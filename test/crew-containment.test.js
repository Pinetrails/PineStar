/* node test/crew-containment.test.js — agent-in-the-void escape (2026-07-12) containment locks.

   THE BUG: rederive() re-framed only the HERO across a station origin shift (a room added/removed
   at the north/west edge moves the whole local pixel frame), so every crew body kept old-frame
   px/py + an old-frame path — rendering it adrift in the void until the next task seized it back.
   Two more holes compounded it: syncCrewFromPlan's no-bays early return skipped the stranded
   re-foot entirely, and nothing at tick time ever checked a body's feet against the floor.

   world.js is a browser IIFE (can't require under node), so — per this repo's world.js test
   pattern (social-border.test.js) — these are SOURCE LOCKS: they pin the wiring that closes each
   hole, so a refactor that drops any layer fails the fast gate with a named reason. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');

// ---- layer 1: rederive() re-frames EVERY crew body across an origin shift, like the hero ----
const red = src.slice(src.indexOf('function rederive('), src.indexOf('function rebake('));
A.ok(red.length > 0, 'rederive() and rebake() both exist (slice is non-empty)');
A.ok(/const cdx = \(oldOrigin\.tx - geo\.origin\.tx\) \* T/.test(red),
  'rederive computes the crew origin-shift delta (cdx) from oldOrigin');
A.ok(/for \(const b of crew\) \{[\s\S]*?b\.px \+= cdx; b\.py \+= cdy;/.test(red),
  'rederive shifts every crew body\'s px/py into the NEW frame');
A.ok(/b\.seatPx \+= cdx; b\.seatPy \+= cdy;/.test(red),
  'the seated render position rides the frame shift too');
A.ok(/if \(b\.home\) \{ b\.home\.x \+= oldOrigin\.tx - geo\.origin\.tx/.test(red),
  'the leash home tile is re-framed (tile delta, not pixel delta)');
A.ok(/b\.pathPts = null; b\.target = null;\s*\/\/ the in-flight path is in the OLD frame/.test(red),
  'crew in-flight paths are dropped on rederive (they were plotted in the OLD frame)');
// the crew re-frame must land BEFORE syncCrewFromPlan's walkable checks see the positions
A.ok(red.indexOf('b.px += cdx') < red.indexOf('syncCrewFromPlan()'),
  'the crew re-frame runs BEFORE syncCrewFromPlan (whose walkable checks need new-frame px/py)');

// ---- layer 2: the no-bays plan still re-foots stranded summoned bodies ----
const sync = src.slice(src.indexOf('function syncCrewFromPlan('), src.indexOf('function sweepAgentMaps('));
A.ok(/if \(geo\) refootStranded\(\);/.test(sync),
  'syncCrewFromPlan\'s no-bays early return still runs refootStranded (the old skip stranded bodies forever)');
A.ok(/refootStranded\(\);\s*\/\/ a refit may have moved the floor/.test(sync),
  'the main syncCrewFromPlan path re-foots stranded summoned bodies');
A.ok(/function refootStranded\(\)/.test(src) && /const f = workerFoot\(\); b\.px = f\.x; b\.py = f\.y; b\.home = tileOf\(f\.x, f\.y\);/.test(src),
  'refootStranded re-foots to a real floor tile AND re-pins the leash home');

// ---- layer 3: per-tick containment backstop — no standing body ever stays off the floor ----
A.ok(/function containBody\(b, now\)/.test(src), 'the containment backstop containBody exists');
const cb = src.slice(src.indexOf('function containBody('), src.indexOf('function stepCrew('));
A.ok(/if \(b\.seated \|\| b\.sitting\) return;/.test(cb),
  'seated/desk-sitting poses are exempt (their logical foot is already on a walkable tile)');
A.ok(/if \(geo\.walkable\(t\.x, t\.y, blocked\)\) return;/.test(cb),
  'a body on real floor is untouched (the backstop is a no-op in the healthy case)');
A.ok(/seizeFromIdle\(b\);/.test(cb),
  'an off-floor body drops its in-flight goal/seat claims before re-homing (they are in a broken frame)');
A.ok(/if \(!f\) f = workerFoot\(\);/.test(cb),
  'truly-in-the-void bodies (no floor in the local ring) re-home to the spawn room');
A.ok(/containBody\(b, now\);/.test(src.slice(src.indexOf('function stepCrew('))),
  'stepCrew runs the backstop on every placed body, every tick');
A.ok(/if \(!agent\.sitting && !agent\.seated\) ensureAgentValid\(\);/.test(src),
  'the HERO gets the same per-tick backstop (ensureAgentValid was rederive-only before)');

A.report('crew-containment.test');
