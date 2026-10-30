import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface Story { number: number; title: string; normalized_title: string; script_file: string; status: string; output_dir?: string; project_file?: string; recovery_file?: string; platform_posts?: Record<string, { status?: string }> }
export function delivered(story: Story) { const posts = story.platform_posts ?? {}; return ['youtube', 'youtube_short', 'instagram_reel'].every(kind => ['published', 'scheduled'].includes(posts[kind]?.status ?? '')); }
export async function selectToday(root: string, number?: number) {
  const file = path.join(root, 'production/output/story-library/story-ledger.json'), ledger = JSON.parse(await fs.readFile(file, 'utf8')) as { stories: Story[] };
  const stories = [...ledger.stories].sort((a, b) => a.number - b.number);
  // Resume a partial production first; never restart or repost a completed story.
  // --story N picks one explicit story (used for the weekly long format); otherwise the regular queue order.
  const story = number !== undefined ? stories.find(s => s.number === number && !delivered(s)) : stories.find(s => s.number >= 9 && !delivered(s) && /recover|produc|partial|process|render|fail|block/i.test(s.status)) ?? stories.find(s => s.number >= 9 && !delivered(s) && !/^published|^scheduled/.test(s.status));
  if (!story) throw Error('No unpublished story available');
  const script = await fs.readFile(story.script_file, 'utf8');
  const scriptHash = createHash('sha256').update(script).digest('hex');
  const normalized = script.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  for (const prior of stories.filter(s => s.number !== story.number && delivered(s))) {
    const text = await fs.readFile(prior.script_file, 'utf8');
    if (text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === normalized) throw Error(`Duplicate story ${story.number} matches ${prior.number}; no credits spent`);
  }
  return { story, scriptHash, output: path.resolve(story.output_dir ?? path.join(root, 'production/outputs', story.normalized_title)), ledgerFile: file };
}
