'use strict';
const TIER = { economy: 0, balanced: 1, deep: 2 };
function cleanRole(input) {
  const r = input || {}, id = String(r.id || '');
  if (!/^[a-z][a-z0-9_.-]{2,79}$/.test(id)) throw new Error('invalid role id: ' + id);
  const tier = Object.prototype.hasOwnProperty.call(TIER, r.modelTier) ? r.modelTier : 'balanced';
  const capabilities = [...new Set((Array.isArray(r.capabilities) ? r.capabilities : []).map(String).filter(Boolean))].sort();
  if (!capabilities.length) throw new Error('role requires capabilities: ' + id);
  return Object.freeze({ id, displayName: String(r.displayName || id), department: String(r.department || 'general'), capabilities,
    modelTier: tier, escalationTargets: (Array.isArray(r.escalationTargets) ? r.escalationTargets : []).map(String),
    permissions: Object.assign({ protectedActions: false }, r.permissions || {}), availability: r.availability === 'inactive' ? 'inactive' : 'active' });
}
function makeRoleRegistry(seed) {
  const roles = new Map();
  function register(input) { const role = cleanRole(input); if (roles.has(role.id)) throw new Error('duplicate role id: ' + role.id); roles.set(role.id, role); return role; }
  for (const r of (Array.isArray(seed) ? seed : [])) register(r);
  function route(objective) {
    const o = objective || {};
    if (o.protectedAction) return { status: 'approval_required', role: null, reason: 'protected action requires Commander approval' };
    const needs = [...new Set((Array.isArray(o.requiredCapabilities) ? o.requiredCapabilities : []).map(String).filter(Boolean))];
    if (!needs.length) return { status: 'unroutable', role: null, reason: 'objective declares no required capabilities' };
    const maxTier = Object.prototype.hasOwnProperty.call(TIER, o.maxModelTier) ? TIER[o.maxModelTier] : TIER.deep;
    const candidates = [...roles.values()].filter(r => r.availability === 'active' && TIER[r.modelTier] <= maxTier && needs.every(c => r.capabilities.includes(c)));
    candidates.sort((a, b) => TIER[a.modelTier] - TIER[b.modelTier] || (a.capabilities.length - needs.length) - (b.capabilities.length - needs.length) || a.id.localeCompare(b.id));
    if (!candidates.length) return { status: 'escalate', role: null, reason: 'no active role satisfies the objective within its model tier' };
    return { status: 'assigned', role: candidates[0], reason: 'lowest capable active role' };
  }
  return { register, get: id => roles.get(String(id)) || null, list: () => [...roles.values()], route };
}
module.exports = { makeRoleRegistry, cleanRole, TIER };
