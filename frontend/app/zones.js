/* SKYNET — zones.js : the IDLE-CONTAINMENT primitive (P0, pure + headless-testable).

   A "zone" is the area an agent is allowed to ROAM inside while idle. It is DERIVED on the
   fly from geometry the world already holds (room rects + props) — never persisted, never on
   the bus (so shared/events.js + shared/schema.js are untouched). world.js will call these to
   filter every idle target picker to the agent's own area; this module owns ALL the geometry
   math so it can be unit-tested with plain node asserts (test/zones.test.js), exactly like
   xp.js / ctxgauge.js.

   The shape of a zone (a tiny tagged union):
     • { kind:'room', rect:{x1,y1,x2,y2} } — the agent's bay/workstation sits inside an
       enclosing room rect; roam that rect. A SOLO agent whose room spans the whole station
       yields a large rect, so its rich station-wide behavior is NOT regressed (invariant I2/A3).
     • { kind:'leash', cx,cy,r }           — no enclosing room found around the anchor; roam a
       bounded leash radius (Chebyshev) around the workstation/bay foot tile.
     • { kind:'multi', rects:[...] }        — SOLE-OWNERSHIP widening (invariant A3/I2): when one
       agent effectively owns the whole space (no other bound bay/crew), its zone is the UNION of
       EVERY room rect — i.e. the whole reachable floor, exactly the set the pre-change idle
       pickers drew from (geo.allRects). This is what keeps the solo hero's rich, station-wide
       behavior un-regressed even in a multi-room built-out station (its desk room is NOT the whole
       station, so a single 'room' zone would wrongly cage it).
     • null                                — unassigned / unplaced: NO zone, the agent does not
       roam (it stays put; callers treat null as "no in-zone candidate").

   PURITY CONTRACT: no DOM, no globals, no world state, no RNG, no clock. All inputs are passed
   in. All rect coords are LOCAL-frame inclusive (x1<=x<=x2, y1<=y<=y2), matching geo.allRects /
   geo.zones from worldmodel.js. Math.floor/abs/min/max (pure arithmetic) are fine; the caller
   owns any U.irnd/U.chance sampling so determinism (invariant I3) lives in world.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Zones = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_LEASH = 5;   // Chebyshev tiles around the anchor when there is no enclosing room

  // ---- small geometry helpers (LOCAL-frame, inclusive rects) ----
  function isRect(r) {
    return !!r && Number.isFinite(r.x1) && Number.isFinite(r.y1) &&
                  Number.isFinite(r.x2) && Number.isFinite(r.y2);
  }
  // inclusive contains-test; tolerant of rects given either corner order
  function rectHas(r, x, y) {
    if (!isRect(r)) return false;
    const lx = Math.min(r.x1, r.x2), hx = Math.max(r.x1, r.x2);
    const ly = Math.min(r.y1, r.y2), hy = Math.max(r.y1, r.y2);
    return x >= lx && x <= hx && y >= ly && y <= hy;
  }
  function rectArea(r) {
    if (!isRect(r)) return 0;
    return (Math.abs(r.x2 - r.x1) + 1) * (Math.abs(r.y2 - r.y1) + 1);
  }
  // normalize to a clean inclusive rect (x1<=x2, y1<=y2), copied so we never alias geo's arrays
  function normRect(r) {
    return {
      x1: Math.min(r.x1, r.x2), y1: Math.min(r.y1, r.y2),
      x2: Math.max(r.x1, r.x2), y2: Math.max(r.y1, r.y2),
    };
  }

  // ---- find the agent's anchor tile from its props (its bay/workstation foot) ----
  // Looks for a prop bound to this agent (p.agentId === agentId). Prefers a bay, then any bound
  // prop. Returns {x,y} of its top-left-ish tile, or null. (Caller usually passes anchorTile
  // explicitly — this is the fallback when only props are available.)
  function anchorFromProps(props, agentId) {
    if (!Array.isArray(props) || agentId == null) return null;
    let bay = null, any = null;
    for (const p of props) {
      if (!p || p.agentId !== agentId) continue;
      if (!any) any = p;
      if (p.t === 'bay') { bay = p; break; }
    }
    const p = bay || any;
    if (!p) return null;
    const x = Number.isFinite(p.x) ? Math.floor(p.x) : null;
    const y = Number.isFinite(p.y) ? Math.floor(p.y) : null;
    if (x == null || y == null) return null;
    return { x, y };
  }

  // ---- the smallest enclosing room rect for a tile ----
  // Among rects that contain (tx,ty), return the SMALLEST by area (tightest room). Multi-rect
  // L-shaped rooms appear as several allRects sharing a z; the tightest containing rect is the
  // legible "this room" target. Returns a normalized COPY or null. Determinism: ties broken by
  // earliest array index (stable iteration order — invariant I3), never by RNG.
  function smallestEnclosing(rects, tx, ty) {
    if (!Array.isArray(rects)) return null;
    let best = null, bestArea = Infinity;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (!isRect(r)) continue;
      if (!rectHas(r, tx, ty)) continue;
      const a = rectArea(r);
      if (a < bestArea) { best = r; bestArea = a; }   // strict < keeps the first of equal-area ties
    }
    return best ? normRect(best) : null;
  }

  // ---- the main resolver ----
  // computeZone({ rects, props, agentId, anchorTile, leashR, solo }) -> zone | null
  //   rects      : Array<{x1,y1,x2,y2,...}> LOCAL inclusive room rects (geo.allRects)
  //   props      : Array<{agentId,t,x,y,...}> LOCAL props (geo.props) — used only to locate the
  //                anchor when anchorTile is not supplied
  //   agentId    : the agent's id (to match bound props); may be null/undefined
  //   anchorTile : {x,y} the agent's bay/workstation foot tile (preferred input)
  //   leashR     : Chebyshev radius for the open-floor fallback (default DEFAULT_LEASH)
  //   solo       : when truthy, this agent effectively OWNS the whole space (no other bound
  //                bay/crew). Per A3/I2 its zone widens to the UNION of all room rects (the whole
  //                reachable floor) so its rich station-wide behavior is never caged — even in a
  //                multi-room station where its desk room is only one of several. (Applies only
  //                when there IS an anchor — an unplaced agent still gets no zone.)
  //
  // Resolution order (matches the plan A2/A3):
  //   1. resolve an anchor tile (explicit anchorTile, else from a bound prop)
  //   2. no anchor at all -> unassigned/unplaced -> null (does not roam)
  //   3. SOLE OWNERSHIP (solo) with >=1 room rect -> { kind:'multi', rects:[...] } (whole floor)
  //   4. anchor inside an enclosing room rect -> { kind:'room', rect }
  //   5. anchor on open floor (no enclosing rect) -> { kind:'leash', cx,cy,r }
  function computeZone(opts) {
    opts = opts || {};
    const rects = opts.rects;
    const r = Number.isFinite(opts.leashR) && opts.leashR > 0 ? Math.floor(opts.leashR) : DEFAULT_LEASH;

    // 1) anchor tile
    let a = null;
    if (opts.anchorTile && Number.isFinite(opts.anchorTile.x) && Number.isFinite(opts.anchorTile.y)) {
      a = { x: Math.floor(opts.anchorTile.x), y: Math.floor(opts.anchorTile.y) };
    } else {
      a = anchorFromProps(opts.props, opts.agentId);
    }
    // 2) unassigned / unplaced -> no zone
    if (!a) return null;

    // 3) sole-ownership widening: the whole reachable floor (union of every room rect). This is the
    // exact target set the pre-change idle pickers drew from (geo.allRects), so a SOLO agent keeps
    // every previously-valid cross-room target — invariant I2/A3 held for the realistic solo case
    // (a built-out solo station where the desk room != the whole station).
    const multi = soloMulti(rects, opts.solo);
    if (multi) return multi;

    // 4) enclosing room
    const room = smallestEnclosing(rects, a.x, a.y);
    if (room) return { kind: 'room', rect: room };

    // 5) open-floor leash around the anchor
    return { kind: 'leash', cx: a.x, cy: a.y, r };
  }

  // Build the sole-ownership 'multi' zone: a normalized COPY of every valid room rect (never an
  // alias of geo's arrays). Returns null when not solo or there is no rect to span (then the caller
  // falls back to room/leash). Iteration order is the stable geo.allRects order — no RNG (I3).
  function soloMulti(rects, solo) {
    if (!solo || !Array.isArray(rects)) return null;
    const out = [];
    for (let i = 0; i < rects.length; i++) {
      if (isRect(rects[i])) out.push(normRect(rects[i]));
    }
    return out.length ? { kind: 'multi', rects: out } : null;
  }

  // ---- membership test ----
  // inZone(null, ..) -> false (an agent with no zone roams nowhere). For a room zone: inclusive
  // rect contains. For a leash zone: Chebyshev (square) radius around the center.
  function inZone(zone, tx, ty) {
    if (!zone) return false;
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return false;
    if (zone.kind === 'room') return rectHas(zone.rect, tx, ty);
    if (zone.kind === 'leash') {
      return Math.abs(tx - zone.cx) <= zone.r && Math.abs(ty - zone.cy) <= zone.r;
    }
    if (zone.kind === 'multi') {                       // sole-ownership: in ANY room rect (whole floor)
      if (!Array.isArray(zone.rects)) return false;
      for (let i = 0; i < zone.rects.length; i++) if (rectHas(zone.rects[i], tx, ty)) return true;
      return false;
    }
    return false;
  }

  // ---- filter a candidate list to the zone ----
  // clampPickable(zone, candidates, keyFn) -> the subset whose tile is inZone, in ORIGINAL order
  // (so a caller's deterministic U.irnd/U.pick over the result stays deterministic — invariant
  // I3). keyFn(candidate) -> {x,y}; defaults to identity (candidate already {x,y}). A null zone
  // yields [] (nothing pickable -> caller falls through to an in-place beat).
  function clampPickable(zone, candidates, keyFn) {
    if (!zone || !Array.isArray(candidates)) return [];
    const key = typeof keyFn === 'function' ? keyFn : (c => c);
    const out = [];
    for (const c of candidates) {
      const t = key(c);
      if (t && inZone(zone, t.x, t.y)) out.push(c);
    }
    return out;
  }

  return {
    computeZone, inZone, clampPickable,
    // exposed for tests / reuse — pure geometry helpers
    rectHas, rectArea, smallestEnclosing, anchorFromProps,
    DEFAULT_LEASH,
  };
});
