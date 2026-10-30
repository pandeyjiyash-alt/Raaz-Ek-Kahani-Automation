import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acquireLock } from './lock.js';

test('live owners and unknown legacy locks are protected; confirmed dead owner is recovered', async t => {
  const dir=await fs.mkdtemp(path.join(tmpdir(),'owned-lock-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'run.lock'), release=await acquireLock(file);
  await assert.rejects(acquireLock(file),/already running/); await release();
  await fs.writeFile(file,''); await assert.rejects(acquireLock(file),/Unknown lock owner/); await fs.unlink(file);
  const child=spawn(process.execPath,['-e',''],{windowsHide:true}); const pid=child.pid;
  await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>resolve());});
  const token=randomUUID(); await fs.writeFile(file,JSON.stringify({pid,host:hostname(),token}));
  const recovered=await acquireLock(file); await fs.access(file+'.stale-'+token); await recovered();
  await assert.rejects(fs.access(file));
});
