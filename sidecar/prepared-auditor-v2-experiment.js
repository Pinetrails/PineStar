'use strict';
// PS-2026-072: immutable plan construction only. There is deliberately no execution, receipt, trigger, route,
// objective, scheduling, model, or measurement capability in this module.
const crypto = require('crypto');
const AuditV2 = require('./auditor-json-audit-v2.js');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

const champion = Object.freeze({ configurationId: 'operations-auditor.ollama-llama3.2-3b.v1', provider: 'ollama', model: 'llama3.2:3b' });
const challenger = Object.freeze({ configurationId: 'operations-auditor.ollama-llama3.1-8b.v1', provider: 'ollama', model: 'llama3.1:latest' });
const inputSpecs = [
  ['objective-store-audit-v2', 'pine-star.objectives.json', '63708ad3a136e15f8ed18b5d9b619846644e5417840e2a4758050a64e5548632'],
  ['shared-report-audit-v2', 'pine-star.shared-reports.json', '2b5e770cddaa75410736bfa7f88d379069263e4b360cf3fd7869977ad2114f8d'],
  ['runtime-roster-audit-v2', 'agent.roster.json', '26d731f85ff58b05c1482ab0da58b70c9c8422ec24b00279ef40c2c87cfebe79']
];
const tasks = Object.freeze(inputSpecs.map(([taskId, sourceFile, inputHash]) => Object.freeze({
  taskId, sourceFile, inputHash,
  immutableSnapshotRef: 'matched-measurements/auditor-matched-local-operational-envelope-v1/' + taskId.replace(/-v2$/, '') + '-' + inputHash + '.json',
  instructionVersion: AuditV2.CONTRACT.version,
  instructionHash: sha(AuditV2.instruction(taskId, inputHash, champion))
})));
const slots = Object.freeze(['champion', 'challenger'].flatMap((arm) => tasks.flatMap((task) => [1, 2, 3].map((repetition) => Object.freeze({
  slotId: 'auditor-v2-' + arm + '-' + task.taskId + '-r' + repetition,
  pairId: 'auditor-v2-' + task.taskId + '-r' + repetition,
  arm, taskId: task.taskId, repetition, inputHash: task.inputHash, instructionHash: task.instructionHash
})))));

const PLAN = Object.freeze({
  schema: 'pine-star.prepared-auditor-experiment.v2',
  planId: 'auditor-matched-local-v2-repeated-v1',
  authorityChangeId: 'PS-2026-072',
  sourceChangeIds: Object.freeze(['PS-2026-071', 'PS-2026-072']),
  executionAuthorized: false,
  executionCapability: 'absent-requires-separate-commander-authorization',
  roleId: 'operations.auditor',
  champion, challenger,
  taskContractVersion: AuditV2.CONTRACT.version,
  instructionGeneration: 'auditor-json-audit-v2.instruction(taskId,inputHash,champion)',
  repetitionsPerTaskPerArm: 3,
  maximumMeasuredSlots: 18,
  tasks,
  slots,
  pairingPolicy: 'same immutable snapshot, input hash, v2 instruction, instruction hash, task, and repetition across arms',
  inputPolicy: 'reuse the named immutable PS-2026-069 snapshots read-only; hash-check before every slot; never substitute live input',
  evidenceRequirements: Object.freeze([
    'intended deterministic slot executed exactly once', 'normal run provenance exists',
    'configuration, provider, model, task, repetition, input hash, and instruction hash match the slot',
    'exact raw model output retained, including malformed or empty output',
    'mechanical truth independently recomputed from the immutable bytes with auditor-json-audit-v2',
    'parser result, agreement, timeout, incorrect output, and UNKNOWN telemetry settled truthfully',
    'cost, token/usage uncertainty, retries, tools, mutations, safety exceptions, start/end, and duration retained',
    'matched pair counts only when both arms satisfy every identity and provenance requirement'
  ]),
  operationalEnvelope: Object.freeze({ provider: 'ollama', locality: 'loopback-only', firstResponseHeaderCeilingMs: 240000, preHeaderRetries: 0, attemptsPerSlot: 1, automaticRetries: 0, recurrence: false, fallbackModels: Object.freeze([]), fallbackProviders: Object.freeze([]), tools: false, routingMutation: false, configurationMutation: false, maximumExternalCostUsd: 0 }),
  wallEnvelope: Object.freeze({ maximumPlannedMs: 5400000, maximumPlannedMinutes: 90, expectedDurationMinutes: Object.freeze({ low: 35, high: 65 }), expectedBasis: 'two completed PS-2026-069 champion responses were 140526ms and 178462ms; challenger completion latency remains UNKNOWN' }),
  rawOutputRetention: true,
  independentTruthRecomputation: true,
  historicalIntegrity: 'all prior plans, receipts, runs, measurements, evidence, findings, and outcomes remain immutable',
  rollback: 'close only a future separately authorized receipt; retain the champion and keep the challenger inactive'
});
const PLAN_DIGEST = sha(canonical(PLAN));

function assertPreparedPlan() {
  if (PLAN.executionAuthorized !== false || PLAN.executionCapability.indexOf('absent') !== 0) throw new Error('plan must remain non-executable');
  if (PLAN.planId === 'auditor-matched-local-operational-envelope-v1' || PLAN.planId === 'auditor-matched-local-replacement-v1') throw new Error('plan identity must be distinct');
  if (PLAN.roleId !== 'operations.auditor' || PLAN.taskContractVersion !== 'auditor-json-audit-v2') throw new Error('v2 role/contract mismatch');
  if (PLAN.tasks.length !== 3 || PLAN.slots.length !== 18 || PLAN.maximumMeasuredSlots !== 18 || PLAN.repetitionsPerTaskPerArm !== 3) throw new Error('exact 18-slot structure required');
  if (new Set(PLAN.slots.map((row) => row.slotId)).size !== 18 || new Set(PLAN.slots.map((row) => row.pairId)).size !== 9) throw new Error('slot/pair identities must be deterministic and unique');
  if (PLAN.tasks.some((task) => !task.taskId.endsWith('-v2') || task.instructionVersion !== AuditV2.CONTRACT.version || task.instructionHash !== sha(AuditV2.instruction(task.taskId, task.inputHash, champion)))) throw new Error('v2 task or instruction identity mismatch');
  const envelope = PLAN.operationalEnvelope;
  if (envelope.provider !== 'ollama' || envelope.firstResponseHeaderCeilingMs !== 240000 || envelope.preHeaderRetries || envelope.automaticRetries || envelope.attemptsPerSlot !== 1 || envelope.recurrence || envelope.fallbackModels.length || envelope.fallbackProviders.length || envelope.tools || envelope.routingMutation || envelope.configurationMutation || envelope.maximumExternalCostUsd !== 0) throw new Error('operational envelope expanded');
  return true;
}

module.exports = { PLAN, PLAN_DIGEST, canonical, sha, assertPreparedPlan };
