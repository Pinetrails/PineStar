/* node test/onboarding.test.js — source-level honesty invariants for THE AWAKENING (frontend/app/onboarding.js).

   onboarding.js is browser-flow code (an IIFE over World / Chat / Dialogue globals), not node-loadable, so —
   exactly like beat-coordination.test.js and lint-emits.js — we lock its invariants by reading the source.

   THE INVARIANT: every awakening beat that writes a dossier DIMENSION (a `dossierDim` beat, as opposed to a
   `field` beat that authors a .md config doc) must target a REAL dossier dimension. A typo would make
   Dossier.upsert silently reject the answer (unknown-dim guard) — the same "silently drop a belief" failure
   that interview.test.js guards for the intake interview. PAIN (Slice 6) and AMBITION (Slice 7) are such beats. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const D = require('../frontend/app/dossier.js');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/onboarding.js'), 'utf8');

/* ---------- every dossierDim beat targets a real dossier dimension (no silent-drop typo) ---------- */
const dimRefs = [...src.matchAll(/dossierDim:\s*'([^']+)'/g)].map(m => m[1]);
A.ok(dimRefs.length > 0, 'the awakening has at least one dossier-dimension beat');
for (const k of dimRefs) A.ok(D.DIM_KEYS.indexOf(k) >= 0, 'awakening dossierDim "' + k + '" is a real dossier dimension');

/* ---------- each dossier-writing beat (pain, ambition): present, dossier-authored (no .md doc), skippable ---------- */
// bound a beat's object literal by the NEXT beat marker (dossierDim: or field:) so a per-beat check can't bleed
// into a sibling beat as more dossierDim beats are added.
function beatSeg(key) {
  const start = src.indexOf("dossierDim: '" + key + "'");
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const nexts = [rest.indexOf('dossierDim:'), rest.indexOf('field:')].filter(i => i >= 0);
  const seg = src.slice(start, nexts.length ? start + 1 + Math.min(...nexts) : src.length);
  // strip line comments — a neighbouring beat's prose (e.g. a comment mentioning "build:()=>null") must NOT
  // satisfy a code check, or the per-beat guard silently stops guarding (caught by the Slice 7 sweep).
  return seg.replace(/\/\/[^\n]*/g, '');
}
for (const key of ['pain', 'ambition']) {
  A.ok(dimRefs.indexOf(key) >= 0, 'the awakening extracts the ' + key + ' dimension');
  const seg = beatSeg(key);
  A.ok(/build:\s*\(\)\s*=>\s*null/.test(seg), 'the ' + key + ' beat seeds no .md doc (build:()=>null) — it writes the dossier directly');
  A.ok(/optional:\s*true/.test(seg), 'the ' + key + ' beat is optional/skippable (never traps the Commander on it)');
}

/* ---------- startQuestions routes a dossierDim answer straight to the station-wide dossier ---------- */
A.ok(/s\.dossierDim\b[\s\S]{0,200}DossierStore\.upsert\(s\.dossierDim/.test(src),
  'startQuestions writes a dossierDim answer straight to DossierStore.upsert');

/* ---------- a recruited (specialty) wake skips the pain beat (the dossier is station-wide, asked once) ---------- */
A.ok(/specialty\s*\?[\s\S]{0,160}!s\.dossierDim/.test(src),
  'a pre-specced wake filters out dossierDim beats (pain is asked once, at the orchestrator awakening)');

A.report('onboarding.test');
