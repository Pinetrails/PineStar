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

if (require.main === module) A.report('cron.run-now.test');
