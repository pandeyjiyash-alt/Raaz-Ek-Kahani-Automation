/** Download one CC0 horror music bed from Freesound using a local OAuth refresh token. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const dotenvFile = path.resolve(moduleDirectory, '../../scripting/.env');

const arg = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};

async function loadLocalEnvironment(): Promise<void> {
  try {
    const contents = await fs.readFile(dotenvFile, 'utf8');
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (name && value && !process.env[name]) process.env[name] = value;
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

await loadLocalEnvironment();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} locally before downloading music. Never commit credentials.`);
  return value;
}

async function saveRefreshToken(token: string): Promise<void> {
  if (!/^[A-Za-z0-9._~-]+$/.test(token)) throw new Error('Unexpected refresh token format.');
  let contents = await fs.readFile(dotenvFile, 'utf8');
  contents = contents.replace(/^FREESOUND_AUTHORIZATION_CODE=.*(?:\r?\n|$)/gm, '');
  const replacement = `FREESOUND_REFRESH_TOKEN=${token}`;
  contents = /^FREESOUND_REFRESH_TOKEN=.*$/m.test(contents)
    ? contents.replace(/^FREESOUND_REFRESH_TOKEN=.*$/gm, () => replacement)
    : `${contents.trimEnd()}\n${replacement}\n`;
  await fs.writeFile(dotenvFile, contents, 'utf8');
  process.env.FREESOUND_REFRESH_TOKEN = token;
}

async function accessToken(): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: required('FREESOUND_CLIENT_ID'),
    client_secret: required('FREESOUND_CLIENT_SECRET'),
    refresh_token: required('FREESOUND_REFRESH_TOKEN'),
  });
  const response = await fetch('https://freesound.org/apiv2/oauth2/access_token/', { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Freesound token refresh failed (${response.status}).`);
  const data = await response.json() as { access_token?: string; refresh_token?: string };
  if (!data.access_token) throw new Error('Freesound did not return an access token.');
  if (data.refresh_token) await saveRefreshToken(data.refresh_token);
  return data.access_token;
}

async function exchangeAuthorizationCode(code: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: required('FREESOUND_CLIENT_ID'),
    client_secret: required('FREESOUND_CLIENT_SECRET'),
    code,
  });
  const response = await fetch('https://freesound.org/apiv2/oauth2/access_token/', { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Freesound authorization-code exchange failed (${response.status}).`);
  const data = await response.json() as { access_token?: string; refresh_token?: string };
  if (!data.access_token || !data.refresh_token) throw new Error('Freesound did not return an access and refresh token pair.');
  await saveRefreshToken(data.refresh_token);
  return data.access_token;
}

const query = arg('--query', 'dark Indian folk horror supernatural suspense ambient, no vocals')!;
const output = path.resolve(arg('--output') ?? 'outputs/background-music.mp3');
const authorizationCode = process.env.FREESOUND_AUTHORIZATION_CODE || arg('--authorization-code');
const token = authorizationCode ? await exchangeAuthorizationCode(authorizationCode) : await accessToken();
if (process.argv.includes('--auth-only')) {
  console.log('Freesound credentials validated and refresh token saved locally.');
} else {
const batchFile = arg('--batch');
if (batchFile) {
  const batch = JSON.parse(await fs.readFile(path.resolve(batchFile), 'utf8'));
  const excluded = new Set<number>(batch.exclude_ids ?? []);
  const selected = [];
  for (const item of batch.items) {
    const endpoint = new URL(item.id ? `https://freesound.org/apiv2/sounds/${item.id}/` : 'https://freesound.org/apiv2/search/text/');
    endpoint.searchParams.set('fields', 'id,name,license,username,previews,duration,url,description');
    if (!item.id) { endpoint.searchParams.set('query', item.query); endpoint.searchParams.set('filter', 'license:"Creative Commons 0" duration:[0.2 TO 120]'); endpoint.searchParams.set('sort', 'rating_desc'); endpoint.searchParams.set('page_size', '10'); }
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw Error(`Freesound batch ${item.cue}: HTTP ${response.status}`);
    const data = await response.json() as any;
    if (batch.mode === 'search') { selected.push({ cue: item.cue, query: item.query, candidates: (data.results ?? []).filter((s: any) => !excluded.has(s.id)).slice(0, 4) }); continue; }
    if (excluded.has(data.id) || !/creativecommons\.org\/publicdomain\/zero\/1\.0/.test(data.license)) throw Error(`Reused/non-CC0 sound blocked: ${item.cue}`);
    const file = path.resolve(item.file); await fs.mkdir(path.dirname(file), { recursive: true });
    let cached = false; try { const existing = JSON.parse(await fs.readFile(`${file}.license.json`, 'utf8')); cached = existing.id === data.id && (await fs.stat(file)).size > 0; } catch {}
    if (!cached) {
      const audio = await fetch(data.previews['preview-hq-mp3'], { signal: AbortSignal.timeout(30_000) }); if (!audio.ok) throw Error(`Sound download failed ${audio.status}`);
      await fs.writeFile(file, Buffer.from(await audio.arrayBuffer()));
      await fs.writeFile(`${file}.license.json`, JSON.stringify({ provider: 'Freesound', id: data.id, name: data.name, creator: data.username, license: data.license, source: data.url }, null, 2));
    }
    selected.push({ ...item, id: data.id, name: data.name, creator: data.username, license: data.license, source: data.url, duration: data.duration, file });
  }
  await fs.writeFile(path.resolve(batch.output), JSON.stringify(selected, null, 2)); console.log(JSON.stringify({ mode: batch.mode, count: selected.length, output: batch.output }));
} else {
const soundId = arg('--sound-id');
if (soundId && !/^\d+$/.test(soundId)) throw new Error('--sound-id must be numeric.');
const search = new URL(soundId ? `https://freesound.org/apiv2/sounds/${soundId}/` : 'https://freesound.org/apiv2/search/text/');
search.searchParams.set('query', query);
search.searchParams.set('filter', 'license:"Creative Commons 0" duration:[30 TO 600]');
search.searchParams.set('sort', 'rating_desc');
search.searchParams.set('page_size', '10');
search.searchParams.set('fields', 'id,name,license,username,previews,duration,url');
const searchResponse = await fetch(search, { headers: { Authorization: `Bearer ${token}` } });
if (!searchResponse.ok) throw new Error(`Freesound search failed (${searchResponse.status}).`);
const searchData = await searchResponse.json() as { results?: Array<{ id: number; name: string; license: string; username: string; duration: number; url: string; previews?: Record<string, string> }> };
const sound = soundId ? searchData as unknown as NonNullable<typeof searchData.results>[number] : searchData.results?.find((candidate) => candidate.previews?.['preview-hq-mp3']);
if (sound && !/creativecommons\.org\/publicdomain\/zero\/1\.0/.test(sound.license)) throw new Error('Selected sound is not CC0; refusing automatic download.');
if (!sound?.previews?.['preview-hq-mp3']) throw new Error('No suitable CC0 Freesound music result was found. Try a different --query.');
const audioResponse = await fetch(sound.previews['preview-hq-mp3']);
if (!audioResponse.ok || !audioResponse.body) throw new Error(`Freesound preview download failed (${audioResponse.status}).`);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, Buffer.from(await audioResponse.arrayBuffer()));
await fs.writeFile(`${output}.license.json`, `${JSON.stringify({ provider: 'Freesound', id: sound.id, name: sound.name, creator: sound.username, license: sound.license, source: sound.url, query, downloaded_at: new Date().toISOString() }, null, 2)}\n`);
console.log(JSON.stringify({ output, refreshed_authorization: Boolean(authorizationCode), sound: { id: sound.id, name: sound.name, license: sound.license, durationSeconds: sound.duration }, query }, null, 2));

}
}
