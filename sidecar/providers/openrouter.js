/* sidecar/providers/openrouter.js — the ONLY module that knows the OpenRouter wire format.
   Implements the LLMProvider seam (provider.js): stream(req) -> AsyncIterable<HarnessEvent>,
   plus listModels / contextLimit / priceOf. `fetch` is INJECTED (Node global fetch in the host,
   a fake Response in tests) so the same module is testable headlessly.

   SSE handling (verified against OpenRouter, June 2026): skip ':' keep-alive comments, honor the
   '[DONE]' sentinel, buffer partial reads across chunks, and accumulate tool-call argument
   fragments BY INDEX. We send `usage:{include:true}` so the final chunk carries the real billed
   `cost` (cost.js prefers usage.cost over the catalog estimate). */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.openrouter = factory(root.SK.providers.provider, root.SK.providers.errorClass); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass) {
  'use strict';

  const normalizeFinish = provider.normalizeFinish;
  const classifyApiError = errorClass.classifyApiError;
  const BASE = 'https://openrouter.ai/api/v1';

  // The OpenRouter /models catalog is key-independent, so it is shared across every per-run
  // provider instance: warmed once (see loadCatalog), it makes priceOf/contextLimit live for all
  // runs without a per-run /models round-trip. Concurrent loads dedupe on CATALOG_PROMISE.
  let CATALOG = null;
  let CATALOG_PROMISE = null;

  function isAbort(e, signal) {
    // ONLY a real cancellation — never a loose message match, which would mask a genuine provider
    // error (whose text happens to contain "abort") as a clean, empty, "successful" turn.
    return !!((signal && signal.aborted) || (e && e.name === 'AbortError'));
  }

  const RETRY_DELAYS = [400, 1200];   // up to 2 retries (no jitter -> determinism); retryability comes from classifyApiError
  const CATALOG_TIMEOUT_MS = 15000;   // a hung /models socket must not pin CATALOG_PROMISE forever
  function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      // remove the abort listener on the normal (timer-wins) path too — { once:true } only fires it on abort,
      // so otherwise it would accumulate orphaned listeners on the longer-lived per-run signal across retries.
      const onAbort = () => { clearTimeout(t); reject(abortError()); };
      const t = setTimeout(() => {
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function makeOpenRouterProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('openrouter provider requires fetch (Node 18+) or opts.fetch');
    const key = opts.key;
    const baseUrl = opts.baseUrl || BASE;
    const referer = opts.referer || 'http://127.0.0.1';

    async function* stream(req) {
      const body = { model: req.model, messages: req.messages, stream: true, usage: { include: true } };
      if (req.tools && req.tools.length) {
        body.tools = req.tools;
        body.tool_choice = 'auto';
        body.parallel_tool_calls = false;   // linear, one tool at a time — easier to visualize + accumulate
      }
      let res;
      try { res = await requestWithRetry(body, req.signal); }   // retries transient 429/5xx + network errors BEFORE any token streams
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }  // cancel during the POST/backoff -> end cleanly so the loop reports 'cancelled', not 'error'
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const started = {};   // index -> true once tool_start has been emitted

      // parse ONE raw SSE line into either a control signal or its JSON payload
      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (!t || t.charAt(0) === ':') return null;          // blank / keep-alive comment
        if (t.indexOf('data:') !== 0) return null;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (e) { return null; }
      }
      // one decoded chunk -> 0..n normalized HarnessEvents (shared by the loop + end-of-stream flush)
      function* emitFrom(j) {
        if (j.error) throw new Error((j.error && j.error.message) || 'openrouter stream error');
        const choice = j.choices && j.choices[0];
        if (choice && choice.delta) {
          const d = choice.delta;
          if (typeof d.content === 'string' && d.content) yield { type: 'text', delta: d.content };
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              const idx = (tc.index != null) ? tc.index : 0;
              if (!started[idx] && (tc.id || (tc.function && tc.function.name))) {
                started[idx] = true;
                yield { type: 'tool_start', index: idx, id: tc.id || ('call_' + idx), name: (tc.function && tc.function.name) || '' };
              }
              if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments) {
                yield { type: 'tool_args', index: idx, chunk: tc.function.arguments };
              }
            }
          }
        }
        if (j.usage) yield { type: 'usage', usage: j.usage };
        if (choice && choice.finish_reason) yield { type: 'done', finishReason: normalizeFinish(choice.finish_reason) };
      }

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            const p = parseLine(line);
            if (!p) continue;
            if (p.done) return;
            yield* emitFrom(p.json);
          }
        }
        // flush a final line that arrived WITHOUT a trailing newline (rare: the closing usage/done chunk)
        buf += dec.decode();
        if (buf.trim()) {
          const p = parseLine(buf);
          if (p && !p.done && p.json) yield* emitFrom(p.json);
        }
      } catch (e) {
        if (isAbort(e, req.signal)) return;   // cancellation: end the stream cleanly so the loop reports 'cancelled'
        throw e;
      }
    }

    async function loadCatalog() {
      if (CATALOG && CATALOG.length) return CATALOG;   // only a NON-empty catalog is a cache hit
      if (!CATALOG_PROMISE) {
        CATALOG_PROMISE = (async () => {
          // bound the GET with an internal AbortController (mirrors tools/builtin/web.js): a stalled socket
          // otherwise leaves this promise pending forever, and line 144 below could never reset it for a retry.
          const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          const timer = ac ? setTimeout(() => ac.abort(), CATALOG_TIMEOUT_MS) : null;
          try {
            const res = await doFetch(baseUrl + '/models', ac ? { signal: ac.signal } : {});
            const j = await res.json();
            return (j.data || []).map(m => ({
              id: m.id,
              context_length: m.context_length || 0,
              max_completion_tokens: (m.top_provider && m.top_provider.max_completion_tokens) || null,
              pricing: m.pricing,
              supportsTools: !!(m.supported_parameters && m.supported_parameters.indexOf('tools') >= 0)
            }));
          } catch (e) { return []; }
          finally { if (timer) clearTimeout(timer); }
        })();
      }
      CATALOG = await CATALOG_PROMISE;
      if (!CATALOG.length) CATALOG_PROMISE = null;     // empty (transient failure / no data): allow a later retry, don't pin
      return CATALOG;
    }
    async function listModels() { return (await loadCatalog()).map(m => Object.assign({}, m)); }
    function findModel(id) { return CATALOG ? CATALOG.find(m => m.id === id) : null; }
    function contextLimit(id) { const m = findModel(id); return (m && m.context_length) || 0; }
    function priceOf(id) {
      // best-effort: null until the catalog is loaded — cost.js then relies on the provider's
      // real `usage.cost` (always returned by OpenRouter), so this never blocks honest accounting.
      const m = findModel(id);
      if (!m || !m.pricing) return null;
      const i = parseFloat(m.pricing.prompt) * 1e6, o = parseFloat(m.pricing.completion) * 1e6;
      return (isFinite(i) && isFinite(o)) ? { in: i, out: o } : null;
    }
    // true/false once the catalog is warm; null = unknown (cold catalog) so callers don't false-refuse.
    function supportsTools(id) { const m = findModel(id); return m ? !!m.supportsTools : null; }

    // POST the chat request, retrying transient failures (429/5xx + network resets) BEFORE the stream
    // starts — safe because no tokens have been emitted yet. Aborts propagate at once. Returns an ok Response.
    async function requestWithRetry(body, signal) {
      for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw abortError();
        let res;
        try {
          res = await doFetch(baseUrl + '/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + (key || ''), 'Content-Type': 'application/json', 'HTTP-Referer': referer, 'X-Title': 'SKYNET' },
            body: JSON.stringify(body),
            signal
          });
        } catch (e) {
          if (isAbort(e, signal)) throw e;
          if (attempt < RETRY_DELAYS.length) { await delay(RETRY_DELAYS[attempt], signal); continue; }   // network error -> retry
          throw e;
        }
        if (res.ok && res.body) return res;
        let detail = res.statusText || '';
        try { const j = await res.json(); detail = (j && j.error && j.error.message) || JSON.stringify(j); }
        catch (e) { try { detail = (await res.text()).slice(0, 300); } catch (_) {} }
        const err = new Error('openrouter http ' + res.status + ' — ' + detail);
        err.status = res.status;
        const cls = classifyApiError(err, { model: body.model });   // single source of truth for retryability
        err.transient = cls.retryable;                              // keep the field other code reads, now classifier-derived
        if (cls.retryable && attempt < RETRY_DELAYS.length) { await delay(RETRY_DELAYS[attempt], signal); continue; }
        throw err;
      }
    }

    return { stream, listModels, contextLimit, priceOf, supportsTools };
  }

  return { makeOpenRouterProvider };
});
