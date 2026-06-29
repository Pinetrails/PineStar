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

A.report('harness-internal.test');
