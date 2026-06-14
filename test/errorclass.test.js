/* node test/errorclass.test.js — API error classification truth table (L3.S1).
   Pure: builds error objects shaped like the openrouter adapter / node fetch throws, asserts reason +
   action flags. The cold-catalog guard (contextLimit 0) must NOT mislabel a bare 400 as context_overflow. */
'use strict';
const A = require('./_assert.js');
const { classifyApiError, REASONS } = require('../sidecar/providers/errorClass.js');

// openrouter-adapter-shaped error: `new Error('openrouter http <s> — <detail>')` with .status set
function httpErr(status, detail) { return Object.assign(new Error('openrouter http ' + status + (detail ? ' — ' + detail : '')), { status: status }); }
function bodyErr(status, body) { return Object.assign(new Error('api error'), { status: status, body: body }); }
const R = (err, ctx) => classifyApiError(err, ctx || {});

// ---- A. HTTP status -> reason + headline action flags ----
{
  A.eq(R(httpErr(401)).reason, 'auth', '401 -> auth');
  A.eq(R(httpErr(401)).retryable, false, 'auth not retryable');
  A.eq(R(httpErr(401)).shouldRotateCredential, true, 'auth -> rotate credential');

  A.eq(R(httpErr(402, 'insufficient credits')).reason, 'billing', '402 out-of-credits -> billing');
  A.eq(R(httpErr(402, 'insufficient credits')).retryable, false, 'billing not retryable (no point burning attempts)');
  A.eq(R(httpErr(402, 'rate limit resets at midnight')).reason, 'rate_limit', '402 that is really a rate window -> rate_limit');

  A.eq(R(httpErr(429, 'slow down')).reason, 'rate_limit', '429 -> rate_limit');
  A.eq(R(httpErr(429)).retryable, true, 'rate_limit retryable');

  A.eq(R(httpErr(500)).reason, 'server_error', '500 -> server_error');
  A.eq(R(httpErr(500)).retryable, true, 'server_error retryable');
  A.eq(R(httpErr(500)).shouldFallback, true, 'server_error -> fallback provider');

  A.eq(R(httpErr(503, 'overloaded')).reason, 'overloaded', '503 -> overloaded');
  A.eq(R(httpErr(502)).reason, 'overloaded', '502 -> overloaded');
  A.eq(R(httpErr(504)).reason, 'timeout', '504 -> timeout');
  A.eq(R(httpErr(408)).reason, 'timeout', '408 -> timeout');

  A.eq(R(httpErr(404, 'no endpoints found for model')).reason, 'model_not_found', '404 -> model_not_found');
  A.eq(R(httpErr(404)).shouldFallback, true, 'model_not_found -> fallback');
}

// ---- B. 400 ambiguity: context vs format, gated by the cold-catalog guard ----
{
  A.eq(R(httpErr(400, 'maximum context length is 8192 tokens')).reason, 'context_overflow', '400 w/ context message -> context_overflow');
  A.eq(R(httpErr(400, 'maximum context length is 8192 tokens')).shouldCompress, true, 'context_overflow -> compress');

  // bare 400, COLD catalog (contextLimit 0) -> must fall to format_error, NOT context_overflow
  A.eq(R(httpErr(400, 'bad request'), { contextLimit: 0, approxTokens: 999999 }).reason, 'format_error', 'cold catalog: bare 400 -> format_error (not overflow)');
  A.eq(R(httpErr(400, 'bad request')).retryable, false, 'format_error not retryable');

  // bare 400, WARM catalog + over the ratio -> context_overflow
  A.eq(R(httpErr(400, 'bad request'), { contextLimit: 8000, approxTokens: 5000 }).reason, 'context_overflow', 'warm catalog + over ratio -> context_overflow');
  // bare 400, WARM catalog + under the ratio -> format_error
  A.eq(R(httpErr(400, 'bad request'), { contextLimit: 8000, approxTokens: 100 }).reason, 'format_error', 'warm catalog + under ratio -> format_error');
}

// ---- C. structured error-code (no HTTP status) + metadata.raw unwrap ----
{
  A.eq(R(bodyErr(null, { error: { code: 'context_length_exceeded', message: 'too long' } })).reason, 'context_overflow', 'structured context_length_exceeded code');
  A.eq(R(bodyErr(null, { error: { code: 'insufficient_quota', message: 'pay up' } })).reason, 'billing', 'structured insufficient_quota -> billing');
  // a 400 that ALSO carries a structured context code is caught inside the 400 branch (status wins, code consulted)
  A.eq(R(bodyErr(400, { error: { code: 'context_length_exceeded', message: 'x' } })).reason, 'context_overflow', '400 + context code -> context_overflow');
  // metadata.raw is folded into the classified message
  const raw = R(bodyErr(429, { error: { message: 'Provider error', metadata: { raw: 'upstream said rate limited' } } }));
  A.ok(/upstream said rate limited/.test(raw.message), 'metadata.raw unwrapped into message');
}

// ---- D. content policy beats everything ----
{
  A.eq(R(httpErr(400, 'flagged by content policy')).reason, 'content_policy_blocked', 'content policy wins over a 400');
  A.eq(R(new Error('request blocked by moderation')).reason, 'content_policy_blocked', 'moderation message -> content_policy_blocked');
}

// ---- E. transport / network codes -> timeout (retryable) ----
{
  A.eq(R(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).reason, 'timeout', 'ECONNRESET -> timeout');
  A.eq(R(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })).reason, 'timeout', 'node fetch cause.code -> timeout');
  A.eq(R(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).retryable, true, 'transport timeout retryable');
}

// ---- F. unknown -> retryable; statusCode echoed; message preserved ----
{
  const u = R(new Error('something weird happened'));
  A.eq(u.reason, 'unknown', 'unrecognized -> unknown');
  A.eq(u.retryable, true, 'unknown is retryable (one more attempt is safe-ish)');
  A.eq(R(httpErr(429)).statusCode, 429, 'statusCode echoed');
  A.eq(R(httpErr(500, 'boom')).statusCode, 500, 'statusCode echoed for 5xx');
  A.ok(/boom/.test(R(httpErr(500, 'boom')).message), 'detail preserved in message');
}

// ---- G. every reason in REASONS yields a complete, well-typed verdict ----
{
  for (const k of Object.keys(REASONS)) {
    const f = REASONS[k];
    A.ok(typeof f.retryable === 'boolean' && typeof f.shouldFallback === 'boolean' && typeof f.shouldCompress === 'boolean' && typeof f.shouldRotateCredential === 'boolean', 'reason "' + k + '" has all four boolean flags');
  }
}

A.report('errorclass.test');
