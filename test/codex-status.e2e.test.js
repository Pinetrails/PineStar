/* node test/codex-status.e2e.test.js — the dead-ChatGPT-token honesty seam, over real sockets.

   THE ESCAPE (2026-07-08): Andrew's Codex OAuth refresh token was consumed by another client; the run
   errored correctly, but GET /api/auth/codex/status kept answering connected:true, so Settings→Providers
   kept showing "● SIGNED IN · 1 key" with zero recovery actions.

   This boots the ACTUAL sidecar against an isolated workspace whose codex/tokens.json is pre-seeded with
   the persisted dead marker (exactly what ensureCodexAccessToken writes on a relogin-class refresh failure
   — the write path itself is unit-proven in codex-auth-state.test.js) and proves at the HTTP surface:
     · a booted sidecar reads the marker back → status = { connected:false, expired:true, reason } —
       RESTART STAYS HONEST, and connected NEVER reads true while known-dead.
     · the payload carries no token material.
     · POST /api/auth/codex/logout clears everything → { connected:false, expired:false } and the token
       file is gone (the Settings ✕ DISCONNECT action).
     · a healthy envelope (no marker) still reads connected:true — the fix never breaks the good path.
   Zero network beyond localhost; no model spend. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}
function kill(child) { return new Promise(r => { try { child.on('exit', () => r()); child.kill(); } catch (_) { r(); } setTimeout(r, 3000); }); }

const ACCESS = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE3ODM4NDAwMDB9.ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Q';
const REFRESH = 'rf-e2e-test-refresh-token-abcdefghijklmnopqrstuvwxyz-0123456789';

function seedTokens(ws, envelope) {
  const dir = path.join(ws, 'codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify(envelope));
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-codexstat-ws-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1' };

  // ===== boot 1: a persisted DEAD marker (what a consumed-token refresh failure wrote before the restart) =====
  seedTokens(ws, {
    access_token: ACCESS, refresh_token: REFRESH, last_refresh: '2026-07-08T01:00:00.000Z', auth_mode: 'device',
    authDead: { reason: 'Codex refresh token was already consumed by another client (e.g. the Codex CLI or VS Code extension). Sign in with ChatGPT again.', code: 'refresh_token_reused', at: '2026-07-08T06:00:00.000Z' }
  });
  let { child, port } = await boot(8930 + (process.pid % 25), env, 20);
  let B = 'http://' + HOST + ':' + port;
  try {
    let token = await bootToken(B, B);
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const status = async () => (await fetch(B + '/api/auth/codex/status', { headers })).json();

    let raw = await (await fetch(B + '/api/auth/codex/status', { headers })).text();
    let s = JSON.parse(raw);
    A.eq(s.connected, false, 'a booted sidecar with a persisted dead marker NEVER claims connected (restart honesty)');
    A.eq(s.expired, true, 'status reports expired:true for the dead sign-in');
    A.ok(s.reason && /sign in with chatgpt again/i.test(s.reason), 'status carries the human reason for the death');
    A.eq(s.expiredAt, '2026-07-08T06:00:00.000Z', 'status carries when the token died');
    A.ok(raw.indexOf(ACCESS) === -1 && raw.indexOf(REFRESH) === -1, 'no token material rides the status payload');

    // ===== DISCONNECT (the Settings row action): logout clears tokens AND the dead state =====
    const lo = await (await fetch(B + '/api/auth/codex/logout', { method: 'POST', headers })).json();
    A.eq(lo.connected, false, 'logout answers connected:false');
    s = await status();
    A.eq(s.connected, false, 'after logout: not connected');
    A.eq(s.expired, false, 'after logout: no longer "expired" — the dead state was cleared with the credentials');
    A.eq(fs.existsSync(path.join(ws, 'codex', 'tokens.json')), false, 'logout removed the token file');

    // ===== boot 2: a HEALTHY envelope (no marker) still reads connected — the good path is untouched =====
    await kill(child);
    seedTokens(ws, { access_token: ACCESS, refresh_token: REFRESH, last_refresh: '2026-07-08T01:00:00.000Z', auth_mode: 'device' });
    ({ child, port } = await boot(port, env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    s = await status();
    A.eq(s.connected, true, 'a healthy persisted sign-in still reads connected:true');
    A.eq(s.expired, false, 'a healthy sign-in is not expired');
  } finally {
    await kill(child);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('codex-status.e2e.test');
})().catch(e => { console.error('codex-status.e2e.test FAILED:', e); process.exit(1); });
