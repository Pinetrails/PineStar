/* node test/reviewqueue.test.js - bounded background review worker. */
'use strict';

const A = require('./_assert.js');
const { makeReviewQueue } = require('../sidecar/reviewqueue.js');

(async () => {
  // ---- sequential worker + drain + spend stats ----
  {
    const order = [];
    const q = makeReviewQueue({
      worker: async job => { order.push(job.runId); return { usd: job.usd || 0, tokens: job.tokens || 0 }; }
    });
    A.eq(q.enqueue({ runId: 'r1', usd: 0.1, tokens: 10 }).queued, true, 'first job queued');
    A.eq(q.enqueue({ runId: 'r2', usd: 0.2, tokens: 20 }).queued, true, 'second job queued');
    const s = await q.drain();
    A.eq(order, ['r1', 'r2'], 'jobs run in enqueue order');
    A.eq(s.completed, 2, 'completed count');
    A.eq(Math.round(s.usd * 10) / 10, 0.3, 'usd accounted');
    A.eq(s.tokens, 30, 'tokens accounted');
  }

  // ---- cap drops the oldest queued job, never the running one ----
  {
    const order = [];
    let release;
    const first = new Promise(resolve => { release = resolve; });
    const q = makeReviewQueue({
      maxQueued: 1,
      worker: async job => {
        order.push(job.runId);
        if (job.runId === 'r1') await first;
        return {};
      }
    });
    q.enqueue({ runId: 'r1' });
    q.enqueue({ runId: 'r2' });
    q.enqueue({ runId: 'r3' });
    release();
    const s = await q.drain();
    A.eq(order, ['r1', 'r3'], 'oldest queued job was dropped under cap');
    A.eq(s.dropped, 1, 'drop counted');
  }

  // ---- timeout and missing runId handling ----
  {
    const q = makeReviewQueue({ timeoutMs: 5, worker: () => new Promise(() => {}) });
    A.eq(q.enqueue({}).queued, false, 'missing runId rejected');
    q.enqueue({ runId: 'slow' });
    const s = await q.drain();
    A.eq(s.timedOut, 1, 'timeout counted');
  }

  A.report('reviewqueue.test');
})();
