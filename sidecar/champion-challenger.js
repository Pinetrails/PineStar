'use strict';
const { normalizeSharedReport } = require('./memory-store.js');
const FINAL = new Set(['completed', 'failed', 'cancelled']);
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function ids(v) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, 120)).filter(Boolean))].slice(0, 50); }
function round(v) { return Math.round(Number(v || 0) * 10000) / 10000; }
function sameReport(a, b) { return !!a && ['headline', 'completed', 'exceptions', 'decisions', 'nextActions', 'sourceRefs', 'evaluationLessons'].every(k => JSON.stringify(a[k]) === JSON.stringify(b[k])); }
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
  if (champion.objectiveCount < 2 || challenger.objectiveCount < 2) return 'inconclusive';
  if (champion.runCount !== champion.objectiveCount || challenger.runCount !== challenger.objectiveCount) return 'inconclusive';
  if (champion.evidencedCompletionCount !== champion.completed || challenger.evidencedCompletionCount !== challenger.completed) return 'inconclusive';
  const noWorse = challenger.completionRate >= champion.completionRate && challenger.failed <= champion.failed
    && challenger.cancelled <= champion.cancelled && (challenger.costPerCompletionUsd == null || champion.costPerCompletionUsd == null || challenger.costPerCompletionUsd <= champion.costPerCompletionUsd);
  const better = challenger.completionRate > champion.completionRate || challenger.failed < champion.failed || challenger.cancelled < champion.cancelled
    || (challenger.costPerCompletionUsd != null && champion.costPerCompletionUsd != null && challenger.costPerCompletionUsd < champion.costPerCompletionUsd);
  return noWorse && better ? 'challenger_recommended' : 'retain_champion';
}
function evaluationLessons(decision, champion, challenger) {
  const lessons = [], arms = [['champion', champion], ['challenger', challenger]];
  for (const [arm, row] of arms) {
    if (row.objectiveCount < 2) lessons.push({ kind: 'small_cohort', arm, configurationId: row.configurationId, proxyDimension: 'objective_count', observed: row.objectiveCount + ' settled objective(s); minimum is 2.', futureDesign: 'Use at least two disjoint settled objectives for this arm.' });
    if (row.runCount < row.objectiveCount) lessons.push({ kind: 'missing_run_measurement', arm, configurationId: row.configurationId, proxyDimension: 'measured_runs', observed: (row.objectiveCount - row.runCount) + ' objective(s) lacked a matched measured run.', futureDesign: 'Capture one measured run for every objective before evaluation.' });
    if (row.evidencedCompletionCount < row.completed) lessons.push({ kind: 'missing_completion_evidence', arm, configurationId: row.configurationId, proxyDimension: 'completion_evidence', observed: (row.completed - row.evidencedCompletionCount) + ' completion(s) lacked evidence.', futureDesign: 'Attach evidence references to every completed objective.' });
    if (row.uncertainMutationCount) lessons.push({ kind: 'uncertain_mutation', arm, configurationId: row.configurationId, proxyDimension: 'mutation_certainty', observed: row.uncertainMutationCount + ' uncertain mutation(s) were recorded.', futureDesign: 'Use a known fixed configuration and resolve mutation uncertainty before comparison.' });
  }
  if (decision === 'retain_champion') {
    const losing = [];
    if (challenger.completionRate < champion.completionRate) losing.push(['completion_rate', challenger.completionRate + ' versus champion ' + champion.completionRate]);
    if (challenger.failed > champion.failed) losing.push(['failed_objectives', challenger.failed + ' versus champion ' + champion.failed]);
    if (challenger.cancelled > champion.cancelled) losing.push(['cancelled_objectives', challenger.cancelled + ' versus champion ' + champion.cancelled]);
    if (challenger.costPerCompletionUsd != null && champion.costPerCompletionUsd != null && challenger.costPerCompletionUsd > champion.costPerCompletionUsd) losing.push(['cost_per_completion_usd', challenger.costPerCompletionUsd + ' versus champion ' + champion.costPerCompletionUsd]);
    for (const [proxyDimension, observed] of losing) lessons.push({ kind: 'losing_proxy_dimension', arm: 'challenger', configurationId: challenger.configurationId, proxyDimension, observed, futureDesign: 'Change the experiment design deliberately before testing this configuration again.' });
  }
  return lessons;
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
  const evidenceComplete = champion.objectiveCount >= 2 && challenger.objectiveCount >= 2 && champion.runCount === champion.objectiveCount && challenger.runCount === challenger.objectiveCount
    && champion.evidencedCompletionCount === champion.completed && challenger.evidencedCompletionCount === challenger.completed;
  const lessons = evaluationLessons(decision, champion, challenger);
  const line = a => a.configurationId + ': ' + a.completed + '/' + a.objectiveCount + ' completed; ' + a.failed + ' failed; ' + a.cancelled + ' cancelled; $' + a.costUsd.toFixed(4) + ' measured cost; $' + a.wastedCostUsd.toFixed(4) + ' wasted-work cost.';
  const report = normalizeSharedReport({ id, type: 'champion-challenger-evaluation', createdAt: typeof d.now === 'function' ? d.now() : Date.now(),
    headline: 'Advisory configuration evaluation: ' + decision.replace(/_/g, ' '), completed: [line(champion), line(challenger)],
    exceptions: [].concat(champion.objectiveCount < 2 || challenger.objectiveCount < 2 ? ['Each cohort needs at least two settled objectives before a recommendation.'] : [], champion.runCount + challenger.runCount < champion.objectiveCount + challenger.objectiveCount ? ['Some settled objectives have no matched measured run; cost comparisons are incomplete.'] : [], champion.evidencedCompletionCount < champion.completed || challenger.evidencedCompletionCount < challenger.completed ? ['Some completed objectives lack completion evidence; quality comparisons are incomplete.'] : []),
    decisions: [decision + ': observed completion, failure, cancellation, measured cost, uncertain mutation, and wasted-work proxies only.'],
    nextActions: ['Commander review is required before any configuration admission, activation, retirement, or routing change.'], evaluationLessons: lessons,
    sourceRefs: championArm.objectiveIds.concat(challengerArm.objectiveIds).map(id => 'objective:' + id).concat([...runMap.values()].filter(r => championArm.objectiveIds.concat(challengerArm.objectiveIds).some(id => text((objectiveMap.get(id) || {}).admittedRunId, 120) === r.runId)).map(r => 'run:' + r.runId), evidenceComplete ? ['evaluation-evidence:complete-v1'] : []) });
  const prior = d.getReport(id); if (prior && !sameReport(prior, report)) throw new Error('configuration evaluation already recorded differently');
  const saved = prior ? { added: false, report: prior } : await d.appendReport(report);
  return { schema: 'pine-star.champion-challenger-evaluation.v1', idempotent: !saved.added, verdict: decision, champion, challenger, report: saved.report,
    evidenceComplete, advisoryOnly: true, configurationChanged: false, activationPerformed: false, spendingAuthorityUsd: 0, externalAction: false };
}
module.exports = { normalizeArm, summarizeArm, verdict, evaluationLessons, evaluateConfigurations };
