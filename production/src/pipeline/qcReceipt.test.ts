import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkedGate } from './qcReceipt.js';
import { matchingPosts } from './reconcilePost.js';

test('unchanged QC runs once; changed media, metadata, report and failed execution invalidate receipt', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-cache-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'story'); await fs.mkdir(dir);
  const fields = ['full_video','short_video','reel_video','thumbnail','reel_cover','subtitles_full','subtitles_short'];
  const release = Object.fromEntries(fields.map(k => [k, k + '.fixture']));
  for (const file of [...Object.values(release), 'voice-qc.json','audio-manifest.json','gate.fixture']) await fs.writeFile(path.join(dir,file),file);
  const oldTools=[process.env.FFMPEG_PATH,process.env.FFPROBE_PATH];
  process.env.FFMPEG_PATH=process.env.FFPROBE_PATH=path.join(dir,'gate.fixture');
  t.after(()=>{for(const [i,key]of ['FFMPEG_PATH','FFPROBE_PATH'].entries())if(oldTools[i]===undefined)delete process.env[key];else process.env[key]=oldTools[i];});
  await fs.writeFile(path.join(dir,'release.json'),JSON.stringify(release));
  let runs = 0;
  // Reports are synthetic only inside this isolated test fixture.
  const execute = async () => { runs++; await fs.writeFile(path.join(dir,'qc-report.json'),JSON.stringify({pass:true})); };
  const run = () => checkedGate(dir,path.join(dir,'gate.fixture'),execute);
  await run(); await run(); assert.equal(runs,1);
  for (const file of [release.full_video,release.subtitles_full,'voice-qc.json','gate.fixture','qc-report.json']) {
    await fs.appendFile(path.join(dir,file),' '); await run();
  }
  assert.equal(runs,6);
  await fs.appendFile(path.join(dir,release.reel_cover),'changed');
  await assert.rejects(checkedGate(dir,path.join(dir,'gate.fixture'),async()=>{throw Error('failed gate');}),/failed gate/);
  await run(); assert.equal(runs,7);
  await fs.mkdir(path.join(parent,'previous')); await fs.writeFile(path.join(parent,'previous','audio-manifest.json'),'{}');
  await run(); assert.equal(runs,8);
  // A receipt for the parent video must never authorize changed derivative bytes
  // or changed inspection/verifier evidence in an Instagram series.
  await fs.mkdir(path.join(dir,'qc'));await fs.mkdir(path.join(dir,'media'));await fs.mkdir(path.join(dir,'edit'));
  for(const f of ['part.mp4','part-cover.jpg','asr.fixture','qc/instagram-parts-inspection.json','media/instagram_parts.py','media/instagram_parts_measure.py','media/common.py','render-timeline.json','edit/music-stem.wav'])await fs.writeFile(path.join(dir,f),f);
  await atomicSeries();await run();assert.equal(runs,9);
  for(const f of ['part.mp4','part-cover.jpg','asr.fixture','qc/instagram-parts-inspection.json','media/instagram_parts.py']){await fs.appendFile(path.join(dir,f),'changed');await run();}
  assert.equal(runs,14);
  async function atomicSeries(){
    await fs.writeFile(path.join(dir,'series.json'),JSON.stringify({source:release.reel_video,source_voice_qc:'voice-qc.json',source_asr:'asr.fixture',parts:[{file:'part.mp4',cover:'part-cover.jpg'}]}));
    await fs.writeFile(path.join(dir,'release.json'),JSON.stringify({...release,instagram_parts:'series.json'}));
  }
});

test('post recovery accepts CDN hostname changes, rejects wrong account/media/time and exposes ambiguity', () => {
  const request={content:'story',scheduledFor:'2026-10-23T14:00:00Z',platforms:[{platform:'instagram',accountId:'ig'}],mediaItems:[{type:'video',url:'https://upload.test/bucket/media/unique.mp4'}]};
  const post={...request,_id:'one',platforms:[{platform:'instagram',accountId:{_id:'ig'}}],mediaItems:[{type:'video',url:'https://cdn.test/media/unique.mp4'}]};
  assert.equal(matchingPosts([post],request).length,1);
  assert.equal(matchingPosts([post,{...post,_id:'two'}],request).length,2);
  assert.equal(matchingPosts([{...post,scheduledFor:'2026-10-24T14:00:00Z'}],request).length,0);
  assert.equal(matchingPosts([{...post,platforms:[{platform:'instagram',accountId:'other'}]}],request).length,0);
  assert.equal(matchingPosts([{...post,mediaItems:[{type:'video',url:'https://cdn.test/other.mp4'}]}],request).length,0);
});
