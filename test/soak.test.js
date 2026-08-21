/* node test/soak.test.js
   Locks the scripted soak harness's PURE core (scripts/qa/soak.mjs) with fake tick streams — no sidecar,
   no clock, no OS probes. Proves:
     - CLI arg parsing (defaults, overrides, the restart-interval clamp, rejection of bad numbers)
     - statistics helpers (percentile, least-squares slope, bounded downsampling)
     - a flat RSS series PASSES; a monotonically leaking series FAILS the rss rule
     - a sustained swallowed-error slope in the last third FAILS; a one-off blip does not
     - a restart cycle that loses a persisted entity FAILS the restart rule; a clean cycle passes
     - an unplanned exit / orphan child FAILS the process rule
     - a p95 health stall FAILS the latency rule
     - unobtainable metrics stay null WITH a reason (never a reassuring 0)
     - receipt shape lock + the summary renders every rule
     - the orchestrator, driven by a scripted fake world, completes a full soak and produces a PASS */
'use strict';
const A = require('./_assert.js');

function series(n, fn, opts) {
  const o = opts || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    const at = (o.t0 || 1_000_000) + i * (o.stepMs || 15_000);
    out.push(Object.assign({ at, tick: i + 1, epoch: o.epoch == null ? 0 : (typeof o.epoch === 'function' ? o.epoch(i) : o.epoch), rssBytes: 100 * 1048576, healthMs: { median: 3, max: 8 }, swallowedTotal: 0, swallowedTags: {}, errorRingSeen: 0, workspaceBytes: 1000 + i, runs: { ok: i, failed: 0 }, routineFires: 1 }, fn ? fn(i) : {}));
  }
  return out;
}

function healthyInput(samples, extra) {
  return Object.assign({
    samples, completed: true, runs: { ok: 10, failed: 0, errors: [] }, routineFires: 2,
    restarts: [{ at: samples[Math.floor(samples.length / 2)].at, epoch: 0, before: { agents: ['a'], routines: ['r1'], runs: ['x', 'y'], turns: ['0|1|user'] }, after: { agents: ['a'], routines: ['r1'], runs: ['x', 'y', 'z'], turns: ['0|1|user', '1|2|assistant'] }, bootMs: 900, stopMode: 'SIGTERM' }],
    process: { unexpectedExits: 0, orphans: [], orphanCheck: 'enumerated after stop' },
    startedAt: samples[0].at, endedAt: samples[samples.length - 1].at, plannedMinutes: 10, options: { minutes: 10 }, meta: { sidecarHead: 'abc' },
  }, extra || {});
}

(async () => {
  const M = await import('../scripts/qa/soak.mjs');

  // ---- parseArgs
  {
    const d = M.parseArgs([]);
    A.eq(d.minutes, M.DEFAULTS.minutes, 'default minutes');
    A.eq(d.restartEvery, Math.min(M.DEFAULTS.restartEvery, Math.floor(M.DEFAULTS.minutes / 2)), 'restart interval clamps to half the soak');
    const s = M.parseArgs(['--minutes=6', '--tick-seconds=10', '--restart-every=30', '--out=/tmp/x', '--aux']);
    A.eq([s.minutes, s.tickSeconds, s.restartEvery, s.out, s.aux], [6, 10, 3, '/tmp/x', true], 'overrides + clamp (30 → 3 for a 6-minute soak)');
    A.eq(M.parseArgs(['--minutes=720']).restartEvery, M.DEFAULTS.restartEvery, 'a long soak keeps the default restart interval');
    A.throws(() => M.parseArgs(['--minutes=0']), 'minutes must be ≥ 1');
    A.throws(() => M.parseArgs(['--tick-seconds=abc']), 'non-numeric tick rejected');
    A.eq(M.parseArgs(['--help']).help, true, '--help flag');
  }

  // ---- statistics
  {
    A.eq(M.percentile([], 95), null, 'percentile of nothing is null');
    A.eq(M.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10, 'p95 of 1..10');
    A.eq(M.percentile([5, 1, 3], 50), 3, 'median sorts');
    A.eq(M.linearSlope([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 }]), 2, 'slope of y=2x');
    A.eq(M.linearSlope([{ x: 1, y: 5 }]), null, 'one point has no slope');
    A.eq(M.linearSlope([{ x: 1, y: 5 }, { x: 1, y: 9 }]), null, 'vertical has no slope');
    const b = M.boundSamples(series(100), 10);
    A.eq(b.length, 10, 'downsampled to 10');
    A.eq([b[0].tick, b[9].tick], [1, 100], 'keeps first and last');
    A.eq(M.boundSamples(series(5), 10).length, 5, 'short series untouched');
  }

  // ---- flat series PASSES
  {
    const r = M.evaluate(healthyInput(series(40)));
    A.eq(r.verdict, 'PASS', 'flat healthy series passes: ' + JSON.stringify(r.failedRules));
    A.eq(r.rules.rss.actual.slopeMBPerMin, 0, 'flat RSS slope is 0');
    A.eq(r.rules.swallowed.actual.count, 0, 'no swallowed growth');
  }

  // ---- leak FAILS
  {
    const leak = series(40, (i) => ({ rssBytes: (100 + i * 3) * 1048576 }));   // +3 MB per 15s tick = 12 MB/min, +60% over the half
    const r = M.evaluate(healthyInput(leak));
    A.eq(r.verdict, 'FAIL', 'leaking series fails');
    A.eq(r.failedRules, ['rss'], 'only the rss rule fails');
    A.ok(r.rules.rss.actual.slopeMBPerMin > M.RULES.rss.maxSlopeMBPerMin, 'slope reported above threshold: ' + r.rules.rss.actual.slopeMBPerMin);
    // GC sawtooth: big swings, no net growth → passes
    const saw = series(40, (i) => ({ rssBytes: (100 + (i % 4) * 30) * 1048576 }));
    A.eq(M.evaluate(healthyInput(saw)).rules.rss.pass, true, 'a GC sawtooth with no net growth passes');
    // steep slope but under the growth floor → passes (both conditions are required)
    const tiny = series(40, (i) => ({ rssBytes: (1000 + i * 1) * 1048576 }));   // 4 MB/min on a 1 GB base = 2% growth
    A.eq(M.evaluate(healthyInput(tiny)).rules.rss.pass, true, 'slope over threshold but growth under 20% passes');
    // restart mid-series: each epoch judged separately; a post-restart epoch that leaks fails
    const epochLeak = series(40, (i) => ({ epoch: i < 20 ? 0 : 1, rssBytes: (i < 20 ? 100 : 100 + (i - 20) * 5) * 1048576 }));
    const er = M.evaluate(healthyInput(epochLeak));
    A.eq([er.rules.rss.pass, er.rules.rss.actual.epoch], [false, 1], 'the leaking post-restart epoch is the one judged');
  }

  // ---- swallowed pressure
  {
    const sustained = series(30, (i) => ({ swallowedTotal: i }));   // +1 per 15s tick = 4/min for the whole soak
    const r = M.evaluate(healthyInput(sustained));
    A.eq(r.rules.swallowed.pass, false, 'a sustained swallow rate fails');
    A.ok(r.rules.swallowed.actual.ratePerMin > M.RULES.swallowed.maxRatePerMin, 'rate reported');
    const blip = series(30, (i) => ({ swallowedTotal: i >= 25 ? 1 : 0 }));
    A.eq(M.evaluate(healthyInput(blip)).rules.swallowed.pass, true, 'a single blip in the last third does not fail (count < 3)');
    const early = series(30, (i) => ({ swallowedTotal: i < 10 ? i : 10 }));
    A.eq(M.evaluate(healthyInput(early)).rules.swallowed.pass, true, 'growth that stopped before the last third passes');
    // restart resets the tally: a drop across an epoch boundary is not negative growth and not counted
    const reset = series(30, (i) => ({ epoch: i < 20 ? 0 : 1, swallowedTotal: i < 20 ? 2 : 0 }));
    const rr = M.evaluate(healthyInput(reset));
    A.eq([rr.rules.swallowed.pass, rr.rules.swallowed.actual.count], [true, 0], 'tally reset at restart is not growth');
  }

  // ---- latency
  {
    const stall = series(40, (i) => ({ healthMs: { median: 5, max: i >= 20 ? 900 : 8 } }));
    const r = M.evaluate(healthyInput(stall));
    A.eq(r.rules.latency.pass, false, 'p95 stall in the last half fails');
    A.eq(r.rules.latency.actual.p95Ms, 900, 'p95 reported');
    const early = series(40, (i) => ({ healthMs: { median: 5, max: i < 5 ? 900 : 8 } }));
    A.eq(M.evaluate(healthyInput(early)).rules.latency.pass, true, 'a boot-time spike outside the last half passes');
  }

  // ---- restart entity loss
  {
    const lost = healthyInput(series(40));
    lost.restarts = [{ at: 1, epoch: 0, before: { agents: ['a'], routines: ['r1', 'r2'], runs: ['x', 'y'], turns: ['0|1|user'] }, after: { agents: ['a'], routines: ['r1'], runs: ['x', 'y'], turns: ['0|1|user'] }, bootMs: 800 }];
    const r = M.evaluate(lost);
    A.eq(r.rules.restart.pass, false, 'a lost routine fails the restart rule');
    A.eq(r.rules.restart.actual.detail[0].lost, { routines: ['r2'] }, 'names the lost id by kind');
    const none = healthyInput(series(40), { restarts: [] });
    A.eq(M.evaluate(none).rules.restart.pass, false, 'zero restart cycles is a FAIL, not a pass by absence');
    const errored = healthyInput(series(40)); errored.restarts = [{ at: 1, epoch: 0, before: { agents: ['a'] }, after: null, error: 'boot timed out' }];
    A.eq(M.evaluate(errored).rules.restart.pass, false, 'a restart that errored fails');
    const unreadable = healthyInput(series(40)); unreadable.restarts = [{ at: 1, epoch: 0, before: { agents: ['a'] }, after: { agents: ['a'], routines: ['r9'] } }];
    A.eq(M.evaluate(unreadable).rules.restart.pass, true, 'an entity kind unreadable BEFORE is not judged (cannot be "lost")');
  }

  // ---- process + runs + routine + completed
  {
    A.eq(M.evaluate(healthyInput(series(40), { process: { unexpectedExits: 1, orphans: [] } })).failedRules, ['process'], 'unexpected exit fails process');
    A.eq(M.evaluate(healthyInput(series(40), { process: { unexpectedExits: 0, orphans: [{ pid: 4242 }] } })).failedRules, ['process'], 'an orphan child fails process');
    A.eq(M.evaluate(healthyInput(series(40), { runs: { ok: 9, failed: 1, errors: [{ reason: 'error' }] } })).failedRules, ['runs'], 'one run error fails (tolerance 0)');
    A.eq(M.evaluate(healthyInput(series(40), { runs: { ok: 0, failed: 0, errors: [] } })).failedRules, ['runs'], 'zero runs measured nothing → FAIL');
    A.eq(M.evaluate(healthyInput(series(40), { routineFires: 0 })).failedRules, ['routine'], 'no routine fire fails');
    A.eq(M.evaluate(healthyInput(series(40), { completed: false, stopReason: 'interrupted' })).failedRules, ['completed'], 'an interrupted soak fails completed');
  }

  // ---- null metrics stay null with a reason
  {
    const blind = series(40, () => ({ rssBytes: null, rssReason: 'OS memory probe returned nothing for pid 1', healthMs: null, swallowedTotal: null, swallowedReason: 'diagnostics.swallowed not present' }));
    const r = M.evaluate(healthyInput(blind));
    A.eq(r.rules.rss.actual.slopeMBPerMin, null, 'rss slope null when unsampled');
    A.ok(/OS memory probe/.test(r.rules.rss.actual.reason), 'rss carries the probe reason');
    A.eq(r.rules.latency.actual.p95Ms, null, 'latency null when unsampled');
    A.ok(!!r.rules.latency.actual.reason, 'latency null carries a reason');
    A.eq(r.rules.swallowed.actual.ratePerMin, null, 'swallowed null when unsampled');
    A.ok(!!r.rules.swallowed.actual.reason, 'swallowed null carries a reason');
    A.eq(r.verdict, 'PASS', 'null metrics are not failures (they are honest unknowns)');
    const rec = M.buildReceipt(healthyInput(blind));
    A.eq(rec.measurements.heapBytes, null, 'heap is null'); A.ok(!!rec.measurements.heapReason, 'heap null has a reason');
    A.eq(rec.measurements.openHandles, null, 'open handles null'); A.ok(!!rec.measurements.openHandlesReason, 'open handles null has a reason');
  }

  // ---- receipt shape lock + summary
  {
    const input = healthyInput(series(1000), { maxSamples: 50 });
    const rec = M.buildReceipt(input);
    A.eq(rec.schema, M.RECEIPT_SCHEMA, 'schema id');
    A.eq(Object.keys(rec).sort(), ['actualMinutes', 'endedAt', 'failedRules', 'measurements', 'meta', 'options', 'plannedMinutes', 'processSnapshots', 'rules', 'samples', 'schema', 'sidecarHead', 'startedAt', 'verdict'].sort(), 'receipt top-level keys');
    A.eq(Object.keys(rec.rules).sort(), Object.keys(M.RULES).sort(), 'every RULE has a verdict row');
    for (const [k, v] of Object.entries(rec.rules)) {
      A.eq(typeof v.pass, 'boolean', k + ' has a boolean pass');
      A.ok(v.actual && typeof v.actual === 'object', k + ' has actual numbers');
      A.ok(v.expected && typeof v.expected === 'object', k + ' has an expected threshold');
      A.ok(typeof v.why === 'string' && v.why.length > 20, k + ' states why');
    }
    A.eq(rec.samples.length, 50, 'samples bounded to maxSamples');
    A.eq(rec.sidecarHead, 'abc', 'head sha carried');
    A.eq(rec.verdict, 'PASS', 'receipt verdict');
    A.ok(/^\d{4}-\d{2}-\d{2}T/.test(rec.startedAt), 'ISO start');
    const md = M.renderSummary(rec);
    A.ok(/# StarNet soak — PASS/.test(md), 'summary headline');
    for (const k of Object.keys(M.RULES)) A.ok(new RegExp('\\| ' + k + ' \\|').test(md), 'summary row for ' + k);
    A.ok(/does not replace the attended packaged-desktop soak/.test(md), 'summary never claims to replace the packaged soak');
  }

  // ---- orchestrator with a scripted fake world (virtual clock, no sleeping)
  {
    let t = 1_000_000;
    let pid = 100, alive = false, stopped = 0, bootCount = 0;
    const routineRuns = [];
    let runCount = 0;
    const jsonRoutes = {
      'POST /api/roster': () => ({ status: 200, body: { ok: true } }),
      'POST /api/cron': () => ({ status: 200, body: { ok: true, job: { id: 'r1' } } }),
      'POST /api/cron/arm': () => ({ status: 200, body: { ok: true } }),
      'GET /api/health': () => { t += 2; return { status: 200, body: 'ok' }; },
      'GET /api/diagnostics': () => ({ status: 200, body: { report: { agentCount: 1, swallowed: { present: true, total: 0, tags: [] }, errors: [] } } }),
      'GET /api/state/snapshot': () => ({ status: 200, body: { runs: [] } }),
      'GET /api/cron': () => { if (Math.floor((t - 1_000_000) / 60_000) > routineRuns.length) routineRuns.push('cron-' + routineRuns.length); return { status: 200, body: { jobs: [{ id: 'r1', lastRunId: routineRuns[routineRuns.length - 1] || null, lastStatus: 'ok', lastReason: 'done' }] } }; },
    };
    const drivers = {
      stopMode: 'fake',
      pid: () => pid,
      async boot() { alive = true; bootCount++; return { pid }; },
      async restart() { alive = true; pid++; bootCount++; t += 800; return { pid }; },
      async stop() { alive = false; stopped++; },
      isAlive: () => alive,
      childrenOf: async () => [],
      async json(m, r) { const key = m + ' ' + r.split('?')[0]; if (r.startsWith('/api/runs')) return { status: 200, body: { runs: Array.from({ length: runCount }, (_, i) => ({ runId: 'run' + i })) } }; if (r.startsWith('/api/transcript')) return { status: 200, body: { turns: Array.from({ length: runCount * 2 }, (_, i) => ({ ts: i, role: i % 2 ? 'assistant' : 'user' })) } }; const h = jsonRoutes[key]; if (!h) throw new Error('no fake route ' + key); return h(); },
      async runConversation() { runCount++; t += 300; return { reason: 'done', toolOk: true }; },
      rss: async () => 90 * 1048576,
      workspaceBytes: () => 5000 + runCount,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      log: () => {},
    };
    const opts = M.parseArgs(['--minutes=6', '--tick-seconds=15', '--restart-every=2']);
    const result = await M.runSoak(drivers, opts);
    const rec = M.buildReceipt(Object.assign({}, result, { meta: { sidecarHead: 'fake' } }));
    A.eq(rec.verdict, 'PASS', 'scripted healthy world passes: ' + JSON.stringify(rec.failedRules) + ' ' + JSON.stringify(rec.rules.restart.actual.detail));
    A.ok(result.restarts.length >= 2, 'two restart cycles in 6 minutes at every 2: ' + result.restarts.length);
    A.ok(result.samples.length >= 20, 'one sample per tick: ' + result.samples.length);
    A.ok(result.runs.ok > 0 && result.runs.failed === 0, 'runs counted');
    A.ok(result.routineFires >= 1, 'routine fires counted: ' + result.routineFires);
    A.eq(alive, false, 'sidecar stopped at the end');
    A.eq(stopped, result.restarts.length + 1, 'one stop per restart plus the final stop');
    A.eq(result.completed, true, 'completed');

    // the same world, but the sidecar dies mid-soak → process rule fails, soak ends early, still a receipt
    let t2 = 1_000_000; let alive2 = true;
    const dying = Object.assign({}, drivers, { now: () => t2, sleep: async (ms) => { t2 += ms; if (t2 > 1_000_000 + 90_000) alive2 = false; }, isAlive: () => alive2, async boot() { alive2 = true; return { pid: 1 }; }, async restart() { alive2 = true; return { pid: 2 }; }, async stop() { alive2 = false; }, async json(m, r) { if (m === 'GET' && r === '/api/health') t2 += 2; return drivers.json(m, r); } });
    const dead = await M.runSoak(dying, M.parseArgs(['--minutes=6', '--tick-seconds=15']));
    const deadRec = M.buildReceipt(dead);
    A.eq(deadRec.verdict, 'FAIL', 'a dying sidecar fails');
    A.ok(deadRec.failedRules.includes('process') && deadRec.failedRules.includes('completed'), 'process + completed both fail: ' + JSON.stringify(deadRec.failedRules));
    A.eq(deadRec.rules.process.actual.unexpectedExits, 1, 'the unexpected exit is counted');

    // a world whose restart loses the routine → restart rule fails
    let t3 = 1_000_000;
    let lostOnce = false;
    const lossy = Object.assign({}, drivers, { now: () => t3, sleep: async (ms) => { t3 += ms; }, async restart() { lostOnce = true; t3 += 800; return { pid: 9 }; }, async json(m, r) { if (m === 'GET' && r === '/api/health') t3 += 2; if (m === 'GET' && r === '/api/cron' && lostOnce) return { status: 200, body: { jobs: [] } }; return drivers.json(m, r); } });
    const lost = await M.runSoak(lossy, M.parseArgs(['--minutes=4', '--tick-seconds=15', '--restart-every=2']));
    const lostRec = M.buildReceipt(lost);
    A.ok(lostRec.failedRules.includes('restart'), 'a restart that drops the routine fails: ' + JSON.stringify(lostRec.failedRules));
    A.eq(lostRec.rules.restart.actual.detail[0].lost, { routines: ['r1'] }, 'the lost routine id is named');
  }

  A.report('soak.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
