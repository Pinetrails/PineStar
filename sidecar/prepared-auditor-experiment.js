'use strict';
// PS-2026-068 prepares the next matched Auditor plan but deliberately exposes no execution function or host
// route. A separate Commander decision must authorize and bind an executor to this exact digest.
const crypto = require('crypto');

const PLAN = Object.freeze({
  schema: 'pine-star.prepared-auditor-experiment.v1',
  planId: 'auditor-matched-local-operational-envelope-v1',
  authorityChangeId: 'PS-2026-068',
  executionAuthorized: false,
  receiptFile: 'pine-star.auditor-operational-envelope-v1-receipt.json',
  roleId: 'operations.auditor',
  provider: 'ollama',
  maximumCostUsd: 0,
  connectTimeoutMs: 240000,
  preHeaderRetries: 0,
  retries: 0,
  recurrence: false,
  fallbackModels: Object.freeze([]),
  fallbackProviders: Object.freeze([]),
  residentPolicy: 'one-arm-at-a-time',
  releaseAfterArm: true,
  snapshotPolicy: 'snapshot-each-input-once-before-prewarm-and-reuse-for-both-arms',
  instructionVersion: 'auditor-json-audit-v1',
  champion: Object.freeze({ configurationId: 'operations-auditor.ollama-llama3.2-3b.v1', model: 'llama3.2:3b' }),
  challenger: Object.freeze({ configurationId: 'operations-auditor.ollama-llama3.1-8b.v1', model: 'llama3.1:latest' }),
  prewarm: Object.freeze({
    evidence: false,
    prompt: 'Reply exactly READY.',
    maxOutputTokens: 3,
    temperature: 0,
    instruction: 'Run once immediately before the three measured tasks for that arm; never create an objective, run, or measurement evidence row.'
  }),
  tasks: Object.freeze([
    Object.freeze({ id: 'objective-store-audit', file: 'pine-star.objectives.json' }),
    Object.freeze({ id: 'shared-report-audit', file: 'pine-star.shared-reports.json' }),
    Object.freeze({ id: 'runtime-roster-audit', file: 'agent.roster.json' })
  ])
});

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const PLAN_DIGEST = crypto.createHash('sha256').update(canonical(PLAN)).digest('hex');

function instruction(task, inputHash) {
  return ['Pine Star authorized local Auditor measurement.', 'Task: ' + task.id, 'Input SHA-256: ' + inputHash, 'Inspect only the supplied JSON snapshot.', 'Return one JSON object only with keys validJson, recordCount, issueCount, evidenceRefs. evidenceRefs must be an array of exact JSON-pointer-like paths. Do not use tools, network, or external actions.'].join('\n');
}

function preparedSequence() {
  const rows = [];
  for (const arm of ['champion', 'challenger']) {
    const config = PLAN[arm];
    rows.push(Object.freeze({ kind: 'prewarm', evidence: false, arm, configurationId: config.configurationId, model: config.model }));
    for (const task of PLAN.tasks) rows.push(Object.freeze({ kind: 'measurement', evidence: true, arm, configurationId: config.configurationId, model: config.model, taskId: task.id, file: task.file }));
    rows.push(Object.freeze({ kind: 'release', evidence: false, arm, configurationId: config.configurationId, model: config.model }));
  }
  return Object.freeze(rows);
}

function assertPreparedPlan() {
  if (PLAN.executionAuthorized !== false) throw new Error('prepared plan must not authorize execution');
  if (PLAN.provider !== 'ollama' || PLAN.maximumCostUsd !== 0) throw new Error('local zero-cost scope required');
  if (PLAN.connectTimeoutMs !== 240000 || PLAN.preHeaderRetries !== 0 || PLAN.retries !== 0 || PLAN.recurrence !== false) throw new Error('operational envelope mismatch');
  if (PLAN.fallbackModels.length || PLAN.fallbackProviders.length) throw new Error('fallback prohibited');
  const sequence = preparedSequence();
  if (sequence.filter((row) => row.kind === 'prewarm' && row.evidence === false).length !== 2) throw new Error('exact non-evidence prewarm required per arm');
  if (sequence.filter((row) => row.kind === 'measurement' && row.evidence === true).length !== 6) throw new Error('exact six-run measured plan required');
  if (sequence.filter((row) => row.kind === 'release' && row.evidence === false).length !== 2) throw new Error('exact non-evidence release required per arm');
  return true;
}

module.exports = { PLAN, PLAN_DIGEST, canonical, instruction, preparedSequence, assertPreparedPlan };
