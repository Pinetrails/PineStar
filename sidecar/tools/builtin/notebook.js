/* sidecar/tools/builtin/notebook.js — the NOTEBOOK (memory) capability: the first real tool.
   Pure, sandboxed, no filesystem path-escape surface, no network. Backed by an injected store
   (in-memory for tests; localStorage/Save-backed in the browser; SQLite in the sidecar later) —
   the tool never touches storage directly. Notes are namespaced per agent.

   makeNotebookTools({ store, clock }) -> { writeTool, readTool, register(registry) }
     store : { get(key) -> value|undefined, set(key, value) }
     clock : { now() -> ms }   (injected for deterministic note timestamps)
   At call time, ctx supplies agentId / room / emit (the validated emitter) / consent. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).notebook = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makeNotebookTools(deps) {
    deps = deps || {};
    const store = deps.store;
    const clock = deps.clock || { now: () => 0 };
    const KEY = aid => 'notebook:' + (aid || 'agent');
    // M-mem.2: widen any legacy {id,title,body,ts} note to the §5.2 memory-record shape
    // (kind/scope/provenance/trust/useCount/pinned), idempotently — so an existing notebook upgrades
    // transparently on read, and the next write persists the new shape. title/body/ts are preserved.
    function migrate(n) {
      if (n && n.kind && n.scope) return n;
      return Object.assign({
        kind: 'note', scope: 'global', streamId: null, sourceRunId: null,
        createdAt: (n && typeof n.ts === 'number') ? n.ts : 0,
        lastUsedAt: null, useCount: 0, trust: 0, pinned: false
      }, n);
    }
    const notesOf = aid => { const v = store.get(KEY(aid)); return Array.isArray(v) ? v.map(migrate) : []; };
    // collision-proof id: one past the HIGHEST existing note_N. Positional ('note_'+list.length) reuses a slot
    // freed by a forget (M-mem.6) -> a DUPLICATE id -> id-keyed ops corrupt/delete the wrong record. Mirrors
    // memcore.nextNoteId (kept inline so this UMD tool stays dependency-free).
    const nextId = list => { let max = 0; for (const n of list) { const m = /^note_(\d+)$/.exec(n && n.id); if (m && +m[1] > max) max = +m[1]; } return 'note_' + (max + 1); };

    const writeTool = {
      // NO consent gate: the notebook is the agent's OWN sandboxed private memory (no filesystem reach, no
      // network, a sibling file its fs.* tools can't even touch) — not the user's files. Prompting on every
      // jotted note would be pure consent-fatigue; approval is reserved for outward effects (fs.* writes).
      name: 'notebook.write', capability: 'memory', scope: 'write', requiresConsent: false,
      description: 'Save a short titled note to your persistent notebook so you remember it later.',
      schema: { type: 'object', required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const runId = ctx && ctx.runId ? String(ctx.runId) : null;   // provenance source (B1 Cortex seam)
        const list = notesOf(aid);
        const now = clock.now();
        // §5.2 record: title/body/ts kept (back-compat + recall); sourceRunId is the moat (drill any fact ->
        // the run that earned it). useCount/lastUsedAt move with memory.used; trust with memory.feedback.
        const note = {
          id: nextId(list), kind: 'note',
          title: String(args.title), body: String(args.body),
          scope: 'global', streamId: null, sourceRunId: runId,
          createdAt: now, ts: now, lastUsedAt: null, useCount: 0, trust: 0, pinned: false
        };
        list.push(note);
        store.set(KEY(aid), list);
        if (ctx && typeof ctx.emit === 'function') {
          // memory.write — the durable-memory rung (feeds useCount/trust + the dossier's archivist track). The
          // frozen contract requires runId, so emit only on a real run (some test fixtures carry no runId).
          if (runId) ctx.emit('memory.write', { agentId: aid, runId, id: note.id, kind: 'note', scope: 'global' });
          const d = { id: note.id, agentId: aid, kind: 'note', title: note.title };
          if (ctx.room) d.room = ctx.room;
          ctx.emit('deliverable', d);
        }
        return { content: 'Saved note "' + note.title + '" (' + note.id + ').', summary: 'wrote ' + note.id };
      }
    };

    const readTool = {
      name: 'notebook.read', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'Read your notebook. Optional `query` filters notes by a title/body substring.',
      schema: { type: 'object', properties: { query: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        let list = notesOf(aid);
        const q = args && args.query;
        if (q) { const ql = String(q).toLowerCase(); list = list.filter(n => (n.title + ' ' + n.body).toLowerCase().indexOf(ql) >= 0); }
        if (!list.length) return { content: q ? 'No notes match "' + q + '".' : 'Your notebook is empty.', summary: '0 notes' };
        return { content: list.map(n => '- [' + n.id + '] ' + n.title + ': ' + n.body).join('\n'), summary: list.length + ' note(s)' };
      }
    };

    return {
      writeTool, readTool,
      register(reg) { reg.register(writeTool); reg.register(readTool); return reg; }
    };
  }

  return { makeNotebookTools };
});
