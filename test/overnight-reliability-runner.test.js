'use strict';
const A = require('./_assert.js');

(async () => {
  const R = await import('../scripts/qa/overnight-reliability.mjs');

  const args = R.parseArgs(['--duration-hours', '8', '--resume', '--output', 'report.json']);
  A.eq(args['duration-hours'], '8', 'pair arguments are parsed');
  A.eq(args.resume, '1', 'boolean arguments are parsed');
  A.eq(args.output, 'report.json', 'later pair arguments are parsed');

  const coverage = new Set(R.PROBES.map(row => row.id));
  for (const id of ['oauth-refresh', 'rate-limit-failover', 'scheduled-continuation', 'restart-persistence', 'duplicate-delivery', 'partial-platform-outage']) {
    A.ok(coverage.has(id), 'campaign declares ' + id + ' coverage');
  }
  A.ok(R.PROBES.every(row => row.files.length > 0 && row.files.every(file => /^test\/.+\.test\.js$/.test(file))), 'every probe runs explicit test files');

  const end = Date.now() - 1;
  const green = {
    once: false, plannedEndAt: new Date(end).toISOString(), requiredCycles: 2,
    cycles: [
      { probes: [{ runs: [{ file: 'test/a.test.js', ok: true, cycle: 1 }] }] },
      { probes: [{ runs: [{ file: 'test/a.test.js', ok: true, cycle: 2 }] }] }
    ]
  };
  const greenSummary = R.summarize(green, end + 1);
  A.ok(greenSummary.completed && greenSummary.pass, 'completed coverage with no failures passes');
  A.eq(greenSummary.probeRuns, 2, 'probe executions are counted');

  const red = JSON.parse(JSON.stringify(green));
  red.cycles[1].probes[0].runs[0].ok = false;
  red.cycles[1].probes[0].runs[0].timedOut = true;
  const redSummary = R.summarize(red, end + 1);
  A.eq(redSummary.pass, false, 'one failed probe fails the soak');
  A.eq(redSummary.failures, 1, 'failed probes are counted');
  A.eq(redSummary.failed[0].cycle, 2, 'failure evidence keeps the cycle');

  const short = JSON.parse(JSON.stringify(green));
  short.requiredCycles = 3;
  A.eq(R.summarize(short, end + 1).pass, false, 'insufficient cycle coverage cannot pass');

  const once = { once: true, plannedEndAt: new Date(end + 999999).toISOString(), requiredCycles: 1, cycles: [{ probes: [{ runs: [{ file: 'test/a.test.js', ok: true, cycle: 1 }] }] }] };
  A.ok(R.summarize(once, end).pass, 'a one-cycle smoke can finish without waiting for a wall-clock deadline');

  A.report('overnight-reliability-runner.test');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
