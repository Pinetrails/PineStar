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
  const cancel = fixture(); await cancel.dispatcher.admit('objective:1');
  cancel.rows.set('objective:1', Object.assign({}, cancel.rows.get('objective:1'), { status: 'cancelled' }));
  A.eq(cancel.rows.get('objective:1').status, 'cancelled', 'an admitted ticket remains cancellable before execution');
  A.report('objective-dispatch.test');
})().catch(e => { console.error(e); process.exit(1); });
