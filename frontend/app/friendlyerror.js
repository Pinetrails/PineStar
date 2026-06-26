/* STARNET — friendlyerror.js : turn a raw failure into something a beginner can act on.
   Pure + testable (UMD: a `Friendly` global in the browser, module.exports under node).

   The COMMS panel used to surface raw plumbing on a failed turn — "sidecar HTTP 500", an OpenRouter
   payload, a capdenied string — and the ↻ retry chip fired blindly regardless of WHY it failed. This
   maps any error (the thrown Error from Harness.chat + an optional HTTP status) to:

     friendlyError(err, status) -> { userMessage, kind, retryable, action, raw }

   • userMessage — one plain-language sentence to LEAD the error row with.
   • kind        — a stable class (mirrors the sidecar classifier's reasons, plus the UI-level
                   `network` / `capdenied` / `user_abort` cases the browser sees but the API layer doesn't).
   • retryable   — whether a plain "↻ Try again" makes sense.
   • action      — null | 'settings' | 'skills': a context-aware destination instead of a blind retry.
   • raw         — the original technical text, kept for a de-emphasized sub-line / title tooltip.

   INTEGRATION (not duplication): when the sidecar classifier module is reachable (node/tests), we delegate
   to classifyApiError() to derive the reason, then translate that reason into a beginner-facing message —
   so the truth table stays single-sourced. In the browser the sidecar module isn't loaded, so we fall back
   to a lightweight pattern-match over the SAME kind vocabulary on the UI-level error strings Harness throws
   ('sidecar HTTP <status>', 'cannot reach the STARNET sidecar…', a forwarded 'no <cap> — …'). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Friendly = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // optional: the sidecar's pure API-error classifier (node/test only). Never required in the browser.
  let classifyApiError = null;
  try { if (typeof require === 'function') classifyApiError = require('../../sidecar/providers/errorClass.js').classifyApiError; } catch (_) {}

  // kind -> beginner-facing copy + whether a plain retry helps + where to send them instead.
  // action: 'settings' (fix the model key) · 'skills' (enable a capability) · null (just retry / nothing).
  const KINDS = {
    server_error:  { retryable: true,  action: null,       msg: 'The local StarNet service hit an error — give it a moment and try again.' },
    network:       { retryable: true,  action: null,       msg: "Can't reach the StarNet sidecar — make sure it's still running." },
    rate_limit:    { retryable: true,  action: null,       msg: 'The model provider is rate-limiting — wait a few seconds and retry.' },
    auth:          { retryable: false, action: 'settings', msg: 'Your model key was rejected — check it in Settings.' },
    billing:       { retryable: false, action: 'settings', msg: "Your model provider says the account is out of credit — check billing in Settings." },
    capdenied:     { retryable: false, action: 'skills',   msg: "This needs a capability that's currently off — enable it in SKILLS." },
    timeout:       { retryable: true,  action: null,       msg: 'That took too long and timed out — try again.' },
    user_abort:    { retryable: false, action: null,       msg: 'Stopped.' },
    context_overflow: { retryable: false, action: null,    msg: 'This conversation got too long for the model — start a fresh turn or trim it back.' },
    model_not_found:  { retryable: false, action: 'settings', msg: "That model isn't available — pick another one in Settings." },
    content_policy_blocked: { retryable: false, action: null, msg: 'The model declined that request on safety grounds — try rephrasing.' },
    unknown:       { retryable: true,  action: null,       msg: 'Something went wrong on that turn — try again.' }
  };

  // the sidecar classifier speaks in `reason`s; map each onto our UI kind. (Most are 1:1; `overloaded` and
  // `format_error` fold into the closest beginner-facing bucket.)
  const REASON_TO_KIND = {
    auth: 'auth', billing: 'billing', rate_limit: 'rate_limit', overloaded: 'server_error',
    server_error: 'server_error', timeout: 'timeout', context_overflow: 'context_overflow',
    model_not_found: 'model_not_found', content_policy_blocked: 'content_policy_blocked',
    format_error: 'unknown', unknown: 'unknown'
  };

  function rawText(err) {
    if (err == null) return '';
    if (typeof err === 'string') return err;
    return String((err && err.message) || err);
  }
  // a user-initiated stop (Esc / Stop button → AbortController) reads as an AbortError or an "abort" message.
  // A user abort is NOT a fault — it must not produce a scary error row.
  function isUserAbort(err) {
    if (!err || typeof err === 'string') return /\babort/i.test(String(err || ''));
    return err.name === 'AbortError' || /\babort/i.test(String(err.message || ''));
  }

  // browser fallback: classify the UI-level error string + optional HTTP status into a kind, using the SAME
  // vocabulary the sidecar reasons map onto. Order: most-specific intent first.
  function kindFromRaw(raw, status) {
    const low = String(raw || '').toLowerCase();
    // Harness pre-flight guards ("no API key set" / "no model selected"): a misconfig, not a fault — point at
    // Settings instead of offering a doomed retry. (Match before capdenied, which the em-dash-less strings miss.)
    if (/no api key set|no model selected/.test(low)) return 'auth';
    // a forwarded capability denial ("no web — …" / "capdenied")
    if (/\bcapdenied\b/.test(low) || /^no\s+\w+\s+—/.test(low) || /needs a capability|capability.*(off|denied)/.test(low)) return 'capdenied';
    // the sidecar is unreachable (fetch threw — Harness throws "cannot reach the STARNET sidecar…")
    if (/cannot reach|can'?t reach|unreachable|failed to fetch|fetch failed|networkerror|load failed|connection (refused|reset)|disconnected/.test(low)) return 'network';
    // content / policy beats a status
    if (/content[ _]?policy|moderation|flagged|safety|content_filter/.test(low)) return 'content_policy_blocked';
    // HTTP status from "sidecar HTTP <status>" or an explicit status arg
    const s = status || (low.match(/\b(?:http|status)\s+(\d{3})\b/) ? Number(RegExp.$1) : null);
    if (s) {
      if (s === 401 || s === 403) return 'auth';
      if (s === 402) return /(resets? at|retry[- ]?after|rate limit)/.test(low) ? 'rate_limit' : 'billing';
      if (s === 404) return 'model_not_found';
      if (s === 408 || s === 504) return 'timeout';
      if (s === 429) return 'rate_limit';
      if (s >= 500) return 'server_error';
      if (s === 400 || s === 413 || s === 422) return /context length|maximum context|context window|too many tokens|reduce the length/.test(low) ? 'context_overflow' : 'unknown';
    }
    // message patterns (no status / in-band error text)
    if (/rate limit|too many requests|rate-limit/.test(low)) return 'rate_limit';
    if (/insufficient|out of credit|not enough credit|quota|payment required|add credits|billing/.test(low)) return 'billing';
    if (/unauthorized|invalid api key|invalid key|no auth credentials|authentication|key was rejected|rejected/.test(low)) return 'auth';
    if (/no endpoints|model not found|not a valid model|unknown model/.test(low)) return 'model_not_found';
    if (/timed out|timeout/.test(low)) return 'timeout';
    if (/context length|maximum context|context window|too many tokens/.test(low)) return 'context_overflow';
    return 'unknown';
  }

  /* err: the thrown Error / in-band error string from Harness.chat. status: an optional HTTP status if the
     caller has it separately. Returns a complete, well-typed verdict — never throws. */
  function friendlyError(err, status) {
    const raw = rawText(err);
    if (isUserAbort(err)) {
      const k = KINDS.user_abort;
      return { userMessage: k.msg, kind: 'user_abort', retryable: k.retryable, action: k.action, raw: raw };
    }
    let kind = null;
    // Harness pre-flight misconfig ("no API key set" / "no model selected") is UI-level — catch before delegating
    // (the sidecar classifier never sees these) so both paths point at Settings, not a blind retry.
    if (/no api key set|no model selected/.test(raw.toLowerCase())) {
      kind = 'auth';
    } else if (/\bcapdenied\b/.test(raw.toLowerCase()) || /^no\s+\w+\s+—/.test(raw.toLowerCase()) || /needs a capability/.test(raw.toLowerCase())) {
      // a capability denial is UI-level (the sidecar classifier doesn't model it) — catch it before delegating.
      kind = 'capdenied';
    } else if (classifyApiError) {
      // delegate to the single-sourced truth table; synthesize the err shape it expects (status + message).
      try {
        const probe = (err && typeof err === 'object') ? err : new Error(raw);
        if (status != null && probe.status == null) { try { probe.status = status; } catch (_) {} }
        const verdict = classifyApiError(probe, {});
        kind = REASON_TO_KIND[verdict.reason] || 'unknown';
        // a bare network failure ("cannot reach the sidecar") classifies as `unknown` upstream (it never reached
        // the API) — promote it to the friendlier `network` bucket so the message points at the sidecar.
        if (kind === 'unknown' && /cannot reach|can'?t reach|unreachable|failed to fetch|fetch failed|networkerror|disconnected/.test(raw.toLowerCase())) kind = 'network';
      } catch (_) { kind = kindFromRaw(raw, status); }
    } else {
      kind = kindFromRaw(raw, status);
    }
    const k = KINDS[kind] || KINDS.unknown;
    return { userMessage: k.msg, kind: kind, retryable: k.retryable, action: k.action, raw: raw };
  }

  return { friendlyError, KINDS, _internals: { kindFromRaw, isUserAbort, REASON_TO_KIND } };
});
