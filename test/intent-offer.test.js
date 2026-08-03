/* node test/intent-offer.test.js — the INTENT OFFER matcher (frontend/app/intentoffer.js).

   The Recruitment Bay + recipe library hold 38 classes and 50 ready-made jobs behind a bottom-bar popover,
   so most of that catalog is never discovered. The intent offer closes the gap from COMMS: when what the
   Commander typed is plainly a class's or a recipe's job, the station says so once, inline.

   The ONLY thing that makes that feature worth shipping is precision — a discovery card that fires on a
   vague match is noise in the one COMMS beat slot, which is strictly worse than the undiscovered feature.
   So this file pins BOTH directions against the REAL live catalog (never a fixture — thresholds must stay
   honest as classes are added):
     1. the asks that MUST produce the right offer,
     2. the chatter that must produce SILENCE,
     3. each gate on its own (query length, corroboration, distinctiveness, the ambiguity margin),
     4. purity — no clock, no rng, no DOM, so the thresholds are reproducible. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const IO = require('../frontend/app/intentoffer.js');
const shared = require('../shared/specialties.js');
const RECIPES = require('../frontend/app/recipe-catalog/index.js');

/* ---------- the candidate surface, built from the LIVE catalog exactly as chat.js builds it ---------- */
// `text` is the matchable surface: name + tagline + blurb + starters/task. Deliberately NOT purpose/manual —
// their shared vocabulary ("the Commander", "Output:", "notebook.write") blurs every class into every other.
function candidates() {
  const out = [];
  for (const c of shared.BUILTINS.concat(shared.ARCHETYPES)) {
    out.push({
      kind: 'class', id: c.id, name: c.name, label: c.tagline,
      headline: c.name + ' ' + c.tagline,
      text: [c.name, c.tagline, c.blurb, (c.starters || []).join(' ')].join(' ')
    });
  }
  for (const r of RECIPES) {
    out.push({
      kind: 'recipe', id: r.id, name: r.name, label: r.tagline || '',
      headline: r.name + ' ' + (r.tagline || ''),
      text: [r.name, r.tagline, r.blurb, r.task].join(' ')
    });
  }
  return out;
}
const C = candidates();
A.ok(C.length >= 80, 'the live catalog surface loaded (' + C.length + ' classes + recipes)');

/* ---------- 1. REAL ASKS land on the RIGHT class ---------- */
// Each of these is a phrasing a Commander would actually type, and each names a class that owns that outcome.
const HITS = [
  ['read this contract before I sign it', 'paralegal'],
  ['can you check this lease for anything that will bite me', 'paralegal'],
  ['help me get my internet bill lowered', 'negotiator'],
  ['I want a refund for this purchase, build me a case', 'negotiator'],
  ['tailor my resume to this job posting', 'jobhunter'],
  ['prep me for an interview next week', 'jobhunter'],
  ['rewrite this so it sounds like me, not like an AI', 'ghostwriter'],
  ['work through this backlog overnight while I sleep', 'nightwatch'],
  ['split this across the crew and run it in parallel', 'foreman'],
  ['find me monetizable opportunities that fit my skills', 'opportunist']
];
for (const [q, id] of HITS) {
  const m = IO.match(q, C);
  A.ok(!!m, 'a real ask produces an offer: "' + q + '"');
  if (m) {
    A.eq(m.id, id, 'the offer names the class that owns the outcome: "' + q + '"');
    A.ok(m.kind === 'class' || m.kind === 'recipe', 'the offer carries its kind');
    A.ok(Array.isArray(m.terms) && m.terms.length > 0, 'the offer reports the terms that earned it (an honest why)');
    // the reason must be REAL: every reported term actually occurs in the Commander's message.
    const asked = IO.terms(q);
    for (const t of m.terms) A.ok(asked.has(t), 'a reported reason term came from the message, not the catalog: ' + t);
  }
}

// naming a class outright is the strongest possible signal — one term is enough when it IS the class's name.
for (const [q, id] of [['i need a paralegal for this', 'paralegal'], ['get me a ghostwriter', 'ghostwriter'], ['can I have a nightwatch', 'nightwatch']]) {
  const m = IO.match(q, C);
  A.ok(!!m && m.id === id, 'naming the class outright offers it: "' + q + '"');
}

/* ---------- 2. CHATTER produces SILENCE (the expensive direction) ---------- */
// A false offer costs the one COMMS beat slot and trains the Commander to ignore the channel. Silence is the
// default and the honest answer.
const QUIET = [
  'hi', 'thanks!', 'ok cool', 'yes please', 'no worries',
  'what do you think',            // 4 raw words, zero content terms
  'explain what you just did',    // hits ONE rare term ("explain") in a blurb — no corroboration
  'hey can you help me out',
  'whats the weather today',
  'summarize this for me',
  'write something',
  'can you do that again',
  'nice, that worked'
];
for (const q of QUIET) A.eq(IO.match(q, C), null, 'chatter stays silent: "' + q + '"');

/* ---------- 3. EACH GATE, on its own (so a future tune can't quietly remove one) ---------- */
// A tiny synthetic corpus makes each gate observable in isolation — the live catalog can't isolate them.
const SYN = [
  { kind: 'class', id: 'alpha', name: 'Alpha', label: 'zebrafish husbandry', headline: 'Alpha zebrafish', text: 'Alpha zebrafish husbandry aquarium breeding' },
  { kind: 'class', id: 'beta', name: 'Beta', label: 'general helper', headline: 'Beta general', text: 'Beta general helper assistant common work' },
  { kind: 'class', id: 'gamma', name: 'Gamma', label: 'general helper too', headline: 'Gamma general', text: 'Gamma general helper assistant common work' }
];
// 3a. QUERY LENGTH: fewer than MIN_QUERY_WORDS raw words can never carry an intent, however rare the word.
A.eq(IO.match('zebrafish', SYN), null, 'a one-word message never offers, even on a unique term');
A.eq(IO.match('zebrafish husbandry', SYN), null, 'a two-word message never offers');
A.ok(IO.MIN_QUERY_WORDS === 3, 'the query-length floor is 3 raw words');
// 3b. CORROBORATION: a lone rare term that is NOT the candidate's name/tagline is not enough.
// idf needs a real corpus to be meaningful (a unique term in a 2-item catalog scores ln(2)=0.69, below every
// floor), so pad with filler candidates — the same size regime the live catalog runs in.
function padded(subject) {
  const out = [subject];
  for (let i = 0; i < 40; i++) {
    out.push({ kind: 'class', id: 'filler' + i, name: 'Filler' + i, label: 'common helper', headline: 'Filler' + i + ' common helper', text: 'Filler' + i + ' common helper assistant ordinary routine work' });
  }
  return out;
}
{
  // the rare term sits only in the BLURB → one hit, no corroboration → silence.
  const blurbOnly = padded({ kind: 'class', id: 'solo', name: 'Solo', label: 'a helper', headline: 'Solo a helper', text: 'Solo a helper that knows about zebrafish somewhere in its blurb' });
  A.eq(IO.match('tell me about zebrafish please', blurbOnly), null, 'one rare BLURB term alone never offers (corroboration required)');
  // the SAME lone term, now the class's own name/tagline → the Commander named the thing outright → offer.
  const named = padded({ kind: 'class', id: 'solo', name: 'Zebrafish', label: 'zebrafish keeper', headline: 'Zebrafish zebrafish keeper', text: 'Zebrafish keeper tanks water' });
  const m = IO.match('tell me about zebrafish please', named);
  A.ok(!!m && m.id === 'solo', 'the same lone term DOES offer when it is the class\'s own name');
}
// 3c. AMBIGUITY MARGIN: two equally-good candidates mean the station does not know — it stays silent.
A.eq(IO.match('i need a general helper assistant', SYN), null, 'two equally plausible candidates produce silence, never a coin flip');
A.ok(IO.MARGIN > 1, 'the winner must beat the runner-up by a real margin');
// 3d. an empty / absent corpus can never offer (a cold catalog is not an excuse to guess).
A.eq(IO.match('read this contract before I sign it', []), null, 'an empty catalog offers nothing');
A.eq(IO.match('read this contract before I sign it', [SYN[0]]), null, 'a single-candidate catalog offers nothing (idf is meaningless)');
A.eq(IO.match('', C), null, 'an empty message offers nothing');
A.eq(IO.match(null, C), null, 'a null message offers nothing');

/* ---------- 4. PURITY: reproducible thresholds (no clock, no rng, no DOM, no storage) ---------- */
const src = fs.readFileSync(path.join(__dirname, '../frontend/app/intentoffer.js'), 'utf8');
A.ok(!/Date\.now|new Date|Math\.random/.test(src), 'the matcher is deterministic (no clock, no rng)');
// match real API USE, not prose — the module's own comments discuss inverse "document frequency".
A.ok(!/document\.|window\.|localStorage|sessionStorage|fetch\(|XMLHttpRequest/.test(src), 'the matcher is pure (no DOM, no storage, no network)');
// same input, same verdict — twice.
{
  const a = IO.match('read this contract before I sign it', C);
  const b = IO.match('read this contract before I sign it', C);
  A.eq(JSON.stringify(a), JSON.stringify(b), 'the same message always yields the same offer');
}

/* ---------- 5. WIRING: the offer is delivered through the SHARED gentle-nudge beat, capped ---------- */
// chat.js must not open a parallel nag channel: the offer rides nudge() (the BeatCard lifecycle: one beat at a
// time, decided beats vanish) and is capped per session, and never fires while a task question owns the moment.
const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
A.ok(/function maybeIntentOffer\(/.test(chat), 'chat.js owns a maybeIntentOffer seam');
const seg = chat.slice(chat.indexOf('function maybeIntentOffer('), chat.indexOf('function maybeIntentOffer(') + 2600);
A.ok(/IntentOffer\.match\(/.test(seg), 'the offer is decided by the pure matcher, never by an inline heuristic');
A.ok(/nudge\(/.test(seg), 'the offer is delivered through the shared gentle-nudge beat (BeatCard lifecycle)');
A.ok(/offersShown|OFFER_CAP/.test(seg), 'the offer is capped per session (anti-nag)');
A.ok(/offeredIds/.test(seg), 'the same class/recipe is never offered twice in a session');
A.ok(/taskQuestionLive\(\)/.test(chat), 'the nudge path stands down while a task question owns the moment');
// the accept must deep-link to a REAL destination, never a dead end.
A.ok(/App\.openClassDossier|App\.openRecipeLaunch/.test(seg), 'accepting deep-links into the bay (class dossier) or the recipe launch form');

A.report('intent-offer');
