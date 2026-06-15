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
// L-shaped belt: E from (0,0)->(3,0) then S (3,0)->(3,2). Open end past (3,2).
const belts = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' },
               { x: 3, y: 0, dir: 'S' }, { x: 3, y: 1, dir: 'S' }, { x: 3, y: 2, dir: 'S' }];

// belts NEVER auto-spawn decorative cargo — an idle belt with no enqueued work stays EMPTY
const cvidle = Conveyor.create();
let now = 0;
for (let i = 0; i < 200; i++) { now += 16; cvidle.tick(16, now, belts); }
A.eq(cvidle.boxCount(), 0, 'an idle belt never auto-spawns boxes (quiet until real work rides)');

// an enqueued work-item rounds the corner — adopts each tile’s direction (E→S)
const cv = Conveyor.create();
now = 0; let sawCornerS = false;
cv.enqueueAt(0, 0, { workitemId: 'c1' });
for (let i = 0; i < 400 && !sawCornerS; i++) {
  now += 16; cv.tick(16, now, belts);
  if (cv.peekBoxes().some(b => b.x === 3 && b.y >= 1 && b.dir === 'S')) sawCornerS = true;
}
A.ok(sawCornerS, 'an enqueued box rounds the corner — adopts the next tile’s direction (E→S)');

// a box sinks (despawns) at the open end — the belt drains to empty, never accumulates
const cv2 = Conveyor.create();
const tiny = [{ x: 0, y: 0, dir: 'E' }];   // one tile: source AND open end
cv2.enqueueAt(0, 0, { workitemId: 't1' });
now = 0; let drained = false;
for (let i = 0; i < 200; i++) { now += 16; cv2.tick(16, now, tiny); if (i > 3 && cv2.boxCount() === 0) drained = true; }
A.ok(drained, 'an enqueued box sinks off an open end (the belt drains)');

// pulling the belt out from under a box sinks it (no orphan rides)
const cv3 = Conveyor.create();
cv3.enqueueAt(0, 0, { workitemId: 'o1' }); cv3.enqueueAt(1, 0, { workitemId: 'o2' });
now = 0; for (let i = 0; i < 20; i++) { now += 16; cv3.tick(16, now, belts); }
const had = cv3.boxCount();
for (let i = 0; i < 40; i++) { now += 16; cv3.tick(16, now, []); }   // belts gone
A.ok(had > 0 && cv3.boxCount() === 0, 'removing all belts sinks every riding box');

/* ---------- payload work-items (enqueueAt + onDeliver) ---------- */
// a real work-item box, enqueued at a source, rides to the open end and is delivered exactly once.
const line = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }];
const delivered = [];
const cvp = Conveyor.create({ onDeliver: (bx, x, y) => delivered.push({ id: bx.id, payload: bx.payload, x, y }) });
cvp.enqueueAt(0, 0, { workitemId: 'W1', preview: 'hello' });
cvp.tick(16, 16, line);                                   // first tick drains the pending work-item (no auto-spawn)
const pay = cvp.peekBoxes().filter(b => b.payload);
A.eq(pay.length, 1, 'enqueueAt creates exactly one payload box');
A.eq(cvp.boxCount(), 1, 'and no decorative box rides alongside it (belts are quiet)');
A.ok(pay[0].x === 0 && pay[0].y === 0 && pay[0].payload.workitemId === 'W1', 'the payload box starts at the source carrying its work-item');
now = 16;
for (let i = 0; i < 200 && !delivered.length; i++) { now += 16; cvp.tick(16, now, line); }
A.eq(delivered.length, 1, 'onDeliver fires exactly once for the payload box (ambient cargo never delivers)');
A.eq(delivered[0].payload.workitemId, 'W1', 'onDeliver receives the work-item payload');
A.ok(delivered[0].x === 2 && delivered[0].y === 0, 'delivery happens at the last belt tile (the sink end)');

// enqueueAt on a tile with no belt creates no box and never delivers (no belt path → no crate, work still ran)
let deliveredN = 0;
const cvn = Conveyor.create({ onDeliver: () => deliveredN++ });
cvn.enqueueAt(9, 9, { workitemId: 'W2' });
now = 0; for (let i = 0; i < 50; i++) { now += 16; cvn.tick(16, now, [{ x: 0, y: 0, dir: 'E' }]); }
A.eq(cvn.peekBoxes().filter(b => b.payload).length, 0, 'enqueueAt on a non-belt tile creates no payload box');
A.eq(deliveredN, 0, 'no delivery fires when there is no belt under the work-item');

/* ---------- Stage 2: backpressure spacing + supersede drop ---------- */
const bp = [{ x: 0, y: 0, dir: 'E' }, { x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }, { x: 4, y: 0, dir: 'E' }];
// a trailing work-item holds a backpressure gap behind the leader (crates stack, never overlap)
const cvbp = Conveyor.create();
cvbp.enqueueAt(0, 0, { workitemId: 'A' });
now = 0; for (let i = 0; i < 40; i++) { now += 16; cvbp.tick(16, now, bp); }   // A rides ahead
cvbp.enqueueAt(0, 0, { workitemId: 'B' });
for (let i = 0; i < 30; i++) { now += 16; cvbp.tick(16, now, bp); }
const A_ = cvbp.peekBoxes().find(b => b.payload && b.payload.workitemId === 'A');
const B_ = cvbp.peekBoxes().find(b => b.payload && b.payload.workitemId === 'B');
A.ok(A_ && B_, 'both work-items are riding the belt');
A.ok((A_.x + A_.prog) - (B_.x + B_.prog) >= 0.6, 'the trailing work-item keeps a backpressure gap (no stacking)');

// supersede drop: dropWorkitem early-sinks exactly that box, and it never delivers
const dropped = [];
const cvsd = Conveyor.create({ onDeliver: bx => dropped.push(bx.payload.workitemId) });
cvsd.enqueueAt(0, 0, { workitemId: 'S1' });
now = 0; for (let i = 0; i < 10; i++) { now += 16; cvsd.tick(16, now, bp); }   // S1 riding mid-belt
A.ok(cvsd.peekBoxes().some(b => b.payload && b.payload.workitemId === 'S1' && b.sink <= 0), 'S1 is riding before the drop');
A.ok(cvsd.dropWorkitem('S1'), 'dropWorkitem finds and sinks the riding box');
A.ok(cvsd.peekBoxes().find(b => b.payload && b.payload.workitemId === 'S1').sink > 0, 'S1 is now sinking (dropped off the belt)');
for (let i = 0; i < 40; i++) { now += 16; cvsd.tick(16, now, bp); }   // let it fade out
A.eq(dropped.filter(id => id === 'S1').length, 0, 'a dropped (superseded) box NEVER fires onDeliver');
A.ok(!cvsd.dropWorkitem('S1'), 'dropWorkitem on an already-gone work-item is a no-op');

A.report('conveyor');
