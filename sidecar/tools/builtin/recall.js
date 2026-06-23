/* sidecar/tools/builtin/recall.js — the recall_conversation tool (H1.3).

   The Hermes parity gap: Hermes exposes search_messages (BM25 FTS5) to the agent ITSELF so it can pull
   weeks-old dialogue back into context on demand. StarNet already writes a durable per-workstream transcript
   (transcriptstore.js) and has BM25 recall — but only over the curated NOTEBOOK, never the conversation. This
   tool closes that: the agent searches its OWN past dialogue in the active workstream by keyword and gets the
   most relevant earlier messages back.

   Joins the NOTEBOOK (memory) capability — granted by the placed NOTEBOOK object alongside notebook.read/write,
   so it appears exactly when durable memory does. Read-only, no consent (it only reads the agent's own
   transcript, which is already redacted on write).

     makeRecallTool({ transcriptStore }) -> { recallTool, register(registry) }
   At call time, ctx supplies streamId (the active workstream) — recall is scoped to that stream so the agent
   pulls back THIS conversation's history, not another stream's. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).recall = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makeRecallTool(deps) {
    const d = deps || {};
    const transcriptStore = d.transcriptStore;

    const recallTool = {
      name: 'recall_conversation', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'Search your OWN earlier conversation in THIS workstream by keyword and get the most relevant ' +
        'past messages back — use it to remember what was discussed earlier (days/weeks ago) that has scrolled out ' +
        'of context. Returns the best-matching prior turns, most relevant first. Not the same as notebook (durable ' +
        'facts you chose to save) — this searches the raw dialogue history.',
      schema: {
        type: 'object', required: ['query'],
        properties: {
          query: { type: 'string', description: 'words or a phrase to find in your earlier dialogue' },
          limit: { type: 'integer', description: 'max matches to return (default 5)' }
        }
      },
      run: async (args, ctx) => {
        const streamId = ctx && ctx.streamId ? String(ctx.streamId) : null;
        const q = args && args.query ? String(args.query) : '';
        if (!q.trim()) return { content: 'Provide a `query` (words to find in your earlier conversation).', summary: 'no query' };
        if (!transcriptStore || typeof transcriptStore.search !== 'function') return { content: 'Conversation recall is unavailable.', summary: 'unavailable' };
        const limit = (args && Number(args.limit) > 0) ? Math.min(Number(args.limit), 20) : 5;
        let hits = [];
        try { hits = transcriptStore.search(streamId, q, { limit }) || []; } catch (_) { hits = []; }
        if (!hits.length) return { content: 'No earlier messages in this workstream match "' + q + '".', summary: '0 matches' };
        const body = hits.map((h, i) => (i + 1) + '. [' + h.role + '] ' + String(h.content).slice(0, 600)).join('\n');
        return { content: body, summary: hits.length + ' match(es)' };
      }
    };

    return {
      recallTool,
      register(registry) { if (registry && typeof registry.register === 'function') registry.register(recallTool); return this; }
    };
  }

  return { makeRecallTool };
});
