import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, digest } from './runtime.js';

export type ArtifactKind = 'download' | 'temp' | 'cache' | 'source' | 'final' | 'evidence' | 'runtime';
export interface Artifact { file: string; sha256: string; kind: ArtifactKind; story: string; registeredAt: string; canonical?: string }
interface Registry { version: 1; owner: 'youtube-automation'; artifacts: Artifact[] }
const within = (parent: string, child: string) => { const r = path.relative(parent, child); return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
export async function registerArtifact(registryFile: string, input: Omit<Artifact, 'sha256' | 'registeredAt'>) {
  const file = path.resolve(input.file), stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Only regular owned files can be registered');
  let registry: Registry = { version: 1, owner: 'youtube-automation', artifacts: [] };
  try { registry = JSON.parse(await fs.readFile(registryFile, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  if (registry.owner !== 'youtube-automation') throw Error('Foreign artifact registry');
  const row = { ...input, file, canonical: input.canonical ? path.resolve(input.canonical) : undefined, sha256: await digest(file), registeredAt: new Date().toISOString() };
  if (row.canonical && await digest(row.canonical) !== row.sha256) throw Error('Canonical copy differs; download cannot be discarded');
  registry.artifacts = [...registry.artifacts.filter(a => a.file !== file), row]; await atomicJson(registryFile, registry); return row;
}
export async function cleanupArtifacts(options: { registryFile: string; roots: string[]; terminalStories: Set<string>; now?: number; maxAgeHours?: number; apply?: boolean; completedTempsNow?: boolean }) {
  const roots = await Promise.all(options.roots.map(r => fs.realpath(path.resolve(r))));
  const registry = JSON.parse(await fs.readFile(options.registryFile, 'utf8')) as Registry;
  if (registry.owner !== 'youtube-automation' || registry.version !== 1) throw Error('Invalid ownership registry');
  const cutoff = (options.now ?? Date.now()) - (options.maxAgeHours ?? 48) * 3600_000, records: { file: string; action: string; bytes: number; reason?: string }[] = [];
  const protectedFiles = new Set(registry.artifacts.flatMap(a => [a.canonical, !['temp', 'cache', 'download'].includes(a.kind) ? a.file : undefined]).filter(Boolean).map(f => path.resolve(f!)));
  for (const a of registry.artifacts) {
    let stat; try { stat = await fs.lstat(a.file); } catch (e: any) { if (e.code === 'ENOENT') continue; throw e; }
    const skip = (reason: string) => records.push({ file: a.file, action: 'keep', bytes: stat.size, reason });
    if (!['temp', 'cache', 'download'].includes(a.kind) || protectedFiles.has(path.resolve(a.file))) { skip('protected source/final/evidence/runtime'); continue; }
    if (!options.terminalStories.has(a.story)) { skip('story still active or submission uncertain'); continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) { skip('not a regular file'); continue; }
    const real = await fs.realpath(a.file);
    let linkedParent = false;
    for (let parent = path.dirname(path.resolve(a.file)); path.dirname(parent) !== parent; parent = path.dirname(parent)) if ((await fs.lstat(parent)).isSymbolicLink()) { linkedParent = true; break; }
    if (!roots.some(r => within(r, real)) || linkedParent) { skip('outside allowed roots or junction/symlink'); continue; }
    if (stat.mtimeMs > cutoff && !(options.completedTempsNow && a.kind === 'temp')) { skip('younger than retention'); continue; }
    if (await digest(real) !== a.sha256) { skip('file changed since ownership receipt'); continue; }
    if (a.kind === 'download') {
      if (!a.canonical || !protectedFiles.has(path.resolve(a.canonical))) { skip('no protected canonical copy'); continue; }
      try { if (await digest(a.canonical) !== a.sha256) { skip('canonical changed'); continue; } } catch { skip('canonical missing'); continue; }
    }
    if (options.apply) await fs.unlink(real); // File only; never recursive directory deletion.
    records.push({ file: real, action: options.apply ? 'deleted' : 'would-delete', bytes: stat.size });
  }
  await atomicJson(`${options.registryFile}.last-cleanup.json`, { checkedAt: new Date().toISOString(), applied: !!options.apply, records });
  return { records, reclaimedBytes: records.filter(r => r.action === 'deleted').reduce((sum, r) => sum + r.bytes, 0) };
}
