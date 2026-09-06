'use strict';
const { normalizeSharedReport } = require('./memory-store.js');

function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
function slug(value) { return text(value, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); }
function ids(value) { return [...new Set((Array.isArray(value) ? value : []).map(x => text(x, 120)).filter(Boolean))].slice(0, 12); }
function sameReport(a, b) { return !!a && ['headline', 'completed', 'exceptions', 'decisions', 'nextActions', 'sourceRefs', 'evaluationLessons'].every(k => JSON.stringify(a[k]) === JSON.stringify(b[k])); }

function rejectControlInputs(input) {
  const forbidden = ['configurationId', 'candidateId', 'champion', 'challenger', 'objectiveIds', 'schedule', 'scheduledAt', 'activate', 'admit', 'retire', 'rerun'];
  if (forbidden.some(key => Object.prototype.hasOwnProperty.call(input, key))) {
    throw new Error('experiment-planning advisory cannot select configurations, cohorts, schedules, reruns, or control actions');
  }
}

async function createExperimentPlanningAdvisory(deps, input) {
  const d = deps || {}, x = input && typeof input === 'object' ? input : {};
  rejectControlInputs(x);
  const advisoryId = slug(x.advisoryId), question = text(x.question, 240), reportIds = ids(x.evaluationReportIds);
  if (!advisoryId || !question || !reportIds.length) throw new Error('experiment-planning advisory requires a stable ID, question, and evaluation report IDs');
  if (typeof d.getReport !== 'function' || typeof d.appendReport !== 'function') throw new Error('experiment-planning advisory requires report sources');
  const reports = reportIds.map(id => d.getReport(id));
  if (reports.some(report => !report || report.type !== 'champion-challenger-evaluation')) throw new Error('experiment-planning advisory requires existing champion/challenger evaluation reports');
  const lessons = reports.flatMap(report => Array.isArray(report.evaluationLessons) ? report.evaluationLessons : []).slice(0, 20);
  if (!lessons.length) throw new Error('experiment-planning advisory requires retained evaluation lessons');
  const requirements = [...new Set(lessons.map(lesson => text(lesson && lesson.futureDesign, 240)).filter(Boolean))].slice(0, 10);
  const id = 'experiment-planning-advisory:' + advisoryId;
  const report = normalizeSharedReport({ id, type: 'experiment-planning-advisory', createdAt: typeof d.now === 'function' ? d.now() : Date.now(),
    headline: 'Advisory experiment design: ' + question,
    completed: requirements,
    exceptions: ['This advisory does not select a configuration or cohort and does not schedule or re-run an experiment.'],
    decisions: ['No configuration decision was made; retained lessons are design evidence for Commander review only.'],
    nextActions: ['Commander may review the question and design requirements before separately authorizing any future experiment.'],
    sourceRefs: reportIds.map(id => 'report:' + id), evaluationLessons: lessons });
  const prior = d.getReport(id);
  if (prior && !sameReport(prior, report)) throw new Error('experiment-planning advisory already recorded differently');
  const saved = prior ? { added: false, report: prior } : await d.appendReport(report);
  return { schema: 'pine-star.experiment-planning-advisory.v1', idempotent: !saved.added, report: saved.report,
    advisoryOnly: true, configurationSelected: false, objectiveCreated: false, experimentScheduled: false, rerunPerformed: false,
    configurationChanged: false, activationPerformed: false, spendingAuthorityUsd: 0, externalAction: false };
}

module.exports = { createExperimentPlanningAdvisory, rejectControlInputs };
