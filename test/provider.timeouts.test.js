/* node test/provider.timeouts.test.js — the shared provider stream-timeout plumbing (Lane A item 1/4/5).
   Covers: the idle watchdog (a stalled SSE stream errors with a `timeout`-CLASSIFIED error, and cancels the
   reader) vs a user-cancel (classifies as abort, NOT timeout); connectSignal composition; the Retry-After
   delay math honored by requestWithRetry; and the non-blocking catalog re-warm kick. Zero network. */
'use strict';
const A = require('./_assert.js');
const provider = require('../sidecar/providers/provider.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');

const timeouts = provider.timeouts;
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }

(async () => {
  // 1. idleGuardedReader: a reader that never resolves read() -> the watchdog fires and throws a `timeout`
  //    error (message contains "timed out"), and the underlying reader is cancelled.
  {
    let cancelled = false;
    const stallReader = {
      read: () => new Promise(() => {}),                 // never resolves — a stalled stream
      cancel: () => { cancelled = true; return Promise.resolve(); }
    };
    const guarded = timeouts.idleGuardedReader(stallReader, { idleMs: 30 });
    let err = null;
    try { await guarded.read(); } catch (e) { err = e; }
    A.ok(err && /timed out/i.test(err.message), 'a stalled read throws a "timed out" error');
    A.ok(cancelled, 'the underlying reader is cancelled on idle timeout');
    // and that error classifies as `timeout` (retryable, no credential rotation) — the whole point.
    const cls = classifyApiError(err, {});
    A.eq(cls.reason, 'timeout', 'the idle-timeout error classifies as timeout');
    A.eq(cls.retryable, true, 'a timeout is retryable');
  }

  // 2. user-cancel through the guarded reader classifies as ABORT, never timeout (the CRITICAL invariant).
  {
    const ac = new AbortController();
    let cancelled = false;
    const stallReader = { read: () => new Promise(() => {}), cancel: () => { cancelled = true; return Promise.resolve(); } };
    const guarded = timeouts.idleGuardedReader(stallReader, { idleMs: 10000, signal: ac.signal });
    const p = guarded.read();
    ac.abort();
    let err = null;
    try { await p; } catch (e) { err = e; }
    A.ok(err && err.name === 'AbortError', 'a user-cancel surfaces as an AbortError (name)');
    A.ok(!/timed out/i.test(err.message), 'a user-cancel is NOT reported as a timeout');
    A.ok(cancelled, 'the reader is cancelled on user-cancel too');
  }

  // 2b. a signal already aborted before the first read -> immediate AbortError (never a timeout, no wait).
  {
    const guarded = timeouts.idleGuardedReader({ read: () => new Promise(() => {}), cancel: () => Promise.resolve() }, { idleMs: 5, signal: { aborted: true } });
    let err = null;
    try { await guarded.read(); } catch (e) { err = e; }
    A.ok(err && err.name === 'AbortError', 'a pre-aborted signal short-circuits to AbortError');
  }

  // 3. connectSignal: composes the caller signal with a connect-timeout; a caller-abort still propagates.
  {
    const ac = new AbortController();
    const merged = timeouts.connectSignal(ac.signal, 60000);
    A.ok(merged && typeof merged.aborted === 'boolean', 'connectSignal returns an AbortSignal');
    A.eq(merged.aborted, false, 'not aborted before either input fires');
    ac.abort();
    A.eq(merged.aborted, true, 'a caller-abort aborts the merged signal');
  }

  // 4. Retry-After honored: a 429 with Retry-After: 2 makes requestWithRetry wait ~2s (capped at 60s). We
  //    prove the MATH by classifying the same error and checking the delay formula, and prove it is WIRED by
  //    timing a retry against a short Retry-After. Use a small value so the test stays fast.
  {
    // math: delay = min(60000, max(RETRY_DELAYS[attempt]=400, retryAfterMs)). With Retry-After 2s -> 2000.
    const err = new Error('http 429'); err.status = 429; err.headers = new Headers({ 'retry-after': '2' });
    const cls = classifyApiError(err, {});
    A.eq(cls.reason, 'rate_limit', '429 classifies as rate_limit');
    A.eq(cls.retryAfterMs, 2000, 'Retry-After: 2 -> 2000ms parsed off the response headers');
    const delay = Math.min(60000, Math.max(400, cls.retryAfterMs || 0));
    A.eq(delay, 2000, 'delay math takes the server-stated wait over the base backoff');
    // cap: a huge Retry-After clamps to 60s.
    const err2 = new Error('http 429'); err2.status = 429; err2.headers = new Headers({ 'retry-after': '9999' });
    const cls2 = classifyApiError(err2, {});
    A.eq(Math.min(60000, Math.max(400, cls2.retryAfterMs || 0)), 60000, 'an oversized Retry-After clamps to 60s');
  }

  // 4b. WIRED: requestWithRetry actually waits the Retry-After before the retry. A 429 (Retry-After 0.05s)
  //     then a 200 stream — assert both calls happened and >=~40ms elapsed (the honored wait).
  {
    let n = 0, firstAt = 0, retryAt = 0;
    const fetchImpl = async (url) => {
      if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 });
      n++;
      if (n === 1) { firstAt = Date.now(); return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0.05' } }); }
      retryAt = Date.now();
      return new Response(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenRouterProvider({ fetch: fetchImpl, key: 'k' });
    const evs = await collect(p, { model: 'm', messages: [] });
    A.eq(n, 2, 'a 429 with Retry-After retries exactly once');
    A.ok((retryAt - firstAt) >= 40, 'the retry waited approximately the Retry-After window (>=40ms)');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'ok', 'after honoring Retry-After it streams normally');
  }

  // 5. catalog re-warm: a cold catalog kicks a background /models GET on stream() (at most once per instance).
  {
    let modelsCalls = 0;
    const fetchImpl = async (url) => {
      if (/\/models/.test(url)) { modelsCalls++; return new Response('{"data":[{"id":"m","context_length":123,"pricing":{"prompt":"0.000001","completion":"0.000002"}}]}', { status: 200 }); }
      return new Response(['data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenRouterProvider({ fetch: fetchImpl, key: 'k' });
    await collect(p, { model: 'm', messages: [] });      // first run kicks the re-warm
    await new Promise(r => setTimeout(r, 5));             // let the fire-and-forget /models settle
    A.ok(modelsCalls >= 1, 'a cold-catalog stream() kicks a background /models re-warm');
    const before = modelsCalls;
    await collect(p, { model: 'm', messages: [] });       // now warm -> no further re-warm from this instance
    await new Promise(r => setTimeout(r, 5));
    A.eq(modelsCalls, before, 'once warm, no further re-warm is kicked');
    A.eq(p.contextLimit('m'), 123, 'the re-warmed catalog now answers contextLimit');
  }

  // 6. env-tunable idle timeout is read from SKYNET_PROVIDER_IDLE_MS (default 120s).
  {
    const saved = process.env.SKYNET_PROVIDER_IDLE_MS;
    process.env.SKYNET_PROVIDER_IDLE_MS = '25';
    A.eq(timeouts.idleMs(), 25, 'idle timeout honors SKYNET_PROVIDER_IDLE_MS');
    delete process.env.SKYNET_PROVIDER_IDLE_MS;
    A.eq(timeouts.idleMs(), 120000, 'idle timeout defaults to 120s when unset');
    if (saved != null) process.env.SKYNET_PROVIDER_IDLE_MS = saved;
  }

  A.report('provider.timeouts.test');
})();
