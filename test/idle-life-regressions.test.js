/* node test/idle-life-regressions.test.js — proof locks for the five post-handoff audit fixes.
   Geometry behavior lives in zones.test.js; this file locks the shipped leisure decision and the
   soak/instrumentation clauses that make the live verdict truthful. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const world = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const soak = fs.readFileSync(path.join(__dirname, '../dev/idlesoak.mjs'), 'utf8');

// Extract the actual pure recent-choice predicate from the shipped browser source.
const BEGIN = 'FUN-REPEAT-PURE-BEGIN', END = 'FUN-REPEAT-PURE-END';
const i0 = world.indexOf(BEGIN), i1 = world.indexOf(END);
A.ok(i0 >= 0 && i1 > i0, 'world.js carries the FUN-REPEAT-PURE extraction markers');
const block = world.slice(world.indexOf('*/', i0) + 2, world.lastIndexOf('/*', i1));
A.ok(/function funRecentlyUsed\(/.test(block), 'the marked block holds funRecentlyUsed');
const { funRecentlyUsed } = eval('(function(){' + block + '\nreturn { funRecentlyUsed };})()');
A.eq(funRecentlyUsed('lounge', 100000, 'lounge', 99999), true, 'the same couch is hard-blocked during its cooldown');
A.eq(funRecentlyUsed('lounge', 100000, 'lounge', 100000), false, 'the couch becomes eligible exactly when the cooldown expires');
A.eq(funRecentlyUsed('lounge', 100000, 'arcade-1', 99999), false, 'a different leisure choice remains eligible');
A.ok(/FUN_REPEAT_MIN\s*=\s*90000[\s\S]*FUN_REPEAT_MAX\s*=\s*150000/.test(world), 'repeat exclusion lasts 90–150 seconds');
A.ok(!/c\.w\s*\*=\s*0\.12/.test(world), 'the ineffective weak repeat weighting is gone');

// Render truth: a seated body is measured from where it is drawn, and the counter is identified.
A.ok(/tileOf\(bodyPosX\(b\),\s*bodyPosY\(b\)\)/.test(world), 'facing uses the rendered body position');
A.ok(/facingCounter:\s*!!\(fp\s*&&\s*isCounterProp\(fp\)\)/.test(world), 'body snapshots identify the actual counter prop ahead');
A.ok(/if\s*\(b\.facingCounter\)\s*r\.seatFacingCounter\+\+/.test(soak), 'the soak counts counter-facing stools, not any generic prop');
A.ok(!/b\.facing\s*===\s*['"]prop['"]/.test(soak), 'the false generic-prop counter proxy is gone');

// Harness truth + cleanup: the mixed fixture really distributes destinations across both rooms,
// demands observed crossing, and no early exit can bypass finally cleanup.
A.ok(/for\s*\(let i = 0; i < 8; i\+\+\) for \(const group of spotGroups\) spots\.push\(group\[i\]\)/.test(soak), 'mixed prop spots are interleaved across rooms');
A.ok(/mixed soak requires a real second room/.test(soak), 'mixed mode refuses to grade without a second room');
A.ok(/report\.bodies\.some\(b => b\.nextDoorSamples > 0\)/.test(soak), 'mixed mode requires an observed next-room sample');
A.ok(/floor:\s*builtFloor/.test(soak), 'the report records the floor it actually graded');
A.eq((soak.match(/process\.exit\s*\(/g) || []).length, 1, 'only the final process.exit remains, after finally cleanup');
A.ok(/finally\s*\{[\s\S]*proc\.kill\(\)[\s\S]*side\.kill\(\)/.test(soak), 'Chrome and the seeded sidecar are both killed in finally');

A.report('idle-life-regressions.test');
