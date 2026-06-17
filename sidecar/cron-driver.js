/* sidecar/cron-driver.js — the autonomous scheduler TICK DRIVER (CRON Commit 4b), determinism-split clean.

   The orchestration half of the scheduler: it owns the per-tick decision flow (reclaim stale leases → plan
   via the pure cron-math → persist the advanced next-fires BEFORE launching → fire each due job through the
   injected run host → record the outcome) and the in-flight LEASE map. Every ambient dependency is INJECTED —
   there is NO Date.now / Math.random / new Date() / setInterval / setTimeout / fs / crypto in this file, so it
   passes lint-determinism.js and is headless-testable with a fake clock + a fake runOnce (exactly like
   loop.js / permissions.js / cron-store.js). The ambient half — the real setInterval timer, Date.now,
   crypto.randomUUID, the cron.jobs.json load/persist, the boot-resume reconcile — lives ONLY in
   sidecar/index.js (the lint-exempt composition root). See docs/CRON_INTEGRATION_PLAN.md §3.1, §3.3, §4b.

   The whole subsystem is OPT-IN: index.js arms the timer only when SKYNET_CRON_ENABLED is set, so when it is
   off no driver is ever constructed, nothing fires, and the browser path is byte-identical.

   makeCronDriver(deps) -> { applyTick(nowMs) -> {fired,skipped,planned}, leases:Map }
     deps.getJobs()        -> CronJob[]          // read the live store (index.js's cronJobs mirror)
     deps.setJobs(jobs)    -> void               // replace + PERSIST the store (index.js: cronJobs=…; saveCronJobs())
     deps.runOnce(opts)    -> Promise<result>    // the SAME run host the browser uses (index.js runOnce)
     deps.emit(name,pl)    -> void               // a validated+redacted cron emitter (-> console + the SSE HUD)
     deps.newId()          -> string             // a fresh runId (crypto.randomUUID in index.js)
     deps.newAbort()       -> AbortController     // () => new AbortController()
     deps.now()            -> int ms             // wall clock for run-COMPLETION timestamps (a run settles long
                                                 //   after applyTick's nowMs is stale) — Date.now in index.js
     deps.getKey()         -> string             // the LIVE BYOK key (index.js runtimeKey; '' => no-capability)
     deps.defaultModel     -> string             // boot-frozen SKYNET_DEFAULT_MODEL fallback when job.model is null
     deps.persona          -> string             // the autonomous system prompt (carries the [SILENT] hint)
     deps.maxRunMs         -> int                // self-healing lease ceiling: a run older than this is reclaimed */
'use strict';
(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('./cron.js') : (root.SK && root.SK.cron),
    typeof require === 'function' ? require('./cron-store.js') : (root.SK && root.SK.cronStore)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).cronDriver = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (cron, cronStore) {
  'use strict';

  const SILENT_MARKER = '[SILENT]';
  const iso = cron._internals.iso;   // ms(arg) -> ISO; deterministic (the lint bans only the zero-arg new Date)

  function makeCronDriver(deps) {
    const d = deps || {};
    const getJobs = d.getJobs, setJobs = d.setJobs, runOnce = d.runOnce;
    const emit = typeof d.emit === 'function' ? d.emit : function () {};
    const newId = d.newId, newAbort = d.newAbort, now = d.now;
    const getKey = typeof d.getKey === 'function' ? d.getKey : function () { return ''; };
    const defaultModel = d.defaultModel || '';
    const persona = d.persona || '';
    const maxRunMs = d.maxRunMs || (8 * 60 * 1000);
    if (typeof getJobs !== 'function' || typeof setJobs !== 'function') throw new Error('cron-driver: getJobs/setJobs are required');
    if (typeof runOnce !== 'function') throw new Error('cron-driver: runOnce is required');
    if (typeof newId !== 'function' || typeof newAbort !== 'function' || typeof now !== 'function') throw new Error('cron-driver: newId/newAbort/now are required');

    const leases = new Map();   // jobId -> { runId, startedAt, ac } — the one-run-per-job in-flight lock

    /* finishFire — record a fired run's outcome once it settles: markRun (the reducer owns the transient-backoff
       / one-shot-finalize math) → persist → cron.result → release the lease (only if it is still ours). */
    function finishFire(jobId, runId, state, threw) {
      const at = now();
      const reply = (state.buf || '').trim();
      const errMsg = state.errMsg || (threw ? ('run failed: ' + ((threw && threw.message) || threw)) : null);
      const ok = !errMsg;
      const transient = !!(state.transient || (threw && threw.transient));
      try {
        const next = cronStore.markRun(getJobs(), jobId, {
          runId: runId, status: ok ? 'ok' : 'error',
          reason: state.reason || (ok ? 'done' : 'error'),
          error: errMsg || undefined, transient: transient
        }, { now: at });
        setJobs(next);
      } catch (_) { /* a persist/markRun failure must never crash a settling run */ }
      // job-level outcome: a FAILED run always reports (never silent); SILENT only on a clean, exactly-"[SILENT]" reply.
      const outcome = !ok ? 'failed' : (reply === SILENT_MARKER ? 'silent' : 'ok');
      try { emit('cron.result', { jobId: jobId, runId: runId, outcome: outcome, reason: state.reason || (errMsg ? 'error' : 'done') }); } catch (_) {}
      const lease = leases.get(jobId);
      if (lease && lease.runId === runId) leases.delete(jobId);   // a stale-lock sweep may have reclaimed+replaced it
    }

    /* fireJob — launch one due job through the run host. Returns true iff a run was actually launched (false on a
       no-capability skip). The run settles asynchronously; its lease is released in finishFire on EVERY terminal
       path (resolve or reject), so a throwing/zombie run never permanently wedges the job. */
    function fireJob(job, scheduledFor, nowMs) {
      const model = (job.model && String(job.model).trim()) || defaultModel;
      const key = getKey();
      if (!model || !key) { try { emit('cron.skipped', { jobId: job.id, reason: 'no-capability' }); } catch (_) {} return false; }

      const runId = newId();
      const ac = newAbort();
      leases.set(job.id, { runId: runId, startedAt: nowMs, ac: ac });
      try { emit('cron.fire', { jobId: job.id, runId: runId, scheduledFor: scheduledFor }); } catch (_) {}

      // in-process emit sink: assemble the reply from agent.token deltas (the SAME contract harness.js/hub.js use —
      // there is no agent.message event), capture the end reason / error / transient flag, and FORWARD every
      // non-token event to the HUD so an unattended run is observable live (token deltas are dropped to stay quiet).
      const state = { buf: '', errMsg: null, reason: null, transient: false };
      const sink = function (name, payload) {
        const p = payload || {};
        if (name === 'agent.token') state.buf += (p.delta || '');
        else if (name === 'agent.run.error') { state.errMsg = p.message || 'run error'; state.transient = !!p.transient; }
        else if (name === 'capdenied') state.errMsg = state.errMsg || ('no ' + (p.need || 'capability') + ' — ' + (p.reason || ''));
        else if (name === 'agent.run.end') state.reason = p.reason;
        if (name !== 'agent.token') { try { emit(name, payload); } catch (_) {} }
      };

      const messages = [{ role: 'user', content: String(job.prompt || '') }];
      // launch the run SYNCHRONOUSLY (so the fire is ordered with the lease/cron.fire), but route both a
      // synchronous throw and an async rejection through the SAME terminal path so the lease always releases.
      let p;
      try {
        p = runOnce({
          key: key, model: model, system: persona, messages: messages,
          agentId: job.agentId, isTask: true, emit: sink, signal: ac.signal,
          runId: runId, surface: 'autonomous', trigger: 'schedule'
        });
      } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(
        function () { finishFire(job.id, runId, state, null); },
        function (e) { finishFire(job.id, runId, state, e || new Error('run rejected')); }
      );
      return true;
    }

    /* applyTick — ONE scheduler pass over the live store at wall-clock `nowMs`. Synchronous: it launches the due
       runs (their completions settle later via finishFire) and returns a small summary. The host wraps the call
       in try/catch, but the body also guards each emit so a single bad payload never aborts the pass. */
    function applyTick(nowMs) {
      nowMs = nowMs || now();
      let skips = 0, fires = 0;

      // 1. SELF-HEALING LEASE: reclaim any run older than the ceiling — abort it and free the job to re-fire.
      for (const entry of leases) {
        const jobId = entry[0], lease = entry[1];
        if (nowMs - lease.startedAt > maxRunMs) {
          try { lease.ac.abort(); } catch (_) {}
          leases.delete(jobId);
          try { emit('cron.skipped', { jobId: jobId, reason: 'stale-lock-reclaimed' }); } catch (_) {}
          skips++;
        }
      }

      // 2. the PURE plan: which jobs fire / are fast-forward-skipped, and the advanced next-fires to persist.
      const plan = cron.planTick(getJobs(), nowMs);

      // 3. ADVANCE-BEFORE-RUN: persist the advanced nextRunAt for every planned job (fired AND fast-forwarded)
      //    BEFORE launching, so a crash mid-run never double-fires on restart. A fire later skipped by its lease
      //    still keeps this advance (drop the occurrence, never re-queue it).
      if (plan.next.length) {
        let jobs = getJobs();
        for (const nx of plan.next) {
          jobs = jobs.map(function (j) { return (j && j.id === nx.jobId) ? Object.assign({}, j, { nextRunAt: iso(nx.nextAt) }) : j; });
        }
        setJobs(jobs);
      }

      // 4. stale recurring runs that were fast-forwarded (no backlog burst) -> a structured skip per job.
      for (const sk of plan.skipped) { try { emit('cron.skipped', { jobId: sk.jobId, reason: sk.reason }); } catch (_) {} skips++; }

      // 5. fire each due job — lease-guarded (one in-flight per job) and capability-guarded — through the run host.
      for (const f of plan.fire) {
        const job = cronStore.getJob(getJobs(), f.jobId);
        if (!job) continue;
        if (leases.has(job.id)) { try { emit('cron.skipped', { jobId: job.id, reason: 'already-running' }); } catch (_) {} skips++; continue; }
        if (fireJob(job, f.scheduledFor, nowMs)) fires++; else skips++;   // false = no-capability (already emitted)
      }

      // 6. the war-room pulse — emitted ONLY when something happened, so an idle/empty-store tick stays silent
      //    (the no-op invariant: an empty schedule incurs no event, no console line, no cost).
      if (fires || skips || plan.fire.length) {
        try { emit('cron.tick', { fired: fires, skipped: skips, planned: plan.fire.length }); } catch (_) {}
      }
      return { fired: fires, skipped: skips, planned: plan.fire.length };
    }

    return { applyTick: applyTick, leases: leases, _internals: { fireJob: fireJob, finishFire: finishFire } };
  }

  return { makeCronDriver: makeCronDriver, SILENT_MARKER: SILENT_MARKER };
});
