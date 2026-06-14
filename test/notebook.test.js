/* node test/notebook.test.js — the first real tool + the MILESTONE 1 EXIT CRITERION:
   a directive drives the replay loop through model -> notebook.write -> final answer, the note
   is persisted, every transition is a validated U.bus event, removing the notebook drops the
   tool (capdenied), and a same-seed double-run is byte-identical. Zero spend, zero browser. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeClock } = require('../shared/clock-rng.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { canAgentUse, makeCapCtx } = require('../sidecar/capability/capGate.js');
const { makeNotebookTools } = require('../sidecar/tools/builtin/notebook.js');

function memStore() { const m = {}; return { get: k => m[k], set: (k, v) => { m[k] = v; } }; }
function station(objs) {
  return {
    rooms: { quarters: { id: 'quarters', objects: objs.map((t, i) => ({ instanceId: 'q' + i, objectType: t })) } },
    agents: { ag: { id: 'ag', room: 'quarters' } }
  };
}
function setup() { const bus = A.makeBus(); const seq = A.collectBus(bus, events.names()); return { bus, seq, emit: makeEmitter(bus, () => {}) }; }
const dcall = (name, args) => ({ id: 'c', name, args, argsRaw: JSON.stringify(args || {}), parseError: null });

(async () => {
  // ============ A. notebook tools as units ============
  {
    const store = memStore();
    const reg = makeRegistry();
    makeNotebookTools({ store, clock: makeClock(1000) }).register(reg);

    let r = await reg.dispatch(dcall('notebook.read', {}), { agentId: 'ag' });
    A.ok(r.content.indexOf('empty') >= 0, 'empty notebook reads empty');

    // notebook is the agent's OWN sandboxed memory — writes do NOT require consent (unlike fs.* / the user's
    // files): the dispatch consent gate is simply not consulted, so a deny-everything consent fn is ignored.
    r = await reg.dispatch(dcall('notebook.write', { title: 'first', body: 'hello' }), { agentId: 'ag', consent: async () => ({ allow: false }) });
    A.eq(r.ok, true, 'notebook write needs no consent — a denying consent fn is not even consulted');
    const notes = store.get('notebook:ag');
    A.eq(notes.length, 1, 'one note persisted with the injected timestamp');
    A.eq(notes[0].title, 'first', 'note title'); A.eq(notes[0].ts, 1000, 'note ts from injected clock');

    // read back + query miss
    r = await reg.dispatch(dcall('notebook.read', {}), { agentId: 'ag' });
    A.ok(r.content.indexOf('first') >= 0, 'read returns the note');
    r = await reg.dispatch(dcall('notebook.read', { query: 'zzz' }), { agentId: 'ag' });
    A.ok(r.content.indexOf('No notes match') >= 0, 'query miss');

    // per-agent isolation
    A.eq((store.get('notebook:other') || []).length, 0, 'notes are namespaced per agent');

    // schema validation: missing body -> isError, nothing persisted
    r = await reg.dispatch(dcall('notebook.write', { title: 'only title' }), { agentId: 'ag', consent: async () => ({ allow: true }) });
    A.eq(r.isError, true, 'missing body rejected by schema');
    A.eq(store.get('notebook:ag').length, 1, 'rejected write did not persist');
  }

  // ============ B/C. EXIT CRITERION + determinism ============
  function exitFixture() {
    return {
      models: [{ id: 'replay/model', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' }, supportsTools: true }],
      turns: [
        [ { type: 'text', delta: 'Let me note that. ' },
          { type: 'tool_start', index: 0, id: 'call_1', name: 'notebook.write' },
          { type: 'tool_args', index: 0, chunk: '{"title":"first contact",' },
          { type: 'tool_args', index: 0, chunk: '"body":"I am online"}' },
          { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } },
          { type: 'done', finishReason: 'tool_calls' } ],
        [ { type: 'text', delta: 'Noted, Commander.' },
          { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } },
          { type: 'done', finishReason: 'stop' } ]
      ]
    };
  }
  function runExit() {
    const { seq, emit } = setup();
    const store = memStore();
    const provider = makeReplayProvider(exitFixture());
    const reg = makeRegistry();
    makeNotebookTools({ store, clock: makeClock(0) }).register(reg);
    const resolved = resolveTools('ag', station(['computer', 'notebook']));
    const capCtx = makeCapCtx(resolved, { emit, consent: async () => ({ allow: true }) });
    const run = runAgentLoop({
      messages: [{ role: 'user', content: 'remember that you just came online' }], provider, emit,
      cost: makeCostEngine({ priceOf: provider.priceOf }), clock: makeClock(0), model: 'replay/model',
      agentId: 'ag', tools: reg.wireFormat(), dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx
    });
    return { seq, store, provider, run };
  }

  {
    const ex = runExit();
    const res = await ex.run;
    A.eq(res.reason, 'done', 'EXIT: loop completes done');
    A.eq(ex.provider.callCount(), 2, 'EXIT: two model calls (tool turn + final answer)');

    const notes = ex.store.get('notebook:ag');
    A.eq(notes.length, 1, 'EXIT: the note was persisted');
    A.eq(notes[0].title, 'first contact', 'EXIT: persisted title');
    A.eq(notes[0].body, 'I am online', 'EXIT: persisted body');

    const tc = ex.seq.find(e => e.name === 'agent.tool_call').payload;
    const tr = ex.seq.find(e => e.name === 'agent.tool_result').payload;
    A.eq(tc.name, 'notebook.write', 'EXIT: the real tool was called');
    A.eq(tc.callId, tr.callId, 'EXIT: requested id === answered id');
    A.eq(tr.isError, false, 'EXIT: tool succeeded');
    A.eq(ex.seq.filter(e => e.name === 'deliverable').length, 1, 'EXIT: deliverable emitted exactly once');
    A.eq(ex.seq.filter(e => e.name === 'agent.run.end').length, 1, 'EXIT: run.end emitted once');
    A.eq(ex.seq.map(e => e.name)[0], 'agent.run.start', 'EXIT: starts with run.start');
    A.eq(ex.seq.map(e => e.name).pop(), 'agent.run.end', 'EXIT: ends with run.end');
  }

  {
    const a = runExit(); await a.run;
    const b = runExit(); await b.run;
    A.eq(JSON.stringify(a.seq), JSON.stringify(b.seq), 'EXIT: same-seed double-run is byte-identical');
  }

  // ============ D. reclaim the notebook -> tool dropped -> capdenied, nothing persisted ============
  {
    const { seq, emit } = setup();
    const store = memStore();
    const provider = makeReplayProvider({ turns: [
      [ { type: 'tool_start', index: 0, id: 'c1', name: 'notebook.write' }, { type: 'tool_args', index: 0, chunk: '{"title":"x","body":"y"}' }, { type: 'done', finishReason: 'tool_calls' } ],
      [ { type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' } ]
    ] });
    const reg = makeRegistry();
    makeNotebookTools({ store, clock: makeClock(0) }).register(reg);
    const resolved = resolveTools('ag', station(['computer'])); // notebook reclaimed; computer still present
    A.ok(!canAgentUse(resolved, 'notebook.write').ok, 'notebook.write dropped after reclaim');
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'note this' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'ag', tools: reg.wireFormat(), dispatch: (c, ctx) => reg.dispatch(c, ctx),
      capCtx: makeCapCtx(resolved, { emit, consent: async () => ({ allow: true }) })
    });
    const tr = seq.find(e => e.name === 'agent.tool_result').payload;
    A.eq(tr.isError, true, 'reclaimed notebook -> capdenied result');
    A.eq(tr.summary, 'capdenied', 'capdenied summary');
    A.eq((store.get('notebook:ag') || []).length, 0, 'nothing persisted after reclaim');
    A.eq(seq.filter(e => e.name === 'deliverable').length, 0, 'no deliverable when denied');
    A.eq(res.reason, 'done', 'loop recovers and finishes');
  }

  A.report('notebook.test');
})();
