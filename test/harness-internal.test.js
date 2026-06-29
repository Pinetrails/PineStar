/* node test/harness-internal.test.js — source-lock for the internal reason-only BUS SUPPRESSION (Slice 8 MAJOR B).

   The pitch/suggest engines reason via Harness.chat({internal:true}). harness.js must NOT re-emit those calls'
   agent.run.start / agent.run.end on U.bus — otherwise the agent thinking to itself counts as a delivered task in
   XP / tasksDone / FloorStats products / the quest log, and ticks the suggestion cooldown (a truthful-telemetry /
   honest-loot violation). It MUST still re-emit agent.cost so real spend stays honest.

   harness.js is browser-flow (fetch + stream reader), not node-loadable, so — like newhero-reset.test.js and the
   beat-coordination source guard — we lock the invariant by reading the source. The two CALL sites are asserted in
   pitchstore.test.js / suggeststore.test.js (call.internal === true); this locks the harness half. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
const sidecar = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');

// chat() accepts the `internal` flag the callers pass.
A.ok(/function chat\(\{[^}]*\binternal\b[^}]*\}\)/.test(src), 'Harness.chat accepts an `internal` flag');

// the suppression guard is keyed on `internal` and covers BOTH run-lifecycle events — but NOT agent.cost.
const m = /const\s+suppressBus\s*=\s*internal\s*&&\s*\(([^)]*)\)/.exec(src);
A.ok(m, 'a suppressBus guard is keyed on `internal`');
A.ok(/agent\.run\.start/.test(m[1]) && /agent\.run\.end/.test(m[1]), 'suppressBus covers BOTH agent.run.start and agent.run.end');
A.ok(!/agent\.cost/.test(m[1]), 'suppressBus does NOT cover agent.cost — real spend stays honest for internal calls');

// the U.bus re-emit is actually gated on the guard.
A.ok(/if\s*\(\s*!suppressBus\b[\s\S]{0,80}U\.bus\.emit\(/.test(src), 'the U.bus re-emit is gated on !suppressBus');

// Harness self-knowledge: the backend prompt note must be driven by the actual wire tool list, not by
// blanket claims such as "you can always use web/files". The authoritative capability block appears later,
// but the two should not fight each other.
A.ok(/const\s+hasWebTools\s*=/.test(sidecar), 'sidecar derives hasWebTools from the wire tool list');
A.ok(/const\s+hasWriteTools\s*=/.test(sidecar), 'sidecar derives hasWriteTools from the wire tool list');
A.ok(/hasWebTools\s*\?\s*'Ground every current factual claim/.test(sidecar), 'web/source guidance is conditional on web tools');
A.ok(/hasWriteTools\s*\?\s*'Save substantive deliverables/.test(sidecar), 'file-saving guidance is conditional on write tools');
A.ok(!/never say you cannot reach the web or files/.test(sidecar), 'old blanket web/files claim is gone');

// The browser must prefer the same-origin sidecar catalog so local/dev runs get the exact context_length
// the backend already warmed, with direct OpenRouter only as a fallback.
A.ok(src.includes("fetchModelCatalog('/api/models/openrouter', 'models')"), 'Harness.listModels prefers the sidecar OpenRouter catalog');
A.ok(src.includes("fetchModelCatalog(OR + '/models', 'data')"), 'Harness.listModels keeps the direct OpenRouter catalog as fallback');
A.ok(src.includes("params.indexOf('tools') >= 0"), 'Harness.listModels derives tool support from supported_parameters when needed');
A.ok(/saved\s*&&\s*saved\.agent[\s\S]{0,180}Harness\.listModels\(\)/.test(app), 'auto-resume warms the model catalog before entering the game');

// Hermes-style work discipline: task runs should push the model into a stable build loop instead of repeated
// failed path guesses, shell-quoted source rewrites, or syntax-only verification.
A.ok(/const\s+workDisciplineNote\s*=/.test(sidecar), 'sidecar builds a dedicated work-discipline prompt block');
A.ok(/anchor shell_exec\.cwd to that exact folder/.test(sidecar), 'work discipline anchors shell cwd before project commands');
A.ok(/change strategy instead of retrying the same bad path/.test(sidecar), 'work discipline discourages repeated bad path attempts');
A.ok(/Inspect before editing with fs_search\/fs_list\/fs_read/.test(sidecar), 'work discipline requires inspection before editing');
A.ok(/prefer fs_patch for multi-line edits/.test(sidecar), 'work discipline prefers structured patch edits for source changes');
A.ok(/Avoid temporary patch scripts/.test(sidecar), 'work discipline steers away from throwaway patch scripts');
A.ok(/run the narrowest real verification/.test(sidecar), 'work discipline requires targeted verification');
A.ok(/shell_exec background:true/.test(sidecar) && /shell_bg_status/.test(sidecar), 'work discipline checks background dev servers');
A.ok(/browser_navigate plus browser_console\/browser_snapshot\/browser_vision[\s\S]*local\/private dev servers/.test(sidecar), 'work discipline asks browser-capable runs to verify reachable UI/browser behavior without looping on blocked localhost');
A.ok(/Final reports must name changed files, verification commands\/results/.test(sidecar), 'work discipline requires concrete final evidence');

A.report('harness-internal.test');
