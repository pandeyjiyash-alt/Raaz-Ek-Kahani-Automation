import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './runtime.js';
export const FICTION = 'यह कहानी 100% काल्पनिक है। सभी पात्र और घटनाएँ पूरी तरह काल्पनिक हैं।';
export const DIRECTION = 'Adult native North Indian Hindi speaker. Clear Devanagari pronunciation, no English or Western cadence, no slurring, no repeated syllables, no added words. Suspenseful natural dramatic delivery; finish every word.';
export async function preparePlan(projectFile: string, out: string) {
  const p = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  if (p.story_quality_check?.pass !== true) throw Error('Story quality assessment missing/failed; no Flow credits spent');
  const scenes = [...p.scenes].sort((a, b) => a.scene_number - b.scene_number), cast: Record<string, string> = { NARRATOR: 'Charon', none: 'Charon' };
  const voices: Record<string, string> = { young_woman: 'Leda', old_woman: 'Sulafat', man: 'Orus', child: 'Puck', ghost: 'Aoede' };
  for (const c of p.characters) { if (!voices[c.voice_role]) throw Error(`Character ${c.name} needs a verified cast role before production`); cast[c.tag] = voices[c.voice_role]; }
  const script: Record<string, [string, string][]> = {}, lines: any[] = [];
  for (const s of scenes) {
    const text = String(s.speaker === 'NARRATOR' || s.speaker === 'none' ? s.narration_text : s.devanagari_dialogue).trim();
    if (!text || !/[\u0900-\u097f]/.test(text)) throw Error(`Scene ${s.scene_number} lacks exact Hindi speech`);
    const speaker = s.speaker === 'none' ? 'NARRATOR' : s.speaker; script[s.scene_number] = [[speaker, text]];
    lines.push({ scene: s.scene_number, speaker, voice: cast[speaker], source: 'ai_studio', script: text, source_file: path.join(out, 'voices', `scene-${String(s.scene_number).padStart(4, '0')}.wav`), file: `voices/scene-${String(s.scene_number).padStart(4, '0')}-normalized.wav`, direction: speaker === 'NARRATOR' ? `Adult Hindi horror-story narrator. Deep, slow, suspenseful and chilling. ${DIRECTION}` : DIRECTION });
  }
  if (scenes.some(s => [90, 99].includes(s.scene_number))) throw Error('Scene IDs 90 and 99 are reserved for teaser and fiction note');
  const fictionScenes = lines.filter(l => l.script.trim() === FICTION).map(l => l.scene);
  if (!lines.at(-1)?.script.includes(FICTION)) { script['99'] = [['NARRATOR', FICTION]]; lines.push({ scene: 99, speaker: 'NARRATOR', voice: 'Charon', source: 'ai_studio', script: FICTION, source_file: path.join(out, 'voices/scene-0099.wav'), file: 'voices/scene-0099-normalized.wav', direction: DIRECTION }); fictionScenes.push(99); }
  const plan = p.production_plan;
  if (!plan?.short_narration || !plan?.thumbnail_hook || !Array.isArray(plan?.short_scenes) || plan.short_scenes.length !== 3 || !plan?.short_dialogue_scene || !plan?.sound_events?.length) throw Error('Production metadata/teaser/sound plan missing before credits');
  script['90'] = [['NARRATOR', plan.short_narration]]; lines.push({ scene: 90, speaker: 'NARRATOR', voice: 'Charon', source: 'ai_studio', script: plan.short_narration, source_file: path.join(out, 'voices/scene-0090.wav'), file: 'voices/scene-0090-normalized.wav', direction: DIRECTION });
  await fs.mkdir(path.join(out, 'voices'), { recursive: true }); await fs.mkdir(path.join(out, 'clips'), { recursive: true });
  if (plan.title.length > 100 || !plan.title.includes(plan.keyword)) throw Error('Title keyword/length validation failed before credits');
  const displayTitle = plan.title.split('|')[0].trim();
  const stableScenes = scenes.map(({ status, error, video_path, video_sha256, production_source, ...scene }) => scene);
  await atomicJson(path.join(out, 'script.json'), { title_hi: displayTitle, scenes: script });
  await atomicJson(path.join(out, 'voice-lines.json'), lines);
  await atomicJson(path.join(out, 'flow-plan.json'), { characters: p.characters, backgrounds: p.backgrounds, scenes: stableScenes.filter(s => !fictionScenes.includes(s.scene_number)) });
  await atomicJson(path.join(out, 'sound-plan.json'), { music_scene_boundaries: plan.music_scene_boundaries, sound_events: plan.sound_events, scary_scenes: plan.scary_scenes });
  const preparedPlan = { ...plan, cast, slug: p.story_slug ?? p.project_id, title: displayTitle, full_title: plan.title, project_file: projectFile, flow_scenes: stableScenes, fiction_scenes: fictionScenes, scene_count: scenes.length };
  await atomicJson(path.join(out, 'production-plan.json'), preparedPlan);
  return { project: p, lines, plan: preparedPlan };
}
