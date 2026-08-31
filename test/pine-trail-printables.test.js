'use strict';
const A = require('./_assert.js'); const { normalizePineTrailPrintable, intakePineTrailPrintable } = require('../sidecar/pine-trail-printables.js');
(async () => {
  const preset = normalizePineTrailPrintable({ productId: 'weekend-planner', title: 'Weekend Trail Planner', family: 'planner', useCase: 'Prepare for a day hike', targetMarketplaces: ['Marketplace A'], assetRequirements: ['Accessible form labels'] });
  A.eq(preset.productId, 'pine-trail-weekend-planner', 'preset uses a stable Pine Trail namespace');
  A.eq(preset.assetRequirements.length, 5, 'preset combines standard and product-specific requirements');
  A.ok(preset.assetRequirements.some(x => /Original Pine Trail-owned/.test(x)), 'preset requires original distributable assets');
  let received; const result = await intakePineTrailPrintable({ intakeProductIdea: async x => { received = x; return { idempotent: false, project: { id: x.ideaId }, children: [{}, {}] }; } }, preset);
  A.eq(received.productType, 'pine-trail-printable:planner', 'preset delegates a bounded product type to existing Idea intake');
  A.ok(received.assumptions.some(x => /Intended use/.test(x)), 'use case enters existing research assumptions');
  A.eq(result.externalAction, false, 'preset performs no marketplace or publication action');
  A.eq(result.spendingAuthorityUsd, 0, 'preset grants no spending authority');
  let bad = false; try { normalizePineTrailPrintable({ productId: 'x', title: 'X', family: 'unknown' }); } catch (e) { bad = /supported family/.test(e.message); } A.ok(bad, 'unsupported families are rejected rather than improvised');
  A.report('pine-trail-printables.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
