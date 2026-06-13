/* one-off layout validator: node test/validate_map.js
   Phase 0.0 wrapper: ONLY the engine-load path is repointed to ../frontend/js/.
   The ported engine files themselves remain byte-for-byte identical to v7. */
'use strict';
const fs = require('fs');
const path = require('path');
const JS = path.join(__dirname, '..', 'frontend', 'js');
global.U = { irnd: (a, b) => a + Math.floor(Math.random() * (b - a + 1)), rnd: (a, b) => a, bus: { on() { } }, pick: a => a[0], hash: () => 0, chance: () => false, clamp: v => v };
let src = fs.readFileSync(path.join(JS, 'map.js'), 'utf8');
const MAP = eval(src + '\nMAP;');

let fail = 0;
const err = m => { fail++; console.log('FAIL: ' + m); };

/* 1. furniture: in-bounds, on floor, no overlaps among blocking pieces */
const seen = {};
for (const f of MAP.furniture) {
  for (let dy = 0; dy < (f.h || 1); dy++) for (let dx = 0; dx < (f.w || 1); dx++) {
    const x = f.x + dx, y = f.y + dy, k = x + ',' + y;
    const z = MAP.zoneGrid[MAP.idx(x, y)];
    if (!z) err(`${f.t} @${k} is off-floor`);
    if (MAP.chamfers.some(([cx, cy]) => cx === x && cy === y)) err(`${f.t} @${k} sits on a chamfered corner`);
    if (!f.deco) {
      if (seen[k]) err(`${f.t} @${k} overlaps ${seen[k]}`);
      seen[k] = f.t;
    }
  }
}

/* 2. every door edge stays usable */
for (const [x1, y1, x2, y2] of MAP.doorDefs) {
  if (!MAP.walkable(x1, y1)) err(`door tile ${x1},${y1} blocked`);
  if (!MAP.walkable(x2, y2)) err(`door tile ${x2},${y2} blocked`);
}

/* 3. stations: chair tile is sittable + path from hub */
const HUB = { x: 34, y: 26 };
if (!MAP.walkable(HUB.x, HUB.y)) err('hub ref tile blocked');
for (const [id, st] of Object.entries(MAP.stations)) {
  if (!MAP.sitTiles[st.x + ',' + st.y]) err(`${id} station ${st.x},${st.y} has no sit furniture`);
  if (!MAP.path(HUB.x, HUB.y, st.x, st.y)) err(`${id} station ${st.x},${st.y} unreachable from hub`);
}

/* 4. social spots reachable */
for (const s of MAP.social)
  if (!MAP.path(HUB.x, HUB.y, s.x, s.y)) err(`social ${s.kind} ${s.x},${s.y} unreachable`);

/* 5. every room still has free floor for wandering */
for (const r of MAP.ROOM_IDS)
  if (!MAP.randomSpotIn(r, 200)) err(`no free spot in ${r}`);

console.log(fail ? `${fail} problem(s)` : 'OK: layout valid - no overlaps, doors clear, all stations & social spots reachable');
process.exit(fail ? 1 : 0);
