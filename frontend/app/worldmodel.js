/* SKYNET — worldmodel.js : the canonical, mutable, serializable STATION document.

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
  // copy any present + valid junction config from src onto dst (mutates dst; additive — absent fields untouched)
  function applyJunctionCfg(dst, src) {
    const routes = cleanRoutes(src.routes); if (routes) dst.routes = routes;
    const def = cleanDir(src.def); if (def) dst.def = def;
    const buf = cleanBuf(src.bufferSize); if (buf) dst.bufferSize = buf;
    return dst;
  }

  /* Airlock door state — the worktree-isolation mechanic, carried on an 'airlock' prop exactly like a
     BAY carries agentId. A room containing a SEALING airlock (closed|jammed) is cut off: projectGeometry
     drops its boundary doors so canStep — and thus every agent path — can't cross in or out. That mirrors
     an unmerged worktree: the agent's room is private until "merged".
       open   = merged / connected to trunk (DEFAULT — stored as an absent field, so old docs are unchanged)
       closed = private, unmerged (sealed)
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
    gigs_servercart: 'notebook', bridge_relaystack: 'notebook', core: 'notebook'                                             // a server/databank = memory
  };

  /* the paint palette — each is a floor BASE colour; every other floor detail
     (seams / rivets / vents / hatches) is derived from it via U.shade in the bake. */
  const FLOOR_STYLES = {
    hull:     { base: '#33302a', label: 'HULL' },
    corridor: { base: '#2c2924', label: 'DECKING' },
    cobalt:   { base: '#2b3340', label: 'COBALT' },
    rust:     { base: '#3a302a', label: 'RUST' },
    sterile:  { base: '#34383a', label: 'STERILE' },
    crimson:  { base: '#3a2b2b', label: 'CRIMSON' },
    verdant:  { base: '#2c3a2e', label: 'VERDANT' },
  };

  /* room categories — a capability-zone label + a default floor. kind drives nothing
     behavioural yet (capability mapping is a later pass); it tags the zone + seeds the look. */
  const ROOM_KINDS = {
    hab:      { label: 'HAB',      floor: 'hull' },
    bridge:   { label: 'BRIDGE',   floor: 'cobalt' },
    lab:      { label: 'LAB',      floor: 'sterile' },
    factory:  { label: 'FOUNDRY',  floor: 'rust' },
    quarters: { label: 'QUARTERS', floor: 'verdant' },
    storage:  { label: 'STORAGE',  floor: 'rust' },
    corridor: { label: 'CORRIDOR', floor: 'corridor' },
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
      schema: 'skynet.station', version: 1, _nid: 1,
      meta: { name: 'SKYNET STATION', createdAt: createdAt || 0, tier: 0, spawnRoomId: null, trunkRoomId: null },
      rooms: {}, order: [], props: [], belts: {}
    };
    // seed the shabby starter HAB (18×11 floor — the v7 / world.js starter room), so a new
    // station is never empty and the builder has something to extend from.
    const id = 'r' + (doc._nid++);
    doc.rooms[id] = {
      id, kind: 'hab', name: 'HAB-01',
      rects: [{ x1: 0, y1: 0, x2: 17, y2: 10 }],
      floorStyle: 'hull', wallStyle: 'hull', tier: 0, floorPaint: {}
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
    const snap = () => clone({ rooms: doc.rooms, order: doc.order, meta: doc.meta, _nid: doc._nid, props: doc.props, belts: doc.belts });
    function snapshot() { undoStack.push(snap()); if (undoStack.length > 120) undoStack.shift(); redoStack.length = 0; }
    function restore(s) { doc.rooms = s.rooms; doc.order = s.order; doc.meta = s.meta; doc._nid = s._nid; doc.props = s.props || []; doc.belts = s.belts || {}; }
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
      const label = ROOM_KINDS[kind].label;
      doc.rooms[id] = {
        id, kind, name: opts.name || (label + '-' + pad2(doc._nid - 1)),
        rects, floorStyle, wallStyle: 'hull', tier: 0, floorPaint: {}
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
       must not overlap another prop, and the type tag must be a non-empty string. */
    function checkProp(foot, ignoreId) {
      if (foot.x2 < foot.x1 || foot.y2 < foot.y1) return fail('NO_RECT', 'nothing to place');
      for (let y = foot.y1; y <= foot.y2; y++) for (let x = foot.x1; x <= foot.x2; x++) {
        if (!roomAt(x, y)) return fail('OFF_DECK', 'must sit on a deck');
      }
      for (const p of doc.props) {
        if (p.id === ignoreId) continue;
        if (rectsHit(foot, propFootprint(p))) return fail('OVERLAP', 'overlaps a prop');
      }
      return { ok: true };
    }
    const canPlaceProp = (t, x, y, w, h, ignoreId) =>
      checkProp({ x1: x, y1: y, x2: x + (w || 1) - 1, y2: y + (h || 1) - 1 }, ignoreId);

    function addProp(opts) {
      const t = String(opts.t || '').trim();
      if (!t) return fail('NO_TYPE', 'no prop type');
      const w = Math.max(1, opts.w | 0 || 1), h = Math.max(1, opts.h | 0 || 1);
      const x = opts.x | 0, y = opts.y | 0;
      const v = checkProp({ x1: x, y1: y, x2: x + w - 1, y2: y + h - 1 });
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
      const v = checkProp({ x1: nx, y1: ny, x2: nx + p.w - 1, y2: ny + p.h - 1 }, id);
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

      /* worktree isolation: a room holding a SEALING airlock (closed|jammed) gets NO boundary doors
         below, so canStep can't cross its edge — the agent is sealed in, like an unmerged branch. The
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
        return out.reverse();
      }

      return {
        TILE, COLS, ROWS, W: COLS * TILE, H: ROWS * TILE + HULL_PAD,
        origin: { tx: ox, ty: oy },
        allRects, zones, ROOM_IDS, isCorridor, chamfers, windows: [], props: propsLocal, belts: beltsLocal,
        doorDefs, zoneGrid, idx, canStep, baseColorOf, walkable, path, blockedTiles,
        nameOf: id => (doc.rooms[id] ? doc.rooms[id].name : ''),
        kindOf: id => (doc.rooms[id] ? doc.rooms[id].kind : null),
        FLOOR_STYLES
      };
    }

    /* ---------- agent-bay binding (Phase B: a belt endpoint named for an agent) ---------- */
    const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;   // notebook/fs-jail agentId grammar (mirrors the sidecar hub)
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
    // cycle an AIRLOCK's door state (open|closed|jammed) — the worktree merge/isolation handle. Mirrors
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
    const propsByType = t => doc.props.filter(p => p.t === t).map(clone);
    const propsByAgent = agentId => doc.props.filter(p => p.agentId === agentId).map(clone);
    function agentRoomId(agentId) {   // the room the agent's BAY sits in — the capability-isolation seam
      const bay = doc.props.find(p => p.t === 'bay' && p.agentId === agentId);
      return bay ? roomAt(bay.x, bay.y) : null;
    }
    // Phase B5: the capability objectTypes (CAP_REGISTRY) granted by the cap-props sharing the agent's BAY room —
    // exactly what the sidecar feeds resolveTools, so each bay's tools are what you placed in its room. Deduped.
    function bayObjects(agentId) {
      const bay = doc.props.find(p => p.t === 'bay' && p.agentId === agentId);
      const room = bay ? roomAt(bay.x, bay.y) : null;
      if (!room) return [];
      const seen = {}, out = [];
      for (const p of doc.props) {
        const cap = CAP_PROP_MAP[p.t];
        if (!cap || seen[cap]) continue;
        if (roomAt(p.x, p.y) !== room) continue;
        seen[cap] = true; out.push(cap);
      }
      return out;
    }

    /* ---------- serialize / subscribe ---------- */
    const serialize = () => clone(doc);
    function onChange(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; }

    return {
      // reads
      doc: () => doc, rooms, roomById, roomAt, bounds, spawnRoomId,
      props, propById, propAt, belts, beltAt,
      getSeq: () => seq, FLOOR_STYLES, ROOM_KINDS, KIND_ORDER, TILE, MIN_ROOM, MIN_HALL,
      // validation (no mutation — for ghost previews)
      canPlaceRoom, canPlaceHallway, canPlaceProp, canPlaceBeltRun,
      // mutations
      addRoom, placeHallway, removeRoom, moveRoom, setFloor, paintTiles, renameRoom,
      addProp, removeProp, moveProp, assignPropAgent, configureJunction, setDoorState,
      setBelt, removeBelt, placeBeltRun,
      // agent-bay binding queries
      propsByType, propsByAgent, agentRoomId, bayObjects,
      undo, redo, canUndo, canRedo,
      // projection + io
      projectGeometry, serialize, onChange,
    };
  }

  /* forward-only migration ladder for serialized docs (none yet — v1 is current) */
  function migrate(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    if (!doc.schema) doc.schema = 'skynet.station';
    if (!doc.version) doc.version = 1;
    // future: while (doc.version < CURRENT && migrations[doc.version]) ...
    // make deserialize TOTAL over any partial/legacy/corrupted v1 blob (it's the persistence seam):
    if (!doc.rooms || typeof doc.rooms !== 'object') doc.rooms = {};
    if (!Array.isArray(doc.order)) doc.order = Object.keys(doc.rooms);
    // drop order entries with no live room object, and repair any room missing a rects[] array —
    // so a truncated / hand-edited save can never crash the read paths (eachRectWorld/bounds/project).
    doc.order = doc.order.filter(id => doc.rooms[id] && typeof doc.rooms[id] === 'object');
    for (const id of doc.order) { const rm = doc.rooms[id]; if (!Array.isArray(rm.rects)) rm.rects = []; if (!rm.floorPaint) rm.floorPaint = {}; }
    // props are additive (v1 docs predate them); make the read paths total over any blob.
    if (!Array.isArray(doc.props)) doc.props = [];
    doc.props = doc.props.filter(p => p && typeof p === 'object' && typeof p.t === 'string')
      .map(p => { const o = { id: p.id || null, t: p.t, x: p.x | 0, y: p.y | 0, w: Math.max(1, p.w | 0 || 1), h: Math.max(1, p.h | 0 || 1) }; if (p.block === false) o.block = false; if (typeof p.agentId === 'string' && p.agentId) o.agentId = p.agentId; applyJunctionCfg(o, p); if (cleanDoor(p.door)) o.door = p.door; return o; });
    // belts are additive (v1 docs predate them); keep only well-formed "int,int" -> E|W|N|S entries.
    if (!doc.belts || typeof doc.belts !== 'object' || Array.isArray(doc.belts)) doc.belts = {};
    else { const clean = {}; for (const k in doc.belts) { const d = doc.belts[k]; if (/^-?\d+,-?\d+$/.test(k) && (d === 'E' || d === 'W' || d === 'N' || d === 'S')) clean[k] = d; } doc.belts = clean; }
    if (!doc.meta || typeof doc.meta !== 'object') doc.meta = { name: 'SKYNET STATION', createdAt: 0, tier: 0, spawnRoomId: null };
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
    TILE, MARGIN, MIN_ROOM, MIN_HALL, FLOOR_STYLES, ROOM_KINDS, KIND_ORDER,
    create: doc => makeStation(doc),
    deserialize: doc => makeStation(clone(doc)),
    defaultDoc: freshDoc,
    // pure helpers reused by the build layer
    normRect, rectW, rectH, rectsHit, inRect,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WorldModel;
