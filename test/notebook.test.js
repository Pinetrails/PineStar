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

  // ============ A2. M-mem.2: widened §5.2 record shape + provenance + memory.write ============
  {
    const { seq, emit } = setup();
    const store = memStore();
    const reg = makeRegistry();
    makeNotebookTools({ store, clock: makeClock(7000) }).register(reg);

    await reg.dispatch(dcall('notebook.write', { title: 'fact', body: 'the sky is blue' }), { agentId: 'ag', emit, runId: 'run_42' });
    const n = store.get('notebook:ag')[0];
    A.eq(n.kind, 'note', 'widened: kind = note');
    A.eq(n.scope, 'global', 'widened: scope defaults to global');
    A.eq(n.streamId, null, 'widened: streamId null until the M-mem.2b frontend seam');
    A.eq(n.sourceRunId, 'run_42', 'provenance (Bet 2): sourceRunId stamped from ctx.runId');
    A.eq(n.createdAt, 7000, 'widened: createdAt from the injected clock');
    A.eq(n.useCount, 0, 'widened: useCount starts at 0 (moves with memory.used)');
    A.eq(n.trust, 0, 'widened: trust starts neutral (moves with memory.feedback)');
    A.eq(n.pinned, false, 'widened: not pinned');
    A.eq(n.title, 'fact', 'back-compat: title preserved'); A.eq(n.body, 'the sky is blue', 'back-compat: body preserved');

    const mw = seq.find(e => e.name === 'memory.write');
    A.ok(mw, 'memory.write emitted on a real (runId-bearing) write');
    A.eq(mw.payload.id, n.id, 'memory.write carries the note id');
    A.eq(mw.payload.runId, 'run_42', 'memory.write carries runId (contract requires it)');
    A.eq(mw.payload.kind, 'note', 'memory.write kind = note');
    A.eq(mw.payload.scope, 'global', 'memory.write scope = global');

    // M-mem.6 regression guard: ids are collision-proof (max+1), NOT positional (length+1). A store with a gap
    // — as left by a forget that removed an earlier record — must NOT reissue an id that already exists.
    const storeGap = memStore();
    storeGap.set('notebook:ag', [
      { id: 'note_1', kind: 'note', title: 'a', body: 'a', scope: 'global', streamId: null, sourceRunId: null, createdAt: 1, ts: 1, lastUsedAt: null, useCount: 0, trust: 0, pinned: false },
      { id: 'note_3', kind: 'note', title: 'c', body: 'c', scope: 'global', streamId: null, sourceRunId: null, createdAt: 1, ts: 1, lastUsedAt: null, useCount: 0, trust: 0, pinned: false }
    ]);
    const regGap = makeRegistry();
    makeNotebookTools({ store: storeGap, clock: makeClock(1) }).register(regGap);
    await regGap.dispatch(dcall('notebook.write', { title: 'd', body: 'd' }), { agentId: 'ag' });
    const gapList = storeGap.get('notebook:ag');
    A.eq(gapList.length, 3, 'the new note appended (no overwrite)');
    A.eq(gapList[2].id, 'note_4', 'next id is max+1 (note_4), NOT the colliding positional length+1 (note_3)');
    A.eq(new Set(gapList.map(n => n.id)).size, 3, 'all ids stay unique after a write into a gapped store');

    // best-effort telemetry: a write WITHOUT a runId still persists, just emits no memory.write
    const { seq: seq2, emit: emit2 } = setup();
    const store2 = memStore();
    const reg2 = makeRegistry();
    makeNotebookTools({ store: store2, clock: makeClock(0) }).register(reg2);
    await reg2.dispatch(dcall('notebook.write', { title: 't', body: 'b' }), { agentId: 'ag', emit: emit2 });
    A.eq(store2.get('notebook:ag').length, 1, 'a runId-less write still persists');
    A.eq(seq2.filter(e => e.name === 'memory.write').length, 0, 'no memory.write without a runId');
    A.eq(seq2.filter(e => e.name === 'deliverable').length, 1, 'deliverable still emitted without a runId');

    // migration: a legacy {id,title,body,ts} note widens transparently on read, idempotently
    const store3 = memStore();
    store3.set('notebook:ag', [{ id: 'note_1', title: 'old', body: 'legacy', ts: 1234 }]);
    const reg3 = makeRegistry();
    makeNotebookTools({ store: store3, clock: makeClock(0) }).register(reg3);
    const r3 = await reg3.dispatch(dcall('notebook.read', {}), { agentId: 'ag' });
    A.ok(r3.content.indexOf('old') >= 0, 'migration: a legacy note still reads back');
    await reg3.dispatch(dcall('notebook.write', { title: 'new', body: 'fresh' }), { agentId: 'ag', emit, runId: 'r1' });
    const migrated = store3.get('notebook:ag')[0];
    A.eq(migrated.kind, 'note', 'migration: legacy note gains kind = note');
    A.eq(migrated.scope, 'global', 'migration: legacy note gains scope = global');
    A.eq(migrated.createdAt, 1234, 'migration: createdAt derived from the legacy ts');
    A.eq(migrated.useCount, 0, 'migration: useCount defaulted');
    A.eq(migrated.title, 'old', 'migration: original content preserved');
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
