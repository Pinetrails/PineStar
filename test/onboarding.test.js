/* node test/onboarding.test.js — source-level honesty invariants for THE AWAKENING (frontend/app/onboarding.js).

   onboarding.js is browser-flow code (an IIFE over World / Chat / Dialogue globals), not node-loadable, so —
   exactly like beat-coordination.test.js and lint-emits.js — we lock its invariants by reading the source.

   THE INVARIANT: every awakening beat that writes a dossier DIMENSION (a `dossierDim` beat, as opposed to a
   `field` beat that authors a .md config doc) must target a REAL dossier dimension. A typo would make
   Dossier.upsert silently reject the answer (unknown-dim guard) — the same "silently drop a belief" failure
   that interview.test.js guards for the intake interview. The PAIN beat (Slice 6) is the first such beat. */
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

/* ---------- the PAIN beat: present, dossier-authored (not a .md doc), and skippable ---------- */
A.ok(dimRefs.indexOf('pain') >= 0, 'the awakening extracts the pain dimension');
const iPain = src.indexOf("dossierDim: 'pain'");
const seg = src.slice(iPain, src.indexOf("field: 'manual'", iPain));   // the pain beat, bounded by the next (manual) beat
A.ok(/build:\s*\(\)\s*=>\s*null/.test(seg), 'the pain beat seeds no .md doc (build:()=>null) — it writes the dossier directly');
A.ok(/optional:\s*true/.test(seg), 'the pain beat is optional/skippable (never traps the Commander on it)');

/* ---------- startQuestions routes a dossierDim answer straight to the station-wide dossier ---------- */
A.ok(/s\.dossierDim\b[\s\S]{0,200}DossierStore\.upsert\(s\.dossierDim/.test(src),
  'startQuestions writes a dossierDim answer straight to DossierStore.upsert');

/* ---------- a recruited (specialty) wake skips the pain beat (the dossier is station-wide, asked once) ---------- */
A.ok(/specialty\s*\?[\s\S]{0,160}!s\.dossierDim/.test(src),
  'a pre-specced wake filters out dossierDim beats (pain is asked once, at the orchestrator awakening)');

A.report('onboarding.test');
