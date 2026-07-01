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

function makeSseHub() {
  const clients = new Set();

  // SSE wire frame: one event per `data:` line, terminated by a blank line.
  function format(name, payload) { return 'data: ' + JSON.stringify({ name, payload }) + '\n\n'; }

  function add(res) { clients.add(res); return () => clients.delete(res); }
  function remove(res) { return clients.delete(res); }
  function size() { return clients.size; }

  // returns how many clients the event actually reached (dead clients are dropped, not counted).
  function broadcast(name, payload) {
    if (!clients.size) return 0;
    const line = format(name, payload);
    let n = 0;
    for (const res of clients) {
      try { res.write(line); n++; }
      catch (_) { clients.delete(res); }   // socket gone → evict so we never grow unbounded
    }
    return n;
  }

  return { add, remove, size, broadcast, format };
}

module.exports = { makeSseHub, runTeeView };
