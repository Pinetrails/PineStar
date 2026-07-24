/* sidecar/loopjob.js — the PURE decision half of the LOOP subsystem (standing objectives, S1).

   A LOOP is the fourth "keep going" mechanism in the station, and the only one that advances on a
   VERDICT instead of a clock:

     Routines (cron.js)      WHEN  — wall-clock cadence; an overrun occurrence is dropped, never chained.
     Night Shift (nightshift.js) IDLE — fixed ~45min beats while the Commander is away; it picks its own focus.
     Goal loop (frontend/app/goalloop.js) — judge-gated re-fire, but browser-only, one workstream, dies with the tab.
     LOOP (this file)        UNTIL — the Commander's standing objective, iterated server-side, each iteration
                                     parked for review, the next one triggered by the Commander's verdict.

   This is the schedule-math analog of cron.js: PURE. Every function is a transform over (loop, inputs)
   with `now` INJECTED. There is NO Date.now / Math.random / new Date() / setTimeout / fs here, so it passes
   test/lint-determinism.js and is headless-testable exactly like cron.js / nightshift.js / loop.js.
   The record LIFECYCLE lives in loopjob-store.js; the tick orchestration in loopjob-driver.js; the ambient
   half (real clock, id minting, persistence, the runOnce fire) ONLY in sidecar/index.js.

   NAMING: `loop` in this repo already means runAgentLoop (sidecar/loop.js) and `loops/` at the repo root is
   the QA crew's directive folder. The product noun is LOOP; every module/record here is `loopjob*` / LoopJob
   so neither collides. The user never sees the word "loopjob".

   Surface:
     decide(loop, inp, ctx)        -> { fire, binding, pendingCount, detail }   // THE gate — may an iteration fire now?
     pendingReviews(loop)          -> Iteration[]        // candidates awaiting a verdict, oldest first
     stackedAbove(loop, n)         -> Iteration[]        // un-approved candidates built ON TOP of iteration n
     rollBudgetDay(loop, ctx)      -> loop               // reset the daily spend bucket on a new UTC day
     budgetLeft(loop, ctx)         -> number | null      // remaining daily USD headroom (null = ungoverned)
     nextOutcomeFor(text)          -> 'noop' | 'candidate'  // did the model declare convergence?
     digest(loop, ctx)             -> string             // the LEDGER BLOCK injected into the next iteration
     summarize(loop, ctx)          -> {...}              // a UI-shaped status projection (truthful-telemetry safe)

   THE CONVERGENCE LAW. A 24/7 loop that cannot admit it is finished is a money fire: "find bug fixes"
   re-finds the same bug every pass until the budget dies. Two mechanisms, both here:
     (a) `digest` hands every iteration the compacted history — what was already done, what the Commander
         APPROVED, and above all WHY anything was REJECTED. A loop with no memory is not a loop, it is a
         retry storm.
     (b) `nextOutcomeFor` reads the model's own NOTHING-TO-DO declaration; loopjob-store counts the streak
         and parks the loop DORMANT at dryStopAfter. Dormant is a truthful terminal state that costs $0 —
         never a silent idle, and never a manufactured task invented to look busy. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).loopjob = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- knobs (all overridable per-loop; these are the shipped defaults) -------------------------------
  const QUEUE_CAP_DEFAULT = 3;    // un-reviewed candidates the loop may stack before it parks itself
  const QUEUE_CAP_MIN = 1;        // 1 = strictly blocking (review each one before the next starts)
  const QUEUE_CAP_MAX = 12;
  const DRY_STOP_DEFAULT = 3;     // consecutive NOTHING-TO-DO passes before the loop goes DORMANT
  const DRY_STOP_MAX = 20;

  // the marker an iteration prints when it genuinely found nothing left to do. Matched case-insensitively
  // and anywhere in the final text, because a model will wrap it in a sentence. Deliberately ugly and
  // un-English so ordinary prose can never trip it.
  const NOTHING_MARK = /NOTHING-TO-DO/i;

  const GATES = ['halted', 'disabled', 'stopped', 'dormant', 'paused', 'max-iterations',
    'budget', 'in-flight', 'queue-full', 'concurrency', 'precheck'];

  function iso(ms) { return new Date(ms).toISOString(); }
  function dayOf(ms) { return Math.floor(ms / 86400000); }             // UTC day bucket, same idiom as nightshift.js
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  function queueCapOf(loop) { return clampInt(loop && loop.queueCap, QUEUE_CAP_MIN, QUEUE_CAP_MAX, QUEUE_CAP_DEFAULT); }
  function dryStopOf(loop) { return clampInt(loop && loop.dryStopAfter, 1, DRY_STOP_MAX, DRY_STOP_DEFAULT); }

  /* pendingReviews — the iterations sitting in the review queue: outcome 'candidate' (real work landed)
     with no verdict yet. Oldest first; the queue is FIFO by design because iteration N+1 is built ON TOP
     of N's un-approved work (see stackedAbove). Iterations that produced nothing ('noop') or died
     ('failed') are NOT review items — there is nothing to approve. */
  function pendingReviews(loop) {
    const its = (loop && loop.iterations) || [];
    return its.filter(it => it && it.outcome === 'candidate' && !it.verdict);
  }

  /* stackedAbove — every un-approved candidate with a HIGHER iteration number than n. This is the honest
     cost of a stacking review queue: iteration 5 was built on a tree that contains un-approved 3 and 4, so
     rejecting 3 invalidates 4 and 5 too. The UI MUST show this count before the Commander clicks REJECT —
     a review gate that silently discards work the user could still see is a truthful-telemetry violation. */
  function stackedAbove(loop, n) {
    const num = parseInt(n, 10);
    if (!isFinite(num)) return [];
    return pendingReviews(loop).filter(it => it.n > num);
  }

  /* rollBudgetDay — reset the loop's daily spend bucket when the UTC day advances. Returns the SAME object
     when nothing changed so callers can cheaply skip a persist. Mirrors nightshift.rollDay. */
  function rollBudgetDay(loop, ctx) {
    const now = (ctx && ctx.now) || 0;
    const b = loop && loop.budget;
    if (!b) return loop;
    const day = dayOf(now);
    if (b.day === day) return loop;
    return Object.assign({}, loop, { budget: Object.assign({}, b, { day: day, spentTodayUsd: 0 }) });
  }

  /* budgetLeft — remaining USD headroom for TODAY. null means ungoverned (no cap), matching the station's
     budgetcaps.js convention where 0/absent = "no cap" rather than "block everything". Never negative. */
  function budgetLeft(loop, ctx) {
    const now = (ctx && ctx.now) || 0;
    const rolled = rollBudgetDay(loop, { now: now });
    const b = rolled && rolled.budget;
    if (!b || !isNum(b.perDayUsd) || b.perDayUsd <= 0) return null;
    return Math.max(0, b.perDayUsd - (isNum(b.spentTodayUsd) ? b.spentTodayUsd : 0));
  }

  /* decide — THE gate. May this loop fire its next iteration right now?

     Returns { fire, binding, pendingCount, detail }. `binding` names the FIRST blocking reason (see GATES
     for the priority order) so the UI can state exactly why a loop is quiet — "queue-full: 3 waiting on you"
     reads very differently from "budget: $5.00/day spent". A loop that is quiet for an unnameable reason is
     a bug, so binding is never null when fire is false.

     Ambient facts arrive on `inp`, never read here:
       inp.halted        bool   — the durable station E-STOP (POST /api/halt), same flag night shift honors
       inp.agentBusy     bool   — the agent's run mutex is occupied by someone else
       inp.precheck      { ok, reason } | bool | undefined
                                — a PURELY-LOCAL readiness gate (credential present, agent exists, workdir
                                  still blessed). Copied from nightshift-driver's NS-2 cold-leash fix: a
                                  stand-down no model call could have avoided must not cost money or a slot.
       inp.inFlight      bool   — the driver's in-memory lease says an iteration of THIS loop is running

     NOTE the queue-full gate applies to gate:'review' only. A gate:'auto' loop applies its own work, so it
     never accumulates a review queue and never parks on one. */
  function decide(loop, inp, ctx) {
    inp = inp || {}; ctx = ctx || {};
    const now = ctx.now || 0;
    const pend = pendingReviews(loop);
    const out = (binding, detail) => ({ fire: !binding, binding: binding || null, pendingCount: pend.length, detail: detail || null });

    if (!loop) return out('disabled', 'no such loop');
    if (inp.halted) return out('halted', 'station E-STOP engaged');
    // the SPECIFIC quiet states are checked before the generic `enabled` flag, because stop/dormant/pause all
    // clear `enabled` and "disabled" would tell the Commander nothing about WHY. A loop that converged reads
    // very differently from one the Commander stopped, and the UI must be able to say which.
    if (loop.state === 'stopped') return out('stopped', loop.stopReason || null);
    if (loop.state === 'dormant') return out('dormant', loop.stopReason || 'nothing left to do');
    if (loop.state === 'paused') return out('paused', loop.stopReason || null);
    if (loop.enabled === false) return out('disabled', null);

    const maxIters = isNum(loop.maxIterations) ? loop.maxIterations : (loop.maxIterations == null ? null : parseInt(loop.maxIterations, 10));
    if (maxIters != null && isFinite(maxIters) && maxIters > 0 && (loop.iterationCount || 0) >= maxIters) {
      return out('max-iterations', (loop.iterationCount || 0) + '/' + maxIters + ' done');
    }

    const left = budgetLeft(loop, { now: now });
    if (left != null && left <= 0) return out('budget', 'daily cap $' + loop.budget.perDayUsd + ' reached');

    // in-flight: the driver's live lease OR a durable fire-claim whose heartbeat is still fresh. The durable
    // half is what survives a restart — without it a crash mid-iteration would double-fire on boot.
    if (inp.inFlight) return out('in-flight', 'iteration ' + ((loop.iterationCount || 0) + 1) + ' running');
    if (loop.fireClaim != null) {
      const staleMs = isNum(ctx.staleMs) ? ctx.staleMs : 900000;   // 15min default; driver injects maxRunMs
      const beat = isNum(loop.heartbeatAt) ? loop.heartbeatAt : loop.fireClaim;
      if (now - beat < staleMs) return out('in-flight', 'claim held');
      // a stale claim is a ZOMBIE (the holder died); fall through so the loop re-arms rather than wedging.
    }

    if (loop.gate !== 'auto' && pend.length >= queueCapOf(loop)) {
      return out('queue-full', pend.length + ' waiting on your review');
    }

    if (inp.agentBusy) return out('concurrency', 'agent busy');

    const pre = inp.precheck;
    if (pre === false) return out('precheck', null);
    if (pre && typeof pre === 'object' && pre.ok === false) return out('precheck', pre.reason || null);

    return out(null, null);
  }

  /* nextOutcomeFor — read an iteration's final text and classify it. The ONLY thing that makes an iteration
     a 'noop' is the model explicitly declaring NOTHING-TO-DO; we never infer convergence from a short reply
     or an empty diff, because "the agent said little" and "there is nothing left to do" are different facts
     and only one of them is provable from the transcript. */
  function nextOutcomeFor(text) {
    return NOTHING_MARK.test(String(text == null ? '' : text)) ? 'noop' : 'candidate';
  }

  /* digest — the LEDGER BLOCK handed to the next iteration. This is the single highest-leverage function in
     the subsystem: without it a "sweep for bugs" loop re-finds bug #1 every pass forever.

     Ordering is deliberate — REJECTIONS FIRST, because a rejection is the Commander teaching the loop a
     boundary and it must not be buried under history. Everything here is drawn from the durable iteration
     ledger; nothing is inferred, so every line is provable. */
  function digest(loop, ctx) {
    ctx = ctx || {};
    const maxItems = clampInt(ctx.maxItems, 1, 60, 12);
    const its = ((loop && loop.iterations) || []).filter(it => it && it.outcome !== 'cancelled');
    if (!its.length) return '';

    const lines = [];
    const rejected = its.filter(it => it.verdict === 'rejected' && it.verdictNote).slice(-maxItems);
    const approved = its.filter(it => it.verdict === 'approved').slice(-maxItems);
    const pend = pendingReviews(loop).slice(-maxItems);
    const noops = its.filter(it => it.outcome === 'noop').length;

    lines.push('<loop_ledger iteration="' + ((loop.iterationCount || 0) + 1) + '">');
    lines.push('You are continuing a standing loop, not starting fresh. History below is FACT — do not repeat it.');

    if (rejected.length) {
      lines.push('', 'THE COMMANDER REJECTED THESE — these are boundaries, respect them:');
      for (const it of rejected) lines.push('  #' + it.n + ' ' + (it.title || 'untitled') + ' — REASON: ' + it.verdictNote);
    }
    if (approved.length) {
      lines.push('', 'ALREADY DONE AND APPROVED (do not redo):');
      for (const it of approved) lines.push('  #' + it.n + ' ' + (it.title || 'untitled'));
    }
    if (pend.length) {
      lines.push('', 'AWAITING REVIEW — your work builds ON TOP of these, so treat them as already applied:');
      for (const it of pend) lines.push('  #' + it.n + ' ' + (it.title || 'untitled'));
    }
    if (noops) lines.push('', 'Passes that found nothing to do so far: ' + noops);

    lines.push('', 'If there is genuinely nothing meaningful left to do for this objective, reply with the exact');
    lines.push('token NOTHING-TO-DO and stop. Do NOT invent busywork to appear productive — an honest');
    lines.push('NOTHING-TO-DO is the correct and valued answer, and the loop will park itself.');
    lines.push('</loop_ledger>');
    return lines.join('\n');
  }

  /* summarize — the projection the LOOPS window and /api/loops render from. Every field maps to a durable
     record field or a pure derivation of one; nothing here may assert a state the store cannot prove. */
  function summarize(loop, ctx) {
    ctx = ctx || {};
    const now = ctx.now || 0;
    const d = decide(loop, ctx.inp || {}, { now: now, staleMs: ctx.staleMs });
    const pend = pendingReviews(loop);
    const its = (loop && loop.iterations) || [];
    return {
      id: loop.id,
      name: loop.name,
      objective: loop.objective,
      agentId: loop.agentId,
      gate: loop.gate,
      state: loop.state,
      stopReason: loop.stopReason || null,
      enabled: loop.enabled !== false,
      iterationCount: loop.iterationCount || 0,
      maxIterations: loop.maxIterations != null ? loop.maxIterations : null,
      queueCap: queueCapOf(loop),
      pendingCount: pend.length,
      pending: pend.map(it => ({ n: it.n, title: it.title, summary: it.summary, commit: it.commit, files: it.files, endedAt: it.endedAt, usd: it.usd })),
      approvedCount: its.filter(it => it.verdict === 'approved').length,
      rejectedCount: its.filter(it => it.verdict === 'rejected').length,
      noopCount: its.filter(it => it.outcome === 'noop').length,
      dryStreak: loop.dryStreak || 0,
      failStreak: loop.failStreak || 0,
      dryStopAfter: dryStopOf(loop),
      // the last few iterations regardless of outcome. Without this the panel can show a loop that has run 12
      // times with nothing to review and no way to say WHY — a failing loop would look identical to an idle
      // one. `error` is the real settled error string, never a generic "something went wrong".
      recent: its.slice(-5).map(it => ({
        n: it.n, outcome: it.outcome, title: it.title, error: it.error,
        verdict: it.verdict, endedAt: it.endedAt, usd: it.usd
      })),
      lastError: (() => { const f = its.slice().reverse().find(it => it.outcome === 'failed'); return f ? f.error : null; })(),
      budget: loop.budget ? {
        perDayUsd: loop.budget.perDayUsd || 0,
        perIterationUsd: loop.budget.perIterationUsd || 0,
        spentTodayUsd: (rollBudgetDay(loop, { now: now }).budget || {}).spentTodayUsd || 0,
        leftTodayUsd: budgetLeft(loop, { now: now })
      } : null,
      workdir: loop.workdir || null,
      branch: loop.branch || null,
      lastRunAt: loop.lastRunAt || null,
      lastRunId: loop.lastRunId || null,
      createdAt: loop.createdAt,
      // the honest "why is nothing happening" line — never a spinner over an unknown state.
      binding: d.binding,
      bindingDetail: d.detail,
      wouldFire: d.fire
    };
  }

  return {
    decide: decide,
    pendingReviews: pendingReviews,
    stackedAbove: stackedAbove,
    rollBudgetDay: rollBudgetDay,
    budgetLeft: budgetLeft,
    nextOutcomeFor: nextOutcomeFor,
    digest: digest,
    summarize: summarize,
    queueCapOf: queueCapOf,
    dryStopOf: dryStopOf,
    GATES: GATES,
    QUEUE_CAP_DEFAULT: QUEUE_CAP_DEFAULT,
    QUEUE_CAP_MIN: QUEUE_CAP_MIN,
    QUEUE_CAP_MAX: QUEUE_CAP_MAX,
    DRY_STOP_DEFAULT: DRY_STOP_DEFAULT,
    _internals: { iso: iso, dayOf: dayOf, clampInt: clampInt, NOTHING_MARK: NOTHING_MARK }
  };
});
