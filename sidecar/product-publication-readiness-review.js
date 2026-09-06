'use strict';
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function list(v, cap, n) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, n)).filter(Boolean))].slice(0, cap); }
async function completePublicationReadinessReview(deps, input) {
  const d = deps || {}, row = input && typeof input === 'object' ? input : {}, projectId = text(row.projectId, 100), requestId = text(row.requestId, 100), objectiveId = text(row.objectiveId, 120), qaReportId = text(row.qaReportId, 120);
  if (!projectId || !requestId || !objectiveId || !qaReportId || row.scope !== 'internal-readiness-only') throw new Error('internal readiness review requires stable identities and explicit internal-only scope');
  if (!d.projects || !d.objectives || typeof d.getReport !== 'function' || typeof d.appendReport !== 'function' || typeof d.artifactExists !== 'function') throw new Error('internal readiness review dependencies unavailable');
  const project = d.projects.get(projectId), objective = d.objectives.get(objectiveId), qa = d.getReport(qaReportId);
  if (!project) throw new Error('product project not found');
  if (!objective || !objective.classification || objective.classification.workflow !== 'product-publication-approval' || objective.classification.projectId !== project.id || objective.classification.requestId !== requestId) throw new Error('protected review request identity mismatch');
  if (!qa || qa.type !== 'product-qa' || !project.linkedReportIds.includes(qa.id)) throw new Error('linked formal QA report not found');
  const coverage = Array.isArray(qa.deliverableEvidence) ? qa.deliverableEvidence : [], expected = list(project.deliverables, 20, 240);
  if (!expected.length || expected.some(name => !coverage.some(x => x && x.deliverable === name && d.artifactExists(x.artifactId)))) throw new Error('internal readiness review requires complete verified artifact coverage');
  const findings = list(row.findings, 20, 400), blockers = list(row.blockers, 12, 300), corrections = list(row.corrections, 12, 300);
  if (!findings.length) throw new Error('internal readiness review requires findings');
  const reportId = 'product-publication-readiness:' + project.id + ':' + requestId, prior = d.getReport(reportId);
  const report = { id: reportId, type: 'product-publication-readiness-review', createdAt: typeof d.now === 'function' ? d.now() : Date.now(), headline: (blockers.length ? 'BLOCKED' : 'READY') + ' INTERNAL PUBLICATION READINESS: ' + project.title,
    completed: findings, exceptions: blockers, decisions: ['Commander approval covered internal readiness review only; external publication remains unauthorized.', 'Pricing recommendation: ' + (text(row.pricingRecommendation, 300) || 'unsupported by current real evidence; leave price undecided.')],
    nextActions: blockers.length ? ['Resolve listed blockers and repeat the protected internal review.'] : ['Stop at the external publication authorization boundary; do not publish without a separate explicit authorization.'], sourceRefs: ['product-project:' + project.id, 'report:' + qa.id, 'objective:' + objective.id].concat(coverage.map(x => 'deliverable:' + x.artifactId)) };
  const sameReport = prior && ['type', 'headline', 'completed', 'exceptions', 'decisions', 'nextActions', 'sourceRefs'].every(key => JSON.stringify(prior[key] || []) === JSON.stringify(report[key] || []));
  if (prior && !sameReport) throw new Error('internal readiness review already recorded differently');
  const saved = prior ? { added: false, report: prior } : await d.appendReport(report);
  const completed = await d.objectives.completeInternalReview(objective.id, ['report:' + saved.report.id, 'report:' + qa.id].concat(coverage.map(x => 'deliverable:' + x.artifactId)));
  let revisionObjective = null, qaObjective = null, revisionParent = null;
  if (blockers.length || corrections.length) {
    revisionParent = d.objectives.find(x => x && x.classification && x.classification.workflow === 'product-publication-readiness-revision-plan' && x.classification.projectId === project.id && x.classification.requestId === requestId);
    if (!revisionParent) revisionParent = await d.objectives.create({ title: 'Coordinate internal publication-package revision: ' + project.title,
      description: 'Coordinate bounded internal package revision followed by separate independent QA. Preserve source files and evidence; do not publish, upload, access accounts, message externally, use credentials, or spend.', requiredCapabilities: ['coordinate'], maxModelTier: 'balanced', priority: 'high', protectedAction: false,
      classification: { method: 'product-publication-readiness-revision-plan-v2', workflow: 'product-publication-readiness-revision-plan', projectId: project.id, requestId, reviewReportId: saved.report.id } });
    const detail = '\nCorrections: ' + corrections.concat(blockers).join('; ');
    const graph = await d.objectives.decompose(revisionParent.id, { decompositionId: 'product-publication-readiness-revision:' + project.id + ':' + requestId, children: [
      { title: 'Revise internal publication package: ' + project.title, description: 'Prepare internal customer-package corrections through Pine Star-controlled working/output storage. Preserve read-only sources and provenance. Build only an internal candidate; do not independently verify, publish, upload, access accounts, message externally, use credentials, or spend.' + detail, requiredCapabilities: ['prepare_product'], maxModelTier: 'balanced', targetRoleId: 'business.product_designer', priority: 'high', protectedAction: false, classification: { method: 'product-publication-readiness-revision-v2', workflow: 'product-publication-readiness-revision', responsibility: 'preparation', projectId: project.id, requestId, reviewReportId: saved.report.id } },
      { title: 'Independently review revised publication package: ' + project.title, description: 'Independently verify the revised internal candidate, provenance, claim consistency, customer-document rendering/layout, and complete deliverable coverage. Do not approve or perform publication, upload, account access, external messaging, credential use, or spending.' + detail, requiredCapabilities: ['quality_review', 'verify'], maxModelTier: 'economy', targetRoleId: 'operations.quality_reviewer', priority: 'high', protectedAction: false, dependsOn: [0], classification: { method: 'product-publication-readiness-revision-qa-v1', workflow: 'product-publication-readiness-revision-qa', responsibility: 'independent_qa', projectId: project.id, requestId, reviewReportId: saved.report.id } }
    ] });
    revisionParent = graph.parent; revisionObjective = graph.children[0]; qaObjective = graph.children[1];
  }
  let current = await d.projects.link(project.id, { reportIds: [saved.report.id], objectiveIds: revisionObjective ? [revisionParent.id, revisionObjective.id, qaObjective.id] : [] });
  if (current.status === 'approval_required') current = await d.projects.update(current.id, { status: 'listing_ready', revision: current.revision, blockers, nextAction: blockers.length ? 'Resolve internal publication-readiness blockers' : 'Await separate explicit external publication authorization' }, { internalReadinessReviewCompleted: true });
  if (revisionObjective && current.status === 'listing_ready') current = await d.projects.update(current.id, { status: 'qa', qaState: 'in_progress', revision: current.revision, blockers, nextAction: 'Complete the linked internal package revision and re-run QA' });
  return { schema: 'pine-star.product-publication-readiness-review.v1', idempotent: !!prior, ready: !blockers.length, corrections, project: current, objective: completed, revisionParent, revisionObjective, qaObjective, report: saved.report, externalAction: false, publicationAuthorized: false, publicationPerformed: false, spendingAuthorityUsd: 0 };
}
module.exports = { completePublicationReadinessReview };
