/* STARNET — terrain.js : THE GROUND. What the station is standing ON.

   THIS IS NOT A BACKDROP, AND THE DIFFERENCE IS THE WHOLE POINT.

   spacebg.js draws things at a DISTANCE, in screen space, deliberately not zooming — correct for
   a starfield or a sea a long way below. Terrain is at the SAME PLANE as the station: it must pan
   AND zoom with it, or the illusion dies on the first scroll-wheel tick. The camera zooms 0.5x to
   6x (world.js MINZ/MAXZ), a 12x range, so faking that in screen space would fall apart violently.

   So the ground is drawn in WORLD space, between world.js's setTransform() and the station bake.
   At that seam the camera transform is already applied, which means panning, zooming and the
   station's own coordinate frame all come for free — no parallax maths, no toroidal wrap, no
   camera plumbing.

   THREE layers, because they fail differently:
     1. THE PATCH — soil, moss, litter. Fine texture, tiled with createPattern (ONE fillRect, not
        hundreds of drawImage). Fine texture can repeat every few hundred pixels invisibly.
     2. THE FIELD — a world-space value noise that decides how much grows WHERE. This is what the
        first forest lacked: it scattered trees at a flat 38% everywhere, so the eye read an even
        stipple with no groves, no glades and no edges. Density variation is structure, and
        structure is most of what "detailed" actually means.
     3. THE SCATTER — trees, logs, ferns, boulders. These CANNOT tile: a repeating tree is
        instantly legible as wallpaper. They are placed by hashing world cell coordinates, which
        gives an infinite non-repeating field with no stored map, drawn from pre-rendered sprites
        so a crown costs one drawImage rather than four hundred stamps every frame.

   The station stands in a CLEARING: scatter is suppressed inside the station's world rect plus a
   margin, and thickened just outside it, because a real clearing has a dense edge.

   WHY THE FIRST FOREST WAS SCRAPPED (2026-07-24, Andrew: "too blurry… just looks like an outline
   of a forest") and what is different here:
     - Crowns were 8 overlapping anti-aliased arcs. A blob with a lit rim IS an outline. Crowns are
       now built from hundreds of hard 1-3px LEAF STAMPS lit by a dome+sun term, with holes punched
       through them, so the mass has interior texture and the ground shows through it.
     - One species. There are now five silhouettes (broadleaf, conifer, birch, snag, sapling) and a
       conifer does not read as a maple from any distance.
     - No layering. Items are y-sorted and overlap, which is the only cue that says "canopy" rather
       than "stickers".
     - Flat lighting. A tiled DAPPLE pass now puts sun through the canopy onto the floor, so the
       floor has large-scale light structure instead of uniform noise. */
'use strict';

const Terrain = (typeof document === 'undefined') ? { active: () => false } : (() => {

  /* ---------------------------------------------------------------- shared helpers ---- */

  const TAU = Math.PI * 2;
  const mkCv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const rgba = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (+a).toFixed(3) + ')';
  const rgb = c => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

  /* Sample a colour RAMP (array of rgb triples) at t in [0,1] — quantized to the ramp's own
     entries, never interpolated. Interpolation is what makes pixel art look like a photograph:
     every neighbouring pixel differs slightly, so nothing has an edge. Flat bands have edges. */
  const ramp = (R, t) => R[Math.max(0, Math.min(R.length - 1, Math.round(clamp01(t) * (R.length - 1))))];

  /* Sample a ramp with HASH DITHERING between the two adjacent steps.
     Rounding to the nearest step draws a hard contour wherever the underlying field crosses a
     boundary, and those contours are shaped like the field's low-frequency octave — which is
     exactly how a grey plain turns into CAMOUFLAGE. Dithering replaces each contour with a
     probabilistic mix of the two neighbouring colours: the palette stays quantized (still pixel
     art, still flat bands) but the band EDGES stop being drawn. It is the oldest trick in the
     medium and it is the difference between regolith and a pattern of continents. */
  function dither(R, t, x, y, k) {
    const f = clamp01(t) * (R.length - 1);
    let i = Math.floor(f);
    if (h01(x, y, k) < f - i) i++;
    return R[Math.max(0, Math.min(R.length - 1, i))];
  }

  /* HARD-EDGE a sprite: snap every pixel's alpha to fully on or fully off.
     Canvas path fills (arc, ellipse) are ALWAYS anti-aliased — there is no flag to turn it off —
     so anything drawn from paths carries a soft fringe, and the world transform then blows that
     fringe up by the zoom factor. At 4x a one-pixel fringe becomes a four-pixel smear, which is
     exactly the "blurry" this exists to kill. Everything a sprite wants to keep must be drawn
     OPAQUE — anything translucent is erased by this pass, by design. */
  function hardEdge(cv) {
    const c = cv.getContext('2d');
    const img = c.getImageData(0, 0, cv.width, cv.height), d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
    c.putImageData(img, 0, 0);
    return cv;
  }

  function mulberry32(seed) {
    let a = seed | 0;
    return () => {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* A stable hash of a world CELL -> [0,1). ALLOCATION-FREE on purpose: the draw loop calls this
     tens of thousands of times a frame at low zoom, and the old closure-per-cell version handed
     the GC a bag of garbage every frame for no reason. */
  function h01(cx, cy, k) {
    let h = Math.imul(cx | 0, 374761393) ^ Math.imul(cy | 0, 668265263) ^ Math.imul(k | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /* Value noise over the INFINITE world lattice (not a wrapping tile). This is THE FIELD: it says
     where the forest is thick and where it opens out. Smoothstep interpolation, hashed corners —
     nothing stored, identical every visit. */
  function vnoise(x, y, k) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = h01(ix, iy, k), b = h01(ix + 1, iy, k);
    const c = h01(ix, iy + 1, k), d = h01(ix + 1, iy + 1, k);
    const top = a + (b - a) * sx, bot = c + (d - c) * sx;
    return top + (bot - top) * sy;
  }

  /* value noise on an N x N lattice, WRAPPING — for anything that must tile seamlessly (the patch,
     the dapple, per-sprite hole masks). Seamless by construction, never by touch-up. */
  function noiseField(N, rnd) {
    const g = new Float32Array(N * N);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return (u, v) => {
      const fx = u * N, fy = v * N;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const x0 = ((ix % N) + N) % N, y0 = ((iy % N) + N) % N;
      const x1 = (x0 + 1) % N, y1 = (y0 + 1) % N;
      const tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[y0 * N + x0], b = g[y0 * N + x1], c = g[y1 * N + x0], d = g[y1 * N + x1];
      const top = a + (b - a) * sx, bot = c + (d - c) * sx;
      return top + (bot - top) * sy;
    };
  }

  /* THE SUN. One direction for every shadow, every lit rim, every facet, in every ground. Light
     comes from the top-left, which is what the station's own props already assume. */
  const SUN = { x: -0.7071, y: -0.7071 };

  /* ------------------------------------------------------------------ GROUND: FOREST ---- */
  /* Forest FLOOR, not forest canopy. Canopy from altitude is a continuous organic mass with no
     structure to hang detail on — the same problem that made open water hard. The floor is a base
     texture plus discrete objects, which is what this codebase is best at.

     It is dark on purpose. A forest floor sits under shade and the station must stay the brightest
     thing on screen (the OCEAN law: a backdrop brighter than the station turns the station into a
     cutout). Shade does that work for us — and contrast WITHIN a dark range is what reads as
     detail, so the range is wide even though the mean is low. */

  const FOREST = {
    label: 'FOREST',
    blurb: 'Landed in old growth. Deep litter, high canopy, no one around.',
    base: '#0e1210',
    PATCH: 512,                       // world px of the tiling floor texture
    DAPPLE: 640,                      // world px of the sunlight-through-canopy pass
    OVERLAY_ALPHA: 0.34,              // how hard that pass lands on the floor
    CELL: 64,                         // world px per scatter cell (~5 station tiles)
    LEVELS: 6,                        // flat bands in the floor — pixel art, not a photograph

    /* THE VALUE SEPARATION IS THE WHOLE READ. The scrapped first pass had canopy [20,34,17] over
       grass [21,33,17] — the same colour — so the crowns were invisible against the ground and all
       that survived was their lit rims: an outline. A crown from above is a DENSE DARK mass on
       LIGHTER open ground, and the gap has to be big enough to survive the CRT pass. */
    LIGHT: {
      /* The floor is TWO MATERIALS, each a flat ramp, chosen by a hard threshold with a dithered
         boundary — never a smooth blend between them. Blending soil into moss across a hundred
         pixels is precisely how the first pass turned into mud: every pixel differed from its
         neighbour by one unit, so the surface had no shapes in it at all. */
      SOIL: [[9, 8, 6], [14, 12, 9], [20, 17, 12], [27, 22, 15], [35, 28, 18],],
      MOSS: [[10, 15, 9], [14, 21, 12], [19, 29, 15], [25, 38, 18], [33, 49, 22]],
      SOIL_D: [17, 14, 11], SOIL_L: [56, 44, 29],
      MOSS_D: [19, 30, 18], MOSS_L: [58, 82, 41],
      LITTER: [92, 64, 33], TWIG: [46, 34, 22], STONE: [44, 45, 42],
      DAPPLE: [150, 132, 66],                          // warm sun on the floor, used additively
      CAST: [10, 14, 10],                              // opaque, so hard-edging cannot erase it
      /* five ramps, five silhouettes. A conifer is COOLER and DARKER than a maple; a birch is
         warmer and brighter than either. Hue separation is species identification at 40px. */
      LEAF: [[19, 31, 19], [30, 48, 26], [44, 68, 33], [62, 92, 41], [86, 118, 51], [116, 148, 63]],
      NEEDLE: [[14, 26, 17], [20, 37, 23], [28, 50, 30], [39, 66, 39], [56, 88, 50]],
      BIRCH: [[26, 40, 20], [48, 70, 30], [78, 104, 42], [112, 138, 55], [150, 168, 74]],
      DEAD: [[30, 26, 20], [46, 40, 31], [64, 56, 43], [84, 74, 57]],
      BARK: [[30, 24, 18], [52, 42, 30], [78, 64, 46]],
      PALE: [[64, 62, 56], [92, 90, 81], [124, 120, 107]],     // birch bark, bone, bare wood
    },

    /* ---- the tiling floor: humus, moss, litter, twigs ---- */
    buildPatch(rnd) {
      const P = FOREST.PATCH, LT = FOREST.LIGHT, L = FOREST.LEVELS;
      const cv = mkCv(P, P), c = cv.getContext('2d');
      const n1 = noiseField(3, rnd), n2 = noiseField(7, rnd), n3 = noiseField(15, rnd), n4 = noiseField(31, rnd);
      const img = c.createImageData(P, P), D = img.data;
      let p = 0;
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const u = x / P, v = y / P;
          /* two independent fields, not one: WETNESS decides soil vs moss (big shapes), GRAIN is
             the tooth of the surface. One field alone gives you a cloud; two give you a material
             with something growing on it. */
          const wet = n1(u, v) * 0.62 + n2(u, v) * 0.38;
          const grain = n3(u, v) * 0.42 + n4(u, v) * 0.38 + h01(x, y, 5) * 0.20;
          /* HARD material boundary with a DITHERED band. A pixel-art surface changes material at
             an edge; the only softening allowed is a one-band checker of hashed pixels along that
             edge, which is how every pixel artist has ever faded one texture into another. */
          const dw = wet - 0.46;
          const mossy = Math.abs(dw) < 0.05 ? (h01(x, y, 9) < 0.5 + dw * 10) : dw > 0;
          const pal = mossy ? LT.MOSS : LT.SOIL;
          /* quantize to the ramp's own steps, then let a 1px hash push the odd pixel one step —
             the dither is what stops five flat bands looking like five flat bands. */
          const col = dither(pal, grain * 1.06 - 0.03, x, y, 13);
          D[p] = col[0]; D[p + 1] = col[1]; D[p + 2] = col[2]; D[p + 3] = 255;
          p += 4;
        }
      }
      c.putImageData(img, 0, 0);

      /* discrete marks on top. Every one is stamped nine times (3x3 wrap) so the patch stays
         seamless — a mark clipped at the edge is a visible seam once it tiles. */
      const stamp = (x, y, w, h, style) => {
        c.fillStyle = style;
        for (const ox of [-P, 0, P]) for (const oy of [-P, 0, P]) c.fillRect(x + ox, y + oy, w, h);
      };
      for (let i = 0; i < 2600; i++) {                       // leaf litter — warm flat flakes
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0;
        const w = 1 + ((rnd() * 3) | 0), h = 1 + ((rnd() * 2) | 0);
        stamp(x, y, w, h, rgba(mix(LT.LITTER, LT.SOIL_D, rnd() * 0.55), 0.16 + 0.34 * rnd()));
      }
      for (let i = 0; i < 420; i++) {                        // twigs — short 1px runs, any angle
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0;
        const len = 3 + ((rnd() * 7) | 0), horiz = rnd() < 0.5;
        stamp(x, y, horiz ? len : 1, horiz ? 1 : len, rgba(LT.TWIG, 0.30 + 0.35 * rnd()));
      }
      for (let i = 0; i < 700; i++) {                        // moss speckle — the fine green tooth
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0;
        stamp(x, y, 1, 1, rgba(LT.MOSS_L, 0.14 + 0.30 * rnd()));
      }
      for (let i = 0; i < 130; i++) {                        // pebbles, lit on the sun side
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0, s = 1 + ((rnd() * 2) | 0);
        stamp(x, y, s, s, rgba(LT.STONE, 0.20 + 0.20 * rnd()));
        stamp(x, y, 1, 1, rgba([104, 104, 96], 0.22));
      }
      return cv;
    },

    /* ---- DAPPLE: sunlight through the canopy, onto the floor ----
       Drawn additively over the patch BEFORE the scatter, because light lands on the ground and
       the trees stand on top of it. It tiles at a different period from the patch, so the two
       repeats beat against each other instead of lining up into visible wallpaper.

       IT IS QUANTIZED, NOT SOFT. The first cut stacked radial gradients, and once that was blitted
       across the whole floor the result was exactly the note the first forest died of: a soft brown
       haze over everything, with no edge anywhere. A sun pool falling through a canopy gap has a
       SHAPE. Three flat steps give it one, and the CRT pass will do the rest of the softening. */
    buildOverlay(rnd) {
      const P = FOREST.DAPPLE, LT = FOREST.LIGHT;
      const cv = mkCv(P, P), c = cv.getContext('2d');
      const big = noiseField(4, rnd), mid = noiseField(9, rnd), fine = noiseField(19, rnd);
      const img = c.createImageData(P, P), D = img.data;
      let p = 0;
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const u = x / P, v = y / P;
          const n = big(u, v) * 0.50 + mid(u, v) * 0.32 + fine(u, v) * 0.18;
          /* only the top of the distribution lights up at all — a canopy is mostly closed, so most
             of the floor gets nothing and the pools that do exist are worth looking at. */
          const t = clamp01((n - 0.56) * 3.4);
          const step = t <= 0 ? 0 : t < 0.34 ? 0.34 : t < 0.72 ? 0.66 : 1;
          D[p] = LT.DAPPLE[0] * step; D[p + 1] = LT.DAPPLE[1] * step; D[p + 2] = LT.DAPPLE[2] * step;
          D[p + 3] = 255;
          p += 4;
        }
      }
      c.putImageData(img, 0, 0);
      return cv;
    },

    /* ---- THE CROWN: the thing the scrapped version got wrong ----
       A lobed outline filled with hundreds of hard leaf stamps, lit by a DOME term (the middle of
       a tree is nearer the sun than its edge) plus the SUN term (top-left), with holes punched
       through so the floor shows between the leaves. Nothing here is a gradient and nothing relies
       on alpha: hardEdge() is coming. */
    crown(c, cx, cy, R, pal, rnd, opt) {
      const o = opt || {};
      const LT = FOREST.LIGHT;
      const holes = noiseField(6, rnd);                    // per-crown hole mask
      const clump = noiseField(4, rnd);                    // per-crown density clumping

      /* THE OUTLINE IS THE SPECIES. Three smooth harmonics give the round lobed crown of a
         broadleaf; a sawtooth gives the spiked wheel of a conifer seen straight down its trunk.
         Same leaf machinery underneath, completely different silhouette — which is the cheap way
         to get species that are still distinguishable once they are 30px wide. */
      const K = 96, rad = new Float32Array(K);
      if (o.teeth) {
        const jag = 0.30 + rnd() * 0.12, ph = rnd() * TAU;
        for (let i = 0; i < K; i++) {
          const th = (i / K) * TAU;
          const saw = Math.abs(((th * o.teeth + ph) / Math.PI) % 2 - 1);       // 0..1 triangle wave
          rad[i] = R * (1 - jag * saw) * (0.94 + 0.12 * h01(i, o.teeth, 3));
        }
      } else {
        const a1 = 0.10 + rnd() * 0.13, a2 = 0.05 + rnd() * 0.10, a3 = 0.03 + rnd() * 0.07;
        const p1 = rnd() * TAU, p2 = rnd() * TAU, p3 = rnd() * TAU;
        const m1 = 2 + ((rnd() * 2) | 0), m2 = 4 + ((rnd() * 3) | 0), m3 = 7 + ((rnd() * 4) | 0);
        for (let i = 0; i < K; i++) {
          const th = (i / K) * TAU;
          rad[i] = R * (1 - a1 - a2 - a3 + a1 * (1 + Math.sin(th * m1 + p1)) * 0.5 * 2
            + a2 * (1 + Math.sin(th * m2 + p2)) * 0.5 * 2 + a3 * (1 + Math.sin(th * m3 + p3)) * 0.5 * 2);
        }
      }
      const radAt = th => {
        const f = ((th % TAU) + TAU) % TAU / TAU * K;
        const i0 = Math.floor(f) % K, i1 = (i0 + 1) % K, t = f - Math.floor(f);
        return rad[i0] + (rad[i1] - rad[i0]) * t;
      };

      // 1. the cast shadow, offset down-sun. Opaque and hard: a soft shadow would be erased.
      if (o.shadow !== false) {
        /* SMALL OFFSET ON PURPOSE. Seen from straight down, a crown hides nearly all of its own
           shadow; only a crescent escapes on the anti-sun side. An offset of half a radius (the
           first cut) throws a second crown-sized black shape onto the floor for every tree, and
           at canopy coverage those merge into the black lagoons that made v4 look punched out. */
        c.fillStyle = rgb(LT.CAST);
        c.beginPath();
        for (let i = 0; i <= K; i++) {
          const th = (i / K) * TAU, r = rad[i % K] * 0.94;
          const x = cx - SUN.x * R * 0.30 + Math.cos(th) * r, y = cy - SUN.y * R * 0.34 + Math.sin(th) * r;
          i ? c.lineTo(x, y) : c.moveTo(x, y);
        }
        c.closePath(); c.fill();
      }

      // 2. the base mass — one step up from the ramp floor, so gaps between leaves read as deep
      //    foliage rather than as holes punched through to nothing
      c.fillStyle = rgb(pal[1]);
      c.beginPath();
      for (let i = 0; i <= K; i++) {
        const th = (i / K) * TAU, r = rad[i % K];
        const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.closePath(); c.fill();

      // 3. the leaves. Density scales with area so a big crown is not sparser than a small one.
      const N = Math.round(R * R * (o.density || 0.62));
      const S = R * 2;
      for (let i = 0; i < N; i++) {
        const th = rnd() * TAU;
        const edge = radAt(th);
        const rr = edge * Math.pow(rnd(), 0.52);           // slight edge weighting: crowns are shells
        const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
        const u = (x - cx + R) / S, v = (y - cy + R) / S;

        if (holes(u, v) > (o.hole || 0.78) && rr > edge * 0.30) continue;   // sky through the leaves
        if (clump(u * 1.7, v * 1.7) < 0.22) continue;                        // clumped, not uniform

        /* LIGHTING IS A GRADIENT ACROSS THE WHOLE CROWN, NOT A RING AROUND IT. Lighting each leaf
           by its own radial angle gives a bright rim all the way round — an OUTLINE, the exact
           note that killed the first forest. A real crown is a dome lit from ONE side: the term
           that matters is how far the leaf sits UP-SUN of the trunk, measured linearly. */
        const k = rr / edge;
        const dome = Math.sqrt(Math.max(0, 1 - k * k));                      // height on the crown dome
        const side = -((x - cx) * SUN.x + (y - cy) * SUN.y) / R;             // -1 (shade) .. +1 (sun)
        /* the clump field is subtracted, not added: it carves BRANCH-SCALE shadow into the mass,
           which is what stops a crown reading as one smooth ball of confetti. */
        const branch = clump(u * 2.3, v * 2.3);
        const sunSide = side > 0 ? Math.pow(side, 0.72) : side * 0.85;
        let lit = 0.24 + (o.boost || 0) + 0.20 * dome + 0.62 * sunSide - 0.28 * (1 - branch);
        lit += (rnd() - 0.5) * 0.18;                                          // per-leaf jitter
        c.fillStyle = rgb(ramp(pal, lit));
        const sz = 1 + ((rnd() * (R > 34 ? 4 : R > 18 ? 3 : 2)) | 0);
        c.fillRect(Math.round(x), Math.round(y), sz, Math.max(1, sz - ((rnd() * 2) | 0)));
      }

      // 4. the shaded well on the anti-sun side — without it a crown is a flat disc of confetti
      c.fillStyle = rgba(pal[0], 0.80);
      for (let i = 0; i < Math.round(R * R * 0.10); i++) {
        const th = rnd() * TAU, rr = radAt(th) * (0.35 + 0.62 * rnd());
        const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
        const shade = clamp01(0.5 + (Math.cos(th) * SUN.x + Math.sin(th) * SUN.y) * 0.5) * (rr / R);
        if (shade < 0.55 || rnd() > shade) continue;
        c.fillRect(Math.round(x), Math.round(y), 1 + ((rnd() * 2) | 0), 1);
      }
    },

    /* ---- the scatter sprites: pre-rendered once, then one drawImage per instance ---- */
    buildSprites(rnd) {
      const LT = FOREST.LIGHT;
      const out = [];
      const add = (kind, cv, ox, oy, R) => out.push({ kind, cv: hardEdge(cv), ox, oy, R });

      /* BROADLEAF — the big money silhouette. Wide lobed crown, dense leaf texture. Big on
         purpose: from directly above, old growth is MOSTLY CROWN. Small trees on open ground is
         the composition that reads as scrubland. */
      for (let v = 0; v < 7; v++) {
        const R = 28 + Math.round(rnd() * 26);
        const S = Math.ceil(R * 3.2), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        FOREST.crown(c, cx, cy, R, LT.LEAF, rnd, { density: 0.66, hole: 0.80 });
        add('tree', cv, cx, cy, R);
      }

      /* EMERGENTS — the handful of giants that stand above the canopy. One per screenful is enough
         to give the wood a scale: without a size hierarchy every crown is the same 40px disc and
         the eye reads a repeating pattern instead of a forest. They catch more sun than anything
         below them, hence the boost. */
      for (let v = 0; v < 3; v++) {
        const R = 58 + Math.round(rnd() * 20);
        const S = Math.ceil(R * 3.0), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        FOREST.crown(c, cx, cy, R, LT.LEAF, rnd, { density: 0.60, hole: 0.82, boost: 0.10 });
        add('emergent', cv, cx, cy, R);
      }

      /* CONIFER — the same leaf machinery under a SAWTOOTH outline: seen straight down its trunk a
         spruce is a spiked wheel, and that silhouette is what separates it from a maple at 30px.
         The star-of-triangles version this replaces read as a sea urchin at every zoom. */
      for (let v = 0; v < 5; v++) {
        const R = 21 + Math.round(rnd() * 15);
        const S = Math.ceil(R * 3.0), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        FOREST.crown(c, cx, cy, R, LT.NEEDLE, rnd, {
          density: 0.72, hole: 0.88, teeth: 13 + ((rnd() * 6) | 0),
        });
        c.fillStyle = rgb(LT.NEEDLE[4]);                     // the lit apex, straight down the leader
        c.beginPath(); c.arc(cx - R * 0.05, cy - R * 0.05, Math.max(1.5, R * 0.11), 0, TAU); c.fill();
        add('conifer', cv, cx, cy, R);
      }

      /* BIRCH — sparse warm crown with the pale trunk visible straight down the middle. The only
         bright tree; three or four per screen are what stop the canopy reading as one green mat. */
      for (let v = 0; v < 4; v++) {
        const R = 19 + Math.round(rnd() * 11);
        const S = Math.ceil(R * 3.2), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        FOREST.crown(c, cx, cy, R, LT.BIRCH, rnd, { density: 0.44, hole: 0.62 });
        c.fillStyle = rgb(LT.PALE[1]);                       // trunk seen from directly above
        c.beginPath(); c.arc(cx, cy, Math.max(1.5, R * 0.11), 0, TAU); c.fill();
        c.fillStyle = rgb(LT.PALE[2]);
        c.beginPath(); c.arc(cx - R * 0.04, cy - R * 0.04, Math.max(1, R * 0.06), 0, TAU); c.fill();
        add('birch', cv, cx, cy, R);
      }

      /* SNAG — a dead tree: no canopy at all, just bare forking branches and a long shadow. Pale
         bone-grey against all that green, and the single most "old growth" object out there. */
      for (let v = 0; v < 3; v++) {
        const R = 14 + Math.round(rnd() * 10);
        const S = Math.ceil(R * 3.0), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        const limbs = [];
        for (let i = 0, n = 5 + ((rnd() * 4) | 0); i < n; i++) {
          const a = (i / n) * TAU + rnd() * 0.6, len = R * (0.55 + 0.45 * rnd());
          limbs.push({ a, len, fork: rnd() < 0.6 });
        }
        const drawLimbs = (ox, oy, style) => {
          c.strokeStyle = style; c.lineCap = 'butt';
          for (const L of limbs) {
            c.lineWidth = Math.max(1.4, R * 0.10);
            c.beginPath(); c.moveTo(ox, oy);
            c.lineTo(ox + Math.cos(L.a) * L.len, oy + Math.sin(L.a) * L.len); c.stroke();
            if (!L.fork) continue;
            c.lineWidth = Math.max(1, R * 0.06);
            for (const s of [-1, 1]) {
              const bx = ox + Math.cos(L.a) * L.len * 0.62, by = oy + Math.sin(L.a) * L.len * 0.62;
              c.beginPath(); c.moveTo(bx, by);
              c.lineTo(bx + Math.cos(L.a + s * 0.7) * L.len * 0.38, by + Math.sin(L.a + s * 0.7) * L.len * 0.38);
              c.stroke();
            }
          }
        };
        drawLimbs(cx - SUN.x * R * 0.55, cy - SUN.y * R * 0.6, rgb(LT.CAST));
        drawLimbs(cx, cy, rgb(LT.DEAD[1]));
        c.fillStyle = rgb(LT.DEAD[2]);                       // the broken-off trunk top
        c.beginPath(); c.arc(cx, cy, Math.max(2, R * 0.17), 0, TAU); c.fill();
        c.fillStyle = rgb(LT.DEAD[3]);
        c.beginPath(); c.arc(cx - R * 0.05, cy - R * 0.05, Math.max(1, R * 0.10), 0, TAU); c.fill();
        add('snag', cv, cx, cy, R);
      }

      /* SAPLINGS — small crowns that fill the gaps between the big ones. Without a young cohort a
         forest looks planted. */
      for (let v = 0; v < 4; v++) {
        const R = 7 + Math.round(rnd() * 6);
        const S = Math.ceil(R * 3.2), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        FOREST.crown(c, cx, cy, R, LT.LEAF, rnd, { density: 0.9, hole: 0.86, shadow: true });
        add('sap', cv, cx, cy, R);
      }

      /* FERN CLUMPS — radial fronds with pinnae dots. Bright green, low to the ground, no shadow
         worth the pixels. These are the undergrowth that makes a floor look inhabited. */
      for (let v = 0; v < 5; v++) {
        const R = 6 + Math.round(rnd() * 6);
        const S = R * 3, cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        for (let i = 0, n = 6 + ((rnd() * 5) | 0); i < n; i++) {
          const a = rnd() * TAU, len = R * (0.6 + 0.4 * rnd());
          const lit = 0.45 + 0.45 * clamp01(0.5 - (Math.cos(a) * SUN.x + Math.sin(a) * SUN.y) * 0.5);
          c.strokeStyle = rgb(ramp(LT.LEAF, lit)); c.lineWidth = 1.2;
          c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); c.stroke();
          for (let k = 1; k <= 4; k++) {                     // pinnae: the tooth that says "fern"
            const t = k / 5, px = cx + Math.cos(a) * len * t, py = cy + Math.sin(a) * len * t;
            c.fillStyle = rgb(ramp(LT.LEAF, lit + 0.12));
            c.fillRect(Math.round(px + Math.cos(a + 1.5) * 1.5), Math.round(py + Math.sin(a + 1.5) * 1.5), 1, 1);
            c.fillRect(Math.round(px + Math.cos(a - 1.5) * 1.5), Math.round(py + Math.sin(a - 1.5) * 1.5), 1, 1);
          }
        }
        add('fern', cv, cx, cy, R);
      }

      /* FALLEN LOGS — a horizontal accent in a field of round things, and the clearest read of
         "old growth" there is. Bark ridges along the length, moss on the up-sun side, hard shadow. */
      for (let v = 0; v < 4; v++) {
        const len = 34 + Math.round(rnd() * 40), rad = 3 + Math.round(rnd() * 3);
        const ang = rnd() * Math.PI;
        const S = Math.ceil(len * 1.5), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        c.save(); c.translate(cx, cy); c.rotate(ang);
        c.fillStyle = rgb(LT.CAST);                          // shadow
        c.fillRect(-len / 2 + 3, -rad + 3, len, rad * 2);
        c.fillStyle = rgb(LT.BARK[0]);                       // the log body
        c.fillRect(-len / 2, -rad, len, rad * 2);
        c.fillStyle = rgb(LT.BARK[1]);                       // lit upper flank
        c.fillRect(-len / 2, -rad, len, Math.max(1, rad * 0.8));
        c.fillStyle = rgb(LT.BARK[2]);
        c.fillRect(-len / 2, -rad, len, 1);
        for (let i = 0; i < len * 1.6; i++) {                // bark ridges: 1px runs along the grain
          const x = -len / 2 + rnd() * len, y = -rad + rnd() * rad * 2;
          c.fillStyle = rgba(rnd() < 0.5 ? LT.BARK[0] : LT.BARK[2], 0.55);
          c.fillRect(Math.round(x), Math.round(y), 1 + ((rnd() * 3) | 0), 1);
        }
        for (let i = 0; i < len * 0.5; i++) {                // moss creeping along the top
          const x = -len / 2 + rnd() * len, y = -rad + rnd() * rad * 0.9;
          c.fillStyle = rgb(mix(FOREST.LIGHT.MOSS_D, FOREST.LIGHT.MOSS_L, rnd()));
          c.fillRect(Math.round(x), Math.round(y), 1 + ((rnd() * 2) | 0), 1);
        }
        c.fillStyle = rgb(LT.PALE[0]);                       // the sawn/broken end grain
        c.fillRect(-len / 2 - 1, -rad, 2, rad * 2);
        c.restore();
        add('log', cv, cx, cy, len / 2);
      }

      /* STUMPS — a pale disc with growth rings. Small, but it is a MAN-MADE mark in a wild place,
         which is exactly the note this station wants. */
      for (let v = 0; v < 2; v++) {
        const R = 5 + Math.round(rnd() * 4);
        const S = R * 4, cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        c.fillStyle = rgb(LT.CAST);
        c.beginPath(); c.ellipse(cx - SUN.x * R * 0.4, cy - SUN.y * R * 0.4, R * 1.05, R * 0.9, 0, 0, TAU); c.fill();
        c.fillStyle = rgb(LT.BARK[0]);
        c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fill();
        c.fillStyle = rgb(LT.PALE[0]);
        c.beginPath(); c.arc(cx, cy, R * 0.82, 0, TAU); c.fill();
        for (let k = 1; k <= 3; k++) {
          c.strokeStyle = rgba(LT.BARK[1], 0.9); c.lineWidth = 1;
          c.beginPath(); c.arc(cx, cy, R * 0.82 * (k / 4), 0, TAU); c.stroke();
        }
        add('stump', cv, cx, cy, R);
      }

      /* BOULDERS — the only cool grey mass out there, so they read as stone, not foliage. Moss on
         top because everything in an old forest is being eaten by moss. */
      for (let v = 0; v < 4; v++) {
        const R = 8 + Math.round(rnd() * 9);
        const S = R * 3.2, cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        c.fillStyle = rgb(LT.CAST);
        c.beginPath(); c.ellipse(cx - SUN.x * R * 0.45, cy - SUN.y * R * 0.5, R * 0.95, R * 0.66, 0, 0, TAU); c.fill();
        c.fillStyle = rgb(LT.STONE);
        c.beginPath();                                        // faceted, not round: stone has planes
        for (let i = 0, n = 7; i <= n; i++) {
          const a = (i / n) * TAU, r = R * (0.78 + 0.30 * h01(i, v, 17));
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          i ? c.lineTo(x, y) : c.moveTo(x, y);
        }
        c.closePath(); c.fill();
        c.fillStyle = rgb([60, 61, 57]);
        c.beginPath(); c.arc(cx + SUN.x * R * 0.28, cy + SUN.y * R * 0.30, R * 0.52, 0, TAU); c.fill();
        c.fillStyle = rgb([78, 79, 74]);
        c.beginPath(); c.arc(cx + SUN.x * R * 0.42, cy + SUN.y * R * 0.44, R * 0.24, 0, TAU); c.fill();
        for (let i = 0, n = Math.round(R * R * 0.35); i < n; i++) {   // moss cap + grain
          const a = rnd() * TAU, d = R * Math.pow(rnd(), 0.7);
          const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
          c.fillStyle = rnd() < 0.62 ? rgba(mix(LT.MOSS_D, LT.MOSS_L, rnd()), 0.85) : rgba([64, 65, 60], 0.5);
          c.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
        add('rock', cv, cx, cy, R);
      }

      return out;
    },

    /* ---- WHERE THINGS GROW ----
       Called once per frame with the visible world rect. Pushes sprite instances; the dispatcher
       y-sorts and blits them. Everything here is a pure function of the cell coordinate, so the
       wood is infinite, identical on every visit, and stored nowhere. */
    place(push, x0, y0, x1, y1, clr, scale, pools) {
      const C = FOREST.CELL;
      const cx0 = Math.floor(x0 / C), cx1 = Math.ceil(x1 / C);
      const cy0 = Math.floor(y0 / C), cy1 = Math.ceil(y1 / C);
      /* LOD: undergrowth is sub-pixel when zoomed out, so below 0.9x it is not drawn at all. This
         is what keeps a zoomed-out frame from queueing ten thousand one-pixel blits. */
      const clutter = scale >= 0.9;

      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const wx0 = cx * C, wy0 = cy * C;
          /* THE FIELD: two octaves of world-space noise decide how thick the wood is here — where
             the groves, glades and edges are. A flat probability gives an even stipple, and an even
             stipple reads as "texture" rather than "place".

             WAVELENGTHS ARE IN WORLD PX AND MUST BE SMALLER THAN A SCREENFUL. The first cut used
             900px and 340px; a 1000px viewport at 1x therefore sampled barely one period, the whole
             screen landed inside a single glade, and NOT ONE TREE DREW. A field you cannot see more
             than one period of is a constant. */
          const dens = vnoise(wx0 / 380, wy0 / 380, 3) * 0.60 + vnoise(wx0 / 150, wy0 / 150, 11) * 0.40;
          const edgeBoost = clr ? nearClearing(clr, wx0, wy0, C) : 0;
          const inClearing = clr && wx0 + C > clr.x && wx0 < clr.x + clr.w && wy0 + C > clr.y && wy0 < clr.y + clr.h;

          /* CANOPY COVERAGE IS THE COMPOSITION. Seen from directly above, old growth is mostly
             CROWN: a near-continuous mass with the floor showing through gaps, not trees dotted on
             a lawn. A sparse scatter reads as scrubland no matter how good the tree is — which is
             what the first forest actually looked like. So most cells carry a tree, thick cells
             carry two, and only genuine glades open up. */
          const nTree = dens > 0.24 ? (h01(cx, cy, 1) < 0.30 + dens * 0.86 ? (h01(cx, cy, 2) < 0.34 + dens * 0.3 ? 2 : 1) : 0) : 0;
          for (let k = 0; k < nTree; k++) {
            const wx = wx0 + h01(cx, cy, 20 + k) * C, wy = wy0 + h01(cx, cy, 30 + k) * C;
            if (clr && wx > clr.x && wx < clr.x + clr.w && wy > clr.y && wy < clr.y + clr.h) continue;
            const pick = h01(cx, cy, 40 + k);
            /* species mix: broadleaf dominant, a real conifer minority, birch and dead snags rare
               enough to be events. A 50/50 mix reads as a garden centre, not a wood. */
            const pool = pick < 0.06 ? 'emergent' : pick < 0.60 ? 'tree' : pick < 0.82 ? 'conifer'
              : pick < 0.92 ? 'birch' : pick < 0.97 ? 'snag' : 'sap';
            const arr = pools[pool] || pools.tree;
            if (!arr || !arr.length) continue;
            push(arr[(h01(cx, cy, 50 + k) * arr.length) | 0], wx, wy);
          }

          if (!clutter) continue;
          /* UNDERGROWTH LIVES IN THE LIGHT. Ferns, logs and stumps go where the canopy ISN'T —
             glades and the clearing's edge — because that is both true of forests and the only way
             they stay visible instead of being buried under crowns. */
          const open = clamp01(1 - dens * 1.5) + edgeBoost * 1.1;
          const nSmall = inClearing ? 0 : Math.round(open * 2.2 * (0.35 + h01(cx, cy, 5)));
          for (let k = 0; k < nSmall; k++) {
            const wx = wx0 + h01(cx, cy, 60 + k) * C, wy = wy0 + h01(cx, cy, 70 + k) * C;
            if (clr && wx > clr.x && wx < clr.x + clr.w && wy > clr.y && wy < clr.y + clr.h) continue;
            const pick = h01(cx, cy, 80 + k);
            const pool = pick < 0.46 ? 'fern' : pick < 0.68 ? 'sap' : pick < 0.86 ? 'log'
              : pick < 0.95 ? 'rock' : 'stump';
            const arr = pools[pool];
            if (!arr || !arr.length) continue;
            push(arr[(h01(cx, cy, 90 + k) * arr.length) | 0], wx, wy);
          }
        }
      }
    },
  };

  /* -------------------------------------------------------------------- GROUND: MOON ---- */
  /* A landed station on a mare plain. The forest's problem was making an organic mass legible;
     the moon's is the opposite — there is exactly ONE material out here, so every scrap of
     interest has to come from FORM. Which is lucky, because form is what a crater is.

     THREE THINGS CARRY IT:
       1. THE SUN IS LOW AND THERE IS NO AIR. Shadows are long, hard and BLACK — no atmospheric
          fill light, no colour bounce, no falloff. That single fact is most of the drama, and it
          is why the shadow colour here is nearly (0,0,0) while the forest's is a dark green.
       2. CRATERS ARE HOLES, NOT DOMES, and the difference is which side is lit. In a bowl the FAR
          wall (down-sun) catches the light and the near wall is in shadow — precisely inverted
          from a boulder. Get that backwards and the whole plain inflates into bubble wrap; it is
          the classic failure of every procedural moon.
       3. SCALE HIERARCHY. Real regolith is craters inside craters inside craters, over five
          orders of magnitude. Three placement grids (basins, craters, pits) plus micro-pits baked
          into the tiling patch is enough to fake that, and it is what keeps the plain from reading
          as a texture with dots on it. */

  const MOON = {
    label: 'THE MOON',
    blurb: 'Landed on a mare plain. Long shadows, no air, no one coming.',
    base: '#0a0a0b',
    PATCH: 512,
    DAPPLE: 768,                      // broad albedo swathes — ray material, not sunlight
    OVERLAY_ALPHA: 0.06,
    CELL: 96,

    LIGHT: {
      /* Mare basalt is DARK — albedo around 0.07, one of the least reflective surfaces in the
         solar system. The moon looks bright to us only because it sits against black sky. Ramping
         it up to "moon white" would both be wrong and break the law that the station is the
         brightest thing on screen. */
      REG: [[19, 18, 19], [28, 27, 28], [38, 37, 37], [50, 48, 47], [63, 60, 58], [79, 76, 72]],
      RIM: [[96, 92, 87], [122, 117, 110], [152, 146, 137]],       // sun-struck crater rims, brightest thing out here
      DARK: [[16, 16, 17], [22, 22, 23]],                          // shaded regolith
      SHADOW: [14, 14, 17],                                        // cast shadow: airless, so very nearly black
      DUST: [96, 93, 88],                                          // ray ejecta, used additively
    },

    /* ---- the tiling regolith: grain, micro-pits, and the odd bright chip ---- */
    buildPatch(rnd) {
      const P = MOON.PATCH, LT = MOON.LIGHT;
      const cv = mkCv(P, P), c = cv.getContext('2d');
      const n1 = noiseField(3, rnd), n2 = noiseField(8, rnd), n3 = noiseField(21, rnd);
      const img = c.createImageData(P, P), D = img.data;
      let p = 0;
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const u = x / P, v = y / P;
          /* regolith is churned powder: broad tonal drift, then a hard 1px hash on top. The hash
             is doing most of the work — dust has no structure at any scale you can see from here,
             only tooth. */
          const soft = n1(u, v) * 0.30 + n2(u, v) * 0.30 + n3(u, v) * 0.40;
          const col = dither(LT.REG, soft * 0.74 + 0.14, x, y, 17);
          D[p] = col[0]; D[p + 1] = col[1]; D[p + 2] = col[2]; D[p + 3] = 255;
          p += 4;
        }
      }
      c.putImageData(img, 0, 0);

      const stamp = (x, y, w, h, style) => {
        c.fillStyle = style;
        for (const ox of [-P, 0, P]) for (const oy of [-P, 0, P]) c.fillRect(x + ox, y + oy, w, h);
      };
      /* MICRO-PITS: the smallest craters, too small to be sprites, baked straight into the tile.
         Each is two pixels — a lit crumb up-sun and a black crumb down-sun. That two-pixel pair is
         the entire language of this ground, repeated at every scale above it. */
      for (let i = 0; i < 1500; i++) {
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0, s = 1 + ((rnd() * 2) | 0);
        stamp(x, y, s, s, rgba(LT.SHADOW, 0.55 + 0.4 * rnd()));
        stamp(x + Math.round(SUN.x * (s + 1)), y + Math.round(SUN.y * (s + 1)), s, 1, rgba(LT.RIM[0], 0.30 + 0.35 * rnd()));
      }
      for (let i = 0; i < 260; i++) {                     // fresh chips of unweathered rock
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0;
        stamp(x, y, 1, 1, rgba(LT.RIM[1], 0.30 + 0.40 * rnd()));
      }
      return cv;
    },

    /* ---- broad ray material: the pale swathes thrown across a mare by distant impacts ---- */
    buildOverlay(rnd) {
      const P = MOON.DAPPLE, LT = MOON.LIGHT;
      const cv = mkCv(P, P), c = cv.getContext('2d');
      const big = noiseField(3, rnd), mid = noiseField(7, rnd);
      const img = c.createImageData(P, P), D = img.data;
      let p = 0;
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const u = x / P, v = y / P;
          /* STRETCHED ALONG ONE AXIS ON PURPOSE. A ray is a splash from somewhere else, so it is
             directional; sampling the noise anisotropically turns round blobs into streaks and is
             the difference between "rays" and "clouds". */
          const n = big(u * 0.42 + v * 0.30, v * 1.5) * 0.6 + mid(u * 0.5 + v * 0.36, v * 1.8) * 0.4;
          const t0 = clamp01((n - 0.54) * 3.0);
          const q = t0 * 3;
          let qi = Math.floor(q); if (h01(x, y, 31) < q - qi) qi++;
          const step = [0, 0.42, 0.72, 1][Math.max(0, Math.min(3, qi))];
          D[p] = LT.DUST[0] * step; D[p + 1] = LT.DUST[1] * step; D[p + 2] = LT.DUST[2] * step;
          D[p + 3] = 255;
          p += 4;
        }
      }
      c.putImageData(img, 0, 0);
      return cv;
    },

    /* ---- THE CRATER ----
       Built strictly in the order light hits it: ejecta, then the bowl, then the shadow the near
       rim throws INTO the bowl, then the rim itself, then whatever stands in the middle. */
    crater(c, cx, cy, R, rnd, opt) {
      const o = opt || {}, LT = MOON.LIGHT;
      const fresh = o.fresh !== false;
      const pop = clamp01((R - 7) / 38);        // 0 = a shallow pit, 1 = a proper crater
      const K = 64, rad = new Float32Array(K);
      const a1 = 0.010 + rnd() * 0.014, a2 = 0.006 + rnd() * 0.012;
      const p1 = rnd() * TAU, p2 = rnd() * TAU;
      const m1 = 9 + ((rnd() * 4) | 0), m2 = 15 + ((rnd() * 7) | 0);
      for (let i = 0; i < K; i++) {
        const th = (i / K) * TAU;
        rad[i] = R * (1 + a1 * Math.sin(th * m1 + p1) + a2 * Math.sin(th * m2 + p2));
      }
      const ring = (scale, style) => {
        c.fillStyle = style;
        c.beginPath();
        for (let i = 0; i <= K; i++) {
          const th = (i / K) * TAU, r = rad[i % K] * scale;
          const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
          i ? c.lineTo(x, y) : c.moveTo(x, y);
        }
        c.closePath(); c.fill();
      };

      // 1. EJECTA — the apron of overturned material, brighter than the plain and only on the young.
      //    Radial streaks, not a scatter: ejecta is thrown OUT, and the direction is the whole tell.
      if (fresh && R >= 15) {
        for (let i = 0, n = Math.round(R * R * 0.40); i < n; i++) {
          const th = rnd() * TAU;
          const d = R * (1.03 + Math.pow(rnd(), 2.6) * 0.55);      // dense at the rim, thinning out
          const x = cx + Math.cos(th) * d, y = cy + Math.sin(th) * d;
          const len = 1 + ((rnd() * 3) | 0);
          c.fillStyle = rgb(ramp(LT.REG, 0.42 + rnd() * 0.30));
          c.fillRect(Math.round(x), Math.round(y), Math.abs(Math.cos(th)) > 0.5 ? len : 1,
            Math.abs(Math.cos(th)) > 0.5 ? 1 : len);
        }
      }

      /* 2. THE BOWL. Base tone first, then the lit inner wall as a CRESCENT hugging the down-sun
         rim — an arc, not a disc. Filling the lit wall as a circle (the first two cuts) drops a
         grey coin into the hole; a bowl is a rim you see the inside of, so the light belongs on
         the wall, and the wall is a band. */
      ring(0.98, rgb(ramp(LT.REG, fresh ? 0.54 : 0.50)));
      c.save();
      c.beginPath();
      for (let i = 0; i <= K; i++) {
        const th = (i / K) * TAU, r = rad[i % K] * 0.99;
        const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.closePath(); c.clip();
      const down = Math.atan2(-SUN.y, -SUN.x);                              // the wall the sun reaches
      c.strokeStyle = rgb(ramp(LT.REG, fresh ? 0.88 : 0.68));
      c.lineWidth = R * 0.30;
      c.beginPath(); c.arc(cx, cy, R * 0.86, down - 1.25, down + 1.25); c.stroke();
      /* GRAIN INSIDE THE BOWL. Flat fills are the tell of vector art, and a crater made of three
         smooth regions reads as a logo. The same hashed tooth that carries the plain has to run
         through the bowl too, or the two surfaces are visibly different materials. */
      for (let i = 0, n = Math.round(R * R * 0.55); i < n; i++) {
        const th = rnd() * TAU, d = R * Math.sqrt(rnd());
        const x = cx + Math.cos(th) * d, y = cy + Math.sin(th) * d;
        const lit = 0.42 + 0.34 * (-(Math.cos(th) * SUN.x + Math.sin(th) * SUN.y)) * (d / R);
        c.fillStyle = rgb(ramp(LT.REG, lit + (rnd() - 0.5) * 0.30));
        c.fillRect(Math.round(x), Math.round(y), 1 + ((rnd() * 2) | 0), 1);
      }
      c.restore();

      /* 3. THE SHADOW INSIDE THE BOWL — the near (up-sun) rim throws it across the near wall and
         part of the floor. THIS IS THE WHOLE ILLUSION: shade the up-sun interior and the crater is
         a hole; shade the down-sun interior instead and the identical shape inflates into a dome.
         The shadow's edge is a GENTLE ARC, cut by a circle far larger than the crater — a small
         circle centred just inside the bowl (the first cut) swallows nearly the whole interior and
         leaves a black coin, which is what m1 looked like. */
      c.save();
      c.beginPath();
      for (let i = 0; i <= K; i++) {
        const th = (i / K) * TAU, r = rad[i % K] * 0.98;
        const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.closePath(); c.clip();
      const Rs = R * 2.4, chord = R * ((o.deep ? 0.44 : 0.62) + (1 - pop) * 0.30);   // shallow pits, less shade
      const sx = cx + SUN.x * (Rs + chord), sy = cy + SUN.y * (Rs + chord);
      c.fillStyle = rgb(LT.SHADOW);
      c.beginPath(); c.arc(sx, sy, Rs, 0, TAU); c.fill();
      // ...and a stippled band just outside it, so the terminator crumbles instead of cutting
      for (let i = 0, n = Math.round(R * 22); i < n; i++) {
        const a = rnd() * TAU, d = Rs + rnd() * R * 0.16;
        const x = sx + Math.cos(a) * d, y = sy + Math.sin(a) * d;
        if (rnd() > 0.55) continue;
        c.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
      c.restore();

      /* 4. THE RIM — a bright lip up-sun, dark down-sun. Drawn as a thin arc pair rather than a
         full ring: a ring of even value reads as a washer, which is what a crater is not. */
      /* A CONTINUOUS RING, NOT TWO ARCS. Stroking a bright arc from 0.47 to 0.78 of a turn leaves
         two abrupt ends, and a bright band that stops dead reads as a fingernail lying on the
         ground. The rim is a ridge all the way round; only its BRIGHTNESS varies, brightest where
         it faces the sun and darkest on its own shaded back. Drawing it segment by segment gives
         that gradient without ever drawing an end. */
      c.lineWidth = Math.max(1.6, R * 0.16);
      const RIMPAL = [LT.DARK[0], LT.DARK[1], LT.REG[2], LT.REG[3], LT.REG[4], LT.REG[5], LT.RIM[0], LT.RIM[1]];
      const gain = 0.20 + 0.26 * pop * (fresh ? 1 : 0.62);      // young rims are sharper and brighter
      for (let i = 0; i < K; i++) {
        const th0 = (i / K) * TAU, th1 = ((i + 1) / K) * TAU;
        const facing = -(Math.cos(th0) * SUN.x + Math.sin(th0) * SUN.y);   // +1 down-sun, -1 up-sun
        const lit = 0.5 - facing * (0.30 + gain) + (h01(i, R | 0, 77) - 0.5) * 0.12;
        c.strokeStyle = rgb(ramp(RIMPAL, lit));
        c.beginPath();
        c.moveTo(cx + Math.cos(th0) * rad[i], cy + Math.sin(th0) * rad[i]);
        c.lineTo(cx + Math.cos(th1) * rad[(i + 1) % K], cy + Math.sin(th1) * rad[(i + 1) % K]);
        c.stroke();
      }

      /* 4b. DUST THE RIM. The lip is drawn as a stroke, and a stroke has a clean edge — the one
         thing nothing else on this plain has. Scattering the ramp's own grain across the rim band
         breaks that edge into the same tooth as the regolith, which is what stops the crater
         reading as a sticker laid on top of the ground. */
      for (let i = 0, n = Math.round(R * R * 0.45); i < n; i++) {
        const th = rnd() * TAU;
        const d = R * (0.90 + rnd() * 0.26);
        const x = cx + Math.cos(th) * d, y = cy + Math.sin(th) * d;
        const sun = -(Math.cos(th) * SUN.x + Math.sin(th) * SUN.y);        // +1 down-sun, -1 up-sun
        const lit = 0.52 - sun * 0.34 + (rnd() - 0.5) * 0.34;
        c.fillStyle = rgb(ramp(LT.REG, lit));
        c.fillRect(Math.round(x), Math.round(y), 1 + ((rnd() * 2) | 0), 1);
      }

      // 5. CENTRAL PEAK — only big craters rebound one, and it is lit like a boulder: the OPPOSITE
      //    side from the bowl, which is exactly what sells the bowl as a bowl.
      if (R >= 46) {
        const pr = R * (0.14 + rnd() * 0.07);
        c.fillStyle = rgb(LT.SHADOW);
        c.beginPath(); c.ellipse(cx - SUN.x * pr * 1.5, cy - SUN.y * pr * 1.5, pr * 0.95, pr * 0.6, 0, 0, TAU); c.fill();
        c.fillStyle = rgb(ramp(LT.REG, 0.55));
        c.beginPath(); c.arc(cx, cy, pr, 0, TAU); c.fill();
        c.fillStyle = rgb(LT.RIM[1]);
        c.beginPath(); c.arc(cx + SUN.x * pr * 0.4, cy + SUN.y * pr * 0.4, pr * 0.55, 0, TAU); c.fill();
      }

      /* NO TERRACES. Slumped walls are real, but two concentric arcs inside a 60px bowl read as
         pen strokes on every frame they appeared in — a detail that only survives at a scale this
         camera never reaches is a decoration, not a detail. */
    },

    buildSprites(rnd) {
      const LT = MOON.LIGHT;
      const out = [];
      const add = (kind, cv, ox, oy, R) => out.push({ kind, cv: hardEdge(cv), ox, oy, R });

      /* BASINS — the rare big ones with peaks and terraces. */
      for (let v = 0; v < 3; v++) {
        const R = 62 + Math.round(rnd() * 34);
        const S = Math.ceil(R * 4.6), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        MOON.crater(c, cx, cy, R, rnd, { fresh: rnd() < 0.6, deep: true });
        add('basin', cv, cx, cy, R);
      }
      /* CRATERS — the everyday size, half of them old and subdued. */
      for (let v = 0; v < 8; v++) {
        const R = 22 + Math.round(rnd() * 30);
        const S = Math.ceil(R * 4.6), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        MOON.crater(c, cx, cy, R, rnd, { fresh: v % 2 === 0 });
        add('crater', cv, cx, cy, R);
      }
      /* PITS — small, sharp, everywhere. These are what make the plain feel worked over. */
      for (let v = 0; v < 8; v++) {
        const R = 6 + Math.round(rnd() * 11);
        const S = Math.ceil(R * 4.2), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        MOON.crater(c, cx, cy, R, rnd, { fresh: v % 3 !== 0 });
        add('pit', cv, cx, cy, R);
      }

      /* BOULDERS — lit on the sun side with a LONG hard shadow. They are the counter-evidence to
         the craters: same plain, same light, opposite shading, which is what makes both read. */
      for (let v = 0; v < 6; v++) {
        const R = 4 + Math.round(rnd() * 9);
        const S = Math.ceil(R * 7), cx = S / 2, cy = S / 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        const len = R * (2.2 + rnd() * 1.8);                 // the sun is LOW: shadows run long
        c.fillStyle = rgb(LT.SHADOW);
        c.beginPath();
        c.moveTo(cx + Math.cos(0.9) * R, cy + Math.sin(0.9) * R);
        c.lineTo(cx - SUN.x * len, cy - SUN.y * len);
        c.lineTo(cx + Math.cos(2.6) * R, cy + Math.sin(2.6) * R);
        c.closePath(); c.fill();
        c.beginPath(); c.ellipse(cx - SUN.x * R * 0.3, cy - SUN.y * R * 0.3, R * 0.95, R * 0.75, 0, 0, TAU); c.fill();
        c.fillStyle = rgb(ramp(LT.REG, 0.45));               // the rock: faceted, never round
        c.beginPath();
        for (let i = 0, n = 6 + ((rnd() * 3) | 0); i <= n; i++) {
          const a = (i / n) * TAU, r = R * (0.74 + 0.34 * h01(i, v, 29));
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          i ? c.lineTo(x, y) : c.moveTo(x, y);
        }
        c.closePath(); c.fill();
        c.fillStyle = rgb(LT.RIM[0]);                        // the sun-struck facet
        c.beginPath(); c.arc(cx + SUN.x * R * 0.34, cy + SUN.y * R * 0.34, R * 0.52, 0, TAU); c.fill();
        c.fillStyle = rgb(LT.RIM[2]);
        c.beginPath(); c.arc(cx + SUN.x * R * 0.52, cy + SUN.y * R * 0.52, R * 0.24, 0, TAU); c.fill();
        add('rock', cv, cx, cy, R);
      }

      return out;
    },

    /* ---- WHERE THE CRATERS ARE ----
       Three grids at three scales, because a cratered plain IS a scale hierarchy and one grid can
       only ever produce one size of thing evenly spread — the definition of a texture. */
    place(push, x0, y0, x1, y1, clr, scale, pools) {
      const grids = [
        { C: 520, key: 'basin', p: 0.34, salt: 1, lod: 0 },
        { C: 190, key: 'crater', p: 0.40, salt: 2, lod: 0 },
        { C: 74, key: 'pit', p: 0.44, salt: 3, lod: 0.75 },
        { C: 74, key: 'rock', p: 0.30, salt: 4, lod: 1.1 },
      ];
      for (const g of grids) {
        if (scale < g.lod) continue;
        const arr = pools[g.key];
        if (!arr || !arr.length) continue;
        const cx0 = Math.floor(x0 / g.C), cx1 = Math.ceil(x1 / g.C);
        const cy0 = Math.floor(y0 / g.C), cy1 = Math.ceil(y1 / g.C);
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            if (h01(cx, cy, g.salt) > g.p) continue;
            const wx = (cx + h01(cx, cy, g.salt + 40)) * g.C;
            const wy = (cy + h01(cx, cy, g.salt + 50)) * g.C;
            /* THE PAD: the station sits on cleared, graded ground. Craters are suppressed under it
               for the same reason trees are — a rim running through the floor plan reads as a
               drawing laid over a picture. */
            if (clr && wx > clr.x && wx < clr.x + clr.w && wy > clr.y && wy < clr.y + clr.h) continue;
            push(arr[(h01(cx, cy, g.salt + 60) * arr.length) | 0], wx, wy);
          }
        }
      }
    },
  };

  /* ---------------------------------------------------------------------- registry ---- */

  const GROUNDS = { forest: FOREST, moon: MOON };
  const ORDER = ['forest', 'moon'];
  const has = id => Object.prototype.hasOwnProperty.call(GROUNDS, id);

  /* ---------------------------------------------------------------------- dispatch ---- */

  let curId = null;                          // null == no ground; the station is flying, spacebg owns the frame
  let st = null, builtId = '';

  function build(id) {
    const G = GROUNDS[id];
    const rnd = mulberry32(0x0FE57);         // fixed: the ground is a place, not a dice roll
    const patchCv = G.buildPatch(rnd);
    const dappleCv = G.buildOverlay ? G.buildOverlay(rnd) : null;
    const sprites = G.buildSprites(rnd);
    const pools = {};
    for (const s of sprites) (pools[s.kind] || (pools[s.kind] = [])).push(s);
    st = { patchCv, dappleCv, pattern: null, dapplePat: null, sprites, pools };
    builtId = id;
  }

  /* one scatter item, reused: the draw loop fills a pooled array rather than allocating
     thousands of objects per frame. */
  const ITEMS = [];
  let itemN = 0;
  const pushItem = (sp, x, y) => {
    const it = ITEMS[itemN] || (ITEMS[itemN] = { sp: null, x: 0, y: 0 });
    it.sp = sp; it.x = x; it.y = y; itemN++;
  };

  /* Draw the ground under the CURRENT world transform. Callers must already have applied
     setTransform(scale,0,0,scale,panX,panY) — that is what makes this pan and zoom for free.
     `station` is the bake's world rect and may be null before the first bake, in which case
     nothing is cleared and the ground simply closes over. */
  function draw(ctx, cam, cw, ch, station) {
    const id = curId;
    if (!id || !has(id)) return;
    if (builtId !== id || !st) build(id);
    const G = GROUNDS[id];

    const s = (cam && cam.scale) || 1;
    const px = (cam && cam.panX) || 0, py = (cam && cam.panY) || 0;
    const pad = G.CELL * 3;
    const x0 = -px / s - pad, y0 = -py / s - pad;
    const x1 = (cw - px) / s + pad, y1 = (ch - py) / s + pad;

    // 1. THE FLOOR — one fill through a repeating pattern, in the current transform space, so it
    // scales with the world exactly like the station bake does.
    if (!st.pattern) st.pattern = ctx.createPattern(st.patchCv, 'repeat');
    if (st.pattern) { ctx.fillStyle = st.pattern; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
    else { ctx.fillStyle = G.base; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }

    // 2. THE OVERLAY — light that lands ON the floor (canopy dapple, ray ejecta), additive and
    // drawn before anything stands on it.
    if (st.dappleCv) {
      if (!st.dapplePat) st.dapplePat = ctx.createPattern(st.dappleCv, 'repeat');
      if (st.dapplePat) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = G.OVERLAY_ALPHA || 0.34;
        ctx.fillStyle = st.dapplePat; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.restore();
      }
    }

    /* the CLEARING: the station's footprint plus a margin, kept free of anything tall. The rect is
       passed in rather than assumed at the origin — world.js blits the bake at (0,0) but REFIT
       blits it at cache.origin, and a clearing in the wrong place is worse than none. */
    const clr = station ? {
      x: (station.x || 0) - G.CELL * 0.5, y: (station.y || 0) - G.CELL * 0.5,
      w: station.w + G.CELL, h: station.h + G.CELL,
    } : null;

    // 3. THE SCATTER. Hashed per cell — no stored map, no growth over time, and stable: the same
    // cell always yields the same thing, so panning away and back finds the place unchanged. Each
    // ground owns its own placement rules; a forest and a cratered plain share nothing but the
    // hash, the pools and the y-sort.
    itemN = 0;
    G.place(pushItem, x0, y0, x1, y1, clr, s, st.pools);

    /* Y-SORT. Overlap is the only cue that says "canopy" instead of "stickers on a table": a near
       crown must cover the one behind it, and undergrowth must sit under the tree it grows beside.
       Sorting by world y is exactly the painter's order for a top-down-with-a-tilt camera. */
    const view = ITEMS.slice(0, itemN);
    view.sort((a, b) => a.y - b.y);
    for (let i = 0; i < view.length; i++) {
      const it = view[i], sp = it.sp;
      ctx.drawImage(sp.cv, Math.round(it.x - sp.ox), Math.round(it.y - sp.oy));
    }
  }

  /* how close a cell is to the clearing's edge, 0..1 — used to thicken the undergrowth around the
     station. A real clearing has a wall of growth at its rim; a hard cut with nothing at the edge
     reads as a mask, which is what it is. */
  function nearClearing(clr, wx, wy, C) {
    const dx = Math.max(clr.x - wx, 0, wx - (clr.x + clr.w));
    const dy = Math.max(clr.y - wy, 0, wy - (clr.y + clr.h));
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= 0 || d > C * 2.5) return 0;
    return 1 - d / (C * 2.5);
  }

  /* set the ground. Anything that is not a known ground id (a SKY id, or nothing) turns the layer
     OFF — spacebg then owns the frame, which is what "the station is flying" means. */
  function setGround(id) { curId = has(id) ? id : null; return curId; }
  const getGround = () => curId;
  const active = () => !!(curId && has(curId));
  const baseColor = () => (active() ? GROUNDS[curId].base : '#040302');
  const list = () => ORDER.map(id => ({ id, label: GROUNDS[id].label, blurb: GROUNDS[id].blurb || '', ground: true }));

  /* The picker's swatch: the REAL renderer, never a stand-in, so a preview cannot promise a place
     the station won't deliver.

     BUILT AT A REFERENCE SIZE AND SCALED DOWN, which is the same law the sky swatches learned:
     drawing straight into a 112x63 chip shows one third of one tree crown, because the features
     are sized in WORLD px and the chip is a tiny window onto the world — not a small picture of
     it. Rendering a proper 4x view and shrinking it shows the place instead of a close-up of its
     dirt. */
  function paintSample(ctx, w, h, id, zoom) {
    if (!has(id)) return;
    const keep = curId, keepSt = st, keepId = builtId;
    curId = id; st = null; builtId = '';
    const RW = Math.max(w, 448), RH = Math.round(RW * h / w);
    const ref = mkCv(RW, RH), rc = ref.getContext('2d');
    const z = zoom || 0.9;
    rc.fillStyle = GROUNDS[id].base; rc.fillRect(0, 0, RW, RH);
    rc.imageSmoothingEnabled = false;
    rc.setTransform(z, 0, 0, z, 0, 0);
    draw(rc, { scale: z, panX: 0, panY: 0 }, RW, RH, null);
    rc.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;                  // a smooth downscale, per the sprite law
    ctx.drawImage(ref, 0, 0, RW, RH, 0, 0, w, h);
    ctx.restore();
    curId = keep; st = keepSt; builtId = keepId;
  }

  return { draw, setGround, getGround, active, baseColor, list, paintSample, GROUNDS };
})();
