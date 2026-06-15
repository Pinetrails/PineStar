/* test/conveyor.test.js — headless tests for the belt MODEL (worldmodel belts) + the transport
   SIM (conveyor.js). Neither needs a DOM: the model is pure, and Conveyor.tick() takes injected
   time and a belt list (drawing is the only ctx-dependent part, exercised in-browser). */
'use strict';
const A = require('./_assert.js');
global.U = global.U || { shade: c => c, hash: s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; } };
const WM = require('../frontend/app/worldmodel.js');
const Conveyor = require('../frontend/app/conveyor.js');

/* ---------- belt model ---------- */
const s = WM.create();                                   // HAB-01 {0..17,0..10}
const r = s.roomById(s.spawnRoomId()).rects[0];
A.eq(s.belts().length, 0, 'fresh station has no belts');

const run = s.placeBeltRun({ tx: r.x1 + 2, ty: r.y1 + 2 }, { tx: r.x1 + 6, ty: r.y1 + 2 });
A.ok(run.ok && run.dir === 'E' && run.count === 5, 'an eastward run lays 5 E belts');
A.eq(s.beltAt(r.x1 + 4, r.y1 + 2), 'E', 'beltAt reads the laid direction');

// a perpendicular run sharing the end tile re-aims that corner tile
const run2 = s.placeBeltRun({ tx: r.x1 + 6, ty: r.y1 + 2 }, { tx: r.x1 + 6, ty: r.y1 + 5 });
A.ok(run2.ok && run2.dir === 'S', 'a downward run lays S belts');
A.eq(s.beltAt(r.x1 + 6, r.y1 + 2), 'S', 'the shared corner tile is re-aimed to the new direction');
A.eq(s.belts().length, 8, 'L-run shares the corner tile (5 + 4 - 1 = 8)');

A.ok(!s.placeBeltRun({ tx: 500, ty: 500 }, { tx: 503, ty: 500 }).ok, 'a run off the deck is rejected');
A.eq(s.placeBeltRun({ tx: 500, ty: 500 }, { tx: 503, ty: 500 }).error, 'OFF_DECK', '...with OFF_DECK');
A.ok(!s.setBelt(r.x1 + 2, r.y1 + 2, 'X').ok, 'a bad direction is rejected');

// belts are WALKABLE (floor machinery) — never block pathing
const g = s.projectGeometry();
A.eq(g.belts.length, 8, 'projectGeometry emits belts in the local frame');
A.ok(g.walkable(r.x1 + 4 - g.origin.tx, r.y1 + 2 - g.origin.ty), 'a belt tile stays walkable (agents cross it)');

// a belt can't sit on a blocking prop
const sp = WM.create(); const sr = sp.roomById(sp.spawnRoomId()).rects[0];
sp.addProp({ t: 'desk', x: sr.x1 + 2, y: sr.y1 + 2, w: 2, h: 1, block: true });
A.eq(sp.setBelt(sr.x1 + 2, sr.y1 + 2, 'E').error, 'ON_PROP', 'a belt is blocked by a solid prop');

// remove + undo/redo + serialize round-trip
A.ok(s.removeBelt(r.x1 + 2, r.y1 + 2).ok, 'removeBelt drops a tile');
A.eq(s.belts().length, 7, 'belt count drops after remove');
s.undo();
A.eq(s.belts().length, 8, 'undo restores the removed belt');
const doc = s.serialize();
A.eq(JSON.stringify(WM.deserialize(doc).serialize()), JSON.stringify(doc), 'belts serialize round-trip identically');

// migrate() drops malformed belt entries without crashing
const mig = WM.deserialize({ schema: 'skynet.station', version: 1,
  rooms: { rA: { id: 'rA', kind: 'hab', name: 'A', rects: [{ x1: 0, y1: 0, x2: 5, y2: 5 }] } }, order: ['rA'],
  belts: { '1,1': 'E', 'bad': 'E', '2,2': 'Z', '3,3': 'N' } });
A.eq(mig.belts().length, 2, 'migrate keeps only well-formed "int,int"->E|W|N|S belt entries');

/* ---------- transport sim ---------- */
// L-shaped belt: E from (0,0)->(3,0) then S (3,0)->(3,2). Source at (0,0); open end past (3,2).
const belts = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' },
               { x: 3, y: 0, dir: 'S' }, { x: 3, y: 1, dir: 'S' }, { x: 3, y: 2, dir: 'S' }];
const cv = Conveyor.create();
let now = 0, sawCornerS = false, maxBoxes = 0;
for (let i = 0; i < 700; i++) {
  now += 16; cv.tick(16, now, belts);
  maxBoxes = Math.max(maxBoxes, cv.boxCount());
  // a box on the vertical leg means it took the corner (adopted S) — its tile x is 3, y>0
  if (cv.peekBoxes().some(b => b.x === 3 && b.y >= 1 && b.dir === 'S')) sawCornerS = true;
}
A.ok(maxBoxes > 0, 'the source spawns boxes onto the belt');
A.ok(sawCornerS, 'a box rounds the corner — adopts the next tile’s direction (E→S)');
A.ok(cv.boxCount() <= 80 && maxBoxes <= 80, 'box count stays under the cap (no runaway)');

// boxes sink (despawn) at the open end — a single short belt drains to empty between spawns
const cv2 = Conveyor.create();
const tiny = [{ x: 0, y: 0, dir: 'E' }];   // one tile: source AND open end
let drained = false; now = 0;
for (let i = 0; i < 200; i++) { now += 16; cv2.tick(16, now, tiny); if (i > 20 && cv2.boxCount() === 0) drained = true; }
A.ok(drained, 'boxes sink off an open end (the belt drains, not accumulates)');

// pulling the belt out from under a box sinks it (no orphan rides)
const cv3 = Conveyor.create();
now = 0; for (let i = 0; i < 60; i++) { now += 16; cv3.tick(16, now, belts); }
const had = cv3.boxCount();
for (let i = 0; i < 40; i++) { now += 16; cv3.tick(16, now, []); }   // belts gone
A.ok(had > 0 && cv3.boxCount() === 0, 'removing all belts sinks every riding box');

A.report('conveyor');
