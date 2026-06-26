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
  const NFACE = 9, NCAP = 4, FACEW = 4, WALLH = 12;
  const wallTop = '#4a463a', wallFace = '#2b2820', wallDk = '#1d1a14', hullC = '#191712';

  const CORNER = {
    tl: { cx: 1, cy: 1, a0: Math.PI, a1: 1.5 * Math.PI },
    tr: { cx: 0, cy: 1, a0: 1.5 * Math.PI, a1: 2 * Math.PI },
    bl: { cx: 1, cy: 0, a0: 0.5 * Math.PI, a1: Math.PI },
    br: { cx: 0, cy: 0, a0: 0, a1: 0.5 * Math.PI }
  };

  /* per-bake state (a bake runs synchronously start→finish, so module locals are safe) */
  const CHUNK_PX = 384;
  const DIRTY_PAD_PX = pad + WALLH + 48;
  let G, T, HR, W, H, VX, VY, CW, CH, lampPos, edges, chamferAt;
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
        edges.push({ x, y, side, room, door, exterior: nz == null });
      }
    }
  }

  /* ---------- floor passes (per-tile base colour → paint tool just works) ---------- */
  function bakeRoomFloor(b, r) {
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    const off = U.hash(r.z) % 2;
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      const base = G.baseColorOf(r.z, x, y);
      const X = x * T, Y = y * T, n = h2(x, y, r.z);
      px(X, Y, T, T, base);
      if (n % 5 === 0) px(X, Y, T, T, 'rgba(0,0,0,0.06)');
      else if (n % 7 === 0) px(X, Y, T, T, 'rgba(255,255,255,0.025)');
      if ((x + off) % 2 === 0) px(X, Y, 1, T, U.shade(base, -0.30));
      if ((y + off) % 2 === 0) px(X, Y, T, 1, U.shade(base, -0.30));
      if ((x + off) % 2 === 0 && (y + off) % 2 === 0) px(X + 1, Y + 1, 1, 1, U.shade(base, 0.22));
      if (n % 19 === 3) {
        px(X + 2, Y + 2, T - 4, T - 4, U.shade(base, -0.25));
        for (let i = 0; i < 3; i++) px(X + 3, Y + 4 + i * 3, T - 6, 1, U.shade(base, -0.5));
      } else if (n % 23 === 5) {
        px(X + 2, Y + 2, T - 4, T - 4, U.shade(base, -0.12));
        b.strokeStyle = U.shade(base, -0.4); b.lineWidth = 1; b.strokeRect(X + 2.5, Y + 2.5, T - 5, T - 5);
        px(X + T / 2 - 2, Y + T / 2, 4, 1, U.shade(base, -0.5));
      } else if (n % 31 === 7) {
        b.fillStyle = 'rgba(0,0,0,0.13)'; b.beginPath(); b.ellipse(X + (n % 8), Y + (n % 6) + 3, 5, 3, 0, 0, 7); b.fill();
      } else if (n % 13 === 2) {
        px(X + (n % 5), Y + (n % 7) + 2, 4, 1, 'rgba(0,0,0,0.12)');
        px(X + (n % 7) + 1, Y + (n % 4) + 6, 3, 1, 'rgba(255,255,255,0.05)');
      }
    }
    b.fillStyle = 'rgba(226,214,184,0.28)';
    for (let x = r.x1 * T + 3; x < (r.x2 + 1) * T - 3; x += 10) b.fillRect(x, r.y1 * T + NFACE + 2, 6, 1);
  }

  function bakeCorridorFloor(b, r) {
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    const vertical = (r.y2 - r.y1) > (r.x2 - r.x1);
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      const base = G.baseColorOf(r.z, x, y);
      const X = x * T, Y = y * T, n = h2(x, y, 'cor');
      px(X, Y, T, T, base);
      if (n % 6 === 0) px(X, Y, T, T, 'rgba(0,0,0,0.07)');
      px(X, Y, T, 1, U.shade(base, -0.34));
      if (n % 23 === 5) { px(X + 2, Y + 2, T - 4, T - 4, U.shade(base, -0.16)); b.strokeStyle = U.shade(base, -0.4); b.lineWidth = 1; b.strokeRect(X + 2.5, Y + 2.5, T - 5, T - 5); }
    }
    // long-axis rib bands + edge air-grilles
    b.fillStyle = 'rgba(0,0,0,0.12)';
    const x1 = r.x1 * T, y1 = r.y1 * T, rw = (r.x2 - r.x1 + 1) * T, rh = (r.y2 - r.y1 + 1) * T;
    if (vertical) for (let yy = y1 + 4; yy < y1 + rh; yy += 7) b.fillRect(x1 + 2, yy, rw - 4, 1);
    else for (let xx = x1 + 4; xx < x1 + rw; xx += 7) b.fillRect(xx, y1 + 2, 1, rh - 4);
    b.fillStyle = U.shade('#2c2924', -0.5);
    if (vertical) { for (let yy = y1 + 3; yy < y1 + rh; yy += 5) { b.fillRect(x1 + 1, yy, 1, 2); b.fillRect(x1 + rw - 2, yy, 1, 2); } }
    else { for (let xx = x1 + 3; xx < x1 + rw; xx += 5) { b.fillRect(xx, y1 + 1, 2, 1); b.fillRect(xx, y1 + rh - 2, 2, 1); } }
  }

  function bakeEdgeAO(b) {
    b.fillStyle = 'rgba(0,0,0,0.25)';
    for (const e of edges) {
      if (e.door) continue;
      const X = e.x * T, Y = e.y * T, d = e.room ? 8 : 4, ds = e.room ? 5 : 3;
      if (e.side === 'n') b.fillRect(X, Y, T, d);
      else if (e.side === 's') b.fillRect(X, Y + T - ds, T, ds);
      else if (e.side === 'w') b.fillRect(X, Y, ds, T);
      else b.fillRect(X + T - ds, Y, ds, T);
    }
  }

  function bakeWalls(b) {
    for (const e of edges) {
      const X = e.x * T, Y = e.y * T;
      if (e.door) { bakeThreshold(b, e, X, Y); continue; }
      const fw = e.room ? FACEW : 2, out = e.room ? 4 : 2, face = e.room ? NFACE : 5, cap = e.room ? NCAP : 2;
      const dep = fw + 1, rib = 'rgba(0,0,0,0.25)';
      // the dark hull band (cap above / out below/beside) paints OUTSIDE the tile — only when the
      // neighbour is void. Interior boundaries (a non-door seam to another zone) draw the face only,
      // so the wall never smears onto an adjacent room/corridor floor (v7 render.js parity).
      if (e.side === 'n') {
        if (e.exterior) { b.fillStyle = wallDk; b.fillRect(X, Y - cap, T, cap); }
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
        if (e.exterior) { b.fillStyle = wallDk; b.fillRect(X - out, Y, out, T); }
      } else {
        b.fillStyle = wallTop; b.fillRect(X + T - dep, Y, 1, T);
        b.fillStyle = wallFace; b.fillRect(X + T - fw, Y, fw, T);
        b.fillStyle = rib; b.fillRect(X + T - fw, Y + 5, fw, 1);
        if (e.exterior) { b.fillStyle = wallDk; b.fillRect(X + T, Y, out, T); }
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
        gw.addColorStop(0, 'rgba(248,238,214,0.16)'); gw.addColorStop(0.6, 'rgba(248,238,214,0.05)'); gw.addColorStop(1, 'rgba(248,238,214,0)');
        b.fillStyle = gw; b.fillRect(Math.max(X, lx - rad * 0.7), Y, Math.min(rad * 1.4, RW), Math.min(rad * 1.2, RH));
        lampPos.push({ x: lx, y: ly, r: rad * 1.4 });
      }
    }
    b.globalCompositeOperation = 'source-over';
    for (const r of G.allRects) {
      if (G.isCorridor(r.z)) continue;
      const X = r.x1 * T, RW = (r.x2 - r.x1 + 1) * T;
      const count = Math.max(1, Math.round((r.x2 - r.x1 + 1) / 7));
      for (let i = 0; i < count; i++) {
        const lx = X + RW * (i + 0.5) / count;
        b.fillStyle = '#6a6253'; b.fillRect(Math.round(lx) - 4, r.y1 * T + 1, 8, 2);
        b.fillStyle = 'rgba(255,255,255,0.55)'; b.fillRect(Math.round(lx) - 3, r.y1 * T + 1, 6, 1);
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
    const sil = canvas(CW, CH);
    const g = translatedContext(sil);
    g.fillStyle = '#fff';
    for (const r of G.allRects) g.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    for (const [ccx, ccy, kind] of G.chamfers) { const A = CORNER[kind]; eraseSpandrel(g, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, HR); }
    const f = canvas(CW, CH);
    const fg = f.getContext('2d');
    const tmp = canvas(CW, CH);
    const tg = tmp.getContext('2d');
    const stamp = (dy, c) => {
      tg.clearRect(0, 0, CW, CH); tg.drawImage(sil, 0, dy);
      tg.globalCompositeOperation = 'source-in'; tg.fillStyle = c; tg.fillRect(0, 0, CW, CH);
      tg.globalCompositeOperation = 'source-over'; fg.drawImage(tmp, 0, 0);
    };
    stamp(WALLH, '#0b0a07'); stamp(WALLH - 2, '#14120d'); stamp(3, '#1f1c15'); stamp(1, '#3f3a2c');
    fg.globalCompositeOperation = 'destination-out'; fg.drawImage(sil, 0, 0);
    fg.globalCompositeOperation = 'source-atop';
    fg.fillStyle = 'rgba(0,0,0,0.35)';
    for (let x = 5 - (VX % 28); x < CW; x += 28) fg.fillRect(x, 0, 1, CH);
    fg.globalCompositeOperation = 'source-over';
    b.globalCompositeOperation = 'destination-over';
    b.drawImage(f, VX, VY);
    b.globalCompositeOperation = 'source-over';
  }

  function buildLightMap() {
    const lightCv = canvas(CW, CH);
    const L = translatedContext(lightCv);
    L.fillStyle = 'rgba(10,8,4,0.62)';
    for (const r of G.allRects) L.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    for (const [ccx, ccy, kind] of G.chamfers) { const A = CORNER[kind]; eraseSpandrel(L, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, T + pad); }
    L.globalCompositeOperation = 'destination-out';
    const cut = (x, y, r, a) => {
      const g = L.createRadialGradient(x, y, 1, x, y, r);
      g.addColorStop(0, 'rgba(0,0,0,' + a + ')'); g.addColorStop(0.55, 'rgba(0,0,0,' + a * 0.45 + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
      L.fillStyle = g; L.fillRect(x - r, y - r, r * 2, r * 2);
    };
    for (const r of G.allRects) {
      const X = r.x1 * T, Y = r.y1 * T, RW = (r.x2 - r.x1 + 1) * T, RH = (r.y2 - r.y1 + 1) * T;
      if (G.isCorridor(r.z)) { cut(X + RW / 2, Y + RH / 2, Math.max(RW, RH) * 0.5, 0.42); continue; }
      const n = Math.max(1, Math.round(RW / (RH * 1.4)));
      for (let i = 0; i < n; i++) cut(X + RW * (i + 0.5) / n, Y + RH * 0.42, Math.max(RH * 0.78, RW / n * 0.62), 0.5);
    }
    for (const l of lampPos) cut(l.x, l.y, l.r, 0.8);
    // doorway light spill so corridors and rooms read as connected
    for (const [x1, y1, x2, y2] of G.doorDefs) cut((x1 + x2 + 1) / 2 * T, (y1 + y2 + 1) / 2 * T, T * 1.6, 0.5);
    L.globalCompositeOperation = 'source-over';
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
      b.save(); spandrelPath(b, kind, ax, ay, T); b.clip('evenodd');
      b.fillStyle = hullC; b.fillRect(X - 1, Y - 1, T + 2, T + 2); b.restore();
      b.lineWidth = 4.5; b.strokeStyle = wallDk; b.beginPath(); b.arc(ax, ay, T + 2.25, A.a0, A.a1); b.stroke();
      b.lineWidth = 5; b.strokeStyle = wallFace; b.beginPath(); b.arc(ax, ay, T - 2.5, A.a0, A.a1); b.stroke();
      b.lineWidth = 1; b.strokeStyle = 'rgba(0,0,0,0.25)';
      for (let k = 1; k <= 2; k++) {
        const ang = A.a0 + (A.a1 - A.a0) * k / 3;
        b.beginPath();
        b.moveTo(ax + Math.cos(ang) * (T - 5), ay + Math.sin(ang) * (T - 5));
        b.lineTo(ax + Math.cos(ang) * T, ay + Math.sin(ang) * T); b.stroke();
      }
      b.lineWidth = 2; b.strokeStyle = '#28241b'; b.beginPath(); b.arc(ax, ay, HR - 2, A.a0, A.a1); b.stroke();
      b.lineWidth = 1; b.strokeStyle = wallTop; b.beginPath(); b.arc(ax, ay, T - 5.5, A.a0, A.a1); b.stroke();
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
    VX = viewport ? viewport.x : 0; VY = viewport ? viewport.y : 0;
    CW = viewport ? viewport.w : W; CH = viewport ? viewport.h : H;
    lampPos = []; chamferAt = {};
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
      x1: Math.max(0, (r.x1 - geo.origin.tx) * t - DIRTY_PAD_PX),
      y1: Math.max(0, (r.y1 - geo.origin.ty) * t - DIRTY_PAD_PX),
      x2: Math.min(geo.W, (r.x2 + 1 - geo.origin.tx) * t + DIRTY_PAD_PX),
      y2: Math.min(geo.H, (r.y2 + 1 - geo.origin.ty) * t + DIRTY_PAD_PX)
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

  return { bake, bakeIncremental, dirtyChunks, visibleChunks, missingVisibleChunks, drawBase, drawLight, CHUNK_PX };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StationBake;
