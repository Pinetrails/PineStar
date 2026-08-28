'use strict';
const A = require('./_assert.js');
const { composeMorningBrief } = require('../sidecar/morning-brief.js');
const end = Date.UTC(2026, 7, 27, 12), start = end - 86400000;
const report = composeMorningBrief({ periodStart: start, periodEnd: end, objectives: [
  { id: 'done', title: 'Ship safe bridge', status: 'completed', settledAt: end - 9, resultSummary: 'Focused tests passed' },
  { id: 'work', title: 'Active work', status: 'in_progress', updatedAt: end - 8 },
  { id: 'fail', title: 'Broken task', status: 'failed', settledAt: end - 7, settlementReason: 'provider unavailable' },
  { id: 'approval', title: 'Publish release', status: 'approval_required', updatedAt: end - 6 },
  { id: 'audit', title: 'Verify bridge', assignedRoleId: 'operations.auditor', status: 'failed', settledAt: end - 5, resultSummary: 'Evidence exception' },
  { id: 'old', title: 'Old work', status: 'completed', settledAt: start }
], reports: [{ id: 'scout:1', type: 'open-source-scout', createdAt: end - 4, discoveries: [
  { name: 'Useful tool', source: 'fixture', reference: 'https://example.invalid/tool', recommendation: 'TEST', recommendedOwnerRoleId: 'development.integration_engineer' }
] }], runs: [{ runId: 'r1', ts: end - 3, usd: 0.125 }, { runId: 'old-run', ts: start, usd: 9 }] });
A.eq(report.type, 'morning-brief', 'uses shared Morning Brief report type');
A.eq(report.completed.length, 1, 'only in-period completion is summarized');
A.ok(report.exceptions.some(x => /Broken task/.test(x)) && report.exceptions.some(x => /Publish release/.test(x)), 'failures and approvals remain visible');
A.ok(report.nextActions.some(x => /Continue monitoring/.test(x)) && report.nextActions.some(x => /^TEST: Useful tool/.test(x)), 'active work and actionable Scout findings become bounded next actions');
A.eq(report.discoveries.length, 1, 'Scout evidence is retained');
A.ok(report.decisions[0].includes('$0.1250') && !report.decisions[0].includes('9.0000'), 'only real in-period run cost is reported');
A.ok(report.sourceRefs.includes('objective:done') && report.sourceRefs.includes('report:scout:1') && report.sourceRefs.includes('run:r1'), 'durable evidence references are attached');
const noCost = composeMorningBrief({ periodStart: start, periodEnd: end, objectives: [], reports: [], runs: [] });
A.eq(noCost.decisions.length, 0, 'missing cost data stays absent rather than invented');
A.eq(noCost.completed.length, 0, 'empty periods remain truthful');
A.report('morning-brief.test');
