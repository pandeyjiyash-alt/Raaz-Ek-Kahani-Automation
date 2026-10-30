import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { root } from '../setupConfig.js';
import { cleanupArtifacts } from './artifacts.js';
const registryFile = path.join(root, 'production/.cache/artifact-registry.json');
const ledger = JSON.parse(await fs.readFile(path.join(root, 'production/output/story-library/story-ledger.json'), 'utf8'));
const terminalStories = new Set<string>(ledger.stories.filter((s: any) => ['youtube', 'youtube_short', 'instagram_reel'].every(k => ['published', 'scheduled'].includes(s.platform_posts?.[k]?.status))).flatMap((s: any) => [String(s.number), s.normalized_title, s.project_id].filter(Boolean)));
try {
  const result = await cleanupArtifacts({ registryFile, roots: [root, path.join(os.homedir(), 'Downloads')], terminalStories, maxAgeHours: 48, apply: process.argv.includes('--apply'), completedTempsNow: process.argv.includes('--completed-temps-now') });
  console.log(JSON.stringify({ deleted: result.records.filter(r => r.action === 'deleted').length, reclaimedBytes: result.reclaimedBytes, report: `${registryFile}.last-cleanup.json` }));
} catch (e: any) { if (e.code !== 'ENOENT') throw e; console.log(JSON.stringify({ deleted: 0, reason: 'No owned artifact registry yet' })); }
