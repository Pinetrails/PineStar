/* node test/cloudsave-unknown.test.js — SAVE-UNKNOWN escape test (the July-19 "my save got deleted" incident).

   Before the fix, CloudSave.pull() mapped EVERY failure — network error, timeout, and an auth-refused 403
   (lost/stale per-launch token) — to null, and reconcile() treated null as "no durable save exists". With the
   localStorage cache also gone (webview cache purge on update), boot fell through to the first-run creation
   ceremony over an intact durable save: the app asserted "you have no save" when the harness proved no such
   thing. This locks the truth: only a definitive 200 "empty" answer may present as no-save; forbidden/
   unreachable with no local cache must hand boot the save-unknown sentinel so it gates and retries.

   Runs cloudsave.js in Node with a stubbed fetch, mirroring cloudsave-refusal.test.js. */
'use strict';
const A = require('./_assert.js');

let nextPull = null;   // () => Promise<Response-ish> for the next GET
global.fetch = (url, init) => {
  const method = (init && init.method) || 'GET';
  if (method === 'GET' && nextPull) return nextPull();
  // POSTs (the seed-from-local push path) — accept quietly so flush timers settle clean
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
};

const CloudSave = require('../frontend/app/cloudsave.js');
const doc = (updatedAt) => ({ schema: 'starnet.save', version: 3, updatedAt, agent: { id: 'agent', name: 'NOVA' } });

(async () => {
  // ---- 1. auth-refused pull (403) + NO local cache → save-unknown sentinel, reason 'forbidden' ----
  nextPull = () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
  let r = await CloudSave.reconcile(null);
  A.ok(CloudSave.isUnknownSentinel(r), 'a 403 pull with no local cache yields the save-unknown sentinel, never "no save"');
  A.eq(r.reason, 'forbidden', 'the sentinel names the auth refusal so the gate can say so honestly');
  A.eq(CloudSave.isFutureSentinel(r), false, 'the unknown sentinel is not mistaken for the future-save sentinel');
  A.eq(CloudSave.pullOutcome(), 'forbidden', 'pullOutcome() reports what the pull actually proved');

  // ---- 2. network failure (sidecar unreachable) + NO local cache → sentinel, reason 'unreachable' ----
  nextPull = () => Promise.reject(new Error('ECONNREFUSED'));
  r = await CloudSave.reconcile(null);
  A.ok(CloudSave.isUnknownSentinel(r), 'an unreachable sidecar with no local cache yields the sentinel');
  A.eq(r.reason, 'unreachable', 'network failure reads as unreachable');

  // ---- 3. definitive 200 empty answer + NO local cache → null (genuine first run; onboarding allowed) ----
  nextPull = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ save: null }) });
  r = await CloudSave.reconcile(null);
  A.eq(r, null, 'a definitive 200-empty answer is the ONLY no-local path that presents as no-save');
  A.eq(CloudSave.pullOutcome(), 'empty', 'a 200 with no save proves empty');

  // ---- 4. auth-refused pull + local cache PRESENT → resume from local (no sentinel, no data loss) ----
  nextPull = () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
  const local = doc(100);
  r = await CloudSave.reconcile(local);
  A.eq(r, local, 'with a local cache in hand, a refused pull still resumes from local');
  A.eq(CloudSave.isUnknownSentinel(r), false, 'a real save doc is never sentinel-shaped');

  // ---- 5. 5xx server error + NO local cache → sentinel 'unreachable' (a sick sidecar proves nothing) ----
  nextPull = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
  r = await CloudSave.reconcile(null);
  A.ok(CloudSave.isUnknownSentinel(r), 'a 5xx with no local cache yields the sentinel');
  A.eq(r.reason, 'unreachable', 'a server error reads as unreachable, not as an auth refusal');

  A.report('cloudsave-unknown');
})().catch(e => { console.log('FAIL: unhandled — ' + (e && e.stack || e)); process.exit(1); });
