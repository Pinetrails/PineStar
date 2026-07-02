/* node test/goalstore.test.js — GROWTH Tier 2: the live wiring around the pure GOAL-TREE engine (goalstore.js).

   Decisions live in the pure goals.js (tested separately); this verifies the EDGE: the decomposition confirm flow
   (propose → confirm → persist, not-now → re-offer only on belief change), the milestone → work-quest binding, the
   chaining + evidence fold on a completed build, drift retiring, the sidecar mirror, the feedback-loop hooks, the
   one-beat arbiter discipline (memory wins, study second, arc third — behavioral state assertions on the pure
   beat-slot), and the new-hero reset. Mirrors studystore.test.js / workqueststore.test.js. */
'use strict';
const A = require('./_assert.js');
const G = require('../frontend/app/goals.js');
const S = require('../frontend/app/study.js');

// ---- fakes: localStorage, fetch (captures the sidecar mirror), DossierStore beliefs, WorkQuestStore ----
const mem = {};
global.localStorage = { getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.Goals = G;

let goalsBeliefs = [{ id: 'cd_5', text: 'ship a local-first agent harness' }];
global.DossierStore = { beliefs: dim => (dim === 'goals' ? goalsBeliefs.slice() : []) };

// a fake WorkQuestStore: accept() mints an incrementing id; quests() reports each as done when markDone'd.
let wqSeq = 0; const wqDone = {}; const wqAccepts = [];
global.WorkQuestStore = {
  accept: parsed => { wqAccepts.push(parsed); return 'wq:' + (++wqSeq); },
  quests: () => Object.keys(wqDone).map(id => ({ id, status: wqDone[id] ? 'done' : 'open' }))
};

// capture the sidecar mirror + let a POST resolve
const posts = [];
global.fetch = (url, opts) => { posts.push({ url, body: JSON.parse((opts && opts.body) || '{}') }); return Promise.resolve({ ok: true }); };

// a fake Harness returning a fixed decomposition; a launch recorder
let harnessReply = '1. Set up the runtime\n2. Wire the event bus\n3. Build the first agent loop';
const launches = [];
global.Harness = { chat: async () => ({ text: harnessReply, error: false }) };

const { GoalStore } = require('../frontend/app/goalstore.js');

(async () => {
  let clock = 1000;
  GoalStore.init({ now: () => clock, getSystem: () => '', launchDirective: t => launches.push(t) });

  /* ============================ 1. THE DECOMPOSITION CONFIRM FLOW ============================ */

  A.eq(GoalStore.willOfferDecomposition(), true, 'a goals belief with no tree → a decomposition is offerable');
  const pend = GoalStore.pendingDecomposition();
  A.ok(pend && pend.id === 'cd_5', 'pendingDecomposition returns the belief to decompose');
  const proposed = await GoalStore.proposeDecomposition();
  A.ok(proposed && proposed.texts.length === 3, 'proposeDecomposition runs the model + parses 3 milestones');
  A.eq(proposed.belief.id, 'cd_5', 'the proposal carries its source belief');

  // CONFIRM → the tree persists, bound to the belief, and mirrors to the sidecar
  const goal = GoalStore.confirm(proposed.belief, proposed.texts);
  A.ok(goal && goal.sourceBeliefId === 'cd_5', 'confirm persists a goal tree bound to the belief');
  A.eq(goal.milestones.length, 3, 'the confirmed tree holds its milestones');
  A.ok(posts.some(p => p.url === '/api/goals' && p.body.goal && p.body.goal.text.indexOf('harness') >= 0), 'confirm mirrors the active goal to the sidecar (POST /api/goals)');
  // it is now the active goal + surfaces in the projection
  A.ok(GoalStore.activeGoal() && GoalStore.activeGoal().id === goal.id, 'the confirmed goal is the active goal');
  const q1 = GoalStore.quests();
  A.eq(q1[0].kind, 'arc-goal', 'the projection leads with the goal header');
  A.eq(q1.filter(q => q.kind === 'arc-step').length, 3, 'three milestone steps project');

  // once a tree exists for the belief, it is NOT re-offered
  A.eq(GoalStore.willOfferDecomposition(), false, 'a belief that already has a tree is not re-offered');

  /* ============================ 2. NOT-NOW → RE-OFFER ONLY ON BELIEF CHANGE ============================ */

  // a fresh belief with no tree, declined → not re-offered until the belief changes
  goalsBeliefs = [{ id: 'cd_9', text: 'launch a public beta' }];
  A.eq(GoalStore.willOfferDecomposition(), true, 'a new belief with no tree is offerable');
  GoalStore.declineDecomposition(GoalStore.pendingDecomposition());
  A.eq(GoalStore.willOfferDecomposition(), false, 'not-now stops the re-offer for THIS belief state (never nag)');
  // the SAME belief text, unchanged → still not offered
  goalsBeliefs = [{ id: 'cd_9', text: 'launch a public beta' }];
  A.eq(GoalStore.willOfferDecomposition(), false, 'the unchanged belief still does not re-offer');
  // the belief text CHANGES → re-offers (a real change is a new thing to decompose)
  goalsBeliefs = [{ id: 'cd_9', text: 'launch a public beta AND a paid tier' }];
  A.eq(GoalStore.willOfferDecomposition(), true, 'a CHANGED belief re-offers (fingerprint moved)');

  /* ============================ 3. MILESTONE → WORK-QUEST BINDING + CHAINING + EVIDENCE ============================ */

  // accept the front milestone of the active goal (cd_5's) → routes through WorkQuestStore + launches a run
  goalsBeliefs = [{ id: 'cd_5', text: 'ship a local-first agent harness' }];   // restore the tree's live belief
  const m1 = goal.milestones[0].id;
  const accepted = GoalStore.acceptMilestone(goal.id, m1);
  A.ok(accepted && accepted.id === m1, 'acceptMilestone accepts the front milestone');
  A.eq(wqAccepts.length, 1, 'the milestone routed through the work-quest path (WorkQuestStore.accept)');
  A.ok(launches.length >= 1 && launches[launches.length - 1].indexOf(goal.milestones[0].text) >= 0, 'accepting launches a real run for the milestone (no dead gap)');
  A.eq(goal.milestones[0].questRef, 'wq:1', 'the milestone is bound to the work quest');
  // only the CURRENT front milestone is acceptable (honest chaining)
  A.eq(GoalStore.acceptMilestone(goal.id, goal.milestones[1].id), null, 'a non-front milestone cannot be accepted (chaining)');

  // the work quest completes → a clean run.end reconciles: the milestone folds done + writes evidence + chains
  wqDone['wq:1'] = true;
  clock = 2000;
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_a' });
  A.eq(GoalStore.activeGoal().milestones[0].status, 'done', 'completing the REAL work completes the milestone (never a manual tick)');
  A.ok(GoalStore.activeGoal().milestones[0].evidence, 'evidence is written onto the milestone node');
  const q2 = GoalStore.quests();
  A.ok(/1 of 3/.test(q2[0].desc), 'the arc meter advanced to 1 of 3 (honest)');
  const nextStep = q2.filter(q => q.kind === 'arc-step').find(s => s.isNext);
  A.eq(nextStep.milestoneId, goal.milestones[1].id, 'the NEXT milestone surfaces as the front (real chaining)');
  A.ok(posts.some(p => p.url === '/api/goals' && p.body.goal && p.body.goal.done === 1), 'the advanced progress re-mirrors to the sidecar');

  // complete the remaining two → the goal completes
  GoalStore.acceptMilestone(goal.id, goal.milestones[1].id); wqDone['wq:2'] = true;
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_b' });
  GoalStore.acceptMilestone(goal.id, goal.milestones[2].id); wqDone['wq:3'] = true;
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_c' });
  A.eq(GoalStore.activeGoal(), null, 'all milestones done → the goal is done (no active goal left)');
  A.eq(GoalStore.quests().length, 0, 'a done goal projects no active arc');

  /* ============================ 4. FEEDBACK-LOOP HOOKS (§5, additive/fail-open) ============================ */

  const studyNotes = []; let suggestBumped = 0;
  global.StudyStore = { noteGoalProgress: n => studyNotes.push(n) };
  global.SuggestStore = { noteGoalProgress: () => { suggestBumped++; } };
  // a fresh goal + a completed milestone → the study salience note + (on goal-done) the suggest bump fire
  goalsBeliefs = [{ id: 'cd_11', text: 'build a second real feature' }];
  harnessReply = '1. draft the plan clearly\n2. build the core module\n3. wire the ui shell in';
  const g3 = GoalStore.confirm(GoalStore.pendingDecomposition(), (await GoalStore.proposeDecomposition()).texts);
  GoalStore.acceptMilestone(g3.id, g3.milestones[0].id); wqDone['wq:4'] = true;
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_d' });
  A.ok(studyNotes.length >= 1 && studyNotes[0].milestoneText, 'a completed milestone bumps Study salience (goal-progress note)');
  // finish the goal → the suggest gate bump
  GoalStore.acceptMilestone(g3.id, g3.milestones[1].id); wqDone['wq:5'] = true;
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_e' });
  GoalStore.acceptMilestone(g3.id, g3.milestones[2].id); wqDone['wq:6'] = true;
  GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_f' });
  A.ok(suggestBumped >= 1, 'completing the whole goal bumps the suggestion gate (§5 additive OR)');
  delete global.StudyStore; delete global.SuggestStore;

  /* ============================ 5. DRIFT / RETIRE PROPAGATION (through the store) ============================ */

  goalsBeliefs = [{ id: 'cd_20', text: 'a goal that will drift' }];
  harnessReply = '1. first real step now\n2. second real step here\n3. third real step too';
  const g4 = GoalStore.confirm(GoalStore.pendingDecomposition(), (await GoalStore.proposeDecomposition()).texts);
  A.ok(GoalStore.activeGoal() && GoalStore.activeGoal().id === g4.id, 'the new goal is active');
  // the Study engine RETIRES the source belief (dossier.forget) → it's gone from the live beliefs
  goalsBeliefs = [];
  A.eq(GoalStore.syncDrift(), true, 'syncDrift detects the forgotten source belief and retires the goal');
  A.eq(GoalStore.activeGoal(), null, 'a drifted goal is retired (hidden from the active quest log)');
  A.ok(posts.some(p => p.url === '/api/goals' && p.body.goal === null), 'a cleared active arc mirrors null to the sidecar');

  /* ============================ 6. NEW-HERO RESET (own key) ============================ */

  goalsBeliefs = [{ id: 'cd_30', text: 'a goal for the next hero test' }];
  harnessReply = '1. alpha step one\n2. beta step two\n3. gamma step three';
  GoalStore.confirm(GoalStore.pendingDecomposition(), (await GoalStore.proposeDecomposition()).texts);
  A.ok(GoalStore.activeGoal(), 'a goal exists before reset');
  GoalStore.reset();
  A.eq(GoalStore.activeGoal(), null, 'reset clears every goal tree (a new Commander inherits nothing)');
  A.eq(mem['starnet.goals.v1'], undefined, 'reset removes the own localStorage key');

  /* ============================ 7. PERSISTENCE ROUND-TRIP (survives a re-init) ============================ */

  goalsBeliefs = [{ id: 'cd_40', text: 'a persisted goal' }];
  harnessReply = '1. persist step one\n2. persist step two\n3. persist step three';
  const gp = GoalStore.confirm(GoalStore.pendingDecomposition(), (await GoalStore.proposeDecomposition()).texts);
  GoalStore.acceptMilestone(gp.id, gp.milestones[0].id); wqDone['wq:' + wqSeq] = true;
  clock = 9000; GoalStore._onRunEnd({ reason: 'done', agentId: 'agent', runId: 'run_p' });
  const prBefore = GoalStore.quests()[0].desc;
  GoalStore.init({ now: () => clock, getSystem: () => '', launchDirective: t => launches.push(t) });   // re-hydrate from the own key
  A.ok(GoalStore.activeGoal() && GoalStore.activeGoal().id === gp.id, 'the goal tree survives a re-init (persisted, own key)');
  A.eq(GoalStore.quests()[0].desc, prBefore, 'progress + evidence round-trip through persistence');

  /* ====== 8. THE ONE-BEAT DISCIPLINE — BEHAVIORAL (memory wins, study second, arc third) ======
     The arc confirm beat is the LOWEST-priority participant on the pure beat-slot arbiter (Study.makeBeatSlot):
     memory turn-in and study proposals both win the moment before it. We drive the arbiter through the contested
     scenarios and assert the arc can only take a WHOLLY FREE slot and never coexists with another beat. */

  const slot = S.makeBeatSlot();
  // all three pending: memory wins, study cedes to memory, arc cedes to both
  slot.memoryProposed('run_1');
  A.eq(slot.canStudy(), 'memory', 'reflection in flight → study cedes to memory');
  A.eq(slot.canArc(), 'memory', 'reflection in flight → the arc cedes to memory too');
  A.eq(slot.memoryDeck(), 'render', 'the memory deck renders');
  A.eq(slot.canArc(), 'busy', 'a visible memory deck blocks the arc (never two beats)');
  slot.memoryDone('run_1', false);
  // now only study + arc contend: study takes it, arc cedes to the visible study card
  A.eq(slot.canStudy(), 'free', 'the moment is free for study once memory resolves');
  A.eq(slot.canArc(), 'free', 'the moment is also free for the arc when nothing else wants it');
  slot.studyShown();
  A.eq(slot.canArc(), 'busy', 'a visible study card blocks the arc (study wins over arc)');
  A.eq(slot.visibleBeat(), 'study', 'exactly one visible beat: the study card');
  slot.studyDone(false);
  // now the arc may take a wholly free slot; while it is visible, memory/study never stack on it
  A.eq(slot.canArc(), 'free', 'with memory + study both resolved, the arc may take the free moment');
  slot.arcShown();
  A.eq(slot.visibleBeat(), 'arc', 'the arc confirm is the one visible beat');
  A.eq(slot.canStudy(), 'busy', 'a visible arc panel blocks a study card (never two beats)');
  A.eq(slot.canArc(), 'busy', 'a visible arc panel blocks a second arc offer');
  slot.arcDone();
  A.eq(slot.visibleBeat(), null, 'the moment is free again after the arc confirm resolves');
  A.eq(slot.canStudy(), 'free', 'and the pre-Tier-2 memory/study surface is untouched (still free)');

  A.report('goalstore.test');
})();
