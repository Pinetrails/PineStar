'use strict';
const { normalizeSharedReport } = require('./memory-store.js');
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function list(v, cap, n) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, n)).filter(Boolean))].slice(0, cap); }
function slug(v) { return text(v, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); }
function finite(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null; }
function sameReport(a, b) { const fields = ['headline', 'completed', 'exceptions', 'decisions', 'nextActions', 'sourceRefs']; return !!a && fields.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k])); }
function normalizePlan(input) {
  const x = input && typeof input === 'object' ? input : {}, projectId = text(x.projectId, 100), experimentId = slug(x.experimentId), hypothesis = text(x.hypothesis, 800), metric = text(x.metric, 160);
  const baselineValue = finite(x.baselineValue), targetValue = finite(x.targetValue), direction = ['increase', 'decrease'].includes(x.direction) ? x.direction : '';
  if (!projectId || !experimentId || !hypothesis || !metric || baselineValue == null || targetValue == null || !direction) throw new Error('growth experiment requires stable IDs, hypothesis, metric, direction, baselineValue, and targetValue');
  return { projectId, experimentId, hypothesis, metric, direction, baselineValue, targetValue, method: text(x.method, 1200), evidenceRefs: list(x.evidenceRefs, 16, 300), priority: ['low', 'normal', 'high'].includes(x.priority) ? x.priority : 'normal' };
}
async function planGrowthExperiment(deps, input) {
  const d = deps || {}, plan = normalizePlan(input); if (!d.projects || !d.objectives || typeof d.appendReport !== 'function' || typeof d.getReport !== 'function') throw new Error('growth experiment requires project, objective, and report stores');
  const project = d.projects.get(plan.projectId); if (!project) throw new Error('product project not found');
  if (!['listing_ready', 'approval_required', 'published'].includes(project.status)) throw new Error('product project is not ready for a growth experiment');
  let objective = d.objectives.find(x => x && x.classification && x.classification.workflow === 'growth-experiment' && x.classification.projectId === project.id && x.classification.experimentId === plan.experimentId);
  if (!objective) objective = await d.objectives.create({ title: 'Evaluate growth experiment: ' + project.title, description: 'Analyze this bounded hypothesis using user-supplied or already-authorized evidence. Do not publish, advertise, message anyone, create accounts, purchase, subscribe, or spend.\nHypothesis: ' + plan.hypothesis + '\nMetric: ' + plan.metric + '\nBaseline: ' + plan.baselineValue + '; target: ' + plan.targetValue + '; direction: ' + plan.direction + '\nMethod: ' + (plan.method || 'Use the smallest reviewed test that can falsify the hypothesis.'), requiredCapabilities: ['design_growth_experiment', 'analyze_growth_experiment'], targetRoleId: 'business.growth_analyst', maxModelTier: 'economy', priority: plan.priority, classification: { method: 'growth-experiment-v1', matched: true, workflow: 'growth-experiment', projectId: project.id, experimentId: plan.experimentId } });
  const report = { id: 'growth-experiment-plan:' + project.id + ':' + plan.experimentId, type: 'growth-experiment-plan', createdAt: typeof d.now === 'function' ? d.now() : Date.now(), headline: 'Growth experiment planned: ' + project.title,
    decisions: ['Hypothesis: ' + plan.hypothesis, 'Measure ' + plan.metric + ' from ' + plan.baselineValue + ' toward ' + plan.targetValue + ' (' + plan.direction + ').'],
    nextActions: ['Complete the linked Growth Analyst objective using existing evidence; record a result only after observation.'], sourceRefs: ['product-project:' + project.id, 'objective:' + objective.id].concat(plan.evidenceRefs) };
  const normalized = normalizeSharedReport(report), prior = d.getReport(report.id); if (prior && !sameReport(prior, normalized)) throw new Error('growth experiment plan already recorded differently');
  const saved = prior ? { added: false, report: prior } : await d.appendReport(report), linked = await d.projects.link(project.id, { objectiveIds: [objective.id], reportIds: [saved.report.id] });
  return { schema: 'pine-star.growth-experiment-plan.v1', idempotent: !saved.added, plan, project: linked, objective, report: saved.report, spendingAuthorityUsd: 0, externalAction: false };
}
function normalizeResult(input) {
  const x = input && typeof input === 'object' ? input : {}, projectId = text(x.projectId, 100), experimentId = slug(x.experimentId), objectiveId = text(x.objectiveId, 120), observedValue = finite(x.observedValue), sampleSize = Math.floor(Number(x.sampleSize));
  const outcome = ['supported', 'not_supported', 'inconclusive'].includes(x.outcome) ? x.outcome : '', evidenceRefs = list(x.evidenceRefs, 20, 300);
  if (!projectId || !experimentId || !objectiveId || observedValue == null || !Number.isFinite(sampleSize) || sampleSize < 1 || !outcome || !evidenceRefs.length) throw new Error('growth result requires stable IDs, observedValue, positive sampleSize, outcome, and evidence');
  return { projectId, experimentId, objectiveId, observedValue, sampleSize, outcome, interpretation: text(x.interpretation, 1000), evidenceRefs, nextAction: text(x.nextAction, 300) };
}
async function finalizeGrowthExperiment(deps, input) {
  const d = deps || {}, row = normalizeResult(input); if (!d.projects || !d.objectives || typeof d.appendReport !== 'function' || typeof d.getReport !== 'function') throw new Error('growth result requires project, objective, and report stores');
  const project = d.projects.get(row.projectId); if (!project) throw new Error('product project not found'); const objective = d.objectives.get(row.objectiveId);
  if (!objective || !project.linkedObjectiveIds.includes(objective.id) || objective.assignedRoleId !== 'business.growth_analyst' || !objective.classification || objective.classification.experimentId !== row.experimentId) throw new Error('growth result requires its linked Growth Analyst objective');
  if (objective.status !== 'completed') throw new Error('growth result requires a completed objective');
  const report = { id: 'growth-experiment-result:' + project.id + ':' + row.experimentId, type: 'growth-experiment-result', createdAt: typeof d.now === 'function' ? d.now() : Date.now(), headline: row.outcome.toUpperCase() + ' growth experiment: ' + project.title,
    completed: ['Observed value: ' + row.observedValue + '; sample size: ' + row.sampleSize + '.'], exceptions: row.outcome === 'inconclusive' ? [row.interpretation || 'Evidence was inconclusive.'] : [],
    decisions: [row.outcome.toUpperCase() + ': ' + (row.interpretation || 'Result recorded from completed specialist work and cited evidence.')], nextActions: [row.nextAction || (row.outcome === 'supported' ? 'Review whether a separately approved next experiment is warranted.' : 'Do not scale this approach without new reviewed evidence.')], sourceRefs: ['product-project:' + project.id, 'objective:' + objective.id].concat(row.evidenceRefs) };
  const normalized = normalizeSharedReport(report), prior = d.getReport(report.id); if (prior && !sameReport(prior, normalized)) throw new Error('growth experiment result already recorded differently');
  const saved = prior ? { added: false, report: prior } : await d.appendReport(report), linked = await d.projects.link(project.id, { reportIds: [saved.report.id] });
  return { schema: 'pine-star.growth-experiment-result.v1', idempotent: !saved.added, result: row, project: linked, objective, report: saved.report, spendingAuthorityUsd: 0, externalAction: false };
}
module.exports = { normalizePlan, planGrowthExperiment, normalizeResult, finalizeGrowthExperiment };
