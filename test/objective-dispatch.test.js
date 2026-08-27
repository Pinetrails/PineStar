'use strict';
const A = require('./_assert.js');
const { makeObjectiveDispatch } = require('../sidecar/objective-dispatch.js');

function fixture(overrides) {
  const rows = new Map();
  const base = { id: 'objective:1', status: 'assigned', approvalState: 'not_required', assignedRoleId: 'research.safe' };
  rows.set(base.id, Object.assign(base, overrides && overrides.objective));
  const audits = [];
  const objectives = {
    get: id => rows.get(id) || null,
    recordAdmission: async (id, audit) => { const cur = rows.get(id); audits.push(audit); const next = Object.assign({}, cur, { admissionAudit: audits.slice() }); if (audit.decision === 'admitted') Object.assign(next, { status: 'admitted', admittedRunId: audit.runId, runtimeAgentId: audit.agentId }); rows.set(id, next); return next; }
  };
  const role = Object.assign({ id: 'research.safe', availability: 'active' }, overrides && overrides.role);
  const roles = { get: id => id === role.id ? role : null };
  const agents = new Map([['agent_a', Object.assign({ model: 'model-a', provider: 'provider-a', systemRoleIds: ['research.safe'] }, overrides && overrides.agent)] ]);
  const dispatcher = makeObjectiveDispatch({ objectives, roles, roster: () => agents, halted: () => !!(overrides && overrides.halted), newId: () => 'run-1', now: () => 123,
    admitRuntime: async plan => overrides && overrides.admission ? overrides.admission : { ok: true, plan } });
  return { dispatcher, objectives, rows, audits, agents };
}

(async () => {
  const safe = fixture(); const admitted = await safe.dispatcher.admit('objective:1');
  A.eq(admitted.ok, true, 'approved safe objective is admitted');
  A.eq(admitted.executionStarted, false, 'admission does not pretend execution started');
  A.eq(admitted.agentId, 'agent_a', 'explicit system-role binding selects the runtime identity');
  A.eq(safe.rows.get('objective:1').status, 'admitted', 'objective state commits the admission');
  A.eq(safe.audits[0].runId, 'run-1', 'admission creates an auditable run id');
  const protectedFx = fixture({ objective: { status: 'approval_required', approvalState: 'required' } });
  A.eq((await protectedFx.dispatcher.admit('objective:1')).code, 'approval_required', 'protected objective remains blocked');
  const missing = fixture(); missing.agents.clear();
  A.eq((await missing.dispatcher.admit('objective:1')).code, 'runtime_identity_missing', 'missing runtime identity fails closed');
  const invalid = fixture({ agent: { model: null } });
  A.eq((await invalid.dispatcher.admit('objective:1')).code, 'runtime_identity_invalid', 'invalid runtime identity fails closed');
  const unavailable = fixture({ role: { availability: 'inactive' } });
  A.eq((await unavailable.dispatcher.admit('objective:1')).code, 'role_unavailable', 'unavailable role is rejected');
  const halted = fixture({ halted: true });
  A.eq((await halted.dispatcher.admit('objective:1')).code, 'halted', 'E-stop halt condition blocks admission');
  const failed = fixture({ admission: { ok: false, code: 'runtime_admission_failed', reason: 'capacity full' } });
  A.eq((await failed.dispatcher.admit('objective:1')).code, 'runtime_admission_failed', 'failed existing-runtime admission is preserved');
  A.eq(failed.rows.get('objective:1').status, 'assigned', 'failed admission leaves objective assignable');
  A.eq(failed.audits[0].decision, 'rejected', 'failed admission creates an audit record');
  const dependency = fixture({ objective: { dependsOnObjectiveIds: ['objective:predecessor'] } });
  A.eq((await dependency.dispatcher.admit('objective:1')).code, 'dependencies_incomplete', 'unfinished dependency blocks child admission');
  A.eq(dependency.audits[0].decision, 'rejected', 'dependency rejection creates admission audit evidence');
  const cancel = fixture(); await cancel.dispatcher.admit('objective:1');
  cancel.rows.set('objective:1', Object.assign({}, cancel.rows.get('objective:1'), { status: 'cancelled' }));
  A.eq(cancel.rows.get('objective:1').status, 'cancelled', 'an admitted ticket remains cancellable before execution');

  function activationFx(opts) {
    opts = opts || {}; let row = Object.assign({ id: 'objective:a', status: 'admitted', approvalState: 'not_required', assignedRoleId: 'research.safe', runtimeAgentId: 'agent_a', admittedRunId: 'run-a' }, opts.objective);
    const lifecycle = [], agents = new Map([['agent_a', { model: 'm', provider: 'p', systemRoleIds: ['research.safe'] }]]);
    let resolveRun, rejectRun; const completion = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    let reconciled = 0;
    const objectives = { get: () => row, recordAdmission: async () => row, recordLifecycle: async (id, e) => { lifecycle.push(e); row = Object.assign({}, row, { status: e.state === 'running' ? 'in_progress' : e.state }); return row; }, reconcileParent: async () => { reconciled++; } };
    let cancelled = false, starts = 0;
    const dispatcher = makeObjectiveDispatch({ objectives, roles: { get: () => ({ id: 'research.safe', availability: opts.roleUnavailable ? 'inactive' : 'active' }) }, roster: () => agents,
      halted: () => !!opts.halted, isRunActive: () => row.status === 'in_progress' && !opts.orphaned, now: () => 200 + lifecycle.length, newId: () => 'unused',
      startRuntime: () => { starts++; if (opts.startFail) return { ok: false, code: 'runtime_start_failed' }; return { ok: true, completion, cancel: () => { cancelled = true; resolveRun({ reason: 'cancelled' }); } }; } });
    return { dispatcher, lifecycle, agents, resolveRun, rejectRun, starts: () => starts, cancelled: () => cancelled, reconciled: () => reconciled, row: () => row };
  }
  const active = activationFx(); const activation = await active.dispatcher.activate('objective:a');
  A.eq(activation.code, 'running', 'safe admitted objective activates');
  A.eq(active.lifecycle[0].state, 'running', 'activation synchronizes observable running state');
  A.eq(activation.agentId, 'agent_a', 'activation preserves intended runtime identity');
  A.eq((await active.dispatcher.activate('objective:a')).code, 'already_running', 'duplicate activation is rejected');
  active.resolveRun({ reason: 'done', artifacts: [{ path: 'result.txt' }], summary: 'finished safely' });
  const completed = await activation.settled;
  A.eq(completed.status, 'completed', 'successful execution settles completed');
  A.ok(active.lifecycle[1].evidenceRefs.includes('run:run-a') && active.lifecycle[1].evidenceRefs.includes('artifact:result.txt'), 'completion records bounded run and artifact evidence');
  A.eq((await active.dispatcher.activate('objective:a')).code, 'objective_not_admitted', 'settled objective cannot execute twice after retry/restart');
  const orphaned = activationFx({ objective: { status: 'in_progress' }, orphaned: true });
  A.eq((await orphaned.dispatcher.activate('objective:a')).code, 'interrupted', 'restart orphan is settled without re-execution');
  A.eq(orphaned.row().status, 'failed', 'interrupted activation becomes a durable truthful failure');
  const failedRun = activationFx(); const failingActivation = await failedRun.dispatcher.activate('objective:a'); failedRun.rejectRun(new Error('provider failed'));
  A.eq((await failingActivation.settled).status, 'failed', 'execution failure settles truthfully');
  const protectedActivation = activationFx({ objective: { status: 'approval_required', approvalState: 'required' } });
  A.eq((await protectedActivation.dispatcher.activate('objective:a')).code, 'approval_required', 'protected objective cannot activate');
  const unroutable = activationFx({ objective: { status: 'unroutable' } });
  A.eq((await unroutable.dispatcher.activate('objective:a')).code, 'objective_not_admitted', 'unroutable objective cannot activate');
  const stopped = activationFx({ halted: true }); A.eq((await stopped.dispatcher.activate('objective:a')).code, 'halted', 'E-stop blocks activation');
  const stale = activationFx(); stale.agents.get('agent_a').systemRoleIds = [];
  A.eq((await stale.dispatcher.activate('objective:a')).code, 'runtime_binding_stale', 'stale binding blocks activation');
  const cancellable = activationFx(); const runningCancel = await cancellable.dispatcher.activate('objective:a'); cancellable.resolveRun({ reason: 'cancelled' });
  A.eq((await runningCancel.settled).status, 'cancelled', 'existing runtime cancellation reason propagates to objective');
  const child = activationFx({ objective: { parentObjectiveId: 'objective:parent' } }); const childRun = await child.dispatcher.activate('objective:a'); child.resolveRun({ reason: 'done' }); await childRun.settled;
  A.eq(child.reconciled(), 1, 'child settlement triggers durable parent reconciliation');
  A.report('objective-dispatch.test');
})().catch(e => { console.error(e); process.exit(1); });
