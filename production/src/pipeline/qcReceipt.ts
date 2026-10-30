import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, digest } from './runtime.js';

/** Cache only an execution we observed exiting zero. Never trust a bare report. */
export async function checkedGate(dir: string, gate: string, execute: () => Promise<void>) {
  const reportFile = path.join(dir, 'qc-report.json'), receiptFile = path.join(dir, 'qc-receipt.json');
  async function inputs() {
    const release = JSON.parse(await fs.readFile(path.join(dir, 'release.json'), 'utf8'));
    const files = [gate, 'release.json', 'voice-qc.json', 'audio-manifest.json',
      ...['full_video', 'short_video', 'reel_video', 'thumbnail', 'reel_cover', 'subtitles_full', 'subtitles_short'].map(k => {
        if (!release[k]) throw Error(`Missing QC input ${k}`); return release[k];
      })].map(f => path.resolve(dir, f));
    if(release.instagram_parts){
      const manifest=path.resolve(dir,release.instagram_parts),series=JSON.parse(await fs.readFile(manifest,'utf8'));
      files.push(manifest,path.join(dir,'qc/instagram-parts-inspection.json'),path.join(path.dirname(gate),'media/instagram_parts.py'),path.join(path.dirname(gate),'media/instagram_parts_measure.py'),path.join(path.dirname(gate),'media/common.py'),path.join(dir,'render-timeline.json'),path.join(dir,'edit/music-stem.wav'));
      for(const p of series.parts)files.push(path.resolve(dir,p.file),path.resolve(dir,p.cover));
      for(const f of [series.source,series.source_voice_qc,series.source_asr])files.push(path.resolve(dir,f));
    }
    const parent = path.dirname(dir);
    const here = path.dirname(gate), win = process.platform === 'win32';
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const candidates = [process.env[tool === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'],
        tool === 'ffmpeg' ? path.join(here, 'outputs/local-tools/node_modules/ffmpeg-static', win ? 'ffmpeg.exe' : 'ffmpeg')
          : path.join(here, 'outputs/local-tools/node_modules/ffprobe-static/bin', win ? 'win32/x64/ffprobe.exe' : `${process.platform}/x64/ffprobe`),
        ...(process.env.PATH ?? '').split(path.delimiter).map(p => path.join(p, tool + (win ? '.exe' : '')))];
      for (const file of candidates) {
        if (!file) continue;
        try { if ((await fs.stat(file)).isFile()) { files.push(path.resolve(file)); break; } }
        catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
      }
    }
    for (const item of await fs.readdir(parent, { withFileTypes: true })) {
      if (item.isDirectory() && path.join(parent, item.name) !== dir) {
        const file = path.join(parent, item.name, 'audio-manifest.json');
        try { await fs.access(file); files.push(file); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      }
    }
    // Include the selected tool configuration; changing the gate or inputs invalidates reuse.
    return JSON.stringify({ tools: [process.env.FFMPEG_PATH, process.env.FFPROBE_PATH, process.env.PATH],
      files: await Promise.all([...new Set(files)].sort().map(async f => [f, await digest(f)])) });
  }
  const before = await inputs();
  try {
    const old = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
    if (old.version === 1 && old.inputs === before && old.report === await digest(reportFile) && report.pass === true) return;
  } catch (e: any) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  await execute();
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  if (!report.pass || before !== await inputs()) throw Error('QC inputs changed during gate execution');
  await atomicJson(receiptFile, { version: 1, checkedAt: new Date().toISOString(), inputs: before, report: await digest(reportFile) });
}
