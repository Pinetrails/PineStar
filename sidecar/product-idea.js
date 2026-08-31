'use strict';
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function list(v, cap, n) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, n)).filter(Boolean))].slice(0, cap); }
function normalizeIdea(input) {
  const row = input && typeof input === 'object' ? input : {}, ideaId = text(row.ideaId, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''), title = text(row.title, 200);
  if (!ideaId) throw new Error('product idea requires a stable ideaId'); if (!title) throw new Error('product idea requires a title');
  return { ideaId, title, description: text(row.description, 1600), productType: text(row.productType, 100) || 'digital-product', targetCustomer: text(row.targetCustomer, 500),
    targetMarketplaces: list(row.targetMarketplaces, 8, 100), assumptions: list(row.assumptions, 12, 240), assetRequirements: list(row.assetRequirements, 20, 240), priority: ['low', 'normal', 'high'].includes(row.priority) ? row.priority : 'normal' };
}
function productIdeaReport(idea, project, parent, children, at) {
  const objectiveIds = [parent.id].concat(children.map(x => x.id));
  return { id: 'product-idea:' + idea.ideaId, type: 'product-idea-intake', createdAt: Math.max(0, Number(at) || 0),
    headline: 'Idea Lab intake created: ' + idea.title,
    decisions: ['Created a zero-spend product project and a bounded research-to-concept workflow.'],
    nextActions: ['Complete market validation before the dependent Idea Lab concept brief.'],
    sourceRefs: ['product-project:' + project.id].concat(objectiveIds.map(id => 'objective:' + id)) };
}
async function intakeProductIdea(deps, input) {
  const d = deps || {}, idea = normalizeIdea(input); if (!d.projects || !d.objectives || typeof d.appendReport !== 'function') throw new Error('product idea workflow requires project, objective, and report stores');
  const made = await d.projects.create({ projectId: idea.ideaId, title: idea.title, description: idea.description, productType: idea.productType, targetCustomer: idea.targetCustomer,
    targetMarketplaces: idea.targetMarketplaces, assetRequirements: idea.assetRequirements, status: 'idea', nextAction: 'Complete market validation and product concept brief' });
  let parent = d.objectives.find(x => x && x.classification && x.classification.productIdeaId === idea.ideaId && x.classification.workflow === 'product-idea-intake');
  if (!parent) parent = await d.objectives.create({ title: 'Coordinate product idea: ' + idea.title,
    description: 'Coordinate bounded market validation and a product concept brief. Do specialist work at the lowest capable role; do not publish, purchase, create accounts, or spend.',
    requiredCapabilities: ['coordinate'], maxModelTier: 'balanced', priority: idea.priority,
    classification: { method: 'product-idea-v1', matched: true, workflow: 'product-idea-intake', productIdeaId: idea.ideaId, projectId: made.project.id } });
  const decomposition = await d.objectives.decompose(parent.id, { decompositionId: 'product-idea:' + idea.ideaId, children: [
    { title: 'Validate market need: ' + idea.title, description: 'Research the target customer, problem, alternatives, demand evidence, marketplace fit, and material risks. Cite evidence; do not buy, message, create accounts, or publish.\nAssumptions: ' + (idea.assumptions.join('; ') || 'none declared'), requiredCapabilities: ['research', 'verify'], maxModelTier: 'economy', targetRoleId: 'research.general_researcher', priority: idea.priority },
    { title: 'Prepare product concept brief: ' + idea.title, description: 'Using the completed research objective, recommend a bounded product concept, scope, differentiators, asset plan, and go/no-go rationale. Draft only; do not publish or spend.', requiredCapabilities: ['product_ideation', 'recommend'], maxModelTier: 'economy', targetRoleId: 'business.idea_lab', priority: idea.priority, dependsOn: [0] }
  ] });
  const ids = [decomposition.parent.id].concat(decomposition.children.map(x => x.id));
  const saved = await d.appendReport(productIdeaReport(idea, made.project, decomposition.parent, decomposition.children, typeof d.now === 'function' ? d.now() : Date.now()));
  const linked = await d.projects.link(made.project.id, { objectiveIds: ids, reportIds: [saved.report.id] });
  const project = linked.status === 'idea' ? await d.projects.update(linked.id, { status: 'research', revision: linked.revision, nextAction: 'Complete linked market validation before the concept brief' }) : linked;
  return { schema: 'pine-star.product-idea-intake.v1', idempotent: made.idempotent && decomposition.idempotent && !saved.added, idea, project, report: saved.report, parent: decomposition.parent, children: decomposition.children };
}
module.exports = { normalizeIdea, productIdeaReport, intakeProductIdea };
