'use strict';
const A = require('./_assert.js');
const { SEEDS } = require('../shared/pine-star-roles.js');
const { makeRoleRegistry } = require('../sidecar/role-registry.js');
const { makeObjectiveStore } = require('../sidecar/objective-store.js');
const HybridAuditor = require('../sidecar/auditor-hybrid-verification.js');
let rows, seq = 0;
const durable = { get: () => rows, readKey: () => ({ status: rows ? 'ok' : 'absent', value: rows }), update: async (key, mutate) => { const next = await mutate(rows); if (next !== undefined) rows = next; return next; } };
const store = makeObjectiveStore({ durable, registry: makeRoleRegistry(SEEDS), now: () => 100 + seq, newId: () => 'audit-' + (++seq) });
(async () => {
  const target = await store.create({ title: 'Completed specialist work', requiredCapabilities: ['research'] });
  let unsettled = false; try { await store.createAudit(target.id, { auditId: 'review-1' }); } catch (e) { unsettled = /not settled/.test(e.message); }
  A.ok(unsettled, 'auditor cannot claim review of unfinished work');
  await store.updateStatus(target.id, 'completed', ['report:target-result']);
  const made = await store.createAudit(target.id, { auditId: 'review-1' });
  A.eq(made.objective.assignedRoleId, 'operations.auditor', 'audit objective binds to the Auditor system role');
  A.eq(made.objective.requiredCapabilities, ['audit', 'verify'], 'audit work declares bounded verification capabilities');
  A.eq(made.objective.auditTargetObjectiveId, target.id, 'audit objective links its settled target');
  A.eq(made.objective.auditRequest.targetEvidenceRefs, ['report:target-result'], 'audit request snapshots bounded target evidence references');
  A.eq(made.objective.auditRequest.verifiedFacts.authority, 'deterministic-mechanical-verifier', 'deterministic verification is persisted as the fact authority');
  A.eq(made.objective.auditRequest.verifiedFacts.facts, { validJson: true, recordCount: 1, issueCount: 0, evidenceRefs: [] }, 'v2 verifier supplies exact objective facts before model work');
  A.ok(made.objective.description.includes(target.id) && made.objective.description.includes('report:target-result'), 'runtime directive contains the bounded target record needed for useful review');
  A.ok(made.objective.description.includes('Do not revise, contradict, replace, or recalculate'), 'runtime directive prohibits model override of mechanical truth');
  const report = HybridAuditor.composeReport(made.objective, { modelInterpretation: 'Evidence is present.', uncertainty: ['Artifact contents not inspected.'], recommendedFollowUp: ['Inspect the referenced report.'] });
  A.eq(report.verifiedFact, made.objective.auditRequest.verifiedFacts, 'final report carries deterministic facts unchanged');
  A.eq(report.modelInterpretation, 'Evidence is present.', 'model interpretation remains separately labeled');
  let overrideBlocked = false; try { HybridAuditor.composeReport(made.objective, { verifiedFact: { recordCount: 99 }, modelInterpretation: 'override' }); } catch (e) { overrideBlocked = /interpretation fields only/.test(e.message); }
  A.ok(overrideBlocked, 'model cannot inject or replace verified facts in the final report');
  const custom = await store.createAudit(target.id, { auditId: 'review-custom', description: 'Focus on operational significance.' });
  A.ok(custom.objective.description.includes('Focus on operational significance.') && custom.objective.description.includes('VERIFIED FACT:'), 'custom scope cannot displace the authoritative hybrid directive');
  A.eq(made.objective.status, 'assigned', 'audit enters the existing objective lifecycle without auto-execution');
  const retry = await store.createAudit(target.id, { auditId: 'review-1' });
  A.eq(retry.idempotent, true, 'duplicate audit request is idempotent');
  A.eq(store.list(50).filter(x => x.auditRequest && x.auditRequest.id === 'review-1').length, 1, 'idempotent audit does not create duplicate execution work');
  const other = await store.create({ title: 'Other settled work', requiredCapabilities: ['code'] }); await store.updateStatus(other.id, 'failed', []);
  let conflict = false; try { await store.createAudit(other.id, { auditId: 'review-1' }); } catch (e) { conflict = /another objective/.test(e.message); }
  A.ok(conflict, 'audit identity cannot silently move to another target');
  A.report('objective-auditor.test');
})().catch(e => { console.error(e); process.exit(1); });
