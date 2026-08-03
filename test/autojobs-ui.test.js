/* node test/autojobs-ui.test.js — source-lock for the SELF-INITIATION entry point in the ROUTINES panel
   (stationui.js). stationui.js is browser-flow (DOM/terminal panels), not node-loadable, so — like
   autonomy-ui.test.js / newhero-reset.test.js — we lock the invariant by reading the source: the ROUTINES panel
   must expose a "propose standing jobs" control that routes through AutoJobStore.propose() and refreshes the list,
   so the manual entry point can never silently disappear or drift off the store API. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/routines.js'), 'utf8');   // ROUTINES window extracted from stationui.js (BUILDERS split)
const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const { AutoJobStore } = require('../frontend/app/autojobstore.js');

// the button exists in the ROUTINES panel.
A.ok(/id="rt-propose"/.test(src), 'the ROUTINES panel has a propose-standing-jobs button (#rt-propose)');
// it routes through the store's propose() (not some ad-hoc path).
A.ok(/AutoJobStore\.propose\(/.test(src), 'the button calls AutoJobStore.propose()');
// it is guarded so a missing store degrades, never throws.
A.ok(/typeof AutoJobStore\s*[!=]==\s*'undefined'/.test(src), 'the handler guards on AutoJobStore being present');
// after scheduling it refreshes the routines list so new jobs appear inline.
A.ok(/AutoJobStore\.propose\([\s\S]{0,200}refresh\(\)/.test(src), 'after proposing it refreshes the routines list');

// E-STOP preserves enabled intent while freezing the global scheduler. Every browser consumer must use BOTH
// facts or it promises work over a durable stop.
A.ok(/schedulerArmed\s*=\s*!!\(j\s*&&\s*j\.enabled\s*&&\s*!j\.halted\)/.test(src),
  'the ROUTINES panel derives runnable scheduler state from enabled and not halted');
A.ok(/const next\s*=\s*on\s*&&\s*schedulerArmed\s*&&\s*j\.nextRunAt\s*\?/.test(src),
  'routine rows show a countdown only while the scheduler is actually runnable');
A.eq(AutoJobStore._cronRunnable({ enabled: true, halted: true }), false,
  'self-initiation confirmations treat E-STOP as not runnable');
A.eq(AutoJobStore._cronRunnable({ enabled: true, halted: false }), true,
  'self-initiation confirmations recognize a genuinely armed scheduler');
A.ok(/j\s*&&\s*j\.halted\s*\?\s*'stopped \(E-STOP\)'/.test(chatSrc),
  '/cron names the durable E-STOP instead of reporting scheduler on');

A.report('autojobs-ui.test');
