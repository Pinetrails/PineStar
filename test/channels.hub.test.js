/* node test/channels.hub.test.js — the messaging bridge: inbound -> runOnce -> streamed reply (C5).
   Fake runOnce/store/send (no network, no real loop). Covers: reply assembled from agent.token deltas,
   user+assistant persisted, channel.inbound/delivery telemetry, error/capdenied surfacing, long-reply
   chunking, not-configured guard, surface:'autonomous' + task classification, and abort-on-new-message. */
'use strict';
const A = require('./_assert.js');
const { makeChannelHub, chunkText, endNote } = require('../sidecar/channels/hub.js');

function fakeStore() {
  const hist = new Map(), recs = new Map(), appends = [];
  return {
    hist, recs, appends,
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); appends.push({ a, role, content }); return arr; },
    getChatRecord(c) { return recs.get(String(c)); }
  };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };
const dm = (text, chatId) => ({ channel: 'telegram', chatId: chatId || '555', chatType: 'dm', userId: 'u1', text, messageId: '1', ts: 1 });

async function run() {
  // ---- A. happy path: tokens -> reply -> send; user+assistant persisted; inbound/delivery emitted ----
  {
    const sends = [], events = []; const store = fakeStore(); let lastRun = null;
    const runOnce = async (o) => {
      lastRun = o;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'Hello ' });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'Commander' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (chatId, text) => { sends.push({ chatId, text }); return Promise.resolve({ ok: true, messageId: 'm' + (sends.length) }); },
      secrets: () => ({ key: 'k', model: 'anthropic/claude-sonnet-4.6' }), classify: () => false,
      emit: (n, p) => events.push({ n, p }), newId: idGen()
    });
    await hub.onInbound(dm('hi'));
    A.eq(sends, [{ chatId: '555', text: 'Hello Commander' }], 'reply assembled from token deltas, sent once');
    A.eq(store.hist.get('tg_555'), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello Commander' }], 'user + assistant turns persisted');
    A.eq(lastRun.agentId, 'tg_555', 'chatId -> tg_<chatId> agentId');
    A.eq(lastRun.surface, 'autonomous', 'headless chat runs autonomous (no live consent prompt)');
    A.eq(lastRun.messages, [{ role: 'user', content: 'hi' }], 'messages replayed (prior history + new user turn)');
    A.ok(events.some(e => e.n === 'channel.inbound' && e.p.agentId === 'tg_555' && e.p.kind === 'dm'), 'channel.inbound emitted');
    A.ok(events.some(e => e.n === 'channel.delivery' && e.p.ok === true && e.p.chunks === 1 && e.p.reason === 'done'), 'channel.delivery ok=true');
  }

  // ---- B. prior history is replayed; isTask=true adds the task suffix to the system prompt ----
  {
    const store = fakeStore(); store.hist.set('tg_9', [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'sure' }]);
    let lastRun = null;
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({ runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen() });
    await hub.onInbound(dm('research foo', '9'));
    A.eq(lastRun.isTask, true, 'classify -> isTask');
    A.ok(/task/i.test(lastRun.system), 'task suffix added to system when isTask');
    A.eq(lastRun.messages.length, 3, 'history (2) + new user turn replayed');
    A.eq(lastRun.messages[2], { role: 'user', content: 'research foo' }, 'newest user turn last');
  }

  // ---- B2. configured agentId + system: runs as the SAME app agent (shared memory) with its real prompt ----
  {
    const store = fakeStore(); let lastRun = null; const sends = [];
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'hi' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push({ c, t }); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm', agentId: 'agent', system: 'You are ULTRON, the Commander\'s agent.' }), classify: () => false, newId: idGen() });
    await hub.onInbound(dm('hey'));
    A.eq(lastRun.agentId, 'agent', 'configured agentId used verbatim (same as the app -> shared notebook/memory/workspace)');
    A.ok(lastRun.system.indexOf('You are ULTRON, the Commander\'s agent.') === 0, 'the REAL composed system prompt is used, not the default persona');
    A.eq((store.hist.get('agent') || []).length, 2, 'history stored under the shared agentId');
    A.eq(store.hist.has('tg_555'), false, 'did NOT create a separate tg_<chatId> agent');
  }

  // ---- B3. Codex OAuth config: no API key is required, but provider must reach runOnce ----
  {
    const store = fakeStore(); let lastRun = null; const sends = [];
    const runOnce = async (o) => {
      lastRun = o;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'codex-ok' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
      secrets: () => ({ provider: 'codex', model: 'gpt-5.3-codex', agentId: 'agent' }),
      classify: () => false, newId: idGen()
    });
    await hub.onInbound(dm('hi'));
    A.eq(sends, ['codex-ok'], 'Codex Telegram config runs without an API key');
    A.eq(lastRun.provider, 'codex', 'provider=codex passed into runOnce');
    A.eq(lastRun.key, '', 'Codex run does not receive an API key placeholder');
  }

  // ---- C. error / capdenied surfaced; assistant turn NOT persisted on error ----
  {
    const store = fakeStore(); const sends = [];
    const runOnce = async (o) => { o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.run.error', { agentId: o.agentId, runId: o.runId, message: 'boom', transient: false }); };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    await hub.onInbound(dm('hi'));
    A.eq(sends, ['⚠ boom'], 'run error surfaced to the chat');
    A.eq((store.hist.get('tg_555') || []).filter(m => m.role === 'assistant').length, 0, 'no assistant turn persisted on error');
  }

  // ---- D. endReason != done appends a note ----
  {
    const store = fakeStore(); const sends = [];
    const runOnce = async (o) => { o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'partial' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'max_iters', turns: 16, usd: 0.1 }); };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => true, newId: idGen() });
    await hub.onInbound(dm('do it'));
    A.ok(/partial/.test(sends[0]) && /continue/.test(sends[0]), 'max_iters reply carries the partial + a continue hint');
  }

  // ---- E. long reply chunked to maxMessageLength; channel.delivery.chunks reflects it ----
  {
    const store = fakeStore(); const sends = [], events = [];
    const big = 'wordone wordtwo wordthree wordfour wordfive wordsix';   // 50 chars, spaces to break on
    const runOnce = async (o) => { o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: big }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({ runOnce, store, maxMessageLength: 20, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, emit: (n, p) => events.push({ n, p }), newId: idGen() });
    await hub.onInbound(dm('hi'));
    A.ok(sends.length >= 3, 'reply split into multiple <=20-char messages');
    A.ok(sends.every(s => s.length <= 20), 'every chunk within the length limit');
    A.eq(sends.join(''), big, 'chunks concatenate back to the full reply (no chars lost at breaks)');
    const del = events.find(e => e.n === 'channel.delivery');
    A.eq(del.p.chunks, sends.length, 'delivery chunk count matches');
  }

  // ---- F. not configured (no key/model) -> friendly connect message; runOnce NOT called ----
  {
    const store = fakeStore(); const sends = []; let ran = false;
    const hub = makeChannelHub({ runOnce: async () => { ran = true; }, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({}), classify: () => false, newId: idGen() });
    await hub.onInbound(dm('hi'));
    A.eq(ran, false, 'runOnce not called when unconfigured');
    A.ok(/Messaging tab/.test(sends[0]), 'tells the user to connect in the app');
  }

  // ---- G. one run per chat: a new message ABORTS the in-flight run; only the latest is answered ----
  {
    const store = fakeStore(); const sends = []; let call = 0;
    const runOnce = async (o) => {
      call++;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      if (call === 1) {   // first run parks until aborted by the second message
        await new Promise(res => { if (o.signal.aborted) return res(); o.signal.addEventListener('abort', () => res(), { once: true }); });
        o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'cancelled', turns: 0, usd: 0 });
        return;
      }
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'second-reply' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    const p1 = hub.onInbound(dm('first'));   // parks
    await hub.onInbound(dm('second'));         // aborts the first, runs + delivers
    await p1;                                  // first unwinds: superseded -> no delivery
    A.eq(sends, ['second-reply'], 'only the latest message is answered (first run superseded, no partial sent)');
  }

  // ---- H. onStatus -> channel.connect; pure helpers ----
  {
    const events = [];
    const hub = makeChannelHub({ runOnce: async () => {}, store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), emit: (n, p) => events.push({ n, p }), newId: idGen() });
    hub.onStatus({ state: 'up' });
    hub.onStatus({ state: 'error', detail: '401' });
    A.ok(events.some(e => e.n === 'channel.connect' && e.p.state === 'up'), 'status up -> channel.connect up');
    A.ok(events.some(e => e.n === 'channel.connect' && e.p.state === 'error' && e.p.detail === '401'), 'status error surfaced');
    A.eq(chunkText('abc', 10), ['abc'], 'short text -> single chunk');
    A.eq(chunkText('', 10), [], 'empty text -> no chunks');
    A.ok(endNote('max_iters').indexOf('continue') !== -1, 'endNote(max_iters) hints continue');
    A.eq(endNote('done'), endNote('done'), 'endNote deterministic');
  }

  // ---- I. construction guards ----
  {
    A.throws(() => makeChannelHub({ store: fakeStore(), send: () => {} }), 'missing runOnce throws');
    A.throws(() => makeChannelHub({ runOnce: async () => {}, send: () => {} }), 'missing store throws');
    A.throws(() => makeChannelHub({ runOnce: async () => {}, store: fakeStore() }), 'missing send throws');
  }

  // ---- J. Phase B routing: resolveAgent picks the agent; getTag threads the tag; null falls back ----
  {
    const store = fakeStore(); let lastRun = null; const tags = [];
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      getTag: (text) => { tags.push(text); return /code/.test(text) ? 'code' : 'general'; },
      resolveAgent: (ctx) => ctx.tag === 'code' ? 'coder' : null
    });
    await hub.onInbound(dm('write code please'));
    A.eq(lastRun.agentId, 'coder', 'a routed message fires the bay-bound agent (not tg_<chatId>)');
    A.eq(tags[0], 'write code please', 'getTag receives the message text (the FILTER routing key)');
    A.eq((store.hist.get('coder') || []).length, 2, 'transcript stored under the routed agent');
    await hub.onInbound(dm('just chatting', '777'));
    A.eq(lastRun.agentId, 'tg_777', 'resolveAgent -> null falls back to tg_<chatId> (real work never stalls)');
  }

  // ---- K. two chats routed to the SAME agent do NOT cross-cancel (supersede keyed by chatId, not agentId) ----
  {
    const store = fakeStore(); const sends = []; const parks = {};
    const runOnce = async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      await new Promise(res => { parks[o.runId] = res; if (o.signal.aborted) res(); o.signal.addEventListener('abort', () => res(), { once: true }); });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'reply' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const hub = makeChannelHub({
      runOnce, store, send: (c, t) => { sends.push({ c, t }); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(), resolveAgent: () => 'shared'
    });
    const pa = hub.onInbound(dm('from-A', 'A'));   // chat A -> agent 'shared'
    const pb = hub.onInbound(dm('from-B', 'B'));   // chat B -> the SAME agent 'shared'
    for (const id in parks) parks[id]();           // release both in-flight runs
    await Promise.all([pa, pb]);
    A.eq(sends.length, 2, 'both chats got a reply — neither superseded the other despite sharing an agent');
    A.ok(sends.some(s => s.c === 'A') && sends.some(s => s.c === 'B'), 'each reply went back to its own chat');
  }

  A.report('channels.hub.test');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
