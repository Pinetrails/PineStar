/* node test/cron.dispatch.test.js — TRANSACTIONAL DISPATCH + GENERATION FENCE (2026-07-15 reliability audit).

   Locks the two launch-integrity guarantees added to sidecar/cron-driver.js:
     · TRANSACTIONAL DISPATCH: a launch is CONDITIONAL on a verified durable advance/claim. When setJobs
       returns false (the host's persist did not reach disk), the tick fires NOTHING — every planned fire is
       deferred, the jobs stay due, and the next tick (with a working disk) fires exactly once. Launching
       over an unpersisted advance is the crash-restart double-fire window this closes.
     · GENERATION FENCE: only the run that still OWNS the job's lease may settle its record. A reclaimed
       (zombie-swept) run that settles late must NOT markRun — its stale completion would overwrite the
       replacement run's fresher state. It still emits an honest cron.result (reason 'stale-lease'). */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');

const T0 = 1700000000000;
const flush = () => new Promise(r => setImmediate(r));

// a harness variant of cron.tick.test.js's setup with a CONTROLLABLE setJobs receipt and hand-settled runs.
function setup(jobs, opts) {
  opts = opts || {};
  const clock = makeClock(T0);
  let store = (jobs || []).slice();
  const events = [];
  const runs = [];            // { opts, resolve, reject } — settle a run by hand
  let idN = 0;
  let failPersist = false;    // when true, setJobs refuses (returns false) WITHOUT applying — the host
                              // rolls its mirror back to disk on failure, so "not applied" models it.
  const driver = makeCronDriver({
    getJobs: () => store,
    setJobs: (j) => { if (failPersist) return false; store = j; return true; },
    runOnce: (o) => new Promise((resolve, reject) => { runs.push({ opts: o, resolve, reject }); }),
    emit: (name, payload) => { events.push({ name, payload }); },
    newId: () => 'run-' + (++idN),
    newAbort: () => new AbortController(),
    now: () => clock.now(),
    getKey: () => 'sk-test',
    defaultModel: 'test/model',
    persona: 'PERSONA',
    maxRunMs: 480000
  });
  return {
    driver, clock, events, runs,
    getJob: (id) => cronStore.getJob(store, id),
    setStore: (fn) => { store = fn(store); },
    setFailPersist: (v) => { failPersist = v; }
  };
}
const firstOf = (events, name) => (events.find(e => e.name === name) || {}).payload;
const lastOf = (events, name) => { const m = events.filter(e => e.name === name); return m.length ? m[m.length - 1].payload : undefined; };

function intervalJob(id, everyStr) {
  const schedule = cron.parseSchedule(everyStr, T0);
  return cronStore.makeJob({ id, prompt: 'do ' + id, agentId: 'cron_' + id, schedule }, { id, now: T0 });
}

(async function () {

  // ---- 1. TRANSACTIONAL DISPATCH: a failed advance persist launches NOTHING; the job stays due; the
  //         next tick with a healthy disk fires exactly once. ----
  {
    const j = intervalJob('t1', 'every 1m');                 // armed nextRunAt = T0 + 60000
    const s = setup([j]);
    s.setFailPersist(true);
    s.clock.set(T0 + 60000);
    const r1 = s.driver.applyTick(s.clock.now());
    A.eq(r1.fired, 0, 'failed advance persist -> nothing fires');
    A.eq(r1.unpersisted, true, 'the tick reports the unpersisted advance');
    A.eq(r1.deferred, ['t1'], 'the due job is deferred, not dropped');
    A.eq(s.runs.length, 0, 'runOnce was never called over an unpersisted advance');
    A.eq(s.getJob('t1').nextRunAt, cron._internals.iso(T0 + 60000), 'nextRunAt unchanged — the job stays DUE');

    // disk recovers -> the SAME occurrence fires exactly once on the next tick.
    s.setFailPersist(false);
    const r2 = s.driver.applyTick(s.clock.now());
    A.eq(r2.fired, 1, 'healthy disk on the next tick -> the deferred job fires');
    A.eq(s.runs.length, 1, 'exactly one launch total (no double-fire, no loss)');
    A.ok(Date.parse(s.getJob('t1').nextRunAt) > s.clock.now(), 'the advance persisted before the launch');
    s.runs[0].resolve(); await flush();
  }

  // ---- 2. GENERATION FENCE: a reclaimed run settling late does NOT overwrite the replacement's record. ----
  {
    const j = intervalJob('f1', 'every 60m');                // armed nextRunAt = T0 + 3600000
    const s = setup([j]);
    s.clock.set(T0 + 3600000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 1, 'run-1 launched');

    // run-1 goes silent past the heartbeat-stale ceiling -> the sweep reclaims its lease.
    s.clock.set(T0 + 3600000 + 480001);
    s.driver.applyTick(s.clock.now());
    A.eq(firstOf(s.events, 'cron.skipped').reason, 'stale-lock-reclaimed', 'the zombie lease was reclaimed');
    A.eq(s.driver.leases.size, 0, 'the reclaimed lease is gone');

    // a REPLACEMENT fires (make the job due now) and settles cleanly -> it owns the record.
    s.setStore(jobs => jobs.map(x => x.id === 'f1' ? Object.assign({}, x, { nextRunAt: cron._internals.iso(s.clock.now()) }) : x));
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 2, 'replacement run-2 launched');
    s.runs[1].resolve(); await flush();
    A.eq(s.getJob('f1').lastRunId, 'run-2', 'the replacement settled and owns lastRunId');
    const advancedNext = s.getJob('f1').nextRunAt;

    // NOW the zombie run-1 finally settles. FENCE: it must not touch the store — run-2's record stands.
    s.runs[0].resolve(); await flush();
    A.eq(s.getJob('f1').lastRunId, 'run-2', 'the stale run did NOT overwrite the replacement (generation fence)');
    A.eq(s.getJob('f1').nextRunAt, advancedNext, 'the stale run did not disturb the advanced nextRunAt');
    const staleResult = lastOf(s.events, 'cron.result');
    A.eq(staleResult.runId, 'run-1', 'the stale run still reports its own cron.result');
    A.ok(String(staleResult.reason).indexOf('stale-lease') >= 0, 'the stale settlement is honestly labeled stale-lease');
  }

  // ---- 3. FENCE + ABORT: the sweep aborts the zombie; its rejected settle is fenced the same way. ----
  {
    const j = intervalJob('a1', 'every 60m');
    const s = setup([j]);
    s.clock.set(T0 + 3600000);
    s.driver.applyTick(s.clock.now());
    const run1 = s.runs[0];
    A.eq(run1.opts.signal.aborted, false, 'run-1 not aborted while live');
    s.clock.set(T0 + 3600000 + 480001);
    s.driver.applyTick(s.clock.now());
    A.eq(run1.opts.signal.aborted, true, 'the sweep aborted the zombie run');
    run1.reject(new Error('aborted')); await flush();
    A.eq(s.getJob('a1').lastRunId, null, 'a reclaimed run\'s rejection never writes the job record');
    A.eq(s.getJob('a1').lastStatus, null, 'no phantom error status from a fenced settle');
  }

  A.report('cron.dispatch');
})().catch(e => { console.error(e); process.exit(1); });
