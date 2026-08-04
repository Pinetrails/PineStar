/* node test/recqualitystore.test.js — THE OUTCOME LOOP (frontend/app/recqualitystore.js).
   The arithmetic lives in the pure recquality.js (tested separately); this is the live glue, and the thing it
   has to get right is ATTRIBUTION: an accepted offer → the run it spawned → that run's real outcome. Locks:
     - weights start NEUTRAL and are read neutral for an unknown channel (a cold store changes no ranking)
     - an accept that spawns work credits NOTHING until the work produces an outcome (a click is not a result)
     - the stamp is claimed by the FIRST hero run after the accept, never by a worker's run, never twice
     - a clean finish folds a weak positive; a stop/error/limit folds NOTHING (an interrupted run is not the
       suggestion's fault, and the harness cannot honestly say otherwise)
     - the Commander's 👍/👌/👎 on the attributed run is the strong signal; an UNattributed run says nothing
     - weights persist, hydrate clamped, and reset() clears them for a new hero
     - a dud channel gets quieter but is never silenced (the floor holds through the whole live path) */
'use strict';
const A = require('./_assert.js');
global.RecQuality = require('../frontend/app/recquality.js');

const mem = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};
const bus = A.makeBus();
global.U = { bus };

const { RecQualityStore: S } = require('../frontend/app/recqualitystore.js');
const RQ = global.RecQuality;
const NEUTRAL = RQ.Q_START;

S.init({ now: () => 1780000000000 });

/* ── 1. a cold store is NEUTRAL everywhere (it can never change a ranking it has no evidence for) ── */
A.eq(S.weightFor('suggest'), NEUTRAL, 'an unrated channel reads neutral');
A.eq(S.weightFor('suggest', 'goals'), NEUTRAL, 'so does an unrated channel/dimension pair');
A.eq(S.weightFor(''), NEUTRAL, 'so does a nameless channel');
A.eq(S.stampFor('run-nope'), null, 'an unknown run carries no stamp');
A.eq(S.noteVerdict('run-nope', 'great'), null, 'and a verdict on an unattributed run records NOTHING');

/* ── 2. an accept that spawns work credits nothing YET ── */
S.noteAccept({ channel: 'suggest', dim: 'goals', spawnsWork: true, id: 'sugg-1' });
A.eq(S.weightFor('suggest'), NEUTRAL, 'accepting an offer that spawns work is not itself an outcome');
A.ok(S._pending() && S._pending().channel === 'suggest', 'the accept arms a pending attribution stamp');

/* ── 3. the stamp is claimed by the first HERO run, once ── */
A.eq(S.claimForRun('run-w', 'worker-2'), null, 'a summoned worker’s run never claims the Commander’s offer');
A.ok(S._pending(), 'and the pending stamp survives that');
const stamp = S.claimForRun('run-1', 'agent');
A.eq(stamp && stamp.channel, 'suggest', 'the next hero run claims the stamp');
A.eq(stamp && stamp.dim, 'goals', 'the targeted dimension rides with it');
A.eq(S._pending(), null, 'the pending stamp is consumed — a stale accept can never attach to later work');
A.eq(S.claimForRun('run-2', 'agent'), null, 'a subsequent run claims nothing');
A.eq(S.stampFor('run-1').id, 'sugg-1', 'the run remembers WHICH recommendation it came from');

/* ── 4. the run's real outcome folds back ── */
bus.emit('agent.run.end', { runId: 'run-1', reason: 'stopped' });
A.eq(S.weightFor('suggest'), NEUTRAL, 'a STOPPED run folds nothing — the harness cannot blame the offer for it');
bus.emit('agent.run.end', { runId: 'run-1', reason: 'done' });
const afterDone = S.weightFor('suggest');
A.ok(afterDone > NEUTRAL, 'a clean finish is a weak positive');
bus.emit('agent.run.end', { runId: 'run-1', reason: 'done' });
A.eq(S.weightFor('suggest'), afterDone, 'a re-fired run.end cannot double-credit the same completion');
const afterGreat = S.noteVerdict('run-1', 'great');
A.ok(afterGreat > afterDone, 'the Commander’s 👍 on the attributed work is the strong signal');
A.ok(S.weightFor('suggest', 'goals') > NEUTRAL, 'and the dimension it targeted earns with it');
A.eq(S.noteVerdict('run-1', 'shrug'), null, 'an unnamed verdict folds nothing');

/* ── 5. an accept with no trackable work IS the outcome ── */
const before = S.weightFor('study');
S.noteAccept({ channel: 'study', dim: 'pain', spawnsWork: false });
A.ok(S.weightFor('study') > before, 'a kept belief credits its channel immediately (nothing to wait for)');
A.eq(S._pending(), null, 'and arms no stamp');

/* ── 6. declines are real, and a "not now" is milder than a "no" ── */
S.noteDecline({ channel: 'seed' }, true);
const deferred = S.weightFor('seed');
S.reset(); S.init({});
S.noteDecline({ channel: 'seed' }, false);
const declined = S.weightFor('seed');
A.ok(declined < deferred, 'a refusal costs more than a "not now"');
A.ok(deferred < NEUTRAL, 'and both are honest negatives');

/* ── 7. a DUD channel gets quieter — and is never silenced ── */
S.reset(); S.init({});
for (let i = 0; i < 30; i++) {
  S.noteAccept({ channel: 'routine', spawnsWork: true });
  S.claimForRun('r' + i, 'agent');
  S.noteVerdict('r' + i, 'miss');
}
const dud = S.weightFor('routine');
A.ok(dud < NEUTRAL, 'a channel whose work is consistently rated 👎 ranks lower');
A.ok(dud >= RQ.Q_FLOOR, 'but never below the floor — quality alone can NEVER silence a channel');
A.ok(S.weightFor('curiosity') === NEUTRAL, 'and one bad channel never taints another');

/* ── 8. persistence: the earned weights survive, corrupt ones do not ── */
A.ok(mem[S.KEY] && JSON.parse(mem[S.KEY]).ch.routine < NEUTRAL, 'weights self-persist to their own key (no save.js)');
mem[S.KEY] = JSON.stringify({ v: 1, ch: { routine: 0.01, broken: 'x', huge: 99 }, dim: {} });
S.init({});
A.eq(S.weightFor('routine'), RQ.Q_FLOOR, 'a persisted weight below the floor hydrates clamped UP to it');
A.eq(S.weightFor('huge'), RQ.Q_CAP, 'and one above the cap hydrates clamped down');
A.eq(S.weightFor('broken'), NEUTRAL, 'a corrupted entry is dropped, never guessed at');
A.eq(S.stampFor('r1'), null, 'run attribution is in-memory: a reload honestly forgets it rather than inventing it');
S.reset();
A.eq(mem[S.KEY], undefined, 'reset() clears the key — a new hero inherits no channel history');
A.eq(S.weightFor('routine'), NEUTRAL, 'and reads neutral again');

/* ── 9. the store is a READ-ONLY citizen of the event spine ── */
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'recqualitystore.js'), 'utf8');
A.eq(/U\.bus\.emit|bus\.emit/.test(src), false, 'recqualitystore.js NEVER emits on the frozen event contract');
A.ok(/U\.bus\.on\('agent\.run\.end'/.test(src), 'it subscribes to the run lifecycle it needs and nothing more');
A.eq(/document\./.test(src), false, 'it renders nothing — presentation belongs to the card');

/* ── 10. THE WIRING IS REAL (source-lock: chat.js is DOM-flow, not node-loadable) ──
   An injected-store test proves the arithmetic and hides the wiring. These lock the seams the loop dies at. */
const fs = require('fs'), path = require('path');
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
A.ok(/rec: recClaimRun\(id, ws\.agentId \|\| 'agent'\)/.test(chatSrc),
  'the attribution stamp is written onto RUN_META at run start, beside every other piece of run provenance');
const iRate = chatSrc.indexOf('function rateWork');
A.ok(iRate > 0 && /RecQualityStore\.noteVerdict\(runId, verdict\)/.test(chatSrc.slice(iRate, iRate + 7600)),
  'rateWork hands its verdict to the loop DIRECTLY (it never rides the bus)');
const iPass = chatSrc.indexOf('async function recommendPass');
const passBody = chatSrc.slice(iPass, chatSrc.indexOf('function wireCuriosity'));
A.ok(/c\.quality = recQualityOf\(c\.kind, c\.dim\)/.test(passBody), 'the pass hands each candidate its channel’s earned weight');
A.ok(passBody.indexOf('c.quality = recQualityOf') < passBody.indexOf('Recommend.pick(cands'),
  '…before the spine ranks them');
for (const [file, probe, what] of [
  ['frontend/app/suggeststore.js', /noteAccept\(\{ channel: 'suggest', dim: probe \? probe\.dim : '', spawnsWork: true/, 'the suggestion arms a stamp (its accept launches a run)'],
  ['frontend/app/seedstore.js', /noteAccept\(\{ channel: 'seed', spawnsWork: false/, 'a saved seed settles immediately (it authors a recipe, it does not run one)'],
  ['frontend/app/routinenudgestore.js', /noteAccept\(\{ channel: 'routine', spawnsWork: false/, 'a scheduled routine settles immediately'],
  ['frontend/app/chat.js', /recAccept\('study', prop\.dim, false\)/, 'a kept belief settles immediately'],
  ['frontend/app/chat.js', /recAccept\('trust', '', false\)/, 'a granted trust offer settles on the VERIFIED apply'],
  ['frontend/app/chat.js', /recAccept\('curiosity', dim, false\)/, 'an answered curiosity question settles immediately']
]) {
  A.ok(probe.test(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')), what);
}
A.ok(/RecQualityStore\.init\(/.test(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8'))
  && /RecQualityStore\.reset\(\)/.test(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8')),
  'the store is initialised on boot and reset for a new hero');
A.ok(/app\/recqualitystore\.js/.test(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8'))
  && /app\/recquality\.js/.test(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8')),
  'both halves are actually loaded by the page (a module wired only under node is dead in the browser)');

A.report('recqualitystore.test');
