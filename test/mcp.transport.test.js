/* node test/mcp.transport.test.js — the connector I/O + lifecycle layer:
   (A) the Streamable-HTTP transport over an injected fetch: URL guard, json + SSE responses,
       auth header, session-id capture/echo, error-status -> error response, notification ack.
   (B) the connector manager: configure/connect, tool projection, per-agent toolDefsForObjects,
       token never leaked in summaries, disabled/error states, call routing, remove. */
'use strict';
const A = require('./_assert.js');
const { makeHttpTransport, _internals: T } = require('../sidecar/mcp/transport.http.js');
const { makeConnectorManager } = require('../sidecar/mcp/manager.js');

// a fake fetch: routes(url, init, n) -> { status?, headers?, body? }. Records every call on f.calls.
function makeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const r = routes(url, init, calls.length) || {};
    const hdr = r.headers || {};
    const headers = { get: (k) => { const key = Object.keys(hdr).find(x => x.toLowerCase() === String(k).toLowerCase()); return key ? hdr[key] : null; } };
    return { status: r.status == null ? 200 : r.status, headers, text: async () => (r.body == null ? '' : r.body) };
  };
  f.calls = calls;
  return f;
}
const rpc = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });

(async () => {
  // ===== A. transport =====

  // URL guard
  A.throws(() => T.assertUrl('ftp://x/y'), 'non-http(s) URL refused');
  A.throws(() => T.assertUrl('http://example.com/mcp'), 'http:// to a remote host refused (cleartext token)');
  A.notThrows(() => T.assertUrl('http://localhost:3000/mcp'), 'http:// to localhost allowed (local MCP server)');
  A.notThrows(() => T.assertUrl('https://example.com/mcp'), 'https:// remote allowed');

  // SSE parsing
  {
    const msgs = T.parseSse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n: keepalive\n\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\n');
    A.eq(msgs.length, 2, 'parseSse extracts both JSON messages, skips the keepalive');
    A.eq(msgs[0].result.ok, true, 'parseSse parsed the response');
    A.eq(msgs[1].method, 'notifications/x', 'parseSse parsed the notification');
  }

  // json response + auth header + session capture/echo
  {
    const f = makeFetch((url, init, n) => {
      if (n === 1) return { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }, body: rpc(1, { serverInfo: { name: 's' } }) };
      return { headers: { 'content-type': 'application/json' }, body: rpc(2, { tools: [] }) };
    });
    const tp = makeHttpTransport({ url: 'https://srv.example/mcp', token: 'secrettok', fetchImpl: f });
    const got = [];
    tp.onMessage(m => got.push(m));
    await tp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    A.eq(got.length, 1, 'json response delivered one message');
    A.eq(got[0].result.serverInfo.name, 's', 'response routed back by onMessage');
    A.eq(f.calls[0].init.headers['Authorization'], 'Bearer secrettok', 'bearer auth header sent');
    A.ok(/application\/json/.test(f.calls[0].init.headers['Accept']) && /text\/event-stream/.test(f.calls[0].init.headers['Accept']), 'Accept advertises json + sse');
    await tp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    A.eq(f.calls[1].init.headers['Mcp-Session-Id'], 'sess-1', 'captured session id echoed on the next request');
  }

  // SSE response
  {
    const f = makeFetch(() => ({ headers: { 'content-type': 'text/event-stream' }, body: 'data: ' + rpc(5, { tools: [{ name: 'a' }] }) + '\n\n' }));
    const tp = makeHttpTransport({ url: 'https://srv.example/mcp', fetchImpl: f });
    const got = []; tp.onMessage(m => got.push(m));
    await tp.send({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    A.eq(got[0].result.tools[0].name, 'a', 'SSE response routed back by onMessage');
  }

  // error status -> a JSON-RPC error response synthesized against the request id (no hang)
  {
    const f = makeFetch(() => ({ status: 401, body: 'unauthorized' }));
    const tp = makeHttpTransport({ url: 'https://srv.example/mcp', fetchImpl: f });
    const got = []; tp.onMessage(m => got.push(m));
    await tp.send({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
    A.eq(got[0].id, 7, 'error response carries the request id');
    A.ok(/HTTP 401/.test(got[0].error.message), 'HTTP status surfaced as a JSON-RPC error');
  }

  // a notification (no id) acked with 202 delivers nothing
  {
    const f = makeFetch(() => ({ status: 202 }));
    const tp = makeHttpTransport({ url: 'https://srv.example/mcp', fetchImpl: f });
    const got = []; tp.onMessage(m => got.push(m));
    await tp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    A.eq(got.length, 0, 'a 202-acked notification routes no message');
  }

  // ===== B. manager =====

  // a fake JSON-RPC client keyed by the transport url, so each connector gets its own scripted behavior
  const specByUrl = {
    'https://gh/mcp': { tools: [
      { name: 'create_issue', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } },
      { name: 'list_issues', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }
    ] },
    'https://bad/mcp': { failInit: 'handshake refused' }
  };
  function fakeClient(spec) {
    let closed = false;
    return {
      initialize: async () => { if (spec.failInit) throw new Error(spec.failInit); return { serverInfo: { name: 'fake' } }; },
      listTools: async () => spec.tools || [],
      callTool: async (name, args) => (spec.callImpl ? spec.callImpl(name, args) : { content: [{ type: 'text', text: 'ran ' + name + ' ' + JSON.stringify(args) }] }),
      close: () => { closed = true; }, isClosed: () => closed
    };
  }
  const makeTransport = ({ url, token }) => ({ url, token, send() {}, onMessage() {}, close() {} });
  const makeClient = ({ transport }) => fakeClient(specByUrl[transport.url] || { tools: [] });
  const events = [];
  const mgr = makeConnectorManager({ makeTransport, makeClient, onEvent: e => events.push(e) });

  // configure + connect
  {
    const r = await mgr.configure('gh', { url: 'https://gh/mcp', token: 'ghtok', label: 'GitHub' });
    A.eq(r.ok, true, 'configure connected'); A.eq(r.state, 'up', 'state up'); A.eq(r.toolCount, 2, 'two tools discovered');
    A.ok(events.some(e => e.type === 'connector.state' && e.state === 'up'), 'an up state event fired');
  }

  // summaries never leak the token
  {
    const s = mgr.status('gh');
    A.eq(s.hasToken, true, 'status reports a token is set');
    A.eq('token' in s, false, 'status NEVER includes the token value');
    A.eq(s.tools.length, 2, 'status lists tool names');
    A.eq(mgr.list().length, 1, 'list returns the one connector');
  }

  // tool projection + call routing
  {
    const defs = mgr.toolDefsFor('gh');
    A.eq(defs.map(d => d.name).sort(), ['mcp__gh__create_issue', 'mcp__gh__list_issues'], 'projected tool defs are namespaced');
    const create = defs.find(d => d.name === 'mcp__gh__create_issue');
    A.eq(create.requiresConsent, true, 'mutating connector tool requires consent');
    A.eq(defs.find(d => d.name === 'mcp__gh__list_issues').requiresConsent, false, 'readOnly connector tool needs no consent');
    const out = await create.run({ title: 'hi' }, {});
    A.ok(out.content.indexOf('ran create_issue') >= 0, 'tool run routed through the manager to the client');
    const called = await mgr.call('gh', 'create_issue', { title: 'x' });
    A.ok(called.content[0].text.indexOf('create_issue') >= 0, 'manager.call reaches the warm client');
  }

  // PER-AGENT projection: only connector objects in THIS room yield tools; dupes collapse; non-connector rooms get none
  {
    const roomA = [{ objectType: 'computer' }, { objectType: 'connector', connectorId: 'gh' }, { objectType: 'connector', binding: { connectorId: 'gh' } }];
    const defsA = mgr.toolDefsForObjects(roomA);
    A.eq(defsA.length, 2, 'two connector portals to the same server collapse to its 2 tools');
    const roomB = [{ objectType: 'computer' }, { objectType: 'dish' }];
    A.eq(mgr.toolDefsForObjects(roomB).length, 0, 'an agent with no connector object gets no MCP tools (per-agent isolation)');
    A.eq(mgr.toolDefsForObjects([{ objectType: 'connector', connectorId: 'nope' }]).length, 0, 'an object pointing at an unconfigured connector yields nothing');
  }

  // disabled + error states
  {
    const d = await mgr.configure('off', { url: 'https://gh/mcp', enabled: false });
    A.eq(d.state, 'down', 'a disabled connector stays down'); A.eq(mgr.toolDefsFor('off').length, 0, 'a down connector projects no tools');
    const e = await mgr.configure('bad', { url: 'https://bad/mcp' });
    A.eq(e.ok, false, 'a failed handshake reports not-ok'); A.eq(e.state, 'error', 'state error');
    A.ok(/handshake refused/.test(e.error), 'the handshake error is surfaced'); A.eq(mgr.toolDefsFor('bad').length, 0, 'an errored connector projects no tools');
  }

  // remove
  {
    await mgr.remove('gh');
    A.eq(mgr.has('gh'), false, 'removed connector is gone');
    A.eq(mgr.toolDefsForObjects([{ objectType: 'connector', connectorId: 'gh' }]).length, 0, 'removing a connector revokes its tools immediately');
  }

  A.report('mcp.transport.test');
})();
