/* test/blueprints.test.js — STARTER-LINE blueprints (the beginner onramp, 2026-08-04).

   The contract under lock:
     1. Every blueprint stamps whole (machines + belts) as ONE undoable action — a single undo
        removes the entire line, a single redo restores it.
     2. A fresh stamp compiles to UNBOUND_BAY warns ONLY — no blockers, no BELT_BURIED, no
        ORPHAN_* / BAY_NOT_FED / FILTER_NO_DEFAULT / SPLIT_ONE_LANE surprises. The amber
        "NO AGENT — CLICK" nag is the built-in next step, and nothing else nags.
     3. With every bay bound, the plan is fully clean (zero errors), deployable (Pipeline.ok),
        and COMPLETE where the blueprint has an intake: reach[agent] true, liveTiles energized —
        the exact condition REFIT's auto-narrated first ride keys on.
     4. Placement is all-or-nothing on clear deck: off-deck, over a prop, or over an existing
        belt all refuse without half-stamping. */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');

A.ok(Array.isArray(WM.BLUEPRINTS) && WM.BLUEPRINTS.length === 4, 'exactly four starter-line blueprints ship');
const IDS = WM.BLUEPRINTS.map(b => b.id);
for (const want of ['research_line', 'sorting_office', 'parallel_crew', 'ship_out'])
  A.ok(IDS.indexOf(want) >= 0, 'blueprint catalog carries ' + want);

// a fresh station with one big empty deck to stamp on (beside the seed room)
function freshFloor() {
  const s = WM.create();
  const r = s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 59, y2: 14 } });
  A.ok(r.ok, 'test deck placed');
  return s;
}
const AT = { x: 32, y: 2 };   // stamp origin — fully inside the test deck for every blueprint (max 17×8)

for (const bp of WM.BLUEPRINTS) {
  const s = freshFloor();
  const propsBefore = s.props().length, beltsBefore = s.belts().length;

  /* ---- validation is a read: a red ghost mutates nothing ---- */
  const off = s.canPlaceBlueprint(bp.id, 500, 500);
  A.ok(!off.ok && off.error === 'OFF_DECK', bp.id + ': off-deck placement refused (' + off.error + ')');
  A.eq(s.props().length, propsBefore, bp.id + ': refused validation did not mutate');

  /* ---- the stamp: one call, whole line ---- */
  const v = s.canPlaceBlueprint(bp.id, AT.x, AT.y);
  A.ok(v.ok, bp.id + ': clear-deck placement validates');
  const res = s.stampBlueprint(bp.id, AT.x, AT.y);
  A.ok(res.ok, bp.id + ': stamps');
  A.eq(s.props().length, propsBefore + bp.props.length, bp.id + ': every machine landed');
  A.eq(s.belts().length, beltsBefore + bp.belts.length, bp.id + ': every belt tile landed');

  /* ---- bays stamp UNBOUND; the filter stamps configured ---- */
  const bays = s.props().filter(p => p.t === 'bay');
  A.ok(bays.every(p => !p.agentId), bp.id + ': bays stamp unbound (the amber nag is the next step)');
  for (const f of s.props().filter(p => p.t === 'filter')) {
    A.ok(f.def, bp.id + ': stamped filter carries a default lane (never introduces FILTER_NO_DEFAULT)');
    A.ok(f.routes && Object.keys(f.routes).length, bp.id + ': stamped filter carries content routes');
  }

  /* ---- freshly stamped: the compiled plan is amber-only, and only UNBOUND_BAY ---- */
  let plan = P.compileRoutingPlan(s.projectGeometry());
  A.ok(P.ok(plan), bp.id + ': fresh stamp is deployable (no blocking errors)');
  const codes = plan.errors.map(e => e.code).sort();
  A.ok(plan.errors.every(e => e.warn && e.code === 'UNBOUND_BAY'),
    bp.id + ': fresh-stamp errors are UNBOUND_BAY warns only (got: ' + (codes.join(',') || 'none') + ')');
  A.eq(plan.errors.length, bays.length, bp.id + ': one UNBOUND_BAY warn per stamped bay');

  /* ---- bind every bay -> plan is fully clean + complete ---- */
  bays.forEach((b, i) => A.ok(s.assignPropAgent(b.id, 'crew' + i).ok, bp.id + ': bay ' + i + ' binds'));
  plan = P.compileRoutingPlan(s.projectGeometry());
  A.eq(plan.errors.length, 0, bp.id + ': bound plan has ZERO errors (got: '
    + plan.errors.map(e => e.code).join(',') + ')');
  A.ok(P.ok(plan), bp.id + ': bound plan deployable');
  const live = P.liveTiles(plan);
  A.ok(Object.keys(live).length > 0, bp.id + ': bound line energizes (liveTiles non-empty)');
  if (bp.props.some(p => p.t === 'intake')) {
    // the auto-first-ride condition: an intake lane actually REACHES a bound bay
    A.ok(Object.keys(plan.reach).some(a => plan.reach[a]), bp.id + ': intake line reaches a bound bay (reach true)');
  }

  /* ---- ONE undo slot: a single undo removes the whole line, a single redo restores it ---- */
  const boundProps = s.props().length, boundBelts = s.belts().length;
  const undosForBinds = bays.length;   // each bind burns one slot; the stamp itself burns exactly one more
  for (let i = 0; i < undosForBinds; i++) A.ok(s.undo().ok, bp.id + ': undo bind ' + i);
  A.ok(s.undo().ok, bp.id + ': undo the stamp');
  A.eq(s.props().length, propsBefore, bp.id + ': ONE undo removed every stamped machine');
  A.eq(s.belts().length, beltsBefore, bp.id + ': ONE undo removed every stamped belt');
  A.ok(s.redo().ok, bp.id + ': redo restores the stamp');
  A.eq(s.props().length, propsBefore + bp.props.length, bp.id + ': redo restored every machine');
  A.eq(s.belts().length, beltsBefore + bp.belts.length, bp.id + ': redo restored every belt');
  // restore binds so the doc round-trip below sees the full state
  for (let i = 0; i < undosForBinds; i++) s.redo();
  A.eq(s.props().length, boundProps, bp.id + ': redo chain restores the bound floor');
  A.eq(s.belts().length, boundBelts, bp.id + ': redo chain restores the belts');

  /* ---- clear-deck law: a second stamp over the first refuses whole ---- */
  const again = s.stampBlueprint(bp.id, AT.x, AT.y);
  A.ok(!again.ok, bp.id + ': stamping over the existing line refuses');
  A.eq(s.props().length, boundProps, bp.id + ': refused stamp added no props');
  A.eq(s.belts().length, boundBelts, bp.id + ': refused stamp added no belts');

  /* ---- persistence: the stamped line survives serialize/deserialize ---- */
  const back = WM.deserialize(s.serialize());
  A.eq(back.props().length, boundProps, bp.id + ': machines survive the save round-trip');
  A.eq(back.belts().length, boundBelts, bp.id + ': belts survive the save round-trip');
  const f2 = back.props().find(p => p.t === 'filter');
  if (f2) A.ok(f2.def && f2.routes, bp.id + ': filter config survives the save round-trip');
}

/* ---- a belt already on the deck blocks the stamp (never bury or overwrite a laid lane) ---- */
{
  const s = freshFloor();
  A.ok(s.setBelt(33, 3, 'E').ok, 'pre-existing belt laid');
  const v = s.canPlaceBlueprint('research_line', AT.x, AT.y);
  A.ok(!v.ok && v.error === 'ON_BELT', 'a stamp over an existing belt refuses with ON_BELT (got ' + v.error + ')');
}

/* ---- a blocking prop in the footprint blocks the stamp ---- */
{
  const s = freshFloor();
  A.ok(s.addProp({ t: 'crate', x: 34, y: 3, w: 1, h: 1, block: true }).ok, 'obstacle placed');
  const v = s.canPlaceBlueprint('research_line', AT.x, AT.y);
  A.ok(!v.ok, 'a stamp over a blocking prop refuses (' + v.error + ')');
}

A.report('blueprints');
