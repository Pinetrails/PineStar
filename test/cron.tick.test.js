/* node test/cron.tick.test.js — the autonomous TICK DRIVER (CRON Commit 4b).

   Proves the index.js-owned scheduler pass is correct with every ambient dep FAKED (fake clock, fake runOnce,
   capturing emit, in-memory store) — no http server, no real timer, no wall-clock read. Asserts the load-bearing
   safety properties from docs/CRON_INTEGRATION_PLAN.md §3.3/§4b:
     · a due job fires exactly once, surface:'autonomous' + trigger:'schedule' (the unattended-consent keystone)
     · nextRunAt is ADVANCED before the run is launched (at-most-once across a crash) — lastRunAt only on completion
     · cron.fire carries the launched run's runId; the war-room pulse (cron.tick) is silent on an idle/empty tick
     · one-run-per-job: a still-leased job is skipped (cron.skipped{already-running}), the occurrence advanced
     · the SELF-HEALING lease: a run that never ends is reclaimed+aborted after the ceiling (stale-lock-reclaimed)
     · BOOT RESUME: a recurring job whose nextRunAt elapsed while down fires ONE catch-up within grace, else
       fast-forwards+skips (caught-up) — never a backlog burst
     · a throwing run records lastStatus:'error' and does not stop the next job from firing
     · no provider credentials/model -> cron.skipped{no-capability}; OAuth-backed providers do not need a BYOK key
     · the [SILENT] no-spam check is strict-equals-after-trim (an embedded [SILENT] does NOT suppress) */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
require('./cron.run-now.test.js');

const T0 = 1700000000000;
const flush = () => new Promise(r => setImmediate(r));   // let the launch->finishFire promise chain settle

// build a store + driver with controllable fakes. runOnce: a fn(opts)->Promise that may use opts.emit to
// simulate the run's events. Returns { driver, store getters, captured runs/events, clock }.
function setup(jobs, runOnceFake, opts) {
  opts = opts || {};
  const clock = makeClock(opts.t0 || T0);
  let store = (jobs || []).slice();
  const events = [];        // every cron.*/forwarded event the driver emitted
  const runs = [];          // every runOnce opts object the driver passed
  const placed = [];        // every placeWorkitem(agentId,prompt,runId) — the conveyor box a fire rides onto the floor
  let idN = 0;
  const driver = makeCronDriver({
    getJobs: () => store,
    setJobs: (j) => { store = j; },
    runOnce: (o) => { runs.push(o); return Promise.resolve(runOnceFake ? runOnceFake(o) : undefined); },
    emit: (name, payload) => { events.push({ name, payload }); },
    placeWorkitem: (agentId, prompt, runId) => { placed.push({ agentId, prompt, runId }); },
    newId: () => 'run-' + (++idN),
    newAbort: () => new AbortController(),
    now: () => clock.now(),
    getKey: () => (opts.key !== undefined ? opts.key : 'sk-test'),
    providerForJob: opts.providerForJob,
    hasCredential: opts.hasCredential,
    defaultModel: opts.defaultModel !== undefined ? opts.defaultModel : 'test/model',
    identityForAgent: opts.identityForAgent,
    persona: 'PERSONA',
    maxRunMs: opts.maxRunMs || 480000,
    maxParallel: opts.maxParallel        // G4.4: undefined -> driver default (4); a number caps in-flight fires
  });
  return { driver, clock, events, runs, placed, getJobs: () => store, getJob: (id) => cronStore.getJob(store, id) };
}

const evNames = (events) => events.map(e => e.name);
const firstOf = (events, name) => (events.find(e => e.name === name) || {}).payload;
const countOf = (events, name) => events.filter(e => e.name === name).length;

// an interval job armed at T0 (nextRunAt = T0 + period); due once the clock reaches that.
function intervalJob(id, everyStr) {
  const schedule = cron.parseSchedule(everyStr, T0);
  return cronStore.makeJob({ id, prompt: 'do ' + id, agentId: 'cron_' + id, schedule }, { id, now: T0 });
}
function onceJob(id, inStr) {
  const schedule = cron.parseSchedule(inStr, T0);
  return cronStore.makeJob({ id, prompt: 'do ' + id, agentId: 'cron_' + id, schedule }, { id, now: T0 });
}
function cronJob(id, expr, base) {
  const schedule = cron.parseSchedule(expr, base);
  return cronStore.makeJob({ id, prompt: 'do ' + id, agentId: 'cron_' + id, schedule }, { id, now: base });
}

// a runOnce fake that emits a normal short reply then ends 'done'.
const okRun = (text) => (o) => { o.emit('agent.run.start', { agentId: 'a', runId: o.runId, trigger: o.trigger, model: o.model }); o.emit('agent.token', { delta: text == null ? 'all good' : text }); o.emit('agent.run.end', { agentId: 'a', runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };

(async function () {

  // ---- 1. a due job fires exactly once; surface:'autonomous' + trigger:'schedule'; cron.fire carries the runId ----
  {
    const j = intervalJob('j1', 'every 1m');                  // armed nextRunAt = T0 + 60000
    const s = setup([j], okRun());
    s.clock.set(T0 + 60000);                                  // now the interval is due
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary, { fired: 1, skipped: 0, planned: 1, deferred: [] }, 'one job planned + fired (nothing deferred)');
    A.eq(s.runs.length, 1, 'runOnce called exactly once');
    A.eq(s.runs[0].surface, 'autonomous', 'fire passes surface:autonomous (the unattended-consent keystone)');
    A.eq(s.runs[0].trigger, 'schedule', 'fire passes trigger:schedule');
    A.eq(s.runs[0].isTask, true, 'a scheduled run is a task');
    A.eq(s.runs[0].agentId, 'cron_j1', 'fire runs as the job agent');
    const fire = firstOf(s.events, 'cron.fire');
    A.eq(fire.jobId, 'j1', 'cron.fire jobId');
    A.eq(fire.runId, s.runs[0].runId, 'cron.fire runId == the launched run');
    await flush();
    A.eq(countOf(s.events, 'cron.result'), 1, 'one cron.result after it settles');
    A.eq(firstOf(s.events, 'cron.result').outcome, 'ok', 'a normal reply -> outcome ok');
  }

  // ---- 1b. a due cron job fires through the same autonomous path and advances to its next cron time ----
  {
    const base = Date.parse('2026-06-19T08:58:00Z');
    const due = Date.parse('2026-06-19T09:00:00Z');
    const j = cronJob('cj1', '0 9 * * *', base);
    const s = setup([j], okRun(), { t0: base });
    s.clock.set(due);
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary, { fired: 1, skipped: 0, planned: 1, deferred: [] }, 'one cron job planned + fired (nothing deferred)');
    A.eq(s.runs[0].agentId, 'cron_cj1', 'cron fire runs as the job agent');
    A.eq(s.getJob('cj1').nextRunAt, cron._internals.iso(Date.parse('2026-06-20T09:00:00Z')), 'cron nextRunAt advanced before launch');
  }

  // ---- 2. advance-before-run: nextRunAt is advanced BEFORE launch; lastRunAt only after completion ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun());
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                        // run launched but NOT yet settled
    const mid = s.getJob('j1');
    A.eq(mid.nextRunAt, cron._internals.iso(T0 + 60000 + 60000), 'nextRunAt advanced one period BEFORE the run settles');
    A.eq(mid.lastRunAt, null, 'lastRunAt still null until completion (at-most-once on crash)');
    await flush();
    A.ok(s.getJob('j1').lastRunAt != null, 'lastRunAt stamped after completion');
    A.eq(s.getJob('j1').lastStatus, 'ok', 'lastStatus ok after a clean run');
  }

  // ---- 3. one-run-per-job: a still-leased job is skipped on the next due tick (occurrence still advanced) ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], () => new Promise(() => {}));        // runOnce that NEVER settles -> lease stays held
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                        // fires; lease held
    A.eq(s.driver.leases.size, 1, 'lease held for the in-flight run');
    s.clock.set(T0 + 120000);                                 // its (advanced) nextRunAt is now due again
    s.driver.applyTick(s.clock.now());
    A.eq(countOf(s.events, 'cron.skipped'), 1, 'second tick skipped the still-running job');
    A.eq(firstOf(s.events, 'cron.skipped').reason, 'already-running', 'skip reason already-running');
    A.eq(s.runs.length, 1, 'runOnce was NOT called a second time');
    A.eq(s.getJob('j1').nextRunAt, cron._internals.iso(T0 + 180000), 'the skipped occurrence still advanced (no re-queue)');
  }

  // ---- 4. self-healing lease: a run that never ends is reclaimed + aborted after the ceiling ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], () => new Promise(() => {}), { maxRunMs: 100000 });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());                        // fires at T0+60000, lease.startedAt = T0+60000
    const ac = s.runs[0].signal;
    A.eq(ac.aborted, false, 'run not aborted yet');
    s.clock.set(T0 + 60000 + 100001);                         // older than maxRunMs
    s.driver.applyTick(s.clock.now());
    A.eq(ac.aborted, true, 'the zombie run was aborted by the lease sweep');
    A.ok(s.events.some(e => e.name === 'cron.skipped' && e.payload.reason === 'stale-lock-reclaimed'), 'emitted stale-lock-reclaimed');
    // self-heal: once the zombie's lease is reclaimed the (still-due) job becomes eligible and re-fires that tick.
    A.eq(s.runs.length, 2, 'after reclaim the freed job re-fired (no longer wedged)');
    A.ok(s.driver.leases.size === 1 && s.driver.leases.get('j1').runId === s.runs[1].runId, 'a fresh lease tracks the new run');
  }

  // ---- 5. BOOT RESUME (within grace): a recurring job whose nextRunAt elapsed while down fires ONE catch-up ----
  {
    // 10m interval => grace = clamp(period/2)=300000 (5m). Persist nextRunAt in the past, then "restart".
    const j = intervalJob('j1', 'every 10m');
    j.nextRunAt = cron._internals.iso(T0);                    // elapsed while the host was down
    j.lastRunAt = null;
    const s = setup([j], okRun(), { t0: T0 });
    s.clock.set(T0 + 200000);                                 // 200s late < grace(300s) -> fire one catch-up
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 1, 'resume fires exactly one catch-up within grace');
    A.eq(countOf(s.events, 'cron.fire'), 1, 'exactly one cron.fire (no backlog)');
  }

  // ---- 6. BOOT RESUME (beyond grace): a long-down job fast-forwards + skips, never a backlog burst ----
  {
    const j = intervalJob('j1', 'every 10m');                 // period 600000
    j.nextRunAt = cron._internals.iso(T0);
    j.lastRunAt = null;
    const s = setup([j], okRun(), { t0: T0 });
    s.clock.set(T0 + 5000000);                                // ~83min late >> grace -> fast-forward, do NOT fire
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 0, 'beyond grace: nothing fires (no backlog burst)');
    A.eq(firstOf(s.events, 'cron.skipped').reason, 'caught-up', 'fast-forward emits caught-up');
    A.ok(Date.parse(s.getJob('j1').nextRunAt) > s.clock.now(), 'nextRunAt fast-forwarded to a FUTURE occurrence');
  }

  // ---- 7. a throwing run records lastStatus:error and does NOT stop the next job from firing ----
  {
    const a = intervalJob('ja', 'every 1m');
    const b = intervalJob('jb', 'every 1m');
    const s = setup([a, b], (o) => { if (o.agentId === 'cron_ja') throw new Error('boom'); return okRun()(o); });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 2, 'both due jobs were launched (a throw in one does not block the other)');
    await flush();
    A.eq(s.getJob('ja').lastStatus, 'error', 'the throwing job recorded lastStatus error');
    A.eq(s.getJob('jb').lastStatus, 'ok', 'the other job still completed ok');
    A.ok(s.events.some(e => e.name === 'cron.result' && e.payload.jobId === 'ja' && e.payload.outcome === 'failed'), 'failed outcome for the throwing job');
  }

  // ---- 8. no key/model -> cron.skipped{no-capability}; runOnce is never called ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun(), { key: '' });               // no BYOK key configured
    s.clock.set(T0 + 60000);
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 0, 'nothing fires without a key');
    A.eq(s.runs.length, 0, 'runOnce not called');
    A.eq(firstOf(s.events, 'cron.skipped').reason, 'no-capability', 'skip reason no-capability');
  }

  // ---- 8b. OAuth-backed providers launch without a BYOK key ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun(), {
      key: '',
      defaultModel: 'gpt-5.3-codex',
      providerForJob: () => 'codex',
      hasCredential: (provider) => provider === 'codex'
    });
    s.clock.set(T0 + 60000);
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary, { fired: 1, skipped: 0, planned: 1, deferred: [] }, 'codex oauth cron fires without an OpenRouter key');
    A.eq(s.runs[0].provider, 'codex', 'cron passes the inherited provider to runOnce');
    A.eq(s.runs[0].key, '', 'codex cron does not fabricate a BYOK key');
  }

  // ---- 9. the [SILENT] no-spam check is strict-equals-after-trim ----
  {
    // a bare "[SILENT]" suppresses (outcome silent); an embedded one does NOT (outcome ok).
    const silent = setup([onceJob('s1', 'in 1m')], (o) => { o.emit('agent.token', { delta: '  [SILENT]  ' }); o.emit('agent.run.end', { agentId: 'a', runId: o.runId, reason: 'done', turns: 1, usd: 0 }); });
    silent.clock.set(T0 + 60000);
    silent.driver.applyTick(silent.clock.now());
    await flush();
    A.eq(firstOf(silent.events, 'cron.result').outcome, 'silent', 'bare [SILENT] -> outcome silent (delivery suppressed)');

    const embedded = setup([onceJob('s2', 'in 1m')], (o) => { o.emit('agent.token', { delta: 'Report: nothing urgent. [SILENT] markers were considered.' }); o.emit('agent.run.end', { agentId: 'a', runId: o.runId, reason: 'done', turns: 1, usd: 0 }); });
    embedded.clock.set(T0 + 60000);
    embedded.driver.applyTick(embedded.clock.now());
    await flush();
    A.eq(firstOf(embedded.events, 'cron.result').outcome, 'ok', 'an embedded [SILENT] does NOT suppress (strict-equals divergence)');
  }

  // ---- 10. the no-op invariant: an empty/idle tick fires nothing and emits NOTHING (no heartbeat spam) ----
  {
    const empty = setup([], okRun());
    const summary = empty.driver.applyTick(empty.clock.now());
    A.eq(summary, { fired: 0, skipped: 0, planned: 0, deferred: [] }, 'empty store -> a pure no-op');
    A.eq(empty.events.length, 0, 'an idle tick emits no events (no cron.tick heartbeat)');

    // a not-yet-due job is also a silent no-op (nextRunAt in the future).
    const future = setup([intervalJob('j1', 'every 1m')], okRun());   // armed at T0+60000, clock still T0
    const sum2 = future.driver.applyTick(future.clock.now());
    A.eq(sum2.planned, 0, 'nothing due yet -> nothing planned');
    A.eq(future.events.length, 0, 'a not-yet-due tick is silent too');
  }

  // ---- 11. a one-shot finalizes (enabled:false, completed) after it fires + settles ----
  {
    const s = setup([onceJob('o1', 'in 1m')], okRun());
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    await flush();
    const job = s.getJob('o1');
    A.eq(job.enabled, false, 'one-shot disabled after firing');
    A.eq(job.state, 'completed', 'one-shot state completed');
    A.eq(job.nextRunAt, null, 'one-shot has no next fire');
  }

  // ---- 12. cron.tick pulse is emitted (with real counts) WHEN something happens ----
  {
    const s = setup([intervalJob('j1', 'every 1m')], okRun());
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    const tick = firstOf(s.events, 'cron.tick');
    A.ok(tick != null, 'cron.tick emitted on an active tick');
    A.eq(tick, { fired: 1, skipped: 0, planned: 1 }, 'cron.tick carries the real counts');
  }

  // ---- 13. selected-agent identity: roster system/model are used when the job has no explicit model ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun(), {
      defaultModel: 'fallback/model',
      identityForAgent: (agentId) => agentId === 'cron_j1' ? { system: 'ROSTER SYSTEM', model: 'roster/model' } : null
    });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs[0].model, 'roster/model', 'cron fire uses the selected agent roster model');
    A.eq(s.runs[0].system, 'ROSTER SYSTEM', 'cron fire uses the selected agent roster system prompt');
  }

  // ---- CONVEYOR: a real fire rides a box onto the floor for its agent (workitem.placed plumbing) ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun());
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.placed.length, 1, 'a fired routine rides exactly one conveyor box');
    A.eq(s.placed[0].agentId, 'cron_j1', 'the box is bound for the job agent (server-authoritative)');
    A.eq(s.placed[0].prompt, 'do j1', 'the box carries the routine instruction as its payload');
    A.eq(s.placed[0].runId, s.runs[0].runId, 'the box is stamped with the launched runId (crate<->run correlation)');
  }

  // ---- CONVEYOR: a no-capability skip rides NO box (a crate appears only when a run truly fires) ----
  {
    const j = intervalJob('j1', 'every 1m');
    const s = setup([j], okRun(), { key: '' });            // no key -> no-capability skip
    s.clock.set(T0 + 60000);
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 0, 'no run fires without capability');
    A.eq(s.placed.length, 0, 'and no conveyor box rides — the floor never shows phantom work');
  }

  // ---- G4.4 CAP: maxParallel caps in-flight fires; the excess due jobs DEFER (stay due next tick) ----
  {
    // 3 interval jobs all due at the same instant, but only ONE may fire (cap=1). The other two are
    // DEFERRED — observable via the return value (summary.deferred) — and MUST stay due (nextRunAt NOT
    // advanced) so the next tick fires them. The deferral does NOT emit a new event this iteration (the
    // cron.skipped 'at-capacity' reason is enum-governed and pending the memory-cortex events batch).
    const a = intervalJob('ca', 'every 1m');
    const b = intervalJob('cb', 'every 1m');
    const c = intervalJob('cc', 'every 1m');
    // never-settling runs so the fired job HOLDS its lease (a real in-flight run counts against the cap).
    const s = setup([a, b, c], () => new Promise(() => {}), { maxParallel: 1 });
    s.clock.set(T0 + 60000);                                // all three are due
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 1, 'cap=1 -> exactly one due job fires');
    A.eq(s.runs.length, 1, 'runOnce launched exactly once (the cap held the rest back)');
    A.ok(Array.isArray(summary.deferred), 'summary.deferred is an array (the observable deferral signal)');
    A.eq(summary.deferred.length, 2, 'the two over-cap jobs are reported deferred via the return value');
    A.eq(summary.fired + summary.deferred.length, 3, 'every due job is accounted for: fired + deferred = 3');
    // the fired job advanced (advance-before-run); the two DEFERRED jobs did NOT — they remain due.
    const firedId = s.runs[0].agentId.replace('cron_', '');
    for (const id of ['ca', 'cb', 'cc']) {
      const job = s.getJob(id);
      if (id === firedId) {
        A.eq(job.nextRunAt, cron._internals.iso(T0 + 120000), 'the FIRED job advanced one period (advance-before-run)');
      } else {
        A.ok(summary.deferred.indexOf(id) >= 0, 'the over-cap job ' + id + ' is in summary.deferred');
        A.eq(job.nextRunAt, cron._internals.iso(T0 + 60000), 'a DEFERRED job keeps its old nextRunAt (still DUE)');
      }
    }
    // next tick at the SAME instant: the one freed slot is taken by a deferred job (cap still 1, still in-flight).
    const summary2 = s.driver.applyTick(s.clock.now());
    A.eq(summary2.fired, 0, 'cap=1 and the first run is still in-flight -> nothing new fires next tick');
    A.eq(summary2.deferred.length, 2, 'both deferred jobs still due and still over the cap');
  }

  // ---- G4.4 CAP: with headroom the deferred jobs fire on a later tick once a slot frees ----
  {
    // cap=2, 3 due jobs whose runs settle immediately: 2 fire this tick (deferring 1), and after the leases
    // release the deferred job fires on the next tick — proving deferral is a HOLD, not a drop.
    const a = intervalJob('da', 'every 5m');
    const b = intervalJob('db', 'every 5m');
    const c = intervalJob('dc', 'every 5m');
    const s = setup([a, b, c], okRun(), { maxParallel: 2 });
    s.clock.set(T0 + 300000);                               // all three due (period 5m)
    const summary = s.driver.applyTick(s.clock.now());
    A.eq(summary.fired, 2, 'cap=2 -> two fire this tick');
    A.eq(summary.deferred.length, 1, 'the third is deferred');
    const deferredId = summary.deferred[0];
    A.eq(s.getJob(deferredId).nextRunAt, cron._internals.iso(T0 + 300000), 'the deferred job is still due (nextRunAt unchanged)');
    await flush();                                          // the two fired runs settle -> leases release
    const summary2 = s.driver.applyTick(s.clock.now());     // same instant, slots now free
    A.eq(summary2.fired, 1, 'the previously-deferred job fires once a slot frees');
    A.eq(s.runs[s.runs.length - 1].agentId, 'cron_' + deferredId, 'the freed slot ran the deferred job');
    A.eq(s.getJob(deferredId).nextRunAt, cron._internals.iso(T0 + 300000 + 300000), 'now it has advanced (it actually fired)');
  }

  // ---- G4.4 TRANSIENT RETRY (proven end-to-end): transient-once-then-ok backs off, retryCount++, no lastRunAt advance, then succeeds ----
  {
    // The EXISTING retry path (markRun transient backoff) is proven through the REAL driver fire->settle
    // path: the first fire's run reports a TRANSIENT error -> nextRunAt backs off (now+backoffMs),
    // retryCount becomes 1, lastRunAt stays null (occurrence not finalized). The backed-off fire then
    // succeeds -> retryCount resets to 0, lastRunAt stamped, lastStatus ok.
    const BACKOFF = 90000;                                  // cron-store default backoffMs
    let attempt = 0;
    const flaky = (o) => {
      attempt++;
      if (attempt === 1) {
        // a transient run error (the loop signals transient:true; the driver's sink books state.transient)
        o.emit('agent.run.error', { agentId: 'a', runId: o.runId, message: 'rate limited', transient: true });
        o.emit('agent.run.end', { agentId: 'a', runId: o.runId, reason: 'error', turns: 1, usd: 0 });
        return;
      }
      okRun('recovered')(o);                                // second attempt succeeds
    };
    const j = intervalJob('rj', 'every 10m');               // period 600000; armed at T0+600000
    const s = setup([j], flaky);
    s.clock.set(T0 + 600000);                               // due
    s.driver.applyTick(s.clock.now());                      // fire #1
    await flush();                                          // settle -> markRun(transient)
    const afterFail = s.getJob('rj');
    A.eq(afterFail.retryCount, 1, 'transient failure incremented retryCount');
    A.eq(afterFail.lastRunAt, null, 'transient failure did NOT advance lastRunAt (occurrence not finalized)');
    A.eq(afterFail.lastStatus, 'error', 'transient failure recorded lastStatus error (failing-and-retrying)');
    A.eq(afterFail.state, 'error', 'state error while retrying, but still scheduled');
    A.eq(afterFail.nextRunAt, cron._internals.iso(T0 + 600000 + BACKOFF), 'nextRunAt backed off by backoffMs (now + 90s)');
    A.ok(afterFail.enabled !== false, 'a transiently-failing recurring job stays enabled');
    // advance to the backed-off fire time and tick again -> the retry succeeds.
    s.clock.set(T0 + 600000 + BACKOFF);
    s.driver.applyTick(s.clock.now());                      // fire #2 (the retry)
    await flush();
    const afterOk = s.getJob('rj');
    A.eq(attempt, 2, 'the run was attempted exactly twice (one transient, one success)');
    A.eq(afterOk.retryCount, 0, 'a successful retry resets retryCount');
    A.ok(afterOk.lastRunAt != null, 'the successful retry finalized the occurrence (lastRunAt stamped)');
    A.eq(afterOk.lastStatus, 'ok', 'lastStatus ok after the retry succeeds');
  }

  require('./cron.run-now.test.js');
  A.report('cron.tick');
})();
