'use strict';
const A = require('assert');
const { normalizeExistingProduct, intakeExistingPineTrailProduct } = require('../sidecar/pine-trail-existing-product.js');

let createdInput, decomposition, report;
const existing = new Map();
const projects = {
  async create(input) { createdInput = input; return { project: Object.assign({ id: input.projectId, linkedObjectiveIds: [], linkedReportIds: [] }, input), idempotent: false }; },
  async link(id, input) { return Object.assign({}, createdInput, { id, linkedObjectiveIds: input.objectiveIds, linkedReportIds: input.reportIds }); }
};
const objectives = {
  find(fn) { return [...existing.values()].find(fn) || null; },
  async create(input) { const row = Object.assign({ id: 'parent' }, input); existing.set(row.id, row); return row; },
  async decompose(id, input) { decomposition = input; return { parent: existing.get(id), children: input.children.map((row, index) => Object.assign({ id: 'child-' + index }, row)), idempotent: false }; }
};
(async () => {
  const input = { productId: 'the-big-bite', title: 'The Big Bite', productType: 'clipart-collection', deliverables: ['ZIP archive', 'Transparent PNG collection'], evidenceRefs: ['sha256:archive'], verifiedFacts: ['213 PNGs decode successfully'], unknowns: ['Full visual review is incomplete'], targetMarketplaces: ['Etsy'] };
  const normalized = normalizeExistingProduct(input);
  A.equal(normalized.productId, 'pine-trail-the-big-bite');
  A.equal(normalized.productType, 'pine-trail-existing:clipart-collection');
  const result = await intakeExistingPineTrailProduct({ projects, objectives, appendReport: async value => { report = value; return { added: true, report: value }; }, now: () => 42 }, input);
  A.equal(createdInput.status, 'production');
  A.equal(createdInput.qaState, 'not_started');
  A.deepEqual(createdInput.blockers, input.unknowns);
  A.equal(decomposition.children[0].targetRoleId, 'business.product_designer');
  A.deepEqual(decomposition.children[0].requiredCapabilities, ['prepare_product']);
  A.equal(decomposition.children[1].targetRoleId, 'operations.quality_reviewer');
  A.deepEqual(decomposition.children[1].dependsOn, [0]);
  A.ok(/not approved/.test(report.decisions[0]));
  A.equal(result.externalAction, false);
  A.equal(result.spendingAuthorityUsd, 0);
  for (const bad of [{}, Object.assign({}, input, { deliverables: [] }), Object.assign({}, input, { evidenceRefs: [] }), Object.assign({}, input, { verifiedFacts: [] })]) A.throws(() => normalizeExistingProduct(bad));
  console.log('pine-trail-existing-product tests: PASS (16 assertions)');
})().catch(error => { console.error(error); process.exit(1); });
