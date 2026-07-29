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

     TONE SEPARATION IS THE WHOLE JOB. A wall face at only -0.15 off the deck's own base reads as
     the SAME surface as the floor — same value, same plate rhythm — so the room looks like one
     continuous field with an arbitrary seam across it rather than a floor with walls around it.
     Walls are vertical, they face away from the ceiling lamps, and they must sit clearly DARKER
     than the deck they enclose. */
  const WALL_TONE = { face: -0.40, top: -0.10, cap: 0.30 };
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
  // FALLBACK ONLY, like MAT_BY_KIND below: projected geometry always carries wallMatOf, so this
  // default is not what you see in game. WorldModel.wallMatOfRoom is the authority — change both.
  const wallMatOf = z => {
    const m = G && G.wallMatOf ? G.wallMatOf(z) : null;
    return WALL_RECIPES[m] ? m : 'bulkhead';
  };

  /* live-tunable WALL HEIGHT — same contract as LIGHT below: the CRT LAB writes these and
     re-bakes. Height only ever extrudes OUTSIDE the floor footprint (up-screen above north
     edges, down-screen below the hull, sideways past e/w edges), so no walkable tile is ever
     covered and nothing y-sorted against agents changes.
       up     = how far a room's north wall face rises above the floor seam (px)
       corUp  = same for corridors (lower → corridors read as tunnels, rooms as halls). It must
                stay LOWER than `up` — that difference IS the tunnel read — but it may not be 0:
                at 0 the north face falls to the legacy short-wall branch, which paints no lit
                crown at all, so a hallway with an exposed north end had the one surface that
                defines a wall's height simply missing (2026-07-28).
       skirt  = hull extrusion depth below the station silhouette (the south wall seen outside)
       side   = width of the e/w wall-top band beyond the floor edge. PINNED TO `pad`: the hull
                plate, its rounded corners and its riveted rim all stop exactly `pad` out, so a
                wider band is a slab of wall sticking out past the station's own silhouette. It
                did not show while the band was near-black, and it showed the instant the band
                got a lit crown.
       capH   = thickness of the lit cap that crowns a tall wall
       sideCap= width of the LIT TOP SURFACE on the walls that are not extruded (e/w/s and the
                corner arcs). CAPPED AT pad-1 BY CONTRACT: buildLightMap's ambient plate covers
                each footprint plus exactly `pad`, so a crown wider than that hangs OUTSIDE the
                mask and renders at its raw baked tone against the starfield — a blazing line
                down the sides while the north crown sits under 0.77 ambient. */
  const WALL = { up: 14, corUp: 8, skirt: 32, side: 7, capH: 3, sideCap: 5 };   // up 9→14 (2026-07-24): the wall materials need surface to live on · corUp 0→8 (2026-07-28): a hallway stands too, just lower than a hall
  /* VIEWPORT holes punched by the wall pass this bake. buildLightMap cuts the ambient mask over
     them — without that the sky behind a window renders at the interior's 23% and reads as a
     black pane. Reset per bake alongside the wall palette cache. */
  let viewportRects = [];
  /* THE CORNER CROWN'S ACTUAL REACH, recorded BY THE PAINTER — chamfer key → (column → topmost
     painted bake-pixel row). buildLightMap's chamfer erase needs to know how far up the art goes so
     the ambient mask stops exactly there; deriving that a second time is precisely what drifted
     before (see the note in buildLightMap). Same per-bake-state contract as viewportRects/lampPos,
     and keyed on absolute bake-pixel coords, so a chunk bake records the same numbers as the
     monolithic one.

     KEYED PER CHAMFER, NOT PER COLUMN. It was one flat column→row map, which is indistinguishable
     from correct on a one-room station because no two chamfers can share a bake column there. Put a
     second room above or below another and they do: the mask pass then ran from a FAR-AWAY corner's
     reach down to THIS corner's tile, laying a tall 1px column of ambient over bare space — a
     scattered shadow line hanging in the starfield (Andrew, on his own multi-room station). 148
     leaked pixels on a stacked layout, 0 on the seed. LEAK-CHECK CORNER WORK ON A MULTI-ROOM
     STATION; the single-room case cannot exercise this at all. */
  let crownReach = null;

  /* EVERY RECT THE CROWN PAINTS, recorded by the painter for buildLightMap to cut the ambient back
     over (same per-bake contract as viewportRects/lampPos, absolute bake-pixel coords, so chunk and
     monolithic bakes record identically).

     WHY THE CROWN NEEDS ITS OWN CUT AT ALL. The hull SKIRT hangs in void and is deliberately left
     OUTSIDE the ambient plate, so it renders at its raw baked tones — its top lip `#3f3a2c` reads
     luma 58 flat. The wall's crown is interior and takes the full 0.77 ambient, which at the dark
     end of a room drops it to 38. So the station's hull was BRIGHTER than the lit top surface of
     the wall inside it, and the corners nearest the skirt were where that inversion showed worst.
     Brightening the baked tone cannot fix it: through 0.77 ambient even a pure white crown tops out
     near luma 62, barely at the skirt. The ambient itself has to give over the crown.
     Which is also the honest reading — a crown is the one interior surface that faces the ceiling
     lamps square-on. It is cut MULTIPLICATIVELY, so the crown still darkens away from the lamps
     like everything else; it just never falls under the shell outside it. */
  let crownRects = [];
  const crown = (b, x, y, w, h, color) => {
    b.fillStyle = color; b.fillRect(x, y, w, h);
    if (w > 0 && h > 0) crownRects.push([x, y, w, h]);
  };

  /* live-tunable lighting — the CRT LAB (crtlab.js, dev-gated) writes these and calls
     World.rebake() to re-run the bake. These ARE the shipped defaults.
       ambient  = how dark the unlit station is (0=fully lit · 1=black)
       pool     = how brightly the ceiling lamps carve their light pools back out
       room/corridor/door = baseline lift inside each space type
       floor    = warmth of the additive light pool painted on the floor */
  const LIGHT = { ambient: 0.77, ambR: 7, ambG: 5, ambB: 3, pool: 1, room: 0.6, corridor: 0.42, door: 0.5, floor: 0.2, crown: 0.45 };   // crown = how far the ambient gives way over a wall's lit top surface (0 = off, the old inversion)

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
  /*   deckSeam   = how hard the JOINT between deck plates/boards reads. The v3 grout was a -0.30
                    step with a +0.07 catch-light immediately beside it, repeated at every plate
                    boundary — a high-contrast 2px edge on a 24px pitch, which reads as a GRID OF
                    SEPARATION LINES cutting the deck into blocks instead of a quiet laid surface
                    (Andrew 2026-07-24: "there seems to be this separation line, can we remove that
                    so it blends?"). The joint still has to exist or a plate deck is a flat field,
                    so it gets its own knob rather than being deleted. Scales ONLY the seam/bevel
                    steps — per-plate tone, material dressing and wear are untouched.
                    0 = a genuinely seamless deck · 1 = the old hard v3 grid. */
  const DEPTH = { wallShadow: 0.5, sheen: 0.14, cornerAO: 0.55, dither: 0.15, floorWear: 0.55, floorDetail: 1, wallDetail: 1, deckSeam: 0.38 };   // dither 0.15 = Andrew's dialed value (2026-07-13 crtlab COPY VALUES)

  const CORNER = {
    tl: { cx: 1, cy: 1, a0: Math.PI, a1: 1.5 * Math.PI },
    tr: { cx: 0, cy: 1, a0: 1.5 * Math.PI, a1: 2 * Math.PI },
    bl: { cx: 1, cy: 0, a0: 0.5 * Math.PI, a1: Math.PI },
    br: { cx: 0, cy: 0, a0: 0, a1: 0.5 * Math.PI }
  };

  /* per-bake state (a bake runs synchronously start→finish, so module locals are safe) */
  const CHUNK_PX = 384;
  // walls reach outside the footprint — invalidate that far too. Takes the MAX of both rises: it
  // read WALL.up only, which was safe purely because corUp happened to be smaller. That is a
  // coincidence, not an invariant, and a crtlab preset can invert it in one slider drag (the
  // shipped 'Towering' preset sets corUp 15) — a corUp above up would then under-invalidate on a
  // chunk bake and leave a stale strip of wall behind.
  const dirtyPadPx = () => pad + Math.max(WALL.skirt, Math.max(WALL.up, WALL.corUp) + WALL.capH + 8) + 48;
  let G, T, HR, W, H, VX, VY, CW, CH, lampPos, edges, chamferAt, extN;
  const h2 = (x, y, s) => U.hash(x + ',' + y + ',' + (s || ''));

  /* ---------- THE ONE ROUNDED-CORNER RASTER ----------
     Every curve in the station is a quarter circle at a tile corner, and they must all agree to the
     pixel or the corner reads as misaligned. This is the single source: walk the corner's pixel
     ROWS and hand back the integer x at which the curve crosses. A quarter circle crosses each row
     exactly once, so the walk is complete and gap-free — no fractional rects, no stroked arcs, no
     anti-aliasing against the deck's hard pixels. Sampling at the row's CENTRE (py + 0.5) and
     rounding is the shared convention: the hull silhouette erase, the hull rim, the ambient-mask
     cut and the room's interior curve all use it, so concentric curves stay concentric per-pixel.
     Keyed on bake-pixel coords, so chunk↔monolithic parity holds. */
  function eachCornerRow(kind, ax, ay, rad, fn) {
    const A = CORNER[kind];
    const ox = Math.round(A.cx ? ax - rad : ax), oy = Math.round(A.cy ? ay - rad : ay);
    const r = Math.round(rad);
    for (let py = oy; py < oy + r; py++) {
      const ady = Math.abs(py + 0.5 - ay);
      const ex = ady >= r ? null : (A.cx ? Math.round(ax - Math.sqrt(r * r - ady * ady))
                                        : Math.round(ax + Math.sqrt(r * r - ady * ady)));
      fn(py, ex, ox, ox + r, A);
    }
  }
  /* cut the hull's rounded corner. Was a clip('evenodd') + fill, which anti-aliased the station's
     whole silhouette — the soft outer fuzz that survived the interior-curve fix. */
  function eraseSpandrel(g, kind, ax, ay, rad) {
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    eachCornerRow(kind, ax, ay, rad, (py, ex, ox, oxEnd, A) => {
      if (ex == null) { g.fillRect(ox, py, oxEnd - ox, 1); return; }        // row wholly outside the disc
      if (A.cx) { if (ex > ox) g.fillRect(ox, py, ex - ox, 1); }
      else if (ex + 1 < oxEnd) g.fillRect(ex + 1, py, oxEnd - ex - 1, 1);
    });
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
     user-chosen now (WorldModel.FLOOR_MATERIALS → REFIT ▧ SURFACE), not just a per-kind default:
       grate — open catwalk mesh: top-lit bars over a dark void, substructure glimpsed below.
       hex   — honeycomb cells on an offset lattice: advanced-tech, nothing else here is non-rectilinear.
       plank — staggered wood boards: per-board tone, grain hairlines, occasional knot.
       turf  — hydroponic growth: pure blade scatter, NO lattice at all. The absence of a grid
               is the whole point; it is what separates a grown surface from a built one.

     V5 replaces `plate` as the HAB default with `spine` (see the note above deckSpine). `plate` is
     NOT deleted — it stays in the palette as the classic, so a station that preferred the old deck
     can still choose it, and no existing station loses a look it was built with. Every room carries
     `floorMat: null` (inherit), so the swap reaches stations built before it existed — which is the
     point: the default deck is the one surface every player sees and it had aged. */
  // FALLBACK ONLY — projected geometry always carries matOf, so this map is not what you see in
  // game. WorldModel.ROOM_KINDS[kind].mat is the authority; keep the two in step.
  const MAT_BY_KIND = { hab: 'spine', corridor: 'spine', bridge: 'panel', lab: 'tile', factory: 'tread', storage: 'tread', quarters: 'soft' };
  const MAT_PITCH = { plate: [2, 2], panel: [4, 1], tile: [2, 2], tread: [2, 2], soft: [3, 2], grate: [1, 1], hex: [1, 1], plank: [5, 1], turf: [1, 1], spine: [4, 3], runner: [2, 2], treadway: [3, 2], meshway: [3, 3] };
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
  /* VIVID LIGHTEN — for the GROWTH materials only (turf, hedge).
     U.shade lerps toward WHITE, so every lightening step desaturates: fern lightened by +0.4 goes
     from saturation 0.43 to 0.11 — a grass blade lifted far enough to read as a highlight stops
     being green and turns silver. That is why capping the lift only made the lawn duller instead of
     greener (Andrew 2026-07-25: "grass is too white, I want Terraria grass").
     This pushes the colour's DOMINANT channel hard and the others barely, so the ramp gains
     lightness while GAINING saturation. Every built surface keeps U.shade — plating should wash
     toward the light. Growth must not. Negative f falls through to U.shade: darkening toward black
     already preserves hue. */
  const vivid = (hex, f) => {
    if (f <= 0) return U.shade(hex, f);
    const n = parseInt(String(hex).slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const mx = Math.max(r, g, b) || 1;
    const lift = c => { const s = c / mx; return Math.min(255, c + (255 - c) * f * s * s); };
    return '#' + ((1 << 24) | (Math.round(lift(r)) << 16) | (Math.round(lift(g)) << 8) | Math.round(lift(b))).toString(16).slice(1);
  };

  const hp = (a, c, k) => {
    let n = (Math.imul(a | 0, 374761393) + Math.imul(c | 0, 668265263) + Math.imul(k | 0, 1442695041)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
  };

  /* ---------- per-tile deck painters — one per material ----------
     Each paints ONE tile in that tile's own base colour. bakeDeck AND the REFIT palette
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
    // the plate JOINT rides DEPTH.deckSeam — see the knob's note. The body tone above is NOT scaled
    // by it, so softening the seam blends the plates together without flattening the deck.
    const sk = Math.max(0, DEPTH.deckSeam);
    if (lx === 0) { px(X, Y, 1, T, sh(-0.30 * sk)); px(X + 1, Y, 1, T, sh(body + 0.07 * sk)); }   // grout + lit west bevel
    if (ly === 0) { px(X, Y, T, 1, sh(-0.30 * sk)); px(X, Y + 1, T, 1, sh(body + 0.07 * sk)); }   // grout + lit north bevel
    if (lx === PW - 1) px(X + T - 1, Y, 1, T, sh(body - 0.14 * sk));                              // shaded east bevel
    if (ly === PH - 1) px(X, Y + T - 1, T, 1, sh(body - 0.14 * sk));                              // shaded south bevel
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
    const sk = Math.max(0, DEPTH.deckSeam);                      // board joints ride the same knob
    px(X, Y, T, T, base);
    px(X, Y, T, T, sh(body));
    px(X, Y, T, 1, sh(body + 0.10 * sk));                        // lit top edge of the board
    px(X, Y + T - 2, T, 1, sh(body - 0.10 * sk));                // shadow into the gap
    px(X, Y + T - 1, T, 1, sh(body - 0.30 * sk));                // the gap between boards
    if (rel === 0) { px(X, Y, 1, T, sh(body - 0.32 * sk)); px(X + 1, Y, 1, T, sh(body + 0.06 * sk)); }   // butt-end seam
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
    const cl = ((clump % 5) - 2) * 0.018;
    /* v3 (2026-07-25, matched against a real grass reference). v2 gave every blade an INDEPENDENT
       random tone off a 5-step ramp, and that is the whole reason it read as static rather than as
       grass: with no correlation between neighbours, no pixel belongs to the pixel beside it, so the
       eye finds noise where it wants tufts. Real grass is CLUMPED — a patch of blades catches the
       light together, and the gaps between patches fall into shadow together.
       So tone is no longer random per blade. It comes from a two-octave value FIELD sampled on
       ABSOLUTE bake-pixel coords: a coarse octave (~8px) that mottles the lawn at tuft scale, and a
       mid octave (~3px) that breaks each tuft into strands. Neighbouring pixels sample almost the
       same field value, so they share a tone and read as one clump — and because the field is keyed
       on absolute coords rather than position-in-tile, tufts continue straight across tile borders
       and chunk↔monolithic parity still holds. */
    /* SHEARED cells. Sampling the field on plain axis-aligned blocks made the lawn a quilt of
       squares — the clumps were the right size but the wrong SHAPE, because every cell boundary
       lined up with its neighbours in both axes. Offsetting x by a function of y staggers the
       boundaries so clump edges break up and stop reading as a grid. */
    const oct = (ax, ay, size, salt) => {                        // -1..1, constant within a sheared cell
      const sx = ax + Math.floor(ay / size) * ((size >> 1) + 1);
      const r = hp(Math.floor(sx / size) * size, Math.floor(ay / size) * size, salt);
      return ((r % 7) - 3) / 3;
    };
    /* Every lift goes through vivid(), never U.shade — U.shade lerps toward WHITE, so the brightest
       blades come out the greyest pixels on the deck ("the grass is too white"). The value range is
       deliberately TIGHT: a dark understory under bright blades reads as confetti. Saturation does
       the separating, not value. */
    /* AMPLITUDE IS LOW ON PURPOSE (±0.13, not ±0.20). At the wider spread the lawn read as
       camouflage blotches: the clumps were legible but they no longer belonged to one surface. The
       reference is a cohesive mid-olive field whose tufts are a STEP off each other, and a mid-tone
       has to dominate for the whole thing to read as one lawn. */
    px(X, Y, T, T, vivid(base, (cl + 0.06) * fd));               // the MAT — a cohesive field, not a void
    for (let cy = 0; cy < T; cy += 2) for (let cx = 0; cx < T; cx += 2) {
      const ax = X + cx, ay = Y + cy;
      const v = 0.56 * oct(ax, ay, 6, 'g1') + 0.44 * oct(ax, ay, 2, 'g2');   // 6px tufts, 2px strands
      const tone = cl + 0.10 + 0.13 * v;
      px(ax, ay, 2, 2, vivid(base, tone * fd));                  // tuft body: 2×2 so a clump has area
      const r = hp(ax, ay, 7);
      // strands ON the tuft, one step off ITS OWN tone (not off a global ramp) so a blade always
      // belongs to the clump it sits in. Mixed orientation — grass is matted, not a picket fence.
      const bx = cx + (r & 1), by = cy + ((r >>> 2) & 1);
      if (by < T && (r >>> 4) % 7 !== 0) {                       // denser than v2: strands are the texture
        const lit = vivid(base, (tone + 0.10) * fd);
        if (((r >>> 7) & 3) === 0) px(X + bx, Y + by, Math.min(2, T - bx), 1, lit);  // lying flat
        else px(X + bx, Y + by, 1, Math.min(2 + ((r >>> 9) & 1), T - by), lit);      // standing
      }
      if (v < -0.62) px(X + bx, Y + by, 1, 1, vivid(base, (cl - 0.09) * fd));   // shadow deep in a gap
    }
    for (let i = 0; i < 2; i++) {                                // taller blades breaking the canopy
      const r = hp(X, Y, 90 + i);
      const by = (r >>> 6) % (T - 3);
      px(X + (r % T), Y + by, 1, 4, vivid(base, (cl + 0.26) * fd));
    }
    /* DRY BLADES — the one legitimate U.shade LIFT on this deck. The law is "never use U.shade to
       lighten anything that must keep its hue", and a dead blade is precisely the thing that must
       LOSE its hue: bleached straw is desaturated and lighter, which is exactly the direction
       U.shade travels. Sparse — a couple of flecks per few tiles, or the lawn reads as dying. */
    if ((clump % 3) === 0) {
      const r = hp(X, Y, 71);
      px(X + (r % T), Y + ((r >>> 6) % T), 1, 1 + ((r >>> 12) & 1), U.shade(base, (0.30 + cl) * fd));
    }
    if ((clump % 7) === 0) { const r = hp(X, Y, 99); px(X + (r % T), Y + ((r >>> 6) % T), 1, 1, vivid(base, (cl + 0.48) * fd)); }   // seed head
  }

  /* ---------- SPINE · the deck that replaces `plate` as the hab default (2026-07-25) ----------
     `plate` was a uniform 24px grid of identical slabs with random specks dropped on it. Two things
     dated it: EVERY MODULE WAS THE SAME SIZE, which reads as bathroom tile rather than engineering,
     and its detail was scattered at random instead of composed — a hatch means nothing when it
     could be anywhere. SPINE fixes both: big STAGGERED 4×3 plates (so no module lines up with its
     neighbour above), each read as a discrete bolted panel — recess inside the joint, four corner
     fixings, brushed grain — under a heavier TRANSVERSE structural seam every third band. That
     seam is the hierarchy: one strong line, then joints, then surface grain.

     NO LONGITUDINAL SERVICE CHANNEL. The first cut ran a recessed trench (dark inner wall, lit lip,
     grating ticks) every 6 tiles, and it was the design's centrepiece — it gave the deck direction.
     Andrew cut it on sight: at station scale a room shows only two or three of them, so they don't
     read as a rhythm, they read as two black bars ruled across the floor. Do not reintroduce a
     full-height vertical line here without looking at a whole room first — the trench looked
     correct in every close-up and wrong in every wide shot, which is the trap this deck sets. */
  function deckSpine(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => U.shade(base, d * fd);
    const sk = Math.max(0, DEPTH.deckSeam);
    const band = Math.floor(y / 3), off = (band % 2) * 2;
    const pcx = Math.floor((x - off) / 4);
    const lx = ((x - off) % 4 + 4) % 4, ly = ((y % 3) + 3) % 3;
    const pn = h2(pcx, band, z + ':sp');
    const body = ((pn % 5) - 2) * 0.013;
    px(X, Y, T, T, sh(body));
    for (let i = 1; i < T; i += 3) px(X, Y + i, T, 1, sh(body + ((i & 1) ? 0.026 : -0.020)));   // brushed grain
    // PLATE AS A PANEL — a 1px recess just inside the joint on the plate's own outer edges, so a
    // plate reads as a discrete bolted panel instead of a cell in a grid.
    if (lx === 0) px(X + 2, Y, 1, T, sh(body - 0.09));
    if (lx === 3) px(X + T - 3, Y, 1, T, sh(body - 0.09));
    if (ly === 0) px(X, Y + 2, T, 1, sh(body - 0.09));
    if (ly === 2) px(X, Y + T - 3, T, 1, sh(body - 0.09));
    if (lx === 0) { px(X, Y, 1, T, sh(-0.26 * sk)); px(X + 1, Y, 1, T, sh(body + 0.07 * sk)); } // plate joint
    if (ly === 0) { px(X, Y, T, 1, sh(-0.26 * sk)); px(X, Y + 1, T, 1, sh(body + 0.07 * sk)); }
    // bolts at EVERY plate corner, not one — four fixings is what makes it read as fastened down
    const bolt = (bx, by) => { px(bx, by, 2, 2, sh(0.15)); px(bx, by, 1, 1, sh(0.27)); px(bx + 1, by + 1, 1, 1, sh(-0.22)); };
    if (ly === 0 && lx === 0) bolt(X + 3, Y + 3);
    if (ly === 0 && lx === 3) bolt(X + T - 5, Y + 3);
    if (ly === 2 && lx === 0) bolt(X + 3, Y + T - 5);
    if (ly === 2 && lx === 3) bolt(X + T - 5, Y + T - 5);
    // a heavier TRANSVERSE structural seam every third band — a cross-rhythm, so the deck has two
    // scales of line rather than one.
    if (((y % 9) + 9) % 9 === 0) { px(X, Y, T, 1, sh(-0.34)); px(X, Y + 1, T, 1, sh(0.09)); }
  }

  /* ---------- THE CORRIDOR DECK CANDIDATES (2026-07-28) ----------
     Andrew, after the hallway deck was moved onto the room material: "it doesnt really look good in
     my opinion, make a new tile set for the hallway to better match". A hallway sharing the rooms'
     deck exactly is correct about CONTINUITY and wrong about CHARACTER — spine's 4×3 panels are
     sized for a room's span, and in a 3-tile passage you only ever see a sliver of one.

     All three are AXIS-NEUTRAL on purpose. A corridor can run either way, `paintDeck` is not told
     which, and the REFIT palette samples the same function for its chip — a recipe that assumed
     "along the walk" would be wrong half the time in game and always wrong in the swatch. Direction
     is not the job of the deck here; it was tried as a full-length channel and deleted twice
     (SPINE's service trench, then the old corridor's gutters).
     Each one carries ONE idea, per the wall lane's finding that a second element competes with the
     first rather than supporting it. */

  /* RUNNER — spine's own vocabulary at a corridor's scale: bolted panels, brushed grain, four
     corner fixings, and the heavier transverse seam. The only change is PITCH, 4×3 → 2×2, because
     plate size follows span — a narrow passage is decked in narrower plates, which is true of real
     structures and is why this reads as the same station rather than a different one. The most
     conservative of the three: it matches by speaking the identical language. */
  function deckRunner(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const sh = d => U.shade(base, d * fd);
    const sk = Math.max(0, DEPTH.deckSeam);
    const band = Math.floor(y / 2), off = (band % 2);
    const pcx = Math.floor((x - off) / 2);
    const lx = ((x - off) % 2 + 2) % 2, ly = ((y % 2) + 2) % 2;
    const pn = h2(pcx, band, z + ':rn');
    const body = ((pn % 5) - 2) * 0.013;
    px(X, Y, T, T, sh(body));
    for (let i = 1; i < T; i += 3) px(X, Y + i, T, 1, sh(body + ((i & 1) ? 0.024 : -0.018)));   // brushed grain
    if (lx === 0) px(X + 2, Y, 1, T, sh(body - 0.09));                                          // panel recess
    if (lx === 1) px(X + T - 3, Y, 1, T, sh(body - 0.09));
    if (ly === 0) px(X, Y + 2, T, 1, sh(body - 0.09));
    if (ly === 1) px(X, Y + T - 3, T, 1, sh(body - 0.09));
    if (lx === 0) { px(X, Y, 1, T, sh(-0.26 * sk)); px(X + 1, Y, 1, T, sh(body + 0.07 * sk)); }  // plate joint
    if (ly === 0) { px(X, Y, T, 1, sh(-0.26 * sk)); px(X, Y + 1, T, 1, sh(body + 0.07 * sk)); }
    const bolt = (bx, by) => { px(bx, by, 2, 2, sh(0.15)); px(bx, by, 1, 1, sh(0.27)); px(bx + 1, by + 1, 1, 1, sh(-0.22)); };
    if (ly === 0 && lx === 0) bolt(X + 3, Y + 3);
    if (ly === 0 && lx === 1) bolt(X + T - 5, Y + 3);
    if (ly === 1 && lx === 0) bolt(X + 3, Y + T - 5);
    if (ly === 1 && lx === 1) bolt(X + T - 5, Y + T - 5);
    if (((y % 6) + 6) % 6 === 0) { px(X, Y, T, 1, sh(-0.32)); px(X, Y + 1, T, 1, sh(0.09)); }    // transverse structural seam
  }

  /* TREADWAY — raised anti-slip DIAMOND plate, the surface real gangways and service passages are
     actually floored in. A lattice of small lozenges, each lit on its up-screen face and shaded
     below, so the deck reads as textured-for-grip rather than panelled. The one deck in the catalog
     whose marks are not axis-aligned, which is exactly what stops it reading as another grid: the
     diamonds sit on absolute bake-pixel coords (not tile-local), so the lattice crosses tile
     borders unbroken and a chunk bake lands identically to a monolithic one. */
  function deckTreadway(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    // every stud is clipped to THIS tile: the lattice is absolute, the painting is per-tile
    const pxc = (a, c, w, h, col) => {
      const a0 = Math.max(X, a), a1 = Math.min(X + T, a + w);
      const c0 = Math.max(Y, c), c1 = Math.min(Y + T, c + h);
      if (a1 <= a0 || c1 <= c0) return;
      b.fillStyle = col; b.fillRect(a0, c0, a1 - a0, c1 - c0);
    };
    const sh = d => U.shade(base, d * fd);
    const sk = Math.max(0, DEPTH.deckSeam);
    const pcx = Math.floor(x / 3), pcy = Math.floor(y / 2);
    const pn = h2(pcx, pcy, z + ':tw');
    const body = ((pn % 5) - 2) * 0.011;
    px(X, Y, T, T, sh(body));
    const lit = sh(body + 0.20), dim = sh(body - 0.20);
    /* THE MARK IS A BAR, NOT A DOT. Real chequer (durbar) plate is raised TEARDROPS laid in
       alternating diagonal pairs — the alternation is the whole reason it reads as a manufactured
       anti-slip surface instead of a field of studs. A round-ish lozenge on a lattice came out as a
       repeating glyph, which is the same failure mode as any mark that has a silhouette of its own:
       the eye reads the shape, not the surface. Each bar here is 3px long with a 1px rise across it,
       lit along the top and shaded along the bottom, and the lean flips on (row + col) parity. */
    const P = 5;
    const r0 = Math.floor(Y / P), r1 = Math.floor((Y + T - 1) / P);
    for (let r = r0; r <= r1; r++) {
      const cy = r * P, ox = (((r % 2) + 2) % 2) ? 2 : 0;
      const c0 = Math.floor((X - ox) / P), c1 = Math.floor((X + T - 1 - ox) / P);
      for (let c = c0; c <= c1; c++) {
        const cx = c * P + ox;
        if (((r + c) & 1) === 0) {          // leans up to the right
          pxc(cx, cy + 1, 2, 1, lit);  pxc(cx + 2, cy, 1, 1, lit);
          pxc(cx, cy + 2, 2, 1, dim);  pxc(cx + 2, cy + 1, 1, 1, dim);
        } else {                             // leans up to the left
          pxc(cx, cy, 1, 1, lit);      pxc(cx + 1, cy + 1, 2, 1, lit);
          pxc(cx, cy + 1, 1, 1, dim);  pxc(cx + 1, cy + 2, 2, 1, dim);
        }
      }
    }
    if (x % 3 === 0) px(X, Y, 1, T, sh(-0.24 * sk));                                             // plate joint
    if (y % 2 === 0) px(X, Y, T, 1, sh(-0.24 * sk));
    px(X, Y, T, T, 'rgba(0,0,0,' + (0.04 * fd).toFixed(3) + ')');                                // knock the stud contrast back a touch
    if (pn % 6 === 0) { px(X + 2, Y + 2, 2, 2, sh(0.14)); px(X + 3, Y + 3, 1, 1, sh(-0.20)); }    // occasional fixing
  }

  /* MESHWAY — a solid deck PERFORATED for drainage: a regular field of small dark holes, each with
     a catch-lit upper rim, punched through a plain plate. Its ancestor is GRATE, but where grate is
     an open catwalk that reads from its voids, this is a floor you could set a crate on — the holes
     are a detail on a surface, not the surface itself. The busiest of the three; kept honest by
     having no plate dressing at all beyond the joints, so the perforation is the only idea. */
  function deckMeshway(b, base, x, y, X, Y, z, n, fd) {
    const px = (a, c, w, h, col) => { b.fillStyle = col; b.fillRect(a, c, w, h); };
    const pxc = (a, c, w, h, col) => {
      const a0 = Math.max(X, a), a1 = Math.min(X + T, a + w);
      const c0 = Math.max(Y, c), c1 = Math.min(Y + T, c + h);
      if (a1 <= a0 || c1 <= c0) return;
      b.fillStyle = col; b.fillRect(a0, c0, a1 - a0, c1 - c0);
    };
    const sh = d => U.shade(base, d * fd);
    const sk = Math.max(0, DEPTH.deckSeam);
    const pcx = Math.floor(x / 3), pcy = Math.floor(y / 3);
    const pn = h2(pcx, pcy, z + ':mw');
    const body = ((pn % 5) - 2) * 0.012;
    px(X, Y, T, T, sh(body));
    px(X, Y + 1, T, 1, sh(body + 0.05));                                                          // faint rolled grain
    const hole = sh(body - 0.44), rim = sh(body + 0.16);
    const P = 4;                                                                                  // perforation lattice, absolute coords
    const r0 = Math.floor(Y / P), r1 = Math.floor((Y + T - 1) / P);
    const c0 = Math.floor(X / P), c1 = Math.floor((X + T - 1) / P);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const hx = c * P + 1, hy = r * P + 1;
      pxc(hx, hy - 1, 2, 1, rim);                                                                 // catch-lit upper rim
      pxc(hx, hy, 2, 2, hole);
    }
    if (x % 3 === 0) { px(X, Y, 1, T, sh(-0.28 * sk)); px(X + 1, Y, 1, T, sh(body + 0.06 * sk)); }
    if (y % 3 === 0) { px(X, Y, T, 1, sh(-0.28 * sk)); px(X, Y + 1, T, 1, sh(body + 0.06 * sk)); }
  }

  function paintDeck(b, mat, base, x, y, X, Y, z, n, fd) {
    if (mat === 'runner') return deckRunner(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'treadway') return deckTreadway(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'meshway') return deckMeshway(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'spine') return deckSpine(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'grate') return deckGrate(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'hex') return deckHex(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'plank') return deckPlank(b, base, x, y, X, Y, z, n, fd);
    if (mat === 'turf') return deckTurf(b, base, x, y, X, Y, z, n, fd);
    return deckSlab(b, mat, base, x, y, X, Y, z, n, fd);
  }

  /* THE ONE DECK PAINTER — every walkable tile in the station, room or corridor, comes through
     here (2026-07-28). It used to be rooms only, and `bakeCorridorFloor` was a wholly separate,
     PRE-V2 painter that hand-rolled a slab-tread look and never called `matOf`/`paintDeck` at all.
     So a corridor's declared material was DEAD ART: `ROOM_KINDS.corridor.mat` is 'spine', set to
     match `hab` precisely so "a corridor doesn't read as a different floor through the doorway"
     (worldmodel.js), and the bake threw it away — spine, plate, grate, turf and plank all baked
     byte-identical corridor pixels. That is the whole of Andrew's "the hallway floor seems very
     outdated": it was not a dated recipe, it was NO recipe, frozen before the material axis existed.
     A user could even paint a hallway from REFIT and watch nothing happen, which is the truthful-
     telemetry law failing in the art layer.
     LAW: one surface class, one painter. A second painter for "the same thing but narrower" does
     not stay in sync — it silently stops receiving every improvement the first one gets. */
  function bakeDeck(b, r) {
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
        /* The catch-lit room-facing edge is drawn BEFORE the trim's darkening, and rides
           DEPTH.deckSeam. Two bugs here, both showing as a bright 1px column running the room's
           ENTIRE length one tile inside each side wall (Andrew 2026-07-24: "the line that divides
           the left and right side wall"):
             1. it was an OPAQUE fill derived from the raw `base`, so it punched straight through the
                trim's own 6% darkening AND through the plate work — the column reset to base tone
                and therefore read brighter than the deck no matter how small the delta got;
             2. at a flat 0.06 the delta was +20 luminance on top of that.
           Painting it first and letting the trim overlay darken it too keeps it a gentle LIFT
           relative to the border course it belongs to, instead of a hole punched through it. */
        const tk = 'rgba(255,246,224,' + (Math.max(0, DEPTH.deckSeam) * 0.05 * fd).toFixed(3) + ')';
        if (wN && !wS) px(X, Y + T - 1, T, 1, tk);
        if (wS && !wN) px(X, Y, T, 1, tk);
        if (wW && !wE) px(X + T - 1, Y, 1, T, tk);
        if (wE && !wW) px(X, Y, 1, T, tk);
        px(X, Y, T, T, 'rgba(6,7,10,' + (0.06 * fd).toFixed(3) + ')');
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

  /* A CORRIDOR IS THE STATION'S DECK PLUS EXACTLY ONE IDEA — the tracks the crew wears into it.
     Everything else the old corridor painter drew (a hard tread seam on every tile row, rib bands
     on a 7px pitch, staggered chevrons, and a full-length gutter hugging each long wall) was a
     second visual system competing with the deck material underneath it, and every one of those
     marks ran the corridor's WHOLE length. That is the mark the SPINE deck's service channel was
     deleted for: a full-run trench reads as a system in a close-up and as an arbitrary bar in the
     space itself. The wall lane taught the same thing from the other side — of three candidates
     for a 23px wall face, the EMPTY bay beat both busy ones, because a second element between the
     columns competes with them instead of supporting them.
     So the traffic lanes stay and the rest goes. They earn it by being the one mark that is TRUE
     of a corridor and not of a room: a hallway is a thing people walk down, and foot-polish down
     the middle is that fact rendered. They also ride DEPTH.floorWear, so they are wear, not
     decoration, and they vanish with the rest of the wear at 0. */
  function bakeCorridorFloor(b, r) {
    bakeDeck(b, r);
    const wear = Math.max(0, DEPTH.floorWear);
    if (wear <= 0.001) return;
    const vertical = (r.y2 - r.y1) > (r.x2 - r.x1);
    const x1 = r.x1 * T, y1 = r.y1 * T, rw = (r.x2 - r.x1 + 1) * T, rh = (r.y2 - r.y1 + 1) * T;
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
    // matches the station's own pixel idiom (see bakeDeck / bakeTallNorthFace: no low-alpha
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
    // hairline. NOTHING SHIPPED TAKES THIS PATH ANY MORE — it is reachable only from the crtlab
    // 'Flat (old)' preset. Corridors used to live here at corUp:0, which is why they had no lit
    // crown: this branch paints none, and a wall with no crown does not read as a wall at all.
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
    crown(b, X, topY - capH, T, capH, pal.cap);
    crown(b, X, topY - capH, T, 1, U.shade(pal.cap, 0.30));                          // 1px lighter top edge
    b.fillStyle = U.shade(pal.cap, -0.45); b.fillRect(X, topY - 1, T, 1);            // 1px darker seam beneath
    // THE FACE — per material
    (WALL_RECIPES[wallMatOf(e.z)] || WALL_RECIPES.plating)(b, pal, X, topY, h, e, n, room, Y + inFace);
    // FLOOR-CONTACT SEAM. This used to be a LIGHT line (wallTop), which is exactly backwards: a
    // highlight at the junction fuses the wall into the deck. Where a vertical surface meets a
    // horizontal one, no light reaches — it is the darkest line in the room, and it is what tells
    // the eye "the floor stops here".
    b.fillStyle = U.shade(pal.base, -0.62); b.fillRect(X, Y + inFace, T, 1);
  }

  /* ---------- WALL RECIPES — one per material, each painting ONE tile's interior face ----------
     Signature: (b, pal, X, topY, h, e, n, room, footY). `pal` is the room's derived wall palette,
     `h` the full face height, `footY` the floor-contact row. Every mark is opaque and stepped off
     `pal.face`, deterministic on the tile hash / bake-pixel coords, and scaled by DEPTH.wallDetail
     so 0 gives a flat unadorned face. A recipe owns the face ONLY — never the crown or the foot. */
  const wallDet = () => Math.max(0, DEPTH.wallDetail);

  /* the foot every recipe shares — a graded skirt of shadow pooling where the wall meets the deck.
     Deliberately NOT scaled all the way out by wallDetail: even a "flat" wall must stay seated on
     the floor, and this band is what seats it. Three hard steps, darkest at the contact line. */
  function wallFoot(b, tone, X, footY, wd) {
    b.fillStyle = U.shade(tone, -0.16 - 0.08 * wd); b.fillRect(X, footY - 4, T, 4);
    b.fillStyle = U.shade(tone, -0.30 - 0.10 * wd); b.fillRect(X, footY - 2, T, 2);
    b.fillStyle = U.shade(tone, -0.46 - 0.12 * wd); b.fillRect(X, footY - 1, T, 1);
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
    // foliage lifts go through vivid() for the same reason the TURF deck's do: U.shade would take
    // the lit leaves toward white and the hedge would read as a grey bush.
    const body = U.shade(pal.base, -0.34 * wd);
    b.fillStyle = body; b.fillRect(X, topY, T, h);
    const LEAF = [U.shade(pal.base, -0.20 * wd), vivid(pal.base, 0.10 * wd), vivid(pal.base, 0.30 * wd), vivid(pal.base, 0.50 * wd)];
    const leaves = Math.max(8, Math.round(T * h / 6));
    for (let i = 0; i < leaves; i++) {
      const r = hp(X, topY, i);
      const ly = (r >>> 5) % h;
      // darker toward the base, where light doesn't reach into the foliage
      const k = 1 - 0.45 * (ly / Math.max(1, h));
      b.fillStyle = U.shade(LEAF[(r >>> 11) & 3], -(1 - k) * 0.5);
      b.fillRect(X + (r % T), topY + ly, 1, Math.min(1 + ((r >>> 14) % 2), h - ly));
    }
    b.fillStyle = vivid(pal.base, 0.62 * wd); b.fillRect(X + (hp(X, topY, 91) % T), topY, 1, 2);   // lit crown sprig
    wallFoot(b, body, X, footY, wd);
  }

  /* ---------- BASE-WALL CANDIDATES (2026-07-25) ----------
     `plating` is dated in exactly the ways `plate` was, plus one of its own:
       1. ONE SEAM PER TILE. A 24px cell repeated the length of the room, every cell the same
          width — the wall reads as bathroom tile, not as a built bulkhead.
       2. FEATURES PLACED AT RANDOM. The rivet, the vent panel and the conduit drop are all
          `n % k` on the tile hash, so they land wherever and mean nothing.
       3. NO DEPTH. Every mark is painted ON one flat plane. Nothing is in front of anything
          else, so a 23px-tall face has no structure to read — one rail carries the whole wall.
     The fixes are the deck's: rhythm at a WIDER interval than the tile, features on a LOGIC, and
     a hierarchy — structure first, then panel, then rail, then grain. All three keep the crown,
     the foot and the contact seam untouched (a recipe owns the face only) and scale by wallDetail.

     Vertical budget is tight: h = WALL.up + NFACE = 23px, of which the bottom 4 are the foot
     shadow. Detail finer than ~3px does not survive the ambient bake — go coarse. */

  /* A · BULKHEAD — a raised STANCHION every 3 tiles instead of a seam every tile, with one wide
     recessed infill panel spanning the bay between them. The stanchion is the wall's structure:
     it carries the fixings (a bolt at head and foot, nowhere else), and the bumper rail BREAKS at
     it, so the rail reads as segments held between columns rather than a stripe painted over
     everything. Gives the wall the vertical rhythm the SPINE deck deliberately lacks. */
  /* the pilaster every BULKHEAD variant shares: a raised column standing in front of the infill.
     It STARTS BELOW THE CROWN and stays dimmer than it — drawn from topY with a bright edge it
     read as a fence post standing ON the wall top at room scale, because the crown is the
     brightest continuous line in the room and anything vertical touching it joins it. */
  function wallPilaster(b, sh, X, topY, footY, w, bolts) {
    const px = (a, c, wd_, ht, col) => { b.fillStyle = col; b.fillRect(a, c, wd_, ht); };
    const sy = topY + 2, ht = footY - sy;
    px(X, sy, w, ht, sh(0.05));                                                        // column body, in front
    px(X, sy, 1, ht, sh(-0.32));                                                       // its cast shadow
    px(X + w - 1, sy, 1, ht, sh(0.11));                                                // its lit edge
    if (bolts) {
      const bolt = (by) => { px(X + 1, by, 2, 2, sh(0.13)); px(X + 2, by + 1, 1, 1, sh(-0.24)); };
      bolt(sy + 2); bolt(footY - 8);                                                   // head and foot only
    }
  }

  /* BULKHEAD — the base wall since 2026-07-25, replacing `plating`. A slim pilaster every 2 tiles
     and NOTHING between them: the bay is left flush, the rail runs unbroken, and the rhythm of the
     columns alone carries the wall.

     Three versions were built and Andrew picked this one. The other two put work INTO the bay — a
     framed recess in one, two riveted courses in the other — and both lost to the empty bay. That
     is the lesson worth keeping: on a face only 23px tall with a bright crown above it and a
     shadowed foot below, the wall has room for ONE idea. Adding a second thing between the columns
     competes with the columns instead of supporting them. If you are tempted to dress this bay,
     render a whole room first and compare it against this. */
  function wallBulkhead(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const px = (a, c, w, ht, col) => { b.fillStyle = col; b.fillRect(a, c, w, ht); };
    const bay = Math.floor(e.x / 2), tx = ((e.x % 2) + 2) % 2;      // tx 0 = the pilaster tile
    const body = U.shade(pal.face, ((h2(bay, e.y, 'bht') % 5) - 2) * 0.014 * wd);
    const sh = d => U.shade(body, d * wd);
    px(X, topY, T, h, body);
    wallFoot(b, body, X, footY, wd);                                                  // seated first, marks over it
    px(X, topY + 2, T, 1, sh(0.07));                                                  // a single lit line under the crown
    const rail = topY + Math.round(h * 0.62);
    px(X, rail, T, 2, sh(-0.22));
    px(X, rail, T, 1, sh(0.11));
    if (tx === 0) wallPilaster(b, sh, X, topY, footY, 3, false);
  }

  /* B · COURSES — riveted hull plating, all horizontal: three stacked courses, each with a lit top
     lip over a shadowed underside, and vertical butt joints every 4 tiles STAGGERED course to
     course so no joint runs the full height. Rivets march along each lip on a fixed 6px pitch —
     a row of fixings, not a sprinkle. The calm option; it never competes with a prop. */
  function wallCourses(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const px = (a, c, w, ht, col) => { b.fillStyle = col; b.fillRect(a, c, w, ht); };
    const usable = (footY - 4) - topY;
    const cuts = [0, Math.round(usable * 0.36), Math.round(usable * 0.70)];
    for (let ci = 0; ci < cuts.length; ci++) {
      const y0 = topY + cuts[ci], y1 = topY + (ci + 1 < cuts.length ? cuts[ci + 1] : usable);
      const cn = h2(Math.floor((e.x - ci * 2) / 4), ci, 'crs');
      const body = U.shade(pal.face, (((cn % 5) - 2) * 0.018 - ci * 0.035) * wd);     // lower courses darker
      const sh = d => U.shade(body, d * wd);
      px(X, y0, T, y1 - y0, body);
      px(X, y0, T, 1, sh(0.16));                                                      // lit course lip
      px(X, y1 - 1, T, 1, sh(-0.30));                                                 // shadowed underside
      if ((((e.x - ci * 2) % 4) + 4) % 4 === 0) {                                     // staggered butt joint
        px(X, y0, 1, y1 - y0, sh(-0.34));
        px(X + 1, y0, 1, y1 - y0, sh(0.09));
      }
      // rivet row on the lip. Pitch 8 not 6 and lift 0.15 not 0.22: at room scale a tighter,
      // brighter row stops reading as fixings and starts reading as perforation.
      for (let rx = 4; rx < T; rx += 8) px(X + rx, y0 + 2, 1, 1, sh(0.15));
    }
    wallFoot(b, pal.face, X, footY, wd);
  }

  /* C · SERVICE — big calm panels carrying ONE composed horizontal service run: a conduit at a
     fixed height with brackets every 2 tiles and a junction box every 4th, so a feature appears
     because a run passes through, never because a hash said so. The wall equivalent of the deck's
     original idea, kept HORIZONTAL — a run along the wall's length is one line the whole room
     shares, which is what the vertical trenches on the deck failed to be. */
  function wallService(b, pal, X, topY, h, e, n, room, footY) {
    const wd = wallDet();
    const px = (a, c, w, ht, col) => { b.fillStyle = col; b.fillRect(a, c, w, ht); };
    const pan = Math.floor(e.x / 4), lx = ((e.x % 4) + 4) % 4;
    const body = U.shade(pal.face, ((h2(pan, e.y, 'svc') % 5) - 2) * 0.015 * wd);
    const sh = d => U.shade(body, d * wd);
    px(X, topY, T, h, body);
    for (let i = 4; i < h - 5; i += 5) px(X, topY + i, T, 1, sh(-0.04));              // faint grain
    if (lx === 0) { px(X, topY, 1, h, sh(-0.30)); px(X + 1, topY, 1, h, sh(0.08)); }  // panel joint every 4 tiles
    const run = topY + Math.round(h * 0.34);                                          // THE SERVICE RUN
    px(X, run, T, 3, sh(-0.20));
    px(X, run, T, 1, sh(-0.34));                                                      // its shadowed top
    px(X, run + 2, T, 1, sh(0.15));                                                   // catch-lit underside
    if (lx % 2 === 0) { px(X + 5, run - 1, 2, 5, sh(-0.28)); px(X + 5, run - 1, 2, 1, sh(0.12)); }  // bracket
    if (lx === 2 && room) {                                                            // junction box ON the run
      px(X + 9, run - 2, 7, 7, sh(0.04));                                              // 7x7, not 8x9: a 23px
      px(X + 9, run - 2, 7, 1, sh(0.16));                                              // face cannot carry a
      px(X + 9, run + 4, 7, 1, sh(-0.32));                                             // box a third of its height
      px(X + 11, run + 1, 3, 1, sh(-0.24));
    }
    const rail = topY + Math.round(h * 0.72);                                          // bumper rail, kept
    px(X, rail, T, 2, sh(-0.22));
    px(X, rail, T, 1, sh(0.12));
    wallFoot(b, body, X, footY, wd);
  }

  const WALL_RECIPES = {
    plating: wallPlating, ribbed: wallRibbed, panelled: wallPanelled,
    viewport: wallViewport, pipework: wallPipework, wainscot: wallWainscot, hedge: wallHedge,
    bulkhead: wallBulkhead, courses: wallCourses, service: wallService
  };

  /* how wide the LIT TOP SURFACE is on a wall that is not extruded up-screen. Hard-clamped to
     pad-1 — past that the crown falls outside the ambient plate and burns against the starfield
     (see the WALL.sideCap note).

     ONE RING, ONE WIDTH — CORRIDORS INCLUDED (2026-07-28, Andrew on a vertical hallway between two
     rooms: "can we add walls properly to the hallways?"). This used to shrink to 0.6 for corridors
     "the same way corUp < up", and the two are NOT the same knob. `corUp` is how far a wall is
     STOOD UP, a real style choice: a lower corridor reads as a tunnel, a taller room as a hall.
     `sideCap` is how WIDE that wall's top surface is — i.e. how thick the bulkhead is — and a
     hallway's bulkhead is the same slab of station as the room's it connects. Shrinking it bought
     no tunnel read at all; it just made the one surface that DEFINES a wall from directly above
     three pixels of near-nothing, so a hallway read as a dark slot you look through while the rooms
     either side had obvious standing walls. Worse, the ring visibly STEPPED 5→3 at every junction,
     which is the same "the crown stops here" failure the corners had. A wall's height may differ
     between space types; its top surface may not. */
  const sideCapW = () => Math.max(2, Math.min(pad - 1, Math.round(WALL.sideCap)));

  /* WHERE A CORNER ARC'S CENTRE SITS. Bottom corners: the chamfer's own centre — the outline is
     the plain quarter circle and this is a no-op. Top corners: moved UP so the arc's topmost point
     lands on the straight north wall's outline, i.e. `centre = thatLine + HR`. DERIVED, not tuned,
     and derived at BOTH ends at once — the arc's leftmost point is then at `ax - HR = X - pad`,
     which is exactly the e/w wall's outer edge. Circle tangents there are vertical and at the top
     horizontal, so the arc leaves one straight wall and meets the other with no kink at either end,
     for any WALL.up. Clamped at `ay`: a wall with no rise keeps the plain flat corner rather than
     inventing a lift below it (reachable via the crtlab 'Flat (old)' preset; corridors sat here
     while corUp was 0, though they carry no chamfers of their own either way). */
  const cornerArcCy = (kind, ay, Y, HR, room) => {
    if (kind !== 'tl' && kind !== 'tr') return ay;
    const up = Math.round(room ? WALL.up : WALL.corUp);
    if (up <= 0) return ay;
    return Math.min(ay, Y - up - Math.max(2, Math.round(WALL.capH)) - 2 + HR);
  };

  /* THE CROWN-WIDTH EASE. A wall's top surface is `capW` wide where it is read from directly above
     (every e/w/s straight) and `capH` where it has been stood up and is read as a face (the north
     straight); around a chamfer it crosses between the two. It used to ease to NOTHING and dim out,
     because at the side end there was no side crown to hand off to — a cap kept at full thickness
     over a wall receded to zero read as a bright bar ruled across the corner ("the thick diagonal
     lines", 2026-07-25). Now the ease runs INTO that crown. The law both halves of that history
     teach: the cap must never be wider than the surface it crowns at either end of the arc. */
  const crownEase = (tt, capW, capFar) => Math.max(1, Math.round(capW + (capFar - capW) * tt));

  /* WHAT THE CROWN NARROWS TO AT THE FAR END OF A CORNER ARC — i.e. the width of whatever straight
     wall waits there. Only a TOP corner ends on an extruded wall, whose crown is genuinely
     foreshortened to capH; a BOTTOM corner joins two walls that are both read from straight above,
     so both ends are capW and the ring must hold ONE width the whole way round.
     It taper-pinched to capH at the bottom two for a while, which put a 5 -> 3 -> 5 waist at exactly
     the corner — the ring visibly thinning right where the eye is following it round (Andrew:
     "lets perfect the corners on the bottom"). A constant-width band is what reads as a turn. */
  const cornerCapFar = (kind, capW, capH) => (kind === 'tl' || kind === 'tr') ? capH : capW;

  /* THE CORNER'S SHARE OF THE CROWN RING. On the straights the wall's lit top surface is a rect;
     around a chamfer it is the band just inside the station's own outline, and without it the ring
     broke at all four corners — which is exactly the "cuts off as if there's only a back wall"
     read, because the two TOP corners are where the eye follows the bright line and loses it.

     ---- THE OUTLINE IS ONE CIRCLE, AND A TOP CORNER LIFTS IT RIGIDLY (2026-07-27) ----
     Two rounds of this were wrong, and both failures are worth keeping because both are easy to
     walk back into.

     ROUND 1 — TWO PROFILES. The flat ring followed the hull curve while a separate column sweep
     rose 0 → WALL.up across only the DECK curve's columns, and the hull reaches `pad` further out
     than that sweep ever began. The outline stepped inward where the sweep started, then kinked
     onto a much steeper staircase. Two curves meeting at an angle is not a corner, it is a notch.

     ROUND 2 — ONE PROFILE, BUT SHEARED. Displacing the ring by a per-column EASED amount is a
     shear, and a sheared circle is not a circle: its curvature piles up where the ease is steepest.
     Andrew, tracing the arc he wanted over a screenshot: "it needs to perfectly curve at the top
     left and the top right the same way it does on the bottom." An ease cannot do that, however
     smooth the easing function is. LAW: NEVER EASE THE OUTLINE ITSELF.

     What is actually true: the wall's top surface is the footprint ring translated up-screen by the
     wall's height, and a RIGID TRANSLATION PRESERVES A CIRCLE. So the outer boundary here is the
     same radius-HR quarter circle the bottom corners use, with its centre moved up to `cy` — and
     the region it vacates is simply wall FACE, which is what standing the wall up exposes.

     `cy` is DERIVED so both ends land tangentially, which is what makes the join invisible:
       · centre y = (the straight north wall's outline top) + HR, so the arc's topmost point sits
         exactly on that line with a HORIZONTAL tangent;
       · the arc's leftmost point is then at ax - HR = X - pad, which IS the e/w wall's outer edge,
         with a VERTICAL tangent — so it leaves the side wall without a kink.
     Below that leftmost point the outline is simply the vertical run at ax - HR, which is how the
     ring crosses the chamfer tile and reaches the straight side wall underneath.

     Only the LADDER WIDTH eases (crownEase, capW → capH), never the boundary: a top surface really
     is foreshortened where you see it edge-on. Bottom corners pass cy = ay and are unchanged. */
  function bakeCornerCrown(b, pal, kind, X, Y, ax, ay, Rc, HR, capW, capFar, cy, record) {
    const A = CORNER[kind];
    const outX = A.cx ? -1 : 1, outY = A.cy ? -1 : 1;      // which way is "away from the room"
    // the ring may hang past the tile into the VOID (that is where every wall's height lives) but
    // never into the tile behind it, which is this room's own walkable floor.
    /* HALF-OPEN VS INCLUSIVE — the one-pixel jog. A footprint plate spans [c - pad, c + pad), so its
       LAST painted row/column is `c + pad - 1`, while the circle crossing `round(centre + HR)` is
       the first pixel PAST the art. On the -ve side (west/north) `centre - HR` already lands on the
       first painted pixel and the two agree; on the +ve side (east/south) the ring sat one pixel
       proud of the plate and its whole ladder shifted with it, so a bottom corner met the south
       straight's crown one row low. The hull rim walk has always carried the same `ex - 1`
       correction — the ring simply did not. Keep them together. */
    const xLo = outX < 0 ? Math.round(ax - HR) : X, xHi = outX < 0 ? X + T : Math.round(ax + HR);
    const yLo = outY < 0 ? Math.round(cy - HR) : Y, yHi = outY < 0 ? Y + T : Math.round(cy + HR);
    const lit = U.shade(pal.cap, 0.30), seam = U.shade(pal.cap, -0.45);
    const put = (x, y, w, h, c) => {
      const x0 = Math.max(xLo, x), x1 = Math.min(xHi, x + w);
      const y0 = Math.max(yLo, y), y1 = Math.min(yHi, y + h);
      if (x1 <= x0 || y1 <= y0) return;
      b.fillStyle = c; b.fillRect(x0, y0, x1 - x0, y1 - y0);
      // the ring's crown tones join the straights' in the ambient cut — a corner that stayed
      // under full ambient beside a lifted straight would be the same inversion, just localised.
      if (c === pal.cap || c === lit) crownRects.push([x0, y0, x1 - x0, y1 - y0]);
      if (!record) return;
      for (let ix = x0; ix < x1; ix++) { const p = record.get(ix); if (p === undefined || y0 < p) record.set(ix, y0); }
    };
    const K = HR * Math.SQRT1_2;              // the 45° split between the two duals
    /* the DECK's own curve is the inner limit for the face fill — everything from the ladder down
       to it is wall face. Same centre and rounding convention as the deck cut itself, so the face
       stops exactly where the floor starts. */
    const deckXAt = py => {
      const ady = Math.abs(py + 0.5 - ay);
      if (ady >= Rc) return null;
      const d = Math.sqrt(Rc * Rc - ady * ady);
      return outX < 0 ? Math.round(ax - d) : Math.round(ax + d);
    };
    const deckYAt = ix => {
      const adx = Math.abs(ix + 0.5 - ax);
      if (adx >= Rc) return null;
      const d = Math.sqrt(Rc * Rc - adx * adx);
      return outY < 0 ? Math.round(ay - d) : Math.round(ay + d);
    };
    // ROW dual — the steep stretch (and the vertical run below it), where the ring hands off to
    // the e/w wall. A row walk lays a HORIZONTAL span, which is ACROSS the outline only here.
    for (let py = yLo; py < yHi; py++) {
      const t = outY < 0 ? cy - (py + 0.5) : (py + 0.5) - cy;    // distance along the lift axis
      if (t >= HR) continue;                                      // past the top of the arc
      if (t > K) continue;                                        // shallow — the column dual owns it
      // below the arc's widest point the outline is simply the straight run at the e/w wall's edge
      const off = t <= 0 ? HR : Math.sqrt(HR * HR - t * t);
      const ex = outX < 0 ? Math.round(ax - off) : Math.round(ax + off) - 1;   // -1: see the half-open note above
      const w = crownEase(Math.max(0, t) / HR, capW, capFar);
      const dx = deckXAt(py), inner = dx == null ? (outX < 0 ? X + T : X - 1) : dx;
      if (outX < 0) {
        put(ex, py, 1, 1, wallDk);                                             // the shell's own edge
        put(ex + 1, py, w, 1, pal.cap); put(ex + 1, py, 1, 1, lit);            // the lit top surface
        put(ex + 2 + w, py, Math.max(0, inner - (ex + 2 + w)), 1, pal.face);   // face, down to the deck
        put(ex + 1 + w, py, 1, 1, seam);
      } else {
        // the lit edge is the crown's OUTERMOST row, i.e. ex - 1 here — putting it on `ex` paints
        // over the shell edge and rules a near-white line along the station's own silhouette.
        put(ex, py, 1, 1, wallDk);
        put(ex - w, py, w, 1, pal.cap); put(ex - 1, py, 1, 1, lit);
        put(inner + 1, py, Math.max(0, (ex - 1 - w) - inner), 1, pal.face);
        put(ex - 1 - w, py, 1, 1, seam);
      }
    }
    // COLUMN dual — the shallow stretch, where the ring hands off to the n/s wall.
    for (let ix = xLo; ix < xHi; ix++) {
      const adx = Math.abs(ix + 0.5 - ax);
      if (adx >= K) continue;                                     // steep — the row dual owns it
      const s = Math.sqrt(HR * HR - adx * adx);
      const ey = outY < 0 ? Math.round(cy - s) : Math.round(cy + s) - 1;       // -1: see the half-open note above
      const w = crownEase(s / HR, capW, capFar);
      const dy = deckYAt(ix), inner = dy == null ? (outY < 0 ? Y + T : Y - 1) : dy;
      if (outY < 0) {
        put(ix, ey, 1, 1, wallDk);
        put(ix, ey + 1, 1, w, pal.cap); put(ix, ey + 1, 1, 1, lit);
        put(ix, ey + 2 + w, 1, Math.max(0, inner - (ey + 2 + w)), pal.face);
        put(ix, ey + 1 + w, 1, 1, seam);
      } else {
        put(ix, ey, 1, 1, wallDk);
        put(ix, ey - w, 1, w, pal.cap); put(ix, ey - 1, 1, 1, lit);   // outermost crown row, not the shell edge
        put(ix, inner + 1, 1, Math.max(0, (ey - 1 - w) - inner), pal.face);
        put(ix, ey - 1 - w, 1, 1, seam);
      }
    }
  }

  function bakeWalls(b) {
    for (const e of edges) {
      const X = e.x * T, Y = e.y * T;
      if (e.door) { bakeThreshold(b, e, X, Y); continue; }
      const fw = e.room ? FACEW : 2, out = e.room ? 4 : 2, face = e.room ? NFACE : 5;
      const dep = fw + 1, rib = 'rgba(0,0,0,0.25)';
      // the SIDE faces (s/w/e) and interior seams carry the room's own wall tone too — otherwise a
      // cobalt room's tall north wall would meet three brown-grey walls at its corners.
      const pal = wallPal(e.z), wallFace = pal.face, wallTop = pal.top;
      /* A SIDE WALL IS SEEN AS ITS TOP SURFACE, and that surface is a BAND, not a line.
         THE CROWN IS A RING, NOT A BACK WALL (2026-07-27, Andrew, tracing the missing left edge in
         a screenshot: "it seems to cut off as if there's only a back wall ... on the left and right
         side there doesn't really feel like there's a real wall there"). Only the north wall is
         extruded up-screen, so it is the only one whose HEIGHT you can read directly; every other
         wall is seen from straight above and is read ENTIRELY by its lit top surface. That surface
         used to be 3px of `U.shade(base,-0.22)` — DARKER than the deck it encloses — fronting 9px
         of global near-black hull, so the bright crown that defines a wall at any zoom simply
         STOPPED at the two top corners and the e/w sides read as "the floor ends here".
         The fix is not more contrast, it is the SAME LADDER bakeTallNorthFace paints, read outward
         instead of upward, so one continuous top surface runs the whole silhouette:
             contact seam (darkest) · inner face · dark under-seam · CROWN · lit outer edge · hull
         Nothing spikes above its neighbours — the -0.22 crest's original complaint (a bright 1px
         divider column, 2026-07-24) is avoided because the crown is a WIDE band with its highlight
         on the outer edge, where the hull is, not stranded in the middle of the wall. */
      const crownLit = U.shade(pal.cap, 0.30), crownSeam = U.shade(pal.cap, -0.45);
      const cw = sideCapW();
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
        // the south wall is seen as its TOP surface plus the shadow it drops onto the deck in
        // front of it — same contact-seam law as the north face, mirrored. Its top surface can
        // only ever hang SOUTH of the tile: extruding it toward the viewer like the north wall
        // would bury the walkable row in front of it.
        b.fillStyle = U.shade(pal.base, -0.62); b.fillRect(X, Y + T - dep, T, 1);
        b.fillStyle = wallFace; b.fillRect(X, Y + T - fw, T, fw);                 // the sliver of face still inside the tile
        b.fillStyle = rib; b.fillRect(X + 5, Y + T - fw, 1, fw);
        if (e.exterior) {
          b.fillStyle = wallDk; b.fillRect(X, Y + T, T, Math.max(out, cw + 2));   // outer hull band
          crown(b, X, Y + T + 1, T, cw, pal.cap);                                 // the wall's LIT TOP SURFACE
          crown(b, X, Y + T + cw, T, 1, crownLit);                                // lit outer edge
          b.fillStyle = crownSeam; b.fillRect(X, Y + T, T, 1);                    // dark seam under the crown
        } else {
          b.fillStyle = U.shade(pal.base, -0.22); b.fillRect(X, Y + T - fw, T, 2);   // interior seam keeps the quiet crest
        }
      } else if (e.side === 'w') {
        b.fillStyle = U.shade(pal.base, -0.62); b.fillRect(X + fw, Y, 1, T);      // contact seam onto the deck
        b.fillStyle = wallFace; b.fillRect(X, Y, fw, T);
        b.fillStyle = rib; b.fillRect(X, Y + 5, fw, 1);
        if (e.exterior) {
          const side = Math.max(out, cw + 2, Math.round(WALL.side));   // the hull band under the crown — one width, corridors included (see sideCapW)
          b.fillStyle = wallDk; b.fillRect(X - side, Y, side, T);          // outer hull band — the shell, global tone
          b.fillStyle = 'rgba(0,0,0,0.35)'; b.fillRect(X - side, Y, 1, T);
          crown(b, X - 1 - cw, Y, cw, T, pal.cap);                         // the wall's LIT TOP SURFACE
          crown(b, X - 1 - cw, Y, 1, T, crownLit);                         // lit outer edge
          b.fillStyle = crownSeam; b.fillRect(X - 1, Y, 1, T);             // dark seam under the crown
        }
      } else {
        b.fillStyle = U.shade(pal.base, -0.62); b.fillRect(X + T - dep, Y, 1, T);
        b.fillStyle = wallFace; b.fillRect(X + T - fw, Y, fw, T);
        b.fillStyle = rib; b.fillRect(X + T - fw, Y + 5, fw, 1);
        if (e.exterior) {
          const side = Math.max(out, cw + 2, Math.round(WALL.side));   // the hull band under the crown — one width, corridors included (see sideCapW)
          b.fillStyle = wallDk; b.fillRect(X + T, Y, side, T);
          b.fillStyle = 'rgba(0,0,0,0.35)'; b.fillRect(X + T + side - 1, Y, 1, T);
          crown(b, X + T + 1, Y, cw, T, pal.cap);
          crown(b, X + T + cw, Y, 1, T, crownLit);
          b.fillStyle = crownSeam; b.fillRect(X + T, Y, 1, T);
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
    /* ...and above a TOP corner the raised strip has to follow the wall's EASED top instead of
       staying square. eraseSpandrel above only cuts the corner out of the FOOTPRINT plate; the
       wall-height strip kept its square corner while the ring it stands for eases down around the
       chamfer, so ambient mask was left lying over bare space — a shadow hanging outside the hull,
       invisible against pure black but plain against the SpaceBG starfield. Same law as the
       straight wall top: the mask must never cover pixels the art doesn't paint.
       THE REACH IS READ BACK FROM THE PAINTER (`crownReach`), never recomputed. A mask edge
       derived a second time to match the art is exactly what drifted before, and it drifts again
       the moment the corner's shape changes — as it just did. Erase only ABOVE the art: the crown
       itself belongs under the ambient like the rest of the interior. */
    if (WALL.up > 0) {
      const upC = Math.round(WALL.up);
      mg.save();
      mg.globalCompositeOperation = 'destination-out';
      mg.fillStyle = '#000';
      for (const [ccx, ccy, kind] of G.chamfers) {
        if (kind !== 'tl' && kind !== 'tr') continue;
        const stripTop = ccy * T - (upC + capH + 2), X0 = ccx * T;
        const rm = crownReach.get(ccx + ',' + ccy);
        for (let ix = X0; ix < X0 + T; ix++) {
          const reach = rm && rm.get(ix);
          const artTop = reach === undefined || reach === null ? ccy * T : reach;   // no ring here → the footprint plate is the top
          if (artTop > stripTop) mg.fillRect(ix, stripTop, 1, artTop - stripTop);
        }
      }
      mg.restore();
      /* ...and the other half of the same law: the corner ring reaches a full `pad` FURTHER OUT
         than the straight north wall's strip does (the strip spans the footprint width only), so
         those columns had lit crown standing OUTSIDE the ambient plate — which renders at its raw
         baked tone against the starfield, the blazing-line failure the WALL.sideCap note describes.
         Add mask over exactly what the painter recorded, so cover and art are the same shape. */
      for (const [ccx, ccy, kind] of G.chamfers) {
        if (kind !== 'tl' && kind !== 'tr') continue;
        const X0 = kind === 'tl' ? ccx * T - pad : ccx * T, X1 = X0 + T + pad, bottom = ccy * T + T;
        const rm = crownReach.get(ccx + ',' + ccy);
        if (!rm) continue;
        for (let ix = X0; ix < X1; ix++) {
          const reach = rm.get(ix);
          if (reach === undefined || reach >= bottom) continue;
          mg.fillRect(ix, reach, 1, bottom - reach);
        }
      }
    }
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
    /* THE CROWN CUT — a flat, hard-edged pull on the ambient over every rect the crown painted, so
       the wall's lit top surface always reads ABOVE the hull skirt outside it (the skirt hangs in
       void, deliberately outside the ambient plate, so it renders at a flat luma 58 and used to
       out-shine a 38 crown at the dark end of a room). MULTIPLICATIVE by construction — it is one
       more destination-out on the same layer — so the crown still falls off away from the lamps
       exactly like every other surface; it just never falls under the shell. Hard-edged, not a
       gradient: it stands for a surface, not a light source. */
    if (LIGHT.crown > 0.001) {
      L.fillStyle = 'rgba(0,0,0,' + Math.min(1, LIGHT.crown).toFixed(3) + ')';
      for (const [x, y, w, h] of crownRects) L.fillRect(x, y, w, h);
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
    // distant (or mid-build, not-yet-connected) rooms stays open instead of one rim crossing space.
    // SOURCE-ATOP like the seam grid above: the rim is a rectangle, but the hull it frames has had
    // its rounded corners erased by the chamfer pass. Painting it unclipped left the rim's square
    // corner (and its bolts) hanging in empty space beside every rounded corner — the little
    // detached "ladder" fragments. Clipping to existing hull pixels is the whole fix.
    b.globalCompositeOperation = 'source-atop';
    b.lineWidth = 2;
    for (const r of G.allRects) {
      const x1 = r.x1 * T - pad, y1 = r.y1 * T - pad, x2 = (r.x2 + 1) * T + pad, y2 = (r.y2 + 1) * T + pad;
      b.strokeStyle = '#28241b'; b.strokeRect(x1 + 1, y1 + 1, x2 - x1 - 2, y2 - y1 - 2);
      b.fillStyle = '#302b21';
      for (let x = x1 + 6; x < x2; x += 18) { b.fillRect(x, y1 + 2, 2, 2); b.fillRect(x, y2 - 4, 2, 2); }
      for (let y = y1 + 6; y < y2; y += 18) { b.fillRect(x1 + 2, y, 2, 2); b.fillRect(x2 - 4, y, 2, 2); }
    }
    b.globalCompositeOperation = 'source-over';

    // floors
    for (const r of G.allRects) (G.isCorridor(r.z) ? bakeCorridorFloor : bakeDeck)(b, r);
    bakeEdgeAO(b);
    bakeCorridorDressing(b);
    bakeWalls(b);

    /* The chamfer pass runs BEFORE bakeRoomLighting (2026-07-25). It used to run after, which made
       a rounded corner the only surface in the room the ceiling lights never touched — the corner
       read as a dark blob beside a lit wall, and no amount of geometric alignment fixes that,
       because the mismatch is tonal. Lighting the corner with everything else is what actually
       makes it connect. */
    // chamfer floor-cut + curved interior wall pass
    for (const [ccx, ccy, kind] of G.chamfers) {
      const X = ccx * T, Y = ccy * T, A = CORNER[kind], ax = X + A.cx * T, ay = Y + A.cy * T;
      // a rounded corner belongs to the room it was cut from — take that room's wall palette so a
      // coloured room's corner arc doesn't revert to the old universal brown-grey.
      const cPal = wallPal(G.zoneGrid[G.idx(ccx, ccy)]);
      /* ONE INTEGER CURVE, SHARED BY EVERY LAYER (2026-07-24). This corner used to be six
         anti-aliased arc() strokes at six different radii (T+2.25, T-2.5, T-5.5, HR-2, T-5..T)
         plus a clip()+fill at radius T for the deck cut — so the deck ended on one curve, the wall
         face sat on another and the crown on a third, and every one of them was AA'd against the
         deck's hard 1px pixels. That is the ragged, unaligned corner.
         Now: a single radius Rc is rasterized into exact per-ROW integer spans. A quarter circle
         crosses each pixel row exactly once, so the spans are complete and gap-free, and the deck
         cut, the wall face band and the outer dark band are all cut from that same edge — the deck
         stops exactly where the wall starts. The face band TAPERS from the side wall's thickness at
         the side end of the arc to the north wall's NFACE at the north end, so the corner flows
         into whichever straight wall it meets instead of stepping. */
      const Rc = T;                                  // THE chamfer radius — every layer uses this one
      const sgnX = A.cx ? -1 : 1, sgnY = A.cy ? -1 : 1;
      const fill = (x, y, w, h, c) => { if (w > 0 && h > 0) { b.fillStyle = c; b.fillRect(x, y, w, h); } };
      const outerBand = U.shade(cPal.base, -0.62);   // the same contact-seam tone the straight walls use
      const vFace = sgnY < 0 ? NFACE : FACEW;   // top corners meet the deep north face; bottom ones the thin south wall
      const aIn = Math.max(1, Rc - FACEW), bIn = Math.max(1, Rc - vFace);
      eachCornerRow(kind, ax, ay, Rc, (py, edge) => {
        const ady = Math.abs(py + 0.5 - ay);
        if (edge == null) { fill(X, py, T, 1, hullC); return; }       // row lies wholly outside the curve
        /* THE INNER BOUNDARY IS AN ELLIPSE, NOT A CIRCLE — this is the whole reason corners never
           quite met their walls. The deck's edge at a rounded corner has to land on TWO straight
           walls: x = Xroom + FACEW on the side wall (4px) and y = Yroom + NFACE on the north wall
           (9px). At T=12 those sit 8 and 3 from the corner's centre, so NO single radius can touch
           both — a concentric circle, however finely rasterized, is guaranteed to miss one of them,
           and it was missing the north wall by 2px (Andrew drew the line: 2026-07-25).
           Semi-axes Rc-FACEW and Rc-<the n/s wall's own depth> make it meet both dead on, and the
           face thickness then tapers from the side wall's to the north wall's entirely on its own —
           no hand-tuned taper term, which is what the old `faceW` guess was. */
        /* Rows the ellipse doesn't reach carry no inner boundary at all: the face runs to the tile
           edge and there is NO contact seam. Forcing the inner x to the centre instead put it exactly
           on the tile boundary and painted the seam tone there every such row — a dark 1px stripe
           down the handoff column, drawn OVER the straight wall's face. Everything is clamped to the
           chamfer's own tile now, so no layer can reach into its neighbour. */
        const ty = ady / bIn;
        const hasInner = ty < 1;
        const dxIn = hasInner ? aIn * Math.sqrt(1 - ty * ty) : 0;
        const inner = hasInner ? (sgnX < 0 ? Math.round(ax - dxIn) : Math.round(ax + dxIn))
                               : (sgnX < 0 ? X + T : X);
        const clamp = (x0, x1, c) => fill(Math.max(X, x0), py, Math.min(X + T, x1) - Math.max(X, x0), 1, c);
        if (sgnX < 0) clamp(X, edge, hullC); else clamp(edge + 1, X + T, hullC);      // 1. cut the deck
        if (sgnX < 0) clamp(edge - 3, edge, outerBand); else clamp(edge + 1, edge + 4, outerBand);
        /* 2. the face: BODY, then a shadowed foot where it meets the deck. Deliberately NO lit top
           course in here — the straight wall's lit course sits 14px higher, up in the crown, so its
           in-tile face is body+foot too. Painting a course at the tile's outer edge instead put a
           lum-65 band against a lum-32 wall (the ellipse's b semi-axis is only 3px, so most rows
           never reach it and fell into the "outer sliver" case, which lit the WHOLE run). The lit
           top belongs to the crown raster on the tall side and to the crest band on the side wall. */
        const lo = Math.min(edge, inner), hi = Math.max(edge, inner);
        clamp(lo, hi + 1, cPal.face);
        if (hasInner) {
          // the foot mirrors wallFoot's depth AND grading exactly (4px / 2px / 1px, -0.24 / -0.40 /
          // -0.58). A 2px flat foot against the straight wall's graded 4px one left the corner ~9
          // luminance brighter than the wall it joins, which reads as a mismatch even once the
          // geometry lines up.
          for (const [d, k] of [[4, -0.24], [2, -0.40], [1, -0.58]]) {
            if (sgnX < 0) clamp(Math.max(lo, inner - d), inner, U.shade(cPal.face, k));
            else clamp(inner + 1, Math.min(hi + 1, inner + 1 + d), U.shade(cPal.face, k));
          }
          clamp(inner, inner + 1, outerBand);                                        // contact seam onto the deck
        }
      });
      /* The inner boundary is nearly HORIZONTAL where it meets the north/south wall and nearly
         VERTICAL where it meets the side wall. A per-ROW walk lays exactly one seam pixel per row,
         which is right on the steep stretch but leaves the shallow one sparse — so against the
         straight wall the deck appeared to start a row early and the contact line broke up. Walk the
         COLUMNS as well and lay the seam at the ellipse's y: the contact line is then continuous the
         whole way round and terminates on both straight walls' own seams. Same row/column duality
         the crown needed. */
      for (let ix = X; ix < X + T; ix++) {
        const adx = Math.abs(ix + 0.5 - ax);
        if (adx >= aIn) continue;
        const dy = bIn * Math.sqrt(1 - (adx / aIn) * (adx / aIn));
        const py = sgnY < 0 ? Math.round(ay - dy) : Math.round(ay + dy);
        if (py < Y || py >= Y + T) continue;
        // same graded foot as the row pass, so the shallow stretch is shaded like the steep one
        for (const [d, k] of [[4, -0.24], [2, -0.40], [1, -0.58]]) {
          for (let j = 1; j <= d; j++) {
            const fy = sgnY < 0 ? py - j : py + j;
            if (fy >= Y && fy < Y + T) fill(ix, fy, 1, 1, U.shade(cPal.face, k));
          }
        }
        fill(ix, py, 1, 1, outerBand);
      }
      const cRoom = !G.isCorridor(G.zoneGrid[G.idx(ccx, ccy)]);
      const cCy = cornerArcCy(kind, ay, Y, HR, cRoom);   // the outline circle's centre — lifted on a top corner
      // HULL RIM — the outer silhouette's own curve (HR), concentric with the interior one and now
      // rasterized off the SAME row walk, so the two curves stay a fixed pixel distance apart all
      // the way round instead of one being a crisp staircase beside a soft anti-aliased stroke.
      // It rides the SAME centre as the ring: left at ay on a lifted corner it would rule a rim
      // straight across the middle of the standing wall face.
      eachCornerRow(kind, ax, cCy, HR, (py, ex) => {
        if (ex == null) return;
        fill(A.cx ? ex : ex - 1, py, 2, 1, '#28241b');
      });

      /* THE CROWN RING carries the wall's lit top surface around the arc, so the bright line that
         defines a wall does not die at the corners — and on a TOP corner the SAME circle, centred
         higher, is also what stands the wall up. One profile, one radius, no ease on the outline. */
      const cCapW = sideCapW();
      let reach = null;
      if (kind === 'tl' || kind === 'tr') crownReach.set(ccx + ',' + ccy, reach = new Map());
      bakeCornerCrown(b, cPal, kind, X, Y, ax, ay, Rc, HR, cCapW,
                      cornerCapFar(kind, cCapW, Math.max(2, Math.round(WALL.capH))), cCy, reach);
    }

    bakeRoomLighting(b);   // after the chamfers, so a rounded corner is lit like every other surface

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
    crownRects = [];       // ...and the crown rects the ambient cut reads back
    crownReach = new Map();   // ...and the corner crown's measured reach, which the mask erase reads back
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
