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
  // Model catalogs are keyed BY PROVIDER. A single shared map was a real defect: ModelDock warms all
  // ~17 providers in parallel (modeldock.js fetchModels) and every listModels(p) miss reset the one
  // map, so whichever provider resolved LAST — usually an unconfigured one with an empty list — wiped
  // the ACTIVE provider's catalog. contextLimitOf()/priceOf() then returned 0 for the live model, and
  // the bottom-bar context gauge sat at unknown/"—" forever even after a real measured turn.
  let modelsByProv = Object.create(null);   // provider -> { id -> { id, name, pricing, context_length, supportsTools } }

  // Resolve a model id against the warmed catalogs, preferring the ACTIVE provider's (the same id can
  // exist under two providers with different windows/prices, e.g. a direct slug vs an OpenRouter one).
  function catalogModel(id) {
    if (!id) return null;
    const p = normalizeProviderId(getProv());
    const own = modelsByProv[p];
    if (own && own[id]) return own[id];
    for (const k in modelsByProv) { const m = modelsByProv[k] && modelsByProv[k][id]; if (m) return m; }
    return null;
  }
  // Per-agent context-window occupancy = the latest real prompt_tokens for that same agent/model.
  // Distinct from totals.tokens (lifetime in+out), and not persisted across resumes.
  let contextByAgent = {};   // agentId -> { used, model, runId }
  let runModels = {};        // runId -> model from agent.run.start, for events that omit model
  // Runs launched with internal:true (retitle / goal-judge / pitch / autopilot self-talk) are tiny
  // side prompts on the SAME agentId — their prompt_tokens must never overwrite the agent's real
  // context occupancy (they made the gauge snap back to ~1% right after every real turn).
  const internalRuns = new Set();   // runIds whose cost events are gauge-invisible

  // Fold ONE token-bearing agent.cost payload into the per-agent context occupancy. Called from the
  // U.bus subscription below, which sees BOTH transports: chat-stream events (re-emitted by chat()'s
  // reader) and routed/scheduled/channel runs arriving over the world SSE bridge — previously only
  // the chat path updated the gauge, so background runs never moved it.
  function foldContextCost(payload) {
    if (!payload || !(payload.tokensIn > 0)) return;               // summarizer/compaction emits omit token fields on purpose
    if (payload.runId && internalRuns.has(payload.runId)) return;  // gauge-invisible side prompt
    const aid = payload.agentId || 'agent';
    const m = payload.model || runModels[payload.runId] || getModel();
    contextByAgent[aid] = { used: payload.tokensIn, model: m, runId: payload.runId || '' };
  }

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
  let _configured = false;   // desktop back-compat alias for "is the OpenRouter key stored?"
  let _configuredByProvider = Object.create(null);
  let apiToken = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) ? String(window.__STARNET_API_TOKEN__) : '';
  let apiTokenPromise = null;

  // TRUE only for our OWN sidecar API — a same-origin request under /api/. The X-StarNet-Token this gates is a
  // PRIVATE local credential; a naive substring match on '/api/' would attach it to third-party URLs that merely
  // contain '/api/' (e.g. the OpenRouter fallback catalog https://openrouter.ai/api/v1/models), leaking the token
  // cross-origin AND forcing a CORS preflight OpenRouter rejects (so the fallback fails exactly when it's needed).
  // Same-origin = a leading-slash relative path ('/api/...') OR an absolute URL whose origin === location.origin.
  function apiPath(s) {
    s = String(s || '');
    if (s.indexOf('/api/') === 0) return true;   // leading-slash relative — always same-origin
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;   // other relative forms don't carry another origin
    try {
      const base = (typeof location !== 'undefined' && location.href) ? location.href : undefined;
      const parsed = new URL(s, base);
      const here = (typeof location !== 'undefined' && location.origin) ? location.origin : null;
      return here != null && parsed.origin === here && parsed.pathname.indexOf('/api/') === 0;
    } catch (_) { return false; }
  }
  function isApiUrl(u) {
    if (typeof u === 'string') return apiPath(u);
    return !!(u && typeof u.url === 'string' && apiPath(u.url));
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
    let loaded = false;
    try {
      const status = await invoke('harness_provider_key_status');
      if (Array.isArray(status)) {
        _configuredByProvider = Object.create(null);
        status.forEach(s => {
          const p = normalizeProviderId(s && s.provider);
          _configuredByProvider[p] = !!(s && s.configured);
        });
        _configured = !!_configuredByProvider.openrouter;
        loaded = true;
      }
    } catch (_) {}
    if (!loaded) {
      try { _configured = await invoke('harness_has_key'); } catch (_) { _configured = false; }
      _configuredByProvider.openrouter = _configured;
    }
    // CODEX IS NOT A KEYCHAIN PROVIDER (its OAuth tokens live sidecar-side in workspaces/codex/), so the
    // keychain status above can NEVER report it — which left configured('codex') false FOREVER on desktop:
    // every ChatGPT-sign-in install had brainReady() dead, so the live awakening beats + the V3 interview
    // silently degraded to the scripted spine on every machine (proven on Andrew's 3-install test,
    // 2026-07-19). Ask the sidecar directly; fail-open (a dead route just leaves it unconfigured).
    try {
      const r = await fetch('/api/auth/codex/status');   // same relative idiom app.js's refreshCodexStatus uses (works in browser + desktop webview)
      if (r && r.ok) { const j = await r.json(); if (j && j.connected) _configuredByProvider.codex = true; }
    } catch (_) {}
    // The OTHER device-code OAuth providers (grok/kimi) hold their tokens sidecar-side too — same probe,
    // same fail-open contract (a dead route just leaves them unconfigured).
    await Promise.all(['grok', 'kimi'].map(async pid => {
      try {
        const r = await fetch('/api/auth/' + pid + '/status');
        if (r && r.ok) { const j = await r.json(); if (j && j.connected) _configuredByProvider[pid] = true; }
      } catch (_) {}
    }));
  }
  /* whether a key is set — works in both modes; never exposes the value. In dev mode the host holds the
     key (runtimeKey), so we report configured without one — that's what lets a fresh origin auto-resume. */
  function normalizeProviderId(provider) {
    const p = String(provider || getProv() || 'openrouter').trim().toLowerCase();
    if (p === 'codex' || p === 'openai-codex') return 'codex';
    if (p === 'openai' || p === 'openai-api') return 'openai';
    if (p === 'anthropic' || p === 'claude') return 'anthropic';
    if (p === 'gemini' || p === 'google' || p === 'google-ai' || p === 'google-gemini') return 'gemini';
    // grok/kimi are their OWN keyless OAuth (subscription) providers — NOT aliases for the API-key
    // providers. Folding 'grok' into 'xai' here silently rewrote every GROK OAUTH selection into the
    // API-key xAI provider (and 'kimi' fell through to 'openrouter'), so the OAuth brains could never
    // actually be the active provider anywhere Harness owns the truth.
    if (p === 'grok' || p === 'grok-oauth' || p === 'supergrok' || p === 'xai-oauth') return 'grok';
    if (p === 'kimi' || p === 'moonshot' || p === 'kimi-code' || p === 'kimi-for-coding' || p === 'kimi-oauth') return 'kimi';
    if (p === 'xai' || p === 'x-ai') return 'xai';
    if (p === 'groq') return 'groq';
    if (p === 'mistral' || p === 'mistralai') return 'mistral';
    if (p === 'deepseek') return 'deepseek';
    if (p === 'together' || p === 'together-ai') return 'together';
    if (p === 'fireworks' || p === 'fireworks-ai') return 'fireworks';
    if (p === 'perplexity' || p === 'pplx' || p === 'sonar') return 'perplexity';
    if (p === 'cerebras') return 'cerebras';
    if (p === 'ollama' || p === 'ollama-local') return 'ollama';
    if (p === 'custom' || p === 'openai-compatible' || p === 'local' || p === 'vllm' || p === 'lmstudio') return 'custom';
    return 'openrouter';
  }
  function providerSlot(base, provider) {
    return base + '.' + normalizeProviderId(provider || getProv());
  }
  function readScoped(base, provider) {
    const p = normalizeProviderId(provider || getProv());
    const scoped = localStorage.getItem(providerSlot(base, p));
    if (scoped != null) return scoped;
    return p === 'openrouter' ? (localStorage.getItem(base) || '') : '';
  }
  function writeScoped(base, provider, value) {
    const p = normalizeProviderId(provider || getProv());
    const v = value == null ? '' : String(value);
    localStorage.setItem(providerSlot(base, p), v);
    if (p === 'openrouter') localStorage.setItem(base, v);
  }
  function setDesktopConfigured(provider, value) {
    const p = normalizeProviderId(provider || getProv());
    _configuredByProvider[p] = !!value;
    if (p === 'openrouter') _configured = !!value;
  }
  function providerNeedsKey(provider) {
    const p = normalizeProviderId(provider);
    // codex/grok/kimi authenticate by device-code OAuth tokens held sidecar-side; ollama/custom are keyless endpoints.
    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'custom';
  }
  function configured(provider) {
    const p = normalizeProviderId(provider);
    if (p === 'ollama') return true;
    if (p === 'custom' && getBaseUrl(p)) return true;
    return DESKTOP ? !!(_configuredByProvider[p] || (p === 'openrouter' && _configured)) : (DEVMODE || !providerNeedsKey(p) || !!getKey(p));
  }

  // Truthful-telemetry getter for the SETTINGS credential list/badges: true IFF a real credential
  // actually exists for this provider — never fabricated by DEVMODE. Unlike configured() (which gates
  // run-ability and intentionally reports true in DEVMODE for auto-resume), this answers ONLY "does a
  // stored credential back this row?" so removing a key makes the row/badge disappear on rerender.
  //   - a real API key is stored (browser localStorage), OR
  //   - desktop OS keychain reports it (getKey returns '' by design there; _configuredByProvider holds truth), OR
  //   - a deliberately keyless endpoint is configured (custom with a baseUrl; ollama is a local endpoint), OR
  //   - codex OAuth is connected, OR
  //   - DEV seed: the host holds a server-side runtime credential for exactly DEV.prov (the seeded provider).
  function hasStoredCredential(provider) {
    const p = normalizeProviderId(provider);
    if (p === 'codex') return DESKTOP ? !!_configuredByProvider.codex : (getProv() === 'codex');
    // grok/kimi mirror codex: OAuth tokens live sidecar-side, so the desktop configured map (fed by the boot
    // probe + app.js's status refresh) is the only local truth; in the browser the active-provider pick stands in.
    if (p === 'grok' || p === 'kimi') return DESKTOP ? !!_configuredByProvider[p] : (getProv() === p);
    if (p === 'ollama') return false;                      // an endpoint is configuration, never a credential
    if (p === 'custom' && !getKey(p)) return false;        // a keyless custom endpoint must not manufacture a key row
    if (DESKTOP) return !!(_configuredByProvider[p] || (p === 'openrouter' && _configured));
    if (!!readScoped(LS.key, p)) return true;              // a real key is stored in this browser
    if (DEVMODE && DEV && normalizeProviderId(DEV.prov) === p) return true;  // server-held runtime key for the seeded provider
    return false;
  }

  // getKey() returns the real key in the browser; in desktop it returns '' (the key isn't here).
  const getKey = provider => DESKTOP ? '' : readScoped(LS.key, provider);
  const setKey = (k, provider) => {
    const p = normalizeProviderId(provider || getProv());
    if (DESKTOP) {
      const on = !!(k && String(k).trim());
      // configured flips ONLY after the keychain write PROVES itself. The old optimistic pre-invoke flip meant a
      // rejected write (locked/denied keychain) left the map claiming "configured" while no key existed anywhere —
      // Settings toasted "✓ stored in your OS keychain", the no-key nudges stayed cleared, and the next run died
      // with no re-entry hint (desktop-only strand; the browser branch is synchronous localStorage). Callers see
      // the rejection and must render the honest failure.
      return invoke('harness_store_provider_key', { provider: p, key: k || '', baseUrl: getBaseUrl(p) || '' })
        .catch(e => {
          if (p === 'openrouter') return invoke('harness_store_key', { key: k || '' });
          throw e;
        })
        .then(r => { setDesktopConfigured(p, on); return r; })
        .catch(e => { setDesktopConfigured(p, false); throw e; });
    }
    writeScoped(LS.key, p, k || '');
  };
  // Channel bot tokens (Telegram/Discord). Desktop: store in the OS keychain via Tauri (never over HTTP, never
  // plaintext) — mirrors setKey for provider keys. Returns a promise that resolves to true when the token was
  // routed to the keychain, false in the browser build (where the caller lets the token ride the connect POST as
  // before). An empty token clears the stored token. `DESKTOP` is the only branch — dev/browser keep the old path.
  function storeChannelToken(channel, token) {
    const c = String(channel || '').trim().toLowerCase();
    if (!DESKTOP || !c) return Promise.resolve(false);
    return Promise.resolve(invoke('harness_store_channel_token', { channel: c, token: token || '' }))
      .then(() => true)
      .catch(e => { console.warn('[harness] channel-token store failed:', (e && e.message) || e); return false; });
  }
  const getModel = () => localStorage.getItem(LS.model) || '';
  const setModel = m => {
    const prev = localStorage.getItem(LS.model) || '';
    localStorage.setItem(LS.model, m || '');
    // A deliberate model switch invalidates every context-occupancy reading (a different window,
    // and the next prompt re-measures): blank the gauge honestly rather than show a stale fill.
    if ((m || '') !== prev) contextByAgent = {};
  };
  const getProv = () => normalizeProviderId(localStorage.getItem(LS.prov) || 'openrouter');
  const setProv = p => localStorage.setItem(LS.prov, normalizeProviderId(p || 'openrouter'));
  const getBaseUrl = provider => readScoped(LS.baseUrl, provider);
  const setBaseUrl = (u, provider) => {
    const p = normalizeProviderId(provider || getProv());
    writeScoped(LS.baseUrl, p, u || '');
    if (DESKTOP) {
      return invoke('harness_store_provider_key', { provider: p, baseUrl: u || '' }).catch(() => {});
    }
  };
  function defaultReasoningEffortForProvider(provider) {
    const p = normalizeProviderId(provider);
    if (p === 'codex') return 'low';
    if (p === 'kimi') return 'none';   // mirrors the sidecar registry profile (kimi-for-coding has no reasoning dial)
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
  const getReasoningEffort = provider => normalizeReasoningEffort(readScoped(LS.effort, provider) || defaultReasoningEffortForProvider(provider));
  const setReasoningEffort = (e, provider) => writeScoped(LS.effort, provider || getProv(), normalizeReasoningEffort(e));

  /* per-million pricing for a model id, if known from the catalog */
  function priceOf(id) {
    const m = catalogModel(id);
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
    const m = catalogModel(id);
    return (m && m.context_length) || 0;
  }

  /* Last measured context-window occupancy for an agent. The reading is trusted for the model that
     PRODUCED it (rec.model — the provider stamped it on the reconciled agent.cost), so a mid-run
     provider failover or a crew agent on an aux model still shows its real occupancy against that
     model's real limit. A USER model switch wipes the readings (setModel) — the gauge then honestly
     reports measured:false ("waiting for a measured prompt") until the new model's first real turn. */
  function contextState(agentId) {
    const aid = agentId || 'agent';
    const rec = contextByAgent[aid] || null;
    const measured = !!(rec && rec.used > 0 && rec.model);
    const model = (measured && rec.model) || getModel() || '';
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

  // The model catalog can proxy a LIVE external fetch (OpenRouter's /models); a slow/blocked upstream must
  // never hang a caller. Bound every catalog fetch with an AbortController timeout so listModels() always
  // settles — a timeout reads as "catalog unavailable" (empty list), exactly like an offline sidecar.
  const MODEL_CATALOG_TIMEOUT_MS = 6000;
  async function fetchModelCatalog(url, field) {
    let ctl = null, t = null;
    try { ctl = new AbortController(); t = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, MODEL_CATALOG_TIMEOUT_MS); } catch (_) {}
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const raw = (j && j[field]) || [];
      return raw.map(normalizeModel).filter(m => m.id);
    } finally { if (t) clearTimeout(t); }
  }

  /* public model catalog (no key required) — populates the connect dropdown */
  async function listModels(provider) {
    try {
      let list;
      const p = normalizeProviderId(provider || getProv());
      try {
        const q = (p === 'custom' && getBaseUrl(p)) ? ('?baseUrl=' + encodeURIComponent(getBaseUrl(p))) : '';
        list = await fetchModelCatalog('/api/models/' + encodeURIComponent(p) + q, 'models');
      } catch (_) {
        if (p === 'openrouter') list = await fetchModelCatalog(OR + '/models', 'data');
        else list = [];
      }
      list.sort((a, b) => a.id.localeCompare(b.id));
      // scope the catalog to the provider it was fetched FOR — never to a shared map another
      // provider's warm can overwrite (see modelsByProv above).
      const map = Object.create(null);
      for (const m of list) map[m.id] = m;
      modelsByProv[p] = map;
      return list;
    } catch (e) {
      console.warn('[harness] model list unavailable:', e.message);
      return [];
    }
  }

  // Truthful provider state for Settings. Configuration, credential custody, endpoint reachability and catalog
  // availability are independent facts; callers must never infer one from another. The sidecar performs the
  // round-trip so desktop keychain credentials stay out of the WebView, while browser BYOK can be supplied over
  // the same authenticated loopback seam used by /api/run. A failed probe is data, not an exception-shaped lie.
  async function probeProvider(provider) {
    const p = normalizeProviderId(provider || getProv());
    const baseUrl = getBaseUrl(p) || '';
    const credentialSaved = hasStoredCredential(p);
    const endpointConfigured = p === 'ollama' || (p === 'custom' && !!baseUrl);
    const selected = p === getProv();
    const fallback = { provider: p, credentialSaved, endpointConfigured, reachable: false, catalogAvailable: false, credentialVerified: false, selected, error: 'station unreachable' };
    if (p === 'custom' && !endpointConfigured) return Object.assign({}, fallback, { error: 'endpoint not configured' });
    try {
      const r = await fetch('/api/providers/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: p, key: getKey(p) || '', baseUrl })
      });
      const j = await r.json().catch(() => ({}));
      return {
        provider: p, credentialSaved, endpointConfigured,
        reachable: !!(r.ok && j.reachable), catalogAvailable: !!(j && j.catalogAvailable),
        credentialVerified: !!(j && j.credentialVerified), selected,
        error: String((j && j.error) || '')
      };
    } catch (_) { return fallback; }
  }

  // PURE (test-locked in harness-internal.test.js): fold a sidecar error-response body into the human tail of
  // the thrown "sidecar HTTP <status> — <detail>" message. JSON envelopes ({error}/{message}, + code when it
  // isn't already in the text) unwrap to their message; anything else passes through. Bounded, never throws.
  function sidecarErrorDetail(text) {
    const t = String(text == null ? '' : text).slice(0, 600).trim();
    if (!t) return '';
    try {
      const j = JSON.parse(t);
      const msg = j && (j.error || j.message);
      if (msg) {
        let out = String(msg);
        if (j.code && out.indexOf(String(j.code)) < 0) out += ' (' + String(j.code) + ')';
        return out.slice(0, 600).trim();
      }
    } catch (_) {}
    return t;
  }

  /* Run an agent turn/task through the LOCAL SIDECAR (node sidecar/index.js), which holds the
     real agent loop + tools (web, files). We POST the request and read the response body as a
     stream of newline-delimited JSON events — the FROZEN agent.* U.bus events the harness emits.
     Each event is re-emitted on U.bus (for telemetry) and mapped to the caller's callbacks.
     onToken(delta) per text delta · onToolCall/onToolResult per tool step · onUsage per turn. */
  async function chat({ system, messages, onToken, onUsage, onToolCall, onToolResult, onRunId, onDeliverable, onPermission, onSummon, agentId, isTask, recurring, signal, streamId, recipeId, workbench, placed, stationPlaced, internal, projectRoot, taskAction }) {
    const model = getModel(), provider = getProv(), key = getKey(provider), reasoningEffort = getReasoningEffort(provider);
    // Codex authenticates by an OAuth token (server-side); the desktop build keeps the key in the
    // sidecar's env (keychain). Neither needs a key sent from here.
    if (providerNeedsKey(provider) && !DESKTOP && !DEVMODE && !key) throw new Error('no API key set');
    if (!model) throw new Error('no model selected');

    let res;
    try {
      const reqBody = { model, provider, reasoningEffort, system, messages, agentId: agentId || 'agent', isTask: !!isTask, recurring: !!recurring };
      if (getBaseUrl(provider)) reqBody.baseUrl = getBaseUrl(provider);
      if (streamId) reqBody.streamId = streamId;   // M-mem.2b: scope this run's memory to the active workstream
      // reason-only self-talk (retitle / goal-judge / pitch / autopilot): the sidecar keeps the caller's system
      // prompt VERBATIM (no manual/capability/skill/memory dressing) and never stamps the away clock for it.
      if (internal) reqBody.internal = true;
      if (/^(answer|cancel|replace)$/.test(String(taskAction || ''))) reqBody.taskAction = String(taskAction);
      if (recipeId) reqBody.recipeId = String(recipeId).slice(0, 60);   // provenance spine: which recipe launched this run (rides to the durable run row)
      // project-anchored session (ref-parity working folder): the sidecar injects the folder context line
      // ONLY when this root is still a standing blessed path grant — an un-blessed root injects nothing.
      if (projectRoot) reqBody.projectRoot = String(projectRoot);
      // THE MOAT (FLOOR-REAL): send the agent's REAL placed capability objects so the sidecar grants exactly what's
      // on the floor (dish→web · cabinet→files · workbench→terminal · …). `placed` supersedes the legacy `workbench`
      // boolean; an old caller passing only `workbench` still grants the terminal.
      if (Array.isArray(placed) && placed.length) reqBody.placed = placed;
      else if (workbench) reqBody.workbench = true;
      // Class Loadouts (shared-gear model): the STATION-WIDE gear the agent draws on under the overseer. Tools stay
      // gated by `placed` (the agent's own desk-room), but a class's SKILL PACKAGE — recipes, not tools — becomes
      // available when the STATION has the required shared gear (a specialist owns only a desk yet still gets its
      // class skills). Sent separately so the tool projection is untouched; the sidecar uses it for skills only.
      if (Array.isArray(stationPlaced) && stationPlaced.length) reqBody.stationPlaced = stationPlaced;
      if (!DESKTOP && !DEVMODE && provider !== 'codex' && provider !== 'grok' && provider !== 'kimi') reqBody.key = key;   // dev/desktop + the OAuth providers keep secrets server-side (custom/ollama may still ride an optional key)
      res = await fetch('/api/run', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      });
    } catch (e) {
      throw new Error('cannot reach the STARNET sidecar — start it with `npm start` (node sidecar/index.js)');
    }
    // A pre-stream failure's TRUE reason lives in the response body — runRouteFailure's {"error":"sidecar
    // failure: Not signed in to ChatGPT …"} JSON, handleRun's "missing key/model", the token gate's "forbidden
    // token". The old bare throw discarded it, so the friendly-error ladder never saw the text it classifies on
    // and the RECONNECT CHATGPT / reload doors were lost on this whole path (EL-10/EL-11). Read it (bounded)
    // and carry it in the thrown message.
    if (!res.ok || !res.body) {
      let detail = '';
      try { detail = sidecarErrorDetail(await res.text()); } catch (_) {}
      throw new Error('sidecar HTTP ' + res.status + (detail ? ' — ' + detail : ''));
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '', lastUsage = null, runId = null, errMsg = null, endReason = null, finishReason = null;
    let budgetScope = null, budgetCapUsd = null;   // additive: WHICH spend cap ended a 'budget' run (+ its $ cap)

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
            if (internal && payload.runId) internalRuns.add(payload.runId);   // this run's cost events must not move the context gauge
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
            // The newest prompt_tokens is the live context reading for this event's agent/model. The
            // U.bus subscription (foldContextCost) already saw this payload via the re-emit above;
            // fold directly only when the bus is unavailable (headless/test embeds).
            if (typeof U === 'undefined' || !U.bus) foldContextCost(payload);
            lastUsage = { total_tokens: (payload.tokensIn || 0) + (payload.tokensOut || 0), cost: payload.usd };
            onUsage && onUsage(lastUsage); break;
          case 'capdenied': errMsg = errMsg || ('no ' + (payload.need || 'capability') + ' — ' + (payload.reason || '')); break;
          case 'agent.run.error': if (!payload.runId || payload.runId === runId) errMsg = payload.message; break;   // the lead's own error (a worker's rides the tool result)
          case 'agent.run.end':
            if (payload.runId) { delete runModels[payload.runId]; internalRuns.delete(payload.runId); }
            // latch the lead's stop reason AND (Lane 5, additive) WHY it stopped when the provider truncated/
            // filtered it — the caller renders a "cut short" recap instead of a delivered crate for those.
            if (!payload.runId || payload.runId === runId) {
              endReason = payload.reason; finishReason = payload.finishReason || null;
              // additive budget-stop detail: which cap fired + the effective $ cap (absent on non-budget stops)
              budgetScope = payload.budgetScope || null;
              budgetCapUsd = (typeof payload.budgetCapUsd === 'number' && isFinite(payload.budgetCapUsd)) ? payload.budgetCapUsd : null;
            }
            break;   // the lead's own end, not a forwarded worker's
        }
      }
    }
    totals.calls++;
    // surface the error to the caller (do NOT swallow it just because some text streamed first) —
    // a network/fetch failure still throws below; this is for in-band run errors / capdenied.
    if (errMsg) return { text: full, usage: lastUsage, runId, error: errMsg, endReason, finishReason, budgetScope, budgetCapUsd };
    return { text: full, usage: lastUsage, runId, endReason, finishReason, budgetScope, budgetCapUsd };
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
      // honest total: run controllers (browser/hub/force-fired beats) + cron leases + the driver-path beat —
      // everything the server ACTUALLY aborted, so the HALT toast never under-reports what the E-STOP stopped.
      const n = k => (j && typeof j[k] === 'number') ? j[k] : 0;
      return n('halted') + n('cronAborted') + n('beatAborted');
    } catch (_) { return 0; }
  }

  // answer a live permission.prompt: decision ∈ once|always|full|deny. Resolves the run's paused dispatch so it
  // continues (or denies). Separate request from the open /api/run stream — no deadlock.
  async function consent(runId, promptId, decision) {
    if (!runId || !promptId) return;
    try { await fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, promptId, decision }) }); } catch (_) {}
  }

  // EL-11 FIX 1c: attest to the sidecar that a live permission.prompt is now RENDERED to a human (the active
  // consent card, or the global background toast + rail marker). Earns the run's paused consent ONE bounded
  // extension of the fail-closed auto-deny timer — a deny on a prompt nobody saw is a consent violation.
  // Fire-and-forget; a stale id is a harmless no-op on the sidecar.
  async function consentAck(runId, promptId) {
    if (!runId || !promptId) return;
    try { await fetch('/api/consent/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, promptId }) }); } catch (_) {}
  }

  // answer a live crew.summon.request: report the new agentId we summoned (or null if we couldn't), which resolves
  // the run's awaiting team.summon tool. Separate request from the open /api/run stream — no deadlock. The summon
  // tool has its own browser-ack timeout, so a dropped ack settles cleanly to "not completed" rather than hanging.
  // `desk` (optional) is the room the new agent's seeded workstation actually landed in — the ONLY reason the
  // tool result may mention a desk at all, so the lead can never announce furniture the floor doesn't have.
  async function summonAck(runId, requestId, agentId, desk) {
    if (!runId || !requestId) return;
    const body = { runId, requestId, agentId: agentId || null };
    if (desk) body.desk = String(desk).slice(0, 60);
    try { await fetch('/api/summon/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (_) {}
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
  // GROWTH Tier 1: after a salient run a STUDY pass may propose DOSSIER belief updates (goals/pain/style/… ADD or
  // RETIRE). Fetch the pending candidates WITH text for the study turn-in card. Consent is applied locally to the
  // dossier (Keep→DossierStore.upsert / Discard→StudyStore denylist), so there is no server verdict call. [] on failure.
  async function studyProposals(runId, agentId) {
    try {
      const q = '?agent=' + encodeURIComponent(agentId || 'agent') + (runId ? '&run=' + encodeURIComponent(runId) : '');
      const r = await fetch('/api/study/proposals' + q, { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.proposals) ? j.proposals : [];
    } catch (e) { return []; }
  }
  // NS-6: after a salient task run the sidecar MINES threads (ideas the Commander floated but never acted on) into
  // a stash. Fetch the pending candidates for the thread turn-in card. Returns { runId, proposals } — the BATCH
  // runId matters: the turn-in verdict must reference the stash batch (which may be the agent's latest pending
  // batch when the exact run had none). { runId:null, proposals:[] } on any failure (fail-open).
  async function threadProposals(runId, agentId) {
    try {
      const q = '?agent=' + encodeURIComponent(agentId || 'agent') + (runId ? '&run=' + encodeURIComponent(runId) : '');
      const r = await fetch('/api/threads/proposals' + q, { cache: 'no-store' });
      if (!r.ok) return { runId: null, proposals: [] };
      const j = await r.json();
      return { runId: j.runId || null, proposals: Array.isArray(j.proposals) ? j.proposals : [] };
    } catch (e) { return { runId: null, proposals: [] }; }
  }
  // NS-6: submit ONE thread turn-in verdict { agentId, runId, id, verdict:'keep'|'edit'|'discard', title?, spec? }.
  // keep/edit COMMIT an open thread on the ledger (the click IS the consent — stash, never auto-commit); discard
  // permanently denylists the idea's fingerprint. Returns the server's { ok, reason } ({ ok:false } on failure).
  async function threadTurnin(o) {
    try {
      const r = await fetch('/api/threads/turnin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
      return r.ok ? (await r.json().catch(() => ({ ok: false }))) : { ok: false };
    } catch (e) { return { ok: false }; }
  }
  // submit one turn-in verdict. Keep/Edit commit a real memory (→ memory.write); every verdict → memory.feedback.
  // The sidecar re-broadcasts those over the SSE bus, so XP + the dossier update live without a local emit here.
  async function memoryTurnin(o) {
    try {
      const r = await fetch('/api/memory/turnin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
      return r.ok ? (await r.json().catch(() => ({ ok: true }))) : { ok: false };
    } catch (e) { return { ok: false }; }
  }
  // SILENT-SAVE UX: undo an auto-saved memory (the one-tap ✕ on a passive receipt). verdict:'veto' removes the
  // saved record (a notebook note, or a skill when kind:'skill') and adds its text to the permanent declined
  // denylist so it's never re-proposed. Server emits memory.forget/feedback over SSE. { ok } on success.
  function memoryVeto(o) {
    return memoryTurninSend(Object.assign({ verdict: 'veto' }, o || {}));
  }
  function memoryTurninSend(o) {
    return fetch('/api/memory/turnin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) })
      .then(r => r.ok ? r.json().catch(() => ({ ok: true })) : { ok: false }).catch(() => ({ ok: false }));
  }
  // wipe a hero's SERVER-SIDE memory (notebook/declined/todo) on new-hero commission, so a fresh Commander never
  // inherits a stranger's kept memories or permanently-declined proposals. Fire-and-forget; a fresh hero proceeds
  // regardless (the browser advice stores are already reset locally).
  async function memoryReset(agentId) {
    try { await fetch('/api/memory/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId || 'agent' }) }); } catch (e) {}
  }

  // Cortex (M-mem.6) — the Memory Core: the FULL provenance-bearing §5.2 records (kind/sourceRunId/useCount/
  // trust/pinned/timestamps), which the slim /api/notebook view drops. [] on any failure.
  async function agentSkills(agentId, opts) {
    opts = opts || {};
    try {
      const q = '?agent=' + encodeURIComponent(agentId || 'agent')
        + (opts.archived ? '&archived=1' : '')
        + (opts.body ? '&body=1' : '');
      const r = await fetch('/api/agent-skills' + q, { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.skills) ? j.skills : [];
    } catch (e) { return []; }
  }
  async function agentSkillManage(o) {
    try {
      const r = await fetch('/api/agent-skills/manage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
      return r.ok ? (await r.json().catch(() => ({ ok: true }))) : { ok: false };
    } catch (e) { return { ok: false }; }
  }
  /* The Commander's review decision on a skill the guard WITHHELD from the model. The approval is
     recorded against the content digest the sidecar just read, so any later edit re-asks. Carries
     the sidecar's refusal text through on failure — a 'block' verdict can never be approved and the
     panel must say why rather than silently fail. */
  async function agentSkillAllow(o) {
    try {
      const r = await fetch('/api/agent-skills/allow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
      const j = await r.json().catch(() => null);
      if (r.ok) return j || { ok: true };
      return { ok: false, error: (j && j.error) || 'could not record that decision' };
    } catch (e) { return { ok: false, error: 'the station did not answer' }; }
  }

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
  // High-stakes proposals still awaiting a verdict, across ALL runs (the durable queue). Unattended runs reflect
  // now, so a credential/PII/standing-instruction belief can be raised by a routine at 3am with nobody watching —
  // this is how it stays answerable instead of quietly evaporating. [] on any failure (never a fabricated deck).
  async function memoryPending(agentId) {
    try {
      const r = await fetch('/api/memory/pending?agent=' + encodeURIComponent(agentId || 'agent'), { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.pending) ? j.pending : [];
    } catch (e) { return []; }
  }

  /* Minimal JSON client for the sidecar's /api surface (the launch-token rides via the hardened
     window.fetch above). Two shapes, matching the two call-site idioms this codebase already uses:
       get(path)        -> resolves the parsed JSON; THROWS Error('http <status>') on a non-2xx.
                           Callers keep their own .catch — silence stays an explicit .catch(() => …).
       post(path, body) -> resolves { ok, status, j } where j is the parsed body EVEN on a non-2xx
       del(path)           (the sidecar's {error} envelope), so callers can surface j.error; rejects
                           only on network failure or a non-JSON body. body defaults to {}.
     Streaming responses (/api/run, /api/cron/run) and Response-shape consumers must NOT use this. */
  const api = {
    get: path => fetch(path, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }),
    post: (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body == null ? {} : body) })
      .then(r => r.json().then(j => ({ ok: r.ok, status: r.status, j }))),
    del: path => fetch(path, { method: 'DELETE' })
      .then(r => r.json().then(j => ({ ok: r.ok, status: r.status, j })))
  };

  // ONE fold point for context occupancy: every agent.cost on the bus — chat-stream re-emits AND
  // routed/scheduled/channel runs arriving over the world SSE bridge — updates the gauge. util.js
  // (U.bus) loads before this file; the chat reader keeps a direct-fold fallback for busless embeds.
  if (typeof U !== 'undefined' && U.bus) { try { U.bus.on('agent.cost', foldContextCost); } catch (_) {} }

  /* IS THE LOCAL ENGINE ACTUALLY UP? (2026-07-29 — the "Can't reach StarNet's local service" misdiagnosis.)
     A dead response stream and a dead sidecar are INDISTINGUISHABLE from the thrown fetch error alone (see the
     long note on isTransportLoss in friendlyerror.js), and the app used to assert the sidecar was gone and tell
     people to restart — sending users chasing a phantom for days when the real drop was the model's stream.
     This is the measurement that turns that guess into proof.

     GET /api/health is the right probe and the only one that works here: it is in apiauth's TOKEN_EXEMPT set, so
     it needs no X-StarNet-Token (a stale-token 403 would otherwise read as "dead" — a second lie), and its
     handler is a bare writeHead(200)/end('ok') that touches no store, so it cannot itself fail for load reasons.
     Bounded by an AbortController, because a socket the sidecar accepted and never answered (the exact
     hung-request bug this fix exists for) would otherwise hang the error row forever. On timeout we return
     `null`, NOT false — an unanswered probe has not proven the engine dead, and under truthful telemetry an
     inconclusive measurement must never be reported as a conclusive one.

     THE 4s BUDGET IS MEASURED, NOT GUESSED (2026-07-29, Chromium/WebView2, dead loopback port, n=13). A REFUSED
     connection does NOT fail in microseconds as you would expect — it is BIMODAL: ~250ms or ~1750-2015ms
     (Chromium appears to retry a dead keep-alive socket with a ~2s backoff before surfacing "Failed to fetch").
     Samples: 249,250,251,251,268,1754,1771,1773,1794,2015 + 251,1778,2030. A 2000ms budget therefore lands
     exactly ON the slow mode and half of all genuinely-dead engines time out into `null` — which is the ONE case
     where "restart StarNet" is the correct advice, so it must not be lost to an impatient probe. 4000ms clears
     the observed tail ~2x. Cost is bounded and rare: the common in-band failure path proves liveness by receipt
     and never calls this at all, and a healthy engine answers /api/health in ~1ms.
     Resolves true | false | null. Never throws, never rejects. */
  function pingEngine(timeoutMs) {
    const budget = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 4000;
    let ac = null, timer = null;
    try { ac = new AbortController(); } catch (_) { ac = null; }
    let timedOut = false;
    if (ac) timer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch (_) {} }, budget);
    const done = (v) => { if (timer) clearTimeout(timer); return v; };
    let p;
    try {
      p = fetch('/api/health', Object.assign({ cache: 'no-store' }, ac ? { signal: ac.signal } : {}));
    } catch (_) { return Promise.resolve(done(false)); }   // synchronous throw = no request left the page
    return Promise.resolve(p)
      // Any ANSWER at all proves something is listening and serving on the port — even a non-2xx. The claim
      // under test is "can't REACH the local service", so reachability, not the status code, is the verdict.
      .then(() => done(true))
      .catch(() => done(timedOut ? null : false));
  }

  return {
    pingEngine,
    isDesktop: () => DESKTOP,   // lets the UI tell a desktop keychain-store failure (token saved locally) from a browser no-op
    getKey, setKey, storeChannelToken, getModel, setModel, getProv, setProv, getBaseUrl, setBaseUrl, getReasoningEffort, setReasoningEffort, normalizeReasoningEffort, init, configured, hasStoredCredential, setDesktopConfigured,
    listModels, probeProvider, priceOf, contextLimitOf, contextState, chat, cancel, haltAll, consent, consentAck, summonAck, notebook,
    memoryProposals, memoryTurnin, memoryVeto, memoryReset, memoryRecords, memoryDeclined, memoryRestore, memoryPending, memoryPin, memoryEdit, memoryForget,
    studyProposals,
    threadProposals, threadTurnin,
    agentSkills, agentSkillManage, agentSkillAllow,
    api,
    apiToken: ensureApiToken,
    apiFetch: (u, init) => ensureApiToken().then(t => fetch(u, withApiToken(init, t))),
    totals: () => totals,
    setTotals: t => { totals = { tokens: t.tokens || 0, cost: t.cost || 0, calls: t.calls || 0 }; },
    resetTotals: () => { totals = { tokens: 0, cost: 0, calls: 0 }; contextByAgent = {}; runModels = {}; }
  };
})();
