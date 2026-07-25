/* STARNET — terrain.js : THE GROUND. What the station is standing ON.

   THIS IS NOT A BACKDROP, AND THE DIFFERENCE IS THE WHOLE POINT.

   spacebg.js draws things at a DISTANCE, in screen space, deliberately not zooming — correct for
   a starfield or a sea a long way below. Terrain is at the SAME PLANE as the station: it must pan
   AND zoom with it, or the illusion dies on the first scroll-wheel tick. The camera zooms 0.5x to
   6x (world.js MINZ/MAXZ), a 12x range, so faking that in screen space would fall apart violently.

   So the ground is drawn in WORLD space, between world.js's setTransform() and the station bake.
   At that seam the camera transform is already applied, which means panning, zooming and the
   station's own coordinate frame all come for free — no parallax maths, no toroidal wrap, no
   camera plumbing. It is genuinely simpler than the backdrops, not harder.

   Two layers, because they fail differently:
     1. THE PATCH — soil, grass and litter. Fine texture, tiled with createPattern (ONE fillRect,
        not hundreds of drawImage). Fine texture can repeat every few hundred pixels invisibly.
     2. THE SCATTER — trees, boulders, bushes. These CANNOT tile: a repeating tree is instantly
        legible as wallpaper. They are placed by hashing world cell coordinates, which gives an
        infinite non-repeating field with no stored map, and drawn from pre-rendered sprites so a
        canopy costs one drawImage rather than a dozen gradients every frame.

   The station stands in a CLEARING: scatter is suppressed inside the station's world rect plus a
   margin. Without that, trees would sprout through the gaps in the floor plan and the base would
   read as a drawing laid on top of a picture rather than a thing built on ground. */
'use strict';

const Terrain = (typeof document === 'undefined') ? { active: () => false } : (() => {

  /* ---------------------------------------------------------------- shared helpers ---- */

  const mkCv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (+a).toFixed(3) + ')';
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  function mulberry32(seed) {
    let a = seed | 0;
    return () => {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* A stable hash of a world CELL. This is what makes the scatter infinite without a stored map:
     the same cell always yields the same tree, so walking away and back finds the forest
     unchanged, and there is nothing to persist or to grow without bound. */
  function cellRnd(cx, cy, salt) {
    let h = Math.imul(cx | 0, 374761393) ^ Math.imul(cy | 0, 668265263) ^ Math.imul(salt | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return mulberry32((h ^ (h >>> 16)) >>> 0);
  }

  /* value noise on an N x N lattice, WRAPPING — the patch has to tile, so every lattice lookup is
     taken modulo N and the texture is seamless by construction rather than by touch-up. */
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

  /* ------------------------------------------------------------------ GROUND: FOREST ---- */
  /* Forest FLOOR, not forest canopy. Canopy from altitude is a continuous organic mass with no
     structure to hang detail on — the same problem that made open water hard. The floor is a base
     texture plus discrete scattered objects, which is a solved, cheap shape.

     It is dark on purpose. A forest floor sits under shade, and the station must stay the
     brightest thing on screen (backdrop/station luma ~0.5-0.65 — the law learned from OCEAN,
     which shipped at 1.25 and made the station read as a cutout). Shade does that work for us. */

  const FOREST = {
    label: 'FOREST',
    blurb: 'Landed. Old trees, deep leaf litter, no one around.',
    base: '#12160f',                       // shows only in the instant before the pattern lands
    PATCH: 256,                            // world px; fine texture, so this repeat is invisible
    CELL: 72,                              // world px per scatter cell (6 station tiles)
    LIGHT: {
      SOIL_D: [26, 22, 16], SOIL_L: [44, 37, 25],
      GRASS_D: [21, 33, 17], GRASS_L: [45, 63, 29],
      LITTER: [58, 43, 25], STONE: [50, 50, 47],
      CANOPY_D: [20, 34, 17], CANOPY_M: [31, 50, 24], CANOPY_L: [48, 72, 34],
      SHADOW_A: 0.34,
    },

    /* ---- the tiling floor ---- */
    buildPatch(rnd) {
      const P = FOREST.PATCH, LT = FOREST.LIGHT;
      const cv = mkCv(P, P), c = cv.getContext('2d');
      const n1 = noiseField(4, rnd), n2 = noiseField(8, rnd), n3 = noiseField(16, rnd);
      const img = c.createImageData(P, P), D = img.data;
      let p = 0;
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const u = x / P, v = y / P;
          const n = n1(u, v) * 0.52 + n2(u, v) * 0.32 + n3(u, v) * 0.16;
          // low noise = bare soil, high = grass. A soft threshold keeps the border organic.
          const grass = Math.max(0, Math.min(1, (n - 0.38) * 3.1));
          const soil = mix(LT.SOIL_D, LT.SOIL_L, n3(u, v));
          const gr = mix(LT.GRASS_D, LT.GRASS_L, n2(u * 2, v * 2));
          const col = mix(soil, gr, grass);
          D[p] = col[0]; D[p + 1] = col[1]; D[p + 2] = col[2]; D[p + 3] = 255;
          p += 4;
        }
      }
      c.putImageData(img, 0, 0);

      /* litter + stones — small discrete marks. Drawn with wrap so the patch stays seamless. */
      const stamp = (x, y, w, h, style) => {
        c.fillStyle = style;
        for (const ox of [x - P, x, x + P]) for (const oy of [y - P, y, y + P]) c.fillRect(ox, oy, w, h);
      };
      for (let i = 0, n = 900; i < n; i++) {         // leaf litter, warm and flat
        const x = rnd() * P, y = rnd() * P;
        stamp(x | 0, y | 0, 1 + ((rnd() * 2) | 0), 1, rgba(LT.LITTER, 0.10 + 0.28 * rnd()));
      }
      for (let i = 0, n = 260; i < n; i++) {         // grass tufts, a shade brighter than the mat
        const x = rnd() * P, y = rnd() * P;
        stamp(x | 0, y | 0, 1, 1 + ((rnd() * 2) | 0), rgba(LT.GRASS_L, 0.16 + 0.30 * rnd()));
      }
      for (let i = 0, n = 70; i < n; i++) {          // small stones, with a hint of top-left light
        const x = (rnd() * P) | 0, y = (rnd() * P) | 0, s = 1 + ((rnd() * 2) | 0);
        stamp(x, y, s, s, rgba(LT.STONE, 0.22 + 0.22 * rnd()));
        stamp(x, y, 1, 1, rgba([90, 90, 86], 0.20));
      }
      return cv;
    },

    /* ---- the scatter sprites: pre-rendered once, then one drawImage per instance ----
       A canopy is ~8 overlapping blobs. Drawing that per tree per frame would be thousands of
       gradient fills; pre-rendering makes a tree cost the same as a single blit. */
    buildSprites(rnd) {
      const LT = FOREST.LIGHT;
      const sprites = [];

      // TREES — a rough mass of lobes, lit top-left, sitting on its own cast shadow
      for (let v = 0; v < 5; v++) {
        const R = 15 + Math.round(rnd() * 11);           // canopy radius in world px (~2-4 tiles)
        const pad = Math.ceil(R * 0.55);
        const S = (R + pad) * 2;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        const cx = S / 2, cy = S / 2;
        // cast shadow first, offset down-right (light is top-left, consistently, everywhere)
        c.fillStyle = 'rgba(0,0,0,' + LT.SHADOW_A + ')';
        c.beginPath(); c.ellipse(cx + R * 0.34, cy + R * 0.40, R * 0.92, R * 0.66, 0, 0, Math.PI * 2); c.fill();
        // the mass
        const lobes = 7 + Math.floor(rnd() * 4);
        for (let i = 0; i < lobes; i++) {
          const a = (i / lobes) * Math.PI * 2 + rnd() * 0.5;
          const d = R * (0.20 + 0.42 * rnd());
          const lr = R * (0.44 + 0.30 * rnd());
          const lx = cx + Math.cos(a) * d, ly = cy + Math.sin(a) * d;
          const lit = Math.max(0, (-Math.cos(a - 2.36)));   // brightest toward the top-left
          c.fillStyle = rgba(mix(LT.CANOPY_D, LT.CANOPY_M, 0.35 + 0.5 * rnd()), 1);
          c.beginPath(); c.arc(lx, ly, lr, 0, Math.PI * 2); c.fill();
          if (lit > 0.25) {                                  // the lit rim of each lobe
            c.fillStyle = rgba(mix(LT.CANOPY_M, LT.CANOPY_L, lit), 0.85);
            c.beginPath(); c.arc(lx - lr * 0.22, ly - lr * 0.22, lr * 0.62, 0, Math.PI * 2); c.fill();
          }
        }
        // a dark core so the crown does not read as a flat disc
        c.fillStyle = rgba(LT.CANOPY_D, 0.5);
        c.beginPath(); c.arc(cx + R * 0.12, cy + R * 0.14, R * 0.42, 0, Math.PI * 2); c.fill();
        sprites.push({ cv, ox: cx, oy: cy, kind: 'tree', w: R * 2 });
      }

      // BUSHES / FERNS — smaller, flatter, no cast shadow worth the pixels
      for (let v = 0; v < 4; v++) {
        const R = 5 + Math.round(rnd() * 5);
        const S = R * 3;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        const cx = S / 2, cy = S / 2;
        for (let i = 0, n = 5 + Math.floor(rnd() * 4); i < n; i++) {
          const a = rnd() * Math.PI * 2, d = R * rnd() * 0.7;
          c.fillStyle = rgba(mix(LT.GRASS_D, LT.CANOPY_M, rnd()), 0.9);
          c.beginPath(); c.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, R * (0.36 + 0.30 * rnd()), 0, Math.PI * 2); c.fill();
        }
        sprites.push({ cv, ox: cx, oy: cy, kind: 'bush', w: R * 2 });
      }

      // BOULDERS — the only cool-grey mass out there, so they read as stone not foliage
      for (let v = 0; v < 3; v++) {
        const R = 7 + Math.round(rnd() * 7);
        const S = R * 3;
        const cv = mkCv(S, S), c = cv.getContext('2d');
        const cx = S / 2, cy = S / 2;
        c.fillStyle = 'rgba(0,0,0,' + (LT.SHADOW_A * 0.8) + ')';
        c.beginPath(); c.ellipse(cx + R * 0.3, cy + R * 0.34, R * 0.9, R * 0.6, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = rgba(LT.STONE, 1);
        c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
        c.fillStyle = rgba([96, 96, 92], 0.55);           // top-left facet catching the light
        c.beginPath(); c.arc(cx - R * 0.26, cy - R * 0.28, R * 0.55, 0, Math.PI * 2); c.fill();
        sprites.push({ cv, ox: cx, oy: cy, kind: 'rock', w: R * 2 });
      }
      return sprites;
    },
  };

  /* ---------------------------------------------------------------------- registry ---- */

  const GROUNDS = { forest: FOREST };
  const ORDER = ['forest'];
  const has = id => Object.prototype.hasOwnProperty.call(GROUNDS, id);

  /* ---------------------------------------------------------------------- dispatch ---- */

  let curId = null;                          // null == no ground; the station is flying and spacebg owns the frame
  let st = null, builtId = '';

  function build(id) {
    const G = GROUNDS[id];
    const rnd = mulberry32(0x0FE57);
    const patchCv = G.buildPatch(rnd);
    st = { patchCv, pattern: null, sprites: G.buildSprites(rnd) };
    builtId = id;
  }

  /* Draw the ground under the CURRENT world transform. Callers must already have applied
     setTransform(scale,0,0,scale,panX,panY) — that is what makes this pan and zoom for free.
     `station` is the bake's world rect ({w,h} at the origin) and may be null before the first
     bake, in which case nothing is cleared and the forest simply closes over. */
  function draw(ctx, cam, cw, ch, station) {
    const id = curId;
    if (!id || !has(id)) return;
    if (builtId !== id || !st) build(id);
    const G = GROUNDS[id];

    // the visible world rect, from inverting the camera. Padded by a cell so scatter that
    // overhangs the edge still draws instead of popping in at the border.
    const s = (cam && cam.scale) || 1;
    const px = (cam && cam.panX) || 0, py = (cam && cam.panY) || 0;
    const pad = G.CELL * 2;
    const x0 = -px / s - pad, y0 = -py / s - pad;
    const x1 = (cw - px) / s + pad, y1 = (ch - py) / s + pad;

    // 1. THE FLOOR — one fill through a repeating pattern. The pattern lives in the current
    // transform space, so it scales with the world exactly like the station bake does.
    if (!st.pattern) st.pattern = ctx.createPattern(st.patchCv, 'repeat');
    if (st.pattern) {
      ctx.fillStyle = st.pattern;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    } else {                                    // pattern creation can fail on a zero-size canvas
      ctx.fillStyle = G.base;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }

    // 2. THE SCATTER — hash per cell. No stored map, no growth over time, and stable: the same
    // cell always grows the same tree, so panning away and back finds the forest unchanged.
    const C = G.CELL;
    const cx0 = Math.floor(x0 / C), cx1 = Math.ceil(x1 / C);
    const cy0 = Math.floor(y0 / C), cy1 = Math.ceil(y1 / C);
    /* the CLEARING: the station's footprint plus a margin, kept free of anything tall. The rect
       is passed in rather than assumed at the origin — world.js blits the bake at (0,0) but
       REFIT blits it at cache.origin, and a clearing in the wrong place is worse than none. */
    const clr = station ? {
      x: (station.x || 0) - C * 0.6, y: (station.y || 0) - C * 0.6,
      w: station.w + C * 1.2, h: station.h + C * 1.2,
    } : null;

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const r = cellRnd(cx, cy, 1);
        if (r() > 0.62) continue;                         // most cells are open floor
        const wx = (cx + r()) * C, wy = (cy + r()) * C;
        if (clr && wx > clr.x && wx < clr.x + clr.w && wy > clr.y && wy < clr.y + clr.h) continue;
        const pick = r();
        const pool = pick < 0.52 ? 'tree' : pick < 0.82 ? 'bush' : 'rock';
        const cands = st.sprites.filter(sp => sp.kind === pool);
        if (!cands.length) continue;
        const sp = cands[Math.floor(r() * cands.length) % cands.length];
        ctx.drawImage(sp.cv, Math.round(wx - sp.ox), Math.round(wy - sp.oy));
      }
    }
  }

  /* set the ground. Anything that is not a known ground id (a SKY id, or nothing) turns the
     layer OFF — spacebg then owns the frame, which is what "the station is flying" means. */
  function setGround(id) { curId = has(id) ? id : null; return curId; }
  const getGround = () => curId;
  const active = () => !!(curId && has(curId));
  const baseColor = () => (active() ? GROUNDS[curId].base : '#040302');
  const list = () => ORDER.map(id => ({ id, label: GROUNDS[id].label, blurb: GROUNDS[id].blurb || '', ground: true }));

  /* the picker's swatch: the real renderer, at a plausible play zoom, with no station to clear
     around — so what you see is exactly the ground the station will stand on. */
  function paintSample(ctx, w, h, id, zoom) {
    if (!has(id)) return;
    const keep = curId, keepSt = st, keepId = builtId;
    curId = id; st = null; builtId = '';
    const z = zoom || 2.2;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(z, 0, 0, z, 0, 0);
    draw(ctx, { scale: z, panX: 0, panY: 0 }, w, h, null);
    ctx.restore();
    curId = keep; st = keepSt; builtId = keepId;
  }

  return { draw, setGround, getGround, active, baseColor, list, paintSample, GROUNDS };
})();
