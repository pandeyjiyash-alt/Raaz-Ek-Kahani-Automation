import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { markReviewPending, loadProject, saveProject } from './reviewState.js';
import { publishApproved, decide, nextPublishingSlot } from './upload.js';
const passGate = async () => {};
const config = { apiKey: 'fake', accountId: 'account', visibility: 'private' };
async function fixture(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'pipeline.json'), video = path.join(dir, 'video.mp4');
  await fs.writeFile(project, '{}'); await fs.writeFile(video, 'test video');
  await markReviewPending(project, video, 'Test');
  return { project, video };
}
async function approve(file: string) { const p = await loadProject(file); p.review!.status = 'approved'; await saveProject(file, p); }
function mock(failPost = false, expectedTime = '08:00:00.000Z') {
  const calls: string[] = [];
  const http = (async (url: any, init: any) => {
    calls.push(String(url));
    if (String(url).endsWith('/accounts')) return Response.json({ accounts: [{ _id: 'account', platform: 'youtube' }] });
    if (String(url).endsWith('/presign')) return Response.json({ uploadUrl: 'https://storage.test/file', publicUrl: 'https://media.test/video.mp4' });
    if (String(url).includes('storage.test')) { assert.equal(init.headers.Authorization, undefined); for await (const chunk of init.body) {} return new Response(''); }
    if (failPost) throw new Error('Lost response');
    const body = JSON.parse(init.body); assert.equal(body.platforms[0].accountId, 'account'); assert.equal(body.publishNow, false);
    assert.equal(body.timezone, 'Asia/Kolkata');
    assert.ok(new Date(body.scheduledFor).getTime() > Date.now());
    assert.equal(body.scheduledFor.slice(11), expectedTime);
    return Response.json({ post: { _id: 'post', status: 'scheduled', platforms: [{ platform: 'youtube', status: 'pending' }] } });
  }) as typeof fetch;
  return { calls, http };
}
test('unapproved and rejected videos cannot upload', async t => {
  const f = await fixture(t); const m = mock();
  await assert.rejects(publishApproved(f.project, config, m.http, passGate), /approved/);
  await decide(f.project, false);
  await assert.rejects(publishApproved(f.project, config, m.http, passGate), /approved/);
  assert.equal(m.calls.length, 0);
});
test('changed file cannot upload', async t => {
  const f = await fixture(t); await approve(f.project); await fs.writeFile(f.video, 'changed'); const m = mock();
  await assert.rejects(publishApproved(f.project, config, m.http, passGate), /changed/); assert.equal(m.calls.length, 0);
});
test('local media uploads and pending post is not marked posted; duplicate blocked', async t => {
  const f = await fixture(t); await approve(f.project); const m = mock();
  const result = await publishApproved(f.project, config, m.http, passGate);
  assert.equal(result.status, 'scheduled'); assert.equal(result.zernio_post_id, 'post');
  await assert.rejects(publishApproved(f.project, config, m.http, passGate)); assert.equal(m.calls.length, 4);
});
test('publishing uses next 1:30 PM India slot, including date rollover', () => {
  assert.equal(nextPublishingSlot(new Date('2026-10-12T07:59:59Z')), '2026-10-12T08:00:00.000Z');
  assert.equal(nextPublishingSlot(new Date('2026-10-12T08:00:00Z')), '2026-10-13T08:00:00.000Z');
  assert.equal(nextPublishingSlot(new Date('2026-12-31T18:00:00Z')), '2027-01-01T08:00:00.000Z');
});

test('an explicitly selected future publishing time overrides the daily slot', async t => {
  const f = await fixture(t); await approve(f.project);
  const selected = new Date(Date.now() + 86400000); selected.setUTCHours(8, 15, 0, 0);
  const project = await loadProject(f.project); project.review!.scheduled_for = selected.toISOString(); await saveProject(f.project, project);
  const m = mock(false, '08:15:00.000Z');
  const result = await publishApproved(f.project, config, m.http, passGate);
  assert.equal(result.scheduled_for, selected.toISOString());
  assert.equal(result.status, 'scheduled');
});
test('lost post response blocks resubmission', async t => {
  const f = await fixture(t); await approve(f.project); const m = mock(true);
  await assert.rejects(publishApproved(f.project, config, m.http, passGate), /Lost response/);
  assert.equal((await loadProject(f.project)).review!.status, 'submitting');
  await assert.rejects(publishApproved(f.project, config, m.http, passGate)); assert.equal(m.calls.length, 4);
});
test('custom description and tags reach the scheduled YouTube request', async t => {
  const f = await fixture(t); await approve(f.project);
  const project = await loadProject(f.project);
  project.youtube_metadata = { title: 'Hindi story title', description: 'Spoiler-free description\n#HindiHorrorStory', tags: ['Hindi horror story', 'Test'] };
  await saveProject(f.project, project);
  const m = mock();
  const http = (async (url: any, init: any) => {
    if (String(url).endsWith('/posts')) {
      const body = JSON.parse(init.body);
      assert.equal(body.content, 'Spoiler-free description\n#HindiHorrorStory');
      assert.deepEqual(body.tags, ['Hindi horror story', 'Test']);
      assert.equal(body.platforms[0].platformSpecificData.title, 'Hindi story title');
    }
    return m.http(url, init);
  }) as typeof fetch;
  await publishApproved(f.project, config, http, passGate);
});

test('refuses upload when the QC gate fails', async t => {
  const f = await fixture(t); await approve(f.project); const m = mock();
  await assert.rejects(publishApproved(f.project, config, m.http, async () => { throw new Error('QC gate failed'); }), /QC gate failed/);
  assert.equal(m.calls.length, 0);
});
