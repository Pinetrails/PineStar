/* node test/channels.outbox.test.js — the durable outbound-retry seam (store outbox + hub queue/flush).
   Proves: a FAILED reply is queued (only the undelivered remainder, never a /command reply), the queue is
   bounded + survives via the same atomic store, an adapter 'up' status redelivers it, a mid-session healthy
   send drains the backlog, and a hopeless item drops with an honest event only after MAX_OUTBOX_TRIES. */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

function memFs() {
  const files = new Map();
  return {
    files,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; } files.set(b, files.get(a)); files.delete(a); },
    mkdirSync() {}
  };
}

let clk = 1000;
const clock = { now: () => clk };
const ROOT = '/ws/channels';
const mkStore = (fs, outboxLimits) => makeChannelStore({ fs: fs || memFs(), pathMod, root: ROOT, clock, outboxLimits });

// a hub over a controllable send + real store; runOnce streams one token so a real reply exists.
function mkHub(store, sendImpl, events) {
  return makeChannelHub({
    channel: 'telegram',
    runOnce: async (o) => { o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'the result' }); o.emit('agent.run.end', { reason: 'done' }); },
    store,
    send: sendImpl,
    secrets: () => ({ key: 'k', model: 'm', configured: true }),
    emit: (name, payload) => events.push([name, payload]),
    newId: (() => { let n = 0; return () => 'run-' + (++n); })(),
    sleep: () => Promise.resolve()
  });
}

(async () => {
  // ---- A. store outbox CRUD: push/load/remove/bump round-trip; missing/corrupt -> [] ----
  {
    const s = mkStore();
    A.eq(s.loadOutbox(), [], 'missing outbox -> []');
    clk = 2000;
    const it = s.pushOutbox({ channel: 'telegram', chatId: '77', text: 'queued reply', runId: 'r1', agentId: 'ag', reason: 'done' });
    A.ok(it.id && it.tries === 0 && it.ts === 2000, 'pushed item is stamped from the injected clock');
    A.eq(s.loadOutbox('telegram').length, 1, 'loadOutbox(channel) finds it');
    A.eq(s.loadOutbox('discord'), [], 'another channel sees nothing');
    const b = s.bumpOutboxTry(it.id);
    A.eq(b.tries, 1, 'bump counts a failed attempt');
    A.eq(s.loadOutbox()[0].tries, 1, 'the bump persisted');
    A.eq(s.removeOutbox(it.id), true, 'remove drops it');
    A.eq(s.loadOutbox(), [], 'outbox empty after remove');
    A.eq(s.removeOutbox('nope'), false, 'removing a missing id is a safe no-op');
  }

  // ---- B. bounds: oldest drops past maxOutbox; oversized text is truncated, never unbounded ----
  {
    const s = mkStore(memFs(), { maxOutbox: 3, maxOutboxChars: 20 });
    for (let i = 1; i <= 5; i++) s.pushOutbox({ channel: 'telegram', chatId: String(i), text: 't' + i });
    const items = s.loadOutbox();
    A.eq(items.length, 3, 'outbox is bounded');
    A.eq(items.map(x => x.chatId), ['3', '4', '5'], 'oldest undelivered dropped first');
    const big = s.pushOutbox({ channel: 'telegram', chatId: '9', text: 'x'.repeat(100) });
    A.ok(big.text.length < 100 && /truncated/.test(big.text), 'oversized reply is truncated with an honest marker');
  }

  // ---- C. hub queues ONLY the undelivered remainder of a failed reply ----
  {
    const events = [];
    const store = mkStore();
    // chunk limit 12 → 'the result' fits one chunk; make send fail
    let sendOk = false;
    const hub = mkHub(store, async () => (sendOk ? { ok: true } : { ok: false, error: 'net down' }), events);
    await hub.onInbound({ chatId: '55', chatType: 'dm', userId: 'u1', text: 'do the thing', messageId: 'm1', ts: 1 });
    const q = store.loadOutbox('telegram');
    A.eq(q.length, 1, 'the failed reply was queued');
    A.ok(/the result/.test(q[0].text), 'queued text carries the undelivered reply');
    A.ok(/delayed reply/.test(q[0].text), 'queued text is marked as delayed (honesty when it lands late)');
    A.eq(q[0].chatId, '55', 'queued under the right chat');
    const del = events.filter(e => e[0] === 'channel.delivery');
    A.eq(del.length, 1, 'the original failure still emitted its delivery event');
    A.eq(del[0][1].ok, false, '…as ok:false (no lie)');

    // ---- D. the adapter's next 'up' status redelivers it ----
    sendOk = true;
    hub.onStatus({ state: 'up' });
    await new Promise(r => setTimeout(r, 0));
    A.eq(store.loadOutbox('telegram'), [], 'outbox drained on the up status');
    const redeliver = events.filter(e => e[0] === 'channel.delivery' && e[1].reason === 'redelivered');
    A.eq(redeliver.length, 1, 'redelivery emitted an honest ok:true event');
    A.eq(redeliver[0][1].chatId, '55', 'redelivered to the right chat');
  }

  // ---- E. a successful NEW delivery also drains the backlog (mid-session failure, status never dropped) ----
  {
    const events = [];
    const store = mkStore();
    store.pushOutbox({ channel: 'telegram', chatId: '88', text: 'stranded earlier', runId: 'r0' });
    const hub = mkHub(store, async () => ({ ok: true }), events);
    await hub.onInbound({ chatId: '99', chatType: 'dm', userId: 'u1', text: 'hi again', messageId: 'm2', ts: 2 });
    await new Promise(r => setTimeout(r, 0));
    A.eq(store.loadOutbox('telegram'), [], 'backlog drained after a healthy send');
    A.ok(events.some(e => e[0] === 'channel.delivery' && e[1].reason === 'redelivered' && e[1].chatId === '88'), 'the stranded reply reached its chat');
  }

  // ---- F. /command replies are never queued (ephemeral by design) ----
  {
    const events = [];
    const store = mkStore();
    const hub = mkHub(store, async () => ({ ok: false, error: 'down' }), events);
    await hub.onInbound({ chatId: '11', chatType: 'dm', userId: 'u1', text: '/help', messageId: 'm3', ts: 3 });
    A.eq(store.loadOutbox('telegram'), [], 'a failed /command reply is not queued');
  }

  // ---- G. give-up honesty: after MAX_OUTBOX_TRIES failed flushes the item drops with an ok:false event ----
  {
    const events = [];
    const store = mkStore();
    store.pushOutbox({ channel: 'telegram', chatId: '13', text: 'doomed', runId: 'rX' });
    const hub = mkHub(store, async () => ({ ok: false, error: 'still down' }), events);
    const tries = hub._internals.MAX_OUTBOX_TRIES;
    for (let i = 0; i < tries; i++) await hub._internals.flushOutbox();
    A.eq(store.loadOutbox('telegram'), [], 'the hopeless item was dropped after ' + tries + ' attempts');
    const gaveUp = events.filter(e => e[0] === 'channel.delivery' && e[1].reason === 'redelivery-gave-up');
    A.eq(gaveUp.length, 1, 'the drop emitted one honest gave-up event');
    A.eq(gaveUp[0][1].ok, false, '…as ok:false');
  }

  A.report('channels.outbox.test');
})().catch(e => { console.error(e); process.exit(1); });
