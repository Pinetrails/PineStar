/* STARNET — spacebg.js : THE BACKDROP. What the station floats in.

   One shared backdrop for the live world (world.js) AND REFIT (build.js), so entering/exiting
   build mode never jumps the sky. Originally a single hardcoded deep-space field; now a small
   REGISTRY of backdrops the commander picks (station-wide, persisted in the StationUI store).

   THE LAW OF THIS FILE, in order of importance:

   1. THE VOID IS FROZEN. It is the default and it renders byte-identical to what shipped.
      On 2026-07-14 a galaxy + ringed planet were added to it and Andrew had them reverted
      (514386de: "keep the sky to starfield + nebulas + band + meteor"). That call stands.
      Richer space lives in DEEP FIELD, which is opt-in. Never decorate the default.
   2. A BACKDROP IS NOT A WALLPAPER. Anything at a finite distance below the station MUST
      parallax with the camera, or the eye reads "picture behind a picture" instantly. Deep
      space is the one honest exception — it has no near reference, so THE VOID's depths are
      0/0 and it stays nailed to the screen exactly as before.
   3. THE CAMERA NEVER TILTS. Every backdrop is a thing seen from directly above, at altitude.
      No horizon, no sun in frame, no "up". The station floats; you look past it, straight down.

   Structure:
     - shared helpers: seeded PRNG, star tints, wrapped puff stamps, toroidal tile draw
     - shared weather: the rare meteor and the very rare bolide (space backdrops opt in)
     - BACKDROPS registry: each { label, build(w,h,rnd) -> state, draw(ctx,w,h,now,cam,st) }
     - dispatch: variant-aware tile cache, resize settling, public API

   Coordinates are DEVICE pixels (callers pass canvas.width/height) and draw() is called with
   the IDENTITY transform, before the world's setTransform(scale,0,0,scale,panX,panY). The
   camera is handed in separately so each backdrop can parallax by its own per-layer depth.

   Everything is seeded (mulberry32, fixed seed per backdrop) so the same backdrop at the same
   canvas size always grows the same world — a resize re-lays it deterministically instead of
   reshuffling. Pre-rendered tiles wrap: THE VOID wraps horizontally only (3-stamp, its layers
   never move in y); every backdrop that parallaxes vertically wraps in BOTH axes (9-stamp
   author + 2x2 draw), or a vertical pan tears the tile seam straight across the screen.

   Tuning note inherited from the original field: everything here is judged AFTER the barrel
   warp + CRT pass in world.js, which eats roughly half the contrast. Values look too bold in
   isolation on purpose. Never tune a backdrop on a bare canvas. */
'use strict';

const SpaceBG = (() => {
  const SEED = 0x57A2BE7;                            // fixed: the sky is a place, not a dice roll

  /* ---------------------------------------------------------------- shared helpers ---- */

  function mulberry32(seed) {
    let a = seed | 0;
    return () => {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // star tints: mostly pale blue-white, some warm white, rare violet/teal — weights cumulative
  const TINTS = [
    [0.45, 'rgba(180,200,230,'], [0.72, 'rgba(205,218,242,'], [0.87, 'rgba(255,226,188,'],
    [0.95, 'rgba(196,168,255,'], [1.01, 'rgba(150,235,222,'],
  ];
  const pickTint = r => { for (const t of TINTS) if (r < t[0]) return t[1]; return TINTS[0][1]; };

  // nebula hue families [r,g,b] — the station's phosphor palette pushed into the void
  const NEB_HUES = [[150, 90, 255], [255, 90, 190], [90, 200, 255], [90, 255, 200]];

  const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (+a).toFixed(3) + ')';
  const px1 = () => Math.max(1, Math.round((typeof window !== 'undefined' && window.devicePixelRatio) || 1));

  /* stamp one soft radial puff, wrapped HORIZONTALLY (x-w / x / x+w) — for layers that only
     ever scroll in x. THE VOID uses this; changing it to the 9-stamp below would add puff
     copies at the top/bottom edges and break law 1. */
  function puff(c, w, x, y, r, rgb, a) {
    for (const xo of [x - w, x, x + w]) {
      if (xo + r < 0 || xo - r > w) continue;
      const g = c.createRadialGradient(xo, y, 0, xo, y, r);
      g.addColorStop(0, rgba(rgb, a));
      g.addColorStop(1, rgba(rgb, 0));
      c.fillStyle = g;
      c.fillRect(xo - r, y - r, r * 2, r * 2);
    }
  }

  /* the same puff stamped across a 3x3 neighbourhood — TOROIDAL, so the tile is seamless under
     a pan in both axes. Any backdrop with a non-zero vertical parallax depth must author with
     this, not puff(). */
  function puff9(c, w, h, x, y, r, rgb, a) {
    for (const xo of [x - w, x, x + w]) {
      if (xo + r < 0 || xo - r > w) continue;
      for (const yo of [y - h, y, y + h]) {
        if (yo + r < 0 || yo - r > h) continue;
        const g = c.createRadialGradient(xo, yo, 0, xo, yo, r);
        g.addColorStop(0, rgba(rgb, a));
        g.addColorStop(1, rgba(rgb, 0));
        c.fillStyle = g;
        c.fillRect(xo - r, yo - r, r * 2, r * 2);
      }
    }
  }

  /* draw a pre-rendered tile scrolled to (ox,oy), wrapping in BOTH axes. Four copies always
     cover the viewport: with the offset normalised into [0,w)x[0,h), the copy at (x-w,y-h)
     starts at or before the origin and the copy at (x,y) ends at or after (w,h). Fully
     offscreen copies cost nothing worth measuring. */
  function tile2(ctx, cv, w, h, ox, oy) {
    const x = ((ox % w) + w) % w, y = ((oy % h) + h) % h;
    ctx.drawImage(cv, x - w, y - h, w, h);
    ctx.drawImage(cv, x, y - h, w, h);
    ctx.drawImage(cv, x - w, y, w, h);
    ctx.drawImage(cv, x, y, w, h);
  }

  const mkCv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  /* screen offset for a layer at parallax depth d: 0 = infinitely far (nailed to the screen,
     the old behaviour), 1 = rides exactly with the station. The camera pans the world by
     (panX,panY), so a layer at depth d follows that fraction of it. */
  const parX = (cam, d) => (cam ? cam.panX || 0 : 0) * d;
  const parY = (cam, d) => (cam ? cam.panY || 0 : 0) * d;

  /* reduced-motion: never ADD dramatic motion (the meteor) when the OS asks for less; the gentle
     twinkle/scroll predates this module and stays. Live-read, same idiom as world.js. */
  const _rmq = (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduceMotion = () => !!(_rmq && _rmq.matches);

  /* ---------------------------------------------------------------- shared weather ---- */
  /* Runtime Math.random on purpose, and deliberately NOT part of any backdrop's seeded build:
     the WORLD is a stable seeded place, weather is weather. State is module-level so it keeps
     its rhythm across a backdrop switch. */

  let meteor = null, nextMeteorAt = 0;
  let bolide = null, nextBolideAt = 0;

  /* THE METEOR — a rare, silent shooting star (one live at a time, ~1-2 per minute).
     Skipped entirely under prefers-reduced-motion (never ADD dramatic motion the OS asked us not to). */
  function drawMeteor(ctx, w, h, now) {
    if (!nextMeteorAt) { nextMeteorAt = now + 20000 + Math.random() * 40000; return; }   // first one 20-60s in
    if (!meteor) {
      if (reduceMotion() || now < nextMeteorAt) return;
      const dirx = Math.random() < 0.5 ? -1 : 1;
      const ang = (0.30 + Math.random() * 0.35) * Math.PI / 2;   // shallow-to-mid diagonal, always downward
      const spd = w * (0.28 + Math.random() * 0.22);             // px/s — crosses ~a third of the sky in its life
      meteor = {
        x: (0.15 + Math.random() * 0.7) * w, y: (0.05 + Math.random() * 0.4) * h,
        vx: Math.cos(ang) * spd * dirx, vy: Math.sin(ang) * spd,
        born: now, life: 900 + Math.random() * 500,
      };
    }
    const t = (now - meteor.born) / meteor.life;
    if (t >= 1) { meteor = null; nextMeteorAt = now + 45000 + Math.random() * 60000; return; }
    const a = Math.sin(Math.PI * t);                             // fade in → streak → fade out
    const el = (now - meteor.born) / 1000;
    const hx = meteor.x + meteor.vx * el, hy = meteor.y + meteor.vy * el;
    for (let k = 0; k < 9; k++) {                                // trail: dimming embers back along the path
      const tx = hx - meteor.vx * k * 0.011, ty = hy - meteor.vy * k * 0.011;
      ctx.fillStyle = 'rgba(220,230,255,' + (a * (1 - k / 9) * 0.85).toFixed(3) + ')';
      ctx.fillRect(tx, ty, k < 2 ? 2 : 1, k < 2 ? 2 : 1);
    }
  }

  /* THE GREAT ONE — an extremely rare bolide: brighter, slower, longer than the common meteor,
     with a glowing head and a long ember trail. First window 30min-3h after boot, then 1-5h
     between sightings — most sessions never see it; the ones that do, remember it. */
  function drawBolide(ctx, w, h, now) {
    if (!nextBolideAt) { nextBolideAt = now + (30 + Math.random() * 150) * 60000; return; }
    if (!bolide) {
      if (reduceMotion() || now < nextBolideAt) return;
      const dirx = Math.random() < 0.5 ? -1 : 1;
      const ang = (0.20 + Math.random() * 0.30) * Math.PI / 2;   // shallow, majestic descent
      const spd = w * (0.16 + Math.random() * 0.08);             // slower than the meteor — it lingers
      bolide = {
        x: (0.2 + Math.random() * 0.6) * w, y: (0.05 + Math.random() * 0.30) * h,
        vx: Math.cos(ang) * spd * dirx, vy: Math.sin(ang) * spd,
        born: now, life: 2400 + Math.random() * 900,
      };
    }
    const t = (now - bolide.born) / bolide.life;
    if (t >= 1) { bolide = null; nextBolideAt = now + (60 + Math.random() * 240) * 60000; return; }
    const a = Math.sin(Math.PI * t);
    const el = (now - bolide.born) / 1000;
    const hx = bolide.x + bolide.vx * el, hy = bolide.y + bolide.vy * el;
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 10);   // the glowing head
    g.addColorStop(0, 'rgba(210,255,240,' + (a * 0.9).toFixed(3) + ')');
    g.addColorStop(0.35, 'rgba(150,240,220,' + (a * 0.35).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(150,240,220,0)');
    ctx.fillStyle = g; ctx.fillRect(hx - 10, hy - 10, 20, 20);
    ctx.fillStyle = 'rgba(240,255,250,' + (a * 0.95).toFixed(3) + ')'; ctx.fillRect(hx - 1, hy - 1, 3, 3);
    for (let k = 1; k < 20; k++) {                               // the long ember trail
      const tx = hx - bolide.vx * k * 0.016, ty = hy - bolide.vy * k * 0.016;
      ctx.fillStyle = 'rgba(190,245,230,' + (a * (1 - k / 20) * 0.7).toFixed(3) + ')';
      ctx.fillRect(tx, ty, k < 5 ? 2 : 1, k < 5 ? 2 : 1);
    }
  }

  /* ------------------------------------------------------------- BACKDROP: THE VOID ---- */
  /* FROZEN (law 1). Interstellar deep space: nebulas → dust → twinkle bands → weather. Depths
     are 0/0 — it does not parallax, because deep space genuinely has no near reference and
     this is the look that shipped and was signed off. Do not add bodies to it; DEEP FIELD is
     where richer space goes. */

  const VOID_BG = {
    label: 'THE VOID',
    blurb: 'Interstellar. Nebulas, dust, and the long dark.',
    base: '#040302',                       // the dispatcher clears to this before draw()
    // px/sec drift per depth layer, far → near (old single layer was 8; old bands 3/8/15).
    SPD: { neb: 1.2, dust: 3, mid: 8, near: 15 },
    DIM_MID: 0.8, DIM_NEAR: 1.0,           // per-band brightness scale (matches old Slice-4 feel)

    build(w, h, rnd) {
      const area = w * h;
      const u = px1();                     // star pixel unit — keeps grain consistent across dpr

      /* ---- layer 1: NEBULAS (farthest) ---- */
      const nebCv = mkCv(w, h);
      const nc = nebCv.getContext('2d');
      nc.globalCompositeOperation = 'lighter';         // gas glows additively — overlaps bloom, never mud
      const blobs = area > 2.2e6 ? 4 : 3;
      for (let b = 0; b < blobs; b++) {
        const cx = rnd() * w, cy = h * (0.10 + 0.72 * rnd());
        const R = (0.20 + 0.24 * rnd()) * Math.min(w, h);
        const hue = NEB_HUES[Math.floor(rnd() * NEB_HUES.length) % NEB_HUES.length];
        const acc = NEB_HUES[Math.floor(rnd() * NEB_HUES.length) % NEB_HUES.length];
        for (let p = 0; p < 7; p++) {                  // 7 jittered puffs per cloud → organic, not a perfect disc
          const px = cx + (rnd() - 0.5) * R * 1.3, py = cy + (rnd() - 0.5) * R * 0.9;
          puff(nc, w, px, py, R * (0.35 + 0.45 * rnd()), p < 5 ? hue : acc, 0.06 + 0.05 * rnd());
        }
        puff(nc, w, cx, cy, R * 0.30, hue, 0.16);      // the bright heart of the cloud
        // local star cluster — real nebulas sit in crowded sky
        for (let s = 0, n = 24 + Math.floor(rnd() * 20); s < n; s++) {
          const ang = rnd() * Math.PI * 2, d = rnd() * R;
          nc.fillStyle = 'rgba(220,225,250,' + (0.10 + 0.25 * rnd()).toFixed(3) + ')';
          nc.fillRect(((cx + Math.cos(ang) * d) % w + w) % w, cy + Math.sin(ang) * d * 0.8, 1, 1);
        }
      }
      /* the galactic band: a sine curve periodic in w (wraps seamlessly) — faint glow + dust bias below */
      const bandY = h * (0.22 + 0.5 * rnd()), bandAmp = h * (0.05 + 0.06 * rnd()), bandPh = rnd() * Math.PI * 2;
      const bandHalf = h * 0.11;
      const bandAt = x => bandY + bandAmp * Math.sin((x / w) * Math.PI * 2 + bandPh);
      const bandHue = NEB_HUES[Math.floor(rnd() * NEB_HUES.length) % NEB_HUES.length];
      for (let i = 0; i < 26; i++) {
        const bx = (i / 26) * w + (rnd() - 0.5) * w * 0.03;
        puff(nc, w, bx, bandAt(bx) + (rnd() - 0.5) * bandHalf * 0.8, bandHalf * (1.1 + 0.7 * rnd()), bandHue, 0.028 + 0.022 * rnd());
      }

      /* ---- layer 2: DUST (dense static far field) ---- */
      const dustCv = mkCv(w, h);
      const dc = dustCv.getContext('2d');
      const dustN = Math.min(8000, Math.round(area / 1100));
      for (let i = 0; i < dustN; i++) {
        const x = rnd() * w;
        // 35% of the dust condenses onto the galactic band — the field reads structured, not uniform noise
        const y = rnd() < 0.35
          ? bandAt(x) + (rnd() + rnd() - 1) * bandHalf     // triangular falloff around the curve
          : rnd() * h;
        dc.fillStyle = pickTint(rnd()) + (0.25 + 0.5 * rnd()).toFixed(3) + ')';   // bold enough to survive the CRT pass (scanlines+warp eat ~half)
        dc.fillRect(x, ((y % h) + h) % h, rnd() < 0.88 ? 1 : 2, 1);
      }

      /* ---- layers 3+4: the live twinkle bands (area-scaled, capped for per-frame cost) ---- */
      const mid = [], near = [];
      const midN = Math.min(340, Math.round(area / 11000)), nearN = Math.min(190, Math.round(area / 24000));
      for (let i = 0; i < midN; i++) mid.push({ x: rnd(), y: rnd(), r: rnd() < 0.85 ? u : u * 2, ph: rnd() * 10, c: pickTint(rnd()) });
      for (let i = 0; i < nearN; i++) near.push({ x: rnd(), y: rnd(), r: rnd() < 0.6 ? u : u * 2, ph: rnd() * 10, c: pickTint(rnd()), glint: rnd() < 0.08 });

      return { nebCv, dustCv, mid, near };
    },

    draw(ctx, w, h, now, cam, st) {
      const S = VOID_BG.SPD;
      const nx = (now / 1000 * S.neb) % w;             // two-copy wrap scroll, same idiom per layer
      ctx.globalAlpha = 0.9 + 0.1 * Math.sin(now / 7000);   // the gas breathes, slowly
      ctx.drawImage(st.nebCv, nx - w, 0, w, h); ctx.drawImage(st.nebCv, nx, 0, w, h);
      const dx = (now / 1000 * S.dust) % w;
      ctx.globalAlpha = 0.92 + 0.08 * Math.sin(now / 4100);
      ctx.drawImage(st.dustCv, dx - w, 0, w, h); ctx.drawImage(st.dustCv, dx, 0, w, h);
      ctx.globalAlpha = 1;

      for (const s of st.mid) {
        const tw = (0.35 + 0.65 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph))) * VOID_BG.DIM_MID;
        ctx.fillStyle = s.c + tw.toFixed(3) + ')';
        ctx.fillRect((s.x * w + now / 1000 * S.mid) % w, s.y * h, s.r, s.r);
      }
      for (const s of st.near) {
        const tw = (0.35 + 0.65 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph))) * VOID_BG.DIM_NEAR;
        const x = (s.x * w + now / 1000 * S.near) % w, y = s.y * h;
        ctx.fillStyle = s.c + tw.toFixed(3) + ')';
        ctx.fillRect(x, y, s.r, s.r);
        if (s.glint && tw > 0.55) {                    // the brightest few flare into a 4-point glint at twinkle peak
          ctx.fillStyle = s.c + (tw * 0.30).toFixed(3) + ')';
          ctx.fillRect(x - s.r * 2, y + (s.r >> 1), s.r * 5, 1);
          ctx.fillRect(x + (s.r >> 1), y - s.r * 2, 1, s.r * 5);
        }
      }

      drawMeteor(ctx, w, h, now);
      drawBolide(ctx, w, h, now);
    },
  };

  /* ---------------------------------------------------------------------- registry ---- */

  const BACKDROPS = { void: VOID_BG };
  const ORDER = ['void'];
  const DEFAULT_ID = 'void';

  const has = id => Object.prototype.hasOwnProperty.call(BACKDROPS, id);
  const resolve = id => (has(id) ? id : DEFAULT_ID);

  /* ---------------------------------------------------------------------- dispatch ---- */

  let curId = DEFAULT_ID;
  let st = null;                                     // the built state, or null before first build
  let builtId = '', builtW = 0, builtH = 0;          // WHAT that state was built for
  let pendKey = '', pendAt = 0;                      // resize settling (see draw)

  function rebuild(id, w, h) {
    st = BACKDROPS[id].build(w, h, mulberry32(SEED));
    builtId = id; builtW = w; builtH = h;
  }

  /* the whole backdrop, base fill included — callers do NOT pre-fill (identity transform,
     device px). `cam` is the world camera {panX,panY,scale}; omit it and every backdrop
     behaves as if the camera sat at the origin (which is exactly THE VOID's behaviour). */
  function draw(ctx, w, h, now, cam) {
    const id = resolve(curId);
    ctx.fillStyle = BACKDROPS[id].base || '#040302'; ctx.fillRect(0, 0, w, h);
    if (!w || !h) return;

    /* The cache is keyed on the BACKDROP ID as well as the size. Size alone was the original
       design and becomes a trap the moment backdrops are switchable: picking a new one at the
       same canvas size would keep the old tiles and the picker would look broken. */
    if (builtId !== id) {
      // a switch is never a settle case — rebuild now, or the commander watches the old sky
      // sit there for a quarter second after picking a new one.
      rebuild(id, w, h); pendKey = '';
    } else if (builtW !== w || builtH !== h) {
      // a seam-drag streams ResizeObserver sizes — rebuilding the tiles per tick (8k specks +
      // gradients) would jank the drag. Draw the OLD tiles stretched until the size holds ~250ms.
      // But stretching only reads right for SMALL deltas: snapping open from a collapsed stage
      // (canvas floored at 1px) would smear a 1px-wide tile of 'lighter' nebulas + dense dust
      // across the whole sky — a bright flash. Big jumps up (or a degenerate old tile) rebuild NOW.
      const key = w + 'x' + h;
      if (w > builtW * 1.5 || h > builtH * 1.5 || builtW < 48 || builtH < 48) rebuild(id, w, h);
      else if (pendKey !== key) { pendKey = key; pendAt = now; }
      else if (now - pendAt > 250) rebuild(id, w, h);
    } else pendKey = '';

    BACKDROPS[id].draw(ctx, w, h, now, cam, st);
    ctx.globalAlpha = 1;                             // never leak a layer alpha into the world pass
  }

  /* pick the station's backdrop. Returns the id actually in effect (an unknown id falls back
     to the default rather than blanking the sky). Idempotent — re-picking the current one does
     not force a rebuild. */
  function setBackdrop(id) {
    const next = resolve(id);
    if (next !== curId) { curId = next; pendKey = ''; }
    return curId;
  }
  const getBackdrop = () => curId;

  /* the picker's menu, in display order — [{ id, label, blurb }] */
  const list = () => ORDER.map(id => ({ id, label: BACKDROPS[id].label, blurb: BACKDROPS[id].blurb || '' }));

  /* Paint one backdrop into an arbitrary canvas context, off the live selection — this is what
     the picker's swatches use, so a preview is the REAL renderer and can never promise a sky
     the station won't deliver (the same law the deck/wall material swatches follow). Builds a
     throwaway state at the swatch's own size; never touches the live tile cache. */
  function paintSample(ctx, w, h, id, now) {
    const bid = resolve(id);
    const state = BACKDROPS[bid].build(w, h, mulberry32(SEED));
    BACKDROPS[bid].draw(ctx, w, h, now || 0, null, state);
    ctx.globalAlpha = 1;
  }

  return { draw, setBackdrop, getBackdrop, list, paintSample, DEFAULT_ID };
})();
