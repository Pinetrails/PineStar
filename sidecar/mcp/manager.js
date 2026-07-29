/* sidecar/mcp/manager.js — the connector MANAGER: the host-side singleton that owns configured MCP
   connectors, keeps a client warm per connector, caches each server's tools/list, and projects those
   tools into registry tool defs on demand. Mirrors the Telegram channel's lifecycle (configure / status /
   remove) so index.js wires it the same way. All I/O arrives injected — makeTransport (the network edge),
   makeClient (the JSON-RPC client), makeToolDef (the translator) — so the manager's logic is unit-testable
   with fakes and stays free of ambient time/randomness (clock injected).

   makeConnectorManager({ makeTransport, makeClient?, makeToolDef?, clock?, timeoutMs?, onEvent? }) -> {
     configure(id, { transport?, url?, token?, command?, args?, cwd?, env?, label?, enabled? }) -> Promise<{ ok, state, toolCount, error? }>,
     remove(id) -> Promise, refresh(id) -> Promise<...>, close() -> Promise,
     status(id) -> summary | null, list() -> summary[],            // summaries NEVER include the token
     has(id), ids(),
     toolDefsFor(id) -> registry tool def[],                        // cached tools of ONE connector
     toolDefsForObjects(objects) -> registry tool def[],            // per-agent: defs for the room's connector objects
     call(id, toolName, args) -> Promise<{ content, isError }>
   }
   A placed connector object is { objectType:'connector', connectorId } (or { binding:{ connectorId } }). */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./client.js'), require('./translate.js'));
  } else {
    root.SK = root.SK || {}; root.SK.mcp = root.SK.mcp || {};
    root.SK.mcp.manager = factory(root.SK.mcp.client, root.SK.mcp.translate);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (clientMod, translateMod) {
  'use strict';

  function connectorIdOf(obj) {
    if (!obj || obj.objectType !== 'connector') return null;
    const id = obj.connectorId || (obj.binding && obj.binding.connectorId);
    return id ? String(id) : null;
  }

  function makeConnectorManager(deps) {
    deps = deps || {};
    const makeTransport = deps.makeTransport;
    if (typeof makeTransport !== 'function') throw new Error('makeConnectorManager: makeTransport is required (the network edge)');
    const makeClient = deps.makeClient || (clientMod && clientMod.makeMcpClient);
    const makeToolDef = deps.makeToolDef || (translateMod && translateMod.makeMcpToolDef);
    // Injected like makeToolDef, and OPTIONAL: a host (or a test) that passes neither simply gets the historic
    // tools-only projection rather than a crash.
    const makeAuxDefs = ('makeAuxDefs' in deps) ? deps.makeAuxDefs : (translateMod && translateMod.connectorAuxDefs);
    const clock = deps.clock || { now: () => 0 };
    const timeoutMs = deps.timeoutMs || 30000;
    const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : function () {};
    // AUTO-RECONNECT deps (injected so the manager stays timer/rng-free for tests + determinism lint). When absent
    // the reconnect scheduler is INERT (setTimeoutImpl null -> no reconnect armed), so existing callers are unchanged.
    const setTimeoutImpl = typeof deps.setTimeoutImpl === 'function' ? deps.setTimeoutImpl : null;
    const clearTimeoutImpl = typeof deps.clearTimeoutImpl === 'function' ? deps.clearTimeoutImpl : function () {};
    // jitter source: injected random() in [0,1); default is a fixed 0.5 (no Math.random literal here — the host
    // injects the real rng, keeping this module deterministic under lint).
    const random = typeof deps.random === 'function' ? deps.random : function () { return 0.5; };
    const RECONNECT_BASE_MS = Math.max(250, Number(deps.reconnectBaseMs) || 1000);
    const RECONNECT_MAX_MS = Math.max(RECONNECT_BASE_MS, Number(deps.reconnectMaxMs) || 60000);
    const RECONNECT_MAX_ATTEMPTS = Math.max(0, deps.reconnectMaxAttempts == null ? 8 : Number(deps.reconnectMaxAttempts));

    const conns = new Map();   // id -> { id, transportKind, url, token, ..., state, detail, tools[], client, transport, ts, reconnectAttempt, reconnectTimer, connecting }

    function normalizeTransport(cfg, prev) {
      const raw = cfg.transport || (prev && prev.transportKind) || (cfg.command || (prev && prev.command) ? 'stdio' : 'http');
      const t = String(raw || 'http').toLowerCase();
      if (t !== 'http' && t !== 'stdio') throw new Error('connector transport must be "http" or "stdio"');
      return t;
    }
    function normalizeArgs(args, prev) {
      if (!('args' in (args || {}))) return prev && Array.isArray(prev.args) ? prev.args.slice() : [];
      if (!Array.isArray(args.args)) throw new Error('connector stdio args must be an array');
      return args.args.map(a => String(a == null ? '' : a));
    }
    function normalizeEnv(cfg, prev) {
      if (!('env' in (cfg || {}))) return prev && prev.env && typeof prev.env === 'object' ? Object.assign({}, prev.env) : {};
      if (!cfg.env || typeof cfg.env !== 'object' || Array.isArray(cfg.env)) throw new Error('connector stdio env must be an object');
      const out = {};
      for (const k of Object.keys(cfg.env)) out[k] = String(cfg.env[k] == null ? '' : cfg.env[k]);
      return out;
    }
    // ADDITIVE: extra HTTP request headers (e.g. a custom auth scheme the bearer token can't express).
    // Same object-of-strings shape + carry-forward-when-absent contract as env.
    function normalizeHeaders(cfg, prev) {
      if (!('headers' in (cfg || {}))) return prev && prev.headers && typeof prev.headers === 'object' ? Object.assign({}, prev.headers) : {};
      if (!cfg.headers || typeof cfg.headers !== 'object' || Array.isArray(cfg.headers)) throw new Error('connector http headers must be an object');
      const out = {};
      for (const k of Object.keys(cfg.headers)) out[String(k)] = String(cfg.headers[k] == null ? '' : cfg.headers[k]);
      return out;
    }
    // ADDITIVE: an optional per-connector handshake/call timeout. Absent -> carry prev -> fall back to the
    // manager-global default; clamped to a sane range so a typo can't wedge a run forever or hang instantly.
    function normalizeTimeout(cfg, prev) {
      if (!cfg || cfg.timeoutMs == null) return (prev && prev.timeoutMs) || timeoutMs;
      const n = Number(cfg.timeoutMs);
      if (!isFinite(n) || n <= 0) return (prev && prev.timeoutMs) || timeoutMs;
      return Math.max(1000, Math.min(600000, Math.round(n)));
    }
    function redactEnv(env) {
      const out = {};
      const keys = Object.keys(env || {}).sort();
      for (const k of keys) out[k] = /TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|BEARER|CREDENTIAL|COOKIE/i.test(k) ? '<redacted>' : '<set>';
      return out;
    }

    function setState(c, state, detail) {
      c.state = state; c.detail = detail || ''; c.ts = clock.now();
      try { onEvent({ type: 'connector.state', connectorId: c.id, state: state, detail: c.detail, toolCount: (c.tools || []).length }); } catch (e) {}
    }
    function closeResources(client, transport, reason) {
      if (client) { try { client.close(reason || 'reconfigured'); } catch (_) {} }
      else if (transport && typeof transport.close === 'function') { try { transport.close(); } catch (_) {} }
    }
    function teardown(c) {
      if (c && c.reconnectTimer != null) { try { clearTimeoutImpl(c.reconnectTimer); } catch (_) {} c.reconnectTimer = null; }
      if (c && c.connecting) { closeResources(c.connecting.client, c.connecting.transport, 'superseded'); c.connecting = null; }
      if (c && c.client) closeResources(c.client, c.transport, 'reconfigured');
      if (c) { c.client = null; c.transport = null; }
    }

    // the connector's ID for THIS live connection — bumped on every (re)connect so a death callback from an OLD
    // transport (a torn-down connection) is ignored (it can't flip a freshly-reconnected connector back to error).
    function bumpEpoch(c) { c._epoch = (c._epoch || 0) + 1; return c._epoch; }

    // TRANSPORT DEATH: the stdio child exited / the HTTP endpoint keeps failing. The transport calls this via its
    // onError hook. Flip the connector to 'error' (honest status — the UI was previously stuck on 'up' forever)
    // and, if reconnect is wired + within the attempt cap, schedule a bounded-backoff reconnect. Guarded by epoch
    // so a stale callback from a superseded transport does nothing.
    function onTransportDeath(c, epoch, reason) {
      if (!conns.get(c.id) || c._epoch !== epoch) return;      // stale connection or removed connector -> ignore
      if (c.state === 'error' && c.reconnectTimer != null) return;   // already handling this death
      c.tools = [];
      // keep c.transport reference so teardown can close the client; mark not-up.
      setState(c, 'error', reason || 'connector transport closed');
      scheduleReconnect(c);
    }

    function reconnectDelay(c) {
      const attempt = c.reconnectAttempt || 0;
      const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt));
      c.reconnectAttempt = attempt + 1;
      return Math.floor(exp * (0.5 + 0.5 * random()));         // jitter in [0.5x, 1x]
    }

    function scheduleReconnect(c) {
      if (!setTimeoutImpl) return;                              // reconnect not wired -> honest error state only
      if (!c.enabled) return;                                   // a disabled connector never auto-reconnects
      if (c.reconnectTimer != null) return;                     // already scheduled
      if ((c.reconnectAttempt || 0) >= RECONNECT_MAX_ATTEMPTS) { setState(c, 'error', (c.detail || 'connector down') + ' (giving up after ' + RECONNECT_MAX_ATTEMPTS + ' reconnect attempts)'); return; }
      const delay = reconnectDelay(c);
      c.reconnectTimer = setTimeoutImpl(function () {
        c.reconnectTimer = null;
        if (!conns.get(c.id) || !c.enabled) return;
        connect(c).catch(() => {});                             // connect() re-arms scheduleReconnect on failure
      }, delay);
    }

    async function connect(c) {
      if (c.reconnectTimer != null) { try { clearTimeoutImpl(c.reconnectTimer); } catch (_) {} c.reconnectTimer = null; }
      if (c.connecting) { closeResources(c.connecting.client, c.connecting.transport, 'superseded'); c.connecting = null; }
      if (c.client) { closeResources(c.client, c.transport, 'reconnect'); c.client = null; c.transport = null; }
      const epoch = bumpEpoch(c);
      const isCurrent = () => conns.get(c.id) === c && c._epoch === epoch;
      const attempt = { epoch: epoch, transport: null, client: null };
      c.connecting = attempt;
      setState(c, 'connecting');
      try {
        const connTimeout = c.timeoutMs || timeoutMs;
        // oauth connectors carry a tokenProvider() rather than a frozen token, so EVERY (re)connect — the initial
        // connect, a manual Reload, and bounded auto-reconnect — fetches a FRESH bearer (refreshing if near expiry).
        // A provider throw falls back to the static token; an empty result connects tokenless so an expired/signed-out
        // connector surfaces an HONEST 401/error (visible + reloadable), never a crash or a silently-frozen stale token.
        let liveToken = c.token;
        if (typeof c.tokenProvider === 'function') { try { const t = await c.tokenProvider(); if (t != null) liveToken = String(t); } catch (_) {} }
        if (!isCurrent()) return { ok: false, state: 'down', toolCount: 0, superseded: true };
        attempt.transport = makeTransport({
          transport: c.transportKind,
          url: c.url,
          token: liveToken,
          headers: c.headers,
          command: c.command,
          args: c.args,
          cwd: c.cwd,
          env: c.env,
          timeoutMs: connTimeout,
          // DEATH HOOK: the transport reports child-exit / repeated failure here. Bound to THIS epoch so a stale
          // callback from a torn-down transport can't flip a reconnected connector back to error.
          onError: (e) => {
            try { if (isCurrent() && c.client === attempt.client) onTransportDeath(c, epoch, (e && e.message) || String(e)); } catch (_) {}
          }
        });
        attempt.client = makeClient({ transport: attempt.transport, timeoutMs: connTimeout });
        await attempt.client.initialize();
        /* TOOLS ARE NOT MANDATORY. This used to be an unconditional `listTools()`, which meant a server that
           publishes only RESOURCES or only PROMPTS answered "method not found", the throw fell into the catch
           below, and the connector died in an `error` state. A perfectly healthy document server looked
           broken — the precise symptom this whole lane exists to fix, hidden one line above the fix.
           The rule is capability-driven, with one deliberate legacy allowance: a server that declared NOTHING
           at all is still probed for tools (older servers under-report), and a probe failure there costs zero
           tools rather than the connector. A server that DID declare capabilities is taken at its word. */
        const declared = attempt.client.serverCapabilities || {};
        const declaredAnything = !!Object.keys(declared).length;
        let tools = [];
        if (!declaredAnything) {
          try { tools = await attempt.client.listTools() || []; }
          catch (_) { tools = []; }
        } else if (typeof attempt.client.supports === 'function' && attempt.client.supports('tools')) {
          tools = await attempt.client.listTools() || [];
        } else {
          tools = [];
        }
        /* RESOURCES + PROMPTS. Cached on connect exactly like tools, and asked for ONLY when the server's own
           initialize response declared the capability — probing a server that never claimed `resources` earns
           a protocol error, not an empty list, and that error is indistinguishable from a broken connector.
           A LIST FAILURE IS NOT A CONNECT FAILURE: a server whose tools work but whose resources/list throws
           must still come up `up` with its tools usable. Losing the whole connector over a secondary
           primitive would be a worse outcome than the one this feature exists to fix. */
        let resources = [];
        let prompts = [];
        if (typeof attempt.client.supports === 'function' && attempt.client.supports('resources')) {
          try {
            const [res, tpl] = [await attempt.client.listResources() || [], await attempt.client.listResourceTemplates() || []];
            resources = res.concat(tpl.map(t => Object.assign({}, t, { isTemplate: true })));
          } catch (e) { if (isCurrent()) try { onEvent({ type: 'connector.partial', connectorId: c.id, what: 'resources', detail: (e && e.message) || String(e) }); } catch (_) {} }
        }
        if (typeof attempt.client.supports === 'function' && attempt.client.supports('prompts')) {
          try { prompts = await attempt.client.listPrompts() || []; }
          catch (e) { if (isCurrent()) try { onEvent({ type: 'connector.partial', connectorId: c.id, what: 'prompts', detail: (e && e.message) || String(e) }); } catch (_) {} }
        }
        if (!isCurrent()) {
          closeResources(attempt.client, attempt.transport, 'superseded');
          return { ok: false, state: 'down', toolCount: 0, superseded: true };
        }
        c.connecting = null;
        c.transport = attempt.transport;
        c.client = attempt.client;
        c.tools = tools;
        c.resources = resources;
        c.prompts = prompts;
        c.reconnectAttempt = 0;                                 // a clean connect resets the backoff ladder
        setState(c, 'up');
        return { ok: true, state: 'up', toolCount: tools.length, resourceCount: resources.length, promptCount: prompts.length };
      } catch (e) {
        closeResources(attempt.client, attempt.transport, 'connect failed');
        if (!isCurrent()) return { ok: false, state: 'down', toolCount: 0, superseded: true };
        if (c.connecting === attempt) c.connecting = null;
        c.tools = []; c.resources = []; c.prompts = [];
        setState(c, 'error', (e && e.message) || String(e));
        scheduleReconnect(c);                                   // a failed (re)connect backs off and retries (bounded)
        return { ok: false, state: 'error', toolCount: 0, error: c.detail };
      }
    }

    async function configure(id, cfg) {
      id = String(id || '').trim();
      if (!id) throw new Error('configure: connector id is required');
      cfg = cfg || {};
      const prev = conns.get(id);
      if (prev) teardown(prev);
      const transportKind = normalizeTransport(cfg, prev);
      const c = {
        id: id,
        transportKind: transportKind,
        url: String(cfg.url || (prev && prev.url) || ''),
        token: ('token' in cfg) ? (cfg.token || '') : (prev ? prev.token : ''),
        command: String(cfg.command || (prev && prev.command) || ''),
        args: normalizeArgs(cfg, prev),
        cwd: String(cfg.cwd || (prev && prev.cwd) || ''),
        env: normalizeEnv(cfg, prev),
        headers: normalizeHeaders(cfg, prev),
        timeoutMs: normalizeTimeout(cfg, prev),
        label: String(cfg.label || (prev && prev.label) || id),
        enabled: cfg.enabled !== false,
        // oauth connectors pass a tokenProvider() instead of a frozen token (see connect); carried across reconfigure
        // so a benign toggle/re-warm keeps refreshing the bearer.
        tokenProvider: (typeof cfg.tokenProvider === 'function') ? cfg.tokenProvider : (prev ? prev.tokenProvider : null),
        state: 'down', detail: '', tools: [], client: null, transport: null, connecting: null, ts: clock.now(),
        reconnectAttempt: 0, reconnectTimer: null, _epoch: 0
      };
      conns.set(id, c);
      if (transportKind === 'http' && !c.url) { setState(c, 'error', 'no server URL configured'); return { ok: false, state: 'error', toolCount: 0, error: c.detail }; }
      if (transportKind === 'stdio' && !c.command) { setState(c, 'error', 'no stdio command configured'); return { ok: false, state: 'error', toolCount: 0, error: c.detail }; }
      if (!c.enabled) { setState(c, 'down'); return { ok: true, state: 'down', toolCount: 0 }; }
      return connect(c);
    }

    function refresh(id) {
      const c = conns.get(String(id));
      if (!c) return Promise.resolve({ ok: false, state: 'down', toolCount: 0, error: 'unknown connector' });
      if (!c.enabled || (c.transportKind === 'http' && !c.url) || (c.transportKind === 'stdio' && !c.command)) return Promise.resolve({ ok: false, state: c.state, toolCount: 0 });
      return connect(c);
    }

    function remove(id) {
      const c = conns.get(String(id));
      if (c) { teardown(c); conns.delete(c.id); try { onEvent({ type: 'connector.removed', connectorId: c.id }); } catch (e) {} }
      return Promise.resolve({ ok: true });
    }

    // a summary safe to log / return over HTTP: the token is NEVER included (only whether one is set).
    function summary(c) {
      const out = {
        id: c.id,
        label: c.label,
        transport: c.transportKind,
        enabled: c.enabled,
        state: c.state,
        detail: c.detail,
        hasToken: !!(c.token || c.tokenProvider),
        oauth: !!c.tokenProvider,                        // the panel renders oauth connectors distinctly (re-auth via sign-in, not an http edit)
        timeoutMs: c.timeoutMs || timeoutMs,
        toolCount: (c.tools || []).length,
        // Surfaced so the connector panel can say what a server ACTUALLY offers. A server with 0 tools and 40
        // resources used to render as an empty connector, which reads as broken rather than as "this one
        // serves documents, not actions".
        resourceCount: (c.resources || []).length,
        promptCount: (c.prompts || []).length,
        tools: (c.tools || []).map(t => t.name)
      };
      if (c.transportKind === 'stdio') {
        out.command = c.command;
        out.args = (c.args || []).slice();
        out.cwd = c.cwd || '';
        out.env = redactEnv(c.env);
        out.hasEnv = Object.keys(c.env || {}).length > 0;
      } else {
        out.url = c.url;
        out.headers = redactEnv(c.headers);            // header VALUES are never echoed — key + set/redacted only
        out.hasHeaders = Object.keys(c.headers || {}).length > 0;
      }
      return out;
    }
    function status(id) { const c = conns.get(String(id)); return c ? summary(c) : null; }
    function list() { const out = []; for (const c of conns.values()) out.push(summary(c)); return out; }
    function has(id) { return conns.has(String(id)); }
    function ids() { return Array.from(conns.keys()); }

    // consecutive call failures that flip an HTTP connector to 'error' (its transport reports per-call failures as
    // JSON-RPC errors, not transport death, so a vanished HTTP endpoint would otherwise stay 'up' forever). stdio
    // gets death detection from the child-exit hook, so this net is only meaningful for http; 0 disables it.
    const CALL_FAIL_LIMIT = Math.max(0, deps.callFailLimit == null ? 3 : Number(deps.callFailLimit));
    function call(id, toolName, args) {
      const c = conns.get(String(id));
      if (!c || !c.client || c.state !== 'up') return Promise.reject(new Error('connector "' + id + '" is not connected'));
      const p = c.client.callTool(toolName, args || {});
      if (c.transportKind !== 'http' || CALL_FAIL_LIMIT <= 0) return p;
      return p.then(
        (r) => { c._callFails = 0; return r; },
        (e) => {
          c._callFails = (c._callFails || 0) + 1;
          if (c._callFails >= CALL_FAIL_LIMIT && c.state === 'up') { onTransportDeath(c, c._epoch, 'connector unreachable (' + c._callFails + ' consecutive call failures)'); }
          throw e;
        }
      );
    }

    function toolDefsFor(id) {
      const c = conns.get(String(id));
      if (!c || c.state !== 'up' || !c.client) return [];
      const bound = (toolName, args) => call(c.id, toolName, args);
      const defs = (c.tools || []).map(t => makeToolDef({ connectorId: c.id, label: c.label, mcpTool: t, call: bound, localProcess: c.transportKind === 'stdio' }));
      /* The resources/prompts tools are projected ONLY for a server that actually publishes them, so a
         tools-only connector's catalogue is byte-identical to before — nobody pays schema bytes for a
         primitive their server does not serve. They ride the same projection as tools, which is why they
         need no new registration site: index.js already registers whatever this returns, unions the names
         into the resolved grant set, and marks them network + consent-gated. */
      if (makeAuxDefs) {
        for (const d of makeAuxDefs({
          connectorId: c.id, label: c.label,
          listResources: (c.resources || []).length ? (() => Promise.resolve(c.resources)) : null,
          readResource: (c.resources || []).length ? ((uri) => c.client.readResource(uri)) : null,
          listPrompts: (c.prompts || []).length ? (() => Promise.resolve(c.prompts)) : null,
          getPrompt: (c.prompts || []).length ? ((n, a) => c.client.getPrompt(n, a)) : null
        })) defs.push(d);
      }
      return defs;
    }

    // PER-AGENT projection: given the objects placed in ONE agent's room, return the tool defs for every
    // connector object found there, de-duplicated by wire name (two portals to the same connector collapse).
    function toolDefsForObjects(objects) {
      const out = [], seen = {};
      for (const obj of (objects || [])) {
        const cid = connectorIdOf(obj);
        if (!cid || !conns.has(cid)) continue;
        for (const def of toolDefsFor(cid)) { if (seen[def.name]) continue; seen[def.name] = true; out.push(def); }
      }
      return out;
    }

    async function close() {
      for (const c of conns.values()) teardown(c);
      conns.clear();
    }

    /* The RESOURCES + PROMPTS read path. Served from the connect-time cache for lists (so a listing costs no
       round trip and cannot hang a turn) and live for the two fetches, because a resource's CONTENT is the
       thing that changes between reads — caching that would hand the agent a stale document and call it
       current. An unknown/down connector is an honest error, never an empty list that reads as "nothing here". */
    const upConn = (id) => {
      const c = conns.get(String(id));
      if (!c) throw new Error('unknown connector: ' + id);
      if (!c.client || c.state !== 'up') throw new Error('connector ' + c.id + ' is ' + (c.state || 'down') + (c.detail ? ' (' + c.detail + ')' : ''));
      return c;
    };
    const resourcesFor = (id) => (conns.get(String(id)) || {}).resources || [];
    const promptsFor = (id) => (conns.get(String(id)) || {}).prompts || [];
    const readResource = (id, uri) => upConn(id).client.readResource(uri);
    const getPrompt = (id, name, args) => upConn(id).client.getPrompt(name, args);

    return { configure, remove, refresh, close, status, list, has, ids, toolDefsFor, toolDefsForObjects, call, resourcesFor, promptsFor, readResource, getPrompt, _internals: { connectorIdOf } };
  }

  return { makeConnectorManager, _internals: { connectorIdOf } };
});
