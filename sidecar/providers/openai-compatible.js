/* sidecar/providers/openai-compatible.js - generic OpenAI-compatible chat/completions adapter.
   Used for OpenAI API, local Ollama/vLLM/LM Studio, and user-supplied custom /v1 endpoints.
   It implements the same LLMProvider seam as OpenRouter and Codex. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.openaiCompatible = factory(root.SK.providers.provider, root.SK.providers.errorClass); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass) {
  'use strict';

  const normalizeFinish = provider.normalizeFinish;
  const classifyApiError = errorClass.classifyApiError;
  const DEFAULT_BASE = 'https://api.openai.com/v1';
  const RETRY_DELAYS = [400, 1200];

  function isAbort(e, signal) {
    return !!((signal && signal.aborted) || (e && e.name === 'AbortError'));
  }
  function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
      }
    });
  }
  function cleanBaseUrl(value) {
    return String(value || DEFAULT_BASE).trim().replace(/\/+$/, '');
  }
  function cleanPath(value, fallback) {
    const path = String(value || fallback || '').trim();
    if (!path) return '';
    return path.charAt(0) === '/' ? path : '/' + path;
  }
  function headerBag(key, extra) {
    const h = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, extra || {});
    if (key) h.Authorization = 'Bearer ' + key;
    return h;
  }
  function normalizeModel(m) {
    const id = (m && (m.id || m.name || m.model)) ? String(m.id || m.name || m.model) : '';
    if (!id) return null;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.slice() : [];
    return {
      id,
      name: m.name || id,
      context_length: Number(m.context_length || m.context_window || m.max_context_window || 0) || 0,
      max_completion_tokens: Number(m.max_completion_tokens || m.max_output_tokens || 0) || null,
      pricing: m.pricing || null,
      supported_parameters: params,
      supportsTools: typeof m.supportsTools === 'boolean' ? m.supportsTools : (params.length ? params.indexOf('tools') >= 0 : null),
      supportsReasoning: typeof m.supportsReasoning === 'boolean' ? m.supportsReasoning : null,
      reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.slice() : []
    };
  }

  function makeOpenAICompatibleProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('openai-compatible provider requires fetch (Node 18+) or opts.fetch');
    const key = opts.key || '';
    const baseUrl = cleanBaseUrl(opts.baseUrl);
    const chatPath = cleanPath(opts.chatPath, '/chat/completions');
    const modelsPath = cleanPath(opts.modelsPath, '/models');
    // Usage reporting defaults ON: streams must report token usage so cost accounting and
    // context compaction work. Callers may opt out with an explicit includeUsage: false.
    const includeUsage = opts.includeUsage !== false;
    const defaultContext = Number(opts.defaultContext || 0) || 0;
    let catalog = null;
    let catalogPromise = null;

    async function* stream(req) {
      req = req || {};
      const body = { model: req.model, messages: req.messages || [], stream: true };
      if (includeUsage) body.stream_options = { include_usage: true };
      if (req.tools && req.tools.length) {
        body.tools = req.tools;
        body.tool_choice = 'auto';
        body.parallel_tool_calls = false;
      }
      let res;
      try { res = await requestWithRetry(body, req.signal); }
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const started = {};

      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (!t || t.charAt(0) === ':') return null;
        if (t.indexOf('data:') !== 0) return null;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (_) { return null; }
      }
      function* emitFrom(j) {
        if (j.error) throw new Error((j.error && (j.error.message || j.error.code)) || 'provider stream error');
        if (j.usage) yield { type: 'usage', usage: j.usage };
        const choice = j.choices && j.choices[0];
        if (!choice) return;
        const d = choice.delta || choice.message || {};
        if (typeof d.content === 'string' && d.content) yield { type: 'text', delta: d.content };
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = tc.index != null ? tc.index : 0;
            const fn = tc.function || {};
            if (!started[idx] && (tc.id || fn.name)) {
              started[idx] = true;
              yield { type: 'tool_start', index: idx, id: tc.id || ('call_' + idx), name: fn.name || '' };
            }
            if (typeof fn.arguments === 'string' && fn.arguments) yield { type: 'tool_args', index: idx, chunk: fn.arguments };
          }
        }
        if (choice.finish_reason) yield { type: 'done', finishReason: normalizeFinish(choice.finish_reason) };
      }

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            const p = parseLine(line);
            if (!p) continue;
            if (p.done) return;
            yield* emitFrom(p.json);
          }
        }
        buf += dec.decode();
        if (buf.trim()) {
          const p = parseLine(buf);
          if (p && !p.done && p.json) yield* emitFrom(p.json);
        }
      } catch (e) {
        if (isAbort(e, req.signal)) return;
        throw e;
      }
    }

    async function requestWithRetry(body, signal) {
      for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw abortError();
        let res;
        try {
          res = await doFetch(baseUrl + chatPath, {
            method: 'POST',
            headers: headerBag(key, opts.headers),
            body: JSON.stringify(body),
            signal
          });
        } catch (e) {
          if (isAbort(e, signal)) throw e;
          if (attempt < RETRY_DELAYS.length) { await delay(RETRY_DELAYS[attempt], signal); continue; }
          throw e;
        }
        if (res.ok && res.body) return res;
        let detail = res.statusText || '';
        try { const j = await res.json(); detail = (j && j.error && (j.error.message || j.error.code)) || JSON.stringify(j); }
        catch (_) { try { detail = (await res.text()).slice(0, 300); } catch (_) {} }
        const err = new Error('openai-compatible http ' + res.status + ' - ' + detail);
        err.status = res.status;
        const cls = classifyApiError(err, { model: body.model });
        err.transient = cls.retryable;
        if (cls.retryable && attempt < RETRY_DELAYS.length) { await delay(RETRY_DELAYS[attempt], signal); continue; }
        throw err;
      }
    }

    async function loadCatalog() {
      if (catalog) return catalog;
      if (!catalogPromise) {
        catalogPromise = (async () => {
          try {
            const res = await doFetch(baseUrl + modelsPath, { headers: key ? { Authorization: 'Bearer ' + key } : {} });
            if (!res.ok) return [];
            const j = await res.json();
            const raw = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
            return raw.map(normalizeModel).filter(Boolean);
          } catch (_) { return []; }
        })();
      }
      catalog = await catalogPromise;
      if (!catalog.length) catalogPromise = null;
      return catalog;
    }
    async function listModels() { return (await loadCatalog()).map(m => Object.assign({}, m)); }
    function findModel(id) { return catalog ? catalog.find(m => m.id === id) : null; }
    function contextLimit(id) { const m = findModel(id); return (m && m.context_length) || defaultContext; }
    function priceOf(id) {
      const m = findModel(id);
      if (!m || !m.pricing) return null;
      const i = parseFloat(m.pricing.prompt) * 1e6, o = parseFloat(m.pricing.completion) * 1e6;
      return (isFinite(i) && isFinite(o)) ? { in: i, out: o } : null;
    }
    function supportsTools(id) { const m = findModel(id); return m ? m.supportsTools : null; }
    function reasoningEfforts() { return ['none']; }

    return { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts };
  }

  return { makeOpenAICompatibleProvider, _internals: { normalizeModel, cleanBaseUrl } };
});
