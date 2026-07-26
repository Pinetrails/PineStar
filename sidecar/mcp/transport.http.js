/* sidecar/mcp/transport.http.js — the MCP "Streamable HTTP" client transport (the I/O edge).
   POSTs one JSON-RPC message per send(); the POST's response carries the reply, either as a single
   application/json body OR a text/event-stream (SSE) of one-or-more messages — both are parsed and
   handed back to the client via onMessage(). A server-assigned `Mcp-Session-Id` (from initialize) is
   captured and echoed on every later request. fetch is injected so the transport is testable headless.

   makeHttpTransport({ url, token?, headers?, fetchImpl?, timeoutMs?, protocolVersion?, onError? }) -> transport
     transport = { send(message)->Promise, onMessage(cb), close(), }

   SECURITY: the Commander configures the server URL deliberately (unlike web_fetch, where the MODEL
   picks the URL), so loopback IS allowed — local MCP servers are common. The one guard: refuse http://
   for a NON-local host, so a bearer token is never sent in cleartext over the network. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.mcp = root.SK.mcp || {}).transportHttp = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const JSONRPC = '2.0';

  /* `/^127\./` was UNANCHORED, so it matched the public hostname `127.0.0.1.evil.com` — and this predicate is
     the module's ONE guard ("refuse http:// for a non-local host, so a bearer token is never sent in
     cleartext"). A connector URL of http://127.0.0.1.evil.com/mcp therefore shipped the Commander's OAuth
     bearer over plaintext HTTP to whoever owns that domain. An IPv4 loopback literal is four numeric octets
     and nothing else; anything with a trailing label is a NAME. Also folds the FQDN root label so
     `localhost.` classifies the same as `localhost`, and recognizes the IPv4-mapped IPv6 form Node renders
     for [::ffff:127.0.0.1]. */
  function isLoopback(host) {
    host = String(host).toLowerCase();
    if (host.charAt(0) === '[') host = host.slice(1, -1);
    else host = host.replace(/\.+$/, '');
    if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true;
    const m = host.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);   // a LITERAL v4, whole-string
    return !!m && Number(m[1]) === 127;
  }

  function assertUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { throw new Error('invalid connector URL: ' + raw); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('connector URL must be http(s): ' + raw);
    let h = u.hostname.toLowerCase();
    if (h.charAt(0) === '[') h = h.slice(1, -1);
    if (u.protocol === 'http:' && !isLoopback(h))
      throw new Error('refusing http:// for a non-local connector (' + h + ') — use https so the auth token is not sent in cleartext');
    return u;
  }

  // parse an SSE body into the JSON-RPC messages carried on its `data:` lines (multiple data: lines in
  // one event are joined; non-JSON keepalive/comment lines are skipped).
  function parseSse(text) {
    const out = [];
    const events = String(text).split(/\r?\n\r?\n/);
    for (const ev of events) {
      const dataLines = [];
      for (const line of ev.split(/\r?\n/)) { const m = line.match(/^data:\s?(.*)$/); if (m) dataLines.push(m[1]); }
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n').trim();
      if (!payload) continue;
      try { out.push(JSON.parse(payload)); } catch (e) { /* keepalive / non-JSON event — skip */ }
    }
    return out;
  }

  function makeHttpTransport(deps) {
    deps = deps || {};
    const u = assertUrl(deps.url);
    const doFetch = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('mcp http transport requires global fetch (Node 18+) or deps.fetchImpl');
    const token = deps.token || '';
    const extraHeaders = deps.headers || {};
    const timeoutMs = deps.timeoutMs || 30000;
    const onError = typeof deps.onError === 'function' ? deps.onError : function () {};
    let onMsg = null, sessionId = deps.sessionId || null, protocolVersion = deps.protocolVersion || null, closed = false;

    function headers() {
      const h = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }, extraHeaders);
      if (token) h['Authorization'] = 'Bearer ' + token;
      if (sessionId) h['Mcp-Session-Id'] = sessionId;
      if (protocolVersion) h['MCP-Protocol-Version'] = protocolVersion;
      return h;
    }
    function withTimeout(fn) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      if (t && typeof t.unref === 'function') t.unref();
      return Promise.resolve(fn(ctrl.signal)).finally(() => clearTimeout(t));
    }
    function deliver(msg) { if (onMsg) { try { onMsg(msg); } catch (e) { onError(e); } } }
    // a transport-level failure on a REQUEST is turned into a JSON-RPC error response so the client's pending
    // promise rejects promptly (instead of hanging until its timeout); for a notification there is no id to fail.
    function failTo(id, message) { if (id != null) deliver({ jsonrpc: JSONRPC, id, error: { code: -32000, message: message } }); else onError(new Error(message)); }

    async function send(message) {
      const id = message && message.id;
      if (closed) return failTo(id, 'connector transport closed');
      if (message && message.method === 'initialize' && protocolVersion == null && message.params && message.params.protocolVersion) {
        protocolVersion = message.params.protocolVersion;   // pin the negotiated version onto later request headers
      }
      let res;
      try { res = await withTimeout(signal => doFetch(u.href, { method: 'POST', headers: headers(), body: JSON.stringify(message), signal })); }
      catch (e) { return failTo(id, 'connector request failed: ' + ((e && e.message) || e)); }

      try { const sid = res.headers && res.headers.get && res.headers.get('mcp-session-id'); if (sid) sessionId = sid; } catch (e) {}

      const status = res.status;
      if (status === 202 || status === 204) return;                         // accepted notification / no body
      if (status < 200 || status >= 300) {
        let detail = ''; try { detail = (await res.text()).slice(0, 200); } catch (e) {}
        return failTo(id, 'connector HTTP ' + status + (detail ? ' — ' + detail : ''));
      }
      const ct = ((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
      let body = ''; try { body = await res.text(); } catch (e) { return failTo(id, 'connector response read failed'); }
      if (/text\/event-stream/.test(ct)) { for (const m of parseSse(body)) deliver(m); }
      else if (!body.trim()) { /* empty body — a notification ack, nothing to route */ }
      else { try { deliver(JSON.parse(body)); } catch (e) { failTo(id, 'connector returned a non-JSON body'); } }
    }

    function onMessage(cb) { onMsg = cb; }
    function close() {
      if (closed) return;
      closed = true;
      if (sessionId) { try { Promise.resolve(doFetch(u.href, { method: 'DELETE', headers: headers() })).catch(() => {}); } catch (e) {} }   // best-effort MCP session teardown
    }

    return { send, onMessage, close };
  }

  return { makeHttpTransport, _internals: { parseSse, assertUrl, isLoopback } };
});
