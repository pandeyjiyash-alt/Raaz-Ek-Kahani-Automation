import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runStages } from './runtime.js';
import { resolveSchedule } from './schedule.js';
import { registerArtifact, cleanupArtifacts } from './artifacts.js';
async function fixture(t: any) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-pipeline-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
test('independent stages overlap; resume validates hashes and invalidates changed descendants', async t => {
  const dir = await fixture(t), input = path.join(dir, 'script'), a = path.join(dir, 'a'), b = path.join(dir, 'b'), c = path.join(dir, 'c'); await fs.writeFile(input, 'one');
  let running = 0, peak = 0, calls = 0;
  const stage = (id: string, out: string, deps: string[] = []) => ({ id, version: '1', inputs: deps.length ? [] : [input], outputs: [out], dependencies: deps, timeoutMs: 1000, run: async () => { calls++; peak = Math.max(peak, ++running); await new Promise(r => setTimeout(r, 20)); await fs.writeFile(out, await fs.readFile(input)); running--; } });
  const options = { stateFile: path.join(dir, 'state.json'), stages: [stage('a', a), stage('b', b), stage('c', c, ['a', 'b'])] };
  await runStages(options); assert.equal(peak, 2); assert.equal(calls, 3);
  await runStages(options); assert.equal(calls, 3);
  await fs.writeFile(input, 'two'); await runStages(options); assert.equal(calls, 6);
  await fs.writeFile(a, 'corrupt'); await runStages(options); assert.equal(calls, 7);
});
test('cycle rejected and blocked stage is not retried in a loop', async t => {
  const dir = await fixture(t); let calls = 0; const options = { stateFile: path.join(dir, 'state'), stages: [{ id: 'fail', version: '1', outputs: [], timeoutMs: 1000, run: async () => { calls++; throw Error('Verification required'); } }] };
  await assert.rejects(runStages(options), /Verification/); assert.equal(calls, 1);
  await assert.rejects(runStages({ ...options, stages: [{ ...options.stages[0], dependencies: ['fail'] }] }), /cycle/);
});

test('dynamic media inputs are fingerprinted after dependencies and invalidate their render only', async t => {
  const dir=await fixture(t), source=path.join(dir,'sound.wav'), selection=path.join(dir,'selection.json'), output=path.join(dir,'master');
  await fs.writeFile(source,'sound one'); let selections=0,renders=0;
  const stages=[{id:'sound',version:'1',outputs:[selection],timeoutMs:1000,run:async()=>{selections++;await fs.writeFile(selection,JSON.stringify([source]));}},
    {id:'render',version:'1',dependencies:['sound'],inputs:async()=>JSON.parse(await fs.readFile(selection,'utf8')),outputs:[output],timeoutMs:1000,run:async()=>{renders++;await fs.copyFile(source,output);}}];
  const options={stateFile:path.join(dir,'state'),stages};await runStages(options);await runStages(options);
  assert.equal(selections,1);assert.equal(renders,1);await fs.writeFile(source,'sound two');await runStages(options);
  assert.equal(selections,1);assert.equal(renders,2);
});
test('stage timeout aborts its work and retains a blocked receipt', async t => {
  const dir = await fixture(t), stateFile = path.join(dir, 'state'); let cancelled = false;
  await assert.rejects(runStages({ stateFile, stages: [{ id: 'slow', version: '1', outputs: [], timeoutMs: 20, run: async signal => { await new Promise<void>((resolve) => signal.addEventListener('abort', () => { cancelled = true; resolve(); })); } }] }), /time budget/);
  assert.equal(cancelled, true); assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).stages.slow.status, 'blocked');
});

test('timeout keeps the run lock until owned asynchronous cleanup finishes', async t => {
  const dir = await fixture(t), stateFile = path.join(dir, 'state'); let cleaned = false;
  await assert.rejects(runStages({ stateFile, stages: [{ id: 'owned', version: '1', outputs: [], timeoutMs: 15, run: async signal => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { setTimeout(async () => {
      await fs.access(stateFile + '.lock'); cleaned = true; resolve();
    }, 25); }, { once: true }));
  } }] }), /time budget/);
  assert.equal(cleaned, true); await assert.rejects(fs.access(stateFile + '.lock'));
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8')); assert.equal(state.runs.at(-1).status, 'blocked');
});
test('retention removes only unchanged owned files, preserves active stories and canonical copies', async t => {
  const dir = await fixture(t), registryFile = path.join(dir, 'registry'), canonical = path.join(dir, 'master'), download = path.join(dir, 'download'), changed = path.join(dir, 'changed'), active = path.join(dir, 'active'), unrelated = path.join(dir, 'unrelated');
  for (const f of [canonical, download, changed, active, unrelated]) await fs.writeFile(f, 'data');
  await registerArtifact(registryFile, { file: download, kind: 'download', story: 'done', canonical });
  await registerArtifact(registryFile, { file: changed, kind: 'temp', story: 'done' }); await fs.writeFile(changed, 'different');
  await registerArtifact(registryFile, { file: active, kind: 'temp', story: 'active' });
  const old = new Date(Date.now() - 72 * 3600_000); for (const f of [canonical, download, changed, active, unrelated]) await fs.utimes(f, old, old);
  const result = await cleanupArtifacts({ registryFile, roots: [dir], terminalStories: new Set(['done']), apply: true });
  assert.equal(result.records.filter(r => r.action === 'deleted').length, 1); await assert.rejects(fs.access(download));
  for (const f of [canonical, changed, active, unrelated]) await fs.access(f);
});
test('a receipt cannot authorize deleting through a symbolic link', async t => {
  if (process.platform === 'win32') { t.skip('Windows symlink privilege varies; realpath junction guard is also enforced'); return; }
  const dir = await fixture(t), outside = await fixture(t), file = path.join(outside, 'data'), link = path.join(dir, 'link'); await fs.writeFile(file, 'x'); await fs.symlink(file, link); await assert.rejects(registerArtifact(path.join(dir, 'registry'), { file: link, kind: 'temp', story: 'done' }), /regular/);
});
test('default schedule resolves after uploads with a lead margin; explicit missed slot never publishes now', () => {
  assert.equal(resolveSchedule(new Date('2026-10-20T07:59:00Z')), '2026-10-21T08:00:00.000Z');
  assert.equal(resolveSchedule(new Date('2026-10-20T07:00:00Z')), '2026-10-20T08:00:00.000Z');
  assert.throws(() => resolveSchedule(new Date('2026-10-20T18:01:00Z'), '2026-10-20T18:00:00Z'), /no publish-now/);
});
