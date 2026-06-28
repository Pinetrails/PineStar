/* node test/autonomy-ui.test.js — source-lock for the AUTONOMY DIAL in the SETTINGS panel (stationui.js).

   stationui.js is browser-flow (DOM/terminal panels), not node-loadable, so — like harness-internal.test.js /
   newhero-reset.test.js — we lock the dial's invariants by reading the source: it must offer every Initiative +
   Reach level the engine defines, WRITE through AutonomyStore (not ad-hoc state), and repaint the honest
   describe() posture line so the panel can never silently drift from the engine. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const Au = require('../frontend/app/autonomy.js');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');

// the dial offers a button for EVERY level on both axes (data-init / data-reach), matching the engine enums — so a
// new rung added to autonomy.js can't be silently missing from the dial.
for (const lvl of Au.INITIATIVE) A.ok(new RegExp('data-init="' + lvl + '"').test(src), 'the dial has an Initiative button for "' + lvl + '"');
for (const lvl of Au.REACH) A.ok(new RegExp('data-reach="' + lvl + '"').test(src), 'the dial has a Reach button for "' + lvl + '"');

// it writes through the store (persisted, single source of truth) and repaints the live honest description.
A.ok(/AutonomyStore\.setInitiative\(/.test(src), 'the dial writes Initiative via AutonomyStore.setInitiative');
A.ok(/AutonomyStore\.setReach\(/.test(src), 'the dial writes Reach via AutonomyStore.setReach');
A.ok(/AutonomyStore\.describe\(\)/.test(src), 'the dial repaints the live describe() posture line (stays honest)');

A.report('autonomy-ui.test');
