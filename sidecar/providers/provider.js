/* sidecar/providers/provider.js — the LLMProvider interface (the transport seam).
   Every provider (replay, openrouter, later tauri-sidecar) implements:

     stream(req) -> AsyncIterable<HarnessEvent>
       req = { model, messages, tools, signal, stream:true, ... }
       HarnessEvent =
         | { type:'text',       delta }
         | { type:'tool_start', index, id, name }
         | { type:'tool_args',  index, chunk }   // argument STRING fragment
         | { type:'tool_done',  index }
         | { type:'usage',      usage }          // prompt_tokens, completion_tokens, total_tokens,
         |                                       //   prompt_tokens_details.cached_tokens, reasoning_tokens, cost
         | { type:'done',       finishReason }   // normalized via normalizeFinish()
     listModels()     -> [{ id, context_length, max_completion_tokens, pricing, supportsTools }]
     contextLimit(id) -> number
     priceOf(id)      -> { in, out } | null      // per-million USD

   This module is the shared contract + a finish-reason normalizer used by adapters. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).provider = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EVENT_TYPES = ['text', 'tool_start', 'tool_args', 'tool_done', 'usage', 'done'];
  const FINISH = ['tool_calls', 'stop', 'length', 'content_filter', 'error'];

  function normalizeFinish(r) {
    if (!r) return 'stop';
    if (r === 'tool_calls' || r === 'tool_use' || r === 'function_call') return 'tool_calls';
    if (r === 'length' || r === 'max_tokens') return 'length';
    if (r === 'content_filter') return 'content_filter';
    if (r === 'stop' || r === 'end_turn' || r === 'stop_sequence') return 'stop';
    return 'error';
  }

  // ---- shared stream-timeout plumbing (every adapter uses this so the logic isn't copy-pasted 5×) ----
  //
  // Two independent timeouts protect a run from hanging on paid spend:
  //   · CONNECT — a ceiling on the POST/fetch itself (headers not received). Env SKYNET_PROVIDER_CONNECT_MS,
  //     default 30s. Implemented by connectGuard(): a manual AbortController whose timer is DISARMED the moment
  //     response headers arrive, so this ceiling can never abort a healthy streaming body. (A fetch `signal`
  //     governs the ENTIRE response, so a bare AbortSignal.timeout kept ticking past headers and killed any
  //     turn that streamed longer than the ceiling — the 2026-07-07 codex incident. The body is the idle
  //     watchdog's job, not this timer's.)
  //   · IDLE    — a resettable watchdog around each reader.read(): if no bytes arrive for this long the reader
  //     is cancelled and a `timeout`-classified error is thrown. Env SKYNET_PROVIDER_IDLE_MS, default 300s.
  //     (Generous: once the connect guard is disarmed the idle watchdog is the body's ONLY ceiling, and a
  //     deep-reasoning turn can stay byte-silent for a while — a healthy run must not be killed mid-flight.)
  //
  // CRITICAL invariant: a user-cancel (the original signal aborts) must classify as abort/cancelled, NOT
  // timeout. connectGuard keeps the user's signal as a distinct input and, on a user-cancel, aborts its
  // controller with a NAMED AbortError; on a connect expiry it aborts with a plain Error whose message
  // contains "timed out" (errorClass.pickReason -> 'timeout'). Node/undici rejects fetch with the abort
  // REASON object, so the adapter sees exactly that error. Adapters' isAbort() keys off the original signal +
  // AbortError name only, so a connect-timeout is NEVER seen as a cancel (it retries like a transient network
  // error), and a user-cancel is NEVER seen as a timeout. The idle watchdog upholds the same split downstream.
  function envInt(name, dflt) {
    try {
      const v = (typeof process !== 'undefined' && process.env && process.env[name]);
      const n = v != null && String(v).trim() !== '' ? parseInt(v, 10) : NaN;
      return (isFinite(n) && n > 0) ? n : dflt;
    } catch (_) { return dflt; }
  }
  function connectMs() { return envInt('SKYNET_PROVIDER_CONNECT_MS', 30000); }
  function idleMs() { return envInt('SKYNET_PROVIDER_IDLE_MS', 300000); }

  // DEPRECATED for streaming fetches — new code MUST use connectGuard() instead. This merges the caller's
  // signal with a NON-disarmable AbortSignal.timeout: because a fetch signal governs the whole response, the
  // timeout keeps ticking after headers arrive and aborts a healthy streaming body (that killed a real >30s
  // codex turn on 2026-07-07). Kept only for non-streaming callers/tests that reference it.
  function connectSignal(signal, ms) {
    const timeoutMs = (ms != null && ms > 0) ? ms : connectMs();
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && typeof AbortSignal.any === 'function') {
        const parts = [AbortSignal.timeout(timeoutMs)];
        if (signal) parts.unshift(signal);
        return AbortSignal.any(parts);
      }
    } catch (_) {}
    return signal;
  }

  // Connect-phase guard: a manual AbortController whose timer is DISARMED the moment response headers arrive
  // (the adapter calls guard.disarm() in a finally around the fetch). Until then it enforces the connect
  // ceiling; after that the streaming body is protected only by the idle watchdog — so a slow-but-alive turn
  // can stream for as long as it keeps producing bytes.
  //   · guard.signal — pass this to fetch().
  //   · guard.disarm() — call once the fetch settles (headers arrived OR it rejected); idempotent.
  // Reasons (undici rejects fetch with the abort reason object): a connect expiry -> timeoutError() (name
  // 'Error', message "…timed out…", classifies as `timeout`, retryable); a user-cancel on the caller signal
  // -> makeAbortError() (name 'AbortError', so adapters' isAbort() treats it as a clean cancel). Degrades to
  // the caller's signal unchanged when AbortController is unavailable (older runtimes).
  function connectGuard(signal, ms) {
    const timeoutMs = (ms != null && ms > 0) ? ms : connectMs();
    if (typeof AbortController === 'undefined') return { signal: signal, disarm: function () {} };
    const ctrl = new AbortController();
    let timer = setTimeout(function () {
      timer = null;
      try { ctrl.abort(timeoutError(timeoutMs, 'connect')); } catch (_) { ctrl.abort(); }
    }, timeoutMs);
    let onAbort = null;
    if (signal) {
      onAbort = function () {
        if (timer) { clearTimeout(timer); timer = null; }
        try { ctrl.abort(makeAbortError()); } catch (_) { ctrl.abort(); }
      };
      if (signal.aborted) onAbort();
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
      signal: ctrl.signal,
      disarm: function () {
        if (timer) { clearTimeout(timer); timer = null; }
        if (onAbort && signal && typeof signal.removeEventListener === 'function') { signal.removeEventListener('abort', onAbort); onAbort = null; }
      }
    };
  }

  function timeoutError(ms, phase) {
    // message MUST contain "timed out" so errorClass.pickReason lands this on the `timeout` class (retryable,
    // no credential rotation). `phase` distinguishes connect vs idle for logs/telemetry.
    const e = new Error('provider stream ' + (phase || 'idle') + ' timed out after ' + ms + 'ms with no bytes received');
    e.code = 'PROVIDER_STREAM_TIMEOUT';
    e.timeout = true;
    e.phase = phase || 'idle';
    return e;
  }
  function makeAbortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

  // Wrap a WHATWG stream reader with a per-read idle watchdog. Each read() races a timer (reset every read);
  // on expiry the reader is cancelled and a `timeout` error is thrown. A user-cancel resolves as an AbortError
  // so the loop reports 'cancelled'. Returns a reader-shaped object exposing read()/cancel().
  function idleGuardedReader(reader, opts) {
    opts = opts || {};
    const ms = (opts.idleMs != null && opts.idleMs > 0) ? opts.idleMs : idleMs();
    const signal = opts.signal || null;
    let cancelled = false;
    async function read() {
      if (signal && signal.aborted) { try { await reader.cancel(); } catch (_) {} throw makeAbortError(); }
      let timer = null;
      let onAbort = null;
      const guard = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          cancelled = true;
          try { reader.cancel(); } catch (_) {}
          reject(timeoutError(ms, 'idle'));
        }, ms);
        // NOTE: deliberately NOT unref'd. The watchdog must be able to fire even when the stalled read() is the
        // only pending work — unref'ing would let the process exit instead of timing out (and would also break
        // deterministic unit testing of the watchdog). The timer is always cleared in the finally below.
        if (signal && typeof signal.addEventListener === 'function') {
          onAbort = () => { try { reader.cancel(); } catch (_) {} reject(makeAbortError()); };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      try {
        return await Promise.race([reader.read(), guard]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort && signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      }
    }
    function cancel(reason) { return reader.cancel ? reader.cancel(reason) : undefined; }
    return { read, cancel, get _cancelledByTimeout() { return cancelled; } };
  }

  const timeouts = { envInt, connectMs, idleMs, connectSignal, connectGuard, idleGuardedReader, timeoutError, makeAbortError };

  return { EVENT_TYPES, FINISH, normalizeFinish, timeouts };
});
