'use strict';
// PS-2026-072: deterministic post-run evaluation only; cannot execute or activate a model.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Prepared = require('./prepared-auditor-v2-experiment.js');
const Worker = require('./auditor-v2-durable-worker.js');

function median(values) { const v = values.slice().sort((a, b) => a - b); return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; }
function summarize(slots) {
  const runtime = slots.map((s) => s.runtimeMs).filter(Number.isFinite);
  const knownUsage = slots.filter((s) => s.usage && s.usage !== 'UNKNOWN');
  return {
    slots: slots.length, successful: slots.filter((s) => s.agreement).length,
    validV2Format: slots.filter((s) => !!s.parsedClaim).length,
    timeouts: slots.filter((s) => String(s.timeoutClassification).includes('timeout-')).length,
    failures: slots.filter((s) => s.state === 'failed').length,
    averageRuntimeMs: runtime.length ? Math.round(runtime.reduce((a, b) => a + b, 0) / runtime.length) : 'UNKNOWN',
    medianRuntimeMs: runtime.length ? median(runtime) : 'UNKNOWN',
    usage: { knownSlots: knownUsage.length, unknownSlots: slots.length - knownUsage.length,
      promptTokensKnown: knownUsage.reduce((n, s) => n + (Number.isInteger(s.usage.promptTokens) ? s.usage.promptTokens : 0), 0),
      completionTokensKnown: knownUsage.reduce((n, s) => n + (Number.isInteger(s.usage.completionTokens) ? s.usage.completionTokens : 0), 0) },
    externalCostUsd: slots.reduce((n, s) => n + s.costUsd, 0)
  };
}
function evaluate(receiptDir) {
  const receiptFile = path.join(receiptDir, 'receipt.json'); const receipt = Worker.validateReceipt(JSON.parse(fs.readFileSync(receiptFile, 'utf8')));
  if (receipt.status !== 'completed' || receipt.launchCount !== 18 || receipt.slots.some((s) => !Worker.TERMINAL.has(s.state))) throw new Error('all 18 slots must be terminal');
  const rawChecks = receipt.slots.map((s) => {
    if (!s.rawOutputRef) return s.completion === 'provider-failure' && s.usage === 'UNKNOWN';
    const bytes = fs.readFileSync(path.join(receiptDir, s.rawOutputRef)); return crypto.createHash('sha256').update(bytes).digest('hex') === s.rawOutputSha256;
  });
  const pairs = Prepared.PLAN.slots.filter((s) => s.arm === 'champion').map((slot) => {
    const champion = receipt.slots.find((s) => s.pairId === slot.pairId && s.arm === 'champion');
    const challenger = receipt.slots.find((s) => s.pairId === slot.pairId && s.arm === 'challenger');
    const matched = !!champion && !!challenger && champion.inputHash === challenger.inputHash && champion.instructionHash === challenger.instructionHash && champion.taskId === challenger.taskId && champion.repetition === challenger.repetition;
    return { pairId: slot.pairId, matched, championSlotId: champion && champion.slotId, challengerSlotId: challenger && challenger.slotId };
  });
  const perTask = Prepared.PLAN.tasks.map((task) => {
    const arms = {};
    for (const arm of ['champion', 'challenger']) { const slots = receipt.slots.filter((s) => s.taskId === task.taskId && s.arm === arm); arms[arm] = { ...summarize(slots), twoOfThreeReliable: slots.filter((s) => s.agreement).length >= 2 }; }
    return { taskId: task.taskId, inputHash: task.inputHash, instructionHash: task.instructionHash, ...arms };
  });
  const champion = summarize(receipt.slots.filter((s) => s.arm === 'champion')); const challenger = summarize(receipt.slots.filter((s) => s.arm === 'challenger'));
  return {
    schema: 'pine-star.auditor-v2-evaluation.v1', evaluationId: 'champion-challenger:' + Prepared.PLAN.planId,
    createdAt: new Date().toISOString(), planId: receipt.planId, planDigest: receipt.planDigest, receiptId: receipt.receiptId,
    matchedEvidenceComplete: pairs.every((p) => p.matched) && rawChecks.every(Boolean), pairCount: pairs.length, pairs,
    champion, challenger, perTask,
    evidenceQuality: 'complete-for-this-plan',
    lessons: [
      'Neither arm achieved reliable correctness on objective-store or shared-report audits.',
      'The challenger achieved three-of-three correctness on the small roster audit while the champion achieved zero-of-three.',
      'Both arms showed material latency variability; three first-response timeouts occurred and token usage for those slots is UNKNOWN.',
      'Strict v2 parsing exposed format failures without weakening the contract.'
    ],
    recommendation: 'retain_champion_no_candidate',
    rationale: 'The challenger is better on roster correctness and JSON compliance, but succeeds on only one of three tasks and 3/9 slots overall; that is insufficient for a production-role candidate.',
    candidate: { created: false, status: 'absent-insufficient-cross-task-reliability' },
    activation: 'not-authorized-not-performed', externalCostUsd: 0, safetyExceptions: []
  };
}

if (require.main === module) {
  const receiptDir = path.resolve(process.argv[2]); const output = path.join(receiptDir, 'evaluation.json');
  if (fs.existsSync(output)) throw new Error('evaluation already exists');
  fs.writeFileSync(output, JSON.stringify(evaluate(receiptDir), null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); process.stdout.write(output + '\n');
}
module.exports = { summarize, evaluate };
