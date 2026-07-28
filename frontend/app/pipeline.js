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

  /* DFS along belt flow for a cycle (a back-edge to a GRAY node). Returns the offending tile, or null.

     ITERATIVE (explicit stack) ON PURPOSE: the recursive version recursed once per tile along the flow and
     blew the JS call stack at ~5k chained belt tiles — a 71x71 serpentine, well inside the 240-tile MAX_SPAN
     a floor may span. compileRoutingPlan is called UNGUARDED from build.js rebake() (inside the REFIT render
     loop) and world.js compileRouting(), so that RangeError took the renderer down with it. Same three-colour
     marking, same child order, same first-back-edge answer — only the stack moved off the interpreter's. */
  function detectCycle(map, junctions) {
    const color = {};   // undefined=white, 1=gray (on stack), 2=black (done)
    for (const root in map) {
      if (color[root]) continue;
      color[root] = 1;
      const stack = [{ k: root, kids: null, i: 0 }];      // kids resolved lazily, exactly when visit() would have
      while (stack.length) {
        const fr = stack[stack.length - 1];
        if (fr.kids === null) { const p = fr.k.split(','); fr.kids = nextTiles(map, junctions, { x: +p[0], y: +p[1] }); }
        if (fr.i >= fr.kids.length) { color[fr.k] = 2; stack.pop(); continue; }   // exhausted → black, unwind
        const nt = fr.kids[fr.i++], nk = key(nt.x, nt.y);
        if (color[nk] === 1) return { x: nt.x, y: nt.y };                         // back-edge to a node on the stack
        if (!color[nk]) { color[nk] = 1; stack.push({ k: nk, kids: null, i: 0 }); }
      }
    }
    return null;
  }

  function compileRoutingPlan(geo) {
    const props = (geo && geo.props) || [];
    const map = buildBeltMap(geo && geo.belts);
    const errors = [], sources = [], bays = [], junctions = {}, bayTileToAgent = {};

    for (const p of props) {
      if (p.t === 'intake') {
        const t = beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1);
        // WARN, never a blocker (2026-07-26): an intake with no belt contributes no source, so it can neither
        // loop nor route work into a void — the two things `ok()` exists to prevent. Blocking on it meant ONE
        // decorative INTAKE anywhere on the floor made the whole plan non-deployable, which the sidecar
        // refuses wholesale — taking per-bay capability isolation down with it (see router.stationFor).
        // Same standing as its neighbours ORPHAN_BAY / BAY_NOT_FED: the floor still nags, it just isn't fatal.
        if (!t) { errors.push({ code: 'ORPHAN_SOURCE', propId: p.id, warn: true }); continue; }
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
        // a MERGE carries no config: it is a LANE FUNNEL (several lanes converge, every crate rides on).
        // The old `bufferSize` K described a hold-K-then-combine barrier the harness never performed —
        // see the chooseExit note in conveyor.js. The prop's `bufferSize` field is still carried by the
        // world model so old saves round-trip, it just no longer compiles into anything.
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
    const plan = { sources, bays, junctions, belts: map, bayTileToAgent, unboundBays, dockBays, outs, reach, errors };

    /* THE CHAIN LAYER (agentic graphs, 2026-07-27) — bay -> bay edges. Until this existed the floor was a
       DISPATCHER: it picked one agent per inbound message, the dock consumed the crate, and everything drawn
       downstream of that dock was scenery. `chains` compiles the other half of the graph: where a dock's OUTPUT
       goes. Computed here (not on demand) so the frontend engine, the sidecar chain runner and the REFIT nags
       all read ONE fact — the same reason resolveTarget lives in this module. Compiled BEFORE the BAY_NOT_FED
       pass because it is now one of the three ways a dock can be fed. */
    plan.chains = compileChains(plan);
    const chainFed = {};
    for (const a in plan.chains) for (const n of plan.chains[a].next) chainFed[n] = true;

    // a HOOKED bay whose belt serves NO direction — no intake feeds it, no UPSTREAM DOCK hands off to it, and
    // no outbox receives from it — is a belt to nowhere. A warning, never a blocker (dispatch can't route to it
    // anyway: resolveTarget only walks from sources). This replaces the old blocking DEAD_BAY, which condemned
    // valid outbound lanes; the chainFed clause is the same correction for valid stage-two docks, which are fed
    // by an agent rather than by a door and were being shamed for it.
    for (const b of bays) if (!reach[b.agentId] && !chainFed[b.agentId] && !flowsToOutbox(b.tile)) errors.push({ code: 'BAY_NOT_FED', propId: b.propId, agentId: b.agentId, warn: true });
    // A CHAIN LOOP IS A BLOCKING ERROR — and it is INVISIBLE to detectCycle. A's ship tile feeding B's dock and
    // B's ship tile feeding A's dock are two separate physical lanes with no belt cycle anywhere; the loop only
    // exists across the docks (consume here, respawn there). Left unguarded that is an infinite chain of PAID
    // runs, which is exactly the bar `ok()` sets for a wholesale refusal ("a blocking error must genuinely be
    // able to loop or void work").
    const cc = chainCycle(plan.chains);
    if (cc) {
      // carry a propId so the REFIT/world overlay can ANCHOR the finding on a dock the loop runs through —
      // an error the Commander can't see on the floor is an error they can't fix. First agent, sorted: stable.
      const onLoop = bays.find(b => b.agentId === cc[0]);
      errors.push(onLoop ? { code: 'CHAIN_CYCLE', agents: cc, propId: onLoop.propId } : { code: 'CHAIN_CYCLE', agents: cc });
    }

    plan.hash = hashStr(JSON.stringify({ sources, bays, junctions, belts: map }));   // hash excludes the legibility extras: same dispatch topology, same hash
    return plan;
  }

  /* ---------- the chain layer: a dock's OUTPUT is another dock's INPUT ----------

     A DOCK NEVER EATS ITS OWN OUTPUT. A handoff crate leaves its producer's dock and rides THROUGH every other
     hookup tile of that same bay (a lane running along a dock's edge touches several ring tiles) — it is consumed
     only by a FOREIGN bound bay. The engine enforces the identical rule (`fromAgentId === stopOwner` rides on),
     which is what makes a self-loop structurally impossible rather than merely unlikely. */

  // walk the flow from `starts`, fanning ALL junction lanes: which foreign docks / outboxes can this reach?
  function chainWalk(plan, agentId, starts) {
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    const outAt = {};
    for (const o of (plan.outs || [])) outAt[key(o.tile.x, o.tile.y)] = true;
    const found = {}, seen = {}, q = [];
    let outbox = false, deadEnd = false;
    for (const t of starts) { const k = key(t.x, t.y); if (map[k] && !seen[k]) { seen[k] = true; q.push(t); } }
    while (q.length) {
      const t = q.shift(), k = key(t.x, t.y), owner = bayAt[k];
      if (owner && owner !== agentId) { found[owner] = true; continue; }   // a foreign dock CONSUMES the handoff
      if (outAt[k]) outbox = true;                                          // this lane also ships out
      const nts = nextTiles(map, junctions, t);
      if (!nts.length) { if (!outAt[k]) deadEnd = true; continue; }
      for (const nt of nts) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
    }
    return { next: Object.keys(found).sort(), outbox, deadEnd };
  }

  /* which ring hookup does a dock SHIP from? A bay can touch several lanes (one in, one out). Pick the tile whose
     onward flow actually goes somewhere, in a fixed preference so frontend and sidecar spawn on the same tile:
     a lane that reaches another DOCK > a lane that reaches an OUTBOX > the first hookup. Deterministic: `tiles`
     is recorded in ring-scan order. Returns { tile, next, outbox, deadEnd } or null for a beltless dock. */
  function shipFrom(plan, bay) {
    const tiles = (bay.tiles && bay.tiles.length) ? bay.tiles : (bay.tile ? [bay.tile] : []);
    let viaOutbox = null, first = null;
    for (const t of tiles) {
      // the walk STARTS ON the hookup itself (not its successor): a dock's ring tile is very often ALSO the
      // outbox's ring tile on a short bay->OUTBOX lane, and starting one tile downstream stepped straight over
      // the delivery mouth and reported the ship-out lane as a dead end.
      const r = chainWalk(plan, bay.agentId, [t]);
      const rec = { tile: t, next: r.next, outbox: r.outbox, deadEnd: r.deadEnd };
      if (r.next.length) return rec;                    // feeds another dock — the strongest signal
      if (r.outbox && !viaOutbox) viaOutbox = rec;
      if (!first) first = rec;
    }
    return viaOutbox || first;
  }

  // { agentId -> { tile, next:[agentId…], outbox, deadEnd } } for every belt-hooked bound bay.
  function compileChains(plan) {
    const out = {};
    for (const b of (plan.bays || [])) { const r = shipFrom(plan, b); if (r) out[b.agentId] = r; }
    return out;
  }

  // a cycle over the chain edges (A→B→…→A). Returns the agents on the loop (sorted) or null. Iterative, same
  // three-colour marking as detectCycle — a bay graph is small, but the stack discipline is not negotiable here.
  function chainCycle(chains) {
    const color = {};
    for (const root in chains) {
      if (color[root]) continue;
      color[root] = 1;
      const stack = [{ a: root, i: 0 }];
      while (stack.length) {
        const fr = stack[stack.length - 1], kids = (chains[fr.a] && chains[fr.a].next) || [];
        if (fr.i >= kids.length) { color[fr.a] = 2; stack.pop(); continue; }
        const nb = kids[fr.i++];
        if (color[nb] === 1) return stack.map(f => f.a).concat([nb]).sort().filter((v, i, a) => a.indexOf(v) === i);
        if (!color[nb] && chains[nb]) { color[nb] = 1; stack.push({ a: nb, i: 0 }); }
      }
    }
    return null;
  }

  /* chainNext(plan, agentId, ctx, pick) -> the SINGLE agent this dock's output actually hands off to, or null.
     Mirrors the crate physics exactly (K crates in, K crates out — one output crate is one downstream run, never
     a fan-out to every lane): follows the belt from the ship tile, a FILTER branches on the OUTPUT's tag (this is
     how you draw "route the result by what it turned out to be"), a SPLIT round-robins through `pick`, own-dock
     hookups are ridden through, the first foreign dock consumes. null = the handoff ships out / dead-ends, i.e.
     this dock is a terminal stage and its reply is the pipeline's answer. */
  function chainNext(plan, agentId, ctx, pick) {
    if (!plan || !plan.chains || !plan.belts) return null;
    const rec = plan.chains[agentId];
    if (!rec || !rec.tile || !rec.next.length) return null;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    const tag = (ctx && ctx.tag) || 'general';
    let t = rec.tile, guard = 0; const seen = {};
    while (t && guard++ < 4096) {
      const k = key(t.x, t.y);
      if (bayAt[k] && bayAt[k] !== agentId) return bayAt[k];   // a foreign dock consumes it
      if (seen[k]) return null;                                 // (a CYCLE is already a compile error)
      seen[k] = true;
      const here = map[k]; if (!here) return null;
      const j = junctions[k];
      let d = here;
      if (j && j.kind === 'filter') {
        const lanes = outLanes(map, t.x, t.y), want = j.routes && j.routes[tag];
        d = (want && lanes.indexOf(want) >= 0) ? want : (j.def && lanes.indexOf(j.def) >= 0) ? j.def : (lanes[0] || here);
      } else if (j && j.kind === 'split') {
        const lanes = outLanes(map, t.x, t.y);
        if (lanes.length) { const i = pick ? ((pick(k, lanes.length) % lanes.length) + lanes.length) % lanes.length : 0; d = lanes[i]; }
      }
      const v = DIRV[d], nx = t.x + v[0], ny = t.y + v[1];
      if (!map[key(nx, ny)]) return null;                       // shipped out / sank with no dock
      t = { x: nx, y: ny };
    }
    return null;
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
    // HANDOFF: dock -> dock. A stage-to-stage lane carries real crates (and buys real runs) the moment the
    // chain layer exists, so leaving it COLD would be the energized-tile promise lying in the other direction.
    // Starts at the SHIP tile and ends only on a DOWNSTREAM dock's hookups, so a stub hookup that reaches no
    // other dock stays dark instead of lighting itself.
    const chains = plan.chains || {};
    for (const aid in chains) {
      const c = chains[aid];
      if (!c || !c.tile || !c.next || !c.next.length) continue;
      const ends = [];
      for (const k in bayAt) if (c.next.indexOf(bayAt[k]) >= 0) { const p = k.split(','); ends.push({ x: +p[0], y: +p[1] }); }
      if (ends.length) segment([c.tile], false, ends);
    }
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

  /* sourceFor(plan, agentId) -> the INBOX source whose flow actually REACHES this agent's dock, or null.
     Multi-network law (2026-07-05, Andrew's two-room bug): each room's INBOX feeds its OWN line — an
     addressed work-item must enter through the door that leads home, never sail another agent's lane to
     their outbox. Mirrors the ENGINE's addressed-crate physics exactly: fans ALL junction lanes (owners
     steer it home), rides THROUGH foreign docks (only the owner's dock consumes an addressed crate).
     First matching source in plan order (deterministic); null -> no line on this floor reaches the agent
     (caller lands the work directly at the dock — the lone-bay law). */
  function sourceFor(plan, agentId) {
    if (!plan || !plan.sources || !plan.sources.length || !agentId) return null;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    for (const s of plan.sources) {
      const seen = {}, q = [s.tile];
      seen[key(s.tile.x, s.tile.y)] = true;
      let hit = false;
      while (q.length && !hit) {
        const t = q.shift(), k = key(t.x, t.y);
        if (bayAt[k] === agentId) { hit = true; break; }
        // a FOREIGN dock hookup does not consume an addressed crate — keep riding
        for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
      }
      if (hit) return s.tile;
    }
    return null;
  }

  // round-robin picker so autonomous dispatch genuinely SPREADS splitter work across agents, matching the
  // engine's load-balance intent instead of always running the first lane.
  function resolveTarget(plan, ctx, pick) {
    if (!plan) return null;
    // ADDRESSED WORK GOES TO ITS ADDRESSEE (2026-07-05, Andrew's consistency ruling): when the message is
    // explicitly bound to an agent (a COMMS session, a /talk binding) and that agent owns a dock on this
    // floor, the floor's answer IS that dock — content/filter routing only ever sorts UNADDRESSED work
    // (group intake, unbound chats). Without this, a two-room floor sent "message to agent B" down room A's
    // line because A's INBOX compiled first.
    const bound = ctx && ctx.boundAgentId;
    if (bound) {
      const docks = plan.dockBays || plan.bays || [];
      for (const b of docks) if (b.agentId === bound) return bound;
    }
    if (!plan.sources || !plan.sources.length) return null;
    const tag = (ctx && ctx.tag) || 'general';
    const map = plan.belts, junctions = plan.junctions, bayAt = plan.bayTileToAgent;
    // walk EVERY source in plan order (not just sources[0] — a second room's network was invisible);
    // the first lane that lands on a bound bay wins. Deterministic: plan order + lane rules are fixed.
    for (const s of plan.sources) {
      let t = s.tile, guard = 0; const seen = {};
      let hitAgent = null;
      while (t && guard++ < 4096) {
        const k = key(t.x, t.y);
        if (bayAt[k]) { hitAgent = bayAt[k]; break; } // arrived at a bound bay
        if (seen[k]) break;                            // loop guard (a CYCLE is already a compile error)
        seen[k] = true;
        const here = map[k]; if (!here) break;         // sank with no bay
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
        else if (j && j.kind === 'split') {   // pick a lane (default 0; the router's picker round-robins to spread work)
          const lanes = outLanes(map, t.x, t.y);
          if (lanes.length) { const i = pick ? ((pick(k, lanes.length) % lanes.length) + lanes.length) % lanes.length : 0; d = lanes[i]; } else d = here;
        }
        // a MERGE follows the belt (it funnels lanes IN; its single exit IS the tile's dir), and must not
        // burn a round-robin tick — that counter belongs to splitters, which are the only real branch.
        const v = DIRV[d], nx = t.x + v[0], ny = t.y + v[1];
        if (!map[key(nx, ny)]) break;                  // stepped off the belt with no bay
        t = { x: nx, y: ny };
      }
      if (hitAgent) return hitAgent;
    }
    return null;
  }

  /* THE HANDOFF TURN — lives HERE, in the module both the sidecar executor and the browser's COMMS loop
     already load, because the same floor must produce the same run on every surface. A downstream stage is
     NOT the user, it is a machine being handed material, so the turn names the line explicitly. Carrying the
     ORIGINAL request as well as the upstream output is load-bearing: a writer handed only research has no
     idea what was asked and invents one. */
  function handoffPrompt(originalText, fromAgentId, upstream, hop) {
    return 'PIPELINE HANDOFF — you are stage ' + (hop + 1) + ' of a work line on this station.\n\n'
      + 'The original request was:\n' + String(originalText || '(none recorded)') + '\n\n'
      + 'The upstream stage (' + fromAgentId + ') produced:\n' + String(upstream) + '\n\n'
      + 'Do YOUR part of this work and produce the output for the next stage. Do not restate the upstream '
      + 'output — build on it. Answer with the work itself, not a description of what you would do.';
  }

  const ok = plan => !plan.errors.some(e => !e.warn);   // a plan is deployable iff it has no non-warning errors

  return { compileRoutingPlan, resolveTarget, sourceFor, ok, liveTiles, routeFrom, junctionLaneOwners, chainNext, handoffPrompt, _internals: { DIRV, OPP, LANE_ORDER, key, buildBeltMap, outLanes, beltTileNear, nextTiles, detectCycle, hashStr, compileChains, chainCycle, shipFrom } };
});
