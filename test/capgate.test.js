/* node test/capgate.test.js — object=capability resolution + the compute & tool gates. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { canAgentUse, attenuate, makeCapCtx } = require('../sidecar/capability/capGate.js');

// build a station: { roomId: [objectType,...] }, with agent 'ag' assigned to `assignedRoom`
function station(objsByRoom, assignedRoom) {
  const rooms = {};
  for (const r in objsByRoom) rooms[r] = { id: r, objects: objsByRoom[r].map((t, i) => ({ instanceId: r + '_' + i, objectType: t })) };
  return { rooms, agents: { ag: { id: 'ag', room: assignedRoom } } };
}

// ---- A. resolveTools (pure projection) ----
{
  const full = resolveTools('ag', station({ quarters: ['computer', 'notebook'] }, 'quarters'));
  A.ok(full.hasCompute, 'computer grants compute');
  A.eq(full.tools.slice().sort(), ['notebook.read', 'notebook.write'], 'notebook grants its tools; compute excluded from tools[]');
  A.eq(full.approvalRules['notebook.write'].requiresConsent, false, 'notebook write needs no consent (sandboxed private memory)');
  A.eq(full.approvalRules['notebook.read'].requiresConsent, false, 'read auto-allowed');

  const empty = resolveTools('ag', station({ quarters: [] }, 'quarters'));
  A.ok(!empty.hasCompute, 'empty room -> no compute');
  A.eq(empty.tools.length, 0, 'empty room -> no tools');

  // capability follows the ASSIGNED room, not objects elsewhere
  const split = resolveTools('ag', station({ quarters: ['notebook'], lab: ['computer'] }, 'quarters'));
  A.eq(split.tools.slice().sort(), ['notebook.read', 'notebook.write'], 'only assigned-room objects grant tools');
  A.ok(!split.hasCompute, 'a computer in a DIFFERENT room does not grant compute');

  // de-dupe duplicate objects
  const dup = resolveTools('ag', station({ quarters: ['notebook', 'notebook'] }, 'quarters'));
  A.eq(dup.tools.slice().sort(), ['notebook.read', 'notebook.write'], 'duplicate objects de-duped');

  // unknown agent -> nothing
  A.eq(resolveTools('ghost', station({ quarters: ['computer'] }, 'quarters')).tools.length, 0, 'unknown agent -> no tools');
}

// ---- B. canAgentUse ----
{
  const r = resolveTools('ag', station({ quarters: ['notebook'] }, 'quarters'));
  A.ok(canAgentUse(r, 'notebook.read').ok, 'granted tool allowed');
  A.ok(!canAgentUse(r, 'shell.exec').ok, 'ungranted tool denied');
  A.ok(canAgentUse(r, 'shell.exec').reason.indexOf('shell.exec') >= 0, 'denial names the tool');
}

// ---- C. attenuate (intersection, never union) ----
{
  const r = resolveTools('ag', station({ quarters: ['notebook'] }, 'quarters'));
  A.eq(attenuate(r, ['notebook.read', 'web.fetch']).tools, ['notebook.read'], 'attenuate intersects; never adds web.fetch');
}

// ---- C2. makeCapCtx threads run-scoped extras (runId) onto the ctx tools/dispatch consume (B1 seam) ----
{
  const r = resolveTools('ag', station({ quarters: ['notebook'] }, 'quarters'));
  const cc = makeCapCtx(r, { runId: 'run_42' });
  A.eq(cc.runId, 'run_42', 'makeCapCtx surfaces runId from extra (so a tool can stamp sourceRunId)');
  A.eq(cc.agentId, 'ag', 'capCtx still carries agentId');
  A.eq(typeof cc.canUse, 'function', 'capCtx still exposes canUse');
  A.eq(typeof cc.canRun, 'function', 'capCtx still exposes the compute gate');
}

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  return { bus, seq, emit: makeEmitter(bus, () => {}) };
}

(async () => {
  // ---- D. compute gate: empty room -> NO paid model call ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider({ turns: [[{ type: 'text', delta: 'hi' }, { type: 'done', finishReason: 'stop' }]] });
    const resolved = resolveTools('ag', station({ quarters: [] }, 'quarters'));
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', capCtx: makeCapCtx(resolved) });
    A.eq(provider.callCount(), 0, 'no compute -> NO paid model call');
    const cd = seq.find(e => e.name === 'capdenied');
    A.ok(cd !== undefined, 'capdenied emitted');
    A.eq(cd.payload.need, 'compute', 'capdenied need=compute');
    A.eq(res.reason, 'error', 'run ends without doing work');
  }

  // ---- D2. compute present -> normal run ----
  {
    const { emit } = setup();
    const provider = makeReplayProvider({ turns: [[{ type: 'text', delta: 'hi' }, { type: 'done', finishReason: 'stop' }]] });
    const resolved = resolveTools('ag', station({ quarters: ['computer'] }, 'quarters'));
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', capCtx: makeCapCtx(resolved) });
    A.eq(provider.callCount(), 1, 'compute present -> model call proceeds');
    A.eq(res.reason, 'done', 'normal completion');
  }

  // ---- E. tool gate: model calls an ungranted tool -> capdenied result, body never runs, pairing held ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider({ turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'notebook.read' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]
    ] });
    const reg = makeRegistry();
    let ran = 0;
    reg.register({ name: 'notebook.read', capability: 'memory', schema: { type: 'object' }, run: async () => { ran++; return 'secret notes'; } });
    // computer present (run proceeds) but NO notebook -> notebook.read is not granted
    const resolved = resolveTools('ag', station({ quarters: ['computer'] }, 'quarters'));
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'read my notes' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', tools: reg.wireFormat(), dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: makeCapCtx(resolved)
    });
    const tr = seq.find(e => e.name === 'agent.tool_result').payload;
    A.eq(tr.isError, true, 'ungranted tool -> isError result');
    A.eq(tr.summary, 'capdenied', 'tool_result marked capdenied');
    A.eq(ran, 0, 'the tool body never ran (no action)');
    A.eq(res.reason, 'done', 'loop recovers and finishes');
  }

  A.report('capgate.test');
})();
