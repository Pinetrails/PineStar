/* node test/cloudsave-refusal.test.js — EL-11 FIX 1 escape test ("the worst lie class").

   The sidecar answers REFUSED writes as HTTP 200 { ok:false, ... } (degraded workspace / stale stamp /
   unreadable prior). Before the fix, cloudsave.js flush() checked only Response.ok, so a refused write
   stamped lastPushOkAt and the save-dot claimed a healthy backup over a write that never landed —
   permanent silent divergence. This locks the truth: a 200 { ok:false } body is a FAILED push, and
   degraded:true latches its own persistent, renderable state.

   Runs cloudsave.js in Node with a stubbed fetch (it requires cloudsavecore.js itself). A.report()
   process.exit()s, so backoff timers armed by the failure path never hang the run. */
'use strict';
const A = require('./_assert.js');

// stub fetch BEFORE requiring cloudsave.js — flush() calls the global.
const responses = [];
global.fetch = () => {
  const r = responses.shift() || { status: 200, body: { ok: true } };
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: () => Promise.resolve(r.body)
  });
};

const CloudSave = require('../frontend/app/cloudsave.js');
const doc = (updatedAt) => ({ schema: 'starnet.save', version: 3, updatedAt, agent: { id: 'agent', name: 'NOVA' } });

(async () => {
  // ---- 1. degraded refusal: HTTP 200 { ok:false, degraded:true } must NOT stamp health OK ----
  responses.push({ status: 200, body: { ok: false, error: 'workspace written by newer StarNet', degraded: true } });
  CloudSave.push(doc(10));
  const landed1 = await CloudSave.flush({ force: true });
  A.eq(landed1, false, 'a 200 { ok:false, degraded:true } body is a FAILED push, not a success');
  let h = CloudSave.health();
  A.ok(h.consecutiveFailures >= 1, 'the refusal is recorded as a push failure');
  A.eq(h.lastPushOkAt, 0, 'lastPushOkAt is NOT stamped on a refused write (the old lie)');
  A.eq(h.degraded, true, 'degraded:true gets its OWN persistent state the save-dot can render');

  // ---- 2. a non-degraded refusal (stale stamp) also fails, and clears the degraded verdict ----
  responses.push({ status: 200, body: { ok: false, stale: true, updatedAt: 999 } });
  CloudSave.push(doc(20));
  const landed2 = await CloudSave.flush({ force: true });
  A.eq(landed2, false, 'a 200 { ok:false, stale:true } body is also a FAILED push');
  h = CloudSave.health();
  A.ok(h.consecutiveFailures >= 2, 'the streak grows across refusals');
  A.eq(h.degraded, false, 'a parsed non-degraded answer re-proves the workspace is not degraded');

  // ---- 3. an ok:true body is a REAL success: health recovers, streak clears ----
  responses.push({ status: 200, body: { ok: true, updatedAt: 30 } });
  CloudSave.push(doc(30));
  const landed3 = await CloudSave.flush({ force: true });
  A.eq(landed3, true, 'a 200 { ok:true } body lands');
  h = CloudSave.health();
  A.eq(h.consecutiveFailures, 0, 'success clears the failure streak');
  A.ok(h.lastPushOkAt > 0, 'success stamps lastPushOkAt');
  A.eq(h.degraded, false, 'success proves the workspace accepts writes');

  // ---- 4. a non-JSON 200 (older sidecar / dev shim) still counts as landed — no false alarm ----
  responses.push({ status: 200, body: undefined });
  global.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('no body')) });
  CloudSave.push(doc(40));
  const landed4 = await CloudSave.flush({ force: true });
  A.eq(landed4, true, 'a non-JSON 200 keeps the old trust (backward compatible with older sidecars)');

  // ---- 5. HTTP-level failure still fails (pre-existing behavior preserved) ----
  global.fetch = () => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'EPERM' }) });
  CloudSave.push(doc(50));
  const landed5 = await CloudSave.flush({ force: true });
  A.eq(landed5, false, 'a non-2xx status is still a failed push');
  A.ok(CloudSave.health().consecutiveFailures >= 1, 'the HTTP failure is recorded');

  A.report('cloudsave-refusal');
})().catch(e => { console.log('FAIL: unhandled — ' + (e && e.stack || e)); process.exit(1); });
