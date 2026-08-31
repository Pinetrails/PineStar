'use strict';

const FINAL = new Set(['completed', 'failed', 'cancelled']);
function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
function at(row) { return Math.max(0, Number(row && (row.settledAt || row.completedAt || row.updatedAt || row.createdAt)) || 0); }
function inPeriod(row, start, end) { const stamp = at(row); return stamp > start && stamp <= end; }
function label(row) { return text(row && row.title, 180) || text(row && row.id, 120) || 'Untitled objective'; }
function unique(items, cap) { return [...new Set(items.filter(Boolean))].slice(0, cap); }

function composeMorningBrief(input) {
  const o = input || {}, end = Math.max(1, Number(o.periodEnd) || Date.now());
  const start = Math.max(0, Math.min(end - 1, Number(o.periodStart) || end - 86400000));
  const objectives = Array.isArray(o.objectives) ? o.objectives.filter(Boolean) : [];
  const reports = Array.isArray(o.reports) ? o.reports.filter(Boolean) : [];
  const runs = Array.isArray(o.runs) ? o.runs.filter(r => r && Number(r.ts) > start && Number(r.ts) <= end) : [];
  const completedRows = objectives.filter(x => x.status === 'completed' && inPeriod(x, start, end));
  const failures = objectives.filter(x => ['failed', 'cancelled', 'blocked'].includes(x.status) && inPeriod(x, start, end));
  const active = objectives.filter(x => ['admitted', 'in_progress', 'decomposed'].includes(x.status));
  const approvals = objectives.filter(x => ['approval_required', 'waiting_approval'].includes(x.status));
  const scoutReports = reports.filter(x => x.type === 'open-source-scout' && Number(x.createdAt) > start && Number(x.createdAt) <= end);
  const productReports = reports.filter(x => x.type === 'product-research-decision' && Number(x.createdAt) > start && Number(x.createdAt) <= end);
  const auditorRows = objectives.filter(x => x.assignedRoleId === 'operations.auditor' && FINAL.has(x.status) && inPeriod(x, start, end));
  const discoveries = scoutReports.flatMap(x => Array.isArray(x.discoveries) ? x.discoveries : []).slice(0, 5);
  const measuredRuns = runs.filter(x => typeof x.usd === 'number' && Number.isFinite(x.usd));
  const totalUsd = measuredRuns.reduce((sum, x) => sum + Math.max(0, x.usd), 0);
  const completed = unique(completedRows.map(x => label(x) + ' — ' + text(x.resultSummary || x.settlementReason || 'completed', 120)), 6);
  const exceptions = unique([
    ...failures.map(x => label(x) + ' — ' + text(x.settlementReason || x.status, 120)),
    ...approvals.map(x => label(x) + ' — waiting for approval'),
    ...auditorRows.filter(x => x.status !== 'completed' || /exception|issue|fail/i.test(String(x.resultSummary || x.settlementReason || '')))
      .map(x => 'Auditor: ' + label(x) + ' — ' + text(x.resultSummary || x.settlementReason || x.status, 120))
  ], 8);
  const decisions = unique((measuredRuns.length ? ['Measured runtime cost for this period: $' + totalUsd.toFixed(4) + ' across ' + measuredRuns.length + ' recorded run' + (measuredRuns.length === 1 ? '' : 's') + '.'] : [])
    .concat(productReports.flatMap(x => Array.isArray(x.decisions) ? x.decisions : [])), 10);
  const nextActions = unique([
    ...approvals.map(x => 'Review approval: ' + label(x)),
    ...failures.map(x => 'Review ' + x.status + ' objective: ' + label(x)),
    ...active.map(x => 'Continue monitoring: ' + label(x)),
    ...discoveries.filter(x => ['TEST', 'ADD'].includes(x.recommendation)).map(x => x.recommendation + ': ' + text(x.name, 140) + ' → ' + text(x.recommendedOwnerRoleId || 'appropriate specialist', 100)),
    ...productReports.flatMap(x => Array.isArray(x.nextActions) ? x.nextActions : [])
  ], 8);
  const headline = completedRows.length + ' completed · ' + active.length + ' active · ' + exceptions.length + ' attention item' + (exceptions.length === 1 ? '' : 's');
  return { schema: 'pine-star.shared-report.v1', id: text(o.id, 120) || ('morning-brief:' + new Date(end).toISOString().slice(0, 10)), type: 'morning-brief',
    createdAt: end, periodStart: start, periodEnd: end, headline, completed, exceptions, decisions, nextActions, discoveries,
    sourceRefs: unique([...completedRows, ...failures, ...active, ...approvals, ...auditorRows].map(x => 'objective:' + x.id).concat(scoutReports.concat(productReports).map(x => 'report:' + x.id), measuredRuns.map(x => 'run:' + x.runId)), 12) };
}

module.exports = { composeMorningBrief };
