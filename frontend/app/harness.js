/* SKYNET — harness.js : the REAL agent harness (BYOK).
   Owns the model connection + streaming + token/cost accounting.

   For this prototype the call goes browser -> OpenRouter directly (CORS-friendly,
   key in localStorage). In the shipped desktop build this exact interface is
   re-implemented behind the Tauri sidecar + OS keychain — callers (chat.js) never
   change, only the transport inside Harness.chat() does. Keep that seam clean. */
'use strict';

const Harness = (() => {
  const LS = { key: 'skynet.byok.key', model: 'skynet.byok.model', prov: 'skynet.byok.prov' };
  const OR = 'https://openrouter.ai/api/v1';

  let totals = { tokens: 0, cost: 0, calls: 0 };
  let modelMap = {};   // id -> { id, name, pricing, context_length }
  // the agent's CURRENT context-window occupancy = the most recent turn's real prompt_tokens
  // (agent.cost.tokensIn). Distinct from totals.tokens (lifetime in+out). Ephemeral runtime state,
  // not persisted — on resume it stays 0 until the next real turn measures the live context.
  let lastTokensIn = 0;

  // Desktop (Tauri) build: the BYOK key lives in the OS keychain — never in localStorage and
  // never returned to this WebView. Rust stores it and injects it into the sidecar's env at spawn
  // (read only there). The browser build keeps the localStorage transport unchanged.
  const TAURI = (typeof window !== 'undefined') && window.__TAURI__ && window.__TAURI__.core;
  const DESKTOP = !!TAURI;
  const invoke = (cmd, args) => TAURI.invoke(cmd, args);
  let _configured = false;   // desktop: cached "is a key stored?" (loaded by init())

  /* desktop: load the keychain "configured?" flag once at boot, before the connect screen reads it */
  async function init() {
    if (!DESKTOP) return;
    try { _configured = await invoke('harness_has_key'); } catch (_) { _configured = false; }
  }
  /* whether a key is set — works in both modes; never exposes the value */
  function configured() { return DESKTOP ? _configured : !!getKey(); }

  // getKey() returns the real key in the browser; in desktop it returns '' (the key isn't here).
  const getKey = () => DESKTOP ? '' : (localStorage.getItem(LS.key) || '');
  const setKey = k => {
    if (DESKTOP) { _configured = !!(k && String(k).trim()); return invoke('harness_store_key', { key: k || '' }); }
    localStorage.setItem(LS.key, k || '');
  };
  const getModel = () => localStorage.getItem(LS.model) || '';
  const setModel = m => localStorage.setItem(LS.model, m || '');
  const getProv = () => localStorage.getItem(LS.prov) || 'openrouter';
  const setProv = p => localStorage.setItem(LS.prov, p || 'openrouter');

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
     The browser already fetches the full OpenRouter /models payload — context_length is right
     there next to pricing; we just stopped throwing it away. */
  function contextLimitOf(id) {
    const m = modelMap[id];
    return (m && m.context_length) || 0;
  }

  /* live context-window occupancy for the CURRENT agent's model: how full is the window right now.
     used = the latest real prompt_tokens; limit = the model's max context. Both come from real
     provider/catalog data — the gauge (CtxGauge) renders "calibrating" until both are known. */
  function contextState() {
    return { used: lastTokensIn, limit: contextLimitOf(getModel()) };
  }

  /* public model catalog (no key required) — populates the connect dropdown */
  async function listModels() {
    try {
      const r = await fetch(OR + '/models', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const list = (j.data || []).map(m => ({ id: m.id, name: m.name, pricing: m.pricing, context_length: m.context_length || 0 }));
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
  async function chat({ system, messages, onToken, onUsage, onToolCall, onToolResult, onRunId, onDeliverable, onPermission, agentId, isTask, signal }) {
    const key = getKey(), model = getModel(), provider = getProv();
    // Codex authenticates by an OAuth token (server-side); the desktop build keeps the key in the
    // sidecar's env (keychain). Neither needs a key sent from here.
    if (provider !== 'codex' && !DESKTOP && !key) throw new Error('no API key set');
    if (!model) throw new Error('no model selected');

    let res;
    try {
      const reqBody = { model, provider, system, messages, agentId: agentId || 'agent', isTask: !!isTask };
      if (!DESKTOP) reqBody.key = key;
      res = await fetch('/api/run', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      });
    } catch (e) {
      throw new Error('cannot reach the SKYNET sidecar — start it with `npm start` (node sidecar/index.js)');
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
        if (typeof U !== 'undefined' && U.bus) { try { U.bus.emit(name, payload); } catch (_) {} }
        switch (name) {
          case 'agent.run.start': runId = payload.runId; onRunId && onRunId(runId); break;
          case 'agent.token': full += payload.delta; onToken && onToken(payload.delta); break;
          case 'agent.tool_call': onToolCall && onToolCall(payload); break;
          case 'agent.tool_result': onToolResult && onToolResult(payload); break;
          case 'deliverable': onDeliverable && onDeliverable(payload); break;
          // the run is PAUSED on the sidecar awaiting this; the UI shows approve/always/full/deny and answers
          // via Harness.consent(). No more events arrive on this stream until the answer is POSTed.
          case 'permission.prompt': onPermission && onPermission(payload); break;
          case 'agent.cost':
            totals.tokens += (payload.tokensIn || 0) + (payload.tokensOut || 0);
            totals.cost += payload.usd || 0;
            // the newest prompt_tokens IS the live context occupancy — keep the last real reading
            if (payload.tokensIn) lastTokensIn = payload.tokensIn;
            lastUsage = { total_tokens: (payload.tokensIn || 0) + (payload.tokensOut || 0), cost: payload.usd };
            onUsage && onUsage(lastUsage); break;
          case 'capdenied': errMsg = errMsg || ('no ' + (payload.need || 'capability') + ' — ' + (payload.reason || '')); break;
          case 'agent.run.error': errMsg = payload.message; break;
          case 'agent.run.end': endReason = payload.reason; break;
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

  return {
    getKey, setKey, getModel, setModel, getProv, setProv, init, configured,
    listModels, priceOf, contextLimitOf, contextState, chat, cancel, haltAll, consent, notebook,
    totals: () => totals,
    setTotals: t => { totals = { tokens: t.tokens || 0, cost: t.cost || 0, calls: t.calls || 0 }; },
    resetTotals: () => { totals = { tokens: 0, cost: 0, calls: 0 }; lastTokensIn = 0; }
  };
})();
