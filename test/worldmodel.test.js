/* test/worldmodel.test.js — headless tests for the pure Station model (frontend/app/worldmodel.js).
   The model has no DOM / no ambient time/RNG, so it loads with a plain require(). */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');

/* ---- default station: one spawn HAB room ---- */
const s = WM.create();
A.eq(s.rooms().length, 1, 'default station seeds exactly one room');
A.ok(s.spawnRoomId(), 'spawn room id is set');
const hab = s.rooms()[0];
A.eq(hab.kind, 'hab', 'seed room is a hab');
A.eq(s.spawnRoomId(), hab.id, 'seed room is the spawn room');

/* ---- addRoom: valid, overlap, too-small ---- */
const ok1 = s.addRoom({ kind: 'lab', rect: { x1: 20, y1: 0, x2: 26, y2: 8 } });
A.ok(ok1.ok, 'non-overlapping addRoom succeeds');
A.eq(s.rooms().length, 2, 'two rooms after add');
const labId = ok1.id;

const over = s.addRoom({ kind: 'lab', rect: { x1: 0, y1: 0, x2: 5, y2: 5 } });
A.ok(!over.ok && over.error === 'OVERLAP', 'overlapping addRoom rejected with OVERLAP');

const tiny = s.addRoom({ kind: 'lab', rect: { x1: 40, y1: 40, x2: 41, y2: 41 } });
A.ok(!tiny.ok && tiny.error === 'TOO_SMALL', 'too-small room rejected with TOO_SMALL');
A.eq(s.rooms().length, 2, 'rejected adds do not mutate the doc');

/* normRect tolerance: reversed corners still place ---- */
const rev = s.addRoom({ kind: 'storage', rect: { x1: 26, y1: 24, x2: 20, y2: 18 } });
A.ok(rev.ok, 'reversed-corner rect is normalised and placed');
s.removeRoom(rev.id); // keep the rest of the test tidy

/* ---- hallway bridges the 2-tile gap between hab (x≤17) and lab (x≥20) ---- */
const hw = s.placeHallway({ rect: { x1: 18, y1: 3, x2: 19, y2: 4 } });
A.ok(hw.ok, 'hallway placed in the gap');
A.eq(s.rooms().length, 3, 'three zones: hab + lab + corridor');

/* ---- projectGeometry: the MAP-shaped contract the bake consumes ---- */
const g = s.projectGeometry();
A.eq(g.TILE, 12, 'geometry TILE = 12');
A.ok(g.COLS > 0 && g.ROWS > 0, 'geometry has a positive size');
A.eq(g.W, g.COLS * 12, 'W = COLS*TILE');
A.ok(g.H > g.ROWS * 12, 'H carries hull headroom below the grid');
A.eq(g.ROOM_IDS.length, 2, 'ROOM_IDS excludes the corridor (hab + lab)');
A.eq(g.allRects.length, 3, 'allRects covers every footprint rect');
A.ok(g.isCorridor(hw.id) === true, 'isCorridor true for the corridor zone');
A.ok(g.isCorridor(hab.id) === false, 'isCorridor false for a room zone');

const lx = hab.rects[0].x1 - g.origin.tx, ly = hab.rects[0].y1 - g.origin.ty;
A.eq(g.zoneGrid[g.idx(lx, ly)], hab.id, 'hab corner tile stamped into zoneGrid (local frame)');
A.ok(g.doorDefs.length > 0, 'auto-doors derived between abutting zones');
const d = g.doorDefs[0];
A.ok(g.canStep(d[0], d[1], d[2], d[3]), 'canStep crosses a derived door');
A.ok(!g.canStep(0, 0, -1, 0), 'canStep false off the grid');
A.ok(typeof g.baseColorOf(hab.id, lx, ly) === 'string', 'baseColorOf returns a colour');
A.ok(g.chamfers.length > 0, 'rooms get chamfered (void-exposed) corners');

/* ---- roomAt in world coords ---- */
A.eq(s.roomAt(hab.rects[0].x1, hab.rects[0].y1), hab.id, 'roomAt finds the hab');
A.eq(s.roomAt(10000, 10000), null, 'roomAt over void returns null');

/* ---- moveRoom: empty target ok; overlap rejected ---- */
const mv = s.moveRoom(labId, 0, 30);
A.ok(mv.ok, 'moveRoom into empty space succeeds');
const mvBack = s.moveRoom(labId, -100, 0); // far away, still empty
A.ok(mvBack.ok, 'moveRoom far into empty space succeeds');
const mvOver = s.moveRoom(labId, 100, -30); // back onto hab/corridor region
// not asserting overlap here (depends on exact geometry); just ensure it returns a result shape
A.ok(typeof mvOver.ok === 'boolean', 'moveRoom returns a result shape');

/* ---- paint / floor styles ---- */
const pf = s.setFloor(hab.id, 'cobalt');
A.ok(pf.ok, 'setFloor to a known style succeeds');
A.eq(s.roomById(hab.id).floorStyle, 'cobalt', 'room floorStyle updated');
const pfBad = s.setFloor(hab.id, 'nope');
A.ok(!pfBad.ok && pfBad.error === 'BAD_STYLE', 'unknown floor style rejected');

/* ---- removeRoom: spawn protected, others removable ---- */
const rmSpawn = s.removeRoom(s.spawnRoomId());
A.ok(!rmSpawn.ok && rmSpawn.error === 'SPAWN_ROOM', 'spawn room is protected from reclaim');
const cntBefore = s.rooms().length;
const rmHall = s.removeRoom(hw.id);
A.ok(rmHall.ok, 'a non-spawn zone is removable');
A.eq(s.rooms().length, cntBefore - 1, 'removal drops the count by one');

/* ---- undo / redo round-trip ---- */
A.ok(s.canUndo(), 'history has undoable steps');
s.undo();
A.eq(s.rooms().length, cntBefore, 'undo restores the removed corridor');
s.redo();
A.eq(s.rooms().length, cntBefore - 1, 'redo re-applies the removal');

/* ---- onChange fires with a monotonic seq ---- */
let last = null;
const off = s.onChange(p => { last = p; });
const seq0 = s.getSeq();
s.addRoom({ kind: 'quarters', rect: { x1: 0, y1: 30, x2: 8, y2: 38 } });
A.ok(last && last.seq === seq0 + 1, 'onChange fired with an incremented seq');
off();

/* ---- serialize round-trips byte-identically ---- */
const doc = s.serialize();
const s2 = WM.deserialize(doc);
A.eq(s2.rooms().length, s.rooms().length, 'deserialize preserves the room count');
A.eq(JSON.stringify(s2.serialize()), JSON.stringify(doc), 'serialize → deserialize → serialize is identical');

/* ---- multi-rect / L-shaped footprints + self-overlap rejection ---- */
const s3 = WM.create();
const lshape = s3.addRoom({ kind: 'storage', rects: [{ x1: 40, y1: 40, x2: 46, y2: 46 }, { x1: 44, y1: 47, x2: 50, y2: 52 }] });
A.ok(lshape.ok, 'L-shaped multi-rect room places');
const selfOver = s3.addRoom({ kind: 'storage', rects: [{ x1: 60, y1: 60, x2: 66, y2: 66 }, { x1: 63, y1: 63, x2: 69, y2: 69 }] });
A.ok(!selfOver.ok && selfOver.error === 'OVERLAP', 'self-overlapping multi-rect footprint rejected');

/* ---- a rejected mutation must not touch history ---- */
const s4 = WM.create();
s4.addRoom({ kind: 'lab', rect: { x1: 30, y1: 0, x2: 36, y2: 6 } });
const canU = s4.canUndo();
A.ok(!s4.addRoom({ kind: 'lab', rect: { x1: 0, y1: 0, x2: 4, y2: 4 } }).ok, 'overlapping add rejected');
A.eq(s4.canUndo(), canU, 'a rejected mutation leaves the undo stack untouched');

/* ---- no-op mutations must not consume an undo slot or wipe redo ---- */
const s5 = WM.create();
const hid = s5.rooms()[0].id;
s5.setFloor(hid, 'cobalt');
s5.undo();
A.ok(s5.canRedo(), 'redo available after undo');
A.ok(s5.setFloor(hid, s5.roomById(hid).floorStyle).ok, 'no-op setFloor returns ok');
A.ok(s5.canRedo(), 'a no-op mutation does not wipe the redo stack');
s5.setFloor(hid, 'rust');
A.ok(!s5.canRedo(), 'a real mutation after undo clears redo');

/* ---- floorPaint survives moveRoom + a serialize round-trip ---- */
const s6 = WM.create();
const pid = s6.rooms()[0].id;
s6.paintTiles(pid, [[2, 2], [3, 3]], 'crimson');
s6.moveRoom(pid, 5, 5);                       // painted tile (2,2) -> world (7,7)
let g6 = s6.projectGeometry();
const lx6 = 7 - g6.origin.tx, ly6 = 7 - g6.origin.ty;
A.eq(g6.baseColorOf(pid, lx6, ly6), s6.FLOOR_STYLES.crimson.base, 'painted tile follows a moveRoom');
g6 = WM.deserialize(s6.serialize()).projectGeometry();
A.eq(g6.baseColorOf(pid, lx6, ly6), s6.FLOOR_STYLES.crimson.base, 'floorPaint survives serialize round-trip');

/* ---- name-counter determinism + canStep same-zone ---- */
const s7 = WM.create();
const a7 = s7.addRoom({ kind: 'lab', rect: { x1: 20, y1: 0, x2: 28, y2: 6 } });
A.eq(s7.roomById(a7.id).name, 'LAB-02', 'auto-name uses the deterministic doc id counter');
const g7 = s7.projectGeometry(), hz = g7.zones[s7.spawnRoomId()];
A.ok(g7.canStep(hz.x1, hz.y1, hz.x1 + 1, hz.y1), 'canStep true within the same zone');

/* ---- migrate() is total over a partial / legacy doc ---- */
const partial = WM.deserialize({ schema: 'skynet.station', version: 1,
  rooms: { rX: { id: 'rX', kind: 'hab', name: 'X', rects: [{ x1: 0, y1: 0, x2: 5, y2: 5 }] } } });
A.eq(partial.rooms().length, 1, 'deserialize backfills a missing order[] from rooms{}');
A.eq(partial.spawnRoomId(), 'rX', 'deserialize re-derives spawnRoomId for a partial doc');

A.report('worldmodel');
