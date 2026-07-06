/* frontend/app/pipeline.js — the belt-graph -> RoutingPlan compiler. Phase B's single authority.

   Pure, zero-dep, UMD: node tests + the browser sim + the sidecar router all require() the SAME module,
   so "the box you watch ride to a bay" and "the agent that actually runs" are provably one plan — they
   cannot drift. This is to ROUTING what resolveTools(agentId, station) is to CAPABILITY.

   compileRoutingPlan(geo)  -> a validated { sources, bays, junctions, belts, bayTileToAgent, reach, errors, hash }
   resolveTarget(plan,{tag}) -> the agentId a work-item routes to (following FILTER content-routing), or null.

   DETERMINISM: no Math.random, no wall-clock, no mutation of inputs. A belt CYCLE is a HARD error (a loop
   would be infinite paid runOnce). The plan is plain JSON (no Maps) so the sidecar can hold the same one. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.Pipeline = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DIRV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
  const OPP = { E: 'W', W: 'E', S: 'N', N: 'S' };
  const LANE_ORDER = ['E', 'S', 'W', 'N'];          // fixed order so routing is deterministic (mirrors conveyor.js)
  const key = (x, y) => x + ',' + y;

  const buildBeltMap = belts => { const m = {}; for (const b of (belts || [])) m[key(b.x, b.y)] = b.dir; return m; };
  // a junction's out-lanes: neighbour belts that DON'T flow back into the tile (the lane it came from)
  function outLanes(map, x, y) {
    const lanes = [];
    for (const d of LANE_ORDER) { const v = DIRV[d], nb = map[key(x + v[0], y + v[1])]; if (nb && nb !== OPP[d]) lanes.push(d); }
    return lanes;
  }
  // the first belt tile on/adjacent to a footprint (its tiles + a 1-tile ring) — a prop's connection point
  function beltTileNear(map, tx, ty, tw, th) {
    for (let yy = ty - 1; yy <= ty + th; yy++)
      for (let xx = tx - 1; xx <= tx + tw; xx++)
        if (map[key(xx, yy)]) return { x: xx, y: yy };
    return null;
  }
  // small deterministic FNV-1a hash of the plan topology (frontend<->sidecar agree they hold the same plan)
  function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }

  // the tile(s) a box flows to next from t (a junction fans out to ALL its out-lanes for reachability/cycle)
  function nextTiles(map, junctions, t) {
    if (!map[key(t.x, t.y)]) return [];
    const dirs = junctions[key(t.x, t.y)] ? outLanes(map, t.x, t.y) : [map[key(t.x, t.y)]];
    const out = [];
    for (const d of dirs) { const v = DIRV[d], nx = t.x + v[0], ny = t.y + v[1]; if (map[key(nx, ny)]) out.push({ x: nx, y: ny }); }
    return out;
  }

  // DFS along belt flow for a cycle (a back-edge to a GRAY node). Returns the offending tile, or null.
  function detectCycle(map, junctions) {
    const color = {};   // undefined=white, 1=gray (on stack), 2=black (done)
    function visit(k) {
      color[k] = 1;
      const p = k.split(','), t = { x: +p[0], y: +p[1] };
      for (const nt of nextTiles(map, junctions, t)) {
        const nk = key(nt.x, nt.y);
        if (color[nk] === 1) return { x: nt.x, y: nt.y };
        if (!color[nk]) { const c = visit(nk); if (c) return c; }
      }
      color[k] = 2; return null;
    }
    for (const k in map) if (!color[k]) { const c = visit(k); if (c) return c; }
    return null;
  }

  function compileRoutingPlan(geo) {
    const props = (geo && geo.props) || [];
    const map = buildBeltMap(geo && geo.belts);
    const errors = [], sources = [], bays = [], junctions = {}, bayTileToAgent = {};

    for (const p of props) {
      if (p.t === 'intake') {
        const t = beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1);
        if (!t) { errors.push({ code: 'ORPHAN_SOURCE', propId: p.id }); continue; }
        sources.push({ propId: p.id, tile: t });
      } else if (p.t === 'splitter' || p.t === 'filter' || p.t === 'merger') {
        const t = map[key(p.x, p.y)] ? { x: p.x, y: p.y } : beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1);
        if (!t) continue;   // a junction on no belt is inert
        const kind = p.t === 'splitter' ? 'split' : p.t === 'merger' ? 'merge' : 'filter';
        const cfg = { kind };
        if (kind === 'filter') {
          cfg.routes = (p.routes && typeof p.routes === 'object') ? p.routes : {};   // {tag -> out-lane dir}
          cfg.def = p.def || null;                                                    // default out-lane dir
          if (!cfg.def) errors.push({ code: 'FILTER_NO_DEFAULT', propId: p.id });
        }
        if (kind === 'merge') cfg.bufferSize = Math.max(2, p.bufferSize | 0 || 2);
        // a splitter with fewer than two out-lanes fans nothing — it silently acts as a plain tile. Warn
        // (not a blocker: the line still works, it just isn't doing what the prop claims) so the UI can nag.
        if (kind === 'split' && outLanes(map, t.x, t.y).length < 2) errors.push({ code: 'SPLIT_ONE_LANE', propId: p.id, warn: true });
        junctions[key(t.x, t.y)] = cfg;
      }
    }

    // OUTBOX hookups: the legal END of an outbound lane (bay/desk -> outbox). Legibility-only — dispatch
    // never routes THROUGH an outbox — but recording them lets a bay->outbox line count as a VALID build
    // instead of being shamed as unreachable (the 2026-07-05 "NO ROUTE IN on a correct outbound lane" bug).
    const outs = [];
    for (const p of props) {
      if (p.t !== 'outbox') continue;
      // EVERY ring belt tile is a delivery mouth (same multi-hookup rule as bays — a single-tile hookup
      // left the final approach tile of a second lane dark)
      const ow = p.w || 1, oh = p.h || 1;
      for (let yy = p.y - 1; yy <= p.y + oh; yy++)
        for (let xx = p.x - 1; xx <= p.x + ow; xx++)
          if (map[key(xx, yy)]) outs.push({ propId: p.id, tile: { x: xx, y: yy } });
    }

    const seenAgent = {}, unboundBays = [], dockBays = [];
    const hasLine = sources.length > 0;   // an INTAKE line exists — only then can "not fed by it" be a finding
    for (const p of props) {
      if (p.t !== 'bay') continue;
      if (!p.agentId) {
        errors.push({ code: 'UNBOUND_BAY', propId: p.id, warn: true });
        // an unbound bay is not a routing target, but the legibility layer (hover tags, nags) needs to know
        // a belt runs past it — record its connection tile additively (never enters bayTileToAgent/hash).
        const ut = beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1);
        if (ut) unboundBays.push({ propId: p.id, tile: ut });
        continue;
      }
      // EVERY bound bay is a working dock (legibility list; NOT the dispatch `bays` — router semantics untouched).
      // A LONE assigned bay is a COMPLETE build: work addressed to its agent arrives at the dock, no belts needed.
      dockBays.push({ propId: p.id, agentId: p.agentId, x: p.x, y: p.y, w: p.w || 1, h: p.h || 1 });
      const t = beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1);
      if (!t) {
        // beltless bound bay: valid alone; merely "not on the line" (warn) when an intake line exists elsewhere
        if (hasLine) errors.push({ code: 'ORPHAN_BAY', propId: p.id, agentId: p.agentId, warn: true });
        continue;
      }
      if (seenAgent[p.agentId]) { errors.push({ code: 'DUP_AGENT', propId: p.id, agentId: p.agentId }); continue; }
      seenAgent[p.agentId] = true;
      // A DOCK TOUCHES THE LINE WHEREVER THE LINE TOUCHES IT: record EVERY ring belt tile as a hookup —
      // an inbound lane arrives at one, an outbound lane leaves from another, and both must count (a
      // single-tile hookup left a bay's out-lane dark and spawned its product crates on the in-lane).
      const tiles = [];
      const bw = p.w || 1, bh = p.h || 1;
      for (let yy = p.y - 1; yy <= p.y + bh; yy++)
        for (let xx = p.x - 1; xx <= p.x + bw; xx++)
          if (map[key(xx, yy)]) tiles.push({ x: xx, y: yy });
      bays.push({ agentId: p.agentId, propId: p.id, tile: t, tiles });
      for (const ht of tiles) bayTileToAgent[key(ht.x, ht.y)] = p.agentId;
    }

    const cyc = detectCycle(map, junctions);
    if (cyc) errors.push({ code: 'CYCLE', tile: cyc });

    // reachability: BFS from every source along the flow; a bay CONSUMES the box (don't expand past it)
    const reach = {};
    for (const b of bays) reach[b.agentId] = false;
    if (!cyc) {
      const seen = {}, q = [];
      for (const s of sources) { const sk = key(s.tile.x, s.tile.y); if (!seen[sk]) { seen[sk] = true; q.push(s.tile); } }
      while (q.length) {
        const t = q.shift(), k = key(t.x, t.y);
        if (bayTileToAgent[k]) { reach[bayTileToAgent[k]] = true; continue; }
        for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
      }
    }
    // outbound reach: does this hooked bay's flow arrive at an OUTBOX? (a pure outbound lane is a VALID build)
    const outSet = {};
    for (const o of outs) outSet[key(o.tile.x, o.tile.y)] = true;
    function flowsToOutbox(from) {
      if (cyc) return false;
      const seen = {}, q = [from]; seen[key(from.x, from.y)] = true;
      while (q.length) {
        const t = q.shift(), k = key(t.x, t.y);
        if (outSet[k]) return true;
        for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
      }
      return false;
    }
    // a HOOKED bay whose belt serves NEITHER direction (no intake feeds it, no outbox receives from it)
    // is a belt to nowhere — a warning, never a blocker (dispatch can't route to it anyway: resolveTarget
    // only walks from sources). This replaces the old blocking DEAD_BAY, which condemned valid outbound lanes.
    for (const b of bays) if (!reach[b.agentId] && !flowsToOutbox(b.tile)) errors.push({ code: 'BAY_NOT_FED', propId: b.propId, agentId: b.agentId, warn: true });

    const plan = { sources, bays, junctions, belts: map, bayTileToAgent, unboundBays, dockBays, outs, reach, errors };
    plan.hash = hashStr(JSON.stringify({ sources, bays, junctions, belts: map }));   // hash excludes the legibility extras: same dispatch topology, same hash
    return plan;
  }

  /* ---------- legibility layer: pure readouts of the compiled plan (no routing behavior) ----------
     liveTiles(plan) -> { "x,y": true } for every belt tile on a COMPLETE route, in EITHER direction:
       • inbound  — reachable forward from an INTAKE source AND flowing onward into a bound bay;
       • outbound — reachable forward from a bound bay's hookup AND flowing onward into an OUTBOX.
     The renderer draws these tiles energized and the rest cold, so "the line powers on" is literally the
     compiled plan — truthful telemetry by construction. A bay->outbox ship-out lane glows exactly like an
     intake->bay feed lane: both genuinely carry real crates. */
  function liveTiles(plan) {
    const out = {};
    if (!plan || !plan.belts) return out;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    // shared reverse adjacency (tileKey -> upstream tileKeys), built once for both direction passes
    const rev = {};
    for (const k in map) {
      const p = k.split(','), t = { x: +p[0], y: +p[1] };
      for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); (rev[nk] = rev[nk] || []).push(k); }
    }
    // forward flood from `starts`, intersected with a reverse flood from `ends` — the tiles on a complete route
    function segment(starts, stopAtBay, ends) {
      const fwd = {}, q = [];
      for (const s of starts) { const k = key(s.x, s.y); if (map[k] && !fwd[k]) { fwd[k] = true; q.push(s); } }
      while (q.length) {
        const t = q.shift();
        if (stopAtBay && bayAt[key(t.x, t.y)]) continue;   // a bound bay consumes inbound boxes
        for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!fwd[nk]) { fwd[nk] = true; q.push(nt); } }
      }
      const bwd = {}, q2 = [];
      for (const e of ends) { const k = key(e.x, e.y); if (map[k] && !bwd[k]) { bwd[k] = true; q2.push(k); } }
      while (q2.length) {
        const k = q2.shift();
        for (const uk of (rev[k] || [])) if (!bwd[uk]) { bwd[uk] = true; q2.push(uk); }
      }
      for (const k in fwd) if (bwd[k]) out[k] = true;
    }
    // inbound: intake sources -> bound-bay hookups
    const bayTiles = [];
    for (const k in bayAt) { const p = k.split(','); bayTiles.push({ x: +p[0], y: +p[1] }); }
    if (plan.sources && plan.sources.length && bayTiles.length) segment(plan.sources.map(s => s.tile), true, bayTiles);
    // outbound: bound-bay hookups -> outbox hookups
    const outTiles = (plan.outs || []).map(o => o.tile);
    if (bayTiles.length && outTiles.length) segment(bayTiles, false, outTiles);
    return out;
  }

  /* routeFrom(plan, x, y) -> where does the flow from THIS belt tile end up?
     { agents: [agentId...], unbound: n, outbox: bool, deadEnd: bool } — agents sorted (deterministic),
     unbound counts distinct unassigned-bay hookups passed, outbox true when the flow reaches an OUTBOX
     hookup (a ship-out lane), deadEnd true if any branch sinks with none of the above. Fans out ALL
     junction lanes (a hover tag answers "where CAN this go", not one dispatch decision). */
  function routeFrom(plan, x, y) {
    const res = { agents: [], unbound: 0, outbox: false, deadEnd: false };
    if (!plan || !plan.belts || !plan.belts[key(x, y)]) return res;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    const unboundAt = {}, outAt = {};
    for (const u of (plan.unboundBays || [])) unboundAt[key(u.tile.x, u.tile.y)] = u.propId;
    for (const o of (plan.outs || [])) outAt[key(o.tile.x, o.tile.y)] = true;
    const agents = {}, unboundSeen = {}, seen = {}, q = [{ x, y }];
    seen[key(x, y)] = true;
    while (q.length) {
      const t = q.shift(), k = key(t.x, t.y);
      if (bayAt[k]) { agents[bayAt[k]] = true; continue; }   // a bound bay consumes the box
      if (unboundAt[k]) unboundSeen[unboundAt[k]] = true;     // riding past a dead hookup — note it, flow continues
      if (outAt[k]) res.outbox = true;                        // this lane ships out (flow may continue past)
      const nts = nextTiles(map, junctions, t);
      if (!nts.length) { if (!outAt[k]) res.deadEnd = true; continue; }   // an open end AT the outbox is a delivery, not a dead end
      for (const nt of nts) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
    }
    res.agents = Object.keys(agents).sort();
    res.unbound = Object.keys(unboundSeen).length;
    return res;
  }

  // which agentId does a work-item with this tag route to? Follows belt flow from the (first) source, applying
  // FILTER content-routing by tag, until it reaches a bound bay. null = no bay on the route.
  // `pick(tileKey, laneCount) -> index` chooses the lane at a SPLIT/MERGE junction (FILTER is deterministic by
  // tag and ignores it). Omitted -> lane 0 (a pure, replay-stable read). The sidecar router passes a stateful
  /* junctionLaneOwners(plan) -> { junctionTileKey: { dir: [agentIds…] } } — for each junction out-lane,
     every bound-bay owner that lane can reach (fanning through downstream junctions; a bound bay consumes,
     so the walk never fans past one). The conveyor engine reads this so an ADDRESSED crate (payload.agentId
     — a cron, a bound chat) takes the lane that leads HOME instead of obeying content/balance routing:
     filters and splitters only ever decide for unowned work. Pure, deterministic, sorted output. */
  function junctionLaneOwners(plan) {
    const out = {};
    if (!plan || !plan.belts) return out;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    function ownersFrom(start) {
      const seen = {}, q = [start], found = {};
      seen[key(start.x, start.y)] = true;
      while (q.length) {
        const t = q.shift(), k = key(t.x, t.y);
        if (bayAt[k]) { found[bayAt[k]] = true; continue; }
        for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
      }
      return found;
    }
    for (const jk in junctions) {
      const p = jk.split(','), x = +p[0], y = +p[1];
      const rec = {};
      for (const d of outLanes(map, x, y)) {
        const v = DIRV[d], nt = { x: x + v[0], y: y + v[1] };
        if (!map[key(nt.x, nt.y)]) continue;
        const ids = Object.keys(ownersFrom(nt)).sort();
        if (ids.length) rec[d] = ids;
      }
      if (Object.keys(rec).length) out[jk] = rec;
    }
    return out;
  }

  // round-robin picker so autonomous dispatch genuinely SPREADS splitter work across agents, matching the
  // engine's load-balance intent instead of always running the first lane.
  function resolveTarget(plan, ctx, pick) {
    if (!plan || !plan.sources || !plan.sources.length) return null;
    const tag = (ctx && ctx.tag) || 'general';
    const map = plan.belts, junctions = plan.junctions, bayAt = plan.bayTileToAgent;
    let t = plan.sources[0].tile, guard = 0; const seen = {};
    while (t && guard++ < 4096) {
      const k = key(t.x, t.y);
      if (bayAt[k]) return bayAt[k];                 // arrived at a bound bay
      if (seen[k]) return null;                      // loop guard (a CYCLE is already a compile error)
      seen[k] = true;
      const here = map[k]; if (!here) return null;   // sank with no bay
      const j = junctions[k];
      let d = here;
      if (j && j.kind === 'filter') {
        // mirror conveyor.chooseExit EXACTLY: routed lane -> default lane -> first lane (never an invalid dir),
        // so the agent the sidecar resolves is provably the bay the box physically rides to.
        const lanes = outLanes(map, t.x, t.y);
        const want = j.routes && j.routes[tag];
        d = (want && lanes.indexOf(want) >= 0) ? want
          : (j.def && lanes.indexOf(j.def) >= 0) ? j.def
          : (lanes[0] || here);
      }
      else if (j) {   // SPLIT/MERGE: pick a lane (default 0; the router's picker round-robins to spread work)
        const lanes = outLanes(map, t.x, t.y);
        if (lanes.length) { const i = pick ? ((pick(k, lanes.length) % lanes.length) + lanes.length) % lanes.length : 0; d = lanes[i]; } else d = here;
      }
      const v = DIRV[d], nx = t.x + v[0], ny = t.y + v[1];
      if (!map[key(nx, ny)]) return null;            // stepped off the belt with no bay
      t = { x: nx, y: ny };
    }
    return null;
  }

  const ok = plan => !plan.errors.some(e => !e.warn);   // a plan is deployable iff it has no non-warning errors

  return { compileRoutingPlan, resolveTarget, ok, liveTiles, routeFrom, junctionLaneOwners, _internals: { DIRV, OPP, LANE_ORDER, key, buildBeltMap, outLanes, beltTileNear, nextTiles, detectCycle, hashStr } };
});
