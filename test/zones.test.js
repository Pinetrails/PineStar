/* node test/zones.test.js — the IDLE-CONTAINMENT primitive. Pure geometry: derive the area an
   agent may roam while idle from room rects + props, with zero world/DOM/RNG state.

   Contract under test (plan A2 / invariants I2,I3):
     • an agent anchored inside a room -> a 'room' zone = the SMALLEST enclosing rect
     • an agent on open floor (no enclosing rect) -> a bounded 'leash' zone around the anchor
     • an unassigned / unplaced agent (no anchor) -> null (it does NOT roam)
     • a SOLO agent whose room spans the station -> a LARGE room zone (no regression)
     • inZone(null,..) is false; clampPickable filters candidates to the zone, preserving order. */
'use strict';
const A = require('./_assert.js');
const Z = require('../frontend/app/zones.js');

// ---- the module surface ----
A.ok(typeof Z.computeZone === 'function', 'exports computeZone');
A.ok(typeof Z.inZone === 'function', 'exports inZone');
A.ok(typeof Z.clampPickable === 'function', 'exports clampPickable');

// a tiny station: one big room (z0) and a small side room (z1), LOCAL inclusive rects
const RECTS = [
  { z: 0, x1: 0,  y1: 0,  x2: 20, y2: 12 },   // big main room, area 21*13 = 273
  { z: 1, x1: 22, y1: 0,  x2: 27, y2: 5  },   // small side room, area 6*6 = 36
];
// props: agent 'a1' has a bay foot tile inside the side room; 'a2' has a workstation in the big room
const PROPS = [
  { id: 'p1', t: 'bay',         x: 24, y: 3, w: 1, h: 1, agentId: 'a1' },
  { id: 'p2', t: 'workstation', x: 8,  y: 6, w: 2, h: 1, agentId: 'a2' },
  { id: 'p3', t: 'couch',       x: 5,  y: 5, w: 1, h: 1, agentId: null },   // unbound
];

// ---- room-anchored zone (explicit anchorTile) ----
const zSide = Z.computeZone({ rects: RECTS, props: PROPS, agentId: 'a1', anchorTile: { x: 24, y: 3 } });
A.eq(zSide.kind, 'room', 'agent in the side room gets a room zone');
A.eq(zSide.rect, { x1: 22, y1: 0, x2: 27, y2: 5 }, 'room zone is the enclosing side-room rect');

// the room zone is a COPY, not an alias of the source rect (purity — mutating result must not touch input)
zSide.rect.x1 = 999;
A.eq(RECTS[1].x1, 22, 'computeZone returns a rect COPY — source allRects untouched');

// ---- room-anchored zone resolved from a bound PROP (no explicit anchorTile) ----
const zFromProp = Z.computeZone({ rects: RECTS, props: PROPS, agentId: 'a1' });
A.eq(zFromProp.kind, 'room', 'anchor resolved from the bay prop when no anchorTile given');
A.eq(zFromProp.rect.x1, 22, 'prop-derived anchor lands in the side room');

// agent in the big room
const zMain = Z.computeZone({ rects: RECTS, props: PROPS, agentId: 'a2', anchorTile: { x: 8, y: 6 } });
A.eq(zMain.kind, 'room', 'agent in the big room gets a room zone');
A.eq(zMain.rect, { x1: 0, y1: 0, x2: 20, y2: 12 }, 'big-room zone is the big rect');

// ---- smallest-enclosing tie-break: a nested rect wins over the room it sits in ----
const NESTED = [
  { z: 0, x1: 0, y1: 0, x2: 30, y2: 30 },   // outer, area 31*31
  { z: 1, x1: 5, y1: 5, x2: 9, y2: 9 },     // inner nook, area 5*5 = 25
];
const zNook = Z.computeZone({ rects: NESTED, anchorTile: { x: 7, y: 7 } });
A.eq(zNook.rect, { x1: 5, y1: 5, x2: 9, y2: 9 }, 'tightest enclosing rect wins (the nook, not the hall)');

// ---- leash fallback: anchor on open floor with NO enclosing rect ----
const zLeash = Z.computeZone({ rects: RECTS, anchorTile: { x: 40, y: 40 }, leashR: 4 });
A.eq(zLeash.kind, 'leash', 'no enclosing room -> leash zone');
A.eq(zLeash.cx, 40, 'leash centered on the anchor x');
A.eq(zLeash.cy, 40, 'leash centered on the anchor y');
A.eq(zLeash.r, 4, 'leash honors the supplied radius');

const zLeashDefault = Z.computeZone({ rects: [], anchorTile: { x: 3, y: 3 } });
A.eq(zLeashDefault.kind, 'leash', 'empty rects -> leash');
A.eq(zLeashDefault.r, Z.DEFAULT_LEASH, 'leash falls back to DEFAULT_LEASH when none supplied');

// ---- unassigned / unplaced -> null (no anchor at all) ----
A.eq(Z.computeZone({ rects: RECTS, props: PROPS, agentId: 'ghost' }), null, 'unknown agent with no anchor -> null');
A.eq(Z.computeZone({ rects: RECTS }), null, 'no agentId, no anchorTile, no props -> null');
A.eq(Z.computeZone({}), null, 'empty opts -> null');
A.eq(Z.computeZone(), null, 'no opts -> null');

// ---- SOLO agent whose room spans the station -> a LARGE room zone (no regression / A3,I2) ----
const SOLO_RECTS = [{ z: 0, x1: 0, y1: 0, x2: 63, y2: 47 }];   // whole-floor single room
const zSolo = Z.computeZone({ rects: SOLO_RECTS, anchorTile: { x: 30, y: 24 } });
A.eq(zSolo.kind, 'room', 'solo agent gets a room zone, not a leash');
A.eq(zSolo.rect, { x1: 0, y1: 0, x2: 63, y2: 47 }, 'solo zone spans the whole station rect');
A.ok(Z.rectArea(zSolo.rect) === 64 * 48, 'solo zone is large (whole floor) — rich behavior preserved');
// every corner of the floor is in-zone for the solo agent (no idle beat stripped)
A.ok(Z.inZone(zSolo, 0, 0) && Z.inZone(zSolo, 63, 47) && Z.inZone(zSolo, 63, 0) && Z.inZone(zSolo, 0, 47),
  'solo zone admits all four station corners (gaze-out / vigil unaffected)');

// ---- inZone: room membership (inclusive) ----
A.eq(Z.inZone(null, 5, 5), false, 'inZone(null,..) is false — no zone, no roaming');
A.eq(Z.inZone(zMain, 0, 0), true, 'room corner (0,0) is in-zone (inclusive)');
A.eq(Z.inZone(zMain, 20, 12), true, 'room far corner (20,12) is in-zone (inclusive)');
A.eq(Z.inZone(zMain, 21, 12), false, 'one tile past the east edge is out-of-zone');
A.eq(Z.inZone(zMain, 10, 13), false, 'one tile past the south edge is out-of-zone');
A.eq(Z.inZone(zMain, -1, 5), false, 'negative tile is out-of-zone');

// ---- inZone: leash membership (Chebyshev square) ----
const lz = { kind: 'leash', cx: 10, cy: 10, r: 3 };
A.eq(Z.inZone(lz, 10, 10), true, 'leash center is in-zone');
A.eq(Z.inZone(lz, 13, 13), true, 'leash corner (cx+r,cy+r) is in-zone (Chebyshev)');
A.eq(Z.inZone(lz, 14, 10), false, 'one tile past the leash radius is out-of-zone');
A.eq(Z.inZone(lz, 7, 10), true, 'leash reaches r tiles to the west');
A.eq(Z.inZone(lz, 6, 10), false, 'r+1 to the west is out');

// ---- clampPickable: filter candidates to the zone, preserving order ----
const cands = [
  { x: 0,  y: 0,  tag: 'A' },   // in big room
  { x: 25, y: 2,  tag: 'B' },   // NOT in big room (side room)
  { x: 20, y: 12, tag: 'C' },   // in big room (far corner)
  { x: 50, y: 50, tag: 'D' },   // off-floor
  { x: 5,  y: 5,  tag: 'E' },   // in big room
];
const kept = Z.clampPickable(zMain, cands);
A.eq(kept.map(c => c.tag), ['A', 'C', 'E'], 'clampPickable keeps only in-zone candidates, in original order');

// keyFn extracts the tile from a richer candidate shape
const props2 = [
  { id: 'q1', x: 3,  y: 3 },    // in big room
  { id: 'q2', x: 26, y: 1 },    // side room — out
];
const keptProps = Z.clampPickable(zMain, props2, p => ({ x: p.x, y: p.y }));
A.eq(keptProps.map(p => p.id), ['q1'], 'clampPickable uses keyFn to read each candidate tile');

// null zone / bad input -> empty (caller falls through to an in-place beat)
A.eq(Z.clampPickable(null, cands), [], 'clampPickable(null,..) is empty — nothing to pick, no roaming');
A.eq(Z.clampPickable(zMain, null), [], 'clampPickable with non-array candidates is empty');
A.eq(Z.clampPickable(zMain, []), [], 'clampPickable of an empty list is empty');

// ---- determinism guard: same inputs -> identical output (no RNG/clock inside) ----
const z1 = Z.computeZone({ rects: RECTS, props: PROPS, agentId: 'a1' });
const z2 = Z.computeZone({ rects: RECTS, props: PROPS, agentId: 'a1' });
A.eq(z1, z2, 'computeZone is deterministic — identical inputs yield identical zones');

A.report('zones.test');
