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
    const clock = deps.clock || { now: () => 0 };
    const timeoutMs = deps.timeoutMs || 30000;
    const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : function () {};

    const conns = new Map();   // id -> { id, transportKind, url, token, command, args, cwd, env, label, enabled, state, detail, tools[], client, transport, ts }

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
    function teardown(c) {
      if (c && c.client) { try { c.client.close('reconfigured'); } catch (e) {} }
      if (c) { c.client = null; c.transport = null; }
    }

    async function connect(c) {
      setState(c, 'connecting');
      try {
        const connTimeout = c.timeoutMs || timeoutMs;
        c.transport = makeTransport({
          transport: c.transportKind,
          url: c.url,
          token: c.token,
          headers: c.headers,
          command: c.command,
          args: c.args,
          cwd: c.cwd,
          env: c.env,
          timeoutMs: connTimeout
        });
        c.client = makeClient({ transport: c.transport, timeoutMs: connTimeout });
        await c.client.initialize();
        c.tools = await c.client.listTools() || [];
        setState(c, 'up');
        return { ok: true, state: 'up', toolCount: c.tools.length };
      } catch (e) {
        c.tools = [];
        teardown(c);
        setState(c, 'error', (e && e.message) || String(e));
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
        state: 'down', detail: '', tools: [], client: null, transport: null, ts: clock.now()
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
        hasToken: !!c.token,
        timeoutMs: c.timeoutMs || timeoutMs,
        toolCount: (c.tools || []).length,
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

    function call(id, toolName, args) {
      const c = conns.get(String(id));
      if (!c || !c.client || c.state !== 'up') return Promise.reject(new Error('connector "' + id + '" is not connected'));
      return c.client.callTool(toolName, args || {});
    }

    function toolDefsFor(id) {
      const c = conns.get(String(id));
      if (!c || c.state !== 'up' || !c.client) return [];
      const bound = (toolName, args) => call(c.id, toolName, args);
      return (c.tools || []).map(t => makeToolDef({ connectorId: c.id, label: c.label, mcpTool: t, call: bound }));
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

    return { configure, remove, refresh, close, status, list, has, ids, toolDefsFor, toolDefsForObjects, call, _internals: { connectorIdOf } };
  }

  return { makeConnectorManager, _internals: { connectorIdOf } };
});
