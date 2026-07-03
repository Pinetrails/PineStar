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
     deps.getKey(provider, job)
                           -> string             // LIVE provider credential material when one is key-backed
     deps.providerForJob(job, ident)
                           -> string             // selected runtime provider ('openrouter' or 'codex')
     deps.hasCredential(provider, key, job)
                           -> bool               // OAuth providers can be runnable without a BYOK key
     deps.defaultModel     -> string             // boot-frozen SKYNET_DEFAULT_MODEL fallback when job.model is null
     deps.identityForAgent -> (agentId, job) -> { system?, model? } | null
                                                 // optional selected-agent identity (browser roster / persisted mirror)
     deps.persona          -> string | ()=>string // the autonomous system prompt (carries the [SILENT] hint);
                                                 //   a getter is re-read each fire so it can fold in the live
                                                 //   Commander dossier (Phase C). Both forms stay determinism-clean.
     deps.maxRunMs         -> int                // self-healing lease ceiling: a run older than this is reclaimed
     deps.placeWorkitem(agentId, prompt, runId)
                           -> void               // OPTIONAL: ride the routine's instruction onto the CONVEYOR as a
                                                 //   box bound for its agent (the SAME workitem.placed plumbing a
                                                 //   Telegram message uses) so a scheduled fire is VISIBLE on the
                                                 //   floor — a crate arrives and the agent goes to work. Injected
                                                 //   (the ambient id-mint + emit live in index.js), so this file
                                                 //   stays determinism-clean. No-op when not provided. */
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
    const providerForJob = typeof d.providerForJob === 'function' ? d.providerForJob : function () { return 'openrouter'; };
    const hasCredential = typeof d.hasCredential === 'function' ? d.hasCredential : function (_provider, key) { return !!key; };
    const defaultModel = d.defaultModel || '';
    const identityForAgent = typeof d.identityForAgent === 'function' ? d.identityForAgent : function () { return null; };
    // persona may be a STRING (the autonomous system prompt) or a GETTER that returns it fresh each fire
    // (Phase C: index.js passes a getter so each run folds in the live Commander dossier). Both stay
    // determinism-clean — a getter is just an injected dep, exactly like getKey/getJobs.
    const personaOf = typeof d.persona === 'function' ? d.persona : function () { return d.persona || ''; };
    const placeWorkitem = typeof d.placeWorkitem === 'function' ? d.placeWorkitem : function () {};
    const maxRunMs = d.maxRunMs || (8 * 60 * 1000);
    // G4.4 global concurrency cap: at most `maxParallel` cron runs may be IN-FLIGHT at once. When a tick's due
    // set would push the live-lease count over this, the EXTRA due jobs are DEFERRED to the next tick WITHOUT
    // advancing their nextRunAt (they stay due), so a burst of simultaneously-due routines never floods the run
    // host / blows the spend budget all at once — they drain `maxParallel` at a time over successive ticks. An
    // INJECTED int (host threads SKYNET_CRON_MAX_PARALLEL), so this file stays determinism-clean. Default 4.
    const maxParallel = (function () {
      const n = parseInt(d.maxParallel, 10);
      return (Number.isFinite(n) && n > 0) ? n : 4;
    })();
    // injected host tz (G4.1): a tz-LESS cron schedule is planned on this LOCAL wall-clock; a schedule's
    // own tz always wins. A string dep — the pure cron-math owns the Intl formatting, so this stays clean.
    const defaultTz = d.defaultTz != null ? d.defaultTz : null;
    if (typeof getJobs !== 'function' || typeof setJobs !== 'function') throw new Error('cron-driver: getJobs/setJobs are required');
    if (typeof runOnce !== 'function') throw new Error('cron-driver: runOnce is required');
    if (typeof newId !== 'function' || typeof newAbort !== 'function' || typeof now !== 'function') throw new Error('cron-driver: newId/newAbort/now are required');

    const leases = new Map();   // jobId -> { runId, startedAt, ac } — the one-run-per-job in-flight lock
    // G4.3 in-process reentrancy guard: a tick re-entered at the SAME instant (e.g. the boot resume
    // reconcile racing the first timer tick, or a fire's run host synchronously re-entering applyTick)
    // must be a NO-OP — the outer pass has not yet persisted its advance, so a re-entrant pass would
    // see the same jobs still due and double-fire. The cross-process file lock (cron-lock.js) handles
    // the two-sidecars case; this flag closes the single-process re-entrancy hole the lock cannot see.
    let tickInFlight = false;

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
      const ident = identityForAgent(job.agentId, job) || {};
      const model = (job.model && String(job.model).trim()) || (ident.model && String(ident.model).trim()) || defaultModel;
      const provider = providerForJob(job, ident) || 'openrouter';
      const key = getKey(provider, job);
      if (!model || !hasCredential(provider, key, job)) { try { emit('cron.skipped', { jobId: job.id, reason: 'no-capability' }); } catch (_) {} return false; }

      const runId = newId();
      const ac = newAbort();
      leases.set(job.id, { runId: runId, startedAt: nowMs, ac: ac });
      try { emit('cron.fire', { jobId: job.id, runId: runId, scheduledFor: scheduledFor }); } catch (_) {}
      // ride the routine's instruction onto the CONVEYOR as a box bound for this agent — only NOW (past the
      // capability gate, lease taken), so a crate appears on the floor iff a run is genuinely firing.
      try { placeWorkitem(job.agentId, job.prompt, runId); } catch (_) {}

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
          key: key, model: model, system: (ident.system && String(ident.system)) || personaOf(job.agentId, job), messages: messages,
          agentId: job.agentId, isTask: true, emit: sink, signal: ac.signal,
          // streamId 'cron-'+runId makes this run's transcript durable under a per-RUN named stream (runId is a
          // fresh newId() already in scope — determinism-clean). Without it the reply is buffered into `state.buf`
          // and only an outcome enum escapes, so the actual work is invisible: it persists under the 'global'
          // stream no UI renders. A PER-RUN id (not per-job) keeps the run's message seed empty (index.js only
          // reconstructs a stream when messages<=1), so cron behavior is byte-identical — the frontend
          // autosessions module reads GET /api/transcript?stream=cron-<runId> to surface the output as a session.
          runId: runId, streamId: 'cron-' + runId, surface: 'autonomous', trigger: 'schedule', provider: provider
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
      // G4.3: re-entrant tick at the same instant is a no-op (see tickInFlight above). The guard wraps
      // the WHOLE pass — set on entry, cleared in a finally so a thrown plan/emit never wedges the flag.
      if (tickInFlight) return { fired: 0, skipped: 0, planned: 0, deferred: [], reentered: true };
      tickInFlight = true;
      try {
        return applyTickInner(nowMs);
      } finally {
        tickInFlight = false;
      }
    }

    function applyTickInner(nowMs) {
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
      //    defaultTz makes a tz-less schedule plan on the host's local wall-clock (G4.1). maxRunMs is the
      //    one-shot fire-claim ceiling (G4.5): planTick suppresses a one-shot with a FRESH claim (in flight)
      //    and reclaims a ZOMBIE claim past this age — the SAME ceiling the lease sweep above uses.
      const plan = cron.planTick(getJobs(), nowMs, { defaultTz: defaultTz, maxRunMs: maxRunMs });

      // 2b. GLOBAL CONCURRENCY CAP (G4.4): partition plan.fire into the jobs we'll ATTEMPT this tick and the
      //     ones DEFERRED past the cap. A job already holding a lease is neither attempted nor deferred — it
      //     advances + reports already-running below exactly as before (drop the occurrence, never re-queue).
      //     Slots = maxParallel - currently-in-flight; reserve one per attempt in plan order. A deferred job is
      //     NOT advanced (step 3 skips it), so its nextRunAt stays put and it remains DUE next tick — it drains
      //     when a slot frees. NOTE: the at-capacity deferral is reported via the RETURN VALUE only this
      //     iteration — the additive `cron.skipped` reason `at-capacity` / `cron.tick.deferred` field are
      //     pending the memory-cortex events batch (the reason enum is governed; emitting it would fail lint).
      let slotsLeft = maxParallel - leases.size;
      const deferred = [];
      const deferredSet = new Set();
      for (const f of plan.fire) {
        const job = cronStore.getJob(getJobs(), f.jobId);
        if (!job) continue;
        if (leases.has(job.id)) continue;                  // already-running: not attempted, not deferred (advances)
        if (slotsLeft > 0) { slotsLeft--; }                // reserve a concurrency slot for this attempt
        else { deferred.push(job.id); deferredSet.add(job.id); }   // over the cap -> defer (stays due, not advanced)
      }

      // 3. ADVANCE-BEFORE-RUN: persist the advanced nextRunAt for every planned RECURRING job EXCEPT a
      //    deferred one, BEFORE launching, so a crash mid-run never double-fires on restart. A fire later
      //    skipped by its lease still keeps this advance (drop the occurrence, never re-queue it); a DEFERRED
      //    job keeps its OLD nextRunAt so it stays due and fires on a later tick when a concurrency slot frees.
      //
      //    G4.5 ONE-SHOT FIRE-CLAIM: a one-shot has no advanced nextRunAt to persist (it doesn't recur), so its
      //    crash-restart protection is a fire-CLAIM stamped here and persisted in the SAME write, BEFORE launch.
      //    cron.planTick then suppresses a one-shot carrying a fresh claim (in flight) and reclaims a zombie one
      //    past maxRunMs. A deferred or already-leased one-shot is NOT claimed this tick (it isn't firing yet).
      {
        const advanceById = Object.create(null);
        for (const nx of plan.next) { if (!deferredSet.has(nx.jobId)) advanceById[nx.jobId] = nx.nextAt; }
        // which one-shots will actually fire this tick (in plan.fire, not deferred, not already leased)?
        const claimOnce = new Set();
        for (const f of plan.fire) {
          if (deferredSet.has(f.jobId) || leases.has(f.jobId)) continue;
          const job = cronStore.getJob(getJobs(), f.jobId);
          if (job && job.schedule && job.schedule.kind === 'once') claimOnce.add(f.jobId);
        }
        // NOTE: a one-shot that turns out NO-CAPABILITY in step 5 (fireJob returns false → no run launched)
        // still carries this claim. That is intentional and safe: it converts per-tick re-attempts into a
        // bounded ~maxRunMs backoff, after which the zombie reclaim retries — a non-firing one-shot either way.
        if (Object.keys(advanceById).length || claimOnce.size) {
          let jobs = getJobs();
          for (const id in advanceById) {
            jobs = jobs.map(function (j) { return (j && j.id === id) ? Object.assign({}, j, { nextRunAt: iso(advanceById[id]) }) : j; });
          }
          // stamp + persist the one-shot fire-claim through the store reducer (keeps the claim shape in one place).
          for (const id of claimOnce) { jobs = cronStore.claimOnceFire(jobs, id, { now: nowMs }); }
          setJobs(jobs);
        }
      }

      // 4. stale recurring runs that were fast-forwarded (no backlog burst) -> a structured skip per job.
      for (const sk of plan.skipped) { try { emit('cron.skipped', { jobId: sk.jobId, reason: sk.reason }); } catch (_) {} skips++; }

      // 5. fire each due job — lease-guarded (one in-flight per job), CAP-guarded, and capability-guarded.
      for (const f of plan.fire) {
        const job = cronStore.getJob(getJobs(), f.jobId);
        if (!job) continue;
        if (leases.has(job.id)) { try { emit('cron.skipped', { jobId: job.id, reason: 'already-running' }); } catch (_) {} skips++; continue; }
        if (deferredSet.has(job.id)) continue;             // over the cap: held back (counted in `deferred`), no advance, no event this iteration
        if (fireJob(job, f.scheduledFor, nowMs)) fires++; else skips++;   // false = no-capability (already emitted)
      }

      // 6. the war-room pulse — emitted ONLY when something happened, so an idle/empty-store tick stays silent
      //    (the no-op invariant: an empty schedule incurs no event, no console line, no cost). A tick that only
      //    DEFERRED still pulses (deferred ⊆ plan.fire, so plan.fire.length covers it — something WAS due). The
      //    `deferred` count is NOT on the emit yet (the additive cron.tick.deferred field is pending the batch).
      if (fires || skips || plan.fire.length) {
        try { emit('cron.tick', { fired: fires, skipped: skips, planned: plan.fire.length }); } catch (_) {}
      }
      return { fired: fires, skipped: skips, planned: plan.fire.length, deferred: deferred };
    }

    return { applyTick: applyTick, leases: leases, _internals: { fireJob: fireJob, finishFire: finishFire } };
  }

  return { makeCronDriver: makeCronDriver, SILENT_MARKER: SILENT_MARKER };
});
