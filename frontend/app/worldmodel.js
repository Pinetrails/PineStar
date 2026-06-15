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
  const HULL_PAD = 14;  // extra canvas px below the grid for the south hull extrusion (matches v7 H = ROWS*T+14)

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
      meta: { name: 'SKYNET STATION', createdAt: createdAt || 0, tier: 0, spawnRoomId: null },
      rooms: {}, order: []
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
    function snapshot() { undoStack.push(clone({ rooms: doc.rooms, order: doc.order, meta: doc.meta, _nid: doc._nid })); if (undoStack.length > 120) undoStack.shift(); redoStack.length = 0; }
    function restore(s) { doc.rooms = s.rooms; doc.order = s.order; doc.meta = s.meta; doc._nid = s._nid; }
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
      redoStack.push(clone({ rooms: doc.rooms, order: doc.order, meta: doc.meta, _nid: doc._nid }));
      restore(undoStack.pop());
      emit([]);   // empty dirty = full re-bake
      return { ok: true };
    }
    function redo() {
      if (!redoStack.length) return fail('NOTHING', 'nothing to redo');
      undoStack.push(clone({ rooms: doc.rooms, order: doc.order, meta: doc.meta, _nid: doc._nid }));
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

      /* auto-doors: open a threshold wherever two different zones are orthogonally adjacent,
         so abutting rooms/corridors connect with no manual door tool (foundation default). */
      const doorDefs = [];
      const doorSet = new Set();
      const addDoor = (x1, y1, x2, y2) => {
        const k = x1 + ',' + y1 + '>' + x2 + ',' + y2;
        if (doorSet.has(k)) return;
        doorDefs.push([x1, y1, x2, y2]);
        doorSet.add(k); doorSet.add(x2 + ',' + y2 + '>' + x1 + ',' + y1);
      };
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        const z = zoneGrid[idx(x, y)];
        if (z == null) continue;
        if (x + 1 < COLS) { const nz = zoneGrid[idx(x + 1, y)]; if (nz != null && nz !== z) addDoor(x, y, x + 1, y); }
        if (y + 1 < ROWS) { const nz = zoneGrid[idx(x, y + 1)]; if (nz != null && nz !== z) addDoor(x, y, x, y + 1); }
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
        allRects, zones, ROOM_IDS, isCorridor, chamfers, windows: [],
        doorDefs, zoneGrid, idx, canStep, baseColorOf, walkable, path, blockedTiles,
        nameOf: id => (doc.rooms[id] ? doc.rooms[id].name : ''),
        kindOf: id => (doc.rooms[id] ? doc.rooms[id].kind : null),
        FLOOR_STYLES
      };
    }

    /* ---------- serialize / subscribe ---------- */
    const serialize = () => clone(doc);
    function onChange(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; }

    return {
      // reads
      doc: () => doc, rooms, roomById, roomAt, bounds, spawnRoomId,
      getSeq: () => seq, FLOOR_STYLES, ROOM_KINDS, KIND_ORDER, TILE, MIN_ROOM, MIN_HALL,
      // validation (no mutation — for ghost previews)
      canPlaceRoom, canPlaceHallway,
      // mutations
      addRoom, placeHallway, removeRoom, moveRoom, setFloor, paintTiles, renameRoom,
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
    if (!doc.meta || typeof doc.meta !== 'object') doc.meta = { name: 'SKYNET STATION', createdAt: 0, tier: 0, spawnRoomId: null };
    if (typeof doc._nid !== 'number') doc._nid = doc.order.length + 1;
    for (const id of doc.order) { const rm = doc.rooms[id]; if (rm && !rm.floorPaint) rm.floorPaint = {}; }
    // spawnRoomId must point at a live non-corridor room (or null) so removeRoom's guard stays meaningful
    if (!doc.meta.spawnRoomId || !doc.rooms[doc.meta.spawnRoomId])
      doc.meta.spawnRoomId = doc.order.find(id => doc.rooms[id] && doc.rooms[id].kind !== 'corridor') || null;
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
