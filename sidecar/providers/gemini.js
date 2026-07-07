/* sidecar/providers/gemini.js - native Google Gemini GenerateContent adapter.
   Keeps the harness transcript/tool seam stable while speaking Gemini's
   contents/tools/functionCall wire. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.gemini = factory(root.SK.providers.provider, root.SK.providers.errorClass); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass) {
  'use strict';

  const classifyApiError = errorClass.classifyApiError;
  const timeouts = provider.timeouts;
  const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const RETRY_DELAYS = [400, 1200];
  const REWARM_MIN_MS = 5 * 60 * 1000;

  function isAbort(e, signal) { return !!((signal && signal.aborted) || (e && e.name === 'AbortError')); }
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
  function headerBag(key, accept) {
    const h = { 'Content-Type': 'application/json', 'Accept': accept || 'text/event-stream' };
    if (key) h['x-goog-api-key'] = key;
    return h;
  }
  function modelPath(id) {
    const s = String(id || '').trim();
    if (!s) return 'models/gemini-pro';
    return s.indexOf('/') >= 0 ? s.replace(/^\/+/, '') : ('models/' + s);
  }
  function stripModelPrefix(id) {
    return String(id || '').replace(/^models\//, '');
  }
  function safeJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }
  function responseObject(content) {
    const parsed = safeJson(content, null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { content: String(content == null ? '' : content) };
  }
  function textFromContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const out = [];
      for (const p of content) {
        if (typeof p === 'string') { out.push(p); continue; }
        if (!p || typeof p !== 'object') continue;
        if (typeof p.text === 'string') out.push(p.text);
        else if (typeof p.content === 'string') out.push(p.content);
      }
      return out.join('');
    }
    return String(content);
  }
  function contentToParts(content) {
    const text = textFromContent(content);
    return text ? [{ text }] : [];
  }
  function appendContent(out, role, parts) {
    if (!parts || !parts.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.parts)) {
      last.parts = last.parts.concat(parts);
      return;
    }
    out.push({ role, parts });
  }
  function extractLeadingSystem(messages) {
    const system = [];
    let i = 0;
    for (; i < (messages || []).length; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'system') break;
      const text = textFromContent(msg.content).trim();
      if (text) system.push({ text });
    }
    return { systemInstruction: system.length ? { parts: system } : null, rest: (messages || []).slice(i) };
  }
  function messagesToGemini(messages) {
    const picked = extractLeadingSystem(messages || []);
    const contents = [];
    const callNames = Object.create(null);
    for (const msg of picked.rest) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'tool') {
        const callId = String(msg.tool_call_id || msg.call_id || '');
        const name = callNames[callId] || msg.name || callId || 'tool';
        appendContent(contents, 'user', [{ functionResponse: { name, response: responseObject(msg.content) } }]);
        continue;
      }
      if (msg.role === 'assistant') {
        const parts = contentToParts(msg.content);
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const fn = (tc && tc.function) || {};
            const name = String(fn.name || '').trim();
            if (!name) continue;
            const callId = String((tc && tc.id) || fn.call_id || '');
            if (callId) callNames[callId] = name;
            parts.push({ functionCall: { name, args: safeJson(fn.arguments, {}) } });
          }
        }
        appendContent(contents, 'model', parts);
        continue;
      }
      appendContent(contents, 'user', contentToParts(msg.content));
    }
    return { systemInstruction: picked.systemInstruction, contents };
  }
  function toGeminiTools(tools) {
    if (!tools || !tools.length) return null;
    const declarations = [];
    for (const item of tools) {
      const fn = (item && item.function) || {};
      const name = String(fn.name || '').trim();
      if (!name) continue;
      declarations.push({
        name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} }
      });
    }
    return declarations.length ? [{ functionDeclarations: declarations }] : null;
  }
  function normalizeUsage(u) {
    u = u || {};
    const prompt = Number(u.promptTokenCount || 0) || 0;
    const out = Number(u.candidatesTokenCount || u.outputTokenCount || 0) || 0;
    const total = Number(u.totalTokenCount || 0) || (prompt + out);
    return {
      prompt_tokens: prompt,
      completion_tokens: out,
      total_tokens: total,
      prompt_tokens_details: { cached_tokens: Number(u.cachedContentTokenCount || 0) || 0 },
      reasoning_tokens: Number(u.thoughtsTokenCount || 0) || 0
    };
  }
  function finishFor(reason, sawToolCall) {
    const r = String(reason || '').trim().toUpperCase();
    if (sawToolCall && (!r || r === 'STOP')) return 'tool_calls';
    if (!r || r === 'STOP') return 'stop';
    if (r === 'MAX_TOKENS') return 'length';
    if (/SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII/.test(r)) return 'content_filter';
    return 'error';
  }
  function normalizeModel(m) {
    const raw = (m && (m.name || m.id || m.model)) ? String(m.name || m.id || m.model) : '';
    const id = stripModelPrefix(raw);
    if (!id) return null;
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods.slice() : [];
    const canGenerate = !methods.length || methods.indexOf('generateContent') >= 0 || methods.indexOf('streamGenerateContent') >= 0;
    return {
      id,
      name: m.displayName || m.name || id,
      context_length: Number(m.inputTokenLimit || m.context_length || 0) || 0,
      max_completion_tokens: Number(m.outputTokenLimit || m.max_completion_tokens || 0) || null,
      pricing: null,
      supported_parameters: canGenerate ? ['tools'] : [],
      supportsTools: canGenerate ? true : null,
      supportsReasoning: null,
      reasoningEfforts: []
    };
  }

  function makeGeminiProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('gemini provider requires fetch (Node 18+) or opts.fetch');
    const key = opts.key || '';
    const baseUrl = cleanBaseUrl(opts.baseUrl);
    const defaultContext = Number(opts.defaultContext || 0) || 0;
    const clock = (opts.clock && typeof opts.clock.now === 'function') ? opts.clock : null;
    let catalog = null;
    let catalogPromise = null;
    let catalogRewarmAt = 0;
    let rewarmKicked = false;

    function maybeRewarmCatalog() {
      if (catalog && catalog.length) return;
      if (catalogPromise) return;
      if (clock) {
        const now = clock.now();
        if (now - catalogRewarmAt < REWARM_MIN_MS) return;
        catalogRewarmAt = now;
      } else {
        if (rewarmKicked) return;
        rewarmKicked = true;
      }
      Promise.resolve().then(() => loadCatalog()).catch(() => {});
    }

    function buildBody(req) {
      const converted = messagesToGemini(req.messages || []);
      const body = { contents: converted.contents };
      if (converted.systemInstruction) body.systemInstruction = converted.systemInstruction;
      const tools = toGeminiTools(req.tools);
      if (tools) body.tools = tools;
      return body;
    }

    async function* stream(req) {
      req = req || {};
      maybeRewarmCatalog();
      const body = buildBody(req);
      let res;
      try { res = await requestWithRetry(req.model, body, req.signal); }
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }
      const reader = timeouts.idleGuardedReader(res.body.getReader(), { signal: req.signal });
      const dec = new TextDecoder();
      let buf = '';
      const toolIndexOf = new Map();
      const argsSentFor = new Set();   // dense tool indices we've already emitted nonempty args for (dup-call guard)
      let dupToolSeq = 0;              // disambiguates a repeated ci:pi:name that is actually a NEW call
      let nextToolIndex = 0;
      let sawToolCall = false;
      let doneEmitted = false;

      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (!t || t.charAt(0) === ':' || t.indexOf('event:') === 0) return null;
        if (t.indexOf('data:') !== 0) return null;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (_) { return null; }
      }
      function* emitFrom(j) {
        if (!j || typeof j !== 'object') return;
        if (j.error) throw new Error('gemini stream error: ' + ((j.error && (j.error.message || j.error.status || j.error.code)) || 'unknown'));
        const candidates = Array.isArray(j.candidates) ? j.candidates : [];
        for (let ci = 0; ci < candidates.length; ci++) {
          const c = candidates[ci] || {};
          const parts = (((c.content || {}).parts) || []);
          for (let pi = 0; pi < parts.length; pi++) {
            const part = parts[pi] || {};
            if (typeof part.text === 'string' && part.text) yield { type: 'text', delta: part.text };
            if (part.functionCall) {
              // Gemini normally delivers each functionCall WHOLE (complete args) in a single part, so ci:pi:name
              // uniquely maps a call. But if the same ci:pi:name recurs in a LATER SSE frame carrying its OWN
              // nonempty args, that is a SECOND, distinct tool call — reusing the index would make the consumer
              // concatenate two whole JSON objects ({"a":1}{"b":2}) into invalid args. So: if a key repeats AND we
              // already emitted nonempty args for it, treat the recurrence as a NEW call (suffix a counter to force
              // a fresh key + index + tool_start). Empty-arg recurrences keep the original mapping (no corruption risk).
              const argsStr = part.functionCall.args != null ? JSON.stringify(part.functionCall.args || {}) : '';
              const hasArgs = argsStr && argsStr !== '{}';
              let keyOf = ci + ':' + pi + ':' + (part.functionCall.name || nextToolIndex);
              if (toolIndexOf.has(keyOf) && argsSentFor.has(toolIndexOf.get(keyOf)) && hasArgs) {
                keyOf = keyOf + '#' + (++dupToolSeq);   // a distinct repeat call -> its own index, never arg-concatenated
              }
              let idx = toolIndexOf.get(keyOf);
              if (idx == null) {
                idx = nextToolIndex++;
                toolIndexOf.set(keyOf, idx);
                sawToolCall = true;
                yield { type: 'tool_start', index: idx, id: part.functionCall.id || ('call_' + idx), name: part.functionCall.name || '' };
              }
              if (part.functionCall.args != null) { yield { type: 'tool_args', index: idx, chunk: argsStr }; if (hasArgs) argsSentFor.add(idx); }
              yield { type: 'tool_done', index: idx };
            }
          }
          if (c.finishReason && !doneEmitted) {
            doneEmitted = true;
            yield { type: 'done', finishReason: finishFor(c.finishReason, sawToolCall) };
          }
        }
        if (j.usageMetadata) yield { type: 'usage', usage: normalizeUsage(j.usageMetadata) };
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

    async function requestWithRetry(model, body, signal) {
      for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw abortError();
        let res;
        // Fresh connect guard per attempt; disarmed the instant the fetch settles so the ceiling can't abort
        // the streaming body (a connect expiry rejects as a `timeout`, a user-cancel as AbortError).
        const guard = timeouts.connectGuard(signal);
        try {
          res = await doFetch(baseUrl + '/' + modelPath(model) + ':streamGenerateContent?alt=sse', {
            method: 'POST',
            headers: headerBag(key),
            body: JSON.stringify(body),
            signal: guard.signal
          });
        } catch (e) {
          if (isAbort(e, signal)) throw e;
          if (attempt < RETRY_DELAYS.length) { await delay(RETRY_DELAYS[attempt], signal); continue; }
          throw e;
        } finally {
          guard.disarm();
        }
        if (res.ok && res.body) return res;
        let detail = res.statusText || '';
        try { const j = await res.json(); detail = (j && j.error && (j.error.message || j.error.status || j.error.code)) || JSON.stringify(j); }
        catch (_) { try { detail = (await res.text()).slice(0, 300); } catch (_) {} }
        const err = new Error('gemini http ' + res.status + ' - ' + detail);
        err.status = res.status;
        err.headers = res.headers;
        const cls = classifyApiError(err, { model });
        err.transient = cls.retryable;
        if (cls.retryable && attempt < RETRY_DELAYS.length) { await delay(Math.min(60000, Math.max(RETRY_DELAYS[attempt], cls.retryAfterMs || 0)), signal); continue; }
        throw err;
      }
    }

    async function loadCatalog() {
      if (catalog) return catalog;
      if (!catalogPromise) {
        catalogPromise = (async () => {
          try {
            const res = await doFetch(baseUrl + '/models', { headers: headerBag(key, 'application/json') });
            if (!res.ok) return [];
            const j = await res.json();
            const raw = Array.isArray(j.models) ? j.models : (Array.isArray(j.data) ? j.data : []);
            return raw.map(normalizeModel).filter(Boolean);
          } catch (_) { return []; }
        })();
      }
      catalog = await catalogPromise;
      if (!catalog.length) catalogPromise = null;
      return catalog;
    }
    async function listModels() { return (await loadCatalog()).map(m => Object.assign({}, m)); }
    function findModel(id) {
      const clean = stripModelPrefix(id);
      return catalog ? catalog.find(m => m.id === clean || m.id === id) : null;
    }
    function contextLimit(id) { const m = findModel(id); return (m && m.context_length) || defaultContext; }
    function priceOf() { return null; }
    function supportsTools(id) { const m = findModel(id); return m ? m.supportsTools : true; }
    function reasoningEfforts() { return ['none']; }

    return { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts };
  }

  return { makeGeminiProvider, _internals: { messagesToGemini, toGeminiTools, normalizeUsage, normalizeModel, modelPath, cleanBaseUrl, finishFor } };
});
