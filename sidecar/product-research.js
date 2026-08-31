'use strict';
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function list(v, cap, n) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, n)).filter(Boolean))].slice(0, cap); }
function normalizeResearchDecision(input) {
  const row = input && typeof input === 'object' ? input : {}, projectId = text(row.projectId, 100), researchObjectiveId = text(row.researchObjectiveId, 120), conceptObjectiveId = text(row.conceptObjectiveId, 120);
  const decision = ['go', 'revise', 'stop'].includes(row.decision) ? row.decision : '';
  if (!projectId || !researchObjectiveId || !conceptObjectiveId) throw new Error('product research decision requires project and objective IDs');
  if (!decision) throw new Error('product research decision must be go, revise, or stop');
  const evidenceRefs = list(row.evidenceRefs, 20, 300); if (!evidenceRefs.length) throw new Error('product research decision requires evidence');
  return { projectId, researchObjectiveId, conceptObjectiveId, decision, rationale: text(row.rationale, 1200), findings: list(row.findings, 10, 240), risks: list(row.risks, 10, 240), evidenceRefs };
}
function researchReport(row, project, at) {
  const label = row.decision.toUpperCase();
  return { id: 'product-research:' + project.id, type: 'product-research-decision', createdAt: Math.max(0, Number(at) || 0),
    headline: label + ' product research decision: ' + project.title,
    completed: row.findings, exceptions: row.risks,
    decisions: [label + ': ' + (row.rationale || 'Decision recorded from completed linked research and concept objectives.')],
    nextActions: [row.decision === 'go' ? 'Prepare the bounded product plan and deliverable specification.' : row.decision === 'revise' ? 'Revise the concept or collect the named missing evidence.' : 'Stop further production work unless a later reviewed decision supersedes this record.'],
    sourceRefs: ['product-project:' + project.id, 'objective:' + row.researchObjectiveId, 'objective:' + row.conceptObjectiveId].concat(row.evidenceRefs) };
}
async function finalizeProductResearch(deps, input) {
  const d = deps || {}, row = normalizeResearchDecision(input);
  if (!d.projects || !d.objectives || typeof d.appendReport !== 'function' || typeof d.getReport !== 'function') throw new Error('product research workflow requires project, objective, and report stores');
  const project = d.projects.get(row.projectId); if (!project) throw new Error('product project not found');
  if (project.status !== 'research' && project.status !== 'planned') throw new Error('product project is not in research');
  const research = d.objectives.get(row.researchObjectiveId), concept = d.objectives.get(row.conceptObjectiveId);
  for (const objective of [research, concept]) if (!objective || !project.linkedObjectiveIds.includes(objective.id)) throw new Error('research decision objective is not linked to project');
  if (research.assignedRoleId !== 'research.general_researcher' || concept.assignedRoleId !== 'business.idea_lab') throw new Error('research decision requires Researcher and Idea Lab objectives');
  if (research.status !== 'completed' || concept.status !== 'completed') throw new Error('research decision requires completed specialist objectives');
  const draft = researchReport(row, project, typeof d.now === 'function' ? d.now() : Date.now()), prior = d.getReport(draft.id);
  if (prior && prior.headline !== draft.headline) throw new Error('product research decision already recorded differently');
  const saved = prior ? { added: false, report: prior } : await d.appendReport(draft);
  const linked = await d.projects.link(project.id, { reportIds: [saved.report.id] });
  let updated = linked;
  if (row.decision === 'go' && linked.status === 'research') updated = await d.projects.update(linked.id, { status: 'planned', revision: linked.revision, blockers: [], nextAction: 'Prepare product specification and deliverable plan', evidenceRefs: row.evidenceRefs });
  if (row.decision !== 'go' && linked.status === 'research') updated = await d.projects.update(linked.id, { revision: linked.revision, blockers: row.risks.length ? row.risks : ['Research decision: ' + row.decision], nextAction: row.decision === 'revise' ? 'Revise concept or collect missing evidence' : 'Hold production pending a later reviewed decision', evidenceRefs: row.evidenceRefs });
  return { schema: 'pine-star.product-research-decision.v1', idempotent: !saved.added && updated.revision === linked.revision, decision: row.decision, project: updated, report: saved.report, objectives: [research, concept] };
}
module.exports = { normalizeResearchDecision, researchReport, finalizeProductResearch };
