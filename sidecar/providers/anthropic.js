/* sidecar/providers/anthropic.js - native Anthropic Messages API adapter.
   Converts the harness's OpenAI-style chat/tool transcript into Anthropic's
   messages wire, then normalizes Anthropic SSE back to HarnessEvent. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'), require('./prices.js'), require('./toolschema.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.anthropic = factory(root.SK.providers.provider, root.SK.providers.errorClass, root.SK.providers.prices, root.SK.providers.toolschema); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass, prices, toolschema) {
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
  // Prompt caching is ON by default (see the breakpoint() note below for why it pays). This is the kill
  // switch: it changes what Anthropic BILLS, so there has to be a way to turn it off without a code change.
  const CACHE_OFF = (function () {
    try {
      const raw = (typeof process !== 'undefined' && process.env) ? process.env.SKYNET_ANTHROPIC_CACHE : '';
      return String(raw == null ? '' : raw).trim() === '0';
    } catch (_) { return false; }
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
  // USER ATTACHMENTS (COMMS): a user turn may carry image parts alongside its text — the run path expands a
  // Commander's attached photo into an {type:'image_url', image_url:{url}} block before this adapter sees it.
  // Anthropic's native vision shape is {type:'image', source:{type:'base64'|'url', …}}, so map image_url → that.
  // Only USER messages get this (assistant/tool turns never carry images); an unrecognized part degrades to its
  // text or is dropped — never throws.
  function anthImageBlock(url) {
    const s = String(url == null ? '' : url);
    const m = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(s);
    if (m) {
      const media_type = (m[1] || 'image/png').toLowerCase();
      const data = m[2] ? (m[3] || '') : Buffer.from(decodeURIComponent(m[3] || ''), 'utf8').toString('base64');
      return { type: 'image', source: { type: 'base64', media_type, data } };
    }
    if (/^https?:\/\//i.test(s)) return { type: 'image', source: { type: 'url', url: s } };
    return null;
  }
  function userContentToBlocks(content) {
    if (content == null) return [];
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
    if (!Array.isArray(content)) return contentToTextBlocks(content);
    const out = [];
    for (const p of content) {
      if (typeof p === 'string') { if (p) out.push({ type: 'text', text: p }); continue; }
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text' && typeof p.text === 'string') { if (p.text) out.push({ type: 'text', text: p.text }); continue; }
      if (p.type === 'image_url') { const b = anthImageBlock(p.image_url && (p.image_url.url != null ? p.image_url.url : p.image_url)); if (b) out.push(b); continue; }
      if (p.type === 'image' && p.source) { out.push(p); continue; }   // already a native Anthropic image block
      if (typeof p.text === 'string' && p.text) out.push({ type: 'text', text: p.text });
    }
    return out;
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
      appendMessage(out, 'user', userContentToBlocks(msg.content));
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
      // Anthropic tolerates extra JSON-Schema keywords, so this is normalize() not the Gemini prune:
      // it only repairs shapes the wire genuinely rejects — chiefly a `{anyOf:[X,{type:'null'}]}`
      // null-union at the root of input_schema, the standard zod/Pydantic optional-field shape that
      // arrives with third-party MCP connector tools.
      out.push({
        name,
        description: fn.description || '',
        input_schema: toolschema.normalize(fn.parameters || { type: 'object', properties: {} })
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
      // /v1/models reports no pricing, so this comes from the dated list-rate table (prices.js) rather than
      // the wire. Same {prompt, completion} per-token shape every other adapter publishes, so listModels()
      // and priceOf() can never disagree. Unknown model -> null -> honestly 'unpriced'.
      pricing: prices.pricingBlock('anthropic', id),
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

    /* PROMPT CACHING (2026-07-26). Anthropic renders a request as tools -> system -> messages and caches by
       PREFIX, so ONE breakpoint on the last system block also covers the entire tool catalogue sitting in
       front of it — which is where the bytes actually are. Measured at the wire on a fully placed floor:
       72 tools = 37.7KB = 59.7% of the request, re-sent on every turn of a run.

       What makes it work is that the prefix is stable for a run's lifetime, and that is not an accident of
       this file: loop.js resolves `tools` ONCE (loop.js:162) and re-sends the same array every turn, and
       extractLeadingSystem hoists only the LEADING system run — the mid-run <steering_note>/<loop_guard>/
       <continuation> injections land as user turns at the END, so they never shift the cached prefix.
       BEFORE ADDING ANYTHING TO THE SYSTEM PROMPT: a clock, a turn counter, or a remaining-budget line would
       be a fresh prefix every turn and would silently reduce this to a pure 1.25x surcharge.

       The second breakpoint rides the last message block, extending the cache over the conversation as it
       grows — which is where the bytes migrate late in a long run, once tool results outweigh the schemas.

       Economics: a cache READ bills ~0.1x input, a WRITE ~1.25x, so this pays from the second request on.
       A run that ends in ONE turn pays the 1.25x for nothing — the right trade when the ceiling is 40
       iterations. Under a model's minimum cacheable prefix Anthropic simply declines to cache; that is a
       silent no-op rather than an error, so there is nothing to feature-detect per model. */
    function breakpoint(blocks) {
      if (CACHE_OFF || !Array.isArray(blocks) || !blocks.length) return blocks;
      const i = blocks.length - 1;
      const last = blocks[i];
      // COPY, never stamp in place: userContentToBlocks passes native image blocks through BY REFERENCE, so
      // mutating the last block here would reach back into the CALLER's message array and persist.
      if (last && typeof last === 'object') blocks[i] = Object.assign({}, last, { cache_control: { type: 'ephemeral' } });
      return blocks;
    }
    function buildBody(req) {
      const converted = messagesToAnthropic(req.messages || []);
      const body = {
        model: req.model,
        max_tokens: resolveMaxTokens(req),
        messages: converted.messages,
        stream: true
      };
      const tools = toAnthropicTools(req.tools);
      if (tools) body.tools = tools;
      // One breakpoint for the whole static prefix. System is the preferred anchor because it sits AFTER the
      // tools and so caches both; with no system prompt the last tool is the only anchor that covers them.
      if (converted.system) body.system = breakpoint([{ type: 'text', text: converted.system }]);
      else if (tools) breakpoint(tools);
      const lastMsg = converted.messages[converted.messages.length - 1];
      if (lastMsg) breakpoint(lastMsg.content);
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
        let sawSentinel = false;                     // the protocol's own end-of-stream marker
        while (!sawSentinel) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            const p = parseLine(line);
            if (!p) continue;
            if (p.done) { sawSentinel = true; break; }
            yield* emitFrom(p.json);
          }
        }
        if (!sawSentinel) {
          buf += dec.decode();
          if (buf.trim()) {
            const p = parseLine(buf);
            if (p && p.done) sawSentinel = true;
            else if (p && p.json) yield* emitFrom(p.json);
          }
        }
        // STREAM-END TRUTH (truthful-telemetry law): always emit exactly ONE terminal event, and say honestly
        // whether the stream really ENDED or merely stopped arriving. A clean mid-generation FIN yields neither
        // a `message_stop` (which sets doneEmitted) nor a sentinel; the loop cannot otherwise tell that apart
        // from a finished answer, so it shipped the fragment as a completed — and $0 — delivery.
        if (!doneEmitted) yield { type: 'done', finishReason: null, truncated: !sawSentinel };
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
    // Anthropic's API never reports a price, and returning null here left spentUsd at 0.00 for the whole run
    // — which silently disabled the per-run spend ceiling and the day/global pools (loop.js only stops when
    // spentUsd crosses the cap). Resolved off the dated list-rate table, independent of catalog warm state so
    // the cap works from the first turn; an unrecognized model still returns null and stays 'unpriced'.
    function priceOf(id) { return prices.priceOf('anthropic', id); }
    function supportsTools(id) { const m = findModel(id); return m ? m.supportsTools : true; }
    function reasoningEfforts() { return ['none']; }

    return { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts };
  }

  return { makeAnthropicProvider, _internals: { messagesToAnthropic, toAnthropicTools, normalizeUsage, normalizeModel, cleanBaseUrl } };
});
