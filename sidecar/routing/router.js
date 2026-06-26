/* sidecar/routing/router.js — the server-authoritative RoutingPlan + dispatch resolution.

   The browser posts the compiled plan (POST /api/routing) on every floor change; this holds it and answers
   "which agent runs this work-item?" via the SAME ../../frontend/app/pipeline.js the frontend uses — one
   compiler, two consumers, zero drift. A non-deployable plan (cycle / orphan source / dead bay) is NEVER
   stored, so routing can't loop or send work into a void; resolveTarget returning null lets the caller fall
   back to its own resolution, so real work never stalls. */
'use strict';
const Pipeline = require('../../frontend/app/pipeline.js');
const { makeStationStore } = require('../station-store.js');

function makeRouter(o) {
  o = o || {};
  let plan = null;
  let rr = {};   // per-SPLITTER-tile round-robin counter so dispatch spreads work across lanes (matches the engine)
  const stationStore = o.stationStore || makeStationStore();

  // store a posted plan. null/empty clears it (no routing floor). A plan with BLOCKING errors is refused.
  function setPlan(p) {
    if (!p || typeof p !== 'object') { plan = null; return { ok: true, cleared: true }; }
    if (!Array.isArray(p.errors)) { plan = null; return { ok: false, error: 'malformed plan' }; }
    if (!Pipeline.ok(p)) { plan = null; return { ok: false, error: 'plan has blocking errors', codes: p.errors.filter(e => !e.warn).map(e => e.code) }; }
    plan = p; rr = {}; return { ok: true, hash: p.hash || null, bays: (p.bays || []).length };   // new floor -> reset round-robin
  }
  function clearPlan() { plan = null; rr = {}; }
  function getPlan() { return plan; }
  function hasPlan() { return !!plan; }
  function setStation(stationDoc) { return stationStore.setStation(stationDoc); }
  function clearStation() { return stationStore.clearStation(); }
  function getStation() { return stationStore.getStation(); }
  // the agentId a work-item routes to, or null (caller falls back to its default resolution — never stalls).
  // The picker advances a per-splitter-tile counter, so successive work-items spread across the splitter's lanes
  // (a FILTER stays deterministic by tag and ignores it) — dispatch load-balances instead of always lane 0.
  function resolveTarget(ctx) {
    if (!plan) return null;
    const pick = (k, n) => { const c = rr[k] || 0; rr[k] = (c + 1) % n; return c; };
    return Pipeline.resolveTarget(plan, ctx || {}, pick);
  }

  /* Phase B5 — per-bay capability isolation. The resolveTools-shaped station for a BAY-bound agent, built from
     the objects the floor placed in that bay's room (carried on the posted plan). null for any agent WITHOUT a
     bay (the caller then uses its own default office), so only bay-routed work is isolated; everything else is
     unchanged. PURE room objects — no baseline — so an UNEQUIPPED bay grants no compute and can't spend (the
     compute gate stays shut; cost-safe), exactly mirroring resolveTools' projection of the placed floor. */
  function stationFor(agentId) {
    if (!plan || !agentId) return null;
    const bay = (plan.bays || []).find(b => b.agentId === agentId);
    if (!bay) return null;
    const authoritative = stationStore.hasStation() ? stationStore.bayObjects(agentId) : null;
    const objs = Array.isArray(authoritative) ? authoritative : (Array.isArray(bay.objects) ? bay.objects : []);
    // each entry is EITHER a bare objectType string (the generic caps: 'computer'/'dish'/…) OR a rich object
    // { objectType, … } carrying per-instance data — e.g. a connector portal's { objectType:'connector',
    // connectorId } so the manager can project THAT server's tools. Normalize both to a room object.
    return {
      agents: { [agentId]: { id: agentId, room: 'bay' } },
      rooms: { bay: { id: 'bay', objects: objs.map((t, i) =>
        (t && typeof t === 'object') ? Object.assign({ instanceId: 'o' + i }, t) : { instanceId: 'o' + i, objectType: t }
      ) } }
    };
  }

  return { setPlan, clearPlan, getPlan, hasPlan, setStation, clearStation, getStation, resolveTarget, stationFor };
}

module.exports = { makeRouter };
