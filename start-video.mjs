// Runs unchanged in macOS Terminal and Windows PowerShell. No shell commands.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
const today = args.includes('--today') || args.join(' ').toLowerCase() === 'publish today story';
if (!process.env.YOUTUBE_AUTO_APPROVE) process.env.YOUTUBE_AUTO_APPROVE = 'true';
for(let i=0;i<args.length;i++) if(['--project','--output-dir','--user-data-dir','--script-file'].includes(args[i]) && args[i+1]) { args[i+1]=path.resolve(args[i+1]);i++; }
// Prefer private local media tools when FFmpeg has not been installed globally.
const toolRoot=path.join(root,'production','outputs','local-tools','node_modules');
process.env.PATH=[path.join(toolRoot,'ffmpeg-static'),path.join(toolRoot,'ffprobe-static','bin',process.platform,process.arch),process.env.PATH].join(path.delimiter);
const entry = today ? 'production/src/pipeline/today.ts' : 'production/src/workflow.ts';
const child=spawn(process.execPath,['--use-system-ca','--import','tsx',path.join(root,entry),...(today ? args.filter(a => a !== '--today' && !['publish','today','story'].includes(a)) : args)],{cwd:path.join(root,'production'),stdio:'inherit',shell:false,windowsHide:true});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
