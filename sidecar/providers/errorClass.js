/* sidecar/providers/errorClass.js — API error classification -> failover actions (derived from the reference harness, L3.S1).

   Today the loop carries a single `err.transient` bit: a 429/5xx retries, everything else is fatal. That
   burns paid attempts on never-succeed failures (402 out-of-credits, 400 malformed) and tells the user
   nothing useful. This pure classifier maps any provider error to a reason + the action it implies.

   classifyApiError(err, { provider, model, approxTokens, contextLimit, numMessages })
     -> { reason, retryable, shouldRotateCredential, shouldFallback, shouldCompress, statusCode, message }

   Reasons: auth · billing · rate_limit · overloaded · server_error · timeout · context_overflow ·
            model_not_found · content_policy_blocked · format_error · unknown.

   Priority pipeline: content/policy -> HTTP status (code+message consulted inside the ambiguous 400 branch)
   -> structured error-code (for errors with no HTTP status) -> message patterns -> transport -> a
   context-overflow RATIO heuristic -> unknown. The ratio (approxTokens > 0.4·contextLimit) only fires when
   contextLimit > 0, so a cold /models catalog (contextLimit === 0) never mis-labels a bare 400 as overflow.

   Pure: inspects only `err` and the context bag — no clock, no rng, no IO. Wiring (producer seam in
   openrouter.js, honest `transient` in loop.js) is L3.S2/S3; this commit ships the classifier + test only. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.errorClass = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // reason -> the recovery it implies. retryable = worth another attempt on the SAME credential/model after
  // backoff; the *should* flags are advisory hints a future failover layer consumes (no consumer yet — L3.S3
  // records them inert). Default-deny posture: only genuinely transient classes are retryable.
  const REASONS = {
    auth:                   { retryable: false, shouldRotateCredential: true,  shouldFallback: false, shouldCompress: false },
    billing:                { retryable: false, shouldRotateCredential: true,  shouldFallback: false, shouldCompress: false },
    rate_limit:             { retryable: true,  shouldRotateCredential: true,  shouldFallback: false, shouldCompress: false },
    overloaded:             { retryable: true,  shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    server_error:           { retryable: true,  shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    timeout:                { retryable: true,  shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    context_overflow:       { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: true  },
    model_not_found:        { retryable: false, shouldRotateCredential: false, shouldFallback: true,  shouldCompress: false },
    content_policy_blocked: { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    format_error:           { retryable: false, shouldRotateCredential: false, shouldFallback: false, shouldCompress: false },
    unknown:                { retryable: true,  shouldRotateCredential: false, shouldFallback: false, shouldCompress: false }
  };

  function extractStatus(err) {
    if (!err) return null;
    const s = err.status || err.statusCode || (err.response && err.response.status);
    if (typeof s === 'number' && s >= 100) return s;
    const m = String(err.message || '').match(/\b(?:http|status)\s+(\d{3})\b/i);
    return m ? Number(m[1]) : null;
  }
  function extractBody(err) {
    if (!err) return null;
    return err.body || err.error || (err.response && (err.response.data || err.response.body)) || null;
  }
  function extractCode(body, err) {
    const e = body && (body.error || body);
    const c = (e && e.code) || (err && err.code);
    // node transport codes (ECONNRESET…) are numeric-ish strings handled separately; only return API codes here
    return (typeof c === 'string' && !/^E[A-Z]/.test(c)) ? c : (typeof c === 'number' ? null : (c || null));
  }
  function extractMessage(err, body) {
    const e = body && (body.error || body);
    const parts = [];
    if (e && e.message) parts.push(String(e.message));
    if (e && e.metadata && e.metadata.raw) parts.push(String(e.metadata.raw));   // OpenRouter wraps the upstream error here
    if (!parts.length && err && err.message) parts.push(String(err.message));
    return parts.join(' — ') || (err ? String(err) : 'unknown error');
  }
  function transportCode(err) {
    return (err && (err.code || err.errno || (err.cause && err.cause.code))) || '';
  }

  // H6.1: surface how long the server says to wait, so a rate-limited credential cools for exactly that long
  // (instead of a blind fixed cooldown). PURE — no clock: a RELATIVE hint (Retry-After: 30, "try again in 1.5s")
  // becomes `retryAfterMs`; an ABSOLUTE hint (HTTP-date, X-RateLimit-Reset epoch, "resets at <epoch>") becomes
  // `resetAtMs` and the consumer (with its injected clock) turns it into a delay. Either/both may be null.
  function extractHeaders(err) { return (err && (err.headers || (err.response && err.response.headers))) || null; }
  function headerGet(headers, name) {
    if (!headers) return null;
    const lname = name.toLowerCase();
    if (typeof headers.get === 'function') { const v = headers.get(name); if (v != null) return v; }
    for (const k in headers) { if (String(k).toLowerCase() === lname) return headers[k]; }
    return null;
  }
  function extractRetryAfter(err, body, message) {
    let retryAfterMs = null, resetAtMs = null;
    const headers = extractHeaders(err);
    const e = body && (body.error || body);
    // 1. Retry-After: bare integer = delta-seconds; otherwise an HTTP-date (absolute).
    const ra = headerGet(headers, 'retry-after') || (e && (e.retry_after != null ? e.retry_after : (body && body.retry_after)));
    if (ra != null && String(ra).trim() !== '') {
      const s = String(ra).trim();
      if (/^\d+(\.\d+)?$/.test(s)) retryAfterMs = Math.round(parseFloat(s) * 1000);
      else { const t = Date.parse(s); if (!isNaN(t)) resetAtMs = t; }
    }
    // 2. X-RateLimit-Reset header: epoch seconds or ms (a small delta-seconds value is ambiguous -> skip).
    const xr = headerGet(headers, 'x-ratelimit-reset') || headerGet(headers, 'x-ratelimit-reset-requests') || headerGet(headers, 'x-ratelimit-reset-tokens');
    if (resetAtMs == null && xr != null && /^\d+(\.\d+)?$/.test(String(xr).trim())) {
      const n = parseFloat(xr);
      if (n > 1e12) resetAtMs = Math.round(n);            // already epoch-ms
      else if (n > 1e9) resetAtMs = Math.round(n * 1000); // epoch-seconds
    }
    // 3. message text: "(try again|retry|resets|available) in <n><unit>"
    if (retryAfterMs == null) {
      const m = String(message || '').toLowerCase().match(/(?:try again|retry|resets?|available|wait)\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)\b/);
      if (m) { const v = parseFloat(m[1]); const u = m[2]; retryAfterMs = /^ms|^milli/.test(u) ? Math.round(v) : /^m/.test(u) ? Math.round(v * 60000) : Math.round(v * 1000); }
    }
    // 4. message text: "resets at <epoch>" (10–13 digit unix time)
    if (resetAtMs == null) {
      const m = String(message || '').toLowerCase().match(/resets?\s+at\s+(\d{10,13})/);
      if (m) { const n = Number(m[1]); resetAtMs = n > 1e12 ? n : n * 1000; }
    }
    return { retryAfterMs, resetAtMs };
  }

  function classify400(low, code, ctx) {
    const c = String(code || '').toLowerCase();
    if (/context_length|context_window|max.*token/.test(c)) return 'context_overflow';
    if (/content_policy|moderation/.test(c)) return 'content_policy_blocked';
    if (/context length|maximum context|context window|too many tokens|reduce the length|maximum.*tokens|payload too large/.test(low)) return 'context_overflow';
    // ratio heuristic ONLY with a known limit — a cold catalog (contextLimit 0) falls to format_error
    if (ctx.contextLimit > 0 && ctx.approxTokens > 0.4 * ctx.contextLimit) return 'context_overflow';
    return 'format_error';
  }

  function pickReason(status, code, low, err, ctx) {
    // 1. content / policy (most specific intent)
    if (/content[ _]?policy|moderation|flagged|safety|content_filter/.test(low)) return 'content_policy_blocked';
    // 2. HTTP status
    if (status) {
      if (status === 401 || status === 403) return 'auth';
      if (status === 402) return /(resets? at|retry[- ]?after|rate limit)/.test(low) ? 'rate_limit' : 'billing';
      if (status === 404) return 'model_not_found';
      if (status === 408) return 'timeout';
      if (status === 429) return 'rate_limit';
      if (status === 500) return 'server_error';
      if (status === 502 || status === 503) return 'overloaded';
      if (status === 504) return 'timeout';
      if (status === 400 || status === 413 || status === 422) return classify400(low, code, ctx);
    }
    // 3. structured error-code (errors that arrive with no HTTP status)
    if (code) {
      const c = String(code).toLowerCase();
      if (/context_length|context_window|max.*token/.test(c)) return 'context_overflow';
      if (/insufficient_quota|insufficient_credit|billing|payment/.test(c)) return 'billing';
      if (/rate_limit/.test(c)) return 'rate_limit';
      if (/model_not_found|unknown_model|no_endpoints/.test(c)) return 'model_not_found';
      if (/content_policy|moderation/.test(c)) return 'content_policy_blocked';
      if (/invalid_api_key|authentication|unauthorized/.test(c)) return 'auth';
    }
    // 4. message patterns
    if (/context length|maximum context|context window|too many tokens|reduce the length|maximum.*tokens/.test(low)) return 'context_overflow';
    if (/insufficient|not enough credit|out of credit|quota|payment required|add credits/.test(low)) return 'billing';
    if (/rate limit|too many requests/.test(low)) return 'rate_limit';
    if (/overloaded|over capacity|temporarily unavailable|try again later/.test(low)) return 'overloaded';
    if (/no endpoints|model not found|not a valid model|unknown model|no allowed providers/.test(low)) return 'model_not_found';
    if (/unauthorized|invalid api key|no auth credentials|authentication/.test(low)) return 'auth';
    if (/timed out|timeout/.test(low)) return 'timeout';
    // 5. transport
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED|UND_ERR/i.test(transportCode(err))) return 'timeout';
    // 6. ratio heuristic (only with a known limit)
    if (ctx.contextLimit > 0 && ctx.approxTokens > 0.4 * ctx.contextLimit) return 'context_overflow';
    // 7. unknown — one retry is safe-ish
    return 'unknown';
  }

  function classifyApiError(err, ctx) {
    ctx = ctx || {};
    const status = extractStatus(err);
    const body = extractBody(err);
    const code = extractCode(body, err);
    const message = extractMessage(err, body);
    const reason = pickReason(status, code, String(message).toLowerCase(), err, ctx);
    const f = REASONS[reason] || REASONS.unknown;
    const wait = extractRetryAfter(err, body, message);
    return {
      reason,
      retryable: f.retryable,
      shouldRotateCredential: f.shouldRotateCredential,
      shouldFallback: f.shouldFallback,
      shouldCompress: f.shouldCompress,
      statusCode: status || null,
      retryAfterMs: wait.retryAfterMs,   // H6.1: server-stated delay (relative ms), or null
      resetAtMs: wait.resetAtMs,         // H6.1: server-stated absolute reset (epoch ms), or null
      message: message
    };
  }

  return { classifyApiError, REASONS, _internals: { extractStatus, extractCode, extractMessage, classify400, pickReason, extractRetryAfter } };
});
