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
        junctions[key(t.x, t.y)] = cfg;
      }
    }

    const seenAgent = {}, unboundBays = [];
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
      const t = beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1);
      if (!t) { errors.push({ code: 'ORPHAN_BAY', propId: p.id, agentId: p.agentId }); continue; }
      if (seenAgent[p.agentId]) { errors.push({ code: 'DUP_AGENT', propId: p.id, agentId: p.agentId }); continue; }
      seenAgent[p.agentId] = true;
      bays.push({ agentId: p.agentId, propId: p.id, tile: t });
      bayTileToAgent[key(t.x, t.y)] = p.agentId;
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
    for (const b of bays) if (!reach[b.agentId]) errors.push({ code: 'DEAD_BAY', propId: b.propId, agentId: b.agentId });

    const plan = { sources, bays, junctions, belts: map, bayTileToAgent, unboundBays, reach, errors };
    plan.hash = hashStr(JSON.stringify({ sources, bays, junctions, belts: map }));   // hash excludes unboundBays: same topology, same hash
    return plan;
  }

  /* ---------- legibility layer: pure readouts of the compiled plan (no routing behavior) ----------
     liveTiles(plan) -> { "x,y": true } for every belt tile on a COMPLETE route: reachable forward from an
     INTAKE source AND flowing onward into a bound bay. The renderer draws these tiles energized and the
     rest cold, so "the line powers on" is literally the compiled plan — truthful telemetry by construction. */
  function liveTiles(plan) {
    const out = {};
    if (!plan || !plan.belts || !plan.sources || !plan.sources.length) return out;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    // forward: every tile a box could occupy starting from any source (a bound bay consumes — don't expand past it)
    const fwd = {}, q = [];
    for (const s of plan.sources) { const k = key(s.tile.x, s.tile.y); if (map[k] && !fwd[k]) { fwd[k] = true; q.push(s.tile); } }
    while (q.length) {
      const t = q.shift();
      if (bayAt[key(t.x, t.y)]) continue;
      for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!fwd[nk]) { fwd[nk] = true; q.push(nt); } }
    }
    // backward: every tile whose flow can still REACH a bound bay (reverse-BFS from bay tiles over flow edges)
    const rev = {};   // tileKey -> [upstream tileKeys]
    for (const k in map) {
      const p = k.split(','), t = { x: +p[0], y: +p[1] };
      for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); (rev[nk] = rev[nk] || []).push(k); }
    }
    const bwd = {}, q2 = [];
    for (const k in bayAt) if (map[k]) { bwd[k] = true; q2.push(k); }
    while (q2.length) {
      const k = q2.shift();
      for (const uk of (rev[k] || [])) if (!bwd[uk]) { bwd[uk] = true; q2.push(uk); }
    }
    for (const k in fwd) if (bwd[k]) out[k] = true;
    return out;
  }

  /* routeFrom(plan, x, y) -> where does the flow from THIS belt tile end up?
     { agents: [agentId...], unbound: n, deadEnd: bool } — agents sorted (deterministic), unbound counts
     distinct unassigned-bay hookups passed, deadEnd true if any branch sinks without reaching a bound bay.
     Fans out ALL junction lanes (a hover tag answers "where CAN this go", not one dispatch decision). */
  function routeFrom(plan, x, y) {
    const res = { agents: [], unbound: 0, deadEnd: false };
    if (!plan || !plan.belts || !plan.belts[key(x, y)]) return res;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    const unboundAt = {};
    for (const u of (plan.unboundBays || [])) unboundAt[key(u.tile.x, u.tile.y)] = u.propId;
    const agents = {}, unboundSeen = {}, seen = {}, q = [{ x, y }];
    seen[key(x, y)] = true;
    while (q.length) {
      const t = q.shift(), k = key(t.x, t.y);
      if (bayAt[k]) { agents[bayAt[k]] = true; continue; }   // a bound bay consumes the box
      if (unboundAt[k]) unboundSeen[unboundAt[k]] = true;     // riding past a dead hookup — note it, flow continues
      const nts = nextTiles(map, junctions, t);
      if (!nts.length) { res.deadEnd = true; continue; }      // open end with no bay: the box sinks
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

  return { compileRoutingPlan, resolveTarget, ok, liveTiles, routeFrom, _internals: { DIRV, OPP, LANE_ORDER, key, buildBeltMap, outLanes, beltTileNear, nextTiles, detectCycle, hashStr } };
});
