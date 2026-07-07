/* sidecar/cron-store.js — the PURE lifecycle reducer for the scheduled-routines store (CRON Commit 2).

   This is the second half of the determinism split (see cron.js header + docs/CRON_INTEGRATION_PLAN.md
   §3.2): cron.js owns the schedule MATH, this file owns the job-RECORD lifecycle. Both are pure — every
   function is a transform over (jobs, args) with `now`/`id`/`runId` INJECTED as parameters, never read
   from the wall clock or rng. There is NO Date.now / Math.random / new Date() / setTimeout / fs here, so
   it passes lint-determinism.js and is headless-testable exactly like cron.js / loop.js / permissions.js.

   The ambient half — JSON file load/persist (atomic temp+rename, fail-closed), id minting
   (crypto.randomUUID), the real now-source — lives ONLY in sidecar/index.js, which copies the allowlist
   persistence idiom (index.js:76-88) and feeds these reducers an injected `now`/`id`.

   Surface (every op returns a NEW jobs array; the input is never mutated):
     makeJob(spec, { id, now })                  -> CronJob          // normalize a new record
     createJob(jobs, spec, { id, now })          -> jobs'           // append (throws on dup/invalid id)
     updateJob(jobs, id, patch, { now })         -> jobs'           // patch editable fields (id is immutable)
     pauseJob(jobs, id)                          -> jobs'           // disable (state:'paused')
     resumeJob(jobs, id, { now })                -> jobs'           // enable + re-anchor nextRunAt at now
     claimOnceFire(jobs, id, { now })            -> jobs'           // G4.5: stamp a one-shot fire-claim (advance-before-run analog)
     renewOnceHeartbeat(jobs, id, { now })       -> jobs'           // NS-0: bump a one-shot's liveness heartbeat while in flight
     markRun(jobs, id, result, { now, ... })     -> jobs'           // record an outcome (+ transient backoff; clears the fire-claim)
     removeJob(jobs, id)                         -> jobs'           // delete
     getJob(jobs, id)                            -> CronJob | null
     loadEnvelope(rawObjOrString)               -> { version, jobs } // tolerant, fail-closed
     toEnvelope(jobs)                           -> { version, jobs } // for persistence
     isValidId(id)                              -> boolean

   A CronJob (see cron.js for schedule shapes):
     { id, name, prompt, schedule, scheduleDisplay, agentId, model, provider, deliver, enabled,
       state:'scheduled'|'paused'|'completed'|'error', repeat:{times,completed},
       createdAt, nextRunAt, lastRunAt, lastRunId, lastStatus, lastError, lastReason, retryCount,
       fireClaim, lastFireAttemptAt, heartbeatAt,                      // G4.5 claim + NS-0 in-flight liveness heartbeat
       skills, script, workdir, contextFrom,                          // record-the-field, defer-the-consumer
       meta }                                                         // ADDITIVE provenance bag (e.g. {recipeId}); null when absent

   G4.5 — ONE-SHOT FIRE-CLAIM (at-most-once-within-window). A recurring job is protected from a
   crash-restart double-fire by advance-before-run (planTick persists the ADVANCED nextRunAt before the
   run launches), but a one-shot has no "next" fire to advance. Instead the host stamps a FIRE-CLAIM
   (claimOnceFire: fireClaim = the fire-instant ms, lastFireAttemptAt = its ISO) and persists it BEFORE
   launching the run; cron.planTick then treats a one-shot carrying a FRESH claim (claim age < maxRunMs
   and no settlement) as NOT due, so a crash-restart INSIDE the run window does not re-fire it. A ZOMBIE
   claim past the maxRunMs ceiling (a crashed holder) IS reclaimed and re-fires. CRITICALLY, markRun
   CLEARS fireClaim on EVERY settlement — success, terminal failure, AND transient failure — so the
   not-due guard only suppresses re-fire while the run is ACTUALLY in flight: a transient failure clears
   the claim and re-arms via the normal backoff path (NOT suppressed by a stale claim); a terminal
   settlement clears the claim and the (now-set) lastRunAt makes the one-shot permanently ineligible. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./cron.js') : (root.SK && root.SK.cron));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).cronStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (cron) {
  'use strict';

  const ENVELOPE_VERSION = 1;
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;      // a single safe path component (matches index.js agentId guard)
  const iso = cron._internals.iso;            // ms(arg) -> ISO; deterministic (no zero-arg new Date)

  // fields a user may edit via updateJob. `id`, timestamps, run-state and counters are NOT editable here.
  const EDITABLE = ['name', 'prompt', 'agentId', 'model', 'provider', 'deliver', 'skills', 'script', 'workdir', 'contextFrom'];

  function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }

  function getJob(jobs, id) { return (jobs || []).find(j => j && j.id === id) || null; }

  // return a NEW jobs array with the matching job replaced by fn(job); other jobs untouched, input not mutated.
  function mapJob(jobs, id, fn) {
    return (jobs || []).map(j => (j && j.id === id ? fn(j) : j));
  }

  // the next-fire ISO for an enabled, fireable schedule re-anchored at `now`, else null.
  function armAt(schedule, lastRunIso, now) {
    const ms = cron.nextFireAt(schedule, lastRunIso, now);
    return ms != null ? iso(ms) : null;
  }

  /* makeJob — normalize a creation spec into a full CronJob record. `id` comes from spec.id or ctx.id
     (minted by the host); `now` anchors createdAt + the initial nextRunAt. Throws on an invalid id so a
     bad path component never reaches an output dir. */
  function makeJob(spec, ctx) {
    spec = spec || {}; ctx = ctx || {};
    const rawId = spec.id != null ? spec.id : ctx.id;
    const id = String(rawId);
    if (rawId == null || !isValidId(id)) throw new Error('cron-store: invalid job id (must match ' + ID_RE + ')');
    const now = ctx.now || 0;
    const schedule = spec.schedule || null;
    const enabled = spec.enabled !== false;                          // default true
    const isOnce = !!(schedule && schedule.kind === 'once');
    const fireable = !!(schedule && (schedule.kind === 'once' || schedule.kind === 'interval' || schedule.kind === 'cron'));

    // repeat: a one-shot is exactly once; recurring schedules are forever (null) unless a finite times is given.
    let times = null;
    if (isOnce) times = 1;
    else if (spec.repeat && spec.repeat.times != null) times = Math.max(1, parseInt(spec.repeat.times, 10) || 1);

    return {
      id: id,
      name: String(spec.name || ''),
      prompt: String(spec.prompt || ''),
      schedule: schedule,
      scheduleDisplay: schedule && schedule.display ? schedule.display : '',
      agentId: String(spec.agentId || 'agent'),
      model: spec.model != null ? String(spec.model) : null,        // null -> host's boot-frozen default
      provider: spec.provider != null ? String(spec.provider) : null, // null -> selected agent/global provider
      deliver: String(spec.deliver || 'local'),
      enabled: enabled,
      state: enabled ? 'scheduled' : 'paused',
      repeat: { times: times, completed: 0 },
      createdAt: iso(now),
      nextRunAt: (enabled && fireable) ? armAt(schedule, null, now) : null,
      lastRunAt: null, lastRunId: null, lastStatus: null, lastError: null, lastReason: null,
      retryCount: 0,
      // G4.5 one-shot fire-claim: stamped at fire time (claimOnceFire), cleared on settlement (markRun).
      // null on a fresh job; only ever non-null while a one-shot run is in flight (or a zombie past maxRunMs).
      fireClaim: null, lastFireAttemptAt: null,
      // NS-0 LEASE HEARTBEAT (2026-07-07): a LIVENESS timestamp renewed while a one-shot run is genuinely in
      // flight (the driver bumps it on every run-progress event via renewOnceHeartbeat, persisted). planTick
      // suppresses re-fire of a one-shot whose heartbeat is FRESH (age < staleMs) REGARDLESS of wall-clock claim
      // age — so a real research run that outlives maxRunMs is NOT declared a zombie and re-fired. A STALE
      // heartbeat (a crashed/dead-process holder — heartbeats stop) falls through to the fireClaim zombie reclaim.
      // null on a fresh job; cleared alongside fireClaim on EVERY settlement. Additive — old jobs load as null.
      heartbeatAt: null,
      // ---- record-the-field, defer-the-consumer (no v1 runtime consumer; stored so a later commit wires it) ----
      skills: Array.isArray(spec.skills) ? spec.skills.slice() : [],
      script: spec.script != null ? String(spec.script) : null,
      workdir: spec.workdir != null ? String(spec.workdir) : null,
      contextFrom: Array.isArray(spec.contextFrom) ? spec.contextFrom.slice() : null,
      // ADDITIVE provenance (Recipe Marketplace R3): a sibling `meta` bag for caller-supplied provenance, e.g.
      // { recipeId } stamped by MAKE ROUTINE so the ROUTINES console + the recipe dossier can show the link. Old
      // jobs with no `meta` load as null and every consumer tolerates its absence — this NEVER breaks an existing
      // job. Normalized to a plain shallow object (or null); the driver/schedule math never reads it.
      meta: normMeta(spec.meta)
    };
  }
  // normalize a caller-supplied meta bag: keep it only if it is a plain object, shallow-cloned; else null. This is
  // pure provenance (no runtime behavior keys), so we don't validate its shape beyond "plain object" — a recipeId
  // that isn't a string just won't resolve in the UI (a no-op), never a crash.
  function normMeta(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const out = {};
    for (const k of Object.keys(meta)) { const v = meta[k]; if (v != null && typeof v !== 'function') out[k] = v; }
    return Object.keys(out).length ? out : null;
  }

  function createJob(jobs, spec, ctx) {
    jobs = jobs || [];
    const job = makeJob(spec, ctx);
    if (jobs.some(j => j && j.id === job.id)) throw new Error('cron-store: duplicate job id ' + job.id);
    return jobs.concat([job]);
  }

  /* updateJob — patch the EDITABLE fields (and repeat.times). `id` is immutable: a patch.id is ignored,
     never copied. Changing the schedule re-anchors nextRunAt at `now` (unless the job is paused). */
  function updateJob(jobs, id, patch, ctx) {
    ctx = ctx || {}; patch = patch || {};
    const now = ctx.now || 0;
    return mapJob(jobs, id, (job) => {
      const next = Object.assign({}, job);
      for (const k of EDITABLE) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
      if (patch.repeat && patch.repeat.times !== undefined) {
        const t = patch.repeat.times;
        next.repeat = Object.assign({}, job.repeat, { times: t == null ? null : Math.max(1, parseInt(t, 10) || 1) });
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'schedule')) {
        next.schedule = patch.schedule || null;
        next.scheduleDisplay = next.schedule && next.schedule.display ? next.schedule.display : '';
        if (next.enabled) next.nextRunAt = armAt(next.schedule, null, now);   // re-anchor at now
      }
      return next;
    });
  }

  function pauseJob(jobs, id) {
    return mapJob(jobs, id, (job) => Object.assign({}, job, { enabled: false, state: 'paused' }));
  }

  function resumeJob(jobs, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapJob(jobs, id, (job) =>
      Object.assign({}, job, { enabled: true, state: 'scheduled', nextRunAt: armAt(job.schedule, null, now) }));
  }

  function removeJob(jobs, id) { return (jobs || []).filter(j => !(j && j.id === id)); }

  /* claimOnceFire — G4.5: stamp a one-shot's FIRE-CLAIM at fire time (the advance-before-run analog for a
     non-recurring job). The host calls this for each due one-shot it is about to launch and PERSISTS the
     result BEFORE launching, so a crash-restart inside the run window sees the claim and does not re-fire
     (planTick suppresses a fresh-claimed one-shot; a zombie claim past maxRunMs is reclaimed). `now` is the
     fire instant ms (injected). No-op shape on a non-once job (still records the attempt timestamp). The
     claim is cleared by markRun on settlement, so it only ever marks an in-flight run. */
  function claimOnceFire(jobs, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    // NS-0: do NOT stamp heartbeatAt here — the heartbeat is proof a run is ACTUALLY EMITTING progress, which a
    // just-claimed (or no-capability, never-launched) one-shot has not yet done. Leaving heartbeatAt null means
    // planTick falls through to the pure maxRunMs fireClaim reclaim (unchanged backoff for a non-firing one-shot);
    // once the run emits its first progress event, renewOnceHeartbeat sets a fresh heartbeat that extends liveness.
    return mapJob(jobs, id, (job) => Object.assign({}, job, { fireClaim: now, lastFireAttemptAt: iso(now) }));
  }

  /* renewOnceHeartbeat — NS-0: bump a one-shot's durable liveness timestamp to `now` (the driver calls this on
     each run-progress event so an in-flight run keeps proving it is alive). No-op-safe on a non-once/absent job.
     Only meaningful while a fireClaim is live; markRun clears BOTH on settlement so a stale heartbeat never
     wedges the job. Pure: `now` is injected. Kept minimal (heartbeat only) so a hot renewal path is cheap. */
  function renewOnceHeartbeat(jobs, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapJob(jobs, id, (job) => (job.fireClaim == null ? job : Object.assign({}, job, { heartbeatAt: now })));
  }

  /* markRun — record the outcome of a fired run. `result = { runId, status:'ok'|'error', reason, error, transient }`.
     ctx = { now, maxRetries=3, backoffMs=90000 }.

       - transient error with retries left -> back off (nextRunAt = now + backoffMs), retryCount++, stay
         eligible (lastRunAt UNTOUCHED so it re-fires; repeat.completed NOT incremented). Bounded retry, no storm.
       - otherwise (success / permanent error / retries exhausted) -> finalize the occurrence: stamp
         lastRunAt, reset retryCount, increment repeat.completed, then:
           * one-shot OR finite repeat exhausted -> enabled:false, state:'completed' (ok) / 'error' (failed).
           * recurring continues -> on success leave nextRunAt as planTick already advanced it (advance-
             before-run); on a terminal error re-arm one period out and flag state:'error' but stay ENABLED
             (never silently disable a recurring job). */
  function markRun(jobs, id, result, ctx) {
    result = result || {}; ctx = ctx || {};
    const now = ctx.now || 0;
    const maxRetries = ctx.maxRetries != null ? ctx.maxRetries : 3;
    const backoffMs = ctx.backoffMs != null ? ctx.backoffMs : 90000;
    return mapJob(jobs, id, (job) => {
      const ok = result.status === 'ok';
      const isOnce = !!(job.schedule && job.schedule.kind === 'once');
      const next = Object.assign({}, job);
      next.lastRunId = result.runId != null ? String(result.runId) : job.lastRunId;
      next.lastReason = result.reason != null ? String(result.reason) : null;
      next.lastStatus = ok ? 'ok' : 'error';
      next.lastError = ok ? null : (result.error != null ? String(result.error) : 'error');
      // G4.5: ANY settlement (success, terminal failure, OR transient failure) means the run is no longer
      // in flight, so CLEAR the one-shot fire-claim. The not-due guard must only suppress re-fire WHILE
      // actually running — a transient settlement clears the claim so the backoff path below can re-arm
      // the one-shot without being suppressed by a stale claim. (lastFireAttemptAt is left as the audit trail.)
      next.fireClaim = null;
      // NS-0: clear the liveness heartbeat on the SAME settlement — the run is no longer in flight, so a
      // stale heartbeat must never suppress a legitimately-re-arming (transient-backoff) one-shot.
      next.heartbeatAt = null;

      // transient failure with retries left: back off, stay eligible, do NOT finalize the occurrence.
      if (!ok && result.transient && (job.retryCount || 0) < maxRetries) {
        next.retryCount = (job.retryCount || 0) + 1;
        next.nextRunAt = iso(now + backoffMs);
        next.state = 'error';                  // visible as failing-and-retrying, but still scheduled to fire
        return next;
      }

      // terminal: finalize this occurrence.
      next.retryCount = 0;
      next.lastRunAt = iso(now);
      next.repeat = Object.assign({}, job.repeat, { completed: ((job.repeat && job.repeat.completed) || 0) + 1 });
      const exhausted = next.repeat.times != null && next.repeat.completed >= next.repeat.times;

      if (isOnce || exhausted) {
        next.enabled = false;
        next.nextRunAt = null;
        next.state = ok ? 'completed' : 'error';
        return next;
      }
      // recurring continues
      if (ok) {
        next.state = 'scheduled';              // nextRunAt left as planTick advanced it (advance-before-run)
      } else {
        next.nextRunAt = armAt(job.schedule, next.lastRunAt, now) || job.nextRunAt;  // re-arm defensively
        next.state = 'error';                  // visible, but enabled stays true
      }
      return next;
    });
  }

  /* loadEnvelope — normalize whatever came off disk into a valid { version, jobs } envelope. Tolerates a
     JSON string, a parsed object, null, or garbage; fail-closed to an empty store. Drops malformed job
     records (missing/invalid id) rather than trusting them. */
  function loadEnvelope(raw) {
    let obj = raw;
    if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (e) { obj = null; } }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.jobs)) return { version: ENVELOPE_VERSION, jobs: [] };
    const jobs = obj.jobs.filter(j => j && typeof j === 'object' && isValidId(j.id));
    return { version: ENVELOPE_VERSION, jobs: jobs };
  }

  function toEnvelope(jobs) { return { version: ENVELOPE_VERSION, jobs: (jobs || []).slice() }; }

  return {
    makeJob: makeJob,
    createJob: createJob,
    updateJob: updateJob,
    pauseJob: pauseJob,
    resumeJob: resumeJob,
    claimOnceFire: claimOnceFire,
    renewOnceHeartbeat: renewOnceHeartbeat,
    markRun: markRun,
    removeJob: removeJob,
    getJob: getJob,
    loadEnvelope: loadEnvelope,
    toEnvelope: toEnvelope,
    isValidId: isValidId,
    ENVELOPE_VERSION: ENVELOPE_VERSION
  };
});
