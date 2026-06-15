/* sidecar/channels/sse.js — a tiny Server-Sent-Events fan-out.

   The sidecar already validates + redacts every channel.* / workitem.* / queue.* event before it
   reaches chanBus.emit; this hub forwards each of those to every open browser EventSource so the
   live station world can animate them (a box riding the belt, a queue-depth gauge). It is the
   browser-facing half of the bridge the index.js comment reserved.

   Pure + testable: a "client" is any object with a .write(string) method (an http ServerResponse
   duck-types it). No node:http dependency, no ambient I/O — so test/channels.sse.test.js drives it
   with a fake res. A client whose write() throws (dead socket) is evicted on the next broadcast. */
'use strict';

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

module.exports = { makeSseHub };
