'use strict';
const { makeDurableJsonStore } = require('./durable-store.js');
const CAP = 1000;
const FINAL = new Set(['completed', 'failed', 'cancelled']);
const MUTABLE = new Set(['assigned', 'in_progress', 'completed', 'failed', 'cancelled']);
function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
function strings(value, cap, width) { return [...new Set((Array.isArray(value) ? value : []).map(v => text(v, width)).filter(Boolean))].slice(0, cap); }
function publicRole(role) { return role ? { id: role.id, displayName: role.displayName, department: role.department, capabilities: role.capabilities.slice(), modelTier: role.modelTier, escalationTargets: role.escalationTargets.slice(), permissions: Object.assign({}, role.permissions), availability: role.availability } : null; }
function makeObjectiveStore(deps) {
  deps = deps || {};
  if (!deps.registry || typeof deps.registry.route !== 'function') throw new Error('objective store requires a role registry');
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const newId = typeof deps.newId === 'function' ? deps.newId : (() => { throw new Error('objective store requires newId'); });
  const durable = deps.durable || makeDurableJsonStore({ fs: deps.fs, path: deps.path, writeDurable: deps.writeDurable,
    fileFor: () => deps.path.join(deps.workspaces, 'pine-star.objectives.json'), onRecover: deps.onRecover, onCorrupt: deps.onCorrupt });
  async function create(input) {
    const row = input && typeof input === 'object' ? input : {}, title = text(row.title, 240);
    const requiredCapabilities = strings(row.requiredCapabilities, 24, 80);
    if (!title) throw new Error('objective requires a title');
    if (!requiredCapabilities.length) throw new Error('objective requires declared capabilities');
    const maxModelTier = ['economy', 'balanced', 'deep'].includes(row.maxModelTier) ? row.maxModelTier : 'deep';
    const protectedAction = row.protectedAction === true;
    const routed = deps.registry.route({ requiredCapabilities, maxModelTier, protectedAction });
    const stamp = Math.max(0, Number(now()) || 0);
    const objective = { schema: 'pine-star.objective.v1', id: 'objective:' + text(newId(), 100), title,
      description: text(row.description, 2000), requiredCapabilities, protectedAction, maxModelTier,
      routing: { status: routed.status, reason: text(routed.reason, 300) }, assignedRoleId: routed.role ? routed.role.id : null,
      assignedModelTier: routed.role ? routed.role.modelTier : null,
      approvalState: routed.status === 'approval_required' ? 'required' : 'not_required', status: routed.status,
      createdAt: stamp, updatedAt: stamp, completedAt: 0, completionEvidenceRefs: [], admissionAudit: [] };
    await durable.update('station', stored => { const list = Array.isArray(stored) ? stored.slice() : []; list.push(objective); while (list.length > CAP) list.shift(); return list; });
    return objective;
  }
  function list(limit) { const cap = Math.max(1, Math.min(250, Number(limit) || 50)); const rows = durable.get('station'); return (Array.isArray(rows) ? rows : []).filter(Boolean).slice(-cap).reverse(); }
  function get(id) { const rows = durable.get('station'); return (Array.isArray(rows) ? rows : []).find(row => row && row.id === String(id || '')) || null; }
  async function recordAdmission(id, admission) {
    let updated = null;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], index = list.findIndex(item => item && item.id === String(id || ''));
      if (index < 0) throw new Error('objective not found');
      const current = list[index], audit = (Array.isArray(current.admissionAudit) ? current.admissionAudit : []).slice(-19);
      audit.push(Object.assign({}, admission));
      updated = Object.assign({}, current, { admissionAudit: audit, updatedAt: Math.max(Number(current.updatedAt) || 0, Number(admission && admission.at) || 0) });
      if (admission && admission.decision === 'admitted') updated = Object.assign(updated, { status: 'admitted', admittedRunId: String(admission.runId || ''), runtimeAgentId: String(admission.agentId || '') });
      list[index] = updated; return list;
    });
    return updated;
  }
  async function recordLifecycle(id, event) {
    let updated = null;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], index = list.findIndex(item => item && item.id === String(id || ''));
      if (index < 0) throw new Error('objective not found');
      const current = list[index], e = event || {}, runId = String(e.runId || '');
      if (!runId || runId !== String(current.admittedRunId || '')) throw new Error('objective run identity mismatch');
      const audit = (Array.isArray(current.lifecycleAudit) ? current.lifecycleAudit : []).slice(-39);
      audit.push({ state: String(e.state || ''), runId, at: Math.max(0, Number(e.at) || 0), reason: text(e.reason, 300) });
      const stamp = Math.max(Number(current.updatedAt) || 0, Number(e.at) || 0);
      if (e.state === 'running') {
        if (current.status !== 'admitted') throw new Error('objective is not admitted');
        updated = Object.assign({}, current, { status: 'in_progress', startedAt: stamp, updatedAt: stamp, lifecycleAudit: audit });
      } else {
        if (current.status !== 'in_progress' && !(current.status === 'admitted' && e.state === 'cancelled')) throw new Error('objective is not running');
        if (!['completed', 'failed', 'cancelled'].includes(e.state)) throw new Error('invalid objective settlement');
        const refs = strings(e.evidenceRefs, 24, 240);
        if (e.state === 'completed' && !refs.length) throw new Error('completion requires evidence references');
        updated = Object.assign({}, current, { status: e.state, updatedAt: stamp, settledAt: stamp,
          completedAt: e.state === 'completed' ? stamp : 0, completionEvidenceRefs: refs,
          settlementReason: text(e.reason, 300), resultSummary: text(e.resultSummary, 500), lifecycleAudit: audit });
      }
      list[index] = updated; return list;
    });
    return updated;
  }
  async function updateStatus(id, status, evidenceRefs) {
    const objectiveId = text(id, 120), nextStatus = text(status, 40);
    if (!objectiveId) throw new Error('objective id is required');
    if (!MUTABLE.has(nextStatus)) throw new Error('unsupported objective status');
    let updated = null;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], index = list.findIndex(item => item && item.id === objectiveId);
      if (index < 0) throw new Error('objective not found');
      const current = list[index];
      if (current.status === 'approval_required') throw new Error('objective requires approval before status changes');
      if (FINAL.has(current.status)) throw new Error('completed objective status is immutable');
      if (current.status === 'admitted' || current.status === 'in_progress') throw new Error('active objective state is runtime-owned');
      const refs = strings(evidenceRefs, 24, 240);
      if (nextStatus === 'completed' && !refs.length) throw new Error('completion requires evidence references');
      const stamp = Math.max(Number(current.updatedAt) || 0, Number(now()) || 0);
      updated = Object.assign({}, current, { status: nextStatus, updatedAt: stamp, completedAt: nextStatus === 'completed' ? stamp : 0,
        completionEvidenceRefs: nextStatus === 'completed' ? refs : current.completionEvidenceRefs });
      list[index] = updated; return list;
    });
    return updated;
  }
  return { create, list, get, recordAdmission, recordLifecycle, updateStatus, readStatus: () => durable.readKey('station'), _durable: durable };
}
module.exports = { makeObjectiveStore, publicRole, CAP };
