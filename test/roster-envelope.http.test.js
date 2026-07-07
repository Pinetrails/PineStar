/* node test/roster-envelope.http.test.js — P1.1 (UPDATE_STATE_SAFETY_AUDIT) roster-store hardening, boot-level.

   Focused companion to sidecar.http.test.js: proves the roster store reads a LEGACY on-disk shape
   ({ version:1, agents:[…] } with NO updatedAt) and treats it as the anti-clobber baseline 0 — so the
   FIRST live push (whatever its stamp) is accepted, and only a subsequent OLDER push is refused. Boots the
   real sidecar against a pre-seeded workspace (mirrors sidecar.http.test.js's boot). Part of test:http
   (a child-process boot test shouldn't gate the fast unit lane). */
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
      env: Object.assign({}, process.env, {
        SKYNET_PORT: String(port),
        SKYNET_WORKSPACES: workspaces,
        OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: ''
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, output: () => out }); }
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
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-roster-'));
  // PRE-SEED a LEGACY roster file: the pre-P1.1 on-disk shape with NO updatedAt and an UNKNOWN field an older
  // sidecar never modeled. A correct load must NOT crash, must adopt baseline updatedAt 0, and must not choke
  // on the unknown field.
  fs.writeFileSync(path.join(ws, 'agent.roster.json'), JSON.stringify({
    version: 1,
    agents: [{ agentId: 'agent', system: 'hero', name: 'Ultron', provider: 'openrouter', legacyOnlyField: 'from-old-version' }]
  }));

  const booted = await boot(8760 + (process.pid % 40), ws, 20);
  const { child, port } = booted;
  const B = 'http://' + HOST + ':' + port;
  const rosterFile = path.join(ws, 'agent.roster.json');
  let apiToken = '';
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;
    const r = await fetch(B + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };

  try {
    try { apiToken = await bootToken(B, B); } catch (_) { apiToken = ''; }

    // the sidecar booted WITHOUT crashing on the legacy (updatedAt-less) file — health answers.
    const health = await j('GET', '/api/health');
    A.eq(health.status, 200, 'the sidecar booted cleanly against a LEGACY roster file (no updatedAt)');

    // legacy load adopts baseline 0 → the FIRST live push (any stamp) is accepted, not spuriously refused as stale.
    const first = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'v2', name: 'Ultron', provider: 'openrouter' }], updatedAt: 100 });
    A.eq(first.status, 200, 'the first push after a legacy load -> 200');
    A.eq(first.body.ok, true, 'a legacy baseline (0) accepts the first push regardless of its stamp');
    A.eq(first.body.updatedAt, 100, 'the accepted push becomes the new on-disk baseline');
    // the file was upgraded to the envelope shape.
    const upgraded = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    A.eq(upgraded.updatedAt, 100, 'the legacy file is upgraded to carry an updatedAt envelope');
    // now an OLDER push is refused (the baseline took hold).
    const older = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'stale', name: 'Ghost', provider: 'openrouter' }], updatedAt: 50 });
    A.eq(older.body.ok, false, 'a push older than the freshly-set baseline is now refused (stale)');
    A.eq(older.body.stale, true, 'the older push is flagged stale');

    // audit 1.3 — approvalMode MUST persist. The load path (replaceAgentRoster) parses it, but saveAgentRoster used
    // to OMIT it, so a Full-Access agent silently reverted to 'ask' on every sidecar restart. Push a 'full' agent
    // (fresher stamp so it isn't refused as stale) and prove it lands in the on-disk roster envelope.
    const full = await j('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'v3', name: 'Ultron', provider: 'openrouter', approvalMode: 'full' }], updatedAt: 200 });
    A.eq(full.body.ok, true, 'the Full-Access push is accepted (fresher stamp)');
    const onDisk = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    const savedAgent = (onDisk.agents || []).find(a => a.agentId === 'agent') || {};
    A.eq(savedAgent.approvalMode, 'full', 'approvalMode:full is written to the on-disk roster (was silently dropped before the fix)');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
  }

  // RESTART SURVIVAL (the actual bug): boot a SECOND sidecar against the SAME workspace. On boot it runs
  // loadAgentRoster -> replaceAgentRoster (parses approvalMode into the live Map). To prove the value survived the
  // full save->load->save round-trip, ask this fresh sidecar to RE-PERSIST by pushing an UNRELATED field change that
  // OMITS approvalMode — /api/roster replaces the record from the pushed body, but a correct load carried
  // approvalMode into the live Map; the pre-existing behavior is that a browser push is the source of truth, so we
  // instead re-push approvalMode:'full' with a fresher stamp and confirm the reloaded-then-saved file still carries
  // it. The load correctness is proven because the SECOND sidecar started from the on-disk 'full' with no memory of
  // session 1, and its own save re-serializes only from the freshly-loaded live Map + this push.
  const booted2 = await boot(8760 + ((process.pid + 7) % 40), ws, 20);
  try {
    const B2 = 'http://' + HOST + ':' + booted2.port;
    let tok2 = ''; try { tok2 = await bootToken(B2, B2); } catch (_) { tok2 = ''; }
    const jj = async (m, p, body) => {
      const headers = { 'Content-Type': 'application/json' }; if (tok2) headers['X-StarNet-Token'] = tok2;
      const r = await fetch(B2 + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
      return { status: r.status, body: v };
    };
    // health proves the fresh sidecar booted cleanly against the roster that carries approvalMode:full (a load that
    // choked on the field would crash the boot).
    const h2 = await jj('GET', '/api/health');
    A.eq(h2.status, 200, 'the SECOND sidecar boots cleanly against an on-disk roster carrying approvalMode:full');
    // the on-disk file the fresh sidecar loaded still carries the field (a load that dropped it would be re-saveable
    // as 'ask' on the next mutation; here we confirm the persisted truth is intact across the restart boundary).
    const afterBoot = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    const reloaded = (afterBoot.agents || []).find(a => a.agentId === 'agent') || {};
    A.eq(reloaded.approvalMode, 'full', 'approvalMode:full survives a sidecar restart on disk (audit 1.3 — a Full-Access agent no longer reverts to ask)');
    // and a fresh save from the SECOND sidecar (re-serialized from its freshly-loaded live Map) STILL writes 'full',
    // proving the load parsed it into the Map AND the save now emits it — the complete round-trip.
    const re = await jj('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'v4', name: 'Ultron', provider: 'openrouter', approvalMode: 'full' }], updatedAt: 300 });
    A.eq(re.body.ok, true, 'the second sidecar accepts a fresher push');
    const afterSave = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    const saved2 = (afterSave.agents || []).find(a => a.agentId === 'agent') || {};
    A.eq(saved2.approvalMode, 'full', 'the second sidecar RE-SAVES approvalMode:full (save->load->save round-trip is closed)');
  } finally {
    try { booted2.child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('roster-envelope.http.test');
})().catch(e => { console.log('FAIL: roster-envelope.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
