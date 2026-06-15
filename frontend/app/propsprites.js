/* SKYNET — propsprites.js : the canonical PROP (furniture) art + catalog.

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

  /* ============ FURNITURE (ported verbatim from v7 sprites.js) ============ */
  const F = {};

  F.desk = (x, y, w, h, f) => {
    sh(x + 1, y + h, w - 2);
    box(x, y + 3, w, h - 2, '#343e46');
    px(x + 1, y + 4, w - 2, h - 4, '#414d56');
    px(x + 1, y + 4, w - 2, 1, '#54626c');
    px(x + 1, y + 4, 6, 1, '#64727c'); // brushed steel sheen
    seamH(x + 1, y + h - 3, w - 2, '#414d56'); // front drawer seam
    px(x + w - 8, y + h - 2, 3, 1, '#2a343c'); // drawer pull
    rivets(x + 1, y + 4, w - 2, h - 5, '#5e6c76', '#222b32');
    wear(x + 1, y + 4, w - 2, h - 5, 3, '#37424a');
    // monitor on stand: neck + foot plate
    px(x + 5, y + 4, 2, 1, '#1a241e');
    px(x + 4, y + 5, 4, 1, '#222c26');
    box(x + 2, y - 3, 8, 7, '#1a241e');
    px(x + 3, y - 3, 6, 1, '#2c3a30'); // bezel catch
    inset(x + 3, y - 2, 6, 5, '#0d150f');
    if (f.work) {
      px(x + 4, y - 1, 4, 3, scr(f.x));
      px(x + 4, y - 1, 2, 1, '#dfffe8'); // top code line
      px(x + 4, y + 1, 3, 1, U.shade(scr(f.x), -0.3)); // dim line
      if (blink(180, f.x)) px(x + 4, y - 1, 3, 1, '#dfffe8');
      px(x + 7, y + 1, 1, 1, blink(400, f.x) ? '#dfffe8' : '#101a14'); // cursor
      scanl(x + 4, y - 1, 4, 3, 0.2);
      glow(x + 2, y + 4, 8, 2, scr(f.x), 0.18); // screen light spills on desk
      glow(x + 3, y - 2, 6, 5, scr(f.x), 0.10); // bezel glow
    } else {
      px(x + 4, y - 1, 4, 3, '#101a14');
      px(x + 4, y - 1, 1, 1, '#1c2a22'); // faint reflection
      px(x + 9, y + 2, 1, 1, blink(1600) ? '#ff9d2e' : '#33241a'); // standby
    }
    px(x + 9, y + 4, 1, 2, '#222b32'); // cable drop behind monitor
    inset(x + 13, y + 6, 6, 3, '#262e2a'); px(x + 14, y + 7, 4, 1, '#39443e'); // keyboard
    px(x + 14, y + 7, 2, 1, '#46544a'); // key glint
    px(x + 20, y + 7, 1, 1, '#39443e'); px(x + 20, y + 7, 1, 1, '#46544a'); // mouse
    px(x + 2, y + 8, 2, 2, '#3a6a62'); px(x + 2, y + 8, 2, 1, '#5aa89c'); // ceramic mug
    if (f.work && blink(700)) px(x + 3, y + 6, 1, 1, '#8a8a8a'); // coffee steam
    px(x + 11, y + 5, 2, 2, '#ffe066'); px(x + 11, y + 5, 2, 1, '#fff0a8'); // sticky note
  };

  F.desk2 = (x, y, w, h, f) => { // dual monitor battle-station
    sh(x + 1, y + h, w - 2);
    box(x, y + 3, w, h - 2, '#33333f');
    px(x + 1, y + 4, w - 2, h - 4, '#41414f');
    px(x + 1, y + 4, w - 2, 1, '#535364');
    px(x + 1, y + 4, 5, 1, '#636376'); // sheen
    seamH(x + 1, y + h - 3, w - 2, '#41414f');
    rivets(x + 1, y + 4, w - 2, h - 5, '#5c5c70', '#22222c');
    glow(x + 1, y + h - 2, w - 2, 1, '#b44aff', f.work ? 0.22 + 0.08 * Math.sin(now / 300) : 0.08); // underglow strip
    px(x + 5, y + 4, 2, 1, '#181826'); px(x + 16, y + 4, 2, 1, '#181826');
    box(x + 1, y - 3, 9, 7, '#181826'); box(x + 12, y - 3, 9, 7, '#181826');
    px(x + 2, y - 3, 7, 1, '#2a2a3c'); px(x + 13, y - 3, 7, 1, '#2a2a3c'); // bezel catch
    inset(x + 2, y - 2, 7, 5, '#0c0c16'); inset(x + 13, y - 2, 7, 5, '#0c0c16');
    if (f.work) {
      px(x + 3, y - 1, 5, 3, scr(f.x)); px(x + 14, y - 1, 5, 3, scr(f.x + 2));
      px(x + 3, y - 1, 2, 1, '#dfffe8'); px(x + 14, y, 3, 1, U.shade(scr(f.x + 2), -0.3)); // code rows
      if (blink(180, f.x)) px(x + 3, y - 1, 3, 1, '#dfffe8');
      px(x + 18, y + 1, 1, 1, blink(350, f.x) ? '#dfffe8' : '#0c0c16'); // cursor
      scanl(x + 3, y - 1, 5, 3, 0.2); scanl(x + 14, y - 1, 5, 3, 0.2);
      glow(x + 2, y + 4, 19, 2, scr(f.x), 0.15);
    } else {
      px(x + 3, y - 1, 5, 3, '#0e0e1a'); px(x + 14, y - 1, 5, 3, '#0e0e1a');
      px(x + 3, y - 1, 1, 1, '#1a1a2a'); px(x + 14, y - 1, 1, 1, '#1a1a2a');
      px(x + 20, y + 1, 1, 1, blink(1600, x) ? '#ff9d2e' : '#33241a'); // standby
    }
    px(x + 10, y + 4, 1, 2, '#22222c'); // cable channel between monitors
    inset(x + 8, y + 7, 7, 3, '#262630'); px(x + 9, y + 8, 5, 1, '#3a3a48');
    px(x + 9, y + 8, 2, 1, '#4a4a5c'); // key glint
    px(x + 3, y + 7, 4, 2, '#2a2a36'); px(x + 3, y + 7, 4, 1, '#3a3a4a'); // headset on desk
    px(x + 17, y + 8, 2, 1, '#3a3a48'); // mouse
  };

  F.tv = (x, y, w, h) => { // wall TV — always on, three channels cycling every 4s
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
    glow(x + 2, y + h + 5, w - 4, 2, mode === 1 ? '#2a5a7a' : '#3a1a2a', 0.15); // screen light under tv
    px(x + 1, y + h + 5, w - 2, 1, '#000');
    px(x + 8, y + h + 5, w - 16, 1, '#1c1c1c'); // soundbar
    px(x + 10, y + h + 5, 1, 1, '#2e2e2e'); px(x + w - 11, y + h + 5, 1, 1, '#2e2e2e');
    px(x + w - 3, y + h + 4, 1, 1, blink(1400) ? '#ff3030' : '#3a1010'); // standby LED
  };

  /* ============ CATALOG — every placeable prop ============
     id        — F key (the draw fn) AND the model's prop.t
     label     — palette button text
     cat       — palette group
     w,h       — default footprint in tiles
     animated  — has a per-frame emissive accent (informational)
     blocks    — occupies its footprint tiles for pathfinding (agents route around) */
  const CATALOG = [
    { id: 'desk',  label: 'DESK',     cat: 'work',   w: 2, h: 1, animated: true, blocks: true },
    { id: 'desk2', label: 'DESK ×2',  cat: 'work',   w: 2, h: 1, animated: true, blocks: true },
    { id: 'tv',    label: 'TV',       cat: 'lounge', w: 3, h: 1, animated: true, blocks: true },
  ];
  const BY_ID = {};
  for (const c of CATALOG) BY_ID[c.id] = c;
  const CATS = CATALOG.reduce((o, c) => { (o[c.cat] = o[c.cat] || []).push(c); return o; }, {});

  const spec = id => BY_ID[id] || null;
  const has = id => !!F[id];

  /* draw one prop. f = {t, x, y, w, h} in LOCAL tile coords; `work` lights its screens. */
  function draw(f, work) {
    const fn = F[f.t]; if (!fn) return;
    const X = f.x * TILE, Y = f.y * TILE, W = (f.w || 1) * TILE, H = (f.h || 1) * TILE;
    fn(X, Y, W, H, { x: f.x, work: !!work });
  }

  return {
    setCtx(c) { ctx = c; },
    setNow(t) { now = t; },
    draw, CATALOG, CATS, spec, has, TILE,
    // exposed for tests / reuse
    _F: F,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PropSprites;
