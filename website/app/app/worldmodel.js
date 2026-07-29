/* STARNET — worldmodel.js : the canonical, mutable, serializable STATION document.

   This is the single source of truth the builder edits and that both the renderer
   (via projectGeometry → stationbake.js) and the future AgentOrg runtime read.

   PURITY CONTRACT (so it stays headless-testable and deterministic):
     - no DOM, no canvas, no `window`/`document`
     - no ambient wall-clock or RNG — ids are a per-document counter, timestamps are injected
   It only depends on the global `U` (util.js: U.clamp/U.shade/U.hash) — none of which are
   non-deterministic. See frontend/app/BUILDER.md for the full contract.

   The model stores LOGICAL geometry in signed world-tile coords (unbounded; the station can
   grow in any direction). `projectGeometry()` emits the v7 MAP-shaped object the bake consumes,
   shifted into a non-negative local frame with a margin for the hull. */
'use strict';

const WorldModel = (() => {
  /* MOUNT RULES lookup, injected once at module level (NOT per station instance) — a per-instance
     setter would have to be re-armed at every create()/deserialize()/undo-clone site, and the one
     that got missed would silently place wall props in open floor. Null = no rules installed, which
     is the plain-node/test case: every prop is placeable on bare deck exactly as before. */
  let propRules = null;
  function setPropRules(fn) { propRules = (typeof fn === 'function') ? fn : null; }
  const TILE = 12;
  const MARGIN = 3;     // tile padding around the bounding box (hull extrusion + chamfer arcs need room)
  const MIN_ROOM = 3;   // min room floor side, in tiles
  const MIN_HALL = 2;   // min hallway length, in tiles (long axis)
  const MAX_SPAN = 240; // max station footprint span per axis (keeps the bake canvas bounded)
  const HULL_PAD = 14;  // extra canvas px below the grid for the south hull extrusion (matches v7 H = ROWS*T+14)

  /* FILTER/MERGER junction config carried on a prop (additive, like a BAY's agentId; the pipeline reads
     routes/def for filters, bufferSize for mergers). Sanitized so a hand-edited save can never inject a bad lane. */
  const JDIRS = { E: 1, W: 1, N: 1, S: 1 };
  const cleanDir = d => (JDIRS[d] ? d : null);
  function cleanRoutes(r) {
    if (!r || typeof r !== 'object') return null;
    const out = {}; let n = 0;
    for (const k in r) { const key = String(k).slice(0, 24); if (key && JDIRS[r[k]]) { out[key] = r[k]; n++; } }
    return n ? out : null;
  }
  const cleanBuf = b => { const n = b | 0; return n >= 2 ? n : null; };
  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;   // notebook/fs-jail agentId grammar (mirrors the sidecar hub)
  const WHEN_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
  function cleanPipelineEdge(e) {
    if (!e || typeof e !== 'object') return null;
    const from = String(e.from || '').trim();
    const to = String(e.to || '').trim();
    const whenKind = String(e.whenKind || 'handoff').trim();
    if (!AID_RE.test(from) || !AID_RE.test(to) || from === to || !WHEN_RE.test(whenKind)) return null;
    const out = { from, to, whenKind };
    const lane = String(e.lane == null ? '' : e.lane).trim();
    if (lane) {
      if (!WHEN_RE.test(lane)) return null;
      out.lane = lane;
    }
    return out;
  }
  // copy any present + valid junction config from src onto dst (mutates dst; additive — absent fields untouched)
  function applyJunctionCfg(dst, src) {
    const routes = cleanRoutes(src.routes); if (routes) dst.routes = routes;
    const def = cleanDir(src.def); if (def) dst.def = def;
    const buf = cleanBuf(src.bufferSize); if (buf) dst.bufferSize = buf;
    return dst;
  }

  /* Airlock door state — a SPATIAL room-seal mechanic, carried on an 'airlock' prop exactly like a BAY
     carries agentId. A room containing a SEALING airlock (closed|jammed) is cut off ON THE FLOOR:
     projectGeometry drops its boundary doors so canStep — and thus every agent BODY path — can't cross in
     or out. It's a staging seal (an unmerged-branch metaphor); it does NOT change the agent's run, tools, or
     capabilities (the BAY governs those). The room is visually private until "merged".
       open   = connected to trunk (DEFAULT — stored as an absent field, so old docs are unchanged)
       closed = private, sealed
       jammed = a merge conflict (sealed + a red spark on the prop) */
  const DOOR_STATES = { open: 1, closed: 1, jammed: 1 };
  const cleanDoor = s => (DOOR_STATES[s] ? s : null);
  const doorSeals = s => s === 'closed' || s === 'jammed';

  /* Phase B5 — object = capability, made real on the placed floor. A prop type maps to a CAP_REGISTRY
     objectType (computer=compute · cabinet=files · dish=web · notebook=memory); the props in a BAY's room are
     that agent's grants (via the sidecar's resolveTools). DATA, deliberately tunable — only a few intuitive
     props grant reach; everything else is inert decor. A bay with no `computer` prop can't run (compute gate
     stays shut = cost-safe), which the REFIT validator surfaces as NO COMPUTE. */
  const CAP_PROP_MAP = {
    console: 'computer', consoleL: 'computer', desk: 'computer', desk2: 'computer', pixelrig: 'computer', bench: 'computer',  // a workstation = compute
    war_intelcab: 'cabinet', safe: 'cabinet', vault: 'cabinet', rack: 'cabinet', shelf: 'cabinet',                            // a locked cabinet = files
    comms_dish: 'dish', comms_uplink: 'dish', comms_beacon: 'dish',                                                           // a comms dish = web
    gigs_servercart: 'notebook', bridge_relaystack: 'notebook', core: 'notebook',                                            // a server/databank = memory
    connector_portal: 'connector',                                                                                           // a connector portal = an MCP server's live tools (per-instance, bound to a connectorId)
    workbench: 'workbench',                                                                                                   // a workbench = shell.exec + verify.run (real code execution, consent-gated)
    studio: 'studio',                                                                                                         // a media studio = image_generate / image_analyze (G1b: image tools finally have a placeable body)
    jukebox: 'jukebox'                                                                                                        // a jukebox = Spotify tools (search/now-playing/play/pause/queue); INERT until Spotify is connected in TOOLSETS
  };

  /* the plain-English POWER each capability grants — one OWNED source of truth so the palette tile, the
     placement toast, and the Field Manual all say the SAME word for the same thing (kills DISH-vs-antenna
     drift: a prop, the power it grants, and what the agent then does all match). */
  const CAP_LABEL = {
    computer: 'COMPUTE', cabinet: 'FILES', dish: 'WEB', notebook: 'MEMORY', connector: 'LIVE TOOLS', workbench: 'TERMINAL', studio: 'IMAGES', jukebox: 'SPOTIFY'
  };
  function grantLabelForProp(propType) { const c = CAP_PROP_MAP[propType]; return c ? (CAP_LABEL[c] || c) : null; }   // prop -> plain power word (or null = inert decor)

  /* the paint palette — each is a floor BASE colour; every other floor detail
     (seams / rivets / vents / hatches) is derived from it via U.shade in the bake.
     The COLOURED bases stay in a dark low-value SUBSTRATE band (floor, not accent light) so the
     CRT phosphor + warm room-light pools read on top — their variety comes from spreading the HUE
     across the wheel, not from brightness. bone + onyx are the deliberate exceptions: the bright
     and near-black ends of the value range, for decks that want stark contrast. This catalog is the
     sole source: add a colour here and it appears in the SURFACE palette's COLOUR row AND as a room floor
     style automatically. */
  const FLOOR_STYLES = {
    hull:     { base: '#33302a', label: 'HULL' },
    corridor: { base: '#2c2924', label: 'DECKING' },
    cobalt:   { base: '#2b3340', label: 'COBALT' },
    rust:     { base: '#3a302a', label: 'RUST' },
    sterile:  { base: '#34383a', label: 'STERILE' },
    crimson:  { base: '#3a2b2b', label: 'CRIMSON' },
    verdant:  { base: '#2c3a2e', label: 'VERDANT' },
    // extended spectrum — warm → cool, same dark substrate band, each a distinct hue
    ember:    { base: '#402a1c', label: 'EMBER' },
    amber:    { base: '#3c3420', label: 'AMBER' },
    moss:     { base: '#34391f', label: 'MOSS' },
    teal:     { base: '#213a3c', label: 'TEAL' },
    indigo:   { base: '#282a48', label: 'INDIGO' },
    violet:   { base: '#332941', label: 'VIOLET' },
    orchid:   { base: '#3e2a3a', label: 'ORCHID' },
    // natural tones — the hues the PLANK / TURF materials were drawn for. Same dark substrate
    // band as everything above: a wood deck is a DARK wood deck, so the room-light pools still
    // read on top of it. (Any material still renders in any hue — these are just the fitting ones.)
    walnut:   { base: '#3b2b20', label: 'WALNUT' },
    oak:      { base: '#46372a', label: 'OAK' },
    ash:      { base: '#3a3630', label: 'ASH' },
    fern:     { base: '#2a3f24', label: 'FERN' },
    // MEADOW — fern's warm twin, added for TURF (2026-07-25). Real grass is olive: red and green
    // close together with blue well under both. FERN is a blue-leaning green, and because vivid()
    // drives the DOMINANT channel hardest, its lifts run toward pure green rather than the
    // yellow-green of a lawn. Raising red and dropping blue is what buys the olive.
    meadow:   { base: '#374024', label: 'MEADOW' },
    // value poles — the bright + near-black ends of the range (stark, deliberate)
    bone:     { base: '#e7e3d9', label: 'BONE' },
    onyx:     { base: '#0e0e12', label: 'ONYX' },
  };

  /* the deck MATERIAL catalog — the second floor axis, orthogonal to colour.
     FLOOR_STYLES picks the HUE; this picks the RECIPE the bake draws in that hue (plate seams,
     grate holes, wood grain, grass blades...). Both compose: every material derives its marks
     from the tile's own base via U.shade, so a TURF deck painted COBALT is blue grass — odd,
     but coherent and the user's call. `pitch` is the plate/plank cell in tiles; `suggest` is the
     hue the SURFACE palette pre-selects when you pick that material (a UI convenience only — the
     model never forces a colour). This catalog is the sole source: add a material here, give it
     a recipe in stationbake, and it appears in the SURFACE palette's MATERIAL row automatically. */
  const FLOOR_MATERIALS = {
    // the hab default since 2026-07-25 — see the note above deckSpine in stationbake.js
    spine: { label: 'SPINE',  pitch: [4, 3], suggest: null },
    plate: { label: 'PLATE',  pitch: [2, 2], suggest: null },
    panel: { label: 'PANEL',  pitch: [4, 1], suggest: null },
    tile:  { label: 'TILE',   pitch: [2, 2], suggest: null },
    tread: { label: 'TREAD',  pitch: [2, 2], suggest: null },
    soft:  { label: 'MATTED', pitch: [3, 2], suggest: null },
    // v4 additions — the decks that don't look like the old station
    grate: { label: 'GRATE',  pitch: [1, 1], suggest: 'onyx' },
    hex:   { label: 'HEX',    pitch: [1, 1], suggest: 'sterile' },
    plank: { label: 'PLANK',  pitch: [5, 1], suggest: 'walnut' },
    turf:  { label: 'TURF',   pitch: [1, 1], suggest: 'meadow' },
  };
  const MAT_ORDER = ['spine', 'plate', 'panel', 'tile', 'tread', 'soft', 'grate', 'hex', 'plank', 'turf'];

  /* the WALL material catalog — the deck's opposite number. Walls carry the same two axes as the
     floor (hue × recipe) and read from the same FLOOR_STYLES hue catalog, because a room should be
     able to be cobalt all the way up. `room.wallStyle` null means "follow this room's floor hue",
     which is what makes a freshly-built station instantly varied instead of one brown-grey box.
     `viewport` is the odd one out: it doesn't PAINT the wall, it punches a hole in it — the bake
     leaves those pixels transparent so the live drifting starfield behind the station shows
     through. Baked stars would be a lie; the real sky is already back there. */
  const WALL_MATERIALS = {
    // base-wall candidates — see the note above wallBulkhead in stationbake.js
    // the base wall since 2026-07-25 — see the note above wallBulkhead in stationbake.js
    bulkhead: { label: 'BULKHEAD', suggest: null },
    courses:  { label: 'COURSES',  suggest: null },
    service:  { label: 'SERVICE',  suggest: null },
    plating:  { label: 'PLATING',  suggest: null },
    ribbed:   { label: 'RIBBED',   suggest: null },
    panelled: { label: 'PANEL',    suggest: null },
    viewport: { label: 'VIEWPORT', suggest: null },
    pipework: { label: 'PIPEWORK', suggest: null },
    wainscot: { label: 'WAINSCOT', suggest: 'walnut' },
    hedge:    { label: 'HEDGE',    suggest: 'fern' },
  };
  const WALL_ORDER = ['bulkhead', 'courses', 'service', 'plating', 'ribbed', 'panelled', 'viewport', 'pipework', 'wainscot', 'hedge'];

  /* room categories — a capability-zone label + a default floor (hue + material). kind drives
     nothing behavioural yet (capability mapping is a later pass); it tags the zone + seeds the
     look. `mat` is the DEFAULT deck material a room of this kind is built with — a room whose
     floorMat is null renders at this material.

     THIS MAP IS THE AUTHORITY on a room's default deck. `MAT_BY_KIND` in stationbake.js looks like
     a second copy but is only a fallback for geometry that arrives without `matOf` — projected
     geometry always carries it, so editing stationbake alone changes NOTHING you can see. Change
     both, and keep them agreeing.

     2026-07-25: hab and corridor moved off `plate` onto `spine` (they must move together or a
     corridor reads as a different floor through the doorway). This DELIBERATELY changes the look of
     every station already built — floorMat is null on all of them — because the default deck is the
     one surface every player sees. `plate` stays in the palette, so the old look is still choosable
     and nothing is destroyed. It also means the Guardian goldens all shift. */
  const ROOM_KINDS = {
    hab:      { label: 'HAB',      floor: 'hull',     mat: 'spine' },
    bridge:   { label: 'BRIDGE',   floor: 'cobalt',   mat: 'panel' },
    lab:      { label: 'LAB',      floor: 'sterile',  mat: 'tile'  },
    factory:  { label: 'FOUNDRY',  floor: 'rust',     mat: 'tread' },
    quarters: { label: 'QUARTERS', floor: 'verdant',  mat: 'soft'  },
    storage:  { label: 'STORAGE',  floor: 'rust',     mat: 'tread' },
    corridor: { label: 'CORRIDOR', floor: 'corridor', mat: 'spine' },
  };
  // a room's effective deck material: explicit override, else the kind default, else plate.
  const matOfRoom = rm => (rm && FLOOR_MATERIALS[rm.floorMat]) ? rm.floorMat
    : ((rm && ROOM_KINDS[rm.kind] && ROOM_KINDS[rm.kind].mat) || 'plate');
  // walls: material defaults to plating; hue defaults to FOLLOWING THE FLOOR, so every room's
  // walls harmonize with its deck without the Commander having to pick twice.
  /* THE AUTHORITY on a room's default wall material (stationbake's `wallMatOf` fallback is only for
     geometry arriving without one). 2026-07-25: moved off `plating` onto `bulkhead` — every room
     carries wallMat null, so this reaches stations already built, deliberately, for the same reason
     the deck default moved. `plating` stays in the palette as the classic. */
  const wallMatOfRoom = rm => (rm && WALL_MATERIALS[rm.wallMat]) ? rm.wallMat : 'bulkhead';
  const wallStyleOfRoom = rm => {
    if (rm && FLOOR_STYLES[rm.wallStyle]) return rm.wallStyle;
    if (rm && FLOOR_STYLES[rm.floorStyle]) return rm.floorStyle;
    return 'hull';
  };
  const KIND_ORDER = ['hab', 'bridge', 'lab', 'factory', 'quarters', 'storage'];

  /* ---------- pure geometry helpers ---------- */
  const normRect = r => ({
    x1: Math.min(r.x1, r.x2), y1: Math.min(r.y1, r.y2),
    x2: Math.max(r.x1, r.x2), y2: Math.max(r.y1, r.y2)
  });
  const rectW = r => r.x2 - r.x1 + 1;
  const rectH = r => r.y2 - r.y1 + 1;
  const rectsHit = (a, b) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2; // inclusive: shares a tile
  const inRect = (r, x, y) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
  const clone = o => JSON.parse(JSON.stringify(o));
  const pad2 = n => String(n).padStart(2, '0');

  function freshDoc(createdAt) {
    const doc = {
      schema: 'starnet.station', version: 1, _nid: 1,
      meta: { name: 'STARNET STATION', createdAt: createdAt || 0, tier: 0, spawnRoomId: null, trunkRoomId: null },
      rooms: {}, order: [], props: [], belts: {}, edges: []
    };
    // seed the shabby starter HAB (18×11 floor — the v7 / world.js starter room), so a new
    // station is never empty and the builder has something to extend from.
    const id = 'r' + (doc._nid++);
    doc.rooms[id] = {
      id, kind: 'hab', name: 'HAB-01',
      rects: [{ x1: 0, y1: 0, x2: 17, y2: 10 }],
      floorStyle: 'hull', floorMat: null, wallStyle: null, wallMat: null, tier: 0, floorPaint: {}
    };
    doc.order.push(id);
    doc.meta.spawnRoomId = id;
    doc.meta.trunkRoomId = id;   // the starter HAB is the integration hub — it never seals
    return doc;
  }

  /* ============================================================= */
  function makeStation(doc) {
    doc = doc || freshDoc();
    migrate(doc);
    let seq = 0;
    const subs = [];
    const undoStack = [], redoStack = [];

    const fail = (code, msg) => ({ ok: false, error: code, msg: msg || code });

    /* ---------- read accessors ---------- */
    const rooms = () => doc.order.map(id => doc.rooms[id]);
    const roomById = id => doc.rooms[id] || null;
    const spawnRoomId = () => doc.meta.spawnRoomId;

    function eachRectWorld(ignoreId, fn) {
      for (const id of doc.order) {
        if (id === ignoreId) continue;
        const rm = doc.rooms[id];
        for (const r of rm.rects) fn(id, rm, r);
      }
    }

    function roomAt(tx, ty) {
      for (const id of doc.order) {
        const rm = doc.rooms[id];
        for (const r of rm.rects) if (inRect(r, tx, ty)) return id;
      }
      return null;
    }

    /* ---------- props (furniture) ---------- */
    const props = () => doc.props;
    const propById = id => doc.props.find(p => p.id === id) || null;
    const propFootprint = p => ({ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 });
    // topmost prop occupying a tile (last in array = drawn last = on top)
    function propAt(tx, ty) {
      for (let i = doc.props.length - 1; i >= 0; i--) {
        const p = doc.props[i];
        if (inRect(propFootprint(p), tx, ty)) return p.id;
      }
      return null;
    }

    /* ---------- belts (conveyor) ----------
       A keyed graph "x,y"->dir (E|W|N|S). Belts are walkable floor machinery; boxes ride above
       them (the conveyor runtime lives in conveyor.js — the model only owns topology). */
    const DIRS = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
    const beltKey = (x, y) => (x | 0) + ',' + (y | 0);
    const beltAt = (x, y) => doc.belts[beltKey(x, y)] || null;
    const belts = () => Object.keys(doc.belts).map(k => { const p = k.split(','); return { x: +p[0], y: +p[1], dir: doc.belts[k] }; });

    function bounds() {
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      eachRectWorld(null, (id, rm, r) => {
        if (r.x1 < mnx) mnx = r.x1; if (r.y1 < mny) mny = r.y1;
        if (r.x2 > mxx) mxx = r.x2; if (r.y2 > mxy) mxy = r.y2;
      });
      if (mnx === Infinity) { mnx = mny = 0; mxx = mxy = 0; }
      return { minTx: mnx, minTy: mny, maxTx: mxx, maxTy: mxy };
    }

    /* ---------- layered validation (returns {ok} | {ok:false, error, msg}) ---------- */
    function checkRects(rects, kind, ignoreId) {
      const isCor = kind === 'corridor';
      for (const r of rects) {
        const w = rectW(r), h = rectH(r);
        if (isCor) {
          if (Math.min(w, h) < 1) return fail('TOO_SMALL', 'hallway needs width');
          if (Math.max(w, h) < MIN_HALL) return fail('TOO_SHORT', 'hallway too short');
        } else {
          if (w < MIN_ROOM || h < MIN_ROOM) return fail('TOO_SMALL', 'room min ' + MIN_ROOM + '×' + MIN_ROOM);
        }
      }
      // candidate rects must not overlap EACH OTHER (multi-rect / L-shaped footprints)
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++)
        if (rectsHit(rects[i], rects[j])) return fail('OVERLAP', 'self-overlapping footprint');
      // the whole footprint can't sprawl past a sane span — a room placed thousands of tiles
      // away would balloon the bake canvas to gigabytes. Reject early so the ghost tints red.
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      const acc = r => { if (r.x1 < mnx) mnx = r.x1; if (r.y1 < mny) mny = r.y1; if (r.x2 > mxx) mxx = r.x2; if (r.y2 > mxy) mxy = r.y2; };
      eachRectWorld(ignoreId, (id, rm, r) => acc(r));
      for (const r of rects) acc(r);
      if (mxx - mnx + 1 > MAX_SPAN || mxy - mny + 1 > MAX_SPAN) return fail('TOO_FAR', 'too far from the station');
      let hitName = null;
      eachRectWorld(ignoreId, (id, rm, r) => {
        if (hitName) return;
        for (const nr of rects) if (rectsHit(nr, r)) { hitName = rm.name || id; return; }
      });
      if (hitName) return fail('OVERLAP', 'overlaps ' + hitName);
      return { ok: true };
    }

    const canPlaceRoom = (rects, kind, ignoreId) =>
      checkRects((rects || []).map(normRect), kind || 'hab', ignoreId);
    const canPlaceHallway = (rects, ignoreId) =>
      checkRects((rects || []).map(normRect), 'corridor', ignoreId);

    /* ---------- history (snapshot-based — small docs, correct by construction) ---------- */
    const snap = () => clone({ rooms: doc.rooms, order: doc.order, meta: doc.meta, _nid: doc._nid, props: doc.props, belts: doc.belts, edges: doc.edges });
    function snapshot() { undoStack.push(snap()); if (undoStack.length > 120) undoStack.shift(); redoStack.length = 0; }
    function restore(s) { doc.rooms = s.rooms; doc.order = s.order; doc.meta = s.meta; doc._nid = s._nid; doc.props = s.props || []; doc.belts = s.belts || {}; doc.edges = s.edges || []; }
    function emit(dirtyRects) {
      seq++;
      const patch = { seq, dirtyRects: dirtyRects || [] };
      subs.forEach(fn => { try { fn(patch); } catch (e) { /* a listener must never break a mutation */ } });
      return patch;
    }

    /* ---------- mutations ---------- */
    function addRoom(opts) {
      const kind = ROOM_KINDS[opts.kind] ? opts.kind : 'hab';
      const rects = (opts.rects || (opts.rect ? [opts.rect] : [])).map(normRect);
      if (!rects.length) return fail('NO_RECT', 'nothing to place');
      const v = checkRects(rects, kind);
      if (!v.ok) return v;
      snapshot();
      const id = 'r' + (doc._nid++);
      const floorStyle = FLOOR_STYLES[opts.floorStyle] ? opts.floorStyle : ROOM_KINDS[kind].floor;
      // null = "inherit the kind default" — never write the default out, so a room built today
      // and a room built before the material axis existed serialize (and render) identically.
      const floorMat = FLOOR_MATERIALS[opts.floorMat] ? opts.floorMat : null;
      const label = ROOM_KINDS[kind].label;
      doc.rooms[id] = {
        id, kind, name: opts.name || (label + '-' + pad2(doc._nid - 1)),
        rects, floorStyle, floorMat, wallStyle: null, wallMat: null, tier: 0, floorPaint: {}
      };
      doc.order.push(id);
      if (!doc.meta.spawnRoomId && kind !== 'corridor') doc.meta.spawnRoomId = id;
      emit(rects);
      return { ok: true, id };
    }

    const placeHallway = opts => addRoom(Object.assign({}, opts, { kind: 'corridor' }));

    function removeRoom(id) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      if (id === doc.meta.spawnRoomId) return fail('SPAWN_ROOM', 'can’t reclaim the spawn room');
      snapshot();
      const dirty = rm.rects.slice();
      delete doc.rooms[id];
      doc.order = doc.order.filter(x => x !== id);
      emit(dirty);
      return { ok: true };
    }

    function moveRoom(id, dTx, dTy) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      if (!dTx && !dTy) return { ok: true };
      const moved = rm.rects.map(r => ({ x1: r.x1 + dTx, y1: r.y1 + dTy, x2: r.x2 + dTx, y2: r.y2 + dTy }));
      const v = checkRects(moved, rm.kind, id);
      if (!v.ok) return v;
      snapshot();
      const before = rm.rects.slice();
      rm.rects = moved;
      if (rm.floorPaint && Object.keys(rm.floorPaint).length) {
        const np = {};
        for (const k in rm.floorPaint) { const p = k.split(',').map(Number); np[(p[0] + dTx) + ',' + (p[1] + dTy)] = rm.floorPaint[k]; }
        rm.floorPaint = np;
      }
      emit(before.concat(moved));
      return { ok: true };
    }

    function setFloor(id, styleId) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      if (!FLOOR_STYLES[styleId]) return fail('BAD_STYLE', 'unknown floor');
      if (rm.floorStyle === styleId && !Object.keys(rm.floorPaint || {}).length) return { ok: true };
      snapshot();
      rm.floorStyle = styleId;
      rm.floorPaint = {};   // a whole-room repaint clears per-tile overrides
      emit(rm.rects.slice());
      return { ok: true };
    }

    /* the MATERIAL axis. Picking the room-kind's own default normalizes back to null so the
       serialized doc never carries a redundant value (and an old save round-trips unchanged). */
    function setMaterial(id, matId) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      if (!FLOOR_MATERIALS[matId]) return fail('BAD_MAT', 'unknown deck material');
      const kindMat = (ROOM_KINDS[rm.kind] && ROOM_KINDS[rm.kind].mat) || 'plate';
      const next = matId === kindMat ? null : matId;
      if ((rm.floorMat || null) === next) return { ok: true };   // no-op: don't burn an undo slot
      snapshot();
      rm.floorMat = next;
      emit(rm.rects.slice());
      return { ok: true };
    }

    /* lay a whole deck — hue AND material — in ONE undo slot. This is what the REFIT SURFACE tool
       commits on a room click, so "undo" reverses the deck the Commander saw laid, not half of it.
       Either field may be omitted to leave that axis alone. */
    function setDeck(id, opts) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      const o = opts || {};
      const styleId = o.style == null ? null : o.style;
      const matId = o.mat == null ? null : o.mat;
      if (styleId != null && !FLOOR_STYLES[styleId]) return fail('BAD_STYLE', 'unknown floor');
      if (matId != null && !FLOOR_MATERIALS[matId]) return fail('BAD_MAT', 'unknown deck material');
      const kindMat = (ROOM_KINDS[rm.kind] && ROOM_KINDS[rm.kind].mat) || 'plate';
      const nextMat = matId == null ? (rm.floorMat || null) : (matId === kindMat ? null : matId);
      // a whole-room repaint also clears per-tile overrides, so having any is itself a change
      const styleChanges = styleId != null && (rm.floorStyle !== styleId || !!Object.keys(rm.floorPaint || {}).length);
      const matChanges = (rm.floorMat || null) !== nextMat;
      if (!styleChanges && !matChanges) return { ok: true };
      snapshot();
      if (styleId != null) { rm.floorStyle = styleId; rm.floorPaint = {}; }
      rm.floorMat = nextMat;
      emit(rm.rects.slice());
      return { ok: true };
    }

    /* WALLS — the deck's opposite number, same shape: hue AND material in ONE undo slot. A null
       style means "follow the floor hue", so clearing back to the default is expressible
       (`{style: null}` is "leave alone"; pass `{style: 'follow'}` to reset it). */
    function setWalls(id, opts) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      const o = opts || {};
      const wantStyle = o.style === 'follow' ? null : (o.style == null ? undefined : o.style);
      const wantMat = o.mat == null ? undefined : o.mat;
      if (wantStyle !== undefined && wantStyle !== null && !FLOOR_STYLES[wantStyle]) return fail('BAD_STYLE', 'unknown wall colour');
      if (wantMat !== undefined && !WALL_MATERIALS[wantMat]) return fail('BAD_MAT', 'unknown wall material');
      // picking the room's own floor hue IS "follow" — normalize so it never serializes redundantly
      const nextStyle = wantStyle === undefined ? (rm.wallStyle || null)
        : (wantStyle === rm.floorStyle ? null : wantStyle);
      const nextMat = wantMat === undefined ? (rm.wallMat || null) : (wantMat === 'plating' ? null : wantMat);
      if ((rm.wallStyle || null) === nextStyle && (rm.wallMat || null) === nextMat) return { ok: true };
      snapshot();
      rm.wallStyle = nextStyle;
      rm.wallMat = nextMat;
      emit(rm.rects.slice());
      return { ok: true };
    }

    function paintTiles(id, tiles, styleId) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      if (!FLOOR_STYLES[styleId]) return fail('BAD_STYLE', 'unknown floor');
      rm.floorPaint = rm.floorPaint || {};
      const writes = [];
      for (const t of tiles) {
        const k = t[0] + ',' + t[1];
        if (roomAt(t[0], t[1]) === id && rm.floorPaint[k] !== styleId) writes.push(k);
      }
      if (!writes.length) return { ok: true };   // a no-op must not consume an undo slot
      snapshot();
      for (const k of writes) rm.floorPaint[k] = styleId;
      emit(rm.rects.slice());
      return { ok: true };
    }

    /* ---------- prop validation + mutations ----------
       The model stays pure: it doesn't know the prop CATALOG (that lives in propsprites.js).
       The caller supplies w,h (the footprint) from the catalog; the model only validates
       GEOMETRY — every footprint tile must sit on station floor (inside a zone), the footprint
       must not overlap another prop, and the type tag must be a non-empty string.

       MOUNT RULES (2026-07-26) are the one exception, and they are injected rather than imported so
       the layering holds: setPropRules() hands the model a lookup from prop type to
       {mount, stack, surface}. With no lookup installed (plain node tests, older callers) nothing
       changes and every prop is placeable on bare deck exactly as before.

       The mount axis has THREE states, and a prop's catalog row picks one:
         mount 'surface' — REQUIRES a table. The footprint must lie wholly on ONE prop whose catalog
                           row says surface:true, and that host is exempt from the overlap check,
                           because standing on a table is the entire point.
         stack:true      — MAY use a table. Same host rule when one is found; otherwise it places on
                           bare deck like any other prop. (2026-07-29: without this state the only
                           two props in the whole catalog that could go on a table were the two that
                           were FORCED to, so every other small object — a mug, a plant, a stack of
                           printouts — was rejected with OVERLAP the moment a table was under it.
                           A required-mount flag cannot express "a plant belongs on the floor OR on
                           a table", and forcing plant/coffee onto tables would have broken the
                           agents that place their own decor on open deck.)
         neither         — deck only; a table is an obstacle like any other prop.

       There was briefly a mount 'wall' rule too (hang a prop on the face the bake raises along a
       room's north edge). Andrew rejected the look outright and every wall-only prop was retired with
       it, so the rule is gone rather than left dormant: a placement constraint with no props subject
       to it is dead code that still has to be reasoned about on every read of this function. */
    const ruleOf = (t) => (propRules && t) ? (propRules(t) || {}) : {};
    // the single surface prop wholly covering `foot`, or null
    function surfaceHostFor(foot, ignoreId) {
      for (let i = doc.props.length - 1; i >= 0; i--) {
        const p = doc.props[i];
        if (p.id === ignoreId) continue;
        if (!ruleOf(p.t).surface) continue;
        const f = propFootprint(p);
        if (foot.x1 >= f.x1 && foot.x2 <= f.x2 && foot.y1 >= f.y1 && foot.y2 <= f.y2) return p;
      }
      return null;
    }
    function checkProp(foot, ignoreId, type) {
      if (foot.x2 < foot.x1 || foot.y2 < foot.y1) return fail('NO_RECT', 'nothing to place');
      for (let y = foot.y1; y <= foot.y2; y++) for (let x = foot.x1; x <= foot.x2; x++) {
        if (!roomAt(x, y)) return fail('OFF_DECK', 'must sit on a deck');
      }
      const rule = ruleOf(type);
      let host = null;
      if (rule.mount === 'surface') {
        host = surfaceHostFor(foot, ignoreId);
        if (!host) return fail('NEEDS_SURFACE', 'must stand on a table');
      } else if (rule.stack) {
        host = surfaceHostFor(foot, ignoreId);   // optional: on a table if there is one, else plain deck
      }
      for (const p of doc.props) {
        if (p.id === ignoreId) continue;
        if (host && p.id === host.id) continue;             // its own table is not an obstacle
        if (rectsHit(foot, propFootprint(p))) return fail('OVERLAP', 'overlaps a prop');
      }
      return { ok: true, host: host ? host.id : null };
    }
    const canPlaceProp = (t, x, y, w, h, ignoreId) =>
      checkProp({ x1: x, y1: y, x2: x + (w || 1) - 1, y2: y + (h || 1) - 1 }, ignoreId, t);

    function addProp(opts) {
      const t = String(opts.t || '').trim();
      if (!t) return fail('NO_TYPE', 'no prop type');
      const w = Math.max(1, opts.w | 0 || 1), h = Math.max(1, opts.h | 0 || 1);
      const x = opts.x | 0, y = opts.y | 0;
      const v = checkProp({ x1: x, y1: y, x2: x + w - 1, y2: y + h - 1 }, null, t);
      if (!v.ok) return v;
      snapshot();
      const id = 'p' + (doc._nid++);
      // block defaults true; the caller (builder) passes the catalog's blocks flag. Wall murals /
      // floor rugs pass block:false so agents walk over/along them (they're flat decor, not obstacles).
      const prop = { id, t, x, y, w, h };
      if (opts.block === false) prop.block = false;
      if (typeof opts.agentId === 'string' && opts.agentId) prop.agentId = opts.agentId;   // a BAY binds a belt endpoint to an agent
      applyJunctionCfg(prop, opts);   // a FILTER/MERGER carries its routes/def/bufferSize (inert on other props)
      if (cleanDoor(opts.door)) prop.door = opts.door;   // an AIRLOCK carries its seal state (inert on other props)
      doc.props.push(prop);
      emit([{ x1: x, y1: y, x2: x + w - 1, y2: y + h - 1 }]);
      return { ok: true, id };
    }

    function removeProp(id) {
      const i = doc.props.findIndex(p => p.id === id);
      if (i < 0) return fail('NOT_FOUND', 'no such prop');
      snapshot();
      const p = doc.props[i];
      doc.props.splice(i, 1);
      emit([propFootprint(p)]);
      return { ok: true };
    }

    function moveProp(id, dTx, dTy) {
      const p = propById(id);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      if (!dTx && !dTy) return { ok: true };
      const nx = p.x + dTx, ny = p.y + dTy;
      const v = checkProp({ x1: nx, y1: ny, x2: nx + p.w - 1, y2: ny + p.h - 1 }, id, p.t);
      if (!v.ok) return v;
      snapshot();
      const before = propFootprint(p);
      p.x = nx; p.y = ny;
      emit([before, propFootprint(p)]);
      return { ok: true };
    }

    /* ---------- belt mutations ----------
       A belt tile must sit on a deck and not on a blocking prop. Belts are 1×1, keyed by tile;
       setBelt overwrites the direction in place (re-laying over a belt just re-aims it). */
    function beltPlaceable(x, y) {
      if (!roomAt(x, y)) return fail('OFF_DECK', 'belts must sit on a deck');
      const pid = propAt(x, y);
      if (pid) { const p = propById(pid); if (p && p.block !== false) return fail('ON_PROP', 'a prop is in the way'); }
      return { ok: true };
    }
    function setBelt(x, y, dir) {
      x |= 0; y |= 0;
      if (!DIRS[dir]) return fail('BAD_DIR', 'bad belt direction');
      const v = beltPlaceable(x, y); if (!v.ok) return v;
      if (doc.belts[beltKey(x, y)] === dir) return { ok: true };   // no-op: don't burn an undo slot
      snapshot();
      doc.belts[beltKey(x, y)] = dir;
      emit([{ x1: x, y1: y, x2: x, y2: y }]);
      return { ok: true };
    }
    function removeBelt(x, y) {
      const k = beltKey(x, y);
      if (!doc.belts[k]) return fail('NOT_FOUND', 'no belt here');
      snapshot();
      delete doc.belts[k];
      emit([{ x1: x | 0, y1: y | 0, x2: x | 0, y2: y | 0 }]);
      return { ok: true };
    }
    // batch-remove a set of belt tiles in ONE undo slot (a RECLAIM drag clearing a whole run —
    // mirrors placeBeltRun's single-snapshot shape so one UNDO restores the lot). Tiles with no belt
    // are silently skipped; an all-empty request is a no-op fail so the caller can flag "no belts".
    function removeBelts(tiles) {
      const hit = (tiles || []).map(t => [t[0] | 0, t[1] | 0]).filter(([x, y]) => doc.belts[beltKey(x, y)]);
      if (!hit.length) return fail('NOT_FOUND', 'no belts here');
      snapshot();
      const dirty = [];
      for (const [x, y] of hit) { delete doc.belts[beltKey(x, y)]; dirty.push({ x1: x, y1: y, x2: x, y2: y }); }
      emit(dirty);
      return { ok: true, count: hit.length };
    }
    // lay a straight run a→b; direction = the dominant drag axis (drag east → E belts, etc.)
    function placeBeltRun(a, b) {
      const ax = a.tx | 0, ay = a.ty | 0, bx = b.tx | 0, by = b.ty | 0;
      const dx = bx - ax, dy = by - ay;
      const horiz = Math.abs(dx) >= Math.abs(dy);
      const dir = horiz ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
      const tiles = [];
      if (horiz) { const s = dx >= 0 ? 1 : -1; for (let x = ax; x !== bx + s; x += s) tiles.push([x, ay]); }
      else { const s = dy >= 0 ? 1 : -1; for (let y = ay; y !== by + s; y += s) tiles.push([ax, y]); }
      // validate every tile first so a run is all-or-nothing (the ghost already tinted it)
      for (const [x, y] of tiles) { const v = beltPlaceable(x, y); if (!v.ok) return v; }
      const dirty = [];
      let changed = false;
      // single snapshot for the whole run
      const prev = clone(doc.belts);
      for (const [x, y] of tiles) { const k = beltKey(x, y); if (doc.belts[k] !== dir) changed = true; doc.belts[k] = dir; dirty.push({ x1: x, y1: y, x2: x, y2: y }); }
      if (!changed) { doc.belts = prev; return { ok: true }; }
      doc.belts = prev; snapshot();                                  // snapshot the pre-run state
      for (const [x, y] of tiles) doc.belts[beltKey(x, y)] = dir;
      emit(dirty);
      return { ok: true, dir, count: tiles.length };
    }
    const canPlaceBeltRun = (a, b) => {
      const ax = a.tx | 0, ay = a.ty | 0, bx = b.tx | 0, by = b.ty | 0;
      const horiz = Math.abs(bx - ax) >= Math.abs(by - ay);
      const tiles = [];
      if (horiz) { const s = bx >= ax ? 1 : -1; for (let x = ax; x !== bx + s; x += s) tiles.push([x, ay]); }
      else { const s = by >= ay ? 1 : -1; for (let y = ay; y !== by + s; y += s) tiles.push([ax, y]); }
      for (const [x, y] of tiles) { const v = beltPlaceable(x, y); if (!v.ok) return v; }
      return { ok: true };
    };

    /* ---------- CONNECT MODE (2026-07-05 UX reshape): connect MACHINES, not tiles ----------
       connectBelt(fromId, toId) lays a correctly-oriented belt path between two workflow props
       automatically: BFS over deck tiles (never through blocking props, never under ANY prop, never
       trampling an existing lane), flow from → to, the final tile aimed INTO the target's footprint so
       the crate visibly sinks at the dock. A junction that already sits ON a line starts its branch from
       a free neighbor (the out-lane forms naturally). All-or-nothing, one undo slot. This is what makes
       the tile-perfect wiring rules (ring adjacency, junction-on-line, direction) unlearnable-by-necessity:
       the user clicks INBOX then BAY, and the path knows the rules for them. */
    const CONNECTABLE = { intake: 1, bay: 1, outbox: 1, filter: 1, splitter: 1, merger: 1 };
    function connectBelt(fromId, toId) {
      const A = doc.props.find(p => p.id === fromId), B = doc.props.find(p => p.id === toId);
      if (!A || !B) return fail('NOT_FOUND', 'no such prop');
      if (A.id === B.id) return fail('SAME_PROP', 'pick two different machines');
      if (!CONNECTABLE[A.t] || !CONNECTABLE[B.t]) return fail('NOT_CONNECTABLE', 'connect workflow machines (INBOX/BAY/OUTBOX/junctions)');
      const inFoot = (p, x, y) => x >= p.x && x < p.x + (p.w || 1) && y >= p.y && y < p.y + (p.h || 1);
      // a path tile: on deck, not an existing belt, not under ANY prop (docks hook via ring adjacency)
      const pathable = (x, y) => !doc.belts[beltKey(x, y)] && !propAt(x, y) && !!roomAt(x, y);
      // the 1-tile ring around a footprint (the expanded rect minus the footprint) — matches beltTileNear's hookup scan
      const ring = p => {
        const out = [], w = p.w || 1, h = p.h || 1;
        for (let y = p.y - 1; y <= p.y + h; y++) for (let x = p.x - 1; x <= p.x + w; x++)
          if (!inFoot(p, x, y)) out.push({ x, y });
        return out;
      };
      // START set: a junction already ON a line branches from a free 4-neighbor of its own tile;
      // anything else starts from a pathable ring tile.
      const starts = [];
      if (doc.belts[beltKey(A.x, A.y)]) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = A.x + dx, y = A.y + dy; if (pathable(x, y)) starts.push({ x, y }); }
      } else {
        for (const t of ring(A)) if (pathable(t.x, t.y)) starts.push(t);
      }
      if (!starts.length) return fail('FROM_BLOCKED', 'no free tile beside the start machine');
      // GOAL set: pathable ring tiles of B — EDGE tiles preferred over corners, so the lane's last tile
      // can aim straight INTO the footprint and the crate visibly sinks at the dock (a corner end works
      // but sinks diagonally beside it; corners are the fallback when every edge is taken)
      const goalEdge = new Set(), goalCorner = new Set();
      for (const t of ring(B)) {
        if (!pathable(t.x, t.y)) continue;
        const corner = (t.x < B.x || t.x >= B.x + (B.w || 1)) && (t.y < B.y || t.y >= B.y + (B.h || 1));
        (corner ? goalCorner : goalEdge).add(t.x + ',' + t.y);
      }
      const goals = goalEdge.size ? goalEdge : goalCorner;
      if (!goals.size) return fail('TO_BLOCKED', 'no free tile beside the destination');
      // BFS, multi-source → any goal (shortest orthogonal path; deterministic neighbor order)
      const prev = new Map(), q = [];
      for (const s of starts) { const k = s.x + ',' + s.y; if (!prev.has(k)) { prev.set(k, null); q.push(s); } }
      let hit = null, head = 0;
      while (head < q.length && !hit) {
        const t = q[head++];
        const tk = t.x + ',' + t.y;
        if (goals.has(tk)) { hit = t; break; }
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const x = t.x + dx, y = t.y + dy, k = x + ',' + y;
          if (prev.has(k) || !pathable(x, y)) continue;
          prev.set(k, tk); q.push({ x, y });
        }
        if (q.length > 4096) return fail('NO_PATH', 'no route found (path too long)');
      }
      if (!hit) return fail('NO_PATH', 'no clear route between these machines');
      // rebuild the path start→goal
      const path = [];
      let ck = hit.x + ',' + hit.y;
      while (ck) { const pp = ck.split(','); path.unshift({ x: +pp[0], y: +pp[1] }); ck = prev.get(ck); }
      // orient each tile at the next; the LAST tile aims into B's footprint (open-end sink at the dock)
      const dirTo = (a, b) => (b.x > a.x ? 'E' : b.x < a.x ? 'W' : b.y > a.y ? 'S' : 'N');
      const dirs = [];
      for (let i = 0; i < path.length - 1; i++) dirs.push(dirTo(path[i], path[i + 1]));
      const last = path[path.length - 1];
      let endDir = null;
      for (const [dx, dy, d] of [[1, 0, 'E'], [-1, 0, 'W'], [0, 1, 'S'], [0, -1, 'N']]) if (inFoot(B, last.x + dx, last.y + dy)) { endDir = d; break; }
      dirs.push(endDir || (dirs.length ? dirs[dirs.length - 1] : 'E'));
      snapshot();   // one undo slot for the whole connection
      const dirty = [];
      for (let i = 0; i < path.length; i++) { doc.belts[beltKey(path[i].x, path[i].y)] = dirs[i]; dirty.push({ x1: path[i].x, y1: path[i].y, x2: path[i].x, y2: path[i].y }); }
      emit(dirty);
      return { ok: true, count: path.length, from: A.t, to: B.t };
    }

    function renameRoom(id, name) {
      const rm = doc.rooms[id];
      if (!rm) return fail('NOT_FOUND', 'no such room');
      const nm = String(name || '').slice(0, 24) || rm.name;
      if (nm === rm.name) return { ok: true };   // no-op: don't burn an undo slot / wipe redo
      snapshot();
      rm.name = nm;
      emit([]);
      return { ok: true };
    }

    function undo() {
      if (!undoStack.length) return fail('NOTHING', 'nothing to undo');
      redoStack.push(snap());
      restore(undoStack.pop());
      emit([]);   // empty dirty = full re-bake
      return { ok: true };
    }
    function redo() {
      if (!redoStack.length) return fail('NOTHING', 'nothing to redo');
      undoStack.push(snap());
      restore(redoStack.pop());
      emit([]);
      return { ok: true };
    }
    const canUndo = () => undoStack.length > 0;
    const canRedo = () => redoStack.length > 0;

    /* ---------- projection → the v7 MAP-shaped geometry the bake consumes ---------- */
    function projectGeometry() {
      const b = bounds();
      const ox = b.minTx - MARGIN, oy = b.minTy - MARGIN;       // world → local offset
      const COLS = (b.maxTx - b.minTx) + 1 + MARGIN * 2;
      const ROWS = (b.maxTy - b.minTy) + 1 + MARGIN * 2;
      const idx = (x, y) => y * COLS + x;
      const zoneGrid = new Array(COLS * ROWS).fill(null);
      const zones = {};            // id → local bounding rect
      const allRects = [];         // [{z,x1,y1,x2,y2}] local
      const ROOM_IDS = [];
      const corridor = {};

      for (const id of doc.order) {
        const rm = doc.rooms[id];
        const isCor = rm.kind === 'corridor';
        if (isCor) corridor[id] = true; else ROOM_IDS.push(id);
        let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
        for (const r of rm.rects) {
          const lr = { z: id, x1: r.x1 - ox, y1: r.y1 - oy, x2: r.x2 - ox, y2: r.y2 - oy };
          allRects.push(lr);
          for (let y = lr.y1; y <= lr.y2; y++) for (let x = lr.x1; x <= lr.x2; x++) zoneGrid[idx(x, y)] = id;
          if (lr.x1 < bx1) bx1 = lr.x1; if (lr.y1 < by1) by1 = lr.y1;
          if (lr.x2 > bx2) bx2 = lr.x2; if (lr.y2 > by2) by2 = lr.y2;
        }
        zones[id] = { x1: bx1, y1: by1, x2: bx2, y2: by2 };
      }

      const isCorridor = z => corridor[z] === true;

      /* spatial room-seal: a room holding a SEALING airlock (closed|jammed) gets NO boundary doors
         below, so canStep can't cross its edge — the agent's BODY is sealed in, like an unmerged branch
         (floor containment only, not capability isolation). The
         trunk room (the integration hub) never seals, so the station can't be severed from its core. */
      const sealed = new Set();
      for (const p of doc.props) {
        if (p.t !== 'airlock' || !doorSeals(p.door)) continue;
        const rid = roomAt(p.x, p.y);
        if (rid && rid !== doc.meta.trunkRoomId) sealed.add(rid);
      }

      /* auto-doors: open a threshold wherever two different zones are orthogonally adjacent,
         so abutting rooms/corridors connect with no manual door tool (foundation default). A seam is
         skipped when either side's room is sealed — that absence is exactly what isolates the room. */
      const doorDefs = [];
      const doorSet = new Set();
      const addDoor = (x1, y1, x2, y2) => {
        const k = x1 + ',' + y1 + '>' + x2 + ',' + y2;
        if (doorSet.has(k)) return;
        doorDefs.push([x1, y1, x2, y2]);
        doorSet.add(k); doorSet.add(x2 + ',' + y2 + '>' + x1 + ',' + y1);
      };
      const linkable = (a, b) => b != null && b !== a && !sealed.has(a) && !sealed.has(b);
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        const z = zoneGrid[idx(x, y)];
        if (z == null) continue;
        if (x + 1 < COLS) { const nz = zoneGrid[idx(x + 1, y)]; if (linkable(z, nz)) addDoor(x, y, x + 1, y); }
        if (y + 1 < ROWS) { const nz = zoneGrid[idx(x, y + 1)]; if (linkable(z, nz)) addDoor(x, y, x, y + 1); }
      }

      const canStep = (x1, y1, x2, y2) => {
        if (x2 < 0 || y2 < 0 || x2 >= COLS || y2 >= ROWS) return false;
        const za = zoneGrid[idx(x1, y1)], zb = zoneGrid[idx(x2, y2)];
        if (zb == null) return false;
        if (za === zb) return true;
        return doorSet.has(x1 + ',' + y1 + '>' + x2 + ',' + y2);
      };

      /* chamfers: round the convex, void-exposed corners of ROOMS only (corridors stay slim).
         a corner is roundable when both of its orthogonal-outward neighbours are void. */
      const chamfers = [];
      const isVoid = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS) ? true : zoneGrid[idx(x, y)] == null;
      for (const id of doc.order) {
        const rm = doc.rooms[id];
        if (rm.kind === 'corridor') continue;
        for (const r of rm.rects) {
          const lx1 = r.x1 - ox, ly1 = r.y1 - oy, lx2 = r.x2 - ox, ly2 = r.y2 - oy;
          if (isVoid(lx1 - 1, ly1) && isVoid(lx1, ly1 - 1)) chamfers.push([lx1, ly1, 'tl']);
          if (isVoid(lx2 + 1, ly1) && isVoid(lx2, ly1 - 1)) chamfers.push([lx2, ly1, 'tr']);
          if (isVoid(lx1 - 1, ly2) && isVoid(lx1, ly2 + 1)) chamfers.push([lx1, ly2, 'bl']);
          if (isVoid(lx2 + 1, ly2) && isVoid(lx2, ly2 + 1)) chamfers.push([lx2, ly2, 'br']);
        }
      }

      const styleBase = sid => (FLOOR_STYLES[sid] || FLOOR_STYLES.hull).base;
      const baseColorOf = (id, lx, ly) => {
        const rm = doc.rooms[id];
        if (!rm) return styleBase('hull');
        const ov = rm.floorPaint && rm.floorPaint[(lx + ox) + ',' + (ly + oy)];
        return styleBase(ov || rm.floorStyle);
      };

      /* ---------- walkability + pathfinding (local tile frame; pure) ----------
         A tile is walkable if it belongs to a zone, isn't a rounded-corner (chamfer)
         tile, and isn't in the caller's `extra` blocked set (furniture/desks live in
         the renderer, not the model, so they're passed in per query). path() is a BFS
         that only crosses zone seams where canStep allows (same zone or a door). */
      const blockedTiles = new Set();
      for (const c of chamfers) blockedTiles.add(c[0] + ',' + c[1]);
      // props occupy their footprint: shift to the local frame, block walking, and emit for the
      // renderer. This is the seam the walkability contract promised — furniture lives here now.
      const propsLocal = [];
      for (const p of doc.props) {
        const lx = p.x - ox, ly = p.y - oy, w = p.w || 1, h = p.h || 1;
        const lp = { id: p.id, t: p.t, x: lx, y: ly, w, h, block: p.block !== false, agentId: p.agentId || null };
        if (p.routes) lp.routes = p.routes; if (p.def) lp.def = p.def; if (p.bufferSize) lp.bufferSize = p.bufferSize;   // junction config -> the bake/pipeline
        if (p.door) lp.door = p.door;   // an AIRLOCK's seal state -> the prop sprite's status light / jam spark
        if (p.connectorId) lp.connectorId = p.connectorId;   // a CONNECTOR PORTAL's bound server -> live state + firing pulse on the sprite
        propsLocal.push(lp);
        if (p.block === false) continue;   // flat decor (rugs / wall panels) never blocks walking
        for (let yy = ly; yy < ly + h; yy++) for (let xx = lx; xx < lx + w; xx++) blockedTiles.add(xx + ',' + yy);
      }
      // belts: shift into the local frame for the renderer/transport. Belts are WALKABLE — they
      // are never added to blockedTiles (floor machinery; boxes ride above, agents step across).
      const beltsLocal = [];
      for (const k in doc.belts) { const p = k.split(','); beltsLocal.push({ x: +p[0] - ox, y: +p[1] - oy, dir: doc.belts[k] }); }
      const walkable = (lx, ly, extra) => {
        if (lx < 0 || ly < 0 || lx >= COLS || ly >= ROWS) return false;
        if (zoneGrid[idx(lx, ly)] == null) return false;
        const k = lx + ',' + ly;
        return !blockedTiles.has(k) && !(extra && extra.has(k));
      };
      /* ---------- path smoothing (string-pulling) ----------
         path() is a 4-NEIGHBOUR BFS, so its raw output is a staircase of orthogonal tile hops: a body
         following it pivots 90° at nearly every tile and never once moves diagonally. We pull the string —
         from the current anchor, keep the FARTHEST later waypoint with clear line of sight and drop
         everything between — which collapses the staircase into long straight runs and true diagonals.
         losClear is deliberately conservative. It walks the segment one tile at a time; every touched tile
         must be walkable; every orthogonal hop must satisfy canStep (so a shortcut can NEVER skip a zone
         seam that a door is meant to gate); and an exact diagonal step demands BOTH corner tiles plus the
         canStep legality of both ways around — so a shortcut can't squeeze a body through the diagonal gap
         between two blockers. canStep is orthogonal-only, so it is never called on a diagonal pair. */
      function losClear(x0, y0, x1, y1, extra) {
        let x = x0, y = y0;
        let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        const xi = x1 > x0 ? 1 : -1, yi = y1 > y0 ? 1 : -1;
        let err = dx - dy;
        dx *= 2; dy *= 2;
        let guard = dx + dy + 4;   // the walk is bounded; never trust the loop to terminate on its own
        while ((x !== x1 || y !== y1) && guard-- > 0) {
          if (!walkable(x, y, extra)) return false;
          if (err > 0) {
            if (!walkable(x + xi, y, extra) || !canStep(x, y, x + xi, y)) return false;
            x += xi; err -= dy;
          } else if (err < 0) {
            if (!walkable(x, y + yi, extra) || !canStep(x, y, x, y + yi)) return false;
            y += yi; err += dx;
          } else {   // exact diagonal — both corners open, and legal whichever way round we go
            if (!walkable(x + xi, y, extra) || !walkable(x, y + yi, extra)) return false;
            if (!canStep(x, y, x + xi, y) || !canStep(x, y, x, y + yi)) return false;
            if (!canStep(x + xi, y, x + xi, y + yi) || !canStep(x, y + yi, x + xi, y + yi)) return false;
            x += xi; y += yi; err -= dy; err += dx;
          }
        }
        return guard > 0 && walkable(x1, y1, extra);
      }
      function smoothPath(pts, sx, sy, extra) {
        if (!pts || pts.length < 3) return pts;
        const out = [];
        let ax = sx, ay = sy, i = 0;
        while (i < pts.length) {
          let best = i;
          for (let j = pts.length - 1; j > i; j--) {
            if (losClear(ax, ay, pts[j].x, pts[j].y, extra)) { best = j; break; }
          }
          out.push(pts[best]);
          ax = pts[best].x; ay = pts[best].y;
          i = best + 1;
        }
        return out;
      }
      function path(sx, sy, tx, ty, extra) {
        if (!walkable(tx, ty, extra)) return null;
        if (sx === tx && sy === ty) return [];
        const prev = new Int32Array(COLS * ROWS).fill(-1);
        const start = idx(sx, sy), target = idx(tx, ty);
        prev[start] = start;
        const q = [start]; let head = 0;
        while (head < q.length) {
          const cur = q[head++];
          if (cur === target) break;
          const cx = cur % COLS, cy = (cur / COLS) | 0;
          for (let d = 0; d < 4; d++) {
            const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
            if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
            const ni = idx(nx, ny);
            if (prev[ni] !== -1 || !walkable(nx, ny, extra) || !canStep(cx, cy, nx, ny)) continue;
            prev[ni] = cur; q.push(ni);
          }
        }
        if (prev[target] === -1) return null;
        const out = []; let cur = target;
        while (cur !== start) { out.push({ x: cur % COLS, y: (cur / COLS) | 0 }); cur = prev[cur]; }
        out.reverse();
        return smoothPath(out, sx, sy, extra);   // collapse the BFS staircase into straight runs + diagonals
      }

      return {
        TILE, COLS, ROWS, W: COLS * TILE, H: ROWS * TILE + HULL_PAD,
        origin: { tx: ox, ty: oy },
        allRects, zones, ROOM_IDS, isCorridor, chamfers, windows: [], props: propsLocal, belts: beltsLocal,
        doorDefs, zoneGrid, idx, canStep, baseColorOf, walkable, path, blockedTiles,
        nameOf: id => (doc.rooms[id] ? doc.rooms[id].name : ''),
        kindOf: id => (doc.rooms[id] ? doc.rooms[id].kind : null),
        matOf: id => matOfRoom(doc.rooms[id]),   // effective deck material (override, else kind default)
        // walls: effective material, and the base colour to derive the wall palette from (a room's
        // own wall hue when set, else its floor hue — so walls harmonize with the deck by default)
        wallMatOf: id => wallMatOfRoom(doc.rooms[id]),
        wallBaseOf: id => styleBase(wallStyleOfRoom(doc.rooms[id])),
        FLOOR_STYLES, FLOOR_MATERIALS, WALL_MATERIALS
      };
    }

    /* ---------- agent-bay binding (Phase B: a belt endpoint named for an agent) ---------- */
    function assignPropAgent(propId, agentId) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      const aid = String(agentId || '').trim();
      if (aid && !AID_RE.test(aid)) return fail('BAD_AGENT', 'agentId must match ' + AID_RE);
      snapshot();
      if (aid) p.agentId = aid; else delete p.agentId;   // empty string unbinds
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, agentId: aid || null };
    }
    // cycle an AIRLOCK's door state (open|closed|jammed) — the room-seal (merge/staging) handle. Mirrors
    // assignPropAgent. 'open' clears the field (= default) so docs stay clean. A full re-bake (emit []) is
    // used because sealing flips the room's whole wall/threshold boundary, not just the prop's footprint.
    function setDoorState(propId, state) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      const s = cleanDoor(state);
      if (!s) return fail('BAD_STATE', 'door state must be open|closed|jammed');
      snapshot();
      if (s === 'open') delete p.door; else p.door = s;
      emit([]);
      return { ok: true, id: propId, door: p.door || 'open' };
    }
    // set/replace a FILTER's routes+def or a MERGER's bufferSize (cfg null/empty clears). Mirrors assignPropAgent.
    function configureJunction(propId, cfg) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      snapshot();
      delete p.routes; delete p.def; delete p.bufferSize;   // replace wholesale
      if (cfg) applyJunctionCfg(p, cfg);
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, routes: p.routes || null, def: p.def || null, bufferSize: p.bufferSize || null };
    }
    // bind/clear the connectorId on a CONNECTOR PORTAL — WHICH MCP server this gateway grants (per-instance).
    // A blank id unbinds (the portal grants nothing until bound; bayObjects emits it only when bound). Mirrors
    // assignPropAgent's shape; the live state/tools come from the sidecar connector manager keyed by this id.
    function bindConnector(propId, connectorId) {
      const p = doc.props.find(q => q.id === propId);
      if (!p) return fail('NOT_FOUND', 'no such prop');
      snapshot();
      const id = (connectorId == null ? '' : String(connectorId)).trim();
      if (id) p.connectorId = id; else delete p.connectorId;
      emit([{ x1: p.x, y1: p.y, x2: p.x + (p.w || 1) - 1, y2: p.y + (p.h || 1) - 1 }]);
      return { ok: true, id: propId, connectorId: p.connectorId || null };
    }
    const propsByType = t => doc.props.filter(p => p.t === t).map(clone);
    const propsByAgent = agentId => doc.props.filter(p => p.agentId === agentId).map(clone);
    const pipelineEdges = () => clone(doc.edges || []);
    function setPipelineEdges(edges) {
      const clean = [];
      const seen = {};
      for (const e of (Array.isArray(edges) ? edges : [])) {
        const ce = cleanPipelineEdge(e);
        if (!ce) continue;
        const k = ce.from + '>' + ce.to + ':' + ce.whenKind + ':' + (ce.lane || '');
        if (seen[k]) continue;
        seen[k] = true; clean.push(ce);
      }
      if (JSON.stringify(clean) === JSON.stringify(doc.edges || [])) return { ok: true, count: clean.length };
      snapshot();
      doc.edges = clean;
      emit([]);
      return { ok: true, count: clean.length };
    }
    function addPipelineEdge(edge) {
      const ce = cleanPipelineEdge(edge);
      if (!ce) return fail('BAD_EDGE', 'edge must be {from,to,whenKind,lane?}');
      return setPipelineEdges((doc.edges || []).concat([ce]));
    }
    function removePipelineEdge(edge) {
      const ce = cleanPipelineEdge(edge);
      if (!ce) return fail('BAD_EDGE', 'edge must be {from,to,whenKind,lane?}');
      const before = doc.edges || [];
      const next = before.filter(e => !(e.from === ce.from && e.to === ce.to && e.whenKind === ce.whenKind && (e.lane || '') === (ce.lane || '')));
      if (next.length === before.length) return fail('NOT_FOUND', 'no such edge');
      snapshot();
      doc.edges = next;
      emit([]);
      return { ok: true, count: next.length };
    }
    function agentRoomId(agentId) {   // the room the agent's BAY sits in — the capability-isolation seam
      const bay = doc.props.find(p => p.t === 'bay' && p.agentId === agentId);
      return bay ? roomAt(bay.x, bay.y) : null;
    }
    // Phase B5: the capability objectTypes (CAP_REGISTRY) granted by the cap-props sharing the agent's BAY room —
    // exactly what the sidecar feeds resolveTools, so each bay's tools are what you placed in its room. Deduped.
    // PER-AGENT PC (the true rule): COMPUTE is granted by a computer prop DEDICATED to this agent — one BOUND to
    // it (agentId match), or (back-compat) an UNBOUND computer when the room holds a single bound bay. So a SHARED
    // room (3-4 agents passing work) demands a distinct PC per agent, while a solo room still runs unbound. Every
    // OTHER cap (cabinet/dish/notebook/connector) stays room-based — a shared room's files/web/memory are shared.
    function bayObjects(agentId) {
      const bay = doc.props.find(p => p.t === 'bay' && p.agentId === agentId);
      const room = bay ? roomAt(bay.x, bay.y) : null;
      if (!room) return [];
      const boundBays = doc.props.filter(p => p.t === 'bay' && p.agentId && roomAt(p.x, p.y) === room).length;
      const soloRoom = boundBays <= 1;   // one bay in the room -> an unbound PC is unambiguously this agent's
      const seen = {}, out = [];
      for (const p of doc.props) {
        const cap = CAP_PROP_MAP[p.t];
        if (!cap) continue;
        if (roomAt(p.x, p.y) !== room) continue;
        if (cap === 'computer') {
          if (!(p.agentId === agentId || (!p.agentId && soloRoom))) continue;   // not THIS agent's dedicated PC
          if (seen.computer) continue;
          seen.computer = true; out.push('computer');
          continue;
        }
        if (cap === 'connector') {
          // per-instance, NOT deduped: each BOUND connector portal grants its OWN server's tools. The sidecar
          // reads { objectType, connectorId } (router.stationFor passes the object through; resolveTools yields
          // no static grant — the MCP tools are projected dynamically by the connector manager). An UNBOUND
          // portal (no connectorId) grants nothing until the Commander binds it.
          if (p.connectorId) out.push({ objectType: 'connector', connectorId: p.connectorId });
          continue;
        }
        if (seen[cap]) continue;
        seen[cap] = true; out.push(cap);
      }
      return out;
    }

    /* THE OVERSEER'S DESK, MADE REAL. Historically the hero's starter desk was a SYNTHETIC render in
       world.js — drawn and walk-blocking, but absent from doc.props. That was an object=capability lie
       with real teeth: bayObjects() truthfully found no computer in the room, so a bay placed beside the
       visible "PC" nagged NO COMPUTE and the belt system looked broken on every fresh install (2026-07-05
       playtest bug). This materializes the same desk as a REAL placed workstation prop assigned to the
       agent, at the exact spot the synthetic one drew (spawn room, mid-width on the north wall), keeping
       the old invariant — the overseer always has a desk — honestly. Idempotent: no-op when the agent
       already owns any seat-type workstation. Falls back to the nearest valid spawn-room tile if the
       canonical spot is occupied; callers may still synthesize when even that fails (crowded floor). */
    const SEAT_WORKSTATIONS = { desk: 1, desk2: 1, console: 1, consoleL: 1, pixelrig: 1, bench: 1 };
    // Is there anywhere to put the CHAIR? world.js seats a body on the tile row directly SOUTH of a
    // workstation (PropAnchor's 'south' approach), so a desk whose whole south row is wall or blocking
    // prop is a desk nobody can sit at. Pure geometry — the model still knows nothing about chairs.
    function deskSeatFree(x, y, w) {
      const sy = y + 1;
      for (let sx = x; sx < x + w; sx++) {
        if (!roomAt(sx, sy)) continue;
        const pid = propAt(sx, sy);
        if (pid) { const p = propById(pid); if (p && p.block !== false) continue; }
        return true;
      }
      return false;
    }
    // Scan one room rect for a 2x1 desk spot, preferring one with a free seat row below it. Returns the
    // seat-approachable spot when there is one, else the first merely-valid spot, else null. Rows are walked
    // from y1+1 — the hero's own desk row — so a bank of seeded crew desks lines up WITH the starter desk
    // instead of tucking under the north wall face the tall-walls bake raises along y1. y1 stays as a last
    // resort (it is legal deck the Commander can build on) rather than being ruled out.
    function deskSpotIn(r) {
      let any = null;
      const rows = [];
      for (let y = r.y1 + 1; y <= r.y2; y++) rows.push(y);
      rows.push(r.y1);
      for (const y of rows)
        for (let x = r.x1; x <= r.x2; x++) {
          if (!canPlaceProp('desk', x, y, 2, 1).ok) continue;
          if (deskSeatFree(x, y, 2)) return { x, y };
          if (!any) any = { x, y };
        }
      return any;
    }
    function ensureWorkstation(agentId) {
      const aid = String(agentId || '').trim();
      if (!aid || !AID_RE.test(aid)) return fail('BAD_AGENT');
      const own = doc.props.find(p => SEAT_WORKSTATIONS[p.t] && p.agentId === aid);
      if (own) return { ok: true, existing: true, id: own.id, agentId: aid, x: own.x, y: own.y, roomId: roomAt(own.x, own.y) };
      // ADOPT BEFORE BUILDING. An UNBOUND workstation is dead furniture — no agent may walk to an unassigned
      // capability prop (world.js mayTouchProp), so it grants nobody a seat. Two ways one appears: the Commander
      // built a desk and never bound it, and deleteAgent unbinds (never demolishes) the props of a removed
      // specialist. Without this, a summon → delete → summon cycle silently litters the spawn room with
      // abandoned desks and eventually pushes the seeder into other rooms. Deliberately SPAWN-ROOM ONLY: a
      // free desk the Commander built in some far lab is theirs to assign, and adopting it would land a
      // newly-summoned specialist (and its whole zone/leash) somewhere they never asked for.
      const adopt = doc.props.find(p => SEAT_WORKSTATIONS[p.t] && !p.agentId && roomAt(p.x, p.y) === doc.meta.spawnRoomId);
      if (adopt) {
        const bound = assignPropAgent(adopt.id, aid);
        return bound.ok ? Object.assign({}, bound, { adopted: true, x: adopt.x, y: adopt.y, roomId: roomAt(adopt.x, adopt.y) }) : bound;
      }
      const rm = doc.meta.spawnRoomId && doc.rooms[doc.meta.spawnRoomId];
      const r = rm && rm.rects && rm.rects[0];
      if (!r) return fail('NO_SPAWN_ROOM');
      // the synthetic auto-desk's exact spot (mirrors world.js placeDesk fallback, in world tiles)
      let dtx = r.x1 + Math.max(1, Math.floor((r.x2 - r.x1) / 2));
      if (dtx + 1 > r.x2) dtx = Math.max(r.x1, r.x2 - 1);
      const dty = Math.min(r.y1 + 1, r.y2 - 1);
      let spot = (canPlaceProp('desk', dtx, dty, 2, 1).ok && deskSeatFree(dtx, dty, 2)) ? { x: dtx, y: dty } : null;
      if (!spot) spot = deskSpotIn(r);
      // CREW SEEDING: the spawn room fills up once several summoned specialists each own a desk. A crowded
      // spawn room must not strand the next one deskless while the rest of the station stands empty, so
      // fall through to every OTHER room (spawn room stays first — the hero's seed never moves).
      if (!spot) {
        for (const id of doc.order) {
          if (id === doc.meta.spawnRoomId) continue;
          for (const rect of (doc.rooms[id] && doc.rooms[id].rects) || []) { spot = deskSpotIn(rect); if (spot) break; }
          if (spot) break;
        }
      }
      if (!spot) return fail('NO_ROOM_FOR_DESK');
      const res = addProp({ t: 'desk', x: spot.x, y: spot.y, w: 2, h: 1, block: true });
      if (!res.ok) return res;
      const bound = assignPropAgent(res.id, aid);
      return bound.ok ? Object.assign({}, bound, { x: spot.x, y: spot.y, roomId: roomAt(spot.x, spot.y) }) : bound;
    }

    /* ---------- serialize / subscribe ---------- */
    const serialize = () => clone(doc);
    function onChange(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; }

    return {
      // reads
      doc: () => doc, rooms, roomById, roomAt, bounds, spawnRoomId,
      props, propById, propAt, belts, beltAt,
      getSeq: () => seq, FLOOR_STYLES, FLOOR_MATERIALS, MAT_ORDER, WALL_MATERIALS, WALL_ORDER, ROOM_KINDS, KIND_ORDER, TILE, MIN_ROOM, MIN_HALL,
      matOfRoom: id => matOfRoom(doc.rooms[id]),   // the room's effective deck material (for the palette's active state)
      wallMatOfRoom: id => wallMatOfRoom(doc.rooms[id]),
      wallStyleOfRoom: id => wallStyleOfRoom(doc.rooms[id]),
      // validation (no mutation — for ghost previews)
      canPlaceRoom, canPlaceHallway, canPlaceProp, canPlaceBeltRun,
      // mount rules: injected so the model never imports the prop catalog (see MOUNT RULES).
      // surfaceHostOf is the read surface the world layer uses to decide whether a placed prop is
      // ACTUALLY standing on a table right now — a prop whose table was reclaimed renders back on the
      // deck rather than floating, so no save ever needs migrating.
      // FRAME-PROOF: both readers below re-resolve the prop from the DOC by id before measuring it.
      // A renderer holds whatever frame it draws in — build.js has WORLD props, world.js has the
      // LOCAL ones projectGeometry() emits (same ids, shifted by the hull margin) — and the doc's
      // tables are only ever in WORLD tiles. Measuring the caller's copy compared a local footprint
      // against world footprints, so a station whose origin wasn't (0,0) — i.e. every real one —
      // found no host and the live world silently never lifted a single table-top prop.
      surfaceHostOf: (p) => {
        const host = p ? surfaceHostFor(propFootprint(propById(p.id) || p), p.id) : null;
        return host ? host.id : null;
      },
      // mountOf is the ONE question a renderer asks: "is this prop standing on a table RIGHT NOW?"
      // -> 'surface' | null. It folds both halves — the type may mount at all (mount/stack) AND a host
      // is actually under it — so the live world and the REFIT editor cannot answer it differently.
      // They did: build.js resolved neither half, so every table-top prop drew SURFACE_RISE px low
      // (sunk into its table) and with a sort key tied to the table's, i.e. sometimes behind it too.
      mountOf: (p) => {
        if (!p) return null;
        const rule = ruleOf(p.t);
        if (rule.mount !== 'surface' && !rule.stack) return null;
        return surfaceHostFor(propFootprint(propById(p.id) || p), p.id) ? 'surface' : null;
      },
      // mutations
      addRoom, placeHallway, removeRoom, moveRoom, setFloor, setMaterial, setDeck, setWalls, paintTiles, renameRoom,
      addProp, removeProp, moveProp, assignPropAgent, ensureWorkstation, configureJunction, bindConnector, setDoorState,
      setBelt, removeBelt, removeBelts, placeBeltRun, connectBelt,
      // agent-bay binding queries
      propsByType, propsByAgent, pipelineEdges, setPipelineEdges, addPipelineEdge, removePipelineEdge, agentRoomId, bayObjects,
      capForProp: t => CAP_PROP_MAP[t] || null,   // a prop type's capability objectType (single source for the UI)
      undo, redo, canUndo, canRedo,
      // projection + io
      projectGeometry, serialize, onChange,
    };
  }

  /* forward-only migration ladder for serialized docs (none yet — v1 is current) */
  function migrate(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    if (!doc.schema) doc.schema = 'starnet.station';
    if (!doc.version) doc.version = 1;
    // future: while (doc.version < CURRENT && migrations[doc.version]) ...
    // make deserialize TOTAL over any partial/legacy/corrupted v1 blob (it's the persistence seam):
    if (!doc.rooms || typeof doc.rooms !== 'object') doc.rooms = {};
    if (!Array.isArray(doc.order)) doc.order = Object.keys(doc.rooms);
    // drop order entries with no live room object, and repair any room missing a rects[] array —
    // so a truncated / hand-edited save can never crash the read paths (eachRectWorld/bounds/project).
    doc.order = doc.order.filter(id => doc.rooms[id] && typeof doc.rooms[id] === 'object');
    // floorMat is additive (docs predate the material axis): null/unknown means "inherit the kind
    // default", so a legacy blob and a hand-edited one both fall back to the exact pre-material look.
    for (const id of doc.order) {
      const rm = doc.rooms[id];
      if (!Array.isArray(rm.rects)) rm.rects = [];
      if (!rm.floorPaint) rm.floorPaint = {};
      if (!FLOOR_MATERIALS[rm.floorMat]) rm.floorMat = null;
      // Walls are additive too. Every room written before the wall axis carries a literal
      // wallStyle:'hull' that NOTHING ever read — it's noise, not intent, and keeping it would
      // pin every legacy room's walls to hull instead of letting them follow their own floor.
      // The absence of a wallMat key is the reliable tell that a room predates the axis.
      if (!('wallMat' in rm)) rm.wallStyle = null;
      if (!FLOOR_STYLES[rm.wallStyle]) rm.wallStyle = null;
      if (!WALL_MATERIALS[rm.wallMat]) rm.wallMat = null;
    }
    // props are additive (v1 docs predate them); make the read paths total over any blob.
    if (!Array.isArray(doc.props)) doc.props = [];
    // legacy repair: the 2×2 workflow docks shipped as block:false for a while, so agents walked
    // straight through them. They are solid now (catalog blocks:true; belts hook to ring tiles,
    // never under the footprint) — strip the stale flag from saved docs so old stations heal on load.
    const LEGACY_WALKABLE_DOCKS = { intake: 1, bay: 1, outbox: 1 };
    // RETIRED PROP TYPES must be dropped, not merely left unpainted. PropSprites.draw() no-ops on an
    // unknown type, but the doc entry keeps its footprint — so a station saved with a since-retired prop
    // would carry an INVISIBLE obstacle that agents path around forever. Only prunes when the mount-rule
    // lookup is installed (i.e. a real client with the catalog); plain node tests keep every prop.
    if (propRules) doc.props = doc.props.filter(p => !(p && typeof p.t === 'string') || !!propRules(p.t));
    doc.props = doc.props.filter(p => p && typeof p === 'object' && typeof p.t === 'string')
      .map(p => { const o = { id: p.id || null, t: p.t, x: p.x | 0, y: p.y | 0, w: Math.max(1, p.w | 0 || 1), h: Math.max(1, p.h | 0 || 1) }; if (p.block === false && !LEGACY_WALKABLE_DOCKS[p.t]) o.block = false; if (typeof p.agentId === 'string' && p.agentId) o.agentId = p.agentId; applyJunctionCfg(o, p); if (cleanDoor(p.door)) o.door = p.door; if (typeof p.connectorId === 'string' && p.connectorId.trim()) o.connectorId = p.connectorId.trim(); return o; });
    // belts are additive (v1 docs predate them); keep only well-formed "int,int" -> E|W|N|S entries.
    if (!doc.belts || typeof doc.belts !== 'object' || Array.isArray(doc.belts)) doc.belts = {};
    else { const clean = {}; for (const k in doc.belts) { const d = doc.belts[k]; if (/^-?\d+,-?\d+$/.test(k) && (d === 'E' || d === 'W' || d === 'N' || d === 'S')) clean[k] = d; } doc.belts = clean; }
    if (!Array.isArray(doc.edges)) doc.edges = [];
    doc.edges = doc.edges.map(cleanPipelineEdge).filter(Boolean);
    if (!doc.meta || typeof doc.meta !== 'object') doc.meta = { name: 'STARNET STATION', createdAt: 0, tier: 0, spawnRoomId: null };
    if (typeof doc._nid !== 'number') doc._nid = doc.order.length + 1;
    for (const p of doc.props) if (!p.id) p.id = 'p' + (doc._nid++);   // backfill ids for legacy/partial props
    // spawnRoomId must point at a live non-corridor room (or null) so removeRoom's guard stays meaningful
    if (!doc.meta.spawnRoomId || !doc.rooms[doc.meta.spawnRoomId])
      doc.meta.spawnRoomId = doc.order.find(id => doc.rooms[id] && doc.rooms[id].kind !== 'corridor') || null;
    // trunkRoomId (the integration-hub room that never seals) — additive; default to the spawn room.
    if (!doc.meta.trunkRoomId || !doc.rooms[doc.meta.trunkRoomId])
      doc.meta.trunkRoomId = doc.meta.spawnRoomId || doc.order.find(id => doc.rooms[id] && doc.rooms[id].kind !== 'corridor') || null;
    return doc;
  }

  return {
    TILE, MARGIN, MIN_ROOM, MIN_HALL, FLOOR_STYLES, FLOOR_MATERIALS, MAT_ORDER, WALL_MATERIALS, WALL_ORDER, ROOM_KINDS, KIND_ORDER,
    create: doc => makeStation(doc),
    deserialize: doc => makeStation(clone(doc)),
    defaultDoc: freshDoc,
    // pure helpers reused by the build layer
    normRect, rectW, rectH, rectsHit, inRect,
    // install the prop-type -> {mount, surface} lookup once for every station this module makes
    setPropRules,
    // capability legibility — prop -> plain power word (WEB/FILES/…); one owned source for the palette tile + Field Manual
    CAP_PROP_MAP, CAP_LABEL, capForProp: t => CAP_PROP_MAP[t] || null, grantLabelForProp,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WorldModel;
