// Start once and walk away: keeps re-running the production runner until the
// package is ready (stops BEFORE any upload/publish), with bounded retries.
// Every quality gate is unchanged; a failed check simply waits for repairs and retries.
//   node auto-produce.mjs            (defaults: 20 attempts, 2 min between attempts)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const attempts = arg('--attempts', 20), waitSec = arg('--wait', 120);
const log = path.join(root, 'production', 'outputs', 'auto-runner.log');
const write = s => { const line = `[${new Date().toISOString()}] ${s}\n`; process.stdout.write(line); fs.appendFileSync(log, line); };
for (let n = 1; n <= attempts; n++) {
  write(`attempt ${n}/${attempts} starting`);
  let ready = false;
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, ['start-video.mjs', '--today', '--stop-before-schedule', '--budget-minutes', '90'], { cwd: root, windowsHide: true });
    const onData = d => { const t = d.toString(); process.stdout.write(t); fs.appendFileSync(log, t); if (t.includes('package_ready_for_release')) ready = true; };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1));
  });
  if (ready && code === 0) { write('PACKAGE READY - stopped before scheduling; nothing uploaded or posted'); process.exit(0); }
  write(`attempt ${n} ended (exit ${code}); waiting ${waitSec}s for repairs before retrying`);
  await new Promise(r => setTimeout(r, waitSec * 1000));
}
write('Stopped after the maximum number of attempts; see the story folder logs for the exact blocker');
process.exit(1);
