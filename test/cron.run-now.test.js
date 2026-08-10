/* node test/cron.run-now.test.js - source-locks manual routine Run Now visibility.

   The reference harness had this exact class of bug: a manual cron run reported success but did
   not actually fire through the same observable path. In StarNet the important
   contract is that /api/cron/run is not only a panel-local NDJSON stream: it
   must also place a cron work item and mirror lifecycle over SSE so the floor
   moves immediately when the user presses Run Now. */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'sidecar', 'index.js'), 'utf8');

function sliceBetween(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  if (start < 0) return '';
  const rest = text.slice(start);
  const end = rest.search(endPattern);
  return end < 0 ? rest : rest.slice(0, end);
}

const driverBlock = sliceBetween(src, /const cronDriver = makeCronDriver\(/, /let cronTimer = null;/);
const runNowBlock = sliceBetween(src, /async function handleCronRun\(/, /\/\* POST \/api\/checkpoint\/restore/);
const runOnceBlock = sliceBetween(src, /async function runOnce\(/, /\/\/ ---- concurrency admission/);

A.ok(/function placeCronWorkitem\s*\(/.test(src), 'shared cron workitem helper exists');
A.ok(/placeWorkitem:\s*placeCronWorkitem/.test(driverBlock), 'scheduled cron uses the shared workitem helper');
A.ok(/placeCronWorkitem\s*\(\s*job\.agentId\s*,\s*job\.prompt\s*,\s*runId\s*\)/.test(runNowBlock), 'manual Run Now places a cron workitem');
A.ok(/broadcast:\s*true/.test(runNowBlock), 'manual Run Now opts into SSE lifecycle broadcast');
A.ok(/manual[\s/]+Run Now[\s/]+opts into broadcast/i.test(runOnceBlock), 'runOnce comment documents manual cron broadcast reason');

/* GRANTS NEVER FLOW DOWN A LINE (2026-08-04). The routine's unattended grant was approved for ONE agent —
   its own dock. Stage one keeps it; every chain hop must run UNGRANTED, on BOTH fire paths (scheduled goes
   through the driver's advanceChain seam; Run Now calls chainRunner.advance directly). Lock the exact text
   so a refactor that quietly re-inherits job.unattendedGrants into a hop turns this red. */
// stage one of Run Now still runs with the routine's own recorded grant…
A.ok(/unattendedGrants:\s*Array\.isArray\(job\.unattendedGrants\)/.test(runNowBlock), "Run Now stage one keeps the routine's own unattended grant");
// …but its chain hop (inside the same handler, after chainRunner.advance) passes an empty list…
const runNowHopBlock = sliceBetween(runNowBlock, /chainRunner\.advance\(/, /markRun/);
A.ok(/unattendedGrants:\s*\[\]/.test(runNowHopBlock), 'the Run Now chain hop passes NO unattended grants');
A.ok(!/unattendedGrants:\s*Array\.isArray\(job\.unattendedGrants\)/.test(runNowHopBlock), "the Run Now chain hop never inherits the routine's grant");
// …and the scheduled path's advanceChain seam hard-codes the same law for every hop it executes.
const seamBlock = sliceBetween(driverBlock, /advanceChain:\s*\(o\)\s*=>\s*chainRunner\.advance\(/, /^\}\);/m);
A.ok(/unattendedGrants:\s*\[\]/.test(seamBlock), 'the scheduled advanceChain seam runs every hop with NO unattended grants');
A.ok(!/unattendedGrants:\s*o\.unattendedGrants/.test(seamBlock), 'the seam never forwards caller-supplied grants into a hop');

if (require.main === module) A.report('cron.run-now.test');
