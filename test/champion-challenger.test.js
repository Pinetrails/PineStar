'use strict';
const A = require('./_assert.js'); const { appendSharedReport } = require('../sidecar/memory-store.js'); const { evaluateConfigurations } = require('../sidecar/champion-challenger.js');
let reports; const store = { get: () => reports, update: async (k, fn) => { const n = await fn(reports); if (n !== undefined) reports = n; return n; } };
const objectives = [
  { id: 'c1', status: 'completed', assignedRoleId: 'research.general_researcher', admittedRunId: 'r1', completionEvidenceRefs: ['report:c1'] },
  { id: 'c2', status: 'failed', assignedRoleId: 'research.general_researcher', admittedRunId: 'r2', completionEvidenceRefs: [] },
  { id: 'n1', status: 'completed', assignedRoleId: 'research.general_researcher', admittedRunId: 'r3', completionEvidenceRefs: ['report:n1'] },
  { id: 'n2', status: 'completed', assignedRoleId: 'research.general_researcher', admittedRunId: 'r4', completionEvidenceRefs: ['report:n2'] }
];
const runs = [{ runId: 'r1', usd: .2 }, { runId: 'r2', usd: .2 }, { runId: 'r3', usd: .1 }, { runId: 'r4', usd: .1 }];
const deps = { objectives, runs, appendReport: r => appendSharedReport(store, r), getReport: id => (reports || []).find(x => x.id === id) || null, now: () => 500 };
(async () => {
  const spec = { evaluationId: 'research-v2', champion: { configurationId: 'research-v1', objectiveIds: ['c1', 'c2'] }, challenger: { configurationId: 'research-v2', objectiveIds: ['n1', 'n2'] } };
  const out = await evaluateConfigurations(deps, spec); A.eq(out.verdict, 'challenger_recommended', 'strict no-worse complete evidence can recommend challenger'); A.eq(out.evidenceComplete, true, 'matched runs, adequate cohorts, and completion evidence pass the evidence gate'); A.eq(out.configurationChanged, false, 'evaluation cannot change configuration'); A.eq(out.activationPerformed, false, 'evaluation cannot activate configuration'); A.eq(out.spendingAuthorityUsd, 0, 'evaluation grants zero spend'); A.ok(out.report.sourceRefs.includes('run:r4') && out.report.sourceRefs.includes('evaluation-evidence:complete-v1'), 'report retains run provenance and complete-evidence marker');
  A.eq((await evaluateConfigurations(deps, spec)).idempotent, true, 'stable retry is idempotent');
  let conflict = false; try { await evaluateConfigurations(deps, Object.assign({}, spec, { challenger: { configurationId: 'research-v3', objectiveIds: ['n1', 'n2'] } })); } catch (e) { conflict = /differently/.test(e.message); } A.ok(conflict, 'stable identity rejects changed cohort');
  let overlap = false; try { await evaluateConfigurations(deps, { evaluationId: 'overlap', champion: { configurationId: 'a', objectiveIds: ['c1'] }, challenger: { configurationId: 'b', objectiveIds: ['c1'] } }); } catch (e) { overlap = /share/.test(e.message); } A.ok(overlap, 'cohorts cannot share objectives');
  let active = false; try { await evaluateConfigurations(Object.assign({}, deps, { objectives: objectives.concat({ id: 'active', status: 'assigned', assignedRoleId: 'research.general_researcher' }) }), { evaluationId: 'active', champion: { configurationId: 'a', objectiveIds: ['active'] }, challenger: { configurationId: 'b', objectiveIds: ['n1'] } }); } catch (e) { active = /settled/.test(e.message); } A.ok(active, 'only settled evidence is evaluated');
  const uncertain = await evaluateConfigurations(Object.assign({}, deps, { runs: runs.map(r => r.runId === 'r3' ? Object.assign({}, r, { uncertainMutations: [{ callId: 'x' }] }) : r) }), Object.assign({}, spec, { evaluationId: 'uncertain' })); A.eq(uncertain.verdict, 'inconclusive', 'uncertain mutations prevent a promotion recommendation');
  const missingRun = await evaluateConfigurations(Object.assign({}, deps, { runs: runs.filter(r => r.runId !== 'r4') }), Object.assign({}, spec, { evaluationId: 'missing-run' })); A.eq(missingRun.verdict, 'inconclusive', 'missing measured run evidence prevents recommendation');
  const weak = await evaluateConfigurations(deps, { evaluationId: 'weak', champion: { configurationId: 'a', objectiveIds: ['c1'] }, challenger: { configurationId: 'b', objectiveIds: ['n1'] } }); A.eq(weak.verdict, 'inconclusive', 'one-item cohorts remain too weak to recommend');
  A.report('champion-challenger.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
