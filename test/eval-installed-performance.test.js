'use strict';
const A = require('./_assert.js');

(async () => {
  const { performanceStats } = await import('../scripts/eval/installed-performance.mjs');
  const stats = performanceStats([9, 1, 5, 3, 7]);
  A.eq(stats, { unit: 'ms', samples: 5, min: 1, median: 5, p95: 9, max: 9, values: [1, 3, 5, 7, 9] }, 'installed performance stats are deterministic');
  let refused = false;
  try { performanceStats([]); } catch (_) { refused = true; }
  A.ok(refused, 'an empty performance sample cannot produce a green measurement');
  A.report('eval-installed-performance.test');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
