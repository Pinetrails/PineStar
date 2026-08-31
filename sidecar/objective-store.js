'use strict';
const { makeDurableJsonStore } = require('./durable-store.js');
const { scoutDirective } = require('./open-source-scout.js');
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
  function build(input, relation) {
    const row = input && typeof input === 'object' ? input : {}, title = text(row.title, 240);
    const requiredCapabilities = strings(row.requiredCapabilities, 24, 80);
    if (!title) throw new Error('objective requires a title');
    if (!requiredCapabilities.length) throw new Error('objective requires declared capabilities');
    const maxModelTier = ['economy', 'balanced', 'deep'].includes(row.maxModelTier) ? row.maxModelTier : 'deep';
    const protectedAction = row.protectedAction === true;
    let routed = deps.registry.route({ requiredCapabilities, maxModelTier, protectedAction });
    const targetRoleId = text(row.targetRoleId, 80);
    if (!protectedAction && targetRoleId) {
      const role = deps.registry.get(targetRoleId), tier = { economy: 0, balanced: 1, deep: 2 };
      routed = role && role.availability === 'active' && tier[role.modelTier] <= tier[maxModelTier] && requiredCapabilities.every(c => role.capabilities.includes(c))
        ? { status: 'assigned', role, reason: 'direct specialist selection satisfies declared capabilities' }
        : { status: 'escalate', role: null, reason: 'direct specialist is unavailable or lacks required capability/tier' };
    }
    const stamp = Math.max(0, Number(now()) || 0);
    const rel = relation || {};
    return { schema: 'pine-star.objective.v1', id: rel.id || ('objective:' + text(newId(), 100)), title,
      description: text(row.description, 2000), requiredCapabilities, protectedAction, maxModelTier,
      priority: ['low', 'normal', 'high', 'urgent'].includes(row.priority) ? row.priority : 'normal', targetRoleId: targetRoleId || null,
      routing: { status: routed.status, reason: text(routed.reason, 300) }, assignedRoleId: routed.role ? routed.role.id : null,
      assignedModelTier: routed.role ? routed.role.modelTier : null,
      approvalState: routed.status === 'approval_required' ? 'required' : 'not_required', status: routed.status,
      parentObjectiveId: rel.parentObjectiveId || null, decompositionDepth: Number(rel.decompositionDepth) || 0,
      dependsOnObjectiveIds: Array.isArray(rel.dependsOnObjectiveIds) ? rel.dependsOnObjectiveIds.slice() : [],
      auditTargetObjectiveId: rel.auditTargetObjectiveId || null, auditRequest: rel.auditRequest || null,
      scoutRequest: rel.scoutRequest || null, scoutReportId: null,
      recurringOccurrence: rel.recurringOccurrence || null,
      workflowAudit: Array.isArray(rel.workflowAudit) ? rel.workflowAudit.slice(0, 20) : [],
      classification: row.classification && typeof row.classification === 'object' ? row.classification : null,
      createdAt: stamp, updatedAt: stamp, completedAt: 0, completionEvidenceRefs: [], admissionAudit: [] };
  }
  async function create(input) {
    const objective = build(input);
    await durable.update('station', stored => { const list = Array.isArray(stored) ? stored.slice() : []; list.push(objective); while (list.length > CAP) list.shift(); return list; });
    return objective;
  }
  async function decompose(parentId, input) {
    const body = input && typeof input === 'object' ? input : {}, decompositionId = text(body.decompositionId, 120);
    const specs = Array.isArray(body.children) ? body.children : [];
    if (!decompositionId) throw new Error('decompositionId is required');
    if (specs.length < 2 || specs.length > 8) throw new Error('decomposition requires 2-8 children');
    if (JSON.stringify(specs).length > 24000) throw new Error('decomposition payload is too large');
    let result;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], pi = list.findIndex(x => x && x.id === String(parentId || ''));
      if (pi < 0) throw new Error('parent objective not found');
      const parent = list[pi], role = deps.registry.get(parent.assignedRoleId);
      if (parent.decomposition && parent.decomposition.id === decompositionId) { result = { parent, children: parent.decomposition.childIds.map(id => list.find(x => x && x.id === id)).filter(Boolean), idempotent: true }; return undefined; }
      if (parent.decomposition) throw new Error('parent objective already decomposed');
      if (parent.protectedAction || parent.status === 'approval_required') throw new Error('protected parent requires approval');
      if (parent.status !== 'assigned' || !role || role.availability !== 'active' || !role.capabilities.includes('coordinate')) throw new Error('parent is not an available coordinator objective');
      const depth = (Number(parent.decompositionDepth) || 0) + 1; if (depth > 3) throw new Error('decomposition depth limit exceeded');
      if (list.length + specs.length > CAP) throw new Error('objective store capacity exceeded');
      const children = [], ids = specs.map(() => 'objective:' + text(newId(), 100));
      for (let i = 0; i < specs.length; i++) {
        const rawDeps = Array.isArray(specs[i] && specs[i].dependsOn) ? specs[i].dependsOn : [];
        if (rawDeps.some(n => !Number.isInteger(n) || n < 0 || n >= i)) throw new Error('child dependencies must reference earlier child indexes');
        const child = build(specs[i], { id: ids[i], parentObjectiveId: parent.id, decompositionDepth: depth, dependsOnObjectiveIds: rawDeps.map(n => ids[n]) });
        children.push(child);
      }
      const stamp = Math.max(0, Number(now()) || 0), nextParent = Object.assign({}, parent, { status: 'decomposed', decompositionState: 'active', updatedAt: stamp,
        decomposition: { id: decompositionId, childIds: ids, at: stamp, decision: 'bounded multi-capability decomposition' } });
      list[pi] = nextParent; list.push(...children); result = { parent: nextParent, children, idempotent: false }; return list;
    });
    return result;
  }
  async function reconcileParent(parentId) {
    let parent = null;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], pi = list.findIndex(x => x && x.id === String(parentId || ''));
      if (pi < 0) return undefined; const cur = list[pi], ids = cur.decomposition && cur.decomposition.childIds;
      if (!Array.isArray(ids) || !ids.length) return undefined;
      const children = ids.map(id => list.find(x => x && x.id === id)).filter(Boolean); if (children.length !== ids.length) return undefined;
      let status = 'decomposed', state = 'active', reason = 'children in progress';
      if (children.some(x => x.status === 'approval_required')) { status = 'waiting_approval'; state = 'waiting_approval'; reason = 'child approval required'; }
      else if (children.some(x => x.status === 'failed' || x.status === 'cancelled' || x.status === 'blocked')) { status = 'blocked'; state = 'blocked'; reason = 'required child did not complete'; }
      else if (children.every(x => x.status === 'completed')) { status = 'completed'; state = 'completed'; reason = 'all required children completed'; }
      const stamp = Math.max(0, Number(now()) || 0); parent = Object.assign({}, cur, { status, decompositionState: state, settlementReason: reason, updatedAt: stamp,
        completedAt: status === 'completed' ? stamp : 0, completionEvidenceRefs: status === 'completed' ? ids.slice() : cur.completionEvidenceRefs });
      list[pi] = parent; return list;
    }); return parent;
  }
  async function createAudit(targetId, input) {
    const body = input && typeof input === 'object' ? input : {}, auditId = text(body.auditId, 120);
    if (!auditId) throw new Error('auditId is required');
    let result;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], target = list.find(x => x && x.id === String(targetId || ''));
      if (!target) throw new Error('audit target objective not found');
      if (!FINAL.has(target.status)) throw new Error('audit target objective is not settled');
      const existing = list.find(x => x && x.auditRequest && x.auditRequest.id === auditId);
      if (existing) {
        if (existing.auditTargetObjectiveId !== target.id) throw new Error('auditId already targets another objective');
        result = { objective: existing, idempotent: true }; return undefined;
      }
      if (list.length >= CAP) throw new Error('objective store capacity exceeded');
      const targetSnapshot = ['Target: ' + target.id, 'Title: ' + target.title, 'Status: ' + target.status,
        'Assigned role: ' + (target.assignedRoleId || 'unassigned'), 'Settlement: ' + (target.settlementReason || 'not recorded'),
        'Result summary: ' + (target.resultSummary || 'not recorded'), 'Evidence: ' + (strings(target.completionEvidenceRefs, 24, 240).join(', ') || 'none recorded')].join('\n');
      const objective = build({ title: text(body.title, 240) || ('Audit objective: ' + target.title),
        description: text(body.description, 1200) || ('Independently verify this settled objective from its bounded record. Report findings and exceptions; do not repeat or expand the target action.\n\n' + targetSnapshot),
        requiredCapabilities: ['audit', 'verify'], maxModelTier: body.maxModelTier || 'economy', targetRoleId: 'operations.auditor', priority: body.priority || 'normal' },
      { auditTargetObjectiveId: target.id, auditRequest: { id: auditId, at: Math.max(0, Number(now()) || 0), targetStatus: target.status,
        targetEvidenceRefs: strings(target.completionEvidenceRefs, 24, 240) } });
      list.push(objective); result = { objective, idempotent: false }; return list;
    });
    return result;
  }
  async function createScout(request) {
    let result;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], existing = list.find(x => x && x.scoutRequest && x.scoutRequest.id === request.scoutId);
      const signature = JSON.stringify(request.scope);
      if (existing) {
        if (existing.scoutRequest.signature !== signature) throw new Error('scoutId already has another scope');
        result = { objective: existing, idempotent: true }; return undefined;
      }
      if (list.length >= CAP) throw new Error('objective store capacity exceeded');
      const s = request.scope;
      const objective = build({ title: 'Daily Open-Source Scout: ' + s.topic, description: scoutDirective(s),
        requiredCapabilities: ['discover_open_source', 'research', 'recommend'], maxModelTier: 'economy', targetRoleId: 'operations.open_source_scout' },
      { scoutRequest: { id: request.scoutId, signature, scope: s, safety: request.safety, sourceAdapterIds: s.sourceAdapterIds, at: Math.max(0, Number(now()) || 0) } });
      list.push(objective); result = { objective, idempotent: false }; return list;
    }); return result;
  }
  async function recordScoutReport(id, reportId) {
    let updated;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], index = list.findIndex(x => x && x.id === String(id || ''));
      if (index < 0) throw new Error('Scout objective not found'); const current = list[index];
      if (!current.scoutRequest) throw new Error('objective is not a Scout request');
      if (current.status !== 'completed') throw new Error('Scout objective did not complete successfully');
      if (current.scoutReportId && current.scoutReportId !== reportId) throw new Error('Scout objective already has another report');
      if (current.scoutReportId === reportId) { updated = current; return undefined; }
      const audit = (Array.isArray(current.workflowAudit) ? current.workflowAudit : []).slice(-19);
      audit.push({ event: 'scout_report_created', reportId, at: Math.max(0, Number(now()) || 0) });
      updated = Object.assign({}, current, { scoutReportId: reportId, workflowAudit: audit, updatedAt: Math.max(Number(current.updatedAt) || 0, Number(now()) || 0) });
      list[index] = updated; return list;
    }); return updated;
  }
  async function createRecurringOccurrence(definition, occurrenceKey) {
    let result;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], existing = list.find(x => x && x.recurringOccurrence && x.recurringOccurrence.key === occurrenceKey);
      if (existing) { result = { objective: existing, idempotent: true }; return undefined; }
      const pending = list.find(x => x && x.recurringOccurrence && x.recurringOccurrence.scheduleId === definition.scheduleId && !FINAL.has(x.status));
      if (pending) { result = { objective: pending, idempotent: true, reusedPending: true }; return undefined; }
      if (list.length >= CAP) throw new Error('objective store capacity exceeded');
      const t = definition.template, scout = t.workflow === 'open-source-scout' ? { id: occurrenceKey.slice(0, 120), signature: occurrenceKey,
        scope: t.workflowConfig.scope, safety: t.workflowConfig.safety, sourceAdapterIds: t.workflowConfig.scope.sourceAdapterIds,
        at: Math.max(0, Number(now()) || 0) } : null;
      const objective = build(Object.assign({}, t, { targetRoleId: definition.roleId }),
        { recurringOccurrence: { key: occurrenceKey, scheduleId: definition.scheduleId, cronJobId: definition.cronJobId || null,
          cronRunId: definition.cronRunId || null, scheduledFor: definition.scheduledFor || null, createdAt: Math.max(0, Number(now()) || 0) }, scoutRequest: scout,
          workflowAudit: [{ event: 'recurring_occurrence_created', scheduleId: definition.scheduleId, occurrenceKey, at: Math.max(0, Number(now()) || 0) }] });
      list.push(objective); result = { objective, idempotent: false }; return list;
    }); return result;
  }
  function list(limit) { const cap = Math.max(1, Math.min(250, Number(limit) || 50)); const rows = durable.get('station'); return (Array.isArray(rows) ? rows : []).filter(Boolean).slice(-cap).reverse(); }
  function get(id) { const rows = durable.get('station'); return (Array.isArray(rows) ? rows : []).find(row => row && row.id === String(id || '')) || null; }
  function find(predicate) { const rows = durable.get('station'); return typeof predicate === 'function' ? (Array.isArray(rows) ? rows : []).find(predicate) || null : null; }
  function listAway() { const rows = durable.get('station'); return (Array.isArray(rows) ? rows : []).filter(x => x && x.awayWork).slice(-250).reverse(); }
  function hasAwayReady(atMs, leaseMs) { const stale = Math.max(0, Number(atMs) || 0) - Math.max(60000, Number(leaseMs) || 3600000); return listAway().some(x => ['assigned', 'admitted'].includes(x.status) && (x.awayWork.state === 'queued' || (x.awayWork.state === 'claimed' && Number(x.awayWork.claimedAt) <= stale))); }
  async function queueAway(id) {
    let updated = null;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], index = list.findIndex(x => x && x.id === String(id || ''));
      if (index < 0) throw new Error('objective not found');
      const current = list[index];
      if (current.protectedAction || current.approvalState === 'required' || current.status === 'approval_required') throw new Error('protected objective requires approval');
      if (!['assigned', 'admitted'].includes(current.status)) throw new Error('objective is not ready for Away work');
      if (current.awayWork && ['queued', 'claimed'].includes(current.awayWork.state)) { updated = current; return undefined; }
      const stamp = Math.max(0, Number(now()) || 0);
      updated = Object.assign({}, current, { updatedAt: stamp, awayWork: { state: 'queued', queuedAt: stamp, claimedAt: 0, attempts: 0, lastReason: '' } });
      list[index] = updated; return list;
    }); return updated;
  }
  async function claimAway(leaseMs) {
    let claimed = null; const stamp = Math.max(0, Number(now()) || 0), stale = stamp - Math.max(60000, Number(leaseMs) || 3600000);
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], index = list.findIndex(x => x && x.awayWork && (x.awayWork.state === 'queued' || (x.awayWork.state === 'claimed' && Number(x.awayWork.claimedAt) <= stale)) && ['assigned', 'admitted'].includes(x.status));
      if (index < 0) return undefined;
      const current = list[index], attempts = Math.max(0, Number(current.awayWork.attempts) || 0) + 1;
      claimed = Object.assign({}, current, { updatedAt: stamp, awayWork: Object.assign({}, current.awayWork, { state: 'claimed', claimedAt: stamp, attempts }) });
      list[index] = claimed; return list;
    }); return claimed;
  }
  async function finishAway(id, outcome) {
    let updated = null;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], index = list.findIndex(x => x && x.id === String(id || ''));
      if (index < 0) throw new Error('objective not found');
      const current = list[index], prior = current.awayWork;
      if (!prior || prior.state !== 'claimed') { updated = current; return undefined; }
      const o = outcome || {}, retry = o.retry === true && Number(prior.attempts) < 3, stamp = Math.max(0, Number(now()) || 0);
      updated = Object.assign({}, current, { updatedAt: Math.max(Number(current.updatedAt) || 0, stamp), awayWork: Object.assign({}, prior, {
        state: retry ? 'queued' : (o.ok ? 'completed' : 'blocked'), claimedAt: 0, finishedAt: retry ? 0 : stamp, lastReason: text(o.reason, 300)
      }) });
      list[index] = updated; return list;
    }); return updated;
  }
  async function cancelAway(id) {
    let updated = null;
    await durable.update('station', stored => {
      const list = Array.isArray(stored) ? stored.slice() : [], index = list.findIndex(x => x && x.id === String(id || ''));
      if (index < 0) throw new Error('objective not found');
      const current = list[index], prior = current.awayWork;
      if (!prior || prior.state !== 'queued') throw new Error('objective is not queued for Away work');
      const stamp = Math.max(0, Number(now()) || 0);
      updated = Object.assign({}, current, { updatedAt: stamp, awayWork: Object.assign({}, prior, { state: 'cancelled', finishedAt: stamp, lastReason: 'Away queue cancelled by user' }) });
      list[index] = updated; return list;
    }); return updated;
  }
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
  return { create, decompose, reconcileParent, createAudit, createScout, recordScoutReport, createRecurringOccurrence, list, get, find, listAway, hasAwayReady, queueAway, claimAway, finishAway, cancelAway, recordAdmission, recordLifecycle, updateStatus, readStatus: () => durable.readKey('station'), _durable: durable };
}
module.exports = { makeObjectiveStore, publicRole, CAP };
