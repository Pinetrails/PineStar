/* node test/cloudsavecore.test.js
   Locks the durable-mirror retry/health brain (P0.2): capped exponential backoff, pending
   retained across failures, success resets health, the TRUTHFUL stale verdict, and the
   health() snapshot shape the save-dot reads. Pure logic — no fetch/DOM/timers. */
'use strict';
const A = require('./_assert.js');
const C = require('../frontend/app/cloudsavecore.js');

const S = 1000;
const now = 10_000_000;

// ---- fresh + hydrate: safe shape, malformed input tolerated ----
{
  const h = C.freshHealth();
  A.eq(h.lastPushOkAt, 0, 'fresh has no ok stamp');
  A.eq(h.consecutiveFailures, 0, 'fresh has no failures');
  const bad = C.hydrate({ lastPushOkAt: -5, consecutiveFailures: -3, nextRetryAt: 'x' });
  A.eq(bad.lastPushOkAt, 0, 'negative ok stamp clamps to 0');
  A.eq(bad.consecutiveFailures, 0, 'negative failure count clamps to 0');
  A.eq(bad.nextRetryAt, 0, 'non-numeric retry clamps to 0');
  A.eq(C.hydrate(null).consecutiveFailures, 0, 'null hydrates to a clean record');
}

// ---- backoff: 5s → 30s → 2m … capped at 5m, and never overflows for huge streaks ----
{
  A.eq(C.backoffFor(1), 5 * S, 'first retry at base (5s)');
  A.eq(C.backoffFor(2), 10 * S, 'second retry doubles (10s)');
  A.eq(C.backoffFor(3), 20 * S, 'third retry doubles again (20s)');
  A.ok(C.backoffFor(7) === C.RETRY_MAX_MS, 'deep streak caps at 5m');
  A.eq(C.backoffFor(9999), C.RETRY_MAX_MS, 'huge streak stays capped, never Infinity');
  A.ok(C.RETRY_MAX_MS === 5 * 60 * S, 'cap is 5 minutes');
}

// ---- failure records: streak grows, retry scheduled, lastPushFailAt stamped ----
{
  let h = C.recordFailure(C.freshHealth(), now);
  A.eq(h.consecutiveFailures, 1, 'first failure → streak 1');
  A.eq(h.lastPushFailAt, now, 'failure stamps lastPushFailAt');
  A.eq(h.nextRetryAt, now + 5 * S, 'first failure schedules a 5s retry');
  A.eq(h.lastPushOkAt, 0, 'a failure does not fabricate an ok stamp');
  h = C.recordFailure(h, now + S);
  A.eq(h.consecutiveFailures, 2, 'second failure → streak 2');
  A.eq(h.nextRetryAt, (now + S) + 10 * S, 'second failure schedules a 10s retry');
}

// ---- retryDue: honors the backoff window; no-streak is always due ----
{
  A.ok(C.retryDue(C.freshHealth(), now), 'a clean record is always allowed to push');
  const h = C.recordFailure(C.freshHealth(), now);       // nextRetryAt = now + 5s
  A.ok(!C.retryDue(h, now + S), 'inside the backoff window a retry is NOT due');
  A.ok(C.retryDue(h, now + 5 * S), 'at the deadline the retry becomes due');
  A.ok(C.retryDue(h, now + 6 * S), 'past the deadline the retry is due');
}

// ---- success resets health: streak → 0, retry cleared, ok stamped (failure history retained) ----
{
  let h = C.recordFailure(C.recordFailure(C.freshHealth(), now), now + S);
  A.eq(h.consecutiveFailures, 2, 'precondition: a live 2-failure streak');
  const failAt = h.lastPushFailAt;
  h = C.recordSuccess(h, now + 3 * S);
  A.eq(h.consecutiveFailures, 0, 'success clears the failure streak');
  A.eq(h.lastPushOkAt, now + 3 * S, 'success stamps lastPushOkAt');
  A.eq(h.nextRetryAt, 0, 'success cancels the pending retry');
  A.eq(h.lastPushFailAt, failAt, 'success preserves the last-failure timestamp (diagnostics)');
}

// ---- stale verdict: TRUTHFUL — only stale with a live streak AND an aged/absent last success ----
{
  const HOUR = 60 * 60 * S;
  A.ok(!C.isStale(C.freshHealth(), now), 'a clean record is never stale');
  // succeeded recently, then a failure just now → not yet stale (last ok is fresh)
  let h = C.recordSuccess(C.freshHealth(), now);
  h = C.recordFailure(h, now + S);
  A.ok(!C.isStale(h, now + S), 'a fresh success + a new failure is NOT stale yet');
  // same streak but the clock has moved > 60m past the last success → stale
  A.ok(C.isStale(h, now + HOUR + S), 'a failure streak with a >60m-old last success IS stale');
  // never succeeded but failing → stale immediately (mirror was never proven)
  const never = C.recordFailure(C.freshHealth(), now);
  A.ok(C.isStale(never, now), 'failing with no confirmed push ever → stale');
  // recovery clears staleness even if the clock is far ahead
  const recovered = C.recordSuccess(never, now + HOUR + S);
  A.ok(!C.isStale(recovered, now + HOUR + 2 * S), 'a successful push clears staleness');
}

// ---- snapshot: the exact shape CloudSave.health() exposes to the UI ----
{
  const h = C.recordFailure(C.freshHealth(), now);
  const snap = C.snapshot(h, now);
  A.eq(Object.keys(snap).sort().join(','), 'consecutiveFailures,lastPushFailAt,lastPushOkAt,nextRetryAt,stale', 'health snapshot has the documented keys');
  A.eq(snap.stale, true, 'snapshot surfaces the stale verdict (failing, never confirmed)');
  A.eq(snap.consecutiveFailures, 1, 'snapshot carries the failure streak');
  const clean = C.snapshot(C.freshHealth(), now);
  A.eq(clean.stale, false, 'a clean snapshot is not stale');
}

A.report('cloudsavecore');
