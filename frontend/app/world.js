/* SKYNET — world.js : a single chamfered STARTER ROOM rendered with v7's actual
   procedural station art (floor / tilted walls / rounded-corner arcs / lit pools /
   hull extrusion / lightmap) + v7's real desk & chair furniture, ported from v7.
   BEHAVIOR: when given a TASK the agent walks to the computer, sits, and works
   (lit screen + typing) until the task finishes, then stands up. Casual talk =
   the agent pauses and faces the Commander. Everything the agent does is visible. */
'use strict';

const World = (() => {
  /* ---------- v7 geometry + palette (verbatim) ---------- */
  const T = 12, pad = 7, HR = T + pad;
  const NFACE = 9, NCAP = 4, FACEW = 4, WALLH = 12;
  const wallTop = '#4a463a', wallFace = '#2b2820', wallDk = '#1d1a14', hullC = '#191712', FLOOR = '#33302a';

  const RW_TILES = 18, RH_TILES = 11;
  const room = { x1: 1, y1: 1, x2: RW_TILES, y2: RH_TILES, z: 'hab' };
  const COLS = room.x2 + 2, ROWS = room.y2 + 2;
  const W = COLS * T, H = ROWS * T + WALLH;

  const chamfers = [
    [room.x1, room.y1, 'tl'], [room.x2, room.y1, 'tr'],
    [room.x1, room.y2, 'bl'], [room.x2, room.y2, 'br']
  ];
  const chamferAt = {}; for (const [cx, cy, k] of chamfers) chamferAt[cx + ',' + cy] = k;

  const inRoom = (x, y) => x >= room.x1 && x <= room.x2 && y >= room.y1 && y <= room.y2;
  const zone = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS) ? 0 : (inRoom(x, y) ? 1 : 0);
  const h2 = (x, y, s) => U.hash(x + ',' + y + ',' + (s || ''));

  // the computer workstation against the north wall + the chair in front of it
  const desk = { tx: 9, ty: room.y1 + 1, w: 2, h: 1 };
  const seat = { tx: 9, ty: room.y1 + 2 };

  const CORNER = {
    tl: { cx: 1, cy: 1, a0: Math.PI, a1: 1.5 * Math.PI },
    tr: { cx: 0, cy: 1, a0: 1.5 * Math.PI, a1: 2 * Math.PI },
    bl: { cx: 1, cy: 0, a0: 0.5 * Math.PI, a1: Math.PI },
    br: { cx: 0, cy: 0, a0: 0, a1: 0.5 * Math.PI }
  };
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

  const edges = [];
  (function () {
    const dirs = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (!zone(x, y)) continue;
      if (chamferAt[x + ',' + y]) continue;
      for (const side in dirs) {
        const [dx, dy] = dirs[side];
        if (zone(x + dx, y + dy) === 1) continue;
        edges.push({ x, y, side, exterior: true });
      }
    }
  })();

  const lampPos = [], flickers = [];
  let baseCv = null, lightCv = null;

  /* ================= BAKE (ported from v7 render.js) ================= */
  function bakeRoomFloor(b, r) {
    const base = FLOOR;
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    px(r.x1 * T, r.y1 * T, (r.x2 - r.x1 + 1) * T, (r.y2 - r.y1 + 1) * T, base);
    const off = U.hash(r.z) % 2;
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      const X = x * T, Y = y * T, n = h2(x, y, r.z);
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

  function bakeEdgeAO(b) {
    b.fillStyle = 'rgba(0,0,0,0.25)';
    for (const e of edges) {
      const X = e.x * T, Y = e.y * T, d = 5;
      if (e.side === 'n') b.fillRect(X, Y, T, 8);
      else if (e.side === 's') b.fillRect(X, Y + T - d, T, d);
      else if (e.side === 'w') b.fillRect(X, Y, d, T);
      else b.fillRect(X + T - d, Y, d, T);
    }
  }

  function bakeWalls(b) {
    const fw = FACEW, out = 4, face = NFACE, cap = NCAP, dep = fw + 1, rib = 'rgba(0,0,0,0.25)';
    for (const e of edges) {
      const X = e.x * T, Y = e.y * T;
      if (e.side === 'n') {
        b.fillStyle = wallDk; b.fillRect(X, Y - cap, T, cap);
        b.fillStyle = wallFace; b.fillRect(X, Y, T, face);
        b.fillStyle = rib; b.fillRect(X + 5, Y, 1, face);
        b.fillStyle = wallTop; b.fillRect(X, Y + face, T, 1);
        b.fillStyle = 'rgba(255,255,255,0.05)'; b.fillRect(X, Y, T, 1);
      } else if (e.side === 's') {
        b.fillStyle = wallTop; b.fillRect(X, Y + T - dep, T, 1);
        b.fillStyle = wallFace; b.fillRect(X, Y + T - fw, T, fw);
        b.fillStyle = rib; b.fillRect(X + 5, Y + T - fw, 1, fw);
        b.fillStyle = wallDk; b.fillRect(X, Y + T, T, out);
      } else if (e.side === 'w') {
        b.fillStyle = wallTop; b.fillRect(X + fw, Y, 1, T);
        b.fillStyle = wallFace; b.fillRect(X, Y, fw, T);
        b.fillStyle = rib; b.fillRect(X, Y + 5, fw, 1);
        b.fillStyle = wallDk; b.fillRect(X - out, Y, out, T);
      } else {
        b.fillStyle = wallTop; b.fillRect(X + T - dep, Y, 1, T);
        b.fillStyle = wallFace; b.fillRect(X + T - fw, Y, fw, T);
        b.fillStyle = rib; b.fillRect(X + T - fw, Y + 5, fw, 1);
        b.fillStyle = wallDk; b.fillRect(X + T, Y, out, T);
      }
    }
  }

  function bakeRoomLighting(b) {
    b.globalCompositeOperation = 'lighter';
    const X = room.x1 * T, Y = room.y1 * T, RW = (room.x2 - room.x1 + 1) * T, RH = (room.y2 - room.y1 + 1) * T;
    const count = Math.max(1, Math.round((room.x2 - room.x1 + 1) / 7));
    const rad = Math.min(60, Math.max(30, RH * 0.85));
    for (let i = 0; i < count; i++) {
      const lx = X + RW * (i + 0.5) / count, ly = Y + T * 1.6;
      const gw = b.createRadialGradient(lx, ly, 1, lx, ly, rad * 0.7);
      gw.addColorStop(0, 'rgba(248,238,214,0.16)'); gw.addColorStop(0.6, 'rgba(248,238,214,0.05)'); gw.addColorStop(1, 'rgba(248,238,214,0)');
      b.fillStyle = gw; b.fillRect(Math.max(X, lx - rad * 0.7), Y, Math.min(rad * 1.4, RW), Math.min(rad * 1.2, RH));
      lampPos.push({ x: lx, y: ly, r: rad * 1.4 });
    }
    b.globalCompositeOperation = 'source-over';
    for (let i = 0; i < count; i++) {
      const lx = X + RW * (i + 0.5) / count;
      b.fillStyle = '#6a6253'; b.fillRect(Math.round(lx) - 4, Y + 1, 8, 2);
      b.fillStyle = 'rgba(255,255,255,0.55)'; b.fillRect(Math.round(lx) - 3, Y + 1, 6, 1);
    }
  }

  function bakeHullExtrusion(b) {
    const sil = document.createElement('canvas'); sil.width = W; sil.height = H;
    const g = sil.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(room.x1 * T - pad, room.y1 * T - pad, (room.x2 - room.x1 + 1) * T + pad * 2, (room.y2 - room.y1 + 1) * T + pad * 2);
    for (const [ccx, ccy, kind] of chamfers) { const A = CORNER[kind]; eraseSpandrel(g, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, HR); }
    const f = document.createElement('canvas'); f.width = W; f.height = H;
    const fg = f.getContext('2d');
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    const tg = tmp.getContext('2d');
    const stamp = (dy, c) => {
      tg.clearRect(0, 0, W, H); tg.drawImage(sil, 0, dy);
      tg.globalCompositeOperation = 'source-in'; tg.fillStyle = c; tg.fillRect(0, 0, W, H);
      tg.globalCompositeOperation = 'source-over'; fg.drawImage(tmp, 0, 0);
    };
    stamp(WALLH, '#0b0a07'); stamp(WALLH - 2, '#14120d'); stamp(3, '#1f1c15'); stamp(1, '#3f3a2c');
    fg.globalCompositeOperation = 'destination-out'; fg.drawImage(sil, 0, 0);
    fg.globalCompositeOperation = 'source-atop';
    fg.fillStyle = 'rgba(0,0,0,0.35)';
    for (let x = 5; x < W; x += 28) fg.fillRect(x, 0, 1, H);
    fg.globalCompositeOperation = 'source-over';
    b.globalCompositeOperation = 'destination-over';
    b.drawImage(f, 0, 0);
    b.globalCompositeOperation = 'source-over';
  }

  function buildLightMap() {
    lightCv = document.createElement('canvas'); lightCv.width = W; lightCv.height = H;
    const L = lightCv.getContext('2d');
    L.fillStyle = 'rgba(10,8,4,0.62)';
    L.fillRect(room.x1 * T - pad, room.y1 * T - pad, (room.x2 - room.x1 + 1) * T + pad * 2, (room.y2 - room.y1 + 1) * T + pad * 2);
    for (const [ccx, ccy, kind] of chamfers) { const A = CORNER[kind]; eraseSpandrel(L, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, T + pad); }
    L.globalCompositeOperation = 'destination-out';
    const cut = (x, y, r, a) => {
      const g = L.createRadialGradient(x, y, 1, x, y, r);
      g.addColorStop(0, 'rgba(0,0,0,' + a + ')'); g.addColorStop(0.55, 'rgba(0,0,0,' + a * 0.45 + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
      L.fillStyle = g; L.fillRect(x - r, y - r, r * 2, r * 2);
    };
    const X = room.x1 * T, Y = room.y1 * T, RW = (room.x2 - room.x1 + 1) * T, RH = (room.y2 - room.y1 + 1) * T;
    const n = Math.max(1, Math.round(RW / (RH * 1.4)));
    for (let i = 0; i < n; i++) cut(X + RW * (i + 0.5) / n, Y + RH * 0.42, Math.max(RH * 0.78, RW / n * 0.62), 0.5);
    for (const l of lampPos) cut(l.x, l.y, l.r, 0.8);
    L.globalCompositeOperation = 'source-over';
    const v = L.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.72);
    v.addColorStop(0, 'rgba(3,2,1,0)'); v.addColorStop(1, 'rgba(3,2,1,0.46)');
    L.fillStyle = v; L.fillRect(0, 0, W, H);
    flickers.length = 0;
    for (let i = 0; i < lampPos.length; i += 2) flickers.push(lampPos[i]);
  }

  function buildBase() {
    baseCv = document.createElement('canvas'); baseCv.width = W; baseCv.height = H;
    const b = baseCv.getContext('2d'); b.imageSmoothingEnabled = false;
    b.fillStyle = hullC;
    b.fillRect(room.x1 * T - pad, room.y1 * T - pad, (room.x2 - room.x1 + 1) * T + pad * 2, (room.y2 - room.y1 + 1) * T + pad * 2);
    b.globalCompositeOperation = 'source-atop';
    b.strokeStyle = '#231f17'; b.lineWidth = 1;
    for (let x = 5; x < W; x += 28) { b.beginPath(); b.moveTo(x + .5, 0); b.lineTo(x + .5, H); b.stroke(); }
    for (let y = 9; y < H; y += 26) { b.beginPath(); b.moveTo(0, y + .5); b.lineTo(W, y + .5); b.stroke(); }
    b.globalCompositeOperation = 'source-over';
    {
      const x1 = room.x1 * T - pad, y1 = room.y1 * T - pad, x2 = (room.x2 + 1) * T + pad, y2 = (room.y2 + 1) * T + pad;
      b.strokeStyle = '#28241b'; b.lineWidth = 2; b.strokeRect(x1 + 1, y1 + 1, x2 - x1 - 2, y2 - y1 - 2);
      b.fillStyle = '#302b21';
      for (let x = x1 + 6; x < x2; x += 18) { b.fillRect(x, y1 + 2, 2, 2); b.fillRect(x, y2 - 4, 2, 2); }
      for (let y = y1 + 6; y < y2; y += 18) { b.fillRect(x1 + 2, y, 2, 2); b.fillRect(x2 - 4, y, 2, 2); }
    }
    for (const [ccx, ccy, kind] of chamfers) {
      const A = CORNER[kind], ax = (ccx + A.cx) * T, ay = (ccy + A.cy) * T;
      eraseSpandrel(b, kind, ax, ay, HR);
      b.strokeStyle = '#28241b'; b.lineWidth = 2; b.beginPath(); b.arc(ax, ay, HR - 2, A.a0, A.a1); b.stroke();
    }
    bakeRoomFloor(b, room);
    bakeEdgeAO(b);
    bakeWalls(b);
    bakeRoomLighting(b);
    for (const [ccx, ccy, kind] of chamfers) {
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
    b.font = '7px monospace'; b.fillStyle = 'rgba(255,255,255,0.07)';
    b.fillText('HAB-01', (room.x2 - 2) * T - 4, (room.y2 + 1) * T - 4);
    bakeHullExtrusion(b);
    buildLightMap();
  }

  /* ================= furniture (ported v7 sprites.js F.desk / F.chair) ================= */
  let ctx, fnow = 0;
  const fpx = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  const fblink = (p, ph) => ((fnow / p + (ph || 0)) % 1) < 0.5;
  const fscrCols = ['#62ff9e', '#3fd07c', '#7adfb0', '#2fa863'];
  const fscr = (ph) => fscrCols[Math.floor((fnow / 700 + ph) % fscrCols.length)];
  const fsh = (x, y, w) => { ctx.globalAlpha = 0.22; fpx(x, y, w, 2, '#000'); ctx.globalAlpha = 1; };
  const fglow = (x, y, w, h, c, a) => { ctx.globalAlpha = a; fpx(x, y, w, h, c); ctx.globalAlpha = 1; };
  const fbox = (x, y, w, h, c) => {
    fpx(x - 1, y - 1, w + 2, h + 2, '#06090c'); fpx(x, y, w, h, c);
    fpx(x, y, w, 1, U.shade(c, 0.28)); fpx(x, y + h - 1, w, 1, U.shade(c, -0.4));
    fpx(x + w - 1, y + 1, 1, h - 2, U.shade(c, -0.22)); fpx(x, y + 1, 1, h - 2, U.shade(c, 0.08));
  };
  const finset = (x, y, w, h, c) => { fpx(x, y, w, h, U.shade(c, -0.6)); fpx(x + 1, y + 1, w - 2, h - 2, c); fpx(x + 1, y + 1, w - 2, 1, U.shade(c, -0.3)); };
  const fseamH = (x, y, w, c) => { fpx(x, y, w, 1, U.shade(c, -0.45)); fpx(x, y + 1, w, 1, U.shade(c, 0.14)); };
  const frivets = (x, y, w, h, lc, dc) => { fpx(x, y, 1, 1, lc); fpx(x + w - 1, y, 1, 1, lc); fpx(x, y + h - 1, 1, 1, dc); fpx(x + w - 1, y + h - 1, 1, 1, dc); };
  const fwear = (x, y, w, h, n, c) => { if (w < 4 || h < 4) return; for (let i = 0; i < n; i++) { const hx = U.hash('w' + x + ',' + y + ',' + i); fpx(x + 1 + (hx % (w - 2)), y + 1 + ((hx >> 5) % (h - 2)), 1 + (hx % 2), 1, c); } };
  const fscanl = (x, y, w, h, a) => { ctx.globalAlpha = a; for (let j = 1; j < h; j += 2) fpx(x, y + j, w, 1, '#000'); ctx.globalAlpha = 1; };

  function F_desk(x, y, w, h, f) {
    fsh(x + 1, y + h, w - 2);
    fbox(x, y + 3, w, h - 2, '#343e46');
    fpx(x + 1, y + 4, w - 2, h - 4, '#414d56');
    fpx(x + 1, y + 4, w - 2, 1, '#54626c');
    fpx(x + 1, y + 4, 6, 1, '#64727c');
    fseamH(x + 1, y + h - 3, w - 2, '#414d56');
    fpx(x + w - 8, y + h - 2, 3, 1, '#2a343c');
    frivets(x + 1, y + 4, w - 2, h - 5, '#5e6c76', '#222b32');
    fwear(x + 1, y + 4, w - 2, h - 5, 3, '#37424a');
    fpx(x + 5, y + 4, 2, 1, '#1a241e'); fpx(x + 4, y + 5, 4, 1, '#222c26');
    fbox(x + 2, y - 3, 8, 7, '#1a241e'); fpx(x + 3, y - 3, 6, 1, '#2c3a30');
    finset(x + 3, y - 2, 6, 5, '#0d150f');
    if (f.work) {
      fpx(x + 4, y - 1, 4, 3, fscr(f.x)); fpx(x + 4, y - 1, 2, 1, '#dfffe8');
      fpx(x + 4, y + 1, 3, 1, U.shade(fscr(f.x), -0.3));
      if (fblink(180, f.x)) fpx(x + 4, y - 1, 3, 1, '#dfffe8');
      fpx(x + 7, y + 1, 1, 1, fblink(400, f.x) ? '#dfffe8' : '#101a14');
      fscanl(x + 4, y - 1, 4, 3, 0.2);
      fglow(x + 2, y + 4, 8, 2, fscr(f.x), 0.18); fglow(x + 3, y - 2, 6, 5, fscr(f.x), 0.10);
    } else {
      fpx(x + 4, y - 1, 4, 3, '#101a14'); fpx(x + 4, y - 1, 1, 1, '#1c2a22');
      fpx(x + 9, y + 2, 1, 1, fblink(1600) ? '#ff9d2e' : '#33241a');
    }
    fpx(x + 9, y + 4, 1, 2, '#222b32');
    finset(x + 13, y + 6, 6, 3, '#262e2a'); fpx(x + 14, y + 7, 4, 1, '#39443e'); fpx(x + 14, y + 7, 2, 1, '#46544a');
    fpx(x + 20, y + 7, 1, 1, '#39443e'); fpx(x + 20, y + 7, 1, 1, '#46544a');
    fpx(x + 2, y + 8, 2, 2, '#3a6a62'); fpx(x + 2, y + 8, 2, 1, '#5aa89c');
    if (f.work && fblink(700)) fpx(x + 3, y + 6, 1, 1, '#8a8a8a');
    fpx(x + 11, y + 5, 2, 2, '#ffe066'); fpx(x + 11, y + 5, 2, 1, '#fff0a8');
  }

  function F_chair(x, y) {
    ctx.globalAlpha = 0.2; fpx(x + 3, y + 9, 6, 2, '#000'); ctx.globalAlpha = 1;
    fpx(x + 3, y + 1, 6, 2, '#3a4a40'); fpx(x + 3, y + 1, 6, 1, '#46584c');
    fpx(x + 3, y + 1, 1, 2, '#41544a'); fpx(x + 8, y + 1, 1, 2, '#2e3c34');
    fpx(x + 4, y + 2, 4, 1, '#33413a');
    fpx(x + 3, y + 3, 6, 6, '#2e3a34');
    fpx(x + 4, y + 4, 4, 2, '#39463f'); fpx(x + 4, y + 4, 4, 1, '#41504a');
    fpx(x + 4, y + 6, 1, 1, '#27322c'); fpx(x + 7, y + 6, 1, 1, '#27322c');
    fpx(x + 3, y + 8, 6, 1, '#242e29');
    fpx(x + 5, y + 9, 2, 1, '#39434b'); fpx(x + 5, y + 9, 1, 1, '#46535c');
    fpx(x + 4, y + 10, 1, 1, '#222'); fpx(x + 7, y + 10, 1, 1, '#222');
    fpx(x + 5, y + 10, 2, 1, '#2a2a2a'); fpx(x + 4, y + 11, 1, 1, '#1a1a1a'); fpx(x + 7, y + 11, 1, 1, '#1a1a1a');
  }

  /* ---------- agent + camera ---------- */
  let cv, raf = 0, last = 0, agent = null, activity = 'idle', running = false, ro = null, wakeAt = 0;
  const stars = [];
  const footOf = (tx, ty) => ({ x: tx * T + T / 2, y: ty * T + T - 1 });

  function init(canvas) {
    cv = canvas; ctx = cv.getContext('2d');
    if (!baseCv) buildBase();
    if (!stars.length) for (let i = 0; i < 90; i++) stars.push({ x: Math.random(), y: Math.random(), r: Math.random() < 0.85 ? 1 : 2, ph: Math.random() * 10 });
    resize();
    try { if (ro) ro.disconnect(); ro = new ResizeObserver(() => resize()); ro.observe(cv.parentElement || cv); } catch (e) {}
    window.addEventListener('resize', resize);
  }

  function spawn(a) {
    const f = footOf(room.x1 + 9, room.y1 + 6);
    agent = {
      id: a.id, name: a.name, color: a.color || '#5ad0ff',
      px: f.x, py: f.y, dir: 'south', state: 'idle', sitting: false, working: false,
      phase: U.hash(a.id) % 6, target: null, idleUntil: 0, goal: null, say: { text: '', until: 0 }
    };
  }

  function start() { if (running) return; running = true; last = performance.now(); frame(last); }
  function stop() { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function wakeIn() { wakeAt = performance.now(); }
  function say(text) {
    if (!agent) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    agent.say = { text: t.slice(0, 160), until: performance.now() + 4200 };
  }
  /* kind: 'task' (go to computer + work) | 'talk' (pause, face Commander) | 'idle' (wander) */
  function setActivity(kind) {
    activity = kind;
    if (!agent) return;
    if (kind === 'talk') { agent.target = null; agent.state = 'idle'; agent.sitting = false; agent.working = false; agent.dir = 'south'; }
  }

  function resize() {
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || cv.parentElement.clientWidth, h = cv.clientHeight || cv.parentElement.clientHeight;
    cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
  }

  function tick(dt, now) {
    if (!agent) return;
    const SPEED = 34;
    if (activity === 'task' && agent.goal !== 'work') { agent.goal = 'work'; agent.sitting = false; agent.working = false; agent.target = footOf(seat.tx, seat.ty); agent.state = 'walk'; }
    if (activity !== 'task' && agent.goal === 'work') { agent.goal = null; agent.sitting = false; agent.working = false; agent.target = null; agent.state = 'idle'; agent.idleUntil = now + 200; }
    if (agent.target) {
      const dx = agent.target.x - agent.px, dy = agent.target.y - agent.py, d = Math.hypot(dx, dy);
      if (d < 1.1) {
        agent.px = agent.target.x; agent.py = agent.target.y; agent.target = null;
        if (agent.goal === 'work') { agent.sitting = true; agent.working = true; agent.dir = 'north'; agent.state = 'idle'; }
        else { agent.state = 'idle'; agent.idleUntil = now + U.irnd(800, 2600); }
      } else {
        const s = Math.min(d, SPEED * dt / 1000);
        agent.px += dx / d * s; agent.py += dy / d * s; agent.state = 'walk';
        agent.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
      }
    } else if (activity === 'idle' && agent.state !== 'walk' && !agent.sitting && now >= agent.idleUntil) {
      const tx = U.irnd(room.x1 + 1, room.x2 - 1), ty = U.irnd(room.y1 + 3, room.y2 - 1);
      agent.target = footOf(tx, ty); agent.state = 'walk';
    }
  }

  function frame(now) {
    const dt = Math.min(64, now - last); last = now; fnow = now;
    tick(dt, now);

    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#040302'; ctx.fillRect(0, 0, cv.width, cv.height);
    for (const s of stars) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph));
      ctx.fillStyle = 'rgba(180,200,230,' + tw + ')';
      ctx.fillRect((s.x * cv.width + now / 1000 * 8) % cv.width, s.y * cv.height, s.r, s.r);
    }

    const scale = Math.min(cv.width / W, cv.height / H);
    const ox = (cv.width - W * scale) / 2, oy = (cv.height - H * scale) / 2;
    ctx.setTransform(scale, 0, 0, scale, ox, oy); ctx.imageSmoothingEnabled = false;

    ctx.drawImage(baseCv, 0, 0);

    // furniture + agent, painter y-sort, under the lightmap
    const items = [
      { y: (desk.ty + desk.h) * T, draw: () => F_desk(desk.tx * T, desk.ty * T, desk.w * T, desk.h * T, { x: desk.tx, work: !!(agent && agent.working) }) },
      { y: (seat.ty + 1) * T, draw: () => F_chair(seat.tx * T, seat.ty * T) }
    ];
    if (agent) items.push({ y: agent.py, draw: () => drawAgent(now) });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();

    ctx.drawImage(lightCv, 0, 0);
    drawGlows(now);
    if (agent) drawBubble(now);

    if (running) raf = requestAnimationFrame(frame);
  }

  function drawGlows(now) {
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flickers) {
      const a = Math.max(0, 0.085 * (0.55 + 0.45 * Math.sin(now / 210 + f.x) * Math.sin(now / 83 + f.y)));
      const g = ctx.createRadialGradient(f.x, f.y, 1, f.x, f.y, f.r * 0.7);
      g.addColorStop(0, 'rgba(240,230,206,' + a + ')'); g.addColorStop(1, 'rgba(240,230,206,0)');
      ctx.fillStyle = g; ctx.fillRect(f.x - f.r * 0.7, f.y - f.r * 0.7, f.r * 1.4, f.r * 1.4);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawAgent(now) {
    let geo = null;
    if (SPRITES && SPRITES.ready) geo = SPRITES.drawBody(ctx, agent, now);
    if (!geo) drawFallback(now);
    if (wakeAt && now - wakeAt < 1300) {
      const t = (now - wakeAt) / 1300;
      ctx.save(); ctx.globalAlpha = (1 - t) * 0.8; ctx.strokeStyle = agent.color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(agent.px, agent.py, 4 + t * 16, 2 + t * 7, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
  }

  function drawFallback(now) {
    const a = agent, x = Math.round(a.px), y = Math.round(a.py), h = 13;
    const step = a.state === 'walk' ? (Math.floor(now / 140) % 2) : 0;
    const bob = (a.state !== 'walk' && !a.sitting) ? Math.round(Math.sin(now / 600 + a.phase) * 0.7) : 0;
    ctx.globalAlpha = 0.3; ctx.fillStyle = '#000'; ctx.fillRect(x - 4, y - 1, 8, 2); ctx.globalAlpha = 1;
    const top = y - h + bob;
    ctx.fillStyle = a.color; ctx.fillRect(x - 3, top + 3, 6, h - 6);
    ctx.fillStyle = '#f0e6c0'; ctx.fillRect(x - 2, top, 5, 4);
    ctx.fillStyle = U.shade(a.color, -0.45);
    if (a.sitting) ctx.fillRect(x - 3, y - 3, 6, 2);
    else { ctx.fillRect(x - 3 + (step ? 1 : 0), y - 2, 2, 2); ctx.fillRect(x + 1 - (step ? 1 : 0), y - 2, 2, 2); }
  }

  function drawBubble(now) {
    const s = agent.say;
    if (!s.text || s.until < now) return;
    ctx.font = '8px monospace';
    const maxW = 96, padb = 3, lh = 9;
    const words = s.text.split(' '), lines = []; let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; if (lines.length >= 3) break; } else line = test;
    }
    if (line && lines.length < 3) lines.push(line);
    if (lines.length === 3) lines[2] = lines[2].replace(/.{0,2}$/, '…');
    const bw = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width))) + padb * 2;
    const bh = lines.length * lh + padb * 2;
    let bx = Math.round(agent.px - bw / 2); const by = Math.round(agent.py - 22 - bh);
    bx = Math.max(2, Math.min(W - bw - 2, bx));
    ctx.fillStyle = 'rgba(3,2,1,0.92)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#ffaa33'; ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, bw - 1, bh - 1);
    ctx.fillStyle = '#ffaa33'; ctx.fillRect(Math.round(agent.px) - 1, by + bh, 3, 2);
    ctx.fillStyle = '#ffd9a3'; ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, bx + padb, by + padb + lh * (i + 1) - 2));
  }

  return { init, spawn, start, stop, setActivity, wakeIn, say };
})();
