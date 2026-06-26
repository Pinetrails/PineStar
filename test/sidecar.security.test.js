/* node test/sidecar.security.test.js -- boot-level security composition tests.
   Boots the real sidecar and proves the API-token layer is visible to tests:
   sensitive GETs need authority, /api/session is not a loopback freebie, active
   deliverables are sandboxed, and both browser and Tauri trusted-origin flows work. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function boot(port, workspaces, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, { STARNET_PORT: String(port), STARNET_WORKSPACES: workspaces }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, workspaces, attemptsLeft - 1));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 9000);
  });
}

async function tokenFromIndex(base) {
  const html = await (await fetch(base + '/')).text();
  const m = html.match(/window\.__STARNET_API_TOKEN__=("[^"]+")/);
  return m ? JSON.parse(m[1]) : '';
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sec-'));
  const { child, port } = await boot(8910 + (process.pid % 50), ws, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const browserToken = await tokenFromIndex(B);
    A.ok(browserToken.length >= 32, 'browser-served index carries the boot API token');

    const getNoToken = await fetch(B + '/api/budget/status', { headers: { Origin: B } });
    A.eq(getNoToken.status, 403, 'sensitive GET without token -> 403');
    const getWithToken = await fetch(B + '/api/budget/status', { headers: { Origin: B, 'X-StarNet-Token': browserToken } });
    A.eq(getWithToken.status, 200, 'browser token authorizes sensitive GET');
    A.eq(getWithToken.headers.get('access-control-allow-origin'), B, 'browser CORS still mirrors the trusted loopback origin');

    const sessionGet = await fetch(B + '/api/session', { headers: { Origin: B } });
    A.eq(sessionGet.status, 403, 'GET /api/session is not freely retrievable');
    const sessionPostBrowser = await fetch(B + '/api/session', { method: 'POST', headers: { Origin: B } });
    A.eq(sessionPostBrowser.status, 403, 'loopback browser pages cannot mint a fresh session token');
    const tokenedSession = await fetch(B + '/api/session', {
      method: 'POST',
      headers: { Origin: B, 'X-StarNet-Token': browserToken }
    });
    A.eq(tokenedSession.status, 200, 'browser token authorizes session liveness check');
    A.eq((await tokenedSession.json()).token, undefined, 'tokened session never returns the API token');

    const tauriOrigin = 'http://tauri.localhost';
    const tauriSessionNoToken = await fetch(B + '/api/session', { method: 'POST', headers: { Origin: tauriOrigin } });
    A.eq(tauriSessionNoToken.status, 403, 'Tauri app origin still needs the boot token for /api/session');
    const tauriGet = await fetch(B + '/api/budget/status', { headers: { Origin: tauriOrigin, 'X-StarNet-Token': browserToken } });
    A.eq(tauriGet.status, 200, 'Tauri trusted origin with boot token authorizes sensitive GET');
    A.eq(tauriGet.headers.get('access-control-allow-origin'), tauriOrigin, 'Tauri CORS still mirrors the app origin');

    fs.mkdirSync(path.join(ws, 'agent', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent', 'reports', 'active.html'), '<script>fetch("/api/session",{method:"POST"})</script>');
    const filePath = '/api/file?agent=agent&path=' + encodeURIComponent('reports/active.html');
    const fileNoToken = await fetch(B + filePath);
    A.eq(fileNoToken.status, 403, 'workspace deliverable GET without token -> 403');
    const fileWithToken = await fetch(B + filePath, { headers: { Origin: B, 'X-StarNet-Token': browserToken } });
    A.eq(fileWithToken.status, 200, 'header token authorizes media/file deliverable fetches');
    A.ok(/\bsandbox\b/.test(fileWithToken.headers.get('content-security-policy') || ''), 'deliverables are served under a CSP sandbox');
    A.ok(!fileWithToken.headers.get('content-security-policy').includes('allow-scripts'), 'deliverable sandbox does not allow scripts');
    const deliverableSession = await fetch(B + '/api/session', { method: 'POST', headers: { Origin: B, Referer: B + filePath } });
    A.eq(deliverableSession.status, 403, 'same-origin active deliverables cannot obtain API authority');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('sidecar.security.test');
})().catch(e => { console.log('FAIL: sidecar.security.test threw -- ' + (e && e.stack || e)); process.exit(1); });
