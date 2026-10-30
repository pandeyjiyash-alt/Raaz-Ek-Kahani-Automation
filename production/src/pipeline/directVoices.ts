import fs from 'node:fs/promises';
import path from 'node:path';
import { launchProfile } from '../browserSession.js';
import { generateNarration } from '../narration.js';

type VoiceLine = {
  scene: number;
  voice: string;
  script: string;
  direction: string;
  source_file: string;
};

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

async function chooseVoice(page: any, voice: string) {
  const current = page.getByRole('button', { name: /speaker\s*1/i }).first();
  if (!(await current.isVisible().catch(() => false))) return;
  const label = await current.innerText();
  if (new RegExp(`\\b${voice}\\b`, 'i').test(label)) return;
  await current.click();
  const search = page.getByRole('textbox', { name: /search voices/i }).first();
  await search.waitFor({ state: 'visible', timeout: 30_000 });
  await search.fill(voice);
  await page.getByRole('button', { name: new RegExp(`^${voice}$`, 'i') }).first().click();
  const close = page.getByRole('button', { name: /close panel|close/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function main() {
  const dir = arg('--dir');
  const profile = arg('--profile');
  if (!dir || !profile) throw new Error('Usage: directVoices --dir <story-output> --profile <Chrome-profile>');
  const lines = JSON.parse(await fs.readFile(path.join(dir, 'voice-lines.json'), 'utf8')) as VoiceLine[];
  const pending: VoiceLine[] = [];
  for (const line of lines) {
    try { if ((await fs.stat(line.source_file)).size > 44) continue; } catch {}
    pending.push(line);
  }
  if (!pending.length) return;

  const context = await launchProfile(path.resolve(profile));
  try {
    const page = await context.newPage();
    await page.goto(process.env.AI_STUDIO_SPEECH_URL || 'https://aistudio.google.com/generate-speech', { waitUntil: 'domcontentloaded' });
    const create = page.getByRole('button', { name: /create new dialog/i }).first();
    if (await create.isVisible().catch(() => false)) await create.click();
    const run = page.getByRole('button', { name: /^Run(?:\s|$)|Generate speech/i }).first();
    for (const line of pending) {
      await chooseVoice(page, line.voice);
      const text = page.getByRole('textbox', { name: /speech block text|^text$|speech text|script/i }).first();
      await text.fill(line.script);
      if (await run.isDisabled()) throw new Error('AI Studio Run remains disabled after filling speech text; inspect the actual page message.');
      await generateNarration(page, line.script, line.direction, line.source_file);
      console.log(JSON.stringify({ event: 'voice_saved', scene: line.scene, file: line.source_file }));
    }
  } finally {
    await context.close();
  }
}

await main();
