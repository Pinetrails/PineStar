/* STARNET — stationbake.js : the GENERALIZED station bake.

   v7's world.js / render.js bake the gorgeous procedural station art (floors, tilted
   walls, rounded-corner hull arcs, lit pools, hull extrusion, lightmap) — but each was
   wired to a single hardcoded room (world.js) or the fixed v7 MAP (render.js). This module
   lifts that exact bake VOCABULARY to an ARBITRARY set of rooms + corridors, driven purely
   by the geometry object WorldModel.projectGeometry() emits.

   StationBake.bake(geo) -> { baseCv, lightCv, W, H, origin, flickers }
     baseCv  — floors + walls + hull + room lighting (blit first, under entities)
     lightCv — baked darkness with light pools carved out (blit last, over entities)
     flickers — lamp positions for the per-frame shimmer (drawGlows)

   Depends only on the global `U` (util.js: U.hash, U.shade) and the DOM canvas API. */
'use strict';

const StationBake = (() => {
  /* palette + geometry knobs — verbatim from v7 world.js/render.js */
  const pad = 7;
  const NFACE = 9, FACEW = 4;
  const wallTop = '#4a463a', wallFace = '#2b2820', wallDk = '#1d1a14', hullC = '#191712';
  const wallCap = '#7c7258';   // the lit TOP surface of a tall wall — bright on purpose: it survives the ambient bake and defines wall height at any zoom

  /* live-tunable WALL HEIGHT — same contract as LIGHT below: the CRT LAB writes these and
     re-bakes. Height only ever extrudes OUTSIDE the floor footprint (up-screen above north
     edges, down-screen below the hull, sideways past e/w edges), so no walkable tile is ever
     covered and nothing y-sorted against agents changes.
       up     = how far a room's north wall face rises above the floor seam (px)
       corUp  = same for corridors (lower → corridors read as tunnels, rooms as halls)
       skirt  = hull extrusion depth below the station silhouette (the south wall seen outside)
       side   = width of the e/w wall-top band beyond the floor edge
       capH   = thickness of the lit cap that crowns a tall wall */
  const WALL = { up: 9, corUp: 0, skirt: 32, side: 12, capH: 3 };

  /* live-tunable lighting — the CRT LAB (crtlab.js, dev-gated) writes these and calls
     World.rebake() to re-run the bake. These ARE the shipped defaults.
       ambient  = how dark the unlit station is (0=fully lit · 1=black)
       pool     = how brightly the ceiling lamps carve their light pools back out
       room/corridor/door = baseline lift inside each space type
       floor    = warmth of the additive light pool painted on the floor */
  const LIGHT = { ambient: 0.77, ambR: 7, ambG: 5, ambB: 3, pool: 1, room: 0.6, corridor: 0.42, door: 0.5, floor: 0.2 };

  /* live-tunable DEPTH FX — the CRT LAB writes these and re-bakes (same contract as LIGHT/WALL).
     Pure top-down 2D cosmetics that make the deck read a touch more 3D — never imply agent/run
     state. Baked once at bake-time, so free at runtime.
       wallShadow = strength of the soft south-cast shadow the standing north wall throws onto
                    the floor at its base (0 = off, matches the pre-depth look), and the extra
                    e/w wall-base shade so every wall foot sits in a little shadow.
       sheen      = strength of the faint vertical reflection streak baked on the floor under
                    each ceiling-light pool (polished deck read; 0 = off).
       cornerAO   = pooled darkening where two wall feet MEET (concave floor corners). The
                    linear wallShadow bands merely overlap there; this adds the radial-ish
                    corner pool that sells the room as a 3D box (0 = off).
       dither     = ordered-dither quantization of the light map's smooth alpha falloff into
                    hard stepped levels broken by a 4x4 Bayer pattern, so LIGHT reads in the
                    same chunky pixel idiom as the geometry (0 = off = smooth gradients).
       floorWear  = density/strength of hash-keyed wear on the deck — scuffs, worn patches,
                    drag marks, corridor traffic lanes (0 = off = the pristine floor). */
  const DEPTH = { wallShadow: 0.5, sheen: 0.14, cornerAO: 0.55, dither: 0.8, floorWear: 0.55 };

  const CORNER = {
    tl: { cx: 1, cy: 1, a0: Math.PI, a1: 1.5 * Math.PI },
    tr: { cx: 0, cy: 1, a0: 1.5 * Math.PI, a1: 2 * Math.PI },
    bl: { cx: 1, cy: 0, a0: 0.5 * Math.PI, a1: Math.PI },
    br: { cx: 0, cy: 0, a0: 0, a1: 0.5 * Math.PI }
  };

  /* per-bake state (a bake runs synchronously start→finish, so module locals are safe) */
  const CHUNK_PX = 384;
  const dirtyPadPx = () => pad + Math.max(WALL.skirt, WALL.up + WALL.capH + 8) + 48;   // walls reach outside the footprint — invalidate that far too
  let G, T, HR, W, H, VX, VY, CW, CH, lampPos, edges, chamferAt, extN;
  const h2 = (x, y, s) => U.hash(x + ',' + y + ',' + (s || ''));

  function spandrelPath(g, kind, ax, ay, rad) {
    const A = CORNER[kind];
    const ox = A.cx ? ax - rad : ax, oy = A.cy ? ay - rad : ay;
    g.beginPath(); g.rect(ox, oy, rad, rad); g.moveTo(ax, ay); g.arc(ax, ay, rad, A.a0, A.a1); g.closePath();
    return { ox, oy };
  }
  function eraseSpandrel(g, kind, ax, ay, rad) {
    g.save();
    const o = spandrelPath(g, kind, ax, ay, rad);
    g.clip('evenodd'); g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000'; g.fillRect(o.ox - 1, o.oy - 1, rad + 2, rad + 2);
    g.restore();
  }
  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  function translatedContext(c) {
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.translate(-VX, -VY);
    return g;
  }

  /* derive the wall edges from the zone grid (generalizes world.js's single-room IIFE).
     a boundary edge is where a zone tile faces a different/void neighbour; chamfer tiles
     are skipped (the curved pass handles them); door adjacencies become threshold edges. */
  function buildEdges() {
    edges = [];
    const G_ = G, idx = G.idx, COLS = G.COLS, ROWS = G.ROWS, zg = G.zoneGrid;
    const dirs = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const z = zg[idx(x, y)];
      if (z == null) continue;
      if (chamferAt[x + ',' + y]) continue;
      const room = !G_.isCorridor(z);
      for (const side in dirs) {
        const [dx, dy] = dirs[side];
        const nx = x + dx, ny = y + dy;
        const nz = (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) ? null : zg[idx(nx, ny)];
        if (nz === z) continue;                       // interior — no edge
        const door = nz != null && (G_.canStep(x, y, nx, ny) || G_.canStep(nx, ny, x, y));
        edges.push({ x, y, side, room, door, exterior: nz == null });
        if (side === 'n' && nz == null) extN.add(x + ',' + y);   // tiles with a TALL north face (lamp fixtures mount on it)
      }
    }
  }

  /* ---------- floor passes (per-tile base colour → paint tool just works) ---------- */
  function bakeRoomFloor(b, r) {
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    const off = U.hash(r.z) % 2;
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      const base = G.baseColorOf(r.z, x, y);
      const X = x * T, Y = y * T, n = h2(x, y, r.z);
      px(X, Y, T, T, base);
      if (n % 5 === 0) px(X, Y, T, T, 'rgba(0,0,0,0.06)');
      else if (n % 7 === 0) px(X, Y, T, T, 'rgba(255,255,255,0.025)');
      if ((x + off) % 2 === 0) px(X, Y, 1, T, U.shade(base, -0.30));
      if ((y + off) % 2 === 0) px(X, Y, T, 1, U.shade(base, -0.30));
      if ((x + off) % 2 === 0 && (y + off) % 2 === 0) px(X + 1, Y + 1, 1, 1, U.shade(base, 0.22));
      if (n % 19 === 3) {
        px(X + 2, Y + 2, T - 4, T - 4, U.shade(base, -0.25));
        for (let i = 0; i < 3; i++) px(X + 3, Y + 4 + i * 3, T - 6, 1, U.shade(base, -0.5));
      } else if (n % 23 === 5) {
        px(X + 2, Y + 2, T - 4, T - 4, U.shade(base, -0.12));
        b.strokeStyle = U.shade(base, -0.4); b.lineWidth = 1; b.strokeRect(X + 2.5, Y + 2.5, T - 5, T - 5);
        px(X + T / 2 - 2, Y + T / 2, 4, 1, U.shade(base, -0.5));
      } else if (n % 31 === 7) {
        b.fillStyle = 'rgba(0,0,0,0.13)'; b.beginPath(); b.ellipse(X + (n % 8), Y + (n % 6) + 3, 5, 3, 0, 0, 7); b.fill();
      } else if (n % 13 === 2) {
        px(X + (n % 5), Y + (n % 7) + 2, 4, 1, 'rgba(0,0,0,0.12)');
        px(X + (n % 7) + 1, Y + (n % 4) + 6, 3, 1, 'rgba(255,255,255,0.05)');
      }
    }
  }

  function bakeCorridorFloor(b, r) {
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    const vertical = (r.y2 - r.y1) > (r.x2 - r.x1);
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      const base = G.baseColorOf(r.z, x, y);
      const X = x * T, Y = y * T, n = h2(x, y, 'cor');
      px(X, Y, T, T, base);
      if (n % 6 === 0) px(X, Y, T, T, 'rgba(0,0,0,0.07)');
      px(X, Y, T, 1, U.shade(base, -0.34));
      if (n % 23 === 5) { px(X + 2, Y + 2, T - 4, T - 4, U.shade(base, -0.16)); b.strokeStyle = U.shade(base, -0.4); b.lineWidth = 1; b.strokeRect(X + 2.5, Y + 2.5, T - 5, T - 5); }
    }
    // long-axis rib bands + edge air-grilles
    b.fillStyle = 'rgba(0,0,0,0.12)';
    const x1 = r.x1 * T, y1 = r.y1 * T, rw = (r.x2 - r.x1 + 1) * T, rh = (r.y2 - r.y1 + 1) * T;
    if (vertical) for (let yy = y1 + 4; yy < y1 + rh; yy += 7) b.fillRect(x1 + 2, yy, rw - 4, 1);
    else for (let xx = x1 + 4; xx < x1 + rw; xx += 7) b.fillRect(xx, y1 + 2, 1, rh - 4);
    b.fillStyle = U.shade('#2c2924', -0.5);
    if (vertical) { for (let yy = y1 + 3; yy < y1 + rh; yy += 5) { b.fillRect(x1 + 1, yy, 1, 2); b.fillRect(x1 + rw - 2, yy, 1, 2); } }
    else { for (let xx = x1 + 3; xx < x1 + rw; xx += 5) { b.fillRect(xx, y1 + 1, 2, 1); b.fillRect(xx, y1 + rh - 2, 2, 1); } }
  }

  function bakeEdgeAO(b) {
    // base edge AO — the short shade band hugging every wall foot (verbatim legacy look)
    b.fillStyle = 'rgba(0,0,0,0.25)';
    for (const e of edges) {
      if (e.door) continue;
      const X = e.x * T, Y = e.y * T, d = e.room ? 8 : 4, ds = e.room ? 5 : 3;
      if (e.side === 'n') b.fillRect(X, Y, T, d);
      else if (e.side === 's') b.fillRect(X, Y + T - ds, T, ds);
      else if (e.side === 'w') b.fillRect(X, Y, ds, T);
      else b.fillRect(X + T - ds, Y, ds, T);
    }
    bakeWallCastShadow(b);
    bakeCornerAO(b);
  }

  /* CORNER AO — where two wall feet MEET, the linear bands above only overlap in a square;
     real light pools extra darkness INTO a concave corner. Painted as 3 nested opaque-alpha
     squares anchored at the corner point (hard 1px transitions — the station's pixel idiom,
     same reasoning as bakeWallCastShadow), largest faintest → smallest darkest, so the corner
     reads as a pooled radial-ish falloff at any zoom. Cool-black to sit with the edge AO tone.
     Only same-tile side pairs (a room's corner tile carries both edges); door seams never
     count as walls. DEPTH.cornerAO scales the whole pass; 0 = off = the pre-AO look. */
  function bakeCornerAO(b) {
    const s = Math.max(0, DEPTH.cornerAO);
    if (s <= 0.001) return;
    const cool = a => 'rgba(6,7,10,' + a.toFixed(3) + ')';
    const sides = new Map();   // 'x,y' -> which sides of this tile carry a solid (non-door) wall
    for (const e of edges) {
      if (e.door) continue;
      const k = e.x + ',' + e.y;
      let sd = sides.get(k);
      if (!sd) sides.set(k, sd = { n: false, s: false, w: false, e: false, room: e.room });
      sd[e.side] = true;
    }
    const R = [Math.round(T * 0.6), Math.round(T * 0.42), Math.round(T * 0.24)];
    const A = [0.26, 0.34, 0.42];
    for (const [k, sd] of sides) {
      const both = (sd.n || sd.s) && (sd.w || sd.e);
      if (!both) continue;
      const cx = k.indexOf(','), x = +k.slice(0, cx), y = +k.slice(cx + 1);
      const X = x * T, Y = y * T;
      const topY = Y + (sd.room ? NFACE : 5);   // floor starts below the north face (matches bakeWallCastShadow's seam)
      const put = (ax, ay, right, down) => {    // corner point + which way the squares grow
        for (let i = 0; i < R.length; i++) {
          const r = R[i], a = s * A[i];
          if (a < 0.004 || r < 2) continue;
          b.fillStyle = cool(a);
          b.fillRect(right ? ax - r : ax, down ? ay - r : ay, r, r);
        }
      };
      if (sd.n && sd.w) put(X, topY, false, false);
      if (sd.n && sd.e) put(X + T, topY, true, false);
      if (sd.s && sd.w) put(X, Y + T, false, true);
      if (sd.s && sd.e) put(X + T, Y + T, true, true);
    }
  }

  /* the big 3D cue: the STANDING north wall shades the floor at its base, as if the ceiling light
     rakes over it. A soft vertical gradient cast SOUTH (down-screen) from each north wall's floor
     seam, plus a touch more shade at the e/w wall feet so every wall foot sits in shadow. Cool-black
     to match the existing edge AO tone. Baked onto the floor at the same stage as edge AO, INSIDE the
     floor footprint only (never onto the hull skirt, which the ambient mask deliberately excludes). */
  function bakeWallCastShadow(b) {
    const s = Math.max(0, DEPTH.wallShadow);
    if (s <= 0.001) return;
    // Painted as STEPPED opaque-alpha bands (hard 1px transitions), not a smooth gradient — this
    // matches the station's own pixel idiom (see bakeRoomFloor / bakeTallNorthFace: no low-alpha
    // washes) AND keeps the bake portable to the headless canvas mock (no createLinearGradient).
    // Cool-black to sit with the existing edge AO tone. Alpha falls off south of the seam.
    const cool = a => 'rgba(6,7,10,' + a.toFixed(3) + ')';
    for (const e of edges) {
      if (e.door) continue;
      const X = e.x * T, Y = e.y * T;
      if (e.side === 'n') {
        // the floor seam of a tall north face sits inFace px below the tile top; the legacy short
        // wall (up:0) contacts the floor at the same inFace line, so seed the cast there either way.
        const inFace = e.room ? NFACE : 5;
        const seam = Y + inFace;
        const h = e.room ? 14 : 8;                       // rooms throw a taller floor shadow than corridors
        // 4 bands easing 1 → 0 in alpha over the shadow height (raised-cosine-ish falloff, discretized)
        const bands = 4, prof = [1, 0.62, 0.34, 0.14];
        const bh = Math.max(1, Math.round(h / bands));
        for (let i = 0; i < bands; i++) {
          const a = s * 0.92 * prof[i]; if (a < 0.004) continue;
          b.fillStyle = cool(a); b.fillRect(X, seam + i * bh, T, bh);
        }
      } else if (e.side === 'w') {
        // deepen the west wall foot: two inward bands so the wall base reads shaded (steps in x)
        const w = e.room ? 6 : 4, bw = Math.max(1, Math.round(w / 2));
        b.fillStyle = cool(s * 0.5); b.fillRect(X, Y, bw, T);
        b.fillStyle = cool(s * 0.22); b.fillRect(X + bw, Y, w - bw, T);
      } else if (e.side === 'e') {
        const w = e.room ? 6 : 4, bw = Math.max(1, Math.round(w / 2));
        b.fillStyle = cool(s * 0.5); b.fillRect(X + T - bw, Y, bw, T);
        b.fillStyle = cool(s * 0.22); b.fillRect(X + T - w, Y, w - bw, T);
      }
    }
  }

  /* the TALL north wall: the interior face a viewer sees when looking at the far side of a
     room. It keeps the classic NFACE px of floor-contact face BELOW the seam (unchanged, so
     props/agents hugging the top row still read right) and rises WALL.up px ABOVE it — over
     void/hull only, never over walkable floor — crowned by a lit cap + dark hull lip. */
  function bakeTallNorthFace(b, e, X, Y) {
    const room = e.room;
    const up = Math.max(0, Math.round(room ? WALL.up : WALL.corUp));
    const inFace = room ? NFACE : 5;

    // up === 0 → the EXACT legacy short wall (verbatim from the pre-tall-wall bake): a dark
    // hull cap band above the seam, the plain face + rib, the floor-contact line, the seam
    // hairline. Corridors at corUp:0 hit this path and read as they did before tall walls.
    if (up === 0) {
      const cap = room ? 4 : 2;                                        // legacy NCAP (rooms) / 2 (corridors)
      b.fillStyle = wallDk; b.fillRect(X, Y - cap, T, cap);
      b.fillStyle = wallFace; b.fillRect(X, Y, T, inFace);
      b.fillStyle = 'rgba(0,0,0,0.25)'; b.fillRect(X + 5, Y, 1, inFace);
      b.fillStyle = wallTop; b.fillRect(X, Y + inFace, T, 1);
      b.fillStyle = 'rgba(255,255,255,0.05)'; b.fillRect(X, Y, T, 1);
      return;
    }

    // up > 0 → clean standing metal plating, painted in the STATION'S OWN PIXEL IDIOM: opaque
    // colours stepped via U.shade (hard 1px transitions), a per-tile plate seam on the floor's
    // tile grid, and sparse single-pixel accents — so at 3x the face grain matches the floor
    // grain. NO low-alpha full-width washes (those read as blur next to the hard floor steps).
    const capH = Math.max(2, Math.round(WALL.capH));
    const h = up + inFace, topY = Y - up;              // all integer already (up/capH rounded, T/inFace int)
    const n = h2(e.x, e.y, 'nwall');
    // per-tile plate tone: discrete opaque jitter (±0.03..0.06), keyed on the hash so long walls
    // read as individual plates without ever crossing into a gradient
    const plate = U.shade(wallFace, ((n % 4) - 1.5) * 0.03);   // one of 4 hard tones, opaque
    // dark hull lip above the crown (the old NCAP band, pushed up with the wall)
    b.fillStyle = wallDk; b.fillRect(X, topY - capH - 2, T, 2);
    // lit crown — opaque cap band, 1px lighter top edge, 1px darker seam beneath. Kept BRIGHT:
    // after the ambient bake this continuous line defines the wall height at any zoom.
    b.fillStyle = wallCap; b.fillRect(X, topY - capH, T, capH);
    b.fillStyle = U.shade(wallCap, 0.30); b.fillRect(X, topY - capH, T, 1);          // 1px lighter top edge
    b.fillStyle = U.shade(wallCap, -0.45); b.fillRect(X, topY - 1, T, 1);            // 1px darker seam beneath
    // face: opaque stepped bands — lighter top course, base plate tone, darker foot. Hard 1px
    // transitions, exactly how bakeRoomFloor steps its values.
    b.fillStyle = plate; b.fillRect(X, topY, T, h);
    const topCourse = Math.max(2, Math.min(4, (h / 3) | 0));
    b.fillStyle = U.shade(plate, 0.10); b.fillRect(X, topY, T, topCourse);            // lit top course (opaque)
    b.fillStyle = U.shade(plate, 0.16); b.fillRect(X, topY, T, 1);                    // 1px bright course edge
    b.fillStyle = U.shade(plate, -0.22); b.fillRect(X, Y + inFace - 2, T, 2);         // 2px darker foot / floor AO
    b.fillStyle = U.shade(plate, -0.42); b.fillRect(X, Y + inFace - 1, T, 1);         // 1px hard contact shadow
    // per-tile darker plate seam at the tile boundary (aligns with the floor's tile grid — the
    // floor draws its grid at X and X+? ; this 1px seam at the left tile edge matches that pitch)
    b.fillStyle = U.shade(wallFace, -0.34); b.fillRect(X, topY, 1, h);
    // sparse single-pixel accents like the floor's (deterministic on the hash): a bright rivet
    // dot high on the plate and an occasional dark speck, both opaque, both 1px
    b.fillStyle = U.shade(plate, 0.24); b.fillRect(X + 2 + (n % 7), topY + 1 + (n % 2), 1, 1);
    if (n % 5 === 0) { b.fillStyle = U.shade(plate, -0.30); b.fillRect(X + 4 + (n % 5), topY + 3 + (n % 3), 1, 1); }
    // richer dressing only at the tall CRT-lab 'Towering' preset — the shipped up:10 stays clean
    if (up >= 18) {
      b.fillStyle = U.shade(wallFace, -0.30); b.fillRect(X, topY + ((h * 0.55) | 0), T, 1);   // opaque weld line
      if (room && n % 4 === 0) {                                                        // recessed vent panel
        b.fillStyle = '#1a1712'; b.fillRect(X + 7, topY + 4, 4, 5);
        b.fillStyle = U.shade('#1a1712', -0.4);
        for (let i = 0; i < 2; i++) b.fillRect(X + 8, topY + 5 + i * 2, 2, 1);
      } else if (n % 7 === 3) {                                                         // pale conduit drop
        b.fillStyle = U.shade(wallFace, 0.22); b.fillRect(X + 2, topY + 2, 1, h - 6);
      }
    }
    // floor-contact cap line (identical to the old look)
    b.fillStyle = wallTop; b.fillRect(X, Y + inFace, T, 1);
  }

  function bakeWalls(b) {
    for (const e of edges) {
      const X = e.x * T, Y = e.y * T;
      if (e.door) { bakeThreshold(b, e, X, Y); continue; }
      const fw = e.room ? FACEW : 2, out = e.room ? 4 : 2, face = e.room ? NFACE : 5;
      const dep = fw + 1, rib = 'rgba(0,0,0,0.25)';
      // walls only extrude OUTSIDE the tile when the neighbour is void. Interior boundaries
      // (a non-door seam to another zone) draw the face only, so the wall never smears onto
      // an adjacent room/corridor floor (v7 render.js parity).
      if (e.side === 'n') {
        if (e.exterior) { bakeTallNorthFace(b, e, X, Y); continue; }
        b.fillStyle = wallFace; b.fillRect(X, Y, T, face);
        b.fillStyle = rib; b.fillRect(X + 5, Y, 1, face);
        b.fillStyle = wallTop; b.fillRect(X, Y + face, T, 1);
        b.fillStyle = 'rgba(255,255,255,0.05)'; b.fillRect(X, Y, T, 1);
      } else if (e.side === 's') {
        b.fillStyle = wallTop; b.fillRect(X, Y + T - dep, T, 1);
        b.fillStyle = wallFace; b.fillRect(X, Y + T - fw, T, fw);
        b.fillStyle = rib; b.fillRect(X + 5, Y + T - fw, 1, fw);
        if (e.exterior) { b.fillStyle = wallDk; b.fillRect(X, Y + T, T, out); }
      } else if (e.side === 'w') {
        b.fillStyle = wallTop; b.fillRect(X + fw, Y, 1, T);
        b.fillStyle = wallFace; b.fillRect(X, Y, fw, T);
        b.fillStyle = rib; b.fillRect(X, Y + 5, fw, 1);
        if (e.exterior) {
          const side = Math.max(out, Math.round(e.room ? WALL.side : WALL.side * 0.6));
          b.fillStyle = '#2f2b20'; b.fillRect(X - 3, Y, 3, T);            // wall-top mid tone against the floor
          b.fillStyle = wallDk; b.fillRect(X - side, Y, side - 3, T);     // outer hull band
          b.fillStyle = 'rgba(0,0,0,0.35)'; b.fillRect(X - side, Y, 1, T);
        }
      } else {
        b.fillStyle = wallTop; b.fillRect(X + T - dep, Y, 1, T);
        b.fillStyle = wallFace; b.fillRect(X + T - fw, Y, fw, T);
        b.fillStyle = rib; b.fillRect(X + T - fw, Y + 5, fw, 1);
        if (e.exterior) {
          const side = Math.max(out, Math.round(e.room ? WALL.side : WALL.side * 0.6));
          b.fillStyle = '#2f2b20'; b.fillRect(X + T, Y, 3, T);
          b.fillStyle = wallDk; b.fillRect(X + T + 3, Y, side - 3, T);
          b.fillStyle = 'rgba(0,0,0,0.35)'; b.fillRect(X + T + side - 1, Y, 1, T);
        }
      }
    }
  }

  /* a doorway threshold: a recessed metal track + lit lip across the open seam */
  function bakeThreshold(b, e, X, Y) {
    const track = '#3a352c', lip = 'rgba(255,236,196,0.18)';
    if (e.side === 'n') { b.fillStyle = track; b.fillRect(X, Y - 1, T, 2); b.fillStyle = lip; b.fillRect(X, Y, T, 1); }
    else if (e.side === 's') { b.fillStyle = track; b.fillRect(X, Y + T - 1, T, 2); b.fillStyle = lip; b.fillRect(X, Y + T - 1, T, 1); }
    else if (e.side === 'w') { b.fillStyle = track; b.fillRect(X - 1, Y, 2, T); b.fillStyle = lip; b.fillRect(X, Y, 1, T); }
    else { b.fillStyle = track; b.fillRect(X + T - 1, Y, 2, T); b.fillStyle = lip; b.fillRect(X + T - 1, Y, 1, T); }
  }

  /* a vertical reflection streak on the polished deck under a ceiling light. `cx,cy` = streak
     centre, `w` ≈ its half-width. Rendered as a warm-neutral radial gradient painted into a
     TALL-NARROW rect (height ≈ 2.6×width) so the round falloff is clipped into a vertical lens —
     reads as a glossy floor highlight, not fog. Caller supplies the 'lighter' composite. Uses only
     createRadialGradient + fillRect (portable to the headless canvas mock; no scale/ellipse). */
  function bakeSheen(b, cx, cy, w) {
    const s = Math.max(0, DEPTH.sheen);
    if (s <= 0.001 || w < 2) return;
    const halfW = Math.max(2, w);
    // Build the vertical lens from THREE stacked circular radial dabs (top / mid / bright core),
    // spanning ≈2.6×width tall — no scale()/ellipse() so it bakes identically in the headless mock.
    const a0 = s * 0.5;
    const dab = (dy, rad, a) => {
      if (a < 0.004) return;
      const g = b.createRadialGradient(cx, cy + dy, 0.5, cx, cy + dy, rad);
      g.addColorStop(0, 'rgba(252,244,224,' + a.toFixed(3) + ')');
      g.addColorStop(0.6, 'rgba(252,244,224,' + (a * 0.3).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(252,244,224,0)');
      b.fillStyle = g; b.fillRect(cx - rad, cy + dy - rad, rad * 2, rad * 2);
    };
    dab(0, halfW, a0);                       // bright core
    dab(-halfW * 1.1, halfW * 0.72, a0 * 0.55);  // upper taper
    dab(halfW * 1.1, halfW * 0.72, a0 * 0.55);   // lower taper
  }

  function bakeRoomLighting(b) {
    b.globalCompositeOperation = 'lighter';
    for (const r of G.allRects) {
      if (G.isCorridor(r.z)) continue;
      const X = r.x1 * T, Y = r.y1 * T, RW = (r.x2 - r.x1 + 1) * T, RH = (r.y2 - r.y1 + 1) * T;
      const count = Math.max(1, Math.round((r.x2 - r.x1 + 1) / 7));
      const rad = Math.min(60, Math.max(30, RH * 0.85));
      for (let i = 0; i < count; i++) {
        const lx = X + RW * (i + 0.5) / count, ly = Y + T * 1.6;
        const gw = b.createRadialGradient(lx, ly, 1, lx, ly, rad * 0.7);
        gw.addColorStop(0, 'rgba(250,236,206,' + LIGHT.floor + ')'); gw.addColorStop(0.6, 'rgba(250,236,206,' + (LIGHT.floor * 0.32).toFixed(3) + ')'); gw.addColorStop(1, 'rgba(250,236,206,0)');
        b.fillStyle = gw; b.fillRect(Math.max(X, lx - rad * 0.7), Y, Math.min(rad * 1.4, RW), Math.min(rad * 1.2, RH));
        // FLOOR SHEEN (Slice 2): a faint vertical reflection streak on the deck below the pool, as if
        // the polished plating catches the ceiling light. Narrow (≈40% pool width), taller than wide,
        // additive + very low alpha, warm-neutral like the pool. Drawn under the same 'lighter' pass.
        bakeSheen(b, lx, ly + T * 0.9, rad * 0.34);
        lampPos.push({ x: lx, y: ly, r: rad * 1.4 });
      }
    }
    // tiny sheen under each doorway light spill (the threshold catches a little floor gloss too)
    for (const [x1, y1, x2, y2] of (G.doorDefs || [])) {
      bakeSheen(b, (x1 + x2 + 1) / 2 * T, (y1 + y2 + 1) / 2 * T + T * 0.4, T * 0.4);
    }
    b.globalCompositeOperation = 'source-over';
    for (const r of G.allRects) {
      if (G.isCorridor(r.z)) continue;
      const X = r.x1 * T, RW = (r.x2 - r.x1 + 1) * T;
      const count = Math.max(1, Math.round((r.x2 - r.x1 + 1) / 7));
      for (let i = 0; i < count; i++) {
        const lx = X + RW * (i + 0.5) / count;
        // when the tile behind the fixture carries a TALL exterior face, mount the flood
        // high on that wall (just under the crown); a door/interior seam keeps the old spot
        const up = Math.round(WALL.up);
        const tall = up > 0 && extN.has(Math.floor(lx / T) + ',' + r.y1);
        const fy = tall ? r.y1 * T - up + 2 : r.y1 * T + 1;   // just under the crown when tall; legacy spot at up:0
        b.fillStyle = '#6a6253'; b.fillRect(Math.round(lx) - 4, fy, 8, 2);
        b.fillStyle = 'rgba(255,255,255,0.55)'; b.fillRect(Math.round(lx) - 3, fy, 6, 1);
      }
    }
  }

  /* corridor ceiling lights + cable run — feeds lampPos for the lightmap carve */
  function bakeCorridorDressing(b) {
    for (const r of G.allRects) {
      if (!G.isCorridor(r.z)) continue;
      const vertical = (r.y2 - r.y1) > (r.x2 - r.x1);
      const cx = (r.x1 + r.x2 + 1) / 2 * T, cy = (r.y1 + r.y2 + 1) / 2 * T;
      b.globalCompositeOperation = 'lighter';
      const pool = (lx, ly) => {
        const g = b.createRadialGradient(lx, ly, 1, lx, ly, 20);
        g.addColorStop(0, 'rgba(220,230,236,0.10)'); g.addColorStop(1, 'rgba(220,230,236,0)');
        b.fillStyle = g; b.fillRect(lx - 20, ly - 20, 40, 40);
        lampPos.push({ x: lx, y: ly, r: 30 });
      };
      if (vertical) for (let y = r.y1 + 1; y <= r.y2; y += 4) pool(cx, (y + 0.5) * T);
      else for (let x = r.x1 + 1; x <= r.x2; x += 4) pool((x + 0.5) * T, cy);
      b.globalCompositeOperation = 'source-over';
      // fixture caps + a coloured cable run on the wall side
      b.fillStyle = '#5b6066';
      if (vertical) for (let y = r.y1 + 1; y <= r.y2; y += 4) b.fillRect(Math.round(cx) - 3, Math.round((y + 0.5) * T) - 1, 6, 2);
      else for (let x = r.x1 + 1; x <= r.x2; x += 4) b.fillRect(Math.round((x + 0.5) * T) - 3, Math.round(cy) - 1, 6, 2);
      b.fillStyle = '#a3402e';
      if (vertical) b.fillRect(r.x1 * T + 2, r.y1 * T + 2, 1, (r.y2 - r.y1 + 1) * T - 4);
      else b.fillRect(r.x1 * T + 2, r.y1 * T + 2, (r.x2 - r.x1 + 1) * T - 4, 1);
    }
  }

  function bakeHullExtrusion(b) {
    const skirt = Math.max(4, Math.round(WALL.skirt));
    // vertical working margin: a footprint whose bottom edge sits just ABOVE this viewport
    // must still drop its skirt INTO it (and one ending just below must not lose its lip),
    // so the silhouette canvases are taller than the viewport by the full skirt reach.
    const M = skirt + 4;
    const sil = canvas(CW, CH + M * 2);
    const g = sil.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.translate(-VX, -(VY - M));
    g.fillStyle = '#fff';
    for (const r of G.allRects) g.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    for (const [ccx, ccy, kind] of G.chamfers) { const A = CORNER[kind]; eraseSpandrel(g, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, HR); }
    const f = canvas(CW, CH + M * 2);
    const fg = f.getContext('2d');
    const tmp = canvas(CW, CH + M * 2);
    const tg = tmp.getContext('2d');
    const stamp = (dy, c) => {
      tg.clearRect(0, 0, CW, CH + M * 2); tg.drawImage(sil, 0, dy);
      tg.globalCompositeOperation = 'source-in'; tg.fillStyle = c; tg.fillRect(0, 0, CW, CH + M * 2);
      tg.globalCompositeOperation = 'source-over'; fg.drawImage(tmp, 0, 0);
    };
    // the tall exterior wall seen from outside: banded panels darkening toward the void
    // (renders at these raw tones — the ambient mask deliberately stops at the floor line)
    stamp(skirt, '#0b0a07');
    stamp(skirt - 1, '#100e09');
    stamp(Math.max(3, Math.round(skirt * 0.72)), '#16130d');
    stamp(Math.max(2, Math.round(skirt * 0.45)), '#1f1b12');
    stamp(3, '#2a251a');
    stamp(1, '#3f3a2c');
    fg.globalCompositeOperation = 'destination-out'; fg.drawImage(sil, 0, 0);
    fg.globalCompositeOperation = 'source-atop';
    fg.fillStyle = 'rgba(0,0,0,0.35)';
    for (let x = 5 - (VX % 28); x < CW; x += 28) fg.fillRect(x, 0, 1, CH + M * 2);
    fg.globalCompositeOperation = 'source-over';
    b.globalCompositeOperation = 'destination-over';
    b.drawImage(f, VX, VY - M);
    b.globalCompositeOperation = 'source-over';
  }

  /* ORDERED DITHER — the light map is the one surface still painted in smooth alpha falloff,
     which reads soft/"digital" against the hard-stepped floors and walls. This pass quantizes
     its alpha into a few hard levels and breaks each transition with a 4x4 Bayer checker, so
     the LIGHTING speaks the same chunky pixel dialect as the geometry. Rules that keep the
     chunk cache honest (stationbake.chunk.test.js asserts chunk↔monolithic pixel parity):
       - the Bayer threshold is keyed on WORLD pixel coords (canvas-local + VX/VY), so a pixel
         dithers identically no matter which chunk viewport bakes it;
       - contexts that can't read pixels back (the headless canvas mock) skip the pass — both
         bake paths skip together, so parity holds there too.
     DEPTH.dither = mix between the smooth original and the fully dithered result (0 = off). */
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function ditherLight(L, w, h) {
    const k = Math.max(0, Math.min(1, DEPTH.dither));
    if (k <= 0.001) return;
    if (typeof L.getImageData !== 'function' || typeof L.putImageData !== 'function') return;
    const img = L.getImageData(0, 0, w, h);
    const d = img.data;
    const STEPS = 5;   // alpha quantized to 6 hard values (0, 51, 102 … 255)
    for (let y = 0; y < h; y++) {
      const row = ((y + VY) & 3) << 2;
      for (let x = 0; x < w; x++) {
        const i = ((y * w + x) << 2) + 3;
        const a = d[i];
        if (!a || a === 255) continue;
        const t = (BAYER4[row | ((x + VX) & 3)] + 0.5) / 16;
        const q = Math.min(STEPS, Math.floor((a / 255) * STEPS + t)) * (255 / STEPS);
        d[i] = Math.round(a + (q - a) * k);
      }
    }
    L.putImageData(img, 0, 0);
  }

  function buildLightMap() {
    const lightCv = canvas(CW, CH);
    const L = translatedContext(lightCv);
    // darker ambient: the station leans on its OWN lights (the lamp cuts below punch brighter
    // pools out of this). Built as an opaque MASK drawn once at LIGHT.ambient alpha, so the
    // per-rect fills UNION instead of stacking — overlapping footprints (and the new tall-wall
    // reach above/below them) never double-darken.
    const capH = Math.max(2, Math.round(WALL.capH));
    const upReach = r => Math.round((G.isCorridor(r.z) ? WALL.corUp : WALL.up) + capH + 4);
    // the raised north faces sit under the ambient like the rest of the interior (lamp cuts
    // give them life); the hull SKIRT below stays OUTSIDE the mask — it hangs in void where
    // no lamp reaches, so it renders at its baked tones (else it fades to nothing).
    const mask = canvas(CW, CH);
    const mg = mask.getContext('2d');
    mg.imageSmoothingEnabled = false;
    mg.translate(-VX, -VY);
    mg.fillStyle = 'rgb(' + LIGHT.ambR + ',' + LIGHT.ambG + ',' + LIGHT.ambB + ')';
    for (const r of G.allRects) {
      const u = upReach(r);
      mg.fillRect(r.x1 * T - pad, r.y1 * T - pad - u, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2 + u);
    }
    for (const [ccx, ccy, kind] of G.chamfers) { const A = CORNER[kind]; eraseSpandrel(mg, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, T + pad); }
    L.globalAlpha = LIGHT.ambient;
    L.drawImage(mask, VX, VY);
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'destination-out';
    const cut = (x, y, r, a) => {
      const g = L.createRadialGradient(x, y, 1, x, y, r);
      g.addColorStop(0, 'rgba(0,0,0,' + a + ')'); g.addColorStop(0.55, 'rgba(0,0,0,' + a * 0.45 + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
      L.fillStyle = g; L.fillRect(x - r, y - r, r * 2, r * 2);
    };
    for (const r of G.allRects) {
      const X = r.x1 * T, Y = r.y1 * T, RW = (r.x2 - r.x1 + 1) * T, RH = (r.y2 - r.y1 + 1) * T;
      if (G.isCorridor(r.z)) { cut(X + RW / 2, Y + RH / 2, Math.max(RW, RH) * 0.5, LIGHT.corridor); continue; }
      const n = Math.max(1, Math.round(RW / (RH * 1.4)));
      for (let i = 0; i < n; i++) cut(X + RW * (i + 0.5) / n, Y + RH * 0.42, Math.max(RH * 0.78, RW / n * 0.62), LIGHT.room);
    }
    for (const l of lampPos) cut(l.x, l.y, l.r, LIGHT.pool);   // lamps punch bright pools out of the darker ambient → the lights carry the room
    // doorway light spill so corridors and rooms read as connected
    for (const [x1, y1, x2, y2] of G.doorDefs) cut((x1 + x2 + 1) / 2 * T, (y1 + y2 + 1) / 2 * T, T * 1.6, LIGHT.door);
    L.globalCompositeOperation = 'source-over';
    ditherLight(L, lightCv.width, lightCv.height);
    const flickers = [];
    for (let i = 0; i < lampPos.length; i += 2) flickers.push(lampPos[i]);
    return { lightCv, flickers };
  }

  function buildBase() {
    const baseCv = canvas(CW, CH);
    const b = translatedContext(baseCv);

    // hull plate behind ROOMS first (notches between distant rooms show stars)
    const plate = r => b.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    b.fillStyle = hullC;
    for (const r of G.allRects) if (!G.isCorridor(r.z)) plate(r);

    // chamfer hull spandrel erase + curved rim — BEFORE corridor connectors, so a corridor kissing a
    // room's rounded corner keeps its hull (v7 render.js ordering: corridors drawn after the erase)
    for (const [ccx, ccy, kind] of G.chamfers) {
      const A = CORNER[kind], ax = (ccx + A.cx) * T, ay = (ccy + A.cy) * T;
      eraseSpandrel(b, kind, ax, ay, HR);
      b.strokeStyle = '#28241b'; b.lineWidth = 2; b.beginPath(); b.arc(ax, ay, HR - 2, A.a0, A.a1); b.stroke();
    }

    // hull plate behind CORRIDORS (connectors stay intact through the corner erase)
    b.fillStyle = hullC;
    for (const r of G.allRects) if (G.isCorridor(r.z)) plate(r);

    // panel seam grid over all hull pixels
    b.globalCompositeOperation = 'source-atop';
    b.strokeStyle = '#231f17'; b.lineWidth = 1;
    for (let x = 5; x < W; x += 28) { b.beginPath(); b.moveTo(x + .5, 0); b.lineTo(x + .5, H); b.stroke(); }
    for (let y = 9; y < H; y += 26) { b.beginPath(); b.moveTo(0, y + .5); b.lineTo(W, y + .5); b.stroke(); }
    b.globalCompositeOperation = 'source-over';

    // riveted rim + bolts PER footprint — each room/corridor frames itself, so the void between
    // distant (or mid-build, not-yet-connected) rooms stays open instead of one rim crossing space
    b.lineWidth = 2;
    for (const r of G.allRects) {
      const x1 = r.x1 * T - pad, y1 = r.y1 * T - pad, x2 = (r.x2 + 1) * T + pad, y2 = (r.y2 + 1) * T + pad;
      b.strokeStyle = '#28241b'; b.strokeRect(x1 + 1, y1 + 1, x2 - x1 - 2, y2 - y1 - 2);
      b.fillStyle = '#302b21';
      for (let x = x1 + 6; x < x2; x += 18) { b.fillRect(x, y1 + 2, 2, 2); b.fillRect(x, y2 - 4, 2, 2); }
      for (let y = y1 + 6; y < y2; y += 18) { b.fillRect(x1 + 2, y, 2, 2); b.fillRect(x2 - 4, y, 2, 2); }
    }

    // floors
    for (const r of G.allRects) (G.isCorridor(r.z) ? bakeCorridorFloor : bakeRoomFloor)(b, r);
    bakeEdgeAO(b);
    bakeCorridorDressing(b);
    bakeWalls(b);
    bakeRoomLighting(b);

    // chamfer floor-cut + curved interior wall pass
    for (const [ccx, ccy, kind] of G.chamfers) {
      const X = ccx * T, Y = ccy * T, A = CORNER[kind], ax = X + A.cx * T, ay = Y + A.cy * T;
      b.save(); spandrelPath(b, kind, ax, ay, T); b.clip('evenodd');
      b.fillStyle = hullC; b.fillRect(X - 1, Y - 1, T + 2, T + 2); b.restore();
      b.lineWidth = 4.5; b.strokeStyle = wallDk; b.beginPath(); b.arc(ax, ay, T + 2.25, A.a0, A.a1); b.stroke();
      b.lineWidth = 5; b.strokeStyle = wallFace; b.beginPath(); b.arc(ax, ay, T - 2.5, A.a0, A.a1); b.stroke();
      b.lineWidth = 1; b.strokeStyle = 'rgba(0,0,0,0.25)';
      for (let k = 1; k <= 2; k++) {
        const ang = A.a0 + (A.a1 - A.a0) * k / 3;
        b.beginPath();
        b.moveTo(ax + Math.cos(ang) * (T - 5), ay + Math.sin(ang) * (T - 5));
        b.lineTo(ax + Math.cos(ang) * T, ay + Math.sin(ang) * T); b.stroke();
      }
      b.lineWidth = 2; b.strokeStyle = '#28241b'; b.beginPath(); b.arc(ax, ay, HR - 2, A.a0, A.a1); b.stroke();
      b.lineWidth = 1; b.strokeStyle = wallTop; b.beginPath(); b.arc(ax, ay, T - 5.5, A.a0, A.a1); b.stroke();

      // TALL WALL over a curved top corner: sweep the interior wall arc up-screen, easing from
      // full height at the north end down to zero at the side end (side walls carry no face),
      // so the raised north wall flows around the chamfer instead of stopping dead at it.
      if ((kind === 'tl' || kind === 'tr') && WALL.up > 0) {
        const R = T - 0.5, up = Math.round(WALL.up), capH = Math.max(2, Math.round(WALL.capH));
        const steps = Math.max(12, Math.ceil(R * 1.4));
        const pt = tt => {   // tt: 0 at the side end of the arc → 1 at the north end
          const ang = kind === 'tl' ? A.a0 + (A.a1 - A.a0) * tt : A.a1 - (A.a1 - A.a0) * tt;
          const k = Math.pow(Math.sin(tt * Math.PI / 2), 1.5) * up;
          return [ax + Math.cos(ang) * R, ay + Math.sin(ang) * R, k];
        };
        // Rasterize the SAME arc+taper curve (same R, ang, k) into per-COLUMN integer fills —
        // no fractional rects, no stroked polylines (those AA'd → blurry). Oversample the arc so
        // every integer screen-x the curve passes through gets a column; per column keep the
        // highest crown top the curve reaches there, then draw crisp pixel-stair fills.
        const cols = new Map();   // ix -> { top, base }  (top = lowest y the FACE top reaches; base = floor contact)
        const fine = steps * 4;
        for (let i = 0; i <= fine; i++) {
          const [px, py, k] = pt(i / fine);
          const ix = Math.round(px), top = Math.round(py - k), base = Math.round(py);
          const c = cols.get(ix);
          if (!c) cols.set(ix, { top, base });
          else { if (top < c.top) c.top = top; if (base > c.base) c.base = base; }
        }
        for (const [ix, c] of cols) {
          const faceH = c.base - c.top; if (faceH <= 0) continue;
          b.fillStyle = wallFace; b.fillRect(ix, c.top, 1, faceH + 1);            // face column, integer
          // crown = opaque cap pixels stepped up the curve (pixel stairs, not a stroke)
          b.fillStyle = wallCap; b.fillRect(ix, c.top - capH, 1, capH);
          b.fillStyle = U.shade(wallCap, 0.30); b.fillRect(ix, c.top - capH, 1, 1); // 1px lit top edge
          b.fillStyle = U.shade(wallCap, -0.45); b.fillRect(ix, c.top - 1, 1, 1);   // 1px darker seam beneath crown
        }
      }
    }

    // faint room name plates (the v7 floor-code stencil, generalized)
    b.font = '7px monospace'; b.fillStyle = 'rgba(255,255,255,0.07)'; b.textAlign = 'left';
    for (const id of G.ROOM_IDS) {
      const z = G.zones[id]; if (!z) continue;
      const nm = (G.nameOf(id) || '').toUpperCase();
      if (nm) b.fillText(nm, (z.x2 - 2) * T - 4, (z.y2 + 1) * T - 4);
    }

    bakeHullExtrusion(b);
    b.setTransform(1, 0, 0, 1, 0, 0);
    return baseCv;
  }

  /* ---------- public ---------- */
  function setBakeState(geo, viewport) {
    // belt-and-suspenders: never allocate gigabytes for a malformed/oversized imported geometry
    // (the model's MAX_SPAN normally keeps this far below the ceiling).
    if (geo.W * geo.H > 16e6) {
      return false;
    }
    G = geo; T = geo.TILE; HR = T + pad; W = geo.W; H = geo.H;
    VX = viewport ? viewport.x : 0; VY = viewport ? viewport.y : 0;
    CW = viewport ? viewport.w : W; CH = viewport ? viewport.h : H;
    lampPos = []; chamferAt = {}; extN = new Set();
    for (const [cx, cy, k] of geo.chamfers) chamferAt[cx + ',' + cy] = k;
    buildEdges();
    return true;
  }

  function blankBake(geo) {
    const blank = canvas(1, 1);
    return { baseCv: blank, lightCv: blank, W: geo.W, H: geo.H, origin: geo.origin, flickers: [] };
  }

  function bakeViewport(geo, viewport) {
    if (!setBakeState(geo, viewport)) return blankBake(geo);
    const baseCv = buildBase();
    const { lightCv, flickers } = buildLightMap();
    return { baseCv, lightCv, W: geo.W, H: geo.H, origin: geo.origin, flickers, viewport: viewport || { x: 0, y: 0, w: geo.W, h: geo.H } };
  }

  function bake(geo) {
    return bakeViewport(geo, null);
  }

  const chunkKey = (cx, cy) => cx + ',' + cy;
  function chunkGrid(geo) {
    return {
      cols: Math.max(1, Math.ceil(geo.W / CHUNK_PX)),
      rows: Math.max(1, Math.ceil(geo.H / CHUNK_PX)),
      chunkPx: CHUNK_PX
    };
  }
  function chunkViewport(geo, cx, cy) {
    const x = cx * CHUNK_PX, y = cy * CHUNK_PX;
    return { x, y, w: Math.min(CHUNK_PX, geo.W - x), h: Math.min(CHUNK_PX, geo.H - y) };
  }
  function dirtyRectToLocalPx(geo, r) {
    const t = geo.TILE;
    return {
      x1: Math.max(0, (r.x1 - geo.origin.tx) * t - dirtyPadPx()),
      y1: Math.max(0, (r.y1 - geo.origin.ty) * t - dirtyPadPx()),
      x2: Math.min(geo.W, (r.x2 + 1 - geo.origin.tx) * t + dirtyPadPx()),
      y2: Math.min(geo.H, (r.y2 + 1 - geo.origin.ty) * t + dirtyPadPx())
    };
  }
  function dirtyChunks(geo, dirtyRects) {
    const grid = chunkGrid(geo);
    if (!dirtyRects || !dirtyRects.length) {
      const all = [];
      for (let cy = 0; cy < grid.rows; cy++) for (let cx = 0; cx < grid.cols; cx++) all.push({ cx, cy, key: chunkKey(cx, cy) });
      return all;
    }
    const seen = new Set(), out = [];
    for (const r of dirtyRects) {
      const px = dirtyRectToLocalPx(geo, r);
      const x0 = Math.max(0, Math.floor(px.x1 / CHUNK_PX));
      const y0 = Math.max(0, Math.floor(px.y1 / CHUNK_PX));
      const x1 = Math.min(grid.cols - 1, Math.floor(Math.max(0, px.x2 - 1) / CHUNK_PX));
      const y1 = Math.min(grid.rows - 1, Math.floor(Math.max(0, px.y2 - 1) / CHUNK_PX));
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const key = chunkKey(cx, cy);
        if (!seen.has(key)) { seen.add(key); out.push({ cx, cy, key }); }
      }
    }
    return out;
  }
  function rectIntersectsChunk(r, c) {
    if (!r) return true;
    return c.x < r.x + r.w && c.x + c.w > r.x && c.y < r.y + r.h && c.y + c.h > r.y;
  }
  function chunkRefsForRect(geo, rect) {
    const grid = chunkGrid(geo);
    if (!rect) return null;
    const x0 = Math.max(0, Math.floor(rect.x / CHUNK_PX));
    const y0 = Math.max(0, Math.floor(rect.y / CHUNK_PX));
    const x1 = Math.min(grid.cols - 1, Math.floor(Math.max(0, rect.x + rect.w - 1) / CHUNK_PX));
    const y1 = Math.min(grid.rows - 1, Math.floor(Math.max(0, rect.y + rect.h - 1) / CHUNK_PX));
    const out = [];
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) out.push({ cx, cy, key: chunkKey(cx, cy) });
    return out;
  }
  function visibleChunks(baked, rect) {
    if (!baked || !baked.chunked) return [];
    return baked.chunks.filter(c => rectIntersectsChunk(rect, c));
  }
  function expectedChunkKeysForRect(baked, rect) {
    if (!baked || !baked.chunked || !rect) return [];
    const cols = Math.max(1, Math.ceil(baked.W / CHUNK_PX));
    const rows = Math.max(1, Math.ceil(baked.H / CHUNK_PX));
    const x0 = Math.max(0, Math.floor(rect.x / CHUNK_PX));
    const y0 = Math.max(0, Math.floor(rect.y / CHUNK_PX));
    const x1 = Math.min(cols - 1, Math.floor(Math.max(0, rect.x + rect.w - 1) / CHUNK_PX));
    const y1 = Math.min(rows - 1, Math.floor(Math.max(0, rect.y + rect.h - 1) / CHUNK_PX));
    const keys = [];
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) keys.push(chunkKey(cx, cy));
    return keys;
  }
  function missingVisibleChunks(baked, rect) {
    if (!baked || !baked.chunked || !rect) return [];
    return expectedChunkKeysForRect(baked, rect).filter(k => !baked.chunkMap.has(k));
  }
  function sameChunkFrame(prev, geo) {
    return !!(prev && prev.chunked && prev.W === geo.W && prev.H === geo.H && prev.origin &&
      prev.origin.tx === geo.origin.tx && prev.origin.ty === geo.origin.ty && prev.chunkPx === CHUNK_PX);
  }
  function bakeChunk(geo, cx, cy, usedAt) {
    const viewport = chunkViewport(geo, cx, cy);
    const baked = bakeViewport(geo, viewport);
    return { key: chunkKey(cx, cy), cx, cy, x: viewport.x, y: viewport.y, w: viewport.w, h: viewport.h,
      baseCv: baked.baseCv, lightCv: baked.lightCv, flickers: baked.flickers, usedAt: usedAt || 0 };
  }
  function pruneChunkMap(chunkMap, maxRetainedChunks, requiredKeys) {
    if (!maxRetainedChunks || chunkMap.size <= maxRetainedChunks) return { evicted: 0 };
    const required = requiredKeys || new Set();
    const victims = Array.from(chunkMap.values()).filter(c => !required.has(c.key))
      .sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0));
    let evicted = 0;
    while (chunkMap.size > maxRetainedChunks && victims.length) {
      const c = victims.shift();
      chunkMap.delete(c.key);
      evicted++;
    }
    return { evicted };
  }
  function uniqueFlickers(chunks) {
    const seen = new Set(), out = [];
    for (const c of chunks) for (const f of (c.flickers || [])) {
      const key = Math.round(f.x * 1000) + ',' + Math.round(f.y * 1000) + ',' + Math.round(f.r * 1000);
      if (!seen.has(key)) { seen.add(key); out.push(f); }
    }
    return out;
  }
  function bakeIncremental(geo, previous, dirtyRects, opts) {
    opts = opts || {};
    const reuse = sameChunkFrame(previous, geo);
    const generation = reuse ? (previous.generation || 0) + 1 : 1;
    const chunkMap = reuse ? new Map(previous.chunkMap) : new Map();
    const visible = chunkRefsForRect(geo, opts.visibleRect);
    const visibleKeys = new Set((visible || []).map(c => c.key));
    let dirty = (reuse && opts.onlyMissingVisible) ? [] : (reuse ? dirtyChunks(geo, dirtyRects) : dirtyChunks(geo, []));
    if (!reuse && visible) dirty = dirty.filter(d => visibleKeys.has(d.key));
    for (const d of dirty) chunkMap.set(d.key, bakeChunk(geo, d.cx, d.cy, generation));
    const requiredKeys = new Set(dirty.map(d => d.key));
    let visibleBaked = 0;
    for (const v of (visible || [])) {
      requiredKeys.add(v.key);
      const existing = chunkMap.get(v.key);
      if (existing) existing.usedAt = generation;
      else {
        chunkMap.set(v.key, bakeChunk(geo, v.cx, v.cy, generation));
        visibleBaked++;
      }
    }
    const pruned = pruneChunkMap(chunkMap, opts.maxRetainedChunks, requiredKeys);
    const chunks = Array.from(chunkMap.values()).sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
    return {
      chunked: true, chunks, chunkMap, chunkPx: CHUNK_PX, generation,
      W: geo.W, H: geo.H, origin: geo.origin, flickers: uniqueFlickers(chunks),
      stats: { chunkCount: chunks.length, rebakedChunks: dirty.length + visibleBaked, reusedChunks: reuse ? Math.max(0, chunks.length - dirty.length - visibleBaked) : 0,
        dirtyChunks: dirty.map(d => d.key), visibleChunks: visible ? Array.from(visibleKeys) : null,
        evictedChunks: pruned.evicted, fullReset: !reuse }
    };
  }

  function drawBase(ctx, baked, ox, oy, visibleRect) {
    if (baked && baked.chunked) for (const c of visibleChunks(baked, visibleRect)) ctx.drawImage(c.baseCv, ox + c.x, oy + c.y);
    else if (baked && baked.baseCv) ctx.drawImage(baked.baseCv, ox, oy);
  }
  function drawLight(ctx, baked, ox, oy, visibleRect) {
    if (baked && baked.chunked) for (const c of visibleChunks(baked, visibleRect)) ctx.drawImage(c.lightCv, ox + c.x, oy + c.y);
    else if (baked && baked.lightCv) ctx.drawImage(baked.lightCv, ox, oy);
  }

  return { bake, bakeIncremental, dirtyChunks, visibleChunks, missingVisibleChunks, drawBase, drawLight, CHUNK_PX, LIGHT, WALL, DEPTH };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StationBake;
