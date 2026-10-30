import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, type Stage } from './runtime.js';
import type { preparePlan } from './preparePlan.js';
import { browserTask } from './browserTasks.js';
import { requireQcGate } from '../upload.js';

interface Context {
  out: string; production: string; projectFile: string; prompt: string;
  prepared: Awaited<ReturnType<typeof preparePlan>>;
  local(file: string, label: string, signal: AbortSignal, extra?: string[]): Promise<void>;
  schedule(signal: AbortSignal): Promise<void>;
}

export async function verifySourceVoices(out: string, lines: { scene: number; speaker: string; script: string; voice: string; source_file: string; file: string }[]) {
  const report = JSON.parse(await fs.readFile(path.join(out,'qc/source-voice-qc.json'),'utf8'));
  for (const line of lines) {
    const measured = report.lines.find((r: any) => r.scene === line.scene && r.speaker === line.speaker);
    if (!measured?.pass || measured.script !== line.script || measured.voice !== line.voice ||
      measured.source_sha256 !== await digest(line.source_file) || measured.sha256 !== await digest(path.join(out,line.file)))
      throw Error(`Source voice changed or failed QC at scene ${line.scene}; preserve completed lines`);
  }
}

// Browser stages wait for agent-serviced Chrome work (Flow queues, TTS, Freesound, package QC).
// A short fixed limit aborted every concurrent stage and forced full restarts; allow it to be
// raised (BROWSER_STAGE_MINUTES) while keeping a bounded wait. Media/gate limits are unchanged.
const BROWSER_STAGE_MS = Math.max(10, Number(process.env.BROWSER_STAGE_MINUTES ?? 45)) * 60_000;
/** Immutable checkpoints: a publishing retry never owns rendering or transcription. */
export function productionGraph(c: Context): Stage[] {
  const { out, production, prepared, prompt, projectFile, local } = c;
  const file = (...parts: string[]) => path.join(out, ...parts), code = (name: string) => path.join(production, 'media', name);
  const plan = prepared.plan, slug = plan.slug;
  const reel = path.join(production, 'output/instagram', slug + '-instagram-reel.mp4');
  const cover = path.join(production, 'output/instagram', slug + '-reel-cover.jpg');
  const clips = plan.flow_scenes.filter((s: any) => !plan.fiction_scenes.includes(s.scene_number))
    .map((s: any) => ({ file: file('clips', `scene-${String(s.scene_number).padStart(4, '0')}.mp4`), role: `scene ${s.scene_number}` }));
  const voices = prepared.lines.map(l => ({ file: l.source_file, role: `${l.speaker} scene ${l.scene}` }));
  const normalized = prepared.lines.map(l => file(l.file));
  const root = path.dirname(production);
  const logo = path.resolve(root, process.env.CHANNEL_LOGO_PATH ?? path.join(production, 'assets/channel-logo.jpg'));
  const font = process.env.HINDI_FONT_PATH ?? (process.platform === 'win32' ? 'C:/Windows/Fonts/NirmalaB.ttf' : '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf');
  const browser = (id: string, instruction: string, outputs: { file: string; role: string }[], payload: unknown, signal: AbortSignal) =>
    browserTask(out, id, prompt + '\n' + instruction, outputs, payload, signal).then(() => {});
  // Long-format stories have ~4x the scenes; scale local media limits with the scene count.
  const scale = Math.max(1, (plan.flow_scenes?.length ?? 22) / 22);
  const mediaStage = (id: string, script: string, dependencies: string[], inputs: string[], outputs: string[], extra: string[] = []): Stage => ({
    id, version: '1', dependencies, inputs: [code(script), code('common.py'), ...inputs], outputs,
    resource: 'cpu-media', timeoutMs: Math.round(10 * 60_000 * scale), run: signal => local(script, id, signal, extra),
  });
  async function voicesAndQc(signal: AbortSignal) {
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    const tasks = [browser('tts', 'Use the current authenticated Chrome extension. Fill the exact Hindi speech text and fixed voice before checking Run. The No API key selected label alone is not a blocker: free AI Studio generation can run without linking a paid key. Generate only missing or measured failed lines and save every completed WAV immediately.', voices, prepared.lines, controller.signal),
      local('voice_qc.py', 'source-voice-qc', controller.signal)];
    try {
      await Promise.all(tasks);
      await verifySourceVoices(out,prepared.lines);
    }
    finally { controller.abort(); await Promise.allSettled(tasks); signal.removeEventListener('abort', abort); }
  }
  const stages: Stage[] = [
    { id: 'flow', version: '2', inputs: [file('flow-plan.json')], outputs: clips.map((x: any) => x.file), timeoutMs: BROWSER_STAGE_MS,
      run: signal => browser('flow', 'Recover existing references/results before generating. Create only missing exact scenes; save each observed task/media reference, cost and download. At most three identifiable requests in flight. Never regenerate queued/completed work or create footage for fiction cards. Prioritize quality with no fixed credit target; do not replace required action/dialogue animation with stills or held frames solely to save credits.', clips, { projectFile, plan: file('flow-plan.json'), creditTarget: null, qualityPriority: true }, signal) },
    { id: 'voices', version: '2', inputs: [file('voice-lines.json'), code('voice_qc.py'), code('common.py')],
      outputs: [...voices.map(v => v.file), ...normalized, file('qc/processed-lines.json'), file('qc/source-voice-qc.json')],
      // Source voice QC runs ASR on every line; long stories need proportionally more time.
      timeoutMs: Math.round(BROWSER_STAGE_MS * scale), resource: 'cpu-media', run: voicesAndQc },
    { id: 'sound', version: '2', inputs: [file('sound-plan.json')], outputs: [file('audio/selected-music.json'), file('audio/selected-sfx.json')], timeoutMs: BROWSER_STAGE_MS,
      run: signal => browser('sound', 'Browser preview/select/download three real horror music cues and nine story SFX. Exclude previously used IDs; record real licence/source evidence. Write selected-music.json and selected-sfx.json arrays. Do not mark mixed_into_final before checking the final files.', [{ file: file('audio/selected-music.json'), role: 'music' }, { file: file('audio/selected-sfx.json'), role: 'effects' }], plan, signal) },
    mediaStage('assets', 'prepare_assets.py', ['flow'], [file('production-plan.json'), code('hindi_text.py'), logo, font],
      [file('thumbnail.jpg'), file('thumbnail-source.png'), cover, ...['logo.png','title.png','fiction.png','vertical-brand.png','short-cta.png'].map(n => file('edit', n))]),
    mediaStage('master', 'render_full.py', ['assets', 'flow', 'voices', 'sound'], [file('production-plan.json'), file('script.json'), ...voices.map(v => v.file)],
      [file(slug + '-hindi-horror-story.mp4'), file('render-timeline.json'), file('voice-review.mp3'), file('edit/voice-stem.wav'), file('edit/final-mix.wav'), file('edit/picture.mp4')]),
    mediaStage('derivatives', 'render_derivatives.py', ['master', 'assets'], [file('production-plan.json'), file('qc/processed-lines.json')],
      [file(slug + '-short.mp4'), reel, file(slug + '.hi.srt'), file(slug + '-short.hi.srt'), file('short-timeline.json')]),
      mediaStage('final-voice-qc', 'voice_qc.py', ['derivatives', 'voices'], [code('final_asr_cache.py'), code('codec_copy_cache.py')],
      [file('voice-qc.json'), file('qc/final-asr.json'), file('qc/final-line-presence.json')], ['--final','--final-vad','--repair-speech-windows']),
    { id: 'package', version: '1', dependencies: ['final-voice-qc'], inputs: [file('production-plan.json')],
      outputs: [file('release.json'), file('audio-manifest.json')], timeoutMs: BROWSER_STAGE_MS,
      run: signal => browser('package-qc', 'Prepare release.json and audio-manifest.json from real measurements/templates, accurate Hindi SRT and timeline chapters. Inspect actual thumbnail/cover/opening/ending, Short CTA and final audio. Fix failed artifacts only. Do not rerender passing files, run the gate or upload: the runner owns those steps.', [{ file: file('release.json'), role: 'release' }, { file: file('audio-manifest.json'), role: 'audio evidence' }], { out, plan }, signal) },
    { id: 'gate', version: '1', dependencies: ['package'], inputs: [file('release.json'), file('voice-qc.json'), file('audio-manifest.json'), path.join(production, 'qc-gate.mjs')],
      outputs: [file('qc-report.json'), file('qc-receipt.json')], timeoutMs: 3 * 60_000,
      run: async signal => { const release = JSON.parse(await fs.readFile(file('release.json'), 'utf8')); await requireQcGate(file(release.full_video), signal); } },
    { id: 'schedule', version: '3', dependencies: ['gate'], inputs: [file('release.json')], outputs: [file('delivery.json')], timeoutMs: 30 * 60_000, run: c.schedule },
  ];
  const master = stages.find(s => s.id === 'master')!, masterInputs = master.inputs as string[];
  // Final mixed Hindi verification with the offline medium model can take
  // longer than rendering on the two-core host. The overall run deadline stays bounded.
  stages.find(s => s.id === 'final-voice-qc')!.timeoutMs = Math.round(20 * 60_000 * scale);
  // The full-length vertical Reel is a second full render of the master; give it the same headroom.
  stages.find(s => s.id === 'derivatives')!.timeoutMs = Math.round(30 * 60_000 * scale);
  master.inputs = async () => {
    const selections = await Promise.all(['selected-music.json','selected-sfx.json'].map(async n => JSON.parse(await fs.readFile(file('audio',n),'utf8'))));
    return [...masterInputs, path.join(production,'assets/channel-intro.mp4'), ...selections.flat().map(s => path.resolve(out,s.file))];
  };
  return stages;
}
