/* node test/pitch.test.js — the pure First Pitch engine (frontend/app/pitch.js).
   Locks the keystone promises: shouldPitch() fires once, only after a real task, only when the station knows
   enough to be confident; buildDirective() hard-constrains the agent to ONE buildable proposal in a strict
   parseable format; parsePitch() reads the reply back tolerantly; choices() is always the confident single
   pitch + a soft out (never a menu); present() carries the famous line. Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/pitch.js');

/* ---------- fresh(): the fire-once persisted flag ---------- */
A.eq(P.fresh(), { v: 1, pitched: false }, 'fresh() starts un-pitched');

/* ---------- shouldPitch(): the graduation gate ---------- */
const ready = { firstTaskDone: true, alreadyPitched: false, knownDims: ['goals', 'identity'] };
A.eq(P.shouldPitch(ready), { go: true, reason: 'ready' }, 'pitches once task is done and it knows enough');
A.eq(P.shouldPitch(Object.assign({}, ready, { alreadyPitched: true })), { go: false, reason: 'already-pitched' }, 'never pitches twice (fire-once)');
A.eq(P.shouldPitch(Object.assign({}, ready, { firstTaskDone: false })), { go: false, reason: 'awaiting-first-task' }, 'no advice before it has done one real task');
A.eq(P.shouldPitch({ firstTaskDone: true, knownDims: ['identity', 'stack'] }), { go: false, reason: 'missing:goals' }, 'cannot pitch a build without knowing the goal');
A.eq(P.shouldPitch({ firstTaskDone: true, knownDims: ['goals'] }), { go: false, reason: 'too-cold' }, 'stays quiet when it barely knows the Commander');
A.eq(P.shouldPitch({}).go, false, 'defensive: empty state never pitches');
A.eq(P.shouldPitch().go, false, 'defensive: no state never pitches, never throws');

// the gate is configurable (the controller can tighten/loosen it)
A.eq(P.shouldPitch({ firstTaskDone: true, knownDims: ['stack', 'style'], requireDims: ['stack'], minKnown: 2 }), { go: true, reason: 'ready' }, 'requireDims + minKnown are honored');
A.eq(P.shouldPitch({ firstTaskDone: true, knownDims: ['goals', 'stack', 'style'], minKnown: 4 }), { go: false, reason: 'too-cold' }, 'a higher minKnown holds the pitch');
A.eq(P.REQUIRE_DIMS, ['goals'], 'goals is the default required dimension');

/* ---------- buildDirective(): one buildable proposal, strict format ---------- */
const dir = P.buildDirective({
  recipes: [{ id: 'morning-brief', name: 'Morning Brief', tagline: 'daily digest' }, { id: 'inbox-triage', name: 'Inbox Triage' }],
  capabilities: [{ id: 'computer', label: 'run code' }, { id: 'dish', label: 'web access' }],
  recentTask: 'wrote a hello file and verified it'
});
A.ok(typeof dir === 'string' && dir.length > 0, 'buildDirective returns a non-empty directive');
A.ok(/exactly one/i.test(dir), 'directive demands exactly one proposal (never a menu)');
A.ok(/buildable|cannot deliver/i.test(dir), 'directive forbids un-buildable fluff');
A.ok(dir.indexOf('recipe:morning-brief') >= 0, 'directive lists the real recipe shelf by id');
A.ok(dir.indexOf('daily digest') >= 0, 'directive carries a recipe tagline when present');
A.ok(/run code/.test(dir) && /web access/.test(dir), 'directive lists the capabilities it actually has');
A.ok(dir.indexOf('wrote a hello file and verified it') >= 0, 'directive references the first task it just did');
A.ok(/PITCH:/.test(dir) && /WHY:/.test(dir) && /BUILD:/.test(dir) && /GAP:/.test(dir), 'directive demands the strict tagged reply format');

// deterministic — same ctx in, byte-identical directive out (cache-warmth + testability)
A.eq(P.buildDirective({ recipes: [{ id: 'x', name: 'X' }] }), P.buildDirective({ recipes: [{ id: 'x', name: 'X' }] }), 'buildDirective is deterministic');
// the recent-task line is omitted cleanly when there was none
A.ok(P.buildDirective({}).indexOf('You just did this') < 0, 'no recent-task line when there is no recent task');
// the recipe shelf is capped so the directive stays lean
const many = Array.from({ length: 12 }, (_, n) => ({ id: 'r' + (n + 1), name: 'R' + (n + 1) }));
const capped = P.buildDirective({ recipes: many, maxRecipes: 8 });
A.ok(capped.indexOf('recipe:r8') >= 0 && capped.indexOf('recipe:r9') < 0, 'buildDirective caps the listed recipes');

/* ---------- parsePitch(): tolerant read-back ---------- */
const good = 'PITCH: a daily crypto-price watcher\nWHY: you said you check prices every morning\nBUILD: recipe:morning-brief\nGAP: which coins you actually care about';
A.eq(P.parsePitch(good), {
  title: 'a daily crypto-price watcher',
  why: 'you said you check prices every morning',
  gap: 'which coins you actually care about',
  build: { kind: 'recipe', recipeId: 'morning-brief' }
}, 'parses a well-formed recipe pitch');

A.eq(P.parsePitch('PITCH: a custom thing\nBUILD: workflow').build, { kind: 'workflow', recipeId: null }, 'a non-recipe pitch is a workflow build');
A.eq(P.parsePitch('here you go!\n  pitch:  lowercase tags work  \n  why: sure').title, 'lowercase tags work', 'parse is case-insensitive and trims surrounding chatter');
A.eq(P.parsePitch('PITCH: just a title').why, '', 'missing optional fields default to empty, not undefined');
A.eq(P.parsePitch('no tagged pitch here'), null, 'unparseable reply → null (caller falls back)');
A.eq(P.parsePitch(''), null, 'empty reply → null');
A.eq(P.parsePitch(null), null, 'null reply → null, never throws');

/* ---------- choices(): the confident single pitch, never a menu ---------- */
const ch = P.choices();
A.eq(ch.length, 2, 'always exactly two choices — commit or a soft out');
A.eq(ch.map(c => c.value), ['build', 'other'], 'the two choices are build + escape hatch');

/* ---------- present(): the famous line, one tested home ---------- */
const line = P.present({ title: 'a watcher', why: 'you check prices daily.', gap: 'which coins' });
A.ok(/i think i know what we should build/i.test(line), 'present() opens with the keystone line');
A.ok(line.indexOf('a watcher') >= 0 && line.indexOf('which coins') >= 0, 'present() carries the title and the gap');
A.ok(P.present({ title: 'x' }).indexOf('the one thing i need') < 0, 'present() omits the gap clause when there is no gap');
A.eq(P.present(null), '', 'present(null) → empty string');
A.eq(P.present({ title: '' }), '', 'present() of a titleless pitch → empty string');

/* ---------- end-to-end: a reply to the real directive parses into an offered recipe ---------- */
const reply = 'PITCH: a morning brief on your project\nWHY: matches your goal\nBUILD: recipe:morning-brief\nGAP: the topic to watch';
const parsed = P.parsePitch(reply);
A.eq(parsed.build.recipeId, 'morning-brief', 'a reply maps cleanly to a recipe the directive offered');

A.report('pitch.test');
