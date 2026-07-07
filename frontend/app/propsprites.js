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
  /* casings are toned DOWN ~15% (sheen rows 20%) from the authoring values so props sit inside the
     station's dim CRT lighting instead of popping against it — a locked pre-merge call. Emissives
     and ACC accents keep full brightness; only the body ramps dim. */
  const dim = (c, k) => {   // module-load-safe darken (U isn't defined under a bare Node require)
    k = k || -0.15;
    const n = parseInt(c.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * (1 + k)), g = Math.round(((n >> 8) & 255) * (1 + k)), b = Math.round((n & 255) * (1 + k));
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  };
  const RAMP = {
    steel: { top: dim('#4a5862'), face: dim('#39454d'), lit: dim('#5f6f7a'), sheen: dim('#7a8b95', -0.2), dk: dim('#242e35'), ao: dim('#12181d') },
    gun:   { top: dim('#3c4a44'), face: dim('#2e3a36'), lit: dim('#4e5e56'), sheen: dim('#68796f', -0.2), dk: dim('#1d2723'), ao: dim('#0f1512') },
    fabric:{ top: dim('#46565f'), face: dim('#39464e'), lit: dim('#5a6b75'), sheen: dim('#70828c', -0.2), dk: dim('#28323a'), ao: dim('#141b20') },
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
  /* The locked style law (2026-07-01): projection MIX — low furniture is TOP-BIAS OBLIQUE
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

  F.bigscreen = (x, y, w, h, f) => {   // v2 freestanding: HUGE display on two heavy floor pylon mounts
    const r = RAMP.steel;
    const py = y - 9, pH = 15;                                   // panel rides y-9..y+6; floor gap below
    shadow2(x + 4, y + h - 1, w - 8);
    // two heavy pylon mounts carrying the panel down to the floor line
    for (const mx of [x + 12, x + w - 20]) {
      px(mx - 1, y + 3, 10, 8, LINE);
      px(mx, y + 4, 8, 6, r.face);
      px(mx, y + 4, 1, 6, r.lit); px(mx + 7, y + 4, 1, 6, r.dk);
      px(mx + 3, y + 4, 2, 6, r.ao);                            // cable channel up the pylon
      rr(mx - 3, y + h - 3, 14, 3, LINE);                       // splayed base shoe
      px(mx - 2, y + h - 3, 12, 2, r.face);
      px(mx - 2, y + h - 3, 12, 1, r.lit);
      px(mx - 2, y + h - 1, 12, 1, r.ao);
      ctx.globalAlpha = 0.30; px(mx - 3, y + h, 14, 1, '#000'); ctx.globalAlpha = 1;
    }
    // chamfered panel body
    rr(x - 1, py - 1, w + 2, pH + 2, LINE);
    px(x, py, w, pH, r.face);
    px(x, py, w, 1, r.lit);                                     // frame top catch
    px(x, py + 1, 6, 1, U.shade(r.lit, 0.12));                  // west sheen streak
    px(x, py + 1, 1, pH - 2, U.shade(r.face, 0.08));
    px(x + w - 1, py + 1, 1, pH - 2, r.dk);
    px(x, py + pH - 1, w, 1, r.ao);
    px(x + 2, py, 1, 1, '#8693a0'); px(x + w - 3, py, 1, 1, '#8693a0'); // frame screws
    wear(x + 1, py + 1, w - 2, pH - 2, 4, U.shade(r.face, -0.10));
    // recessed phosphor screen
    inset(x + 2, py + 2, w - 4, pH - 5, '#0e2418');
    const cy0 = py + 3, ch0 = pH - 6, cyc = cy0 + 4;
    for (let gx = 6; gx < w - 10; gx += 8) px(x + 3 + gx, cy0, 1, ch0, '#123020'); // graticule
    px(x + 4, cyc, w - 8, 1, '#153a26');                        // baseline
    glow(x + 3, cy0, w - 6, 1, '#9adcb0', 0.10);
    glow(x + 3, cy0, 14, ch0, '#bfffd9', 0.05);
    // twin waveforms: dim echo behind the live red trace (kept 1:1)
    ctx.strokeStyle = '#5c241e'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < w - 8; i++) {
      const yy = cyc + Math.sin(now / 260 + i * 0.35 + 1.3) * 2.2;
      i ? ctx.lineTo(x + 4 + i, yy) : ctx.moveTo(x + 4 + i, yy);
    }
    ctx.stroke();
    ctx.strokeStyle = '#ff4a3d'; ctx.beginPath();
    for (let i = 0; i < w - 8; i++) {
      const yy = cyc + Math.sin(now / 260 + i * 0.35) * 2.4;
      i ? ctx.lineTo(x + 4 + i, yy) : ctx.moveTo(x + 4 + i, yy);
    }
    ctx.stroke();
    // hot pixel riding the live trace
    const hp = Math.floor((now / 30) % (w - 9));
    px(x + 4 + hp, cyc + Math.round(Math.sin(now / 260 + hp * 0.35) * 2.4), 1, 1, '#ffd0c8');
    scanl(x + 3, cy0, w - 6, ch0, 0.10);
    glow(x + 3 + ((now / 40) % (w - 10)), cy0, 4, ch0, '#dfffe8', 0.06); // drifting scan band
    for (let i = 0; i < 4; i++) px(x + 4 + i * 8, py + pH - 2, 4, 1, blink(900, i) ? '#ffd34a' : '#2c3a32');
    for (let i = 0; i < 7; i++) px(x + w - 26 + i * 3, py + pH - 2, 2, 1, '#0c1410'); // vent slits
    glow(x + 2, py + 2, w - 4, pH - 5, '#ff4a3d', 0.04 + 0.02 * Math.sin(now / 800)); // emissive spill
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

  F.holotable = (x, y, w, h, f) => {   // v2 TOP-BIAS OBLIQUE hero table: big top, short face, plinth; holo floats ABOVE
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, w - 4);
    // central plinth pedestal on the floor
    rr(x + 7, y + h - 7, w - 14, 6, LINE);
    px(x + 8, y + h - 6, w - 16, 4, r.dk);
    px(x + 8, y + h - 6, w - 16, 1, U.shade(r.dk, 0.28));
    px(x + 8, y + h - 3, w - 16, 1, r.ao);
    underAO(x + 3, y + h - 7, w - 6, 2);                        // open gap under the slab lip
    // short south face of the slab
    rr(x - 1, y + h - 12, w + 2, 6, LINE);
    px(x, y + h - 11, w, 4, r.face);
    px(x, y + h - 11, w, 1, r.lit);
    px(x, y + h - 10, 1, 3, U.shade(r.face, 0.08));
    px(x + w - 1, y + h - 10, 1, 3, r.dk);
    px(x, y + h - 8, w, 1, r.ao);
    // control strip on the near face (kept beat)
    px(x + 5, y + h - 10, 8, 1, '#0e1a20');
    for (let i = 0; i < 3; i++) px(x + 6 + i * 3, y + h - 10, 1, 1, blink(500, i) ? '#4ad9ff' : '#1d4a5a');
    // the big rounded top surface
    rr(x - 1, y, w + 2, h - 11, LINE);
    px(x, y + 1, w, h - 13, r.top);
    px(x + 1, y + 1, w - 2, 1, r.sheen);
    px(x + 1, y + 2, 5, 1, U.shade(r.sheen, 0.12));             // west sheen streak
    px(x, y + 2, 1, h - 15, r.lit); px(x + w - 1, y + 2, 1, h - 15, r.dk);
    px(x + 1, y + h - 13, w - 2, 1, U.shade(r.top, -0.16));     // top front lip
    wear(x + 1, y + 1, w - 2, h - 14, 3, U.shade(r.top, -0.08));
    // projection well recessed into the top
    inset(x + 4, y + 3, w - 8, h - 17, '#0c1a22');
    // corner emitter studs (kept)
    for (const [ex, ey] of [[x + 5, y + 4], [x + w - 7, y + 4], [x + 5, y + 8], [x + w - 7, y + 8]])
      px(ex, ey, 2, 1, blink(600, ex + ey) ? '#9aeaff' : '#1d4a5a');
    const rim = 0.35 + 0.2 * Math.sin(now / 600);
    glow(x + 5, y + 4, w - 10, 1, '#4ad9ff', rim); glow(x + 5, y + 9, w - 10, 1, '#4ad9ff', rim);
    glow(x + 5, y + 5, 1, h - 20, '#4ad9ff', rim); glow(x + w - 6, y + 5, 1, h - 20, '#4ad9ff', rim);
    // projection well: dot grid + faint cross axes (kept)
    for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++) px(x + 8 + i * 8, y + 5 + j * 3, 1, 1, '#1d4a5a');
    px(x + 6, y + 6, w - 12, 1, '#13313e'); px(x + w / 2 - 1, y + 4, 1, 5, '#13313e');
    // hologram of the station floats ABOVE the top + orbit ring + orbiting blip (kept 1:1)
    const hcx = x + w / 2, hcy = y - 4;
    glow(hcx - 1, hcy + 4, 2, 4, '#4ad9ff', 0.10);              // projection beam up from the well
    const g = 0.45 + 0.25 * Math.sin(now / 400);
    ctx.globalAlpha = g;
    px(hcx - 7, hcy - 1, 14, 2, '#4ad9ff');
    px(hcx - 1, hcy - 5, 2, 10, '#4ad9ff');
    px(hcx - 4, hcy - 4, 8, 1, '#9aeaff');
    px(hcx - 8, hcy - 1, 1, 1, '#9aeaff'); px(hcx + 7, hcy - 1, 1, 1, '#9aeaff'); // wing tips
    ctx.globalAlpha = g * 0.4;
    ctx.strokeStyle = '#4ad9ff'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.ellipse(hcx, hcy, 9.5, 4.5, 0, 0, 7); ctx.stroke();
    ctx.globalAlpha = 1;
    const oa = now / 700;
    px(hcx - 1 + Math.round(Math.cos(oa) * 9), hcy + Math.round(Math.sin(oa) * 4), 1, 1, '#dffaff');
    glow(hcx - 8, hcy - 5, 16, 10, '#4ad9ff', 0.05 + 0.03 * Math.sin(now / 400)); // volume haze
  };

  F.screens = (x, y, w, h) => {   // v2 freestanding: monitor bank riding rolling posts (was a wall-mural)
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, w - 4);
    // rolling posts on splayed T-feet with casters
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx - 1, y + 5, 4, h - 7, LINE);
      px(pxx, y + 6, 1, h - 8, r.lit); px(pxx + 1, y + 6, 1, h - 8, r.dk);
      rr(pxx - 3, y + h - 3, 8, 2, LINE);
      px(pxx - 2, y + h - 3, 6, 1, r.face);
      px(pxx - 2, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 2, y + h - 1, 2, 1, '#1a1e22'); // casters
      ctx.globalAlpha = 0.30; px(pxx - 3, y + h, 8, 1, '#000'); ctx.globalAlpha = 1;
    }
    // panel riding the posts: rounded steel frame, three monitor units
    rr(x, y - 5, w, 12, LINE);
    px(x + 1, y - 4, w - 2, 10, r.face);
    px(x + 1, y - 4, w - 2, 1, r.lit);
    px(x + 2, y - 4, 1, 1, '#56645c'); px(x + w - 3, y - 4, 1, 1, '#56645c'); // frame screws
    px(x + 1, y + 5, w - 2, 1, r.ao);
    for (let i = 0; i < w / 8; i++) {
      inset(x + 1 + i * 8, y - 3, 7, 6, '#0c1f16');
      const dead = (U.hash('scr' + x + i) % 7) === 0;           // one unit runs diagnostics (kept)
      if (dead) {
        for (let k = 0; k < 5; k++)
          px(x + 2 + i * 8 + (U.hash('st' + i + k + Math.floor(now / 150)) % 5), y - 2 + (U.hash('su' + i + k + Math.floor(now / 150)) % 4), 1, 1, '#3a5a50');
      } else {
        px(x + 2 + i * 8, y - 2 + Math.floor((now / 300 + i) % 3), 5, 1, '#4ad9ff');
        px(x + 2 + i * 8, y - 2 + Math.floor((now / 300 + i) % 3), 2, 1, '#bfeeff'); // bright lead
        px(x + 2 + i * 8, y + 1, 3, 1, '#16424e');              // dim history row
        if (blink(1700, i * 2.3)) glow(x + 2 + i * 8, y - 2, 5, 4, '#4ad9ff', 0.15);
      }
      px(x + 6 + i * 8, y + 4, 1, 1, blink(900, i) ? '#2ee6c8' : '#143028'); // unit LED on the bezel
    }
    px(x + 2, y + 4, 3, 1, r.dk);                               // label strip
  };

  F.tank = (x, y, w, h) => {   // v2 oblique aquarium: visible glass top rim, front glass face, low stand
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    // low stand with feet
    rr(x, y + h - 4, w, 4, LINE);
    px(x + 1, y + h - 3, w - 2, 2, r.dk);
    px(x + 1, y + h - 3, w - 2, 1, U.shade(r.dk, 0.25));
    px(x + 1, y + h - 1, 2, 1, r.ao); px(x + w - 3, y + h - 1, 2, 1, r.ao); // feet
    px(x + 2, y + h - 3, 2, 1, blink(1000) ? '#2ee6c8' : '#143028'); // pump LED (kept)
    // oblique top rim: we look down onto the liquid surface
    rr(x, y - 9, w, 4, LINE);
    px(x + 1, y - 8, w - 2, 1, r.sheen);                        // rim ring catches light
    px(x + 2, y - 7, w - 4, 1, '#2a6a62');                      // liquid surface seen from above
    glow(x + 2, y - 7, w - 4, 1, '#7adfd0', 0.4 + 0.2 * Math.sin(now / 500));
    for (let i = 0; i < 3; i++) px(x + 3 + i * ((w - 7) >> 1), y - 9, 1, 1, '#5a8a80'); // cap bolts (kept)
    // front glass face
    rr(x, y - 6, w, h + 2, LINE);
    px(x + 1, y - 5, w - 2, h, '#0f3a3a');
    px(x + 2, y + 4, w - 4, 3, '#0b2c2c'); px(x + 2, y + 6, w - 4, 1, '#082222'); // murky depth
    px(x + 1, y - 5, 1, h, '#1e4a48'); px(x + w - 2, y - 5, 1, h, '#0a2624'); // lit west / dark east glass
    px(x + 2, y - 5, w - 4, 1, '#2a6a62');                      // surface line behind the glass
    glow(x + 3, y - 4, 2, h - 2, '#bffff2', 0.18);              // glass highlight (kept)
    glow(x + w - 5, y - 2, 1, h - 4, '#bffff2', 0.08);          // second faint streak (kept)
    // suspended specimen, bobbing slowly (kept 1:1)
    const bob = Math.round(Math.sin(now / 1100) * 1.5);
    px(x + w / 2 - 2, y - 1 + bob, 4, 3, '#16504a'); px(x + w / 2 - 1, y - 2 + bob, 2, 1, '#16504a');
    px(x + w / 2 - 2, y - 1 + bob, 1, 1, '#2a7a6e');            // rim light on specimen
    for (let i = 0; i < 3; i++) {
      const ph = (now / (700 + i * 160) + i * 0.7) % 1;
      px(x + 4 + i * 6, y - 5 + Math.floor((1 - ph) * (h - 2)), 1, 1, '#7adfd0');
      px(x + 5 + i * 6, y - 5 + Math.floor((1 - ((ph + 0.4) % 1)) * (h - 2)), 1, 1, '#3a8a80'); // dim bubble
    }
    px(x + 1, y + h - 5, w - 2, 1, '#143028');                  // base band where glass meets stand
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

  F.coffee = (x, y, w, h) => {   // v2: counter-height brewer — rounded head + column, carafe filling in a lit alcove
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, 10);                              // floor contact
    // waiting mug on the deck, west of the machine
    px(x, y + 9, 2, 2, '#3a6a62'); px(x, y + 9, 2, 1, '#5aa89c');
    px(x + 2, y + 10, 1, 1, '#2a4a44');                         // mug handle
    ctx.globalAlpha = 0.25; px(x, y + 11, 3, 1, '#000'); ctx.globalAlpha = 1;
    // rounded body column
    rr(x + 3, y - 1, 9, 13, LINE);
    px(x + 4, y, 7, 10, r.face);
    px(x + 4, y, 1, 10, r.lit); px(x + 10, y, 1, 10, r.dk);
    px(x + 4, y + 10, 7, 1, r.ao);                              // floor-line AO
    // rounded head unit juts over the body (top-bias cap with the water lid)
    rr(x + 2, y - 4, 11, 4, LINE);
    px(x + 3, y - 3, 9, 2, r.top);
    px(x + 3, y - 3, 9, 1, r.sheen);
    px(x + 3, y - 2, 2, 1, U.shade(r.top, 0.10));               // west sheen streak
    px(x + 7, y - 3, 1, 2, U.shade(r.top, -0.20));              // lid seam
    px(x + 10, y - 3, 1, 1, '#8693a0');                         // hinge glint
    // control strip: ready light + buttons
    px(x + 5, y, 1, 1, blink(1200) ? ACC.work : '#1c2a22');     // ready light (kept)
    if (blink(1200)) glow(x + 4, y - 1, 3, 3, ACC.work, 0.22);
    px(x + 7, y, 1, 1, '#222c32'); px(x + 8, y, 1, 1, '#222c32'); // buttons (kept)
    // brew alcove: dark recess, spout dripping into the glass carafe
    px(x + 5, y + 2, 5, 6, '#0d1216');
    px(x + 5, y + 2, 5, 1, '#06090c');                          // recess top shadow
    px(x + 6, y + 2, 3, 1, '#1a2228');                          // spout housing
    px(x + 7, y + 3, 1, 1, '#10161a');                          // spout
    const lvl = 1 + Math.floor(((now / 4000) % 1) * 3);         // pot slowly fills (kept)
    px(x + 6, y + 4, 3, 1, '#8a98a8');                          // carafe rim
    px(x + 6, y + 5, 3, 3, '#141b1e');                          // carafe glass
    px(x + 6, y + 8 - lvl, 3, lvl, '#2f4a46');                  // brew
    px(x + 6, y + 8 - lvl, 3, 1, '#3e5e58');                    // brew surface
    px(x + 6, y + 5, 1, 3, '#2a363c');                          // glass shine
    px(x + 9, y + 5, 1, 2, '#6a7888');                          // carafe handle
    if (blink(400)) px(x + 7, y + 4, 1, 1, '#3e5e58');          // drip stream
    px(x + 5, y + 8, 5, 1, '#241c14');                          // drip tray
    px(x + 6, y + 8, 2, 1, '#3a2c20');                          // old stain (kept)
    px(x + 5, y + 9, 2, 1, '#caa84a');                          // serial tag
    if (blink(600)) { px(x + 6, y - 6, 1, 2, '#8a8a8a'); px(x + 8, y - 7, 1, 2, '#6a6a6a'); } // steam (kept)
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

  F.cans = (x, y) => {   // v2: floor litter — standing, tipped + crushed cans, ring stain, stale spill
    // deck stains first (they are the floor)
    px(x + 4, y + 5, 2, 1, '#3a4440'); px(x + 3, y + 6, 1, 1, '#3a4440'); // ring stain
    px(x + 6, y + 6, 1, 1, '#3a4440'); px(x + 4, y + 7, 2, 1, '#3a4440');
    // crushed can, flattened NW
    px(x + 1, y + 2, 6, 3, LINE);
    px(x + 2, y + 2, 3, 1, '#7a8898');                          // folded rim on top
    px(x + 2, y + 3, 4, 1, '#98a8b8');
    px(x + 4, y + 3, 1, 1, '#5a6878');                          // crush crease
    px(x + 2, y + 3, 1, 1, '#c0ccd8');                          // rim glint
    ctx.globalAlpha = 0.20; px(x + 1, y + 5, 6, 1, '#000'); ctx.globalAlpha = 1;
    // standing tall can, east
    rr(x + 7, y + 2, 5, 8, LINE);
    px(x + 8, y + 3, 3, 6, '#8a98a8');
    px(x + 8, y + 3, 1, 6, '#aab8c8'); px(x + 10, y + 3, 1, 6, '#6a7888');
    px(x + 8, y + 3, 3, 1, '#c8d4e0');                          // top rim
    px(x + 9, y + 3, 1, 1, '#e8f0f8');                          // pull tab
    px(x + 8, y + 5, 3, 2, '#16302a');                          // brand band
    px(x + 9, y + 5, 1, 1, ACC.work);                           // brand glyph
    px(x + 8, y + 8, 3, 1, '#5a6878');                          // bottom rim
    ctx.globalAlpha = 0.22; px(x + 7, y + 10, 5, 1, '#000'); ctx.globalAlpha = 1;
    // tipped can lying E-W, southwest
    rr(x, y + 7, 7, 4, LINE);
    px(x + 1, y + 8, 5, 2, '#8a98a8');
    px(x + 1, y + 8, 5, 1, '#aab8c8'); px(x + 1, y + 9, 5, 1, '#6a7888');
    px(x + 1, y + 8, 1, 2, '#4e5c6c');                          // rim end circle
    px(x + 1, y + 8, 1, 1, '#1a2024');                          // dark opening
    px(x + 3, y + 8, 2, 2, '#16302a');                          // brand band
    px(x + 3, y + 9, 2, 1, ACC.work);                           // brand stripe
    px(x + 5, y + 8, 1, 1, '#c8d4e0');                          // tab glint
    px(x + 1, y + 11, 3, 1, '#343c3a');                         // stale spill from the opening
    ctx.globalAlpha = 0.20; px(x, y + 11, 7, 1, '#000'); ctx.globalAlpha = 1;
  };

  F.commswall = (x, y, w, h) => {   // v2 freestanding: long comms rack ROW on stub feet (was a wall mural)
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, w - 4);
    // stub feet carrying the rack row, gap visible beneath
    for (const lx of [x + 4, x + 23, x + 45, x + w - 7]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 7, y + 9, w - 14, 2);
    // rack body riding the feet: rounded steel row with a lit cap
    rr(x, y - 7, w, 16, LINE);
    px(x + 1, y - 6, w - 2, 1, r.sheen);
    px(x + 1, y - 6, 6, 1, U.shade(r.sheen, 0.12));            // west sheen streak
    px(x + 1, y - 5, w - 2, 13, r.face);
    px(x + 1, y - 5, 1, 13, U.shade(r.face, 0.08));            // west lit edge
    px(x + w - 2, y - 5, 1, 13, r.dk);                          // east shade
    px(x + 1, y + 7, w - 2, 1, r.ao);                           // body base AO
    // conduit run with junction boxes along the crown (kept data pulses)
    px(x + 2, y - 4, w - 4, 1, '#14241f');
    for (let i = 1; i < w / 24; i++) {
      px(x + i * 24, y - 4, 3, 1, '#26403a'); px(x + i * 24, y - 4, 1, 1, '#3a5a50'); // junction
    }
    glow(x + 2 + ((now / 6) % (w - 9)), y - 4, 5, 1, '#5ad1b3', 0.7);       // data pulse
    glow(x + 2 + ((now / 9 + 80) % (w - 9)), y - 4, 3, 1, '#5ad1b3', 0.35); // trailing packet
    // LED panel grid (kept green flash cells + red/amber status row)
    for (let i = 0; i < w / 7 - 1; i++) {
      const on = blink(500 + (i % 5) * 90, i);
      inset(x + 2 + i * 7, y - 2, 6, 5, on ? '#0e3a2a' : '#0a1f16');
      if (on) {
        px(x + 3 + i * 7, y - 1 + (i % 2), 4, 1, '#5ad1b3');
        px(x + 3 + i * 7, y - 1 + (i % 2), 1, 1, '#b8f0e0');    // hot pixel
        px(x + 3 + i * 7, y + 1, 2, 1, '#1d5c44');              // dim echo row
      }
      px(x + 3 + i * 7, y + 4, 2, 1, blink(300, i * 0.7) ? '#ff5c5c' : '#2a1414');
      px(x + 6 + i * 7, y + 4, 1, 1, blink(1100, i * 1.3) ? '#ffd34a' : '#2a2418'); // amber aux
      px(x + 7 + i * 7, y + 4, 1, 1, '#11201a');
      if (i % 4 === 2) px(x + 2 + i * 7, y + 5, 6, 1, U.shade(r.face, -0.12)); // panel divider shade
    }
    seamH(x + 2, y + 6, w - 4, r.face);
    rivets(x + 2, y - 5, w - 4, 12, '#3a5a50', '#0c1612');
    wear(x + 1, y - 5, w - 2, 12, 5, U.shade(r.face, -0.10));
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

  F.fabricator = (x, y, w, h, f) => { // apparel printer — top-bias oblique, bolted machine
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 14, w, h - 14);
    deckSocket(x + w + 1, y + h - 3, f.work);
    px(x + w, y + h - 3, 1, 1, '#0e1418');                     // conduit stub
    for (const lx of [x + 2, x + w - 5]) {                     // chunky corner feet on the plate
      px(lx, y + 15, 3, 3, LINE); px(lx, y + 15, 1, 3, r.lit); px(lx + 1, y + 15, 1, 3, r.dk);
    }
    underAO(x + 5, y + 15, w - 10, 2);
    // output hopper jutting onto the plate: finished apparel lands here
    rr(x + 12, y + 16, 12, 6, LINE);
    px(x + 13, y + 17, 10, 4, '#232d33');
    px(x + 13, y + 17, 10, 1, '#39454d');
    px(x + 15, y + 18, 6, 2, '#e8e0d0'); px(x + 15, y + 18, 6, 1, '#f6f0e4'); // folded shirt
    px(x + 17, y + 18, 2, 1, '#c8c0b0');                       // collar
    // short south face: progress well + status lights
    rr(x - 1, y + 9, w + 2, 6, LINE);
    px(x, y + 10, w, 4, r.face);
    px(x, y + 10, w, 1, r.lit);
    px(x, y + 13, w, 1, r.ao);
    inset(x + 3, y + 11, w - 14, 2, '#10161a');                // progress well
    if (f.work) px(x + 4, y + 11, 1 + Math.floor(((now / 900) % 1) * (w - 17)), 1, '#ff9d2e'); // progress (kept)
    px(x + w - 8, y + 11, 2, 2, blink(400) && f.work ? ACC.work : '#2a3a30'); // run light (kept)
    px(x + w - 5, y + 11, 1, 1, blink(900) ? '#ffd34a' : '#33291a');          // heater light (kept)
    // the big rounded top dominates: casing with a recessed print bed seen from above
    rr(x - 1, y - 3, w + 2, 13, LINE);
    rr(x, y - 2, w, 11, r.top);
    px(x + 1, y - 2, w - 2, 1, r.sheen);
    px(x + 1, y - 1, 5, 1, U.shade(r.sheen, 0.12));
    px(x, y - 1, 1, 9, r.lit); px(x + w - 1, y - 1, 1, 9, r.dk);
    px(x + 1, y + 8, w - 2, 1, U.shade(r.top, -0.16));         // top front edge
    wear(x + 1, y + 6, w - 2, 3, 3, U.shade(r.top, -0.10));
    // recessed print bed window (looking down into the machine)
    inset(x + 5, y, w - 10, 6, '#10161a');
    px(x + 5, y, 1, 1, '#4a565e'); px(x + w - 6, y, 1, 1, '#4a565e'); // frame screws
    px(x + 6, y + 1, w - 12, 4, f.work ? '#2e3840' : '#1a2228');
    px(x + 6, y + 1, w - 12, 1, '#39454d');                    // gantry rail
    if (f.work) {
      glow(x + 6, y + 1, w - 12, 4, '#ff9d2e', 0.35 + 0.15 * Math.sin(now / 300)); // amber work glow (kept)
      const hd = x + 6 + Math.floor((now / 120) % (w - 14));   // moving print head (kept)
      px(hd, y + 1, 2, 4, '#ffd9a0');
      px(hd, y, 2, 1, '#8a98a8');                              // head carriage
      px(hd - 1, y + 4, 1, 1, '#ffeccc');                      // fresh thread
      scanl(x + 6, y + 1, w - 12, 4, 0.15);
    } else {
      px(x + 7, y + 2, 2, 1, '#222c34');                       // parked gantry (kept)
      px(x + w - 8, y + 2, 1, 1, blink(1600) ? '#ff9d2e' : '#33241a'); // standby
    }
    // filament spool on the west flank, spinning while printing (kept)
    rr(x - 2, y + 2, 5, 5, LINE);
    px(x - 1, y + 3, 3, 3, '#2a343c'); px(x - 1, y + 3, 3, 1, '#3a4650');
    px(x, y + 4, 1, 1, '#10161a');                             // hub
    if (f.work) px(x - 1 + (Math.floor(now / 200) % 3), y + 5, 1, 1, '#ffd9a0');
    for (let i = 0; i < 3; i++) px(x + w - 5, y + 1 + i * 2, 3, 1, U.shade(r.top, -0.22)); // east vents
  };

  F.vat = (x, y, w, h, f) => { // candle wax vat — open round basin seen from above, bolted machine
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 15, w, h - 15);
    deckSocket(x + w + 1, y + h - 3, f.work);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    // candle tray on the plate (kept: candles, wicks, drip)
    rr(x + 3, y + 16, 15, 6, LINE);
    px(x + 4, y + 17, 13, 4, '#232d33'); px(x + 4, y + 17, 13, 1, '#39454d');
    px(x + 5, y + 18, 2, 3, '#caa86a'); px(x + 8, y + 17, 2, 4, '#d8b87a'); px(x + 11, y + 18, 2, 3, '#e0c890');
    px(x + 5, y + 18, 1, 3, '#dfc28a'); px(x + 8, y + 17, 1, 4, '#e8cc92'); // candle lit sides
    px(x + 5, y + 17, 1, 1, '#888'); px(x + 8, y + 16, 1, 1, '#888'); px(x + 11, y + 17, 1, 1, '#888'); // wicks
    px(x + 14, y + 19, 2, 1, '#b89858');                       // wax drip
    // drum body: curved band under the rim
    rr(x, y + 2, w, 14, LINE);
    px(x + 1, y + 3, w - 2, 12, r.face);
    px(x + 1, y + 3, 2, 12, r.lit); px(x + w - 3, y + 3, 2, 12, r.dk);
    px(x + 2, y + 14, w - 4, 1, r.ao);
    glow(x + 3, y + 11, w - 6, 1, '#ff4a3d', f.work ? 0.25 + 0.12 * Math.sin(now / 250) : 0.08); // heater coil (kept)
    for (let i = 0; i < (w - 6) / 4; i++) px(x + 3 + i * 4, y + 13, 2, 1, i % 2 ? '#caa84a' : '#28323a'); // hazard (kept)
    px(x + w - 5, y + 11, 3, 3, '#2a343c'); px(x + w - 5, y + 11, 3, 1, '#caa84a'); // temp gauge (kept)
    // the oval rim + molten wax pool dominate the top
    const cx2 = x + w / 2, cy2 = y + 3;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2, 7, 0, 0, Math.PI * 2); ctx.fillStyle = LINE; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 1, 6, 0, 0, Math.PI * 2); ctx.fillStyle = r.top; ctx.fill();
    ctx.globalAlpha = 0.8; ctx.strokeStyle = r.sheen; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.5, w / 2 - 2.5, 5, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.globalAlpha = 1;                                        // back rim catches the light
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 3.5, 4.6, 0, 0, Math.PI * 2); ctx.fillStyle = '#1e1408'; ctx.fill(); // well
    const lvl = 3 + Math.round(Math.sin(now / 900));            // wax level breathes (kept)
    const wrx = w / 2 - 4.5 - (4 - lvl) * 0.7, wry = 3.8 - (4 - lvl) * 0.4;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, wrx, wry, 0, 0, Math.PI * 2); ctx.fillStyle = '#ffd9a0'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, wrx - 2, wry - 1.2, 0, 0, Math.PI * 2); ctx.fillStyle = '#ffeccc'; ctx.fill();
    px(Math.round(cx2 - wrx) + 1, cy2, 1, 1, '#f0c890');        // meniscus (kept)
    px(x + 6 + Math.floor((now / 500) % (w - 14)), cy2 - 1, 2, 1, '#fff4dd'); // shimmer (kept)
    // stirrer paddle sweeping the surface (kept sweep)
    const stx = x + 7 + Math.floor((0.5 + 0.5 * Math.sin(now / 1300)) * (w - 15));
    px(stx, cy2 - 4, 1, 5, '#8a98a8'); px(stx, cy2 - 4, 1, 1, '#aab8c8');
    px(stx - 1, cy2 + 1, 3, 1, '#f0c890');                      // wake in the wax
    ctx.restore();
    px(x + 6, y - 3, w - 12, 1, '#4a5862');                     // stirrer gantry rail over the basin
    if (f.work && blink(300)) { px(x + w / 2, y - 5, 1, 2, '#ff9d2e'); px(x + w / 2, y - 6, 1, 1, '#ffd34a'); } // flame test (kept)
    glow(x + 4, y - 2, w - 8, 10, '#ff9d2e', 0.12 + 0.08 * Math.sin(now / 700)); // pool glow (kept)
  };

  F.easel = (x, y, w, h, f) => { // portrait station — freestanding A-frame, BOLD diagonal legs
    const r = RAMP.gun;
    shadow2(x + 3, y + h - 1, w - 6);
    // rear mast, visible under the canvas
    px(x + w / 2 - 1, y + 14, 3, h - 16, LINE);
    px(x + w / 2, y + 15, 1, h - 18, r.dk);
    // splayed A-frame legs stepping down to wide feet
    for (const [tx, fx] of [[x + 10, x + 4], [x + w - 12, x + w - 6]]) {
      for (let i = 0; i < 9; i++) {
        const lx = Math.round(tx + (fx - tx) * (i / 8));
        px(lx - 1, y + 5 + i * 2, 4, 3, LINE);
      }
      for (let i = 0; i < 9; i++) {
        const lx = Math.round(tx + (fx - tx) * (i / 8));
        px(lx, y + 5 + i * 2, 1, 2, r.lit); px(lx + 1, y + 5 + i * 2, 1, 2, r.dk);
      }
      px(fx - 1, y + h - 2, 4, 2, LINE); px(fx, y + h - 2, 2, 1, r.face); // foot pad
    }
    // the canvas dominates: big rounded board riding the frame
    rr(x + 6, y - 8, w - 12, 21, LINE);
    px(x + 7, y - 7, w - 14, 19, '#4c4256');
    px(x + 7, y - 7, w - 14, 1, '#5c5070');                    // frame top catch
    px(x + 7, y - 6, 1, 17, '#564a62'); px(x + w - 8, y - 6, 1, 17, '#3a3242');
    inset(x + 9, y - 5, w - 18, 13, '#1c1626');
    px(x + 9, y - 5, 2, 1, '#4c4258'); px(x + w - 11, y - 5, 2, 1, '#4c4258'); // canvas clamps (kept)
    if (f.work) { // scanline reveal of the commissioned portrait (kept, all beats)
      const rev = (now / 2000) % 1;
      const rh = Math.floor(10 * rev) + 1;
      px(x + 10, y - 4, w - 20, rh, '#ff6ad5');
      px(x + 10, y - 4, w - 20, 1, '#ffa8e8');
      px(x + 12, y - 3, 2, 1, '#ffd9a0'); px(x + 15, y - 2, 1, 1, '#2a1a24'); // pet face hint
      if (rh > 4) { px(x + w - 15, y - 2, 2, 1, '#ffd9a0'); px(x + w - 14, y - 1, 1, 1, '#2a1a24'); }
      px(x + 10, y - 4 + rh, w - 20, 1, blink(120) ? '#ffffff' : '#ff6ad5'); // scan head
      glow(x + 10, y - 4, w - 20, rh, '#ff6ad5', 0.12);
    } else { // idle sketch state (kept)
      px(x + 12, y - 3, 5, 5, '#5a4a6a'); px(x + 13, y - 2, 3, 3, '#6e5a80');
      px(x + w - 16, y - 2, 4, 4, '#4a3c58');
      px(x + 11, y + 5, w - 22, 1, '#2a2236');                 // sketch guide line
    }
    // paint ledge bolted across the front legs
    rr(x + 5, y + 12, w - 10, 4, LINE);
    px(x + 6, y + 13, w - 12, 2, r.face); px(x + 6, y + 13, w - 12, 1, r.lit);
    px(x + w - 12, y + 11, 2, 2, '#ff6ad5'); px(x + w - 12, y + 11, 1, 1, '#ffa8e8'); // paint pots (kept)
    px(x + w - 15, y + 11, 2, 2, '#4ad9ff');
    px(x + 8, y + 12, 1, 1, '#ff6ad5'); px(x + 11, y + 12, 1, 1, '#4ad9ff');  // splatter (kept)
    for (let i = 0; i < 4; i++) px(x + 9 + i * 4, y + 14, 2, 1, blink(500, i) && f.work ? '#ff6ad5' : '#473a54'); // mix LEDs (kept)
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
    // the uncollected-crate stack (G2.3): banked-product minis climbing off the top's west side,
    // with the queue-jam idiom (gentle hash-phased bob + '+N' overflow in the VT323 terminal face).
    // f.crates is fed by world.js from the ReturnStore ledger — real recorded runs, never invented.
    const crates = Math.max(0, (f && f.crates) | 0);
    if (crates > 0) {
      const shown = Math.min(crates, 5);
      const cx = x + 5;                                          // west of the uplink mast
      for (let i = 0; i < shown; i++) {
        const cy = y + h - 22 - i * 6 + Math.sin(now / 380 + i * 0.7) * 0.6;   // base rides the chute top
        const bx0 = Math.round(cx - 4), by0 = Math.round(cy - 4);
        px(bx0 - 1, by0 - 1, 11, 8, '#101614');                  // dark outline
        px(bx0, by0 + 3, 9, 3, '#2a6a56');                       // shaded front face
        px(bx0, by0, 9, 3, '#5ad1b3');                           // lit product top
        px(bx0, by0, 9, 1, '#c8f4e6');                           // top sheen
      }
      glow(cx - 5, y + h - 22 - shown * 6, 12, shown * 6 + 4, '#5ad1b3', 0.18);   // the stack reads from across the room
      if (crates > 5) {
        ctx.fillStyle = '#7df0c8'; ctx.font = "7px 'VT323','Courier New',monospace";
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('+' + (crates - 5), cx, y + h - 22 - shown * 6 - 4);
      }
    }
  };

  F.studio = (x, y, w, h, f) => {
    // STUDIO — the media bay (G1b: image_generate / image_analyze finally get a placeable body). A squat
    // render rig: violet-dark casing, a raised latent-image frame where magenta bands sweep as a picture
    // forms, and an emitter lens aimed up at it. Rides the station's magenta media accent (CAP_GLOW.studio);
    // f.work = an image tool is actually running (the canvas burns + scanlines roll). Bolted, bold, eerie.
    sh(x + 1, y + h - 1, w - 2);                                    // floor contact shadow
    box(x, y + 6, w, h - 6, '#2e2430');                             // violet-dark casing
    px(x + 1, y + 7, w - 2, 1, '#4a3a4e');                          // top-lit edge
    px(x + 1, y + h - 2, w - 2, 1, '#140e18');                      // bottom shade
    rivets(x + 1, y + 7, w - 2, h - 8, '#5a4660', '#120c14');
    // the RENDER FRAME — a raised easel screen (the silhouette): header bar + recessed canvas well
    px(x + 3, y - 4, w - 6, 2, '#1c1420');
    px(x + 3, y - 4, w - 6, 1, '#3a2a3e');                          // header lit edge
    inset(x + 2, y - 2, w - 4, 9, '#160e1a');
    const act = !!f.work;
    // the latent image: vertical magenta bands sweeping across the canvas (a picture resolving)
    for (let i = 0; i < w - 8; i += 3) {
      const on = ((i / 3 + Math.floor(now / 260)) % 3) === 0;
      px(x + 4 + i, y - 1, 2, 7, on ? (act ? '#ff6ad5' : '#5a2a4a') : '#241226');
    }
    px(x + 3, y - 1, 1, 7, '#3a1a34'); px(x + w - 4, y - 1, 1, 7, '#3a1a34');   // canvas side rails
    if (act) { glow(x + 2, y - 3, w - 4, 11, '#ff6ad5', 0.30 + 0.14 * Math.sin(now / 180)); scanl(x + 3, y - 1, w - 6, 7, 0.18); }
    else glow(x + 2, y - 2, w - 4, 9, '#ff6ad5', 0.08);
    // the emitter lens on the casing deck, aimed at the canvas
    px(x + (w >> 1) - 2, y + 8, 4, 3, '#1c1420');
    px(x + (w >> 1) - 1, y + 9, 2, 1, act ? '#ffd2f0' : (blink(700, 2) ? '#ff6ad5' : '#3a1a34'));
    if (act) glow(x + (w >> 1) - 3, y + 6, 6, 5, '#ff6ad5', 0.35);
    // sample drawers on the casing face
    px(x + 3, y + 13, 6, 4, '#241a28'); px(x + 3, y + 13, 6, 1, '#3f3044'); px(x + 8, y + 15, 1, 1, '#5a4660');
    px(x + w - 9, y + 13, 6, 4, '#241a28'); px(x + w - 9, y + 13, 6, 1, '#3f3044'); px(x + w - 4, y + 15, 1, 1, '#5a4660');
    wear(x + 2, y + 8, w - 4, h - 10, 3, '#1a1220');
  };

  F.missionboard = (x, y, w, h, f) => {
    // MISSION BOARD — the quest log's body (G1b). A riveted slate briefing board; each pinned card stub is
    // one OPEN quest (f.pins, fed by world.js from the live quest projection — real direction, never
    // invented). Cap 4 visible + a '+N' counter (the OUTBOX crate idiom). While a station-gap quest is open
    // (f.hot) the whole board breathes a slow gold pulse — the "something to do" beacon. Click → QUEST LOG.
    px(x + 4, y - 3, 2, 3, '#1a2024'); px(x + w - 6, y - 3, 2, 3, '#1a2024');   // wall-mount lugs
    px(x + 4, y - 3, 2, 1, '#323c42'); px(x + w - 6, y - 3, 2, 1, '#323c42');
    box(x, y - 1, w, h + 3, '#23282c');                                          // slate casing
    px(x + 1, y, w - 2, 1, '#3a4248');                                           // bezel sheen
    rivets(x + 1, y, w - 2, h + 1, '#4a565e', '#0c1114');
    inset(x + 2, y + 1, w - 4, h, '#0d1210');                                    // the briefing well
    const pins = Math.max(0, (f && f.pins) | 0), shown = Math.min(pins, 4);
    // phosphor header strip — the terminal face names the surface (VT323, the canvas text law)
    px(x + 3, y + 2, w - 6, 4, '#0f1a14');
    ctx.fillStyle = pins > 0 ? '#7df0c8' : '#2e5a4a';
    ctx.font = "6px 'VT323','Courier New',monospace"; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('MISSIONS', x + 4, y + 6);
    if (pins > 0 && blink(600, 0)) px(x + w - 5, y + 3, 1, 1, '#7df0c8');        // live cursor tick
    // pinned card stubs — one per open quest, amber pin heads, hash-phased hang so they read as paper
    for (let i = 0; i < shown; i++) {
      const cx = x + 4 + i * 7, tilt = (U.hash('mb' + i) % 2);
      px(cx, y + 8 + tilt, 5, 5, '#0a0e0c');                                     // card shadow
      px(cx, y + 7 + tilt, 5, 5, '#b8c4b0');                                     // the card
      px(cx, y + 7 + tilt, 5, 1, '#dce6d4');                                     // top sheen
      px(cx + 1, y + 9 + tilt, 3, 1, '#5a665a'); px(cx + 1, y + 10 + tilt, 2, 1, '#5a665a');   // scrawl
      px(cx + 2, y + 6 + tilt, 1, 1, '#ffaa33');                                 // the pin
    }
    if (pins > 4) {
      ctx.fillStyle = '#ffd9a3'; ctx.font = "7px 'VT323','Courier New',monospace";
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('+' + (pins - 4), x + 4 + shown * 7 + 1, y + 12);
    }
    if (pins === 0) { px(x + 5, y + 9, w - 10, 1, '#1a2420'); px(x + 5, y + 11, w - 14, 1, '#161e1a'); }   // empty cork lines — nothing pinned, nothing claimed
    seamH(x + 1, y + h + 1, w - 2, '#23282c');
    // the beacon: a station-gap quest is OPEN — the board breathes gold (slow, gentle; a state, not an event)
    if (f && f.hot) {
      const b = 0.10 + 0.08 * (0.5 + 0.5 * Math.sin(now / 420));
      glow(x - 1, y - 2, w + 2, h + 5, '#e8c860', b);
      px(x + 2, y + 2, 1, 1, blink(840, 0.5) ? '#ffd75e' : '#3a3020');           // standing-order lamp
    }
    // G4 feature 2 PROPOSAL STATE: the agent pinned pending autojob PROPOSAL cards — a distinct amber card
    // (folded-corner "requisition" look) stacked at the board's TOP-LEFT, with a soft amber halo so a fresh
    // proposal draws the eye. Distinct from the grey quest pins and the top-right red-pinned JAM stub. Cap 3 + '+N'.
    if (f && f.proposals > 0) {
      const np = f.proposals | 0, showP = Math.min(np, 3);
      const hb = 0.09 + 0.07 * (0.5 + 0.5 * Math.sin(now / 500));
      glow(x - 1, y - 2, w + 2, h + 5, '#ffc24a', hb);                            // gentle amber "you have proposals" halo
      for (let i = 0; i < showP; i++) {
        const px0 = x + 4 + i * 3, py0 = y - 2 + i;                               // a slight fan of stacked cards
        px(px0, py0 + 1, 6, 5, '#0a0e0c');                                        // shadow
        px(px0, py0, 6, 5, '#f0b84a');                                            // amber proposal card
        px(px0, py0, 6, 1, '#ffdc8a');                                            // top sheen
        px(px0 + 4, py0, 2, 2, '#c98f2e');                                        // folded corner (requisition read)
        px(px0 + 1, py0 + 2, 3, 1, '#7a5a20'); px(px0 + 1, py0 + 3, 2, 1, '#7a5a20');   // scrawl
        px(px0 + 2, py0 - 1, 1, 1, '#ff7a3a');                                    // orange pin head
      }
      if (np > 3) {
        ctx.fillStyle = '#ffd9a3'; ctx.font = "6px 'VT323','Courier New',monospace";
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('+' + (np - 3), x + 4 + showP * 3 + 6, y + 3);
      }
    }
    // G1c JAM STATE: a routine is backed up (repeatedly skipped) — an amber pinned JAM stub over the top-right
    // corner + a faster amber wash. Distinct from the gold standing-order beacon: amber = "the line is jammed",
    // pure Factorio. A state, not an event (it clears when the routine drains).
    if (f && f.jam) {
      const jb = 0.14 + 0.10 * (0.5 + 0.5 * Math.sin(now / 260));
      glow(x - 1, y - 2, w + 2, h + 5, '#ffae3a', jb);                            // amber jam wash
      const sx = x + w - 6, sy = y + 7;                                           // the jam card, pinned top-right
      px(sx, sy + 1, 5, 5, '#0a0e0c');                                            // shadow
      px(sx, sy, 5, 5, '#f0a83a');                                               // amber card
      px(sx, sy, 5, 1, '#ffd07a');                                               // top sheen
      px(sx + 2, sy + 1, 1, 3, '#3a2410'); px(sx + 2, sy + 4, 1, 1, blink(200) ? '#3a2410' : '#f0a83a');   // "!" warning glyph (blinking dot)
      px(sx + 2, sy - 1, 1, 1, '#ff5a4a');                                        // red jam pin
    }
  };

  F.trophycase = (x, y, w, h, f) => {
    // TROPHY CASE — the station's real achievements made permanent (G3b). A glass museum cabinet: dark bolted
    // frame, two lit shelves of GOLD trophies (one per earned milestone/completed quest, f.trophies), an
    // engraved VT323 plaque, and an eerie cold museum uplight. Cap 6 visible + a '+N' counter (the OUTBOX/board
    // idiom). EMPTY = honest dust on bare shelves, never a placeholder trophy (the honesty law). Grants nothing.
    const won = Math.max(0, (f && f.trophies) | 0);
    sh(x + 2, y + h - 1, w - 4);                                            // floor contact shadow
    box(x, y, w, h, '#1c1712');                                            // dark cabinet carcass (walnut/iron)
    px(x + 1, y + 1, w - 2, 1, '#3a2f22');                                 // top rail sheen
    rivets(x + 1, y + 1, w - 2, h - 2, '#5a4a34', '#0a0806');              // corner bolts
    inset(x + 2, y + 2, w - 4, h - 8, '#0b0d0e');                          // the glass interior (dark)
    // eerie museum uplight: a cold spill washing up the case from below the glass (a state, not an event)
    const up = 0.14 + 0.05 * (0.5 + 0.5 * Math.sin(now / 900));
    glow(x + 2, y + 3, w - 4, h - 9, won > 0 ? '#c9e6ff' : '#3a4a58', up);
    // two shelves; trophies stand in a row on each (up to 3 per shelf → 6 visible)
    const shelfY = [y + 4, y + h - 12];
    const shown = Math.min(won, 6);
    for (let s = 0; s < 2; s++) {
      const sy = shelfY[s];
      px(x + 3, sy + 6, w - 6, 1, '#221b12'); px(x + 3, sy + 6, w - 6, 1, '#2e2415');   // shelf plank
      const nOn = Math.max(0, Math.min(3, shown - s * 3));
      for (let i = 0; i < 3; i++) {
        const tx = x + 4 + i * ((w - 8) / 3), on = i < nOn;
        if (on) {
          // a small gold trophy: cup + stem + base, with a glint
          const gc = '#f3c94a', gd = '#a8842a';
          px(tx + 1, sy + 1, 3, 2, gc); px(tx, sy + 1, 1, 1, gd); px(tx + 4, sy + 1, 1, 1, gd);   // cup + handles
          px(tx + 2, sy + 3, 1, 2, gd);                                    // stem
          px(tx + 1, sy + 5, 3, 1, gc);                                    // base
          if (blink(1100, (i + s) * 0.3)) px(tx + 2, sy + 1, 1, 1, '#fff2c0');   // slow glint
          glow(tx, sy, 5, 6, gc, 0.16);
        } else if (won === 0 && s === 0 && i === 1) {
          // EMPTY case honesty: a single dust mote drifting on the centre of the top shelf — nothing earned yet
          if (blink(1700, 0)) px(tx + 2, sy + 3, 1, 1, '#2a3138');
        }
      }
    }
    if (won > 6) {
      ctx.fillStyle = '#ffe6a0'; ctx.font = "7px 'VT323','Courier New',monospace";
      ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('+' + (won - 6), x + w - 3, y + 12);
    }
    // engraved plaque across the base — VT323, phosphor-gold on won, cold-dim when the case is empty
    const py = y + h - 5;
    px(x + 3, py, w - 6, 4, '#100c08');                                    // plaque recess
    px(x + 3, py, w - 6, 1, '#2c2318');
    ctx.fillStyle = won > 0 ? '#e8c860' : '#3e4650';
    ctx.font = "6px 'VT323','Courier New',monospace"; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(won > 0 ? 'HONOURS' : 'EMPTY', x + 4, py + 4);
    // glass reflection: a soft diagonal sheen across the front (reads as glass, not an open shelf)
    ctx.save(); ctx.globalAlpha = 0.07; ctx.fillStyle = '#dff0ff';
    ctx.beginPath(); ctx.moveTo(x + 3, y + 3); ctx.lineTo(x + 3 + (w >> 1), y + 3); ctx.lineTo(x + 3, y + 3 + (h >> 1)); ctx.closePath(); ctx.fill();
    ctx.restore();
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

  F.poster = (x, y) => {   // v2: freestanding A-board standee — trapezoid face, splayed legs, glowing logo
    const r = RAMP.steel;
    shadow2(x + 1, y + 11, 10);                                 // floor contact
    // rear legs splay out behind the board
    px(x, y + 9, 1, 2, '#1c242a'); px(x + 11, y + 9, 1, 2, '#1c242a');
    // hinge ridge cap on top (the A-fold)
    px(x + 2, y - 3, 8, 1, LINE);
    px(x + 3, y - 3, 6, 1, r.face); px(x + 3, y - 3, 3, 1, r.lit);
    // stepped trapezoid silhouette: narrow at the ridge, wide at the floor
    px(x + 2, y - 2, 8, 5, LINE);
    px(x + 1, y + 2, 10, 4, LINE);
    px(x, y + 5, 12, 5, LINE);
    // board face (merged across the steps)
    px(x + 3, y - 1, 6, 4, '#1a2620');
    px(x + 2, y + 2, 8, 4, '#1a2620');
    px(x + 1, y + 5, 10, 4, '#1a2620');
    px(x + 3, y - 1, 1, 3, '#243228'); px(x + 2, y + 2, 1, 3, '#243228'); px(x + 1, y + 5, 1, 3, '#243228'); // west lit
    px(x + 8, y - 1, 1, 3, '#101812'); px(x + 9, y + 2, 1, 3, '#101812'); px(x + 10, y + 5, 1, 3, '#101812'); // east shade
    // content: logo + clip bar + text lines
    px(x + 4, y, 4, 2, '#41ff8a'); px(x + 5, y + 1, 1, 1, '#1a2620'); // logo glyph
    glow(x + 4, y, 4, 2, '#41ff8a', 0.18 + 0.06 * Math.sin(now / 900)); // kept glow
    px(x + 4, y + 3, 4, 1, r.face); px(x + 4, y + 3, 1, 1, r.lit); // paper clip bar
    px(x + 3, y + 4, 6, 1, '#9adcb0');                          // headline
    px(x + 2, y + 6, 7, 1, '#9adcb0');                          // text line
    px(x + 8, y + 7, 2, 1, '#41ff8a');                          // accent tick
    px(x + 2, y + 8, 5, 1, '#5a7a64');                          // fine print
    px(x + 2, y + 5, 1, 1, '#caa84a');                          // old tape bit
    wear(x + 2, y + 5, 8, 4, 3, '#141e18');
    // front feet under the wide base
    px(x + 1, y + 10, 2, 1, '#242e35'); px(x + 9, y + 10, 2, 1, '#242e35');
  };

  F.djbooth = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE dj console: big deck top, turntables + mixer, EQ riser
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 3, x + 23, x + w - 6]) leg(lx, y + 21, 3, r);
    underAO(x + 5, y + 21, w - 10, 2);
    // short south face: panel dividers + neon rail
    rr(x - 1, y + 16, w + 2, 6, LINE);
    px(x, y + 17, w, 4, r.face);
    px(x, y + 17, w, 1, r.lit);
    for (let i = 1; i < 4; i++) px(x + i * 12, y + 18, 1, 3, r.dk);
    px(x, y + 20, w, 1, r.ao);
    glow(x + 1, y + 18, w - 2, 1, ACC.lounge, f.work ? 0.5 + 0.3 * Math.sin(now / 200) : 0.22); // neon rail
    glow(x + 2, y + 21, w - 4, 2, ACC.lounge, f.work ? 0.16 + 0.08 * Math.sin(now / 200) : 0.05); // floor spill
    // the big deck top dominates
    rr(x - 1, y - 3, w + 2, 20, LINE);
    rr(x, y - 2, w, 18, r.top);
    px(x + 1, y - 2, w - 2, 1, r.sheen);
    px(x + 1, y - 1, 6, 1, U.shade(r.sheen, 0.12));
    px(x, y - 1, 1, 16, r.lit); px(x + w - 1, y - 1, 1, 16, r.dk);
    px(x + 1, y + 15, w - 2, 1, U.shade(r.top, -0.16));         // top front lip
    wear(x + 2, y, w - 4, 14, 4, U.shade(r.top, -0.08));
    // twin turntables (top view): rounded platter + grooves + label + tonearm + stylus orbit
    for (const tx of [x + 5, x + w - 16]) {
      rr(tx - 1, y + 1, 13, 12, LINE);
      rr(tx, y + 2, 11, 10, '#161a20');
      px(tx + 1, y + 2, 9, 1, '#262c36');                       // plinth catch
      rr(tx + 1, y + 3, 9, 8, '#111');
      rr(tx + 2, y + 4, 7, 6, '#222');
      px(tx + 2, y + 4, 7, 1, '#2e2e2e'); px(tx + 2, y + 8, 7, 1, '#1a1a1a'); // groove rings
      px(tx + 4, y + 6, 3, 2, '#0a0a0a');
      px(tx + 4, y + 6, 1, 1, ACC.lounge);                      // label dot
      px(tx + 9, y + 3, 1, 4, '#4a5866'); px(tx + 8, y + 7, 1, 1, '#5c6c7c'); // tonearm
      if (f.work) {
        const a = now / 250 + tx;
        px(tx + 5 + Math.round(Math.cos(a) * 3), y + 7 + Math.round(Math.sin(a) * 2), 1, 1, '#ffe0f4'); // stylus glint
      }
    }
    // mixer between the decks: faders + cue LEDs
    inset(x + w / 2 - 6, y + 3, 12, 9, '#1a1420');
    px(x + w / 2 - 5, y + 3, 10, 1, '#332840');                 // mixer face catch
    for (let i = 0; i < 3; i++) {
      px(x + w / 2 - 3 + i * 3, y + 5, 1, 6, '#3a2a4e');        // fader slots
      const sv = f.work ? Math.abs(Math.floor(flick(150, i) * 2)) : 1;
      px(x + w / 2 - 3 + i * 3, y + 9 - sv, 1, 2, ACC.lounge);
      px(x + w / 2 - 3 + i * 3, y + 9 - sv, 1, 1, '#ffa8e8');   // fader cap shine
    }
    for (let i = 0; i < 4; i++) px(x + w / 2 - 4 + i * 2, y + 4, 1, 1, blink(300, i) && f.work ? ACC.data : '#2c1c40'); // cue LEDs
    // EQ riser standing on the back edge (the signature animation, facing south)
    rr(x + 9, y - 9, w - 18, 8, LINE);
    px(x + 10, y - 8, w - 20, 6, '#151021');
    px(x + 10, y - 8, w - 20, 1, '#2a2038');                    // riser catch
    for (let i = 0; i < (w - 24) / 3; i++) {                    // EQ bars with peak-hold dots
      const hh = f.work ? 1 + Math.abs(Math.floor(flick(90, i) * 3)) : 1;
      const c = ['#b44aff', ACC.lounge, ACC.data][i % 3];
      px(x + 12 + i * 3, y - 2 - hh, 2, hh, c);
      if (f.work) px(x + 12 + i * 3, y - 3 - hh, 2, 1, U.shade(c, 0.45));
    }
    glow(x + 10, y - 8, w - 20, 6, ACC.lounge, f.work ? 0.12 : 0.05);
    if (f.work) px(x + w / 2 - 1, y - 9, 2, 1, blink(150) ? ACC.lounge : ACC.data); // beat lamp
    // record crate resting on the east end of the top
    px(x + w - 9, y + 12, 6, 3, '#1d1826'); px(x + w - 9, y + 12, 6, 1, '#332c44');
    px(x + w - 8, y + 11, 1, 1, '#b44aff'); px(x + w - 6, y + 11, 1, 1, ACC.data); // sleeve edges
  };

  F.speaker = (x, y, w, h, f) => {   // small rounded lounge speaker cab, freestanding
    const r = RAMP.fabric;
    shadow2(x + 2, y + h - 1, 8);
    for (const lx of [x + 2, x + 7]) {                          // stub feet
      px(lx, y + 10, 3, 2, LINE); px(lx, y + 10, 1, 2, r.lit); px(lx + 1, y + 10, 1, 2, r.dk);
    }
    underAO(x + 4, y + 10, 4, 1);
    // rounded cab with a narrow lit top
    rr(x + 1, y - 3, 10, 13, LINE);
    px(x + 2, y - 2, 8, 11, r.face);
    px(x + 2, y, 1, 9, U.shade(r.face, 0.10)); px(x + 9, y, 1, 9, r.dk); // side facets
    px(x + 2, y - 2, 8, 2, r.top);
    px(x + 2, y - 2, 8, 1, r.sheen);                            // top catch
    px(x + 2, y + 8, 8, 1, r.ao);                               // base AO
    // driver: surround ring + cone + dust cap
    rr(x + 3, y + 1, 6, 6, '#2c3641');
    px(x + 4, y + 1, 4, 1, '#40495a');                          // ring catch
    rr(x + 4, y + 2, 4, 4, '#10151b');
    px(x + 5, y + 3, 2, 2, '#06090c');
    px(x + 5, y + 3, 1, 1, '#39434f');                          // cap glint
    if (f.work) {
      glow(x + 3, y + 1, 6, 6, ACC.lounge, blink(170, x) ? 0.28 : 0.08); // cone throb
      if (blink(170, x)) px(x + 5, y + 3, 2, 2, '#1c1220');
    }
    px(x + 5, y + 7, 2, 1, '#0e1216');                          // bass port
    px(x + 8, y - 1, 1, 1, f.work && blink(400, x) ? ACC.lounge : '#3a2434'); // power LED
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

  F.ticker = (x, y, w, h) => {   // v2 freestanding: crawl display riding rolling posts
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, w - 4);
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx - 1, y + 5, 4, h - 7, LINE);
      px(pxx, y + 6, 1, h - 8, r.lit); px(pxx + 1, y + 6, 1, h - 8, r.dk);
      rr(pxx - 3, y + h - 3, 8, 2, LINE);
      px(pxx - 2, y + h - 3, 6, 1, r.face);
      px(pxx - 2, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 2, y + h - 1, 2, 1, '#1a1e22');
      ctx.globalAlpha = 0.30; px(pxx - 3, y + h, 8, 1, '#000'); ctx.globalAlpha = 1;
    }
    // slim rounded marquee body
    rr(x, y - 5, w, 12, LINE);
    px(x + 1, y - 4, w - 2, 10, r.face);
    px(x + 1, y - 4, w - 2, 1, r.lit);
    px(x + 2, y - 4, 1, 1, '#56645c'); px(x + w - 3, y - 4, 1, 1, '#56645c');
    px(x + 1, y + 5, w - 2, 1, r.ao);
    inset(x + 2, y - 3, w - 4, 7, '#0a1608');
    // scrolling quote crawl with dim ghost pass (kept 1:1)
    ctx.save(); ctx.beginPath(); ctx.rect(x + 3, y - 2, w - 6, 5); ctx.clip();
    const off = Math.floor(now / 200) % 8;
    ctx.fillStyle = '#2c5218'; ctx.font = '7px monospace';
    ctx.fillText('Q' + (8 - off) + '4' + off + '.. +' + off + '%', x + 3 - off + 14, y + 3);
    ctx.fillStyle = '#9bff4a';
    ctx.fillText('Q' + (8 - off) + '4' + off + '.. +' + off + '%', x + 3 - off, y + 3);
    ctx.restore();
    scanl(x + 3, y - 2, w - 6, 5, 0.14);
    glow(x + 3, y - 2, w - 6, 5, '#9bff4a', 0.05 + 0.02 * Math.sin(now / 700));
    px(x + 2, y + 3, w - 4, 1, '#13200f');                      // display divider (kept)
    for (let i = 0; i < (w - 6) / 4; i++) {                     // mini bar chart strip (kept)
      const bh = 1 + (U.hash('tk' + i) % 2);
      const red = i % 4 === 3;
      px(x + 3 + i * 4, y + 6 - bh, 2, bh, red ? '#ff5c5c' : '#41ff8a');
      px(x + 3 + i * 4, y + 6 - bh, 1, 1, red ? '#ff8a8a' : '#8affb8'); // bar cap
    }
    px(x + 2, y + 5, 1, 1, blink(700) ? '#9bff4a' : '#1c2a1a'); // power LED (kept)
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

  F.chartwall = (x, y, w, h) => {   // v2 freestanding: triple chart bank riding rolling posts
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, w - 4);
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx - 1, y + 5, 4, h - 7, LINE);
      px(pxx, y + 6, 1, h - 8, r.lit); px(pxx + 1, y + 6, 1, h - 8, r.dk);
      rr(pxx - 3, y + h - 3, 8, 2, LINE);
      px(pxx - 2, y + h - 3, 6, 1, r.face);
      px(pxx - 2, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 2, y + h - 1, 2, 1, '#1a1e22');
      ctx.globalAlpha = 0.30; px(pxx - 3, y + h, 8, 1, '#000'); ctx.globalAlpha = 1;
    }
    rr(x, y - 5, w, 12, LINE);
    px(x + 1, y - 4, w - 2, 10, r.face);
    px(x + 1, y - 4, w - 2, 1, r.lit);
    px(x + 2, y - 4, 1, 1, '#56645c'); px(x + w - 3, y - 4, 1, 1, '#56645c');
    px(x + 1, y + 5, w - 2, 1, r.ao);
    const pw = Math.floor((w - 6) / 3) - 2;
    for (let i = 0; i < 3; i++) {
      const px0 = x + 3 + i * (pw + 2);
      inset(px0, y - 3, pw, 8, '#1a1218');
      px(px0 + 1, y - 3, 3, 1, i === 1 ? '#ff5c7a' : '#a0a8ff'); // panel color tab (kept)
      for (let gx = 0; gx < pw - 2; gx += 4) px(px0 + 1 + gx, y + 2, 1, 1, '#241a20'); // grid
      px(px0 + 1, y - 1, pw - 2, 1, '#221820');                 // mid gridline
      // dim echo trace behind the live one (kept 1:1)
      ctx.strokeStyle = '#3a2832'; ctx.lineWidth = 1; ctx.beginPath();
      for (let j = 0; j < pw - 2; j++) {
        const yy = y + 3 - (U.hash('ch' + i + ((j + 3) >> 1)) % 5);
        j ? ctx.lineTo(px0 + 1 + j, yy) : ctx.moveTo(px0 + 1 + j, yy);
      }
      ctx.stroke();
      ctx.strokeStyle = i === 1 ? '#ff5c7a' : '#a0a8ff'; ctx.beginPath();
      for (let j = 0; j < pw - 2; j++) {
        const yy = y + 3 - (U.hash('ch' + i + (j >> 1)) % 5) - (i === 1 && j > pw - 6 ? -2 : 0);
        j ? ctx.lineTo(px0 + 1 + j, yy) : ctx.moveTo(px0 + 1 + j, yy);
      }
      ctx.stroke();
      px(px0 + pw - 3, y - 2 + (Math.floor(now / 400 + i) % 4), 1, 1, i === 1 ? '#ff5c7a' : '#a0a8ff'); // live tick
      glow(px0, y - 3, pw, 8, i === 1 ? '#ff5c7a' : '#a0a8ff', 0.04); // panel cast
      if (i < 2) px(px0 + pw, y - 1, 1, 4, '#1c1218');          // inter-panel conduit
    }
  };

  F.wartable = (x, y, w, h) => {   // v2 TOP-BIAS OBLIQUE war table: tactical map on the big top, legs on the floor
    const r = RAMP.gun;
    shadow2(x + 2, y + h - 1, w - 4);
    // chunky corner legs
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + h - 6, 3, 5, LINE);
      px(lx, y + h - 6, 1, 5, r.lit); px(lx + 1, y + h - 6, 1, 5, r.dk);
      ctx.globalAlpha = 0.30; px(lx - 1, y + h - 1, 5, 1, '#000'); ctx.globalAlpha = 1;
    }
    underAO(x + 6, y + h - 6, w - 12, 2);
    // short south face
    rr(x - 1, y + h - 12, w + 2, 7, LINE);
    px(x, y + h - 11, w, 5, r.face);
    px(x, y + h - 11, w, 1, r.lit);
    px(x, y + h - 10, 1, 4, U.shade(r.face, 0.08));
    px(x + w - 1, y + h - 10, 1, 4, r.dk);
    px(x, y + h - 7, w, 1, r.ao);
    // edge control strips on the face (kept)
    px(x + 7, y + h - 9, 6, 1, '#241218');
    for (let i = 0; i < 3; i++) px(x + 8 + i * 2, y + h - 9, 1, 1, blink(500, i) ? '#ff5c7a' : '#3a2030');
    px(x + w - 13, y + h - 9, 6, 1, '#241218');
    for (let i = 0; i < 3; i++) px(x + w - 12 + i * 2, y + h - 9, 1, 1, blink(700, i + 4) ? '#ffd34a' : '#3a3020');
    // the big rounded top
    rr(x - 1, y, w + 2, h - 11, LINE);
    px(x, y + 1, w, h - 13, r.top);
    px(x + 1, y + 1, w - 2, 1, r.sheen);
    px(x + 1, y + 2, 5, 1, U.shade(r.sheen, 0.12));
    px(x, y + 2, 1, h - 15, r.lit); px(x + w - 1, y + 2, 1, h - 15, r.dk);
    px(x + 1, y + h - 13, w - 2, 1, U.shade(r.top, -0.16));
    wear(x + 1, y + 1, w - 2, h - 14, 3, U.shade(r.top, -0.08));
    // corner posts with status studs on the top (kept)
    for (const [cx2, cy2] of [[x + 2, y + 2], [x + w - 4, y + 2], [x + 2, y + h - 15], [x + w - 4, y + h - 15]]) {
      px(cx2, cy2, 2, 2, U.shade(r.top, 0.14));
      px(cx2, cy2, 1, 1, blink(800, cx2 + cy2) ? '#ff5c7a' : '#52303c');
    }
    // recessed map well in the top
    inset(x + 4, y + 3, w - 8, h - 16, '#1a1016');
    const wx = x + 5, wy = y + 4, ww = w - 10, wh = h - 18;
    for (let gx = 8; gx < ww - 2; gx += 8) px(wx + gx, wy, 1, wh, '#241620'); // grid (kept)
    px(wx, wy + 3, ww, 1, '#241620');
    for (let gx = 8; gx < ww - 4; gx += 8) px(wx + gx - 1, wy, 3, 1, '#3a2030'); // sector dashes (kept)
    const a = 0.5 + 0.3 * Math.sin(now / 500);
    for (let i = 0; i < 5; i++) {                               // threat blips + pulse rings (kept)
      const bx = wx + 3 + i * 9, by = wy + (i % 3) * 2;
      ctx.globalAlpha = a; px(bx, by, 2, 2, '#ff5c7a');
      px(bx, by, 1, 1, '#ffb0c0');                              // blip core
      const rad = ((now / 600 + i * 0.4) % 1) * 3;
      ctx.strokeStyle = '#ff5c7a'; ctx.globalAlpha = a * (1 - rad / 3);
      ctx.beginPath(); ctx.arc(bx + 1, by + 1, rad + 1, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // targeting reticle stepping between blips (kept)
    const tgt = Math.floor(now / 2400) % 5;
    const tx2 = wx + 3 + tgt * 9, ty2 = wy + (tgt % 3) * 2;
    if (blink(300)) {
      px(tx2 - 2, ty2 - 1, 2, 1, '#ffd34a'); px(tx2 + 2, ty2 - 1, 2, 1, '#ffd34a');
      px(tx2 - 2, ty2 + 2, 2, 1, '#ffd34a'); px(tx2 + 2, ty2 + 2, 2, 1, '#ffd34a');
    }
    glow(wx + ((now / 25) % (ww - 2)), wy, 1, wh, '#ff8ba0', 0.35); // radar sweep (kept)
    glow(x + 4, y + 3, w - 8, h - 16, '#ff5c7a', 0.04 + 0.02 * Math.sin(now / 800)); // table haze (kept)
  };

  F.calwall = (x, y, w, h) => {   // v2 freestanding: schedule board on two heavy rolling posts
    const r = RAMP.steel;
    shadow2(x + 3, y + h - 1, w - 6);
    for (const pxx of [x + 8, x + w - 10]) {
      px(pxx - 1, y + 5, 4, h - 7, LINE);
      px(pxx, y + 6, 1, h - 8, r.lit); px(pxx + 1, y + 6, 1, h - 8, r.dk);
      rr(pxx - 4, y + h - 3, 10, 2, LINE);                      // wide T-foot
      px(pxx - 3, y + h - 3, 8, 1, r.face);
      px(pxx - 3, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 3, y + h - 1, 2, 1, '#1a1e22');
      ctx.globalAlpha = 0.30; px(pxx - 4, y + h, 10, 1, '#000'); ctx.globalAlpha = 1;
    }
    rr(x, y - 6, w, 13, LINE);
    px(x + 1, y - 5, w - 2, 11, r.face);
    px(x + 1, y - 5, w - 2, 1, r.lit);
    px(x + 2, y - 5, 1, 1, '#56645c'); px(x + w - 3, y - 5, 1, 1, '#56645c');
    px(x + 1, y + 5, w - 2, 1, r.ao);
    // 7x2 day grid with the marching week (kept 1:1, fitted to the footprint)
    const cw2 = Math.floor((w - 4) / 7);
    const gx0 = x + 2 + ((w - 4 - 7 * cw2) >> 1);
    const prog = (now / 1400) % 14;
    for (let i = 0; i < 7; i++) for (let j = 0; j < 2; j++) {
      const idx = i + j * 7;
      const lit = idx < prog;
      const wknd = i > 4;                                       // weekend columns tinted (kept)
      const cx3 = gx0 + i * cw2, cy3 = y - 4 + j * 5;
      inset(cx3, cy3, cw2 - 1, 5, lit ? (wknd ? '#42434e' : '#3a4750') : (wknd ? '#26262e' : '#222a30'));
      if (lit) {
        px(cx3 + 1, cy3 + 1, 5, 1, '#ffe066');
        px(cx3 + 1, cy3 + 1, 2, 1, '#fff4c0');                  // entry highlight
        px(cx3 + cw2 - 4, cy3 + 3, 2, 1, '#41ff8a');            // done check
      }
      if (Math.floor(prog) === idx) {
        if (blink(400)) px(cx3 + 1, cy3 + 3, 3, 1, '#fff4c0');  // today cursor
        px(cx3, cy3, cw2 - 1, 1, '#ffe066');                    // today ring top
        px(cx3, cy3 + 4, cw2 - 1, 1, '#8a7a34');
      }
      px(cx3 + cw2 - 4, cy3 + 1, 2, 1, '#2e3840');              // date notch
    }
  };

  F.tube = (x, y, w, h) => { // horizontal specimen tube: glass cylinder on cradle stands
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    // two cradle stands with splayed bases
    for (const sx of [x + 3, x + w - 7]) {
      px(sx - 1, y + 4, 6, h - 5, LINE);
      px(sx, y + 5, 4, h - 7, r.face);
      px(sx, y + 5, 1, h - 7, r.lit); px(sx + 3, y + 5, 1, h - 7, r.dk);
      px(sx - 1, y + h - 2, 6, 1, r.ao);
    }
    px(x + 4, y + 6, 2, 2, blink(800, 0) ? '#ffe066' : '#2e3840'); // end lights (kept)
    px(x + w - 6, y + 6, 2, 2, blink(800, 1) ? '#ffe066' : '#2e3840');
    // pressure gauge hung under the barrel (kept wobble)
    px(x + w / 2 - 2, y + 5, 4, 3, '#28323a'); px(x + w / 2 - 2, y + 5, 4, 1, '#3a464e');
    px(x + w / 2 - 1 + Math.round(Math.sin(now / 400)), y + 6, 1, 1, '#ffe066');
    // the glass cylinder lying across the cradles: bold capsule silhouette
    rr(x - 1, y - 4, w + 2, 10, LINE);
    rr(x, y - 3, w, 8, '#1a2228');
    px(x + 3, y - 3, w - 6, 1, '#3a4a55');                     // top curve catch
    px(x + 3, y - 2, w - 6, 1, '#56707e');                     // glass sheen line
    px(x + 3, y + 3, w - 6, 1, '#0e161c');                     // barrel underside
    glow(x + 4, y - 2, 3, 4, '#fffbe0', 0.12);                 // glass highlight (kept)
    const ph = (now / 900) % 1;                                // capsule whoosh (kept)
    if (ph < 0.4) {
      const capx = x + 4 + Math.floor(ph / 0.4 * (w - 11));
      px(capx, y - 1, 3, 2, '#ffe066');
      px(capx - 1, y - 1, 1, 2, '#8a7a34'); px(capx - 2, y, 1, 1, '#5a5024'); // speed lines
      px(capx, y - 1, 1, 1, '#fff4c0');                        // nose shine
    } else if (ph < 0.45 && blink(80)) {
      px(x + w - 8, y - 1, 2, 2, '#fff4c0');                   // arrival flash (kept)
    }
    // brass end fittings + center clamp ring (kept)
    px(x, y - 3, 3, 8, '#56646e'); px(x + w - 3, y - 3, 3, 8, '#56646e');
    px(x, y - 3, 1, 8, '#6e7c86'); px(x + w - 1, y - 3, 1, 8, '#3a444c');
    px(x, y - 3, 3, 1, '#7e8c96'); px(x + w - 3, y - 3, 3, 1, '#6e7c86');
    px(x, y + 4, 3, 1, '#2e3a44'); px(x + w - 3, y + 4, 3, 1, '#2e3a44');
    px(x + w / 2 - 1, y - 3, 2, 8, '#46525c'); px(x + w / 2 - 1, y - 3, 2, 1, '#5a6a76');
    px(x + w / 2 - 1, y + 4, 2, 1, '#2e3a44');
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

  F.bar = (x, y, w, h) => {   // TOP-BIAS OBLIQUE counter: big steel top with drinks, kick gap + foot rail
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 5]) {                      // end feet blocks
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    px(x + 4, y + 10, w - 8, 1, '#78868f');                     // chrome foot rail in the kick gap
    px(x + 4, y + 11, w - 8, 1, '#2c363c');                     // rail shadow
    // short front face: panel dividers + under-counter neon
    rr(x - 1, y + 4, w + 2, 6, LINE);
    px(x, y + 5, w, 4, r.face);
    px(x, y + 5, w, 1, r.lit);
    for (let i = 1; i < 3; i++) px(x + i * 16, y + 6, 1, 3, r.dk); // panel dividers
    px(x, y + 8, w, 1, r.ao);
    glow(x + 1, y + 8, w - 2, 1, ACC.lounge, 0.16 + 0.06 * Math.sin(now / 700)); // under-counter accent
    // the counter top dominates
    rr(x - 1, y - 3, w + 2, 9, LINE);
    rr(x, y - 2, w, 7, r.top);
    px(x + 1, y - 2, w - 2, 1, r.sheen);
    for (let i = 0; i < w / 8; i++) px(x + 3 + i * 8, y - 1, 3, 1, U.shade(r.sheen, 0.06)); // brushed streaks
    px(x, y - 1, 1, 5, r.lit); px(x + w - 1, y - 1, 1, 5, r.dk);
    px(x + 1, y + 4, w - 2, 1, U.shade(r.top, -0.16));          // top front edge
    wear(x + 2, y - 1, w - 4, 5, 4, U.shade(r.top, -0.08));
    // beer tap rising off the back edge, with drip
    px(x + w / 2 - 6, y - 6, 1, 5, '#aab8c8'); px(x + w / 2 - 6, y - 7, 2, 1, '#caa84a'); // column + brass handle
    px(x + w / 2 - 7, y - 3, 1, 1, '#8a98a8');                  // spout
    px(x + w / 2 - 6, y - 1, 3, 1, U.shade(r.top, -0.22));      // tap base plate
    if ((now % 2400) < 200) px(x + w / 2 - 7, y - 2, 1, 1, '#ffd9a0'); // drip
    // drinks ON the counter
    px(x + 5, y, 3, 3, '#8a98a8'); px(x + 5, y, 3, 1, '#caa84a'); px(x + 5, y, 1, 3, '#aab8c8'); // can
    px(x + w - 9, y - 2, 2, 5, '#7adfd0'); px(x + w - 9, y - 3, 2, 1, '#3a6a62'); px(x + w - 9, y - 1, 1, 3, '#bffff2'); // bottle
    px(x + w / 2 + 3, y + 1, 2, 2, '#9ab8c8'); px(x + w / 2 + 6, y + 1, 2, 2, '#9ab8c8'); // drying glasses
    px(x + w / 2 + 3, y + 2, 2, 1, '#6a8898'); px(x + w / 2 + 6, y + 2, 2, 1, '#6a8898');
    rr(x + w / 2 - 3, y + 1, 6, 3, '#20282a');                  // bar mat
    px(x + w / 2 - 2, y + 1, 4, 1, '#2a3436');
    px(x + w / 2 + 10, y + 1, 3, 2, '#dfe8df');                 // napkin
  };

  F.stool = (x, y) => {   // v2: round gas-lift task stool — big oval seat, chrome lift, splayed foot ring
    const r = RAMP.steel;
    shadow2(x + 3, y + 10, 7);                                  // floor contact
    // oval foot ring + rubber pads
    px(x + 3, y + 8, 6, 1, LINE);
    px(x + 2, y + 9, 8, 1, LINE);
    px(x + 3, y + 10, 6, 1, LINE);
    px(x + 3, y + 9, 6, 1, '#46535c');
    px(x + 3, y + 9, 2, 1, '#5e6c76');                          // ring glint west
    px(x + 3, y + 10, 2, 1, '#1a1e22'); px(x + 7, y + 10, 2, 1, '#1a1e22'); // pads
    // gas-lift column (kept construction)
    px(x + 4, y + 5, 4, 4, LINE);
    px(x + 5, y + 5, 1, 3, '#5e6c76'); px(x + 6, y + 5, 1, 3, '#39434b');
    px(x + 5, y + 6, 2, 1, '#6d7a84');                          // lift collar
    px(x + 8, y + 5, 2, 1, '#39434b'); px(x + 10, y + 5, 1, 1, '#1a1e22'); // adjust lever
    // BIG round cushioned seat (dominates: this is a top-down game)
    px(x + 3, y, 6, 1, LINE);
    px(x + 2, y + 1, 8, 1, LINE);
    px(x + 1, y + 2, 10, 2, LINE);
    px(x + 2, y + 4, 8, 1, LINE);
    px(x + 3, y + 5, 6, 1, LINE);
    px(x + 3, y + 1, 6, 1, '#4a8a82');                          // pad top, brightest
    px(x + 3, y + 1, 2, 1, '#5aa89c');                          // west sheen
    px(x + 2, y + 2, 8, 1, '#2f6a62');
    px(x + 2, y + 2, 1, 1, '#4a8a82'); px(x + 9, y + 2, 1, 1, '#26554e');
    px(x + 2, y + 3, 8, 1, '#2f6a62');
    px(x + 2, y + 3, 1, 1, '#4a8a82'); px(x + 9, y + 3, 1, 1, '#26554e');
    px(x + 3, y + 3, 1, 1, '#26554e'); px(x + 8, y + 3, 1, 1, '#26554e'); // piping stitches (kept)
    px(x + 3, y + 4, 6, 1, r.dk);                               // rounded underside rim
  };

  F.tv = (x, y, w, h, f) => {   // screen slab standing on a LOW media credenza; screen faces south
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 5]) {                      // credenza feet
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // credenza face: doors + pulls
    rr(x - 1, y + 4, w + 2, 6, LINE);
    px(x, y + 5, w, 4, r.face);
    px(x, y + 5, w, 1, r.lit);
    px(x + 12, y + 6, 1, 3, r.dk); px(x + 24, y + 6, 1, 3, r.dk); // door seams
    px(x + 5, y + 6, 2, 1, r.dk); px(x + 17, y + 6, 2, 1, r.dk); px(x + 29, y + 6, 2, 1, r.dk); // pulls
    px(x, y + 8, w, 1, r.ao);
    // credenza top
    rr(x - 1, y + 1, w + 2, 5, LINE);
    rr(x, y + 2, w, 3, r.top);
    px(x + 1, y + 2, w - 2, 1, r.sheen);
    // the TV slab
    px(x + 7, y + 2, 2, 1, '#0c1014'); px(x + w - 9, y + 2, 2, 1, '#0c1014'); // stand feet
    rr(x + 2, y - 11, w - 4, 14, LINE);
    px(x + 3, y - 10, w - 6, 12, '#12181d');                    // bezel
    px(x + 3, y - 10, w - 6, 1, '#232d33');                     // bezel catch
    const sx = x + 4, sy = y - 9, sw = w - 8, sh2 = 9;
    const mode = Math.floor(now / 4000) % 3;
    if (mode === 0) { // static
      px(sx, sy, sw, sh2, '#101418');
      for (let i = 0; i < 30; i++) px(sx + (U.hash('tv' + i + Math.floor(now / 90)) % sw), sy + (U.hash('tw' + i + Math.floor(now / 90)) % sh2), 1, 1, '#9aa');
      px(sx, sy + (Math.floor(now / 130) % sh2), sw, 1, '#202830'); // rolling bar
    } else if (mode === 1) { // movie: sunset over water
      px(sx, sy, sw, sh2, '#1a3a5a'); px(sx, sy, sw, 2, '#2a5a7a');
      px(sx + 3, sy + 2, 6, 2, '#e8c860'); px(sx + 4, sy + 1, 4, 1, '#f0d880'); // sun dome
      px(sx + 3, sy + 5, 6, 1, '#8a7a4a'); px(sx + 4, sy + 7, 4, 1, '#6a6038'); // water glints
      px(sx + 18, sy + 4, 8, 3, '#0e2436');
      px(sx + 18, sy + 4, 8, 1, '#16344a');                     // island rim light
    } else { // news: anchor + headlines
      px(sx, sy, sw, sh2, '#3a1a2a');
      px(sx + 2, sy, 8, 1, '#4a2436');                          // studio backdrop band
      px(sx + 3, sy + 1, 5, 5, '#caa088'); px(sx + 4, sy + 2, 1, 1, '#222'); px(sx + 6, sy + 2, 1, 1, '#222');
      px(sx + 4, sy + 4, 3, 1, '#a08068');                      // mouth shadow
      px(sx + 3, sy + 6, 5, 1, '#2a3a5a');                      // suit
      px(sx + 10, sy + 2, 12, 1, '#e0e0e0'); px(sx + 10, sy + 4, 9, 1, '#b0b0b0');
      px(sx + 10, sy + 2, 4, 1, '#ffffff');                     // headline pop
      px(sx, sy + 7, sw, 2, '#2a1220'); px(sx + 1 + (Math.floor(now / 160) % (sw - 11)), sy + 7, 10, 1, '#ff5c7a'); // crawling ticker
      px(sx + sw - 6, sy, 4, 2, '#ff5c7a'); px(sx + sw - 5, sy, 2, 1, '#ffa8b8'); // LIVE bug
    }
    scanl(sx, sy, sw, sh2, 0.08);
    glow(sx, sy, 6, 2, '#ffffff', 0.06);                        // glass glint
    const watched = !!(f && f.work);   // someone on the couch → screen spills more light, LED goes solid
    glow(x + 4, y + 3, w - 8, 2, mode === 1 ? '#2a5a7a' : '#3a1a2a', watched ? 0.30 : 0.15);
    px(x + w / 2 - 1, y, 2, 1, '#1e262c');                      // brand chip on the chin
    px(x + 8, y + 3, w - 16, 1, '#161c22');                     // soundbar on the credenza
    px(x + 10, y + 3, 1, 1, '#2e2e2e'); px(x + w - 11, y + 3, 1, 1, '#2e2e2e');
    px(x + w - 6, y, 1, 1, watched ? '#ff6a6a' : (blink(1400) ? '#ff3030' : '#3a1010')); // standby LED
  };

  F.couch = (x, y, w, h) => {   // TOP-BIAS OBLIQUE lounge sofa seen from BEHIND — it faces north (the TV),
    const r = RAMP.fabric;      // so the camera gets the tall upholstered rear panel; sitters peek over the cap
    shadow2(x + 1, y + h - 1, w - 2);                            // floor contact
    // throw-pillow tops leaning on the far seat, just proud of the back line
    px(x + 6, y - 8, 7, 4, LINE);
    px(x + 7, y - 7, 5, 3, '#2f6a62'); px(x + 7, y - 7, 5, 1, '#4a8a82');
    px(x + w - 13, y - 8, 7, 4, LINE);
    px(x + w - 12, y - 7, 5, 3, '#8a6a3a'); px(x + w - 12, y - 7, 5, 1, '#caa84a');
    // backrest from behind: rounded lit cap + ONE tall rear panel dropping to the floor
    rr(x + 1, y - 5, w - 2, h + 5, LINE);
    px(x + 2, y - 4, w - 4, 2, r.lit);                           // cap catches the light
    px(x + 2, y - 4, 8, 1, U.shade(r.lit, 0.10));
    px(x + 2, y - 2, w - 4, h, r.face);                          // rear upholstery panel
    px(x + 2, y - 2, 1, h, U.shade(r.face, 0.10));               // lit west facet
    px(x + w - 3, y - 2, 1, h, r.dk);                            // dark east facet
    for (let i = 1; i < (w - 4) / 14; i++) px(x + 2 + i * 14, y - 1, 1, h - 2, r.dk); // panel seams
    wear(x + 2, y - 1, w - 4, h - 2, 6, U.shade(r.face, -0.08));
    px(x + 2, y + h - 3, w - 4, 1, U.shade(r.face, -0.16));      // kick-line shadow near the floor
    px(x + 2, y + h - 2, w - 4, 1, r.ao);                        // floor-line ambient occlusion
    // arms: rounded caps that step DOWN from the back and wrap the ends to the floor
    for (const ax of [x, x + w - 4]) {
      rr(ax - 1, y - 3, 6, h + 3, LINE);
      px(ax, y - 2, 4, h + 1, r.face);
      px(ax, y - 2, 4, 2, r.lit); px(ax, y - 2, 3, 1, U.shade(r.lit, 0.10)); // arm cap
      px(ax === x ? ax : ax + 3, y, 1, h - 2, ax === x ? U.shade(r.face, 0.10) : r.dk); // outer facet
      px(ax, y + h - 2, 4, 1, r.ao);                             // arm base AO
    }
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

  F.arcade2 = (x, y, w, h, f) => {   // TALL 3/4 rhythm cabinet — sibling of F.arcade, teal identity
    const cw = 13, bh = h, r = RAMP.steel;
    shadow2(x + 1, y + bh - 1, cw - 2);
    // body: chamfered slab, side facets
    rr(x - 1, y - 5, cw + 2, bh + 4, LINE);
    px(x + 1, y - 3, cw - 2, bh + 1, r.face);
    px(x + 1, y - 3, 1, bh, U.shade(r.face, 0.10)); px(x + cw - 2, y - 3, 1, bh, r.dk);
    // cap: the top surface we look down on
    rr(x, y - 7, cw, 3, LINE);
    px(x + 1, y - 6, cw - 2, 2, r.top);
    px(x + 1, y - 6, cw - 2, 1, r.sheen);
    // marquee JUTS out wider than the body — teal
    rr(x - 2, y - 5, cw + 4, 4, LINE);
    px(x - 1, y - 4, cw + 2, 2, blink(900, 2) ? '#2ee6c8' : '#1a3a3a');
    px(x + 2, y - 4, 3, 1, '#bff8ee');                          // marquee glint
    glow(x - 1, y - 4, cw + 2, 2, '#2ee6c8', blink(900, 2) ? 0.45 : 0.12);
    px(x - 1, y - 2, cw + 2, 1, U.shade('#1a3a3a', -0.35));     // marquee underside shadow
    px(x + 1, y + 2, 1, bh - 10, '#2ee6c8');                    // side art stripe
    px(x + 1, y + 3, 1, 2, '#bff8ee');
    // screen: the waveform game
    inset(x + 2, y - 1, cw - 4, 9, '#0a1216');
    const fr = Math.floor(now / 200) % 5;
    px(x + 3, y + 3, cw - 6, 1, '#12262a');                     // midline
    for (let i = 0; i < 4; i++) {
      px(x + 3 + i * 2, y + 5 - ((fr + i) % 5), 1, 1, '#2ee6c8');   // waveform
      px(x + 3 + i * 2, y + 6 - ((fr + i + 2) % 5), 1, 1, '#15564c'); // echo trace
    }
    px(x + 3 + ((fr + 2) % 4) * 2, y + 5 - ((fr * 2) % 5), 1, 1, '#dffaf4'); // combo spark
    scanl(x + 2, y, cw - 4, 8, 0.12);
    glow(x + 2, y - 1, cw - 4, 9, '#2ee6c8', 0.06);
    // control deck JUTS toward the camera: rhythm pads
    rr(x - 1, y + 9, cw + 2, 4, LINE);
    px(x, y + 10, cw, 2, r.top);
    px(x, y + 10, cw, 1, r.sheen);
    px(x + 3, y + 11, 2, 1, '#2ee6c8'); px(x + 3, y + 11, 1, 1, '#bff8ee'); // pad + shine
    px(x + 7, y + 11, 2, 1, '#caa84a');                         // second pad
    px(x + 10, y + 11, 1, 1, '#ff5c5c');                        // stop button
    px(x, y + 12, cw, 1, r.dk);                                 // deck front lip
    // coin door on the lower face
    px(x + 3, y + bh - 7, cw - 6, 3, r.dk); px(x + 3, y + bh - 7, cw - 6, 1, U.shade(r.face, 0.10));
    px(x + 5, y + bh - 6, 2, 1, blink(1100) ? '#2ee6c8' : '#16302e'); // coin light
    // kick plate + feet with a floor gap
    px(x + 1, y + bh - 3, cw - 2, 1, r.ao);
    underAO(x + 2, y + bh - 2, cw - 4, 1);
    px(x + 1, y + bh - 2, 2, 2, r.dk); px(x + cw - 3, y + bh - 2, 2, 2, r.dk); // feet
    px(x + 1, y + bh - 2, 1, 1, r.lit); px(x + cw - 3, y + bh - 2, 1, 1, r.lit);
    wear(x + 1, y + bh - 7, cw - 2, 4, 3, U.shade(r.face, -0.12));
  };

  F.jukebox = (x, y, w, h, f) => {   // TALL 3/4 jukebox: rounded dome, bubble chase, spinning record
    // OBJECT=CAPABILITY TRUTH: a placed jukebox GRANTS the Spotify tools, but they are INERT until the user
    // connects Spotify in Settings. So the sprite runs DEAD when unconnected — the machine is unplugged: no
    // bubble chase, no spinning disc, no lamps, no floor glow, everything dimmed to a cold grey — and only
    // comes alive (bubbles rise, disc spins, lamps blink, gold floor glow) when f.live (=Spotify connected).
    const live = !!(f && f.live);
    const cw = 13, bh = h, r = RAMP.steel;
    const dim = c => live ? c : U.shade(c, -0.42);   // cold-shift every accent when unplugged
    shadow2(x + 1, y + bh - 1, cw - 2);
    // body slab
    rr(x - 1, y - 5, cw + 2, bh + 4, LINE);
    px(x + 1, y - 4, cw - 2, bh + 2, dim(r.face));
    px(x + 1, y - 4, 1, bh + 1, dim(U.shade(r.face, 0.10))); px(x + cw - 2, y - 4, 1, bh + 1, U.shade(r.dk, live ? 0 : -0.2));
    // rounded DOME top
    px(x + 3, y - 8, cw - 6, 1, LINE);
    px(x + 1, y - 7, cw - 2, 1, LINE);
    px(x, y - 6, cw, 2, LINE);
    px(x + 4, y - 8, cw - 8, 1, dim(U.shade(r.sheen, 0.15)));   // dome crown catch
    px(x + 2, y - 7, cw - 4, 1, dim(r.sheen));
    px(x + 1, y - 6, cw - 2, 1, dim(r.lit));
    // arch lamp under the dome — lit + breathing only when connected; a cold dead filament otherwise
    if (live) {
      px(x + 2, y - 4, cw - 4, 3, blink(500) ? '#ffd34a' : '#b88a3a');
      px(x + 3, y - 4, cw - 6, 1, '#ffe88c');
      glow(x + 2, y - 4, cw - 4, 3, '#ffd34a', 0.3 + 0.2 * Math.sin(now / 400));
    } else {
      px(x + 2, y - 4, cw - 4, 3, '#3a3226');                   // unlit arch (dead filament)
      px(x + 3, y - 4, cw - 6, 1, '#4a4030');
    }
    // bubble tubes climbing both flanks — bubbles only rise when live; static cold fluid when dead
    for (let i = 0; i < 2; i++) {
      const bx = i ? x + cw - 3 : x + 2;
      px(bx, y + 1, 1, 9, '#2c3a42');
      if (live) { const bp = (now / (900 + i * 300)) % 1; px(bx, y + 1 + Math.floor((1 - bp) * 8), 1, 1, '#7fd0ff'); }
    }
    // record window + disc — spins only when live; parked (no glint) when dead
    inset(x + 3, y + 1, cw - 6, 6, '#10161c');
    px(x + 4, y + 2, cw - 8, 4, '#26262e');                     // platter
    px(x + 4, y + 2, cw - 8, 1, '#3a3a44');                     // groove ring catch
    px(x + 5, y + 3, cw - 10, 2, '#15151a');                    // vinyl
    px(x + 6, y + 3, 1, 1, live ? ACC.lounge : U.shade(ACC.lounge, -0.4)); // label dot
    if (live) { const a = now / 300; px(x + 6 + Math.round(Math.cos(a) * 1.5), y + 3 + Math.round(Math.sin(a)), 1, 1, '#bfe6ff'); } // disc glint
    px(x + 2, y - 1, 1, 2, dim(r.sheen)); px(x + cw - 3, y - 1, 1, 2, dim(r.sheen)); // chrome shoulder trims
    // selection buttons — blink when live, dark when dead
    px(x + 3, y + 9, cw - 6, 2, '#1c242a');
    for (let i = 0; i < 3; i++) px(x + 4 + i * 2, y + 9, 1, 1, (live && blink(600, i)) ? '#ffd34a' : '#3a3020');
    // speaker grille skirt
    for (let i = 0; i < 3; i++) {
      px(x + 2, y + 12 + i * 2, cw - 4, 1, r.ao);
      px(x + 2, y + 13 + i * 2, cw - 4, 1, dim(U.shade(r.face, 0.10)));
    }
    // base lamps — power indicators: green+red alternating only when connected, both dark otherwise
    px(x + 2, y + bh - 5, 2, 2, (live && blink(400)) ? '#ff5c5c' : '#5c1c1c');
    px(x + cw - 4, y + bh - 5, 2, 2, (live && blink(400, 1)) ? '#41ff8a' : '#1c5c2c');
    px(x + 1, y + bh - 3, cw - 2, 1, r.ao);
    underAO(x + 2, y + bh - 2, cw - 4, 1);
    px(x + 1, y + bh - 2, 2, 2, r.dk); px(x + cw - 3, y + bh - 2, 2, 2, r.dk);
    px(x + 1, y + bh - 2, 1, 1, dim(r.lit)); px(x + cw - 3, y + bh - 2, 1, 1, dim(r.lit));
    if (live) glow(x + 1, y + bh - 2, cw - 2, 2, '#ffd34a', 0.10 + 0.05 * Math.sin(now / 400)); // floor glow — only when plugged in
  };

  F.bunk = (x, y, w, h) => {   // TOP-BIAS OBLIQUE berth: Zelda bed — pillow + blanket seen from above
    const r = RAMP.fabric;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 5]) {                      // footboard legs
      px(lx, y + 21, 3, 3, LINE); px(lx, y + 21, 1, 3, r.lit); px(lx + 1, y + 21, 1, 3, r.dk);
    }
    underAO(x + 5, y + 21, w - 10, 2);
    // footboard face (south)
    rr(x - 1, y + 15, w + 2, 6, LINE);
    px(x, y + 16, w, 4, r.face);
    px(x, y + 16, w, 1, r.lit);
    px(x + 2, y + 18, 2, 1, '#caa84a');                         // name tag
    px(x, y + 19, w, 1, r.ao);
    // headboard cap (north) rising above the mattress
    rr(x, y - 6, w, 5, LINE);
    px(x + 1, y - 5, w - 2, 2, r.sheen);
    px(x + 1, y - 5, 6, 1, U.shade(r.sheen, 0.12));
    px(x + 1, y - 3, w - 2, 1, r.lit);
    // mattress top (dominant)
    rr(x - 1, y - 2, w + 2, 18, LINE);
    px(x, y - 1, w, 16, '#cfc8b8');                             // sheet
    px(x, y - 1, 1, 16, U.shade('#cfc8b8', 0.08)); px(x + w - 1, y - 1, 1, 16, U.shade('#cfc8b8', -0.18));
    // pillow
    rr(x + 5, y, 14, 5, '#e2dccc');
    px(x + 6, y, 12, 1, '#f0ecdc');
    px(x + 7, y + 2, 9, 1, '#c8c0ac');                          // crease
    px(x + 5, y + 4, 14, 1, '#b8b09c');                         // pillow under-shade
    // blanket from mid-bed to the foot, turned-down fold at the top
    px(x, y + 6, w, 9, '#2f5a62');
    px(x, y + 6, w, 2, '#3e6e74');                              // turned-down fold
    px(x, y + 6, w, 1, '#4d7f84');                              // fold catch
    px(x, y + 8, 1, 7, '#3a686e'); px(x + w - 1, y + 8, 1, 7, '#234449'); // side tucks
    px(x + 3, y + 10, w - 6, 1, '#274c53'); px(x + 5, y + 13, w - 10, 1, '#234449'); // folds
    px(x, y + 14, w, 1, '#1d3c41');                             // blanket hem shade
    wear(x + 2, y + 7, w - 4, 7, 4, '#2a525a');
    // reading lamp on the headboard corner + warm pool on the pillow
    px(x + 3, y - 5, 2, 2, '#1c242a'); px(x + 3, y - 5, 2, 1, '#39454e');
    px(x + 4, y - 4, 1, 1, '#ffd34a');                          // lit bulb
    glow(x + 3, y - 5, 3, 3, '#ffd34a', 0.25);
    glow(x + 4, y - 1, 8, 4, '#ffd34a', 0.12 + 0.05 * Math.sin(now / 1300));
  };

  F.rug = (x, y, w, h) => {   // v2: floor-flat lounge rug — rounded corners, woven field, medallion, worn patches
    const edge = '#1b2126', band = '#28313a', field = '#2f3a43', motif = '#48565f', acc = '#2f6a62';
    // rounded slab: union of two rects + corner steps (it IS the floor — no shadow)
    px(x + 2, y, w - 4, h, edge); px(x, y + 2, w, h - 4, edge);
    px(x + 1, y + 1, 1, 1, edge); px(x + w - 2, y + 1, 1, 1, edge);
    px(x + 1, y + h - 2, 1, 1, edge); px(x + w - 2, y + h - 2, 1, 1, edge);
    rr(x + 1, y + 1, w - 2, h - 2, band);
    px(x + 2, y + 1, w - 4, 1, U.shade(band, 0.10));            // north edge catches light
    px(x + 1, y + 2, 1, h - 4, U.shade(band, 0.05));            // west lit
    px(x + w - 2, y + 2, 1, h - 4, U.shade(band, -0.10));       // east shade
    px(x + 2, y + h - 2, w - 4, 1, U.shade(band, -0.16));       // south shade
    // border dashes in the lounge accent
    for (let i = 0; i < (w - 16) / 6; i++) { px(x + 8 + i * 6, y + 2, 3, 1, acc); px(x + 8 + i * 6, y + h - 3, 3, 1, acc); }
    for (let j = 0; j < (h - 16) / 6; j++) { px(x + 2, y + 8 + j * 6, 1, 3, acc); px(x + w - 3, y + 8 + j * 6, 1, 3, acc); }
    // inner field + herringbone weave
    rr(x + 4, y + 4, w - 8, h - 8, field);
    for (let j = 0; j < h - 12; j += 2)
      for (let i = ((j >> 1) & 1) * 2; i < w - 12; i += 4)
        px(x + 6 + i, y + 6 + j, 2, 1, ((i + j) & 4) ? '#37434c' : '#2b353e');
    // bold diamond medallion with a teal core
    const cx = x + w / 2, cy = y + h / 2;
    for (let d = 0; d < 5; d++) {
      px(cx - 8 + d * 2, cy - d, 2, 1, motif); px(cx + 6 - d * 2, cy - d, 2, 1, motif);
      px(cx - 8 + d * 2, cy + d, 2, 1, motif); px(cx + 6 - d * 2, cy + d, 2, 1, motif);
    }
    px(cx - 4, cy - 1, 8, 3, '#39454e'); px(cx - 2, cy - 2, 4, 5, '#39454e');
    px(cx - 2, cy - 1, 4, 3, acc); px(cx - 1, cy - 1, 2, 1, '#4a8a82');
    px(cx - 12, cy, 2, 1, motif); px(cx + 10, cy, 2, 1, motif); // side dots
    px(cx - 1, cy - 7, 2, 1, motif); px(cx - 1, cy + 6, 2, 1, motif);
    // worn patches: sun-faded + threadbare speckle
    ctx.globalAlpha = 0.15; px(x + 9, y + 7, 8, 4, '#8a98a8'); px(x + w - 16, y + h - 12, 7, 4, '#8a98a8'); ctx.globalAlpha = 1;
    wear(x + 5, y + 5, w - 10, h - 10, 10, '#232c33');
    // frayed edge ticks west/east
    for (let j = 4; j < h - 4; j += 6) { px(x - 1, y + j, 1, 3, edge); px(x + w, y + j, 1, 3, edge); }
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
    } else {   // v2 task chair — pairs with the F.desk workstation (steel frame, rounded, star base)
      const r = RAMP.steel;
      shadow2(x + 3, y + 10, 7);                                 // floor contact
      // star base: arm bar + caster dots (south caster visible in front)
      px(x + 2, y + 10, 8, 1, '#10161a');
      px(x + 3, y + 10, 6, 1, '#2a343c');
      px(x + 2, y + 9, 1, 1, '#242e35'); px(x + 9, y + 9, 1, 1, '#242e35'); // NW/NE arm tips
      px(x + 2, y + 11, 2, 1, '#1a1e22'); px(x + 8, y + 11, 2, 1, '#1a1e22'); // casters
      px(x + 5, y + 11, 2, 1, '#1a1e22');
      // gas-lift column (seat overlaps its top)
      px(x + 4, y + 7, 4, 3, LINE);
      px(x + 5, y + 7, 1, 3, '#46535c'); px(x + 6, y + 7, 1, 3, '#39434b');
      // rounded backrest, north side (kept orientation — agent renders over the seat)
      rr(x + 2, y - 2, 8, 5, LINE);
      px(x + 3, y - 1, 6, 3, r.face);
      px(x + 3, y - 1, 6, 1, r.lit);                             // cap catches the light
      px(x + 3, y - 1, 3, 1, U.shade(r.lit, 0.10));
      px(x + 3, y, 1, 2, U.shade(r.face, 0.08)); px(x + 8, y, 1, 2, r.dk);
      px(x + 4, y + 1, 4, 1, U.shade(r.face, -0.18));            // lumbar seam (kept)
      // BIG rounded seat pad, middle-south (stays visible under a seated agent)
      px(x + 3, y + 3, 6, 1, LINE);
      px(x + 2, y + 4, 8, 5, LINE);
      px(x + 3, y + 4, 6, 1, '#4a8a82');                         // pad top, brightest
      px(x + 3, y + 4, 2, 1, '#5aa89c');                         // west sheen
      px(x + 3, y + 5, 6, 2, '#2f6a62');
      px(x + 3, y + 5, 1, 2, '#4a8a82'); px(x + 8, y + 5, 1, 2, '#26554e');
      px(x + 4, y + 6, 1, 1, '#26554e'); px(x + 7, y + 6, 1, 1, '#26554e'); // seat stitches (kept)
      px(x + 3, y + 7, 6, 1, r.face);                            // front lip
      px(x + 3, y + 7, 2, 1, r.lit);
      px(x + 4, y + 8, 4, 1, r.dk);                              // rounded skirt
    }
  };

  /* ============ DETAIL-PASS PROPS (auto-generated) ============ */
  F.bridge_tacscreen = (x, y, w, h, f) => {   // v2 freestanding: tactical display riding rolling posts
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, w - 4);
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx - 1, y + 5, 4, h - 7, LINE);
      px(pxx, y + 6, 1, h - 8, r.lit); px(pxx + 1, y + 6, 1, h - 8, r.dk);
      rr(pxx - 3, y + h - 3, 8, 2, LINE);
      px(pxx - 2, y + h - 3, 6, 1, r.face);
      px(pxx - 2, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 2, y + h - 1, 2, 1, '#1a1e22');
      ctx.globalAlpha = 0.30; px(pxx - 3, y + h, 8, 1, '#000'); ctx.globalAlpha = 1;
    }
    rr(x, y - 5, w, 12, LINE);
    px(x + 1, y - 4, w - 2, 10, r.face);
    px(x + 1, y - 4, w - 2, 1, r.lit);
    px(x + 2, y - 4, 1, 1, '#56645c'); px(x + w - 3, y - 4, 1, 1, '#56645c');
    px(x + 1, y + 5, w - 2, 1, r.ao);
    // recessed near-black screen well
    const sx = x + 2, sy = y - 3, sw = w - 4, sh2 = 8;
    inset(sx, sy, sw, sh2, '#080a0c');
    px(sx, sy, sw, 1, '#040506');
    const on = f && f.work;
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now / 1000)); // wireframe pulse (kept)
    const lineA = (on ? 0.85 : 0.45) * pulse;
    const red = '#ff4a3d';
    // station deck-plan wireframe (kept 1:1)
    ctx.save();
    ctx.globalAlpha = lineA;
    ctx.strokeStyle = red;
    ctx.beginPath();
    ctx.rect(sx + 1.5, sy + 1.5, sw - 4, sh2 - 5);              // outer hull
    ctx.rect(sx + 3.5, sy + 3.5, Math.max(2, (sw - 8) / 2 - 1), Math.max(2, sh2 - 9)); // left deck
    ctx.moveTo(sx + sw / 2, sy + 2);                            // central spine
    ctx.lineTo(sx + sw / 2, sy + sh2 - 4);
    ctx.moveTo(sx + 2, sy + sh2 / 2);                           // cross corridor
    ctx.lineTo(sx + sw - 3, sy + sh2 / 2);
    ctx.stroke();
    ctx.restore();
    // three tiny scrolling tactical readout bars (kept 1:1)
    for (let r2 = 0; r2 < 3; r2++) {
      const by = sy + sh2 - 4 + r2;
      if (by > sy + sh2 - 2) break;
      const scroll = Math.floor(now / (90 + r2 * 40)) % sw;
      const bw = 2 + (U.hash('tac' + r2) % 4);
      const bx = sx + ((scroll + r2 * 5) % (sw - bw - 1));
      glow(bx, by, bw, 1, red, (on ? 0.7 : 0.35) * pulse);
    }
    // slow-blinking status dot, lower-right (kept)
    const dotOn = blink(1400);
    px(sx + sw - 3, sy + sh2 - 3, 2, 2, dotOn ? red : '#3a1714');
    if (dotOn) glow(sx + sw - 4, sy + sh2 - 4, 4, 4, red, on ? 0.5 : 0.3);
    glow(sx, sy, sw, sh2, red, (on ? 0.10 : 0.05) * pulse);     // emissive spill (kept)
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
  F.bridge_dispatch_pylon = (x, y, w, h, f) => {   // v2 TALL 3/4 pylon: rounded column, dish crown, red dispatch slot
    const r = RAMP.steel;
    const active = f && f.work;
    const cx = x + w / 2;
    shadow2(x + 1, y + h - 1, w - 2);
    // splayed base shoe on the floor
    rr(x - 1, y + h - 4, w + 2, 4, LINE);
    px(x, y + h - 3, w, 2, r.face);
    px(x, y + h - 3, w, 1, r.lit);
    px(x, y + h - 1, w, 1, r.ao);
    // rounded full-height column
    rr(x, y - 2, w, h - 2, LINE);
    px(x + 1, y - 1, w - 2, h - 4, r.face);
    px(x + 1, y - 1, 1, h - 4, U.shade(r.face, 0.10));          // west lit
    px(x + w - 2, y - 1, 1, h - 4, r.dk);                       // east dark
    px(x + 1, y - 1, 2, 2, r.lit);                              // top-west chamfer glint
    // cap: visible top surface (3/4)
    rr(x + 1, y - 4, w - 2, 3, LINE);
    px(x + 2, y - 3, w - 4, 2, r.top);
    px(x + 2, y - 3, w - 4, 1, r.sheen);
    // rotating cap dish with sweeping scan-beam (kept 1:1)
    px(cx - 2, y - 6, 5, 2, '#454b52');
    px(cx - 1, y - 7, 3, 1, U.shade('#5a626a', 0.08));
    px(cx, y - 6, 1, 2, '#2a2e33');
    const sweep = Math.sin(now / 1300);
    const bx2 = Math.floor(cx) + Math.round(sweep * 3);
    px(bx2, y - 8, 1, 1, active ? '#ff8a78' : '#ff4a3d');
    glow(bx2 - 1, y - 9, 3, 2, '#ff4a3d', active ? 0.5 : 0.28);
    glow(Math.floor(cx), y - 8, (bx2 - Math.floor(cx)) || 1, 1, '#ff4a3d', 0.18); // beam trace
    // two beveled bands (kept)
    for (const by of [y + 1, y + h - 9]) {
      px(x, by, w, 3, '#5a626a');
      px(x, by, w, 1, U.shade('#5a626a', 0.16));
      px(x, by + 2, w, 1, U.shade('#5a626a', -0.22));
      px(x + 1, by + 1, 1, 1, U.shade('#5a626a', -0.30));       // rivets
      px(x + w - 2, by + 1, 1, 1, U.shade('#5a626a', -0.30));
    }
    // central vertical dispatch light-slot (kept 1:1)
    const slotX = Math.floor(cx) - 1, slotY = y + 5, slotH = h - 16;
    inset(slotX - 1, slotY - 1, 4, slotH + 2, '#201210');
    const pulse = active ? 0.55 + 0.45 * Math.abs(Math.sin(now / 480)) : 0.18 + 0.06 * Math.sin(now / 1400);
    px(slotX, slotY, 2, slotH, U.shade('#ff4a3d', active ? -0.04 : -0.28));
    glow(slotX - 1, slotY - 1, 4, slotH + 2, '#ff4a3d', pulse);
    if (active && blink(480)) {                                 // hot core when sending (kept)
      px(slotX, slotY, 2, slotH, '#ff8a78');
      glow(slotX - 3, slotY + slotH / 2 - 2, 8, 4, '#ff4a3d', 0.3);
    }
  };
  F.bridge_orderqueue = (x, y, w, h, f) => {   // v2 low oblique projector unit: visible top tray, holo cards float above
    const r = RAMP.steel;
    const cx = x + Math.floor(w / 2);
    shadow2(x + 1, y + h - 1, w - 2);
    // feet under the cabinet
    px(x + 2, y + h - 2, 2, 2, r.dk); px(x + w - 4, y + h - 2, 2, 2, r.dk);
    px(x + 2, y + h - 2, 1, 1, r.lit); px(x + w - 4, y + h - 2, 1, 1, r.lit);
    underAO(x + 4, y + h - 2, w - 8, 1);
    // short front face with vents
    rr(x - 1, y + 5, w + 2, 6, LINE);
    px(x, y + 6, w, 4, r.face);
    px(x, y + 6, w, 1, r.lit);
    for (let i = 0; i < (w - 8) / 6; i++) px(x + 4 + i * 6, y + 7, 1, 2, r.ao); // vents (kept)
    px(x, y + 9, w, 1, r.ao);
    px(x + 2, y + 7, 1, 1, (f && f.work ? blink(420) : blink(1600)) ? '#ff6a5a' : '#3a1c1a'); // status LED (kept)
    // top surface with the recessed projector tray
    rr(x - 1, y, w + 2, 6, LINE);
    px(x, y + 1, w, 4, r.top);
    px(x + 1, y + 1, w - 2, 1, r.sheen);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk);
    inset(x + 4, y + 1, w - 8, 3, '#23272b');
    px(x + 5, y + 2, w - 10, 1, '#3c424a');
    glow(x + 5, y + 1, w - 10, 3, '#ff4a3d', 0.10 + 0.06 * Math.abs(flick(1300))); // emitter glow (kept)
    px(cx - 3, y + 2, 6, 1, '#ff6a5a');                         // emitter slit (kept)
    // faint red projector cone rising from the tray (kept)
    const coneTop = y - 13;
    ctx.save();
    ctx.globalAlpha = 0.10 + 0.05 * Math.abs(flick(1300));
    ctx.fillStyle = '#ff4a3d';
    ctx.beginPath();
    ctx.moveTo(cx, y + 2);
    ctx.lineTo(x + 3, coneTop);
    ctx.lineTo(x + w - 3, coneTop);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // floating stack of three translucent order-cards (kept 1:1)
    const PERIOD = 2600;
    const phase = (now % PERIOD) / PERIOD;
    const rise = Math.floor(phase * 3);
    const cardW = w - 8, cardX = x + 4;
    const bob = Math.round(Math.sin(now / 800));
    for (let c = 0; c < 3; c++) {
      const cy = coneTop + 1 + (2 - c) * 5 + bob - (c === 2 ? rise : 0);
      let a2 = 0.85 - c * 0.12;
      if (c === 2) a2 *= (1 - phase * 0.7);
      if (cy < y - 18) continue;
      ctx.save();
      ctx.globalAlpha = a2;
      px(cardX, cy, cardW, 4, '#ff4a3d');
      px(cardX, cy, cardW, 1, '#ff7a6c');                       // bright top edge
      px(cardX, cy + 3, cardW, 1, '#c2241a');                   // darker base edge
      const scroll = Math.floor(now / 110);
      for (let g = 0; g < cardW - 2; g += 2) {
        if (((g + scroll + c * 3) >> 1) % 3 !== 0) px(cardX + 1 + g, cy + 1, 1, 1, '#ffd9d2');
      }
      ctx.restore();
    }
    // fresh card glinting up from the emitter slit (kept)
    if (phase > 0.6) {
      const fy2 = y + 1 - Math.floor((phase - 0.6) * 8);
      glow(cx - 3, fy2, 6, 2, '#ff7a6c', 0.5 * (phase - 0.6) / 0.4);
    }
  };
  F.research_corelens = (x, y, w, h, f) => { // TALL 3/4 lens column (kept: arcs, sweep, LEDs, floor bleed)
    const r = RAMP.steel;
    shadow2(x, y + h - 1, w);
    glow(x - 1, y + h - 4, w + 2, 5, '#4ad9ff', ((f && f.work) ? 0.22 : 0.12) + 0.05 * Math.sin(now / 600));
    // flared base foot
    rr(x - 1, y + h - 4, w + 2, 4, LINE);
    px(x, y + h - 3, w, 2, r.face); px(x, y + h - 3, w, 1, r.lit);
    px(x, y + h - 1, w, 1, r.ao);
    // full-height cylindrical column
    rr(x, y - 6, w, h + 2, LINE);
    px(x + 1, y - 5, w - 2, h, r.face);
    px(x + 1, y - 5, 2, h, r.lit);                             // west curve light
    px(x + w - 3, y - 5, 2, h, r.dk);                          // east curve shade
    // domed cap
    rr(x, y - 8, w, 3, LINE);
    px(x + 1, y - 7, w - 2, 1, r.sheen);
    px(x + 1, y - 6, w - 2, 1, r.top);
    // recessed lens housing
    const lensTop = y - 4, lensH = 14;
    inset(x + 1, lensTop, w - 2, lensH, '#10161a');
    const lcx = x + w / 2, lcy = lensTop + lensH / 2, R = (w - 5) / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(x + 2, lensTop + 1, w - 4, lensH - 2); ctx.clip();
    for (let cr = R; cr >= 1.2; cr -= 1.2) {                   // concentric cyan arcs (kept)
      const t = cr / R;
      ctx.beginPath();
      ctx.strokeStyle = U.shade('#4ad9ff', (-18 + t * 4 * (1 - t) * 60 - 30) / 100);
      ctx.globalAlpha = 0.35 + 0.4 * (1 - t);
      ctx.arc(lcx, lcy, cr, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.fillStyle = '#1f6b80'; ctx.arc(lcx, lcy, Math.max(1.5, R * 0.4), 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = '#0e3540'; ctx.arc(lcx, lcy, 1, 0, Math.PI * 2); ctx.fill();
    const sweep = (now % 2000) / 2000;                         // scan sweep (kept)
    const sy2 = lensTop + 1 + sweep * (lensH - 2);
    glow(x + 2, sy2 - 3, w - 4, 4, '#4ad9ff', 0.22);
    px(x + 2, Math.round(sy2), w - 4, 1, '#bff0ff');
    glow(x + 2, sy2, w - 4, 2, '#4ad9ff', 0.45);
    ctx.restore();
    px(Math.round(lcx) - 1, Math.round(lcy) - 1, 1, 1, '#cdeeff'); // pupil spec (kept)
    // collar + alternating amber LEDs (kept 520)
    px(x + 1, y + 11, w - 2, 2, '#2f3a34'); px(x + 1, y + 11, w - 2, 1, '#4a564e');
    px(x + 2, y + 14, 2, 2, blink(520, 0) ? '#ffb347' : '#5a3f1a');
    px(x + w - 4, y + 14, 2, 2, blink(520, 1) ? '#ffb347' : '#5a3f1a');
    if (blink(520, 0)) glow(x + 1, y + 13, 4, 4, '#ffb347', 0.3);
    if (blink(520, 1)) glow(x + w - 5, y + 13, 4, 4, '#ffb347', 0.3);
    px(x + 2, y + 17, w - 4, 1, r.dk);                         // lower column seam (kept)
    px(x + 2, y + 18, w - 4, 1, U.shade(r.face, 0.14));
  };
  F.research_trendpillar = (x, y, w, h, f) => { // TALL 3/4 data totem (kept: charts, ticker, scan, LED)
    const r = RAMP.steel;
    shadow2(x, y + h - 1, w);
    // pedestal foot
    rr(x - 1, y + h - 6, w + 2, 6, LINE);
    px(x, y + h - 5, w, 4, r.face); px(x, y + h - 5, w, 1, r.lit);
    px(x, y + h - 2, w, 1, r.ao);
    inset(x + 2, y + h - 4, w - 4, 2, '#10161a');              // vent
    px(x + 3, y + h - 4, 1, 1, blink(2200) ? '#41ff8a' : '#1c2a22'); // status LED (kept)
    // slab body, full height, rounded cap
    rr(x - 1, y - 7, w + 2, 3, LINE);
    px(x, y - 6, w, 1, r.sheen);
    rr(x - 1, y - 5, w + 2, h + 3, LINE);
    px(x, y - 4, w, h + 1, r.face);
    px(x, y - 4, 1, h + 1, r.lit); px(x + w - 1, y - 4, 1, h + 1, r.dk);
    // vertical strip display
    const scX = x + 1, scW = w - 2, scY = y - 3, scH = h - 11;
    const on = f.work;
    glow(scX - 1, scY - 1, scW + 2, scH + 2, '#4ad9ff', on ? 0.20 : 0.10); // bezel halo (kept)
    inset(scX, scY, scW, scH, '#0a1416');
    ctx.save();
    ctx.beginPath(); ctx.rect(scX + 1, scY + 1, scW - 2, scH - 2); ctx.clip();
    const gX = scX + 1, gW = scW - 2, gTop = scY + 2, gH = scH - 4;
    const dim = on ? 1 : 0.45;
    const t = Math.floor(now / 110);                           // scrolling charts (kept)
    for (let i = 0; i < gW; i++) {
      const s = U.hash('trend' + ((i + t) % 64));
      const climb = (i / gW) * (gH - 4), jit = (s % 5);
      const cy = gTop + gH - 2 - climb - jit + 2;
      ctx.globalAlpha = dim;
      px(gX + i, cy, 1, 1, '#4ad9ff');
      if (i > 0) px(gX + i, cy, 1, 2, U.shade('#4ad9ff', -0.25));
      ctx.globalAlpha = 1;
      const pclimb = (i / gW) * (gH - 8);
      const pjit = (U.hash('curie' + ((i + t) % 64)) % 3);
      const py = gTop + gH - 1 - pclimb * 0.6 - pjit;
      ctx.globalAlpha = dim * 0.85;
      px(gX + i, py, 1, 1, '#8f7bff');
      ctx.globalAlpha = 1;
    }
    const tick = Math.floor(now / 240) % 9;                    // crawling ticker (kept)
    for (let rw = 0; rw < gH; rw += 3) {
      const yy = gTop + ((rw + tick) % gH);
      const v = U.hash('pct' + rw + (Math.floor(now / 700) % 7)) % 99;
      ctx.globalAlpha = dim * 0.5;
      px(gX + 1, yy, 1, 1, v % 2 ? '#41ff8a' : '#ff6a6a');
      px(gX + 3 + (v % 3), yy, 1, 1, '#3a5c50');
      px(gX + gW - 3 - (v % 2), yy, 1, 1, '#3a5c50');
      ctx.globalAlpha = 1;
    }
    const scanY = gTop + Math.floor((Math.sin(now / 600) * 0.5 + 0.5) * (gH - 1)); // drifting scan (kept)
    glow(gX, scanY, gW, 1, '#9af0ff', on ? 0.22 : 0.10);
    ctx.restore();
    px(scX, scY, scW, 1, U.shade('#2a332f', 0.18));            // bezel highlights (kept)
    px(scX, scY, 1, scH, U.shade('#2a332f', 0.10));
    px(scX + scW - 1, scY, 1, scH, '#1a221e');
  };
  F.research_samplecart = (x, y, w, h, f) => { // wheeled sample cart — freestanding oblique
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    // caster wheels (kept idea, now proud of the frame)
    for (const wx of [x + 3, x + w - 6]) {
      px(wx - 1, y + h - 3, 4, 3, LINE);
      px(wx, y + h - 3, 2, 2, '#15191a'); px(wx, y + h - 3, 2, 1, '#2c3438');
    }
    // open mid shelf: void + posts + drive caddy (kept green read LED)
    px(x + 2, y + 5, w - 4, 4, '#0d1318');
    px(x + 1, y + 4, 2, 5, LINE); px(x + w - 3, y + 4, 2, 5, LINE);
    px(x + 1, y + 4, 1, 5, r.lit); px(x + w - 2, y + 4, 1, 5, r.dk);
    px(x + 2, y + 8, w - 4, 1, '#2c3630');                     // shelf plank
    px(x + 4, y + 5, 6, 3, '#5a665c'); px(x + 4, y + 5, 6, 1, '#6e7a70'); // caddy
    px(x + 5, y + 6, 4, 1, '#222a26');                         // drive slot
    px(x + 11, y + 6, 1, 1, blink(520) ? '#7dffb0' : '#1d3a2c');
    if (blink(520)) glow(x + 10, y + 5, 3, 2, '#7dffb0', 0.22);
    // big top tray dominates
    rr(x - 1, y - 2, w + 2, 8, LINE);
    rr(x, y - 1, w, 6, r.top);
    px(x + 1, y - 1, w - 2, 1, r.sheen);
    px(x, y, 1, 4, r.lit); px(x + w - 1, y, 1, 4, r.dk);
    px(x + 1, y + 4, w - 2, 1, U.shade(r.top, -0.16));
    // vial rack: three capped vials glowing cyan (kept stagger pulse)
    px(x + 3, y - 1, 11, 3, '#2c3630'); px(x + 3, y - 1, 11, 1, '#3c4840');
    for (let i = 0; i < 3; i++) {
      const vx = x + 4 + i * 4;
      px(vx, y - 5, 2, 1, '#7a8a86');                          // cap
      px(vx, y - 4, 2, 4, '#2a3a40');                          // glass
      const lit = 0.55 + 0.35 * Math.sin(now / 760 + i * 1.7);
      px(vx, y - 3, 2, 2, U.shade('#4ad9ff', -0.18));
      px(vx, y - 3, 1, 1, '#4ad9ff');
      glow(vx - 1, y - 4, 4, 4, '#4ad9ff', 0.10 + 0.10 * lit);
    }
    // folded printout on the tray (kept)
    px(x + 16, y, 5, 3, '#cfd2c8'); px(x + 16, y, 5, 1, '#e6e8df');
    px(x + 17, y + 1, 3, 1, '#9aa094'); px(x + 18, y + 2, 1, 1, '#8c9286');
    // push handle jutting east (+2px)
    px(x + w, y - 3, 2, 8, LINE); px(x + w, y - 2, 1, 6, r.lit);
    px(x + w - 1, y - 4, 3, 2, LINE); px(x + w, y - 4, 2, 1, '#5f6f7a'); // grip
  };
  F.research_papers = (x, y, w, h, f) => { // low printout stacks — flat floor deco, tiny rise
    const paper = '#e8e6dd', hi = U.shade(paper, 0.18), shd = U.shade(paper, -0.22);
    sh(x + 2, y + h - 2, w - 4);
    const fold = '#c9b27a';                                    // manila folder underneath (kept)
    px(x + 1, y + 3, 11, 8, U.shade(fold, -0.4));
    px(x + 1, y + 2, 11, 8, fold);
    px(x + 1, y + 2, 11, 1, U.shade(fold, 0.22));
    px(x + 8, y + 2, 4, 1, U.shade(fold, 0.3));                // raised tab
    // two low stacks: paper top + stacked side edge (oblique read)
    const stack = (sx, sy, sw, sh2) => {
      px(sx, sy + sh2, sw, 2, shd);                            // stacked sheet edges
      px(sx, sy + sh2 + 1, sw, 1, U.shade(paper, -0.34));
      px(sx, sy, sw, sh2, paper);
      px(sx, sy, sw, 1, hi); px(sx, sy, 1, sh2, hi);
      px(sx + sw - 1, sy + 1, 1, sh2 - 1, shd);
    };
    stack(x + 2, y + 1, 8, 6);
    stack(x + 13, y + 3, 8, 6);
    px(x + 3, y + 3, 5, 1, '#9aa0a0'); px(x + 3, y + 5, 4, 1, '#9aa0a0'); // text lines
    px(x + 14, y + 5, 5, 1, '#9aa0a0'); px(x + 14, y + 7, 4, 1, '#969c9c');
    // topmost readable sheet with chart (kept: curl, bars, pulsing tick)
    const tx = x + 7, ty = y + 2, tw = 9, th = 9;
    px(tx - 1, ty + 1, tw + 1, th, U.shade(paper, -0.32));
    px(tx, ty, tw, th, paper);
    px(tx, ty, tw, 1, hi); px(tx, ty, 1, th, hi);
    px(tx + tw - 1, ty + 1, 1, th - 1, shd); px(tx, ty + th - 1, tw, 1, shd);
    px(tx + tw - 3, ty - 1, 3, 1, U.shade(paper, -0.28));      // curl shadow
    px(tx + tw - 3, ty, 3, 2, hi); px(tx + tw - 1, ty, 1, 1, '#fffdf6'); // curled corner
    px(tx + 1, ty + 2, 6, 1, '#7e8484');
    const bars = [2, 4, 3, 5];
    for (let b = 0; b < bars.length; b++) {
      px(tx + 1 + b * 2, ty + 8 - bars[b], 1, bars[b], '#4ad9ff');
      px(tx + 1 + b * 2, ty + 8 - bars[b], 1, 1, '#bff0ff');
    }
    const k = Math.floor(now / 600) % bars.length;             // pulsing data tick (kept)
    glow(tx + 1 + k * 2, ty + 8 - bars[k], 1, 1, '#9aeaff', f.work ? 0.55 : 0.18 + 0.12 * Math.sin(now / 700));
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
  F.comms_inbox = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE holo intake tray: dominant top, short vented face
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 5]) {                     // stub corner feet
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short front face: channel pips + vent slits
    rr(x, y + 3, w, 7, LINE);
    px(x + 1, y + 4, w - 2, 4, r.face);
    px(x + 1, y + 4, w - 2, 1, r.lit);
    px(x + 1, y + 8, w - 2, 1, r.ao);
    const alert = blink(520, 1);                               // kept channel pips
    px(x + 2, y + 5, 2, 1, blink(900, 0) ? '#41ff8a' : '#173026');          // mail
    px(x + 5, y + 5, 2, 1, alert ? '#ffb23a' : '#3a2c12');                  // webhook (alert)
    px(x + 8, y + 5, 2, 1, blink(1300, 2) ? '#41ff8a' : '#173026');         // platform
    if (alert) glow(x + 4, y + 4, 4, 3, '#ff9d2e', 0.35);
    for (let i = 0; i < 3; i++) px(x + 13 + i * 3, y + 5, 1, 2, r.ao);      // vent slits
    // the big rounded top: dark glass tray recessed into it
    rr(x - 1, y - 4, w + 2, 9, LINE);
    rr(x, y - 3, w, 7, r.top);
    px(x + 1, y - 3, w - 2, 1, r.sheen);
    px(x, y - 2, 1, 5, r.lit); px(x + w - 1, y - 2, 1, 5, r.dk);
    px(x + 1, y + 3, w - 2, 1, U.shade(r.top, -0.16));         // top front lip
    inset(x + 3, y - 2, w - 6, 4, '#0a100d');                  // glass tray
    const pulse = 0.10 + 0.06 * Math.sin(now / 640);           // kept holo under-glow
    glow(x + 3, y - 2, w - 6, 4, '#5ad1b3', pulse);
    // floating holographic message stack (kept rise/fade cycle)
    const teal = '#5ad1b3', tealDim = '#2f7a68';
    const cardW = 8, cardX = x + 8;
    const t = (now % 2000) / 2000;
    for (let s = 0; s < 4; s++) {
      let cy = y - 3 - s * 3;
      let a = 0.85 - s * 0.18;
      if (s === 0) { cy -= Math.round(t * 4); a *= (1 - t); }
      else { cy -= Math.round(t * 3); }
      if (a <= 0.04) continue;
      ctx.save();
      ctx.globalAlpha = a;
      const col = s === 0 ? teal : tealDim;
      px(cardX, cy, cardW, 1, col);
      px(cardX, cy + 2, cardW, 1, col);
      px(cardX, cy, 1, 3, col);
      px(cardX + cardW - 1, cy, 1, 3, col);
      px(cardX + cardW / 2 - 1, cy + 1, 2, 1, U.shade(col, 0.30)); // flap hint
      ctx.restore();
    }
    // unread-count holo badge on the NE corner (kept tick)
    const cnt = (Math.floor(now / 2000) % 9) + 1;
    const bx = x + w - 6, by = y - 5;
    glow(bx - 1, by - 1, 5, 4, '#5ad1b3', 0.25);
    px(bx, by, 4, 3, '#0c1714');
    const segOn = (U.hash('' + cnt) % 2) === 0;
    px(bx + 1, by, 2, 1, teal);
    px(bx + 1, by + 1, segOn ? 2 : 1, 1, teal);
    px(bx + 1, by + 2, 2, 1, U.shade(teal, -0.10));
    // active-use lift (kept)
    if (f && f.work) {
      glow(x + 3, y - 4, w - 6, 7, '#5ad1b3', 0.14 + 0.05 * Math.sin(now / 300));
      px(cardX - 1, y - 3, 1, 1, '#bff5e6');
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
  F.etsy_threadrack = (x, y, w, h, f) => { // freestanding spool rack — round spool tops on an oblique tray
    const r = RAMP.gun;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 4]) {                     // stub legs
      px(lx - 1, y + 8, 4, 3, LINE);
      px(lx, y + 8, 1, 2, r.lit); px(lx + 1, y + 8, 1, 2, r.dk);
      px(lx, y + h - 2, 2, 1, r.ao);
    }
    underAO(x + 4, y + 8, w - 8, 2);
    // short face rail: spool end discs
    rr(x, y + 4, w, 5, LINE);
    px(x + 1, y + 5, w - 2, 3, r.face);
    px(x + 1, y + 5, w - 2, 1, r.lit);
    px(x + 1, y + 7, w - 2, 1, r.ao);
    for (let i = 0; i < 3; i++) {
      const fx = x + 4 + i * 6, c = i === 1 ? '#e8ddc8' : '#ffbf6a';
      rr(fx, y + 5, 3, 3, U.shade(c, -0.25));
      px(fx + 1, y + 5, 1, 1, U.shade(c, 0.1)); px(fx + 1, y + 6, 1, 1, '#141a1e'); // hub
    }
    px(x + w - 3, y + 6, 1, 1, (f && f.work) ? (blink(900) ? '#ffd34a' : '#28323a') : (blink(1800) ? '#ffd34a' : '#28323a')); // feed LED (kept)
    if ((f && f.work) ? blink(900) : blink(1800)) glow(x + w - 4, y + 5, 3, 2, '#ff9d2e', 0.22);
    // top tray with upright spools: bold round tops
    rr(x - 1, y - 3, w + 2, 8, LINE);
    rr(x, y - 2, w, 6, r.top);
    px(x + 1, y - 2, w - 2, 1, r.sheen);
    px(x, y - 1, 1, 4, r.lit); px(x + w - 1, y - 1, 1, 4, r.dk);
    px(x + 1, y + 3, w - 2, 1, U.shade(r.top, -0.16));
    const cols2 = ['#ff9d2e', '#ffbf6a', '#e8ddc8', '#ff9d2e'];
    for (let i = 0; i < 4; i++) {
      const sx2 = x + 2 + i * 5, c = cols2[(i + (U.hash('threadrack') % 2)) % cols2.length]; // kept hash seed
      px(sx2, y, 4, 1, U.shade(c, -0.35));                     // spool side under the disc
      rr(sx2, y - 4, 4, 4, c);                                 // wound top disc
      px(sx2 + 1, y - 4, 2, 1, U.shade(c, 0.3));               // lit rim
      px(sx2 + 1, y - 2, 2, 1, U.shade(c, -0.2));              // winding shade
      px(sx2 + 1, y - 3, 1, 1, '#141a1e');                     // hub hole
      if (i === 1 || i === 3) px(sx2 + 1, y + 1, 1, 4, U.shade(c, -0.06)); // dangling thread tails (kept)
    }
  };
  F.etsy_dyevat = (x, y, w, h, f) => { // round dye basin — oval rim, bolted machine
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 16, w, h - 16);
    deckSocket(x + w + 1, y + h - 3, f && f.work);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    // rounded drum body: the curved front band
    rr(x, y + 4, w, 13, LINE);
    px(x + 1, y + 5, w - 2, 11, r.face);
    px(x + 1, y + 5, 2, 11, r.lit); px(x + w - 3, y + 5, 2, 11, r.dk);
    px(x + 2, y + 15, w - 4, 1, r.ao);
    px(x + 1, y + 12, w - 2, 1, U.shade(r.face, -0.25));       // drum hoop
    px(x + 1, y + 13, w - 2, 1, U.shade(r.face, 0.10));
    px(x + 3, y + 14, 3, 2, '#1b2422');                        // control nub (kept)
    px(x + 4, y + 14, 1, 1, blink(900) ? '#41ff8a' : '#16302a');
    if (f && f.work) glow(x + 3, y + 13, 4, 3, '#41ff8a', 0.18);
    // oval rim + amber dye pool dominate the top
    const cx2 = x + w / 2, cy2 = y + 4;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2, 7.5, 0, 0, Math.PI * 2); ctx.fillStyle = LINE; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 1, 6.5, 0, 0, Math.PI * 2); ctx.fillStyle = r.top; ctx.fill();
    ctx.globalAlpha = 0.8; ctx.strokeStyle = r.sheen; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.5, w / 2 - 2.5, 5.5, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 3, 4.6, 0, 0, Math.PI * 2); ctx.fillStyle = '#241712'; ctx.fill();
    // concentric dye rings core->rim (kept hues)
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, w / 2 - 4, 3.8, 0, 0, Math.PI * 2); ctx.fillStyle = '#c9701a'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, w / 2 - 5.5, 3, 0, 0, Math.PI * 2); ctx.fillStyle = U.shade('#c9701a', 0.16); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, w / 2 - 7, 2.2, 0, 0, Math.PI * 2); ctx.fillStyle = '#ff9d2e'; ctx.fill();
    const rp = now / 1400;                                     // drifting ripples (kept)
    ctx.globalAlpha = 0.5; ctx.strokeStyle = U.shade('#ff9d2e', 0.3); ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const cr = (w / 2 - 6) * (0.35 + i * 0.22) + Math.sin(rp + i) * 0.6;
      ctx.beginPath();
      ctx.ellipse(cx2, cy2 + 0.4, cr, cr * 0.4, 0, Math.PI * (0.9 + i * 0.15), Math.PI * (1.7 + i * 0.15));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const bt = (now / 2600) % 1;                               // surfacing bubble (kept)
    if (bt < 0.6) {
      const by2 = cy2 - bt * 2;
      px(Math.round(cx2 - 3), Math.round(by2), 1, 1, U.shade('#ff9d2e', 0.4));
      if (bt > 0.4) px(Math.round(cx2 - 3), Math.round(by2), 1, 1, '#ffeccc');
    }
    ctx.restore();
    glow(x + 3, y - 1, w - 6, 9, '#ff9d2e', 0.1 + 0.05 * Math.sin(now / 800)); // pool glow (kept)
    // dip-arm over the east rim + half-submerged staining swatch (kept)
    px(x + w - 6, y - 4, 4, 2, '#5a665e'); px(x + w - 6, y - 4, 4, 1, U.shade('#5a665e', 0.22));
    px(x + w - 7, y - 2, 2, 3, '#4a544d'); px(x + w - 8, y + 1, 2, 2, '#4a544d');
    px(x + w - 12, y + 2, 5, 2, '#e8ece6'); px(x + w - 12, y + 2, 5, 1, '#ffffff');
    px(x + w - 12, y + 4, 5, 1, '#e0a45c'); px(x + w - 11, y + 5, 3, 1, '#c9701a');
  };
  F.etsy_kiln = (x, y, w, h, f) => { // wax kiln — domed top with hot crucible eye, bolted machine
    const r = RAMP.gun;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 16, w, h - 16);
    deckSocket(x + w + 1, y + h - 3, f && f.work);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    const breath = 0.5 + 0.5 * Math.sin(now / 1000);           // breathing heat (kept)
    // short front face: heat-leak vents + readout
    rr(x - 1, y + 10, w + 2, 7, LINE);
    px(x, y + 11, w, 5, r.face);
    px(x, y + 11, w, 1, r.lit);
    px(x, y + 15, w, 1, r.ao);
    for (let i = 0; i < 3; i++) {
      px(x + 3 + i * 3, y + 13, 2, 1, '#141a17');              // vent slits
      glow(x + 3 + i * 3, y + 13, 2, 1, '#ff7a1a', 0.15 + 0.2 * breath);
    }
    inset(x + w - 10, y + 12, 8, 3, '#191e1b');                // 3-seg readout (kept, breath-tied)
    for (let s = 0; s < 3; s++) px(x + w - 9 + s * 2, y + 13, 1, 1, breath > s / 3.2 ? '#ffd34a' : '#28323a');
    // big domed top
    rr(x - 1, y - 3, w + 2, 14, LINE);
    rr(x, y - 2, w, 12, r.top);
    px(x + 1, y - 2, w - 2, 1, r.sheen);
    px(x, y - 1, 1, 10, r.lit); px(x + w - 1, y - 1, 1, 10, r.dk);
    px(x + 1, y + 9, w - 2, 1, U.shade(r.top, -0.16));
    rr(x + 2, y, w - 4, 8, U.shade(r.top, 0.08));              // dome step
    px(x + 3, y, w - 6, 1, U.shade(r.top, 0.2));
    px(x + 2, y - 1, 1, 1, '#5e6c64'); px(x + w - 3, y - 1, 1, 1, '#5e6c64'); // dome bolts (kept)
    // round crucible eye: hot rings + spec (kept palette)
    const cx2 = x + w / 2, cy2 = y + 4, R2 = 5;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, R2 + 1.6, R2 * 0.8 + 1.4, 0, 0, Math.PI * 2); ctx.fillStyle = '#0d1210'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, R2, R2 * 0.8, 0, 0, Math.PI * 2); ctx.fillStyle = '#ff7a1a'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, R2 * 0.55, R2 * 0.45, 0, 0, Math.PI * 2); ctx.fillStyle = '#ffd34a'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx2 - 1, cy2 - 1, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#fff0b0'; ctx.fill();
    ctx.restore();
    const bloomA = ((f && f.work) ? 0.30 : 0.16) + 0.14 * breath; // breathing bloom (kept)
    glow(cx2 - R2 - 2, cy2 - R2, R2 * 2 + 4, R2 * 1.7 + 3, '#ff9d2e', bloomA);
    glow(cx2 - R2, cy2 - R2 * 0.8, R2 * 2, R2 * 1.6, '#ffd34a', 0.10 + 0.10 * breath);
    // vent stack on the west shoulder (kept shimmer)
    rr(x + 1, y - 6, 5, 5, LINE);
    px(x + 2, y - 5, 3, 3, '#262f2b'); px(x + 2, y - 5, 3, 1, '#3a463f');
    px(x + 3, y - 4, 1, 1, '#0e1311');
    if (blink(420)) px(x + 3, y - 8, 1, 1, '#6a7882');
    else if (blink(420, 0.5)) px(x + 2, y - 9, 1, 1, '#46525a');
  };
  F.etsy_packbot = (x, y, w, h, f) => { // packing robot station — bolted machine, arm over the case
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 15, w, h - 15);
    deckSocket(x + w + 1, y + h - 3, f && f.work);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    // short front face: vents + status LED (kept 420 blink + dim idle)
    rr(x - 1, y + 9, w + 2, 7, LINE);
    px(x, y + 10, w, 5, r.face);
    px(x, y + 10, w, 1, r.lit);
    px(x, y + 14, w, 1, r.ao);
    for (let i = 0; i < 4; i++) px(x + w - 11 + i * 2, y + 12, 1, 2, '#1e262c');
    if (f && f.work) {
      px(x + 3, y + 11, 2, 2, blink(420) ? '#ffb43a' : '#28323a');
      if (blink(420)) glow(x + 2, y + 10, 4, 4, '#ff9d2e', 0.25);
    } else {
      px(x + 3, y + 11, 2, 2, '#28323a'); px(x + 3, y + 11, 1, 1, '#36424c');
    }
    // big top work deck
    rr(x - 1, y - 2, w + 2, 13, LINE);
    rr(x, y - 1, w, 11, r.top);
    px(x + 1, y - 1, w - 2, 1, r.sheen);
    px(x, y, 1, 9, r.lit); px(x + w - 1, y, 1, 9, r.dk);
    px(x + 1, y + 9, w - 2, 1, U.shade(r.top, -0.16));
    for (let i = 0; i < 4; i++) px(x + 2, y + 1 + i * 2, 2, 1, U.shade(r.top, -0.3)); // feed rollers
    // shipping case on the deck (kept: flap seam, label + barcode)
    const bx = x + 6, by2 = y, bw = 12, bh = 8;
    rr(bx - 1, by2 - 1, bw + 2, bh + 2, LINE);
    px(bx, by2, bw, bh, '#36424c');
    px(bx, by2, bw, 1, U.shade('#36424c', 0.22));
    px(bx, by2 + bh - 1, bw, 1, U.shade('#36424c', -0.28));
    px(bx, by2, 1, bh, U.shade('#36424c', 0.10));
    px(bx + Math.floor(bw / 2), by2 + 1, 1, bh - 2, '#28323a'); // half-open flap seam
    px(bx + 1, by2 + 2, Math.floor(bw / 2) - 1, 1, '#46525a');  // sealed-side highlight
    px(bx + 1, by2 + 1, 5, 5, '#ff9d2e');                       // orange label
    px(bx + 1, by2 + 1, 5, 1, U.shade('#ff9d2e', 0.22));
    px(bx + 2, by2 + 4, 3, 1, '#1a2228'); px(bx + 2, by2 + 5, 3, 1, '#1a2228'); // barcode
    // arm: mast on the east deck + boom reaching over the case
    px(x + w - 5, y - 7, 3, 10, LINE);
    px(x + w - 4, y - 6, 1, 8, '#5a645c'); px(x + w - 3, y - 6, 1, 8, '#3a423c');
    px(x + w - 5, y - 8, 4, 2, LINE); px(x + w - 4, y - 8, 2, 1, '#6e7a70'); // shoulder cap
    px(x + 9, y - 6, 11, 3, LINE);
    px(x + 10, y - 5, 9, 1, '#6b766e');
    // scanner head hanging over the case (kept emitter)
    px(x + 9, y - 4, 4, 3, '#4a544d'); px(x + 9, y - 4, 4, 1, U.shade('#6b766e', 0.10));
    inset(x + 10, y - 3, 2, 1, '#11201c');
    if (f && f.work) {                                          // cyan scan sweep (kept)
      const sweep = bx + Math.floor(((now / 900) % 1) * bw);
      px(sweep, by2, 1, bh, '#cffcff');
      glow(sweep - 1, by2, 3, bh, '#5fe0ff', 0.30);
      glow(x + 9, y - 4, 4, 3, '#5fe0ff', 0.22);               // emitter spill
    }
  };
  F.gigs_thumbwall = (x, y, w, h, f) => {   // v2 freestanding: pinned gig-card panel on rolling posts
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, w - 4);
    // rolling posts on splayed T-feet with casters (whiteboard family)
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx - 1, y + 4, 4, h - 6, LINE);
      px(pxx, y + 5, 1, h - 7, r.lit); px(pxx + 1, y + 5, 1, h - 7, r.dk);
      rr(pxx - 3, y + h - 3, 8, 2, LINE);
      px(pxx - 2, y + h - 3, 6, 1, r.face);
      px(pxx - 2, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 2, y + h - 1, 2, 1, '#1a1e22'); // casters
      ctx.globalAlpha = 0.30; px(pxx - 3, y + h, 8, 1, '#000'); ctx.globalAlpha = 1;
    }
    // panel riding the posts: rounded steel frame + recessed pin-board well
    rr(x, y - 7, w, 13, LINE);
    rr(x + 1, y - 6, w - 2, 11, r.face);
    px(x + 1, y - 6, w - 2, 1, r.lit);
    px(x + 2, y - 6, 1, 1, '#56645c'); px(x + w - 3, y - 6, 1, 1, '#56645c'); // frame screws
    inset(x + 2, y - 5, w - 4, 9, '#1a1e21');
    // 3x2 grid of pinned thumbnail cards + micro star rows (kept)
    const tints = ['#41ff8a', '#7fd0ff', '#f0ece4'];
    const pulse = blink(1200) ? 1 : 0;
    for (let rj = 0; rj < 2; rj++) for (let c = 0; c < 3; c++) {
      const cx = x + 4 + c * 6, cy = y - 4 + rj * 4;
      const isNew = (c === 1 && rj === 1);                     // NEW ORDER slot
      px(cx + 4, cy, 1, 3, '#0c0f11');                         // card drop shadow
      if (isNew) {
        const base = pulse ? '#b44aff' : '#7a2fb0';
        px(cx, cy, 4, 3, base);
        px(cx, cy, 4, 1, pulse ? '#d79bff' : '#9a4ad0');
        if (pulse) glow(cx - 1, cy - 1, 6, 5, '#b44aff', 0.4);
      } else {
        const col = tints[U.hash('gig' + rj + '_' + c) % tints.length];
        px(cx, cy, 4, 3, col);
        px(cx, cy, 4, 1, U.shade(col, 0.30));
        px(cx, cy + 2, 4, 1, U.shade(col, -0.40));
      }
      for (let s = 0; s < 5; s++) px(cx - 1 + s, cy + 3, 1, 1, '#ffd23a'); // micro 5-star row
    }
    px(x + 2, y + 4, 1, 1, blink(700) ? '#c46bff' : '#3a2050'); // violet status LED (kept)
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
  F.gigs_amp = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE rounded amp cab: capsule crown, throbbing woven grille
    const r = RAMP.gun;
    const beat = blink(360);                                   // bass-throb pulse (kept)
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 4]) {                     // squat feet
      px(lx, y + 9, 2, 3, LINE); px(lx, y + 9, 1, 3, r.lit);
    }
    underAO(x + 4, y + 9, w - 8, 2);
    // capsule body outline
    rr(x, y - 4, w, 13, LINE);
    // dominant rounded top
    px(x + 2, y - 3, w - 4, 1, r.sheen);                       // crown sheen
    px(x + 1, y - 2, w - 2, 4, r.top);
    px(x + 1, y - 2, 1, 4, r.lit); px(x + w - 2, y - 2, 1, 4, r.dk);
    px(x + 1, y + 2, w - 2, 1, U.shade(r.top, -0.16));         // front lip
    // face = full-width silver-piped grille
    px(x + 1, y + 3, w - 2, 5, r.face);
    const gx = x + 2, gy = y + 4, gw = w - 4, gh = 3;
    px(gx - 1, gy - 1, gw + 2, gh + 2, '#9aa0a6');             // silver piping frame
    px(gx - 1, gy - 1, gw + 2, 1, '#c4cace');
    px(gx - 1, gy - 1, 1, gh + 2, '#b6bcc0');
    inset(gx, gy, gw, gh, '#161618');
    glow(gx, gy, gw, gh, '#b44aff', beat ? 0.22 : 0.08);       // purple bass backlight (kept)
    for (let rj = 0; rj < gh; rj++) for (let c = 0; c < gw; c++)
      if (((rj + c) & 1) === 0) px(gx + c, gy + rj, 1, 1, beat ? '#3a2150' : '#26262b');
    for (let c = 1; c < gw; c += 3) px(gx + c, gy, 1, gh, U.shade('#161618', beat ? 0.26 : 0.10));
    // knobs + power LED on the crown (kept)
    px(x + 2, y - 2, 2, 2, '#3a3a40'); px(x + 2, y - 2, 1, 1, '#6a6a72');
    px(x + 5, y - 2, 2, 2, '#3a3a40'); px(x + 5, y - 2, 1, 1, '#6a6a72');
    const on = f.work ? blink(900) : true;
    px(x + w - 3, y - 2, 1, 1, on ? '#ff5a4a' : '#3a1612');
    if (on) glow(x + w - 4, y - 3, 3, 3, '#ff5a4a', 0.25);
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
  F.treasury_pnl_holo = (x, y, w, h, f) => {   // v2: ROUND emitter puck on the deck + the floating P&L hologram (kept)
    const cx = x + w / 2;
    // ---- round floor puck (oval, top-bias) ----
    ctx.globalAlpha = 0.20; px(x + 3, y + h - 1, 6, 1, '#000'); ctx.globalAlpha = 1;
    px(x + 3, y + h - 5, 6, 1, LINE);                           // oval silhouette
    px(x + 2, y + h - 4, 8, 2, LINE);
    px(x + 3, y + h - 2, 6, 1, LINE);
    px(x + 3, y + h - 4, 6, 1, '#1a1f1d');                      // puck top surface
    px(x + 3, y + h - 4, 1, 1, '#242b28');                      // west lit
    px(x + 8, y + h - 4, 1, 1, '#0e1210');                      // east dark
    px(x + 4, y + h - 4, 4, 1, '#3a5a2e');                      // lens ring (kept rim)
    px(x + 5, y + h - 4, 2, 1, '#9bff4a');                      // hot lens core
    px(x + 5, y + h - 4, 1, 1, '#d6ffb0');                      // west glint
    px(x + 3, y + h - 3, 6, 1, '#111614');                      // puck face
    px(x + 4, y + h - 3, 1, 1, blink(900) ? '#9bff4a' : '#1c2a1a'); // status dot (kept)
    px(cx - 1, y + h - 5, 2, 1, '#2a3a22');                     // emitter notch (kept)

    // ---- holographic projection (translucent toxic-green stack, kept) ----
    const G = '#9bff4a', GT = '#d6ffb0';
    const base = y + h - 5;          // hologram sits just above the lens
    const top = y;                   // rises to top of tile
    const span = base - top;         // vertical room for chart
    const fl = 0.55 + 0.18 * flick(220) + 0.12 * flick(90, 1);

    glow(cx - 3, top, 6, span, G, 0.07 * fl);                   // emitter cone
    px(cx, base - 1, 1, 1, GT);

    const grow = Math.floor((now / 520) % 4);                   // which bar is "alive"
    const heights = [2, 4, 6, 8];
    const bw = 2, gap = 1;
    const startX = cx - (4 * bw + 3 * gap) / 2;
    ctx.save();
    ctx.globalAlpha = 0.42 * fl;
    for (let b = 0; b < 4; b++) {
      let hgt = heights[b] + (b === grow ? 1 + Math.floor((now / 130) % 2) : 0);
      if (hgt > span - 1) hgt = span - 1;
      const bx = Math.round(startX + b * (bw + gap));
      const by = base - 1 - hgt;
      px(bx, by, bw, hgt, G);
      px(bx, by, bw, 1, GT);
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.12 * fl;
    const scan = top + 1 + Math.floor((now / 240) % span);
    for (let sy = top + 1; sy < base; sy += 2) px(cx - 4, sy, 8, 1, G);
    ctx.restore();
    ctx.save(); ctx.globalAlpha = 0.22 * fl; px(cx - 4, scan, 8, 1, GT); ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.7 * fl;                                 // rising trend line
    px(startX, base - 3, 1, 1, GT);
    px(startX + 2, base - 4, 1, 1, GT);
    px(startX + 4, base - 6, 1, 1, GT);
    px(startX + 6, base - 8, 1, 1, GT);
    ctx.restore();

    const peakX = Math.round(startX + 6), peakY = base - 9;     // up-arrow glint (kept)
    const glint = blink(640) ? GT : G;
    ctx.save();
    ctx.globalAlpha = 0.9 * fl;
    px(peakX, peakY, 1, 1, glint);
    px(peakX - 1, peakY + 1, 3, 1, glint);
    px(peakX, peakY + 1, 1, 2, glint);
    ctx.restore();
    if (f && f.work && blink(300)) glow(cx - 4, top, 8, span, G, 0.10);
  };
  F.war_pivotpanel = (x, y, w, h, f) => {   // v2 freestanding: split decision board riding rolling posts
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, w - 4);
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx - 1, y + 5, 4, h - 7, LINE);
      px(pxx, y + 6, 1, h - 8, r.lit); px(pxx + 1, y + 6, 1, h - 8, r.dk);
      rr(pxx - 3, y + h - 3, 8, 2, LINE);
      px(pxx - 2, y + h - 3, 6, 1, r.face);
      px(pxx - 2, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 2, y + h - 1, 2, 1, '#1a1e22');
      ctx.globalAlpha = 0.30; px(pxx - 3, y + h, 8, 1, '#000'); ctx.globalAlpha = 1;
    }
    rr(x, y - 5, w, 12, LINE);
    px(x + 1, y - 4, w - 2, 10, r.face);
    px(x + 1, y - 4, w - 2, 1, r.lit);
    px(x + 2, y - 4, 5, 1, U.shade(r.lit, 0.14));               // brushed streak
    px(x + 2, y - 4, 1, 1, '#56645c'); px(x + w - 3, y - 4, 1, 1, '#56645c');
    px(x + 1, y + 5, w - 2, 1, r.ao);
    // split face well
    const fy = y - 3, fh = 8, half = (w - 6) / 2;
    inset(x + 2, fy, w - 4, fh, '#101216');
    // left: rose PIVOT panel (kept 1:1)
    const lx = x + 3;
    px(lx, fy + 1, half - 1, fh - 2, '#ff5c7a');
    px(lx, fy + 1, half - 1, 1, '#ffd0d9');
    px(lx, fy + 2, 1, fh - 3, U.shade('#ff5c7a', 0.22));
    px(lx, fy + fh - 2, half - 1, 1, U.shade('#ff5c7a', -0.4));
    for (let i = 0; i < 5; i++) px(lx + 1 + i * 2, fy + 3, 1, 2, '#ffd0d9'); // PIVOT ticks
    px(lx + 2, fy + 4, 1, 1, '#a8324a'); px(lx + 6, fy + 4, 1, 1, '#a8324a');
    // amber seam (kept)
    const sx2 = lx + half;
    px(sx2, fy, 1, fh, '#ffb84d'); px(sx2, fy, 1, 1, '#ffe1a0');
    px(sx2, fy + 1, 1, fh - 2, U.shade('#ffb84d', -0.15));
    // right: periwinkle PERSEVERE panel (kept 1:1)
    const rx = sx2 + 1;
    px(rx, fy + 1, half - 1, fh - 2, '#a0a8ff');
    px(rx, fy + 1, half - 1, 1, '#d4d8ff');
    px(rx + half - 2, fy + 2, 1, fh - 3, U.shade('#a0a8ff', -0.28));
    px(rx, fy + fh - 2, half - 1, 1, U.shade('#a0a8ff', -0.35));
    for (let i = 0; i < 5; i++) px(rx + 1 + i * 2, fy + 3, 1, 2, '#d4d8ff'); // PERSEVERE ticks
    px(rx + 3, fy + 4, 1, 1, '#5a64b8'); px(rx + 7, fy + 4, 1, 1, '#5a64b8');
    // drifting scanline over the lit halves (kept)
    const sc = fy + 1 + Math.floor((now / 240) % (fh - 2));
    glow(lx, sc, half - 1, 2, '#fff', 0.10); glow(rx, sc, half - 1, 2, '#fff', 0.10);
    // magnetic chrome puck on the PERSEVERE side (kept)
    const pcx = rx + half - 4, pcy = fy + fh - 4;
    ctx.globalAlpha = 0.30; px(pcx - 1, pcy + 2, 4, 1, '#000'); ctx.globalAlpha = 1;
    px(pcx, pcy, 3, 2, '#c8ccd6'); px(pcx, pcy, 3, 1, '#eef0f6'); px(pcx, pcy + 1, 3, 1, '#8a8e98');
    px(pcx, pcy, 1, 1, '#ffffff');
    // pulsing seam LED (kept)
    const pulse = Math.max(0, Math.sin(now / 700));
    glow(sx2, fy + 2 + Math.floor(fh / 2), 1, 2, '#ff5c7a', 0.25 + 0.65 * pulse);
    if (pulse > 0.6) px(sx2, fy + 2 + Math.floor(fh / 2), 1, 1, '#ffd0d9');
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
  F.war_threatcore = (x, y, w, h, f) => {   // v2 TALL 3/4 column: anodized threat totem, splayed foot, crown sweep
    const hot = f.work ? 1 : 0.55;
    shadow2(x + 1, y + h - 1, w - 2);
    glow(x - 1, y + h - 3, w + 2, 3, '#ff5c7a', (0.10 + 0.05 * hot) + 0.04 * Math.sin(now / 900)); // floor halo (kept)
    // splayed base foot
    rr(x - 1, y + h - 4, w + 2, 4, LINE);
    px(x, y + h - 3, w, 2, '#22262c');
    px(x, y + h - 3, w, 1, '#343a42');
    px(x, y + h - 1, w, 1, '#0d0e10');
    // slim full-height column, rises above the footprint
    rr(x + 1, y - 4, w - 2, h, LINE);
    px(x + 2, y - 3, w - 4, h - 2, '#1c1e22');
    px(x + 2, y - 3, 1, h - 2, '#2c313a');                      // west lit rail
    px(x + w - 3, y - 3, 1, h - 2, '#0d0e10');                  // east shade rail
    // rounded cap with visible top
    rr(x + 2, y - 6, w - 4, 3, LINE);
    px(x + 3, y - 5, w - 6, 2, '#262b32');
    px(x + 3, y - 5, w - 6, 1, '#3c434e');
    // smoked-glass well with stacked 5-segment readout, fills bottom-up (kept 1:1)
    const gx2 = x + 3, gy2 = y, gw2 = w - 6, gh2 = 11;
    inset(gx2, gy2, gw2, gh2, '#0d0e10');
    const segs = 5, seglvl = f.work ? 5 : 3;
    const topAmber = blink(1400);                               // slow warning loop (kept)
    for (let s = 0; s < segs; s++) {
      const sy3 = gy2 + gh2 - 2 - s * 2;
      if (s < seglvl) {
        const isTop = s === seglvl - 1;
        const col = (isTop && topAmber) ? '#ffb84d' : '#ff5c7a';
        px(gx2 + 1, sy3, gw2 - 2, 1, col);
        px(gx2 + 1, sy3, 2, 1, U.shade(col, 0.14));             // west-lit segment edge
      } else {
        px(gx2 + 1, sy3, gw2 - 2, 1, '#16171a');                // unlit segment behind smoked glass
      }
    }
    px(gx2, gy2, 1, gh2, '#262b32');                            // smoked-glass sheen
    glow(gx2, gy2, gw2, gh2, (topAmber ? '#ffb84d' : '#ff5c7a'), 0.06 + 0.05 * hot);
    // vent slits below the glass (kept)
    for (let v = 0; v < 3; v++) {
      const vy = gy2 + gh2 + 2 + v * 2;
      px(x + 3, vy, w - 6, 1, '#0d0e10');
      px(x + 3, vy + 1, w - 6, 1, '#3a3f47');
    }
    // rose glow bleeding from the seams (kept)
    glow(x + 1, gy2, 1, gh2, '#ff5c7a', 0.08 + 0.05 * hot);
    glow(x + w - 2, gy2, 1, gh2, '#ff5c7a', 0.08 + 0.05 * hot);
    // crown: rotating radar sweep dot orbiting a tiny hub (kept 1:1)
    const hubx = x + w / 2, huby = y - 8;
    px(hubx - 1, huby + 1, 2, 1, '#4a4e55');
    const a = (now / 600);
    const dx2 = Math.round(Math.cos(a) * 2), dy2 = Math.round(Math.sin(a) * 1);
    px(hubx - 1 + dx2, huby + dy2, 1, 1, f.work ? '#ffd9e2' : '#ff5c7a');
    if (f.work) glow(hubx - 2, huby - 1, 4, 2, '#ff5c7a', 0.16);
  };
  F.pub_publishpress = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE heat press BOLTED to the deck (kept press cycle)
    const PER = 1500;
    const ph = (now % PER) / PER;
    const fire = Math.max(0, Math.sin(ph * Math.PI * 2));
    const firing = ph > 0.18 && ph < 0.42;
    const heat = (f && f.work) ? 0.45 + 0.55 * fire : 0.18 + 0.30 * fire;
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 5, w + 2, 5);                     // heavy press: bolted mounting plate
    deckSocket(x + w + 1, y + h - 3, f && f.work);
    px(x + w, y + h - 3, 1, 1, '#0e1418');                     // conduit stub
    // body: chamfered slab front face
    rr(x, y + 6, w, h - 8, LINE);
    px(x + 1, y + 7, w - 2, h - 10, r.face);
    px(x + 1, y + 7, 1, h - 10, U.shade(r.face, 0.08));
    px(x + w - 2, y + 7, 1, h - 10, r.dk);
    px(x + 1, y + h - 4, w - 2, 1, r.ao);
    // chrome side pistons
    px(x + 1, y + 9, 2, 10, '#5a625e'); px(x + 1, y + 9, 1, 10, '#8a928c'); px(x + 1, y + 10, 1, 2, '#cfd6d0');
    px(x + w - 3, y + 9, 2, 10, '#5a625e'); px(x + w - 2, y + 9, 1, 10, '#8a928c');
    px(x + 1, y + 17, 2, 1, '#3a423e'); px(x + w - 3, y + 17, 2, 1, '#3a423e'); // piston collars
    // recessed heat plate: amber->gold gradient + emissive heat wash (kept)
    const plX = x + 5, plY = y + 10, plW = w - 10, plH = 7;
    inset(plX - 1, plY - 1, plW + 2, plH + 2, '#241f16');
    for (let i = 0; i < plH; i++) {
      const tt = i / (plH - 1);
      const base = tt < 0.5 ? U.shade('#ff8a1e', tt * 0.30) : U.shade('#ffc24a', (tt - 0.5) * 0.24);
      px(plX, plY + (plH - 1 - i), plW, 1, base);
    }
    glow(plX, plY, plW, plH, '#ffb030', 0.16 + 0.34 * heat);
    if (firing) glow(plX - 1, plY - 1, plW + 2, plH + 2, '#ffe066', 0.10 + 0.30 * fire);
    px(plX + 1, plY + Math.floor(plH / 2), plW - 2, 1, firing ? '#fff0b0' : '#ffcf66'); // hot core line
    // status LEDs on the face (kept timings)
    px(x + w - 8, y + h - 5, 1, 1, '#41ff8a');                              // steady green
    px(x + w - 6, y + h - 5, 1, 1, blink(750) ? '#ffe066' : '#3a3210');     // blinking gold
    px(x + w - 4, y + h - 5, 1, 1, firing ? '#ff9d2e' : '#2a2014');         // fires with print
    if (blink(750)) glow(x + w - 7, y + h - 6, 3, 3, '#ffe066', 0.30);
    // dominant rounded top slab
    rr(x - 1, y - 2, w + 2, 10, LINE);
    rr(x, y - 1, w, 8, r.top);
    px(x + 1, y - 1, w - 2, 1, r.sheen);
    px(x, y, 1, 6, r.lit); px(x + w - 1, y, 1, 6, r.dk);
    px(x + 1, y + 6, w - 2, 1, U.shade(r.top, -0.16));         // top front edge
    // roller drum across the top
    rr(x + 2, y, w - 4, 5, LINE);
    px(x + 3, y + 1, w - 6, 3, '#33383a');
    px(x + 3, y + 1, w - 6, 1, U.shade('#33383a', 0.26));      // cylinder highlight
    px(x + 3, y + 3, w - 6, 1, '#23272a');                     // dark belly
    px(x + 3, y + 1, 2, 3, '#22262a'); px(x + 3, y + 2, 1, 1, '#454d4a');   // west hub
    px(x + w - 5, y + 1, 2, 3, '#22262a'); px(x + w - 4, y + 2, 1, 1, '#454d4a'); // east hub
    // poster stock feeding over the drum, gold test grid (kept)
    const sheetX = x + 6, sheetW = w - 12, sheetTop = y - 6;
    px(sheetX, sheetTop, sheetW, 8, '#cdd2cc');
    px(sheetX, sheetTop, sheetW, 1, '#e6eae4');
    px(sheetX, sheetTop, 1, 8, '#b6bbb4');
    for (let gx2 = 0; gx2 < sheetW; gx2 += 3) px(sheetX + gx2, sheetTop + 1, 1, 6, '#ffe066');
    for (let gy2 = 0; gy2 < 6; gy2 += 2) px(sheetX, sheetTop + 1 + gy2, sheetW, 1, U.shade('#ffe066', -0.06));
    glow(sheetX, sheetTop, sheetW, 8, '#ffe066', 0.10);
    // warm rim-light along the top's back edge (kept)
    px(x + 2, y - 1, 6, 1, '#ffe066');
    glow(x + 1, y - 1, w - 2, 1, '#ffe066', 0.25);
    // steam wisp from the sheet on the fire pulse (kept)
    if (firing) {
      const sx2 = sheetX + Math.floor(sheetW / 2);
      ctx.save();
      ctx.globalAlpha = 0.18 + 0.18 * fire;
      px(sx2, sheetTop - 1, 1, 2, '#ffffff');
      px(sx2 + (blink(220) ? 1 : -1), sheetTop - 3, 1, 2, '#ffffff');
      px(sx2, sheetTop - 5, 1, 1, '#ffffff');
      ctx.restore();
    }
  };
  F.pub_outboundchute = (x, y, w, h, f) => {   // TALL 3/4 pneumatic SHIP chute: flared hopper + glass drop slit (kept)
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    // column body
    rr(x - 1, y - 3, w + 2, h + 1, LINE);
    px(x + 1, y - 2, w - 2, h - 2, r.face);
    px(x + 1, y - 2, 1, h - 2, U.shade(r.face, 0.08));
    px(x + w - 2, y - 2, 1, h - 2, r.dk);
    px(x + 1, y + h - 4, w - 2, 1, r.ao);
    // flared hopper mouth JUTS wider than the column
    rr(x - 2, y - 7, w + 4, 6, LINE);
    px(x - 1, y - 6, w + 2, 4, r.top);
    px(x - 1, y - 6, w + 2, 1, r.sheen);
    px(x - 1, y - 5, 1, 3, r.lit); px(x + w, y - 5, 1, 3, r.dk);
    inset(x + 1, y - 5, w - 2, 3, '#0d100c');                  // dark throat
    const ring = 0.45 + 0.25 * Math.sin(now / 600);            // gold ring-light (kept)
    glow(x + 1, y - 5, w - 2, 1, '#ffe066', ring);
    glow(x + 1, y - 5, 1, 3, '#ffe066', ring * 0.7);
    glow(x + w - 2, y - 5, 1, 3, '#ffe066', ring * 0.7);
    px(x + 2, y - 4, w - 4, 1, '#1a1d17');                     // mouth shadow
    px(x, y - 1, w, 1, U.shade(r.face, -0.30));                // flare underside shadow
    // glass viewport slit with parcel mid-drop (kept anim)
    const sx = x + 3, sw = w - 6, sy = y + 1, sh2 = h - 13;
    inset(sx, sy, sw, sh2, '#0d100c');
    glow(sx + 1, sy, 1, sh2, '#9ab0a0', 0.10);
    ctx.save(); ctx.beginPath(); ctx.rect(sx + 1, sy + 1, sw - 2, sh2 - 2); ctx.clip();
    const ph = (now / 2000) % 1;
    const py2 = sy + 1 + Math.floor(ph * (sh2 + 1));
    if (ph < 0.92) {
      px(sx + 2, py2, 3, 3, '#36424c');                        // steel parcel case
      px(sx + 2, py2, 3, 1, '#46525a');
      px(sx + 2, py2 + 1, 1, 2, '#28323a');
      px(sx + 3, py2 + 1, 1, 1, '#caa84a');                    // tape strip
    }
    ctx.restore();
    px(sx, sy, 1, sh2, '#161a14'); px(sx + sw - 1, sy, 1, sh2, '#161a14');
    // chamfered lower barrel with SHIP stencil (kept)
    const by = y + h - 10;
    rr(x - 1, by, w + 2, 7, LINE);
    px(x, by + 1, w, 5, U.shade(r.face, -0.10));
    px(x, by + 1, w, 1, r.lit);
    px(x, by + 3, w, 1, U.shade(r.face, -0.35));               // band seam
    px(x + 2, by + 2, 1, 1, '#e6ece2'); px(x + 1, by + 3, 3, 1, '#e6ece2'); px(x + 2, by + 4, 1, 1, '#e6ece2'); // down arrow
    ctx.fillStyle = '#e6ece2'; ctx.font = '5px monospace'; ctx.fillText('SHIP', x + 4, by + 4);
    for (let i = 0; i < 7; i++) px(x + 2 + i, by + 5, 1, 1, (U.hash('bc' + i) % 2) ? '#dfe8df' : '#1a1d17'); // barcode
    // corner rivets on the column
    for (const rx of [x + 1, x + w - 2]) for (const ry of [y + 1, y + h - 12]) {
      px(rx, ry, 1, 1, '#5c6055'); px(rx, ry + 1, 1, 1, '#14170f');
    }
    // kick + feet with a floor gap
    underAO(x + 2, y + h - 2, w - 4, 1);
    px(x + 1, y + h - 2, 2, 2, r.dk); px(x + w - 3, y + h - 2, 2, 2, r.dk);
    px(x + 1, y + h - 2, 1, 1, r.lit); px(x + w - 3, y + h - 2, 1, 1, r.lit);
  };
  F.pub_mailpod = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE rounded mail pod: BOLD capsule, twin glass bays (kept)
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 3, x + w - 6]) {                     // stub feet
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 6, y + 9, w - 12, 2);
    // capsule silhouette: 2-step rounded ends
    px(x + 2, y - 4, w - 4, 13, LINE);
    px(x + 1, y - 3, w - 2, 11, LINE);
    px(x, y - 2, w, 9, LINE);
    // dome top (dominant)
    px(x + 3, y - 3, w - 6, 1, r.sheen);                       // crown sheen
    px(x + 2, y - 2, w - 4, 1, U.shade(r.top, 0.10));          // shoulder
    px(x + 1, y - 1, w - 2, 3, r.top);
    px(x + 1, y - 1, 1, 3, r.lit); px(x + w - 2, y - 1, 1, 3, r.dk);
    px(x + 1, y + 2, w - 2, 1, U.shade(r.top, -0.16));         // dome lip
    // short face + rounded base
    px(x + 1, y + 3, w - 2, 4, r.face);
    px(x + 1, y + 3, w - 2, 1, U.shade(r.face, 0.08));
    px(x + 2, y + 7, w - 4, 1, r.ao);
    // twin round glass capsule bays (kept thunk cycle)
    const thunk = Math.floor(now / 2500) % 2 === 0 && (now % 2500) < 220;
    const bays = [
      { cx: x + 6, empty: false },
      { cx: x + w - 7, empty: thunk }                          // right bay thunks empty then refills
    ];
    const cy = y + 2;
    for (let b = 0; b < 2; b++) {
      const bx = bays[b].cx;
      inset(bx - 4, cy - 4, 8, 8, '#1c211b');                  // recessed well
      px(bx - 3, cy - 3, 6, 6, '#23302c');                     // glass bay
      px(bx - 3, cy - 3, 6, 1, U.shade('#23302c', 0.30));
      if (!bays[b].empty) {
        px(bx - 2, cy - 2, 4, 4, '#56646e');                   // rolled steel capsule
        px(bx - 2, cy - 2, 4, 1, '#6a7882');
        px(bx - 1, cy - 1, 1, 2, '#28323a');
      } else {
        px(bx - 2, cy - 1, 4, 2, '#161b15');
      }
      glow(bx - 3, cy - 3, 6, 1, '#bfeaff', 0.22);             // glass sheen
      px(bx - 2, cy - 2, 1, 1, '#dff4ff');
    }
    // indicators above each bay (kept: steady cyan-white / blinking gold)
    px(bays[0].cx, y - 3, 1, 1, '#dff6ff');
    glow(bays[0].cx - 1, y - 4, 3, 3, '#aef0ff', 0.30);
    const goldOn = blink(620);
    px(bays[1].cx, y - 3, 1, 1, goldOn ? '#ffe066' : '#28323a');
    if (goldOn) glow(bays[1].cx - 1, y - 4, 3, 3, '#ffe066', 0.34);
    // intake snorkel pipe arcing off the NE shoulder (kept)
    px(x + w - 3, y - 5, 3, 2, '#36424c');
    px(x + w - 1, y - 6, 2, 2, '#46525a');
    px(x + w, y - 7, 1, 2, '#56646e');
    px(x + w - 3, y - 5, 3, 1, '#6a7882');
    // central feed slot between the bays
    inset(x + 10, y + 3, 3, 4, '#1a1f18');
  };
  F.arc_indexwall = (x, y, w, h, f) => {   // v2 freestanding: index-card cabinet row on stub feet
    const r = RAMP.gun;
    shadow2(x + 2, y + h - 1, w - 4);
    for (const lx of [x + 4, x + Math.floor(w / 2) - 1, x + w - 7]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 7, y + 9, w - 14, 2);
    // cabinet body
    rr(x, y - 7, w, 16, LINE);
    px(x + 1, y - 5, w - 2, 13, r.face);
    px(x + 1, y - 5, 1, 13, U.shade(r.face, 0.08));
    px(x + w - 2, y - 5, 1, 13, r.dk);
    px(x + 1, y + 7, w - 2, 1, r.ao);
    // silver top rail (kept accent)
    px(x + 1, y - 6, w - 2, 1, '#c0c0c0');
    px(x + 2, y - 5, w - 4, 1, '#7e8480');
    glow(x + 1, y - 6, w - 2, 1, '#e6e6e6', 0.12);
    // recessed catalogue well
    inset(x + 2, y - 4, w - 4, 10, '#161c1a');
    // 6x3 grid of back-lit index slips, one flips cyan per second (kept)
    const cols = 6, rows = 3, gw = w - 8;
    const land = Math.floor(now / 1000);
    const litIdx = land % (cols * rows);
    for (let rj = 0; rj < rows; rj++) for (let c = 0; c < cols; c++) {
      const cx = x + 4 + Math.round(c * gw / cols);
      const cy = y - 3 + rj * 3;
      const idx = rj * cols + c;
      const sw = 2 + (U.hash('ix' + idx) % 2);
      const flip = idx === litIdx;
      px(cx, cy, sw + 2, 2, flip ? '#bfeefe' : '#b8c0bc');
      px(cx, cy, sw + 2, 1, flip ? '#e6fbff' : '#d6dedb');
      if (flip) glow(cx - 1, cy - 1, sw + 4, 4, '#8fdfff', 0.4);
      px(cx, cy + 2, sw + 3, 1, '#0e1413');                    // slip slot shadow
    }
    // 1px silver scan-line sweeping the well (kept)
    const sweep = x + 3 + Math.floor((now / 30) % (w - 6));
    glow(sweep, y - 4, 1, 10, '#dfe6e2', 0.5);
    // status dots at the well's lower corners (kept)
    px(x + 2, y + 6, 1, 1, '#ffb24a');                         // steady amber
    glow(x + 2, y + 6, 1, 1, '#ffd34a', 0.4);
    px(x + w - 3, y + 6, 1, 1, blink(700) ? '#e6e6e6' : '#3a423e'); // blinking silver
  };
  F.arc_microfiche = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE reader desk: reels + frosted viewport on a slab (kept)
    const r = RAMP.gun;
    const step = Math.floor(now / 2200);                       // notch advance (kept)
    const advancing = (now % 2200) < 260;
    const lit = f.work;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 5]) {                     // desk legs
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short front lip with the silver engraved label plate (kept)
    rr(x, y + 4, w, 6, LINE);
    px(x + 1, y + 5, w - 2, 4, r.face);
    px(x + 1, y + 5, w - 2, 1, r.lit);
    px(x + 1, y + 8, w - 2, 1, r.ao);
    px(x + 7, y + 6, w - 14, 2, '#c0c0c0');
    px(x + 7, y + 6, w - 14, 1, U.shade('#c0c0c0', 0.16));
    for (let i = 0; i < w - 18; i += 3) px(x + 9 + i, y + 7, 2, 1, '#6a6e6e'); // engraved text
    // desk top slab
    rr(x - 1, y, w + 2, 6, LINE);
    rr(x, y + 1, w, 4, r.top);
    px(x + 1, y + 1, w - 2, 1, r.sheen);
    px(x, y + 2, 1, 2, r.lit); px(x + w - 1, y + 2, 1, 2, r.dk);
    px(x + 1, y + 4, w - 2, 1, U.shade(r.top, -0.16));
    // reader housing standing on the slab
    rr(x + 2, y - 9, w - 4, 11, LINE);
    px(x + 3, y - 8, w - 6, 9, r.face);
    px(x + 3, y - 8, w - 6, 1, r.lit);
    px(x + 3, y - 7, 1, 8, U.shade(r.face, 0.08));
    px(x + w - 4, y - 7, 1, 8, r.dk);
    // frosted glass viewport, centered (kept flicker + frame advance)
    const vx = x + 10, vy = y - 7, vw = 4, vh = 6;
    box(vx - 1, vy - 1, vw + 2, vh + 2, '#161c1a');
    inset(vx, vy, vw, vh, '#3a4744');
    const base = lit ? 0.34 : 0.16;
    const flk = advancing ? 0.14 * Math.abs(flick(70)) : 0.05 * Math.sin(now / 500);
    glow(vx, vy, vw, vh, '#c8d8da', base + flk);
    px(vx + 1, vy + 1, vw - 2, 1, '#dfeceb');                  // top sheen
    const fx = vx + 1 + (step % 2);                            // film frame shifts as it advances
    px(fx, vy + 2, 1, vh - 3, lit ? '#aebcbe' : '#8a9698');
    px(fx, vy + Math.floor(vh / 2), 1, 1, U.shade('#aebcbe', -0.28));
    if (advancing) px(vx + 1, vy + 1 + (step % (vh - 2)), vw - 2, 1, '#eef6f5'); // advance scan line
    // twin chrome reels flanking the viewport, spokes notch per step (kept)
    const ry = y - 4;
    const reel = (cx) => {
      px(cx - 3, ry - 3, 6, 6, '#6e7474');
      px(cx - 2, ry - 2, 4, 4, '#9aa0a0');
      px(cx - 2, ry - 2, 4, 1, U.shade('#9aa0a0', 0.20));
      px(cx - 1, ry + 1, 2, 1, U.shade('#9aa0a0', -0.26));
      const o = step % 4;
      if (o === 0) { px(cx - 2, ry, 4, 1, '#d8dcdc'); }
      else if (o === 1) { px(cx, ry - 2, 1, 4, '#d8dcdc'); }
      else if (o === 2) { px(cx - 2, ry - 1, 1, 1, '#d8dcdc'); px(cx + 1, ry, 1, 1, '#d8dcdc'); }
      else { px(cx + 1, ry - 1, 1, 1, '#d8dcdc'); px(cx - 2, ry, 1, 1, '#d8dcdc'); }
      px(cx, ry, 1, 1, '#4a5050');
    };
    const lcx = x + 6, rcx = x + w - 6;
    reel(lcx); reel(rcx);
    // film strip threaded across the housing crown (kept advance highlight)
    px(lcx + 2, ry - 4, rcx - lcx - 4, 1, advancing ? '#e4e8e8' : '#b8bebe');
    px(lcx + 2, ry + 3, rcx - lcx - 4, 1, U.shade('#b8bebe', -0.22)); // lower strand
    // ready LED (kept timings)
    const on = lit ? blink(900) : blink(2600);
    px(x + w - 5, y - 8, 1, 1, on ? '#41ff8a' : '#16302a');
    if (on) glow(x + w - 6, y - 9, 3, 3, '#41ff8a', 0.4);
  };
  F.arc_floorlight = (x, y, w, h, f) => {   // v2: flush ROUND deck light — recessed ring + pulsing lens, flat (walk-over)
    const cx = x + w / 2;
    // stepped circular recess cut into the deck (no shadow — it IS the floor)
    const well = [[3, 6], [2, 8], [1, 10], [1, 10], [1, 10], [1, 10], [2, 8], [3, 6]];
    well.forEach((s, j) => px(x + s[0], y + 2 + j, s[1], 1, '#171b19'));
    px(x + 3, y + 2, 6, 1, '#121614');                          // deep top lip
    px(x + 3, y + 9, 6, 1, U.shade('#1f2422', 0.10));           // bottom bevel catch (kept)
    // round metal housing ring
    const ring = [[3, 6], [2, 8], [2, 8], [2, 8], [2, 8], [3, 6]];
    ring.forEach((s, j) => px(x + s[0], y + 3 + j, s[1], 1, '#2a302d'));
    px(x + 3, y + 3, 6, 1, '#39453f');                          // ring top lit
    px(x + 2, y + 4, 1, 4, '#333e38');                          // west arc lit
    px(x + 9, y + 4, 1, 4, '#1c2220');                          // east arc dark
    px(x + 3, y + 4, 1, 1, '#48544c'); px(x + 8, y + 4, 1, 1, '#48544c'); // bezel bolts
    px(x + 3, y + 7, 1, 1, '#1f2622'); px(x + 8, y + 7, 1, 1, '#1f2622');
    // round pulsing lens (kept slow breath + glow bleed)
    const pulse = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(now / 1300));
    const lens = [[4, 4], [3, 6], [3, 6], [4, 4]];
    lens.forEach((s, j) => px(x + s[0], y + 4 + j, s[1], 1, U.shade('#dfe2e0', -0.38 + 0.20 * pulse)));
    ctx.save();
    ctx.globalAlpha = pulse;
    lens.forEach((s, j) => px(x + s[0], y + 4 + j, s[1], 1, '#dfe2e0'));
    px(x + 4, y + 5, 2, 1, U.shade('#dfe2e0', 0.18));           // hot inner glint, west-biased
    ctx.restore();
    glow(x + 1, y + 2, 10, 8, '#cfe0e2', 0.05 + 0.06 * pulse);  // kept floor bleed
    glow(x + 3, y + 4, 6, 4, '#eef2f2', 0.07 + 0.10 * pulse);
    // etched chevron pointing down the aisle (+y, kept)
    px(cx - 2, y + 10, 1, 1, '#56706e'); px(cx + 1, y + 10, 1, 1, '#56706e');
    px(cx - 1, y + 11, 2, 1, '#56706e');
  };
  F.arc_ladder = (x, y, w, h, f) => {   // v2: LEANING maintenance ladder — bold diagonal, rails + rungs, parked gear
    const r = RAMP.steel;
    shadow2(x + 1, y + h - 1, 9);                               // floor contact
    const foot = y + h - 2;                                     // feet on the floor line
    const rows = 18;                                            // rises ~7px above the tile
    const xoAt = (i) => Math.round(i * 4 / (rows - 1));         // eastward lean drift
    // pass 1: rail silhouettes (diagonal)
    for (let i = 0; i < rows; i++) {
      const xo = xoAt(i), yy = foot - i;
      px(x + xo, yy, 4, 1, LINE); px(x + 6 + xo, yy, 4, 1, LINE);
    }
    px(x + xoAt(rows - 1), foot - rows, 4, 1, LINE);            // rounded head caps
    px(x + 6 + xoAt(rows - 1), foot - rows, 4, 1, LINE);
    // pass 2: rungs between the rails
    for (const i of [3, 7, 11, 15]) {
      const xo = xoAt(i), yy = foot - i;
      px(x + 2 + xo, yy - 1, 8, 3, LINE);
      px(x + 3 + xo, yy, 4, 1, r.sheen);
      px(x + 3 + xo, yy, 1, 1, U.shade(r.sheen, 0.15));         // west rung glint
    }
    // pass 3: rail colors (in front of the rungs)
    for (let i = 0; i < rows; i++) {
      const xo = xoAt(i), yy = foot - i;
      px(x + 1 + xo, yy, 1, 1, r.lit); px(x + 2 + xo, yy, 1, 1, r.face);
      px(x + 7 + xo, yy, 1, 1, r.face); px(x + 8 + xo, yy, 1, 1, r.dk);
    }
    px(x + 1 + xoAt(rows - 1), foot - rows + 1, 2, 1, r.sheen); // head caps catch the light
    px(x + 7 + xoAt(rows - 1), foot - rows + 1, 2, 1, r.sheen);
    // rubber feet on the deck
    px(x + 1, foot, 2, 1, '#1a1e22'); px(x + 7, foot, 2, 1, '#1a1e22');
    // hazard tag hanging off a mid rung
    px(x + 7, y + 4, 1, 1, '#39434b');                          // string
    px(x + 6, y + 5, 3, 3, '#caa84a');
    px(x + 6, y + 5, 3, 1, '#ffd34a');
    px(x + 7, y + 6, 1, 1, '#3a3020');                          // tag glyph
    // kept: slow chrome glint drifting up the west rail
    const g = 0.18 + 0.16 * Math.sin(now / 1400);
    const gi = 2 + (Math.floor(now / 700) % (rows - 3));
    glow(x + 1 + xoAt(gi), foot - gi, 1, 1, '#eaf2f2', g);
    px(x + 1 + xoAt(rows - 4), foot - rows + 4, 1, 1, '#dfe6e6'); // fixed highlight near the head
  };
  F.quarters_pooltable = (x, y, w, h, f) => {   // TOP-BIAS OBLIQUE billiards: rounded rail, felt, 6 pockets
    const wood = '#5c4030', felt = '#2f5d3a', feltLit = '#3c7048';
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 5]) {                      // chunky corner legs
      px(lx, y + 20, 3, 4, LINE); px(lx, y + 20, 1, 4, U.shade(wood, 0.18)); px(lx + 1, y + 20, 1, 4, U.shade(wood, -0.3));
    }
    underAO(x + 5, y + 20, w - 10, 3);
    // short apron face
    rr(x - 1, y + 14, w + 2, 6, LINE);
    px(x, y + 15, w, 4, U.shade(wood, -0.12));
    px(x, y + 15, w, 1, U.shade(wood, 0.10));
    px(x, y + 18, w, 1, U.shade(wood, -0.35));
    // rounded wood rail ring (the top)
    rr(x - 1, y - 3, w + 2, 19, LINE);
    rr(x, y - 2, w, 17, wood);
    px(x + 1, y - 2, w - 2, 1, U.shade(wood, 0.30));            // rail sheen
    px(x, y - 1, 1, 14, U.shade(wood, 0.14)); px(x + w - 1, y - 1, 1, 14, U.shade(wood, -0.28));
    px(x + 1, y + 13, w - 2, 1, U.shade(wood, -0.2));           // rail front lip
    // felt bed
    inset(x + 4, y + 1, w - 8, 11, U.shade(felt, -0.35));
    px(x + 5, y + 2, w - 10, 9, felt);
    for (let i = 0; i < 9; i++) {                               // west-lit diagonal gradient
      const lit = Math.max(0, Math.floor((w - 10) * (1 - i / 9)) - i * 2);
      if (lit > 0) px(x + 5, y + 2 + i, Math.min(lit, w - 10), 1, feltLit);
    }
    px(x + 5, y + 2, w - 10, 1, U.shade(feltLit, 0.12));        // felt sheen line
    // six pockets
    const pk = [[x + 4, y + 1], [x + w / 2 - 2, y], [x + w - 8, y + 1], [x + 4, y + 9], [x + w / 2 - 2, y + 10], [x + w - 8, y + 9]];
    for (const p of pk) { px(p[0], p[1], 4, 4, '#141a16'); px(p[0] + 1, p[1] + 1, 2, 2, '#06090c'); }
    // balls (the 8-ball slowly drifts)
    const drift = Math.round(Math.sin(now / 1400));
    const balls = [[x + 12, y + 4, '#e8e2d2'], [x + w / 2 + 1 + drift, y + 6, '#15161a'], [x + w - 14, y + 4, '#a83a32'], [x + 11, y + 8, '#3a5aa8'], [x + w - 12, y + 8, '#caa84a'], [x + w / 2 - 5, y + 8, '#3a6a8a']];
    for (const b of balls) {
      px(b[0], b[1] + 2, 3, 1, U.shade(felt, -0.3));            // contact shadow on the felt
      px(b[0], b[1], 3, 3, b[2]);
      px(b[0], b[1], 2, 1, U.shade(b[2], 0.25));
      px(b[0], b[1], 1, 1, U.shade(b[2], 0.5));                 // specular
      px(b[0] + 2, b[1] + 2, 1, 1, U.shade(b[2], -0.3));
    }
    // warm rail edge-light + pocket liners (pulsing)
    const pulse = 0.28 + 0.16 * (0.5 + 0.5 * Math.sin(now / 760));
    glow(x + 1, y - 2, w - 2, 2, '#ffb84d', pulse);
    for (const p of pk) glow(p[0], p[1], 4, 4, '#ffb84d', pulse * 0.5);
  };
  F.quarters_vending = (x, y, w, h, f) => {   // TALL 3/4 vending machine: lit shelves, chase strip, drop slot
    const cw = 13, bh = h, r = RAMP.steel;
    shadow2(x + 1, y + bh - 1, cw - 2);
    // body slab + cap (same construction family as the arcade cabinets)
    rr(x - 1, y - 5, cw + 2, bh + 4, LINE);
    px(x + 1, y - 3, cw - 2, bh + 1, r.face);
    px(x + 1, y - 3, 1, bh, U.shade(r.face, 0.10)); px(x + cw - 2, y - 3, 1, bh, r.dk);
    rr(x, y - 7, cw, 3, LINE);
    px(x + 1, y - 6, cw - 2, 2, r.top);
    px(x + 1, y - 6, cw - 2, 1, r.sheen);
    // lit brand header juts slightly
    rr(x - 2, y - 5, cw + 4, 4, LINE);
    px(x - 1, y - 4, cw + 2, 2, blink(1600) ? '#ffb84d' : '#8a5f28');
    px(x + 2, y - 4, 3, 1, '#ffe2b0');                          // header glint
    glow(x - 1, y - 4, cw + 2, 2, '#ffb84d', blink(1600) ? 0.35 : 0.12);
    px(x - 1, y - 2, cw + 2, 1, U.shade('#8a5f28', -0.4));      // header underside
    // glass window: three lit shelves of stock
    inset(x + 2, y - 1, cw - 5, 13, '#0e1614');
    for (let row = 0; row < 3; row++) {
      const ry = y + row * 4;
      px(x + 3, ry + 2, cw - 7, 1, '#233029');                  // shelf lip
      glow(x + 3, ry + 2, cw - 7, 1, '#ffb84d', 0.18);          // shelf edge-light
      for (let c = 0; c < 3; c++) {
        const seed = U.hash('vend' + row + c);
        const base = seed % 2 === 0 ? '#7a2e2e' : '#1f5a63';    // muted red / cyan
        px(x + 3 + c * 2, ry, 2, 2, base);
        px(x + 3 + c * 2, ry, 1, 2, U.shade(base, 0.22));       // can highlight
        px(x + 3 + c * 2, ry, 2, 1, U.shade(base, 0.3));        // cap glint
      }
    }
    ctx.globalAlpha = 0.10; px(x + 3, y, 2, 8, '#bfe6dc'); px(x + 5, y, 1, 4, '#bfe6dc'); ctx.globalAlpha = 1; // glass sheen
    // keypad + ready LED on the east pillar
    for (let i = 0; i < 3; i++) px(x + cw - 3, y + 1 + i * 2, 1, 1, '#9aa49c');
    const ready = blink(620);
    px(x + cw - 3, y + 8, 1, 1, ready ? (f.work ? '#7dffb0' : '#41ff8a') : '#16302a');
    if (ready) glow(x + cw - 4, y + 7, 3, 3, '#41ff8a', f.work ? 0.30 : 0.16);
    // scrolling amber chase strip
    const sy = y + 13, segs = 5, off = Math.floor(now / 140) % segs;
    px(x + 2, sy, cw - 4, 2, '#241c10');
    for (let s = 0; s < segs; s++) {
      const on = ((s + off) % 3) !== 0;
      px(x + 2 + s * 2, sy, 2, 1, on ? '#ffb84d' : '#4a3a1c');
      px(x + 2 + s * 2, sy + 1, 2, 1, on ? '#b8862f' : '#33290f');
    }
    glow(x + 2, sy - 1, cw - 4, 4, '#ffb84d', 0.18 + 0.10 * (0.5 + 0.5 * flick(900)));
    // dispense slot: dark mouth with a warm glow
    inset(x + 2, y + bh - 8, cw - 4, 4, '#0d1110');
    px(x + 3, y + bh - 7, cw - 6, 1, '#1a221e');                // slot lip
    glow(x + 2, y + bh - 8, cw - 4, 3, '#ffb84d', 0.12 + 0.05 * flick(1300, 1));
    px(x + 4, y + bh - 6, 2, 1, U.shade('#ffb84d', -0.1));      // warm dot in the slot
    // kick + feet with a floor gap
    px(x + 1, y + bh - 3, cw - 2, 1, r.ao);
    underAO(x + 2, y + bh - 2, cw - 4, 1);
    px(x + 1, y + bh - 2, 2, 2, r.dk); px(x + cw - 3, y + bh - 2, 2, 2, r.dk);
    px(x + 1, y + bh - 2, 1, 1, r.lit); px(x + cw - 3, y + bh - 2, 1, 1, r.lit);
    wear(x + 1, y + bh - 5, cw - 2, 2, 2, U.shade(r.face, -0.12));
  };
  F.quarters_lockerbank = (x, y, w, h, f) => {   // locker fronts + thin lit top, freestanding on feet
    const r = RAMP.gun;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w / 2 - 1, x + w - 5]) {       // feet
      px(lx, y + 8, 3, 4, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // thin top surface
    rr(x - 1, y - 5, w + 2, 4, LINE);
    px(x, y - 4, w, 2, r.top);
    px(x, y - 4, w, 1, r.sheen);
    px(x, y - 4, 5, 1, U.shade(r.sheen, 0.12));
    // locker fronts: three rounded doors
    rr(x - 1, y - 2, w + 2, 11, LINE);
    px(x, y - 1, w, 9, r.face);
    px(x, y - 1, w, 1, r.lit);                                  // catch under the top
    for (let d = 0; d < 3; d++) {
      const dx = x + 1 + d * 12;
      if (d) px(dx - 2, y, 1, 8, r.ao);                         // dark seam between doors
      rr(dx, y, 10, 8, U.shade(r.face, 0.14));                  // door plate
      px(dx + 1, y, 8, 1, U.shade(r.face, 0.28));               // door top catch
      px(dx, y + 7, 10, 1, U.shade(r.face, -0.2));              // door base shade
      px(dx + 3, y + 2, 4, 1, r.ao); px(dx + 3, y + 4, 4, 1, r.ao); // vent slots
      px(dx + 3, y + 1, 4, 1, U.shade(r.face, 0.3));            // vent catch
      px(dx + 8, y + 5, 1, 2, '#0c1210');                       // handle slot
      px(dx + 8, y + 5, 1, 1, U.shade(r.lit, 0.3));             // handle glint
    }
    px(x, y + 7, w, 1, r.ao);                                   // floor-line AO
    // door 0: worn pink sticker
    px(x + 3, y + 5, 3, 2, '#b56a78'); px(x + 3, y + 5, 3, 1, '#c98592');
    // door 1: amber name-tag light, slow pulse
    const tp = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(now / 1100));
    inset(x + 15, y + 4, 5, 3, '#10161a');
    glow(x + 16, y + 5, 3, 1, '#ffb84d', tp);
    px(x + 16, y + 5, 1, 1, U.shade('#ffb84d', 0.1));
    glow(x + 15, y + 4, 5, 3, '#ffb84d', 0.10 + 0.10 * tp);
    wear(x + 1, y + 4, w - 2, 4, 4, U.shade(r.face, -0.1));
  };
  F.quarters_minifridge = (x, y, w, h, f) => {   // rounded mini-fridge: lit top, chrome handle, magnets
    const r = RAMP.steel;
    shadow2(x + 2, y + h - 1, 8);
    for (const lx of [x + 2, x + 7]) {                          // stub feet
      px(lx, y + 10, 3, 2, LINE); px(lx, y + 10, 1, 2, r.lit); px(lx + 1, y + 10, 1, 2, r.dk);
    }
    underAO(x + 4, y + 10, 4, 1);
    // rounded body
    rr(x + 1, y - 3, 10, 13, LINE);
    px(x + 2, y - 2, 8, 11, U.shade(r.face, 0.12));
    px(x + 2, y, 1, 8, U.shade(r.face, 0.22)); px(x + 9, y, 1, 8, r.dk); // side facets
    px(x + 2, y + 8, 8, 1, r.ao);
    // lit rounded top with a soda can resting on it
    px(x + 2, y - 2, 8, 2, U.shade(r.top, 0.10));
    px(x + 2, y - 2, 8, 1, U.shade(r.sheen, 0.10));
    px(x + 6, y - 4, 2, 2, '#a83a32'); px(x + 6, y - 4, 1, 2, '#c86a5a'); px(x + 6, y - 4, 2, 1, '#8a98a8'); // can
    // door: freezer seam + rounded panel + chrome handle
    px(x + 2, y, 8, 1, U.shade(r.face, -0.25));                 // freezer seam
    rr(x + 3, y + 2, 6, 6, U.shade(r.face, 0.20));              // door panel
    px(x + 3, y + 2, 6, 1, U.shade(r.face, 0.32));
    px(x + 9, y + 1, 1, 6, '#9aa8b4'); px(x + 9, y + 1, 1, 1, '#c6cccb'); // chrome handle
    // magnets + running LED
    px(x + 4, y + 3, 1, 1, '#ffb84d'); px(x + 6, y + 5, 1, 1, '#5fb6a8');
    const lit = blink(2500);
    px(x + 4, y + 6, 1, 1, lit ? '#ffb84d' : '#36424c');
    if (lit) glow(x + 3, y + 5, 3, 3, '#ffb84d', 0.30);
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
  const D_MEM = 'CAPABILITY — gives the agent in this room long-term memory AND its skill library (a notebook it recalls facts from, and where it saves & reloads reusable skills).';

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
    // (id stays 'intake' — saves/routing keys never rename; INBOX is the user-facing word, mirroring OUTBOX)
    { id: "intake", label: "INBOX", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: false, desc: "INBOX — where OUTSIDE work (a DM, a routine) arrives on the floor and drops onto a belt. Orders you give in COMMS skip it — they land straight at the agent's BAY. You don't need one for an agent to work — a BAY alone is enough; the inbox is for watching outside work ride in." },
    { id: "bay", label: "BAY", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: false, desc: "BAY — the agent dock. Click it, assign an agent — done: work for that agent lands here, no belts required. Add belts to watch work ride in from an INBOX (and finished work ride out to an OUTBOX). The props in its room become its powers." },
    { id: "filter", label: "FILTER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "FILTER — sorts UNADDRESSED work by its content, sending each kind down a different belt lane. Work already bound to an agent rides straight home past it. Click it to set the routes." },
    { id: "merger", label: "MERGER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "MERGER — buffers K incoming boxes, then emits one combined box. A join / map-reduce barrier." },
    { id: "splitter", label: "SPLITTER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "SPLITTER — fans one work stream across its lanes to run several agents in parallel (load-balance)." },
    { id: "outbox", label: "OUTBOX", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: false, desc: "OUTBOX — the dispatch chute where an agent's finished reply leaves the station." },
    // NOTE: the old "CONVEYOR" palette prop (beltH) is retired — it was inert scenery that LOOKED like the
    // routing system and taught users the wrong model (you can't assign or route through it). Real belts are
    // laid with the BELT tool and compile into the RoutingPlan. F.beltH stays so stations that placed one
    // still render; it just can't be placed anew.
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
    { id: "studio", label: "STUDIO", cat: "capability", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: "CAPABILITY — gives the agent in this room a media studio (generate & analyze images). It glows magenta while an image renders." },
    // ISOLATION — seal a room off on the floor.
    { id: "airlock", label: "AIRLOCK", cat: "isolation", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "AIRLOCK — seals a room on the floor (a staging / merge gate); the agent's body can't path in or out. Click to cycle open / sealed / jammed." },
    // COMMAND — mission surfaces (functional-but-not-capability: they grant no tools; they make the
    // station's real state readable + clickable. The workstation-model rule: functional props that aren't
    // capability objects get their own category, never mixed into cosmetics).
    { id: "missionboard", label: "MISSION BOARD", cat: "command", tier: "functional", w: 3, h: 1, animated: true, blocks: false, desc: "MISSION BOARD — the quest log made physical. Every pinned card is a real open quest; click the board to read them. It suggests, never gates." },
    { id: "trophycase", label: "TROPHY CASE", cat: "command", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: "TROPHY CASE — the station's real achievements made permanent. Earned milestones, completed quests, and your living tools stand behind glass; click to open the case. It grants nothing — it remembers." },

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
  /* reconcile against a SUCCESSFUL /api/connectors poll: any tracked connector ABSENT from the live list was
     removed/unbound server-side, so DROP it — else its portal would keep glowing green off a stale last-known
     state until reload. Called ONLY on a good poll; a FAILED poll never clears (keep-last-known, E4/E6f). */
  function reconcileConnectors(liveIds) {
    const keep = new Set(liveIds || []);
    for (const id of Object.keys(connState)) if (!keep.has(id)) delete connState[id];
  }

  /* live WORKBENCH pulse (drives the workbench sprite). The world layer calls pulseWorkbench(ok) when a
     shell.exec / verify.result fires (ok=false => a verify FAILED, the bench flashes red). One global pulse —
     every placed workbench glows, signalling "the agent is running code right now." */
  // ROOM-SCOPED (T1 finding): a shell/verify pulse must glow only the ACTING agent's OWN workbench, not every
  // placed bench on the floor. The world layer resolves the target instance (capPropFor('workbench', agentId))
  // and passes its propId; keyed by propId so two agents' benches pulse independently. pulseWorkbench(ok) with
  // no id falls back to a GLOBAL pulse (back-compat: a single-bench floor / a caller that can't resolve a room).
  let wbFiredAt = 0, wbBad = false;                 // global fallback (no propId)
  const wbInst = {};                                // propId -> { at, bad } per-instance pulse
  function pulseWorkbench(ok, id) {
    if (id) { wbInst[id] = { at: now, bad: ok === false }; return; }
    wbFiredAt = now; wbBad = (ok === false);
  }
  // this workbench's pulse: its OWN instance pulse if it has one, else the global fallback (never both — an
  // instance that ever pulsed owns its glow and ignores the global, so a scoped pulse can't leak floor-wide).
  function workbenchFiredFor(id) {
    if (id && wbInst[id]) return { fired: Math.max(0, 1 - (now - wbInst[id].at) / PULSE_MS), bad: wbInst[id].bad };
    return { fired: wbFiredAt ? Math.max(0, 1 - (now - wbFiredAt) / PULSE_MS) : 0, bad: wbBad };
  }

  /* live JUKEBOX state (drives the jukebox sprite's dead-vs-live glow). Object=capability law: a placed
     jukebox grants the Spotify tools, but they're INERT until the user connects Spotify in Settings — so
     the sprite must read DEAD (dark, no bubble chase / no spinning disc / no lamps) when unconnected and
     only come alive (animated + gold floor glow) once /api/spotify/status reports connected:true. The
     world layer polls that endpoint and pushes the boolean here; the draw stays a pure function of it. */
  let jukeConnected = false;
  function setSpotifyConnected(on) { jukeConnected = !!on; }

  /* live CAPABILITY-PROP pulse (G0.1) — per placed INSTANCE, the connector/workbench idiom generalized:
     the world layer maps a firing tool to the prop that GRANTS it (fs->cabinet · web/browser->dish ·
     notebook/skill/recall/todo->notebook · image->studio · spotify->jukebox, via toolprops.js) and calls
     pulseProp(propId, capType); draw() overlays a bright surge in that capability's accent that decays
     1 -> 0 over PULSE_MS. Colors ride the station's semantic economy (amber=files, cyan=web/data,
     green=memory, magenta=media, gold=audio). */
  const CAP_GLOW = { cabinet: '#e8c860', dish: '#4ad9ff', notebook: '#41ff8a', studio: '#ff6ad5', jukebox: '#ffd34a' };
  const PROP_FAIL = '#ff5c5c';   // a DENIED/FAILED tool call — the workbench verify-red cue, generalized
  const propPulse = {};          // propId -> { at, cap, bad }
  // ok defaults true (the success surge). ok===false => a distinct RED failure cue (denied/errored tool call) —
  // TRUTH: a call that the gate denied or that errored never did the work, so it must NOT read as the green surge.
  function pulseProp(id, cap, ok) { if (!id) return; propPulse[id] = { at: now, cap: cap || '', bad: ok === false }; }

  // G2.3 — uncollected while-away work: the world layer feeds the ReturnStore's pending-crate count
  // here each frame; the OUTBOX sprite stacks that many banked-product crates (cap 5 + counter).
  let outboxCrates = 0;
  function setOutboxCrates(n) { outboxCrates = Math.max(0, n | 0); }

  // G1b — the MISSION BOARD's live readout: `pins` = how many quests are OPEN in the (visible) quest log,
  // `hot` = a station-gap fix-it quest is currently open (the board breathes gold). The world layer feeds
  // both from the real quest projection (throttled ~1s) — the sprite stays a pure function of its inputs.
  let missionPins = 0, missionHot = false, missionJam = false, missionProposals = 0;
  // G4 feature 2: `proposals` (4th arg) = pending autojob PROPOSAL cards the agent pinned to the board (a distinct
  // amber stub vs the quest pins + the jam stub). Optional so existing 3-arg callers are unaffected.
  function setMissionPins(open, hot, jam, proposals) { missionPins = Math.max(0, open | 0); missionHot = !!hot; missionJam = !!jam; missionProposals = Math.max(0, proposals | 0); }
  // G3b — the TROPHY CASE's live readout: how many trophies are EARNED (real completed quests + milestones).
  // The world layer feeds it from the trophy projection (throttled ~1s); the sprite stays a pure function.
  let trophyCount = 0;
  function setTrophyCount(n) { trophyCount = Math.max(0, n | 0); }
  function propFired(id) { const s = id && propPulse[id]; return (s && s.at) ? Math.max(0, 1 - (now - s.at) / PULSE_MS) : 0; }

  /* draw one prop. f = {t, x, y, w, h} in LOCAL tile coords; `work` lights its screens.
     `live` (G0.2/G0.3, optional) carries the seated agent's TRUTHFUL activity: { heat, prog } — heat
     is real token/tool flow (0..1, ~2s decay, world.js heatFor); prog is a real published task
     fraction or null (live harness runs have none). Only ever passed for a lit assigned workstation. */
  function draw(f, work, live) {
    const fn = F[f.t]; if (!fn) return;
    const X = f.x * TILE, Y = f.y * TILE, W = (f.w || 1) * TILE, H = (f.h || 1) * TILE;
    const o = { x: f.x, work: !!work, agentId: f.agentId || null, door: f.door || null };
    if (live) { o.heat = +live.heat || 0; o.prog = (live.prog == null) ? null : Math.max(0, Math.min(1, +live.prog || 0)); }
    if (f.t === 'connector_portal') {                 // a bound portal rides its connector's live state
      const cid = f.connectorId || null;
      o.bound = !!cid;
      o.state = cid ? ((connState[cid] && connState[cid].state) || 'offline') : 'unbound';
      o.fired = connectorFired(cid);
    }
    if (f.t === 'workbench') { const wf = workbenchFiredFor(f.id); o.fired = wf.fired; o.bad = wf.bad; }   // shell/verify pulse (room-scoped by propId)
    if (f.t === 'jukebox') o.live = jukeConnected;   // dead until Spotify is connected in Settings (object=capability truth)
    if (f.t === 'outbox') o.crates = outboxCrates;   // G2.3: uncollected while-away runs stack as crates
    if (f.t === 'missionboard') { o.pins = missionPins; o.hot = missionHot; o.jam = missionJam; o.proposals = missionProposals; }   // G1b/G1c: open quests pinned + the station-gap beacon + the routine-JAM amber stub; G4: pending autojob PROPOSAL cards
    if (f.t === 'trophycase') o.trophies = trophyCount;   // G3b: earned trophies stand behind glass (real completions only)
    fn(X, Y, W, H, o);
    // G0.3 ACTIVITY-HEAT WASH: real token/tool flow burns the working screens brighter + shimmers faster
    // (the monitors live in the prop's upper band); a stalled run cools back to the base work-glow in ~2s.
    if (o.work && o.heat > 0) {
      const hshim = 0.72 + 0.28 * Math.sin(now / (170 - 110 * o.heat));
      glow(X + 1, Y - 4, W - 2, Math.min(H + 4, 11), scr(o.x), (0.08 + 0.36 * o.heat) * hshim);
    }
    // G0.2 PROGRESS STRIP: drawn ONLY when a REAL fraction was published (the 'task' contract's
    // prog/dur) — a live harness run has no knowable % and never gets a bar (honesty law).
    if (o.work && o.prog != null) {
      const pw = Math.max(1, Math.round((W - 6) * o.prog));
      px(X + 2, Y - 6, W - 4, 3, '#06090c');            // strip housing above the crown
      px(X + 3, Y - 5, W - 6, 1, '#12251a');            // dark channel
      px(X + 3, Y - 5, pw, 1, '#62ff9e');               // the honest fraction
      glow(X + 3, Y - 6, pw, 3, '#62ff9e', 0.35);
    }
    // G0.1 TOOL-FIRE SURGE: this instance's tool just RESOLVED — a hot core wash + wider halo in the
    // capability accent, plus a charge bar draining shut across the crown. BOLD by design (the CRT-lab
    // law: effects read from across the room), gone in under a second. A DENIED/FAILED call surges RED
    // instead (the workbench verify-red cue) — a call the gate refused never did the work, so it must
    // never read as the green success surge (truthful-telemetry law).
    const pf = propFired(f.id);
    if (pf > 0) {
      const ps = propPulse[f.id];
      const acc = (ps && ps.bad) ? PROP_FAIL : (CAP_GLOW[(ps && ps.cap) || ''] || '#c7ffe0');
      glow(X - 1, Y - 3, W + 2, H + 4, acc, 0.10 + 0.32 * pf);               // outer halo
      glow(X + 1, Y - 1, Math.max(2, W - 2), Math.max(2, H - 2), acc, 0.28 * pf);   // hot core
      px(X, Y - 3, Math.max(1, Math.round(W * pf)), 1, acc);                 // draining charge bar
    }
  }

  return {
    setCtx(c) { ctx = c; },
    setNow(t) { now = t; },
    draw, CATALOG, CATS, spec, has, TILE,
    // live connector state (the world layer feeds these; the connector_portal sprite reads them)
    setConnectorState, pulseConnector,
    // workbench pulse (the world layer feeds this off shell.exec / verify.result)
    pulseWorkbench,
    // connector reconcile: drop portals absent from a successful /api/connectors poll (stale-green fix)
    reconcileConnectors,
    // JUKEBOX live state (the world layer feeds this off /api/spotify/status — dead-vs-live glow)
    setSpotifyConnected,
    // per-instance capability-prop pulse (G0.1 — the world layer feeds this off agent.tool_call via toolprops.js)
    pulseProp,
    // G2.3 uncollected-crate stack on the OUTBOX (the world layer feeds this from ReturnStore.pendingCount)
    setOutboxCrates,
    // G1b MISSION BOARD pins + station-gap beacon (the world layer feeds these from the live quest projection)
    setMissionPins,
    // G3b TROPHY CASE earned-trophy count (the world layer feeds this from the live trophy projection)
    setTrophyCount,
    // exposed for tests / reuse
    _F: F,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PropSprites;
