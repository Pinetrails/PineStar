/* node test/kitout.test.js — source-level invariants for the kit-out COMPRESSION ("requisition the rest").

   tutorial.js and build.js are browser IIFEs over live DOM/canvas globals (not node-loadable), so — exactly
   like onboarding.test.js / beat-coordination.test.js — the honesty-critical wiring is locked by reading the
   source. THE INVARIANT: a requisitioned prop is a REAL placement through the same validated path as a hand
   placement (object=capability must stay honest — never a flag), and the offer only appears AFTER the
   Commander has placed one piece by hand (the first placement is the lesson; the reps are the chore). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const build = fs.readFileSync(path.join(__dirname, '../frontend/app/build.js'), 'utf8');
const tut = fs.readFileSync(path.join(__dirname, '../frontend/app/tutorial.js'), 'utf8');

/* ---------- build.js: requisition is the REAL path, gated, and fires the same hooks ---------- */
const reqStart = build.indexOf('function requisition(');
A.ok(reqStart >= 0, 'Build.requisition exists');
const reqSeg = build.slice(reqStart, build.indexOf('\n  const api', reqStart));
A.ok(/findPlaceableTile\(/.test(reqSeg), 'requisition places at a VALIDATED tile (findPlaceableTile)');
A.ok(/station\.addProp\(/.test(reqSeg), 'requisition goes through the real station.addProp (object=capability stays honest)');
A.ok(/if\s*\(!running\s*\|\|\s*!station\)/.test(reqSeg), 'requisition refuses when REFIT is not open');
A.ok(/isEditableProp\(t\)/.test(reqSeg), 'requisition refuses editable/config props (no editor popping mid-ceremony)');
A.ok(/Tutorial\.onPropPlaced\)\s*Tutorial\.onPropPlaced\(t\)/.test(reqSeg), 'a requisitioned placement fires the SAME first-touch/kit hook as a hand placement');
A.ok(/requisition\s*[},]/.test(build.slice(build.indexOf('const api'))), 'requisition is exported on the Build api');

/* ---------- tutorial.js: the offer appears only after ONE hand placement; the runner is guarded ---------- */
A.ok(/kitNeeded\.size\s*<\s*KIT\.length[\s\S]{0,120}Build\.requisition/.test(tut),
  'the requisition offer appears only once a needed cap has been placed by hand (size < KIT.length)');
A.ok(/function runRequisition\(\)/.test(tut), 'the requisition runner exists');
const runSeg = tut.slice(tut.indexOf('function runRequisition('), tut.indexOf('function beatKitReady('));
A.ok(/if\s*\(!active\s*\|\|\s*!kitMode\s*\|\|\s*!kitNeeded\)\s*return/.test(runSeg), 'the runner bails when the tour/kit-out is over');
A.ok(/!kitNeeded\.has\(k\.grant\)\)\s*return/.test(runSeg), 'each staggered placement re-checks its grant (a hand placement mid-run is respected, no dupes)');
A.ok(/no clear floor for/.test(runSeg), 'a floor with no valid tile degrades honestly to hand placement (named, not silent)');
A.ok(/setTimeout\(/.test(runSeg), 'placements are staggered so each ✓ + chime reads');

/* ---------- the tutorial hands off to the quest log (the durable "what next" surface) ---------- */
A.ok(/⚑ QUESTS/.test(tut), 'the classic close points at the quest log by name');

A.report('kitout.test');
