/* sidecar/reviewqueue.js - bounded background review worker.
   No model logic here: the caller injects worker(job). This module owns queueing, timeout, stats, and drain. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.reviewqueue = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makeReviewQueue(opts) {
    opts = opts || {};
    const worker = opts.worker;
    const maxQueued = opts.maxQueued || 32;
    const timeoutMs = opts.timeoutMs || 30000;
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    const queue = [];
    const waiters = [];
    const stats = { queued: 0, started: 0, completed: 0, dropped: 0, errors: 0, timedOut: 0, usd: 0, tokens: 0 };
    let running = false;

    function snapshot() { return Object.assign({ depth: queue.length, running: running }, stats); }
    function finishWaiters() {
      if (running || queue.length) return;
      while (waiters.length) waiters.shift()(snapshot());
    }
    function withTimeout(p, ms) {
      if (!ms || ms <= 0) return Promise.resolve(p);
      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; const e = new Error('review timed out'); e.code = 'REVIEW_TIMEOUT'; reject(e); } }, ms);
        Promise.resolve(p).then(
          v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
          e => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
        );
      });
    }
    async function pump() {
      if (running) return;
      running = true;
      while (queue.length) {
        const job = queue.shift();
        stats.started++;
        onEvent('start', job, snapshot());
        try {
          if (typeof worker !== 'function') throw new Error('review worker unavailable');
          const r = await withTimeout(worker(job), job.timeoutMs || timeoutMs);
          stats.completed++;
          stats.usd += (r && Number(r.usd)) || 0;
          stats.tokens += (r && Number(r.tokens)) || 0;
          onEvent('complete', Object.assign({}, job, { result: r || {} }), snapshot());
        } catch (e) {
          if (e && e.code === 'REVIEW_TIMEOUT') stats.timedOut++;
          else stats.errors++;
          onEvent('error', Object.assign({}, job, { error: (e && e.message) || String(e) }), snapshot());
        }
      }
      running = false;
      finishWaiters();
    }
    function enqueue(job) {
      job = Object.assign({}, job || {});
      if (!job.runId) return { queued: false, error: 'runId required', queueDepth: queue.length };
      if (queue.length >= maxQueued) {
        const dropped = queue.shift();
        stats.dropped++;
        onEvent('drop', dropped, snapshot());
      }
      queue.push(job);
      stats.queued++;
      const depth = queue.length;
      pump();
      return { queued: true, queueDepth: depth };
    }
    function drain() {
      if (!running && !queue.length) return Promise.resolve(snapshot());
      return new Promise(resolve => waiters.push(resolve));
    }
    return { enqueue, drain, stats: snapshot };
  }

  return { makeReviewQueue };
});
