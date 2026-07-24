/* sidecar/loopjob-store.js — the PURE lifecycle reducer for the LOOP store (standing objectives, S1).

   Second half of the determinism split (see loopjob.js header): loopjob.js owns the GATE math, this file
   owns the record LIFECYCLE. Both are pure — every function is a transform over (loops, args) with
   `now` / `id` / `runId` INJECTED, never read from the wall clock or rng. No Date.now / Math.random /
   new Date() / setTimeout / fs, so it passes test/lint-determinism.js exactly like cron-store.js.

   The ambient half — JSON load/persist (atomic temp+rename via the durable-store idiom), id minting
   (crypto.randomUUID), the real now-source, the runOnce fire, git — lives ONLY in sidecar/index.js and
   loopjob-driver.js.

   Surface (every op returns a NEW loops array; the input is never mutated):
     makeLoop(spec, { id, now })                     -> LoopJob
     createLoop(loops, spec, { id, now })            -> loops'
     updateLoop(loops, id, patch, { now })           -> loops'
     pauseLoop(loops, id, reason, { now })           -> loops'
     resumeLoop(loops, id, { now })                  -> loops'      // also lifts dormant/stopped
     stopLoop(loops, id, reason, { now })            -> loops'
     removeLoop(loops, id)                           -> loops'
     getLoop(loops, id)                              -> LoopJob | null
     claimFire(loops, id, { now })                   -> loops'      // advance-before-run analog
     renewHeartbeat(loops, id, { now })              -> loops'
     startIteration(loops, id, { runId, now })       -> loops'      // append a running iteration
     settleIteration(loops, id, result, { now })     -> loops'      // record the outcome, advance state
     recordVerdict(loops, id, n, verdict, ctx)       -> loops'      // approve / reject (+ cascade)
     loadEnvelope(raw)                               -> { version, loops }
     toEnvelope(loops)                               -> { version, loops }
     isValidId(id)                                   -> boolean

   A LoopJob:
     { id, name, objective, agentId, model, provider,
       gate:'review'|'auto',                 // review = stack candidates for approval; auto = apply its own work
       queueCap, maxIterations, dryStopAfter,
       workdir, branch,                      // git loop: the blessed root + the loop's own branch (null = no-git)
       enabled, state:'idle'|'running'|'waiting'|'paused'|'dormant'|'stopped',
       stopReason,                           // ALWAYS set when quiet for a non-obvious reason (truthful telemetry)
       iterationCount, dryStreak, failStreak,
       iterations: Iteration[],              // the durable ledger — the whole point of the subsystem
       budget: { perDayUsd, perIterationUsd, spentTodayUsd, day },
       createdAt, updatedAt, lastRunAt, lastRunId,
       fireClaim, heartbeatAt,               // in-flight liveness (cron-store G4.5 / NS-0 idiom)
       meta }

   An Iteration:
     { n, runId, startedAt, endedAt,
       outcome:'running'|'candidate'|'noop'|'failed'|'cancelled',
       title, summary, commit, files:[{path,bytes}], usd, error,
       verdict:'approved'|'rejected'|'discarded'|null, verdictNote, verdictAt }

   THE STACKING LAW. In gate:'review' the loop keeps working while candidates queue up, so iteration N+1 is
   built on a tree containing un-approved N. That makes the queue strictly FIFO and makes rejection
   CASCADE: rejecting #3 marks #4 and #5 'discarded' because they were built on top of it. recordVerdict
   does this in one atomic reduction and returns the cascade in the record, so the UI can (and must) warn
   before the click. The alternative — pretending #4 survives a rejected #3 — would have the app assert a
   tree state git cannot produce, which is exactly the lie this product forbids. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./loopjob.js') : (root.SK && root.SK.loopjob));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).loopjobStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LJ) {
  'use strict';

  const ENVELOPE_VERSION = 1;
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;      // one safe path component (matches the index.js agentId guard)
  const ITER_CAP = 200;                        // ledger retention; un-reviewed iterations are NEVER dropped
  const FAIL_STREAK_MAX = 3;                   // consecutive hard failures before the loop parks itself
  const TEXT_CAP = 4000, TITLE_CAP = 140, SUM_CAP = 1200, NOTE_CAP = 800, FILE_CAP = 50;

  const iso = LJ._internals.iso;
  const dayOf = LJ._internals.dayOf;

  // fields a Commander may edit. id / timestamps / run-state / ledger are NOT patchable here.
  const EDITABLE = ['name', 'objective', 'agentId', 'model', 'provider', 'gate',
    'queueCap', 'maxIterations', 'dryStopAfter', 'workdir', 'branch'];

  function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }
  function getLoop(loops, id) { return (loops || []).find(l => l && l.id === id) || null; }
  function mapLoop(loops, id, fn) { return (loops || []).map(l => (l && l.id === id ? fn(l) : l)); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function str(v, cap) { const s = v == null ? '' : String(v); return cap && s.length > cap ? s.slice(0, cap) : s; }
  function normGate(v) { return v === 'auto' ? 'auto' : 'review'; }
  function posNumOr(v, dflt) { const n = Number(v); return isFinite(n) && n >= 0 ? n : dflt; }

  function normFiles(files) {
    if (!Array.isArray(files)) return [];
    return files.slice(0, FILE_CAP).map(f => {
      if (typeof f === 'string') return { path: str(f, 400), bytes: null };
      return { path: str(f && f.path, 400), bytes: isNum(f && f.bytes) ? f.bytes : null };
    }).filter(f => f.path);
  }

  function normMeta(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const out = {};
    for (const k of Object.keys(meta)) { const v = meta[k]; if (v != null && typeof v !== 'function') out[k] = v; }
    return Object.keys(out).length ? out : null;
  }

  /* makeLoop — normalize a creation spec into a full LoopJob. A loop is born 'idle' and ENABLED: the whole
     product promise is "say what to keep doing and it goes", so there is no arm-it-later ceremony (no
     gating — a standing product law). It fires on the driver's very next tick. */
  function makeLoop(spec, ctx) {
    spec = spec || {}; ctx = ctx || {};
    const rawId = spec.id != null ? spec.id : ctx.id;
    const id = String(rawId);
    if (rawId == null || !isValidId(id)) throw new Error('loopjob-store: invalid loop id (must match ' + ID_RE + ')');
    const now = ctx.now || 0;
    const enabled = spec.enabled !== false;
    const maxIters = spec.maxIterations == null ? null : Math.max(1, parseInt(spec.maxIterations, 10) || 1);

    return {
      id: id,
      name: str(spec.name, TITLE_CAP),
      objective: str(spec.objective, TEXT_CAP),
      agentId: str(spec.agentId || 'agent', 40),
      model: spec.model != null ? str(spec.model, 200) : null,
      provider: spec.provider != null ? str(spec.provider, 60) : null,
      // REVIEW is the default and it is the safe one: nothing the loop makes is applied without a click.
      // 'auto' is the Commander's explicit "you have full access to merge" choice, per-loop, never global.
      gate: normGate(spec.gate),
      queueCap: LJ.queueCapOf({ queueCap: spec.queueCap }),
      maxIterations: maxIters,
      dryStopAfter: LJ.dryStopOf({ dryStopAfter: spec.dryStopAfter }),
      // workdir = the blessed project root this loop works in (git loop). null => the loop produces
      // workshop deliverables instead of commits, and `branch` stays null. The HOST validates blessedness;
      // this reducer only records what it was told (never trusts it as a path).
      workdir: spec.workdir != null ? str(spec.workdir, 600) : null,
      branch: spec.branch != null ? str(spec.branch, 200) : null,
      enabled: enabled,
      state: enabled ? 'idle' : 'paused',
      stopReason: null,
      iterationCount: 0,
      dryStreak: 0,
      failStreak: 0,
      iterations: [],
      budget: {
        // 0 = ungoverned, matching budgetcaps.js semantics (never "block everything").
        perDayUsd: posNumOr(spec.perDayUsd != null ? spec.perDayUsd : (spec.budget && spec.budget.perDayUsd), 0),
        perIterationUsd: posNumOr(spec.perIterationUsd != null ? spec.perIterationUsd : (spec.budget && spec.budget.perIterationUsd), 0),
        spentTodayUsd: 0,
        day: dayOf(now)
      },
      createdAt: iso(now),
      updatedAt: iso(now),
      lastRunAt: null,
      lastRunId: null,
      fireClaim: null,
      heartbeatAt: null,
      meta: normMeta(spec.meta)
    };
  }

  function createLoop(loops, spec, ctx) {
    loops = loops || [];
    const loop = makeLoop(spec, ctx);
    if (loops.some(l => l && l.id === loop.id)) throw new Error('loopjob-store: duplicate loop id ' + loop.id);
    return loops.concat([loop]);
  }

  /* updateLoop — patch EDITABLE fields. `id` is immutable (a patch.id is ignored, never copied). Budget is
     patched through its own nested keys so a partial patch can never blank the day bucket. */
  function updateLoop(loops, id, patch, ctx) {
    ctx = ctx || {}; patch = patch || {};
    const now = ctx.now || 0;
    return mapLoop(loops, id, (loop) => {
      const next = Object.assign({}, loop);
      for (const k of EDITABLE) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
      if (Object.prototype.hasOwnProperty.call(patch, 'gate')) next.gate = normGate(patch.gate);
      if (Object.prototype.hasOwnProperty.call(patch, 'queueCap')) next.queueCap = LJ.queueCapOf({ queueCap: patch.queueCap });
      if (Object.prototype.hasOwnProperty.call(patch, 'dryStopAfter')) next.dryStopAfter = LJ.dryStopOf({ dryStopAfter: patch.dryStopAfter });
      if (Object.prototype.hasOwnProperty.call(patch, 'maxIterations')) {
        next.maxIterations = patch.maxIterations == null ? null : Math.max(1, parseInt(patch.maxIterations, 10) || 1);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'name')) next.name = str(patch.name, TITLE_CAP);
      if (Object.prototype.hasOwnProperty.call(patch, 'objective')) next.objective = str(patch.objective, TEXT_CAP);
      if (patch.budget && typeof patch.budget === 'object') {
        next.budget = Object.assign({}, loop.budget);
        if (patch.budget.perDayUsd !== undefined) next.budget.perDayUsd = posNumOr(patch.budget.perDayUsd, 0);
        if (patch.budget.perIterationUsd !== undefined) next.budget.perIterationUsd = posNumOr(patch.budget.perIterationUsd, 0);
      }
      next.updatedAt = iso(now);
      return next;
    });
  }

  function pauseLoop(loops, id, reason, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapLoop(loops, id, (loop) => Object.assign({}, loop, {
      enabled: false, state: 'paused', stopReason: reason != null ? str(reason, NOTE_CAP) : null, updatedAt: iso(now)
    }));
  }

  /* resumeLoop — re-arm a loop from ANY quiet state. Resuming clears the dry streak and the fail streak:
     the Commander looked at it and said keep going, which is new information the convergence counter must
     not override. It does NOT clear the iteration ledger — the loop keeps its memory. */
  function resumeLoop(loops, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapLoop(loops, id, (loop) => Object.assign({}, loop, {
      enabled: true, state: 'idle', stopReason: null, dryStreak: 0, failStreak: 0, updatedAt: iso(now)
    }));
  }

  function stopLoop(loops, id, reason, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapLoop(loops, id, (loop) => Object.assign({}, loop, {
      enabled: false, state: 'stopped', stopReason: reason != null ? str(reason, NOTE_CAP) : 'stopped by the Commander',
      fireClaim: null, heartbeatAt: null, updatedAt: iso(now)
    }));
  }

  function removeLoop(loops, id) { return (loops || []).filter(l => !(l && l.id === id)); }

  /* claimFire — stamp the durable in-flight claim BEFORE the run launches (cron-store G4.5 idiom). The host
     persists this and only then fires, so a crash-restart inside the run window sees the claim and does not
     double-fire. Cleared on every settlement; a claim older than the driver's staleMs is reclaimed as a
     zombie by loopjob.decide so a dead holder can never wedge the loop forever. */
  function claimFire(loops, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapLoop(loops, id, (loop) => Object.assign({}, loop, { fireClaim: now, updatedAt: iso(now) }));
  }

  /* renewHeartbeat — NS-0 idiom: proof the in-flight iteration is genuinely still emitting progress, so a
     long-but-live run is not declared a zombie and re-fired. No-op unless a claim is held. */
  function renewHeartbeat(loops, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapLoop(loops, id, (loop) => (loop.fireClaim == null ? loop : Object.assign({}, loop, { heartbeatAt: now })));
  }

  /* pruneIterations — cap the ledger, NEVER dropping anything the Commander still has to rule on. Only
     verdict-settled / noop / failed rows are eligible for eviction, oldest first. A pending candidate is
     unreviewed WORK; silently evicting it would strand a real artifact. */
  function pruneIterations(its) {
    if (its.length <= ITER_CAP) return its;
    const keepAlways = new Set();
    for (const it of its) if (it.outcome === 'candidate' && !it.verdict) keepAlways.add(it.n);
    const out = [];
    let dropBudget = its.length - ITER_CAP;
    for (const it of its) {
      if (dropBudget > 0 && !keepAlways.has(it.n)) { dropBudget--; continue; }
      out.push(it);
    }
    return out;
  }

  /* startIteration — append a RUNNING iteration and take the number. iterationCount is incremented here (at
     start, not at settle) so a crash mid-iteration still burns the slot: the alternative lets a crash-loop
     re-use n forever and blow past maxIterations invisibly. */
  function startIteration(loops, id, ctx) {
    ctx = ctx || {};
    const now = ctx.now || 0;
    return mapLoop(loops, id, (loop) => {
      const n = (loop.iterationCount || 0) + 1;
      const it = {
        n: n,
        runId: ctx.runId != null ? str(ctx.runId, 80) : null,
        startedAt: iso(now), endedAt: null,
        outcome: 'running',
        title: null, summary: null, commit: null, files: [], usd: 0, error: null,
        verdict: null, verdictNote: null, verdictAt: null
      };
      return Object.assign({}, loop, {
        iterationCount: n,
        state: 'running',
        stopReason: null,
        lastRunId: it.runId,
        iterations: pruneIterations((loop.iterations || []).concat([it])),
        updatedAt: iso(now)
      });
    });
  }

  /* settleIteration — record how the newest running iteration ended and decide the loop's next state.

     result = { runId, status:'ok'|'error', text, title, summary, commit, files, usd, error, cancelled }

     Outcome resolution:
       cancelled          -> 'cancelled'  (E-STOP / Commander stop mid-iteration; costs no streak either way)
       status !== 'ok'    -> 'failed'     (failStreak++; FAIL_STREAK_MAX in a row parks the loop 'paused')
       NOTHING-TO-DO      -> 'noop'       (dryStreak++; dryStopAfter in a row parks the loop 'dormant')
       otherwise          -> 'candidate'  (dryStreak reset; enters the review queue, or auto-approves)

     A gate:'auto' loop stamps its own verdict 'approved' at settle time — it applied its own work, so there
     is nothing to queue. That verdict is a RECORD of what happened, not a fake review: the digest still
     feeds it forward as "already done", which is exactly true. */
  function settleIteration(loops, id, result, ctx) {
    result = result || {}; ctx = ctx || {};
    const now = ctx.now || 0;
    const failMax = isNum(ctx.failStreakMax) ? ctx.failStreakMax : FAIL_STREAK_MAX;

    return mapLoop(loops, id, (loop) => {
      const its = (loop.iterations || []).slice();
      // settle the newest RUNNING iteration (matched by runId when the caller supplies one — a late
      // settlement from a superseded run must never overwrite its replacement's record; the same
      // generation-fence intent as cron-driver's finishFire).
      let idx = -1;
      for (let i = its.length - 1; i >= 0; i--) {
        if (its[i].outcome !== 'running') continue;
        if (result.runId != null && its[i].runId != null && String(its[i].runId) !== String(result.runId)) continue;
        idx = i; break;
      }
      if (idx < 0) return loop;      // nothing in flight to settle (already settled, or fenced out)

      const cancelled = result.cancelled === true;
      const ok = result.status === 'ok' && !cancelled;
      let outcome;
      if (cancelled) outcome = 'cancelled';
      else if (!ok) outcome = 'failed';
      else outcome = LJ.nextOutcomeFor(result.text);

      const usd = posNumOr(result.usd, 0);
      const settled = Object.assign({}, its[idx], {
        endedAt: iso(now),
        outcome: outcome,
        title: str(result.title, TITLE_CAP) || null,
        summary: str(result.summary, SUM_CAP) || null,
        commit: result.commit != null ? str(result.commit, 80) : null,
        files: normFiles(result.files),
        usd: usd,
        error: ok ? null : (result.error != null ? str(result.error, NOTE_CAP) : (cancelled ? 'cancelled' : 'error'))
      });
      // gate:'auto' applies its own work — stamp the verdict now so it never sits in a queue nobody reads.
      if (outcome === 'candidate' && loop.gate === 'auto') {
        settled.verdict = 'approved';
        settled.verdictNote = 'auto-applied (this loop has full access to merge)';
        settled.verdictAt = iso(now);
      }
      its[idx] = settled;

      const rolled = LJ.rollBudgetDay(loop, { now: now });
      const budget = Object.assign({}, rolled.budget, {
        spentTodayUsd: ((rolled.budget && rolled.budget.spentTodayUsd) || 0) + usd
      });

      const next = Object.assign({}, loop, {
        iterations: pruneIterations(its),
        budget: budget,
        lastRunAt: iso(now),
        lastRunId: settled.runId || loop.lastRunId,
        fireClaim: null, heartbeatAt: null,
        updatedAt: iso(now)
      });

      // ---- streaks + the next state -------------------------------------------------------------------
      if (outcome === 'noop') {
        next.dryStreak = (loop.dryStreak || 0) + 1;
        next.failStreak = 0;
        if (next.dryStreak >= LJ.dryStopOf(loop)) {
          next.state = 'dormant';
          next.enabled = false;
          next.stopReason = 'nothing left to do — ' + next.dryStreak + ' passes in a row found no work';
          return next;
        }
      } else if (outcome === 'failed') {
        next.failStreak = (loop.failStreak || 0) + 1;
        if (next.failStreak >= failMax) {
          next.state = 'paused';
          next.enabled = false;
          next.stopReason = next.failStreak + ' iterations failed in a row: ' + (settled.error || 'error');
          return next;
        }
      } else if (outcome === 'candidate') {
        next.dryStreak = 0;
        next.failStreak = 0;
      }

      // still live: 'waiting' when the review queue is now full (the honest reason it goes quiet), else idle.
      const pend = LJ.pendingReviews(next).length;
      if (next.gate !== 'auto' && pend >= LJ.queueCapOf(next)) {
        next.state = 'waiting';
        next.stopReason = pend + ' waiting on your review';
      } else {
        next.state = 'idle';
        next.stopReason = null;
      }
      return next;
    });
  }

  /* recordVerdict — the review gate. verdict is 'approved' or 'rejected'.

     APPROVED: this iteration's work is accepted. (The HOST performs the actual git merge / file promotion
     BEFORE calling this — the store records what happened, it never claims an apply it did not witness.)

     REJECTED: this iteration is rejected AND every un-approved candidate stacked above it is marked
     'discarded', because they were built on top of it (THE STACKING LAW in the header). `note` is the
     Commander's reason and is the single most valuable field in the whole subsystem — loopjob.digest leads
     the next iteration's prompt with it. A rejection with no note still works, it just teaches nothing.

     Rejecting also clears the dry streak: the loop demonstrably still has work to do (it just did it wrong),
     so it must not be allowed to converge to DORMANT off the back of a rejected pass. */
  function recordVerdict(loops, id, n, verdict, ctx) {
    ctx = ctx || {};
    const now = ctx.now || 0;
    const num = parseInt(n, 10);
    const v = verdict === 'approved' ? 'approved' : 'rejected';
    const note = ctx.note != null ? str(ctx.note, NOTE_CAP) : null;

    return mapLoop(loops, id, (loop) => {
      const target = (loop.iterations || []).find(it => it && it.n === num);
      if (!target || target.outcome !== 'candidate' || target.verdict) return loop;   // nothing to rule on

      const its = (loop.iterations || []).map(it => {
        if (it.n === num) {
          return Object.assign({}, it, { verdict: v, verdictNote: note, verdictAt: iso(now) });
        }
        // cascade: only on rejection, only un-approved candidates ABOVE the rejected one.
        if (v === 'rejected' && it.n > num && it.outcome === 'candidate' && !it.verdict) {
          return Object.assign({}, it, {
            verdict: 'discarded',
            verdictNote: 'discarded — built on top of rejected #' + num,
            verdictAt: iso(now)
          });
        }
        return it;
      });

      const next = Object.assign({}, loop, { iterations: its, updatedAt: iso(now) });
      if (v === 'rejected') next.dryStreak = 0;

      // a verdict frees queue space — if the loop was parked on a full queue, that reason is now gone. This
      // is what makes the loop advance on the VERDICT rather than the clock.
      if (next.state === 'waiting') {
        const pend = LJ.pendingReviews(next).length;
        if (next.gate === 'auto' || pend < LJ.queueCapOf(next)) { next.state = 'idle'; next.stopReason = null; }
        else next.stopReason = pend + ' waiting on your review';
      }
      return next;
    });
  }

  /* loadEnvelope — normalize whatever came off disk into { version, loops }. Tolerates a JSON string, a
     parsed object, null, or garbage; fail-closed to an empty store. Drops malformed records rather than
     trusting them, and normalizes the fields a live driver reads so an old/hand-edited file cannot make the
     gate math NaN its way into firing. */
  function loadEnvelope(raw) {
    let obj = raw;
    if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (e) { obj = null; } }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.loops)) return { version: ENVELOPE_VERSION, loops: [] };
    const loops = obj.loops
      .filter(l => l && typeof l === 'object' && isValidId(l.id))
      .map(l => Object.assign({}, l, {
        gate: normGate(l.gate),
        iterations: Array.isArray(l.iterations) ? l.iterations.filter(it => it && isNum(it.n)) : [],
        iterationCount: isNum(l.iterationCount) ? l.iterationCount : 0,
        dryStreak: isNum(l.dryStreak) ? l.dryStreak : 0,
        failStreak: isNum(l.failStreak) ? l.failStreak : 0,
        budget: l.budget && typeof l.budget === 'object' ? {
          perDayUsd: posNumOr(l.budget.perDayUsd, 0),
          perIterationUsd: posNumOr(l.budget.perIterationUsd, 0),
          spentTodayUsd: posNumOr(l.budget.spentTodayUsd, 0),
          day: isNum(l.budget.day) ? l.budget.day : 0
        } : { perDayUsd: 0, perIterationUsd: 0, spentTodayUsd: 0, day: 0 }
      }));
    return { version: ENVELOPE_VERSION, loops: loops };
  }

  function toEnvelope(loops) { return { version: ENVELOPE_VERSION, loops: (loops || []).slice() }; }

  return {
    makeLoop: makeLoop,
    createLoop: createLoop,
    updateLoop: updateLoop,
    pauseLoop: pauseLoop,
    resumeLoop: resumeLoop,
    stopLoop: stopLoop,
    removeLoop: removeLoop,
    getLoop: getLoop,
    claimFire: claimFire,
    renewHeartbeat: renewHeartbeat,
    startIteration: startIteration,
    settleIteration: settleIteration,
    recordVerdict: recordVerdict,
    loadEnvelope: loadEnvelope,
    toEnvelope: toEnvelope,
    isValidId: isValidId,
    ENVELOPE_VERSION: ENVELOPE_VERSION,
    ITER_CAP: ITER_CAP,
    FAIL_STREAK_MAX: FAIL_STREAK_MAX
  };
});
