/** Move an already-scheduled release (full video, Short, Reel) to a new time.
 * Usage: tsx src/pipeline/rescheduleCli.ts --dir <story output dir> [--at <ISO time>]
 * Without --at it uses the default daily slot (next 12:00 AM Asia/Kolkata). Only posts still
 * in "scheduled" state are moved; nothing is re-uploaded and publishNow is never used. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup } from '../setupConfig.js';
import { resolveSchedule } from './schedule.js';
const args = process.argv.slice(2), arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dir = path.resolve(arg('--dir') ?? ''); const deliveryFile = path.join(dir, 'delivery.json');
const delivery = JSON.parse(await fs.readFile(deliveryFile, 'utf8'));
const target = resolveSchedule(new Date(), arg('--at'), 10 * 60_000);
const cfg = await setup(false);
async function api(endpoint: string, method = 'GET', body?: unknown) {
  const r = await fetch(`https://zernio.com/api/v1${endpoint}`, { method, headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  const text = await r.text(); if (!r.ok) throw Error(`Zernio ${method} ${endpoint} HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const log: any[] = [];
for (const post of delivery.posts) {
  const before = (await api(`/posts/${post.id}`)).post ?? {};
  if (before.status !== 'scheduled') throw Error(`${post.kind} ${post.id} is ${before.status}; only scheduled posts can be moved`);
  await api(`/posts/${post.id}`, 'PUT', { scheduledFor: target, timezone: 'Asia/Kolkata' });
  const after = (await api(`/posts/${post.id}`)).post ?? {};
  if (after.status !== 'scheduled' || Date.parse(after.scheduledFor) !== Date.parse(target)) throw Error(`${post.kind} ${post.id} did not move: ${after.status} ${after.scheduledFor}`);
  log.push({ kind: post.kind, id: post.id, from: before.scheduledFor, to: after.scheduledFor, status: after.status });
  post.scheduledFor = after.scheduledFor; post.status = after.status;
  const marker = path.join(dir, `${post.kind}-submission-marker.json`);
  try { const m = JSON.parse(await fs.readFile(marker, 'utf8')); m.scheduledFor = after.scheduledFor; if (m.request) m.request.scheduledFor = after.scheduledFor; await fs.writeFile(marker, JSON.stringify(m, null, 2)); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  console.log(JSON.stringify({ event: 'rescheduled', ...log.at(-1) }));
}
delivery.scheduled_for = target; delivery.rescheduled = [...(delivery.rescheduled ?? []), { at: new Date().toISOString(), to: target, posts: log }];
await fs.writeFile(deliveryFile, JSON.stringify(delivery, null, 2));
console.log(JSON.stringify({ event: 'reschedule_done', scheduled_for: target }));
