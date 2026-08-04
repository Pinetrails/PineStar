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

/* ---------- 1. source guard: ONE collection pass, ONE arbiter, ONE winner ----------
   The five old agent.run.end offer listeners plus the wireCuriosity if/return ladder are gone: every
   proactive channel now stages a CANDIDATE and the pure spine (recommend.js) decides who speaks. The
   precedence this suite has always protected (suggestion > seed > routine > recruitment > curiosity, one
   beat per task) survives as Recommend.PRIORITY — locked behaviorally in recommend.test.js and asserted
   against the live chat.js wiring here. */
const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const Recommend = require('../frontend/app/recommend.js');
const iPass = chatSrc.indexOf('async function recommendPass');
A.ok(iPass > 0, 'chat.js drives ONE post-run collection pass (the recommendation spine)');
const iWireAnchor = chatSrc.indexOf('function wireCuriosity');
A.ok(iWireAnchor > iPass, 'chat.js still defines wireCuriosity (the single arm point for the pass)');
const passBody = chatSrc.slice(iPass, iWireAnchor);
A.ok(/setTimeout\(\(\) => \{ recommendPass\(p\); \}, BEAT_ARM_MS\)/.test(chatSrc.slice(iWireAnchor, iWireAnchor + 900)),
  'a clean run end arms the pass ONCE (no per-channel arm delays left to race)');

// the pass asks the PURE spine who speaks, and exactly one candidate ever fires
A.ok(/const winner = Recommend\.pick\(cands, recUnderstanding\(\)\);/.test(passBody),
  'the pass ranks every candidate through Recommend.pick (one voice, best-first, or silence)');
A.eq((passBody.match(/winner\.fire\(\)/g) || []).length, 1, 'exactly ONE candidate fires per pass (never two beats)');
A.ok(/if \(!winner\) return;/.test(passBody), 'no citable candidate means SILENCE, not a fallback beat');

// every gentle channel is still consulted, and their old ladder order IS the spine's priority order
A.ok(chatSrc.indexOf('SuggestStore.willSuggest()') > 0, 'chat.js consults SuggestStore.willSuggest()');
A.ok(chatSrc.indexOf('SeedStore.willPropose()') > 0, 'chat.js consults SeedStore.willPropose()');
A.ok(chatSrc.indexOf('RoutineNudgeStore.willPropose()') > 0, 'chat.js consults RoutineNudgeStore.willPropose()');
A.ok(chatSrc.indexOf('RecruiterStore.topPick()') > 0, 'chat.js consults RecruiterStore.topPick()');
A.ok(chatSrc.indexOf('CuriosityStore.consider()') > 0, 'chat.js still consults CuriosityStore.consider()');
const ladder = ['suggest', 'seed', 'routine', 'recruit', 'curiosity'].map(k => Recommend.PRIORITY.indexOf(k));
A.ok(ladder.every(i => i >= 0), 'every gentle channel has a place in the one priority order');
A.eq(ladder, ladder.slice().sort((a, b) => a - b),
  'suggestion > seed > routine > recruitment > curiosity — the ladder precedence survives as PRIORITY');
A.ok(Recommend.PRIORITY.indexOf('suggest') < Recommend.PRIORITY.indexOf('curiosity'),
  'a due suggestion outranks a get-to-know-you question (and only ONE of them can fire)');
// the gentle channels share ONE beat-slot family, so the arbiter itself makes them mutually exclusive
for (const k of ['suggest', 'seed', 'routine', 'recruit', 'curiosity']) {
  A.eq(Recommend.slotKindOf(k), 'nudge', k + ' renders through the one gentle-aside slot');
}

// EVIDENCE OR SILENCE: every candidate builder must cite real state or return null
for (const fn of ['arcCandidate', 'trustCandidate', 'rateCandidate', 'suggestCandidate', 'seedCandidate',
                  'routineCandidate', 'recruitCandidate', 'curiosityCandidate', 'studyCandidate', 'threadCandidate']) {
  const i = chatSrc.indexOf('function ' + fn);
  A.ok(i > 0, 'chat.js defines ' + fn);
  A.ok(/why:/.test(chatSrc.slice(i, i + 1800)), fn + ' carries a why — a channel that cannot cite stays silent');
}

// the whole pass stands down behind a focused panel / onboarding / intake / an unanswered task question
const iMoment = chatSrc.indexOf('function momentBlocked');
A.ok(iMoment > 0 && /studyBlocked\(\) \|\| taskQuestionLive\(\)/.test(chatSrc.slice(iMoment, iMoment + 260)),
  'momentBlocked is the ONE stand-down set (the old study/arc guards + the live-question rule)');
A.ok(/if \(momentBlocked\(\)\) return;/.test(passBody), 'the pass stands down on a blocked moment');
const iBlocked0 = chatSrc.indexOf('function studyBlocked');
A.ok(iBlocked0 > 0 && /Dialogue\.isOpen/.test(chatSrc.slice(iBlocked0, iBlocked0 + 700)),
  'the shared stand-down set includes a focused Dialogue panel (First Pitch / awakening / tutorial)');

// the gentle half stays HERO-ONLY; the rating does not (S1 specialist rate-starve fix, re-locked by order)
A.ok(/if \(gentleOk && isHeroRun\) \{/.test(passBody), 'the gentle-nudge half of the pass is hero-only');
const iArmInPass = passBody.indexOf('armRateFallback(agentId, runId)');
A.ok(iArmInPass > 0 && iArmInPass < passBody.indexOf('if (momentBlocked()) return;'),
  'armRateFallback is armed BEFORE every stand-down guard (a blocked moment cannot skip arming)');
A.ok(passBody.indexOf('rateCandidate(agentId, runId)') > 0
  && passBody.indexOf('rateCandidate(agentId, runId)') < passBody.indexOf('if (gentleOk && isHeroRun)'),
  'the rate candidate is staged before the hero gate (a specialist run can still be rated)');
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
// V3 §6: the shared readiness gate (fail-closed) — this suite is about BEAT COORDINATION, so the gate is open.
global.UnderstandingStore = { readiness: () => ({ ready: true, reasons: [] }) };
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
// bound the window at the function's real end (the fallback's ledger declaration) rather than a magic char count,
// so growing the body's commentary can never silently slide an assertion out of range.
const iMaybeEnd = chatSrc.indexOf('const armedRateRuns', iMaybe);
A.ok(iMaybeEnd > iMaybe, 'maybeStandaloneRate is still followed by the armRateFallback ledger (window anchor)');
const mBody = chatSrc.slice(iMaybe, iMaybeEnd);
A.ok(/workRatedRuns\.has\(runId\)/.test(mBody), 'maybeStandaloneRate never double-asks a rated run');
A.ok(/\.cmsg\.work-rate/.test(mBody), 'maybeStandaloneRate never stacks a second live rate ask (one at a time)');
A.ok(/Dialogue\.isOpen/.test(mBody) && /'blocked'/.test(mBody),
  'a focused panel is a TRANSIENT block (retryable), not a permanent stand-down');
/* S1 SPECIALIST RATE-STARVE. The gate was `agentId !== 'agent' -> 'never'`, so a summoned specialist could only
   ever be rated via a memory turn-in card and stayed Lv 1 forever. A non-hero run is now gated on ITS OWN stream
   being the one on screen (the beat renders into the single shared #chat-log — it must never land a specialist's
   rating in somebody else's transcript), and that gate is TRANSIENT so the fallback still lands it on switch. */
A.ok(!/\(agentId \|\| 'agent'\) !== 'agent'\) return 'never'/.test(mBody),
  'the old hero-only PERMANENT stand-down is gone (it starved every specialist of the primary leveling beat)');
A.ok(/\(agentId \|\| 'agent'\) !== 'agent' && !\(activeWs && \(activeWs\.agentId \|\| 'agent'\) === \(agentId \|\| 'agent'\)\)\) return 'blocked'/.test(mBody),
  'a non-hero run is rateable only while ITS OWN stream is displayed, and the wait is TRANSIENT (retried, never starved)');
// the self-retrying fallback: armed at run end BEFORE any stand-down guard, retries while blocked
const iArm = chatSrc.indexOf('function armRateFallback');
A.ok(iArm > 0, 'chat.js defines the armRateFallback retry loop');
A.ok(/'blocked'\s*&&\s*left > 0\)\s*attempt\(left - 1\)/.test(chatSrc.slice(iArm, iArm + 800)),
  'the fallback re-attempts while transiently blocked (a tutorial panel delays, never starves, the rating)');
// (the arm-before-guards ORDER inside the pass is locked in section 1; here we only re-assert it exists)
const iRunEnd = chatSrc.indexOf('armRateFallback(agentId, runId)');
const iBusyGuard = chatSrc.indexOf('if (momentBlocked()) return;');
A.ok(iRunEnd > 0 && iBusyGuard > 0 && iRunEnd < iBusyGuard,
  'the fallback is armed BEFORE the post-run slot\'s stand-down guards (a blocked moment cannot skip arming)');
// hole 1: proposed-but-empty batch (no deck AND no receipts) — the no-deck branch of routeProposalBatch must
// release any reserved slot and STILL rate (the silent-save UX split receipts from the deck; the RATE guarantee
// is unchanged — a run that reflected but rendered nothing must not silently drop its rating).
const iRoute = chatSrc.indexOf('async function routeProposalBatch');
A.ok(iRoute > 0, 'chat.js defines routeProposalBatch (the shared proposed/write fetch+route)');
A.ok(/if \(reservedSlot\) slotMemoryEmpty\(runId\);\s*maybeStandaloneRate\(agentId, runId\);/.test(chatSrc.slice(iRoute, iRoute + 3400)),
  'an EMPTY/no-deck proposal batch releases the reserved slot and still fires the standalone rate beat');
// hole 3: a batch on a non-displayed stream is notify-only — the rating must not vanish with it
const iNotify = chatSrc.indexOf('to review');
A.ok(iNotify > 0 && /maybeStandaloneRate\(agentId, runId\)/.test(chatSrc.slice(iNotify, iNotify + 400)),
  'an off-stream (notify-only) batch still fires the standalone rate beat');
// hole 2: a deck decided without rating — finishBatch must hand the rating to the standalone beat
const iFinish = chatSrc.indexOf('function finishBatch');
A.ok(iFinish > 0 && /maybeStandaloneRate\(batch\.agentId \|\| 'agent', batch\.runId\)/.test(chatSrc.slice(iFinish, iFinish + 600)),
  'a turn-in deck that vanishes unrated hands the rating to the standalone beat');

/* ---------- 5. P3.1 RE-SUMMON + P3.2 CREW RATEABILITY (source guards, same idiom as §1/§4) ----------
   Both are 👍-triggered post-run consumers riding the SAME rateWork direct hand-off + the SAME one beat slot. */
// P3.1: re-summon rides rateWork like BottleStore, and is MUTUALLY EXCLUSIVE with bottle on a given run — it fires
// ONLY when a bottle offer will NOT (so a single 👍 shows at most one of the two; never a clobber/double-ask).
const iRate = chatSrc.indexOf('function rateWork');
A.ok(iRate > 0, 'chat.js defines rateWork (the 👍/👌/👎 direct mint hand-off)');
const rateBody = chatSrc.slice(iRate, iRate + 6000);
const iBottleCall = rateBody.indexOf('BottleStore.onVerdict');
const iResummonCall = rateBody.indexOf('ResummonStore.onVerdict');
A.ok(iBottleCall > 0 && iResummonCall > 0, 'rateWork hands the verdict to BOTH BottleStore and ResummonStore');
A.ok(iBottleCall < iResummonCall, 'BottleStore is consulted BEFORE ResummonStore (bottle keeps priority for the shared slot)');
A.ok(/bottleWillOffer/.test(rateBody) && /if \(!bottleWillOffer\) ResummonStore\.onVerdict/.test(rateBody),
  're-summon fires ONLY when a bottle offer will NOT (mutually exclusive per 👍 run — never both, never a slot clobber)');
// P3.2: the crew capture is wired at init, and the split rides the SAME memory.feedback mint path per worker.
A.ok(chatSrc.indexOf('wireCrewCapture()') > 0, 'chat.js wires wireCrewCapture at init (records forwarded worker spend)');
A.ok(/function claimCrew/.test(chatSrc), 'chat.js defines claimCrew (attributes forwarded worker ends to a lead run window)');
A.ok(/\/\^sub-\//.test(chatSrc), 'ephemeral team.spawn clones (sub-* ids) are filtered from crew attribution (no persistent identity → never credited)');
const iSplit = rateBody.indexOf('Xp.crewSplit');
A.ok(iSplit > 0, 'rateWork splits a crew run\'s mint via Xp.crewSplit');
A.ok(/XpStore\.onEvent\('memory\.feedback', \{ agentId: wk\.agentId/.test(rateBody),
  'each proven worker\'s share rides the SAME direct memory.feedback mint path under ITS OWN agentId');

A.report('beat-coordination.test');
