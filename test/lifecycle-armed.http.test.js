/* node test/lifecycle-armed.http.test.js — Lane 4D: end-to-end proof of GET /api/lifecycle/armed, the ONE
   aggregate the desktop tray supervisor polls to decide whether closing the window may keep the sidecar alive.
   Spawns the real Node host against an ISOLATED temp workspace on an ephemeral port, NO key (zero model spend):

     - DISABLED STATE IS INERT: a fresh boot with nothing armed reports armed:false and every category
       honestly not-armed — so the tray quits the whole app on window close (no hidden daemon).
     - ARMING A ROUTINE FLIPS IT TRUE: create a routine + POST /api/cron/arm {enabled:true} -> armed:true,
       categories.routines.armed:true with the real count, and a human "N routine(s) armed" reason string.
     - DISARM RETURNS TO INERT: POST /api/cron/arm {enabled:false} -> armed:false again (routines drop out).
     - TOKEN GUARD: GET without the X-StarNet-Token header is rejected 403 (GET data routes are token-gated).

   Short tick (SKYNET_CRON_TICK_MS=300) so any live-timer effect settles fast. NOT in test:fast (child-process
   boot). Run via `npm run test:http`. Mirrors cron.arm.test.js. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function boot(port, workspaces, attemptsLeft, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, { SKYNET_PORT: String(port), SKYNET_WORKSPACES: workspaces }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, out: () => out }); }
      if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, workspaces, attemptsLeft - 1, extraEnv));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 9000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-lifecycle-'));
  const booted = await boot(8990 + (process.pid % 40), ws, 20, { SKYNET_CRON_TICK_MS: '300' });
  const child = booted.child; const port = booted.port;
  const B = () => 'http://' + HOST + ':' + port;
  let apiToken = await bootToken(B(), B());
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json', Origin: B() };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;
    const r = await fetch(B() + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };
  const jNoToken = async (m, p) => {
    const r = await fetch(B() + p, { method: m, headers: { Origin: B() } });
    return { status: r.status };
  };

  try {
    // ---- DISABLED STATE IS INERT ----
    const off = await j('GET', '/api/lifecycle/armed');
    A.eq(off.status, 200, 'GET /api/lifecycle/armed -> 200');
    A.eq(off.body.armed, false, 'fresh boot: armed:false (nothing requires a background process)');
    A.ok(off.body.categories && off.body.categories.routines && off.body.categories.channels && off.body.categories.nightshift, 'all three categories present in the snapshot');
    A.eq(off.body.categories.routines.armed, false, 'routines not armed on a fresh boot');
    A.eq(off.body.categories.channels.armed, false, 'no channel connected on a fresh boot');
    A.eq(off.body.categories.nightshift.armed, false, 'night shift not armed on a fresh boot');
    A.ok(Array.isArray(off.body.reasons) && off.body.reasons.length === 0, 'no reasons when nothing is armed');

    // ---- TOKEN GUARD ----
    const noTok = await jNoToken('GET', '/api/lifecycle/armed');
    A.eq(noTok.status, 403, 'GET /api/lifecycle/armed without X-StarNet-Token -> 403 (token-gated)');

    // ---- ARMING A ROUTINE FLIPS IT TRUE ----
    const create = await j('POST', '/api/cron', { name: 'Nightly digest', prompt: 'summarize', schedule: '2020-01-01T00:00:00Z', agentId: 'lc_test' });
    A.eq(create.status, 200, 'POST /api/cron (valid routine) -> 200');
    const armOn = await j('POST', '/api/cron/arm', { enabled: true });
    A.eq(armOn.status, 200, 'POST /api/cron/arm {enabled:true} -> 200');
    const on = await j('GET', '/api/lifecycle/armed');
    A.eq(on.body.armed, true, 'after arming a routine: armed:true (the process must survive window close)');
    A.eq(on.body.categories.routines.armed, true, 'routines category armed:true');
    A.ok(on.body.categories.routines.count >= 1, 'routines count reflects the real routine (>=1)');
    A.ok(on.body.reasons.some(r => /routine/.test(r)), 'a human "routine(s) armed" reason is surfaced for the tray');

    // ---- DISARM RETURNS TO INERT ----
    const armOff = await j('POST', '/api/cron/arm', { enabled: false });
    A.eq(armOff.status, 200, 'POST /api/cron/arm {enabled:false} -> 200');
    const back = await j('GET', '/api/lifecycle/armed');
    A.eq(back.body.armed, false, 'after disarm: armed:false again (nothing ticks -> tray may fully quit)');
    A.eq(back.body.categories.routines.armed, false, 'routines category back to armed:false');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('lifecycle-armed.http.test');
})().catch(e => { console.log('FAIL: lifecycle-armed.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
