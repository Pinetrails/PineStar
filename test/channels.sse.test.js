/* test/channels.sse.test.js — the SSE fan-out that forwards channel/work-item telemetry to the
   live station HUD. Pure + headless: a "client" is any object with .write(string); we drive it
   with a fake res (no node:http, no socket). Guards the two things that matter — every client gets
   each event, and disconnected/dead clients are removed so the Set never leaks.
   ALSO (G2.1): the runTeeView egress policy for broadcast-opted server-initiated runs — every
   agent.tool_call tees NAME-ONLY (args stripped structurally), agent.token never tees. */
'use strict';
const A = require('./_assert.js');
const { makeSseHub, runTeeView } = require('../sidecar/channels/sse.js');

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

// a BACKPRESSURED client (write() returns false) is tolerated while its buffer is small, but evicted once the
// buffered bytes cross the ceiling — the zombie-socket memory-leak guard. write() never throws here (that's the
// separate dead-socket path above); it just returns false, so only the writableLength ceiling catches it.
{
  const hub2 = makeSseHub();
  const CEIL = hub2._internals.SSE_MAX_BUFFER_BYTES;

  // under the ceiling: kept (a healthy-ish reader that's momentarily behind is not evicted)
  let slowWrites = 0;
  const slow = { write: () => { slowWrites++; return false; }, writableLength: 1024, end: () => {}, destroy: () => {} };
  hub2.add(slow);
  const reachedSlow = hub2.broadcast('queue.status', { depth: 1 });
  A.eq(hub2.size(), 1, 'a backpressured-but-under-ceiling client is NOT evicted');
  A.eq(reachedSlow, 1, 'it still counts as reached while under the ceiling');
  A.eq(slowWrites, 1, 'the frame was written to it');

  // over the ceiling: evicted + end/destroy called so the buffer is released
  let ended = false, destroyed = false;
  const zombie = { write: () => false, writableLength: CEIL + 1, end: () => { ended = true; }, destroy: () => { destroyed = true; } };
  hub2.add(zombie);
  A.eq(hub2.size(), 2, 'the zombie is registered before the broadcast');
  const reached = hub2.broadcast('queue.status', { depth: 2 });
  A.eq(hub2.size(), 1, 'a client buffering past the ceiling is evicted');
  A.eq(reached, 1, 'the evicted zombie is NOT counted as reached (only the slow client)');
  A.ok(ended && destroyed, 'the evicted client is end()ed and destroy()ed so its write buffer is released');
}

/* ---------- G2.1: the server-initiated-run tee policy (runTeeView) ---------- */
// run lifecycle passes through whole
const startP = { agentId: 'a1', runId: 'r1', trigger: 'schedule', model: 'm' };
A.eq(runTeeView('agent.run.start', startP), startP, 'agent.run.start tees whole');
A.ok(!!runTeeView('agent.cost', { agentId: 'a1', runId: 'r1', usd: 0.01, reconciled: true }), 'agent.cost tees');
A.ok(!!runTeeView('agent.run.end', { agentId: 'a1', runId: 'r1', reason: 'done', turns: 1, usd: 0 }), 'agent.run.end tees');

// EVERY tool_call tees — not just mcp__ — but NAME-ONLY: args/argsSummary stripped structurally
const tc = runTeeView('agent.tool_call', { agentId: 'a1', runId: 'r1', callId: 'c1', name: 'fs.read', argsSummary: 'C:/secret/path.txt' });
A.ok(!!tc, 'a plain (non-mcp) tool_call is teed — G0 prop pulses fire for autonomous runs');
A.eq(tc.name, 'fs.read', 'the tool NAME is carried (the prop mapper keys on it)');
A.eq(tc.agentId, 'a1', 'agentId is carried (pulse lands on the acting agent\'s prop)');
A.eq(tc.runId, 'r1', 'runId is carried (frozen agent.tool_call schema requires it)');
A.eq(tc.callId, 'c1', 'callId is carried (the delegation window pairs call->result)');
A.ok(!('argsSummary' in tc), 'argsSummary is STRIPPED — tool arguments never ride the SSE bus');
A.eq(Object.keys(tc).sort().join(','), 'agentId,callId,name,runId', 'the tool_call view carries EXACTLY the four id fields — nothing else can leak');
const tcm = runTeeView('agent.tool_call', { agentId: 'a1', runId: 'r1', callId: 'c2', name: 'mcp__github__search', argsSummary: '{"q":"x"}' });
A.ok(tcm && tcm.name === 'mcp__github__search' && !('argsSummary' in tcm), 'mcp__ tool_calls keep pulsing their portal, now also name-only');

// the token stream NEVER tees (that noise decision stands)
A.eq(runTeeView('agent.token', { agentId: 'a1', runId: 'r1', delta: 'hello' }), null, 'agent.token is never teed');

// agent.tool_result TEES OUTCOME-ONLY (2026-07-06 audit: was dropped; now the floor can render a FAILED/denied
// tool surge for autonomous runs) — but the payload-bearing `summary` is STRIPPED structurally.
const tr = runTeeView('agent.tool_result', { agentId: 'a1', runId: 'r1', callId: 'c1', ok: false, isError: true, ms: 12, summary: 'SECRET RESULT BODY' });
A.ok(!!tr, 'agent.tool_result is now teed (outcome-only) so denied/failed calls surge red on the floor');
A.ok(!('summary' in tr), 'the tool RESULT body (summary) is STRIPPED — result payloads never ride the SSE bus');
A.eq(Object.keys(tr).sort().join(','), 'agentId,callId,isError,ms,ok,runId', 'the tool_result view carries EXACTLY the outcome fields — nothing else can leak');
A.eq(tr.isError, true, 'isError (error-kind) is carried so the floor renders the red/dim variant');

// the observability metadata events tee WHOLE (no args/result payloads in their frozen schemas)
A.ok(!!runTeeView('deliverable', { id: 'd1', agentId: 'a1', room: 'r', kind: 'html', title: 't' }), 'deliverable tees (crates land for autonomous runs)');
A.ok(!!runTeeView('agent.run.error', { agentId: 'a1', runId: 'r1', message: 'boom', transient: false }), 'agent.run.error tees (errors strobe the floor)');
A.ok(!!runTeeView('memory.write', { agentId: 'a1', runId: 'r1', id: 'm1', kind: 'fact' }), 'memory.write tees (memory pulses for autonomous runs)');
A.ok(!!runTeeView('memory.recall', { agentId: 'a1', runId: 'r1', count: 3, chars: 40 }), 'memory.recall tees');
A.ok(!!runTeeView('capdenied', { agentId: 'a1', need: 'net', reason: 'no key' }), 'capdenied tees (denials show on the floor)');

A.eq(runTeeView('agent.reasoning', { agentId: 'a1', runId: 'r1', on: true }), null, 'other run events stay off the bus');

// SOURCE GUARD (lint-emits idiom): the runOnce broadcast tee in sidecar/index.js must route through
// runTeeView — a hand-rolled tee could silently re-leak args or re-tee tokens.
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
  const i = src.indexOf('const emit = o.broadcast');
  A.ok(i > 0, 'index.js has the broadcast-opted tee');
  const seg = src.slice(i, i + 400);
  A.ok(/runTeeView\(name,\s*payload\)/.test(seg), 'the tee routes through the runTeeView egress policy');
  A.ok(/redact\(view\)/.test(seg), 'the teed view still passes redact() as a second backstop');
}

A.report('channels.sse');
