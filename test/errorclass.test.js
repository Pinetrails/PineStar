/* node test/errorclass.test.js — API error classification truth table (L3.S1).
   Pure: builds error objects shaped like the openrouter adapter / node fetch throws, asserts reason +
   action flags. The cold-catalog guard (contextLimit 0) must NOT mislabel a bare 400 as context_overflow. */
'use strict';
const A = require('./_assert.js');
const { classifyApiError, REASONS } = require('../sidecar/providers/errorClass.js');
const { friendlyError, KINDS } = require('../frontend/app/friendlyerror.js');

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

// ---- H6.1: server-stated wait extraction (Retry-After / reset_at), pure & clockless ----
{
  let c = R({ status: 429, headers: { 'Retry-After': '30' } });
  A.eq(c.retryAfterMs, 30000, 'Retry-After: 30 -> 30000ms relative');
  A.eq(c.resetAtMs, null, 'a relative Retry-After leaves resetAtMs null');

  c = R({ status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
  A.eq(c.retryAfterMs, null, 'an HTTP-date Retry-After is not a relative delay');
  A.eq(c.resetAtMs, Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'), 'HTTP-date Retry-After -> absolute resetAtMs');

  c = R({ status: 429, headers: { 'x-ratelimit-reset': '1900000000' } });
  A.eq(c.resetAtMs, 1900000000 * 1000, 'X-RateLimit-Reset epoch-seconds -> *1000 resetAtMs');

  c = R({ status: 429, message: 'Rate limit exceeded. Please try again in 1.5s.' });
  A.eq(c.retryAfterMs, 1500, '"try again in 1.5s" -> 1500ms');

  c = R({ status: 429, message: 'Too many requests, retry in 2 minutes' });
  A.eq(c.retryAfterMs, 120000, '"retry in 2 minutes" -> 120000ms');

  c = R({ status: 500, message: 'internal error' });
  A.eq(c.retryAfterMs, null, 'no hint -> retryAfterMs null');
  A.eq(c.resetAtMs, null, 'no hint -> resetAtMs null');

  c = R({ status: 429, headers: { 'retry-after': 'soon-ish' } });
  A.eq(c.reason, 'rate_limit', 'unparseable Retry-After still classifies normally');
  A.eq(c.retryAfterMs, null, 'unparseable Retry-After -> null (no crash)');
}

// ---- I. friendlyError (frontend) — the BEGINNER-FACING layer over the classifier (B5). It turns the raw
//        thrown Error / in-band error string the COMMS panel sees into { userMessage, kind, retryable, action,
//        raw }, leading with plain language and pointing non-retryable faults at the right destination. ----
const F = (err, status) => friendlyError(err, status);
{
  // 5xx / "sidecar HTTP 5xx" -> retryable server_error
  let v = F(new Error('sidecar HTTP 500'));
  A.eq(v.kind, 'server_error', '5xx -> server_error');
  A.eq(v.retryable, true, 'server_error retryable');
  A.eq(v.action, null, 'server_error has no deep-link action');
  A.ok(/local StarNet service hit an error/i.test(v.userMessage), 'server_error leads with the friendly headline');
  A.ok(/sidecar HTTP 500/.test(v.raw), 'raw technical text preserved for the dim sub-line');
  A.eq(F({ status: 503 }).kind, 'server_error', 'a bare 503 status -> server_error');

  // network / sidecar-unreachable -> retryable network
  v = F(new Error('cannot reach the STARNET sidecar — start it with `npm start`'));
  A.eq(v.kind, 'network', 'sidecar-unreachable -> network');
  A.eq(v.retryable, true, 'network retryable');
  A.ok(/Can't reach StarNet's local service/i.test(v.userMessage), 'network friendly headline');
  A.eq(F(new Error('Failed to fetch')).kind, 'network', 'browser "Failed to fetch" -> network');

  // 429 / rate / quota -> retryable rate_limit
  v = F(new Error('sidecar HTTP 429'));
  A.eq(v.kind, 'rate_limit', '429 -> rate_limit');
  A.eq(v.retryable, true, 'rate_limit retryable');
  A.ok(/too many requests|busy/i.test(v.userMessage), 'rate_limit friendly headline');
  A.eq(F(new Error('Rate limit exceeded')).kind, 'rate_limit', '"rate limit" message -> rate_limit');

  // 401 / 403 / auth -> NOT retryable, action = settings
  v = F(new Error('sidecar HTTP 401'));
  A.eq(v.kind, 'auth', '401 -> auth');
  A.eq(v.retryable, false, 'auth not retryable');
  A.eq(v.action, 'settings', 'auth points at Settings');
  A.ok(/ChatGPT/i.test(v.userMessage) && /key/i.test(v.userMessage), 'auth friendly headline offers a fix path (add a key or sign in with ChatGPT)');
  // EL-11 FIX 2: a "sidecar HTTP 403" is OUR OWN token gate (stale X-StarNet-Token after a crash+respawn), not
  // a provider key problem — it takes the reload door, never "🔑 Add a key". Provider 403s still read as auth.
  A.eq(F(new Error('sidecar HTTP 403')).kind, 'stale_session', 'sidecar 403 -> stale_session (the station restarted)');
  A.eq(F(new Error('sidecar HTTP 403')).action, 'reload', 'stale_session offers the reload door');
  A.eq(F(new Error('invalid api key')).kind, 'auth', '"invalid api key" -> auth');

  v = F(new Error('ChatGPT sign-in needed: Not signed in to ChatGPT'));
  A.eq(v.kind, 'oauth', 'ChatGPT sign-in error -> oauth');
  A.eq(v.retryable, false, 'oauth auth is not a blind retry');
  A.eq(v.action, 'settings', 'oauth points at Settings');
  A.ok(/ChatGPT sign-in/i.test(v.userMessage), 'oauth friendly headline names ChatGPT sign-in');

  // capability denied -> NOT retryable, action = refit (the TRUE unlock: place the gear; a station quest minted on
  // this denial completes by PLACEMENT, never a SKILLS toggle). Copy names the exact power + gear.
  v = F(new Error('no web — capability is off'));
  A.eq(v.kind, 'capdenied', 'capdenied forwarded string -> capdenied');
  A.eq(v.retryable, false, 'capdenied not retryable');
  A.eq(v.action, 'refit', 'capdenied points at REFIT (place the gear), not the SKILLS list');
  A.eq(v.cap, 'web', 'capdenied parses the missing capability off the raw message');
  A.ok(/WEB ACCESS/.test(v.userMessage) && /DISH/.test(v.userMessage) && /REFIT/.test(v.userMessage), 'capdenied headline names the power (WEB ACCESS), the gear (DISH), and the door (REFIT)');
  A.eq(F(new Error('capdenied: terminal')).kind, 'capdenied', 'literal capdenied token -> capdenied');

  // timeout vs user-abort: a user cancel is a quiet, non-retryable "Stopped."; a real timeout is retryable.
  v = F(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));
  A.eq(v.kind, 'user_abort', 'AbortError -> user_abort');
  A.eq(v.retryable, false, 'user_abort offers no retry chip');
  A.eq(v.action, null, 'user_abort is not actionable');
  A.eq(v.userMessage, 'Stopped.', 'user_abort is a calm cancel, not a scary error');
  v = F(new Error('sidecar HTTP 504'));
  A.eq(v.kind, 'timeout', '504 -> timeout');
  A.eq(v.retryable, true, 'timeout retryable');
  A.ok(/timed out/i.test(v.userMessage), 'timeout friendly headline');
  A.eq(F(new Error('request timed out')).kind, 'timeout', '"timed out" message -> timeout');

  // 402 billing -> Settings; 404 model-not-found -> Settings
  A.eq(F(new Error('sidecar HTTP 402')).kind, 'billing', '402 -> billing');
  A.eq(F(new Error('sidecar HTTP 402')).action, 'settings', 'billing points at Settings');
  A.eq(F(new Error('sidecar HTTP 402')).retryable, false, 'billing not retryable');
  A.eq(F(new Error('sidecar HTTP 404')).kind, 'model_not_found', '404 -> model_not_found');
  A.eq(F(new Error('sidecar HTTP 404')).action, 'settings', 'model_not_found points at Settings');

  // mid-run token death (2026-07-22): the openai-compatible adapter labels HTTP failures with the provider
  // name for device-OAuth providers, so a 401 mid-stream lands on the ⏼ RECONNECT door, never "＋ Add a key"
  // (a key field is a dead end for a keyless subscription sign-in). grok+403 stays the xAI-key door: that's
  // the allowlist yank, where RECONNECT is doomed by design.
  v = F(new Error('Grok (xAI) http 401 - invalid access token'));
  A.eq(v.kind, 'oauth', 'labeled grok mid-run 401 -> oauth reconnect class');
  A.eq(v.provider, 'grok', 'labeled grok 401 resolves the grok provider (door reads RECONNECT GROK)');
  v = F(new Error('Kimi for Coding http 401 - token expired'));
  A.eq(v.kind, 'oauth', 'labeled kimi mid-run 401 -> oauth reconnect class');
  A.eq(v.provider, 'kimi', 'labeled kimi 401 resolves the kimi provider');
  A.eq(F(new Error('Grok (xAI) http 403 - oauth not enabled for this account')).kind, 'grok_oauth_unavailable',
    'grok 403 keeps routing to the xAI API-key door (allowlist yank — reconnect is doomed)');

  // unknown / default -> friendly generic + retryable, with the raw text kept for debugging
  v = F(new Error('something weird happened'));
  A.eq(v.kind, 'unknown', 'unrecognized -> unknown');
  A.eq(v.retryable, true, 'unknown is retryable');
  A.ok(/Something went wrong/i.test(v.userMessage), 'unknown has a friendly generic headline');
  A.ok(/something weird happened/.test(v.raw), 'unknown keeps the raw text');

  // agent_busy (2026-07-07 escape): the per-agent mutex message must NEVER flatten to "Something went wrong" —
  // the sidecar's sentence names the holder (age/source) + the doors (ROUTINES, E-STOP); show it VERBATIM.
  const busyRaw = 'That agent is already running a task — one run at a time per agent (they share a workspace). The run holding it started 12 min ago (source: cron). Wait for it to finish, check ROUTINES for a recurring job on this agent, or press E-STOP to stop everything.';
  v = F(new Error(busyRaw));
  A.eq(v.kind, 'agent_busy', 'the run-mutex message classifies as agent_busy, not unknown');
  A.eq(v.userMessage, busyRaw, 'the sidecar sentence passes through VERBATIM (holder + age + doors)');
  A.eq(v.retryable, true, 'agent_busy is retryable (the slot frees when the holder finishes)');
  A.ok(!/Something went wrong/.test(v.userMessage), 'the generic flattening is gone');

  // robustness: a bare string and a null both classify without throwing
  A.eq(F('sidecar HTTP 500').kind, 'server_error', 'a bare string error is accepted');
  A.notThrows(() => F(null), 'null error does not throw');

  // every KIND yields a complete, well-typed verdict
  for (const k of Object.keys(KINDS)) {
    const def = KINDS[k];
    A.ok(typeof def.retryable === 'boolean' && typeof def.msg === 'string' && def.msg.length > 0, 'kind "' + k + '" has a boolean retryable + a non-empty message');
    A.ok(def.action === null || def.action === 'settings' || def.action === 'skills' || def.action === 'store' || def.action === 'refit' || def.action === 'reload' || def.action === 'toolsets', 'kind "' + k + '" action is null|settings|skills|store|refit|reload|toolsets');
  }
}

// ---- J. browser fallback path: re-load friendlyerror.js with the sidecar classifier UNREACHABLE (as in the
//        shipped browser, where require() / the errorClass module don't exist), forcing classifyApiError=null so
//        EVERY verdict flows through kindFromRaw. Locks the untested browser path to the same truth as delegation —
//        a future kindFromRaw edit that diverges from the classifier now fails here instead of shipping silently. ----
{
  const Module = require('module');
  const path = require('path');
  const ecPath = require.resolve('../sidecar/providers/errorClass.js');
  const fePath = require.resolve('../frontend/app/friendlyerror.js');
  const origLoad = Module._load;
  // make the errorClass require inside friendlyerror.js throw → its try/catch leaves classifyApiError = null.
  Module._load = function (request, parent, isMain) {
    const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch (_) { return request; } })();
    if (resolved === ecPath || /errorClass\.js$/.test(String(request))) throw new Error('module unavailable (browser)');
    return origLoad.apply(this, arguments);
  };
  delete require.cache[fePath];
  let friendlyErrorBrowser;
  try { friendlyErrorBrowser = require('../frontend/app/friendlyerror.js').friendlyError; }
  finally { Module._load = origLoad; delete require.cache[fePath]; }
  // re-require the normal (delegating) build so any later require sees the real module again.
  require('../frontend/app/friendlyerror.js');

  const B = (err, status) => friendlyErrorBrowser(err, status);
  A.eq(B(new Error('sidecar HTTP 500')).kind, 'server_error', 'browser: 5xx -> server_error');
  A.eq(B(new Error('cannot reach the STARNET sidecar — start it')).kind, 'network', 'browser: unreachable -> network');
  A.eq(B(new Error('Failed to fetch')).kind, 'network', 'browser: Failed to fetch -> network');
  A.eq(B(new Error('sidecar HTTP 429')).kind, 'rate_limit', 'browser: 429 -> rate_limit');
  A.eq(B(new Error('sidecar HTTP 401')).kind, 'auth', 'browser: 401 -> auth');
  A.eq(B(new Error('sidecar HTTP 400 — missing key/model')).kind, 'auth', 'browser: /api/run missing credentials -> auth, not unknown retry');
  A.eq(B(new Error('sidecar HTTP 403')).kind, 'stale_session', 'browser: sidecar 403 -> stale_session (reload, not the key door)');
  A.eq(B(new Error('forbidden token'), 403).kind, 'stale_session', 'browser: 403 + "forbidden token" body -> stale_session');
  A.eq(B(new Error('invalid api key')).kind, 'auth', 'browser: invalid api key -> auth');
  A.eq(B(new Error('ChatGPT sign-in needed: codex_not_connected')).kind, 'oauth', 'browser: ChatGPT sign-in -> oauth');
  A.eq(B(new Error('sidecar HTTP 402')).kind, 'billing', 'browser: 402 -> billing');
  A.eq(B(new Error('sidecar HTTP 404')).kind, 'model_not_found', 'browser: 404 -> model_not_found');
  A.eq(B(new Error('sidecar HTTP 504')).kind, 'timeout', 'browser: 504 -> timeout');
  A.eq(B(new Error('no web — capability is off')).kind, 'capdenied', 'browser: capdenied string -> capdenied');
  A.eq(B(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind, 'user_abort', 'browser: AbortError -> user_abort');
  A.eq(B(new Error('something weird happened')).kind, 'unknown', 'browser: unrecognized -> unknown');
  // the new pre-flight misconfig mapping must hold on the browser path too (points at Settings, not a retry).
  A.eq(B(new Error('no API key set')).kind, 'auth', 'browser: "no API key set" -> auth');
  A.eq(B(new Error('no API key set')).action, 'settings', 'browser: missing key points at Settings');
  A.eq(B(new Error('no model selected')).kind, 'auth', 'browser: "no model selected" -> auth');
}

/* ---- a TRANSPORT status beats a policy WORD in the message ----
   The content-policy regex ran against the whole message before the status was consulted, so any retryable
   failure whose text merely CONTAINED "moderation"/"safety"/"content_filter" was rewritten as a fatal policy
   block: no retry, no failover, and agent.run.error.transient reporting false. A real policy refusal never
   arrives as 429/5xx. */
{
  const t = R(httpErr(503, 'No instances available for openai/omni-moderation-latest'));
  A.eq(t.reason, 'overloaded', 'a 503 naming a moderation MODEL is still overloaded');
  A.eq(t.retryable, true, 'and stays retryable');
  A.eq(t.shouldFallback, true, 'and can still fail over');
  A.eq(R(httpErr(429, 'rate limit exceeded on the safety-tier endpoint')).reason, 'rate_limit', 'a 429 mentioning "safety" is still a rate limit');
  A.eq(R(httpErr(500, 'content_filter pipeline crashed')).reason, 'server_error', 'a 500 naming a content_filter component is still a server error');
  A.eq(R(httpErr(408, 'safety check timed out')).reason, 'timeout', 'a 408 mentioning safety is still a timeout');
  // ...and a genuine refusal is unchanged
  A.eq(R(httpErr(400, 'your request was blocked by our content policy')).reason, 'content_policy_blocked', 'a 400 policy refusal still classifies as policy');
  A.eq(R(httpErr(403, 'flagged by moderation')).reason, 'content_policy_blocked', 'so does a 403');
  A.eq(R(new Error('the model refused: content_filter triggered')).reason, 'content_policy_blocked', 'and so does a status-less refusal');
}

A.report('errorclass.test');
