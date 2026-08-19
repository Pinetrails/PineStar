/* node test/failopen.test.js — the tagged fail-open helper (sidecar/failopen.js).
   The law this file guards (failure-learning lane, 2026-08-17): a fail-open background pass must
   never fail INVISIBLY — reflection was dead on trunk for weeks behind a bare empty catch handler.
   swallow(tag) keeps the fail-open contract (never rethrows) but leaves a trace: a throttled
   console.warn + a per-tag counter. The counter is the "prove it fires" hook: reject into the
   envelope, read counts(). */
'use strict';
const A = require('./_assert.js');
const { swallow, counts, resetForTests } = require('../sidecar/failopen.js');

(async () => {
  // ---- A. the handler swallows (fail-open contract intact) and counts (visibility contract new) ----
  resetForTests();
  await Promise.reject(new Error('boom')).catch(swallow('t.envelope'));
  A.eq(counts()['t.envelope'], 1, 'a rejection into swallow() is counted — the envelope provably fired');
  await Promise.reject(new Error('boom2')).catch(swallow('t.envelope'));
  A.eq(counts()['t.envelope'], 2, 'counter accumulates per tag');

  // ---- B. value-default form preserves the .catch(() => null) call-site semantics ----
  const v = await Promise.reject(new Error('x')).catch(swallow('t.default', null));
  A.eq(v, null, 'swallow(tag, null) resolves the chain to null (drop-in for a bare null default)');
  const u = await Promise.reject(new Error('x')).catch(swallow('t.plain'));
  A.eq(u === undefined, true, 'swallow(tag) resolves to undefined (drop-in for a bare empty handler)');

  // ---- C. never throws, whatever the rejection reason looks like ----
  A.notThrows(() => swallow('t.weird')(null), 'null error');
  A.notThrows(() => swallow('t.weird')({ message: { toString: null } }), 'hostile message object');
  A.notThrows(() => swallow()(new Error('untagged')), 'missing tag still counts + warns');
  A.eq(counts()['untagged'] >= 1, true, 'missing tag lands under "untagged", not lost');

  // ---- D. the counter NEVER throttles (only the warn does) — a long-running failure stays measurable ----
  resetForTests();
  const h = swallow('t.stuck-loop');
  for (let i = 0; i < 137; i++) h(new Error('every 60s forever'));
  A.eq(counts()['t.stuck-loop'], 137, 'all 137 swallowed errors counted despite warn throttling');

  // ---- E. counts() is a snapshot, not the live store — a caller cannot blind the trace ----
  const snap = counts();
  snap['t.stuck-loop'] = 0;
  A.eq(counts()['t.stuck-loop'], 137, 'mutating the snapshot does not clear the real tally');

  A.report('failopen helper');
})();
