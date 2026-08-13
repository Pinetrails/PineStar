'use strict';
const A = require('./_assert.js');
const P = require('../sidecar/recovery-policy.js');

A.eq(P.providerFailure({ classification: { shouldCompress: true, reason: 'context_overflow' }, canCompress: true, recoveriesUsed: 0, maxRecoveries: 1 }),
  { action: 'compress', reason: 'context_overflow', retryable: true, delayMs: 0 }, 'compression is the first recovery path');
A.eq(P.providerFailure({ classification: { shouldFallback: true, reason: 'overloaded' }, hasFallback: true, recoveriesUsed: 0, maxRecoveries: 1 }).action,
  'fallback', 'available fallback outranks same-provider retry');
A.eq(P.providerFailure({ classification: { shouldFallback: true, retryable: true, reason: 'overloaded' }, hasFallback: false, retriesUsed: 0, maxRetries: 6 }).action,
  'retry', 'exhausted fallback chain uses bounded same-provider retry');
A.eq(P.providerFailure({ classification: { retryable: true, reason: 'timeout', retryAfterMs: 2500 }, retriesUsed: 1, maxRetries: 6 }).delayMs,
  2500, 'server retry-after outranks the local rung');
A.eq(P.providerFailure({ classification: { retryable: true }, retriesUsed: 6, maxRetries: 6 }).action,
  'fail', 'retry budget is a hard bound');
A.eq(P.providerFailure({ classification: { retryable: true }, preStreamRetriesExhausted: true, retriesUsed: 0, maxRetries: 6 }).action,
  'fail', 'adapter-exhausted pre-stream ladder is never multiplied');
A.eq(P.providerFailure({ classification: { retryable: true }, cancelled: true }).action,
  'fail', 'cancellation cannot enter recovery');
A.report('recovery-policy.test');
