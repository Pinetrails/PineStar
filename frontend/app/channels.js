/* SKYNET — channels.js : per-workstream COMMS run-state (THE GATE).

   The single defect that made genuine multi-agent impossible was that chat.js kept ONE
   global run-state (one `busy`, one `currentRunId`, one in-flight stream) and wiped the DOM
   on every stream switch. This module lifts that state OUT of chat.js into a per-WORKSTREAM
   channel, so:
     - two workstreams can have a run in flight AT THE SAME TIME (each its own `busy`/`runId`);
     - switching the displayed stream no longer destroys the one you left — chat.js re-renders
       the in-flight text / tool lines / pending approval from a channel SNAPSHOT instead of
       wiping it.

   It owns ONLY transient run-state. History stays in Workstreams (workstreams.js) — never
   duplicated here. A channel is keyed by workstreamId (NOT agentId: many workstreams can share
   one agentId, workstreams.js make() defaults agentId:'agent').

   Pure + DOM-free + dependency-free, UMD like workstreams.js, so it is unit-testable headless
   (test/channels.test.js). chat.js is the DOM VIEW over this model.

   composeTargetId is tracked here, decoupled from camera/selection (war-room D2): the thing that
   moves your eyes (a camera jump to the agent that needs you) must never silently re-aim the
   COMMS input. The compose target is the workstream a typed message is sent to. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Channels = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const map = new Map();          // workstreamId -> channel (transient; never persisted)
  let composeTargetId = null;     // which workstream the COMMS input posts to

  function blank(wsId) {
    return {
      wsId: wsId,
      busy: false,
      runId: null,                // the in-flight run id (for Harness.cancel / consent routing)
      acc: '',                    // accumulated in-flight assistant text (survives a switch)
      tools: [],                  // in-flight tool-activity lines: [{ text, isErr }]
      pending: null,              // live consent awaiting a human: { promptId, tool, argsSummary, runId }
      status: 'online'            // 'online' | 'thinking…' | 'working…' | 'awaiting your approval…'
    };
  }

  // get-or-create the channel for a workstream.
  function get(wsId) {
    if (wsId == null) return null;
    let c = map.get(wsId);
    if (!c) { c = blank(wsId); map.set(wsId, c); }
    return c;
  }
  function peek(wsId) { return (wsId == null) ? null : (map.get(wsId) || null); }   // no auto-create
  function has(wsId) { return map.has(wsId); }

  // ---------- run lifecycle ----------
  // a run is starting on this workstream — clear any stale transient state, mark busy.
  function begin(wsId) {
    const c = get(wsId);
    c.busy = true; c.runId = null; c.acc = ''; c.tools = []; c.pending = null;
    c.status = 'thinking…';
    return c;
  }
  // the run finished (or errored/aborted) — drop transient state; the turn now lives in Workstreams.history.
  function end(wsId) {
    const c = peek(wsId); if (!c) return;
    c.busy = false; c.runId = null; c.acc = ''; c.tools = []; c.pending = null;
    c.status = 'online';
  }
  function setRunId(wsId, runId) { const c = get(wsId); c.runId = runId; return runId; }
  function setStatus(wsId, s) { const c = get(wsId); c.status = s; return s; }
  function appendToken(wsId, d) { const c = get(wsId); c.acc += (d == null ? '' : d); return c.acc; }
  function setAcc(wsId, text) { const c = get(wsId); c.acc = (text == null ? '' : String(text)); return c.acc; }
  function addTool(wsId, text, isErr) { const c = get(wsId); c.tools.push({ text: String(text == null ? '' : text), isErr: !!isErr }); return c.tools.length; }
  function setPending(wsId, p) { const c = get(wsId); c.pending = p || null; if (p) c.status = 'awaiting your approval…'; return c.pending; }
  function clearPending(wsId) { const c = peek(wsId); if (c) { c.pending = null; c.status = c.busy ? 'working…' : 'online'; } }

  // ---------- queries ----------
  function isBusy(wsId) { const c = peek(wsId); return !!(c && c.busy); }
  function runIdOf(wsId) { const c = peek(wsId); return c ? c.runId : null; }
  function statusOf(wsId) { const c = peek(wsId); return c ? c.status : 'online'; }
  function pendingOf(wsId) { const c = peek(wsId); return c ? c.pending : null; }
  function anyBusy() { for (const c of map.values()) if (c.busy) return true; return false; }
  function busyCount() { let n = 0; for (const c of map.values()) if (c.busy) n++; return n; }
  function busyIds() { const out = []; for (const c of map.values()) if (c.busy) out.push(c.wsId); return out; }
  function pendingIds() { const out = []; for (const c of map.values()) if (c.pending) out.push(c.wsId); return out; }

  // a deep-ish copy for chat.js to re-render a stream on switch — callers must not mutate live state.
  function snapshot(wsId) {
    const c = peek(wsId); if (!c) return null;
    return {
      wsId: c.wsId, busy: c.busy, runId: c.runId, acc: c.acc,
      tools: c.tools.map(t => ({ text: t.text, isErr: t.isErr })),
      pending: c.pending ? Object.assign({}, c.pending) : null,
      status: c.status
    };
  }

  // ---------- compose target (decoupled from camera/selection — war-room D2) ----------
  function setComposeTarget(wsId) { composeTargetId = (wsId == null ? null : wsId); return composeTargetId; }
  function composeTarget() { return composeTargetId; }

  // ---------- teardown ----------
  function drop(wsId) { map.delete(wsId); if (composeTargetId === wsId) composeTargetId = null; }
  function reset() { map.clear(); composeTargetId = null; }

  return {
    get: get, peek: peek, has: has,
    begin: begin, end: end, setRunId: setRunId, setStatus: setStatus,
    appendToken: appendToken, setAcc: setAcc, addTool: addTool, setPending: setPending, clearPending: clearPending,
    isBusy: isBusy, runIdOf: runIdOf, statusOf: statusOf, pendingOf: pendingOf,
    anyBusy: anyBusy, busyCount: busyCount, busyIds: busyIds, pendingIds: pendingIds, snapshot: snapshot,
    setComposeTarget: setComposeTarget, composeTarget: composeTarget,
    drop: drop, reset: reset
  };
});
