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
    contextFor: opts.contextFor,
    deliverResult: opts.deliverResult,
    afterFinalizationCommitted: opts.afterFinalizationCommitted,
    maxRunMs: 480000
  });
  return {
    driver, clock, events, runs,
    getJob: (id) => cronStore.getJob(store, id), getStore: () => store.slice(),
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

  // ---- 4. DATA PLANE: upstream context reaches the model and completion gets the final reply once. ----
  {
    const delivered = [];
    const j = intervalJob('d1', 'every 1m');
    j.contextFrom = ['source']; j.skills = ['Research']; j.workdir = 'C:\\approved-project'; j.enabledToolsets = ['web'];
    const s = setup([j], { contextFor: () => '<untrusted_routine_context>prior result</untrusted_routine_context>', deliverResult: (job, result) => delivered.push({ job, result }) });
    s.clock.set(T0 + 60000); s.driver.applyTick(s.clock.now());
    A.ok(s.runs[0].opts.messages[0].content.includes('prior result'), 'assembled upstream context reaches the scheduled run');
    A.eq(s.runs[0].opts.preloadSkills, ['Research'], 'scheduled skills reach the guarded runtime preload seam');
    A.eq(s.runs[0].opts.workdir, 'C:\\approved-project', 'scheduled project cwd reaches the run host');
    A.eq(s.runs[0].opts.enabledToolsets, ['web'], 'per-job toolset intersection reaches the run host');
    A.eq(s.runs[0].opts.initialTaint, true, 'upstream context structurally taints the unattended run');
    A.eq(s.runs[0].opts.cronJobId, 'd1', 'scheduled run carries its host-minted routine id into recovery metadata');
    A.eq(s.runs[0].opts.cronJobName, j.name, 'scheduled run carries its routine name into recovery metadata');
    s.runs[0].opts.emit('agent.token', { delta: 'final answer' });
    s.runs[0].resolve(); await flush(); await flush();
    A.eq(s.getJob('d1').lastOutput, 'final answer', 'final reply is persisted for downstream context');
    A.eq(delivered.length, 1, 'completion delivery hook runs exactly once');
    A.eq(delivered[0].result.text, 'final answer', 'delivery receives the actual final result text');
  }

  // ---- 5. FINALIZATION RESTART: receipt commits before delivery and replays without rerunning work. ----
  {
    const j = intervalJob('r1', 'every 1m');
    j.deliver = 'origin'; j.origin = { target: 'telegram:original', channel: 'telegram', chatId: 'original' };
    const first = setup([j], { afterFinalizationCommitted: () => false, deliverResult: () => { throw new Error('must not deliver before crash'); } });
    first.clock.set(T0 + 60000); first.driver.applyTick(first.clock.now());
    first.runs[0].opts.emit('agent.token', { delta: 'restart-safe answer' });
    first.runs[0].opts.emit('agent.run.end', { reason: 'done', usd: 0.41 });
    first.runs[0].resolve(); await flush(); await flush();
    const pending = first.getJob('r1');
    A.eq(pending.finalization.state, 'pending', 'result receipt is durable before destination delivery');
    const delivered = [];
    const second = setup(first.getStore(), { deliverResult: (job, result) => { delivered.push({ job, result }); return { ok: true }; } });
    const recovered = await second.driver.recoverFinalizations();
    A.eq(recovered, 1, 'restart reconciles one pending routine receipt');
    A.eq(second.runs.length, 0, 'recovery does not rerun the paid routine');
    A.eq(delivered.length, 1, 'recovery delivers one logical result');
    A.eq({ text: delivered[0].result.text, usd: second.getJob('r1').lastUsd, destination: delivered[0].job.origin.target },
      { text: 'restart-safe answer', usd: 0.41, destination: 'telegram:original' }, 'result, one cost record, and original destination survive together');
    A.eq(second.getJob('r1').finalization.state, 'delivered', 'successful recovery durably closes the receipt');
  }

  A.report('cron.dispatch');
})().catch(e => { console.error(e); process.exit(1); });
