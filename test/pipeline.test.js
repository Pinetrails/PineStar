/* test/pipeline.test.js — headless tests for the belt-graph -> RoutingPlan compiler (frontend/app/pipeline.js).
   Pure function of geo {props, belts}; no DOM, no time, no RNG — loads with a plain require(). */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/pipeline.js');

const geo = (props, belts) => ({ props, belts });
const belt = (x, y, dir) => ({ x, y, dir });

/* ---- a complete INTAKE -> belt -> BAY floor routes + validates clean ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E')]
  ));
  A.eq(plan.sources.length, 1, 'one INTAKE source bound to its belt tile');
  A.eq(plan.bays.length, 1, 'one BAY bound to its belt tile');
  A.eq(plan.bays[0].agentId, 'coder', 'the bay carries its agentId');
  A.eq(plan.reach.coder, true, 'the coder bay is reachable from the source');
  A.eq(plan.errors.length, 0, 'a complete intake->belt->bay floor has no errors');
  A.ok(P.ok(plan), 'plan is deployable');
  A.eq(P.resolveTarget(plan, { tag: 'anything' }), 'coder', 'resolveTarget routes work to the single bay');
}

/* ---- ORPHAN_SOURCE: an intake with no adjacent belt ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }], [belt(8, 8, 'E')]
  ));
  A.ok(plan.errors.some(e => e.code === 'ORPHAN_SOURCE' && e.warn), 'an intake with no belt -> ORPHAN_SOURCE (warn)');
  A.ok(P.ok(plan), 'an unbelted intake is advice, never a deploy blocker (it contributes no source at all)');
}

/* ---- an unbelted INTAKE beside a WORKING line must not condemn the line (2026-07-26 audit) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'coder' },
     { id: 'i2', t: 'intake', x: 12, y: 9, w: 1, h: 1 }],            // decorative: nowhere near a belt
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E')]
  ));
  A.ok(plan.errors.some(e => e.code === 'ORPHAN_SOURCE' && e.propId === 'i2'), 'the stray intake is still flagged');
  A.ok(P.ok(plan), 'one decorative intake does NOT make the whole floor non-deployable');
  A.eq(P.resolveTarget(plan, { tag: 'anything' }), 'coder', 'the working line still routes');
}

/* ---- detectCycle is iterative: a long connected run must compile, not blow the call stack ---- */
{
  const belts = [];                                    // 71x71 connected serpentine = 5041 chained tiles
  for (let y = 0; y < 71; y++) {
    const ltr = y % 2 === 0;
    for (let x = 0; x < 71; x++) {
      const endOfRow = ltr ? (x === 70) : (x === 0);
      belts.push({ x, y, dir: (endOfRow && y < 70) ? 'S' : (ltr ? 'E' : 'W') });
    }
  }
  let threw = null, plan = null;
  try { plan = P.compileRoutingPlan({ belts, props: [], origin: { tx: 0, ty: 0 } }); } catch (e) { threw = e; }
  A.ok(!threw, 'a 5041-tile connected belt run compiles (no RangeError: ' + (threw && threw.message) + ')');
  A.ok(plan && !plan.errors.some(e => e.code === 'CYCLE'), '...and is correctly seen as acyclic');
  // and a real loop inside a long run is still caught
  const loop = belts.slice(0, 200).concat([{ x: 0, y: 80, dir: 'E' }, { x: 1, y: 80, dir: 'S' }, { x: 1, y: 81, dir: 'W' }, { x: 0, y: 81, dir: 'N' }]);
  const lp = P.compileRoutingPlan({ belts: loop, props: [], origin: { tx: 0, ty: 0 } });
  A.ok(lp.errors.some(e => e.code === 'CYCLE'), 'a cycle is still detected after the iterative rewrite');
  A.ok(!P.ok(lp), 'a cyclic plan stays non-deployable');
}

/* ---- BAY_NOT_FED (was blocking DEAD_BAY): a hooked bay whose belt serves NEITHER direction ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 8, y: 8, w: 2, h: 2, agentId: 'lonely' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(9, 8, 'E')]   // bay's belt scrap: no intake feeds it, no outbox receives it
  ));
  A.eq(plan.reach.lonely, false, 'an unconnected bay is not reachable');
  A.ok(plan.errors.some(e => e.code === 'BAY_NOT_FED' && e.agentId === 'lonely' && e.warn), 'belt to nowhere -> BAY_NOT_FED (warn)');
  A.ok(P.ok(plan), 'a belt-to-nowhere is advice, never a deploy blocker (dispatch cannot route to it anyway)');
}

/* ---- LONE BAY IS A COMPLETE BUILD: no intake, no belts -> zero findings (the 2026-07-05 confusion bug) ---- */
{
  const plan = P.compileRoutingPlan(geo([{ id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'solo' }], []));
  A.eq(plan.errors.length, 0, 'a lone assigned bay has NO errors — the simplest build just works');
  A.ok(P.ok(plan), 'lone-bay plan is deployable');
  A.eq(plan.dockBays.length, 1, 'the lone bay is recorded as a working dock');
  A.eq(plan.bays.length, 0, 'a beltless bay never enters the dispatch bays (router semantics untouched)');
}

/* ---- OUTBOUND LANE IS VALID + GLOWS: bay -> belt -> OUTBOX with NO intake (Andrew's exact repro) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'b1', t: 'bay', x: 0, y: 0, w: 2, h: 2, agentId: 'coder' },
     { id: 'o1', t: 'outbox', x: 6, y: 0, w: 2, h: 2 }],
    [belt(2, 1, 'E'), belt(3, 1, 'E'), belt(4, 1, 'E'), belt(5, 1, 'E')]
  ));
  A.eq(plan.errors.length, 0, 'bay->belt->outbox with no intake: ZERO findings (a correct ship-out lane, not "NO ROUTE IN")');
  A.ok(P.ok(plan), 'the outbound lane deploys');
  const live = P.liveTiles(plan);
  A.ok(live['2,1'] && live['3,1'] && live['4,1'] && live['5,1'], 'the outbound lane GLOWS live end to end');
  const r = P.routeFrom(plan, 3, 1);
  A.ok(r.outbox && !r.deadEnd && r.agents.length === 0, 'hovering the outbound lane answers OUTBOX, not DEAD END');
}

/* ---- ORPHAN_BAY is contextual: beltless bay + an intake line elsewhere -> warn; without a line -> silent ---- */
{
  const withLine = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 8, y: 8, w: 2, h: 2, agentId: 'apart' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E')]
  ));
  A.ok(withLine.errors.some(e => e.code === 'ORPHAN_BAY' && e.warn), 'a line exists + bay not hooked -> NOT ON THE LINE (warn)');
  A.ok(P.ok(withLine), '...and it never blocks deploy');
  const noLine = P.compileRoutingPlan(geo([{ id: 'b1', t: 'bay', x: 8, y: 8, w: 2, h: 2, agentId: 'apart' }], [belt(1, 0, 'E')]));
  A.ok(!noLine.errors.some(e => e.code === 'ORPHAN_BAY'), 'no intake line anywhere -> a beltless bay is NOT a finding');
}

/* ---- CYCLE: a belt loop is a HARD error (a loop = infinite paid runOnce) ---- */
{
  const plan = P.compileRoutingPlan(geo([], [belt(0, 0, 'E'), belt(1, 0, 'S'), belt(1, 1, 'W'), belt(0, 1, 'N')]));
  A.ok(plan.errors.some(e => e.code === 'CYCLE'), 'a belt loop -> CYCLE');
  A.ok(!P.ok(plan), 'a cyclic plan is never deployable');
}

/* ---- DUP_AGENT: two bays bound to the same agent ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },
     { id: 'b2', t: 'bay', x: 5, y: 5, w: 2, h: 2, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 6, 'E')]
  ));
  A.ok(plan.errors.some(e => e.code === 'DUP_AGENT' && e.agentId === 'coder'), 'two bays, one agent -> DUP_AGENT');
}

/* ---- UNBOUND_BAY is a warning, not a blocker ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b1', t: 'bay', x: 3, y: 0, w: 2, h: 2 }],
    [belt(1, 0, 'E'), belt(2, 0, 'E')]
  ));
  A.ok(plan.errors.some(e => e.code === 'UNBOUND_BAY' && e.warn), 'a bay with no agent -> UNBOUND_BAY (warn)');
  A.ok(P.ok(plan), 'a warning does not block deploy');
}

/* ---- FILTER content-routing: code->coder (E lane), research->researcher (S lane), default->coder ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'f1', t: 'filter', x: 2, y: 0, w: 1, h: 1, routes: { code: 'E', research: 'S' }, def: 'E' },
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },
     { id: 'br', t: 'bay', x: 1, y: 3, w: 2, h: 2, agentId: 'researcher' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),   // E lane -> coder bay (@4,0)
     belt(2, 1, 'S'), belt(2, 2, 'S')]                                      // S lane -> researcher bay (@2,2)
  ));
  A.eq(plan.errors.length, 0, 'a complete filter floor has no errors (default present, both bays reachable)');
  A.eq(plan.reach.coder, true, 'coder reachable via the E lane');
  A.eq(plan.reach.researcher, true, 'researcher reachable via the S lane');
  A.eq(P.resolveTarget(plan, { tag: 'code' }), 'coder', "a 'code' message routes to the coder bay");
  A.eq(P.resolveTarget(plan, { tag: 'research' }), 'researcher', "a 'research' message routes to the researcher bay");
  A.eq(P.resolveTarget(plan, { tag: 'misc' }), 'coder', 'an untagged message takes the default lane');
}

/* ---- FILTER never-drops: a route to a non-existent lane falls back to the default (visual == dispatch) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'f1', t: 'filter', x: 2, y: 0, w: 1, h: 1, routes: { code: 'N' }, def: 'E' },   // 'N' lane has no belt
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E')]
  ));
  A.eq(P.resolveTarget(plan, { tag: 'code' }), 'coder',
    'a filter route to a missing lane falls back to the default lane (resolveTarget mirrors the engine — work never dropped)');
}

/* ---- MERGER: bufferSize (K) threaded into the plan junction; a box still resolves through it ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'm1', t: 'merger', x: 2, y: 0, w: 1, h: 1, bufferSize: 3 },
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'a' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E')]
  ));
  const j = plan.junctions['2,0'];
  A.ok(j && j.kind === 'merge' && j.bufferSize === 3, 'a merger compiles to a merge junction carrying its bufferSize (K)');
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'a', 'a box still resolves through a merge to the downstream bay');
}

/* ---- FILTER_NO_DEFAULT ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'f1', t: 'filter', x: 1, y: 0, w: 1, h: 1, routes: { code: 'E' } }],   // no def
    [belt(1, 0, 'E'), belt(2, 0, 'E')]
  ));
  A.ok(plan.errors.some(e => e.code === 'FILTER_NO_DEFAULT'), 'a filter with no default lane -> FILTER_NO_DEFAULT');
}

/* ---- resolveTarget null fallback + replay-stable hash ---- */
{
  A.eq(P.resolveTarget({ sources: [] }, { tag: 'x' }), null, 'no source -> resolveTarget null (caller falls back, never stalls)');
  const mk = () => geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b1', t: 'bay', x: 4, y: 0, w: 2, h: 2, agentId: 'a' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E')]
  );
  A.eq(P.compileRoutingPlan(mk()).hash, P.compileRoutingPlan(mk()).hash, 'two identical floors -> identical plan.hash');
  const other = geo([{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }], [belt(1, 0, 'E')]);
  A.ok(P.compileRoutingPlan(mk()).hash !== P.compileRoutingPlan(other).hash, 'a different floor -> a different hash');
}

/* ---- SPLITTER lane pick: resolveTarget round-robins split lanes via the pick callback (else first lane) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },       // E lane
     { id: 'br', t: 'bay', x: 1, y: 4, w: 2, h: 2, agentId: 'researcher' }], // S lane
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),
     belt(2, 1, 'S'), belt(2, 2, 'S'), belt(2, 3, 'S')]
  ));
  A.eq(plan.errors.length, 0, 'a splitter feeding two distinct bound bays is valid');
  A.eq(P.resolveTarget(plan, {}), P.resolveTarget(plan, {}), 'no pick -> the first lane every time (replay-stable read)');
  const rr = {}, pick = (k, n) => { const c = rr[k] || 0; rr[k] = (c + 1) % n; return c; };
  const seq = [P.resolveTarget(plan, {}, pick), P.resolveTarget(plan, {}, pick), P.resolveTarget(plan, {}, pick), P.resolveTarget(plan, {}, pick)];
  A.eq(seq.join(','), 'coder,researcher,coder,researcher', 'a round-robin pick spreads dispatch across the splitter lanes (' + seq.join(',') + ')');
}

/* ---- liveTiles: only tiles on a COMPLETE source->bound-bay route are energized ---- */
{
  // E lane reaches the coder bay; S branch off the splitter dead-ends; (8,8) is disconnected scrap
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),
     belt(2, 1, 'S'), belt(2, 2, 'S'),      // the dead branch: forward-reachable, never reaches a bay
     belt(8, 8, 'E')]                       // disconnected scrap: not even forward-reachable
  ));
  const live = P.liveTiles(plan);
  A.ok(live['1,0'] && live['2,0'] && live['3,0'] && live['4,0'], 'every tile on the source->bay route is live');
  A.ok(!live['2,1'] && !live['2,2'], 'a branch that never reaches a bound bay stays cold');
  A.ok(!live['8,8'], 'a disconnected belt stays cold');
}

/* ---- liveTiles: no bound bay anywhere -> the whole line is cold (nothing can run) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b1', t: 'bay', x: 4, y: 0, w: 2, h: 2 }],   // bay UNBOUND
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E')]
  ));
  A.eq(Object.keys(P.liveTiles(plan)).length, 0, 'an unbound bay powers nothing — the whole line is cold');
  A.ok(plan.unboundBays.length === 1 && plan.unboundBays[0].tile.x === 3, 'the unbound bay hookup tile is recorded for the legibility layer');
}

/* ---- routeFrom: the hover answer — agent / unbound bay / dead end, from any belt tile ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },
     { id: 'bu', t: 'bay', x: 1, y: 3, w: 2, h: 2 }],                      // unbound bay on the S lane
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),
     belt(2, 1, 'S'), belt(2, 2, 'S')]
  ));
  const atSplit = P.routeFrom(plan, 1, 0);       // upstream of the splitter: both futures are possible
  A.eq(atSplit.agents.join(','), 'coder', 'upstream of the splitter the flow can reach the coder bay');
  A.eq(atSplit.unbound, 1, '...and can ride past one unbound bay hookup');
  A.ok(atSplit.deadEnd, '...and the unbound branch sinks (deadEnd flagged)');
  const eLane = P.routeFrom(plan, 3, 0);
  A.eq(eLane.agents.join(','), 'coder', 'on the E lane the flow reaches exactly the coder bay');
  A.ok(!eLane.deadEnd && eLane.unbound === 0, 'the E lane has no dead futures');
  const sLane = P.routeFrom(plan, 2, 2);
  A.eq(sLane.agents.length, 0, 'the S lane reaches no bound bay');
  A.eq(sLane.unbound, 1, 'the S lane passes the unbound bay hookup');
  const off = P.routeFrom(plan, 9, 9);
  A.ok(off.agents.length === 0 && !off.deadEnd, 'a non-belt tile answers empty (no false claims)');
}

/* ---- SPLIT_ONE_LANE: a splitter with <2 out-lanes fans nothing — warn (not a blocker) ---- */
{
  const one = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'a' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E')]   // single straight lane through the splitter
  ));
  A.ok(one.errors.some(e => e.code === 'SPLIT_ONE_LANE' && e.warn), 'a one-lane splitter -> SPLIT_ONE_LANE warning');
  A.ok(P.ok(one), 'the warning does not block deploy (the line still works, it just is not splitting)');
  const two = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'a' },
     { id: 'b2', t: 'bay', x: 1, y: 4, w: 2, h: 2, agentId: 'b' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(2, 1, 'S'), belt(2, 2, 'S'), belt(2, 3, 'S')]
  ));
  A.ok(!two.errors.some(e => e.code === 'SPLIT_ONE_LANE'), 'a splitter with two real out-lanes does not warn');
}

/* ---- junctionLaneOwners: each junction lane knows which bay owners it can reach (addressed crates ride home) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'f', t: 'filter', x: 2, y: 0, w: 1, h: 1, routes: { code: 'S' }, def: 'E' },
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'nova' },
     { id: 'br', t: 'bay', x: 1, y: 3, w: 2, h: 2, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),
     belt(2, 1, 'S'), belt(2, 2, 'S')]
  ));
  const own = P.junctionLaneOwners(plan);
  A.ok(own['2,0'], 'the filter tile carries lane owners');
  A.eq((own['2,0'].E || []).join(','), 'nova', 'E lane reaches nova');
  A.eq((own['2,0'].S || []).join(','), 'coder', 'S lane reaches coder');
  A.eq(P.junctionLaneOwners({ belts: {} })['x'], undefined, 'empty plan -> no owners (never throws)');
}

/* ---- MULTI-NETWORK LAW (the two-room bug): sourceFor picks the INBOX that reaches the agent; resolveTarget
        walks EVERY source and honors an explicit binding with a dock ---- */
{
  // room 1: intakeA -> bayA ('over')     room 2 (disjoint): intakeB -> bayB ('nova')
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'iA', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'bA', t: 'bay', x: 4, y: 0, w: 2, h: 2, agentId: 'over' },
     { id: 'iB', t: 'intake', x: 0, y: 10, w: 1, h: 1 },
     { id: 'bB', t: 'bay', x: 4, y: 10, w: 2, h: 2, agentId: 'nova' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'),
     belt(1, 10, 'E'), belt(2, 10, 'E'), belt(3, 10, 'E')]
  ));
  A.eq(P.sourceFor(plan, 'over'), { x: 1, y: 0 }, "sourceFor('over') = room 1's INBOX hookup");
  A.eq(P.sourceFor(plan, 'nova'), { x: 1, y: 10 }, "sourceFor('nova') = room 2's INBOX hookup — never room 1's line");
  A.eq(P.sourceFor(plan, 'ghost'), null, 'no line reaches an unknown agent -> null (caller lands it at the dock)');
  A.eq(P.sourceFor(plan, null), null, 'unaddressed -> null (caller keeps first-INBOX behavior)');
  A.eq(P.resolveTarget(plan, { boundAgentId: 'nova' }), 'nova', 'an ADDRESSED message resolves to its addressee, not the first network');
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'over', 'unaddressed work still takes the first network (deterministic default)');
  A.eq(P.resolveTarget(plan, { boundAgentId: 'ghost' }), 'over', 'a binding with NO dock on the floor falls through to the walk (work never stalls)');
}

/* ---- sourceFor rides THROUGH a foreign dock (addressed physics): one line, two bays in series ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 2, y: 1, w: 1, h: 1, agentId: 'first' },    // hooked at (2,0) on the line
     { id: 'b2', t: 'bay', x: 6, y: 0, w: 2, h: 2, agentId: 'second' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E')]
  ));
  A.eq(P.sourceFor(plan, 'second'), { x: 1, y: 0 }, "an addressed item reaches 'second' RIDING THROUGH 'first's dock hookup");
}

/* ---- resolveTarget: a SECOND source feeding the only bay is found (sources[0] alone was the old blind spot) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'iA', t: 'intake', x: 0, y: 0, w: 1, h: 1 },      // source A: dead-ends, no bay
     { id: 'iB', t: 'intake', x: 0, y: 5, w: 1, h: 1 },
     { id: 'b', t: 'bay', x: 4, y: 5, w: 2, h: 2, agentId: 'solo' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'),
     belt(1, 5, 'E'), belt(2, 5, 'E'), belt(3, 5, 'E')]
  ));
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'solo', "source A sinks -> the walk continues to source B's network (was null)");
}

A.report('pipeline');
