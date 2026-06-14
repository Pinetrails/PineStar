/* SKYNET — build.js : the diegetic full-screen REFIT (build) mode.

   Toggled from the dock. Dims the live sim and drops the Commander into an in-fiction
   station-editor over the SAME procedural art: pan/zoom camera, phosphor build grid,
   a ghost preview that snaps to tiles and tints green/red via the model's validators,
   and an in-fiction toolbar — PLACE ROOM · HALLWAY · PAINT · MOVE · RECLAIM · UNDO.

   It reads + mutates the canonical WorldModel station (the single source of truth) and
   re-bakes via StationBake on every change, then persists through the injected save hook.
   See frontend/app/BUILDER.md for the contract. */
'use strict';

const Build = (() => {
  const TOOLS = [
    { id: 'room', label: '▦ ROOM', hint: 'drag to place a room' },
    { id: 'hall', label: '═ HALLWAY', hint: 'drag along an axis to run a corridor — any length' },
    { id: 'paint', label: '▧ PAINT', hint: 'click a room to repaint its deck' },
    { id: 'move', label: '✥ MOVE', hint: 'drag a room to relocate it' },
    { id: 'reclaim', label: '⌫ RECLAIM', hint: 'click a room to tear it down' },
  ];

  let opts = null, station = null, unsub = null;
  let root, cv, ctx, tip, hintEl, dpr = 1;
  let raf = 0, running = false;
  let cache = null, bakeDirty = true;

  // camera: screen = world*zoom + pan   (world = bake-pixel space, 1 tile = TILE px)
  let zoom = 2, panX = 0, panY = 0;
  const MINZ = 0.4, MAXZ = 6;

  // interaction state
  let tool = 'room', kind = 'hab', style = 'cobalt', hallWidth = 2;
  let drag = null, hoverRoomId = null, lastClient = { x: 0, y: 0 }, spaceHeld = false;
  let stars = [];

  const T = () => (station ? station.TILE : 12);

  /* ---------- lifecycle ---------- */
  function init(o) { opts = o; }

  function open() {
    if (running) return;
    station = opts.getStation();
    if (!station) return;
    spaceHeld = false; drag = null;        // never inherit a latched pan/drag from a prior session
    buildDOM();
    if (opts.world && opts.world.stop) opts.world.stop();       // freeze the live sim
    document.body.classList.add('refit-on');
    unsub = station.onChange(() => { bakeDirty = true; });
    bakeDirty = true;
    if (!stars.length) seedStars();
    resize();
    fitCamera();
    running = true;
    if (typeof SFX !== 'undefined') SFX.open();
    raf = requestAnimationFrame(frame);
  }

  function close() {
    if (!running) return;
    running = false;
    if (raf) cancelAnimationFrame(raf), raf = 0;
    clearTimeout(tipTimer); tipTimer = 0;
    if (unsub) unsub(), unsub = null;
    document.body.classList.remove('refit-on');
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = cv = ctx = tip = hintEl = null;
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    if (typeof SFX !== 'undefined') SFX.close();
    if (opts.persist) opts.persist();
    if (opts.world && opts.world.start) opts.world.start();     // resume the live sim
    if (opts.onClose) opts.onClose();
  }

  const toggle = () => (running ? close() : open());
  const isOpen = () => running;

  /* ---------- DOM ---------- */
  function buildDOM() {
    root = document.createElement('div');
    root.className = 'refit-overlay';
    root.innerHTML = `
      <canvas class="refit-canvas"></canvas>
      <div class="refit-top">
        <span class="refit-title">▮ REFIT MODE</span>
        <span class="refit-sub" id="refit-sub">STATION ARCHITECT</span>
        <span class="refit-spacer"></span>
        <button class="bb sm" id="refit-undo" title="undo (Ctrl+Z)">↶ UNDO</button>
        <button class="bb sm" id="refit-redo" title="redo (Ctrl+Shift+Z)">↷ REDO</button>
        <button class="bb sm" id="refit-fit" title="frame the station">⊹ FIT</button>
        <button class="bb sm danger" id="refit-done" title="exit build mode (Esc)">✓ DONE</button>
      </div>
      <div class="refit-dock">
        <div class="refit-tools" id="refit-tools"></div>
        <div class="refit-palette" id="refit-palette"></div>
        <div class="refit-hint" id="refit-hint"></div>
      </div>
      <div class="refit-tip" id="refit-tip"></div>`;
    document.body.appendChild(root);
    cv = root.querySelector('.refit-canvas');
    ctx = cv.getContext('2d');
    tip = root.querySelector('#refit-tip');
    hintEl = root.querySelector('#refit-hint');

    const tools = root.querySelector('#refit-tools');
    TOOLS.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'bb refit-tool' + (t.id === tool ? ' active' : '');
      btn.dataset.tool = t.id; btn.textContent = t.label;
      btn.onclick = () => selectTool(t.id);
      tools.appendChild(btn);
    });
    renderPalette();

    root.querySelector('#refit-done').onclick = close;
    root.querySelector('#refit-fit').onclick = () => { fitCamera(); };
    root.querySelector('#refit-undo').onclick = () => { if (station.undo().ok) sfx('click'); else sfx('bad'); };
    root.querySelector('#refit-redo').onclick = () => { if (station.redo().ok) sfx('click'); else sfx('bad'); };

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointerleave', () => { hoverRoomId = null; if (!drag) hideTip(); });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    setHint();
  }

  function renderPalette() {
    const pal = root.querySelector('#refit-palette');
    if (!pal) return;
    pal.innerHTML = '';
    if (tool === 'room') {
      station.KIND_ORDER.forEach(k => {
        const b = document.createElement('button');
        b.className = 'bb sm refit-kind' + (k === kind ? ' active' : '');
        b.textContent = station.ROOM_KINDS[k].label;
        b.onclick = () => { kind = k; renderPalette(); setHint(); sfx('click'); };
        pal.appendChild(b);
      });
    } else if (tool === 'hall') {
      [1, 2, 3].forEach(w => {
        const b = document.createElement('button');
        b.className = 'bb sm refit-kind' + (w === hallWidth ? ' active' : '');
        b.textContent = 'W' + w;
        b.onclick = () => { hallWidth = w; renderPalette(); sfx('click'); };
        pal.appendChild(b);
      });
    } else if (tool === 'paint') {
      Object.keys(station.FLOOR_STYLES).forEach(sid => {
        const b = document.createElement('button');
        b.className = 'refit-swatch' + (sid === style ? ' active' : '');
        b.style.background = station.FLOOR_STYLES[sid].base;
        b.title = station.FLOOR_STYLES[sid].label;
        b.onclick = () => { style = sid; renderPalette(); sfx('click'); };
        pal.appendChild(b);
      });
    }
  }

  function selectTool(id) {
    tool = id; drag = null; hideTip();
    root.querySelectorAll('.refit-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === id));
    renderPalette(); setHint(); sfx('click');
  }

  function setHint(msg) {
    if (!hintEl) return;
    const t = TOOLS.find(x => x.id === tool);
    hintEl.textContent = msg || (t ? t.hint : '') + '  ·  wheel = zoom · space-drag = pan';
  }

  /* ---------- camera + sizing ---------- */
  function resize() {
    if (!cv) return;
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(cv.clientWidth * dpr));
    cv.height = Math.max(1, Math.round(cv.clientHeight * dpr));
  }
  function seedStars() {
    stars = [];
    for (let i = 0; i < 120; i++) stars.push({ x: Math.random(), y: Math.random(), r: Math.random() < 0.85 ? 1 : 2, ph: Math.random() * 10 });
  }
  function fitCamera() {
    const b = station.bounds(), t = T();
    const wx1 = b.minTx * t, wy1 = b.minTy * t, wx2 = (b.maxTx + 1) * t, wy2 = (b.maxTy + 1) * t;
    const ww = (wx2 - wx1) + 8 * t, wh = (wy2 - wy1) + 8 * t;
    zoom = clamp(Math.min(cv.width / ww, cv.height / wh), MINZ, MAXZ);
    panX = cv.width / 2 - (wx1 + wx2) / 2 * zoom;
    panY = cv.height / 2 - (wy1 + wy2) / 2 * zoom;
  }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  // client → canvas backing px
  function toCanvas(ev) {
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
  }
  function toWorldTile(ev) {
    const c = toCanvas(ev), t = T();
    return { tx: Math.floor(((c.x - panX) / zoom) / t), ty: Math.floor(((c.y - panY) / zoom) / t) };
  }

  /* ---------- pointer interaction ---------- */
  function panTrigger(ev) { return tool === 'pan' || spaceHeld || ev.button === 1 || ev.button === 2; }

  function onDown(ev) {
    lastClient = { x: ev.clientX, y: ev.clientY };
    try { cv.setPointerCapture(ev.pointerId); } catch (e) {}
    if (panTrigger(ev)) { drag = { mode: 'pan', sx: toCanvas(ev).x, sy: toCanvas(ev).y }; return; }
    if (ev.button !== 0) return;
    const w = toWorldTile(ev);
    if (tool === 'move') {
      const id = station.roomAt(w.tx, w.ty);
      if (!id) { flashTip(ev, 'nothing to move here'); return; }
      drag = { mode: 'move', roomId: id, start: w, cur: w, moved: false };
    } else if (tool === 'paint' || tool === 'reclaim') {
      drag = { mode: 'click', start: w, cur: w, moved: false };
    } else { // room | hall
      drag = { mode: 'draw', start: w, cur: w, moved: false };
    }
  }

  function onMove(ev) {
    lastClient = { x: ev.clientX, y: ev.clientY };
    if (drag && drag.mode === 'pan') {
      const c = toCanvas(ev);
      panX += c.x - drag.sx; panY += c.y - drag.sy; drag.sx = c.x; drag.sy = c.y;
      return;
    }
    const w = toWorldTile(ev);
    if (drag) {
      if (w.tx !== drag.cur.tx || w.ty !== drag.cur.ty) drag.moved = true;
      drag.cur = w;
    } else {
      hoverRoomId = station.roomAt(w.tx, w.ty);
    }
  }

  function onUp(ev) {
    try { cv.releasePointerCapture(ev.pointerId); } catch (e) {}
    if (!drag) return;
    const d = drag; drag = null;
    if (d.mode === 'pan') return;
    if (d.mode === 'draw') return commitDraw(d, ev);
    if (d.mode === 'move') return commitMove(d, ev);
    if (d.mode === 'click') return commitClick(d, ev);
  }

  function commitDraw(d, ev) {
    const rect = (tool === 'hall') ? laneRect(d.start, d.cur) : norm(d.start, d.cur);
    const res = (tool === 'hall')
      ? station.placeHallway({ rect })
      : station.addRoom({ kind, rect });
    feedback(res, ev, tool === 'hall' ? 'hallway run' : 'room placed');
  }
  function commitMove(d, ev) {
    const dx = d.cur.tx - d.start.tx, dy = d.cur.ty - d.start.ty;
    if (!dx && !dy) { hideTip(); return; }
    feedback(station.moveRoom(d.roomId, dx, dy), ev, 'relocated');
  }
  function commitClick(d, ev) {
    const id = station.roomAt(d.cur.tx, d.cur.ty);
    if (!id) return;
    if (tool === 'paint') feedback(station.setFloor(id, style), ev, 'repainted');
    else feedback(station.removeRoom(id), ev, 'reclaimed');
  }
  function feedback(res, ev, okMsg) {
    if (res && res.ok) { sfx('click'); flashTip(ev, okMsg, true); }
    else { sfx('bad'); flashTip(ev, (res && res.msg) || 'blocked'); }
  }

  function onWheel(ev) {
    ev.preventDefault();
    const c = toCanvas(ev), t = T();
    const wx = (c.x - panX) / zoom, wy = (c.y - panY) / zoom;
    zoom = clamp(zoom * Math.exp(-ev.deltaY * 0.0015), MINZ, MAXZ);
    panX = c.x - wx * zoom; panY = c.y - wy * zoom;
  }

  function onKey(ev) {
    const a = ev.target;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    if (ev.key === ' ') { ev.preventDefault(); spaceHeld = true; return; }
    if (ev.key === 'Escape') return close();
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      const r = ev.shiftKey ? station.redo() : station.undo();
      sfx(r.ok ? 'click' : 'bad'); return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); sfx(station.redo().ok ? 'click' : 'bad'); return; }
    const map = { '1': 'room', '2': 'hall', '3': 'paint', '4': 'move', '5': 'reclaim' };
    if (map[ev.key]) selectTool(map[ev.key]);
  }
  function onKeyUp(ev) { if (ev.key === ' ') spaceHeld = false; }

  /* ---------- geometry helpers (world tiles) ---------- */
  function norm(a, b) { return { x1: Math.min(a.tx, b.tx), y1: Math.min(a.ty, b.ty), x2: Math.max(a.tx, b.tx), y2: Math.max(a.ty, b.ty) }; }
  function laneRect(a, b) {
    const dx = b.tx - a.tx, dy = b.ty - a.ty, w = hallWidth - 1;
    if (Math.abs(dx) >= Math.abs(dy)) return { x1: Math.min(a.tx, b.tx), y1: a.ty, x2: Math.max(a.tx, b.tx), y2: a.ty + w };
    return { x1: a.tx, y1: Math.min(a.ty, b.ty), x2: a.tx + w, y2: Math.max(a.ty, b.ty) };
  }
  function ghostInfo() {
    if (!drag || (drag.mode !== 'draw' && drag.mode !== 'move')) return null;
    if (drag.mode === 'draw') {
      const rect = (tool === 'hall') ? laneRect(drag.start, drag.cur) : norm(drag.start, drag.cur);
      const v = (tool === 'hall') ? station.canPlaceHallway([rect]) : station.canPlaceRoom([rect], kind);
      return { rects: [rect], v };
    }
    // move
    const rm = station.roomById(drag.roomId); if (!rm) return null;
    const dx = drag.cur.tx - drag.start.tx, dy = drag.cur.ty - drag.start.ty;
    const rects = rm.rects.map(r => ({ x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy }));
    const v = rm.kind === 'corridor' ? station.canPlaceHallway(rects, rm.id) : station.canPlaceRoom(rects, rm.kind, rm.id);
    return { rects, v, move: true };
  }

  /* ---------- render loop ---------- */
  function rebake() {
    cache = StationBake.bake(station.projectGeometry());
    bakeDirty = false;
  }

  function frame(now) {
    if (!running) return;
    if (bakeDirty || !cache) rebake();
    const t = T();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#04050a'; ctx.fillRect(0, 0, cv.width, cv.height);
    // starfield (screen space)
    for (const s of stars) {
      const tw = 0.3 + 0.6 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph));
      ctx.fillStyle = 'rgba(170,195,230,' + tw + ')';
      ctx.fillRect((s.x * cv.width + now / 1000 * 6) % cv.width, s.y * cv.height, s.r, s.r);
    }

    ctx.setTransform(zoom, 0, 0, zoom, panX, panY);
    ctx.imageSmoothingEnabled = false;
    const ox = cache.origin.tx * t, oy = cache.origin.ty * t;
    ctx.drawImage(cache.baseCv, ox, oy);
    drawGrid(t);
    ctx.drawImage(cache.lightCv, ox, oy);
    drawGlows(now);
    drawHover(t);
    drawGhost(t, now);

    raf = requestAnimationFrame(frame);
  }

  function drawGrid(t) {
    // faint cyan blueprint grid across the visible world, brighter inside the footprint
    const x0 = (-panX) / zoom, y0 = (-panY) / zoom;
    const x1 = (cv.width - panX) / zoom, y1 = (cv.height - panY) / zoom;
    const tx0 = Math.floor(x0 / t) - 1, ty0 = Math.floor(y0 / t) - 1;
    const tx1 = Math.ceil(x1 / t) + 1, ty1 = Math.ceil(y1 / t) + 1;
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = 'rgba(120,200,255,0.10)';
    ctx.beginPath();
    for (let gx = tx0; gx <= tx1; gx++) { ctx.moveTo(gx * t, y0); ctx.lineTo(gx * t, y1); }
    for (let gy = ty0; gy <= ty1; gy++) { ctx.moveTo(x0, gy * t); ctx.lineTo(x1, gy * t); }
    ctx.stroke();
  }

  function drawGlows(now) {
    if (!cache.flickers) return;
    const t = T(), ox = cache.origin.tx * t, oy = cache.origin.ty * t;
    ctx.globalCompositeOperation = 'lighter';
    for (const f of cache.flickers) {
      const a = Math.max(0, 0.08 * (0.55 + 0.45 * Math.sin(now / 210 + f.x) * Math.sin(now / 83 + f.y)));
      const g = ctx.createRadialGradient(ox + f.x, oy + f.y, 1, ox + f.x, oy + f.y, f.r * 0.7);
      g.addColorStop(0, 'rgba(240,230,206,' + a + ')'); g.addColorStop(1, 'rgba(240,230,206,0)');
      ctx.fillStyle = g; ctx.fillRect(ox + f.x - f.r * 0.7, oy + f.y - f.r * 0.7, f.r * 1.4, f.r * 1.4);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawHover(t) {
    if (drag) return;
    if (tool !== 'move' && tool !== 'reclaim' && tool !== 'paint') return;
    if (!hoverRoomId) return;
    const rm = station.roomById(hoverRoomId); if (!rm) return;
    ctx.lineWidth = 1.5 / zoom;
    ctx.strokeStyle = tool === 'reclaim' ? 'rgba(255,92,77,0.9)' : 'rgba(120,220,255,0.9)';
    for (const r of rm.rects) ctx.strokeRect(r.x1 * t + 1, r.y1 * t + 1, (r.x2 - r.x1 + 1) * t - 2, (r.y2 - r.y1 + 1) * t - 2);
  }

  function drawGhost(t, now) {
    const g = ghostInfo();
    if (!g) return;
    const ok = g.v && g.v.ok;
    const fill = ok ? 'rgba(80,255,140,0.16)' : 'rgba(255,90,80,0.18)';
    const line = ok ? 'rgba(120,255,170,0.95)' : 'rgba(255,120,110,0.95)';
    ctx.lineWidth = 1.5 / zoom;
    for (const r of g.rects) {
      const X = r.x1 * t, Y = r.y1 * t, Wd = (r.x2 - r.x1 + 1) * t, Hd = (r.y2 - r.y1 + 1) * t;
      ctx.fillStyle = fill; ctx.fillRect(X, Y, Wd, Hd);
      ctx.strokeStyle = line; ctx.strokeRect(X + 0.5 / zoom, Y + 0.5 / zoom, Wd - 1 / zoom, Hd - 1 / zoom);
    }
    // size + validity readout at the cursor
    const r0 = g.rects[0];
    const w = r0.x2 - r0.x1 + 1, h = r0.y2 - r0.y1 + 1;
    const label = ok ? (w + '×' + h) : ((g.v && g.v.msg) || 'blocked');
    showTip(label, ok);
  }

  /* ---------- tooltip ---------- */
  function showTip(text, ok) {
    if (!tip) return;
    tip.textContent = text;
    tip.classList.toggle('ok', !!ok);
    tip.classList.toggle('bad', !ok);
    tip.style.display = 'block';
    tip.style.left = (lastClient.x + 16) + 'px';
    tip.style.top = (lastClient.y + 14) + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }
  let tipTimer = 0;
  function flashTip(ev, text, ok) {
    lastClient = { x: ev.clientX, y: ev.clientY };
    showTip(text, ok); clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, 1100);
  }

  function sfx(n) { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); }

  return { init, open, close, toggle, isOpen };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Build;
