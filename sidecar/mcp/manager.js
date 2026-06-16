/* sidecar/mcp/manager.js — the connector MANAGER: the host-side singleton that owns configured MCP
   connectors, keeps a client warm per connector, caches each server's tools/list, and projects those
   tools into registry tool defs on demand. Mirrors the Telegram channel's lifecycle (configure / status /
   remove) so index.js wires it the same way. All I/O arrives injected — makeTransport (the network edge),
   makeClient (the JSON-RPC client), makeToolDef (the translator) — so the manager's logic is unit-testable
   with fakes and stays free of ambient time/randomness (clock injected).

   makeConnectorManager({ makeTransport, makeClient?, makeToolDef?, clock?, timeoutMs?, onEvent? }) -> {
     configure(id, { url, token?, label?, enabled? }) -> Promise<{ ok, state, toolCount, error? }>,
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

    const conns = new Map();   // id -> { id, url, token, label, enabled, state, detail, tools[], client, transport, ts }

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
        c.transport = makeTransport({ url: c.url, token: c.token, timeoutMs: timeoutMs });
        c.client = makeClient({ transport: c.transport, timeoutMs: timeoutMs });
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
      const c = {
        id: id,
        url: String(cfg.url || (prev && prev.url) || ''),
        token: ('token' in cfg) ? (cfg.token || '') : (prev ? prev.token : ''),
        label: String(cfg.label || (prev && prev.label) || id),
        enabled: cfg.enabled !== false,
        state: 'down', detail: '', tools: [], client: null, transport: null, ts: clock.now()
      };
      conns.set(id, c);
      if (!c.url) { setState(c, 'error', 'no server URL configured'); return { ok: false, state: 'error', toolCount: 0, error: c.detail }; }
      if (!c.enabled) { setState(c, 'down'); return { ok: true, state: 'down', toolCount: 0 }; }
      return connect(c);
    }

    function refresh(id) {
      const c = conns.get(String(id));
      if (!c) return Promise.resolve({ ok: false, state: 'down', toolCount: 0, error: 'unknown connector' });
      if (!c.enabled || !c.url) return Promise.resolve({ ok: false, state: c.state, toolCount: 0 });
      return connect(c);
    }

    function remove(id) {
      const c = conns.get(String(id));
      if (c) { teardown(c); conns.delete(c.id); try { onEvent({ type: 'connector.removed', connectorId: c.id }); } catch (e) {} }
      return Promise.resolve({ ok: true });
    }

    // a summary safe to log / return over HTTP: the token is NEVER included (only whether one is set).
    function summary(c) {
      return { id: c.id, label: c.label, url: c.url, enabled: c.enabled, state: c.state, detail: c.detail, hasToken: !!c.token, toolCount: (c.tools || []).length, tools: (c.tools || []).map(t => t.name) };
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
