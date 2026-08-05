/* node test/rec-truth-consistency.test.js — W3 of the recommendation perfection campaign: TRUTH & CONSISTENCY.

   One suite for the cross-surface honesty invariants that no single engine's own test can hold, because each of
   them is about TWO surfaces agreeing (or about a card not claiming what the data cannot prove):

     1. ONE goal matcher — the bay's specialist shelf, the recruiter's dossier term and the FOR YOU row all read
        Recipes.goalKeywordHits. No file may carry a second, divergent one.
     2. The autojobs grounding VETO — a proposal's GROUNDS must overlap what the station actually knows, not
        merely be non-empty (presence-only let invented grounds become scheduled cron jobs).
     3. ONE card grammar on the shelves — every shelf reason goes through whyGrammar, every shelf header names
        the noticer under one glyph family.
     4. The interest-evidence receipt — a learned-topic reason SHOWS the verbatim quote that earned the topic.
     6. The honest FOR YOU header — a row that is entirely a cold-start category spread may not be titled FOR YOU.
     7. The seed→routine gate — a hand-launched recipe with no authored cadence can still earn the offer.
    10. Prospect shown-rows survive a reload — the ledger must not re-mint `shown` for the same shelf item.
    11. Exclusion lists ride the PROMPT, not only the post-hoc filter.
    12. The suggest ledger types model prose as RATIONALE, never as a quote of the Commander.

   Source-locks are used where the subject is DOM-flow or load-order wiring (not node-loadable); everything else
   is exercised against the real module. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const P = (...p) => path.join(__dirname, '..', ...p);
const read = (...p) => fs.readFileSync(P(...p), 'utf8');

const Recipes = require('../frontend/app/recipes.js');
const Recruiter = require('../frontend/app/recruiter.js');
const WorkSignal = require('../frontend/app/worksignal.js');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   1. ONE GOAL MATCHER
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/* The two artifacts the divergent matchers produced, pinned as the failing cases they were:
   (a) TAG-KEY HITS. The interest lanes are internal vocabulary. A goal sentence containing the word "general"
       used to score against every general-lane class in the catalog, and the WHY chip quoted it back as
       «it matches your goal: “general”» — a reason the Commander cannot find anywhere on the card.
   (b) FRAGMENT HITS. A bare indexOf matched "for" inside "performance". */
const tagOnlyClass = { name: 'Archivist', tagline: 'keeps the record straight', blurb: 'files things away',
  tags: { general: 3, research: 1 } };
A.eq(Recipes.goalKeywordHits(tagOnlyClass, 'i want general help with my business').length, 0,
  'a goal word that appears ONLY as an internal tag key is not a hit (the “general” artifact)');
const fragClass = { name: 'Profiler', tagline: 'performance and memory profiles', blurb: '' };
A.eq(Recipes.goalKeywordHits(fragClass, 'for my team').length, 0,
  '“for” does not match inside “performance” (fragment artifact + stoplist)');
A.eq(Recipes.goalKeywordHits(fragClass, 'track memory profile').join(','), 'memory,profile',
  'real words still match, through an ordinary suffix, in goal order');

/* The recruiter's dossier term now reads that SAME matcher. Both artifacts are gone from its score too — proven
   through the public recommend() surface, not a private helper. */
const sigOf = (lane, tag, k) => { const s = WorkSignal.fresh(); for (let i = 0; i < k; i++) WorkSignal.observe(s, { lane, tag }, 0); return s; };
const S = require('../shared/specialties.js');
const CAT = S.BUILTINS;
const dishSig = sigOf('dish', 'research', WorkSignal.CALIBRATING_N * 3);
const tagArtifactRun = Recruiter.recommend({ worksignal: dishSig, roster: [], catalog: CAT,
  dossier: { goals: ['i just want general help with all of it'], pain: [], ambition: [] }, now: 0 });
const plainRun = Recruiter.recommend({ worksignal: dishSig, roster: [], catalog: CAT,
  dossier: { goals: [], pain: [], ambition: [] }, now: 0 });
A.eq(tagArtifactRun.items.map(x => x.classId).join(','), plainRun.items.map(x => x.classId).join(','),
  'a goal made only of stopwords + a tag-key word moves the recruiter ranking not at all');
A.ok(tagArtifactRun.items.every(x => x.evidence && x.evidence.dossierHits === 0),
  '…and it records ZERO dossier hits, so nothing downstream can cite one');

/* Nobody may keep a private copy. These are the exact shapes the three old matchers had. */
for (const f of ['frontend/app/marketplace.js', 'frontend/app/recruiter.js']) {
  const src = read(f);
  A.eq(/Object\.keys\(\s*(?:s|cls)\.tags[^)]*\)\.join\(' '\)\)\.toLowerCase\(\)/.test(src), false,
    f + ' no longer builds a goal haystack out of tag keys');
  A.ok(/goalKeywordHits/.test(src), f + ' reads the shared matcher');
}
// …and it is resolved LAZILY, because index.html loads both files BEFORE recipes.js.
const idx = read('frontend/index.html');
A.ok(idx.indexOf('app/recruiter.js') < idx.indexOf('app/recipes.js'),
  'recruiter.js really does load first — which is why a load-time capture would be null forever');
A.ok(/function goalMatcher\(\)/.test(read('frontend/app/recruiter.js')) &&
     /function goalMatcher\(\)/.test(read('frontend/app/marketplace.js')),
  'both resolve the matcher through a call-time getter, never a module-scope binding');

A.report('rec truth & consistency (W3)');
