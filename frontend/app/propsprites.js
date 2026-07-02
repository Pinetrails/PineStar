/* STARNET — propsprites.js : the canonical PROP (furniture) art + catalog.

   v7's sprites.js drew ~85 furniture pieces as detailed PROCEDURAL pixel art — outlined
   casings, 2–3 tone shading, contact shadows, and animated emissive bits (a TV cycling
   channels, console LEDs blinking, screens that light when worked). Tiles are 12px in both
   v7 and gen, so the art ports 1:1 with no rescaling.

   This module is the single source of truth for props:
     - CATALOG  — every placeable prop: id, label, category, default tile footprint, flags
                  (animated, blocks-walk). Drives the builder palette AND the model defaults.
     - F{}      — the procedural draw functions, ported verbatim from v7 (id ↔ F key).
     - draw(f, work) — blit one prop. f = {t, x, y, w, h} in LOCAL tile coords (the bake frame),
                  exactly like world.js's existing F_desk pass. Call setCtx()/setNow() per frame.

   Props ANIMATE, so they are drawn per-frame OVER the static StationBake base and UNDER the
   lightmap (so they're lit) — never baked. Depends only on the global `U` (util.js) + a 2D ctx.
   Headless-safe: requiring the module does nothing until setCtx() is called. */
'use strict';

const PropSprites = (() => {
  const TILE = 12;
  let ctx = null, now = 0;

  /* ---- core primitives (verbatim from v7 sprites.js) ---- */
  const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  const blink = (period, phase) => ((now / period + (phase || 0)) % 1) < 0.5;
  const flick = (period, phase) => Math.sin(now / period + (phase || 0) * 7);
  const scrCols = ['#62ff9e', '#3fd07c', '#7adfb0', '#2fa863'];
  const scr = (ph) => scrCols[Math.floor((now / 700 + ph) % scrCols.length)];

  /* ---- furniture micro-helpers (verbatim from v7 sprites.js FURNITURE block) ---- */
  const sh = (x, y, w) => { ctx.globalAlpha = 0.22; px(x, y, w, 2, '#000'); ctx.globalAlpha = 1; };
  const glow = (x, y, w, h, c, a) => { ctx.globalAlpha = a; px(x, y, w, h, c); ctx.globalAlpha = 1; };
  const box = (x, y, w, h, c) => {              // outlined, shaded casing
    px(x - 1, y - 1, w + 2, h + 2, '#06090c');
    px(x, y, w, h, c);
    px(x, y, w, 1, U.shade(c, 0.28));
    px(x, y + h - 1, w, 1, U.shade(c, -0.4));
    px(x + w - 1, y + 1, 1, h - 2, U.shade(c, -0.22));
    px(x, y + 1, 1, h - 2, U.shade(c, 0.08));
  };
  const inset = (x, y, w, h, c) => {            // recessed panel / screen
    px(x, y, w, h, U.shade(c, -0.6));
    px(x + 1, y + 1, w - 2, h - 2, c);
    px(x + 1, y + 1, w - 2, 1, U.shade(c, -0.3));
  };
  const bevel = (x, y, w, h, c) => {            // box + inner 3-tone face
    box(x, y, w, h, c);
    px(x + 1, y + 1, w - 2, h - 2, U.shade(c, 0.10));
    px(x + 1, y + 1, w - 2, 1, U.shade(c, 0.30));
    px(x + 1, y + 2, 1, h - 4, U.shade(c, 0.18));
    px(x + w - 2, y + 2, 1, h - 4, U.shade(c, -0.18));
    px(x + 1, y + h - 2, w - 2, 1, U.shade(c, -0.32));
  };
  const seamH = (x, y, w, c) => {               // recessed panel seam (shadow+catch)
    px(x, y, w, 1, U.shade(c, -0.45));
    px(x, y + 1, w, 1, U.shade(c, 0.14));
  };
  const rivets = (x, y, w, h, lc, dc) => {      // 4 corner rivets, lit top / dark base
    px(x, y, 1, 1, lc); px(x + w - 1, y, 1, 1, lc);
    px(x, y + h - 1, 1, 1, dc); px(x + w - 1, y + h - 1, 1, 1, dc);
  };
  const wear = (x, y, w, h, n, c) => {          // deterministic scuff/grime speckle
    if (w < 4 || h < 4) return;
    for (let i = 0; i < n; i++) {
      const hx = U.hash('w' + x + ',' + y + ',' + i);
      px(x + 1 + (hx % (w - 2)), y + 1 + ((hx >> 5) % (h - 2)), 1 + (hx % 2), 1, c);
    }
  };
  const scanl = (x, y, w, h, a) => {            // CRT scanlines over a lit screen
    ctx.globalAlpha = a;
    for (let j = 1; j < h; j += 2) px(x, y + j, w, 1, '#000');
    ctx.globalAlpha = 1;
  };

  /* ============ v2 OBLIQUE KIT ============
     One projection law for every prop, matching the station bake (walls = lit TOP band +
     a south-facing FACE): a prop's footprint bottom edge IS its floor contact line; the
     body is drawn as a foreshortened TOP surface + a vertical FRONT face + legs/base that
     touch the floor, under one light (high + slightly west, like the walls). Bodies use
     the shared ramps below; color identity lives in ACCENTS + emissives, not casings. */
  const LINE = '#06090c';                        // universal silhouette outline
  const RAMP = {
    steel: { top: '#4a5862', face: '#39454d', lit: '#5f6f7a', sheen: '#7a8b95', dk: '#242e35', ao: '#12181d' },
    gun:   { top: '#3c4a44', face: '#2e3a36', lit: '#4e5e56', sheen: '#68796f', dk: '#1d2723', ao: '#0f1512' },
    fabric:{ top: '#46565f', face: '#39464e', lit: '#5a6b75', sheen: '#70828c', dk: '#28323a', ao: '#141b20' },
  };
  const ACC = { work: '#41ff8a', data: '#4ad9ff', flow: '#ffd34a', lounge: '#ff6ad5', mem: '#b44aff', alert: '#ff4a3d' };
  const shadow2 = (x, y, w) => {                 // soft 2-step contact shadow ON the floor line y
    ctx.globalAlpha = 0.13; px(x - 1, y - 1, w + 2, 3, '#000');
    ctx.globalAlpha = 0.24; px(x + 1, y, w - 2, 2, '#000');
    ctx.globalAlpha = 1;
  };
  const topFace = (x, y, w, d, r) => {           // foreshortened top surface, back edge catches light
    px(x - 1, y - 1, w + 2, d + 1, LINE);
    px(x, y, w, d, r.top);
    px(x, y, w, 1, r.sheen);
    px(x, y + 1, 5, 1, U.shade(r.sheen, 0.12));  // west-biased sheen streak
    px(x, y + 1, 1, d - 1, r.lit);
    px(x + w - 1, y + 1, 1, d - 1, r.dk);
    px(x, y + d - 1, w, 1, U.shade(r.top, -0.16)); // front lip of the top
  };
  const frontFace = (x, y, w, fh, r) => {        // vertical south face under a top surface
    px(x - 1, y, w + 2, fh + 1, LINE);
    px(x, y, w, fh, r.face);
    px(x, y, w, 1, r.lit);                       // catch under the lip
    px(x, y + 1, 1, fh - 1, U.shade(r.face, 0.08));
    px(x + w - 1, y + 1, 1, fh - 1, r.dk);
    px(x, y + fh - 1, w, 1, r.ao);               // floor-line ambient occlusion
  };
  const leg = (x, y, lh, r) => {                 // one 2px leg: lit west column, dark east, foot pad
    px(x - 1, y, 4, lh, LINE);
    px(x, y, 1, lh, r.lit); px(x + 1, y, 1, lh, r.dk);
    px(x, y + lh - 1, 2, 1, r.ao);
    ctx.globalAlpha = 0.30; px(x - 1, y + lh, 4, 1, '#000'); ctx.globalAlpha = 1;
  };
  const underAO = (x, y, w, h2) => {             // shade the open gap under furniture
    ctx.globalAlpha = 0.20; px(x, y, w, h2, '#000'); ctx.globalAlpha = 1;
  };
  /* Andrew's locked style law (2026-07-01): projection MIX — low furniture is TOP-BIAS OBLIQUE
     (big visible top, short face, ~10px rise: Pokemon/Zelda), naturally tall props are TALL 3/4
     (full height, may briefly occlude an agent: y-sort handles it). SYSTEMS props read as
     machinery BOLTED to the deck (baseplate + floor cable socket); decor/lounge is freestanding.
     Silhouettes are BOLD — rounded/oval/trapezoid/chamfered, never plain boxes. */
  const rr = (x, y, w, h, c) => {                // rounded rect: 1px corner cuts kill the boxiness
    px(x + 1, y, w - 2, 1, c); px(x, y + 1, w, h - 2, c); px(x + 1, y + h - 1, w - 2, 1, c);
  };
  const deckPlate = (x, y, w, h2) => {           // bolted-to-deck mounting plate under a SYSTEMS prop
    rr(x, y, w, h2, '#10161a');
    px(x + 1, y, w - 2, 1, '#232d33');           // lit rim
    px(x + 1, y + 1, 1, 1, '#39454d'); px(x + w - 2, y + 1, 1, 1, '#39454d'); // deck bolts
    px(x + 1, y + h2 - 1, 3, 1, '#8a7434'); px(x + w - 4, y + h2 - 1, 3, 1, '#8a7434'); // hazard ticks
  };
  const deckSocket = (x, y, live) => {           // floor conduit socket a machine's cable runs into
    px(x, y, 2, 1, '#0e1418');                   // conduit
    px(x + 2, y - 1, 2, 2, '#1a232a');           // socket box
    px(x + 3, y, 1, 1, live ? ACC.work : '#16302a');
  };

  /* ============ FURNITURE (ported verbatim from v7 sprites.js) ============ */
  const F = {};

  F.bigscreen = (x, y, w, h, f) => {
    // wall-mount lugs + heavy bezel
    px(x + 8, y, 4, 2, '#1a261f'); px(x + w - 12, y, 4, 2, '#1a261f');
    px(x + 9, y, 2, 1, '#2c3a32'); px(x + w - 11, y, 2, 1, '#2c3a32');
    box(x, y + 1, w, h - 1, '#13211a');
    px(x + 1, y + 2, w - 2, 1, '#2c3e34');                      // bezel sheen
    rivets(x + 1, y + 2, w - 2, h - 4, '#46584e', '#0c1410');
    inset(x + 2, y + 2, w - 4, h - 5, '#0e2418');
    // phosphor backdrop: faint graticule + baseline
    for (let gx = 6; gx < w - 10; gx += 8) px(x + 3 + gx, y + 3, 1, h - 7, '#123020');
    px(x + 4, y + h / 2 - 1, w - 8, 1, '#153a26');
    glow(x + 3, y + 3, w - 6, 1, '#9adcb0', 0.10);
    glow(x + 3, y + 3, 14, h - 7, '#bfffd9', 0.05);
    // twin waveforms: dim echo behind the live red trace
    ctx.strokeStyle = '#5c241e'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < w - 8; i++) {
      const yy = y + h / 2 - 1 + Math.sin(now / 260 + i * 0.35 + 1.3) * 2.2;
      i ? ctx.lineTo(x + 4 + i, yy) : ctx.moveTo(x + 4 + i, yy);
    }
    ctx.stroke();
    ctx.strokeStyle = '#ff4a3d'; ctx.beginPath();
    for (let i = 0; i < w - 8; i++) {
      const yy = y + h / 2 - 1 + Math.sin(now / 260 + i * 0.35) * 2.4;
      i ? ctx.lineTo(x + 4 + i, yy) : ctx.moveTo(x + 4 + i, yy);
    }
    ctx.stroke();
    // hot pixel riding the live trace
    const hp = Math.floor((now / 30) % (w - 9));
    px(x + 4 + hp, y + h / 2 - 1 + Math.round(Math.sin(now / 260 + hp * 0.35) * 2.4), 1, 1, '#ffd0c8');
    scanl(x + 3, y + 3, w - 6, h - 7, 0.10);
    glow(x + 3 + ((now / 40) % (w - 10)), y + 3, 4, h - 7, '#dfffe8', 0.06); // drifting scan band
    for (let i = 0; i < 4; i++) px(x + 4 + i * 8, y + h - 2, 4, 1, blink(900, i) ? '#ffd34a' : '#2c3a32');
    for (let i = 0; i < 7; i++) px(x + w - 26 + i * 3, y + h - 2, 2, 1, '#0c1410'); // vent slits
    glow(x + 2, y + 2, w - 4, h - 5, '#ff4a3d', 0.04 + 0.02 * Math.sin(now / 800)); // emissive spill
  };

  F.consoleL = (x, y, w, h, f) => {   // long ops console (3x1) — TOP-BIAS OBLIQUE trapezoid, bolted to deck
    const r = RAMP.gun, ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, f && f.work);            // socket east
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    for (const lx of [x + 2, x + Math.floor(w / 2) - 1, x + w - 5]) { // three legs (long span)
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // trapezoid front face, wider south, chamfered
    rr(x - 2, y + 5, w + 4, 5, LINE);
    px(x - 1, y + 6, w + 2, 3, r.face);
    px(x - 1, y + 6, w + 2, 1, r.lit);
    px(x - 1, y + 8, w + 2, 1, r.ao);
    for (let i = 0; i < 5; i++) px(x + 4 + i * (w >> 3), y + 7, 2, 1, r.dk); // front vents
    // rear cable stubs poking above the back edge (kept from old)
    px(x + 4, y - 4, 2, 1, '#141a16'); px(x + w - 6, y - 4, 2, 1, '#141a16');
    // the long top surface dominates
    rr(x - 1, y - 4, w + 2, 11, LINE);
    rr(x, y - 3, w, 9, r.top);
    px(x + 1, y - 3, w - 2, 1, r.sheen);
    px(x, y - 2, 1, 7, r.lit); px(x + w - 1, y - 2, 1, 7, r.dk);
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.16));
    wear(x + 1, y - 2, w - 2, 6, 4, U.shade(r.top, -0.10));
    // a bank of recessed terminal cells across the top, each scrolling code
    const cells = Math.floor((w - 6) / 8);
    for (let i = 0; i < cells; i++) {
      const cx = x + 2 + i * 8;
      inset(cx, y - 2, 6, 5, '#0b1511');
      px(cx + 1, y - 1, 4, 2, scr(i + ph));                    // screen fill
      if (blink(160, i * 1.7)) px(cx + 1, y - 1, 4, 1, U.shade(scr(i + ph), 0.35)); // scanline sweep
      px(cx + 1, y - 1, 1, 1, '#eafff2');                      // phosphor hot pixel
      px(cx + 1, y + 2, 2, 1, blink(700, i * 0.4) ? '#ff9d2e' : '#33241a'); // amber blink row
      px(cx + 4, y + 2, 1, 1, '#141c17');                      // toggle switch
      if (f && f.work) glow(cx, y - 2, 6, 4, ACC.work, 0.10);
    }
    // amber status ribbon on the near lip
    px(x + 4, y + 4, w - 8, 1, blink(800) ? U.shade(ACC.flow, -0.1) : U.shade(ACC.flow, -0.55));
    px(x + 4, y + 4, 6, 1, blink(800) ? ACC.flow : U.shade(ACC.flow, -0.4));
  };

  F.holotable = (x, y, w, h, f) => {
    sh(x + 2, y + h - 1, w - 4);
    box(x + 1, y + 2, w - 2, h - 3, '#1b2a33');
    px(x + 2, y + 3, w - 4, 1, '#2c4250');                      // rim sheen
    px(x + 2, y + 3, 1, h - 5, '#24394a'); px(x + w - 3, y + 3, 1, h - 5, '#101c24'); // side facets
    inset(x + 3, y + 4, w - 6, h - 7, '#0c1a22');
    // corner emitter studs
    for (const [ex, ey] of [[x + 3, y + 4], [x + w - 5, y + 4], [x + 3, y + h - 5], [x + w - 5, y + h - 5]])
      px(ex, ey, 2, 1, blink(600, ex + ey) ? '#9aeaff' : '#1d4a5a');
    const rim = 0.35 + 0.2 * Math.sin(now / 600);
    glow(x + 3, y + 4, w - 6, 1, '#4ad9ff', rim); glow(x + 3, y + h - 4, w - 6, 1, '#4ad9ff', rim);
    glow(x + 3, y + 5, 1, h - 9, '#4ad9ff', rim); glow(x + w - 4, y + 5, 1, h - 9, '#4ad9ff', rim);
    // projection well: dot grid + faint cross axes
    for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++) px(x + 6 + i * 8, y + h / 2 - 3 + j * 6, 1, 1, '#1d4a5a');
    px(x + 5, y + h / 2, w - 10, 1, '#13313e'); px(x + w / 2 - 1, y + 6, 1, h - 11, '#13313e');
    // hologram of the station + orbiting blip + orbit ring
    const g = 0.45 + 0.25 * Math.sin(now / 400);
    ctx.globalAlpha = g;
    px(x + w / 2 - 7, y + h / 2 - 1, 14, 2, '#4ad9ff');
    px(x + w / 2 - 1, y + h / 2 - 5, 2, 10, '#4ad9ff');
    px(x + w / 2 - 4, y + h / 2 - 4, 8, 1, '#9aeaff');
    px(x + w / 2 - 8, y + h / 2 - 1, 1, 1, '#9aeaff'); px(x + w / 2 + 7, y + h / 2 - 1, 1, 1, '#9aeaff'); // wing tips
    ctx.globalAlpha = g * 0.4;
    ctx.strokeStyle = '#4ad9ff'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, 9.5, 4.5, 0, 0, 7); ctx.stroke();
    ctx.globalAlpha = 1;
    const oa = now / 700;
    px(x + w / 2 - 1 + Math.round(Math.cos(oa) * 9), y + h / 2 + Math.round(Math.sin(oa) * 4), 1, 1, '#dffaff');
    glow(x + w / 2 - 8, y + h / 2 - 5, 16, 10, '#4ad9ff', 0.05 + 0.03 * Math.sin(now / 400)); // volume haze
    // control strip on the near rim
    px(x + 5, y + h - 3, 8, 1, '#0e1a20');
    for (let i = 0; i < 3; i++) px(x + 6 + i * 3, y + h - 3, 1, 1, blink(500, i) ? '#4ad9ff' : '#1d4a5a');
  };

  F.screens = (x, y, w, h) => {
    box(x, y + 2, w, h - 2, '#1a2a26');
    px(x + 1, y + 3, w - 2, 1, '#2c4038');                      // bezel sheen
    for (let i = 0; i < w / 8; i++) {
      inset(x + 1 + i * 8, y + 3, 7, 6, '#0c1f16');
      const dead = (U.hash('scr' + x + i) % 7) === 0;           // one unit runs diagnostics
      if (dead) {
        for (let k = 0; k < 5; k++)
          px(x + 2 + i * 8 + (U.hash('st' + i + k + Math.floor(now / 150)) % 5), y + 4 + (U.hash('su' + i + k + Math.floor(now / 150)) % 4), 1, 1, '#3a5a50');
      } else {
        px(x + 2 + i * 8, y + 4 + Math.floor((now / 300 + i) % 3), 5, 1, '#4ad9ff');
        px(x + 2 + i * 8, y + 4 + Math.floor((now / 300 + i) % 3), 2, 1, '#bfeeff'); // bright lead
        px(x + 2 + i * 8, y + 7, 3, 1, '#16424e');              // dim history row
        if (blink(1700, i * 2.3)) glow(x + 2 + i * 8, y + 4, 5, 4, '#4ad9ff', 0.15);
      }
      px(x + 6 + i * 8, y + 8, 1, 1, blink(900, i) ? '#2ee6c8' : '#143028'); // unit LED
    }
    seamH(x + 1, y + h - 2, w - 2, '#1a2a26');
    rivets(x + 1, y + 3, w - 2, h - 4, '#3a5048', '#0c1612');
  };

  F.tank = (x, y, w, h) => {
    sh(x + 1, y + h + 3, w - 2);
    box(x, y + 1, w, h + 3, '#1e3434');
    px(x + 1, y + 1, w - 2, 1, '#3e6a62');                      // cap sheen
    for (let i = 0; i < 3; i++) px(x + 3 + i * ((w - 7) >> 1), y + 1, 1, 1, '#5a8a80'); // cap bolts
    inset(x + 1, y + 2, w - 2, h + 1, '#0f3a3a');
    // murky depth gradient
    px(x + 2, y + h - 1, w - 4, 3, '#0b2c2c'); px(x + 2, y + h + 1, w - 4, 1, '#082222');
    px(x + 2, y + 3, w - 4, 1, '#2a6a62'); // liquid surface
    glow(x + 2, y + 3, w - 4, 1, '#7adfd0', 0.4 + 0.2 * Math.sin(now / 500));
    glow(x + 3, y + 4, 2, h - 2, '#bffff2', 0.18); // glass highlight
    glow(x + w - 5, y + 5, 1, h - 4, '#bffff2', 0.08); // second faint streak
    // suspended specimen, bobbing slowly
    const bob = Math.round(Math.sin(now / 1100) * 1.5);
    px(x + w / 2 - 2, y + 6 + bob, 4, 3, '#16504a'); px(x + w / 2 - 1, y + 5 + bob, 2, 1, '#16504a');
    px(x + w / 2 - 2, y + 6 + bob, 1, 1, '#2a7a6e'); // rim light on specimen
    for (let i = 0; i < 3; i++) {
      const ph = (now / (700 + i * 160) + i * 0.7) % 1;
      px(x + 4 + i * 6, y + 3 + Math.floor((1 - ph) * (h - 2)), 1, 1, '#7adfd0');
      px(x + 5 + i * 6, y + 3 + Math.floor((1 - ((ph + 0.4) % 1)) * (h - 2)), 1, 1, '#3a8a80'); // dim bubble
    }
    px(x, y + 1, w, 1, '#3e6a62'); px(x, y + h + 3, w, 1, '#16302a');
    px(x + 1, y + h + 2, w - 2, 1, '#143028');                  // base band
    px(x + 2, y + h + 2, 2, 1, blink(1000) ? '#2ee6c8' : '#143028'); // pump LED
  };

  F.whiteboard = (x, y, w, h) => {   // v2 freestanding: rolling frame — posts + casters carry the board
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, w - 4);
    // rolling posts on splayed T-feet with caster wheels
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx - 1, y + 6, 4, h - 8, LINE);
      px(pxx, y + 7, 1, h - 9, r.lit); px(pxx + 1, y + 7, 1, h - 9, r.dk);
      rr(pxx - 3, y + h - 3, 8, 2, LINE);                       // splayed T-foot
      px(pxx - 2, y + h - 3, 6, 1, r.face);
      px(pxx - 2, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 2, y + h - 1, 2, 1, '#1a1e22'); // caster wheels
      ctx.globalAlpha = 0.30; px(pxx - 3, y + h, 8, 1, '#000'); ctx.globalAlpha = 1;
    }
    // board panel riding the posts: rounded steel frame, white sheet
    rr(x, y - 6, w, 13, LINE);
    rr(x + 1, y - 5, w - 2, 11, r.face);
    px(x + 1, y - 5, w - 2, 1, r.lit);                          // frame top catch
    px(x + 2, y - 5, 1, 1, '#56645c'); px(x + w - 3, y - 5, 1, 1, '#56645c'); // frame screws
    px(x + 2, y - 4, w - 4, 9, '#cfe6d4');
    px(x + 2, y - 4, w - 4, 1, '#e8f6ea');
    px(x + 2, y + 4, w - 4, 1, '#b2c8b8');                      // lower sheet shade
    px(x + w - 24, y - 2, 6, 3, '#c2dcc8');                     // old eraser smudge
    px(x + 4, y - 3, w - 22, 1, '#e05050'); px(x + 4, y - 1, w - 18, 1, '#3a6aa0'); px(x + 4, y + 1, w - 24, 1, '#3a6aa0');
    px(x + 4, y + 3, 8, 1, '#e05050');
    px(x + 14, y + 3, 4, 1, '#3a6aa0'); px(x + 20, y + 3, 2, 1, '#3a6aa0'); // scrawl fragments
    // sticky notes
    px(x + w - 22, y + 1, 3, 3, '#ffe066'); px(x + w - 22, y + 1, 3, 1, '#fff0a8'); px(x + w - 21, y + 2, 2, 1, '#caa84a');
    px(x + w - 18, y + 2, 3, 3, '#8adf9a'); px(x + w - 18, y + 2, 3, 1, '#b8f0c0'); px(x + w - 17, y + 3, 1, 1, '#4a9a5a');
    // chart box with red trend line + axis ticks
    px(x + w - 13, y - 3, 9, 5, '#b8d4c0');
    px(x + w - 13, y - 3, 1, 5, '#8aa890'); px(x + w - 13, y + 1, 9, 1, '#8aa890');
    ctx.strokeStyle = '#e05050'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(x + w - 12, y + 1); ctx.lineTo(x + w - 9, y - 1); ctx.lineTo(x + w - 6, y); ctx.stroke();
    px(x + w - 6, y - 1, 1, 1, '#e05050');                      // data point
    // marker tray bolted to the frame
    px(x + 3, y + 7, w - 6, 2, LINE);
    px(x + 4, y + 7, w - 8, 1, r.face);
    px(x + 6, y + 6, 3, 1, '#e05050'); px(x + 11, y + 6, 3, 1, '#3a6aa0');
    px(x + 16, y + 6, 2, 1, '#8a98a8');                         // eraser block
  };

  F.rack = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE server rack (2x1): big top + LED-row face; bolted; ACC.work green
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);                                 // floor contact
    deckPlate(x - 1, y + h - 4, w + 2, 4);                            // bolted plate peeks at feet
    deckSocket(x + w + 1, y + h - 3, f && f.work);
    for (const lx of [x + 2, x + w - 5]) {                            // chunky corner legs
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // front face with 3 stacked rack-unit rows (short face, top-bias)
    rr(x - 1, y + 2, w + 2, h - 3, LINE);
    px(x, y + 3, w, h - 5, r.face);
    px(x, y + 3, 1, h - 5, U.shade(r.face, 0.08)); px(x + w - 1, y + 3, 1, h - 5, r.dk);
    for (let ru = 0; ru < 3; ru++) {
      const ry = y + 3 + ru * 3;
      inset(x + 2, ry, w - 4, 2, U.shade(r.face, -0.16));            // rack unit bay
      px(x + 3, ry, w - 6, 1, U.shade(r.face, 0.06));                // unit face catch
      for (let i = 0; i < (w - 12) / 4; i++)                          // LED row — ACC.work blink pattern (preserved)
        px(x + 4 + i * 4, ry, 2, 1, blink(400 + ru * 130, i + ru) ? ACC.work : U.shade(ACC.work, -0.6));
      px(x + w - 6, ry, 1, 1, blink(900, ru * 1.7) ? ACC.flow : '#2a2418'); // amber drive light
      for (let i = 0; i < 3; i++) px(x + w - 4, ry, 1, 1, '#0e1413');       // vent
    }
    px(x, y + h - 3, w, 1, r.ao);                                     // floor-line AO
    // big rounded TOP surface (dominant)
    rr(x - 1, y - 3, w + 2, 6, LINE);
    rr(x, y - 2, w, 5, r.top);
    px(x + 1, y - 2, w - 2, 1, r.sheen);
    px(x, y - 1, 1, 3, r.lit); px(x + w - 1, y - 1, 1, 3, r.dk);
    px(x + 3, y - 1, 8, 1, U.shade(r.top, 0.06));                     // brushed streak
    for (let i = 1; i < w / 8; i++) px(x + i * 8, y - 1, 1, 2, r.ao); // top vent slits
    px(x + 1, y + 2, w - 2, 1, U.shade(r.top, -0.16));               // top front edge
    wear(x + 2, y - 1, w - 4, 3, 3, U.shade(r.top, -0.10));
    if (f && f.work) glow(x, y + 3, w, h - 5, ACC.work, 0.05 + 0.03 * Math.sin(now / 500));
  };

  F.rackV = (x, y, w, h) => {
    // TALL 3/4 server rack: rises ~6px above the 1x2 footprint, every LED row/link-light blink kept.
    const r = RAMP.steel, cw = w, rise = 6, topY = y - rise;
    shadow2(x + 1, y + h - 1, cw - 2);
    // slim east-side facet (gives the tower depth) then the lit front face
    rr(x - 1, topY - 3, cw + 2, (y + h) - topY + 3, LINE);
    px(x + cw - 3, topY - 1, 2, (y + h) - topY, r.dk);          // dark east flank
    px(x + 1, topY, cw - 4, (y + h - 2) - topY, r.face);        // front chassis
    px(x + 1, topY, 1, (y + h - 2) - topY, r.lit);              // west sheen column
    px(x + 2, topY, cw - 5, 1, U.shade(r.face, 0.14));          // upper catch
    // rounded cap we look slightly down onto
    rr(x, topY - 4, cw - 2, 4, LINE);
    px(x + 1, topY - 3, cw - 4, 3, r.top);
    px(x + 1, topY - 3, cw - 4, 1, r.sheen);
    px(x + 1, topY - 3, 4, 1, U.shade(r.sheen, 0.12));         // west-biased sheen streak
    px(x + 1, topY - 1, cw - 4, 1, U.shade(r.top, -0.18));      // cap front lip
    px(x + 2, topY - 3, 1, 1, '#8693a0'); px(x + cw - 5, topY - 3, 1, 1, r.dk); // cap corner beads
    // rail posts framing the rack units
    px(x + 2, topY + 1, 1, (y + h - 3) - topY, U.shade(r.face, 0.20));
    px(x + cw - 4, topY + 1, 1, (y + h - 3) - topY, r.dk);
    // 5 rack units, each with a blade catch, blinking status LED + link light, vents
    const uh = 4, u0 = topY + 1;
    for (let rr2 = 0; rr2 < 5; rr2++) {
      const uy = u0 + rr2 * (uh + 1);
      px(x + 3, uy, cw - 8, uh, rr2 % 2 ? '#1c242c' : '#212a34'); // blade body
      px(x + 3, uy, cw - 8, 1, rr2 % 2 ? '#2a3540' : '#2e3a46');  // unit top catch
      px(x + 3, uy + uh, cw - 8, 1, '#0f151b');                   // seam shadow
      px(x + 4, uy + 1, 2, 1, blink(420 + rr2 * 110, x + rr2) ? '#7fd0ff' : '#16242e'); // status LED
      px(x + 7, uy + 1, 3, 1, '#2a3640');                         // label strip
      px(x + cw - 6, uy + 1, 1, 1, blink(700, x + rr2 * 2) ? '#41ff8a' : '#16302a'); // link light
      px(x + 4, uy + 3, cw - 10, 1, '#141b22');                   // vent slot
      px(x + 5, uy + 3, 1, 1, '#1e2832'); px(x + 8, uy + 3, 1, 1, '#1e2832'); // vent dots
    }
    // PSU strip at the base with its blinking light + floor cable
    px(x + 3, y + h - 4, cw - 8, 2, '#161d24');
    px(x + 3, y + h - 4, cw - 8, 1, U.shade(r.face, -0.10));
    px(x + 4, y + h - 3, 2, 1, blink(1300, x) ? '#ff9d2e' : '#33241a'); // psu light
    px(x + cw - 5, y + h - 3, 1, 1, blink(1600, x + 3) ? '#41ff8a' : '#16302a'); // aux light
    px(x + cw - 4, y + h - 1, 1, 1, '#11161c');                   // floor cable stub
    // freestanding feet + under-gap AO
    px(x + 1, y + h - 2, 2, 2, r.dk); px(x + cw - 5, y + h - 2, 2, 2, r.dk);
    px(x + 1, y + h - 2, 1, 1, r.lit); px(x + cw - 5, y + h - 2, 1, 1, r.lit);
    underAO(x + 3, y + h - 1, cw - 8, 1);
  };

  F.bench = (x, y, w, h, f) => {   // long work bench (4x1) — TOP-BIAS OBLIQUE, bolted to the deck
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, f && f.work);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    for (const lx of [x + 2, x + Math.floor(w / 3) - 1, x + Math.floor(2 * w / 3) - 1, x + w - 5]) { // four legs
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short apron / front lip
    rr(x - 1, y + 5, w + 2, 5, LINE);
    px(x, y + 6, w, 3, r.face);
    px(x, y + 6, w, 1, r.lit);
    px(x, y + 8, w, 1, r.ao);
    // the big rounded worktop dominates the whole 4-tile span
    rr(x - 1, y - 4, w + 2, 11, LINE);
    rr(x, y - 3, w, 9, r.top);
    px(x + 1, y - 3, w - 2, 1, r.sheen);
    px(x, y - 2, 1, 7, r.lit); px(x + w - 1, y - 2, 1, 7, r.dk);
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.16));
    px(x + 4, y - 1, 7, 1, U.shade(r.top, 0.06)); px(x + 20, y + 2, 8, 1, U.shade(r.top, 0.05)); // brushed streaks
    wear(x + 1, y - 2, w - 2, 6, 6, U.shade(r.top, -0.10));
    // rotating bench-top clutter, spread along the surface (kept: flasks/reagents/papers)
    const slots = Math.floor((w - 4) / 10);
    for (let i = 0; i < slots; i++) {
      const bx = x + 4 + i * 10;
      if (i % 3 === 0) {                                       // flask of culture fluid with vapor blink
        px(bx - 1, y + 2, 5, 1, '#222c26');                   // heat pad
        px(bx, y - 1, 3, 3, '#7adfd0'); px(bx + 1, y - 2, 1, 1, '#9aeae0'); px(bx, y + 1, 3, 1, '#4aa89c');
        px(bx, y - 1, 1, 2, '#bffff2');                       // glass shine
        if (blink(800, i)) px(bx + 1, y - 3, 1, 1, '#9aeae0'); // vapor wisp
      } else if (i % 3 === 1) {                                // reagent bottle with label
        px(bx + 1, y - 2, 2, 4, '#caa86a'); px(bx + 1, y - 2, 1, 4, '#e0c084'); px(bx + 1, y - 3, 2, 1, '#6a5836');
        px(bx + 1, y, 2, 1, '#e8e0d0');                       // label band
      } else {                                                // papers + tool glint
        px(bx, y, 4, 2, '#dfe8df'); px(bx, y, 4, 1, '#f0f6f0');
        px(bx + 1, y + 1, 2, 1, '#9aaa9a');                   // print lines
        px(bx + 1, y - 1, 4, 1, '#8a98a8'); px(bx + 4, y - 1, 1, 1, '#aab8c8'); // tool glint
      }
    }
  };

  F.desk = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE workstation, bolted to the deck (locked style law)
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);                          // floor contact
    deckPlate(x - 1, y + 8, w + 2, h - 8);                     // mounting plate peeks out under the desk
    deckSocket(x + w + 1, y + h - 3, f.work);                  // cable runs into a floor socket east
    px(x + w, y + h - 3, 1, 1, '#0e1418');                     // conduit stub off the plate
    for (const lx of [x + 2, x + w - 5]) {                     // chunky corner legs on the plate
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);                          // dark open gap under the desk
    // short front lip (the desk slab's south face)
    rr(x - 1, y + 5, w + 2, 5, LINE);
    px(x, y + 6, w, 3, r.face);
    px(x, y + 6, w, 1, r.lit);
    px(x + 16, y + 7, 3, 1, r.dk); px(x + 5, y + 7, 3, 1, r.dk); // drawer pulls
    px(x, y + 8, w, 1, r.ao);
    // the big rounded tabletop (dominates: this is a top-down game)
    rr(x - 1, y - 4, w + 2, 11, LINE);
    rr(x, y - 3, w, 9, r.top);
    px(x + 1, y - 3, w - 2, 1, r.sheen);
    px(x, y - 2, 1, 7, r.lit); px(x + w - 1, y - 2, 1, 7, r.dk);
    px(x + 3, y - 1, 6, 1, U.shade(r.top, 0.07)); px(x + 14, y + 2, 5, 1, U.shade(r.top, 0.05)); // brushed streaks
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.16));         // top's front edge
    wear(x + 1, y - 2, w - 2, 7, 3, U.shade(r.top, -0.10));
    // monitor standing on the back edge
    rr(x + 2, y - 10, 10, 8, LINE);
    rr(x + 3, y - 9, 8, 6, '#1a241e');
    px(x + 4, y - 9, 6, 1, '#2c3a30');                         // bezel catch
    px(x + 4, y - 8, 6, 4, '#0d150f');
    if (f.work) {
      px(x + 5, y - 7, 4, 2, scr(f.x));
      px(x + 5, y - 7, 2, 1, '#dfffe8');                       // top code line
      if (blink(180, f.x)) px(x + 5, y - 7, 3, 1, '#dfffe8');
      px(x + 8, y - 6, 1, 1, blink(400, f.x) ? '#dfffe8' : '#101a14'); // cursor
      scanl(x + 5, y - 7, 4, 2, 0.2);
      glow(x + 2, y - 2, 10, 3, scr(f.x), 0.18);               // screen light pools on the tabletop
      glow(x + 4, y - 8, 6, 4, scr(f.x), 0.10);                // bezel glow
    } else {
      px(x + 5, y - 7, 4, 2, '#101a14');
      px(x + 5, y - 7, 1, 1, '#1c2a22');                       // faint reflection
      px(x + 10, y - 6, 1, 1, blink(1600) ? '#ff9d2e' : '#33241a'); // standby
    }
    px(x + 7, y - 2, 3, 1, '#141c18');                         // monitor foot on the top
    rr(x + 13, y - 1, 7, 3, U.shade(r.top, -0.28));            // keyboard well
    px(x + 14, y, 5, 1, r.face); px(x + 14, y, 2, 1, r.lit);   // key glint
    px(x + 21, y, 1, 1, r.lit);                                // mouse
    px(x + w - 4, y - 2, 2, 2, '#3a6a62'); px(x + w - 4, y - 2, 2, 1, '#5aa89c'); // ceramic mug
    if (f.work && blink(700)) px(x + w - 3, y - 4, 1, 1, '#8a8a8a'); // coffee steam
    px(x + 11, y + 2, 2, 2, '#ffe066'); px(x + 11, y + 2, 2, 1, '#fff0a8'); // sticky note
  };

  F.desk2 = (x, y, w, h, f) => {   // dual-monitor battlestation — TOP-BIAS OBLIQUE, bolted to the deck
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);                          // floor contact
    deckPlate(x - 1, y + 8, w + 2, h - 8);                     // mounting plate peeks out under the slab
    deckSocket(x + w + 1, y + h - 3, f.work);                  // cable runs into a floor socket, east
    px(x + w, y + h - 3, 1, 1, '#0e1418');                     // conduit stub off the plate
    for (const lx of [x + 2, x + w - 5]) {                     // chunky corner legs standing on the plate
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);                          // dark open gap under the desk
    // short front lip (the slab's south face) with the signature purple underglow strip
    rr(x - 1, y + 5, w + 2, 5, LINE);
    px(x, y + 6, w, 3, r.face);
    px(x, y + 6, w, 1, r.lit);
    px(x + 6, y + 7, 3, 1, r.dk); px(x + w - 8, y + 7, 3, 1, r.dk); // drawer pulls
    px(x, y + 8, w, 1, r.ao);
    glow(x + 1, y + 8, w - 2, 1, ACC.mem, f.work ? 0.30 + 0.10 * Math.sin(now / 300) : 0.10); // mem underglow
    // the big rounded tabletop dominates (top-down game)
    rr(x - 1, y - 4, w + 2, 11, LINE);
    rr(x, y - 3, w, 9, r.top);
    px(x + 1, y - 3, w - 2, 1, r.sheen);
    px(x, y - 2, 1, 7, r.lit); px(x + w - 1, y - 2, 1, 7, r.dk);
    px(x + 3, y - 1, 6, 1, U.shade(r.top, 0.07)); px(x + 13, y + 2, 5, 1, U.shade(r.top, 0.05)); // brushed streaks
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.16));         // top's front edge
    wear(x + 1, y - 2, w - 2, 7, 3, U.shade(r.top, -0.10));
    // twin monitors standing on the back edge — mem-purple bezels
    for (const [mx, ph] of [[x + 1, f.x], [x + 12, f.x + 2]]) {
      rr(mx, y - 10, 10, 8, LINE);
      rr(mx + 1, y - 9, 8, 6, '#1a1626');
      px(mx + 2, y - 9, 6, 1, '#2c2440');                      // bezel catch
      px(mx + 2, y - 8, 6, 4, '#0c0a16');
      if (f.work) {
        px(mx + 3, y - 7, 4, 2, scr(ph));
        px(mx + 3, y - 7, 2, 1, '#dfffe8');                    // top code line
        if (blink(180, ph)) px(mx + 3, y - 7, 3, 1, '#dfffe8');
        px(mx + 6, y - 6, 1, 1, blink(400, ph) ? '#dfffe8' : '#0c0a16'); // cursor
        scanl(mx + 3, y - 7, 4, 2, 0.2);
        glow(mx, y - 2, 10, 3, scr(ph), 0.16);                 // screen light pools on the tabletop
        glow(mx + 2, y - 8, 6, 4, scr(ph), 0.10);              // bezel glow
      } else {
        px(mx + 3, y - 7, 4, 2, '#0e0c1a');
        px(mx + 3, y - 7, 1, 1, '#1c1830');                    // faint reflection
      }
    }
    if (!f.work) px(x + 20, y - 6, 1, 1, blink(1600, x) ? '#ff9d2e' : '#33241a'); // standby amber
    px(x + 5, y - 2, 2, 1, '#141018'); px(x + 16, y - 2, 2, 1, '#141018'); // monitor feet on the top
    rr(x + 8, y - 1, 8, 3, U.shade(r.top, -0.28));             // keyboard well between the stands
    px(x + 9, y, 5, 1, r.face); px(x + 9, y, 2, 1, r.lit);     // key glint
    px(x + 3, y + 1, 4, 2, '#2a2436'); px(x + 3, y + 1, 4, 1, '#3a3450'); // headset resting on the desk
    px(x + 3, y + 1, 1, 2, ACC.mem);                          // headset accent strip
    px(x + 18, y + 2, 2, 1, r.lit); px(x + 18, y + 2, 1, 1, r.sheen); // mouse
  };

  F.pixelrig = (x, y, w, h, f) => {   // art workstation — TOP-BIAS OBLIQUE, bolted to the deck
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, f.work);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short front lip
    rr(x - 1, y + 5, w + 2, 5, LINE);
    px(x, y + 6, w, 3, r.face);
    px(x, y + 6, w, 1, r.lit);
    px(x, y + 8, w, 1, r.ao);
    glow(x + 1, y + 8, w - 2, 1, ACC.lounge, f.work ? 0.24 + 0.08 * Math.sin(now / 320) : 0.08); // art-pink underglow
    // the rounded worktop dominates
    rr(x - 1, y - 4, w + 2, 11, LINE);
    rr(x, y - 3, w, 9, r.top);
    px(x + 1, y - 3, w - 2, 1, r.sheen);
    px(x, y - 2, 1, 7, r.lit); px(x + w - 1, y - 2, 1, 7, r.dk);
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.16));
    wear(x + 1, y - 2, w - 2, 6, 3, U.shade(r.top, -0.10));
    // canvas display standing on the back edge with corner clamps
    rr(x + 1, y - 11, w - 2, 9, LINE);
    rr(x + 2, y - 10, w - 4, 7, '#141c1a');
    px(x + 3, y - 10, w - 6, 1, '#2a4a44');                    // bezel catch
    px(x + 2, y - 10, 2, 1, '#2a4a44'); px(x + w - 4, y - 10, 2, 1, '#2a4a44'); // clamps
    inset(x + 3, y - 9, w - 6, 5, '#0a1d1b');
    // tiny pixel-art canvas being painted (kept animation)
    const cols = ['#2ee6c8', '#ff9d2e', '#ff6ad5'];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++)
      if ((i + j + Math.floor(now / 500)) % 3 === 0)
        px(x + 5 + i * 3, y - 8 + j * 2, 2, 1, cols[(i + j) % 3]);
    const cc = Math.floor(now / 500) % 5;                     // paint cursor blinking at the active cell
    if (blink(250)) px(x + 5 + cc * 3, y - 8 + (cc % 2) * 2, 2, 1, '#ffffff');
    glow(x + 3, y - 9, w - 6, 5, '#2ee6c8', f.work ? 0.12 : 0.04);
    if (!f.work) px(x + w - 5, y - 4, 1, 1, blink(1600, x) ? '#ff9d2e' : '#33241a'); // standby amber
    // swatch palette row + tablet + stylus on the worktop (kept)
    for (let i = 0; i < 4; i++) px(x + 2 + i * 2, y - 1, 1, 1, ['#2ee6c8', '#ff9d2e', '#ff6ad5', '#ffd34a'][i]);
    inset(x + 11, y - 1, 8, 4, '#1c2a28'); px(x + 13, y, 4, 2, '#0e1816'); // tablet
    if (f.work) px(x + 13 + (Math.floor(now / 300) % 3), y, 1, 1, '#2ee6c8'); // pen tracking dot
    px(x + 3, y + 2, 3, 1, '#caa86a'); px(x + 5, y + 2, 1, 1, '#e8e0d0'); // stylus lying on the top
    px(x + 3, y + 4, 2, 1, '#26403c'); // pen dock
  };

  F.coffee = (x, y, w, h) => {
    sh(x + 2, y + 10, 8);
    box(x + 2, y, 8, 10, '#36424c');
    px(x + 3, y + 1, 6, 3, '#1a2228');
    px(x + 3, y + 1, 6, 1, '#46525a');
    px(x + 3, y + 2, 1, 2, '#26323a'); // hopper shade
    const lvl = 1 + Math.floor(((now / 4000) % 1) * 2); // pot slowly fills
    px(x + 4, y + 5, 4, 4, '#141b1e'); // carafe glass
    px(x + 4, y + 6 + (3 - lvl), 4, lvl, '#2f4a46');
    px(x + 4, y + 6 + (3 - lvl), 4, 1, '#3e5e58'); // brew surface
    px(x + 4, y + 5, 1, 4, '#2a363c'); // glass shine
    px(x + 4, y + 5, 4, 1, '#8a98a8');
    px(x + 9, y + 4, 1, 1, blink(1200) ? '#41ff8a' : '#1c2a22'); // ready light
    px(x + 9, y + 6, 1, 1, '#222c32'); px(x + 9, y + 7, 1, 1, '#222c32'); // buttons
    if (blink(600)) { px(x + 5, y - 2, 1, 2, '#8a8a8a'); px(x + 7, y - 3, 1, 2, '#6a6a6a'); } // steam
    px(x + 4, y + 9, 4, 1, '#241c14'); // drip tray
    px(x + 5, y + 9, 2, 1, '#3a2c20'); // old stain
    px(x, y + 8, 2, 2, '#3a6a62'); px(x, y + 8, 2, 1, '#5aa89c'); // waiting mug
  };

  F.plant = (x, y) => {   // v2 oblique: tapered pot with a lit rim, layered fronds rising above the tile
    const r = RAMP.gun;
    shadow2(x + 2, y + 10, 8);
    // pot: oval rim (top surface) + tapered rounded body + foot
    rr(x + 2, y + 4, 8, 3, LINE);
    px(x + 3, y + 5, 6, 1, r.sheen);                            // rim catches light
    px(x + 3, y + 4, 6, 1, '#1d1812');                          // soil behind the rim
    px(x + 5, y + 4, 1, 1, '#2a2218');                          // soil clump
    rr(x + 2, y + 6, 8, 5, LINE);
    px(x + 3, y + 6, 6, 3, r.face);
    px(x + 4, y + 9, 4, 1, U.shade(r.face, -0.10));             // taper toward the base
    px(x + 3, y + 6, 1, 3, r.lit);                              // pot lit side
    px(x + 8, y + 6, 1, 3, r.dk);                               // pot shade side
    px(x + 4, y + 10, 4, 1, r.dk);                              // rounded foot
    ctx.globalAlpha = 0.30; px(x + 3, y + 11, 6, 1, '#000'); ctx.globalAlpha = 1;
    // foliage: open palm-like fronds with gaps between them, not a solid mass
    px(x + 5, y - 2, 2, 6, '#256032');                          // stalk
    px(x + 5, y - 7, 2, 5, '#2e7a3e');                          // center leaf
    px(x + 5, y - 7, 1, 2, '#5ec46e');                          // lit tip
    px(x + 3, y - 5, 2, 1, '#3a9a4e'); px(x + 2, y - 4, 2, 2, '#3a9a4e'); // west leaf arcs out...
    px(x + 1, y - 2, 2, 2, '#3a9a4e'); px(x + 1, y - 2, 1, 1, '#5ec46e'); // ...and down, tip lit
    px(x + 7, y - 5, 2, 1, '#2a6a36'); px(x + 8, y - 4, 2, 2, '#2a6a36'); // east leaf (shade side)
    px(x + 9, y - 2, 2, 2, '#2a6a36'); px(x + 10, y - 2, 1, 1, '#4aa45a');
    px(x + 3, y, 2, 2, '#256032'); px(x + 3, y + 2, 1, 2, '#256032'); // west drooper over the rim
    px(x + 8, y, 2, 2, '#1f5228'); px(x + 9, y + 2, 1, 2, '#1f5228'); // east drooper
    px(x + 5, y - 3, 1, 1, '#1f5228'); px(x + 6, y, 1, 3, '#1f5228'); // stem shadows into the pot
    px(x + 8, y + 7, 1, 2, '#56645c');                          // moisture probe
    px(x + 8, y + 7, 1, 1, blink(2000, x) ? '#2ee6c8' : '#1a3a34');
  };

  F.cans = (x, y) => { // empty energy cans
    ctx.globalAlpha = 0.18; px(x + 2, y + 10, 9, 2, '#000'); ctx.globalAlpha = 1;
    px(x + 1, y + 7, 3, 4, '#8a98a8'); px(x + 1, y + 7, 1, 4, '#aab8c8'); px(x + 1, y + 7, 3, 1, '#caa84a');
    px(x + 2, y + 9, 1, 1, '#6a7888'); // dent
    px(x + 2, y + 8, 1, 1, '#41ff8a'); // brand stripe
    px(x + 6, y + 8, 4, 3, '#8a98a8'); px(x + 6, y + 8, 4, 1, '#aab8c8'); px(x + 9, y + 9, 1, 2, '#6a7888');
    px(x + 7, y + 9, 1, 1, '#41ff8a');
    px(x + 10, y + 8, 1, 1, '#caa84a');
    px(x + 4, y + 4, 3, 3, '#7a8898'); px(x + 4, y + 4, 3, 1, '#98a8b8'); // crushed third can
    px(x + 5, y + 5, 1, 1, '#5a6878');
    px(x + 4, y + 10, 3, 1, '#3a4440'); // stale spill
    px(x + 8, y + 11, 2, 1, '#343c3a'); // ring stain
  };

  F.commswall = (x, y, w, h) => {
    box(x, y + 1, w, h + 3, '#1c2e28');
    px(x, y + 1, w, 1, '#2e463e');
    // twin conduit run with junction boxes
    px(x + 1, y + 2, w - 2, 1, '#14241f');
    for (let i = 1; i < w / 24; i++) {
      px(x + i * 24, y + 2, 3, 1, '#26403a'); px(x + i * 24, y + 2, 1, 1, '#3a5a50'); // junction
    }
    glow(x + ((now / 6) % (w - 5)), y + 2, 5, 1, '#5ad1b3', 0.7); // data pulse
    glow(x + ((now / 9 + 80) % (w - 5)), y + 2, 3, 1, '#5ad1b3', 0.35); // trailing packet
    for (let i = 0; i < w / 7 - 1; i++) {
      const on = blink(500 + (i % 5) * 90, i);
      inset(x + 1 + i * 7, y + 3, 6, 5, on ? '#0e3a2a' : '#0a1f16');
      if (on) {
        px(x + 2 + i * 7, y + 4 + (i % 2), 4, 1, '#5ad1b3');
        px(x + 2 + i * 7, y + 4 + (i % 2), 1, 1, '#b8f0e0'); // hot pixel
        px(x + 2 + i * 7, y + 6, 2, 1, '#1d5c44'); // dim echo row
      }
      px(x + 2 + i * 7, y + 9, 2, 1, blink(300, i * 0.7) ? '#ff5c5c' : '#2a1414');
      px(x + 5 + i * 7, y + 9, 1, 1, blink(1100, i * 1.3) ? '#ffd34a' : '#2a2418'); // amber aux
      px(x + 6 + i * 7, y + 9, 1, 1, '#11201a');
      if (i % 4 === 2) px(x + 1 + i * 7, y + 10, 6, 1, '#15261f'); // panel divider shade
    }
    seamH(x + 1, y + h + 1, w - 2, '#1c2e28');
    px(x + 1, y + h + 2, w - 2, 1, '#101c18');
    rivets(x + 1, y + 2, w - 2, h + 1, '#3a5a50', '#0c1612');
    wear(x, y + 1, w, h + 3, 5, '#16261f');
  };

  F.console = (x, y, w, h, f) => {   // ops console — TOP-BIAS OBLIQUE trapezoid, bolted to the deck
    const r = RAMP.gun, ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);                          // floor contact
    deckPlate(x - 1, y + 8, w + 2, h - 8);                     // mounting plate
    deckSocket(x - 3, y + h - 3, f && f.work);                 // conduit into floor socket, west
    px(x - 1, y + h - 3, 1, 1, '#0e1418');                     // conduit stub
    for (const lx of [x + 2, x + w - 5]) {                     // corner legs on the plate
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // trapezoid front face — wider toward the user (south), chamfered corners
    rr(x - 2, y + 5, w + 4, 5, LINE);
    px(x - 1, y + 6, w + 2, 3, r.face);
    px(x - 1, y + 6, w + 2, 1, r.lit);
    px(x - 1, y + 8, w + 2, 1, r.ao);
    // vents cut into the front face
    for (let i = 0; i < 3; i++) px(x + 3 + i * (w >> 2), y + 7, 2, 1, r.dk);
    // the console top dominates: rounded, tilted, brightest — the amber ops slab
    rr(x - 1, y - 4, w + 2, 11, LINE);
    rr(x, y - 3, w, 9, r.top);
    px(x + 1, y - 3, w - 2, 1, r.sheen);
    px(x, y - 2, 1, 7, r.lit); px(x + w - 1, y - 2, 1, 7, r.dk);
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.16));         // front lip of the top
    wear(x + 1, y - 2, w - 2, 6, 3, U.shade(r.top, -0.10));
    // recessed terminal screen on the top surface with scrolling text lines
    inset(x + 2, y - 2, w - 12, 6, '#0a1d12');
    px(x + 3, y - 1, w - 14, 4, scr(1 + ph));
    for (let j = 0; j < 3; j++) {                              // terminal text lines (kept behavior)
      const lw = 2 + ((j * 3 + Math.floor(now / 400)) % 5);
      px(x + 3, y - 1 + j, Math.min(lw, w - 14), 1, '#dfffe8');
    }
    scanl(x + 3, y - 1, w - 14, 4, 0.18);
    if (f && f.work) glow(x + 2, y - 2, w - 12, 6, ACC.work, 0.12);
    // amber blink control rows on the near part of the top
    for (let i = 0; i < 3; i++) px(x + w - 8 + i * 2, y - 1, 1, 2, blink(600, i) ? '#ff9d2e' : '#33241a');
    px(x + w - 8, y + 2, 6, 1, blink(800) ? ACC.flow : U.shade(ACC.flow, -0.6)); // amber status bar
    px(x + w - 8, y + 4, 5, 1, U.shade(r.top, -0.24));        // knurled grip strip
    px(x + 3, y + 3, 3, 1, r.dk); px(x + 3, y + 3, 1, 1, r.lit); // small dial on the top
  };

  F.crate = (x, y, w, h) => {   // TOP-BIAS OBLIQUE cargo crate: big rounded lid, short ribbed face, skids
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    // short front face: ribbed cargo panel
    rr(x, y + 3, w, h - 4, LINE);
    px(x + 1, y + 4, w - 2, h - 6, r.face);
    for (let i = 1; i < (w - 2) / 5; i++) {
      px(x + 1 + i * 5, y + 4, 1, h - 6, r.ao);                 // ribs cut deep
      px(x + 2 + i * 5, y + 4, 1, h - 6, U.shade(r.face, 0.16)); // rib catch
    }
    px(x + 1, y + 4, 2, 2, r.sheen); px(x + w - 3, y + 4, 2, 2, r.sheen); // corner braces
    px(x + 1, y + h - 4, 2, 2, r.dk); px(x + w - 3, y + h - 4, 2, 2, r.dk);
    px(x + w - 8, y + 5, 4, 1, '#caa84a'); px(x + w - 7, y + 6, 2, 1, '#8a7434'); // serial stripe
    px(x + 1, y + h - 3, w - 2, 1, r.ao);                       // floor-line AO
    // the lid dominates: big rounded top surface with seam, stencil + clasps
    rr(x - 1, y - 3, w + 2, 9, LINE);
    rr(x, y - 2, w, 7, r.top);
    px(x + 1, y - 2, w - 2, 1, r.sheen);
    px(x, y - 1, 1, 5, r.lit); px(x + w - 1, y - 1, 1, 5, r.dk);
    px(x + w / 2, y - 1, 1, 5, U.shade(r.top, -0.20));          // lid seam
    px(x + 4, y, 4, 2, '#3a5a48'); px(x + 5, y, 2, 1, ACC.work); // stencil cargo glyph on the lid
    px(x + 4, y + 3, 1, 2, '#1e262c'); px(x + w - 5, y + 3, 1, 2, '#1e262c'); // clasps
    px(x + 2, y - 2, 1, 1, '#8693a0');                          // rivet glint
    px(x + 1, y + 4, w - 2, 1, U.shade(r.top, -0.16));          // lid front edge
    wear(x + 2, y - 1, w - 4, 5, 3, U.shade(r.top, -0.10));
    // skid rails on the floor
    px(x + 2, y + h - 1, 3, 1, r.dk); px(x + w - 5, y + h - 1, 3, 1, r.dk);
  };

  F.fabricator = (x, y, w, h, f) => { // apparel printer
    sh(x + 1, y + h - 1, w - 2);
    box(x, y + 1, w, h - 1, '#36424c');
    px(x + 1, y + 2, w - 2, 1, '#46525a');
    px(x + 1, y + 2, 1, h - 4, '#414d56'); px(x + w - 2, y + 2, 1, h - 4, '#2a343c'); // side facets
    rivets(x + 1, y + 2, w - 2, h - 3, '#5a6872', '#1e262c');
    // print window with frame screws
    inset(x + 2, y + 3, w - 4, 6, '#28323a');
    px(x + 2, y + 3, 1, 1, '#4a565e'); px(x + w - 3, y + 3, 1, 1, '#4a565e');
    px(x + 3, y + 4, w - 6, 4, f.work ? '#2e3840' : '#1a2228');
    if (f.work) {
      glow(x + 3, y + 4, w - 6, 4, '#ff9d2e', 0.35 + 0.15 * Math.sin(now / 300));
      const hd = x + 3 + Math.floor((now / 120) % (w - 8));
      px(hd, y + 4, 2, 4, '#ffd9a0'); // print head
      px(hd, y + 3, 2, 1, '#8a98a8'); // head carriage
      px(hd - 1, y + 7, 1, 1, '#ffeccc'); // fresh thread
      px(x + 3, y + 8, Math.floor(((now / 900) % 1) * (w - 6)), 1, '#ff9d2e'); // progress
      scanl(x + 3, y + 4, w - 6, 4, 0.15);
    } else {
      px(x + 4, y + 5, 2, 1, '#222c34'); // idle gantry
    }
    px(x + 1, y + 4, 1, 8, '#46525a'); px(x + w - 2, y + 4, 1, 8, '#2e3840'); // side pipes
    px(x + 1, y + 6, 1, 1, '#5a6872'); px(x + w - 2, y + 6, 1, 1, '#222a30'); // pipe clamps
    for (let i = 0; i < 4; i++) px(x + 3 + i * 3, y + 11, 2, 1, '#28323a'); // vents
    // filament spool on the left flank, spinning while printing
    px(x - 1, y + 6, 3, 3, '#2a343c'); px(x - 1, y + 6, 3, 1, '#3a4650');
    if (f.work) px(x - 1 + (Math.floor(now / 200) % 3), y + 7, 1, 1, '#ffd9a0');
    inset(x + 2, y + h - 6, w - 4, 4, '#28323a'); // output tray
    px(x + 3, y + h - 3, w - 6, 1, '#1c242a'); // tray lip shade
    px(x + w / 2 - 3, y + h - 5, 6, 2, '#e8e0d0'); px(x + w / 2 - 4, y + h - 5, 1, 1, '#e8e0d0'); px(x + w / 2 + 3, y + h - 5, 1, 1, '#e8e0d0');
    px(x + w / 2 - 3, y + h - 5, 6, 1, '#f6f0e4'); // fold highlight
    px(x + w / 2 - 1, y + h - 5, 2, 1, '#c8c0b0'); // collar
    px(x + 1, y + 1, 2, 2, blink(400) && f.work ? '#41ff8a' : '#2a3a30');
    px(x + 4, y + 1, 1, 1, blink(900) ? '#ffd34a' : '#33291a'); // heater light
    wear(x, y + 1, w, h - 1, 4, '#2e3a42');
  };

  F.vat = (x, y, w, h, f) => { // candle wax vat
    sh(x + 1, y + h - 1, w - 2);
    box(x, y + 1, w, h - 1, '#36424c');
    px(x + 1, y + 2, w - 2, 1, '#46525a');
    rivets(x + 1, y + 2, w - 2, h - 3, '#5a6872', '#1e262c');
    inset(x + 2, y + 2, w - 4, 7, '#28323a');
    px(x + 2, y + 2, 1, 1, '#4a565e'); px(x + w - 3, y + 2, 1, 1, '#4a565e'); // rim bolts
    const lvl = 3 + Math.round(Math.sin(now / 900));
    px(x + 3, y + 3 + (5 - lvl), w - 6, lvl, '#ffd9a0');
    px(x + 3, y + 3 + (5 - lvl), w - 6, 1, '#ffeccc');
    px(x + 4, y + 4 + (5 - lvl), 1, lvl - 1, '#f0c890'); // wax meniscus
    glow(x + 3, y + 3, w - 6, 6, '#ff9d2e', 0.12 + 0.08 * Math.sin(now / 700));
    px(x + 5 + Math.floor((now / 500) % (w - 12)), y + 4 + (5 - lvl), 2, 1, '#fff4dd'); // shimmer
    // stirrer paddle sweeping the surface
    const stx = x + 4 + Math.floor((0.5 + 0.5 * Math.sin(now / 1300)) * (w - 11));
    px(stx, y + 2 + (5 - lvl), 1, 2, '#8a98a8'); px(stx, y + 2 + (5 - lvl), 1, 1, '#aab8c8');
    if (f.work && blink(300)) { px(x + w / 2, y, 1, 2, '#ff9d2e'); px(x + w / 2, y - 1, 1, 1, '#ffd34a'); } // flame test
    // heater coil glow under the basin
    glow(x + 3, y + 9, w - 6, 1, '#ff4a3d', f.work ? 0.25 + 0.12 * Math.sin(now / 250) : 0.08);
    for (let i = 0; i < (w - 4) / 4; i++) px(x + 2 + i * 4, y + 10, 2, 1, i % 2 ? '#caa84a' : '#28323a'); // hazard stripe
    px(x + w - 3, y + 5, 1, 4, '#2a343c'); px(x + w - 3, y + 5, 1, 1, '#caa84a'); // temp gauge
    inset(x + 1, y + h - 7, w - 2, 6, '#28323a'); // candle tray
    px(x + 2, y + h - 2, w - 4, 1, '#1c242a'); // tray shade
    px(x + 3, y + h - 5, 3, 3, '#caa86a'); px(x + 8, y + h - 6, 3, 4, '#d8b87a'); px(x + 13, y + h - 5, 3, 3, '#e0c890');
    px(x + 3, y + h - 5, 1, 3, '#dfc28a'); px(x + 8, y + h - 6, 1, 4, '#e8cc92'); // candle lit sides
    px(x + 4, y + h - 6, 1, 1, '#888'); px(x + 9, y + h - 7, 1, 1, '#888'); px(x + 14, y + h - 6, 1, 1, '#888');
    px(x + 5, y + h - 3, 2, 1, '#b89858'); // wax drip on tray
  };

  F.easel = (x, y, w, h, f) => { // portrait station
    sh(x + 1, y + h - 1, w - 2);
    box(x, y + 1, w, h - 1, '#3a3242');
    px(x + 1, y + 2, w - 2, 1, '#4c4256');
    px(x + 1, y + 2, 1, h - 4, '#463c52'); px(x + w - 2, y + 2, 1, h - 4, '#2c2434'); // side facets
    rivets(x + 1, y + 2, w - 2, h - 3, '#5c5070', '#221c2c');
    inset(x + 2, y + 2, w - 4, 9, '#1c1626');
    px(x + 2, y + 2, 2, 1, '#4c4258'); px(x + w - 4, y + 2, 2, 1, '#4c4258'); // canvas clamps
    if (f.work) { // scanline reveal of the commissioned portrait
      const rev = (now / 2000) % 1;
      const rh = Math.floor(7 * rev) + 1;
      px(x + 3, y + 3, w - 6, rh, '#ff6ad5');
      px(x + 3, y + 3, w - 6, 1, '#ffa8e8');
      px(x + 5, y + 4, 2, 1, '#ffd9a0'); px(x + 8, y + 5, 1, 1, '#2a1a24'); // pet face hint
      if (rh > 3) { px(x + w - 8, y + 5, 2, 1, '#ffd9a0'); px(x + w - 7, y + 6, 1, 1, '#2a1a24'); } // second ear
      px(x + 3, y + 3 + rh, w - 6, 1, blink(120) ? '#ffffff' : '#ff6ad5'); // scan head
      glow(x + 3, y + 3, w - 6, rh, '#ff6ad5', 0.12);
    } else {
      px(x + 5, y + 4, 4, 4, '#5a4a6a'); px(x + 6, y + 5, 2, 2, '#6e5a80');
      px(x + w - 9, y + 4, 3, 3, '#4a3c58');
      px(x + 4, y + 9, w - 8, 1, '#2a2236'); // sketch guide line
    }
    px(x + 1, y + h - 4, w - 2, 3, '#2e2838');
    px(x + 2, y + h - 4, w - 4, 1, '#3c3448'); // ledge catch
    // paint pots + splatter on the ledge
    px(x + w - 6, y + h - 3, 2, 2, '#ff6ad5'); px(x + w - 6, y + h - 3, 1, 1, '#ffa8e8');
    px(x + w - 9, y + h - 3, 2, 2, '#4ad9ff');
    px(x + 2, y + h - 2, 1, 1, '#ff6ad5'); px(x + 5, y + h - 2, 1, 1, '#4ad9ff'); // splatter
    for (let i = 0; i < 4; i++) px(x + 3 + i * 4, y + h - 3, 2, 1, blink(500, i) && f.work ? '#ff6ad5' : '#473a54');
  };

  F.beltH = (x, y, w, h) => {
    // CONVEYOR — a FLOOR-FLAT belt segment carrying work boxes between stations (walk-level deck
    // hardware, integral to the floor — no separate plate). Moving tread + hazard ends + a drive-motor
    // indicator. Bolder restyle in the RAMP/ACC language, matched to conveyor.js's live-belt look.
    const r = RAMP.steel;
    const top = y + 2, bh = h - 4;                            // belt bed sits between two rails
    // bed: dark recessed channel
    rr(x - 1, top - 1, w + 2, bh + 2, LINE);
    px(x, top, w, bh, U.shade(r.face, -0.3));
    px(x, top, w, 1, r.ao);
    // moving tread: diagonal cleats scrolling east (matches conveyor.js direction)
    const off = Math.floor(now / 110) % 6;
    for (let i = -1; i < w / 6 + 1; i++) {
      const cx = x + 1 + i * 6 + off;
      px(cx, top + 1, 1, bh - 2, r.lit);                     // cleat lit face
      px(cx + 1, top + 1, 1, bh - 2, r.dk);                  // cleat shadow
    }
    px(x, top + 1, w, 1, U.shade(r.top, -0.10));             // subtle bed sheen over the tread
    // side RAILS (raised guide walls, lit top / dark inner)
    px(x - 1, y + 1, w + 2, 2, LINE); px(x - 1, y + h - 3, w + 2, 2, LINE);
    px(x, y + 1, w, 1, r.sheen); px(x, y + 2, w, 1, r.lit);  // north rail
    px(x, y + h - 3, w, 1, r.top); px(x, y + h - 2, w, 1, r.dk); // south rail (faces us)
    for (let i = 0; i < w / 12; i++) {                       // rail bolts + roller shadows
      px(x + 2 + i * 12, y + 1, 1, 1, r.sheen);
      px(x + 8 + i * 12, y + h - 1, 2, 1, '#141a16');
    }
    // hazard ends (yellow/black chevron caps)
    px(x, y, 2, h > 6 ? 3 : 2, '#caa84a'); px(x + 1, y, 1, h > 6 ? 3 : 2, '#2a2418');
    px(x + w - 2, y, 2, h > 6 ? 3 : 2, '#caa84a'); px(x + w - 2, y, 1, h > 6 ? 3 : 2, '#2a2418');
    // drive-motor housing at the left end with a spinning green run indicator
    px(x + 1, y + h - 2, 6, 3, '#232d33'); px(x + 1, y + h - 2, 6, 1, r.lit);
    px(x + 1, y + h - 2, 1, 3, r.dk);
    px(x + 2 + (Math.floor(now / 150) % 3), y + h + 1, 1, 1, ACC.work); // drive pulse
    glow(x + 2, y + h, 4, 1, ACC.work, 0.25);
    wear(x + 1, top + 1, w - 2, bh - 2, 5, U.shade(r.face, -0.4));
  };

  F.intake = (x, y, w, h, f) => {
    // INTAKE — where outside work (a DM / a job) enters the station and drops onto a belt.
    // TOP-BIAS OBLIQUE hopper bolted to the deck: dominant lit top with an AMBER feeder MOUTH
    // (pulses; flares on active intake f.work) + a cyan SIGNAL MAST that pings (the bay LISTENS).
    const r = RAMP.steel, active = !!f.work, cyc = (now / 900) % 1;
    shadow2(x + 1, y + h - 1, w - 2);                         // floor contact
    deckPlate(x - 1, y + h - 6, w + 2, 6);                    // bolted mounting plate peeks out
    deckSocket(x + w + 1, y + h - 3, active);                 // cable into floor conduit, east
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    for (const lx of [x + 2, x + w - 5]) {                    // chunky corner legs on the plate
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // short south face of the hopper body (chamfered corners kill the box)
    rr(x - 1, y + h - 12, w + 2, 8, LINE);
    px(x, y + h - 11, w, 6, r.face);
    px(x, y + h - 11, w, 1, r.lit);                           // catch under the top lip
    px(x + 1, y + h - 6, w - 2, 1, r.ao);                     // floor-line AO band
    // AMBER feeder mouth set into the front face (belt SOURCE language: dark slot + feeder bars)
    const mx = x + 4, my = y + h - 10, mw = w - 8, mh = 4;
    px(mx - 1, my - 1, mw + 2, mh + 2, '#2a2418');            // dark-amber frame
    inset(mx, my, mw, mh, (cyc < 0.5) ? '#161210' : '#3a3320');
    for (let i = 0; i < mw - 2; i += 3) px(mx + 1 + i, my + 1, 1, mh - 2, ACC.flow); // feeder bars (amber)
    if (active || cyc > 0.86) {
      px(mx, my, mw, 1, '#ffe27a');
      glow(mx - 1, my - 1, mw + 2, mh + 2, ACC.flow, active ? 0.5 : 0.3);
    }
    // the big lit TOP surface dominates: rounded, back-edge sheen, chute collar + intake caret
    rr(x - 1, y + h - 20, w + 2, 10, LINE);
    rr(x, y + h - 19, w, 8, r.top);
    px(x + 1, y + h - 19, w - 2, 1, r.sheen);
    px(x, y + h - 18, 1, 6, r.lit); px(x + w - 1, y + h - 18, 1, 6, r.dk);
    px(x + 3, y + h - 17, 6, 1, U.shade(r.top, 0.07));       // west brushed streak
    px(x + 1, y + h - 12, w - 2, 1, U.shade(r.top, -0.16));  // top front edge
    wear(x + 2, y + h - 18, w - 4, 6, 3, U.shade(r.top, -0.10));
    // raised intake COLLAR + caret stencil on the top (work drops IN here)
    rr(x + 4, y + h - 18, w - 8, 5, U.shade(r.top, -0.22));
    px(x + 5, y + h - 17, w - 10, 3, '#1a1410');             // dark throat
    px(x + w / 2 - 2, y + h - 16, 1, 1, '#8a9a90'); px(x + w / 2 - 1, y + h - 15, 1, 1, '#8a9a90');
    px(x + w / 2, y + h - 16, 1, 1, '#8a9a90');              // ▽ intake caret
    if (active) glow(x + 5, y + h - 17, w - 10, 3, ACC.flow, 0.22 + 0.1 * Math.sin(now / 300));
    // cyan SIGNAL MAST rising above the footprint with a listen-ping
    const ax = x + w - 4;
    px(ax, y + h - 26, 1, 6, r.dk); px(ax - 1, y + h - 26, 3, 1, r.lit); // mast + crossbar
    px(ax, y + h - 21, 1, 1, r.sheen);
    const ping = blink(640, 0);
    px(ax, y + h - 27, 1, 1, ping ? '#7df0ff' : U.shade(ACC.data, -0.55));
    if (ping) glow(ax - 2, y + h - 28, 5, 4, ACC.data, 0.30);
  };

  F.outbox = (x, y, w, h, f) => {
    // OUTBOX — the dispatch chute where a finished reply LEAVES the station. Mirror of INTAKE but
    // GREEN/CYAN (outgoing) vs amber (incoming). Uplink light solid + bright while dispatching (f.work).
    const r = RAMP.steel, active = !!f.work, cyc = (now / 900) % 1;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 6, w + 2, 6);
    deckSocket(x + w + 1, y + h - 3, active);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // short south face + dark dispatch chute mouth (green dispatch bars)
    rr(x - 1, y + h - 12, w + 2, 8, LINE);
    px(x, y + h - 11, w, 6, r.face);
    px(x, y + h - 11, w, 1, r.lit);
    px(x + 1, y + h - 6, w - 2, 1, r.ao);
    const mx = x + 4, my = y + h - 10, mw = w - 8, mh = 4;
    px(mx - 1, my - 1, mw + 2, mh + 2, '#0a1816');           // dark chute frame
    inset(mx, my, mw, mh, '#06100e');
    for (let i = 0; i < mw - 2; i += 3) px(mx + 1 + i, my + 1, 1, mh - 2, active ? '#5ad1b3' : U.shade(ACC.work, -0.42)); // dispatch bars
    if (active || cyc > 0.86) {
      px(mx, my, mw, 1, '#7df0c8');
      glow(mx - 1, my - 1, mw + 2, mh + 2, '#5ad1b3', active ? 0.5 : 0.25);
    }
    // lit TOP dominates: rounded, sheen, dispatch collar + OUT caret (▲ leaving)
    rr(x - 1, y + h - 20, w + 2, 10, LINE);
    rr(x, y + h - 19, w, 8, r.top);
    px(x + 1, y + h - 19, w - 2, 1, r.sheen);
    px(x, y + h - 18, 1, 6, r.lit); px(x + w - 1, y + h - 18, 1, 6, r.dk);
    px(x + 3, y + h - 17, 6, 1, U.shade(r.top, 0.07));
    px(x + 1, y + h - 12, w - 2, 1, U.shade(r.top, -0.16));
    wear(x + 2, y + h - 18, w - 4, 6, 3, U.shade(r.top, -0.10));
    rr(x + 4, y + h - 18, w - 8, 5, U.shade(r.top, -0.22));
    px(x + 5, y + h - 17, w - 10, 3, '#0e1a16');             // dark dispatch throat
    px(x + w / 2, y + h - 17, 1, 1, '#8a9a90'); px(x + w / 2 - 1, y + h - 16, 1, 1, '#8a9a90');
    px(x + w / 2 + 1, y + h - 16, 1, 1, '#8a9a90');          // ▲ OUT caret
    if (active) glow(x + 5, y + h - 17, w - 10, 3, ACC.work, 0.24 + 0.12 * Math.sin(now / 300));
    // UPLINK light on a mast: blinks idle, solid + bright while dispatching
    const ax = x + w - 4;
    px(ax, y + h - 26, 1, 6, r.dk); px(ax - 1, y + h - 26, 3, 1, r.lit);
    px(ax, y + h - 21, 1, 1, r.sheen);
    px(ax, y + h - 27, 1, 1, active ? '#7df0c8' : (blink(720, 1) ? ACC.work : U.shade(ACC.work, -0.6)));
    if (active) glow(ax - 2, y + h - 28, 5, 4, '#5ad1b3', 0.35);
  };

  F.splitter = (x, y, w, h, f) => {
    // SPLITTER — a 1-tile belt router that FANS one work stream across its out-lanes (load-balance =
    // real parallelism). Low bolted deck box (~4px rise), symmetric green fan + cycling routing LED.
    const r = RAMP.steel, c = '#5ad1b3';
    shadow2(x + 1, y + h - 1, w - 2);
    // low bolted body: short south face + lit top
    rr(x - 1, y + h - 8, w + 2, 5, LINE);
    px(x, y + h - 7, w, 3, r.face); px(x, y + h - 7, w, 1, r.lit); px(x + 1, y + h - 5, w - 2, 1, r.ao);
    px(x + 2, y + h - 6, 1, 1, '#caa84a'); px(x + w - 3, y + h - 6, 1, 1, '#caa84a'); // bolt hazard ticks
    rr(x - 1, y + h - 13, w + 2, 7, LINE);
    rr(x, y + h - 12, w, 6, r.top);
    px(x + 1, y + h - 12, w - 2, 1, r.sheen);
    px(x, y + h - 11, 1, 4, r.lit); px(x + w - 1, y + h - 11, 1, 4, r.dk);
    px(x + 1, y + h - 7, w - 2, 1, U.shade(r.top, -0.16));
    // FAN-OUT lane graphic recessed into the lit top (neutral steel well — identity lives in the
    // glowing LANES, never the casing): trunk-in fans to two out-lanes
    inset(x + 2, y + h - 11, w - 4, 5, '#131b20');
    const cy = y + h - 9, lc = f.work ? U.shade(c, 0.28) : c; // lanes run hotter while routing
    px(x + 2, cy, w - 5, 1, lc);                              // trunk (incoming lane)
    px(x + w - 4, y + h - 11, 1, 3, lc);                      // branch up
    px(x + w - 4, cy, 1, 3, lc);                              // branch down
    px(x + w - 3, y + h - 11, 2, 1, lc); px(x + w - 3, y + h - 6, 2, 1, lc); // lane tips
    glow(x + w - 3, y + h - 11, 2, 1, c, 0.25); glow(x + w - 3, y + h - 6, 2, 1, c, 0.25); // tips glow
    px(x + 3, cy - 1, 1, 1, blink(360, 0) ? '#7df0c8' : U.shade(c, -0.55)); // routing LED cycles as it dispatches
    if (f.work) {                                             // lane-shaped halo on work — casing stays steel
      glow(x + 1, cy - 1, w - 3, 3, c, 0.22);                 // trunk halo
      glow(x + w - 5, y + h - 12, 3, 7, c, 0.20);             // fan-branch halo
    }
  };

  F.filter = (x, y, w, h, f) => {
    // FILTER — the content router: sorts the work stream by a box's TAG to a chosen out-lane
    // (code/research/default). Steel casing; the violet SORT-LANE graphic + TRI-COLOURED lane tips
    // carry its identity vs the splitter's symmetric green fan. Low bolted deck box (~4px rise).
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    rr(x - 1, y + h - 8, w + 2, 5, LINE);
    px(x, y + h - 7, w, 3, r.face); px(x, y + h - 7, w, 1, r.lit); px(x + 1, y + h - 5, w - 2, 1, r.ao);
    px(x + 2, y + h - 6, 1, 1, '#caa84a'); px(x + w - 3, y + h - 6, 1, 1, '#caa84a');
    rr(x - 1, y + h - 13, w + 2, 7, LINE);
    rr(x, y + h - 12, w, 6, r.top);
    px(x + 1, y + h - 12, w - 2, 1, r.sheen);
    px(x, y + h - 11, 1, 4, r.lit); px(x + w - 1, y + h - 11, 1, 4, r.dk);
    px(x + 1, y + h - 7, w - 2, 1, U.shade(r.top, -0.16));
    // SORT-LANE graphic recessed in the top (neutral steel well): violet trunk + rail,
    // tri-colour lane tips = the filter's identity
    inset(x + 2, y + h - 11, w - 4, 5, '#131b20');
    const cy = y + h - 9, lc = f.work ? U.shade(ACC.mem, 0.28) : ACC.mem; // trunk runs hotter while sorting
    px(x + 2, cy, w - 5, 1, lc);                             // trunk in (violet)
    px(x + w - 4, y + h - 11, 1, 5, U.shade(ACC.mem, -0.28)); // sorting rail
    px(x + w - 3, y + h - 11, 2, 1, ACC.data);              // top tip — cyan (code)
    px(x + w - 3, cy, 2, 1, ACC.flow);                      // mid tip — amber (research)
    px(x + w - 3, y + h - 6, 2, 1, '#8a9a90');              // bottom tip — neutral (default)
    glow(x + w - 3, y + h - 11, 2, 1, ACC.data, 0.25); glow(x + w - 3, cy, 2, 1, ACC.flow, 0.25); // tips glow
    px(x + 3, cy - 1, 1, 1, blink(420, 0) ? '#d8b8ff' : U.shade(ACC.mem, -0.5)); // sorting LED
    if (f.work) {                                            // lane-shaped halo on work — casing stays steel
      glow(x + 1, cy - 1, w - 3, 3, ACC.mem, 0.22);          // trunk halo
      glow(x + w - 5, y + h - 12, 3, 7, ACC.mem, 0.18);      // sorting-rail halo
    }
  };

  F.merger = (x, y, w, h, f) => {
    // MERGER — buffers K inbound boxes and emits ONE combined box (a join / map-reduce barrier).
    // Steel casing; the amber K-JOIN trunk graphic (two inputs converging to one out lane — the
    // visual INVERSE of the splitter's fan) carries its identity. Low bolted deck box (~4px rise).
    const r = RAMP.steel, c = '#e0a45a';
    shadow2(x + 1, y + h - 1, w - 2);
    rr(x - 1, y + h - 8, w + 2, 5, LINE);
    px(x, y + h - 7, w, 3, r.face); px(x, y + h - 7, w, 1, r.lit); px(x + 1, y + h - 5, w - 2, 1, r.ao);
    px(x + 2, y + h - 6, 1, 1, '#caa84a'); px(x + w - 3, y + h - 6, 1, 1, '#caa84a');
    rr(x - 1, y + h - 13, w + 2, 7, LINE);
    rr(x, y + h - 12, w, 6, r.top);
    px(x + 1, y + h - 12, w - 2, 1, r.sheen);
    px(x, y + h - 11, 1, 4, r.lit); px(x + w - 1, y + h - 11, 1, 4, r.dk);
    px(x + 1, y + h - 7, w - 2, 1, U.shade(r.top, -0.16));
    // K-JOIN trunk graphic recessed in the top (neutral steel well): two inputs converge to one
    // out lane = the merger's identity
    inset(x + 2, y + h - 11, w - 4, 5, '#131b20');
    const cy = y + h - 9, top = y + h - 11, bot = y + h - 7;
    px(x + 3, top, 2, 1, c); px(x + 3, bot, 2, 1, c);        // two input stubs (top-left + bottom-left)
    px(x + 4, top, 1, Math.max(1, cy - top), c);            // top input converges to centre
    px(x + 4, cy, 1, Math.max(1, bot - cy), c);             // bottom input converges to centre
    px(x + 4, cy, w - 6, 1, c);                              // combined out lane
    px(x + w - 3, cy, 2, 1, c);                              // out tip
    glow(x + w - 3, cy, 2, 1, c, 0.25);                      // out tip glows
    px(x + 3, cy + 1, 1, 1, blink(520, 0) ? '#ffd488' : U.shade(c, -0.5)); // buffer LED
    if (f.work) glow(x + 2, y + h - 11, w - 4, 5, c, 0.3);   // lanes flare on work, casing stays steel
  };

  F.bay = (x, y, w, h, f) => {
    // BAY — the agent DOCK. Work routed here runs as the bound agent; props in the room become its
    // powers. TOP-BIAS OBLIQUE docking platform bolted to the deck. Nameplate on the top names the
    // bound agent (lit) or reads UNASSIGNED (dim). Docking chevrons point IN; bound LED pulses.
    const bound = !!(f && f.agentId), c = bound ? '#5ad1b3' : '#3a464a', r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 6, w + 2, 6);                    // bolted deck plate
    deckSocket(x + w + 1, y + h - 3, bound);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // short south face of the platform
    rr(x - 1, y + h - 11, w + 2, 7, LINE);
    px(x, y + h - 10, w, 5, r.face);
    px(x, y + h - 10, w, 1, r.lit);
    px(x + 1, y + h - 6, w - 2, 1, r.ao);
    // the big lit deck TOP: rounded, sheen, corner dock guides + recessed nameplate
    rr(x - 1, y + h - 20, w + 2, 10, LINE);
    rr(x, y + h - 19, w, 8, r.top);
    px(x + 1, y + h - 19, w - 2, 1, r.sheen);
    px(x, y + h - 18, 1, 6, r.lit); px(x + w - 1, y + h - 18, 1, 6, r.dk);
    px(x + 1, y + h - 12, w - 2, 1, U.shade(r.top, -0.16));   // top front edge
    wear(x + 2, y + h - 18, w - 4, 5, 3, U.shade(r.top, -0.10));
    // hazard dock guides / chevrons pointing IN (work berths here) — corners of the pad
    px(x + 2, y + h - 18, 3, 1, '#caa84a'); px(x + 2, y + h - 18, 1, 3, '#caa84a');
    px(x + w - 5, y + h - 18, 3, 1, '#caa84a'); px(x + w - 3, y + h - 18, 1, 3, '#caa84a');
    px(x + w / 2 - 2, y + h - 17, 5, 1, c); px(x + w / 2, y + h - 16, 1, 2, c); // centre-in chevron
    // recessed NAMEPLATE inset into the top surface
    const npx = x + 3, npy = y + h - 15, npw = w - 6;
    px(npx - 1, npy - 1, npw + 2, 6, '#0c1210');
    px(npx, npy, npw, 4, bound ? '#13211a' : '#101619');
    if (bound) {
      px(npx, npy, npw, 1, '#1e3a2c');                        // lit top edge
      ctx.fillStyle = '#7df0c8'; ctx.font = '6px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(String(f.agentId).replace(/^tg_/, '').slice(0, 5).toUpperCase(), npx + 1, npy - 1);
      if (f.work) glow(x, y + h - 19, w, 8, c, 0.28);         // active dock spill on the pad
    } else {
      px(npx + 2, npy + 1, npw - 4, 1, '#2a3438');            // dim "unassigned" bar
      px(npx + 2, npy + 2, npw - 7, 1, '#232c30');
    }
    // bound status LED on the pad corner
    px(x + 2, y + h - 18, 1, 1, bound ? (blink(700, 0) ? '#7df0c8' : U.shade(c, -0.55)) : '#3a2418');
    if (bound && blink(700, 0)) glow(x + 1, y + h - 19, 3, 3, c, 0.3);
  };

  F.boxes = (x, y, w, h) => {
    // TOP-BIAS OBLIQUE clutter: cartons at varied heights & 1px offsets, each a BIG lid + short face.
    const cw = w, floorY = y + h - 1;
    // one carton: big rounded lid (depth ld) over a short front face (fh), base sits at fb.
    const carton = (bx, fb, bw, fh, ld, ramp, tint) => {
      const ty = fb - fh - ld;                                  // lid top y
      // short front face
      rr(bx, ty + ld, bw, fh, LINE);
      px(bx + 1, ty + ld + 1, bw - 2, fh - 2, ramp.face);
      px(bx + 1, ty + ld + 1, 1, fh - 2, ramp.lit);             // west lit edge
      px(bx + bw - 2, ty + ld + 1, 1, fh - 2, ramp.dk);         // east dark edge
      px(bx + 1, fb - 1, bw - 2, 1, ramp.ao);                   // floor-line AO
      px(bx + Math.floor(bw / 2), ty + ld + 1, 1, fh - 2, U.shade(ramp.face, 0.12)); // tape seam
      // shipping label on the face
      px(bx + 2, ty + ld + 2, 3, 2, '#dfe8df'); px(bx + 2, ty + ld + 2, 3, 1, '#f0f6f0');
      px(bx + 2, ty + ld + 3, 2, 1, '#9aaa9a');                 // barcode
      px(bx + bw - 4, ty + ld + 2, 2, 1, tint);                 // priority sticker
      // DOMINANT rounded lid
      rr(bx - 1, ty, bw + 2, ld + 1, LINE);
      px(bx, ty + 1, bw, ld, ramp.top);
      px(bx, ty + 1, bw, 1, ramp.sheen);                        // back edge catches light
      px(bx, ty + 2, 4, 1, U.shade(ramp.sheen, 0.14));          // west sheen streak
      px(bx, ty + 2, 1, ld - 1, ramp.lit); px(bx + bw - 1, ty + 2, 1, ld - 1, ramp.dk);
      px(bx + Math.floor(bw / 2), ty + 1, 1, ld, U.shade(ramp.top, -0.20)); // flap crease
      px(bx, ty + ld, bw, 1, U.shade(ramp.top, -0.16));         // lid front lip
      px(bx + bw - 5, ty + 1, 3, 1, tint);                      // cargo tag on the lid
    };
    shadow2(x + 1, floorY, cw - 2);
    // big front-left carton (steel), a TALLER back-right one nudged east, then a small one perched
    carton(x + 1, floorY, 13, 4, 5, RAMP.steel, ACC.data);
    carton(x + 13, floorY - 1, 10, 3, 6, RAMP.fabric, ACC.flow);
    // small carton perched on the left one's lid, 1px-rotated (offset edges)
    const sx = x + 3, sb = floorY - 8;
    rr(sx, sb - 4, 7, 5, LINE);
    px(sx + 1, sb - 2, 5, 2, RAMP.fabric.face); px(sx + 1, sb - 2, 1, 2, RAMP.fabric.lit);
    px(sx + 1, sb - 3, 5, 2, RAMP.fabric.top); px(sx + 1, sb - 3, 5, 1, RAMP.fabric.sheen);
    px(sx + 4, sb - 3, 1, 2, U.shade(RAMP.fabric.top, -0.18));  // flap
    px(sx + 2, sb - 3, 1, 1, ACC.alert);                       // fragile dot
    // scattered floor wear
    px(x + cw - 6, floorY, 3, 1, U.shade(RAMP.steel.face, -0.22));
  };

  F.poster = (x, y) => {
    px(x + 1, y, 10, 12, '#0c1410');
    px(x + 2, y + 1, 8, 10, '#1a2620');
    px(x + 2, y + 1, 8, 1, '#243228'); // top catch
    px(x + 3, y + 2, 6, 8, '#24382c');
    px(x + 4, y + 3, 4, 2, '#41ff8a'); px(x + 5, y + 2, 2, 1, '#41ff8a'); // logo
    glow(x + 4, y + 2, 4, 3, '#41ff8a', 0.18 + 0.06 * Math.sin(now / 900));
    px(x + 4, y + 6, 4, 1, '#9adcb0'); px(x + 4, y + 8, 3, 1, '#9adcb0'); // text
    px(x + 4, y + 9, 2, 1, '#5a7a64'); // fine print
    px(x + 2, y + 1, 1, 1, '#56645c'); px(x + 9, y + 1, 1, 1, '#56645c'); // pins
    px(x + 2, y + 10, 1, 1, '#56645c');
    px(x + 9, y + 10, 1, 1, '#16241a'); // peeling corner
    glow(x + 3, y + 2, 2, 8, '#ffffff', 0.05);
  };

  F.djbooth = (x, y, w, h, f) => {
    sh(x + 1, y + h - 1, w - 2);
    box(x, y + 2, w, h - 2, '#2a1a3a');
    px(x + 1, y + 3, w - 2, 1, '#3e2a52');
    px(x + 1, y + 3, 1, h - 6, '#372348'); px(x + w - 2, y + 3, 1, h - 6, '#1d1129'); // side facets
    glow(x, y + 2, w, 1, '#b44aff', f.work ? 0.5 + 0.3 * Math.sin(now / 200) : 0.25); // neon trim
    glow(x + 1, y + h - 1, w - 2, 2, '#b44aff', f.work ? 0.18 + 0.08 * Math.sin(now / 200) : 0.06); // floor spill
    inset(x + 2, y + 3, w - 4, 5, '#1a0e28');
    for (let i = 0; i < (w - 8) / 3; i++) { // EQ bars with peak-hold dots
      const hh = f.work ? 1 + Math.abs(Math.floor(flick(90, i) * 3)) : 1;
      px(x + 4 + i * 3, y + 7 - hh, 2, hh, ['#b44aff', '#ff6ad5', '#4ad9ff'][i % 3]);
      if (f.work) px(x + 4 + i * 3, y + 7 - hh - 1, 2, 1, U.shade(['#b44aff', '#ff6ad5', '#4ad9ff'][i % 3], 0.45));
    }
    for (const tx of [x + 4, x + w - 12]) { // turntables with grooves + tonearm
      px(tx - 1, y + h - 11, 10, 10, '#160d20');
      px(tx - 1, y + h - 11, 10, 1, '#241636'); // deck plate catch
      px(tx, y + h - 10, 8, 8, '#111'); px(tx + 1, y + h - 9, 6, 6, '#222');
      px(tx + 1, y + h - 9, 6, 1, '#2c2c2c'); px(tx + 1, y + h - 6, 6, 1, '#1c1c1c'); // groove rings
      px(tx + 2, y + h - 8, 4, 4, '#333'); px(tx + 3, y + h - 7, 2, 2, '#0a0a0a');
      px(tx + 3, y + h - 7, 1, 1, '#b44aff'); // label dot
      px(tx + 7, y + h - 10, 1, 4, '#4a3a5e'); px(tx + 6, y + h - 7, 1, 1, '#5c4a72'); // tonearm
      if (f.work) {
        const a = now / 250 + tx;
        px(tx + 3 + Math.round(Math.cos(a) * 3), y + h - 6 + Math.round(Math.sin(a) * 3), 1, 1, '#dfd0ff');
      }
    }
    inset(x + w / 2 - 5, y + h - 10, 10, 8, '#241636'); // mixer
    px(x + w / 2 - 4, y + h - 10, 8, 1, '#382454'); // mixer face catch
    for (let i = 0; i < 3; i++) {
      px(x + w / 2 - 3 + i * 3, y + h - 9, 1, 6, '#3a2a4e');
      const sv = f.work ? Math.abs(Math.floor(flick(150, i) * 2)) : 1;
      px(x + w / 2 - 3 + i * 3, y + h - 5 - sv, 1, 2, '#ff6ad5');
      px(x + w / 2 - 3 + i * 3, y + h - 5 - sv, 1, 1, '#ffa8e8'); // fader cap shine
    }
    px(x + w / 2 - 4, y + h - 3, 8, 1, '#1a0e28'); // mixer base shade
    for (let i = 0; i < 4; i++) px(x + w / 2 - 4 + i * 2, y + h - 11, 1, 1, blink(300, i) && f.work ? '#4ad9ff' : '#2c1c40'); // cue LEDs
    // cable run from booth to floor
    px(x + 2, y + h - 1, 1, 1, '#160d20'); px(x + 3, y + h, 2, 1, '#160d20');
    if (f.work) px(x + w / 2 - 1, y + 1, 2, 1, blink(150) ? '#ff6ad5' : '#4ad9ff');
    // record crate leaning on the right side
    px(x + w - 3, y + h - 4, 3, 3, '#1d1129'); px(x + w - 3, y + h - 4, 3, 1, '#33204a');
    px(x + w - 2, y + h - 5, 1, 1, '#b44aff'); px(x + w - 1, y + h - 5, 1, 1, '#4ad9ff'); // sleeve edges
  };

  F.speaker = (x, y, w, h, f) => {
    sh(x + 2, y + 11, 8);
    box(x + 2, y, 8, 12, '#1a1424');
    px(x + 3, y + 1, 6, 1, '#2c2240');
    px(x + 3, y + 2, 1, 9, '#241b32'); px(x + 8, y + 2, 1, 9, '#120d1c'); // cabinet facets
    px(x + 2, y, 1, 1, '#3a2c52'); px(x + 9, y, 1, 1, '#3a2c52'); // corner protectors
    px(x + 2, y + 11, 1, 1, '#0e0a16'); px(x + 9, y + 11, 1, 1, '#0e0a16');
    px(x + 4, y, 4, 1, '#241b32'); // top handle slot
    for (const dy of [2, 7]) { // drivers: surround ring + cone + dust cap
      px(x + 4, y + dy, 4, 4, '#2a2038');
      px(x + 4, y + dy, 4, 1, '#382a4c'); px(x + 4, y + dy + 3, 4, 1, '#1c1428'); // ring shading
      px(x + 5, y + dy + 1, 2, 2, '#0a0612');
      px(x + 5, y + dy + 1, 1, 1, '#3c3050');
      if (f.work) {
        glow(x + 3, y + dy, 6, 4, '#b44aff', blink(170, x + dy) ? 0.25 : 0.08);
        if (blink(170, x + dy)) px(x + 5, y + dy + 1, 2, 2, '#1a1026'); // cone throb
      }
    }
    px(x + 5, y + 6, 2, 1, '#0e0a18'); // port
    px(x + 5, y + 6, 1, 1, '#1c1428'); // port shading
    px(x + 6, y + 12, 2, 1, '#120d1c'); // cable to floor
    px(x + 8, y + 1, 1, 1, f.work && blink(400, x) ? '#ff6ad5' : '#2c1c40'); // power LED
  };

  F.vault = (x, y, w, h, f) => {   // heavy LOW BUNKER (3x2): big top mass + thick door face; combo dial; ACC.work green
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);                                 // floor contact
    deckPlate(x + 1, y + h - 4, w - 2, 4);                            // bolted plate
    deckSocket(x + 1, y + h - 3, f && f.work); deckSocket(x + w - 5, y + h - 3, f && f.work);
    // THICK door face (south wall of the bunker) — spans most of the height
    rr(x - 1, y + 4, w + 2, h - 4, LINE);
    px(x, y + 5, w, h - 6, r.face);
    px(x, y + 5, 1, h - 6, U.shade(r.face, 0.10)); px(x + w - 1, y + 5, 1, h - 6, r.dk);
    px(x, y + h - 2, w, 1, r.ao);                                     // floor-line AO
    // armored plate seams + two bolt rows across the door
    for (const sxp of [x + 14, x + w - 15]) px(sxp, y + 5, 1, h - 6, U.shade(r.face, -0.2));
    for (let i = 0; i < 5; i++) { px(x + 4 + i * ((w - 8) / 4), y + 6, 1, 1, r.sheen); px(x + 4 + i * ((w - 8) / 4), y + h - 3, 1, 1, r.ao); }
    // hinge knuckles on the left edge
    px(x, y + 7, 2, 3, r.dk); px(x, y + 7, 2, 1, r.lit); px(x, y + h - 5, 2, 3, r.dk); px(x, y + h - 5, 2, 1, r.lit);
    // big BOLD top mass (we look down on it — dominant surface of a low bunker)
    rr(x - 1, y - 4, w + 2, 9, LINE);
    rr(x, y - 3, w, 8, r.top);
    px(x + 1, y - 3, w - 2, 1, r.sheen);
    px(x, y - 2, 1, 7, r.lit); px(x + w - 1, y - 2, 1, 7, r.dk);
    px(x + 3, y - 2, 8, 1, U.shade(r.top, 0.06)); px(x + 18, y + 1, 6, 1, U.shade(r.top, 0.05)); // brushed streaks
    px(x + w / 2, y - 3, 1, 8, U.shade(r.top, -0.18));               // top seam
    px(x + 1, y + 4, w - 2, 1, U.shade(r.top, -0.16));               // top front edge
    wear(x + 2, y - 2, w - 4, 6, 4, U.shade(r.top, -0.10));
    // massive central combination dial on the door (3-tone, turning spokes)
    const cx = x + Math.round(w / 2), cy = y + Math.round((h + 4) / 2) + 2;
    ctx.fillStyle = LINE; ctx.beginPath(); ctx.arc(cx, cy, 9, 0, 6.2832); ctx.fill();
    ctx.fillStyle = r.face; ctx.beginPath(); ctx.arc(cx, cy, 8, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = r.dk; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, 7, 0, 6.2832); ctx.stroke();
    ctx.strokeStyle = r.sheen; ctx.beginPath(); ctx.arc(cx, cy, 8, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); // top-light catch
    ctx.strokeStyle = U.shade(ACC.work, -0.2); ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 6.2832); ctx.stroke();
    ctx.strokeStyle = r.lit; ctx.beginPath();                        // slowly turning spokes
    for (let k = 0; k < 3; k++) { const a = k * Math.PI / 3 + now / 4000; ctx.moveTo(cx - Math.cos(a) * 5, cy - Math.sin(a) * 5); ctx.lineTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5); }
    ctx.stroke();
    px(cx - 1, cy - 1, 2, 2, U.shade(ACC.work, 0.1));                // hub
    glow(cx - 2, cy - 2, 4, 4, ACC.work, 0.18 + 0.08 * Math.sin(now / 600));
    // keypad with cycling digit + secured LED, east of the dial
    inset(x + w - 8, y + 7, 4, 5, '#141b18');
    if (blink(500)) px(x + w - 7, y + 8, 2, 1, ACC.work);
    for (let i = 0; i < 4; i++) px(x + w - 8 + (i % 2) * 2, y + 10 + (i >> 1), 1, 1, U.shade(r.face, -0.1));
    px(x + 2, y + 6, 2, 1, blink(1000) ? ACC.work : U.shade(ACC.work, -0.55));
    // heavy handle west of the dial
    px(cx - 12, cy - 2, 2, 6, r.dk); px(cx - 12, cy - 2, 2, 1, r.lit); px(cx - 12, cy - 2, 1, 6, r.face);
  };

  F.ticker = (x, y, w, h) => {
    box(x, y + 2, w, h + 2, '#1c2a1a');
    px(x + 1, y + 3, w - 2, 1, '#2e3e2a');
    px(x + 1, y + 2, 2, 1, '#3c4e36'); px(x + w - 3, y + 2, 2, 1, '#3c4e36'); // mount lugs
    inset(x + 1, y + 3, w - 2, 6, '#0a1608');
    ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 4, w - 4, 5); ctx.clip();
    const off = Math.floor(now / 200) % 8;
    // dim ghost pass behind the live quote
    ctx.fillStyle = '#2c5218'; ctx.font = '7px monospace';
    ctx.fillText('Q' + (8 - off) + '4' + off + '.. +' + off + '%', x + 3 - off + 14, y + 9);
    ctx.fillStyle = '#9bff4a';
    ctx.fillText('Q' + (8 - off) + '4' + off + '.. +' + off + '%', x + 3 - off, y + 9);
    ctx.restore();
    scanl(x + 2, y + 4, w - 4, 5, 0.14);
    glow(x + 2, y + 4, w - 4, 5, '#9bff4a', 0.05 + 0.02 * Math.sin(now / 700));
    px(x + 1, y + 9, w - 2, 1, '#13200f'); // display divider
    for (let i = 0; i < (w - 6) / 4; i++) { // mini bar chart strip
      const bh = 1 + (U.hash('tk' + i) % 2);
      const red = i % 4 === 3;
      px(x + 3 + i * 4, y + h + 2 - bh, 2, bh, red ? '#ff5c5c' : '#41ff8a');
      px(x + 3 + i * 4, y + h + 2 - bh, 1, 1, red ? '#ff8a8a' : '#8affb8'); // bar cap
    }
    px(x + 1, y + 2, 1, 1, blink(700) ? '#9bff4a' : '#1c2a1a');
    rivets(x + 1, y + 3, w - 2, h + 1, '#3c4e36', '#0e160c');
  };

  F.safe = (x, y, w, h, f) => {   // TALL 3/4 armored safe (1x2), bolted; combo dial; ACC.work green (files)
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);                                 // floor contact
    deckPlate(x - 1, y + h - 5, w + 2, 5);                            // bolted plate at feet
    deckSocket(x + w + 1, y + h - 3, f && f.work);
    // TALL armored body: chamfered slab, lit W / dark E
    rr(x - 1, y - 3, w + 2, h + 2, LINE);
    px(x + 1, y - 1, w - 2, h, r.face);
    px(x + 1, y - 1, 1, h, U.shade(r.face, 0.10)); px(x + w - 2, y - 1, 1, h, r.dk);
    rr(x, y - 5, w, 3, LINE);                                         // heavy top cap
    px(x + 1, y - 4, w - 2, 2, r.top); px(x + 1, y - 4, w - 2, 1, r.sheen);
    px(x + 2, y - 3, 3, 1, U.shade(r.sheen, 0.12));
    // recessed armored door with a thick frame + corner rivets
    const doorX = x + 2, doorY = y + 1, doorW = w - 4, doorH = h - 4;
    inset(doorX, doorY, doorW, doorH, U.shade(r.face, -0.22));
    rivets(doorX + 1, doorY + 1, doorW - 2, doorH - 2, r.sheen, r.ao);
    // brand/keypad plate near the top of the door
    inset(doorX + 1, doorY + 1, doorW - 2, 3, '#141b18');
    const kp = blink(900);
    px(doorX + 2, doorY + 2, 2, 1, kp ? ACC.work : U.shade(ACC.work, -0.55));
    if (kp) glow(doorX + 1, doorY + 1, 4, 3, ACC.work, 0.4);
    // big central combination dial (3-tone) with a lit crown catch
    const cx = x + Math.round(w / 2), cy = y + Math.round(h / 2) + 1;
    ctx.fillStyle = LINE; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 6.2832); ctx.fill();
    ctx.fillStyle = r.face; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = r.sheen; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, 4, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); // top-light catch
    ctx.strokeStyle = r.ao; ctx.beginPath();                         // slowly turning spokes
    for (let k = 0; k < 3; k++) { const a = k * Math.PI / 3 + now / 4000; ctx.moveTo(cx - Math.cos(a) * 3, cy - Math.sin(a) * 3); ctx.lineTo(cx + Math.cos(a) * 3, cy + Math.sin(a) * 3); }
    ctx.stroke();
    px(cx - 1, cy - 1, 2, 2, U.shade(ACC.work, 0.1));                // dial hub
    glow(cx - 2, cy - 2, 4, 4, ACC.work, 0.14 + 0.06 * Math.sin(now / 600));
    // heavy handle east of the dial
    px(cx + 4, cy - 2, 2, 5, r.dk); px(cx + 4, cy - 2, 2, 1, r.lit);
    // secured LED + vents low on the door
    px(doorX + 1, doorY + doorH - 2, 2, 1, blink(1000) ? ACC.work : U.shade(ACC.work, -0.55));
    for (let i = 0; i < 3; i++) px(cx - 3, doorY + doorH - 4 + i, 6, 1, i % 2 ? U.shade(r.face, 0.06) : r.ao);
    px(x + 1, y + h - 2, w - 2, 1, r.ao);                             // floor-line AO
  };

  F.goldcrate = (x, y, w, h) => {
    // TOP-BIAS OBLIQUE treasury crate (F.crate construction) with gold ACC.flow accents + lock.
    const r = RAMP.steel, cw = w, gold = ACC.flow;
    shadow2(x + 1, y + h - 1, cw - 2);
    // short ribbed front face
    rr(x, y + 3, cw, h - 4, LINE);
    px(x + 1, y + 4, cw - 2, h - 6, r.face);
    for (let i = 1; i < (cw - 2) / 6; i++) {
      px(x + 1 + i * 6, y + 4, 1, h - 6, r.ao);            // ribs cut deep
      px(x + 2 + i * 6, y + 4, 1, h - 6, U.shade(r.face, 0.16));
    }
    px(x + 1, y + 4, 2, 2, r.sheen); px(x + cw - 3, y + 4, 2, 2, r.sheen); // corner braces
    px(x + 1, y + h - 4, 2, 2, r.dk); px(x + cw - 3, y + h - 4, 2, 2, r.dk);
    // gold banding straps across the face (treasury identity)
    px(x + 4, y + 4, 1, h - 6, U.shade(gold, -0.25)); px(x + 5, y + 4, 1, h - 6, gold);
    px(x + cw - 6, y + 4, 1, h - 6, U.shade(gold, -0.25)); px(x + cw - 5, y + 4, 1, h - 6, gold);
    glow(x + 5, y + 4, 1, h - 6, gold, 0.18); glow(x + cw - 5, y + 4, 1, h - 6, gold, 0.18);
    px(x + 1, y + h - 3, cw - 2, 1, r.ao);                 // floor-line AO
    // the lid dominates: big rounded gold-stencilled top
    rr(x - 1, y - 3, cw + 2, 9, LINE);
    rr(x, y - 2, cw, 7, r.top);
    px(x + 1, y - 2, cw - 2, 1, r.sheen);
    px(x, y - 1, 1, 5, r.lit); px(x + cw - 1, y - 1, 1, 5, r.dk);
    px(x + Math.floor(cw / 2), y - 1, 1, 5, U.shade(r.top, -0.20)); // lid seam
    // gold bullion-mark stencil + sparkle on the lid
    px(x + 4, y, 5, 2, U.shade(gold, -0.20)); px(x + 5, y, 3, 1, gold);
    glow(x + 4, y - 1, 5, 3, gold, 0.14 + 0.06 * Math.sin(now / 900));
    if (blink(1300, x)) px(x + 5 + (U.hash('gc' + x) % 3), y, 1, 1, '#fffbe8'); // sparkle
    px(x + 1, y + 4, cw - 2, 1, U.shade(r.top, -0.16));         // lid front edge
    // heavy padlock hasp centred on the lid front, with a secured LED
    const lx = x + Math.floor(cw / 2) - 2;
    px(lx, y + 4, 4, 3, '#1e262c'); px(lx, y + 4, 4, 1, '#3a444c'); // hasp body
    px(lx + 1, y + 3, 2, 1, U.shade(gold, -0.30));             // shackle
    px(lx + 1, y + 5, 1, 1, blink(1100) ? '#9bff4a' : '#1c3a14'); // secured LED
    px(x + 2, y - 2, 1, 1, '#8693a0');                          // rivet glint
    wear(x + 2, y - 1, cw - 4, 5, 3, U.shade(r.top, -0.10));
    // skid rails on the floor
    px(x + 2, y + h - 1, 3, 1, r.dk); px(x + cw - 5, y + h - 1, 3, 1, r.dk);
  };

  F.chartwall = (x, y, w, h) => {
    box(x, y + 2, w, h + 2, '#2e2026');
    px(x + 1, y + 3, w - 2, 1, '#3e2c34');
    rivets(x + 1, y + 3, w - 2, h, '#54404a', '#181014');
    const pw = Math.floor((w - 6) / 3) - 2;
    for (let i = 0; i < 3; i++) {
      const px0 = x + 3 + i * (pw + 2);
      inset(px0, y + 3, pw, 8, '#1a1218');
      px(px0 + 1, y + 3, 3, 1, i === 1 ? '#ff5c7a' : '#a0a8ff'); // panel color tab
      for (let gx = 0; gx < pw - 2; gx += 4) px(px0 + 1 + gx, y + 8, 1, 1, '#241a20'); // grid
      px(px0 + 1, y + 5, pw - 2, 1, '#221820'); // mid gridline
      // dim echo trace behind the live one
      ctx.strokeStyle = '#3a2832'; ctx.lineWidth = 1; ctx.beginPath();
      for (let j = 0; j < pw - 2; j++) {
        const yy = y + 9 - (U.hash('ch' + i + ((j + 3) >> 1)) % 5);
        j ? ctx.lineTo(px0 + 1 + j, yy) : ctx.moveTo(px0 + 1 + j, yy);
      }
      ctx.stroke();
      ctx.strokeStyle = i === 1 ? '#ff5c7a' : '#a0a8ff'; ctx.beginPath();
      for (let j = 0; j < pw - 2; j++) {
        const yy = y + 9 - (U.hash('ch' + i + (j >> 1)) % 5) - (i === 1 && j > pw - 6 ? -2 : 0);
        j ? ctx.lineTo(px0 + 1 + j, yy) : ctx.moveTo(px0 + 1 + j, yy);
      }
      ctx.stroke();
      px(px0 + pw - 3, y + 4 + (Math.floor(now / 400 + i) % 4), 1, 1, i === 1 ? '#ff5c7a' : '#a0a8ff'); // live tick
      glow(px0, y + 3, pw, 8, i === 1 ? '#ff5c7a' : '#a0a8ff', 0.04); // panel cast
      if (i < 2) px(px0 + pw + 0, y + 5, 1, 4, '#1c1218'); // inter-panel conduit
    }
    seamH(x + 1, y + h + 1, w - 2, '#2e2026');
  };

  F.wartable = (x, y, w, h) => {
    sh(x + 3, y + h - 1, w - 6);
    box(x + 2, y + 1, w - 4, h - 1, '#33222a');
    px(x + 3, y + 2, w - 6, 1, '#46303a');
    px(x + 3, y + 3, 1, h - 5, '#3e2a34'); px(x + w - 4, y + 3, 1, h - 5, '#231219'); // rim facets
    // corner posts with status studs
    for (const [cx2, cy2] of [[x + 3, y + 2], [x + w - 5, y + 2], [x + 3, y + h - 4], [x + w - 5, y + h - 4]]) {
      px(cx2, cy2, 2, 2, '#46303a');
      px(cx2, cy2, 1, 1, blink(800, cx2 + cy2) ? '#ff5c7a' : '#52303c');
    }
    inset(x + 4, y + 2, w - 8, h - 4, '#1a1016');
    for (let gx = 8; gx < w - 10; gx += 8) px(x + 2 + gx, y + 3, 1, h - 6, '#241620'); // grid
    for (let gy = 4; gy < h - 5; gy += 4) px(x + 5, y + 2 + gy, w - 10, 1, '#241620');
    // sector coordinate dashes along the top of the map
    for (let gx = 8; gx < w - 12; gx += 8) px(x + 3 + gx, y + 3, 3, 1, '#3a2030');
    const a = 0.5 + 0.3 * Math.sin(now / 500);
    for (let i = 0; i < 5; i++) { // threat blips + expanding pulse rings
      const bx = x + 8 + i * 9, by = y + 5 + (i % 3) * 4;
      ctx.globalAlpha = a; px(bx, by, 2, 2, '#ff5c7a');
      px(bx, by, 1, 1, '#ffb0c0'); // blip core
      const r = ((now / 600 + i * 0.4) % 1) * 4;
      ctx.strokeStyle = '#ff5c7a'; ctx.globalAlpha = a * (1 - r / 4);
      ctx.beginPath(); ctx.arc(bx + 1, by + 1, r + 1, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // targeting reticle stepping between blips
    const tgt = Math.floor(now / 2400) % 5;
    const tx2 = x + 8 + tgt * 9, ty2 = y + 5 + (tgt % 3) * 4;
    if (blink(300)) {
      px(tx2 - 2, ty2 - 2, 2, 1, '#ffd34a'); px(tx2 + 2, ty2 - 2, 2, 1, '#ffd34a');
      px(tx2 - 2, ty2 + 3, 2, 1, '#ffd34a'); px(tx2 + 2, ty2 + 3, 2, 1, '#ffd34a');
    }
    glow(x + 5 + ((now / 25) % (w - 12)), y + 3, 1, h - 6, '#ff8ba0', 0.35); // radar sweep
    glow(x + 4, y + 2, w - 8, h - 4, '#ff5c7a', 0.04 + 0.02 * Math.sin(now / 800)); // table haze
    // edge control strips
    px(x + 7, y + h - 3, 6, 1, '#241218');
    for (let i = 0; i < 3; i++) px(x + 8 + i * 2, y + h - 3, 1, 1, blink(500, i) ? '#ff5c7a' : '#3a2030');
    px(x + w - 13, y + h - 3, 6, 1, '#241218');
    for (let i = 0; i < 3; i++) px(x + w - 12 + i * 2, y + h - 3, 1, 1, blink(700, i + 4) ? '#ffd34a' : '#3a3020');
  };

  F.calwall = (x, y, w, h) => {
    box(x, y + 2, w, h + 2, '#2e3840');
    px(x + 1, y + 3, w - 2, 1, '#3e4a52');
    rivets(x + 1, y + 3, w - 2, h, '#54626c', '#161e24');
    const prog = (now / 1400) % 14;
    for (let i = 0; i < 7; i++) for (let j = 0; j < 2; j++) {
      const idx = i + j * 7;
      const lit = idx < prog;
      const wknd = i > 4; // weekend columns tinted
      inset(x + 2 + i * 15, y + 3 + j * 5, 13, 5, lit ? (wknd ? '#42434e' : '#3a4750') : (wknd ? '#26262e' : '#222a30'));
      if (lit) {
        px(x + 3 + i * 15, y + 4 + j * 5, 7, 1, '#ffe066');
        px(x + 3 + i * 15, y + 4 + j * 5, 2, 1, '#fff4c0'); // entry highlight
        px(x + 11 + i * 15, y + 6 + j * 5, 2, 1, '#41ff8a'); // done check
      }
      if (Math.floor(prog) === idx) {
        if (blink(400)) px(x + 3 + i * 15, y + 6 + j * 5, 4, 1, '#fff4c0'); // today cursor
        px(x + 2 + i * 15, y + 3 + j * 5, 13, 1, '#ffe066'); // today ring top
        px(x + 2 + i * 15, y + 7 + j * 5, 13, 1, '#8a7a34');
      }
      px(x + 10 + i * 15, y + 4 + j * 5, 2, 1, '#2e3840'); // date notch
    }
    seamH(x + 1, y + h + 1, w - 2, '#2e3840');
  };

  F.tube = (x, y, w, h) => {
    box(x + 1, y, w - 2, h + 6, '#36424c');
    px(x + 2, y + 1, w - 4, 1, '#46525a');
    inset(x + 3, y + 1, w - 6, 5, '#1a2228');
    glow(x + 4, y + 2, 2, 3, '#fffbe0', 0.12); // glass highlight
    px(x + 4, y + 5, w - 8, 1, '#222e36'); // tube floor shading
    const ph = (now / 900) % 1;
    if (ph < 0.4) {
      const capx = x + 4 + Math.floor(ph / 0.4 * (w - 11));
      px(capx, y + 2, 3, 2, '#ffe066'); // capsule whoosh
      px(capx - 1, y + 2, 1, 2, '#8a7a34'); px(capx - 2, y + 3, 1, 1, '#5a5024'); // speed lines
      px(capx, y + 2, 1, 1, '#fff4c0'); // nose shine
    } else if (ph < 0.45 && blink(80)) {
      px(x + w - 8, y + 2, 2, 2, '#fff4c0'); // arrival flash
    }
    px(x + 2, y, w - 4, 1, '#56646e'); px(x + 2, y + 6, w - 4, 1, '#56646e'); // brass fittings
    px(x + 2, y, 1, 1, '#6e7c86'); px(x + w - 3, y + 6, 1, 1, '#3a444c'); // fitting shine/shade
    for (let i = 1; i < (w - 4) / 8; i++) { px(x + 2 + i * 8, y, 1, 1, '#3a444c'); px(x + 2 + i * 8, y + 6, 1, 1, '#3a444c'); } // pipe clamps
    for (let i = 0; i < 2; i++) px(x + 3 + i * (w - 8), y + 8, 2, 2, blink(800, i) ? '#ffe066' : '#2e3840');
    // pressure gauge with wobbling needle
    px(x + w / 2 - 2, y + 8, 4, 3, '#28323a'); px(x + w / 2 - 2, y + 8, 4, 1, '#3a464e');
    px(x + w / 2 - 1 + Math.round(Math.sin(now / 400)), y + 9, 1, 1, '#ffe066');
    px(x + 2, y + h + 4, w - 4, 2, '#28323a'); // base plate
    px(x + 2, y + h + 4, w - 4, 1, '#343f47');
    px(x + 4, y + h + 5, 2, 1, '#1c242a'); px(x + w - 6, y + h + 5, 2, 1, '#1c242a'); // base vents
  };

  F.parcels = (x, y, w, h) => {
    // TALL 3/4 leaning tower of stacked parcels: BOLD offset stacking on a 1x2 footprint.
    const cw = w, floorY = y + h - 1;
    shadow2(x + 1, floorY, cw - 2);
    // one parcel: rounded box, dominant lid (2px) + face; drawn with (bx,fb)=front-base-left corner.
    const parcel = (bx, fb, bw, fh, ramp, tint) => {
      const ty = fb - fh;
      rr(bx, ty, bw, fh, LINE);
      // front face
      px(bx + 1, ty + 2, bw - 2, fh - 3, ramp.face);
      px(bx + 1, ty + 2, 1, fh - 3, ramp.lit);                  // west lit edge
      px(bx + bw - 2, ty + 2, 1, fh - 3, ramp.dk);              // east dark edge
      px(bx + 1, fb - 1, bw - 2, 1, ramp.ao);                   // base AO
      // lid slab (top-bias)
      px(bx + 1, ty + 1, bw - 2, 2, ramp.top);
      px(bx + 1, ty + 1, bw - 2, 1, ramp.sheen);                // back edge sheen
      px(bx + 1, ty + 1, 3, 1, U.shade(ramp.sheen, 0.14));      // west streak
      // cross-strap (bold) + priority tab
      px(bx + Math.floor(bw / 2) - 1, ty + 2, 2, fh - 3, U.shade(ramp.face, 0.16)); // vertical tape
      px(bx + 1, ty + 4, bw - 2, 1, U.shade(ramp.face, -0.20));                     // horizontal tape shade
      px(bx + 2, ty + 3, 3, 1, '#dfe8df');                      // shipping label
      px(bx + bw - 4, ty + 1, 2, 1, tint);                      // bold color tab on the lid
      px(bx + bw - 4, ty + 3, 2, 1, U.shade(tint, -0.2));       // sticker on the face
    };
    // base (widest) flush to floor, then tiers narrow & LEAN alternately (bold 2px offsets)
    parcel(x + 0, floorY, cw + 0, 8, RAMP.steel, ACC.flow);      // base carton, full width
    parcel(x + 2, floorY - 8, cw - 3, 7, RAMP.fabric, ACC.data); // middle, leaning EAST
    parcel(x - 1, floorY - 15, cw - 4, 6, RAMP.steel, ACC.alert);// upper, leaning WEST (juts past footprint)
    // small crowning parcel catching the most light
    const tb = floorY - 21, tx = x + 2;
    rr(tx, tb - 5, 7, 5, LINE);
    px(tx + 1, tb - 3, 5, 2, RAMP.fabric.face); px(tx + 1, tb - 3, 1, 2, RAMP.fabric.lit);
    px(tx + 1, tb - 4, 5, 2, RAMP.fabric.top); px(tx + 1, tb - 4, 5, 1, RAMP.fabric.sheen);
    px(tx + 4, tb - 3, 1, 1, ACC.work);                         // sticker
    // secured-strap glint travelling down the stack
    if (blink(1400, x)) px(x + Math.floor(cw / 2), floorY - 11, 1, 1, '#fff4c8');
    px(x + Math.floor(cw / 2) - 1, floorY, 3, 1, U.shade(RAMP.steel.face, -0.22)); // base scuff
  };

  F.core = (x, y, w, h, f) => {   // TALL 3/4 memory core (1x2), bolted; cylindrical glowing column; ACC.mem purple
    const r = RAMP.steel, cx = x + Math.round(w / 2);
    shadow2(x + 1, y + h - 1, w - 2);                                 // floor contact
    deckPlate(x - 1, y + h - 5, w + 2, 5);                            // bolted plate at feet
    deckSocket(x + w + 1, y + h - 3, f && f.work);
    // cylindrical housing: dark caps top & bottom + a tall barrel with side facets
    const bx = x + 2, bw = w - 4, colTop = y - 1, colBot = y + h - 4;
    rr(bx - 1, colTop - 2, bw + 2, colBot - colTop + 4, LINE);
    px(bx, colTop, bw, colBot - colTop, r.face);
    px(bx, colTop, 1, colBot - colTop, r.lit);                       // west sheen
    px(bx + 1, colTop, 1, colBot - colTop, U.shade(r.face, 0.06));
    px(bx + bw - 1, colTop, 1, colBot - colTop, r.dk);               // east shade
    // heavy top cap (we look down on it) + bottom cap
    rr(bx - 1, colTop - 3, bw + 2, 3, LINE);
    px(bx, colTop - 2, bw, 2, r.top); px(bx, colTop - 2, bw, 1, r.sheen);
    px(bx, colBot, bw, 2, U.shade(r.face, -0.24)); px(bx, colBot + 1, bw, 1, r.ao);
    px(bx + 1, colBot, 1, 1, r.dk); px(bx + bw - 2, colBot, 1, 1, r.dk);
    // central glowing memory column — ACC.mem purple pulse (preserved behavior)
    const g = 0.55 + 0.35 * Math.sin(now / 350);
    const gx = cx - 2, gTop = colTop + 1, gLen = colBot - colTop - 2;
    inset(gx, gTop, 4, gLen, '#12081c');                             // recessed glass well
    glow(gx - 1, gTop, 6, gLen, ACC.mem, 0.28 + 0.22 * g);           // soft outer bloom, continuous
    px(gx + 1, gTop, 2, gLen, U.shade(ACC.mem, 0.15 + 0.2 * g));     // lit plasma body
    px(cx, gTop, 1, gLen, '#e8d6ff');                                // white-hot core line, unbroken
    for (let i = 0; i < 3; i++) {                                     // rising energy motes
      const ph = (now / (800 + i * 230) + i * 0.5) % 1;
      px(cx - 1 + (i % 2), gTop + Math.floor((1 - ph) * (gLen - 2)), 1, 1, '#f9f2ff');
    }
    // containment cage rings across the column — thin 1px hoops, sit IN FRONT without killing the glow
    for (let ri = 0; ri < 5; ri++) {
      const ry = gTop + 2 + ri * Math.floor((gLen - 2) / 5);
      px(gx - 1, ry, 6, 1, U.shade(r.face, -0.28));                  // dark hoop
      px(gx - 1, ry, 1, 1, r.lit); px(gx + 4, ry, 1, 1, r.dk);       // hoop end catches
    }
    glow(gx - 1, colTop - 2, 6, 3, ACC.mem, g * 0.4);                // heat shimmer at the crown
    // base vents + containment LED
    px(bx + 1, colBot + 1, 2, 1, '#101a22'); px(bx + bw - 3, colBot + 1, 2, 1, '#101a22');
    px(bx, colBot + 2, 1, 1, blink(600) ? ACC.mem : U.shade(ACC.mem, -0.55));
  };

  F.shelf = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE storage shelf (4x1): big top + binned face; bolted; ACC.work green
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);                                 // floor contact
    deckPlate(x - 1, y + h - 4, w + 2, 4);                            // bolted plate
    deckSocket(x + w + 1, y + h - 3, f && f.work);
    for (const lx of [x + 2, x + Math.floor(w / 2) - 1, x + w - 5]) { // legs along the long footprint
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // short front face: a row of storage bins with green data labels
    rr(x - 1, y + 2, w + 2, h - 3, LINE);
    px(x, y + 3, w, h - 5, r.face);
    px(x, y + 3, w, 1, r.lit);
    const nbin = Math.floor((w - 2) / 6);
    for (let i = 0; i < nbin; i++) {
      const bx = x + 2 + i * 6;
      inset(bx, y + 4, 5, h - 7, U.shade(r.face, -0.18));            // bin recess
      px(bx + 1, y + 5, 3, 1, U.shade(r.face, 0.06));                // bin face catch
      const on = blink(700 + i * 90, i);                             // per-bin status label — ACC.work
      px(bx + 1, y + h - 4, 3, 1, on ? ACC.work : U.shade(ACC.work, -0.6));
      if (on) glow(bx, y + h - 5, 5, 2, ACC.work, 0.14);
    }
    px(x, y + h - 3, w, 1, r.ao);                                     // floor-line AO
    // big rounded TOP surface (dominant), with folder tabs sitting on it
    rr(x - 1, y - 3, w + 2, 6, LINE);
    rr(x, y - 2, w, 5, r.top);
    px(x + 1, y - 2, w - 2, 1, r.sheen);
    px(x, y - 1, 1, 3, r.lit); px(x + w - 1, y - 1, 1, 3, r.dk);
    for (let i = 0; i < 4; i++) px(x + 4 + i * 9, y - 1, 5, 1, U.shade(r.top, 0.05)); // brushed streaks
    // a couple of green-tabbed file folders resting on the deck
    for (const fx of [x + 6, x + Math.floor(w * 0.55)]) { px(fx, y - 1, 6, 2, U.shade(r.top, -0.06)); px(fx + 1, y - 1, 2, 1, ACC.work); }
    px(x + 1, y + 2, w - 2, 1, U.shade(r.top, -0.16));               // top front edge
    wear(x + 2, y - 1, w - 4, 3, 4, U.shade(r.top, -0.10));
    if (f && f.work) glow(x, y + 3, w, h - 5, ACC.work, 0.05 + 0.03 * Math.sin(now / 500));
  };

  F.bar = (x, y, w, h) => {
    sh(x + 1, y + h + 2, w - 2);
    box(x, y + 1, w, h + 2, '#363f47');
    px(x, y + 1, w, 2, '#4a5660');
    px(x, y + 1, w, 1, '#5c6a74');
    for (let i = 0; i < w / 7; i++) px(x + 3 + i * 7, y + 2, 3, 1, '#56646e'); // brushed sheen
    px(x, y + 4, w, 1, '#222a30'); // counter edge
    glow(x + 1, y + 5, w - 2, 1, '#5ad1b3', 0.16 + 0.06 * Math.sin(now / 700)); // under-counter accent
    seamH(x + 1, y + 7, w - 2, '#363f47'); // front panel seam
    for (let i = 1; i < w / 16; i++) px(x + i * 16, y + 5, 1, h - 3, '#2c343c'); // panel dividers
    px(x + 1, y + h + 1, w - 2, 1, '#8a98a8'); // steel foot rail
    px(x + 1, y + h + 2, w - 2, 1, '#3e4a52'); // rail shadow
    // beer tap with drip
    px(x + w / 2 - 6, y + 2, 1, 3, '#aab8c8'); px(x + w / 2 - 6, y + 1, 2, 1, '#caa84a');
    if ((now % 2400) < 200) px(x + w / 2 - 6, y + 5, 1, 1, '#ffd9a0'); // drip
    px(x + 4, y + 4, 3, 3, '#8a98a8'); px(x + 4, y + 4, 3, 1, '#caa84a'); px(x + 4, y + 4, 1, 3, '#aab8c8'); // can
    px(x + w - 9, y + 3, 2, 4, '#7adfd0'); px(x + w - 9, y + 2, 2, 1, '#3a6a62'); px(x + w - 9, y + 3, 1, 4, '#bffff2'); // glass bottle
    // upside-down glasses drying near the tap
    px(x + w / 2 + 2, y + 3, 2, 2, '#9ab8c8'); px(x + w / 2 + 5, y + 3, 2, 2, '#9ab8c8');
    px(x + w / 2 + 2, y + 4, 2, 1, '#6a8898'); px(x + w / 2 + 5, y + 4, 2, 1, '#6a8898');
    px(x + w / 2 - 2, y + 5, 4, 2, '#222a26'); // bar mat
    px(x + w / 2 - 2, y + 5, 4, 1, '#2c362f');
    px(x + w / 2 + 8, y + 4, 3, 2, '#dfe8df'); // napkin
    wear(x + 1, y + 2, w - 2, 2, 4, '#414c55'); // counter scuffs
  };

  F.stool = (x, y) => {
    ctx.globalAlpha = 0.18; px(x + 3, y + 10, 7, 2, '#000'); ctx.globalAlpha = 1;
    px(x + 3, y + 4, 6, 3, '#3a444c');
    px(x + 3, y + 4, 6, 1, '#4e5a64');
    px(x + 4, y + 4, 4, 1, '#2f6a62'); px(x + 4, y + 4, 2, 1, '#4a8a82'); // cushion pad
    px(x + 4, y + 5, 1, 1, '#26554e'); px(x + 7, y + 5, 1, 1, '#26554e'); // piping stitches
    px(x + 3, y + 6, 6, 1, '#2c343c'); // seat rim shade
    px(x + 5, y + 7, 2, 1, '#39434b'); // gas lift collar
    px(x + 4, y + 7, 1, 4, '#46535c'); px(x + 7, y + 7, 1, 4, '#46535c'); // chrome legs
    px(x + 4, y + 7, 1, 1, '#5e6c76'); px(x + 7, y + 7, 1, 1, '#5e6c76'); // leg shine
    px(x + 4, y + 10, 4, 1, '#2a3138'); // foot ring
    px(x + 5, y + 11, 2, 1, '#1e252b'); // ring shadow
  };

  F.tv = (x, y, w, h, f) => {
    px(x - 1, y, w + 2, h + 6, '#0a0a0a');
    px(x, y + 1, w, h + 4, '#1a1a1a');
    px(x, y + 1, w, 1, '#2e2e2e');
    px(x, y + 2, 1, h + 2, '#242424'); px(x + w - 1, y + 2, 1, h + 2, '#101010'); // bezel facets
    const mode = Math.floor(now / 4000) % 3;
    if (mode === 0) { // static
      px(x + 2, y + 2, w - 4, h + 1, '#101418');
      for (let i = 0; i < 30; i++) px(x + 2 + (U.hash('tv' + i + Math.floor(now / 90)) % (w - 4)), y + 2 + (U.hash('tw' + i + Math.floor(now / 90)) % (h + 1)), 1, 1, '#9aa');
      px(x + 2, y + 2 + (Math.floor(now / 130) % (h + 1)), w - 4, 1, '#202830'); // rolling bar
    } else if (mode === 1) { // movie: sunset over water
      px(x + 2, y + 2, w - 4, h + 1, '#1a3a5a'); px(x + 2, y + 2, w - 4, 2, '#2a5a7a');
      px(x + 5, y + 3, 6, 2, '#e8c860'); px(x + 6, y + 2, 4, 1, '#f0d880'); // sun dome
      px(x + 5, y + 6, 6, 1, '#8a7a4a'); px(x + 6, y + 8, 4, 1, '#6a6038'); // water glints
      px(x + 20, y + 5, 8, 3, '#0e2436');
      px(x + 20, y + 5, 8, 1, '#16344a'); // island rim light
    } else { // news: anchor + headlines
      px(x + 2, y + 2, w - 4, h + 1, '#3a1a2a');
      px(x + 4, y + 2, 8, 1, '#4a2436'); // studio backdrop band
      px(x + 5, y + 3, 5, 5, '#caa088'); px(x + 6, y + 4, 1, 1, '#222'); px(x + 8, y + 4, 1, 1, '#222');
      px(x + 6, y + 6, 3, 1, '#a08068'); // mouth shadow
      px(x + 5, y + 8, 5, 1, '#2a3a5a'); // suit
      px(x + 12, y + 4, 12, 1, '#e0e0e0'); px(x + 12, y + 6, 9, 1, '#b0b0b0');
      px(x + 12, y + 4, 4, 1, '#ffffff'); // headline pop
      px(x + 2, y + h + 1, w - 4, 2, '#2a1220'); px(x + 3 + (Math.floor(now / 160) % (w - 16)), y + h + 1, 10, 1, '#ff5c7a'); // crawling ticker
      px(x + w - 8, y + 2, 4, 2, '#ff5c7a'); px(x + w - 7, y + 2, 2, 1, '#ffa8b8'); // LIVE bug
    }
    scanl(x + 2, y + 2, w - 4, h + 1, 0.08);
    glow(x + 2, y + 2, 6, 2, '#ffffff', 0.06); // glass glint
    const watched = !!(f && f.work);   // an agent is on the couch watching → screen spills more light, LED goes solid
    glow(x + 2, y + h + 5, w - 4, 2, mode === 1 ? '#2a5a7a' : '#3a1a2a', watched ? 0.30 : 0.15); // screen light under tv
    px(x + 1, y + h + 5, w - 2, 1, '#000');
    px(x + 8, y + h + 5, w - 16, 1, '#1c1c1c'); // soundbar
    px(x + 10, y + h + 5, 1, 1, '#2e2e2e'); px(x + w - 11, y + h + 5, 1, 1, '#2e2e2e');
    px(x + w - 3, y + h + 4, 1, 1, watched ? '#ff6a6a' : (blink(1400) ? '#ff3030' : '#3a1010')); // standby LED (solid when watched)
  };

  F.couch = (x, y, w, h) => {   // TOP-BIAS OBLIQUE lounge sofa, freestanding (locked style law)
    const r = RAMP.fabric;
    shadow2(x + 1, y + h - 1, w - 2);                            // floor contact
    for (const lx of [x + 3, x + Math.floor(w / 2) - 1, x + w - 6]) { // stub legs
      px(lx, y + 10, 3, 2, LINE); px(lx, y + 10, 1, 2, r.lit); px(lx + 1, y + 10, 1, 2, r.dk);
    }
    underAO(x + 6, y + 10, w - 12, 1);                           // gap under the seat
    // backrest: rounded lit cap + short upholstered face
    rr(x + 1, y - 4, w - 2, 8, LINE);
    px(x + 2, y - 3, w - 4, 2, r.lit);                           // cap catches the light
    px(x + 2, y - 3, 8, 1, U.shade(r.lit, 0.10));
    px(x + 2, y - 1, w - 4, 4, r.face);
    for (let i = 1; i < (w - 4) / 14; i++) px(x + 2 + i * 14, y - 1, 1, 4, r.dk); // back seams
    wear(x + 2, y - 1, w - 4, 4, 5, U.shade(r.face, -0.08));
    // arms: rounded caps that wrap above the back line and drop to the floor
    for (const ax of [x, x + w - 4]) {
      rr(ax - 1, y - 3, 6, h + 2, LINE);
      px(ax, y - 2, 4, h - 1, r.face);
      px(ax, y - 2, 4, 2, r.lit); px(ax, y - 2, 3, 1, U.shade(r.lit, 0.10)); // arm cap
      px(ax === x ? ax : ax + 3, y, 1, h - 4, ax === x ? U.shade(r.face, 0.10) : r.dk); // outer facet
      px(ax, y + h - 4, 4, 1, r.ao);                             // arm base AO
    }
    // seat: big visible cushion tops, then a short front lip
    px(x + 4, y + 3, w - 8, 4, U.shade(r.top, 0.05));
    px(x + 4, y + 3, w - 8, 1, r.lit);
    for (let i = 1; i < (w - 8) / 13; i++) {
      px(x + 4 + i * 13, y + 3, 1, 4, r.dk);                     // cushion seams
      px(x + 4 + i * 13 - 5, y + 4, 4, 1, U.shade(r.lit, 0.06)); // cushion sheen
    }
    wear(x + 4, y + 3, w - 8, 4, 5, U.shade(r.top, -0.08));
    px(x + 4, y + 7, w - 8, 2, r.face);                          // seat front lip
    px(x + 4, y + 7, w - 8, 1, U.shade(r.face, 0.10));
    px(x + 5, y + 8, w - 10, 1, r.ao);
    // throw pillows tucked against each arm
    px(x + 6, y, 5, 4, '#2f6a62'); px(x + 6, y, 5, 1, '#4a8a82'); px(x + 10, y + 3, 1, 1, '#26554e');
    px(x + w - 11, y, 5, 4, '#8a6a3a'); px(x + w - 11, y, 5, 1, '#caa84a'); px(x + w - 7, y + 3, 1, 1, '#6a5230');
  };

  F.arcade = (x, y, w, h, f) => {   // TALL 3/4 cabinet (locked style law): rises above its footprint, may occlude
    const cw = 13, bh = h, r = RAMP.steel;
    shadow2(x + 1, y + bh - 1, cw - 2);                         // floor contact
    // body: chamfered slab, side facets
    rr(x - 1, y - 5, cw + 2, bh + 4, LINE);
    px(x + 1, y - 3, cw - 2, bh + 1, r.face);
    px(x + 1, y - 3, 1, bh, U.shade(r.face, 0.10)); px(x + cw - 2, y - 3, 1, bh, r.dk);
    // cap: the top surface we look down on
    rr(x, y - 7, cw, 3, LINE);
    px(x + 1, y - 6, cw - 2, 2, r.top);
    px(x + 1, y - 6, cw - 2, 1, r.sheen);
    // marquee JUTS out wider than the body
    rr(x - 2, y - 5, cw + 4, 4, LINE);
    px(x - 1, y - 4, cw + 2, 2, blink(700) ? ACC.lounge : '#3a2a3a');
    px(x + 2, y - 4, 3, 1, '#ffd0ee');                          // marquee title glint
    glow(x - 1, y - 4, cw + 2, 2, ACC.lounge, blink(700) ? 0.45 : 0.12);
    px(x - 1, y - 2, cw + 2, 1, U.shade('#3a2a3a', -0.35));     // marquee underside shadow
    px(x + 1, y + 2, 1, bh - 10, ACC.lounge);                   // side art stripe
    px(x + 1, y + 3, 1, 2, '#ffa8e8');
    // screen: recessed, tilted back into the cabinet
    inset(x + 2, y - 1, cw - 4, 9, '#0c0a16');
    const fr = Math.floor(now / 280) % 4;
    for (let i = 0; i < 3; i++) px(x + 3 + i * 2, y, 1, 1, '#1c1830'); // starfield
    px(x + 4 + (fr % 3), y + 1, 2, 2, '#41ff8a');               // player
    px(x + 4 + (fr % 3), y, 1, 1, '#8affb8');                   // player cannon
    for (let i = 0; i < 3; i++) px(x + 3 + i * 2 + (fr & 1), y + 5, 1, 1, '#ff5c5c'); // marching enemies
    if (fr === 2) px(x + 6, y + 3, 1, 1, '#ffd34a');            // shot
    scanl(x + 2, y, cw - 4, 8, 0.12);
    glow(x + 2, y - 1, cw - 4, 9, '#41ff8a', 0.06);
    // control deck JUTS toward the camera: lit top + front lip
    rr(x - 1, y + 9, cw + 2, 4, LINE);
    px(x, y + 10, cw, 2, r.top);
    px(x, y + 10, cw, 1, r.sheen);
    px(x + 3, y + 11, 1, 1, '#ff5c5c');                         // red button
    px(x + 5, y + 11, 1, 1, '#ffd34a');                         // yellow button
    px(x + 8, y + 10, 1, 1, '#ccc'); px(x + 8, y + 11, 1, 1, '#888'); // joystick
    px(x, y + 12, cw, 1, r.dk);                                 // deck front lip
    // coin door on the lower face
    px(x + 3, y + bh - 7, cw - 6, 3, r.dk); px(x + 3, y + bh - 7, cw - 6, 1, U.shade(r.face, 0.10));
    px(x + 5, y + bh - 6, 2, 1, blink(900) ? '#ffd34a' : '#3a3020'); // coin light
    // kick plate + feet with a floor gap
    px(x + 1, y + bh - 3, cw - 2, 1, r.ao);
    underAO(x + 2, y + bh - 2, cw - 4, 1);
    px(x + 1, y + bh - 2, 2, 2, r.dk); px(x + cw - 3, y + bh - 2, 2, 2, r.dk); // feet
    px(x + 1, y + bh - 2, 1, 1, r.lit); px(x + cw - 3, y + bh - 2, 1, 1, r.lit);
    wear(x + 1, y + bh - 7, cw - 2, 4, 3, U.shade(r.face, -0.12)); // kick scuffs
  };

  F.arcade2 = (x, y, w, h, f) => {
    const cw = 13, bh = h;                     // slim 1-tile cabinet, exactly 2 tiles tall — see F.arcade
    sh(x + 1, y + bh, cw - 1);
    px(x, y, cw, bh, '#0e1a1e');
    px(x + 1, y, cw - 2, bh, '#1e3038');
    px(x + 1, y, cw - 2, 1, '#2c424c');
    px(x + 1, y + 1, 1, bh - 2, '#263a44'); px(x + cw - 2, y + 1, 1, bh - 2, '#15242a'); // cab facets
    px(x + cw - 2, y + 3, 1, bh - 9, '#2ee6c8'); // side art stripe
    px(x + 1, y, cw - 2, 2, blink(900, 2) ? '#2ee6c8' : '#1a2a30'); // marquee
    px(x + 3, y, 2, 1, '#bff8ee'); // marquee glint
    glow(x + 1, y, cw - 2, 2, '#2ee6c8', blink(900, 2) ? 0.4 : 0.1);
    inset(x + 2, y + 2, cw - 4, 8, '#0a1216'); // screen
    const fr = Math.floor(now / 200) % 5;
    px(x + 2, y + 6, cw - 4, 1, '#12262a'); // midline
    for (let i = 0; i < 4; i++) {
      px(x + 3 + i * 2, y + 8 - ((fr + i) % 5), 1, 1, '#2ee6c8'); // waveform game
      px(x + 3 + i * 2, y + 9 - ((fr + i + 2) % 5), 1, 1, '#15564c'); // echo trace
    }
    px(x + 3 + ((fr + 2) % 4) * 2, y + 8 - ((fr * 2) % 5), 1, 1, '#dffaf4'); // combo spark
    scanl(x + 2, y + 3, cw - 4, 7, 0.12);
    glow(x + 2, y + 2, cw - 4, 8, '#2ee6c8', 0.05);
    px(x + 2, y + 11, cw - 4, 3, '#2a3e46'); // control panel
    px(x + 2, y + 11, cw - 4, 1, '#3a525c');
    px(x + 2, y + 13, cw - 4, 1, '#1c2c32'); // panel shade
    px(x + 3, y + 12, 2, 1, '#2ee6c8'); px(x + 3, y + 12, 1, 1, '#bff8ee'); // pads + shine
    px(x + 7, y + 12, 1, 1, '#caa84a'); // pad
    px(x + 3, y + bh - 4, cw - 6, 3, '#15242a'); px(x + 3, y + bh - 4, cw - 6, 1, '#263a44'); // coin door
    px(x + 5, y + bh - 3, 2, 1, blink(1100) ? '#2ee6c8' : '#16242a'); // coin light
    wear(x + 1, y + 11, cw - 2, 4, 3, '#192b31');
  };

  F.jukebox = (x, y, w, h) => {
    sh(x + 1, y + h + 9, 10);
    px(x, y, 12, h + 11, '#222a30');
    px(x + 1, y + 1, 10, h + 9, '#3a444c');
    px(x + 2, y + 1, 8, 1, '#4e5a64');
    px(x + 2, y + 2, 8, 3, blink(500) ? '#ffd34a' : '#b88a3a'); // arch lamp
    px(x + 3, y + 2, 6, 1, '#ffe88c');
    glow(x + 2, y + 2, 8, 3, '#ffd34a', 0.3 + 0.2 * Math.sin(now / 400));
    // bubble tubes climbing both sides of the arch
    for (let i = 0; i < 2; i++) {
      const bx = i ? x + 9 : x + 2;
      px(bx, y + 5, 1, 7, '#2c3a42');
      const bp = (now / (900 + i * 300)) % 1;
      px(bx, y + 5 + Math.floor((1 - bp) * 6), 1, 1, '#7fd0ff');
    }
    inset(x + 3, y + 6, 6, 5, '#10161c'); // record window
    px(x + 4, y + 7, 4, 3, '#111');
    px(x + 4, y + 7, 4, 1, '#1c1c1c'); // groove ring
    const a = now / 300;
    px(x + 5 + Math.round(Math.cos(a) * 1.5), y + 8 + Math.round(Math.sin(a)), 1, 1, '#7fd0ff'); // spinning disc glint
    px(x + 2, y + 1, 1, h + 9, '#56646e'); // chrome edge
    px(x + 9, y + 1, 1, h + 9, '#2c343a'); // shaded edge
    // selection button grid
    px(x + 3, y + 12, 6, 1, '#1c242a');
    for (let i = 0; i < 3; i++) px(x + 3 + i * 2, y + 12, 1, 1, blink(600, i) ? '#ffd34a' : '#3a3020');
    for (let i = 0; i < 2; i++) {
      px(x + 3, y + 14 + i * 2, 6, 1, '#2a333a'); // grille
      px(x + 3, y + 15 + i * 2, 6, 1, '#434e57'); // grille catch
    }
    glow(x + 2, y + h + 9, 8, 2, '#ffd34a', 0.10 + 0.05 * Math.sin(now / 400)); // floor glow
    px(x + 2, y + h + 7, 2, 2, blink(400) ? '#ff5c5c' : '#5c1c1c');
    px(x + 8, y + h + 7, 2, 2, blink(400, 1) ? '#41ff8a' : '#1c5c2c');
  };

  F.bunk = (x, y, w, h) => {
    sh(x + 1, y + h - 1, w - 2);
    px(x - 1, y + 1, w + 2, h - 1, '#1a2228');
    px(x, y + 2, w, h - 2, '#2e3840');
    px(x, y + 2, w, 1, '#3e4a52');
    // top bunk
    px(x + 1, y + 3, w - 2, 5, '#3a464e');
    px(x + 1, y + 3, 6, 5, '#d8d0c0'); px(x + 1, y + 3, 6, 1, '#eae4d6'); // pillow
    px(x + 2, y + 5, 4, 1, '#c4bcac'); // pillow crease
    px(x + 7, y + 3, w - 8, 5, '#2f5a62'); px(x + 7, y + 3, w - 8, 1, '#3e6e74'); // blanket
    px(x + 9, y + 5, w - 12, 1, '#274c53'); px(x + 8, y + 7, w - 10, 1, '#234449'); // blanket folds
    px(x + 1, y + 8, w - 2, 1, '#1a2228'); // rail
    px(x + 1, y + 9, w - 2, 1, '#39454e'); // rail catch
    // reading light over the top pillow
    px(x + 2, y + 2, 2, 1, '#1c242a');
    glow(x + 1, y + 3, 5, 2, '#ffd34a', 0.10 + 0.04 * Math.sin(now / 1300));
    // bottom bunk
    px(x + 1, y + 10, w - 2, 5, '#34404a');
    px(x + 1, y + 10, 6, 5, '#c8c0b0'); px(x + 1, y + 10, 6, 1, '#dad2c2');
    px(x + 2, y + 12, 4, 1, '#b4ac9c');
    px(x + 7, y + 10, w - 8, 5, '#274e54'); px(x + 7, y + 10, w - 8, 1, '#356065');
    px(x + 9, y + 12, w - 12, 1, '#1f4046'); px(x + 8, y + 14, w - 10, 1, '#1c3a40');
    px(x + 1, y + 15, w - 2, 1, '#1a2228');
    px(x, y + 2, 1, h - 2, '#222a30'); px(x + w - 1, y + 2, 1, h - 2, '#222a30'); // posts
    px(x, y + 2, 1, 1, '#39454e'); px(x + w - 1, y + 2, 1, 1, '#39454e'); // post caps
    for (let i = 0; i < 3; i++) {
      px(x + w - 4, y + 4 + i * 4, 3, 1, '#56646e'); // ladder
      px(x + w - 4, y + 5 + i * 4, 3, 1, '#222a30'); // rung shadow
    }
    px(x + 1, y + 17, w - 2, 5, '#28323a'); // under-bed drawers
    px(x + 1, y + 17, w - 2, 1, '#323e48');
    px(x + 3, y + 18, 6, 2, '#34404a'); px(x + 11, y + 18, 6, 2, '#34404a');
    px(x + 5, y + 19, 2, 1, '#1e262c'); px(x + 13, y + 19, 2, 1, '#1e262c'); // drawer pulls
    px(x + 2, y + 4, 1, 1, '#caa84a'); // name tag on post
  };

  F.rug = (x, y, w, h) => { // synthetic deck mat — cool slate, no textile/wood warmth
    px(x, y, w, h, '#20272d');
    px(x + 1, y + 1, w - 2, h - 2, '#28313a');
    px(x + 2, y + 2, w - 4, h - 4, '#2f3a43');
    for (let i = 0; i < (w - 8) / 4; i++) { px(x + 4 + i * 4, y + 2, 2, 1, '#3a4750'); px(x + 4 + i * 4, y + h - 3, 2, 1, '#3a4750'); } // dashed border
    for (let j = 0; j < (h - 8) / 4; j++) { px(x + 2, y + 4 + j * 4, 1, 2, '#3a4750'); px(x + w - 3, y + 4 + j * 4, 1, 2, '#3a4750'); }
    px(x + w / 2 - 6, y + h / 2 - 1, 12, 2, '#39454e'); // center motif
    px(x + w / 2 - 3, y + h / 2 - 3, 6, 6, '#324049');
    px(x + w / 2 - 1, y + h / 2 - 1, 2, 2, '#48565f');
    for (let j = 0; j < h; j += 3) { px(x - 1, y + j, 1, 1, '#46545c'); px(x + w, y + j, 1, 1, '#46545c'); } // edge trim
  };

  F.chair = (x, y, w, h, f) => {
    if (f.big) { // ultron's command throne
      ctx.globalAlpha = 0.22; px(x + 2, y + 9, 9, 2, '#000'); ctx.globalAlpha = 1;
      px(x + 1, y, 10, 4, '#3a1212'); // high back
      px(x + 1, y, 1, 4, '#4e1a1a'); px(x + 10, y, 1, 4, '#2a0c0c'); // wing facets
      px(x + 2, y + 1, 8, 3, '#5a2222');
      px(x + 2, y + 1, 8, 1, '#7a3030');
      px(x + 3, y + 2, 1, 2, '#6a2a2a'); px(x + 8, y + 2, 1, 2, '#481a1a'); // back bolster shading
      px(x + 5, y, 2, 1, '#7a3030'); // headrest
      px(x + 5, y, 2, 1, '#8a3a3a'); px(x + 4, y, 1, 1, '#5a2222'); px(x + 7, y, 1, 1, '#5a2222'); // headrest wings
      px(x + 2, y + 4, 8, 6, '#3a1616');
      px(x + 3, y + 5, 6, 2, '#4e1e1e'); // seat cushion
      px(x + 3, y + 5, 6, 1, '#5e2626'); // cushion catch
      px(x + 4, y + 6, 1, 1, '#3a1414'); px(x + 7, y + 6, 1, 1, '#3a1414'); // tuft buttons
      px(x + 1, y + 4, 2, 5, '#4a1c1c'); px(x + 9, y + 4, 2, 5, '#4a1c1c'); // armrests
      px(x + 1, y + 4, 2, 1, '#5e2626'); px(x + 9, y + 4, 2, 1, '#5e2626');
      px(x + 1, y + 8, 2, 1, '#320e0e'); px(x + 9, y + 8, 2, 1, '#320e0e'); // armrest base shade
      px(x + 2, y + 8, 1, 1, blink(800) ? '#ff4a3d' : '#5a1a14'); // console button
      px(x + 9, y + 5, 1, 2, '#1c0a0a'); // side control slit
      glow(x + 9, y + 5, 1, 2, '#ff4a3d', 0.25 + 0.1 * Math.sin(now / 600)); // throne power line
      px(x + 5, y + 2, 2, 1, '#8a6a2a'); // gold trim
      px(x + 5, y + 2, 1, 1, '#b8924a'); // trim glint
      px(x + 5, y + 10, 2, 1, '#1c0a0a'); // pedestal shadow
    } else {
      ctx.globalAlpha = 0.2; px(x + 3, y + 9, 6, 2, '#000'); ctx.globalAlpha = 1;
      px(x + 3, y + 1, 6, 2, '#3a4a40'); // backrest
      px(x + 3, y + 1, 6, 1, '#46584c');
      px(x + 3, y + 1, 1, 2, '#41544a'); px(x + 8, y + 1, 1, 2, '#2e3c34'); // backrest facets
      px(x + 4, y + 2, 4, 1, '#33413a'); // lumbar seam
      px(x + 3, y + 3, 6, 6, '#2e3a34');
      px(x + 4, y + 4, 4, 2, '#39463f'); // cushion
      px(x + 4, y + 4, 4, 1, '#41504a'); // cushion catch
      px(x + 4, y + 6, 1, 1, '#27322c'); px(x + 7, y + 6, 1, 1, '#27322c'); // seat stitches
      px(x + 3, y + 8, 6, 1, '#242e29'); // seat edge shade
      px(x + 5, y + 9, 2, 1, '#39434b'); // gas lift
      px(x + 5, y + 9, 1, 1, '#46535c'); // lift shine
      px(x + 4, y + 10, 1, 1, '#222'); px(x + 7, y + 10, 1, 1, '#222'); // star base
      px(x + 5, y + 10, 2, 1, '#2a2a2a'); px(x + 4, y + 11, 1, 1, '#1a1a1a'); px(x + 7, y + 11, 1, 1, '#1a1a1a'); // casters
    }
  };

  /* ============ DETAIL-PASS PROPS (auto-generated) ============ */
  F.bridge_tacscreen = (x, y, w, h, f) => {
  // 2px contact shadow at base (wall unit slotted between console banks)
  px(x + 1, y + h, w - 2, 2, '#0d0f11');
  // recessed two-tone grey gunmetal casing (edge bevel #565d63 over body #3a3f44)
  box(x, y, w, h, '#565d63');
  px(x + 1, y + 1, w - 2, h - 2, '#3a3f44');
  px(x + 1, y + 1, w - 2, 1, '#6b727a');           // 1px top highlight
  px(x + 1, y + h - 2, w - 2, 1, '#23272a');        // bottom inner shade
  // recessed near-black screen well
  const sx = x + 3, sy = y + 3, sw = w - 6, sh2 = h - 6;
  inset(sx, sy, sw, sh2, '#080a0c');
  px(sx, sy, sw, 1, '#040506');
  // active = brighter wireframe / readouts when an agent uses it
  const on = f && f.work;
  // wireframe brightness pulse every ~2s
  const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now / 1000));
  const lineA = (on ? 0.85 : 0.45) * pulse;
  const red = '#ff4a3d';
  // station deck-plan wireframe (faint accent-red rectangles + a cross corridor)
  ctx.save();
  ctx.globalAlpha = lineA;
  ctx.strokeStyle = red;
  ctx.beginPath();
  ctx.rect(sx + 1.5, sy + 1.5, sw - 4, sh2 - 5);                    // outer hull
  ctx.rect(sx + 3.5, sy + 3.5, Math.max(2, (sw - 8) / 2 - 1), Math.max(2, sh2 - 9)); // left deck
  ctx.moveTo(sx + sw / 2, sy + 2);                                  // central spine
  ctx.lineTo(sx + sw / 2, sy + sh2 - 4);
  ctx.moveTo(sx + 2, sy + sh2 / 2);                                 // cross corridor
  ctx.lineTo(sx + sw - 3, sy + sh2 / 2);
  ctx.stroke();
  ctx.restore();
  // three tiny scrolling tactical readout bars along the bottom of the screen
  for (let r = 0; r < 3; r++) {
    const by = sy + sh2 - 4 + r;
    if (by > sy + sh2 - 2) break;
    const scroll = Math.floor(now / (90 + r * 40)) % sw;
    const bw = 2 + (U.hash('tac' + r) % 4);
    let bx = sx + ((scroll + r * 5) % (sw - bw - 1));
    glow(bx, by, bw, 1, red, (on ? 0.7 : 0.35) * pulse);
  }
  // slow-blinking accent-red status dot, lower-right corner
  const dotOn = blink(1400);
  px(sx + sw - 3, sy + sh2 - 3, 2, 2, dotOn ? red : '#3a1714');
  if (dotOn) glow(sx + sw - 4, sy + sh2 - 4, 4, 4, red, on ? 0.5 : 0.3);
  // faint emissive spill of the screen onto the bezel
  glow(sx, sy, sw, sh2, red, (on ? 0.10 : 0.05) * pulse);
};
  F.bridge_relaystack = (x, y, w, h, f) => {   // TALL 3/4 comms relay tower (1x2), bolted; climbing data LEDs; ACC.mem
    const r = RAMP.steel, cx = x + Math.round(w / 2);
    shadow2(x + 1, y + h - 1, w - 2);                                 // contact shadow at base
    deckPlate(x - 1, y + h - 5, w + 2, 5);                            // bolted plate peeks at feet
    deckSocket(x + w + 1, y + h - 3, f && f.work);
    // antenna nub at the crown — rises a few px above the cabinet
    px(x + w - 5, y - 5, 1, 4, r.dk);                                 // mast
    px(x + w - 7, y - 6, 4, 1, r.face); px(x + w - 7, y - 6, 4, 1, r.lit);  // angled dish nub
    px(x + w - 4, y - 7, 1, 1, blink(900) ? ACC.alert : U.shade(ACC.alert, -0.6)); // beacon tip
    // TALL body: chamfered slab, lit W / dark E facet, top cap
    rr(x - 1, y - 3, w + 2, h + 2, LINE);
    px(x + 1, y - 1, w - 2, h, r.face);
    px(x + 1, y - 1, 1, h, U.shade(r.face, 0.10)); px(x + w - 2, y - 1, 1, h, r.dk);
    rr(x, y - 5, w, 3, LINE);
    px(x + 1, y - 4, w - 2, 2, r.top); px(x + 1, y - 4, w - 2, 1, r.sheen);
    px(x + 2, y - 3, 3, 1, U.shade(r.sheen, 0.12));
    // horizontal seam lines down the body
    for (let s = 0; s < 5; s++) { px(x + 2, y + 3 + s * 4, w - 4, 1, r.ao); px(x + 2, y + 4 + s * 4, w - 4, 1, U.shade(r.face, 0.08)); }
    // top vent slit with faint purple glow bleeding out
    inset(x + 3, y, w - 6, 2, '#12081c');
    glow(x + 2, y - 1, w - 4, 3, ACC.mem, 0.08 + 0.05 * Math.sin(now / 600));
    // two thin vent slits lower on the face
    px(x + 3, y + h - 6, w - 6, 1, r.ao); px(x + 3, y + h - 4, w - 6, 1, r.ao);
    // six small indicator lights, two columns of three (steady status)
    for (let ri = 0; ri < 3; ri++) {
      px(x + 3, y + 6 + ri * 4, 2, 2, blink(1100, ri * 1.3) ? ACC.mem : U.shade(ACC.mem, -0.6));
      px(x + 6, y + 6 + ri * 4, 2, 2, blink(1300, ri * 0.7 + 1) ? ACC.flow : '#33271a');
    }
    // EMISSIVE ACCENT: vertical column of purple data LEDs chasing upward like a loading bar (preserved)
    const N = 6, lit = Math.floor((now / 130) % (N + 1));
    for (let i = 0; i < N; i++) {
      const ly = y + h - 5 - i * 2, on = (N - i) <= lit;
      px(x + w - 4, ly, 2, 1, on ? ACC.mem : U.shade(ACC.mem, -0.6));
      if (on) { px(x + w - 4, ly, 1, 1, '#e0b8ff'); glow(x + w - 5, ly, 3, 1, ACC.mem, 0.3); }
    }
    px(x + 2, y, 1, 1, r.sheen); px(x + w - 3, y, 1, 1, r.sheen);     // corner bolts
    px(x + 1, y + h - 2, w - 2, 1, r.ao);                             // floor-line AO
  };
  F.bridge_dispatch_pylon = (x, y, w, h, f) => {
  // contact shadow at base
  sh(x + 1, y + h - 1, w - 2);

  const cx = x + w / 2;
  const active = f && f.work;

  // --- hexagonal column body (tapers slightly toward top) ---
  // base is full width, top inset by 2px on each side for taper
  const topInset = 2;
  // back/dark silhouette
  box(x, y + 2, w, h - 2, '#33383d');
  // left bevel facet (catches top-light)
  px(x + 1, y + 3, 2, h - 5, U.shade('#33383d', 14));
  px(x + 1, y + 3 + topInset, 1, h - 5 - topInset, U.shade('#33383d', 22));
  // right facet (shaded)
  px(x + w - 3, y + 3, 2, h - 5, U.shade('#33383d', -16));
  px(x + w - 2, y + 3, 1, h - 5, U.shade('#33383d', -26));
  // taper shave at the very top corners to read as hex narrowing
  px(x, y + 2, topInset, 2, '#1c2024');
  px(x + w - topInset, y + 2, topInset, 2, '#1c2024');
  px(x + topInset, y + 2, w - topInset * 2, 1, U.shade('#33383d', 20));

  // --- two beveled grey bands ---
  const bandY = [y + 6, y + h - 9];
  for (const by of bandY) {
    px(x + 1, by, w - 2, 3, '#5a626a');
    px(x + 1, by, w - 2, 1, U.shade('#5a626a', 16));      // top highlight
    px(x + 1, by + 2, w - 2, 1, U.shade('#5a626a', -22));  // bottom shade
    // rivets
    px(x + 2, by + 1, 1, 1, U.shade('#5a626a', -30));
    px(x + w - 3, by + 1, 1, 1, U.shade('#5a626a', -30));
  }

  // --- central vertical light-slot (recessed well) ---
  const slotY = y + 10;
  const slotH = h - 21;
  const slotX = Math.floor(cx) - 1;
  inset(slotX - 1, slotY - 1, 4, slotH + 2, '#201210');
  // pulse: brighter each time it 'sends an order'
  const pulse = active ? 0.55 + 0.45 * Math.abs(Math.sin(now / 480)) : 0.18 + 0.06 * Math.sin(now / 1400);
  px(slotX, slotY, 2, slotH, U.shade('#ff4a3d', active ? -4 : -28));
  glow(slotX - 1, slotY - 1, 4, slotH + 2, '#ff4a3d', pulse);
  // hot core line when sending
  if (active && blink(480)) {
    px(slotX, slotY, 2, slotH, '#ff8a78');
    glow(slotX - 3, slotY + slotH / 2 - 2, 8, 4, '#ff4a3d', 0.3);
  }

  // --- cap dish (small, rotating) with sweeping scan-beam ---
  const capY = y + 1;
  box(x + 3, capY, w - 6, 3, U.shade('#33383d', -8));
  px(x + 4, capY, w - 8, 1, '#5a626a');
  // dish bowl
  const dx = Math.floor(cx);
  px(dx - 2, capY - 2, 5, 2, '#454b52');
  px(dx - 1, capY - 3, 3, 1, U.shade('#5a626a', 8));
  px(dx, capY - 2, 1, 2, '#2a2e33');
  // slow sweeping scan-beam: emitter tip swings left<->right
  const sweep = Math.sin(now / 1300);
  const bx = dx + Math.round(sweep * 3);
  px(bx, capY - 4, 1, 1, active ? '#ff8a78' : '#ff4a3d');
  glow(bx - 1, capY - 5, 3, 2, '#ff4a3d', active ? 0.5 : 0.28);
  // thin beam trace
  glow(dx, capY - 4, (bx - dx) || 1, 1, '#ff4a3d', 0.18);
};
  F.bridge_orderqueue = (x, y, w, h, f) => {
  // soft oval contact shadow under the wide base
  sh(x + 1, y + h - 1, w - 2);

  // --- flat wide pedestal base (dark gunmetal) ---
  const baseH = Math.max(6, Math.floor(h * 0.55));
  const baseY = y + h - baseH;
  box(x, baseY, w, baseH, '#34393e');
  px(x + 1, baseY + 1, w - 2, baseH - 2, '#2c3034');
  // 2px grey top edge of the base
  px(x + 1, baseY, w - 2, 1, '#5b636b');
  px(x + 1, baseY + 1, w - 2, 1, '#454c52');
  // a couple of bottom-shaded seams / vents on the front face
  px(x + 3, baseY + baseH - 3, w - 6, 1, '#23272b');
  for (let i = 0; i < (w - 8) / 6; i++) px(x + 4 + i * 6, baseY + 3, 1, baseH - 6, '#262a2e');

  // --- shallow projector tray recessed into the top of the base ---
  const trayY = baseY - 2;
  inset(x + 2, trayY, w - 4, 4, '#23272b');
  px(x + 3, trayY + 1, w - 6, 1, '#3c424a');
  // emitter slit glow at center of the tray
  const cx = x + Math.floor(w / 2);
  const pulse = 0.55 + 0.35 * Math.abs(flick(1300));
  glow(x + 4, trayY, w - 8, 3, '#ff4a3d', 0.10 + 0.06 * Math.abs(flick(1300)));
  px(cx - 3, trayY + 1, 6, 1, '#ff6a5a');

  // --- faint red projector cone rising from the tray ---
  const coneTop = baseY - baseH - 3;
  ctx.save();
  ctx.globalAlpha = 0.10 + 0.05 * Math.abs(flick(1300));
  ctx.fillStyle = '#ff4a3d';
  ctx.beginPath();
  ctx.moveTo(cx, trayY + 1);
  ctx.lineTo(x + 3, coneTop);
  ctx.lineTo(x + w - 3, coneTop);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // --- floating stack of three translucent order-cards ---
  // topmost card ticks upward and dissolves every ~2.6s; the cycle index
  // makes the whole stack feel like it advances as new orders arrive.
  const PERIOD = 2600;
  const phase = (now % PERIOD) / PERIOD;          // 0..1 within current cycle
  const rise = Math.floor(phase * 3);             // topmost card creeps up
  const cardW = w - 8;
  const cardX = x + 4;
  const bob = Math.round(Math.sin(now / 800));     // gentle hologram bob

  for (let c = 0; c < 3; c++) {
    // c=0 is bottom (newest), c=2 is top (about to dissolve)
    const cy = coneTop + 1 + (2 - c) * 5 + bob - (c === 2 ? rise : 0);
    // top card fades out near the end of the cycle as it dissolves upward
    let a = 0.85 - c * 0.12;
    if (c === 2) a *= (1 - phase * 0.7);
    if (cy < y - 4) continue;

    ctx.save();
    ctx.globalAlpha = a;
    // card body (thin translucent accent-red rectangle)
    px(cardX, cy, cardW, 4, '#ff4a3d');
    px(cardX, cy, cardW, 1, '#ff7a6c');            // bright top edge
    px(cardX, cy + 3, cardW, 1, '#c2241a');        // darker base edge
    // tiny scrolling text glyphs (two rows of ticking pixels)
    const scroll = Math.floor(now / 110);
    for (let g = 0; g < cardW - 2; g += 2) {
      if (((g + scroll + c * 3) >> 1) % 3 !== 0) {
        px(cardX + 1 + g, cy + 1, 1, 1, '#ffd9d2');
      }
    }
    ctx.restore();
  }

  // a small fresh card glinting up from the emitter slit as one cycles in
  if (phase > 0.6) {
    const fy = trayY - 1 - Math.floor((phase - 0.6) * 8);
    glow(cx - 3, fy, 6, 2, '#ff7a6c', 0.5 * (phase - 0.6) / 0.4);
  }

  // status LED on the base â€” ticks when an agent is queuing orders
  px(x + 3, baseY + 2, 1, 1, (f && f.work ? blink(420) : blink(1600)) ? '#ff6a5a' : '#3a1c1a');
};
  F.research_corelens = (x, y, w, h, f) => {
  // --- contact shadow + cyan floor light-bleed under the column ---
  sh(x + 1, y + h - 1, w - 2);
  glow(x - 1, y + h - 4, w + 2, 5, '#4ad9ff', (f && f.work ? 0.22 : 0.12) + 0.05 * Math.sin(now / 600));
  px(x + 1, y + h - 1, w - 2, 1, '#1a201d'); // pooled near-black contact shadow at foot

  // --- main cylindrical metal column body (grey-green) ---
  const cx = x + w / 2;
  box(x + 1, y + 2, w - 2, h - 2, '#3a463f');
  px(x + 1, y + 2, w - 2, 1, '#525e54');            // top-lit rim
  px(x + 1, y + 2, 2, h - 3, '#525e54');            // left-edge highlight (cylinder curve)
  px(x + w - 3, y + 2, 2, h - 3, '#262e29');        // right-edge core shade
  px(x + 1, y + h - 2, w - 2, 1, '#1a201d');        // base shade

  // --- recessed lens housing: upper two-thirds of the column ---
  const lensTop = y + 3;
  const lensH = Math.round((h - 4) * 0.62);
  inset(x + 2, lensTop, w - 4, lensH, '#1a201d');
  const lcx = cx;                                   // lens center x
  const lcy = lensTop + lensH / 2;                  // lens center y
  const R = Math.min((w - 6) / 2, lensH / 2 - 1);   // outer lens radius

  // concentric cyan arcs (outer to inner) around darker pupil
  ctx.save();
  ctx.beginPath(); ctx.rect(x + 2, lensTop, w - 4, lensH); ctx.clip();
  for (let r = R; r >= 2; r -= 1.6) {
    const t = r / R;                                // 1 at rim, 0 at center
    ctx.beginPath();
    ctx.strokeStyle = U.shade('#4ad9ff', -18 + t * 4 * (1 - t) * 60 - 30);
    ctx.globalAlpha = 0.35 + 0.4 * (1 - t);
    ctx.arc(lcx, lcy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // dark pupil core
  ctx.beginPath(); ctx.fillStyle = '#1f6b80';
  ctx.arc(lcx, lcy, Math.max(1.5, R * 0.32), 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.fillStyle = '#0e3540';
  ctx.arc(lcx, lcy, Math.max(1, R * 0.16), 0, Math.PI * 2); ctx.fill();

  // --- sweeping scanline (top->bottom every ~2s) with trailing glow ---
  const sweep = (now % 2000) / 2000;               // 0..1
  const sy = lensTop + 1 + sweep * (lensH - 2);
  glow(x + 2, sy - 3, w - 4, 4, '#4ad9ff', 0.22);  // faint trailing glow above line
  px(x + 3, Math.round(sy), w - 6, 1, '#bff0ff');  // bright scanline
  glow(x + 2, sy, w - 4, 2, '#4ad9ff', 0.45);
  ctx.restore();

  // --- pupil spec highlight + idle emissive pulse ---
  px(Math.round(lcx) - 1, Math.round(lcy) - 1, 1, 1, '#cdeeff');

  // --- metal collar beneath the lens with two alternating amber LEDs ---
  const cyc = lensTop + lensH + 1;
  px(x + 2, cyc, w - 4, 2, '#2f3a34');
  px(x + 2, cyc, w - 4, 1, '#4a564e');
  const ledY = cyc + (h - (cyc - y) > 4 ? 2 : 1);
  px(x + 3, ledY, 2, 2, blink(520, 0) ? '#ffb347' : '#5a3f1a');
  px(x + w - 5, ledY, 2, 2, blink(520, 1) ? '#ffb347' : '#5a3f1a');
  if (blink(520, 0)) glow(x + 2, ledY - 1, 4, 4, '#ffb347', 0.3);
  if (blink(520, 1)) glow(x + w - 6, ledY - 1, 4, 4, '#ffb347', 0.3);

  // --- lower column seam detail ---
  px(x + 3, y + h - 4, w - 6, 1, '#262e29');
  px(x + 3, y + h - 3, w - 6, 1, '#48544c');
};
  F.research_trendpillar = (x, y, w, h, f) => {
  // ground contact shadow (hard, near-black)
  sh(x + 1, y + h, w - 2);
  px(x + 2, y + h - 1, w - 4, 1, '#080b0a');

  // --- pedestal (lower tile): square dark-metal base ---
  const pedH = 11;
  const pedY = y + h - pedH;
  box(x + 1, pedY, w - 2, pedH, '#333d37');
  px(x + 2, pedY, w - 4, 1, '#4a564e');            // top bevel highlight
  px(x + 2, pedY + 1, 1, pedH - 2, '#414c45');     // left edge sheen
  px(x + w - 3, pedY + 1, 1, pedH - 2, '#252d28'); // right edge shade
  px(x + 2, pedY + pedH - 1, w - 4, 1, '#1c2420'); // base shade line
  inset(x + 3, pedY + 3, w - 6, 4, '#222b26');     // recessed vent panel
  px(x + 4, pedY + 4, 1, 1, blink(2200) ? '#41ff8a' : '#1c2a22'); // status LED

  // --- vertical strip display (upper tile) ---
  const scX = x + 2, scW = w - 4;
  const scY = y + 1, scH = h - pedH - 2;
  const on = f.work;
  // bezel casing with emissive halo
  glow(scX - 1, scY - 1, scW + 2, scH + 2, '#4ad9ff', on ? 0.20 : 0.10);
  box(scX - 1, scY - 1, scW + 2, scH + 2, '#2a332f');
  inset(scX, scY, scW, scH, '#0a1416'); // dark screen well

  // clip drawing to the screen face
  ctx.save();
  ctx.beginPath();
  ctx.rect(scX + 1, scY + 1, scW - 2, scH - 2);
  ctx.clip();

  const gX = scX + 1, gW = scW - 2, gTop = scY + 2, gH = scH - 4;
  const dim = on ? 1 : 0.45;

  // scrolling cyan line-chart climbing left-to-right + purple comparison beneath
  const t = Math.floor(now / 110);
  for (let i = 0; i < gW; i++) {
    const s = U.hash('trend' + ((i + t) % 64));
    // cyan: rises overall, jitter
    const climb = (i / gW) * (gH - 4);
    const jit = (s % 5);
    const cy = gTop + gH - 2 - climb - jit + 2;
    ctx.globalAlpha = dim;
    px(gX + i, cy, 1, 1, '#4ad9ff');
    if (i > 0) px(gX + i, cy, 1, 2, U.shade('#4ad9ff', -25));
    ctx.globalAlpha = 1;
    // purple comparison line, lower/flatter
    const pclimb = (i / gW) * (gH - 8);
    const pjit = (U.hash('curie' + ((i + t) % 64)) % 3);
    const py = gTop + gH - 1 - pclimb * 0.6 - pjit;
    ctx.globalAlpha = dim * 0.85;
    px(gX + i, py, 1, 1, '#8f7bff');
    ctx.globalAlpha = 1;
  }

  // 2px ticker of fake percentage figures crawling upward (bottom band)
  const tick = Math.floor(now / 240) % 9;
  for (let r = 0; r < gH; r += 3) {
    const yy = gTop + ((r + tick) % gH);
    const v = U.hash('pct' + r + (Math.floor(now / 700) % 7)) % 99;
    ctx.globalAlpha = dim * 0.5;
    // tiny 2px figure: sign tick + two digit dots
    px(gX + 1, yy, 1, 1, v % 2 ? '#41ff8a' : '#ff6a6a');
    px(gX + 3 + (v % 3), yy, 1, 1, '#3a5c50');
    px(gX + gW - 3 - (v % 2), yy, 1, 1, '#3a5c50');
    ctx.globalAlpha = 1;
  }

  // drifting scan line
  const scanY = gTop + Math.floor((Math.sin(now / 600) * 0.5 + 0.5) * (gH - 1));
  glow(gX, scanY, gW, 1, '#9af0ff', on ? 0.22 : 0.10);

  ctx.restore();

  // bezel inner highlight ring + corner glints
  px(scX, scY, scW, 1, U.shade('#2a332f', 18));
  px(scX, scY, 1, scH, U.shade('#2a332f', 10));
  px(scX + scW - 1, scY, 1, scH, '#1a221e');
};
  F.research_samplecart = (x, y, w, h, f) => {
  // soft contact shadow under the casters
  sh(x + 1, y + h - 1, w - 2);

  // ---- caster wheels (four tiny dark casters) ----
  px(x + 2, y + h - 2, 2, 2, '#15191a');
  px(x + w - 4, y + h - 2, 2, 2, '#15191a');
  px(x + 3, y + h - 1, 1, 1, '#0c0f10');
  px(x + w - 3, y + h - 1, 1, 1, '#0c0f10');

  // ---- cart frame (scuffed grey-green metal) ----
  const fr = '#404a43';
  box(x + 1, y + 2, w - 2, h - 3, fr);
  // vertical posts catching a touch more light
  px(x + 2, y + 3, 1, h - 5, U.shade(fr, 18));
  px(x + w - 3, y + 3, 1, h - 5, U.shade(fr, -14));

  // ---- lower shelf (data-drive caddy) ----
  const sy = y + h - 5;
  inset(x + 2, sy, w - 4, 3, '#2c332e');
  // stacked grey caddy
  px(x + 3, sy, 5, 3, '#5a665c');
  px(x + 3, sy, 5, 1, U.shade('#5a665c', 16));
  px(x + 3, sy + 1, 5, 1, '#3a443d');
  // drive slots
  px(x + 4, sy + 1, 3, 1, '#222a26');
  // blinking green read LED
  px(x + 9, sy + 1, 1, 1, blink(520) ? '#7dffb0' : '#1d3a2c');
  if (blink(520)) glow(x + 8, sy, 3, 2, '#7dffb0', 0.22);

  // ---- top tray ----
  const ty = y + 2;
  box(x + 1, ty, w - 2, 4, fr);
  // tray rim (grey-green) + specular highlight along the front rail
  px(x + 2, ty + 1, w - 4, 2, '#5a665c');
  px(x + 2, ty + 1, w - 4, 1, U.shade('#5a665c', 14));
  px(x + 2, ty + 3, w - 4, 1, '#2f3833');
  // thin specular highlight on the front rail
  px(x + 3, ty + 4, w - 6, 1, '#7e8c82');

  // ---- folded printout on the tray (right side) ----
  px(x + w - 6, ty - 1, 4, 3, '#cfd2c8');
  px(x + w - 6, ty - 1, 4, 1, '#e6e8df');
  px(x + w - 5, ty, 2, 1, '#9aa094');
  px(x + w - 4, ty + 1, 1, 1, '#8c9286'); // fold crease

  // ---- three capped sample vials glowing faint cyan ----
  const cyan = '#4ad9ff';
  for (let i = 0; i < 3; i++) {
    const vx = x + 3 + i * 3;
    // cap
    px(vx, ty - 3, 2, 1, '#7a8a86');
    // glass body
    px(vx, ty - 2, 2, 3, '#2a3a40');
    // glowing fluid (subtle staggered pulse per vial)
    const lit = 0.55 + 0.35 * Math.sin(now / 760 + i * 1.7);
    px(vx, ty - 1, 2, 2, U.shade(cyan, -18));
    px(vx, ty - 1, 1, 1, cyan);
    glow(vx - 1, ty - 2, 4, 4, cyan, 0.10 + 0.10 * lit);
  }
};
  F.research_papers = (x, y, w, h, f) => {
  // flat non-blocking floor deco: scattered printout sheets + one manila folder
  const paper = '#e8e6dd', paperHi = U.shade(paper, 0.18), paperSh = U.shade(paper, -0.22);
  // soft contact shadow grounding the loose pile
  sh(x + 2, y + h - 2, w - 4);
  // --- manila folder lying underneath, peeking out lower-left ---
  const fold = '#c9b27a';
  px(x + 1, y + h - 7, 11, 6, U.shade(fold, -0.4));      // folder drop shadow / edge
  px(x + 1, y + h - 8, 11, 6, fold);
  px(x + 1, y + h - 8, 11, 1, U.shade(fold, 0.22));       // top-lit fold crease
  px(x + 1, y + h - 4, 1, 1, U.shade(fold, 0.22));        // tab corner highlight
  px(x + 8, y + h - 8, 4, 1, U.shade(fold, 0.3));         // raised tab
  // --- 4 plain scatter sheets at deterministic angles (drawn back-to-front) ---
  const sheets = [
    [x + 6, y + 2, 8, 9, 0],
    [x + 1, y + 5, 8, 8, 1],
    [x + 9, y + 6, 7, 8, -1],
    [x + 3, y + 1, 7, 8, 0]
  ];
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i], sx = s[0], sy = s[1], sw = s[2], sh2 = s[3], skew = s[4];
    px(sx - 1 + skew, sy + 1, sw, sh2, paperSh);          // each sheet's own shadow
    px(sx + skew, sy, sw, sh2, paper);
    px(sx + skew, sy, sw, 1, paperHi);                    // top sheen
    px(sx + skew, sy, 1, sh2, paperHi);
    px(sx + skew, sy + sh2 - 1, sw, 1, paperSh);          // bottom edge
    // faint grey text lines on the lower sheets
    for (let j = 0; j < 2; j++) {
      const lw = 2 + (U.hash('rp' + i + j) % (sw - 3));
      px(sx + 1 + skew, sy + 2 + j * 2, lw, 1, '#9aa0a0');
    }
  }
  // --- topmost sheet: the readable printout with chart + text ---
  const tx = x + 4, ty = y + 3, tw = 9, th = 10;
  px(tx - 1, ty + 1, tw + 1, th, U.shade(paper, -0.32));  // deeper drop shadow (slightly raised)
  px(tx, ty, tw, th, paper);
  px(tx, ty, tw, 1, paperHi);
  px(tx, ty, 1, th, paperHi);
  px(tx + tw - 1, ty + 1, 1, th - 1, paperSh);
  px(tx, ty + th - 1, tw, 1, paperSh);
  // curled corner (top-right lifts) with soft cast shadow beneath it
  px(tx + tw - 3, ty - 1, 3, 1, U.shade(paper, -0.28));   // shadow cast by curl
  px(tx + tw - 3, ty, 3, 2, paperHi);                     // curled-up paper, catching light
  px(tx + tw - 1, ty, 1, 1, '#fffdf6');
  // grey printed text rows
  px(tx + 1, ty + 2, 6, 1, '#7e8484');
  px(tx + 1, ty + 4, 5, 1, '#969c9c');
  px(tx + 1, ty + 9, 4, 1, '#969c9c');
  // tiny cyan bar-chart block
  const bars = [2, 4, 3, 5];
  for (let b = 0; b < bars.length; b++) {
    px(tx + 1 + b * 2, ty + 8 - bars[b], 1, bars[b], '#4ad9ff');
    px(tx + 1 + b * 2, ty + 8 - bars[b], 1, 1, '#bff0ff'); // lit cap
  }
  // ONE subtle animated emissive accent: a single bar's data tick pulses faintly,
  // brighter when an agent is reading it (f.work)
  const k = Math.floor(now / 600) % bars.length;
  const a = f.work ? 0.55 : 0.18 + 0.12 * Math.sin(now / 700);
  glow(tx + 1 + k * 2, ty + 8 - bars[k], 1, 1, '#9aeaff', a);
};
  F.comms_dish = (x, y, w, h, f) => {   // bolted deck base + BOLD oval dish on a mast (2x2); ACC.data cyan reach
    const r = RAMP.steel, active = f && f.work;
    shadow2(x + 1, y + h - 1, w - 2);                                 // floor contact
    deckPlate(x + 1, y + h - 5, w - 2, 5);                            // bolted mounting plate under the pedestal
    deckSocket(x + 1, y + h - 3, active);                             // cable into a floor socket, W side
    // squat pedestal base: top-bias oblique block the mast rises from
    const bw = w - 6, bx = x + 3, by = y + h - 9;
    rr(bx - 1, by, bw + 2, 8, LINE);
    px(bx, by + 1, bw, 5, r.face);
    px(bx, by + 1, bw, 1, r.lit);                                     // under-lip catch
    px(bx, by + 1, 1, 5, U.shade(r.face, 0.08)); px(bx + bw - 1, by + 1, 1, 5, r.dk);
    px(bx, by + 5, bw, 1, r.ao);
    rr(bx - 1, by - 3, bw + 2, 4, LINE);                              // pedestal top surface (we look down on it)
    px(bx, by - 2, bw, 3, r.top); px(bx, by - 2, bw, 1, r.sheen);
    px(bx + 2, by - 1, 4, 1, U.shade(r.sheen, 0.10));
    inset(bx + 1, by + 2, 4, 2, '#10161a'); inset(bx + bw - 5, by + 2, 4, 2, '#10161a'); // bolt plates
    px(bx + 2, by + 3, 1, 1, r.sheen); px(bx + bw - 4, by + 3, 1, 1, r.sheen);
    px(bx + bw - 4, by + 3, 1, 1, blink(900, 0.37) ? ACC.data : U.shade(ACC.data, -0.6)); // status LED
    // yoke mast rising toward the dish
    const cx = x + Math.round(w / 2), yoke = y + 5;
    px(cx - 1, yoke, 3, by - yoke, LINE);
    px(cx, yoke, 1, by - yoke, r.lit); px(cx + 1, yoke, 1, by - yoke, r.dk);            // lit W / dark E column
    // BOLD tilted oval dish, angled up-left (3-tone), rimmed
    const dcx = cx - 2, dcy = yoke - 1, rx = w * 0.44, ry = w * 0.24;
    ctx.save();
    ctx.fillStyle = LINE;                                             // heavy silhouette rim
    ctx.beginPath(); ctx.ellipse(dcx, dcy, rx + 0.6, ry + 0.6, -0.55, 0, 6.2832); ctx.fill();
    ctx.fillStyle = r.face;                                           // dish back (mid steel)
    ctx.beginPath(); ctx.ellipse(dcx, dcy, rx, ry, -0.55, 0, 6.2832); ctx.fill();
    ctx.fillStyle = r.dk;                                             // concave shadow interior
    ctx.beginPath(); ctx.ellipse(dcx + 1, dcy + 0.5, rx - 3, ry - 2.4, -0.55, 0, 6.2832); ctx.fill();
    ctx.fillStyle = r.sheen;                                          // upper-left specular sliver
    ctx.beginPath(); ctx.ellipse(dcx - rx * 0.34, dcy - ry * 0.34, rx * 0.30, ry * 0.24, -0.55, 0, 6.2832); ctx.fill();
    // radar sweep arc across the concave (once per cycle) — ACC.data
    const cyc = (now / 1500) % 1;
    if (cyc < 0.45) {
      ctx.globalAlpha = 0.36 * (1 - cyc / 0.45); ctx.strokeStyle = ACC.data; ctx.lineWidth = 1;
      const a0 = -2.2 + cyc * 3.2;
      ctx.beginPath(); ctx.ellipse(dcx + 1, dcy + 0.5, rx - 3, ry - 2.4, -0.55, a0, a0 + 0.9); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    // feed-arm + emitter horn at the focus
    const fx = dcx + rx * 0.5, fy = dcy + ry * 0.5;
    px(dcx, dcy, 1, 1, r.sheen);
    ctx.strokeStyle = LINE; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(dcx, dcy); ctx.lineTo(fx, fy); ctx.stroke();
    px(Math.round(fx) - 1, Math.round(fy) - 1, 3, 3, r.face); px(Math.round(fx) - 1, Math.round(fy) - 1, 3, 1, r.lit); // horn
    // ONE emissive accent: feed-horn cyan pulse (~1.5s)
    const pulse = 0.45 + 0.55 * Math.max(0, Math.sin(now / 750));
    const gain = active ? 1 : 0.55;
    glow(Math.round(fx) - 2, Math.round(fy) - 2, 4, 4, ACC.data, 0.45 * pulse * gain);
    px(Math.round(fx), Math.round(fy), 1, 1, pulse > 0.7 ? '#c7f4ff' : ACC.data);
  };
  F.comms_inbox = (x, y, w, h, f) => {
  // ---- floor contact shadow ----
  sh(x + 1, y + h - 1, w - 2);

  // ---- main gunmetal grey-green cabinet ----
  box(x, y + 2, w, h - 2, '#2c342f');
  px(x + 1, y + 3, w - 2, 1, '#3c463f');           // top-lit edge
  px(x + 1, y + h - 2, w - 2, 1, '#161c19');       // bottom shade

  // ---- vented lower grille (front face) ----
  const grY = y + h - 5;
  inset(x + 2, grY, w - 4, 4, '#1a201d');
  for (let i = 0; i < (w - 6) / 3; i++) px(x + 3 + i * 3, grY + 1, 1, 2, '#0e1411');

  // ---- channel pips along the front lip (mail / webhook / platform) ----
  const pipY = y + h - 7;
  const alert = blink(520, 1);                       // amber alert blink
  px(x + 3, pipY, 2, 1, blink(900, 0) ? '#41ff8a' : '#173026');           // mail
  px(x + 7, pipY, 2, 1, alert ? '#ffb23a' : '#3a2c12');                   // webhook (alert)
  px(x + 11, pipY, 2, 1, blink(1300, 2) ? '#41ff8a' : '#173026');         // platform
  if (alert) glow(x + 6, pipY - 1, 4, 3, '#ff9d2e', 0.35);

  // ---- angled near-black glass bezel, tilted toward viewer ----
  box(x + 1, y - 3, w - 2, 6, '#141a17');
  inset(x + 2, y - 2, w - 4, 5, '#0a100d');
  // teal under-glow spill from the projected hologram
  const pulse = 0.10 + 0.06 * Math.sin(now / 640);
  glow(x + 2, y - 2, w - 4, 6, '#5ad1b3', pulse);

  // ---- floating holographic message stack (teal wireframe) ----
  const teal = '#5ad1b3', tealDim = '#2f7a68';
  const cardW = 8, cardX = x + 4;
  // phase of the rise/fade cycle (~2s)
  const t = (now % 2000) / 2000;
  for (let s = 0; s < 4; s++) {
    // base resting y for each stacked card, lower = closer to glass
    let cy = y - 2 - s * 3;
    let a = 0.85 - s * 0.18;
    if (s === 0) {                                   // top card slides up + fades out
      cy -= Math.round(t * 4);
      a *= (1 - t);
    } else {                                          // others rise one notch over the cycle
      cy -= Math.round(t * 3);
    }
    if (a <= 0.04) continue;
    ctx.save();
    ctx.globalAlpha = a;
    const col = s === 0 ? teal : tealDim;
    // envelope card outline
    px(cardX, cy, cardW, 1, col);                    // top
    px(cardX, cy + 2, cardW, 1, col);                // bottom
    px(cardX, cy, 1, 3, col);                        // left
    px(cardX + cardW - 1, cy, 1, 3, col);            // right
    // envelope flap diagonal hint
    px(cardX + cardW / 2 - 1, cy + 1, 2, 1, U.shade(col, 30));
    ctx.restore();
  }

  // ---- scrolling 2px unread-count badge (ticks) ----
  const cnt = (Math.floor(now / 2000) % 9) + 1;      // digit ticks each cycle
  const bx = x + w - 6, by = y - 1;
  glow(bx - 1, by - 1, 5, 4, '#5ad1b3', 0.25);
  px(bx, by, 4, 3, '#0c1714');
  // tiny 2px-tall digit rendered as lit teal cell pattern (deterministic per count)
  const segOn = (U.hash('' + cnt) % 2) === 0;
  px(bx + 1, by, 2, 1, teal);
  px(bx + 1, by + 1, segOn ? 2 : 1, 1, teal);
  px(bx + 1, by + 2, 2, 1, U.shade(teal, -10));

  // ---- active-use lift: brighten hologram when an agent works it ----
  if (f && f.work) {
    glow(x + 2, y - 3, w - 4, 8, '#5ad1b3', 0.14 + 0.05 * Math.sin(now / 300));
    px(cardX - 1, y - 2, 1, 1, '#bff5e6');
  }
};
  F.comms_uplink = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE capsule sorter (2x2): big top deck + short face; ACC.data
    const r = RAMP.steel, active = f && f.work;
    shadow2(x + 1, y + h - 1, w - 2);                                 // floor contact
    deckPlate(x + 1, y + h - 5, w - 2, 5);                            // bolted plate
    deckSocket(x + w + 1, y + h - 3, active);                         // cable into floor socket, E side
    for (const lx of [x + 2, x + w - 5]) {                            // chunky corner legs on the plate
      px(lx, y + h - 6, 3, 3, LINE); px(lx, y + h - 6, 1, 3, r.lit); px(lx + 1, y + h - 6, 1, 3, r.dk);
    }
    underAO(x + 5, y + h - 6, w - 10, 2);
    // short front face (south wall of the sorter)
    rr(x - 1, y + 6, w + 2, 6, LINE);
    px(x, y + 7, w, 4, r.face); px(x, y + 7, w, 1, r.lit);
    px(x, y + 10, w, 1, r.ao);
    // routing panel with lit destination tabs on the face
    inset(x + 2, y + 7, w - 8, 3, '#141b18');
    const activeTab = Math.floor(now / 1800) % 4;
    for (let i = 0; i < 4; i++) {
      const on = i === activeTab;
      px(x + 3 + i * 4, y + 8, 2, 1, on ? ACC.data : '#1f3a33');
      if (on) glow(x + 2 + i * 4, y + 7, 4, 2, ACC.data, 0.25);
    }
    // amber active chute on the face's right end
    const chx = x + w - 5; inset(chx, y + 7, 3, 3, '#241c12');
    const route = blink(450) && ((now % 1800) / 1800 > 0.7);
    px(chx + 1, y + 8, 1, 1, route ? ACC.flow : '#5a3c18');
    if (route) glow(chx, y + 7, 4, 3, ACC.flow, 0.3);
    // big rounded TOP DECK (dominates)
    rr(x - 1, y - 3, w + 2, 10, LINE);
    rr(x, y - 2, w, 8, r.top);
    px(x + 1, y - 2, w - 2, 1, r.sheen);
    px(x, y - 1, 1, 6, r.lit); px(x + w - 1, y - 1, 1, 6, r.dk);
    px(x + 3, y - 1, 6, 1, U.shade(r.top, 0.06));                     // brushed streak
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.16));               // top front edge
    wear(x + 2, y - 1, w - 4, 5, 3, U.shade(r.top, -0.10));
    // two capsule tubes rising THROUGH the deck (glass wells) + a dropping capsule
    const txA = x + 4, txB = x + w - 7, tTop = y - 8, tBot = y + 2;
    for (const tx of [txA, txB]) {
      rr(tx - 1, tTop - 1, 4, tBot - tTop + 2, LINE);
      inset(tx, tTop, 3, tBot - tTop, '#1b2420');
      px(tx, tTop, 3, 1, r.sheen);                                    // cap rim
      glow(tx, tTop, 3, tBot - tTop, ACC.data, 0.06);
    }
    px(txB + 1, y - 4, 1, 2, ACC.data); px(txB + 1, y - 4, 1, 1, '#c7f4ff'); // resting capsule
    const drop = (now % 1800) / 1800, dy = tTop + 1 + Math.floor(drop * (tBot - tTop - 2));
    px(txA + 1, dy, 1, 2, ACC.data); px(txA + 1, dy, 1, 1, '#e0fbff');       // dropping capsule
    glow(txA, dy - 1, 3, 3, ACC.data, 0.22);
    // circular drum viewport set into the deck between tubes
    const cx = x + Math.round(w / 2), cy = y + 1, rad = 4;
    ctx.fillStyle = LINE; ctx.beginPath(); ctx.arc(cx, cy, rad + 1, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#0f1714'; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 6.2832); ctx.fill();
    const notch = Math.floor(now / 1800) % 6;
    ctx.save(); ctx.strokeStyle = r.lit; ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * 6.2832 + (notch / 6) * 6.2832;
      ctx.beginPath(); ctx.moveTo(cx + 0.5, cy + 0.5);
      ctx.lineTo(cx + 0.5 + Math.cos(a) * (rad - 1), cy + 0.5 + Math.sin(a) * (rad - 1)); ctx.stroke();
    }
    ctx.restore();
    const catchT = (now % 1800) / 1800;
    if (catchT < 0.18) glow(cx - rad, cy - rad, rad * 2, rad * 2, ACC.data, 0.18 * (1 - catchT / 0.18));
    px(cx - 2, cy - 3, 3, 1, U.shade(r.top, 0.10));                  // glass highlight
    if (active) glow(x + 2, y - 2, w - 4, 8, ACC.data, 0.06 + 0.03 * Math.sin(now / 500));
  };
  F.comms_beacon = (x, y, w, h, f) => {   // TALL 3/4 signal mast (1x2), bolted; caged lamp + climbing rings; ACC.data
    const r = RAMP.steel, cx = x + Math.round(w / 2);
    shadow2(cx - 4, y + h - 1, 9);                                    // floor contact
    deckPlate(cx - 5, y + h - 5, 11, 5);                             // bolted round base plate
    deckSocket(cx + 4, y + h - 3, f && f.work);                      // cable into floor socket
    // weighted base drum (top-bias block)
    const baseY = y + h - 8;
    rr(cx - 5, baseY, 11, 5, LINE);
    px(cx - 4, baseY + 1, 9, 3, r.face); px(cx - 4, baseY + 1, 9, 1, r.lit);
    px(cx - 4, baseY + 3, 9, 1, r.ao);
    rr(cx - 5, baseY - 2, 11, 3, LINE);                              // base top surface
    px(cx - 4, baseY - 1, 9, 2, r.top); px(cx - 4, baseY - 1, 9, 1, r.sheen);
    px(cx - 3, baseY + 2, 1, 1, r.sheen); px(cx + 3, baseY + 2, 1, 1, r.sheen); // rivets
    // gunmetal pole
    const poleTop = y - 1, poleBot = baseY - 1;
    px(cx - 2, poleTop, 4, poleBot - poleTop, LINE);
    px(cx - 1, poleTop, 1, poleBot - poleTop, r.lit);                // west highlight
    px(cx, poleTop, 1, poleBot - poleTop, r.face);
    px(cx + 1, poleTop, 1, poleBot - poleTop, r.dk);                 // east shade
    // three stacked signal-strength rings climbing the pole (outgoing transmission) — ACC.data
    const seq = Math.floor(now / 320) % 4;
    for (let ri = 0; ri < 3; ri++) {
      const ry = poleTop + 4 + ri * 4;
      const lit = seq < 3 && (2 - ri) <= seq;                        // fill from bottom ring upward
      px(cx - 2, ry, 5, 1, lit ? ACC.data : '#1e3a33');
      if (lit) { px(cx - 2, ry, 5, 1, U.shade(ACC.data, 0.12 - ri * 0.06)); glow(cx - 3, ry, 7, 1, ACC.data, 0.2); }
    }
    // caged emitter lamp at the crown (rises above the footprint)
    const lampY = poleTop - 6;
    rr(cx - 4, lampY, 9, 8, LINE);
    px(cx - 3, lampY + 1, 7, 6, r.face); px(cx - 3, lampY + 1, 7, 1, r.lit);           // housing
    inset(cx - 2, lampY + 2, 5, 4, '#0c1411');                                          // recessed well
    const pulse = 0.5 + 0.5 * Math.sin(now / 318), core = f && f.work ? 1 : 0.45;
    const a = (0.25 + 0.6 * pulse) * (0.6 + 0.4 * core);
    px(cx - 1, lampY + 3, 3, 2, U.shade(ACC.data, -0.1 + pulse * 0.25));
    if (pulse > 0.55) px(cx, lampY + 3, 1, 1, '#e6fffb');            // white-hot center
    glow(cx - 5, lampY, 11, 8, ACC.data, 0.10 + a * 0.22);
    px(cx - 1, lampY + 1, 1, 6, '#0a0f0d'); px(cx + 1, lampY + 1, 1, 6, '#0a0f0d'); px(cx - 2, lampY + 3, 5, 1, '#0a0f0d'); // cage bars
    // two short whip antennas forming a shallow V
    for (const s of [-1, 1]) { px(cx + s, lampY - 1, 1, 1, r.face); px(cx + 2 * s, lampY - 2, 1, 1, r.lit); px(cx + 3 * s, lampY - 3, 1, 1, r.lit); }
    // tiny red collision-light blinking at the very tip
    if (blink(560)) { px(cx, lampY - 2, 1, 1, ACC.alert); glow(cx - 1, lampY - 3, 3, 3, ACC.alert, 0.4); }
    else px(cx, lampY - 2, 1, 1, U.shade(ACC.alert, -0.6));
  };
  F.connector_portal = (x, y, w, h, f) => {   // TALL 3/4 gateway cabinet, bolted to deck; rides live connector state
    // CONNECTOR PORTAL (1x2) — an agent's on-ramp to an EXTERNAL MCP server. BOUND to one connector, rides its LIVE
    // state: crown aperture + status lamp + conduit go green=connected · amber=offline/warming · red=error · grey=unbound.
    // A tool call fires a bright packet UP the conduit and out the aperture; f.fired decays 1 -> 0. States must stay distinct.
    const st  = (f && f.state) || (f && f.bound ? 'offline' : 'unbound');
    const SACC = { connected: ACC.work, offline: ACC.flow, error: ACC.alert, unbound: '#586b61' };
    const SHOT = { connected: '#c7ffe0', offline: '#ffe9a8', error: '#ff8378', unbound: '#8aa093' };
    const acc = SACC[st] || SACC.unbound, hot = SHOT[st] || SHOT.unbound;
    const live = st === 'connected', bad = st === 'error';
    const fired = Math.max(0, Math.min(1, (f && f.fired) || 0));
    const r = RAMP.steel, cw = 13, cx = x + Math.round(cw / 2);
    const apX = cx + 3, apY = y - 6;                                  // crown aperture = the "outside" port, above the cabinet
    shadow2(x + 1, y + h - 1, cw - 2);                                // contact shadow at base
    deckPlate(x - 1, y + h - 6, cw + 2, 6);                           // bolted mounting plate peeks at its feet
    deckSocket(x + cw + 1, y + h - 3, live);                          // cable runs into a floor socket, live-tinted
    // crown: a 3-dot arc climbing to the aperture; chases upward when connected
    const arc = [[cx - 1, y - 2], [cx + 1, y - 4], [apX, apY + 1]];
    for (let i = 0; i < arc.length; i++) {
      const on = live ? (Math.floor(now / 160) % arc.length === i) : (i === 0);
      px(arc[i][0], arc[i][1], 1, 1, on ? hot : U.shade(acc, -0.45));
      if (on && live) glow(arc[i][0] - 1, arc[i][1] - 1, 3, 3, acc, 0.28);
    }
    // aperture ring (flickers when error; flares with a firing packet or when live)
    ctx.strokeStyle = (bad && blink(260)) ? U.shade(acc, -0.5) : acc; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(apX + 0.5, apY + 0.5, 2, 0, 6.2832); ctx.stroke();
    if (live || fired > 0) glow(apX - 2, apY - 2, 5, 5, acc, 0.16 + 0.5 * fired);
    // TALL 3/4 body: chamfered slab, side facets, top cap we look down on
    rr(x - 1, y - 4, cw + 2, h + 3, LINE);
    px(x + 1, y - 2, cw - 2, h, r.face);
    px(x + 1, y - 2, 1, h, U.shade(r.face, 0.10)); px(x + cw - 2, y - 2, 1, h, r.dk);   // lit W / dark E facet
    rr(x, y - 6, cw, 3, LINE);
    px(x + 1, y - 5, cw - 2, 2, r.top); px(x + 1, y - 5, cw - 2, 1, r.sheen);           // cap top surface
    px(x + 1, y - 4, 4, 1, U.shade(r.sheen, 0.12));                                     // west sheen streak
    // recessed conduit channel up the center (the data path)
    const condX = cx - 1, condTop = y - 2, condBot = y + h - 8;
    inset(condX, condTop, 2, condBot - condTop, '#141b18');
    px(condX, condTop, 2, 1, U.shade(acc, -0.4));                                       // conduit mouth ring
    // brushed side seams
    for (let s = 0; s < 3; s++) { px(x + 2, y + 2 + s * 5, cw - 4, 1, r.ao); px(x + 2, y + 3 + s * 5, cw - 4, 1, U.shade(r.face, 0.08)); }
    // status lamp on the face near the crown
    const lampOn = bad ? blink(300) : (live ? true : (st === 'offline' ? blink(1400) : false));
    px(x + 2, y - 1, 2, 2, lampOn ? acc : U.shade(acc, -0.55));
    if (lampOn) glow(x + 1, y - 2, 4, 4, acc, 0.3);
    // socket bay near the base: two ports = the literal "connector"
    const syb = y + h - 6;
    for (const sx of [cx - 4, cx + 1]) {
      inset(sx, syb, 3, 3, '#10100c');                                                  // socket well
      px(sx + 1, syb + 1, 1, 1, U.shade(acc, -0.2));                                     // contact pin, state-tinted
    }
    px(x + 1, y + h - 2, cw - 2, 1, r.ao);                                              // floor-line AO
    // idle: a dim packet drifts UP the conduit when connected
    if (live && fired === 0) {
      const t = (now % 1400) / 1400;
      const py = condBot - 1 - Math.floor(t * (condBot - condTop - 1));
      px(condX, py, 2, 1, U.shade(acc, 0.1));
    }
    // FIRING: a bright packet rises the conduit toward the aperture
    if (fired > 0) {
      const py = condBot - 1 - Math.floor((1 - fired) * (condBot - condTop - 1));
      px(condX, py, 2, 2, hot);
      glow(condX - 1, py - 1, 4, 4, acc, 0.45);
    }
  };
  F.workbench = (x, y, w, h, f) => {   // POWERED bench (2x1) — TOP-BIAS OBLIQUE, bolted to deck. f.fired 1->0 pulse, f.bad = fail
    const r = RAMP.steel;
    const fired = Math.max(0, Math.min(1, (f && f.fired) || 0));
    const bad = !!(f && f.bad) && fired > 0;
    const acc = bad ? ACC.alert : ACC.work, hot = bad ? '#ff8378' : '#c7ffe0';
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, fired > 0 || (f && f.work));
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short apron / front lip, with the run-status underglow strip (green pulse / red fail)
    rr(x - 1, y + 5, w + 2, 5, LINE);
    px(x, y + 6, w, 3, r.face);
    px(x, y + 6, w, 1, r.lit);
    px(x, y + 8, w, 1, r.ao);
    glow(x + 1, y + 8, w - 2, 1, acc, fired > 0 ? 0.30 + 0.5 * fired : 0.06); // fires green, red on bad
    // heavy steel worktop dominates
    rr(x - 1, y - 4, w + 2, 11, LINE);
    rr(x, y - 3, w, 9, r.top);
    px(x + 1, y - 3, w - 2, 1, r.sheen);
    px(x, y - 2, 1, 7, r.lit); px(x + w - 1, y - 2, 1, 7, r.dk);
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.16));
    wear(x + 1, y - 2, w - 2, 6, 4, U.shade(r.top, -0.10));
    // a vise clamped at the left edge of the top
    rr(x + 1, y - 2, 4, 3, LINE); px(x + 2, y - 1, 2, 1, U.shade('#9aa39c', -0.1));
    px(x + 2, y, 2, 1, U.shade('#9aa39c', -0.3));
    // scattered tools on the surface (wrench + driver)
    px(x + 7, y - 1, 3, 1, U.shade('#9aa39c', -0.2)); px(x + 7, y, 1, 1, U.shade('#9aa39c', -0.35));
    px(x + 12, y - 1, 1, 2, U.shade('#c9a14a', -0.1));         // screwdriver shaft
    // status MONITOR on the right: idle amber standby; green pulse on run; red on verify-fail
    const mx = x + w - 6, my = y - 2;
    inset(mx, my, 5, 4, '#0c120f');
    if (fired > 0) {
      px(mx + 1, my + 1, 3, 1, hot);
      px(mx + 1, my + 2, 2, 1, U.shade(acc, 0.1));
      glow(mx - 1, my - 1, 7, 6, acc, 0.25 + 0.5 * fired);
    } else {
      const standby = blink(1600);
      px(mx + 1, my + 1, 1, 1, standby ? ACC.flow : U.shade(ACC.flow, -0.5)); // amber heartbeat
    }
    // a small bar-graph "work" readout under the monitor when active
    if (f && f.work) for (let i = 0; i < 3; i++)
      px(mx + i, my + 3, 1, 1, (Math.floor(now / 180) % 3 === i) ? acc : U.shade(acc, -0.5));
  };
  F.etsy_threadrack = (x, y, w, h, f) => {
  // wall-mounted thread/filament spool rack â€” sits flush under north wall
  sh(x + 1, y + h, w - 2);
  // dark gunmetal grey-green back plate
  box(x, y + 1, w, h - 1, '#3a4540');
  px(x + 1, y + 2, w - 2, 1, U.shade('#3a4540', 16));
  px(x + 1, y + h - 1, w - 2, 1, U.shade('#3a4540', -22));
  // two thin horizontal mounting rails
  const railA = y + 4, railB = y + h - 4;
  px(x + 1, railA, w - 2, 1, '#262e2a');
  px(x + 1, railA - 1, w - 2, 1, U.shade('#3a4540', 8));
  px(x + 1, railB, w - 2, 1, '#262e2a');
  px(x + 1, railB - 1, w - 2, 1, U.shade('#3a4540', 8));
  // row of upright spools across the rails (2px discs)
  const cols = ['#ff9d2e', '#ffbf6a', '#ff9d2e', '#e8ddc8', '#ffbf6a', '#ff9d2e', '#ffbf6a'];
  const n = 6 + (U.hash('threadrack') % 2); // 6-7 spools
  const span = w - 6;
  const step = span / n;
  const cy = y + Math.floor(h / 2);
  for (let i = 0; i < n; i++) {
    const cx = x + 3 + Math.round(i * step + step / 2 - 1);
    const c = cols[i % cols.length];
    // spool body
    px(cx - 1, cy - 2, 3, 4, U.shade(c, -28));
    px(cx - 1, cy - 1, 3, 2, c);
    // upper-left highlight pixel
    px(cx - 1, cy - 2, 1, 1, U.shade(c, 34));
    // dangling thread tail (a couple of them)
    if (i === 1 || i === n - 2) px(cx, cy + 2, 1, 2, U.shade(c, -6));
  }
  // active print-feed: tiny amber LED at one spool base, slow 2-frame pulse
  const ledx = x + 3 + Math.round(1 * step + step / 2 - 1);
  const lit = (f && f.work) ? blink(900) : blink(1800);
  px(ledx, cy + 4, 1, 1, lit ? '#ffd34a' : '#28323a');
  if (lit) glow(ledx - 1, cy + 3, 3, 2, '#ff9d2e', 0.22);
  // hard 1px contact shadow along bottom edge
  px(x + 1, y + h, w - 2, 1, '#1a201d');
};
  F.etsy_dyevat = (x, y, w, h, f) => {
  // contact shadow on floor
  sh(x + 1, y + h - 1, w - 2);
  // round-cornered dark steel basin
  box(x, y + 1, w, h - 1, '#33403b');
  px(x + 1, y + 2, w - 2, 1, U.shade('#33403b', 18));
  px(x + 1, y + h - 2, w - 2, 1, U.shade('#33403b', -16));
  // soften the corners by darkening outer corner pixels
  px(x, y + 1, 1, 1, U.shade('#33403b', -22)); px(x + w - 1, y + 1, 1, 1, U.shade('#33403b', -22));
  px(x, y + h - 2, 1, 1, U.shade('#33403b', -26)); px(x + w - 1, y + h - 2, 1, 1, U.shade('#33403b', -26));
  // riveted rim â€” lighter grey dabs at corners
  px(x + 2, y + 2, 2, 1, '#5a665e'); px(x + w - 4, y + 2, 2, 1, '#5a665e');
  px(x + 2, y + h - 4, 2, 1, U.shade('#5a665e', -12)); px(x + w - 4, y + h - 4, 2, 1, U.shade('#5a665e', -12));
  px(x + 2, y + 2, 1, 1, U.shade('#5a665e', 22)); px(x + w - 3, y + 2, 1, 1, U.shade('#5a665e', 22));
  // recessed dye well
  inset(x + 2, y + 3, w - 4, h - 7, '#241712');
  // circular pool of amber dye â€” concentric rings core->rim
  const cx = x + w / 2, cy = y + 3 + (h - 7) / 2;
  ctx.save();
  ctx.beginPath(); ctx.ellipse(cx, cy, w / 2 - 3, (h - 7) / 2 - 1, 0, 0, Math.PI * 2); ctx.clip();
  px(x + 2, y + 3, w - 4, h - 7, '#c9701a');
  ctx.beginPath(); ctx.ellipse(cx, cy, w / 2 - 4.5, (h - 7) / 2 - 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = U.shade('#c9701a', 16); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx, cy, w / 2 - 6, (h - 7) / 2 - 3, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ff9d2e'; ctx.fill();
  // ripple arcs â€” 2-3 lighter highlight crescents, slow drift
  const rp = now / 1400;
  ctx.globalAlpha = 0.5; ctx.strokeStyle = U.shade('#ff9d2e', 30); ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const rr = (w / 2 - 5) * (0.35 + i * 0.22) + Math.sin(rp + i) * 0.6;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rr, rr * 0.62, 0, Math.PI * (0.9 + i * 0.15), Math.PI * (1.7 + i * 0.15));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // animated bubble â€” surfaces then pops on slow cycle
  const bt = (now / 2600) % 1;
  if (bt < 0.6) {
    const by = cy - 1 - bt * 3;
    px(Math.round(cx - 2), Math.round(by), 1, 1, U.shade('#ff9d2e', 40));
    if (bt > 0.4) px(Math.round(cx - 2), Math.round(by), 1, 1, '#ffeccc');
  }
  ctx.restore();
  glow(cx - (w / 2 - 4), cy - (h - 7) / 2, w - 6, h - 7, '#ff9d2e', 0.1 + 0.05 * Math.sin(now / 800));
  // bent steel dip-arm crossing the top-right corner
  px(x + w - 5, y, 3, 2, '#5a665e'); px(x + w - 5, y, 3, 1, U.shade('#5a665e', 22));
  px(x + w - 6, y + 2, 2, 3, '#4a544d'); px(x + w - 7, y + 4, 2, 2, '#4a544d');
  // half-submerged white fabric swatch, staining orange at lower edge
  px(x + w - 9, y + 5, 5, 3, '#e8ece6'); px(x + w - 9, y + 5, 5, 1, '#ffffff');
  px(x + w - 9, y + 7, 5, 1, '#e0a45c'); px(x + w - 9, y + 8, 5, 1, '#c9701a');
  px(x + w - 8, y + 9, 3, 1, U.shade('#c9701a', -10));
  // small green-LED control nub on the front face
  px(x + 3, y + h - 3, 3, 2, '#1b2422');
  px(x + 4, y + h - 3, 1, 1, blink(900) ? '#41ff8a' : '#16302a');
  if (f.work) glow(x + 3, y + h - 4, 4, 3, '#41ff8a', 0.18);
};
  F.etsy_kiln = (x, y, w, h, f) => {
  // contact shadow
  sh(x + 1, y + h - 1, w - 2);
  // squat dark-metal cube housing
  box(x, y + 1, w, h - 1, '#2f3a36');
  // heavy beveled lid: top-lit rim + recessed inner plate
  px(x + 1, y + 2, w - 2, 1, '#46544e');
  px(x + 1, y + 2, w - 2, 1, U.shade('#2f3a36', 22));
  inset(x + 2, y + 3, w - 4, h - 8, '#222b28');
  // bevel chamfer lines (3-tone)
  px(x + 2, y + 3, w - 4, 1, '#374440');
  px(x + 2, y + h - 5, w - 4, 1, '#1a211e');
  // two corner bolt highlights (top-left, top-right)
  px(x + 2, y + 3, 2, 2, '#1b211e'); px(x + 2, y + 3, 1, 1, '#5e6c64');
  px(x + w - 4, y + 3, 2, 2, '#1b211e'); px(x + w - 4, y + 3, 1, 1, '#5e6c64');

  // centered circular viewport with hot wax core
  const cx = x + w / 2, cy = y + 3 + (h - 8) / 2;
  const r = Math.min(w, h - 8) / 2 - 2;
  // breathing 3-frame loop -> 0,1,2 then back via sine for smoothness
  const breath = 0.5 + 0.5 * Math.sin(now / 1000);
  // dark viewport bezel ring
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2); ctx.fillStyle = '#15191780'; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r + 1, 0, Math.PI * 2); ctx.fillStyle = '#0d1210'; ctx.fill();
  // ember orange outer molten ring
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#ff7a1a'; ctx.fill();
  // deep amber hot core
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2); ctx.fillStyle = '#ffd34a'; ctx.fill();
  // brightest centre spec when active / breathing peak
  ctx.beginPath(); ctx.arc(cx - r * 0.18, cy - r * 0.18, Math.max(1, r * 0.22), 0, Math.PI * 2);
  ctx.fillStyle = '#fff0b0'; ctx.fill();
  ctx.restore();
  // soft 3px emissive bloom that breathes (the ONE animated accent)
  const bloomA = (f && f.work ? 0.30 : 0.16) + 0.14 * breath;
  glow(cx - r - 2, cy - r - 2, r * 2 + 4, r * 2 + 4, '#ff9d2e', bloomA);
  glow(cx - r, cy - r, r * 2, r * 2, '#ffd34a', 0.10 + 0.10 * breath);

  // short vent stack on top-left corner
  box(x, y, 4, 4, '#262f2b'); px(x + 1, y, 2, 1, '#3a463f');
  inset(x + 1, y + 1, 2, 2, '#11161300');
  px(x + 1, y + 1, 2, 2, '#0e1311');
  // faint 1px heat-shimmer pixel rising from the vent
  if (blink(420)) px(x + 2, y - 2, 1, 1, '#6a7882');
  else if (blink(420, 0.5)) px(x + 1, y - 3, 1, 1, '#46525a');

  // tiny yellow 3-segment readout bar on the front face
  inset(x + w / 2 - 5, y + h - 4, 11, 2, '#191e1b');
  for (let s = 0; s < 3; s++) {
    const lit = breath > s / 3.2;
    px(x + w / 2 - 4 + s * 4, y + h - 3, 3, 1, lit ? '#ffd34a' : '#28323a');
  }

  // front lower bevel shade for grounding
  px(x + 1, y + h - 2, w - 2, 1, '#1a211e');
};
  F.etsy_packbot = (x, y, w, h, f) => {
  // contact shadow grounds it on the factory floor
  sh(x + 1, y + h - 1, w - 2);

  // --- base plate: square grey-green casing with recessed center ---
  box(x, y + 1, w, h - 2, '#3d4842');
  px(x + 1, y + 2, w - 2, 1, U.shade('#3d4842', 18)); // top-lit lip
  inset(x + 4, y + 5, w - 8, h - 11, '#2c352f');      // darker recessed center well
  px(x + 5, y + 6, w - 10, 1, '#222a25');

  // four corner footpads
  px(x + 1, y + 2, 3, 3, '#313a35'); px(x + 1, y + 2, 3, 1, '#4a564f');
  px(x + w - 4, y + 2, 3, 3, '#313a35'); px(x + w - 4, y + 2, 3, 1, '#4a564f');
  px(x + 1, y + h - 5, 3, 3, '#2b332e');
  px(x + w - 4, y + h - 5, 3, 3, '#2b332e');

  // --- half-sealed metal shipping case sitting on the plate ---
  const bx = x + 6, by = y + 8, bw = w - 12, bh = h - 13;
  px(bx, by, bw, bh, '#36424c');
  px(bx, by, bw, 1, U.shade('#36424c', 22));         // top-lit lid edge
  px(bx, by + bh - 1, bw, 1, U.shade('#36424c', -28)); // shaded base
  px(bx, by, 1, bh, U.shade('#36424c', 10));
  // half-open flap seam (sealed left, open right)
  px(bx + Math.floor(bw / 2), by + 1, 1, bh - 2, '#28323a');
  px(bx + 1, by + 2, Math.floor(bw / 2) - 1, 1, '#46525a'); // sealed-side seam highlight

  // --- orange Etsy-style shipping label on the lid ---
  const lx = bx + 1, ly = by + 1, ls = 5;
  px(lx, ly, ls, ls, '#ff9d2e');
  px(lx, ly, ls, 1, U.shade('#ff9d2e', 22));
  px(lx + 1, ly + ls - 2, 3, 1, '#1a2228'); // barcode line 1
  px(lx + 1, ly + ls - 1, 3, 1, '#1a2228'); // barcode line 2

  // --- stubby two-segment articulated steel arm reaching over the box ---
  // shoulder mount on back-right of plate
  const sx = x + w - 6, sy = y + 4;
  px(sx, sy, 4, 4, '#5a645c'); px(sx, sy, 4, 1, U.shade('#6b766e', 14)); // mount
  px(sx + 1, sy + 1, 2, 2, '#2a322d');                                    // joint
  // segment 1 (upper arm) angling in toward box
  px(sx - 4, sy + 2, 5, 2, '#6b766e'); px(sx - 4, sy + 2, 5, 1, U.shade('#6b766e', 16));
  // elbow joint
  px(sx - 5, sy + 2, 2, 2, '#3a423c');
  // segment 2 (forearm) reaching down over the label
  px(sx - 5, sy + 3, 2, 4, '#7a857c'); px(sx - 5, sy + 3, 1, 4, U.shade('#7a857c', 14));

  // --- scanner head on the arm tip ---
  const hx = sx - 6, hy = sy + 6;
  px(hx, hy, 4, 3, '#4a544d'); px(hx, hy, 4, 1, U.shade('#6b766e', 10));
  inset(hx + 1, hy + 1, 2, 1, '#11201c');

  // --- ONE animated emissive accent: cyan-white scan sweep across the box ---
  if (f && f.work) {
    const sweep = bx + Math.floor(((now / 900) % 1) * bw);
    px(sweep, by, 1, bh, '#cffcff');
    glow(sweep - 1, by, 3, bh, '#5fe0ff', 0.30);
    glow(hx, hy, 4, 3, '#5fe0ff', 0.22);              // emitter spill at scanner head
    // amber status LED blinks when active
    px(x + 3, y + h - 4, 2, 2, blink(420) ? '#ffb43a' : '#28323a');
    if (blink(420)) glow(x + 2, y + h - 5, 4, 4, '#ff9d2e', 0.25);
  } else {
    px(x + 3, y + h - 4, 2, 2, '#28323a'); // dim LED when idle
    px(x + 3, y + h - 4, 1, 1, '#36424c');
  }
};
  F.gigs_thumbwall = (x, y, w, h, f) => {
  // contact shadow along bottom edge (wall unit sits flush under north wall)
  sh(x + 1, y + h, w - 2);
  // dark gunmetal frame
  box(x, y, w, h, '#2b2f33');
  // thin brushed-aluminium bezel (top-lit) inside the frame
  px(x + 1, y + 1, w - 2, 1, '#9aa2a8');
  px(x + 1, y + 1, w - 2, h - 2, '#5a6066');
  px(x + 1, y + 2, w - 2, h - 4, '#3a3f44');
  px(x + 1, y + h - 2, w - 2, 1, '#1d2225');
  // recessed face well behind the cards
  inset(x + 2, y + 2, w - 4, h - 4, '#1a1e21');
  // 2x3 grid of pinned thumbnail cards (2 rows, 3 cols)
  const cols = 3, rows = 2;
  const gx = x + 3, gy = y + 3;                 // grid origin
  const cw = 4, chT = 4;                          // card body w / total cell stride helpers
  const stepX = Math.floor((w - 6) / cols);       // horizontal stride per cell
  const stepY = Math.floor((h - 5) / rows);       // vertical stride per cell
  const tints = ['#41ff8a', '#7fd0ff', '#f0ece4']; // lime / sky / off-white
  // which cell is the NEW ORDER slot (deterministic): last row, middle col
  const newCol = 1, newRow = rows - 1;
  // emissive pulse for the NEW ORDER card (~1.2s, 2-frame bump)
  const pulse = blink(1200) ? 1 : 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = gx + c * stepX;
      const cy = gy + r * stepY;
      const isNew = (c === newCol && r === newRow);
      // 1px drop shadow under/right of each card
      px(cx + 1, cy + chT, cw, 1, '#0c0f11');
      px(cx + cw, cy + 1, 1, chT, '#0c0f11');
      if (isNew) {
        // NEW ORDER slot glowing room-accent purple, pulses
        const base = pulse ? '#b44aff' : '#7a2fb0';
        px(cx, cy, cw, chT, base);
        px(cx, cy, cw, 1, pulse ? '#d79bff' : '#9a4ad0');
        if (pulse) glow(cx - 1, cy - 1, cw + 2, chT + 2, '#b44aff', 0.4);
      } else {
        // pick a deterministic tint per card
        const col = tints[U.hash('gig' + r + '_' + c) % tints.length];
        px(cx, cy, cw, chT, col);
        px(cx, cy, cw, 1, U.shade(col, 30));     // top highlight
        px(cx, cy + chT - 1, cw, 1, U.shade(col, -40)); // bottom shade
      }
      // micro 5-star row of yellow pixels beneath the card
      for (let s = 0; s < 5; s++) px(cx - 1 + s, cy + chT + 1, 1, 1, '#ffd23a');
    }
  }
  // 1px violet status LED in the bottom-left corner, blinks
  px(x + 1, y + h - 2, 1, 1, blink(700) ? '#c46bff' : '#3a2050');
};
  F.gigs_servercart = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE blade cart (1x1): big top + blade face on casters; ACC.mem
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);                                 // floor contact
    // caster wheels poking out the front edge (mobile — no deck plate, it rolls)
    px(x + 3, y + h - 2, 2, 2, LINE); px(x + 3, y + h - 2, 1, 1, r.lit);
    px(x + w - 5, y + h - 2, 2, 2, LINE); px(x + w - 5, y + h - 2, 1, 1, r.lit);
    // short front face: recessed well holding a stack of horizontal blade servers
    rr(x - 1, y + 2, w + 2, h - 4, LINE);
    px(x, y + 3, w, h - 6, r.face); px(x, y + 3, w, 1, r.lit);
    inset(x + 2, y + 3, w - 4, h - 7, '#12081c');
    const nrow = 4, bw2 = w - 6, rowH = Math.floor((h - 8) / nrow);
    const scan = Math.floor((now / 130) % (nrow + 1));               // purple data scroll across rows
    for (let ru = 0; ru < nrow; ru++) {
      const ry = y + 4 + ru * rowH;
      px(x + 3, ry, bw2, rowH - 1, ru % 2 ? U.shade(r.face, -0.08) : U.shade(r.face, 0.02)); // blade body
      px(x + 3, ry, bw2, 1, U.shade(r.face, 0.12));                  // blade top catch
      px(x + 3, ry, 1, 1, '#0c0e10'); px(x + 5, ry, 1, 1, '#0c0e10'); // left vent slits
      // horizontal LED strip on each blade — mem purple, one scans bright
      for (let i = 0; i < 3; i++) {
        const lx = x + 8 + i * 2;
        const lit = blink(360 + ru * 110 + i * 47, i + ru);
        const hot = (nrow - 1 - ru) === scan;                        // scroll head lights this row
        px(lx, ry, 1, 1, hot ? '#e0b8ff' : (lit ? ACC.mem : U.shade(ACC.mem, -0.62)));
      }
    }
    px(x, y + h - 4, w, 1, r.ao);                                     // floor-line AO
    glow(x + 2, y + 3, w - 4, h - 7, ACC.mem, 0.08 + 0.05 * Math.sin(now / 300));
    // big rounded TOP surface with a chrome push-handle bar (dominant)
    rr(x - 1, y - 3, w + 2, 6, LINE);
    rr(x, y - 2, w, 5, r.top);
    px(x + 1, y - 2, w - 2, 1, r.sheen);
    px(x, y - 1, 1, 3, r.lit); px(x + w - 1, y - 1, 1, 3, r.dk);
    px(x + 2, y - 1, w - 4, 1, U.shade(r.top, 0.06));                // brushed streak
    px(x + 2, y - 3, w - 4, 1, '#aeb6c0'); px(x + 2, y - 3, 1, 1, '#6c727a'); px(x + w - 3, y - 3, 1, 1, '#6c727a'); // chrome push-handle
    px(x + 1, y + 2, w - 2, 1, U.shade(r.top, -0.16));              // top front edge
    // coiled cable looping off the right onto the floor
    px(x + w - 1, y + h - 4, 2, 1, '#0a0b0c'); px(x + w, y + h - 3, 1, 2, '#0a0b0c');
    if (f && f.work) glow(x + 2, y + 3, w - 4, h - 7, ACC.mem, 0.06 + 0.03 * Math.sin(now / 500));
  };
  F.gigs_partsbin = (x, y, w, h, f) => {
    // TOP-BIAS OPEN-TOP bin: you look INTO it. Freestanding, 4 compartments of parts visible inside the rim.
    const cw = w, r = RAMP.steel;
    shadow2(x + 1, y + h - 1, cw - 2);
    // short outer front face (bin wall)
    rr(x, y + 3, cw, h - 4, LINE);
    px(x + 1, y + 4, cw - 2, h - 6, r.face);
    px(x + 1, y + 4, 1, h - 6, r.lit); px(x + cw - 2, y + 4, 1, h - 6, r.dk);
    px(x + 1, y + h - 3, cw - 2, 1, r.ao);
    // scuffs + a hazard tick on the front wall
    px(x + 3, y + 4, 2, 1, r.dk); px(x + cw - 6, y + 4, 3, 1, r.sheen);
    px(x + Math.floor(cw / 2), y + h - 4, 2, 1, '#8a7434');
    // OPEN TOP: thick lit rim we look over, dark interior well inside it
    rr(x - 1, y - 1, cw + 2, 7, LINE);
    px(x, y, cw, 6, r.top);                                     // rim slab
    px(x, y, cw, 1, r.sheen);                                   // back rim catches light
    px(x, y + 1, 4, 1, U.shade(r.sheen, 0.12));                 // west sheen streak
    px(x, y, 1, 6, r.lit); px(x + cw - 1, y, 1, 6, r.dk);       // side rim walls
    // recessed interior floor (dark), inset from the rim
    const ix = x + 2, iy = y + 1, iw = cw - 4, ih = 4;
    px(ix, iy, iw, ih, U.shade(r.face, -0.42));                 // interior back wall shade
    px(ix, iy + 1, iw, ih - 1, '#161c22');                      // interior floor
    px(ix, iy + ih, iw, 1, U.shade(r.top, -0.20));              // front inner lip
    // 3 dividers -> 4 compartments of visible parts
    const cc = (iw - 3) / 4;
    for (let d = 1; d < 4; d++) { const dx = Math.round(ix + d * cc + (d - 1)); px(dx, iy, 1, ih, '#0d1116'); px(dx, iy, 1, 1, U.shade(r.face, 0.10)); }
    const cx0 = i => Math.round(ix + i * (cc + 1)) + 1;
    // c0: green sprite-chip swatch
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++)
      px(cx0(0) + sx, iy + 1 + sy, 1, 1, (sx + sy) % 2 ? '#2faa55' : ACC.work);
    // c1: warm freshly-rendered teal chip stack + soft emissive glow (kept behavior)
    const c1 = cx0(1), warm = 0.16 + 0.12 * Math.sin(now / 760);
    px(c1, iy + 2, 3, 2, '#1f8c7a'); px(c1, iy + 2, 3, 1, '#2ee6c8'); px(c1, iy + 1, 2, 1, '#43f0d6');
    glow(c1 - 1, iy, 4, ih, '#2ee6c8', warm);
    if (blink(900)) px(c1 + 1, iy + 1, 1, 1, '#d6fff6');       // render sparkle
    // c2: coil of orange filament
    const c2 = cx0(2);
    px(c2, iy + 1, 3, 3, '#b35a1c'); px(c2 + 1, iy + 2, 1, 1, '#3a2414'); // coil + hole
    px(c2, iy + 1, 3, 1, '#ff9d2e'); px(c2 + 2, iy + 3, 1, 1, '#ffc870');
    // c3: loose screws + gems (with the kept gem glint)
    const c3 = cx0(3);
    px(c3, iy + 1, 1, 1, U.hash('scrw') % 2 ? '#e4e8e0' : '#c8ccc4'); // screw
    px(c3 + 2, iy + 2, 1, 1, '#9aa09a');                        // screw
    px(c3, iy + 3, 1, 1, '#5ad6ff'); if (blink(1400, 2)) px(c3, iy + 3, 1, 1, '#c4f4ff'); // gem glint
    px(c3 + 2, iy + 3, 1, 1, '#ff7ad0');                        // gem
    // freestanding feet + under-gap AO
    px(x + 1, y + h - 2, 2, 2, r.dk); px(x + cw - 3, y + h - 2, 2, 2, r.dk);
    px(x + 1, y + h - 2, 1, 1, r.lit); px(x + cw - 3, y + h - 2, 1, 1, r.lit);
    underAO(x + 3, y + h - 1, cw - 6, 1);
  };
  F.gigs_amp = (x, y, w, h, f) => {
  sh(x + 1, y + h - 1, w - 2);
  // dark vinyl casing, top-lit
  box(x, y + 1, w, h - 1, '#1c1c1f');
  px(x + 1, y + 2, w - 2, 1, U.shade('#1c1c1f', 18)); // top sheen line
  px(x + 1, y + 2, 3, 1, U.shade('#1c1c1f', 38)); // top-left plastic sheen
  px(x + 1, y + 2, 1, 2, U.shade('#1c1c1f', 30));
  px(x + 1, y + h - 2, w - 2, 1, U.shade('#1c1c1f', -22)); // bottom shade

  // silver piping frame around grille
  const gx = x + 2, gy = y + 4, gw = w - 4, gh = h - 6;
  px(gx - 1, gy - 1, gw + 2, gh + 2, '#9aa0a6');
  px(gx - 1, gy - 1, gw + 2, 1, '#c4cace'); // bright top piping
  px(gx - 1, gy - 1, 1, gh + 2, '#b6bcc0');

  // recessed grille well
  inset(gx, gy, gw, gh, '#161618');

  // bass-throb purple backlight (2-frame pulse)
  const beat = blink(360);
  glow(gx, gy, gw, gh, '#b44aff', beat ? 0.22 : 0.08);

  // fine 1px woven crosshatch over the grille
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      if (((r + c) & 1) === 0) {
        px(gx + c, gy + r, 1, 1, beat ? '#3a2150' : '#26262b');
      }
    }
  }
  // subtle vertical weave threads for depth
  for (let c = 1; c < gw; c += 3) px(gx + c, gy, 1, gh, U.shade('#161618', beat ? 26 : 10));

  // two control knobs along top edge
  px(x + 4, y, 2, 2, '#3a3a40'); px(x + 4, y, 1, 1, '#6a6a72');
  px(x + w - 6, y, 2, 2, '#3a3a40'); px(x + w - 6, y, 1, 1, '#6a6a72');

  // power LED top-right
  const on = f.work ? blink(900) : true;
  px(x + w - 3, y + 1, 1, 1, on ? '#ff5a4a' : '#3a1612');
  if (on) glow(x + w - 4, y, 3, 3, '#ff5a4a', 0.25);
};
  F.treasury_coinsorter = (x, y, w, h, f) => {
    // TOP-BIAS OBLIQUE coin sorter: rounded top hopper, short face; coin-stack jitter + counter kept.
    const cw = w, r = RAMP.steel, gold = ACC.flow;
    shadow2(x + 1, y + h - 1, cw - 2);
    // short front face of the machine
    rr(x, y + 3, cw, h - 4, LINE);
    px(x + 1, y + 4, cw - 2, h - 6, r.face);
    px(x + 1, y + 4, 1, h - 6, r.lit); px(x + cw - 2, y + 4, 1, h - 6, r.dk);
    px(x + 1, y + h - 3, cw - 2, 1, r.ao);
    // dominant rounded top deck
    rr(x - 1, y - 2, cw + 2, 7, LINE);
    px(x, y - 1, cw, 6, r.top);
    px(x, y - 1, cw, 1, r.sheen); px(x, y, 4, 1, U.shade(r.sheen, 0.12));
    px(x, y - 1, 1, 6, r.lit); px(x + cw - 1, y - 1, 1, 6, r.dk);
    px(x, y + 4, cw, 1, U.shade(r.top, -0.16));                 // deck front lip
    // LEFT 2/3: recessed sorting bay (open, we see into it) with the jittering coin stacks
    const hw = Math.floor((cw - 2) * 2 / 3);
    inset(x + 1, y + 4, hw, h - 7, '#1c211e');
    px(x + 2, y + 5, hw - 2, 1, '#222b27');
    const jit = Math.floor(now / 220) % 2, base = y + h - 4;
    const cols = [
      [x + 3, base, 3, '#c9a440'], [x + 5, base - 2, 4, '#d9b24a'],
      [x + 8, base - 1, 3, '#cfa844'], [x + 10, base - 3, 5, '#d9b24a'],
      [x + 13, base, 3, '#c9a440'], [x + 15, base - 2, 4, '#d9b24a']
    ];
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]; if (c[0] > x + hw - 1) continue;
      const dy = (i + Math.floor(now / 220)) % 2 === jit ? 0 : -1;
      px(c[0], c[1] + dy, 3, c[2], '#8a6a25');
      px(c[0], c[1] + dy, 3, c[2] - 1, c[3]);
      px(c[0], c[1] + dy, 3, 1, '#f5e08a');                     // coin-edge sheen
      px(c[0] + 2, c[1] + dy + 1, 1, c[2] - 1, '#8a6a25');
    }
    glow(x + 2, y + 4, hw - 2, h - 8, gold, 0.06);          // faint bullion cast
    // RIGHT 1/3: readout tower with the live counter (kept) + status LED
    const sx = x + 1 + hw + 1, sw = cw - hw - 3;
    px(sx, y + 4, sw, h - 7, r.face);
    px(sx, y + 4, 1, h - 7, r.lit); px(sx + sw - 1, y + 4, 1, h - 7, r.dk);
    inset(sx + 1, y + 5, sw - 2, 4, '#0c1a0c');
    const on = (f && f.work) ? 1 : 0.35;
    const nDisp = 100 + Math.floor(now / 1000) % 900, dg = String(nDisp);
    for (let d = 0; d < 3; d++) {
      glow(sx + 2 + d * 2, y + 6, 1, 2, '#9bff4a', 0.22 + 0.7 * on * ((dg.charCodeAt(d) % 2) ? 1 : 0.6));
      px(sx + 2 + d * 2, y + 6, 1, (d % 2) ? 2 : 1, U.shade('#9bff4a', -10 * (1 - on)));
    }
    glow(sx + 1, y + 5, sw - 2, 4, '#9bff4a', 0.10 * on);
    const led = blink(1000) ? '#9bff4a' : '#1f3a16';
    px(sx + sw - 2, y + 6, 1, 1, led);
    if (blink(1000)) glow(sx + sw - 3, y + 5, 3, 3, '#9bff4a', 0.30);
    // freestanding feet + under-gap AO
    px(x + 1, y + h - 2, 2, 2, r.dk); px(x + cw - 3, y + h - 2, 2, 2, r.dk);
    px(x + 1, y + h - 2, 1, 1, r.lit); px(x + cw - 3, y + h - 2, 1, 1, r.lit);
    underAO(x + 3, y + h - 1, cw - 6, 1);
  };
  F.treasury_token_furnace = (x, y, w, h, f) => {
    // TALL 3/4 token-burn furnace: rises ~5px above the 1x2 footprint. Furnace glow/ember pulse kept.
    const cw = w, r = RAMP.gun, rise = 5, topY = y - rise, botY = y + h - 1;
    shadow2(x + 1, botY, cw - 2);
    // stovepipe vent rising from the cap, with heat-shimmer
    const pw = 3, pvx = x + Math.round(cw / 2) - 1;
    px(pvx - 1, topY - 8, pw + 2, 1, U.shade(r.top, 0.20));      // pipe cap rim
    px(pvx, topY - 8, pw, 4, r.face); px(pvx, topY - 8, 1, 4, r.lit); px(pvx + pw - 1, topY - 8, 1, 4, r.dk);
    if (blink(520)) px(pvx + (Math.floor(now / 260) % 2), topY - 10, 1, 1, '#4a564a');
    if (blink(520, 1)) px(pvx + 1, topY - 9, 1, 1, '#3e4a3e');
    // front cabinet face (tall) + slim east flank
    rr(x - 1, topY - 3, cw + 2, botY - topY + 3, LINE);
    px(x + cw - 3, topY - 1, 2, botY - topY, r.dk);              // east flank
    px(x + 1, topY, cw - 4, (botY - 1) - topY, r.face);          // face
    px(x + 1, topY, 1, (botY - 1) - topY, r.lit);                // west lit column
    px(x + 2, topY, cw - 5, 1, U.shade(r.face, 0.14));
    // rounded cap
    rr(x, topY - 4, cw - 2, 4, LINE);
    px(x + 1, topY - 3, cw - 4, 3, r.top); px(x + 1, topY - 3, cw - 4, 1, r.sheen);
    px(x + 1, topY - 1, cw - 4, 1, U.shade(r.top, -0.18));
    // riveted corners
    const rv = '#4a5254';
    px(x + 1, topY + 1, 1, 1, rv); px(x + cw - 5, topY + 1, 1, 1, rv);
    px(x + 1, botY - 3, 1, 1, U.shade(rv, -0.15)); px(x + cw - 5, botY - 3, 1, 1, U.shade(rv, -0.15));
    // 'TOKENS BURNED' readout near the top of the face
    const ry = topY + 2;
    inset(x + 2, ry, cw - 6, 4, '#0c1410');
    for (let i = 0; i < cw - 8; i++) {
      if ((U.hash('tb' + i) + Math.floor(now / 240)) % 3 === 0) {
        const lit = blink(300, i) || (f && f.work);
        px(x + 3 + i, ry + 1, 1, 1, lit ? scr(i) : '#13261c');
      }
    }
    // arched grate window in the lower face
    const gw = cw - 8, gx = x + 3, gy = topY + 8, gh = (botY - 4) - gy;
    inset(gx, gy, gw, gh, '#0a0d0a');
    px(gx, gy, 1, 1, '#1c2123'); px(gx + gw - 1, gy, 1, 1, '#1c2123'); // arch corners trimmed
    px(gx + 1, gy - 1, gw - 2, 1, '#15191a');                   // arch crown
    px(gx, gy + 1, gw, gh - 1, '#070a07');                      // furnace interior
    // animated ember/flame core (kept behavior)
    const beat = 0.5 + 0.5 * Math.sin(now / 260), beat2 = 0.5 + 0.5 * Math.sin(now / 170 + 1.3);
    const fh = Math.max(2, Math.round((gh - 2) * (0.55 + 0.4 * beat)));
    const fx = gx + 1, fy = gy + (gh - 1) - fh, fw = gw - 2;
    glow(gx, gy, gw, gh, '#9bff4a', 0.10 + 0.10 * beat);
    px(fx, fy, fw, fh, '#3a6b1e'); px(fx, fy + 1, fw, fh - 1, '#5fae2c');
    const cwF = Math.max(1, fw - 2);
    px(fx + 1, fy + 1, cwF, fh - 1, '#9bff4a');
    const hwF = Math.max(1, Math.round(cwF * (0.4 + 0.3 * beat2))), hcx = fx + 1 + Math.floor((cwF - hwF) / 2);
    px(hcx, fy + Math.max(1, fh - Math.round(fh * 0.7)), hwF, Math.max(1, Math.round(fh * 0.6)), '#d6ffb0');
    px(hcx, fy + fh - 2, hwF, 1, '#eaffd8');                    // hottest pixel
    if (blink(190)) px(fx + (U.hash('s1' + Math.floor(now / 190)) % fw), fy - 1, 1, 1, '#d6ffb0');
    if (blink(330, 2)) px(fx + (U.hash('s2' + Math.floor(now / 330)) % fw), fy, 1, 1, '#9bff4a');
    // grate bars + halo
    for (let i = 1; i < gw - 1; i += 2) px(gx + i, gy + 1, 1, gh - 1, '#0d130d');
    px(gx, gy + Math.floor(gh / 2), gw, 1, '#0d130d');
    px(gx - 1, gy, 1, gh + 1, '#353c3e'); px(gx + gw, gy, 1, gh + 1, '#1a1f20');
    glow(gx - 2, gy - 2, gw + 4, gh + 4, '#9bff4a', 0.14 + 0.12 * beat);
    glow(gx - 1, gy - 1, gw + 2, gh + 2, '#d6ffb0', (0.14 + 0.12 * beat) * 0.5);
    // freestanding feet + under-gap AO
    px(x + 1, botY - 1, 2, 2, r.dk); px(x + cw - 5, botY - 1, 2, 2, r.dk);
    px(x + 1, botY - 1, 1, 1, r.lit); px(x + cw - 5, botY - 1, 1, 1, r.lit);
    underAO(x + 3, botY, cw - 8, 1);
  };
  F.treasury_pnl_holo = (x, y, w, h, f) => {
  // ---- floor puck base (matte black, thin green rim light) ----
  sh(x + 2, y + h - 1, w - 4);
  const cx = x + w / 2;
  // puck body
  box(x + 2, y + h - 4, w - 4, 4, '#1a1f1d');
  px(x + 3, y + h - 3, w - 6, 2, '#111614');
  // thin rim light around top edge of puck
  px(x + 2, y + h - 4, w - 4, 1, '#3a5a2e');
  px(x + 3, y + h - 4, w - 6, 1, '#9bff4a');
  // tiny emitter notch + status dot
  px(cx - 1, y + h - 5, 2, 1, '#2a3a22');
  px(x + 3, y + h - 3, 1, 1, blink(900) ? '#9bff4a' : '#1c2a1a');

  // ---- holographic projection (translucent toxic-green stack) ----
  const G = '#9bff4a', GT = '#d6ffb0';
  const base = y + h - 5;          // hologram sits just above emitter
  const top = y;                   // rises to top of tile
  const span = base - top;         // vertical room for chart
  // subtle edge flicker of the whole holo
  const fl = 0.55 + 0.18 * flick(220) + 0.12 * flick(90, 1);

  // upward emitter cone / light spill
  glow(cx - 3, top, 6, span, G, 0.07 * fl);
  px(cx, base - 1, 1, 1, GT);

  // four ascending bar columns; one animates (grows a px then resets)
  const grow = Math.floor((now / 520) % 4);        // which bar is "alive"
  const heights = [2, 4, 6, 8];                     // ascending base heights
  const bw = 2, gap = 1;
  const startX = cx - (4 * bw + 3 * gap) / 2;
  ctx.save();
  ctx.globalAlpha = 0.42 * fl;
  for (let b = 0; b < 4; b++) {
    let hgt = heights[b] + (b === grow ? 1 + Math.floor((now / 130) % 2) : 0);
    if (hgt > span - 1) hgt = span - 1;
    const bx = Math.round(startX + b * (bw + gap));
    const by = base - 1 - hgt;
    px(bx, by, bw, hgt, G);            // translucent column body
    px(bx, by, bw, 1, GT);             // brighter top cap
  }
  ctx.restore();

  // faint scanline banding across the holo field
  ctx.save();
  ctx.globalAlpha = 0.12 * fl;
  const scan = top + 1 + Math.floor((now / 240) % span);
  for (let sy = top + 1; sy < base; sy += 2) px(cx - 4, sy, 8, 1, G);
  ctx.restore();
  // one travelling brighter scan line
  ctx.save(); ctx.globalAlpha = 0.22 * fl; px(cx - 4, scan, 8, 1, GT); ctx.restore();

  // ---- rising trend line over the bars ----
  ctx.save();
  ctx.globalAlpha = 0.7 * fl;
  px(startX, base - 3, 1, 1, GT);
  px(startX + 2, base - 4, 1, 1, GT);
  px(startX + 4, base - 6, 1, 1, GT);
  px(startX + 6, base - 8, 1, 1, GT);
  ctx.restore();

  // ---- green up-arrow glint at the peak ----
  const peakX = Math.round(startX + 6), peakY = base - 9;
  const glint = blink(640) ? GT : G;
  ctx.save();
  ctx.globalAlpha = 0.9 * fl;
  px(peakX, peakY, 1, 1, glint);              // tip
  px(peakX - 1, peakY + 1, 3, 1, glint);      // arrow head row
  px(peakX, peakY + 1, 1, 2, glint);          // shaft
  ctx.restore();
  if (f && f.work && blink(300)) glow(cx - 4, top, 8, span, G, 0.10);
};
  F.war_pivotpanel = (x, y, w, h, f) => {
  // two tone-stepped contact shadow at the base (wall unit kissing the floor)
  ctx.globalAlpha = 0.20; px(x + 2, y + h + 1, w - 4, 1, '#000'); ctx.globalAlpha = 1;
  px(x + 1, y + h, w - 2, 1, '#14161a');
  // dark gunmetal casing + brushed bezel
  box(x, y + 1, w, h, '#2a2d33');
  px(x + 1, y + 2, w - 2, 1, U.shade('#2a2d33', 0.30));            // bezel top sheen
  px(x + 1, y + 2, w - 2, 1, '#3a3e46'); px(x + 3, y + 2, 5, 1, '#464b54'); // brushed streak
  for (let i = 0; i < w; i += 3) px(x + 1 + i, y + 3, 2, 1, '#23262b'); // brushed grain
  px(x + 2, y + 2, 1, 1, '#565c66'); px(x + w - 3, y + 2, 1, 1, '#565c66'); // bezel bolts
  // split face well
  const fy = y + 4, fh = h - 5, half = (w - 6) / 2;
  inset(x + 2, fy, w - 4, fh, '#101216');
  // --- left: rose 'PIVOT' panel ---
  const lx = x + 3;
  px(lx, fy + 1, half - 1, fh - 2, '#ff5c7a');
  px(lx, fy + 1, half - 1, 1, '#ffd0d9');                          // top hi
  px(lx, fy + 2, 1, fh - 3, U.shade('#ff5c7a', 0.22));            // left hi edge
  px(lx, fy + fh - 2, half - 1, 1, U.shade('#ff5c7a', -0.4));     // bottom shade
  // baked 'PIVOT' glyph row (tiny 1px ticks reading as letters)
  for (let i = 0; i < 5; i++) px(lx + 1 + i * 2, fy + 3, 1, 2, '#ffd0d9');
  px(lx + 2, fy + 4, 1, 1, '#a8324a'); px(lx + 6, fy + 4, 1, 1, '#a8324a');
  // --- amber seam down the middle ---
  const sx = lx + half;
  px(sx, fy, 1, fh, '#ffb84d'); px(sx, fy, 1, 1, '#ffe1a0');
  px(sx, fy + 1, 1, fh - 2, U.shade('#ffb84d', -0.15));
  // --- right: periwinkle 'PERSEVERE' panel ---
  const rx = sx + 1;
  px(rx, fy + 1, half - 1, fh - 2, '#a0a8ff');
  px(rx, fy + 1, half - 1, 1, '#d4d8ff');                          // top hi
  px(rx + half - 2, fy + 2, 1, fh - 3, U.shade('#a0a8ff', -0.28)); // right shade
  px(rx, fy + fh - 2, half - 1, 1, U.shade('#a0a8ff', -0.35));
  for (let i = 0; i < 5; i++) px(rx + 1 + i * 2, fy + 3, 1, 2, '#d4d8ff'); // 'PERSEVERE' ticks
  px(rx + 3, fy + 4, 1, 1, '#5a64b8'); px(rx + 7, fy + 4, 1, 1, '#5a64b8');
  // faint 2px scanline drifting down the lit halves
  const sc = fy + 1 + Math.floor((now / 240) % (fh - 2));
  glow(lx, sc, half - 1, 2, '#fff', 0.10); glow(rx, sc, half - 1, 2, '#fff', 0.10);
  // magnetic chrome puck resting on the PERSEVERE side
  const pcx = rx + half - 4, pcy = fy + fh - 4;
  ctx.globalAlpha = 0.30; px(pcx - 1, pcy + 2, 4, 1, '#000'); ctx.globalAlpha = 1;
  px(pcx, pcy, 3, 2, '#c8ccd6'); px(pcx, pcy, 3, 1, '#eef0f6'); px(pcx, pcy + 1, 3, 1, '#8a8e98');
  px(pcx, pcy, 1, 1, '#ffffff');
  // single seam LED: pulses rose then fades every few frames
  const pulse = Math.max(0, Math.sin(now / 700));
  glow(sx, fy + 2 + Math.floor(fh / 2), 1, 2, '#ff5c7a', 0.25 + 0.65 * pulse);
  if (pulse > 0.6) px(sx, fy + 2 + Math.floor(fh / 2), 1, 1, '#ffd0d9');
};
  F.war_intelcab = (x, y, w, h, f) => {   // TALL 3/4 file cabinet (1x2), bolted; sealed drawers; ACC.work green (files)
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);                                 // floor contact
    deckPlate(x - 1, y + h - 5, w + 2, 5);                            // bolted plate peeks at feet
    deckSocket(x + w + 1, y + h - 3, f && f.work);                    // cable into floor socket
    // TALL body: chamfered slab, lit W / dark E facets, top cap
    rr(x - 1, y - 3, w + 2, h + 2, LINE);
    px(x + 1, y - 1, w - 2, h, r.face);
    px(x + 1, y - 1, 2, h, U.shade(r.face, 0.10)); px(x + w - 3, y - 1, 2, h, r.dk);   // beveled side rails
    px(x + 1, y - 1, 1, h, r.lit);
    rr(x, y - 5, w, 3, LINE);
    px(x + 1, y - 4, w - 2, 2, r.top); px(x + 1, y - 4, w - 2, 1, r.sheen);            // top cap
    px(x + 2, y - 3, 4, 1, U.shade(r.sheen, 0.12));
    // four stacked sealed drawers
    const dx = x + 3, dw = w - 8, top = y + 1, span = h - 4, dh = Math.floor(span / 4);
    const rip = Math.floor(now / 320) % 4;                            // ripple phase top-to-bottom
    for (let d = 0; d < 4; d++) {
      const dy = top + d * dh;
      inset(dx, dy + 1, dw, dh - 2, U.shade(r.face, -0.18));
      px(dx + 1, dy + 2, dw - 2, dh - 4, U.shade(r.face, 0.06));      // face plate
      px(dx + 1, dy + 2, dw - 2, 1, r.lit);                           // face top hi
      px(dx + 1, dy + dh - 3, dw - 2, 1, r.ao);                       // face seam shade
      const hy = dy + Math.floor(dh / 2);
      inset(dx + Math.floor(dw / 2) - 3, hy, 6, 2, '#141b18');        // recessed handle
      const lit = d === rip;                                          // status LED ripple — ACC.work
      px(dx + 2, hy, 2, 2, lit ? ACC.work : U.shade(ACC.work, -0.6));
      if (lit) glow(dx + 1, hy - 1, 4, 4, ACC.work, 0.45);
    }
    // top drawer cracked open: sliver of glowing green file edge
    const odY = top + 1;
    px(dx, odY, dw, 2, '#141b18');                                    // dark gap above the files
    px(dx + 1, odY + 2, dw - 2, 1, blink(700) ? '#c7ffe0' : ACC.work); // glowing paper edge
    glow(dx, odY, dw, 4, ACC.work, 0.20 + 0.06 * Math.sin(now / 600));
    // vertical label strip down the right edge, faint green glow
    const sx = x + w - 5; inset(sx, y + 1, 3, h - 4, '#1c2420');
    px(sx + 1, y + 2, 1, h - 6, U.shade(ACC.work, 0.05));
    for (let i = 0; i < (h - 6); i += 4) px(sx, y + 3 + i, 3, 1, U.shade(ACC.work, -0.5));
    glow(sx - 1, y + 1, 5, h - 4, ACC.work, 0.12);
    px(x + 1, y + h - 2, w - 2, 1, r.ao);                             // floor-line AO
  };
  F.war_threatcore = (x, y, w, h, f) => {
  // floor prop: contact shadow + rose emissive halo bleeding onto floor
  sh(x + 1, y + h - 1, w - 2);
  const hot = f.work ? 1 : 0.55;
  glow(x - 1, y + h - 3, w + 2, 3, '#ff5c7a', (0.10 + 0.05 * hot) + 0.04 * Math.sin(now / 900));

  // slim vertical column â€” black anodized housing, inset 2px each side
  const cx = x + 2, cw = w - 4;
  box(cx, y + 3, cw, h - 4, '#1c1e22');
  px(cx, y + 3, cw, 1, U.shade('#1c1e22', 18)); // top-lit edge
  px(cx, y + h - 2, cw, 1, '#0d0e10');           // bottom shade
  px(cx, y + 3, 1, h - 5, '#0d0e10');            // left shade rail
  px(cx + cw - 1, y + 3, 1, h - 5, U.shade('#1c1e22', 10));

  // rounded cap â€” trim the top corners with shade
  px(cx, y + 3, 1, 1, '#0d0e10');
  px(cx + cw - 1, y + 3, 1, 1, '#0d0e10');
  px(cx + 1, y + 2, cw - 2, 1, '#1c1e22');
  px(cx + 1, y + 2, cw - 2, 1, U.shade('#1c1e22', 22));

  // smoked-glass front well with stacked 5-segment readout (fills bottom-up)
  const gx = cx + 1, gy = y + 6, gw = cw - 2, gh = 11;
  inset(gx, gy, gw, gh, '#0d0e10');
  const segs = 5, seglvl = f.work ? 5 : 3;
  const topAmber = blink(1400); // slow warning loop on the top segment
  for (let s = 0; s < segs; s++) {
    const sy = gy + gh - 2 - s * 2; // bottom-up
    if (s < seglvl) {
      const isTop = s === seglvl - 1;
      const col = (isTop && topAmber) ? '#ffb84d' : '#ff5c7a';
      px(gx + 1, sy, gw - 2, 1, col);
      px(gx + 1, sy, gw - 2, 1, U.shade(col, 14)); // segment hi-edge
    } else {
      px(gx + 1, sy, gw - 2, 1, '#16171a'); // unlit segment, behind smoked glass
    }
  }
  // smoked-glass sheen
  px(gx, gy, 1, gh, U.shade('#1c1e22', 6));
  glow(gx, gy, gw, gh, (topAmber ? '#ffb84d' : '#ff5c7a'), 0.06 + 0.05 * hot);

  // three horizontal vent slits below the glass, with lit top edge
  for (let v = 0; v < 3; v++) {
    const vy = gy + gh + 1 + v * 2;
    px(cx + 1, vy, cw - 2, 1, '#0d0e10');
    px(cx + 1, vy, cw - 2, 1, '#4a4e55');
  }

  // rose glow bleeding from the seams onto the housing
  glow(cx - 1, gy, 1, gh, '#ff5c7a', 0.08 + 0.05 * hot);
  glow(cx + cw, gy, 1, gh, '#ff5c7a', 0.08 + 0.05 * hot);

  // crown: single rotating radar sweep dot orbiting a tiny hub
  const hubx = x + w / 2, huby = y + 1;
  px(hubx - 1, huby, 2, 1, '#4a4e55');
  const a = (now / 600);
  const dx = Math.round(Math.cos(a) * 2), dy = Math.round(Math.sin(a) * 1);
  px(hubx - 1 + dx, huby + dy, 1, 1, f.work ? '#ffd9e2' : '#ff5c7a');
  if (f.work) glow(hubx - 2, huby - 1, 4, 2, '#ff5c7a', 0.16);
};
  F.pub_publishpress = (x, y, w, h, f) => {
  // ---- pulse / fire timing ----
  const PER = 1500;
  const ph = (now % PER) / PER;                 // 0..1 across the print cycle
  const fire = Math.max(0, Math.sin(ph * Math.PI * 2));   // 0..1, peaks mid-cycle
  const firing = ph > 0.18 && ph < 0.42;        // the brief 'snap' window
  const heat = (f && f.work) ? 0.45 + 0.55 * fire : 0.18 + 0.30 * fire;

  // ---- contact shadow, slightly wide at base ----
  sh(x + 1, y + h - 1, w - 2);
  sh(x, y + h - 1, 2); sh(x + w - 2, y + h - 1, 2);

  // ---- boxy press frame (gunmetal), wider base ----
  box(x, y + 2, w, h - 2, '#3a3f3a');
  px(x + 1, y + 3, w - 2, 1, U.shade('#3a3f3a', 18));     // top-lit lip
  px(x + 1, y + h - 4, w - 2, 3, '#2a2e2a');              // base mass shading
  px(x - 1, y + h - 3, w + 2, 2, '#23272a');             // splayed footing
  px(x, y + h - 1, w, 1, '#1b1f1d');

  // ---- top roller drum (cylinder) ----
  const drumY = y + 2, drumH = 8;
  box(x + 1, drumY, w - 2, drumH, '#33383a');
  // cylindrical banding: top highlight, dark belly
  px(x + 2, drumY + 1, w - 4, 1, U.shade('#33383a', 26));
  px(x + 2, drumY + 2, w - 4, 2, U.shade('#33383a', 10));
  px(x + 2, drumY + 4, w - 4, 2, '#2a2e2a');
  px(x + 2, drumY + 6, w - 4, 1, '#23272a');
  // end-cap hubs
  inset(x + 1, drumY + 2, 3, 4, '#22262a'); px(x + 2, drumY + 3, 1, 2, '#454d4a');
  inset(x + w - 4, drumY + 2, 3, 4, '#22262a'); px(x + w - 3, drumY + 3, 1, 2, '#454d4a');

  // ---- fabric/poster stock feeding over the top roller, gold test grid ----
  const sheetX = x + 4, sheetW = w - 8, sheetTop = y - 3;
  px(sheetX, sheetTop, sheetW, drumY - sheetTop + 2, '#cdd2cc');      // sheet body
  px(sheetX, sheetTop, sheetW, 1, '#e6eae4');                          // lit top edge
  px(sheetX, sheetTop, 1, drumY - sheetTop + 2, '#b6bbb4');
  // faint gold test-pattern grid
  for (let gx = 0; gx < sheetW; gx += 3) px(sheetX + gx, sheetTop + 1, 1, drumY - sheetTop, '#ffe066');
  for (let gy = 0; gy < (drumY - sheetTop + 1); gy += 2) px(sheetX, sheetTop + 1 + gy, sheetW, 1, U.shade('#ffe066', -6));
  glow(sheetX, sheetTop, sheetW, drumY - sheetTop + 2, '#ffe066', 0.10);

  // ---- chrome side pistons ----
  const pisY = y + 11, pisH = h - 15;
  box(x, pisY, 3, pisH, '#5a625e'); px(x + 1, pisY, 1, pisH, '#8a928c'); px(x + 1, pisY + 1, 1, 2, '#cfd6d0');
  box(x + w - 3, pisY, 3, pisH, '#5a625e'); px(x + w - 2, pisY, 1, pisH, '#8a928c'); px(x + w - 2, pisY + 1, 1, 2, '#cfd6d0');

  // ---- front face: recessed heat plate, amber->gold gradient ----
  const plX = x + 4, plY = y + 12, plW = w - 8, plH = h - 17;
  inset(plX - 1, plY - 1, plW + 2, plH + 2, '#241f16');
  // vertical amber-to-gold gradient bands
  const bands = plH;
  for (let i = 0; i < bands; i++) {
    const t = i / Math.max(1, bands - 1);                 // 0 top -> 1 bottom
    const base = t < 0.5 ? U.shade('#ff8a1e', Math.round(t * 30))      // amber lower
                         : U.shade('#ffc24a', Math.round((t - 0.5) * 24)); // gold upper-ish
    px(plX, plY + (plH - 1 - i), plW, 1, base);
  }
  // emissive heat wash (THE animated accent)
  glow(plX, plY, plW, plH, '#ffb030', 0.16 + 0.34 * heat);
  if (firing) glow(plX - 1, plY - 1, plW + 2, plH + 2, '#ffe066', 0.10 + 0.30 * fire);
  // hot core line brightens on fire
  px(plX + 1, plY + Math.floor(plH / 2), plW - 2, 1, firing ? '#fff0b0' : '#ffcf66');

  // ---- warm rim-light along the top edge ----
  px(x + 1, y + 2, w - 2, 1, '#ffe066');
  px(x + 1, y + 2, Math.floor(w / 3), 1, U.shade('#ffe066', 14));

  // ---- status panel: three tiny LEDs ----
  const spX = x + w - 7, spY = y + h - 9;
  inset(spX, spY, 6, 6, '#1a1f1c');
  px(spX + 1, spY + 1, 1, 1, '#41ff8a');                              // steady green
  px(spX + 4, spY + 1, 1, 1, blink(750) ? '#ffe066' : '#3a3210');     // blinking gold
  px(spX + 1, spY + 4, 1, 1, firing ? '#ff9d2e' : '#2a2014');         // fires with print
  if (blink(750)) glow(spX + 3, spY, 3, 3, '#ffe066', 0.30);

  // ---- thin steam wisp from top seam, on the pulse ----
  if (firing) {
    const sx = sheetX + Math.floor(sheetW / 2);
    ctx.save();
    ctx.globalAlpha = 0.18 + 0.18 * fire;
    px(sx, sheetTop - 1, 1, 2, '#ffffff');
    px(sx + (blink(220) ? 1 : -1), sheetTop - 3, 1, 2, '#ffffff');
    px(sx, sheetTop - 5, 1, 1, '#ffffff');
    ctx.restore();
  }
};
  F.pub_outboundchute = (x, y, w, h, f) => {
  // vertical pneumatic OUTBOUND shipping chute, 1x2 (w=12, h=24)
  sh(x + 1, y + h - 1, w - 2);
  const tube = '#33372f', dk = '#232722';

  // ---- flared hopper mouth at top ----
  box(x - 1, y, w + 2, 5, tube);                       // wide flare
  px(x, y + 1, w, 1, U.shade(tube, 0.22));
  inset(x + 1, y + 1, w - 2, 3, dk);                   // dark throat
  // thin gold ring-light around the opening (subtle pulse)
  const ring = 0.45 + 0.25 * Math.sin(now / 600);
  glow(x + 1, y + 1, w - 2, 1, '#ffe066', ring);
  glow(x + 1, y + 1, 1, 3, '#ffe066', ring * 0.7);
  glow(x + w - 2, y + 1, 1, 3, '#ffe066', ring * 0.7);
  px(x + 2, y + 2, w - 4, 1, '#1a1d17');               // mouth shadow

  // ---- angled tube column body ----
  box(x + 1, y + 5, w - 2, h - 11, tube);
  px(x + 2, y + 6, w - 4, 1, U.shade(tube, 0.18));     // top sheen
  px(x + 2, y + 6, 1, h - 13, U.shade(tube, 0.10));    // left light edge
  px(x + w - 3, y + 6, 1, h - 13, U.shade(tube, -0.3)); // right shade

  // ---- glass viewport slit with parcel mid-drop ----
  const sx = x + 3, sw = w - 6, sy = y + 7, sh2 = h - 16;
  inset(sx, sy, sw, sh2, '#0d100c');                   // recessed glass well
  glow(sx + 1, sy, 1, sh2, '#9ab0a0', 0.10);           // glass highlight
  ctx.save(); ctx.beginPath(); ctx.rect(sx + 1, sy + 1, sw - 2, sh2 - 2); ctx.clip();
  const ph = (now / 2000) % 1;                         // ~2s loop, box slides down + vanishes
  const py2 = sy + 1 + Math.floor(ph * (sh2 + 1));
  if (ph < 0.92) {
    px(sx + 2, py2, 3, 3, '#36424c');                  // steel parcel case
    px(sx + 2, py2, 3, 1, '#46525a');                  // lit top
    px(sx + 2, py2 + 1, 1, 2, '#28323a');              // side shade
    px(sx + 3, py2 + 1, 1, 1, '#caa84a');              // tape strip
  }
  ctx.restore();
  px(sx, sy, 1, sh2, '#161a14'); px(sx + sw - 1, sy, 1, sh2, '#161a14'); // slit frame

  // ---- banded lower barrel ----
  const by = y + h - 7;
  box(x, by, w, 7, dk);
  px(x + 1, by + 1, w - 2, 1, U.shade(dk, 0.2));
  for (let i = 0; i < 2; i++) px(x + 1, by + 1 + i * 3, w - 2, 1, U.shade(dk, -0.35)); // band seams
  // stenciled white 'â†“ SHIP'
  px(x + 2, by + 2, 1, 1, '#e6ece2'); px(x + 1, by + 3, 3, 1, '#e6ece2'); px(x + 2, by + 4, 1, 1, '#e6ece2'); // down arrow
  ctx.fillStyle = '#e6ece2'; ctx.font = '5px monospace'; ctx.fillText('SHIP', x + 4, by + 4);
  // tiny barcode decal
  for (let i = 0; i < 7; i++) px(x + 2 + i, by + 5, 1, 1, (U.hash('bc' + i) % 2) ? '#dfe8df' : '#1a1d17');

  // ---- corner rivets ----
  for (const rx of [x + 1, x + w - 2]) for (const ry of [y + 6, y + h - 6]) {
    px(rx, ry, 1, 1, '#5c6055'); px(rx, ry + 1, 1, 1, '#14170f');
  }
};
  F.pub_mailpod = (x, y, w, h, f) => {
  // ---- pneumatic-tube SORTER feeder, 2x1 footprint, floor prop ----
  sh(x + 1, y + h - 1, w - 2);
  // main grey-green console block, 2-tone outlined metal casing
  box(x, y + 2, w, h - 3, '#2b302a');
  px(x + 1, y + 3, w - 2, h - 5, '#3a4038');
  px(x + 1, y + 3, w - 2, 1, U.shade('#3a4038', 26)); // top highlight (tone 1)
  px(x + 1, y + 4, w - 2, 1, U.shade('#3a4038', 12)); // 2-tone top highlight (tone 2)
  px(x + 1, y + h - 3, w - 2, 1, '#23271f');           // lower shade line

  // steel intake pipe arcing off the right edge toward wall tube
  px(x + w - 3, y + 1, 3, 2, '#36424c');
  px(x + w - 1, y, 2, 2, '#46525a');
  px(x + w, y - 1, 1, 2, '#56646e');
  px(x + w - 3, y + 1, 3, 1, '#6a7882');

  // two round transparent capsule bays
  const cy = y + 4 + Math.floor((h - 7) / 2);
  // deterministic per-bay refill timing; right bay 'thunks' on a ~2.5s cycle
  const thunk = Math.floor(now / 2500) % 2 === 0 && (now % 2500) < 220;
  const bays = [
    { cx: x + 4, empty: false },
    { cx: x + w - 6, empty: thunk } // right bay briefly flashes empty then refills
  ];
  for (let b = 0; b < 2; b++) {
    const bx = bays[b].cx, r = 3;
    inset(bx - r - 1, cy - r - 1, r * 2 + 2, r * 2 + 2, '#1c211b'); // recessed dark well
    // glass bay body
    px(bx - r, cy - r, r * 2, r * 2, '#23302c');
    px(bx - r, cy - r, r * 2, 1, U.shade('#23302c', 30));
    if (!bays[b].empty) {
      // steel rolled capsule inside
      px(bx - 2, cy - 2, 4, 4, '#56646e');
      px(bx - 2, cy - 2, 4, 1, '#6a7882');
      px(bx - 1, cy - 1, 1, 2, '#28323a'); // rolled core shadow
    } else {
      px(bx - 2, cy - 1, 4, 2, '#161b15'); // empty bay interior
    }
    // transparent glass sheen
    glow(bx - r, cy - r, r * 2, 1, '#bfeaff', 0.22);
    px(bx - r + 1, cy - r + 1, 1, 1, '#dff4ff');
  }

  // tiny indicators above each bay
  // left: steady cyan-white  |  right: blinking gold (the ONE animated emissive accent)
  const lx = bays[0].cx, rx = bays[1].cx, iy = y + 3;
  px(lx, iy, 1, 1, '#dff6ff');
  glow(lx - 1, iy - 1, 3, 3, '#aef0ff', 0.30);
  const goldOn = blink(620);
  px(rx, iy, 1, 1, goldOn ? '#ffe066' : '#28323a');
  if (goldOn) glow(rx - 1, iy - 1, 3, 3, '#ffe066', 0.34);

  // central feed slot into the room's mail tube + a couple of seam rivets
  inset(x + Math.floor(w / 2) - 1, y + h - 5, 3, 3, '#1a1f18');
  px(x + 2, y + h - 4, 1, 1, '#1d221b');
  px(x + w - 3, y + h - 4, 1, 1, '#1d221b');
};
  F.arc_indexwall = (x, y, w, h, f) => {
  // soft contact shadow along the base
  sh(x + 1, y + h + 2, w - 2);
  // dark gun-metal grey-green casing with brushed bevel
  box(x, y + 1, w, h + 1, '#2b3330');
  px(x + 1, y + 2, w - 2, 1, '#3a443f');            // top bevel sheen
  for (let i = 2; i < w - 2; i += 3) px(x + i, y + 3, 1, h - 3, '#28302d'); // brushed flutes
  // thin silver top rail (room accent)
  px(x, y, w, 1, '#c0c0c0');
  px(x + 1, y + 1, w - 2, 1, '#7e8480');
  glow(x + 1, y, w - 2, 1, '#e6e6e6', 0.12);
  // recessed face well that holds the catalogue grid
  inset(x + 2, y + 3, w - 4, h - 4, '#161c1a');
  // 6-column x 3-row grid of tiny back-lit index cards / catalogue slips
  const cols = 6, rows = 3;
  const gw = w - 6, gh = h - 6;
  const cw = gw / cols, ch = gh / rows;
  const land = Math.floor(now / 1000);           // one query 'lands' per second
  const litIdx = land % (cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x + 3 + Math.round(c * cw);
      const cy = y + 4 + Math.round(r * ch);
      const idx = r * cols + c;
      // base pale silver-white slip, deterministic 1-2px width variation
      const sw = 2 + (U.hash('ix' + idx) % 2);
      const flip = idx === litIdx;               // this card flips to faint cyan-white
      px(cx, cy, Math.min(sw, Math.round(cw) - 1), 2, flip ? '#bfeefe' : '#b8c0bc');
      px(cx, cy, Math.min(sw, Math.round(cw) - 1), 1, flip ? '#e6fbff' : '#d6dedb');
      if (flip) glow(cx - 1, cy - 1, Math.round(cw), 3, '#8fdfff', 0.4);
      px(cx, cy + 2, Math.round(cw) - 1, 1, '#0e1413'); // slip slot shadow
    }
  }
  // 1px silver scan-line sweeping left->right on a slow loop
  const sweep = x + 3 + Math.floor((now / 30) % (w - 6));
  glow(sweep, y + 4, 1, h - 6, '#dfe6e2', 0.5);
  // two recessed status dots at the lower corners
  inset(x + 2, y + h - 2, 3, 3, '#1a201d');
  px(x + 3, y + h - 1, 1, 1, '#ffb24a');           // steady amber
  glow(x + 3, y + h - 1, 1, 1, '#ffd34a', 0.4);
  inset(x + w - 5, y + h - 2, 3, 3, '#1a201d');
  px(x + w - 4, y + h - 1, 1, 1, blink(700) ? '#e6e6e6' : '#3a423e'); // blinking silver
};
  F.arc_microfiche = (x, y, w, h, f) => {
  // wall-mounted microfiche reader, 2x1. dark metal box with frosted viewport + flanking reels.
  sh(x + 1, y + h + 2, w - 2);
  box(x, y + 1, w, h - 1, '#2b3330');
  px(x + 1, y + 2, w - 2, 1, U.shade('#2b3330', 18));      // top hi-light
  px(x + 1, y + h - 2, w - 2, 1, U.shade('#2b3330', -16)); // bottom shade
  // worn archival speckle on the casing
  for (let i = 0; i < 4; i++) {
    const sx = x + 2 + (U.hash('mf' + i) % (w - 4));
    const sy = y + 3 + (U.hash('mfy' + i) % (h - 6));
    px(sx, sy, 1, 1, U.shade('#2b3330', -10));
  }

  // notch advance: one step every ~2.2s
  const step = Math.floor(now / 2200);
  // frame-advance window: brief flicker right after a step
  const advancing = (now % 2200) < 260;
  const lit = f.work;

  // --- centered frosted glass viewport ---
  const vw = w - 16, vx = x + 8, vy = y + 3, vh = h - 8;
  box(vx - 1, vy - 1, vw + 2, vh + 2, '#161c1a');
  inset(vx, vy, vw, vh, '#3a4744');
  // cool silver-white frosted glow
  const base = lit ? 0.34 : 0.16;
  const flk = advancing ? 0.14 * Math.abs(flick(70)) : 0.05 * Math.sin(now / 500);
  glow(vx, vy, vw, vh, '#c8d8da', base + flk);
  px(vx + 1, vy + 1, vw - 2, 1, '#dfeceb');               // top sheen
  // single dim film frame faintly visible inside, shifts as it advances
  const fx = vx + 3 + (step % 2);
  px(fx, vy + 2, vw - 6, vh - 4, lit ? '#aebcbe' : '#8a9698');
  px(fx + 1, vy + 3, 2, vh - 6, U.shade('#aebcbe', -22));  // faint frame detail
  px(fx + vw - 8, vy + 3, 1, vh - 6, U.shade('#aebcbe', -22));
  px(fx + 2, vy + Math.floor(vh / 2), vw - 11, 1, U.shade('#aebcbe', -28));
  if (advancing) px(vx + 1, vy + 1 + (step % (vh - 2)), vw - 2, 1, '#eef6f5'); // advance scan line

  // --- two reel hubs flanking viewport (chrome-grey) ---
  const ry = y + Math.floor(h / 2);
  const reel = (cx) => {
    px(cx - 3, ry - 3, 6, 6, '#6e7474');                  // hub body
    px(cx - 2, ry - 2, 4, 4, '#9aa0a0');
    px(cx - 2, ry - 2, 4, 1, U.shade('#9aa0a0', 20));     // top-lit chrome
    px(cx - 1, ry + 1, 2, 1, U.shade('#9aa0a0', -26));    // bottom shade
    // spoke that rotates one notch per step (4 orientations)
    const o = step % 4;
    if (o === 0) { px(cx - 2, ry, 4, 1, '#d8dcdc'); }
    else if (o === 1) { px(cx, ry - 2, 1, 4, '#d8dcdc'); }
    else if (o === 2) { px(cx - 2, ry - 1, 1, 1, '#d8dcdc'); px(cx + 1, ry, 1, 1, '#d8dcdc'); }
    else { px(cx + 1, ry - 1, 1, 1, '#d8dcdc'); px(cx - 2, ry, 1, 1, '#d8dcdc'); }
    px(cx, ry, 1, 1, '#4a5050');                          // center pin
  };
  const lcx = x + 4, rcx = x + w - 5;
  reel(lcx);
  reel(rcx);
  // hair-thin silver film strip drawn between the reels, threaded across the top
  px(lcx + 2, ry - 4, rcx - lcx - 4, 1, '#b8bebe');
  px(lcx + 2, ry - 4, rcx - lcx - 4, 1, advancing ? '#e4e8e8' : '#b8bebe');
  px(lcx + 2, ry + 3, rcx - lcx - 4, 1, U.shade('#b8bebe', -22)); // lower strand

  // --- silver accent label plate under the screen ---
  const ly = y + h - 4;
  px(x + 7, ly, w - 14, 3, '#c0c0c0');
  px(x + 7, ly, w - 14, 1, U.shade('#c0c0c0', 16));
  for (let i = 0; i < (w - 18); i += 3) px(x + 9 + i, ly + 1, 2, 1, '#6a6e6e'); // engraved text

  // --- tiny green 'ready' LED ---
  const on = lit ? blink(900) : blink(2600);
  px(x + w - 4, y + 2, 1, 1, on ? '#41ff8a' : '#16302a');
  if (on) glow(x + w - 5, y + 1, 3, 3, '#41ff8a', 0.4);
};
  F.arc_floorlight = (x, y, w, h, f) => {
  // Flush in-floor guidance light â€” completely flat, no contact shadow (agents walk over it).
  // Recessed dark slot down the centre holding a thin silver-white pulsing light bar.
  const cx = x + w / 2;
  const slotW = Math.max(4, (w >> 1) + 1);     // recessed slot width
  const sx = Math.round(cx - slotW / 2);
  const slotY = y + 1;
  const slotH = h - 2;

  // 1) Recessed dark slot well, beveled into the floor (top-dark / bottom faint catch-light).
  inset(sx, slotY, slotW, slotH, '#1f2422');
  px(sx, slotY, slotW, 1, '#171b19');                 // deep top lip shadow
  px(sx, slotY + slotH - 1, slotW, 1, U.shade('#1f2422', 6)); // faint bottom bevel catch

  // 2) The thin silver-white light bar, vertical down the aisle, gently pulsing.
  const pulse = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(now / 1300)); // 0.62..1.0 slow breath
  const barX = Math.round(cx) - (slotW >= 6 ? 1 : 0);
  const barW = slotW >= 6 ? 2 : 1;
  const barTop = slotY + 2;
  const barH = slotH - 4;
  const bar = U.shade('#dfe2e0', -12 + Math.round(pulse * 12)); // dimmer at trough
  px(barX, barTop, barW, barH, bar);
  // hot core highlight at peak brightness
  ctx.save();
  ctx.globalAlpha = pulse;
  px(barX, barTop, barW, barH, '#dfe2e0');
  px(barX, barTop + 1, 1, Math.max(2, barH - 2), U.shade('#dfe2e0', 18)); // sharp inner glint
  ctx.restore();

  // 3) Faint silver glow bleeding ~1px onto surrounding floor (the depth-lighting).
  glow(sx - 1, slotY, slotW + 2, slotH, '#cfe0e2', 0.05 + 0.06 * pulse);
  glow(barX - 1, barTop, barW + 2, barH, '#eef2f2', 0.07 + 0.1 * pulse);

  // 4) Tiny etched arrow in dim cyan-grey pointing down the aisle (toward +y).
  const ay = y + h - 4;
  const acx = Math.round(cx);
  const arr = '#56706e';
  px(acx, ay, 1, 1, arr);                 // tip
  px(acx - 1, ay - 1, 3, 1, arr);         // mid row
  px(acx - 2, ay - 2, 5, 1, U.shade(arr, -10)); // upper, dimmest
};
  F.arc_ladder = (x, y, w, h, f) => {
  // soft contact shadow â€” low parked object on the floor
  sh(x + 1, y + h - 1, w - 2);

  // ladder runs vertically within the tile; leave margin so it reads as a slim object
  const railW = 2;                       // rail thickness
  const lx = x + 3;                      // left rail x
  const rx = x + w - 3 - railW;          // right rail x
  const top = y + 2;                     // ladder top
  const bot = y + h - 3;                 // ladder bottom (above caster)
  const len = bot - top;                 // rail run length

  // ---- caster wheel hint at the base (dark rubber) ----
  inset(x + 3, y + h - 4, w - 6, 3, '#171b19');
  px(lx, y + h - 3, railW, 2, '#1f2422');
  px(rx, y + h - 3, railW, 2, '#1f2422');
  px(lx, y + h - 3, railW, 1, '#2a302d');   // faint top edge on rubber

  // ---- two thin chrome-grey rails (2-tone) ----
  px(lx, top, railW, len, '#9aa0a0');
  px(rx, top, railW, len, '#9aa0a0');
  px(lx, top, 1, len, U.shade('#9aa0a0', 22));      // lit left edge
  px(rx + railW - 1, top, 1, len, U.shade('#9aa0a0', -28)); // shaded right edge
  px(lx + railW - 1, top, 1, len, U.shade('#9aa0a0', -22));

  // ---- short rungs between the rails ----
  const rungs = 4;
  const gap = Math.floor(len / (rungs + 1));
  for (let i = 1; i <= rungs; i++) {
    const ry = top + gap * i;
    px(lx + railW, ry, rx - (lx + railW), 2, '#878d8d');
    px(lx + railW, ry, rx - (lx + railW), 1, U.shade('#878d8d', 18)); // top-lit
    px(lx + railW, ry + 1, rx - (lx + railW), 1, '#5a605e');          // under-shade
  }

  // ---- slim silver hook bracket at the top, accent-tinted ----
  px(lx, top - 1, railW, 1, '#c0c0c0');
  px(rx, top - 1, railW, 1, '#c0c0c0');
  px(lx, top - 2, rx + railW - lx, 1, U.shade('#c0c0c0', -20)); // bracket span
  px(rx - 1, top - 2, 1, 2, '#c0c0c0');                          // hook lip
  px(lx + 1, top - 2, 1, 2, U.shade('#c0c0c0', 12));

  // ---- ONE subtle animated emissive accent: slow chrome glint drifting on top rail ----
  const g = 0.18 + 0.16 * Math.sin(now / 1400);
  const glintY = top + 1 + ((Math.floor(now / 700) % Math.max(1, (len - 2))));
  glow(lx, glintY, 1, 1, '#eaf2f2', g);
  px(lx, top + 1, 1, 1, '#dfe6e6'); // fixed faint highlight glint on top rail
};
  F.quarters_pooltable = (x, y, w, h, f) => {
  // soft drop shadow under whole table
  sh(x + 1, y + h - 1, w - 2);

  // ---- outer metal rail casing (rounded-corner rect) ----
  box(x, y + 1, w, h - 1, '#3a3f3c');
  // top-lit rail highlight
  px(x + 1, y + 2, w - 2, 1, '#555b56');
  // chip the four corners to fake rounding
  px(x, y + 1, 1, 1, '#2a2e2c'); px(x + w - 1, y + 1, 1, 1, '#2a2e2c');
  px(x, y + h - 1, 1, 1, '#2a2e2c'); px(x + w - 1, y + h - 1, 1, 1, '#2a2e2c');

  // ---- felt bed (recessed) ----
  const bx = x + 4, by = y + 4, bw = w - 8, bh = h - 8;
  inset(bx - 1, by - 1, bw + 2, bh + 2, '#23402c');
  // two-tone felt with diagonal light gradient (lighter toward top-left)
  px(bx, by, bw, bh, '#2f5d3a');
  for (let i = 0; i < bh; i++) {
    const lit = bw - Math.round((i / bh) * bw);
    if (lit > 0) px(bx, by + i, Math.min(lit, bw), 1, '#3c7048');
  }
  // subtle felt sheen line top
  px(bx, by, bw, 1, U.shade('#3c7048', 18));

  // ---- six pockets: near-black holes ringed dark ----
  const pk = [
    [bx - 2, by - 2], [bx + (bw >> 1) - 1, by - 3], [bx + bw, by - 2],
    [bx - 2, by + bh - 1], [bx + (bw >> 1) - 1, by + bh], [bx + bw, by + bh - 1]
  ];
  for (const [pxn, pyn] of pk) {
    px(pxn, pyn, 4, 4, '#1a1c1b');
    px(pxn + 1, pyn + 1, 2, 2, '#0c0d0c');
  }

  // ---- warm amber edge-light along top rail + pocket liners (pulsing) ----
  const pulse = 0.28 + 0.16 * (0.5 + 0.5 * Math.sin(now / 760));
  glow(x + 1, y + 1, w - 2, 2, '#ffb84d', pulse);
  px(x + 2, y + 1, w - 4, 1, U.shade('#ffb84d', -8));
  for (const [pxn, pyn] of pk) glow(pxn, pyn, 4, 4, '#ffb84d', pulse * 0.5);

  // ---- balls: cue-spot, 8-ball, muted red/blue ----
  const drift = Math.round(Math.sin(now / 1400)); // one ball slowly drifts a px
  const balls = [
    [bx + 3, by + 2, '#ffb84d'],                 // amber cue-spot
    [bx + (bw >> 1) + 1 + drift, by + (bh >> 1), '#15161a'], // 8-ball
    [bx + bw - 4, by + 2, '#a83a32'],            // muted red
    [bx + 2, by + bh - 4, '#3a5aa8'],            // muted blue
    [bx + bw - 3, by + bh - 3, '#2e3840'],       // dark steel
    [bx + (bw >> 1) - 3, by + bh - 2, '#3a6a8a'] // dark blue
  ];
  for (const [bxn, byn, col] of balls) {
    px(bxn + 1, byn + 2, 3, 1, '#1c3326');            // contact shadow on felt
    px(bxn, byn, 3, 3, col);
    px(bxn, byn, 2, 1, U.shade(col, 26));             // upper body shade
    px(bxn, byn, 1, 1, U.shade(col, 60));             // 1px specular highlight
    px(bxn + 2, byn + 2, 1, 1, U.shade(col, -34));    // far-side shade
  }
};
  F.quarters_vending = (x, y, w, h, f) => {
  // contact shadow â€” slightly wider base on the floor
  sh(x, y + h - 1, w);
  // main upright cabinet, dark grey-green metal
  box(x, y + 1, w, h - 1, '#2c3330');
  px(x + 1, y + 2, w - 2, 1, U.shade('#404a44', 12));            // top-lit lip
  px(x + 1, y + 2, w - 2, h - 4, '#404a44');                     // body face
  px(x, y + h - 4, w, 3, '#222824');                             // wider darker base plinth
  px(x, y + h - 4, w, 1, U.shade('#404a44', 8));                 // base highlight edge
  px(x + 1, y + 2, 1, h - 5, U.shade('#404a44', 18));            // left vertical sheen
  px(x + w - 2, y + 2, 1, h - 5, '#222824');                     // right shaded edge

  // tall glass window well, upper ~60%
  const gw = w - 7, gx = x + 2, gy = y + 4, gh = Math.round(h * 0.56);
  inset(gx, gy, gw, gh, '#161c1a');
  px(gx + 1, gy + 1, gw - 2, gh - 2, '#0e1614');                 // dark interior

  // two rows of tiny stocked cans/bottles behind the glass
  const cols = Math.max(2, Math.floor((gw - 2) / 4));
  for (let row = 0; row < 2; row++) {
    const ry = gy + 2 + row * Math.floor((gh - 3) / 2);
    for (let c = 0; c < cols; c++) {
      const cx = gx + 2 + c * 4;
      if (cx + 2 > gx + gw - 1) break;
      const seed = U.hash('vend' + row + c);
      const warm = seed % 2 === 0;
      const base = warm ? '#7a2e2e' : '#1f5a63';                 // muted red / cyan
      px(cx, ry, 2, 3, base);
      px(cx, ry, 1, 3, U.shade(base, 22));                       // can left highlight
      px(cx, ry, 2, 1, U.shade(base, 30));                       // can cap glint
    }
  }
  // faint diagonal reflection sheen across the glass
  ctx.save();
  ctx.globalAlpha = 0.10;
  ctx.fillStyle = '#bfe6dc';
  ctx.beginPath();
  ctx.moveTo(gx + 1, gy + 1);
  ctx.lineTo(gx + Math.floor(gw * 0.45), gy + 1);
  ctx.lineTo(gx + 1, gy + Math.floor(gh * 0.55));
  ctx.fill();
  ctx.restore();
  px(gx, gy, 1, gh, U.shade('#404a44', 24));                     // glass frame highlight

  // keypad of pale dots on the right strip
  const kx = gx + gw + 2;
  for (let i = 0; i < 6; i++) {
    px(kx + (i % 2) * 2, gy + 1 + Math.floor(i / 2) * 3, 1, 1, '#9aa49c');
  }
  // one product LED blinks ready (green), brighter when in use
  const ready = blink(620);
  px(kx + 1, gy + 10, 1, 1, ready ? (f.work ? '#7dffb0' : '#41ff8a') : '#16302a');
  if (ready) glow(kx, gy + 9, 3, 3, '#41ff8a', f.work ? 0.30 : 0.16);

  // lower control area
  const by = gy + gh + 1;
  inset(gx, by, gw, h - (by - y) - 4, '#1b211e');

  // warm amber status strip â€” scrolling flicker
  const sy = by + 2, sw = gw;
  px(gx, sy, sw, 2, '#241c10');                                  // strip well
  const segs = Math.max(4, Math.floor(sw / 2));
  const offset = Math.floor(now / 140) % segs;
  for (let s = 0; s < segs; s++) {
    const on = ((s + offset) % 3) !== 0;
    const lit = '#ffb84d';
    px(gx + s * 2, sy, 2, 1, on ? lit : U.shade(lit, -45));
    px(gx + s * 2, sy + 1, 2, 1, on ? U.shade(lit, -18) : U.shade(lit, -55));
  }
  ctx.save();
  ctx.globalAlpha = 0.18 + 0.10 * (0.5 + 0.5 * flick(900));
  glow(gx, sy - 1, sw, 4, '#ffb84d', 1);
  ctx.restore();

  // lit dispense slot glow at the bottom
  const dy = sy + 4;
  inset(gx + 1, dy, gw - 2, h - (dy - y) - 4, '#0d1110');
  px(gx + 2, dy + 1, gw - 4, 1, '#1a221e');                      // slot lip
  glow(gx + 1, dy, gw - 2, 3, '#ffb84d', 0.12 + 0.05 * flick(1300, 1));
  px(gx + 3, dy + 2, 2, 1, U.shade('#ffb84d', -10));             // inner slot warm dot
};
  F.quarters_lockerbank = (x, y, w, h, f) => {
  // contact shadow along the base â€” squat floor/wall-line cabinet
  sh(x + 1, y + h - 1, w - 2);
  // outlined brushed metal casing
  box(x, y + 1, w, h - 1, '#3a423d');
  // top edge highlight
  px(x + 1, y + 1, w - 2, 1, '#545d56');
  px(x + 1, y + 2, w - 2, 1, U.shade('#3a423d', 8));
  // three equal doors across the 3-tile span
  const dw = (w - 2) / 3;
  for (let d = 0; d < 3; d++) {
    const dx = x + 1 + Math.round(d * dw);
    const nx = x + 1 + Math.round((d + 1) * dw);
    const iw = nx - dx;
    // door face: slight 2-tone â€” top lit, lower body
    px(dx, y + 3, iw, h - 4, '#3a423d');
    px(dx, y + 3, iw, 1, '#545d56');
    px(dx, y + h - 2, iw, 1, U.shade('#3a423d', -12));
    // dark shadow seam between doors
    if (d > 0) px(dx - 1, y + 3, 1, h - 4, U.shade('#3a423d', -22));
    // thin vent grille (upper third of door)
    for (let g = 0; g < 3; g++) px(dx + 2, y + 5 + g * 2, iw - 4, 1, U.shade('#3a423d', -16));
    px(dx + 2, y + 5, iw - 4, 1, U.shade('#3a423d', 6));
    // recessed handle (lower-right of each door)
    inset(dx + iw - 5, y + h - 6, 3, 3, '#23282a');
    px(dx + iw - 4, y + h - 5, 1, 1, U.shade('#545d56', -4));
  }
  // door 0: small worn sticker decal in faded pink
  const sx = x + 1 + Math.round(0 * dw) + 2;
  px(sx, y + h - 5, 3, 2, '#b56a78');
  px(sx, y + h - 5, 3, 1, '#c98592');
  px(sx + 1, y + h - 4, 1, 1, U.shade('#b56a78', -14));
  // door 1: amber name-tag light that slowly pulses
  const tx = x + 1 + Math.round(1 * dw) + 3;
  const ty = y + h - 6;
  const pulse = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(now / 1100));
  inset(tx - 1, ty - 1, 5, 3, '#23282a');
  ctx.save();
  ctx.globalAlpha = pulse;
  px(tx, ty, 3, 1, '#ffb84d');
  ctx.restore();
  px(tx, ty, 1, 1, U.shade('#ffb84d', 10));
  glow(tx - 1, ty - 1, 5, 3, '#ffb84d', 0.10 + 0.10 * pulse);
};
  F.quarters_minifridge = (x, y, w, h, f) => {
  // ---- compact under-counter mini-fridge, top-down ----
  sh(x + 1, y + h - 1, w - 2);

  // off-white enamel body, outlined/top-lit metal casing
  box(x + 1, y + 1, w - 2, h - 2, '#cfd2cc');
  // rounded-cube corner knockouts (chamfer the silhouette)
  px(x + 1, y + 1, 1, 1, '#9aa0a0');
  px(x + w - 2, y + 1, 1, 1, '#9aa0a0');
  px(x + 1, y + h - 2, 1, 1, '#8a9090');
  px(x + w - 2, y + h - 2, 1, 1, '#8a9090');

  // top highlight band + faint condensation sheen
  px(x + 2, y + 2, w - 4, 2, '#e7e9e4');
  px(x + 2, y + 2, w - 4, 1, U.shade('#e7e9e4', 12));
  ctx.save();
  ctx.globalAlpha = 0.10;
  px(x + 3, y + 4, Math.max(1, (w - 6) >> 1), 2, '#ffffff');
  ctx.restore();
  // bottom shade for a little rounded volume
  px(x + 2, y + h - 3, w - 4, 1, U.shade('#cfd2cc', -16));

  // door seam (vertical, dark grey) splitting body
  const seam = x + Math.round(w * 0.62);
  px(seam, y + 3, 1, h - 6, '#6b7270');
  px(seam, y + 3, 1, 1, '#444b49');
  // door panel slightly insetted on the larger left face
  inset(x + 3, y + 5, seam - (x + 3) - 1, h - 9, '#c4c7c1');
  px(x + 4, y + 6, seam - (x + 4) - 1, 1, '#dadcd6');

  // stubby chrome handle on the door, near the seam
  box(seam - 4, y + Math.round(h * 0.45), 3, 4, '#9aa0a0');
  px(seam - 4, y + Math.round(h * 0.45), 3, 1, '#c6cccb');
  px(seam - 4, y + Math.round(h * 0.45) + 3, 3, 1, '#6e7472');

  // magnet dots on the door face (one amber, one teal)
  px(x + 4, y + 5, 1, 1, '#ffb84d');
  px(x + 5, y + h - 6, 1, 1, '#5fb6a8');

  // ---- single animated emissive accent: amber running LED, blinks every ~2.5s ----
  const lit = blink(2500);
  const ledX = x + 4, ledY = y + Math.round(h * 0.5);
  px(ledX, ledY, 1, 1, lit ? '#ffb84d' : '#36424c');
  if (lit) glow(ledX - 1, ledY - 1, 3, 3, '#ffb84d', 0.30);
};

  F.airlock = (x, y, w, h, f) => {
    // AIRLOCK — the room-seal hatch (spatial floor containment, not capability isolation). A FLOOR-FLAT
    // OCTAGONAL IRIS whose blades + status lamp reflect the room's merge state:
    //   open   = green, blades retracted to a lit central gap
    //   closed = amber, blades meet at a sealed seam
    //   jammed = red,   a sparking, half-jammed seam
    // f.door drives it live (set via setDoorState). Bolder = a round iris, not a square shutter.
    const st = (f && f.door) || 'open';
    const sealed = st === 'closed' || st === 'jammed', jam = st === 'jammed';
    const lc = jam ? '#ff5a4a' : sealed ? '#ffb347' : ACC.work;   // status colour
    const cx = x + (w >> 1), cy = y + (h >> 1);
    const rad = Math.min(w, h) / 2 - 1;
    shadow2(x + 1, y + h - 1, w - 2);                            // floor contact
    // octagonal deck rim (bolted frame) — draw the ring by clipping a rounded well
    rr(x + 1, y + 1, w - 2, h - 2, '#151d20');                   // outer bezel
    rr(x + 2, y + 2, w - 4, h - 4, U.shade(RAMP.steel.face, -0.2));
    px(x + 2, y + 2, w - 4, 1, RAMP.steel.lit);                  // north rim catch
    px(x + 2, y + h - 3, w - 4, 1, RAMP.steel.ao);              // south rim AO
    // hazard bolts at the 4 diagonal corners of the octagon frame
    px(x + 2, y + 2, 1, 1, '#caa84a'); px(x + w - 3, y + 2, 1, 1, '#caa84a');
    px(x + 2, y + h - 3, 1, 1, '#8a7434'); px(x + w - 3, y + h - 3, 1, 1, '#8a7434');
    // recessed circular track
    const trk = '#0c1417';
    for (let dy = -rad + 1; dy <= rad - 1; dy++) {
      const half = Math.floor(Math.sqrt(Math.max(0, (rad - 1) * (rad - 1) - dy * dy)));
      if (half <= 0) continue;
      px(cx - half, cy + dy, half * 2, 1, trk);
    }
    // IRIS BLADES: 4 wedges. Retracted (open) leave a lit central eye; sealed they close to the centre.
    const close = sealed ? rad - 1 : 1;                          // how far blades reach inward
    const bc = jam ? '#3a2a24' : U.shade(RAMP.steel.top, -0.05);
    const be = U.shade(bc, 0.3), bs = U.shade(bc, -0.4);
    for (let dy = -rad + 1; dy <= rad - 1; dy++) {
      const half = Math.floor(Math.sqrt(Math.max(0, (rad - 1) * (rad - 1) - dy * dy)));
      if (half <= 0) continue;
      // blades come in from the rim toward the centre by `close` px, leaving a central gap when open
      const gap = Math.max(0, half - close);
      if (gap < half) {
        // left blade
        px(cx - half, cy + dy, half - gap, 1, bc);
        px(cx - half, cy + dy, 1, 1, dy < 0 ? be : bs);         // blade edge shading
        // right blade
        px(cx + gap, cy + dy, half - gap, 1, bc);
        px(cx + half - 1, cy + dy, 1, 1, dy < 0 ? be : bs);
      }
    }
    // spokes between blades (cross of the iris) — subtle, always visible over the blades
    px(cx - 1, cy - rad + 1, 2, (rad - 1) * 2, U.shade(bc, -0.5));
    if (sealed) {
      // sealed centre boss + seam
      px(cx - 1, cy - 1, 2, 2, U.shade(bc, -0.3));
      px(cx - 1, cy - rad + 2, 2, rad * 2 - 3, U.shade(bc, -0.55)); // vertical sealed seam
      if (jam && blink(150)) { px(cx, cy - 1, 1, 1, '#fff'); px(cx + 1, cy - 2, 1, 1, '#ffd9a0'); } // jam spark
    } else {
      // open: lit central eye
      px(cx - 1, cy - 1, 2, 2, U.shade(ACC.work, -0.1));
      glow(cx - 2, cy - 2, 4, 4, ACC.work, 0.24 + 0.1 * Math.sin(now / 400));
    }
    // status lamp on the north lintel of the frame
    px(cx - 1, y, 2, 2, '#0c1417');
    const on = jam ? blink(170) : sealed ? blink(680) : true;
    px(cx - 1, y, 2, 2, on ? lc : U.shade(lc, -0.65));
    glow(cx - 2, y - 1, 4, 3, lc, jam ? 0.45 + 0.2 * Math.sin(now / 110) : sealed ? 0.18 : 0.24);
  };

  /* ============ CATALOG — every placeable prop ============
     id        — F key (the draw fn) AND the model's prop.t
     label     — palette button text
     cat       — palette group
     w,h       — default footprint in tiles
     animated  — has a per-frame emissive accent (informational)
     blocks    — occupies its footprint tiles for pathfinding (agents route around)
     use       — OPTIONAL leisure descriptor {kind, sit, approach}: marks a prop an idle
                 agent can lounge at (couch/tv/arcade/…). world.js derives the approach
                 tile via propanchor.js; sit=true seats the agent, approach biases the side. */
  /* short Fallout-style blurbs for the hover card (functional props). Reused where the effect is identical. */
  const D_WS = 'WORKSTATION — assign an agent here and it walks over and sits to work whenever it gets a task.';
  const D_FILES = 'CAPABILITY — gives the agent in this room file access (read & write its own files).';
  const D_WEB = 'CAPABILITY — gives the agent in this room web access (live search & fetch).';
  const D_MEM = 'CAPABILITY — gives the agent in this room long-term memory (a notebook it can recall).';

  /* CATALOG is split into two TIERS for the builder palette (shown as ⚙ SYSTEMS / ✦ DECOR):
       functional — SYSTEMS: props that DO something (place · assign · wire into real workflows)
       cosmetic   — DECOR: looks only (decoration, atmosphere, leisure)
     `tier` + `cat` drive the palette grouping; `seat:true` marks an agent-assignable workstation;
     `desc` is the hover-card blurb. None of this is read by the routing/capability backend (it keys on prop.t). */
  const CATALOG = [
    /* ===================== FUNCTIONAL ===================== */
    // WORKSTATIONS — the agent's seat. Assign ONE agent; it walks here and sits to work when tasked.
    { id: "desk", label: "DESK", cat: "workstation", tier: "functional", seat: true, w: 2, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "desk2", label: "DESK ×2", cat: "workstation", tier: "functional", seat: true, w: 2, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "console", label: "CONSOLE", cat: "workstation", tier: "functional", seat: true, w: 2, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "consoleL", label: "CONSOLE L", cat: "workstation", tier: "functional", seat: true, w: 3, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "pixelrig", label: "PIXEL RIG", cat: "workstation", tier: "functional", seat: true, w: 2, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "bench", label: "BENCH", cat: "workstation", tier: "functional", seat: true, w: 4, h: 1, animated: true, blocks: true, desc: D_WS },
    { id: "workbench", label: "WORKBENCH", cat: "workstation", tier: "functional", w: 2, h: 1, animated: true, blocks: true, desc: "WORKBENCH — grants the room's agent shell + verify, so it can run and test real code. Pair it with a workstation in the same room." },
    // WORKFLOW — how work enters, moves, routes, and leaves.
    { id: "intake", label: "INTAKE", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: false, desc: "INTAKE — where outside work (a DM, a job) enters the station and drops onto a belt. The start of a workflow." },
    { id: "bay", label: "BAY", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: false, desc: "BAY — the agent dock. Assign an agent; work routed here runs as that agent, and the props in this room become its powers." },
    { id: "filter", label: "FILTER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "FILTER — sorts work by its content, sending each kind down a different belt lane. Click it to set the routes." },
    { id: "merger", label: "MERGER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "MERGER — buffers K incoming boxes, then emits one combined box. A join / map-reduce barrier." },
    { id: "splitter", label: "SPLITTER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "SPLITTER — fans one work stream across its lanes to run several agents in parallel (load-balance)." },
    { id: "outbox", label: "OUTBOX", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: false, desc: "OUTBOX — the dispatch chute where an agent's finished reply leaves the station." },
    { id: "beltH", label: "CONVEYOR", cat: "workflow", tier: "functional", w: 2, h: 1, animated: true, blocks: true, desc: "CONVEYOR — carries work boxes between stations; the path work travels. Tip: use the BELT tool to draw long runs." },
    // CAPABILITY — object = capability. Place one in a BAY's room to grant that agent a power.
    { id: "connector_portal", label: "CONNECTOR", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: "CONNECTOR — bind an MCP server here to grant the room's agent that server's live tools. Click it to bind one." },
    { id: "comms_dish", label: "DISH", cat: "capability", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: D_WEB },
    { id: "comms_uplink", label: "UPLINK", cat: "capability", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: D_WEB },
    { id: "comms_beacon", label: "BEACON", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: D_WEB },
    { id: "war_intelcab", label: "INTEL CAB", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: D_FILES },
    { id: "safe", label: "SAFE", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: D_FILES },
    { id: "vault", label: "VAULT", cat: "capability", tier: "functional", w: 3, h: 2, animated: true, blocks: true, desc: D_FILES },
    { id: "rack", label: "RACK", cat: "capability", tier: "functional", w: 2, h: 1, animated: true, blocks: true, desc: D_FILES },
    { id: "shelf", label: "SHELF", cat: "capability", tier: "functional", w: 4, h: 1, animated: true, blocks: true, desc: D_FILES },
    { id: "core", label: "CORE", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: D_MEM },
    { id: "gigs_servercart", label: "SERVER CART", cat: "capability", tier: "functional", w: 1, h: 1, animated: true, blocks: true, desc: D_MEM },
    { id: "bridge_relaystack", label: "RELAY STACK", cat: "capability", tier: "functional", w: 1, h: 2, animated: true, blocks: true, desc: D_MEM },
    // ISOLATION — seal a room off on the floor.
    { id: "airlock", label: "AIRLOCK", cat: "isolation", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "AIRLOCK — seals a room on the floor (a staging / merge gate); the agent's body can't path in or out. Click to cycle open / sealed / jammed." },

    /* ===================== COSMETIC ===================== */
    // SCREENS — ops & display dressing.
    { id: "bigscreen", label: "BIG SCREEN", cat: "screens", tier: "cosmetic", w: 8, h: 1, animated: true, blocks: false },
    { id: "holotable", label: "HOLOTABLE", cat: "screens", tier: "cosmetic", w: 4, h: 2, animated: true, blocks: true },
    { id: "screens", label: "SCREENS", cat: "screens", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false },
    { id: "tank", label: "TANK", cat: "screens", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "whiteboard", label: "WHITEBOARD", cat: "screens", tier: "cosmetic", w: 4, h: 1, animated: true, blocks: false },
    { id: "ticker", label: "TICKER", cat: "screens", tier: "cosmetic", w: 4, h: 1, animated: true, blocks: false },
    { id: "chartwall", label: "CHART WALL", cat: "screens", tier: "cosmetic", w: 3, h: 1, animated: true, blocks: false },
    { id: "wartable", label: "WAR TABLE", cat: "screens", tier: "cosmetic", w: 5, h: 2, animated: true, blocks: true },
    { id: "calwall", label: "CAL WALL", cat: "screens", tier: "cosmetic", w: 6, h: 1, animated: true, blocks: false },
    { id: "bridge_tacscreen", label: "TAC SCREEN", cat: "screens", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false },
    { id: "bridge_dispatch_pylon", label: "DISPATCH PYLON", cat: "screens", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "bridge_orderqueue", label: "ORDER QUEUE", cat: "screens", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "war_pivotpanel", label: "PIVOT PANEL", cat: "screens", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "war_threatcore", label: "THREAT CORE", cat: "screens", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    // LAB — research & craft dressing.
    { id: "fabricator", label: "FABRICATOR", cat: "lab", tier: "cosmetic", w: 3, h: 2, animated: true, blocks: true },
    { id: "vat", label: "VAT", cat: "lab", tier: "cosmetic", w: 3, h: 2, animated: true, blocks: true },
    { id: "easel", label: "EASEL", cat: "lab", tier: "cosmetic", w: 3, h: 2, animated: true, blocks: true },
    { id: "tube", label: "TUBE", cat: "lab", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "research_corelens", label: "CORE LENS", cat: "lab", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "research_trendpillar", label: "TREND PILLAR", cat: "lab", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "research_samplecart", label: "SAMPLE CART", cat: "lab", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "research_papers", label: "PAPERS", cat: "lab", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false },
    { id: "etsy_threadrack", label: "THREAD RACK", cat: "lab", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "etsy_dyevat", label: "DYE VAT", cat: "lab", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true },
    { id: "etsy_kiln", label: "KILN", cat: "lab", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true },
    { id: "etsy_packbot", label: "PACK BOT", cat: "lab", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true },
    // STORAGE — crates, bins & vaults (decorative).
    { id: "rackV", label: "RACK V", cat: "storage", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "crate", label: "CRATE", cat: "storage", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "boxes", label: "BOXES", cat: "storage", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "goldcrate", label: "GOLD CRATE", cat: "storage", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "parcels", label: "PARCELS", cat: "storage", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "gigs_partsbin", label: "PARTS BIN", cat: "storage", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "treasury_coinsorter", label: "COIN SORTER", cat: "storage", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "treasury_token_furnace", label: "TOKEN FURNACE", cat: "storage", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    // COMMS — antennas & mail dressing.
    { id: "commswall", label: "COMMS WALL", cat: "comms", tier: "cosmetic", w: 6, h: 1, animated: true, blocks: false },
    { id: "comms_inbox", label: "INBOX", cat: "comms", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "gigs_thumbwall", label: "THUMB WALL", cat: "comms", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false },
    { id: "gigs_amp", label: "AMP", cat: "comms", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    { id: "pub_publishpress", label: "PUBLISH PRESS", cat: "comms", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true },
    { id: "pub_outboundchute", label: "OUTBOUND CHUTE", cat: "comms", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "pub_mailpod", label: "MAIL POD", cat: "comms", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "arc_indexwall", label: "INDEX WALL", cat: "comms", tier: "cosmetic", w: 4, h: 1, animated: true, blocks: false },
    { id: "arc_microfiche", label: "MICROFICHE", cat: "comms", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    // LOUNGE — morale & downtime (idle agents drift here).
    { id: "djbooth", label: "DJ BOOTH", cat: "lounge", tier: "cosmetic", w: 4, h: 2, animated: true, blocks: true },
    { id: "speaker", label: "SPEAKER", cat: "lounge", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    { id: "bar", label: "BAR", cat: "lounge", tier: "cosmetic", w: 4, h: 1, animated: true, blocks: true, use: { kind: 'bar', sit: false, approach: 'south' } },
    { id: "tv", label: "TV", cat: "lounge", tier: "cosmetic", w: 3, h: 1, animated: true, blocks: true, use: { kind: 'tv', sit: false, approach: 'south' } },
    { id: "couch", label: "COUCH", cat: "lounge", tier: "cosmetic", w: 5, h: 1, animated: true, blocks: true, use: { kind: 'couch', sit: true, approach: 'south' } },
    { id: "arcade", label: "ARCADE", cat: "lounge", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true, use: { kind: 'arcade', sit: false, approach: 'south' } },
    { id: "arcade2", label: "ARCADE II", cat: "lounge", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true, use: { kind: 'arcade', sit: false, approach: 'south' } },
    { id: "jukebox", label: "JUKEBOX", cat: "lounge", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true, use: { kind: 'juke', sit: false, approach: 'south' } },
    { id: "bunk", label: "BUNK", cat: "lounge", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true },
    { id: "quarters_pooltable", label: "POOL TABLE", cat: "lounge", tier: "cosmetic", w: 4, h: 2, animated: true, blocks: true },
    { id: "quarters_vending", label: "VENDING", cat: "lounge", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "quarters_lockerbank", label: "LOCKERS", cat: "lounge", tier: "cosmetic", w: 3, h: 1, animated: true, blocks: true },
    { id: "quarters_minifridge", label: "MINIFRIDGE", cat: "lounge", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    // DECOR — small dressing & plain seating.
    { id: "coffee", label: "COFFEE", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "plant", label: "PLANT", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "cans", label: "CANS", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "poster", label: "POSTER", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "rug", label: "RUG", cat: "decor", tier: "cosmetic", w: 4, h: 3, animated: true, blocks: false },
    { id: "treasury_pnl_holo", label: "PNL HOLO", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "arc_floorlight", label: "FLOOR LIGHT", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "arc_ladder", label: "LADDER", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "stool", label: "STOOL", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    { id: "chair", label: "CHAIR", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
  ];
  const BY_ID = {};
  for (const c of CATALOG) BY_ID[c.id] = c;
  const CATS = CATALOG.reduce((o, c) => { (o[c.cat] = o[c.cat] || []).push(c); return o; }, {});

  const spec = id => BY_ID[id] || null;
  const has = id => !!F[id];

  /* ---- live connector state (drives the connector_portal sprite). The world layer owns the data — it polls
     /api/connectors for each bound server's state and calls a tool-call pulse when an mcp__ tool fires — and
     pushes it here, so the prop draw stays a pure function of (geometry + this map). Keyed by connectorId. */
  const connState = {};          // connectorId -> { state, toolCount, firedAt }
  const PULSE_MS = 900;          // a firing packet decays 1 -> 0 over this window
  function setConnectorState(id, state, toolCount) {
    if (!id) return; const s = connState[id] || (connState[id] = {});
    s.state = state || 'offline'; if (toolCount != null) s.toolCount = toolCount;
  }
  function pulseConnector(id) { if (!id) return; (connState[id] || (connState[id] = {})).firedAt = now; }
  function connectorFired(id) { const s = id && connState[id]; return (s && s.firedAt) ? Math.max(0, 1 - (now - s.firedAt) / PULSE_MS) : 0; }

  /* live WORKBENCH pulse (drives the workbench sprite). The world layer calls pulseWorkbench(ok) when a
     shell.exec / verify.result fires (ok=false => a verify FAILED, the bench flashes red). One global pulse —
     every placed workbench glows, signalling "the agent is running code right now." */
  let wbFiredAt = 0, wbBad = false;
  function pulseWorkbench(ok) { wbFiredAt = now; wbBad = (ok === false); }
  function workbenchFired() { return wbFiredAt ? Math.max(0, 1 - (now - wbFiredAt) / PULSE_MS) : 0; }

  /* draw one prop. f = {t, x, y, w, h} in LOCAL tile coords; `work` lights its screens. */
  function draw(f, work) {
    const fn = F[f.t]; if (!fn) return;
    const X = f.x * TILE, Y = f.y * TILE, W = (f.w || 1) * TILE, H = (f.h || 1) * TILE;
    const o = { x: f.x, work: !!work, agentId: f.agentId || null, door: f.door || null };
    if (f.t === 'connector_portal') {                 // a bound portal rides its connector's live state
      const cid = f.connectorId || null;
      o.bound = !!cid;
      o.state = cid ? ((connState[cid] && connState[cid].state) || 'offline') : 'unbound';
      o.fired = connectorFired(cid);
    }
    if (f.t === 'workbench') { o.fired = workbenchFired(); o.bad = wbBad; }   // shell/verify pulse
    fn(X, Y, W, H, o);
  }

  return {
    setCtx(c) { ctx = c; },
    setNow(t) { now = t; },
    draw, CATALOG, CATS, spec, has, TILE,
    // live connector state (the world layer feeds these; the connector_portal sprite reads them)
    setConnectorState, pulseConnector,
    // workbench pulse (the world layer feeds this off shell.exec / verify.result)
    pulseWorkbench,
    // exposed for tests / reuse
    _F: F,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PropSprites;
