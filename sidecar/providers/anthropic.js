/* sidecar/providers/anthropic.js - native Anthropic Messages API adapter.
   Converts the harness's OpenAI-style chat/tool transcript into Anthropic's
   messages wire, then normalizes Anthropic SSE back to HarnessEvent. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.anthropic = factory(root.SK.providers.provider, root.SK.providers.errorClass); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass) {
  'use strict';

  const normalizeFinish = provider.normalizeFinish;
  const classifyApiError = errorClass.classifyApiError;
  const timeouts = provider.timeouts;
  const DEFAULT_BASE = 'https://api.anthropic.com/v1';
  const ANTHROPIC_VERSION = '2023-06-01';
  const RETRY_DELAYS = [400, 1200];
  const REWARM_MIN_MS = 5 * 60 * 1000;
  const DEFAULT_CONTEXT = 200000;
  const FALLBACK_MAX_TOKENS = 32000;   // Anthropic requires max_tokens; when the model's real ceiling is unknown, cap here
                                       // (well above the old 4096 so long deliverables aren't silently truncated) — decided 2026-07-04.
  // resolve the env override once, tolerant of a garbage value (a typo must never wedge generation).
  const ENV_MAX_TOKENS = (function () {
    try {
      const raw = (typeof process !== 'undefined' && process.env) ? process.env.SKYNET_ANTHROPIC_MAX_TOKENS : '';
      const n = Number(String(raw == null ? '' : raw).trim());
      return (Number.isFinite(n) && n > 0) ? Math.floor(n) : 0;
    } catch (_) { return 0; }
  })();

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
    const h = {
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
      'Accept': accept || 'text/event-stream'
    };
    if (key) h['x-api-key'] = key;
    return h;
  }
  function safeJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
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
  function contentToTextBlocks(content) {
    const text = textFromContent(content);
    return text ? [{ type: 'text', text }] : [];
  }
  function appendMessage(out, role, content) {
    if (!content || !content.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content = last.content.concat(content);
      return;
    }
    out.push({ role, content });
  }
  function extractLeadingSystem(messages) {
    const system = [];
    let i = 0;
    for (; i < (messages || []).length; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'system') break;
      const text = textFromContent(msg.content).trim();
      if (text) system.push(text);
    }
    return { system: system.join('\n\n'), rest: (messages || []).slice(i) };
  }
  function assistantToolBlocks(toolCalls) {
    const blocks = [];
    if (!Array.isArray(toolCalls)) return blocks;
    for (const tc of toolCalls) {
      const fn = (tc && tc.function) || {};
      const name = String(fn.name || '').trim();
      if (!name) continue;
      blocks.push({
        type: 'tool_use',
        id: String((tc && tc.id) || fn.call_id || ('call_' + blocks.length)),
        name,
        input: safeJson(fn.arguments, {})
      });
    }
    return blocks;
  }
  function messagesToAnthropic(messages) {
    const picked = extractLeadingSystem(messages || []);
    const out = [];
    for (const msg of picked.rest) {
      if (!msg || typeof msg !== 'object') continue;
      const role = msg.role;
      if (role === 'tool') {
        appendMessage(out, 'user', [{
          type: 'tool_result',
          tool_use_id: String(msg.tool_call_id || msg.call_id || ''),
          content: textFromContent(msg.content)
        }]);
        continue;
      }
      if (role === 'assistant') {
        appendMessage(out, 'assistant', contentToTextBlocks(msg.content).concat(assistantToolBlocks(msg.tool_calls)));
        continue;
      }
      appendMessage(out, 'user', contentToTextBlocks(msg.content));
    }
    return { system: picked.system, messages: out };
  }
  function toAnthropicTools(tools) {
    if (!tools || !tools.length) return null;
    const out = [];
    for (const item of tools) {
      const fn = (item && item.function) || {};
      const name = String(fn.name || '').trim();
      if (!name) continue;
      out.push({
        name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} }
      });
    }
    return out.length ? out : null;
  }
  function normalizeUsage(u) {
    u = u || {};
    const uncached = Number(u.input_tokens || 0) || 0;
    const cacheCreate = Number(u.cache_creation_input_tokens || 0) || 0;
    const cacheRead = Number(u.cache_read_input_tokens || 0) || 0;
    const out = Number(u.output_tokens || 0) || 0;
    return {
      prompt_tokens: uncached + cacheCreate + cacheRead,
      completion_tokens: out,
      total_tokens: uncached + cacheCreate + cacheRead + out,
      prompt_tokens_details: { cached_tokens: cacheRead },
      reasoning_tokens: 0
    };
  }
  function normalizeModel(m) {
    const id = (m && (m.id || m.name || m.model)) ? String(m.id || m.name || m.model) : '';
    if (!id) return null;
    return {
      id,
      name: m.display_name || m.name || id,
      context_length: Number(m.context_length || m.input_token_limit || DEFAULT_CONTEXT) || DEFAULT_CONTEXT,
      max_completion_tokens: m.max_output_tokens || m.output_token_limit || null,
      pricing: null,
      supported_parameters: ['tools'],
      supportsTools: true,
      supportsReasoning: null,
      reasoningEfforts: []
    };
  }

  function makeAnthropicProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('anthropic provider requires fetch (Node 18+) or opts.fetch');
    const key = opts.key || '';
    const baseUrl = cleanBaseUrl(opts.baseUrl);
    const defaultContext = Number(opts.defaultContext || DEFAULT_CONTEXT) || DEFAULT_CONTEXT;
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

    // The output-token ceiling for this request. Precedence (first defined wins):
    //   explicit per-request max_tokens  →  the model's real catalog max (when the catalog is warm)  →
    //   opts.maxTokens (composition-root override)  →  SKYNET_ANTHROPIC_MAX_TOKENS env  →  32000 fallback.
    // Callers that pass max_tokens explicitly keep working unchanged; everyone else gets the model's true
    // ceiling instead of a silent 4096 truncation.
    function resolveMaxTokens(req) {
      const explicit = Number(req.max_tokens || req.maxTokens || 0);
      if (explicit > 0) return explicit;
      const m = findModel(req.model);   // hoisted decl; null until the catalog warms
      const catMax = Number(m && m.max_completion_tokens);
      if (Number.isFinite(catMax) && catMax > 0) return catMax;
      const optMax = Number(opts.maxTokens || 0);
      if (optMax > 0) return optMax;
      if (ENV_MAX_TOKENS > 0) return ENV_MAX_TOKENS;
      return FALLBACK_MAX_TOKENS;
    }

    function buildBody(req) {
      const converted = messagesToAnthropic(req.messages || []);
      const body = {
        model: req.model,
        max_tokens: resolveMaxTokens(req),
        messages: converted.messages,
        stream: true
      };
      if (converted.system) body.system = converted.system;
      const tools = toAnthropicTools(req.tools);
      if (tools) body.tools = tools;
      return body;
    }

    async function* stream(req) {
      req = req || {};
      maybeRewarmCatalog();
      const body = buildBody(req);
      let res;
      try { res = await requestWithRetry(body, req.signal); }
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }
      const reader = timeouts.idleGuardedReader(res.body.getReader(), { signal: req.signal });
      const dec = new TextDecoder();
      let buf = '';
      const toolIndexOf = new Map();
      let nextToolIndex = 0;
      let doneEmitted = false;
      let lastStopReason = '';
      let baseUsage = {};

      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (!t || t.charAt(0) === ':' || t.indexOf('event:') === 0) return null;
        if (t.indexOf('data:') !== 0) return null;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (_) { return null; }
      }
      function* emitFrom(ev) {
        if (!ev || typeof ev !== 'object') return;
        if (ev.error) throw new Error('anthropic stream error: ' + ((ev.error && (ev.error.message || ev.error.type)) || 'unknown'));
        switch (ev.type) {
          case 'message_start':
            baseUsage = Object.assign({}, (ev.message && ev.message.usage) || {});
            if (ev.message && ev.message.usage) yield { type: 'usage', usage: normalizeUsage(ev.message.usage) };
            return;
          case 'content_block_start': {
            const block = ev.content_block || {};
            if (block.type !== 'tool_use') return;
            const idx = nextToolIndex++;
            toolIndexOf.set(ev.index, idx);
            yield { type: 'tool_start', index: idx, id: block.id || ('call_' + idx), name: block.name || '' };
            if (block.input && Object.keys(block.input).length) yield { type: 'tool_args', index: idx, chunk: JSON.stringify(block.input) };
            return;
          }
          case 'content_block_delta': {
            const d = ev.delta || {};
            if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
              yield { type: 'text', delta: d.text };
              return;
            }
            if (d.type === 'input_json_delta') {
              const idx = toolIndexOf.get(ev.index);
              if (idx != null && typeof d.partial_json === 'string' && d.partial_json) yield { type: 'tool_args', index: idx, chunk: d.partial_json };
            }
            return;
          }
          case 'content_block_stop': {
            const idx = toolIndexOf.get(ev.index);
            if (idx != null) yield { type: 'tool_done', index: idx };
            return;
          }
          case 'message_delta': {
            const d = ev.delta || {};
            if (d.stop_reason) lastStopReason = d.stop_reason;
            if (ev.usage) yield { type: 'usage', usage: normalizeUsage(Object.assign({}, baseUsage, ev.usage)) };
            if (d.stop_reason && !doneEmitted) {
              doneEmitted = true;
              yield { type: 'done', finishReason: normalizeFinish(d.stop_reason) };
            }
            return;
          }
          case 'message_stop':
            if (!doneEmitted) {
              doneEmitted = true;
              yield { type: 'done', finishReason: normalizeFinish(lastStopReason || 'stop') };
            }
            return;
          default:
            return;
        }
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
        // Fresh connect guard per attempt; disarmed the instant the fetch settles so the ceiling can't abort
        // the streaming body (a connect expiry rejects as a `timeout`, a user-cancel as AbortError).
        const guard = timeouts.connectGuard(signal);
        try {
          res = await doFetch(baseUrl + '/messages', {
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
        try { const j = await res.json(); detail = (j && j.error && (j.error.message || j.error.type)) || JSON.stringify(j); }
        catch (_) { try { detail = (await res.text()).slice(0, 300); } catch (_) {} }
        const err = new Error('anthropic http ' + res.status + ' - ' + detail);
        err.status = res.status;
        err.headers = res.headers;
        const cls = classifyApiError(err, { model: body.model });
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
    function priceOf() { return null; }
    function supportsTools(id) { const m = findModel(id); return m ? m.supportsTools : true; }
    function reasoningEfforts() { return ['none']; }

    return { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts };
  }

  return { makeAnthropicProvider, _internals: { messagesToAnthropic, toAnthropicTools, normalizeUsage, normalizeModel, cleanBaseUrl } };
});
