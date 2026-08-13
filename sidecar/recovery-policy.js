/* Central, pure recovery decisions for model-stream failures.
 *
 * The loop performs the actions; this module owns ordering and boundedness so provider adapters, fallback
 * wiring, and future UIs read one policy instead of reimplementing subtly different retry ladders. Tool-effect
 * retries are intentionally absent: those require the durable prepared/dispatched classification first. */
'use strict';

const RETRY_DELAYS_MS = [400, 1200, 4000, 10000, 30000, 60000];

function finite(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

function providerFailure(input) {
  const i = input || {};
  const cls = i.classification || {};
  if (i.cancelled) return { action: 'fail', reason: 'cancelled', retryable: false, delayMs: 0 };
  if (cls.shouldCompress && i.canCompress && finite(i.recoveriesUsed, 0) < finite(i.maxRecoveries, 0)) {
    return { action: 'compress', reason: String(cls.reason || 'context_overflow'), retryable: true, delayMs: 0 };
  }
  if ((cls.shouldFallback || cls.shouldRotateCredential) && i.hasFallback
      && finite(i.recoveriesUsed, 0) < finite(i.maxRecoveries, 0)) {
    return { action: 'fallback', reason: String(cls.reason || 'provider_failure'), retryable: true, delayMs: 0, rotate: !!cls.shouldRotateCredential };
  }
  const retriesUsed = Math.max(0, finite(i.retriesUsed, 0));
  const maxRetries = Math.max(0, finite(i.maxRetries, RETRY_DELAYS_MS.length));
  const fallbackUnavailable = !cls.shouldFallback || !i.hasFallback;
  if (!i.preStreamRetriesExhausted && cls.retryable && fallbackUnavailable && retriesUsed < maxRetries) {
    const local = RETRY_DELAYS_MS[Math.min(retriesUsed, RETRY_DELAYS_MS.length - 1)];
    return {
      action: 'retry', reason: String(cls.reason || 'transient'), retryable: true,
      delayMs: Math.min(60000, Math.max(local, Math.max(0, finite(cls.retryAfterMs, 0))))
    };
  }
  return { action: 'fail', reason: String(cls.reason || 'unrecoverable'), retryable: !!cls.retryable, delayMs: 0 };
}

module.exports = { providerFailure, RETRY_DELAYS_MS };
