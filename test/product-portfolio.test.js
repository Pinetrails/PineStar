'use strict';
const A = require('./_assert.js'); const { summarizeProductPortfolio } = require('../sidecar/product-portfolio.js');
const summary = summarizeProductPortfolio({ projects: [
  { id: 'ready', title: 'Ready Planner', status: 'listing_ready', qaState: 'passed', blockers: [] },
  { id: 'approval', title: 'Approval Checklist', status: 'approval_required', qaState: 'passed', blockers: [] },
  { id: 'failed', title: 'Failed Tracker', status: 'production', qaState: 'failed', blockers: ['Clipped text'] }
], commerce: [{ id: 'listing-1', projectId: 'approval', state: 'observed_published' }], financials: { byProject: [{ projectId: 'ready', netUsd: 8 }, { projectId: 'failed', netUsd: -2 }, { projectId: 'unknown', netUsd: 100 }], sourceRefs: ['business-entry:sale-1'] } });
A.eq(summary.total, 3, 'summary counts real project rows');
A.eq(summary.stageCounts, { listing_ready: 1, approval_required: 1, production: 1 }, 'summary retains deterministic stage counts');
A.eq(summary.observedPublished, 1, 'evidenced publication observations are counted by project');
A.eq(summary.failedQa, 1, 'failed QA remains visible');
A.ok(summary.exceptions.some(x => /Clipped text/.test(x)), 'product blocker enters attention items');
A.ok(summary.nextActions.some(x => /protected product approval/.test(x)) && summary.nextActions.some(x => /Resolve failed QA/.test(x)), 'approval and QA actions are distinct');
A.ok(summary.sourceRefs.includes('product-project:ready') && summary.sourceRefs.includes('commerce-record:listing-1'), 'project and commerce provenance is retained');
A.eq(summary.productsWithLedgerEvidence, 2, 'only known products with linked ledger evidence are counted');
A.eq(summary.recordedNetUsd, 6, 'recorded product contribution sums linked evidence without estimates');
A.ok(summary.decisions.some(x => /net \$6\.00/.test(x)) && summary.exceptions.some(x => /negative contribution.*Failed Tracker.*-2\.00/.test(x)), 'product contribution and negative evidence remain visible');
A.ok(summary.sourceRefs.includes('business-entry:sale-1'), 'financial provenance is retained');
A.eq(summarizeProductPortfolio({}).decisions.length, 0, 'an empty portfolio does not invent activity');
A.report('product-portfolio.test');
