'use strict';
const A = require('./_assert.js');
const M = require('../sidecar/prepared-auditor-v2-experiment.js');
const V2 = require('../sidecar/auditor-json-audit-v2.js');
A.eq(M.assertPreparedPlan(), true, 'prepared v2 plan satisfies its immutable contract');
A.ok(M.PLAN.executionAuthorized === false && typeof M.execute === 'undefined' && typeof M.claimAttempt === 'undefined', 'plan exposes no execution or receipt path');
A.eq(M.PLAN.maximumMeasuredSlots, 18, 'plan has exactly 18 maximum slots');
A.eq(M.PLAN.slots.length, 18, 'slot manifest contains exactly 18 entries');
A.eq(new Set(M.PLAN.slots.map((row) => row.slotId)).size, 18, 'slot identities are unique');
A.eq(new Set(M.PLAN.slots.map((row) => row.pairId)).size, 9, 'nine matched pairs are defined');
A.ok(M.PLAN.tasks.every((task) => task.taskId.endsWith('-v2') && task.instructionVersion === V2.CONTRACT.version), 'only distinct v2 task identities are used');
for (const task of M.PLAN.tasks) {
  A.eq(task.instructionHash, M.sha(V2.instruction(task.taskId, task.inputHash, M.PLAN.champion)), task.taskId + ' instruction hash is reproducible');
  const taskSlots = M.PLAN.slots.filter((row) => row.taskId === task.taskId);
  A.eq(taskSlots.length, 6, task.taskId + ' has three repetitions in both arms');
  for (const repetition of [1, 2, 3]) {
    const pair = taskSlots.filter((row) => row.repetition === repetition);
    A.eq(pair.length, 2, task.taskId + ' repetition ' + repetition + ' is paired');
    A.eq(new Set(pair.map((row) => row.inputHash + ':' + row.instructionHash)).size, 1, task.taskId + ' repetition ' + repetition + ' preserves pair identity');
  }
}
A.ok(/^[a-f0-9]{64}$/.test(M.PLAN_DIGEST) && M.PLAN_DIGEST === M.sha(M.canonical(M.PLAN)), 'canonical SHA-256 digest is reproducible');
A.ok(M.PLAN.evidenceRequirements.some((row) => row.includes('raw model output')) && M.PLAN.independentTruthRecomputation, 'raw output and independent truth are mandatory');
A.ok(M.PLAN.operationalEnvelope.maximumExternalCostUsd === 0 && M.PLAN.wallEnvelope.maximumPlannedMinutes === 90, 'zero-cost and wall boundaries are explicit');
A.report('prepared-auditor-v2-experiment.test');
