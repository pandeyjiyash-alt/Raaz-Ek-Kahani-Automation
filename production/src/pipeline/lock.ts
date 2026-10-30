import fs from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Reclaim only a positively identified dead local owner. Unknown legacy locks stay protected. */
export async function acquireLock(file: string): Promise<() => Promise<void>> {
  const token = randomUUID(), owner = { pid: process.pid, host: hostname(), token, createdAt: new Date().toISOString() };
  async function create() {
    const handle = await fs.open(file, 'wx');
    try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
  }
  try { await create(); }
  catch (e: any) {
    if (e.code !== 'EEXIST') throw e;
    const recovery = file + '.recovery', guard = await fs.open(recovery, 'wx');
    try {
      let old;
      try { old = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch { throw Error(`Unknown lock owner; preserve progress and inspect ${file}`); }
      if (old.host !== hostname() || !Number.isSafeInteger(old.pid) || old.pid <= 0 || !/^[a-f0-9-]{36}$/i.test(old.token ?? ''))
        throw Error(`Unknown lock owner: ${file}`);
      let dead = false;
      try { process.kill(old.pid, 0); } catch (error: any) { dead = error.code === 'ESRCH'; }
      if (!dead) throw Error(`Production is already running (PID ${old.pid}): ${file}`);
      await fs.rename(file, `${file}.stale-${old.token}`);
      await create();
    } finally { await guard.close(); await fs.unlink(recovery); }
  }
  return async () => {
    const current = JSON.parse(await fs.readFile(file, 'utf8'));
    if (current.token !== token) throw Error(`Lock ownership changed: ${file}`);
    await fs.unlink(file);
  };
}
