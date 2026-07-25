/* test/path-smoothing.test.js — guards the string-pulling smoother in worldmodel.js path().

   path() is a 4-neighbour BFS whose raw output is a staircase of orthogonal tile hops. We smooth it
   (keep the farthest waypoint with clear line of sight, drop the rest) so bodies walk long straight
   runs and true diagonals instead of pivoting 90° at every tile. The danger of any such shortcut is
   that it cuts a corner THROUGH a blocker.

   This test checks that INDEPENDENTLY of how losClear walks the line: it densely samples every
   segment between consecutive waypoints and asks walkable() about the tile under each sample. A
   smoother that clips a wall — or that squeezes through the diagonal gap between two blockers —
   trips this even though its own Bresenham walk thought the segment was clear.

   The model is pure (no DOM / no ambient time or RNG), so it loads with a plain require(). */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');

/* ---- a station with rooms, corridors and scattered blockers (corners + pinch points) ---- */
const s = WM.create();
s.addRoom({ kind: 'lab', rect: { x1: 20, y1: 0, x2: 30, y2: 12 } });
s.placeHallway({ rect: { x1: 18, y1: 3, x2: 19, y2: 4 } });
s.addRoom({ kind: 'storage', rect: { x1: 20, y1: 16, x2: 30, y2: 26 } });
s.placeHallway({ rect: { x1: 24, y1: 13, x2: 25, y2: 15 } });
for (const [x, y] of [[22, 4], [23, 4], [24, 4], [27, 7], [28, 7], [22, 19], [23, 19], [26, 21], [5, 5], [6, 5], [7, 5]]) {
  s.addProp({ t: 'desk', x, y, w: 1, h: 1 });
}

const geo = s.projectGeometry();
const { COLS, ROWS, walkable, path } = geo;

const cells = [];
for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (walkable(x, y, null)) cells.push({ x, y });
A.ok(cells.length > 100, 'fixture station has a substantial walkable area');

/* deterministic pair sampling — the gate must not depend on Math.random */
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const SAMPLES = 120;
let tested = 0, diagonal = 0, violations = 0, endpointMiss = 0, waypoints = 0, manhattan = 0;

for (let n = 0; n < 1200; n++) {
  const a = cells[Math.floor(rnd() * cells.length)];
  const b = cells[Math.floor(rnd() * cells.length)];
  const p = path(a.x, a.y, b.x, b.y, null);
  if (!p || !p.length) continue;
  tested++;
  waypoints += p.length;
  manhattan += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

  let px = a.x, py = a.y;
  for (const w of p) {
    const dx = w.x - px, dy = w.y - py;
    if (dx !== 0 && dy !== 0) diagonal++;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      if (!walkable(Math.round(px + dx * t), Math.round(py + dy * t), null)) { violations++; break; }
    }
    px = w.x; py = w.y;
  }
  if (px !== b.x || py !== b.y) endpointMiss++;
}

A.ok(tested > 500, 'enough reachable pairs exercised (' + tested + ')');
A.eq(violations, 0, 'no smoothed segment ever crosses an unwalkable tile');
A.eq(endpointMiss, 0, 'every smoothed path still ends exactly on its target tile');
A.ok(diagonal > 0, 'smoothing actually produces diagonal segments (a raw 4-neighbour BFS produces none)');
A.ok(waypoints < manhattan, 'smoothing strictly reduces waypoint count vs the orthogonal staircase');

console.log('  ' + tested + ' paths, ' + diagonal + ' diagonal segments, '
  + (manhattan / Math.max(1, waypoints)).toFixed(1) + 'x waypoint compression, 0 wall violations');

A.report('path-smoothing');
