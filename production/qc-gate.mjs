#!/usr/bin/env node
/**
 * RAAZ release quality gate.
 *
 * Every story (from story 9) must pass this gate BEFORE anything is scheduled or
 * published, no matter which agent (Claude, Codex, a person) produced it or which
 * route publishes it (Zernio API, Zernio web, YouTube Studio, Instagram).
 *
 *   node production/qc-gate.mjs --dir "C:/Youtube automation/production/outputs/<story-folder>"
 *
 * Inputs in <story-folder> (written by the producer):
 *   release.json      paths + all platform texts (see production/release.template.json)
 *   voice-qc.json     one entry per narration/dialogue line (see template)
 *   audio-manifest.json  music cues + SFX actually mixed into the final files
 * Output: qc-report.json (pass/fail, every check, sha256 of each checked file).
 * Exit code 0 only when every check passes. Do not edit thresholds to make a story pass
 * and never write qc-report.json by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? undefined : process.argv[i + 1]; };
const dir = path.resolve(arg('--dir') ?? '.');

function findTool(name) {
  const env = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (env && fs.existsSync(env)) return env;
  const win = process.platform === 'win32';
  const local = name === 'ffmpeg'
    ? path.join(here, 'outputs/local-tools/node_modules/ffmpeg-static', win ? 'ffmpeg.exe' : 'ffmpeg')
    : path.join(here, 'outputs/local-tools/node_modules/ffprobe-static/bin', win ? 'win32/x64/ffprobe.exe' : `${process.platform}/x64/ffprobe`);
  if (fs.existsSync(local)) return local;
  return name;
}
const FFMPEG = findTool('ffmpeg'), FFPROBE = findTool('ffprobe');

const checks = [];
const add = (group, name, ok, detail = '') => checks.push({ group, name, pass: !!ok, detail: String(detail) });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
const abs = (p) => (p ? (path.isAbsolute(p) ? p : path.join(dir, p)) : '');
const exists = (p) => !!p && fs.existsSync(abs(p));

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,bit_rate:stream=codec_type,codec_name,width,height,bit_rate,r_frame_rate,sample_rate', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status) return null;
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video'); const a = j.streams.find((s) => s.codec_type === 'audio');
  const rate=(v?.r_frame_rate||'0/1').split('/').map(Number);
  return { duration: Number(j.format.duration), bitrate: Number(j.format.bit_rate), width: v?.width, height: v?.height, hasAudio: !!a, videoCodec:v?.codec_name,audioCodec:a?.codec_name,sampleRate:Number(a?.sample_rate),fps:rate[0]/rate[1] };
}
function loudness(file, extra = []) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', ...extra, '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const s = r.stderr || ''; const tail = s.slice(s.lastIndexOf('Summary:'));
  const I = Number(/I:\s*(-?[\d.]+) LUFS/.exec(tail)?.[1]); const tp = Number(/Peak:\s*(-?[\d.]+) dBFS/.exec(tail)?.[1]);
  return { I, tp };
}
function silences(file, noise = -45, d = 1.5) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `silencedetect=noise=${noise}dB:d=${d}`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return [...(r.stderr || '').matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const hashtags = (t) => (t.match(/(^|\s)#[^\s#]+/g) || []).map((h) => h.trim());
const ts = (t) => { const p = t.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };

const release = readJson('release.json');
add('files', 'release.json present', release, 'write it from production/release.template.json');
if (!release) finish();

// ---------- files & video quality ----------
const R = release;
const F = { full: R.full_video, short: R.short_video, reel: R.reel_video, thumb: R.thumbnail, cover: R.reel_cover, srt: R.subtitles_full, srtShort: R.subtitles_short };
for (const [k, p] of Object.entries(F)) add('files', `${k} exists`, exists(p), p);
for (const k of ['full', 'short', 'reel']) add('files', `${k} filename is final (no draft/review/test)`, F[k] && !/draft|review|test|tmp/i.test(path.basename(F[k])), F[k]);
add('seo', 'full filename contains keyword slug', F.full && /horror|kahani|story/i.test(path.basename(F.full)) , path.basename(F.full || ''));
const fileHashes = {};
let full, short, reel;
if (exists(F.full)) {
  full = probe(abs(F.full)); fileHashes.full = sha(abs(F.full));
  add('video', 'full resolution >= 1280x720 landscape', full && full.width >= 1280 && full.height >= 720 && full.width > full.height, `${full?.width}x${full?.height}`);
  add('video', 'full bitrate >= 1.5 Mbps (no over-compressed copy)', full && full.bitrate >= 1_500_000, `${Math.round((full?.bitrate || 0) / 1000)} kbps`);
  const L = loudness(abs(F.full));
  add('audio', 'full loudness -16..-13 LUFS', L.I >= -16 && L.I <= -13, `${L.I} LUFS`);
  add('audio', 'full true peak <= -1 dBTP', L.tp <= -1, `${L.tp} dBTP`);
  const st = loudness(abs(F.full), ['-t', '3']);
  add('audio', 'horror sting audible in first 3 s', st.I >= -26, `${st.I} LUFS (0-3 s)`);
  const sil = silences(abs(F.full));
  add('audio', 'no dead air > 1.5 s (music bed continuous)', sil.length === 0, sil.length ? `silence at ${sil.map((s) => s.toFixed(1)).join(', ')} s` : 'none');
}
if (exists(F.short)) {
  short = probe(abs(F.short)); fileHashes.short = sha(abs(F.short));
  add('video', 'short is vertical 9:16', short && short.height > short.width, `${short?.width}x${short?.height}`);
  add('video', 'short duration 28-35 s', short && short.duration >= 28 && short.duration <= 35, `${short?.duration?.toFixed(1)} s`);
  const L = loudness(abs(F.short)); add('audio', 'short loudness -16..-13 LUFS, peak <= -1', L.I >= -16 && L.I <= -13 && L.tp <= -1, `${L.I} LUFS / ${L.tp} dBTP`);
  const st = loudness(abs(F.short), ['-t', '2']); add('audio', 'short sting audible in first 2 s', st.I >= -26, `${st.I} LUFS`);
}
if (exists(F.reel)) {
  reel = probe(abs(F.reel)); fileHashes.reel = sha(abs(F.reel));
  add('video', 'reel is vertical 9:16', reel && reel.height > reel.width, `${reel?.width}x${reel?.height}`);
  add('video', 'reel keeps the full story (duration within 2 s of full)', reel && full && Math.abs(reel.duration - full.duration) <= 2, `${reel?.duration?.toFixed(1)} vs ${full?.duration?.toFixed(1)} s`);
  add('video', 'reel bitrate >= 1.5 Mbps', reel && reel.bitrate >= 1_500_000, `${Math.round((reel?.bitrate || 0) / 1000)} kbps`);
}
for (const [k, wantW, wantH] of [['thumb', 1280, 720], ['cover', 1080, 1920]]) {
  if (!exists(F[k])) continue; const p = probe(abs(F[k])); const size = fs.statSync(abs(F[k])).size;
  add('images', `${k} ${wantW}x${wantH} JPEG < 2 MB`, p && p.width === wantW && p.height === wantH && size < 2 * 1024 * 1024 && /\.jpe?g$/i.test(F[k]), `${p?.width}x${p?.height}, ${Math.round(size / 1024)} KB`);
}

// ---------- voice ----------
const vq = readJson('voice-qc.json');
const lines = vq?.lines || [];
add('voice', 'voice-qc.json present with lines', lines.length > 0, `${lines.length} lines`);
const expected = Number(R.expected_spoken_lines || 0);
add('voice', 'every script narration/dialogue line checked', expected > 0 && lines.length >= expected, `${lines.length}/${expected}`);
const bad = lines.filter((l) => !(l.pass === true && Number(l.match) >= 0.85 && Number(l.hindi_confidence) >= 0.8 && l.source !== 'veo'));
add('voice', 'all lines pass (match >= 0.85, Hindi confidence >= 0.8, no Veo voice)', lines.length && !bad.length, bad.slice(0, 8).map((l) => `scene ${l.scene} ${l.speaker}: ${l.notes || 'fail'}`).join('; '));
const castVoices = {}; for (const l of lines) (castVoices[l.speaker] ??= new Set()).add(l.voice);
const changed = Object.entries(castVoices).filter(([, v]) => v.size > 1).map(([s]) => s);
add('voice', 'each character keeps one voice', !changed.length, changed.join(', '));
add('voice', 'final mix re-checked', vq?.final_mix_checked === true, 'set final_mix_checked after transcribing the rendered full/short/reel');

// ---------- music & sfx ----------
const am = readJson('audio-manifest.json');
const sounds = am?.sounds || [];
const music = sounds.filter((s) => s.role === 'music' && s.mixed_into_final === true);
const sfx = sounds.filter((s) => s.role === 'sfx' && s.mixed_into_final === true);
add('music', 'at least 2 horror music cues mixed into final', music.length >= 2, `${music.length}`);
add('music', 'music is music, not only ambience', music.some((m) => m.kind !== 'ambience'), music.map((m) => m.kind).join(', '));
add('music', 'at least 8 distinct SFX in full video', new Set(sfx.map((s) => s.id)).size >= 8, `${new Set(sfx.map((s) => s.id)).size}`);
add('music', 'at least 4 SFX in the Short', (am?.short_sound_ids || []).length >= 5, `${(am?.short_sound_ids || []).length} sound ids (music + sfx)`);
const mu = am?.measurements || {};
add('music', 'music under voice -28..-22 LUFS (audible, not masking)', mu.music_under_voice_lufs >= -28 && mu.music_under_voice_lufs <= -22, `${mu.music_under_voice_lufs}`);
add('music', 'music in gaps/climax -20..-14 LUFS', mu.music_in_gaps_lufs >= -20 && mu.music_in_gaps_lufs <= -14, `${mu.music_in_gaps_lufs}`);
add('music', 'licences recorded (CC0 or attribution-compatible)', sounds.length && sounds.every((s) => s.license && s.source), '');
// reuse check against other story folders
const used = new Set(); const parent = path.dirname(dir);
for (const d of fs.readdirSync(parent)) {
  const f = path.join(parent, d, 'audio-manifest.json'); if (path.join(parent, d) === dir || !fs.existsSync(f)) continue;
  try { for (const s of JSON.parse(fs.readFileSync(f, 'utf8')).sounds || []) used.add(String(s.id)); } catch {}
}
const reused = sounds.filter((s) => used.has(String(s.id))).map((s) => s.id);
add('music', 'no sound reused from earlier stories', !reused.length, reused.join(', '));

// ---------- SEO (full video) ----------
const yt = R.youtube || {}; const kw = (yt.keyword || '').trim(); const desc = yt.description || '';
add('seo', 'keyword chosen', kw.length > 2, kw);
add('seo', 'title <= 100 chars and contains keyword or story name', yt.title && yt.title.length <= 100 && (yt.title.toLowerCase().includes(kw.toLowerCase()) || yt.title.includes(R.story_name_hindi || '~')), `${yt.title?.length} chars`);
add('seo', 'keyword in first 150 chars of description', desc.slice(0, 150).toLowerCase().includes(kw.toLowerCase()) || desc.slice(0, 150).includes(R.story_name_hindi || '~'), desc.slice(0, 80));
const chapters = [...desc.matchAll(/^\s*((?:\d+:)?\d{1,2}:\d{2})\s+(.+)$/gm)].map((m) => ({ t: ts(m[1]), name: m[2] }));
const chapOk = chapters.length >= 3 && chapters[0].t === 0 && chapters.every((c, i) => (i === 0 || c.t > chapters[i - 1].t) && ((chapters[i + 1]?.t ?? full?.duration ?? 1e9) - c.t >= 10)) && (!full || chapters.at(-1).t < full.duration - 10);
add('seo', 'chapters: start 0:00, >=3, each >=10 s, inside video', chapOk, chapters.map((c) => `${c.t}s ${c.name}`).join(' | '));
add('seo', 'chapters match render timeline', Array.isArray(R.chapter_source_timeline) && R.chapter_source_timeline.length >= 3 && chapters.every((c) => R.chapter_source_timeline.some((s) => Math.abs(Number(s.start) - c.t) <= 1)), 'each chapter must equal a scene start in chapter_source_timeline (+-1 s)');
add('seo', 'chapters are not the old template', !/adjust timestamps|0:45 .*\n1:30 /i.test(desc), '');
const dh = hashtags(desc); add('seo', 'description has 3-5 hashtags', dh.length >= 3 && dh.length <= 5, dh.join(' '));
const tags = yt.tags || []; add('seo', 'tags 8-15, total <= 500 chars', tags.length >= 8 && tags.length <= 15 && tags.join(',').length <= 500, `${tags.length} tags, ${tags.join(',').length} chars`);
const ctaOk = (t) => /youtube\.com\/@raaz_ekkahani/.test(t) && /instagram\.com\/raaz_ekkahani/.test(t) && /Subscribe, follow and press the bell icon/.test(t) && !/facebook/i.test(t);
add('seo', 'description: CTA block (YouTube + Instagram, English bell line, no Facebook)', ctaOk(desc), '');
add('seo', 'description: fiction/AI note', /काल्पनिक/.test(desc) && /AI/.test(desc), '');
add('seo', 'description in Hindi', (desc.match(/[\u0900-\u097F]/g) || []).length > 80, '');
add('seo', 'Hindi subtitles SRT valid and covers the video', (() => {
  if (!exists(F.srt)) return false; const s = fs.readFileSync(abs(F.srt), 'utf8');
  const cues = [...s.matchAll(/(\d\d):(\d\d):(\d\d)[,.](\d{3}) --> (\d\d):(\d\d):(\d\d)[,.](\d{3})/g)];
  const end = cues.length ? (+cues.at(-1)[5]) * 3600 + (+cues.at(-1)[6]) * 60 + (+cues.at(-1)[7]) : 0;
  return cues.length >= 10 && /[\u0900-\u097F]/.test(s) && (!full || (end <= full.duration + 1 && end >= full.duration * 0.6));
})(), F.srt);
for (const k of ['playlist', 'end_screen', 'pinned_comment', 'category', 'language_hindi', 'synthetic_media_disclosed']) add('seo', `planned: ${k}`, !!(yt[k]), String(yt[k] ?? 'missing'));

// ---------- Short & Instagram texts ----------
const sh = R.short || {}; const st = hashtags(sh.title || '');
add('short', 'short title <= 100 chars with exactly 5 hashtags incl. #shorts #ytshorts', sh.title && sh.title.length <= 100 && st.length === 5 && st.map((h) => h.toLowerCase()).includes('#shorts') && st.map((h) => h.toLowerCase()).includes('#ytshorts'), sh.title);
add('short', 'short description: CTA + "पूरी कहानी देखें" + fiction note', ctaOk(sh.description || '') && /पूरी कहानी देखें/.test(sh.description || '') && /काल्पनिक/.test(sh.description || ''), '');
add('short', 'short burned-in CTA and captions confirmed', sh.burned_cta === true && sh.burned_captions === true, '');
add('short', 'related video planned', !!sh.related_video_plan, String(sh.related_video_plan ?? 'missing'));
const ig = R.instagram || {}; const ih = hashtags(ig.caption || '');
add('instagram', 'caption: exactly 5 hashtags, CTA, fiction note, Hindi', ih.length === 5 && ctaOk(ig.caption || '') && /काल्पनिक/.test(ig.caption || ''), ih.join(' '));
add('instagram', 'AI label on', ig.ai_label === true, '');

// ---------- story completeness ----------
add('story', 'all script dialogue present in final (no omissions)', R.script_lines_total && R.script_lines_in_final === R.script_lines_total, `${R.script_lines_in_final}/${R.script_lines_total}`);
add('story', 'fiction note spoken and shown at the end', R.fiction_note_in_final === true, '');

// Serialized Instagram delivery is additional evidence; the original full-story,
// voice, sound and SEO checks above remain unchanged.
if (R.instagram_parts) {
  const series = readJson(R.instagram_parts), inspection = readJson('qc/instagram-parts-inspection.json');
  add('instagram-series', 'exactly three complete ordered parts', series?.parts?.length === 3 && series.parts.every((p,i)=>p.number===i+1&&p.key===`instagram_part_${i+1}`), '');
  if (series?.parts?.length === 3) {
    const python = process.env.PYTHON || (process.platform === 'win32' ? path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe') : 'python3');
    const measured = spawnSync(python, [path.join(here,'media/instagram_parts_measure.py'),'--dir',dir], {encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let evidence;
    try { if(measured.status===0)evidence=JSON.parse(measured.stdout); } catch {}
    add('instagram-series','independent final decode, contiguous copied speech and source ASR verification',!!evidence,measured.status===0?'Measured all final part files':(measured.stderr||'Verifier failed').slice(-1500));
    if(evidence) {
      fs.writeFileSync(path.join(dir,'qc/instagram-parts-measured.json'),JSON.stringify(evidence,null,2));
      add('instagram-series','all story lines retained once in order',evidence.all_story_lines===Number(R.script_lines_total),`${evidence.all_story_lines}/${R.script_lines_total}`);
      for(const [i,p]of series.parts.entries()) {
        const e=evidence.parts[i],meta=probe(abs(p.file)),cover=probe(abs(p.cover)),text=p.caption||'';
        fileHashes[p.key]=sha(abs(p.file));
        add('instagram-series',`part ${i+1}: video is 1080x1920, 3..900 s, bitrate >=1.5Mbps`,meta?.width===1080&&meta?.height===1920&&meta.duration>=3&&meta.duration<=900&&meta.bitrate>=1_500_000&&Math.abs(meta.duration-p.duration_s)<.1,`${meta?.duration}s, ${meta?.bitrate}bps`);
        add('instagram-series',`part ${i+1}: H.264/HEVC, 23..60 fps, AAC 48kHz, under 1GB`,['h264','hevc'].includes(meta?.videoCodec)&&meta.fps>=23&&meta.fps<=60&&meta.audioCodec==='aac'&&meta.sampleRate===48000&&fs.statSync(abs(p.file)).size<=1_000_000_000,`${meta?.videoCodec}, ${meta?.fps}fps, ${meta?.audioCodec}/${meta?.sampleRate}Hz`);
        add('instagram-series',`part ${i+1}: loudness -16..-13 LUFS, peak <= -1 dBTP`,e.loudness_lufs>=-16&&e.loudness_lufs<=-13&&e.true_peak_dbtp<=-1,`${e.loudness_lufs} LUFS / ${e.true_peak_dbtp} dBTP`);
        add('instagram-series',`part ${i+1}: horror sting in first 2 s, no dead air`,e.intro_lufs>=-26&&!e.dead_air,`${e.intro_lufs} LUFS`);
        add('instagram-series',`part ${i+1}: audible music under voice -28..-22 and in gaps -20..-14 LUFS`,e.music_under_voice_lufs>=-28&&e.music_under_voice_lufs<=-22&&e.music_in_gaps_lufs>=-20&&e.music_in_gaps_lufs<=-14,`${e.music_under_voice_lufs} / ${e.music_in_gaps_lufs} LUFS`);
        add('instagram-series',`part ${i+1}: 1080x1920 JPEG cover <2MB`,cover?.width===1080&&cover?.height===1920&&/\.jpe?g$/i.test(p.cover)&&fs.statSync(abs(p.cover)).size<2*1024*1024,p.cover);
        add('instagram-series',`part ${i+1}: Hindi caption, exactly five hashtags, CTA and fiction/AI disclosure`,hashtags(text).length===5&&ctaOk(text)&&/काल्पनिक/.test(text)&&/AI/.test(text)&&(text.match(/[\u0900-\u097F]/g)||[]).length>80&&text.length<=2200&&p.ai_label===true,`${text.length} characters`);
        const reviewed=inspection?.parts?.find(r=>r.number===p.number);
        add('instagram-series',`part ${i+1}: actual opening, ending, captions, number and cover inspected`,reviewed?.pass===true&&reviewed.file_sha256===e.file_sha256&&reviewed.cover_sha256===e.cover_sha256,'Producer inspection bound to final media');
        const ids=new Set(sfx.filter(s=>(s.placements||[]).some(v=>v.time_s<p.source_end&&v.time_s+v.duration_s>p.source_start)).map(s=>s.id));
        if(p.bumper_units)for(const s of sfx.filter(s=>(s.placements||[]).some(v=>v.time_s<2)))ids.add(s.id);
        add('instagram-series',`part ${i+1}: at least four story-matched SFX preserved`,ids.size>=4,`${ids.size} distinct effects`);
        add('instagram-series',`part ${i+1}: schedule one hour after preceding part`,Number.isFinite(Date.parse(p.scheduled_for))&&(i===0||Date.parse(p.scheduled_for)-Date.parse(series.parts[i-1].scheduled_for)===3600000),p.scheduled_for);
      }
    }
  }
}

finish();
function finish() {
  const failed = checks.filter((c) => !c.pass);
  const report = { story: release?.story_number, folder: dir, checked_at: new Date().toISOString(), pass: failed.length === 0 && checks.length > 1, failed: failed.length, total: checks.length, file_sha256: fileHashes, checks };
  fs.writeFileSync(path.join(dir, 'qc-report.json'), JSON.stringify(report, null, 2));
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  [${c.group}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  console.log(`\n${report.pass ? 'QC GATE PASSED' : `QC GATE FAILED: ${failed.length} of ${checks.length} checks failed. Do NOT schedule or publish.`}`);
  process.exit(report.pass ? 0 : 1);
}
