import { spawn } from 'node:child_process';
/** Working R2 transport. URLs go through stdin, never process arguments or logs. */
export async function uploadWithCurl(file: string, url: string, contentType: string, signal?: AbortSignal): Promise<void> {
  if (new URL(url).protocol !== 'https:' || /[\r\n]/.test(contentType)) throw Error('Invalid media upload target/type');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--config', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal });
    let status = ''; child.stdout.on('data', b => status += b); child.stderr.on('data', () => {});
    child.once('error', () => reject(Error('Media transport failed or cancelled; completed upload receipts retained')));
    child.once('close', code => code === 0 && /^2\d\d$/.test(status.trim()) ? resolve() : reject(Error(`Media upload failed (transport ${code}, HTTP ${status.trim().slice(-3)})`)));
    // The local network advertises IPv6 but R2 uploads stalled/fail with send
    // error 55 on that route. Keep TLS verification and use its working IPv4 route.
    child.stdin.end(`url = ${JSON.stringify(url)}\nipv4\nupload-file = ${JSON.stringify(file.replaceAll('\\', '/'))}\nrequest = "PUT"\nheader = ${JSON.stringify('Content-Type: ' + contentType)}\nheader = "Expect:"\nsilent\nshow-error\nconnect-timeout = 20\nmax-time = 2400\nspeed-limit = 1024\nspeed-time = 60\nwrite-out = "%{http_code}"\n`);
  });
}
