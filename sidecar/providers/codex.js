/* sidecar/providers/codex.js — the ONLY module that knows the OpenAI Codex (ChatGPT-subscription) wire.
   Implements the LLMProvider seam (provider.js): stream(req) -> AsyncIterable<HarnessEvent>, plus
   listModels / contextLimit / priceOf / supportsTools. `fetch` is INJECTED (Node global in the host, a
   fake Response in tests).

   IMPORTANT — this is a DIFFERENT wire than openrouter.js. Inference goes to OpenAI's *Responses* API
   (chatgpt.com/backend-api/codex/responses), not chat/completions. So two things differ:
     · REQUEST: chat-style `messages` are converted to Responses `input[]` items — the system prompt is
       lifted into `instructions`, user/assistant turns become typed-content messages (input_text /
       output_text), assistant tool calls become `function_call` items, and tool results become
       `function_call_output` items. Tools are the Responses function-tool schema.
     · STREAM: the SSE event types are `response.output_text.delta`, `response.function_call_arguments.*`,
       `response.output_item.added/done`, `response.completed`, `response.failed` — NOT `choices[].delta`.
   We normalize both back to the SAME HarnessEvent stream the proven loop already consumes, so nothing
   downstream of the provider seam changes.

   Auth is an OAuth access_token (a JWT), passed as `Authorization: Bearer …` — there is no API key. The
   token's freshness (refresh before expiry) is the sidecar's job; this module just uses what it's given. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./errorClass.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.codex = factory(root.SK.providers.provider, root.SK.providers.errorClass); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, errorClass) {
  'use strict';

  const normalizeFinish = provider.normalizeFinish;
  const classifyApiError = errorClass.classifyApiError;
  const BASE = 'https://chatgpt.com/backend-api/codex';

  // The ChatGPT-account Codex backend exposes its OWN model list (DIFFERENT from the public OpenAI API
  // catalog) and the lineup drifts — slugs like gpt-5.1-codex* that the Codex CLI's public catalog still
  // lists are 400-rejected by the OAuth backend ("model is not supported when using Codex with a ChatGPT
  // account"). So the real list is DISCOVERED live (listModels -> GET /models, Hermes codex_models.py); this
  // static list is only the OFFLINE FALLBACK (curated to the slugs verified accepted as of 2026-05/06). All
  // Codex models are tool-capable; a subscription is flat-rate, so per-token price is null (cost = $0).
  const CLIENT_VERSION = '1.0.0';   // chatgpt.com/backend-api/codex/models?client_version=…
  const STATIC_MODELS = [
    { id: 'gpt-5.3-codex',       context_length: 272000, max_completion_tokens: 128000, supportsTools: true },
    { id: 'gpt-5.5',             context_length: 272000, max_completion_tokens: 128000, supportsTools: true },
    { id: 'gpt-5.4',             context_length: 272000, max_completion_tokens: 128000, supportsTools: true },
    { id: 'gpt-5.4-mini',        context_length: 272000, max_completion_tokens: 128000, supportsTools: true }
  ];
  const DEFAULT_MODEL = 'gpt-5.3-codex';

  const RETRY_DELAYS = [400, 1200];   // up to 2 pre-stream retries (no jitter -> determinism)
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

  // ---- request building: chat messages -> Responses input items --------------------------------------

  // Multimodal-safe text part. Responses rejects input_text inside an assistant message and output_text
  // inside a user message, so the part type follows the role.
  function textPart(role, text) { return { type: role === 'assistant' ? 'output_text' : 'input_text', text: String(text == null ? '' : text) }; }

  function contentToParts(content, role) {
    if (content == null) return [];
    if (typeof content === 'string') return content ? [textPart(role, content)] : [];
    if (Array.isArray(content)) {
      const out = [];
      for (const p of content) {
        if (typeof p === 'string') { if (p) out.push(textPart(role, p)); continue; }
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') { out.push(textPart(role, p.text || '')); continue; }
        if (p.type === 'image_url' || p.type === 'input_image') {
          const url = (p.image_url && (p.image_url.url || p.image_url)) || p.url || '';
          if (url) out.push({ type: 'input_image', image_url: url });
        }
      }
      return out;
    }
    return [textPart(role, String(content))];
  }

  // Lift the leading system message into `instructions`; return { instructions, rest }.
  function extractInstructions(messages) {
    let instructions = '';
    let rest = messages || [];
    if (rest.length && rest[0] && rest[0].role === 'system') {
      instructions = String(rest[0].content == null ? '' : rest[0].content).trim();
      rest = rest.slice(1);
    }
    return { instructions, rest };
  }

  function messagesToInput(messages) {
    const input = [];
    for (const msg of (messages || [])) {
      if (!msg || typeof msg !== 'object') continue;
      const role = msg.role;
      if (role === 'system') { input.push({ role: 'user', content: contentToParts(msg.content, 'user') }); continue; }
      if (role === 'tool') {
        // a chat tool-result message -> a Responses function_call_output item
        const callId = msg.tool_call_id || msg.call_id || '';
        input.push({ type: 'function_call_output', call_id: callId, output: String(msg.content == null ? '' : msg.content) });
        continue;
      }
      if (role === 'assistant') {
        const parts = contentToParts(msg.content, 'assistant');
        if (parts.length) input.push({ role: 'assistant', content: parts });
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const fn = (tc && tc.function) || {};
            input.push({
              type: 'function_call',
              call_id: tc.id || fn.call_id || '',
              name: fn.name || '',
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})
            });
          }
        }
        continue;
      }
      // default: user (or any other) role -> a user message
      input.push({ role: 'user', content: contentToParts(msg.content, role === 'assistant' ? 'assistant' : 'user') });
    }
    return input;
  }

  function toResponsesTools(tools) {
    if (!tools || !tools.length) return null;
    const out = [];
    for (const item of tools) {
      const fn = (item && item.function) || {};
      const name = fn.name;
      if (typeof name !== 'string' || !name.trim()) continue;
      out.push({ type: 'function', name: name, description: fn.description || '', strict: false, parameters: fn.parameters || { type: 'object', properties: {} } });
    }
    return out.length ? out : null;
  }

  function makeCodexProvider(opts) {
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('codex provider requires fetch (Node 18+) or opts.fetch');
    const token = opts.token || '';
    const baseUrl = (opts.baseUrl || BASE).replace(/\/$/, '');
    const reasoningEffort = opts.reasoningEffort || 'medium';

    function buildBody(req) {
      const { instructions, rest } = extractInstructions(req.messages || []);
      const body = {
        model: req.model || DEFAULT_MODEL,
        instructions: instructions || 'You are a helpful assistant.',
        input: messagesToInput(rest),
        store: false,
        stream: true,
        // ask the backend to echo encrypted reasoning so multi-turn chains stay coherent
        reasoning: { effort: reasoningEffort, summary: 'auto' },
        include: ['reasoning.encrypted_content']
      };
      const tools = toResponsesTools(req.tools);
      if (tools) { body.tools = tools; body.tool_choice = 'auto'; body.parallel_tool_calls = true; }
      return body;
    }

    async function* stream(req) {
      const body = buildBody(req);
      let res;
      try { res = await requestWithRetry(body, req.signal); }
      catch (e) { if (isAbort(e, req.signal)) return; throw e; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      // Responses streams function calls as discrete output items addressed by `output_index`. Map each
      // index we've seen to a small, dense tool index for the HarnessEvent stream (and remember which
      // were function_call items so we can emit tool_done + compute the finish reason).
      const toolIndexOf = new Map();   // output_index -> harness tool index
      const itemKind = new Map();      // output_index -> 'function_call' | 'message' | 'reasoning'
      let nextToolIndex = 0;
      let sawToolCall = false;

      // parse ONE raw SSE line -> a control signal or a JSON event payload. Responses SSE puts the event
      // name on both an `event:` line AND inside `data.type`; we switch on `data.type`.
      function parseLine(line) {
        const t = line.replace(/\r$/, '').trim();
        if (!t || t.charAt(0) === ':') return null;
        if (t.indexOf('data:') !== 0) return null;        // ignore `event:` lines; the type is in the data
        const data = t.slice(5).trim();
        if (data === '[DONE]') return { done: true };
        try { return { json: JSON.parse(data) }; } catch (e) { return null; }
      }

      function* emitFrom(ev) {
        const type = ev && ev.type;
        if (!type) return;
        switch (type) {
          case 'response.output_text.delta':
            if (typeof ev.delta === 'string' && ev.delta) yield { type: 'text', delta: ev.delta };
            return;
          case 'response.output_item.added': {
            const item = ev.item || {};
            const oi = ev.output_index;
            itemKind.set(oi, item.type);
            if (item.type === 'function_call') {
              sawToolCall = true;
              const idx = nextToolIndex++;
              toolIndexOf.set(oi, idx);
              yield { type: 'tool_start', index: idx, id: item.call_id || item.id || ('call_' + idx), name: item.name || '' };
              if (typeof item.arguments === 'string' && item.arguments) yield { type: 'tool_args', index: idx, chunk: item.arguments };
            }
            return;
          }
          case 'response.function_call_arguments.delta': {
            const idx = toolIndexOf.get(ev.output_index);
            if (idx != null && typeof ev.delta === 'string' && ev.delta) yield { type: 'tool_args', index: idx, chunk: ev.delta };
            return;
          }
          case 'response.output_item.done': {
            const oi = ev.output_index;
            if (itemKind.get(oi) === 'function_call' && toolIndexOf.has(oi)) yield { type: 'tool_done', index: toolIndexOf.get(oi) };
            return;
          }
          case 'response.completed': {
            const r = ev.response || {};
            if (r.usage) yield { type: 'usage', usage: normalizeUsage(r.usage) };
            yield { type: 'done', finishReason: finishFor(r) };
            return;
          }
          case 'response.incomplete': {
            const r = ev.response || {};
            if (r.usage) yield { type: 'usage', usage: normalizeUsage(r.usage) };
            const reason = (r.incomplete_details && r.incomplete_details.reason) || '';
            yield { type: 'done', finishReason: /max_output_tokens|length/.test(reason) ? 'length' : normalizeFinish('stop') };
            return;
          }
          case 'response.failed': {
            const err = (ev.response && ev.response.error) || ev.error || {};
            throw new Error('codex stream failed: ' + (err.message || err.code || 'unknown'));
          }
          case 'error':
            throw new Error('codex stream error: ' + ((ev.error && ev.error.message) || ev.message || 'unknown'));
          default:
            return;   // reasoning summaries, content_part.*, created/in_progress — ignored for the harness stream
        }
      }

      function finishFor(r) {
        if (r && r.status === 'incomplete') {
          const reason = (r.incomplete_details && r.incomplete_details.reason) || '';
          if (/max_output_tokens|length/.test(reason)) return 'length';
        }
        return sawToolCall ? 'tool_calls' : 'stop';
      }

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const lineStr = buf.slice(0, nl); buf = buf.slice(nl + 1);
            const p = parseLine(lineStr);
            if (!p) continue;
            if (p.done) return;
            yield* emitFrom(p.json);
          }
        }
        buf += dec.decode();
        if (buf.trim()) { const p = parseLine(buf); if (p && !p.done && p.json) yield* emitFrom(p.json); }
      } catch (e) {
        if (isAbort(e, req.signal)) return;
        throw e;
      }
    }

    // POST the responses request, retrying transient failures (429/5xx + network) BEFORE the stream starts.
    async function requestWithRetry(body, signal) {
      for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw abortError();
        let res;
        try {
          res = await doFetch(baseUrl + '/responses', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'OpenAI-Beta': 'responses=experimental',
              'originator': 'codex_cli_rs'
            },
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
        catch (e) { try { detail = (await res.text()).slice(0, 300); } catch (_) {} }
        const err = new Error('codex http ' + res.status + ' — ' + detail);
        err.status = res.status;
        const cls = classifyApiError(err, { model: body.model });
        err.transient = cls.retryable;
        if (cls.retryable && attempt < RETRY_DELAYS.length) { await delay(RETRY_DELAYS[attempt], signal); continue; }
        throw err;
      }
    }

    function findModel(id) { return STATIC_MODELS.find(m => m.id === id) || null; }

    // The ACCOUNT's real model list — what the Codex backend will actually accept (the whole point: a slug
    // missing here is the one that 400s). GET /models with the bearer token; entries are { slug, visibility,
    // priority, … }. Skip hidden ones, sort by priority (the backend's recommended order), fall back to the
    // curated STATIC_MODELS when offline / no token. Mirrors Hermes codex_models._fetch_models_from_api.
    async function listModels() {
      try {
        const res = await doFetch(baseUrl + '/models?client_version=' + CLIENT_VERSION, {
          headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
        });
        if (res.ok) {
          const j = await res.json();
          const entries = (j && Array.isArray(j.models)) ? j.models : [];
          const out = [];
          for (const it of entries) {
            if (!it || typeof it.slug !== 'string' || !it.slug.trim()) continue;
            const vis = String(it.visibility || '').toLowerCase();
            if (vis === 'hide' || vis === 'hidden') continue;   // backend marks slugs it won't serve to this account
            out.push({
              id: it.slug.trim(),
              context_length: it.context_window || it.max_context_window || 272000,
              max_completion_tokens: it.max_output_tokens || null,
              supportsTools: true, pricing: null,
              _rank: (typeof it.priority === 'number') ? it.priority : 10000
            });
          }
          out.sort((a, b) => (a._rank - b._rank) || a.id.localeCompare(b.id));
          if (out.length) return out.map(({ _rank, ...m }) => m);
        }
      } catch (e) { /* offline / no token -> curated fallback below */ }
      return STATIC_MODELS.map(m => Object.assign({}, m, { pricing: null }));
    }
    function contextLimit(id) { const m = findModel(id); return (m && m.context_length) || 272000; }   // sane default for an unlisted Codex model
    function priceOf() { return null; }                  // flat-rate subscription -> no per-token price
    function supportsTools(id) { const m = findModel(id); return m ? !!m.supportsTools : true; }   // Codex models are tool-capable; never false-refuse

    return { stream, listModels, contextLimit, priceOf, supportsTools };
  }

  // Responses usage uses input_tokens/output_tokens; remap to the prompt_tokens/completion_tokens shape
  // the cost engine + context gauge read. A subscription is flat-rate, so cost is recorded as 0.
  function normalizeUsage(u) {
    u = u || {};
    const inDetails = u.input_tokens_details || {};
    const outDetails = u.output_tokens_details || {};
    return {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)),
      reasoning_tokens: outDetails.reasoning_tokens || 0,
      prompt_tokens_details: { cached_tokens: inDetails.cached_tokens || 0 },
      cost: 0
    };
  }

  return { makeCodexProvider, STATIC_MODELS, DEFAULT_MODEL, _internals: { messagesToInput, extractInstructions, toResponsesTools, normalizeUsage } };
});
