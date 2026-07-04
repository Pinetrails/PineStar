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
  //     default 30s. Combined with the caller's signal via AbortSignal.any so a user-cancel still wins.
  //   · IDLE    — a resettable watchdog around each reader.read(): if no bytes arrive for this long the reader
  //     is cancelled and a `timeout`-classified error is thrown. Env SKYNET_PROVIDER_IDLE_MS, default 120s.
  //
  // CRITICAL invariant: a user-cancel (the original signal aborts) must classify as abort/cancelled, NOT
  // timeout. connectSignal keeps the user's signal as a distinct input; the idle watchdog checks the user
  // signal first and constructs a NAMED AbortError on cancel, but a genuine idle expiry throws a plain Error
  // whose message contains "timed out" (errorClass.pickReason -> 'timeout'). Adapters' isAbort() keys off the
  // original signal + AbortError name only, so a TimeoutError from AbortSignal.timeout is NEVER seen as a cancel.
  function envInt(name, dflt) {
    try {
      const v = (typeof process !== 'undefined' && process.env && process.env[name]);
      const n = v != null && String(v).trim() !== '' ? parseInt(v, 10) : NaN;
      return (isFinite(n) && n > 0) ? n : dflt;
    } catch (_) { return dflt; }
  }
  function connectMs() { return envInt('SKYNET_PROVIDER_CONNECT_MS', 30000); }
  function idleMs() { return envInt('SKYNET_PROVIDER_IDLE_MS', 120000); }

  // Build the signal passed to fetch: the caller's signal (cancel) merged with a connect-timeout signal, so
  // the POST can't hang forever waiting for response headers. Returns the caller's signal unchanged when the
  // platform lacks AbortSignal.any/timeout (older Node) — connect protection then degrades to the idle watchdog.
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

  const timeouts = { envInt, connectMs, idleMs, connectSignal, idleGuardedReader, timeoutError, makeAbortError };

  return { EVENT_TYPES, FINISH, normalizeFinish, timeouts };
});
