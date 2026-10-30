// YouTube Automation agent: runs ONLY allow-listed pipeline jobs that the producer
// (Claude) drops into production/agent/jobs/*.json, one at a time, and writes logs and
// status back into the project folder. No arbitrary commands. Started by START-AUTOMATION.cmd
// (and automatically at Windows sign-in). Stop it: create production/agent/STOP or close its window.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(root, 'production', 'agent');
const jobs = path.join(dir, 'jobs'), status = path.join(dir, 'status'), logs = path.join(dir, 'logs'), done = path.join(dir, 'done');
for (const d of [jobs, status, logs, done]) fs.mkdirSync(d, { recursive: true });
const lock = path.join(dir, 'agent.lock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
try { const old = JSON.parse(fs.readFileSync(lock, 'utf8')); if (old.pid !== process.pid && alive(old.pid)) { console.log(`Agent already running (pid ${old.pid}).`); process.exit(0); } } catch {}
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));

const venvPy = path.join(root, 'scripting', '.venv', 'Scripts', 'python.exe');
const mediaPy = process.env.PYTHON || path.join(process.env.USERPROFILE ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const storyDir = slug => { if (!/^[a-z0-9-]{3,80}$/.test(slug ?? '')) throw Error('invalid story slug'); return path.join(root, 'production', 'outputs', slug); };

// Allow-list: job type -> [binary, args, cwd, env]
// Optional ASR settings documented in AGENTS.md: one local model at a time, and a short
// vocabulary hint of names/terms only (recorded with its hash by voice_qc.py).
function asrEnv(job) {
  const env = {};
  if (job.asrModel) {
    if (!['small', 'medium'].includes(job.asrModel)) throw Error('asrModel must be small or medium');
    env.LOCAL_ASR_MODEL_PATH = path.join(root, 'production', 'outputs', 'local-tools', `whisper-${job.asrModel}-offline`, 'model.bin');
  }
  if (job.asrVocabulary) {
    if (typeof job.asrVocabulary !== 'string' || job.asrVocabulary.length > 120 || /[\r\n]/.test(job.asrVocabulary)) throw Error('asrVocabulary must be a short single line of names/terms');
    env.LOCAL_ASR_VOCABULARY = job.asrVocabulary;
  }
  return env;
}

function command(job) {
  const budget = String(num(job.budgetMinutes, 90, 10, 480));
  // Optional explicit ledger story number (weekly long format runs a chosen story, not the queue).
  if (job.story !== undefined && typeof job.story === 'number' && !Number.isInteger(job.story)) throw Error('story must be an integer');
  const pick = typeof job.story === 'number' ? ['--story', String(job.story)] : [];
  switch (job.type) {
    case 'produce': return [process.execPath, ['start-video.mjs', '--today', ...pick, '--stop-before-schedule', '--budget-minutes', budget], root];
    case 'produce-and-schedule': return [process.execPath, ['start-video.mjs', '--today', ...pick, '--budget-minutes', budget], root];
    case 'release-only': return [process.execPath, ['start-video.mjs', '--today', ...pick, '--release-only', ...(job.publishNow === true ? ['--publish-now'] : []), ...(job.youtubeOnly === true ? ['--youtube-only'] : [])], root];
    case 'plan': return [process.execPath, ['start-video.mjs', '--today', '--plan'], root];
    case 'typecheck': return ['npm.cmd', ['--prefix', 'production', 'run', 'typecheck'], root];
    case 'build-story': {
      if (!/^build_story_\d{3}$/.test(job.module ?? '')) throw Error('invalid builder module');
      return [venvPy, ['-m', `story_builds.${job.module}`, ...(job.force ? ['--force'] : [])], path.join(root, 'scripting')];
    }
    case 'repair-pauses': {
      const scenes = (job.scenes ?? []).map(s => String(num(s, 0, 1, 999)));
      if (!scenes.length) throw Error('no scenes');
      return [mediaPy, [path.join(root, 'production', 'media', 'repair_measured_pauses.py'), '--dir', storyDir(job.story), '--scenes', ...scenes], path.join(root, 'production', 'media')];
    }
    case 'reschedule': {
      // Moves this story's scheduled posts (no upload, never publishNow). Default: next 12:00 AM IST.
      if (job.at !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(job.at)) throw Error('at must be an ISO time');
      return [process.execPath, ['--use-system-ca', '--import', 'tsx', path.join('src', 'pipeline', 'rescheduleCli.ts'), '--dir', storyDir(job.story), ...(job.at ? ['--at', job.at] : [])], path.join(root, 'production')];
    }
    case 'test': return [process.execPath, ['--import', 'tsx', '--test', path.join('src', 'pipeline', 'release.test.ts')], path.join(root, 'production')];
    case 'media': {
      // Read-only review / packaging helpers that the runner itself does not schedule.
      const allowed = ['visual_review.py', 'package_release.py', 'source_review.py', 'preflight.py', 'asr_probe.py'];
      if (!allowed.includes(job.script)) throw Error('media script not allowed');
      const extra = [];
      if (job.script === 'package_release.py') extra.push('--editorial', path.join(storyDir(job.story), 'release-editorial.json'));
      return [mediaPy, [path.join(root, 'production', 'media', job.script), '--dir', storyDir(job.story), ...extra], path.join(root, 'production', 'media')];
    }
    default: throw Error(`job type not allowed: ${job.type}`);
  }
}

const write = (file, data) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file); };
const heartbeat = state => write(path.join(dir, 'heartbeat.json'), { pid: process.pid, at: new Date().toISOString(), ...state });
console.log('YouTube Automation agent running. Leave this window open (minimised is fine).');

let current = null;
setInterval(() => heartbeat({ busy: current }), 10_000).unref?.();
heartbeat({ busy: null });

// Self-update: when this file changes on disk, relaunch the new version between jobs.
const self = fileURLToPath(import.meta.url), selfMtime = fs.statSync(self).mtimeMs;
function restartIfUpdated() {
  if (fs.statSync(self).mtimeMs === selfMtime) return;
  fs.rmSync(lock, { force: true });
  spawn(process.execPath, [self], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  heartbeat({ restarting: true }); process.exit(0);
}

while (true) {
  restartIfUpdated();
  if (fs.existsSync(path.join(dir, 'STOP'))) { heartbeat({ stopped: true }); fs.rmSync(lock, { force: true }); process.exit(0); }
  const next = fs.readdirSync(jobs).filter(f => f.endsWith('.json')).sort()[0];
  if (!next) { await new Promise(r => setTimeout(r, 5000)); continue; }
  const jobFile = path.join(jobs, next), id = path.basename(next, '.json');
  let job; try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch (e) { fs.renameSync(jobFile, path.join(done, next)); write(path.join(status, id + '.json'), { id, state: 'rejected', error: 'unreadable job' }); continue; }
  const st = { id, type: job.type, state: 'running', startedAt: new Date().toISOString() };
  try {
    const [bin, args, cwd] = command(job); const extraEnv = asrEnv(job);
    current = id; write(path.join(status, id + '.json'), st); heartbeat({ busy: id });
    const logFile = path.join(logs, id + '.log'), out = fs.openSync(logFile, 'a');
    const code = await new Promise(resolve => {
      const child = spawn(bin, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', out, out], windowsHide: true, shell: bin.endsWith('.cmd') });
      child.on('exit', c => resolve(c ?? 1)); child.on('error', e => { fs.appendFileSync(logFile, String(e) + '\n'); resolve(1); });
    });
    fs.closeSync(out);
    Object.assign(st, { state: code === 0 ? 'done' : 'failed', exitCode: code, endedAt: new Date().toISOString(), log: logFile });
  } catch (e) { Object.assign(st, { state: 'rejected', error: String(e.message ?? e), endedAt: new Date().toISOString() }); }
  current = null; write(path.join(status, id + '.json'), st); fs.renameSync(jobFile, path.join(done, next)); heartbeat({ busy: null, last: st });
}
