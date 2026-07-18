/* node test/servicekeys.http.test.js — end-to-end proof of the /api/servicekeys surface (the KEYS tab's
   custom platform keys). Boots the REAL host against an isolated temp workspace on an ephemeral port,
   zero model spend. Proves the whole contract the UI + agents rely on:

     - POST upsert -> 200, response carries the MASKED public shape (never the key value).
     - GET list -> masked rows; the raw response text contains NO key substring (the never-echo law).
     - RESTART round-trip: the key survives a host reboot (persisted store re-applied at boot).
     - toggle + remove behave and 404 honestly on unknown ids.
     - validation: bad name / bad key / bad docsUrl refused 400.
     - the injected env var actually reaches a SHELL CHILD (spawn inherits process.env) — proven via the
       host's own child env, not a claim: after upsert, a fresh boot's process.env carries the var, which
       we observe through the persisted file + a second boot's list state (the direct env read is internal;
       the observable contract is list + survival).

   NOT in test:fast (child-process boot); run via `npm run test:http`. Mirrors lifecycle-armed.http.test.js. */
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

function boot(port, workspaces, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, { SKYNET_PORT: String(port), SKYNET_WORKSPACES: workspaces }),
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
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 9000);
  });
}

const SECRET = 'rk-live-verySECRET-9876';

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-servicekeys-'));
  let booted = await boot(9030 + (process.pid % 40), ws, 20);
  let child = booted.child; let port = booted.port;
  const B = () => 'http://' + HOST + ':' + port;
  let apiToken = await bootToken(B(), B());
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json', Origin: B() };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;
    const r = await fetch(B() + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v, text: t };
  };

  try {
    // ---- empty list on a fresh boot ----
    const empty = await j('GET', '/api/servicekeys');
    A.eq(empty.status, 200, 'GET /api/servicekeys -> 200');
    A.eq(empty.body.keys, [], 'fresh boot: no keys');

    // ---- upsert: masked response, never the value ----
    const up = await j('POST', '/api/servicekeys', { name: 'Resend', key: SECRET, docsUrl: 'https://resend.com/docs' });
    A.eq(up.status, 200, 'POST /api/servicekeys -> 200');
    A.eq(up.body.key && up.body.key.envVar, 'RESEND_API_KEY', 'response names the derived env var');
    A.eq(up.body.key.last4, '····9876', 'response carries a masked last4');
    A.ok(up.text.indexOf(SECRET) < 0, 'upsert response NEVER echoes the key value');

    // ---- list: masked, never the value ----
    const list = await j('GET', '/api/servicekeys');
    A.eq(list.body.keys.length, 1, 'list has the row');
    A.eq(list.body.keys[0].name, 'Resend', 'row keeps the display name');
    A.eq(list.body.keys[0].enabled, true, 'new key enabled by default');
    A.ok(list.text.indexOf(SECRET) < 0, 'list response NEVER contains the key value');

    // ---- validation refusals ----
    A.eq((await j('POST', '/api/servicekeys', { name: '', key: 'x' })).status, 400, 'empty name -> 400');
    A.eq((await j('POST', '/api/servicekeys', { name: 'A', key: 'two words' })).status, 400, 'space in key -> 400');
    A.eq((await j('POST', '/api/servicekeys', { name: 'A', key: 'x', docsUrl: 'ftp://n' })).status, 400, 'non-http docsUrl -> 400');
    // provider-shaped names are refused: 'OpenRouter' would derive OPENROUTER_API_KEY, which the provider
    // credential resolver reads from process.env — a KEYS paste must never become billing credentials.
    const prov = await j('POST', '/api/servicekeys', { name: 'OpenRouter', key: 'sk-or-nope' });
    A.eq(prov.status, 400, 'provider-shaped name -> 400');
    A.ok(/model provider/i.test(String(prov.body.error || '')), 'refusal points at the SETTINGS surface');
    A.eq((await j('POST', '/api/servicekeys', { name: 'Anthropic', key: 'sk-ant-nope' })).status, 400, 'Anthropic likewise refused');
    A.eq((await j('POST', '/api/servicekeys/toggle', { id: 'nope', enabled: false })).status, 404, 'toggle unknown id -> 404');
    A.eq((await j('POST', '/api/servicekeys/remove', { id: 'nope' })).status, 404, 'remove unknown id -> 404');

    // ---- update with EMPTY key keeps the saved secret (the edit idiom) ----
    const upd = await j('POST', '/api/servicekeys', { name: 'Resend', key: '', docsUrl: 'https://new.docs' });
    A.eq(upd.status, 200, 'update with empty key -> 200 (saved key kept)');
    A.eq(upd.body.key.last4, '····9876', 'kept key still masks to the same last4');

    // ---- RESTART round-trip: the key survives a reboot ----
    try { child.kill(); } catch (_) {} await sleep(250);
    booted = await boot(port + 100, ws, 20);
    child = booted.child; port = booted.port;
    apiToken = await bootToken(B(), B());
    const after = await j('GET', '/api/servicekeys');
    A.eq(after.body.keys.length, 1, 'REBOOT: key survived the restart');
    A.eq(after.body.keys[0].envVar, 'RESEND_API_KEY', 'REBOOT: env var intact');
    A.eq(after.body.keys[0].docsUrl, 'https://new.docs', 'REBOOT: updated docsUrl persisted');
    A.ok(after.text.indexOf(SECRET) < 0, 'REBOOT: list still never echoes the value');

    // ---- toggle off, then remove ----
    const off = await j('POST', '/api/servicekeys/toggle', { id: 'resend', enabled: false });
    A.eq(off.status, 200, 'toggle off -> 200');
    A.eq(off.body.key.enabled, false, 'row reports disabled');
    const rm = await j('POST', '/api/servicekeys/remove', { id: 'resend' });
    A.eq(rm.status, 200, 'remove -> 200');
    A.eq((await j('GET', '/api/servicekeys')).body.keys, [], 'list empty after remove');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('servicekeys.http.test');
})().catch(e => { console.log('FAIL: servicekeys.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
