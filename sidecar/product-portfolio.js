'use strict';
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function unique(v, cap) { return [...new Set(v.filter(Boolean))].slice(0, cap); }
function summarizeProductPortfolio(input) {
  const x = input || {}, projects = (Array.isArray(x.projects) ? x.projects : []).filter(Boolean), commerce = (Array.isArray(x.commerce) ? x.commerce : []).filter(Boolean);
  const stageCounts = {}; for (const p of projects) stageCounts[p.status] = (stageCounts[p.status] || 0) + 1;
  const listingReady = projects.filter(p => p.status === 'listing_ready'), approvals = projects.filter(p => p.status === 'approval_required');
  const failedQa = projects.filter(p => p.qaState === 'failed'), blocked = projects.filter(p => Array.isArray(p.blockers) && p.blockers.length);
  const observedProjectIds = new Set(commerce.filter(c => c.state === 'observed_published').map(c => c.projectId));
  const decisions = projects.length ? ['Product pipeline: ' + projects.length + ' total; ' + listingReady.length + ' listing-ready; ' + approvals.length + ' approval-required; ' + observedProjectIds.size + ' with evidenced observed publication.'] : [];
  const exceptions = unique(failedQa.map(p => 'Failed QA: ' + text(p.title || p.id, 160)).concat(blocked.map(p => 'Blocked product: ' + text(p.title || p.id, 160) + ' — ' + text(p.blockers[0], 160))), 8);
  const nextActions = unique(approvals.map(p => 'Review protected product approval: ' + text(p.title || p.id, 160))
    .concat(failedQa.map(p => 'Resolve failed QA: ' + text(p.title || p.id, 160)), listingReady.filter(p => !observedProjectIds.has(p.id)).map(p => 'Review listing-ready product: ' + text(p.title || p.id, 160))), 8);
  const sourceRefs = unique(projects.map(p => 'product-project:' + p.id).concat(commerce.map(c => 'commerce-record:' + c.id)), 40);
  return { schema: 'pine-star.product-portfolio-summary.v1', total: projects.length, stageCounts, listingReady: listingReady.length, approvalRequired: approvals.length, failedQa: failedQa.length, blocked: blocked.length, observedPublished: observedProjectIds.size, decisions, exceptions, nextActions, sourceRefs };
}
module.exports = { summarizeProductPortfolio };
