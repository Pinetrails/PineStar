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
] }, { id: 'product-research:trail-kit', type: 'product-research-decision', createdAt: end - 2, decisions: ['GO: Evidence supports planning.'], nextActions: ['Prepare the bounded product plan.'] }, { id: 'growth-experiment-result:trail-kit:title', type: 'growth-experiment-result', createdAt: end - 1, decisions: ['SUPPORTED: observed target exceeded.'], nextActions: ['Review a separate next experiment.'] }], runs: [{ runId: 'r1', ts: end - 3, usd: 0.125 }, { runId: 'old-run', ts: start, usd: 9 }], businessSummary: { entryCount: 2, revenueUsd: 12.5, expenseUsd: 2, refundUsd: 0, netUsd: 10.5, sourceRefs: ['business-entry:sale-1', 'business-entry:fee-1'] }, productSummary: { decisions: ['Product pipeline: 2 total; 1 listing-ready.'], exceptions: ['Failed QA: Tracker'], nextActions: ['Resolve failed QA: Tracker'], sourceRefs: ['product-project:tracker'] } });
A.eq(report.type, 'morning-brief', 'uses shared Morning Brief report type');
A.eq(report.completed.length, 1, 'only in-period completion is summarized');
A.ok(report.exceptions.some(x => /Broken task/.test(x)) && report.exceptions.some(x => /Publish release/.test(x)), 'failures and approvals remain visible');
A.ok(report.nextActions.some(x => /Continue monitoring/.test(x)) && report.nextActions.some(x => /^TEST: Useful tool/.test(x)), 'active work and actionable Scout findings become bounded next actions');
A.eq(report.discoveries.length, 1, 'Scout evidence is retained');
A.ok(report.decisions[0].includes('$0.1250') && !report.decisions[0].includes('9.0000'), 'only real in-period run cost is reported');
A.ok(report.decisions.includes('GO: Evidence supports planning.') && report.nextActions.includes('Prepare the bounded product plan.'), 'business research decisions enter the Morning Brief through shared reports');
A.ok(report.decisions.some(x => /\$12\.50 revenue/.test(x) && /net \$10\.50/.test(x)), 'recorded business activity enters the Morning Brief without estimates');
A.ok(report.sourceRefs.includes('business-entry:sale-1'), 'business summary provenance enters the Morning Brief');
A.ok(report.decisions.includes('SUPPORTED: observed target exceeded.') && report.nextActions.includes('Review a separate next experiment.'), 'growth outcomes enter the Business Morning Brief');
A.ok(report.decisions.some(x => /^Product pipeline:/.test(x)) && report.exceptions.includes('Failed QA: Tracker') && report.nextActions.includes('Resolve failed QA: Tracker'), 'product portfolio status enters the Business Morning Brief');
A.ok(report.sourceRefs.includes('product-project:tracker'), 'product portfolio provenance enters the Morning Brief');
A.ok(report.sourceRefs.includes('objective:done') && report.sourceRefs.includes('report:scout:1') && report.sourceRefs.includes('report:product-research:trail-kit') && report.sourceRefs.includes('run:r1'), 'durable evidence references are attached');
const noCost = composeMorningBrief({ periodStart: start, periodEnd: end, objectives: [], reports: [], runs: [] });
A.eq(noCost.decisions.length, 0, 'missing cost data stays absent rather than invented');
A.eq(noCost.completed.length, 0, 'empty periods remain truthful');
A.report('morning-brief.test');
