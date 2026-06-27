/* node test/interview.test.js — the pure Intake Interview engine (frontend/app/interview.js).
   Locks the Phase-B promises: plan() asks one question per dimension, skips already-known dimensions and
   caps length; beliefFromAnswer() trims, rejects blanks, and stamps source:'interview' on the right
   dimension; questionFor() finds a dimension's question; and EVERY question targets a real dossier
   dimension (the honesty invariant — a typo'd dim would silently drop the belief). Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const I = require('../frontend/app/interview.js');
const D = require('../frontend/app/dossier.js');

/* ---------- the honesty invariant: every question maps to a real dossier dimension ---------- */
for (const q of I.QUESTIONS) {
  A.ok(D.DIM_KEYS.indexOf(q.dim) >= 0, 'question dim "' + q.dim + '" is a real dossier dimension');
  A.ok(typeof q.ask === 'string' && q.ask.length > 0, 'question for "' + q.dim + '" has an ask');
}
// there is exactly one question per dimension, and they cover every dossier dimension
A.eq(I.QUESTIONS.length, D.DIM_KEYS.length, 'one question per dossier dimension');
A.eq(I.QUESTIONS.map(q => q.dim).sort(), D.DIM_KEYS.slice().sort(), 'questions cover every dimension exactly once');

/* every chip is well-formed; skip chips carry an empty value */
for (const q of I.QUESTIONS) {
  for (const c of (q.chips || [])) {
    A.ok(typeof c.label === 'string' && c.label.length > 0, 'chip has a label (' + q.dim + ')');
    A.ok(typeof c.value === 'string', 'chip value is a string (' + q.dim + ')');
    if (c.skip) A.eq(c.value, '', 'a skip chip carries an empty value (' + q.dim + ')');
  }
}

/* ---------- plan(): skip known dimensions, preserve canonical order, cap ---------- */
const full = I.plan({});
A.eq(full.length, I.QUESTIONS.length, 'plan() with no skip asks every question');
A.eq(full.map(q => q.dim), I.QUESTIONS.map(q => q.dim), 'plan() preserves canonical question order');

const partial = I.plan({ skip: ['identity', 'goals'] });
A.eq(partial.map(q => q.dim), ['stack', 'pain', 'ambition', 'style', 'standing_orders'], 'plan() skips already-known dimensions');

A.eq(I.plan({ skip: D.DIM_KEYS }).length, 0, 'plan() asks nothing when every dimension is known');
A.eq(I.plan({ max: 2 }).length, 2, 'plan() honors the max cap');
A.eq(I.plan({ skip: ['identity'], max: 2 }).map(q => q.dim), ['stack', 'goals'], 'plan() applies skip then cap');

/* ---------- beliefFromAnswer(): trims, rejects blanks, stamps provenance ---------- */
const q0 = I.questionFor('stack');
A.ok(q0 && q0.dim === 'stack', 'questionFor finds a dimension question');
A.eq(I.questionFor('nonsense'), null, 'questionFor returns null for an unknown dimension');

const b = I.beliefFromAnswer(q0, '  Rust and a little Go  ');
A.eq(b, { dim: 'stack', text: 'Rust and a little Go', source: 'interview' }, 'beliefFromAnswer trims + stamps dim/source');
A.eq(I.beliefFromAnswer(q0, '   '), null, 'a blank answer yields no belief');
A.eq(I.beliefFromAnswer(q0, ''), null, 'an empty answer yields no belief');
A.eq(I.beliefFromAnswer(q0, null), null, 'a null answer yields no belief');
A.eq(I.beliefFromAnswer(null, 'x'), null, 'no question yields no belief');

/* a belief from the interview actually lands in the right dossier dimension (end-to-end with the engine) */
const dossier = D.fresh();
const belief = I.beliefFromAnswer(I.questionFor('goals'), 'Ship the Commander Dossier');
D.upsert(dossier, belief.dim, { text: belief.text, source: belief.source }, 1);
A.eq(dossier.dims.goals[0].text, 'Ship the Commander Dossier', 'an interview answer upserts into its dossier dimension');
A.eq(dossier.dims.goals[0].source, 'interview', 'the dossier records the interview provenance');

A.report('interview.test');
