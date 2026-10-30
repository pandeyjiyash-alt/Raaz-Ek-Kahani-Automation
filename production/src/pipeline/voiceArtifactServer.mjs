import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const arg=n=>process.argv[process.argv.indexOf(n)+1];
if(!process.argv.includes('--dir'))throw Error('--dir is required');
const dir=path.resolve(arg('--dir'),'voices'),token=randomUUID(),groups=new Map();
await fs.mkdir(dir,{recursive:true});
const form=`<!doctype html><title>Story voice artifacts</title><form><input type="hidden" name="token" value="${token}"><label>Filename<input name="filename" required></label><label>Part<input name="part" required></label><label>Total<input name="total" required></label><label>Audio data<textarea name="audio" required></textarea></label><button>Save</button></form><p role="status">Ready</p><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();let s=document.querySelector('[role=status]');s.textContent='Saving';try{const r=await fetch('/',{method:'POST',body:new URLSearchParams(new FormData(e.target))});s.textContent=await r.text()}catch(e){s.textContent='Error '+e.message}};</script>`;
http.createServer(async(req,res)=>{
 try{
  if(req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(form);return}
  if(req.method!=='POST')throw Error('POST required');
  let body='';for await(const b of req){body+=b;if(body.length>200000)throw Error('Chunk too large')}
  const p=new URLSearchParams(body);if(p.get('token')!==token)throw Error('Invalid token');
  const name=p.get('filename');if(!/^scene-\d{4}\.wav$/.test(name??''))throw Error('Invalid filename');
  const part=Number(p.get('part')),total=Number(p.get('total'));
  if(!Number.isInteger(part)||!Number.isInteger(total)||part<0||part>=total||total>100)throw Error('Invalid chunk');
  if(part===0)groups.set(name,{total,parts:new Map()});
  const group=groups.get(name);if(!group||group.total!==total)throw Error('Restart this transfer at part zero');
  group.parts.set(part,p.get('audio')??'');
  if(group.parts.size!==total){res.end('Chunk '+part+' accepted');return}
  const data=Array.from({length:total},(_,i)=>group.parts.get(i)).join('');
  if(!data.startsWith('data:audio/wav;base64,'))throw Error('WAV required');
  const bytes=Buffer.from(data.slice(data.indexOf(',')+1),'base64');
  if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw Error('Invalid WAV');
  const declared=bytes.readUInt32LE(4)+8;
  if(declared!==bytes.length)throw Error(`Truncated WAV: expected ${declared}, received ${bytes.length}`);
  const file=path.join(dir,name);
  try{const old=await fs.readFile(file);if(!old.equals(bytes))throw Error('Preserve previous take before replacing source')}
  catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(file+'.tmp',bytes);await fs.rename(file+'.tmp',file)}
  groups.delete(name);
  res.end('Saved '+name+' '+bytes.length+' bytes '+createHash('sha256').update(bytes).digest('hex'));
 }catch(e){res.statusCode=400;res.end('Error '+e.message)}
}).listen(38465,'127.0.0.1',()=>console.log('Story voice artifact server ready on localhost:38465'));
