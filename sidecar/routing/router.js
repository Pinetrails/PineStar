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
  let capsPlan = null;   // last WELL-FORMED posted plan, deployable or not — the CAPABILITY view only (see setPlan)
  let stationPlan = null;
  let rr = {};   // per-SPLITTER-tile round-robin counter so dispatch spreads work across lanes (matches the engine)
  const stationStore = o.stationStore || makeStationStore();

  // store a posted plan. null/empty clears it (no routing floor). A plan with BLOCKING errors is refused.
  function setPlan(p) {
    if (!p || typeof p !== 'object') { plan = null; capsPlan = null; return { ok: true, cleared: true }; }
    if (!Array.isArray(p.errors)) { plan = null; capsPlan = null; return { ok: false, error: 'malformed plan' }; }
    // CAPABILITY IS NOT ROUTING (2026-07-26). Which objects a bay's room holds is a fact about the PLACED
    // FLOOR — true whether or not the belts compile. Refusing a plan outright used to drop that fact too, so
    // one blocking error (a loop, a dup binding, and until today a stray unbelted INTAKE) silently handed
    // every bay-bound agent the DEFAULT OFFICE while the world still painted "NO COMPUTE" over its bay: the
    // UI asserting a restriction the harness had stopped applying, and the looser grant of the two. Keeping
    // the bay projection here means the claim and the grant stay one fact; ROUTING still refuses below.
    capsPlan = p;
    if (!Pipeline.ok(p)) { plan = null; return { ok: false, error: 'plan has blocking errors', codes: p.errors.filter(e => !e.warn).map(e => e.code) }; }
    plan = p; rr = {}; return { ok: true, hash: p.hash || null, bays: (p.bays || []).length };   // new floor -> reset round-robin
  }
  function clearPlan() { plan = null; capsPlan = null; rr = {}; }
  function activePlan() { return stationPlan || plan; }
  function getPlan() { return activePlan(); }
  function hasPlan() { return !!activePlan(); }
  function setStation(stationDoc) {
    const v = stationStore.validateStationDoc(stationDoc);
    if (!v.ok) return { ok: false, error: v.error };
    if (!v.routingOk && stationPlan) {
      return {
        ok: false,
        error: 'station routing plan has blocking errors',
        codes: v.routingPlan.errors.filter(e => !e.warn).map(e => e.code)
      };
    }
    const r = stationStore.setStation(stationDoc);
    if (!r.ok) return r;
    stationPlan = r.routingOk ? r.routingPlan : null;
    rr = {};
    return r;
  }
  function clearStation() { stationPlan = null; return stationStore.clearStation(); }
  function getStation() { return stationStore.getStation(); }
  // the agentId a work-item routes to, or null (caller falls back to its default resolution — never stalls).
  // The picker advances a per-splitter-tile counter, so successive work-items spread across the splitter's lanes
  // (a FILTER stays deterministic by tag and ignores it) — dispatch load-balances instead of always lane 0.
  function resolveTarget(ctx) {
    const p = activePlan();
    if (!p) return null;
    const pick = (k, n) => { const c = rr[k] || 0; rr[k] = (c + 1) % n; return c; };
    return Pipeline.resolveTarget(p, ctx || {}, pick);
  }

  /* Phase B5 — per-bay capability isolation. The resolveTools-shaped station for a BAY-bound agent, built from
     the objects the floor placed in that bay's room (carried on the posted plan). null for any agent WITHOUT a
     bay (the caller then uses its own default office), so only bay-routed work is isolated; everything else is
     unchanged. PURE room objects — no baseline — so an UNEQUIPPED bay grants no compute and can't spend (the
     compute gate stays shut; cost-safe), exactly mirroring resolveTools' projection of the placed floor. */
  function stationFor(agentId) {
    // the CAPABILITY view: an authoritative station wins, else the last well-formed posted plan — deployable
    // or not (a broken belt graph must not widen an agent's reach; see the setPlan note).
    const p = stationPlan || plan || capsPlan;
    if (!p || !agentId) return null;
    // a bay isolates its agent whether or not a belt is hooked to it: `bays` = belt-hooked dispatch targets,
    // `dockBays` = EVERY bound bay (a lone dock is a complete build — 2026-07-05 sense pass). Older plans
    // without dockBays behave exactly as before.
    const bay = (p.bays || []).find(b => b.agentId === agentId) || (p.dockBays || []).find(b => b.agentId === agentId);
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
