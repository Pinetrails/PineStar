'use strict';
const A = require('./_assert.js');
const { finalizeProductResearch, normalizeResearchDecision } = require('../sidecar/product-research.js');
function store(project, objectives) {
  const reports = [], state = { project };
  return { deps: { projects: { get: id => state.project.id === id ? state.project : null, link: async (id, x) => { if (!x.reportIds.every(r => reports.some(v => v.id === r))) throw new Error('missing report'); if (!state.project.linkedReportIds.includes(x.reportIds[0])) state.project = Object.assign({}, state.project, { linkedReportIds: state.project.linkedReportIds.concat(x.reportIds), revision: state.project.revision + 1 }); return state.project; }, update: async (id, patch) => { if (patch.revision !== state.project.revision) throw new Error('revision conflict'); state.project = Object.assign({}, state.project, patch, { revision: state.project.revision + 1 }); delete state.project.revision; state.project.revision = project.revision + (state.project.linkedReportIds.length ? 2 : 1); return state.project; } },
    objectives: { get: id => objectives.find(x => x.id === id) }, appendReport: async report => { reports.push(report); return { added: true, report }; }, getReport: id => reports.find(x => x.id === id), now: () => 500 }, state, reports };
}
(async () => {
  const project = { id: 'trail-kit', title: 'Trail Kit', status: 'research', revision: 1, linkedObjectiveIds: ['r1', 'i1'], linkedReportIds: [], blockers: [] };
  const objectives = [{ id: 'r1', assignedRoleId: 'research.general_researcher', status: 'completed' }, { id: 'i1', assignedRoleId: 'business.idea_lab', status: 'completed' }];
  const s = store(project, objectives), input = { projectId: 'trail-kit', researchObjectiveId: 'r1', conceptObjectiveId: 'i1', decision: 'go', rationale: 'Demand evidence and a bounded differentiated concept support planning.', findings: ['Customers need a compact planning aid'], risks: ['Demand evidence is limited'], evidenceRefs: ['report:market-fixture'] };
  A.eq(normalizeResearchDecision(input).decision, 'go', 'bounded decision normalizes');
  const result = await finalizeProductResearch(s.deps, input);
  A.eq(result.project.status, 'planned', 'supported go decision advances research to planning');
  A.eq(result.project.spendingAuthorityUsd, undefined, 'workflow grants no spending field or authority');
  A.eq(result.project.linkedReportIds, ['product-research:trail-kit'], 'decision report links to the project');
  A.eq(result.report.sourceRefs.length, 4, 'report links project, both objectives, and evidence');
  A.eq((await finalizeProductResearch(s.deps, input)).idempotent, true, 'same decision retry is idempotent');
  let pending = false; try { await finalizeProductResearch(store(project, [objectives[0], Object.assign({}, objectives[1], { status: 'assigned' })]).deps, input); } catch (e) { pending = /completed/.test(e.message); } A.ok(pending, 'unfinished specialist work blocks the decision');
  let noEvidence = false; try { normalizeResearchDecision(Object.assign({}, input, { evidenceRefs: [] })); } catch (e) { noEvidence = /evidence/.test(e.message); } A.ok(noEvidence, 'evidence-free decisions are rejected');
  A.report('product-research.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
