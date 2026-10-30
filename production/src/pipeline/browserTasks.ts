import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, digest } from './runtime.js';
export interface BrowserOutput { file: string; role: string }
/** Codex handles these requests through the user's existing Chrome extension.
 * The CLI never launches a competing profile or treats a queued job as a failure.
 */
export async function browserTask(dir: string, id: string, instruction: string, outputs: BrowserOutput[], payload: unknown, signal: AbortSignal) {
  const folder = path.join(dir, 'browser-tasks'); await fs.mkdir(folder, { recursive: true });
  const request = path.join(folder, `${id}.request.json`), result = path.join(folder, `${id}.result.json`);
  const data = { version: 1, id, instruction, payload, outputs, rules: ['Use the current authenticated Chrome extension', 'Inspect existing task before any generation; never resubmit queued work', 'Save exact media/task references before waiting', 'At most two TTS attempts per line; preserve failed measurements', 'Do not bypass verification or purchase credits', 'No user review/approval questions; producer owns QC'] };
  await atomicJson(request, data); const requestSha256 = await digest(request);
  console.log(JSON.stringify({ event: 'browser_task_ready', id, request, completion_file: result, request_sha256: requestSha256 }));
  while (!signal.aborted) {
    try {
      const completion = JSON.parse(await fs.readFile(result, 'utf8'));
      if (completion.request_sha256 !== requestSha256) {
        // A repaired request must not be failed by the previous attempt's receipt.
        // Preserve that evidence, but never accept it for the current outputs.
        const staleHash = await digest(result);
        await fs.rename(result, `${result}.stale-${staleHash.slice(0, 16)}`);
        continue;
      }
      if (completion.status === 'blocked') throw Error(`Browser ${id}: ${completion.reason}`);
      if (completion.status === 'done') {
        for (const output of outputs) {
          const file = path.resolve(output.file); if (!file.startsWith(path.resolve(dir) + path.sep)) throw Error('Browser result output outside story directory');
          if (!(await fs.stat(file)).size || completion.files?.[file] !== await digest(file)) throw Error(`Unverified browser result ${output.role}`);
        }
        return completion;
      }
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    await new Promise<void>(resolve => { const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 1000); const cancel = () => { clearTimeout(timer); resolve(); }; signal.addEventListener('abort', cancel, { once: true }); });
  }
  signal.throwIfAborted();
}
