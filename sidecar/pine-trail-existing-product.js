'use strict';

function text(value, limit) { return String(value == null ? '' : value).trim().slice(0, limit); }
function list(value, cap, limit) { return [...new Set((Array.isArray(value) ? value : []).map(item => text(item, limit)).filter(Boolean))].slice(0, cap); }
function slug(value) { return text(value, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); }

function normalizeExistingProduct(input) {
  const row = input && typeof input === 'object' ? input : {};
  const productId = slug(row.productId), title = text(row.title, 200), productType = text(row.productType, 100);
  if (!productId || !title || !productType) throw new Error('existing Pine Trail product requires stable productId, title, and productType');
  const deliverables = list(row.deliverables, 20, 240), evidenceRefs = list(row.evidenceRefs, 24, 300);
  if (!deliverables.length || !evidenceRefs.length) throw new Error('existing Pine Trail product requires deliverables and source evidence');
  const verifiedFacts = list(row.verifiedFacts, 20, 240), unknowns = list(row.unknowns, 12, 240);
  if (!verifiedFacts.length) throw new Error('existing Pine Trail product requires verified facts');
  return {
    productId: 'pine-trail-' + productId.replace(/^pine-trail-/, ''), title, productType: 'pine-trail-existing:' + productType,
    description: text(row.description, 2000), targetCustomer: text(row.targetCustomer, 500), targetMarketplaces: list(row.targetMarketplaces, 8, 100),
    deliverables, evidenceRefs, verifiedFacts, unknowns, assetRequirements: list(row.assetRequirements, 20, 240),
    priority: ['low', 'normal', 'high'].includes(row.priority) ? row.priority : 'normal'
  };
}

async function intakeExistingPineTrailProduct(deps, input) {
  const d = deps || {}, product = normalizeExistingProduct(input);
  if (!d.projects || !d.objectives || typeof d.appendReport !== 'function') throw new Error('existing Pine Trail product workflow requires project, objective, and report stores');
  const made = await d.projects.create({
    projectId: product.productId, title: product.title, description: product.description, productType: product.productType,
    status: 'production', targetCustomer: product.targetCustomer, targetMarketplaces: product.targetMarketplaces,
    assetRequirements: product.assetRequirements, deliverables: product.deliverables, evidenceRefs: product.evidenceRefs,
    blockers: product.unknowns, qaState: 'not_started', notes: 'Imported from read-only existing-product evidence; no source files were modified or copied.',
    nextAction: 'Reconcile the imported package, then complete independent QA against the recorded evidence and unknowns'
  });
  const project = made.project;
  let parent = d.objectives.find(item => item && item.classification && item.classification.workflow === 'pine-trail-existing-product' && item.classification.projectId === project.id);
  if (!parent) parent = await d.objectives.create({
    title: 'Coordinate existing product review: ' + product.title,
    description: 'Coordinate bounded reconciliation and independent QA of an existing read-only Pine Trail product package. Do not modify source files, publish, upload, create accounts, purchase, subscribe, or spend.',
    requiredCapabilities: ['coordinate'], maxModelTier: 'balanced', priority: product.priority,
    classification: { method: 'pine-trail-existing-product-v1', matched: true, workflow: 'pine-trail-existing-product', projectId: project.id }
  });
  const detail = '\nDeliverables: ' + product.deliverables.join('; ') + '\nVerified facts: ' + product.verifiedFacts.join('; ') + '\nUnknowns: ' + (product.unknowns.join('; ') || 'none recorded');
  const graph = await d.objectives.decompose(parent.id, { decompositionId: 'pine-trail-existing-product:' + project.id, children: [
    { title: 'Reconcile existing package: ' + product.title, description: 'Reconcile the read-only package inventory and documentation. Preserve discrepancies and unknowns; do not alter source files. Independent verification belongs to the dependent Quality Reviewer.' + detail, requiredCapabilities: ['prepare_product'], maxModelTier: 'balanced', targetRoleId: 'business.product_designer', priority: product.priority },
    { title: 'Independently review existing package: ' + product.title, description: 'Independently verify the package against its stated scope, file integrity, transparency, metadata, documentation, branding, and distribution-safety requirements. Sampling must not be represented as exhaustive visual review. Do not approve publication.' + detail, requiredCapabilities: ['quality_review', 'verify'], maxModelTier: 'economy', targetRoleId: 'operations.quality_reviewer', priority: product.priority, dependsOn: [0] }
  ] });
  const report = {
    id: 'pine-trail-existing-product:' + project.id, type: 'pine-trail-existing-product-evidence', createdAt: typeof d.now === 'function' ? d.now() : Date.now(),
    headline: 'Existing Pine Trail product evidence recorded: ' + product.title,
    completed: product.verifiedFacts, exceptions: product.unknowns,
    decisions: ['Recorded existing files as read-only evidence; QA and publication are not approved.'],
    nextActions: ['Complete package reconciliation and independent QA through the linked objectives.'],
    sourceRefs: ['product-project:' + project.id].concat(product.evidenceRefs, [graph.parent].concat(graph.children).map(item => 'objective:' + item.id))
  };
  const saved = await d.appendReport(report);
  const linked = await d.projects.link(project.id, { objectiveIds: [graph.parent.id].concat(graph.children.map(item => item.id)), reportIds: [saved.report.id] });
  return { schema: 'pine-star.pine-trail-existing-product.v1', idempotent: made.idempotent && graph.idempotent && !saved.added, product, project: linked, report: saved.report, parent: graph.parent, children: graph.children, externalAction: false, spendingAuthorityUsd: 0 };
}

module.exports = { normalizeExistingProduct, intakeExistingPineTrailProduct };
