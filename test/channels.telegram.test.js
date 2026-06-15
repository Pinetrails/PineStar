/* node test/channels.telegram.test.js — Telegram concrete adapter + Bot API fetch transport (C2).
   An injected FAKE fetch drives everything; no real network. Covers: getUpdates URL/body + result parsing,
   401 -> fatal throw, network throw -> non-fatal; sendMessage URL/body + message_id mapping, 429/5xx retryable,
   4xx not-retryable, network/abort never-throws-returns-SendResult; the pure normalize() truth table; and an
   end-to-end connect() -> onInbound through the real transport+normalize+generic adapter. Deterministic. */
'use strict';
const A = require('./_assert.js');
const { makeTelegramTransport, ALLOWED_UPDATES } = require('../sidecar/channels/telegram.transport.js');
const { makeTelegramAdapter, normalize, MAX_MESSAGE_LENGTH } = require('../sidecar/channels/telegram.js');

const tick = () => new Promise(r => setTimeout(r, 0));
const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

// fake fetch: handler(url, opts, callNo) -> a resp(); or { __throw: err } to throw; or { __park:true } to
// park until opts.signal aborts (mimics a quiet long-poll). Records every call's url + parsed body.
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts, body: (opts && opts.body) ? JSON.parse(opts.body) : undefined });
    const r = handler(url, opts, calls.length);
    if (r && r.__throw) throw r.__throw;
    if (r && r.__park) return new Promise((resolve, reject) => {
      const sig = opts && opts.signal;
      if (sig && sig.aborted) return reject(abortErr());
      sig && sig.addEventListener('abort', () => reject(abortErr()), { once: true });
    });
    return r;
  };
  f.calls = calls;
  return f;
}

async function run() {
  // ---- A. getUpdates: URL carries the token, body carries offset/timeout/allowed_updates, result parsed ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: [{ update_id: 7, message: { message_id: 1, text: 'hi', chat: { id: 1, type: 'private' }, from: { id: 2 } } }] }));
    const t = makeTelegramTransport({ fetch: f, token: 'TKN' });
    const ups = await t.getUpdates({ offset: 5, timeoutSec: 50 });
    A.eq(ups.length, 1, 'getUpdates returns the raw Update[]');
    A.eq(f.calls[0].url, 'https://api.telegram.org/botTKN/getUpdates', 'getUpdates URL embeds the token in the path');
    A.eq(f.calls[0].body, { offset: 5, timeout: 50, allowed_updates: ALLOWED_UPDATES }, 'getUpdates body');
    A.eq(f.calls[0].opts.method, 'POST', 'POST');
  }

  // ---- B. getUpdates: 401 -> fatal throw (stops the loop); 5xx -> non-fatal throw (loop backs off) ----
  {
    const t401 = makeTelegramTransport({ fetch: fakeFetch(() => resp(401, { ok: false, error_code: 401, description: 'Unauthorized' })), token: 'BAD' });
    let e = null; try { await t401.getUpdates({ offset: 0 }); } catch (x) { e = x; }
    A.ok(e && e.fatal === true, '401 -> fatal throw');
    const t500 = makeTelegramTransport({ fetch: fakeFetch(() => resp(500, { ok: false, error_code: 500, description: 'Internal' })), token: 'TKN' });
    e = null; try { await t500.getUpdates({ offset: 0 }); } catch (x) { e = x; }
    A.ok(e && !e.fatal, '500 -> throws but NOT fatal (transient, loop will back off)');
    // 409 (another poller / stale webhook) -> fatal with an actionable message (don't loop forever)
    const t409 = makeTelegramTransport({ fetch: fakeFetch(() => resp(409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' })), token: 'TKN' });
    e = null; try { await t409.getUpdates({ offset: 0 }); } catch (x) { e = x; }
    A.ok(e && e.fatal === true && /another instance|webhook/i.test(e.message), '409 -> fatal with actionable detail');
  }

  // ---- B5. deleteWebhook posts the right method and never throws ----
  {
    const fdw = fakeFetch(() => resp(200, { ok: true, result: true }));
    const tdw = makeTelegramTransport({ fetch: fdw, token: 'TKN' });
    await tdw.deleteWebhook();
    A.eq(fdw.calls[0].url, 'https://api.telegram.org/botTKN/deleteWebhook', 'deleteWebhook hits the right method');
    A.eq(fdw.calls[0].body, { drop_pending_updates: false }, 'deleteWebhook body keeps pending (drop is handled by the offset prime)');
    const tdw2 = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: new Error('net down') })), token: 'TKN' });
    await tdw2.deleteWebhook();   // must NOT throw
    A.ok(true, 'deleteWebhook swallows transport errors');
  }

  // ---- C. getUpdates: a network throw propagates (non-fatal) so the loop backs off ----
  {
    const t = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: new Error('ECONNRESET') })), token: 'TKN' });
    let e = null; try { await t.getUpdates({ offset: 0 }); } catch (x) { e = x; }
    A.ok(e && /ECONNRESET/.test(e.message) && !e.fatal, 'network error propagates, not fatal');
  }

  // ---- D. send: URL/body correct, message_id mapped, `signal` stripped from the wire body ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: { message_id: 42 } }));
    const t = makeTelegramTransport({ fetch: f, token: 'TKN' });
    const r = await t.send('c1', 'hi', { parse_mode: 'HTML', signal: {} });
    A.eq(r, { ok: true, messageId: '42' }, 'send maps result.message_id -> string SendResult');
    A.eq(f.calls[0].url, 'https://api.telegram.org/botTKN/sendMessage', 'send URL');
    A.eq(f.calls[0].body, { chat_id: 'c1', text: 'hi', parse_mode: 'HTML' }, 'send body includes opts EXCEPT signal');
  }

  // ---- E. send error mapping: 429/5xx retryable (+retryAfter), 4xx not; never throws on network/abort ----
  {
    const t429 = makeTelegramTransport({ fetch: fakeFetch(() => resp(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } })), token: 'TKN' });
    const r429 = await t429.send('c', 'x');
    A.eq(r429.ok, false, '429 -> not ok'); A.eq(r429.retryable, true, '429 retryable'); A.eq(r429.retryAfter, 3, 'retry_after surfaced');

    const t400 = makeTelegramTransport({ fetch: fakeFetch(() => resp(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })), token: 'TKN' });
    const r400 = await t400.send('c', 'x');
    A.eq(r400.retryable, false, '400 -> not retryable');

    const tNet = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: new Error('socket hang up') })), token: 'TKN' });
    const rNet = await tNet.send('c', 'x');
    A.eq(rNet, { ok: false, error: 'socket hang up', retryable: true }, 'network throw -> retryable SendResult (never throws)');

    const tAb = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: abortErr() })), token: 'TKN' });
    const rAb = await tAb.send('c', 'x');
    A.eq(rAb.retryable, false, 'abort -> not retryable');
  }

  // ---- F. normalize() truth table (pure; no transport) ----
  {
    A.eq(MAX_MESSAGE_LENGTH, 4096, 'Telegram MAX_MESSAGE_LENGTH = 4096');
    A.eq(normalize({ update_id: 1, message: { message_id: 9, text: 'hi', chat: { id: 111, type: 'private' }, from: { id: 5, username: 'andro' } } }),
      { offset: 1, message: { chatId: 111, chatType: 'dm', userId: 5, userName: 'andro', text: 'hi', messageId: 9 } }, 'private chat -> dm');
    A.eq(normalize({ update_id: 2, message: { message_id: 10, text: 'yo', chat: { id: -200, type: 'supergroup' }, from: { id: 6, first_name: 'X' } } }).message.chatType, 'group', 'supergroup -> group');
    A.eq(normalize({ update_id: 2, message: { message_id: 10, text: 'yo', chat: { id: -200, type: 'supergroup' }, from: { id: 6, first_name: 'X' } } }).message.userName, 'X', 'falls back to first_name when no username');
    A.eq(normalize({ update_id: 3, callback_query: { id: 'q1', data: 'approve:p1', from: { id: 7 }, message: { message_id: 11, chat: { id: 111 } } } }),
      { offset: 3, callback: { chatId: 111, userId: 7, data: 'approve:p1', callbackId: 'q1', messageId: 11 } }, 'callback_query -> callback');
    A.eq(normalize({ update_id: 4, message: { message_id: 12, chat: { id: 111, type: 'private' }, sticker: {} } }), { offset: 4, message: null }, 'non-text message -> message:null (offset still advances)');
    A.eq(normalize({ foo: 1 }), null, 'no update_id -> null (skipped, no offset advance)');
  }

  const getUpdatesCalls = (f) => f.calls.filter(c => c.url.indexOf('/getUpdates') !== -1);

  // ---- G. end-to-end: connect() polls via the real transport+normalize+generic adapter -> onInbound fires ----
  {
    const inbox = [];
    let gu = 0;   // count getUpdates calls specifically (connect also fires deleteWebhook, so total-call index is unreliable)
    const f = fakeFetch((url) => {
      if (url.indexOf('/getUpdates') !== -1) {
        gu++;
        if (gu === 1) return resp(200, { ok: true, result: [{ update_id: 50, message: { message_id: 1, text: 'ping', chat: { id: 999, type: 'private' }, from: { id: 1, username: 'a' } } }] });
        return { __park: true };   // subsequent polls park (abort-aware) so the test's timers aren't starved
      }
      return resp(200, { ok: true, result: { message_id: 1 } });   // deleteWebhook / sendMessage
    });
    // drop-pending OFF here so the first poll IS the delivery (this case tests basic end-to-end, not backlog).
    const a = makeTelegramAdapter({ fetch: f, token: 'TKN', dropPendingOnConnect: false, onInbound: m => inbox.push(m), clock: { now: () => 1234 }, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8 && !inbox.length; i++) await tick();
    A.eq(inbox.length, 1, 'end-to-end: one inbound delivered');
    A.eq(inbox[0], { channel: 'telegram', chatId: '999', chatType: 'dm', userId: '1', userName: 'a', text: 'ping', messageId: '1', ts: 1234 }, 'normalized InboundMessage via the real pipeline');
    const gus = getUpdatesCalls(f);
    A.ok(gus[1] && gus[1].body.offset === 51, 'second getUpdates confirmed offset 50+1 (each update fetched once)');
    await a.disconnect();
  }

  // ---- H. drop-pending is ON by default for Telegram: connect primes offset:-1 and discards the backlog ----
  {
    const inbox = [];
    let gu = 0;
    const f = fakeFetch((url) => {
      if (url.indexOf('/getUpdates') !== -1) {
        gu++;
        if (gu === 1) return resp(200, { ok: true, result: [{ update_id: 70, message: { message_id: 1, text: 'STALE', chat: { id: 5, type: 'private' }, from: { id: 9 } } }] });   // prime -> dropped
        if (gu === 2) return resp(200, { ok: true, result: [{ update_id: 71, message: { message_id: 2, text: 'fresh', chat: { id: 5, type: 'private' }, from: { id: 9 } } }] });   // real -> delivered
        return { __park: true };
      }
      return resp(200, { ok: true, result: { message_id: 1 } });
    });
    const a = makeTelegramAdapter({ fetch: f, token: 'TKN', onInbound: m => inbox.push(m), clock: { now: () => 1 }, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8 && !inbox.length; i++) await tick();
    A.eq(inbox.map(m => m.text), ['fresh'], 'Telegram default discards the offline backlog, delivers only fresh');
    A.eq(getUpdatesCalls(f)[0].body.offset, -1, 'prime getUpdates used offset -1');
    await a.disconnect();
  }

  A.report('channels.telegram.test');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
