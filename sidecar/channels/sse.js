/* sidecar/channels/sse.js — a tiny Server-Sent-Events fan-out.

   The sidecar already validates + redacts every channel.* / workitem.* / queue.* event before it
   reaches chanBus.emit; this hub forwards each of those to every open browser EventSource so the
   live station world can animate them (a box riding the belt, a queue-depth gauge). It is the
   browser-facing half of the bridge the index.js comment reserved.

   Pure + testable: a "client" is any object with a .write(string) method (an http ServerResponse
   duck-types it). No node:http dependency, no ambient I/O — so test/channels.sse.test.js drives it
   with a fake res. A client whose write() throws (dead socket) is evicted on the next broadcast. */
'use strict';

/* G2.1 — the server-initiated-run egress policy: which runOnce lifecycle events a broadcast-opted
   run may tee onto the SSE bus, and in what SHAPE. Pure (no IO/clock) so the redaction contract is
   unit-testable. Returns the payload VIEW to broadcast, or null for "never teed".
     • agent.run.start / agent.cost / agent.run.end — teed whole (the floor's run lifecycle).
     • agent.tool_call — teed NAME-ONLY: { agentId, runId, callId, name }. args/argsSummary are
       stripped STRUCTURALLY (never copied), so a routed run's tool arguments — which can carry user
       text, file paths, or fetched content — never leave the sidecar on this path (the B4
       redacted-egress rule). The four kept fields satisfy the frozen agent.tool_call schema, so
       every existing consumer (connector-portal pulse, G0 per-tool prop pulse, desk heat,
       delegation window) still fires for autonomous/cron runs.
     • agent.token (and everything else) — null. The token stream stays off the SSE bus by design
       (that noise decision stands; desk heat for UNWATCHED runs rides tool_call instead). */
function runTeeView(name, payload) {
  const p = payload || {};
  if (name === 'agent.run.start' || name === 'agent.cost' || name === 'agent.run.end') return p;
  if (name === 'agent.tool_call') {
    return {
      agentId: String(p.agentId == null ? '' : p.agentId),
      runId: String(p.runId == null ? '' : p.runId),
      callId: String(p.callId == null ? '' : p.callId),
      name: String(p.name == null ? '' : p.name)
    };
  }
  return null;
}

// Backpressure ceiling: a ZOMBIE client (still connected at TCP but not reading — a suspended laptop, a wedged
// tab) makes res.write() return false and the kernel/Node buffer the frame in process memory. Left alone that
// buffer grows without bound for the life of the (never-closing) socket — a slow memory leak the throw-based
// dead-socket eviction never catches (write() doesn't throw, it just returns false). So once a client's buffered
// bytes cross this ceiling, we treat it as gone and evict it. 4MB is ~thousands of queued HUD frames — a healthy
// reader drains far below it; only a truly stuck socket ever gets here.
const SSE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function makeSseHub() {
  const clients = new Set();

  // SSE wire frame: one event per `data:` line, terminated by a blank line.
  function format(name, payload) { return 'data: ' + JSON.stringify({ name, payload }) + '\n\n'; }

  function add(res) { clients.add(res); return () => clients.delete(res); }
  function remove(res) { return clients.delete(res); }
  function size() { return clients.size; }

  // Hard-evict a backpressured/dead client: drop it from the set, then best-effort end+destroy the socket so the
  // buffered bytes are released (a plain delete would leave Node still holding the write buffer alive).
  function evict(res) {
    clients.delete(res);
    try { if (typeof res.end === 'function') res.end(); } catch (_) {}
    try { if (typeof res.destroy === 'function') res.destroy(); } catch (_) {}
  }

  // returns how many clients the event actually reached (dead/backpressured clients are dropped, not counted).
  function broadcast(name, payload) {
    if (!clients.size) return 0;
    const line = format(name, payload);
    let n = 0;
    for (const res of clients) {
      let ok;
      try { ok = res.write(line); n++; }
      catch (_) { evict(res); continue; }   // socket gone (write threw) → evict so we never grow unbounded
      // write() returned false → the client isn't draining. Tolerate transient backpressure, but once the
      // buffered bytes cross the ceiling the client is a zombie: evict it (and don't count it as reached).
      if (ok === false && Number(res.writableLength) > SSE_MAX_BUFFER_BYTES) { evict(res); n--; }
    }
    return n;
  }

  return { add, remove, size, broadcast, format, _internals: { SSE_MAX_BUFFER_BYTES } };
}

module.exports = { makeSseHub, runTeeView };
