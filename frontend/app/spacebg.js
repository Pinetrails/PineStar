/* STARNET — spacebg.js : THE VOID. The deep-space backdrop behind the station.

   One shared sky for the live world (world.js) AND REFIT (build.js), so entering/exiting
   build mode never jumps the stars. Replaces the old ~90/110-star fixed sprinkles with a
   real deep field, back to front:

     1. NEBULAS  — 3-4 distant gas clouds (phosphor violet/magenta/teal) + ONE spiral galaxy
                   (log-spiral arms, warm core), pre-rendered once per canvas size onto an
                   offscreen tile, drifting slowest of all.
     2. DUST     — a dense area-scaled field of faint 1px stars (hundreds to thousands),
                   thickened along a sine-wrapped galactic band, + ONE small ringed planet;
                   pre-rendered + scrolled (the planet parallaxes apart from the galaxy).
     3. MID/NEAR — the live twinkling bands (per-star phase, tinted), the near band bright
                   and fast with a few 4-point glint stars, + the rare silent meteor.

   Everything is seeded (mulberry32, fixed seed) so the same canvas size always grows the
   same sky — a resize re-lays the field deterministically instead of reshuffling it.
   Pre-rendered tiles wrap horizontally: blobs are stamped at x-w/x/x+w and the band curve
   is periodic in w, so the two-copy scroll draw is seamless. All coordinates are DEVICE
   pixels (callers pass canvas.width/height); draw() is called with the identity transform. */
'use strict';

const SpaceBG = (() => {
  // px/sec drift per depth layer, far → near (old single layer was 8; old bands 3/8/15).
  const NEB_SPD = 1.2, DUST_SPD = 3, MID_SPD = 8, NEAR_SPD = 15;
  const DIM_MID = 0.8, DIM_NEAR = 1.0;               // per-band brightness scale (matches old Slice-4 feel)
  const SEED = 0x57A2BE7;                            // fixed: the sky is a place, not a dice roll

  let nebCv = null, dustCv = null, sizeKey = '';     // pre-rendered layers + the w×h key that built them
  let pendKey = '', pendAt = 0;                      // resize settling: a seam-drag streams sizes — rebuild ONCE when stable, not per tick
  let mid = [], near = [];                           // live twinkle bands
  let meteor = null, nextMeteorAt = 0;               // the rare silent shooting star (one at a time, runtime-only)

  /* reduced-motion: never ADD dramatic motion (the meteor) when the OS asks for less; the gentle
     twinkle/scroll predates this module and stays. Live-read, same idiom as world.js. */
  const _rmq = (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduceMotion = () => !!(_rmq && _rmq.matches);

  // star tints: mostly pale blue-white, some warm white, rare violet/teal — weights cumulative
  const TINTS = [
    [0.45, 'rgba(180,200,230,'], [0.72, 'rgba(205,218,242,'], [0.87, 'rgba(255,226,188,'],
    [0.95, 'rgba(196,168,255,'], [1.01, 'rgba(150,235,222,'],
  ];
  const pickTint = r => { for (const t of TINTS) if (r < t[0]) return t[1]; return TINTS[0][1]; };

  // nebula hue families [r,g,b] — the station's phosphor palette pushed into the void
  const NEB_HUES = [[150, 90, 255], [255, 90, 190], [90, 200, 255], [90, 255, 200]];

  function mulberry32(seed) {
    let a = seed | 0;
    return () => {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* stamp one soft radial puff, wrapped horizontally (x-w / x / x+w) so the scrolled tile is seamless */
  function puff(c, w, x, y, r, rgb, a) {
    for (const xo of [x - w, x, x + w]) {
      if (xo + r < 0 || xo - r > w) continue;
      const g = c.createRadialGradient(xo, y, 0, xo, y, r);
      g.addColorStop(0, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)');
      c.fillStyle = g;
      c.fillRect(xo - r, y - r, r * 2, r * 2);
    }
  }

  function rebuild(w, h) {
    sizeKey = w + 'x' + h;
    const rnd = mulberry32(SEED);
    const area = w * h;
    const u = Math.max(1, Math.round((typeof window !== 'undefined' && window.devicePixelRatio) || 1)); // star pixel unit — keeps grain consistent across dpr

    /* ---- layer 1: NEBULAS (farthest) ---- */
    nebCv = document.createElement('canvas'); nebCv.width = w; nebCv.height = h;
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
    /* THE GALAXY — one distant spiral: disk haze + two log-spiral arms + a warm core. Placed
       clear of the tile edges so it never straddles the wrap seam (no triple-stamp needed). */
    const gx = w * (0.22 + 0.56 * rnd()), gy = h * (0.14 + 0.5 * rnd());
    const Rg = (0.11 + 0.06 * rnd()) * Math.min(w, h);
    nc.save(); nc.translate(gx, gy); nc.rotate(rnd() * Math.PI); nc.scale(1, 0.34);   // tilt + flatten → everything below draws as an inclined disk
    const dg = nc.createRadialGradient(0, 0, 0, 0, 0, Rg);
    dg.addColorStop(0, 'rgba(210,190,255,0.10)'); dg.addColorStop(0.55, 'rgba(150,120,255,0.05)'); dg.addColorStop(1, 'rgba(150,120,255,0)');
    nc.fillStyle = dg; nc.fillRect(-Rg, -Rg, Rg * 2, Rg * 2);
    for (let arm = 0; arm < 2; arm++) for (let i = 0; i < 26; i++) {
      const phi = (i / 26) * 2.4 * Math.PI, r = Rg * 0.16 * Math.exp(0.24 * phi);
      const ax = r * Math.cos(phi + arm * Math.PI), ay = r * Math.sin(phi + arm * Math.PI);
      const ag = nc.createRadialGradient(ax, ay, 0, ax, ay, Rg * 0.14);
      ag.addColorStop(0, 'rgba(190,170,255,' + (0.055 * (1 - i / 26) + 0.02).toFixed(3) + ')'); ag.addColorStop(1, 'rgba(190,170,255,0)');
      nc.fillStyle = ag; nc.fillRect(ax - Rg * 0.14, ay - Rg * 0.14, Rg * 0.28, Rg * 0.28);
      if (i % 2) { nc.fillStyle = 'rgba(230,220,255,' + (0.35 * (1 - i / 26)).toFixed(3) + ')'; nc.fillRect(ax + (rnd() - 0.5) * Rg * 0.1, ay + (rnd() - 0.5) * Rg * 0.1, 1.5, 1.5); }   // arm speckle stars
    }
    const cg = nc.createRadialGradient(0, 0, 0, 0, 0, Rg * 0.22);
    cg.addColorStop(0, 'rgba(255,240,220,0.35)'); cg.addColorStop(0.4, 'rgba(255,220,190,0.12)'); cg.addColorStop(1, 'rgba(255,220,190,0)');
    nc.fillStyle = cg; nc.fillRect(-Rg * 0.22, -Rg * 0.22, Rg * 0.44, Rg * 0.44);
    nc.restore();

    /* ---- layer 2: DUST (dense static far field) ---- */
    dustCv = document.createElement('canvas'); dustCv.width = w; dustCv.height = h;
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
    /* THE PLANET — one small ringed world, drawn AFTER the dust so stars sit behind it. It rides
       the dust layer, so it parallaxes apart from the galaxy. Ring order: full ring → body over it
       (hides the far half) → front arc re-stroked. Placed clear of the tile edges (no wrap clip). */
    const pR = h * (0.030 + 0.018 * rnd());
    const px0 = w * (0.15 + 0.7 * rnd()), py0 = h * (0.12 + 0.6 * rnd());
    const ringTilt = -0.35, ringFlat = 0.32;
    dc.save(); dc.translate(px0, py0); dc.rotate(ringTilt); dc.scale(1, ringFlat);
    dc.strokeStyle = 'rgba(180,190,210,0.28)'; dc.lineWidth = Math.max(1, pR * 0.10);
    dc.beginPath(); dc.arc(0, 0, pR * 1.75, 0, Math.PI * 2); dc.stroke();
    dc.strokeStyle = 'rgba(180,190,210,0.13)'; dc.lineWidth = Math.max(1, pR * 0.22);
    dc.beginPath(); dc.arc(0, 0, pR * 1.45, 0, Math.PI * 2); dc.stroke();
    dc.restore();
    const bg = dc.createRadialGradient(px0 - pR * 0.45, py0 - pR * 0.45, pR * 0.1, px0, py0, pR);
    bg.addColorStop(0, 'rgba(120,150,180,0.60)');   // muted slate-blue day side
    bg.addColorStop(0.6, 'rgba(70,90,120,0.50)');
    bg.addColorStop(1, 'rgba(14,18,28,0.95)');      // night limb
    dc.beginPath(); dc.arc(px0, py0, pR, 0, Math.PI * 2); dc.fillStyle = bg; dc.fill();
    dc.save(); dc.translate(px0, py0); dc.rotate(ringTilt); dc.scale(1, ringFlat);   // the near half of the ring passes in FRONT of the disk
    dc.strokeStyle = 'rgba(180,190,210,0.28)'; dc.lineWidth = Math.max(1, pR * 0.10);
    dc.beginPath(); dc.arc(0, 0, pR * 1.75, 0, Math.PI); dc.stroke();
    dc.restore();

    /* ---- layers 3+4: the live twinkle bands (area-scaled, capped for per-frame cost) ---- */
    mid = []; near = [];
    const midN = Math.min(340, Math.round(area / 11000)), nearN = Math.min(190, Math.round(area / 24000));
    for (let i = 0; i < midN; i++) mid.push({ x: rnd(), y: rnd(), r: rnd() < 0.85 ? u : u * 2, ph: rnd() * 10, c: pickTint(rnd()) });
    for (let i = 0; i < nearN; i++) near.push({ x: rnd(), y: rnd(), r: rnd() < 0.6 ? u : u * 2, ph: rnd() * 10, c: pickTint(rnd()), glint: rnd() < 0.08 });
  }

  /* the whole backdrop, base fill included — callers do NOT pre-fill (identity transform, device px) */
  function draw(ctx, w, h, now) {
    ctx.fillStyle = '#040302'; ctx.fillRect(0, 0, w, h);
    if (!w || !h) return;
    const key = w + 'x' + h;
    if (sizeKey !== key) {
      // a seam-drag streams ResizeObserver sizes — rebuilding the tiles per tick (8k specks +
      // gradients) would jank the drag. Draw the OLD tiles stretched until the size holds ~250ms.
      if (!nebCv) rebuild(w, h);
      else if (pendKey !== key) { pendKey = key; pendAt = now; }
      else if (now - pendAt > 250) rebuild(w, h);
    } else pendKey = '';

    const nx = (now / 1000 * NEB_SPD) % w;           // two-copy wrap scroll, same idiom per layer
    ctx.globalAlpha = 0.9 + 0.1 * Math.sin(now / 7000);   // the gas breathes, slowly
    ctx.drawImage(nebCv, nx - w, 0, w, h); ctx.drawImage(nebCv, nx, 0, w, h);
    const dx = (now / 1000 * DUST_SPD) % w;
    ctx.globalAlpha = 0.92 + 0.08 * Math.sin(now / 4100);
    ctx.drawImage(dustCv, dx - w, 0, w, h); ctx.drawImage(dustCv, dx, 0, w, h);
    ctx.globalAlpha = 1;

    for (const s of mid) {
      const tw = (0.35 + 0.65 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph))) * DIM_MID;
      ctx.fillStyle = s.c + tw.toFixed(3) + ')';
      ctx.fillRect((s.x * w + now / 1000 * MID_SPD) % w, s.y * h, s.r, s.r);
    }
    for (const s of near) {
      const tw = (0.35 + 0.65 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph))) * DIM_NEAR;
      const x = (s.x * w + now / 1000 * NEAR_SPD) % w, y = s.y * h;
      ctx.fillStyle = s.c + tw.toFixed(3) + ')';
      ctx.fillRect(x, y, s.r, s.r);
      if (s.glint && tw > 0.55) {                    // the brightest few flare into a 4-point glint at twinkle peak
        ctx.fillStyle = s.c + (tw * 0.30).toFixed(3) + ')';
        ctx.fillRect(x - s.r * 2, y + (s.r >> 1), s.r * 5, 1);
        ctx.fillRect(x + (s.r >> 1), y - s.r * 2, 1, s.r * 5);
      }
    }

    drawMeteor(ctx, w, h, now);
  }

  /* THE METEOR — a rare, silent shooting star (one live at a time, ~1-2 per minute). Spawn params
     are runtime Math.random on purpose: the SKY is a stable seeded place, a meteor is weather.
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

  return { draw };
})();
