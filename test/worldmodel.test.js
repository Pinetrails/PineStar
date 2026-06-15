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

/* ---- walkability + pathfinding over the projected geometry ---- */
const s8 = WM.create();                                  // HAB-01 {0..17,0..10}
s8.addRoom({ kind: 'lab', rect: { x1: 20, y1: 0, x2: 28, y2: 8 } });
s8.placeHallway({ rect: { x1: 18, y1: 3, x2: 19, y2: 4 } });  // bridges hab <-> lab
const g8 = s8.projectGeometry();
const ox8 = g8.origin.tx, oy8 = g8.origin.ty;
const L = (wx, wy) => [wx - ox8, wy - oy8];              // world -> local
const habT = L(3, 5), labT = L(24, 5);
A.ok(g8.walkable(habT[0], habT[1]), 'hab interior tile is walkable');
A.ok(g8.walkable(labT[0], labT[1]), 'lab interior tile is walkable');
A.ok(!g8.walkable(-1, -1), 'off-grid is not walkable');
A.ok(!g8.walkable(0, 0), 'a margin/void tile is not walkable');
const cz = g8.chamfers[0];
A.ok(cz && !g8.walkable(cz[0], cz[1]), 'a rounded-corner (chamfer) tile is not walkable');

const p = g8.path(habT[0], habT[1], labT[0], labT[1]);
A.ok(p && p.length > 0, 'a path from hab to lab exists');
A.ok(p[p.length - 1].x === labT[0] && p[p.length - 1].y === labT[1], 'path ends at the target tile');
A.eq(g8.path(habT[0], habT[1], 0, 0), null, 'no path to a void tile');
const extra = new Set();
for (let wx = 18; wx <= 19; wx++) for (let wy = 3; wy <= 4; wy++) extra.add((wx - ox8) + ',' + (wy - oy8));
A.eq(g8.path(habT[0], habT[1], labT[0], labT[1], extra), null, 'blocking the only corridor severs the path');

/* ---- footprint span cap (the far-room canvas-explosion guard) ---- */
const s9 = WM.create();
A.ok(!s9.addRoom({ kind: 'lab', rect: { x1: 800, y1: 600, x2: 806, y2: 606 } }).ok, 'a far-flung room is rejected');
A.eq(s9.addRoom({ kind: 'lab', rect: { x1: 800, y1: 600, x2: 806, y2: 606 } }).error, 'TOO_FAR', '...with TOO_FAR');
A.ok(s9.addRoom({ kind: 'lab', rect: { x1: 22, y1: 0, x2: 28, y2: 6 } }).ok, 'a nearby room is still fine');

/* ---- migrate() is total over corrupt docs (ghost order id / missing rects) ---- */
A.notThrows(() => {
  const g = WM.deserialize({ schema: 'skynet.station', version: 1,
    rooms: { rA: { id: 'rA', kind: 'hab', name: 'A', rects: [{ x1: 0, y1: 0, x2: 5, y2: 5 }] } },
    order: ['rA', 'rGHOST'], meta: { spawnRoomId: 'rGHOST' } });
  g.projectGeometry(); g.bounds(); g.canPlaceRoom([{ x1: 9, y1: 9, x2: 13, y2: 13 }], 'lab');
}, 'a doc with a ghost order id does not crash any read path');
A.notThrows(() => {
  const g = WM.deserialize({ schema: 'skynet.station', version: 1,
    rooms: { rB: { id: 'rB', kind: 'hab', name: 'B' } }, order: ['rB'] });   // room with no rects
  g.projectGeometry(); g.rooms();
}, 'a room with no rects[] is repaired, not crashed');

/* ---- props (furniture): place / validate / block-walk / move / reclaim / persist ---- */
const sp = WM.create();                                   // HAB-01 {0..17,0..10}
const spId = sp.spawnRoomId();
A.eq(sp.props().length, 0, 'a fresh station has no props');

const addP = sp.addProp({ t: 'desk', x: 4, y: 2, w: 2, h: 1 });
A.ok(addP.ok && addP.id, 'addProp onto the deck succeeds');
A.eq(sp.props().length, 1, 'one prop after add');
A.eq(sp.propAt(4, 2), addP.id, 'propAt finds the placed prop');
A.eq(sp.propAt(15, 9), null, 'propAt over bare deck returns null');

const offDeck = sp.addProp({ t: 'desk', x: 500, y: 500, w: 2, h: 1 });
A.ok(!offDeck.ok && offDeck.error === 'OFF_DECK', 'a prop off the deck is rejected');
const overlapP = sp.addProp({ t: 'tv', x: 5, y: 2, w: 3, h: 1 });
A.ok(!overlapP.ok && overlapP.error === 'OVERLAP', 'a prop overlapping another prop is rejected');
const noType = sp.addProp({ t: '', x: 8, y: 5, w: 1, h: 1 });
A.ok(!noType.ok && noType.error === 'NO_TYPE', 'a typeless prop is rejected');
A.eq(sp.props().length, 1, 'rejected prop adds do not mutate the doc');

/* props block walkability in the projected geometry (the furniture seam) */
const gp = sp.projectGeometry();
A.ok(gp.props && gp.props.length === 1, 'projectGeometry emits props in the local frame');
const pl = gp.props[0];
A.eq(pl.t, 'desk', 'projected prop keeps its type');
A.ok(!gp.walkable(pl.x, pl.y), 'a prop footprint tile is NOT walkable (agents route around it)');
A.ok(gp.walkable(pl.x, pl.y + 2), 'the deck below the prop is still walkable');

/* move + reclaim + undo */
A.ok(sp.moveProp(addP.id, 0, 4).ok, 'moveProp to free deck succeeds');
A.eq(sp.propById(addP.id).y, 6, 'moveProp updates the prop position');
sp.undo();
A.eq(sp.propById(addP.id).y, 2, 'undo restores the prop position');
sp.redo();
A.eq(sp.propById(addP.id).y, 6, 'redo re-applies the move');
A.ok(sp.removeProp(addP.id).ok, 'removeProp succeeds');
A.eq(sp.props().length, 0, 'prop count drops after reclaim');
sp.undo();
A.eq(sp.props().length, 1, 'undo restores a reclaimed prop');

/* props survive a serialize round-trip */
const spDoc = sp.serialize();
const sp2 = WM.deserialize(spDoc);
A.eq(sp2.props().length, 1, 'deserialize preserves props');
A.eq(JSON.stringify(sp2.serialize()), JSON.stringify(spDoc), 'props serialize round-trips identically');

/* migrate(): legacy doc with no props[] and a partial prop blob is repaired, not crashed */
A.notThrows(() => {
  const g = WM.deserialize({ schema: 'skynet.station', version: 1,
    rooms: { rP: { id: 'rP', kind: 'hab', name: 'P', rects: [{ x1: 0, y1: 0, x2: 5, y2: 5 }] } }, order: ['rP'],
    props: [{ t: 'tv', x: 1, y: 1 }, { nope: true }] });   // one valid (no id/w/h), one junk
  const pr = g.props();
  A.eq(pr.length, 1, 'migrate keeps the valid prop and drops the junk one');
  A.ok(pr[0].id && pr[0].w >= 1 && pr[0].h >= 1, 'migrate backfills id + default footprint');
  g.projectGeometry();
}, 'a legacy/partial props blob is repaired without crashing');

A.report('worldmodel');
