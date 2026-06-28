/* node test/autojobs-ui.test.js — source-lock for the SELF-INITIATION entry point in the ROUTINES panel
   (stationui.js). stationui.js is browser-flow (DOM/terminal panels), not node-loadable, so — like
   autonomy-ui.test.js / newhero-reset.test.js — we lock the invariant by reading the source: the ROUTINES panel
   must expose a "propose standing jobs" control that routes through AutoJobStore.propose() and refreshes the list,
   so the manual entry point can never silently disappear or drift off the store API. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');

// the button exists in the ROUTINES panel.
A.ok(/id="rt-propose"/.test(src), 'the ROUTINES panel has a propose-standing-jobs button (#rt-propose)');
// it routes through the store's propose() (not some ad-hoc path).
A.ok(/AutoJobStore\.propose\(/.test(src), 'the button calls AutoJobStore.propose()');
// it is guarded so a missing store degrades, never throws.
A.ok(/typeof AutoJobStore\s*[!=]==\s*'undefined'/.test(src), 'the handler guards on AutoJobStore being present');
// after scheduling it refreshes the routines list so new jobs appear inline.
A.ok(/AutoJobStore\.propose\([\s\S]{0,200}refresh\(\)/.test(src), 'after proposing it refreshes the routines list');

A.report('autojobs-ui.test');
