/* node test/questrefresh.test.js — the pure quest-refresh engine (sidecar/questrefresh.js, QUEST V3).
   Locks the standing-refresh promises: decide() fires on the 24h cadence and on the caught-up fast path
   (zero open quests past the cooldown) and binds honestly otherwise; parseContract enforces the contract
   rule (no 'run', no unplaceable prop, no unsweepable fact); parse() round-trips a well-formed multi-quest
   reply, dedups against the open slate + the dismissed-forever denylist + earlier blocks in the SAME reply,
   caps at MAX_MINTS_PER_CYCLE, and kills an ungrounded WHY; NONE is a sentinel; reducers are pure + capped;
   the Commander's active goal always outranks an inferred north star at the setNorthStar seam (source flag).
   Deterministic — injected now, no ambient clock. */
'use strict';
const A = require('./_assert.js');
const R = require('../sidecar/questrefresh.js');

const T0 = 1000000000000;
const DAY = R.REFRESH_EVERY_MS;
const GAP = R.CAUGHT_UP_GAP_MS;
const PROPS = ['dish', 'cabinet', 'notebook', 'workbench', 'studio', 'connector', 'computer', 'compute'];

/* ---------- decide: the two triggers + honest bindings ---------- */
let s = R.fresh();
A.ok(R.decide(s, { now: T0, openCount: 5 }).fire, 'a never-cycled state is due (daily clock starts at epoch)');
A.eq(R.decide(s, { now: T0, openCount: 5 }).why, 'daily', 'never-cycled fires as the daily pass');
s = R.stampCycle(s, { now: T0 });
A.eq(R.decide(s, { now: T0 + GAP + 1, openCount: 2 }, ).binding, 'cooldown', 'open quests + inside 24h -> cooldown binds');
A.eq(R.decide(s, { now: T0 + 1, openCount: 0 }).binding, 'gap', 'caught up but inside the cooldown -> gap binds');
const dCaught = R.decide(s, { now: T0 + GAP + 1, openCount: 0 });
A.ok(dCaught.fire, 'caught up past the cooldown fires');
A.eq(dCaught.why, 'caught-up', 'the caught-up fast path is named');
const dDaily = R.decide(s, { now: T0 + DAY + 1, openCount: 9 });
A.ok(dDaily.fire && dDaily.why === 'daily', '24h elapsed fires regardless of open count');

/* ---------- parseContract: the contract rule, enforced at the parse seam ---------- */
A.eq(R.parseContract('prop dish', PROPS), { type: 'prop', key: 'dish' }, 'prop with a placeable key parses');
A.eq(R.parseContract('prop DISH', PROPS), { type: 'prop', key: 'dish' }, 'prop keys normalize case');
A.eq(R.parseContract('prop teleporter', PROPS), null, 'an unplaceable prop key is an uncompletable quest — rejected');
A.eq(R.parseContract('artifact out/plan.md', PROPS), { type: 'artifact', key: 'out/plan.md' }, 'artifact keeps its path key');
A.eq(R.parseContract('artifact', PROPS), null, 'artifact without a path is rejected');
A.eq(R.parseContract('fact ships a video every week', PROPS), { type: 'fact', key: 'ships a video every week' }, 'fact keeps its phrase');
A.eq(R.parseContract('fact ab', PROPS), null, 'a fact key shorter than the sweep minimum can never complete — rejected');
A.eq(R.parseContract('attest', PROPS), { type: 'attest', key: '' }, 'attest carries the empty key (Commander-confirm completes it)');
A.eq(R.parseContract('run r123', PROPS), null, 'run is not in the refresh vocabulary (nothing to bind)');
A.eq(R.parseContract('', PROPS), null, 'empty contract rejected');

/* ---------- buildDirective: evidence + vocabulary + the goal-vs-inference precedence ---------- */
const dirGoal = R.buildDirective({ goalNote: 'Current goal: Launch the channel (1/4 milestones done).', dossierBlock: 'Goals: grow an audience', activityBlock: '• edited episode 3', openQuests: [{ title: 'Write the outline' }], deniedTitles: ['old chore'], propKeys: PROPS });
A.ok(dirGoal.indexOf('ACTIVE GOAL') >= 0 && dirGoal.indexOf('Launch the channel') >= 0, 'an active goal leads the directive as the north star');
A.ok(dirGoal.indexOf('Write the outline') >= 0, 'open slate is shown for dedup');
A.ok(dirGoal.indexOf('old chore') >= 0, 'dismissed-forever titles are shown');
A.ok(dirGoal.indexOf('dish, cabinet') >= 0, 'the honest prop vocabulary is spelled out');
const dirNS = R.buildDirective({ northStar: { text: 'Become a full-time creator' }, propKeys: PROPS });
A.ok(dirNS.indexOf('CURRENT NORTH STAR') >= 0 && dirNS.indexOf('full-time creator') >= 0, 'a prior inferred star is re-shown, not re-derived');
A.ok(R.buildDirective({ propKeys: PROPS }).indexOf('NO NORTH STAR IS KNOWN YET') >= 0, 'a cold state asks for the inference');

/* ---------- parse: round-trip, dedup, grounding, caps, NONE ---------- */
const GROUNDING = 'Goals: grow the youtube channel to sustainable income\n• edited episode 3 of the interview series';
const GOOD = [
  'NORTH_STAR: Grow the channel into a sustainable income',
  'QUEST: Publish episode 3',
  'DESC: Finish the edit and get episode 3 live.',
  'REWARD: a published episode driving the channel forward',
  'CONTRACT: attest',
  'STEPS: final cut; thumbnail; upload',
  'WHY: you edited episode 3 of the interview series this week',
  'QUEST: Automate the research brief',
  'DESC: Stand up the web dish so an agent can compile guest research.',
  'REWARD: research on tap for every episode',
  'CONTRACT: prop dish',
  'WHY: the channel goals need recurring guest research',
  'QUEST: Write the outline',
  'DESC: dup of an open quest.',
  'REWARD: none',
  'CONTRACT: attest',
  'WHY: the channel goals need it'
].join('\n');
const p1 = R.parse(GOOD, { openTitles: ['Write the outline'], deniedTitles: [], propKeys: PROPS, grounding: GROUNDING });
A.eq(p1.none, false, 'a QUEST-bearing reply is not NONE');
A.eq(p1.northStar && p1.northStar.text, 'Grow the channel into a sustainable income', 'north star line parses');
A.eq(p1.quests.length, 2, 'the open-slate duplicate is dropped, the two real quests survive');
A.eq(p1.quests[0].contract, { type: 'attest', key: '' }, 'attest contract rides through');
A.eq(p1.quests[0].steps, [{ key: 's1', label: 'final cut' }, { key: 's2', label: 'thumbnail' }, { key: 's3', label: 'upload' }], 'STEPS split into keyed steps');
A.eq(p1.quests[1].contract, { type: 'prop', key: 'dish' }, 'prop contract clamps to the vocabulary');
A.ok(p1.quests[1].groundedIn.indexOf('guest research') >= 0, 'WHY becomes groundedIn');

// denylist + intra-reply dedup + the per-cycle cap
const DUPED = [
  'NORTH_STAR: x',
  'QUEST: Same title', 'CONTRACT: attest', 'WHY: grow the channel with research',
  'QUEST: Same title', 'CONTRACT: attest', 'WHY: grow the channel with research',
  'QUEST: Old chore', 'CONTRACT: attest', 'WHY: grow the channel with research',
  'QUEST: Fresh one', 'CONTRACT: attest', 'WHY: grow the channel with research',
  'QUEST: Also fine', 'CONTRACT: attest', 'WHY: grow the channel with research',
  'QUEST: Over the cap', 'CONTRACT: attest', 'WHY: grow the channel with research'
].join('\n');
const p2 = R.parse(DUPED, { openTitles: [], deniedTitles: ['old chore'], propKeys: PROPS, grounding: 'grow the channel with research' });
A.eq(p2.quests.map(q => q.title), ['Same title', 'Fresh one', 'Also fine'], 'intra-reply dup + denylisted title dropped; cap at 3 holds');

// grounding guard: an invented WHY dies at the parse seam
const INVENTED = ['QUEST: Buy a boat', 'CONTRACT: attest', 'WHY: sailing maximizes nautical synergy'].join('\n');
A.eq(R.parse(INVENTED, { openTitles: [], deniedTitles: [], propKeys: PROPS, grounding: GROUNDING }).quests.length, 0, 'a WHY citing nothing observed is rejected');

// load-bearing fields: a block missing CONTRACT or WHY is malformed
A.eq(R.parse('QUEST: No contract\nWHY: grow the channel', { propKeys: PROPS, grounding: 'grow the channel' }).quests.length, 0, 'missing contract -> dropped');
A.eq(R.parse('QUEST: No why\nCONTRACT: attest', { propKeys: PROPS }).quests.length, 0, 'missing WHY -> dropped');

// NONE sentinel (with and without a north-star line)
A.eq(R.parse('NONE', {}).none, true, 'bare NONE is the sentinel');
const pNone = R.parse('NORTH_STAR: Grow the channel\nNONE', {});
A.ok(pNone.none && pNone.northStar && pNone.northStar.text === 'Grow the channel', 'NONE may still carry the north star');

/* ---------- reducers: pure, capped, junk-tolerant ---------- */
let st = R.fresh();
for (let i = 0; i < R.LEDGER_CAP + 10; i++) st = R.note(st, { outcome: 'minted', reason: 'r' + i, title: 't' + i }, { now: T0 + i });
A.eq(st.ledger.length, R.LEDGER_CAP, 'ledger is FIFO-capped');
A.eq(st.ledger[st.ledger.length - 1].reason, 'r' + (R.LEDGER_CAP + 9), 'newest entry survives the cap');
st = R.setNorthStar(st, { text: 'Ship the product', groundedIn: 'dossier', source: 'model' }, { now: T0 });
A.eq(st.northStar.text, 'Ship the product', 'setNorthStar lands');
A.eq(st.northStar.source, 'model', 'inferred stars carry source model');
st = R.setNorthStar(st, { text: '', source: 'goal' }, { now: T0 + 1 });
A.eq(st.northStar.text, 'Ship the product', 'an empty star never blanks an existing one');
st = R.setNorthStar(st, { text: 'The Commander goal', source: 'goal' }, { now: T0 + 2 });
A.eq(st.northStar.source, 'goal', 'a Commander-goal star carries source goal');
A.eq(R.normalize(null).ledger, [], 'normalize(null) is a fresh state');
A.eq(R.normalize({ northStar: { text: '' }, ledger: 'junk', lastCycleAt: 'x' }).northStar, null, 'junk hydrates safely');
const roundTrip = R.normalize(JSON.parse(JSON.stringify(st)));
A.eq(roundTrip.northStar.text, 'The Commander goal', 'state survives a JSON round-trip');

A.report();
