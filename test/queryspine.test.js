/* node test/queryspine.test.js — pure contract for the shared frontend JSON query spine. */
'use strict';
const A = require('./_assert.js');
const { QuerySpine: Q } = require('../frontend/app/queryspine.js');

async function rejects(p, label) {
  let failed = false;
  try { await p; } catch (_) { failed = true; }
  A.ok(failed, label);
}

(async () => {
  let clock = 1000;
  Q._setClockForTest(() => clock);
  Q._resetForTest();

  // One key, one wire request: concurrent readers adopt the exact same in-flight promise.
  Q.define('dedupe', { path: '/dedupe', ttlMs: 100 });
  let calls = 0, release;
  Q._setGetForTest(path => {
    calls++;
    A.eq(path, '/dedupe', 'the configured path reaches the JSON getter');
    return new Promise(resolve => { release = resolve; });
  });
  const d1 = Q.refresh('dedupe');
  const d2 = Q.refresh('dedupe');
  A.ok(d1 === d2, 'concurrent reads share one in-flight promise');
  await Promise.resolve();
  A.eq(calls, 1, 'concurrent readers make one request');
  release({ value: 7 });
  const ds = await d1;
  A.eq(ds.data.value, 7, 'the shared request publishes its real payload');

  // TTL serves the last-good value only while it is actually fresh.
  Q.define('ttl', { path: '/ttl', ttlMs: 50 });
  calls = 0;
  Q._setGetForTest(() => Promise.resolve({ value: ++calls }));
  A.eq((await Q.get('ttl')).data.value, 1, 'the first TTL read reaches the wire');
  clock += 49;
  A.eq((await Q.get('ttl')).data.value, 1, 'a fresh TTL read reuses last-good state');
  A.eq(calls, 1, 'the fresh read does not duplicate the request');
  clock += 1;
  A.eq((await Q.get('ttl')).data.value, 2, 'the TTL boundary refreshes from the wire');

  // A failed refresh is not an empty success: reject, retain last-good, expose error metadata.
  Q.define('honesty', { path: '/honesty', ttlMs: 100 });
  Q._setGetForTest(() => Promise.resolve({ rows: ['real'] }));
  await Q.refresh('honesty');
  clock += 1;
  Q._setGetForTest(() => Promise.reject(new Error('offline now')));
  await rejects(Q.refresh('honesty'), 'a failed refresh rejects instead of synthesizing success');
  const honest = Q.state('honesty');
  A.eq(honest.data.rows.join(','), 'real', 'failure retains the last-good payload');
  A.ok(honest.stale && honest.error && honest.error.message === 'offline now' && honest.errorAt === clock,
    'failure publishes explicit stale/error metadata');

  // Invalidation keeps last-good for display but forces the next ordinary read to the wire.
  Q.define('invalidate', { path: '/invalidate', ttlMs: 1000 });
  calls = 0;
  Q._setGetForTest(() => Promise.resolve({ revision: ++calls }));
  await Q.get('invalidate');
  await Q.get('invalidate');
  A.eq(calls, 1, 'a long-TTL resource is cached before invalidation');
  const invalid = Q.invalidate('invalidate');
  A.ok(invalid.stale && invalid.data.revision === 1, 'invalidate marks state stale without erasing last-good');
  A.eq((await Q.get('invalidate')).data.revision, 2, 'the next read after invalidate refreshes');

  // Subscribers jointly own exactly one poll timer; the final unsubscribe tears it down.
  Q.define('poll', { path: '/poll', pollMs: 60, ttlMs: 5 });
  let timerSeq = 0;
  const timers = new Map(), cleared = [];
  Q._setTimersForTest((fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; }, id => { cleared.push(id); timers.delete(id); });
  Q._setGetForTest(() => Promise.resolve({ tick: true }));
  const seen = [];
  const offA = Q.subscribe('poll', s => seen.push(['a', s]), { refresh: false });
  const offB = Q.subscribe('poll', s => seen.push(['b', s]), { refresh: false });
  A.eq(timers.size, 1, 'two subscribers share one poll timer');
  A.eq(Array.from(timers.values())[0].ms, 60, 'the resource owns its configured cadence');
  offA();
  A.eq(timers.size, 1, 'one remaining subscriber keeps the shared timer alive');
  offB();
  A.eq(timers.size, 0, 'the final unsubscribe stops polling');
  A.eq(cleared.length, 1, 'the shared timer is cleared exactly once');
  A.eq(Q._debug('poll').listeners, 0, 'no subscriber ownership leaks after teardown');
  A.ok(seen.length >= 2, 'subscribers receive an immediate state snapshot');

  A.report('queryspine.test');
})().catch(err => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
