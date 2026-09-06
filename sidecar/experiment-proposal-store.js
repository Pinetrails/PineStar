'use strict';
const { makeDurableJsonStore } = require('./durable-store.js');
const CAP = 200, MAX_RUNS = 20, MAX_DURATION_MS = 86400000;
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function slug(v) { return text(v, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); }
function strings(v, cap, width) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, width)).filter(Boolean))].slice(0, cap); }
const SIGNATURE_FIELDS = ['experimentId', 'advisoryReportId', 'championConfigurationId', 'challengerConfigurationId', 'hypothesis', 'metrics', 'successThreshold', 'failureThreshold', 'evidenceRequirements', 'maximumRunCount', 'maximumDurationMs', 'permittedCostUsd', 'environment', 'scope', 'rollbackPlan', 'preparationRoleId', 'evaluatorRoleId', 'sourceRefs'];
function same(a, b) { return !!a && SIGNATURE_FIELDS.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k])); }

function makeExperimentProposalStore(deps) {
  const d = deps || {}, now = typeof d.now === 'function' ? d.now : Date.now, getReport = typeof d.getReport === 'function' ? d.getReport : () => null;
  const getRole = typeof d.getRole === 'function' ? d.getRole : () => null;
  const durable = d.durable || makeDurableJsonStore({ fs: d.fs, path: d.path, writeDurable: d.writeDurable,
    fileFor: () => d.path.join(d.workspaces, 'pine-star.experiment-proposals.json'), onRecover: d.onRecover, onCorrupt: d.onCorrupt });
  function build(input) {
    const x = input && typeof input === 'object' ? input : {}, experimentId = slug(x.experimentId), advisoryReportId = text(x.advisoryReportId, 120);
    const advisory = getReport(advisoryReportId), championConfigurationId = text(x.championConfigurationId, 100), challengerConfigurationId = text(x.challengerConfigurationId, 100);
    const hypothesis = text(x.hypothesis, 500), metrics = strings(x.metrics, 12, 160), successThreshold = text(x.successThreshold, 300), failureThreshold = text(x.failureThreshold, 300);
    const evidenceRequirements = strings(x.evidenceRequirements, 20, 240), maximumRunCount = Number(x.maximumRunCount), maximumDurationMs = Number(x.maximumDurationMs);
    const permittedCostUsd = x.permittedCostUsd == null ? 0 : Number(x.permittedCostUsd), environment = text(x.environment || 'local', 40).toLowerCase(), scope = text(x.scope, 500);
    const rollbackPlan = text(x.rollbackPlan, 500), preparationRoleId = text(x.preparationRoleId, 100), evaluatorRoleId = text(x.evaluatorRoleId, 100);
    if (!experimentId || !advisoryReportId || !championConfigurationId || !challengerConfigurationId || !hypothesis || !metrics.length || !successThreshold || !failureThreshold || !evidenceRequirements.length || !scope || !rollbackPlan || !preparationRoleId || !evaluatorRoleId) throw new Error('experiment proposal requires stable identity, advisory, pairing, hypothesis, metrics, thresholds, evidence, scope, rollback, and role fields');
    if (!advisory || advisory.type !== 'experiment-planning-advisory' || !(Array.isArray(advisory.evaluationLessons) && advisory.evaluationLessons.length) || !(Array.isArray(advisory.sourceRefs) && advisory.sourceRefs.some(ref => /^report:champion-challenger:/.test(String(ref))))) throw new Error('experiment proposal requires an evidenced experiment-planning advisory');
    if (championConfigurationId === challengerConfigurationId) throw new Error('experiment proposal champion and challenger must differ');
    if (!Number.isInteger(maximumRunCount) || maximumRunCount < 2 || maximumRunCount > MAX_RUNS) throw new Error('experiment proposal run count must be between 2 and ' + MAX_RUNS);
    if (!Number.isInteger(maximumDurationMs) || maximumDurationMs < 1 || maximumDurationMs > MAX_DURATION_MS) throw new Error('experiment proposal duration exceeds the bounded local limit');
    if (!Number.isFinite(permittedCostUsd) || permittedCostUsd !== 0) throw new Error('experiment proposal external spending authority is $0');
    if (environment !== 'local' || x.externalSideEffects === true) throw new Error('experiment proposal must be local with no external side effects');
    if (!getRole(preparationRoleId) || !getRole(evaluatorRoleId)) throw new Error('experiment proposal requires known preparation and evaluator roles');
    if (preparationRoleId === evaluatorRoleId) throw new Error('experiment proposal evaluator must be independent from preparation');
    const sourceRefs = strings(['report:' + advisoryReportId].concat(advisory.sourceRefs, Array.isArray(x.sourceRefs) ? x.sourceRefs : []), 24, 500);
    return { schema: 'pine-star.experiment-proposal.v1', id: 'experiment-proposal:' + experimentId, experimentId, advisoryReportId, championConfigurationId, challengerConfigurationId,
      hypothesis, metrics, successThreshold, failureThreshold, evidenceRequirements, maximumRunCount, maximumDurationMs, permittedCostUsd: 0, environment: 'local', scope, rollbackPlan,
      preparationRoleId, evaluatorRoleId, sourceRefs, protectedAction: true, status: 'review_required', approvalState: 'required', commanderDecision: null,
      executionAuthorized: false, objectiveCreated: false, experimentScheduled: false, runCount: 0, externalSideEffects: false, configurationChanged: false, activationAuthorized: false, createdAt: Math.max(0, Number(now()) || 0) };
  }
  async function create(input) { const proposal = build(input); let result; await durable.update('station', stored => { const rows = Array.isArray(stored) ? stored.slice() : [], prior = rows.find(x => x && x.id === proposal.id);
    if (prior) { if (!same(prior, proposal)) throw new Error('experiment proposal already recorded differently'); result = { proposal: prior, idempotent: true }; return undefined; }
    if (rows.length >= CAP) throw new Error('experiment proposal capacity exceeded'); rows.push(proposal); result = { proposal, idempotent: false }; return rows; }); return result; }
  function list(limit) { const rows = durable.get('station'), cap = Math.max(1, Math.min(CAP, Number(limit) || 50)); return (Array.isArray(rows) ? rows : []).filter(Boolean).slice(-cap).reverse(); }
  function get(id) { return list(CAP).find(x => x.id === String(id || '') || x.experimentId === String(id || '')) || null; }
  return { create, list, get, readStatus: () => durable.readKey('station'), _durable: durable };
}
module.exports = { makeExperimentProposalStore, CAP, MAX_RUNS, MAX_DURATION_MS };
