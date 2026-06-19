/* node test/cron.api.test.js — boot-level end-to-end test of the /api/cron ROUTINES CRUD surface.
   Spawns the real Node host (sidecar/index.js) against an ISOLATED temp workspace on an ephemeral port, with
   NO key (so zero model spend), and drives the routine CRUD + preview + the run-now guard over real sockets:
     - POST /api/cron            create (interval + 5-field cron -> ok; unparseable -> 400)
     - GET  /api/cron            the snapshot the panel renders (enabled:false when the tick is unarmed)
     - POST /api/cron/preview    next-5 fire times for an interval; one for a once; 400 on garbage
     - POST /api/cron/update     edit a field + pause/resume via the enabled flag
     - POST /api/cron/run        no provider credentials -> 400 (guard, zero spend); unknown id -> 404
     - POST /api/cron/remove     delete; then a SECOND boot proves the job persisted to cron.jobs.json
   Mirrors sidecar.http.test.js; NOT in test:fast (a child-process boot test shouldn't gate other agents).
   Run via `npm run test:http`. */
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

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cron-'));
  let booted = await boot(8890 + (process.pid % 60), ws, 20);
  let child = booted.child, port = booted.port;
  const B = () => 'http://' + HOST + ':' + port;
  const j = async (m, p, body) => {
    const r = await fetch(B() + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };

  try {
    // ---- create: a valid interval routine ----
    const create = await j('POST', '/api/cron', { name: 'Morning brief', prompt: 'summarize AI news', schedule: 'every 30m', agentId: 'cron_brief' });
    A.eq(create.status, 200, 'POST /api/cron (valid) -> 200');
    A.ok(create.body.ok && create.body.job && create.body.job.id, 'create returns the new job with an id');
    const id = create.body.job.id;
    A.eq(create.body.job.schedule.kind, 'interval', 'schedule parsed to an interval');
    A.eq(create.body.job.agentId, 'cron_brief', 'agentId stored');
    A.ok(create.body.job.nextRunAt, 'an enabled interval job is armed with a nextRunAt');
    const roster = await j('POST', '/api/roster', { agents: [{ agentId: 'cron_brief', system: 'ROSTER SYSTEM', name: 'Briefing Agent', model: 'roster/model', provider: 'codex', role: 'news briefings' }] });
    A.eq(roster.status, 200, 'POST /api/roster -> 200');
    A.eq(roster.body.count, 1, 'roster stores the selected cron agent identity');
    const rosterPath = path.join(ws, 'agent.roster.json');
    A.ok(fs.existsSync(rosterPath), 'agent roster mirror persisted for headless cron');
    const rosterDisk = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    A.eq(rosterDisk.agents[0].agentId, 'cron_brief', 'persisted roster carries the agentId');
    A.eq(rosterDisk.agents[0].provider, 'codex', 'persisted roster carries the selected provider');

    // ---- create: a valid 5-field cron routine is accepted and armed ----
    const cronExpr = await j('POST', '/api/cron', { name: 'Daily brief', prompt: 'daily summary', schedule: '0 9 * * *', agentId: 'cron_brief', provider: 'codex' });
    A.eq(cronExpr.status, 200, '5-field cron expr -> 200');
    A.eq(cronExpr.body.job.schedule.kind, 'cron', 'cron schedule stored as cron');
    A.eq(cronExpr.body.job.provider, 'codex', 'cron routine can pin a provider');
    A.ok(cronExpr.body.job.nextRunAt, 'an enabled cron job is armed with a nextRunAt');
    const cronId = cronExpr.body.job.id;

    // ---- create: bad inputs are refused (not silently stored as un-fireable) ----
    const badSched = await j('POST', '/api/cron', { name: 'x', prompt: 'y', schedule: 'whenever i feel like it' });
    A.eq(badSched.status, 400, 'unparseable schedule -> 400');
    const badCronExpr = await j('POST', '/api/cron', { name: 'x', prompt: 'y', schedule: '61 * * * *' });
    A.eq(badCronExpr.status, 400, 'invalid cron expr -> 400');
    const badAgent = await j('POST', '/api/cron', { name: 'x', prompt: 'y', schedule: 'every 1h', agentId: '../escape' });
    A.eq(badAgent.status, 400, 'malformed routine agentId -> 400');

    // ---- list: the snapshot the panel renders; enabled:false because SKYNET_CRON_ENABLED is unset ----
    const list = await j('GET', '/api/cron');
    A.eq(list.status, 200, 'GET /api/cron -> 200');
    A.eq(list.body.jobs.length, 2, 'two routines listed');
    A.eq(list.body.enabled, false, 'enabled:false — the tick is honestly reported as unarmed');
    A.ok(JSON.stringify(list.body).indexOf('sk-') < 0, 'no key-shaped secret in the snapshot');

    // ---- preview: next-5 for an interval, one for a once, 400 on garbage ----
    const pv = await j('POST', '/api/cron/preview', { schedule: 'every 1h' });
    A.eq(pv.status, 200, 'preview -> 200');
    A.eq(pv.body.kind, 'interval', 'preview kind interval');
    A.eq(pv.body.next.length, 5, 'preview returns 5 fire times');
    const d0 = Date.parse(pv.body.next[0]), d1 = Date.parse(pv.body.next[1]);
    A.ok(Math.abs((d1 - d0) - 3600000) < 1000, 'consecutive fire times are one hour apart');
    const pvOnce = await j('POST', '/api/cron/preview', { schedule: 'in 2h' });
    A.eq(pvOnce.body.kind, 'once', 'preview kind once');
    A.eq(pvOnce.body.next.length, 1, 'a once schedule previews exactly one fire');
    const pvCron = await j('POST', '/api/cron/preview', { schedule: '*/30 * * * *' });
    A.eq(pvCron.status, 200, 'preview of valid cron -> 200');
    A.eq(pvCron.body.kind, 'cron', 'preview kind cron');
    A.eq(pvCron.body.next.length, 5, 'cron preview returns 5 fire times');
    const pvBad = await j('POST', '/api/cron/preview', { schedule: 'nonsense!!' });
    A.eq(pvBad.status, 400, 'preview of garbage -> 400');

    // ---- update: rename + pause, then resume ----
    const upd = await j('POST', '/api/cron/update', { id, patch: { name: 'Renamed brief', enabled: false } });
    A.eq(upd.status, 200, 'update -> 200');
    A.eq(upd.body.job.name, 'Renamed brief', 'name edited');
    A.eq(upd.body.job.enabled, false, 'paused via enabled:false');
    A.eq(upd.body.job.state, 'paused', 'state paused');
    const res = await j('POST', '/api/cron/update', { id, patch: { enabled: true } });
    A.eq(res.body.job.enabled, true, 'resumed via enabled:true');
    A.eq(res.body.job.state, 'scheduled', 'state scheduled after resume');
    A.ok(res.body.job.nextRunAt, 're-armed nextRunAt on resume');
    const updMissing = await j('POST', '/api/cron/update', { id: 'nope', patch: { name: 'z' } });
    A.eq(updMissing.status, 404, 'update of an unknown id -> 404');
    const updBadAgent = await j('POST', '/api/cron/update', { id, patch: { agentId: 'bad agent!' } });
    A.eq(updBadAgent.status, 400, 'update rejects a malformed agentId');
    const updBadProvider = await j('POST', '/api/cron/update', { id, patch: { provider: 'bad-provider' } });
    A.eq(updBadProvider.status, 400, 'update rejects an unknown provider');

    // ---- run-now: guarded (no provider credentials -> 400; unknown id -> 404) — zero spend ----
    const runNoKey = await j('POST', '/api/cron/run', { id });
    A.eq(runNoKey.status, 400, 'run-now with no provider credentials -> 400 (no spend)');
    const runMissing = await j('POST', '/api/cron/run', { id: 'nope' });
    A.eq(runMissing.status, 404, 'run-now of an unknown id -> 404');

    // ---- persistence: the routine survives a fresh boot on the same workspace ----
    A.ok(fs.existsSync(path.join(ws, 'cron.jobs.json')), 'cron.jobs.json written to the workspace');
    try { child.kill(); } catch (_) {} await sleep(200);
    booted = await boot(port + 100, ws, 20); child = booted.child; port = booted.port;
    const after = await j('GET', '/api/cron');
    A.eq(after.body.jobs.length, 2, 'the routines persisted across a restart');
    A.ok(after.body.jobs.some(job => job.name === 'Renamed brief'), 'the edited name persisted');
    A.ok(after.body.jobs.some(job => job.schedule && job.schedule.kind === 'cron'), 'the cron routine persisted');
    A.ok(after.body.jobs.some(job => job.provider === 'codex'), 'the routine provider persisted');

    // ---- remove: delete then confirm gone ----
    const rm = await j('POST', '/api/cron/remove', { id });
    A.eq(rm.status, 200, 'remove -> 200');
    const rmCron = await j('POST', '/api/cron/remove', { id: cronId });
    A.eq(rmCron.status, 200, 'remove cron -> 200');
    const empty = await j('GET', '/api/cron');
    A.eq(empty.body.jobs.length, 0, 'routine removed');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('cron.api.test');
})().catch(e => { console.log('FAIL: cron.api.test threw — ' + (e && e.stack || e)); process.exit(1); });
