/* STARNET — build.js : the diegetic full-screen REFIT (build) mode.

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
    { id: 'room', key: '1', label: '▦ ROOM', hint: 'drag on the grid to place a room', cursor: 'crosshair' },
    { id: 'hall', key: '2', label: '═ HALLWAY', hint: 'drag along an axis to run a corridor — any length', cursor: 'crosshair' },
    { id: 'paint', key: '3', label: '▧ PAINT', hint: 'drag to paint deck tiles · click a room to fill it', cursor: 'cell' },
    { id: 'move', key: '4', label: '✥ MOVE', hint: 'drag a room to relocate it', cursor: 'move' },
    { id: 'reclaim', key: '5', label: '⌫ RECLAIM', hint: 'click a room or prop to tear it down (UNDO restores it)', cursor: 'not-allowed' },
    { id: 'prop', key: '6', label: '⚇ PROP', hint: 'click to place furniture · agents walk around it', cursor: 'crosshair' },
    { id: 'belt', key: '7', label: '⇶ BELT', hint: 'drag to lay a conveyor — boxes flow the way you drag', cursor: 'crosshair' },
  ];
  const SEEN_KEY = 'starnet.refit.seen';

  let opts = null, station = null, unsub = null;
  let root, cv, ctx, tip, hintEl, undoBtn, redoBtn, propCard, dpr = 1, ro = null;
  let raf = 0, running = false;
  let cache = null, cacheGeo = null, bakeDirty = true, bakeDirtyRects = null, valPlan = null;   // valPlan = live RoutingPlan (cost-safety ghosts)
  const flashes = [];   // {rects, t0, bad} place/delete confirmations
  // short human labels for the routing-validation overlay (cost-safety: surfaced before any paid run)
  const VAL_LABEL = { ORPHAN_SOURCE: 'NO BELT', ORPHAN_BAY: 'NO BELT', DEAD_BAY: 'UNREACHABLE', CYCLE: 'LOOP!', FILTER_NO_DEFAULT: 'NO DEFAULT', DUP_AGENT: 'DUP AGENT', UNBOUND_BAY: 'NO AGENT' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // camera: screen = world*zoom + pan   (world = bake-pixel space, 1 tile = TILE px)
  let zoom = 2, panX = 0, panY = 0;
  const MINZ = 0.4, MAXZ = 6;

  // interaction state
  let tool = 'room', kind = 'hab', style = 'cobalt', hallWidth = 2, propType = 'desk', propCat = 'workstation', propTier = 'functional';
  let drag = null, hoverRoomId = null, hoverPropId = null, lastClient = { x: 0, y: 0 }, spaceHeld = false;
  let stars = [];
  let convey = null, lastFrameTs = 0;   // editor conveyor sim (boxes flow live as you build)
  let propThumbs = [], lastThumbTs = 0; // visual prop palette: live animated preview tiles + redraw throttle

  const T = () => (station ? station.TILE : 12);

  /* ---------- lifecycle ---------- */
  function init(o) { opts = o; }

  function open() {
    if (running) return;
    station = opts.getStation();
    if (!station) return;
    spaceHeld = false; drag = null; flashes.length = 0;   // never inherit latched state from a prior session
    buildDOM();
    if (opts.world && opts.world.stop) opts.world.stop();       // freeze the live sim
    document.body.classList.add('refit-on');
    updateSafetyClearance();
    unsub = station.onChange(p => {
      bakeDirty = true;
      const rects = p && p.dirtyRects;
      bakeDirtyRects = bakeDirtyRects && rects ? bakeDirtyRects.concat(rects) : (rects || bakeDirtyRects);
      updateUndoRedo();
    });
    bakeDirty = true; bakeDirtyRects = null;
    convey = (typeof Conveyor !== 'undefined') ? Conveyor.create({ onDeliver: onBuildDeliver }) : null;
    lastFrameTs = 0;
    if (!stars.length) seedStars();
    resize();
    fitCamera();
    updateUndoRedo();
    if (!hasSeen()) showGuide();
    running = true;
    if (typeof SFX !== 'undefined') SFX.open();
    raf = requestAnimationFrame(frame);
  }

  function close() {
    if (!running) return;
    running = false;
    if (raf) cancelAnimationFrame(raf), raf = 0;
    clearTimeout(tipTimer); tipTimer = 0;
    if (convey) convey.reset(), convey = null;
    propThumbs.length = 0; lastThumbTs = 0;   // free the preview tiles' canvases
    if (unsub) unsub(), unsub = null;
    if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
    document.body.classList.remove('refit-on');
    document.body.style.removeProperty('--refit-dock-clearance');
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = cv = ctx = tip = hintEl = undoBtn = redoBtn = null;
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    if (typeof SFX !== 'undefined') SFX.close();
    if (opts.persist) opts.persist();
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('Station layout saved', 'good');
    if (opts.world && opts.world.refit) opts.world.refit();     // recenter the live world on the new build
    if (opts.world && opts.world.start) opts.world.start();     // resume the live sim with the new build
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
        <span class="refit-sub" id="refit-sub">DRAG TO PLACE ROOMS · RUN CORRIDORS · PAINT DECKS</span>
        <span class="refit-spacer"></span>
        <button class="bb sm" id="refit-help" title="how to build">? HELP</button>
        <button class="bb sm" id="refit-undo" title="undo (Ctrl+Z)">↶ UNDO</button>
        <button class="bb sm" id="refit-redo" title="redo (Ctrl+Shift+Z)">↷ REDO</button>
        <button class="bb sm" id="refit-fit" title="frame the station">⊹ FIT</button>
        <button class="bb sm" id="refit-test" title="send test work down your belts — watch it sort to the bays (no bot needed)">▸ TEST</button>
        <button class="bb sm refit-primary" id="refit-done" title="finish + save (Esc)">✓ DONE</button>
      </div>
      <div class="refit-dock" role="toolbar" aria-label="Refit mode controls">
        <div class="refit-dock-section refit-mode-section">
          <div class="refit-section-label">MODE</div>
          <div class="refit-tools" id="refit-tools"></div>
        </div>
        <div class="refit-dock-section refit-option-section" id="refit-option-section">
          <div class="refit-section-label" id="refit-palette-label">OPTIONS</div>
          <div class="refit-palette" id="refit-palette"></div>
        </div>
        <div class="refit-hint" id="refit-hint"></div>
      </div>
      <div class="refit-tip" id="refit-tip"></div>
      <div class="refit-propcard" id="refit-propcard" role="tooltip"></div>`;
    document.body.appendChild(root);
    cv = root.querySelector('.refit-canvas');
    ctx = cv.getContext('2d');
    tip = root.querySelector('#refit-tip');
    propCard = root.querySelector('#refit-propcard');
    hintEl = root.querySelector('#refit-hint');
    undoBtn = root.querySelector('#refit-undo');
    redoBtn = root.querySelector('#refit-redo');

    const tools = root.querySelector('#refit-tools');
    TOOLS.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'bb refit-tool' + (t.id === tool ? ' active' : '');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', t.id === tool ? 'true' : 'false');
      btn.dataset.tool = t.id; btn.innerHTML = t.label + ' <span class="refit-key">' + t.key + '</span>';
      btn.title = t.hint + '  (' + t.key + ')';
      btn.onclick = () => selectTool(t.id);
      tools.appendChild(btn);
    });
    renderPalette();
    setCursor();

    root.querySelector('#refit-done').onclick = close;
    root.querySelector('#refit-help').onclick = showGuide;
    root.querySelector('#refit-fit').onclick = () => { fitCamera(); };
    root.querySelector('#refit-test').onclick = (e) => sendTestBoxes(e);
    undoBtn.onclick = () => { if (station.undo().ok) sfx('click'); else sfx('bad'); };
    redoBtn.onclick = () => { if (station.redo().ok) sfx('click'); else sfx('bad'); };

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    cv.addEventListener('pointerleave', () => { hoverRoomId = null; hoverPropId = null; if (!drag) hideTip(); hidePropCard(); });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    try { ro = new ResizeObserver(() => { resize(); }); ro.observe(cv); } catch (e) {}
    setHint();
  }

  /* ---------- prop palette taxonomy ----------
     Props are split into two TIERS (functional vs cosmetic) carried on each CATALOG entry, then grouped by
     `cat` within the tier. This is the "clean area for the stuff that actually does something" split. */
  const TIER_ORDER = ['functional', 'cosmetic'];
  const TIER_LABEL = { functional: '⚙ SYSTEMS', cosmetic: '✦ DECOR' };   // display names; the internal tier keys stay functional/cosmetic
  const CAT_LABEL = {
    workstation: 'WORKSTATIONS', workflow: 'WORKFLOW', capability: 'CAPABILITY', isolation: 'ISOLATION',
    screens: 'SCREENS', lab: 'LAB', storage: 'STORAGE', comms: 'COMMS', lounge: 'LOUNGE', decor: 'DECOR',
  };
  // the agent-assignable workstation types — the 'computer' props the agent walks to + sits at (matches
  // world.js isWorkstationProp / deskPropFor seating + the CATALOG seat:true set). These open the picker on place/click.
  const WORKSTATION_TYPES = { desk: 1, desk2: 1, console: 1, consoleL: 1, pixelrig: 1, bench: 1 };
  const catalog = () => (typeof PropSprites !== 'undefined') ? PropSprites.CATALOG : [];
  // the ordered list of category ids that belong to a tier (first-appearance order in the catalog)
  function catsForTier(tier) {
    const out = [], seen = {};
    for (const c of catalog()) { if ((c.tier || 'cosmetic') !== tier) continue; if (!seen[c.cat]) { seen[c.cat] = 1; out.push(c.cat); } }
    return out;
  }
  const agentLabel = aid => {
    const list = (opts && typeof opts.agents === 'function' && opts.agents()) || [];
    const a = list.find(x => x.id === aid);
    return a ? (a.name || a.id) : aid;
  };

  function renderPalette() {
    const pal = root.querySelector('#refit-palette');
    if (!pal) return;
    const section = root.querySelector('#refit-option-section');
    const label = root.querySelector('#refit-palette-label');
    let paletteLabel = '';
    pal.innerHTML = '';
    propThumbs.length = 0;   // drop any preview tiles from a prior render (they're rebuilt below for the prop tool)
    if (tool === 'room') {
      paletteLabel = 'ROOM TYPE';
      station.KIND_ORDER.forEach(k => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bb sm refit-kind' + (k === kind ? ' active' : '');
        b.setAttribute('aria-pressed', k === kind ? 'true' : 'false');
        b.textContent = station.ROOM_KINDS[k].label;
        b.onclick = () => { kind = k; renderPalette(); setHint(); sfx('click'); };
        pal.appendChild(b);
      });
    } else if (tool === 'hall') {
      paletteLabel = 'HALL WIDTH';
      [1, 2, 3].forEach(w => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bb sm refit-kind' + (w === hallWidth ? ' active' : '');
        b.setAttribute('aria-pressed', w === hallWidth ? 'true' : 'false');
        b.textContent = 'W' + w;
        b.onclick = () => { hallWidth = w; renderPalette(); sfx('click'); };
        pal.appendChild(b);
      });
    } else if (tool === 'prop') {
      paletteLabel = 'PROPS';
      const CATS = (typeof PropSprites !== 'undefined') ? PropSprites.CATS : {};
      if (TIER_ORDER.indexOf(propTier) < 0) propTier = 'functional';
      let cats = catsForTier(propTier);
      if (cats.indexOf(propCat) < 0) { propCat = cats[0]; if (CATS[propCat] && CATS[propCat][0]) propType = CATS[propCat][0].id; }
      // row 0 — the TIER toggle: a clear, hard split between props that DO something and props that are just looks
      const tierRow = document.createElement('div'); tierRow.className = 'refit-tiers';
      tierRow.setAttribute('aria-label', 'Prop tiers');
      TIER_ORDER.forEach(t => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bb sm refit-tier refit-tier-' + t + (t === propTier ? ' active' : '');
        b.setAttribute('aria-pressed', t === propTier ? 'true' : 'false');
        b.textContent = TIER_LABEL[t];
        b.onclick = () => { propTier = t; const cs = catsForTier(t); propCat = cs[0]; if (CATS[propCat] && CATS[propCat][0]) propType = CATS[propCat][0].id; hidePropCard(); renderPalette(); setHint(); sfx('click'); };
        tierRow.appendChild(b);
      });
      pal.appendChild(tierRow);
      // row 1 — category tabs WITHIN the chosen tier (clean, specific names — WORKSTATIONS · WORKFLOW · …)
      const catRow = document.createElement('div'); catRow.className = 'refit-propcats';
      catRow.setAttribute('aria-label', 'Prop categories');
      cats.forEach(g => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bb sm refit-propcat' + (g === propCat ? ' active' : '');
        b.dataset.cat = g;   // lets the tutorial light the exact category tab a step needs
        b.setAttribute('aria-pressed', g === propCat ? 'true' : 'false');
        b.textContent = CAT_LABEL[g] || g.toUpperCase();
        b.onclick = () => { propCat = g; if (CATS[g] && CATS[g][0]) propType = CATS[g][0].id; hidePropCard(); renderPalette(); setHint(); sfx('click'); };
        catRow.appendChild(b);
      });
      pal.appendChild(catRow);
      // row 2 — a scrollable gallery of LIVE previews: each tile draws the real animated sprite, not just its name
      const grid = document.createElement('div'); grid.className = 'refit-propgrid';
      grid.setAttribute('aria-label', 'Props');
      (CATS[propCat] || []).forEach(c => grid.appendChild(propTile(c)));
      pal.appendChild(grid);
      try { paintThumbs(performance.now()); } catch (e) {}   // first frame now, so the gallery isn't blank for a beat
    } else if (tool === 'paint') {
      paletteLabel = 'DECK PAINT';
      Object.keys(station.FLOOR_STYLES).forEach(sid => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'refit-swatch' + (sid === style ? ' active' : '');
        b.setAttribute('aria-pressed', sid === style ? 'true' : 'false');
        b.appendChild(swatchCanvas(station.FLOOR_STYLES[sid].base));
        b.title = station.FLOOR_STYLES[sid].label;
        b.onclick = () => { style = sid; renderPalette(); sfx('click'); };
        pal.appendChild(b);
      });
    }
    if (label) label.textContent = paletteLabel || 'OPTIONS';
    if (section) section.classList.toggle('is-empty', !pal.children.length);
    updateSafetyClearance();
  }

  function updateSafetyClearance() {
    if (!root || !document.body) return;
    const dock = root.querySelector('.refit-dock');
    if (!dock) return;
    const r = dock.getBoundingClientRect();
    const gap = 12;
    const clearance = Math.ceil(r.height + Math.max(0, window.innerHeight - r.bottom) + gap);
    document.body.style.setProperty('--refit-dock-clearance', Math.max(58, clearance) + 'px');
  }

  /* ---------- visual prop palette: a scrollable gallery of LIVE animated previews ----------
     Each tile carries its own mini-canvas; paintThumbs() blits the real PropSprites art into it every
     few frames (driven by the main loop) so the screens/LEDs animate exactly like the placed prop. */
  const THUMB_PAD = 7;   // native-px halo so art that overflows the footprint (monitors, masts, shadows) isn't clipped
  function propTile(c) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'refit-proptile' + (c.tier === 'functional' ? ' fn' : '') + (c.id === propType ? ' active' : '');
    b.dataset.prop = c.id;   // lets the tutorial light a specific gear tile by id
    b.setAttribute('aria-pressed', c.id === propType ? 'true' : 'false');
    const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(c.id) : null;
    b.title = c.label + ' · ' + c.w + '×' + c.h + (grant ? ' · grants ' + grant : '');   // native fallback; the rich Fallout-style card is the hover surface
    b.onclick = () => { propType = c.id; renderPalette(); setHint(); sfx('click'); };
    b.onmouseenter = (e) => showPropCard(c, null, e.clientX, e.clientY);   // "what does this do?" card
    b.onmouseleave = hidePropCard;

    const DW = 76, DH = 50, SS = Math.max(2, Math.min(3, window.devicePixelRatio || 1));  // supersample so even wide props stay crisp
    const cvEl = document.createElement('canvas');
    cvEl.className = 'refit-proptile-cv';
    cvEl.style.width = DW + 'px'; cvEl.style.height = DH + 'px';
    cvEl.width = Math.round(DW * SS); cvEl.height = Math.round(DH * SS);

    const tile = (typeof PropSprites !== 'undefined') ? PropSprites.TILE : 12;
    const nativeW = c.w * tile + THUMB_PAD * 2, nativeH = c.h * tile + THUMB_PAD * 2;
    const off = document.createElement('canvas'); off.width = nativeW; off.height = nativeH;

    const lbl = document.createElement('span'); lbl.className = 'refit-proptile-lbl'; lbl.textContent = c.label;
    b.appendChild(cvEl); b.appendChild(lbl);
    if (grant) {   // capability prop — flag the POWER it grants so the gallery shows at a glance which props matter
      const g = document.createElement('span'); g.className = 'refit-proptile-grant'; g.textContent = grant; b.appendChild(g);
    } else if (c.blocks === false) {   // walkable decor marker (agents path THROUGH it) — matches the title hint
      const tag = document.createElement('span'); tag.className = 'refit-proptile-tag'; tag.textContent = '○'; b.appendChild(tag);
    }
    propThumbs.push({ id: c.id, w: c.w, h: c.h, off, octx: off.getContext('2d'), dctx: cvEl.getContext('2d'),
                      nativeW, nativeH, bw: cvEl.width, bh: cvEl.height });
    return b;
  }
  // draw every visible preview tile for time `now` (animated). Renders native → fit-blits with nearest-neighbour.
  function paintThumbs(now) {
    if (typeof PropSprites === 'undefined' || !propThumbs.length) return;
    for (const th of propThumbs) {
      const o = th.octx;
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.clearRect(0, 0, th.nativeW, th.nativeH);
      o.imageSmoothingEnabled = false;
      o.translate(THUMB_PAD, THUMB_PAD);
      PropSprites.setCtx(o); PropSprites.setNow(now);
      PropSprites.draw({ t: th.id, x: 0, y: 0, w: th.w, h: th.h }, true);   // work=true → screens read alive in the preview
      const d = th.dctx, s = Math.min(th.bw / th.nativeW, th.bh / th.nativeH);
      const dw = Math.round(th.nativeW * s), dh = Math.round(th.nativeH * s);
      d.setTransform(1, 0, 0, 1, 0, 0);
      d.clearRect(0, 0, th.bw, th.bh);
      d.imageSmoothingEnabled = false;
      d.drawImage(th.off, Math.round((th.bw - dw) / 2), Math.round((th.bh - dh) / 2), dw, dh);
    }
  }

  // a tiny textured deck sample (so the swatch reads like the baked floor, not a flat chip)
  function swatchCanvas(base) {
    const c = document.createElement('canvas'); c.width = 24; c.height = 20;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    x.fillStyle = base; x.fillRect(0, 0, 24, 20);
    x.fillStyle = U.shade(base, -0.3);
    for (let i = 0; i <= 24; i += 6) x.fillRect(i, 0, 1, 20);
    for (let j = 0; j <= 20; j += 6) x.fillRect(0, j, 24, 1);
    x.fillStyle = U.shade(base, 0.22); x.fillRect(1, 1, 1, 1); x.fillRect(7, 7, 1, 1); x.fillRect(13, 13, 1, 1);
    return c;
  }

  function selectTool(id) {
    tool = id; drag = null; hideTip(); hidePropCard();
    root.querySelectorAll('.refit-tool').forEach(b => {
      const active = b.dataset.tool === id;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    renderPalette(); setHint(); setCursor(); sfx('click');
  }

  function setHint(msg) {
    if (!hintEl) return;
    const t = TOOLS.find(x => x.id === tool);
    hintEl.textContent = msg || (t ? t.hint : '') + '  ·  wheel = zoom · space-drag = pan';
  }
  function setCursor() {
    if (!cv) return;
    const t = TOOLS.find(x => x.id === tool);
    cv.style.cursor = spaceHeld ? 'grab' : (t ? t.cursor : 'default');
  }
  function updateUndoRedo() {
    if (undoBtn) undoBtn.disabled = !station.canUndo();
    if (redoBtn) redoBtn.disabled = !station.canRedo();
  }

  /* ---------- first-use guide ---------- */
  function hasSeen() { try { return !!localStorage.getItem(SEEN_KEY); } catch (e) { return false; } }
  function markSeen() { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {} }
  function showGuide() {
    if (!root || root.querySelector('.refit-guide')) return;
    const g = document.createElement('div');
    g.className = 'refit-guide';
    g.innerHTML = `
      <div class="refit-guide-card">
        <h3>▮ BUILD YOUR STATION</h3>
        <ul>
          <li><b>Drag</b> on the grid to place a <b>ROOM</b>.</li>
          <li><b>Drag</b> along an axis to run a <b>HALLWAY</b> — any length.</li>
          <li>Rooms &amp; halls that <b>touch auto-connect</b> with a door.</li>
          <li><span class="g-ok">green</span> = ok · <span class="g-bad">red</span> = blocked (a tip says why).</li>
          <li><b>PAINT</b> decks, <b>MOVE</b> / <b>RECLAIM</b> rooms · <b>UNDO</b> anything.</li>
          <li>Your agent walks the rooms + corridors you build.</li>
          <li><b>BELT</b> (7) + <b>PROP ▸ LOGISTICS</b> (INTAKE · BAY · FILTER) wire work to your agents — the floor <b>IS</b> the routing. Hit <b>▸ TEST</b> to watch a box ride.</li>
        </ul>
        <button class="btn-sm refit-primary" id="refit-guide-go">▸ START BUILDING</button>
      </div>`;
    root.appendChild(g);
    const dismiss = () => { markSeen(); if (g.parentNode) g.parentNode.removeChild(g); };
    g.querySelector('#refit-guide-go').onclick = dismiss;
    g.addEventListener('click', e => { if (e.target === g) dismiss(); });
  }

  /* ---------- BAY agent-picker (Phase B4c): bind a docking bay to an agent — work that reaches it runs as
     that agent. Sourced from the app's agent list (opts.agents()) when present, plus a free-text agent id. */
  // is this prop a COMPUTER (PC)? — sourced from the station's CAP_PROP_MAP so the type list never drifts.
  const isPcProp = t => !!(station && typeof station.capForProp === 'function' && station.capForProp(t) === 'computer');
  function openBayPicker(bayId, ev) {
    if (!root || root.querySelector('.refit-bay-picker')) return;
    const p = station.propById(bayId); if (!p || !(p.t === 'bay' || isPcProp(p.t))) return;
    const isPc = isPcProp(p.t);
    const noun = isPc ? 'PC' : 'bay';
    const cur = p.agentId || '';
    const agents = (opts && typeof opts.agents === 'function' && opts.agents()) || [];
    const rows = agents.map(a => `<button type="button" class="bb sm bay-agent${a.id === cur ? ' active' : ''}" data-aid="${esc(a.id)}">${esc(a.name || a.id)}</button>`).join('');
    const g = document.createElement('div');
    g.className = 'refit-guide refit-bay-picker';
    g.innerHTML = `
      <div class="refit-guide-card">
        <h3>▮ ASSIGN AGENT TO ${isPc ? 'PC' : 'BAY'}</h3>
        ${isPc
          ? '<ul><li>This computer becomes the chosen agent\'s <b>dedicated PC</b> — its compute.</li><li><b>Every agent needs its own PC</b>; roommates can share one room, not one computer.</li></ul>'
          : '<ul><li>Work routed to this bay <b>runs as the chosen agent</b>.</li><li>A <b>FILTER</b> upstream sorts work to the right bay by content.</li></ul>'}
        ${agents.length ? '<div class="refit-bay-agents" style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 0">' + rows + '</div>' : ''}
        <input id="bay-aid" type="text" maxlength="40" placeholder="agent id — e.g. coder" value="${esc(cur)}"
          style="width:100%;box-sizing:border-box;margin:6px 0;padding:5px 7px;background:#0b0f0d;border:1px solid #2a3a32;color:#cfe;font:11px monospace;border-radius:3px" />
        <div style="display:flex;gap:6px;margin-top:6px">
          <button type="button" class="btn-sm refit-primary" id="bay-ok">▸ ASSIGN</button>
          <button type="button" class="btn-sm" id="bay-clear">UNBIND</button>
          <button type="button" class="btn-sm" id="bay-cancel">CANCEL</button>
        </div>
      </div>`;
    root.appendChild(g);
    const input = g.querySelector('#bay-aid');
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    g.querySelectorAll('.bay-agent').forEach(b => b.onclick = () => { input.value = b.dataset.aid; input.style.borderColor = '#2a3a32'; });
    g.querySelector('#bay-ok').onclick = () => {
      const res = station.assignPropAgent(bayId, input.value.trim());
      if (res && res.ok) { sfx('click'); flashTip(ev, res.agentId ? (noun + ' → ' + res.agentId) : (noun + ' unbound'), true); closeP(); }
      else { input.style.borderColor = '#ff6a5a'; sfx('bad'); }
    };
    g.querySelector('#bay-clear').onclick = () => { station.assignPropAgent(bayId, ''); sfx('click'); flashTip(ev, noun + ' unbound', true); closeP(); };
    g.querySelector('#bay-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
    try { input.focus(); input.select(); } catch (_) {}
  }

  /* ---------- WORKSTATION agent-picker: the desk/PC version of the BAY picker. A workstation carries an
     agentId exactly like a bay does (assignPropAgent is type-agnostic); world.js then seats THAT agent here, so
     when it's given a task it walks over and sits at this desk. The host/model is already chosen when the agent
     was created, so this is a single "pick an agent" step. Opens on place + on click (PROP_EDITABLE). */
  function openWorkstationPicker(propId, ev) {
    if (!root || root.querySelector('.refit-ws-picker')) return;
    const p = station.propById(propId); if (!p || !WORKSTATION_TYPES[p.t]) return;
    const cur = p.agentId || '';
    const agents = (opts && typeof opts.agents === 'function' && opts.agents()) || [];
    const rows = agents.map(a => `<button type="button" class="bb sm ws-agent${a.id === cur ? ' active' : ''}" data-aid="${esc(a.id)}">${esc(a.name || a.id)}${a.model ? ' <span class="ws-model">' + esc(a.model) + '</span>' : ''}</button>`).join('');
    const g = document.createElement('div');
    g.className = 'refit-guide refit-ws-picker';
    g.innerHTML = `
      <div class="refit-guide-card">
        <h3>▮ ASSIGN AGENT TO WORKSTATION</h3>
        <ul><li>The assigned agent <b>walks here and sits to work</b> whenever it gets a task.</li>
        <li>Just pick one of your active agents — its model/host was set when it was created.</li></ul>
        ${agents.length
          ? '<div class="refit-bay-agents" style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 0">' + rows + '</div>'
          : '<div style="color:#ffd34a;font:11px monospace;margin:6px 0">No active agents yet — summon one first, or type an id below.</div>'}
        <input id="ws-aid" type="text" maxlength="40" placeholder="agent id — e.g. coder" value="${esc(cur)}"
          style="width:100%;box-sizing:border-box;margin:6px 0;padding:5px 7px;background:#0b0f0d;border:1px solid #2a3a32;color:#cfe;font:11px monospace;border-radius:3px" />
        <div style="display:flex;gap:6px;margin-top:6px">
          <button type="button" class="btn-sm refit-primary" id="ws-ok">▸ ASSIGN</button>
          <button type="button" class="btn-sm" id="ws-clear">UNASSIGN</button>
          <button type="button" class="btn-sm" id="ws-cancel">CANCEL</button>
        </div>
      </div>`;
    root.appendChild(g);
    const input = g.querySelector('#ws-aid');
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    g.querySelectorAll('.ws-agent').forEach(b => b.onclick = () => { input.value = b.dataset.aid; input.style.borderColor = '#2a3a32'; });
    g.querySelector('#ws-ok').onclick = () => {
      const res = station.assignPropAgent(propId, input.value.trim());
      if (res && res.ok) { sfx('click'); flashTip(ev, res.agentId ? ('workstation → ' + res.agentId) : 'workstation cleared', true); closeP(); }
      else { input.style.borderColor = '#ff6a5a'; sfx('bad'); }
    };
    g.querySelector('#ws-clear').onclick = () => { station.assignPropAgent(propId, ''); sfx('click'); flashTip(ev, 'workstation cleared', true); closeP(); };
    g.querySelector('#ws-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
    try { input.focus(); input.select(); } catch (_) {}
  }

  /* ---------- FILTER/MERGER junction editor (Polish P1): make content-routing reachable from the UI.
     A FILTER needs routes (tag -> out-lane) + a default lane or it's non-deployable (FILTER_NO_DEFAULT);
     a MERGER just needs its buffer size K. Both call station.configureJunction. Opens on place/click. */
  const J_DIRV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
  const J_OPP = { E: 'W', W: 'E', S: 'N', N: 'S' };
  const J_LANES = ['E', 'S', 'W', 'N'];   // fixed order — mirrors pipeline.js / conveyor.js
  const J_ARROW = { E: '→ E', S: '↓ S', W: '← W', N: '↑ N' };
  // the out-lanes leaving this tile: neighbouring belts that don't flow back in (where work can exit)
  function junctionOutLanes(tx, ty) {
    const out = [];
    for (const d of J_LANES) { const v = J_DIRV[d], nb = station.beltAt(tx + v[0], ty + v[1]); if (nb && nb !== J_OPP[d]) out.push(d); }
    return out;
  }
  function openJunctionEditor(propId, ev) {
    if (!root || root.querySelector('.refit-junction-editor')) return;
    const p = station.propById(propId); if (!p || (p.t !== 'filter' && p.t !== 'merger')) return;
    const g = document.createElement('div');
    g.className = 'refit-guide refit-junction-editor';
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };

    if (p.t === 'merger') {
      const k = Math.max(2, p.bufferSize | 0 || 2);
      g.innerHTML = '<div class="refit-guide-card"><h3>▮ MERGER</h3>'
        + '<ul><li>Buffers <b>K</b> inbound boxes, then emits ONE combined box (a map-reduce barrier).</li></ul>'
        + '<label style="display:block;margin:6px 0;font:11px monospace;color:#cfe">combine K = '
        + '<input id="mrg-k" type="number" min="2" max="9" value="' + k + '" style="width:48px;margin-left:6px;background:#0b0f0d;border:1px solid #2a3a32;color:#cfe;font:11px monospace;padding:3px"/></label>'
        + '<div style="display:flex;gap:6px;margin-top:6px"><button type="button" class="btn-sm refit-primary" id="j-ok">▸ SET</button><button type="button" class="btn-sm" id="j-cancel">CANCEL</button></div></div>';
      root.appendChild(g);
      g.querySelector('#j-ok').onclick = () => {
        const v = Math.max(2, Math.min(9, parseInt(g.querySelector('#mrg-k').value, 10) || 2));
        const res = station.configureJunction(propId, { bufferSize: v });
        if (res && res.ok) { sfx('click'); flashTip(ev, 'merger K=' + v, true); } else { sfx('bad'); }
        closeP();
      };
    } else {
      const lanes = junctionOutLanes(p.x, p.y);
      const cur = { routes: (p.routes && typeof p.routes === 'object') ? Object.assign({}, p.routes) : {}, def: p.def || null };
      const selOf = tag => (tag === '__def__' ? cur.def : cur.routes[tag]);
      const ROWS = [['code', 'CODE'], ['research', 'RESEARCH'], ['__def__', 'EVERYTHING ELSE']];
      const rowHtml = ROWS.map(([tag, label]) => {
        const btns = lanes.length
          ? lanes.map(d => '<button type="button" class="bb sm lane-btn" data-tag="' + tag + '" data-dir="' + d + '"'
              + (selOf(tag) === d ? ' style="background:#2a4a3a;border-color:#5ad1b3"' : '') + '>' + J_ARROW[d] + '</button>').join('')
          : '<span style="color:#ff8a5a;font:10px monospace">lay belts OUT of this filter first</span>';
        return '<div style="display:flex;align-items:center;gap:5px;margin:3px 0"><span style="width:104px;font:10px monospace;color:#9fb">' + label + ' →</span>' + btns + '</div>';
      }).join('');
      g.innerHTML = '<div class="refit-guide-card"><h3>▮ FILTER — route by content</h3>'
        + '<ul><li>Each <b>kind</b> of work routes to the out-lane you pick; the rest take <b>EVERYTHING ELSE</b>.</li>'
        + '<li>Put a <b>BAY</b> on a lane to send that work to a specific agent.</li></ul>'
        + '<div class="refit-filter-rows">' + rowHtml + '</div>'
        + '<div style="display:flex;gap:6px;margin-top:8px"><button type="button" class="btn-sm refit-primary" id="j-ok">▸ SAVE ROUTES</button><button type="button" class="btn-sm" id="j-clear">CLEAR</button><button type="button" class="btn-sm" id="j-cancel">CANCEL</button></div></div>';
      root.appendChild(g);
      g.querySelectorAll('.lane-btn').forEach(b => b.onclick = () => {
        const tag = b.dataset.tag, dir = b.dataset.dir;
        if (tag === '__def__') cur.def = (cur.def === dir) ? null : dir;
        else if (cur.routes[tag] === dir) delete cur.routes[tag]; else cur.routes[tag] = dir;
        g.querySelectorAll('.lane-btn[data-tag="' + tag + '"]').forEach(x => {
          const on = selOf(tag) === x.dataset.dir;
          x.style.background = on ? '#2a4a3a' : ''; x.style.borderColor = on ? '#5ad1b3' : '';
        });
      });
      g.querySelector('#j-ok').onclick = () => {
        const res = station.configureJunction(propId, { routes: cur.routes, def: cur.def });
        if (res && res.ok) { sfx('click'); flashTip(ev, cur.def ? 'filter routes saved' : 'set a default lane', !!cur.def); if (cur.def) closeP(); }
        else { sfx('bad'); }
      };
      g.querySelector('#j-clear').onclick = () => { station.configureJunction(propId, null); sfx('click'); flashTip(ev, 'filter cleared', true); closeP(); };
    }
    g.querySelector('#j-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
  }

  /* ---------- CONNECTOR PORTAL editor: bind this gateway to ONE configured MCP server. The bound connectorId
     is what bayObjects emits for the bay, so the agent in this room gains that server's live tools. The list is
     the live /api/connectors set; a state dot mirrors the panel. Opens on place/click, like the junction editor. */
  function openConnectorEditor(propId, ev) {
    if (!root || root.querySelector('.refit-connector-editor')) return;
    const p = station.propById(propId); if (!p || p.t !== 'connector_portal') return;
    const g = document.createElement('div');
    g.className = 'refit-guide refit-connector-editor';
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    g.innerHTML = '<div class="refit-guide-card"><h3>▮ CONNECTOR PORTAL — bind an MCP server</h3>'
      + '<ul><li>This gateway grants its bay\'s agent the <b>live tools</b> of ONE configured connector.</li>'
      + '<li>Bind it below — the portal then rides that server\'s state and pulses when its tools fire.</li></ul>'
      + '<div class="refit-conn-rows" id="c-rows">loading…</div>'
      + '<div style="display:flex;gap:6px;margin-top:8px"><button type="button" class="btn-sm" id="c-unbind">✕ UNBIND</button><button type="button" class="btn-sm" id="c-cancel">CANCEL</button></div></div>';
    root.appendChild(g);
    const rowsEl = g.querySelector('#c-rows');
    const STATE_COL = { connected: '#41ff8a', ready: '#41ff8a', up: '#41ff8a', warming: '#ffd34a', offline: '#ffd34a', down: '#ffd34a', error: '#ff4a3d' };
    const bind = (id, label) => { const res = station.bindConnector(propId, id); if (res && res.ok) { sfx('click'); flashTip(ev, 'bound → ' + (label || id), true); closeP(); } else sfx('bad'); };
    g.querySelector('#c-unbind').onclick = () => { station.bindConnector(propId, ''); sfx('click'); flashTip(ev, 'portal unbound', true); closeP(); };
    g.querySelector('#c-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
    if (typeof fetch === 'undefined') { rowsEl.innerHTML = '<div class="refit-conn-note">no sidecar — can\'t list connectors here.</div>'; return; }
    fetch('/api/connectors').then(r => r.json()).then(j => {
      const list = (j && j.connectors) || [];
      if (!list.length) { rowsEl.innerHTML = '<div class="refit-conn-note">No MCP servers yet — add one in the <b>⇄ CONNECTORS</b> panel (bottom bar), then bind it here.</div>'; return; }
      rowsEl.innerHTML = list.map(c => {
        const sel = (c.id === p.connectorId), col = STATE_COL[c.state] || '#7a8a80';
        const meta = c.toolCount ? (c.toolCount + ' tool' + (c.toolCount === 1 ? '' : 's')) : (c.state || 'idle');
        return '<button type="button" class="bb sm conn-row' + (sel ? ' active' : '') + '" data-id="' + esc(c.id) + '" data-label="' + esc(c.label || c.id) + '">'
          + '<span class="conn-dot" style="color:' + col + '">●</span> ' + esc(c.label || c.id)
          + ' <span class="conn-meta">' + esc(meta) + '</span></button>';
      }).join('');
      rowsEl.querySelectorAll('.conn-row').forEach(b => b.onclick = () => bind(b.dataset.id, b.dataset.label));
    }).catch(() => { rowsEl.innerHTML = '<div class="refit-conn-note">sidecar offline — start it to bind a connector.</div>'; });
  }

  /* ---------- test run (Polish B): send work down your belts with NO bot connected, and watch it sort to the
     bays right here in REFIT — the build-time payoff + the first thing a tutorial points at. ---------- */
  function onBuildDeliver(bx) { pushFlash([{ x1: bx.x, y1: bx.y, x2: bx.x, y2: bx.y }], false); sfx('click'); }   // box finished — flash where it landed
  // the INTAKE's belt-adjacent tile (where a box spawns), or null if no INTAKE sits on a belt
  function intakeBeltTile() {
    const intake = station.props().find(p => p.t === 'intake');
    if (!intake) return null;
    const w = intake.w || 1, h = intake.h || 1;
    for (let yy = intake.y - 1; yy <= intake.y + h; yy++)
      for (let xx = intake.x - 1; xx <= intake.x + w; xx++)
        if (station.beltAt(xx, yy)) return { x: xx, y: yy };
    return null;
  }
  let _testN = 0;
  // fire one box per content tag at the INTAKE so you watch them SORT through your FILTERs to the right bays
  function sendTestBoxes(ev) {
    if (!convey) return;
    const t = intakeBeltTile();
    if (!t) { flashTip(ev, 'place an INTAKE on a belt first', false); sfx('bad'); return; }
    for (const tag of ['code', 'research', 'general']) convey.enqueueAt(t.x, t.y, { workitemId: 'test-' + (++_testN), tag, preview: 'test ' + tag });
    flashTip(ev, 'test work riding — watch it sort', true); sfx('click');
  }

  /* ---------- AIRLOCK door-state picker: cycle a room's SPATIAL seal (floor containment, NOT capability
     isolation). closed/jammed SEAL the room — its agent's BODY can't path in or out (a staging seal, the
     unmerged-branch metaphor); open = connected to trunk. Sealing does NOT change the agent's run/tools/caps
     — the BAY governs capability. */
  function openDoorPicker(propId, ev) {
    if (!root || root.querySelector('.refit-door-picker')) return;
    const p = station.propById(propId); if (!p || p.t !== 'airlock') return;
    const cur = p.door || 'open';
    const room = station.roomAt(p.x, p.y);
    const isTrunk = !!(room && typeof station.doc === 'function' && station.doc().meta.trunkRoomId === room);
    const STATES = [
      { id: 'closed', label: '▦ SEALED' },
      { id: 'open', label: '▢ OPEN' },
      { id: 'jammed', label: '✖ JAMMED' },
    ];
    const rows = STATES.map(s => `<button type="button" class="bb sm door-state${s.id === cur ? ' active' : ''}" data-st="${s.id}">${s.label}</button>`).join('');
    const g = document.createElement('div');
    g.className = 'refit-guide refit-door-picker';
    g.innerHTML = `
      <div class="refit-guide-card">
        <h3>▮ AIRLOCK — ROOM SEAL</h3>
        <ul><li>A <b>SEALED</b> room is contained on the floor — its agent’s body can’t path in or out (a staging seal, the unmerged-branch look).</li>
        <li><b>OPEN</b> = connected to the trunk hub · <b>JAMMED</b> = a merge conflict (sealed).</li>
        <li>A spatial seal — it doesn’t change what the agent’s run can do; its tools &amp; permissions come from its BAY.</li>
        ${isTrunk ? '<li><b>This is the trunk room</b> — it never seals (the integration hub).</li>' : ''}</ul>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin:6px 0">${rows}</div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button type="button" class="btn-sm" id="door-cancel">CANCEL</button>
        </div>
      </div>`;
    root.appendChild(g);
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    g.querySelectorAll('.door-state').forEach(b => b.onclick = () => {
      const res = station.setDoorState(propId, b.dataset.st);
      if (res && res.ok) { sfx('click'); flashTip(ev, 'airlock → ' + res.door, true); closeP(); }
      else sfx('bad');
    });
    g.querySelector('#door-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
  }

  /* ---------- camera + sizing ---------- */
  function resize() {
    if (!cv) return;
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(cv.clientWidth * dpr));
    cv.height = Math.max(1, Math.round(cv.clientHeight * dpr));
    updateSafetyClearance();
  }
  function seedStars() {
    stars = [];
    for (let i = 0; i < 110; i++) stars.push({ x: Math.random(), y: Math.random(), r: Math.random() < 0.85 ? 1 : 2, ph: Math.random() * 10 });
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
  function toCanvas(ev) {
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
  }
  function toWorldTile(ev) {
    const c = toCanvas(ev), t = T();
    return { tx: Math.floor(((c.x - panX) / zoom) / t), ty: Math.floor(((c.y - panY) / zoom) / t) };
  }

  /* ---------- pointer interaction ---------- */
  function panTrigger(ev) { return spaceHeld || ev.button === 1; }  // space-drag or middle-drag

  function onDown(ev) {
    lastClient = { x: ev.clientX, y: ev.clientY };
    hidePropCard();
    // right-button cancels an in-progress edit (and never starts one)
    if (ev.button === 2) { if (drag) { drag = null; hideTip(); } return; }
    try { cv.setPointerCapture(ev.pointerId); } catch (e) {}
    if (panTrigger(ev)) { drag = { mode: 'pan', sx: toCanvas(ev).x, sy: toCanvas(ev).y }; cv.style.cursor = 'grabbing'; return; }
    if (ev.button !== 0) return;
    const w = toWorldTile(ev);
    if (tool === 'belt') {
      drag = { mode: 'beltrun', start: w, cur: w, moved: false };
    } else if (tool === 'prop') {
      drag = { mode: 'propstamp', start: w, cur: w, moved: false };
    } else if (tool === 'move') {
      const pid = station.propAt(w.tx, w.ty);   // props sit on top of rooms — move them first
      if (pid) { drag = { mode: 'propmove', propId: pid, start: w, cur: w, moved: false }; return; }
      const id = station.roomAt(w.tx, w.ty);
      if (!id) { flashTip(ev, 'nothing to move here'); return; }
      drag = { mode: 'move', roomId: id, start: w, cur: w, moved: false };
    } else if (tool === 'paint') {
      const id = station.roomAt(w.tx, w.ty);
      if (!id) { flashTip(ev, 'nothing to paint here'); return; }
      drag = { mode: 'paint', roomId: id, start: w, cur: w, cells: new Set([w.tx + ',' + w.ty]), moved: false };
    } else if (tool === 'reclaim') {
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
      if (drag.mode === 'paint') rasterTo(drag, w);   // accumulate every tile the brush crosses
      drag.cur = w;
    } else {
      hoverPropId = station.propAt(w.tx, w.ty);
      hoverRoomId = station.roomAt(w.tx, w.ty);
      // hovering a placed FUNCTIONAL prop shows its Fallout-style card (what it does + its live assignment)
      const hp = hoverPropId && station.propById(hoverPropId);
      const sp = hp && (typeof PropSprites !== 'undefined') && PropSprites.spec(hp.t);
      if (sp && sp.tier === 'functional') showPropCard(sp, hp, ev.clientX, ev.clientY);
      else hidePropCard();
    }
  }

  function onUp(ev) {
    try { cv.releasePointerCapture(ev.pointerId); } catch (e) {}
    if (!drag) return;
    const d = drag; drag = null;
    setCursor();
    if (d.mode === 'pan') return;
    if (d.mode === 'draw') return commitDraw(d, ev);
    if (d.mode === 'move') return commitMove(d, ev);
    if (d.mode === 'propmove') return commitPropMove(d, ev);
    if (d.mode === 'propstamp') return commitPropStamp(d, ev);
    if (d.mode === 'beltrun') return commitBeltRun(d, ev);
    if (d.mode === 'paint') return commitPaint(d, ev);
    if (d.mode === 'click') return commitClick(d, ev);
  }
  function onCancel() { if (drag) { drag = null; hideTip(); setCursor(); } }
  function onBlur() { spaceHeld = false; if (drag && drag.mode === 'pan') drag = null; setCursor(); }

  // add every tile on the segment from drag.cur to w (so a fast brush stroke skips nothing)
  function rasterTo(d, w) {
    let x0 = d.cur.tx, y0 = d.cur.ty; const x1 = w.tx, y1 = w.ty;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, guard = 0;
    while (guard++ < 4096) {
      d.cells.add(x0 + ',' + y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  function commitDraw(d, ev) {
    const rect = (tool === 'hall') ? laneRect(d.start, d.cur) : norm(d.start, d.cur);
    const res = (tool === 'hall') ? station.placeHallway({ rect }) : station.addRoom({ kind, rect });
    if (res && res.ok) pushFlash([rect], false);
    feedback(res, ev, tool === 'hall' ? 'hallway run' : 'room placed');
  }
  function commitMove(d, ev) {
    const dx = d.cur.tx - d.start.tx, dy = d.cur.ty - d.start.ty;
    if (!dx && !dy) { hideTip(); return; }
    feedback(station.moveRoom(d.roomId, dx, dy), ev, 'relocated');
  }
  function propSpec(id) { return (typeof PropSprites !== 'undefined' && PropSprites.spec(id)) || { w: 1, h: 1 }; }
  // open the right editor for a logistics prop that carries config (BAY = agent, FILTER/MERGER = routing, AIRLOCK = seal)
  // a workstation (PC/desk) opens the dedicated WORKSTATION picker; bays/junctions/etc. keep their editors.
  // (Trunk's PC-binding via the BAY picker is unified into the workstation picker — same agentId field, richer UX.)
  const openPropEditor = (id, t, ev) => { if (WORKSTATION_TYPES[t]) openWorkstationPicker(id, ev); else if (t === 'bay') openBayPicker(id, ev); else if (t === 'filter' || t === 'merger') openJunctionEditor(id, ev); else if (t === 'airlock') openDoorPicker(id, ev); else if (t === 'connector_portal') openConnectorEditor(id, ev); };
  const PROP_EDITABLE = { bay: 1, filter: 1, merger: 1, airlock: 1, connector_portal: 1 };
  const isEditableProp = t => !!PROP_EDITABLE[t] || !!WORKSTATION_TYPES[t];   // a workstation binds an agent + opens its picker on place/click
  function commitPropStamp(d, ev) {
    // a click (no drag) on an existing editable logistics prop re-opens its editor instead of stamping a duplicate
    if (isEditableProp(propType) && !d.moved) {
      const exist = station.propAt(d.cur.tx, d.cur.ty);
      const ep = exist && station.propById(exist);
      if (ep && ep.t === propType) { openPropEditor(exist, ep.t, ev); return; }
    }
    const s = propSpec(propType);
    const placement = { t: propType, x: d.cur.tx, y: d.cur.ty, w: s.w, h: s.h, block: s.blocks !== false };
    if (propType === 'airlock') placement.door = 'closed';   // a fresh airlock seals its room (then click to cycle)
    const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(propType) : null;
    const res = station.addProp(placement);
    if (res && res.ok) {
      pushFlash([{ x1: d.cur.tx, y1: d.cur.ty, x2: d.cur.tx + s.w - 1, y2: d.cur.ty + s.h - 1 }], false);
      if (grant) sfx('chime');   // a capability just came online — a brighter note than the plain placement click
      // first-touch coachmark (tutorial.js): a portal teaches "live tools", any other gear teaches "props are permissions"
      if (typeof Tutorial !== 'undefined') {
        if (propType === 'connector_portal') { if (Tutorial.onConnectorPlaced) Tutorial.onConnectorPlaced(); }
        else if (!isEditableProp(propType) && Tutorial.onPropPlaced) Tutorial.onPropPlaced(propType);
      }
      if (isEditableProp(propType) && res.id) { openPropEditor(res.id, propType, ev); return; }   // configure the freshly-placed prop
    }
    feedback(res, ev, grant ? ('EQUIPPED · grants ' + grant) : ('placed ' + propType));
  }
  function commitBeltRun(d, ev) {
    const res = station.placeBeltRun(d.start, d.cur);
    if (res && res.ok && res.count) {
      pushFlash([beltRunBox(d.start, d.cur)], false);
      if (typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced) Tutorial.onBeltPlaced();   // first-touch coachmark: belts + ▸ TEST
    }
    feedback(res, ev, res && res.dir ? ('belt → ' + res.dir) : 'belt');
  }
  function commitPropMove(d, ev) {
    const dx = d.cur.tx - d.start.tx, dy = d.cur.ty - d.start.ty;
    if (!dx && !dy) { hideTip(); return; }
    feedback(station.moveProp(d.propId, dx, dy), ev, 'relocated');
  }
  function commitPaint(d, ev) {
    if (d.moved) {
      const tiles = [...d.cells].map(k => { const p = k.split(','); return [+p[0], +p[1]]; });
      feedback(station.paintTiles(d.roomId, tiles, style), ev, 'painted');
    } else {
      feedback(station.setFloor(d.roomId, style), ev, 'deck repainted');   // a plain click fills the room
    }
  }
  function commitClick(d, ev) {   // RECLAIM
    const pid = station.propAt(d.cur.tx, d.cur.ty);   // props sit on top — reclaim them first
    if (pid) {
      const p = station.propById(pid);
      const res = station.removeProp(pid);
      if (res && res.ok) { if (p) pushFlash([{ x1: p.x, y1: p.y, x2: p.x + p.w - 1, y2: p.y + p.h - 1 }], true); flashUndo(); flashTip(ev, 'reclaimed — UNDO to restore', true); sfx('click'); }
      else { flashTip(ev, (res && res.msg) || 'blocked'); sfx('bad'); }
      return;
    }
    if (station.beltAt(d.cur.tx, d.cur.ty)) {   // a belt tile sits on the floor, under props
      const res = station.removeBelt(d.cur.tx, d.cur.ty);
      if (res && res.ok) { pushFlash([{ x1: d.cur.tx, y1: d.cur.ty, x2: d.cur.tx, y2: d.cur.ty }], true); flashUndo(); flashTip(ev, 'belt removed — UNDO to restore', true); sfx('click'); }
      else { flashTip(ev, (res && res.msg) || 'blocked'); sfx('bad'); }
      return;
    }
    const id = station.roomAt(d.cur.tx, d.cur.ty);
    if (!id) return;
    const rm = station.roomById(id);
    const res = station.removeRoom(id);
    if (res && res.ok) { if (rm) pushFlash(rm.rects, true); flashUndo(); flashTip(ev, 'reclaimed — UNDO to restore', true); sfx('click'); }
    else if (res && res.error === 'SPAWN_ROOM') { flashTip(ev, 'spawn room — can’t reclaim (try MOVE)'); sfx('bad'); }
    else { flashTip(ev, (res && res.msg) || 'blocked'); sfx('bad'); }
  }
  function feedback(res, ev, okMsg) {
    if (res && res.ok) { sfx('click'); flashTip(ev, okMsg, true); }
    else { sfx('bad'); flashTip(ev, (res && res.msg) || 'blocked'); }
  }
  function pushFlash(rects, bad) { flashes.push({ rects: rects.map(r => Object.assign({}, r)), t0: performance.now(), bad: !!bad }); }
  function flashUndo() { if (undoBtn) { undoBtn.classList.add('pulse'); setTimeout(() => undoBtn && undoBtn.classList.remove('pulse'), 900); } }

  function onWheel(ev) {
    ev.preventDefault();
    const c = toCanvas(ev), t = T();
    const wx = (c.x - panX) / zoom, wy = (c.y - panY) / zoom;
    const d = clamp(ev.deltaY, -50, 50);   // normalize notch vs trackpad so one mouse click doesn't over-zoom
    zoom = clamp(zoom * Math.exp(-d * 0.0022), MINZ, MAXZ);
    panX = c.x - wx * zoom; panY = c.y - wy * zoom;
  }

  function onKey(ev) {
    const a = ev.target;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    if (ev.key === ' ') { ev.preventDefault(); spaceHeld = true; setCursor(); return; }
    if (ev.key === 'Escape') {
      const card = root && root.querySelector('.refit-guide');
      if (card) { markSeen(); card.parentNode.removeChild(card); return; }
      if (drag) { drag = null; hideTip(); setCursor(); return; }   // cancel an in-progress edit first
      return close();
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      const r = ev.shiftKey ? station.redo() : station.undo();
      sfx(r.ok ? 'click' : 'bad'); return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); sfx(station.redo().ok ? 'click' : 'bad'); return; }
    if (ev.key === 'f' || ev.key === 'F') { fitCamera(); return; }
    const map = { '1': 'room', '2': 'hall', '3': 'paint', '4': 'move', '5': 'reclaim', '6': 'prop', '7': 'belt' };
    if (map[ev.key]) selectTool(map[ev.key]);
  }
  function onKeyUp(ev) { if (ev.key === ' ') { spaceHeld = false; setCursor(); } }

  /* ---------- geometry helpers (world tiles) ---------- */
  function norm(a, b) { return { x1: Math.min(a.tx, b.tx), y1: Math.min(a.ty, b.ty), x2: Math.max(a.tx, b.tx), y2: Math.max(a.ty, b.ty) }; }
  // a corridor lane along the dominant drag axis; its WIDTH grows toward the drag, not always south/east
  function laneRect(a, b) {
    const dx = b.tx - a.tx, dy = b.ty - a.ty, w = hallWidth - 1;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const y1 = dy < 0 ? a.ty - w : a.ty, y2 = dy < 0 ? a.ty : a.ty + w;
      return { x1: Math.min(a.tx, b.tx), y1, x2: Math.max(a.tx, b.tx), y2 };
    }
    const x1 = dx < 0 ? a.tx - w : a.tx, x2 = dx < 0 ? a.tx : a.tx + w;
    return { x1, y1: Math.min(a.ty, b.ty), x2, y2: Math.max(a.ty, b.ty) };
  }
  // a belt run is a single-tile-wide line along the dominant drag axis; returns {rect, dir}
  function beltRun(a, b) {
    const dx = b.tx - a.tx, dy = b.ty - a.ty;
    const horiz = Math.abs(dx) >= Math.abs(dy);
    const dir = horiz ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
    const rect = horiz ? { x1: Math.min(a.tx, b.tx), y1: a.ty, x2: Math.max(a.tx, b.tx), y2: a.ty }
                       : { x1: a.tx, y1: Math.min(a.ty, b.ty), x2: a.tx, y2: Math.max(a.ty, b.ty) };
    return { rect, dir };
  }
  function beltRunBox(a, b) { return beltRun(a, b).rect; }

  function ghostInfo() {
    if (!drag) return null;
    if (drag.mode === 'draw') {
      const rect = (tool === 'hall') ? laneRect(drag.start, drag.cur) : norm(drag.start, drag.cur);
      const v = (tool === 'hall') ? station.canPlaceHallway([rect]) : station.canPlaceRoom([rect], kind);
      return { rects: [rect], v, kind: tool };
    }
    if (drag.mode === 'beltrun') {
      const br = beltRun(drag.start, drag.cur);
      return { rects: [br.rect], v: station.canPlaceBeltRun(drag.start, drag.cur), belt: true, dir: br.dir };
    }
    if (drag.mode === 'propstamp') {
      const s = propSpec(propType), tx = drag.cur.tx, ty = drag.cur.ty;
      const rect = { x1: tx, y1: ty, x2: tx + s.w - 1, y2: ty + s.h - 1 };
      return { rects: [rect], v: station.canPlaceProp(propType, tx, ty, s.w, s.h), kind: 'prop' };
    }
    if (drag.mode === 'propmove') {
      const p = station.propById(drag.propId); if (!p) return null;
      const dx = drag.cur.tx - drag.start.tx, dy = drag.cur.ty - drag.start.ty;
      const nx = p.x + dx, ny = p.y + dy;
      const rect = { x1: nx, y1: ny, x2: nx + p.w - 1, y2: ny + p.h - 1 };
      return { rects: [rect], v: station.canPlaceProp(p.t, nx, ny, p.w, p.h, p.id), move: true, dx, dy };
    }
    if (drag.mode === 'move') {
      const rm = station.roomById(drag.roomId); if (!rm) return null;
      const dx = drag.cur.tx - drag.start.tx, dy = drag.cur.ty - drag.start.ty;
      const rects = rm.rects.map(r => ({ x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy }));
      const v = rm.kind === 'corridor' ? station.canPlaceHallway(rects, rm.id) : station.canPlaceRoom(rects, rm.kind, rm.id);
      return { rects, v, move: true, dx, dy };
    }
    return null;
  }

  /* ---------- render loop ---------- */
  function rebake() {
    cacheGeo = station.projectGeometry();
    cache = StationBake.bakeIncremental ? StationBake.bakeIncremental(cacheGeo, cache, bakeDirtyRects) : StationBake.bake(cacheGeo);
    valPlan = (typeof Pipeline !== 'undefined') ? Pipeline.compileRoutingPlan(cacheGeo) : null;   // cost-safety: recompute the routing plan on every floor edit
    bakeDirty = false; bakeDirtyRects = null;
  }

  function frame(now) {
    if (!running) return;
    if (bakeDirty || !cache) rebake();
    const t = T();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#040302'; ctx.fillRect(0, 0, cv.width, cv.height);
    for (const s of stars) {   // starfield matched to the live world so entering/exiting REFIT doesn't jump
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph));
      ctx.fillStyle = 'rgba(180,200,230,' + tw + ')';
      ctx.fillRect((s.x * cv.width + now / 1000 * 8) % cv.width, s.y * cv.height, s.r, s.r);
    }

    ctx.setTransform(zoom, 0, 0, zoom, panX, panY);
    ctx.imageSmoothingEnabled = false;
    const ox = cache.origin.tx * t, oy = cache.origin.ty * t;
    if (StationBake.drawBase) StationBake.drawBase(ctx, cache, ox, oy);
    else ctx.drawImage(cache.baseCv, ox, oy);
    drawGrid(t);
    drawConveyor(now, t);   // belts (floor) → props → boxes ride on top
    drawProps(now);
    drawConveyorBoxes(now, t);
    if (StationBake.drawLight) StationBake.drawLight(ctx, cache, ox, oy);
    else ctx.drawImage(cache.lightCv, ox, oy);
    drawGlows(now);
    drawFlashes(now, t);
    drawRoutingValidation(t, now);   // red/amber markers on any unroutable junction/bay (cost-safety)
    drawHover(t);
    drawAgentTag(t);   // hovering a PC or BAY names the agent it's bound to (or flags an unassigned PC)
    drawGhost(t, now);
    // animate the prop-palette preview gallery (~25fps is plenty + cheap). Runs LAST: it hijacks PropSprites'
    // ctx for the offscreen tiles, and the next frame re-points it at the main canvas in drawProps().
    if (tool === 'prop' && propThumbs.length && now - lastThumbTs >= 40) { paintThumbs(now); lastThumbTs = now; }

    raf = requestAnimationFrame(frame);
  }

  function drawGrid(t) {
    const x0 = (-panX) / zoom, y0 = (-panY) / zoom, x1 = (cv.width - panX) / zoom, y1 = (cv.height - panY) / zoom;
    const tx0 = Math.floor(x0 / t) - 1, ty0 = Math.floor(y0 / t) - 1, tx1 = Math.ceil(x1 / t) + 1, ty1 = Math.ceil(y1 / t) + 1;
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = 'rgba(120,200,255,0.07)';
    ctx.beginPath();
    for (let gx = tx0; gx <= tx1; gx++) { ctx.moveTo(gx * t, y0); ctx.lineTo(gx * t, y1); }
    for (let gy = ty0; gy <= ty1; gy++) { ctx.moveTo(x0, gy * t); ctx.lineTo(x1, gy * t); }
    ctx.stroke();
    // brighter cells over the actual footprint (the comment's promise, now real)
    if (cacheGeo && (tx1 - tx0) * (ty1 - ty0) < 6000) {
      const ox = cacheGeo.origin.tx, oy = cacheGeo.origin.ty, zg = cacheGeo.zoneGrid, idx = cacheGeo.idx, C = cacheGeo.COLS, R = cacheGeo.ROWS;
      ctx.strokeStyle = 'rgba(140,210,255,0.16)';
      ctx.beginPath();
      for (let gy = ty0; gy <= ty1; gy++) for (let gx = tx0; gx <= tx1; gx++) {
        const lx = gx - ox, ly = gy - oy;
        if (lx < 0 || ly < 0 || lx >= C || ly >= R || zg[idx(lx, ly)] == null) continue;
        ctx.rect(gx * t + 0.5 / zoom, gy * t + 0.5 / zoom, t - 1 / zoom, t - 1 / zoom);
      }
      ctx.stroke();
    }
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

  // place/delete confirmation flashes — a quick bright pulse that fades over ~500ms
  function drawFlashes(now, t) {
    for (let i = flashes.length - 1; i >= 0; i--) {
      const fl = flashes[i], k = (now - fl.t0) / 500;
      if (k >= 1) { flashes.splice(i, 1); continue; }
      const a = (1 - k) * 0.5;
      ctx.fillStyle = fl.bad ? 'rgba(255,110,90,' + a + ')' : 'rgba(170,255,210,' + a + ')';
      for (const r of fl.rects) ctx.fillRect(r.x1 * t, r.y1 * t, (r.x2 - r.x1 + 1) * t, (r.y2 - r.y1 + 1) * t);
    }
  }

  // placeable props — drawn in WORLD tile coords (camera maps world*t, the bake is origin-shifted
  // to match). Lit (work=true) so the editor previews screens alive; y-sorted for clean overlap.
  function drawProps(now) {
    if (typeof PropSprites === 'undefined') return;
    const list = station.props();
    if (!list.length) return;
    PropSprites.setCtx(ctx); PropSprites.setNow(now);
    const sorted = list.slice().sort((a, b) => (a.y + (a.h || 1)) - (b.y + (b.h || 1)));
    for (const p of sorted) PropSprites.draw(p, true);
  }

  // conveyor — belts (floor machinery) + the live transport sim. WORLD coords like drawProps.
  function drawConveyor(now, t) {
    if (!convey) return;
    const belts = station.belts();
    const dt = lastFrameTs ? (now - lastFrameTs) : 16; lastFrameTs = now;
    // route the preview boxes through the SAME junctions the compiled plan uses, so a TEST box sorts exactly as
    // real work will (build-time "does my routing work?" loop). null until a junction exists -> boxes go straight.
    const jmap = (valPlan && valPlan.junctions && Object.keys(valPlan.junctions).length) ? new Map(Object.entries(valPlan.junctions)) : null;
    convey.tick(dt, now, belts, jmap);
    convey.drawBelts(ctx, now, t, belts);
  }
  function drawConveyorBoxes(now, t) { if (convey) convey.drawBoxes(ctx, now, t); }

  /* cost-safety overlay: an unroutable floor would silently send work into a void or an infinite paid loop, so
     surface it BEFORE any run. Red = blocking (orphan source / dead bay / cycle / filter has no default lane /
     duplicate agent); amber = warning (a bay with no agent). Plan is recomputed only on a floor edit (rebake). */
  function drawRoutingValidation(t, now) {
    if (!cacheGeo) return;
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);
    ctx.lineWidth = 2 / zoom;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.font = (7 / zoom) + 'px monospace';
    const mark = (rect, col, label) => {
      const X = rect.x1 * t, Y = rect.y1 * t, Wd = (rect.x2 - rect.x1 + 1) * t, Hd = (rect.y2 - rect.y1 + 1) * t;
      ctx.fillStyle = 'rgba(' + col + ',' + (0.10 + 0.12 * pulse).toFixed(3) + ')'; ctx.fillRect(X, Y, Wd, Hd);
      ctx.strokeStyle = 'rgba(' + col + ',0.95)'; ctx.strokeRect(X + 0.5 / zoom, Y + 0.5 / zoom, Wd - 1 / zoom, Hd - 1 / zoom);
      ctx.fillStyle = 'rgba(' + col + ',0.95)'; ctx.fillText(label, X + Wd / 2, Y - 1 / zoom);
    };
    // routing errors from the compiled plan (orphan source / dead bay / cycle / no default / dup agent / no agent)
    if (valPlan && valPlan.errors && valPlan.errors.length) {
      const propById = {};
      for (const p of (cacheGeo.props || [])) propById[p.id] = p;
      for (const e of valPlan.errors) {
        let rect = null;
        if (e.tile) rect = { x1: e.tile.x, y1: e.tile.y, x2: e.tile.x, y2: e.tile.y };
        else if (e.propId && propById[e.propId]) { const p = propById[e.propId]; rect = { x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }; }
        if (rect) mark(rect, e.warn ? '255,190,60' : '255,80,70', VAL_LABEL[e.code] || e.code);   // amber warn vs red blocker
      }
    }
    // B5 cost-safety: a BOUND bay whose room has no workstation can't run — the compute gate stays shut, so
    // routed work would silently do nothing. Surface it (amber) so the Commander knows to equip the bay.
    if (typeof station.bayObjects === 'function') {
      for (const p of (cacheGeo.props || [])) {
        if (p.t !== 'bay' || !p.agentId) continue;
        if (station.bayObjects(p.agentId).indexOf('computer') >= 0) continue;
        mark({ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }, '255,190,60', 'NO COMPUTE');
      }
    }
    // a CONNECTOR PORTAL with no bound server grants nothing — surface it (amber) so the Commander binds one.
    for (const p of (cacheGeo.props || [])) {
      if (p.t !== 'connector_portal') continue;
      const live = station.propById(p.id);
      if (live && live.connectorId) continue;
      mark({ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }, '255,190,60', 'UNBOUND');
    }
  }

  // hovering an agent-bound endpoint (a PC = compute, a BAY = routing) floats the bound agent's name above it —
  // so a SHARED room (several agents, several PCs) stays legible without one-room-per-agent. An unbound PC reads
  // amber "unassigned" to invite binding. (Belts/conveyors gain the same tag in Phase 2b once they carry agentId.)
  function drawAgentTag(t) {
    if (drag || !hoverPropId) return;
    const p = station.propById(hoverPropId);
    if (!p) return;
    const isPc = isPcProp(p.t), isBay = p.t === 'bay';
    if (!isPc && !isBay) return;
    const bound = !!p.agentId;
    const txt = (isPc ? 'PC · ' : 'BAY · ') + (bound ? String(p.agentId).replace(/^tg_/, '') : 'unassigned');
    ctx.font = (8 / zoom) + 'px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const cx = (p.x + (p.w || 1) / 2) * t, topY = p.y * t - 2 / zoom;
    const pad = 5 / zoom, bw = ctx.measureText(txt).width + pad * 2, bh = 11 / zoom;
    ctx.fillStyle = 'rgba(8,16,12,0.92)'; ctx.fillRect(cx - bw / 2, topY - bh, bw, bh);
    ctx.fillStyle = bound ? 'rgba(125,240,200,0.96)' : 'rgba(255,190,60,0.96)';
    ctx.fillText(txt, cx, topY - 2 / zoom);
  }

  function drawHover(t) {
    if (drag) return;
    // a hovered prop (move/reclaim) outlines on top of any room outline
    if ((tool === 'move' || tool === 'reclaim') && hoverPropId) {
      const p = station.propById(hoverPropId);
      if (p) {
        ctx.lineWidth = 1.5 / zoom;
        ctx.strokeStyle = tool === 'reclaim' ? 'rgba(255,92,77,0.95)' : 'rgba(120,220,255,0.95)';
        ctx.strokeRect(p.x * t + 1, p.y * t + 1, p.w * t - 2, p.h * t - 2);
        return;
      }
    }
    if (tool !== 'move' && tool !== 'reclaim' && tool !== 'paint') return;
    if (!hoverRoomId) return;
    const rm = station.roomById(hoverRoomId); if (!rm) return;
    const protectedSpawn = tool === 'reclaim' && hoverRoomId === station.spawnRoomId();
    ctx.lineWidth = 1.5 / zoom;
    ctx.strokeStyle = protectedSpawn ? 'rgba(255,200,80,0.95)' : (tool === 'reclaim' ? 'rgba(255,92,77,0.95)' : 'rgba(120,220,255,0.95)');
    for (const r of rm.rects) ctx.strokeRect(r.x1 * t + 1, r.y1 * t + 1, (r.x2 - r.x1 + 1) * t - 2, (r.y2 - r.y1 + 1) * t - 2);
    if (protectedSpawn) { // a small lock badge so the block is predictable, not surprising
      const z = rm.rects[0]; ctx.fillStyle = 'rgba(255,200,80,0.95)'; ctx.font = (10 / zoom) + 'px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⌂', (z.x1 + 0.5) * t, (z.y1 + 0.5) * t);
    }
  }

  function drawGhost(t, now) {
    // paint brush: tint the crossed tiles with the chosen deck colour
    if (drag && drag.mode === 'paint' && drag.moved) {
      const base = station.FLOOR_STYLES[style] ? station.FLOOR_STYLES[style].base : '#888';
      ctx.globalAlpha = 0.55; ctx.fillStyle = base;
      for (const k of drag.cells) { const p = k.split(','); if (station.roomAt(+p[0], +p[1]) === drag.roomId) ctx.fillRect(+p[0] * t, +p[1] * t, t, t); }
      ctx.globalAlpha = 1;
      showTip(drag.cells.size + ' tiles', true);
      return;
    }
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
    // belt: draw flow arrows along the run so the direction reads at a glance
    if (g.belt) {
      const V = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] }[g.dir];
      ctx.strokeStyle = line; ctx.lineWidth = 1.5 / zoom;
      const rr = g.rects[0];
      for (let x = rr.x1; x <= rr.x2; x++) for (let y = rr.y1; y <= rr.y2; y++) {
        const cx = (x + 0.5) * t, cy = (y + 0.5) * t, a = t * 0.22;
        ctx.beginPath();
        if (V[0]) { ctx.moveTo(cx - a * V[0], cy - a); ctx.lineTo(cx + a * V[0], cy); ctx.lineTo(cx - a * V[0], cy + a); }
        else { ctx.moveTo(cx - a, cy - a * V[1]); ctx.lineTo(cx, cy + a * V[1]); ctx.lineTo(cx + a, cy - a * V[1]); }
        ctx.stroke();
      }
    }
    // live readout: dimensions while placing/sizing; the reason when blocked
    const r0 = g.rects[0], w = r0.x2 - r0.x1 + 1, h = r0.y2 - r0.y1 + 1;
    let dims = g.belt ? ('belt → ' + g.dir + ' · ' + Math.max(w, h) + ' long')
      : g.move ? ('move ' + (g.dx >= 0 ? '+' : '') + g.dx + ',' + (g.dy >= 0 ? '+' : '') + g.dy)
      : (tool === 'hall' ? (Math.max(w, h) + ' long × ' + Math.min(w, h)) : (w + '×' + h));
    showTip(ok ? dims : (dims + ' · ' + ((g.v && g.v.msg) || 'blocked')), ok);
  }

  /* ---------- tooltip ---------- */
  function showTip(text, ok) {
    if (!tip) return;
    tip.textContent = text;
    tip.classList.toggle('ok', !!ok);
    tip.classList.toggle('bad', !ok);
    tip.style.display = 'block';
    // clamp within the viewport so it never clips off the right/bottom edge
    const tw = tip.offsetWidth || 80, th = tip.offsetHeight || 18;
    const x = Math.min(lastClient.x + 16, window.innerWidth - tw - 6);
    const y = Math.min(lastClient.y + 14, window.innerHeight - th - 6);
    tip.style.left = Math.max(6, x) + 'px';
    tip.style.top = Math.max(6, y) + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }
  let tipTimer = 0;
  function flashTip(ev, text, ok) {
    lastClient = { x: ev.clientX, y: ev.clientY };
    showTip(text, ok); clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, 1300);
  }

  /* ---------- Fallout-style prop description card ----------
     A persistent hover panel (NOT the transient action tip): says what a prop IS and DOES, its footprint, and —
     for a placed functional prop — its live assignment (hosted-by agent / bound server). Shown on palette-tile
     hover (browsing) and on canvas hover of a placed functional prop. `c` = a CATALOG spec; `placed` = the live prop. */
  function propCardHTML(c, placed) {
    const fn = c.tier === 'functional';
    const tier = fn ? '<span class="pc-tier fn">⚙ SYSTEMS</span>' : '<span class="pc-tier">✦ DECOR</span>';
    const foot = c.w + '×' + c.h + (c.blocks === false ? ' · walkable' : ' · solid');
    const desc = c.desc || (fn ? '' : 'Decor — looks only. Sets the mood; no effect on how the station runs.');
    let assign = '';
    if (placed && WORKSTATION_TYPES[placed.t]) {
      assign = placed.agentId
        ? '<div class="pc-assign ok">▸ HOSTED BY ' + esc(agentLabel(placed.agentId)) + '</div>'
        : '<div class="pc-assign">UNASSIGNED — click to choose an agent</div>';
    } else if (placed && placed.t === 'bay') {
      assign = placed.agentId
        ? '<div class="pc-assign ok">▸ AGENT ' + esc(agentLabel(placed.agentId)) + '</div>'
        : '<div class="pc-assign">NO AGENT — click to assign</div>';
    } else if (placed && placed.t === 'connector_portal') {
      assign = placed.connectorId
        ? '<div class="pc-assign ok">▸ BOUND ' + esc(placed.connectorId) + '</div>'
        : '<div class="pc-assign">UNBOUND — click to bind a server</div>';
    }
    return '<h4>' + esc(c.label) + '</h4>' + tier + (desc ? ('<p>' + esc(desc) + '</p>') : '') + '<div class="pc-foot">' + foot + '</div>' + assign;
  }
  let propCardKey = null;
  function showPropCard(c, placed, cx, cy) {
    if (!propCard || !c) return;
    const key = placed ? ('p:' + placed.id + ':' + (placed.agentId || placed.connectorId || '')) : ('c:' + c.id);
    if (key !== propCardKey) { propCard.innerHTML = propCardHTML(c, placed); propCardKey = key; }
    propCard.style.display = 'block';
    const w = propCard.offsetWidth || 230, h = propCard.offsetHeight || 96;
    const ax = (cx == null ? lastClient.x : cx), ay = (cy == null ? lastClient.y : cy);
    let x = ax + 16, y = ay - h - 14;            // prefer above-right of the cursor
    if (y < 6) y = ay + 20;                       // flip below if it would clip the top
    x = Math.min(x, window.innerWidth - w - 8);
    y = Math.min(y, window.innerHeight - h - 8);
    propCard.style.left = Math.max(6, x) + 'px';
    propCard.style.top = Math.max(6, y) + 'px';
  }
  function hidePropCard() { if (propCard) { propCard.style.display = 'none'; propCardKey = null; } }

  function sfx(n) { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); }

  // DEV-ONLY test hook (gated on window.__STARNET_DEV__) — lets the audit harness prove the
  // object=capability moat (place a dish → web cap appears) by placing through the REAL
  // station.addProp path at a validated tile, instead of simulating fragile canvas-drag pixel
  // coordinates. Never attached in a shipped build (the dev flag is never set there).
  function findPlaceableTile(type, w, h) {
    if (!station || !station.bounds || !station.canPlaceProp) return null;
    const b = station.bounds();
    for (let ty = b.minTy; ty <= b.maxTy; ty++)
      for (let tx = b.minTx; tx <= b.maxTx; tx++)
        if (station.canPlaceProp(type, tx, ty, w, h)) return { tx, ty };
    return null;
  }
  const __test__ = {
    isOpen: () => running,
    placeCapProp: (type) => {
      if (!running || !station) return { ok: false, reason: 'not-in-build' };
      const t = type || 'workbench';   // a real cap-prop id (CAP_PROP_MAP): workbench→terminal, comms_dish→web
      const s = propSpec(t);
      const tile = findPlaceableTile(t, s.w, s.h);
      if (!tile) return { ok: false, reason: 'no-valid-tile' };
      propType = t; tool = 'prop';
      const res = station.addProp({ t, x: tile.tx, y: tile.ty, w: s.w, h: s.h, block: s.blocks !== false });
      return { ok: !!(res && res.ok), tile, type: t };
    },
  };

  const api = { init, open, close, toggle, isOpen };
  if (typeof window !== 'undefined' && window.__STARNET_DEV__) api.__test__ = __test__;
  return api;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Build;
