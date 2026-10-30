import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { root, setup, loadEnvironment } from '../setupConfig.js';
import { selectToday } from './storySelection.js';
import { preparePlan } from './preparePlan.js';
import { runStages, atomicJson } from './runtime.js';
import { runCommand } from './process.js';
import { productionGraph } from './productionGraph.js';
import { scheduleRelease } from './release.js';

await loadEnvironment();
// --budget-minutes N: overall wall-clock bound (default 30, the target). Agent-serviced browser work
// can exceed the target; a larger bound avoids aborting healthy concurrent stages. Gates are unchanged.
const budgetArg = process.argv.indexOf('--budget-minutes'), budgetMinutes = budgetArg > 0 ? Math.max(5, Number(process.argv[budgetArg + 1]) || 30) : 30, BUDGET_MS = budgetMinutes * 60_000;
const began = performance.now(), controller = new AbortController(), deadline = setTimeout(() => controller.abort(Error(`${budgetMinutes}-minute budget reached; preserve progress and report the exact blocker`)), BUDGET_MS);
process.once('SIGINT', () => controller.abort(Error('Stopped by user')));
const storyArg = process.argv.indexOf('--story'), storyNumber = storyArg > 0 ? Number(process.argv[storyArg + 1]) : undefined;
if (storyNumber !== undefined && !Number.isInteger(storyNumber)) throw Error('--story needs a ledger story number');
const selected = await selectToday(root, storyNumber), out = selected.output, story = selected.story;
const id = `story-${String(story.number).padStart(3, '0')}-${story.normalized_title}`;
const projectFile = story.project_file ?? path.join(root, 'scripting/projects', id, 'pipeline.json');
const python = process.env.PYTHON || (process.platform === 'win32' ? path.join(process.env.USERPROFILE ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe') : 'python3');
const production = path.join(root, 'production'), planOnly = process.argv.includes('--plan');
const run = (binary: string, args: string[], label: string, signal = controller.signal, cwd = root, env?: NodeJS.ProcessEnv) => runCommand(binary, args, { cwd, logFile: path.join(out, 'logs', label + '.log'), signal, env });
// Scripting packages live in scripting/.venv; expose them explicitly so the step works
// even when the venv launcher is bypassed (e.g. an inherited PYTHONHOME).
const scriptEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: [path.join(root, 'scripting', '.venv', 'Lib', 'site-packages'), path.join(root, 'scripting'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
delete scriptEnv.PYTHONHOME;
try {
  if (planOnly) { console.log(JSON.stringify({ event: 'production_plan', story: story.number, title: story.title, output: out, projectFile, targetMinutes: 30, flowCreditsTarget: null, qualityPriority: true, stages: ['story/continuity/cast audit', 'parallel current-Chrome Flow + individual TTS + fresh Freesound selection + cached local voice QC', 'cached master/Short/full-Reel render', 'final transcription + producer visual QC', 'unchanged release gate', 'three verified Zernio schedules'], caveat: 'External queue/authentication and genuine quality failures can exceed the target; quality gates remain mandatory' }, null, 2)); }
  else {
    await fs.mkdir(out, { recursive: true });
    const cfg = await setup();
    await run(python, [path.join(production,'media/preflight.py')], 'preflight');
    // A failed scripting run can leave an unvalidated draft; only a project whose scenes carry Flow prompts counts as scripted.
    const scripted = await fs.readFile(projectFile, 'utf8').then(t => { const p = JSON.parse(t); return p.scenes?.length > 0 && p.scenes.every((s: any) => s.animation_prompt_NARRATOR_ONLY); }, () => false);
    if (!scripted) { await run(python, ['-m', 'pipeline.one_minute', '--project-id', id, '--title', story.title, '--script-file', story.script_file], 'script', controller.signal, path.join(root, 'scripting'), scriptEnv); }
    let project = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    if (process.argv.includes('--publish-now')) project.publish_immediately = true;
    if (project.story_source_sha256 && project.story_source_sha256 !== selected.scriptHash) throw Error('Source story changed; inspect the existing project before replacing it');
    project.story_source_sha256 = selected.scriptHash; project.story_slug = story.normalized_title; await atomicJson(projectFile, project);
    if (!project.production_plan || !project.story_quality_check?.pass) await run(python, ['-m', 'pipeline.production_plan', '--project', projectFile], 'story-audit', controller.signal, path.join(root, 'scripting'), scriptEnv);
    const prepared = await preparePlan(projectFile, out), prompt = await fs.readFile(path.join(production, 'prompts/production-contract.md'), 'utf8');
    const local = (file: string, label: string, signal: AbortSignal, extra: string[] = []) => run(python, [path.join(production, 'media', file), '--dir', out, ...extra], label, signal);
    const stages = productionGraph({ out, production, projectFile, prepared, prompt, local, schedule: async signal => {
      await scheduleRelease(out, { apiKey: cfg.apiKey, youtubeAccountId: cfg.accountId, instagramAccountId: process.env.ZERNIO_INSTAGRAM_ACCOUNT_ID ?? '6acf14014fd2186704d21b0c', scheduledFor: prepared.project.requested_schedule, publishNow: prepared.project.publish_immediately === true, youtubeOnly: process.argv.includes('--youtube-only') }, projectFile, signal);
      const delivery = JSON.parse(await fs.readFile(path.join(out, 'delivery.json'), 'utf8')), ledger = JSON.parse(await fs.readFile(selected.ledgerFile, 'utf8')), row = ledger.stories.find((s: any) => s.number === story.number);
      row.status = delivery.status; row.project_file = projectFile; row.output_dir = out; row.platform_posts = Object.fromEntries(delivery.posts.map((p: any) => [p.kind, p])); if (['published','scheduled'].includes(delivery.status) && story.number === ledger.next_story_number) ledger.next_story_number = story.number + 1; await atomicJson(selected.ledgerFile, ledger);
    } });
    // Recovery may arrive with a fully rendered, independently verified package.
    // The same mandatory gate still executes before the common three-post release.
    // --stop-before-schedule: production handoff boundary. Every stage up to and
    // including the unchanged mandatory gate runs; scheduleRelease (uploads/POSTs)
    // is removed from the graph so nothing can be uploaded or submitted.
    const stopBeforeSchedule = process.argv.includes('--stop-before-schedule');
    if (stopBeforeSchedule && process.argv.includes('--release-only')) throw Error('--stop-before-schedule cannot be combined with --release-only');
    const resumeStages = (process.argv.includes('--release-only')
      ? stages.filter(s => ['gate','schedule'].includes(s.id)).map(s => s.id === 'gate' ? {...s,dependencies:[]} : s)
      : stages).filter(s => !(stopBeforeSchedule && s.id === 'schedule'));
    await runStages({ stateFile: path.join(out, 'run-state.json'), stages: resumeStages, concurrency: 4, budgetMs: Math.max(1, BUDGET_MS - (performance.now() - began)), signal: controller.signal });
    if (stopBeforeSchedule) console.log(JSON.stringify({ event: 'package_ready_for_release', story: story.number, output: out, qcReport: path.join(out, 'qc-report.json'), qcReceipt: path.join(out, 'qc-receipt.json'), uploaded: false, posted: false, resume: 'node start-video.mjs --today --release-only', elapsedSeconds: Math.round((performance.now() - began) / 1000) }));
    else console.log(JSON.stringify({ event: 'delivery_ready', ...JSON.parse(await fs.readFile(path.join(out, 'delivery.json'), 'utf8')), elapsedSeconds: Math.round((performance.now() - began) / 1000) }));
  }
} finally { clearTimeout(deadline); controller.abort(); }
