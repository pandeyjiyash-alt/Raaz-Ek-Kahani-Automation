import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
const arg=n=>process.argv[process.argv.indexOf(n)+1];
if(!process.argv.includes('--dir')||!process.argv.includes('--task'))throw Error('--dir and --task are required');
const dir=path.resolve(arg('--dir')),task=arg('--task');
if(!['flow','sound','tts'].includes(task))throw Error('This helper cannot approve package QC or publication');
const digest=async file=>{const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex')};
const requestFile=path.join(dir,'browser-tasks',task+'.request.json'),request=JSON.parse(await fs.readFile(requestFile,'utf8')),files={};
for(const output of request.outputs){const file=path.resolve(output.file);const relative=path.relative(dir,file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Output outside story');if(!(await fs.stat(file)).size)throw Error('Empty output');files[file]=await digest(file)}
const result={request_sha256:await digest(requestFile),status:'done',files};
const target=path.join(dir,'browser-tasks',task+'.result.json');await fs.writeFile(target+'.tmp',JSON.stringify(result,null,2));await fs.rename(target+'.tmp',target);
console.log(JSON.stringify({task,verified_outputs:Object.keys(files).length}));
