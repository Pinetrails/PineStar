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

  // ---- F. sessionSearch(): Hermes-like browse/discover/read/scroll over stable message ids ----
  {
    const s = makeTranscriptStore({ io: memIo(), clock });
    clk = 2000;
    s.append({ streamId: 'alpha', role: 'user', content: 'start alpha project brief' });
    s.append({ streamId: 'alpha', role: 'assistant', content: 'alpha kickoff acknowledged' });
    const anchor = s.append({ streamId: 'alpha', role: 'user', content: 'the quarterly budget reconciliation plan needs an airlock review' });
    s.append({ streamId: 'alpha', role: 'assistant', content: 'airlock budget reconciliation noted' });
    s.append({ streamId: 'alpha', role: 'user', content: 'wrap alpha' });
    clk = 3000;
    s.append({ streamId: 'beta', role: 'user', content: 'beta launch notes mention quarterly budget only once' });
    s.append({ streamId: 'beta', role: 'assistant', content: 'beta response' });

    const browse = s.sessionSearch({ limit: 5 }, { streamId: 'alpha' });
    A.eq(browse.mode, 'browse', 'sessionSearch no args -> browse mode');
    A.ok(browse.results.some(x => x.sessionId === 'beta'), 'browse lists other recent sessions');
    A.ok(!browse.results.some(x => x.sessionId === 'alpha'), 'browse excludes the active session lineage');

    const found = s.sessionSearch({ query: 'quarterly budget reconciliation airlock', limit: 5, window: 1 }, { streamId: 'gamma' });
    A.eq(found.mode, 'discover', 'query -> discover mode');
    A.eq(found.results[0].sessionId, 'alpha', 'discover dedupes and ranks the best matching session first');
    A.eq(found.results[0].matchMessageId, anchor.id, 'discover exposes a stable message anchor');
    A.ok(found.results[0].messages.some(m => m.anchor), 'discover returns an anchored match window');
    A.ok(found.results[0].bookendStart.length > 0 && found.results[0].bookendEnd.length > 0, 'discover includes session bookends');

    const read = s.sessionSearch({ sessionId: 'alpha', head: 2, tail: 1 });
    A.eq(read.mode, 'read', 'sessionId -> read mode');
    A.eq(read.truncated, true, 'read bounds long sessions with head+tail');
    A.eq(read.messages.length, 3, 'read returns bounded first+last messages');

    const scroll = s.sessionSearch({ sessionId: 'alpha', aroundMessageId: anchor.id, window: 1 });
    A.eq(scroll.mode, 'scroll', 'sessionId+aroundMessageId -> scroll mode');
    A.ok(scroll.messages.some(m => m.id === anchor.id && m.anchor), 'scroll centers and marks the anchor message');
    A.eq(scroll.messages.length, 3, 'scroll returns +/- window around the anchor');
  }

  // ---- G. session_search tool returns structured JSON and degrades gracefully ----
  {
    const s = makeTranscriptStore({ io: memIo(), clock });
    s.append({ streamId: 's_tool', role: 'user', content: 'remember the graphite gasket audit trail' });
    const { sessionSearchTool } = makeRecallTool({ transcriptStore: s });
    A.eq(sessionSearchTool.name, 'session_search', 'session_search tool name');
    A.eq(sessionSearchTool.capability, 'memory', 'session_search joins the memory capability');
    const r = await sessionSearchTool.run({ query: 'graphite gasket', limit: 3 }, { streamId: 'other' });
    const parsed = JSON.parse(r.content);
    A.eq(parsed.mode, 'discover', 'tool query returns discover JSON');
    A.eq(parsed.results[0].sessionId, 's_tool', 'tool surfaces the matching session');
    const noStore = makeRecallTool({}).sessionSearchTool;
    const missing = await noStore.run({ query: 'x' }, {});
    A.ok(/unavailable/i.test(missing.content), 'missing session search store -> graceful unavailable');
  }

  A.report('recall.test');
})();
