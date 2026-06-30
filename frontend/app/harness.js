/* STARNET — harness.js : the REAL agent harness (BYOK).
   Owns the model connection + streaming + token/cost accounting.

   For this prototype the call goes browser -> OpenRouter directly (CORS-friendly,
   key in localStorage). In the shipped desktop build this exact interface is
   re-implemented behind the Tauri sidecar + OS keychain — callers (chat.js) never
   change, only the transport inside Harness.chat() does. Keep that seam clean. */
'use strict';

const Harness = (() => {
  const LS = { key: 'starnet.byok.key', model: 'starnet.byok.model', prov: 'starnet.byok.prov', baseUrl: 'starnet.byok.baseUrl', effort: 'starnet.byok.reasoningEffort' };
  const OR = 'https://openrouter.ai/api/v1';

  let totals = { tokens: 0, cost: 0, calls: 0 };
  let modelMap = {};   // id -> { id, name, pricing, context_length, supportsTools }
  // Per-agent context-window occupancy = the latest real prompt_tokens for that same agent/model.
  // Distinct from totals.tokens (lifetime in+out), and not persisted across resumes.
  let contextByAgent = {};   // agentId -> { used, model, runId }
  let runModels = {};        // runId -> model from agent.run.start, for events that omit model

  // Desktop (Tauri) build: the BYOK key lives in the OS keychain — never in localStorage and
  // never returned to this WebView. Rust stores it and injects it into the sidecar's env at spawn
  // (read only there). The browser build keeps the localStorage transport unchanged.
  const TAURI = (typeof window !== 'undefined') && window.__TAURI__ && window.__TAURI__.core;
  const DESKTOP = !!TAURI;
  const invoke = (cmd, args) => TAURI.invoke(cmd, args);
  // DEV fast-path (sidecar started with SKYNET_DEV=1, e.g. `npm run dev:seed`): the host injects
  // window.__STARNET_DEV__ = {model, prov} and holds the API key in its own env (runtimeKey). We treat dev
  // like the desktop "server holds the key" seam — no key in the page, configured() is true, and a fresh
  // origin (a new worktree port) auto-resumes the server-seeded save with no connect screen / awakening.
  const DEV = (typeof window !== 'undefined' && window.__STARNET_DEV__ && typeof window.__STARNET_DEV__ === 'object') ? window.__STARNET_DEV__ : null;
  const DEVMODE = !!DEV;
  if (DEVMODE) {
    try {
      if (DEV.model) localStorage.setItem('starnet.byok.model', String(DEV.model));
      localStorage.setItem('starnet.byok.prov', String(DEV.prov || 'openrouter'));
    } catch (_) {}
  }
  let _configured = false;   // desktop: cached "is a key stored?" (loaded by init())
  let apiToken = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) ? String(window.__STARNET_API_TOKEN__) : '';
  let apiTokenPromise = null;

  function isApiUrl(u) {
    if (typeof u === 'string') return u.indexOf('/api/') === 0 || /\/api\//.test(u);
    return !!(u && typeof u.url === 'string' && /\/api\//.test(u.url));
  }
  function withApiToken(init, token) {
    init = Object.assign({}, init || {});
    const headers = new Headers(init.headers || {});
    if (token) headers.set('X-StarNet-Token', token);
    init.headers = headers;
    return init;
  }
  function ensureApiToken() {
    if (!apiToken && typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) apiToken = String(window.__STARNET_API_TOKEN__);
    if (apiToken) return Promise.resolve(apiToken);
    if (!apiTokenPromise) apiTokenPromise = Promise.resolve('').then(t => { apiTokenPromise = null; return t; });
    return apiTokenPromise;
  }
  if (typeof window !== 'undefined' && window.fetch && !window.__STARNET_FETCH_HARDENED__) {
    const rawFetch = window.fetch.bind(window);
    window.fetch = function (u, init) {
      if (!isApiUrl(u)) return rawFetch(u, init);
      return ensureApiToken().then(t => rawFetch(u, withApiToken(init, t)));
    };
    window.__STARNET_FETCH_HARDENED__ = true;
  }

  /* desktop: load the keychain "configured?" flag once at boot, before the connect screen reads it */
  async function init() {
    await ensureApiToken();
    if (!DESKTOP) return;
    try { _configured = await invoke('harness_has_key'); } catch (_) { _configured = false; }
  }
  /* whether a key is set — works in both modes; never exposes the value. In dev mode the host holds the
     key (runtimeKey), so we report configured without one — that's what lets a fresh origin auto-resume. */
  function normalizeProviderId(provider) {
    const p = String(provider || getProv() || 'openrouter').trim().toLowerCase();
    if (p === 'codex' || p === 'openai-codex') return 'codex';
    if (p === 'openai' || p === 'openai-api') return 'openai';
    if (p === 'ollama' || p === 'ollama-local') return 'ollama';
    if (p === 'custom' || p === 'openai-compatible' || p === 'local' || p === 'vllm' || p === 'lmstudio') return 'custom';
    return 'openrouter';
  }
  function providerNeedsKey(provider) {
    const p = normalizeProviderId(provider);
    return p !== 'codex' && p !== 'ollama' && p !== 'custom';
  }
  function configured(provider) {
    const p = normalizeProviderId(provider);
    if (p === 'ollama') return true;
    if (p === 'custom' && getBaseUrl()) return true;
    return DESKTOP ? _configured : (DEVMODE || !providerNeedsKey(p) || !!getKey());
  }

  // getKey() returns the real key in the browser; in desktop it returns '' (the key isn't here).
  const getKey = () => DESKTOP ? '' : (localStorage.getItem(LS.key) || '');
  const setKey = k => {
    if (DESKTOP) { _configured = !!(k && String(k).trim()); return invoke('harness_store_key', { key: k || '' }); }
    localStorage.setItem(LS.key, k || '');
  };
  const getModel = () => localStorage.getItem(LS.model) || '';
  const setModel = m => localStorage.setItem(LS.model, m || '');
  const getProv = () => normalizeProviderId(localStorage.getItem(LS.prov) || 'openrouter');
  const setProv = p => localStorage.setItem(LS.prov, normalizeProviderId(p || 'openrouter'));
  const getBaseUrl = () => localStorage.getItem(LS.baseUrl) || '';
  const setBaseUrl = u => localStorage.setItem(LS.baseUrl, u || '');
  function defaultReasoningEffortForProvider(provider) {
    const p = normalizeProviderId(provider);
    if (p === 'codex') return 'low';
    if (p === 'ollama') return 'none';
    return 'medium';
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
  const getReasoningEffort = provider => normalizeReasoningEffort(localStorage.getItem(LS.effort) || defaultReasoningEffortForProvider(provider));
  const setReasoningEffort = e => localStorage.setItem(LS.effort, normalizeReasoningEffort(e));

  /* per-million pricing for a model id, if known from the catalog */
  function priceOf(id) {
    const m = modelMap[id];
    if (!m || !m.pricing) return null;
    const inP = parseFloat(m.pricing.prompt) * 1e6;
    const outP = parseFloat(m.pricing.completion) * 1e6;
    if (!isFinite(inP) || !isFinite(outP)) return null;
    return { in: inP, out: outP };
  }

  /* the model's real max context-window length (tokens) from the catalog, or 0 if unknown.
     The sidecar's model endpoint carries OpenRouter context_length through to the browser; if
     that endpoint is unavailable we fall back to the public OpenRouter catalog. */
  function contextLimitOf(id) {
    const m = modelMap[id];
    return (m && m.context_length) || 0;
  }

  /* Last measured context-window occupancy for an agent/model. If the selected model changed or no
     provider prompt_tokens reading exists yet, measured:false prevents a stale percentage. */
  function contextState(agentId) {
    const aid = agentId || 'agent';
    const selectedModel = getModel();
    const rec = contextByAgent[aid] || null;
    const model = selectedModel || (rec && rec.model) || '';
    const measured = !!(rec && rec.model === model && rec.used > 0);
    return { agentId: aid, model, used: measured ? rec.used : 0, limit: contextLimitOf(model), measured };
  }

  function normalizeModel(m) {
    const params = Array.isArray(m && m.supported_parameters) ? m.supported_parameters.slice() : [];
    return {
      id: m && m.id,
      name: (m && (m.name || m.id)) || '',
      pricing: (m && m.pricing) || null,
      context_length: (m && +m.context_length) || 0,
      supportsTools: (m && typeof m.supportsTools === 'boolean') ? m.supportsTools : (params.length ? params.indexOf('tools') >= 0 : true),
      supportsReasoning: !!(m && m.supportsReasoning),
      supported_parameters: params,
      reasoningEfforts: Array.isArray(m && m.reasoningEfforts) ? m.reasoningEfforts.slice() : []
    };
  }

  async function fetchModelCatalog(url, field) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const raw = (j && j[field]) || [];
    return raw.map(normalizeModel).filter(m => m.id);
  }

  /* public model catalog (no key required) — populates the connect dropdown */
  async function listModels(provider) {
    try {
      let list;
      const p = normalizeProviderId(provider || getProv());
      try {
        const q = (p === 'custom' && getBaseUrl()) ? ('?baseUrl=' + encodeURIComponent(getBaseUrl())) : '';
        list = await fetchModelCatalog('/api/models/' + encodeURIComponent(p) + q, 'models');
      } catch (_) {
        if (p === 'openrouter') list = await fetchModelCatalog(OR + '/models', 'data');
        else list = [];
      }
      list.sort((a, b) => a.id.localeCompare(b.id));
      modelMap = {};
      for (const m of list) modelMap[m.id] = m;
      return list;
    } catch (e) {
      console.warn('[harness] model list unavailable:', e.message);
      return [];
    }
  }

  /* Run an agent turn/task through the LOCAL SIDECAR (node sidecar/index.js), which holds the
     real agent loop + tools (web, files). We POST the request and read the response body as a
     stream of newline-delimited JSON events — the FROZEN agent.* U.bus events the harness emits.
     Each event is re-emitted on U.bus (for telemetry) and mapped to the caller's callbacks.
     onToken(delta) per text delta · onToolCall/onToolResult per tool step · onUsage per turn. */
  async function chat({ system, messages, onToken, onUsage, onToolCall, onToolResult, onRunId, onDeliverable, onPermission, onSummon, agentId, isTask, recurring, signal, streamId, workbench, placed, internal }) {
    const key = getKey(), model = getModel(), provider = getProv(), reasoningEffort = getReasoningEffort(provider);
    // Codex authenticates by an OAuth token (server-side); the desktop build keeps the key in the
    // sidecar's env (keychain). Neither needs a key sent from here.
    if (providerNeedsKey(provider) && !DESKTOP && !DEVMODE && !key) throw new Error('no API key set');
    if (!model) throw new Error('no model selected');

    let res;
    try {
      const reqBody = { model, provider, reasoningEffort, system, messages, agentId: agentId || 'agent', isTask: !!isTask, recurring: !!recurring };
      if (getBaseUrl()) reqBody.baseUrl = getBaseUrl();
      if (streamId) reqBody.streamId = streamId;   // M-mem.2b: scope this run's memory to the active workstream
      // THE MOAT (FLOOR-REAL): send the agent's REAL placed capability objects so the sidecar grants exactly what's
      // on the floor (dish→web · cabinet→files · workbench→terminal · …). `placed` supersedes the legacy `workbench`
      // boolean; an old caller passing only `workbench` still grants the terminal.
      if (Array.isArray(placed) && placed.length) reqBody.placed = placed;
      else if (workbench) reqBody.workbench = true;
      if (!DESKTOP && !DEVMODE) reqBody.key = key;   // dev: omit so the sidecar uses its env key (runtimeKey)
      res = await fetch('/api/run', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      });
    } catch (e) {
      throw new Error('cannot reach the STARNET sidecar — start it with `npm start` (node sidecar/index.js)');
    }
    if (!res.ok || !res.body) throw new Error('sidecar HTTP ' + res.status);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '', lastUsage = null, runId = null, errMsg = null, endReason = null;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const s = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!s) continue;
        let ev; try { ev = JSON.parse(s); } catch (_) { continue; }
        const name = ev.name, payload = ev.payload || {};
        // INTERNAL reason-only calls (the pitch/suggest self-talk) still produce usage events, but must NOT
        // register as delivered tasks: drop their run.start/run.end re-emit so
        // XP / tasksDone / FloorStats products / the quest log / the suggestion cooldown never count the agent
        // thinking to itself (truthful-telemetry + honest-loot). The caller's own promise result is unaffected — the
        // switch below still latches runId/endReason locally from these same events.
        const suppressBus = internal && (name === 'agent.run.start' || name === 'agent.run.end');
        if (!suppressBus && typeof U !== 'undefined' && U.bus) { try { U.bus.emit(name, payload); } catch (_) {} }
        switch (name) {
          // latch the LEAD's runId on the FIRST run.start only. Stage 2: a delegated worker's run.start/end/error
          // are forwarded onto THIS (the lead's) stream for the floor animation — they still reach U.bus above, but
          // must NOT hijack the lead's runId / endReason / errMsg (keyed below to the lead's runId).
          case 'agent.run.start':
            if (payload.runId && payload.model) runModels[payload.runId] = payload.model;
            if (!runId) { runId = payload.runId; onRunId && onRunId(runId); }
            break;
          case 'agent.token': full += payload.delta; onToken && onToken(payload.delta); break;
          case 'agent.tool_call': onToolCall && onToolCall(payload); break;
          case 'agent.tool_result': onToolResult && onToolResult(payload); break;
          case 'deliverable': onDeliverable && onDeliverable(payload); break;
          // the run is PAUSED on the sidecar awaiting this; the UI shows approve/always/full/deny and answers
          // via Harness.consent(). No more events arrive on this stream until the answer is POSTed.
          case 'permission.prompt': onPermission && onPermission(payload); break;
          // a backend COMMAND: the orchestrator's team.summon tool asks us to create a worker. The handler runs the
          // real summonAgent() and POSTs /api/summon/ack with the new id (Harness.summonAck), resolving the tool.
          case 'crew.summon.request': onSummon && onSummon(payload); break;
          case 'agent.cost':
            totals.tokens += (payload.tokensIn || 0) + (payload.tokensOut || 0);
            totals.cost += payload.usd || 0;
            // The newest prompt_tokens is the live context reading for this event's agent/model.
            if (payload.tokensIn > 0) {
              const aid = payload.agentId || 'agent';
              const m = payload.model || runModels[payload.runId] || getModel();
              contextByAgent[aid] = { used: payload.tokensIn, model: m, runId: payload.runId || '' };
            }
            lastUsage = { total_tokens: (payload.tokensIn || 0) + (payload.tokensOut || 0), cost: payload.usd };
            onUsage && onUsage(lastUsage); break;
          case 'capdenied': errMsg = errMsg || ('no ' + (payload.need || 'capability') + ' — ' + (payload.reason || '')); break;
          case 'agent.run.error': if (!payload.runId || payload.runId === runId) errMsg = payload.message; break;   // the lead's own error (a worker's rides the tool result)
          case 'agent.run.end':
            if (payload.runId) delete runModels[payload.runId];
            if (!payload.runId || payload.runId === runId) endReason = payload.reason;
            break;   // the lead's own end, not a forwarded worker's
        }
      }
    }
    totals.calls++;
    // surface the error to the caller (do NOT swallow it just because some text streamed first) —
    // a network/fetch failure still throws below; this is for in-band run errors / capdenied.
    if (errMsg) return { text: full, usage: lastUsage, runId, error: errMsg, endReason };
    return { text: full, usage: lastUsage, runId, endReason };
  }

  /* Read-only fetch of an agent's notebook (its memory.md) from the sidecar. The agent writes these notes
     itself with the notebook tool during runs; the dossier just surfaces them. Returns [] on any failure. */
  async function notebook(agentId) {
    try {
      const r = await fetch('/api/notebook?agent=' + encodeURIComponent(agentId || 'agent'), { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.notes) ? j.notes : [];
    } catch (e) { return []; }
  }

  async function cancel(runId) {
    if (!runId) return;
    try { await fetch('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) }); } catch (_) {}
  }

  // E-STOP: stop EVERY in-flight run on the sidecar in one call — browser runs AND any messaging-hub/Telegram
  // runs. Returns how many were halted (0 if the sidecar is unreachable). Safe to call when nothing is running.
  async function haltAll() {
    try {
      const r = await fetch('/api/halt', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const j = await r.json().catch(() => ({}));
      return (j && typeof j.halted === 'number') ? j.halted : 0;
    } catch (_) { return 0; }
  }

  // answer a live permission.prompt: decision ∈ once|always|full|deny. Resolves the run's paused dispatch so it
  // continues (or denies). Separate request from the open /api/run stream — no deadlock.
  async function consent(runId, promptId, decision) {
    if (!runId || !promptId) return;
    try { await fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, promptId, decision }) }); } catch (_) {}
  }

  // answer a live crew.summon.request: report the new agentId we summoned (or null if we couldn't), which resolves
  // the run's awaiting team.summon tool. Separate request from the open /api/run stream — no deadlock. The summon
  // tool has its own browser-ack timeout, so a dropped ack settles cleanly to "not completed" rather than hanging.
  async function summonAck(runId, requestId, agentId) {
    if (!runId || !requestId) return;
    try { await fetch('/api/summon/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, requestId, agentId: agentId || null }) }); } catch (_) {}
  }

  // Cortex (M-mem.5b): after a run, reflection may PROPOSE durable memories (announced via the memory.proposed
  // SSE event). Fetch the pending candidates WITH content for the Keep/Edit/Discard turn-in beat. [] on failure.
  async function memoryProposals(runId, agentId) {
    try {
      const q = '?agent=' + encodeURIComponent(agentId || 'agent') + (runId ? '&run=' + encodeURIComponent(runId) : '');
      const r = await fetch('/api/memory/proposals' + q, { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.proposals) ? j.proposals : [];
    } catch (e) { return []; }
  }
  // submit one turn-in verdict. Keep/Edit commit a real memory (→ memory.write); every verdict → memory.feedback.
  // The sidecar re-broadcasts those over the SSE bus, so XP + the dossier update live without a local emit here.
  async function memoryTurnin(o) {
    try {
      const r = await fetch('/api/memory/turnin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
      return r.ok ? (await r.json().catch(() => ({ ok: true }))) : { ok: false };
    } catch (e) { return { ok: false }; }
  }
  // wipe a hero's SERVER-SIDE memory (notebook/declined/todo) on new-hero commission, so a fresh Commander never
  // inherits a stranger's kept memories or permanently-declined proposals. Fire-and-forget; a fresh hero proceeds
  // regardless (the browser advice stores are already reset locally).
  async function memoryReset(agentId) {
    try { await fetch('/api/memory/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId || 'agent' }) }); } catch (e) {}
  }

  // Cortex (M-mem.6) — the Memory Core: the FULL provenance-bearing §5.2 records (kind/sourceRunId/useCount/
  // trust/pinned/timestamps), which the slim /api/notebook view drops. [] on any failure.
  async function memoryRecords(agentId) {
    try {
      const r = await fetch('/api/memory/records?agent=' + encodeURIComponent(agentId || 'agent'), { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.records) ? j.records : [];
    } catch (e) { return []; }
  }
  // the three Memory Core mutations (the user's click IS the consent). { ok } on success.
  function memoryMutate(path, o) {
    return fetch('/api/memory/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) })
      .then(r => r.ok ? r.json().catch(() => ({ ok: true })) : { ok: false }).catch(() => ({ ok: false }));
  }
  const memoryPin = o => memoryMutate('pin', o);
  const memoryEdit = o => memoryMutate('edit', o);
  const memoryForget = o => memoryMutate('forget', o);
  // observability: the permanent declined reject-list (what reflection will never re-propose). [] on any failure.
  async function memoryDeclined(agentId) {
    try {
      const r = await fetch('/api/memory/declined?agent=' + encodeURIComponent(agentId || 'agent'), { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.declined) ? j.declined : [];
    } catch (e) { return []; }
  }
  const memoryRestore = o => memoryMutate('declined/restore', o);   // undo a discard — remove one entry from the reject-list

  return {
    getKey, setKey, getModel, setModel, getProv, setProv, getBaseUrl, setBaseUrl, getReasoningEffort, setReasoningEffort, normalizeReasoningEffort, init, configured,
    listModels, priceOf, contextLimitOf, contextState, chat, cancel, haltAll, consent, summonAck, notebook,
    memoryProposals, memoryTurnin, memoryReset, memoryRecords, memoryDeclined, memoryRestore, memoryPin, memoryEdit, memoryForget,
    apiToken: ensureApiToken,
    apiFetch: (u, init) => ensureApiToken().then(t => fetch(u, withApiToken(init, t))),
    totals: () => totals,
    setTotals: t => { totals = { tokens: t.tokens || 0, cost: t.cost || 0, calls: t.calls || 0 }; },
    resetTotals: () => { totals = { tokens: 0, cost: 0, calls: 0 }; contextByAgent = {}; runModels = {}; }
  };
})();
