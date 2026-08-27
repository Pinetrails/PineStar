'use strict';
const A = require('./_assert.js');
const { SEEDS } = require('../shared/pine-star-roles.js');
const { makeRoleRegistry } = require('../sidecar/role-registry.js');
const { makeObjectiveStore } = require('../sidecar/objective-store.js');
const fs = require('fs'), path = require('path'), os = require('os');
let rows;
const durable = { get: () => rows, readKey: () => ({ status: rows ? 'ok' : 'absent', value: rows }), update: async (key, mutate) => { const next = await mutate(rows); if (next !== undefined) rows = next; return next; } };
let stamp = 100;
const store = makeObjectiveStore({ durable, registry: makeRoleRegistry(SEEDS), now: () => stamp++, newId: () => 'fixed-' + stamp });
(async () => {
  const made = await store.create({ title: 'Verify a source', requiredCapabilities: ['research', 'verify'], maxModelTier: 'economy' });
  A.eq(made.assignedRoleId, 'research.general_researcher', 'objective persists the stable assigned role id');
  A.eq(made.assignedModelTier, 'economy', 'objective persists the assigned model tier');
  A.eq(made.status, 'assigned', 'routable objective starts assigned');
  A.eq(store.list()[0].requiredCapabilities, ['research', 'verify'], 'declared capabilities survive read-after-write');
  const done = await store.updateStatus(made.id, 'completed', ['report:verification-1']);
  A.eq(done.status, 'completed', 'status transition persists');
  A.eq(done.completionEvidenceRefs, ['report:verification-1'], 'completion evidence references persist');
  const protectedObjective = await store.create({ title: 'Publish externally', requiredCapabilities: ['publish'], protectedAction: true });
  A.eq(protectedObjective.status, 'approval_required', 'protected objectives stop at approval required');
  A.eq(protectedObjective.approvalState, 'required', 'approval state is explicit and durable');
  let blocked = false; try { await store.updateStatus(protectedObjective.id, 'in_progress', []); } catch (e) { blocked = /requires approval/.test(e.message); }
  A.ok(blocked, 'status mutation cannot bypass approval-required state');
  let evidenceRequired = false; const another = await store.create({ title: 'Write code', requiredCapabilities: ['code'] });
  try { await store.updateStatus(another.id, 'completed', []); } catch (e) { evidenceRequired = /evidence/.test(e.message); }
  A.ok(evidenceRequired, 'completion cannot be claimed without evidence references');
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'pine-objectives-'));
  const deps = { fs, path, workspaces, registry: makeRoleRegistry(SEEDS), now: () => 500, newId: () => 'durable-id' };
  const first = makeObjectiveStore(deps);
  await first.create({ title: 'Durable audit', requiredCapabilities: ['audit'] });
  const restarted = makeObjectiveStore(deps);
  A.eq(restarted.list()[0].id, 'objective:durable-id', 'objective survives store reconstruction from disk');
  A.eq(restarted.readStatus().status, 'ok', 'durable objective store reports a healthy committed main');
  A.report('objective-store.test');
})().catch(e => { console.error(e); process.exit(1); });
