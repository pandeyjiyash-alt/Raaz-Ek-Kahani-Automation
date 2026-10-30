import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { acquireLock } from './lock.js';

export async function digest(file: string): Promise<string> {
  const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex');
}
export async function atomicJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(data, null, 2)); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
export interface Stage {
  id: string; version: string; dependencies?: string[]; inputs?: string[] | (() => Promise<string[]>); outputs: string[];
  timeoutMs: number; resource?: string; run(signal: AbortSignal): Promise<void>;
}
interface Receipt { signature: string; status: string; startedAt: string; endedAt?: string; durationMs?: number; outputs?: Record<string, string>; error?: string }
export interface RunOptions { stateFile: string; stages: Stage[]; concurrency?: number; budgetMs?: number; signal?: AbortSignal }
/** One durable execution graph. Completed output hashes, not flags, decide reuse. */
export async function runStages(options: RunOptions) {
  const { stages, stateFile } = options, ids = new Set(stages.map(s => s.id));
  if (ids.size !== stages.length) throw Error('Duplicate stage ID');
  for (const s of stages) for (const dep of s.dependencies ?? []) if (!ids.has(dep)) throw Error(`Unknown dependency ${dep}`);
  const seen = new Set<string>(), visiting = new Set<string>();
  function visit(id: string) { if (visiting.has(id)) throw Error('Stage dependency cycle'); if (seen.has(id)) return; visiting.add(id); for (const d of stages.find(s => s.id === id)!.dependencies ?? []) visit(d); visiting.delete(id); seen.add(id); }
  stages.forEach(s => visit(s.id));
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const lockPath = `${stateFile}.lock`, releaseLock = await acquireLock(lockPath);
  const controller = new AbortController(), start = performance.now();
  const timer = setTimeout(() => controller.abort(Error('30-minute production budget exhausted; resume saved progress without reducing quality')), options.budgetMs ?? 30 * 60_000);
  const abort = () => controller.abort(options.signal?.reason ?? Error('Run cancelled')); options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  let state: { version: number; stages: Record<string, Receipt>; runs?: unknown[] } = { version: 1, stages: {} };
  let writes = Promise.resolve();
  const save = () => (writes = writes.then(() => atomicJson(stateFile, state)));
  try {
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const complete = new Set<string>(), resources = new Set<string>(), active = new Map<string, Promise<void>>();
    const signature = async (stage: Stage) => {
      const inputs = typeof stage.inputs === 'function' ? await stage.inputs() : stage.inputs ?? [];
      return createHash('sha256').update(JSON.stringify({ version: stage.version, inputs: await Promise.all(inputs.map(async f => [path.resolve(f), await digest(f)])), dependencies: (stage.dependencies ?? []).map(id => state.stages[id]?.outputs) })).digest('hex');
    };
    async function execute(stage: Stage) {
      controller.signal.throwIfAborted(); const key = await signature(stage), previous = state.stages[stage.id];
      if (previous?.status === 'done' && previous.signature === key && stage.outputs.length && previous.outputs && await Promise.all(stage.outputs.map(async f => { try { return previous.outputs![f] === await digest(f); } catch { return false; } })).then(xs => xs.every(Boolean))) { complete.add(stage.id); return; }
      const began = performance.now(); state.stages[stage.id] = { signature: key, status: 'running', startedAt: new Date().toISOString() }; await save();
      const local = new AbortController(), onAbort = () => local.abort(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => local.abort(Error(`Stage ${stage.id} exceeded its time budget; saved outputs retained`)), stage.timeoutMs);
      let abortListener: (() => void) | undefined, work: Promise<void> | undefined;
      try {
        work = stage.run(local.signal);
        await Promise.race([work, new Promise<never>((_, reject) => { abortListener = () => reject(local.signal.reason); local.signal.addEventListener('abort', abortListener, { once: true }); if (local.signal.aborted) abortListener(); })]);
        local.signal.throwIfAborted(); const outputs: Record<string, string> = {};
        for (const file of stage.outputs) { if (!(await fs.stat(file)).size) throw Error(`Empty output ${file}`); outputs[file] = await digest(file); }
        Object.assign(state.stages[stage.id], { status: 'done', endedAt: new Date().toISOString(), durationMs: performance.now() - began, outputs }); complete.add(stage.id);
      } catch (e: any) { Object.assign(state.stages[stage.id], { status: 'blocked', endedAt: new Date().toISOString(), durationMs: performance.now() - began, error: e.message }); controller.abort(e); throw e; }
      finally {
        // Owned stages must cooperate with AbortSignal. Keep the lock until their
        // child processes/browser waits have actually stopped writing outputs.
        local.abort(); await work?.catch(() => {});
        clearTimeout(timeout); controller.signal.removeEventListener('abort', onAbort); if (abortListener) local.signal.removeEventListener('abort', abortListener); await save();
      }
    }
    while (complete.size < stages.length) {
      controller.signal.throwIfAborted();
      for (const s of stages) {
        if (active.size >= (options.concurrency ?? 2)) break;
        if (complete.has(s.id) || active.has(s.id) || (s.dependencies ?? []).some(d => !complete.has(d)) || (s.resource && resources.has(s.resource))) continue;
        if (s.resource) resources.add(s.resource);
        const job = execute(s).finally(() => { active.delete(s.id); if (s.resource) resources.delete(s.resource); });
        job.catch(() => {}); active.set(s.id, job);
      }
      if (!active.size) { if (complete.size === stages.length) break; throw Error('No runnable stage'); }
      try { await Promise.race(active.values()); } catch (e) { await Promise.allSettled(active.values()); throw e; }
    }
    state.runs = [...(state.runs ?? []), { status: 'done', completedAt: new Date().toISOString(), elapsedMs: performance.now() - start }]; await save(); return state;
  } catch (e: any) {
    state.runs = [...(state.runs ?? []), { status: 'blocked', endedAt: new Date().toISOString(), elapsedMs: performance.now() - start, error: e.message }];
    await save(); throw e;
  } finally { controller.abort(Error('Run finished')); clearTimeout(timer); options.signal?.removeEventListener('abort', abort); try { await writes; } finally { await releaseLock(); } }
}
