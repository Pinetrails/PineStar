/* sidecar/routing/router.js — the server-authoritative RoutingPlan + dispatch resolution.

   The browser posts the compiled plan (POST /api/routing) on every floor change; this holds it and answers
   "which agent runs this work-item?" via the SAME ../../frontend/app/pipeline.js the frontend uses — one
   compiler, two consumers, zero drift. A non-deployable plan (cycle / orphan source / dead bay) is NEVER
   stored, so routing can't loop or send work into a void; resolveTarget returning null lets the caller fall
   back to its own resolution, so real work never stalls. */
'use strict';
const Pipeline = require('../../frontend/app/pipeline.js');

function makeRouter() {
  let plan = null;

  // store a posted plan. null/empty clears it (no routing floor). A plan with BLOCKING errors is refused.
  function setPlan(p) {
    if (!p || typeof p !== 'object') { plan = null; return { ok: true, cleared: true }; }
    if (!Array.isArray(p.errors)) { plan = null; return { ok: false, error: 'malformed plan' }; }
    if (!Pipeline.ok(p)) { plan = null; return { ok: false, error: 'plan has blocking errors', codes: p.errors.filter(e => !e.warn).map(e => e.code) }; }
    plan = p; return { ok: true, hash: p.hash || null, bays: (p.bays || []).length };
  }
  function clearPlan() { plan = null; }
  function getPlan() { return plan; }
  function hasPlan() { return !!plan; }
  // the agentId a work-item routes to, or null (caller falls back to its default resolution — never stalls)
  function resolveTarget(ctx) { return plan ? Pipeline.resolveTarget(plan, ctx || {}) : null; }

  return { setPlan, clearPlan, getPlan, hasPlan, resolveTarget };
}

module.exports = { makeRouter };
