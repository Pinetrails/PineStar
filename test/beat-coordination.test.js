/* node test/beat-coordination.test.js — locks the HEADLINE Slice 3 behavior: the ongoing suggestion and the
   curiosity nudge share ONE post-run beat slot and never both fire on the same task (anti-nag coordination).

   Two layers, because the arbiter itself lives in chat.js (DOM/flow code, not node-loadable):
     1. SOURCE GUARD (idiomatic here, like lint-emits.js): chat.js's post-run slot must consult
        SuggestStore.willSuggest() BEFORE CuriosityStore.consider(), and early-return when an idea fires — so a
        precedence inversion (which would let both fire) is caught.
     2. BEHAVIORAL: with the REAL SuggestStore, a due idea makes willSuggest() true (curiosity stands down) and a
        "nothing new" state makes it false (curiosity proceeds) — the mutual-exclusion contract chat.js relies on. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

/* ---------- 1. source guard: cede to a due suggestion BEFORE curiosity, then return ---------- */
const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const iSuggest = chatSrc.indexOf('SuggestStore.willSuggest()');
const iCuriosity = chatSrc.indexOf('CuriosityStore.consider()');
A.ok(iSuggest > 0, 'chat.js consults SuggestStore.willSuggest() in the post-run beat slot');
A.ok(iCuriosity > 0, 'chat.js still consults CuriosityStore.consider()');
A.ok(iSuggest < iCuriosity, 'a due suggestion is checked BEFORE curiosity (it takes the one beat; curiosity stands down)');
A.ok(/SuggestStore\.fire\(\);\s*return;/.test(chatSrc.slice(iSuggest, iCuriosity)), 'a due suggestion fires and RETURNS, so curiosity never also runs that task');
// Slice 5: a seed offer sits BETWEEN suggestion and curiosity, with the same early-return discipline.
const iSeed = chatSrc.indexOf('SeedStore.willPropose()');
A.ok(iSeed > 0, 'chat.js consults SeedStore.willPropose() in the post-run beat slot');
A.ok(iSuggest < iSeed, 'a seed offer is checked AFTER suggestion (suggestion keeps priority)');
A.ok(iSeed < iCuriosity, 'a seed offer is checked BEFORE curiosity (seed takes the one beat over a get-to-know-you ask)');
A.ok(/SeedStore\.propose\(\);\s*return;/.test(chatSrc.slice(iSeed, iCuriosity)), 'a seed offer fires and RETURNS, so curiosity never also runs that task');
// the whole gentle-nudge slot stands down when a focused Dialogue panel (First Pitch / awakening / tutorial) is open.
const iWire = chatSrc.indexOf('function wireCuriosity');
A.ok(iWire > 0 && chatSrc.slice(iWire, iSuggest).indexOf('Dialogue.isOpen') >= 0, 'wireCuriosity stands down when a focused Dialogue panel is open (guard before any gentle nudge)');
// Slice 8 minors (chat.js is DOM-flow, not node-loadable — locked at the source like the guards above):
// the post-run slot fires ONLY for the HERO's runs — a summoned worker's clean run must not trigger a hero nudge.
A.ok(iWire > 0 && /\(p\.agentId\s*\|\|\s*'agent'\)\s*!==\s*'agent'\)\s*return;/.test(chatSrc.slice(iWire, iWire + 700)), 'wireCuriosity early-returns for a non-hero agentId (a summoned worker run fires no hero nudge)');
// a new gentle beat retires any prior unanswered one (no cross-run nudge stacking), and clearNudge is exported
// so the First Pitch can retire a live nudge before its focused panel opens over it.
const iCurNudge = chatSrc.indexOf('function curiosityNudge');
const iGentle = chatSrc.indexOf('function nudge(');
A.ok(iCurNudge > 0 && /clearNudge\(\);/.test(chatSrc.slice(iCurNudge, iCurNudge + 220)), 'curiosityNudge retires a prior nudge before creating a new one');
A.ok(iGentle > 0 && /clearNudge\(\);/.test(chatSrc.slice(iGentle, iGentle + 220)), 'the gentle nudge() retires a prior nudge before creating a new one');
A.ok(/return\s*\{[^}]*\bclearNudge\b/.test(chatSrc), 'clearNudge is exported (so pitchstore can retire a live nudge before the First Pitch panel opens)');

/* ---------- 2. behavioral: the real SuggestStore decision drives the mutual exclusion ---------- */
global.Pitch = require('../frontend/app/pitch.js');
const mem = {};
global.localStorage = { getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const bus = A.makeBus(); global.U = { bus };
let dsFam = 0.4; const dsKnown = ['goals', 'identity'];
global.DossierStore = { summary: () => ({ known: dsKnown, blank: ['stack'], familiarity: dsFam }) };
let pitchDoneFlag = true; global.PitchStore = { done: () => pitchDoneFlag };
global.Recipes = { list: () => [], get: () => null, requiredMissing: () => [] };
global.Chat = { nudge() {}, isBusy: () => false };
global.Harness = { chat() { return Promise.resolve({ text: 'PITCH: x\nBUILD: workflow' }); } };
const { SuggestStore } = require('../frontend/app/suggeststore.js');
SuggestStore.init({ getSystem: () => 'SYS', getCaps: () => [], getRecentTask: () => '', launchRecipe: () => {}, launchDirective: () => {} });

// a faithful copy of chat.js's arbiter precedence (locked above by the source guard): a due idea takes the beat;
// otherwise curiosity is consulted. We don't call the async fire() here — the precedence is a synchronous decision.
let curiosityConsulted = false;
let stubSeedWill = false, seedProposed = false;   // a stub seed gate (real SeedStore behavior is locked in seedstore.test.js)
function postRunBeat() {
  curiosityConsulted = false; seedProposed = false;
  if (SuggestStore.willSuggest()) return 'suggestion';   // (chat.js calls SuggestStore.fire(); return; here)
  if (stubSeedWill) { seedProposed = true; return 'seed'; }   // (chat.js calls SeedStore.propose(); return; here)
  curiosityConsulted = true;                              // (chat.js falls through to CuriosityStore.consider())
  return 'curiosity';
}

// drive the store "due": establish the post-graduation baseline (0.4), then grow (0.6) past the task cooldown
SuggestStore.reset();
bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });   // counter 1, baseline := 0.4
dsFam = 0.6;
bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });   // counter 2
bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });   // counter 3 → cooldown met
A.eq(SuggestStore.willSuggest(), true, 'an idea is due after the dossier grew + the cooldown passed');
A.eq(postRunBeat(), 'suggestion', 'a due idea takes the one post-run beat');
A.eq(curiosityConsulted, false, 'curiosity stands down when an idea fires (never both on one task)');

// nothing new learned → the idea stands down and curiosity gets the beat
SuggestStore.reset();
dsFam = 0.4;
bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });   // baseline := 0.4
bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });
bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });   // cooldown met, but no growth
A.eq(SuggestStore.willSuggest(), false, 'no idea when nothing new was learned');
A.eq(postRunBeat(), 'curiosity', 'curiosity proceeds when no idea is due');
A.ok(curiosityConsulted, 'curiosity is consulted when the suggestion stands down');

/* ---------- 3. the 4-way precedence: suggestion > seed > curiosity, one beat per task ---------- */
// (SuggestStore.willSuggest() is false here — the "nothing new" state above.)
stubSeedWill = true;
A.eq(postRunBeat(), 'seed', 'when no idea is due but a seed is ripe, the seed takes the beat');
A.eq(curiosityConsulted, false, 'curiosity stands down when a seed fires (never both on one task)');
// suggestion still outranks a ripe seed
dsFam = 0.6; bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });   // make an idea due again
A.eq(SuggestStore.willSuggest(), true, 'an idea is due again');
A.eq(postRunBeat(), 'suggestion', 'a due suggestion outranks a ripe seed (suggestion keeps priority)');
A.eq(seedProposed, false, 'the seed stands down when a suggestion fires');
stubSeedWill = false;

/* ---------- 4. G2.4: the rate-the-work control can never STARVE (source guards, same idiom as §1) ----------
   Rating is the PRIMARY leveling input (XP law), so every path where the turn-in "owns the moment" (or a
   focused panel holds the slot) must still funnel an unrated run into the standalone beat: an empty
   proposal fetch, an off-stream batch (notify-only), a deck the Commander finished without rating, and
   a tutorial/intake panel blocking the 650ms moment. */
const iMaybe = chatSrc.indexOf('function maybeStandaloneRate');
A.ok(iMaybe > 0, 'chat.js defines maybeStandaloneRate (the one funnel for a starved rating)');
A.ok(/workRatedRuns\.has\(runId\)/.test(chatSrc.slice(iMaybe, iMaybe + 500)), 'maybeStandaloneRate never double-asks a rated run');
A.ok(/\.cmsg\.work-rate/.test(chatSrc.slice(iMaybe, iMaybe + 2200)), 'maybeStandaloneRate never stacks a second live rate ask (one at a time)');
A.ok(/Dialogue\.isOpen/.test(chatSrc.slice(iMaybe, iMaybe + 2200)) && /'blocked'/.test(chatSrc.slice(iMaybe, iMaybe + 2200)),
  'a focused panel is a TRANSIENT block (retryable), not a permanent stand-down');
// the self-retrying fallback: armed at run end BEFORE any stand-down guard, retries while blocked
const iArm = chatSrc.indexOf('function armRateFallback');
A.ok(iArm > 0, 'chat.js defines the armRateFallback retry loop');
A.ok(/'blocked'\s*&&\s*left > 0\)\s*attempt\(left - 1\)/.test(chatSrc.slice(iArm, iArm + 800)),
  'the fallback re-attempts while transiently blocked (a tutorial panel delays, never starves, the rating)');
const iRunEnd = chatSrc.indexOf('armRateFallback(p.agentId');
const iBusyGuard = chatSrc.indexOf('if (isBusy() || interview) return;', iWire);
A.ok(iRunEnd > iWire && iBusyGuard > 0 && iRunEnd < iBusyGuard,
  'the fallback is armed BEFORE the post-run slot\'s stand-down guards (a blocked moment cannot skip arming)');
// hole 1: proposed-but-empty batch — the early return must rate first
A.ok(/if \(!proposals\.length\) \{ maybeStandaloneRate\(agentId, runId\); return; \}/.test(chatSrc),
  'an EMPTY proposal batch (turn-in stood the slot down, then never rendered) still fires the standalone rate beat');
// hole 3: a batch on a non-displayed stream is notify-only — the rating must not vanish with it
const iNotify = chatSrc.indexOf('memories to review');
A.ok(iNotify > 0 && /maybeStandaloneRate\(agentId, runId\)/.test(chatSrc.slice(iNotify, iNotify + 400)),
  'an off-stream (notify-only) batch still fires the standalone rate beat');
// hole 2: a deck decided without rating — finishBatch must hand the rating to the standalone beat
const iFinish = chatSrc.indexOf('function finishBatch');
A.ok(iFinish > 0 && /maybeStandaloneRate\(batch\.agentId \|\| 'agent', batch\.runId\)/.test(chatSrc.slice(iFinish, iFinish + 600)),
  'a turn-in deck that vanishes unrated hands the rating to the standalone beat');

A.report('beat-coordination.test');
