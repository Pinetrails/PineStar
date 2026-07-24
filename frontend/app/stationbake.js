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

  /* PER-ROOM WALL PALETTE. The four constants above used to paint every wall in the station one
     colour — a cobalt bridge and a rust foundry had identical brown-grey walls. The interior
     faces are derived per room now, from that room's wall hue (which itself defaults to the
     room's FLOOR hue, so a station is varied the moment it's built). The HULL tones stay global
     on purpose: the outside of the station is one shell, the inside of each room is decorated.
     Offsets were fitted so a `hull`-hued room reproduces the classic constants near-exactly. */
  const WALL_TONE = { face: -0.15, top: 0.10, cap: 0.35 };
  let wallPalCache = null;
  function wallPal(z) {
    let p = wallPalCache && wallPalCache.get(z);
    if (p) return p;
    const base = (G && G.wallBaseOf && G.wallBaseOf(z)) || '#33302a';
    p = { base, face: U.shade(base, WALL_TONE.face), top: U.shade(base, WALL_TONE.top), cap: U.shade(base, WALL_TONE.cap) };
    if (!wallPalCache) wallPalCache = new Map();
    wallPalCache.set(z, p);
    return p;
  }
  const wallMatOf = z => {
    const m = G && G.wallMatOf ? G.wallMatOf(z) : null;
    return WALL_RECIPES[m] ? m : 'plating';
  };

  /* live-tunable WALL HEIGHT — same contract as LIGHT below: the CRT LAB writes these and
     re-bakes. Height only ever extrudes OUTSIDE the floor footprint (up-screen above north
     edges, down-screen below the hull, sideways past e/w edges), so no walkable tile is ever
     covered and nothing y-sorted against agents changes.
       up     = how far a room's north wall face rises above the floor seam (px)
       corUp  = same for corridors (lower → corridors read as tunnels, rooms as halls)
       skirt  = hull extrusion depth below the station silhouette (the south wall seen outside)
       side   = width of the e/w wall-top band beyond the floor edge
       capH   = thickness of the lit cap that crowns a tall wall */
  const WALL = { up: 14, corUp: 0, skirt: 32, side: 12, capH: 3 };   // up 9→14 (2026-07-24): the wall materials need surface to live on
  /* VIEWPORT holes punched by the wall pass this bake. buildLightMap cuts the ambient mask over
     them — without that the sky behind a window renders at the interior's 23% and reads as a
     black pane. Reset per bake alongside the wall palette cache. */
  let viewportRects = [];

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
                    drag marks, corridor traffic lanes (0 = off = the pristine floor).
       floorDetail= amplitude of the V2 floor-material pass (deck plates, seams, rivets,
                    per-kind recipes, perimeter trim). Scales every U.shade delta the floor
                    draws, so 0 = a flat unadorned deck, 1 = shipped, >1 = overdriven. */
  const DEPTH = { wallShadow: 0.5, sheen: 0.14, cornerAO: 0.55, dither: 0.15, floorWear: 0.55, floorDetail: 1, wallDetail: 1 };   // dither 0.15 = Andrew's dialed value (2026-07-13 crtlab COPY VALUES)

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
        edges.push({ x, y, z, side, room, door, exterior: nz == null });   // z = the zone this wall belongs to (its room owns the wall palette)
        if (side === 'n' && nz == null) extN.add(x + ',' + y);   // tiles with a TALL north face (lamp fixtures mount on it)
      }
    }
  }

  /* ---------- floor passes (per-tile base colour → paint tool just works) ----------

     V2 FLOOR MATERIALS. The deck is the biggest surface on screen, so it carries a real
     material vocabulary instead of the old uniform 1-tile grid. The two axes are separate
     by contract: room KIND picks the material RECIPE, the per-tile base colour (floor style
     + deck paint overrides) stays the HUE — every mark below derives from THIS tile's own
     base via U.shade, so a painted tile renders its material in its painted colour. All
     marks are keyed on world tile coords (chunk↔monolithic parity) and painted as opaque
     hard-stepped pixels (the station idiom; headless-mock safe). Recipes:
       plate (HAB/default)     — 2×2 deck plates: shared per-plate tone, dark seam + catch-
                                 light, corner rivets, brushed hairline grain.
       panel (BRIDGE)          — long 4×1 panel strips with longitudinal grain, no rivets:
                                 a finished command-deck read.
       tile  (LAB)             — clean 2×2 gloss checker on dark grout, sparse specular
                                 ticks, no grime/stains.
       tread (FOUNDRY/STORAGE) — heavy plate + stamped tread ticks, weld lines, rivets.
       soft  (QUARTERS)        — wide 3×2 low-contrast plates with warm matted lifts.
     Every room also gets a PERIMETER TRIM COURSE (a darker border course where floor meets
     wall, catch-lit on its room-facing edge) and pale guide ticks across door thresholds.
     DEPTH.floorDetail scales every delta the material draws; DEPTH.floorWear rides on top.

     V4 adds four decks that deliberately DON'T read as the old station — the material axis is
     user-chosen now (WorldModel.FLOOR_MATERIALS → REFIT ▧ PAINT), not just a per-kind default:
       grate — open catwalk mesh: top-lit bars over a dark void, substructure glimpsed below.
       hex   — honeycomb cells on an offset lattice: advanced-tech, nothing else here is non-rectilinear.
       plank — staggered wood boards: per-board tone, grain hairlines, occasional knot.
       turf  — hydroponic growth: pure blade scatter, NO lattice at all. The absence of a grid
               is the whole point; it is what separates a grown surface from a built one. */
  const MAT_BY_KIND = { hab: 'plate', bridge: 'panel', lab: 'tile', factory: 'tread', storage: 'tread', quarters: 'soft' };
  const MAT_PITCH = { plate: [2, 2], panel: [4, 1], tile: [2, 2], tread: [2, 2], soft: [3, 2], grate: [1, 1], hex: [1, 1], plank: [5, 1], turf: [1, 1] };
  const MAT_NO_WEAR = { tile: 1, grate: 1, turf: 1 };   // gloss, open mesh and growth don't take boot scuffs
  // the room's deck material — the model's per-room choice when it has one, else the kind default
  // (a station built before the material axis existed has none, and bakes exactly as it always did).
  const matOf = z => {
    const m = G.matOf ? G.matOf(z) : null;
    return (m && MAT_PITCH[m]) ? m : (MAT_BY_KIND[(G.kindOf && G.kindOf(z)) || 'hab'] || 'plate');
  };
  /* cheap deterministic per-PIXEL hash. h2 hashes a string, which is fine at ~5 marks per tile but
     not at the ~25 turf needs. Keyed on bake-pixel coords (the same space the Bayer dither uses),
     so a pixel resolves identically no matter which chunk viewport bakes it. */
  const hp = (a, c, k) => {
    let n = (Math.imul(a | 0, 374761393) + Math.imul(c | 0, 668265263) + Math.imul(k | 0, 1442695041)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
  };

  /* ---------- per-tile deck painters — one per material ----------
     Each paints ONE tile in that tile's own base colour. bakeRoomFloor AND the REFIT palette
     sampler both go through paintDeck, so the swatch a Commander clicks is drawn by the exact
     code that bakes the station — a deck preview here can never drift from the deck they get. */

  function deckSlab(b, mat, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => U.shade(base, d * fd);
    const PW = MAT_PITCH[mat][0], PH = MAT_PITCH[mat][1];
    px(X, Y, T, T, base);
    // V3 SLAB TILES — the tile texture itself is dimensional now, not a flat fill with
    // lines drawn on it: each plate renders as a slab — dark GROUT at the plate boundary,
    // a lit BEVEL along the slab's top/left, a shaded bevel along its bottom/right, and a
    // 2-step body shade down the slab (upper course a hair lighter). The dimension comes
    // from edge placement, not contrast, so the deck stays a quiet background surface.
    const pxc = Math.floor(x / PW), pyc = Math.floor(y / PH);
    const pn = h2(pxc, pyc, z + ':pl');
    const lx = x % PW, ly = y % PH;
    const checker = mat === 'tile' ? ((pxc + pyc) % 2 ? 0.022 : -0.016) : 0;
    const body = ((pn % 5) - 2) * 0.014 + checker;
    const step = PH > 1 ? (ly === 0 ? 0.016 : -0.012) : 0;   // slab body: light upper course → dark lower
    px(X, Y, T, T, sh(body + step));
    if (lx === 0) { px(X, Y, 1, T, sh(-0.30)); px(X + 1, Y, 1, T, sh(body + 0.07)); }   // grout + lit west bevel
    if (ly === 0) { px(X, Y, T, 1, sh(-0.30)); px(X, Y + 1, T, 1, sh(body + 0.07)); }   // grout + lit north bevel
    if (lx === PW - 1) px(X + T - 1, Y, 1, T, sh(body - 0.14));                          // shaded east bevel
    if (ly === PH - 1) px(X, Y + T - 1, T, 1, sh(body - 0.14));                          // shaded south bevel
    // material dressing — rivets on alternating plate joints only
    if ((mat === 'plate' || mat === 'tread') && lx === 0 && ly === 0 && (pxc + pyc) % 2 === 0) {
      px(X + 2, Y + 2, 2, 2, sh(0.16)); px(X + 3, Y + 3, 1, 1, sh(-0.22));
    }
    if (mat === 'tread') {
      if (n % 2 === 0) {                                           // stamped tread ticks on half the tiles
        px(X + 2 + (n % 3), Y + 4, 3, 1, sh(-0.14));
        px(X + 5 + (n % 3), Y + 8, 3, 1, sh(-0.14));
      }
      if (y % (PH * 3) === 0) px(X, Y, T, 1, sh(-0.35));           // weld line every 3rd plate row
    } else if (mat === 'tile' && pn % 7 === 0) {
      px(X + T - 5, Y + 2, 2, 1, sh(0.20));                        // specular tick on a gloss tile
    } else if (mat === 'soft' && pn % 3 === 0) {
      px(X + 1, Y + 1, T - 2, T - 2, sh(0.035));                   // warm matted lift on some plates
    }
    // sparse one-off features (v1 survivors, now material-aware: labs/bridge stay clean)
    if (mat === 'plate' || mat === 'tread' || mat === 'soft') {
      if (n % 19 === 3 && mat !== 'soft') {
        px(X + 2, Y + 2, T - 4, T - 4, sh(-0.25));                 // recessed vent hatch
        for (let i = 0; i < 3; i++) px(X + 3, Y + 4 + i * 3, T - 6, 1, sh(-0.5));
      } else if (n % 23 === 5) {
        px(X + 2, Y + 2, T - 4, T - 4, sh(-0.12));                 // access panel
        b.strokeStyle = sh(-0.4); b.lineWidth = 1; b.strokeRect(X + 2.5, Y + 2.5, T - 5, T - 5);
        px(X + T / 2 - 2, Y + T / 2, 4, 1, sh(-0.5));
      } else if (n % 31 === 7) {
        b.fillStyle = 'rgba(0,0,0,' + (0.13 * fd).toFixed(3) + ')';                // old oil stain
        b.beginPath(); b.ellipse(X + (n % 8), Y + (n % 6) + 3, 5, 3, 0, 0, 7); b.fill();
      }
    }
  }

  /* GRATE — open catwalk mesh. A 4px lattice of top-lit bars over a dark void, so the read comes
     from the HOLES: this is the one deck that sits darker than its own base. Heavier structural
     beams every third tile keep long runs from turning into flat noise. */
  function deckGrate(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => U.shade(base, d * fd);
    px(X, Y, T, T, base);
    px(X, Y, T, T, sh(-0.50));                                        // the void between the bars
    if (n % 3 === 0) px(X, Y + 4 + (n % 5), T, 1, sh(-0.34));          // a strut on the deck far below
    for (let i = 0; i < T; i += 4) { px(X + i, Y, 2, T, sh(-0.04)); px(X + i, Y, 1, T, sh(0.09)); }   // vertical bars + lit west edge
    for (let j = 0; j < T; j += 4) { px(X, Y + j, T, 2, sh(0.02)); px(X, Y + j, T, 1, sh(0.15)); }    // horizontals woven over + lit north edge
    if (x % 3 === 0) { px(X, Y, 2, T, sh(-0.18)); px(X, Y, 1, T, sh(0.05)); }   // structural beam
    if (y % 3 === 0) { px(X, Y, T, 2, sh(-0.14)); px(X, Y, T, 1, sh(0.11)); }
  }

  /* HEX — honeycomb. Two 12×6 cells per tile on a half-cell-offset lattice: flat top and bottom,
     diagonal shoulders, short side walls. Everything else on the station is rectilinear, so the
     non-square lattice alone is what makes this read as a different technology. */
  function deckHex(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => U.shade(base, d * fd);
    px(X, Y, T, T, base);
    for (let row = 0; row < 2; row++) {
      const cy = Y + row * 6, off = row ? 6 : 0, cx = X + off - (off ? 12 : 0);
      // two passes so the offset row's half-cells at both tile edges are drawn
      for (let c = 0; c < (off ? 2 : 1); c++) {
        const ox0 = cx + c * 12;
        const cn = h2(Math.floor((ox0 - X) / 12) + x * 2, y * 2 + row, z + ':hx');
        const body = ((cn % 5) - 2) * 0.016;
        px(Math.max(X, ox0 + 2), cy + 1, Math.min(8, X + T - Math.max(X, ox0 + 2)), 4, sh(body));   // cell body
        px(Math.max(X, ox0 + 2), cy, Math.min(8, X + T - Math.max(X, ox0 + 2)), 1, sh(-0.30));      // flat top grout
        px(Math.max(X, ox0 + 2), cy + 1, Math.min(8, X + T - Math.max(X, ox0 + 2)), 1, sh(body + 0.11));  // catch-light under it
        // diagonal shoulders + side walls (clipped to the tile by the guards)
        const dot = (dx, dy, col) => { const ax = ox0 + dx; if (ax >= X && ax < X + T) px(ax, cy + dy, 1, 1, col); };
        dot(1, 1, sh(-0.30)); dot(10, 1, sh(-0.30));
        dot(0, 2, sh(-0.30)); dot(11, 2, sh(-0.30));
        dot(0, 3, sh(-0.26)); dot(11, 3, sh(-0.26));
        dot(1, 4, sh(-0.22)); dot(10, 4, sh(-0.22));
        px(Math.max(X, ox0 + 2), cy + 5, Math.min(8, X + T - Math.max(X, ox0 + 2)), 1, sh(body - 0.16));  // shaded flat bottom
      }
    }
  }

  /* PLANK — laid wood boards, 5 tiles long and one tile deep, staggered every third row so end
     seams never line up (the tell of real flooring). Per-board tone, grain hairlines along the
     run, and the occasional knot. Warm, and the only deck that reads as CARPENTRY. */
  function deckPlank(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => U.shade(base, d * fd);
    const PWp = MAT_PITCH.plank[0];
    const stagger = (y % 3) * 2;
    const rel = ((x - stagger) % PWp + PWp) % PWp;              // safe mod: x-stagger can go negative
    const pn = h2(Math.floor((x - stagger) / PWp), y, z + ':pk');
    const body = ((pn % 7) - 3) * 0.018;                         // per-BOARD tone (whole board, not per tile)
    px(X, Y, T, T, base);
    px(X, Y, T, T, sh(body));
    px(X, Y, T, 1, sh(body + 0.10));                             // lit top edge of the board
    px(X, Y + T - 2, T, 1, sh(body - 0.10));                     // shadow into the gap
    px(X, Y + T - 1, T, 1, sh(body - 0.30));                     // the gap between boards
    if (rel === 0) { px(X, Y, 1, T, sh(body - 0.32)); px(X + 1, Y, 1, T, sh(body + 0.06)); }   // butt-end seam
    px(X, Y + 3 + (n % 3), T, 1, sh(body - 0.07));               // grain hairlines running with the board
    px(X, Y + 7 + (n % 3), T, 1, sh(body - 0.05));
    if (n % 3 === 0) px(X, Y + 5, T, 1, sh(body + 0.05));
    if (n % 29 === 4) {                                          // knot
      px(X + 3 + (n % 4), Y + 4, 4, 3, sh(body - 0.26));
      px(X + 4 + (n % 4), Y + 5, 2, 1, sh(body - 0.40));
    }
  }

  /* TURF — hydroponic growth. Pure blade scatter with low-frequency clumping and NO lattice of any
     kind: no grout, no bevels, no seams. That absence is the entire design — every other deck here
     is a built surface, and the only way to read "grown" at 12px is to remove the grid. */
  function deckTurf(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => U.shade(base, d * fd);
    const clump = h2(x >> 1, y >> 1, z + ':cl');                 // 2×2-tile patches read denser/sparser
    const cl = ((clump % 5) - 2) * 0.020;
    px(X, Y, T, T, base);
    px(X, Y, T, T, sh(cl));
    const TONE = [-0.20, -0.10, 0.07, 0.16];
    for (let i = 0; i < 22; i++) {
      const r = hp(X, Y, i);
      const by = (r >>> 5) % T;
      px(X + (r % T), Y + by, 1, Math.min(1 + ((r >>> 13) % 3), T - by), sh(cl + TONE[(r >>> 11) & 3]));
    }
    if ((clump % 4) === 0) {                                     // a taller blade catching the room light
      const r = hp(X, Y, 99);
      px(X + (r % T), Y + ((r >>> 6) % (T - 3)), 1, 3, sh(cl + 0.24));
    }
  }

  function paintDeck(b, mat, base, x, y, X, Y, z, n, fd) {
    if (mat === 'grate') return deckGrate(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'hex') return deckHex(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'plank') return deckPlank(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'turf') return deckTurf(b, base, x, y, X, Y, z, n, fd);
    return deckSlab(b, mat, base, x, y, X, Y, z, n, fd);
  }

  function bakeRoomFloor(b, r) {
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    const fd = Math.max(0, DEPTH.floorDetail);
    const mat = matOf(r.z);
    const zg = G.zoneGrid, idx = G.idx, COLS = G.COLS, ROWS = G.ROWS;
    const zAt = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS) ? null : zg[idx(x, y)];
    const doorTo = (x, y, nx, ny) => { const nz = zAt(nx, ny); return nz != null && nz !== r.z && (G.canStep(x, y, nx, ny) || G.canStep(nx, ny, x, y)); };
    const wallTo = (x, y, nx, ny) => zAt(nx, ny) !== r.z && !doorTo(x, y, nx, ny);
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      const base = G.baseColorOf(r.z, x, y);
      const X = x * T, Y = y * T, n = h2(x, y, r.z);
      const sh = d => U.shade(base, d * fd);
      paintDeck(b, mat, base, x, y, X, Y, r.z, n, fd);
      // FLOOR WEAR — a lived-in deck: hash-keyed scuffs, drag marks, worn-pale patches and
      // grime films over the plates above. Same idiom (opaque-ish 1px marks, deterministic on
      // the tile hash); DEPTH.floorWear scales alpha, 0 = the pristine pre-wear floor exactly.
      const wear = Math.max(0, DEPTH.floorWear);
      if (wear > 0.001 && !MAT_NO_WEAR[mat]) {
        const wa = a => (a * wear).toFixed(3);
        if (n % 9 === 1) px(X + (n % 6), Y + 3 + (n % 8), 4 + (n % 3), 1, 'rgba(0,0,0,' + wa(0.18) + ')');          // boot scuff streak
        else if (n % 11 === 6) px(X + 3 + (n % 8), Y + (n % 5), 1, 3 + (n % 3), 'rgba(0,0,0,' + wa(0.15) + ')');    // vertical scrape
        else if (n % 17 === 8) {                                                                                     // parallel drag marks (something heavy moved)
          px(X + 2, Y + 5 + (n % 4), 6 + (n % 4), 1, 'rgba(0,0,0,' + wa(0.14) + ')');
          px(X + 2, Y + 7 + (n % 4), 6 + (n % 4), 1, 'rgba(0,0,0,' + wa(0.14) + ')');
        } else if (n % 27 === 4) px(X + 2, Y + 2, T - 4, T - 4, 'rgba(255,244,220,' + wa(0.05) + ')');               // worn-pale patch (foot polish)
        if (n % 13 === 9) px(X, Y, T, T, 'rgba(0,0,0,' + wa(0.06) + ')');                                            // grime film over the whole plate
      }
      // PERIMETER TRIM COURSE — the border course where floor meets wall reads as a distinct
      // laid material band, catch-lit on its room-facing edge; doors get pale guide ticks.
      // Painted LAST so it re-tones the whole tile over the plate work above.
      const wN = wallTo(x, y, x, y - 1), wS = wallTo(x, y, x, y + 1), wW = wallTo(x, y, x - 1, y), wE = wallTo(x, y, x + 1, y);
      if (wN || wS || wW || wE) {
        px(X, Y, T, T, 'rgba(6,7,10,' + (0.06 * fd).toFixed(3) + ')');
        if (wN && !wS) px(X, Y + T - 1, T, 1, sh(0.06));
        if (wS && !wN) px(X, Y, T, 1, sh(0.06));
        if (wW && !wE) px(X + T - 1, Y, 1, T, sh(0.06));
        if (wE && !wW) px(X, Y, 1, T, sh(0.06));
      }
      const dN = doorTo(x, y, x, y - 1), dS = doorTo(x, y, x, y + 1), dW = doorTo(x, y, x - 1, y), dE = doorTo(x, y, x + 1, y);
      if (dN || dS || dW || dE) {
        b.fillStyle = sh(0.13);
        for (let i = 2; i < T - 2; i += 5) {
          if (dN) b.fillRect(X + i, Y + 1, 2, 1);
          if (dS) b.fillRect(X + i, Y + T - 2, 2, 1);
          if (dW) b.fillRect(X + 1, Y + i, 1, 2);
          if (dE) b.fillRect(X + T - 2, Y + i, 1, 2);
        }
      }
    }
  }

  function bakeCorridorFloor(b, r) {
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    const fd = Math.max(0, DEPTH.floorDetail);
    const vertical = (r.y2 - r.y1) > (r.x2 - r.x1);
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      const base = G.baseColorOf(r.z, x, y);
      const X = x * T, Y = y * T, n = h2(x, y, 'cor');
      const sh = d => U.shade(base, d * fd);
      px(X, Y, T, T, base);
      px(X, Y, T, T, sh(((n % 4) - 1.5) * 0.013));   // per-tile tread-plate tone (hard, one of 4)
      // slab tread: seam, lit lip under it, shaded base — each corridor row reads as a step
      px(X, Y, T, 1, sh(-0.34));
      px(X, Y + 1, T, 1, sh(0.05));
      px(X, Y + T - 1, T, 1, sh(-0.12));
      if (n % 23 === 5) { px(X + 2, Y + 2, T - 4, T - 4, sh(-0.16)); b.strokeStyle = sh(-0.4); b.lineWidth = 1; b.strokeRect(X + 2.5, Y + 2.5, T - 5, T - 5); }
      // corridor wear ticks (see the room-floor wear block for the idiom)
      if (DEPTH.floorWear > 0.001 && n % 7 === 2) px(X + (n % 6), Y + 2 + (n % 7), 3 + (n % 3), 1, 'rgba(0,0,0,' + (0.16 * DEPTH.floorWear).toFixed(3) + ')');
    }
    // long-axis rib bands + edge air-grilles
    b.fillStyle = 'rgba(0,0,0,' + (0.12 * fd).toFixed(3) + ')';
    const x1 = r.x1 * T, y1 = r.y1 * T, rw = (r.x2 - r.x1 + 1) * T, rh = (r.y2 - r.y1 + 1) * T;
    if (vertical) for (let yy = y1 + 4; yy < y1 + rh; yy += 7) b.fillRect(x1 + 2, yy, rw - 4, 1);
    else for (let xx = x1 + 4; xx < x1 + rw; xx += 7) b.fillRect(xx, y1 + 2, 1, rh - 4);
    b.fillStyle = U.shade('#2c2924', -0.5);
    if (vertical) { for (let yy = y1 + 3; yy < y1 + rh; yy += 5) { b.fillRect(x1 + 1, yy, 1, 2); b.fillRect(x1 + rw - 2, yy, 1, 2); } }
    else { for (let xx = x1 + 3; xx < x1 + rw; xx += 5) { b.fillRect(xx, y1 + 1, 2, 1); b.fillRect(xx, y1 + rh - 2, 2, 1); } }
    // V2: chevron stamps between the ribs (staggered direction ticks along the walk axis)
    // + side GUTTERS — a dark drainage channel with a faint lit lip hugging each long wall
    if (fd > 0.001) {
      const tick = 'rgba(0,0,0,' + (0.10 * fd).toFixed(3) + ')';
      const chan = 'rgba(0,0,0,' + (0.18 * fd).toFixed(3) + ')';
      const lip = 'rgba(255,244,220,' + (0.03 * fd).toFixed(3) + ')';
      if (vertical) {
        const cxp = Math.round(x1 + rw / 2);
        b.fillStyle = tick;
        for (let yy = y1 + 8; yy < y1 + rh - 3; yy += 14) { b.fillRect(cxp - 4, yy, 3, 1); b.fillRect(cxp + 1, yy + 2, 3, 1); }
        b.fillStyle = chan; b.fillRect(x1 + 3, y1 + 2, 1, rh - 4); b.fillRect(x1 + rw - 4, y1 + 2, 1, rh - 4);
        b.fillStyle = lip; b.fillRect(x1 + 4, y1 + 2, 1, rh - 4); b.fillRect(x1 + rw - 5, y1 + 2, 1, rh - 4);
      } else {
        const cyp = Math.round(y1 + rh / 2);
        b.fillStyle = tick;
        for (let xx = x1 + 8; xx < x1 + rw - 3; xx += 14) { b.fillRect(xx, cyp - 4, 1, 3); b.fillRect(xx + 2, cyp + 1, 1, 3); }
        b.fillStyle = chan; b.fillRect(x1 + 2, y1 + 3, rw - 4, 1); b.fillRect(x1 + 2, y1 + rh - 4, rw - 4, 1);
        b.fillStyle = lip; b.fillRect(x1 + 2, y1 + 4, rw - 4, 1); b.fillRect(x1 + 2, y1 + rh - 5, rw - 4, 1);
      }
    }
    // TRAFFIC LANES (floor wear) — two foot-polished tracks down the corridor's long axis where
    // the crew actually walks: a pale sheen lane with a faint grime line hugging its outside.
    // Rides DEPTH.floorWear like the per-tile wear marks; 0 = off.
    const wear = Math.max(0, DEPTH.floorWear);
    if (wear > 0.001) {
      const lane = 'rgba(255,244,220,' + (0.05 * wear).toFixed(3) + ')';
      const grime = 'rgba(0,0,0,' + (0.10 * wear).toFixed(3) + ')';
      if (vertical) {
        const cx = Math.round(x1 + rw / 2);
        b.fillStyle = lane; b.fillRect(cx - 4, y1 + 2, 2, rh - 4); b.fillRect(cx + 2, y1 + 2, 2, rh - 4);
        b.fillStyle = grime; b.fillRect(cx - 5, y1 + 2, 1, rh - 4); b.fillRect(cx + 4, y1 + 2, 1, rh - 4);
      } else {
        const cy = Math.round(y1 + rh / 2);
        b.fillStyle = lane; b.fillRect(x1 + 2, cy - 4, rw - 4, 2); b.fillRect(x1 + 2, cy + 2, rw - 4, 2);
        b.fillStyle = grime; b.fillRect(x1 + 2, cy - 5, rw - 4, 1); b.fillRect(x1 + 2, cy + 4, rw - 4, 1);
      }
    }
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

    // up > 0 → a standing interior face, painted in the STATION'S OWN PIXEL IDIOM: opaque colours
    // stepped via U.shade (hard 1px transitions), grain that matches the floor's at 3x, and NO
    // low-alpha full-width washes (those read as blur next to the hard floor steps). The FACE
    // itself is per-material (WALL_RECIPES); the crown, hull lip and floor-contact line are
    // common to every material because they define the wall's silhouette and height.
    const pal = wallPal(e.z);
    const capH = Math.max(2, Math.round(WALL.capH));
    const h = up + inFace, topY = Y - up;              // all integer already (up/capH rounded, T/inFace int)
    const n = h2(e.x, e.y, 'nwall');
    // dark hull lip above the crown (the old NCAP band, pushed up with the wall) — HULL tone, not
    // the room's: this is the shell seen from outside.
    b.fillStyle = wallDk; b.fillRect(X, topY - capH - 2, T, 2);
    // lit crown — opaque cap band, 1px lighter top edge, 1px darker seam beneath. Kept BRIGHT:
    // after the ambient bake this continuous line defines the wall height at any zoom.
    b.fillStyle = pal.cap; b.fillRect(X, topY - capH, T, capH);
    b.fillStyle = U.shade(pal.cap, 0.30); b.fillRect(X, topY - capH, T, 1);          // 1px lighter top edge
    b.fillStyle = U.shade(pal.cap, -0.45); b.fillRect(X, topY - 1, T, 1);            // 1px darker seam beneath
    // THE FACE — per material
    (WALL_RECIPES[wallMatOf(e.z)] || WALL_RECIPES.plating)(b, pal, X, topY, h, e, n, room, Y + inFace);
    // floor-contact cap line (identical to the old look)
    b.fillStyle = pal.top; b.fillRect(X, Y + inFace, T, 1);
  }

  /* ---------- WALL RECIPES — one per material, each painting ONE tile's interior face ----------
     Signature: (b, pal, X, topY, h, e, n, room, footY). `pal` is the room's derived wall palette,
     `h` the full face height, `footY` the floor-contact row. Every mark is opaque and stepped off
     `pal.face`, deterministic on the tile hash / bake-pixel coords, and scaled by DEPTH.wallDetail
     so 0 gives a flat unadorned face. A recipe owns the face ONLY — never the crown or the foot. */
  const wallDet = () => Math.max(0, DEPTH.wallDetail);

  // the foot every recipe shares: a darker base course and a hard contact shadow at the floor line
  function wallFoot(b, tone, X, footY, wd) {
    b.fillStyle = U.shade(tone, -0.22 * wd); b.fillRect(X, footY - 2, T, 2);
    b.fillStyle = U.shade(tone, -0.42 * wd); b.fillRect(X, footY - 1, T, 1);
  }

  /* PLATING — the classic standing metal, but no longer starved: the weld line, vent panels and
     conduit drops that used to be gated behind the up>=18 CRT-lab preset (i.e. never rendered in
     the shipped game) now run at any height, plus a mid-height bumper rail that gives a long wall
     a horizon instead of one flat tone. */
  function wallPlating(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const plate = U.shade(pal.face, ((n % 4) - 1.5) * 0.03 * wd);
    b.fillStyle = plate; b.fillRect(X, topY, T, h);
    const topCourse = Math.max(2, Math.min(4, (h / 3) | 0));
    b.fillStyle = U.shade(plate, 0.10 * wd); b.fillRect(X, topY, T, topCourse);       // lit top course
    b.fillStyle = U.shade(plate, 0.16 * wd); b.fillRect(X, topY, T, 1);               // 1px bright course edge
    wallFoot(b, plate, X, footY, wd);
    b.fillStyle = U.shade(pal.face, -0.34 * wd); b.fillRect(X, topY, 1, h);           // per-tile plate seam
    // BUMPER RAIL — a hard horizontal band ~58% down, lit on top. This is the single biggest
    // legibility win on a tall wall: it gives the eye a line to read height against.
    const rail = topY + Math.round(h * 0.58);
    b.fillStyle = U.shade(plate, -0.26 * wd); b.fillRect(X, rail, T, 2);
    b.fillStyle = U.shade(plate, 0.14 * wd); b.fillRect(X, rail, T, 1);
    b.fillStyle = U.shade(plate, 0.20 * wd); b.fillRect(X + 2 + (n % 7), topY + 1 + (n % 2), 1, 1);   // rivet
    if (n % 5 === 0) { b.fillStyle = U.shade(plate, -0.30 * wd); b.fillRect(X + 4 + (n % 5), topY + 3 + (n % 3), 1, 1); }
    if (h >= 14) {
      b.fillStyle = U.shade(pal.face, -0.30 * wd); b.fillRect(X, topY + ((h * 0.28) | 0), T, 1);      // weld line
      if (room && n % 9 === 0) {                                                     // recessed vent panel
        b.fillStyle = U.shade(pal.face, -0.55 * wd); b.fillRect(X + 6, topY + 3, 5, 6);
        b.fillStyle = U.shade(pal.face, -0.72 * wd);
        for (let i = 0; i < 3; i++) b.fillRect(X + 7, topY + 4 + i * 2, 3, 1);
      } else if (n % 11 === 3) {                                                     // pale conduit drop
        b.fillStyle = U.shade(pal.face, 0.20 * wd); b.fillRect(X + 2, topY + 2, 1, h - 6);
      }
    }
  }

  /* RIBBED — vertical structural ribs on a 4px pitch, each a lit column beside a deep channel.
     The strongest vertical rhythm of any recipe; reads as engine-room / pressure bulkhead. */
  function wallRibbed(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const body = U.shade(pal.face, ((n % 3) - 1) * 0.02 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    for (let i = 0; i < T; i += 4) {
      b.fillStyle = U.shade(body, -0.34 * wd); b.fillRect(X + i, topY, 1, h);        // deep channel
      b.fillStyle = U.shade(body, 0.15 * wd); b.fillRect(X + i + 1, topY, 1, h);     // lit rib edge
      b.fillStyle = U.shade(body, -0.10 * wd); b.fillRect(X + i + 3, topY, 1, h);    // rib shadow side
    }
    // top and bottom rails cap the ribs so they don't float
    b.fillStyle = U.shade(body, 0.12 * wd); b.fillRect(X, topY, T, 2);
    b.fillStyle = U.shade(body, 0.20 * wd); b.fillRect(X, topY, T, 1);
    const rail = topY + Math.round(h * 0.62);
    b.fillStyle = U.shade(body, -0.28 * wd); b.fillRect(X, rail, T, 2);
    b.fillStyle = U.shade(body, 0.10 * wd); b.fillRect(X, rail, T, 1);
    wallFoot(b, body, X, footY, wd);
  }

  /* PANEL — one large recessed panel per tile: inset border, lit inner top-left bevel, shaded
     bottom-right. The finished command-deck read; deliberately the calmest recipe. */
  function wallPanelled(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const body = U.shade(pal.face, ((n % 3) - 1) * 0.018 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    b.fillStyle = U.shade(body, -0.30 * wd); b.fillRect(X, topY, 1, h);              // tile seam
    const pTop = topY + 2, pH = Math.max(4, h - 6);
    b.fillStyle = U.shade(body, -0.20 * wd); b.fillRect(X + 2, pTop, T - 4, pH);     // recess
    b.fillStyle = U.shade(body, 0.06 * wd); b.fillRect(X + 3, pTop + 1, T - 6, pH - 2);
    b.fillStyle = U.shade(body, 0.18 * wd); b.fillRect(X + 3, pTop + 1, T - 6, 1);   // lit inner top
    b.fillStyle = U.shade(body, 0.14 * wd); b.fillRect(X + 3, pTop + 1, 1, pH - 2);  // lit inner left
    b.fillStyle = U.shade(body, -0.24 * wd); b.fillRect(X + T - 4, pTop + 1, 1, pH - 2);
    b.fillStyle = U.shade(body, -0.24 * wd); b.fillRect(X + 3, pTop + pH - 2, T - 6, 1);
    b.fillStyle = U.shade(body, 0.22 * wd); b.fillRect(X, topY, T, 1);               // trim line along the run
    wallFoot(b, body, X, footY, wd);
  }

  /* VIEWPORT — the only recipe that does not paint a wall: it CUTS one. The glass band is cleared
     to transparent so the live drifting starfield behind the station shows through the hole (see
     buildLightMap, which also punches the ambient mask here or the sky would render at 23%).
     Baked stars would be a lie — the real sky is already back there, and it moves. */
  function wallViewport(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const body = U.shade(pal.face, ((n % 3) - 1) * 0.02 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    const gTop = topY + 3, gH = Math.max(3, h - 9);
    b.clearRect(X + 1, gTop, T - 1, gH);                     // THE HOLE — 1px left mullion kept per tile
    viewportRects.push({ x: X + 1, y: gTop, w: T - 1, h: gH });
    // frame: bright sill under the glass, shaded head above, mullion at the tile seam
    b.fillStyle = U.shade(body, -0.40 * wd); b.fillRect(X, gTop - 1, T, 1);          // head shadow
    b.fillStyle = U.shade(body, 0.26 * wd); b.fillRect(X, gTop + gH, T, 2);          // lit sill
    b.fillStyle = U.shade(body, 0.34 * wd); b.fillRect(X, gTop + gH, T, 1);
    b.fillStyle = U.shade(body, 0.10 * wd); b.fillRect(X, gTop, 1, gH);              // mullion
    wallFoot(b, body, X, footY, wd);
  }

  /* PIPEWORK — plating overrun with conduit: vertical pipe runs with a lit highlight column, a
     horizontal cable tray, and the occasional valve block. The utility/engine-room read. */
  function wallPipework(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const body = U.shade(pal.face, ((n % 4) - 1.5) * 0.025 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    b.fillStyle = U.shade(body, -0.30 * wd); b.fillRect(X, topY, 1, h);
    const pipe = (px, w) => {                                                        // a round-read pipe
      b.fillStyle = U.shade(body, -0.34 * wd); b.fillRect(X + px, topY, w, h);
      b.fillStyle = U.shade(body, 0.24 * wd); b.fillRect(X + px + 1, topY, 1, h);    // highlight column
      b.fillStyle = U.shade(body, -0.48 * wd); b.fillRect(X + px + w - 1, topY, 1, h);
    };
    pipe(2 + (n % 2), 3);
    if (n % 3 !== 0) pipe(8, 2);
    const tray = topY + Math.round(h * 0.66);                                        // horizontal cable tray
    b.fillStyle = U.shade(body, -0.38 * wd); b.fillRect(X, tray, T, 3);
    b.fillStyle = U.shade(body, 0.16 * wd); b.fillRect(X, tray, T, 1);
    if (n % 7 === 2) {                                                               // valve block
      b.fillStyle = U.shade(body, 0.10 * wd); b.fillRect(X + 1 + (n % 2), topY + 4, 5, 4);
      b.fillStyle = U.shade(body, -0.44 * wd); b.fillRect(X + 2 + (n % 2), topY + 5, 3, 1);
    }
    wallFoot(b, body, X, footY, wd);
  }

  /* WAINSCOT — timber panelling to the chair rail, plain wall above. The warm habitat recipe; the
     board pitch is 3px so it reads as narrower boards than the PLANK floor's, which stops a
     wainscot wall above a plank deck from looking like one continuous surface. */
  function wallWainscot(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const upper = U.shade(pal.face, 0.10 * wd);
    b.fillStyle = upper; b.fillRect(X, topY, T, h);                                  // plain plaster above
    b.fillStyle = U.shade(upper, -0.08 * wd); b.fillRect(X, topY, 1, h);
    const railY = topY + Math.round(h * 0.42);
    const boardTop = railY + 2;
    b.fillStyle = U.shade(pal.face, -0.10 * wd); b.fillRect(X, boardTop, T, footY - boardTop);
    for (let i = 0; i < T; i += 3) {                                                 // vertical boards
      const bn = h2(e.x * 4 + i, e.y, 'wsc');
      b.fillStyle = U.shade(pal.face, (((bn % 5) - 2) * 0.020 - 0.10) * wd); b.fillRect(X + i, boardTop, 3, footY - boardTop);
      b.fillStyle = U.shade(pal.face, -0.36 * wd); b.fillRect(X + i, boardTop, 1, footY - boardTop);      // board seam
      b.fillStyle = U.shade(pal.face, 0.04 * wd); b.fillRect(X + i + 1, boardTop, 1, footY - boardTop);   // lit face
      if (bn % 4 === 0) b.fillStyle = U.shade(pal.face, -0.18 * wd), b.fillRect(X + i + 1, boardTop + 2 + (bn % 4), 1, 2);  // grain fleck
    }
    b.fillStyle = U.shade(pal.face, -0.34 * wd); b.fillRect(X, railY, T, 2);         // chair rail
    b.fillStyle = U.shade(pal.face, 0.30 * wd); b.fillRect(X, railY, T, 1);          // lit rail edge
    wallFoot(b, pal.face, X, footY, wd);
  }

  /* HEDGE — a living wall. Same principle as the TURF deck: NO lattice, no seams, no bevels; the
     read comes from dense blade scatter alone, darker toward the base where light doesn't reach. */
  function wallHedge(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const body = U.shade(pal.face, -0.06 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    const TONE = [-0.26, -0.14, 0.08, 0.20];
    const leaves = Math.max(8, Math.round(T * h / 7));
    for (let i = 0; i < leaves; i++) {
      const r = hp(X, topY, i);
      const ly = (r >>> 5) % h;
      const depth = -0.16 * (ly / Math.max(1, h));                                   // darker toward the base
      b.fillStyle = U.shade(body, (TONE[(r >>> 11) & 3] + depth) * wd);
      b.fillRect(X + (r % T), topY + ly, 1, Math.min(1 + ((r >>> 14) % 2), h - ly));
    }
    b.fillStyle = U.shade(body, 0.22 * wd); b.fillRect(X + (hp(X, topY, 91) % T), topY, 1, 2);   // lit crown sprig
    wallFoot(b, body, X, footY, wd);
  }

  const WALL_RECIPES = {
    plating: wallPlating, ribbed: wallRibbed, panelled: wallPanelled,
    viewport: wallViewport, pipework: wallPipework, wainscot: wallWainscot, hedge: wallHedge
  };

  function bakeWalls(b) {
    for (const e of edges) {
      const X = e.x * T, Y = e.y * T;
      if (e.door) { bakeThreshold(b, e, X, Y); continue; }
      const fw = e.room ? FACEW : 2, out = e.room ? 4 : 2, face = e.room ? NFACE : 5;
      const dep = fw + 1, rib = 'rgba(0,0,0,0.25)';
      // the SIDE faces (s/w/e) and interior seams carry the room's own wall tone too — otherwise a
      // cobalt room's tall north wall would meet three brown-grey walls at its corners.
      const pal = wallPal(e.z), wallFace = pal.face, wallTop = pal.top;
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
    // up-reach must never exceed the pixels the wall art actually paints — anything past the
    // wall's top edge darkens BARE SPACE, which reads as a floating shadow band above rooms
    // on the colored SpaceBG (invisible back when space was pure black). The tall face tops
    // out at topY - capH - 2 (lip) above the floor line; the legacy up:0 short wall at its
    // NCAP band (4 rooms / 2 corridors). Both sit above the pad-wide hull plate, so the extra
    // strip spans the footprint width ONLY (no horizontal pad — the pad wings would hang in space).
    const upReach = r => {
      const up = Math.max(0, Math.round(G.isCorridor(r.z) ? WALL.corUp : WALL.up));
      return up > 0 ? up + capH + 2 : (G.isCorridor(r.z) ? 2 : 4);
    };
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
      const RW = (r.x2 - r.x1 + 1) * T, RH = (r.y2 - r.y1 + 1) * T;
      // footprint + pad matches the opaque hull plate; the wall-height strip above spans the
      // footprint width only (the wall face paints per-tile, exactly X..X+T)
      mg.fillRect(r.x1 * T - pad, r.y1 * T - pad, RW + pad * 2, RH + pad * 2);
      if (u > pad) mg.fillRect(r.x1 * T, r.y1 * T - u, RW, u);
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
    // VIEWPORT GLASS — clear the ambient mask fully over every window the wall pass cut, so the
    // live starfield behind the hole reads at its own brightness instead of the interior's 23%.
    // A hard-edged fill, not a gradient: the frame around it is a hard pixel edge too.
    L.fillStyle = 'rgba(0,0,0,1)';
    for (const v of viewportRects) L.fillRect(v.x, v.y, v.w, v.h);
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
      // a rounded corner belongs to the room it was cut from — take that room's wall palette so a
      // coloured room's corner arc doesn't revert to the old universal brown-grey.
      const cPal = wallPal(G.zoneGrid[G.idx(ccx, ccy)]);
      b.save(); spandrelPath(b, kind, ax, ay, T); b.clip('evenodd');
      b.fillStyle = hullC; b.fillRect(X - 1, Y - 1, T + 2, T + 2); b.restore();
      b.lineWidth = 4.5; b.strokeStyle = wallDk; b.beginPath(); b.arc(ax, ay, T + 2.25, A.a0, A.a1); b.stroke();
      b.lineWidth = 5; b.strokeStyle = cPal.face; b.beginPath(); b.arc(ax, ay, T - 2.5, A.a0, A.a1); b.stroke();
      b.lineWidth = 1; b.strokeStyle = 'rgba(0,0,0,0.25)';
      for (let k = 1; k <= 2; k++) {
        const ang = A.a0 + (A.a1 - A.a0) * k / 3;
        b.beginPath();
        b.moveTo(ax + Math.cos(ang) * (T - 5), ay + Math.sin(ang) * (T - 5));
        b.lineTo(ax + Math.cos(ang) * T, ay + Math.sin(ang) * T); b.stroke();
      }
      b.lineWidth = 2; b.strokeStyle = '#28241b'; b.beginPath(); b.arc(ax, ay, HR - 2, A.a0, A.a1); b.stroke();
      b.lineWidth = 1; b.strokeStyle = cPal.top; b.beginPath(); b.arc(ax, ay, T - 5.5, A.a0, A.a1); b.stroke();

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
          b.fillStyle = cPal.face; b.fillRect(ix, c.top, 1, faceH + 1);            // face column, integer
          // crown = opaque cap pixels stepped up the curve (pixel stairs, not a stroke)
          b.fillStyle = cPal.cap; b.fillRect(ix, c.top - capH, 1, capH);
          b.fillStyle = U.shade(cPal.cap, 0.30); b.fillRect(ix, c.top - capH, 1, 1); // 1px lit top edge
          b.fillStyle = U.shade(cPal.cap, -0.45); b.fillRect(ix, c.top - 1, 1, 1);   // 1px darker seam beneath crown
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
    wallPalCache = null;   // per-room wall palettes are derived from THIS geometry — never reuse across bakes
    viewportRects = [];    // ...and so are the window holes the wall pass punches
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

  /* MATERIAL SAMPLE — paint a small patch of one deck material into any 2D context using the very
     same per-tile painters the station bake uses. The REFIT palette draws its swatches through
     this, so a preview can never drift from the deck it promises. `T` is per-bake module state,
     so it's saved and restored around the sample (a palette redraw must not disturb a live bake). */
  function sampleMaterial(ctx, matId, base, cols, rows, tile) {
    const mat = MAT_PITCH[matId] ? matId : 'plate';
    const fd = Math.max(0, DEPTH.floorDetail);
    const prevT = T;
    T = tile || 12;
    try {
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++)
        paintDeck(ctx, mat, base, x, y, x * T, y * T, 'sample', h2(x, y, 'sample'), fd);
    } finally { T = prevT; }
  }

  /* WALL SAMPLE — the wall counterpart of sampleMaterial, painting a strip of interior face
     through the real WALL_RECIPES. VIEWPORT is the special case: it clears its glass to
     transparent, so the sample lays a few stars behind first — which is honest, because a real
     viewport shows the real (moving) sky through exactly that hole. `viewportRects` is saved and
     restored so drawing a palette chip can never inject phantom windows into a live bake. */
  function sampleWall(ctx, matId, base, cols, height, tile) {
    const recipe = WALL_RECIPES[matId] || WALL_RECIPES.plating;
    const prevT = T, prevRects = viewportRects;
    T = tile || 12;
    viewportRects = [];
    const h = Math.max(6, height || 24);
    try {
      const pal = { base, face: U.shade(base, WALL_TONE.face), top: U.shade(base, WALL_TONE.top), cap: U.shade(base, WALL_TONE.cap) };
      if (matId === 'viewport') {                       // the sky the glass will reveal
        ctx.fillStyle = '#05060c'; ctx.fillRect(0, 0, cols * T, h);
        for (let i = 0; i < cols * 4; i++) {
          const r = hp(i * 7, 3, 5);
          ctx.fillStyle = (r % 5) ? 'rgba(200,214,255,0.75)' : 'rgba(255,236,200,0.9)';
          ctx.fillRect(r % (cols * T), (r >>> 8) % h, 1, 1);
        }
      }
      for (let i = 0; i < cols; i++) recipe(ctx, pal, i * T, 0, h, { x: i, y: 0, z: 'sample' }, h2(i, 0, 'sample'), true, h);
    } finally { T = prevT; viewportRects = prevRects; }
  }

  return { bake, bakeIncremental, dirtyChunks, visibleChunks, missingVisibleChunks, drawBase, drawLight, sampleMaterial, sampleWall, CHUNK_PX, LIGHT, WALL, DEPTH };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StationBake;
