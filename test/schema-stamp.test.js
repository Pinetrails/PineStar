/* node test/schema-stamp.test.js — P2.1 (UPDATE_STATE_SAFETY_AUDIT): workspace-root schemaVersion stamp + the
   newer-stamp DEGRADED guard, proven against the REAL sidecar.

   Part 1: boot a fresh sidecar on an empty workspace → assert <WORKSPACES>/.schema-version.json is written with
           { version:1, schemaVersion:1, stampedAt }.
   Part 2: pre-seed a workspace with schemaVersion:2 (a NEWER StarNet wrote it), boot this (older) sidecar → assert
           it enters DEGRADED mode: POST /api/roster and POST /api/save are REFUSED with the honest error, but GET
           /api/save still serves (reads never blocked) and the boot log warns loudly.

   NOT in test:fast? — it IS registered (child-process boot, but fast + deterministic, no network). Run via node.  */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

// spawn the real sidecar; resolve once it logs its listen URL (capturing stdout+stderr for the boot-log assertion).
// Retries the next port on EADDRINUSE.
function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, out: () => out }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---- Part 1: fresh workspace → stamp is written ---------------------------------------------------------------
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-schema-fresh-'));
    const { child } = await boot(8940 + (process.pid % 40), { SKYNET_WORKSPACES: ws }, 20);
    try {
      const stampPath = path.join(ws, '.schema-version.json');
      // the stamp is written synchronously at boot (before listen), so by the time we saw the listen URL it exists.
      A.ok(fs.existsSync(stampPath), '.schema-version.json is written on a fresh boot');
      const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
      A.eq(stamp.version, 1, 'stamp envelope version is 1');
      A.eq(stamp.schemaVersion, 1, 'stamp schemaVersion is 1');
      A.ok(typeof stamp.stampedAt === 'number' && stamp.stampedAt > 0, 'stamp carries a numeric stampedAt');
    } finally { try { child.kill(); } catch (_) {} }
  }

  // ---- Part 2: pre-seeded NEWER stamp → DEGRADED (writes refused, reads served) ---------------------------------
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-schema-newer-'));
    // A NEWER StarNet already wrote this workspace: schemaVersion 2 > the 1 this sidecar understands.
    fs.writeFileSync(path.join(ws, '.schema-version.json'), JSON.stringify({ version: 1, schemaVersion: 2, stampedAt: Date.now() }));
    const { child, port, out } = await boot(8985 + (process.pid % 40), { SKYNET_WORKSPACES: ws }, 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      // boot log warned LOUDLY (never silent)
      await wait(150);
      A.ok(/WORKSPACE WRITTEN BY A NEWER STARNET|DEGRADED/i.test(out()), 'boot logs a loud newer-StarNet / DEGRADED warning');

      const token = await bootToken(B, B);
      A.ok(token.length >= 32, 'got a session API token');
      const hdrs = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

      // the sidecar did NOT re-stamp the newer marker DOWN (leave newer data honest)
      const stamp = JSON.parse(fs.readFileSync(path.join(ws, '.schema-version.json'), 'utf8'));
      A.eq(stamp.schemaVersion, 2, 'the newer on-disk stamp is left untouched (not downgraded)');

      // POST /api/roster is REFUSED with the honest error (200 { ok:false }, NOT a wipe)
      const rosterRes = await fetch(B + '/api/roster', {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ agents: [{ agentId: 'agent', name: 'Hero', system: 'x' }] })
      });
      A.eq(rosterRes.status, 200, 'degraded roster POST answers 200 (honest payload, not 5xx)');
      const rosterJson = await rosterRes.json();
      A.eq(rosterJson.ok, false, 'degraded roster POST is refused (ok:false)');
      A.eq(rosterJson.error, 'workspace written by newer StarNet', 'degraded roster POST carries the honest error');
      // the on-disk roster was NOT written (the refusal happened before any write)
      A.ok(!fs.existsSync(path.join(ws, 'agent.roster.json')), 'degraded roster POST wrote nothing to disk');

      // POST /api/save is likewise REFUSED
      const saveRes = await fetch(B + '/api/save', {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ agent: { id: 'agent' }, schema: 'starnet.save', version: 1, updatedAt: Date.now(), world: {} })
      });
      A.eq(saveRes.status, 200, 'degraded save POST answers 200');
      const saveJson = await saveRes.json();
      A.eq(saveJson.ok, false, 'degraded save POST is refused (ok:false)');
      A.eq(saveJson.error, 'workspace written by newer StarNet', 'degraded save POST carries the honest error');

      // GET /api/save STILL SERVES (reads are never blocked in degraded mode)
      const readRes = await fetch(B + '/api/save?agent=agent', { headers: { 'X-StarNet-Token': token, Origin: B } });
      A.eq(readRes.status, 200, 'GET /api/save still serves in degraded mode (reads not blocked)');
    } finally { try { child.kill(); } catch (_) {} }
  }

  A.report('schema-stamp.test');
})().catch(e => { console.error(e); process.exit(1); });
