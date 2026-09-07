'use strict';
const A = require('./_assert.js');
const M = require('../sidecar/prepared-auditor-experiment.js');

A.eq(M.assertPreparedPlan(), true, 'prepared plan satisfies its fail-closed contract');
A.ok(M.PLAN.executionAuthorized === false && typeof M.execute === 'undefined', 'preparation grants no execution path');
A.eq(M.PLAN.connectTimeoutMs, 240000, 'prepared measurement uses the Ollama operational ceiling');
A.eq(M.PLAN.preHeaderRetries + M.PLAN.retries, 0, 'prepared measurement has no provider or experiment retry');
A.ok(M.PLAN.provider === 'ollama' && M.PLAN.maximumCostUsd === 0, 'prepared measurement is local and zero external cost');
A.ok(M.PLAN.fallbackModels.length + M.PLAN.fallbackProviders.length === 0, 'prepared measurement cannot substitute provider or model');
A.ok(M.PLAN.planId !== 'auditor-matched-local-v1' && M.PLAN.planId !== 'auditor-matched-local-replacement-v1', 'prepared plan does not reuse a consumed plan identity');
A.ok(!/pine-star\.auditor-measurement-receipt\.json$/.test(M.PLAN.receiptFile), 'prepared plan reserves a distinct receipt identity');
const sequence = M.preparedSequence();
A.eq(sequence.filter((row) => row.kind === 'prewarm').length, 2, 'one prewarm is declared per arm');
A.ok(sequence.filter((row) => row.kind === 'prewarm').every((row) => row.evidence === false), 'prewarms are explicitly non-evidence');
A.eq(sequence.filter((row) => row.kind === 'release' && row.evidence === false).length, 2, 'each arm is released without creating evidence');
A.eq(sequence.filter((row) => row.kind === 'measurement').length, 6, 'exactly six measured runs are declared');
A.ok(sequence.slice(0, 5).every((row) => row.arm === 'champion') && sequence.slice(5).every((row) => row.arm === 'challenger'), 'one-arm-at-a-time order avoids unnecessary model swapping');
for (const task of M.PLAN.tasks) {
  const pair = sequence.filter((row) => row.kind === 'measurement' && row.taskId === task.id);
  A.eq(pair.length, 2, task.id + ' has exactly one run per arm');
  A.eq(new Set(pair.map((row) => row.file)).size, 1, task.id + ' names identical immutable input source');
  A.eq(new Set(pair.map(() => M.instruction(task, 'same-input-hash'))).size, 1, task.id + ' uses an identical instruction for both arms');
}
A.report('prepared-auditor-experiment.test');
