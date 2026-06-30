/* node test/newhero-reset.test.js — source-level lock for the new-hero clean slate (Slice 8 #8).

   The whole-build sweep found the new-hero (onWake) path reset only Pitch/Suggest/Seed and silently OMITTED
   CuriosityStore + MintStore, so a second Commander inherited the prior one's waved-off dimensions and recurring-
   task shapes — the latter feeds the seed shelf, so a brand-new agent could offer to author a stranger's chore
   ("you keep asking me to …"), a direct app-lie. Every per-agent advice store MUST be reset on commission.

   app.js is browser-flow (an IIFE over the DOM / sidecar), not node-loadable, so — like beat-coordination.test.js
   / onboarding.test.js — we lock the invariant by reading the source: the onWake new-hero block must call reset()
   on ALL five self-persisting advice stores. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
const i = src.indexOf('async function onWake');
A.ok(i >= 0, 'app.js has an onWake (new-hero commission) path');

// the reset block lives at the head of onWake, before the new agent enters the game.
const enter = src.indexOf('enterGame(', i);
A.ok(enter > i, 'onWake reaches enterGame() (the new-hero path)');
const seg = src.slice(i, enter);

for (const store of ['PitchStore', 'SuggestStore', 'SeedStore', 'CuriosityStore', 'MintStore', 'AutonomyStore', 'AutoJobStore', 'AutopilotStore']) {
  A.ok(new RegExp('\\b' + store + '\\.reset\\(\\)').test(seg),
    'new-hero onWake resets ' + store + ' — no prior-Commander state bleeds into a fresh agent');
}

// SERVER-SIDE bleed: the frontend stores above are localStorage; the notebook + the NEW declined denylist live on
// the sidecar. onWake must ALSO wipe them, or a fresh hero inherits a stranger's kept/declined memories (app-lie).
A.ok(/Harness\.memoryReset\(/.test(seg),
  'new-hero onWake wipes SERVER-SIDE memory (notebook/declined/todo) so no prior-Commander memory bleeds into a fresh agent');

A.report('newhero-reset.test');
