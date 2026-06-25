/* STARNET — render.js : canvas station renderer (baked environment + live actors) */
'use strict';

const RENDER = (() => {
  const T = MAP.TILE, W = MAP.W, H = MAP.H;
  let cv, ctx, now = 0;
  let hoverAgent = null, hoverProp = null, selAgent = null;
  let onClick = null; // cb(propKey, agentId, screenPos)

  /* ---------- camera (zoom + pan) ----------
     World is drawn in 0..W,0..H; the camera maps world -> canvas pixels via
     setTransform(scale,0,0,scale,panX,panY). scale=1 / pan=0 == the classic
     fit-to-frame view, so the default look is unchanged. */
  const MIN_SCALE = 1, MAX_SCALE = 5;
  let scale = 1, panX = 0, panY = 0;
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  function clampPan() {
    // never let the station be dragged off-screen: keep [0,cv.width] inside [0,W*scale]
    panX = clamp(panX, cv.width - W * scale, 0);
    panY = clamp(panY, cv.height - H * scale, 0);
  }
  const floaters = []; // {x,y,txt,born,col}
  U.bus.on('sale', d => {
    const amt = d && d.amt != null ? d.amt : d;
    // anchor the cash over whoever earned it — revenue is legible at its source
    const b = d && d.agentId && WORLD.bodies ? WORLD.bodies[d.agentId] : null;
    let x, y;
    if (b) { x = b.px; y = b.py - 18; }
    else { const r = MAP.zones.publishing; x = U.rnd(r.x1 + 2, r.x2 - 2) * T; y = r.y1 * T + 8; }
    floaters.push({ x, y, txt: '+' + U.money(amt), born: now, col: '#69ff8e' });
    if (floaters.length > 8) floaters.shift();
  });
  U.bus.on('level', () => {
    floaters.push({ x: 37 * T - 20, y: 6 * T, txt: '★ LEVEL UP ★', born: now, col: '#ffd34a' });
  });

  const h2 = (x, y, salt) => U.hash(x + ',' + y + ',' + (salt || ''));

  /* ---------- precomputed stars ---------- */
  const stars = [];
  for (let i = 0; i < 230; i++) stars.push({
    x: Math.random() * W, y: Math.random() * H,
    r: Math.random() < 0.85 ? 1 : 2, ph: Math.random() * 10,
    spd: 0.3 + Math.random() * 0.9, layer: Math.random()
  });

  /* ---------- rounded corner geometry ---------- */
  /* corner tiles get NO straight walls; floor, wall and hull are all cut along
     quarter-circle arcs centered on the tile corner that points into the room */
  const chamferAt = {};
  for (const [ccx, ccy, ckind] of MAP.chamfers) chamferAt[ccx + ',' + ccy] = ckind;
  const CORNER = {
    tl: { cx: 1, cy: 1, a0: Math.PI, a1: 1.5 * Math.PI },
    tr: { cx: 0, cy: 1, a0: 1.5 * Math.PI, a1: 2 * Math.PI },
    bl: { cx: 1, cy: 0, a0: 0.5 * Math.PI, a1: Math.PI },
    br: { cx: 0, cy: 0, a0: 0, a1: 0.5 * Math.PI }
  };
  /* path = corner box minus the quarter-disc that stays (use with clip('evenodd')) */
  function spandrelPath(g, kind, ax, ay, rad) {
    const A = CORNER[kind];
    const ox = A.cx ? ax - rad : ax, oy = A.cy ? ay - rad : ay;
    g.beginPath();
    g.rect(ox, oy, rad, rad);
    g.moveTo(ax, ay);
    g.arc(ax, ay, rad, A.a0, A.a1);
    g.closePath();
    return { ox, oy };
  }
  function eraseSpandrel(g, kind, ax, ay, rad) {
    g.save();
    const o = spandrelPath(g, kind, ax, ay, rad);
    g.clip('evenodd');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    g.fillRect(o.ox - 1, o.oy - 1, rad + 2, rad + 2);
    g.restore();
  }

  /* ---------- wall edges ---------- */
  const edges = []; // {x,y,side,door,window,exterior}
  const winSet = {};
  for (const [wx, wy, side, len] of MAP.windows) {
    for (let i = 0; i < len; i++) {
      if (side === 'n' || side === 's') winSet[(wx + i) + ',' + wy + ',' + side] = true;
      else winSet[wx + ',' + (wy + i) + ',' + side] = true;
    }
  }
  (function buildEdges() {
    const dirs = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
    for (let y = 0; y < MAP.ROWS; y++) for (let x = 0; x < MAP.COLS; x++) {
      const z = MAP.zoneGrid[MAP.idx(x, y)];
      if (!z) continue;
      if (chamferAt[x + ',' + y]) continue; // rounded corner tile: arc replaces straight walls
      for (const side in dirs) {
        const [dx, dy] = dirs[side];
        const nx = x + dx, ny = y + dy;
        const nz = (nx < 0 || ny < 0 || nx >= MAP.COLS || ny >= MAP.ROWS) ? null : MAP.zoneGrid[MAP.idx(nx, ny)];
        if (nz === z) continue;
        const door = nz !== null && (MAP.canStep(x, y, nx, ny) || MAP.canStep(nx, ny, x, y));
        edges.push({ x, y, side, door, window: !!winSet[x + ',' + y + ',' + side], exterior: nz === null });
      }
    }
  })();

  /* animated detail registries (filled during bake) */
  const glints = [];  // north windows: {x, y}
  const leds = [];    // blinking leds: {x, y, c1, c2, period, ph}
  const lampPos = []; // baked light sources for the lightmap: {x, y, r}
  const flickers = []; // subset of lamps that shimmer per-frame

  const wallTop = '#4a463a', wallFace = '#2b2820', wallDk = '#1d1a14', hullC = '#191712';
  /* wall geometry — the "tilted 1/3 top-down" read. NFACE/NCAP: north interior wall
     face + hull cap above it; FACEW: lit wall-top band along s/w/e room edges;
     WALLH: exterior hull face extruded below every south-facing silhouette edge.
     intensity knobs: raise WALLH/NFACE to push the depth further. */
  const NFACE = 9, NCAP = 4, FACEW = 4, WALLH = 12;

  /* ================= BAKE: static environment ================= */
  let baseCv = null;
  function buildBase() {
    baseCv = document.createElement('canvas'); baseCv.width = W; baseCv.height = H;
    const b = baseCv.getContext('2d');
    b.imageSmoothingEnabled = false;
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };

    /* ----- hull plate ----- */
    const pad = 7, HR = T + pad; // HR: hull silhouette corner radius (floor arc + hull ring)
    const hullSeams = () => {
      b.globalCompositeOperation = 'source-atop';
      // large hull panel seams
      b.strokeStyle = '#231f17'; b.lineWidth = 1;
      for (let x = 5; x < W; x += 28) { b.beginPath(); b.moveTo(x + 0.5, 0); b.lineTo(x + 0.5, H); b.stroke(); }
      for (let y = 9; y < H; y += 26) { b.beginPath(); b.moveTo(0, y + 0.5); b.lineTo(W, y + 0.5); b.stroke(); }
      // discolored plates
      for (let gy = 0; gy < H; gy += 26) for (let gx = 0; gx < W; gx += 28) {
        const hh = h2(gx, gy, 'plate') % 7;
        if (hh === 0) px(gx + 5, gy + 9, 28, 26, 'rgba(0,0,0,0.10)');
        else if (hh === 1) px(gx + 5, gy + 9, 28, 26, 'rgba(205,190,155,0.03)');
      }
      b.globalCompositeOperation = 'source-over';
    };
    // rim + rivets + greebles per rect
    const hullRim = rects => {
      for (const r of rects) {
        const x1 = r.x1 * T - pad, y1 = r.y1 * T - pad, x2 = (r.x2 + 1) * T + pad, y2 = (r.y2 + 1) * T + pad;
        b.strokeStyle = '#28241b'; b.lineWidth = 2;
        b.strokeRect(x1 + 1, y1 + 1, x2 - x1 - 2, y2 - y1 - 2);
        b.fillStyle = '#302b21';
        for (let x = x1 + 6; x < x2; x += 18) { b.fillRect(x, y1 + 2, 2, 2); b.fillRect(x, y2 - 4, 2, 2); }
        for (let y = y1 + 6; y < y2; y += 18) { b.fillRect(x1 + 2, y, 2, 2); b.fillRect(x2 - 4, y, 2, 2); }
        // greebles along outer edge (skip where another rect overlaps — harmless if not)
        for (let x = x1 + 14; x < x2 - 14; x += 38) {
          const g = h2(x, y1, 'gr') % 3;
          if (g === 0) { px(x, y1, 6, 4, '#262219'); px(x + 1, y1 + 1, 4, 1, '#363024'); }
          else if (g === 1) { for (let i = 0; i < 3; i++) px(x + i * 2, y2 - 4, 1, 4, '#13110b'); }
        }
      }
    };
    const roomRects = MAP.allRects.filter(r => !MAP.isCorridor(r.z));
    const corRects = MAP.allRects.filter(r => MAP.isCorridor(r.z));
    // rooms first: slab, seams, rim — then round their silhouette corners
    b.fillStyle = hullC;
    for (const r of roomRects)
      b.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    hullSeams();
    hullRim(roomRects);
    for (const [ccx, ccy, kind] of MAP.chamfers) {
      const A = CORNER[kind], ax = (ccx + A.cx) * T, ay = (ccy + A.cy) * T;
      eraseSpandrel(b, kind, ax, ay, HR);
      // curved rim continuing the straight strokeRect rim
      b.strokeStyle = '#28241b'; b.lineWidth = 2;
      b.beginPath(); b.arc(ax, ay, HR - 2, A.a0, A.a1); b.stroke();
    }
    // corridors drawn after the corner erase so connector slabs stay intact
    b.fillStyle = hullC;
    for (const r of corRects)
      b.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    b.save();
    b.beginPath();
    for (const r of corRects)
      b.rect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    b.clip();
    hullSeams();
    b.restore();
    hullRim(corRects);
    // hull stencils
    b.font = '8px monospace';
    b.fillStyle = 'rgba(195,180,142,0.30)';
    b.fillText('STARNET·07', 31 * T, 3 * T - 10);
    b.fillText('DECK·A', 19 * T, 12 * T - 10);
    b.fillStyle = 'rgba(202,168,74,0.25)';
    b.fillText('CARGO', 64 * T - 16, 23 * T - 10);

    /* ----- static exterior structures ----- */
    // comms dish mast + dish
    const dx = 64 * T, dy = 12 * T - 8;
    b.strokeStyle = '#343026'; b.lineWidth = 2;
    b.beginPath(); b.moveTo(dx, dy + 8); b.lineTo(dx, dy - 2); b.stroke();
    b.fillStyle = '#2b2820';
    b.beginPath(); b.ellipse(dx, dy - 8, 10, 6, -0.5, 0, 7); b.fill();
    // bridge antenna mast
    b.beginPath(); b.moveTo(37 * T, 3 * T - 8); b.lineTo(37 * T, 3 * T - 22); b.stroke();
    // engine housings, mounted across the hull edge onto the extruded south face
    for (const ex of [29, 40]) {
      px(ex * T, 54 * T + 3, 4 * T, 10, '#231f19');
      px(ex * T, 54 * T + 3, 4 * T, 1, '#363024');
    }

    /* ----- floors ----- */
    for (const r of MAP.allRects) {
      if (MAP.isCorridor(r.z)) bakeCorridorFloor(b, r);
      else bakeRoomFloor(b, r);
    }
    bakeEdgeAO(b);
    bakeCorridorDressing(b);

    /* ----- door thresholds ----- */
    for (const [x1d, y1d, x2d, y2d] of MAP.doorDefs) {
      const hx = Math.min(x1d, x2d), hy = Math.min(y1d, y2d);
      b.fillStyle = '#3a3a26';
      if (x1d !== x2d) b.fillRect(Math.max(x1d, x2d) * T - 2, hy * T + 1, 4, T - 2);
      else b.fillRect(hx * T + 1, Math.max(y1d, y2d) * T - 2, T - 2, 4);
    }

    /* ----- walls ----- */
    bakeWalls(b);

    /* ----- room lighting (additive color wash + ceiling light pools) ----- */
    bakeRoomLighting(b);

    /* ----- rounded corners: floor cut + curved wall along the quarter-arc ----- */
    /* the spandrel outside the arc goes back to hull, then the curved wall is
       drawn outside-in: dark outer band, wall face, top highlight */
    for (const [ccx, ccy, kind] of MAP.chamfers) {
      const X = ccx * T, Y = ccy * T;
      const A = CORNER[kind], ax = X + A.cx * T, ay = Y + A.cy * T;
      b.save();
      spandrelPath(b, kind, ax, ay, T);
      b.clip('evenodd'); // tile minus the quarter-disc of floor that stays
      b.fillStyle = hullC; b.fillRect(X - 1, Y - 1, T + 2, T + 2);
      b.restore();
      // rooms carry a fat solid wall shell around the curve; corridor/hub corners stay slim
      const thick = !MAP.isCorridor(MAP.zoneGrid[MAP.idx(ccx, ccy)]);
      if (thick) {
        // dark hull wall fills the whole ring from the floor edge out to the rim
        b.lineWidth = 4.5; b.strokeStyle = wallDk;
        b.beginPath(); b.arc(ax, ay, T + 2.25, A.a0, A.a1); b.stroke();
        // lit wall face inside, matching the north-wall face
        b.lineWidth = 5; b.strokeStyle = wallFace;
        b.beginPath(); b.arc(ax, ay, T - 2.5, A.a0, A.a1); b.stroke();
        // strut ribs across the face, echoing the straight walls
        b.lineWidth = 1; b.strokeStyle = 'rgba(0,0,0,0.25)';
        for (let k = 1; k <= 2; k++) {
          const ang = A.a0 + (A.a1 - A.a0) * k / 3;
          b.beginPath();
          b.moveTo(ax + Math.cos(ang) * (T - 5), ay + Math.sin(ang) * (T - 5));
          b.lineTo(ax + Math.cos(ang) * T, ay + Math.sin(ang) * T);
          b.stroke();
        }
        // riveted rim re-struck at the outer edge of the shell
        b.lineWidth = 2; b.strokeStyle = '#28241b';
        b.beginPath(); b.arc(ax, ay, HR - 2, A.a0, A.a1); b.stroke();
        b.lineWidth = 1; b.strokeStyle = wallTop;
        b.beginPath(); b.arc(ax, ay, T - 5.5, A.a0, A.a1); b.stroke();
      } else {
        b.lineWidth = 2; b.strokeStyle = wallDk;
        b.beginPath(); b.arc(ax, ay, T + 1, A.a0, A.a1); b.stroke();
        b.lineWidth = 2; b.strokeStyle = wallFace;
        b.beginPath(); b.arc(ax, ay, T - 1, A.a0, A.a1); b.stroke();
        b.lineWidth = 1; b.strokeStyle = wallTop;
        b.beginPath(); b.arc(ax, ay, T - 2.5, A.a0, A.a1); b.stroke();
      }
    }

    /* ----- floor stencils (room codes) ----- */
    b.font = '7px monospace';
    const codes = { bridge: 'CMD-01', research: 'LAB-02', comms: 'COM-03', factory1: 'FAC-01', factory2: 'FAC-02', treasury: 'TRS-05', warroom: 'WAR-06', publishing: 'PUB-07', archives: 'ARC-08', quarters: 'HAB-09' };
    for (const rid of MAP.ROOM_IDS) {
      const r = MAP.zones[rid];
      b.fillStyle = 'rgba(255,255,255,0.07)';
      b.fillText(codes[rid], (r.x2 - 2) * T - 8, (r.y2 + 1) * T - 4);
    }

    bakeHullExtrusion(b);

    buildLightMap();
  }

  /* ================= LIGHTMAP: baked darkness with light carved back out =================
     Drawn over floors/walls/furniture/agents each frame so the whole scene sits in the
     same light. Glows/labels/UI render above it. */
  let lightCv = null;
  function buildLightMap() {
    lightCv = document.createElement('canvas'); lightCv.width = W; lightCv.height = H;
    const L = lightCv.getContext('2d');
    const pad = 7;
    // cool darkness over the hull only — space keeps its own exposure
    L.fillStyle = 'rgba(10,8,4,0.62)';
    for (const r of MAP.allRects)
      if (!MAP.isCorridor(r.z))
        L.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    // darkness follows the rounded hull silhouette at room corners
    for (const [ccx, ccy, kind] of MAP.chamfers) {
      const A = CORNER[kind];
      eraseSpandrel(L, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, T + pad);
    }
    L.fillStyle = 'rgba(10,8,4,0.62)';
    for (const r of MAP.allRects)
      if (MAP.isCorridor(r.z))
        L.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    L.globalCompositeOperation = 'destination-out';
    const cut = (x, y, r, a) => {
      const g = L.createRadialGradient(x, y, 1, x, y, r);
      g.addColorStop(0, 'rgba(0,0,0,' + a + ')');
      g.addColorStop(0.55, 'rgba(0,0,0,' + a * 0.45 + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      L.fillStyle = g;
      L.fillRect(x - r, y - r, r * 2, r * 2);
    };
    // broad room fill — brightest under the north fixtures, easing off toward the south wall
    for (const r of MAP.allRects) {
      if (MAP.isCorridor(r.z)) continue;
      const X = r.x1 * T, Y = r.y1 * T, RW = (r.x2 - r.x1 + 1) * T, RH = (r.y2 - r.y1 + 1) * T;
      const n = Math.max(1, Math.round(RW / (RH * 1.4)));
      for (let i = 0; i < n; i++)
        cut(X + RW * (i + 0.5) / n, Y + RH * 0.42, Math.max(RH * 0.78, RW / n * 0.62), 0.5);
    }
    // fixture pools (rooms + corridors)
    for (const l of lampPos) cut(l.x, l.y, l.r, 0.8);
    // light spills through open doorways
    for (const [x1d, y1d, x2d, y2d] of MAP.doorDefs)
      cut((x1d + x2d + 1) / 2 * T, (y1d + y2d + 1) / 2 * T, 20, 0.55);
    // faint starlight at the windows
    for (const [wx, wy, side, len] of MAP.windows) {
      for (let i = 0; i < len; i++) {
        if (side === 'n') cut((wx + i + 0.5) * T, wy * T + 3, 13, 0.22);
        else if (side === 's') cut((wx + i + 0.5) * T, (wy + 1) * T - 3, 13, 0.22);
        else if (side === 'w') cut(wx * T + 3, (wy + i + 0.5) * T, 13, 0.22);
        else cut((wx + 1) * T - 3, (wy + i + 0.5) * T, 13, 0.22);
      }
    }
    // soft vignette pulls the eye to the station core
    L.globalCompositeOperation = 'source-over';
    const v = L.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.72);
    v.addColorStop(0, 'rgba(3,2,1,0)');
    v.addColorStop(1, 'rgba(3,2,1,0.46)');
    L.fillStyle = v; L.fillRect(0, 0, W, H);
    // a few lamps get a living shimmer per-frame
    flickers.length = 0;
    for (let i = 3; i < lampPos.length; i += 9) flickers.push(lampPos[i]);
  }

  /* one station-wide deck material — room identity comes from LIGHTING, not paint */
  const FLOOR = '#33302a';

  /* room floor: metal deck panels, vents, hatches, stains — no checkerboard */
  function bakeRoomFloor(b, r) {
    const base = FLOOR;
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    px(r.x1 * T, r.y1 * T, (r.x2 - r.x1 + 1) * T, (r.y2 - r.y1 + 1) * T, base);
    const off = U.hash(r.z) % 2;
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      const X = x * T, Y = y * T;
      const n = h2(x, y, r.z);
      // subtle per-tile tone variation
      if (n % 5 === 0) px(X, Y, T, T, 'rgba(0,0,0,0.06)');
      else if (n % 7 === 0) px(X, Y, T, T, 'rgba(255,255,255,0.025)');
      // panel seams every 2 tiles
      if ((x + off) % 2 === 0) px(X, Y, 1, T, U.shade(base, -0.30));
      if ((y + off) % 2 === 0) px(X, Y, T, 1, U.shade(base, -0.30));
      // rivet at seam crossings
      if ((x + off) % 2 === 0 && (y + off) % 2 === 0) px(X + 1, Y + 1, 1, 1, U.shade(base, 0.22));
      // feature panels
      if (n % 19 === 3) { // vent grate
        px(X + 2, Y + 2, T - 4, T - 4, U.shade(base, -0.25));
        for (let i = 0; i < 3; i++) px(X + 3, Y + 4 + i * 3, T - 6, 1, U.shade(base, -0.5));
      } else if (n % 23 === 5) { // access hatch
        px(X + 2, Y + 2, T - 4, T - 4, U.shade(base, -0.12));
        b.strokeStyle = U.shade(base, -0.4); b.lineWidth = 1;
        b.strokeRect(X + 2.5, Y + 2.5, T - 5, T - 5);
        px(X + T / 2 - 2, Y + T / 2, 4, 1, U.shade(base, -0.5));
      } else if (n % 31 === 7) { // stain
        b.fillStyle = 'rgba(0,0,0,0.13)';
        b.beginPath(); b.ellipse(X + (n % 8), Y + (n % 6) + 3, 5, 3, 0, 0, 7); b.fill();
      } else if (n % 13 === 2) { // scuffs
        px(X + (n % 5), Y + (n % 7) + 2, 4, 1, 'rgba(0,0,0,0.12)');
        px(X + (n % 7) + 1, Y + (n % 4) + 6, 3, 1, 'rgba(255,255,255,0.05)');
      }
    }
    // recessed light strip along the north interior wall (dashes) — neutral
    // sits just below the NFACE wall face + 1px top lip
    b.fillStyle = 'rgba(226,214,184,0.28)';
    for (let x = r.x1 * T + 3; x < (r.x2 + 1) * T - 3; x += 10) b.fillRect(x, r.y1 * T + NFACE + 2, 6, 1);
  }

  /* corridor floor: modular station decking — plates, structural ribs, edge air grilles */
  function bakeCorridorFloor(b, r) {
    const base = '#2c2924';
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    const X0 = r.x1 * T, Y0 = r.y1 * T, RW = (r.x2 - r.x1 + 1) * T, RH = (r.y2 - r.y1 + 1) * T;
    px(X0, Y0, RW, RH, base);
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      const X = x * T, Y = y * T, n = h2(x, y, 'cor');
      // per-tile tonal variation
      if (n % 5 === 0) px(X, Y, T, T, 'rgba(0,0,0,0.05)');
      else if (n % 7 === 0) px(X, Y, T, T, 'rgba(255,255,255,0.02)');
      // deck plate seams every 2 tiles, rivets at crossings
      if (x % 2 === 0) px(X, Y, 1, T, U.shade(base, -0.30));
      if (y % 2 === 0) px(X, Y, T, 1, U.shade(base, -0.30));
      if (x % 2 === 0 && y % 2 === 0) px(X + 1, Y + 1, 1, 1, U.shade(base, 0.20));
      // occasional service hatch / scuffs
      if (n % 23 === 5) {
        px(X + 2, Y + 2, T - 4, T - 4, U.shade(base, -0.12));
        b.strokeStyle = U.shade(base, -0.4); b.lineWidth = 1;
        b.strokeRect(X + 2.5, Y + 2.5, T - 5, T - 5);
        px(X + T / 2 - 2, Y + T / 2, 4, 1, U.shade(base, -0.5));
      } else if (n % 13 === 2) {
        px(X + (n % 5), Y + (n % 7) + 2, 4, 1, 'rgba(0,0,0,0.10)');
      }
    }
    const vertical = (r.y2 - r.y1) > (r.x2 - r.x1);
    if (vertical) {
      // structural rib bands across the corridor every 4 tiles
      for (let y = r.y1 + 2; y <= r.y2 - 1; y += 4) {
        px(X0, y * T, RW, 1, U.shade(base, 0.14));
        px(X0, y * T + 1, RW, 1, U.shade(base, -0.35));
      }
      // recessed air grilles along both edges
      for (let y = Y0 + 2; y < Y0 + RH - 2; y += 3) {
        px(X0 + 1, y, 2, 1, '#1d1a15');
        px(X0 + RW - 3, y, 2, 1, '#1d1a15');
      }
    } else if (r.x2 - r.x1 > 3) {
      for (let x = r.x1 + 2; x <= r.x2 - 1; x += 4) {
        px(x * T, Y0, 1, RH, U.shade(base, 0.14));
        px(x * T + 1, Y0, 1, RH, U.shade(base, -0.35));
      }
      for (let x = X0 + 2; x < X0 + RW - 2; x += 3) {
        px(x, Y0 + 1, 1, 2, '#1d1a15');
        px(x, Y0 + RH - 3, 1, 2, '#1d1a15');
      }
    }
  }

  /* per-room colored lighting, baked additively over floor + lower walls */
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function bakeRoomLighting(b) {
    b.globalCompositeOperation = 'lighter';
    for (const r of MAP.allRects) {
      if (MAP.isCorridor(r.z)) continue;
      const X = r.x1 * T, Y = r.y1 * T, RW = (r.x2 - r.x1 + 1) * T, RH = (r.y2 - r.y1 + 1) * T;
      // neutral ceiling light pools along the north side — plain white, no room tint
      const tilesW = r.x2 - r.x1 + 1;
      const count = Math.max(1, Math.round(tilesW / 7));
      const rad = Math.min(60, Math.max(30, RH * 0.85));
      for (let i = 0; i < count; i++) {
        const lx = X + RW * (i + 0.5) / count;
        const ly = Y + T * 1.6;
        const gw = b.createRadialGradient(lx, ly, 1, lx, ly, rad * 0.7);
        gw.addColorStop(0, 'rgba(248,238,214,0.16)');
        gw.addColorStop(0.6, 'rgba(248,238,214,0.05)');
        gw.addColorStop(1, 'rgba(248,238,214,0)');
        b.fillStyle = gw;
        b.fillRect(Math.max(X, lx - rad * 0.7), Y, Math.min(rad * 1.4, RW), Math.min(rad * 1.2, RH));
        lampPos.push({ x: lx, y: ly, r: rad * 1.4 });
      }
      b.globalCompositeOperation = 'source-over';
      // visible light fixtures on the north wall face — neutral metal
      for (let i = 0; i < count; i++) {
        const lx = X + RW * (i + 0.5) / count;
        b.fillStyle = '#6a6253';
        b.fillRect(Math.round(lx) - 4, Y + 1, 8, 2);
        b.fillStyle = 'rgba(255,255,255,0.55)';
        b.fillRect(Math.round(lx) - 3, Y + 1, 6, 1);
      }
      b.globalCompositeOperation = 'lighter';
    }
    b.globalCompositeOperation = 'source-over';
  }

  /* cables, pipes, junction boxes, light pools along corridors */
  function bakeCorridorDressing(b) {
    const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    const CABLES = ['#a3402e', '#b8973a', '#3e7a8a'];
    for (const r of MAP.allRects) {
      if (!MAP.isCorridor(r.z)) continue;
      const vertical = (r.y2 - r.y1) > (r.x2 - r.x1);
      if (vertical) {
        const x0 = r.x1 * T + 1, y0 = r.y1 * T, y1 = (r.y2 + 1) * T;
        CABLES.forEach((c, i) => px(x0 + i * 2, y0, 1, y1 - y0, c));
        for (let y = y0 + 10; y < y1; y += 30) px(x0 - 1, y, 7, 3, '#201d16'); // cable clips
        // pipe on the right wall
        const xp = (r.x2 + 1) * T - 5;
        px(xp, y0, 3, y1 - y0, '#555043'); px(xp, y0, 1, y1 - y0, '#6a6354');
        for (let y = y0 + 16; y < y1; y += 36) { px(xp - 1, y, 5, 3, '#423d32'); px(xp - 1, y, 5, 1, '#6a6354'); }
        // ceiling light pools down the centerline
        const cx = (r.x1 + r.x2 + 1) / 2 * T;
        for (let y = y0 + 24; y < y1 - 8; y += 54) {
          const g = b.createRadialGradient(cx, y, 1, cx, y, 22);
          g.addColorStop(0, 'rgba(235,224,196,0.18)'); g.addColorStop(1, 'rgba(235,224,196,0)');
          b.fillStyle = g; b.fillRect(cx - 22, y - 22, 44, 44);
          lampPos.push({ x: cx, y, r: 42 });
        }
      } else {
        const y0 = r.y1 * T + 6, x0 = r.x1 * T, x1 = (r.x2 + 1) * T;
        CABLES.forEach((c, i) => px(x0, y0 + i * 2, x1 - x0, 1, c));
        for (let x = x0 + 10; x < x1; x += 30) px(x, y0 - 1, 3, 7, '#201d16');
        const yp = (r.y2 + 1) * T - 5;
        px(x0, yp, x1 - x0, 3, '#555043'); px(x0, yp, x1 - x0, 1, '#6a6354');
        for (let x = x0 + 16; x < x1; x += 36) { px(x, yp - 1, 3, 5, '#423d32'); px(x, yp - 1, 1, 5, '#6a6354'); }
        // ceiling light pools along the centerline
        const cy = (r.y1 + r.y2 + 1) / 2 * T;
        for (let x = x0 + 28; x < x1 - 8; x += 58) {
          const g = b.createRadialGradient(x, cy, 1, x, cy, 22);
          g.addColorStop(0, 'rgba(235,224,196,0.18)'); g.addColorStop(1, 'rgba(235,224,196,0)');
          b.fillStyle = g; b.fillRect(x - 22, cy - 22, 44, 44);
          lampPos.push({ x, y: cy, r: 42 });
        }
      }
    }
    // junction boxes where side corridors meet the spine
    const junctions = [[35, 15], [39, 15], [35, 39], [39, 39]];
    for (const [jx, jy] of junctions) {
      const X = jx * T + (jx === 35 ? 1 : T - 8), Y = jy * T - 4;
      px(X, Y, 7, 9, '#2a261d'); px(X + 1, Y + 1, 5, 7, '#342f24');
      px(X + 2, Y + 5, 3, 1, '#1a1812');
      leds.push({ x: X + 2, y: Y + 2, c1: '#41ff8a', c2: '#173a26', period: 700 + (jx * jy) % 400, ph: jx });
    }
    // a few wall-panel leds in the spine (skipping the hub plaza)
    for (const y of [13, 19, 35, 42]) {
      leds.push({ x: 35 * T + 8, y: y * T + 3, c1: '#b8973a', c2: '#2a2415', period: 900 + y * 37 % 500, ph: y });
    }
  }

  /* ambient occlusion at zone borders */
  function bakeEdgeAO(b) {
    b.fillStyle = 'rgba(0,0,0,0.25)';
    for (const e of edges) {
      const X = e.x * T, Y = e.y * T;
      if (e.door) continue;
      const room = !MAP.isCorridor(MAP.zoneGrid[MAP.idx(e.x, e.y)]);
      const d = room ? 5 : 3; // shadow depth tracks the thicker room walls
      if (e.side === 'n') b.fillRect(X, Y, T, room ? 8 : 4);
      else if (e.side === 's') b.fillRect(X, Y + T - d, T, d);
      else if (e.side === 'w') b.fillRect(X, Y, d, T);
      else b.fillRect(X + T - d, Y, d, T);
    }
  }

  /* s/w/e edges read as the flat TOP of a thick wall (lit band + interior lip),
     matching the shell the chamfer arcs already wear — the n edge alone shows a
     tall interior face, which is what sells the tilted top-down camera */
  function bakeWalls(b) {
    for (const e of edges) {
      const X = e.x * T, Y = e.y * T;
      // rooms get beefier walls; corridors keep the slim profile
      const room = !MAP.isCorridor(MAP.zoneGrid[MAP.idx(e.x, e.y)]);
      const fw = room ? FACEW : 2; // s/w/e wall-top band width
      const out = room ? 4 : 2;    // dark hull band outside exterior edges
      const face = room ? NFACE : 5; // n wall face height
      const cap = room ? NCAP : 2; // dark hull cap above the n face
      const jamb = room ? 3 : 2;   // door frame strip
      const dep = fw + 1;          // window glass depth = lip + band
      const rib = 'rgba(0,0,0,0.25)';
      if (e.side === 'n') {
        if (e.door) { b.fillStyle = '#564f41'; b.fillRect(X, Y, T, jamb); continue; }
        if (e.window) {
          if (e.exterior) { b.fillStyle = wallDk; b.fillRect(X, Y - cap, T, cap); }
          b.fillStyle = '#06090f'; b.fillRect(X, Y, T, face);
          b.fillStyle = 'rgba(160,220,255,0.12)'; b.fillRect(X, Y + 1, T, 1);
          b.fillStyle = wallTop; b.fillRect(X, Y + face, T, 1);
          glints.push({ x: X, y: Y + 1 });
          continue;
        }
        if (e.exterior) { b.fillStyle = wallDk; b.fillRect(X, Y - cap, T, cap); }
        b.fillStyle = wallFace; b.fillRect(X, Y, T, face);
        // strut texture on the face
        b.fillStyle = rib;
        b.fillRect(X + 5, Y, 1, face);
        b.fillStyle = wallTop; b.fillRect(X, Y + face, T, 1);
        b.fillStyle = 'rgba(255,255,255,0.05)'; b.fillRect(X, Y, T, 1);
      } else if (e.side === 's') {
        if (e.door) { b.fillStyle = '#564f41'; b.fillRect(X, Y + T - jamb, T, jamb); continue; }
        if (e.window) {
          b.fillStyle = '#06090f'; b.fillRect(X, Y + T - dep, T, dep);
          b.fillStyle = 'rgba(160,220,255,0.15)'; b.fillRect(X, Y + T - dep, T, 1);
          if (e.exterior) { b.fillStyle = wallDk; b.fillRect(X, Y + T, T, out); }
          continue;
        }
        b.fillStyle = wallTop; b.fillRect(X, Y + T - dep, T, 1);
        b.fillStyle = wallFace; b.fillRect(X, Y + T - fw, T, fw);
        b.fillStyle = rib; b.fillRect(X + 5, Y + T - fw, 1, fw);
        b.fillStyle = wallDk;
        if (e.exterior) b.fillRect(X, Y + T, T, out);
        else b.fillRect(X, Y + T - 1, T, 1); // seam where two zones back onto each other
      } else if (e.side === 'w') {
        if (e.door) { b.fillStyle = '#564f41'; b.fillRect(X, Y, jamb, T); continue; }
        if (e.window) {
          b.fillStyle = '#06090f'; b.fillRect(X, Y, dep, T);
          b.fillStyle = 'rgba(160,220,255,0.13)'; b.fillRect(X + dep - 1, Y, 1, T);
          if (e.exterior) { b.fillStyle = wallDk; b.fillRect(X - out, Y, out, T); }
          continue;
        }
        b.fillStyle = wallTop; b.fillRect(X + fw, Y, 1, T);
        b.fillStyle = wallFace; b.fillRect(X, Y, fw, T);
        b.fillStyle = rib; b.fillRect(X, Y + 5, fw, 1);
        b.fillStyle = wallDk;
        if (e.exterior) b.fillRect(X - out, Y, out, T);
        else b.fillRect(X, Y, 1, T);
      } else {
        if (e.door) { b.fillStyle = '#564f41'; b.fillRect(X + T - jamb, Y, jamb, T); continue; }
        if (e.window) {
          b.fillStyle = '#06090f'; b.fillRect(X + T - dep, Y, dep, T);
          b.fillStyle = 'rgba(160,220,255,0.13)'; b.fillRect(X + T - dep, Y, 1, T);
          if (e.exterior) { b.fillStyle = wallDk; b.fillRect(X + T, Y, out, T); }
          continue;
        }
        b.fillStyle = wallTop; b.fillRect(X + T - dep, Y, 1, T);
        b.fillStyle = wallFace; b.fillRect(X + T - fw, Y, fw, T);
        b.fillStyle = rib; b.fillRect(X + T - fw, Y + 5, fw, 1);
        b.fillStyle = wallDk;
        if (e.exterior) b.fillRect(X + T, Y, out, T);
        else b.fillRect(X + T - 1, Y, 1, T);
      }
    }
  }

  /* ----- exterior hull extrusion: turns floor decals into a solid station body.
     The full silhouette (rects + pad, chamfer spandrels cut) is stamped downward
     behind the bake (destination-over), so every south-facing edge — straight or
     curved — grows a depth-shaded exterior wall face. shift(sil, k) covers exactly
     the top k px below each bottom edge, so deeper stamps paint first and shallower
     stamps shade upward; the arcs come along for free. */
  function bakeHullExtrusion(b) {
    const pad = 7, HR = T + pad;
    const sil = document.createElement('canvas'); sil.width = W; sil.height = H;
    const g = sil.getContext('2d');
    const padRect = r => g.fillRect(r.x1 * T - pad, r.y1 * T - pad, (r.x2 - r.x1 + 1) * T + pad * 2, (r.y2 - r.y1 + 1) * T + pad * 2);
    g.fillStyle = '#fff';
    for (const r of MAP.allRects) if (!MAP.isCorridor(r.z)) padRect(r);
    for (const [ccx, ccy, kind] of MAP.chamfers) {
      const A = CORNER[kind];
      eraseSpandrel(g, kind, (ccx + A.cx) * T, (ccy + A.cy) * T, HR);
    }
    g.fillStyle = '#fff';
    for (const r of MAP.allRects) if (MAP.isCorridor(r.z)) padRect(r);
    const f = document.createElement('canvas'); f.width = W; f.height = H;
    const fg = f.getContext('2d');
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    const tg = tmp.getContext('2d');
    const stamp = (dy, c) => {
      tg.clearRect(0, 0, W, H);
      tg.drawImage(sil, 0, dy);
      tg.globalCompositeOperation = 'source-in';
      tg.fillStyle = c; tg.fillRect(0, 0, W, H);
      tg.globalCompositeOperation = 'source-over';
      fg.drawImage(tmp, 0, 0);
    };
    stamp(WALLH, '#0b0a07');     // bottom rows fall off toward space
    stamp(WALLH - 2, '#14120d'); // main face
    stamp(3, '#1f1c15');         // upper face catches the deck lighting
    stamp(1, '#3f3a2c');         // lit lip right under the hull rim
    fg.globalCompositeOperation = 'destination-out';
    fg.drawImage(sil, 0, 0);     // keep only the band exposed below the silhouette
    fg.globalCompositeOperation = 'source-atop';
    // struts continuing the hull panel seams down the face
    fg.fillStyle = 'rgba(0,0,0,0.35)';
    for (let x = 5; x < W; x += 28) fg.fillRect(x, 0, 1, H);
    // lit portholes on the face under real south windows on the outer hull
    for (const [wx, wy, side, len] of MAP.windows) {
      if (side !== 's') continue;
      for (let i = 0; i < len; i++) {
        if (wy + 1 < MAP.ROWS && MAP.zoneGrid[MAP.idx(wx + i, wy + 1)]) continue;
        const cx = Math.round((wx + i + 0.5) * T);
        fg.fillStyle = 'rgba(120,180,230,0.55)';
        fg.fillRect(cx - 1, (wy + 1) * T + pad + 4, 3, 2);
      }
    }
    fg.globalCompositeOperation = 'source-over';
    b.globalCompositeOperation = 'destination-over';
    b.drawImage(f, 0, 0);
    b.globalCompositeOperation = 'source-over';
  }

  /* ---------- animated exterior bits (over the bake) ---------- */
  function drawExteriorAnim() {
    // dish + antenna leds
    const dx = 64 * T, dy = 12 * T - 8;
    ctx.fillStyle = SPR.blink(800) ? '#ff5c5c' : '#4a2222';
    ctx.fillRect(dx - 1, dy - 16, 2, 2);
    ctx.fillStyle = SPR.blink(600) ? '#41ff8a' : '#1a3a26';
    ctx.fillRect(37 * T - 1, 3 * T - 25, 3, 3);
    // engine glow
    const eg = 0.45 + 0.2 * Math.sin(now / 300);
    for (const ex of [29, 40]) {
      const g = ctx.createRadialGradient(ex * T + 2 * T, 54 * T + 14, 1, ex * T + 2 * T, 54 * T + 14, 16);
      g.addColorStop(0, 'rgba(120,190,255,' + eg + ')'); g.addColorStop(1, 'rgba(120,190,255,0)');
      ctx.fillStyle = g; ctx.fillRect(ex * T - 10, 54 * T + 4, 4 * T + 20, 26);
    }
    // nav lights
    const navs = [[9 * T - 18, 15 * T], [64 * T + 18, 15 * T], [5 * T - 6, 39 * T], [68 * T + 6, 40 * T]];
    navs.forEach(([nx, ny], i) => {
      ctx.fillStyle = SPR.blink(700, i * 0.5) ? (i % 2 ? '#ff5c5c' : '#41ff8a') : '#1a2420';
      ctx.fillRect(nx, ny, 3, 3);
    });
    // window star glints (north windows)
    ctx.fillStyle = 'rgba(140,190,255,0.30)';
    for (const g of glints) ctx.fillRect(g.x + ((now / 240 + g.x * 3) % T), g.y, 1, 1);
    // junction/wall leds
    for (const l of leds) {
      ctx.fillStyle = SPR.blink(l.period, l.ph) ? l.c1 : l.c2;
      ctx.fillRect(l.x, l.y, 2, 2);
    }
  }

  /* ---------- ambient glows ---------- */
  function drawGlows() {
    // lamp shimmer — a handful of fixtures breathe so the neutral light feels alive
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flickers) {
      const a = Math.max(0, 0.085 * (0.55 + 0.45 * Math.sin(now / 210 + f.x) * Math.sin(now / 83 + f.y)));
      const g = ctx.createRadialGradient(f.x, f.y, 1, f.x, f.y, f.r * 0.7);
      g.addColorStop(0, 'rgba(240,230,206,' + a + ')');
      g.addColorStop(1, 'rgba(240,230,206,0)');
      ctx.fillStyle = g;
      ctx.fillRect(f.x - f.r * 0.7, f.y - f.r * 0.7, f.r * 1.4, f.r * 1.4);
    }
    ctx.globalCompositeOperation = 'source-over';
    const S = SIM.S;
    if (S && S.party > S.time) {
      const hue = (now / 20) % 360;
      ctx.fillStyle = 'hsla(' + hue + ',80%,60%,0.07)';
      const r = MAP.zones.quarters;
      ctx.fillRect(r.x1 * T, r.y1 * T, (r.x2 - r.x1 + 1) * T, (r.y2 - r.y1 + 1) * T);
    }
  }

  /* ---------- labels & hazards ---------- */
  function drawLabels() {
    ctx.font = '9px monospace';
    for (const rid of MAP.ROOM_IDS) {
      const r = MAP.zones[rid], room = DATA.ROOMS[rid];
      ctx.fillStyle = 'rgba(212,198,164,0.45)';
      ctx.fillText(room.name, r.x1 * T + 3, r.y1 * T + 11);
    }
  }
  function drawHazards(hz) {
    for (const rid in hz) {
      if (rid === 'corridor' || !MAP.zones[rid]) continue;
      const r = MAP.zones[rid];
      const a = 0.25 + 0.45 * Math.abs(Math.sin(now / 280));
      ctx.strokeStyle = 'rgba(255,170,40,' + a + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(r.x1 * T + 1, r.y1 * T + 1, (r.x2 - r.x1 + 1) * T - 2, (r.y2 - r.y1 + 1) * T - 2, T);
      ctx.stroke();
      const cx = (r.x1 + r.x2 + 1) / 2 * T, cy = r.y1 * T - 5 + Math.sin(now / 300) * 1.5;
      ctx.fillStyle = 'rgba(255,190,40,' + (0.6 + 0.4 * Math.sin(now / 280)) + ')';
      ctx.beginPath(); ctx.moveTo(cx, cy - 5); ctx.lineTo(cx + 5, cy + 3); ctx.lineTo(cx - 5, cy + 3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#1a1200'; ctx.fillRect(cx - 0.5, cy - 2.5, 1.5, 3);
    }
  }

  /* hovered prop: targeting brackets + designation tag (mirrors agent hover) */
  function drawPropHover() {
    if (!hoverProp) return;
    const f = hoverProp;
    const x = f.x * T - 2, y = f.y * T - 2, w = f.w * T + 4, hh = f.h * T + 4;
    const room = MAP.roomAt(f.x, f.y);
    const acc = (DATA.ROOMS[room] || DATA.ROOMS.corridor).accent;
    const arm = 5;
    ctx.strokeStyle = acc;
    ctx.globalAlpha = 0.65 + 0.35 * Math.abs(Math.sin(now / 260));
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + arm); ctx.lineTo(x, y); ctx.lineTo(x + arm, y);
    ctx.moveTo(x + w - arm, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + arm);
    ctx.moveTo(x + w, y + hh - arm); ctx.lineTo(x + w, y + hh); ctx.lineTo(x + w - arm, y + hh);
    ctx.moveTo(x + arm, y + hh); ctx.lineTo(x, y + hh); ctx.lineTo(x, y + hh - arm);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // designation tag above the prop
    ctx.font = '9px monospace';
    const txt = f.pwl || 'TERMINAL';
    const tw = ctx.measureText(txt).width + 8;
    const lx = U.clamp(x + w / 2 - tw / 2, 2, W - tw - 2);
    const ly = Math.max(2, y - 15);
    ctx.fillStyle = 'rgba(5,10,8,0.85)';
    ctx.fillRect(lx, ly, tw, 12);
    ctx.strokeStyle = acc;
    ctx.strokeRect(lx + 0.5, ly + 0.5, tw - 1, 11);
    ctx.fillStyle = acc;
    ctx.fillText(txt, lx + 4, ly + 9);
  }

  /* ---------- main frame ---------- */
  function frame(tMs) {
    now = tMs;
    SPR.setCtx(ctx); // reclaim ctx (portrait renders borrow it)
    SPR.setNow(tMs);

    // clear the whole canvas under identity, then look through the camera —
    // this paints black into the margins exposed when zoomed/panned
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#040302';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(scale, 0, 0, scale, panX, panY);

    // space
    ctx.fillStyle = '#040302';
    ctx.fillRect(0, 0, W, H);
    for (const s of stars) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(tMs / (900 + s.ph * 300) + s.ph));
      ctx.fillStyle = s.layer > 0.7 ? 'rgba(200,220,255,' + tw + ')' : 'rgba(140,160,190,' + tw * 0.7 + ')';
      const sx = (s.x + tMs / 1000 * s.spd) % W;
      ctx.fillRect(sx, s.y, s.r, s.r);
    }

    if (!baseCv) buildBase();
    ctx.drawImage(baseCv, 0, 0);
    drawExteriorAnim();

    // furniture & agents y-sorted
    const workTiles = {};
    for (const id in WORLD.bodies) {
      const b = WORLD.bodies[id];
      if (b.working) workTiles[b.tile.x + ',' + b.tile.y] = true;
    }
    // occupied seats must sort just behind their sitter, not by tile bottom edge
    const sitPy = {};
    for (const id in WORLD.bodies) {
      const b = WORLD.bodies[id];
      if (b.sitting && b.tile) sitPy[b.tile.x + ',' + b.tile.y] = b.py;
    }
    const items = [];
    for (const f of MAP.furniture) {
      let work = false;
      for (let dy = -2; dy <= 2 && !work; dy++) for (let dx = -2; dx <= 2 && !work; dx++)
        if (workTiles[(f.x + dx) + ',' + (f.y + dy)]) work = true;
      let fy = (f.y + (f.h || 1)) * T - (f.t === 'rug' ? 900 : 0);
      // scan the full footprint — multi-tile seats (couch) sit people on non-origin tiles
      let occ = 0;
      if (f.sit) {
        for (let dy = 0; dy < (f.h || 1) && !occ; dy++) for (let dx = 0; dx < (f.w || 1) && !occ; dx++)
          occ = sitPy[(f.x + dx) + ',' + (f.y + dy)] || 0;
      }
      if (occ) fy = occ - 1;
      items.push({ y: fy, draw: () => SPR.drawFurn(f, work) });
    }
    for (const p of WORLD.parcels) items.push({ y: p.y + 6, draw: () => SPR.drawParcel(p) }); // +6 sorts past the belt's bottom edge so boxes ride on top of it
    for (const id in WORLD.bodies) {
      const b = WORLD.bodies[id];
      items.push({ y: b.py, draw: () => SPR.drawAgent(b, selAgent === id || hoverAgent === id) });
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();

    ctx.drawImage(lightCv, 0, 0); // baked darkness + light pools over the whole scene
    drawGlows();
    drawLabels();
    if (SIM.S) drawHazards(SIM.hazards());
    drawPropHover();

    // sale / level floaters
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const age = (now - f.born) / 2400;
      if (age >= 1) { floaters.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - age;
      ctx.font = '10px monospace';
      ctx.fillStyle = '#020503';
      ctx.fillText(f.txt, f.x + 1, f.y - age * 18 + 1);
      ctx.fillStyle = f.col;
      ctx.fillText(f.txt, f.x, f.y - age * 18);
      ctx.globalAlpha = 1;
    }

    // hovered agent name tag
    if (hoverAgent || selAgent) {
      const b = WORLD.bodies[hoverAgent || selAgent];
      if (b) {
        ctx.font = '9px monospace';
        const w = ctx.measureText(b.id).width + 6;
        ctx.fillStyle = 'rgba(5,10,8,0.85)';
        ctx.fillRect(b.px - w / 2, b.py - 28, w, 11);
        ctx.fillStyle = b.color;
        ctx.fillText(b.id, b.px - w / 2 + 3, b.py - 19);
      }
    }
  }

  /* ---------- input ---------- */
  // canvas-pixel coords from a pointer event (canvas is CSS-stretched to its box)
  function toCanvas(ev) {
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
  }
  // world coords: undo the camera transform on the canvas-pixel position
  function toLocal(ev) {
    const c = toCanvas(ev);
    return { x: (c.x - panX) / scale, y: (c.y - panY) / scale };
  }
  function init(canvas, clickCb) {
    cv = canvas; onClick = clickCb;
    cv.width = W; cv.height = H;
    ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    SPR.setCtx(ctx);
    cv.style.cursor = 'grab';

    let dragging = false, dragSX = 0, dragSY = 0, dragMoved = false;
    cv.addEventListener('mousemove', ev => {
      if (dragging) {
        const c = toCanvas(ev);
        panX += c.x - dragSX; panY += c.y - dragSY;
        dragSX = c.x; dragSY = c.y;
        dragMoved = true; // any movement while held counts as a drag, not a click
        clampPan();
        cv.style.cursor = 'grabbing';
        return;
      }
      const p = toLocal(ev);
      const b = WORLD.bodyAt(p.x, p.y);
      hoverAgent = b ? b.id : null;
      hoverProp = b ? null : MAP.propAt(Math.floor(p.x / T), Math.floor(p.y / T));
      cv.style.cursor = (hoverAgent || hoverProp) ? 'pointer' : 'grab';
    });
    cv.addEventListener('mouseleave', () => { hoverAgent = null; hoverProp = null; });

    // drag to pan — track movement so a real drag doesn't fire click-to-select
    cv.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      const c = toCanvas(ev);
      dragging = true; dragMoved = false; dragSX = c.x; dragSY = c.y;
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; cv.style.cursor = 'grab'; }
    });

    cv.addEventListener('click', ev => {
      if (dragMoved) { dragMoved = false; return; } // released after a pan — not a select
      const p = toLocal(ev);
      const b = WORLD.bodyAt(p.x, p.y);
      if (b) { selAgent = b.id; onClick && onClick(null, b.id, null); return; }
      const f = MAP.propAt(Math.floor(p.x / T), Math.floor(p.y / T));
      if (f) { selAgent = null; onClick && onClick(f.pw, null, { x: ev.clientX, y: ev.clientY }); }
      else selAgent = null;
    });

    // wheel to zoom, centered on the cursor so the point under it stays put
    cv.addEventListener('wheel', ev => {
      ev.preventDefault();
      const c = toCanvas(ev);
      const wx = (c.x - panX) / scale, wy = (c.y - panY) / scale; // world point under cursor
      scale = clamp(scale * Math.exp(-ev.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
      panX = c.x - wx * scale; panY = c.y - wy * scale;
      clampPan();
    }, { passive: false });
  }

  return { init, frame, set selAgent(v) { selAgent = v; } };
})();
