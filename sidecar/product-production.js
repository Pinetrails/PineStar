'use strict';
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function list(v, cap, n) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, n)).filter(Boolean))].slice(0, cap); }
function normalizeProductionPlan(input) {
  const row = input && typeof input === 'object' ? input : {}, projectId = text(row.projectId, 100), planId = text(row.planId, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!projectId || !planId) throw new Error('production plan requires stable projectId and planId');
  const deliverables = list(row.deliverables, 20, 240), qaChecklist = list(row.qaChecklist, 20, 240); if (!deliverables.length || !qaChecklist.length) throw new Error('production plan requires deliverables and QA checklist');
  return { projectId, planId, productSpecification: text(row.productSpecification, 1800), deliverables, qaChecklist, constraints: list(row.constraints, 12, 240), priority: ['low', 'normal', 'high'].includes(row.priority) ? row.priority : 'normal' };
}
async function createProductionPlan(deps, input) {
  const d = deps || {}, plan = normalizeProductionPlan(input); if (!d.projects || !d.objectives || typeof d.appendReport !== 'function') throw new Error('production workflow requires project, objective, and report stores');
  const project = d.projects.get(plan.projectId); if (!project) throw new Error('product project not found'); if (!['planned', 'production'].includes(project.status)) throw new Error('product project is not ready for production planning');
  let parent = d.objectives.find(x => x && x.classification && x.classification.workflow === 'product-production' && x.classification.projectId === project.id && x.classification.planId === plan.planId);
  if (!parent) parent = await d.objectives.create({ title: 'Coordinate production: ' + project.title, description: 'Coordinate a bounded specification, product preparation, and independent QA. Use existing Workshop/file provenance for real artifacts. Do not publish, spend, purchase, or create accounts.', requiredCapabilities: ['coordinate'], maxModelTier: 'balanced', priority: plan.priority, classification: { method: 'product-production-v1', matched: true, workflow: 'product-production', projectId: project.id, planId: plan.planId } });
  const detail = '\nDeliverables: ' + plan.deliverables.join('; ') + '\nConstraints: ' + (plan.constraints.join('; ') || 'none declared');
  const made = await d.objectives.decompose(parent.id, { decompositionId: 'product-production:' + project.id + ':' + plan.planId, children: [
    { title: 'Specify product: ' + project.title, description: 'Prepare a precise internal product specification and acceptance criteria. Do not claim artifacts exist.\nSpecification seed: ' + (plan.productSpecification || 'derive from linked research evidence') + detail, requiredCapabilities: ['specify_product'], maxModelTier: 'balanced', targetRoleId: 'business.product_designer', priority: plan.priority },
    { title: 'Prepare deliverables: ' + project.title, description: 'Prepare the named product deliverables through existing trusted workspace/Workshop paths and cite real artifact evidence. Draft only; do not list, publish, purchase, or spend.' + detail, requiredCapabilities: ['prepare_product'], maxModelTier: 'balanced', targetRoleId: 'business.product_designer', priority: plan.priority, dependsOn: [0] },
    { title: 'Quality review: ' + project.title, description: 'Independently verify real deliverable evidence against this checklist. Do not approve publication.\nQA checklist: ' + plan.qaChecklist.join('; '), requiredCapabilities: ['quality_review', 'verify'], maxModelTier: 'economy', targetRoleId: 'operations.quality_reviewer', priority: plan.priority, dependsOn: [1] }
  ] });
  const report = { id: 'product-production-plan:' + project.id + ':' + plan.planId, type: 'product-production-plan', createdAt: typeof d.now === 'function' ? d.now() : Date.now(), headline: 'Production plan created: ' + project.title, decisions: plan.deliverables, nextActions: ['Complete specification, prepare real deliverables, then pass independent QA.'], sourceRefs: ['product-project:' + project.id].concat([made.parent].concat(made.children).map(x => 'objective:' + x.id)) };
  const saved = await d.appendReport(report), linked = await d.projects.link(project.id, { objectiveIds: [made.parent.id].concat(made.children.map(x => x.id)), reportIds: [saved.report.id] });
  const updated = linked.status === 'planned' ? await d.projects.update(linked.id, { status: 'production', revision: linked.revision, deliverables: plan.deliverables, qaState: 'not_started', nextAction: 'Complete specification and linked deliverable preparation objectives' }) : linked;
  return { schema: 'pine-star.product-production-plan.v1', idempotent: made.idempotent && !saved.added, plan, project: updated, report: saved.report, parent: made.parent, children: made.children };
}
module.exports = { normalizeProductionPlan, createProductionPlan };
