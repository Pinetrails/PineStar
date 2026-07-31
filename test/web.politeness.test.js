/* node test/web.politeness.test.js — process-owned per-host request spacing and backoff. */
'use strict';
const A = require('./_assert.js');
const { makeWebTools, makePoliteScheduler } = require('../sidecar/tools/builtin/web.js');

function response(status, body, headers) {
  headers = headers || {};
  return {
    status,
    headers: { get: name => headers[String(name || '').toLowerCase()] || (name === 'content-type' ? 'text/plain' : '') },
    text: async () => body || ''
  };
}

(async () => {
  // Same host is spaced; a different host gets an independent first request.
  {
    const waits = [], calls = [];
    const scheduler = makePoliteScheduler({ minGapMs: 250, wait: async ms => { waits.push(ms); } });
    const web = makeWebTools({
      lookup: null, politeness: scheduler,
      fetchImpl: async url => { calls.push(String(url)); return response(200, 'ok'); }
    });
    await web.webFetch('https://a.example/one');
    await web.webFetch('https://a.example/two');
    await web.webFetch('https://b.example/one');
    A.eq(calls.length, 3, 'all three authorized requests run');
    A.eq(waits, [250], 'only the repeated same-host request is delayed');
    const snap = scheduler.snapshot();
    A.eq(snap.find(x => x.host === 'a.example').requests, 2, 'scheduler measures requests per host');
    A.eq(snap.find(x => x.host === 'b.example').lastDelayMs, 0, 'a different host has an independent bucket');
  }

  // Retry-After delta-seconds is honored but capped; no automatic retry is hidden from the caller.
  {
    const waits = [];
    const scheduler = makePoliteScheduler({ minGapMs: 100, maxBackoffMs: 5000, wait: async ms => { waits.push(ms); } });
    let n = 0;
    const web = makeWebTools({
      lookup: null, politeness: scheduler,
      fetchImpl: async () => ++n === 1 ? response(429, 'slow down', { 'retry-after': '2' }) : response(200, 'recovered')
    });
    let first = '';
    try { await web.webFetch('https://limited.example/a'); } catch (e) { first = e.message; }
    A.eq(first, 'http 429', 'the original 429 remains the truthful result — scheduler does not auto-retry');
    const ok = await web.webFetch('https://limited.example/b');
    A.eq(ok.text, 'recovered', 'a later request may succeed');
    A.eq(waits, [2000], 'the later same-host request honors Retry-After');
    A.eq(scheduler.snapshot()[0].backoffMs, 0, 'a successful response clears the remembered penalty');
  }

  // Repeated refusal without Retry-After backs off exponentially within the configured ceiling.
  {
    const waits = [];
    const scheduler = makePoliteScheduler({ minGapMs: 100, initialBackoffMs: 800, maxBackoffMs: 2000, wait: async ms => { waits.push(ms); } });
    const web = makeWebTools({ lookup: null, politeness: scheduler, fetchImpl: async () => response(403, 'no') });
    for (let i = 0; i < 3; i++) { try { await web.webFetch('https://refuses.example/' + i); } catch (_) {} }
    A.eq(waits, [800, 1600], 'repeated refusal backs off exponentially before later requests');
    A.eq(scheduler.snapshot()[0].backoffMs, 2000, 'remembered backoff is capped at the configured ceiling');
  }

  A.report('web.politeness.test');
})();
