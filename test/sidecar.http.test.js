/* node test/sidecar.http.test.js — boot-level end-to-end test of the real Node host (sidecar/index.js).
   Spawns the actual server as a child process against an ISOLATED temp workspace (SKYNET_WORKSPACES) on an
   ephemeral port, then drives the cost-spine HTTP surface over real sockets:
     - GET  /api/health
     - GET  /api/budget/status        (reads a PRE-SEEDED ledger -> pools reflect persisted spend)
     - POST /api/budget/resume        (valid scope lifts the cap; bad scope 400s)
     - POST /api/run                  (missing key/model 400s — the guard path, zero spend)
   Zero network dependence (the catalog warm fails closed offline) and ZERO model spend — it never sends a key.
   This is the one test that proves the server actually BOOTS and the new routes are wired, not just the units.

   NOT in test:fast (a child-process boot test shouldn't gate ~25 other agents' merges); run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// spawn the host on a candidate port; resolve once it logs "listening", retry the next port on EADDRINUSE.
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
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 9000);
  });
}

(async () => {
  // isolated workspace, PRE-SEEDED with two finished runs inside the trailing-day window (ts ~ now)
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-http-'));
  const now = Date.now();
  const seed = [
    { runId: 'r1', agentId: 'alice', turns: 3, usd: 1.25, tokens: 1200, ts: now - 1000 },
    { runId: 'r2', agentId: 'bob', turns: 1, usd: 0.75, tokens: 400, ts: now - 500 }
  ];
  fs.writeFileSync(path.join(ws, 'ledger.jsonl'), seed.map(e => JSON.stringify(e)).join('\n') + '\n');

  const booted = await boot(8820 + (process.pid % 60), ws, 20);
  const { child, port } = booted;
  const B = 'http://' + HOST + ':' + port;
  let apiToken = '';
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (apiToken && m !== 'GET') headers['X-StarNet-Token'] = apiToken;
    const r = await fetch(B + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };

  try {
    // ---- health ----
    const health = await j('GET', '/api/health');
    A.eq(health.status, 200, 'GET /api/health -> 200');
    A.eq(health.body, 'ok', 'health body is ok');

    // ---- localhost API hardening: no wildcard CORS, hostile web origins rejected ----
    const sameOrigin = await fetch(B + '/api/budget/status', { headers: { Origin: B } });
    A.eq(sameOrigin.status, 200, 'same-origin API request with Origin -> 200');
    A.eq(sameOrigin.headers.get('access-control-allow-origin'), B, 'same-origin CORS mirrors the exact loopback origin');

    const tauriOrigin = 'http://tauri.localhost';
    const tauri = await fetch(B + '/api/budget/status', { headers: { Origin: tauriOrigin } });
    A.eq(tauri.status, 200, 'Tauri app origin API request -> 200');
    A.eq(tauri.headers.get('access-control-allow-origin'), tauriOrigin, 'Tauri CORS mirrors the trusted app origin');

    const badOrigin = await fetch(B + '/api/budget/status', { headers: { Origin: 'https://evil.example' } });
    A.eq(badOrigin.status, 403, 'foreign web origin API request -> 403');
    A.eq(badOrigin.headers.get('access-control-allow-origin'), null, 'foreign origin gets no CORS read access');

    const preflight = await fetch(B + '/api/run', { method: 'OPTIONS', headers: { Origin: B, 'Access-Control-Request-Method': 'POST' } });
    A.eq(preflight.status, 204, 'trusted API preflight -> 204');
    A.eq(preflight.headers.get('access-control-allow-origin'), B, 'trusted preflight mirrors loopback origin');
    const badPreflight = await fetch(B + '/api/run', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    A.eq(badPreflight.status, 403, 'foreign API preflight -> 403');

    const injected = await (await fetch(B + '/')).text();
    A.ok(/__STARNET_API_TOKEN__/.test(injected), 'served index.html bootstraps the API token for browser mode');

    const sess = await fetch(B + '/api/session', { method: 'POST', headers: { Origin: B } });
    A.eq(sess.status, 200, 'POST /api/session from trusted origin -> 200');
    const sessBody = await sess.json();
    apiToken = String(sessBody.token || '');
    A.ok(apiToken.length >= 32, 'session returns a high-entropy API token');

    // ---- slash command catalog + dispatch seam ----
    const slashCat = await j('GET', '/api/slash/catalog');
    A.eq(slashCat.status, 200, 'GET /api/slash/catalog -> 200');
    A.ok(Array.isArray(slashCat.body.commands), 'slash catalog returns commands');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'retry'), 'slash catalog includes /retry');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'morning-brief'), 'slash catalog includes built-in recipe commands');
    A.ok(slashCat.body.commands.some(c => c && c.name === 'plan' && c.source === 'skill'), 'slash catalog includes available compute-only skill commands');
    A.ok(!slashCat.body.commands.some(c => c && c.name === 'test-driven-development'), 'slash catalog omits unavailable workbench skill without placed workbench');

    const slashBench = await j('GET', '/api/slash/catalog?placed=workbench');
    A.ok(slashBench.body.commands.some(c => c && c.name === 'test-driven-development'), 'slash catalog includes workbench skill when workbench is placed');

    const slashRun = await j('POST', '/api/slash/dispatch', { input: '/retry' });
    A.eq(slashRun.status, 200, 'POST /api/slash/dispatch /retry -> 200');
    A.eq(slashRun.body.directive, { type: 'client', action: 'retry', args: '' }, 'slash dispatch returns a client retry directive');

    const slashRecipe = await j('POST', '/api/slash/dispatch', { input: '/summarize launch notes' });
    A.eq(slashRecipe.status, 200, 'POST /api/slash/dispatch recipe -> 200');
    A.eq(slashRecipe.body.directive.type, 'insert', 'recipe slash dispatch returns insert directive');
    A.ok(String(slashRecipe.body.directive.text || '').indexOf('launch notes') >= 0, 'recipe slash dispatch carries typed args into the draft');

    const slashSkill = await j('POST', '/api/slash/dispatch', { input: '/plan refactor commands' });
    A.eq(slashSkill.status, 200, 'POST /api/slash/dispatch skill -> 200');
    A.eq(slashSkill.body.directive.source, 'skill', 'skill slash dispatch returns a skill directive');
    A.ok(String(slashSkill.body.directive.text || '').indexOf('refactor commands') >= 0, 'skill slash dispatch carries typed args into the task');

    const slashUnknown = await j('POST', '/api/slash/dispatch', { input: '/unknown' });
    A.eq(slashUnknown.status, 404, 'POST /api/slash/dispatch unknown -> 404');

    const noApiToken = await fetch(B + '/api/budget/resume', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: JSON.stringify({ scope: 'day' }) });
    A.eq(noApiToken.status, 403, 'privileged POST without X-StarNet-Token -> 403');

    // ---- budget status reflects the PRE-SEEDED ledger (persisted spend survived a fresh boot) ----
    const st = await j('GET', '/api/budget/status');
    A.eq(st.status, 200, 'GET /api/budget/status -> 200');
    A.eq(st.body.runs, 2, 'status counts the two seeded runs');
    A.ok(Math.abs(st.body.totalUsd - 2.0) < 1e-9, 'totalUsd = seeded $1.25 + $0.75');
    A.eq(st.body.perRun, 3, 'perRun cap exposed (Balanced $3)');
    A.ok(st.body.day && Math.abs(st.body.day.cap - 40) < 1e-9, 'day pool base cap is $40');
    A.ok(st.body.global && Math.abs(st.body.global.cap - 100) < 1e-9, 'global pool base cap is $100');
    A.ok(Math.abs(st.body.day.usd - 2.0) < 1e-9, 'day pool reflects seeded spend inside the 24h window');
    A.ok(Math.abs(st.body.global.usd - 2.0) < 1e-9, 'global pool reflects seeded spend');
    A.ok(JSON.stringify(st.body).indexOf('sk-') < 0, 'status leaks no key-shaped secret');

    // ---- resume lifts a pool for the session ----
    const rs = await j('POST', '/api/budget/resume', { scope: 'day' });
    A.eq(rs.status, 200, 'POST /api/budget/resume{day} -> 200');
    A.eq(rs.body.resumed, 'day', 'resume names the scope');
    A.ok(Math.abs(rs.body.cap - 80) < 1e-9, 'resume lifts the day cap to $80 (base + base)');

    const st2 = await j('GET', '/api/budget/status');
    A.ok(Math.abs(st2.body.day.cap - 80) < 1e-9, 'status reflects the lifted day cap after resume');
    A.ok(Math.abs(st2.body.overrides.day - 40) < 1e-9, 'override headroom exposed');

    // ---- resume rejects an ungoverned / bogus scope ----
    const bad = await j('POST', '/api/budget/resume', { scope: 'bogus' });
    A.eq(bad.status, 400, 'resume of a bogus scope -> 400');
    const runScope = await j('POST', '/api/budget/resume', { scope: 'run' });
    A.eq(runScope.status, 400, 'resume of the per-run scope -> 400 (run is the loop hard cap, not a pool)');

    // ---- /api/run guard path (no key -> 400, zero spend) ----
    const noKey = await j('POST', '/api/run', { model: 'anthropic/claude-sonnet-4.6' });
    A.eq(noKey.status, 400, 'POST /api/run without a key -> 400');
    const noModel = await j('POST', '/api/run', { key: 'sk-or-v1-fake' });
    A.eq(noModel.status, 400, 'POST /api/run without a model -> 400');
    const badJson = await fetch(B + '/api/run', { method: 'POST', headers: { 'X-StarNet-Token': apiToken }, body: '{not json' });
    A.eq(badJson.status, 400, 'POST /api/run with malformed JSON -> 400');

    // ---- /api/file media serving: typed content-type + HTTP Range (so COMMS <video>/<audio> can seek) ----
    // write a known-size clip into the agent's jailed workspace (<ws>/agent/clips/clip.webm)
    const N = 1000;
    fs.mkdirSync(path.join(ws, 'agent', 'clips'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent', 'clips', 'clip.webm'), Buffer.alloc(N, 7));
    const fileUrl = B + '/api/file?agent=agent&path=' + encodeURIComponent('clips/clip.webm');

    const full = await fetch(fileUrl);
    A.eq(full.status, 200, 'GET /api/file -> 200');
    A.eq(full.headers.get('content-type'), 'video/webm', 'webm served with a video content-type');
    A.eq(full.headers.get('accept-ranges'), 'bytes', 'full response advertises byte-range support');
    A.eq(full.headers.get('content-length'), String(N), 'full Content-Length is the file size');
    A.eq((await full.arrayBuffer()).byteLength, N, 'full body is the whole file');

    const ranged = await fetch(fileUrl, { headers: { Range: 'bytes=100-199' } });
    A.eq(ranged.status, 206, 'ranged GET -> 206 Partial Content');
    A.eq(ranged.headers.get('content-range'), 'bytes 100-199/' + N, 'Content-Range names the served slice + total');
    A.eq(ranged.headers.get('content-length'), '100', 'partial Content-Length is the slice size');
    A.eq((await ranged.arrayBuffer()).byteLength, 100, 'partial body is exactly the requested 100 bytes');

    const suffix = await fetch(fileUrl, { headers: { Range: 'bytes=-50' } });
    A.eq(suffix.status, 206, 'suffix range -> 206');
    A.eq(suffix.headers.get('content-range'), 'bytes 950-999/' + N, 'suffix range resolves to the last N bytes');

    const unsat = await fetch(fileUrl, { headers: { Range: 'bytes=99999-' } });
    A.eq(unsat.status, 416, 'unsatisfiable range -> 416');
    A.eq(unsat.headers.get('content-range'), 'bytes */' + N, '416 reports the full size');

    const head = await fetch(fileUrl, { method: 'HEAD' });
    A.eq(head.status, 200, 'HEAD /api/file -> 200');
    A.eq(head.headers.get('content-length'), String(N), 'HEAD reports the size with no body');
    A.eq((await head.arrayBuffer()).byteLength, 0, 'HEAD carries no body');

    const escape = await fetch(B + '/api/file?agent=agent&path=' + encodeURIComponent('../../etc/passwd'));
    A.ok(escape.status === 403 || escape.status === 404, 'a jail-escape path is refused (403/404), never served');

    // ---- /api/summon/ack: the team.summon round-trip's reply leg. A stale runId/requestId is a harmless 200
    //      no-op (the run already ended or auto-settled), exactly like /api/consent; malformed JSON 400s. ----
    const ackStale = await j('POST', '/api/summon/ack', { runId: 'nope', requestId: 'nope', agentId: 'researcher-2' });
    A.eq(ackStale.status, 200, 'POST /api/summon/ack with an unknown run -> 200 no-op');
    const ackBadJson = await fetch(B + '/api/summon/ack', { method: 'POST', headers: { 'X-StarNet-Token': apiToken }, body: '{not json' });
    A.eq(ackBadJson.status, 400, 'POST /api/summon/ack with malformed JSON -> 400');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('sidecar.http.test');
})().catch(e => { console.log('FAIL: sidecar.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
