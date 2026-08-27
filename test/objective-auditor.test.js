'use strict';
const A = require('./_assert.js');
const { SEEDS } = require('../shared/pine-star-roles.js');
const { makeRoleRegistry } = require('../sidecar/role-registry.js');
const { makeObjectiveStore } = require('../sidecar/objective-store.js');
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
  A.ok(made.objective.description.includes(target.id) && made.objective.description.includes('report:target-result'), 'runtime directive contains the bounded target record needed for useful review');
  A.eq(made.objective.status, 'assigned', 'audit enters the existing objective lifecycle without auto-execution');
  const retry = await store.createAudit(target.id, { auditId: 'review-1' });
  A.eq(retry.idempotent, true, 'duplicate audit request is idempotent');
  A.eq(store.list(50).filter(x => x.auditRequest && x.auditRequest.id === 'review-1').length, 1, 'idempotent audit does not create duplicate execution work');
  const other = await store.create({ title: 'Other settled work', requiredCapabilities: ['code'] }); await store.updateStatus(other.id, 'failed', []);
  let conflict = false; try { await store.createAudit(other.id, { auditId: 'review-1' }); } catch (e) { conflict = /another objective/.test(e.message); }
  A.ok(conflict, 'audit identity cannot silently move to another target');
  A.report('objective-auditor.test');
})().catch(e => { console.error(e); process.exit(1); });
