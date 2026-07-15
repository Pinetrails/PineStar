/* node test/cron-store.test.js — the PURE cron-job lifecycle reducer (CRON Commit 2).
   Proves create/update/pause/resume/markRun/remove are pure (input never mutated), deterministic, and
   injected-clock, and that the load-bearing run-lifecycle invariants hold: advance-before-run is not
   clobbered by markRun, one-shots finalize once, transient failures back off (bounded) without losing
   the occurrence, recurring errors stay enabled, finite repeats exhaust, and the store load is fail-closed.
   Driven by makeClock — no wall-clock read — exactly like cron / loop.replay / permissions. */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const store = require('../sidecar/cron-store.js');

const T0 = 1700000000000;
const HOUR = 3600000, MIN = 60000;
const iso = cron._internals.iso;

// ---- 1. createJob: normalize an interval job, compute the initial fire, default the record ----
{
  const jobs = store.createJob([], {
    id: 'j1', name: 'hourly', prompt: 'do the thing',
    schedule: cron.parseSchedule('every 1h', T0), agentId: 'cron_j1'
  }, { now: T0 });
  A.eq(jobs.length, 1, 'createJob appends one job');
  const j = jobs[0];
  A.eq(j.id, 'j1', 'id carried through');
  A.eq(j.enabled, true, 'default enabled');
  A.eq(j.state, 'scheduled', 'enabled -> state scheduled');
  A.eq(j.deliver, 'local', 'default deliver = local');
  A.eq(j.model, null, 'default model null (host default)');
  A.eq(j.repeat.times, null, 'interval -> forever (times null)');
  A.eq(j.repeat.completed, 0, 'completed starts at 0');
  A.eq(j.retryCount, 0, 'retryCount starts at 0');
  A.eq(j.nextRunAt, iso(T0 + HOUR), 'interval nextRunAt = now + period');
  A.eq(j.createdAt, iso(T0), 'createdAt = now');
  A.eq(j.lastRunAt, null, 'no last run yet');
}

// ---- 2. createJob: a one-shot is times:1 and arms at its runAt ----
{
  const sched = cron.parseSchedule('in 2h', T0);
  const jobs = store.createJob([], { id: 'once1', schedule: sched }, { now: T0 });
  A.eq(jobs[0].repeat.times, 1, 'one-shot -> times 1');
  A.eq(jobs[0].nextRunAt, iso(T0 + 2 * HOUR), 'one-shot arms at its runAt');
}

// ---- 2b. createJob: a cron job is recurring and arms at its next matching minute ----
{
  const base = Date.parse('2026-06-19T08:58:00Z');
  const sched = cron.parseSchedule('0 9 * * *', base);
  const jobs = store.createJob([], { id: 'cron1', schedule: sched }, { now: base });
  A.eq(jobs[0].repeat.times, null, 'cron -> forever by default');
  A.eq(jobs[0].nextRunAt, iso(Date.parse('2026-06-19T09:00:00Z')), 'cron arms at its next matching time');
}

// ---- 3. createJob: invalid + duplicate ids are rejected; disabled spec -> paused ----
{
  A.throws(() => store.createJob([], { id: 'bad id!', schedule: null }, { now: T0 }), 'invalid id rejected');
  A.throws(() => store.createJob([], { schedule: null }, { now: T0 }), 'missing id rejected');
  const jobs = store.createJob([], { id: 'dup', schedule: null }, { now: T0 });
  A.throws(() => store.createJob(jobs, { id: 'dup', schedule: null }, { now: T0 }), 'duplicate id rejected');
  const paused = store.createJob([], { id: 'p1', enabled: false, schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  A.eq(paused[0].state, 'paused', 'enabled:false -> paused');
  A.eq(paused[0].nextRunAt, null, 'a paused job is not armed');
}

// ---- 4. createJob does NOT mutate the input array (purity) ----
{
  const before = [];
  const after = store.createJob(before, { id: 'x', schedule: null }, { now: T0 });
  A.eq(before.length, 0, 'input array untouched');
  A.ok(after !== before, 'returns a new array');
}

// ---- 5. updateJob: patch editable fields; id immutable; schedule change re-anchors nextRunAt ----
{
  let jobs = store.createJob([], { id: 'u1', name: 'old', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  jobs = store.updateJob(jobs, 'u1', { name: 'new', id: 'hacked' }, { now: T0 });
  A.eq(store.getJob(jobs, 'u1').name, 'new', 'name patched');
  A.eq(store.getJob(jobs, 'hacked'), null, 'id is immutable (patch.id ignored)');

  const now2 = T0 + 10 * MIN;
  jobs = store.updateJob(jobs, 'u1', { schedule: cron.parseSchedule('every 30m', now2) }, { now: now2 });
  A.eq(store.getJob(jobs, 'u1').schedule.minutes, 30, 'schedule replaced');
  A.eq(store.getJob(jobs, 'u1').nextRunAt, iso(now2 + 30 * MIN), 'schedule change re-anchors nextRunAt at now');
}

// ---- 6. pause / resume: resume re-anchors the next fire at now ----
{
  let jobs = store.createJob([], { id: 'pr', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  jobs = store.pauseJob(jobs, 'pr');
  A.eq(store.getJob(jobs, 'pr').enabled, false, 'paused -> disabled');
  A.eq(store.getJob(jobs, 'pr').state, 'paused', 'paused -> state paused');
  const later = T0 + 5 * HOUR;
  jobs = store.resumeJob(jobs, 'pr', { now: later });
  A.eq(store.getJob(jobs, 'pr').enabled, true, 'resumed -> enabled');
  A.eq(store.getJob(jobs, 'pr').nextRunAt, iso(later + HOUR), 'resume re-anchors nextRunAt at now + period');
}

// ---- 7. markRun success on a recurring job: stamps last-run, increments completed, LEAVES nextRunAt ----
{
  // simulate the host having advanced nextRunAt before launch (advance-before-run)
  let jobs = store.createJob([], { id: 'm1', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  const advanced = iso(T0 + 2 * HOUR);
  jobs = store.updateJob(jobs, 'm1', {}, { now: T0 });          // no-op patch
  jobs = jobs.map(j => j.id === 'm1' ? Object.assign({}, j, { nextRunAt: advanced }) : j);
  const runAt = T0 + HOUR;
  jobs = store.markRun(jobs, 'm1', { runId: 'r1', status: 'ok', reason: 'done' }, { now: runAt });
  const j = store.getJob(jobs, 'm1');
  A.eq(j.lastRunAt, iso(runAt), 'lastRunAt stamped at now');
  A.eq(j.lastStatus, 'ok', 'lastStatus ok');
  A.eq(j.lastReason, 'done', 'lastReason carried');
  A.eq(j.lastRunId, 'r1', 'lastRunId carried');
  A.eq(j.repeat.completed, 1, 'completed incremented');
  A.eq(j.nextRunAt, advanced, 'success does NOT clobber the pre-advanced nextRunAt (advance-before-run honored)');
  A.eq(j.state, 'scheduled', 'recurring success stays scheduled');
}

// ---- 8. markRun on a one-shot: finalize once (disabled, completed, no next) ----
{
  let jobs = store.createJob([], { id: 'os', schedule: cron.parseSchedule('in 1h', T0) }, { now: T0 });
  jobs = store.markRun(jobs, 'os', { runId: 'r', status: 'ok', reason: 'done' }, { now: T0 + HOUR });
  const j = store.getJob(jobs, 'os');
  A.eq(j.enabled, false, 'one-shot disabled after running');
  A.eq(j.state, 'completed', 'one-shot -> completed');
  A.eq(j.nextRunAt, null, 'one-shot has no next fire');
  A.eq(j.repeat.completed, 1, 'one-shot completed count = 1');
}

// ---- 9. markRun transient failure: back off, stay eligible, do NOT consume the occurrence ----
{
  let jobs = store.createJob([], { id: 't1', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  const failAt = T0 + HOUR;
  jobs = store.markRun(jobs, 't1', { runId: 'r', status: 'error', error: 'network', transient: true },
    { now: failAt, backoffMs: 90000 });
  const j = store.getJob(jobs, 't1');
  A.eq(j.retryCount, 1, 'transient failure increments retryCount');
  A.eq(j.lastRunAt, null, 'transient failure does NOT stamp lastRunAt (occurrence not consumed)');
  A.eq(j.repeat.completed, 0, 'transient failure does NOT increment completed');
  A.eq(j.nextRunAt, iso(failAt + 90000), 'transient failure backs off to now + backoff');
  A.eq(j.state, 'error', 'transient failure is visible as error (still scheduled)');
}

// ---- 10. transient retries are BOUNDED: after maxRetries it finalizes ----
{
  let jobs = store.createJob([], { id: 't2', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  // simulate retryCount already at the cap
  jobs = jobs.map(j => j.id === 't2' ? Object.assign({}, j, { retryCount: 3 }) : j);
  jobs = store.markRun(jobs, 't2', { status: 'error', error: 'network', transient: true }, { now: T0 + HOUR, maxRetries: 3 });
  const j = store.getJob(jobs, 't2');
  A.eq(j.lastRunAt, iso(T0 + HOUR), 'retries exhausted -> occurrence finalized (lastRunAt stamped)');
  A.eq(j.retryCount, 0, 'retryCount reset after finalize');
  A.eq(j.enabled, true, 'recurring job stays enabled after a finalized error');
  A.eq(j.state, 'error', 'finalized error is visible');
}

// ---- 11. permanent error on a recurring job: stays enabled, re-armed, state error ----
{
  let jobs = store.createJob([], { id: 'pe', schedule: cron.parseSchedule('every 1h', T0) }, { now: T0 });
  const failAt = T0 + HOUR;
  jobs = store.markRun(jobs, 'pe', { status: 'error', error: 'bad model', transient: false }, { now: failAt });
  const j = store.getJob(jobs, 'pe');
  A.eq(j.enabled, true, 'recurring permanent-error job is NEVER silently disabled');
  A.eq(j.state, 'error', 'state reflects the error');
  A.eq(j.nextRunAt, iso(failAt + HOUR), 'permanent error re-arms one period out');
  A.eq(j.repeat.completed, 1, 'permanent error consumes the occurrence');
}

// ---- 12. finite-repeat interval exhaustion: completes after `times` runs ----
{
  let jobs = store.createJob([], { id: 'fin', schedule: cron.parseSchedule('every 1h', T0), repeat: { times: 2 } }, { now: T0 });
  A.eq(jobs[0].repeat.times, 2, 'finite times honored on create');
  jobs = store.markRun(jobs, 'fin', { status: 'ok', reason: 'done' }, { now: T0 + HOUR });
  A.eq(store.getJob(jobs, 'fin').enabled, true, 'still running after 1/2');
  jobs = store.markRun(jobs, 'fin', { status: 'ok', reason: 'done' }, { now: T0 + 2 * HOUR });
  const j = store.getJob(jobs, 'fin');
  A.eq(j.repeat.completed, 2, '2 of 2 completed');
  A.eq(j.enabled, false, 'finite repeat exhausted -> disabled');
  A.eq(j.state, 'completed', 'finite repeat exhausted -> completed');
}

// ---- 13. removeJob ----
{
  let jobs = store.createJob([], { id: 'rm', schedule: null }, { now: T0 });
  jobs = store.createJob(jobs, { id: 'keep', schedule: null }, { now: T0 });
  jobs = store.removeJob(jobs, 'rm');
  A.eq(jobs.length, 1, 'removeJob deletes one');
  A.eq(jobs[0].id, 'keep', 'the other job survives');
}

// ---- 14. loadEnvelope: fail-closed + drops malformed records + parses a string ----
{
  A.eq(store.loadEnvelope(null), { version: 1, jobs: [] }, 'null -> empty store (fail-closed)');
  A.eq(store.loadEnvelope('not json'), { version: 1, jobs: [] }, 'garbage string -> empty store');
  A.eq(store.loadEnvelope({ jobs: 'nope' }), { version: 1, jobs: [] }, 'jobs not an array -> empty store');
  const env = store.loadEnvelope({ version: 1, jobs: [{ id: 'good' }, { id: 'bad id!' }, null, { noId: true }] });
  A.eq(env.jobs.length, 1, 'malformed job records dropped');
  A.eq(env.jobs[0].id, 'good', 'the valid record survives');
  const parsed = store.loadEnvelope(JSON.stringify({ version: 1, jobs: [{ id: 'fromstring' }] }));
  A.eq(parsed.jobs[0].id, 'fromstring', 'a JSON string is parsed');
}

// ---- 15. END-TO-END with planTick: create -> plan fires -> apply advance -> markRun -> no double-fire ----
{
  const c = makeClock(T0);
  let jobs = store.createJob([], { id: 'e2e', schedule: cron.parseSchedule('every 1h', c.now()) }, { now: c.now() });
  A.eq(cron.planTick(jobs, c.now()).fire.length, 0, 'not due at t0');
  c.advance(HOUR);
  const plan = cron.planTick(jobs, c.now());
  A.eq(plan.fire.length, 1, 'due after one period -> fires');
  // host applies the advance BEFORE launching (advance-before-run)
  jobs = jobs.map(j => j.id === 'e2e' ? Object.assign({}, j, { nextRunAt: iso(plan.next[0].nextAt) }) : j);
  A.eq(cron.planTick(jobs, c.now()).fire.length, 0, 'after advance, the same instant does not double-fire');
  // run completes -> markRun (success leaves the advanced nextRunAt)
  jobs = store.markRun(jobs, 'e2e', { runId: 'r', status: 'ok', reason: 'done' }, { now: c.now() });
  A.eq(store.getJob(jobs, 'e2e').nextRunAt, iso(plan.next[0].nextAt), 'markRun preserves the advanced next-fire');
  c.advance(HOUR);
  A.eq(cron.planTick(jobs, c.now()).fire.length, 1, 'fires again at the next period');
}

// ---- 16. R3 provenance: meta.recipeId round-trips through create -> update -> markRun -> envelope ----
{
  // create with a meta bag: it is normalized to a plain object and carried on the record.
  let jobs = store.createJob([], {
    id: 'prov1', name: 'from a recipe', schedule: cron.parseSchedule('0 9 * * *', Date.parse('2026-06-19T08:00:00Z')),
    meta: { recipeId: 'morning-brief', extra: 'kept' }
  }, { now: Date.parse('2026-06-19T08:00:00Z') });
  A.eq(store.getJob(jobs, 'prov1').meta.recipeId, 'morning-brief', 'meta.recipeId is carried onto the created job');
  A.eq(store.getJob(jobs, 'prov1').meta.extra, 'kept', 'other meta keys are preserved (shallow clone)');

  // a job with NO meta loads as null (never breaks an existing/pre-R3 job).
  const noMeta = store.createJob([], { id: 'nom', schedule: null }, { now: T0 });
  A.eq(store.getJob(noMeta, 'nom').meta, null, 'a job with no meta -> meta:null (tolerated absence)');

  // garbage meta is rejected to null (not an object / an array / empty).
  A.eq(store.makeJob({ id: 'g1', meta: 'nope' }, { now: T0 }).meta, null, 'a string meta -> null');
  A.eq(store.makeJob({ id: 'g2', meta: [1, 2] }, { now: T0 }).meta, null, 'an array meta -> null');
  A.eq(store.makeJob({ id: 'g3', meta: {} }, { now: T0 }).meta, null, 'an empty meta object -> null');

  // meta survives an editable-field update (updateJob copies the record; meta is not an editable field but persists).
  jobs = store.updateJob(jobs, 'prov1', { name: 'renamed' }, { now: T0 });
  A.eq(store.getJob(jobs, 'prov1').meta.recipeId, 'morning-brief', 'meta survives an updateJob (name edit)');

  // meta survives a markRun settlement.
  jobs = store.markRun(jobs, 'prov1', { runId: 'r', status: 'ok', reason: 'done' }, { now: Date.parse('2026-06-19T09:00:00Z') });
  A.eq(store.getJob(jobs, 'prov1').meta.recipeId, 'morning-brief', 'meta survives a markRun');

  // meta survives a persist round-trip (toEnvelope -> JSON -> loadEnvelope).
  const round = store.loadEnvelope(JSON.parse(JSON.stringify(store.toEnvelope(jobs))));
  const back = round.jobs.find(j => j.id === 'prov1');
  A.eq(back.meta.recipeId, 'morning-brief', 'meta.recipeId round-trips through the persistence envelope');

  // a legacy record with a meta field already on disk loads intact (loadEnvelope keeps well-formed rows verbatim).
  const legacy = store.loadEnvelope({ version: 1, jobs: [{ id: 'legacy', meta: { recipeId: 'x' } }] });
  A.eq(legacy.jobs[0].meta.recipeId, 'x', 'an on-disk record carrying meta loads intact');
}

// ---- MISFIRE + DELIVERY OUTCOME (2026-07-15 reliability audit) ----
{
  const T = 1700000000000;
  const mk = (spec) => store.makeJob(Object.assign({ id: 'm1', prompt: 'p', schedule: { kind: 'interval', minutes: 60, display: 'every 1h' } }, spec || {}), { id: 'm1', now: T });

  // misfire normalizes at creation: valid values kept, garbage -> null (schedule-derived default at plan time).
  A.eq(mk().misfire, null, 'misfire defaults to null (derive from the schedule)');
  A.eq(mk({ misfire: 'fire_once' }).misfire, 'fire_once', 'misfire fire_once persists');
  A.eq(mk({ misfire: 'skip' }).misfire, 'skip', 'misfire skip persists');
  A.eq(mk({ misfire: 'bogus' }).misfire, null, 'an unknown misfire value can never persist');

  // misfire is editable and re-normalized on update.
  let jobs = [mk()];
  jobs = store.updateJob(jobs, 'm1', { misfire: 'fire_once' }, { now: T });
  A.eq(store.getJob(jobs, 'm1').misfire, 'fire_once', 'updateJob sets misfire');
  jobs = store.updateJob(jobs, 'm1', { misfire: 'whatever' }, { now: T });
  A.eq(store.getJob(jobs, 'm1').misfire, null, 'updateJob normalizes a bogus misfire to null');

  // markDelivery records the last notification attempt separately from the run outcome.
  A.eq(store.getJob(jobs, 'm1').lastDeliveryOk, null, 'fresh job has no delivery record');
  jobs = store.markDelivery(jobs, 'm1', { ok: true, channel: 'telegram' }, { now: T + 1000 });
  let j = store.getJob(jobs, 'm1');
  A.eq([j.lastDeliveryOk, j.lastDeliveryError], [true, null], 'a delivered ping records ok with no error');
  A.ok(j.lastDeliveryAt, 'delivery timestamp stamped');
  jobs = store.markDelivery(jobs, 'm1', { ok: false, error: 'rate limited', channel: 'discord' }, { now: T + 2000 });
  j = store.getJob(jobs, 'm1');
  A.eq(j.lastDeliveryOk, false, 'a failed ping records ok:false');
  A.ok(/rate limited/.test(j.lastDeliveryError) && /discord/.test(j.lastDeliveryError), 'the failure carries the error + channel');
  A.eq(store.markDelivery(jobs, 'nope', { ok: true }, { now: T }), jobs.map(x => x), 'markDelivery on an absent job is a no-op');
}

A.report('cron-store');
