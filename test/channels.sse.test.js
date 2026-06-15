/* test/channels.sse.test.js — the SSE fan-out that forwards channel/work-item telemetry to the
   live station HUD. Pure + headless: a "client" is any object with .write(string); we drive it
   with a fake res (no node:http, no socket). Guards the two things that matter — every client gets
   each event, and disconnected/dead clients are removed so the Set never leaks. */
'use strict';
const A = require('./_assert.js');
const { makeSseHub } = require('../sidecar/channels/sse.js');

const hub = makeSseHub();
A.eq(hub.size(), 0, 'a fresh hub has no clients');
A.eq(hub.broadcast('queue.status', { depth: 1 }), 0, 'broadcasting to nobody reaches 0 clients');

// one registered client receives an SSE-framed event carrying the name + payload
const a = []; const ca = { write: s => a.push(s) };
const offA = hub.add(ca);
A.eq(hub.size(), 1, 'add() registers a client');
const reached = hub.broadcast('workitem.placed', { workitemId: 'W1', queueId: 'tg_42' });
A.eq(reached, 1, 'broadcast reaches the one open client');
A.eq(a.length, 1, 'the client got exactly one frame');
A.ok(a[0].startsWith('data: ') && a[0].endsWith('\n\n'), 'the frame is SSE-shaped (data: ... blank line)');
const decoded = JSON.parse(a[0].slice(6, -2));
A.ok(decoded.name === 'workitem.placed' && decoded.payload.workitemId === 'W1', 'the frame carries the event name + payload');

// fan-out: a second client also receives subsequent events
const b = []; hub.add({ write: s => b.push(s) });
hub.broadcast('queue.status', { queueId: 'tg_42', depth: 2 });
A.eq(a.length, 2, 'the first client received the second event too');
A.eq(b.length, 1, 'the second client received the second event');

// the unsubscribe returned by add() removes exactly that client (no leak)
offA();
A.eq(hub.size(), 1, 'the unsubscribe handle removes its client');
hub.broadcast('queue.status', { depth: 3 });
A.eq(a.length, 2, 'the removed client receives nothing further');

// a dead client (write throws, e.g. closed socket) is evicted on the next broadcast
hub.add({ write: () => { throw new Error('EPIPE'); } });
A.eq(hub.size(), 2, 'the throwing client is registered before the broadcast');
hub.broadcast('queue.status', { depth: 4 });
A.eq(hub.size(), 1, 'a client whose write() throws is evicted (the Set never grows unbounded)');

A.report('channels.sse');
