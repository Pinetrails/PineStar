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
  /* MOUNT GEOMETRY — how far above the floor line every table's top plane sits. A prop whose catalog
     row says mount:'surface' is drawn shifted up by exactly this, which is why all tables MUST agree
     on it (see the TABLES section). One constant, no per-table lookup. */
  const SURFACE_RISE = 8;
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
      // `>>>`, not `>>`: U.hash returns a UINT32, and the signed shift makes any hash >= 2^31 negative.
      // JS `%` keeps that sign, so ~2/3 of specks landed ABOVE the rect instead of inside it — visible
      // as stray pixels floating off a prop's top edge. Ported from v7 with the bug; caught 2026-07-24.
      px(x + 1 + (hx % (w - 2)), y + 1 + ((hx >>> 5) % (h - 2)), 1 + (hx % 2), 1, c);
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

  /* ============ v4 MATERIAL KIT (2026-07-24) ============
     v3 locked PROJECTION and SILHOUETTE and is NOT reopened here. v4 only fixes what v3 left flat —
     MATERIAL and LIGHT — so footprints, the oblique law, and the bolted-to-deck language all stand:
       (1) TWO-TONE LIGHT. A prop lit by one white lamp reads flat no matter how many tones its ramp
           has. Real metal takes a WARM key off the station's ceiling strips (high + west) on its lit
           edges and a COOL sky bounce on its shade edges. keyEdge/rimEdge are 1px washes that add
           that split on top of the existing ramp instead of replacing it.
       (2) FALLOFF EMISSIVES. glow() stamps one flat alpha rect, which reads as a translucent sticker.
           bloom() lays 3 nested rings so light actually falls off, and spill() runs light DOWN a
           surface from an emitter above it (a screen pooling onto a tabletop).
       (3) BOLDER SILHOUETTE. rr() cuts 1px corners — at 12px tiles that still reads as a lozenge.
           chamf() cuts k px (default 2) so a body can be genuinely chamfered, and cable() hangs a
           real sagging line, which is the cheapest way to break a boxy outline. */
  const KEY = '#ffe0b0';                         // warm key — the station's ceiling strips, west-biased
  const SKY = '#7fb4d8';                         // cool sky bounce — fills the shade side
  const keyEdge = (x, y, w, h, a) => { ctx.globalAlpha = a == null ? 0.22 : a; px(x, y, w, h, KEY); ctx.globalAlpha = 1; };
  const rimEdge = (x, y, w, h, a) => { ctx.globalAlpha = a == null ? 0.24 : a; px(x, y, w, h, SKY); ctx.globalAlpha = 1; };
  const bloom = (x, y, w, h, c, a) => {          // emissive with 3-ring falloff (vs glow's flat rect)
    ctx.globalAlpha = a * 0.28; px(x - 2, y - 2, w + 4, h + 4, c);
    ctx.globalAlpha = a * 0.55; px(x - 1, y - 1, w + 2, h + 2, c);
    ctx.globalAlpha = a;        px(x, y, w, h, c);
    ctx.globalAlpha = 1;
  };
  const spill = (x, y, w, c, a, n) => {          // light pooling DOWN a surface from an emitter above
    n = n || 4;
    for (let i = 0; i < n; i++) {
      const t = 1 - i / n;
      ctx.globalAlpha = a * t * t;
      px(x + i, y + i, w - i * 2, 1, c);
    }
    ctx.globalAlpha = 1;
  };
  const chamf = (x, y, w, h, c, k) => {          // chamfered rect — k px corner cuts (k=2 default)
    k = k == null ? 2 : k;
    for (let j = 0; j < h; j++) {
      const d = Math.min(j, h - 1 - j), i = d < k ? k - d : 0;
      if (w - i * 2 > 0) px(x + i, y + j, w - i * 2, 1, c);
    }
  };
  const cable = (x0, y0, x1, y1, sag, c) => {    // limp sagging cable — breaks a boxy silhouette
    const n = Math.max(2, Math.abs(x1 - x0) + Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      px(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * (sag || 0)), 1, 1, c || '#0b1114');
    }
  };
  const knurl = (x, y, w, h, c) => {             // machined grip texture on a dial / handle
    for (let i = 0; i < w; i += 2) px(x + i, y, 1, h, U.shade(c, -0.32));
  };
  const dial = (x, y, c, ang) => {               // 3x3 control knob with a pointer mark
    px(x, y, 3, 3, LINE); px(x, y, 3, 1, U.shade(c, 0.20)); px(x + 1, y + 1, 1, 1, U.shade(c, -0.32));
    const dx = Math.round(Math.cos(ang)), dy = Math.round(Math.sin(ang));
    px(x + 1 + dx, y + 1 + dy, 1, 1, U.shade(c, 0.44));   // a soft catch, not a white speck (reads as noise)
  };
  const codeRow = (x, y, wmax, seed, c, hot) => {  // one scrolling line of code on a screen
    const k = (seed + Math.floor(now / 380)) % 6;
    const lw = [7, 4, 9, 3, 6, 5][k], ind = [0, 1, 0, 2, 1, 0][k];
    px(x + ind, y, Math.min(lw, wmax - ind), 1, c);
    if (k === 2 || k === 4) px(x + ind, y, 2, 1, hot);   // a keyword token, brighter
  };

  /* ============ FURNITURE (ported verbatim from v7 sprites.js) ============ */
  const F = {};

  F.bigscreen = (x, y, w, h, f) => {
    // BIG SCREEN (8x1) — v4 rebuild. At 96px this is the widest prop in the game, so it cannot be a
    // scaled-up monitor: it gets the structure a real hall display has — pylon mounts with a cross-tie,
    // a stepped bezel with genuine recess depth, and CONTENT WITH HIERARCHY (header band / left table /
    // centre plot / right tile column) instead of uniform noise. Idle keeps phosphor; f.work drives gain.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const py = y - 12, pH = 18;                                  // panel rides y-12..y+5, pylons carry it down
    const dc = (c, k) => U.shade(c, on ? 0 : (k == null ? -0.5 : k));   // idle dims content, never kills it
    shadow2(x + 6, y + h - 1, w - 12);
    // TWO PYLONS + A CROSS-TIE. Without the tie a 96px panel reads as balanced on two loose sticks.
    for (const mx of [x + 14, x + w - 22]) {
      px(mx - 1, y + 4, 10, 8, LINE);
      px(mx, y + 5, 8, 6, r.face);
      px(mx, y + 5, 8, 1, r.lit); keyEdge(mx + 1, y + 5, 5, 1, 0.16);
      px(mx, y + 5, 1, 6, U.shade(r.face, 0.08)); px(mx + 7, y + 5, 1, 6, r.dk);
      rimEdge(mx + 7, y + 5, 1, 6, 0.20);
      px(mx + 3, y + 5, 2, 6, r.ao);                             // cable channel routed up the pylon
      chamf(mx - 4, y + h - 4, 16, 4, LINE, 1);                  // splayed base shoe
      px(mx - 3, y + h - 3, 14, 2, r.face); px(mx - 3, y + h - 3, 14, 1, r.lit);
      px(mx - 3, y + h - 1, 14, 1, r.ao);
      ctx.globalAlpha = 0.30; px(mx - 4, y + h, 16, 1, '#000'); ctx.globalAlpha = 1;
    }
    px(x + 22, y + 7, w - 44, 2, LINE);
    px(x + 22, y + 8, w - 44, 1, U.shade(r.face, 0.06));         // cross-tie between the pylons
    cable(x + 17, y + 6, x + 13, y + h - 4, 2.6);                // feed lead sagging down the west pylon
    // HEAVY CHAMFERED CARCASS — 3px cuts, big enough to read as machined at this width
    chamf(x - 1, py - 1, w + 2, pH + 2, LINE, 3);
    chamf(x, py, w, pH, r.face, 3);
    px(x + 3, py, w - 6, 1, r.top); keyEdge(x + 3, py, 12, 1, 0.20);   // warm ceiling strip along the crown
    px(x, py + 3, 1, pH - 6, r.lit); px(x + w - 1, py + 3, 1, pH - 6, r.dk);
    rimEdge(x + w - 1, py + 3, 1, pH - 6, 0.22);                 // cool sky bounce down the shade flank
    px(x + 3, py + pH - 1, w - 6, 1, r.ao);
    wear(x + 2, py + 1, w - 4, pH - 2, 5, U.shade(r.face, -0.10));
    for (const sxx of [x + 3, x + w - 4]) { px(sxx, py + 1, 1, 1, U.shade(r.top, 0.30)); px(sxx, py + pH - 2, 1, 1, r.ao); }
    // STEPPED BEZEL: an intermediate face set back from the carcass, then the glass well cut into it.
    // Two steps is what sells depth on a big panel; one step reads as a sticker on a plate.
    px(x + 2, py + 2, w - 4, pH - 5, U.shade(r.face, -0.30));
    px(x + 2, py + 2, w - 4, 1, U.shade(r.face, -0.55));         // the step's top face lies in its own shadow
    px(x + 2, py + pH - 4, w - 4, 1, U.shade(r.face, 0.10));
    const gx = x + 4, gy = py + 4, gw = w - 8, gh = pH - 9;      // 88 x 9 of actual glass
    px(gx - 1, gy - 1, gw + 2, gh + 2, '#050a08');
    px(gx, gy, gw, gh, on ? '#08171c' : '#071012');              // glass ground — never dead black
    // --- HEADER BAND: a title block of word-shapes + a right-hand lamp cluster ---
    px(gx, gy, gw, 2, on ? '#0b2630' : '#08181e');
    let tw = gx + 2;
    for (const k of [5, 3, 7, 4]) { px(tw, gy, k, 1, dc(ACC.data, -0.55)); tw += k + 2; }   // "STATION FEED"
    px(gx + 2, gy + 1, 22, 1, dc(U.shade(ACC.data, -0.45), -0.6));  // subtitle rule under the title
    for (let i = 0; i < 3; i++)
      px(gx + gw - 8 + i * 3, gy, 2, 1, blink(700 + i * 210, i + ph) ? dc(i === 2 ? ACC.flow : ACC.work, -0.5) : '#123028');
    px(gx, gy + 2, gw, 1, '#0a1c1f');                            // rule separating header from the body
    // --- LEFT TABLE: five rows of bar-value pairs. Reads as a manifest, not as noise. ---
    const lx = gx + 2, ly = gy + 4;
    for (let i = 0; i < 5; i++) {
      const v = 4 + ((U.hash('bs' + i) + Math.floor(now / 900 + i)) % 12);
      px(lx, ly + i, 4, 1, dc(U.shade(ACC.data, -0.5), -0.6));   // row label stub
      px(lx + 5, ly + i, v, 1, dc(i === 2 ? ACC.flow : ACC.work, -0.58));
    }
    px(lx - 1, ly - 1, 20, 1, '#12262a');                        // table header rule
    // --- CENTRE PLOT: graticule, baseline, twin trace (dim echo behind the live one), hot pixel ---
    const cx0 = gx + 24, cw0 = 44, cy0 = gy + 3, ch0 = gh - 3, mid = cy0 + (ch0 >> 1);
    px(cx0, cy0, cw0, ch0, on ? '#061a17' : '#06120f');
    for (let i = 0; i <= cw0; i += 11) px(cx0 + i, cy0, 1, ch0, '#0e2a26');
    for (let j = 0; j < ch0; j += 3) px(cx0, cy0 + j, cw0, 1, '#0c2320');
    px(cx0, mid, cw0, 1, '#154034');                             // baseline
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = on ? '#1d5a63' : '#123338'; ctx.beginPath();
    for (let i = 0; i < cw0; i++) {                              // dim echo pass, one beat behind
      const yy = mid + Math.sin(now / 300 + i * 0.30 + 1.4 + ph) * (on ? 2.6 : 1.4);
      i ? ctx.lineTo(cx0 + i, yy) : ctx.moveTo(cx0 + i, yy);
    }
    ctx.stroke();
    ctx.strokeStyle = on ? ACC.data : U.shade(ACC.data, -0.55); ctx.beginPath();
    for (let i = 0; i < cw0; i++) {
      const yy = mid + Math.sin(now / 300 + i * 0.30 + ph) * (on ? 3.0 : 1.6);
      i ? ctx.lineTo(cx0 + i, yy) : ctx.moveTo(cx0 + i, yy);
    }
    ctx.stroke();
    ctx.restore();
    const hp = Math.floor((now / 30) % cw0);                     // hot pixel riding the live trace (kept beat)
    px(cx0 + hp, mid + Math.round(Math.sin(now / 300 + hp * 0.30 + ph) * (on ? 3.0 : 1.6)), 1, 1, on ? '#dffaff' : '#3a6a72');
    // --- RIGHT COLUMN: three stacked readout tiles, each a labelled fill gauge ---
    const rx0 = gx + gw - 18;
    for (let i = 0; i < 3; i++) {
      const ty = gy + 3 + i * 2;
      px(rx0, ty, 18, 1, '#0d2126');
      px(rx0, ty, 3, 1, dc(U.shade(ACC.data, -0.35), -0.6));     // tile label
      const fw = 3 + Math.floor((1 + Math.sin(now / 640 + i * 1.7 + ph)) * (on ? 5.4 : 2.2));
      px(rx0 + 4, ty, fw, 1, dc(i === 1 ? ACC.flow : ACC.work, -0.6));
      px(rx0 + 4 + fw, ty, 1, 1, on ? '#dffaff' : '#20423a');    // gauge head
    }
    px(rx0 - 1, gy + 3, 1, gh - 3, '#12262a');                   // column divider
    // glass finish: scanlines, a drifting refresh band, then falloff bloom over the whole lit area
    scanl(gx, gy, gw, gh, on ? 0.12 : 0.20);
    glow(gx + Math.floor((now / 45) % (gw - 6)), gy, 5, gh, '#dfffe8', on ? 0.06 : 0.03);
    bloom(gx, gy, gw, gh, ACC.data, on ? 0.11 + 0.03 * Math.sin(now / 800) : 0.05);
    px(gx + 1, gy + 1, 6, 1, '#123a42'); px(gx + 1, gy + 2, 3, 1, '#0e2d34'); // ceiling reflection in the glass
    // the panel throws light DOWN its own frame and onto the pylons — the reason it's the room's key
    spill(x + 4, py + pH, w - 8, ACC.data, on ? 0.20 : 0.09, 6);
    for (let i = 0; i < 5; i++)                                  // status row on the frame's bottom rail
      px(x + 8 + i * 9, py + pH - 3, 4, 1, blink(900, i + ph) ? dc(ACC.flow, -0.55) : '#2c3a32');
    for (let i = 0; i < 9; i++) px(x + w - 34 + i * 3, py + pH - 3, 2, 1, '#0c1410'); // exhaust slits, east end
  };

  F.consoleL = (x, y, w, h, f) => {   // v4 long ops console (3x1) — 3-seat slab under a HOODED wall of screens
    const r = RAMP.gun, ph = (f && f.x) || 0, on = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);
    for (const lx of [x + 2, x + (w >> 1) - 1, x + w - 5]) {    // three legs across the long span
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // trapezoid front face, wider south (kept from v3), deeply vented
    rr(x - 2, y + 5, w + 4, 5, LINE);
    px(x - 1, y + 6, w + 2, 3, r.face);
    px(x - 1, y + 6, w + 2, 1, r.lit); keyEdge(x, y + 6, w, 1, 0.14);
    for (let i = 0; i < 7; i++) { px(x + 3 + i * 5, y + 7, 3, 1, r.ao); px(x + 3 + i * 5, y + 7, 1, 1, U.shade(r.face, -0.5)); }
    px(x - 1, y + 8, w + 2, 1, r.ao);
    // the long slab
    chamf(x - 1, y - 4, w + 2, 11, LINE, 2);
    chamf(x, y - 3, w, 9, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 10, 1, 0.26);
    px(x, y - 1, 1, 5, r.lit); px(x + w - 1, y - 1, 1, 5, r.dk); rimEdge(x + w - 1, y - 1, 1, 5, 0.20);
    px(x + 2, y + 5, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 2, y - 2, w - 4, 7, 5, U.shade(r.top, -0.10));
    // END POSTS carry the hood down into the slab — without them the wall floats as a second object
    for (const pxx of [x + 3, x + w - 5]) {
      px(pxx - 1, y - 11, 4, 9, LINE);
      px(pxx, y - 11, 1, 8, r.lit); px(pxx + 1, y - 11, 1, 8, r.dk);
      rimEdge(pxx + 1, y - 9, 1, 5, 0.18);
    }
    // WALL OF SCREENS: three panes spanning the whole 3-tile run. The pilot console's readout is a small
    // raised box; the long console's whole point is horizon-wide readout AREA, so that is what it gets.
    const wx = x + 5, wy = y - 11, ww = w - 10, wh = 6, pw = Math.floor((ww - 2) / 3);
    px(wx - 1, wy - 1, ww + 2, wh + 2, LINE);
    px(wx, wy, ww, wh, '#0a1310');
    for (let p = 0; p < 3; p++) {
      const gx = wx + p * (pw + 1), sc = scr(p + ph);
      px(gx, wy, pw, wh, on ? U.shade(sc, -0.78) : '#0d1a14');  // idle keeps phosphor, not a hole
      if (p === 0) {                                            // pane 1 — scrolling code
        for (let j = 0; j < wh - 1; j++)
          codeRow(gx + 1, wy + j, pw - 2, j * 2 + Math.floor(ph), on ? sc : '#2c4a38', on ? '#eaffe8' : '#3d6a50');
      } else if (p === 1) {                                     // pane 2 — station telemetry histogram
        for (let i = 0; i < pw - 2; i++) {
          const v = 1 + Math.floor((1 + Math.sin(now / 240 + i * 0.8 + ph)) * (on ? 1.6 : 0.7));
          px(gx + 1 + i, wy + wh - 1 - v, 1, v, on ? ACC.work : U.shade(ACC.work, -0.6));
        }
        px(gx + 1, wy + wh - 1, pw - 2, 1, on ? U.shade(ACC.work, -0.35) : '#1a2c22');
      } else {                                                  // pane 3 — sector map with a sweeping column
        for (let i = 1; i < pw - 1; i += 2) for (let j = 1; j < wh - 1; j += 2)
          px(gx + i, wy + j, 1, 1, on ? U.shade(ACC.data, -0.4) : '#183038');
        const sw = 1 + Math.floor((now / 220) % (pw - 2));
        px(gx + sw, wy, 1, wh, on ? ACC.data : U.shade(ACC.data, -0.55));
      }
      if (p < 2) px(gx + pw, wy, 1, wh, '#05100c');             // mullion between panes
    }
    scanl(wx, wy, ww, wh, on ? 0.18 : 0.26);
    if (on) { bloom(wx, wy, ww, wh, ACC.work, 0.11); spill(wx, wy + wh, ww, ACC.work, 0.15, 4); }
    else px(wx + ww - 2, wy + wh - 2, 1, 1, blink(1600, ph) ? '#ff9d2e' : '#33241a'); // standby amber
    // HOOD / brow over the wall — the silhouette that names this prop from across the room
    chamf(x + 1, y - 14, w - 2, 4, LINE, 2);
    chamf(x + 2, y - 13, w - 4, 2, r.top, 2);
    px(x + 4, y - 13, w - 8, 1, r.sheen); keyEdge(x + 4, y - 13, 10, 1, 0.28);
    px(x + 3, y - 12, w - 6, 1, r.ao);                          // hood underside AO onto the wall
    for (let i = 0; i < 4; i++) {                               // hood downlights washing the working slab
      const lx = x + 6 + i * ((w - 12) / 3 | 0);
      px(lx, y - 12, 2, 1, on ? '#ffe6b8' : '#3b332a');
      if (on) { bloom(lx, y - 12, 2, 1, KEY, 0.20); spill(lx - 2, y - 3, 6, KEY, 0.10, 3); }
    }
    // THREE operator stations on the slab — this is a 3-seat console, and the top says so
    for (let s = 0; s < 3; s++) {
      const sx = x + 2 + s * 12;
      chamf(sx, y + 1, 9, 4, U.shade(r.top, -0.30), 1);         // keyboard well
      px(sx + 1, y + 2, 7, 1, U.shade(r.face, 0.12)); px(sx + 1, y + 3, 7, 1, U.shade(r.face, -0.04));
      for (let i = 0; i < 7; i += 2) px(sx + 1 + i, y + 2, 1, 1, U.shade(r.face, 0.26));
      dial(sx + 10, y + 1, r.top, now / (820 + s * 130) + ph + s);
      px(sx + 10, y - 2, 1, 1, blink(600 + s * 190, s) ? (s === 2 ? ACC.flow : ACC.work) : '#16241c'); // seat LED
    }
    knurl(x + 4, y + 4, w - 8, 1, r.top);                       // machined grip strip along the front edge
    px(x + 4, y + 4, 8, 1, blink(800) ? ACC.flow : U.shade(ACC.flow, -0.5)); // amber status ribbon (kept)
  };

  F.holotable = (x, y, w, h, f) => {
    // HOLOTABLE (4x2) — v4. The other props in this family are LIT SURFACES; this one is a lit VOLUME, so
    // the differentiator is a real emitter ring in the well and a visible projection cone carrying light up
    // to a station hologram floating above the slab. Cyan lives in the light only; the table stays steel.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const g0 = on ? 1 : 0.55;                                      // idle still projects, just weaker
    shadow2(x + 3, y + h - 1, w - 6);
    // fluted central plinth — a column, not a block, so the slab reads as floating on one stem
    chamf(x + 7, y + h - 8, w - 14, 8, LINE, 2);
    px(x + 8, y + h - 7, w - 16, 5, r.face);
    px(x + 8, y + h - 7, w - 16, 1, r.lit); keyEdge(x + 9, y + h - 7, 8, 1, 0.16);
    for (let i = 0; i < 5; i++) px(x + 11 + i * 5, y + h - 6, 1, 4, r.ao);   // flutes
    px(x + 8, y + h - 7, 1, 5, U.shade(r.face, 0.08)); px(x + w - 9, y + h - 7, 1, 5, r.dk);
    rimEdge(x + w - 9, y + h - 7, 1, 5, 0.20);
    px(x + 8, y + h - 3, w - 16, 1, r.ao);
    underAO(x + 4, y + h - 9, w - 8, 2);                           // dark gap under the overhanging slab
    // short south face of the slab, with the control strip recessed into it
    chamf(x - 1, y + h - 13, w + 2, 6, LINE, 2);
    px(x, y + h - 12, w, 4, r.face);
    px(x, y + h - 12, w, 1, r.lit); keyEdge(x + 2, y + h - 12, 12, 1, 0.15);
    px(x, y + h - 11, 1, 3, U.shade(r.face, 0.08)); px(x + w - 1, y + h - 11, 1, 3, r.dk);
    rimEdge(x + w - 1, y + h - 11, 1, 3, 0.20);
    px(x, y + h - 9, w, 1, r.ao);
    inset(x + 5, y + h - 11, 10, 2, '#0a1a20');                    // control strip (kept beat)
    for (let i = 0; i < 3; i++)
      px(x + 6 + i * 3, y + h - 10, 1, 1, blink(500, i + ph) ? ACC.data : '#1d4a5a');
    knurl(x + w - 14, y + h - 10, 9, 1, r.face);                   // machined grip along the near edge
    // the big top surface dominates (top-bias oblique)
    chamf(x - 1, y, w + 2, h - 11, LINE, 2);
    chamf(x, y + 1, w, h - 13, r.top, 2);
    px(x + 2, y + 1, w - 4, 1, r.sheen); keyEdge(x + 2, y + 1, 10, 1, 0.28);
    px(x, y + 3, 1, h - 17, r.lit); px(x + w - 1, y + 3, 1, h - 17, r.dk);
    rimEdge(x + w - 1, y + 3, 1, h - 17, 0.20);
    px(x + 2, y + h - 13, w - 4, 1, U.shade(r.top, -0.18));        // front lip of the top
    wear(x + 1, y + 2, w - 2, h - 15, 3, U.shade(r.top, -0.08));
    // PROJECTION WELL sunk into the slab, ringed by real emitter studs
    const wx = x + 4, wy = y + 3, ww = w - 8, wh = h - 17;
    inset(wx, wy, ww, wh, '#081820');
    px(wx + 1, wy + 1, ww - 2, wh - 2, '#0a1e26');
    for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++)        // floor dot grid inside the well
      px(wx + 4 + i * 8, wy + 2 + j * 3, 1, 1, '#12333f');
    px(wx + 2, wy + 3, ww - 4, 1, '#123642'); px(wx + (ww >> 1), wy + 1, 1, wh - 2, '#123642'); // cross axes
    const rim = (0.30 + 0.18 * Math.sin(now / 600 + ph)) * g0;
    bloom(wx + 1, wy, ww - 2, 1, ACC.data, rim);                   // ring emitters, with falloff
    bloom(wx + 1, wy + wh - 1, ww - 2, 1, ACC.data, rim);
    bloom(wx, wy + 1, 1, wh - 2, ACC.data, rim * 0.8);
    bloom(wx + ww - 1, wy + 1, 1, wh - 2, ACC.data, rim * 0.8);
    for (const [ex, ey] of [[wx + 1, wy + 1], [wx + ww - 3, wy + 1], [wx + 1, wy + wh - 2], [wx + ww - 3, wy + wh - 2]])
      px(ex, ey, 2, 1, blink(600, ex + ey + ph) ? '#cdf4ff' : '#1d4a5a');   // corner studs (kept blink)
    spill(wx - 2, y + h - 13, ww + 4, ACC.data, 0.16 * g0, 4);     // well light pooling onto the near face
    // VOLUMETRIC CONE from the well up to the hologram — this is what makes it a volume, not a screen
    const hcx = x + (w >> 1), hcy = y - 5;
    ctx.save();
    ctx.globalAlpha = (0.09 + 0.04 * Math.sin(now / 260 + ph)) * g0; ctx.fillStyle = ACC.data;
    ctx.beginPath(); ctx.moveTo(wx + 4, wy + 1); ctx.lineTo(hcx - 9, hcy + 1);
    ctx.lineTo(hcx + 9, hcy + 1); ctx.lineTo(wx + ww - 4, wy + 1); ctx.closePath(); ctx.fill();
    ctx.restore();
    // the hologram itself: a station core with wings, an orbit ring and one blip running it
    const gA = (0.42 + 0.24 * Math.sin(now / 400 + ph)) * g0;
    ctx.globalAlpha = gA;
    px(hcx - 8, hcy - 1, 16, 2, ACC.data);                         // main ring/hull bar
    px(hcx - 1, hcy - 6, 2, 12, ACC.data);                         // spine
    px(hcx - 5, hcy - 5, 10, 1, '#9aeaff');                        // upper deck, brighter
    px(hcx - 4, hcy + 5, 8, 1, U.shade(ACC.data, -0.2));           // lower deck in the cone's shadow
    px(hcx - 9, hcy - 1, 1, 1, '#cdf4ff'); px(hcx + 8, hcy - 1, 1, 1, '#cdf4ff');  // wing tips
    ctx.globalAlpha = gA * 0.4;
    ctx.strokeStyle = ACC.data; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(hcx, hcy, 10.5, 4.5, 0, 0, 6.2832); ctx.stroke();
    ctx.globalAlpha = 1;
    const oa = now / 700 + ph;
    px(hcx - 1 + Math.round(Math.cos(oa) * 10), hcy + Math.round(Math.sin(oa) * 4), 1, 1, '#dffaff');
    for (let k = 0; k < 3; k++) {                                  // interference rows sliding up the volume
      const sy = hcy - 6 + Math.floor(((now / 420 + k * 4) % 13));
      glow(hcx - 8, sy, 16, 1, '#cdf4ff', 0.10 * g0);
    }
    bloom(hcx - 8, hcy - 5, 16, 11, ACC.data, (0.05 + 0.03 * Math.sin(now / 400 + ph)) * g0);  // volume haze
  };

  F.screens = (x, y, w, h, f) => {
    // SCREENS (2x1) — v4. Was three identical cells in a row, which is the exact uniformity trap this
    // family has to dodge. Now a real CLUSTER on one column: a wide status head up top, two heads hanging
    // off a crossbar below, each showing a DIFFERENT kind of content. One unit still runs diagnostics.
    // ANCHOR: the cast column runs UNBROKEN from the crossbar into the base plate, and the pair of lower
    // heads hangs low enough to sit in the placed tile — the sweep left a 1px stem and a 7px air gap
    // between the column foot and the base, so the whole cluster floated a tile north of its own footprint.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const g0 = on ? 1 : 0.6;
    shadow2(x + 4, y + h - 1, w - 8);
    // cast base + single column: one stem reads cleaner than two posts at 24px, and separates this
    // prop from the rolling-post props elsewhere in the family
    chamf(x + 4, y + h - 5, w - 8, 5, LINE, 2);
    px(x + 5, y + h - 4, w - 10, 3, r.face);
    px(x + 5, y + h - 4, w - 10, 1, r.lit); keyEdge(x + 6, y + h - 4, 6, 1, 0.16);
    px(x + 5, y + h - 2, w - 10, 1, r.ao);
    px(x + 9, y - 8, 6, h + 7, LINE);                            // cast column, crossbar -> base, real width
    px(x + 10, y - 8, 4, h + 6, r.face);
    px(x + 10, y - 8, 1, h + 6, r.lit); px(x + 13, y - 8, 1, h + 6, r.dk);
    rimEdge(x + 13, y - 6, 1, h + 2, 0.18);
    px(x + 10, y + h - 5, 4, 1, U.shade(r.face, -0.32));         // cast seam where the neck enters the foot
    cable(x + 14, y - 6, x + 17, y + h - 3, 2.2);                // loom sagging down the shade side
    px(x + 3, y - 8, w - 6, 2, LINE);                            // crossbar the lower heads hang from
    px(x + 4, y - 8, w - 8, 1, U.shade(r.face, 0.10)); keyEdge(x + 4, y - 8, 6, 1, 0.18);
    // one shared head routine: chamfered bezel, recessed glass, falloff bloom, light spilling below it
    const head = (hx, hy, hw, hh, kind, idx) => {
      const dead = (U.hash('scr' + x + idx) % 7) === 0;           // kept: one unit runs diagnostics
      chamf(hx - 1, hy - 1, hw + 2, hh + 2, LINE, 1);
      chamf(hx, hy, hw, hh, '#161d1a', 1);
      px(hx + 1, hy, hw - 2, 1, '#2c3b33'); keyEdge(hx + 1, hy, 4, 1, 0.24);
      px(hx, hy + 1, 1, hh - 2, '#20302a'); px(hx + hw - 1, hy + 1, 1, hh - 2, '#0d1512');
      rimEdge(hx + hw - 1, hy + 1, 1, hh - 2, 0.20);
      const sx = hx + 1, sy = hy + 1, sw = hw - 2, sh = hh - 2;
      inset(hx, hy, hw, hh, '#07120f');
      px(sx, sy, sw, sh, dead ? '#0d1a16' : (on ? '#08191c' : '#071113'));
      const acc = dead ? '#3a5a50' : (kind === 0 ? ACC.work : ACC.data);
      if (dead) {                                                 // static snow — a unit that lost its feed
        for (let k = 0; k < 6; k++)
          px(sx + (U.hash('st' + idx + k + Math.floor(now / 150)) % sw),
             sy + (U.hash('su' + idx + k + Math.floor(now / 150)) % sh), 1, 1, '#3a5a50');
        px(sx, sy + sh - 1, sw, 1, '#16241f');
      } else if (kind === 0) {                                    // code column
        for (let j = 0; j < sh; j++) codeRow(sx, sy + j, sw, j * 2 + idx + Math.floor(ph), U.shade(acc, on ? 0 : -0.5), on ? '#eaffe8' : '#2c4a38');
        px(sx + (Math.floor(now / 300) % (sw - 1)), sy + sh - 1, 1, 1, blink(400, ph) ? '#eaffe8' : U.shade(acc, -0.6));
      } else if (kind === 1) {                                    // bar histogram
        for (let i = 0; i < sw; i += 2) {
          const v = 1 + Math.floor((1 + Math.sin(now / 300 + i * 0.8 + idx + ph)) * (on ? 1.4 : 0.6));
          px(sx + i, sy + sh - v, 1, v, U.shade(acc, on ? 0 : -0.5));
        }
        px(sx, sy + sh - 1, sw, 1, U.shade(acc, -0.55));          // baseline
      } else {                                                    // wide status trace + lamp row
        px(sx, sy, sw, 1, U.shade(acc, on ? -0.2 : -0.62));       // header rule
        for (let i = 0; i < sw; i++)
          px(sx + i, sy + 2 - Math.round(Math.max(0, Math.sin(now / 200 + i * 0.55 + ph))), 1, 1, U.shade(acc, on ? 0 : -0.5));
        for (let i = 0; i < 4; i++)
          px(sx + 1 + i * 3, sy + sh - 1, 2, 1, blink(800, i + ph) ? U.shade(on ? ACC.flow : ACC.flow, on ? 0 : -0.5) : '#2c3a32');
      }
      scanl(sx, sy, sw, sh, on ? 0.16 : 0.24);
      bloom(sx, sy, sw, sh, acc, (dead ? 0.07 : 0.15) * g0);
      spill(hx, hy + hh + 1, hw, acc, 0.14 * g0, 3);              // each head lights what's under it
      px(hx + hw - 2, hy + hh - 1, 1, 1, blink(900, idx + ph) ? (on ? '#2ee6c8' : '#1d6a5c') : '#143028'); // bezel LED
    };
    head(x + 5, y - 14, 14, 6, 2, 2);                             // wide status head crowning the column
    head(x, y - 1, 11, 6, 0, 0);                                  // code head, west — hangs INSIDE the tile
    head(x + 13, y - 1, 11, 6, 1, 1);                             // chart head, east
    px(x + 9, y - 9, 6, 1, U.shade(r.face, -0.35));               // yoke pad under the top head
    px(x + 8, y + 6, 8, 1, LINE); px(x + 9, y + 6, 6, 1, U.shade(r.face, 0.08));   // clamp yoke: pair -> column
  };

  F.tank = (x, y, w, h, f) => {
    // TANK (2x1) — v4. The one prop in this family that is NOT a display: its light comes from a lamp
    // under the rim shining DOWN THROUGH water, so it gets caustics, a bright surface line and a cool
    // spill onto the stand — never scanlines. Curved glass: the end columns pinch, so it reads cylindrical.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const gTop = y - 7, gBot = y + 8, gh = gBot - gTop;             // glass body
    const aqua = '#7adfd0';
    shadow2(x + 1, y + h - 1, w - 2);
    // low stand with feet + the pump housing on the east end
    chamf(x, y + 8, w, 4, LINE, 1);
    px(x + 1, y + 9, w - 2, 2, r.face);
    px(x + 1, y + 9, w - 2, 1, r.lit); keyEdge(x + 2, y + 9, 7, 1, 0.16);
    px(x + 1, y + 11, 3, 1, r.ao); px(x + w - 4, y + 11, 3, 1, r.ao);   // feet
    px(x + w - 7, y + 9, 5, 2, U.shade(r.face, -0.2));                  // pump housing
    px(x + w - 6, y + 10, 1, 1, blink(1000, ph) ? '#2ee6c8' : '#143028'); // pump LED (kept beat)
    cable(x + w - 3, y + 9, x + w + 1, y + 11, 1.6);
    // CURVED GLASS: draw the body column by column so the flanks darken toward the silhouette
    px(x - 1, gTop - 1, w + 2, gh + 2, LINE);
    for (let i = 0; i < w; i++) {
      const t = Math.abs((i + 0.5) / w - 0.5) * 2;                 // 0 at the centre, 1 at the flanks
      const k = -0.10 - t * t * 0.42 + (on ? 0.06 : -0.06);        // flanks roll off into the silhouette
      px(x + i, gTop, 1, 5, U.shade('#155a54', k));                // clear water just under the surface
      px(x + i, gTop + 5, 1, 5, U.shade('#0f4444', k));            // mid depth
      px(x + i, gTop + 10, 1, gh - 10, U.shade('#0a2c2e', k));     // murk at the bottom
    }
    px(x, gTop, w, 1, U.shade('#2a6a62', 0.15));                    // the water line seen through the glass
    for (let i = 0; i < 4; i++) {                                   // caustics rippling across the bottom
      const cwid = 3 + (i % 2), cxp = x + 2 + ((i * 6 + Math.floor(now / 240 + ph)) % (w - 6));
      glow(cxp, gBot - 2, cwid, 1, aqua, (on ? 0.22 : 0.12) - i * 0.02);
    }
    px(x + 1, gTop + 1, 1, gh - 2, U.shade(aqua, -0.45));           // lit west glass edge
    px(x + w - 2, gTop + 1, 1, gh - 2, '#08201f');                  // dark east glass edge
    rimEdge(x + w - 2, gTop + 2, 1, gh - 5, 0.20);
    glow(x + 3, gTop + 2, 2, gh - 5, '#bffff2', 0.16);              // specular streak on the curve (kept)
    glow(x + w - 6, gTop + 3, 1, gh - 8, '#bffff2', 0.07);          // second faint streak (kept)
    // suspended specimen, bobbing, with a rim light off the surface lamp and a couple of tendrils
    const bob = Math.round(Math.sin(now / 1100 + ph) * 1.5), sx = x + (w >> 1) - 2, sy = y - 1 + bob;
    px(sx, sy, 4, 3, '#16504a'); px(sx + 1, sy - 1, 2, 1, '#16504a');
    px(sx, sy, 4, 1, '#2a7a6e'); px(sx, sy, 1, 3, '#2a7a6e');       // rim light, lit from above-west
    px(sx + 3, sy + 1, 1, 2, '#0d3a36');
    for (let i = 0; i < 2; i++)
      px(sx + 1 + i * 2, sy + 3, 1, 2 + ((Math.floor(now / 420 + i + ph)) % 2), '#123f3c');   // tendrils
    for (let i = 0; i < 3; i++) {                                   // bubbles rising (kept 1:1 beat)
      const bp = (now / (700 + i * 160) + i * 0.7 + ph) % 1;
      px(x + 4 + i * 6, gBot - 1 - Math.floor((1 - bp) * (gh - 3)), 1, 1, aqua);
      px(x + 5 + i * 6, gBot - 1 - Math.floor((1 - ((bp + 0.4) % 1)) * (gh - 3)), 1, 1, '#3a8a80');
    }
    // HEAVY TOP RIM we look down onto — steel, warm-keyed, hiding the lamp that lights the water
    chamf(x - 1, y - 11, w + 2, 5, LINE, 1);
    px(x, y - 10, w, 3, r.top);
    px(x, y - 10, w, 1, r.sheen); keyEdge(x + 1, y - 10, 8, 1, 0.28);
    px(x, y - 8, w, 1, U.shade(r.top, -0.22));                      // front lip of the rim
    for (let i = 0; i < 3; i++) px(x + 3 + i * ((w - 7) >> 1), y - 10, 1, 1, '#5a8a80');  // cap bolts (kept)
    px(x + 2, y - 8, w - 4, 1, '#2a6a62');                          // liquid surface under the rim
    bloom(x + 2, y - 8, w - 4, 1, aqua, (0.30 + 0.16 * Math.sin(now / 500 + ph)) * (on ? 1 : 0.7));
    spill(x + 1, y - 7, w - 2, aqua, on ? 0.20 : 0.13, 5);          // lamp light pushing down through the water
    spill(x + 1, y + 8, w - 2, aqua, on ? 0.14 : 0.08, 3);          // and pooling out onto the stand
    px(x + 1, y + 8, w - 2, 1, '#143028');                          // seal where glass meets the stand
  };

  F.whiteboard = (x, y, w, h, f) => {
    // WHITEBOARD (4x1) — v4, and deliberately the ANTI-SCREEN of this family: a MATTE dry-erase sheet
    // with no bloom, no scanlines and no emissive at all. Its only light is the ceiling strip raking
    // across the top of the sheet and dying off toward the tray, which is exactly how paper behaves.
    // It also gets the family's only A-frame stand, so its silhouette never confuses with a display.
    const r = RAMP.steel, ph = (f && f.x) || 0;
    const bt = y - 10, bh = 17;                                    // board rides y-10..y+6
    const ink = { red: '#c04640', blue: '#3a6aa0', dk: '#4a5a52' };
    shadow2(x + 3, y + h - 1, w - 6);
    // A-FRAME on casters: raked legs plus a real cross-brace, so the board is carried, not balanced
    for (const s of [-1, 1]) {
      const bx = x + (w >> 1) + s * 9;
      for (let j = 0; j < 6; j++) px(bx + s * j, y + 5 + j, 2, 1, LINE);
      for (let j = 0; j < 6; j++) px(bx + s * j, y + 5 + j, 1, 1, s < 0 ? r.lit : r.dk);
      chamf(bx + s * 6 - 3, y + h - 3, 8, 3, LINE, 1);             // caster yoke
      px(bx + s * 6 - 2, y + h - 2, 6, 1, r.face);
      px(bx + s * 6 - 2, y + h - 1, 2, 1, '#1a1e22'); px(bx + s * 6 + 2, y + h - 1, 2, 1, '#1a1e22');
      ctx.globalAlpha = 0.28; px(bx + s * 6 - 3, y + h, 8, 1, '#000'); ctx.globalAlpha = 1;
    }
    px(x + (w >> 1) - 12, y + 8, 24, 1, LINE);                     // cross-brace tying the legs together
    px(x + (w >> 1) - 12, y + 8, 24, 1, U.shade(r.face, 0.04));
    px(x + (w >> 1) - 3, y + 5, 6, 2, U.shade(r.face, -0.2));      // hinge block under the board
    // aluminium frame — light on the crown, cool on the shade flank, corner brackets at all four corners
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 14, 1, 0.28);
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);
    for (const cx0 of [x + 1, x + w - 3]) {
      px(cx0, bt + 1, 2, 2, U.shade(r.top, 0.22)); px(cx0, bt + bh - 3, 2, 2, r.ao);
    }
    // THE SHEET — matte, top-lit. Three broad value steps top-to-bottom is all a matte surface gets;
    // any specular streak here would make it read as glass.
    const sx = x + 3, sy = bt + 2, sw = w - 6, sh = bh - 6;
    px(sx - 1, sy - 1, sw + 2, sh + 2, U.shade(r.face, -0.45));    // the sheet sits proud of the frame
    px(sx, sy, sw, sh, '#c6dccb');
    px(sx, sy, sw, 2, '#dcefe0');                                  // ceiling strip raking the top
    keyEdge(sx, sy, sw, 1, 0.13);
    px(sx, sy + sh - 2, sw, 2, '#aec3b4');                         // falls off toward the tray
    px(sx, sy + sh - 1, sw, 1, '#9db2a4');
    wear(sx + 1, sy + 1, sw - 2, sh - 2, 4 + (ph % 2), '#bcd2c1');  // ghosts of old, badly-erased marker
    px(sx + 24, sy + 3, 8, 3, '#bfd6c5');                          // one broad eraser smudge
    // CONTENT — a real working board: a two-node flow at the left, a bulleted list, a small bar chart.
    px(sx + 2, sy + 1, 12, 1, ink.red); px(sx + 2, sy + 2, 8, 1, U.shade(ink.red, 0.25));  // heading + rule
    px(sx + 2, sy + 5, 7, 4, '#c6dccb'); rr(sx + 2, sy + 5, 7, 4, ink.blue);               // node A
    px(sx + 3, sy + 6, 5, 2, '#c6dccb');
    px(sx + 14, sy + 5, 7, 4, '#c6dccb'); rr(sx + 14, sy + 5, 7, 4, ink.blue);             // node B
    px(sx + 15, sy + 6, 5, 2, '#c6dccb');
    px(sx + 9, sy + 6, 5, 1, ink.dk); px(sx + 12, sy + 5, 1, 3, ink.dk);                   // arrow A -> B
    for (let i = 0; i < 3; i++) {                                   // bulleted list, centre-right
      px(sx + 24, sy + 6 + i * 2, 1, 1, ink.red);
      px(sx + 26, sy + 6 + i * 2, 8 - i * 2, 1, ink.dk);
    }
    px(sx + 24, sy + 1, 6, 1, ink.blue);                            // list heading
    const chx = sx + sw - 12;                                       // bar chart, top-right
    px(chx, sy + 1, 1, 7, ink.dk); px(chx, sy + 7, 11, 1, ink.dk);
    for (let i = 0; i < 4; i++) px(chx + 2 + i * 2, sy + 7 - (2 + (U.hash('wb' + i) % 4)), 1, 2 + (U.hash('wb' + i) % 4), i === 3 ? ink.red : ink.blue);
    // magnets + sticky notes — paper on paper, held down, nothing lit
    px(sx + 34, sy + 2, 3, 3, '#e8cf5e'); px(sx + 34, sy + 2, 3, 1, '#f4e28c'); px(sx + 35, sy + 3, 2, 1, '#bda347');
    px(sx + 38, sy + 4, 3, 3, '#82c98f'); px(sx + 38, sy + 4, 3, 1, '#a9dcb2'); px(sx + 39, sy + 5, 1, 1, '#4a8a58');
    px(sx + 21, sy + 1, 1, 1, '#b8452e'); px(sx + 33, sy + 8, 1, 1, '#3a6aa0');            // bare magnets
    // marker tray bolted across the frame's bottom rail
    px(x + 3, bt + bh - 3, w - 6, 3, LINE);
    px(x + 4, bt + bh - 2, w - 8, 2, U.shade(r.face, 0.08));
    px(x + 4, bt + bh - 2, w - 8, 1, r.lit); keyEdge(x + 5, bt + bh - 2, w - 12, 1, 0.13);
    px(x + 7, bt + bh - 3, 5, 1, ink.red); px(x + 14, bt + bh - 3, 5, 1, ink.blue);
    px(x + 21, bt + bh - 3, 4, 1, '#2c8a5a'); px(x + 28, bt + bh - 3, 4, 2, '#8a98a8');    // markers + eraser block
    px(x + 28, bt + bh - 3, 4, 1, '#a8b6c4');
  };

  F.rack = (x, y, w, h, f) => {   // v4 store rack (2x1) — same family, LOW and wide: three lit bays under a big top
    const r = RAMP.steel, on = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 4, w + 2, 4);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 3, y + h - 6, x + w + 2, y + h - 3, 2);              // loom sags off the east corner
    for (const lx of [x + 2, x + w - 5]) {                             // chunky corner legs on the plate
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
      rimEdge(lx + 2, y + h - 5, 1, 2, 0.16);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // short front face carrying three rack-unit bays (the family's "secured" seams, at compute scale)
    chamf(x - 1, y + 2, w + 2, h - 3, LINE, 2);
    px(x, y + 3, w, h - 5, r.face);
    px(x, y + 3, w, 1, r.lit); keyEdge(x + 1, y + 3, w - 3, 1, 0.15);
    px(x, y + 4, 1, h - 7, U.shade(r.face, 0.10)); px(x + w - 1, y + 4, 1, h - 7, r.dk);
    rimEdge(x + w - 1, y + 4, 1, h - 7, 0.20);
    for (let ru = 0; ru < 3; ru++) {
      const ry = y + 3 + ru * 3;
      inset(x + 2, ry, w - 4, 2, U.shade(r.face, -0.18));             // rack-unit bay
      px(x + 3, ry, w - 6, 1, U.shade(r.face, 0.08));                 // unit face catch
      for (let i = 0; i < (w - 12) / 4; i++)                          // LED row — blink pattern preserved 1:1
        px(x + 4 + i * 4, ry, 2, 1, blink(400 + ru * 130, i + ru) ? ACC.work : U.shade(ACC.work, -0.6));
      bloom(x + 4, ry, w - 12, 1, ACC.work, on ? 0.16 : 0.09);        // bay light with real falloff
      px(x + w - 6, ry, 1, 1, blink(900, ru * 1.7) ? ACC.flow : '#2a2418');   // amber drive light (kept)
      px(x + w - 4, ry, 1, 1, '#0e1413');                             // vent
    }
    px(x, y + h - 3, w, 1, r.ao);                                     // floor-line AO
    // big TOP surface dominates — chamfered, warm key on the back edge, vents cut through it
    chamf(x - 1, y - 4, w + 2, 7, LINE, 2);
    chamf(x, y - 3, w, 6, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 8, 1, 0.30);
    px(x, y - 1, 1, 3, r.lit); px(x + w - 1, y - 1, 1, 3, r.dk);
    rimEdge(x + w - 1, y - 1, 1, 3, 0.20);
    px(x + 3, y - 1, 8, 1, U.shade(r.top, 0.06));                     // brushed streak
    for (let i = 1; i < w / 8; i++) { px(x + i * 8, y - 2, 1, 3, r.ao); px(x + i * 8 + 1, y - 2, 1, 3, U.shade(r.top, 0.10)); }
    px(x + 2, y + 2, w - 4, 1, U.shade(r.top, -0.18));                // top front edge
    px(x + 4, y, 7, 1, U.shade(r.top, -0.30)); px(x + 5, y, 3, 1, ACC.work);  // green-tabbed index card on the deck
    wear(x + 2, y - 2, w - 4, 4, 3, U.shade(r.top, -0.10));
    if (on) spill(x + 2, y + 3, w - 4, ACC.work, 0.10, 3);            // bays pool light down the face
  };

  F.rackV = (x, y, w, h, f) => {
    // RACK V (1x2) — TALL 3/4 server tower, the STORAGE family's machine end. Shares the family's
    // language (chamfered cap, warm crown key, cool east rim, hazard-ticked base) but its "contents" are
    // blades instead of cargo. Every LED row / link light / PSU blink is kept, now with real falloff so
    // the lights sit IN the chassis instead of on top of it.
    const r = RAMP.steel, cw = w, rise = 7, topY = y - rise, botY = y + h - 1, ph = (f && f.x) || 0;
    shadow2(x + 1, botY, cw - 2);
    // silhouette + slim east flank that gives the tower its depth
    chamf(x - 1, topY - 5, cw + 2, botY - topY + 6, LINE, 2);
    px(x + cw - 3, topY - 1, 2, botY - topY, r.dk);
    rimEdge(x + cw - 2, topY + 1, 1, botY - topY - 3, 0.22);          // cool sky bounce down the shade flank
    px(x + 1, topY, cw - 4, (botY - 1) - topY, r.face);               // front chassis
    px(x + 1, topY, 1, (botY - 1) - topY, r.lit);                     // west sheen column
    px(x + 2, topY, cw - 5, 1, U.shade(r.face, 0.14));
    // chamfered cap we look down onto
    chamf(x, topY - 4, cw - 2, 4, LINE, 1);
    px(x + 1, topY - 3, cw - 4, 3, r.top);
    px(x + 1, topY - 3, cw - 4, 1, r.sheen); keyEdge(x + 1, topY - 3, 4, 1, 0.30);
    px(x + 1, topY - 1, cw - 4, 1, U.shade(r.top, -0.18));            // cap front lip
    px(x + 2, topY - 3, 1, 1, U.shade(r.sheen, 0.30)); px(x + cw - 5, topY - 3, 1, 1, r.dk);
    // rail posts framing the rack units
    px(x + 2, topY + 1, 1, (botY - 3) - topY, U.shade(r.face, 0.20));
    px(x + cw - 4, topY + 1, 1, (botY - 3) - topY, r.dk);
    // 5 rack units: blade body, status LED, label, link light, vent slot
    for (let u = 0; u < 5; u++) {
      const uy = topY + 1 + u * 5;
      px(x + 3, uy, cw - 7, 4, u % 2 ? '#1c242c' : '#212a34');        // blade body
      px(x + 3, uy, cw - 7, 1, u % 2 ? '#2a3540' : '#2e3a46');        // unit top catch
      keyEdge(x + 3, uy, 3, 1, 0.10);
      px(x + 3, uy + 4, cw - 7, 1, '#0f151b');                        // seam shadow between units
      const st = blink(420 + u * 110, ph + u);
      px(x + 4, uy + 1, 1, 1, st ? '#7fd0ff' : '#16242e');            // status LED
      if (st) bloom(x + 4, uy + 1, 1, 1, '#7fd0ff', 0.26);
      px(x + 5, uy + 1, 2, 1, '#2a3640');                             // label strip
      const lk = blink(700, ph + u * 2);
      px(x + 7, uy + 1, 1, 1, lk ? ACC.work : '#16302a');             // link light
      if (lk) bloom(x + 7, uy + 1, 1, 1, ACC.work, 0.22);
      px(x + 4, uy + 3, cw - 9, 1, '#141b22');                        // vent slot
      px(x + 5, uy + 3, 1, 1, '#1e2832'); px(x + 7, uy + 3, 1, 1, '#1e2832');
    }
    // PSU strip at the base + the hazard ticks that mark it as bolted hardware
    px(x + 3, botY - 3, cw - 7, 2, '#161d24');
    px(x + 3, botY - 3, cw - 7, 1, U.shade(r.face, -0.10));
    const psu = blink(1300, ph);
    px(x + 4, botY - 2, 2, 1, psu ? '#ff9d2e' : '#33241a');
    if (psu) bloom(x + 4, botY - 2, 2, 1, '#ff9d2e', 0.20);
    px(x + cw - 5, botY - 2, 1, 1, blink(1600, ph + 3) ? ACC.work : '#16302a');
    px(x + 3, botY - 4, 2, 1, '#8a7434');                             // hazard tick, shared storage-family mark
    cable(x + cw - 4, botY - 3, x + cw - 1, botY, 1.4);               // power lead sagging off the back corner
    // freestanding feet + under-gap AO
    px(x + 1, botY - 1, 2, 2, r.dk); px(x + cw - 5, botY - 1, 2, 2, r.dk);
    px(x + 1, botY - 1, 1, 1, r.lit); px(x + cw - 5, botY - 1, 1, 1, r.lit);
    underAO(x + 3, botY, cw - 8, 1);
  };

  F.bench = (x, y, w, h, f) => {   // v4 lab bench (4x1) — LOW open run: wash basin, clutter, assay terminal east
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);
    for (const lx of [x + 2, x + 15, x + 30, x + w - 5]) {      // four legs across the long span
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // apron with a long tool drawer + a quiet green service underglow
    rr(x - 1, y + 5, w + 2, 5, LINE);
    px(x, y + 6, w, 3, r.face);
    px(x, y + 6, w, 1, r.lit); keyEdge(x + 1, y + 6, w - 3, 1, 0.14);
    for (let i = 0; i < 4; i++) { px(x + 4 + i * 11, y + 7, 9, 1, U.shade(r.face, 0.06)); px(x + 7 + i * 11, y + 7, 3, 1, U.shade(r.face, -0.36)); }
    px(x, y + 8, w, 1, r.ao);
    bloom(x + 3, y + 8, w - 6, 1, ACC.work, on ? 0.20 + 0.07 * Math.sin(now / 340) : 0.06);
    // the long worktop dominates — deliberately kept EMPTY and low; nothing tall spans it, which is exactly
    // what separates a 4-tile bench from the console next to it at station scale.
    chamf(x - 1, y - 4, w + 2, 11, LINE, 2);
    chamf(x, y - 3, w, 9, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 12, 1, 0.26);
    px(x, y - 1, 1, 5, r.lit); px(x + w - 1, y - 1, 1, 5, r.dk); rimEdge(x + w - 1, y - 1, 1, 5, 0.20);
    px(x + 5, y - 1, 9, 1, U.shade(r.top, 0.06)); px(x + 24, y + 2, 11, 1, U.shade(r.top, 0.05)); // brushed streaks
    px(x + 2, y + 5, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 1, y - 2, w - 2, 7, 7, U.shade(r.top, -0.12));
    // low BACKSPLASH lip along the back — profile without height
    px(x + 1, y - 7, w - 2, 4, LINE);
    px(x + 2, y - 6, w - 4, 2, r.face);
    px(x + 2, y - 6, w - 4, 1, r.top); keyEdge(x + 2, y - 6, 10, 1, 0.22);
    px(x + 3, y - 4, w - 6, 1, r.ao);                           // splash-back AO onto the worktop
    for (let i = 0; i < 5; i++) px(x + 8 + i * 8, y - 5, 1, 1, U.shade(r.face, -0.45)); // hanger holes
    // WASH BASIN sunk into the west end, with a gooseneck tap and a slow drip
    chamf(x + 2, y - 2, 12, 7, '#0d1518', 2);
    chamf(x + 3, y - 1, 10, 5, '#141f22', 2);
    px(x + 7, y + 2, 2, 1, '#08100f');                          // drain
    px(x + 5, y - 6, 1, 4, U.shade(r.lit, -0.1)); px(x + 5, y - 6, 3, 1, U.shade(r.lit, -0.1)); // tap
    px(x + 7, y - 5, 1, 1, U.shade(r.dk, 0.1));
    if (blink(1500, ph)) px(x + 7, y - 3, 1, 1, '#8fd8e0');     // a drip on its way down
    rimEdge(x + 3, y - 1, 10, 1, 0.14);                         // sky bounce off the wet steel
    // rotating bench-top clutter (kept: flasks / reagents / papers), now clear of the basin
    for (let i = 0; i < 3; i++) {
      const bx = x + 17 + i * 8;
      if (i % 3 === 0) {                                        // flask of culture fluid with vapor blink
        px(bx - 1, y + 2, 5, 1, '#222c26');                     // heat pad
        px(bx, y - 1, 3, 3, '#7adfd0'); px(bx + 1, y - 2, 1, 1, '#9aeae0'); px(bx, y + 1, 3, 1, '#4aa89c');
        px(bx, y - 1, 1, 2, '#bffff2');                         // glass shine
        if (blink(800, i)) px(bx + 1, y - 3, 1, 1, '#9aeae0');  // vapor wisp
      } else if (i % 3 === 1) {                                 // reagent bottle with label
        px(bx + 1, y - 2, 2, 4, '#caa86a'); px(bx + 1, y - 2, 1, 4, '#e0c084'); px(bx + 1, y - 3, 2, 1, '#6a5836');
        px(bx + 1, y, 2, 1, '#e8e0d0');                         // label band
      } else {                                                  // papers + tool glint
        px(bx, y, 4, 2, '#dfe8df'); px(bx, y, 4, 1, '#f0f6f0');
        px(bx + 1, y + 1, 2, 1, '#9aaa9a');
        px(bx + 1, y - 1, 4, 1, '#8a98a8'); px(bx + 4, y - 1, 1, 1, '#aab8c8');
      }
    }
    // ASSAY TERMINAL on a stub arm at the east end — the bench's COMPUTER, kept small and off to one side so
    // the long empty run still carries the silhouette. Spectrum readout, not code: this is lab hardware.
    const tx = x + 35, tt = y - 13;
    px(tx + 5, y - 4, 3, 3, U.shade(r.face, -0.15)); px(tx + 5, y - 4, 1, 3, r.lit); px(tx + 7, y - 4, 1, 3, r.dk);
    chamf(tx + 3, y - 2, 8, 2, U.shade(r.top, -0.30), 1);       // foot on the worktop
    chamf(tx - 1, tt - 1, 13, 10, LINE, 2);
    chamf(tx, tt, 11, 8, '#161d1a', 2);
    px(tx + 2, tt, 7, 1, '#2c3b33'); keyEdge(tx + 2, tt, 4, 1, 0.24);
    px(tx, tt + 2, 1, 4, '#20302a'); px(tx + 10, tt + 2, 1, 4, '#0d1512'); rimEdge(tx + 10, tt + 2, 1, 4, 0.20);
    px(tx + 1, tt + 1, 9, 6, '#08110c');                        // glass well
    const sc = scr(ph);
    for (let i = 0; i < 9; i++) {                               // spectrum bars + the assay's live peak
      const v = 1 + Math.round(Math.abs(Math.sin(now / 300 + i * 0.7 + ph)) * (on ? 4 : 1.6));
      px(tx + 1 + i, tt + 6 - v, 1, v, on ? U.shade(sc, -0.1) : U.shade(sc, -0.66));
    }
    px(tx + 1, tt + 6, 9, 1, on ? U.shade(sc, -0.45) : '#12251c');   // baseline, idle keeps phosphor
    if (on) {
      px(tx + 1 + (Math.floor(now / 240) % 9), tt + 1, 1, 1, '#eaffe8');   // peak marker sweeping
      scanl(tx + 1, tt + 1, 9, 6, 0.20);
      bloom(tx + 1, tt + 1, 9, 6, sc, 0.15); spill(tx, y - 3, 11, sc, 0.18, 4);
    } else {
      scanl(tx + 1, tt + 1, 9, 6, 0.26);
      px(tx + 9, tt + 6, 1, 1, blink(1600, ph) ? '#ff9d2e' : '#33241a'); // standby amber
    }
  };

  F.desk = (x, y, w, h, f) => {   // v4 workstation — TOP-BIAS OBLIQUE slab, bolted; warm lamp vs cold screen
    const r = RAMP.steel, ph = f.x || 0, on = !!f.work;
    shadow2(x + 1, y + h - 1, w - 2);                          // floor contact
    deckPlate(x - 1, y + 8, w + 2, h - 8);                     // mounting plate peeks out under the desk
    deckSocket(x + w + 1, y + h - 3, on);                      // cable runs into a floor socket east
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);        // limp power lead sags off the back corner
    for (const lx of [x + 2, x + w - 5]) {                     // chunky corner legs on the plate
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);                      // cool sky bounce down the shade side
    }
    underAO(x + 5, y + 9, w - 10, 2);                          // dark open gap under the desk
    // short front apron: two real drawer fronts, warm catch under the tabletop's overhang
    rr(x - 1, y + 5, w + 2, 5, LINE);
    px(x, y + 6, w, 3, r.face);
    px(x, y + 6, w, 1, r.lit);
    keyEdge(x + 1, y + 6, w - 3, 1, 0.15);
    for (const dx of [x + 3, x + 13]) {
      px(dx, y + 7, 8, 1, U.shade(r.face, 0.07));              // drawer front
      px(dx + 2, y + 7, 4, 1, U.shade(r.face, -0.36));         // recessed pull
      px(dx, y + 7, 1, 1, r.lit); px(dx + 7, y + 7, 1, 1, r.dk);
    }
    px(x, y + 8, w, 1, r.ao);
    // the big CHAMFERED tabletop dominates — 2px corner cuts kill the lozenge read of rr()
    chamf(x - 1, y - 4, w + 2, 11, LINE, 2);
    chamf(x, y - 3, w, 9, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen);                       // back edge catches the ceiling strip
    keyEdge(x + 2, y - 3, 9, 1, 0.30);                         // warm key, west-biased
    px(x, y - 1, 1, 5, r.lit); px(x + w - 1, y - 1, 1, 5, r.dk);
    rimEdge(x + w - 1, y - 1, 1, 5, 0.20);                     // cool rim down the shade side
    for (let i = 0; i < 3; i++) px(x + 3 + i * 7, y - 1 + i * 2, 6 - i, 1, U.shade(r.top, 0.055)); // brushed grain
    px(x + 2, y + 5, w - 4, 1, U.shade(r.top, -0.18));         // front edge of the top
    wear(x + 1, y - 2, w - 2, 7, 3, U.shade(r.top, -0.10));
    // GOOSENECK task lamp at the west edge — a warm key fighting the cold screen (two temperatures = depth).
    // Kept SLIM on purpose: a chunky lamp body competes with the monitor for the desk's silhouette.
    px(x, y - 2, 4, 3, LINE); px(x + 1, y - 1, 2, 1, r.lit);    // clamp foot biting the back edge
    for (let i = 0; i <= 10; i++) {                             // a real curve, not a pipe elbow
      const t = i / 10;
      px(Math.round(x + 1 + t * t * 4), Math.round(y - 2 - t * 8), 1, 1, i < 6 ? r.lit : r.dk);
    }
    px(x + 3, y - 11, 5, 3, LINE); px(x + 4, y - 10, 3, 1, r.top);   // compact head aimed down at the desk
    px(x + 4, y - 9, 3, 1, on ? '#ffe6b8' : '#3b332a');         // lit mouth
    if (on) { bloom(x + 4, y - 9, 3, 1, KEY, 0.28); spill(x + 2, y - 3, 9, KEY, 0.13, 4); }
    // MONITOR: a wide panel on a slim riser — the desk's hero silhouette
    const mx = x + 10, mw = 13, mtop = y - 12, sx = mx + 2, sy = mtop + 2, sw = mw - 4;
    px(mx + 5, y - 3, 3, 3, U.shade(r.face, -0.15));           // riser neck
    px(mx + 5, y - 3, 1, 3, r.lit); px(mx + 7, y - 3, 1, 3, r.dk);
    chamf(mx + 2, y - 1, 9, 2, U.shade(r.top, -0.32), 1);      // foot pad pressed into the tabletop
    px(mx + 3, y - 1, 7, 1, U.shade(r.top, -0.12));
    chamf(mx - 1, mtop - 1, mw + 2, 11, LINE, 2);
    chamf(mx, mtop, mw, 9, '#161d1a', 2);                      // dark bezel
    px(mx + 2, mtop, mw - 4, 1, '#2c3b33'); keyEdge(mx + 2, mtop, 5, 1, 0.26); // bezel top catch
    px(mx, mtop + 2, 1, 5, '#20302a'); px(mx + mw - 1, mtop + 2, 1, 5, '#0d1512');
    rimEdge(mx + mw - 1, mtop + 2, 1, 5, 0.22);
    inset(mx + 1, mtop + 1, mw - 2, 7, '#08110c');             // glass well
    if (on) {
      const sc = scr(ph);
      px(sx, sy, sw, 5, U.shade(sc, -0.74));                   // terminal ground, not dead black
      for (let j = 0; j < 4; j++) codeRow(sx, sy + j, sw, j * 2 + Math.floor(ph), sc, '#eaffe8');
      px(sx + (Math.floor(now / 300) % (sw - 2)), sy + 4, 1, 1, blink(400, ph) ? '#eaffe8' : U.shade(sc, -0.6));
      scanl(sx, sy, sw, 5, 0.22);
      bloom(sx, sy, sw, 5, sc, 0.17);                          // panel bloom that actually falls off
      spill(mx + 1, y - 3, mw - 2, sc, 0.22, 5);               // screen light pools DOWN the tabletop
    } else {
      px(sx, sy, sw, 5, '#0b130e');
      px(sx, sy, 4, 1, '#16231b'); px(sx + 1, sy + 1, 2, 1, '#111c15'); // dead glass reflecting the ceiling
      px(sx + sw - 1, sy + 4, 1, 1, blink(1600, ph) ? '#ff9d2e' : '#33241a'); // standby amber
    }
    // desk surface: keyboard well with two key rows, mouse, mug under the lamp, papers, sticky note
    chamf(mx - 1, y + 1, 11, 4, U.shade(r.top, -0.30), 1);
    px(mx, y + 2, 9, 1, U.shade(r.face, 0.12)); px(mx, y + 3, 9, 1, U.shade(r.face, -0.04));
    for (let i = 0; i < 9; i += 2) { px(mx + i, y + 2, 1, 1, U.shade(r.face, 0.28)); px(mx + i + 1, y + 3, 1, 1, U.shade(r.face, 0.18)); }
    px(mx + 11, y + 2, 2, 2, r.face); px(mx + 11, y + 2, 2, 1, r.lit);   // mouse
    px(x + 2, y + 1, 3, 3, '#3a6a62'); px(x + 2, y + 1, 3, 1, '#5aa89c'); px(x + 2, y + 1, 1, 3, '#4a8078');
    px(x + 5, y + 2, 1, 1, '#2a4a44');                         // mug handle
    if (on && blink(700)) px(x + 3, y - 1, 1, 1, '#7a8a86');   // coffee steam
    px(x + 6, y + 3, 2, 2, '#ffe066'); px(x + 6, y + 3, 2, 1, '#fff0a8'); // sticky note
  };

  F.desk2 = (x, y, w, h, f) => {   // v4 battlestation (2x1) — twin panels on ONE arm mast; ACC.mem bias light
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);                          // floor contact
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);        // limp lead off the back corner
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);                      // cool bounce down the shade side
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short apron — the signature mem-purple underglow stays, now with real falloff
    rr(x - 1, y + 5, w + 2, 5, LINE);
    px(x, y + 6, w, 3, r.face);
    px(x, y + 6, w, 1, r.lit); keyEdge(x + 1, y + 6, w - 3, 1, 0.15);
    for (const dx of [x + 3, x + 13]) {                        // two real drawer fronts
      px(dx, y + 7, 8, 1, U.shade(r.face, 0.07));
      px(dx + 2, y + 7, 4, 1, U.shade(r.face, -0.36));
      px(dx, y + 7, 1, 1, r.lit); px(dx + 7, y + 7, 1, 1, r.dk);
    }
    px(x, y + 8, w, 1, r.ao);
    bloom(x + 2, y + 8, w - 4, 1, ACC.mem, on ? 0.30 + 0.10 * Math.sin(now / 300) : 0.10);
    // chamfered tabletop
    chamf(x - 1, y - 4, w + 2, 11, LINE, 2);
    chamf(x, y - 3, w, 9, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 8, 1, 0.28);
    px(x, y - 1, 1, 5, r.lit); px(x + w - 1, y - 1, 1, 5, r.dk); rimEdge(x + w - 1, y - 1, 1, 5, 0.20);
    for (let i = 0; i < 2; i++) px(x + 4 + i * 9, y + i * 2, 6, 1, U.shade(r.top, 0.05)); // brushed grain
    px(x + 2, y + 5, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 1, y - 2, w - 2, 7, 3, U.shade(r.top, -0.10));
    // ONE central MAST + crossbar carries both panels. The pilot desk is a single wide monitor on a stub
    // riser — this goalpost silhouette is what tells the two apart at 12px, before any pixel of screen reads.
    const cx = x + 11;
    chamf(cx - 4, y - 2, 10, 3, U.shade(r.top, -0.30), 1);      // mount foot pressed into the tabletop
    px(cx - 3, y - 2, 8, 1, U.shade(r.top, -0.12));
    px(cx - 1, y - 13, 1, 11, LINE); px(cx + 2, y - 13, 1, 11, LINE);
    px(cx, y - 13, 1, 11, r.lit); px(cx + 1, y - 13, 1, 11, r.dk);
    rimEdge(cx + 1, y - 11, 1, 8, 0.18);
    px(cx - 2, y - 14, 6, 2, LINE);                             // mast head under the bar
    px(x + 2, y - 14, w - 4, 2, LINE);                          // crossbar the panels hang from
    px(x + 3, y - 14, w - 6, 1, r.lit); keyEdge(x + 3, y - 14, 8, 1, 0.24);
    px(x + 3, y - 13, w - 6, 1, U.shade(r.face, -0.34));        // bar underside in shade
    bloom(x + 4, y - 15, w - 8, 1, ACC.mem, on ? 0.24 : 0.07);  // mem bias light washing the wall behind
    // twin panels, outer top corners cut so the pair toes IN like a cockpit
    for (let s = 0; s < 2; s++) {
      const p0 = s ? x + 13 : x + 1, ptop = y - 13, sp = ph + s * 3;
      px(p0 - 1, ptop - 1, 12, 10, LINE);                       // silhouette
      px(p0, ptop, 10, 8, '#171426');                           // dark mem-tinted bezel
      px(p0 + (s ? 0 : 9), ptop, 1, 1, LINE);                   // outer corner cut = toe-in
      px(p0 + 1, ptop, 8, 1, '#2c2440'); keyEdge(p0 + 1, ptop, 4, 1, 0.22);
      px(p0, ptop + 1, 1, 6, '#221c34'); px(p0 + 9, ptop + 1, 1, 6, '#0d0a16');
      rimEdge(p0 + 9, ptop + 1, 1, 6, 0.18);
      px(p0 + 1, ptop + 1, 8, 6, '#08110c');                    // glass well
      if (on) {
        const sc = scr(sp);
        px(p0 + 1, ptop + 1, 8, 6, U.shade(sc, -0.76));         // terminal ground, never dead black
        for (let j = 0; j < 5; j++) codeRow(p0 + 1, ptop + 1 + j, 8, j * 2 + Math.floor(sp), sc, '#eaffe8');
        px(p0 + 1 + (Math.floor(now / 300 + s * 4) % 7), ptop + 6, 1, 1, blink(400, sp) ? '#eaffe8' : U.shade(sc, -0.6));
        scanl(p0 + 1, ptop + 1, 8, 6, 0.22);
        bloom(p0 + 1, ptop + 1, 8, 6, sc, 0.16);
        spill(p0, y - 3, 10, sc, 0.20, 4);                      // both panels pool light onto the top
      } else {
        px(p0 + 2, ptop + 1, 4, 1, '#16231b'); px(p0 + 2, ptop + 2, 2, 1, '#111c15'); // dead glass reflection
        if (s) px(p0 + 8, ptop + 6, 1, 1, blink(1600, ph) ? '#ff9d2e' : '#33241a');   // standby amber
      }
    }
    // desk surface: a SPLIT keyboard (one half under each panel), mouse, headset with the mem accent strip
    for (const kx of [x + 2, x + 13]) {
      chamf(kx, y + 1, 9, 4, U.shade(r.top, -0.30), 1);
      px(kx + 1, y + 2, 7, 1, U.shade(r.face, 0.12)); px(kx + 1, y + 3, 7, 1, U.shade(r.face, -0.04));
      for (let i = 0; i < 7; i += 2) px(kx + 1 + i, y + 2, 1, 1, U.shade(r.face, 0.26));
    }
    px(x + 21, y + 2, 2, 2, r.face); px(x + 21, y + 2, 2, 1, r.lit);   // mouse
    px(x + 3, y - 2, 4, 2, '#2a2436'); px(x + 3, y - 2, 4, 1, '#3a3450'); // headset on the top
    px(x + 3, y - 2, 1, 2, ACC.mem);
  };

  F.pixelrig = (x, y, w, h, f) => {   // v4 art rig (2x1) — TILTED easel canvas + a ring light; ACC.lounge identity
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short front lip — art-pink underglow kept, now with falloff
    rr(x - 1, y + 5, w + 2, 5, LINE);
    px(x, y + 6, w, 3, r.face);
    px(x, y + 6, w, 1, r.lit); keyEdge(x + 1, y + 6, w - 3, 1, 0.15);
    px(x + 4, y + 7, 7, 1, U.shade(r.face, 0.07)); px(x + 6, y + 7, 3, 1, U.shade(r.face, -0.36)); // flat file drawer
    px(x, y + 8, w, 1, r.ao);
    bloom(x + 2, y + 8, w - 4, 1, ACC.lounge, on ? 0.26 + 0.08 * Math.sin(now / 320) : 0.08);
    // worktop
    chamf(x - 1, y - 4, w + 2, 11, LINE, 2);
    chamf(x, y - 3, w, 9, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 8, 1, 0.26);
    px(x, y - 1, 1, 5, r.lit); px(x + w - 1, y - 1, 1, 5, r.dk); rimEdge(x + w - 1, y - 1, 1, 5, 0.20);
    px(x + 2, y + 5, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 1, y - 2, w - 2, 7, 3, U.shade(r.top, -0.10));
    // EASEL: the canvas is genuinely ROTATED (drawn column by column, east end riding 2px high). Every other
    // station in this room is axis-aligned, so the leaning rectangle is what names this one at a glance.
    const p0 = x + 3, pw = 14, ptop = y - 11, cols = ['#2ee6c8', '#ff9d2e', '#ff6ad5'];
    const tilt = i => -Math.round(i * 2 / (pw - 1));
    px(p0 + 5, y - 3, 3, 3, U.shade(r.top, -0.30)); px(p0 + 5, y - 3, 3, 1, U.shade(r.top, -0.12)); // easel foot
    for (let i = 0; i < pw; i++) {                              // frame columns, each carrying the tilt
      const d = tilt(i);
      px(p0 + i, ptop + d - 1, 1, 11, LINE);
      px(p0 + i, ptop + d, 1, 9, '#141c1a');
      if (i === 0 || i === pw - 1) px(p0 + i, ptop + d + 1, 1, 7, i ? '#0d1412' : '#243430'); // lit W / dark E stile
    }
    px(p0 + 1, ptop + tilt(1), 4, 1, '#2a4a44'); keyEdge(p0 + 1, ptop + tilt(1), 4, 1, 0.22);   // frame crown catch
    for (let i = 2; i < pw - 2; i++) {                          // the canvas well, then the pixel art itself
      const d = tilt(i), ci = Math.floor((i - 2) / 3);
      px(p0 + i, ptop + d + 2, 1, 5, '#0a1d1b');
      for (let j = 0; j < 2; j++)
        if ((ci + j + Math.floor(now / 500)) % 3 === 0) px(p0 + i, ptop + d + 3 + j * 2, 1, 1, cols[(ci + j) % 3]);
    }
    const cc = Math.floor(now / 500) % 4;                       // paint cursor blinking at the active cell
    if (blink(250)) for (let i = 2 + cc * 3; i < Math.min(pw - 2, 4 + cc * 3); i++)
      px(p0 + i, ptop + tilt(i) + 3 + (cc % 2) * 2, 1, 1, U.shade(cols[cc % 3], 0.45));
    if (on) { bloom(p0 + 2, ptop - 1, pw - 4, 6, ACC.lounge, 0.12); spill(p0 + 1, y - 3, pw - 2, ACC.lounge, 0.16, 4); }
    else px(p0 + pw - 3, ptop + tilt(pw - 3) + 7, 1, 1, blink(1600, ph) ? '#ff9d2e' : '#33241a'); // standby amber
    // RING LIGHT on a stub post — a circle in a room of rectangles, and where the pink actually lives
    const rcx = x + 20, rcy = y - 11;
    px(rcx - 1, y - 8, 3, 6, LINE); px(rcx, y - 8, 1, 5, r.lit); px(rcx + 1, y - 8, 1, 5, r.dk);
    for (const o of [[-1, -3], [0, -3], [1, -3], [-2, -2], [2, -2], [-3, -1], [3, -1], [-3, 0], [3, 0],
                     [-3, 1], [3, 1], [-2, 2], [2, 2], [-1, 3], [0, 3], [1, 3]]) {
      px(rcx + o[0] - 1, rcy + o[1], 3, 1, LINE);               // dark housing so the ring reads unlit too
      px(rcx + o[0], rcy + o[1], 1, 1, on ? '#ffd6f0' : '#3a2c3c');
    }
    if (on) { bloom(rcx - 3, rcy - 3, 7, 7, ACC.lounge, 0.13); spill(rcx - 4, y - 3, 9, ACC.lounge, 0.14, 4); }
    else px(rcx, rcy, 1, 1, blink(1200, ph) ? U.shade(ACC.lounge, -0.3) : '#2a1c2c');
    // swatch strip, tablet + stylus on the worktop (kept)
    for (let i = 0; i < 4; i++) px(x + 2 + i * 2, y + 1, 1, 2, [cols[0], cols[1], cols[2], ACC.flow][i]);
    chamf(x + 11, y, 9, 5, U.shade(r.top, -0.30), 1);
    px(x + 12, y + 1, 7, 3, '#0e1816'); px(x + 12, y + 1, 7, 1, '#1c2a28');   // tablet
    if (on) px(x + 13 + (Math.floor(now / 300) % 5), y + 2, 1, 1, '#2ee6c8'); // pen tracking dot
    px(x + 13, y + 4, 4, 1, '#caa86a'); px(x + 16, y + 4, 1, 1, '#e8e0d0');   // stylus lying on the tablet
  };

  F.coffee = (x, y, w, h, f) => {   // v4 brewer — ONE chamfered column, the hot alcove is the only lit thing
    const r = RAMP.steel, rdy = blink(1200);                    // brew-ready lamp (kept)
    shadow2(x + 2, y + 11, 9);                                  // freestanding decor: contact only, no deckplate
    // waiting mug on the deck, west — the scale cue that tells you this is counter-height, not a server rack
    px(x - 1, y + 8, 4, 4, LINE); px(x, y + 9, 2, 2, '#3a6a62'); px(x, y + 9, 2, 1, '#5aa89c');
    px(x + 2, y + 10, 1, 1, '#2a4a44');
    // the column: one bold chamfered mass. v3 drew a rounded box; the 2px cuts are what stop it reading
    // as a filing cabinet at 3x.
    chamf(x + 2, y - 3, 9, 15, LINE, 2);
    chamf(x + 3, y - 2, 7, 13, r.face, 2);
    px(x + 3, y - 1, 1, 9, r.lit); px(x + 9, y - 1, 1, 9, r.dk);
    rimEdge(x + 9, y - 1, 1, 9, 0.20);                          // cool sky bounce down the shade flank
    px(x + 3, y + 10, 7, 1, r.ao);                              // floor-line AO
    // head cap OVERHANGS the column so the silhouette steps — a straight tube reads as a pipe
    chamf(x + 1, y - 6, 11, 4, LINE, 1);
    chamf(x + 2, y - 5, 9, 3, r.top, 1);
    px(x + 3, y - 5, 7, 1, r.sheen); keyEdge(x + 3, y - 5, 4, 1, 0.30);   // warm key on the water lid
    px(x + 6, y - 5, 1, 3, U.shade(r.top, -0.26));              // lid seam
    px(x + 9, y - 5, 1, 1, U.shade(r.top, 0.34));               // hinge catch (soft, not a white speck)
    px(x + 2, y - 3, 9, 1, U.shade(r.top, -0.24));              // front lip of the cap
    // brew ALCOVE — a real hole cut into the column. Cutting a void into the mass is worth more at 12px
    // than any amount of surface detail: it gives the prop an interior.
    inset(x + 4, y + 1, 5, 7, '#0a0f12');
    px(x + 5, y + 1, 3, 1, '#1a2228'); px(x + 6, y + 2, 1, 1, '#0d1216');   // spout housing + spout
    const lvl = 1 + Math.floor(((now / 4000) % 1) * 3);         // pot slowly fills (kept)
    px(x + 5, y + 3, 3, 1, '#8a98a8');                          // carafe rim
    px(x + 5, y + 4, 3, 3, '#141b1e');
    px(x + 5, y + 7 - lvl, 3, lvl, '#2f4a46'); px(x + 5, y + 7 - lvl, 3, 1, '#4a706a');
    px(x + 5, y + 4, 1, 3, '#2a363c');                          // glass shine, west
    px(x + 8, y + 4, 1, 2, '#6a7888');                          // carafe handle
    if (blink(400)) px(x + 6, y + 2, 1, 1, '#3e5e58');          // drip stream (kept)
    px(x + 4, y + 8, 5, 1, '#241c14'); px(x + 5, y + 8, 2, 1, '#3a2c20');   // drip tray + old stain (kept)
    // control strip. The lamp is 1px, so it earns its read from FALLOFF, not brightness.
    px(x + 4, y, 5, 1, U.shade(r.face, -0.34));
    px(x + 4, y, 1, 1, rdy ? ACC.work : '#1c2a22');
    px(x + 6, y, 1, 1, '#222c32'); px(x + 8, y, 1, 1, '#222c32');   // buttons (kept)
    if (rdy) { bloom(x + 4, y, 1, 1, ACC.work, 0.34); spill(x + 4, y + 1, 5, ACC.work, 0.10, 3); }
    px(x + 4, y + 9, 2, 1, '#caa84a');                          // serial tag
    if (blink(600)) { px(x + 4, y - 8, 1, 2, '#8a8a8a'); px(x + 7, y - 9, 1, 2, '#6a6a6a'); } // steam (kept)
  };

  F.plant = (x, y, w, h, f) => {   // v4 potted palm — genuinely tapered pot, open fronds lit warm W / cool E
    const r = RAMP.gun;
    shadow2(x + 2, y + 11, 8);
    // POT: a real taper (wide rim -> narrow foot), not a rounded box. The rim is a top surface we look
    // down into, which is what sells the oblique projection on a prop this small.
    for (let j = 0; j < 7; j++) { const i = j >> 1; px(x + 1 + i, y + 5 + j, 10 - i * 2, 1, LINE); }
    for (let j = 0; j < 5; j++) {
      const i = (j + 1) >> 1;
      px(x + 2 + i, y + 6 + j, 8 - i * 2, 1, r.face);
      px(x + 2 + i, y + 6 + j, 1, 1, r.lit);
      px(x + 9 - i, y + 6 + j, 1, 1, r.dk);
    }
    rimEdge(x + 8, y + 6, 1, 4, 0.20);                          // cool sky down the shade side of the pot
    px(x + 4, y + 10, 4, 1, r.ao);                              // foot in shadow
    chamf(x + 1, y + 3, 10, 3, LINE, 1);                        // rim lip, drawn over the body
    px(x + 2, y + 4, 8, 1, '#1d1812');                          // soil in the bowl
    px(x + 4, y + 4, 2, 1, '#2a2218'); px(x + 8, y + 4, 1, 1, '#2a2218');   // clods
    px(x + 2, y + 5, 8, 1, r.sheen); keyEdge(x + 2, y + 5, 4, 1, 0.32);     // rim catches the ceiling strip
    px(x + 9, y + 5, 1, 1, r.dk);
    // FOLIAGE: open palm fronds with real gaps. A solid green mass reads as a bush-shaped blob at 3x;
    // the gaps are the silhouette. West leaves take the warm key, east leaves take the cold sky bounce.
    px(x + 5, y - 2, 2, 6, '#256032');                          // stalk
    px(x + 5, y - 8, 2, 6, '#2e7a3e');                          // centre leaf rises well above the tile
    px(x + 5, y - 8, 1, 2, '#5ec46e'); keyEdge(x + 5, y - 8, 1, 2, 0.30);
    px(x + 3, y - 6, 2, 1, '#3a9a4e'); px(x + 2, y - 5, 2, 2, '#3a9a4e');   // west frond arcs out...
    px(x + 1, y - 3, 2, 2, '#3a9a4e'); px(x + 1, y - 3, 1, 1, '#5ec46e');   // ...and down, tip lit
    keyEdge(x + 1, y - 3, 1, 1, 0.26);
    px(x + 7, y - 6, 2, 1, '#2a6a36'); px(x + 8, y - 5, 2, 2, '#2a6a36');   // east frond (shade side)
    px(x + 9, y - 3, 2, 2, '#2a6a36'); px(x + 10, y - 3, 1, 1, '#4aa45a');
    rimEdge(x + 9, y - 3, 2, 2, 0.20);                          // sky bounce on the shaded fronds
    px(x + 3, y, 2, 2, '#256032'); px(x + 3, y + 2, 1, 2, '#256032');       // west drooper over the rim
    px(x + 8, y, 2, 2, '#1f5228'); px(x + 9, y + 2, 1, 2, '#1f5228');       // east drooper
    px(x + 5, y - 3, 1, 1, '#1f5228'); px(x + 6, y, 1, 3, '#1f5228');       // stem shadows into the pot
    px(x + 8, y + 7, 1, 2, '#56645c');                          // moisture probe — a dead metal stake, never a lamp
    px(x + 8, y + 7, 1, 1, '#3c4a46');                           // its unlit head, read by shape not by glow
  };


  /* ---- DECOR EXPANSION (2026-07-15): theming set, same v2 oblique kit ---- */


  F.lavalamp = (x, y, w, h, f) => {   // v4 lava lamp — tall tapered glass, wax lit from INSIDE with falloff
    const r = RAMP.steel;
    shadow2(x + 3, y + 11, 6);
    // pedestal foot + cap are the only metal; keeping them small is what makes the glass read as glass
    chamf(x + 3, y + 8, 6, 4, LINE, 1);
    px(x + 4, y + 9, 4, 1, r.top); keyEdge(x + 4, y + 9, 2, 1, 0.26);
    px(x + 4, y + 10, 4, 1, r.face); px(x + 4, y + 11, 4, 1, r.ao);
    rimEdge(x + 7, y + 9, 1, 2, 0.20);
    // tapered glass: narrow neck widening to the base, drawn as an outline shell over a dark interior
    px(x + 4, y - 6, 4, 3, LINE); px(x + 3, y - 3, 6, 5, LINE); px(x + 2, y + 2, 8, 7, LINE);
    px(x + 5, y - 5, 2, 3, '#1a0d1c'); px(x + 4, y - 2, 4, 4, '#1a0d1c'); px(x + 3, y + 2, 6, 6, '#1a0d1c');
    px(x + 5, y - 5, 1, 3, '#33203a'); px(x + 4, y - 2, 1, 4, '#33203a'); px(x + 3, y + 2, 1, 6, '#33203a');
    keyEdge(x + 3, y + 3, 1, 4, 0.18);                          // the warm key rides the west curve of the glass
    rimEdge(x + 8, y + 3, 1, 4, 0.24);                          // cold sky on the east curve
    px(x + 4, y - 7, 4, 1, r.top); px(x + 5, y - 8, 2, 1, r.face);   // metal cap
    keyEdge(x + 4, y - 7, 2, 1, 0.26);
    // wax: a hot pool at the bottom and two blobs on offset clocks (kept). The lamp is the light source,
    // so the glow starts INSIDE the glass and falls off outward.
    px(x + 4, y + 5, 4, 3, '#a63d8f'); px(x + 4, y + 5, 4, 1, '#c44ba6');
    bloom(x + 4, y + 5, 4, 3, '#ff6ad5', 0.24);                 // the pool is the brightest thing in the prop
    const b1 = y + 4 - Math.floor(((now / 620) + x) % 11);      // wraps bottom -> top (kept clocks)
    const b2 = y + 4 - Math.floor(((now / 940) + x * 3 + 5) % 11);
    for (const by of [b1, b2]) {
      if (by > y + 4 || by < y - 5) continue;
      const half = (by < y - 2) ? 5 : (by < y + 2 ? 4 : 3);     // keep the blob inside the taper
      px(x + half, by, 2, 2, '#ff6ad5');
      px(x + half, by, 1, 1, '#ffc4ee');                        // blob highlight
      bloom(x + half, by, 2, 2, '#ff6ad5', 0.20);
    }
    bloom(x + 3, y - 3, 6, 11, '#ff6ad5', 0.09 + 0.05 * (flick(1100, x) * 0.5 + 0.5));   // kept breathing haze
  };

  F.crt_pile = (x, y, w, h, f) => {   // v4 scrap stack — two dead CRTs, the top tube still whispering static
    // blocks:true: a genuine solid on the deck, so it keeps its full contact shadow and its mass. The
    // OVERHANG of the top set is the silhouette — a neatly aligned stack reads as a cabinet.
    const r = RAMP.gun;
    shadow2(x + 1, y + 11, 10);
    // bottom CRT, face-on, dead
    chamf(x, y + 4, 11, 8, LINE, 1);
    px(x + 1, y + 5, 9, 6, r.face);
    px(x + 1, y + 5, 9, 1, r.lit); keyEdge(x + 1, y + 5, 5, 1, 0.20);
    px(x + 9, y + 6, 1, 4, r.dk); rimEdge(x + 9, y + 6, 1, 4, 0.20);
    px(x + 1, y + 10, 9, 1, r.ao);
    inset(x + 2, y + 6, 5, 4, '#0a0f12');
    px(x + 3, y + 7, 3, 1, '#161f1a'); px(x + 3, y + 8, 1, 1, '#121a16');   // dead glass keeps a reflection
    px(x + 8, y + 6, 2, 1, '#222c32'); px(x + 8, y + 7, 2, 1, '#222c32');   // vent slits
    px(x + 8, y + 9, 1, 1, '#2a1414');                          // dead power LED
    wear(x + 1, y + 5, 9, 5, 4, U.shade(r.face, -0.14));
    // top CRT, smaller and shoved askew so the stack looks dumped, not shelved
    chamf(x + 2, y - 4, 9, 9, LINE, 1);
    px(x + 3, y - 3, 7, 7, r.top);
    px(x + 3, y - 3, 7, 1, r.sheen); keyEdge(x + 3, y - 3, 4, 1, 0.28);
    px(x + 9, y - 2, 1, 5, r.dk); rimEdge(x + 9, y - 2, 1, 5, 0.22);
    px(x + 3, y + 3, 7, 1, U.shade(r.top, -0.30));
    const st = flick(70, x) > 0.55;                             // intermittent static burst (kept)
    inset(x + 4, y - 2, 5, 5, st ? '#16281f' : '#0c1114');
    px(x + 5, y - 1, 3, 1, st ? '#2e5a44' : '#141d18');         // idle is never a black hole
    if (st) {
      px(x + 5 + ((now >> 4) % 3), y, 1, 1, ACC.work);          // wandering hot pixel (kept)
      scanl(x + 5, y - 1, 3, 3, 0.30);
      bloom(x + 5, y - 1, 3, 3, ACC.work, 0.16);
    }
    cable(x + 2, y + 10, x - 1, y + 11, 1.2, '#0e1418');        // dead lead spilling west onto the deck
  };

  F.cablerun = (x, y, w, h, f) => {   // v4 taped floor loom (2x1) — FLAT paint, walk-over, zero rise
    // Agents cross this constantly, so the whole prop lives in the ground plane: no oblique body, no front
    // face, no contact shadow. Depth comes from the strands separating and the tape lying on top of them.
    // v4's three strands were #2c383f / #161d21 / #080c0e — the lower two sit within a couple of values of
    // the deck itself, so two thirds of the bundle was invisible and the prop read as a lone taped box with a
    // blue light on it. Each strand now has its own JACKET COLOUR (that is also what a real loom looks like:
    // you bundle cables so you can still tell them apart) and every one clears the plating.
    const HI = '#7d8b96', MD = '#4a5a54', LO = '#5c4436';
    // three strands, each sagging on its own line so the bundle reads as rope rather than a painted bar
    for (let i = 0; i < 3; i++) {
      const yy = y + 5 + i, c = i === 0 ? HI : (i === 1 ? MD : LO);
      for (let sx = 0; sx < w; sx++) {
        const s = Math.round(Math.sin((sx / w) * Math.PI) * 1.6);
        px(x + sx, yy + s, 1, 1, c);
        px(x + sx, yy + s + 1, 1, 1, U.shade(c, -0.52));         // each strand's own underside shadow
      }
    }
    // gaffer tape crossings pinning the loom to the deck — painted flat, with a peeling corner
    for (const tx of [x + 5, x + w - 9]) {
      px(tx, y + 4, 4, 6, '#3a3426');
      px(tx, y + 4, 4, 1, '#4c4430'); keyEdge(tx, y + 4, 4, 1, 0.14);
      px(tx + 1, y + 9, 2, 1, '#2a2418');                       // corner lifting off the plate
      wear(tx, y + 4, 4, 6, 2, '#2f2a1e');
    }
    // one frayed strand escaping the bundle, and a flat inline connector block
    px(x + 10, y + 3, 3, 1, '#0e1418'); px(x + 13, y + 2, 2, 1, '#0e1418');
    px(x + 15, y + 5, 4, 3, '#1c2429'); px(x + 15, y + 5, 4, 1, '#2c383f'); px(x + 16, y + 6, 2, 1, '#0a0e11');
    if (blink(2400, x)) { px(x + 15, y + 2, 1, 1, ACC.flow); bloom(x + 15, y + 2, 1, 1, ACC.flow, 0.30); }  // rare stray spark (kept)
    // the PACKET: one live datum running the loom. Flat light on a flat prop — a bloom ring, no rise.
    const pxp = x + 1 + Math.round((now / 14) % (w - 5));
    bloom(pxp, y + 6, 3, 1, ACC.data, 0.34);
    px(pxp, y + 6, 3, 1, U.shade(ACC.data, -0.10));
  };

  F.hazardpad = (x, y, w, h, f) => {   // v4 hazard decal (2x1) — pure deck PAINT, walk-over, zero rise
    // This is paint on plating and nothing else: no body, no shadow, no lip. Its job is to say "keep clear"
    // and then get walked over without an agent ever appearing to clip through it.
    // v4 painted the stripes onto BARE DECK: there was no pad body, and the alternating band was #141a1e —
    // within a couple of values of the floor itself. So only every other stripe rendered, over nothing, and
    // the prop read as three loose yellow scribbles lying on the plating. The decal now has a real painted
    // ground, and both stripe colours sit clear of the deck's value.
    const Y = '#9a8038', YD = '#6b5827', K = '#232b31';
    px(x + 1, y + 1, w - 2, h - 2, '#1b2227');                  // the painted ground — this is what was missing
    // Parity comes off a COUNTER, never off (i / step): the loop starts negative and only lands on integer
    // multiples when the step happens to divide h, so deriving it from i silently drops every yellow band.
    for (let i = -h, k = 0; i < w; i += 5, k++) {               // diagonal caution bands, clipped to the pad
      const lit = k % 2 === 0;
      for (let j = 2; j < h - 2; j++) {
        const sx = x + i + j, L = Math.max(x + 1, sx), R = Math.min(x + w - 1, sx + 3);
        if (R > L) px(L, y + j, R - L, 1, lit ? (j < h / 2 ? Y : YD) : K);
      }
    }
    px(x + 1, y + 1, w - 2, 1, '#2f3940'); px(x + 1, y + h - 2, w - 2, 1, '#10161a');   // border rails
    px(x + 1, y + 1, 1, h - 2, '#2a343a'); px(x + w - 2, y + 1, 1, h - 2, '#10161a');
    // flat two-temperature split: the ceiling strips fall on the north half, the cold bounce fills the south.
    // On a decal this is the ONLY light cue there is — there are no facets to shade.
    keyEdge(x + 2, y + 2, w - 4, 2, 0.10);
    rimEdge(x + 2, y + h - 5, w - 4, 2, 0.08);
    // WEAR is the whole story of a hazard pad: the stripes get walked off first down the middle
    wear(x + 1, y + 2, w - 2, h - 4, 14, '#242c30');
    ctx.globalAlpha = 0.18; px(x + 4, y + 4, w - 8, 3, '#0c1013'); ctx.globalAlpha = 1;   // traffic scuff track
    ctx.globalAlpha = 0.11; px(x + 6, y + 3, w - 12, 1, '#0c1013'); px(x + 7, y + 7, w - 14, 1, '#0c1013'); ctx.globalAlpha = 1;
    px(x + 2, y + 2, 2, 1, '#242c30'); px(x + w - 4, y + h - 3, 2, 1, '#242c30');   // chipped corners
    px(x + 1, y + 5, 1, 2, '#2a3236'); px(x + w - 2, y + 6, 1, 2, '#2a3236');       // rails scuffed through
  };

  F.tallplant = (x, y, w, h, f) => {   // v4 floor planter (BLOCKS) — heavy barrel + a tower of upright blades
    const r = RAMP.gun, ph = (f && f.x) || 0;
    const sway = flick(1400, ph + x) > 0 ? 1 : 0;                    // slow top-growth sway (kept)
    shadow2(x + 2, y + 11, 8);                                       // real floor contact — this one BLOCKS
    // TOP-BIAS OBLIQUE barrel: soil surface we look down on, short banded face
    chamf(x + 1, y + 3, 10, 9, LINE, 2);
    chamf(x + 2, y + 4, 8, 3, '#241c14', 1);
    px(x + 3, y + 4, 6, 1, '#33281c');                               // back of the soil catches the ceiling strip
    px(x + 4, y + 5, 2, 1, '#1a140e');                               // a dug hollow, so the soil isn't a flat slab
    px(x + 2, y + 6, 8, 1, r.top); keyEdge(x + 2, y + 6, 5, 1, 0.26);
    px(x + 2, y + 7, 8, 4, r.face);
    px(x + 2, y + 7, 1, 4, r.lit); px(x + 9, y + 7, 1, 4, r.dk);
    rimEdge(x + 9, y + 7, 1, 4, 0.22);                               // cool bounce down the shade flank
    px(x + 2, y + 9, 8, 1, U.shade(r.face, -0.40));                  // barrel band
    px(x + 2, y + 10, 8, 1, r.ao);
    wear(x + 2, y + 7, 8, 4, 3, U.shade(r.face, -0.14));
    // FOLIAGE = a tight COLUMN of upright blades. Shape is the whole job at 12px: this is the only plant in
    // the batch that reads as a vertical tower, which is how it stays tellable from monstera/bonsai/flytrap.
    const BL = [[3, 9, -2, 1], [4, 13, -1, 2], [5, 18, 0, 2], [7, 14, 2, 2], [8, 10, 3, 1]];
    for (let i = 0; i < BL.length; i++) {
      const b = BL[i], bh = b[1], bw = b[3];
      for (let j = 0; j < bh; j++) {
        const t = j / (bh - 1);
        const sx = x + b[0] + Math.round(t * t * b[2]) + (t > 0.66 ? sway : 0);
        px(sx - 1, y + 3 - j, bw + 2, 1, '#0d1c12');                 // dark edge gives each blade real mass
        px(sx, y + 3 - j, bw, 1, t > 0.72 ? '#3a9a4e' : t > 0.34 ? '#2e7a3e' : '#1f5228');
      }
      const tipX = x + b[0] + Math.round(b[2]) + sway;
      if (i !== 0) px(tipX, y + 4 - bh, 1, 1, '#5ec46e');            // lit blade tips
    }
    keyEdge(x + 4, y - 13, 2, 4, 0.14);                              // warm key down the sunward blades
    rimEdge(x + 9, y - 7, 1, 6, 0.14);                               // cool sky on the shade side of the tower
    px(x + 9, y + 2, 2, 2, '#1f5228'); px(x + 10, y + 4, 1, 2, '#1f5228');   // one tendril flopping over the rim
    // NO status lamp. A blinking cyan "bioluminescent bud" floated one pixel clear of the tallest blade, so it
    // read as a free-standing indicator light hovering over a houseplant. Emissive blinks are this station's
    // TELEMETRY vocabulary (connector state, workbench pulse, cap surges) — spending it on a pot plant both
    // lies about the object and dilutes the lamps that carry real state. The sway is the only motion a planter
    // earns, because air handling is a mechanism that actually exists here.
  };


  F.terrarium = (x, y, w, h, f) => {   // v4 sealed tank (BLOCKS) — glass box on a stand, a moss colony breathing
    const r = RAMP.steel, ph = (f && f.x) || 0;
    shadow2(x + 2, y + 11, 8);                                       // real floor contact — this one BLOCKS
    leg(x + 3, y + 8, 3, r); leg(x + 8, y + 8, 3, r);
    underAO(x + 3, y + 9, 6, 2);
    // GLASS BOX is the whole silhouette — a hard rectangle, which is what keeps it apart from the plants
    chamf(x, y - 5, 11, 13, LINE, 1);
    px(x + 1, y - 3, 9, 10, '#0e1a1c');                              // tank void, never dead black
    px(x + 1, y - 4, 9, 2, r.top); px(x + 2, y - 4, 7, 1, r.sheen);  // sealed lid casting we look down on
    keyEdge(x + 2, y - 4, 5, 1, 0.28);
    px(x + 1, y - 2, 9, 1, U.shade(r.top, -0.34));                   // lid underside AO onto the glass
    px(x + 1, y - 2, 1, 10, '#31424a');                              // west pane catches the strip
    px(x + 2, y - 2, 1, 4, '#223036');
    px(x + 9, y - 2, 1, 10, '#142024'); rimEdge(x + 9, y - 2, 1, 10, 0.20);   // cool sky down the shade pane
    px(x + 1, y + 7, 9, 1, r.dk);                                    // base channel the panes seat into
    // moss colony: a humped bed, not a flat stripe — the humps are what read as living matter at 12px
    px(x + 2, y + 4, 7, 3, '#12301e');
    px(x + 2, y + 3, 3, 1, '#1d5c34'); px(x + 6, y + 3, 3, 1, '#1d5c34');
    px(x + 3, y + 2, 2, 1, '#2e7a3e'); px(x + 7, y + 2, 1, 1, '#256032');
    px(x + 5, y + 1, 1, 2, '#3a9a4e');                               // one taller frond
    bloom(x + 2, y + 2, 7, 5, ACC.work, 0.10 + 0.07 * (flick(900, ph + x) * 0.5 + 0.5));   // the colony breathing
    spill(x + 2, y + 6, 7, ACC.work, 0.14, 3);                       // its light pooling on the tank floor
    const sy = y + 3 - Math.floor(((now / 800) + ph + x) % 7);       // one spore drifting up (kept behaviour)
    px(x + 3 + Math.floor(((now / 1300) + ph + x) % 5), sy, 1, 1, '#7dffb0');
    px(x + 8, y - 1, 1, 2, '#3a4a52');                               // condensation on the east pane — it sits, it
    px(x + 8, y - 3, 1, 1, '#16302a');                               // does not flash. Seal fitting, unlit: the
    // colony's own glow (the bloom + spore drift above) is this tank's life. A green seal LAMP on top of it was a
    // second, fake voice claiming the lid had a sensor — keep the biology, drop the instrumentation.
  };

  /* ---- DECOR EXPANSION wave 2 (2026-07-15): grime + machinery + glow ---- */


  F.holopet = (x, y, w, h, f) => {   // v4 holo jellyfish — FLUSH deck emitter, walk-over; nothing solid at all
    const ph = (f && f.x) || 0;
    // The emitter is INLAID in the deck (2 rows, no rise) because agents walk straight over this tile; the
    // pet itself is light, so it never gets a contact shadow.
    px(x + 3, y + 8, 6, 2, '#0a0e11');
    px(x + 4, y + 8, 4, 1, '#1a232a'); px(x + 4, y + 9, 4, 1, U.shade('#1a232a', 0.26));
    px(x + 5, y + 8, 2, 1, blink(900, ph + x) ? ACC.data : U.shade(ACC.data, -0.55));   // emitter eye (kept)
    bloom(x + 4, y + 8, 4, 2, ACC.data, 0.16);                       // light pooling on the deck plating
    const bob = Math.round(Math.sin(now / 900 + ph + x) * 2);
    const sway = Math.round(Math.sin(now / 700 + ph + x + 1.3));
    const by = y - 2 + bob;
    for (let i = 0; i < 4; i++) {                                    // the projection CONE, widening upward
      ctx.globalAlpha = 0.11 - i * 0.022;
      px(x + 4 - i, y + 6 - i * 2, 2 + i * 2, 2, ACC.data);
    }
    ctx.globalAlpha = 1;
    // BELL: one bold dome is the whole silhouette — tentacles are texture, the bell is the read
    px(x + 4, by - 3, 4, 1, '#2c8ca8');
    px(x + 3, by - 2, 6, 2, '#3fb6d9');
    px(x + 4, by - 2, 2, 1, '#bfeaff');                              // bell highlight, west
    rimEdge(x + 8, by - 2, 1, 2, 0.24);
    px(x + 3, by, 6, 1, '#2c8ca8');                                  // bell rim
    px(x + 5, by - 1, 2, 1, blink(700, ph + x) ? '#ffc4ee' : '#ff6ad5');   // pulsing core (kept)
    bloom(x + 3, by - 3, 6, 4, ACC.data, 0.17);
    for (let i = 0; i < 4; i++) {                                    // four trailing tentacles, lagging drift
      const tx = x + 3 + i * 2 + ((i % 2) ? sway : 0);
      px(tx, by + 1, 1, 2 + (i % 2), '#2c8ca8');
      px(tx, by + 3 + (i % 2), 1, 1, '#1c5a70');
    }
    if (blink(180, ph + x)) px(x + 3 + ((now >> 6) % 6), by, 1, 1, '#0e2a36');   // hologram dropout scanline
  };

  F.plasmaglobe = (x, y, w, h, f) => {   // v5 TABLE globe — plasma orb on a weighted base, mount:'surface'
    const r = RAMP.steel, ph = (f && f.x) || 0;
    // v4 was a wall sconce: cradle ring, stub arm, bulkhead plate, and deliberately no deck contact. That
    // is a fine object but it hung in mid-air wherever it was placed, because nothing checked for a wall
    // behind it — the same mid-air failure the hanging monstera had. It is a TABLE object now, which is
    // what it always wanted to be, so the bracket becomes a real weighted base and the paint runs all the
    // way to the footprint bottom (mount:'surface' seats a prop by its own contact line — see draw()).
    px(x + 3, y + 9, 6, 3, LINE);                                    // base disc, sitting ON the surface
    px(x + 4, y + 10, 4, 1, r.top); keyEdge(x + 4, y + 10, 3, 1, 0.24);
    px(x + 4, y + 11, 4, 1, U.shade(r.face, -0.34));
    rimEdge(x + 7, y + 10, 1, 2, 0.18);
    px(x + 5, y + 6, 2, 4, LINE); px(x + 5, y + 7, 1, 3, r.lit); px(x + 6, y + 7, 1, 3, r.dk);   // stem
    px(x + 3, y + 5, 6, 2, LINE); px(x + 4, y + 5, 4, 1, r.top); keyEdge(x + 4, y + 5, 3, 1, 0.22);
    px(x + 4, y + 6, 4, 1, U.shade(r.face, -0.34));                  // cradle ring the sphere seats into
    // the sphere seats DOWN into the cradle now (it used to float two rows clear of the old stub arm)
    const cxp = x + 5.5, cyp = y - 0.5;
    for (let q = y - 6; q <= y + 5; q++) for (let p = x + 1; p <= x + 10; p++) {
      const dx = p + 0.5 - cxp, dy = q + 0.5 - cyp, d = Math.sqrt(dx * dx + dy * dy);
      if (d > 4.9) continue;
      px(p, q, 1, 1, d > 4.2 ? LINE : d > 3.6 ? '#1e1830' : '#140f1e');   // glass shell over a dark interior
    }
    px(x + 2, y - 2, 1, 3, '#3d3059'); px(x + 3, y - 4, 1, 1, '#4b3c69');   // NW glint on the glass
    rimEdge(x + 8, y, 1, 4, 0.22);                                   // cool sky bounce on the shade side
    px(x + 5, y - 1, 2, 2, '#b47aff'); px(x + 5, y - 1, 1, 1, '#f2e6ff');   // electrode core
    const a1 = Math.floor((now / 130) + ph + x) % 4, a2 = Math.floor((now / 190) + (ph + x) * 3) % 4;
    const TIP = [[x + 2, y - 2], [x + 9, y - 1], [x + 3, y + 2], [x + 8, y + 3]];
    for (const pair of [[a1, 1], [a2, 0]]) {                         // two arcs re-rooting on their own clocks
      const t = TIP[pair[0]], mx = (t[0] + x + 5) >> 1, my = (t[1] + y - 1) >> 1;
      px(mx, my, 1, 1, pair[1] ? '#b47aff' : '#8a4ae0');
      px(t[0], t[1], 1, 1, '#f2e6ff');                               // hot tip kissing the glass
    }
    bloom(x + 3, y - 3, 6, 7, '#8a4ae0', 0.15 + 0.07 * (flick(300, ph + x) * 0.5 + 0.5));
    spill(x + 4, y + 6, 4, '#8a4ae0', 0.16, 3);                      // violet pooling down the stem and base
  };


  F.gachapon = (x, y, w, h, f) => {   // v4 capsule machine (BLOCKS) — steel cabinet, DOME of bright capsules
    const r = RAMP.steel, ph = (f && f.x) || 0;
    const CAPS = ['#ff6ad5', '#41ff8a', '#ffd34a', '#4ad9ff', '#b47aff', '#ff8a4a'];
    shadow2(x + 2, y + 11, 8);                                       // real floor contact — this one BLOCKS
    // cabinet stays on the shared ramp: the law puts identity in the accents, so the CAPSULES carry the
    // carnival, not the casing. One red trim band is all the fairground this needs.
    chamf(x + 1, y + 2, 10, 10, LINE, 2);
    chamf(x + 2, y + 3, 8, 8, r.face, 1);
    px(x + 2, y + 3, 8, 1, r.top); keyEdge(x + 2, y + 3, 5, 1, 0.26);
    px(x + 2, y + 4, 1, 6, r.lit); px(x + 9, y + 4, 1, 6, r.dk); rimEdge(x + 9, y + 4, 1, 6, 0.22);
    px(x + 2, y + 5, 8, 1, '#a03448');                               // one carnival trim band, all it needs
    px(x + 2, y + 6, 8, 1, U.shade('#a03448', -0.45));
    px(x + 2, y + 10, 8, 1, r.ao);
    px(x + 3, y + 7, 1, 2, '#0c1013'); px(x + 3, y + 7, 1, 1, r.sheen);      // coin slot
    px(x + 7, y + 7, 2, 2, '#caa84a'); px(x + 7, y + 7, 1, 1, '#e8d070');    // brass crank
    px(x + 4, y + 8, 3, 2, '#0a0e11'); px(x + 4, y + 8, 3, 1, U.shade(r.face, 0.18));   // prize flap
    // GLASS DOME — a real dome, not a box lid; the round crown over a square cabinet IS the silhouette
    for (let j = 0; j < 8; j++) {
      const hw = j < 1 ? 2 : j < 2 ? 3 : 4;
      px(x + 5 - hw, y - 5 + j, hw * 2 + 1, 1, j === 0 ? LINE : '#101a1c');
      px(x + 4 - hw, y - 5 + j, 1, 1, LINE); px(x + 6 + hw, y - 5 + j, 1, 1, LINE);
    }
    px(x + 3, y - 4, 1, 4, '#33474f');                               // dome glint, west
    rimEdge(x + 8, y - 2, 1, 4, 0.20);                               // cool sky down the east of the glass
    for (let i = 0; i < 9; i++) {                                    // the capsules ARE the colour identity
      const hx = U.hash('cap' + i + ph + x);
      px(x + 2 + (hx % 7), y - 3 + ((hx >> 4) % 5), 1, 1, CAPS[i % CAPS.length]);
    }
    bloom(x + 3, y - 3, 6, 5, ACC.flow, 0.07 + (blink(1000, ph + x) ? 0.06 : 0));   // marquee twinkle, falls off
    px(x + 1, y + 2, 10, 1, r.top); px(x + 2, y + 2, 8, 1, r.sheen); // dome collar / cabinet crown
    keyEdge(x + 2, y + 2, 5, 1, 0.24);
    const t = ((now / 3400) + (ph + x) * 0.7) % 1;                   // a capsule drops the chute (kept behaviour)
    if (t < 0.22) {
      const cy = Math.min(y - 1 + Math.floor(t * 40), y + 8);
      px(x + 5, cy, 1, 1, CAPS[Math.floor(ph + x + now / 3400) % CAPS.length]);
    }
  };




  /* ---- DECOR EXPANSION wave 3 (2026-07-15): greenery + lounge ---- */


  F.monstera = (x, y, w, h, f) => {   // v5 FLOOR planter — three split paddle leaves standing over a heavy pot
    const ph = (f && f.x) || 0;
    const nod = blink(2000, ph + x) ? 1 : 0;                          // air handling moving the crown leaf
    // v4 hung this from the overhead: basket in the top half, leaf skirt filling the bottom, cords reaching
    // north into nothing. Two things killed it. The cords terminated MID-AIR — this projection draws no
    // ceiling, so there was never anything up there to hang off — and the reading order came out inverted
    // (container above, foliage below), which at 12px is a box with a green beard, not a plant. It stands on
    // the deck now, which is also simply what a monstera is. It still owns a silhouette none of the other
    // greenery has: tallplant is a column of blades, bonsai is flat stacked pads, plant is thin sprigs —
    // this one is BIG PADDLES, and the fenestration slits are what name the species at any size.
    const LF_DK = '#1c4a2a', LF = '#2e7a3e', LF_LIT = '#4aa45a', LF_HI = '#6cc97c', SLIT = '#12301e';
    ctx.globalAlpha = 0.20; px(x + 1, y + 11, 10, 1, '#000'); ctx.globalAlpha = 1;   // contact shadow
    // POT — tapered, so the pot reads as a vessel and not as a crate
    chamf(x + 2, y + 6, 8, 6, LINE, 1);
    for (let j = 0; j < 4; j++) px(x + 3 + (j >> 1), y + 7 + j, 6 - (j >> 1) * 2, 1, '#5e4a34');
    px(x + 3, y + 7, 6, 1, '#7a6044'); keyEdge(x + 3, y + 7, 3, 1, 0.22);
    px(x + 3, y + 7, 1, 3, '#6d5540'); px(x + 8, y + 7, 1, 3, '#3a2c1c'); rimEdge(x + 8, y + 7, 1, 3, 0.20);
    px(x + 2, y + 6, 8, 1, '#3a2c1c'); px(x + 3, y + 6, 6, 1, '#241d14');    // rim, then soil inside it
    px(x + 4, y + 10, 4, 1, '#2a2016');
    // STEMS — two petioles leaning apart out of the soil; a monstera never grows straight up in one line
    px(x + 5, y + 3, 1, 3, LF_DK); px(x + 6, y + 2, 1, 4, LF_DK);
    px(x + 4, y + 5, 1, 1, LF_DK); px(x + 7, y + 5, 1, 1, LF_DK);
    // THREE PADDLES, each cut by a fenestration slit — west, east, then the crown standing above both
    // The three are drawn back-to-front and each is separated by a hard dark edge — without that they merge
    // into one green mass and the prop reads as a hedge, which is the same fusing failure the poker board had.
    px(x, y + 2, 5, 4, LF); px(x, y + 2, 5, 1, LF_LIT); keyEdge(x, y + 2, 3, 1, 0.24);
    px(x + 2, y + 3, 1, 2, SLIT); px(x, y + 5, 4, 1, LF_DK); px(x + 4, y + 3, 1, 3, SLIT);
    px(x + 7, y + 3, 5, 4, LF_DK); px(x + 7, y + 3, 5, 1, LF); px(x + 6, y + 3, 1, 4, SLIT);
    px(x + 9, y + 4, 1, 2, SLIT); px(x + 11, y + 3, 1, 3, LF_DK); rimEdge(x + 11, y + 3, 1, 3, 0.18);
    chamf(x + 2, y - 1 + nod, 8, 4, LF_LIT, 1);                             // the CROWN paddle, leaf-shaped
    px(x + 3, y - 1 + nod, 6, 1, LF_HI); keyEdge(x + 3, y - 1 + nod, 3, 1, 0.20);
    px(x + 4, y + nod, 1, 2, SLIT); px(x + 7, y + nod, 1, 2, SLIT);         // the crown's two slits
    px(x + 3, y + 2 + nod, 6, 1, SLIT);                                     // its shadow, cast onto the two below
  };


  F.fishtank = (x, y, w, h, f) => {
    // v4 LOUNGE AQUARIUM (2x1) — the point of this prop is WATER LIGHT. v3 painted the tank as one flat
    // alpha rect of cyan, which is exactly the translucent-sticker failure v4 exists to kill. Now: a depth
    // ramp from a lit surface down to a dark floor, a caustic band that actually wavers per column, and
    // ONE cold tube up in the hood whose light blooms, falls through the water and pools on the cabinet.
    // Its sibling backlit prop (quarters_vending) is flat cold fluorescent behind rows — this one moves.
    const r = RAMP.steel, ph = (f && f.x) || 0;
    const mid = '#12384a', lit = '#2a6f88', cold = '#7ad9ff';
    const tt = y - 9;                                          // hood tt..tt+1, tube tt+2, water tt+3..tt+14
    shadow2(x + 2, y + h - 1, w - 4);
    // freestanding cabinet stand — lounge tier, so stub feet on the deck, nothing bolted
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 10, 3, 2, LINE); px(lx, y + 10, 1, 2, r.lit); px(lx + 1, y + 10, 1, 2, r.dk);
      rimEdge(lx + 2, y + 10, 1, 2, 0.16);
    }
    underAO(x + 5, y + 10, w - 10, 1);
    chamf(x + 1, y + 6, w - 2, 5, LINE, 1);
    px(x + 2, y + 7, w - 4, 3, r.face);
    px(x + 2, y + 7, w - 4, 1, r.lit); keyEdge(x + 3, y + 7, w - 9, 1, 0.14);
    px(x + 2, y + 8, 1, 2, U.shade(r.face, 0.08)); px(x + w - 3, y + 8, 1, 2, r.dk);
    rimEdge(x + w - 3, y + 8, 1, 2, 0.20);
    px(x + (w >> 1) - 1, y + 7, 1, 3, '#141a1e');              // cabinet door seam
    px(x + (w >> 1) + 1, y + 8, 2, 1, U.shade(r.face, 0.26));  // door pull
    px(x + 2, y + 9, w - 4, 1, r.ao);
    // GLASS BOX, overdrawing north of the tile
    chamf(x - 1, tt - 1, w + 2, 17, LINE, 1);
    // water depth ramp — surface is lit by the tube, the floor of the tank stays genuinely dark
    for (let j = 0; j < 12; j++) px(x + 1, tt + 3 + j, w - 2, 1, U.shade(mid, 0.34 - j * 0.058));
    // CAUSTICS: a per-column shimmer under the surface, two beat frequencies so it never reads as a loop
    for (let i = 0; i < w - 2; i++) {
      const s = Math.sin(now / 620 + i * 0.55 + ph) + 0.7 * Math.sin(now / 410 + i * 0.31);
      const d = 1 + Math.max(0, Math.round(s));
      px(x + 1 + i, tt + 3, 1, d, U.shade(lit, 0.24 - d * 0.06));
    }
    for (let i = 0; i < w - 4; i += 3) {                       // ripple net thrown down onto the gravel
      const a = Math.sin(now / 780 + i * 0.42 + ph);
      px(x + 2 + i + (a > 0 ? 1 : 0), tt + 11 + Math.round(a), 2, 1, U.shade(mid, 0.30));
    }
    // gravel bed + planting + the castle every crew aquarium is legally required to contain
    px(x + 1, tt + 12, w - 2, 3, '#332e22'); px(x + 1, tt + 12, w - 2, 1, '#463f2c');
    px(x + 3, tt + 12, 3, 1, '#514830'); px(x + w - 7, tt + 13, 3, 1, '#282316');
    px(x + w - 8, tt + 8, 4, 5, '#46525f'); px(x + w - 8, tt + 8, 4, 1, '#5d6b79');
    px(x + w - 7, tt + 6, 2, 3, '#46525f'); px(x + w - 7, tt + 6, 2, 1, '#5d6b79');   // turret
    px(x + w - 6, tt + 10, 1, 2, '#0e1216');                   // castle door
    for (let j = 0; j < 6; j++) {                              // waterweed swaying on the tube's clock
      const sw = Math.round(Math.sin(now / 1100 + j * 0.5 + ph) * 1.2);
      px(x + 3 + (j > 3 ? 2 : 0) + sw, tt + 13 - j, 1, 1, j > 3 ? '#2e7a3e' : '#1d5c34');
    }
    // FISH — silhouetted dark against the lit water up top, catching the tube on their backs
    for (const spec of [[0, 2600, tt + 5, '#ffd34a'], [3, 3400, tt + 9, '#ff6ad5'], [1.4, 4200, tt + 7, '#7fd0c0']]) {
      const t = ((now / spec[1]) + spec[0] + ph) % 2, flip = t < 1;
      const fx = x + 2 + Math.round((flip ? t : 2 - t) * (w - 7)), c = spec[3];
      px(fx, spec[2], 2, 1, c); px(fx, spec[2], 1, 1, U.shade(c, 0.30));   // lit back
      px(fx + (flip ? -1 : 2), spec[2], 1, 1, U.shade(c, -0.38));          // tail behind
      px(fx + (flip ? 1 : 0), spec[2] + 1, 1, 1, U.shade(c, -0.55));       // belly in shade
    }
    // bubbler column off the castle, drifting and widening as it rises
    for (let b = 0; b < 3; b++) {
      const bh = Math.floor((now / 260 + b * 3) % 11);
      px(x + w - 6 + (bh > 5 ? 1 : 0), tt + 12 - bh, 1, 1, U.shade(cold, -0.10 - bh * 0.03));
    }
    // glass: west glint, cool east rim, and the waterline meniscus
    px(x + 1, tt + 3, 1, 12, U.shade(lit, 0.18)); px(x + w - 2, tt + 3, 1, 12, U.shade(mid, -0.30));
    rimEdge(x + w - 2, tt + 3, 1, 12, 0.18);
    px(x + 1, tt + 4, w - 2, 1, U.shade(lit, 0.34));           // meniscus
    ctx.globalAlpha = 0.10; px(x + 2, tt + 5, 2, 7, '#dff4ff'); px(x + 5, tt + 5, 1, 4, '#dff4ff'); ctx.globalAlpha = 1;
    px(x + 1, tt + 15, w - 2, 1, U.shade(r.face, -0.30));      // tank base frame sitting on the cabinet
    // HOOD + the single cold tube — the tank's only emitter, with real falloff both ways
    chamf(x - 1, tt - 1, w + 2, 4, LINE, 1);
    px(x, tt, w, 2, r.top); px(x, tt, w, 1, r.sheen); keyEdge(x + 1, tt, 7, 1, 0.24);
    px(x, tt + 1, 1, 1, r.lit); px(x + w - 1, tt + 1, 1, 1, r.dk);
    px(x + 2, tt + 2, w - 4, 1, '#d6f2ff');                    // the tube under the hood lip
    bloom(x + 2, tt + 2, w - 4, 1, cold, 0.32);
    spill(x + 1, tt + 3, w - 2, cold, 0.24, 5);                // light falling DOWN through the water
    spill(x + 2, y + 6, w - 4, cold, 0.18, 3);                 // and pooling out onto the cabinet top
    glow(x + 3, y + 10, w - 6, 2, cold, 0.07 + 0.03 * Math.sin(now / 900 + ph));  // faint cold wash on the deck
  };

  F.pokertable = (x, y, w, h) => {
    // v5 POKER (4x2) — TOP-BIAS OBLIQUE. It stays the deliberate OPPOSITE of F.quarters_pooltable on the
    // four axes v4 locked (oval vs rectangle · one pedestal vs four legs · studded black leather vs
    // mahogany-and-diamonds · indigo under low ambient vs green under tungsten), but the art is rebuilt,
    // because v4 lost the read completely — in-game it scanned as a monitor on a mic stand. Four causes:
    //   1. The rail roll was EIGHT px deep on a 48px table, so felt — the one thing that says "card
    //      table" — survived only as a slot. The roll is now a 4px PERPENDICULAR offset off a true
    //      RACETRACK capsule (semicircular ends, straight sides), which is the plan shape of a real
    //      poker table, and felt owns the top surface again.
    //   2. The pedestal was drawn with U.shade(rail, +0.46). Lightening a NEAR-BLACK desaturates it
    //      toward grey, so the base rendered as brushed steel under a black oval. Dark materials need
    //      AUTHORED lit tones (LEA_MID/LEA_LIT below) — never a large positive shade().
    //   3. Five near-white board cards, two seat stacks, a five-colour chip tray and four pot stacks all
    //      landed inside the middle 20px and fused into one pale block. There are now exactly TWO bright
    //      clusters (board, pot); the seats are gone and everything else is held under the felt's value.
    //   4. There was no front face at all, so the oval floated. A short APRON now carries the table's
    //      edge thickness down to the pedestal, per the top-bias oblique law.
    // NEW: the betting line. A 1px cream racetrack ring printed on the felt is the cheapest unmistakable
    // "poker" signifier there is and it costs no brightness — and it lets the composition be honest, with
    // community cards INSIDE the line and the rail outside it, which is where they actually belong.
    // STATIC by law: nothing here has a mechanism (no dealer, no motor, no emitter), so v4's river-flip
    // clock, its blinking mid-toss chip and its pulsing "ambient" are gone — a lit room does not throb.
    const LEA_DK = '#120d10', LEA = '#1e1519', LEA_MID = '#2b2025', LEA_LIT = '#3a2b31';
    const feltDk = '#101c39', felt = '#1b2c55', feltLit = '#26406f';
    const RH = 18, rtop = y - 4, R = (RH - 1) / 2;
    // Racetrack capsule: horizontal inset of the outline lying `o` px (perpendicular) inside the rail's
    // outer edge. Returns null on rows the shape does not reach, which is what lets the ring/band helper
    // below know it is on a flat cap row.
    // The +0.5 on the radius inside the root is not slop: with a true semicircular end the extreme row
    // sits exactly on the pole, so its inset jumps 9px in one row and the outline breaks into a black
    // staircase notch. Half a pixel of extra radius flattens the cap to a 6,4,2,1,1,0 ramp — the same
    // oval, drawn as pixel art rather than as sampled geometry.
    const cap = (o) => {
      const rr = R - o;
      return (j) => {
        const dy = j - R;
        if (Math.abs(dy) > rr) return null;
        return o + Math.round(rr - Math.sqrt(Math.max(0, (rr + 0.5) * (rr + 0.5) - dy * dy)));
      };
    };
    // paint the band between two capsule offsets: the west run, the mirrored east run, or — on a row the
    // inner capsule cannot reach — the full span, which is what closes the top and bottom of a ring.
    // A colour may be a function of the row, which is how the roll takes the key on its north crown and
    // stays in shadow on the south one under a single high light.
    const band = (o0, o1, cWest, cEast) => {
      const a = cap(o0), b = cap(o1);
      const cw = typeof cWest === 'function' ? cWest : () => cWest;
      const ce = cEast == null ? cw : (typeof cEast === 'function' ? cEast : () => cEast);
      for (let j = 0; j < RH; j++) {
        const i0 = a(j); if (i0 == null) continue;
        const i1 = b(j);
        if (i1 == null) { px(x + i0, rtop + j, w - i0 * 2, 1, cw(j)); continue; }
        const t = Math.max(1, i1 - i0);
        px(x + i0, rtop + j, t, 1, cw(j));
        px(x + w - i1, rtop + j, t, 1, ce(j));
      }
    };
    const north = (j) => j < R;                              // which half of the roll the light reaches
    const outer = cap(0), inner = cap(4);
    const pcx = x + (w >> 1);
    shadow2(pcx - 12, y + h - 1, 24);
    // PEDESTAL — drawn first so the apron and the rail overhang it. The stack under the bed reads in three
    // steps: apron (the table's own edge thickness) -> turned column -> splayed cross foot. v4 had none of
    // the first two, which is why its oval hovered over a stand instead of being a table.
    chamf(pcx - 12, y + 20, 24, 4, LINE, 3);                   // splayed cross foot
    chamf(pcx - 11, y + 21, 22, 3, LEA_MID, 2);
    px(pcx - 10, y + 21, 20, 1, LEA_LIT); keyEdge(pcx - 10, y + 21, 8, 1, 0.16);
    px(pcx - 11, y + 23, 22, 1, '#0a0d10');
    rimEdge(pcx + 9, y + 21, 1, 2, 0.16);
    underAO(pcx - 9, y + 19, 18, 2);
    px(pcx - 5, y + 14, 10, 8, LINE);                          // turned column, tucked up under the apron
    px(pcx - 4, y + 15, 8, 6, LEA_MID);
    px(pcx - 4, y + 15, 1, 6, LEA_LIT); keyEdge(pcx - 4, y + 15, 1, 4, 0.20);
    px(pcx + 3, y + 15, 1, 6, LEA_DK); rimEdge(pcx + 3, y + 16, 1, 4, 0.18);
    px(pcx - 3, y + 17, 6, 1, LEA); px(pcx - 3, y + 19, 6, 1, LEA);   // turned collars
    // APRON — narrow, so it reads as the boss under the bed and not as a shelf the table is standing on
    const ax = pcx - 10, aw = 20;
    chamf(ax - 1, y + 14, aw + 2, 4, LINE, 2);
    chamf(ax, y + 15, aw, 3, LEA, 1);
    px(ax + 1, y + 15, aw - 2, 1, LEA_MID); keyEdge(ax + 2, y + 15, 7, 1, 0.14);
    px(ax + 1, y + 17, aw - 2, 1, '#0a0d10');
    // PADDED OVAL RAIL — silhouette halo, base roll, then the roll modelled as three concentric bands:
    // outer wall, lit crown, inner slope falling to the felt.
    for (let j = -1; j <= RH; j++) {
      const i = outer(Math.max(0, Math.min(RH - 1, j)));
      px(x + i - 1, rtop + j, w - i * 2 + 2, 1, LINE);
    }
    band(0, 4, LEA);                                           // the roll's body
    band(0, 1, (j) => north(j) ? LEA_MID : LEA_DK, LEA_DK);    // outer wall
    band(1, 2, (j) => north(j) ? LEA_LIT : LEA_MID,            // the crown of the padding — 1px, and the
              (j) => north(j) ? LEA_MID : LEA);                // south crown never takes the full key
    band(3, 4, LEA_DK);                                        // inner slope, dropping into the bed
    keyEdge(x + 12, rtop + 1, 14, 1, 0.16);                    // the key lands on the north-west crown
    for (let i = 0; i < 6; i++) {                              // brass upholstery studs — the leather's tell
      px(x + 11 + i * 5, rtop + 1, 1, 1, '#6e5830');
      px(x + 11 + i * 5, rtop + RH - 2, 1, 1, '#3f331d');
    }
    // FELT BED — an inner capsule, ringed by the rail's shadow and lit from the north-west
    for (let j = 0; j < RH; j++) {
      const i = inner(j); if (i == null) continue;
      px(x + i - 1, rtop + j, w - i * 2 + 2, 1, feltDk);       // rail shadow ringing the bed
      px(x + i, rtop + j, w - i * 2, 1, felt);
      const lw = Math.round((w - i * 2) * (0.86 - (j - 4) / 6));  // NW nap, falling off to the south-east
      if (lw > 0) px(x + i, rtop + j, lw, 1, feltLit);
      if (j >= 11) px(x + i, rtop + j, w - i * 2, 1, U.shade(felt, -0.20));   // bed darkens into the near rail
    }
    // NO betting line. It was tried and cut: the felt is ten rows deep, so an inner ring degenerates into
    // two long horizontal bars across the bed that out-shout the cards — and the racetrack read is already
    // carried, completely, by the rail's own silhouette.
    // THE BOARD — five community cards, inside the betting line where they belong. Two rules earn the
    // read at 48px. (1) Cards are BONE, never white — v4's #f0ece0 blew the felt out of the composition.
    // (2) NO per-card outline: at a 4px pitch the LINE boxes butt together into one continuous black
    // strip and the board turns into a filmstrip. The dark felt is already the separator; each card gets
    // only its own drop shadow, and the gap between them stays felt.
    const cy = y + 2;
    for (let i = 0; i < 5; i++) {
      const cxp = x + 14 + i * 4;
      px(cxp, cy + 1, 3, 4, feltDk);                           // the card's shadow, cast south-east
      px(cxp, cy, 2, 4, '#9c9583');
      px(cxp, cy, 2, 1, '#b2ab98');
      // one pip each, alternating suit colour and riding a different row per card — five identical faces
      // in a row read as piano keys, and the variation costs nothing
      px(cxp, cy + 1 + (i % 3 ? 1 : 0), 1, 1, i % 2 ? '#8e3040' : '#1a1e22');
    }
    // THE POT — three chip stacks east of the board: the second bright cluster, and the only warm one
    for (let s = 0; s < 3; s++) {
      const pxx = x + 35 + s * 3, hgt = [3, 4, 2][s], base = y + 6;
      const c = s === 1 ? '#8e4433' : '#a08a4e';
      px(pxx, base - hgt + 1, 3, hgt, feltDk);
      px(pxx, base - hgt, 2, hgt, U.shade(c, -0.16));
      px(pxx, base - hgt, 2, 1, U.shade(c, 0.26));
      px(pxx, base - 1, 2, 1, U.shade(c, -0.40));
    }
    px(x + 10, y + 5, 3, 2, feltDk);
    px(x + 10, y + 4, 2, 1, '#b0a996'); px(x + 10, y + 5, 2, 1, '#7d7768');   // dealer button, west of the board
    // LIGHT: no pendant here on purpose (that silhouette belongs to the pool table). What lands on the
    // felt is the room's own low warm ambient — steady, because the room's lamps are steady.
    glow(x + 10, y + 1, w - 20, 7, '#ffb84d', 0.05);
    spill(x + 12, rtop + RH, w - 24, KEY, 0.09, 3);            // room light catching under the rail's overhang
  };

  F.commswall = (x, y, w, h, f) => {
    // COMMS WALL (6x1, blocks:FALSE) — v4 REBUILD. The CATALOG says agents walk in FRONT of this, so the old
    // freestanding rack-row on stub feet was simply wrong: it is now a SHALLOW bulkhead unit hung off lugs,
    // casting onto the wall, never touching the deck. 72px is far too long for one motif stamped ten times,
    // so the span carries three DIFFERENT stations west->east — a patch bay where channels land, the QUEUE
    // glass in the middle (the hero, by area not brightness), and a channel stack that dispatches. One packet
    // crosses the whole run on the conduit rail; that is what makes it read as ONE bus instead of three props.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bt = y - 10, bh = 19;                                   // hangs y-10..y+8 — 3px of air under it
    ctx.globalAlpha = 0.20; px(x + 2, bt + 3, w, bh, '#000'); ctx.globalAlpha = 1;   // cast on the bulkhead
    for (const lx of [x + 6, x + 34, x + w - 9]) {                // wall lugs — no legs, nothing meets the floor
      px(lx, bt - 3, 2, 4, LINE); px(lx, bt - 3, 2, 1, U.shade(r.top, 0.20));
      rimEdge(lx + 1, bt - 2, 1, 3, 0.18);
    }
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 16, 1, 0.28);   // warm ceiling strip along the crown
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);                  // cool sky bounce down the shade side
    px(x + 2, bt + bh - 2, w - 4, 1, U.shade(r.face, -0.26));
    px(x + 2, bt + bh - 1, w - 4, 1, r.ao);                       // shallow underside, NOT a floor line
    // CONDUIT RAIL — the only element that crosses all three stations
    px(x + 2, bt + 2, w - 4, 2, '#0e1a17');
    px(x + 2, bt + 2, w - 4, 1, U.shade(r.face, -0.42));
    for (let i = 0; i < 4; i++) {                                 // junction boxes at the station seams
      const jx = x + 4 + i * 17;
      px(jx, bt + 1, 4, 4, LINE); px(jx + 1, bt + 2, 2, 2, U.shade(r.face, 0.10));
      px(jx + 1, bt + 2, 2, 1, r.lit);
    }
    const run = w - 13;
    const pkx = x + 4 + Math.round((now / (on ? 5 : 9) + ph * 20) % run);
    px(pkx, bt + 3, 5, 1, ACC.data); bloom(pkx, bt + 3, 5, 1, ACC.data, on ? 0.34 : 0.20);
    const tkx = x + 4 + Math.round((now / 12 + 90 + ph * 13) % run);
    px(tkx, bt + 3, 3, 1, U.shade(ACC.data, -0.34)); bloom(tkx, bt + 3, 3, 1, ACC.data, 0.12);
    // WEST — PATCH BAY: cable() sag is what sells this as wiring instead of a printed grid
    const bx0 = x + 3;
    inset(bx0, bt + 5, 18, 12, '#111a18');
    for (let rj = 0; rj < 3; rj++) for (let c = 0; c < 6; c++) {
      const jx = bx0 + 2 + c * 3, jy = bt + 7 + rj * 3;
      px(jx, jy, 2, 2, '#0a1210'); px(jx, jy, 2, 1, U.shade(r.face, -0.16));
      px(jx, jy + 1, 1, 1, U.shade(r.face, 0.06));
    }
    const cords = [[0, 0, 3, 1, ACC.work], [1, 2, 4, 0, ACC.data], [2, 1, 5, 2, ACC.flow]];
    for (let i = 0; i < 3; i++) {
      const cd = cords[i];
      cable(bx0 + 2 + cd[0] * 3, bt + 8 + cd[1] * 3, bx0 + 2 + cd[2] * 3, bt + 8 + cd[3] * 3, 2.4, U.shade(cd[4], -0.58));
      const liveJ = blink(900, i * 0.4);                          // the plug lights as its channel carries
      px(bx0 + 2 + cd[0] * 3, bt + 7 + cd[1] * 3, 2, 2, liveJ ? cd[4] : U.shade(cd[4], -0.66));
      if (liveJ) bloom(bx0 + 2 + cd[0] * 3, bt + 7 + cd[1] * 3, 2, 2, cd[4], 0.20);
    }
    // CENTRE — QUEUE GLASS. Messages march EAST and one clears off the end; idle keeps phosphor, never a hole.
    const qx = x + 23, qw = 30, qy = bt + 5, qh = 12;
    inset(qx, qy, qw, qh, '#06100f');
    px(qx + 1, qy + 1, qw - 2, qh - 2, U.shade(ACC.data, on ? -0.80 : -0.88));
    const off = Math.floor((now / (on ? 26 : 60)) % 6);
    for (let rj = 0; rj < 4; rj++) for (let k = -1; k < 6; k++) {
      const cxp = qx + 2 + k * 6 + off + (rj & 1);
      if (cxp < qx + 1 || cxp + 4 > qx + qw - 1) continue;
      const head = ((k + rj * 2) % 3) === 0;
      px(cxp, qy + 2 + rj * 2, 4, 1, head ? U.shade(ACC.data, 0.10) : U.shade(ACC.data, -0.46));
    }
    const disp = (now % 1800) / 1800;                             // one message clears the queue every 1.8s
    if (disp < 0.30) {
      const dx = qx + 2 + Math.round((disp / 0.30) * (qw - 8));
      px(dx, qy + 1, 5, 1, '#dbf7ff'); bloom(dx, qy + 1, 5, 1, ACC.data, 0.36 * (1 - disp / 0.30));
    }
    scanl(qx + 1, qy + 1, qw - 2, qh - 2, 0.20);
    bloom(qx + 1, qy + 1, qw - 2, qh - 2, ACC.data, on ? 0.15 : 0.07);
    spill(qx, qy + qh, qw, ACC.data, on ? 0.16 : 0.08, 3);
    // EAST — CHANNEL STACK. Names are dash plates, not text: 14px would give VT323 ~4 characters of mush.
    const chx = x + 55;
    inset(chx, bt + 5, 14, 12, '#0d1512');
    for (let i = 0; i < 4; i++) {
      const cy = bt + 7 + i * 3;
      const up = blink(700 + i * 210, i * 0.6);
      px(chx + 1, cy, 1, 1, up ? ACC.work : '#14291f');
      if (up) bloom(chx + 1, cy, 1, 1, ACC.work, 0.22);
      px(chx + 3, cy, 5, 1, U.shade(r.face, 0.12));               // channel name plate
      px(chx + 3, cy + 1, 4, 1, U.shade(r.face, -0.34));
      for (let b = 0; b < 3; b++) {                               // signal meter, jittering
        const lvl = 1 + Math.floor((1 + Math.sin(now / 240 + i * 1.7 + b)) * (on ? 0.9 : 0.45));
        px(chx + 9 + b, cy + 1 - (lvl - 1), 1, lvl, U.shade(ACC.data, b < 2 ? 0 : -0.3));
      }
    }
    rivets(x + 2, bt + 1, w - 4, bh - 2, U.shade(r.top, 0.22), r.ao);
    wear(x + 2, bt + 1, w - 4, bh - 2, 6, U.shade(r.face, -0.10));
  };

  F.console = (x, y, w, h, f) => {   // v4 ops console — a REAL tapered slab under a raised readout panel
    const r = RAMP.gun, ph = (f && f.x) || 0, on = !!(f && f.work);
    const TR = 9, tTop = y - 3;                                // top slab: 9 rows, tapered back->front
    const inw = j => Math.round(4 * (1 - j / (TR - 1)));       // 4px inset at the back, flush at the front
    shadow2(x + 1, y + h - 1, w - 2);                          // floor contact
    deckPlate(x - 1, y + 8, w + 2, h - 8);                     // mounting plate
    deckSocket(x - 3, y + h - 3, on);                          // conduit into floor socket, west
    cable(x + 1, y + 7, x - 3, y + h - 3, 2);                  // sagging conduit run to the socket
    for (const lx of [x + 2, x + w - 5]) {                     // corner legs on the plate
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // RAISED READOUT PANEL at the back — gives the console a profile and shades the working slab
    chamf(x + 1, y - 9, 16, 7, LINE, 2);
    chamf(x + 2, y - 8, 14, 5, r.face, 2);
    px(x + 3, y - 8, 12, 1, r.top); keyEdge(x + 3, y - 8, 6, 1, 0.26);   // warm catch along its crown
    px(x + 2, y - 7, 1, 3, r.lit); px(x + 15, y - 7, 1, 3, r.dk); rimEdge(x + 15, y - 7, 1, 3, 0.22);
    inset(x + 3, y - 7, 12, 3, '#07110b');                     // slim readout strip
    for (let i = 0; i < 10; i++) {                             // running bar histogram — station telemetry
      const v = 1 + Math.floor((1 + Math.sin(now / 260 + i * 0.9 + ph)) * (on ? 0.9 : 0.45));
      px(x + 4 + i, y - 5 + (1 - v), 1, v, on ? U.shade(ACC.work, 0.1) : U.shade(ACC.work, -0.62));
    }
    if (on) bloom(x + 4, y - 6, 10, 2, ACC.work, 0.13);
    for (let i = 0; i < 4; i++)                                // status LEDs under the strip
      px(x + 4 + i * 3, y - 4, 1, 1, blink(600 + i * 190, i) ? (i === 3 ? ACC.flow : ACC.work) : '#16241c');
    px(x + 2, y - 4, 14, 1, r.ao);                             // panel underside AO onto the slab
    // TAPERED TOP SLAB — genuinely wider toward the user; the silhouette follows the taper row by row
    for (let j = -1; j <= TR; j++) {
      const i = inw(Math.max(0, Math.min(TR - 1, j)));
      px(x + i - 1, tTop + j, w - i * 2 + 2, 1, LINE);
    }
    for (let j = 0; j < TR; j++) {
      const i = inw(j);
      px(x + i, tTop + j, w - i * 2, 1, r.top);
      px(x + i, tTop + j, 1, 1, r.lit);                        // lit west bevel, tracking the taper
      px(x + w - i - 1, tTop + j, 1, 1, r.dk);                 // dark east bevel
      rimEdge(x + w - i - 1, tTop + j, 1, 1, 0.18);            // cool sky bounce on the shade side
    }
    px(x + 3, tTop, w - 6, 1, r.sheen); keyEdge(x + 3, tTop, 7, 1, 0.24);
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.20));         // front lip of the slab
    wear(x + 2, y - 1, w - 4, 5, 3, U.shade(r.top, -0.10));
    // recessed CURVED CRT — the end rows pinch in, so the glass reads as a bulge under the panel
    const gx = x + 3, gy = y - 1, gw = 11, gh = 5, sc = scr(1 + ph);
    px(gx - 1, gy - 1, gw + 2, gh + 2, '#070c09');             // glass surround
    px(gx, gy - 1, gw, 1, U.shade(r.top, -0.45));              // recessed shadow at the top of the well
    for (let j = 0; j < gh; j++) {
      const c = (j === 0 || j === gh - 1) ? 1 : 0;
      px(gx + c, gy + j, gw - c * 2, 1, on ? U.shade(sc, -0.72) : '#101d16');   // idle glass still holds phosphor
    }
    for (let j = 0; j < 3; j++) {                              // terminal text lines (kept behavior)
      const lw = 2 + ((j * 3 + Math.floor(now / 400)) % 5);
      px(gx + 1, gy + 1 + j, Math.min(lw, gw - 2), 1, on ? '#dfffe8' : '#2c4a38');
    }
    for (let i = 0; i < gw - 2; i++)                           // live trace across the bottom of the glass
      px(gx + 1 + i, gy + 3 - Math.round(Math.max(0, Math.sin(now / 190 + i * 0.8))), 1, 1, on ? ACC.data : '#223a42');
    if (!on) px(gx + gw - 2, gy + gh - 2, 1, 1, blink(1600, ph) ? '#ff9d2e' : '#33241a'); // standby amber
    scanl(gx, gy, gw, gh, 0.20);
    if (on) { bloom(gx, gy, gw, gh, sc, 0.15); spill(gx, gy + gh, gw, sc, 0.16, 3); } // glow spills onto the slab
    // physical CONTROLS on the near-east quarter: two knobs, a toggle bank, a knurled grip
    dial(x + 15, y - 1, r.top, now / 900 + ph);
    dial(x + 19, y - 1, r.top, -now / 640 + ph);
    for (let i = 0; i < 3; i++) {                              // toggle bank, amber collars (kept blink)
      px(x + 16 + i * 2, y + 2, 1, 2, U.shade(r.face, -0.3));
      px(x + 16 + i * 2, y + 2, 1, 1, blink(600, i) ? '#ff9d2e' : '#33241a');
    }
    px(x + 16, y + 4, 6, 1, blink(800) ? ACC.flow : U.shade(ACC.flow, -0.6)); // amber status bar
    knurl(x + 3, y + 4, 10, 1, r.top);                         // machined grip strip along the front edge
    // short vented front face
    rr(x - 2, y + 5, w + 4, 5, LINE);
    px(x - 1, y + 6, w + 2, 3, r.face);
    px(x - 1, y + 6, w + 2, 1, r.lit); keyEdge(x, y + 6, w, 1, 0.14);
    px(x - 1, y + 8, w + 2, 1, r.ao);
    for (let i = 0; i < 5; i++) { px(x + 3 + i * 4, y + 7, 2, 1, r.ao); px(x + 3 + i * 4, y + 7, 1, 1, U.shade(r.face, -0.5)); }
  };

  F.crate = (x, y, w, h) => {
    // CRATE (2x1) — v6 rebuild. v4's steel version read as a grey APPLIANCE: its front face was filled
    // LINE black with only 22x5 ever painted, four 5px-pitch ribs chopped that survivor into five grey
    // blocks, and a 15px rise over a 24px footprint is the proportion of a hi-fi, not of freight.
    // Two changes fix it. (1) PROPORTION: it now rises 20px, so the silhouette is near-CUBIC and reads
    // as a crate before a single detail resolves. (2) MATERIAL: timber, not steel — plank seams and
    // cross-battens are the one universal crate signal, and the warm ramp separates it at a glance from
    // the dozen grey machines it stands beside. (Footprint gate safe: 12 of 20 painted rows sit inside.)
    const WD = '#6a512f', WD_LIT = '#8b6c44', WD_DK = '#3c2c19', WD_TOP = '#7b5f38';
    const BAT = '#4a3620', BAT_LIT = '#6d5232';                   // cross-battens, a shade below the planks
    const bT = y - 2, bH = 12;                                    // front face: y-2 .. y+9
    shadow2(x + 1, y + h - 1, w - 2);
    // ---- FRONT FACE: vertical planks. Seams run WITH the boards, never across (the longtable law).
    px(x, bT, w, bH, LINE);
    px(x + 1, bT + 1, w - 2, bH - 2, WD);
    for (let i = 1; i < 5; i++) {                                 // four seams => five planks across 22px
      const sx = x + 1 + Math.round(i * (w - 2) / 5);
      px(sx, bT + 1, 1, bH - 2, WD_DK);
      px(sx + 1, bT + 1, 1, bH - 2, U.shade(WD, 0.10));           // the next plank's lit edge
    }
    px(x + w - 2, bT + 1, 1, bH - 2, WD_DK); rimEdge(x + w - 2, bT + 2, 1, bH - 5, 0.20);
    // v6.1: wear was 7 specks over a 22x8 face and it buried the plank seams in mud. A crate's texture
    // IS its seams — the speckle only has to imply grime, so it goes to 3 and stays off the batten rows.
    wear(x + 3, bT + 4, w - 6, 3, 3, U.shade(WD, -0.22));
    // ---- BATTENS: two horizontal rails, pushed to the very top and bottom of the face so the planks
    // own the middle. A DIAGONAL brace was authored here and CUT: between the rails there were only
    // three free rows, so it came out all but horizontal and vanished into the plank seams. Don't re-add
    // it on a 2x1 — a shallow diagonal needs a face at least twice this tall to read.
    for (const by of [bT + 1, bT + bH - 4]) {
      px(x + 1, by, w - 2, 2, BAT);
      px(x + 1, by, w - 2, 1, BAT_LIT); keyEdge(x + 2, by, 7, 1, 0.16);
      px(x + 1, by + 2, w - 2, 1, U.shade(BAT, -0.50));           // the batten's cast shadow below it
      for (let i = 0; i < 4; i++) px(x + 3 + i * 6, by + 1, 1, 1, U.shade(BAT_LIT, 0.24));   // nail heads
    }
    // stencil block on the middle planks: cargo markings read as ONE object, never as scattered specks
    px(x + 3, bT + 4, 7, 4, '#241b0f');
    px(x + 4, bT + 5, 5, 1, '#b8933f'); px(x + 4, bT + 6, 3, 1, U.shade('#b8933f', -0.40));
    px(x + w - 8, bT + 4, 4, 4, '#20301f'); px(x + w - 7, bT + 5, 2, 2, '#2f6b46');   // cargo-cleared chit
    px(x + 1, y + h - 3, w - 2, 1, '#0d1114');                    // floor-line AO
    px(x + 1, y + h - 2, 5, 1, WD_DK); px(x + w - 6, y + h - 2, 5, 1, WD_DK);        // skid feet
    ctx.globalAlpha = 0.34; px(x + 1, y + h - 1, w - 2, 1, '#000'); ctx.globalAlpha = 1;
    // ---- LID: the foreshortened TOP plane, planked the other way and visibly OVERHANGING the body.
    // The 1px proud edge east/west is the whole trick that turns two stacked rectangles into a lid on a box.
    chamf(x - 1, y - 10, w + 2, 10, LINE, 2);
    chamf(x, y - 9, w, 8, WD_TOP, 2);
    px(x + 2, y - 9, w - 4, 1, U.shade(WD_LIT, 0.14)); keyEdge(x + 2, y - 9, 10, 1, 0.30);
    px(x + 2, y - 8, w - 4, 1, WD_LIT);
    for (const sy of [y - 6, y - 4]) {                            // lid plank seams, running east-west
      px(x + 1, sy, w - 2, 1, U.shade(WD_TOP, -0.34));
      px(x + 1, sy + 1, w - 2, 1, U.shade(WD_TOP, 0.10));
    }
    px(x, y - 7, 1, 5, WD_LIT); px(x + w - 1, y - 7, 1, 5, WD_DK);
    rimEdge(x + w - 1, y - 7, 1, 5, 0.22);
    wear(x + 4, y - 8, w - 8, 6, 4, U.shade(WD_TOP, -0.16));
    px(x + 1, y - 2, w - 2, 1, U.shade(WD_DK, -0.30));            // underside of the overhang
    // steel toggle clasps ACROSS the lid line. They must STRADDLE it, not stand on it: the first draft
    // ran them 4px up into the lid inside a LINE block, which cut two black notches out of the top plane
    // and left two chrome sticks reading as aerials. Two rows above the seam, two below, no outline.
    for (const cxx of [x + 5, x + w - 8]) {
      px(cxx, y - 4, 4, 4, U.shade(WD_DK, -0.34));                // the recess the clasp is let into
      px(cxx + 1, y - 4, 2, 3, '#79868f');
      px(cxx + 1, y - 4, 2, 1, '#a3b0b8'); keyEdge(cxx + 1, y - 4, 1, 1, 0.30);
      px(cxx + 1, y - 1, 2, 1, '#4c565d');                        // the catch, gripping the body below
    }
  };

  F.fabricator = (x, y, w, h, f) => { // v4 apparel fabricator (3x2) — a framed gantry BAY, a feed line, an out-hopper
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 14, w, h - 14);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 3, y + 13, x + w + 2, y + h - 3, 2.4);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 15, 3, 3, LINE); px(lx, y + 15, 1, 3, r.lit); px(lx + 1, y + 15, 1, 3, r.dk);
      rimEdge(lx + 2, y + 15, 1, 2, 0.16);
    }
    underAO(x + 5, y + 15, w - 10, 2);
    // OUT hopper on the plate — a 3x2 machine needs a visible in-end and out-end, not one big shape
    chamf(x + 12, y + 16, 12, 6, LINE, 1);
    px(x + 13, y + 17, 10, 4, U.shade(r.face, -0.18));
    px(x + 13, y + 17, 10, 1, r.face); keyEdge(x + 14, y + 17, 6, 1, 0.14);
    px(x + 13, y + 20, 10, 1, r.ao);
    px(x + 15, y + 18, 6, 2, '#d8d0c0'); px(x + 15, y + 18, 6, 1, '#ece4d6');   // folded output
    px(x + 17, y + 18, 2, 1, '#b8b0a0');
    // short south face: progress well + run/heater lamps
    chamf(x - 1, y + 9, w + 2, 7, LINE, 2);
    px(x, y + 10, w, 4, r.face);
    px(x, y + 10, w, 1, r.lit); keyEdge(x + 1, y + 10, w - 5, 1, 0.15);
    px(x, y + 11, 1, 3, U.shade(r.face, 0.08)); px(x + w - 1, y + 11, 1, 3, r.dk);
    rimEdge(x + w - 1, y + 11, 1, 3, 0.20);
    px(x, y + 13, w, 1, r.ao);
    inset(x + 3, y + 11, w - 14, 2, '#10161a');
    if (on) {
      const pw = 1 + Math.floor(((now / 900) % 1) * (w - 17));
      px(x + 4, y + 11, pw, 1, '#ff9d2e');
      bloom(x + 4, y + 11, pw, 1, '#ff9d2e', 0.16);
    } else px(x + 4, y + 11, 2, 1, U.shade('#ff9d2e', -0.66));   // parked head still reads as a bar, not a dead slot
    px(x + w - 8, y + 11, 2, 2, (blink(400) && on) ? ACC.work : '#2a3a30');   // run light (kept 400)
    px(x + w - 5, y + 11, 1, 1, blink(900) ? ACC.flow : '#33291a');           // heater light (kept 900)
    // the chamfered casing top dominates
    chamf(x - 1, y - 4, w + 2, 14, LINE, 2);
    chamf(x, y - 3, w, 12, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 10, 1, 0.30);
    px(x, y - 1, 1, 9, r.lit); px(x + w - 1, y - 1, 1, 9, r.dk);
    rimEdge(x + w - 1, y - 1, 1, 9, 0.20);
    px(x + 2, y + 8, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 2, y + 5, w - 4, 3, 3, U.shade(r.top, -0.10));
    px(x + 1, y + 1, 3, 5, U.shade(r.top, -0.26)); px(x + 1, y + 1, 3, 1, U.shade(r.top, 0.10)); // access hatch
    px(x + 2, y + 3, 1, 1, r.sheen);
    for (let i = 0; i < 3; i++) { px(x + w - 5, y + 1 + i * 2, 3, 1, r.ao); px(x + w - 5, y + 2 + i * 2, 3, 1, U.shade(r.top, 0.08)); }
    // PRINT BAY: a heavy frame around the bed, so the window reads as a machine cavity and not a sticker
    const bx = x + 6, by = y - 1, bw = w - 14, bh = 6;
    px(bx - 2, by - 2, bw + 4, bh + 4, LINE);
    px(bx - 1, by - 1, bw + 2, bh + 2, U.shade(r.face, -0.34));
    px(bx - 1, by - 1, bw + 2, 1, U.shade(r.top, 0.10));
    px(bx - 1, by - 1, 1, bh + 2, U.shade(r.top, 0.06)); px(bx + bw, by - 1, 1, bh + 2, U.shade(r.top, -0.40));
    px(bx - 1, by + bh, bw + 2, 1, U.shade(r.top, -0.44));
    px(bx, by, bw, bh, on ? '#20282e' : '#161d22');            // bed plate — idle keeps a little sheen, never a hole
    px(bx, by, bw, 1, U.shade(r.face, -0.5));                  // recess shadow at the back of the well
    px(bx, by + 1, bw, 1, U.shade(r.top, -0.05));              // gantry rail
    if (on) {
      const hd = bx + 1 + Math.floor((now / 120) % (bw - 3));  // moving print head (kept 120)
      px(bx, by + 3, bw, 3, U.shade('#ff9d2e', -0.55));        // laid-down material
      for (let i = 0; i < bw; i += 2) px(bx + i, by + 4, 1, 1, U.shade('#ff9d2e', -0.30));
      bloom(bx, by + 3, bw, 3, '#ff9d2e', 0.12 + 0.05 * Math.sin(now / 300 + ph));
      px(hd, by + 1, 2, 4, '#8a98a8'); px(hd, by + 1, 2, 1, '#b6c2ce');   // carriage
      px(hd, by + 5, 2, 1, '#ffd9a0');                         // molten thread at the nozzle
      bloom(hd, by + 4, 2, 2, '#ff9d2e', 0.34);
      scanl(bx, by, bw, bh, 0.14);
      spill(bx - 1, by + bh + 1, bw + 2, '#ff9d2e', 0.18, 4);  // bay heat pooling down the casing top
    } else {
      px(bx + 1, by + 3, 3, 1, '#222c34');                     // parked gantry (kept)
      px(bx + bw - 3, by + 2, 1, 1, blink(1600, ph) ? '#ff9d2e' : '#33241a'); // standby (kept 1600)
    }
    // filament spool on the west flank + the feed tube arcing into the bay — plumbing is what says "machine"
    chamf(x - 3, y + 1, 7, 7, LINE, 1);
    px(x - 2, y + 2, 5, 5, U.shade(r.face, -0.10)); px(x - 2, y + 2, 5, 1, r.lit);
    rimEdge(x + 2, y + 3, 1, 4, 0.18);
    px(x - 1, y + 3, 3, 3, '#c98a3a'); px(x - 1, y + 3, 3, 1, U.shade('#c98a3a', 0.22));
    px(x, y + 4, 1, 1, '#10161a');                             // hub
    const spin = Math.floor(now / 200) % 4;                    // rotation tell (kept 200)
    if (on) px(x - 1 + (spin % 3), y + (spin < 2 ? 3 : 5), 1, 1, U.shade('#c98a3a', 0.34));
    cable(x + 2, y + 3, bx + 2, by + 1, -2.2, '#2a2118');
  };

  F.vat = (x, y, w, h, f) => { // v4 wax vat (3x2) — dark basin body, LIT MENISCUS, firelight climbing the inner rim
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 15, w, h - 15);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 4, y + 14, x + w + 2, y + h - 3, 2.2);
    // candle tray on the plate — the vat's visible OUTPUT
    chamf(x + 3, y + 16, 15, 6, LINE, 1);
    px(x + 4, y + 17, 13, 4, U.shade(r.face, -0.18)); px(x + 4, y + 17, 13, 1, r.face);
    keyEdge(x + 5, y + 17, 8, 1, 0.14);
    px(x + 4, y + 20, 13, 1, r.ao);
    for (const c3 of [[x + 5, y + 18, 3], [x + 8, y + 17, 4], [x + 11, y + 18, 3]]) {
      px(c3[0], c3[1], 2, c3[2], '#c9a866'); px(c3[0], c3[1], 1, c3[2], '#dcc088');
      px(c3[0], c3[1], 2, 1, '#e6d0a0'); px(c3[0], c3[1] - 1, 1, 1, '#7a7266');   // wick (kept)
    }
    px(x + 14, y + 19, 2, 1, '#b89858');                       // wax drip (kept)
    // drum body — warm key down the west curve, cool sky bounce down the east
    chamf(x, y + 2, w, 15, LINE, 2);
    px(x + 1, y + 3, w - 2, 12, r.face);
    px(x + 1, y + 3, 2, 12, r.lit); keyEdge(x + 1, y + 4, 1, 9, 0.18);
    px(x + w - 3, y + 3, 2, 12, r.dk); rimEdge(x + w - 3, y + 4, 1, 9, 0.22);
    px(x + 2, y + 14, w - 4, 1, r.ao);
    px(x + 1, y + 8, w - 2, 1, U.shade(r.face, -0.30));        // welded hoop
    px(x + 1, y + 9, w - 2, 1, U.shade(r.face, 0.10));
    knurl(x + 4, y + 5, 8, 1, r.face);
    // BURNER: firelight leaks from the seam under the drum and is hottest at the pilot, not a uniform bar
    const heat = on ? 0.52 + 0.26 * Math.sin(now / 250 + ph) : 0.15;
    for (let i = 0; i < w - 6; i++) {
      const a = heat * (0.32 + 0.68 * Math.exp(-Math.abs(i - (w - 6) * 0.34) / 7));
      ctx.globalAlpha = Math.max(0, Math.min(0.85, a)); px(x + 3 + i, y + 11, 1, 1, '#ff5a2a');
    }
    ctx.globalAlpha = 1;
    bloom(x + 5, y + 11, w - 10, 1, '#ff9d2e', heat * 0.20);
    for (let i = 0; i < (w - 6) / 4; i++) px(x + 3 + i * 4, y + 13, 2, 1, i % 2 ? '#caa84a' : '#28323a'); // hazard (kept)
    px(x + w - 7, y + 10, 5, 5, LINE);                         // temp gauge (kept)
    px(x + w - 6, y + 11, 3, 3, '#1b2226'); px(x + w - 6, y + 11, 3, 1, U.shade(r.face, 0.14));
    px(x + w - 5 + (on ? 1 : 0), y + 12, 1, 1, on ? ACC.flow : U.shade(ACC.flow, -0.55));  // needle swings hot
    // the OVAL RIM + molten pool dominate: dark body below the surface, light climbing UP the far wall
    const cx2 = x + w / 2, cy2 = y + 3;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2, 7, 0, 0, 6.2832); ctx.fillStyle = LINE; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 1, 6, 0, 0, 6.2832); ctx.fillStyle = r.top; ctx.fill();
    ctx.globalAlpha = 0.85; ctx.strokeStyle = r.sheen; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.5, w / 2 - 2.5, 5, 0, Math.PI * 1.02, Math.PI * 1.98); ctx.stroke();
    ctx.globalAlpha = 0.30; ctx.strokeStyle = SKY;             // cool bounce on the near rim
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.5, w / 2 - 2.5, 5, 0, Math.PI * 0.08, Math.PI * 0.92); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 3.5, 4.6, 0, 0, 6.2832); ctx.fillStyle = '#1a1108'; ctx.fill();
    ctx.globalAlpha = on ? 0.46 : 0.22; ctx.strokeStyle = '#ff9d2e'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.4, w / 2 - 4.2, 4.0, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.globalAlpha = 1;                                        // ^ the pool lighting the far inner wall
    const lvl = 3 + Math.round(Math.sin(now / 900 + ph));       // wax level breathes (kept)
    const wrx = w / 2 - 4.5 - (4 - lvl) * 0.7, wry = 3.8 - (4 - lvl) * 0.4;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.5, wrx, wry, 0, 0, 6.2832); ctx.fillStyle = on ? '#e0a03c' : '#8a6a30'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.3, wrx - 1.6, wry - 1.1, 0, 0, 6.2832); ctx.fillStyle = on ? '#ffd9a0' : '#b08a4a'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2 - 1.5, cy2 - 0.2, wrx * 0.42, wry * 0.4, 0, 0, 6.2832); ctx.fillStyle = on ? '#fff0cc' : '#c8a366'; ctx.fill();
    ctx.globalAlpha = 0.8; ctx.strokeStyle = '#fff4dd'; ctx.lineWidth = 1;   // the LIT MENISCUS on the near lip
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.5, Math.max(0.6, wrx - 0.4), Math.max(0.6, wry - 0.4), 0, Math.PI * 0.10, Math.PI * 0.90); ctx.stroke();
    ctx.globalAlpha = 1;
    px(Math.round(cx2 - wrx) + 1, cy2, 1, 1, '#f0c890');        // meniscus catch (kept)
    px(x + 6 + Math.floor((now / 500) % (w - 14)), cy2 - 1, 2, 1, '#fff4dd');  // shimmer (kept)
    const stx = x + 7 + Math.floor((0.5 + 0.5 * Math.sin(now / 1300 + ph)) * (w - 15));  // stirrer sweep (kept)
    px(stx, cy2 - 4, 1, 5, '#8a98a8'); px(stx, cy2 - 4, 1, 1, '#aab8c8'); px(stx + 1, cy2 - 3, 1, 3, '#3e4a54');
    px(stx - 1, cy2 + 1, 3, 1, '#f0c890'); px(stx - 2, cy2 + 2, 5, 1, U.shade('#f0c890', -0.35));  // wake
    ctx.restore();
    // stirrer GANTRY bridging the basin — the paddle hangs off it instead of floating over the wax
    px(x + 4, y - 4, w - 8, 2, LINE); px(x + 5, y - 4, w - 10, 1, r.top);
    keyEdge(x + 5, y - 4, 8, 1, 0.24);
    px(x + 4, y - 3, 2, 5, LINE); px(x + w - 6, y - 3, 2, 5, LINE);
    px(x + 4, y - 3, 1, 5, r.lit); px(x + w - 5, y - 3, 1, 5, r.dk);
    px(stx, y - 3, 1, 2, '#6a7884');                            // shaft up to the rail
    glow(x + 5, y - 3, w - 10, 1, '#ff9d2e', on ? 0.30 : 0.12); // the pool lights the gantry's underside
    if (on && blink(300, ph)) { px(x + (w >> 1), y - 7, 1, 2, '#ff9d2e'); px(x + (w >> 1), y - 8, 1, 1, ACC.flow); } // flame test (kept)
    bloom(x + 5, y - 1, w - 10, 8, '#ff9d2e', (on ? 0.15 : 0.06) + 0.04 * Math.sin(now / 700 + ph));
  };

  F.easel = (x, y, w, h, f) => {
    // EASEL (3x2) — v6. The v4 version had an easel's ANATOMY (A-frame, ledge, canvas) and still read as
    // a CRT MONITOR ON A STAND, because of one decision: the canvas was a DARK WELL — inset() over
    // #170f22, with an idle ground of #1d1528. Dark rectangle in a heavy frame on legs IS a monitor;
    // that is the same shape the console and tacscreen props use, and no amount of easel joinery around
    // it can win the argument. A canvas is the LIGHTEST thing in the room — primed linen — so the ground
    // is now cream and the picture is painted in dark pigment ON it, which is the correct polarity and
    // fixes the read on its own. Three supporting changes: the frame goes to warm TIMBER (v4 used
    // RAMP.gun, i.e. the same metal as the lockers), the centre mast now rises ABOVE the canvas the way
    // a real easel's does, and the ledge carries brushes and a palette so the prop reads as in use.
    const on = !!(f && f.work), ph = (f && f.x) || 0;
    const WD = '#7a5a34', WD_LIT = '#a37c4c', WD_DK = '#432d16';
    const LIN = '#d9cfbc', LIN_LIT = '#f2e9d6', LIN_DK = '#9d9483';   // primed linen
    const cx0 = x + 8, cy0 = y - 9, cw = w - 16, ch = 18;             // the canvas face
    shadow2(x + 3, y + h - 1, w - 6);
    // ---- CENTRE MAST, rising past the canvas top. This overshoot is the single silhouette cue that
    // separates an easel from any other framed panel on a stand, and v4 stopped the mast at the canvas.
    px(x + (w >> 1) - 1, cy0 - 5, 3, h - cy0 + y + 3, LINE);
    px(x + (w >> 1), cy0 - 4, 1, h - cy0 + y + 1, WD);
    px(x + (w >> 1), cy0 - 4, 1, 4, WD_LIT); keyEdge(x + (w >> 1), cy0 - 4, 1, 3, 0.20);
    rimEdge(x + (w >> 1), cy0 + 12, 1, 6, 0.16);
    // ---- SPLAYED FRONT LEGS. Kept from v4 (the geometry was never the problem) but in timber.
    for (const pair of [[x + 10, x + 4], [x + w - 12, x + w - 6]]) {
      const tx = pair[0], fx2 = pair[1];
      for (let i = 0; i < 9; i++) px(Math.round(tx + (fx2 - tx) * (i / 8)) - 1, y + 5 + i * 2, 4, 3, LINE);
      for (let i = 0; i < 9; i++) {
        const lx = Math.round(tx + (fx2 - tx) * (i / 8));
        px(lx, y + 5 + i * 2, 1, 2, WD_LIT); px(lx + 1, y + 5 + i * 2, 1, 2, WD_DK);
      }
      px(fx2 - 1, y + h - 2, 4, 2, LINE); px(fx2, y + h - 2, 2, 1, WD);
      px(fx2 - 1, y + h - 1, 4, 1, '#0a0d10');                       // foot contact
      keyEdge(fx2, y + h - 3, 1, 2, 0.16);
    }
    cable(x + 6, y + 17, x + w - 8, y + 17, 2.6, '#2b2016');         // slack tension cord across the A
    // ---- CANVAS: a stretcher frame in timber, then PRIMED LINEN. The top edge of the stretcher is
    // drawn as a lit 1px band standing proud of the face — that reads as the canvas LEANING BACK.
    chamf(cx0 - 2, cy0 - 2, cw + 4, ch + 4, LINE, 2);
    chamf(cx0 - 1, cy0 - 1, cw + 2, ch + 2, WD, 1);
    px(cx0, cy0 - 2, cw, 1, WD_LIT); keyEdge(cx0 + 1, cy0 - 2, 7, 1, 0.26);   // the proud top edge
    px(cx0 - 1, cy0 + 1, 1, ch - 2, WD_LIT); px(cx0 + cw, cy0 + 1, 1, ch - 2, WD_DK);
    rimEdge(cx0 + cw, cy0 + 1, 1, ch - 2, 0.20);
    px(cx0 - 1, cy0 + ch, cw + 2, 1, U.shade(WD_DK, -0.20));         // the frame's bottom rail, in shade
    px(cx0, cy0, cw, ch, LIN);                                       // PRIMED LINEN — the light ground
    px(cx0, cy0, cw, 1, LIN_LIT);                                    // the top of the weave takes the key
    px(cx0, cy0, 1, ch, U.shade(LIN, 0.05)); px(cx0 + cw - 1, cy0, 1, ch, LIN_DK);
    for (let i = 0; i < 3; i++) px(cx0 + 1, cy0 + 4 + i * 5, cw - 2, 1, U.shade(LIN, -0.06));   // weave
    px(cx0, cy0 + ch - 1, cw, 1, U.shade(LIN, -0.16));               // the ledge's shadow on the linen
    // ---- THE PICTURE. Dark pigment on the light ground, in both states. Idle is a charcoal LAY-IN
    // (horizon, a figure blocked in, a couple of construction lines); working paints it in, top-down.
    // It is a PORTRAIT easel, so the lay-in is a bust: head, neck, then shoulders spreading wider than
    // the head. A first draft blocked a torso and a second "mass" beside it and the pair read as a chess
    // piece next to a bottle — on a 20px canvas the shoulder line is the only cue that says "a person".
    const PG = '#4b4034', PG2 = '#6d6152';
    px(cx0 + 7, cy0 + 3, 5, 5, PG);                                  // head
    px(cx0 + 8, cy0 + 2, 3, 1, U.shade(PG, -0.20));                  // crown
    px(cx0 + 8, cy0 + 8, 3, 2, U.shade(PG, 0.10));                   // neck
    // shoulders — TAPERED, and they must not touch the canvas edges. A first draft ran them 13px wide
    // at a constant width and the bust read as a dark BAR under a blob: a rectangle spanning the picture
    // is a horizon, not a body. Widening row by row, with linen left either side, is what makes it read.
    for (let j = 0; j < 5; j++) px(cx0 + 8 - j - 1, cy0 + 10 + j, 5 + (j + 1) * 2, 1, PG);
    px(cx0 + 6, cy0 + 10, 7, 1, PG2);                                // the lit top of the shoulder line
    px(cx0 + 6, cy0 + 12, 2, 3, U.shade(PG, -0.18)); px(cx0 + 11, cy0 + 12, 2, 3, U.shade(PG, -0.18));
    px(cx0 + 1, cy0 + 9, 5, 1, U.shade(LIN, -0.20));                 // the ground line, BEHIND the sitter
    px(cx0 + cw - 6, cy0 + 9, 5, 1, U.shade(LIN, -0.20));
    px(cx0 + 2, cy0 + 6, 3, 1, U.shade(LIN, -0.14));                 // two construction marks, still showing
    px(cx0 + cw - 5, cy0 + 5, 3, 1, U.shade(LIN, -0.14));
    if (on) {
      // THE REVEAL PAINTS THE PICTURE, IT DOES NOT ERASE IT. A first version filled every revealed row
      // edge-to-edge with ACC.lounge, so "working" replaced the portrait with a flat magenta flag and
      // the face survived only as a peach square floating in it. The reveal now lays a muted BACKDROP
      // and then re-stamps the same head/neck/shoulder geometry in painted tones over it — same shapes
      // as the lay-in, in colour, which is what finishing a canvas actually looks like.
      const BKD = '#6b4257', SKN = '#f0c69c', HAIR = '#3a2430', GRB = U.shade(ACC.lounge, -0.34);
      const rev = (now / 2400) % 1, rh = Math.max(1, Math.min(ch - 2, Math.floor((ch - 2) * rev) + 1));
      const done = (ry, rhh) => Math.max(0, Math.min(rhh, rh - (ry - cy0 - 1)));   // rows of a band painted
      for (let j = 0; j < rh; j++)                                   // the backdrop wash, warm at the top
        px(cx0 + 1, cy0 + 1 + j, cw - 2, 1, U.shade(BKD, 0.14 * (1 - j / ch)));
      let d = done(cy0 + 2, 1); if (d) px(cx0 + 8, cy0 + 2, 3, d, HAIR);            // crown
      d = done(cy0 + 3, 5); if (d) { px(cx0 + 7, cy0 + 3, 5, d, SKN);               // head
        px(cx0 + 7, cy0 + 3, 1, d, U.shade(SKN, -0.22)); px(cx0 + 7, cy0 + 3, 5, 1, HAIR); }
      if (rh > 5) { px(cx0 + 8, cy0 + 5, 1, 1, '#2a1a24'); px(cx0 + 10, cy0 + 5, 1, 1, '#2a1a24'); }
      d = done(cy0 + 8, 2); if (d) px(cx0 + 8, cy0 + 8, 3, d, U.shade(SKN, -0.16));  // neck
      for (let j = 0; j < 5; j++)                                    // shoulders, in the sitter's garment
        if (done(cy0 + 10 + j, 1)) px(cx0 + 8 - j - 1, cy0 + 10 + j, 5 + (j + 1) * 2, 1, j ? GRB : U.shade(GRB, 0.22));
      // the wet edge — the only bright pixel this prop ever shows, and it exists only while a row is wet
      if (rh < ch - 2) px(cx0 + 1, cy0 + 1 + rh, cw - 2, 1, blink(120, ph) ? '#ffe4f6' : ACC.lounge);
      bloom(cx0 + 1, cy0 + 1, cw - 2, rh, ACC.lounge, 0.09);
    } else {
      px(cx0 + cw - 3, cy0 + ch - 3, 1, 1, blink(1600, ph) ? U.shade(ACC.flow, -0.30) : '#8d8474');   // a pin
    }
    // ---- PAINT LEDGE bolted across the front legs, with the tools on it
    chamf(x + 5, y + 12, w - 10, 5, LINE, 1);
    px(x + 6, y + 13, w - 12, 3, WD); px(x + 6, y + 13, w - 12, 1, WD_LIT);
    keyEdge(x + 7, y + 13, 8, 1, 0.15);
    px(x + 6, y + 15, w - 12, 1, U.shade(WD_DK, -0.20));
    // TOOLS. Both of these must clear the canvas: a first pass stood the brush jar at x+7 and hooked the
    // palette at x+w-15, and since the canvas face spans cx0..cx0+cw (x+8 .. x+28) BOTH were painted
    // straight over the picture. The canvas owns the middle; the tools get the two clear side strips.
    px(x + 1, y + 8, 5, 5, '#26303a'); px(x + 1, y + 8, 5, 1, '#3d4a56');   // brush jar, west of the frame
    px(x + 1, y + 12, 5, 1, '#151c22');
    for (let i = 0; i < 3; i++) {                                    // brushes: verticals that say "in use"
      const bxx = x + 2 + i;
      px(bxx, y + 3 + i, 1, 6 - i, '#8a6a42');
      px(bxx, y + 3 + i, 1, 1, ['#c8c0b0', '#a33a3a', '#4ad9ff'][i]);
    }
    // PALETTE lying on the ledge, east of the canvas and BELOW its bottom rail
    chamf(x + w - 12, y + 11, 11, 5, LINE, 1);
    chamf(x + w - 11, y + 12, 9, 3, '#9d8a6c', 1); px(x + w - 11, y + 12, 9, 1, '#bda887');
    px(x + w - 5, y + 13, 2, 1, U.shade('#9d8a6c', -0.44));          // the thumb hole
    for (const dab of [[x + w - 10, ACC.lounge], [x + w - 8, ACC.data], [x + w - 6, ACC.flow]])
      px(dab[0], y + 12, 1, 1, U.shade(dab[1], -0.20));
    px(x + 12, y + 15, 1, 1, U.shade(ACC.lounge, -0.20)); px(x + 17, y + 15, 1, 1, U.shade(ACC.data, -0.20));
    if (on) spill(x + 8, y + 12, w - 16, ACC.lounge, 0.18, 4);       // the wet canvas throws colour down
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
    // INBOX (2x2) — where outside work enters the station. v4: a real flared HOPPER. The old prop was a
    // slab with an amber slot cut in it; a funnel says "things fall in here" without a word of UI, and the
    // amber falling INSIDE the throat is the emissive, so the identity lives in light, not casing.
    const r = RAMP.steel, act = !!(f && f.work), ph = (f && f.x) || 0, cyc = (now / 900) % 1;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 6, w + 2, 6);
    deckSocket(x + w + 1, y + h - 3, act);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    cable(x + w - 4, y + h - 9, x + w + 2, y + h - 3, 2);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
      rimEdge(lx + 2, y + h - 5, 1, 2, 0.16);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // south face + the OUTPUT slot: a box leaves here, onto the belt, so its bars march EAST
    chamf(x - 1, y + h - 12, w + 2, 8, LINE, 2);
    chamf(x, y + h - 11, w, 6, r.face, 2);
    px(x + 1, y + h - 11, w - 2, 1, r.lit); keyEdge(x + 2, y + h - 11, w - 5, 1, 0.15);
    px(x, y + h - 9, 1, 3, U.shade(r.face, 0.08)); px(x + w - 1, y + h - 9, 1, 3, r.dk);
    rimEdge(x + w - 1, y + h - 9, 1, 3, 0.20);
    px(x + 1, y + h - 6, w - 2, 1, r.ao);
    inset(x + 4, y + h - 10, w - 8, 4, '#231d12');
    for (let i = 0; i < w - 10; i++)
      if ((i + Math.floor(now / 160)) % 4 === 0) px(x + 5 + i, y + h - 9, 1, 2, act ? ACC.flow : U.shade(ACC.flow, -0.5));
    if (act) bloom(x + 5, y + h - 9, w - 10, 2, ACC.flow, 0.18);
    // machine shoulder — the top surface the hopper is bolted through
    chamf(x - 1, y + h - 20, w + 2, 10, LINE, 2);
    chamf(x, y + h - 19, w, 8, r.top, 2);
    px(x + 2, y + h - 19, w - 4, 1, r.sheen); keyEdge(x + 2, y + h - 19, 8, 1, 0.26);
    px(x, y + h - 17, 1, 5, r.lit); px(x + w - 1, y + h - 17, 1, 5, r.dk);
    rimEdge(x + w - 1, y + h - 17, 1, 5, 0.20);
    px(x + 2, y + h - 12, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 2, y + h - 18, w - 4, 6, 4, U.shade(r.top, -0.10));
    for (const gx of [x + 3, x + w - 6]) { px(gx, y + 3, 3, 3, r.dk); px(gx, y + 3, 3, 1, U.shade(r.dk, 0.3)); } // neck gussets
    // FLARED HOPPER: rim wide at the top, straight neck at the bottom, with material falling down the throat
    for (let j = 0; j < 9; j++) {
      const iw = j < 6 ? 22 - j * 2 : 12, ix = x + 1 + Math.min(j, 5), yy = y - 4 + j;
      px(ix - 1, yy, iw + 2, 1, LINE);
      px(ix, yy, iw, 1, j === 0 ? r.sheen : r.top);
      px(ix, yy, 1, 1, r.lit); px(ix + iw - 1, yy, 1, 1, r.dk);
      if (j === 0) keyEdge(ix, yy, 8, 1, 0.30); else rimEdge(ix + iw - 1, yy, 1, 1, 0.18);
      const tw = iw - 6, tx0 = ix + 3;
      if (tw > 0) {                                              // the throat, and the amber sliding DOWN it
        px(tx0, yy, tw, 1, '#1a1410');
        const band = ((j + Math.floor(now / 200)) % 3) === 0;
        if (band) px(tx0, yy, tw, 1, act ? '#ffe27a' : U.shade(ACC.flow, -0.30));
      }
    }
    if (act || cyc > 0.86) bloom(x + 4, y - 4, 16, 9, ACC.flow, act ? 0.20 + 0.06 * Math.sin(now / 300) : 0.10);
    else glow(x + 4, y - 4, 16, 9, ACC.flow, 0.05);              // never a dead black hole when idle
    // cyan SIGNAL MAST on the shoulder's east corner — the bay is LISTENING (kept ping)
    const ax = x + w - 3, ping = blink(640, ph);
    px(ax, y + 2, 1, 10, r.dk); px(ax - 1, y + 2, 3, 1, r.lit); px(ax, y + 7, 1, 1, r.sheen);
    px(ax, y + 1, 1, 1, ping ? '#7df0ff' : U.shade(ACC.data, -0.55));
    if (ping) bloom(ax, y + 1, 1, 1, ACC.data, 0.34);
  };

  F.outbox = (x, y, w, h, f) => {
    // OUTBOX (2x2) — dispatch. v4: an EJECTOR RAMP climbing away to a launch head, so the prop points the
    // way work leaves instead of mirroring the inbox slab. Green/cyan (outgoing) vs the inbox's amber.
    // f.crates (real uncollected while-away runs, from the ReturnStore ledger) still stacks on the out-tray.
    const r = RAMP.steel, act = !!(f && f.work), ph = (f && f.x) || 0, cyc = (now / 900) % 1;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 6, w + 2, 6);
    deckSocket(x + w + 1, y + h - 3, act);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    cable(x + 4, y + h - 9, x + 1, y + h - 3, 2);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
      rimEdge(lx + 2, y + h - 5, 1, 2, 0.16);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // south face + the intake chute a finished box is fed into (bars march EAST, toward the ramp)
    chamf(x - 1, y + h - 12, w + 2, 8, LINE, 2);
    chamf(x, y + h - 11, w, 6, r.face, 2);
    px(x + 1, y + h - 11, w - 2, 1, r.lit); keyEdge(x + 2, y + h - 11, w - 5, 1, 0.15);
    px(x, y + h - 9, 1, 3, U.shade(r.face, 0.08)); px(x + w - 1, y + h - 9, 1, 3, r.dk);
    rimEdge(x + w - 1, y + h - 9, 1, 3, 0.20);
    px(x + 1, y + h - 6, w - 2, 1, r.ao);
    inset(x + 4, y + h - 10, w - 8, 4, '#08130f');
    for (let i = 0; i < w - 10; i++)
      if ((i + Math.floor(now / 150)) % 4 === 0) px(x + 5 + i, y + h - 9, 1, 2, act ? '#7df0c8' : U.shade(ACC.work, -0.5));
    if (act) bloom(x + 5, y + h - 9, w - 10, 2, '#5ad1b3', 0.18);
    // machine shoulder
    chamf(x - 1, y + h - 20, w + 2, 10, LINE, 2);
    chamf(x, y + h - 19, w, 8, r.top, 2);
    px(x + 2, y + h - 19, w - 4, 1, r.sheen); keyEdge(x + 2, y + h - 19, 8, 1, 0.26);
    px(x, y + h - 17, 1, 5, r.lit); px(x + w - 1, y + h - 17, 1, 5, r.dk);
    rimEdge(x + w - 1, y + h - 17, 1, 5, 0.20);
    px(x + 2, y + h - 12, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 2, y + h - 18, w - 4, 5, 3, U.shade(r.top, -0.10));
    // OUT-TRAY sunk into the west of the shoulder — where uncollected work piles up
    chamf(x + 1, y + h - 18, 10, 6, '#101614', 1);
    px(x + 2, y + h - 17, 8, 4, '#161e1c'); px(x + 2, y + h - 14, 8, 1, '#0b1210');
    // EJECTOR RAMP climbing north-east — a diagonal in a room of boxes, and it points where work goes
    const st = Math.floor(now / 130);
    for (let k = 0; k < 12; k++) {
      const rx = x + 9 + k, ry = y + 11 - k;
      px(rx - 1, ry, 1, 1, LINE); px(rx + 7, ry, 1, 1, LINE);
      px(rx, ry, 7, 1, k % 2 ? U.shade(r.face, -0.06) : r.face);
      px(rx, ry, 1, 1, r.lit); px(rx + 6, ry, 1, 1, r.dk);
      if ((((k - st) % 4) + 4) % 4 === 0) {                      // dispatch bars climbing the ramp
        px(rx + 1, ry, 5, 1, act ? '#7df0c8' : U.shade(ACC.work, -0.45));
        if (act) bloom(rx + 1, ry, 5, 1, '#5ad1b3', 0.16);
      }
    }
    // launch head at the ramp's crest: aperture + uplink lamp (kept blink-idle / solid-on-dispatch)
    chamf(x + 15, y - 5, 9, 8, LINE, 2);
    chamf(x + 16, y - 4, 7, 6, r.face, 2);
    px(x + 17, y - 4, 5, 1, r.top); keyEdge(x + 17, y - 4, 3, 1, 0.26);
    px(x + 16, y - 2, 1, 3, r.lit); px(x + 22, y - 2, 1, 3, r.dk); rimEdge(x + 22, y - 2, 1, 3, 0.20);
    inset(x + 17, y - 3, 5, 4, '#06100e');
    px(x + 18, y - 2, 3, 2, act ? '#7df0c8' : (cyc > 0.86 ? U.shade(ACC.work, -0.2) : '#0e1a16'));
    bloom(x + 18, y - 2, 3, 2, '#5ad1b3', act ? 0.34 + 0.10 * Math.sin(now / 260) : 0.08);
    px(x + 19, y - 7, 1, 3, r.dk); px(x + 18, y - 7, 3, 1, r.lit);   // uplink whip
    px(x + 19, y - 8, 1, 1, act ? '#7df0c8' : (blink(720, ph + 1) ? ACC.work : U.shade(ACC.work, -0.6)));
    if (act) bloom(x + 19, y - 8, 1, 1, '#5ad1b3', 0.34);
    // the uncollected-crate stack (G2.3) — banked product climbing off the out-tray, gentle bob + '+N'
    // overflow in the VT323 terminal face. f.crates comes from the ReturnStore ledger: real runs, never invented.
    const crates = Math.max(0, (f && f.crates) | 0);
    if (crates > 0) {
      const shown = Math.min(crates, 5), cx = x + 5, base = y + h - 18;
      for (let i = 0; i < shown; i++) {
        const cy = base - i * 6 + Math.sin(now / 380 + i * 0.7) * 0.6;
        const bx0 = Math.round(cx - 4), by0 = Math.round(cy - 4);
        px(bx0 - 1, by0 - 1, 11, 8, '#101614');                  // dark outline
        px(bx0, by0 + 3, 9, 3, '#2a6a56');                       // shaded front face
        px(bx0, by0, 9, 3, '#5ad1b3');                           // lit product top
        px(bx0, by0, 9, 1, '#c8f4e6');                           // top sheen
      }
      bloom(cx - 4, base - (shown - 1) * 6 - 4, 9, shown * 6 + 3, '#5ad1b3', 0.14);
      if (crates > 5) {
        ctx.fillStyle = '#7df0c8'; ctx.font = "7px 'VT323','Courier New',monospace";
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('+' + (crates - 5), cx, base - shown * 6 - 2);
      }
    }
  };

  F.studio = (x, y, w, h, f) => {
    // STUDIO — the media bay (image_generate / image_analyze). v4 rebuild: this prop predated the locked
    // style law and was still drawn in the old flat elevation. Now it's TALL 3/4 machinery BOLTED to the
    // deck, carrying a raised holo-easel where a latent image RESOLVES coarse->fine (the way a render
    // actually lands) under a visible emitter cone. Magenta stays in the accents/emissives, never the
    // casing — the law puts colour identity in the light. f.work = an image tool is really running.
    const r = RAMP.steel, act = !!f.work;
    shadow2(x + 2, y + h - 1, w - 4);                               // floor contact
    deckPlate(x, y + h - 6, w, 6);                                  // bolted to the deck
    deckSocket(x + w + 1, y + h - 3, act);
    cable(x + w - 3, y + h - 8, x + w + 2, y + h - 3, 2);
    // TALL 3/4 casing: chamfered slab with lit W / shaded E facets and a top cap we look down on
    chamf(x, y + 3, w, h - 4, LINE, 2);
    chamf(x + 1, y + 6, w - 2, h - 9, r.face, 2);
    px(x + 1, y + 8, 1, h - 13, U.shade(r.face, 0.10)); px(x + w - 2, y + 8, 1, h - 13, r.dk);
    rimEdge(x + w - 2, y + 8, 1, h - 13, 0.20);
    chamf(x + 1, y + 4, w - 2, 3, r.top, 2); px(x + 2, y + 4, w - 4, 1, r.sheen);
    keyEdge(x + 2, y + 4, 7, 1, 0.28);
    px(x + 2, y + 6, w - 4, 1, U.shade(r.top, -0.22));              // front lip of the cap
    for (let s = 0; s < 3; s++) { px(x + 3, y + 10 + s * 4, w - 6, 1, r.ao); px(x + 3, y + 11 + s * 4, w - 6, 1, U.shade(r.face, 0.07)); }
    wear(x + 2, y + 8, w - 4, h - 14, 4, U.shade(r.face, -0.12));
    px(x + 2, y + h - 7, w - 4, 1, r.ao);
    glow(x + 3, y + h - 7, w - 6, 1, ACC.lounge, act ? 0.30 + 0.10 * Math.sin(now / 300) : 0.08); // media underglow
    // print slots on the casing face — a fresh sheet feeds out while a render is landing
    for (const sx of [x + 3, x + w - 9]) {
      inset(sx, y + h - 12, 6, 3, '#141018');
      px(sx + 1, y + h - 11, 4, 1, U.shade(r.face, -0.4));
    }
    if (act) {
      const feed = Math.min(3, Math.floor(((now % 2600) / 2600) * 5));
      if (feed > 0) { px(x + 4, y + h - 9, 4, feed, '#9c93a2'); px(x + 4, y + h - 9, 4, 1, '#c0b6c6'); }
    }
    // RENDER FRAME — a raised holo-easel rising out of the machine; heavy chamfered bezel, recessed canvas
    chamf(x + 1, y - 9, w - 2, 13, LINE, 2);
    chamf(x + 2, y - 8, w - 4, 11, r.face, 2);
    px(x + 3, y - 8, w - 6, 1, r.top); keyEdge(x + 3, y - 8, 6, 1, 0.26);
    px(x + 2, y - 6, 1, 7, r.lit); px(x + w - 3, y - 6, 1, 7, r.dk); rimEdge(x + w - 3, y - 6, 1, 7, 0.22);
    px(x + 3, y + 2, w - 6, 1, r.ao);
    inset(x + 3, y - 7, w - 6, 9, '#150a1c');                       // canvas well
    // the latent image RESOLVING: block size halves through the cycle, coherent subject underneath
    const cx0 = x + 4, cy0 = y - 6, cw = w - 8, ch = 7;
    const per = 3400, t = (now % per) / per;
    const step = t < 0.30 ? 4 : t < 0.62 ? 2 : 1;
    const IMG = act ? ['#2a1030', '#5e1f5a', '#a63289', '#ff6ad5', '#ffc2ec']
                    : ['#1c0c22', '#2e1430', '#43204a', '#5a2a55', '#6b3563'];
    for (let iy = 0; iy < ch; iy += step) for (let ix = 0; ix < cw; ix += step) {
      const u = (ix + step / 2) / cw, v = (iy + step / 2) / ch;
      // a coherent SUBJECT underneath — a lit form off-centre plus a rim highlight — so halving the block
      // size reads as one picture sharpening, not as bands reshuffling
      const val = 0.94 - Math.hypot(u - 0.34, (v - 0.44) * 1.45) * 1.15
                + 0.34 * Math.exp(-Math.hypot(u - 0.74, (v - 0.60) * 1.3) * 3.6)
                + 0.09 * Math.sin(u * 13 + v * 7);
      px(cx0 + ix, cy0 + iy, Math.min(step, cw - ix), Math.min(step, ch - iy),
         IMG[Math.max(0, Math.min(4, Math.floor(val * 5)))]);
    }
    if (act) {
      const bandY = cy0 + Math.floor(t * (ch + 2)) - 1;              // resolve bar sweeping down the canvas
      if (bandY >= cy0 && bandY < cy0 + ch) { px(cx0, bandY, cw, 1, '#ffe4f6'); bloom(cx0, bandY, cw, 1, ACC.lounge, 0.30); }
      scanl(cx0, cy0, cw, ch, 0.18);
      bloom(cx0, cy0, cw, ch, ACC.lounge, 0.14 + 0.05 * Math.sin(now / 180));
    } else {
      scanl(cx0, cy0, cw, ch, 0.26);
      glow(cx0, cy0, cw, ch, ACC.lounge, 0.05);
    }
    // emitter lens on the cap, aimed up at the canvas — with a real volumetric cone while rendering
    const lx = x + (w >> 1) - 2, ly = y + 4;
    px(lx - 1, ly - 1, 6, 4, LINE); px(lx, ly, 4, 2, U.shade(r.face, -0.1)); px(lx, ly, 4, 1, r.lit);
    px(lx + 1, ly + 1, 2, 1, act ? '#ffd2f0' : (blink(700, 2) ? ACC.lounge : '#3a1a34'));
    if (act) {
      bloom(lx + 1, ly + 1, 2, 1, ACC.lounge, 0.38);
      ctx.save();
      ctx.globalAlpha = 0.09 + 0.04 * Math.sin(now / 200); ctx.fillStyle = ACC.lounge;
      ctx.beginPath(); ctx.moveTo(lx + 2, ly); ctx.lineTo(x + 3, y + 2); ctx.lineTo(x + w - 3, y + 2); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    px(x + w - 6, y + 8, 1, 1, act ? ACC.lounge : (blink(1500) ? ACC.flow : '#33241a')); // status LED
  };

  F.missionboard = (x, y, w, h, f) => {
    // MISSION BOARD (3x1) — v4 REBUILD. This prop predated the locked style law and was still drawn as a
    // flat outlined slab. It is now a WALL-HUNG briefing frame: chamfered slate carcass on two lugs, a
    // recessed cork well, a phosphor header and a rail of pinned cards. Every card stub is ONE real open
    // quest (f.pins), so the COUNT leads — the cards stay plain paper rectangles at an even pitch and the
    // header prints the number outright. f.hot = a station-gap quest is open, f.jam = a routine is backed
    // up, f.proposals = agent-pinned requisitions. Click -> QUEST LOG.
    const r = RAMP.gun, ph = (f && f.x) || 0;
    const pins = Math.max(0, (f && f.pins) | 0);
    const bt = y - 10, bh = 21;                                   // the board overdraws north of its tile
    ctx.globalAlpha = 0.18; px(x + 2, bt + 3, w, bh, '#000'); ctx.globalAlpha = 1;   // cast on the bulkhead
    for (const lx of [x + 5, x + w - 7]) {                        // wall lugs it hangs off
      px(lx, bt - 3, 2, 4, LINE); px(lx, bt - 3, 2, 1, U.shade(r.top, 0.20));
      rimEdge(lx + 1, bt - 2, 1, 3, 0.18);
    }
    // chamfered slate carcass — 2px corner cuts so the frame reads as machined, not as a lozenge
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 11, 1, 0.28);          // warm ceiling strip on the crown
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);                              // cool sky bounce, shade side
    for (const rx of [x + 2, x + w - 3]) { px(rx, bt + 2, 1, 1, U.shade(r.top, 0.30)); px(rx, bt + bh - 3, 1, 1, r.ao); }
    // recessed cork well: y-8 .. y+6, with a marker tray shelf under it
    inset(x + 2, bt + 2, w - 4, 15, '#131a15');
    px(x + 3, bt + 3, w - 6, 13, '#182219');                                  // cork ground, warmer than the frame
    wear(x + 3, bt + 3, w - 6, 13, 6, '#1f2a20');                             // old pin holes
    px(x + 2, bt + 17, w - 4, 1, r.ao);
    px(x + 3, bt + 18, w - 6, 2, U.shade(r.face, 0.08));                      // marker tray
    px(x + 3, bt + 18, w - 6, 1, r.lit); keyEdge(x + 4, bt + 18, w - 9, 1, 0.13);
    px(x + 5, bt + 19, 5, 1, '#b8452e'); px(x + 12, bt + 19, 4, 1, '#caa84a');// a marker + a chalk stub in the tray
    // PHOSPHOR HEADER — the terminal face names the surface and prints the open count as a number, so the
    // board is readable even when the card rail is full (VT323, the canvas text law)
    const hc = pins > 0 ? '#7df0c8' : '#2e5a4a';
    px(x + 3, bt + 3, w - 6, 6, '#0d1712');
    px(x + 3, bt + 3, w - 6, 1, '#16261e');
    ctx.fillStyle = hc;
    ctx.font = "7px 'VT323','Courier New',monospace"; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    // "OPEN", not "MISSIONS": at 3 tiles the board is 36px and a 7px VT323 "MISSIONS" runs ~28px,
    // so the right-aligned count landed ON TOP of it. The short word leaves the number its own space.
    ctx.fillText('OPEN', x + 5, bt + 8);
    ctx.textAlign = 'right'; ctx.fillText(String(pins), x + w - 5, bt + 8);
    if (pins > 0) {
      bloom(x + 4, bt + 4, w - 8, 4, '#41ffbe', 0.12);                        // panel bloom with real falloff
      spill(x + 3, bt + 9, w - 6, '#41ffbe', 0.13, 4);                        // header light pools onto the cork
      if (blink(600, ph)) px(x + w - 4, bt + 4, 1, 1, '#c7ffe8');             // live cursor tick
    }
    scanl(x + 3, bt + 3, w - 6, 6, 0.20);
    // PINNED CARDS — one per open quest at an even 6px pitch. 5 fit; past that 4 cards + a '+N' slot, so
    // the rail never crowds into an uncountable smear.
    const cap = pins > 5 ? 4 : 5, shown = Math.min(pins, cap);
    for (let i = 0; i < shown; i++) {
      const cx = x + 3 + i * 6, tilt = U.hash('mb' + i) % 2;                  // hash-phased hang: paper, not tiles
      const cy = bt + 11 + tilt;
      px(cx, cy + 1, 5, 6, '#0a0e0c');                                        // drop shadow off the cork
      px(cx, cy, 5, 6, '#aab6a4');
      px(cx, cy, 5, 1, '#d6e0cc'); keyEdge(cx, cy, 4, 1, 0.30);               // warm key along the paper's top
      px(cx + 4, cy + 1, 1, 5, '#7d8a78'); rimEdge(cx + 4, cy + 1, 1, 5, 0.16);
      px(cx + 1, cy + 2, 3, 1, '#59654f'); px(cx + 1, cy + 4, 2, 1, '#59654f');   // scrawled brief
      px(cx + 2, cy - 1, 1, 2, '#ffaa33');                                    // the pin
      bloom(cx + 2, cy - 1, 1, 1, '#ffaa33', 0.20);
    }
    if (pins > cap) {
      ctx.fillStyle = '#ffd9a3'; ctx.font = "8px 'VT323','Courier New',monospace";
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('+' + (pins - cap), x + 3 + cap * 6 + 1, bt + 16);
    }
    if (pins === 0) {                                                         // honest empty cork — nothing claimed
      px(x + 6, bt + 12, w - 12, 1, '#202b21'); px(x + 6, bt + 14, w - 18, 1, '#1c2620');
      px(x + w - 7, bt + 12, 1, 1, blink(2200, ph) ? '#3a4a3e' : '#222d24');  // one bare pin left in the board
    }
    // BEACON: a station-gap quest is OPEN — the frame breathes gold. Slow and gentle: a state, not an event.
    if (f && f.hot) {
      const b = 0.09 + 0.07 * (0.5 + 0.5 * Math.sin(now / 420));
      bloom(x, bt, w, bh, '#e8c860', b);
      px(x + 3, bt + 1, 1, 1, blink(840, 0.5) ? '#ffd75e' : '#3a3020');       // standing-order lamp on the frame
    }
    // PROPOSAL STATE: pending autojob requisitions the agent pinned itself — amber folded-corner cards
    // fanned over the board's top-left, distinct from the grey quest pins and the red-pinned jam stub.
    if (f && f.proposals > 0) {
      const np = f.proposals | 0, showP = Math.min(np, 3);
      bloom(x + 1, bt - 3, 16, 9, '#ffc24a', 0.08 + 0.06 * (0.5 + 0.5 * Math.sin(now / 500)));
      for (let i = 0; i < showP; i++) {
        const px0 = x + 4 + i * 3, py0 = bt - 3 + i;
        px(px0, py0 + 1, 6, 5, '#0a0e0c');
        px(px0, py0, 6, 5, '#f0b84a');
        px(px0, py0, 6, 1, '#ffdc8a'); keyEdge(px0, py0, 5, 1, 0.22);
        px(px0 + 4, py0, 2, 2, '#c98f2e');                                    // folded corner = requisition
        px(px0 + 1, py0 + 2, 3, 1, '#7a5a20'); px(px0 + 1, py0 + 3, 2, 1, '#7a5a20');
        px(px0 + 2, py0 - 1, 1, 1, '#ff7a3a');                                // orange pin head
      }
      if (np > 3) {
        ctx.fillStyle = '#ffd9a3'; ctx.font = "7px 'VT323','Courier New',monospace";
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('+' + (np - 3), x + 4 + showP * 3 + 6, bt + 2);
      }
    }
    // JAM STATE: a routine is backed up (repeatedly skipped). An amber stub pinned red over the top-right
    // + a faster amber wash — amber = "the line is jammed". Clears when the routine drains.
    if (f && f.jam) {
      const jb = 0.12 + 0.09 * (0.5 + 0.5 * Math.sin(now / 260));
      bloom(x + w - 10, bt - 2, 9, 10, '#ffae3a', jb);
      const sx = x + w - 8, sy = bt - 2;
      px(sx, sy + 1, 5, 6, '#0a0e0c');
      px(sx, sy, 5, 6, '#f0a83a');
      px(sx, sy, 5, 1, '#ffd07a'); keyEdge(sx, sy, 4, 1, 0.24);
      px(sx + 2, sy + 1, 1, 3, '#3a2410');
      px(sx + 2, sy + 4, 1, 1, blink(200) ? '#3a2410' : '#f0a83a');           // blinking "!" glyph
      px(sx + 2, sy - 1, 1, 2, '#ff5a4a');                                    // red jam pin
    }
  };

  F.trophycase = (x, y, w, h, f) => {
    // TROPHY CASE (2x2) — v4 REBUILD. Also predated the style law (flat box + inset). Now TALL 3/4: a
    // chamfered museum cabinet on a plinth, rising ~5px above its footprint, with a cold uplight washing
    // UP the glass and a warm key on its crown — the two-temperature split is what makes it read as glass
    // rather than a hole. f.trophies = REAL earned milestones, one gold cup each on an evenly-pitched
    // shelf so they stay countable; 6 visible + '+N'. EMPTY = honest dust, never a placeholder trophy.
    const won = Math.max(0, (f && f.trophies) | 0), lit = won > 0;
    const r = RAMP.steel, top = y - 5, plY = y + h - 7;
    shadow2(x + 1, y + h - 1, w - 2);                                        // floor contact
    // heavy plinth the case stands on — walnut/iron, chamfered, with a recessed toe kick
    chamf(x - 1, plY - 1, w + 2, 8, LINE, 2);
    chamf(x, plY, w, 6, '#241d15', 2);
    px(x + 1, plY, w - 2, 1, '#3d3122'); keyEdge(x + 1, plY, 7, 1, 0.20);
    px(x, plY + 2, 1, 3, '#3a2f22'); px(x + w - 1, plY + 2, 1, 3, '#120d08');
    rimEdge(x + w - 1, plY + 2, 1, 3, 0.18);
    px(x + 2, y + h - 2, w - 4, 1, '#0a0806');                               // toe-kick AO
    // cabinet carcass: dark chamfered frame, top cap we look down onto
    chamf(x - 1, top - 1, w + 2, (plY - top) + 2, LINE, 2);
    chamf(x, top, w, plY - top, '#1c1712', 2);
    chamf(x + 1, top + 1, w - 2, 3, '#2b231a', 2);                           // crown cap
    px(x + 2, top + 1, w - 4, 1, '#463a29'); keyEdge(x + 2, top + 1, 7, 1, 0.30);
    px(x + 2, top + 4, w - 4, 1, '#0f0b07');                                 // cap front lip
    px(x, top + 3, 1, plY - top - 4, '#2e2519'); px(x + w - 1, top + 3, 1, plY - top - 4, '#0f0b07');
    rimEdge(x + w - 1, top + 3, 1, plY - top - 4, 0.20);
    rivets(x + 1, top + 5, w - 2, plY - top - 6, '#5a4a34', '#0a0806');      // corner bolts
    // the glass interior
    const gx = x + 2, gy = top + 5, gw = w - 4, gh = plY - gy - 1;
    inset(gx, gy, gw, gh, '#0b0d0e');
    px(gx + 1, gy + 1, gw - 2, 1, '#141a1e');                                // back wall catches a little light
    // eerie museum UPLIGHT — a cold wash climbing the glass off a strip in the plinth (falloff, not a sticker)
    const up = 0.13 + 0.05 * (0.5 + 0.5 * Math.sin(now / 900));
    px(gx + 1, gy + gh - 2, gw - 2, 1, lit ? '#5d7f96' : '#243138');         // the strip itself
    bloom(gx + 1, gy + gh - 3, gw - 2, 2, lit ? '#c9e6ff' : '#4a5f6e', up);
    // two shelves, 3 trophies each — fixed 6px pitch keeps the row countable at a glance
    const shelfY = [gy + 1, gy + 9];
    const shown = Math.min(won, 6);
    for (let s = 0; s < 2; s++) {
      const sy = shelfY[s];
      px(gx + 1, sy + 6, gw - 2, 1, '#2e2415');                              // shelf plank
      px(gx + 1, sy + 7, gw - 2, 1, '#100c08');                              // plank underside
      const nOn = Math.max(0, Math.min(3, shown - s * 3));
      for (let i = 0; i < 3; i++) {
        const tx = gx + 2 + i * 6, on = i < nOn;
        if (on) {
          const gc = '#f3c94a', gd = '#a8842a';
          px(tx + 1, sy + 1, 3, 2, gc);                                      // cup
          px(tx, sy + 1, 1, 1, gd); px(tx + 4, sy + 1, 1, 1, gd);            // handles
          px(tx + 1, sy + 1, 1, 2, U.shade(gc, 0.30));                       // lit west flank
          px(tx + 3, sy + 1, 1, 2, gd);                                      // shaded east flank
          px(tx + 2, sy + 3, 1, 2, gd);                                      // stem
          px(tx + 1, sy + 5, 3, 1, gc); px(tx + 1, sy + 5, 3, 1, U.shade(gc, -0.10));
          px(tx + 1, sy + 6, 3, 1, '#1a1206');                               // contact shade on the plank
          if (blink(1100, (i + s) * 0.3)) px(tx + 2, sy + 1, 1, 1, U.shade(gc, 0.40)); // slow glint, not a white speck
          bloom(tx + 1, sy + 1, 3, 2, gc, 0.16);
        } else if (won === 0 && s === 0 && i === 1 && blink(1700, 0)) {
          px(tx + 2, sy + 3, 1, 1, '#2a3138');                               // one dust mote: nothing earned yet
        }
      }
    }
    if (won > 6) {
      ctx.fillStyle = '#ffe6a0'; ctx.font = "8px 'VT323','Courier New',monospace";
      ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('+' + (won - 6), gx + gw - 1, gy + 7);
    }
    // engraved plaque on the plinth — phosphor-gold when won, cold-dim when the case is honestly empty
    px(x + 3, plY + 1, w - 6, 4, '#100c08');
    px(x + 3, plY + 1, w - 6, 1, '#2c2318');
    ctx.fillStyle = lit ? '#e8c860' : '#3e4650';
    ctx.font = "6px 'VT323','Courier New',monospace"; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(lit ? 'HONOURS' : 'EMPTY', x + 4, plY + 5);
    // glass: a soft diagonal sheen + a hard corner catch, so the front reads as a pane, not an open shelf
    ctx.save(); ctx.globalAlpha = 0.07; ctx.fillStyle = '#dff0ff';
    ctx.beginPath(); ctx.moveTo(gx + 1, gy + 1); ctx.lineTo(gx + 1 + (gw >> 1), gy + 1);
    ctx.lineTo(gx + 1, gy + 1 + (gh >> 1)); ctx.closePath(); ctx.fill();
    ctx.restore();
    rimEdge(gx, gy, 1, gh, 0.22);                                            // cold pane edge, west
    px(gx + gw - 1, gy + gh - 4, 1, 3, '#1b232a');
  };

  F.splitter = (x, y, w, h, f) => {
    // SPLITTER (1x1) — fans ONE stream across its lanes (load-balance = real parallelism). At 12px detail is
    // noise, so it gets a FORKED outline (two nozzles off the east face) and exactly one emissive idea: a
    // packet rides in on the trunk and leaves by alternating branches. One in, two out — that is the whole read.
    const r = RAMP.steel, on = !!(f && f.work), c = '#5ad1b3', ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const ny of [y + 2, y + 6]) {                          // the silhouette itself forks
      px(x + w - 1, ny - 1, 3, 4, LINE);
      px(x + w, ny, 2, 2, r.face); px(x + w, ny, 2, 1, r.lit);
    }
    chamf(x - 1, y + 5, w + 2, 6, LINE, 1);                     // low bolted body: short south face
    chamf(x, y + 6, w, 4, r.face, 1);
    px(x + 1, y + 6, w - 2, 1, r.lit); keyEdge(x + 2, y + 6, 5, 1, 0.16);
    px(x + 1, y + 9, w - 2, 1, r.ao);
    px(x + 2, y + 8, 1, 1, '#caa84a'); px(x + w - 3, y + 8, 1, 1, '#caa84a');   // deck-bolt hazard ticks
    chamf(x - 1, y, w + 2, 7, LINE, 1);                         // lit top
    chamf(x, y + 1, w, 5, r.top, 1);
    px(x + 1, y + 1, w - 2, 1, r.sheen); keyEdge(x + 1, y + 1, 4, 1, 0.26);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk); rimEdge(x + w - 1, y + 2, 1, 3, 0.20);
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.18));
    // recessed lane well — casing stays steel, the identity is the light in the channel
    px(x + 1, y + 2, w - 2, 3, '#101a1e'); px(x + 1, y + 2, w - 2, 1, '#0a1216');
    const dim = U.shade(c, -0.55), lc = on ? U.shade(c, 0.22) : U.shade(c, -0.12);
    px(x + 1, y + 3, 5, 1, dim);                                // trunk in
    px(x + 6, y + 2, 5, 1, dim); px(x + 6, y + 4, 5, 1, dim);   // the two branches
    px(x + 6, y + 3, 1, 1, lc);                                 // split node
    // the one moving idea: a packet in on the trunk, out by alternating branch
    const per = on ? 620 : 1100, t = (now % per) / per, alt = Math.floor(now / per) % 2;
    const pxp = t < 0.5 ? x + 1 + Math.floor(t * 10) : x + 6 + Math.floor((t - 0.5) * 10);
    const pyp = t < 0.5 ? y + 3 : (alt ? y + 4 : y + 2);
    px(pxp, pyp, 2, 1, '#c8f4e6'); bloom(pxp, pyp, 2, 1, c, on ? 0.40 : 0.24);
    px(x + w, y + 2, 2, 1, alt ? dim : lc); px(x + w, y + 6, 2, 1, alt ? lc : dim);   // nozzle tips
    px(x + 2, y + 7, 1, 1, blink(360, ph) ? '#7df0c8' : U.shade(c, -0.55));           // routing LED
    if (on) glow(x, y + 1, w, 5, c, 0.10);
  };

  F.filter = (x, y, w, h, f) => {
    // FILTER (1x1) — the content router: reads a box's tag and sends it down a chosen lane. The only router
    // with HEIGHT: a sorting CARTRIDGE standing on the deck box, so the three junctions are told apart by
    // outline alone at 12px. One emissive idea: the cartridge window shows the route it just picked, and the
    // matching out-lane tip lights the same colour (cyan code / amber research / neutral default).
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    const ROUTE = [ACC.data, ACC.flow, '#8a9a90'], sel = Math.floor(now / (on ? 800 : 1400)) % 3, rc = ROUTE[sel];
    shadow2(x + 1, y + h - 1, w - 2);
    chamf(x - 1, y + 5, w + 2, 6, LINE, 1);
    chamf(x, y + 6, w, 4, r.face, 1);
    px(x + 1, y + 6, w - 2, 1, r.lit); keyEdge(x + 2, y + 6, 5, 1, 0.16);
    px(x + 1, y + 9, w - 2, 1, r.ao);
    px(x + 2, y + 8, 1, 1, '#caa84a'); px(x + w - 3, y + 8, 1, 1, '#caa84a');
    chamf(x - 1, y, w + 2, 7, LINE, 1);
    chamf(x, y + 1, w, 5, r.top, 1);
    px(x + 1, y + 1, w - 2, 1, r.sheen); keyEdge(x + 1, y + 1, 3, 1, 0.26);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk); rimEdge(x + w - 1, y + 2, 1, 3, 0.20);
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.18));
    px(x + 1, y + 2, w - 2, 3, '#161020'); px(x + 1, y + 2, w - 2, 1, '#0e0a16');   // violet lane well
    px(x + 1, y + 3, 4, 1, on ? U.shade(ACC.mem, 0.20) : U.shade(ACC.mem, -0.20));  // unsorted trunk IN
    px(x + 8, y + 3, 3, 1, U.shade(rc, -0.15));                                     // sorted lane OUT
    for (let i = 0; i < 3; i++) {                                                   // three route tips, one lit
      const ty = y + 2 + i;
      px(x + w - 2, ty, 2, 1, i === sel ? ROUTE[i] : U.shade(ROUTE[i], -0.62));
      if (i === sel) bloom(x + w - 2, ty, 2, 1, ROUTE[i], on ? 0.34 : 0.20);
    }
    const pk = (now % 700) / 700;                               // a box riding in to be read
    px(x + 1 + Math.floor(pk * 4), y + 3, 1, 1, '#d8b8ff');
    // SORTING CARTRIDGE — the silhouette that names it; collar ties it to the box so it can't float
    const dx0 = x + 3, dt = y - 7;
    px(x + 2, y, 8, 2, LINE); px(x + 3, y, 6, 1, U.shade(r.top, 0.10)); px(x + 3, y + 1, 6, 1, r.ao); // collar
    chamf(dx0 - 1, dt - 1, 8, 10, LINE, 2);
    chamf(dx0, dt, 6, 8, r.face, 2);
    px(dx0 + 1, dt, 4, 1, r.top); keyEdge(dx0 + 1, dt, 3, 1, 0.28);
    px(dx0, dt + 2, 1, 5, r.lit); px(dx0 + 5, dt + 2, 1, 5, r.dk); rimEdge(dx0 + 5, dt + 2, 1, 5, 0.20);
    px(dx0, dt + 1, 6, 1, U.shade(r.face, -0.36)); px(dx0, dt + 7, 6, 1, U.shade(r.face, -0.36)); // clamp bands
    px(dx0 + 1, dt + 3, 4, 3, '#140b1c');                       // sight window
    px(dx0 + 1, dt + 4, 4, 1, U.shade(rc, on ? 0.10 : -0.30));  // the route it just picked
    px(dx0 + 1 + (Math.floor(now / 190) % 4), dt + 3, 1, 1, U.shade(ACC.mem, 0.35)); // tag-read scan
    bloom(dx0 + 1, dt + 3, 4, 3, ACC.mem, on ? 0.26 : 0.13);    // violet halo = "this is the filter"
    px(dx0 + 4, dt + 6, 1, 1, blink(420, ph) ? '#d8b8ff' : U.shade(ACC.mem, -0.5)); // sorting LED
  };

  F.merger = (x, y, w, h, f) => {
    // MERGER (1x1) — buffers K inbound boxes and emits ONE combined box (a join / map-reduce barrier).
    // The exact silhouette INVERSE of the splitter: two horns on the west, one fat outlet east. Its one
    // emissive idea is the join itself — two packets ride in, the buffer fills, one bigger packet leaves.
    const r = RAMP.steel, on = !!(f && f.work), c = '#e0a45a', ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const ny of [y + 2, y + 6]) {                          // twin intake horns, west
      px(x - 2, ny - 1, 3, 4, LINE);
      px(x - 2, ny, 2, 2, r.face); px(x - 2, ny, 2, 1, r.lit);
    }
    px(x + w - 1, y + 2, 3, 5, LINE);                           // one FAT outlet, east
    px(x + w, y + 3, 2, 3, r.face); px(x + w, y + 3, 2, 1, r.lit);
    chamf(x - 1, y + 5, w + 2, 6, LINE, 1);
    chamf(x, y + 6, w, 4, r.face, 1);
    px(x + 1, y + 6, w - 2, 1, r.lit); keyEdge(x + 2, y + 6, 5, 1, 0.16);
    px(x + 1, y + 9, w - 2, 1, r.ao);
    px(x + 2, y + 8, 1, 1, '#caa84a'); px(x + w - 3, y + 8, 1, 1, '#caa84a');
    chamf(x - 1, y, w + 2, 7, LINE, 1);
    chamf(x, y + 1, w, 5, r.top, 1);
    px(x + 1, y + 1, w - 2, 1, r.sheen); keyEdge(x + 1, y + 1, 4, 1, 0.26);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk); rimEdge(x + w - 1, y + 2, 1, 3, 0.20);
    px(x + 1, y + 5, w - 2, 1, U.shade(r.top, -0.18));
    px(x + 1, y + 2, w - 2, 3, '#1c150e'); px(x + 1, y + 2, w - 2, 1, '#120e08');   // lane well
    const dim = U.shade(c, -0.55), lc = on ? U.shade(c, 0.22) : U.shade(c, -0.12);
    px(x + 1, y + 2, 5, 1, dim); px(x + 1, y + 4, 5, 1, dim);   // two inputs converging
    px(x + 5, y + 3, 1, 1, lc);                                 // the join node
    px(x + 6, y + 3, 5, 1, dim);                                // combined out lane
    const per = on ? 900 : 1500, t = (now % per) / per;
    if (t < 0.55) {                                             // both inputs ride in...
      const p = x + 1 + Math.floor((t / 0.55) * 4);
      px(p, y + 2, 1, 1, '#ffd488'); px(p, y + 4, 1, 1, '#ffd488');
      bloom(p, y + 2, 1, 1, c, 0.26); bloom(p, y + 4, 1, 1, c, 0.26);
      px(x + 5, y + 3, 1, 1, U.shade(c, -0.2 + 0.4 * (t / 0.55)));   // buffer filling
    } else {                                                    // ...and ONE fatter box leaves
      const p = x + 5 + Math.floor(((t - 0.55) / 0.45) * 6);
      px(p, y + 3, 2, 1, '#ffd488'); bloom(p, y + 3, 2, 1, c, on ? 0.40 : 0.26);
    }
    px(x + w, y + 4, 2, 1, t < 0.55 ? dim : lc);                // outlet tip
    px(x + 2, y + 7, 1, 1, blink(520, ph) ? '#ffd488' : U.shade(c, -0.5));   // buffer LED
    if (on) glow(x, y + 1, w, 5, c, 0.10);
  };

  F.bay = (x, y, w, h, f) => {
    // BAY (2x2) — the agent DOCK. v4: a berth between two GUIDE ARMS carrying a gantry NAMEPLATE, so the
    // dock reads as a berth from across the room and the bound agent's name sits at eye level instead of
    // being stencilled flat on the floor. Nameplate lit = bound, dim bar = UNASSIGNED (f.agentId).
    const bound = !!(f && f.agentId), act = !!(f && f.work);
    const r = RAMP.steel, c = bound ? '#5ad1b3' : '#3a464a';
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 6, w + 2, 6);
    deckSocket(x + w + 1, y + h - 3, bound);
    px(x + w, y + h - 3, 1, 1, '#0e1418');
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
      rimEdge(lx + 2, y + h - 5, 1, 2, 0.16);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // south face of the pad
    chamf(x - 1, y + h - 11, w + 2, 7, LINE, 2);
    chamf(x, y + h - 10, w, 5, r.face, 2);
    px(x + 1, y + h - 10, w - 2, 1, r.lit); keyEdge(x + 2, y + h - 10, w - 5, 1, 0.15);
    px(x, y + h - 8, 1, 3, U.shade(r.face, 0.08)); px(x + w - 1, y + h - 8, 1, 3, r.dk);
    px(x + 1, y + h - 6, w - 2, 1, r.ao);
    for (let i = 0; i < 4; i++) px(x + 4 + i * 4, y + h - 9, 2, 1, r.ao);   // vent slots
    // the berth PAD
    chamf(x - 1, y + h - 20, w + 2, 10, LINE, 2);
    chamf(x, y + h - 19, w, 8, r.top, 2);
    px(x + 2, y + h - 19, w - 4, 1, r.sheen); keyEdge(x + 2, y + h - 19, 8, 1, 0.26);
    px(x, y + h - 17, 1, 5, r.lit); px(x + w - 1, y + h - 17, 1, 5, r.dk);
    rimEdge(x + w - 1, y + h - 17, 1, 5, 0.20);
    px(x + 2, y + h - 12, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 2, y + h - 18, w - 4, 5, 3, U.shade(r.top, -0.10));
    // painted berth box + centre-in chevron: work berths HERE
    const bx0 = x + 5, by0 = y + h - 17, bw = w - 10, bh = 5;
    for (let i = 0; i < bw; i += 2) { px(bx0 + i, by0, 1, 1, '#caa84a'); px(bx0 + i, by0 + bh - 1, 1, 1, '#caa84a'); }
    for (let j = 0; j < bh; j += 2) { px(bx0, by0 + j, 1, 1, '#caa84a'); px(bx0 + bw - 1, by0 + j, 1, 1, '#caa84a'); }
    px(x + (w >> 1) - 2, by0 + 1, 5, 1, c); px(x + (w >> 1), by0 + 2, 1, 2, c);
    if (act) bloom(bx0, by0, bw, bh, c, 0.22 + 0.10 * Math.sin(now / 300));   // the dock is live
    // GUIDE ARMS — hazard-banded posts standing on the pad, docking lamp at each head
    for (let s = 0; s < 2; s++) {
      const ax = s ? x + w - 5 : x + 1;
      px(ax - 1, y - 7, 6, 16, LINE);
      px(ax, y - 6, 4, 14, r.face);
      px(ax, y - 6, 4, 1, r.top); keyEdge(ax, y - 6, 4, 1, 0.26);
      px(ax, y - 5, 1, 13, r.lit); px(ax + 3, y - 5, 1, 13, r.dk); rimEdge(ax + 3, y - 5, 1, 13, 0.18);
      for (let i = 0; i < 3; i++) px(ax, y + 1 + i * 3, 4, 1, i % 2 ? '#caa84a' : U.shade(r.face, -0.42));
      px(ax + 1, y - 5, 2, 2, bound ? (blink(700, s) ? '#7df0c8' : U.shade(c, -0.5)) : '#2a2018');
      if (bound && blink(700, s)) bloom(ax + 1, y - 5, 2, 2, c, 0.30);
    }
    // gantry NAMEPLATE spanning the arms — ties the two posts into one silhouette
    px(x + 4, y - 4, w - 8, 10, LINE);
    chamf(x + 5, y - 3, w - 10, 8, r.face, 1);
    px(x + 6, y - 3, w - 12, 1, r.top); keyEdge(x + 6, y - 3, 6, 1, 0.24);
    px(x + 5, y + 4, w - 10, 1, r.ao);
    inset(x + 6, y - 2, w - 12, 6, bound ? '#0e1c16' : '#101619');
    if (bound) {
      px(x + 7, y - 1, w - 14, 1, '#1e3a2c');
      ctx.fillStyle = '#7df0c8'; ctx.font = "8px 'VT323','Courier New',monospace";
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(f.agentId).replace(/^tg_/, '').slice(0, 5).toUpperCase(), x + (w >> 1), y + 1);
      bloom(x + 7, y - 1, w - 14, 4, c, 0.10 + (act ? 0.10 : 0));
    } else {
      px(x + 8, y, w - 16, 1, '#2a3438'); px(x + 8, y + 2, w - 20, 1, '#232c30');   // dim UNASSIGNED bars
      px(x + w - 9, y + 3, 1, 1, blink(1500) ? '#ff9d2e' : '#33241a');              // waiting-for-an-agent amber
    }
  };

  F.boxes = (x, y, w, h) => {
    // BOXES (2x1) — the same freight family as CRATE but in FIBREBOARD, not steel: no castings, no ribs,
    // no skids. Taped flap creases, paper labels and the fabric ramp carry the material read, and the
    // varied heights + 1px offsets keep the pile from stacking into one block.
    const cw = w, floorY = y + h - 1;
    // one carton: dominant lid (depth ld) over a short face (fh), base at fb
    const carton = (bx, fb, bw, fh, ld, ramp, tint) => {
      const ty = fb - fh - ld;
      rr(bx, ty + ld, bw, fh, LINE);                                   // short front face
      px(bx + 1, ty + ld + 1, bw - 2, fh - 2, ramp.face);
      px(bx + 1, ty + ld + 1, 1, fh - 2, ramp.lit);
      px(bx + bw - 2, ty + ld + 1, 1, fh - 2, ramp.dk);
      rimEdge(bx + bw - 2, ty + ld + 1, 1, fh - 2, 0.18);              // cool bounce on the shade side
      px(bx + 1, fb - 1, bw - 2, 1, ramp.ao);                          // floor-line AO
      px(bx + (bw >> 1), ty + ld + 1, 1, fh - 2, U.shade(ramp.face, 0.12));   // tape seam down the face
      px(bx + 2, ty + ld + 2, 3, 2, '#d8e0d6'); px(bx + 2, ty + ld + 2, 3, 1, '#eaf2e8');  // shipping label
      px(bx + 2, ty + ld + 3, 2, 1, '#96a696');                        // barcode
      px(bx + bw - 4, ty + ld + 2, 2, 1, tint);                        // priority sticker
      rr(bx - 1, ty, bw + 2, ld + 1, LINE);                            // DOMINANT lid
      px(bx, ty + 1, bw, ld, ramp.top);
      px(bx, ty + 1, bw, 1, ramp.sheen); keyEdge(bx, ty + 1, Math.max(2, bw - 5), 1, 0.26);
      px(bx, ty + 2, 1, ld - 1, ramp.lit); px(bx + bw - 1, ty + 2, 1, ld - 1, ramp.dk);
      px(bx + (bw >> 1), ty + 1, 1, ld, U.shade(ramp.top, -0.20));     // flap crease
      px(bx + 1, ty + 2, bw - 2, 1, U.shade(ramp.top, 0.06));          // cross-tape catch
      px(bx, ty + ld, bw, 1, U.shade(ramp.top, -0.16));                // lid front lip
      px(bx + bw - 5, ty + 1, 3, 1, tint);                             // cargo tag on the lid
    };
    shadow2(x + 1, floorY, cw - 2);
    carton(x + 1, floorY, 13, 4, 5, RAMP.steel, ACC.data);             // big front-left carton
    carton(x + 13, floorY - 1, 10, 3, 6, RAMP.fabric, ACC.flow);       // taller back-right one, nudged east
    // small carton perched on the left lid, offset a pixel so the pile leans
    const sx = x + 3, sb = floorY - 8;
    rr(sx, sb - 4, 7, 5, LINE);
    px(sx + 1, sb - 2, 5, 2, RAMP.fabric.face); px(sx + 1, sb - 2, 1, 2, RAMP.fabric.lit);
    rimEdge(sx + 5, sb - 2, 1, 2, 0.18);
    px(sx + 1, sb - 3, 5, 2, RAMP.fabric.top); px(sx + 1, sb - 3, 5, 1, RAMP.fabric.sheen);
    keyEdge(sx + 1, sb - 3, 3, 1, 0.26);
    px(sx + 4, sb - 3, 1, 2, U.shade(RAMP.fabric.top, -0.18));         // flap
    px(sx + 2, sb - 3, 1, 1, ACC.alert);                               // fragile dot
    px(sx + 1, sb, 5, 1, U.shade(RAMP.fabric.ao, 0.15));               // contact shade on the lid below
    px(x + cw - 6, floorY, 3, 1, U.shade(RAMP.steel.face, -0.22));     // floor scuff
  };


  F.djbooth = (x, y, w, h, f) => {   // v4 DJ console (4x2) — chamfered deck + tied-down EQ riser; lounge light, freestanding
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);                             // lounge tier = freestanding: floor contact, no deck plate
    for (const lx of [x + 3, x + 23, x + w - 6]) leg(lx, y + 21, 3, r);
    underAO(x + 5, y + 21, w - 10, 2);
    // short south face — the neon rail under the lip is the booth's identity, so it gets real falloff
    chamf(x - 1, y + 16, w + 2, 6, LINE, 2);
    px(x, y + 17, w, 4, r.face);
    px(x, y + 17, w, 1, r.lit); keyEdge(x + 1, y + 17, w - 3, 1, 0.15);
    for (let i = 1; i < 4; i++) { px(x + i * 12, y + 18, 1, 3, r.ao); px(x + 1 + i * 12, y + 18, 1, 3, U.shade(r.face, 0.12)); }
    px(x + w - 1, y + 17, 1, 4, r.dk); rimEdge(x + w - 1, y + 17, 1, 4, 0.20);
    px(x, y + 20, w, 1, r.ao);
    bloom(x + 2, y + 19, w - 4, 1, ACC.lounge, on ? 0.34 + 0.14 * Math.sin(now / 200) : 0.13);
    glow(x + 3, y + 22, w - 6, 2, ACC.lounge, on ? 0.14 + 0.06 * Math.sin(now / 200) : 0.04);   // pool on the floor
    // the big CHAMFERED deck top dominates — 2px cuts read as a real bevel where rr() read as a lozenge
    chamf(x - 1, y - 3, w + 2, 20, LINE, 2);
    chamf(x, y - 2, w, 18, r.top, 2);
    px(x + 2, y - 2, w - 4, 1, r.sheen); keyEdge(x + 2, y - 2, 9, 1, 0.28);   // warm ceiling strip on the back edge
    px(x, y, 1, 14, r.lit); px(x + w - 1, y, 1, 14, r.dk);
    rimEdge(x + w - 1, y, 1, 14, 0.20);                           // cool sky bounce down the shade flank
    px(x + 1, y + 15, w - 2, 1, U.shade(r.top, -0.18));           // front lip of the deck
    wear(x + 2, y, w - 4, 14, 4, U.shade(r.top, -0.09));
    // twin turntables (top view): plinth, platter, grooves, tonearm, orbiting stylus glint while playing
    for (const tx of [x + 5, x + w - 16]) {
      chamf(tx - 1, y + 1, 13, 12, LINE, 2);
      chamf(tx, y + 2, 11, 10, '#161a20', 2);
      px(tx + 2, y + 2, 7, 1, '#2b323d'); keyEdge(tx + 2, y + 2, 4, 1, 0.16);   // plinth catch
      rr(tx + 1, y + 3, 9, 8, '#101014');
      rr(tx + 2, y + 4, 7, 6, '#1e1e22');
      px(tx + 2, y + 4, 7, 1, '#2e2e34'); px(tx + 2, y + 8, 7, 1, '#161619');    // groove rings
      px(tx + 4, y + 6, 3, 2, '#0a0a0c');
      px(tx + 4, y + 6, 1, 1, ACC.lounge);                        // label dot
      px(tx + 9, y + 3, 1, 4, '#4a5866'); px(tx + 9, y + 3, 1, 1, U.shade('#4a5866', 0.34));
      px(tx + 8, y + 7, 1, 1, '#5c6c7c');                         // tonearm + headshell
      if (on) {
        const a = now / 250 + tx;
        px(tx + 5 + Math.round(Math.cos(a) * 3), y + 7 + Math.round(Math.sin(a) * 2), 1, 1, '#ffe0f4');
        bloom(tx + 2, y + 4, 7, 6, ACC.lounge, 0.07);             // platter picks up the rig's own light
      }
    }
    // mixer between the decks — faders that actually ride the mix, cue LEDs above them
    const mx = x + Math.round(w / 2) - 6;
    inset(mx, y + 3, 12, 9, '#1a1420');
    px(mx + 1, y + 3, 10, 1, '#332840');
    for (let i = 0; i < 3; i++) {
      px(mx + 3 + i * 3, y + 5, 1, 6, '#3a2a4e');                 // fader slot
      const sv = on ? Math.abs(Math.floor(flick(150, i) * 2)) : 1;
      px(mx + 3 + i * 3, y + 9 - sv, 1, 2, ACC.lounge);
      px(mx + 3 + i * 3, y + 9 - sv, 1, 1, '#ffa8e8');            // fader cap
    }
    for (let i = 0; i < 4; i++) px(mx + 2 + i * 2, y + 4, 1, 1, (on && blink(300, i)) ? ACC.data : '#2c1c40');
    if (on) bloom(mx + 1, y + 4, 10, 7, ACC.lounge, 0.10);
    knurl(mx + 1, y + 11, 10, 1, r.top);                          // machined grip strip on the deck front
    // EQ RISER on the back edge — bracketed DOWN to the deck so it isn't a second floating object
    for (const bx of [x + 9, x + w - 11]) { px(bx, y - 3, 2, 3, LINE); px(bx, y - 3, 1, 3, r.lit); px(bx + 1, y - 3, 1, 3, r.dk); }
    chamf(x + 9, y - 9, w - 18, 8, LINE, 2);
    chamf(x + 10, y - 8, w - 20, 6, '#151021', 2);
    px(x + 11, y - 8, w - 22, 1, '#2a2038'); keyEdge(x + 11, y - 8, 6, 1, 0.22);
    px(x + 10, y - 6, 1, 3, '#241b32'); px(x + w - 11, y - 6, 1, 3, '#0e0a16');
    rimEdge(x + w - 11, y - 6, 1, 3, 0.18);
    for (let i = 0; i < (w - 24) / 3; i++) {                      // EQ bars + peak-hold dots (kept behaviour)
      const hh = on ? 1 + Math.abs(Math.floor(flick(90, i) * 3)) : 1;
      const c = ['#b44aff', ACC.lounge, ACC.data][i % 3];
      px(x + 12 + i * 3, y - 2 - hh, 2, hh, c);
      if (on) px(x + 12 + i * 3, y - 3 - hh, 2, 1, U.shade(c, 0.45));
    }
    if (on) { bloom(x + 11, y - 7, w - 22, 5, ACC.lounge, 0.13); spill(x + 10, y - 1, w - 20, ACC.lounge, 0.20, 5); }
    else glow(x + 11, y - 7, w - 22, 5, ACC.lounge, 0.05);
    if (on) px(x + Math.round(w / 2) - 1, y - 9, 2, 1, blink(150) ? ACC.lounge : ACC.data);   // beat lamp on the crown
    else px(x + Math.round(w / 2) - 1, y - 9, 2, 1, blink(1700, ph) ? '#7a3a68' : '#2a1626'); // idle standby, not dead black
    // record crate resting on the east end, sleeves fanned
    px(x + w - 9, y + 12, 6, 3, '#1d1826'); px(x + w - 9, y + 12, 6, 1, '#332c44');
    px(x + w - 8, y + 11, 1, 1, '#b44aff'); px(x + w - 6, y + 11, 1, 1, ACC.data);
    cable(x + w - 3, y + 16, x + w + 1, y + 22, 2, '#0b1114');    // limp deck lead sagging off the back corner
  };

  F.speaker = (x, y, w, h, f) => {   // v4 lounge speaker (1x1) — chamfered cab, cloth grille, cone throbs on f.work
    const r = RAMP.fabric, ph = (f && f.x) || 0, on = !!(f && f.work);
    shadow2(x + 2, y + h - 1, 8);
    for (const lx of [x + 2, x + 7]) {                            // stub feet, freestanding
      px(lx, y + 10, 3, 2, LINE); px(lx, y + 10, 1, 2, r.lit); px(lx + 1, y + 10, 1, 2, r.dk);
    }
    underAO(x + 4, y + 10, 4, 1);
    // chamfered cab with a narrow lit top cap — 12px wide, so the bevel has to do the silhouette work
    chamf(x + 1, y - 3, 10, 13, LINE, 1);
    chamf(x + 2, y - 2, 8, 11, r.face, 1);
    px(x + 2, y, 1, 8, U.shade(r.face, 0.10)); px(x + 9, y, 1, 8, r.dk);
    rimEdge(x + 9, y, 1, 8, 0.22);                                // cool bounce down the shade side
    px(x + 3, y - 2, 6, 2, r.top); px(x + 3, y - 2, 6, 1, r.sheen);
    keyEdge(x + 3, y - 2, 4, 1, 0.30);                            // warm cap catch
    px(x + 2, y + 8, 8, 1, r.ao);
    // grille cloth over the baffle — a weave, so the cab doesn't read as bare plastic
    for (let j = 0; j < 8; j += 2) px(x + 3, y + j, 6, 1, U.shade(r.face, -0.16));
    // driver: surround ring, cone, dust cap
    chamf(x + 3, y + 1, 6, 6, '#2c3641', 1);
    px(x + 4, y + 1, 4, 1, '#40495a');                            // ring catch
    chamf(x + 4, y + 2, 4, 4, '#10151b', 1);
    px(x + 5, y + 3, 2, 2, '#06090c');
    px(x + 5, y + 3, 1, 1, '#39434f');                            // soft cap catch (a white speck reads as a dead pixel)
    if (on) {
      const b = blink(170, ph);
      bloom(x + 4, y + 2, 4, 4, ACC.lounge, b ? 0.30 : 0.10);     // cone throb with falloff
      if (b) px(x + 5, y + 3, 2, 2, '#1c1220');                   // cone punched forward on the beat
      spill(x + 3, y + 8, 6, ACC.lounge, 0.16, 3);                // light pools down onto the floor
    }
    px(x + 5, y + 7, 2, 1, '#0e1216');                            // bass port
    px(x + 8, y - 1, 1, 1, on && blink(400, ph) ? ACC.lounge : (blink(2200, ph) ? '#5a2a4a' : '#3a2434')); // standby lamp, never fully dead
  };

  F.vault = (x, y, w, h, f) => {   // v4 vault (3x2) — the family's HEAVY end: a low bunker behind a round blast door
    // Same secured-storage language as intelcab/safe/rack/shelf, but SCALE is the whole point: 3x2 of mass, and
    // the read is one huge circular door with retracting lock bolts. Nothing else in the family is round or wide.
    const r = RAMP.steel, on = !!(f && f.work);
    const seal = (lx, ly, lit) => {
      px(lx, ly, 2, 2, lit ? '#c7ffe0' : U.shade(ACC.work, -0.62));
      if (lit) bloom(lx, ly, 2, 2, ACC.work, 0.32);
    };
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x + 1, y + h - 4, w - 2, 4);
    deckSocket(x + 1, y + h - 3, on); deckSocket(x + w - 5, y + h - 3, on);
    // THICK door face (the bunker's south wall)
    chamf(x - 1, y + 3, w + 2, h - 3, LINE, 2);
    chamf(x, y + 4, w, h - 6, r.face, 2);
    px(x, y + 6, 1, h - 10, U.shade(r.face, 0.12)); px(x + w - 1, y + 6, 1, h - 10, r.dk);
    rimEdge(x + w - 1, y + 7, 1, h - 12, 0.22);
    px(x + 1, y + h - 3, w - 2, 1, r.ao);                             // floor-line AO
    px(x + 3, y + h - 2, w - 6, 1, '#1a2228');                        // floor RAIL the door rolls along
    for (let i = 0; i < 6; i++) px(x + 5 + i * 5, y + h - 2, 1, 1, '#39454d');
    // hinge column, west — big knuckles proud of the outline so the silhouette isn't a slab
    for (const hy of [y + 7, y + 14]) {
      px(x - 2, hy, 4, 5, LINE); px(x - 1, hy + 1, 3, 3, r.face);
      px(x - 1, hy + 1, 3, 1, r.lit); keyEdge(x - 1, hy + 1, 2, 1, 0.20); px(x - 1, hy + 3, 3, 1, r.ao);
    }
    // big BOLD top mass — we look down on it; it carries the warm key and the hazard stencilling
    chamf(x - 1, y - 5, w + 2, 10, LINE, 2);
    chamf(x, y - 4, w, 9, r.top, 2);
    px(x + 2, y - 4, w - 4, 1, r.sheen); keyEdge(x + 2, y - 4, 11, 1, 0.30);
    px(x, y - 2, 1, 6, r.lit); px(x + w - 1, y - 2, 1, 6, r.dk);
    rimEdge(x + w - 1, y - 2, 1, 6, 0.20);
    for (let i = 0; i < 3; i++) px(x + 4 + i * 12, y - 2 + i, 8 - i, 1, U.shade(r.top, 0.055)); // brushed grain
    px(x + Math.round(w / 2), y - 4, 1, 8, U.shade(r.top, -0.18));    // top seam
    px(x + 2, y + 4, w - 4, 1, U.shade(r.top, -0.20));                // front lip of the top mass
    for (let i = 0; i < 4; i++) px(x + 2 + i * 3, y + 3, 2, 1, '#8a7434');   // hazard ticks, west corner
    wear(x + 2, y - 3, w - 4, 6, 5, U.shade(r.top, -0.10));
    // ---- ROUND BLAST DOOR: the hero. Locking bolts drive OUT into the frame, then retract.
    const cx = x + 15, cy = y + 13, R = 7.5;
    const lockT = 0.5 + 0.5 * Math.sin(now / 2600);
    ctx.fillStyle = LINE; ctx.beginPath(); ctx.arc(cx, cy, R + 1.4, 0, 6.2832); ctx.fill();
    ctx.fillStyle = U.shade(r.face, -0.30); ctx.beginPath(); ctx.arc(cx, cy, R + 0.6, 0, 6.2832); ctx.fill();
    ctx.fillStyle = U.shade(r.face, 0.06); ctx.beginPath(); ctx.arc(cx, cy, R - 1, 0, 6.2832); ctx.fill();
    ctx.fillStyle = U.shade(r.face, -0.12); ctx.beginPath(); ctx.arc(cx, cy, R - 3.4, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = r.sheen; ctx.lineWidth = 1.4;                   // warm key on the NW arc of the plate
    ctx.beginPath(); ctx.arc(cx, cy, R - 0.4, Math.PI * 1.04, Math.PI * 1.60); ctx.stroke();
    ctx.globalAlpha = 0.32; ctx.strokeStyle = SKY;                    // cool sky bounce on the SE arc
    ctx.beginPath(); ctx.arc(cx, cy, R - 0.4, Math.PI * 0.06, Math.PI * 0.54); ctx.stroke();
    ctx.globalAlpha = 1;
    for (let i = 0; i < 8; i++) {                                     // eight locking bolts driving into the frame
      const a = i * 0.7854 + 0.39, rad = 5.4 + 1.9 * lockT;
      const bx = Math.round(cx + Math.cos(a) * rad), by = Math.round(cy + Math.sin(a) * rad);
      px(bx, by, 1, 1, lockT > 0.6 ? U.shade(ACC.work, -0.05) : U.shade(r.face, 0.22));
    }
    ctx.strokeStyle = r.lit; ctx.lineWidth = 1;                       // three spokes turning on the plate
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI / 3 + now / 5200;
      ctx.moveTo(cx + 0.5 - Math.cos(a) * (R - 2), cy + 0.5 - Math.sin(a) * (R - 2));
      ctx.lineTo(cx + 0.5 + Math.cos(a) * (R - 2), cy + 0.5 + Math.sin(a) * (R - 2));
    }
    ctx.stroke();
    px(cx - 1, cy - 1, 2, 2, U.shade(ACC.work, 0.12));                // lit hub
    bloom(cx - 1, cy - 1, 2, 2, ACC.work, 0.20 + 0.09 * Math.sin(now / 600));
    px(cx - 8, cy - 1, 2, 4, LINE); px(cx - 8, cy - 1, 2, 1, r.lit); px(cx - 7, cy, 1, 3, r.dk); // throw lever
    // ---- control column east of the door: keypad, status stack, seal lamp
    const px0 = x + w - 10;
    inset(px0, y + 7, 8, 10, '#141b18');
    px(px0 + 1, y + 7, 6, 1, U.shade(r.face, 0.14)); keyEdge(px0 + 1, y + 7, 4, 1, 0.16);
    for (let i = 0; i < 4; i++)
      px(px0 + 1 + (i % 2) * 3, y + 9 + (i >> 1) * 2, 2, 1, blink(520, i * 1.1) ? U.shade(ACC.work, -0.15) : '#1b2a24');
    for (let i = 0; i < 3; i++)
      px(px0 + 6, y + 9 + i * 2, 1, 1, blink(800 + i * 260, i) ? (i === 2 ? ACC.flow : ACC.work) : '#16241c');
    seal(px0 + 2, y + 14, blink(1000));
    if (on) { bloom(cx - 3, cy - 3, 6, 6, ACC.work, 0.14); spill(x + 3, y + h - 4, w - 6, ACC.work, 0.12, 3); }
  };

  F.ticker = (x, y, w, h, f) => {
    // TICKER (4x1) — v4. Differentiated by PROPORTION and by lit-area TEXTURE: a long letterbox marquee
    // (48x9 of glass) on two raked struts, and the crawl is drawn as a real LED DOT MATRIX rather than
    // canvas text — dots survive the 3x zoom that 7px type does not, and they read as a ticker instantly.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bt = y - 7, bh = 11;                                      // marquee rides y-7..y+3
    shadow2(x + 4, y + h - 1, w - 8);
    // two RAKED struts + splayed pads: the family's other floor props stand plumb, this one leans
    for (const s of [-1, 1]) {
      const bx = x + (w >> 1) + s * 13;
      for (let j = 0; j < 8; j++) px(bx + s * Math.floor(j / 2), y + 3 + j, 3, 1, LINE);
      for (let j = 0; j < 8; j++) {
        px(bx + s * Math.floor(j / 2), y + 3 + j, 1, 1, s < 0 ? r.lit : U.shade(r.face, 0.06));
        px(bx + s * Math.floor(j / 2) + 1, y + 3 + j, 1, 1, r.dk);
      }
      chamf(bx + s * 4 - 3, y + h - 2, 9, 2, LINE, 1);
      px(bx + s * 4 - 2, y + h - 2, 7, 1, r.face); px(bx + s * 4 - 2, y + h - 1, 7, 1, r.ao);
      ctx.globalAlpha = 0.28; px(bx + s * 4 - 3, y + h, 9, 1, '#000'); ctx.globalAlpha = 1;
    }
    cable(x + (w >> 1) + 10, y + 4, x + (w >> 1) + 17, y + h - 2, 2);
    // slim chamfered housing — shallow enough that the lit band IS the silhouette
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 12, 1, 0.28);
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);
    px(x + 2, bt + bh - 1, w - 4, 1, r.ao);
    for (const sxx of [x + 2, x + w - 3]) px(sxx, bt + 1, 1, 1, U.shade(r.top, 0.28));
    const gx = x + 2, gy = bt + 2, gw = w - 4, gh = 7;
    px(gx - 1, gy - 1, gw + 2, gh + 2, '#04100a');
    px(gx, gy, gw, gh, on ? '#08190e' : '#06120a');                 // never a black hole when idle
    // MATRIX CRAWL — 4-column cells (3 lit columns + 1 gap) scrolling west, with a dim phosphor trail
    // one pixel behind. Colour groups alternate so the stream reads as separate quotes, not one smear.
    const off = Math.floor(now / 90 + ph * 7);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < gw; i++) {
        const col = i + off + pass;
        if (col % 4 === 3) continue;                                // inter-glyph gap
        const cell = Math.floor(col / 4);
        if (cell % 11 > 8) continue;                                // word breaks
        const grp = Math.floor(cell / 11) % 3;
        const bits = U.hash('tkm' + cell + (col % 4)) & 31;
        const base = grp === 1 ? ACC.flow : '#9bff4a';
        const c = pass ? U.shade(base, -0.62) : U.shade(base, on ? 0 : -0.42);
        for (let j = 0; j < 5; j++) if (bits & (1 << j)) px(gx + i, gy + j, 1, 1, c);
      }
    }
    px(gx, gy + 5, gw, 1, '#0d1f10');                               // lane divider
    for (let i = 0; i < gw - 1; i += 3) {                           // lower lane: up/down move ticks
      const k = (U.hash('tkv' + i + Math.floor(now / 1400)) % 3);
      px(gx + i, gy + 6, 2, 1, k === 0 ? U.shade(ACC.work, on ? 0 : -0.4)
        : k === 1 ? U.shade(ACC.flow, on ? -0.1 : -0.5) : '#1c3a22');
    }
    scanl(gx, gy, gw, gh, on ? 0.14 : 0.22);
    bloom(gx, gy, gw, 5, '#9bff4a', (0.13 + 0.03 * Math.sin(now / 700 + ph)) * (on ? 1 : 0.6));
    spill(x + 2, bt + bh, w - 4, '#9bff4a', on ? 0.17 : 0.10, 5);   // the crawl lights the deck below it
    px(x + 2, bt + bh - 3, 1, 1, blink(700, ph) ? '#9bff4a' : '#1c2a1a');   // power LED (kept)
    for (let i = 0; i < 6; i++) px(x + w - 22 + i * 3, bt + bh - 3, 2, 1, '#0c1410');  // vent slits, east end
  };

  F.safe = (x, y, w, h, f) => {   // v4 armoured safe (1x2) — same family, but ONE thick door under a spoked wheel
    const r = RAMP.steel, on = !!(f && f.work);
    const seal = (lx, ly, lit) => {
      px(lx, ly, 2, 2, lit ? '#c7ffe0' : U.shade(ACC.work, -0.62));
      if (lit) bloom(lx, ly, 2, 2, ACC.work, 0.32);
    };
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 5, w + 2, 5);
    deckSocket(x + w + 1, y + h - 3, on);
    // TALL armoured body — HEAVIER than the intel cab, and hinge knuckles break the west outline so the two
    // 1x2 stores never read as the same box at 3x zoom.
    chamf(x - 1, y - 3, w + 2, h + 2, LINE, 2);
    chamf(x, y - 2, w, h, r.face, 2);
    px(x, y, 1, h - 5, U.shade(r.face, 0.12)); px(x + w - 1, y, 1, h - 5, r.dk);
    rimEdge(x + w - 1, y + 1, 1, h - 7, 0.22);
    chamf(x - 1, y - 7, w + 2, 5, LINE, 1);                           // a thicker cap than the cabinet carries
    px(x, y - 6, w, 3, r.top); px(x, y - 6, w, 1, r.sheen);
    keyEdge(x, y - 6, 5, 1, 0.30);
    px(x + 1, y - 5, 4, 1, U.shade(r.sheen, 0.14));
    px(x, y - 3, w, 1, U.shade(r.top, -0.24));
    for (const hy of [y + 2, y + 9, y + h - 8]) {                     // hinge knuckles, proud of the west face
      px(x - 2, hy, 3, 3, LINE); px(x - 1, hy, 2, 3, r.face);
      px(x - 1, hy, 2, 1, r.lit); px(x - 1, hy + 2, 2, 1, r.ao);
    }
    // the door: a stepped frame, so the plate reads THICK instead of printed on
    const dX = x + 2, dY = y + 1, dW = w - 4, dH = h - 6;
    px(dX - 1, dY - 1, dW + 2, dH + 2, U.shade(r.face, -0.42));
    chamf(dX, dY, dW, dH, U.shade(r.face, 0.06), 1);
    px(dX + 1, dY, dW - 2, 1, r.lit); keyEdge(dX + 1, dY, dW - 3, 1, 0.18);
    px(dX + dW - 1, dY + 1, 1, dH - 2, r.dk); rimEdge(dX + dW - 1, dY + 1, 1, dH - 2, 0.18);
    px(dX + 1, dY + dH - 1, dW - 2, 1, r.ao);
    rivets(dX + 1, dY + 1, dW - 2, dH - 2, r.sheen, r.ao);
    // keypad plate high on the door (cycling digits + a seal lamp)
    inset(dX + 1, dY + 1, dW - 2, 4, '#141b18');
    for (let i = 0; i < 3; i++)
      px(dX + 2 + i * 2, dY + 2, 1, 1, blink(520, i * 1.3) ? U.shade(ACC.work, -0.1) : '#1b2a24');
    seal(dX + dW - 4, dY + 3, blink(900));
    // SPOKED WHEEL handle — the hero shape. A turning wheel, not a flat dial disc.
    const cx = x + Math.round(w / 2), cy = y + Math.round(h / 2) + 1, R = 4.6;
    const ang = now / 4200;
    ctx.fillStyle = LINE; ctx.beginPath(); ctx.arc(cx, cy, R + 1.2, 0, 6.2832); ctx.fill();
    ctx.fillStyle = U.shade(r.face, -0.18); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#0f1512'; ctx.beginPath(); ctx.arc(cx, cy, R - 1.7, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = r.sheen; ctx.lineWidth = 1;                     // warm key catch on the NW arc
    ctx.beginPath(); ctx.arc(cx, cy, R - 0.5, Math.PI * 1.05, Math.PI * 1.62); ctx.stroke();
    ctx.globalAlpha = 0.34; ctx.strokeStyle = SKY;                    // cool sky bounce on the SE arc
    ctx.beginPath(); ctx.arc(cx, cy, R - 0.5, Math.PI * 0.08, Math.PI * 0.55); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = r.lit; ctx.lineWidth = 1;                       // two crossed spokes, slowly turning
    ctx.beginPath();
    for (let k = 0; k < 2; k++) {
      const a = k * Math.PI / 2 + ang;
      ctx.moveTo(cx + 0.5 - Math.cos(a) * R, cy + 0.5 - Math.sin(a) * R);
      ctx.lineTo(cx + 0.5 + Math.cos(a) * R, cy + 0.5 + Math.sin(a) * R);
    }
    ctx.stroke();
    px(cx - 1, cy - 1, 2, 2, U.shade(ACC.work, 0.12));                // lit hub
    bloom(cx - 1, cy - 1, 2, 2, ACC.work, 0.18 + 0.08 * Math.sin(now / 600));
    // heavy lever east of the wheel, louvres, and the base seal lamp
    px(cx + 5, cy - 2, 2, 5, LINE); px(cx + 5, cy - 2, 1, 5, r.lit); px(cx + 6, cy - 1, 1, 4, r.dk);
    for (let i = 0; i < 3; i++) px(dX + 2, dY + dH - 5 + i, dW - 4, 1, i % 2 ? U.shade(r.face, 0.08) : r.ao);
    seal(dX + 1, dY + dH - 3, blink(1000));
    if (on) spill(x + 1, y + h - 4, w - 2, ACC.work, 0.12, 3);        // an open store leaks a little light
    px(x + 1, y + h - 3, w - 2, 1, r.ao);
  };

  F.goldcrate = (x, y, w, h) => {
    // GOLD CRATE (2x1) — deliberately CRATE's twin (same steel shell, same castings, same skids) so the
    // storage family reads as one set; what makes it treasury is the hardware bolted ON: gold banding
    // straps, a bullion stencil and a real padlock hasp. Value lives in the accents and the emissive,
    // never in the casing (the colour law) — this is a locked steel box that happens to be worth robbing.
    const r = RAMP.steel, cw = w, gold = ACC.flow;
    shadow2(x + 1, y + h - 1, cw - 2);
    // short ribbed front face
    rr(x, y + 4, cw, h - 5, LINE);
    px(x + 1, y + 5, cw - 2, h - 7, r.face);
    px(x + 1, y + 5, cw - 2, 1, r.lit); keyEdge(x + 2, y + 5, cw - 5, 1, 0.14);
    for (let i = 1; i < (cw - 2) / 6; i++) {
      px(x + 1 + i * 6, y + 5, 1, h - 7, r.ao);
      px(x + 2 + i * 6, y + 5, 1, h - 7, U.shade(r.face, 0.16));
    }
    px(x + cw - 2, y + 5, 1, h - 7, r.dk); rimEdge(x + cw - 2, y + 5, 1, h - 7, 0.20);
    px(x + 1, y + 5, 2, 2, r.sheen); px(x + cw - 3, y + 5, 2, 2, U.shade(r.sheen, -0.25));   // corner castings
    px(x + 1, y + h - 4, 2, 2, r.dk); px(x + cw - 3, y + h - 4, 2, 2, r.dk);
    // gold banding straps across the face — brushed, so they catch rather than flare
    for (const bx of [x + 4, x + cw - 6]) {
      px(bx, y + 5, 1, h - 7, U.shade(gold, -0.35));
      px(bx + 1, y + 5, 1, h - 7, gold);
      px(bx + 1, y + 5, 1, 1, U.shade(gold, 0.36));                    // strap head catches the ceiling strip
      bloom(bx + 1, y + 6, 1, h - 9, gold, 0.13);
    }
    px(x + 1, y + h - 3, cw - 2, 1, r.ao);
    // the chamfered lid dominates, stencilled with the bullion mark
    chamf(x - 1, y - 4, cw + 2, 10, LINE, 2);
    chamf(x, y - 3, cw, 8, r.top, 2);
    px(x + 2, y - 3, cw - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 8, 1, 0.28);
    px(x, y - 1, 1, 5, r.lit); px(x + cw - 1, y - 1, 1, 5, r.dk);
    rimEdge(x + cw - 1, y - 1, 1, 5, 0.20);
    px(x + (cw >> 1), y - 2, 1, 6, U.shade(r.top, -0.22));             // lid seam
    px(x + 4, y - 1, 5, 2, U.shade(gold, -0.28)); px(x + 5, y - 1, 3, 1, gold);   // bullion stencil
    bloom(x + 4, y - 1, 5, 2, gold, 0.12 + 0.05 * Math.sin(now / 900));
    if (blink(1300, x)) px(x + 5 + (U.hash('gc' + x) % 3), y - 1, 1, 1, U.shade(gold, 0.44));  // slow sparkle
    px(x + 2, y - 2, 1, 1, U.shade(r.sheen, 0.34));                    // rivet glint
    px(x + 2, y + 4, cw - 4, 1, U.shade(r.top, -0.16));                // lid front edge
    wear(x + 2, y - 2, cw - 4, 6, 3, U.shade(r.top, -0.12));
    // heavy padlock hasp centred on the lid front, with its secured LED
    const lx = x + (cw >> 1) - 2;
    px(lx - 1, y + 3, 6, 5, LINE);
    px(lx, y + 4, 4, 3, '#232d33'); px(lx, y + 4, 4, 1, '#4a565e'); keyEdge(lx, y + 4, 3, 1, 0.22);
    px(lx + 1, y + 3, 2, 1, U.shade(gold, -0.30));                     // shackle
    px(lx + 1, y + 5, 1, 1, blink(1100) ? '#9bff4a' : '#1c3a14');      // secured LED
    if (blink(1100)) bloom(lx + 1, y + 5, 1, 1, '#9bff4a', 0.24);
    px(x + 2, y + h - 2, 4, 1, r.dk); px(x + cw - 6, y + h - 2, 4, 1, r.dk);      // skid rails
    px(x + 2, y + h - 1, 4, 1, U.shade(r.ao, 0.20)); px(x + cw - 6, y + h - 1, 4, 1, U.shade(r.ao, 0.20));
  };

  F.chartwall = (x, y, w, h, f) => {
    // CHART WALL (3x1) — v4. The old version was three identical line panels on rolling posts. Now it is
    // a signage TOTEM on one cast column (a fourth distinct mount for this family) and the three panels
    // carry three DIFFERENT chart types — trace / histogram / stacked area — so the bank reads as a
    // dashboard at a glance instead of as three copies of the same squiggle.
    // ANCHOR: the bank rides low enough that its bottom third lands in the PLACED tile, and it stands on a
    // STOUT cast neck + splayed foot that live wholly inside the footprint — the sweep had a 6px stick
    // holding a 36x17 head entirely north of the tile the player clicked.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bt = y - 9, bh = 15;                                      // head rides y-9..y+5
    const g0 = on ? 1 : 0.62;
    shadow2(x + 5, y + h - 1, w - 10);
    // splayed cast base + a STOUT tapered neck — the whole mount sits in the footprint
    chamf(x + 6, y + h - 4, w - 12, 4, LINE, 2);
    px(x + 7, y + h - 3, w - 14, 2, r.face);
    px(x + 7, y + h - 3, w - 14, 1, r.lit); keyEdge(x + 8, y + h - 3, 8, 1, 0.16);
    px(x + 7, y + h - 1, w - 14, 1, r.ao);
    for (let j = 0; j < 5; j++) {                                   // neck widens toward the foot
      const cw = 12 + (j > 1 ? 2 : 0) + (j > 3 ? 2 : 0), cx0 = x + (w >> 1) - (cw >> 1);
      px(cx0 - 1, y + 5 + j, cw + 2, 1, LINE);
      px(cx0, y + 5 + j, 1, 1, r.lit); px(cx0 + 1, y + 5 + j, cw - 2, 1, r.face); px(cx0 + cw - 1, y + 5 + j, 1, 1, r.dk);
    }
    px(x + (w >> 1) - 5, y + 8, 10, 1, U.shade(r.face, -0.30));     // cast seam across the neck
    rimEdge(x + (w >> 1) + 5, y + 6, 1, 4, 0.18);
    cable(x + (w >> 1) + 7, y + 7, x + (w >> 1) + 11, y + h - 2, 1.6);
    // chamfered head housing
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 11, 1, 0.28);
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);
    px(x + 2, bt + bh - 1, w - 4, 1, r.ao);
    for (const sxx of [x + 2, x + w - 3]) { px(sxx, bt + 1, 1, 1, U.shade(r.top, 0.28)); px(sxx, bt + bh - 2, 1, 1, r.ao); }
    wear(x + 1, bt + 1, w - 2, bh - 2, 3, U.shade(r.face, -0.10));
    // THREE PANELS, THREE CHART TYPES
    const ACCS = [ACC.data, ACC.flow, ACC.mem], pw = 10, pyy = bt + 2, phh = 10;
    for (let i = 0; i < 3; i++) {
      const p0 = x + 2 + i * 11, acc = ACCS[i], lit = U.shade(acc, on ? 0 : -0.45);
      inset(p0, pyy, pw, phh, '#0c1218');
      px(p0 + 1, pyy + 1, pw - 2, phh - 2, on ? '#0b1620' : '#091119');   // panel ground keeps phosphor
      px(p0 + 1, pyy + 1, 4, 1, lit);                               // colour tab naming the panel (kept)
      px(p0 + 1, pyy + 2, pw - 2, 1, '#141c26');                    // header rule
      for (let gxx = 1; gxx < pw - 1; gxx += 3) px(p0 + gxx, pyy + 3, 1, phh - 4, '#131b24');  // graticule
      px(p0 + 1, pyy + 6, pw - 2, 1, '#182029');                    // mid gridline
      const bx0 = p0 + 1, bw0 = pw - 2, by0 = pyy + 3, bh0 = 6;
      if (i === 0) {                                                // TRACE — dim echo behind the live line
        ctx.save(); ctx.lineWidth = 1;
        ctx.strokeStyle = U.shade(acc, -0.72); ctx.beginPath();
        for (let j = 0; j < bw0; j++) {
          const yy = by0 + bh0 - 1 - (U.hash('ch0' + ((j + 3) >> 1)) % 5);
          j ? ctx.lineTo(bx0 + j, yy) : ctx.moveTo(bx0 + j, yy);
        }
        ctx.stroke();
        ctx.strokeStyle = lit; ctx.beginPath();
        for (let j = 0; j < bw0; j++) {
          const yy = by0 + bh0 - 1 - (U.hash('ch0' + (j >> 1)) % 5);
          j ? ctx.lineTo(bx0 + j, yy) : ctx.moveTo(bx0 + j, yy);
        }
        ctx.stroke(); ctx.restore();
      } else if (i === 1) {                                         // HISTOGRAM — solid bars off a baseline
        for (let j = 0; j < bw0; j += 2) {
          const v = 1 + Math.floor((1 + Math.sin(now / 340 + j * 0.9 + ph)) * (on ? 1.8 : 0.8));
          px(bx0 + j, by0 + bh0 - v, 1, v, lit);
          px(bx0 + j, by0 + bh0 - v, 1, 1, on ? U.shade(acc, 0.35) : U.shade(acc, -0.3));   // bar cap
        }
        px(bx0, by0 + bh0, bw0, 1, U.shade(acc, -0.55));            // baseline
      } else {                                                      // STACKED AREA — filled, not a line
        for (let j = 0; j < bw0; j++) {
          const v = 2 + (U.hash('ch2' + (j >> 1)) % 4);
          px(bx0 + j, by0 + bh0 - v, 1, v, U.shade(acc, on ? -0.42 : -0.68));
          px(bx0 + j, by0 + bh0 - v, 1, 1, lit);                    // the surface of the area
          px(bx0 + j, by0 + bh0 - 1, 1, 1, U.shade(acc, -0.6));     // darker lower band
        }
      }
      px(bx0 + bw0 - 1, by0 + (Math.floor(now / 400 + i + ph) % 4), 1, 1, on ? '#e8f4ff' : lit);  // live tick (kept)
      scanl(p0 + 1, pyy + 1, pw - 2, phh - 2, on ? 0.14 : 0.22);
      bloom(p0 + 1, pyy + 1, pw - 2, phh - 2, acc, 0.11 * g0);
      if (i < 2) px(p0 + pw, pyy + 3, 1, 5, '#121820');             // inter-panel conduit (kept)
    }
    spill(x + 3, bt + bh, w - 6, ACC.data, 0.14 * g0, 4);           // the bank lights its own column
    for (let i = 0; i < 3; i++)                                     // feed lamps on the bottom rail
      px(x + 4 + i * 11, bt + bh - 3, 2, 1, blink(850, i + ph) ? U.shade(ACCS[i], on ? 0 : -0.45) : '#1c2630');
  };

  F.wartable = (x, y, w, h, f) => {   // v4 WAR TABLE (5x2) — the room's centrepiece: a lit map you look DOWN on
    // The family's failure mode is seven glowing rectangles, so this one is deliberately NOT a screen: it is a
    // 60x24 horizontal SLAB whose whole top face is the emitter. Read is (1) a huge oval-cornered map well
    // sunk into a heavy chamfered top, (2) a raised rail with grab-handles running the long edges — the thing
    // officers lean on — and (3) light SPILLING off the table's front lip onto the deck, which is what sells a
    // downward-facing emitter. Alert rose is the map's contact colour (it plots threats); ACC.flow amber is the
    // reticle. f.work = a run is live -> more contacts resolve, sweep speeds up, spill doubles.
    const r = RAMP.gun, ph = (f && f.x) || 0, on = !!(f && f.work);
    const ROSE = '#ff5c7a', ROSEH = '#ffb0c0';
    const topT = y + 1, topH = h - 12;                              // top face rows; south face + legs below
    shadow2(x + 2, y + h - 1, w - 4);
    deckPlate(x + 2, y + h - 5, w - 4, 5);                          // the table is bolted, not wheeled
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 6, y + h - 8, x + w + 2, y + h - 3, 2.4);
    // FOUR chunky legs — a 60px slab on two legs reads as a shelf; four says table
    for (const lx of [x + 3, x + 17, x + w - 20, x + w - 6]) {
      px(lx, y + h - 7, 3, 6, LINE);
      px(lx, y + h - 7, 1, 6, r.lit); px(lx + 1, y + h - 7, 1, 6, r.dk);
      rimEdge(lx + 2, y + h - 6, 1, 4, 0.16);
      ctx.globalAlpha = 0.30; px(lx - 1, y + h - 1, 5, 1, '#000'); ctx.globalAlpha = 1;
    }
    underAO(x + 6, y + h - 7, w - 12, 3);
    // SOUTH FACE — short, with a recessed edge-control channel; the map light pools down it
    chamf(x - 1, y + h - 13, w + 2, 8, LINE, 2);
    px(x, y + h - 12, w, 6, r.face);
    px(x, y + h - 12, w, 1, r.lit); keyEdge(x + 2, y + h - 12, 14, 1, 0.16);   // catch under the top's overhang
    px(x, y + h - 11, 1, 5, U.shade(r.face, 0.08)); px(x + w - 1, y + h - 11, 1, 5, r.dk);
    rimEdge(x + w - 1, y + h - 11, 1, 5, 0.20);
    px(x, y + h - 7, w, 1, r.ao);
    // two operator stations on the face: a rose contact bank west, an amber tasking bank east (kept blinks)
    inset(x + 7, y + h - 11, 8, 3, '#241218');
    for (let i = 0; i < 3; i++) px(x + 8 + i * 2, y + h - 10, 1, 1, blink(500, i + ph) ? ROSE : '#3a2030');
    inset(x + w - 15, y + h - 11, 8, 3, '#241218');
    for (let i = 0; i < 3; i++) px(x + w - 14 + i * 2, y + h - 10, 1, 1, blink(700, i + 4 + ph) ? ACC.flow : '#3a3020');
    knurl(x + 20, y + h - 9, 18, 1, r.face);                        // machined lean-rail grip across the middle
    // THE TOP — heavy chamfer so the 60px slab has real corners, warm crown key on the back edge
    chamf(x - 1, y - 1, w + 2, topH + 3, LINE, 3);
    chamf(x, y, w, topH + 1, r.top, 3);
    px(x + 3, y, w - 6, 1, r.sheen); keyEdge(x + 3, y, 16, 1, 0.28);
    px(x, y + 2, 1, topH - 3, r.lit); px(x + w - 1, y + 2, 1, topH - 3, r.dk);
    rimEdge(x + w - 1, y + 2, 1, topH - 3, 0.20);
    px(x + 3, y + topH, w - 6, 1, U.shade(r.top, -0.20));           // front lip of the top
    wear(x + 2, y + 1, w - 4, topH - 2, 5, U.shade(r.top, -0.09));
    // RAISED EDGE RAIL along the long sides + corner grab-handles: the officers-lean-here detail
    px(x + 4, y + 1, w - 8, 1, U.shade(r.top, 0.16));
    for (const gx of [x + 5, x + w - 12]) {
      px(gx, y + 1, 7, 2, U.shade(r.top, 0.10)); px(gx, y + 1, 7, 1, r.sheen);
      px(gx + 1, y + 2, 5, 1, U.shade(r.top, -0.30));              // the finger gap under the handle
    }
    // MAP WELL — one big oval-cornered recess, the prop's single dominant lit shape
    const wx = x + 5, wy = topT + 2, ww = w - 10, wh = topH - 5;
    chamf(wx - 2, wy - 2, ww + 4, wh + 4, '#080407', 2);            // well surround, deeper than inset()
    chamf(wx - 1, wy - 1, ww + 2, wh + 2, U.shade(r.top, -0.62), 2);
    px(wx - 1, wy - 1, ww + 2, 1, U.shade(r.top, -0.78));           // shadow cast by the north lip INTO the well
    chamf(wx, wy, ww, wh, on ? '#1c0d14' : '#150a10', 1);           // idle map keeps chart-glass, never dead black
    // chart substrate: a sector grid + a coastline-ish landmass, so it reads as a MAP not as noise
    for (let gx = 6; gx < ww - 2; gx += 7) px(wx + gx, wy + 1, 1, wh - 2, on ? '#3a1c28' : '#2a141d');
    for (let gy = 2; gy < wh - 1; gy += 3) px(wx + 1, wy + gy, ww - 2, 1, on ? '#331823' : '#26121a');
    for (let i = 0; i < 9; i++) {                                   // one continuous landmass blob, deterministic
      const hx = U.hash('wt' + i), bx = wx + 4 + (hx % (ww - 12));
      px(bx, wy + 2 + ((hx >> 4) % Math.max(1, wh - 5)), 3 + (hx % 4), 1, on ? '#4a2432' : '#301a24');
    }
    // CONTACTS — plotted blips with expanding pulse rings; more of them resolve while a run is live
    const N = on ? 6 : 4;
    const a0 = 0.5 + 0.3 * Math.sin(now / 500);
    for (let i = 0; i < N; i++) {
      const bx = wx + 4 + i * Math.floor((ww - 8) / N), by = wy + 1 + (i % 3) * Math.max(1, Math.floor((wh - 2) / 3));
      ctx.globalAlpha = a0; px(bx, by, 2, 2, ROSE); ctx.globalAlpha = 1;
      px(bx, by, 1, 1, ROSEH);                                      // blip core
      const rad = ((now / 600 + i * 0.4) % 1) * 3;
      ctx.save();
      ctx.strokeStyle = ROSE; ctx.globalAlpha = a0 * (1 - rad / 3);
      ctx.beginPath(); ctx.arc(bx + 1, by + 1, rad + 1, 0, 6.2832); ctx.stroke();
      ctx.restore();
      if (i === 0) bloom(bx, by, 2, 2, ROSE, 0.20);
    }
    // TARGETING RETICLE stepping between contacts — amber corner brackets (kept behaviour)
    const tgt = Math.floor(now / 2400) % N;
    const tx2 = wx + 4 + tgt * Math.floor((ww - 8) / N), ty2 = wy + 1 + (tgt % 3) * Math.max(1, Math.floor((wh - 2) / 3));
    if (blink(300)) {
      px(tx2 - 2, ty2 - 1, 2, 1, ACC.flow); px(tx2 + 2, ty2 - 1, 2, 1, ACC.flow);
      px(tx2 - 2, ty2 + 2, 2, 1, ACC.flow); px(tx2 + 2, ty2 + 2, 2, 1, ACC.flow);
      bloom(tx2 - 2, ty2 - 1, 6, 4, ACC.flow, 0.14);
    }
    // RADAR SWEEP: a real leading bar with a decaying tail, not one flat translucent column
    const swx = Math.floor((now / (on ? 18 : 28)) % (ww - 1));
    for (let t = 0; t < 5; t++) {
      const cxs = swx - t;
      if (cxs >= 0) { ctx.globalAlpha = 0.30 * (1 - t / 5); px(wx + cxs, wy, 1, wh, ROSEH); }
    }
    ctx.globalAlpha = 1;
    scanl(wx, wy, ww, wh, 0.16);
    bloom(wx, wy, ww, wh, ROSE, (on ? 0.13 : 0.07) + 0.02 * Math.sin(now / 800));
    // the table's own light falling OFF the front lip onto the deck — the downward-emitter tell
    spill(x + 3, y + topH + 1, w - 6, ROSE, on ? 0.22 : 0.12, 5);
    glow(x + 4, y + h - 2, w - 8, 2, ROSE, on ? 0.14 : 0.07);
  };

  F.calwall = (x, y, w, h, f) => {   // v4 CAL WALL (6x1) — the family's ONLY backlit paper board, not another glass screen
    // 72px wide is the widest prop in the family, so uniformity is the risk: this one is differentiated by being
    // a SPLIT-FLAP schedule board — a warm amber-backlit paper grid behind a glass strip, hung on two rolling
    // A-posts. The lit shape is 14 small cells, never one rect; the week MARCHES left-to-right and the current
    // day carries a flap that ticks over. Amber (ACC.flow = scheduling) throws warm light DOWN onto the posts,
    // which is what separates it from the cold-cyan/rose screens standing beside it. f.work speeds the march.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bT = y - 7, bH = 14;                                      // board overdraws north of its 1-tile footprint
    shadow2(x + 3, y + h - 1, w - 6);
    // TWO ROLLING A-POSTS — splayed feet + a castor, so it reads as wheeled kit, not bolted machinery
    for (const pxx of [x + 10, x + w - 12]) {
      px(pxx - 1, y + 5, 4, h - 6, LINE);
      px(pxx, y + 6, 1, h - 8, r.lit); px(pxx + 1, y + 6, 1, h - 8, r.dk);
      rimEdge(pxx + 2, y + 6, 1, h - 8, 0.18);
      chamf(pxx - 5, y + h - 4, 12, 3, LINE, 1);                    // wide T-foot
      px(pxx - 4, y + h - 3, 10, 1, r.face); px(pxx - 4, y + h - 3, 10, 1, r.lit);
      px(pxx - 4, y + h - 2, 10, 1, r.ao);
      px(pxx - 3, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 3, y + h - 1, 2, 1, '#1a1e22');   // castors
      ctx.globalAlpha = 0.30; px(pxx - 5, y + h, 12, 1, '#000'); ctx.globalAlpha = 1;
      px(pxx, y + 4, 2, 2, U.shade(r.top, 0.16));                   // collar tying post to board (no floating)
    }
    // CARCASS — chamfered frame with a warm crown key and a cool east rim
    chamf(x - 1, bT - 1, w + 2, bH + 2, LINE, 2);
    chamf(x, bT, w, bH, r.face, 2);
    px(x + 2, bT, w - 4, 1, r.top); keyEdge(x + 2, bT, 14, 1, 0.26);
    px(x, bT + 2, 1, bH - 4, r.lit); px(x + w - 1, bT + 2, 1, bH - 4, r.dk);
    rimEdge(x + w - 1, bT + 2, 1, bH - 4, 0.22);
    px(x + 2, bT + bH - 1, w - 4, 1, r.ao);
    rivets(x + 1, bT + 1, w - 2, bH - 2, r.sheen, r.ao);
    // HEADER RAIL above the grid: a title bar of ticks, then the amber backlight bleeding out from behind
    inset(x + 2, bT + 1, w - 4, 2, '#1a150c');
    for (let i = 0; i < 8; i++) px(x + 4 + i * 3, bT + 2, 2, 1, U.shade(ACC.flow, on ? -0.15 : -0.45));
    bloom(x + 3, bT + 2, w - 6, 1, ACC.flow, on ? 0.14 : 0.08);
    // THE GRID — 7 columns x 2 rows of split-flap cells behind one recessed glass strip
    const gT = bT + 4, cw2 = Math.floor((w - 6) / 7), gx0 = x + 3 + (((w - 6) - 7 * cw2) >> 1);
    inset(x + 2, gT - 1, w - 4, 10, '#0e0b07');
    const prog = (now / (on ? 900 : 1400)) % 14;
    for (let i = 0; i < 7; i++) for (let j = 0; j < 2; j++) {
      const idx = i + j * 7, lit = idx < prog, wknd = i > 4;        // weekend columns stay cool (kept)
      const cx3 = gx0 + i * cw2, cy3 = gT + j * 5;
      chamf(cx3, cy3, cw2 - 1, 4, lit ? (wknd ? '#3a3446' : '#4a3f2a') : (wknd ? '#1e1e26' : '#201c16'), 1);
      px(cx3, cy3, cw2 - 1, 1, lit ? (wknd ? '#4a4458' : '#63533a') : '#2a2620');   // flap's own top edge
      px(cx3, cy3 + 2, cw2 - 1, 1, '#0d0b08');                      // the SPLIT — the hinge line across the flap
      if (lit) {
        px(cx3 + 1, cy3 + 1, Math.max(2, cw2 - 5), 1, '#ffe066');   // the booked entry
        px(cx3 + 1, cy3 + 1, 2, 1, '#fff4c0');
        px(cx3 + cw2 - 4, cy3 + 3, 2, 1, ACC.work);                 // done check, green
      } else {
        px(cx3 + 1, cy3 + 1, 2, 1, '#33301f');                      // unbooked cells keep faint print, not a hole
      }
      px(cx3 + cw2 - 4, cy3 + 1, 2, 1, '#3a352a');                  // date notch
      if (Math.floor(prog) === idx) {                               // TODAY: the flap mid-tick, ringed amber
        px(cx3, cy3, cw2 - 1, 1, '#ffe066'); px(cx3, cy3 + 3, cw2 - 1, 1, '#8a7a34');
        if (blink(400, ph)) px(cx3 + 1, cy3 + 2, Math.max(2, cw2 - 4), 1, '#fff4c0');   // the flap falling
        bloom(cx3, cy3, cw2 - 1, 4, ACC.flow, 0.22 + 0.06 * Math.sin(now / 300));
      }
    }
    scanl(x + 3, gT - 1, w - 6, 10, 0.12);                          // the glass over the paper
    px(x + 3, gT - 1, 6, 1, U.shade(r.face, 0.30));                 // one corner reflection on that glass
    // warm schedule light falling off the board's bottom edge onto the posts below it
    spill(x + 4, bT + bH, w - 8, ACC.flow, on ? 0.20 : 0.13, 5);
  };

  F.tube = (x, y, w, h, f) => { // v4 pneumatic tube (2x1) — glass barrel on saddles; warm crown vs cool belly
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);
    for (const sx2 of [x + 3, x + w - 7]) {                     // cradle stands with a saddle the glass sits in
      chamf(sx2 - 1, y + 4, 6, h - 5, LINE, 1);
      px(sx2, y + 5, 4, h - 7, r.face);
      px(sx2, y + 5, 1, h - 7, r.lit); keyEdge(sx2, y + 5, 1, 3, 0.18);
      px(sx2 + 3, y + 5, 1, h - 7, r.dk); rimEdge(sx2 + 3, y + 5, 1, 4, 0.20);
      px(sx2, y + 4, 4, 1, U.shade(r.top, 0.10));               // saddle lip
      px(sx2 - 1, y + h - 2, 6, 1, r.ao);
    }
    const per = on ? 520 : 800;                                 // end lights run hot while the line is live
    px(x + 4, y + 6, 2, 2, blink(per, ph) ? ACC.flow : '#2e3840');
    px(x + w - 6, y + 6, 2, 2, blink(per, 1 + ph) ? ACC.flow : '#2e3840');
    if (blink(per, ph)) bloom(x + 4, y + 6, 2, 2, ACC.flow, 0.20);
    px(x + (w >> 1) - 3, y + 5, 6, 4, LINE);                    // pressure gauge (kept wobble)
    px(x + (w >> 1) - 2, y + 6, 4, 2, '#1b2226'); px(x + (w >> 1) - 2, y + 6, 4, 1, U.shade(r.face, 0.14));
    px(x + (w >> 1) - 1 + Math.round(Math.sin(now / 400 + ph)), y + 7, 1, 1, ACC.flow);
    // the GLASS BARREL: dark core, a warm specular line along the crown, cool floor bounce along the belly
    chamf(x - 1, y - 4, w + 2, 10, LINE, 2);
    chamf(x, y - 3, w, 8, '#18202a', 2);
    px(x + 3, y - 3, w - 6, 1, '#33434f');
    px(x + 3, y - 2, w - 6, 1, '#5a7484'); keyEdge(x + 4, y - 2, 8, 1, 0.26);
    px(x + 2, y + 3, w - 4, 1, '#0d151b');                      // belly shadow
    rimEdge(x + 3, y + 2, w - 6, 1, 0.16);
    glow(x + 4, y - 2, 3, 4, '#dfe9f0', 0.10);                  // glass highlight (kept)
    const cyc = (now / 900 + ph * 0.13) % 1;                    // capsule whoosh (kept)
    if (cyc < 0.4) {
      const capx = x + 4 + Math.floor(cyc / 0.4 * (w - 11));
      px(capx, y - 1, 3, 2, ACC.flow); px(capx, y - 1, 3, 1, '#fff4c0');
      px(capx - 1, y - 1, 1, 2, U.shade(ACC.flow, -0.45)); px(capx - 2, y, 1, 1, U.shade(ACC.flow, -0.62)); // speed lines
      bloom(capx, y - 1, 3, 2, ACC.flow, 0.30);
      spill(capx - 2, y + 4, 7, ACC.flow, 0.16, 3);             // the capsule lights the cradle as it passes
    } else if (cyc < 0.45 && blink(80, ph)) {
      px(x + w - 8, y - 1, 2, 2, '#fff4c0'); bloom(x + w - 8, y - 1, 2, 2, ACC.flow, 0.34);   // arrival flash (kept)
    } else {
      px(x + 5, y, 2, 1, '#20303c');                            // a resting slug, so the glass is never empty
    }
    for (const end of [[x, 1], [x + w - 3, 0]]) {               // brass end fittings, lit west / shaded east
      px(end[0], y - 3, 3, 8, '#4e5a64'); px(end[0], y - 3, 3, 1, '#6e7c86'); px(end[0], y + 4, 3, 1, '#2a343c');
      if (end[1]) { px(end[0], y - 3, 1, 8, '#68757f'); keyEdge(end[0], y - 2, 1, 4, 0.20); }
      else { px(end[0] + 2, y - 3, 1, 8, '#333d45'); rimEdge(end[0] + 2, y - 2, 1, 4, 0.20); }
    }
    px(x + (w >> 1) - 1, y - 4, 2, 10, LINE);                   // centre clamp ring (kept)
    px(x + (w >> 1) - 1, y - 3, 2, 8, '#46525c'); px(x + (w >> 1) - 1, y - 3, 2, 1, '#5f6d78');
    cable(x + 2, y + 4, x + 7, y + 7, 1.6, '#141b20');          // limp feed hose off the west fitting
  };

  F.parcels = (x, y, w, h) => {
    // PARCELS (1x2) — the family's TALL entry: a leaning tower of taped parcels. Same fibreboard material
    // as BOXES (labels, tape, no castings) but stacked, so the silhouette is the point — each tier is
    // offset a bold 2px and the top one juts past the footprint. v4 adds a contact shade under every tier
    // (without it the stack reads as decals on one column) and a warm key on each lid.
    const cw = w, floorY = y + h - 1;
    shadow2(x + 1, floorY, cw - 2);
    const parcel = (bx, fb, bw, fh, ramp, tint) => {
      const ty = fb - fh;
      rr(bx, ty, bw, fh, LINE);
      px(bx + 1, ty + 2, bw - 2, fh - 3, ramp.face);                   // front face
      px(bx + 1, ty + 2, 1, fh - 3, ramp.lit);
      px(bx + bw - 2, ty + 2, 1, fh - 3, ramp.dk);
      rimEdge(bx + bw - 2, ty + 2, 1, fh - 3, 0.18);                   // cool bounce, shade side
      px(bx + 1, fb - 1, bw - 2, 1, ramp.ao);                          // base AO
      px(bx + 1, ty + 1, bw - 2, 2, ramp.top);                         // lid slab (top-bias)
      px(bx + 1, ty + 1, bw - 2, 1, ramp.sheen);
      keyEdge(bx + 1, ty + 1, Math.max(2, bw - 5), 1, 0.28);           // warm ceiling strip on the lid
      px(bx + (bw >> 1) - 1, ty + 2, 2, fh - 3, U.shade(ramp.face, 0.16));   // vertical tape
      px(bx + 1, ty + 4, bw - 2, 1, U.shade(ramp.face, -0.20));        // horizontal tape shade
      px(bx + 2, ty + 3, 3, 1, '#d8e0d6');                             // shipping label
      px(bx + bw - 4, ty + 1, 2, 1, tint);                             // colour tab on the lid
      px(bx + bw - 4, ty + 3, 2, 1, U.shade(tint, -0.2));              // sticker on the face
    };
    parcel(x + 0, floorY, cw + 0, 8, RAMP.steel, ACC.flow);            // base carton, full width
    px(x + 3, floorY - 8, cw - 4, 1, '#0a0e0c');                       // the tier above presses into it
    parcel(x + 2, floorY - 8, cw - 3, 7, RAMP.fabric, ACC.data);       // middle, leaning EAST
    px(x + 1, floorY - 15, cw - 5, 1, '#0a0e0c');
    parcel(x - 1, floorY - 15, cw - 4, 6, RAMP.steel, ACC.alert);      // upper, leaning WEST past the footprint
    // small crowning parcel catching the most light + a hanging manifest tag (breaks the boxy outline)
    const tb = floorY - 21, tx = x + 2;
    px(tx + 1, tb, 5, 1, '#0a0e0c');
    rr(tx, tb - 5, 7, 5, LINE);
    px(tx + 1, tb - 3, 5, 2, RAMP.fabric.face); px(tx + 1, tb - 3, 1, 2, RAMP.fabric.lit);
    rimEdge(tx + 5, tb - 3, 1, 2, 0.18);
    px(tx + 1, tb - 4, 5, 2, RAMP.fabric.top); px(tx + 1, tb - 4, 5, 1, RAMP.fabric.sheen);
    keyEdge(tx + 1, tb - 4, 3, 1, 0.28);
    px(tx + 4, tb - 3, 1, 1, ACC.work);                                // sticker
    cable(tx + 6, tb - 4, tx + 8, tb - 1, 1.2, '#6a6256');             // tag string off the top corner
    px(tx + 8, tb - 1, 2, 3, '#c9c2b0'); px(tx + 8, tb - 1, 2, 1, '#e4dcc8');   // the manifest tag itself
    px(tx + 8, tb + 1, 2, 1, '#8a8474');
    px(x + (cw >> 1), floorY - 11, 1, 1, U.shade('#fff4c8', -0.35));   // strap buckle — a still stack cannot glint
    px(x + (cw >> 1) - 1, floorY, 3, 1, U.shade(RAMP.steel.face, -0.22));                 // base scuff
  };

  F.core = (x, y, w, h, f) => {   // v4 memory core (1x2) — the ACC.mem plasma column kept; its MATERIAL and falloff rebuilt
    // The glowing-column idea was already right, so it is not replaced — only made to behave like light: the plasma
    // now runs a travelling standing wave up the tube and the emissive is banded (dim halo -> body -> white-hot
    // filament) instead of one flat alpha rect, and it SPILLS onto the manifold and deck plate beneath it.
    const r = RAMP.steel, cx = x + Math.round(w / 2), on = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 5, w + 2, 5);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + 1, y + h - 7, x - 2, y + h - 3, 2);                      // coolant runs, both flanks
    cable(x + w - 1, y + h - 7, x + w + 2, y + h - 3, 2);
    // cylindrical housing — barrel with a lit west facet and a cool east rim
    const bx = x + 1, bw = w - 2, colTop = y - 1, colBot = y + h - 7;
    chamf(bx - 1, colTop - 1, bw + 2, colBot - colTop + 2, LINE, 2);
    px(bx, colTop, bw, colBot - colTop, r.face);
    px(bx, colTop, 1, colBot - colTop, r.lit);
    px(bx + 1, colTop, 1, colBot - colTop, U.shade(r.face, 0.06));
    px(bx + bw - 1, colTop, 1, colBot - colTop, r.dk);
    rimEdge(bx + bw - 1, colTop + 1, 1, colBot - colTop - 2, 0.22);
    // heavy finned cap we look down on
    chamf(x - 1, y - 6, w + 2, 5, LINE, 1);
    px(x, y - 5, w, 3, r.top); px(x, y - 5, w, 1, r.sheen);
    keyEdge(x, y - 5, 5, 1, 0.30);
    for (let i = 0; i < 4; i++) { px(x + 1 + i * 3, y - 4, 1, 2, r.ao); px(x + 2 + i * 3, y - 4, 1, 2, U.shade(r.top, 0.10)); }
    px(x, y - 2, w, 1, U.shade(r.top, -0.24));                        // cap lip ties the cap to the barrel
    // coolant manifold at the foot
    px(bx, colBot, bw, 3, U.shade(r.face, -0.26)); px(bx, colBot, bw, 1, U.shade(r.face, -0.06));
    px(bx, colBot + 2, bw, 1, r.ao);
    px(bx + 1, colBot + 1, 2, 1, '#101a22'); px(bx + bw - 3, colBot + 1, 2, 1, '#101a22');   // vents
    // ---- the PLASMA COLUMN: banded emissive with a wave travelling up it
    const gx = x + 3, gw = 6, gTop = colTop + 1, gLen = colBot - colTop - 2;
    const g = 0.55 + 0.35 * Math.sin(now / 350), gain = on ? 1 : 0.78;
    inset(gx, gTop, gw, gLen, '#12081c');                             // recessed glass well
    bloom(gx + 1, gTop, gw - 2, gLen, ACC.mem, (0.14 + 0.12 * g) * gain);   // halo, with real 3-ring falloff
    for (let j = 0; j < gLen; j++) {
      const a = 0.5 + 0.5 * Math.sin(now / 430 - j * 0.55);           // standing wave climbing the tube
      px(gx + 1, gTop + j, gw - 2, 1, U.shade(ACC.mem, -0.34 + 0.30 * a * gain));
      px(gx + 2, gTop + j, 2, 1, U.shade(ACC.mem, 0.02 + 0.26 * a * gain));
      px(cx, gTop + j, 1, 1, a > 0.5 ? '#efe2ff' : U.shade('#efe2ff', -0.28));   // white-hot filament, unbroken
    }
    for (let i = 0; i < 3; i++) {                                     // rising energy motes (kept)
      const mp = (now / ((on ? 560 : 800) + i * 230) + i * 0.5) % 1;
      px(cx - 1 + (i % 2), gTop + Math.floor((1 - mp) * (gLen - 2)), 1, 1, '#f9f2ff');
    }
    // containment hoops sit IN FRONT of the glow without killing it — 1px, with key/rim end catches
    for (let ri = 0; ri < 5; ri++) {
      const ry = gTop + 2 + ri * Math.floor((gLen - 2) / 5);
      px(gx - 1, ry, gw + 2, 1, U.shade(r.face, -0.30));
      px(gx - 1, ry, 1, 1, r.lit); keyEdge(gx - 1, ry, 1, 1, 0.24);
      px(gx + gw, ry, 1, 1, r.dk); rimEdge(gx + gw, ry, 1, 1, 0.24);
    }
    bloom(gx, y - 4, gw, 2, ACC.mem, g * 0.30 * gain);                // heat shimmer venting from the crown
    spill(gx - 1, colBot, gw + 2, ACC.mem, 0.24 * gain, 4);           // the column pools light onto the manifold
    px(bx, colBot + 3, bw, 1, blink(600) ? ACC.mem : U.shade(ACC.mem, -0.55));   // containment LED (kept)
    if (on) spill(x, y + h - 4, w, ACC.mem, 0.13, 3);
  };

  F.shelf = (x, y, w, h, f) => {   // v4 store shelf (4x1) — the family's LONGEST: a run of labelled bins, one pulled out
    const r = RAMP.steel, on = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 4, w + 2, 4);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 3, y + h - 6, x + w + 2, y + h - 3, 2);
    for (const lx of [x + 2, x + Math.floor(w / 2) - 1, x + w - 5]) {  // three legs along the long footprint
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
      rimEdge(lx + 2, y + h - 5, 1, 2, 0.16);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // short front face: a long row of bins. The RHYTHM across 4 tiles is what identifies this one.
    chamf(x - 1, y + 2, w + 2, h - 3, LINE, 2);
    px(x, y + 3, w, h - 5, r.face);
    px(x, y + 3, w, 1, r.lit); keyEdge(x + 1, y + 3, w - 3, 1, 0.15);
    px(x, y + 4, 1, h - 7, U.shade(r.face, 0.10)); px(x + w - 1, y + 4, 1, h - 7, r.dk);
    rimEdge(x + w - 1, y + 4, 1, h - 7, 0.20);
    const nbin = Math.floor((w - 4) / 7), pull = 2;                    // bin #2 is pulled proud (silhouette break)
    for (let i = 0; i < nbin; i++) {
      const bx = x + 2 + i * 7;
      inset(bx, y + 4, 6, h - 8, U.shade(r.face, -0.20));             // bin recess
      px(bx + 1, y + 5, 4, 1, U.shade(r.face, 0.10)); keyEdge(bx + 1, y + 5, 3, 1, 0.13);
      px(bx + 2, y + 6, 2, 1, U.shade(r.face, -0.42));                // recessed pull
      // Label strips, not lamps. These were per-bin blinkers on staggered 700-970ms clocks — a wall of
      // shelving strobing out of sync, asserting per-bin state the shelf has no way to know.
      px(bx + 1, y + h - 4, 3, 1, U.shade(ACC.work, -0.45));
    }
    const bx2 = x + 2 + pull * 7;                                     // the pulled bin: proud lip + files glowing inside
    px(bx2 - 1, y + 3, 8, 1, LINE);
    px(bx2 - 1, y + 4, 8, 2, U.shade(r.face, 0.16)); px(bx2 - 1, y + 4, 8, 1, r.lit);
    keyEdge(bx2, y + 4, 6, 1, 0.20);
    px(bx2, y + 6, 6, 1, ACC.work);                                   // file edges catching the light — steadily
    bloom(bx2, y + 6, 6, 1, ACC.work, 0.20);
    spill(bx2, y + 7, 6, ACC.work, 0.18, 3);
    px(bx2 - 1, y + 7, 8, 1, r.ao);
    px(x, y + h - 3, w, 1, r.ao);                                     // floor-line AO
    // big TOP surface, with a label rail and folders resting on it
    chamf(x - 1, y - 4, w + 2, 7, LINE, 2);
    chamf(x, y - 3, w, 6, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 10, 1, 0.30);
    px(x, y - 1, 1, 3, r.lit); px(x + w - 1, y - 1, 1, 3, r.dk);
    rimEdge(x + w - 1, y - 1, 1, 3, 0.20);
    for (let i = 0; i < 4; i++) px(x + 5 + i * 11, y - 1, 6 - (i % 2), 1, U.shade(r.top, 0.055));  // brushed streaks
    for (const fx of [x + 8, x + Math.floor(w * 0.56)]) {             // green-tabbed folders on the deck
      px(fx - 1, y - 2, 8, 3, U.shade(r.top, -0.30)); px(fx, y - 1, 6, 1, U.shade(r.top, -0.06));
      px(fx + 1, y - 2, 3, 1, ACC.work);
    }
    px(x + 2, y + 2, w - 4, 1, U.shade(r.top, -0.18));                // top front edge
    wear(x + 2, y - 2, w - 4, 4, 5, U.shade(r.top, -0.10));
    if (on) spill(x + 2, y + 3, w - 4, ACC.work, 0.09, 3);
  };

  F.bar = (x, y, w, h, f) => {
    // BAR (4x1) — v6 detail pass. v4 had the right ANATOMY (counter, kick rail, back shelf) and read as
    // a grey service counter anyway, for three reasons, all fixed here:
    //   (1) the top was RAMP.steel, so the widest lounge prop in the game was the same material as the
    //       routers and the vault. It is timber now, with a brass nosing — the only warm big surface in
    //       the room, which is what a bar is for.
    //   (2) the back shelf stood on two 2px stubs 6px clear of the counter and read as FLOATING. It now
    //       lands on two full-height end standards with a mid rail, so it is visibly one piece of joinery.
    //   (3) the bottles were 2px blocks. A bottle is a NECK over a shoulder over a body — three rows,
    //       not one — and that is the whole difference between a bottle rack and a colour bar chart.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const WD = '#5a3f28', WD_LIT = '#7d5a3a', WD_DK = '#33230f';        // counter timber
    // BRASS, DEEP not bright. The first pass used #b8953f/#e0c06a and the nosing and the foot rail came
    // out as two full-width neon-yellow bars running the whole 48px — at that length any saturated tone
    // stops being trim and becomes a light fixture. Trim is a HIGHLIGHT on a dark metal, so the base
    // tone drops to a dim bronze and the bright value survives only in the short west-biased glint.
    const BRS = '#7a6128', BRS_LIT = '#b8953f';                          // brass nosing + fittings
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 5]) {                              // end feet blocks, freestanding
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    px(x + 4, y + 10, w - 8, 1, BRS);                                   // brass foot rail in the kick gap
    px(x + 4, y + 10, 7, 1, BRS_LIT);                                   // rail glint, west-biased
    px(x + 4, y + 11, w - 8, 1, '#2c363c');
    // ---- FRONT FACE: panelled timber. Deliberately plain and OPEN — this is the side agents walk up to.
    chamf(x - 1, y + 4, w + 2, 6, LINE, 2);
    px(x, y + 5, w, 4, WD);
    px(x, y + 5, w, 1, WD_LIT); keyEdge(x + 1, y + 5, w - 3, 1, 0.16);
    for (let i = 0; i < 4; i++) {                                       // four recessed panels
      const pxx = x + 3 + i * 12;
      px(pxx, y + 6, 9, 2, U.shade(WD, -0.24));
      px(pxx, y + 6, 9, 1, U.shade(WD, -0.44)); px(pxx, y + 7, 9, 1, U.shade(WD, 0.10));
    }
    px(x + w - 1, y + 5, 1, 4, WD_DK); rimEdge(x + w - 1, y + 5, 1, 4, 0.20);
    px(x, y + 8, w, 1, U.shade(WD_DK, -0.34));
    bloom(x + 2, y + 8, w - 4, 1, ACC.lounge, on ? 0.28 + 0.10 * Math.sin(now / 700) : 0.15);  // under-counter accent
    // ---- COUNTER TOP: timber slab with a BRASS NOSING along the front lip. The nosing is the single
    // detail that says "bar" fastest, because no other prop in the catalog has a warm metal edge.
    chamf(x - 1, y - 3, w + 2, 9, LINE, 2);
    chamf(x, y - 2, w, 7, WD, 2);
    px(x + 2, y - 2, w - 4, 1, WD_LIT); keyEdge(x + 2, y - 2, 10, 1, 0.28);
    px(x + 2, y - 1, w - 4, 1, U.shade(WD, 0.14));
    for (let i = 0; i < 5; i++) px(x + 4 + i * 10, y, 5, 1, U.shade(WD, 0.08));   // grain along the top
    px(x, y, 1, 4, WD_LIT); px(x + w - 1, y, 1, 4, WD_DK); rimEdge(x + w - 1, y, 1, 4, 0.20);
    px(x + 1, y + 3, w - 2, 1, BRS); px(x + 1, y + 3, 9, 1, BRS_LIT);   // the brass nosing
    px(x + 1, y + 4, w - 2, 1, U.shade(BRS, -0.52));                    // its shadow onto the front face
    wear(x + 2, y - 1, w - 4, 4, 4, U.shade(WD, -0.12));
    // ---- BACK GANTRY: two end standards + a mid rail carry the shelf, so it is JOINERY, not a floater.
    const sy = y - 11, sw = 26, sxx = x + 5;
    for (const bx of [sxx, sxx + sw - 3]) {
      px(bx, sy + 5, 3, 8, LINE);
      px(bx, sy + 5, 1, 8, U.shade(WD, 0.18)); px(bx + 1, sy + 5, 1, 8, WD); px(bx + 2, sy + 5, 1, 8, WD_DK);
      keyEdge(bx, sy + 6, 1, 5, 0.16); rimEdge(bx + 2, sy + 6, 1, 6, 0.18);
    }
    px(sxx + 2, sy + 9, sw - 4, 1, WD_DK); px(sxx + 2, sy + 9, 6, 1, U.shade(WD, 0.10));   // mid rail
    // shelf carcass
    chamf(sxx - 1, sy - 1, sw + 2, 8, LINE, 2);
    chamf(sxx, sy, sw, 6, U.shade(WD, -0.20), 2);
    px(sxx + 2, sy, sw - 4, 1, WD_LIT); keyEdge(sxx + 2, sy, 7, 1, 0.24);
    px(sxx, sy + 2, 1, 3, U.shade(WD, 0.14)); px(sxx + sw - 1, sy + 2, 1, 3, WD_DK);
    rimEdge(sxx + sw - 1, sy + 2, 1, 3, 0.20);
    inset(sxx + 1, sy + 1, sw - 2, 4, '#140a10');                       // back-lit niche
    // BOTTLES as three-part silhouettes against the light: body, shoulder, neck. Seven across 24px.
    for (let i = 0; i < 7; i++) {
      const bc = ['#7adfd0', '#caa84a', '#b44aff', '#ff6ad5', '#7fd0ff', '#caa84a', '#8adf9a'][i];
      const bh2 = 2 + (i % 2), bxx = sxx + 2 + i * 3;
      px(bxx, sy + 5 - bh2, 2, bh2, U.shade(bc, -0.34));                // body
      px(bxx, sy + 5 - bh2, 1, bh2, bc);                                // lit west edge
      px(bxx, sy + 4 - bh2, 2, 1, U.shade(bc, -0.52));                  // shoulder
      px(bxx, sy + 3 - bh2, 1, 1, U.shade(bc, -0.16));                  // neck, catching the niche light
    }
    bloom(sxx + 1, sy + 1, sw - 2, 4, ACC.lounge, on ? 0.26 : 0.16);    // the niche is always lit
    spill(sxx + 1, sy + 6, sw - 2, ACC.lounge, on ? 0.20 : 0.12, 4);    // shelf light pools onto the counter
    px(sxx + sw - 4, sy + 1, 1, 1, blink(1500, ph) ? ACC.flow : '#33241a');   // shelf pilot lamp
    // ---- TAP BANK: three taps on a shared plinth, rising off the back edge of the counter. SHORT and
    // in bronze, not tall and in chrome: a first pass ran them six rows of near-white up into the shelf
    // zone and they read as three lit CANDLES — the brightest thing on the prop, in front of the one
    // element (the bottle niche) that is supposed to be the light source.
    const tx = x + Math.round(w / 2) - 9;
    px(tx - 1, y - 1, 11, 2, U.shade(BRS, -0.34)); px(tx - 1, y - 1, 11, 1, BRS);
    for (let i = 0; i < 3; i++) {
      const tk = tx + i * 4;
      px(tk, y - 5, 1, 4, '#6c7a86'); px(tk, y - 5, 1, 2, '#96a4ae');   // the column
      px(tk, y - 6, 2, 1, BRS_LIT);                                     // the handle badge
      px(tk - 1, y - 2, 1, 1, '#7a8894');                               // spout
    }
    if ((now % 2400) < 200) px(tx + 3, y - 1, 1, 1, '#ffd9a0');         // a drip off the middle tap
    // ---- SERVICE ON THE COUNTER. Grouped west / centre / east so it reads as three stations, not litter.
    px(x + 5, y - 1, 3, 4, '#8a98a8'); px(x + 5, y - 1, 3, 1, BRS); px(x + 5, y - 1, 1, 4, '#c2ced6');  // can
    px(x + 10, y, 2, 3, '#7adfd0'); px(x + 10, y - 1, 2, 1, '#3a6a62'); px(x + 10, y, 1, 3, '#bffff2');  // bottle
    chamf(x + Math.round(w / 2) - 4, y + 1, 8, 3, '#1c2426', 1);        // bar mat
    px(x + Math.round(w / 2) - 3, y + 1, 6, 1, '#2a3436');
    for (const gx of [x + w - 14, x + w - 10]) {                        // two glasses, drying upside down
      px(gx, y - 1, 3, 4, '#93a8b4'); px(gx, y - 1, 3, 1, '#c6d6de');
      px(gx + 2, y, 1, 3, '#63757f'); px(gx, y + 3, 3, 1, '#4a585f');
    }
    px(x + w - 6, y + 1, 3, 2, '#dfe8df');                              // napkin stack
    if (on) px(x + 6, y - 2, 1, 1, blink(800, ph) ? '#7a8a86' : '#5a6a66');   // someone just poured
  };

  F.stool = (x, y, w, h, f) => {   // v4 gas-lift task stool — one big oval seat over a thin chrome stem
    // blocks:true, so this one IS a solid on the deck and keeps a real contact shadow. The whole read is
    // the fat seat against the thin stem: at 12px that contrast is the only thing distinguishing a stool
    // from a bollard.
    const r = RAMP.steel;
    shadow2(x + 3, y + 11, 7);                                  // real floor contact
    // splayed foot ring — an oval we look down on, so the base reads as five spokes, not a disc
    px(x + 3, y + 8, 6, 1, LINE); px(x + 2, y + 9, 8, 1, LINE); px(x + 3, y + 10, 6, 1, LINE);
    px(x + 3, y + 9, 6, 1, '#46535c');
    keyEdge(x + 3, y + 9, 3, 1, 0.24);                          // warm key on the ring's west arc
    rimEdge(x + 8, y + 9, 1, 1, 0.22);
    px(x + 3, y + 10, 2, 1, '#1a1e22'); px(x + 7, y + 10, 2, 1, '#1a1e22');   // rubber pads
    px(x + 2, y + 9, 1, 1, '#232b30'); px(x + 9, y + 9, 1, 1, '#161b1f');
    // chrome gas-lift stem. Chrome is two temperatures stacked, never a grey gradient: warm on the west
    // half, cold sky on the east, with a dark core between them.
    px(x + 4, y + 4, 4, 5, LINE);
    px(x + 5, y + 4, 1, 4, '#6d7a84'); px(x + 6, y + 4, 1, 4, '#39434b');
    keyEdge(x + 5, y + 4, 1, 4, 0.26); rimEdge(x + 6, y + 5, 1, 3, 0.28);
    px(x + 5, y + 6, 2, 1, '#7d8a94');                          // lift collar catches a hard line
    px(x + 8, y + 5, 2, 1, '#39434b'); px(x + 10, y + 5, 1, 1, '#1a1e22');   // adjust lever
    // BIG round cushioned seat — this is a top-down game, so the seat is the prop
    px(x + 3, y, 6, 1, LINE); px(x + 2, y + 1, 8, 1, LINE); px(x + 1, y + 2, 10, 2, LINE);
    px(x + 2, y + 4, 8, 1, LINE); px(x + 3, y + 5, 6, 1, LINE);
    px(x + 3, y + 1, 6, 1, '#4a8a82'); px(x + 3, y + 1, 3, 1, '#5aa89c');
    keyEdge(x + 3, y + 1, 4, 1, 0.22);                          // the crown of the pad takes the ceiling strip
    px(x + 2, y + 2, 8, 2, '#2f6a62');
    px(x + 2, y + 2, 1, 2, '#4a8a82'); px(x + 9, y + 2, 1, 2, '#26554e');
    rimEdge(x + 9, y + 2, 1, 2, 0.20);                          // cold bounce off the east flank of the pad
    px(x + 3, y + 3, 1, 1, '#26554e'); px(x + 8, y + 3, 1, 1, '#26554e');   // piping stitches (kept)
    px(x + 5, y + 2, 2, 1, U.shade('#2f6a62', 0.18));           // a soft crease where a body sits
    px(x + 3, y + 4, 6, 1, r.dk);                               // rounded underside rim
    px(x + 4, y + 5, 4, 1, U.shade(r.dk, -0.30));               // seat AO onto the stem
  };

  F.tv = (x, y, w, h, f) => {   // v4 TV (3x1) — chamfered panel on a credenza; screen faces SOUTH (its approach side)
    const r = RAMP.steel, ph = (f && f.x) || 0;
    const watched = !!(f && f.work);   // a couch-sitter is watching → the room actually catches the picture
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 5]) {                        // credenza feet, freestanding
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // credenza face: two real doors with recessed pulls, left open and uncluttered (agents walk up here)
    chamf(x - 1, y + 4, w + 2, 6, LINE, 2);
    px(x, y + 5, w, 4, r.face);
    px(x, y + 5, w, 1, r.lit); keyEdge(x + 1, y + 5, w - 3, 1, 0.16);
    for (const dx of [x + 12, x + 24]) { px(dx, y + 6, 1, 3, r.ao); px(dx + 1, y + 6, 1, 3, U.shade(r.face, 0.10)); }
    for (const pxx of [x + 5, x + 17, x + 29]) { px(pxx, y + 6, 2, 1, U.shade(r.face, -0.40)); px(pxx, y + 7, 2, 1, U.shade(r.face, 0.12)); }
    px(x + w - 1, y + 5, 1, 4, r.dk); rimEdge(x + w - 1, y + 5, 1, 4, 0.20);
    px(x, y + 8, w, 1, r.ao);
    // credenza top
    chamf(x - 1, y + 1, w + 2, 5, LINE, 2);
    chamf(x, y + 2, w, 3, r.top, 2);
    px(x + 2, y + 2, w - 4, 1, r.sheen); keyEdge(x + 2, y + 2, 8, 1, 0.26);
    px(x + 1, y + 4, w - 2, 1, U.shade(r.top, -0.16));
    // the PANEL: chamfered slab on a real pedestal foot, so it sits ON the credenza instead of hovering
    px(x + 12, y + 1, 12, 2, U.shade(r.top, -0.34)); px(x + 13, y + 1, 10, 1, U.shade(r.top, -0.12));  // foot pressed into the top
    px(x + 16, y - 1, 4, 3, U.shade(r.face, -0.12)); px(x + 16, y - 1, 1, 3, r.lit); px(x + 19, y - 1, 1, 3, r.dk);  // neck
    chamf(x + 2, y - 12, w - 4, 15, LINE, 2);
    chamf(x + 3, y - 11, w - 6, 13, '#12181d', 2);                // bezel
    px(x + 5, y - 11, w - 10, 1, '#26333a'); keyEdge(x + 5, y - 11, 7, 1, 0.24);   // warm catch along the crown
    px(x + 3, y - 9, 1, 9, '#1e2a30'); px(x + w - 4, y - 9, 1, 9, '#0b1013');
    rimEdge(x + w - 4, y - 9, 1, 9, 0.22);                        // cool sky bounce down the shade side
    const sx = x + 4, sy = y - 9, sw = w - 8, sh2 = 9;
    inset(sx - 1, sy - 1, sw + 2, sh2 + 2, '#06090c');            // glass well
    const mode = Math.floor(now / 4000) % 3;
    let cast = '#2a3a4a';                                          // the colour the room catches from this channel
    if (mode === 0) {                                              // static
      px(sx, sy, sw, sh2, '#101418');
      for (let i = 0; i < 30; i++) px(sx + (U.hash('tv' + i + Math.floor(now / 90)) % sw), sy + (U.hash('tw' + i + Math.floor(now / 90)) % sh2), 1, 1, '#9aa');
      px(sx, sy + (Math.floor(now / 130) % sh2), sw, 1, '#202830');   // rolling bar
      cast = '#8a9aa8';
    } else if (mode === 1) {                                       // movie: sunset over water
      for (let j = 0; j < sh2; j++) px(sx, sy + j, sw, 1, ['#2a5a7a', '#2a5a7a', '#35617c', '#41647a', '#2c4a62', '#1f3c56', '#1a3a5a', '#173350', '#142d47'][j]);
      px(sx + 3, sy + 2, 6, 2, '#e8c860'); px(sx + 4, sy + 1, 4, 1, '#f0d880');   // sun dome
      bloom(sx + 3, sy + 1, 6, 3, '#ffd9a0', 0.22);                // the sun actually blooms on the glass
      px(sx + 3, sy + 5, 6, 1, '#8a7a4a'); px(sx + 4, sy + 7, 4, 1, '#6a6038');   // water glints
      px(sx + 18, sy + 4, 8, 3, '#0e2436'); px(sx + 18, sy + 4, 8, 1, '#16344a'); // island + rim light
      cast = '#2a5a7a';
    } else {                                                       // news: anchor + headlines
      px(sx, sy, sw, sh2, '#3a1a2a');
      px(sx + 2, sy, 8, 1, '#4a2436');
      px(sx + 3, sy + 1, 5, 5, '#caa088'); px(sx + 4, sy + 2, 1, 1, '#222'); px(sx + 6, sy + 2, 1, 1, '#222');
      px(sx + 4, sy + 4, 3, 1, '#a08068');
      px(sx + 3, sy + 6, 5, 1, '#2a3a5a');                         // suit
      px(sx + 10, sy + 2, 12, 1, '#e0e0e0'); px(sx + 10, sy + 4, 9, 1, '#b0b0b0');
      px(sx + 10, sy + 2, 4, 1, '#f4f4f4');                        // headline pop
      px(sx, sy + 7, sw, 2, '#2a1220'); px(sx + 1 + (Math.floor(now / 160) % (sw - 11)), sy + 7, 10, 1, '#ff5c7a');  // ticker
      px(sx + sw - 6, sy, 4, 2, '#ff5c7a'); px(sx + sw - 5, sy, 2, 1, '#ffa8b8');  // LIVE bug
      cast = '#6a2a3a';
    }
    scanl(sx, sy, sw, sh2, watched ? 0.08 : 0.14);                 // an unwatched set reads dustier
    px(sx, sy, 6, 2, U.shade(cast, 0.45));                         // glass glint on the corner
    glow(sx, sy, 6, 2, '#dfe8f0', 0.07);
    bloom(sx, sy, sw, sh2, cast, watched ? 0.16 : 0.09);           // panel bloom with real falloff
    spill(sx, y + 2, sw, cast, watched ? 0.30 : 0.13, 5);          // picture light pools DOWN the credenza top
    // soundbar on the credenza + the chin badge
    px(x + 8, y + 3, w - 16, 1, '#161c22'); px(x + 8, y + 3, 1, 1, U.shade('#161c22', 0.5));
    for (let i = 0; i < 4; i++) px(x + 11 + i * 4, y + 3, 1, 1, watched && blink(240, i + ph) ? U.shade(cast, 0.4) : '#2e2e2e');
    px(x + Math.round(w / 2) - 1, y, 2, 1, '#1e262c');             // brand chip on the chin
    px(x + w - 6, y, 1, 1, watched ? '#ff6a6a' : (blink(1400, ph) ? '#ff3030' : '#3a1010'));   // standby LED
    cable(x + w - 5, y - 1, x + w - 2, y + 4, 1.6, '#0b1114');     // panel lead sagging behind the credenza
  };

  F.couch = (x, y, w, h, f) => {   // v4 sofa (5x1) — MATERIAL pass only. The BACK VIEW is locked: the sofa faces
    const r = RAMP.fabric;         // north (the TV), the tall rear panel occludes a sitter, heads peek over the cap.
    // Geometry — cap line, panel height, arm extents, cushion seams — is untouched on purpose: the renderer
    // y-sorts a seated body against this silhouette (seat foot at (y+h)*T-2), so moving any of it breaks sitting.
    shadow2(x + 1, y + h - 1, w - 2);                             // floor contact; lounge tier stays freestanding
    // throw-pillow tops leaning on the far seat, just proud of the back line
    px(x + 6, y - 8, 7, 4, LINE);
    px(x + 7, y - 7, 5, 3, '#2f6a62'); px(x + 7, y - 7, 5, 1, '#4a8a82');
    px(x + 7, y - 7, 1, 3, U.shade('#2f6a62', 0.18)); px(x + 11, y - 7, 1, 3, U.shade('#2f6a62', -0.24));
    keyEdge(x + 7, y - 7, 3, 1, 0.20);
    px(x + w - 13, y - 8, 7, 4, LINE);
    px(x + w - 12, y - 7, 5, 3, '#8a6a3a'); px(x + w - 12, y - 7, 5, 1, '#caa84a');
    px(x + w - 12, y - 7, 1, 3, U.shade('#8a6a3a', 0.18)); px(x + w - 8, y - 7, 1, 3, U.shade('#8a6a3a', -0.24));
    rimEdge(x + w - 8, y - 7, 1, 3, 0.20);
    // backrest from behind: rounded lit cap + ONE tall rear panel dropping to the floor
    rr(x + 1, y - 5, w - 2, h + 5, LINE);
    px(x + 2, y - 4, w - 4, 2, r.lit);                            // cap catches the light
    px(x + 2, y - 4, 8, 1, U.shade(r.lit, 0.10));
    keyEdge(x + 2, y - 4, 14, 1, 0.26);                           // warm ceiling strip along the crown
    rimEdge(x + w - 6, y - 4, 4, 1, 0.20);                        // cool sky bounce at the far end of the cap
    px(x + 2, y - 3, w - 4, 1, U.shade(r.lit, -0.22));            // piping seam where the cap rolls into the panel
    px(x + 2, y - 2, w - 4, h, r.face);                           // rear upholstery panel
    for (let j = 0; j < h; j += 2) px(x + 3, y - 2 + j, w - 6, 1, U.shade(r.face, -0.07));   // weave — fabric, not painted steel
    px(x + 2, y - 2, 1, h, U.shade(r.face, 0.10));                // lit west facet
    px(x + w - 3, y - 2, 1, h, r.dk);                             // dark east facet
    rimEdge(x + w - 3, y - 2, 1, h - 2, 0.22);                    // cool bounce down the shade flank
    for (let i = 1; i < (w - 4) / 14; i++) {                      // cushion seams (these mark the cushions — locked)
      px(x + 2 + i * 14, y - 1, 1, h - 2, r.dk);
      px(x + 3 + i * 14, y - 1, 1, h - 3, U.shade(r.face, 0.09)); // the catch beside each seam gives the panel depth
    }
    wear(x + 2, y - 1, w - 4, h - 2, 6, U.shade(r.face, -0.08));
    px(x + 2, y + h - 3, w - 4, 1, U.shade(r.face, -0.18));       // kick-line shadow near the floor
    px(x + 2, y + h - 2, w - 4, 1, r.ao);                         // floor-line ambient occlusion
    // arms: rounded caps that step DOWN from the back and wrap the ends to the floor
    for (const ax of [x, x + w - 4]) {
      rr(ax - 1, y - 3, 6, h + 3, LINE);
      px(ax, y - 2, 4, h + 1, r.face);
      px(ax, y - 2, 4, 2, r.lit); px(ax, y - 2, 3, 1, U.shade(r.lit, 0.10));   // arm cap
      if (ax === x) { keyEdge(ax, y - 2, 4, 1, 0.24); px(ax, y, 1, h - 2, U.shade(r.face, 0.10)); }
      else { rimEdge(ax + 3, y - 2, 1, h, 0.20); px(ax + 3, y, 1, h - 2, r.dk); }
      px(ax, y, 4, 1, U.shade(r.face, -0.20));                    // roll seam under the arm cap
      px(ax, y + h - 2, 4, 1, r.ao);                              // arm base AO
    }
  };

  F.arcade = (x, y, w, h, f) => {   // v4 SHOOTER cab (1x2) — SQUARE-shouldered crown + wide jutting marquee.
    // Sibling-legibility law: arcade and arcade2 stand side by side, so they must differ in SILHOUETTE, not just
    // hue — this one is boxy with a header that overhangs east/west; arcade2 is round-crowned and narrow-headed.
    const cw = 13, bh = h, r = RAMP.steel, ph = (f && f.x) || 0, played = !!(f && f.work);
    shadow2(x + 1, y + bh - 1, cw - 2);                           // freestanding: no deck plate on lounge tier
    // body: chamfered slab with lit W / shaded E facets
    chamf(x - 1, y - 5, cw + 2, bh + 4, LINE, 2);
    chamf(x + 1, y - 4, cw - 2, bh + 2, r.face, 1);
    px(x + 1, y - 3, 1, bh, U.shade(r.face, 0.10)); px(x + cw - 2, y - 3, 1, bh, r.dk);
    rimEdge(x + cw - 2, y - 3, 1, bh, 0.20);                      // cool sky bounce down the shade flank
    // SQUARE crown — flat-topped header block, the half of the silhouette read that isn't colour
    chamf(x, y - 10, cw, 5, LINE, 1);
    px(x + 1, y - 9, cw - 2, 3, r.top);
    px(x + 1, y - 9, cw - 2, 1, r.sheen); keyEdge(x + 1, y - 9, 6, 1, 0.30);
    px(x + 1, y - 7, cw - 2, 1, U.shade(r.top, -0.24));           // header underside
    // marquee JUTS out wider than the body — an overhanging light box
    chamf(x - 2, y - 6, cw + 4, 5, LINE, 1);
    const lit = blink(700, ph);
    px(x - 1, y - 5, cw + 2, 3, lit ? ACC.lounge : '#3a2a3a');
    px(x + 1, y - 5, 4, 1, '#ffd0ee'); px(x + 7, y - 4, 5, 1, U.shade(ACC.lounge, 0.30));   // title lettering block
    bloom(x - 1, y - 5, cw + 2, 3, ACC.lounge, lit ? 0.34 : 0.12);
    px(x - 1, y - 2, cw + 2, 1, U.shade('#3a2a3a', -0.35));       // marquee underside shadow onto the body
    spill(x + 1, y - 2, cw - 2, ACC.lounge, lit ? 0.16 : 0.06, 3);
    px(x + 1, y + 2, 1, bh - 12, ACC.lounge); px(x + 1, y + 3, 1, 2, '#ffa8e8');   // side art stripe
    // screen: recessed behind a heavy bezel, tilted back into the cabinet
    px(x + 1, y - 2, cw - 2, 1, U.shade(r.face, -0.44));          // bezel shelf above the glass
    inset(x + 2, y - 1, cw - 4, 9, '#0c0a16');
    const sp = played ? 170 : 280, fr = Math.floor(now / sp) % 4;
    for (let i = 0; i < 4; i++) px(x + 3 + i * 2, y + (i & 1), 1, 1, '#1c1830');   // starfield
    px(x + 4 + (fr % 3), y + 1, 2, 2, '#41ff8a'); px(x + 4 + (fr % 3), y, 1, 1, '#8affb8');   // player + cannon
    for (let i = 0; i < 3; i++) px(x + 3 + i * 2 + (fr & 1), y + 5, 1, 1, '#ff5c5c');          // marching enemies
    if (fr === 2) px(x + 6, y + 3, 1, 1, ACC.flow);               // a shot in flight
    if (played) {                                                 // someone is really on the sticks: score row + hits
      for (let i = 0; i < 4; i++) px(x + 3 + i * 2, y + 7, 1, 1, blink(220, i + ph) ? '#c7ffe0' : '#1c3a2a');
      px(x + 4 + ((fr + 1) % 3), y + 4, 1, 1, '#fff0c0');
      bloom(x + 2, y - 1, cw - 4, 9, '#41ff8a', 0.14);
    } else {
      px(x + 4, y + 7, 5, 1, blink(900, ph) ? U.shade(ACC.flow, -0.10) : '#33241a');   // attract-mode INSERT COIN bar
      glow(x + 2, y - 1, cw - 4, 9, '#41ff8a', 0.07);             // idle glass keeps phosphor — never a black hole
    }
    scanl(x + 2, y, cw - 4, 8, 0.12);
    // control deck JUTS toward the camera: lit top + front lip, joystick and two buttons
    chamf(x - 1, y + 9, cw + 2, 4, LINE, 1);
    px(x, y + 10, cw, 2, r.top); px(x, y + 10, cw, 1, r.sheen); keyEdge(x, y + 10, 5, 1, 0.24);
    px(x + 3, y + 11, 1, 1, played && blink(200, ph) ? '#ff9d9d' : '#ff5c5c');
    px(x + 5, y + 11, 1, 1, played && blink(200, ph + 1) ? '#fff0a8' : ACC.flow);
    px(x + 8, y + 10, 1, 1, '#b9bfc4'); px(x + 8 + (played ? (fr & 1) : 0), y + 11, 1, 1, '#7c848a');   // stick + ball top
    px(x, y + 12, cw, 1, r.dk); rimEdge(x + cw - 1, y + 10, 1, 3, 0.18);
    // coin door on the lower face
    px(x + 3, y + bh - 7, cw - 6, 3, r.dk); px(x + 3, y + bh - 7, cw - 6, 1, U.shade(r.face, 0.10));
    px(x + 5, y + bh - 6, 2, 1, blink(900, ph) ? ACC.flow : '#3a3020');
    // kick plate + feet with a floor gap
    px(x + 1, y + bh - 3, cw - 2, 1, r.ao);
    underAO(x + 2, y + bh - 2, cw - 4, 1);
    px(x + 1, y + bh - 2, 2, 2, r.dk); px(x + cw - 3, y + bh - 2, 2, 2, r.dk);
    px(x + 1, y + bh - 2, 1, 1, r.lit); px(x + cw - 3, y + bh - 2, 1, 1, r.lit);
    wear(x + 1, y + bh - 7, cw - 2, 4, 3, U.shade(r.face, -0.12));   // kick scuffs
  };

  F.arcade2 = (x, y, w, h, f) => {   // v4 RHYTHM cab (1x2) — ROUND-crowned bonnet, narrow header, deep pad deck.
    // Deliberately unlike its neighbour: no overhanging marquee, a curved top, a control deck that juts further
    // south, and a falling-note screen instead of a shooter. Teal identity carried in light, body stays on the ramp.
    const cw = 13, bh = h, r = RAMP.steel, ph = (f && f.x) || 0, played = !!(f && f.work);
    const TEAL = '#2ee6c8', PALE = '#bff8ee';
    shadow2(x + 1, y + bh - 1, cw - 2);
    // body
    chamf(x - 1, y - 5, cw + 2, bh + 4, LINE, 2);
    chamf(x + 1, y - 4, cw - 2, bh + 2, r.face, 1);
    px(x + 1, y - 3, 1, bh, U.shade(r.face, 0.10)); px(x + cw - 2, y - 3, 1, bh, r.dk);
    rimEdge(x + cw - 2, y - 3, 1, bh, 0.20);
    // ROUNDED bonnet crown — narrowing rows, no side overhang at all
    px(x + 4, y - 11, cw - 8, 1, LINE); px(x + 2, y - 10, cw - 4, 1, LINE); px(x, y - 9, cw, 4, LINE);
    px(x + 5, y - 11, cw - 10, 1, U.shade(r.sheen, 0.15));
    px(x + 3, y - 10, cw - 6, 1, r.sheen); keyEdge(x + 3, y - 10, 4, 1, 0.30);
    px(x + 1, y - 9, cw - 2, 1, r.lit);
    px(x + 1, y - 8, cw - 2, 2, r.top); px(x + cw - 2, y - 8, 1, 2, r.dk); rimEdge(x + cw - 2, y - 8, 1, 2, 0.20);
    px(x + 1, y - 6, cw - 2, 1, U.shade(r.top, -0.24));           // bonnet underside
    // NARROW header light bar sunk into the body — the anti-marquee
    const lit = blink(900, ph + 2);
    inset(x + 3, y - 5, cw - 6, 3, '#0d1c1e');
    px(x + 4, y - 4, cw - 8, 1, lit ? TEAL : '#194440');
    px(x + 4, y - 4, 2, 1, lit ? PALE : '#22625c');
    bloom(x + 4, y - 4, cw - 8, 1, TEAL, lit ? 0.36 : 0.13);
    px(x + 1, y + 2, 1, bh - 12, TEAL); px(x + 1, y + 3, 1, 2, PALE);   // side art stripe
    // screen: falling-note lanes running down to a hit line
    px(x + 1, y - 2, cw - 2, 1, U.shade(r.face, -0.44));
    inset(x + 2, y - 1, cw - 4, 9, '#0a1216');
    const sp = played ? 130 : 200, fr = Math.floor(now / sp) % 5;
    for (let i = 0; i < 4; i++) px(x + 3 + i * 2, y, 1, 8, '#0f2024');     // lane guides
    px(x + 3, y + 6, cw - 6, 1, '#12464a');                       // the hit line
    for (let i = 0; i < 4; i++) {
      const ny = ((fr + i * 2) % 7);
      px(x + 3 + i * 2, y + ny, 1, 1, ny > 4 ? PALE : TEAL);      // a note falling toward the line
      px(x + 3 + i * 2, y + Math.max(0, ny - 1), 1, 1, '#15564c'); // its trail
    }
    if (played) {                                                 // real player: judgement flashes + combo meter
      px(x + 3, y + 6, cw - 6, 1, blink(160, ph) ? PALE : TEAL);
      for (let i = 0; i < 4; i++) px(x + 3 + i * 2, y + 7, 1, 1, ((fr + i) % 4) ? '#123a38' : ACC.flow);
      bloom(x + 2, y - 1, cw - 4, 9, TEAL, 0.15);
    } else {
      px(x + 4, y + 7, 5, 1, blink(1100, ph) ? U.shade(ACC.flow, -0.10) : '#33241a');   // attract-mode demo bar
      glow(x + 2, y - 1, cw - 4, 9, TEAL, 0.07);                  // idle glass keeps a little phosphor
    }
    scanl(x + 2, y, cw - 4, 8, 0.12);
    // control deck juts a row FURTHER south than its neighbour's, carrying four rhythm pads
    chamf(x - 1, y + 9, cw + 2, 5, LINE, 1);
    px(x, y + 10, cw, 3, r.top); px(x, y + 10, cw, 1, r.sheen); keyEdge(x, y + 10, 5, 1, 0.24);
    for (let i = 0; i < 4; i++) {
      const hitp = played && ((fr + i) % 4 === 0);
      px(x + 2 + i * 3, y + 11, 2, 1, hitp ? PALE : U.shade(TEAL, -0.30));
      if (hitp) bloom(x + 2 + i * 3, y + 11, 2, 1, TEAL, 0.34);
    }
    px(x, y + 13, cw, 1, r.dk); rimEdge(x + cw - 1, y + 10, 1, 4, 0.18);
    // coin door on the lower face
    px(x + 3, y + bh - 7, cw - 6, 3, r.dk); px(x + 3, y + bh - 7, cw - 6, 1, U.shade(r.face, 0.10));
    px(x + 5, y + bh - 6, 2, 1, blink(1100, ph) ? TEAL : '#16302e');
    // lit footlight strip along the base — the rhythm cab's other silhouette tell
    px(x + 2, y + bh - 5, cw - 4, 1, played ? TEAL : U.shade(TEAL, -0.55));
    if (played) spill(x + 2, y + bh - 4, cw - 4, TEAL, 0.20, 3);
    px(x + 1, y + bh - 3, cw - 2, 1, r.ao);
    underAO(x + 2, y + bh - 2, cw - 4, 1);
    px(x + 1, y + bh - 2, 2, 2, r.dk); px(x + cw - 3, y + bh - 2, 2, 2, r.dk);
    px(x + 1, y + bh - 2, 1, 1, r.lit); px(x + cw - 3, y + bh - 2, 1, 1, r.lit);
    wear(x + 1, y + bh - 7, cw - 2, 4, 3, U.shade(r.face, -0.12));
  };

  F.jukebox = (x, y, w, h, f) => {   // v4 jukebox (1x2) — dome, bubble tubes, spinning disc. DEAD until Spotify connects.
    // OBJECT=CAPABILITY TRUTH (unchanged, and the whole point of this prop): a placed jukebox GRANTS the Spotify
    // tools, but they are INERT until the user connects Spotify in TOOLSETS. So the unconnected machine is drawn
    // genuinely UNPOWERED, not merely dimmer — every emissive is off, the chrome goes cold, the disc is parked,
    // and its mains lead lies COILED AND UNPLUGGED on the floor beside it. f.live = Spotify really connected.
    const live = !!(f && f.live), ph = (f && f.x) || 0;
    const cw = 13, bh = h, r = RAMP.steel;
    const cold = c => live ? c : U.shade(c, -0.42);   // cold-shift the casing when unplugged
    shadow2(x + 1, y + bh - 1, cw - 2);
    // body slab
    chamf(x - 1, y - 5, cw + 2, bh + 4, LINE, 2);
    chamf(x + 1, y - 4, cw - 2, bh + 2, cold(r.face), 1);
    px(x + 1, y - 4, 1, bh + 1, cold(U.shade(r.face, 0.10)));
    px(x + cw - 2, y - 4, 1, bh + 1, U.shade(r.dk, live ? 0 : -0.20));
    if (live) rimEdge(x + cw - 2, y - 3, 1, bh, 0.20);            // a dead machine catches no sky either
    // rounded DOME top
    px(x + 3, y - 8, cw - 6, 1, LINE); px(x + 1, y - 7, cw - 2, 1, LINE); px(x, y - 6, cw, 2, LINE);
    px(x + 4, y - 8, cw - 8, 1, cold(U.shade(r.sheen, 0.15)));    // dome crown catch
    px(x + 2, y - 7, cw - 4, 1, cold(r.sheen));
    px(x + 1, y - 6, cw - 2, 1, cold(r.lit));
    if (live) keyEdge(x + 3, y - 7, 5, 1, 0.30);                  // warm ceiling strip only reaches a live chrome dome
    // arch lamp under the dome — breathing when connected, a cold dead filament otherwise
    if (live) {
      px(x + 2, y - 4, cw - 4, 3, blink(500) ? ACC.flow : '#b88a3a');
      px(x + 3, y - 4, cw - 6, 1, '#ffe88c');
      bloom(x + 2, y - 4, cw - 4, 3, ACC.flow, 0.28 + 0.16 * Math.sin(now / 400));
      spill(x + 2, y - 1, cw - 4, ACC.flow, 0.16, 3);             // arch light washes down over the record window
    } else {
      px(x + 2, y - 4, cw - 4, 3, '#2e2a22');                     // unlit arch: a grey tube with a visible dead filament
      px(x + 3, y - 4, cw - 6, 1, '#3c3629');
      px(x + 4, y - 3, cw - 8, 1, '#221f19');
    }
    // bubble tubes climbing both flanks — bubbles rise only when live; still cold fluid when dead
    for (let i = 0; i < 2; i++) {
      const bx = i ? x + cw - 3 : x + 2;
      px(bx, y + 1, 1, 9, live ? '#2c3a42' : '#232b30');
      if (live) {
        const bp = (now / (900 + i * 300)) % 1;
        px(bx, y + 1 + Math.floor((1 - bp) * 8), 1, 1, '#7fd0ff');
        bloom(bx, y + 1 + Math.floor((1 - bp) * 8), 1, 1, ACC.data, 0.24);
      }
    }
    // record window + disc — spins only when live; parked and unlit when dead
    inset(x + 3, y + 1, cw - 6, 6, '#10161c');
    px(x + 4, y + 2, cw - 8, 4, live ? '#26262e' : '#1d1d22');    // platter
    px(x + 4, y + 2, cw - 8, 1, live ? '#3a3a44' : '#26262c');    // groove ring catch
    px(x + 5, y + 3, cw - 10, 2, '#15151a');                      // vinyl
    px(x + 6, y + 3, 1, 1, live ? ACC.lounge : U.shade(ACC.lounge, -0.55));   // label dot
    if (live) {
      const a = now / 300;
      px(x + 6 + Math.round(Math.cos(a) * 1.5), y + 3 + Math.round(Math.sin(a)), 1, 1, '#bfe6ff');
      bloom(x + 4, y + 2, cw - 8, 4, ACC.lounge, 0.10);
    }
    px(x + 2, y - 1, 1, 2, cold(r.sheen)); px(x + cw - 3, y - 1, 1, 2, cold(r.sheen));   // chrome shoulder trims
    // selection buttons
    px(x + 3, y + 9, cw - 6, 2, live ? '#1c242a' : '#181e22');
    for (let i = 0; i < 3; i++) px(x + 4 + i * 2, y + 9, 1, 1, (live && blink(600, i)) ? ACC.flow : '#2c2620');
    // speaker grille skirt
    for (let i = 0; i < 3; i++) {
      px(x + 2, y + 12 + i * 2, cw - 4, 1, r.ao);
      px(x + 2, y + 13 + i * 2, cw - 4, 1, cold(U.shade(r.face, 0.10)));
    }
    // base lamps — power indicators: alternating only when connected, both genuinely OUT otherwise
    px(x + 2, y + bh - 5, 2, 2, (live && blink(400)) ? '#ff5c5c' : '#3a1414');
    px(x + cw - 4, y + bh - 5, 2, 2, (live && blink(400, 1)) ? ACC.work : '#14361c');
    px(x + 1, y + bh - 3, cw - 2, 1, r.ao);
    underAO(x + 2, y + bh - 2, cw - 4, 1);
    px(x + 1, y + bh - 2, 2, 2, r.dk); px(x + cw - 3, y + bh - 2, 2, 2, r.dk);
    px(x + 1, y + bh - 2, 1, 1, cold(r.lit)); px(x + cw - 3, y + bh - 2, 1, 1, cold(r.lit));
    // THE MAINS LEAD is the readable-at-a-glance tell: plugged and taut when connected, coiled loose on the
    // floor with its plug lying free when not. A viewer who never opens TOOLSETS can still see it's not running.
    if (live) {
      cable(x + cw - 3, y + bh - 4, x + cw + 1, y + bh - 1, 1.4, '#0b1114');
      bloom(x + 1, y + bh - 2, cw - 2, 2, ACC.flow, 0.14 + 0.06 * Math.sin(now / 400));   // floor pool — only when plugged in
    } else {
      cable(x + cw - 3, y + bh - 4, x + cw + 2, y + bh - 2, 2.6, '#0b1114');
      px(x + cw + 1, y + bh - 1, 2, 1, '#141a1e'); px(x + cw + 1, y + bh - 1, 1, 1, '#232d33');   // the loose plug, pins bare
      px(x + cw + 3, y + bh - 1, 1, 1, '#3a444a');
    }
  };

  F.bunk = (x, y, w, h, f) => {
    // BED (2x2) — v6, and a REPLACEMENT, not a polish pass. The v4 art was a "crew berth": a pale
    // mattress slab, a teal wool blanket and a grey headboard cap, with boots and a jacket for story.
    // Every one of those pieces was a horizontal band of a cold desaturated colour, so at 3x the prop
    // read as a PHOTOCOPIER — which is exactly what the v5 sweep already flagged and left alone.
    // Andrew's call (2026-07-27): make it a bed of the Minecraft kind. That look is three flat, high-
    // contrast blocks in a timber frame — WHITE pillow at the head, RED quilt over the rest, brown
    // frame around both — and it is legible at any zoom precisely because it refuses to be subtle.
    // The catalog id stays 'bunk': saved stations carry the type string, and retiring a type leaves an
    // invisible obstacle behind (the v5 lane law). Only the LABEL moves to BED.
    //
    // PROPORTION IS THE WHOLE JOB HERE. A first pass gave the headboard 9 rows and the footboard 7 out
    // of 24, which left the bedding 13 — a light panel inside a heavy brown surround, i.e. a front-
    // loading washing machine. On a bed the BEDDING is the subject and the frame is a trim: head 5,
    // foot 4, bedding 17. Rails likewise drop 3px -> 2px a side.
    const WD = '#6b5030', WD_LIT = '#8f6d44', WD_DK = '#3d2c19';         // frame timber
    const QLT = '#a33a3a', QLT_LIT = '#c85a54', QLT_DK = '#6d2222';      // the quilt
    const LIN = '#d8d3c4', LIN_LIT = '#f0ece0';                          // linen
    const hdT = y - 3, ftT = y + h - 5;                                  // headboard top / footboard top
    shadow2(x + 1, y + h - 1, w - 2);
    // ---- FOUR POSTS. Drawn first so the rails and the bedding overlap them; the south pair is what
    // actually carries the prop's contact with the deck.
    for (const [lx, lit] of [[x + 1, true], [x + w - 4, false]]) {
      px(lx, y + 2, 3, h - 4, LINE);
      px(lx, y + 3, 3, h - 5, lit ? WD : U.shade(WD, -0.18));
      px(lx, y + 3, 1, h - 5, lit ? WD_LIT : WD);
      px(lx + 2, y + 3, 1, h - 5, WD_DK);
      if (lit) keyEdge(lx, y + 4, 1, h - 8, 0.16); else rimEdge(lx + 2, y + 4, 1, h - 8, 0.20);
      px(lx, y + h - 2, 3, 1, '#0a0d10');                              // foot contact
    }
    underAO(x + 4, y + h - 3, w - 8, 2);
    // ---- HEADBOARD, standing off the north edge. One slot band, not two cut-outs: a pair of dark
    // squares up there read as drawers and turned the whole prop into a bedside cabinet.
    chamf(x, hdT - 1, w, 7, LINE, 2);
    chamf(x + 1, hdT, w - 2, 6, WD, 2);
    px(x + 3, hdT, w - 6, 1, WD_LIT); keyEdge(x + 3, hdT, 9, 1, 0.28);
    px(x + 1, hdT + 2, 1, 3, WD_LIT); px(x + w - 2, hdT + 2, 1, 3, WD_DK);
    rimEdge(x + w - 2, hdT + 2, 1, 3, 0.20);
    px(x + 5, hdT + 2, w - 10, 2, WD_DK);                              // the slot, cut through the board
    px(x + 5, hdT + 2, w - 10, 1, U.shade(WD_DK, -0.44));
    px(x + 5, hdT + 4, w - 10, 1, U.shade(WD, 0.20));                  // its lit lower lip
    wear(x + 3, hdT + 1, w - 6, 4, 3, U.shade(WD, -0.16));
    px(x + 1, y + 2, w - 2, 1, U.shade(WD, -0.34));                    // the board's shade onto the bed
    // ---- SIDE RAILS running the length. These are what make the bedding sit INSIDE a frame.
    for (const [rx, lit] of [[x + 1, true], [x + w - 3, false]]) {
      px(rx, y + 2, 2, h - 6, lit ? WD : U.shade(WD, -0.14));
      px(rx, y + 2, 1, h - 6, lit ? WD_LIT : WD_DK);
      px(rx + 1, y + 2, 1, h - 6, WD_DK);
    }
    // ---- THE BEDDING, in two flat blocks. Flat is the point: any gradient here softens the read.
    // NO OUTLINE ROUND THE BEDDING. A LINE box here butts straight against the timber rails and the two
    // fuse into one fat black frame — the appliance-door read all over again. The rails ARE the border;
    // the only dark the bedding needs is the headboard's shade above it, which is already drawn.
    const bx = x + 3, bw = w - 6, qT = y + 9;
    // PILLOW at the head (north). One block of near-white, with a slept-in dent so it isn't a card.
    px(bx, y + 3, bw, 6, LIN);
    px(bx, y + 3, bw, 1, LIN_LIT); keyEdge(bx + 1, y + 3, 6, 1, 0.22);
    px(bx, y + 4, 1, 5, U.shade(LIN, 0.06)); px(bx + bw - 1, y + 4, 1, 5, U.shade(LIN, -0.22));
    rimEdge(bx + bw - 1, y + 4, 1, 5, 0.16);
    px(bx + 4, y + 5, 9, 2, U.shade(LIN, -0.14));                      // the dent a head left
    px(bx + 5, y + 5, 7, 1, U.shade(LIN, -0.22));
    // QUILT over the rest, hem to the foot. The turned-back fold at the head is the one asymmetry.
    px(bx, qT, bw, ftT - qT + 1, QLT);
    px(bx, qT, bw, 2, QLT_LIT);                                        // turned-down fold, catching light
    px(bx, qT, bw, 1, U.shade(QLT_LIT, 0.20));
    px(bx, qT + 2, bw, 1, QLT_DK);                                     // the fold's own shadow
    px(bx, qT + 3, 1, ftT - qT - 2, U.shade(QLT, 0.14));
    px(bx + bw - 1, qT + 3, 1, ftT - qT - 2, QLT_DK);
    rimEdge(bx + bw - 1, qT + 3, 1, ftT - qT - 2, 0.18);
    for (const qx of [bx + 5, bx + bw - 6]) px(qx, qT + 3, 1, ftT - qT - 2, U.shade(QLT, -0.18));  // stitching
    for (const qy of [qT + 4, qT + 8]) px(bx + 1, qy, bw - 2, 1, U.shade(QLT, -0.14));
    px(bx + 2, qT + 4, 5, 1, U.shade(QLT_LIT, -0.20));                 // one soft crease, west-biased
    wear(bx + 2, qT + 3, bw - 4, ftT - qT - 3, 5, U.shade(QLT, -0.12));
    // ---- FOOTBOARD, matching the headboard so the frame closes at both ends
    chamf(x, ftT, w, 5, LINE, 2);
    chamf(x + 1, ftT + 1, w - 2, 3, WD, 1);
    px(x + 3, ftT + 1, w - 6, 1, WD_LIT); keyEdge(x + 3, ftT + 1, 8, 1, 0.20);
    px(x + 1, ftT + 2, 1, 2, WD_LIT); px(x + w - 2, ftT + 2, 1, 2, WD_DK);
    rimEdge(x + w - 2, ftT + 2, 1, 2, 0.20);
    px(x + 3, ftT + 3, w - 6, 1, U.shade(WD, -0.30));                  // a rail groove across the board
    px(x + 1, y + h - 3, w - 2, 1, U.shade(WD_DK, -0.30));             // floor-line AO under the board
    // the quilt DRAPES over the footboard — the one place the silhouette is allowed to break, and the
    // cheapest way to stop the prop reading as a stack of three rectangles. Drawn LAST on purpose: an
    // earlier version painted it before the footboard and the board covered it completely.
    px(bx + 5, ftT, bw - 10, 4, QLT_DK);
    px(bx + 5, ftT, bw - 10, 1, U.shade(QLT, -0.06));
    px(bx + 6, ftT + 1, bw - 12, 1, U.shade(QLT, -0.22));
    px(bx + 6, ftT + 4, bw - 12, 1, U.shade(QLT_DK, -0.40));           // the hem's own shadow on the board
  };

  F.rug = (x, y, w, h, f) => {   // v4 lounge rug (4x3) — the station's biggest FLOOR DECAL. Zero rise, ever.
    // The whole point of this prop is that it is IN the ground plane: no oblique body, no front face, no
    // contact shadow. It's the largest walked-over surface in the game, so any 3D read here would make
    // every agent that crosses it look like it is clipping through furniture.
    const edge = '#1b2126', band = '#28313a', field = '#2f3a43', motif = '#48565f', acc = '#2f6a62';
    // soft rounded slab: union of two rects + stepped corners (a hard rectangle reads as a floor TILE,
    // not as textile)
    px(x + 2, y, w - 4, h, edge); px(x, y + 2, w, h - 4, edge);
    px(x + 1, y + 1, 1, 1, edge); px(x + w - 2, y + 1, 1, 1, edge);
    px(x + 1, y + h - 2, 1, 1, edge); px(x + w - 2, y + h - 2, 1, 1, edge);
    rr(x + 1, y + 1, w - 2, h - 2, band);
    // two-tone light read FLAT: the north half faces the ceiling strips (warm), the south half only sees
    // the cold bounce. On a floor decal this is the ONLY depth cue available — there are no facets to shade.
    px(x + 2, y + 1, w - 4, 1, U.shade(band, 0.14));
    keyEdge(x + 3, y + 1, w - 6, 2, 0.09);
    px(x + 2, y + h - 2, w - 4, 1, U.shade(band, -0.20));
    rimEdge(x + 2, y + h - 4, w - 4, 2, 0.07);
    px(x + 1, y + 2, 1, h - 4, U.shade(band, 0.06)); px(x + w - 2, y + 2, 1, h - 4, U.shade(band, -0.12));
    // border dashes in the lounge accent
    for (let i = 0; i < (w - 16) / 6; i++) { px(x + 8 + i * 6, y + 2, 3, 1, acc); px(x + 8 + i * 6, y + h - 3, 3, 1, acc); }
    for (let j = 0; j < (h - 16) / 6; j++) { px(x + 2, y + 8 + j * 6, 1, 3, acc); px(x + w - 3, y + 8 + j * 6, 1, 3, acc); }
    // inner field + herringbone weave — the texture that says textile rather than painted deck
    rr(x + 4, y + 4, w - 8, h - 8, field);
    for (let j = 0; j < h - 12; j += 2)
      for (let i = ((j >> 1) & 1) * 2; i < w - 12; i += 4)
        px(x + 6 + i, y + 6 + j, 2, 1, ((i + j) & 4) ? '#37434c' : '#2b353e');
    // bold diamond medallion with a teal core — one strong shape carries the read from across the room
    const cx = x + (w >> 1), cy = y + (h >> 1);
    for (let d = 0; d < 5; d++) {
      px(cx - 8 + d * 2, cy - d, 2, 1, motif); px(cx + 6 - d * 2, cy - d, 2, 1, motif);
      px(cx - 8 + d * 2, cy + d, 2, 1, motif); px(cx + 6 - d * 2, cy + d, 2, 1, motif);
    }
    px(cx - 4, cy - 1, 8, 3, '#39454e'); px(cx - 2, cy - 2, 4, 5, '#39454e');
    px(cx - 2, cy - 1, 4, 3, acc); px(cx - 1, cy - 1, 2, 1, '#4a8a82');
    keyEdge(cx - 2, cy - 1, 4, 1, 0.16);                        // the pile catches light on its north nap
    px(cx - 12, cy, 2, 1, motif); px(cx + 10, cy, 2, 1, motif);
    px(cx - 1, cy - 7, 2, 1, motif); px(cx - 1, cy + 6, 2, 1, motif);
    // WEAR is what makes a rug read as lived-on: a traffic path worn across it, sun-fade, threadbare pile
    ctx.globalAlpha = 0.13; px(x + 6, y + (h >> 1) - 2, w - 12, 5, '#0d1114'); ctx.globalAlpha = 1;
    ctx.globalAlpha = 0.14; px(x + 9, y + 7, 8, 4, '#8a98a8'); px(x + w - 16, y + h - 12, 7, 4, '#8a98a8'); ctx.globalAlpha = 1;
    wear(x + 5, y + 5, w - 10, h - 10, 12, '#232c33');
    // frayed edge ticks — the fringe is drawn IN the floor plane, so it reads as threads, not as a lip
    for (let j = 4; j < h - 4; j += 6) { px(x - 1, y + j, 1, 3, edge); px(x + w, y + j, 1, 3, edge); }
    for (let i = 5; i < w - 5; i += 7) { px(x + i, y - 1, 3, 1, edge); px(x + i, y + h, 3, 1, edge); }
  };

  F.chair = (x, y, w, h, f) => {
    // CHAIR — the renderer draws this at EVERY agent's seat, so it appears more often than any other prop
    // on the station. It is therefore deliberately QUIET: no emissives, no accent LEDs, no bloom. Its only
    // job is to sit next to a workstation and never compete with it. v4 adds material (chrome stem, warm
    // crown / cold flank on the pad) and nothing louder.
    if (f && f.big) {   // command throne (kept branch)
      ctx.globalAlpha = 0.22; px(x + 2, y + 9, 9, 2, '#000'); ctx.globalAlpha = 1;
      chamf(x + 1, y - 1, 10, 6, '#3a1212', 2);                 // high wing back
      px(x + 2, y, 8, 4, '#5a2222'); px(x + 2, y, 8, 1, '#7a3030');
      keyEdge(x + 2, y, 4, 1, 0.24); rimEdge(x + 9, y + 1, 1, 3, 0.18);
      px(x + 3, y + 1, 1, 3, '#6a2a2a'); px(x + 8, y + 1, 1, 3, '#481a1a');  // bolster shading
      px(x + 5, y - 1, 2, 1, '#8a3a3a');                        // headrest
      px(x + 2, y + 4, 8, 6, '#3a1616');
      px(x + 3, y + 5, 6, 2, '#4e1e1e'); px(x + 3, y + 5, 6, 1, '#5e2626');  // seat cushion
      px(x + 4, y + 6, 1, 1, '#3a1414'); px(x + 7, y + 6, 1, 1, '#3a1414');  // tuft buttons
      px(x + 1, y + 4, 2, 5, '#4a1c1c'); px(x + 9, y + 4, 2, 5, '#4a1c1c');  // armrests
      px(x + 1, y + 4, 2, 1, '#5e2626'); px(x + 9, y + 4, 2, 1, '#5e2626');
      px(x + 1, y + 8, 2, 1, '#320e0e'); px(x + 9, y + 8, 2, 1, '#320e0e');
      px(x + 2, y + 8, 1, 1, '#5a1a14');                            // armrest stud, dark — a chair has no console
      px(x + 9, y + 5, 1, 2, '#1c0a0a');
      bloom(x + 9, y + 5, 1, 2, ACC.alert, 0.16);                   // steady piping glow, no fake power heartbeat
      px(x + 5, y + 2, 2, 1, '#8a6a2a'); px(x + 5, y + 2, 1, 1, '#b8924a');      // gold trim
      px(x + 5, y + 10, 2, 1, '#1c0a0a');
      return;
    }
    const r = RAMP.steel;
    shadow2(x + 3, y + 10, 7);                                  // blocks:true — a real solid, real contact
    // star base: arm bar + casters. Kept low and dark so it disappears under a seated body.
    px(x + 2, y + 10, 8, 1, '#10161a');
    px(x + 3, y + 10, 6, 1, '#2a343c'); keyEdge(x + 3, y + 10, 3, 1, 0.16);
    px(x + 2, y + 9, 1, 1, '#242e35'); px(x + 9, y + 9, 1, 1, '#242e35');   // NW/NE arm tips
    for (const cw of [x + 2, x + 5, x + 8]) px(cw, y + 11, 2, 1, '#1a1e22');   // casters
    // chrome gas-lift column: warm west / cold east, matching the stool
    px(x + 4, y + 7, 4, 3, LINE);
    px(x + 5, y + 7, 1, 3, '#54616a'); px(x + 6, y + 7, 1, 3, '#39434b');
    keyEdge(x + 5, y + 7, 1, 2, 0.20); rimEdge(x + 6, y + 7, 1, 3, 0.22);
    // BACKREST — a WAISTED mesh back, not a slab. At 12px the PROFILE is the only thing that says
    // "chair" rather than "small appliance": a headrest bar clear of the shoulders, then a pinch at
    // the lumbar. Legibility bought from silhouette costs no brightness, so the prop stays quiet.
    px(x + 4, y - 4, 4, 1, LINE); px(x + 3, y - 3, 6, 1, LINE);
    px(x + 2, y - 2, 8, 4, LINE); px(x + 3, y + 2, 6, 1, LINE);
    px(x + 4, y - 3, 4, 1, U.shade(r.face, 0.16));              // headrest bar
    keyEdge(x + 4, y - 3, 2, 1, 0.26);
    px(x + 3, y - 2, 6, 3, r.face);                             // shoulders — the widest span
    px(x + 3, y - 2, 1, 3, U.shade(r.face, 0.12)); px(x + 8, y - 2, 1, 3, r.dk);
    rimEdge(x + 8, y - 2, 1, 3, 0.20);
    for (let j = 0; j < 3; j++)                                 // mesh weave, alternating rows
      px(x + 4, y - 2 + j, 4, 1, U.shade(r.face, j % 2 ? -0.13 : 0.03));
    px(x + 4, y + 1, 4, 1, U.shade(r.face, -0.26));             // pinched waist = the lumbar read
    // seat pad, middle-south — stays visible under a seated agent
    px(x + 1, y + 3, 10, 5, LINE);
    px(x + 2, y + 4, 8, 1, '#4a8a82'); px(x + 2, y + 4, 4, 1, '#5aa89c');
    keyEdge(x + 2, y + 4, 4, 1, 0.20);
    px(x + 2, y + 5, 8, 2, '#2f6a62');
    px(x + 2, y + 5, 1, 2, '#4a8a82'); px(x + 9, y + 5, 1, 2, '#26554e');
    rimEdge(x + 9, y + 5, 1, 2, 0.18);
    px(x + 3, y + 6, 1, 1, '#26554e'); px(x + 8, y + 6, 1, 1, '#26554e');   // seat stitches (kept)
    px(x + 2, y + 7, 8, 1, r.face); px(x + 2, y + 7, 3, 1, r.lit);          // front lip
    px(x + 3, y + 8, 6, 1, r.dk);                                          // rounded skirt
    // ARMRESTS — the second tell, and the cheapest one: two nubs breaking the outline east and west,
    // riding just above the seat. Drawn last so they read as in FRONT of the pad, not sunk into it.
    px(x, y + 2, 2, 4, LINE); px(x + 10, y + 2, 2, 4, LINE);
    px(x, y + 3, 2, 1, U.shade(r.face, 0.14)); keyEdge(x, y + 3, 1, 1, 0.26);   // west arm takes the key
    px(x, y + 4, 2, 1, U.shade(r.face, -0.18));
    px(x + 10, y + 3, 2, 1, U.shade(r.face, -0.04));            // east arm sits in shade
    px(x + 10, y + 4, 2, 1, r.dk); rimEdge(x + 10, y + 3, 1, 2, 0.22);
  };

  /* ============ TABLES (2026-07-26) ============
     The catalog had big hero surfaces (holotable, wartable, bar, bench) and nothing in between, so
     every small object — a plasma globe, a lava lamp, a terrarium — had to be parked on the deck,
     where it reads as litter. These three exist to be SAT ON: each carries `surface: true`, and a
     prop whose catalog row says `mount: 'surface'` may be placed on their tiles.

     THE ONE RULE THAT MAKES STACKING WORK: every table presents its top plane at the SAME height,
     SURFACE_RISE px above the floor line, so a mounted prop is drawn by shifting it up one constant
     and lands convincingly on ANY table. If you author a new table, its top face must straddle that
     plane — otherwise objects float above it or sink into it. There is no per-table offset and there
     should never be one: the moment tables disagree on height, every mounted prop needs a lookup. */
  F.sidetable = (x, y, w, h, f) => {
    // 1x1 ROUND pedestal side table — the "put ONE thing here" surface. Round on purpose: the other
    // two are rectangular, so at 12px the silhouette alone says which table you placed.
    // v6: the first version read as a MUSHROOM, for two compounding reasons. (1) The disc was 12px wide
    // plus a 1px outline each side, so the cap hung OUT of its own tile and dominated everything under
    // it. (2) Cap and stem were 5 rows each — a 50/50 split is the proportion of a toadstool, not of
    // furniture. The top is now 3 rows inside a 10px span and the stem carries eight, so it reads TALL.
    // The top PLANE is untouched at SURFACE_RISE — that is what mounted props are seated against.
    const top = y + h - 1 - SURFACE_RISE;                         // = y+3 at h:1
    const WD = '#63513a', WD_LIT = '#8a7154', WD_DK = '#382c1f';
    shadow2(x + 3, y + h - 1, 6);
    // SPLAYED FOOT first (it sits behind the stem): a base wider than the cap, so nothing reads as tipping
    chamf(x + 1, y + h - 3, 10, 3, LINE, 1);
    px(x + 2, y + h - 2, 8, 1, WD); px(x + 2, y + h - 2, 3, 1, WD_LIT); keyEdge(x + 2, y + h - 2, 2, 1, 0.18);
    px(x + 2, y + h - 1, 8, 1, '#0a0d10');
    // TURNED COLUMN — with two collars. The collars are what make a stem read as turned timber rather
    // than as a pipe, and they cost two rows.
    px(x + 4, top + 1, 4, 8, LINE);
    px(x + 5, top + 1, 1, 8, WD_LIT); px(x + 6, top + 1, 1, 8, WD_DK);
    keyEdge(x + 5, top + 2, 1, 5, 0.18); rimEdge(x + 6, top + 2, 1, 6, 0.18);
    // ONE collar, and a NARROW one. A first pass gave it two 6px-wide collars and the prop read as a
    // three-tier cake stand: any horizontal that approaches the cap's own width becomes another tabletop.
    px(x + 4, top + 4, 4, 1, WD); px(x + 4, top + 4, 2, 1, WD_LIT);
    px(x + 4, top + 5, 4, 1, U.shade(WD_DK, -0.30));
    underAO(x + 3, top + 2, 6, 2);
    // the ROUND top: three rows whose insets trace a circle inside a 10px span, so it stays in its tile
    const dsk = [3, 1, 1];
    dsk.forEach((i, j) => px(x + i, top - 1 + j, 10 - i * 2 + 2, 1, LINE));
    dsk.forEach((i, j) => px(x + 1 + i, top - 1 + j, 10 - i * 2, 1, j === 0 ? WD_LIT : WD));
    px(x + 4, top - 1, 4, 1, U.shade(WD_LIT, 0.16)); keyEdge(x + 4, top - 1, 3, 1, 0.26);   // lit back arc
    px(x + 2, top + 1, 8, 1, U.shade(WD_DK, 0.10));               // the top's front lip, in its own shade
    rimEdge(x + 9, top, 1, 1, 0.20);
  };

  F.loungetable = (x, y, w, h, f) => {
    // 2x1 low COFFEE TABLE — chamfered glass top over a steel frame, with a real under-shelf.
    // The shelf is what separates it from the long table at a glance: two horizontal planes, not one.
    // v6: the top was authored as SMOKED glass at #2b3540 over a LINE-black surround, which at 12px is
    // indistinguishable from a hole in the deck — the prop read as an open pit with a white pill in it.
    // Glass at this size cannot be sold by darkness; it is sold by a bright LEADING EDGE, one broad
    // specular streak, and the shelf being VISIBLE THROUGH it. So the pane is lifted two stops and the
    // shelf's front rail is redrawn over it at low alpha, which is the actual cue that it is transparent.
    const r = RAMP.steel, top = y + h - 1 - SURFACE_RISE;
    // Two stops up from v4's #2b3540 hole, but no further: a first correction pushed the pane to a
    // near-uniform #41505e and it read as a CLOSED LAPTOP. Glass is a dark field with a bright rim.
    const GLS = '#35434f', GLS_LIT = '#93a8b8';
    shadow2(x + 1, y + h - 1, w - 2);
    // LEGS: four, not two. The pair-only version left the whole region under the pane unpainted, and
    // with underAO over it the table read as a slab floating on a black hole. The rear pair is drawn
    // first, thinner and cooler, so the frame has depth without competing with the front pair.
    for (const lx of [x + 4, x + w - 6]) {
      px(lx, top + 2, 1, 5, U.shade(r.face, -0.20)); rimEdge(lx, top + 2, 1, 4, 0.16);
    }
    for (const lx of [x + 2, x + w - 4]) {                        // front leg pair
      px(lx - 1, top + 3, 4, 6, LINE);
      px(lx, top + 3, 1, 6, r.lit); px(lx + 1, top + 3, 1, 6, r.dk);
      rimEdge(lx + 1, top + 3, 1, 6, 0.18);
      px(lx, top + 8, 2, 1, r.ao);
    }
    underAO(x + 5, top + 3, w - 10, 3);
    px(x + 2, top + 5, w - 4, 2, LINE);                           // UNDER-SHELF
    px(x + 3, top + 5, w - 6, 1, U.shade(r.face, 0.22)); keyEdge(x + 3, top + 5, 5, 1, 0.16);
    px(x + 3, top + 6, w - 6, 1, U.shade(r.face, -0.14));
    // stacked on the shelf: two datapads, muted. v4 put ONE at #8a8272 which read as a bare white pill.
    px(x + 5, top + 4, 7, 1, '#5d6b63'); px(x + 5, top + 4, 4, 1, '#7a8a80');
    px(x + 6, top + 3, 6, 1, '#4a5a66'); px(x + 6, top + 3, 3, 1, '#647686');
    // GLASS PANE — chamfered, lifted well clear of the deck value so it reads as a surface, not a void
    chamf(x, top - 3, w, 6, LINE, 2);
    chamf(x + 1, top - 2, w - 2, 4, GLS, 1);
    px(x + 2, top - 2, w - 4, 1, GLS_LIT); keyEdge(x + 3, top - 2, 9, 1, 0.30);   // the bright leading edge
    px(x + 3, top - 1, 7, 1, U.shade(GLS_LIT, -0.40));            // ONE short specular streak, static
    ctx.globalAlpha = 0.46;                                       // the shelf, SEEN THROUGH the pane —
    px(x + 4, top, w - 8, 1, '#93a2ae');                          // this is the cue that sells glass
    px(x + 6, top - 1, 6, 1, '#5f6f7c');
    ctx.globalAlpha = 1;
    px(x + 1, top + 1, w - 2, 1, U.shade(GLS, -0.34));
    px(x + 2, top + 2, w - 4, 1, U.shade(GLS, -0.10));            // the pane's own edge thickness, LIT
    rimEdge(x + w - 2, top - 1, 1, 3, 0.22);
  };

  F.longtable = (x, y, w, h, f) => {
    // 3x1 TRESTLE table — heavy warm timber on two A-frame trestles with a stretcher between them.
    // This is the mess/briefing table: the cross-braces are the silhouette and they read at any zoom.
    // v6 keeps the whole scheme (it was the one table that already read) and only deepens it: the plank
    // seam gets a lit lip so the top reads as TWO boards rather than one painted line, the ends get
    // end-grain caps, and the trestles get feet so they stop floating a pixel off the deck.
    const WD = '#5c4732', WD_LIT = '#7a6044', WD_DK = '#3a2c1e';
    const top = y + h - 1 - SURFACE_RISE;
    shadow2(x + 2, y + h - 1, w - 4);
    for (const tx of [x + 4, x + w - 7]) {                        // two trestles, splayed
      px(tx, top + 3, 1, 6, LINE); px(tx + 2, top + 3, 1, 6, LINE);
      px(tx, top + 3, 1, 6, WD_DK); px(tx + 2, top + 3, 1, 6, WD_DK);
      px(tx - 1, top + 8, 5, 1, LINE);
      px(tx - 1, top + 8, 4, 1, WD); keyEdge(tx - 1, top + 8, 2, 1, 0.14);   // foot rail
      px(tx - 1, top + 9, 5, 1, '#0a0d10');                       // the foot's own contact, not a float
      px(tx, top + 5, 3, 1, WD_LIT);                              // the trestle's own cross-brace
    }
    px(x + 5, top + 6, w - 11, 1, WD_DK);                         // stretcher tying the trestles together
    px(x + 5, top + 6, 4, 1, U.shade(WD_DK, 0.16));
    underAO(x + 6, top + 3, w - 12, 4);
    // PLANK top — the plank seams are what say timber; they run the length, never across
    px(x - 1, top - 3, w + 2, 6, LINE);
    px(x, top - 2, w, 4, WD);
    px(x, top - 2, w, 1, WD_LIT); keyEdge(x + 1, top - 2, 10, 1, 0.24);
    px(x, top, w, 1, U.shade(WD, -0.34));                         // seam between the two boards, cut deep
    px(x, top + 1, w, 1, U.shade(WD, 0.14));                      // ...and the south board's own lit lip
    px(x, top + 2, w, 1, WD_DK);                                  // the top's front edge thickness
    px(x, top - 2, 1, 4, WD_LIT); px(x + w - 1, top - 2, 1, 4, WD_DK);
    for (const ex of [x, x + w - 2]) px(ex, top - 1, 2, 1, U.shade(WD, -0.20));   // end-grain caps
    rimEdge(x + w - 1, top - 2, 1, 4, 0.20);
    // GRAIN — clamped to the top's own width. An unclamped run put a 3px plank stub OUT past the east
    // edge, which reads as the table being broken, not as grain. Never let a decorative loop run past w.
    for (let i = 0; i < 5; i++) { const gx = x + 3 + i * 8; if (gx + 4 <= x + w) px(gx, top - 1, 4, 1, U.shade(WD, 0.08)); }
    for (let i = 0; i < 4; i++) { const gx = x + 7 + i * 9; if (gx + 3 <= x + w) px(gx, top + 1, 3, 1, U.shade(WD, 0.06)); }
  };
  /* ============ DETAIL-PASS PROPS (auto-generated) ============ */
  F.bridge_tacscreen = (x, y, w, h, f) => {   // v4 TAC SCREEN (2x1) — the bridge's HOODED wireframe monitor
    // The three bridge props share the room's red and must still be told apart in silhouette alone:
    //   tacscreen  = a wide board with a jutting GLARE HOOD, lit by thin VECTOR LINES (no filled panel)
    //   pylon      = a tall narrow column lit by ONE vertical slot
    //   orderqueue = a low cabinet with NO screen at all, lit by cards floating in the air above it
    // So this one leans all the way into "vector radar": the emissive area is line art on near-black glass,
    // the hood casts a hard shadow band over the top of that glass, and the red bleeds out under the hood
    // onto the bezel. f.work brightens the trace and speeds the readout crawl.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const RED = '#ff4a3d', HOT = '#ff9d8e';
    shadow2(x + 2, y + h - 1, w - 4);
    // rolling posts with splayed feet + a tie-collar so the board never floats off them
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx - 1, y + 5, 4, h - 6, LINE);
      px(pxx, y + 6, 1, h - 8, r.lit); px(pxx + 1, y + 6, 1, h - 8, r.dk);
      rimEdge(pxx + 2, y + 6, 1, h - 8, 0.18);
      chamf(pxx - 4, y + h - 4, 10, 3, LINE, 1);
      px(pxx - 3, y + h - 3, 8, 1, r.face); px(pxx - 3, y + h - 3, 8, 1, r.lit);
      px(pxx - 3, y + h - 2, 8, 1, r.ao);
      px(pxx - 2, y + h - 1, 2, 1, '#1a1e22'); px(pxx + 2, y + h - 1, 2, 1, '#1a1e22');
      ctx.globalAlpha = 0.30; px(pxx - 4, y + h, 10, 1, '#000'); ctx.globalAlpha = 1;
      px(pxx, y + 4, 2, 2, U.shade(r.top, 0.16));
    }
    // chamfered carcass
    chamf(x - 1, y - 6, w + 2, 14, LINE, 2);
    chamf(x, y - 5, w, 12, r.face, 2);
    px(x + 2, y - 5, w - 4, 1, r.top);
    px(x, y - 3, 1, 8, r.lit); px(x + w - 1, y - 3, 1, 8, r.dk); rimEdge(x + w - 1, y - 3, 1, 8, 0.22);
    px(x + 2, y + 6, w - 4, 1, r.ao);
    // GLARE HOOD jutting south over the glass — this prop's silhouette tell, and a hard shadow on the screen
    chamf(x - 2, y - 9, w + 4, 4, LINE, 2);
    chamf(x - 1, y - 8, w + 2, 3, r.top, 2);
    px(x + 1, y - 8, w - 2, 1, r.sheen); keyEdge(x + 1, y - 8, 7, 1, 0.30);
    px(x + 1, y - 6, w - 2, 1, U.shade(r.top, -0.34));              // hood's underside lip
    for (const cx4 of [x + 1, x + w - 3]) { px(cx4, y - 6, 2, 3, U.shade(r.face, -0.20)); px(cx4, y - 6, 1, 3, r.dk); } // hood cheeks
    // recessed glass well, hood shadow raked across its top two rows
    const sx = x + 3, sy = y - 4, sw = w - 6, sh2 = 9;
    inset(sx - 1, sy - 1, sw + 2, sh2 + 2, '#080a0c');
    px(sx, sy, sw, sh2, on ? '#100809' : '#0c0708');                // idle glass keeps a red bias, not a black hole
    ctx.globalAlpha = 0.55; px(sx, sy, sw, 2, '#000'); ctx.globalAlpha = 1;
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now / 1000));  // wireframe pulse (kept)
    // STATION DECK-PLAN WIREFRAME (kept 1:1) — hull, left deck, spine, cross corridor
    ctx.save();
    ctx.globalAlpha = (on ? 0.85 : 0.45) * pulse;
    ctx.strokeStyle = RED; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(sx + 1.5, sy + 1.5, sw - 4, sh2 - 5);
    ctx.rect(sx + 3.5, sy + 3.5, Math.max(2, (sw - 8) / 2 - 1), Math.max(2, sh2 - 9));
    ctx.moveTo(sx + sw / 2, sy + 2); ctx.lineTo(sx + sw / 2, sy + sh2 - 4);
    ctx.moveTo(sx + 2, sy + sh2 / 2); ctx.lineTo(sx + sw - 3, sy + sh2 / 2);
    ctx.stroke();
    ctx.restore();
    // vertex ticks where the wireframe corners land — vector sets read as PLOTTED when the nodes show
    for (const [vx, vy] of [[sx + 1, sy + 1], [sx + sw - 3, sy + 1], [sx + 1, sy + sh2 - 4], [sx + sw - 3, sy + sh2 - 4]])
      px(vx, vy, 1, 1, blink(900, vx + ph) ? HOT : U.shade(RED, -0.35));
    // three scrolling tactical readout bars (kept), now with falloff instead of flat glow
    for (let r2 = 0; r2 < 3; r2++) {
      const by = sy + sh2 - 4 + r2;
      if (by > sy + sh2 - 2) break;
      const scroll = Math.floor(now / ((on ? 60 : 90) + r2 * 40)) % sw;
      const bw = 2 + (U.hash('tac' + r2) % 4);
      const bx = sx + ((scroll + r2 * 5) % Math.max(1, sw - bw - 1));
      bloom(bx, by, bw, 1, RED, (on ? 0.55 : 0.30) * pulse);
    }
    const dotOn = blink(1400);                                      // slow status dot, lower-right (kept)
    px(sx + sw - 3, sy + sh2 - 3, 2, 2, dotOn ? RED : '#3a1714');
    if (dotOn) bloom(sx + sw - 3, sy + sh2 - 3, 2, 2, RED, on ? 0.42 : 0.26);
    scanl(sx, sy, sw, sh2, 0.20);
    bloom(sx, sy, sw, sh2, RED, (on ? 0.10 : 0.05) * pulse);
    spill(x + 2, y + 7, w - 4, RED, on ? 0.16 : 0.09, 4);           // screen light running down onto the posts
  };
  F.bridge_relaystack = (x, y, w, h, f) => {   // v4 relay stack (1x2) — memory family, told apart by a FIBRE PATCH panel
    // core is a sealed glowing tube and the servercart is a small rolling box; this one is the one you PATCH: a
    // port field with jumper leads looped across its face, under a chasing purple load column.
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 5, w + 2, 5);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + h - 8, x + w + 2, y + h - 3, 2);
    // antenna nub at the crown (kept) — rises above the cabinet
    px(x + w - 5, y - 8, 1, 4, r.dk); px(x + w - 5, y - 8, 1, 1, r.lit);
    px(x + w - 7, y - 9, 4, 1, r.face); px(x + w - 7, y - 9, 4, 1, r.lit);
    px(x + w - 4, y - 10, 1, 1, blink(900) ? ACC.alert : U.shade(ACC.alert, -0.6));
    if (blink(900)) bloom(x + w - 4, y - 10, 1, 1, ACC.alert, 0.34);
    // TALL 3/4 slab + cap
    chamf(x - 1, y - 3, w + 2, h + 2, LINE, 2);
    chamf(x, y - 2, w, h, r.face, 2);
    px(x, y, 1, h - 5, U.shade(r.face, 0.12)); px(x + w - 1, y, 1, h - 5, r.dk);
    rimEdge(x + w - 1, y + 1, 1, h - 7, 0.22);
    chamf(x - 1, y - 6, w + 2, 4, LINE, 1);
    px(x, y - 5, w, 2, r.top); px(x, y - 5, w, 1, r.sheen);
    keyEdge(x, y - 5, 5, 1, 0.30);
    px(x, y - 3, w, 1, U.shade(r.top, -0.24));
    // top vent slit bleeding purple (kept behaviour, now with falloff)
    inset(x + 3, y, w - 6, 2, '#12081c');
    bloom(x + 3, y, w - 6, 2, ACC.mem, 0.10 + 0.06 * Math.sin(now / 600));
    // ---- FIBRE PATCH PANEL: eight ports, and real jumper leads looped between them
    const pTop = y + 4;
    inset(x + 2, pTop, w - 5, 7, '#141b18');
    px(x + 3, pTop, w - 7, 1, U.shade(r.face, 0.14)); keyEdge(x + 3, pTop, 4, 1, 0.16);
    const ports = [];
    for (let row = 0; row < 2; row++) for (let c = 0; c < 4; c++) {
      const pxx = x + 3 + c * 2, pyy = pTop + 2 + row * 3;
      px(pxx, pyy, 1, 2, '#0a0f12');                                  // the port well
      const lit = blink(1100 + c * 190, row * 1.3 + c + ph);
      px(pxx, pyy, 1, 1, lit ? ACC.mem : U.shade(ACC.mem, -0.6));
      if (lit) bloom(pxx, pyy, 1, 1, ACC.mem, 0.26);
      ports.push([pxx, pyy]);
    }
    cable(x + 3, pTop + 2, x + 7, pTop + 5, 2.4, '#241436');          // jumper leads breaking the flat face
    cable(x + 5, pTop + 2, x + 9, pTop + 5, 1.8, '#1c1030');
    // horizontal seams + amber/purple status pairs lower on the body (kept blink pattern)
    for (let s = 0; s < 3; s++) { px(x + 2, y + 13 + s * 3, w - 4, 1, r.ao); px(x + 2, y + 14 + s * 3, w - 4, 1, U.shade(r.face, 0.08)); }
    for (let ri = 0; ri < 2; ri++)
      px(x + 3, y + 13 + ri * 3, 2, 1, blink(1300, ri * 0.7 + 1) ? ACC.flow : '#33271a');
    // EMISSIVE ACCENT: the purple load column chasing upward like a loading bar (preserved)
    const N = 6, lit = Math.floor((now / 130) % (N + 1));
    for (let i = 0; i < N; i++) {
      const ly = y + h - 6 - i * 2, isOn = (N - i) <= lit;
      px(x + w - 4, ly, 2, 1, isOn ? ACC.mem : U.shade(ACC.mem, -0.6));
      if (isOn) { px(x + w - 4, ly, 1, 1, '#e0b8ff'); bloom(x + w - 4, ly, 2, 1, ACC.mem, 0.28); }
    }
    px(x + 1, y, 1, 1, r.sheen); px(x + w - 2, y, 1, 1, r.sheen);      // corner bolts
    px(x + 1, y + h - 3, w - 2, 1, r.ao);                             // floor-line AO
    if (on) spill(x + 1, y + h - 4, w - 2, ACC.mem, 0.13, 3);
  };
  F.bridge_dispatch_pylon = (x, y, w, h, f) => {   // v4 DISPATCH PYLON (1x2) — one tall SLOT of light, nothing else
    // Deliberately the thinnest emissive in the family: a single full-height dispatch slot recessed in a
    // chamfered column, so at 3x it reads as a vertical BAR while the tacscreen reads as a rectangle and the
    // orderqueue reads as floating slabs. The slot is a real light PIPE — a hot core, a dimmer surround and
    // spill onto the banding it crosses — and orders travel UP it as brighter packets when a run is live.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const RED = '#ff4a3d', HOT = '#ff8a78';
    const cx = x + w / 2, icx = Math.floor(cx);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 5, w + 2, 5);                          // the pylon is bolted; the boards roll
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + h - 9, x + w + 2, y + h - 3, 2);
    // splayed base shoe
    chamf(x - 2, y + h - 6, w + 4, 5, LINE, 2);
    px(x - 1, y + h - 5, w + 2, 3, r.face); px(x - 1, y + h - 5, w + 2, 1, r.lit);
    keyEdge(x, y + h - 5, w, 1, 0.16);
    px(x - 1, y + h - 3, w + 2, 1, r.ao);
    // TALL 3/4 chamfered column + a cap we look down on
    chamf(x - 1, y - 3, w + 2, h - 2, LINE, 2);
    chamf(x, y - 2, w, h - 4, r.face, 2);
    px(x, y, 1, h - 8, U.shade(r.face, 0.12)); px(x + w - 1, y, 1, h - 8, r.dk);
    rimEdge(x + w - 1, y + 1, 1, h - 10, 0.22);
    chamf(x - 1, y - 6, w + 2, 4, LINE, 1);
    px(x, y - 5, w, 2, r.top); px(x, y - 5, w, 1, r.sheen); keyEdge(x, y - 5, 5, 1, 0.30);
    px(x, y - 3, w, 1, U.shade(r.top, -0.24));                      // cap lip ties cap to column
    // two beveled bands (kept) — the slot crosses them, which is what makes it read as recessed
    for (const by of [y + 1, y + h - 10]) {
      px(x, by, w, 3, U.shade(r.face, 0.14));
      px(x, by, w, 1, r.lit); keyEdge(x + 1, by, w - 3, 1, 0.16);
      px(x, by + 2, w, 1, r.ao);
      px(x + 1, by + 1, 1, 1, r.sheen); px(x + w - 2, by + 1, 1, 1, r.ao);   // rivets
    }
    wear(x + 1, y + 5, w - 2, h - 17, 3, U.shade(r.face, -0.12));
    // CROWN: rotating scan head on a stubby mast (kept sweep behaviour), tied down so it doesn't float
    px(icx - 1, y - 8, 3, 3, LINE); px(icx - 1, y - 8, 1, 3, r.lit); px(icx + 1, y - 8, 1, 3, r.dk);
    chamf(icx - 3, y - 10, 7, 3, LINE, 1);
    px(icx - 2, y - 9, 5, 2, r.top); px(icx - 2, y - 9, 5, 1, r.sheen);
    const sweep = Math.sin(now / 1300);
    const bx2 = icx + Math.round(sweep * 3);
    px(bx2, y - 11, 1, 1, on ? HOT : RED);
    bloom(bx2, y - 11, 1, 1, RED, on ? 0.44 : 0.26);
    ctx.globalAlpha = 0.16; px(Math.min(icx, bx2), y - 11, Math.abs(bx2 - icx) || 1, 1, RED); ctx.globalAlpha = 1; // beam trace
    // THE SLOT — a light pipe down the column's centre line, with real falloff into the casing
    const slotX = icx - 1, slotY = y + 5, slotH = h - 17;
    inset(slotX - 2, slotY - 2, 6, slotH + 4, '#201210');
    px(slotX - 1, slotY - 1, 4, slotH + 2, '#12090a');              // the well behind the diffuser
    const pl = on ? 0.55 + 0.45 * Math.abs(Math.sin(now / 480)) : 0.20 + 0.06 * Math.sin(now / 1400);
    px(slotX, slotY, 2, slotH, U.shade(RED, on ? -0.04 : -0.34));   // idle slot stays a dim ember, never black
    px(slotX, slotY, 1, slotH, U.shade(RED, 0.16));                 // west edge of the pipe catches more
    bloom(slotX, slotY, 2, slotH, RED, pl * 0.55);
    for (let i = 0; i < 3; i++) {                                   // ORDERS travelling up the pipe
      const t = ((now / (on ? 520 : 1500) + i * 0.34) % 1);
      const py2 = slotY + slotH - 2 - Math.round(t * (slotH - 2));
      px(slotX, py2, 2, 1, on ? '#ffd9d2' : U.shade(RED, 0.10));
      bloom(slotX, py2, 2, 1, RED, (on ? 0.40 : 0.18) * (1 - t * 0.6));
    }
    if (on && blink(480)) px(slotX, slotY, 2, slotH, HOT);          // hot core when dispatching (kept)
    spill(x + 1, slotY + slotH + 1, w - 2, RED, on ? 0.20 : 0.10, 4);  // slot light pooling down the shoe
    px(x + 2, y + h - 8, 2, 1, blink(on ? 420 : 1600, ph) ? ACC.flow : '#33271a');   // dispatch-ready lamp
  };
  F.bridge_orderqueue = (x, y, w, h, f) => {   // v4 ORDER QUEUE (2x1) — the family's only prop with NO screen in it
    // Its whole emissive lives in MID-AIR: a low top-bias-oblique projector cabinet you look down on, a recessed
    // emitter trough in its top, and a stack of order-cards floating above with real perspective (the far card
    // is narrower and dimmer than the near one). Everything below the cards is dark metal, which is what makes
    // this instantly separable from the tacscreen's framed rectangle and the pylon's vertical bar.
    // f.work = orders are actually flowing -> faster cycle, brighter cone, a fourth card in the stack.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const RED = '#ff4a3d', HOT = '#ff7a6c', PAPER = '#ffd9d2';
    const cx = x + Math.floor(w / 2);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x + 1, y + h - 4, w - 2, 4);
    deckSocket(x - 3, y + h - 3, on);
    cable(x + 2, y + 8, x - 3, y + h - 3, 2);
    for (const lx of [x + 2, x + w - 5]) {                          // stubby feet on the plate
      px(lx, y + h - 5, 3, 3, LINE); px(lx, y + h - 5, 1, 3, r.lit); px(lx + 1, y + h - 5, 1, 3, r.dk);
    }
    underAO(x + 5, y + h - 5, w - 10, 2);
    // short vented south face (kept vents + status LED)
    chamf(x - 1, y + 5, w + 2, 7, LINE, 2);
    px(x, y + 6, w, 4, r.face);
    px(x, y + 6, w, 1, r.lit); keyEdge(x + 1, y + 6, w - 3, 1, 0.15);
    px(x, y + 6, 1, 4, U.shade(r.face, 0.08)); px(x + w - 1, y + 6, 1, 4, r.dk);
    rimEdge(x + w - 1, y + 6, 1, 4, 0.20);
    for (let i = 0; i < (w - 8) / 6; i++) {
      px(x + 4 + i * 6, y + 7, 1, 2, r.ao); px(x + 5 + i * 6, y + 7, 1, 2, U.shade(r.face, 0.14));
    }
    px(x, y + 9, w, 1, r.ao);
    px(x + 2, y + 7, 1, 1, (on ? blink(420, ph) : blink(1600, ph)) ? HOT : '#3a1c1a');   // status LED (kept)
    // TOP SURFACE we look down on, with the emitter trough sunk into it
    chamf(x - 1, y - 1, w + 2, 7, LINE, 2);
    chamf(x, y, w, 6, r.top, 2);
    px(x + 2, y, w - 4, 1, r.sheen); keyEdge(x + 2, y, 7, 1, 0.28);
    px(x, y + 2, 1, 3, r.lit); px(x + w - 1, y + 2, 1, 3, r.dk); rimEdge(x + w - 1, y + 2, 1, 3, 0.20);
    px(x + 2, y + 5, w - 4, 1, U.shade(r.top, -0.20));
    wear(x + 2, y + 1, w - 4, 4, 3, U.shade(r.top, -0.10));
    const tx = x + 4, tw = w - 8;
    px(tx - 1, y, tw + 2, 4, '#141013');                            // trough surround
    px(tx, y + 1, tw, 2, '#23181a');
    px(tx, y + 1, tw, 1, U.shade(r.top, -0.50));                    // shadow at the back of the trough
    px(cx - 3, y + 2, 6, 1, HOT);                                   // the emitter slit itself (kept)
    bloom(cx - 3, y + 2, 6, 1, RED, 0.22 + 0.10 * Math.abs(flick(1300)));
    for (const lx of [tx + 1, tx + tw - 2]) px(lx, y + 2, 1, 1, blink(700, lx + ph) ? RED : '#3a1c1a'); // lens pilots
    // PROJECTOR CONE rising from the trough — brighter and tighter while orders flow
    const coneTop = y - 13;
    ctx.save();
    ctx.globalAlpha = (on ? 0.14 : 0.09) + 0.05 * Math.abs(flick(1300));
    ctx.fillStyle = RED;
    ctx.beginPath();
    ctx.moveTo(cx, y + 2); ctx.lineTo(x + 3, coneTop); ctx.lineTo(x + w - 3, coneTop); ctx.closePath();
    ctx.fill();
    ctx.restore();
    // THE STACK — cards floating in the cone. Perspective: the far card is narrower, dimmer and thinner.
    const PERIOD = on ? 1800 : 2600;
    const phase = (now % PERIOD) / PERIOD;
    const rise = Math.floor(phase * 3);
    const bob = Math.round(Math.sin(now / 800));
    const NC = on ? 4 : 3;
    for (let c = 0; c < NC; c++) {
      const inset2 = c;                                             // higher cards sit further away -> narrower
      const cardX = x + 4 + inset2, cardW = w - 8 - inset2 * 2;
      const cy = coneTop + 1 + (NC - 1 - c) * 5 + bob - (c === NC - 1 ? rise : 0);
      if (cy < y - 18 || cardW < 4) continue;
      let a2 = 0.88 - c * 0.14;
      if (c === NC - 1) a2 *= (1 - phase * 0.7);
      ctx.save();
      ctx.globalAlpha = Math.max(0, a2);
      px(cardX, cy, cardW, 4, RED);
      px(cardX, cy, cardW, 1, HOT);                                 // bright top edge
      px(cardX, cy + 3, cardW, 1, '#c2241a');                       // darker base edge
      px(cardX, cy + 1, 1, 2, '#ffb0a6');                           // west edge catch — gives the card thickness
      const scroll = Math.floor(now / 110);                         // the order's text scrolling across it
      for (let g = 0; g < cardW - 2; g += 2)
        if (((g + scroll + c * 3) >> 1) % 3 !== 0) px(cardX + 1 + g, cy + 1, 1, 1, PAPER);
      px(cardX + 1, cy + 2, Math.max(1, Math.floor(cardW * 0.4)), 1, '#ff9d8e');   // a priority underline
      ctx.restore();
      if (c === 0) bloom(cardX, cy, cardW, 4, RED, 0.16);           // only the NEAREST card blooms
    }
    if (phase > 0.6) {                                              // fresh card glinting up out of the slit (kept)
      const fy2 = y + 1 - Math.floor((phase - 0.6) * 8);
      bloom(cx - 3, fy2, 6, 2, HOT, 0.45 * (phase - 0.6) / 0.4);
    }
    spill(x + 3, y - 1, w - 6, RED, on ? 0.16 : 0.09, 4);           // card light falling back onto the cabinet top
  };
  F.research_corelens = (x, y, w, h, f) => { // v4 core lens (1x2) — bolted optics column; the lens is its ONLY light
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x, y + h - 1, w);
    deckPlate(x - 2, y + h - 4, w + 4, 4);                      // bolted to the deck like the rest of the bench
    deckSocket(x + w + 2, y + h - 3, on);
    cable(x + w - 2, y + h - 6, x + w + 2, y + h - 3, 1.6);
    // flared foot
    chamf(x - 1, y + h - 9, w + 2, 6, LINE, 1);
    px(x, y + h - 8, w, 4, r.face); px(x, y + h - 8, w, 1, r.lit); keyEdge(x + 1, y + h - 8, 4, 1, 0.18);
    px(x + w - 1, y + h - 7, 1, 3, r.dk); rimEdge(x + w - 1, y + h - 7, 1, 3, 0.20);
    px(x, y + h - 5, w, 1, r.ao);
    // full-height column — cylindrical read: lit west band, shaded east band, cool bounce on the shade edge
    chamf(x, y - 6, w, 22, LINE, 2);
    px(x + 1, y - 5, w - 2, 20, r.face);
    px(x + 1, y - 5, 2, 20, r.lit); keyEdge(x + 1, y - 4, 1, 10, 0.16);
    px(x + w - 3, y - 5, 2, 20, r.dk); rimEdge(x + w - 2, y - 4, 1, 14, 0.20);
    // domed cap
    chamf(x, y - 9, w, 4, LINE, 1);
    px(x + 1, y - 8, w - 2, 1, r.sheen); keyEdge(x + 1, y - 8, 4, 1, 0.28);
    px(x + 1, y - 7, w - 2, 2, r.top); px(x + 1, y - 6, w - 2, 1, U.shade(r.top, -0.24));
    // recessed lens housing (kept: concentric arcs, sweep, pupil spec)
    const lensTop = y - 4, lensH = 13;
    inset(x + 1, lensTop, w - 2, lensH, '#10161a');
    px(x + 1, lensTop, w - 2, 1, U.shade(r.face, -0.55));      // hood shadow into the top of the well
    const lcx = x + w / 2, lcy = lensTop + lensH / 2, R = (w - 5) / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(x + 2, lensTop + 1, w - 4, lensH - 2); ctx.clip();
    for (let cr = R; cr >= 1.2; cr -= 1.2) {
      const t = cr / R;
      ctx.beginPath();
      ctx.strokeStyle = U.shade(ACC.data, -0.48 + 0.40 * (1 - t));
      ctx.globalAlpha = (on ? 1 : 0.62) * (0.35 + 0.4 * (1 - t));
      ctx.arc(lcx, lcy, cr, 0, 6.2832); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.fillStyle = '#1f6b80'; ctx.arc(lcx, lcy, Math.max(1.5, R * 0.4), 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = '#0e3540'; ctx.arc(lcx, lcy, 1, 0, 6.2832); ctx.fill();
    const sweep = (now / 2000 + ph * 0.11) % 1;                // scan sweep (kept)
    const sy2 = Math.round(lensTop + 1 + sweep * (lensH - 2));
    ctx.globalAlpha = 0.20; px(x + 2, sy2 - 3, w - 4, 4, ACC.data); ctx.globalAlpha = 1;
    px(x + 2, sy2, w - 4, 1, '#bff0ff');
    ctx.globalAlpha = 0.42; px(x + 2, sy2, w - 4, 2, ACC.data); ctx.globalAlpha = 1;
    ctx.restore();
    px(Math.round(lcx) - 1, Math.round(lcy) - 1, 1, 1, '#cdeeff');   // pupil spec (kept)
    bloom(x + 2, lensTop + 1, w - 4, lensH - 2, ACC.data, on ? 0.15 : 0.08);
    spill(x + 1, lensTop + lensH, w - 2, ACC.data, on ? 0.20 : 0.10, 4);  // lens light pools down the column
    // instrument collar + the amber hardware LEDs the whole research bench shares (kept 520)
    px(x + 1, y + 10, w - 2, 2, U.shade(r.face, -0.30)); px(x + 1, y + 10, w - 2, 1, U.shade(r.top, 0.10));
    knurl(x + 2, y + 11, w - 4, 1, r.face);
    for (let i = 0; i < 2; i++) {
      const lx2 = i ? x + w - 4 : x + 2, lit = blink(520, i);
      px(lx2, y + 13, 2, 2, lit ? '#ffb347' : '#5a3f1a');
      if (lit) bloom(lx2, y + 13, 2, 2, '#ffb347', 0.24);
    }
    px(x + 2, y + 15, w - 4, 1, r.dk); px(x + 2, y + 16, w - 4, 1, U.shade(r.face, 0.14)); // lower seam (kept)
    bloom(x, y + h - 6, w, 3, ACC.data, (on ? 0.14 : 0.08) + 0.04 * Math.sin(now / 600 + ph)); // floor bleed (kept)
  };
  F.research_trendpillar = (x, y, w, h, f) => { // v4 trend totem (1x2) — a hooded strip chart, same bench hardware
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x, y + h - 1, w);
    deckPlate(x - 2, y + h - 4, w + 4, 4);
    deckSocket(x + w + 2, y + h - 3, on);
    cable(x + w - 2, y + h - 6, x + w + 2, y + h - 3, 1.6);
    // pedestal foot with the vent + status LED (kept 2200)
    chamf(x - 1, y + h - 10, w + 2, 7, LINE, 1);
    px(x, y + h - 9, w, 5, r.face); px(x, y + h - 9, w, 1, r.lit); keyEdge(x + 1, y + h - 9, 4, 1, 0.18);
    px(x + w - 1, y + h - 8, 1, 4, r.dk); rimEdge(x + w - 1, y + h - 8, 1, 4, 0.20);
    px(x, y + h - 5, w, 1, r.ao);
    inset(x + 2, y + h - 7, w - 4, 3, '#10161a');
    for (let i = 0; i < 3; i++) px(x + 3 + i * 2, y + h - 6, 1, 1, U.shade(r.face, -0.5));  // vent slots
    px(x + 3, y + h - 6, 1, 1, blink(2200) ? ACC.work : '#1c2a22');
    if (blink(2200)) bloom(x + 3, y + h - 6, 1, 1, ACC.work, 0.26);
    // slab body, full height, chamfered cap — two temperatures down the flanks
    chamf(x, y - 7, w, 23, LINE, 2);
    px(x + 1, y - 6, w - 2, 21, r.face);
    px(x + 1, y - 6, w - 2, 1, r.sheen); keyEdge(x + 1, y - 6, 4, 1, 0.28);
    px(x + 1, y - 5, 1, 20, r.lit); px(x + w - 2, y - 5, 1, 20, r.dk);
    rimEdge(x + w - 2, y - 4, 1, 16, 0.20);
    // a real HOOD over the screen — the totem needs a brow or the display floats on a bare slab
    px(x, y - 5, w, 2, LINE); px(x + 1, y - 5, w - 2, 1, r.top); keyEdge(x + 1, y - 5, 5, 1, 0.24);
    px(x + 1, y - 3, w - 2, 1, U.shade(r.face, -0.5));         // the hood's shadow onto the glass
    // vertical strip display (kept: dual charts, ticker, drifting scan)
    const scX = x + 1, scW = w - 2, scY = y - 3, scH = h - 11;
    inset(scX, scY, scW, scH, '#0a1416');
    ctx.save();
    ctx.beginPath(); ctx.rect(scX + 1, scY + 1, scW - 2, scH - 2); ctx.clip();
    const gX = scX + 1, gW = scW - 2, gTop = scY + 2, gH = scH - 4;
    px(gX, gTop, gW, gH, '#08171b');                           // idle glass keeps phosphor, never a hole
    const dimA = on ? 1 : 0.45, tk = Math.floor(now / 110);
    for (let i = 0; i < gW; i++) {
      const s = U.hash('trend' + ((i + tk) % 64));
      const cy3 = gTop + gH - 2 - (i / gW) * (gH - 4) - (s % 5) + 2;
      ctx.globalAlpha = dimA;
      px(gX + i, cy3, 1, 1, ACC.data);
      if (i > 0) px(gX + i, cy3 + 1, 1, 1, U.shade(ACC.data, -0.45));   // the series' own shadow under it
      ctx.globalAlpha = dimA * 0.85;
      px(gX + i, gTop + gH - 1 - (i / gW) * (gH - 8) * 0.6 - (U.hash('curie' + ((i + tk) % 64)) % 3), 1, 1, '#8f7bff');
      ctx.globalAlpha = 1;
    }
    const tick = Math.floor(now / 240) % 9;                    // crawling ticker (kept)
    for (let rw = 0; rw < gH; rw += 3) {
      const yy = gTop + ((rw + tick) % gH);
      const v = U.hash('pct' + rw + (Math.floor(now / 700) % 7)) % 99;
      ctx.globalAlpha = dimA * 0.5;
      px(gX + 1, yy, 1, 1, v % 2 ? ACC.work : '#ff6a6a');
      px(gX + 3 + (v % 3), yy, 1, 1, '#3a5c50');
      px(gX + gW - 3 - (v % 2), yy, 1, 1, '#3a5c50');
      ctx.globalAlpha = 1;
    }
    const scanY = gTop + Math.floor((Math.sin(now / 600 + ph) * 0.5 + 0.5) * (gH - 1));  // drifting scan (kept)
    ctx.globalAlpha = on ? 0.22 : 0.10; px(gX, scanY, gW, 1, '#9af0ff'); ctx.globalAlpha = 1;
    scanl(gX, gTop, gW, gH, 0.16);
    ctx.restore();
    px(scX, scY, scW, 1, U.shade('#2a332f', 0.18));            // bezel highlights (kept)
    px(scX, scY, 1, scH, U.shade('#2a332f', 0.10));
    px(scX + scW - 1, scY, 1, scH, '#1a221e');
    bloom(scX + 1, scY + 1, scW - 2, scH - 2, ACC.data, on ? 0.14 : 0.07);
    spill(scX, scY + scH, scW, ACC.data, on ? 0.20 : 0.09, 4); // chart light pools down onto the pedestal
    // the bench's shared amber hardware LED, low on the slab
    px(x + 2, y + h - 12, 2, 1, blink(520, 1) ? '#ffb347' : '#5a3f1a');
  };
  F.research_samplecart = (x, y, w, h, f) => { // v4 sample cart (2x1) — freestanding trolley; the vials do the lighting
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const wx of [x + 3, x + w - 6]) {                     // caster wheels, proud of the frame
      px(wx - 1, y + h - 4, 4, 4, LINE);
      px(wx, y + h - 3, 2, 2, '#15191a'); px(wx, y + h - 3, 2, 1, '#2c3438');
      px(wx, y + h - 4, 2, 1, U.shade(r.face, 0.10));          // the fork the caster hangs off
    }
    // open mid shelf: dark void, corner posts, a cross-brace so the frame is a frame and not two sticks
    px(x + 2, y + 5, w - 4, 4, '#0d1318');
    for (const pxp of [x + 1, x + w - 3]) {
      px(pxp, y + 4, 2, 5, LINE); px(pxp, y + 4, 1, 5, r.lit); px(pxp + 1, y + 4, 1, 5, r.dk);
    }
    rimEdge(x + w - 2, y + 5, 1, 4, 0.18);
    cable(x + 3, y + 6, x + w - 4, y + 6, 1.4, '#141b20');     // slack lead strung under the tray
    px(x + 2, y + 8, w - 4, 1, '#2c3630');                     // shelf plank
    px(x + 4, y + 5, 6, 3, '#5a665c'); px(x + 4, y + 5, 6, 1, '#6e7a70');  // drive caddy
    px(x + 5, y + 6, 4, 1, '#222a26');                         // drive slot
    px(x + 11, y + 6, 1, 1, blink(520, ph) ? '#7dffb0' : '#1d3a2c');       // read LED (kept 520)
    if (blink(520, ph)) bloom(x + 11, y + 6, 1, 1, ACC.work, 0.26);
    // the chamfered top tray dominates
    chamf(x - 1, y - 2, w + 2, 8, LINE, 2);
    chamf(x, y - 1, w, 6, r.top, 1);
    px(x + 2, y - 1, w - 4, 1, r.sheen); keyEdge(x + 2, y - 1, 8, 1, 0.26);
    px(x, y, 1, 4, r.lit); px(x + w - 1, y, 1, 4, r.dk); rimEdge(x + w - 1, y, 1, 4, 0.20);
    px(x + 1, y + 4, w - 2, 1, U.shade(r.top, -0.18));
    wear(x + 2, y, w - 4, 4, 3, U.shade(r.top, -0.10));
    // VIAL RACK: three capped vials, each lit from the liquid inside (kept stagger pulse)
    px(x + 2, y - 1, 13, 3, '#242e28'); px(x + 3, y - 1, 11, 1, '#3c4840');
    for (let i = 0; i < 3; i++) {
      const vx = x + 4 + i * 4, lit = 0.55 + 0.35 * Math.sin(now / 760 + i * 1.7 + ph);
      px(vx - 1, y - 6, 4, 6, LINE);
      px(vx, y - 5, 2, 1, '#8a9a96'); px(vx, y - 5, 1, 1, '#a8b8b4');     // cap
      px(vx, y - 4, 2, 4, '#1c2a30');                                     // glass above the meniscus
      px(vx, y - 2, 2, 2, U.shade(ACC.data, -0.30 - 0.16 * (1 - lit)));   // the liquid body
      px(vx, y - 2, 2, 1, U.shade(ACC.data, 0.10 * lit));                 // lit meniscus
      px(vx, y - 4, 1, 3, U.shade(SKY, -0.30));                           // cool sky catch down the glass
      bloom(vx, y - 2, 2, 2, ACC.data, (on ? 0.16 : 0.09) + 0.10 * lit);
    }
    spill(x + 3, y + 1, 11, ACC.data, on ? 0.18 : 0.10, 3);    // the rack pools cyan onto the tray
    px(x + 17, y, 5, 3, '#cfd2c8'); px(x + 17, y, 5, 1, '#e6e8df');       // folded printout (kept)
    px(x + 18, y + 1, 3, 1, '#9aa094'); px(x + 19, y + 2, 1, 1, '#8c9286');
    // push handle jutting east
    px(x + w, y - 3, 2, 8, LINE); px(x + w, y - 2, 1, 6, r.lit); px(x + w + 1, y - 2, 1, 6, r.dk);
    px(x + w - 1, y - 4, 4, 2, LINE); px(x + w, y - 4, 3, 1, r.sheen);    // grip
    knurl(x + w, y - 4, 3, 1, r.top);
  };
  F.research_papers = (x, y, w, h, f) => { // v4 printouts (2x1) — the bench's one MATTE prop: no glow, only stacking
    const paper = '#ded9cc', hi = U.shade(paper, 0.16), shd = U.shade(paper, -0.26), ink = '#7e8484';
    const on = !!(f && f.work);
    sh(x + 2, y + h - 2, w - 4);
    ctx.globalAlpha = 0.26; px(x + 2, y + 9, w - 6, 2, '#000'); ctx.globalAlpha = 1;   // the contact shadow does the work
    // manila folder underneath (kept)
    const fold = '#bfa96f';
    px(x + 1, y + 3, 11, 8, U.shade(fold, -0.42));
    px(x + 1, y + 2, 11, 8, fold);
    px(x + 1, y + 2, 11, 1, U.shade(fold, 0.20));
    px(x + 8, y + 2, 4, 1, U.shade(fold, 0.28));               // raised tab
    rimEdge(x + 1, y + 9, 11, 1, 0.10);                        // cool floor bounce into the folder's shade
    // two low stacks — the rise is told by the stacked SHEET EDGES, not by a highlight
    const stack = (sx2, sy2, sw2, sh2) => {
      ctx.globalAlpha = 0.22; px(sx2 - 1, sy2 + sh2 + 1, sw2 + 2, 2, '#000'); ctx.globalAlpha = 1;
      for (let j = 0; j < 3; j++) px(sx2 + (j % 2), sy2 + sh2 + j, sw2 - (j % 2), 1, U.shade(paper, -0.20 - j * 0.08));
      px(sx2, sy2, sw2, sh2, paper);
      px(sx2, sy2, sw2, 1, hi); px(sx2, sy2, 1, sh2, hi);
      keyEdge(sx2, sy2, Math.max(1, sw2 - 3), 1, 0.10);        // a warm ceiling wash, matte — paper takes no sheen
      px(sx2 + sw2 - 1, sy2 + 1, 1, sh2 - 1, shd);
    };
    stack(x + 2, y + 1, 8, 5);
    stack(x + 13, y + 3, 8, 5);
    px(x + 3, y + 3, 5, 1, ink); px(x + 3, y + 5, 4, 1, ink);
    px(x + 14, y + 5, 5, 1, ink); px(x + 14, y + 7, 4, 1, '#969c9c');
    // the topmost readable sheet with its bar chart — printed INK, never an emissive
    const tx = x + 7 + (on ? 1 : 0), ty = y + 2, tw = 9, th = 9;   // a fresh sheet lands askew while printing
    ctx.globalAlpha = 0.30; px(tx - 1, ty + 2, tw + 1, th - 1, '#000'); ctx.globalAlpha = 1;
    px(tx, ty, tw, th, paper);
    px(tx, ty, tw, 1, hi); px(tx, ty, 1, th, hi);
    keyEdge(tx, ty, 6, 1, 0.12);
    px(tx + tw - 1, ty + 1, 1, th - 1, shd); px(tx, ty + th - 1, tw, 1, shd);
    px(tx + tw - 3, ty - 1, 3, 1, U.shade(paper, -0.30));      // curl shadow (kept)
    px(tx + tw - 3, ty, 3, 2, hi); px(tx + tw - 1, ty, 1, 1, U.shade(paper, 0.30)); // curled corner
    px(tx + 1, ty + 2, 6, 1, ink);
    const bars = [2, 4, 3, 5];
    for (let b = 0; b < bars.length; b++) {
      px(tx + 1 + b * 2, ty + 8 - bars[b], 1, bars[b], U.shade(ACC.data, -0.42));   // cyan INK, dimmer than a lamp
      px(tx + 1 + b * 2, ty + 8 - bars[b], 1, 1, U.shade(ACC.data, -0.14));
    }
    const k = Math.floor(now / 600) % bars.length;             // the read-head tick (kept cadence)
    px(tx + 1 + k * 2, ty + 8 - bars[k], 1, 1, on ? '#f6f2e8' : U.shade(ACC.data, 0.10));
    if (on) { px(tx - 2, ty + th - 2, tw + 1, 2, paper); px(tx - 2, ty + th - 2, tw + 1, 1, hi); } // sheet feeding out
  };
  F.comms_dish = (x, y, w, h, f) => {   // v4 uplink (2x2) — segmented mesh dish on a tracking yoke; ACC.data reach
    const r = RAMP.steel, active = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);                                 // floor contact
    deckPlate(x + 1, y + h - 5, w - 2, 5);                            // bolted mounting plate under the pedestal
    deckSocket(x + 1, y + h - 3, active);                             // cable into a floor socket, W side
    // squat pedestal base: top-bias oblique block the mast rises from
    const bw = w - 6, bx = x + 3, by = y + h - 9;
    chamf(bx - 1, by, bw + 2, 8, LINE, 2);
    px(bx, by + 1, bw, 5, r.face);
    px(bx, by + 1, bw, 1, r.lit); keyEdge(bx + 1, by + 1, 7, 1, 0.16); // under-lip catch
    px(bx, by + 1, 1, 5, U.shade(r.face, 0.08)); px(bx + bw - 1, by + 1, 1, 5, r.dk);
    rimEdge(bx + bw - 1, by + 1, 1, 5, 0.20);
    px(bx, by + 5, bw, 1, r.ao);
    chamf(bx - 1, by - 3, bw + 2, 4, LINE, 1);                        // pedestal top surface (we look down on it)
    px(bx, by - 2, bw, 3, r.top); px(bx, by - 2, bw, 1, r.sheen);
    keyEdge(bx + 1, by - 2, 5, 1, 0.26);
    cable(bx + 2, by + 5, x + 4, y + h - 3, 2);                       // power lead sagging into the deck socket
    inset(bx + 1, by + 2, 4, 2, '#10161a'); inset(bx + bw - 5, by + 2, 4, 2, '#10161a'); // bolt plates
    px(bx + 2, by + 3, 1, 1, r.sheen);
    px(bx + bw - 4, by + 3, 1, 1, blink(900, 0.37) ? ACC.data : U.shade(ACC.data, -0.6)); // status LED
    const cx = x + Math.round(w / 2), yoke = y + 5;
    // AZIMUTH RING on the pedestal top — ticks creep round as the dish tracks, so the mount reads alive
    const arx = bw * 0.40, ary = 2.0, acx = bx + bw / 2, acy = by - 1;
    ctx.save(); ctx.strokeStyle = U.shade(r.top, -0.38); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(acx, acy, arx, ary, 0, 0, 6.2832); ctx.stroke(); ctx.restore();
    for (let i = 0; i < 8; i++) {
      const a = i * 0.7854 + now / 3000;
      px(Math.round(acx + Math.cos(a) * arx), Math.round(acy + Math.sin(a) * ary), 1, 1,
         i === 0 ? (active ? ACC.data : U.shade(ACC.data, -0.5)) : U.shade(r.top, 0.18));
    }
    // yoke mast + trunnion the dish pivots on
    px(cx - 1, yoke, 3, by - yoke, LINE);
    px(cx, yoke, 1, by - yoke, r.lit); px(cx + 1, yoke, 1, by - yoke, r.dk);            // lit W / dark E column
    rimEdge(cx + 1, yoke + 2, 1, by - yoke - 3, 0.16);
    px(cx - 2, yoke + 1, 5, 2, LINE); px(cx - 1, yoke + 1, 3, 1, r.top);                // trunnion collar
    // SEGMENTED MESH DISH — a real reflector: alternating panel wedges, mesh rim, slow tracking sway
    const th = -0.55 + 0.055 * Math.sin(now / 2600);                  // the dish hunts for its bird
    const dcx = cx - 1 + Math.sin(now / 2600) * 0.6, dcy = yoke - 1;
    const rx = w * 0.50, ry = w * 0.28, ir = rx - 3.6;
    ctx.save();
    ctx.translate(dcx, dcy); ctx.rotate(th); ctx.scale(1, ry / rx);    // work in a circle, squash to the oval
    ctx.fillStyle = LINE; ctx.beginPath(); ctx.arc(0, 0, rx + 1.1, 0, 6.2832); ctx.fill();  // heavy silhouette rim
    ctx.fillStyle = r.face; ctx.beginPath(); ctx.arc(0, 0, rx, 0, 6.2832); ctx.fill();      // solid rim band
    ctx.fillStyle = U.shade(r.dk, -0.44); ctx.beginPath(); ctx.arc(0.5, 0.4, ir, 0, 6.2832); ctx.fill(); // deep concave
    for (let i = 0; i < 12; i += 2) {                                  // alternating reflector panels — kept quiet;
      const a0 = i * Math.PI / 6;                                      // any louder and the bowl turns to haze
      ctx.fillStyle = U.shade(r.dk, -0.24);
      ctx.beginPath(); ctx.moveTo(0.5, 0.4); ctx.arc(0.5, 0.4, ir, a0, a0 + Math.PI / 6); ctx.closePath(); ctx.fill();
    }
    const cyc = (now / 1500) % 1;                                     // radar sweep (kept behaviour)
    if (cyc < 0.5) {
      ctx.globalAlpha = 0.34 * (1 - cyc / 0.5); ctx.fillStyle = ACC.data;
      const a0 = -2.4 + cyc * 3.4;
      ctx.beginPath(); ctx.moveTo(0.5, 0.4); ctx.arc(0.5, 0.4, ir, a0, a0 + 0.55); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = r.sheen; ctx.lineWidth = 1.6;                   // warm NW rim catch
    ctx.beginPath(); ctx.arc(0, 0, rx - 0.9, Math.PI * 1.02, Math.PI * 1.58); ctx.stroke();
    ctx.globalAlpha = 0.34; ctx.strokeStyle = SKY;                    // cool SE sky bounce
    ctx.beginPath(); ctx.arc(0, 0, rx - 0.9, Math.PI * 0.06, Math.PI * 0.52); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
    // TRIPOD feed struts to the horn at the focus — three legs read as hardware, one line reads as a scratch
    const rimPt = a => [dcx + rx * Math.cos(a) * Math.cos(th) - ry * Math.sin(a) * Math.sin(th),
                        dcy + rx * Math.cos(a) * Math.sin(th) + ry * Math.sin(a) * Math.cos(th)];
    const fx = Math.round(dcx + rx * 0.26), fy = Math.round(dcy + ry * 0.72);
    for (const a of [-2.15, -0.15, 1.75]) {
      const p = rimPt(a);
      ctx.strokeStyle = LINE; ctx.lineWidth = 1.8;                    // dark core so the strut reads on the bowl
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(fx + 0.5, fy + 0.5); ctx.stroke();
      ctx.strokeStyle = U.shade(r.face, 0.06); ctx.lineWidth = 0.7;   // faint filament — struts are hardware,
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(fx + 0.5, fy + 0.5); ctx.stroke();   // not the subject
    }
    px(fx - 2, fy - 2, 5, 4, LINE);                                   // feed horn housing
    px(fx - 1, fy - 1, 3, 2, r.face); px(fx - 1, fy - 1, 3, 1, r.lit);
    // ONE emissive accent: feed-horn cyan pulse (~1.5s), with real falloff
    const pulse = 0.45 + 0.55 * Math.max(0, Math.sin(now / 750));
    const gain = active ? 1 : 0.55;
    bloom(fx, fy, 1, 1, ACC.data, 0.42 * pulse * gain);
    px(fx, fy, 1, 1, pulse > 0.7 ? '#c7f4ff' : ACC.data);
    // ACTIVE: signal rings break outward from the horn — the prop's whole point is REACH
    if (active) {
      ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = ACC.data;
      for (let k = 0; k < 3; k++) {
        const t = ((now / 950) + k / 3) % 1;
        ctx.globalAlpha = 0.40 * (1 - t) * (1 - t);
        ctx.beginPath(); ctx.arc(fx, fy, 3 + t * 16, -2.65, -0.95); ctx.stroke();
      }
      ctx.restore();
    }
  };
  F.comms_inbox = (x, y, w, h, f) => {
    // INBOX (2x1, blocks:true) — v4. A real bolted intake: the family register is ARRIVAL, so the machine
    // both swallows a physical card at the front slot AND stacks the holo receipts above it. The stack used
    // to float free of the prop; twin emitter posts now project it, which is what ties it down. Kept: the
    // 2s rise/fade cycle, the three channel pips, the unread badge tick, and the f.work lift.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const cy0 = ACC.data;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short front face: the INTAKE SLOT with a card being drawn in, then the kept channel pips
    rr(x - 1, y + 4, w + 2, 6, LINE);
    px(x, y + 5, w, 3, r.face);
    px(x, y + 5, w, 1, r.lit); keyEdge(x + 1, y + 5, w - 3, 1, 0.15);
    px(x, y + 7, w, 1, r.ao);
    inset(x + 3, y + 5, 9, 2, '#080e0c');
    const draw0 = (now % 2600) / 2600;                            // a card is pulled IN, not pushed out
    if (draw0 < 0.45) {
      const ins = Math.round((1 - draw0 / 0.45) * 4);
      if (ins > 0) { px(x + 5, y + 6, ins + 1, 1, '#b3bcb4'); px(x + 5, y + 6, 1, 1, '#d8e0d6'); }
    }
    const alert = blink(520, 1);                                  // kept channel pips
    px(x + 13, y + 6, 2, 1, blink(900, ph) ? ACC.work : '#173026');        // mail
    px(x + 16, y + 6, 2, 1, alert ? '#ffb23a' : '#3a2c12');                // webhook
    px(x + 19, y + 6, 2, 1, blink(1300, 2 + ph) ? ACC.work : '#173026');   // platform
    if (alert) bloom(x + 16, y + 6, 2, 1, '#ff9d2e', 0.30);
    // dominant chamfered top with a recessed holo tray
    chamf(x - 1, y - 4, w + 2, 10, LINE, 2);
    chamf(x, y - 3, w, 8, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 8, 1, 0.28);
    px(x, y - 1, 1, 4, r.lit); px(x + w - 1, y - 1, 1, 4, r.dk);
    rimEdge(x + w - 1, y - 1, 1, 4, 0.20);
    px(x + 2, y + 4, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 1, y - 2, w - 2, 5, 3, U.shade(r.top, -0.10));
    inset(x + 3, y - 2, w - 6, 5, '#07110f');                     // glass tray
    bloom(x + 4, y - 1, w - 8, 3, cy0, on ? 0.18 : 0.10 + 0.05 * Math.sin(now / 640));
    // EMITTER POSTS — the stack read as a second floating object until these carried it
    for (const ex of [x + 3, x + w - 5]) {
      px(ex, y - 7, 2, 5, LINE); px(ex, y - 7, 1, 5, r.lit); px(ex + 1, y - 7, 1, 5, r.dk);
      px(ex, y - 8, 2, 1, U.shade(r.top, 0.18));
      px(ex, y - 7, 2, 1, on ? '#bff5ff' : U.shade(cy0, -0.45));
      bloom(ex, y - 7, 2, 1, cy0, on ? 0.34 : 0.16);
    }
    // holo receipt stack rising out of the tray (kept 2s cycle), each an envelope with a flap
    const t = (now % 2000) / 2000, cardW = 8, cardX = x + 8;
    for (let s = 0; s < 3; s++) {
      const cy = y - 3 - s * 3 - Math.round(t * (s === 0 ? 4 : 3));
      let a = (s === 0 ? 0.90 * (1 - t) : 0.82 - s * 0.22);
      if (a <= 0.05) continue;
      ctx.save(); ctx.globalAlpha = a;
      const col = s === 0 ? '#8ff0ff' : U.shade(cy0, -0.34);
      px(cardX, cy, cardW, 1, col); px(cardX, cy + 2, cardW, 1, col);
      px(cardX, cy, 1, 3, col); px(cardX + cardW - 1, cy, 1, 3, col);
      px(cardX + 3, cy + 1, 2, 1, U.shade(col, 0.30));            // flap hint
      ctx.restore();
    }
    // unread-count badge on the NE corner (kept tick)
    const cnt = (Math.floor(now / 2000) % 9) + 1, bx = x + w - 7, by = y - 6;
    px(bx, by, 5, 4, '#0a1614'); px(bx, by, 5, 1, U.shade(cy0, -0.55));
    const segOn = (U.hash('' + cnt) % 2) === 0;
    px(bx + 1, by + 1, 3, 1, cy0);
    px(bx + 1, by + 2, segOn ? 3 : 2, 1, U.shade(cy0, 0.20));
    bloom(bx + 1, by + 1, 3, 2, cy0, 0.26);
    if (on) px(cardX - 1, y - 3, 1, 1, '#dff9ff');                // kept active-use catch
  };
  F.comms_uplink = (x, y, w, h, f) => {   // v4 uplink (2x2) — a FLAT phased array on a trunnion; the dish's sibling, not its twin
    // WEB capability, same cyan family as comms_dish and comms_beacon. The three must never read as one prop:
    // the dish is a round bowl that HUNTS, the beacon is a thin mast that FLASHES, and this is a flat rectangular
    // array that SCANS in rows and launches its beam straight up. Old build was a capsule sorter (pneumatic mail,
    // wrong story) whose legs floated below a body that stopped 8px short of the floor — both fixed here.
    const r = RAMP.steel, active = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 2, y + h - 1, w - 4);
    deckPlate(x + 1, y + h - 5, w - 2, 5);
    deckSocket(x + w + 1, y + h - 3, active);
    cable(x + w - 4, y + h - 7, x + w + 2, y + h - 3, 2);
    // ---- equipment cabinet: a squat top-bias block that actually reaches the deck plate
    const bx = x + 2, bw = w - 4, fTop = y + 11, fBot = y + h - 5;
    chamf(bx - 1, fTop, bw + 2, fBot - fTop + 1, LINE, 2);
    px(bx, fTop + 1, bw, fBot - fTop - 1, r.face);
    px(bx, fTop + 1, bw, 1, r.lit); keyEdge(bx + 1, fTop + 1, bw - 3, 1, 0.16);
    px(bx, fTop + 2, 1, fBot - fTop - 3, U.shade(r.face, 0.08)); px(bx + bw - 1, fTop + 2, 1, fBot - fTop - 3, r.dk);
    rimEdge(bx + bw - 1, fTop + 2, 1, fBot - fTop - 3, 0.20);
    px(bx, fBot - 1, bw, 1, r.ao);
    chamf(bx - 1, y + 7, bw + 2, 5, LINE, 1);                          // cabinet top surface (we look down on it)
    px(bx, y + 8, bw, 3, r.top); px(bx, y + 8, bw, 1, r.sheen);
    keyEdge(bx + 1, y + 8, 6, 1, 0.28);
    px(bx, y + 11, bw, 1, U.shade(r.top, -0.22));                      // front lip
    for (let i = 0; i < 4; i++) { px(bx + 2 + i * 3, y + 9, 1, 2, r.ao); px(bx + 3 + i * 3, y + 9, 1, 2, U.shade(r.top, 0.10)); }
    inset(bx + 2, fTop + 3, 8, 4, '#0d1518');                          // transmit meter on the face
    for (let i = 0; i < 6; i++) {
      const v = 1 + Math.floor((1 + Math.sin(now / 240 + i * 0.9 + ph)) * (active ? 0.9 : 0.4));
      px(bx + 3 + i, fTop + 6 - v, 1, v, active ? ACC.data : U.shade(ACC.data, -0.60));
    }
    if (active) bloom(bx + 3, fTop + 4, 6, 2, ACC.data, 0.15);
    knurl(bx + bw - 9, fTop + 4, 7, 1, r.face);                        // machined grip strip
    for (let i = 0; i < 3; i++)                                        // status stack
      px(bx + bw - 4, fTop + 3 + i * 2, 2, 1, blink(700 + i * 230, i + ph) ? (i === 2 ? ACC.flow : ACC.data) : '#16262c');
    wear(bx + 1, fTop + 2, bw - 2, fBot - fTop - 4, 3, U.shade(r.face, -0.12));
    // ---- trunnion + waveguide feed tying the array down to the cabinet
    const cx = x + Math.round(w / 2);
    px(cx - 3, y + 2, 7, 7, LINE);
    px(cx - 2, y + 3, 5, 5, r.face); px(cx - 2, y + 3, 5, 1, r.lit); px(cx + 2, y + 4, 1, 4, r.dk);
    px(cx - 1, y + 1, 3, 3, U.shade(r.face, -0.16));                   // waveguide collar under the panel
    cable(cx + 3, y + 6, bx + bw - 3, y + 9, 1.4);                     // feed line off the trunnion
    // ---- PHASED ARRAY: a sheared rectangle (rows step east as they rise) so it reads TILTED skyward
    const pw = 17, pH = 12, pTop = y - 10, pL = x + 2;
    const ox = j => Math.round((pH - 1 - j) * 0.28);
    for (let j = -1; j <= pH; j++) {                                   // heavy silhouette frame, following the shear
      const o = ox(Math.max(0, Math.min(pH - 1, j)));
      px(pL + o - 1, pTop + j, pw + 2, 1, LINE);
    }
    for (let j = 0; j < pH; j++) {
      const o = ox(j);
      px(pL + o, pTop + j, pw, 1, r.face);
      px(pL + o, pTop + j, 1, 1, r.lit);                               // lit west rail, tracking the shear
      px(pL + o + pw - 1, pTop + j, 1, 1, r.dk);
      rimEdge(pL + o + pw - 1, pTop + j, 1, 1, 0.18);                  // cool sky bounce down the shade rail
    }
    px(pL + ox(0) + 1, pTop, pw - 2, 1, r.sheen);
    keyEdge(pL + ox(0) + 1, pTop, 7, 1, 0.30);                         // warm key along the panel crown
    px(pL + ox(pH - 1) + 1, pTop + pH - 1, pw - 2, 1, r.ao);
    // emitter cells — a 5x3 grid that scans COLUMN BY COLUMN (the array steers its beam by phase)
    const colScan = Math.floor(now / 210) % 5;
    for (let cyi = 0; cyi < 3; cyi++) for (let cxi = 0; cxi < 5; cxi++) {
      const j = 2 + cyi * 3, o = ox(j);
      const ex = pL + o + 2 + cxi * 3, ey = pTop + j;
      inset(ex, ey, 3, 3, '#0c1a1f');
      const lit = cxi === colScan, warm = blink(520, cxi + cyi * 1.7 + ph);
      const c = lit ? '#c7f4ff' : warm ? ACC.data : U.shade(ACC.data, -0.62);
      px(ex + 1, ey + 1, 1, 1, active || lit || warm ? c : U.shade(ACC.data, -0.72));
      if (lit && active) bloom(ex + 1, ey + 1, 1, 1, ACC.data, 0.34);
    }
    if (active) bloom(pL + ox(6) + 1, pTop + 1, pw - 2, pH - 2, ACC.data, 0.10 + 0.04 * Math.sin(now / 380));
    else px(pL + ox(2) + 2, pTop + 2, 1, 1, blink(1600, ph) ? ACC.data : U.shade(ACC.data, -0.5)); // standby cell
    // ---- the point of the prop is REACH: while transmitting, beam rungs climb off the crown and fade
    if (active) {
      for (let k = 0; k < 3; k++) {
        const t = ((now / 820) + k / 3) % 1;
        const ry = pTop - 1 - Math.floor(t * 9), rw = Math.max(2, Math.round((pw - 4) * (1 - t * 0.75)));
        ctx.globalAlpha = 0.42 * (1 - t) * (1 - t);
        px(pL + ox(0) + 2 + Math.round((pw - 4 - rw) / 2), ry, rw, 1, ACC.data);
        ctx.globalAlpha = 1;
      }
    }
    // two short whip antennas on the crown rail, so the top edge is not a bare line
    for (const s of [-1, 1]) {
      const ax = cx + s * 6;
      px(ax, pTop - 2, 1, 2, r.face); px(ax + s, pTop - 3, 1, 1, r.lit);
    }
  };
  F.comms_beacon = (x, y, w, h, f) => {   // v4 beacon (1x2) — the cyan family's SLIM one: a guyed mast under a flashing lantern
    // Sibling of comms_dish / comms_uplink but never mistakable for them: one thin vertical line, a fresnel drum
    // that sweeps like a lighthouse, and guy wires that break the pole out of a plain rectangle.
    const r = RAMP.steel, cx = x + Math.round(w / 2), on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(cx - 5, y + h - 1, 11);
    deckPlate(cx - 6, y + h - 5, 12, 5);
    deckSocket(cx + 4, y + h - 3, on);
    // weighted base drum — chamfered, so the foot is bold rather than a little box
    const baseY = y + h - 9;
    chamf(cx - 6, baseY, 12, 8, LINE, 2);
    px(cx - 5, baseY + 3, 10, 4, r.face); px(cx - 5, baseY + 3, 10, 1, r.lit);
    keyEdge(cx - 4, baseY + 3, 7, 1, 0.16);
    px(cx - 5, baseY + 4, 1, 3, U.shade(r.face, 0.08)); px(cx + 4, baseY + 4, 1, 3, r.dk);
    rimEdge(cx + 4, baseY + 4, 1, 3, 0.20);
    px(cx - 5, baseY + 6, 10, 1, r.ao);
    chamf(cx - 6, baseY, 12, 4, LINE, 2);                              // base top surface we look down on
    px(cx - 5, baseY + 1, 10, 2, r.top); px(cx - 5, baseY + 1, 10, 1, r.sheen);
    keyEdge(cx - 4, baseY + 1, 5, 1, 0.28);
    px(cx - 4, baseY + 4, 1, 1, r.sheen); px(cx + 3, baseY + 4, 1, 1, r.sheen);   // rivets
    cable(cx - 4, baseY + 6, cx - 3, y + h - 3, 1.2);
    // tapered pole: 3px at the foot, 2px at the crown
    const poleTop = y - 2, poleBot = baseY;
    px(cx - 2, poleTop, 4, poleBot - poleTop, LINE);
    px(cx - 1, poleTop, 1, poleBot - poleTop, r.lit);
    px(cx, poleTop, 1, poleBot - poleTop, r.face);
    px(cx + 1, poleTop + 3, 1, poleBot - poleTop - 3, r.dk);
    rimEdge(cx + 1, poleTop + 4, 1, poleBot - poleTop - 6, 0.18);
    px(cx - 2, poleTop + 7, 5, 2, LINE); px(cx - 1, poleTop + 7, 3, 1, r.top);   // machined collar
    // GUY WIRES down to the base — the cheapest way to stop a mast reading as a bare bar
    cable(cx - 1, poleTop + 2, cx - 5, baseY + 1, 1.6);
    cable(cx + 1, poleTop + 2, cx + 5, baseY + 1, 1.6);
    // three signal-strength rings climbing the pole (outgoing transmission) — behaviour preserved
    const seq = Math.floor(now / 320) % 4;
    for (let ri = 0; ri < 3; ri++) {
      const ry = poleTop + 5 + ri * 4;
      const lit = seq < 3 && (2 - ri) <= seq;                          // fill from the bottom ring upward
      px(cx - 2, ry, 5, 1, lit ? U.shade(ACC.data, 0.12 - ri * 0.06) : '#1e3a33');
      if (lit) bloom(cx - 2, ry, 5, 1, ACC.data, 0.22);
    }
    // ---- FRESNEL LANTERN at the crown: ribbed drum with a beam that SWEEPS past us once a cycle
    const lampY = poleTop - 8, sweep = Math.max(0, Math.sin((now / 1150) * 6.2832));
    const gain = on ? 1 : 0.5;
    chamf(cx - 5, lampY - 1, 11, 11, LINE, 2);
    px(cx - 4, lampY, 9, 2, r.top); px(cx - 4, lampY, 9, 1, r.sheen);  // lantern roof
    keyEdge(cx - 4, lampY, 5, 1, 0.28);
    px(cx - 4, lampY + 7, 9, 2, r.face); px(cx - 4, lampY + 8, 9, 1, r.ao);       // lantern floor
    inset(cx - 4, lampY + 2, 9, 5, '#08131a');                         // the glass well
    for (let j = 0; j < 5; j++) {                                      // fresnel ribs across the glass
      const a = (0.18 + 0.62 * sweep) * gain * (j === 2 ? 1 : 0.72);
      ctx.globalAlpha = a; px(cx - 3, lampY + 2 + j, 7, 1, ACC.data); ctx.globalAlpha = 1;
      px(cx - 3, lampY + 2 + j, 1, 1, U.shade(ACC.data, -0.30));       // rib edges keep it from reading as jelly
      px(cx + 3, lampY + 2 + j, 1, 1, U.shade(ACC.data, -0.45));
    }
    px(cx - 1, lampY + 3, 2, 3, U.shade(ACC.data, 0.10 + 0.28 * sweep));           // the burner itself
    if (sweep > 0.72) px(cx, lampY + 4, 1, 1, '#e6fffb');
    bloom(cx - 2, lampY + 3, 4, 3, ACC.data, (0.16 + 0.34 * sweep) * gain);        // real falloff, not a flat sticker
    spill(cx - 4, lampY + 9, 9, ACC.data, 0.16 * gain * (0.4 + 0.6 * sweep), 4);   // light pools down the mast
    px(cx - 2, lampY + 1, 1, 7, '#0a0f0d'); px(cx + 2, lampY + 1, 1, 7, '#0a0f0d');// cage bars
    // two short whip antennas in a shallow V + the red collision light at the tip (kept)
    for (const s of [-1, 1]) { px(cx + s, lampY - 2, 1, 1, r.face); px(cx + 2 * s, lampY - 3, 1, 1, r.lit); px(cx + 3 * s, lampY - 4, 1, 1, r.lit); }
    if (blink(560)) { px(cx, lampY - 3, 1, 1, ACC.alert); bloom(cx, lampY - 3, 1, 1, ACC.alert, 0.40); }
    else px(cx, lampY - 3, 1, 1, U.shade(ACC.alert, -0.6));
  };
  F.connector_portal = (x, y, w, h, f) => {   // MCP on-ramp (1x2) — four LIVE states told by SHAPE + CADENCE, not hue alone
    // CONNECTOR PORTAL — an agent's on-ramp to an EXTERNAL MCP server, bound to one connector and riding its
    // live state. The station lightmap dims everything, so colour cannot carry the truth on its own: each state
    // also owns a distinct APERTURE SHAPE, CROWN behaviour, LAMP cadence and CONDUIT traffic —
    //   connected · open ring, crown chases upward, steady lamp, packets drift up the conduit, ports jumpered
    //   offline   · iris SHUT (a closed bar across the port), one dark dot, slow 1.4s lamp, conduit empty
    //   error     · ring BROKEN into arcs and jittering, 300ms strobe, a packet that rises then FALLS BACK
    //   unbound   · no aperture at all — a bolted blanking cap over the port, dead conduit, capped sockets
    // f.fired decays 1 -> 0 and drives a bright packet up the conduit that flares the aperture.
    const st  = (f && f.state) || (f && f.bound ? 'offline' : 'unbound');
    const SACC = { connected: ACC.work, offline: ACC.flow, error: ACC.alert, unbound: '#586b61' };
    const SHOT = { connected: '#c7ffe0', offline: '#ffe9a8', error: '#ff8378', unbound: '#8aa093' };
    const acc = SACC[st] || SACC.unbound, hot = SHOT[st] || SHOT.unbound;
    const live = st === 'connected', bad = st === 'error', off = st === 'offline', none = st === 'unbound';
    const fired = Math.max(0, Math.min(1, (f && f.fired) || 0));
    const r = RAMP.steel, cw = 13, cx = x + Math.round(cw / 2);
    const apX = cx + 3, apY = y - 6;                                  // crown port = the "outside", above the cabinet
    const jit = (bad && blink(120)) ? 1 : 0;                          // the fault shakes the whole crown assembly
    shadow2(x + 1, y + h - 1, cw - 2);
    deckPlate(x - 1, y + h - 6, cw + 2, 6);
    deckSocket(x + cw + 1, y + h - 3, live);
    cable(x + cw - 2, y + h - 9, x + cw + 2, y + h - 3, 2);           // limp lead into the floor socket
    // ---- TALL 3/4 body: chamfered slab, warm crown key, cool east rim
    chamf(x - 1, y - 3, cw + 2, h + 2, LINE, 2);
    chamf(x, y - 2, cw, h, r.face, 2);
    px(x, y, 1, h - 5, U.shade(r.face, 0.12)); px(x + cw - 1, y, 1, h - 5, r.dk);
    rimEdge(x + cw - 1, y + 1, 1, h - 7, 0.22);
    chamf(x - 1, y - 7, cw + 2, 4, LINE, 1);                          // top cap we look down on
    px(x, y - 6, cw, 2, r.top); px(x, y - 6, cw, 1, r.sheen);
    keyEdge(x, y - 6, 5, 1, 0.30);
    px(x, y - 4, cw, 1, U.shade(r.top, -0.24));                       // cap front lip ties the cap to the slab
    for (let s = 0; s < 3; s++) {                                     // brushed panel seams
      px(x + 2, y + 3 + s * 5, cw - 4, 1, r.ao);
      px(x + 2, y + 4 + s * 5, cw - 4, 1, U.shade(r.face, 0.08));
    }
    wear(x + 2, y + 1, cw - 4, h - 8, 3, U.shade(r.face, -0.12));
    // ---- MAST carrying the port above the cap (stacked things must be tied down, never float)
    px(cx + 2, y - 5, 3, 3, LINE); px(cx + 3, y - 5, 1, 3, r.lit); px(cx + 4, y - 5, 1, 3, r.dk);
    // ---- CROWN: a 3-dot climb to the port. Its MOTION is a state channel of its own.
    if (!none) {
      const arc = [[cx - 1, y - 2], [cx + 1, y - 4], [apX + jit, apY + 1]];
      for (let i = 0; i < arc.length; i++) {
        const on = live ? (Math.floor(now / 160) % arc.length === i)   // chases upward = traffic is flowing
                        : bad ? blink(150)                             // all three strobe together = fault
                        : (i === 0 && blink(1400));                    // offline: only the base dot, slowly
        px(arc[i][0], arc[i][1], 1, 1, on ? hot : U.shade(acc, -0.5));
        if (on) bloom(arc[i][0], arc[i][1], 1, 1, acc, 0.30);
      }
    }
    // ---- APERTURE: a different SHAPE per state, so it survives the lightmap in greyscale
    if (none) {                                                       // unbound: bolted blanking cap, no port at all
      chamf(apX - 3, apY - 3, 7, 7, LINE, 1);
      chamf(apX - 2, apY - 2, 5, 5, U.shade(r.face, -0.06), 1);
      px(apX - 2, apY - 2, 5, 1, U.shade(r.face, 0.14)); rimEdge(apX + 2, apY - 1, 1, 4, 0.18);
      px(apX - 1, apY, 3, 1, U.shade(r.face, -0.42));                 // slot screw — a cover, not an opening
      px(apX - 2, apY - 2, 1, 1, r.sheen); px(apX + 2, apY + 2, 1, 1, r.ao);
    } else if (off) {                                                 // offline: the iris is SHUT
      ctx.strokeStyle = U.shade(acc, -0.45); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(apX + 0.5, apY + 0.5, 2.2, 0, 6.2832); ctx.stroke();
      px(apX - 2, apY, 5, 1, U.shade(acc, -0.10));                    // closed shutter blade across the mouth
      px(apX - 2, apY - 1, 5, 1, '#0a0f0c'); px(apX - 2, apY + 1, 5, 1, '#0a0f0c');
      if (blink(1400)) bloom(apX - 2, apY, 5, 1, acc, 0.16);
    } else if (bad) {                                                 // error: the ring is BROKEN and shaking
      ctx.strokeStyle = blink(260) ? acc : U.shade(acc, -0.55); ctx.lineWidth = 1;
      for (const a0 of [-2.7, -0.6, 1.5]) {
        ctx.beginPath(); ctx.arc(apX + 0.5 + jit, apY + 0.5, 2.2, a0, a0 + 1.25); ctx.stroke();
      }
      if (blink(150)) bloom(apX - 2 + jit, apY - 2, 5, 5, acc, 0.26);
    } else {                                                          // connected: a whole, open ring
      ctx.strokeStyle = acc; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(apX + 0.5, apY + 0.5, 2.2, 0, 6.2832); ctx.stroke();
      px(apX, apY, 1, 1, hot);
      bloom(apX - 1, apY - 1, 3, 3, acc, 0.22 + 0.10 * Math.sin(now / 620));
    }
    if (fired > 0) bloom(apX - 2 + jit, apY - 2, 5, 5, acc, 0.20 + 0.55 * fired);
    // ---- CONDUIT up the centre: what rides it is the fourth channel
    const condX = cx - 1, condTop = y - 2, condBot = y + h - 9;
    inset(condX, condTop, 2, condBot - condTop, '#141b18');
    px(condX, condTop, 2, 1, U.shade(acc, -0.4));                     // conduit mouth ring
    if (none) {                                                       // capped off: a bolted blanking strip
      px(condX, condTop + 2, 2, condBot - condTop - 4, U.shade(r.face, 0.04));
      px(condX, condTop + 2, 1, condBot - condTop - 4, U.shade(r.face, 0.16));
      px(condX, condTop + 3, 2, 1, r.ao); px(condX, condBot - 3, 2, 1, r.ao);
    } else if (live && fired === 0) {                                 // packets drift steadily up
      const t = (now % 1400) / 1400;
      const py = condBot - 1 - Math.floor(t * (condBot - condTop - 1));
      px(condX, py, 2, 1, U.shade(acc, 0.1)); bloom(condX, py, 2, 1, acc, 0.18);
    } else if (bad && fired === 0) {                                  // a call that rises, stalls, and FALLS BACK
      const t = (now % 1100) / 1100, u = t < 0.55 ? t / 0.55 : (1 - (t - 0.55) / 0.45);
      const py = condBot - 1 - Math.floor(u * 0.62 * (condBot - condTop - 1));
      px(condX, py, 2, 1, hot); bloom(condX, py, 2, 1, acc, 0.24);
    }
    if (fired > 0) {                                                  // a real tool call climbing to the port
      const py = condBot - 1 - Math.floor((1 - fired) * (condBot - condTop - 1));
      px(condX, py, 2, 2, hot);
      bloom(condX, py, 2, 2, acc, 0.45);
    }
    // ---- STATUS LAMP on the face: cadence is legible even when the hue is crushed
    const lampOn = bad ? blink(300) : live ? true : off ? blink(1400) : false;
    chamf(x + 1, y - 2, 4, 4, LINE, 1);
    px(x + 2, y - 1, 2, 2, lampOn ? hot : U.shade(acc, -0.58));
    if (lampOn) bloom(x + 2, y - 1, 2, 2, acc, 0.34);
    if (bad) { px(x + 2, y + h - 12, cw - 4, 1, blink(300) ? '#8a7434' : '#3a3018'); }  // hazard bar under a fault
    // ---- SOCKET BAY near the base: the literal "connector"
    const syb = y + h - 7;
    for (const sx of [cx - 4, cx + 1]) {
      inset(sx, syb, 3, 3, '#10100c');
      if (none) { px(sx, syb + 1, 3, 1, U.shade(r.face, 0.06)); px(sx + 1, syb + 1, 1, 1, r.ao); }  // dust cap
      else { px(sx + 1, syb + 1, 1, 1, live ? hot : U.shade(acc, -0.25)); }
    }
    if (live) cable(cx - 3, syb + 1, cx + 2, syb + 1, 2, U.shade(acc, -0.5));   // a patch lead actually plugged in
    px(x + 1, y + h - 3, cw - 2, 1, r.ao);                            // floor-line AO
    if (live) spill(x + 2, y + h - 3, cw - 4, acc, 0.10, 3);          // the live portal pools a little light down
  };
  F.workbench = (x, y, w, h, f) => {   // v4 POWERED bench (2x1) — pegboard + vise + iron; f.fired 1->0 pulse, f.bad = fail
    const r = RAMP.steel;
    const fired = Math.max(0, Math.min(1, (f && f.fired) || 0));
    const bad = !!(f && f.bad) && fired > 0;
    const acc = bad ? ACC.alert : ACC.work, hot = bad ? '#ff8378' : '#c7ffe0';
    const on = fired > 0 || !!(f && f.work), steel = '#9aa39c';
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // PEGBOARD back panel — the bench's silhouette and its story: this is where tools live
    const pt = y - 12;
    for (const ux of [x + 2, x + w - 6]) {                     // uprights tying the board to the bench —
      px(ux, pt + 6, 3, 8, LINE);                              // without these the board floated as a second object
      px(ux, pt + 6, 1, 8, r.lit); px(ux + 1, pt + 6, 1, 8, r.dk);
    }
    chamf(x, pt - 1, w - 1, 10, LINE, 2);
    chamf(x + 1, pt, w - 3, 8, U.shade(r.face, -0.12), 2);
    px(x + 2, pt, w - 5, 1, r.top); keyEdge(x + 2, pt, 6, 1, 0.24);
    px(x + 1, pt + 2, 1, 5, r.lit); px(x + w - 3, pt + 2, 1, 5, r.dk); rimEdge(x + w - 3, pt + 2, 1, 5, 0.20);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 9; i++) px(x + 3 + i * 2, pt + 2 + j * 2, 1, 1, U.shade(r.face, -0.55));
    // hung tools — chunky silhouettes that read at 12px: wrench, hammer, pliers, coiled lead
    px(x + 3, pt + 1, 1, 5, steel); px(x + 3, pt + 1, 1, 2, U.shade(steel, 0.2));
    px(x + 2, pt + 1, 3, 1, steel); px(x + 2, pt + 5, 3, 1, U.shade(steel, -0.2));   // wrench
    px(x + 7, pt + 2, 1, 5, '#7a6440'); px(x + 6, pt + 1, 3, 2, steel); px(x + 6, pt + 1, 3, 1, U.shade(steel, 0.25)); // hammer
    px(x + 11, pt + 1, 1, 3, steel); px(x + 12, pt + 1, 1, 3, U.shade(steel, -0.25));
    px(x + 11, pt + 4, 2, 2, '#b8452e'); px(x + 11, pt + 4, 2, 1, '#d4664a');        // pliers w/ grips
    for (let i = 0; i < 5; i++) px(x + 13 + (i % 2), pt + 1 + i, 2, 1, '#20282c');   // coiled lead
    // status SCOPE on the pegboard: idle amber heartbeat, live trace on run, flatline red on fail
    const sx = x + 17, sy = pt + 1;
    px(sx - 1, sy - 1, 7, 7, LINE); inset(sx, sy, 5, 5, '#0f2018');
    px(sx + 1, sy + 1, 3, 3, '#0d1c15');                       // idle glass keeps a little phosphor, not a black hole
    if (fired > 0) {
      for (let i = 0; i < 3; i++) {
        const v = bad ? 1 : 1 + Math.round(Math.max(0, Math.sin(now / 120 + i * 1.3)));
        px(sx + 1 + i, sy + 3 - v, 1, 1, hot);
      }
      bloom(sx + 1, sy + 1, 3, 3, acc, 0.22 + 0.45 * fired);
    } else if (f && f.work) {
      for (let i = 0; i < 3; i++) px(sx + 1 + i, sy + 2, 1, 1, (Math.floor(now / 180) % 3 === i) ? acc : U.shade(acc, -0.5));
    } else {
      px(sx + 2, sy + 2, 1, 1, blink(1600) ? ACC.flow : U.shade(ACC.flow, -0.5)); // amber heartbeat
    }
    // heavy steel worktop dominates, chamfered
    chamf(x - 1, y - 4, w + 2, 11, LINE, 2);
    chamf(x, y - 3, w, 9, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 8, 1, 0.26);
    px(x, y - 1, 1, 5, r.lit); px(x + w - 1, y - 1, 1, 5, r.dk); rimEdge(x + w - 1, y - 1, 1, 5, 0.20);
    px(x + 2, y + 5, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 1, y - 2, w - 2, 6, 5, U.shade(r.top, -0.12));
    px(x + 5, y + 1, 8, 1, U.shade(r.top, -0.22)); px(x + 6, y + 3, 5, 1, U.shade(r.top, -0.18)); // cut marks
    // heavy VISE bolted at the west end, jaws holding a workpiece
    px(x + 1, y - 2, 6, 4, LINE);
    px(x + 2, y - 1, 4, 2, U.shade(steel, -0.24)); px(x + 2, y - 1, 4, 1, U.shade(steel, -0.02));
    px(x + 2, y - 1, 1, 2, U.shade(steel, 0.18)); px(x + 5, y - 1, 1, 2, U.shade(steel, -0.4));
    px(x + 7, y, 3, 1, U.shade(steel, -0.15)); px(x + 9, y - 1, 1, 3, U.shade(steel, 0.1)); // screw + handle
    px(x + 3, y - 3, 2, 2, '#5a6b4a'); px(x + 3, y - 3, 2, 1, '#7f9468');                    // clamped workpiece
    // soldering iron in its stand, tip hot while a run is live
    px(x + 11, y + 1, 4, 2, U.shade(r.face, -0.2)); px(x + 11, y + 1, 4, 1, r.lit);   // cradle
    px(x + 12, y - 1, 1, 2, '#3a2c22'); px(x + 13, y - 2, 1, 2, '#8a7a5a');           // handle + shaft
    px(x + 13, y - 3, 1, 1, on ? (bad ? '#ff8f7a' : '#ffb060') : '#4a3a2a');          // tip
    if (on) bloom(x + 13, y - 3, 1, 1, bad ? ACC.alert : '#ff9d2e', 0.30);
    // parts tray + loose chips on the near edge
    px(x + 16, y + 1, 6, 3, U.shade(r.face, -0.15)); px(x + 16, y + 1, 6, 1, r.lit);
    px(x + 17, y + 2, 1, 1, ACC.flow); px(x + 19, y + 2, 1, 1, '#6a7a86'); px(x + 21, y + 2, 1, 1, '#b8452e');
    px(x + 17, y - 2, 3, 1, '#1c2620'); px(x + 17, y - 2, 1, 1, ACC.work);            // a small board on the top
    // FIRING: sparks jump off the workpiece and the whole top catches the run's colour
    if (fired > 0) {
      spill(x + 2, y - 3, w - 4, acc, 0.22 * fired, 5);
      for (let i = 0; i < 4; i++) {
        const t = (now / 90 + i * 0.37) % 1;
        px(x + 4 + Math.round(t * 5), y - 4 - Math.round(t * 4 - t * t * 3), 1, 1, t < 0.7 ? hot : U.shade(acc, -0.2));
      }
      bloom(x + 2, y - 4, 6, 3, acc, 0.28 * fired);
    }
    // short apron / front lip, with the run-status underglow strip (green pulse / red fail)
    rr(x - 1, y + 5, w + 2, 5, LINE);
    px(x, y + 6, w, 3, r.face);
    px(x, y + 6, w, 1, r.lit); keyEdge(x + 1, y + 6, w - 3, 1, 0.14);
    for (let i = 0; i < 4; i++) px(x + 4 + i * 5, y + 7, 3, 1, U.shade(r.face, -0.34)); // tool-drawer slots
    px(x, y + 8, w, 1, r.ao);
    glow(x + 1, y + 8, w - 2, 1, acc, fired > 0 ? 0.30 + 0.5 * fired : 0.06); // fires green, red on bad
  };
  F.etsy_threadrack = (x, y, w, h, f) => { // v4 spool rack (2x1) — freestanding; thread stays MATTE, the feed eye tells
    const r = RAMP.gun, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 4]) {                     // stub legs
      px(lx - 1, y + 8, 4, 4, LINE);
      px(lx, y + 8, 1, 3, r.lit); px(lx + 1, y + 8, 1, 3, r.dk);
      rimEdge(lx + 1, y + 9, 1, 2, 0.16);
      px(lx, y + h - 1, 2, 1, r.ao);
    }
    underAO(x + 4, y + 8, w - 8, 2);
    cable(x + 4, y + 9, x + w - 5, y + 9, 1.6, '#171d1a');     // slack lead slung under the rack
    // short face rail: spool ends seen edge-on
    chamf(x, y + 4, w, 5, LINE, 1);
    px(x + 1, y + 5, w - 2, 3, r.face);
    px(x + 1, y + 5, w - 2, 1, r.lit); keyEdge(x + 2, y + 5, w - 6, 1, 0.15);
    px(x + w - 2, y + 6, 1, 2, r.dk); rimEdge(x + w - 2, y + 6, 1, 2, 0.20);
    px(x + 1, y + 7, w - 2, 1, r.ao);
    for (let i = 0; i < 3; i++) {
      const fx2 = x + 4 + i * 6, c = i === 1 ? '#d8cdb8' : '#e0a256';
      rr(fx2, y + 5, 3, 3, U.shade(c, -0.30));
      px(fx2 + 1, y + 5, 1, 1, U.shade(c, 0.08)); px(fx2 + 1, y + 6, 1, 1, '#141a1e');   // hub
    }
    const per = on ? 900 : 1800;                               // feed LED runs hot on a live job (kept both rates)
    px(x + w - 3, y + 6, 1, 1, blink(per) ? ACC.flow : '#28323a');
    if (blink(per)) bloom(x + w - 3, y + 6, 1, 1, ACC.flow, 0.24);
    // chamfered top tray
    chamf(x - 1, y - 3, w + 2, 8, LINE, 2);
    chamf(x, y - 2, w, 6, r.top, 1);
    px(x + 2, y - 2, w - 4, 1, r.sheen); keyEdge(x + 2, y - 2, 8, 1, 0.26);
    px(x, y - 1, 1, 4, r.lit); px(x + w - 1, y - 1, 1, 4, r.dk); rimEdge(x + w - 1, y - 1, 1, 4, 0.20);
    px(x + 1, y + 3, w - 2, 1, U.shade(r.top, -0.18));
    // upright spools: wound thread reads by BANDING, not by a sheen row — it is fibre, not plastic
    const cols2 = ['#e0a256', '#d8a86a', '#d8cdb8', '#c98a3a'];
    for (let i = 0; i < 4; i++) {
      const sx2 = x + 2 + i * 5, c = cols2[(i + (U.hash('threadrack') % 2)) % cols2.length];   // kept hash seed
      rr(sx2 - 1, y - 5, 6, 6, LINE);
      px(sx2, y, 4, 1, U.shade(c, -0.40));                     // base flange under the winding
      rr(sx2, y - 4, 4, 4, U.shade(c, -0.12));
      px(sx2 + 1, y - 4, 2, 1, U.shade(c, 0.22));
      for (let j = 0; j < 2; j++) px(sx2, y - 3 + j, 4, 1, U.shade(c, j ? -0.22 : 0.06));
      px(sx2 + 1, y - 3, 1, 1, '#141a1e');                     // hub hole
      px(sx2 + 3, y - 3, 1, 2, U.shade(c, -0.36));             // shaded east of the reel
      if (i === 1 || i === 3) px(sx2 + 1, y + 1, 1, 3, U.shade(c, -0.06));   // dangling tails (kept)
    }
    // a real THREAD PATH: one strand off the west spool up through a guide eye — says what the rack is FOR
    const guide = x + w - 6;
    px(guide, y - 8, 3, 3, LINE); px(guide, y - 8, 3, 1, r.top); px(guide + 1, y - 7, 1, 1, '#0e1311');
    keyEdge(guide, y - 8, 2, 1, 0.22);
    cable(x + 4, y - 3, guide + 1, y - 7, -1.8, U.shade('#e0a256', -0.18));
    if (on) px(x + 5 + Math.floor((now / 260 + ph) % 8), y - 4, 1, 1, U.shade('#e0a256', 0.24));  // the strand feeding
  };
  F.etsy_dyevat = (x, y, w, h, f) => { // v4 dye vat (2x2) — bolted bath: dark body, LIT MENISCUS, dye light up the rim
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 16, w, h - 16);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 4, y + 15, x + w + 2, y + h - 3, 2);
    // rounded drum — warm key down the west curve, cool sky bounce down the east
    chamf(x, y + 4, w, 13, LINE, 2);
    px(x + 1, y + 5, w - 2, 11, r.face);
    px(x + 1, y + 5, 2, 11, r.lit); keyEdge(x + 1, y + 6, 1, 8, 0.18);
    px(x + w - 3, y + 5, 2, 11, r.dk); rimEdge(x + w - 3, y + 6, 1, 8, 0.22);
    px(x + 2, y + 15, w - 4, 1, r.ao);
    px(x + 1, y + 10, w - 2, 1, U.shade(r.face, -0.28));       // drum hoop (kept)
    px(x + 1, y + 11, w - 2, 1, U.shade(r.face, 0.10));
    knurl(x + 3, y + 7, 7, 1, r.face);
    // the heating jacket leaks along a seam, hottest west of centre where the element sits
    const warm = on ? 0.44 + 0.18 * Math.sin(now / 400 + ph) : 0.15;
    for (let i = 0; i < w - 6; i++) {
      const a = warm * (0.28 + 0.72 * Math.exp(-Math.abs(i - (w - 6) * 0.38) / 5));
      ctx.globalAlpha = Math.max(0, Math.min(0.8, a)); px(x + 3 + i, y + 13, 1, 1, '#c9701a');
    }
    ctx.globalAlpha = 1;
    px(x + 2, y + 13, 5, 3, LINE); px(x + 3, y + 14, 3, 1, '#1b2422');    // control nub (kept)
    px(x + 4, y + 14, 1, 1, blink(900) ? ACC.work : '#16302a');
    if (blink(900) && on) bloom(x + 4, y + 14, 1, 1, ACC.work, 0.24);
    // the OVAL RIM + dye bath dominate the top
    const cx2 = x + w / 2, cy2 = y + 4;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2, 7.5, 0, 0, 6.2832); ctx.fillStyle = LINE; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 1, 6.5, 0, 0, 6.2832); ctx.fillStyle = r.top; ctx.fill();
    ctx.globalAlpha = 0.85; ctx.strokeStyle = r.sheen; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.5, w / 2 - 2.5, 5.5, 0, Math.PI * 1.02, Math.PI * 1.98); ctx.stroke();
    ctx.globalAlpha = 0.30; ctx.strokeStyle = SKY;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.5, w / 2 - 2.5, 5.5, 0, Math.PI * 0.08, Math.PI * 0.92); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, w / 2 - 3, 4.6, 0, 0, 6.2832); ctx.fillStyle = '#1c110c'; ctx.fill(); // dark body
    ctx.globalAlpha = on ? 0.44 : 0.20; ctx.strokeStyle = '#ff9d2e'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.4, w / 2 - 3.6, 4.0, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.globalAlpha = 1;                                        // ^ the bath lighting the far inner wall
    // concentric dye rings core->rim (kept hues), darker at the edge so the bath has depth
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, w / 2 - 4, 3.8, 0, 0, 6.2832); ctx.fillStyle = on ? '#c9701a' : '#8a5016'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, w / 2 - 5.5, 3, 0, 0, 6.2832); ctx.fillStyle = U.shade(on ? '#c9701a' : '#8a5016', 0.16); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.3, w / 2 - 7, 2.2, 0, 0, 6.2832); ctx.fillStyle = on ? '#ff9d2e' : '#a8641e'; ctx.fill();
    ctx.globalAlpha = 0.75; ctx.strokeStyle = '#ffd9a0'; ctx.lineWidth = 1;   // LIT MENISCUS on the near lip
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.4, w / 2 - 4.4, 3.3, 0, Math.PI * 0.12, Math.PI * 0.88); ctx.stroke();
    const rp = now / 1400;                                      // drifting ripples (kept)
    ctx.globalAlpha = 0.5; ctx.strokeStyle = U.shade('#ff9d2e', 0.30);
    for (let i = 0; i < 3; i++) {
      const cr = (w / 2 - 6) * (0.35 + i * 0.22) + Math.sin(rp + i + ph) * 0.6;
      ctx.beginPath();
      ctx.ellipse(cx2, cy2 + 0.4, cr, cr * 0.4, 0, Math.PI * (0.9 + i * 0.15), Math.PI * (1.7 + i * 0.15));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const bt = (now / 2600) % 1;                                // surfacing bubble (kept)
    if (bt < 0.6) {
      const by3 = Math.round(cy2 - bt * 2);
      px(Math.round(cx2 - 3), by3, 1, 1, U.shade('#ff9d2e', 0.40));
      if (bt > 0.4) px(Math.round(cx2 - 3), by3, 1, 1, '#ffeccc');
    }
    ctx.restore();
    bloom(x + 4, y, w - 8, 7, '#ff9d2e', (on ? 0.14 : 0.07) + 0.04 * Math.sin(now / 800 + ph));  // pool glow (kept)
    // dip-arm over the east rim, holding a half-submerged swatch that is STAINED below the waterline
    px(x + w - 7, y - 5, 5, 3, LINE); px(x + w - 6, y - 4, 3, 1, U.shade('#5a665e', 0.24));
    keyEdge(x + w - 6, y - 4, 2, 1, 0.22);
    px(x + w - 6, y - 2, 2, 3, '#4a544d'); px(x + w - 6, y - 2, 1, 3, U.shade('#4a544d', 0.18));
    px(x + w - 8, y + 1, 3, 2, '#4a544d');
    px(x + w - 12, y + 1, 5, 2, '#e0e4de'); px(x + w - 12, y + 1, 5, 1, '#f2f4ee');   // clean cloth above
    px(x + w - 12, y + 3, 5, 1, '#d8945a'); px(x + w - 11, y + 4, 3, 1, '#c9701a');   // stained below
    glow(x + w - 12, y + 3, 5, 2, '#ff9d2e', on ? 0.20 : 0.08);
  };
  F.etsy_kiln = (x, y, w, h, f) => { // v4 kiln (2x2) — firelight LEAKS from the lid seam and door gap, never a flat disc
    const r = RAMP.gun, on = !!(f && f.work), ph = (f && f.x) || 0;
    const breath = 0.5 + 0.5 * Math.sin(now / 1000 + ph);      // breathing heat (kept 1000)
    const heat = (on ? 0.58 : 0.24) + 0.28 * breath;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 16, w, h - 16);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 4, y + 15, x + w + 2, y + h - 3, 2);
    // short front face carrying the CHARGING DOOR — a hinged plate whose gap leaks light down one edge
    chamf(x - 1, y + 10, w + 2, 7, LINE, 2);
    px(x, y + 11, w, 5, r.face);
    px(x, y + 11, w, 1, r.lit); keyEdge(x + 1, y + 11, w - 5, 1, 0.15);
    px(x + w - 1, y + 12, 1, 3, r.dk); rimEdge(x + w - 1, y + 12, 1, 3, 0.20);
    px(x, y + 15, w, 1, r.ao);
    px(x + 2, y + 11, 10, 5, U.shade(r.face, -0.10));          // the door plate
    px(x + 2, y + 11, 1, 5, U.shade(r.face, 0.16));            // hinge stile
    px(x + 11, y + 12, 1, 3, U.shade(r.face, -0.45));          // latch stile
    for (let i = 0; i < 3; i++) {                              // grille in the door — heat behind each slit (kept)
      px(x + 4 + i * 3, y + 14, 2, 1, '#141a17');
      glow(x + 4 + i * 3, y + 14, 2, 1, '#ff7a1a', heat * 0.26);
    }
    px(x + 5, y + 12, 3, 1, U.shade(r.face, 0.10)); px(x + 5, y + 13, 3, 1, U.shade(r.face, -0.5)); // handle
    for (let j = 0; j < 4; j++) {                              // the DOOR GAP, hottest at the top of the seam
      ctx.globalAlpha = Math.min(0.85, heat * (0.95 - j * 0.19));
      px(x + 12, y + 12 + j, 1, 1, j < 2 ? '#ffd34a' : '#ff7a1a');
      ctx.globalAlpha = 1;
    }
    bloom(x + 12, y + 12, 1, 4, '#ff7a1a', heat * 0.24);
    inset(x + w - 9, y + 12, 7, 3, '#191e1b');                 // 3-seg readout (kept, breath-tied)
    for (let s = 0; s < 3; s++) px(x + w - 8 + s * 2, y + 13, 1, 1, breath > s / 3.2 ? ACC.flow : '#28323a');
    // big refractory dome
    chamf(x - 1, y - 3, w + 2, 14, LINE, 2);
    chamf(x, y - 2, w, 12, r.top, 2);
    px(x + 2, y - 2, w - 4, 1, r.sheen); keyEdge(x + 2, y - 2, 8, 1, 0.28);
    px(x, y, 1, 8, r.lit); px(x + w - 1, y, 1, 8, r.dk); rimEdge(x + w - 1, y, 1, 8, 0.20);
    px(x + 1, y + 9, w - 2, 1, U.shade(r.top, -0.18));
    chamf(x + 2, y - 1, w - 4, 9, U.shade(r.top, 0.08), 2);    // dome step
    px(x + 3, y - 1, w - 6, 1, U.shade(r.top, 0.20));
    px(x + 2, y - 2, 1, 1, U.shade(r.top, 0.30)); px(x + w - 3, y - 2, 1, 1, U.shade(r.top, 0.30)); // dome bolts (kept)
    wear(x + 3, y + 4, w - 6, 4, 3, U.shade(r.top, -0.12));
    // the LID: a seated ring. Light escapes at the SEAM (a crescent, hottest west) and through the spy-hole.
    const cx2 = x + w / 2, cy2 = y + 4, R2 = 6;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, R2 + 1.4, R2 * 0.72 + 1.2, 0, 0, 6.2832); ctx.fillStyle = LINE; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2, cy2, R2 + 0.4, R2 * 0.72 + 0.4, 0, 0, 6.2832); ctx.fillStyle = U.shade(r.top, -0.20); ctx.fill();
    ctx.globalAlpha = 0.9; ctx.strokeStyle = r.sheen; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.4, R2, R2 * 0.72, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.globalAlpha = 0.30; ctx.strokeStyle = SKY;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 - 0.4, R2, R2 * 0.72, 0, Math.PI * 0.10, Math.PI * 0.90); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, R2 - 1.2, R2 * 0.72 - 1.0, 0, 0, 6.2832); ctx.fillStyle = U.shade(r.top, 0.06); ctx.fill();
    ctx.globalAlpha = Math.min(0.9, heat); ctx.strokeStyle = '#ff7a1a'; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.2, R2 - 0.6, R2 * 0.72 - 0.5, 0, Math.PI * 0.85, Math.PI * 2.05); ctx.stroke();
    ctx.globalAlpha = Math.min(0.8, heat * 0.7); ctx.strokeStyle = '#ffd34a';
    ctx.beginPath(); ctx.ellipse(cx2, cy2 + 0.2, R2 - 0.6, R2 * 0.72 - 0.5, 0, Math.PI * 1.10, Math.PI * 1.60); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.ellipse(cx2 + 1, cy2, 2.2, 1.6, 0, 0, 6.2832); ctx.fillStyle = '#2a1408'; ctx.fill();  // spy-hole
    ctx.beginPath(); ctx.ellipse(cx2 + 1, cy2, 1.6, 1.1, 0, 0, 6.2832); ctx.fillStyle = on ? '#ff7a1a' : '#8a3d10'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2 + 1, cy2, 0.8, 0.6, 0, 0, 6.2832); ctx.fillStyle = on ? '#ffd34a' : '#b0561a'; ctx.fill();
    ctx.restore();
    px(Math.round(cx2) - 5, Math.round(cy2) - 1, 3, 1, U.shade(r.top, 0.24));   // lid handle
    px(Math.round(cx2) - 5, Math.round(cy2), 3, 1, U.shade(r.top, -0.34));
    bloom(Math.round(cx2) - 5, Math.round(cy2) - 3, 10, 6, '#ff9d2e', heat * 0.20);
    spill(x + 3, y + 8, w - 6, '#ff9d2e', heat * 0.13, 3);     // seam light washing down the dome's front
    // vent stack on the west shoulder, shimmer rising off it (kept 420)
    chamf(x + 1, y - 7, 6, 6, LINE, 1);
    px(x + 2, y - 6, 4, 4, U.shade(r.face, 0.06)); px(x + 2, y - 6, 4, 1, r.top);
    keyEdge(x + 2, y - 6, 3, 1, 0.24);
    px(x + 5, y - 5, 1, 3, r.dk); rimEdge(x + 5, y - 5, 1, 3, 0.20);
    px(x + 3, y - 5, 2, 2, '#0e1311');                         // the flue's dark mouth
    glow(x + 3, y - 5, 2, 2, '#ff7a1a', heat * 0.30);
    if (blink(420)) px(x + 3, y - 9, 1, 1, '#6a7882');
    else if (blink(420, 0.5)) px(x + 4, y - 10, 1, 1, '#46525a');
    px(x + 4, y - 8, 1, 1, U.shade('#6a7882', -0.35));
  };
  F.etsy_packbot = (x, y, w, h, f) => { // v4 pack bot (2x2) — a machine with INTENT: head, shoulder, elbow, a working dip
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    const seg = (x0, y0, x1, y1, c) => { cable(x0, y0 + 1, x1, y1 + 1, 0, LINE); cable(x0, y0, x1, y1, 0, c); }; // 2px linkage
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x, y + 15, w, h - 15);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 4, y + 14, x + w + 2, y + h - 3, 2);
    // short front face: vents + the run lamp (kept 420)
    chamf(x - 1, y + 9, w + 2, 7, LINE, 2);
    px(x, y + 10, w, 5, r.face);
    px(x, y + 10, w, 1, r.lit); keyEdge(x + 1, y + 10, w - 5, 1, 0.15);
    px(x + w - 1, y + 11, 1, 3, r.dk); rimEdge(x + w - 1, y + 11, 1, 3, 0.20);
    px(x, y + 14, w, 1, r.ao);
    for (let i = 0; i < 4; i++) { px(x + w - 11 + i * 2, y + 12, 1, 2, r.ao); px(x + w - 10 + i * 2, y + 12, 1, 2, U.shade(r.face, 0.12)); }
    if (on) {
      px(x + 3, y + 11, 2, 2, blink(420) ? '#ffb43a' : '#28323a');
      if (blink(420)) bloom(x + 3, y + 11, 2, 2, '#ff9d2e', 0.28);
    } else {
      px(x + 3, y + 11, 2, 2, '#28323a'); px(x + 3, y + 11, 1, 1, '#36424c');
      px(x + 4, y + 12, 1, 1, blink(1800, ph) ? U.shade(ACC.flow, -0.25) : '#33241a');   // standby heartbeat
    }
    // top work deck
    chamf(x - 1, y - 2, w + 2, 13, LINE, 2);
    chamf(x, y - 1, w, 11, r.top, 2);
    px(x + 2, y - 1, w - 4, 1, r.sheen); keyEdge(x + 2, y - 1, 8, 1, 0.28);
    px(x, y + 1, 1, 7, r.lit); px(x + w - 1, y + 1, 1, 7, r.dk); rimEdge(x + w - 1, y + 1, 1, 7, 0.20);
    px(x + 1, y + 9, w - 2, 1, U.shade(r.top, -0.18));
    for (let i = 0; i < 4; i++) { px(x + 1, y + 1 + i * 2, 3, 1, U.shade(r.top, -0.34)); px(x + 1, y + 2 + i * 2, 3, 1, U.shade(r.top, 0.08)); } // feed rollers
    // the shipping case on the deck (kept: flap seam, label, barcode)
    const bx = x + 6, by2 = y, bw = 12, bh = 8;
    chamf(bx - 1, by2 - 1, bw + 2, bh + 2, LINE, 1);
    px(bx, by2, bw, bh, '#36424c');
    px(bx, by2, bw, 1, U.shade('#36424c', 0.24)); keyEdge(bx + 1, by2, 5, 1, 0.16);
    px(bx, by2, 1, bh, U.shade('#36424c', 0.10));
    px(bx + bw - 1, by2 + 1, 1, bh - 1, U.shade('#36424c', -0.30)); rimEdge(bx + bw - 1, by2 + 1, 1, bh - 1, 0.18);
    px(bx, by2 + bh - 1, bw, 1, U.shade('#36424c', -0.34));
    px(bx + (bw >> 1), by2 + 1, 1, bh - 2, '#28323a');         // half-open flap seam
    px(bx + 1, by2 + 2, (bw >> 1) - 1, 1, '#46525a');          // sealed-side catch
    px(bx + 1, by2 + 1, 5, 5, '#e08a28'); px(bx + 1, by2 + 1, 5, 1, U.shade('#e08a28', 0.24)); // label
    px(bx + 2, by2 + 4, 3, 1, '#1a2228'); px(bx + 2, by2 + 5, 3, 1, '#1a2228');                // barcode
    // ---- the ARM. Idle it parks raised with the head watching; working it reaches, DIPS into the case,
    // pinches shut and lifts. This is the family's one prop with agency, so the motion has to carry it.
    const cyc = on ? (now / 2400 + ph * 0.17) % 1 : 0;
    const dip = on ? Math.max(0, Math.sin(cyc * 6.2832)) : 0;             // 0 raised, 1 deep in the case
    const reach = on ? 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(cyc * 6.2832)) : 0.12;
    const shX = x + w - 5, shY = y - 6;
    const elX = Math.round(shX - 5 - reach * 3), elY = Math.round(shY + 1 + dip * 2);
    const gpX = Math.round(bx + 3 + reach * 4), gpY = Math.round(shY + 3 + dip * 6);
    px(shX - 2, shY, 4, 12, LINE);                                        // mast planted in the deck
    px(shX - 1, shY + 1, 1, 10, '#5f6d64'); px(shX, shY + 1, 1, 10, '#3a423c');
    rimEdge(shX, shY + 2, 1, 8, 0.18);
    px(shX - 2, shY - 2, 5, 3, LINE); px(shX - 1, shY - 1, 3, 1, '#6e7a70'); keyEdge(shX - 1, shY - 1, 2, 1, 0.24);
    seg(shX - 1, shY + 2, elX, elY, '#5f6d64');                           // upper arm
    seg(elX, elY, gpX, gpY, '#54615a');                                   // forearm
    px(elX - 1, elY - 1, 3, 3, LINE); px(elX, elY, 1, 1, '#7d8a80');      // elbow puck
    const grip = dip > 0.72 ? 0 : 1;                                      // fingers PINCH at the bottom of the dip
    px(gpX - 3, gpY - 1, 7, 3, LINE);
    px(gpX - 2, gpY, 5, 1, U.shade('#6b766e', 0.12));
    px(gpX - 2 - grip, gpY + 2, 1, 2, '#8a968e'); px(gpX + 2 + grip, gpY + 2, 1, 2, '#8a968e');
    px(gpX - 2 - grip, gpY + 3, 1, 1, '#3a423c'); px(gpX + 2 + grip, gpY + 3, 1, 1, '#3a423c');
    if (on && dip > 0.72) { px(gpX - 1, gpY + 3, 3, 1, U.shade(ACC.work, -0.20)); bloom(gpX - 1, gpY + 3, 3, 1, ACC.work, 0.24); }
    // HEAD on the mast: a sensor pod whose EYE tracks the gripper — the tell that it is paying attention
    const hx = shX - 5, hy = shY - 6;
    chamf(hx - 1, hy - 1, 9, 7, LINE, 1);
    px(hx, hy, 7, 5, U.shade(r.face, 0.04)); px(hx, hy, 7, 1, r.top); keyEdge(hx, hy, 4, 1, 0.26);
    px(hx + 6, hy + 1, 1, 4, r.dk); rimEdge(hx + 6, hy + 1, 1, 4, 0.20);
    inset(hx + 1, hy + 1, 5, 3, '#0b1a1e');
    const look = on ? Math.round(-1 + reach * 2) : 0;
    px(hx + 2 + look, hy + 2, 2, 1, on ? '#9fe8ff' : U.shade(ACC.data, -0.55));
    if (on) bloom(hx + 2 + look, hy + 2, 2, 1, ACC.data, 0.30);
    px(hx + 3, hy - 2, 1, 2, r.face); px(hx + 3, hy - 3, 1, 1, blink(1200, ph) ? ACC.flow : '#33241a'); // status whip
    cable(hx + 7, hy + 4, shX - 1, shY + 1, 1.2, '#141b20');              // umbilical into the mast
    if (on) {
      const sweep = bx + Math.floor(((now / 900) % 1) * bw);              // scan sweep (kept 900)
      px(sweep, by2, 1, bh, '#cffcff');
      bloom(sweep - 1, by2, 3, bh, ACC.data, 0.24);
      spill(bx, by2 + bh, bw, ACC.data, 0.16, 3);                         // scan light pools onto the deck
      if (cyc > 0.78) px(bx + (bw >> 1) - 1, by2, 3, bh, U.shade('#d8d0c0', -0.10));   // tape laid down the seam
    }
  };
  F.gigs_thumbwall = (x, y, w, h, f) => {
    // THUMB WALL (2x1, blocks:FALSE) — v4 REBUILD. It was on rolling casters, i.e. freestanding machinery,
    // which is exactly wrong for a prop agents walk in front of. Now a SHALLOW wall-hung order rail on two
    // lugs with a bulkhead cast and no floor contact. The motion is the QUEUE ADVANCING: cards slide west and
    // a fresh one enters at the east edge, so the wall shows work arriving rather than a frozen 3x2 grid.
    // Kept: the tint set, the pulsing NEW-ORDER card in ACC.mem, the star rows, the violet status LED.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bt = y - 9, bh = 17;                                    // y-9..y+7 — air under it, it hangs
    ctx.globalAlpha = 0.20; px(x + 2, bt + 3, w, bh, '#000'); ctx.globalAlpha = 1;
    for (const lx of [x + 5, x + w - 7]) {
      px(lx, bt - 3, 2, 4, LINE); px(lx, bt - 3, 2, 1, U.shade(r.top, 0.20));
      rimEdge(lx + 1, bt - 2, 1, 3, 0.18);
    }
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 2, bt, w - 4, 1, r.top); keyEdge(x + 2, bt, 8, 1, 0.28);
    px(x, bt + 2, 1, bh - 4, r.lit); px(x + w - 1, bt + 2, 1, bh - 4, r.dk);
    rimEdge(x + w - 1, bt + 2, 1, bh - 4, 0.22);
    px(x + 2, bt + bh - 1, w - 4, 1, r.ao);
    for (const sx of [x + 2, x + w - 3]) { px(sx, bt + 2, 1, 1, U.shade(r.top, 0.28)); px(sx, bt + bh - 3, 1, 1, r.ao); }
    const wx = x + 2, ww = w - 4, wy = bt + 2, wh = 12;
    inset(wx, wy, ww, wh, '#141a1d');
    // the rail advances one card every 540ms; absolute index seeds the tint so cards don't shimmer as they move
    const step = Math.floor(now / (on ? 380 : 540));
    const slide = Math.floor(((now % (on ? 380 : 540)) / (on ? 380 : 540)) * 6);
    ctx.save(); ctx.beginPath(); ctx.rect(wx + 1, wy + 1, ww - 2, wh - 2); ctx.clip();
    const tints = ['#41ff8a', '#7fd0ff', '#f0ece4'];
    const pulse = blink(1200, ph) ? 1 : 0;
    for (let rj = 0; rj < 2; rj++) for (let k = 0; k < 5; k++) {
      const idx = step + k + rj * 3;
      const cx = wx + 1 + k * 6 - slide, cy = wy + 1 + rj * 5;
      const isNew = (idx % 7) === 0;                              // the NEW ORDER slot, riding the queue
      px(cx + 4, cy, 1, 3, '#0c0f11');                            // card drop shadow
      if (isNew) {
        const base = pulse ? ACC.mem : U.shade(ACC.mem, -0.34);
        px(cx, cy, 4, 3, base); px(cx, cy, 4, 1, pulse ? '#d79bff' : U.shade(ACC.mem, 0.14));
        if (pulse) bloom(cx, cy, 4, 3, ACC.mem, 0.34);
      } else {
        const col = tints[U.hash('gig' + idx) % 3];
        px(cx, cy, 4, 3, col);
        px(cx, cy, 4, 1, U.shade(col, 0.30)); keyEdge(cx, cy, 3, 1, 0.22);
        px(cx, cy + 2, 4, 1, U.shade(col, -0.40));
      }
      for (let s = 0; s < 4; s++) px(cx + s, cy + 3, 1, 1, s < 1 + (U.hash('st' + idx) % 4) ? '#ffd23a' : '#2e2a18');
    }
    ctx.restore();
    px(wx + 1, wy + 1, 1, wh - 2, U.shade(r.face, -0.5));         // intake edge the cards feed past
    px(wx + ww - 2, wy + 1, 1, wh - 2, U.shade(r.face, -0.5));
    px(x + 2, bt + bh - 3, 1, 1, blink(700, ph) ? ACC.mem : '#3a2050');   // kept violet status LED
    if (blink(700, ph)) bloom(x + 2, bt + bh - 3, 1, 1, ACC.mem, 0.26);
    wear(x + 1, bt + 1, w - 2, bh - 2, 3, U.shade(r.face, -0.10));
  };
  F.gigs_servercart = (x, y, w, h, f) => {   // v4 blade cart (1x1) — the memory family's SMALL, MOBILE one: it rolls
    // Only 12px square, so it lives or dies on silhouette: a chrome push-handle overdrawing north, a big top, and
    // one bright purple scan head in the blade well. Everything finer than that disappears on a dim floor.
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    for (const wx of [x + 2, x + w - 4]) {                            // casters (mobile — no deck plate, it rolls)
      px(wx, y + h - 3, 2, 3, LINE); px(wx, y + h - 3, 1, 1, r.lit); px(wx, y + h - 1, 2, 1, '#0a0d0f');
    }
    px(x + w - 1, y + h - 5, 2, 1, '#0a0b0c'); px(x + w, y + h - 4, 1, 2, '#0a0b0c');   // coiled lead on the floor
    // short front face holding the blade well
    chamf(x - 1, y + 2, w + 2, h - 4, LINE, 2);
    px(x, y + 3, w, h - 6, r.face);
    px(x, y + 3, w, 1, r.lit); keyEdge(x + 1, y + 3, w - 3, 1, 0.16);
    px(x, y + 4, 1, h - 8, U.shade(r.face, 0.08)); px(x + w - 1, y + 4, 1, h - 8, r.dk);
    rimEdge(x + w - 1, y + 4, 1, h - 8, 0.20);
    inset(x + 2, y + 4, w - 4, 5, '#12081c');                         // blade well
    const nrow = 3, scan = Math.floor((now / 130) % (nrow + 1));      // purple data scroll across the blades (kept)
    for (let ru = 0; ru < nrow; ru++) {
      const ry = y + 5 + ru;
      px(x + 3, ry, w - 6, 1, ru % 2 ? U.shade(r.face, -0.10) : U.shade(r.face, 0.02));   // blade body
      px(x + 3, ry, 1, 1, '#0c0e10');                                 // vent slit
      const hot = (nrow - 1 - ru) === scan;                           // the scroll head lights this blade
      const lit = blink(360 + ru * 110, ru + ph);
      px(x + 5, ry, 3, 1, hot ? '#e0b8ff' : lit ? ACC.mem : U.shade(ACC.mem, -0.62));
      if (hot) bloom(x + 5, ry, 3, 1, ACC.mem, 0.34);
    }
    bloom(x + 3, y + 5, w - 6, 3, ACC.mem, 0.10 + 0.05 * Math.sin(now / 300));
    spill(x + 2, y + 9, w - 4, ACC.mem, 0.16, 3);                     // well light pools onto the lower face
    px(x, y + h - 4, w, 1, r.ao);                                     // floor-line AO
    // big TOP surface + the chrome push handle (the shape that says CART at 3x)
    chamf(x - 1, y - 4, w + 2, 7, LINE, 2);
    chamf(x, y - 3, w, 6, r.top, 2);
    px(x + 2, y - 3, w - 4, 1, r.sheen); keyEdge(x + 2, y - 3, 5, 1, 0.30);
    px(x, y - 1, 1, 3, r.lit); px(x + w - 1, y - 1, 1, 3, r.dk);
    rimEdge(x + w - 1, y - 1, 1, 3, 0.20);
    px(x + 2, y, w - 4, 1, U.shade(r.top, 0.06));                     // brushed streak
    px(x + 2, y + 2, w - 4, 1, U.shade(r.top, -0.18));                // top front edge
    px(x + 2, y - 6, 2, 3, U.shade(r.face, -0.10)); px(x + w - 4, y - 6, 2, 3, U.shade(r.face, -0.10)); // handle posts
    px(x + 2, y - 7, w - 4, 1, '#aeb6c0'); px(x + 2, y - 7, 1, 1, '#6c727a'); px(x + w - 3, y - 7, 1, 1, '#6c727a');
    keyEdge(x + 3, y - 7, 4, 1, 0.26);
    if (on) bloom(x + 3, y + 5, w - 6, 3, ACC.mem, 0.10 + 0.05 * Math.sin(now / 500));
  };
  F.gigs_partsbin = (x, y, w, h, f) => {
    // PARTS BIN (2x1) — the SCRAPPY member of the storage family: an open-top tote you look INTO. Same
    // steel ramp and hazard tick as the crates, but the shell is dented, patched with a mismatched panel
    // and missing its castings — this thing has been dropped. Four compartments of visible parts; every
    // kept blink (render sparkle, gem glint) still fires.
    const cw = w, r = RAMP.steel;
    shadow2(x + 1, y + h - 1, cw - 2);
    // short outer bin wall, scuffed
    rr(x, y + 3, cw, h - 4, LINE);
    px(x + 1, y + 4, cw - 2, h - 6, r.face);
    px(x + 1, y + 4, 1, h - 6, r.lit); px(x + cw - 2, y + 4, 1, h - 6, r.dk);
    rimEdge(x + cw - 2, y + 4, 1, h - 6, 0.20);
    px(x + 6, y + 5, 5, 3, U.shade(r.face, -0.22));                    // mismatched patch panel, riveted on
    px(x + 6, y + 5, 5, 1, U.shade(r.face, 0.04));
    px(x + 6, y + 5, 1, 1, U.shade(r.sheen, 0.20)); px(x + 10, y + 7, 1, 1, r.ao);
    px(x + 3, y + 4, 2, 1, r.dk); px(x + cw - 6, y + 4, 3, 1, r.sheen);          // dent + a bright rub
    px(x + (cw >> 1), y + h - 4, 2, 1, '#8a7434');                     // hazard tick — the family's shared mark
    wear(x + 2, y + 5, cw - 4, h - 8, 4, U.shade(r.face, -0.16));
    px(x + 1, y + h - 3, cw - 2, 1, r.ao);
    // OPEN TOP: a thick rim we look over, warm on the back edge, cool down the east wall
    rr(x - 1, y - 1, cw + 2, 7, LINE);
    px(x, y, cw, 6, r.top);
    px(x, y, cw, 1, r.sheen); keyEdge(x, y, 8, 1, 0.28);
    px(x, y, 1, 6, r.lit); px(x + cw - 1, y, 1, 6, r.dk);
    rimEdge(x + cw - 1, y, 1, 6, 0.22);
    px(x + 3, y, 3, 1, U.shade(r.top, -0.30));                         // a bent-in section of the rim
    // recessed interior, inset from the rim
    const ix = x + 2, iy = y + 1, iw = cw - 4, ih = 4;
    px(ix, iy, iw, ih, U.shade(r.face, -0.42));                        // interior back wall shade
    px(ix, iy + 1, iw, ih - 1, '#161c22');                             // interior floor
    rimEdge(ix + iw - 1, iy, 1, ih, 0.14);                             // sky reaches the east inner wall
    px(ix, iy + ih, iw, 1, U.shade(r.top, -0.20));                     // front inner lip
    const cc = (iw - 3) / 4;
    for (let d = 1; d < 4; d++) {
      const dx = Math.round(ix + d * cc + (d - 1));
      px(dx, iy, 1, ih, '#0d1116'); px(dx, iy, 1, 1, U.shade(r.face, 0.10));   // divider, lit top edge
    }
    const cx0 = i => Math.round(ix + i * (cc + 1)) + 1;
    // c0: green sprite-chip swatch
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++)
      px(cx0(0) + sx, iy + 1 + sy, 1, 1, (sx + sy) % 2 ? '#2faa55' : ACC.work);
    // c1: freshly-rendered teal chip stack, still warm (kept behaviour, now with falloff)
    const c1 = cx0(1), warm = 0.14 + 0.10 * Math.sin(now / 760);
    px(c1, iy + 2, 3, 2, '#1f8c7a'); px(c1, iy + 2, 3, 1, '#2ee6c8'); px(c1, iy + 1, 2, 1, '#43f0d6');
    bloom(c1, iy + 1, 3, 3, '#2ee6c8', warm);
    if (blink(900)) px(c1 + 1, iy + 1, 1, 1, '#d6fff6');               // render sparkle
    // c2: coil of orange filament
    const c2 = cx0(2);
    px(c2, iy + 1, 3, 3, '#b35a1c'); px(c2 + 1, iy + 2, 1, 1, '#3a2414');
    px(c2, iy + 1, 3, 1, '#ff9d2e'); px(c2 + 2, iy + 3, 1, 1, '#ffc870');
    // c3: loose screws + gems
    const c3 = cx0(3);
    px(c3, iy + 1, 1, 1, U.hash('scrw') % 2 ? '#e4e8e0' : '#c8ccc4');
    px(c3 + 2, iy + 2, 1, 1, '#9aa09a');
    px(c3, iy + 3, 1, 1, '#5ad6ff'); if (blink(1400, 2)) { px(c3, iy + 3, 1, 1, '#c4f4ff'); bloom(c3, iy + 3, 1, 1, '#5ad6ff', 0.24); }
    px(c3 + 2, iy + 3, 1, 1, '#ff7ad0');
    // mismatched feet — one is a block of scrap
    px(x + 1, y + h - 2, 2, 2, r.dk); px(x + cw - 3, y + h - 2, 2, 2, U.shade(r.dk, -0.2));
    px(x + 1, y + h - 2, 1, 1, r.lit); px(x + cw - 3, y + h - 2, 1, 1, U.shade(r.lit, -0.25));
    underAO(x + 3, y + h - 1, cw - 6, 1);
  };
  F.gigs_amp = (x, y, w, h, f) => {
    // AMP (1x1, blocks:true) — v4. Only 12px square, so it lives or dies on silhouette: the strap HANDLE
    // arching north off the crown is what names it as a cab before a single grille pixel resolves. The
    // movement is cone EXCURSION — the driver bulges and the purple backlight pumps on the beat, and while a
    // run is live two pressure rings break off the top. Kept: blink(360) bass throb, f.work power-lamp cycle.
    const r = RAMP.gun, ph = (f && f.x) || 0, on = !!(f && f.work);
    const beat = blink(360, ph);
    const exc = Math.max(0, Math.sin(now / 180 + ph));            // cone excursion 0..1
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 1, x + w - 3]) {                        // squat rubber feet
      px(lx, y + 9, 2, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 2, r.dk);
    }
    underAO(x + 3, y + 9, w - 6, 2);
    cable(x + w - 3, y + 8, x + w + 2, y + h - 1, 2);             // jack lead flopping onto the deck
    // strap handle — the whole read at 12px
    px(x + 3, y - 7, 6, 2, LINE); px(x + 4, y - 6, 4, 1, U.shade(r.top, 0.22));
    px(x + 3, y - 5, 1, 2, LINE); px(x + 8, y - 5, 1, 2, LINE);
    keyEdge(x + 4, y - 6, 3, 1, 0.26);
    // chamfered cab
    chamf(x - 1, y - 5, w + 2, 15, LINE, 2);
    chamf(x, y - 4, w, 13, r.face, 2);
    chamf(x + 1, y - 4, w - 2, 4, r.top, 2);                      // crown we look down on
    px(x + 2, y - 4, w - 4, 1, r.sheen); keyEdge(x + 2, y - 4, 5, 1, 0.30);
    px(x + 1, y - 1, w - 2, 1, U.shade(r.top, -0.20));            // crown front lip
    px(x, y + 1, 1, 6, r.lit); px(x + w - 1, y + 1, 1, 6, r.dk);
    rimEdge(x + w - 1, y + 1, 1, 6, 0.22);
    px(x + 1, y + 8, w - 2, 1, r.ao);
    // silver-piped grille cloth over the driver
    const gx = x + 2, gy = y + 1, gw = w - 4, gh = 6;
    px(gx - 1, gy - 1, gw + 2, gh + 2, '#8d938f');                // piping frame
    px(gx - 1, gy - 1, gw + 2, 1, '#b6bcb8'); px(gx - 1, gy - 1, 1, gh + 2, '#a4aaa6');
    rimEdge(gx + gw, gy, 1, gh, 0.22);
    inset(gx, gy, gw, gh, '#141416');
    for (let rj = 0; rj < gh; rj++) for (let c = 0; c < gw; c++)
      if (((rj + c) & 1) === 0) px(gx + c, gy + rj, 1, 1, beat ? '#3a2150' : '#232329');
    // the DRIVER itself pushing air — a lit dome that swells with the beat, not a flat backlight rect
    const rad = 1 + Math.round(exc * (beat ? 1.6 : 0.6));
    const dcx = gx + (gw >> 1), dcy = gy + (gh >> 1);
    px(dcx - rad, dcy - rad, rad * 2, rad * 2, U.shade(ACC.mem, -0.30));
    px(dcx - rad, dcy - rad, rad * 2, 1, U.shade(ACC.mem, 0.20));
    bloom(dcx - rad, dcy - rad, rad * 2, rad * 2, ACC.mem, (beat ? 0.30 : 0.14) + 0.14 * exc);
    spill(gx, gy + gh + 1, gw, ACC.mem, beat ? 0.14 : 0.06, 2);
    // pressure rings breaking off the cab while a run is live
    if (on) {
      ctx.save(); ctx.strokeStyle = ACC.mem; ctx.lineWidth = 1;
      for (let k = 0; k < 2; k++) {
        const t = ((now / 700) + k / 2) % 1;
        ctx.globalAlpha = 0.30 * (1 - t) * (1 - t);
        ctx.beginPath(); ctx.arc(dcx, y - 2, 3 + t * 11, -2.7, -0.45); ctx.stroke();
      }
      ctx.restore();
    }
    dial(x + 1, y - 4, r.top, now / 800 + ph);                    // gain
    dial(x + 5, y - 4, r.top, -now / 620 + ph);                   // tone
    const lamp = on ? blink(900, ph) : true;                      // kept: idle steady, live pulsing
    px(x + w - 3, y - 3, 1, 1, lamp ? '#ff6a4a' : '#3a1612');
    if (lamp) bloom(x + w - 3, y - 3, 1, 1, '#ff6a4a', 0.28);
  };
  F.treasury_coinsorter = (x, y, w, h, f) => {
    // COIN SORTER (2x1) — storage as MACHINE: the family shell (steel ramp, chamfered deck, hazard tick)
    // with a sorting bay milled into it. Left 2/3 = open bay where coin stacks jitter as they're counted;
    // right 1/3 = the counter tower. Wealth stays in the gold and the phosphor, never in the casing.
    // NOTE: the old counter passed U.shade an integer k (-10) — out of the -1..1 contract; fixed here.
    const cw = w, r = RAMP.steel, gold = ACC.flow, on = (f && f.work) ? 1 : 0.35;
    shadow2(x + 1, y + h - 1, cw - 2);
    // short front face
    rr(x, y + 4, cw, h - 5, LINE);
    px(x + 1, y + 5, cw - 2, h - 7, r.face);
    px(x + 1, y + 5, cw - 2, 1, r.lit); keyEdge(x + 2, y + 5, cw - 5, 1, 0.14);
    px(x + cw - 2, y + 5, 1, h - 7, r.dk); rimEdge(x + cw - 2, y + 5, 1, h - 7, 0.20);
    px(x + 2, y + h - 4, 2, 1, '#8a7434');                             // hazard tick
    px(x + 1, y + h - 3, cw - 2, 1, r.ao);
    // chamfered top deck
    chamf(x - 1, y - 3, cw + 2, 9, LINE, 2);
    chamf(x, y - 2, cw, 7, r.top, 2);
    px(x + 2, y - 2, cw - 4, 1, r.sheen); keyEdge(x + 2, y - 2, 8, 1, 0.28);
    px(x, y, 1, 4, r.lit); px(x + cw - 1, y, 1, 4, r.dk); rimEdge(x + cw - 1, y, 1, 4, 0.20);
    px(x + 1, y + 4, cw - 2, 1, U.shade(r.top, -0.16));                // deck front lip
    knurl(x + 2, y - 1, 8, 1, r.top);                                  // machined grip along the hopper mouth
    // LEFT 2/3: the recessed sorting bay, open so the coin stacks are visible
    const hw = Math.floor((cw - 2) * 2 / 3);
    inset(x + 1, y + 4, hw, h - 7, '#1c211e');
    px(x + 2, y + 5, hw - 2, 1, '#242e29');                            // bay back wall catches a little light
    const jit = Math.floor(now / 220) % 2, base = y + h - 4;
    const cols = [
      [x + 3, base, 3, '#c9a440'], [x + 5, base - 2, 4, '#d9b24a'],
      [x + 8, base - 1, 3, '#cfa844'], [x + 10, base - 3, 5, '#d9b24a'],
      [x + 13, base, 3, '#c9a440'], [x + 15, base - 2, 4, '#d9b24a']
    ];
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]; if (c[0] > x + hw - 1) continue;
      const dy = (i + Math.floor(now / 220)) % 2 === jit ? 0 : -1;     // the stacks chatter as they're fed
      px(c[0], c[1] + dy, 3, c[2], '#8a6a25');
      px(c[0], c[1] + dy, 3, c[2] - 1, c[3]);
      px(c[0], c[1] + dy, 3, 1, '#f5e08a');                            // coin-edge sheen on the top piece
      px(c[0] + 2, c[1] + dy + 1, 1, c[2] - 1, '#8a6a25');             // shaded east flank of the stack
      keyEdge(c[0], c[1] + dy, 2, 1, 0.18);
    }
    bloom(x + 3, y + 5, hw - 4, h - 9, gold, 0.07);                    // faint bullion cast in the bay
    // RIGHT 1/3: the counter tower — a real readout, the machine's one bright thing
    const sx = x + 1 + hw + 1, sw = cw - hw - 3;
    px(sx, y + 4, sw, h - 7, r.face);
    px(sx, y + 4, 1, h - 7, r.lit); px(sx + sw - 1, y + 4, 1, h - 7, r.dk);
    inset(sx + 1, y + 5, sw - 2, 4, '#0c1a0c');
    px(sx + 2, y + 6, sw - 4, 2, '#0f2410');                           // idle phosphor, never a dead hole
    const dg = String(100 + Math.floor(now / 1000) % 900);
    for (let d = 0; d < 3; d++) {                                      // three counter digits ticking over
      const litd = (dg.charCodeAt(d) % 2) ? 1 : 0.6;
      px(sx + 2 + d * 2, y + 6, 1, (d % 2) ? 2 : 1, U.shade('#9bff4a', -0.65 * (1 - on)));
      bloom(sx + 2 + d * 2, y + 6, 1, 2, '#9bff4a', 0.16 + 0.34 * on * litd);
    }
    spill(sx + 1, y + 9, sw - 2, '#9bff4a', 0.12 * on, 3);             // counter light pools down its housing
    const led = blink(1000);
    px(sx + sw - 2, y + 6, 1, 1, led ? '#9bff4a' : '#1f3a16');
    if (led) bloom(sx + sw - 2, y + 6, 1, 1, '#9bff4a', 0.28);
    // freestanding feet + under-gap AO
    px(x + 1, y + h - 2, 2, 2, r.dk); px(x + cw - 3, y + h - 2, 2, 2, r.dk);
    px(x + 1, y + h - 2, 1, 1, r.lit); px(x + cw - 3, y + h - 2, 1, 1, r.lit);
    underAO(x + 3, y + h - 1, cw - 6, 1);
  };
  F.treasury_token_furnace = (x, y, w, h, f) => {
    // TOKEN FURNACE (1x2) — the family's other TALL machine, and its hottest object: spent tokens go in,
    // heat comes out. Same tower construction as RACK V (chamfered cap, warm crown, cool east flank) so
    // the two read as siblings, but here the emissive is a real fire — one bloom halo plus firelight
    // SPILLING down the face, instead of the old pair of stacked flat glows.
    const cw = w, r = RAMP.gun, rise = 5, topY = y - rise, botY = y + h - 1, ph = (f && f.x) || 0;
    shadow2(x + 1, botY, cw - 2);
    // stovepipe vent rising off the cap, with heat shimmer
    const pw = 3, pvx = x + Math.round(cw / 2) - 1;
    px(pvx - 1, topY - 8, pw + 2, 1, U.shade(r.top, 0.20));
    px(pvx, topY - 8, pw, 4, r.face); px(pvx, topY - 8, 1, 4, r.lit); px(pvx + pw - 1, topY - 8, 1, 4, r.dk);
    rimEdge(pvx + pw - 1, topY - 7, 1, 3, 0.20);
    if (blink(520)) px(pvx + (Math.floor(now / 260) % 2), topY - 10, 1, 1, '#4a564a');
    if (blink(520, 1)) px(pvx + 1, topY - 9, 1, 1, '#3e4a3e');
    // tall cabinet face + slim east flank
    chamf(x - 1, topY - 5, cw + 2, botY - topY + 6, LINE, 2);
    px(x + cw - 3, topY - 1, 2, botY - topY, r.dk);
    rimEdge(x + cw - 2, topY + 1, 1, botY - topY - 3, 0.22);
    px(x + 1, topY, cw - 4, (botY - 1) - topY, r.face);
    px(x + 1, topY, 1, (botY - 1) - topY, r.lit);
    px(x + 2, topY, cw - 5, 1, U.shade(r.face, 0.14));
    // chamfered cap
    chamf(x, topY - 4, cw - 2, 4, LINE, 1);
    px(x + 1, topY - 3, cw - 4, 3, r.top); px(x + 1, topY - 3, cw - 4, 1, r.sheen);
    keyEdge(x + 1, topY - 3, 4, 1, 0.30);
    px(x + 1, topY - 1, cw - 4, 1, U.shade(r.top, -0.18));
    const rv = '#4a5254';
    px(x + 1, topY + 1, 1, 1, rv); px(x + cw - 5, topY + 1, 1, 1, rv);
    px(x + 1, botY - 3, 1, 1, U.shade(rv, -0.15)); px(x + cw - 5, botY - 3, 1, 1, U.shade(rv, -0.15));
    // 'TOKENS BURNED' readout near the top of the face (kept behaviour)
    const ry = topY + 2;
    inset(x + 2, ry, cw - 6, 4, '#0c1410');
    px(x + 3, ry + 1, cw - 8, 1, '#0f1c14');                           // idle phosphor floor, not a black slot
    for (let i = 0; i < cw - 8; i++) {
      if ((U.hash('tb' + i) + Math.floor(now / 240)) % 3 === 0) {
        const lit = blink(300, ph + i) || (f && f.work);
        px(x + 3 + i, ry + 1, 1, 1, lit ? scr(i) : '#13261c');
      }
    }
    // arched grate window in the lower face
    const gw = cw - 8, gx = x + 3, gy = topY + 8, gh = (botY - 4) - gy;
    inset(gx, gy, gw, gh, '#0a0d0a');
    px(gx, gy, 1, 1, '#1c2123'); px(gx + gw - 1, gy, 1, 1, '#1c2123');  // arch corners trimmed
    px(gx + 1, gy - 1, gw - 2, 1, '#15191a');                           // arch crown
    px(gx, gy + 1, gw, gh - 1, '#070a07');                              // furnace interior
    // ember core (kept behaviour): a body that breathes and a hotter heart inside it
    const beat = 0.5 + 0.5 * Math.sin(now / 260), beat2 = 0.5 + 0.5 * Math.sin(now / 170 + 1.3);
    const fh = Math.max(2, Math.round((gh - 2) * (0.55 + 0.4 * beat)));
    const fx = gx + 1, fy = gy + (gh - 1) - fh, fw = gw - 2;
    px(fx, fy, fw, fh, '#3a6b1e'); px(fx, fy + 1, fw, fh - 1, '#5fae2c');
    const cwF = Math.max(1, fw - 2);
    px(fx + 1, fy + 1, cwF, fh - 1, '#9bff4a');
    const hwF = Math.max(1, Math.round(cwF * (0.4 + 0.3 * beat2))), hcx = fx + 1 + Math.floor((cwF - hwF) / 2);
    px(hcx, fy + Math.max(1, fh - Math.round(fh * 0.7)), hwF, Math.max(1, Math.round(fh * 0.6)), '#d6ffb0');
    px(hcx, fy + fh - 2, hwF, 1, '#eaffd8');                            // hottest pixel
    if (blink(190)) px(fx + (U.hash('s1' + Math.floor(now / 190)) % fw), fy - 1, 1, 1, '#d6ffb0');
    if (blink(330, 2)) px(fx + (U.hash('s2' + Math.floor(now / 330)) % fw), fy, 1, 1, '#9bff4a');
    // grate bars over the fire, then ONE halo with real falloff + firelight running down the face
    for (let i = 1; i < gw - 1; i += 2) px(gx + i, gy + 1, 1, gh - 1, '#0d130d');
    px(gx, gy + Math.floor(gh / 2), gw, 1, '#0d130d');
    px(gx - 1, gy, 1, gh + 1, '#353c3e'); px(gx + gw, gy, 1, gh + 1, '#1a1f20');
    bloom(gx, gy, gw, gh, '#9bff4a', 0.16 + 0.13 * beat);
    spill(gx - 1, gy + gh + 1, gw + 2, '#9bff4a', 0.20 + 0.10 * beat, 4);
    // freestanding feet + under-gap AO
    px(x + 1, botY - 1, 2, 2, r.dk); px(x + cw - 5, botY - 1, 2, 2, r.dk);
    px(x + 1, botY - 1, 1, 1, r.lit); px(x + cw - 5, botY - 1, 1, 1, r.lit);
    underAO(x + 3, botY, cw - 8, 1);
  };
  F.treasury_pnl_holo = (x, y, w, h, f) => {   // v4 P&L holo — FLUSH deck emitter + a taller projection with real falloff
    // blocks:false, so the puck is set INTO the deck rather than standing on it: agents cross this tile.
    // All the presence comes from the light above it, which is free — light has no collision.
    const cx = x + (w >> 1), G = '#9bff4a', GT = '#d6ffb0';
    const lensY = y + 7;
    // recessed housing: a stepped oval well cut into the plating
    const well = [[3, 6], [2, 8], [1, 10], [2, 8], [3, 6]];
    well.forEach((s, j) => px(x + s[0], lensY - 2 + j, s[1], 1, '#12181a'));
    px(x + 2, lensY - 1, 8, 1, '#232b2a'); keyEdge(x + 3, lensY - 1, 4, 1, 0.18);   // lit north rim of the well
    px(x + 2, lensY + 1, 8, 1, '#0a0f10');                      // deep south lip
    px(x + 1, lensY, 1, 1, '#2a332f'); px(x + 10, lensY, 1, 1, '#0e1312');
    rimEdge(x + 10, lensY, 1, 1, 0.20);
    px(x + 3, lensY, 6, 1, '#1d2a1a');                          // lens ring
    px(x + 4, lensY, 4, 1, G); px(x + 5, lensY, 2, 1, GT);      // hot lens core
    px(x + 3, lensY + 1, 1, 1, blink(900) ? G : '#1c2a1a');     // status dot (kept)
    // PROJECTION — taller than v3 and lit by falloff instead of one flat alpha rect. The flicker is the
    // hologram's only material: a rock-steady hologram reads as a painted-on decal.
    const base = lensY - 1, top = y - 5, span = base - top;
    const fl = 0.55 + 0.18 * flick(220) + 0.12 * flick(90, 1);
    bloom(x + 4, lensY - 1, 4, 1, G, 0.30 * fl);                // the emitter itself blooms
    ctx.save();
    ctx.globalAlpha = 0.06 * fl; ctx.fillStyle = G;             // volumetric cone widening as it rises
    ctx.beginPath(); ctx.moveTo(cx - 2, base); ctx.lineTo(cx - 6, top); ctx.lineTo(cx + 6, top); ctx.lineTo(cx + 2, base);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    // the chart: 4 bars, one of them ALIVE (kept), plus the rising trend line and the peak glint
    const grow = Math.floor((now / 520) % 4), heights = [3, 5, 7, 9];
    const bw = 2, gap = 1, startX = Math.round(cx - (4 * bw + 3 * gap) / 2);
    ctx.save();
    ctx.globalAlpha = 0.44 * fl;
    for (let b = 0; b < 4; b++) {
      let hgt = heights[b] + (b === grow ? 1 + Math.floor((now / 130) % 2) : 0);
      if (hgt > span - 1) hgt = span - 1;
      const bx = startX + b * (bw + gap), by = base - 1 - hgt;
      px(bx, by, bw, hgt, G);
      px(bx, by, bw, 1, GT);                                    // each bar cap is its brightest row
      px(bx + bw - 1, by + 1, 1, hgt - 1, U.shade(G, -0.35));   // shaded east face — even light has volume
    }
    ctx.restore();
    ctx.save();                                                 // interlace + one sweeping refresh band
    ctx.globalAlpha = 0.10 * fl;
    for (let sy = top + 1; sy < base; sy += 2) px(cx - 5, sy, 10, 1, G);
    ctx.restore();
    const scan = top + 1 + Math.floor((now / 240) % span);
    ctx.save(); ctx.globalAlpha = 0.24 * fl; px(cx - 5, scan, 10, 1, GT); ctx.restore();
    ctx.save();                                                 // rising trend line over the bars (kept)
    ctx.globalAlpha = 0.72 * fl;
    for (let i = 0; i < 4; i++) px(startX + i * 2, base - 4 - i * 2, 1, 1, GT);
    ctx.restore();
    const peakX = startX + 6, peakY = base - 11;                // up-arrow glint (kept)
    const glint = blink(640) ? GT : G;
    ctx.save();
    ctx.globalAlpha = 0.9 * fl;
    px(peakX, peakY, 1, 1, glint); px(peakX - 1, peakY + 1, 3, 1, glint); px(peakX, peakY + 1, 1, 2, glint);
    ctx.restore();
    if (f && f.work) bloom(cx - 4, top + 1, 8, span - 1, G, 0.09 * fl);   // kept: the books are being worked
  };
  F.war_pivotpanel = (x, y, w, h, f) => {   // v4 PIVOT PANEL (2x1) — the family's only BRIGHT-FIELD board, on one column
    // The tacscreen is also a 2x1 board on posts, so these two had to be pulled apart or the war room and the
    // bridge would read as the same prop twice. Two separations, both visible at 3x:
    //   SILHOUETTE — this one loses the twin posts for ONE heavy centre column on a wide oval foot, with a
    //                marker tray slung under the board (a thing people stand AT, not a monitor they watch).
    //   LIGHT      — its lit area is two big SOLID colour fields, bright-on-bright, where every other screen in
    //                the family is thin light on dark glass. Rose PIVOT vs periwinkle PERSEVERE, amber seam.
    // f.work = the room is actively deciding -> the seam LED drives harder and the scanline sweeps faster.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const ROSE = '#ff5c7a', ROSEL = '#ffd0d9', PERI = '#a0a8ff', PERIL = '#d4d8ff', AMB = '#ffb84d';
    const cx = x + Math.floor(w / 2);
    shadow2(x + 4, y + h - 1, w - 8);
    // WIDE OVAL FOOT + single tapered column — the silhouette tell against the bridge's twin-post boards
    chamf(cx - 8, y + h - 4, 16, 4, LINE, 3);
    chamf(cx - 7, y + h - 3, 14, 2, r.face, 2);
    px(cx - 6, y + h - 3, 12, 1, r.lit); keyEdge(cx - 5, y + h - 3, 8, 1, 0.16);
    px(cx - 6, y + h - 2, 12, 1, r.ao);
    ctx.globalAlpha = 0.30; px(cx - 8, y + h, 16, 1, '#000'); ctx.globalAlpha = 1;
    for (let j = 0; j < 5; j++) {                                   // the column tapers as it rises
      const cw3 = 6 - (j > 2 ? 1 : 0);
      px(cx - (cw3 >> 1) - 1, y + 4 + j, cw3 + 2, 1, LINE);
      px(cx - (cw3 >> 1), y + 4 + j, cw3, 1, r.face);
      px(cx - (cw3 >> 1), y + 4 + j, 1, 1, r.lit); px(cx + (cw3 >> 1) - 1, y + 4 + j, 1, 1, r.dk);
    }
    rimEdge(cx + 2, y + 5, 1, 4, 0.18);
    px(cx - 4, y + 3, 8, 2, U.shade(r.top, 0.14));                  // yoke collar clamping board to column
    px(cx - 4, y + 3, 8, 1, r.sheen);
    // MARKER TRAY slung under the board — the physical detail that says "people decide here"
    chamf(x + 5, y + 1, w - 10, 3, LINE, 1);
    px(x + 6, y + 2, w - 12, 1, U.shade(r.face, 0.10)); px(x + 6, y + 2, w - 12, 1, r.lit);
    px(x + 6, y + 3, w - 12, 1, r.ao);
    px(x + 8, y + 2, 3, 1, ROSE); px(x + 13, y + 2, 3, 1, PERI);    // two markers lying in the tray
    // chamfered carcass
    chamf(x - 1, y - 6, w + 2, 8, LINE, 2);
    chamf(x, y - 5, w, 7, r.face, 2);
    px(x + 2, y - 5, w - 4, 1, r.top); keyEdge(x + 2, y - 5, 7, 1, 0.28);
    px(x, y - 3, 1, 4, r.lit); px(x + w - 1, y - 3, 1, 4, r.dk); rimEdge(x + w - 1, y - 3, 1, 4, 0.22);
    px(x + 2, y + 1, w - 4, 1, r.ao);
    px(x + 2, y - 5, 1, 1, r.sheen); px(x + w - 3, y - 5, 1, 1, r.sheen);
    // SPLIT FACE — two solid decision fields either side of an amber seam
    const fy = y - 4, fh = 6, half = Math.floor((w - 6) / 2);
    inset(x + 2, fy - 1, w - 4, fh + 2, '#101216');
    const lx = x + 3;
    px(lx, fy, half - 1, fh, ROSE);                                 // PIVOT
    px(lx, fy, half - 1, 1, ROSEL);
    px(lx, fy + 1, 1, fh - 2, U.shade(ROSE, 0.22));
    px(lx, fy + fh - 1, half - 1, 1, U.shade(ROSE, -0.40));
    for (let i = 0; i < 5; i++) px(lx + 1 + i * 2, fy + 2, 1, 2, ROSEL);        // PIVOT ticks (kept)
    px(lx + 2, fy + 3, 1, 1, '#a8324a'); px(lx + 6, fy + 3, 1, 1, '#a8324a');
    const sx2 = lx + half;                                          // amber seam (kept)
    px(sx2, fy - 1, 1, fh + 2, AMB); px(sx2, fy - 1, 1, 1, '#ffe1a0');
    px(sx2, fy, 1, fh, U.shade(AMB, -0.15));
    const rx = sx2 + 1;
    px(rx, fy, half - 1, fh, PERI);                                 // PERSEVERE
    px(rx, fy, half - 1, 1, PERIL);
    px(rx + half - 2, fy + 1, 1, fh - 2, U.shade(PERI, -0.28));
    px(rx, fy + fh - 1, half - 1, 1, U.shade(PERI, -0.35));
    for (let i = 0; i < 5; i++) px(rx + 1 + i * 2, fy + 2, 1, 2, PERIL);        // PERSEVERE ticks (kept)
    px(rx + 3, fy + 3, 1, 1, '#5a64b8'); px(rx + 7, fy + 3, 1, 1, '#5a64b8');
    const sc = fy + Math.floor((now / (on ? 140 : 240)) % fh);      // drifting scanline (kept)
    glow(lx, sc, half - 1, 2, '#fff', 0.10); glow(rx, sc, half - 1, 2, '#fff', 0.10);
    // magnetic chrome puck on the PERSEVERE side (kept) — catch is a shade, never a white speck
    const pcx = rx + half - 4, pcy = fy + fh - 3;
    ctx.globalAlpha = 0.30; px(pcx - 1, pcy + 2, 4, 1, '#000'); ctx.globalAlpha = 1;
    px(pcx, pcy, 3, 2, '#c8ccd6'); px(pcx, pcy, 3, 1, '#eef0f6'); px(pcx, pcy + 1, 3, 1, '#8a8e98');
    px(pcx, pcy, 1, 1, U.shade('#eef0f6', 0.4));
    // pulsing seam LED (kept) — now with falloff, and the two fields wash the board's frame in their own colours
    const pulse = Math.max(0, Math.sin(now / (on ? 420 : 700)));
    bloom(sx2, fy + Math.floor(fh / 2), 1, 2, AMB, 0.25 + 0.55 * pulse);
    if (pulse > 0.6) px(sx2, fy + Math.floor(fh / 2), 1, 1, '#ffe1a0');
    bloom(lx, fy, half - 1, fh, ROSE, 0.10); bloom(rx, fy, half - 1, fh, PERI, 0.10);
    spill(x + 3, y + 2, half - 1, ROSE, on ? 0.18 : 0.11, 4);       // each half spills its OWN colour down the tray
    spill(rx, y + 2, half - 1, PERI, on ? 0.18 : 0.11, 4);
  };
  F.war_intelcab = (x, y, w, h, f) => {   // v4 intel cabinet (1x2) — the SLIMMEST of the five stores: sealed drawers
    // SECURED-STORAGE family (intelcab · safe · vault · rack · shelf) share one language: chamfered armour on the
    // shared steel ramp, a warm crown key, a cool east rim, riveted seams and a green ACC.work SEAL lamp. What
    // separates them is SILHOUETTE and SCALE — this one is the narrow drawer stack, read by its four seams.
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    const seal = (lx, ly, lit) => {                                   // the family's shared lock tell
      px(lx, ly, 2, 2, lit ? '#c7ffe0' : U.shade(ACC.work, -0.62));
      if (lit) bloom(lx, ly, 2, 2, ACC.work, 0.32);
    };
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 5, w + 2, 5);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + h - 8, x + w + 2, y + h - 3, 2);             // index lead sags into the deck socket
    // TALL 3/4 armoured slab
    chamf(x - 1, y - 3, w + 2, h + 2, LINE, 2);
    chamf(x, y - 2, w, h, r.face, 2);
    px(x, y, 1, h - 5, U.shade(r.face, 0.12)); px(x + w - 1, y, 1, h - 5, r.dk);
    rimEdge(x + w - 1, y + 1, 1, h - 7, 0.22);
    chamf(x - 1, y - 6, w + 2, 4, LINE, 1);                           // top cap
    px(x, y - 5, w, 2, r.top); px(x, y - 5, w, 1, r.sheen);
    keyEdge(x, y - 5, 5, 1, 0.30);
    px(x, y - 3, w, 1, U.shade(r.top, -0.24));                        // cap lip, tying the cap to the body
    rivets(x + 1, y - 1, w - 2, h - 4, r.sheen, r.ao);
    // four sealed drawers — the read at 3x is the seam rhythm, not the detail inside it
    const dx = x + 2, dw = w - 4, top = y + 1, dh = 4;
    const rip = Math.floor(now / 320) % 4;                            // status ripple top-to-bottom (kept)
    for (let d = 0; d < 4; d++) {
      const dy = top + d * dh;
      inset(dx, dy, dw, dh - 1, U.shade(r.face, -0.22));
      px(dx + 1, dy + 1, dw - 2, 1, U.shade(r.face, 0.12));           // drawer face catch
      keyEdge(dx + 1, dy + 1, dw - 3, 1, 0.13);
      px(dx + 1, dy + 2, dw - 2, 1, U.shade(r.face, -0.06));
      px(dx + 2, dy + 2, dw - 4, 1, U.shade(r.face, -0.44));          // recessed pull
      px(dx + 2, dy + 1, 1, 1, r.lit); px(dx + dw - 3, dy + 2, 1, 1, r.dk);
      seal(dx + dw - 2, dy + 1, d === rip);
    }
    // ONE drawer pulled proud, spilling file light onto the drawer below — the whole point of the prop
    const oy = top + dh;
    px(dx - 1, oy - 1, dw + 2, 1, LINE);
    px(dx - 1, oy, dw + 2, 2, U.shade(r.face, 0.16)); px(dx - 1, oy, dw + 2, 1, r.lit);
    keyEdge(dx, oy, dw, 1, 0.20);
    px(dx, oy + 2, dw, 1, blink(700, ph) ? '#c7ffe0' : ACC.work);     // the glowing paper edge (kept)
    bloom(dx, oy + 2, dw, 1, ACC.work, 0.22 + 0.07 * Math.sin(now / 600));
    spill(dx, oy + 3, dw, ACC.work, 0.20, 4);                         // light pools DOWN the drawer front
    px(dx - 1, oy + 3, dw + 2, 1, r.ao);
    // vertical index strip down the east edge — this store is an INDEX, not a strongbox
    const sx = x + w - 4; inset(sx, y + 1, 3, h - 7, '#141b18');
    for (let i = 0; i < h - 10; i += 3)
      px(sx + 1, y + 2 + i, 1, 2, U.shade(ACC.work, on ? -0.15 : -0.5));
    bloom(sx + 1, y + 2, 1, h - 9, ACC.work, on ? 0.16 : 0.08);
    px(x + 1, y + h - 3, w - 2, 1, r.ao);                             // floor-line AO
  };
  F.war_threatcore = (x, y, w, h, f) => {   // v4 THREAT CORE (1x2) — a segmented LEVEL METER, not another light slot
    // Paired against bridge_dispatch_pylon this is the family's hardest read: both are 1x2 columns. They are
    // separated on the axis of their light — the pylon is ONE continuous VERTICAL bar; this is a stack of
    // discrete HORIZONTAL segments climbing bottom-up behind smoked glass, like a threat gauge filling. The
    // body is bulked out to match: an external rib CAGE, a flared foot and an orbit RING on the crown, against
    // the pylon's smooth slim column and single mast. f.work = escalated -> 5 segments lit instead of 3.
    const r = RAMP.gun, ph = (f && f.x) || 0, on = !!(f && f.work);
    const ROSE = '#ff5c7a', ROSEL = '#ffd9e2', AMB = '#ffb84d';
    const hot = on ? 1 : 0.55;
    shadow2(x + 1, y + h - 1, w - 2);
    bloom(x, y + h - 4, w, 3, ROSE, (0.10 + 0.05 * hot) + 0.04 * Math.sin(now / 900));   // floor halo (kept)
    deckPlate(x - 1, y + h - 5, w + 2, 5);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 2, y + h - 9, x + w + 2, y + h - 3, 2);
    // FLARED FOOT — wider than the pylon's shoe, so the column reads bottom-heavy
    chamf(x - 2, y + h - 7, w + 4, 4, LINE, 2);
    px(x - 1, y + h - 6, w + 2, 2, r.face); px(x - 1, y + h - 6, w + 2, 1, r.lit);
    keyEdge(x, y + h - 6, w, 1, 0.16);
    px(x - 1, y + h - 4, w + 2, 1, r.ao);
    // slim column body + a cap we look down on
    chamf(x, y - 3, w - 1, h - 4, LINE, 2);
    chamf(x + 1, y - 2, w - 3, h - 6, r.face, 2);
    px(x + 1, y, 1, h - 9, U.shade(r.face, 0.12)); px(x + w - 3, y, 1, h - 9, r.dk);
    rimEdge(x + w - 3, y + 1, 1, h - 11, 0.22);
    chamf(x, y - 6, w - 1, 4, LINE, 1);
    px(x + 1, y - 5, w - 3, 2, r.top); px(x + 1, y - 5, w - 3, 1, r.sheen); keyEdge(x + 1, y - 5, 4, 1, 0.30);
    px(x + 1, y - 3, w - 3, 1, U.shade(r.top, -0.24));              // cap lip ties the cap down
    // EXTERNAL CAGE RAILS standing proud of the column on both flanks — the bulk that separates this from the
    // pylon in silhouette. Each rail carries its OWN outline pixel on its outer edge, so bolting the cage on
    // widens the dark silhouette instead of eating it.
    const rTop = y - 1, rH = h - 12;
    px(x - 1, rTop - 1, 2, rH + 2, LINE); px(x + w - 2, rTop - 1, 2, rH + 2, LINE);
    px(x, rTop, 1, rH, U.shade(r.face, 0.18)); keyEdge(x, rTop, 1, 4, 0.20);       // west rail takes the key
    px(x + w - 2, rTop, 1, rH, r.dk); rimEdge(x + w - 2, rTop, 1, rH, 0.20);       // east rail takes the sky
    for (let j = 0; j < 4; j++) {                                   // cross-ties bolting the rails to the body
      const ry2 = rTop + 1 + j * 4;
      px(x, ry2, 3, 1, U.shade(r.face, 0.10)); px(x + w - 4, ry2, 3, 1, U.shade(r.face, 0.10));
      px(x, ry2 + 1, 3, 1, r.ao); px(x + w - 4, ry2 + 1, 3, 1, r.ao);
      px(x, ry2, 1, 1, r.sheen); px(x + w - 2, ry2, 1, 1, r.ao);    // tie bolts
    }
    // SMOKED-GLASS WELL with the 5-segment stack filling bottom-up (kept level behaviour)
    const gx2 = x + 3, gy2 = y, gw2 = w - 6, gh2 = 11;
    px(gx2 - 2, gy2 - 1, gw2 + 4, gh2 + 2, '#0a0b0d');              // heavy glass surround
    inset(gx2 - 1, gy2, gw2 + 2, gh2, '#0d0e10');
    const segs = 5, seglvl = on ? 5 : 3;
    const topAmber = blink(1400);                                   // slow warning loop (kept)
    for (let s = 0; s < segs; s++) {
      const sy3 = gy2 + gh2 - 2 - s * 2;
      if (s < seglvl) {
        const isTop = s === seglvl - 1;
        const col = (isTop && topAmber) ? AMB : ROSE;
        px(gx2, sy3, gw2, 1, col);
        px(gx2, sy3, 2, 1, U.shade(col, 0.16));                     // west-lit segment edge
        bloom(gx2, sy3, gw2, 1, col, isTop ? 0.30 : 0.16);          // each SEGMENT blooms on its own
      } else {
        px(gx2, sy3, gw2, 1, '#16171a');                            // unlit segments still visible behind glass
        px(gx2, sy3, 1, 1, '#1f2124');
      }
    }
    px(gx2 - 1, gy2, 1, gh2, U.shade(r.top, 0.10));                 // smoked-glass sheen down the west edge
    rimEdge(gx2 + gw2, gy2, 1, gh2, 0.20);
    scanl(gx2, gy2, gw2, gh2, 0.16);
    spill(x + 1, gy2 + gh2 + 1, w - 3, ROSE, 0.16 + 0.08 * hot, 4); // gauge light pooling down the vents
    // vent slits below the glass (kept)
    for (let v = 0; v < 3; v++) {
      const vy = gy2 + gh2 + 2 + v * 2;
      px(x + 3, vy, w - 6, 1, '#0d0e10');
      px(x + 3, vy + 1, w - 6, 1, U.shade(r.face, 0.12));
    }
    // CROWN: a real orbit RING with the sweep dot riding it — the pylon's crown is a flat mast head
    const hubx = x + Math.floor(w / 2), huby = y - 8;
    px(hubx - 1, huby, 2, 3, LINE); px(hubx - 1, huby, 1, 3, r.lit);
    ctx.save();
    ctx.strokeStyle = U.shade(r.top, -0.30); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(hubx, huby, 3, 1.4, 0, 0, 6.2832); ctx.stroke();
    ctx.restore();
    const a = now / 600;
    const dx2 = Math.round(Math.cos(a) * 3), dy2 = Math.round(Math.sin(a) * 1.4);
    px(hubx + dx2, huby + dy2, 1, 1, on ? ROSEL : ROSE);
    bloom(hubx + dx2, huby + dy2, 1, 1, ROSE, on ? 0.38 : 0.22);
    px(x + 2, y + h - 10, 1, 1, blink(on ? 500 : 1500, ph) ? AMB : '#33271a');   // arming lamp on the body
  };
  F.pub_publishpress = (x, y, w, h, f) => {
    // PUBLISH PRESS (2x2, blocks:true) — v4. Bolted machinery, and the family register made literal: the
    // PLATEN actually travels. It rides two chrome pistons down onto the heat bed on the fire pulse and lifts
    // off after, and a printed sheet feeds out of the lower slot into the catch tray between strikes. That
    // beats any amount of glow: you can see the thing work. Kept: the 1500ms press cycle, the amber->gold
    // heat bed, the three status LEDs, the steam wisp, and f.work biasing the heat hotter.
    const r = RAMP.steel, on = !!(f && f.work);
    const PER = 1500, ph = (now % PER) / PER;
    const fire = Math.max(0, Math.sin(ph * Math.PI * 2));
    const firing = ph > 0.18 && ph < 0.42;
    const heat = on ? 0.45 + 0.55 * fire : 0.18 + 0.30 * fire;
    shadow2(x + 2, y + h - 1, w - 4);
    deckPlate(x - 1, y + h - 5, w + 2, 5);
    deckSocket(x + w + 1, y + h - 3, on);
    cable(x + w - 3, y + h - 9, x + w + 2, y + h - 3, 2.2);
    // TALL 3/4 casing
    chamf(x, y + 2, w, 17, LINE, 2);
    chamf(x + 1, y + 3, w - 2, 3, r.top, 2);                      // cap
    px(x + 2, y + 3, w - 4, 1, r.sheen); keyEdge(x + 2, y + 3, 8, 1, 0.30);
    px(x + 2, y + 5, w - 4, 1, U.shade(r.top, -0.22));            // cap front lip
    chamf(x + 1, y + 6, w - 2, 12, r.face, 2);
    px(x + 1, y + 8, 1, 8, U.shade(r.face, 0.08)); px(x + w - 2, y + 8, 1, 8, r.dk);
    rimEdge(x + w - 2, y + 8, 1, 8, 0.20);
    px(x + 2, y + 18, w - 4, 1, r.ao);
    wear(x + 2, y + 7, w - 4, 10, 4, U.shade(r.face, -0.12));
    // PRESS THROAT
    inset(x + 3, y + 6, w - 6, 9, '#1a1410');                     // y+6..y+14, inner x+4..x+19 / y+7..y+13
    const bedY = y + 12;
    for (let i = 0; i < 2; i++) {                                 // heat bed, amber->gold up the stack
      const base = i === 0 ? '#ff8a1e' : '#ffc24a';
      px(x + 4, bedY + (1 - i), 16, 1, U.shade(base, -0.10 + 0.10 * i));
    }
    bloom(x + 4, bedY, 16, 2, '#ffb030', 0.14 + 0.34 * heat);
    px(x + 5, bedY, 14, 1, firing ? '#fff0b0' : '#ffcf66');       // hot core line
    // pistons + travelling platen: rest at y+7, slams to y+10 at full fire
    const platY = y + 7 + Math.round(fire * 3);
    for (const pxx of [x + 4, x + w - 6]) {
      px(pxx, y + 6, 2, platY - y - 6 + 1, '#5a625e');
      px(pxx, y + 6, 1, platY - y - 6 + 1, '#8d958f');
      px(pxx, y + 7, 1, 1, '#c6cdc7');                            // chrome catch on the rod
    }
    px(x + 4, platY, 16, 2, LINE);
    px(x + 4, platY, 16, 1, U.shade(r.top, 0.12)); keyEdge(x + 5, platY, 7, 1, 0.24);
    px(x + 4, platY + 1, 16, 1, U.shade('#ff8a1e', -0.55));       // the platen's own hot underside
    if (firing) bloom(x + 5, platY + 1, 14, 1, '#ffb030', 0.20 + 0.30 * fire);
    // stock passing through the throat between platen and bed
    px(x + 4, bedY - 1, 16, 1, firing ? '#e8ece4' : '#c4cabf');
    // OUTPUT SLOT + catch tray — the printed sheet feeds out after each strike
    px(x + 4, y + 15, w - 8, 1, r.ao);
    inset(x + 5, y + 15, w - 10, 2, '#0f1418');
    const out = ph > 0.45 ? Math.min(5, 1 + Math.floor((ph - 0.45) * 11)) : 0;
    if (out > 0) {
      px(x + 6, y + 16, w - 12, out, '#cdd2cc');
      px(x + 6, y + 16, w - 12, 1, '#e6eae4');
      for (let gx2 = 1; gx2 < w - 12; gx2 += 3) px(x + 6 + gx2, y + 17, 1, out - 1, ACC.flow);
      bloom(x + 6, y + 16, w - 12, out, ACC.flow, 0.10);
    }
    chamf(x + 3, y + h - 5, w - 6, 3, LINE, 1);                   // catch tray the sheet tucks behind
    px(x + 4, y + h - 4, w - 8, 1, U.shade(r.face, 0.10));
    px(x + 4, y + h - 4, w - 8, 1, r.lit); keyEdge(x + 5, y + h - 4, w - 11, 1, 0.14);
    px(x + 4, y + h - 3, w - 8, 1, r.ao);
    // status LEDs (kept timings) — gold and green only: alert red would claim a failure that has not happened
    px(x + w - 8, y + 17, 1, 1, ACC.work);
    px(x + w - 6, y + 17, 1, 1, blink(750) ? ACC.flow : '#3a3210');
    px(x + w - 4, y + 17, 1, 1, firing ? '#ff9d2e' : '#2a2014');
    if (blink(750)) bloom(x + w - 6, y + 17, 1, 1, ACC.flow, 0.28);
    // STOCK SPOOL on top, web feeding over a drum into the cap — where the paper comes from
    chamf(x + 3, y, w - 6, 4, LINE, 1);
    px(x + 4, y + 1, w - 8, 2, '#33383a'); px(x + 4, y + 1, w - 8, 1, U.shade('#33383a', 0.26));
    px(x + 4, y + 2, w - 8, 1, '#23272a');
    const spin = Math.floor(now / 120) % 4;
    for (const hx of [x + 4, x + w - 6]) { px(hx, y + 1, 2, 2, '#22262a'); px(hx + (spin & 1), y + 1 + (spin >> 1), 1, 1, '#4d5551'); }
    px(x + 7, y - 8, w - 14, 8, LINE);                            // the roll itself
    px(x + 8, y - 7, w - 16, 6, '#c2c7c0'); px(x + 8, y - 7, w - 16, 1, '#dfe4dc');
    keyEdge(x + 8, y - 7, 4, 1, 0.30);
    for (let i = 0; i < 3; i++) px(x + 8, y - 6 + i * 2, w - 16, 1, U.shade('#c2c7c0', -0.14));
    px(x + 8 + spin, y - 4, 1, 2, U.shade('#c2c7c0', -0.34));     // one mark so the roll reads as turning
    px(x + 9, y - 1, w - 18, 2, '#b6bbb4');                       // web running down into the cap
    px(x + 9, y - 1, 1, 2, '#d4d9d2');
    // steam wisp off the sheet on the fire pulse (kept)
    if (firing) {
      const sx2 = x + (w >> 1);
      ctx.save(); ctx.globalAlpha = 0.16 + 0.18 * fire;
      px(sx2, y + 5, 1, 2, '#d8ded6');
      px(sx2 + (blink(220) ? 1 : -1), y + 3, 1, 2, '#d8ded6');
      px(sx2, y + 1, 1, 1, '#d8ded6');
      ctx.restore();
    }
  };
  F.pub_outboundchute = (x, y, w, h, f) => {
    // OUTBOUND CHUTE (1x2, blocks:true) — v4. TALL 3/4 pneumatic column, bolted. The capsule now falls with
    // real ACCELERATION and lands: it eases in down the glass slit, the breech flashes on arrival and the
    // hopper ring recharges behind it. A fall at constant speed reads as a looping texture; a fall that
    // arrives reads as a dispatch. Kept: the ~2s drop cycle, the gold hopper ring, the barcode band.
    // The old SHIP stencil was drawn at 5px monospace from x+4 — ~12px of text on a 12px prop, so it ran off
    // the casing entirely. Replaced with painted chevrons, which are also what actually reads at this width.
    const r = RAMP.steel, on = !!(f && f.work), ph0 = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + h - 5, w + 2, 5);
    deckSocket(x - 3, y + h - 3, on);
    cable(x + 1, y + h - 8, x - 3, y + h - 3, 2);
    // column
    chamf(x - 1, y - 4, w + 2, 23, LINE, 2);
    chamf(x, y - 3, w, 21, r.face, 2);
    px(x, y - 1, 1, 16, U.shade(r.face, 0.08)); px(x + w - 1, y - 1, 1, 16, r.dk);
    rimEdge(x + w - 1, y - 1, 1, 16, 0.22);
    px(x + 1, y + 17, w - 2, 1, r.ao);
    wear(x + 1, y, w - 2, 12, 4, U.shade(r.face, -0.12));
    // flared hopper mouth — juts 2px proud of the column so the silhouette steps
    chamf(x - 3, y - 11, w + 6, 8, LINE, 2);
    px(x - 2, y - 10, w + 4, 4, r.top); px(x - 2, y - 10, w + 4, 1, r.sheen);
    keyEdge(x - 1, y - 10, 6, 1, 0.30);
    px(x - 2, y - 9, 1, 3, r.lit); px(x + w + 1, y - 9, 1, 3, r.dk);
    rimEdge(x + w + 1, y - 9, 1, 3, 0.22);
    px(x - 1, y - 6, w + 2, 1, U.shade(r.top, -0.34));            // flare underside
    inset(x + 1, y - 9, w - 2, 3, '#0d100c');                     // dark throat
    const dropT = (now / (on ? 1500 : 2100)) % 1;
    const charge = dropT > 0.55 ? (dropT - 0.55) / 0.45 : 0;      // the ring recharges after each dispatch
    const ring = 0.20 + 0.55 * charge;
    px(x + 1, y - 9, w - 2, 1, U.shade(ACC.flow, charge > 0.5 ? 0.1 : -0.4));
    bloom(x + 1, y - 9, w - 2, 1, ACC.flow, ring);
    spill(x + 1, y - 5, w - 2, ACC.flow, ring * 0.5, 3);
    // GLASS DROP SLIT — the capsule eases in, so the fall has weight
    const sx = x + 3, sw = w - 6, sy = y - 1, sh2 = 14;
    inset(sx, sy, sw, sh2, '#0b0f0c');
    rimEdge(sx + 1, sy, 1, sh2, 0.14);                            // sky bounce on the glass
    ctx.save(); ctx.beginPath(); ctx.rect(sx + 1, sy + 1, sw - 2, sh2 - 2); ctx.clip();
    const fall = dropT < 0.55 ? (dropT / 0.55) * (dropT / 0.55) : 1.2;
    const py2 = sy + 1 + Math.round(fall * (sh2 - 3));
    if (dropT < 0.55) {
      px(sx + 1, py2, 4, 3, '#36424c'); px(sx + 1, py2, 4, 1, '#4d5962');
      px(sx + 1, py2 + 1, 1, 2, '#28323a'); px(sx + 2, py2 + 1, 2, 1, ACC.flow);   // tape strip
      if (dropT > 0.25) px(sx + 1, py2 - 2, 4, 1, U.shade('#36424c', -0.4));       // motion smear at speed
    }
    ctx.restore();
    px(sx, sy, 1, sh2, '#12170f'); px(sx + sw - 1, sy, 1, sh2, '#12170f');
    // BREECH — flashes as the capsule is fired away down the line
    const land = dropT > 0.50 && dropT < 0.62;
    px(x + 1, y + 13, w - 2, 1, land ? '#fff0b8' : U.shade(ACC.flow, -0.62));
    if (land) { bloom(x + 1, y + 13, w - 2, 1, ACC.flow, 0.42); spill(x, y + 14, w, ACC.flow, 0.22, 3); }
    // chamfered lower barrel: chevrons + barcode band (no text at 12px)
    const by = y + h - 11;
    chamf(x - 1, by, w + 2, 7, LINE, 1);
    px(x, by + 1, w, 5, U.shade(r.face, -0.10));
    px(x, by + 1, w, 1, r.lit); keyEdge(x + 1, by + 1, w - 3, 1, 0.16);
    px(x, by + 3, w, 1, U.shade(r.face, -0.38));                  // band seam
    for (let k = 0; k < 2; k++) {                                 // twin down-chevrons, marching on dispatch
      const cvy = by + 1 + k + (land ? 1 : 0);
      px(x + 3, cvy, 1, 1, '#dfe6da'); px(x + 4, cvy + 1, 2, 1, '#dfe6da'); px(x + 6, cvy, 1, 1, '#dfe6da');
    }
    for (let i = 0; i < 8; i++) px(x + 2 + i, by + 5, 1, 1, (U.hash('bc' + i + ph0) % 2) ? '#cdd6cc' : '#161a12');
    for (const rx of [x + 1, x + w - 2]) for (const ry of [y + 1, y + 11]) {
      px(rx, ry, 1, 1, U.shade(r.top, 0.24)); px(rx, ry + 1, 1, 1, r.ao);
    }
  };
  F.pub_mailpod = (x, y, w, h, f) => {
    // MAIL POD (2x1, blocks:true) — v4. Bolted capsule terminal with two glass bays: WEST is the loaded
    // inbound, EAST is the dispatch. The old prop just blinked a bay empty; now the capsule visibly LEAVES —
    // it streaks up the snorkel tube and off the NE shoulder, which is the whole point of the object and the
    // family's register. Kept: the 2.5s thunk cycle emptying the east bay, the twin indicators, the snorkel.
    const r = RAMP.steel, on = !!(f && f.work), ph = (f && f.x) || 0;
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x - 3, y + h - 3, on);
    cable(x + 2, y + 7, x - 3, y + h - 3, 2);
    for (const lx of [x + 3, x + w - 6]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 6, y + 9, w - 12, 2);
    // BOLD capsule silhouette — chamfered dome over a short face
    chamf(x - 1, y - 5, w + 2, 14, LINE, 3);
    chamf(x, y - 4, w, 12, r.face, 3);
    chamf(x + 1, y - 4, w - 2, 5, r.top, 3);                      // dome we look down on
    px(x + 3, y - 4, w - 6, 1, r.sheen); keyEdge(x + 3, y - 4, 8, 1, 0.30);
    px(x + 1, y + 1, w - 2, 1, U.shade(r.top, -0.20));            // dome lip
    px(x, y + 2, 1, 5, r.lit); px(x + w - 1, y + 2, 1, 5, r.dk);
    rimEdge(x + w - 1, y + 2, 1, 5, 0.22);
    px(x + 1, y + 7, w - 2, 1, r.ao);
    wear(x + 2, y - 3, w - 4, 9, 4, U.shade(r.face, -0.12));
    seamH(x + 10, y + 2, 4, r.face);                              // centre feed seam between the bays
    // TWIN GLASS BAYS (kept thunk cycle) — west loaded, east dispatching
    const cyc = (now % 2500) / 2500, thunk = cyc < 0.09, gone = cyc < 0.42;
    const cy = y + 2;
    for (let b = 0; b < 2; b++) {
      const bx = b ? x + w - 7 : x + 6, empty = b === 1 && gone;
      inset(bx - 4, cy - 4, 8, 8, '#181e1b');
      px(bx - 3, cy - 3, 6, 6, '#22302c'); px(bx - 3, cy - 3, 6, 1, U.shade('#22302c', 0.30));
      if (!empty) {
        px(bx - 2, cy - 2, 4, 4, '#56646e'); px(bx - 2, cy - 2, 4, 1, '#6d7b85');
        px(bx - 1, cy - 1, 1, 2, '#28323a');
        px(bx + 1, cy - 1, 1, 2, U.shade('#56646e', -0.34)); rimEdge(bx + 1, cy - 1, 1, 2, 0.20);
        px(bx - 2, cy + 1, 4, 1, b ? ACC.flow : U.shade(ACC.data, -0.20));   // routing band
      } else {
        px(bx - 2, cy - 1, 4, 2, '#12180f');
        if (thunk) bloom(bx - 2, cy - 1, 4, 2, ACC.flow, 0.34);   // the breech flash it left behind
      }
      rimEdge(bx - 3, cy - 3, 6, 1, 0.26);                        // sky bounce off the curved glass
      px(bx - 2, cy - 2, 1, 1, U.shade('#dff4ff', -0.20));
    }
    // SNORKEL — a real pneumatic tube arcing off the NE shoulder, with the capsule streaking up it
    const tube = [];
    for (let i = 0; i <= 9; i++) {
      const t = i / 9;
      tube.push([Math.round(x + w - 6 + t * 8), Math.round(y - 2 - t * 7 - Math.sin(t * Math.PI) * 1.4)]);
    }
    for (let i = 0; i < tube.length; i++) {
      px(tube[i][0], tube[i][1] - 1, 2, 4, LINE);
      px(tube[i][0], tube[i][1], 2, 2, i < 5 ? '#46525a' : '#3a444c');
      px(tube[i][0], tube[i][1], 1, 1, '#6a7882');
    }
    if (gone) {                                                   // the capsule the east bay just fired
      const tt = Math.min(1, cyc / 0.42), i = Math.min(tube.length - 1, Math.floor(tt * tube.length));
      px(tube[i][0], tube[i][1], 2, 2, '#cfe6f2');
      bloom(tube[i][0], tube[i][1], 2, 2, ACC.flow, 0.34 * (1 - tt));
      if (i > 1) px(tube[i - 2][0], tube[i - 2][1], 2, 1, U.shade(ACC.flow, -0.34));   // trail
    }
    // indicators above each bay (kept: steady cyan-white west, gold blink east)
    px(x + 6, y - 3, 1, 1, '#dff6ff'); bloom(x + 6, y - 3, 1, 1, ACC.data, 0.30);
    const goldOn = blink(620, ph);
    px(x + w - 7, y - 3, 1, 1, goldOn ? ACC.flow : '#28323a');
    if (goldOn) bloom(x + w - 7, y - 3, 1, 1, ACC.flow, 0.34);
    if (on) spill(x + 2, y + 8, w - 4, ACC.flow, 0.16, 3);        // live dispatch washes the deck plate
  };
  F.arc_indexwall = (x, y, w, h, f) => {
    // INDEX WALL (4x1, blocks:FALSE) — v4 REBUILD. Agents walk in front of this, so the stub feet had to go:
    // it is now a SHALLOW wall-hung card index on lugs, casting onto the bulkhead, with no floor contact.
    // 48px gets HIERARCHY along its length instead of one 6x3 grid: labelled drawers west, the backlit index
    // well centre, a lookup readout east. The motion is a RETRIEVAL CARRIAGE that traverses the well, stops
    // over a column and lifts one slip lit — the archive doing its job. Kept: the silver top rail, the
    // one-slip-per-second cyan flip (it is now the slip the carriage pulled), the sweep, both status dots.
    const r = RAMP.gun, ph = (f && f.x) || 0, on = !!(f && f.work);
    const bt = y - 10, bh = 19;                                   // hangs y-10..y+8
    ctx.globalAlpha = 0.20; px(x + 2, bt + 3, w, bh, '#000'); ctx.globalAlpha = 1;
    for (const lx of [x + 6, x + Math.floor(w / 2), x + w - 8]) {
      px(lx, bt - 3, 2, 4, LINE); px(lx, bt - 3, 2, 1, U.shade(r.top, 0.20));
      rimEdge(lx + 1, bt - 2, 1, 3, 0.18);
    }
    chamf(x - 1, bt - 1, w + 2, bh + 2, LINE, 2);
    chamf(x, bt, w, bh, r.face, 2);
    px(x + 1, bt, w - 2, 1, '#b0b6b2');                           // kept silver top rail
    px(x + 2, bt + 1, w - 4, 1, U.shade(r.top, 0.16)); keyEdge(x + 2, bt, 14, 1, 0.28);
    px(x, bt + 3, 1, bh - 6, r.lit); px(x + w - 1, bt + 3, 1, bh - 6, r.dk);
    rimEdge(x + w - 1, bt + 3, 1, bh - 6, 0.22);
    px(x + 2, bt + bh - 2, w - 4, 1, U.shade(r.face, -0.26));
    px(x + 2, bt + bh - 1, w - 4, 1, r.ao);                       // shallow underside, not a floor line
    // WEST — three labelled drawers, shallow: 1px proud, brass pull, card-tops just visible in the middle one
    for (let d = 0; d < 3; d++) {
      const dy = bt + 5 + d * 4, open = d === 1;
      px(x + 2, dy, 13, 3, U.shade(r.face, open ? 0.10 : 0.02));
      px(x + 2, dy, 13, 1, r.lit); keyEdge(x + 3, dy, 8, 1, 0.14);
      px(x + 2, dy + 2, 13, 1, r.ao);
      px(x + 4, dy + 1, 5, 1, '#9aa29c');                         // label holder
      px(x + 5, dy + 1, 3, 1, U.shade('#9aa29c', -0.34));
      px(x + 11, dy + 1, 2, 1, '#8a8256');                        // brass pull
      if (open) { px(x + 3, dy - 1, 11, 1, '#b8c0bc'); px(x + 3, dy - 1, 11, 1, U.shade('#b8c0bc', -0.12)); }
    }
    // CENTRE — backlit index well
    const wx = x + 16, ww = 22, wy = bt + 4, wh = 13;
    inset(wx, wy, ww, wh, '#141a18');
    px(wx + 1, wy + 1, ww - 2, wh - 2, '#0f1614');                // never dead black: the well is lit from behind
    const cols = 6, rows = 3, land = Math.floor(now / 1000), litIdx = land % (cols * rows);
    const litC = litIdx % cols, prevC = ((land - 1 + cols * rows) % (cols * rows)) % cols;
    const tt = Math.min(1, (now % 1000) / 260);                   // the carriage travels, then lifts
    const carX = wx + 2 + Math.round((prevC + (litC - prevC) * tt) * 3);
    for (let rj = 0; rj < rows; rj++) for (let c = 0; c < cols; c++) {
      const cx = wx + 2 + c * 3, idx = rj * cols + c, flip = idx === litIdx && tt >= 1;
      const cy = wy + 2 + rj * 3 - (flip ? 1 : 0);                // the pulled slip stands proud of its file
      const sw = 2 + (U.hash('ix' + idx) % 2);
      px(cx, cy + 3, sw + 1, 1, '#0b110f');                       // slot shadow it came out of
      px(cx, cy, sw + 1, 3, flip ? '#c8f2ff' : '#aab4b0');
      px(cx, cy, sw + 1, 1, flip ? '#e8fbff' : '#c6cec9');
      px(cx, cy + 1, 1, 2, flip ? '#9fe0f2' : U.shade('#aab4b0', -0.24));
      if (flip) bloom(cx - 1, cy - 1, sw + 3, 5, ACC.data, 0.32);
    }
    // the carriage itself, riding a rail across the top of the well
    px(wx + 1, wy + 1, ww - 2, 1, U.shade(r.face, -0.44));
    px(carX, wy, 4, 3, LINE); px(carX + 1, wy + 1, 2, 1, U.shade(r.top, 0.22));
    px(carX + 1, wy + 2, 2, 1, tt >= 1 ? ACC.data : U.shade(ACC.data, -0.5));
    bloom(carX + 1, wy + 2, 2, 1, ACC.data, tt >= 1 ? 0.30 : 0.14);
    const sweep = wx + 2 + Math.floor((now / (on ? 20 : 34)) % (ww - 5));   // kept 1px query sweep
    glow(sweep, wy + 1, 1, wh - 2, '#cfe0dc', 0.34);
    scanl(wx + 1, wy + 1, ww - 2, wh - 2, 0.16);
    // EAST — lookup readout: the call number ticking over, plus the two kept status dots
    const rx0 = x + 39;
    inset(rx0, wy, 7, wh, '#0a120f');
    for (let j = 0; j < 4; j++) {
      const lw = 1 + ((U.hash('cn' + land + j) % 4));
      px(rx0 + 1, wy + 2 + j * 2, Math.min(lw + 1, 5), 1, on ? U.shade(ACC.data, -0.10) : U.shade(ACC.data, -0.52));
    }
    bloom(rx0 + 1, wy + 2, 5, 7, ACC.data, on ? 0.14 : 0.07);
    px(rx0 + 1, wy + wh - 2, 1, 1, ACC.flow);                     // kept steady amber
    bloom(rx0 + 1, wy + wh - 2, 1, 1, ACC.flow, 0.30);
    px(rx0 + 5, wy + wh - 2, 1, 1, blink(700, ph) ? '#dfe6e2' : '#3a423e');   // kept blinking silver
    wear(x + 2, bt + 2, w - 4, bh - 4, 5, U.shade(r.face, -0.10));
  };
  F.arc_microfiche = (x, y, w, h, f) => {
    // MICROFICHE (2x1, blocks:true) — v4. Bolted reader desk. The reels are now ASYMMETRIC — a fat feed reel
    // west, a lean take-up east — and they notch in OPPOSITE directions, so the film has a readable direction
    // of travel instead of two identical discs twitching. The frame in the viewport steps sideways with each
    // advance and the flash-scan runs across it. Kept: the 2.2s notch cycle, the advancing flicker, f.work
    // driving the lamp brighter, the engraved label plate, and the ready-LED timings.
    const r = RAMP.gun, ph = (f && f.x) || 0;
    const step = Math.floor(now / 2200), advancing = (now % 2200) < 260, lit = !!(f && f.work);
    shadow2(x + 1, y + h - 1, w - 2);
    deckPlate(x - 1, y + 8, w + 2, h - 8);
    deckSocket(x + w + 1, y + h - 3, lit);
    cable(x + w - 2, y + 7, x + w + 2, y + h - 3, 2.2);
    for (const lx of [x + 2, x + w - 5]) {
      px(lx, y + 9, 3, 3, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 2, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // short front face with the engraved silver label plate (kept)
    rr(x - 1, y + 4, w + 2, 6, LINE);
    px(x, y + 5, w, 3, r.face);
    px(x, y + 5, w, 1, r.lit); keyEdge(x + 1, y + 5, w - 3, 1, 0.15);
    px(x, y + 7, w, 1, r.ao);
    px(x + 6, y + 6, w - 13, 1, '#adb3b0'); px(x + 6, y + 6, w - 13, 1, U.shade('#adb3b0', 0.10));
    for (let i = 0; i < w - 16; i += 3) px(x + 8 + i, y + 6, 2, 1, '#63676a');   // engraved text
    rimEdge(x + w - 7, y + 6, 1, 1, 0.24);
    // desk slab
    chamf(x - 1, y - 1, w + 2, 7, LINE, 2);
    chamf(x, y, w, 5, r.top, 2);
    px(x + 2, y, w - 4, 1, r.sheen); keyEdge(x + 2, y, 8, 1, 0.28);
    px(x, y + 2, 1, 2, r.lit); px(x + w - 1, y + 2, 1, 2, r.dk);
    rimEdge(x + w - 1, y + 2, 1, 2, 0.20);
    px(x + 2, y + 4, w - 4, 1, U.shade(r.top, -0.18));
    wear(x + 1, y + 1, w - 2, 4, 3, U.shade(r.top, -0.10));
    dial(x + w - 5, y + 1, r.top, now / 1100 + ph);               // focus knob on the desk
    // reader housing standing on the slab, with a HOOD shading the glass
    chamf(x + 1, y - 12, w - 2, 13, LINE, 2);
    chamf(x + 2, y - 11, w - 4, 11, r.face, 2);
    px(x + 3, y - 11, w - 6, 1, r.top); keyEdge(x + 3, y - 11, 7, 1, 0.26);
    px(x + 2, y - 9, 1, 8, U.shade(r.face, 0.08)); px(x + w - 3, y - 9, 1, 8, r.dk);
    rimEdge(x + w - 3, y - 9, 1, 8, 0.22);
    px(x + 3, y, w - 6, 1, r.ao);                                 // housing AO onto the slab
    // FROSTED VIEWPORT under a jutting hood
    const vx = x + 9, vy = y - 8, vw = 6, vh = 7;
    px(vx - 2, vy - 2, vw + 4, 2, LINE); px(vx - 1, vy - 2, vw + 2, 1, U.shade(r.top, 0.14));
    keyEdge(vx - 1, vy - 2, 4, 1, 0.24);
    px(vx - 1, vy - 1, vw + 2, 1, r.ao);                          // the hood's shadow across the glass top
    inset(vx - 1, vy, vw + 2, vh, '#2f3b39');
    const base = lit ? 0.36 : 0.15;
    const flk = advancing ? 0.16 * Math.abs(flick(70)) : 0.05 * Math.sin(now / 500);
    px(vx, vy + 1, vw, vh - 2, lit ? '#5d706d' : '#394644');      // lamp field, never a black hole
    const fx = vx + (step % 3);                                   // the document frame steps sideways
    px(fx, vy + 1, 4, vh - 2, lit ? '#c2d0cf' : '#8e9a99');
    for (let j = 0; j < 3; j++) px(fx + 1, vy + 2 + j * 2, 1 + (U.hash('mf' + step + j) % 3), 1, lit ? '#4a5654' : '#5f6a68');
    if (advancing) px(vx, vy + 1 + (step % (vh - 2)), vw, 1, '#eef6f5');
    bloom(vx, vy + 1, vw, vh - 2, '#cfe0de', base + flk);
    spill(vx - 1, vy + vh, vw + 2, '#cfe0de', lit ? 0.16 : 0.07, 3);
    // ASYMMETRIC reels — fat feed west, lean take-up east, notching opposite ways
    const ry = y - 5;
    for (let b = 0; b < 2; b++) {
      const cx = b ? x + w - 5 : x + 5, rad = b ? 2 : 3, o = (b ? -step : step) & 3;
      px(cx - rad, ry - rad, rad * 2, rad * 2, '#666c6c');
      px(cx - rad + 1, ry - rad + 1, rad * 2 - 2, rad * 2 - 2, '#98a09f');
      px(cx - rad + 1, ry - rad + 1, rad * 2 - 2, 1, U.shade('#98a09f', 0.22));
      rimEdge(cx + rad - 1, ry - rad + 1, 1, rad * 2 - 2, 0.22);
      if (o === 0) px(cx - rad + 1, ry, rad * 2 - 2, 1, '#d6dada');
      else if (o === 1) px(cx, ry - rad + 1, 1, rad * 2 - 2, '#d6dada');
      else if (o === 2) { px(cx - 1, ry - 1, 1, 1, '#d6dada'); px(cx + 1, ry + 1, 1, 1, '#d6dada'); }
      else { px(cx + 1, ry - 1, 1, 1, '#d6dada'); px(cx - 1, ry + 1, 1, 1, '#d6dada'); }
      px(cx, ry, 1, 1, '#454b4b');
    }
    // film threaded across the housing crown, upper strand bright as it pulls
    px(x + 7, ry - 4, w - 14, 1, advancing ? '#e4e8e8' : '#b0b6b6');
    for (let i = 0; i < w - 14; i += 2) px(x + 7 + i, ry - 4, 1, 1, U.shade('#b0b6b6', -0.40));   // sprocket holes
    px(x + 7, ry + 3, w - 14, 1, U.shade('#b0b6b6', -0.26));      // slack lower strand
    const on2 = lit ? blink(900, ph) : blink(2600, ph);           // kept ready-LED timings
    px(x + w - 5, y - 10, 1, 1, on2 ? ACC.work : '#16302a');
    if (on2) bloom(x + w - 5, y - 10, 1, 1, ACC.work, 0.34);
  };
  F.arc_floorlight = (x, y, w, h, f) => {   // v4 deck light — FLAT recessed ring; the only rise is the light itself
    // Walk-over prop: everything here sits at or below the deck plane. v4 only changes falloff — v3 stamped
    // two flat alpha rects, which read as a translucent sticker lying on the floor rather than as a lamp.
    const cx = x + (w >> 1);
    const well = [[3, 6], [2, 8], [1, 10], [1, 10], [1, 10], [1, 10], [2, 8], [3, 6]];
    well.forEach((s, j) => px(x + s[0], y + 2 + j, s[1], 1, '#171b19'));
    px(x + 3, y + 2, 6, 1, '#101413');                          // deep top lip — light never reaches in here
    px(x + 3, y + 9, 6, 1, U.shade('#1f2422', 0.12));           // bottom bevel catch (kept)
    const ring = [[3, 6], [2, 8], [2, 8], [2, 8], [2, 8], [3, 6]];
    ring.forEach((s, j) => px(x + s[0], y + 3 + j, s[1], 1, '#2a302d'));
    px(x + 3, y + 3, 6, 1, '#3d4a43'); keyEdge(x + 3, y + 3, 4, 1, 0.22);   // ring north arc takes the key
    px(x + 2, y + 4, 1, 4, '#333e38'); px(x + 9, y + 4, 1, 4, '#1c2220');
    rimEdge(x + 9, y + 4, 1, 4, 0.22);                          // cold bounce on the east arc
    px(x + 3, y + 4, 1, 1, '#48544c'); px(x + 8, y + 4, 1, 1, '#48544c');   // bezel bolts
    px(x + 3, y + 7, 1, 1, '#1f2622'); px(x + 8, y + 7, 1, 1, '#1f2622');
    // LENS. v4 filled the well with a 6x4 slab of neutral #dfe2e0 and two blooms, which is a white pill
    // lying on the deck — no colour to say "lamp" and no internal structure to say "lens". Two changes fix
    // it: the light is COOL (this deck's own aisle lighting, not paper), and the lens carries FRESNEL RIBS,
    // which is the one detail that reads as an optic at any size.
    // Also STEADY. It used to breathe on a 1300ms clock, and an aisle lamp has no mechanism that breathes —
    // idle is not "dead" here, it is simply a lamp that is on.
    const LENS = '#79b4cc';
    const lens = [[4, 4], [3, 6], [3, 6], [4, 4]];
    lens.forEach((s, j) => px(x + s[0], y + 4 + j, s[1], 1, U.shade(LENS, -0.30)));
    px(x + 3, y + 5, 6, 1, U.shade(LENS, 0.22)); px(x + 3, y + 6, 6, 1, U.shade(LENS, -0.52));  // fresnel ribs
    px(x + 4, y + 5, 2, 1, U.shade(LENS, 0.50));                // hot inner glint, west-biased
    bloom(x + 3, y + 4, 6, 4, LENS, 0.16);                      // real falloff onto the surrounding plating
    px(x + 4, y + 7, 4, 1, U.shade(LENS, -0.10));               // the lens's south face, back toward the bezel
    px(cx - 2, y + 10, 1, 1, '#56706e'); px(cx + 1, y + 10, 1, 1, '#56706e');   // aisle chevron (kept)
    px(cx - 1, y + 11, 2, 1, '#56706e');
  };
  F.arc_ladder = (x, y, w, h, f) => {   // v4 ladder — bold diagonal LEANING on the wall; feet-only floor contact
    // blocks:false, so it must not read as a solid mass parked on the deck: it leans, its footprint is two
    // rubber feet, and its shadow lives only under those feet. The diagonal is the entire silhouette.
    const r = RAMP.steel;
    ctx.globalAlpha = 0.20; px(x, y + 11, 10, 1, '#000'); ctx.globalAlpha = 1;   // feet contact only
    const foot = y + 10, rows = 18;
    const xoAt = (i) => Math.round(i * 4 / (rows - 1));         // eastward lean drift
    for (let i = 0; i < rows; i++) {                            // pass 1: rail silhouettes
      const xo = xoAt(i), yy = foot - i;
      px(x + xo, yy, 4, 1, LINE); px(x + 6 + xo, yy, 4, 1, LINE);
    }
    px(x + xoAt(rows - 1), foot - rows, 4, 1, LINE);
    px(x + 6 + xoAt(rows - 1), foot - rows, 4, 1, LINE);
    for (const i of [3, 7, 11, 15]) {                           // pass 2: rungs, sunk between the rails
      const xo = xoAt(i), yy = foot - i;
      px(x + 2 + xo, yy - 1, 8, 3, LINE);
      px(x + 3 + xo, yy, 4, 1, r.sheen);
      px(x + 3 + xo, yy, 1, 1, U.shade(r.sheen, 0.14));
      keyEdge(x + 3 + xo, yy, 2, 1, 0.20);                      // warm key along the tread
      px(x + 3 + xo, yy + 1, 4, 1, r.ao);                       // the rung casts its own underside shadow
    }
    for (let i = 0; i < rows; i++) {                            // pass 3: rail faces, in front of the rungs
      const xo = xoAt(i), yy = foot - i;
      px(x + 1 + xo, yy, 1, 1, r.lit); px(x + 2 + xo, yy, 1, 1, r.face);
      px(x + 7 + xo, yy, 1, 1, r.face); px(x + 8 + xo, yy, 1, 1, r.dk);
    }
    rimEdge(x + 8 + xoAt(6), foot - 12, 1, 12, 0.16);           // cold sky bounce down the east rail
    px(x + 1 + xoAt(rows - 1), foot - rows + 1, 2, 1, r.sheen);
    px(x + 7 + xoAt(rows - 1), foot - rows + 1, 2, 1, r.sheen);
    px(x + 1, foot, 2, 1, '#1a1e22'); px(x + 7, foot, 2, 1, '#1a1e22');   // rubber feet
    px(x + 7, y + 3, 1, 2, '#39434b');                          // hazard tag on a string
    px(x + 6, y + 5, 3, 3, '#caa84a'); px(x + 6, y + 5, 3, 1, '#ffd34a');
    px(x + 7, y + 6, 1, 1, '#3a3020');
    // A specular is the ceiling strip reflected in the rail. Both the ladder and the strip are bolted down, so
    // the highlight CANNOT crawl — it sat on a 700ms clock climbing 15 rungs, which read as a scanning sensor.
    bloom(x + 1 + xoAt(9), foot - 9, 1, 1, '#eaf2f2', 0.20);        // one fixed catch mid-rail
    px(x + 1 + xoAt(rows - 4), foot - rows + 4, 1, 1, '#c9d4d4');   // fixed catch near the head
  };
  F.quarters_pooltable = (x, y, w, h, f) => {
    // v4 BILLIARDS (4x2) — TOP-BIAS OBLIQUE: we look DOWN on the bed, this is never a front elevation.
    // It shares a room with F.pokertable, also 4x2 and also a felt table, so the two are separated on
    // FOUR axes at once and the first one lands before any pixel of felt reads:
    //   silhouette  a LOW PENDANT BAR hanging in the room over the bed   (poker: nothing overhead)
    //   base        four chunky square corner legs                       (poker: one turned pedestal)
    //   rail        crisp rectangular mahogany with diamond sights       (poker: padded black oval, studs)
    //   felt        green under warm tungsten                            (poker: indigo under low ambient)
    // Freestanding lounge tier throughout — no deckplate, no floor socket, no bolted language.
    const r = RAMP.steel, ph = (f && f.x) || 0;
    const wood = '#5c4030', felt = '#2f5d3a', feltLit = '#3c7048';
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + w - 6]) {                    // four square corner legs (front pair visible)
      px(lx, y + 20, 4, 4, LINE);
      px(lx, y + 20, 1, 4, U.shade(wood, 0.20)); px(lx + 1, y + 20, 2, 4, U.shade(wood, -0.10));
      px(lx + 3, y + 20, 1, 4, U.shade(wood, -0.34)); rimEdge(lx + 3, y + 20, 1, 3, 0.16);
      px(lx, y + 23, 4, 1, '#0a0d10');
    }
    underAO(x + 6, y + 20, w - 12, 3);
    // apron under the bed — routed beading, warm catch under the rail's overhang
    chamf(x - 1, y + 13, w + 2, 7, LINE, 2);
    px(x, y + 14, w, 5, U.shade(wood, -0.16));
    px(x, y + 14, w, 1, U.shade(wood, 0.12)); keyEdge(x + 1, y + 14, w - 5, 1, 0.14);
    px(x, y + 15, 1, 4, U.shade(wood, 0.06)); px(x + w - 1, y + 15, 1, 4, U.shade(wood, -0.32));
    rimEdge(x + w - 1, y + 15, 1, 4, 0.20);
    for (let i = 0; i < 3; i++) px(x + 8 + i * 15, y + 16, 9, 1, U.shade(wood, -0.32));
    px(x, y + 18, w, 1, U.shade(wood, -0.46));
    // RECTANGULAR mahogany rail ring — chamf k=1 keeps the corners crisp; the oval read belongs to poker
    chamf(x - 1, y - 4, w + 2, 19, LINE, 1);
    chamf(x, y - 3, w, 17, wood, 1);
    px(x + 1, y - 3, w - 2, 1, U.shade(wood, 0.34)); keyEdge(x + 2, y - 3, 12, 1, 0.28);
    px(x, y - 1, 1, 14, U.shade(wood, 0.14)); px(x + w - 1, y - 1, 1, 14, U.shade(wood, -0.30));
    rimEdge(x + w - 1, y - 1, 1, 14, 0.20);
    px(x + 1, y + 12, w - 2, 1, U.shade(wood, -0.24));        // rail front lip
    for (let i = 0; i < 6; i++) {                             // diamond sight inlays — pure billiards vocabulary
      px(x + 6 + i * 7, y - 2, 1, 1, U.shade(wood, 0.50));
      px(x + 6 + i * 7, y + 11, 1, 1, U.shade(wood, 0.34));
    }
    for (let i = 0; i < 4; i++) px(x + 4 + i * 12, y - 1, 7, 1, U.shade(wood, 0.10));   // grain along the rail
    // FELT BED
    inset(x + 4, y + 1, w - 8, 11, U.shade(felt, -0.40));
    px(x + 5, y + 2, w - 10, 9, felt);
    for (let i = 0; i < 9; i++) {                             // west-lit diagonal nap gradient (kept)
      const litw = Math.max(0, Math.floor((w - 10) * (1 - i / 9)) - i * 2);
      if (litw > 0) px(x + 5, y + 2 + i, Math.min(litw, w - 10), 1, feltLit);
    }
    px(x + 5, y + 2, w - 10, 1, U.shade(feltLit, 0.14));      // nap sheen along the head cushion
    px(x + 5, y + 10, w - 10, 1, U.shade(felt, -0.28));       // cushion shadow at the near rail
    // SIX POCKETS cut through the rail — jaw, drop and a brass ring, not a black square
    const pk = [[x + 3, y], [x + (w >> 1) - 2, y - 1], [x + w - 8, y],
                [x + 3, y + 9], [x + (w >> 1) - 2, y + 10], [x + w - 8, y + 9]];
    for (const p of pk) {
      chamf(p[0], p[1], 5, 4, '#0d1310', 1);
      px(p[0] + 1, p[1], 3, 1, U.shade(wood, -0.46));         // shadowed jaw
      px(p[0] + 1, p[1] + 1, 3, 2, '#04070a');                // the drop
      px(p[0], p[1] + 3, 5, 1, U.shade(wood, 0.20));          // brass pocket ring
    }
    // BALLS — the 8-ball still drifts on its 1400ms clock (kept)
    const drift = Math.round(Math.sin(now / 1400 + ph));
    const balls = [[x + 12, y + 4, '#e8e2d2'], [x + (w >> 1) + 1 + drift, y + 6, '#15161a'],
                   [x + w - 15, y + 4, '#a83a32'], [x + 11, y + 8, '#3a5aa8'],
                   [x + w - 13, y + 8, '#caa84a'], [x + (w >> 1) - 6, y + 8, '#3a6a8a'],
                   [x + 21, y + 3, '#4a8a4a']];
    for (const b of balls) {
      px(b[0], b[1] + 2, 3, 1, U.shade(felt, -0.36));         // contact shadow ON the felt
      chamf(b[0], b[1], 3, 3, b[2], 1);
      px(b[0], b[1], 2, 1, U.shade(b[2], 0.28));
      px(b[0], b[1], 1, 1, U.shade(b[2], 0.50));              // soft catch — a white speck reads as a dead pixel
      px(b[0] + 2, b[1] + 2, 1, 1, U.shade(b[2], -0.36));
      rimEdge(b[0] + 2, b[1] + 1, 1, 1, 0.16);
    }
    // a CUE left lying across the bed — the only line on the whole prop that isn't parallel to a rail
    for (let i = 0; i < 26; i++)
      px(x + 9 + i, y + 10 - Math.round(i * 0.3), 1, 1,
         i < 4 ? '#1c2228' : i < 8 ? '#7a6a4a' : U.shade('#c9a878', 0.02 + i * 0.004));
    px(x + 17, y - 2, 2, 2, '#3d6a5a'); px(x + 17, y - 2, 2, 1, '#548a76');   // chalk cube on the rail
    for (let i = 0; i < 5; i++) {                                             // triangle rack hung on the rail
      px(x + 24 + i, y - 3 + i, 1, 1, U.shade(wood, 0.40));
      px(x + 32 - i, y - 3 + i, 1, 1, U.shade(wood, 0.24));
    }
    // LOW PENDANT BAR — cords, spine, three cone shades. This is the silhouette that does the work.
    for (const cx0 of [x + 14, x + w - 15]) px(cx0, y - 17, 1, 6, '#0b1114');
    chamf(x + 8, y - 12, w - 16, 3, LINE, 1);
    px(x + 9, y - 11, w - 18, 2, r.face); px(x + 9, y - 11, w - 18, 1, r.lit);
    keyEdge(x + 10, y - 11, 10, 1, 0.24);
    px(x + 9, y - 10, w - 18, 1, U.shade(r.face, -0.36));
    const pulse = 0.28 + 0.16 * (0.5 + 0.5 * Math.sin(now / 760 + ph));   // kept lamp clock
    for (let s = 0; s < 3; s++) {
      const sx0 = x + 8 + s * 14;
      for (let j = 0; j < 4; j++) {                            // cone shade, widening as it drops
        px(sx0 + 3 - j - 1, y - 9 + j, 5 + j * 2, 1, LINE);
        px(sx0 + 3 - j, y - 9 + j, 3 + j * 2, 1, j ? U.shade(r.face, 0.04) : r.lit);
      }
      keyEdge(sx0 + 2, y - 9, 3, 1, 0.24);
      px(sx0 + 8, y - 7, 1, 2, r.dk); rimEdge(sx0 + 8, y - 7, 1, 2, 0.20);
      px(sx0, y - 6, 9, 1, '#ffdca6');                         // the lit mouth of the shade
      bloom(sx0, y - 6, 9, 1, KEY, 0.30);
      spill(sx0, y - 5, 9, KEY, 0.18, 4);                      // the cone of light on its way down
    }
    for (let s = 0; s < 3; s++) {                              // three warm pools landing on the felt
      const sx0 = x + 8 + s * 14;
      glow(sx0 - 1, y + 1, 11, 9, '#ffb84d', pulse * 0.28);
      glow(sx0 + 1, y + 3, 7, 5, '#ffb84d', pulse * 0.24);
    }
    for (const p of pk) glow(p[0], p[1], 5, 4, '#ffb84d', pulse * 0.30);   // pocket liners take the lamp (kept)
  };
  F.quarters_vending = (x, y, w, h, f) => {
    // v4 VENDING (1x2) — TALL 3/4, freestanding. The other backlit prop in this room is the fishtank, and
    // the two must not share a light: water is caustic and moving, chilled glass is FLAT cold fluorescent
    // behind product rows. So the interior here is a dead-even tube per shelf with the stock silhouetted
    // against it, and the only warm light on the whole machine is the header and the dispense mouth —
    // two temperatures, 20px apart, which is the strongest depth cue this narrow a prop can get.
    // f.work = the station is busy: the READY lamp burns hotter. Header/chase/ready clocks all preserved.
    const r = RAMP.steel, ph = (f && f.x) || 0, on = !!(f && f.work);
    const cw = w + 1, cold = '#cfe9f5', amber = '#ffb84d';   // the cabinet runs a touch proud of its tile (kept)
    shadow2(x + 1, y + h - 1, cw - 2);
    cable(x + cw - 2, y + 19, x + cw, y + h - 2, 2);         // limp power lead — freestanding, so NO floor socket
    // TALL 3/4 casing: chamfered slab, warm key down the west facet, cool sky bounce down the east
    chamf(x - 1, y - 6, cw + 2, h + 5, LINE, 2);
    chamf(x, y - 5, cw, h + 3, r.face, 2);
    px(x, y - 3, 1, h - 2, U.shade(r.face, 0.10)); keyEdge(x, y - 3, 1, 10, 0.12);
    px(x + cw - 1, y - 3, 1, h - 2, r.dk); rimEdge(x + cw - 1, y - 3, 1, h - 2, 0.22);
    chamf(x, y - 9, cw, 4, LINE, 1);                         // crown cap we look down on
    px(x + 1, y - 8, cw - 2, 2, r.top); px(x + 1, y - 8, cw - 2, 1, r.sheen);
    keyEdge(x + 1, y - 8, 6, 1, 0.26);
    px(x + 1, y - 6, cw - 2, 1, U.shade(r.top, -0.24));
    // LIT BRAND HEADER, jutting proud — the warm half of the temperature split
    const hb = blink(1600);
    chamf(x - 2, y - 5, cw + 4, 4, LINE, 1);
    px(x - 1, y - 4, cw + 2, 2, hb ? amber : '#8a5f28');
    px(x + 1, y - 4, 4, 1, '#ffe2b0');                       // header glint (kept)
    bloom(x - 1, y - 4, cw + 2, 2, amber, hb ? 0.30 : 0.12);
    spill(x - 1, y - 2, cw + 2, amber, 0.16, 3);             // warm wash falling onto the glass frame
    px(x - 1, y - 2, cw + 2, 1, U.shade('#8a5f28', -0.42));  // header underside
    // GLASS: three shelves, each on its own flat tube, stock read as SILHOUETTE not as colour
    inset(x + 2, y - 1, 8, 15, '#0b1418');
    px(x + 3, y, 6, 13, '#16323c');                          // lit back wall of the cabinet
    for (let row = 0; row < 3; row++) {
      const ry = y + row * 4;
      px(x + 3, ry, 6, 1, cold);                             // shelf tube — deliberately NOT wavering
      bloom(x + 3, ry, 6, 1, cold, 0.24);
      for (let c = 0; c < 3; c++) {
        const seed = U.hash('vend' + row + c);               // kept seed so the stock layout never reshuffles
        const base = seed % 2 === 0 ? '#7a2e2e' : '#1f5a63';
        px(x + 3 + c * 2, ry + 1, 2, 2, U.shade(base, -0.34));
        px(x + 3 + c * 2, ry + 1, 1, 2, U.shade(base, 0.12));   // cold rim on the backlit edge
        px(x + 3 + c * 2, ry + 1, 2, 1, U.shade(base, 0.26));   // cap glint
      }
      for (let i = 0; i < 6; i += 2)                         // delivery coil in FRONT of the row —
        px(x + 3 + i, ry + 1 + ((i >> 1) & 1), 1, 1, U.shade(cold, -0.38));   // this is what says vending, not shelf
      px(x + 3, ry + 3, 6, 1, '#0e2029');                    // shelf lip in its own shadow
    }
    px(x + 3, y + 12, 6, 1, '#0a1a20');                      // one sold-out slot at the bottom
    ctx.globalAlpha = 0.12; px(x + 3, y - 1, 2, 9, '#dff4ff'); px(x + 6, y - 1, 1, 5, '#dff4ff'); ctx.globalAlpha = 1;
    spill(x + 2, y + 13, 8, cold, 0.16, 3);                  // chilled glass pools cold light down the front
    // CONTROL PILLAR east: coin slot, keypad, and the READY lamp that reads f.work
    px(x + 10, y - 1, 2, 15, U.shade(r.face, 0.06));
    px(x + 10, y - 1, 1, 15, U.shade(r.face, 0.20)); px(x + 11, y - 1, 1, 15, r.dk);
    rimEdge(x + 11, y - 1, 1, 15, 0.18);
    px(x + 10, y, 2, 1, '#0d1216'); px(x + 10, y + 1, 2, 1, U.shade(r.face, 0.28));   // coin slot + its lit lip
    for (let i = 0; i < 4; i++) px(x + 10, y + 3 + i * 2, 2, 1, '#9aa49c');           // keypad rows
    const ready = blink(620);
    px(x + 10, y + 12, 1, 1, ready ? (on ? '#7dffb0' : ACC.work) : '#16302a');
    if (ready) bloom(x + 10, y + 12, 1, 1, ACC.work, on ? 0.34 : 0.18);
    // scrolling amber chase strip (clock kept 1:1)
    const sy = y + 14, segs = 5, off = Math.floor(now / 140) % segs;
    px(x + 2, sy, cw - 4, 2, '#241c10');
    for (let s = 0; s < segs; s++) {
      const seg = ((s + off) % 3) !== 0;
      px(x + 2 + s * 2, sy, 2, 1, seg ? amber : '#4a3a1c');
      px(x + 2 + s * 2, sy + 1, 2, 1, seg ? '#b8862f' : '#33290f');
    }
    bloom(x + 2, sy, cw - 4, 2, amber, 0.15 + 0.07 * (0.5 + 0.5 * flick(900, ph)));
    // DISPENSE MOUTH — deep, warm, and with a can actually sitting in the tray waiting to be taken
    chamf(x + 2, y + 17, cw - 4, 5, LINE, 1);
    px(x + 3, y + 17, cw - 6, 1, U.shade(r.face, 0.22)); keyEdge(x + 4, y + 17, cw - 9, 1, 0.16);
    px(x + 3, y + 18, cw - 6, 3, '#0d1110');
    px(x + 3, y + 18, cw - 6, 1, U.shade(r.face, -0.46));    // the lip you reach under
    bloom(x + 4, y + 19, cw - 8, 1, amber, 0.15 + 0.05 * flick(1300, 1));
    px(x + 5, y + 19, 2, 2, '#7a2e2e'); px(x + 5, y + 19, 1, 2, '#a04a44'); px(x + 5, y + 19, 2, 1, '#8a98a8');
    // kick plate + feet with a real floor gap
    px(x + 1, y + 21, cw - 2, 1, r.ao);
    underAO(x + 2, y + 22, cw - 4, 1);
    px(x + 1, y + 22, 2, 2, r.dk); px(x + cw - 3, y + 22, 2, 2, r.dk);
    px(x + 1, y + 22, 1, 1, r.lit); px(x + cw - 3, y + 22, 1, 1, r.lit);
    wear(x + 1, y + 15, cw - 2, 6, 3, U.shade(r.face, -0.12));
  };
  F.quarters_lockerbank = (x, y, w, h, f) => {
    // LOCKER BANK (3x1) — v6. The v4 art was already articulated (real louvres, one door ajar, stowed
    // gear on the crown) and it still read as a low sideboard, because of PROPORTION alone: the door
    // bank was NINE rows tall under a 36px-wide carcass. The v3 projection law puts lockers in the TALL
    // 3/4 family — "full height, ~30px, brief agent occlusion is FINE, y-sort handles it" — so the
    // squatness was never a taste call, it was a prop that had quietly fallen out of its own family.
    // The doors now carry 21 rows. That height is what buys everything else here: a louvre STACK
    // instead of two token slots, a full-length handle stile, and a number plate that has room to sit.
    const r = RAMP.gun;
    const dT = y - 12, dH = 21, cT = y - 17;                  // door bank top / height, crown top
    shadow2(x + 1, y + h - 1, w - 2);
    for (const lx of [x + 2, x + (w >> 1) - 1, x + w - 5]) {  // three feet along the long footprint
      px(lx, y + 8, 3, 4, LINE); px(lx, y + 9, 1, 3, r.lit); px(lx + 1, y + 9, 1, 3, r.dk);
      rimEdge(lx + 2, y + 9, 1, 3, 0.16);
    }
    underAO(x + 5, y + 9, w - 10, 2);
    // ---- CROWN — chamfered top surface, warm ceiling strip along its back edge, cool bounce down the east
    chamf(x - 1, cT, w + 2, 6, LINE, 2);
    px(x, cT + 1, w, 4, r.top);
    px(x, cT + 1, w, 1, r.sheen); keyEdge(x + 1, cT + 1, 10, 1, 0.28);
    px(x, cT + 2, 1, 3, r.lit); px(x + w - 1, cT + 2, 1, 3, r.dk); rimEdge(x + w - 1, cT + 2, 1, 3, 0.20);
    px(x + 1, cT + 4, w - 2, 1, U.shade(r.top, -0.20));       // front lip of the crown
    // stowed on top: a folded towel, a helmet, a stack of ration tins
    px(x + 4, cT - 3, 7, 3, '#6a6152'); px(x + 4, cT - 3, 7, 1, '#857b68');
    px(x + 4, cT - 2, 7, 1, U.shade('#6a6152', -0.20)); px(x + 4, cT - 1, 7, 1, U.shade('#6a6152', -0.34));
    chamf(x + 15, cT - 4, 7, 5, LINE, 2);
    chamf(x + 16, cT - 3, 5, 4, U.shade(r.face, 0.16), 1);
    px(x + 16, cT - 3, 5, 1, U.shade(r.face, 0.36)); keyEdge(x + 16, cT - 3, 3, 1, 0.24);
    px(x + 16, cT - 1, 5, 1, '#0f1512');                      // helmet visor band
    rimEdge(x + 20, cT - 2, 1, 3, 0.18);
    px(x + 26, cT - 2, 4, 3, '#2a323a'); px(x + 26, cT - 2, 4, 1, U.shade(r.face, 0.28));
    px(x + 26, cT, 4, 1, U.shade(r.face, -0.30));
    // ---- DOOR BANK
    chamf(x - 1, dT - 1, w + 2, dH + 2, LINE, 2);
    px(x, dT, w, dH, r.face);
    px(x, dT, w, 1, r.lit); keyEdge(x + 1, dT, w - 5, 1, 0.16);   // catch under the crown overhang
    for (let d = 0; d < 3; d++) {
      const dx = x + 1 + d * 12;
      if (d) px(dx - 2, dT + 1, 1, dH - 2, r.ao);             // stile between doors
      if (d === 1) continue;                                  // the open one is built separately below
      chamf(dx, dT + 1, 10, dH - 3, U.shade(r.face, 0.14), 1);
      px(dx + 1, dT + 1, 8, 1, U.shade(r.face, 0.32));
      px(dx, dT + 2, 1, dH - 5, U.shade(r.face, 0.22)); px(dx + 9, dT + 2, 1, dH - 5, U.shade(r.face, -0.22));
      rimEdge(dx + 9, dT + 2, 1, dH - 5, 0.18);
      px(dx, dT + dH - 3, 10, 1, U.shade(r.face, -0.28));
      // LOUVRE BANK at the TOP ONLY — three slot-and-blade pairs. Two token slots read as a decal, but
      // a full-height stack reads as a SERVER RACK: evenly spaced horizontals over the whole face are
      // that family's signature. A locker vents at the head and is plain below, and that plain lower
      // half is what leaves the number plate somewhere to sit.
      for (let v = 0; v < 3; v++) {
        px(dx + 2, dT + 3 + v * 2, 6, 1, r.ao);
        px(dx + 2, dT + 4 + v * 2, 6, 1, U.shade(r.face, 0.28));
      }
      px(dx + 1, dT + 10, 8, 1, U.shade(r.face, -0.34));      // a pressed swage line across the door
      px(dx + 1, dT + 11, 8, 1, U.shade(r.face, 0.20));
      // NUMBER PLATE — a recessed card with a stencilled digit block, which the 9-row version had no room for
      px(dx + 2, dT + 14, 6, 4, U.shade(r.face, -0.30));
      px(dx + 2, dT + 14, 6, 1, U.shade(r.face, -0.52));
      px(dx + 3, dT + 15, 1, 2, '#8f9c96'); px(dx + 5, dT + 15, 1, 2, '#8f9c96'); px(dx + 6, dT + 16, 1, 1, '#8f9c96');
      // HANDLE STILE running most of the door height — the vertical is what says "this pulls open"
      px(dx + 8, dT + 5, 1, dH - 11, '#0c1210');
      px(dx + 8, dT + 5, 1, 3, U.shade(r.lit, 0.32));
      px(dx + 7, dT + dH - 7, 2, 1, '#7d8a84'); px(dx + 7, dT + dH - 6, 1, 2, '#3a4a44');   // hasp + padlock
    }
    // ---- the CENTRE door hangs open — the read that separates a locker bank from a fence
    const dx1 = x + 13;
    px(dx1 - 1, dT, 10, dH - 1, '#080d0b');                   // the dark inside of the locker
    for (const shy of [dT + 5, dT + 12]) {                    // two shelves, barely catching light
      px(dx1, shy, 8, 1, U.shade(r.face, -0.46));
      px(dx1, shy + 1, 8, 1, '#040806');
    }
    px(dx1 + 1, dT + 1, 6, 4, '#3a4632'); px(dx1 + 1, dT + 1, 6, 1, '#54644a');   // a shirt on the rail
    px(dx1 + 2, dT + 2, 1, 3, U.shade('#3a4632', -0.34));
    px(dx1 + 2, dT + 7, 5, 4, '#8f8674'); px(dx1 + 2, dT + 7, 5, 1, '#a89c86');   // a towel, folded
    px(dx1 + 1, dT + 14, 6, 4, '#2b2118'); px(dx1 + 1, dT + 14, 6, 1, '#463527'); // boots on the floor pan
    px(dx1 + 2, dT + 18, 4, 2, U.shade('#8f8674', -0.30));    // ... something hanging past the sill,
    px(dx1 + 3, dT + 20, 2, 1, U.shade('#8f8674', -0.50));    //     breaking the base line
    px(dx1 + 1, dT + 13, 1, 1, U.shade(ACC.data, -0.30));     // a datachit forgotten on the shelf
    bloom(dx1 + 1, dT + 13, 1, 1, ACC.data, 0.12);            // it is a dropped chit, not a device on standby
    px(dx1 - 4, dT, 4, dH - 1, LINE);                         // the leaf, swung west across its neighbour
    px(dx1 - 3, dT + 1, 3, dH - 3, U.shade(r.face, 0.22));
    px(dx1 - 3, dT + 1, 3, 1, U.shade(r.face, 0.38)); keyEdge(dx1 - 3, dT + 1, 3, 1, 0.22);
    px(dx1 - 1, dT + 1, 1, dH - 3, U.shade(r.face, -0.36));   // the leaf's shaded inner face
    for (let v = 0; v < 4; v++) px(dx1 - 3, dT + 4 + v * 2, 3, 1, U.shade(r.face, -0.10));   // its louvres
    px(dx1 - 3, dT + 13, 1, 3, '#7d8a84');                    // handle riding round with the leaf
    ctx.globalAlpha = 0.26; px(dx1 - 6, dT + 2, 2, dH - 5, '#000'); ctx.globalAlpha = 1;   // its cast shadow
    px(x + 3, dT + 19, 3, 2, '#b56a78'); px(x + 3, dT + 19, 3, 1, '#c98592');   // door 0: worn pink sticker
    // door 2: amber name-tag, BACKLIT AND STEADY. A name plate has nothing to report, so pulsing it was
    // the locker bank pretending to be an instrument panel.
    // ...and SMALL. On the 9-row carcass this plate was 5x1; carrying it up to 7x3 with a 0.44 bloom on
    // the taller door turned it into the brightest object on a cosmetic prop, competing with the real
    // telemetry emissives elsewhere in the room. A name plate is a label, so it gets label brightness.
    inset(x + 27, dT + 8, 5, 3, '#10161a');
    px(x + 28, dT + 9, 3, 1, U.shade('#ffb84d', -0.16));
    bloom(x + 28, dT + 9, 3, 1, '#ffb84d', 0.26);
    spill(x + 27, dT + 11, 5, '#ffb84d', 0.10, 3);
    px(x, y + 8, w, 1, r.ao);                                 // floor-line AO
    wear(x + 1, dT + 2, w - 2, dH - 6, 6, U.shade(r.face, -0.12));
  };
  F.quarters_minifridge = (x, y, w, h, f) => {
    // v4 MINI-FRIDGE (1x1) — ONE bold idea, per the 12px law: the door is standing AJAR and the cold
    // interior light is falling out onto the deck. That gives a 1-tile prop a broken silhouette, a
    // second light temperature, and a story, which no amount of magnets-on-a-box would have bought.
    // blink(2500) is preserved as the compressor cycle: the interior lamp hums brighter on its beat.
    const r = RAMP.steel, ph = (f && f.x) || 0;
    const cold = '#bfe9ff', run = blink(2500);
    shadow2(x + 2, y + h - 1, 8);
    for (const lx of [x + 2, x + 7]) {                         // stub feet, freestanding
      px(lx, y + 10, 3, 2, LINE); px(lx, y + 10, 1, 2, r.lit); px(lx + 1, y + 10, 1, 2, r.dk);
    }
    underAO(x + 4, y + 10, 4, 1);
    // the cold wedge lands on the deck FIRST so the cabinet's edges bite into it rather than float on it
    spill(x + 7, y + 7, 6, cold, run ? 0.26 : 0.20, 4);
    glow(x + 8, y + 3, 4, 7, cold, run ? 0.11 : 0.08);
    // carcass — chamfered, and open on its east side
    chamf(x + 1, y - 3, 10, 13, LINE, 2);
    chamf(x + 2, y - 2, 8, 11, U.shade(r.face, 0.10), 2);
    px(x + 2, y, 1, 8, U.shade(r.face, 0.22));                 // lit west facet
    px(x + 2, y + 8, 8, 1, r.ao);
    // LIT INTERIOR seen down the open jamb: a cold strip lamp at the top, two shelves, stock in silhouette
    px(x + 6, y - 1, 4, 9, '#0a1418');
    px(x + 6, y - 1, 4, 1, run ? '#e8f8ff' : '#c6e6f2');       // interior strip lamp
    bloom(x + 6, y - 1, 4, 1, cold, run ? 0.40 : 0.32);
    spill(x + 6, y, 4, cold, 0.22, 4);                         // falls down the shelves
    px(x + 6, y + 2, 4, 1, '#1d2c33'); px(x + 6, y + 5, 4, 1, '#1d2c33');   // shelf edges
    px(x + 7, y, 2, 2, '#123640'); px(x + 7, y, 1, 2, '#1f5766');           // a can, backlit
    px(x + 8, y + 3, 2, 2, '#3a1620'); px(x + 8, y + 3, 1, 2, '#5e2634');
    px(x + 6, y + 6, 3, 2, '#16232a');
    // DOOR LEAF, swung proud on its west hinge — its free edge is what casts the wedge
    chamf(x + 1, y - 3, 7, 12, LINE, 2);
    chamf(x + 2, y - 2, 5, 10, U.shade(r.face, 0.16), 2);
    px(x + 2, y - 2, 5, 1, U.shade(r.face, 0.30)); keyEdge(x + 2, y - 2, 4, 1, 0.20);
    px(x + 2, y, 1, 7, U.shade(r.face, 0.24));
    px(x + 6, y - 1, 1, 9, U.shade(r.face, 0.44));             // the free edge, lit hard by the interior
    keyEdge(x + 6, y - 1, 1, 9, 0.10);
    px(x + 2, y + 1, 5, 1, U.shade(r.face, -0.28));            // freezer-compartment seam
    px(x + 5, y + 3, 1, 4, '#9aa8b4'); px(x + 5, y + 3, 1, 1, '#c6cccb');   // chrome handle down the free edge
    px(x + 3, y + 4, 1, 1, '#ffb84d'); px(x + 3, y + 6, 1, 1, '#5fb6a8');   // magnets
    px(x + 4, y + 2, 2, 1, '#8f8674');                                       // a note stuck to the door
    // rounded top with a can left on it, and the compressor telltale
    chamf(x + 2, y - 4, 8, 3, LINE, 1);
    px(x + 2, y - 3, 8, 2, U.shade(r.top, 0.10)); px(x + 2, y - 3, 8, 1, U.shade(r.sheen, 0.10));
    keyEdge(x + 3, y - 3, 5, 1, 0.24);
    px(x + 7, y - 6, 2, 3, '#a83a32'); px(x + 7, y - 6, 1, 3, '#c86a5a'); px(x + 7, y - 6, 2, 1, '#8a98a8');
    px(x + 3, y + 7, 1, 1, run ? '#ffb84d' : '#36424c');
    if (run) bloom(x + 3, y + 7, 1, 1, '#ff9d2e', 0.26);
  };

  F.airlock = (x, y, w, h, f) => {
    // AIRLOCK (1x1) — the room-seal hatch. ONE idea, no cramming: a floor-flat OCTAGONAL IRIS. At 12px
    // the silhouette is the whole read, so chamf(k=3) cuts a genuine octagon rather than rr()'s lozenge,
    // and the three states stay separable by SHAPE first, colour second:
    //   open   = blades retracted, a lit central eye        closed = blades meet on a sealed seam
    //   jammed = blades half-shut on a sparking, dark seam
    // f.door drives it live (setDoorState).
    const st = (f && f.door) || 'open';
    const sealed = st === 'closed' || st === 'jammed', jam = st === 'jammed';
    const lc = jam ? '#ff5a4a' : sealed ? '#ffb347' : ACC.work;
    const r = RAMP.steel, cx = x + (w >> 1), cy = y + (h >> 1), rad = Math.min(w, h) / 2 - 1;
    shadow2(x + 1, y + h - 1, w - 2);                                  // floor contact
    // octagonal deck collar, bolted in — warm key across the north rim, cool bounce along the south
    chamf(x - 1, y - 1, w + 2, h + 2, LINE, 3);
    chamf(x, y, w, h, U.shade(r.face, -0.18), 3);
    px(x + 3, y, w - 6, 1, r.lit); keyEdge(x + 3, y, w - 8, 1, 0.30);
    px(x + 3, y + h - 1, w - 6, 1, r.ao); rimEdge(x + 3, y + h - 2, w - 6, 1, 0.18);
    px(x, y + 3, 1, h - 6, r.lit); px(x + w - 1, y + 3, 1, h - 6, r.dk);
    rimEdge(x + w - 1, y + 3, 1, h - 6, 0.22);
    for (const b of [[x + 2, y + 2], [x + w - 3, y + 2]]) px(b[0], b[1], 1, 1, '#caa84a');   // hazard bolts
    for (const b of [[x + 2, y + h - 3], [x + w - 3, y + h - 3]]) px(b[0], b[1], 1, 1, '#8a7434');
    // recessed circular blade track
    for (let dy = -rad + 1; dy <= rad - 1; dy++) {
      const half = Math.floor(Math.sqrt(Math.max(0, (rad - 1) * (rad - 1) - dy * dy)));
      if (half <= 0) continue;
      px(cx - half, cy + dy, half * 2, 1, '#0c1417');
      if (dy === -rad + 1) px(cx - half, cy + dy, half * 2, 1, '#151f24');   // lit lip at the top of the well
    }
    // IRIS BLADES — machined metal, lit on their north facets and sky-cooled on the south. A jammed iris
    // sits HALF closed (its own silhouette), so the state reads before the colour does.
    const close = jam ? Math.round(rad * 0.55) : sealed ? rad - 1 : 1;
    const bc = jam ? U.shade(r.top, -0.42) : U.shade(r.top, -0.05);
    for (let dy = -rad + 1; dy <= rad - 1; dy++) {
      const half = Math.floor(Math.sqrt(Math.max(0, (rad - 1) * (rad - 1) - dy * dy)));
      if (half <= 0) continue;
      const gap = Math.max(0, half - close);
      if (gap >= half) continue;
      px(cx - half, cy + dy, half - gap, 1, bc);
      px(cx + gap, cy + dy, half - gap, 1, bc);
      if (dy < 0) { px(cx - half, cy + dy, 1, 1, U.shade(bc, 0.30)); keyEdge(cx + half - 1, cy + dy, 1, 1, 0.16); }
      else { px(cx - half, cy + dy, 1, 1, U.shade(bc, -0.40)); rimEdge(cx + half - 1, cy + dy, 1, 1, 0.20); }
    }
    px(cx - 1, cy - rad + 1, 2, (rad - 1) * 2, U.shade(bc, -0.5));     // spoke between the blade pairs
    if (sealed) {
      px(cx - 1, cy - rad + 2, 2, rad * 2 - 3, U.shade(bc, -0.55));    // the sealed seam
      px(cx - 1, cy - 1, 2, 2, U.shade(bc, -0.28));                    // centre boss
      px(cx - 1, cy - 1, 2, 1, U.shade(bc, 0.18));
      if (jam) {
        bloom(cx - 1, cy - 2, 2, 4, '#ff5a4a', 0.22 + 0.14 * Math.sin(now / 110));   // the seam glows where it binds
        if (blink(150)) { px(cx, cy - 1, 1, 1, '#ffe6c8'); px(cx + 1, cy - 2, 1, 1, '#ffd9a0'); } // jam spark
      }
    } else {
      px(cx - 1, cy - 1, 2, 2, U.shade(ACC.work, -0.05));              // open: the lit eye through the hatch
      bloom(cx - 1, cy - 1, 2, 2, ACC.work, 0.26 + 0.10 * Math.sin(now / 400));
    }
    // status lamp on the north lintel — the one piece of signage this prop gets
    const on = jam ? blink(170) : sealed ? blink(680) : true;
    px(cx - 2, y, 4, 2, '#0c1417');
    px(cx - 1, y, 2, 2, on ? lc : U.shade(lc, -0.65));
    if (on) bloom(cx - 1, y, 2, 1, lc, jam ? 0.42 : sealed ? 0.22 : 0.28);
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
    // Docks (2×2 floor machines) are SOLID: belts hook to their ring tiles (connectBelt's pathable
    // excludes every prop footprint), so nothing needs to stand ON them — agents route around.
    // The 1×1 junctions below stay blocks:false: they sit ON a belt line (belt tile underneath),
    // and belts are walkable floor machinery by contract.
    { id: "intake", label: "INBOX", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: "INBOX — where OUTSIDE work (a DM, a routine) arrives on the floor and drops onto a belt. Orders you give in COMMS skip it — they land straight at the agent's BAY. You don't need one for an agent to work — a BAY alone is enough; the inbox is for watching outside work ride in." },
    { id: "bay", label: "BAY", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: "BAY — the agent dock. Click it, assign an agent — done: work for that agent lands here, no belts required. Add belts to watch work ride in from an INBOX (and finished work ride out to an OUTBOX). The props in its room become its powers." },
    { id: "filter", label: "FILTER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "FILTER — sorts UNADDRESSED work by its content, sending each kind down a different belt lane. Work already bound to an agent rides straight home past it. Click it to set the routes." },
    { id: "merger", label: "MERGER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "MERGER — buffers K incoming boxes, then emits one combined box. A join / map-reduce barrier." },
    { id: "splitter", label: "SPLITTER", cat: "workflow", tier: "functional", w: 1, h: 1, animated: true, blocks: false, desc: "SPLITTER — fans one work stream across its lanes to run several agents in parallel (load-balance)." },
    { id: "outbox", label: "OUTBOX", cat: "workflow", tier: "functional", w: 2, h: 2, animated: true, blocks: true, desc: "OUTBOX — the dispatch chute where an agent's finished reply leaves the station. Click it to read and rate every finished run waiting for you." },
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
    { id: "bunk", label: "BED", cat: "lounge", tier: "cosmetic", w: 2, h: 2, animated: true, blocks: true },
    { id: "quarters_pooltable", label: "POOL TABLE", cat: "lounge", tier: "cosmetic", w: 4, h: 2, animated: true, blocks: true },
    { id: "quarters_vending", label: "VENDING", cat: "lounge", tier: "cosmetic", w: 1, h: 2, animated: true, blocks: true },
    { id: "quarters_lockerbank", label: "LOCKERS", cat: "lounge", tier: "cosmetic", w: 3, h: 1, animated: true, blocks: true },
    { id: "quarters_minifridge", label: "MINIFRIDGE", cat: "lounge", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    // DECOR — small dressing & plain seating.
    { id: "coffee", label: "COFFEE", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "plant", label: "PLANT", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "rug", label: "RUG", cat: "decor", tier: "cosmetic", w: 4, h: 3, animated: true, blocks: false },
    { id: "treasury_pnl_holo", label: "PNL HOLO", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "arc_floorlight", label: "FLOOR LIGHT", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "arc_ladder", label: "LADDER", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "stool", label: "STOOL", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    { id: "chair", label: "CHAIR", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    // TABLES (2026-07-26) — the catalog had hero surfaces and nothing in between, so every small object
    // had to be parked on the deck. `surface: true` is what a mount:"surface" prop may be placed ON.
    { id: "sidetable", label: "SIDE TABLE", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: false, blocks: true, surface: true },
    { id: "loungetable", label: "LOUNGE TABLE", cat: "decor", tier: "cosmetic", w: 2, h: 1, animated: false, blocks: true, surface: true },
    { id: "longtable", label: "LONG TABLE", cat: "decor", tier: "cosmetic", w: 3, h: 1, animated: false, blocks: true, surface: true },
    // DECOR EXPANSION (2026-07-15) — theming set. Flat paint/looms walk-over; solid bodies block.
    { id: "lavalamp", label: "LAVA LAMP", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, mount: "surface" },
    { id: "crt_pile", label: "CRT PILE", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    { id: "cablerun", label: "CABLE RUN", cat: "decor", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false },
    { id: "hazardpad", label: "HAZARD PAD", cat: "decor", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: false },
    { id: "tallplant", label: "TALL PLANT", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    { id: "terrarium", label: "TERRARIUM", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    // DECOR EXPANSION wave 2 (2026-07-15, recurated) — fun/glow set. Flat holo/paint walk-over; cabinets block.
    { id: "holopet", label: "HOLO PET", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "plasmaglobe", label: "PLASMA GLOBE", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false, mount: "surface" },
    { id: "gachapon", label: "GACHAPON", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: true },
    // DECOR EXPANSION wave 3 (2026-07-15) — greenery + lounge picks.
    { id: "monstera", label: "MONSTERA", cat: "decor", tier: "cosmetic", w: 1, h: 1, animated: true, blocks: false },
    { id: "fishtank", label: "FISH TANK", cat: "lounge", tier: "cosmetic", w: 2, h: 1, animated: true, blocks: true },
    { id: "pokertable", label: "POKER TABLE", cat: "lounge", tier: "cosmetic", w: 4, h: 2, animated: true, blocks: true },
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
     jukebox grants the Spotify tools, but they're INERT until the user connects Spotify in TOOLSETS — so
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
    // MOUNT LIFT. A surface-standing prop is the SAME art as a floor prop, drawn higher: every prop
    // function anchors its contact to its own footprint bottom, so lifting the origin lifts the whole
    // thing and keeps every internal offset valid. This is deliberately the only place the lift is
    // applied — a prop function must never bake its own mount height.
    const lift = f.mount === 'surface' ? SURFACE_RISE : 0;
    const X = f.x * TILE, Y = f.y * TILE - lift, W = (f.w || 1) * TILE, H = (f.h || 1) * TILE;
    const o = { x: f.x, work: !!work, agentId: f.agentId || null, door: f.door || null };
    if (live) { o.heat = +live.heat || 0; o.prog = (live.prog == null) ? null : Math.max(0, Math.min(1, +live.prog || 0)); }
    if (f.t === 'connector_portal') {                 // a bound portal rides its connector's live state
      const cid = f.connectorId || null;
      o.bound = !!cid;
      o.state = cid ? ((connState[cid] && connState[cid].state) || 'offline') : 'unbound';
      o.fired = connectorFired(cid);
    }
    if (f.t === 'workbench') { const wf = workbenchFiredFor(f.id); o.fired = wf.fired; o.bad = wf.bad; }   // shell/verify pulse (room-scoped by propId)
    if (f.t === 'jukebox') o.live = jukeConnected;   // dead until Spotify is connected in TOOLSETS (object=capability truth)
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
