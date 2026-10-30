import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
/** Child owns a log and AbortSignal. No shell interpolation, unlimited waits, or stdout floods. */
export async function runCommand(binary: string, args: string[], options: { cwd: string; logFile: string; signal: AbortSignal; env?: NodeJS.ProcessEnv }) {
  await fs.mkdir(path.dirname(options.logFile), { recursive: true }); const log = await fs.open(options.logFile, 'a');
  try {
    await new Promise<void>((resolve, reject) => {
      options.signal.throwIfAborted();
      const child = spawn(binary, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', log.fd, log.fd], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
      const cancel = () => {
        if (!child.pid) return;
        // Kill only this owned process tree, including its FFmpeg descendants.
        if (process.platform === 'win32') { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
        else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
      };
      options.signal.addEventListener('abort', cancel, { once: true });
      const cleanup = () => options.signal.removeEventListener('abort', cancel);
      child.once('error', error => { cleanup(); reject(error); }); child.once('exit', (code, signal) => { cleanup(); code === 0 && !options.signal.aborted ? resolve() : reject(Error(`${path.basename(binary)} failed (${code ?? signal}); details: ${options.logFile}`)); });
      if (options.signal.aborted) cancel();
    });
  } finally { await log.close(); }
}
