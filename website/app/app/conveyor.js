/* STARNET — conveyor.js : directional belts + the boxes that ride them.

   The WorldModel owns belt TOPOLOGY (a keyed "x,y"->dir graph, walkable floor machinery). This
   module owns everything ALIVE: the transport simulation (boxes flowing tile-to-tile, spawned at
   sources, sinking at open ends, spaced so they never stack) and the pixel art.

   CARGO speaks the station's SEMANTIC COLOR ECONOMY (amber=production, cyan=data, red=command,
   gold=money, steel=neutral) — each box hashes deterministically to a type, weighted so the loud
   colours stay rare. Boxes are built on one 2.5D chassis (lit top face + shaded front face + a
   leading-edge rim light) and carry motion juice: a hash-phased ride bob, a lean into travel, a
   bob-coupled contact shadow, a spawn pop, and a sink that reads as falling into a chute.

   Belts read as a real material-handling network: axis-aware treads, a dim-neutral marching flow
   chevron (NOT an economy accent — that would flood the cyan/green channel), corner-aware art on
   bends, an amber SOURCE feeder hatch, and a dark SINK chute mouth.

   Frame-agnostic: `Conveyor.create()` returns a self-contained instance handed a belt list in
   whatever tile frame the caller draws in (build.js = world coords, world.js = local coords).
   DETERMINISM: no Math.random, no wall-clock — nowMs/dtMs injected; variety from U.hash(''+id). */
'use strict';

const Conveyor = (() => {
  const DIRV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
  const OPP = { E: 'W', W: 'E', S: 'N', N: 'S' };
  const SPEED = 1.7;        // tiles / second a box travels
  const SINK_MS = 300;      // chute fall + fade time once a box rides off the end
  const POP_MS = 180;       // spawn-pop settle time
  const MIN_GAP = 0.82;     // tiles of clear space a box keeps behind the one ahead (no stacking)
  const MAX_BOXES = 80;     // hard cap (a runaway loop can't explode)

  const key = (x, y) => x + ',' + y;
  const buildMap = belts => { const m = new Map(); for (const b of belts) m.set(key(b.x, b.y), b.dir); return m; };
  // a junction's out-lanes: neighbour belts that DON'T flow back into the tile. Fixed order → deterministic routing.
  const LANE_ORDER = ['E', 'S', 'W', 'N'];
  function outLanes(x, y, map) {
    const lanes = [];
    for (const d of LANE_ORDER) { const v = DIRV[d], nb = map.get(key(x + v[0], y + v[1])); if (nb && nb !== OPP[d]) lanes.push(d); }
    return lanes;
  }
  // classify a tile for its art: which neighbour feeds it, where it drains, is it a bend
  function classify(map, b) {
    const d = b.dir, v = DIRV[d];
    const fd = map.get(key(b.x - v[0], b.y - v[1]));      // feeder's own dir (or undefined)
    const fedByMe = fd && fd !== OPP[d];
    const drain = map.get(key(b.x + v[0], b.y + v[1]));
    let kind = 'straight';
    if (!fedByMe) kind = 'source';
    else if (!drain) kind = 'sink';
    else if (fd !== d) kind = 'corner';
    return { kind, dir: d, fromDir: fedByMe ? fd : null };
  }

  /* ---- art context (module-local, set per draw call — like propsprites/sprites) ---- */
  let _ctx = null, _now = 0;
  const px = (x, y, w, h, c) => { _ctx.fillStyle = c; _ctx.fillRect(x, y, w, h); };
  const SH = (c, n) => U.shade(c, n);

  /* ============================ CARGO ART ============================ */
  /* one shared 2.5D chassis; cx,py = rounded pixel centre, h32 = U.hash(''+id), dir = E|W|N|S.
     returns the lit TOP-face rect so each type can stencil onto it. */
  function cargoChassis(cx, py, h32, body, dir) {
    const x = cx - 4, y = py - 5;                 // 9 wide; top face 5 tall, front face 3 tall
    const jit = ((h32 >> 3) & 3) - 1;             // -1..+2 deterministic tone jitter
    const top = SH(body, 0.10 + jit * 0.04);
    // FRONT face (short, shaded) — the 2.5D base
    px(x, y + 5, 9, 3, SH(body, -0.42));
    px(x, y + 7, 9, 1, SH(body, -0.60));          // darkest floor line
    px(x + 8, y + 5, 1, 3, SH(body, -0.55));      // right front facet to shadow
    // TOP face (lit), 1px inset so the front edge shows
    px(x, y, 9, 5, SH(body, -0.25));              // top outline
    px(x + 1, y, 7, 5, top);
    px(x + 1, y, 7, 1, SH(top, 0.30));            // sheen (EXACTLY 1px)
    px(x + 1, y + 1, 1, 4, SH(top, 0.16));        // lit left edge
    px(x + 7, y + 1, 1, 4, SH(top, -0.22));       // shaded right edge
    // RIM LIGHT on the leading edge (reads as travel direction — all 4 headings)
    const v = DIRV[dir];
    if (v[0] > 0) px(x + 8, y, 1, 5, SH(top, 0.5));
    else if (v[0] < 0) px(x, y, 1, 5, SH(top, 0.5));
    else if (v[1] < 0) px(x + 1, y, 7, 1, SH(top, 0.55));
    else px(x + 1, y + 4, 7, 1, SH(top, 0.4));
    // signature corner braces + one rivet glint
    px(x, y, 2, 1, SH(top, 0.4)); px(x + 7, y, 2, 1, SH(top, 0.4));
    px(x + 1, y, 1, 1, '#aeb9c4');
    return { tx: x + 1, ty: y };
  }
  const bloomOK = () => _ctx.globalAlpha > 0.6;   // skip glows on fading/popping boxes (cheap + clean)

  function cargoProduction(cx, py, h32, dir) {     // amber = production (common)
    const f = cargoChassis(cx, py, h32, '#46525a', dir), x = f.tx, y = f.ty;
    px(x + 2, y + 1, 1, 4, '#2e3840'); px(x + 5, y + 1, 1, 4, '#2e3840');     // ribs
    px(x + 3, y + 1, 1, 4, SH('#46525a', 0.18));                              // rib catch
    px(cx - 4, py, 9, 1, '#caa84a'); px(cx - 4, py + 1, 9, 1, SH('#caa84a', -0.4)); // amber band (front)
    px(cx - 3 + (h32 % 3), py, 2, 1, '#e8c860');                              // hot pip, varied x
    const lit = ((_now / 520 + (h32 & 7) * 0.13) % 1) < 0.5;
    px(x + 5, y + 1, 1, 1, lit ? '#ffe088' : '#5a4a24');
    if (lit && bloomOK()) { _ctx.globalAlpha *= 0.5; px(x + 4, y, 3, 3, '#e8c860'); _ctx.globalAlpha /= 0.5; }
  }
  function cargoUtility(cx, py, h32, dir) {         // steel = neutral (most common; lets specials pop)
    const f = cargoChassis(cx, py, h32, '#3e4a52', dir), x = f.tx, y = f.ty;
    for (let i = 0; i < 4; i++) if ((h32 >> i) & 1) px(x + 1 + i * 2, y + 1, 1, 3, '#222a30'); // barcode
    px(x + 1, y + 4, 4, 1, '#2a343c');                                        // serial underline
    px(x + 6, y + 1, 1, 1, '#41ff8a');                                        // green logged dot
    if (h32 & 16) px(x + 5, y + 3, 1, 1, SH('#3e4a52', -0.5));                // deterministic scuff
  }
  function cargoData(cx, py, h32, dir) {           // cyan = data (flat cassette — different silhouette)
    const body = '#1e3a44', x = cx - 4, y = py - 4;
    px(x, y + 4, 9, 3, SH(body, -0.4)); px(x, y + 6, 9, 1, '#0a1418');        // front
    px(x, y, 9, 4, SH(body, -0.2)); px(x + 1, y, 7, 4, body);                 // top
    px(x + 1, y, 7, 1, '#2e5a68');                                            // sheen
    px(x + 2, y + 1, 5, 2, '#06181e');                                        // recessed window
    const head = Math.floor((_now / 90 + (h32 & 7)) % 5);
    px(x + 2 + head, y + 1, 1, 1, '#7df0ff');                                 // marching read-head
    px(x + 2, y + 2, 3, 1, '#1d6878');                                        // dim history
    px(x + 1, y, 1, 4, '#4ad9ff'); px(x + 7, y + 3, 1, 1, body);              // cyan edge + notch
    const v = DIRV[dir];
    if (v[0] >= 0) px(x + 8, y, 1, 4, SH('#4ad9ff', 0.2)); else px(x, y, 1, 4, SH('#4ad9ff', 0.2));
  }
  function cargoCommand(cx, py, h32, dir) {        // red = command (rare, urgent)
    const f = cargoChassis(cx, py, h32, '#3a2826', dir), x = f.tx, y = f.ty;
    px(x + 1, y + 2, 6, 1, '#1a0e0c');
    for (let i = 0; i < 3; i++) px(x + 1 + i * 2, y + 1 + (i % 2), 2, 1, '#ff4a3d'); // hazard chevron
    const on = ((_now / 240 + (h32 & 3) * 0.2) % 1) < 0.5;                    // fast strobe = urgency
    px(x + 5, y, 2, 1, on ? '#ff8a7a' : '#5a201c');
    if (on && bloomOK()) { _ctx.globalAlpha *= 0.45; px(x + 4, y - 1, 3, 3, '#ff4a3d'); _ctx.globalAlpha /= 0.45; }
  }
  function cargoMoney(cx, py, h32, dir) {          // gold = money (rarest, the jackpot)
    const x = cx - 4, y = py - 5;
    for (let r = 0; r < 2; r++) {                                             // two stacked ingots
      const yy = y + 1 + r * 3, w = 9 - r * 2, xx = x + r;
      px(xx, yy, w, 3, '#caa84a'); px(xx, yy, w, 1, '#ffe88c'); px(xx, yy + 2, w, 1, '#8a7434');
      px(xx, yy, 1, 3, '#e8c860'); px(xx + w - 1, yy, 1, 3, '#6a5824');
    }
    const sw = Math.floor((_now / 140 + (h32 & 7)) % 9);                      // sheen sweep
    px(x + sw, y + 1, 1, 2, '#fff4cc');
    if (bloomOK()) { _ctx.globalAlpha *= 0.4; px(x + 2, y + 1, 5, 4, '#ffe88c'); _ctx.globalAlpha /= 0.4; }
  }
  /* ---- ECONOMIC cargo: a work-item box whose ART speaks its place in the spend->yield economy.
     Driven entirely by payload fields (set by world.js from REAL cost/outcome events), so the
     crate on the belt tells the cost truth — the Factorio "read the line at a glance" instinct,
     pointed at operating agents cheaply. A payload WITHOUT a `box` role falls back to the cyan
     data cassette, so nothing about existing boxes changes. */
  function cargoOre(cx, py, h32, dir, weight) {     // amber ORE — inbound work, a UNIFORM raw chunk (size carries no cost signal; only the green PRODUCT crate's mass means real spend)
    const w = weight < 0 ? 0 : weight > 1 ? 1 : weight;
    const f = cargoChassis(cx, py, h32, '#5a4a24', dir), x = f.tx, y = f.ty;
    px(x + 1, y + 1, 6, 3, '#caa84a'); px(x + 1, y + 1, 6, 1, '#e8c860');     // amber ore body + lit cap
    const glints = 1 + Math.round(w * 3);                                     // heavier ore = more embedded glints
    for (let i = 0; i < glints; i++) px(x + 1 + ((h32 >> (i * 2)) % 6), y + 1 + (i % 3), 1, 1, '#ffe88c');
    if (w > 0.05 && bloomOK()) {                                              // mass-scaled heat bloom: pebble -> glowing boulder
      const r = 1 + Math.round(w * 3), k = 0.22 + 0.42 * w;
      _ctx.globalAlpha *= k; px(x + 3 - r, y + 2 - r, 3 + r * 2, 3 + r * 2, '#e8c860'); _ctx.globalAlpha /= k;
    }
  }
  function cargoProduct(cx, py, h32, dir, weight) {  // green PRODUCT — a banked result; MASS = the run's real reconciled cost
    const w = weight < 0 ? 0 : weight > 1 ? 1 : (weight || 0);   // default 0 = today's look (back-compat)
    const f = cargoChassis(cx, py, h32, '#2c4a36', dir), x = f.tx, y = f.ty;
    px(x + 1, y + 1, 6, 3, '#3f8a5a'); px(x + 1, y + 1, 6, 1, '#62c487');     // green face + lit top
    px(x + 2, y + 2, 1, 1, '#d8f4e0'); px(x + 4, y + 1, 2, 2, '#9fe6bf');     // seal glint
    for (let i = 0; i < Math.round(w * 2); i++) px(x + 2 + ((h32 >> (i * 2)) % 5), y + 1 + (i % 2), 1, 1, '#d8f4e0');  // pricier run = more seal pips
    if (bloomOK()) {                                                          // mass-scaled banked glow
      const k = 0.4 + 0.4 * w, r = Math.round(w * 2);
      _ctx.globalAlpha *= k; px(x + 2 - r, y - r, 4 + r * 2, 4 + r * 2, '#62c487'); _ctx.globalAlpha /= k;
    }
  }
  function cargoSlag(cx, py, h32, dir) {             // red-hot SLAG — spend that yielded nothing (the thing to drive DOWN)
    const f = cargoChassis(cx, py, h32, '#2a1714', dir), x = f.tx, y = f.ty;
    px(x + 1, y + 1, 6, 3, '#3a1d18');                                        // charred body (no tidy crate face)
    const hot = ((_now / 300 + (h32 & 7) * 0.12) % 1) < 0.55;                 // molten cracks strobe = hot waste
    px(x + 2, y + 2, 1, 1, hot ? '#ff6a3d' : '#7a2a18');
    px(x + 4, y + 1, 1, 2, hot ? '#ff8a4a' : '#6a2414');
    px(x + 5, y + 3, 1, 1, hot ? '#ffb070' : '#5a2010');
    if (hot && bloomOK()) { _ctx.globalAlpha *= 0.45; px(x + 2, y, 4, 4, '#ff5a2d'); _ctx.globalAlpha /= 0.45; }
  }

  // pure, replayable id -> type. weights keep the meaningful colours rare.
  function cargoType(id) {
    const r = U.hash('' + id) % 100;
    if (r < 34) return 0;      // 34% utility (steel)
    if (r < 64) return 1;      // 30% production (amber)
    if (r < 80) return 2;      // 16% data (cyan)
    if (r < 93) return 3;      // 13% command (red)
    return 4;                  //  7% money (gold)
  }
  const CARGO_FN = [cargoUtility, cargoProduction, cargoData, cargoCommand, cargoMoney];

  /* a floating tag marking a box that carries a REAL work-item. Colour reads its economic ROLE:
     amber = inbound ore, green = banked product, red = wasted slag (legacy: outbound -> green). */
  const TAG_FACE = { ore: ['#e8c860', '#fff0b0'], product: ['#5ad1b3', '#c8f4e6'], slag: ['#ef6a4a', '#ffc8b0'] };
  function payloadTag(cx, py, role) {
    const fs = TAG_FACE[role] || TAG_FACE.ore, face = fs[0], sheen = fs[1];
    const yy = py - 11;
    px(cx, yy + 4, 1, 3, '#2a2418');                    // stem down to the crate
    px(cx - 3, yy, 7, 5, '#161210');                    // dark outline
    px(cx - 2, yy + 1, 5, 3, face);                     // tag face
    px(cx - 2, yy + 1, 5, 1, sheen);                    // top sheen
    px(cx - 1, yy + 2, 3, 1, SH(face, -0.35));          // flap
    if (bloomOK()) { _ctx.globalAlpha *= 0.4; px(cx - 3, yy, 7, 6, face); _ctx.globalAlpha /= 0.4; }
  }

  /* ---- motion bundle: bob/lean/shadow + spawn-pop + sink-chute. translate-only (no ctx.scale). ---- */
  function boxMotion(bx, now) {
    const s = U.hash('' + bx.id);
    const ph = (s % 1000) / 1000 * 6.2832;
    const wob = ((s >> 10) & 255) / 255;
    let bob = Math.sin(now / (520 * (0.85 + wob * 0.3)) + ph) * 0.9;          // ~±1px ride shimmer
    const v = DIRV[bx.dir];
    const lift0 = (bob + 0.9) / 1.8;                                          // 0..1 for the shadow
    let alpha = 1, slide = 0, shadowMul = 1;
    // spawn pop: quick alpha ramp + a small overshoot lift (easeOutBack stand-in)
    const age = now - (bx.t0 || 0);
    if (age < POP_MS) {
      const k = age / POP_MS, kk = k - 1, c = 1.70158;
      bob += -((1 + c) * kk * kk * kk + c * kk * kk) * 3;
      alpha = Math.min(1, age / 60);
    }
    // corner jolt: a brief upward hop when the box just changed heading (reads as reacting to the turn)
    const ta = now - (bx.turn0 || -1e9);
    if (ta >= 0 && ta < 140) bob -= Math.sin((ta / 140) * Math.PI) * 1.4;
    // sink chute: fall + fade + slide off in the travel dir + shrinking shadow
    if (bx.sink > 0) {
      const e = Math.min(1, bx.sink / SINK_MS); const ee = e * e;
      alpha *= 1 - ee; slide = ee * 3.5; shadowMul = 1 - 0.9 * ee; bob += ee * 2.5;
    }
    return { bob, lx: -v[0] * 0.6 + v[0] * slide, ly: -v[1] * 0.6 + v[1] * slide, lift: lift0, alpha, shadowMul };
  }

  function create(opts) {
    const onDeliver = (opts && opts.onDeliver) || null;   // called ONCE when a PAYLOAD box rides off the open end
    const onAdvance = (opts && opts.onAdvance) || null;    // junction telemetry seam: (bx, info) on each routing decision
    let boxes = [];
    let nid = 1;
    const pending = [];                                    // enqueueAt() work-items, born inside tick() (live nowMs + dir)
    const rr = new Map();                                  // per-junction round-robin counter (deterministic splitter routing)
    const mbuf = new Map();                                // per-merge-tile absorbed payloads (combined on the K-th box)
    const mergeSig = new Map();                            // per-merge-tile config signature (kind:bufferSize) — detects junction re-wiring
    const mergeFx = [];                                    // G0.10: {x, y, t0, carrier} — combine flashes at merge junctions

    function reset() { boxes = []; pending.length = 0; rr.clear(); mbuf.clear(); mergeSig.clear(); mergeFx.length = 0; }

    /* Lane E6a — junction re-wire hygiene: a merge tile absorbs K-1 payloads into mbuf before the K-th box carries
       them out. If that tile's junction is edited (removed, retyped, or its bufferSize K changed) while a partial
       buffer sits there, those absorbed payloads would later combine against a config that no longer applies — a
       silent stale-buffer bug. reconcileJunctions() diffs the live junctions Map against the last-seen per-tile
       signature and CLEARS mbuf for any merge tile whose config changed or disappeared, so a partial buffer never
       survives a re-wire. Kept inside the conveyor's API (called at the top of tick) so callers stay unchanged. */
    function reconcileJunctions(junctions) {
      for (const k of Array.from(mbuf.keys())) {                       // tiles no longer a merge junction: drop the buffer
        const jt = junctions && junctions.get(k);
        if (!jt || jt.kind !== 'merge') { mbuf.delete(k); mergeSig.delete(k); }
      }
      if (junctions) for (const [k, jt] of junctions) {               // live merge tiles: clear if the config changed
        if (!jt || jt.kind !== 'merge') continue;
        const sig = 'merge:' + Math.max(2, (jt.bufferSize | 0) || 2);
        if (mergeSig.get(k) !== sig) { mbuf.delete(k); mergeSig.set(k, sig); }
      }
    }

    /* a junction overrides a box's exit at its tile. Three kinds, all deterministic (per-tile state + the
       fixed LANE_ORDER, no RNG/clock):
         SPLIT  — round-robin across out-lanes (load-balance = real parallelism, drawn).
         FILTER — route by the box's payload.tag (config.routes[tag] || config.def), so content sorts to the
                  right agent's bay. A tag pointing at a missing lane falls back to def then the first lane —
                  a filter NEVER drops work (mirrors pipeline.resolveTarget so visual == dispatch).
         MERGE  — buffer K inbound boxes per-tile; the first K-1 are ABSORBED (return false = consume, no
                  delivery), the K-th rides on carrying the combined work-item list (config.bufferSize = K).
       Returns an out-lane dir, or null (go straight), or false (merge consumed this box — sink it, no deliver). */
    function chooseExit(jt, bx, x, y, map, nowMs) {
      const lanes = outLanes(x, y, map);
      if (!lanes.length) return null;                      // open-end junction: nothing to override, deliver/sink
      const k = key(x, y);
      // ADDRESSED work rides HOME (crate-physics truth, 2026-07-05): a box that already belongs to an
      // agent (payload.agentId — a cron, a bound chat) ignores content/balance routing and takes the lane
      // that reaches ITS OWNER's bay (jt.owners = {dir: [agentIds]}, precompiled from the plan). Filters
      // and splitters only ever decide for UNOWNED work — so the crate's path can never contradict who
      // actually runs the job. Deterministic: fixed LANE_ORDER scan.
      if (bx.payload && bx.payload.agentId && !bx.payload.outbound && jt.owners) {
        for (const d of lanes) { const own = jt.owners[d]; if (own && own.indexOf(bx.payload.agentId) >= 0) { if (onAdvance) onAdvance(bx, { kind: jt.kind, tile: { x, y }, lane: d, owner: bx.payload.agentId }); return d; } }
      }
      if (jt.kind === 'split') {
        const n = rr.get(k) || 0;
        rr.set(k, (n + 1) % lanes.length);
        return lanes[n % lanes.length];
      }
      if (jt.kind === 'filter') {
        const tag = (bx.payload && bx.payload.tag) || 'general';
        const want = jt.routes && jt.routes[tag];
        const dir = (want && lanes.indexOf(want) >= 0) ? want
                  : (jt.def && lanes.indexOf(jt.def) >= 0) ? jt.def
                  : lanes[0];                              // safety: an unroutable tag takes the first lane, never dropped
        if (onAdvance) onAdvance(bx, { kind: 'filter', tile: { x, y }, lane: dir, tag });
        return dir;
      }
      if (jt.kind === 'merge') {
        const K = Math.max(2, jt.bufferSize | 0 || 2);
        const buf = mbuf.get(k) || mbuf.set(k, []).get(k);
        buf.push(bx.payload || null);
        if (buf.length < K) {                              // not the K-th yet: this box is absorbed into the merge
          bx.merged = true;
          mergeFx.push({ x, y, t0: nowMs, carrier: false });   // G0.10: an absorbed crate flashes the junction — it never just vanishes
          if (onAdvance) onAdvance(bx, { kind: 'merge', tile: { x, y }, absorbed: true });
          return false;                                    // CONSUME sentinel — caller sinks it without delivering
        }
        mbuf.set(k, []);                                   // K reached: clear buffer; this box becomes the carrier
        const ids = buf.map(p => p && p.workitemId).filter(Boolean);
        bx.payload = Object.assign({}, bx.payload, { merged: ids, mergeCount: K });
        mergeFx.push({ x, y, t0: nowMs, carrier: true });      // G0.10: the combined carrier releases — a brighter combine burst
        if (onAdvance) onAdvance(bx, { kind: 'merge', tile: { x, y }, lane: lanes[0], merged: ids });
        return lanes[0];                                   // merge fans IN, rides out the single out-lane
      }
      return null;
    }

    /* event-driven spawn: drop ONE work-item-carrying box at a named SOURCE tile, bypassing the hash
       auto-spawn cadence. The box is actually born inside tick() so it gets the live nowMs and belt dir. */
    function enqueueAt(x, y, payload) { pending.push({ x, y, payload }); }

    /* supersede drop: early-sink the riding box whose work-item was aborted (a newer message took over the
       chat). It falls off the belt via the chute animation and — crucially — never fires onDeliver. */
    function dropWorkitem(workitemId) {
      // also purge any not-yet-born pending item with this id, so a supersede that races the spawn still drops it
      for (let i = pending.length - 1; i >= 0; i--) { const p = pending[i].payload; if (p && p.workitemId === workitemId) pending.splice(i, 1); }
      for (const bx of boxes) {
        if (bx.sink <= 0 && bx.payload && bx.payload.workitemId === workitemId) { bx.sink = 1; bx.delivered = true; return true; }
      }
      return false;
    }

    /* distance (in tiles, along the path) to the nearest box ahead — for backpressure spacing */
    function leaderDist(bx, tileMap) {
      let best = Infinity;
      const same = tileMap.get(key(bx.x, bx.y));
      if (same) for (const c of same) if (c !== bx && c.sink <= 0 && c.prog > bx.prog) best = Math.min(best, c.prog - bx.prog);
      const v = DIRV[bx.dir], nxt = tileMap.get(key(bx.x + v[0], bx.y + v[1]));
      if (nxt) for (const c of nxt) if (c.sink <= 0) best = Math.min(best, (1 - bx.prog) + c.prog);   // a box that began sinking mid-tick no longer blocks
      return best;
    }

    /* stops (optional 5th arg): { "x,y": agentId } — bound-bay hookup tiles. An INBOUND crate arriving on
       a stop tile is DELIVERED there (the dock consumes the job): an unowned crate stops at the FIRST dock
       it reaches; an addressed crate stops only at ITS OWNER's dock and rides past every other. Outbound
       crates ignore stops entirely (they START at a dock and ship out). This is what makes "the crate ends
       at the bay" physically true even when the lane continues on toward an OUTBOX. */
    function tick(dtMs, nowMs, belts, junctions, stops) {
      reconcileJunctions(junctions);   // E6a: drop stale merge buffers when a junction is re-wired this tick
      const map = buildMap(belts || []);
      const dt = Math.min(64, dtMs) / 1000;

      // G0.10: expire spent merge flashes (append-ordered, so the head is always the oldest)
      while (mergeFx.length && nowMs - mergeFx[0].t0 > MERGE_FX_MS) mergeFx.shift();

      // occupancy index of RIDING boxes (sinking boxes are leaving — they don't block)
      const tileMap = new Map();
      for (const bx of boxes) { if (bx.sink > 0) continue; const k = key(bx.x, bx.y); (tileMap.get(k) || tileMap.set(k, []).get(k)).push(bx); }

      // NO auto-spawn: a box exists ONLY for a real work-item placed via enqueueAt(). The original
      // decorative source-spawn was removed on purpose — belts stay QUIET until real work rides them, so
      // every crate on a belt means something. The only spawn path is the enqueueAt drain below.
      // event-driven work-items (enqueueAt): born here so each gets the live nowMs + the tile's belt dir.
      // No belt under the tile → nothing rides (the server still ran the work; the world just shows no crate).
      while (pending.length && boxes.length < MAX_BOXES) {
        const p = pending.shift();
        const d = map.get(key(p.x, p.y));
        if (!d) continue;
        boxes.push({ id: nid++, x: p.x, y: p.y, dir: d, prog: 0, sink: 0, t0: nowMs, turn0: -1e9, payload: p.payload, spawnTile: key(p.x, p.y) });
      }

      // advance: cap each box so it never closes within MIN_GAP of the box ahead (no stacking; backpressure)
      for (let i = boxes.length - 1; i >= 0; i--) {
        const bx = boxes[i];
        if (bx.sink > 0) { bx.sink += dtMs; if (bx.sink > SINK_MS) boxes.splice(i, 1); continue; }
        const here = map.get(key(bx.x, bx.y));
        if (!here) { bx.sink = 1; continue; }                                 // belt pulled out → sink
        bx.dir = here;
        const want = SPEED * dt, ld = leaderDist(bx, tileMap);
        const allowed = ld === Infinity ? want : Math.min(want, Math.max(0, ld - MIN_GAP));
        bx.prog += allowed;
        let guard = 0;
        while (bx.prog >= 1 && guard++ < 8) {
          // DOCK DELIVERY: an inbound crate whose tile is a qualifying stop is consumed HERE — it never
          // rides past its dock. (Outbound crates skip this — they were born ON a dock tile and ship out —
          // and no crate is ever consumed on its own birth tile.)
          const stopOwner = stops && stops[key(bx.x, bx.y)];
          if (stopOwner && bx.payload && !bx.payload.outbound && bx.spawnTile !== key(bx.x, bx.y) &&
              (!bx.payload.agentId || bx.payload.agentId === stopOwner)) {
            if (onDeliver && !bx.delivered) { bx.delivered = true; onDeliver(bx, bx.x, bx.y); }
            bx.prog = 1; bx.sink = 1; break;
          }
          let dir = bx.dir;
          const jt = junctions && junctions.get(key(bx.x, bx.y));            // a junction picks the exit lane (else straight)
          if (jt) {
            const ex = chooseExit(jt, bx, bx.x, bx.y, map, nowMs);
            if (ex === false) { bx.sink = 1; break; }                        // merge absorbed it — sink, never deliver
            if (ex) dir = ex;
          }
          const v = DIRV[dir], nx = bx.x + v[0], ny = bx.y + v[1], nd = map.get(key(nx, ny));
          if (nd) { if (nd !== dir) bx.turn0 = nowMs; bx.x = nx; bx.y = ny; bx.dir = nd; bx.prog -= 1; }
          else {                                                              // rode off the open end → deliver, then sink
            if (bx.payload && onDeliver && !bx.delivered) { bx.delivered = true; onDeliver(bx, bx.x, bx.y); }
            bx.prog = 1; bx.sink = 1; break;
          }
        }
      }
      if (boxes.length > MAX_BOXES) boxes.splice(0, boxes.length - MAX_BOXES);
    }

    /* ---------- belt art (direction + topology aware) ---------- */
    /* liveSet (optional): { "x,y": true } from Pipeline.liveTiles — tiles on a complete INTAKE→bound-BAY
       route render ENERGIZED (marching treads/chevron, blinking drive LED); everything else renders COLD
       (static treads, no flow, dark LED, dimmed) so an incomplete line visibly isn't running. Omitted →
       every tile draws live (legacy callers unchanged). The glow IS the compiled plan — truthful telemetry. */
    function drawBelts(ctx, nowMs, T, belts, liveSet) {
      if (!belts || !belts.length) return;
      _ctx = ctx; _now = nowMs;
      const map = buildMap(belts);
      for (const b of belts) {
        const live = !liveSet || !!liveSet[key(b.x, b.y)];
        // a cold tile freezes at now=0: deterministic, and every time-driven cue (tread scroll, feeder
        // hatch cycle) parks instead of marching — the line reads as powered-down machinery, not broken art
        beltTile(b.x * T, b.y * T, T, classify(map, b), live ? nowMs : 0, U.hash('belt' + key(b.x, b.y)), live);
      }
      drawMergeFx(T);   // G0.10: combine flashes over the junction tiles (under the riding boxes)
    }
    /* G0.10 MERGE SHIMMER: a merger just absorbed a crate into its buffer (or released the combined
       carrier) — flash the junction tile so K-1 boxes never just vanish. A hot amber core + an
       expanding combine ring, ~450ms decay; the carrier release burns brighter and wider. Driven only
       by real chooseExit decisions and the injected nowMs (deterministic — no ambient clock). */
    const MERGE_FX_MS = 450;
    function drawMergeFx(T) {
      if (!mergeFx.length) return;
      for (const fx of mergeFx) {
        const k = 1 - (_now - fx.t0) / MERGE_FX_MS;
        if (k <= 0) continue;
        const cx = (fx.x + 0.5) * T, cy = (fx.y + 0.5) * T;
        _ctx.save();
        _ctx.globalCompositeOperation = 'lighter';
        _ctx.globalAlpha = Math.min(1, 0.55 * k * (fx.carrier ? 1.5 : 1));
        _ctx.fillStyle = '#e8c860';
        _ctx.fillRect(cx - 3, cy - 3, 6, 6);                        // hot core
        _ctx.globalAlpha = 0.8 * k;
        _ctx.strokeStyle = fx.carrier ? '#fff0b0' : '#e8c860'; _ctx.lineWidth = 1;
        const r = 2 + (1 - k) * (fx.carrier ? 8 : 5);               // the expanding combine ring
        _ctx.beginPath(); _ctx.arc(cx, cy, r, 0, 6.2832); _ctx.stroke();
        _ctx.restore();
      }
    }
    function beltTile(X, Y, T, info, now, h, live) {
      if (live === undefined) live = true;
      const v = DIRV[info.dir], horiz = v[0] !== 0;
      px(X, Y, T, T, '#222a26'); px(X + 1, Y + 1, T - 2, T - 2, '#161c1a');   // bed + recess
      // rails along the edges PARALLEL to flow
      if (horiz) { px(X, Y, T, 1, '#46544c'); px(X, Y + T - 1, T, 1, '#46544c'); px(X + 1, Y + 1, T - 2, 1, '#0e1412'); }
      else { px(X, Y, 1, T, '#46544c'); px(X + T - 1, Y, 1, T, '#46544c'); px(X + 1, Y + 1, 1, T - 2, '#0e1412'); }
      // treads: short bars perpendicular to flow, marching in the SIGNED flow dir
      const sign = v[0] + v[1], scroll = ((Math.floor(now / 90) * sign) % 4 + 4) % 4;
      for (let s = -4; s < T; s += 4) {
        if (horiz) { const tx = X + (v[0] > 0 ? (s + scroll) : (T - 1 - s - scroll)); if (tx > X && tx < X + T - 1) px(Math.round(tx), Y + 2, 1, T - 4, '#3a4a42'); }
        else { const ty = Y + (v[1] > 0 ? (s + scroll) : (T - 1 - s - scroll)); if (ty > Y && ty < Y + T - 1) px(X + 2, Math.round(ty), T - 4, 1, '#3a4a42'); }
      }
      // deterministic wear speckle (frame-stable per tile)
      for (let k = 0; k < 3; k++) { const w = h >> (k * 4); px(X + 2 + (w % (T - 4)), Y + 2 + ((w >> 3) % (T - 4)), 1, 1, '#1d2420'); }
      if (info.kind === 'corner') beltCornerGlyph(X, Y, T, info, now);
      else if (live) beltChevron(X, Y, T, info.dir, now);   // no marching flow on a cold line
      // drive LED: blinking green = powered (on a compiled route); constant near-black = unpowered
      px(X + 1, Y + T - 2, 1, 1, live ? (((now / 300) % 1) < 0.5 ? '#3fa86a' : '#1a2a22') : '#101613');
      if (info.kind === 'source') beltSource(X, Y, T, info, now, h);
      else if (info.kind === 'sink') beltSink(X, Y, T, info);
      // cold wash LAST so the whole tile (rails, treads, source/sink furniture) reads powered-down
      if (!live) { _ctx.globalAlpha = 0.38; px(X, Y, T, T, '#060908'); _ctx.globalAlpha = 1; }
    }
    // a DIM-NEUTRAL marching chevron (no economy accent — keeps cyan/green for data/money)
    function beltChevron(X, Y, T, dir, now) {
      const cphase = (now / 220) % 1, cx = X + T / 2, cy = Y + T / 2, v = DIRV[dir];
      const reach = T * 0.3, off = (cphase - 0.5) * T * 0.5;
      _ctx.globalAlpha = 0.4; _ctx.strokeStyle = '#7a8a80'; _ctx.lineWidth = 1; _ctx.beginPath();
      if (v[0]) { const hx = cx + off * v[0]; _ctx.moveTo(hx - reach * v[0], cy - reach); _ctx.lineTo(hx, cy); _ctx.lineTo(hx - reach * v[0], cy + reach); }
      else { const hy = cy + off * v[1]; _ctx.moveTo(cx - reach, hy - reach * v[1]); _ctx.lineTo(cx, hy); _ctx.lineTo(cx + reach, hy - reach * v[1]); }
      _ctx.stroke(); _ctx.globalAlpha = 1;
    }
    // a bend: a small elbow of tread + a chevron pointing the exit way, biased to the inner corner
    function beltCornerGlyph(X, Y, T, info, now) {
      const vIn = DIRV[OPP[info.fromDir]], vOut = DIRV[info.dir];            // entry/exit headings (inward)
      const cx = X + T / 2, cy = Y + T / 2;
      _ctx.globalAlpha = 0.5; _ctx.strokeStyle = '#8a9a90'; _ctx.lineWidth = 1.5; _ctx.beginPath();
      _ctx.moveTo(cx - vIn[0] * T * 0.34, cy - vIn[1] * T * 0.34);          // from the entry edge
      _ctx.lineTo(cx, cy);                                                   // through the centre
      _ctx.lineTo(cx + vOut[0] * T * 0.34, cy + vOut[1] * T * 0.34);        // out the exit edge
      _ctx.stroke(); _ctx.globalAlpha = 1;
      // exit arrow tip
      const ax = cx + vOut[0] * T * 0.34, ay = cy + vOut[1] * T * 0.34;
      px(Math.round(ax), Math.round(ay), 1, 1, '#aebcb2');
    }
    function beltSource(X, Y, T, info, now, h) {
      const v = DIRV[info.dir], horiz = v[0] !== 0;
      const ex = X + (v[0] > 0 ? 0 : v[0] < 0 ? T - 3 : 2), ey = Y + (v[1] > 0 ? 0 : v[1] < 0 ? T - 3 : 2);
      const fw = horiz ? 3 : T - 4, fh = horiz ? T - 4 : 3;
      px(ex, ey, fw, fh, '#2a2418');                                         // dark-amber feeder frame
      const cyc = (now / 900 + (h % 7) * 0.04) % 1, open = cyc < 0.5;
      if (horiz) px(ex + 1, ey + 1, 1, fh - 2, open ? '#161210' : '#caa84a'); else px(ex + 1, ey + 1, fw - 2, 1, open ? '#161210' : '#caa84a');
      if (cyc > 0.88) px(ex, ey, fw, fh, '#e8c860');                         // "about to spawn" flash
      px(ex, ey, horiz ? fw : 1, horiz ? 1 : fh, '#3a3320');                 // hatch catch
    }
    function beltSink(X, Y, T, info) {
      const v = DIRV[info.dir], horiz = v[0] !== 0;
      const mx = X + (v[0] > 0 ? T - 4 : v[0] < 0 ? 0 : 2), my = Y + (v[1] > 0 ? T - 4 : v[1] < 0 ? 0 : 2);
      const mw = horiz ? 4 : T - 4, mh = horiz ? T - 4 : 4;
      px(mx, my, mw, mh, '#0a0d0c'); px(mx + 1, my + 1, Math.max(1, mw - 2), Math.max(1, mh - 2), '#050706');
      if (horiz) px(mx + (v[0] > 0 ? 0 : mw - 1), my, 1, mh, '#000'); else px(mx, my + (v[1] > 0 ? 0 : mh - 1), mw, 1, '#000');
      px(mx, my, horiz ? 1 : mw, horiz ? mh : 1, '#1a201c');                 // chute rim catch
    }

    /* ---------- box art ---------- */
    function drawBoxes(ctx, nowMs, T) {
      if (!boxes.length) return;
      _ctx = ctx; _now = nowMs;
      const order = boxes.slice().sort((a, b) => boxPix(a, T).py - boxPix(b, T).py);  // painter's y-sort
      for (const bx of order) {
        const base = boxPix(bx, T), m = boxMotion(bx, nowMs);
        if (m.alpha <= 0) continue;
        const cx = Math.round(base.cx + m.lx), py = Math.round(base.py + m.bob + m.ly), h32 = U.hash('' + bx.id);
        // bob-coupled contact shadow (drawn first, under the box)
        const sa = (0.30 - 0.12 * m.lift) * m.shadowMul;
        if (sa > 0) { ctx.globalAlpha = sa * m.alpha; const sw = 9 + Math.round(m.lift * 2); px(cx - (sw >> 1), Math.round(base.py) + 3, sw, 2, '#05080a'); }
        ctx.globalAlpha = m.alpha;
        // ECONOMIC role (set by world.js from real cost/outcome events) picks the art; an untyped
        // payload still rides as the cyan data cassette, so nothing about existing boxes changes.
        const role = bx.payload && bx.payload.box;
        if (role === 'ore') cargoOre(cx, py, h32, bx.dir, +bx.payload.weight || 0);
        else if (role === 'product') cargoProduct(cx, py, h32, bx.dir, +bx.payload.weight || 0);
        else if (role === 'slag') cargoSlag(cx, py, h32, bx.dir);
        else CARGO_FN[bx.payload ? 2 : cargoType(bx.id)](cx, py, h32, bx.dir);   // work-items default to cyan data cassettes
        if (bx.payload) payloadTag(cx, py, role || (bx.payload.outbound ? 'product' : 'ore'));
        ctx.globalAlpha = 1;
      }
    }
    function boxPix(bx, T) {
      const v = DIRV[bx.dir] || [0, 0];
      return { cx: (bx.x + 0.5) * T + (bx.prog - 0.5) * T * v[0], py: (bx.y + 0.5) * T + (bx.prog - 0.5) * T * v[1] };
    }

    return {
      tick, drawBelts, drawBoxes, reset, enqueueAt, dropWorkitem,
      boxCount: () => boxes.length,
      peekBoxes: () => boxes.map(b => ({ id: b.id, x: b.x, y: b.y, dir: b.dir, sink: b.sink, prog: b.prog, payload: b.payload || null }))
    };
  }

  return { create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Conveyor;
