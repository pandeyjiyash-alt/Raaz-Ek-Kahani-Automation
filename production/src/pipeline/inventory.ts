import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { root } from '../setupConfig.js';
import { digest } from './runtime.js';
import { registerArtifact } from './artifacts.js';
const registry = path.join(root, 'production/.cache/artifact-registry.json'), outputs = path.join(root, 'production/outputs');
const ledger = JSON.parse(await fs.readFile(path.join(root, 'production/output/story-library/story-ledger.json'), 'utf8'));
const terminal = ledger.stories.filter((s: any) => ['youtube', 'youtube_short', 'instagram_reel'].every(k => ['published', 'scheduled'].includes(s.platform_posts?.[k]?.status)));
async function files(dir: string): Promise<string[]> {
  const found: string[] = []; let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) { const f = path.join(dir, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) found.push(...await files(f)); else if (e.isFile()) found.push(f); }
  return found;
}
const bySize = new Map<number, { file: string; story: string }[]>(); let registered = 0;
for (const story of terminal) {
  const dir = path.resolve(story.output_dir ?? path.join(outputs, story.normalized_title));
  for (const file of await files(dir)) {
    const rel = path.relative(dir, file).replaceAll('\\', '/');
    // Canonical sources only. Experiment/cache/final renders are not provenance for Downloads.
    if (/\.(mp4|wav|mp3|m4a|flac)$/i.test(file) && (/^(clips|voices|narration|audio)\//.test(rel) || /^scene-\d+\.mp4$/i.test(rel)) && !/pre-level|before-|repair|temp|test/i.test(rel)) {
      const stat = await fs.stat(file); bySize.set(stat.size, [...(bySize.get(stat.size) ?? []), { file, story: String(story.number) }]);
    }
    // Explicit disposable intermediates; keep stems and evidence referenced by QC.
    if (/^(edit\/seg-\d+\.mp4|edit\/(picture|short-picture|voice-review|mix-pre|music-float|line-temp)\.(mp4|wav)|qc\/(qsv-test\.mp4|test-cut\.wav|scene-6-initial-draft\.mp4))$/.test(rel) || /^voices\/pre-level-fix\//.test(rel)) {
      await registerArtifact(registry, { file, kind: 'temp', story: String(story.number) }); registered++;
    }
  }
}
const hashes = new Map<string, string>();
const downloadsRoot = path.join(os.homedir(), 'Downloads');
for (const file of (await fs.readdir(downloadsRoot, { withFileTypes: true })).filter(e => e.isFile() && !e.isSymbolicLink()).map(e => path.join(downloadsRoot, e.name))) {
  // Only top-level download files. Never reach another app's nested folders.
  if (path.dirname(file) !== path.join(os.homedir(), 'Downloads')) continue;
  const stat = await fs.stat(file), candidates = bySize.get(stat.size); if (!candidates?.length) continue;
  const hash = await digest(file);
  for (const candidate of candidates) {
    if (!hashes.has(candidate.file)) hashes.set(candidate.file, await digest(candidate.file));
    if (hashes.get(candidate.file) === hash) { await registerArtifact(registry, { file, kind: 'download', story: candidate.story, canonical: candidate.file }); registered++; break; }
  }
}
console.log(JSON.stringify({ registered, registry, ownership: 'Exact SHA-256 canonical copies; no generic Downloads wildcard deletion' }));
