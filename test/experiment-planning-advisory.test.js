'use strict';
const A = require('./_assert.js');
const { appendSharedReport } = require('../sidecar/memory-store.js');
const { createExperimentPlanningAdvisory } = require('../sidecar/experiment-planning-advisory.js');

let reports = [{ id: 'champion-challenger:incomplete', type: 'champion-challenger-evaluation', headline: 'Inconclusive', evaluationLessons: [
  { kind: 'missing_run_measurement', arm: 'challenger', configurationId: 'research-v2', proxyDimension: 'measured_runs', observed: 'One run was missing.', futureDesign: 'Capture one measured run for every objective before evaluation.' },
  { kind: 'small_cohort', arm: 'champion', configurationId: 'research-v1', proxyDimension: 'objective_count', observed: 'One objective.', futureDesign: 'Use at least two disjoint settled objectives for this arm.' }
], sourceRefs: ['objective:n1'] }];
const store = { get: () => reports, update: async (key, fn) => { const next = await fn(reports); if (next !== undefined) reports = next; return next; } };
const deps = { getReport: id => reports.find(row => row.id === id) || null, appendReport: report => appendSharedReport(store, report), now: () => 900 };

(async () => {
  const spec = { advisoryId: 'research-next', question: 'How should a future research comparison close known evidence gaps?', evaluationReportIds: ['champion-challenger:incomplete'] };
  const out = await createExperimentPlanningAdvisory(deps, spec);
  A.eq(out.report.type, 'experiment-planning-advisory', 'creates a report-only planning advisory');
  A.eq(out.report.completed.length, 2, 'projects retained lessons into bounded design requirements');
  A.eq(out.report.evaluationLessons.length, 2, 'preserves structured source lessons');
  A.ok(out.report.sourceRefs.includes('report:champion-challenger:incomplete'), 'retains evaluation-report provenance');
  A.eq(out.configurationSelected, false, 'does not select configuration');
  A.eq(out.objectiveCreated, false, 'does not create an objective');
  A.eq(out.experimentScheduled, false, 'does not schedule an experiment');
  A.eq(out.rerunPerformed, false, 'does not rerun an experiment');
  A.eq(out.configurationChanged, false, 'does not change configuration');
  A.eq(out.activationPerformed, false, 'does not activate configuration');
  A.eq(out.spendingAuthorityUsd, 0, 'grants zero spending authority');
  A.eq(out.externalAction, false, 'performs no external action');
  A.eq((await createExperimentPlanningAdvisory(deps, spec)).idempotent, true, 'stable retry is idempotent');
  let conflict = false; try { await createExperimentPlanningAdvisory(deps, Object.assign({}, spec, { question: 'Changed question' })); } catch (e) { conflict = /differently/.test(e.message); } A.ok(conflict, 'stable identity rejects changed advisory');
  let missing = false; try { await createExperimentPlanningAdvisory(deps, { advisoryId: 'missing', question: 'Question?', evaluationReportIds: ['missing'] }); } catch (e) { missing = /existing champion/.test(e.message); } A.ok(missing, 'requires existing evaluation reports');
  let noLessons = false; reports.push({ id: 'champion-challenger:none', type: 'champion-challenger-evaluation', evaluationLessons: [] }); try { await createExperimentPlanningAdvisory(deps, { advisoryId: 'none', question: 'Question?', evaluationReportIds: ['champion-challenger:none'] }); } catch (e) { noLessons = /retained evaluation lessons/.test(e.message); } A.ok(noLessons, 'requires retained lessons');
  let control = false; try { await createExperimentPlanningAdvisory(deps, Object.assign({}, spec, { configurationId: 'research-v2' })); } catch (e) { control = /cannot select/.test(e.message); } A.ok(control, 'rejects configuration selection inputs');
  let schedule = false; try { await createExperimentPlanningAdvisory(deps, Object.assign({}, spec, { scheduledAt: 1000 })); } catch (e) { schedule = /cannot select/.test(e.message); } A.ok(schedule, 'rejects scheduling inputs');
  A.report('experiment-planning-advisory.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
