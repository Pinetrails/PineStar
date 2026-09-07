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
function sha(value) { return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex'); }

function instruction(task, inputHash) {
  return ['Pine Star authorized local Auditor measurement.', 'Task: ' + task.id, 'Input SHA-256: ' + inputHash, 'Inspect only the supplied JSON snapshot.', 'Return one JSON object only with keys validJson, recordCount, issueCount, evidenceRefs. evidenceRefs must be an array of exact JSON-pointer-like paths. Do not use tools, network, or external actions.'].join('\n');
}

function expected(taskId, bytes) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch (_) { return { validJson: false, recordCount: 0, issueCount: 1, evidenceRefs: ['$:invalid-json'] }; }
  const refs = [];
  if (taskId === 'objective-store-audit') {
    const rows = Array.isArray(data) ? data : [];
    rows.forEach((row, index) => {
      if (!row || row.schema !== 'pine-star.objective.v1' || !row.id || !row.status) refs.push('$[' + index + ']:schema-state');
      if (row && row.status === 'completed' && !(Array.isArray(row.completionEvidenceRefs) && row.completionEvidenceRefs.length)) refs.push('$[' + index + ']:missing-completion-evidence');
    });
    return { validJson: true, recordCount: rows.length, issueCount: refs.length, evidenceRefs: refs };
  }
  if (taskId === 'shared-report-audit') {
    const rows = Array.isArray(data) ? data : [];
    rows.forEach((row, index) => {
      if (!row || !row.id || !row.type) refs.push('$[' + index + ']:schema');
      (Array.isArray(row && row.sourceRefs) ? row.sourceRefs : []).forEach((ref, refIndex) => {
        if (!String(ref || '').trim() || String(ref).length > 500) refs.push('$[' + index + '].sourceRefs[' + refIndex + ']:invalid');
      });
    });
    return { validJson: true, recordCount: rows.length, issueCount: refs.length, evidenceRefs: refs };
  }
  const agents = Array.isArray(data && data.agents) ? data.agents : [];
  const audit = Array.isArray(data && data.configurationAudit) ? data.configurationAudit : [];
  const agent = agents.find((row) => row && Array.isArray(row.systemRoleIds) && row.systemRoleIds.includes(PLAN.roleId));
  if (!agent || agent.configurationId !== PLAN.champion.configurationId || agent.provider !== PLAN.provider || agent.model !== PLAN.champion.model) refs.push('$.agents:champion-binding');
  const last = audit[audit.length - 1];
  const snap = last && Array.isArray(last.configurations) && last.configurations.find((row) => row.agentId === (agent && agent.agentId));
  if (!snap || snap.configurationId !== (agent && agent.configurationId) || snap.provider !== (agent && agent.provider) || snap.model !== (agent && agent.model)) refs.push('$.configurationAudit:inconsistent');
  return { validJson: true, recordCount: agents.length, issueCount: refs.length, evidenceRefs: refs };
}

function parseModel(text) {
  try {
    const value = JSON.parse(String(text || '').trim().replace(/^```json\s*|\s*```$/g, ''));
    return { validJson: !!value.validJson, recordCount: Number(value.recordCount), issueCount: Number(value.issueCount), evidenceRefs: Array.isArray(value.evidenceRefs) ? value.evidenceRefs.map(String) : [] };
  } catch (_) { return null; }
}

function sealedRunOptions(spec) {
  return { key: '', model: spec.model, provider: PLAN.provider, configurationId: spec.configurationId, fallbackModels: [], fallbackProviders: [], keyPool: [], isTask: false, reflect: false, emit: function () {} };
}

function validateAuthorization(input) {
  const value = input || {};
  if (value.planDigest !== PLAN_DIGEST || value.planId !== PLAN.planId) throw new Error('authorized operational-envelope plan identity mismatch');
  if (value.authorityChangeId !== 'PS-2026-069' || value.provider !== PLAN.provider || value.maximumCostUsd !== 0) throw new Error('exact Commander execution authority required');
  if (value.connectTimeoutMs !== 240000 || value.preHeaderRetries !== 0 || value.retries !== 0 || value.recurrence !== false) throw new Error('authorized operational envelope mismatch');
  if (value.roleId !== PLAN.roleId || value.championConfigurationId !== PLAN.champion.configurationId || value.challengerConfigurationId !== PLAN.challenger.configurationId) throw new Error('authorized role/configuration mismatch');
  return true;
}

function claimAttempt(fs, receiptFile, body) {
  const fd = fs.openSync(receiptFile, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(body, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

async function preflight(deps, input) {
  validateAuthorization(input);
  if (!deps || deps.halted() || deps.rosterChanged()) throw new Error('E-stop or champion roster parity blocks measurement');
  const hashes = [];
  for (const task of PLAN.tasks) {
    const snap = await deps.snapshot(task);
    if (!snap || !Buffer.isBuffer(snap.bytes) || sha(snap.bytes) !== snap.hash) throw new Error('input parity cannot be proven');
    hashes.push({ taskId: task.id, inputHash: snap.hash, instructionHash: sha(instruction(task, snap.hash)) });
  }
  return { planId: PLAN.planId, planDigest: PLAN_DIGEST, tasks: hashes, modelRuns: 0, prewarms: 0, measurements: 0 };
}

async function execute(deps, input) {
  validateAuthorization(input);
  if (!deps || deps.halted() || deps.rosterChanged()) throw new Error('E-stop or champion roster parity blocks measurement');
  const snapshots = new Map();
  for (const task of PLAN.tasks) {
    const snap = await deps.snapshot(task);
    if (!snap || !Buffer.isBuffer(snap.bytes) || sha(snap.bytes) !== snap.hash) throw new Error('input parity cannot be proven');
    snapshots.set(task.id, snap);
  }
  const runs = [], prewarms = [], releases = [];
  for (const arm of ['champion', 'challenger']) {
    if (deps.halted() || deps.rosterChanged()) throw new Error('E-stop or champion roster parity blocks measurement');
    const config = PLAN[arm];
    prewarms.push(await deps.prewarm({ arm, configurationId: config.configurationId, model: config.model, evidence: false }));
    try {
      for (const task of PLAN.tasks) {
        if (deps.halted() || deps.rosterChanged()) throw new Error('E-stop or champion roster parity blocks measurement');
        const snapshot = snapshots.get(task.id), prompt = instruction(task, snapshot.hash), instructionHash = sha(prompt);
        const result = await deps.run({ planId: PLAN.planId, planDigest: PLAN_DIGEST, roleId: PLAN.roleId, provider: PLAN.provider, arm, configurationId: config.configurationId, model: config.model, task, snapshot, prompt, instructionHash });
        const mechanical = expected(task.id, snapshot.bytes), claimed = parseModel(result.modelText), agreement = !!claimed && canonical(claimed) === canonical(mechanical);
        runs.push(await deps.settle(Object.assign({}, result, { taskId: task.id, inputHash: snapshot.hash, instructionHash, mechanical, claimed, agreement, arm, configurationId: config.configurationId, provider: PLAN.provider, model: config.model })));
      }
    } finally {
      releases.push(await deps.release({ arm, configurationId: config.configurationId, model: config.model, evidence: false }));
    }
  }
  return { planId: PLAN.planId, planDigest: PLAN_DIGEST, prewarms, runs, releases };
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

module.exports = { PLAN, PLAN_DIGEST, canonical, sha, instruction, expected, parseModel, sealedRunOptions, validateAuthorization, claimAttempt, preflight, execute, preparedSequence, assertPreparedPlan };
