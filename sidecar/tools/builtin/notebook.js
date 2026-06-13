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
    const notesOf = aid => { const v = store.get(KEY(aid)); return Array.isArray(v) ? v : []; };

    const writeTool = {
      name: 'notebook.write', capability: 'memory', scope: 'write', requiresConsent: true,
      description: 'Save a short titled note to your persistent notebook so you remember it later.',
      schema: { type: 'object', required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const list = notesOf(aid);
        const note = { id: 'note_' + (list.length + 1), title: String(args.title), body: String(args.body), ts: clock.now() };
        list.push(note);
        store.set(KEY(aid), list);
        if (ctx && typeof ctx.emit === 'function') {
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
