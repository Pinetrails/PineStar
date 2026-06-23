/* node test/recall.test.js — agent-callable conversation recall (H1.3).
   Proves transcriptStore.search() ranks the row containing a query phrase first (BM25-ish: distinct terms, then
   frequency, then recency), is stream-scoped, and that the recall_conversation tool returns the match / guards an
   empty query / degrades gracefully. Pure + deterministic (injected clock, in-memory io). */
'use strict';
const A = require('./_assert.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeRecallTool } = require('../sidecar/tools/builtin/recall.js');

function memIo() { const lines = []; return { lines, readAll() { return lines.slice(); }, append(e) { lines.push(e); } }; }
let clk = 1000; const clock = { now: () => clk };

(async () => {
  // ---- A. search(): a phrase from turn #3 ranks that turn FIRST among 50 ----
  {
    const s = makeTranscriptStore({ io: memIo(), clock });
    for (let i = 0; i < 50; i++) { clk = 1000 + i; s.append({ streamId: 's1', role: 'user', content: 'message number ' + i + ' about ' + (i === 3 ? 'the quarterly budget reconciliation plan' : 'misc topic ' + i) }); }
    const hits = s.search('s1', 'quarterly budget reconciliation', { limit: 5 });
    A.ok(hits.length >= 1, 'search returns matches');
    A.ok(hits[0].content.indexOf('number 3 ') >= 0, 'the turn containing the phrase ranks FIRST');
  }

  // ---- B. search() is stream-scoped (never leaks another workstream's dialogue) ----
  {
    const s = makeTranscriptStore({ io: memIo(), clock });
    s.append({ streamId: 'a', role: 'user', content: 'alpha secret pumpkin' });
    s.append({ streamId: 'b', role: 'user', content: 'beta pumpkin elsewhere' });
    const hits = s.search('a', 'pumpkin', { limit: 5 });
    A.eq(hits.length, 1, 'only the queried stream is searched');
    A.ok(hits[0].content.indexOf('alpha') >= 0, 'returns stream a, not stream b');
  }

  // ---- C. search(): empty/no-match queries are safe ----
  {
    const s = makeTranscriptStore({ io: memIo(), clock });
    s.append({ streamId: 'x', role: 'user', content: 'hello world' });
    A.eq(s.search('x', '', { limit: 5 }), [], 'empty query -> no matches');
    A.eq(s.search('x', 'zzzznomatch', { limit: 5 }), [], 'no-overlap query -> no matches');
  }

  // ---- D. the recall_conversation tool: returns matches, scoped by ctx.streamId ----
  {
    const s = makeTranscriptStore({ io: memIo(), clock });
    s.append({ streamId: 's9', role: 'user', content: 'we agreed to ship the airlock fix on friday' });
    s.append({ streamId: 's9', role: 'assistant', content: 'confirmed, airlock fix friday' });
    const { recallTool } = makeRecallTool({ transcriptStore: s });
    A.eq(recallTool.name, 'recall_conversation', 'tool name');
    A.eq(recallTool.capability, 'memory', 'joins the NOTEBOOK (memory) capability');
    A.eq(recallTool.requiresConsent, false, 'read-only, no consent');
    const r = await recallTool.run({ query: 'airlock friday' }, { streamId: 's9' });
    A.ok(r.content.indexOf('airlock') >= 0, 'tool surfaces the matching dialogue');
    A.ok(/match/.test(r.summary), 'summary reports match count');
  }

  // ---- E. the tool guards an empty query + a missing store ----
  {
    const { recallTool } = makeRecallTool({ transcriptStore: makeTranscriptStore({ io: memIo(), clock }) });
    const empty = await recallTool.run({ query: '   ' }, { streamId: 's1' });
    A.ok(/query/i.test(empty.content), 'empty query -> a helpful nudge, not a crash');
    const noStore = makeRecallTool({}).recallTool;
    const r = await noStore.run({ query: 'x' }, { streamId: 's1' });
    A.ok(/unavailable/i.test(r.content), 'missing transcriptStore -> graceful "unavailable"');
  }

  A.report('recall.test');
})();
