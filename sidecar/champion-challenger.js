'use strict';
const { normalizeSharedReport } = require('./memory-store.js');
const FINAL = new Set(['completed', 'failed', 'cancelled']);
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function ids(v) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, 120)).filter(Boolean))].slice(0, 50); }
function round(v) { return Math.round(Number(v || 0) * 10000) / 10000; }
function sameReport(a, b) { return !!a && ['headline', 'completed', 'exceptions', 'decisions', 'nextActions', 'sourceRefs'].every(k => JSON.stringify(a[k]) === JSON.stringify(b[k])); }
function normalizeArm(value, label) {
  const x = value && typeof value === 'object' ? value : {}, configurationId = text(x.configurationId, 100), objectiveIds = ids(x.objectiveIds);
  if (!configurationId || !objectiveIds.length) throw new Error(label + ' requires a configuration ID and objective IDs');
  return { configurationId, objectiveIds };
}
function summarizeArm(arm, objectiveMap, runMap) {
  const objectives = arm.objectiveIds.map(id => objectiveMap.get(id));
  if (objectives.some(x => !x)) throw new Error('evaluation references an unknown objective');
  if (objectives.some(x => !FINAL.has(x.status))) throw new Error('evaluation requires settled objectives');
  if (objectives.some(x => x.protectedAction || ['approval_required', 'waiting_approval'].includes(x.status))) throw new Error('protected objectives cannot enter configuration evaluation');
  const roleIds = [...new Set(objectives.map(x => text(x.assignedRoleId, 80)).filter(Boolean))];
  if (roleIds.length !== 1) throw new Error('each evaluation arm must contain one assigned system role');
  const runs = objectives.map(x => runMap.get(text(x.admittedRunId, 120))).filter(Boolean);
  const completed = objectives.filter(x => x.status === 'completed').length;
  const failed = objectives.filter(x => x.status === 'failed').length;
  const cancelled = objectives.filter(x => x.status === 'cancelled').length;
  const costUsd = round(runs.reduce((s, x) => s + Math.max(0, Number(x.usd) || 0), 0));
  const wastedCostUsd = round(objectives.reduce((s, x) => x.status === 'completed' ? s : s + Math.max(0, Number((runMap.get(text(x.admittedRunId, 120)) || {}).usd) || 0), 0));
  const uncertainMutationCount = runs.reduce((s, x) => s + (Array.isArray(x.uncertainMutations) ? x.uncertainMutations.length : 0), 0);
  return { configurationId: arm.configurationId, roleId: roleIds[0], objectiveCount: objectives.length, completed, failed, cancelled,
    completionRate: round(completed / objectives.length), evidencedCompletionCount: objectives.filter(x => x.status === 'completed' && Array.isArray(x.completionEvidenceRefs) && x.completionEvidenceRefs.length).length,
    runCount: runs.length, costUsd, costPerCompletionUsd: completed ? round(costUsd / completed) : null, wastedCostUsd, uncertainMutationCount };
}
function verdict(champion, challenger) {
  if (champion.uncertainMutationCount || challenger.uncertainMutationCount) return 'inconclusive';
  const noWorse = challenger.completionRate >= champion.completionRate && challenger.failed <= champion.failed
    && challenger.cancelled <= champion.cancelled && (challenger.costPerCompletionUsd == null || champion.costPerCompletionUsd == null || challenger.costPerCompletionUsd <= champion.costPerCompletionUsd);
  const better = challenger.completionRate > champion.completionRate || challenger.failed < champion.failed || challenger.cancelled < champion.cancelled
    || (challenger.costPerCompletionUsd != null && champion.costPerCompletionUsd != null && challenger.costPerCompletionUsd < champion.costPerCompletionUsd);
  return noWorse && better ? 'challenger_recommended' : 'retain_champion';
}
async function evaluateConfigurations(deps, input) {
  const d = deps || {}, x = input && typeof input === 'object' ? input : {}, evaluationId = text(x.evaluationId, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!evaluationId) throw new Error('evaluation requires a stable ID');
  if (!d.objectives || !Array.isArray(d.runs) || typeof d.appendReport !== 'function' || typeof d.getReport !== 'function') throw new Error('evaluation requires objective, run, and report sources');
  const championArm = normalizeArm(x.champion, 'champion'), challengerArm = normalizeArm(x.challenger, 'challenger');
  if (championArm.configurationId === challengerArm.configurationId) throw new Error('champion and challenger configurations must differ');
  if (championArm.objectiveIds.some(id => challengerArm.objectiveIds.includes(id))) throw new Error('evaluation arms cannot share objectives');
  const objectiveMap = new Map(d.objectives.map(row => [row && row.id, row])), runMap = new Map(d.runs.map(row => [row && row.runId, row]));
  const champion = summarizeArm(championArm, objectiveMap, runMap), challenger = summarizeArm(challengerArm, objectiveMap, runMap);
  if (champion.roleId !== challenger.roleId) throw new Error('champion and challenger must evaluate the same system role');
  const decision = verdict(champion, challenger), id = 'champion-challenger:' + evaluationId;
  const line = a => a.configurationId + ': ' + a.completed + '/' + a.objectiveCount + ' completed; ' + a.failed + ' failed; ' + a.cancelled + ' cancelled; $' + a.costUsd.toFixed(4) + ' measured cost; $' + a.wastedCostUsd.toFixed(4) + ' wasted-work cost.';
  const report = normalizeSharedReport({ id, type: 'champion-challenger-evaluation', createdAt: typeof d.now === 'function' ? d.now() : Date.now(),
    headline: 'Advisory configuration evaluation: ' + decision.replace(/_/g, ' '), completed: [line(champion), line(challenger)],
    exceptions: champion.runCount + challenger.runCount < champion.objectiveCount + challenger.objectiveCount ? ['Some settled objectives have no matched measured run; cost comparisons are incomplete.'] : [],
    decisions: [decision + ': observed completion, failure, cancellation, measured cost, uncertain mutation, and wasted-work proxies only.'],
    nextActions: ['Commander review is required before any configuration admission, activation, retirement, or routing change.'],
    sourceRefs: championArm.objectiveIds.concat(challengerArm.objectiveIds).map(id => 'objective:' + id).concat([...runMap.values()].filter(r => championArm.objectiveIds.concat(challengerArm.objectiveIds).some(id => text((objectiveMap.get(id) || {}).admittedRunId, 120) === r.runId)).map(r => 'run:' + r.runId)) });
  const prior = d.getReport(id); if (prior && !sameReport(prior, report)) throw new Error('configuration evaluation already recorded differently');
  const saved = prior ? { added: false, report: prior } : await d.appendReport(report);
  return { schema: 'pine-star.champion-challenger-evaluation.v1', idempotent: !saved.added, verdict: decision, champion, challenger, report: saved.report,
    advisoryOnly: true, configurationChanged: false, activationPerformed: false, spendingAuthorityUsd: 0, externalAction: false };
}
module.exports = { normalizeArm, summarizeArm, verdict, evaluateConfigurations };
