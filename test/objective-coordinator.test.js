'use strict';
const A = require('./_assert.js');
const { SEEDS } = require('../shared/pine-star-roles.js');
const { makeRoleRegistry } = require('../sidecar/role-registry.js');
const { makeObjectiveStore } = require('../sidecar/objective-store.js');

let rows, sequence = 0, stamp = 100;
const durable = { get: () => rows, readKey: () => ({ status: rows ? 'ok' : 'absent', value: rows }), update: async (key, mutate) => { const next = await mutate(rows); if (next !== undefined) rows = next; return next; } };
const store = makeObjectiveStore({ durable, registry: makeRoleRegistry(SEEDS), now: () => stamp++, newId: () => 'co-' + (++sequence) });

(async () => {
  const direct = await store.create({ title: 'Direct research', requiredCapabilities: ['research', 'verify'], targetRoleId: 'research.general_researcher', maxModelTier: 'economy' });
  A.eq(direct.assignedRoleId, 'research.general_researcher', 'direct specialist assignment bypasses coordinator routing');
  const incapable = await store.create({ title: 'Wrong specialist', requiredCapabilities: ['code'], targetRoleId: 'research.general_researcher' });
  A.eq(incapable.status, 'escalate', 'incapable direct specialist selection fails closed');

  const parent = await store.create({ title: 'Coordinate bounded work', requiredCapabilities: ['coordinate'] });
  A.eq(parent.assignedRoleId, 'operations.coordinator', 'coordination work binds to the system coordinator role');
  const plan = { decompositionId: 'plan-1', children: [
    { title: 'Research facts', requiredCapabilities: ['research', 'verify'], maxModelTier: 'economy' },
    { title: 'Implement result', requiredCapabilities: ['code', 'test'], dependsOn: [0] },
    { title: 'Publish result', requiredCapabilities: ['publish'], protectedAction: true },
    { title: 'Unavailable specialty', requiredCapabilities: ['nonexistent_specialty'] }
  ] };
  const made = await store.decompose(parent.id, plan);
  A.eq(made.children[0].assignedRoleId, 'research.general_researcher', 'child routes to the lowest capable researcher');
  A.eq(made.children[1].assignedRoleId, 'development.software_engineer', 'child routes to the lowest capable software specialist');
  A.ok(!made.children.some(x => x.assignedRoleId === 'operations.coordinator'), 'coordinator does not steal specialist work');
  A.eq(made.children[1].dependsOnObjectiveIds, [made.children[0].id], 'dependency indexes become durable objective relationships');
  A.eq(made.children[2].status, 'approval_required', 'protected child remains approval required');
  A.eq(made.children[3].status, 'escalate', 'unroutable child remains explicitly escalated');
  A.eq((await store.reconcileParent(parent.id)).status, 'waiting_approval', 'protected child truthfully pauses its parent');
  const again = await store.decompose(parent.id, plan);
  A.eq(again.idempotent, true, 'same decomposition identity is idempotent');
  A.eq(again.children.map(x => x.id), made.children.map(x => x.id), 'idempotent retry does not create duplicate children');
  let conflict = false; try { await store.decompose(parent.id, Object.assign({}, plan, { decompositionId: 'plan-2' })); } catch (e) { conflict = /already decomposed/.test(e.message); }
  A.ok(conflict, 'different decomposition cannot replace a committed plan');

  const atomicParent = await store.create({ title: 'Atomic validation', requiredCapabilities: ['coordinate'] });
  const before = store.list(250).length;
  let invalid = false; try { await store.decompose(atomicParent.id, { decompositionId: 'bad', children: [
    { title: 'First', requiredCapabilities: ['research'] }, { title: 'Second', requiredCapabilities: ['code'], dependsOn: [1] }
  ] }); } catch (e) { invalid = /earlier child indexes/.test(e.message); }
  A.ok(invalid, 'invalid dependency order is rejected');
  A.eq(store.list(250).length, before, 'failed decomposition creates no partial children');
  A.eq(store.get(atomicParent.id).status, 'assigned', 'failed decomposition leaves parent unchanged');

  const simple = await store.create({ title: 'Specialist-only work', requiredCapabilities: ['research'] });
  let nonCoordinator = false; try { await store.decompose(simple.id, { decompositionId: 'nope', children: [{ title: 'A', requiredCapabilities: ['research'] }, { title: 'B', requiredCapabilities: ['code'] }] }); } catch (e) { nonCoordinator = /not an available coordinator/.test(e.message); }
  A.ok(nonCoordinator, 'specialist objective cannot invoke coordinator decomposition');

  const aggregateParent = await store.create({ title: 'Aggregate children', requiredCapabilities: ['coordinate'] });
  const aggregate = await store.decompose(aggregateParent.id, { decompositionId: 'aggregate', children: [
    { title: 'Research child', requiredCapabilities: ['research'] }, { title: 'Code child', requiredCapabilities: ['code'] }
  ] });
  await store.updateStatus(aggregate.children[0].id, 'completed', ['report:first']);
  A.eq((await store.reconcileParent(aggregateParent.id)).status, 'decomposed', 'partially complete children leave parent active');
  await store.updateStatus(aggregate.children[1].id, 'completed', ['artifact:second']);
  const completed = await store.reconcileParent(aggregateParent.id);
  A.eq(completed.status, 'completed', 'all required children settle parent complete');
  A.eq(completed.completionEvidenceRefs, aggregate.children.map(x => x.id), 'parent settlement links bounded child evidence');
  const failureParent = await store.create({ title: 'Failure aggregation', requiredCapabilities: ['coordinate'] });
  const failure = await store.decompose(failureParent.id, { decompositionId: 'failure', children: [
    { title: 'First required child', requiredCapabilities: ['research'] }, { title: 'Second required child', requiredCapabilities: ['code'] }
  ] });
  await store.updateStatus(failure.children[0].id, 'failed', []);
  A.eq((await store.reconcileParent(failureParent.id)).status, 'blocked', 'required child failure propagates truthfully to parent');
  const protectedParent = await store.create({ title: 'Protected coordination', requiredCapabilities: ['coordinate'], protectedAction: true });
  let protectedBlocked = false; try { await store.decompose(protectedParent.id, { decompositionId: 'protected', children: [{ title: 'A', requiredCapabilities: ['research'] }, { title: 'B', requiredCapabilities: ['code'] }] }); } catch (e) { protectedBlocked = /requires approval/.test(e.message); }
  A.ok(protectedBlocked, 'protected parent cannot decompose before legitimate approval');
  const limitsParent = await store.create({ title: 'Bounded plan', requiredCapabilities: ['coordinate'] });
  let countBlocked = false; try { await store.decompose(limitsParent.id, { decompositionId: 'too-many', children: Array.from({ length: 9 }, (_, i) => ({ title: 'Child ' + i, requiredCapabilities: ['research'] })) }); } catch (e) { countBlocked = /2-8/.test(e.message); }
  A.ok(countBlocked, 'decomposition child count is bounded');
  const depthParent = await store.create({ title: 'Depth boundary', requiredCapabilities: ['coordinate'] });
  rows = rows.map(x => x.id === depthParent.id ? Object.assign({}, x, { decompositionDepth: 3 }) : x);
  let depthBlocked = false; try { await store.decompose(depthParent.id, { decompositionId: 'too-deep', children: [{ title: 'A', requiredCapabilities: ['research'] }, { title: 'B', requiredCapabilities: ['code'] }] }); } catch (e) { depthBlocked = /depth limit/.test(e.message); }
  A.ok(depthBlocked, 'nested decomposition depth is bounded');
  A.report('objective-coordinator.test');
})().catch(e => { console.error(e); process.exit(1); });
