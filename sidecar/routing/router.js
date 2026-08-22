/* sidecar/routing/router.js — the server-authoritative RoutingPlan + dispatch resolution.

   The browser posts the compiled plan (POST /api/routing) on every floor change; this holds it and answers
   "which agent runs this work-item?" via the SAME ../../frontend/app/pipeline.js the frontend uses — one
   compiler, two consumers, zero drift. A non-deployable plan (cycle / orphan source / dead bay) is NEVER
   stored, so routing can't loop or send work into a void; resolveTarget returning null lets the caller fall
   back to its own resolution, so real work never stalls. */
'use strict';
const Pipeline = require('../../frontend/app/pipeline.js');
const { makeStationStore } = require('../station-store.js');
const { healPlan } = require('./planlines.js');

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
    /* SELF-HEAL A PRE-LINE-IDENTITY PLAN (2026-08-07). chainNext reads a missing line map as "every dock is
       terminal", which is the right default for an unknown floor but the WRONG one for a plan whose geometry
       we are holding: a headless sidecar restoring a pre-arc plan from disk ran stage one of every drawn line
       and nothing else, with no browser ever coming along to re-post. planlines derives the map from THIS
       plan's own belts + machine hookups; a plan that already carries one is returned untouched, so the
       compiler stays the authority whenever it has spoken. */
    p = healPlan(p);
    // CAPABILITY IS NOT ROUTING (2026-07-26). Which objects a bay's room holds is a fact about the PLACED
    // FLOOR — true whether or not the belts compile. Refusing a plan outright used to drop that fact too, so
    // one blocking error (a loop, a dup binding, and until today a stray unbelted INTAKE) silently handed
    // every bay-bound agent the DEFAULT OFFICE while the world still painted "NO COMPUTE" over its bay: the
    // UI asserting a restriction the harness had stopped applying, and the looser grant of the two. Keeping
    // the bay projection here means the claim and the grant stay one fact; ROUTING still refuses below.
    // The refusal carries `caps: true` so the persistence seam (index.js handleRouting) keeps this plan on
    // disk: capsPlan was memory-only, so a refusal followed by a RESTART re-opened the same default-office
    // hole this block closed live (2026-08-10 audit #1). Boot replays the file through this same function.
    capsPlan = p;
    if (!Pipeline.ok(p)) { plan = null; return { ok: false, error: 'plan has blocking errors', caps: true, codes: p.errors.filter(e => !e.warn).map(e => e.code) }; }
    /* KEEP SPLITTER BALANCE ACROSS A NO-OP RE-POST (2026-08-07). `rr` is the per-splitter round-robin counter
       that makes dispatch SPREAD across a splitter's lanes; resetting it on every accepted plan meant any
       re-post restarted every splitter at lane 0. plan.hash is exactly the dispatch topology (sources, bays,
       junctions, belts — see the hash note in pipeline.js), so an identical hash guarantees the same splitter
       tiles with the same lane counts and the counters stay meaningful. A CHANGED (or absent, i.e. older and
       unprovable) hash still resets: a floor edit really is a new floor. */
    const same = !!(plan && p.hash && plan.hash && p.hash === plan.hash);
    plan = p; if (!same) rr = {};
    return { ok: true, hash: p.hash || null, bays: (p.bays || []).length };
  }
  function clearPlan() { plan = null; capsPlan = null; rr = {}; }
  function activePlan() { return stationPlan || plan; }
  function getPlan() { return activePlan(); }
  function hasPlan() { return !!activePlan(); }
  function setStation(stationDoc) {
    const v = stationStore.validateStationDoc(stationDoc);
    if (!v.ok) return { ok: false, error: v.error };
    // a non-deployable station (cycle/orphan/dead bay) is refused UNCONDITIONALLY. The old guard
    // (`!v.routingOk && stationPlan`) made validation order-dependent: a FIRST install of a cyclic
    // station slipped through and claimed ok while arming no routing — the same doc refused a moment
    // later if any station was already installed. Refusal must not depend on install order (2026-08-04).
    if (!v.routingOk) {
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
    ctx = ctx || {};
    /* LINE-SCOPED DISPATCH (sample proof, 2026-08-10 audit — "sample not line-scoped"). An optional
       ctx.lineId narrows the UNADDRESSED source walk to the named line's OWN doors: only the INBOX
       sources whose intake prop the compiled plan puts on that line are walked, so the work enters
       through that line's front door and nowhere else. Everything else is byte-identical — the same
       Pipeline.resolveTarget walk, the same shared round-robin counters (a splitter on the named line
       still spreads), and no caller that omits lineId changes behaviour (no production ctx carried a
       lineId before this). The filter reads the plan's own compiled lineOfProp map — no second
       derivation of line membership. A named line with no doors resolves null (the caller refuses
       honestly; dispatch never silently widens to another line's intake). */
    if (ctx.lineId != null && String(ctx.lineId)) {
      const want = String(ctx.lineId);
      const lop = p.lineOfProp || {};
      const srcs = (p.sources || []).filter(s => s && s.propId != null && String(lop[String(s.propId)] || '') === want);
      if (!srcs.length) return null;
      return Pipeline.resolveTarget(Object.assign({}, p, { sources: srcs }), ctx, pick);
    }
    return Pipeline.resolveTarget(p, ctx, pick);
  }

  /* WHICH LINE DOES THIS DOCK BELONG TO? Read straight off the compiled plan (never re-derived) — the
     single fact the gate, the cron fire and the floor's crate honesty all quote. null = this agent crews
     no dock on the armed plan, or the plan predates line identity (both TERMINAL — see Pipeline.chainNext).
     Used by triggers that name their dock OUTRIGHT: a routine fires AT a dock, so it is that line's own
     trigger whether or not a door also feeds that dock. */
  function lineOfAgent(agentId) {
    const p = activePlan();
    return p ? Pipeline.lineOf(p, agentId) : null;
  }

  /* WORK ORIGIN for work ARRIVING FROM OUTSIDE (a channel message, a sample job): the line it belongs to,
     or null when nothing triggered a workflow. Adds the door test to lineOfAgent — only a dock the plan's
     INBOX sources actually reach counts as "it rode in through this line's front door" (see the full
     reasoning on Pipeline.lineOriginOf). Asked of the agent that RUNS, never of how the message was
     addressed, because the per-agent channel bots hard-lock stage one and consult no floor routing. */
  function lineOriginFor(agentId) {
    const p = activePlan();
    return p ? Pipeline.lineOriginOf(p, agentId) : null;
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

  /* THE STANDING BRIEF (step editor, 2026-08-05): the Commander's job brief for the dock this agent crews,
     or null. PROMPT TEXT ONLY — it is injected into run prompts (hub entry runs, chain handoffs) and must
     never influence resolveTarget/chainNext (routing) or stationFor (capability). Same plan precedence as
     stationFor: a brief is a fact about the PLACED floor, true whether or not the belts compile — so it
     reads the capability view (stationPlan || plan || capsPlan), and a broken belt graph can't strip it. */
  function stageBrief(agentId) {
    const p = stationPlan || plan || capsPlan;
    if (!p || !agentId) return null;
    // dockBays FIRST (2026-08-07): the brief now rides ONLY the legibility list, because `bays` is a hash input
    // and prompt text may not move the dispatch hash (a brief edit was re-posting the plan and wiping splitter
    // balance — see the pipeline.js note). `bays` stays as a fallback so a plan persisted by an older compile,
    // which carried the brief on both lists, still answers. dockBays ⊇ bays, so nothing is lost.
    const bay = (p.dockBays || []).find(b => b.agentId === agentId) || (p.bays || []).find(b => b.agentId === agentId);
    const b = bay && typeof bay.brief === 'string' ? bay.brief.trim() : '';
    return b ? b.slice(0, 2000) : null;
  }

  /* THE CHAIN EDGE (agentic graphs): which agent does THIS dock's output hand off to? null = a terminal stage
     (its reply is the pipeline's answer) or no routing floor at all. Reads the same compiled plan and the same
     round-robin counters as resolveTarget, so a SPLIT downstream of a dock spreads exactly like one upstream —
     the crate the world draws and the run the sidecar buys are one decision. */
  function chainNext(agentId, ctx) {
    const p = activePlan();
    if (!p || !agentId) return null;
    const pick = (k, n) => { const c = rr[k] || 0; rr[k] = (c + 1) % n; return c; };
    return Pipeline.chainNext(p, agentId, ctx || {}, pick);
  }

  /* chainStep / fanSiblings (2026-08-21) — the JOINER + LOOP reading of the same plan, same pick counter, for the
     chain runner. chainNext above stays the plain single-dock reading every older surface uses. */
  function chainStep(agentId, ctx) {
    const p = activePlan();
    if (!p || !agentId || !Pipeline.chainStep) return null;
    const pick = (k, n) => { const c = rr[k] || 0; rr[k] = (c + 1) % n; return c; };
    return Pipeline.chainStep(p, agentId, ctx || {}, pick);
  }
  function fanSiblings(agentId) {
    const p = activePlan();
    if (!p || !agentId || !Pipeline.fanSiblings) return [];
    return Pipeline.fanSiblings(p, agentId);
  }

  // A clean model run is not necessarily a shipped work line. This reports whether the final dock's compiled
  // outbound lane actually reaches OUTBOX rather than terminating at an open belt end.
  function chainShipsToOutbox(agentId) {
    const p = activePlan();
    const rec = p && p.chains && p.chains[agentId];
    return !!(rec && rec.outbox && !rec.deadEnd);
  }

  return { setPlan, clearPlan, getPlan, hasPlan, setStation, clearStation, getStation, resolveTarget, lineOfAgent, lineOriginFor, chainNext, chainStep, fanSiblings, chainShipsToOutbox, stationFor, stageBrief };
}

module.exports = { makeRouter };
