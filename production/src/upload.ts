import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadProject, saveProject } from './reviewState.js';
import { setup, ask, type Config } from './setupConfig.js';
import { youtubeMetadata } from './youtubeMetadata.js';
import { fileURLToPath } from 'node:url';
import { checkedGate } from './pipeline/qcReceipt.js';
import { runCommand } from './pipeline/process.js';
/** Release quality gate: refuses any upload unless production/qc-gate.mjs passes for this exact file. */
export async function requireQcGate(videoPath: string, signal = AbortSignal.timeout(3 * 60_000)): Promise<void> {
  const gate = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'qc-gate.mjs');
  const dir = path.dirname(videoPath);
  await checkedGate(dir, gate, async () => {
    await runCommand(process.execPath, [gate, '--dir', dir], { cwd: dir, logFile: path.join(dir,'qc/gate.log'), signal });
    const report = JSON.parse(await fs.readFile(path.join(dir, 'qc-report.json'), 'utf8'));
    if (!report.pass) throw new Error(`QC gate failed for ${dir}; inspect qc-report.json and qc/gate.log`);
  });
  signal.throwIfAborted();
  const report = JSON.parse(await fs.readFile(path.join(dir, 'qc-report.json'), 'utf8'));
  const voice = JSON.parse(await fs.readFile(path.join(dir, 'voice-qc.json'), 'utf8'));
  for (const kind of ['full', 'short', 'reel']) {
    if (voice.final_mix_evidence?.[`${kind}_sha256`] !== report.file_sha256?.[kind])
      throw new Error(`Final voice QC does not cover the current ${kind} file; rerun final voice QC before scheduling.`);
  }
  const hash = await fingerprint(videoPath);
  if (!Object.values(report.file_sha256 ?? {}).includes(hash)) throw new Error('The video being uploaded is not the file that passed the QC gate.');
}
// India has a fixed UTC+05:30 offset and no daylight-saving changes.
export function nextPublishingSlot(now = new Date()): string {
  const india = new Date(now.getTime() + 330 * 60_000);
  const slot = new Date(Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate(), 8, 0)); // 1:30 PM IST
  if (slot.getTime() <= now.getTime()) slot.setUTCDate(slot.getUTCDate() + 1);
  return slot.toISOString();
}
export async function fingerprint(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function publishApproved(projectFile: string, config?: Config, http: typeof fetch = fetch, gate: (video: string) => Promise<void> = requireQcGate) {
  const lock = await fs.open(`${projectFile}.upload.lock`, 'wx');
  try {
    const project = await loadProject(projectFile);
    const review = project.review;
    if (!review || review.status !== 'approved') throw new Error('Only an approved video can be uploaded.');
    if (review.zernio_post_id || review.submission_started_at) throw new Error('An upload was already submitted. Check its Zernio status before any retry.');
    if (!review.video_sha256 || await fingerprint(review.video_path) !== review.video_sha256) throw new Error('Video changed since review. Request a new review.');
    await gate(review.video_path);
    const settings = config ?? await setup(false);
    const metadata = youtubeMetadata(project);
    review.title = metadata.title;
    review.description = metadata.description;
    review.tags = metadata.tags;
    const request = async (endpoint: string, body?: unknown): Promise<any> => {
      const response = await http(`https://zernio.com/api/v1${endpoint}`, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new Error(`Zernio request failed (${response.status}) at ${endpoint}.`);
      return response.json();
    };
    const accounts = await request('/accounts');
    if (!(accounts.accounts ?? accounts).some((a: any) => a._id === settings.accountId && a.platform === 'youtube')) throw new Error('The account ID is not a connected YouTube account for this API key.');
    const stat = await fs.stat(review.video_path);
    if (!stat.size || stat.size > 5 * 1024 ** 3) throw new Error('Video must be nonempty and within the 5 GB upload limit.');
    const media = await request('/media/presign', { filename: path.basename(review.video_path), contentType: 'video/mp4', size: stat.size });
    const upload = await http(media.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size) }, body: createReadStream(review.video_path), duplex: 'half' } as any);
    if (!upload.ok) throw new Error(`Media upload failed (${upload.status}).`);
    let thumbnail: string | undefined;
    if (review.thumbnail_path) {
      const bytes = await fs.readFile(review.thumbnail_path);
      if (!bytes.length || bytes.length > 2 * 1024 ** 2) throw new Error('Thumbnail must be nonempty and at most 2 MB.');
      const image = await request('/media/presign', { filename: path.basename(review.thumbnail_path), contentType: 'image/jpeg', size: bytes.length });
      const sent = await http(image.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: bytes });
      if (!sent.ok) throw new Error(`Thumbnail upload failed (${sent.status}).`);
      thumbnail = image.publicUrl;
    }
    if (await fingerprint(review.video_path) !== review.video_sha256) throw new Error('Video changed during upload. Request a new review.');
    review.submission_started_at = new Date().toISOString();
    review.status = 'submitting';
    await saveProject(projectFile, project);
    const scheduledFor = review.scheduled_for ?? nextPublishingSlot();
    if (!Number.isFinite(Date.parse(scheduledFor)) || Date.parse(scheduledFor) <= Date.now()) throw new Error('The requested publishing time must still be in the future.');
    review.scheduled_for = scheduledFor;
    review.timezone = 'Asia/Kolkata';
    await saveProject(projectFile, project);
    const result = await request('/posts', {
      content: review.description, tags: review.tags, mediaItems: [{ type: 'video', url: media.publicUrl, ...(thumbnail ? { thumbnail } : {}) }],
      platforms: [{ platform: 'youtube', accountId: settings.accountId, platformSpecificData: { title: (review.title || 'Untitled Video').slice(0, 100), visibility: settings.visibility, madeForKids: false, containsSyntheticMedia: true } }], scheduledFor, timezone: 'Asia/Kolkata', publishNow: false,
    });
    review.zernio_post_id = result.post?._id;
    const youtube = result.post?.platforms?.find((p: any) => p.platform === 'youtube');
    review.youtube_url = youtube?.platformPostUrl;
    review.status = youtube?.status === 'published' ? 'posted' : youtube?.status === 'failed' ? 'failed' : result.post?.status === 'scheduled' ? 'scheduled' : 'submitted';
    if (review.status === 'posted') review.posted_at = new Date().toISOString();
    await saveProject(projectFile, project);
    return review;
  } finally { await lock.close(); await fs.unlink(`${projectFile}.upload.lock`); }
}
export async function decide(projectFile: string, approve: boolean) {
  const lock = await fs.open(`${projectFile}.upload.lock`, 'wx');
  let review;
  try {
    const project = await loadProject(projectFile);
    if (!project.review || project.review.status !== 'awaiting_approval') throw new Error('This video is not awaiting approval.');
    project.review.status = approve ? 'approved' : 'rejected';
    project.review.decided_at = new Date().toISOString();
    await saveProject(projectFile, project);
    review = project.review;
  } finally { await lock.close(); await fs.unlink(`${projectFile}.upload.lock`); }
  return approve ? publishApproved(projectFile) : review;
}
export async function promptReview(projectFile: string) {
  const settings = await setup(false);
  const project = await loadProject(projectFile);
  console.log(`Review video: ${project.review?.video_path}\nApproval uploads to ${settings.accountId} with ${settings.visibility} visibility.`);
  const answer = (await ask('Is this video good enough to upload to YouTube? [yes/no]: ')).toLowerCase();
  if (!['yes', 'y', 'no', 'n'].includes(answer)) throw new Error('No decision recorded. Answer yes or no.');
  console.log(JSON.stringify(await decide(projectFile, ['yes', 'y'].includes(answer)), null, 2));
}
