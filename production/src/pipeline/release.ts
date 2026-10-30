import fs from 'node:fs/promises';
import path from 'node:path';
import { requireQcGate } from '../upload.js';
import { loadProject, markReviewPending, saveProject } from '../reviewState.js';
import { atomicJson, digest } from './runtime.js';
import { resolveSchedule } from './schedule.js';
import { uploadWithCurl } from './mediaUpload.js';
import { reconcilePost, matchingPosts } from './reconcilePost.js';
import { acquireLock } from './lock.js';
import { setTimeout as delay } from 'node:timers/promises';

export interface ReleaseConfig { apiKey: string; youtubeAccountId: string; instagramAccountId: string; scheduledFor?: string; publishNow?: boolean; youtubeOnly?: boolean; instagramPartsOnly?: boolean }
interface ReleaseJob { kind: string; key: string; file: string; content: string; title?: string; image?: string; platform: string; account: string; scheduledFor?: string }
interface Dependencies { http?: typeof fetch; gate?: (file: string) => Promise<void>; put?: typeof uploadWithCurl; now?: () => Date }
export async function scheduleRelease(directory: string, config: ReleaseConfig, projectFile?: string, signal = new AbortController().signal, dependencies: Dependencies = {}) {
  const dir = path.resolve(directory), http = dependencies.http ?? fetch, put = dependencies.put ?? uploadWithCurl;
  const lockPath = projectFile ? `${projectFile}.upload.lock` : path.join(dir, '.release.lock');
  const releaseLock = await acquireLock(lockPath);
  try {
    const releaseFile = path.join(dir, 'release.json'), release = JSON.parse(await fs.readFile(releaseFile, 'utf8'));
    await (dependencies.gate ?? (file => requireQcGate(file, signal)))(path.resolve(dir, release.full_video));
    const qcFile = path.join(dir, 'qc-report.json'), qc = JSON.parse(await fs.readFile(qcFile, 'utf8'));
    if (!qc.pass) throw Error('Mandatory release gate did not pass');
    const series = release.instagram_parts ? JSON.parse(await fs.readFile(path.resolve(dir, release.instagram_parts), 'utf8')) : undefined;
    if(series && (series.parts?.length!==3 || series.parts.some((p:any,i:number)=>p.number!==i+1||p.key!==`instagram_part_${i+1}`||!Number.isFinite(Date.parse(p.scheduled_for))||(i>0&&Date.parse(p.scheduled_for)-Date.parse(series.parts[i-1].scheduled_for)!==3600000))))throw Error('Instagram parts must be numbered uniquely in story order with one-hour schedules');
    if (config.instagramPartsOnly && (!series || series.parts?.length !== 3 || config.publishNow || config.youtubeOnly)) throw Error('Instagram multipart scheduling requires exactly three checked parts and scheduled publishing');
    const instagramJobs: ReleaseJob[] = series ? series.parts.map((p: any) => ({kind: p.key, key: p.key, file: path.resolve(dir,p.file), image: path.resolve(dir,p.cover), content:p.caption, platform:'instagram', account:config.instagramAccountId, scheduledFor:p.scheduled_for})) : [
      { kind: 'instagram_reel', key: 'reel', file: path.resolve(dir, release.reel_video), content: release.instagram.caption, image: path.resolve(dir, release.reel_cover), platform: 'instagram', account: config.instagramAccountId },
    ];
    const jobs: ReleaseJob[] = [
      { kind: 'youtube', key: 'full', file: path.resolve(dir, release.full_video), content: release.youtube.description, title: release.youtube.title, image: path.resolve(dir, release.thumbnail), platform: 'youtube', account: config.youtubeAccountId },
      { kind: 'youtube_short', key: 'short', file: path.resolve(dir, release.short_video), content: release.short.description, title: release.short.title, platform: 'youtube', account: config.youtubeAccountId },
      ...instagramJobs,
    ].filter(j => (!config.youtubeOnly || j.platform === 'youtube') && (!config.instagramPartsOnly || j.platform === 'instagram'));
    for (const j of jobs) if (await digest(j.file) !== qc.file_sha256[j.key]) throw Error(`QC video hash mismatch: ${j.kind}`);
    const immutableFiles = [releaseFile, qcFile, path.join(dir, 'voice-qc.json'), path.join(dir, 'audio-manifest.json'),
      ...[release.subtitles_full, release.subtitles_short].filter(Boolean).map(f => path.resolve(dir, f)),
      ...jobs.map(j => j.file), ...jobs.flatMap(j => j.image ? [j.image] : []),
      ...(series ? [path.resolve(dir,release.instagram_parts), path.join(dir,'qc/instagram-parts-inspection.json')] : [])];
    const immutable = await Promise.all(immutableFiles.map(async f => [f, await digest(f)] as const));
    async function api(endpoint: string, body?: unknown): Promise<any> {
      const response = await http(`https://zernio.com/api/v1${endpoint}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([signal, AbortSignal.timeout(body && endpoint === '/posts' ? 90_000 : 30_000)]) });
      if (!response.ok) throw Error(`Zernio ${endpoint.split('?')[0]} HTTP ${response.status}`);
      return response.json(); // POST is deliberately never retried automatically.
    }
    const response = await api('/accounts'), accounts = response.accounts ?? response;
    for (const [id, platform] of [...new Map(jobs.map(j => [j.account, [j.account, j.platform]])).values()]) {
      const a = accounts.find((x: any) => x._id === id && x.platform === platform);
      if (!a || a.isActive === false || a.isConnected === false || a.needsReconnection === true || /disconnected|expired/i.test(a.connectionStatus ?? '')) throw Error(`${platform} account is not connected`);
    }
    const cacheFile = path.join(dir, 'uploaded-media.json'); let cache: Record<string, { url: string; file: string; size: number }> = {};
    let cacheWrite = Promise.resolve();
    try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    async function upload(file: string, contentType: string) {
      const hash = await digest(file); if (cache[hash]) return cache[hash].url;
      const stat = await fs.stat(file), media = await api('/media/presign', { filename: path.basename(file), contentType, size: stat.size });
      await put(file, media.uploadUrl, contentType, signal);
      if (await digest(file) !== hash) throw Error('Asset changed while uploading');
      cache[hash] = { url: media.publicUrl, file, size: stat.size };
      cacheWrite = cacheWrite.then(() => atomicJson(cacheFile, cache)); await cacheWrite; return media.publicUrl;
    }
    const saved: Record<string, any> = {};
    for (const j of jobs) {
      try { saved[j.kind] = JSON.parse(await fs.readFile(path.join(dir, `${j.kind}-submission-marker.json`), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (saved[j.kind] && saved[j.kind].sha256 !== qc.file_sha256[j.key]) throw Error(`Submitted ${j.kind} differs from current QC media; never reuse its post ID`);
      if (saved[j.kind] && j.scheduledFor && Date.parse(saved[j.kind].request?.scheduledFor) !== Date.parse(j.scheduledFor)) throw Error('Existing part has a different time; reschedule its saved ID instead of reposting');
      if (saved[j.kind] && !saved[j.kind].id) {
        saved[j.kind].id = await reconcilePost(api, saved[j.kind].request);
        saved[j.kind].status = 'submitted';
        await atomicJson(path.join(dir, `${j.kind}-submission-marker.json`), saved[j.kind]);
      }
    }
    // Upload once, reusing durable content hashes. Never render again for a PUT retry.
    const media: Record<string, { video: string; image?: string }> = {};
    const pending = jobs.filter(j => !saved[j.kind]);
    // Two transfer workers overlap network waits without saturating the small host.
    // Drain both workers before releasing the lock, even if one transfer fails.
    const transfers = await Promise.allSettled(Array.from({ length: Math.min(2, pending.length) }, async () => {
      while (pending.length) {
        const j = pending.shift()!;
        media[j.kind] = { video: await upload(j.file, 'video/mp4'), image: j.image ? await upload(j.image, 'image/jpeg') : undefined };
      }
    }));
    for (const result of transfers) if (result.status === 'rejected') throw result.reason;
    for (const [file, hash] of immutable) if (await digest(file) !== hash) throw Error('Release changed after QC; no new post submitted');
    const existingTimes = [...new Set(Object.values(saved).map(x => x.scheduledFor).filter(Boolean))];
    if (!series && existingTimes.length > 1) throw Error('Existing delivery schedule times differ; manual reconciliation required');
    if (!series && existingTimes.length && config.scheduledFor && Date.parse(existingTimes[0]) !== Date.parse(config.scheduledFor))
      throw Error('Existing posts have a different time; reschedule those IDs instead of creating or silently reusing posts');
    const immediate = config.publishNow === true;
    if (immediate && Object.values(saved).some(x => x.request?.publishNow !== true)) throw Error('Existing scheduled posts must be edited, never reposted');
    const scheduledFor = config.instagramPartsOnly ? series.parts[0].scheduled_for : (existingTimes[0] ?? (immediate ? undefined : resolveSchedule((dependencies.now ?? (() => new Date()))(), config.scheduledFor)));
    if (projectFile && !config.instagramPartsOnly && !Object.keys(saved).length) {
      let p = await loadProject(projectFile);
      if (p.review?.submission_started_at || p.review?.zernio_post_id) throw Error('Legacy submission exists; recover its marker before scheduling');
      await markReviewPending(projectFile, jobs[0].file, release.youtube.title); p = await loadProject(projectFile);
      Object.assign(p.review!, { status: 'approved', decided_at: new Date().toISOString(), scheduled_for: scheduledFor, timezone: 'Asia/Kolkata' }); await saveProject(projectFile, p);
    }
    const verified: Array<{kind:string;id:string;status:string;platform_status:string|undefined;scheduledFor:string|undefined;url:string|undefined;sha256:string}> = [];
    let playlistId = release.youtube.playlist_id;
    if (!playlistId) { try { playlistId = JSON.parse(await fs.readFile(path.join(dir, 'playlist.json'), 'utf8')).id; } catch {} }
    for (const j of jobs) {
      signal.throwIfAborted(); const markerFile = path.join(dir, `${j.kind}-submission-marker.json`); let id = saved[j.kind]?.id;
      const jobTime = j.scheduledFor ?? scheduledFor;
      if (!id) {
        if (!immediate && (!Number.isFinite(Date.parse(jobTime!)) || Date.parse(jobTime!) <= (dependencies.now ?? (() => new Date()))().getTime())) throw Error('Schedule elapsed during submission; no publish-now fallback');
        const m = media[j.kind], instagram = j.platform === 'instagram';
        const specific = instagram ? { isAiGenerated: true, shareToFeed: true, instagramThumbnail: m.image } : { title: j.title, visibility: 'public', madeForKids: false, containsSyntheticMedia: true, categoryId: '1', ...(playlistId ? { playlistId } : {}), ...(j.kind === 'youtube' ? { firstComment: release.youtube.pinned_comment } : {}) };
        const body = { content: j.content, ...(!instagram ? { tags: release.youtube.tags } : {}), mediaItems: [{ type: 'video', url: m.video, ...(j.kind === 'youtube' ? { thumbnail: m.image } : {}), ...(instagram ? { instagramThumbnail: m.image } : {}) }], platforms: [{ platform: j.platform, accountId: j.account, platformSpecificData: specific }], ...(!immediate ? {scheduledFor:jobTime} : {}), timezone: 'Asia/Kolkata', publishNow: immediate };
        const marker = { kind: j.kind, status: 'submission_started_do_not_retry', scheduledFor:jobTime, sha256: qc.file_sha256[j.key], request: body };
        await fs.writeFile(markerFile, JSON.stringify(marker, null, 2), { flag: 'wx' });
        try {
          const created = await api('/posts', body); id = (created.post ?? created)._id ?? (created.post ?? created).id;
        } catch (error) {
          signal.throwIfAborted();
          id = await reconcilePost(api, body);
        }
        if (!id) throw Error('Post response missing ID; recover uncertain marker before retry');
        await atomicJson(markerFile, { ...marker, id, status: 'submitted' });
      }
      const got = await api(`/posts/${id}`), post = got.post ?? got, platform = post.platforms?.find((p: any) => (p.accountId?._id ?? p.accountId) === j.account && p.platform === j.platform);
      if (!platform) throw Error(`${j.kind} returned a different account; saved marker retained`);
      const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
      if (matchingPosts([post], marker.request).length !== 1) throw Error(`${j.kind} returned different media/text/time; saved marker retained`);
      if (['failed','error'].includes(platform.status)) throw Error(`${j.kind} platform failed; saved marker retained`);
      if (!(immediate ? ['pending','processing','publishing','published','scheduled'] : ['scheduled', 'published']).includes(post.status)) throw Error(`${j.kind} returned ${post.status}; saved marker retained`);
      if (!immediate && post.status === 'scheduled' && Date.parse(post.scheduledFor) !== Date.parse(jobTime!)) throw Error('Returned schedule differs');
      if (j.kind === 'youtube' && !post.mediaItems?.some((m: any) => m.thumbnail)) throw Error('YouTube thumbnail not verified');
      // Zernio promotes uploaded images from /temp/ to /media/. Compare the
      // unique uploaded object (also checked by matchingPosts), never accept an
      // arbitrary cover merely because the returned field is nonempty.
      if (j.platform === 'instagram' && (!post.mediaItems?.some((m: any) => m.instagramThumbnail && new URL(m.instagramThumbnail).pathname.split('/').pop() === new URL(marker.request.mediaItems[0].instagramThumbnail).pathname.split('/').pop()) || platform?.platformSpecificData?.isAiGenerated !== true)) throw Error('Reel cover or AI label not verified');
      verified.push({ kind: j.kind, id, status: post.status, platform_status: platform?.status, scheduledFor: post.scheduledFor, url: platform?.platformPostUrl, sha256: qc.file_sha256[j.key] });
      await atomicJson(path.join(dir, config.instagramPartsOnly ? 'instagram-parts-submission-verification.json' : 'submission-verification.json'), { checked_at: new Date().toISOString(), posts: verified });
    }
    if (immediate) for (const receipt of verified) {
      const deadline = Date.now() + 180_000;
      while (receipt.status !== 'published') {
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw Error('Publication still processing; saved IDs retained, resume verification without another POST');
        await delay(5000, undefined, {signal});
        const result = await api(`/posts/${receipt.id}`), post = result.post ?? result;
        const platform = post.platforms?.find((p: any) => p.platform === (receipt.kind === 'instagram_reel' ? 'instagram' : 'youtube'));
        if (post.status === 'failed' || platform?.status === 'failed') throw Error(`Publication failed: ${receipt.kind}; saved ID retained`);
        Object.assign(receipt,{status:post.status,platform_status:platform?.status,url:platform?.platformPostUrl});
        await atomicJson(path.join(dir,'submission-verification.json'),{checked_at:new Date().toISOString(),posts:verified});
      }
    }
    const status = config.youtubeOnly ? (immediate ? 'partially_published' : 'partially_scheduled') : (immediate ? 'published' : 'scheduled');
    let earlier: any = {};
    if (config.instagramPartsOnly) {try {earlier=JSON.parse(await fs.readFile(path.join(dir,'delivery.json'),'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}}
    const combined=config.instagramPartsOnly ? [...(earlier.posts??[]).filter((p:any)=>!verified.some(v=>v.kind===p.kind)),...verified] : verified;
    if (projectFile) { const p = await loadProject(projectFile); if(!config.instagramPartsOnly)Object.assign(p.review!, { status: config.youtubeOnly ? 'approved' : (immediate ? 'posted' : 'scheduled'), scheduled_for: scheduledFor, zernio_post_id: verified[0].id }); else if(p.review)p.review.status='scheduled'; p.deliveries = combined; await saveProject(projectFile, p); }
    const delivery = { ...earlier,status, pending: config.youtubeOnly ? ['instagram_reel'] : [], scheduled_for: scheduledFor, timezone: 'Asia/Kolkata', posts: combined, qc_pass: true, video_path: earlier.video_path??jobs[0].file, instagram_reel: series?undefined:jobs[2]?.file, instagram_cover:series?undefined:jobs[2]?.image, ...(series?{instagram_parts:series.parts.map((p:any)=>({file:p.file,cover:p.cover,scheduledFor:p.scheduled_for}))}:{}), chat_markdown: earlier.chat_markdown??`[तैयार वीडियो](<${jobs[0].file.replaceAll('\\', '/')}>)` };
    await atomicJson(path.join(dir, 'delivery.json'), delivery); return delivery;
  } finally { await releaseLock(); }
}
