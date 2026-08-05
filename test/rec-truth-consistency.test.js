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

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   2. THE AUTOJOBS GROUNDING VETO IS WIRED (the engine's own behaviour lives in autojobs.test.js)
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   The veto only protects anything if the LIVE caller hands it the pool, and hands it the SAME beliefs it
   grounded the directive with. A store that reads beliefs twice, or forgets the second argument, restores the
   presence-only gate silently — the proposals still render, they are just unchecked again. */
const storeSrc = read('frontend/app/autojobstore.js');
A.ok(/const known = beliefs\(\);/.test(storeSrc), 'autojobstore reads the belief map ONCE');
A.ok(/buildProposalDirective\(\{ beliefs: known,/.test(storeSrc), '…grounds the directive with it');
A.ok(/parseProposals\(res\.text, \{ beliefs: known \}\)/.test(storeSrc), '…and vetoes the reply against that same set');
A.eq(/parseProposals\(res\.text\)/.test(storeSrc), false, 'the unchecked one-argument parse is gone from the live path');
// the veto engine is the night shift's, not a second copy
const jobsSrc = read('frontend/app/autojobs.js');
A.ok(/A\.grounded && A\.flattenBeliefs/.test(jobsSrc), 'autojobs borrows autopilot’s grounded()/flattenBeliefs');
A.ok(/if \(!V \|\| !V\.grounded\(grounds, pool\)\) continue;/.test(jobsSrc), '…and drops the block when it does not clear');
A.ok(idx.indexOf('app/autojobs.js') < idx.indexOf('app/autopilot.js'),
  'autojobs.js loads before autopilot.js — which is why the veto engine is resolved at call time');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   3. ONE CARD GRAMMAR + ONE HEADER FAMILY ACROSS EVERY SHELF
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
const mkt = read('frontend/app/marketplace.js');
// the glyph sweep below must read CODE, not the block comment that documents which glyphs were retired.
const mktCode = mkt.replace(/\/\*[\s\S]*?\*\//g, '');
// the two recruiter shelves rendered `it.why` raw — the one place the bay names a real counter was the one
// place it dropped the "because".
A.eq(/\{ s: Specialties\.get\(it\.classId\), why: it\.why \}/.test(mkt), false,
  'no shelf maps a raw recommender reason onto a card any more');
A.eq((mkt.match(/why: whyGrammar\(it\.why\)/g) || []).length, 2,
  'both recruiter shelves (curated + uncovered) speak the shared grammar');
// ONE glyph. The four strays are gone from the shelf headers.
for (const [glyph, was] of [['★', 'RECOMMENDED FOR YOU'], ['◆', 'CURATED FOR YOUR WORKFLOW'], ['◆', 'UNCOVERED'], ['✦', 'DRAFTED FOR YOU']]) {
  A.eq(mktCode.indexOf(glyph + ' ' + was) >= 0, false, 'the “' + glyph + ' ' + was + '” header is gone');
}
A.ok(/function noticedHead\(tail\)/.test(mkt) && /NOTICED' : 'NOTICED'/.test(mkt),
  'the bay composes its earned headers with the SAME eyebrow the COMMS offer card uses');
// …and the noticer is claimed ONLY where something was noticed.
A.ok(/res\.personalized\s*\n?\s*\? noticedHead\(/.test(mkt) || /personalized\s*$/m.test(mkt), 'the specialists shelf gates the eyebrow on its own personalized flag');
A.ok(/coldHead\('STARTING LINEUP/.test(mkt) && /coldHead\('STARTING POINTS/.test(mkt),
  'both cold-start shelves keep the glyph and DROP the noticer claim — a spread noticed nothing');
A.ok(/const coldHead = \(tail\) => '◈ ' \+ tail;/.test(mkt),
  '…structurally: coldHead composes the glyph and nothing else, so a cold shelf CANNOT wear the eyebrow');

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   6. THE FOR YOU HEADER MAY NOT CLAIM A ROW THE RANKER DID NOT PERSONALIZE
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════
   Readiness says the station has learned enough to be ASKED. It does not say THIS row used any of it. */
const catalog = Recipes.list();
const cold = Recipes.rankRecipesExplained(catalog, { limit: 3 });
A.eq(cold.personalized, false, 'no signal at all → the row reports itself as a spread');
A.eq(cold.items.length, 3, '…and still returns a full, varied row (the shelf never empties)');
// a ready-but-silent Commander: dossier filled (so readiness passes) yet the goal text matches no recipe, no
// launches, no topics, no profile. This is the exact shape that used to print "◈ FOR YOU" over catalog order.
const silent = Recipes.rankRecipesExplained(catalog, { limit: 3, goalText: 'i want to be happy and rich', launches: {}, topics: [] });
A.eq(silent.personalized, false, 'a filled dossier whose goal hits nothing is STILL a spread — and says so');
A.eq(silent.items.map(r => r.id).join(','), cold.items.map(r => r.id).join(','), '…the identical spread, in fact');
// one real launch is enough to earn the claim
const earned = Recipes.rankRecipesExplained(catalog, { limit: 3, launches: { [catalog[0].id]: 4 } });
A.eq(earned.personalized, true, 'one REAL launch counter earns the personalized header');
A.eq(earned.items[0].id, catalog[0].id, '…and puts that recipe first');
// the old signature is untouched — every existing caller and test keeps working byte-for-byte
A.eq(Recipes.rankRecipes(catalog, { limit: 3 }).map(r => r.id).join(','), cold.items.map(r => r.id).join(','),
  'rankRecipes still returns the plain array it always did');
A.ok(/const head = \(ready && ranked\.personalized\)/.test(mkt),
  'the shelf gates its header on BOTH readiness and what the ranker actually did');

A.report('rec truth & consistency (W3)');
