import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scheduleRelease } from './release.js';
import { atomicJson, digest } from './runtime.js';
test('three-post release checks gate first, keeps full Reel, and resumes without duplicate POST/PUT', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const file of ['full.mp4', 'short.mp4', 'reel.mp4', 'thumb.jpg', 'cover.jpg', 'voice-qc.json', 'audio-manifest.json']) await fs.writeFile(path.join(dir, file), file);
  await atomicJson(path.join(dir, 'release.json'), { full_video: 'full.mp4', short_video: 'short.mp4', reel_video: 'reel.mp4', thumbnail: 'thumb.jpg', reel_cover: 'cover.jpg', youtube: { title: 'पूर्ण कहानी', description: 'पूर्ण', tags: ['horror'] }, short: { title: 'झलक', description: 'झलक' }, instagram: { caption: 'पूरी कहानी' } });
  // Synthetic report belongs only to this isolated network-free unit fixture.
  await atomicJson(path.join(dir, 'qc-report.json'), { pass: true, file_sha256: { full: await digest(path.join(dir, 'full.mp4')), short: await digest(path.join(dir, 'short.mp4')), reel: await digest(path.join(dir, 'reel.mp4')) } });
  const posts: any[] = []; let puts = 0, calls = 0;
  const http = (async (url: any, options: any) => {
    calls++; const endpoint = new URL(url).pathname;
    if (endpoint.endsWith('/accounts')) return Response.json({ accounts: [{ _id: 'yt', platform: 'youtube', isConnected: true }, { _id: 'ig', platform: 'instagram', isConnected: true }] });
    if (endpoint.endsWith('/media/presign')) { const body = JSON.parse(options.body); return Response.json({ uploadUrl: 'https://upload.test', publicUrl: `https://media.test/${body.filename}` }); }
    if (endpoint.endsWith('/posts') && options.method === 'GET') return Response.json({ posts });
    if (endpoint.endsWith('/posts')) {
      const body=JSON.parse(options.body);
      const post = { ...body, _id: String(posts.length), status: body.publishNow ? 'published' : 'scheduled' }; posts.push(post);
      // Server accepted Instagram, but its reply was lost. Recovery must GET, never POST twice.
      if (post.platforms[0].platform === 'instagram') throw Error('response timeout');
      return Response.json({ post });
    }
    return Response.json({ post: posts[Number(endpoint.split('/').at(-1))] });
  }) as typeof fetch;
  const config = { apiKey: 'test-only', youtubeAccountId: 'yt', instagramAccountId: 'ig' };
  await assert.rejects(scheduleRelease(dir, config, undefined, undefined, { http, gate: async () => { throw Error('gate fails'); } }), /gate fails/); assert.equal(calls, 0);
  let active = 0, peak = 0;
  const deps = { http, gate: async () => {}, put: async () => {
    puts++; active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--;
  }, now: () => new Date('2026-10-21T07:00:00Z') };
  const delivery = await scheduleRelease(dir, config, undefined, undefined, deps);
  assert.equal(delivery.posts.length, 3); assert.equal(posts.length, 3); assert.equal(puts, 5);
  assert.equal(peak, 2); assert.equal(active, 0);
  assert.ok(posts.every(p => p.publishNow === false && p.scheduledFor === '2026-10-21T08:00:00.000Z'));
  assert.ok(posts[2].mediaItems[0].url.endsWith('/reel.mp4')); assert.ok(posts[2].mediaItems[0].instagramThumbnail.endsWith('/cover.jpg')); assert.equal(posts[2].platforms[0].platformSpecificData.isAiGenerated, true);
  await scheduleRelease(dir, config, undefined, undefined, deps); assert.equal(posts.length, 3); assert.equal(puts, 5);
  const immediateDir=path.join(dir,'immediate');await fs.mkdir(immediateDir);
  for(const file of ['full.mp4','short.mp4','reel.mp4','thumb.jpg','cover.jpg','voice-qc.json','audio-manifest.json','release.json','qc-report.json','uploaded-media.json'])await fs.copyFile(path.join(dir,file),path.join(immediateDir,file));
  const immediateRelease=JSON.parse(await fs.readFile(path.join(immediateDir,'release.json'),'utf8'));
  immediateRelease.youtube.description+=' immediate';immediateRelease.short.description+=' immediate';immediateRelease.instagram.caption+=' immediate';await atomicJson(path.join(immediateDir,'release.json'),immediateRelease);
  const immediate=await scheduleRelease(immediateDir,{...config,publishNow:true},undefined,undefined,deps);
  assert.equal(immediate.status,'published');assert.ok(posts.slice(3).every(p=>p.publishNow===true&&!('scheduledFor'in p)));
  await scheduleRelease(immediateDir,{...config,publishNow:true},undefined,undefined,deps);assert.equal(posts.length,6);
  await assert.rejects(scheduleRelease(dir, {...config,scheduledFor:'2026-10-22T08:00:00Z'},undefined,undefined,deps), /different time/);
  assert.equal(posts.length,6);
  const markerFile = path.join(dir, 'instagram_reel-submission-marker.json');
  const marker = JSON.parse(await fs.readFile(markerFile, 'utf8')); delete marker.id; await atomicJson(markerFile, marker);
  await scheduleRelease(dir, config, undefined, undefined, deps); assert.equal(posts.length, 6); assert.equal(puts, 5);
  await fs.writeFile(path.join(dir, 'reel.mp4'), 'changed');
  await assert.rejects(scheduleRelease(dir, config, undefined, undefined, deps), /hash mismatch/); assert.equal(posts.length, 6);
  const partialDir=path.join(dir,'youtube-only');await fs.mkdir(partialDir);
  for(const file of ['full.mp4','short.mp4','reel.mp4','thumb.jpg','cover.jpg','voice-qc.json','audio-manifest.json','release.json','qc-report.json','uploaded-media.json'])await fs.copyFile(path.join(immediateDir,file),path.join(partialDir,file));
  const partial=await scheduleRelease(partialDir,{...config,publishNow:true,youtubeOnly:true},undefined,undefined,deps);
  assert.equal(partial.status,'partially_published');assert.deepEqual(partial.pending,['instagram_reel']);
  assert.equal(partial.posts.length,2);assert.ok(posts.slice(6).every(p=>p.platforms[0].platform==='youtube'));
  assert.equal(await fs.stat(path.join(partialDir,'instagram_reel-submission-marker.json')).then(()=>true,()=>false),false);
  await scheduleRelease(partialDir,{...config,publishNow:true,youtubeOnly:true},undefined,undefined,deps);assert.equal(posts.length,8);
});

test('multipart Instagram keeps hourly schedules, exact covers, prior YouTube delivery and timeout-safe IDs', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'instagram-series-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(path.join(dir,'qc'));
 const parts=[];
 for(let n=1;n<=3;n++){
  const file=`part-${n}.mp4`,cover=`cover-${n}.jpg`;await fs.writeFile(path.join(dir,file),file);await fs.writeFile(path.join(dir,cover),cover);
  parts.push({number:n,key:`instagram_part_${n}`,file,cover,caption:`भाग ${n}`,scheduled_for:`2026-10-30T0${n-1}:00:00+05:30`});
 }
 for(const f of ['full.mp4','voice-qc.json','audio-manifest.json'])await fs.writeFile(path.join(dir,f),f);
 await atomicJson(path.join(dir,'instagram-parts.json'),{parts});await atomicJson(path.join(dir,'qc/instagram-parts-inspection.json'),{});
 await atomicJson(path.join(dir,'release.json'),{full_video:'full.mp4',short_video:'unused-short.mp4',reel_video:'unused-reel.mp4',thumbnail:'unused-thumb.jpg',reel_cover:'unused-cover.jpg',instagram_parts:'instagram-parts.json',youtube:{},short:{},instagram:{}});
 await atomicJson(path.join(dir,'delivery.json'),{video_path:'saved-youtube-master.mp4',posts:[{kind:'youtube',id:'existing-yt',status:'scheduled'},{kind:'youtube_short',id:'existing-short',status:'scheduled'}]});
 const hashes=Object.fromEntries(await Promise.all(parts.map(async p=>[p.key,await digest(path.join(dir,p.file))])));
 await atomicJson(path.join(dir,'qc-report.json'),{pass:true,file_sha256:hashes});
 const posts:any[]=[];let puts=0;
 const http=(async(url:any,o:any)=>{const endpoint=new URL(url).pathname;
  if(endpoint.endsWith('/accounts'))return Response.json({accounts:[{_id:'ig',platform:'instagram',isConnected:true}]});
  if(endpoint.endsWith('/media/presign')){const r=JSON.parse(o.body);return Response.json({uploadUrl:'https://upload.test',publicUrl:'https://media.test/'+r.filename});}
  if(endpoint.endsWith('/posts')&&o.method==='GET')return Response.json({posts});
  if(endpoint.endsWith('/posts')){const body=JSON.parse(o.body);const p={...body,mediaItems:body.mediaItems.map((m:any)=>({...m,instagramThumbnail:m.instagramThumbnail.replace('https://media.test/','https://cdn.test/stored/')})),_id:'part-'+posts.length,status:'scheduled'};posts.push(p);if(posts.length===2)throw Error('Lost accepted POST reply');return Response.json({post:p});}
  return Response.json({post:posts.find(p=>p._id===endpoint.split('/').at(-1))});
 })as typeof fetch;
 const config={apiKey:'fixture',youtubeAccountId:'yt',instagramAccountId:'ig',instagramPartsOnly:true};
 const deps={http,gate:async()=>{},put:async()=>{puts++;},now:()=>new Date('2026-10-29T08:00:00Z')};
 const delivered=await scheduleRelease(dir,config,undefined,undefined,deps);
 assert.equal(posts.length,3);assert.equal(puts,6);assert.equal(delivered.posts.length,5);assert.equal(delivered.posts[0].id,'existing-yt');assert.equal(delivered.status,'scheduled');
 for(let i=0;i<3;i++){
  assert.equal(Date.parse(posts[i].scheduledFor),Date.parse(parts[i].scheduled_for));assert.equal(posts[i].publishNow,false);
  assert.equal(posts[i].mediaItems[0].instagramThumbnail,'https://cdn.test/stored/'+parts[i].cover);assert.equal(posts[i].platforms[0].platformSpecificData.isAiGenerated,true);
 }
 await scheduleRelease(dir,config,undefined,undefined,deps);assert.equal(posts.length,3);assert.equal(puts,6);
 posts[0].mediaItems[0].instagramThumbnail='https://media.test/wrong-cover.jpg';
 await assert.rejects(scheduleRelease(dir,config,undefined,undefined,deps),/cover or AI label|different media\/text\/time/);assert.equal(posts.length,3);
 posts[0].mediaItems[0].instagramThumbnail='https://cdn.test/stored/'+parts[0].cover;
 const manifest={parts:parts.map(p=>({...p,scheduled_for:new Date(Date.parse(p.scheduled_for)+86400000).toISOString()}))};await atomicJson(path.join(dir,'instagram-parts.json'),manifest);
 await assert.rejects(scheduleRelease(dir,config,undefined,undefined,deps),/different time/);assert.equal(posts.length,3);
});
