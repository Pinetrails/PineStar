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
  let safeWithdrawalBlocked = false; try { await store.withdrawApproval(made.id, 'not protected'); } catch (e) { safeWithdrawalBlocked = /not a pending protected approval/.test(e.message); }
  A.ok(safeWithdrawalBlocked, 'ordinary objectives cannot use protected approval withdrawal');
  let blocked = false; try { await store.updateStatus(protectedObjective.id, 'in_progress', []); } catch (e) { blocked = /requires approval/.test(e.message); }
  A.ok(blocked, 'status mutation cannot bypass approval-required state');
  const withdrawn = await store.withdrawApproval(protectedObjective.id, 'Listing needs revision');
  A.eq(withdrawn.status, 'cancelled', 'pending protected objective can be withdrawn into cancelled state');
  A.eq(withdrawn.approvalState, 'withdrawn', 'withdrawal state is explicit and truthful');
  A.eq(withdrawn.workflowAudit.slice(-1)[0].event, 'approval_withdrawn', 'withdrawal appends durable workflow audit history');
  A.eq((await store.withdrawApproval(protectedObjective.id, 'repeat')).workflowAudit.length, withdrawn.workflowAudit.length, 'repeated withdrawal is idempotent and does not duplicate audit history');
  const notPending = await store.create({ title: 'Another protected request', requiredCapabilities: ['publish'], protectedAction: true }); rows = rows.map(x => x.id === notPending.id ? Object.assign({}, x, { status: 'completed' }) : x); let notPendingBlocked = false; try { await store.withdrawApproval(notPending.id, 'too late'); } catch (e) { notPendingBlocked = /not a pending protected approval/.test(e.message); } A.ok(notPendingBlocked, 'protected objective outside approval-required state cannot be withdrawn');
  let evidenceRequired = false; const another = await store.create({ title: 'Write code', requiredCapabilities: ['code'] });
  try { await store.updateStatus(another.id, 'completed', []); } catch (e) { evidenceRequired = /evidence/.test(e.message); }
  A.ok(evidenceRequired, 'completion cannot be claimed without evidence references');
  const queued = await store.queueAway(another.id);
  A.eq(queued.awayWork.state, 'queued', 'an assigned safe objective can enter the durable Away queue');
  A.eq(store.hasAwayReady(stamp, 3600000), true, 'Night Shift can detect durable queued work without claiming it');
  A.eq((await store.queueAway(another.id)).awayWork.queuedAt, queued.awayWork.queuedAt, 'Away enqueue is idempotent');
  const claimed = await store.claimAway();
  A.eq(claimed.id, another.id, 'Away worker atomically claims the queued objective');
  A.eq(claimed.awayWork.attempts, 1, 'Away claim records its bounded attempt');
  const retried = await store.finishAway(another.id, { retry: true, reason: 'temporary runtime failure' });
  A.eq(retried.awayWork.state, 'queued', 'a transient failure requeues bounded work');
  A.eq((await store.claimAway()).awayWork.attempts, 2, 'retry reclaims the same durable objective without cloning it');
  await store.finishAway(another.id, { retry: true, reason: 'temporary runtime failure' });
  await store.claimAway();
  const exhausted = await store.finishAway(another.id, { retry: true, reason: 'temporary runtime failure' });
  A.eq(exhausted.awayWork.state, 'blocked', 'Away work stops after three failed attempts');
  let protectedAwayBlocked = false; try { await store.queueAway(notPending.id); } catch (e) { protectedAwayBlocked = /requires approval/.test(e.message); }
  A.ok(protectedAwayBlocked, 'protected objectives cannot enter unattended Away execution');
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'pine-objectives-'));
  const deps = { fs, path, workspaces, registry: makeRoleRegistry(SEEDS), now: () => 500, newId: () => 'durable-id' };
  const first = makeObjectiveStore(deps);
  await first.create({ title: 'Durable audit', requiredCapabilities: ['audit'] });
  const restarted = makeObjectiveStore(deps);
  A.eq(restarted.list()[0].id, 'objective:durable-id', 'objective survives store reconstruction from disk');
  A.eq(restarted.readStatus().status, 'ok', 'durable objective store reports a healthy committed main');
  const admission = await restarted.recordAdmission('objective:durable-id', { decision: 'admitted', runId: 'run-1', agentId: 'agent-a', roleId: 'operations.auditor', at: 501 });
  A.eq(admission.status, 'admitted', 'durable admission advances the objective without claiming execution');
  A.eq(admission.admissionAudit[0].runId, 'run-1', 'admission audit evidence persists with the objective');
  A.eq(makeObjectiveStore(deps).get('objective:durable-id').runtimeAgentId, 'agent-a', 'runtime binding survives store reconstruction');
  let admissionBypassBlocked = false; try { await restarted.updateStatus('objective:durable-id', 'admitted', []); } catch (e) { admissionBypassBlocked = /unsupported/.test(e.message); }
  A.ok(admissionBypassBlocked, 'generic status mutation cannot bypass the admission boundary');
  let runtimeStateProtected = false; try { await restarted.updateStatus('objective:durable-id', 'cancelled', []); } catch (e) { runtimeStateProtected = /runtime-owned/.test(e.message); }
  A.ok(runtimeStateProtected, 'generic status mutation cannot settle a runtime-owned objective');
  const running = await restarted.recordLifecycle('objective:durable-id', { state: 'running', runId: 'run-1', at: 502, reason: 'started' });
  A.eq(running.status, 'in_progress', 'activation persists running state against the admitted run identity');
  const settled = await restarted.recordLifecycle('objective:durable-id', { state: 'completed', runId: 'run-1', at: 503, reason: 'done', evidenceRefs: ['run:run-1'], resultSummary: 'bounded result' });
  A.eq(settled.status, 'completed', 'real lifecycle settlement persists completion');
  A.eq(settled.completionEvidenceRefs, ['run:run-1'], 'settlement preserves bounded evidence references');
  A.eq(makeObjectiveStore(deps).get('objective:durable-id').settlementReason, 'done', 'settlement survives restart');
  A.report('objective-store.test');
})().catch(e => { console.error(e); process.exit(1); });
