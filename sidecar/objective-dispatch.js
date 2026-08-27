'use strict';
function makeObjectiveDispatch(deps) {
  deps = deps || {};
  const objectives = deps.objectives, roles = deps.roles;
  if (!objectives || typeof objectives.get !== 'function' || typeof objectives.recordAdmission !== 'function') throw new Error('objective dispatch requires objective storage');
  if (!roles || typeof roles.get !== 'function') throw new Error('objective dispatch requires role registry');
  const roster = typeof deps.roster === 'function' ? deps.roster : () => new Map();
  const halted = typeof deps.halted === 'function' ? deps.halted : () => false;
  const admitRuntime = typeof deps.admitRuntime === 'function' ? deps.admitRuntime : async () => ({ ok: true });
  const newId = typeof deps.newId === 'function' ? deps.newId : (() => { throw new Error('objective dispatch requires newId'); });
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const startRuntime = typeof deps.startRuntime === 'function' ? deps.startRuntime : null;
  const isRunActive = typeof deps.isRunActive === 'function' ? deps.isRunActive : () => false;
  async function reject(objective, code, reason, agentId) {
    const audit = { decision: 'rejected', code, reason, agentId: agentId || null, at: Number(now()) || 0 };
    if (objective) await objectives.recordAdmission(objective.id, audit);
    return { ok: false, code, reason };
  }
  async function admit(objectiveId) {
    const objective = objectives.get(objectiveId);
    if (!objective) return reject(null, 'objective_not_found', 'objective not found');
    if (objective.status === 'approval_required' || objective.approvalState === 'required') return reject(objective, 'approval_required', 'protected objective requires approval');
    if (objective.status !== 'assigned') return reject(objective, 'objective_not_assignable', 'objective is not in assigned state');
    const dependencyIds = Array.isArray(objective.dependsOnObjectiveIds) ? objective.dependsOnObjectiveIds : [];
    const incomplete = dependencyIds.filter(id => { const dependency = objectives.get(id); return !dependency || dependency.status !== 'completed'; });
    if (incomplete.length) return reject(objective, 'dependencies_incomplete', 'required predecessor objectives are not complete');
    const role = roles.get(objective.assignedRoleId);
    if (!role || role.availability !== 'active') return reject(objective, 'role_unavailable', 'assigned system role is unavailable');
    if (halted()) return reject(objective, 'halted', 'runtime is halted');
    const candidates = [...roster().entries()].filter(([, agent]) => Array.isArray(agent && agent.systemRoleIds) && agent.systemRoleIds.includes(role.id));
    if (candidates.length !== 1) return reject(objective, candidates.length ? 'ambiguous_runtime_identity' : 'runtime_identity_missing', candidates.length ? 'multiple runtime agents are bound to the role' : 'no approved runtime agent is bound to the role');
    const [agentId, agent] = candidates[0];
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(agentId)) || !agent || !agent.model || !agent.provider) return reject(objective, 'runtime_identity_invalid', 'bound runtime agent is incomplete', agentId);
    const runId = String(newId());
    let admission;
    try { admission = await admitRuntime({ objective, role, agentId, agent, runId }); }
    catch (e) { admission = { ok: false, code: 'runtime_admission_failed', reason: (e && e.message) || 'runtime admission failed' }; }
    if (!admission || admission.ok !== true) return reject(objective, (admission && admission.code) || 'runtime_admission_failed', (admission && admission.reason) || 'runtime admission failed', agentId);
    const audit = { decision: 'admitted', code: 'admitted', reason: 'existing runtime admission accepted the dispatch ticket', agentId, runId, roleId: role.id, at: Number(now()) || 0 };
    const updated = await objectives.recordAdmission(objective.id, audit);
    return { ok: true, code: 'admitted', runId, agentId, roleId: role.id, objective: updated, executionStarted: false };
  }
  async function settle(objective, event) {
    const updated = await objectives.recordLifecycle(objective.id, event);
    if (updated && updated.parentObjectiveId && typeof objectives.reconcileParent === 'function') await objectives.reconcileParent(updated.parentObjectiveId);
    return updated;
  }
  async function activate(objectiveId) {
    const objective = objectives.get(objectiveId);
    if (!objective) return { ok: false, code: 'objective_not_found', reason: 'objective not found' };
    if (objective.status === 'approval_required' || objective.approvalState === 'required') return { ok: false, code: 'approval_required', reason: 'protected objective requires approval' };
    if (objective.status === 'in_progress') {
      if (isRunActive(objective.admittedRunId)) return { ok: false, code: 'already_running', runId: objective.admittedRunId };
      const interrupted = await settle(objective, { state: 'failed', runId: objective.admittedRunId, at: Number(now()) || 0, reason: 'interrupted before durable settlement', evidenceRefs: ['run:' + objective.admittedRunId] });
      return { ok: false, code: 'interrupted', reason: 'prior activation is no longer running and was settled failed', objective: interrupted };
    }
    if (objective.status !== 'admitted') return { ok: false, code: 'objective_not_admitted', reason: 'objective is not admitted' };
    const role = roles.get(objective.assignedRoleId), agent = roster().get(String(objective.runtimeAgentId || ''));
    if (!role || role.availability !== 'active') return { ok: false, code: 'role_unavailable', reason: 'assigned system role is unavailable' };
    if (!agent || !Array.isArray(agent.systemRoleIds) || !agent.systemRoleIds.includes(role.id)) return { ok: false, code: 'runtime_binding_stale', reason: 'admitted runtime binding is no longer valid' };
    if (halted()) return { ok: false, code: 'halted', reason: 'runtime is halted' };
    if (!startRuntime) return { ok: false, code: 'runtime_unavailable', reason: 'runtime activation is unavailable' };
    const runId = String(objective.admittedRunId || '');
    if (!runId) return { ok: false, code: 'run_identity_missing', reason: 'admitted objective has no run identity' };
    let started;
    try { started = startRuntime({ objective, role, agentId: objective.runtimeAgentId, agent, runId }); }
    catch (e) { return { ok: false, code: 'runtime_start_failed', reason: (e && e.message) || 'runtime start failed' }; }
    if (!started || started.ok !== true || !started.completion || typeof started.completion.then !== 'function') return { ok: false, code: (started && started.code) || 'runtime_start_failed', reason: (started && started.reason) || 'runtime start failed' };
    try { await objectives.recordLifecycle(objective.id, { state: 'running', runId, at: Number(now()) || 0, reason: 'existing runtime started' }); }
    catch (e) { try { if (started.cancel) started.cancel(); } catch (_) {} return { ok: false, code: 'objective_state_failed', reason: (e && e.message) || 'could not persist running state' }; }
    const settled = Promise.resolve(started.completion).then(async result => {
      const r = result || {}, reason = String(r.reason || 'error');
      const state = /^(cancelled|aborted|halted)$/.test(reason) ? 'cancelled' : (reason === 'done' ? 'completed' : 'failed');
      const refs = ['run:' + runId].concat((Array.isArray(r.artifacts) ? r.artifacts : []).map(x => 'artifact:' + String((x && (x.path || x.id)) || '')).filter(x => x !== 'artifact:')).slice(0, 24);
      return settle(objective, { state, runId, at: Number(now()) || 0, reason, evidenceRefs: refs, resultSummary: r.summary || '' });
    }, async e => settle(objective, { state: 'failed', runId, at: Number(now()) || 0, reason: (e && e.message) || 'runtime failure', evidenceRefs: ['run:' + runId] }));
    return { ok: true, code: 'running', runId, agentId: objective.runtimeAgentId, roleId: role.id, settled };
  }
  return { admit, activate };
}
module.exports = { makeObjectiveDispatch };
