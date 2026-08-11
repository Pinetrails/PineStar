/* STARNET — build.js : the diegetic full-screen REFIT (build) mode.

   Toggled from the dock. Dims the live sim and drops the Commander into an in-fiction
   station-editor over the SAME procedural art: pan/zoom camera, phosphor build grid,
   a ghost preview that snaps to tiles and tints green/red via the model's validators,
   and an in-fiction toolbar — PLACE ROOM · HALLWAY · SURFACE · MOVE · DELETE · UNDO.

   It reads + mutates the canonical WorldModel station (the single source of truth) and
   re-bakes via StationBake on every change, then persists through the injected save hook.
   See frontend/app/BUILDER.md for the contract. */
'use strict';

const Build = (() => {
  const TOOLS = [
    // SELECT is the DEFAULT mode (2026-08-05 interaction reshape): entering REFIT arms NO placement
    // tool — a click INSPECTS the machine under it (its picker/editor/flow card) instead of trying to
    // place something. Key 0, ESC and right-click all return here from any armed tool.
    // labels are WORDS ONLY — the leading symbol each one used to carry (◎ ▦ ═ …) is now a pixel
    // icon painted on the button's canvas, because those glyphs fall back to a system font
    { id: 'select', key: '0', label: 'SELECT', verb: 'click a machine to open it', hint: 'click any machine or belt to open it — its picker, its routes, where its lane goes', cursor: 'default' },
    { id: 'room', key: '1', label: 'ROOM', verb: 'click to place · drag to size', hint: 'click the deck to place a room at the last size you drew, or drag out any size', cursor: 'crosshair' },
    { id: 'hall', key: '2', label: 'HALLWAY', verb: 'click to run · drag to size', hint: 'click to run a corridor at the last length you drew, or drag along an axis for any length', cursor: 'crosshair' },
    // 'paint' stays the INTERNAL id (the drag mode, the model's paintTiles verb, the key map and every
    // saved reference key off it) — only the display name changed. The tool stopped being "paint" the
    // day it grew wall cladding and a material axis: it now sets what a room's surfaces are MADE OF,
    // deck and walls, so it's SURFACE. Same law as the skynet.* keys: rename the label, never the key.
    { id: 'paint', key: '3', label: 'SURFACE', verb: 'click a room to lay this deck', hint: 'click a room to lay the selected deck · drag to paint single tiles in the colour', cursor: 'cell' },
    { id: 'move', key: '4', label: 'MOVE', verb: 'drag a room or machine', hint: 'drag a room to relocate it — its machines ride along', cursor: 'move' },
    /* DELETE, not RECLAIM (2026-08-07). "Reclaim" is salvage-economy fiction from a tier system
       that was never built — the button's whole job is to remove a thing, and every player already
       knows the word for that. Same law as SURFACE above: the LABEL changed, the tool id `reclaim`
       did not (the key map, the drag mode, the model verb and every saved reference key ride it). */
    { id: 'reclaim', key: '5', label: 'DELETE', verb: 'click anything to delete it', hint: 'click a room, prop, or belt to delete it · drag across a belt to clear the whole run (UNDO restores it)', cursor: 'not-allowed' },
    { id: 'prop', key: '6', label: 'PROP', verb: 'click the deck to place it', hint: 'click to place furniture · agents walk around it', cursor: 'crosshair' },
    { id: 'belt', key: '7', label: 'BELT', verb: 'click one machine, then another', hint: 'CLICK one machine, then another — the belt lays itself · (or drag to lay tiles by hand)', cursor: 'crosshair' },
    { id: 'dupe', key: '8', label: 'DUPE', verb: 'click a thing to copy it', hint: 'click a room or prop to copy it · then every click stamps a copy — mirror your build fast', cursor: 'copy' },
    { id: 'line', key: '9', label: 'LINES', verb: 'pick a line, then click the deck', hint: 'pick a STARTER LINE below, then click the deck — a whole working layout stamps at once, yours to edit', cursor: 'copy' },
  ];
  /* ---------- TOOL GROUPS (2026-08-07 build-mode overhaul) ----------
     Ten equal-weight buttons in a flat 2×5 grid is a debug menu, not a build mode: nothing said
     which tool comes FIRST, which ones change what already exists, or which ones are about work
     rather than architecture. The same ten verbs now read as four answers to "what am I doing?":

       STRUCTURE  make the space      ROOM · HALLWAY
       SURFACES   dress it            SURFACE · PROP
       WORKFLOW   make it run         BELT · LINES
       EDIT       change what's there MOVE · DUPE · DELETE

     SELECT sits ABOVE the groups on its own full-width row — it is not a fifth kind of building,
     it's the cursor you fall back to (ESC / right-click / re-clicking the armed tool all land here).
     Number keys are UNCHANGED: the quest system and the guide card cite them by number
     (quests.js "drag a BELT (7)"), so grouping reorders the buttons, never the shortcuts. */
  const TOOL_GROUPS = [
    { label: 'STRUCTURE', why: 'make the space',       tools: ['room', 'hall'] },
    { label: 'SURFACES',  why: 'dress it',             tools: ['paint', 'prop'] },
    { label: 'WORKFLOW',  why: 'make it run',          tools: ['belt', 'line'] },
    { label: 'EDIT',      why: 'change what is there', tools: ['move', 'dupe', 'reclaim'] },
    // (no fifth band — SELECT rides its own row above these, see buildDOM)
  ];

  /* ---------- PIXEL TOOL ICONS ----------
     Every tool used to label itself with a unicode symbol (◎ ▦ ═ ▧ ✥ ⌫ ⚇ ⇶ ⧉ ⇉). Those glyphs are
     NOT in VT323 — the browser silently falls back to a system font for the symbol and keeps VT323
     for the word, so each button rendered in two typefaces at two weights (the standing
     symbol-glyph law). These are 12×12 pixel bitmaps painted on a canvas in the button's own
     phosphor colour: one typeface, in the station's own art language, crisp at any DPR. */
  const ICON_PX = [
    ['select', '#...........,##..........,###.........,####........,#####.......,######......,#######.....,########....,#####.......,##.###......,#...###.....,.....###....'],
    ['room',   '############,#..........#,#..........#,#..........#,#..........#,#..........#,#..........#,#..........#,#..........#,#..........#,#..........#,#####..#####'],
    ['hall',   '............,............,............,############,............,..##..##..##,............,............,############,............,............,............'],
    ['paint',  '############,#.#..#..#..#,#..#..#..#.#,#.#..#..#..#,#..#..#..#.#,#.#..#..#..#,#..#..#..#.#,#.#..#..#..#,#..#..#..#.#,#.#..#..#..#,#..#..#..#.#,############'],
    ['move',   '.....##.....,....####....,...##..##...,.....##.....,.#...##...#.,##.######.##,##.######.##,.#...##...#.,.....##.....,...##..##...,....####....,.....##.....'],
    // a BIN, not an X — an X reads "cancel/close"; a bin reads "delete", in every UI there is
    ['reclaim','....####....,############,............,.##########.,.#.##..##.#.,.#.##..##.#.,.#.##..##.#.,.#.##..##.#.,.#.##..##.#.,.#........#.,..########..,............'],
    ['prop',   '..########..,..#......#..,..#.####.#..,..#.####.#..,..#......#..,..########..,.....##.....,.....##.....,############,#..........#,#..........#,############'],
    ['belt',   '............,............,############,............,.##..##..##.,..##..##..##,.##..##..##.,............,############,............,............,............'],
    ['dupe',   '............,..########..,..#......#..,..#......#..,..#..#######,..#..#....#.,..####....#.,.....#....#.,.....#....#.,.....######.,............,............'],
    ['line',   '............,.##########.,.#........#.,.#.##..##.#.,.#.##..##.#.,.#........#.,.#..####..#.,.#..####..#.,.#........#.,.##########.,............,............'],
  ].reduce((m, [k, v]) => (m[k] = v.split(','), m), {});
  const ICON_N = 12;   // bitmap side, in icon pixels

  // Paint a tool's bitmap into its <canvas> in `colour`. Re-run on activation so the icon tracks
  // the button's own phosphor state (dim → bright) instead of being baked once at build time.
  function paintIcon(cvEl, id, colour) {
    const rows = ICON_PX[id]; if (!cvEl || !rows) return;
    const c = cvEl.getContext('2d'); if (!c) return;
    const s = cvEl.width / ICON_N;
    c.clearRect(0, 0, cvEl.width, cvEl.height);
    c.fillStyle = colour;
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) if (row[x] === '#') c.fillRect(x * s, y * s, s, s);
    }
  }
  // the icon colour for a tool button in its current state — read off the live button so a theme
  // switch (or the DELETE red) is honoured without a second colour table to keep in sync
  const iconColour = btn => getComputedStyle(btn).color || '#f0e6ce';
  function repaintIcons() {
    if (!root) return;
    root.querySelectorAll('.refit-tool').forEach(b => {
      const c = b.querySelector('canvas');
      if (c) paintIcon(c, b.dataset.tool, iconColour(b));
    });
  }

  const SEEN_KEY = 'starnet.refit.seen';
  // machines the BELT tool connects with two clicks (mirrors worldmodel CONNECTABLE)
  const CONNECT_TYPES = { intake: 1, bay: 1, outbox: 1, filter: 1, splitter: 1, merger: 1 };

  let opts = null, station = null, unsub = null;
  let connectFrom = null;   // connect-mode state: the armed FROM machine's propId (null = not connecting)
  let root, cv, ctx, tip, hintEl, undoBtn, redoBtn, propCard, dpr = 1, ro = null;
  let raf = 0, frameRetryTimer = 0, running = false, frameFailures = 0;
  let cache = null, cacheGeo = null, bakeDirty = true, bakeDirtyRects = null, bakeDirtyRectsGlobal = false, bakeVisibleOnly = false, valPlan = null, valLive = null;   // valPlan = live RoutingPlan (cost-safety ghosts); valLive = energized-belt tile set
  let planDirty = true;   // routing-plan cache flag: set by EDITS (station.onChange / open), never by pure pans — see rebake()
  const flashes = [];   // {rects, t0, bad} place/delete confirmations
  // short human labels for the routing-validation overlay (cost-safety: surfaced before any paid run)
  // every label NAMES THE FIX, in words (mirrors world.js NAG_LABEL — keep the two in sync)
  const VAL_LABEL = {
    ORPHAN_SOURCE: 'NOT CONNECTED — BELT: CLICK IT, THEN A BAY', ORPHAN_BAY: 'NOT ON THE LINE', BAY_NOT_FED: 'NOT CONNECTED — BELT: CLICK IT, THEN A MACHINE',
    CYCLE: 'LOOP! — BREAK THE CIRCLE', FILTER_NO_DEFAULT: 'NO DEFAULT LANE — CLICK', DUP_AGENT: 'DUP AGENT — ONE BAY EACH',
    UNBOUND_BAY: 'NO AGENT — CLICK', SPLIT_ONE_LANE: 'SPLITTER NEEDS 2 LANES',
    ORPHAN_JUNCTION: 'NOT ON A BELT — MOVE IT ONTO THE LINE',
    BELT_BURIED: 'A PROP SITS ON THIS LINE — MOVE IT',
    // the docks feed each OTHER: no belt loop anywhere, but the work line would run forever, paying each lap
    CHAIN_CYCLE: 'WORK LINE LOOPS — CUT ONE HANDOFF'
  };
  const esc = s => U.esc(s == null ? '' : s);   // one complete impl (escapes & < > " ' — value="…" attrs here stay injection-safe)
  // THE ONE SENTENCE (2026-08-04 onramp): every self-introduction of the belt system leads with this.
  // It also leads the INBOX catalog desc (propsprites.js) and the first-run guide card — keep them aligned.
  const LINE_SENTENCE = 'Your floor is a flowchart — work arrives at the INBOX, every BAY is an agent doing one step, and the belts you draw are the order the work flows.';

  // camera: screen = world*zoom + pan   (world = bake-pixel space, 1 tile = TILE px)
  let zoom = 2, panX = 0, panY = 0;
  const MINZ = 0.4, MAXZ = 6;

  // interaction state
  let tool = 'select', kind = 'hab', style = 'cobalt', mat = 'plate', hallWidth = 2, propType = 'desk', propCat = 'workstation', propTier = 'functional';
  // SURFACE targets one surface at a time — the deck or the walls — so the palette stays two rows
  // instead of four. 'follow' wall colour = inherit the room's floor hue (the default).
  let paintTarget = 'floor', wallMat = 'plating', wallStyle = 'follow';
  // the SHELL axis — a room's exterior, the surface you see from outside the station (WorldModel's
  // HULL_MATERIALS). 'follow' here means "the tone this material was drawn for", not "match the deck":
  // an exterior has no deck to match, and STATION's own follow-tone is the shell grey it always was.
  let hullMat = 'station', hullStyle = 'follow';
  let drag = null, hoverRoomId = null, hoverPropId = null, hoverTile = null, lastClient = { x: 0, y: 0 }, spaceHeld = false;
  /* THE CAPTURED POINTER (2026-08-07 conveyor audit). onDown setPointerCapture()s the canvas so a drag
     that leaves the element keeps tracking. Only onUp released it — every OTHER way a drag ends (ESC,
     right-click, pointercancel, window blur) dropped `drag` and left the capture ON, and a captured
     canvas swallows its own pointerleave/hover until the next click. Remember the id so every exit
     releases it; endDrag() is the ONE way a drag is dropped. */
  let dragPid = null;
  function releaseDrag() {
    if (dragPid != null && cv) { try { cv.releasePointerCapture(dragPid); } catch (e) {} }
    dragPid = null; drag = null;
  }
  let dupe = null;   // DUPE tool clipboard: {type:'prop'|'room', rects (rel to top-left), …} — armed = ghost follows cursor, click stamps
  let lineType = 'research_line';   // LINES tool: the armed starter-line blueprint (WorldModel.BLUEPRINTS id)
  /* WHERE CAN THIS GO — the candidate field (2026-08-07). Arming a blueprint used to answer
     "where is this legal?" with nothing but a red ghost, so the only way to find a spot was to
     wave the pointer until the red went green. lineFields caches, PER BLUEPRINT, the full set of
     legal cursor tiles for the CURRENT floor; it is computed at most once per (blueprint, edit)
     and NEVER inside the frame loop's hot path (a full scan is ~thousands of checkBlueprint calls
     — per frame it would melt). station.onChange drops the whole map; that is the only invalidation. */
  const lineFields = Object.create(null);   // bpId -> { set:Set('tx,ty'), list:[{tx,ty}], runs:[…], edges:[…] }
  const lineFitsMemo = Object.create(null); // bpId -> bool, from the EARLY-EXIT probe (see lineFits)
  /* ---------- THE GEOMETRY VERSION: one explicit invalidation signal (2026-08-08 perf pass) ----------
     REFIT's frame loop was re-deriving, at 60fps, a pile of answers that can only change when the
     FLOOR changes: the station bounds, the belt list, every bound bay's capability objects, the
     table-mount resolution for every prop, and the top readout's room/tile census. On a large deck
     that was the frame — bayObjects alone is O(bays × props × rooms).

     `geoVer` is bumped by exactly one thing: station.onChange (plus open(), so a second session can
     never read a memo left by the first). Every memo below stores the version it was computed at
     and recomputes the instant that number moves. A memo is NEVER refreshed on a timer, a guess or
     a heuristic — a stale overlay would be the app asserting a floor the model does not hold, which
     is the same lie the truthful-telemetry law forbids everywhere else. */
  let geoVer = 1;
  let boundsVer = 0, boundsMemo = null;
  let beltsVer = 0, beltsMemo = null;
  let bayObjVer = 0, bayObjMemo = null;    // Map agentId -> objects (bayObjects is pure over the doc)
  let mountVer = 0, mountOrder = null, mountMap = null;
  let statVer = 0;                          // top readout: the room/prop census only moves with the floor
  let jmapPlan = null, jmapOx = 0, jmapOy = 0, jmapMemo = null;   // junction map, keyed on the COMPILED plan
  function bumpGeo() {
    geoVer++;
    boundsMemo = null; beltsMemo = null; bayObjMemo = null; mountOrder = null; mountMap = null;
  }
  // the station bounds, once per edit. Callers READ it (never mutate), so one shared object is safe.
  const boundsMemoed = () => (boundsVer === geoVer && boundsMemo) ? boundsMemo : (boundsVer = geoVer, boundsMemo = station.bounds());
  /* station.belts() allocates a fresh array of {x,y,dir} — one split(',') per belt tile — on every
     call, and the frame called it once and handed it to three consumers. The model's belt graph
     cannot change without an onChange, and every consumer (conveyor.tick, conveyor.drawBelts, the
     ghost engine) treats it strictly read-only, so hand them all the SAME array for the edit. */
  const beltsMemoed = () => (beltsVer === geoVer && beltsMemo) ? beltsMemo : (beltsVer = geoVer, beltsMemo = station.belts());
  /* bayObjects, per (agentId, geometry). Also DEFENSIVE: world.js has always wrapped this call in a
     try/catch and REFIT called it bare, so one throw took out the whole validation layer (and with
     it every routing callout on the floor) instead of one bay's NO-COMPUTE check. */
  function bayObjectsMemoed(agentId) {
    if (bayObjVer !== geoVer || !bayObjMemo) { bayObjVer = geoVer; bayObjMemo = new Map(); }
    if (bayObjMemo.has(agentId)) return bayObjMemo.get(agentId);
    let objs = [];
    try { objs = station.bayObjects(agentId) || []; } catch (_) { objs = []; }
    bayObjMemo.set(agentId, objs);
    return objs;
  }
  let convey = null, lastFrameTs = 0;   // editor conveyor sim (boxes flow live as you build)
  let ghost = null;                     // GHOST PROJECTION (Phase 3): dedicated engine — never mixes with convey
  let propThumbs = [], lastThumbTs = 0; // visual prop palette: live animated preview tiles + redraw throttle
  let propQuery = '';                   // palette SEARCH text: non-empty = browse the whole catalog flat, ignoring tier/cat

  const T = () => (station ? station.TILE : 12);
  const MAX_REFIT_CHUNKS = 18;

  /* ---------- lifecycle ---------- */
  function init(o) { opts = o; }

  function open() {
    if (running) return;
    station = opts.getStation();
    if (!station) return;
    spaceHeld = false; drag = null; dragPid = null; dupe = null; flashes.length = 0;   // never inherit latched state from a prior session
    /* SESSION-SCOPED UI STATE (2026-08-07 conveyor audit). Everything here outlived close() and lied on the
       next open. The load-bearing one is `layerFailed`: renderDegraded is a TRUTHFUL-TELEMETRY readout —
       "a draw layer is currently failing" — and one transient throw in a session two hours ago had it
       asserting degradation forever, a state the harness could no longer prove. The rest are staleness:
       propCardKey made re-hovering the same prop after a reopen paint an EMPTY card (the key matched, so
       the body was never rebuilt), ordersSeenDone chimed completion for steps finished while REFIT was
       shut, and propQuery reopened the palette silently filtered by a search the Commander can't see. */
    for (const k in layerFailed) delete layerFailed[k];
    propCardKey = null; ordersSeenDone = null; propQuery = ''; lastTier = '';
    tool = 'select';   // SELECT is the default mode — a fresh REFIT session never opens with a placement tool armed
    ridePending = false; rideAgentId = null; ridePrevReach = null;   // the auto first-ride re-arms (and re-baselines its reach snapshot) from THIS session's compile, never a stale one
    // finish-the-line: fresh session state (the registry itself persists in localStorage) + one seam probe
    finSample = null; finKeySel = null; finSig = ''; finCardEl = null; finComp = null; valComps = null; lastStampIds = null; finPollTs = 0;
    for (const k in stampNameOf) delete stampNameOf[k];   // session-scoped blueprint-name placeholders (line naming)
    clearLineFields();   // a fresh session never inherits a prior floor's "where can this go" answers
    bumpGeo();           // …nor a prior floor's bounds/belts/bay-objects/mount memos (see geoVer)
    probeSampleSeam();
    buildDOM();
    if (opts.world && opts.world.stop) opts.world.stop();       // freeze the live sim
    document.body.classList.add('refit-on');
    updateSafetyClearance();
    unsub = station.onChange(p => {
      bakeDirty = true; planDirty = true;   // a real floor edit — the compiled plan is stale
      clearLineFields();   // …and so is every cached "where can this blueprint go" answer
      bumpGeo();           // …and every per-edit derived memo (bounds / belts / bayObjects / mounts / the readout census)
      /* A GLOBAL EDIT CANNOT BE INVALIDATED BY A RECTANGLE. The bake is cached in CHUNKS here, and
         `bakeDirtyRects` re-bakes only the chunks a rect touches — right for a deck or a prop, and
         WRONG for the shell, whose skin grouping and skirt ownership are station-wide. Drop the
         rect list entirely (null = re-bake everything) and latch it so a later rect-scoped edit in
         the same frame cannot re-narrow it. See the note on emit({global}) in worldmodel. */
      // ...and clear the pan-only flag, or a global edit arriving right after a pan would be
      // swallowed by `onlyMissingVisible` (which skips the dirty list entirely).
      if (p && p.global) { bakeDirtyRectsGlobal = true; bakeVisibleOnly = false; }
      const rects = p && p.dirtyRects;
      bakeDirtyRects = bakeDirtyRects && rects ? bakeDirtyRects.concat(rects) : (rects || bakeDirtyRects);
      if (bakeDirtyRectsGlobal) bakeDirtyRects = null;
      updateUndoRedo();
    });
    bakeDirty = true; bakeDirtyRects = null; bakeDirtyRectsGlobal = false; planDirty = true;
    frameFailures = 0;
    clearTimeout(frameRetryTimer); frameRetryTimer = 0;
    convey = (typeof Conveyor !== 'undefined') ? Conveyor.create({ onDeliver: onBuildDeliver, onAdvance: onBuildAdvance }) : null;
    ghost = (typeof GhostLine !== 'undefined') ? GhostLine.create() : null;   // Phase 3: fresh projection per session
    testNotes.length = 0;   // never carry a prior session's ride captions into a fresh REFIT
    statSig = zoomSig = '';   // the top readout re-derives from THIS session's station, never a stale signature
    lastFrameTs = 0;
    resize();
    fitCamera();
    updateUndoRedo();
    if (!hasSeen() && !tutorialCoaching()) showGuide();   // never stack this modal on the tutorial's own coaching (see tutorialCoaching)
    running = true;
    if (typeof SFX !== 'undefined') SFX.open();
    raf = requestAnimationFrame(frame);
  }

  function close() {
    if (!running) return;
    running = false;
    connectFrom = null;   // never carry a half-made connection across sessions
    if (raf) cancelAnimationFrame(raf), raf = 0;
    clearTimeout(frameRetryTimer); frameRetryTimer = 0;
    clearTimeout(tipTimer); tipTimer = 0;
    clearTimeout(rideTimer); rideTimer = 0; ridePending = false;   // a ride can't fire into a closed REFIT
    if (convey) convey.reset(), convey = null;
    if (ghost) ghost.reset(), ghost = null;
    propThumbs.length = 0; lastThumbTs = 0;   // free the preview tiles' canvases
    if (unsub) unsub(), unsub = null;
    if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
    finCardEl = null; finComp = null; finSig = '';   // the card's DOM dies with root below
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
        <span class="refit-sub" id="refit-sub"></span>
        <span class="refit-spacer"></span>
        <span class="refit-zoom" id="refit-zoom">
          <button class="bb sm refit-zoomb" id="refit-zout" title="zoom out (or scroll the wheel)">–</button>
          <button class="bb sm refit-zoomlvl" id="refit-zlvl" title="reset zoom to 1 tile = 1 tile">100%</button>
          <button class="bb sm refit-zoomb" id="refit-zin" title="zoom in (or scroll the wheel)">+</button>
        </span>
        <span class="refit-cluster" id="refit-history">
          <button class="bb sm" id="refit-undo" title="undo (Ctrl+Z)">↶ UNDO</button>
          <button class="bb sm" id="refit-redo" title="redo (Ctrl+Shift+Z)">↷ REDO</button>
        </span>
        <button class="bb sm" id="refit-fit" title="frame the station">⊹ FIT</button>
        <button class="bb sm" id="refit-test" title="send test work down your belts — watch it sort to the bays (no bot needed)">▸ TEST</button>
        <button class="bb sm" id="refit-help" title="how to build">? HELP</button>
        <button class="bb sm refit-primary" id="refit-done" title="finish + save (Esc)">✓ DONE</button>
      </div>
      <div class="refit-dock" role="toolbar" aria-label="Refit mode controls">
        <div class="refit-dock-head"><span class="refit-dock-head-t">BUILD KIT</span></div>
        <div class="refit-dock-section refit-mode-section">
          <div id="refit-tools"></div>
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
    const toolBtn = (t) => {
      const btn = document.createElement('button');
      btn.className = 'bb refit-tool refit-tool-' + t.id + (t.id === tool ? ' active' : '');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', t.id === tool ? 'true' : 'false');
      btn.dataset.tool = t.id;
      const ico = document.createElement('canvas');
      ico.className = 'refit-toolicon';
      // 8× supersample: every icon pixel lands on an exact 8px block in the backing store, so the
      // browser's downscale to the 16px display box is a clean box filter. Painting at ~1.3 device
      // px per icon pixel instead (with image-rendering:pixelated) doubles some rows and not others
      // — the bitmap comes out visibly lopsided, which is exactly what these icons are replacing.
      ico.width = ico.height = ICON_N * 8;
      btn.appendChild(ico);
      const nm = document.createElement('span'); nm.className = 'refit-toolname'; nm.textContent = t.label;
      btn.appendChild(nm);
      const k = document.createElement('span'); k.className = 'refit-key'; k.textContent = t.key;
      btn.appendChild(k);
      btn.title = t.hint + '  (' + t.key + ')';
      // clicking the ARMED tool's own button again DESELECTS it (back to select) — a tool must
      // always have an obvious off switch, not just eight other on switches.
      btn.onclick = () => selectTool(t.id === tool ? 'select' : t.id);
      return btn;
    };
    const byId = id => TOOLS.find(x => x.id === id);
    // SELECT rides its own full-width row above the groups — the cursor, not a fifth kind of build
    const selRow = document.createElement('div'); selRow.className = 'refit-tools refit-tools-sel';
    selRow.appendChild(toolBtn(byId('select')));
    tools.appendChild(selRow);
    TOOL_GROUPS.forEach(g => {
      const wrap = document.createElement('div'); wrap.className = 'refit-toolgroup';
      const lab = document.createElement('div'); lab.className = 'refit-group-label';
      lab.innerHTML = '<span class="refit-group-n">' + esc(g.label) + '</span><span class="refit-group-why">' + esc(g.why) + '</span>';
      wrap.appendChild(lab);
      const grid = document.createElement('div'); grid.className = 'refit-tools';
      g.tools.forEach(id => { const t = byId(id); if (t) grid.appendChild(toolBtn(t)); });
      wrap.appendChild(grid);
      tools.appendChild(wrap);
    });
    renderPalette();
    repaintIcons();
    setCursor();

    root.querySelector('#refit-done').onclick = close;
    root.querySelector('#refit-help').onclick = showGuide;
    root.querySelector('#refit-fit').onclick = () => { fitCamera(); };
    root.querySelector('#refit-zin').onclick = () => zoomStep(+1);
    root.querySelector('#refit-zout').onclick = () => zoomStep(-1);
    root.querySelector('#refit-zlvl').onclick = () => zoomTo(2);   // 2 = the entering default (a tile reads at 24px)
    root.querySelector('#refit-test').onclick = (e) => sendTestBoxes(e);
    undoBtn.onclick = () => { if (station.undo().ok) sfx('click'); else sfx('bad'); };
    redoBtn.onclick = () => { if (station.redo().ok) sfx('click'); else sfx('bad'); };

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    cv.addEventListener('pointerleave', () => { hoverRoomId = null; hoverPropId = null; hoverTile = null; if (!drag) hideTip(); hidePropCard(); });
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
  // The tier/category DISPLAY names now live with the catalog they describe (PropSprites), because the
  // palette is no longer their only reader — propsearch.js matches against them so typing what the tab
  // SAYS finds what the tab shows. Copying them here again is how the tab and the search drift apart.
  // Read LAZILY, not snapshotted into a const at IIFE-load time: this file is a plain <script> and a
  // const would freeze whatever PropSprites happened to be when build.js parsed. index.html loads
  // propsprites.js first today, but a silently-empty label map is a miserable way to find that out.
  const TIER_LABEL = () => (typeof PropSprites !== 'undefined' && PropSprites.TIER_LABEL) || {};
  const CAT_LABEL = () => (typeof PropSprites !== 'undefined' && PropSprites.CAT_LABEL) || {};
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

  /* ---------- palette SEARCH (the flat way into a 120-prop catalog) ----------
     PropSearch owns the matching rules and is unit-tested against the real catalog; everything here is
     presentation. Two things are load-bearing and easy to get wrong:
       1. a keystroke rebuilds the GALLERY ONLY — never the row holding the <input>, or focus dies;
       2. while a search is up the tier/cat rows are HIDDEN, not just ignored. A lit "LOUNGE" tab above a
          grid of workstations is the UI asserting something false about what you're looking at. */
  const catLabelOf = c => CAT_LABEL()[c] || String(c || '').toUpperCase();
  const tierLabelOf = t => TIER_LABEL()[t] || String(t || '').toUpperCase();
  // the power word printed on the tile's badge (COMPUTE / WEB / FILES / …), or '' for inert decor.
  // It is on screen, so it has to be typeable — the prop -> capability map lives in the world model.
  const grantLabelOf = c => ((typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp)
    ? (WorldModel.grantLabelForProp(c && c.id) || '') : '');
  // one options bundle so the palette and the unit test match on IDENTICAL surfaces
  const searchOpts = () => ({ catLabel: catLabelOf, tierLabel: tierLabelOf, extra: grantLabelOf });
  const isSearching = () => (typeof PropSearch !== 'undefined') && PropSearch.active(propQuery);

  // what the gallery is showing right now: matches across the WHOLE catalog, or the chosen tab
  function propsForGrid() {
    if (isSearching()) return PropSearch.matchProps(catalog(), propQuery, searchOpts());
    const CATS = (typeof PropSprites !== 'undefined') ? PropSprites.CATS : {};
    return CATS[propCat] || [];
  }

  /* Leave search mode and go back to browsing. This must rebuild the WHOLE palette, not just the
     gallery: picking a prop out of a search result moves propTier/propCat to that prop's own drawer,
     so the tier and category buttons carry stale `active` classes until they are re-created. Clearing
     with only a grid re-render is what left the palette showing WORKSTATIONS with nothing lit while a
     beanbag was the armed prop. Re-focus the field afterwards — the caller is still typing. */
  function clearSearch({ refocus = true } = {}) {
    propQuery = '';
    renderPalette();
    if (!refocus) return;
    const f = root && root.querySelector('#refit-propsearch-input');
    if (f) f.focus();
  }

  function propSearchRow() {
    const row = document.createElement('div'); row.className = 'refit-propsearch';
    const inp = document.createElement('input');
    // type=text, NOT type=search — a search field gets the UA's own ✕ and cancel affordance, which is raw
    // OS chrome sitting inside a CRT panel (the no-white-controls order). We draw our own clear key.
    inp.type = 'text';
    inp.className = 'refit-input refit-searchfield';
    inp.id = 'refit-propsearch-input';
    inp.value = propQuery;
    inp.spellcheck = false;
    inp.autocomplete = 'off';
    inp.setAttribute('aria-label', 'Search props');
    // the count is READ from the catalog — a hardcoded "120" becomes a lie the first time a prop lands
    inp.placeholder = 'SEARCH ' + catalog().length + ' PROPS — NAME OR CATEGORY';
    inp.oninput = () => { propQuery = inp.value; renderPropGrid(); };
    inp.onkeydown = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();   // a clear must never bubble out and close REFIT behind the Commander
      if (inp.value) { clearSearch(); sfx('click'); }
      else inp.blur();        // an already-empty field hands Escape back to the editor
    };
    row.appendChild(inp);

    const clr = document.createElement('button');
    clr.type = 'button';
    clr.className = 'bb sm refit-searchclear';
    clr.textContent = '✕';
    clr.title = 'clear search';
    clr.onclick = () => { clearSearch(); sfx('click'); };
    row.appendChild(clr);
    return row;
  }

  /* rebuild ONLY the gallery (and the rows a search hides). Runs on every keystroke and every tile
     pick, so it must never re-create the <input> above it. */
  function renderPropGrid() {
    const host = root && root.querySelector('#refit-propgrid-host');
    if (!host) return;
    const on = isSearching();
    // .refit-tiers/.refit-propcats declare `display:flex`, which beats the UA's [hidden] rule — so the
    // visibility toggle has to be an inline display, not the hidden attribute.
    const tiers = root.querySelector('.refit-tiers'), cats = root.querySelector('.refit-propcats');
    if (tiers) tiers.style.display = on ? 'none' : '';
    if (cats) cats.style.display = on ? 'none' : '';
    const clr = root.querySelector('.refit-searchclear');
    if (clr) clr.style.display = propQuery ? '' : 'none';

    propThumbs.length = 0;   // the gallery is the only thumb source; free the outgoing tiles' canvases
    host.innerHTML = '';
    const list = propsForGrid();
    if (on) {
      const note = document.createElement('div');
      note.className = 'refit-searchnote' + (list.length ? '' : ' none');
      note.textContent = list.length
        ? list.length + (list.length === 1 ? ' MATCH' : ' MATCHES') + ' · ALL TIERS'
        : 'NO PROP MATCHES "' + propQuery.trim().toUpperCase() + '"';
      host.appendChild(note);
    }
    const grid = document.createElement('div'); grid.className = 'refit-propgrid';
    grid.setAttribute('aria-label', 'Props');
    list.forEach(c => grid.appendChild(propTile(c)));
    host.appendChild(grid);
    try { paintThumbs(performance.now()); } catch (e) {}   // first frame now, so the gallery isn't blank for a beat
  }

  function renderPalette() {
    const pal = root.querySelector('#refit-palette');
    if (!pal) return;
    bumpUi();   // the dock is about to change height/width — positionFinCard must re-measure it
    const section = root.querySelector('#refit-option-section');
    const label = root.querySelector('#refit-palette-label');
    let paletteLabel = '';
    pal.innerHTML = '';
    propThumbs.length = 0;   // drop any preview tiles from a prior render (they're rebuilt below for the prop tool)
    if (tool === 'select') {
      paletteLabel = 'INSPECT';
      const note = document.createElement('div');
      note.className = 'refit-selectnote';
      note.textContent = 'Click a machine to open it · click a belt to see where its lane goes. Keys 1–9 arm a build tool; ESC / right-click always returns here.';
      pal.appendChild(note);
    } else if (tool === 'room') {
      /* ROOM TYPE was the last palette in REFIT still made of bare text chips, next to a prop
         gallery of live animated previews and a material grid painted by the real bake. A room
         kind IS a deck (a hue × a material), so it can preview itself the same honest way every
         other surface here does — through StationBake, so the chip can never promise a floor the
         station won't deliver. Now you pick FOUNDRY because you can see the rust tread. */
      paletteLabel = 'TYPE';
      const grid = document.createElement('div'); grid.className = 'refit-matgrid refit-kindgrid';
      grid.setAttribute('aria-label', 'Room types');
      station.KIND_ORDER.forEach(k => {
        const def = station.ROOM_KINDS[k]; if (!def) return;
        const active = k === kind;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'refit-mattile refit-kindtile' + (active ? ' active' : '');
        b.dataset.kind = k;
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
        const hue = (station.FLOOR_STYLES[def.floor] || station.FLOOR_STYLES.hull).base;
        b.appendChild(matSwatchCanvas(def.mat || 'plate', hue, 5, 3));
        const nm = document.createElement('span'); nm.className = 'refit-matname'; nm.textContent = def.label;
        b.appendChild(nm);
        const hueDef = station.FLOOR_STYLES[def.floor];
        b.title = def.label + ' — ' + ((station.FLOOR_MATERIALS[def.mat] || {}).label || def.mat || 'plate')
          + ' deck in ' + ((hueDef && hueDef.label) || def.floor) + ' (SURFACE re-lays it any time)';
        b.onclick = () => { kind = k; renderPalette(); setHint(); sfx('click'); };
        grid.appendChild(b);
      });
      pal.appendChild(grid);
      const note = document.createElement('div');
      note.className = 'refit-linenote';
      note.textContent = 'A type is just the deck it starts with — SURFACE (3) re-lays any room later.';
      pal.appendChild(note);
    } else if (tool === 'hall') {
      paletteLabel = 'WIDTH';
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
      paletteLabel = 'CATALOG';
      const CATS = (typeof PropSprites !== 'undefined') ? PropSprites.CATS : {};
      if (TIER_ORDER.indexOf(propTier) < 0) propTier = 'functional';
      let cats = catsForTier(propTier);
      if (cats.indexOf(propCat) < 0) { propCat = cats[0]; if (CATS[propCat] && CATS[propCat][0]) propType = CATS[propCat][0].id; }
      // row -1 — SEARCH. Two tiers × ~11 category tabs is a fine map once you know which drawer a thing
      // lives in and useless when you don't; with 120 props the taxonomy became the slow path. A query
      // here goes FLAT across the whole catalog (both tiers, every category) and hides the browse rows
      // while it's active, so what's on screen never disagrees with the lit tab.
      pal.appendChild(propSearchRow());
      // row 0 — the TIER toggle: a clear, hard split between props that DO something and props that are just looks
      const tierRow = document.createElement('div'); tierRow.className = 'refit-tiers';
      tierRow.setAttribute('aria-label', 'Prop tiers');
      TIER_ORDER.forEach(t => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bb sm refit-tier refit-tier-' + t + (t === propTier ? ' active' : '');
        b.setAttribute('aria-pressed', t === propTier ? 'true' : 'false');
        b.textContent = tierLabelOf(t);
        b.onclick = () => { propQuery = ''; propTier = t; const cs = catsForTier(t); propCat = cs[0]; if (CATS[propCat] && CATS[propCat][0]) propType = CATS[propCat][0].id; hidePropCard(); renderPalette(); setHint(); sfx('click'); };
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
        b.textContent = catLabelOf(g);
        b.onclick = () => { propQuery = ''; propCat = g; if (CATS[g] && CATS[g][0]) propType = CATS[g][0].id; hidePropCard(); renderPalette(); setHint(); sfx('click'); };
        catRow.appendChild(b);
      });
      pal.appendChild(catRow);
      // row 2 — a scrollable gallery of LIVE previews: each tile draws the real animated sprite, not just its name.
      // It lives in its own HOST because every keystroke rebuilds the gallery and NOTHING else: re-running
      // renderPalette() here would replace the <input> mid-word and the field would lose focus (and the caret)
      // after a single character — the classic way a search box ships broken.
      const gridHost = document.createElement('div'); gridHost.id = 'refit-propgrid-host';
      pal.appendChild(gridHost);
      renderPropGrid();
    } else if (tool === 'paint') {
      /* SURFACE — TWO AXES, TWO SECTIONS: the MATERIAL (what the surface is made of) and the HUE
         (what colour it is). They compose — every material renders in whatever colour is selected
         — so the Commander picks a room's finish the way you'd pick flooring: the stuff, then the
         shade. Both sections speak the SAME card language as the prop gallery (a dark inset chip
         with a phosphor rim). They used to be bare <button>s with only a border declared, which
         let the UA paint its own grey buttonface + Arial behind every material name — raw HTML
         chrome sitting inside a CRT panel. Never ship a bare button here. */
      /* THREE surfaces now, not two (2026-08-05). DECK and WALLS dress the inside of a room; SHELL is
         what the station shows the sky — and it was the one surface with no palette at all. Same two
         sections, same card language: adding the axis is a third target, not a third panel. */
      const walls = paintTarget === 'walls', shell = paintTarget === 'hull';
      paletteLabel = shell ? 'SHELL' : walls ? 'WALLS' : 'DECK';
      const styles = station.FLOOR_STYLES || {};
      const matCatalog = shell ? (station.HULL_MATERIALS || {}) : walls ? (station.WALL_MATERIALS || {}) : (station.FLOOR_MATERIALS || {});
      const order = shell ? (station.HULL_ORDER || Object.keys(matCatalog))
        : walls ? (station.WALL_ORDER || Object.keys(matCatalog)) : (station.MAT_ORDER || Object.keys(matCatalog));
      const curMat = shell ? hullMat : walls ? wallMat : mat;
      const curHue = shell ? hullStyle : walls ? wallStyle : style;
      // AUTO is a MODE, not a colour, on both whole-room surfaces — see the auto chip below
      const autoOn = shell ? (hullStyle === 'follow') : (walls && wallStyle === 'follow');
      // a section caption that NAMES the live selection, so the chosen recipe and tone are readable
      // as WORDS and not only as a lit chip (21 hues can't each carry a label without a wall of text)
      const cap = (caption, value) => {
        const wrap = document.createElement('div'); wrap.className = 'refit-palcap';
        const k = document.createElement('span'); k.className = 'refit-palcap-k'; k.textContent = caption;
        wrap.appendChild(k);
        if (value) { const v = document.createElement('span'); v.className = 'refit-palcap-v'; v.textContent = value; wrap.appendChild(v); }
        pal.appendChild(wrap);
      };

      // TARGET — deck or walls. Two surfaces, one palette; reuses the tier-toggle idiom.
      const tgt = document.createElement('div'); tgt.className = 'refit-tiers';
      tgt.setAttribute('aria-label', 'Surface target');
      [['floor', '▧ DECK'], ['walls', '▤ WALLS'], ['hull', '▥ SHELL']].forEach(([id, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bb sm refit-tier refit-painttarget' + (paintTarget === id ? ' active' : '');
        b.dataset.target = id;
        b.setAttribute('aria-pressed', paintTarget === id ? 'true' : 'false');
        b.textContent = label;
        b.onclick = () => { paintTarget = id; renderPalette(); setHint(); sfx('click'); };
        tgt.appendChild(b);
      });
      pal.appendChild(tgt);

      cap('MATERIAL', (matCatalog[curMat] && matCatalog[curMat].label) || '');
      const matGrid = document.createElement('div'); matGrid.className = 'refit-matgrid';
      matGrid.setAttribute('aria-label', shell ? 'Shell materials' : walls ? 'Wall materials' : 'Deck materials');
      order.forEach(mid => {
        const def = matCatalog[mid];
        if (!def) return;
        const active = mid === curMat;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'refit-mattile' + (active ? ' active' : '');
        b.dataset.mat = mid;
        b.dataset.surface = shell ? 'hull' : walls ? 'wall' : 'floor';
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
        // a MATERIAL patch big enough to READ: five tiles across by three down clears a full cell
        // of every recipe in the catalog (SPINE's 4x3 bolted bay is the widest), so the bays, the
        // grate holes and PLANK's 5x1 boards are told apart at a glance. Drawn 1:1 at the bake's
        // own 12px tile — pixel art is never scaled, and ten patches must still fit without the
        // dock growing into a full-height wall.
        b.appendChild(shell ? hullSwatchCanvas(mid, hullBaseFor(mid), 5, 34)
          : walls ? wallSwatchCanvas(mid, wallBaseFor(mid), 5, 30) : matSwatchCanvas(mid, styleBaseFor(mid), 5, 3));
        const nm = document.createElement('span'); nm.className = 'refit-matname'; nm.textContent = def.label;
        b.appendChild(nm);
        // the shell catalog carries a one-line blurb — nine exteriors is past the point where a name
        // alone teaches the difference between CLAPBOARD and SHINGLE
        b.title = shell ? (def.label + ' — ' + (def.blurb || 'shell')) : def.label + (walls ? ' walls' : ' deck');
        // picking a material also moves the hue to the one it was drawn for (wood wants a wood
        // tone) — visibly, in the row below, so the Commander can still override it right after.
        b.onclick = () => {
          // SHELL keeps AUTO rather than pinning the suggested hue: on this axis AUTO already MEANS
          // "the tone this material was drawn for", so pinning it would only make the next material
          // pick inherit the previous one's colour.
          if (shell) hullMat = mid;
          else if (walls) { wallMat = mid; if (def.suggest && styles[def.suggest]) wallStyle = def.suggest; }
          else { mat = mid; if (def.suggest && styles[def.suggest]) style = def.suggest; }
          renderPalette(); setHint(); sfx('click');
        };
        matGrid.appendChild(b);
      });
      pal.appendChild(matGrid);

      cap('COLOUR', autoOn ? 'AUTO' : ((styles[curHue] && styles[curHue].label) || ''));
      const hueGrid = document.createElement('div'); hueGrid.className = 'refit-huegrid';
      hueGrid.setAttribute('aria-label', shell ? 'Shell colours' : walls ? 'Wall colours' : 'Deck colours');
      if (walls || shell) {
        // AUTO — walls inherit the room's deck hue; a SHELL has no deck to inherit, so its AUTO is
        // the tone its material was drawn for (TIMBER→walnut, BRICK→rust, STATION→the shell grey it
        // shipped as). Either way it's the default and the one most people want, so it leads. It is
        // NOT a colour but a MODE, which is why it takes its own full-width row instead of standing
        // in the grid as a 22nd chip.
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'refit-hue refit-hue-auto' + (autoOn ? ' active' : '');
        b.dataset.hue = 'follow';
        b.setAttribute('aria-pressed', autoOn ? 'true' : 'false');
        // preview what AUTO itself yields — the material's own tone, ignoring any hue currently picked
        b.appendChild(shell ? hullSwatchCanvas(hullMat, hullAutoBase(hullMat), 3, 28) : wallSwatchCanvas(wallMat, null, 3, 24));
        const nm = document.createElement('span'); nm.className = 'refit-matname';
        nm.textContent = shell ? 'AUTO — THE MATERIAL’S OWN TONE' : 'AUTO — MATCH THE DECK';
        b.appendChild(nm);
        b.title = shell ? 'the tone this material was drawn for' : 'match the room’s deck colour';
        b.onclick = () => { if (shell) hullStyle = 'follow'; else wallStyle = 'follow'; renderPalette(); sfx('click'); };
        hueGrid.appendChild(b);
      }
      // every hue chip previews the CURRENTLY SELECTED MATERIAL in that tone, painted by the real
      // bake — so the row answers "what does PLANK look like in COBALT?" instead of showing a flat
      // colour the station will never actually render.
      Object.keys(styles).forEach(sid => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'refit-hue' + (sid === curHue ? ' active' : '');
        b.dataset.hue = sid;
        b.setAttribute('aria-pressed', sid === curHue ? 'true' : 'false');
        b.appendChild(shell ? hullSwatchCanvas(hullMat, styles[sid].base, 3, 28)
          : walls ? wallSwatchCanvas(wallMat, styles[sid].base, 3, 24) : matSwatchCanvas(mat, styles[sid].base, 3, 2));
        b.title = styles[sid].label;
        b.onclick = () => { if (shell) hullStyle = sid; else if (walls) wallStyle = sid; else style = sid; renderPalette(); sfx('click'); };
        hueGrid.appendChild(b);
      });
      pal.appendChild(hueGrid);
    } else if (tool === 'belt') {
      /* THE ONE SENTENCE (belt-tool idle state): this palette used to be empty, so the first time a
         user armed the BELT tool the system introduced itself with nothing. Lead with the model. */
      paletteLabel = 'THE LINE';
      const intro = document.createElement('div');
      intro.className = 'refit-lineintro';
      intro.textContent = LINE_SENTENCE;
      pal.appendChild(intro);
    } else if (tool === 'line') {
      /* STARTER LINES v2 — one-click whole layouts (the beginner onramp). Uniform full-width
         cards, every card the same anatomy: a schematic MINIATURE of what will stamp (drawn in
         the floor's own colour economy), the NAME + a footprint/dock chip, and a one-line
         purpose — so the shelf teaches what each line DOES before the first click. */
      paletteLabel = 'BLUEPRINTS';
      const intro = document.createElement('div');
      intro.className = 'refit-lineintro';
      intro.textContent = LINE_SENTENCE + ' Stamp a working line, then make it yours.';
      pal.appendChild(intro);
      const grid = document.createElement('div'); grid.className = 'refit-linegrid';
      grid.setAttribute('aria-label', 'Starter lines');
      for (const bp of blueprints()) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'refit-linetile' + (bp.id === lineType ? ' active' : '');
        b.dataset.line = bp.id;
        b.setAttribute('aria-pressed', bp.id === lineType ? 'true' : 'false');
        b.title = bp.desc;   // adopted by tooltip.js into the station card (never the OS bubble)
        const view = document.createElement('span'); view.className = 'refit-linetile-view';
        view.appendChild(lineSchematic(bp));
        b.appendChild(view);
        const hd = document.createElement('span'); hd.className = 'refit-linetile-hd';
        const nm = document.createElement('span'); nm.className = 'refit-matname'; nm.textContent = bp.label;
        hd.appendChild(nm);
        // footprint + dock count, derived from the catalog (never hand-kept). Mixed VT323 glyphs
        // ('×', '·') fall back fonts, so the chip is BOX-centred in CSS — never padded by font math.
        const docks = bp.props.filter(p => p.t === 'bay').length;
        const stat = document.createElement('span'); stat.className = 'refit-linetile-stat';
        stat.textContent = bp.w + '×' + bp.h + ' · ' + docks + (docks === 1 ? ' DOCK' : ' DOCKS');
        hd.appendChild(stat);
        b.appendChild(hd);
        const why = document.createElement('span'); why.className = 'refit-linetile-why';
        why.textContent = LINE_PURPOSE[bp.id] || '';
        b.appendChild(why);
        /* DECK-FIT HONESTY. Offering a line the current floor has nowhere to put it is an offer the
           deck cannot keep — the user aims, gets red everywhere, and learns nothing. The card says
           so up front, from the SAME canPlaceBlueprint scan the ghost snaps to. It stays selectable
           (sandbox law: never gate) — arming it just shows an empty field and this reason. */
        if (!lineFits(bp.id)) {
          b.classList.add('nofit');
          const nf = document.createElement('span'); nf.className = 'refit-linetile-nofit';
          nf.textContent = 'NO ROOM ON THIS DECK — NEEDS ' + bp.w + '×' + bp.h + ' OF CLEAR FLOOR';
          b.appendChild(nf);
        }
        b.onclick = () => { lineType = bp.id; renderPalette(); setHint(); frameBlueprint(); sfx('click'); };
        grid.appendChild(b);
      }
      pal.appendChild(grid);
      const note = document.createElement('div');
      note.className = 'refit-linenote';
      note.textContent = 'BAYS STAMP EMPTY — CLICK EACH ONE TO ASSIGN AN AGENT · ONE UNDO REMOVES THE WHOLE LINE';
      pal.appendChild(note);
    }
    /* NAME THE ARMED TOOL IN THE OPTIONS HEADER. The two zones of this dock — the tool you picked
       and the options for it — were only related by adjacency: "ROOM TYPE" over a grid of decks
       does not say WHICH tool it belongs to, and the connection is the whole reason the options
       changed. The header now reads `ROOM ▸ TYPE`, the armed tool in phosphor. */
    if (label) {
      const t = TOOLS.find(x => x.id === tool);
      label.innerHTML = t
        ? '<span class="refit-pl-tool">' + esc(t.label) + '</span><span class="refit-pl-sep">▸</span>'
          + '<span class="refit-pl-what">' + esc(paletteLabel || 'OPTIONS') + '</span>'
        : esc(paletteLabel || 'OPTIONS');
    }
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
    // Grid-only re-render: a full renderPalette() here would rebuild the search field and steal focus
    // out of it mid-search. But a pick out of a SEARCH result does change tab state — the prop almost
    // always lives under a different tier/category than the one still selected behind the results. Move
    // the tabs to the prop's own drawer NOW (silently, no re-render) so that whenever the search is
    // cleared the palette opens on the shelf holding what you actually armed, with the tile lit. Without
    // this, clearing dropped you back on WORKSTATIONS with nothing selected while a beanbag was armed.
    b.onclick = () => {
      propType = c.id;
      if (isSearching()) { propTier = c.tier || 'cosmetic'; propCat = c.cat || propCat; }
      renderPropGrid(); setHint(); sfx('click');
    };
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
    }
    // (the old '○' walkable marker is gone — playtesting showed it read as an unexplained mystery badge;
    //  the hover card already states "N×M · walkable", which is where that fact is actually legible)
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

  const SWATCH_TILE = 12;   // the bake's own tile size — samples are drawn 1:1, never scaled

  /* the hue a DECK material's chip previews in. The SELECTED material previews in the hue that is
     actually selected: anything else lets a chip promise a look the deck won't deliver once you
     override its suggested tone (pick PLANK, then COBALT, and a walnut chip is now a lie). An
     UNSELECTED material previews in its own suggested tone, which stays honest because clicking it
     MOVES the hue there — the chip is showing you what that click produces. */
  function styleBaseFor(mid) {
    const def = station.FLOOR_MATERIALS && station.FLOOR_MATERIALS[mid];
    const sid = (mid !== mat && def && def.suggest && station.FLOOR_STYLES[def.suggest]) ? def.suggest : style;
    return (station.FLOOR_STYLES[sid] || station.FLOOR_STYLES.hull).base;
  }
  /* the material chip is rendered by the REAL bake (StationBake.sampleMaterial paints through the
     same per-tile painters the station uses), so a deck preview can never promise a look the
     station won't deliver. Falls back to the flat colour chip if the bake module isn't loaded. */
  function matSwatchCanvas(mid, base, cols, rows) {
    const w = (cols || 4) * SWATCH_TILE, h = (rows || 2) * SWATCH_TILE;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    x.fillStyle = base; x.fillRect(0, 0, w, h);
    try { if (typeof StationBake !== 'undefined' && StationBake.sampleMaterial) StationBake.sampleMaterial(x, mid, base, cols || 4, rows || 2, SWATCH_TILE); }
    catch (e) { /* a swatch must never break the palette */ }
    return c;
  }

  // the hue a WALL chip previews in — same honesty rule as styleBaseFor. AUTO has no hue of its
  // own, so it borrows the currently selected deck colour, which is exactly what "match the deck"
  // will produce.
  function wallBaseFor(mid) {
    const def = station.WALL_MATERIALS && station.WALL_MATERIALS[mid];
    if (wallStyle !== 'follow' && station.FLOOR_STYLES[wallStyle]) return station.FLOOR_STYLES[wallStyle].base;
    const sid = (mid !== wallMat && def && def.suggest && station.FLOOR_STYLES[def.suggest]) ? def.suggest : style;
    return (station.FLOOR_STYLES[sid] || station.FLOOR_STYLES.hull).base;
  }
  /* the hue a SHELL chip previews in. Distinct from wallBaseFor in one way that matters: AUTO here
     resolves to the MATERIAL's own suggested tone, and for STATION that suggestion is null — which
     is not a missing value but the shell's own grey, and the bake must be told null to paint it. */
  function hullAutoBase(mid) {
    const def = station.HULL_MATERIALS && station.HULL_MATERIALS[mid];
    const sid = def && def.suggest;
    return (sid && station.FLOOR_STYLES[sid]) ? station.FLOOR_STYLES[sid].base : null;
  }
  function hullBaseFor(mid) {
    if (hullStyle !== 'follow' && station.FLOOR_STYLES[hullStyle]) return station.FLOOR_STYLES[hullStyle].base;
    return hullAutoBase(mid);
  }
  // same contract as the other two: painted by the REAL hull recipes. A shell chip shows the plate
  // ring AND the skirt below it, because those are two different surfaces of one material and a
  // preview of only the ring can't tell TIMBER from CLAPBOARD (see the sampleHull note).
  function hullSwatchCanvas(mid, base, cols, height) {
    const w = (cols || 4) * SWATCH_TILE, h = height || 32;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    const b = base === undefined ? hullBaseFor(mid) : base;
    x.fillStyle = b || '#191712'; x.fillRect(0, 0, w, h);
    try { if (typeof StationBake !== 'undefined' && StationBake.sampleHull) StationBake.sampleHull(x, mid, b, cols || 4, h, SWATCH_TILE); }
    catch (e) { /* a swatch must never break the palette */ }
    return c;
  }

  // same contract as matSwatchCanvas: painted by the REAL wall recipes, never a hand-drawn mock
  function wallSwatchCanvas(mid, base, cols, height) {
    const w = (cols || 4) * SWATCH_TILE, h = height || 26;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    const b = base || wallBaseFor(mid);
    x.fillStyle = b; x.fillRect(0, 0, w, h);
    try { if (typeof StationBake !== 'undefined' && StationBake.sampleWall) StationBake.sampleWall(x, mid, b, cols || 4, h, SWATCH_TILE); }
    catch (e) { /* a swatch must never break the palette */ }
    return c;
  }

  /* ---------- STARTER LINES (blueprints): palette schematics + ghost + stamp ----------
     The catalog lives in WorldModel.BLUEPRINTS (pure, headless-tested); everything here is
     presentation + the same ghost/commit shape every other tool uses. */
  const blueprints = () => (typeof WorldModel !== 'undefined' && WorldModel.BLUEPRINTS) || [];
  const blueprintOf = id => { for (const b of blueprints()) if (b.id === id) return b; return null; };
  // stamp centered under the cursor (a 17-tile line hung off the click point reads as a misfire)
  const lineOrigin = (bp, tx, ty) => ({ x: tx - (bp.w >> 1), y: ty - (bp.h >> 1) });
  // one-line purposes for the shelf cards — what each line DOES, in station voice
  const LINE_PURPOSE = {
    research_line: 'two agents in a row — one digs, the next writes it up',
    sorting_office: 'sorts arriving work by content to the right specialist',
    parallel_crew: 'splits one stream across three agents working at once',
    ship_out: 'one agent, straight to the outbox — the minimal line',
  };
  /* schematic v2 — the card draws a MINIATURE of what will stamp, in the floor's own colour
     economy (hex families lifted from propsprites.js RAMP.steel/ACC and conveyor.js's belt bed)
     so the schematic teaches the real floor: the INBOX feeds amber, a BAY is a steel berth with
     the green nameplate pip, the OUTBOX is the dark dispatch chute, a FILTER's out-lanes tint
     like its route tips (cyan coded lane / neutral default), a SPLITTER fans teal. */
  const SCHEME = {
    line: '#06090c',                                                       // universal silhouette outline
    steel: { top: '#3f4b53', face: '#303a41', lit: '#515e67', dk: '#242e35' },  // RAMP.steel, pre-dimmed
    bed: '#161c1a', rail: '#46544c', chev: '#7a8a80',                      // conveyor bed + rails
    amber: '#ffd34a', amberDk: '#caa84a', throat: '#1a1410',               // INBOX feed (ACC.flow family)
    green: '#5ad1b3', greenHot: '#7df0c8',                                 // BAY pip / dispatch family
    chute: '#08130f', chuteBody: '#101614', chuteTop: '#1c2420',           // OUTBOX dark chute
    plate: '#0e1c16',                                                      // bay nameplate inset
    cyan: '#4ad9ff', violet: '#b44aff', violetHot: '#d8b8ff', neutral: '#8a9a90', merge: '#e0a45a',
  };
  const LINE_DIR = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
  // follow each junction's out-lanes belt-by-belt so the schematic can tint them — derived from
  // the catalog's belts + routes, never hand-authored per blueprint.
  function traceLanes(bp) {
    const at = {}; for (const b of bp.belts) at[b.x + ',' + b.y] = b;
    const tint = {}, fans = [];
    const paint = (sx, sy, d, col) => {
      let dx = LINE_DIR[d][0], dy = LINE_DIR[d][1], x = sx + dx, y = sy + dy, b = at[x + ',' + y], guard = 0;
      while (b && guard++ < 64) {
        if (!tint[x + ',' + y]) tint[x + ',' + y] = col;
        dx = LINE_DIR[b.d][0]; dy = LINE_DIR[b.d][1]; x += dx; y += dy; b = at[x + ',' + y];
      }
    };
    for (const p of bp.props) {
      if (p.t === 'filter') {
        const dirs = [];
        for (const k of Object.keys(p.routes || {})) { paint(p.x, p.y, p.routes[k], SCHEME.cyan); dirs.push({ d: p.routes[k], col: SCHEME.cyan }); }
        if (p.def) { paint(p.x, p.y, p.def, SCHEME.neutral); dirs.push({ d: p.def, col: SCHEME.neutral }); }
        fans.push({ p, dirs });
      } else if (p.t === 'splitter' || p.t === 'merger') {
        const col = p.t === 'splitter' ? SCHEME.green : SCHEME.merge, dirs = [];
        for (const d of ['N', 'E', 'S', 'W']) {
          const b = at[(p.x + LINE_DIR[d][0]) + ',' + (p.y + LINE_DIR[d][1])];
          if (b && b.d === d) { paint(p.x, p.y, d, col); dirs.push({ d, col }); }   // points AWAY = out-lane
        }
        fans.push({ p, dirs });
      }
    }
    return { tint, fans };
  }
  // a direction chevron (">" turned to d) built from u-sized blocks — belts must say WHICH WAY
  function lineChev(x2, cx, cy, d, col, u) {
    const E = [[-1, -2], [0, -1], [1, 0], [0, 1], [-1, 2]];
    x2.fillStyle = col;
    for (const o of E) {
      let ox = o[0], oy = o[1];
      if (d === 'W') ox = -o[0];
      else if (d === 'S') { ox = o[1]; oy = o[0]; }
      else if (d === 'N') { ox = o[1]; oy = -o[0]; }
      x2.fillRect(cx + ox * u, cy + oy * u, u, u);
    }
  }
  // the oblique-kit body in miniature: silhouette ring, face, lit top band — reads "machine"
  function lineBody(x2, X, Y, W, H, top, face, lit, dk) {
    x2.fillStyle = SCHEME.line; x2.fillRect(X - 1, Y - 1, W + 2, H + 2);
    x2.fillStyle = face; x2.fillRect(X, Y, W, H);
    x2.fillStyle = top; x2.fillRect(X, Y, W, Math.max(2, Math.round(H * 0.42)));
    x2.fillStyle = lit; x2.fillRect(X, Y, W, 1);
    x2.fillStyle = dk; x2.fillRect(X, Y + H - 1, W, 1);
  }
  function lineSchematic(bp) {
    // per-blueprint tile scale: fill the card's fixed viewport without ever scaling the canvas
    const S = Math.max(4, Math.min(14, Math.floor(236 / bp.w), Math.floor(64 / bp.h)));
    const PAD = 2, u = S >= 12 ? 2 : 1;
    const c = document.createElement('canvas');
    c.className = 'refit-linetile-cv';
    c.width = bp.w * S + PAD * 2; c.height = bp.h * S + PAD * 2;
    c.style.width = c.width + 'px'; c.style.height = c.height + 'px';   // 1:1 — pixel art is never scaled
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    x.translate(PAD, PAD);
    const lanes = traceLanes(bp);
    for (const b of bp.belts) {              // belts first (floor machinery): bed, rails, chevron
      const bx = b.x * S, by = b.y * S, horiz = b.d === 'E' || b.d === 'W';
      x.fillStyle = SCHEME.bed; x.fillRect(bx, by, S, S);
      const t = lanes.tint[b.x + ',' + b.y];
      if (t) { x.globalAlpha = 0.16; x.fillStyle = t; x.fillRect(bx, by, S, S); x.globalAlpha = 1; }
      x.fillStyle = SCHEME.rail;
      if (horiz) { x.fillRect(bx, by, S, 1); x.fillRect(bx, by + S - 1, S, 1); }
      else { x.fillRect(bx, by, 1, S); x.fillRect(bx + S - 1, by, 1, S); }
      lineChev(x, bx + (S >> 1), by + (S >> 1), b.d, t || SCHEME.chev, u);
    }
    for (const p of bp.props) {
      const X = p.x * S, Y = p.y * S, W = p.w * S, H = p.h * S;
      const m = Math.max(2, S >> 2), st = SCHEME.steel;
      if (p.t === 'intake') {                // INBOX — steel casing around the amber feed throat
        lineBody(x, X, Y, W, H, st.top, st.face, st.lit, st.dk);
        x.fillStyle = SCHEME.throat; x.fillRect(X + m, Y + m, W - m * 2, H - m * 2);
        x.fillStyle = SCHEME.amberDk; x.fillRect(X + m + 1, Y + m + 1, W - m * 2 - 2, H - m * 2 - 2);
        x.fillStyle = SCHEME.amber; x.fillRect(X + m + 1, Y + m + 1, W - m * 2 - 2, u);
      } else if (p.t === 'bay') {            // BAY — steel berth, green nameplate pip, amber berth ticks
        lineBody(x, X, Y, W, H, st.top, st.face, st.lit, st.dk);
        const nh = Math.max(2, Math.round(H * 0.30));
        x.fillStyle = SCHEME.plate; x.fillRect(X + m, Y + m, W - m * 2, nh);
        x.fillStyle = SCHEME.green; x.fillRect(X + (W >> 1) - u, Y + m + (nh >> 1) - (u >> 1), u * 2, u);
        x.fillStyle = SCHEME.greenHot; x.fillRect(X + (W >> 1), Y + m + (nh >> 1) - (u >> 1), u, u);
        x.fillStyle = SCHEME.amberDk;
        for (let i = X + m; i < X + W - m; i += 3) x.fillRect(i, Y + H - m - 1, 1, 1);
      } else if (p.t === 'outbox') {         // OUTBOX — the dark dispatch chute, green lamp
        lineBody(x, X, Y, W, H, SCHEME.chuteTop, SCHEME.chuteBody, '#2a352e', '#0a0f0c');
        x.fillStyle = SCHEME.chute; x.fillRect(X + m, Y + m, W - m * 2, H - m * 2);
        x.fillStyle = SCHEME.greenHot; x.fillRect(X + W - m - u * 2, Y + m + 1, u * 2, u);
        x.fillStyle = SCHEME.green; x.fillRect(X + m + 1, Y + H - m - u - 1, u * 2, u);
      } else {                               // junction (filter/splitter/merger) — node + tinted arms
        const core = p.t === 'filter' ? SCHEME.violet : (p.t === 'splitter' ? SCHEME.green : SCHEME.merge);
        const hot = p.t === 'filter' ? SCHEME.violetHot : (p.t === 'splitter' ? '#c8f4e6' : '#ffd488');
        lineBody(x, X + 1, Y + 1, W - 2, H - 2, st.top, st.face, st.lit, st.dk);
        const cx = X + (W >> 1), cy = Y + (H >> 1);
        const fan = lanes.fans.find(f => f.p === p);
        if (fan) for (const a of fan.dirs) {   // an arm toward every out-lane, in that lane's colour
          x.fillStyle = a.col;
          for (let k = 1; k <= (S >> 1); k++) x.fillRect(cx + LINE_DIR[a.d][0] * k, cy + LINE_DIR[a.d][1] * k, 1, 1);
        }
        x.fillStyle = core; x.fillRect(cx - u, cy - u, u * 2, u * 2);
        x.fillStyle = hot; x.fillRect(cx - (u >> 1), cy - (u >> 1), Math.max(1, u), Math.max(1, u));
      }
    }
    return c;
  }
  /* ---------- THE CANDIDATE FIELD: "where can this line go?" ----------
     A blueprint is 17 tiles wide; a beginner arming one got a red ghost and no map, so finding a
     legal spot was a hunt. The field answers the question up front: every CURSOR tile whose stamp
     the model accepts, washed dim over the deck, and the ghost SNAPS to the nearest one so
     "click roughly there" lands.

     COST + DETERMINISM. One scan is (bounds + FIELD_MARGIN)² checkBlueprint calls — far too much
     for a frame. It runs lazily on first ask per blueprint and is cached until station.onChange
     drops it (clearLineFields). No RNG, no time input: the same floor always yields the same field.
     The scan is also bounded to the DECK's neighbourhood — every blueprint tile must sit on a room,
     so a legal anchor can never be more than half a footprint outside the station bounds. */
  const FIELD_MARGIN = 2;   // tiles of slack around the bounds — a centred footprint may hang its anchor just outside
  const SNAP_R = 3;         // "roughly there" = within this many tiles of a legal anchor
  function clearLineFields() {
    for (const k of Object.keys(lineFields)) delete lineFields[k];
    for (const k of Object.keys(lineFitsMemo)) delete lineFitsMemo[k];
  }
  function lineField(bpId) {
    const bp = blueprintOf(bpId);
    if (!bp || !station) return null;
    if (lineFields[bpId]) return lineFields[bpId];
    const b = boundsMemoed();
    const hw = bp.w >> 1, hh = bp.h >> 1;
    const x0 = b.minTx + hw - FIELD_MARGIN, x1 = b.maxTx + hw + FIELD_MARGIN;
    const y0 = b.minTy + hh - FIELD_MARGIN, y1 = b.maxTy + hh + FIELD_MARGIN;
    const set = new Set(), list = [];
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      if (!station.canPlaceBlueprint(bp.id, tx - hw, ty - hh).ok) continue;
      set.add(tx + ',' + ty); list.push({ tx, ty });
    }
    // pre-merge the wash into horizontal RUNS and its outline into EDGE segments, once. The frame
    // then paints tens of rects instead of thousands, and the boundary reads as one shape.
    const runs = [], edges = [];
    for (const c of list) {
      const last = runs[runs.length - 1];
      if (last && last.ty === c.ty && last.x2 === c.tx - 1) last.x2 = c.tx;
      else runs.push({ ty: c.ty, x1: c.tx, x2: c.tx });
      if (!set.has((c.tx - 1) + ',' + c.ty)) edges.push([c.tx, c.ty, c.tx, c.ty + 1]);
      if (!set.has((c.tx + 1) + ',' + c.ty)) edges.push([c.tx + 1, c.ty, c.tx + 1, c.ty + 1]);
      if (!set.has(c.tx + ',' + (c.ty - 1))) edges.push([c.tx, c.ty, c.tx + 1, c.ty]);
      if (!set.has(c.tx + ',' + (c.ty + 1))) edges.push([c.tx, c.ty + 1, c.tx + 1, c.ty + 1]);
    }
    return (lineFields[bpId] = { set, list, runs, edges });
  }
  /* does this blueprint fit ANYWHERE on the current deck? (shelf honesty — see renderPalette)
     The shelf asks this for ALL FOUR blueprints on every palette render, and building a full field
     is thousands of checkBlueprint calls each — arming LINES on a large deck visibly froze. Existence
     needs only the FIRST legal anchor, so probe in the SAME scan order and stop at it. The two paths
     cannot disagree: both ask "does canPlaceBlueprint accept any anchor in the deck neighbourhood",
     over the identical rectangle. When the full field is already cached (the armed blueprint) it is
     used verbatim. Both are dropped together by clearLineFields on every station.onChange. */
  function lineFits(bpId) {
    if (lineFields[bpId]) return !!lineFields[bpId].list.length;
    if (bpId in lineFitsMemo) return lineFitsMemo[bpId];
    const bp = blueprintOf(bpId);
    if (!bp || !station) return false;   // no blueprint = nothing to cache (lineField returned null here)
    const b = boundsMemoed();
    const hw = bp.w >> 1, hh = bp.h >> 1;
    const x0 = b.minTx + hw - FIELD_MARGIN, x1 = b.maxTx + hw + FIELD_MARGIN;
    const y0 = b.minTy + hh - FIELD_MARGIN, y1 = b.maxTy + hh + FIELD_MARGIN;
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++)
      if (station.canPlaceBlueprint(bp.id, tx - hw, ty - hh).ok) return (lineFitsMemo[bpId] = true);
    return (lineFitsMemo[bpId] = false);
  }
  /* SNAP: the ghost follows the cursor but lands on the nearest legal anchor within SNAP_R, so a
     click "roughly there" places the line. Beyond that radius the cursor tile is used raw and the
     ghost stays RED — a genuinely-nowhere-near aim must still be told no, not silently teleported
     across the deck. Ties break by (dy, dx) scan order, never by distance alone, so the snap is
     deterministic: the same pointer tile always resolves to the same anchor. */
  function lineSnap(tx, ty) {
    const f = lineField(lineType);
    if (!f || !f.list.length) return { tx, ty, snapped: false };
    if (f.set.has(tx + ',' + ty)) return { tx, ty, snapped: false };
    /* SEARCH THE RADIUS, NOT THE DECK. This walked the ENTIRE candidate list — thousands of tiles on
       a large floor — every frame the LINES ghost was live, only to throw the winner away unless it
       landed within SNAP_R. Any anchor outside the (2·SNAP_R+1)² box has |dx|>R or |dy|>R, hence
       d > R², hence it would have been rejected by that very check; so scanning only the box cannot
       change the answer. The box is walked in (dy, dx) order — the same order f.list is built in —
       and ties still break on the first strictly-smaller distance, so the snap stays deterministic
       and identical, tile for tile. */
    let bx = 0, by = 0, bestD = Infinity, found = false;
    for (let dy = -SNAP_R; dy <= SNAP_R; dy++) {
      for (let dx = -SNAP_R; dx <= SNAP_R; dx++) {
        const cx = tx + dx, cy = ty + dy;
        if (!f.set.has(cx + ',' + cy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bx = cx; by = cy; found = true; }
      }
    }
    if (!found || bestD > SNAP_R * SNAP_R) return { tx, ty, snapped: false };
    return { tx: bx, ty: by, snapped: true };
  }
  // the ghost's rect set + validity at a cursor tile — same {rects, v} contract every ghost uses
  function lineGhost(tx, ty) {
    const bp = blueprintOf(lineType);
    if (!bp) return null;
    const s = lineSnap(tx, ty);
    const o = lineOrigin(bp, s.tx, s.ty);
    const rects = bp.props.map(p => ({ x1: o.x + p.x, y1: o.y + p.y, x2: o.x + p.x + p.w - 1, y2: o.y + p.y + p.h - 1 }))
      .concat(bp.belts.map(b => ({ x1: o.x + b.x, y1: o.y + b.y, x2: o.x + b.x, y2: o.y + b.y })));
    return { rects, v: station.canPlaceBlueprint(bp.id, o.x, o.y), kind: 'line', label: bp.label, snapped: s.snapped };
  }
  function stampLine(w, ev) {
    const bp = blueprintOf(lineType);
    if (!bp) return;
    // the SAME snap the ghost showed — the click commits exactly what was on screen, never the raw tile
    const s = lineSnap(w.tx, w.ty);
    const o = lineOrigin(bp, s.tx, s.ty);
    const res = station.stampBlueprint(bp.id, o.x, o.y);   // ONE undoable action — see worldmodel.stampBlueprint
    if (res && res.ok) {
      lastStampIds = res.ids || null;   // the finish-the-line card adopts this line on the next recompile
      // LINE NAMING: a stamp leaves the intake's `label` UNSET (the save carries only what the Commander
      // typed) — but this session remembers which blueprint stamped it, so the intake card's name field
      // can offer the blueprint's name as its placeholder (session-scoped, like lastStampIds).
      try { for (const id of (res.ids || [])) { const sp = station.propById(id); if (sp && sp.t === 'intake') stampNameOf[id] = bp.label; } } catch (_) {}
      pushFlash(bp.props.map(p => ({ x1: o.x + p.x, y1: o.y + p.y, x2: o.x + p.x + p.w - 1, y2: o.y + p.y + p.h - 1 })), false);
      sfx('chime');
      // PLACEMENT FLOW: a blueprint stamps ONCE, then the tool drops back to SELECT — the next
      // click on the fresh line inspects a dock instead of stamping a second copy on top of it.
      // (Deselect BEFORE the tip: selectTool hides any tip it finds.)
      deselectTool({ silent: true });
      flashTip(ev, bp.label + ' STAMPED — now click each BAY to assign an agent', true);
      if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }
      // belts just landed — the same first-touch coach a hand-laid run earns (points at ▸ TEST)
      if (typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced) Tutorial.onBeltPlaced();
    } else {
      sfx('bad');
      flashTip(ev, (res && res.msg) || 'needs clear deck — every tile on a room, nothing in the way', false);
    }
  }

  /* NO STANDALONE CANVAS INVITATION (2026-08-07). A floating "START A WORK LINE HERE" prompt used
     to live here, painted on an empty deck. It was retired: STATION ORDERS (renderOrders) already
     sequences build mode — ① a second space → ② a deck → ③ a workstation → ④ STAMP A WORK LINE —
     and its step ④ arms this very tool. Two invitations to the same act is exactly the stacking the
     one-voice law forbids, and leading with the line reframed the whole mode as conveyor-first.
     The guidance path is: ORDERS invites → the tool arms → the candidate wash + snap below help
     you land it. Do not reinstate a second voice for the same step. */

  function selectTool(id, o) {
    tool = id; drag = null; connectFrom = null; dupe = null; hideTip(); hidePropCard();
    root.querySelectorAll('.refit-tool').forEach(b => {
      const active = b.dataset.tool === id;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    renderPalette(); repaintIcons(); setHint(); setCursor();
    if (id === 'line') frameBlueprint();   // a footprint you cannot see whole cannot be aimed
    if (!(o && o.silent)) sfx('click');
  }
  /* FRAME THE GHOST. At the entering zoom a 17-tile line is wider than the glass, so half the
     footprint you are placing is off-screen. Arming a blueprint that does not fit the viewport
     pulls the camera back — through fitCamera(), the SAME framer the ⊹ FIT button runs (framing
     the station bounds necessarily frames any legal placement inside them; a second camera fitter
     would be a second set of insets/clamps to keep in sync). A blueprint that already fits is left
     alone: re-framing on every arm would yank the camera away from where the user was looking. */
  function frameBlueprint() {
    const bp = blueprintOf(lineType);
    if (!bp || !cv || !station) return;
    const t = T(), ins = viewInsets();
    const vw = Math.max(1, cv.width - ins.l), vh = Math.max(1, cv.height - ins.t - ins.b);
    // a tile of breathing room each side: a footprint flush against the glass still cannot be read
    if ((bp.w + 2) * t * zoom <= vw && (bp.h + 2) * t * zoom <= vh) return;
    fitCamera();
  }
  // every "drop whatever is armed" gesture (ESC, right-click, post-stamp) lands here
  function deselectTool(o) { if (tool !== 'select') selectTool('select', o); }

  /* ---------- THE STATUS STRIP (2026-08-07) ----------
     This was one run of 12px grey text in which the thing you most need — WHAT THE ARMED TOOL
     DOES — was indistinguishable from the camera keys you already know. It is now two ranks: the
     tool's imperative VERB in bright phosphor, and the standing camera/escape keys beneath it,
     dim. A transient message (passed as `msg`) takes the verb rank alone, because a transient
     message is always the more urgent of the two. */
  const CAMERA_KEYS = 'wheel zoom · space-drag pan · ESC deselect';
  function setHint(msg) {
    if (!hintEl) return;
    const t = TOOLS.find(x => x.id === tool);
    // SURFACE means three different gestures depending on which surface is targeted — say which
    let verb = (t && t.verb) || (t && t.hint) || '';
    if (tool === 'paint') verb = paintTarget === 'hull' ? 'click a room to re-clad its outside'
      : paintTarget === 'walls' ? 'click a room to clad its walls'
      : 'click a room to lay this deck · drag to paint tiles';
    hintEl.innerHTML = '<span class="refit-hint-verb">' + esc(msg || verb) + '</span>'
      + '<span class="refit-hint-keys">' + esc(CAMERA_KEYS) + '</span>';
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

  /* ---------- first-use guide: the three beats, drawn ----------
     One painter per beat, on a 128×72 board of 4px cells (canvas is 3× that for crispness). Every
     mark is a rect — this is the same pixel vocabulary the station is built out of, and it renders
     the GESTURE, so the words underneath only have to name it. Colours come from the same three
     roles the live editor uses: phosphor for structure, green for a legal ghost, gold for a machine. */
  function guideStepArt(c, kind) {
    const x = c.getContext('2d'); if (!x) return;
    const S = c.width / 128;                       // one board unit in device px
    const R = (bx, by, bw, bh, fill) => { x.fillStyle = fill; x.fillRect(bx * S, by * S, bw * S, bh * S); };
    const PH = 'rgba(120,200,255,.55)', DIM = 'rgba(120,200,255,.16)', OK = 'rgba(120,255,170,.95)',
          OKF = 'rgba(80,255,140,.20)', GOLD = 'rgba(240,196,90,.95)', INK = 'rgba(6,9,12,.9)', LIT = 'rgba(180,240,255,.9)';
    x.clearRect(0, 0, c.width, c.height);
    R(0, 0, 128, 72, 'rgba(8,12,16,.75)');
    // the deck grid every beat happens on — 8-unit cells, the editor's own minor lattice
    for (let gx = 0; gx <= 128; gx += 8) R(gx, 0, 1, 72, DIM);
    for (let gy = 0; gy <= 72; gy += 8) R(0, gy, 128, 1, DIM);

    if (kind === 'room') {
      // a room being dragged out: a green footprint with corner brackets and the cursor at its far corner
      R(24, 16, 56, 40, OKF);
      R(24, 16, 56, 1, OK); R(24, 55, 56, 1, OK); R(24, 16, 1, 40, OK); R(79, 16, 1, 40, OK);
      // corner brackets — (cx,cy) is the corner itself, sx/sy point INTO the rect
      const br = (cx, cy, sx, sy) => {
        R(sx > 0 ? cx : cx - 9, cy - 1, 10, 3, OK);
        R(cx - 1, sy > 0 ? cy : cy - 9, 3, 10, OK);
      };
      br(24, 16, 1, 1); br(80, 16, -1, 1); br(24, 56, 1, -1); br(80, 56, -1, -1);
      // the size badge the real drag prints on the ghost
      R(40, 4, 26, 10, INK); R(40, 4, 26, 1, OK); R(40, 13, 26, 1, OK); R(40, 4, 1, 10, OK); R(65, 4, 1, 10, OK);
      for (let i = 0; i < 5; i++) R(44 + i * 4, 8, 2, 2, OK);
      // cursor arrow at the drag's live corner
      for (let i = 0; i < 9; i++) R(80, 56 + i, Math.max(1, 8 - i), 1, LIT);
      R(84, 62, 2, 5, LIT);
    } else if (kind === 'bay') {
      // a dock with an agent walking into it: the machine, the crew body, the bind arrow
      R(64, 24, 32, 26, 'rgba(52,58,64,.95)'); R(64, 24, 32, 2, GOLD); R(64, 48, 32, 2, GOLD);
      R(68, 30, 24, 10, 'rgba(20,26,30,.95)');
      for (let i = 0; i < 5; i++) R(70 + i * 5, 33, 3, 4, GOLD);
      // the crew body (head + torso), reading left-to-right into the dock
      R(24, 26, 8, 8, 'rgba(226,206,170,.95)'); R(22, 36, 12, 14, 'rgba(120,200,255,.8)');
      R(22, 50, 4, 6, 'rgba(60,70,80,.95)'); R(30, 50, 4, 6, 'rgba(60,70,80,.95)');
      // bind arrow
      R(38, 36, 20, 2, PH); R(56, 33, 2, 8, PH); R(54, 35, 2, 4, PH);
    } else {
      /* the belt the click-click lays — THROUGH the bay from beat 2, never machine-to-machine direct.
         The old art wired two anonymous machines straight together: exactly the bay-less line that
         compiles fine and moves NOTHING (crates only ride a lane that reaches a crewed dock). The
         first picture a Commander ever sees of the belt tool must not teach the one dead layout, so
         the middle machine wears beat 2's gold display — the bay they just crewed, now on the line. */
      R(2, 26, 22, 22, 'rgba(52,58,64,.95)'); R(2, 26, 22, 2, PH);                 // INBOX
      R(53, 26, 22, 22, 'rgba(52,58,64,.95)'); R(53, 26, 22, 2, GOLD); R(53, 46, 22, 2, GOLD);   // the BAY
      R(56, 30, 16, 8, 'rgba(20,26,30,.95)');
      for (let i = 0; i < 3; i++) R(58 + i * 5, 32, 3, 4, GOLD);
      R(104, 26, 22, 22, 'rgba(52,58,64,.95)'); R(104, 26, 22, 2, PH);             // OUTBOX
      // two belt legs, one style: INBOX -> BAY, BAY -> OUTBOX
      R(24, 32, 29, 10, 'rgba(24,30,34,.95)'); R(24, 32, 29, 1, PH); R(24, 41, 29, 1, PH);
      R(75, 32, 29, 10, 'rgba(24,30,34,.95)'); R(75, 32, 29, 1, PH); R(75, 41, 29, 1, PH);
      for (const bx of [27, 37, 47, 79, 89, 99]) { R(bx, 34, 2, 2, PH); R(bx + 2, 36, 2, 2, PH); R(bx, 38, 2, 2, PH); }
      R(31, 22, 12, 10, GOLD); R(33, 24, 8, 6, 'rgba(120,90,30,.9)');   // a crate riding leg one
      // the clicks: one per machine, in work order
      R(8, 16, 10, 2, LIT); R(12, 12, 2, 10, LIT);
      R(58, 16, 10, 2, LIT); R(62, 12, 2, 10, LIT);
      R(106, 16, 10, 2, LIT); R(110, 12, 2, 10, LIT);
    }
  }

  /* ---------- THE CARD STACK (2026-08-07 conveyor audit) ----------
     Every modal card in REFIT — the first-run guide, the step editor, the workstation picker, the flow /
     belt / junction / connector / room / door cards — mounts as `.refit-guide` + its own marker class, and
     each one owns a `closeP` that does the work closing it OWES: the step card saves the job brief, the
     flow card saves the line name, the room card saves the rename. Nothing outside those closures could
     reach them, so two callers took a shortcut and paid for it:
       • ESC matched `.refit-guide` — the class they ALL share — then markSeen()'d and removeChild()'d
         directly. Pressing ESC over a step card threw away an unsaved job brief AND permanently marked
         the build-mode guide seen, for a card that was not the guide. The law was even written down two
         hundred lines below ("gate on `.refit-firstrun`, NEVER `.refit-guide`") and broken here.
       • Every opener bailed out (`if (already mounted) return`) instead of replacing, so FINISH ① CREW
         and the live world's NO AGENT nag did NOTHING while any other dock's card was open.
     So: a card REGISTERS its own close path on its element, and both callers route through it. Closing is
     always the card's own closing; opening always replaces whatever is up. */
  function cardRegister(el, closeFn) { el._refitClose = closeFn; return el; }
  // topmost = last mounted (DOM order); these cards are appended, never re-ordered
  function cardTop() {
    if (!root) return null;
    const all = root.querySelectorAll('.refit-guide');
    return all.length ? all[all.length - 1] : null;
  }
  // close ONE card through its own path (which is what saves what that card saves)
  function cardClose(el) {
    if (!el) return false;
    const fn = el._refitClose;
    el._refitClose = null;             // a close path that re-enters must not run twice
    if (typeof fn === 'function') { try { fn(); } catch (e) { console.warn('[refit] card close path threw', e); } }
    if (el.parentNode) el.parentNode.removeChild(el);   // backstop: every closeP already removes itself
    return true;
  }
  // an opener calls this FIRST: whatever is up closes properly, then the new card takes the surface.
  function cardCloseAll() { for (let i = 0; i < 16; i++) { const el = cardTop(); if (!el) break; cardClose(el); } }

  /* ---------- first-use guide ---------- */
  function hasSeen() { try { return !!localStorage.getItem(SEEN_KEY); } catch (e) { return false; } }
  function markSeen() { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {} }
  /* TUTORIAL WINS (same coordination dockglow.js uses). The kit-out tour ALWAYS causes the first REFIT open,
     so this first-run card used to land on top of it every single time: a full-viewport modal that BLOCKS the
     ⚇ PROP button the tour's ring is pulsing on, while teaching a different lesson (rooms/BAYs/belts) than the
     coach bubble floating above it (gear placement). Deferring costs nothing — markSeen() only fires on
     dismiss, so hasSeen() stays false and the card shows on the next REFIT open, once the tour is out of the
     way and the Commander is actually building. #refit-help re-opens it on demand either way. */
  function tutorialCoaching() { try { return !!(typeof Tutorial !== 'undefined' && Tutorial.isCoaching && Tutorial.isCoaching()); } catch (e) { return false; } }
  function showGuide() {
    if (!root || root.querySelector('.refit-guide')) return;
    const g = document.createElement('div');
    g.className = 'refit-guide refit-firstrun';   // refit-firstrun marks THIS card (not the pickers/editors that share .refit-guide) so tutorial.js can avoid painting a coachmark over it
    // Three beats, not a wall — place a room, place+assign a BAY, wire it with a BELT. The full reference (every prop
    // & mechanic) lives in the FIELD MANUAL, so we point there instead of front-loading it all here.
    /* SHOWN, not told (2026-08-07). This card was four prose bullets — the first thing a Commander
       ever sees of build mode, and it read like documentation. The three beats are the same three
       beats; each now leads with a PICTURE of the gesture (drawn in the station's own pixel language
       by guideStepArt) and carries one line of words under it. */
    g.innerHTML = `
      <div class="refit-guide-card refit-guide-wide">
        <h3>▮ BUILD YOUR STATION</h3>
        <p class="refit-guide-lead">Your floor is a flowchart — work arrives at the <b>INBOX</b>, every <b>BAY</b> is an agent doing one step, and the belts you draw are the order the work flows.</p>
        <div class="refit-steps">
          <div class="refit-step" data-art="room">
            <span class="refit-step-n">1</span>
            <b>DRAG A ROOM</b>
            <span>Pick <b>ROOM</b>, drag on the grid. Your agent walks what you build.</span>
          </div>
          <div class="refit-step" data-art="bay">
            <span class="refit-step-n">2</span>
            <b>CREW A BAY</b>
            <span>Drop a <b>BAY</b> (PROP ▸ WORKFLOW), click it, assign an agent.</span>
          </div>
          <div class="refit-step" data-art="belt">
            <span class="refit-step-n">3</span>
            <b>WIRE THE BELT</b>
            <span>Pick <b>BELT</b>, click one machine then the next. The belt lays itself — but it only carries work through a crewed <b>BAY</b> (INBOX ▸ BAY ▸ OUTBOX).</span>
          </div>
        </div>
        <p class="refit-guide-foot">In a hurry? <b>LINES (9)</b> stamps a whole working layout you can edit. Every prop &amp; mechanic is in the <b>FIELD MANUAL</b> — SYSTEM ▸ FIELD MANUAL.</p>
        <button class="btn-sm refit-primary" id="refit-guide-go">▸ START BUILDING</button>
      </div>`;
    root.appendChild(g);
    g.querySelectorAll('.refit-step').forEach(s => {
      const c = document.createElement('canvas');
      c.className = 'refit-step-art'; c.width = 384; c.height = 216;   // 3× the 128×72 display box
      s.insertBefore(c, s.firstChild);
      try { guideStepArt(c, s.dataset.art); } catch (e) { c.remove(); }   // art must never break the card
    });
    requestAnimationFrame(() => g.classList.add('refit-swap'));   // soft rise-in on open (reduced-motion safe)
    const dismiss = () => { markSeen(); if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, dismiss);   // ESC on THIS card (and only this one) is what marks the guide seen
    g.querySelector('#refit-guide-go').onclick = dismiss;
    g.addEventListener('click', e => { if (e.target === g) dismiss(); });
  }

  /* ---------- BAY agent-picker (Phase B4c): bind a docking bay to an agent — work that reaches it runs as
     that agent. Sourced from the app's agent list (opts.agents()) when present, plus a free-text agent id. */
  // is this prop a COMPUTER (PC)? — sourced from the station's CAP_PROP_MAP so the type list never drifts.
  const isPcProp = t => !!(station && typeof station.capForProp === 'function' && station.capForProp(t) === 'computer');
  /* ONE-CLICK CREW (guided workflows Phase 1): create a real agent for a role-carrying dock through
     the EXISTING creation seam — App.summonAgent, the same door the Recruitment Bay and the backend's
     crew.summon.request walk through (single source of agents; never a parallel mint). The spec rides
     the role's real Specialties class (loadout: model tier pin, effort, skill package), with the
     purpose LED by the dock's own duty line (the roleDesc) so the agent knows which station line it
     crews. Model: summonAgent inherits the hero's/station-default model unless the Commander pinned
     the class tier in SETTINGS — exactly the summon default everywhere else. */
  function summonForRole(role, ri) {
    if (typeof App === 'undefined' || !App.summonAgent) return null;
    const cls = (ri && ri.cls && typeof Specialties !== 'undefined' && Specialties.get) ? Specialties.get(ri.cls) : null;
    const duty = 'You crew this station line as its ' + role + ' — you ' + ((ri && ri.desc) || 'work this dock') + '.';
    const spec = Object.assign({}, cls || { name: role, model: 'balanced' });
    spec.purpose = duty + (cls && cls.purpose ? '\n\n' + cls.purpose : '');
    try { return App.summonAgent(spec, { activate: false, desk: true }); } catch (e) { return null; }
  }
  /* ---------- THE STEP CARD (workflow studio, 2026-08-05) ----------
     ONE surface per dock, on the inspect seam: THE STEP (which stage of which line this is), THE AGENT
     (who crews it — the summon/roster/free-id machinery of the old BAY picker folded in, one surface
     instead of two hops), THE WORK (the dock's standing JOB BRIEF — what this step does with arriving
     work). The brief persists on the prop (worldmodel.setPropBrief -> migrate() whitelist), compiles
     into the posted plan (pipeline bays/dockBays.brief) and is injected into entry runs + chain
     handoffs by the sidecar (router.stageBrief). PROMPT TEXT ONLY — a brief never changes who runs or
     what tools they hold; routing and capability come from the binding and the room, untouched. */
  // the LINE a prop belongs to (valComps membership from the CURRENT compiled geometry), or null
  function lineOfProp(propId) {
    return (valComps && valComps.find(c => c.props.indexOf(propId) >= 0)) || null;
  }
  // a line's saved display name: the intake's `label` (line naming rides the INTAKE prop), or null
  function lineNameOf(c) {
    if (!c) return null;
    for (const iid of c.intakes) { const ip = station.propById(iid); if (ip && ip.label) return ip.label; }
    return null;
  }
  /* which position does this dock's agent hold on the COMPILED line? (inbox-trigger, 2026-08-05)
     'entry' = fed straight by an intake source (plan.reach — the BFS from every source), 'chain' = fed by an
     upstream dock's chain edge (plan.chains[..].next), null = unknowable (unbound dock / no compiled plan /
     a lone dock off the belt graph). Read from the SAME compiled plan the sidecar routes by — never guessed
     from geometry. reach wins when both hold: a dock intakes feed directly is an entry stage first. */
  function stepPositionOf(agentId) {
    if (!agentId || !valPlan) return null;
    if (valPlan.reach && valPlan.reach[agentId]) return 'entry';
    const chains = valPlan.chains || {};
    for (const a in chains) { const nx = (chains[a] && chains[a].next) || []; if (nx.indexOf(agentId) >= 0) return 'chain'; }
    return null;
  }
  /* the brief placeholder differs by POSITION (Andrew's confusion, now law): an entry dock's brief reads
     against the ARRIVING message; a chain-fed dock's against the previous station's output. One generic
     fallback for docks the plan can't place (unbound / beltless). */
  const BRIEF_PH = {
    entry: "The arriving message is the task. This is your station's standing part of it — what this desk always does with arriving work.",
    chain: "Work arrives here as the previous station's output. This is your station's job — your part of every run that reaches you."
  };
  function openStepCard(bayId, ev) {
    if (!root) return;
    const p = station.propById(bayId); if (!p || p.t !== 'bay') return;
    cardCloseAll();   // this card REPLACES whatever was up (FINISH ① CREW / the world's NO AGENT nag land here)
    const agents = (opts && typeof opts.agents === 'function' && opts.agents()) || [];
    const roleInfo = (p.role && typeof WorldModel !== 'undefined' && WorldModel.bayRoleInfo) ? WorldModel.bayRoleInfo(p.role) : null;
    const canSummon = !!(roleInfo && typeof App !== 'undefined' && App.summonAgent);
    const cur = p.agentId || '';
    // THE STEP zone copy — all provable floor facts: the role from the stamp, the line from the compiled
    // component grouping (Pipeline.lineComponents), its name from the intake's saved label.
    const comp = lineOfProp(bayId);
    const lineTxt = comp
      ? 'ON <b>' + esc((lineNameOf(comp) || 'an unnamed line').toUpperCase()) + '</b> — ' + comp.bays.length + ' dock' + (comp.bays.length === 1 ? '' : 's') + ' on this line'
      : 'not on a line yet — lay belts (7) to put this dock on one';
    const stepTxt = roleInfo
      ? 'THIS STEP WANTS A <b>' + esc(p.role) + '</b> — ' + esc(roleInfo.desc)
      : 'a dock — work routed here runs as its agent';
    /* WORK BELONGS TO A LINE (Andrew's ruling, 2026-08-07): "each conveyor system built has a purpose and
       a different workflow — the conveyor system should visually run ONLY when the specific workflow is
       running." So the dock has to SAY what makes its line distinct and when it runs. Both facts are read
       off the compiled plan, never guessed: whether this line has a front door of its own (comp.intakes)
       and whether there is anything downstream of this dock at all (valPlan.chains). Plain language only —
       no ids, no "lineId", no belt vocabulary. */
    const handsOn = !!(cur && valPlan && valPlan.chains && valPlan.chains[cur] && (valPlan.chains[cur].next || []).length);
    const runsTxt = !comp ? null
      : comp.intakes.length
      ? 'IT RUNS when work arrives at this line’s <b>INBOX</b> — or when one of its routines fires.'
      : 'IT RUNS when one of this line’s routines fires at a dock on it.';
    const restTxt = (comp && (handsOn || comp.bays.length > 1))
      ? 'A job you hand this agent yourself is answered right here and stops here — it does not run the rest of the line.'
      : null;
    const rows = agents.map(a => `<button type="button" class="bb sm bay-agent${a.id === cur ? ' active' : ''}" data-aid="${esc(a.id)}">${esc(a.name || a.id)}</button>`).join('');
    const briefPh0 = 'what this step does with arriving work' + (roleInfo ? ' — e.g. ' + roleInfo.desc : '');
    const briefPh = BRIEF_PH[stepPositionOf(cur)] || briefPh0;
    const g = document.createElement('div');
    g.className = 'refit-guide refit-step-card';
    g.innerHTML = `
      <div class="refit-guide-card">
        <h3>▮ STEP — ${esc(p.role || 'DOCK')}</h3>
        ${flowStripHTML('bay')}
        <div class="refit-form">
        <div class="refit-sec">THE STEP</div>
        <div class="step-fact">${stepTxt}</div>
        <div class="step-fact">${lineTxt}</div>
        ${runsTxt ? '<div class="step-fact">' + runsTxt + '</div>' : ''}
        ${restTxt ? '<div class="refit-note">' + esc(restTxt) + '</div>' : ''}
        <div class="refit-sec">THE AGENT — <span id="step-bound">${cur ? 'crewed by ' + esc(cur) : 'uncrewed'}</span></div>
        ${canSummon ? '<button type="button" class="bb sm refit-primary refit-summon" id="bay-summon">⊕ SUMMON A ' + esc(p.role) + ' HERE</button>' : ''}
        ${agents.length ? '<div class="refit-agents refit-bay-agents" id="step-rows">' + rows + '</div>' : ''}
        <input id="bay-aid" class="refit-input" type="text" maxlength="40" placeholder="${agents.length ? 'or type an agent id' : 'agent id — e.g. coder'}" value="${esc(cur)}" />
        <div class="refit-error" id="bay-err">unknown agent — pick one above, or check the id</div>
        <div class="refit-actions step-agent-actions">
          <button type="button" class="btn-sm" id="bay-ok">▸ ASSIGN</button>
          <button type="button" class="btn-sm" id="bay-clear">UNBIND</button>
        </div>
        <div class="refit-sec">THE WORK — JOB BRIEF</div>
        <textarea id="step-brief" class="refit-input refit-brief" maxlength="2000" rows="3" placeholder="${esc(briefPh)}">${esc(p.brief || '')}</textarea>
        <div class="refit-note step-brief-note">rides every run this dock gets — saved on blur / Ctrl-Enter. It briefs the agent; it never changes who runs or what tools they hold.</div>
        <div class="refit-actions">
          <button type="button" class="btn-sm refit-primary" id="step-done">✓ DONE</button>
        </div>
        </div>
      </div>`;
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));   // soft rise-in on open (reduced-motion safe)
    const input = g.querySelector('#bay-aid');
    const brief = g.querySelector('#step-brief');
    const boundEl = g.querySelector('#step-bound');
    const clearErr = () => { input.classList.remove('is-error'); };
    const closeP = () => { saveBrief(); if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);   // ESC closes THROUGH here, so the job brief is saved and never discarded
    // a bind/unbind UPDATES the card in place (the brief draft must survive crewing the dock) — the
    // one-surface law: configure the whole step here, close once.
    const refreshBinding = () => {
      const live = station.propById(bayId), aid = (live && live.agentId) || '';
      if (boundEl) boundEl.textContent = aid ? 'crewed by ' + aid : 'uncrewed';
      g.querySelectorAll('.bay-agent').forEach(x => x.classList.toggle('active', x.dataset.aid === aid));
      input.value = aid;
      // a bind can place this dock on the compiled line — re-read its position so the brief placeholder
      // speaks to the right feed (arriving message vs the previous station's output). Best-effort: the plan
      // recompiles async, so a one-frame-stale read just keeps the current copy until the next open.
      if (brief && !brief.value) brief.placeholder = BRIEF_PH[stepPositionOf(aid)] || briefPh0;
    };
    // THE WORK — saved on blur / Ctrl-Enter (never lost on close; a no-op save is silent)
    let briefSaved = p.brief || '';
    function saveBrief() {
      if (!brief || typeof station.setPropBrief !== 'function') return;
      const v = brief.value.trim();
      if (v === briefSaved) return;
      const res = station.setPropBrief(bayId, v);
      if (res && res.ok) { briefSaved = res.brief || ''; sfx('click'); flashTip(ev, v ? 'job brief saved' : 'job brief cleared', true); }
      else sfx('bad');
    }
    brief.addEventListener('blur', saveBrief);
    brief.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveBrief(); }
      if (e.key === 'Escape') { e.stopPropagation(); brief.blur(); }   // first ESC leaves the field (saving); the next closes the card
    });
    // ⊕ SUMMON A <ROLE> HERE — one click: real summon (existing seam) + bind to THIS dock. On any
    // failure the button re-arms and the manual pick below stays fully available (never a dead end).
    const sumBtn = g.querySelector('#bay-summon');
    if (sumBtn) sumBtn.onclick = () => {
      sumBtn.disabled = true;
      const a = summonForRole(p.role, roleInfo);
      const res = a && station.assignPropAgent(bayId, a.id);
      if (res && res.ok) { sfx('chime'); flashTip(ev, a.name + ' summoned → crews this dock', true); refreshBinding(); }
      else { sumBtn.disabled = false; sfx('bad'); flashTip(ev, a ? 'summoned, but the dock refused the bind' : 'summon failed — pick an agent below', false); }
    };
    // ONE CLICK: choosing a roster agent IS the assignment (kept from the old picker — see its note).
    g.querySelectorAll('.bay-agent').forEach(b => b.onclick = () => {
      const res = station.assignPropAgent(bayId, b.dataset.aid);
      if (res && res.ok) { sfx('click'); flashTip(ev, 'bay → ' + (b.textContent || res.agentId).trim(), true); refreshBinding(); }
      else { input.value = b.dataset.aid; input.classList.add('is-error'); sfx('bad'); }
    });
    input.addEventListener('input', clearErr);
    g.querySelector('#bay-ok').onclick = () => {
      const res = station.assignPropAgent(bayId, input.value.trim());
      if (res && res.ok) { sfx('click'); flashTip(ev, res.agentId ? ('bay → ' + res.agentId) : 'bay unbound', true); refreshBinding(); }
      else { input.classList.add('is-error'); sfx('bad'); }
    };
    g.querySelector('#bay-clear').onclick = () => { station.assignPropAgent(bayId, ''); sfx('click'); flashTip(ev, 'bay unbound', true); refreshBinding(); };
    g.querySelector('#step-done').onclick = () => { sfx('click'); closeP(); };
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
  }

  /* ---------- WORKSTATION agent-picker: the desk/PC version of the BAY picker. A workstation carries an
     agentId exactly like a bay does (assignPropAgent is type-agnostic); world.js then seats THAT agent here, so
     when it's given a task it walks over and sits at this desk. The host/model is already chosen when the agent
     was created, so this is a single "pick an agent" step. Opens on place + on click (PROP_EDITABLE). */
  function openWorkstationPicker(propId, ev) {
    if (!root) return;
    const p = station.propById(propId); if (!p || !WORKSTATION_TYPES[p.t]) return;
    cardCloseAll();
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
        <div class="refit-form">
        ${agents.length
          ? '<div class="refit-sec">YOUR AGENTS — click to assign</div><div class="refit-agents refit-bay-agents">' + rows + '</div>'
          : '<div class="refit-note">No active agents yet — summon one first, or type an id below.</div>'}
        <div class="refit-sec">${agents.length ? 'OR TYPE AN AGENT ID' : 'AGENT ID'}</div>
        <input id="ws-aid" class="refit-input" type="text" maxlength="40" placeholder="agent id — e.g. coder" value="${esc(cur)}" />
        <div class="refit-error" id="ws-err">unknown agent — pick one above, or check the id</div>
        <div class="refit-actions">
          <button type="button" class="btn-sm refit-primary" id="ws-ok">▸ ASSIGN</button>
          <button type="button" class="btn-sm" id="ws-clear">UNASSIGN</button>
          <button type="button" class="btn-sm" id="ws-cancel">CANCEL</button>
        </div>
        </div>
      </div>`;
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));   // soft rise-in on open (reduced-motion safe)
    const input = g.querySelector('#ws-aid');
    const clearErr = () => { input.classList.remove('is-error'); };
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);
    // ONE CLICK: choosing a roster agent IS the assignment (mirrors the BAY picker — see the note there)
    g.querySelectorAll('.ws-agent').forEach(b => b.onclick = () => {
      const res = station.assignPropAgent(propId, b.dataset.aid);
      if (res && res.ok) { sfx('click'); flashTip(ev, 'workstation → ' + res.agentId, true); closeP(); }
      else { input.value = b.dataset.aid; input.classList.add('is-error'); sfx('bad'); }
    });
    input.addEventListener('input', clearErr);
    g.querySelector('#ws-ok').onclick = () => {
      const res = station.assignPropAgent(propId, input.value.trim());
      if (res && res.ok) { sfx('click'); flashTip(ev, res.agentId ? ('workstation → ' + res.agentId) : 'workstation cleared', true); closeP(); }
      else { input.classList.add('is-error'); sfx('bad'); }
    };
    g.querySelector('#ws-clear').onclick = () => { station.assignPropAgent(propId, ''); sfx('click'); flashTip(ev, 'workstation cleared', true); closeP(); };
    g.querySelector('#ws-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
    try { input.focus(); input.select(); } catch (_) {}
  }

  /* ---------- FILTER junction editor (Polish P1): make content-routing reachable from the UI.
     A FILTER wants routes (tag -> out-lane) + a default lane — a missing default is an amber nag
     (FILTER_NO_DEFAULT, warn: unrouted work falls back def -> first lane, never dropped);
     it calls station.configureJunction. Opens on place/click.
     A MERGER has NO editor — like the splitter, it is pure topology. It used to offer a "combine K" field
     for a hold-K-then-emit-one barrier the harness never performed (see conveyor.js chooseExit), so the
     control was authoring a promise nothing could keep. A merger clicks through to the flow card instead. */
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
  /* the belt tile a junction prop ATTACHES to — the SAME semantics as the compiler (pipeline.js
     compileRoutingPlan): the prop's own tile if it sits on a belt, else the first belt tile in its
     footprint + 1-tile ring, in the compiler's exact scan order (y then x, from (x-1,y-1)). Before this
     the editor computed lanes at the prop's own tile only, so a ring-attached filter (e.g. nudged one
     tile off its lane by MOVE) still COMPILED and routed, while its editor showed "lay belts OUT of this
     filter first" with zero lane buttons — an error the Commander could not fix. Returns {x,y} or null. */
  function junctionBeltTile(p) {
    if (station.beltAt(p.x, p.y)) return { x: p.x, y: p.y };
    const w = p.w || 1, h = p.h || 1;
    for (let yy = p.y - 1; yy <= p.y + h; yy++)
      for (let xx = p.x - 1; xx <= p.x + w; xx++)
        if (station.beltAt(xx, yy)) return { x: xx, y: yy };
    return null;
  }
  /* ---------- THE FLOW STRIP + FLOW CARD (belt-teach): ONE picture of the whole system, shown wherever
     a workflow prop is touched, with the clicked piece lit — so the model accretes instead of fragmenting
     across six prop descriptions. INBOX/OUTBOX clicks (no editor of their own) open the card directly. */
  function flowStripHTML(hot) {
    const seg = (id, label) => '<span class="flow-seg' + (id === hot ? ' hot' : '') + '">' + label + '</span>';
    const ar = '<span class="flow-arrow">▸</span>';
    return '<div class="refit-flowstrip"><div class="flow-line">'
      + seg('intake', 'INBOX') + ar + seg('junction', 'SORT') + ar + seg('bay', 'BAY') + ar
      + '<span class="flow-seg desk">DESK</span>' + ar + seg('bay', 'BAY') + ar + seg('outbox', 'OUTBOX')
      + '</div><div class="flow-note">outside work rides IN to an agent’s dock · they work it at their desk · the finished result rides OUT. (COMMS orders skip the ride in — you gave them in person.)</div></div>';
  }
  function openFlowCard(propId) {
    if (!root) return;
    const p = station.propById(propId); if (!p) return;
    cardCloseAll();
    const hot = p.t === 'intake' ? 'intake' : p.t === 'outbox' ? 'outbox' : (p.t === 'filter' || p.t === 'splitter' || p.t === 'merger') ? 'junction' : 'bay';
    const TITLE = { intake: 'INBOX — WORK IN', outbox: 'OUTBOX — RESULTS OUT', merger: 'MERGER — LANES JOIN', splitter: 'SPLITTER — LANES BALANCE' };
    const LINE = {
      intake: 'This is where OUTSIDE work — a channel DM, a scheduled routine — physically arrives on the floor. Its TRIGGERS below decide why this line runs; wire one right here.',
      outbox: 'Every job the crew actually FINISHES ships a green crate here; the pallet is today’s output. Click it (when quiet) for the LOGBOOK.',
      // honest by construction: the harness runs each work-item on its own, so the floor must show each
      // one arriving. A merger tidies several lanes into one — it never combines the JOBS riding them.
      merger: 'Where several belt lanes join into one. Every crate rides straight through — a merger tidies the LANES, it does not combine the jobs on them (each still runs on its own). Nothing to configure.',
      // the splitter's counterpart card: it balances UNOWNED work across its out-lanes; addressed
      // jobs still ride home (junctionLaneOwners). Nothing to configure — topology does the work.
      splitter: 'Where one lane fans into several. Unowned work balances across the out-lanes; addressed jobs (crons, bound chats) still take the lane that leads to their owner’s bay. Nothing to configure.'
    };
    const line = LINE[p.t] || LINE.outbox;
    /* LINE NAMING (workflow studio, 2026-08-05): the INTAKE is a line's front door, so its card names the
       line — an additive `label` on the intake prop (worldmodel.setPropLabel; migrate() whitelists it).
       Blueprint stamps leave it UNSET: the placeholder offers the blueprint's name (session map) but only
       what the Commander types is saved. Legibility only — the finish-the-line header + the intake glance
       read it; routing never does. Multiple lines on one floor become nameable systems. */
    const isIntake = p.t === 'intake';
    const namePh = isIntake ? (stampNameOf[p.id] || 'name this line') : '';
    const nameHtml = isIntake
      ? '<div class="refit-sec">LINE NAME</div>'
        + '<input id="line-name" class="refit-input" type="text" maxlength="48" placeholder="' + esc(namePh) + '" value="' + esc(p.label || '') + '" />'
        + '<div class="refit-note">names this whole line (shown on its checklist + this INBOX\'s glance) — saved on Enter / blur</div>'
      : '';
    /* ---------- THE TRIGGER ZONE (inbox-trigger, 2026-08-05) ----------
       The INBOX card is the workflow's WHY, completing the loop the floor already draws: trigger (INBOX) →
       steps (docks + briefs) → result (OUTBOX). Before this the floor shipped the SHAPE of a workflow while
       its triggers had to be pre-created elsewhere (CHANNELS / AUTOMATION). The zone is truthfully derived:
       the server-proven feed truth (World.feedState — the exact NO FEED source) and the cron store's own
       rows (GET /api/cron, filtered to THIS line's dock agents). ⊕ NEW ROUTINE posts the SAME body the
       AUTOMATION window's create form sends — same schedule vocabulary (every 30m · 0 9 * * * · in 2h),
       same /api/cron/preview honesty, and NO unattended grants: a routine made from the inbox gets nothing
       the AUTOMATION window wouldn't give by default. */
    const comp = isIntake ? lineOfProp(propId) : null;
    const docks = (comp ? comp.bays : []).filter(b => b.agentId);
    // default fire-at: the line's entry-reachable dock (plan.reach — fed straight by an intake source);
    // several bound docks -> a small picker naming role + agent. No bound dock -> honest disable.
    const entryDocks = docks.filter(b => valPlan && valPlan.reach && valPlan.reach[b.agentId]);
    let trgDock = (entryDocks[0] || docks[0] || {}).agentId || null;
    const dockChip = b => '<button type="button" class="bb sm trg-dock' + (b.agentId === trgDock ? ' active' : '') + '" data-aid="' + esc(b.agentId) + '">'
      + esc((b.role ? b.role + ' · ' : '') + agentLabelFor(b.agentId)) + '</button>';
    const TRG_PRESETS = [['EVERY 30M', 'every 30m'], ['EVERY 1H', 'every 1h'], ['DAILY 9:00', '0 9 * * *']];
    const trgHtml = isIntake
      ? '<div class="refit-sec">TRIGGERS — WHY THIS LINE RUNS</div>'
        // WORK BELONGS TO A LINE (2026-08-07): the trigger zone is where the Commander decides WHY this line
        // runs, so it is where the rule belongs — only work that comes in through one of these triggers runs
        // the whole line. Plain language; the same fact the STEP card states from the dock's side.
        + '<div class="refit-note">Only work that comes in one of these ways runs this whole line. A job you hand an agent yourself is answered at its own dock and stops there.</div>'
        + '<div class="step-fact" id="trg-feed">checking the wires…</div>'
        + '<div id="trg-routines" class="trg-list"></div>'
        + '<button type="button" class="bb sm refit-primary refit-summon" id="trg-new">⊕ NEW ROUTINE FOR THIS LINE</button>'
        + '<div id="trg-form" style="display:none">'
          + '<textarea id="trg-prompt" class="refit-input refit-brief" maxlength="2000" rows="2" placeholder="what should each run do? e.g. search for new AI-policy news and summarize the top 3"></textarea>'
          + '<div class="refit-agents trg-presets">' + TRG_PRESETS.map(pp => '<button type="button" class="bb sm trg-preset" data-sched="' + esc(pp[1]) + '">' + esc(pp[0]) + '</button>').join('') + '</div>'
          + '<input id="trg-sched" class="refit-input" type="text" maxlength="80" placeholder="schedule — every 30m · 0 9 * * * · in 2h" />'
          + '<div class="trg-preview" id="trg-preview"></div>'
          + (docks.length > 1
              ? '<div class="refit-sec">FIRES AT</div><div class="refit-agents" id="trg-docks">' + docks.map(dockChip).join('') + '</div>'
              : docks.length === 1
              ? '<div class="step-fact">fires at <b>' + esc((docks[0].role ? docks[0].role + ' · ' : '') + agentLabelFor(docks[0].agentId)) + '</b> — this line’s ' + (entryDocks.length ? 'entry dock' : 'dock') + '</div>'
              : '<div class="refit-note">crew a dock first — a routine fires at an agent</div>')
          + '<div class="refit-actions"><button type="button" class="btn-sm refit-primary" id="trg-create"' + (docks.length ? '' : ' disabled') + '>▸ CREATE ROUTINE</button><button type="button" class="btn-sm" id="trg-cancel">CANCEL</button></div>'
          + '<div class="refit-note trg-msg" id="trg-msg" style="display:none"></div>'
        + '</div>'
        + '<div class="refit-actions trg-doors"><button type="button" class="btn-sm" id="trg-chan">⌁ CONNECT A CHANNEL</button><button type="button" class="btn-sm" id="trg-auto">▸ MANAGE IN AUTOMATION</button></div>'
      : '';
    const g = document.createElement('div');
    g.className = 'refit-guide refit-flow-card';
    g.innerHTML = '<div class="refit-guide-card"><h3>▮ ' + (TITLE[p.t] || TITLE.outbox) + '</h3>'
      + flowStripHTML(hot)
      + '<ul><li>' + line + '</li></ul>'
      + nameHtml
      + trgHtml
      + '<div class="refit-actions"><button type="button" class="btn-sm refit-primary" id="flow-ok">✓ GOT IT</button></div></div>';
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));
    let savedLabel = p.label || '';
    const nameIn = g.querySelector('#line-name');
    const saveName = () => {
      if (!nameIn || typeof station.setPropLabel !== 'function') return;
      const v = nameIn.value.trim();
      if (v === savedLabel) return;
      const res = station.setPropLabel(propId, v);
      if (res && res.ok) { savedLabel = res.label || ''; sfx('click'); flashTip(null, v ? 'line named — ' + v : 'line name cleared', true); if (running) { finSig = ''; renderFinCard(); } }
      else sfx('bad');
    };
    if (nameIn) {
      nameIn.addEventListener('blur', saveName);
      nameIn.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); saveName(); }
        if (e.key === 'Escape') { e.stopPropagation(); nameIn.blur(); }   // leave the field (saving); the next ESC closes the card
      });
    }
    const closeP = () => { saveName(); if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);   // ESC closes THROUGH here, so the line name is saved and never discarded
    /* ---- trigger-zone wiring (intake only; every claim below is a server answer, never synthesized) ---- */
    if (isIntake) {
      const feedEl = g.querySelector('#trg-feed'), listEl = g.querySelector('#trg-routines');
      const formEl = g.querySelector('#trg-form'), newBtn = g.querySelector('#trg-new');
      const promptEl = g.querySelector('#trg-prompt'), schedEl = g.querySelector('#trg-sched');
      const pvEl = g.querySelector('#trg-preview'), msgEl = g.querySelector('#trg-msg');
      const dockAgents = {};
      for (const b of docks) dockAgents[b.agentId] = true;
      let schedulerArmed = false;   // mirrors GET /api/cron enabled && !halted — the honest create-confirm
      const say = (t, bad) => { msgEl.style.display = ''; msgEl.style.color = bad ? 'var(--bad)' : ''; msgEl.textContent = t; };
      // the channel/routine FEED TRUTH — the same World.feedState the NO FEED nag keys on. Floor-global by
      // construction (that is what the server proves), said in floor-global words.
      const feed = (opts && opts.world && opts.world.feedState) ? opts.world.feedState() : { known: false, fed: false };
      feedEl.innerHTML = !feed.known ? 'CHANNEL FEED — checking the wires…'
        : feed.fed ? '<b>✓ FED</b> — a channel or an armed routine is wired to drop work on this floor'
        : '<b>NO FEED</b> — nothing is wired to drop work here yet';
      // routines targeting THIS line's dock agents — straight off the cron store, name + schedule + state
      function trgRefresh() {
        listEl.innerHTML = '<span class="dim">reading routines…</span>';
        fetch(finApi('/api/cron')).then(r => (r.ok ? r.json() : null)).then(j => {
          if (!listEl.isConnected) return;
          if (!j) { listEl.innerHTML = '<div class="refit-note">sidecar unreachable — routines unknown</div>'; return; }
          schedulerArmed = !!(j.enabled && !j.halted);
          const mine = (Array.isArray(j.jobs) ? j.jobs : []).filter(jb => jb && dockAgents[jb.agentId]);
          if (!mine.length) { listEl.innerHTML = '<div class="trg-row dim">no routines target this line’s docks yet</div>'; return; }
          listEl.innerHTML = mine.map(jb =>
            '<div class="trg-row"><span class="trg-state' + (jb.enabled && schedulerArmed ? ' on' : '') + '">' + (jb.enabled ? (schedulerArmed ? '●' : '◍') : '○') + '</span> '
            + '<b>' + esc(jb.name || '(unnamed)') + '</b> <span class="dim">' + esc(jb.scheduleDisplay || '') + ' · fires at ' + esc(agentLabelFor(jb.agentId)) + '</span>'
            + (jb.enabled ? (schedulerArmed ? '' : ' <span class="trg-warn">saved — scheduler OFF</span>') : ' <span class="dim">paused</span>') + '</div>').join('');
        }).catch(() => { if (listEl.isConnected) listEl.innerHTML = '<div class="refit-note">sidecar unreachable — routines unknown</div>'; });
      }
      trgRefresh();
      // schedule preview — the honest "next fires", straight from the server math (same seam AUTOMATION uses)
      const relFmt = iso => { const d = Date.parse(iso) - Date.now(); if (!isFinite(d)) return ''; const m = Math.round(d / 60000); return m < 1 ? 'under a minute' : m < 60 ? 'in ' + m + 'm' : m < 2880 ? 'in ' + Math.round(m / 60) + 'h' : 'in ' + Math.round(m / 1440) + 'd'; };
      let pvTimer = null;
      const preview = () => {
        clearTimeout(pvTimer);
        const v = schedEl.value.trim();
        if (!v) { pvEl.textContent = ''; return; }
        pvTimer = setTimeout(() => {
          fetch(finApi('/api/cron/preview'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schedule: v }) })
            .then(r => r.json()).then(r => {
              if (!pvEl.isConnected || schedEl.value.trim() !== v) return;
              if (r && r.ok) {
                const nx = (Array.isArray(r.localNext) && r.localNext[0]) ? r.localNext[0] : (Array.isArray(r.next) && r.next[0] ? relFmt(r.next[0]) : '');
                pvEl.innerHTML = '✓ ' + esc(r.display) + (nx ? ' → next: ' + esc(nx) : '');
              } else pvEl.innerHTML = '<span class="trg-warn">' + esc((r && r.error) || 'unrecognized schedule') + '</span>';
            }).catch(() => {});
        }, 300);
      };
      schedEl.addEventListener('input', preview);
      g.querySelectorAll('.trg-preset').forEach(b => b.onclick = () => { schedEl.value = b.dataset.sched; sfx('click'); preview(); });
      g.querySelectorAll('.trg-dock').forEach(b => b.onclick = () => {
        trgDock = b.dataset.aid; sfx('click');
        g.querySelectorAll('.trg-dock').forEach(x => x.classList.toggle('active', x.dataset.aid === trgDock));
      });
      newBtn.onclick = () => { sfx('click'); formEl.style.display = formEl.style.display === 'none' ? '' : 'none'; if (formEl.style.display !== 'none') promptEl.focus(); };
      g.querySelector('#trg-cancel').onclick = () => { sfx('click'); formEl.style.display = 'none'; };
      g.querySelector('#trg-create').onclick = () => {
        const prompt = promptEl.value.trim(), schedule = schedEl.value.trim();
        if (!prompt || !schedule) { sfx('bad'); say('a task and a schedule are required', true); return; }
        if (!trgDock) { sfx('bad'); say('crew a dock first — a routine fires at an agent', true); return; }
        const btn = g.querySelector('#trg-create'); btn.disabled = true; say('saving…');
        /* the SAME create body the AUTOMATION window posts — tz for wall-clock honesty, the station's live
           provider, and NOTHING else: no unattendedGrants, no toolsets (a routine minted here holds exactly
           the defaults the AUTOMATION window's untouched form would give)…
           …plus ONE field only this door may set. `runsLine` is what makes a routine THIS LINE'S OWN
           trigger: the work it fires carries the line's id, so the chain gate lets it run the whole line.
           It is created here, on the INBOX card, under a button that literally says FOR THIS LINE — that
           is the Commander asking for the line to run. A routine minted anywhere else omits it and stays
           terminal (absent/false = the dock answers and nothing downstream spends), which is the safe
           default: no run the Commander did not ask for. */
        const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch (e) { return undefined; } })();
        const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : undefined;
        const lname2 = lineNameOf(comp);
        const name = (lname2 ? lname2 + ' — ' : '') + (prompt.length > 48 ? prompt.slice(0, 45) + '…' : prompt);
        fetch(finApi('/api/cron'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, prompt, schedule, agentId: trgDock, provider, tz, runsLine: true }) })
          .then(r => r.json()).then(r => {
            btn.disabled = false;
            if (r && r.error) { sfx('bad'); say('✕ ' + r.error, true); return; }
            sfx('chime');
            // honest confirm: never claim "scheduled" over a disarmed scheduler (same law as AUTOMATION)
            say(schedulerArmed ? '✓ routine scheduled — fires at ' + agentLabelFor(trgDock) : '✓ saved — but the scheduler is OFF; enable it in AUTOMATION', !schedulerArmed);
            promptEl.value = ''; pvEl.textContent = '';
            trgRefresh();
          }).catch(() => { btn.disabled = false; sfx('bad'); say('✕ could not reach the sidecar — nothing was created', true); });
      };
      // the two doors: the SAME openers the finish card / NO FEED nag promise. Both leave REFIT (saving).
      g.querySelector('#trg-chan').onclick = () => { sfx('click'); closeP(); close(); if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('messaging'); };
      g.querySelector('#trg-auto').onclick = () => { sfx('click'); closeP(); close(); if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('routines'); };
    }
    g.querySelector('#flow-ok').onclick = () => { sfx('click'); closeP(); };
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
  }

  /* ---------- BELT-TILE INFO CARD (select mode): "where does this lane go?" ----------
     Answered from the COMPILED plan via Pipeline.routeFrom — the same fan-every-junction walk the
     hover tags and the sidecar's routing read from, so the card can never claim a destination a
     dispatch wouldn't reach. Plan coords are LOCAL (valPlan compiles from cacheGeo) → rebase the
     clicked WORLD tile by cacheGeo.origin before asking. */
  function openBeltCard(tx, ty, ev) {
    if (!root) return;
    cardCloseAll();
    const dir = station.beltAt(tx, ty);
    if (!dir) return;
    const o = (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 };
    const r = (valPlan && typeof Pipeline !== 'undefined' && Pipeline.routeFrom)
      ? Pipeline.routeFrom(valPlan, tx - o.tx, ty - o.ty) : null;
    const DIRWORD = { E: 'EAST ▸', W: '◂ WEST', N: '▴ NORTH', S: '▾ SOUTH' };
    const li = [];
    if (r) {
      if (r.agents.length) li.push('Work riding this lane reaches <b>' + r.agents.map(a => esc(agentLabelFor(a))).join(' + ') + '</b>.');
      if (r.unbound) li.push('It passes <b>' + r.unbound + ' uncrewed dock' + (r.unbound === 1 ? '' : 's') + '</b> — crew them or crates ride past.');
      if (r.outbox) li.push('It <b>ships out at the OUTBOX</b>.');
      if (r.deadEnd) li.push('A branch <b>dead-ends</b> — nothing consumes there.');
      if (!r.agents.length && !r.unbound && !r.outbox && !r.deadEnd) li.push('This tile isn’t on the compiled line yet — connect it to a machine.');
    } else li.push('No compiled route yet — lay the line to a machine and this card reads its destination.');
    const g = document.createElement('div');
    g.className = 'refit-guide refit-belt-card';
    g.innerHTML = '<div class="refit-guide-card"><h3>▮ BELT — LANE ' + (DIRWORD[dir] || dir) + '</h3>'
      + '<ul>' + li.map(s => '<li>' + s + '</li>').join('') + '</ul>'
      + '<div class="refit-actions"><button type="button" class="btn-sm refit-primary" id="belt-ok">✓ GOT IT</button></div></div>';
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);
    g.querySelector('#belt-ok').onclick = () => { sfx('click'); closeP(); };
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
  }

  function openJunctionEditor(propId, ev) {
    if (!root) return;
    cardCloseAll();
    const p = station.propById(propId); if (!p || p.t !== 'filter') return;
    const g = document.createElement('div');
    g.className = 'refit-guide refit-junction-editor';
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);

    {
      // resolve lanes at the tile the COMPILER attaches this junction to (own tile OR ring — see
      // junctionBeltTile), so a ring-attached filter is configurable, not a dead editor.
      const jt = junctionBeltTile(p);
      const lanes = jt ? junctionOutLanes(jt.x, jt.y) : [];
      const cur = { routes: (p.routes && typeof p.routes === 'object') ? Object.assign({}, p.routes) : {}, def: p.def || null };
      const selOf = tag => (tag === '__def__' ? cur.def : cur.routes[tag]);
      const ROWS = [['code', 'CODE'], ['research', 'RESEARCH'], ['__def__', 'EVERYTHING ELSE']];
      const rowHtml = ROWS.map(([tag, label]) => {
        const btns = lanes.length
          ? lanes.map(d => '<button type="button" class="bb sm lane-btn' + (selOf(tag) === d ? ' sel' : '') + '" data-tag="' + tag + '" data-dir="' + d + '">' + J_ARROW[d] + '</button>').join('')
          : '<span class="refit-note bad">lay belts OUT of this filter first</span>';
        return '<div class="refit-route-row"><span class="refit-route-lbl">' + label + ' →</span>' + btns + '</div>';
      }).join('');
      g.innerHTML = '<div class="refit-guide-card"><h3>▮ FILTER — route by content</h3>' + flowStripHTML('junction')
        + '<ul><li>Each <b>kind</b> of work routes to the out-lane you pick; the rest take <b>EVERYTHING ELSE</b>. Sorting applies to <b>unowned</b> work — addressed jobs (crons, bound chats) ride straight to their owner’s bay.</li>'
        + '<li>Put a <b>BAY</b> on a lane to send that work to a specific agent.</li></ul>'
        + '<div class="refit-filter-rows">' + rowHtml + '</div>'
        + '<div class="refit-actions"><button type="button" class="btn-sm refit-primary" id="j-ok">▸ SAVE ROUTES</button><button type="button" class="btn-sm" id="j-clear">CLEAR</button><button type="button" class="btn-sm" id="j-cancel">CANCEL</button></div></div>';
      root.appendChild(g);
      requestAnimationFrame(() => g.classList.add('refit-swap'));
      g.querySelectorAll('.lane-btn').forEach(b => b.onclick = () => {
        const tag = b.dataset.tag, dir = b.dataset.dir;
        if (tag === '__def__') cur.def = (cur.def === dir) ? null : dir;
        else if (cur.routes[tag] === dir) delete cur.routes[tag]; else cur.routes[tag] = dir;
        g.querySelectorAll('.lane-btn[data-tag="' + tag + '"]').forEach(x => {
          x.classList.toggle('sel', selOf(tag) === x.dataset.dir);
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
    if (!root) return;
    cardCloseAll();
    const p = station.propById(propId); if (!p || p.t !== 'connector_portal') return;
    const g = document.createElement('div');
    g.className = 'refit-guide refit-connector-editor';
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);
    g.innerHTML = '<div class="refit-guide-card"><h3>▮ CONNECTOR PORTAL — bind an MCP server</h3>'
      + '<ul><li>This gateway grants its bay\'s agent the <b>live tools</b> of ONE configured connector.</li>'
      + '<li>Bind it below — the portal then rides that server\'s state and pulses when its tools fire.</li></ul>'
      + '<div class="refit-conn-rows" id="c-rows">loading…</div>'
      + '<div class="refit-actions"><button type="button" class="btn-sm" id="c-unbind">✕ UNBIND</button><button type="button" class="btn-sm" id="c-cancel">CANCEL</button></div></div>';
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));   // soft rise-in on open (reduced-motion safe)
    const rowsEl = g.querySelector('#c-rows');
    // semantic state → dot class (theme vars, no inline hex): up=ok · warming/offline=warn · error=bad
    const STATE_CLASS = { connected: 'ok', ready: 'ok', up: 'ok', cached: 'warn', warming: 'warn', offline: 'warn', down: 'warn', error: 'bad' };
    const bind = (id, label) => { const res = station.bindConnector(propId, id); if (res && res.ok) { sfx('click'); flashTip(ev, 'bound → ' + (label || id), true); closeP(); } else sfx('bad'); };
    g.querySelector('#c-unbind').onclick = () => { station.bindConnector(propId, ''); sfx('click'); flashTip(ev, 'portal unbound', true); closeP(); };
    g.querySelector('#c-cancel').onclick = closeP;
    g.addEventListener('click', e => { if (e.target === g) closeP(); });
    if (typeof fetch === 'undefined') { rowsEl.innerHTML = '<div class="refit-conn-note">no sidecar — can\'t list connectors here.</div>'; return; }
    fetch('/api/connectors').then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(j => {
      const list = (j && j.connectors) || [];
      if (!list.length) { rowsEl.innerHTML = '<div class="refit-conn-note">No connected services yet — add one in the <b>⇄ ABILITIES</b> panel (⚒ BUILD), then bind it here.</div>'; return; }
      rowsEl.innerHTML = list.map(c => {
        const sel = (c.id === p.connectorId), scls = STATE_CLASS[c.state] || '';
        const meta = c.toolCount ? (c.toolCount + ' tool' + (c.toolCount === 1 ? '' : 's')) : (c.state || 'idle');
        return '<button type="button" class="bb sm conn-row' + (sel ? ' active' : '') + '" data-id="' + esc(c.id) + '" data-label="' + esc(c.label || c.id) + '">'
          + '<span class="conn-dot' + (scls ? ' ' + scls : '') + '">●</span> ' + esc(c.label || c.id)
          + ' <span class="conn-meta">' + esc(meta) + '</span></button>';
      }).join('');
      rowsEl.querySelectorAll('.conn-row').forEach(b => b.onclick = () => bind(b.dataset.id, b.dataset.label));
    }).catch(() => { rowsEl.innerHTML = '<div class="refit-conn-note">sidecar offline — start it to bind a connector.</div>'; });
  }

  /* ---------- test run (Polish B): send work down your belts with NO bot connected, and watch it sort to the
     bays right here in REFIT — the build-time payoff + the first thing a tutorial points at.
     THE NARRATED RIDE (2026-07-05): ▸ TEST now teaches the whole two-trip model as it happens — numbered
     captions land at each stage (① enters → ② sorted → ③ delivered to the dock → ④ result ships from the
     dock → ⑤ out), and a delivered test crate spawns a RETURN product crate so the outbound leg shows too.
     Ephemeral, REFIT-preview only, driven by the same engine decisions real work rides on. ---------- */
  const testNotes = [];   // {x, y, text, col, t0} — stage captions over the ride (WORLD tiles)
  const NOTE_MS = 3200;
  function note(x, y, text, col) { testNotes.push({ x, y, text, col: col || '#9adcb0', t0: (typeof performance !== 'undefined') ? performance.now() : 0 }); if (testNotes.length > 12) testNotes.shift(); }
  const agentLabelFor = aid => {
    const list = (opts && typeof opts.agents === 'function' && opts.agents()) || [];
    const a = list.find(x => x.id === aid);
    return ((a && a.name) || aid || 'AGENT').toUpperCase();
  };
  // world-frame stops map for the preview sim: bound-bay hookup tiles (LOCAL plan keys rebased by origin)
  function testStops() {
    if (!valPlan || !valPlan.bayTileToAgent || !cacheGeo) return null;
    const o = cacheGeo.origin || { tx: 0, ty: 0 }, out = {};
    for (const k in valPlan.bayTileToAgent) { const p = k.split(','); out[(+p[0] + o.tx) + ',' + (+p[1] + o.ty)] = valPlan.bayTileToAgent[k]; }
    return out;
  }
  function onBuildDeliver(bx, x, y) {
    pushFlash([{ x1: x, y1: y, x2: x, y2: y }], false); sfx('click');
    const p = bx.payload || {};
    if (!p.test) return;
    const stops = testStops() || {};
    const owner = stops[x + ',' + y];
    if (!p.outbound && owner) {
      // stage ③ + ④: the dock consumed the job — and the finished work ships back out from the same dock.
      // fromAgentId stamps the PRODUCER on the return crate (same field the live handoff physics rides —
      // conveyor.js: a dock never eats its own output), so stage ⑤ below can tell a handoff from a ship-out.
      note(x, y, '③ DELIVERED — ' + agentLabelFor(owner) + "'S DOCK (they work it at their desk)", '#e8c860');
      convey.enqueueAt(x, y, { test: true, outbound: true, box: 'product', fromAgentId: owner, workitemId: 'test-out-' + (++_testN) });
      setTimeout(() => note(x, y + 1, '④ THE RESULT SHIPS FROM THE DOCK…', '#9adcb0'), 900);
    } else if (p.outbound) {
      // stage ⑤ forks on WHERE the outbound crate landed: a FOREIGN bound dock's hookup tile is a HANDOFF
      // (this dock's output becomes that agent's input — the chain layer), not a ship-out. Only an open
      // end / outbox mouth is the whole loop. The stops map knows the tile's owner; the crate knows its
      // producer — so the caption can only say what the engine actually did.
      if (owner && owner !== p.fromAgentId) {
        note(x, y, '⑤ HANDED OFF TO ' + agentLabelFor(owner) + ' — its output becomes their input', '#e8c860');
      } else {
        note(x, y, '⑤ …AND OUT. THAT IS THE WHOLE LOOP', '#7ee2a8');
      }
    } else {
      note(x, y, '③ SANK — no assigned dock on this line', '#ffbe3c');
    }
  }
  // stage-② watcher: caption the junction decision the moment the engine makes it (same onAdvance seam
  // the telemetry uses — the caption can only ever say what the engine actually did)
  function onBuildAdvance(bx, info) {
    if (!bx.payload || !bx.payload.test || !info || !info.tile) return;
    if (info.kind === 'filter') note(info.tile.x, info.tile.y, '② SORTED: ' + (info.tag || '?') + ' → ' + info.lane, '#5ad0ff');
    else if (info.kind === 'split') note(info.tile.x, info.tile.y, '② SPLIT: balancing lanes', '#5ad0ff');
    // no merge caption: the merger is a LANE FUNNEL — conveyor.js never emits `absorbed` (the old
    // "held for the batch" branch described a combine the harness never performed; see chooseExit).
  }
  // the INTAKE's belt-adjacent tile (where a box spawns), or null if no INTAKE sits on a belt.
  // DOC-ORDER FIRST INTAKE — kept ONLY as the manual ▸ TEST's last-resort fallback when no
  // compiled lane reaches a bound dock yet (the "③ SANK" caption is the honest teaching there).
  function intakeBeltTile() {
    const intake = station.props().find(p => p.t === 'intake');
    if (!intake) return null;
    const w = intake.w || 1, h = intake.h || 1;
    for (let yy = intake.y - 1; yy <= intake.y + h; yy++)
      for (let xx = intake.x - 1; xx <= intake.x + w; xx++)
        if (station.beltAt(xx, yy)) return { x: xx, y: yy };
    return null;
  }
  /* the ride's SPAWN mouth, WORLD tiles — reach-aware (conveyor-audit 2026-08-10). The first
     intake in doc order can be a decorative/unfinished one on a DIFFERENT line; a ride that
     enters there sinks with "③ SANK" at the exact teachable moment. So the ride enters through
     a door that provably leads somewhere, read from the SAME compiled plan the sidecar routes by
     (mirror of ghostline's spawn rule + world.js's addressed-crate physics):
       • agentId given (the line under test — the first ride names the dock whose reach flipped) →
         Pipeline.sourceFor: the mouth whose lane actually REACHES that dock, or null (no guess);
       • lineless (the toolbar ▸ TEST) → the first source in PLAN order with a reaching mouth.
     Plan mouths are LOCAL-frame (valPlan compiles from cacheGeo) → rebase by the geo origin,
     the same rebase testStops() rides. */
  function rideMouthFor(agentId) {
    if (!valPlan || !valPlan.sources || !valPlan.sources.length || !cacheGeo) return null;
    if (typeof Pipeline === 'undefined' || !Pipeline.sourceFor) return null;
    const o = cacheGeo.origin || { tx: 0, ty: 0 }, rb = t => ({ x: t.x + o.tx, y: t.y + o.ty });
    if (agentId) { const t = Pipeline.sourceFor(valPlan, agentId); return t ? rb(t) : null; }
    // lineless: every reaching dock names its own front door; the earliest such mouth in plan
    // order wins (deterministic — plan order + ring-scan order are both fixed, like resolveTarget)
    const mouths = [];
    for (const a in (valPlan.reach || {})) {
      if (!valPlan.reach[a]) continue;
      const t = Pipeline.sourceFor(valPlan, a);
      if (t) mouths.push(t);
    }
    if (!mouths.length) return null;
    for (const s of valPlan.sources) {
      const ts = (s.tiles && s.tiles.length) ? s.tiles : (s.tile ? [s.tile] : []);
      for (const mt of ts) if (mouths.some(m => m.x === mt.x && m.y === mt.y)) return rb(mt);
    }
    return rb(mouths[0]);
  }
  let _testN = 0;
  // fire one box per content tag at the INTAKE so you watch them SORT through your FILTERs to the right
  // bays. Returns true only when boxes actually rode — the auto first ride burns its one-shot on that.
  function sendTestBoxes(ev, auto, agentId) {
    if (!convey) return false;
    // reach-verified mouth first; the doc-order intake only for a MANUAL test on a floor where
    // nothing reaches yet. The AUTO ride never takes the fallback: it only ever fires because a
    // line powered on, and a decorative intake would spend the one narration on a sink.
    const t = rideMouthFor(agentId) || (auto ? null : intakeBeltTile());
    if (!t) { if (!auto) { flashTip(ev, 'place an INBOX on a belt first', false); sfx('bad'); } return false; }
    for (const tag of ['code', 'research', 'general']) convey.enqueueAt(t.x, t.y, { workitemId: 'test-' + (++_testN), tag, preview: 'test ' + tag, test: true });
    note(t.x, t.y, '① OUTSIDE WORK ENTERS HERE (DMs · routines)', '#e8c860');
    flashTip(ev, auto ? 'LINE COMPLETE — the first crate rides itself. ▸ TEST replays this any time' : 'test work riding — watch the loop', true);
    sfx('click');
    return true;
  }

  /* ---------- THE FIRST CRATE NARRATES ITSELF (2026-08-04 onramp) ----------
     The first time this station's floor compiles COMPLETE in REFIT — an INTAKE lane actually
     reaching a BOUND bay (valPlan.reach), which is the moment liveTiles first energize a full
     route — the narrated ▸ TEST ride auto-runs once, unprompted. That is exactly the teachable
     moment: the user just bound the agent that powered the line on. Once per station, persisted
     in localStorage keyed by the station doc's createdAt (doc.meta is whitelisted-fields
     territory in migrate() — a save-schema field for a UI one-shot is the wrong tool; localStorage
     mirrors the SEEN_KEY idiom above and survives reloads the same way).
     LAW (tutorial-audit 2026-08-03): anything coach-like stands down while the tutorial is
     coaching — gate on Tutorial.isCoaching() and the `.refit-firstrun` card, NEVER `.refit-guide`
     (the bay/flow/junction editors share that class; suppressing on it would kill the ride the
     moment the bay picker that caused it closed). Gated attempts stay ARMED (ridePending) and
     fire from the frame loop once the coach clears — a deferred ride must not need another edit
     to re-trigger. A blueprint stamp alone can never fire this: its bays stamp unbound, so reach
     stays false until an agent is truly bound. */
  // one per-station localStorage key root, shared by the first-ride flag and the finish-the-line
  // registry (same doc.meta.createdAt derivation — a UI one-shot never rides the save schema).
  /* THE STATION'S OWN NAMESPACE. Every one-shot below (first ride, ORDERS dismissal, the finish-the-line
     registry) is per-STATION, so it must hang off a durable per-station id — `doc.meta.createdAt`, stamped
     once at creation and backfilled once on migrate (worldmodel.js stationId). Before 2026-08-07 nothing
     ever stamped it, so this always answered 'default' and every "per-station" latch was in fact global:
     a brand-new station inherited the first one's dismissals, never saw its first ride, and had its first
     line retired before the card was ever shown. 'default' survives only as the storage-broken fallback. */
  function stationKeyOf(st) {
    let k = 'default';
    try { const d = st && st.doc && st.doc(); if (d && d.meta && d.meta.createdAt) k = String(d.meta.createdAt); } catch (e) {}
    return k;
  }
  const RIDE_KEY = () => 'starnet.refit.firstride.' + stationKeyOf(station);
  function rideSeen() { try { return !!localStorage.getItem(RIDE_KEY()); } catch (e) { return true; } }   // broken storage → never risk a repeat
  function markRide() { try { localStorage.setItem(RIDE_KEY(), '1'); } catch (e) {} }
  let ridePending = false, rideTimer = 0, rideAgentId = null, ridePrevReach = null;
  function maybeFirstRide() {
    /* THE RIDE NAMES ITS LINE (conveyor-audit 2026-08-10). "Complete" used to be any reach=true
       plus any doc-order intake — on a floor with an older decorative intake, the one narrated
       ride entered the WRONG line and sank. Now the arm records WHICH dock powered on (prefer
       the reach that flipped true THIS compile — that bind is the teachable moment; a session's
       first compile baselines against nothing, so an already-complete floor still narrates), and
       fireFirstRide rides THAT dock's own front door via rideMouthFor. */
    const prev = ridePrevReach || {}, now = {};
    if (valPlan && valPlan.reach) for (const a in valPlan.reach) if (valPlan.reach[a]) now[a] = true;
    ridePrevReach = now;
    if (ridePending || rideSeen()) return;
    let rideA = null;
    for (const a in now) if (!prev[a]) { rideA = a; break; }   // freshly powered line first
    if (!rideA) for (const a in now) { rideA = a; break; }     // else any provably-reaching one
    if (!rideA || !rideMouthFor(rideA)) return;   // complete = an intake lane reaches a bound bay, entered through ITS OWN mouth
    rideAgentId = rideA;
    ridePending = true;   // armed — frame() fires it once nothing coach-like is up
  }
  function fireFirstRide() {
    ridePending = false;
    // a beat after the bind flash so the two tips don't stomp each other mid-read. The flag is
    // consumed ONLY WHEN THE RIDE ACTUALLY NARRATES — sendTestBoxes returning true on the reaching
    // line's own mouth. Closing REFIT inside the beat, or a floor edit that dissolves the line
    // under it, keeps the one shot (the next compile re-arms via maybeFirstRide).
    rideTimer = setTimeout(() => { rideTimer = 0; if (running && convey && sendTestBoxes(null, true, rideAgentId)) markRide(); }, 700);
  }
  // render the stage captions: VT323 phosphor, brief rise + fade, world coords (drawn after the boxes)
  function drawTestNotes(now, t) {
    if (!testNotes.length) return;
    // ride captions register on the activeFlow layer (a running ▸ TEST is a live gesture — it
    // outranks hover/nags, and the arbiter keeps overlapping captions from garbling each other)
    ctx.save();
    ctx.font = VAL_FONT();
    for (let i = testNotes.length - 1; i >= 0; i--) {
      const n = testNotes[i], k = (now - n.t0) / NOTE_MS;
      if (k >= 1) { testNotes.splice(i, 1); continue; }
      const rise = Math.min(1, k * 4) * 4 + k * 3;
      const fs = Math.max(9, 11 / zoom), tw = ctx.measureText(n.text).width;
      const lx = (n.x + 0.5) * t, ly = n.y * t - 3 - rise;
      voiceSay('activeFlow', { x: n.x * t, y: n.y * t, w: t, h: t }, { x: lx - tw / 2, y: ly - fs, w: tw, h: fs }, (c) => {
        c.save();
        c.font = VAL_FONT(); c.textAlign = 'center'; c.textBaseline = 'bottom';
        c.globalAlpha = k < 0.12 ? k / 0.12 : (1 - k) / 0.88;
        c.shadowBlur = 3; c.shadowColor = n.col; c.fillStyle = n.col;
        c.fillText(n.text, lx, ly);
        c.restore();
      });
    }
    ctx.restore();
  }

  /* ---------- FINISH THE LINE (guided workflows Phase 2, 2026-08-05) ----------
     A compact checklist card anchored beside a stamped/incomplete line, derived ONLY from provable
     state: the COMPILED plan (crew count = its UNBOUND_BAY warns over this line's docks), the
     server-proven feed truth (World.feedState — the exact NO FEED source), and the sample-job seam
     (feature-detected, below). LAWS: never blocks editing (a floating side card, no backdrop),
     dismissible, stands down while the tutorial coaches (Tutorial.isCoaching / .refit-firstrun —
     same gate as the first ride), and retires PERMANENTLY per line when that line's first real
     product crate delivers (world.js's delivery seam calls noteLineDelivered — event-driven).
     Line identity + membership come from Pipeline.lineComponents (key = smallest member prop id,
     stable in the save); retirement/dismissal persist in localStorage beside the first-ride flag. */
  const FIN_KEY = st => 'starnet.refit.finline.' + stationKeyOf(st || station);
  function finRead(st) {
    try { const o = JSON.parse(localStorage.getItem(FIN_KEY(st)) || '{}'); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
  }
  function finMark(st, key, field) {
    try {
      const o = finRead(st);
      o[key] = Object.assign({}, o[key]); o[key][field] = 1;
      localStorage.setItem(FIN_KEY(st), JSON.stringify(o));
    } catch (e) {}
  }
  /* SAMPLE-JOB seam detection (Phase 4 lands in parallel — never hardcode its presence): the card
     asks `GET /api/routing/sample` once per REFIT session. Present = any real answer that isn't a
     route-miss (404/405); absent = the router's static 404. An OPTIONS probe is useless here — the
     sidecar 204s OPTIONS on EVERY /api/* path before dispatch (index.js preflight branch). A POST
     probe is forbidden: when the seam exists a POST IS the paid sample dispatch. Fails SAFE: on any
     doubt the button renders disabled ("coming online soon") and no request can spend anything. */
  let finSample = null;   // null = unprobed/in flight · false = absent · true = present
  const finApi = p => ((typeof window !== 'undefined' && window.__STARNET_API__) ? window.__STARNET_API__ : '') + p;
  function probeSampleSeam() {
    if (finSample !== null || typeof fetch === 'undefined') return;
    try {
      fetch(finApi('/api/routing/sample'))
        .then(r => { finSample = !!(r && r.status !== 404 && r.status !== 405); renderFinCard(); })
        .catch(() => { finSample = false; renderFinCard(); });
    } catch (e) { finSample = false; }
  }
  let valComps = null;          // Pipeline.lineComponents of the CURRENT compiled geometry (set in rebake)
  let lastStampIds = null;      // prop ids of the line stamped this session → the card adopts that line
  const stampNameOf = {};       // intake propId -> blueprint label (session-scoped; the name field's placeholder)
  let finKeySel = null;         // the line key the card is focused on (session-scoped)
  let finCardEl = null, finComp = null, finSig = '', finPollTs = 0;
  function finState(c) {
    const unbound = c.bays.filter(b => !b.agentId);
    const feed = (opts && opts.world && opts.world.feedState) ? opts.world.feedState() : { known: false, fed: false };
    const hasIntake = c.intakes.length > 0;
    const feedDone = hasIntake && feed.known && feed.fed;
    return { unbound, crewLeft: unbound.length, hasIntake, feed, feedDone,
      todo: unbound.length > 0 || (hasIntake && feed.known && !feed.fed) };
  }
  function finPick() {
    if (!valComps || !valComps.length) return null;
    const reg = finRead(station);
    const live = valComps.filter(c => c.bays.length && c.beltCount && !(reg[c.key] && (reg[c.key].done || reg[c.key].dis)));
    if (!live.length) return null;
    const sel = live.find(c => c.key === finKeySel);
    if (sel) return sel;
    // otherwise: the first line with something left to DO. A fully-crewed+fed veteran line that was
    // never stamped this session stays quiet (its remaining step is the sample, offered only in the
    // stamp session) — the card guides work, it doesn't haunt finished floors.
    const next = live.find(c => finState(c).todo) || null;
    if (next) finKeySel = next.key;
    return next;
  }
  /* ---------- STATION ORDERS (2026-08-07 round 3) ----------
     FINISH THE LINE only appears once a work line already compiles — so the Commander who most
     needs a next step, the one standing on a bare starter HAB, was the one shown nothing. ORDERS
     is the stage before it, in the SAME card slot (never a second floating panel — the one-voice
     law), handing off the moment a line exists.

     Every step is a live projection of the model, and every step ARMS THE TOOL that does it —
     the checklist is the control, not a description of one. It gates NOTHING: this is the station
     arc vocabulary quests.js already ships ("honest-loot… like everything here it gates nothing"),
     brought to where the work happens. Dismissable forever. */
  // PER STATION, like every other one-shot here (stationKeyOf) — this shipped with no suffix at all, so
  // dismissing ORDERS on one station silently dismissed it on every station the Commander ever builds.
  const ORDERS_KEY = () => 'starnet.refit.orders.dis.' + stationKeyOf(station);
  const ordersDismissed = () => { try { return !!localStorage.getItem(ORDERS_KEY()); } catch (e) { return false; } };
  let ordersSeenDone = null;   // which steps were already done last render (so a NEW completion can chime)

  function ordersSteps() {
    const rooms = station.rooms(), props = station.props();
    const kinds = station.ROOM_KINDS || {};
    const spaces = rooms.length;
    // "dressed" = the Commander made an explicit surface choice somewhere. A room carries null on
    // every surface field until they do, so this can never read true off a fresh station.
    const dressed = rooms.some(r => r.floorMat || r.wallMat || r.hullMat || r.wallStyle || r.hullStyle
      || (r.floorPaint && Object.keys(r.floorPaint).length)
      || (r.floorStyle && kinds[r.kind] && r.floorStyle !== kinds[r.kind].floor));
    const desk = props.some(p => WORKSTATION_TYPES[p.t]);
    const line = props.some(p => p.t === 'bay') && props.some(p => p.t === 'intake' || p.t === 'outbox');
    return [
      { id: 'grow', done: spaces >= 2, label: 'ADD A SECOND SPACE', tool: 'room', tip: 'a room or a hallway — your agent walks what you build' },
      { id: 'dress', done: dressed, label: 'LAY A DECK YOU LIKE', tool: 'paint', tip: 'pick a material and a colour, then click a room' },
      { id: 'desk', done: desk, label: 'PUT DOWN A WORKSTATION', tool: 'prop', tip: 'an agent walks to its desk to do real work' },
      { id: 'line', done: line, label: 'STAMP A WORK LINE', tool: 'line', tip: 'a whole working layout in one click — yours to edit' },
    ];
  }

  function renderOrders() {
    bumpUi();   // same as renderFinCard: the card in this slot is about to be rebuilt/re-measured
    if (ordersDismissed()) {
      if (finCardEl && finCardEl.parentNode) finCardEl.parentNode.removeChild(finCardEl);
      finCardEl = null; finComp = null; finSig = '';
      return;
    }
    const steps = ordersSteps();
    const done = steps.filter(s => s.done).length;
    const sig = 'orders|' + steps.map(s => (s.done ? 1 : 0)).join('');
    if (!finCardEl) {
      finCardEl = document.createElement('div');
      finCardEl.className = 'refit-finline refit-orders';
      root.appendChild(finCardEl);
    } else if (sig === finSig) return;
    // a step that flipped to done SINCE the last render earns the cue — never on the first paint,
    // or every reopened session would replay the whole checklist at you
    if (ordersSeenDone) { for (const s of steps) if (s.done && !ordersSeenDone[s.id]) { sfx('quest'); break; } }
    ordersSeenDone = {}; for (const s of steps) if (s.done) ordersSeenDone[s.id] = 1;
    finSig = sig; finComp = null;
    finCardEl.className = 'refit-finline refit-orders';
    finCardEl.innerHTML = '<div class="fl-head"><span class="fl-title">▸ STATION ORDERS</span>'
      + '<span class="fl-count">' + done + '/' + steps.length + '</span>'
      + '<button type="button" class="bb sm fl-x" title="dismiss — you know the controls">✕</button></div>'
      + steps.map((s, i) => '<button type="button" class="bb fl-step' + (s.done ? ' done' : '') + '" data-ord="' + s.id + '"'
        + ' title="' + esc(s.tip) + '">' + (s.done ? '✓ ' : '①②③④'[i] + ' ') + esc(s.label) + '</button>').join('');
    finCardEl.querySelector('.fl-x').onclick = () => {
      try { localStorage.setItem(ORDERS_KEY(), '1'); } catch (e) {}
      sfx('click'); renderOrders();
    };
    finCardEl.querySelectorAll('[data-ord]').forEach(b => {
      const s = steps.find(x => x.id === b.dataset.ord);
      b.onclick = () => { if (s) { selectTool(s.tool); flashTip(null, s.tip, true); } };
    });
  }

  function renderFinCard() {
    if (!root || !running) return;
    bumpUi();   // the card is about to be re-measured/rebuilt — drop its pinned-position memo
    const c = finPick();
    if (!c) { renderOrders(); return; }   // no line yet → the stage BEFORE it, in the same slot
    finComp = c;
    const st = finState(c);
    // the card is titled with the LINE'S NAME (the intake's saved label — line naming); unnamed lines
    // keep the generic header. In the sig so a rename repaints without a topology edit.
    const lname = lineNameOf(c);
    const sig = [c.key, st.crewLeft, st.hasIntake, st.feed.known, st.feed.fed, finSample, lname || ''].join('|');
    if (!finCardEl) {
      finCardEl = document.createElement('div');
      root.appendChild(finCardEl);
    } else if (sig === finSig) return;
    // ...and always restate the class: this element is SHARED with STATION ORDERS (the stage before
    // a line exists), so handing off from orders to the line card has to shed `refit-orders` or the
    // card keeps orders' styling — and positionFinCard keys its top-right parking on that class.
    finCardEl.className = 'refit-finline';
    finSig = sig;
    const crewDone = st.crewLeft === 0;
    const crewTxt = crewDone ? '✓ DOCKS CREWED' : '① CREW THE DOCKS — ' + st.crewLeft + ' TO GO';
    const feedTxt = !st.hasIntake ? '② FEED IT — TASK THE AGENT, OR WIRE A ROUTINE'
      : !st.feed.known ? '② FEED THE INBOX — CHECKING THE WIRES…'
      : st.feed.fed ? '✓ INBOX FED' : '② FEED THE INBOX — CONNECT A CHANNEL OR ROUTINE';
    const sampleOn = finSample === true && crewDone;
    const sampleTip = finSample !== true ? 'coming online soon' : (crewDone ? 'feed ONE real, clearly-labeled sample job through the whole line' : 'crew the docks first');
    finCardEl.innerHTML = `
      <div class="fl-head"><span class="fl-title">▸ ${lname ? 'FINISH ' + esc(lname.toUpperCase()) : 'FINISH THE LINE'}</span><button type="button" class="bb sm fl-x" title="dismiss for this line">✕</button></div>
      <button type="button" class="bb fl-step${crewDone ? ' done' : ''}" data-act="crew"${crewDone ? ' disabled' : ''}>${esc(crewTxt)}</button>
      <button type="button" class="bb fl-step${st.feedDone ? ' done' : ''}" data-act="feed"${st.feedDone ? ' disabled' : ''}>${esc(feedTxt)}</button>
      <button type="button" class="bb fl-step${sampleOn ? '' : ' off'}" data-act="sample" title="${esc(sampleTip)}">③ RUN A SAMPLE JOB</button>`;
    finCardEl.querySelector('.fl-x').onclick = () => { finMark(station, c.key, 'dis'); sfx('click'); renderFinCard(); };
    const bCrew = finCardEl.querySelector('[data-act="crew"]');
    if (bCrew && !crewDone) bCrew.onclick = () => finFocusCrew(c);
    const bFeed = finCardEl.querySelector('[data-act="feed"]');
    if (bFeed && !st.feedDone) bFeed.onclick = () => finOpenFeed(c);
    const bSample = finCardEl.querySelector('[data-act="sample"]');
    if (bSample) bSample.onclick = () => { if (sampleOn) finRunSample(c); };
  }
  // ① — center the camera on the next unbound dock and open the SAME picker a direct click opens
  function finFocusCrew(c) {
    const b = finState(c).unbound[0];
    if (!b || !cacheGeo) return;
    const o = cacheGeo.origin || { tx: 0, ty: 0 }, t = T();
    panX = cv.width / 2 - (b.x + o.tx + b.w / 2) * t * zoom;
    panY = cv.height / 2 - (b.y + o.ty + b.h / 2) * t * zoom;
    sfx('click');
    openStepCard(b.propId, null);
  }
  // ② — ONE SURFACE (inbox-trigger, 2026-08-05): the line's own INBOX card carries the TRIGGER zone
  // (feed truth, this line's routines, create-right-here, and the CHANNELS/AUTOMATION doors), so the FEED
  // step opens THAT — the trigger is defined on the floor, not behind a blind hop to the messaging term.
  // A line with no intake keeps the old door: the CHANNELS panel is the only feed surface it has.
  function finOpenFeed(c) {
    sfx('click');
    const iid = c && c.intakes && c.intakes[0];
    if (iid && station.propById(iid)) { openFlowCard(iid); return; }
    close();
    if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('messaging');
  }
  // ③ — Phase 4's seam, fired only when detected present + docks crewed. The card claims nothing the
  // harness didn't answer: success/refusal both surface as the server's own verdict.
  function finRunSample(c) {
    sfx('click');
    try {
      fetch(finApi('/api/routing/sample'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line: c.key }) })
        .then(r => { if (r && r.ok) flashTip(null, 'sample job dispatched — watch the line', true); else flashTip(null, 'sample refused (HTTP ' + (r ? r.status : '?') + ')', false); })
        .catch(() => flashTip(null, 'sample failed — sidecar unreachable', false));
    } catch (e) {}
  }
  // per-frame: hide while anything coach-like is up (same gate family as the first ride), else pin
  // the card beside the line's bounding box in screen space (the flashTip/clientX coordinate basis).
  /* PIN ONLY WHEN SOMETHING MOVED (2026-08-08 perf pass). This ran three getBoundingClientRects and
     two style writes on EVERY frame — the writes dirty layout, so the next frame's reads are forced
     layouts, i.e. the loop paid for its own invalidation forever. The card's position is a pure
     function of a handful of values: the camera, the window, REFIT's own chrome (dock width / card
     size, tracked by uiVer), the text-size zoom, and which line it is anchored to. Sign those; an
     unchanged signature means the pin is already correct and the frame owes it nothing.
     The coach gate CLEARS the signature so the card is always re-pinned when it comes back. */
  let finPosSig = '';
  let uiVer = 1;   // bumped wherever REFIT's own DOM geometry can move — see bumpUi()
  function bumpUi() { uiVer++; finPosSig = ''; }
  function positionFinCard() {
    if (!finCardEl) return;
    if (tutorialCoaching() || (root && root.querySelector('.refit-firstrun'))) { finCardEl.style.display = 'none'; finPosSig = ''; return; }
    const c = finComp;
    /* ORDERS mode has no line to anchor to (that is the whole point of it), so it parks in the top
       right of the glass — clear of the left dock and of the action deck above. FINISH THE LINE
       still tracks its own line's bbox below. */
    if (!c && finCardEl.classList.contains('refit-orders')) {
      if (!cv) return;
      finCardEl.style.display = '';
      const osig = 'o|' + uiVer + '|' + window.innerWidth + '|' + window.innerHeight + '|' + U.uiZoom();
      if (osig === finPosSig) return;
      const r0 = cv.getBoundingClientRect();
      if (!r0.width) return;
      finPosSig = osig;
      const z = U.uiZoom(), cr0 = finCardEl.getBoundingClientRect();
      finCardEl.style.left = Math.round((r0.right - (cr0.width || 236 * z) - 14 * z) / z) + 'px';
      finCardEl.style.top = Math.round((r0.top + 58 * z) / z) + 'px';
      return;
    }
    if (!c || !c.bbox || !cacheGeo || !cv) return;
    finCardEl.style.display = '';
    const o = cacheGeo.origin || { tx: 0, ty: 0 }, t = T();
    const lsig = 'l|' + uiVer + '|' + zoom + '|' + panX + '|' + panY + '|' + t + '|' + o.tx + ',' + o.ty
      + '|' + window.innerWidth + '|' + window.innerHeight + '|' + U.uiZoom()
      + '|' + c.key + '|' + c.bbox.x1 + ',' + c.bbox.y1 + ',' + c.bbox.x2 + ',' + c.bbox.y2;
    if (lsig === finPosSig) return;
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    finPosSig = lsig;
    const uiz = U.uiZoom();
    const sx = w => r.left + (w * zoom + panX) * (r.width / cv.width);
    const sy = w => r.top + (w * zoom + panY) * (r.height / cv.height);
    const cr = finCardEl.getBoundingClientRect();
    const w = cr.width || 232 * uiz, h = cr.height || 118 * uiz;
    // NEVER over the tool dock (the never-blocks-editing law): a left-sidebar dock raises the floor x
    const dock = root.querySelector('.refit-dock');
    let minX = 8;
    if (dock) { const d = dock.getBoundingClientRect(); if (d.width < window.innerWidth * 0.6 && d.left < window.innerWidth / 2) minX = Math.max(minX, d.right + 10); }
    const rightX = sx((c.bbox.x2 + 1 + o.tx) * t) + 14;
    const leftX = sx((c.bbox.x1 + o.tx) * t) - w - 14;
    let x, y;
    if (rightX + w <= window.innerWidth - 8) { x = rightX; y = sy((c.bbox.y1 + o.ty) * t) - 4; }          // beside, to the right
    else if (leftX >= minX) { x = leftX; y = sy((c.bbox.y1 + o.ty) * t) - 4; }                            // beside, to the left
    else { x = sx((c.bbox.x2 + 1 + o.tx) * t) - w; y = sy((c.bbox.y2 + 1 + o.ty) * t) + 12; }             // no side room — under the line
    x = Math.max(minX, Math.min(x, window.innerWidth - w - 8));
    y = Math.max(56, Math.min(y, window.innerHeight - h - 8));
    finCardEl.style.left = Math.round(x / uiz) + 'px';
    finCardEl.style.top = Math.round(y / uiz) + 'px';
  }
  /* the delivery-retirement hook — world.js calls this (WORLD tiles) when a real product crate sinks
     at an outbox mouth. Works with REFIT closed: resolves the station via opts and maps the tile to
     its line in a fresh geometry frame. First delivery wins; done is forever (per station+line). */
  function noteLineDelivered(wtx, wty) {
    /* THE LIVE STATION WINS. This hook fires from world.js with REFIT CLOSED, and close() never nulls the
       module-level `station` — so preferring it meant the retirement was booked against whatever station
       the last REFIT session held. Load a different save and the first real delivery retired a line on the
       station you are no longer standing in. opts.getStation() is the app's live station; the stale
       module field is only the fallback for a harness that injected no getter. */
    const live = (opts && typeof opts.getStation === 'function') ? opts.getStation() : null;
    const st = live || station;
    if (!st || typeof Pipeline === 'undefined' || !Pipeline.lineComponents) return;
    let geo = null;
    try { geo = st.projectGeometry(); } catch (e) { return; }
    const o = (geo && geo.origin) || { tx: 0, ty: 0 };
    const k = (wtx - o.tx) + ',' + (wty - o.ty);
    for (const c of Pipeline.lineComponents(geo)) {
      if (!c.tiles[k]) continue;
      const reg = finRead(st);
      if (!(reg[c.key] && reg[c.key].done)) finMark(st, c.key, 'done');
      if (running) renderFinCard();
      return;
    }
  }

  /* ---------- AIRLOCK door-state picker: cycle a room's SPATIAL seal (floor containment, NOT capability
     isolation). closed/jammed SEAL the room — its agent's BODY can't path in or out (a staging seal, the
     unmerged-branch metaphor); open = connected to trunk. Sealing does NOT change the agent's run/tools/caps
     — the BAY governs capability. */
  /* ---------- THE ROOM CARD (2026-08-07) ----------
     SELECT's contract was "click a machine to open it", and clicking a ROOM — the thing you spend
     build mode making — did nothing at all. The most-clicked surface in the editor was a dead
     click, and `station.renameRoom` had shipped in the model with no UI anywhere to reach it.
     This card is the room's own sheet: what it is, how big, what it's made of, and the three verbs
     that already existed (rename · re-deck · delete), each routed through the same mutation API the
     tools use — no new model surface, no state of its own. */
  function openRoomCard(roomId, ev) {
    if (!root) return;
    const rm = station.roomById(roomId); if (!rm) return;
    cardCloseAll();
    const isSpawn = roomId === station.spawnRoomId();
    const kd = station.ROOM_KINDS[rm.kind] || {};
    const matId = station.matOfRoom ? station.matOfRoom(roomId) : (rm.floorMat || kd.mat);
    const matDef = station.FLOOR_MATERIALS[matId] || {};
    const hueDef = station.FLOOR_STYLES[rm.floorStyle] || {};
    let tiles = 0;
    for (const r of rm.rects) tiles += (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1);
    const b = rm.rects[0], w = b.x2 - b.x1 + 1, h = b.y2 - b.y1 + 1;
    const shape = rm.rects.length > 1 ? (rm.rects.length + ' SECTIONS') : (w + ' × ' + h);
    const g = document.createElement('div');
    g.className = 'refit-guide refit-room-card';
    g.innerHTML = `
      <div class="refit-guide-card">
        <h3>▮ ${esc((rm.name || roomId).toUpperCase())}</h3>
        <div class="refit-sec">THE ROOM</div>
        <div class="step-fact"><b>${esc(kd.label || rm.kind)}</b>${isSpawn ? ' · the spawn room' : ''}</div>
        <div class="step-fact">${esc(shape)} · <b>${tiles}</b> tiles of deck</div>
        <div class="step-fact">deck: <b>${esc(matDef.label || matId || '—')}</b> in <b>${esc(hueDef.label || rm.floorStyle || '—')}</b></div>
        <div class="refit-sec">NAME</div>
        <input id="room-name" class="refit-input" type="text" maxlength="40" placeholder="name this room" value="${esc(rm.name || '')}" />
        <div class="refit-note">saved on Enter — it labels the room on the floor</div>
        <div class="refit-actions">
          <button type="button" class="btn-sm" id="room-deck">▧ RE-DECK</button>
          <button type="button" class="btn-sm" id="room-move">✥ MOVE</button>
          <!-- NOT an emoji bin here: a colour-emoji glyph is a different font at a different weight
               beside VT323 (the symbol-glyph law). ⌫ is the same mark the armed state uses. -->
          <button type="button" class="btn-sm refit-danger" id="room-del">${isSpawn ? '⌂ PROTECTED' : '⌫ DELETE'}</button>
          <button type="button" class="btn-sm" id="room-close">CLOSE</button>
        </div>
      </div>`;
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));
    const nameEl = g.querySelector('#room-name');
    // the rename is saved by CLOSING, like the step card's brief and the flow card's line name — removing a
    // focused input does not reliably fire blur, so ESC/✕ used to drop a typed name on the floor.
    let savedName = rm.name || '';
    const saveName = () => {
      const v = (nameEl.value || '').trim();
      if (v === savedName) return;
      const res = station.renameRoom(roomId, v);
      if (res && res.ok) { savedName = v; sfx('click'); flashTip(ev, 'renamed', true); } else sfx('bad');
    };
    const closeC = () => { saveName(); if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeC);
    nameEl.onkeydown = e => { if (e.key === 'Enter') { saveName(); closeC(); } };
    nameEl.onblur = saveName;
    // the two verbs that are TOOLS: arm the tool on this room rather than duplicating its behaviour
    g.querySelector('#room-deck').onclick = () => { closeC(); selectTool('paint'); flashTip(ev, 'SURFACE armed — click the room to lay this deck', true); };
    g.querySelector('#room-move').onclick = () => { closeC(); selectTool('move'); flashTip(ev, 'MOVE armed — drag the room', true); };
    const del = g.querySelector('#room-del');
    if (isSpawn) { del.disabled = true; del.title = 'the spawn room can’t be deleted — MOVE it instead'; }
    // two-step arm, never a native confirm() (no OS dialogs — the station owns its own chrome)
    else if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
      ArmConfirm.wire(del, { armedLabel: '⌫ REALLY DELETE?', onConfirm: () => { doDeleteRoom(roomId, ev); closeC(); } });
    } else del.onclick = () => { doDeleteRoom(roomId, ev); closeC(); };
    g.querySelector('#room-close').onclick = closeC;
    g.addEventListener('click', e => { if (e.target === g) closeC(); });
    setTimeout(() => { try { nameEl.focus(); nameEl.select(); } catch (e) {} }, 30);
  }
  // the ONE room-removal path the card and the DELETE tool both take (flash, undo nudge, honest refusal)
  function doDeleteRoom(roomId, ev) {
    const rm = station.roomById(roomId);
    const res = station.removeRoom(roomId);
    if (res && res.ok) { if (rm) pushFlash(rm.rects, true); flashUndo(); flashTip(ev, 'deleted — UNDO to restore', true); sfx('click'); }
    else if (res && res.error === 'SPAWN_ROOM') { flashTip(ev, 'spawn room — can’t delete (try MOVE)'); sfx('bad'); }
    else { flashTip(ev, (res && res.msg) || 'blocked'); sfx('bad'); }
  }

  function openDoorPicker(propId, ev) {
    if (!root) return;
    const p = station.propById(propId); if (!p || p.t !== 'airlock') return;
    cardCloseAll();
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
        <div class="refit-agents">${rows}</div>
        <div class="refit-actions">
          <button type="button" class="btn-sm" id="door-cancel">CANCEL</button>
        </div>
      </div>`;
    root.appendChild(g);
    requestAnimationFrame(() => g.classList.add('refit-swap'));   // soft rise-in on open (reduced-motion safe)
    const closeP = () => { if (g.parentNode) g.parentNode.removeChild(g); };
    cardRegister(g, closeP);
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
    bumpUi();   // the glass moved — every memoized chrome measurement is stale (positionFinCard)
    dpr = window.devicePixelRatio || 1;
    // TEXT SIZE zoom parity with world.js resize(): body.style.zoom shrinks layout px, so bake the
    // factor back in or the REFIT floor upscales soft. Picking stays rect-ratio-based (canvasPoint).
    const uiz = (() => { const z = parseFloat(document.body && document.body.style ? document.body.style.zoom : ''); return z > 0 ? z : 1; })();
    cv.width = Math.max(1, Math.round(cv.clientWidth * dpr * uiz));
    cv.height = Math.max(1, Math.round(cv.clientHeight * dpr * uiz));
    updateSafetyClearance();
  }
  // the chrome-occluded margins of the canvas (device px): the build panel (left sidebar on
  // desktop, bottom sheet on narrow screens) + the top bar — so FIT frames the station in the
  // VISIBLE viewport instead of centering half of it behind the panel.
  /* viewInsets reads three getBoundingClientRects — cheap once, but it is now consulted from the
     draw loop (the gesture badge and the invitation clamp to the VISIBLE glass, not the raw
     canvas), and three forced layouts per frame is exactly how a canvas app starts stuttering.
     The measurement cannot change within a frame, so memoize it for the frame; frame() drops it. */
  let insMemo = null;
  const viewInsetsFrame = () => (insMemo || (insMemo = viewInsets()));
  function viewInsets() {
    const out = { l: 0, t: 0, b: 0 };
    if (!cv || !root) return out;
    const c = cv.getBoundingClientRect();
    if (!c.width || !c.height) return out;
    const sx = cv.width / c.width, sy = cv.height / c.height;
    const top = root.querySelector('.refit-top');
    if (top) out.t = Math.max(0, top.getBoundingClientRect().bottom - c.top) * sy;
    const dock = root.querySelector('.refit-dock');
    if (dock) {
      const d = dock.getBoundingClientRect();
      if (d.width < c.width * 0.6) out.l = Math.max(0, d.right - c.left) * sx;  // left sidebar (narrow column)
      else out.b = Math.max(0, c.bottom - d.top) * sy;                          // bottom sheet (spans the width)
    }
    return out;
  }
  function fitCamera() {
    const b = station.bounds(), t = T();
    const wx1 = b.minTx * t, wy1 = b.minTy * t, wx2 = (b.maxTx + 1) * t, wy2 = (b.maxTy + 1) * t;
    const ww = (wx2 - wx1) + 8 * t, wh = (wy2 - wy1) + 8 * t;
    const ins = viewInsets();
    const vw = Math.max(1, cv.width - ins.l), vh = Math.max(1, cv.height - ins.t - ins.b);
    zoom = clamp(Math.min(vw / ww, vh / wh), MINZ, MAXZ);
    panX = ins.l + vw / 2 - (wx1 + wx2) / 2 * zoom;
    panY = ins.t + vh / 2 - (wy1 + wy2) / 2 * zoom;
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
  function visibleBakeRect(g) {
    if (!cv || !g) return null;
    const t = g.TILE || T(), ox = g.origin.tx * t, oy = g.origin.ty * t;
    return {
      x: Math.max(0, (-panX) / zoom - ox),
      y: Math.max(0, (-panY) / zoom - oy),
      w: Math.ceil(cv.width / zoom),
      h: Math.ceil(cv.height / zoom)
    };
  }

  /* ---------- pointer interaction ---------- */
  function panTrigger(ev) { return spaceHeld || ev.button === 1; }  // space-drag or middle-drag

  function onDown(ev) {
    lastClient = { x: ev.clientX, y: ev.clientY };
    hidePropCard();
    // right-button cancels an in-progress edit (and never starts one) — then DROPS the armed tool
    // back to SELECT. The browser context menu is already suppressed on the canvas (contextmenu
    // preventDefault in buildDOM), so right-click is a pure deselect gesture.
    if (ev.button === 2) { if (drag) { releaseDrag(); hideTip(); } if (connectFrom) { connectFrom = null; hideTip(); } if (dupe) { dupe = null; hideTip(); setHint(); } deselectTool(); return; }
    try { cv.setPointerCapture(ev.pointerId); dragPid = ev.pointerId; } catch (e) { dragPid = null; }
    if (panTrigger(ev)) { drag = { mode: 'pan', sx: toCanvas(ev).x, sy: toCanvas(ev).y }; cv.style.cursor = 'grabbing'; return; }
    if (ev.button !== 0) return;
    const w = toWorldTile(ev);
    if (tool === 'select') {
      // SELECT (the default): a click INSPECTS what's under it — machine → its editor/picker/flow
      // card, belt tile → where this lane goes. Empty deck does nothing (space-drag still pans).
      const pid = station.propAt(w.tx, w.ty);
      const p = pid && station.propById(pid);
      if (p) { onInspect(p, ev); return; }
      if (station.beltAt(w.tx, w.ty)) { openBeltCard(w.tx, w.ty, ev); return; }
      // ...and a ROOM opens its own sheet. Clicking the thing you spent build mode MAKING used to
      // be the one dead click in the editor.
      const rid = station.roomAt(w.tx, w.ty);
      if (rid) { openRoomCard(rid, ev); return; }
      return;
    }
    if (tool === 'belt') {
      /* CONNECT MODE — the primary belt interaction (2026-07-05 UX reshape): click one MACHINE, then
         another, and the path lays itself (station.connectBelt — oriented, hooked, junction-aware).
         Clicking empty floor still starts the classic hand-laid drag; a second click on the same
         machine (or any empty click mid-connect) cancels. */
      const pid = station.propAt(w.tx, w.ty);
      const pp = pid && station.propById(pid);
      if (pp && CONNECT_TYPES[pp.t]) {
        if (!connectFrom) { connectFrom = pid; sfx('click'); flashTip(ev, 'FROM ▸ ' + (propSpec(pp.t).label || pp.t).toUpperCase() + ' — now click a destination', true); return; }
        if (connectFrom === pid) { connectFrom = null; hideTip(); return; }
        const res = station.connectBelt(connectFrom, pid);
        connectFrom = null;
        if (res && res.ok) {
          sfx('chime'); flashTip(ev, 'CONNECTED — ' + res.count + ' belts laid themselves', true);
          if (typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced) Tutorial.onBeltPlaced();
        } else { sfx('bad'); flashTip(ev, (res && res.msg) || 'no clear route between those machines', false); }
        return;
      }
      if (connectFrom) { connectFrom = null; flashTip(ev, 'connect cancelled', false); return; }
      drag = { mode: 'beltrun', start: w, cur: w, moved: false };
    } else if (tool === 'prop') {
      drag = { mode: 'propstamp', start: w, cur: w, moved: false };
    } else if (tool === 'dupe') {
      // click-only tool: first click COPIES what's under the cursor, every later click STAMPS a copy.
      // CLICK-ON-MACHINE WINS: with a copy armed, a click ON an existing machine inspects it instead
      // of silently attempting an invalid stamp on top of it.
      if (dupe) {
        const pid = station.propAt(w.tx, w.ty), p = pid && station.propById(pid);
        if (p) { onInspect(p, ev); return; }
        stampDupe(w, ev);
      } else pickupDupe(w, ev);
      return;
    } else if (tool === 'line') {
      // click-only tool: the armed starter line stamps under the cursor (the ghost already showed it).
      // CLICK-ON-MACHINE WINS: a click ON an existing machine inspects it — stamping only on clear deck.
      const pid = station.propAt(w.tx, w.ty), p = pid && station.propById(pid);
      if (p) { onInspect(p, ev); return; }
      stampLine(w, ev);
      return;
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
      drag = { mode: 'reclaim', start: w, cur: w, cells: new Set([w.tx + ',' + w.ty]), moved: false };
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
      if (w.tx !== drag.cur.tx || w.ty !== drag.cur.ty) { drag.moved = true; snapTick(drag.mode); }
      if (drag.mode === 'paint' || drag.mode === 'reclaim') rasterTo(drag, w);   // accumulate every tile the brush crosses
      drag.cur = w;
    } else {
      hoverPropId = station.propAt(w.tx, w.ty);
      hoverRoomId = station.roomAt(w.tx, w.ty);
      hoverTile = { tx: w.tx, ty: w.ty };
      // hovering a placed FUNCTIONAL prop shows its Fallout-style card (what it does + its live assignment)
      const hp = hoverPropId && station.propById(hoverPropId);
      const sp = hp && (typeof PropSprites !== 'undefined') && PropSprites.spec(hp.t);
      if (sp && sp.tier === 'functional') showPropCard(sp, hp, ev.clientX, ev.clientY);
      else hidePropCard();
    }
  }

  function onUp(ev) {
    try { cv.releasePointerCapture(ev.pointerId); } catch (e) {}
    dragPid = null;
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
    if (d.mode === 'reclaim') return commitReclaim(d, ev);
  }
  function onCancel() { if (drag || dragPid != null) { releaseDrag(); hideTip(); setCursor(); } }
  /* ALT-TAB DROPS THE WHOLE GESTURE, not just a pan. This cancelled `pan` only, so tabbing away mid
     draw/belt/paint left a live drag with a frozen ghost pinned to the last tile the pointer touched —
     and the pointer that would have ended it is now somewhere else entirely. A gesture you cannot see
     is a gesture you cannot finish: end it, release the capture, and let the floor go quiet. */
  function onBlur() { spaceHeld = false; if (drag || dragPid != null) { releaseDrag(); hideTip(); } setCursor(); }

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
    // CLICK-ON-MACHINE WINS: a plain click (no drag) on an existing machine inspects it — a 1×1
    // room/hall attempt on top of a prop was never anything but a red flash.
    if (!d.moved) {
      const exist = station.propAt(d.cur.tx, d.cur.ty);
      const ep = exist && station.propById(exist);
      if (ep) { onInspect(ep, ev); return; }
    }
    /* a click stamps the remembered size (what the hover ghost was showing); a drag draws its own.
       Both go through the SAME snapFit the ghost drew — commit what was on screen, never the raw
       gesture, or the snap becomes a lie the instant you press. `rememberDrawn` reads the SNAPPED
       rect too, so a room that grew a tile to meet its neighbour teaches the next click that size. */
    // capture the armed tool BEFORE the success path disarms it — deselectTool resets `tool` to
    // 'select', so reading it again in the feedback line called every hallway a "room placed"
    const isHall = tool === 'hall';
    const rect = !d.moved ? snapFit(stampRectFor(d.cur.tx, d.cur.ty), {})
      : snapFit(isHall ? laneRect(d.start, d.cur) : norm(d.start, d.cur), { resize: true });
    const res = isHall ? station.placeHallway({ rect }) : station.addRoom({ kind, rect });
    if (res && res.ok) {
      pushFlash([rect], false);
      rememberDrawn(rect);
      deselectTool({ silent: true });
    }
    feedback(res, ev, isHall ? 'hallway run' : 'room placed');
  }
  function commitMove(d, ev) {
    // the SAME snapped delta the move ghost drew — commit what was on screen, never the raw drag
    const rm = station.roomById(d.roomId);
    const s = snapMoveDelta(rm, d.cur.tx - d.start.tx, d.cur.ty - d.start.ty);
    if (!s.dx && !s.dy) { hideTip(); return; }
    feedback(station.moveRoom(d.roomId, s.dx, s.dy), ev, 'relocated');
  }
  function propSpec(id) { return (typeof PropSprites !== 'undefined' && PropSprites.spec(id)) || { w: 1, h: 1 }; }
  // open the right editor for a logistics prop that carries config (BAY = agent, FILTER/MERGER = routing, AIRLOCK = seal)
  // a workstation (PC/desk) opens the dedicated WORKSTATION picker; bays/junctions/etc. keep their editors.
  // (Trunk's PC-binding via the BAY picker is unified into the workstation picker — same agentId field, richer UX.)
  // a MERGER has no config (pure topology, like the splitter) — it explains itself via the flow card.
  /* THE INSPECT SEAM (2026-08-05): every "the user clicked a machine to look at it" path lands on
     this ONE dispatch point — select-mode clicks, click-on-machine-wins from armed tools, freshly
     placed configurables, and the openAssign deep link. The follow-up per-dock step editor replaces
     the routing INSIDE this function; callers never fan out on prop type themselves. */
  function onInspect(p, ev) {
    if (!p) return;
    const t = p.t;
    if (WORKSTATION_TYPES[t]) return openWorkstationPicker(p.id, ev);
    if (t === 'bay') return openStepCard(p.id, ev);   // the per-dock STEP EDITOR (step + agent + job brief — one card)
    if (t === 'filter') return openJunctionEditor(p.id, ev);
    if (t === 'airlock') return openDoorPicker(p.id, ev);
    if (t === 'connector_portal') return openConnectorEditor(p.id, ev);
    if (t === 'intake' || t === 'outbox' || t === 'merger' || t === 'splitter') return openFlowCard(p.id);
    // no config surface: answer the click honestly instead of doing nothing
    const sp = propSpec(t);
    flashTip(ev, ((sp.label || t) + '').toUpperCase() + ' — MOVE (4) relocates · DELETE (5) removes', true);
  }
  const openPropEditor = (id, t, ev) => { const p = station && station.propById(id); if (p) onInspect(p, ev); };
  const PROP_EDITABLE = { bay: 1, filter: 1, merger: 1, splitter: 1, airlock: 1, connector_portal: 1, intake: 1, outbox: 1 };   // merger/splitter = flow card only (no config)
  const isEditableProp = t => !!PROP_EDITABLE[t] || !!WORKSTATION_TYPES[t];   // a workstation binds an agent + opens its picker on place/click
  function commitPropStamp(d, ev) {
    // CLICK-ON-MACHINE WINS: a click (no drag) on ANY existing prop inspects it instead of attempting
    // a placement on top of it — placement happens only on clear deck. (The old rule only caught a
    // same-type editable prop, so clicking a bay with a desk armed silently tried an invalid place —
    // the exact "it believes I'm trying to place something" complaint.)
    if (!d.moved) {
      const exist = station.propAt(d.cur.tx, d.cur.ty);
      const ep = exist && station.propById(exist);
      if (ep) { onInspect(ep, ev); return; }
    }
    const s = propSpec(propType);
    let px = d.cur.tx, py = d.cur.ty;
    // JUNCTION SNAP (connect-mode UX): a filter/splitter/merger only works ON a line — if it's dropped
    // NEXT to one, snap it onto the nearest belt tile instead of leaving an inert junction (the exact
    // silent failure of the 2026-07-05 playtest). Dropped ON a belt already? Unchanged.
    if ((propType === 'filter' || propType === 'splitter' || propType === 'merger') && !station.beltAt(px, py)) {
      let snapped = null;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (station.beltAt(px + dx, py + dy)) { snapped = { x: px + dx, y: py + dy }; break; }
      }
      if (snapped) { px = snapped.x; py = snapped.y; flashTip(ev, 'snapped onto the line', true); }
    }
    const placement = { t: propType, x: px, y: py, w: s.w, h: s.h, block: s.blocks !== false };
    if (propType === 'airlock') placement.door = 'closed';   // a fresh airlock seals its room (then click to cycle)
    const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(propType) : null;
    const res = station.addProp(placement);
    if (res && res.ok) {
      pushFlash([{ x1: px, y1: py, x2: px + s.w - 1, y2: py + s.h - 1 }], false);
      // a prop just landed → resolve the quest generators + fold NOW, so a station gap this placement closes
      // celebrates on its own edge (fast back-to-back placements can't coalesce it away on the 1s tick).
      if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }
      if (grant) sfx('chime');   // a capability just came online — a brighter note than the plain placement click
      // first-touch coachmark (tutorial.js): a portal teaches "live tools", any other gear teaches "props are
      // permissions". WORKFLOW props coach even though they're editable (their editor opens too) — otherwise
      // the belt-teach chain coaches never fire at all (editable placements skipped this hook entirely).
      if (typeof Tutorial !== 'undefined') {
        if (propType === 'connector_portal') { if (Tutorial.onConnectorPlaced) Tutorial.onConnectorPlaced(); }
        else if ((!isEditableProp(propType) || CONNECT_TYPES[propType]) && Tutorial.onPropPlaced) Tutorial.onPropPlaced(propType);
      }
      // PLACEMENT FLOW (2026-08-10, Andrew's order): a prop stamp KEEPS the tool and the pick
      // armed — dropping to SELECT here threw the user out of the prop drawer after EVERY
      // placement, so furnishing a room meant a re-pick per prop. Double-stamping on top of the
      // fresh prop can't happen (CLICK-ON-MACHINE WINS inspects it; occupied tiles fail red).
      // ESC / right-click still drops the tool; rooms and blueprints keep their one-shot flow.
      if (isEditableProp(propType) && res.id) { openPropEditor(res.id, propType, ev); return; }   // configure the freshly-placed prop
    }
    feedback(res, ev, grant ? ('EQUIPPED · grants ' + grant) : ('placed ' + propType));
  }
  function commitBeltRun(d, ev) {
    // CLICK-ON-MACHINE WINS: connectable machines were consumed by the connect flow in onDown; a
    // plain click on any OTHER machine (a desk, decor) inspects it instead of a 1-tile invalid run.
    if (!d.moved) {
      const exist = station.propAt(d.cur.tx, d.cur.ty);
      const ep = exist && station.propById(exist);
      if (ep) { onInspect(ep, ev); return; }
    }
    const res = station.placeBeltRun(d.start, d.cur);
    if (res && res.ok && res.count) {
      pushFlash([beltRunBox(d.start, d.cur)], false);
      if (typeof Tutorial !== 'undefined' && Tutorial.onBeltPlaced) Tutorial.onBeltPlaced();   // first-touch coachmark: belts + ▸ TEST
    }
    feedback(res, ev, res && res.dir ? ('belt → ' + res.dir) : 'belt');
  }
  function commitPropMove(d, ev) {
    let dx = d.cur.tx - d.start.tx, dy = d.cur.ty - d.start.ty;
    if (!dx && !dy) { hideTip(); return; }
    // JUNCTION SNAP on MOVE — the same rule placement (commitPropStamp) already applies: a filter/
    // splitter/merger dropped NEXT to a line snaps onto the nearest belt tile. Without this, a moved
    // filter one tile off its belt still compiled (ring-attached) while reading as misplaced — or, two
    // tiles off, went silently inert. If the snapped tile is blocked, fall back to the plain move.
    const mp = station.propById(d.propId);
    let okMsg = 'relocated';
    if (mp && (mp.t === 'filter' || mp.t === 'splitter' || mp.t === 'merger') && !station.beltAt(mp.x + dx, mp.y + dy)) {
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (station.beltAt(mp.x + dx + ox, mp.y + dy + oy) && station.canPlaceProp(mp.t, mp.x + dx + ox, mp.y + dy + oy, mp.w, mp.h, mp.id).ok) {
          dx += ox; dy += oy; okMsg = 'snapped onto the line'; break;
        }
      }
    }
    feedback(station.moveProp(d.propId, dx, dy), ev, okMsg);
  }
  function commitPaint(d, ev) {
    // WALLS are a whole-room surface — there's no per-tile wall, so a drag means the same thing
    // as a click here rather than silently doing nothing.
    if (paintTarget === 'walls') {
      feedback(station.setWalls(d.roomId, { style: wallStyle, mat: wallMat }), ev, 'walls clad');
      return;
    }
    // the SHELL is a whole-room surface too — there is no per-tile exterior
    if (paintTarget === 'hull') {
      feedback(station.setHull(d.roomId, { style: hullStyle, mat: hullMat }), ev, 'shell re-clad');
      return;
    }
    if (d.moved) {
      const tiles = [...d.cells].map(k => { const p = k.split(','); return [+p[0], +p[1]]; });
      feedback(station.paintTiles(d.roomId, tiles, style), ev, 'painted');
    } else {
      // a plain click LAYS THE WHOLE DECK — material and hue together, in one undo slot, so
      // "undo" reverses the deck the Commander just saw laid rather than half of it.
      feedback(station.setDeck(d.roomId, { style, mat }), ev, 'deck laid');
    }
  }
  function commitReclaim(d, ev) {   // DELETE (tool id stays `reclaim`)
    // DRAG across tiles → clear every BELT crossed in ONE undo slot. A drag never removes rooms or
    // props (only single clicks do), so you can wipe a lane without fear of nuking the room under it.
    if (d.moved && d.cells) {
      const tiles = [...d.cells].map(k => { const p = k.split(','); return [+p[0], +p[1]]; }).filter(([x, y]) => station.beltAt(x, y));
      if (!tiles.length) { flashTip(ev, 'drag along a belt to clear it'); sfx('bad'); return; }
      const res = station.removeBelts(tiles);
      if (res && res.ok) { pushFlash(tiles.map(([x, y]) => ({ x1: x, y1: y, x2: x, y2: y })), true); flashUndo(); flashTip(ev, res.count + (res.count === 1 ? ' belt' : ' belts') + ' removed — UNDO to restore', true); sfx('click'); }
      else { flashTip(ev, (res && res.msg) || 'blocked'); sfx('bad'); }
      return;
    }
    const pid = station.propAt(d.cur.tx, d.cur.ty);   // props sit on top — reclaim them first
    if (pid) {
      const p = station.propById(pid);
      const res = station.removeProp(pid);
      if (res && res.ok) { if (p) pushFlash([{ x1: p.x, y1: p.y, x2: p.x + p.w - 1, y2: p.y + p.h - 1 }], true); flashUndo(); flashTip(ev, 'deleted — UNDO to restore', true); sfx('click'); }
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
    doDeleteRoom(id, ev);   // ONE room-removal path, shared with the room card's DELETE
  }
  /* ---------- DUPE tool: copy a room or prop, then stamp repeats — the symmetry workflow.
     Props copy their type/footprint + carried config (filter routes, airlock seal) but NEVER an
     agent/connector binding: two bays on one agent is a routing error (DUP_AGENT) and a portal bind is a
     live server relationship, not geometry. Rooms copy their full multi-rect shape + kind + deck style. */
  function pickupDupe(w, ev) {
    const pid = station.propAt(w.tx, w.ty);
    if (pid) {
      const p = station.propById(pid);
      const s = propSpec(p.t);
      dupe = { type: 'prop', t: p.t, w: p.w || 1, h: p.h || 1, block: s.blocks !== false, cfg: {},
               rects: [{ x1: 0, y1: 0, x2: (p.w || 1) - 1, y2: (p.h || 1) - 1 }], label: (s.label || p.t).toUpperCase() };
      if (p.routes && typeof p.routes === 'object') dupe.cfg.routes = Object.assign({}, p.routes);
      if (p.def) dupe.cfg.def = p.def;
      if (p.door) dupe.cfg.door = p.door;   // (a merger's legacy bufferSize is NOT copied — it configures nothing)
    } else {
      const rid = station.roomAt(w.tx, w.ty);
      const rm = rid && station.roomById(rid);
      if (!rm) { flashTip(ev, 'nothing to copy here — click a room or prop', false); sfx('bad'); return; }
      let mx = Infinity, my = Infinity;
      for (const r of rm.rects) { if (r.x1 < mx) mx = r.x1; if (r.y1 < my) my = r.y1; }
      dupe = { type: 'room', roomKind: rm.kind, floorStyle: rm.floorStyle, label: (rm.name || rm.kind).toUpperCase(),
               rects: rm.rects.map(r => ({ x1: r.x1 - mx, y1: r.y1 - my, x2: r.x2 - mx, y2: r.y2 - my })) };
    }
    sfx('click');
    flashTip(ev, 'COPIED ' + dupe.label + ' — click to stamp · right-click to drop', true);
    setHint('holding ' + dupe.label + ' — click to stamp copies · right-click / Esc to drop');
  }
  function dupeRectsAt(tx, ty) { return dupe.rects.map(r => ({ x1: r.x1 + tx, y1: r.y1 + ty, x2: r.x2 + tx, y2: r.y2 + ty })); }
  function stampDupe(w, ev) {
    if (dupe.type === 'prop') {
      const placement = Object.assign({ t: dupe.t, x: w.tx, y: w.ty, w: dupe.w, h: dupe.h, block: dupe.block }, dupe.cfg);
      const res = station.addProp(placement);
      if (res && res.ok) {
        pushFlash(dupeRectsAt(w.tx, w.ty), false);
        if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }
        const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(dupe.t) : null;
        if (grant) sfx('chime');
        if (typeof Tutorial !== 'undefined' && Tutorial.onPropPlaced) Tutorial.onPropPlaced(dupe.t);
      }
      feedback(res, ev, 'copy placed — click again for another');
    } else {
      const res = station.addRoom({ kind: dupe.roomKind, rects: dupeRectsAt(w.tx, w.ty), floorStyle: dupe.floorStyle });
      if (res && res.ok) pushFlash(dupeRectsAt(w.tx, w.ty), false);
      feedback(res, ev, 'copy placed — click again for another');
    }
  }
  // validate the armed copy at a tile (the ghost's green/red) — same checks a hand placement runs
  function dupeGhost(tx, ty) {
    const rects = dupeRectsAt(tx, ty);
    const v = dupe.type === 'prop'
      ? station.canPlaceProp(dupe.t, tx, ty, dupe.w, dupe.h)
      : (dupe.roomKind === 'corridor' ? station.canPlaceHallway(rects) : station.canPlaceRoom(rects, dupe.roomKind));
    return { rects, v, kind: 'dupe' };
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

  /* ---------- the zoom control (2026-08-07) ----------
     Zoom was wheel-only and said so nowhere but a hint line: a Commander on a trackpad, or one who
     simply never scrolled over the canvas, had no way to find it. – / % / + in the action deck makes
     it a control you can SEE, and the readout doubles as a "you are here" for the camera. Both keep
     the VIEW CENTRE fixed (the wheel anchors on the pointer; a button has no pointer to anchor on,
     and anchoring on the last pointer position would make the floor lurch away from the button). */
  function zoomAboutCentre(next) {
    const ins = viewInsets();
    const cx = ins.l + (cv.width - ins.l) / 2, cy = ins.t + (cv.height - ins.t - ins.b) / 2;
    const wx = (cx - panX) / zoom, wy = (cy - panY) / zoom;
    zoom = clamp(next, MINZ, MAXZ);
    panX = cx - wx * zoom; panY = cy - wy * zoom;
  }
  const zoomStep = dir => zoomAboutCentre(zoom * (dir > 0 ? 1.25 : 1 / 1.25));
  const zoomTo = z => zoomAboutCentre(z);

  /* The action deck's subtitle used to be a fixed sentence repeating what the dock already says.
     It now carries the one thing nothing else on screen does: how big the station you are editing
     actually IS. Every number is counted off the model on the frame it is shown — rooms and deck
     tiles from the room rects, machines from the prop list — so it can never claim a station the
     save doesn't hold (truthful telemetry). */
  let statSig = '', zoomSig = '';
  function updateTopReadout() {
    if (!root) return;
    const zt = Math.round(zoom * 50) + '%';   // 100% = zoom 2, the entering default
    if (zt !== zoomSig) {
      zoomSig = zt;
      const zl = root.querySelector('#refit-zlvl');
      if (zl) zl.textContent = zt;
    }
    /* THE CENSUS ONLY MOVES WITH THE FLOOR. The zoom readout above is per-frame (the camera is not
       geometry), but rooms/rects/props cannot change without a station.onChange — and the scan below
       walks every room AND every rect AND the whole prop list. The old throttle compared the finished
       signature, which skipped the DOM write but paid the full walk on every one of 60 frames a
       second. Gate the WALK on geoVer; the signature check still guards the DOM write. */
    if (statVer === geoVer) return;
    const sub = root.querySelector('#refit-sub');
    if (!sub) return;   // DOM not up yet — do NOT bank the version, or the readout never lands
    statVer = geoVer;
    const list = station.rooms();
    let tiles = 0, halls = 0, rooms = 0;
    for (const rm of list) {
      if (rm.kind === 'corridor') halls++; else rooms++;
      for (const r of rm.rects) tiles += (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1);
    }
    const machines = station.props().length;
    const sig = rooms + '/' + halls + '/' + tiles + '/' + machines;
    if (sig === statSig) return;   // the sub is re-read every frame; only touch the DOM when it moved
    const first = statSig === '';
    statSig = sig;
    const bits = [rooms + (rooms === 1 ? ' ROOM' : ' ROOMS')];
    if (halls) bits.push(halls + (halls === 1 ? ' HALL' : ' HALLS'));
    bits.push(tiles + ' TILES');
    if (machines) bits.push(machines + (machines === 1 ? ' MACHINE' : ' MACHINES'));
    /* THE STATION'S OWN NAME FOR ITS SIZE. A pure LABEL on a number already shown — no gauge, no
       gate, nothing unlocks at a threshold (sandbox law); crossing one is simply the floor earning
       a bigger word, which is the whole point of building. Announced once, when it happens. */
    const tier = tierFor(tiles);
    if (!first && tier !== lastTier) { sfx('milestone'); announceTier(tier); }
    lastTier = tier;
    sub.innerHTML = '<span class="refit-tier">' + esc(tier) + '</span>' + esc(' · ' + bits.join(' · '));
  }
  // deck tiles → the station's size word. Thresholds are round numbers, not tuned: they exist to
  // give a growing floor a few named landmarks, and every one is reachable from minute one.
  const TIER_STEPS = [[3000, 'CITADEL'], [1200, 'COMPLEX'], [400, 'STATION'], [0, 'OUTPOST']];
  const tierFor = tiles => (TIER_STEPS.find(s => tiles >= s[0]) || TIER_STEPS[TIER_STEPS.length - 1])[1];
  let lastTier = '';
  function announceTier(tier) {
    if (!root) return;
    const el = root.querySelector('.refit-tier');
    const el2 = root.querySelector('.refit-title');
    [el, el2].forEach(n => { if (!n) return; n.classList.remove('refit-levelup'); void n.offsetWidth; n.classList.add('refit-levelup'); });
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('Your station is now a ' + tier, 'gold');
  }

  function onKey(ev) {
    const a = ev.target;
    const modal = cardTop();
    // Inputs keep every ordinary editing key, but ESC still belongs to the mounted card so its
    // registered close path can save the field before dismissing it.
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)
      && (!modal || ev.key !== 'Escape')) return;
    /* A MOUNTED CARD OWNS THE KEYBOARD (2026-08-07 conveyor audit). These shortcuts drive the FLOOR, and
       the floor is not what you are looking at while a card is up: with the STEP editor open, `9` armed
       LINES and yanked the camera out from under the card, and Ctrl+Z undid the very stamp that created
       the bay being edited. Only ESC crosses a card — and it closes THAT card (below), never the floor. */
    if (modal && ev.key !== 'Escape') return;
    if (ev.key === ' ') { ev.preventDefault(); spaceHeld = true; setCursor(); return; }
    if (ev.key === 'Escape') {
      // close the TOPMOST card through ITS OWN close path (which saves what that card saves — an unsaved
      // job brief / line name / room rename). markSeen() belongs to the first-run card ALONE, and that
      // card's own registered path is what does it: `.refit-guide` is shared by eight cards, so matching
      // on it here is what used to mark the guide seen from a step editor and throw the brief away.
      if (modal) { cardClose(modal); return; }
      if (drag) { releaseDrag(); hideTip(); setCursor(); return; }       // cancel an in-progress edit first
      if (connectFrom) { connectFrom = null; hideTip(); return; }        // then a half-made connection
      if (dupe) { dupe = null; hideTip(); setHint(); return; }           // then the armed copy
      if (tool !== 'select') { deselectTool(); return; }                 // then the armed tool → SELECT
      return close();                                                    // only a bare select-mode ESC leaves REFIT
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      const r = ev.shiftKey ? station.redo() : station.undo();
      sfx(r.ok ? 'click' : 'bad'); return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); sfx(station.redo().ok ? 'click' : 'bad'); return; }
    if (ev.key === 'f' || ev.key === 'F') { fitCamera(); return; }
    const map = { '0': 'select', '1': 'room', '2': 'hall', '3': 'paint', '4': 'move', '5': 'reclaim', '6': 'prop', '7': 'belt', '8': 'dupe', '9': 'line' };
    if (map[ev.key]) selectTool(map[ev.key]);
  }
  function onKeyUp(ev) { if (ev.key === ' ') { spaceHeld = false; setCursor(); } }

  /* ---------- geometry helpers (world tiles) ---------- */
  function norm(a, b) { return { x1: Math.min(a.tx, b.tx), y1: Math.min(a.ty, b.ty), x2: Math.max(a.tx, b.tx), y2: Math.max(a.ty, b.ty) }; }

  /* ---------- CLICK ALSO PLACES (2026-08-07) ----------
     ROOM and HALLWAY were drag-ONLY, and a plain click was worse than nothing: it committed a 1×1
     footprint, which the model correctly rejects ("room min 3×3", "hallway too short"). So the most
     natural thing to try with a tool armed — point at the floor and click — was guaranteed to fail
     and to teach a size rule by refusing you. Now a click stamps the LAST SIZE YOU DREW (seeded at
     a sensible default), the same size the hover ghost has been previewing under the cursor the
     whole time, so what a click does is visible BEFORE you commit to it. Dragging still does
     exactly what it always did, and every drag re-teaches the click its size.
     The cursor tile is the footprint's TOP-LEFT — identical to where a drag starts from — so the
     ghost never jumps when you switch from clicking to dragging. */
  const DEFAULT_ROOM = { w: 7, h: 5 };   // one screen-legible room; over MIN_ROOM (3) with room to spare
  let stampW = DEFAULT_ROOM.w, stampH = DEFAULT_ROOM.h;   // last ROOM size drawn
  let hallLen = 8, hallVert = false;                      // last HALLWAY run drawn (long axis + orientation)
  const roomStampRect = (tx, ty) => ({ x1: tx, y1: ty, x2: tx + stampW - 1, y2: ty + stampH - 1 });
  const hallStampRect = (tx, ty) => hallVert
    ? { x1: tx, y1: ty, x2: tx + hallWidth - 1, y2: ty + hallLen - 1 }
    : { x1: tx, y1: ty, x2: tx + hallLen - 1, y2: ty + hallWidth - 1 };
  const stampRectFor = (tx, ty) => (tool === 'hall' ? hallStampRect(tx, ty) : roomStampRect(tx, ty));
  // remember what a completed drag drew, so the next click repeats it
  function rememberDrawn(rect) {
    const w = rect.x2 - rect.x1 + 1, h = rect.y2 - rect.y1 + 1;
    if (tool === 'hall') { hallVert = h > w; hallLen = Math.max(w, h); }
    else { stampW = w; stampH = h; }
  }
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

  /* ---------- SNAP FLUSH (2026-08-10) ----------
     Andrew's own station, read out of his save: EIGHT rooms, and not one pair of them touching —
     r5/r6/r7/r8 sit ONE tile off r1, r3 two, r9 three. The seam classifier finds 0 open joins, so
     what reads as "the floors won't blend" is not a blend failure at all: it is eight separate
     hulls, each correctly drawing its own wall and shell across a gap of void. Close the gaps and
     the same seven rooms give 72 open joins and one continuous deck.

     Nothing was stopping him. `checkRects` rejects OVERLAP and nothing else, so a one-tile gap is a
     perfectly legal placement — and at TILE=12 it is a handful of screen pixels, invisible until the
     bake draws two walls where you expected none. The tool let you miss by one and said nothing.

     So the fix is in the GESTURE, not the bake: within SNAP_FIT tiles of an existing footprint, a
     placement lands FLUSH against it. Two behaviours, because the two gestures mean different things:
       · a CLICK stamps a remembered size -> TRANSLATE the rect, never resize it. The size is what
         the user last drew and is not ours to change.
       · a DRAG is sizing -> move the EDGE that is near a neighbour, so the room you are drawing
         grows to meet the one already there.
     A snap is only ever offered when the two footprints actually FACE each other (their spans
     overlap on the other axis) — otherwise a room across the station would tug at a placement it can
     never touch. And every candidate is re-validated through the model's own validator before it is
     accepted, so a snap can never create the overlap the snap exists to avoid.

     The ghost and the commit both call this, which is the same contract the LINES tool already
     holds: what a click commits is exactly what was on screen. */
  const SNAP_FIT = 2;   // tiles. 1 is the miss that started this; 2 forgives a slightly wilder aim
  const spanHit = (a1, a2, b1, b2) => Math.max(a1, b1) <= Math.min(a2, b2);
  function snapFit(rect, opts) {
    const resize = !!(opts && opts.resize), ignoreId = opts && opts.ignoreId;
    const list = (station.rooms && station.rooms()) || [];
    if (!list.length) return rect;
    /* MOVE hands its own validator in. It has to: `tool` is 'move' and `kind` is whatever the ROOM
       palette happens to have selected, so validating a dragged corridor against the armed room kind
       would ask the model an unrelated question and take its answer. A multi-rect room also has to
       be validated as the whole set, not as its bounding box. */
    const legal = (opts && opts.validate) || ((r) => {
      const v = (tool === 'hall') ? station.canPlaceHallway([r], ignoreId) : station.canPlaceRoom([r], kind, ignoreId);
      return !!(v && v.ok);
    });
    if (!legal(rect)) return rect;   // already illegal — snapping would only hide why

    // every flush position this rect could take against a footprint it actually faces
    const cand = [];
    for (const rm of list) {
      if (ignoreId && rm.id === ignoreId) continue;
      for (const o of rm.rects) {
        if (spanHit(rect.y1, rect.y2, o.y1, o.y2)) {
          cand.push({ ax: 'x', edge: 'x1', to: o.x2 + 1 });   // our left edge meets their right
          cand.push({ ax: 'x', edge: 'x2', to: o.x1 - 1 });   // our right edge meets their left
        }
        if (spanHit(rect.x1, rect.x2, o.x1, o.x2)) {
          cand.push({ ax: 'y', edge: 'y1', to: o.y2 + 1 });
          cand.push({ ax: 'y', edge: 'y2', to: o.y1 - 1 });
        }
      }
    }
    if (!cand.length) return rect;

    let out = rect;
    for (const ax of ['x', 'y']) {                       // each axis resolves once, independently
      let best = null;
      for (const c of cand) {
        if (c.ax !== ax) continue;
        const d = c.to - out[c.edge];
        if (d === 0 || Math.abs(d) > SNAP_FIT) continue;
        const next = resize
          ? { ...out, [c.edge]: c.to }                                          // drag: the edge moves
          : (ax === 'x' ? { ...out, x1: out.x1 + d, x2: out.x2 + d }            // click: the whole rect slides
                        : { ...out, y1: out.y1 + d, y2: out.y2 + d });
        // a resize may not collapse the footprint under the model's own minimum
        const w = next.x2 - next.x1 + 1, h = next.y2 - next.y1 + 1;
        const min = (tool === 'room') ? station.MIN_ROOM : 1;
        if (w < min || h < min) continue;
        if (!legal(next)) continue;
        if (!best || Math.abs(d) < best.d) best = { d: Math.abs(d), next };
      }
      if (best) out = best.next;
    }
    return out;
  }

  /* MOVE snaps too — relocating a room next to another is the same gesture with the same one-tile
     miss. The whole footprint translates, so the snap is computed on its bounding box and the
     resulting delta is applied to every rect; an L-shaped room keeps its shape. */
  function snapMoveDelta(rm, dx, dy) {
    if (!rm || !rm.rects || !rm.rects.length) return { dx, dy };
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of rm.rects) { if (r.x1 < x1) x1 = r.x1; if (r.y1 < y1) y1 = r.y1; if (r.x2 > x2) x2 = r.x2; if (r.y2 > y2) y2 = r.y2; }
    const moved = { x1: x1 + dx, y1: y1 + dy, x2: x2 + dx, y2: y2 + dy };
    const shift = (ddx, ddy) => rm.rects.map(r => ({ x1: r.x1 + dx + ddx, y1: r.y1 + dy + ddy, x2: r.x2 + dx + ddx, y2: r.y2 + dy + ddy }));
    const validate = (r) => {
      const rects = shift(r.x1 - moved.x1, r.y1 - moved.y1);
      const v = rm.kind === 'corridor' ? station.canPlaceHallway(rects, rm.id) : station.canPlaceRoom(rects, rm.kind, rm.id);
      return !!(v && v.ok);
    };
    const s = snapFit(moved, { ignoreId: rm.id, validate });
    return { dx: dx + (s.x1 - moved.x1), dy: dy + (s.y1 - moved.y1) };
  }

  function ghostInfo() {
    if (!drag) {
      // DUPE armed: the copy ghosts under the cursor with no drag — every click stamps
      if (tool === 'dupe' && dupe && hoverTile) return dupeGhost(hoverTile.tx, hoverTile.ty);
      // LINES armed: the whole blueprint ghosts under the cursor — click stamps, red stays red
      if (tool === 'line' && hoverTile) return lineGhost(hoverTile.tx, hoverTile.ty);
      // ROOM / HALLWAY armed: the footprint a CLICK would stamp, previewed under the cursor and
      // validated live — so "what happens if I press here" is answered before you press. A drag
      // from the same tile takes over the moment you move (drag.mode 'draw' below).
      if ((tool === 'room' || tool === 'hall') && hoverTile && !station.propAt(hoverTile.tx, hoverTile.ty)) {
        const rect = snapFit(stampRectFor(hoverTile.tx, hoverTile.ty), {});
        const v = tool === 'hall' ? station.canPlaceHallway([rect]) : station.canPlaceRoom([rect], kind);
        return { rects: [rect], v, kind: tool, stamp: true };
      }
      return null;
    }
    if (drag.mode === 'draw') {
      const rect = snapFit((tool === 'hall') ? laneRect(drag.start, drag.cur) : norm(drag.start, drag.cur), { resize: true });
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
      const raw = { dx: drag.cur.tx - drag.start.tx, dy: drag.cur.ty - drag.start.ty };
      const { dx, dy } = snapMoveDelta(rm, raw.dx, raw.dy);
      const rects = rm.rects.map(r => ({ x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy }));
      const v = rm.kind === 'corridor' ? station.canPlaceHallway(rects, rm.id) : station.canPlaceRoom(rects, rm.kind, rm.id);
      return { rects, v, move: true, dx, dy };
    }
    return null;
  }

  /* ---------- render loop ---------- */
  function rebake() {
    cacheGeo = station.projectGeometry();
    const visibleRect = visibleBakeRect(cacheGeo);
    cache = StationBake.bakeIncremental
      ? StationBake.bakeIncremental(cacheGeo, cache, bakeDirtyRects, { visibleRect, maxRetainedChunks: MAX_REFIT_CHUNKS, onlyMissingVisible: bakeVisibleOnly })
      : StationBake.bake(cacheGeo);
    /* recompile the routing plan ONLY when the floor actually changed (planDirty — set by station.onChange
       and open(), the two edit paths; world.js compileRouting is gated the same way via its geoDirty edit
       flag). rebake() ALSO runs on pure pans (frame() flips bakeDirty+bakeVisibleOnly when visible chunks
       are missing), and recompiling plan + liveTiles + the key-rebase on every pan was pure waste: the
       geometry is identical, so the plan (and valLive — origin only moves on edits) is still exact. */
    if (planDirty || !valPlan) {
      valPlan = (typeof Pipeline !== 'undefined') ? Pipeline.compileRoutingPlan(cacheGeo) : null;   // cost-safety: recompute the routing plan on every floor edit
      // dead-vs-live belt render mirrors the live world. The plan is compiled in cacheGeo's LOCAL frame but
      // drawConveyor draws station.belts() in WORLD tiles — rebase the live keys by the geo origin or every
      // REFIT belt would look cold (frame-mismatch, not truth).
      valLive = null;
      if (valPlan && Pipeline.liveTiles) {
        const lv = Pipeline.liveTiles(valPlan), o = (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 };
        valLive = {};
        for (const k in lv) { const p = k.split(','); valLive[(+p[0] + o.tx) + ',' + (+p[1] + o.ty)] = true; }
      }
      planDirty = false;
      maybeFirstRide();   // a floor edit just recompiled the plan — the line may have just powered on
      // finish-the-line: regroup the floor's physical lines from the SAME geometry the plan compiled
      valComps = (typeof Pipeline !== 'undefined' && Pipeline.lineComponents) ? Pipeline.lineComponents(cacheGeo) : [];
      if (lastStampIds) {   // a stamp just landed — the card adopts the stamped line
        const set = {}; for (const id of lastStampIds) set[id] = 1;
        const c = valComps.find(cc => cc.props.some(id => set[id]));
        if (c) finKeySel = c.key;
        lastStampIds = null;
      }
      renderFinCard();
      // ghost projection (Phase 3): same plan, same components, same frame rebase as everything above
      if (ghost) ghost.setContext({ plan: valPlan, comps: valComps, offset: (cacheGeo && cacheGeo.origin) || { tx: 0, ty: 0 } });
    }
    bakeDirty = false; bakeDirtyRects = null; bakeDirtyRectsGlobal = false; bakeVisibleOnly = false;
  }

  // A browser animation callback has no supervisor: if one draw dependency throws, the callback exits before
  // the next requestAnimationFrame at the foot of this function and REFIT remains a black overlay forever.
  // Closing and reopening appeared to "fix" it only because open() started a brand-new loop after the transient
  // startup condition (asset decode/layout/cache warm-up) had passed. Keep the loop host-owned: one bad frame is
  // logged, its derived bake is discarded, and a bounded retry re-measures + re-fits from canonical station state.
  function scheduleFrame(failed) {
    if (!running) return;
    if (!failed) { raf = requestAnimationFrame(frame); return; }
    const delay = Math.min(1000, 80 * Math.pow(2, Math.min(4, Math.max(0, frameFailures - 1))));
    clearTimeout(frameRetryTimer);
    frameRetryTimer = setTimeout(() => {
      frameRetryTimer = 0;
      if (running) raf = requestAnimationFrame(frame);
    }, delay);
  }

  function recoverFrame(err) {
    frameFailures++;
    if (root) {
      root.dataset.renderState = 'recovering';
      root.dataset.renderFailures = String(frameFailures);
    }
    // Capture the short startup sequence with stacks; persistent failures stay bounded by the backoff and then
    // report only every tenth attempt instead of flooding the desktop console at 60fps.
    if (frameFailures <= 5 || frameFailures % 10 === 0) console.error('[refit] render failed; retrying', err);
    cache = null; cacheGeo = null;
    bakeDirty = true; bakeDirtyRects = null; bakeDirtyRectsGlobal = false; bakeVisibleOnly = false; planDirty = true;
    // A first desktop layout pass can change the backing size between open() and the first paint. Re-measure and
    // frame the canonical bounds during recovery so a stale 0/small viewport cannot leave the station offscreen.
    try { resize(); fitCamera(); } catch (_) {}
  }

  /* ---------- ONE BAD LAYER MUST NOT BLANK THE CANVAS ----------
     The frame used to be a single try/catch: any draw dependency that threw skipped EVERY layer
     after it and then had its bake discarded and retried forever, so REFIT read as a black overlay.
     A real case: a refused sidecar (the page's token dies when the sidecar restarts under it) left
     prop data undefined and PropSprites threw out of drawProps — the light layer, the ghost and
     every label after it never ran, on a loop.

     Each layer now paints inside its own guard. A failure costs THAT layer and nothing else; the
     rest of the frame paints. It is reported (one console.warn per layer per session — not
     silenced, and never papered over with fake state) and stamped on the overlay's dataset so a
     harness can read the degradation instead of guessing at a dark screenshot.

     STATE HYGIENE: a layer that throws mid-draw leaves the 2D context wherever it died — an
     unbalanced save(), a stray globalAlpha, a clip. The guard brackets the layer with its own
     save() and unwinds to exactly that depth afterwards, detected with a sentinel miterLimit
     (the 2D API exposes no stack depth). Without the unwind, one throwing layer per frame would
     leak the context state stack forever. */
  const LAYER_MITER = 10, LAYER_SENTINEL = 7.3125;   // an ordinary value nothing in this file sets
  const layerFailed = Object.create(null);
  /* ---------- FRAME COST INSTRUMENT (2026-08-08) ----------
     OFF by default and off in every shipped frame: `perfAcc` is null, so the whole instrument costs
     one null test per layer. A harness turns it on (__test__.perf(true)), lets the loop run, and
     reads back real per-layer totals — a perf claim on this file is otherwise just a story. */
  let perfAcc = null;
  function perfAdd(name, ms) { const a = perfAcc[name] || (perfAcc[name] = { n: 0, ms: 0 }); a.n++; a.ms += ms; }
  function drawLayer(name, fn) {
    const pt0 = perfAcc ? performance.now() : 0;
    ctx.miterLimit = LAYER_MITER;
    ctx.save();
    ctx.miterLimit = LAYER_SENTINEL;   // everything the layer pushes inherits this mark
    try {
      fn();
    } catch (err) {
      if (!layerFailed[name]) {
        layerFailed[name] = 1;
        console.warn('[refit] draw layer "' + name + '" failed — the rest of the frame still paints', err);
      }
      if (root) root.dataset.renderDegraded = Object.keys(layerFailed).join(',');
    }
    // pop back to (and including) our own save, whatever depth the layer left behind
    for (let i = 0; i < 64 && ctx.miterLimit === LAYER_SENTINEL; i++) ctx.restore();
    if (perfAcc) perfAdd(name, performance.now() - pt0);
  }

  function frame(now) {
    if (!running) return;
    let failed = false;
    const fT0 = perfAcc ? performance.now() : 0;
    insMemo = null;   // one layout measurement per frame at most (viewInsetsFrame)
    try {
    const visibleRect = cacheGeo ? visibleBakeRect(cacheGeo) : null;
    if (visibleRect && cache && StationBake.missingVisibleChunks && StationBake.missingVisibleChunks(cache, visibleRect).length) {
      bakeDirty = true; bakeVisibleOnly = true;
    }
    if (bakeDirty || !cache) rebake();
    // an armed first ride waits out the tutorial + the first-run card (.refit-firstrun, never .refit-guide)
    if (ridePending && !tutorialCoaching() && !(root && root.querySelector('.refit-firstrun'))) fireFirstRide();
    // finish-the-line card: slow re-derive (feed truth changes on the world's poll, not on edits) + per-frame pin
    if (finCardEl && now - finPollTs > 2000) { finPollTs = now; renderFinCard(); }
    const hT0 = perfAcc ? performance.now() : 0;
    positionFinCard();
    if (perfAcc) perfAdd('~finCard', performance.now() - hT0);
    const rT0 = perfAcc ? performance.now() : 0;
    updateTopReadout();   // station stats + the live zoom % (both self-throttle on an unchanged value)
    if (perfAcc) perfAdd('~topReadout', performance.now() - rT0);
    const t = T();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // The backdrop, shared with the live world (SpaceBG) so entering/exiting REFIT doesn't jump the sky —
    // same selection, same camera contract (REFIT's zoom is the world's `scale`), so the parallax matches too.
    // A LANDED station has no sky: the ground layer below covers the frame, so skip the starfield entirely.
    if (typeof Terrain !== 'undefined' && Terrain.active()) {
      ctx.fillStyle = Terrain.baseColor(); ctx.fillRect(0, 0, cv.width, cv.height);
    } else if (typeof SpaceBG !== 'undefined') SpaceBG.draw(ctx, cv.width, cv.height, now, { panX, panY, scale: zoom });
    else { ctx.fillStyle = '#040302'; ctx.fillRect(0, 0, cv.width, cv.height); }

    ctx.setTransform(zoom, 0, 0, zoom, panX, panY);
    ctx.imageSmoothingEnabled = false;
    const ox = cache.origin.tx * t, oy = cache.origin.ty * t;
    /* the ground, in world space under the bake — REFIT blits the station at (ox,oy), so the
       clearing must be placed there too, not at the origin like the live world.

       THE CLEARING'S SIZE COMES FROM THE GEOMETRY, NOT FROM THE BAKE CANVAS. `cache.baseCv` only
       exists on the WHOLE-CANVAS bake; when StationBake.bakeIncremental is available the cache is
       CHUNKED and has no baseCv at all, so reading `.width` off it threw a TypeError out of the
       draw function before a single pixel of ground or station was painted — REFIT went black.
       The line below it already knew this (it picks drawBase over drawImage(cache.baseCv) for
       exactly that reason); this call did not. cacheGeo carries COLS/ROWS in tiles on both paths. */
    if (typeof Terrain !== 'undefined' && Terrain.active()) {
      const bt = (cacheGeo && cacheGeo.TILE) || t;
      const bw = cacheGeo ? cacheGeo.COLS * bt : (cache.baseCv ? cache.baseCv.width : 0);
      const bh = cacheGeo ? cacheGeo.ROWS * bt : (cache.baseCv ? cache.baseCv.height : 0);
      Terrain.draw(ctx, { scale: zoom, panX, panY }, cv.width, cv.height,
        { x: ox, y: oy, w: bw, h: bh });
    }
    const drawVisibleRect = visibleBakeRect(cacheGeo);
    if (StationBake.drawBase) StationBake.drawBase(ctx, cache, ox, oy, drawVisibleRect);
    else ctx.drawImage(cache.baseCv, ox, oy);
    voiceBegin();   // one-voice law: every text layer below REGISTERS; the arbiter paints at the end
    drawLayer('grid', () => drawGrid(t));
    drawLayer('conveyor', () => drawConveyor(now, t));   // belts (floor) → props → boxes ride on top
    drawLayer('props', () => drawProps(now));
    drawLayer('boxes', () => drawConveyorBoxes(now, t));
    drawLayer('light', () => {
      if (StationBake.drawLight) StationBake.drawLight(ctx, cache, ox, oy, drawVisibleRect);
      else ctx.drawImage(cache.lightCv, ox, oy);
    });
    drawLayer('glows', () => drawGlows(now));
    drawLayer('flashes', () => drawFlashes(now, t));
    drawLayer('validation', () => drawRoutingValidation(t, now));   // plain-words callouts on any broken piece, IN build mode (cost-safety + guidance)
    drawLayer('beltEndpoints', () => drawBeltEndpointGlow(t, now)); // BELT tool armed → INTAKE glows FROM, BAY/OUTBOX glow TO (what connects to what)
    // the candidate field is an INSTRUMENT — above the light with the crosshair, or the deck swallows it
    drawLayer('lineField', () => drawLineField(t));
    drawLayer('crosshair', () => drawCrosshair(t));   // the aim instrument — ABOVE the light layer, or the deck swallows it
    drawLayer('hover', () => drawHover(t));
    drawLayer('agentTag', () => drawAgentTag(t));   // hovering a PC or BAY names the agent it's bound to (or flags an unassigned PC)
    drawLayer('ghost', () => drawGhost(t, now));
    // every voice has registered — the arbiter now paints AT MOST one label per anchor region.
    // overFloor: the pointer is on the station (or a gesture is live) → the projection stays quiet.
    // guarded too: the registered labels PAINT here, so a throwing caption would otherwise take the frame
    drawLayer('voices', () => voiceFlush(!!drag || !!(hoverRoomId || hoverPropId || (hoverTile && station.beltAt(hoverTile.tx, hoverTile.ty)))));
    // animate the prop-palette preview gallery (~25fps is plenty + cheap). Runs LAST: it hijacks PropSprites'
    // ctx for the offscreen tiles, and the next frame re-points it at the main canvas in drawProps().
    if (tool === 'prop' && propThumbs.length && now - lastThumbTs >= 40) { paintThumbs(now); lastThumbTs = now; }

    frameFailures = 0;
    if (root) {
      root.dataset.renderState = 'ready';
      root.dataset.renderFailures = '0';
    }
    } catch (err) {
      failed = true;
      recoverFrame(err);
    } finally {
      if (perfAcc) perfAdd('=FRAME', performance.now() - fT0);
      scheduleFrame(failed);
    }
  }

  /* ---------- THE BLUEPRINT GRID (2026-08-07 build-mode overhaul) ----------
     The old grid was ONE uniform screen-door at alpha .07 across the whole viewport: the void and
     the deck read identically, nothing said where you could build, and no rhythm let you COUNT
     tiles. It is now three concentric readings of the same lattice:

       DECK   — the real footprint. Per-tile cells, brightest: this is floor that exists.
       APRON  — GRID_APRON tiles of open space around the station bounds. Full minor grid: the
                ground you actually build on next, so a drag has something to snap against.
       VOID   — beyond that, MAJOR divisions only, faint. Open space, with a coarse ruler.

     Majors land every GRID_MAJOR tiles (a "bay") so 8 tiles is countable at a glance, and minor
     lines fade out entirely once a tile is only a few device px (below that they alias into a grey
     wash that reads as fog, not grid). The whole lattice steps UP while a placement tool is armed
     and back DOWN in SELECT — in SELECT you're reading the floor, not aligning to it. */
  const GRID_MAJOR = 8;    // tiles per major division — one "bay" of station
  const GRID_APRON = 16;   // tiles of full-resolution grid around the station bounds
  // tools where alignment matters (the grid + crosshair come up for these; SELECT stays quiet)
  const PLACING = { room: 1, hall: 1, paint: 1, move: 1, reclaim: 1, prop: 1, belt: 1, dupe: 1, line: 1 };

  function drawGrid(t) {
    const x0 = (-panX) / zoom, y0 = (-panY) / zoom, x1 = (cv.width - panX) / zoom, y1 = (cv.height - panY) / zoom;
    const tx0 = Math.floor(x0 / t) - 1, ty0 = Math.floor(y0 / t) - 1, tx1 = Math.ceil(x1 / t) + 1, ty1 = Math.ceil(y1 / t) + 1;
    const armed = !!PLACING[tool];
    const lw = 1 / zoom;
    // minor lines below ~5 device px per tile are noise, not grid — fade them out rather than alias
    const px = t * zoom;
    const minorK = clamp((px - 5) / 7, 0, 1);
    const b = boundsMemoed();   // the apron follows the FLOOR, not the camera — once per edit, not per frame
    const ax0 = b.minTx - GRID_APRON, ay0 = b.minTy - GRID_APRON;
    const ax1 = b.maxTx + 1 + GRID_APRON, ay1 = b.maxTy + 1 + GRID_APRON;

    // ---- MINOR: the apron only. Clipped to the buildable neighbourhood, so the void stays open. ----
    const mx0 = Math.max(tx0, ax0), my0 = Math.max(ty0, ay0), mx1 = Math.min(tx1, ax1), my1 = Math.min(ty1, ay1);
    const hasApron = mx1 > mx0 && my1 > my0;
    if (minorK > 0.02 && hasApron) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(120,200,255,' + (minorK * (armed ? 0.15 : 0.075)).toFixed(3) + ')';
      ctx.beginPath();
      for (let gx = mx0; gx <= mx1; gx++) { ctx.moveTo(gx * t, my0 * t); ctx.lineTo(gx * t, my1 * t); }
      for (let gy = my0; gy <= my1; gy++) { ctx.moveTo(mx0 * t, gy * t); ctx.lineTo(mx1 * t, gy * t); }
      ctx.stroke();
    }

    // ---- MAJOR: every GRID_MAJOR tiles. Faint across the whole view (a horizon ruler), then a
    //      second brighter pass clipped to the apron so the falloff reads as depth, not a hard edge.
    const majX = [], majY = [];
    for (let gx = Math.ceil(tx0 / GRID_MAJOR) * GRID_MAJOR; gx <= tx1; gx += GRID_MAJOR) majX.push(gx);
    for (let gy = Math.ceil(ty0 / GRID_MAJOR) * GRID_MAJOR; gy <= ty1; gy += GRID_MAJOR) majY.push(gy);
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(130,205,255,' + (armed ? 0.10 : 0.06) + ')';
    ctx.beginPath();
    for (const gx of majX) { ctx.moveTo(gx * t, y0); ctx.lineTo(gx * t, y1); }
    for (const gy of majY) { ctx.moveTo(x0, gy * t); ctx.lineTo(x1, gy * t); }
    ctx.stroke();
    if (hasApron) {
      ctx.strokeStyle = 'rgba(160,220,255,' + (armed ? 0.17 : 0.10) + ')';
      ctx.beginPath();
      for (const gx of majX) { if (gx < mx0 || gx > mx1) continue; ctx.moveTo(gx * t, my0 * t); ctx.lineTo(gx * t, my1 * t); }
      for (const gy of majY) { if (gy < my0 || gy > my1) continue; ctx.moveTo(mx0 * t, gy * t); ctx.lineTo(mx1 * t, gy * t); }
      ctx.stroke();
    }

    // ---- DECK: per-tile cells over the real footprint — the brightest reading, floor that exists ----
    if (cacheGeo && (tx1 - tx0) * (ty1 - ty0) < 6000) {
      const ox = cacheGeo.origin.tx, oy = cacheGeo.origin.ty, zg = cacheGeo.zoneGrid, idx = cacheGeo.idx, C = cacheGeo.COLS, R = cacheGeo.ROWS;
      ctx.strokeStyle = 'rgba(140,210,255,' + (minorK * (armed ? 0.20 : 0.13) + 0.03).toFixed(3) + ')';
      ctx.beginPath();
      for (let gy = ty0; gy <= ty1; gy++) for (let gx = tx0; gx <= tx1; gx++) {
        const lx = gx - ox, ly = gy - oy;
        if (lx < 0 || ly < 0 || lx >= C || ly >= R || zg[idx(lx, ly)] == null) continue;
        ctx.rect(gx * t + 0.5 / zoom, gy * t + 0.5 / zoom, t - 1 / zoom, t - 1 / zoom);
      }
      ctx.stroke();
    }
  }

  /* The alignment crosshair: with a build tool armed, the tile under the pointer lights up and its
     row + column rule out across the view. This is the single thing that turns "drag somewhere and
     hope" into "line this up with that" — you can see, before you press, exactly which column your
     next room will start on and what it lines up with across the floor. Muted during a drag: the
     ghost's own rulers take over there (drawGhost), and two sets of guides is a clusterfuck.

     Drawn in the OVERLAY pass, not inside drawGrid. The grid is painted before StationBake.drawLight,
     which is right for a lattice that should read as part of the floor and wrong for an instrument:
     the light canvas multiplied a .22 rule down to nothing over the very deck you aim at, so the
     crosshair was invisible in exactly the place it exists to serve. */
  function drawCrosshair(t) {
    if (!PLACING[tool] || drag || !hoverTile) return;
    const x0 = (-panX) / zoom, y0 = (-panY) / zoom, x1 = (cv.width - panX) / zoom, y1 = (cv.height - panY) / zoom;
    const hx = hoverTile.tx, hy = hoverTile.ty;
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = 'rgba(150,225,255,0.34)';
    ctx.beginPath();
    ctx.moveTo(hx * t + 0.5 / zoom, y0); ctx.lineTo(hx * t + 0.5 / zoom, y1);
    ctx.moveTo((hx + 1) * t - 0.5 / zoom, y0); ctx.lineTo((hx + 1) * t - 0.5 / zoom, y1);
    ctx.moveTo(x0, hy * t + 0.5 / zoom); ctx.lineTo(x1, hy * t + 0.5 / zoom);
    ctx.moveTo(x0, (hy + 1) * t - 0.5 / zoom); ctx.lineTo(x1, (hy + 1) * t - 0.5 / zoom);
    ctx.stroke();
    ctx.fillStyle = 'rgba(150,225,255,0.16)';
    ctx.fillRect(hx * t, hy * t, t, t);
    // corner ticks on the aimed tile — the "you are here" the flat fill alone doesn't carry
    const k = Math.min(t * 0.34, 5 / zoom);
    ctx.strokeStyle = 'rgba(190,240,255,0.85)'; ctx.lineWidth = 1.4 / zoom;
    const X = hx * t, Y = hy * t;
    ctx.beginPath();
    ctx.moveTo(X, Y + k); ctx.lineTo(X, Y); ctx.lineTo(X + k, Y);
    ctx.moveTo(X + t - k, Y); ctx.lineTo(X + t, Y); ctx.lineTo(X + t, Y + k);
    ctx.moveTo(X + t, Y + t - k); ctx.lineTo(X + t, Y + t); ctx.lineTo(X + t - k, Y + t);
    ctx.moveTo(X + k, Y + t); ctx.lineTo(X, Y + t); ctx.lineTo(X, Y + t - k);
    ctx.stroke();
  }

  function drawGlows(now) {
    if (!cache.flickers) return;
    const t = T(), ox = cache.origin.tx * t, oy = cache.origin.ty * t;
    ctx.globalCompositeOperation = 'lighter';
    for (const f of cache.flickers) {
      const a = Math.max(0, 0.08 * (0.55 + 0.45 * Math.sin(now / 210 + f.x) * Math.sin(now / 83 + f.y)));
      const g = ctx.createRadialGradient(ox + f.x, oy + f.y, 1, ox + f.x, oy + f.y, f.r * 0.7);
      g.addColorStop(0, 'rgba(238,218,184,' + a + ')'); g.addColorStop(1, 'rgba(238,218,184,0)');
      ctx.fillStyle = g; ctx.fillRect(ox + f.x - f.r * 0.7, oy + f.y - f.r * 0.7, f.r * 1.4, f.r * 1.4);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---------- PLACEMENT JUICE (2026-08-07 round 3) ----------
     A placement used to answer with a flat colour wash that faded in half a second — the same mark
     for building a room and for tearing one down, and nothing that felt like the station DID
     something. It now reads as fabrication: a phosphor SCAN sweeps the footprint (left→right as
     structure materializes, right→left as it is stripped), a RING pushes out past the edge and
     fades, and the body glow decays under both. Eerie, not cute — it is the same construction
     vocabulary the bake and the CRT already speak, no particles and no confetti. */
  const FLASH_MS = 620;
  function drawFlashes(now, t) {
    for (let i = flashes.length - 1; i >= 0; i--) {
      const fl = flashes[i], k = (now - fl.t0) / FLASH_MS;
      if (k >= 1) { flashes.splice(i, 1); continue; }
      const ease = 1 - (1 - k) * (1 - k);         // fast out — the sweep leads, the glow trails
      const body = (1 - k) * (fl.bad ? 0.34 : 0.30);
      const hue = fl.bad ? '255,110,90' : '170,255,210';
      for (const r of fl.rects) {
        const X = r.x1 * t, Y = r.y1 * t, W = (r.x2 - r.x1 + 1) * t, H = (r.y2 - r.y1 + 1) * t;
        ctx.fillStyle = 'rgba(' + hue + ',' + body.toFixed(3) + ')';
        ctx.fillRect(X, Y, W, H);
        // THE SCAN — a bright band crossing the footprint once
        const band = Math.max(t * 0.9, W * 0.14);
        const head = fl.bad ? (X + W - ease * (W + band)) : (X - band + ease * (W + band));
        const bx0 = Math.max(X, head), bx1 = Math.min(X + W, head + band);
        if (bx1 > bx0) {
          const g = ctx.createLinearGradient(head, 0, head + band, 0);
          const peak = (0.55 * (1 - k * 0.5)).toFixed(3);
          g.addColorStop(0, 'rgba(' + hue + ',0)');
          g.addColorStop(0.5, 'rgba(' + hue + ',' + peak + ')');
          g.addColorStop(1, 'rgba(' + hue + ',0)');
          ctx.fillStyle = g; ctx.fillRect(bx0, Y, bx1 - bx0, H);
        }
        // THE RING — the footprint's own outline pushing outward as it settles
        const grow = ease * t * 0.9, ra = (1 - ease) * 0.85;
        if (ra > 0.02) {
          ctx.lineWidth = 2 / zoom;
          ctx.strokeStyle = 'rgba(' + hue + ',' + ra.toFixed(3) + ')';
          ctx.strokeRect(X - grow, Y - grow, W + grow * 2, H + grow * 2);
        }
      }
    }
  }

  /* THE SNAP TICK. Sizing a footprint is the core gesture of build mode and it was silent: the
     ghost changed by a tile and nothing marked it, so a drag felt like moving a rectangle instead
     of laying out a room. Every tile the gesture snaps through now ticks. Rate-limited, because a
     fast drag crosses tiles faster than a cue can decay, and restricted to gestures where the SNAP
     is the point — the paint and delete brushes raster whole runs of tiles per frame and would
     machine-gun it. */
  let lastTick = 0;
  const SNAP_GESTURES = { draw: 1, beltrun: 1, move: 1, propmove: 1, propstamp: 1 };
  function snapTick(mode) {
    if (!SNAP_GESTURES[mode]) return;
    const n = performance.now();
    if (n - lastTick < 55) return;
    lastTick = n;
    sfx('tick');
  }

  // placeable props — drawn in WORLD tile coords (camera maps world*t, the bake is origin-shifted
  // to match). Lit (work=true) so the editor previews screens alive; y-sorted for clean overlap.
  function drawProps(now) {
    if (typeof PropSprites === 'undefined') return;
    const list = station.props();
    if (!list.length) return;
    PropSprites.setCtx(ctx); PropSprites.setNow(now);
    // MOUNT LIFT — resolved per frame through station.mountOf, the SAME seam world.js draws through.
    // REFIT is where props are actually placed, so a table-top prop that only lifted in the live world
    // looked, in the one view you judge it from, like it had been dropped INSIDE the table.
    // The +0.5 goes with it: a mounted prop and its table cover the same tiles, so their sort keys tie
    // and raw array order (whichever was placed first) would decide who draws on top.
    // …resolved ONCE PER EDIT, not per frame: mountOf is O(props) inside the model (a propById find
    // plus a surface-host scan), so asking it for every prop every frame was O(props²) at 60fps —
    // and the map+sort it fed allocated two arrays a frame for an order that cannot change without a
    // station.onChange. The wrapper object for a MOUNTED prop is still built per frame (as before),
    // so PropSprites keeps reading the live prop, never a snapshot of it.
    /* VIEWPORT CULL. Measured 2026-08-08: on a 337-prop floor the props layer was 28.8ms of a 32ms
       frame — PropSprites renders every prop procedurally, every frame, with no offscreen cache. A
       prop entirely off the glass paints nothing, so the frame owes it nothing; culling changes what
       is DRAWN by zero pixels. The pad is deliberately generous (prop art anchors to its footprint
       bottom and rises well above it — crowns, halos, the mount lift), so nothing can clip in at the
       top edge as you pan. Zoomed all the way out to the whole station nothing is culled and the
       cost is unchanged — which is the honest worst case, and exactly what the bench reports. */
    const order = propDrawOrder(list);
    const tp = T(), zt = zoom * tp;
    const vx0 = (-panX) / zt - PROP_CULL_PAD, vy0 = (-panY) / zt - PROP_CULL_PAD;
    const vx1 = (cv.width - panX) / zt + PROP_CULL_PAD, vy1 = (cv.height - panY) / zt + PROP_CULL_PAD;
    let bayNames = null;   // aid -> name, resolved once per paint (the roster read is a callback into app.js)
    for (const p of order) {
      if (p.x > vx1 || p.y > vy1 || p.x + (p.w || 1) - 1 < vx0 || p.y + (p.h || 1) - 1 < vy0) continue;
      const m = mountMap.get(p.id);
      let dp = m ? Object.assign({}, p, { mount: m }) : p;
      // the editor draws the same gantry plate the live world does: a bound bay wears its agent's NAME
      if (p.t === 'bay' && p.agentId) {
        if (!bayNames) { bayNames = new Map(); for (const a of ((opts && typeof opts.agents === 'function' && opts.agents()) || [])) bayNames.set(a.id, a.name); }
        const nm = bayNames.get(p.agentId);
        if (nm) dp = Object.assign(dp === p ? Object.assign({}, p) : dp, { dockName: nm });
      }
      PropSprites.draw(dp, true);
    }
  }
  /* 4 tiles = 48px at TILE 12. The worst upward overshoot in the whole prop catalog is 21px above a
     prop's footprint top (masts/crowns; measured over propsprites.js), and SURFACE_RISE adds a few
     more — so the pad is better than double the art that can ever hang outside a footprint. */
  const PROP_CULL_PAD = 4;
  function propDrawOrder(list) {
    if (mountVer === geoVer && mountOrder) return mountOrder;
    mountVer = geoVer;
    const mounts = new Map();
    for (const p of list) {
      let m = null;
      try { m = station.mountOf ? station.mountOf(p) : null; } catch (_) { m = null; }
      if (m) mounts.set(p.id, m);
    }
    // MOUNT LIFT sort key, unchanged: a mounted prop and its table cover the same tiles, so their
    // keys would tie and raw array order would decide who draws on top. `p.mount` is still consulted
    // for the unmounted branch exactly as the old map+sort did.
    const key = p => (p.y + (p.h || 1)) + ((mounts.get(p.id) || p.mount) ? 0.5 : 0);
    const arr = list.slice().sort((a, b) => key(a) - key(b));   // stable, and never touches doc.props
    mountMap = mounts;
    return (mountOrder = arr);
  }

  // conveyor — belts (floor machinery) + the live transport sim. WORLD coords like drawProps.
  function drawConveyor(now, t) {
    if (!convey) return;
    const belts = beltsMemoed();   // one array per EDIT, shared read-only by tick / ghost.tick / drawBelts
    const dt = lastFrameTs ? (now - lastFrameTs) : 16; lastFrameTs = now;
    // route the preview boxes through the SAME junctions the compiled plan uses, so a TEST box sorts exactly as
    // real work will (build-time "does my routing work?" loop). null until a junction exists -> boxes go straight.
    // Junction keys are LOCAL-frame (valPlan compiles from cacheGeo) — REBASE them to the WORLD tiles the
    // preview belts use, or junctions silently never trigger off-origin (the frame-drift bug class).
    /* The rebase + junctionLaneOwners() ran EVERY FRAME even though both inputs — the compiled plan
       and the bake origin — only move on a recompile. Memoize on exactly those two: valPlan is
       replaced (never mutated) by rebake()'s compile, so object identity is the honest key. */
    let jmap = null;
    if (valPlan && valPlan.junctions && cacheGeo) {
      const o = cacheGeo.origin || { tx: 0, ty: 0 };
      if (jmapPlan === valPlan && jmapOx === o.tx && jmapOy === o.ty) {
        jmap = jmapMemo;
      } else {
        const owners = (typeof Pipeline !== 'undefined' && Pipeline.junctionLaneOwners) ? Pipeline.junctionLaneOwners(valPlan) : {};
        for (const k in valPlan.junctions) {
          const p = k.split(','), wk = (+p[0] + o.tx) + ',' + (+p[1] + o.ty);
          (jmap = jmap || new Map()).set(wk, owners[k] ? Object.assign({}, valPlan.junctions[k], { owners: owners[k] }) : valPlan.junctions[k]);
        }
        jmapPlan = valPlan; jmapOx = o.tx; jmapOy = o.ty; jmapMemo = jmap;
      }
    }
    convey.tick(dt, now, belts, jmap, testStops());   // stops: preview crates are consumed at their dock, like real ones
    /* GHOST PROJECTION (Phase 3): stands down while anything coach-like is up (tutorial, the
       first-run card, an ARMED/pending first ride — the two narrations must never fight) and the
       INSTANT any real preview crate rides (▸ TEST / the first ride own the belt). Same belts,
       same junction decisions, same frame as the real sim; its own dedicated engine + stops. */
    if (ghost) {
      const blocked = tutorialCoaching() || ridePending || !!rideTimer
        || !!(root && root.querySelector('.refit-firstrun')) || convey.boxCount() > 0;
      const feed = (opts && opts.world && opts.world.feedState) ? opts.world.feedState() : { known: false, fed: false };
      ghost.tick(dt, now, belts, jmap, { blocked, feed });
    }
    convey.drawBelts(ctx, now, t, belts, valLive);
  }
  function drawConveyorBoxes(now, t) {
    if (!convey) return;
    convey.drawBoxes(ctx, now, t); drawTestNotes(now, t);
    // projection + WOULD-captions over the real layer — captions go THROUGH the arbiter
    // (ghostCaption layer: mutes whenever any other voice speaks or the pointer rides the floor)
    if (ghost) ghost.draw(ctx, now, t, Math.max(9, 11 / zoom), (box, paint) => voiceSay('ghostCaption', box, box, paint));
  }

  /* THE GUIDANCE LIVES WHERE THE HANDS ARE (2026-07-05 playtest): callouts render INSIDE build mode, in
     plain words that name the fix, at a size you can read while placing — the same visual language as the
     live world's nags (corner brackets + VT323 phosphor), not the old 7px whisper. All plan-derived
     coordinates are LOCAL-frame (valPlan compiles from cacheGeo) and are REBASED by cacheGeo.origin here,
     which kills the frame-drift bug that misplaced ghosts on off-origin floors.
     Red = blocking (loop / no default lane / dup agent / dry intake); amber = fixable advice. */
  /* ---------- THE ONE-VOICE LABEL ARBITER (2026-08-05 interaction reshape) ----------
     Every floating-text layer on the REFIT canvas REGISTERS its labels here instead of painting
     directly; the arbiter draws once per frame, after every producer has spoken. The law it
     enforces (Andrew's "clusterfuck of text" verdict): AT MOST one label per anchor region, and a
     lower layer is muted entirely wherever a higher one is live nearby (collision = overlapping
     label rects OR overlapping anchors).
       priority: activeFlow (connect gesture / test-ride captions)
               > hover (the machine under the pointer)
               > topNag (validation callouts — real problems)
               > ghostCaption (the projection's WOULD-voice)
               > rolePlacard (an unbound role dock introducing itself)
     Ghost captions additionally mute while ANY other layer speaks anywhere, or while the pointer
     is over the floor (the user is looking at machines, not the projection).
     All rects are WORLD px (the frame's zoom/pan transform is live at flush time). */
  const LAYER_PRI = { activeFlow: 5, hover: 4, topNag: 3, ghostCaption: 2, rolePlacard: 1 };
  const voiceReqs = [];
  function voiceBegin() { voiceReqs.length = 0; }
  // anchor = the machine/tile the label speaks about; box = the label's own rect; draw paints it
  function voiceSay(layer, anchor, box, draw) { voiceReqs.push({ layer, pri: LAYER_PRI[layer] || 0, anchor, box, draw }); }
  const voiceHit = (a, b, pad) => !!(a && b) && a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;
  function voiceFlush(overFloor) {
    if (!voiceReqs.length) return;
    const othersSpeak = voiceReqs.some(r => r.layer !== 'ghostCaption');
    const pad = 4 / zoom;   // world-px breathing room between voices
    const live = voiceReqs.filter(r => r.layer !== 'ghostCaption' || (!othersSpeak && !overFloor));
    live.sort((a, b) => b.pri - a.pri);   // stable: within a layer, registration order holds
    const placed = [];
    for (const r of live) {
      if (placed.some(p => voiceHit(r.box, p.box, pad) || voiceHit(r.anchor, p.anchor, 0))) continue;
      placed.push(r);
      if (r.draw) r.draw(ctx);
    }
  }

  const VAL_FONT = () => Math.max(9, 11 / zoom) + "px 'VT323','Courier New',monospace";
  /* LABEL COLLISION (2026-07-11): callouts are laid out, not just painted — neighboring findings on one
     row (or two findings on the SAME prop) used to print on a shared baseline and mash into garble
     ("NO COMPUT|NOT ADD THPC..."). Each label claims a box; a collider steps AWAY from the prop (up for
     above-labels, down for below-labels) one line at a time until it fits. Cleared per frame. */
  function placeLabel(placed, cx, y, w, h, dir) {
    const hits = b => cx - w / 2 < b.x + b.w && cx + w / 2 > b.x && y < b.y + b.h && y + h > b.y;
    let guard = 24;
    while (guard-- > 0 && placed.some(hits)) y += dir * (h + 1);
    placed.push({ x: cx - w / 2, y, w, h });
    return y;
  }
  // the role placard for an UNBOUND role-carrying dock: "RESEARCHER — DIGS SOURCES… — CLICK".
  // One string builder shared by REFIT's validation callout and the live world's nag (world.js
  // mirrors it through the same WorldModel.bayRoleInfo source so the two never drift).
  function roleLabelFor(p) {
    if (!p || !p.role || p.agentId) return null;
    const ri = (typeof WorldModel !== 'undefined' && WorldModel.bayRoleInfo) ? WorldModel.bayRoleInfo(p.role) : null;
    return ri ? p.role + ' — ' + ri.desc.toUpperCase() + ' — CLICK' : null;
  }
  function drawRoutingValidation(t, now) {
    if (!cacheGeo) return;
    const o = cacheGeo.origin || { tx: 0, ty: 0 };
    const pulse = 0.55 + 0.35 * Math.sin(now / 280);
    const placed = [];
    // the checklist's focused next step: its dock may speak its role placard even unhovered
    const focusDock = (finCardEl && finComp) ? (finState(finComp).unbound[0] || null) : null;
    const focusDockId = focusDock ? focusDock.propId : null;
    /* brackets always paint (a bracket is machinery marking, not text); the LABEL registers with
       the arbiter — one voice per anchor, higher layers mute this one nearby. */
    const mark = (rect, col, label, layer) => {
      // rect arrives in LOCAL tiles → draw in WORLD px (bake + props frame)
      const X = (rect.x1 + o.tx) * t, Y = (rect.y1 + o.ty) * t;
      const Wd = (rect.x2 - rect.x1 + 1) * t, Hd = (rect.y2 - rect.y1 + 1) * t;
      const L = Math.max(3, Math.floor(t / 3));
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = col; ctx.lineWidth = 1.5 / zoom;
      ctx.beginPath();   // corner brackets — a machinery callout, not a selection box
      ctx.moveTo(X + .5, Y + .5 + L); ctx.lineTo(X + .5, Y + .5); ctx.lineTo(X + .5 + L, Y + .5);
      ctx.moveTo(X + Wd - .5 - L, Y + .5); ctx.lineTo(X + Wd - .5, Y + .5); ctx.lineTo(X + Wd - .5, Y + .5 + L);
      ctx.moveTo(X + .5, Y + Hd - .5 - L); ctx.lineTo(X + .5, Y + Hd - .5); ctx.lineTo(X + .5 + L, Y + Hd - .5);
      ctx.moveTo(X + Wd - .5, Y + Hd - .5 - L); ctx.lineTo(X + Wd - .5, Y + Hd - .5); ctx.lineTo(X + Wd - .5 - L, Y + Hd - .5);
      ctx.stroke();
      ctx.restore();
      if (!label) return;
      // measure + collision-step NOW (final boxes), paint at flush if the arbiter grants the voice
      ctx.save();
      ctx.font = VAL_FONT();
      const tw = ctx.measureText(label).width;
      ctx.restore();
      // baseline-bottom label: its box spans [y-lh, y] — colliders step UP (dir -1), away from the machinery
      const lh = Math.max(9, 11 / zoom) + 2 / zoom;
      const ly = placeLabel(placed, X + Wd / 2, Y - 2 / zoom - lh, tw, lh, -1);
      voiceSay(layer || 'topNag', { x: X, y: Y, w: Wd, h: Hd }, { x: X + Wd / 2 - tw / 2, y: ly, w: tw, h: lh }, (c) => {
        c.save();
        c.globalAlpha = pulse;
        c.font = VAL_FONT(); c.textAlign = 'center'; c.textBaseline = 'bottom';
        c.shadowBlur = 3; c.shadowColor = col; c.fillStyle = col;
        c.fillText(label, X + Wd / 2, ly + lh);
        c.restore();
      });
    };
    // routing findings from the compiled plan — every label names the FIX (see VAL_LABEL)
    if (valPlan && valPlan.errors && valPlan.errors.length) {
      const propById = {};
      for (const p of (cacheGeo.props || [])) propById[p.id] = p;
      for (const e of valPlan.errors) {
        let rect = null;
        if (e.tile) rect = { x1: e.tile.x, y1: e.tile.y, x2: e.tile.x, y2: e.tile.y };
        else if (e.propId && propById[e.propId]) { const p = propById[e.propId]; rect = { x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }; }
        if (!rect) continue;
        let label = VAL_LABEL[e.code] || e.code, layer = 'topNag';
        /* a ROLE-carrying unbound dock is a PLACARD, not a permanent nag (one-voice law): it speaks
           only while hovered or while it is the checklist's focused next step — at rest the amber
           bracket + the FINISH-THE-LINE card already carry the story. Roleless unbound bays keep
           the short topNag (there is no card walking the user to them). */
        if (e.code === 'UNBOUND_BAY' && e.propId) {
          const rl = roleLabelFor(propById[e.propId]);
          if (rl) {
            layer = 'rolePlacard';
            label = (hoverPropId === e.propId || focusDockId === e.propId) ? rl : null;
          }
        }
        mark(rect, e.warn ? '#ffbe3c' : '#ff5046', label, layer);   // amber warn vs red blocker
      }
    }
    // B5 cost-safety: a BOUND bay whose room has no dedicated PC can't run routed work — the compute gate
    // stays shut. Surface it (amber) so the Commander equips the bay while still IN build mode.
    if (typeof station.bayObjects === 'function') {
      for (const p of (cacheGeo.props || [])) {
        if (p.t !== 'bay' || !p.agentId) continue;
        // memoized per (agentId, geoVer) and guarded — see bayObjectsMemoed. This ran BARE, per bay,
        // per frame, and each call is O(props × rooms) inside the model.
        if (bayObjectsMemoed(p.agentId).indexOf('computer') >= 0) continue;
        mark({ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }, '#ffbe3c', 'NO COMPUTE — ADD A PC IN THIS ROOM');
      }
    }
    // a CONNECTOR PORTAL with no bound server grants nothing — surface it (amber) so the Commander binds one.
    for (const p of (cacheGeo.props || [])) {
      if (p.t !== 'connector_portal') continue;
      const live = station.propById(p.id);
      if (live && live.connectorId) continue;
      mark({ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }, '#ffbe3c', 'NO SERVER — CLICK TO BIND');
    }
  }
  /* BELT-TOOL ENDPOINT GLOW: while the BELT tool is armed, the legal endpoints announce themselves —
     INTAKE pulses green "FROM", bound BAYs and OUTBOX pulse cyan "TO" — so "what do I connect to what"
     is answered by the floor itself before the first tile is laid. Desks never glow: belts don't run to
     workstations (the agent carries work the last leg). */
  function drawBeltEndpointGlow(t, now) {
    if (tool !== 'belt' || !station) return;
    const pulse = 0.45 + 0.3 * Math.sin(now / 260);
    const placed = [];
    ctx.save();
    ctx.font = VAL_FONT();
    for (const p of station.props()) {
      if (!CONNECT_TYPES[p.t]) continue;
      const isFrom = connectFrom && p.id === connectFrom;
      // mid-connect the story flips: the armed machine burns gold, every other machine reads as a target
      const col = isFrom ? '#ffd94a' : connectFrom ? '#7ee2a8' : p.t === 'intake' ? '#3fd08a' : '#5ad0ff';
      const X = p.x * t, Y = p.y * t, Wd = (p.w || 1) * t, Hd = (p.h || 1) * t;
      ctx.globalAlpha = isFrom ? 0.95 : pulse;
      ctx.strokeStyle = col; ctx.lineWidth = (isFrom ? 2.5 : 1.5) / zoom;
      ctx.strokeRect(X - 1, Y - 1, Wd + 2, Hd + 2);
      /* ONE-VOICE LAW: the FROM/TO text exists ONLY while the connect flow is mid-gesture
         (connectFrom armed). At rest the pulsing outlines alone say "these are the endpoints" —
         nine simultaneous CLICK TO CONNECT / JUNCTION captions were the loudest single layer in
         Andrew's text-soup screenshot. Mid-gesture labels ride the activeFlow layer (top priority). */
      if (!connectFrom) continue;
      const role = isFrom ? 'FROM ▸ NOW CLICK A DESTINATION' : 'CLICK TO CONNECT';
      const tw = ctx.measureText(role).width;
      // baseline-top label below the prop: colliders step DOWN (dir +1), away from the machinery
      const lh = Math.max(9, 11 / zoom) + 2 / zoom;
      const ly = placeLabel(placed, X + Wd / 2, Y + Hd + 2 / zoom, tw, lh, 1);
      voiceSay('activeFlow', { x: X, y: Y, w: Wd, h: Hd }, { x: X + Wd / 2 - tw / 2, y: ly, w: tw, h: lh }, (c) => {
        c.save();
        c.font = VAL_FONT(); c.textAlign = 'center'; c.textBaseline = 'top';
        c.globalAlpha = isFrom ? 0.95 : pulse;
        c.shadowBlur = 3; c.shadowColor = col; c.fillStyle = col;
        c.fillText(role, X + Wd / 2, ly);
        c.restore();
      });
    }
    ctx.restore();
  }

  // hovering an agent-bound endpoint (a PC = compute, a BAY = routing) floats the bound agent's name above it —
  // so a SHARED room (several agents, several PCs) stays legible without one-room-per-agent. An unbound PC reads
  // amber "unassigned" to invite binding. (Belts/conveyors gain the same tag in Phase 2b once they carry agentId.)
  function drawAgentTag(t) {
    if (drag || !hoverPropId) return;
    const p = station.propById(hoverPropId);
    if (!p) return;
    const anchor = { x: p.x * t, y: p.y * t, w: (p.w || 1) * t, h: (p.h || 1) * t };
    /* ONE-VOICE LAW: while the DOM prop card (the Fallout-style hover panel) is up for THIS prop,
       it IS the hover voice — the canvas tag would be a second caption on the same machine. Still
       CLAIM the hover slot (an empty draw) so lower layers (nags, placards, ghost) mute near the
       machine the user is actually looking at. The chain line the tag used to add is folded into
       the card itself (propCardHTML) so no information is lost. */
    const cardUp = propCard && propCard.style.display === 'block' && propCardKey && propCardKey.indexOf('p:' + p.id + ':') === 0;
    if (cardUp) { voiceSay('hover', anchor, anchor, null); return; }
    const isPc = isPcProp(p.t), isBay = p.t === 'bay', isIntake = p.t === 'intake';
    if (!isPc && !isBay && !isIntake) return;
    // a NAMED line's INBOX glances its line name (line naming — registered through the arbiter like every
    // other hover voice; an unnamed intake keeps its pre-existing silence, no new resting text).
    if (isIntake && !p.label) return;
    const bound = isIntake ? true : !!p.agentId;
    // a role-carrying dock's glance names the role it wants while unbound ("BAY · needs a RESEARCHER")
    const ri = (!bound && p.role && typeof WorldModel !== 'undefined' && WorldModel.bayRoleInfo) ? WorldModel.bayRoleInfo(p.role) : null;
    const txt = isIntake ? ('LINE · ' + String(p.label))
      : (isPc ? 'PC · ' : 'BAY · ') + (bound ? String(p.agentId).replace(/^tg_/, '') : (ri ? 'needs a ' + p.role + ' — ' + ri.desc : 'unassigned'));
    // dock→dock affordance: a BOUND bay's glance also says where its OUTPUT goes — read from the compiled
    // plan's chain record (valPlan.chains — the same fact the sidecar routes by), so the tag can never
    // claim a handoff dispatch wouldn't perform. Same tag chrome, stacked one line above; still a glance,
    // never a window. A beltless dock has no chain record and gains no line.
    let t2 = null, ch = null;
    if (isBay && bound && valPlan && valPlan.chains) {
      ch = valPlan.chains[p.agentId];
      t2 = !ch ? null
        : (ch.next && ch.next.length) ? '▸ HANDS OFF TO ' + ch.next.map(agentLabelFor).join(' + ')
        : ch.outbox ? '▸ SHIPS TO OUTBOX'
        : ch.deadEnd ? '▸ OUTPUT DEAD-ENDS' : null;
    }
    ctx.save();
    ctx.font = (8 / zoom) + "px 'VT323','Courier New',monospace";
    const pad = 5 / zoom, bh = 11 / zoom;
    const bw = ctx.measureText(txt).width + pad * 2;
    const bw2 = t2 ? ctx.measureText(t2).width + pad * 2 : 0;
    ctx.restore();
    const cx = (p.x + (p.w || 1) / 2) * t, topY = p.y * t - 2 / zoom;
    const lines = t2 ? 2 : 1, wMax = Math.max(bw, bw2);
    voiceSay('hover', anchor, { x: cx - wMax / 2, y: topY - bh * lines, w: wMax, h: bh * lines }, (c) => {
      c.save();
      c.font = (8 / zoom) + "px 'VT323','Courier New',monospace"; c.textAlign = 'center'; c.textBaseline = 'bottom';
      c.fillStyle = 'rgba(8,16,12,0.92)'; c.fillRect(cx - bw / 2, topY - bh, bw, bh);
      c.fillStyle = bound ? 'rgba(125,240,200,0.96)' : 'rgba(255,190,60,0.96)';
      c.fillText(txt, cx, topY - 2 / zoom);
      if (t2) {
        const top2 = topY - bh;
        c.fillStyle = 'rgba(8,16,12,0.92)'; c.fillRect(cx - bw2 / 2, top2 - bh, bw2, bh);
        // handoff/ship-out = the bound green; a dead-ending output reads amber (same invite-to-fix tone as 'unassigned')
        c.fillStyle = (ch.next && ch.next.length) || ch.outbox ? 'rgba(125,240,200,0.96)' : 'rgba(255,190,60,0.96)';
        c.fillText(t2, cx, top2 - 2 / zoom);
      }
      c.restore();
    });
  }

  function drawHover(t) {
    if (drag) return;
    // a hovered prop (select/move/reclaim) outlines on top of any room outline
    if ((tool === 'select' || tool === 'move' || tool === 'reclaim' || (tool === 'dupe' && !dupe)) && hoverPropId) {
      const p = station.propById(hoverPropId);
      if (p) {
        ctx.lineWidth = 1.5 / zoom;
        ctx.strokeStyle = tool === 'reclaim' ? 'rgba(255,92,77,0.95)' : 'rgba(120,220,255,0.95)';
        ctx.strokeRect(p.x * t + 1, p.y * t + 1, p.w * t - 2, p.h * t - 2);
        return;
      }
    }
    // a belt is reclaimable/inspectable even though it sits ON a deck: highlight the BELT tile (not
    // the room under it) so the outline matches what a click actually targets (belt-before-room).
    if ((tool === 'reclaim' || tool === 'select') && hoverTile && station.beltAt(hoverTile.tx, hoverTile.ty)) {
      ctx.lineWidth = 1.5 / zoom;
      ctx.strokeStyle = tool === 'reclaim' ? 'rgba(255,92,77,0.95)' : 'rgba(120,220,255,0.95)';
      ctx.strokeRect(hoverTile.tx * t + 1, hoverTile.ty * t + 1, t - 2, t - 2);
      return;
    }
    if (tool !== 'move' && tool !== 'reclaim' && tool !== 'paint' && !(tool === 'dupe' && !dupe)) return;
    if (!hoverRoomId) return;
    const rm = station.roomById(hoverRoomId); if (!rm) return;
    const protectedSpawn = tool === 'reclaim' && hoverRoomId === station.spawnRoomId();
    ctx.lineWidth = 1.5 / zoom;
    ctx.strokeStyle = protectedSpawn ? 'rgba(255,200,80,0.95)' : (tool === 'reclaim' ? 'rgba(255,92,77,0.95)' : 'rgba(120,220,255,0.95)');
    for (const r of rm.rects) ctx.strokeRect(r.x1 * t + 1, r.y1 * t + 1, (r.x2 - r.x1 + 1) * t - 2, (r.y2 - r.y1 + 1) * t - 2);
    if (protectedSpawn) {
      /* THE SPAWN-ROOM LOCK BADGE. Two laws were broken by one line here:
         • '⌂' (U+2302) is NOT in VT323 — the browser silently fell back to another face for that one
           glyph, so the badge rendered at foreign metrics (symbol-glyph law);
         • it was painted with a bare ctx.fillText, OUTSIDE the one-voice arbiter, so it could print on
           top of a hover nameplate or a validation callout claiming the same tile.
         Now it is a DRAWN padlock — no font, no fallback, nothing to mis-measure — registered on the
         `hover` layer (it is a fact about the room under the pointer) so the arbiter mutes it exactly
         like every other voice when something louder is speaking at that anchor. */
      const z = rm.rects[0];
      const box = { x: z.x1 * t, y: z.y1 * t, w: t, h: t };
      voiceSay('hover', box, box, (c) => {
        const cx = (z.x1 + 0.5) * t, cy = (z.y1 + 0.5) * t, s = Math.max(3, 7 / zoom);
        c.save();
        c.strokeStyle = c.fillStyle = 'rgba(255,200,80,0.95)';
        c.lineWidth = Math.max(0.6, 1.2 / zoom);
        c.fillRect(cx - s / 2, cy - s * 0.1, s, s * 0.6);                       // the body
        c.beginPath();                                                          // the shackle
        c.arc(cx, cy - s * 0.1, s * 0.28, Math.PI, 0);
        c.stroke();
        c.restore();
      });
    }
  }

  /* ---------- THE GESTURE BADGE (2026-08-07 build-mode overhaul) ----------
     What you are about to do, printed ON the thing you are about to do it to. The dimensions used
     to live in the DOM action tip trailing the cursor into a screen corner — you dragged a room in
     the middle of the floor and read its size at the bottom-right of the glass. Now it is a small
     phosphor plate pinned to the ghost's own top edge, green when the model says the placement is
     legal and red with the REASON on a second line when it isn't.
     It registers as `activeFlow` (top priority) so the one-voice arbiter mutes every lower label
     near it — the ghost speaks alone while a gesture is live. */
  function ghostBadge(t, lines, ok, rect) {
    const fs = Math.max(9, 11 / zoom), lh = fs * 1.08, pad = fs * 0.34;
    ctx.font = fs + "px 'VT323','Courier New',monospace";
    let wMax = 0;
    for (const s of lines) wMax = Math.max(wMax, ctx.measureText(s).width);
    const bw = wMax + pad * 2, bh = lh * lines.length + pad * 1.6;
    /* CLAMP TO THE VISIBLE GLASS — the canvas runs UNDER the build dock and the top bar, so
       clamping to the canvas edge is not clamping to anything the user can read. A ghost near the
       left of the floor put its badge behind the dock and you lost the first words of the readout
       ("…SEARCH LINE — CLICK TO STAMP"). viewInsets is the same measurement fitCamera frames by. */
    const ins = viewInsetsFrame();
    const topWorld = (ins.t - panY) / zoom;
    // above the ghost by default; flip below when that would land off the top of the glass
    const above = rect.y1 * t - bh - fs * 0.35;
    const by = above > topWorld + fs ? above : (rect.y2 + 1) * t + fs * 0.35;
    const leftWorld = (ins.l - panX) / zoom, rightWorld = (cv.width - panX) / zoom, m = 4 / zoom;
    let bx = (rect.x1 + rect.x2 + 1) / 2 * t - bw / 2;
    bx = clamp(bx, leftWorld + m, Math.max(leftWorld + m, rightWorld - bw - m));
    const cx = bx + bw / 2;
    const box = { x: bx, y: by, w: bw, h: bh };
    voiceSay('activeFlow', box, box, () => {
      ctx.fillStyle = 'rgba(4,6,8,0.86)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.lineWidth = 1 / zoom;
      ctx.strokeStyle = ok ? 'rgba(120,255,170,0.9)' : 'rgba(255,120,110,0.9)';
      ctx.strokeRect(bx + 0.5 / zoom, by + 0.5 / zoom, bw - 1 / zoom, bh - 1 / zoom);
      ctx.font = fs + "px 'VT323','Courier New',monospace";
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillStyle = i === 0
          ? (ok ? 'rgba(180,255,215,1)' : 'rgba(255,190,180,1)')
          : (ok ? 'rgba(150,220,190,.85)' : 'rgba(255,150,140,.95)');
        ctx.fillText(lines[i], cx, by + pad * 0.8 + i * lh);
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    });
  }

  /* Corner brackets + per-tile edge ticks on the ghost. The brackets read as a targeting reticle
     instead of a flat highlighted rectangle, and the ticks let you COUNT the footprint against the
     grid without moving your eyes off it (the badge gives the number; the ticks prove it). */
  function ghostReticle(t, rect, line) {
    const X = rect.x1 * t, Y = rect.y1 * t, Wd = (rect.x2 - rect.x1 + 1) * t, Hd = (rect.y2 - rect.y1 + 1) * t;
    const arm = Math.min(Wd, Hd) * 0.3, cap = Math.min(arm, t * 2.2);
    // 3 SCREEN px, not 3 world px — a reticle that thins out as you zoom out stops reading as one
    ctx.strokeStyle = line; ctx.lineWidth = 3 / zoom;
    ctx.beginPath();
    ctx.moveTo(X, Y + cap); ctx.lineTo(X, Y); ctx.lineTo(X + cap, Y);
    ctx.moveTo(X + Wd - cap, Y); ctx.lineTo(X + Wd, Y); ctx.lineTo(X + Wd, Y + cap);
    ctx.moveTo(X + Wd, Y + Hd - cap); ctx.lineTo(X + Wd, Y + Hd); ctx.lineTo(X + Wd - cap, Y + Hd);
    ctx.moveTo(X + cap, Y + Hd); ctx.lineTo(X, Y + Hd); ctx.lineTo(X, Y + Hd - cap);
    ctx.stroke();
    if (t * zoom < 7) return;   // ticks turn to mush below ~7 device px per tile
    const tick = Math.min(t * 0.3, 4 / zoom);
    ctx.lineWidth = 1 / zoom; ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (let gx = rect.x1 + 1; gx <= rect.x2; gx++) { const px2 = gx * t; ctx.moveTo(px2, Y); ctx.lineTo(px2, Y + tick); ctx.moveTo(px2, Y + Hd); ctx.lineTo(px2, Y + Hd - tick); }
    for (let gy = rect.y1 + 1; gy <= rect.y2; gy++) { const py2 = gy * t; ctx.moveTo(X, py2); ctx.lineTo(X + tick, py2); ctx.moveTo(X + Wd, py2); ctx.lineTo(X + Wd - tick, py2); }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // the bounding rect of a brush stroke's cells — the badge needs something to pin itself to
  function cellsRect(cells) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const k of cells) { const p = k.split(','), x = +p[0], y = +p[1]; if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
    return x2 < x1 ? null : { x1, y1, x2, y2 };
  }

  /* ---------- THE CANDIDATE WASH: where this line CAN go ----------
     Painted from the cached field (lineField) — the frame does zero model work here, it fills the
     pre-merged runs and strokes the pre-merged boundary. Matte and dim on purpose: this is ground
     being described, not a control. It speaks the GRID's phosphor (the same rgba(120,200,255) the
     apron uses) so it reads as "buildable floor", never as a second ghost.

     It draws ABOVE the light layer with the crosshair: an instrument painted before
     StationBake.drawLight is swallowed by the deck it is supposed to be describing. */
  function drawLineField(t) {
    if (tool !== 'line') return;
    const f = lineField(lineType);
    if (!f || !f.runs.length) return;
    ctx.save();
    ctx.fillStyle = 'rgba(120,200,255,0.075)';
    for (const r of f.runs) ctx.fillRect(r.x1 * t, r.ty * t, (r.x2 - r.x1 + 1) * t, t);
    ctx.strokeStyle = 'rgba(120,200,255,0.34)';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    for (const e of f.edges) { ctx.moveTo(e[0] * t, e[1] * t); ctx.lineTo(e[2] * t, e[3] * t); }
    ctx.stroke();
    ctx.restore();
  }

  function drawGhost(t, now) {
    // paint brush: tint the crossed tiles with the chosen deck colour
    if (drag && drag.mode === 'paint' && drag.moved) {
      const base = station.FLOOR_STYLES[style] ? station.FLOOR_STYLES[style].base : '#888';
      ctx.globalAlpha = 0.55; ctx.fillStyle = base;
      let n = 0;
      for (const k of drag.cells) { const p = k.split(','); if (station.roomAt(+p[0], +p[1]) === drag.roomId) { ctx.fillRect(+p[0] * t, +p[1] * t, t, t); n++; } }
      ctx.globalAlpha = 1;
      const bb = cellsRect(drag.cells);
      if (bb) ghostBadge(t, [n + (n === 1 ? ' TILE' : ' TILES')], true, bb);
      return;
    }
    // reclaim drag: tint the belt tiles the drag will clear (destructive red), like the paint brush
    if (drag && drag.mode === 'reclaim' && drag.moved) {
      let n = 0;
      ctx.globalAlpha = 0.5; ctx.fillStyle = 'rgba(255,92,77,0.9)';
      for (const k of drag.cells) { const p = k.split(','); if (station.beltAt(+p[0], +p[1])) { ctx.fillRect(+p[0] * t, +p[1] * t, t, t); n++; } }
      ctx.globalAlpha = 1;
      const bb = cellsRect(drag.cells);
      if (bb) ghostBadge(t, n ? [n + (n === 1 ? ' BELT' : ' BELTS'), 'RELEASE TO CLEAR'] : ['DRAG ALONG A BELT'], n > 0, bb);
      return;
    }
    const g = ghostInfo();
    if (!g) return;
    const ok = g.v && g.v.ok;
    // a HOVER PREVIEW is quieter than a live gesture — it is showing you an option, not a commitment,
    // and at full strength it read as "you are already dragging" every time the pointer crossed the floor
    // ...and an INVALID preview is quieter still: with ROOM armed, every pass of the pointer over
    // your own station would otherwise wash the whole floor red before you had asked for anything.
    // The outline and the badge carry the refusal; the fill does not need to shout it.
    const k = g.stamp ? (ok ? 0.6 : 0.3) : 1;
    const fill = ok ? 'rgba(80,255,140,' + (0.16 * k).toFixed(3) + ')' : 'rgba(255,90,80,' + (0.18 * k).toFixed(3) + ')';
    const line = ok ? 'rgba(120,255,170,' + (0.95 * k).toFixed(2) + ')' : 'rgba(255,120,110,' + (0.95 * k).toFixed(2) + ')';
    ctx.lineWidth = 1.5 / zoom;
    for (const r of g.rects) {
      const X = r.x1 * t, Y = r.y1 * t, Wd = (r.x2 - r.x1 + 1) * t, Hd = (r.y2 - r.y1 + 1) * t;
      ctx.fillStyle = fill; ctx.fillRect(X, Y, Wd, Hd);
      ctx.strokeStyle = line; ctx.strokeRect(X + 0.5 / zoom, Y + 0.5 / zoom, Wd - 1 / zoom, Hd - 1 / zoom);
    }
    for (const r of g.rects) ghostReticle(t, r, line);
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
    // live readout, pinned to the ghost: the dimensions you are drawing, and — when the model says
    // no — the reason on its own line right under them. (Was a DOM tip trailing into a screen corner.)
    const r0 = g.rects[0], w = r0.x2 - r0.x1 + 1, h = r0.y2 - r0.y1 + 1;
    let dims = g.belt ? ('BELT ' + g.dir + ' · ' + Math.max(w, h) + ' LONG')
      : g.kind === 'line' ? (String(g.label || '').toUpperCase() + ' — CLICK TO STAMP')
      : g.move ? ('MOVE ' + (g.dx >= 0 ? '+' : '') + g.dx + ', ' + (g.dy >= 0 ? '+' : '') + g.dy)
      : (tool === 'hall' ? (Math.max(w, h) + ' LONG × ' + Math.min(w, h) + ' WIDE') : (w + ' × ' + h));
    const lines = [dims];
    // a sized footprint also gets its area — "how much floor is this?" is the other question a drag asks
    if (!g.belt && !g.move && g.kind !== 'line' && w * h > 1) lines[0] = dims + '   ' + (w * h) + ' TILES';
    if (!ok) lines.push(((g.v && g.v.msg) || 'blocked').toUpperCase());
    // the hover preview teaches BOTH gestures: this size on a click, any size on a drag
    else if (g.stamp) lines.push('CLICK TO PLACE · DRAG TO SIZE');
    ghostBadge(t, lines, ok, r0);
    // NOTE: deliberately does NOT hideTip() — flashTip's transient confirmations ("room placed")
    // fire while a ghost is still on screen, and hiding here every frame would eat them instantly.
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
    if (ev) lastClient = { x: ev.clientX, y: ev.clientY };   // ev-less callers (the auto first ride) anchor at the last pointer spot
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
    // MOUNT is a placement RULE, so it belongs on the footprint line next to the other placement facts —
    // a player who only meets it as a red ghost has been told "no" without being told "why".
    const mount = c.mount === 'surface' ? ' · stands on a table'
      : c.stack ? ' · deck or table'
      : (c.surface ? ' · things can stand on it' : '');
    const foot = c.w + '×' + c.h + (c.blocks === false ? ' · walkable' : ' · solid') + mount;
    const desc = c.desc || (fn ? '' : 'Decor — looks only. Sets the mood; no effect on how the station runs.');
    let assign = '';
    if (placed && WORKSTATION_TYPES[placed.t]) {
      assign = placed.agentId
        ? '<div class="pc-assign ok">▸ HOSTED BY ' + esc(agentLabel(placed.agentId)) + '</div>'
        : '<div class="pc-assign">UNASSIGNED — click to choose an agent</div>';
    } else if (placed && placed.t === 'bay') {
      if (placed.agentId) {
        assign = '<div class="pc-assign ok">▸ AGENT ' + esc(agentLabel(placed.agentId)) + '</div>';
        // the dock→dock line the canvas tag used to carry — the card is the ONE hover voice now
        // (one-voice law), so the chain fact rides here, from the same compiled valPlan.chains.
        const ch = valPlan && valPlan.chains && valPlan.chains[placed.agentId];
        const t2 = !ch ? null
          : (ch.next && ch.next.length) ? '▸ HANDS OFF TO ' + ch.next.map(agentLabelFor).join(' + ')
          : ch.outbox ? '▸ SHIPS TO OUTBOX'
          : ch.deadEnd ? '▸ OUTPUT DEAD-ENDS' : null;
        if (t2) assign += '<div class="pc-assign' + ((ch.next && ch.next.length) || ch.outbox ? ' ok' : '') + '">' + esc(t2) + '</div>';
      } else {
        // an unbound ROLE dock introduces itself here on hover (its floor placard is muted while hovered)
        const ri = (placed.role && typeof WorldModel !== 'undefined' && WorldModel.bayRoleInfo) ? WorldModel.bayRoleInfo(placed.role) : null;
        assign = ri ? '<div class="pc-assign">NEEDS A ' + esc(placed.role) + ' — ' + esc(ri.desc) + ' — click to crew</div>'
          : '<div class="pc-assign">NO AGENT — click to assign</div>';
      }
    } else if (placed && placed.t === 'connector_portal') {
      assign = placed.connectorId
        ? '<div class="pc-assign ok">▸ BOUND ' + esc(placed.connectorId) + '</div>'
        : '<div class="pc-assign">UNBOUND — click to bind a server</div>';
    } else if (placed && placed.t === 'intake' && placed.label) {
      // a NAMED line's INBOX hover names the line (line naming) — the card is the ONE hover voice in
      // REFIT (one-voice law), so the fact rides here; the canvas glance covers the card-less contexts.
      assign = '<div class="pc-assign ok">▸ LINE · ' + esc(placed.label) + '</div>';
    }
    // a briefed dock's hover shows its duty line (a glance answer to "what does this step DO?")
    if (placed && placed.t === 'bay' && placed.brief) {
      const bp = String(placed.brief).replace(/\s+/g, ' ');
      assign += '<div class="pc-assign">✎ ' + esc(bp.length > 72 ? bp.slice(0, 72) + '…' : bp) + '</div>';
    }
    return '<h4>' + esc(c.label) + '</h4>' + tier + (desc ? ('<p>' + esc(desc) + '</p>') : '') + '<div class="pc-foot">' + foot + '</div>' + assign;
  }
  let propCardKey = null;
  function showPropCard(c, placed, cx, cy) {
    if (!propCard || !c) return;
    const key = placed
      ? ('p:' + placed.id + ':' + (placed.agentId || placed.connectorId || '') + ':' + (placed.label || '') + ':' + (placed.brief ? placed.brief.length : 0))
      : ('c:' + c.id);
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
        if ((station.canPlaceProp(type, tx, ty, w, h) || {}).ok) return { tx, ty };
    return null;
  }
  const __test__ = {
    isOpen: () => running,
    // the armed tool (select = nothing armed) — CDP proof scripts assert the deselect gestures on this
    tool: () => tool,
    // the live WorldModel — for CDP verify scripts to lay a floor through the REAL validated
    // mutation API (setBelt/addProp/assignPropAgent), never by poking doc internals.
    station: () => station || (opts && typeof opts.getStation === 'function' ? opts.getStation() : null),
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
    // client-pixel for a tile CENTER, inverting the live camera (screen = world*zoom + pan) so a
    // synthetic pointer lands exactly on [tx,ty] — same math toWorldTile uses, run backwards.
    _tileEvent: ([tx, ty], button) => {
      const t = T(), r = cv.getBoundingClientRect();
      return { button: button == null ? 0 : button, pointerId: 1,
        clientX: r.left + ((tx + 0.5) * t * zoom + panX) * (r.width / cv.width),
        clientY: r.top + ((ty + 0.5) * t * zoom + panY) * (r.height / cv.height) };
    },
    // drive a REAL reclaim gesture (onDown→onMove→onUp) across a tile list — proves the belt
    // drag-to-clear path end to end (accumulate cells → filter to belts → removeBelts → one undo).
    reclaimDrag: (tiles) => {
      if (!running || !station || !cv || !tiles || !tiles.length) return { ok: false, reason: 'not-in-build' };
      selectTool('reclaim');
      const before = station.belts().length;
      onDown(__test__._tileEvent(tiles[0]));
      for (let i = 1; i < tiles.length; i++) onMove(__test__._tileEvent(tiles[i]));
      onUp(__test__._tileEvent(tiles[tiles.length - 1]));
      return { ok: true, before, after: station.belts().length };
    },
    /* drive a REAL place gesture (onDown→onMove→onUp) with a tool armed, and hand back the room the
       station actually gained. This is the seam the snap proof needs: asserting snapFit() directly
       would prove the arithmetic and nothing about whether the GHOST and the COMMIT agree, which is
       the half that silently breaks (the ghost shows flush, the click lands one tile off). Drives
       the same three handlers a mouse does, so both go through it. `mode` is 'room' or 'hall'. */
    placeDrag: (mode, from, to) => {
      if (!running || !station || !cv) return { ok: false, reason: 'not-in-build' };
      selectTool(mode === 'hall' ? 'hall' : 'room');
      const before = new Set(station.rooms().map(r => r.id));
      onDown(__test__._tileEvent(from));
      onMove(__test__._tileEvent(to));
      onUp(__test__._tileEvent(to));
      const made = station.rooms().find(r => !before.has(r.id));
      return { ok: !!made, requested: { from, to },
        rects: made ? made.rects.map(r => ({ ...r })) : null, kind: made ? made.kind : null };
    },
    // the ghost's CURRENT rect — so a proof can assert the ghost and the commit agree, not just one
    ghostRects: () => { const g = ghostInfo(); return g && g.rects ? g.rects.map(r => ({ ...r })) : null; },
    // finish-the-line card readout for CDP proof scripts: the EXACT DOM state the card renders
    finCard: () => (finCardEl ? {
      key: finComp && finComp.key,
      display: finCardEl.style.display !== 'none',
      left: finCardEl.style.left, top: finCardEl.style.top,
      steps: [...finCardEl.querySelectorAll('.fl-step')].map(b => ({
        act: b.dataset.act, txt: b.textContent.trim(),
        done: b.classList.contains('done'), off: b.classList.contains('off'), disabled: b.disabled,
        tip: b.getAttribute('title') || b.getAttribute('data-tip') || null,
      })),
    } : null),
    finRegistry: () => finRead(station),
    /* TEST-RIDE readouts for CDP proof scripts (conveyor-audit 2026-08-10). rideMouth runs the
       REAL reach-aware picker (null agentId = the lineless ▸ TEST pick, WORLD tiles); ride()
       reports the one-shot arming + the live preview crates and captions — where the ride
       actually entered, straight from the engine, never a screenshot of the animated canvas. */
    rideMouth: (agentId) => rideMouthFor(agentId || null),
    ride: () => ({
      pending: ridePending, timer: !!rideTimer, agentId: rideAgentId, seen: rideSeen(),
      boxes: convey ? convey.peekBoxes().filter(b => b.payload && b.payload.test)
        .map(b => ({ x: b.x, y: b.y, tag: (b.payload && b.payload.tag) || null, outbound: !!(b.payload && b.payload.outbound) })) : [],
      notes: testNotes.map(n => ({ x: n.x, y: n.y, text: n.text })),
    }),
    /* PLACEMENT readouts for CDP proof scripts — the EXACT state the wash and the snap run on.
       lineField reports the cached candidate set (count + a bounded sample, never the whole list);
       lineSnapAt answers what a click at a tile would actually commit. */
    lineField: (bpId) => {
      const f = lineField(bpId || lineType);
      return f ? { bp: bpId || lineType, count: f.list.length, runs: f.runs.length, sample: f.list.slice(0, 8) } : null;
    },
    lineFits: (bpId) => lineFits(bpId || lineType),
    lineSnapAt: (tx, ty) => lineSnap(tx, ty),
    // which draw layers have failed this session (empty = every layer is painting)
    degradedLayers: () => Object.keys(layerFailed),
    /* FRAME COST INSTRUMENT — perf(true) starts accumulating, perf(false) stops and returns the
       totals: { '=FRAME': {n, ms}, grid: {…}, props: {…}, … }. Off = a null test per layer. */
    perf: (on) => {
      if (on === false) { const o = perfAcc; perfAcc = null; return o; }
      perfAcc = Object.create(null);
      return true;
    },
    perfRead: () => (perfAcc ? JSON.parse(JSON.stringify(perfAcc)) : null),
    // the per-edit memo generation — a harness can prove a cache actually invalidated on an edit
    geoVer: () => geoVer,
    // camera + the dock/top insets, so a harness can assert framing against the VISIBLE glass
    camera: () => ({ zoom, panX, panY, cw: cv ? cv.width : 0, ch: cv ? cv.height : 0, tile: T(), ins: viewInsets() }),
    // ghost-projection readout (Phase 3) — the EXACT state the projection runs on (boxes/captions/log)
    ghost: () => (ghost ? ghost.peek() : null),
    // run the REAL hover path over a tile and report what the reclaim highlight would target
    // (a belt tile lights the belt, not the room under it).
    hoverAt: (tile) => {
      if (!running || !cv) return null;
      selectTool('reclaim');
      onMove(__test__._tileEvent(tile, 0));
      return { hoverTile, onBelt: !!(hoverTile && station.beltAt(hoverTile.tx, hoverTile.ty)) };
    },
  };

  // REQUISITION — place a prop programmatically through the SAME validated path as a hand placement
  // (findPlaceableTile → station.addProp), firing the same flash/chime/first-touch hooks, so the tutorial's
  // "requisition the rest" is a REAL placement (object=capability stays honest — never a flag). Only while
  // REFIT is open (the kit-out's context); editable/config props are refused (they'd open an editor
  // mid-ceremony). Returns { ok, tile? , reason? }.
  function requisition(t) {
    if (!running || !station) return { ok: false, reason: 'not-in-build' };
    if (!t || isEditableProp(t)) return { ok: false, reason: 'needs-config' };
    const s = propSpec(t);
    const tile = findPlaceableTile(t, s.w, s.h);
    if (!tile) return { ok: false, reason: 'no-valid-tile' };
    const res = station.addProp({ t, x: tile.tx, y: tile.ty, w: s.w, h: s.h, block: s.blocks !== false });
    if (!res || !res.ok) return { ok: false, reason: (res && res.reason) || 'rejected' };
    pushFlash([{ x1: tile.tx, y1: tile.ty, x2: tile.tx + s.w - 1, y2: tile.ty + s.h - 1 }], false);
    const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(t) : null;
    if (grant) sfx('chime');   // a capability just came online — same brighter note as a hand placement
    if (typeof StationUI !== 'undefined' && StationUI.pokeQuests) { try { StationUI.pokeQuests(); } catch (_) {} }   // resolve+fold now: a gap this requisition closes celebrates on its own edge
    if (typeof Tutorial !== 'undefined' && Tutorial.onPropPlaced) Tutorial.onPropPlaced(t);
    return { ok: true, tile };
  }

  // deep-link: open REFIT straight into a placed prop's editor. The live world's "NO AGENT — CLICK"
  // bay nag lands here, so the fix is one click away from the callout instead of a hunt through modes.
  function openAssign(propId) {
    if (!running) open();     // open() resolves `station` from opts.getStation() — MUST run before the guard
    if (!station) return;     // (guard-first was a real shipped bug: the click-nag path no-opped on any session that had never opened REFIT)
    const p = station.propById(propId);
    if (!p) return;
    openPropEditor(propId, p.t, { clientX: (window.innerWidth / 2) | 0, clientY: 120 });   // synthetic anchor for the action tip
  }

  const api = { init, open, close, toggle, isOpen, requisition, openAssign, noteLineDelivered };
  if (typeof window !== 'undefined' && window.__STARNET_DEV__) api.__test__ = __test__;
  return api;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Build;
