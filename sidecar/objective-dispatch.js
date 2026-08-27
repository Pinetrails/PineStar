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
  return { admit };
}
module.exports = { makeObjectiveDispatch };
