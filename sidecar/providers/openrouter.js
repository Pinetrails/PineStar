/* sidecar/providers/openrouter.js — the ONLY module that knows the OpenRouter wire format.
   Implements the LLMProvider seam (provider.js): stream(req) -> AsyncIterable<HarnessEvent>,
   plus listModels / contextLimit / priceOf. `fetch` is INJECTED (Node global fetch in the host,
   a fake Response in tests) so the same module is testable headlessly.

   SSE handling (verified against OpenRouter, June 2026): skip ':' keep-alive comments, honor the
   '[DONE]' sentinel, buffer partial reads across chunks, and accumulate tool-call argument
   fragments BY INDEX. We DO send `usage:{include:true}`: a streaming response returns token
   counts by default, but the real billed `cost` field is OPT-IN — without this flag usage.cost is
   absent, so SPEND silently reads $0 (only the token tallies move) for any model not in the warmed
   price catalog. With it, the final chunk carries the authoritative billed cost cost.js prefers. */
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
  // provider instance: warmed once (see warmCatalog), it makes priceOf/contextLimit live for all
  // runs without a per-run /models round-trip. Concurrent loads dedupe on CATALOG_PROMISE.
  let CATALOG = null;
  let CATALOG_PROMISE = null;

  function isAbort(e, signal) {
    // ONLY a real cancellation — never a loose message match, which would mask a genuine provider
    // error (whose text happens to contain "abort") as a clean, empty, "successful" turn.
    return !!((signal && signal.aborted) || (e && e.name === 'AbortError'));
  }

  const RETRY_DELAYS = [400, 1200];   // up to 2 retries (no jitter -> determinism); retryability comes from classifyApiError
  function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
      }
    });
  }

  // ---- prompt caching: mark the byte-stable system prefix as cacheable for providers that honor explicit
  //      breakpoints (Anthropic via OpenRouter). Anthropic caches everything up to & including the marked block,
  //      so on every turn after the first the system prompt + tool note is a cache HIT (much cheaper input tokens;
  //      the saving surfaces as `cached_tokens` in usage, which cost.js already reconciles). A pure NO-OP for
  //      models without explicit caching — their plain-string content is returned untouched, so the wire body is
  //      byte-identical to before and other providers are unaffected. Returns a new array; never mutates the
  //      loop's messages. (Caching the growing conversation prefix + the tool list is a planned follow-up; this
  //      ships the single system breakpoint — the largest stable chunk — as the safe first win.)
  //      NOTE (verified vs the OpenRouter + Anthropic docs, 2026): this is the exact accepted wire shape and never
  //      errors, but Anthropic only caches a prefix at/above a per-model MINIMUM (~1024 tokens for Opus 4.8 /
  //      Sonnet 4.6; up to 4096 for Opus 4.6/4.5 + Haiku 4.5) — below that it runs UNCACHED with no error. So a
  //      real cache HIT (cached_tokens > 0) requires the actual system prefix to clear that floor; billing stays
  //      honest either way (cost.js reads the provider's real usage.cost + cached_tokens).
  function supportsExplicitCache(model) {
    return /anthropic\/|claude/i.test(String(model || ''));
  }
  function applyCacheControl(messages, model) {
    if (!Array.isArray(messages) || !supportsExplicitCache(model)) return messages;
    let idx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i] && messages[i].role === 'system') idx = i; else break;   // last of the LEADING system block
    }
    if (idx < 0 || typeof messages[idx].content !== 'string') return messages;  // nothing to cache / already structured
    const out = messages.slice();
    out[idx] = { role: 'system', content: [{ type: 'text', text: messages[idx].content, cache_control: { type: 'ephemeral' } }] };
    return out;
  }
  function normalizeReasoningEffort(value) {
    const key = String(value || 'medium').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const map = {
      off: 'none', none: 'none', no: 'none', disabled: 'none',
      min: 'minimal', minimal: 'minimal',
      low: 'low',
      med: 'medium', mid: 'medium', medium: 'medium',
      high: 'high',
      extra: 'xhigh', xtra: 'xhigh', extrahigh: 'xhigh', xhigh: 'xhigh',
      max: 'max'
    };
    return map[key] || 'medium';
  }

  function makeOpenRouterProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('openrouter provider requires fetch (Node 18+) or opts.fetch');
    const key = opts.key;
    const baseUrl = opts.baseUrl || BASE;
    const referer = opts.referer || 'http://127.0.0.1';
    const reasoningEffort = normalizeReasoningEffort(opts.reasoningEffort || 'medium');

    async function* stream(req) {
      // usage.include asks OpenRouter to return the real billed `cost` in the final usage chunk (opt-in for
      // streaming). Without it tokens still tally but usd stays 0 unless priceOf(model) resolves — so SPEND
      // reads $0 for any custom/uncatalogued slug. cost.js then takes this authoritative cost over the estimate.
      const body = { model: req.model, messages: applyCacheControl(req.messages, req.model), stream: true, usage: { include: true }, reasoning: { effort: normalizeReasoningEffort(req.reasoningEffort || reasoningEffort) } };
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
          try {
            const res = await doFetch(baseUrl + '/models', {});
            const j = await res.json();
            return (j.data || []).map(m => ({
              id: m.id,
              context_length: m.context_length || 0,
              max_completion_tokens: (m.top_provider && m.top_provider.max_completion_tokens) || null,
              pricing: m.pricing,
              supportsTools: !!(m.supported_parameters && m.supported_parameters.indexOf('tools') >= 0)
            }));
          } catch (e) { return []; }
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

  return { makeOpenRouterProvider, applyCacheControl };
});
