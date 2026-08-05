/* node test/subagents.test.js - durable background subagent registry. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSubagentManager } = require('../sidecar/subagents.js');

function tick() { return new Promise(resolve => setImmediate(resolve)); }

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-subagents-'));
  const file = path.join(root, 'subagents.json');
  let T = 1000;
  const clock = { now: () => T++ };
  const emitted = [];
  let n = 0;
  const ids = () => 'id_' + (++n);

  try {
    const mgr = makeSubagentManager({ fs, pathMod: path, file, clock, emit: (name, p) => emitted.push({ name, p }), newId: ids });

    // start returns a watchable running record immediately; events are tailed and existing task events are emitted.
    const s = mgr.start({ leadId: 'lead', agentId: 'worker', prompt: 'do work' }, async (h) => {
      h.emit('agent.run.start', { agentId: 'worker', runId: h.runId, trigger: 'directive', model: 'm' });
      return { status: 'done', reason: 'done', result: 'finished', usd: 0.12 };
    });
    A.eq(s.status, 'running', 'start returns a running record');
    A.ok(s.id && s.runId, 'record has stable ids');
    await tick(); await tick();
    const done = mgr.get(s.id);
    A.eq(done.status, 'done', 'completed runner marks record done');
    A.eq(done.result, 'finished', 'completed runner stores result');
    A.ok(done.events.some(e => e.name === 'agent.run.start'), 'watch event tail stores forwarded lifecycle');
    A.ok(emitted.some(e => e.name === 'task' && e.p.status === 'running'), 'start emits existing task running event');
    A.ok(emitted.some(e => e.name === 'task' && e.p.status === 'done'), 'completion emits existing task done event');

    // interrupt aborts the live controller and leaves a resumable durable record.
    let captured = null;
    const hold = mgr.start({ leadId: 'lead', agentId: 'worker', prompt: 'hold' }, async (h) => {
      captured = h;
      return new Promise(() => {});
    });
    await tick();
    const cut = mgr.interrupt(hold.id, 'lead');
    A.ok(cut.ok, 'interrupt succeeds');
    A.ok(captured.signal.aborted, 'interrupt aborts the live signal');
    const interrupted = mgr.get(hold.id);
    A.eq(interrupted.status, 'interrupted', 'interrupt marks record interrupted');
    A.eq(interrupted.canResume, true, 'interrupted record can resume');
    A.ok(!mgr.interrupt(hold.id, 'other').ok, 'lead ownership is enforced');

    // restart/load marks formerly-running records stale; resume restarts in the same durable record.
    const stale = mgr.start({ leadId: 'lead', agentId: 'worker', prompt: 'resume me' }, async () => new Promise(() => {}));
    await tick();
    const mgr2 = makeSubagentManager({ fs, pathMod: path, file, clock, emit: () => {}, newId: ids });
    A.eq(mgr2.get(stale.id).status, 'stale', 'a running record is marked stale on manager reload');
    const resumed = mgr2.resume(stale.id, async () => ({ status: 'done', reason: 'done', result: 'resumed', usd: 0.2 }));
    A.ok(resumed.ok, 'resume starts stale record');
    await tick(); await tick();
    const after = mgr2.get(stale.id);
    A.eq(after.status, 'done', 'resumed runner can complete');
    A.eq(after.result, 'resumed', 'resume stores new result');
    A.ok(after.attempts >= 2, 'resume increments attempts');

    // Crash after durable finalization but before destination publication: restart replays the same logical receipt.
    const crashMgr = makeSubagentManager({ fs, pathMod: path, file, clock, emit: () => {}, newId: ids,
      afterFinalizationCommitted: () => false });
    const crash = crashMgr.start({ leadId: 'lead', agentId: 'worker', prompt: 'survive finalization', destination: 'lead:lead', runId: 'run_final' },
      async () => ({ status: 'done', reason: 'done', result: 'durable answer', usd: 0.33 }));
    await tick(); await tick();
    const pending = crashMgr.get(crash.id);
    A.eq(pending.finalization.state, 'pending', 'completion receipt is durable before publication');
    const recoveredEvents = [];
    const recoveredMgr = makeSubagentManager({ fs, pathMod: path, file, clock, emit: (name, p) => recoveredEvents.push({ name, p }), newId: ids });
    const recovered = recoveredMgr.get(crash.id);
    A.eq(recovered.finalization.state, 'delivered', 'restart reconciles a pending finalization');
    A.eq({ result: recovered.result, usd: recovered.usd, destination: recovered.finalization.destination },
      { result: 'durable answer', usd: 0.33, destination: 'lead:lead' }, 'result, one cost record, and original destination survive together');
    A.eq(recoveredEvents.filter(e => e.name === 'task' && e.p.id === crash.id && e.p.status === 'done').length, 1,
      'recovery publishes one idempotent terminal task receipt');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('subagents.test');
})().catch(e => { console.log('FAIL: subagents.test threw - ' + (e && e.stack || e)); process.exit(1); });
