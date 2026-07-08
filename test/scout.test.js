/* node test/scout.test.js — the pure scout engine (sidecar/scout.js).
   Locks the Scout lane-2 promises: decide() gates by named binding (cold/cooldown/gap/full) and alternates
   kinds; the recipe directive embeds the interests evidence + library + NONE; parseRecipe round-trips a
   well-formed draft and HARD-rejects a broken param/task template, an unknown param key, a near-duplicate,
   and a denylisted shape; NONE is a sentinel; reducers (stage/dismiss/accept/note/stampAttempt/setContext)
   are pure, capped, and dismiss-denylists so an equivalent never re-mints. Deterministic — injected now. */
'use strict';
const A = require('./_assert.js');
const S = require('../sidecar/scout.js');

const T0 = 1000000000000;
const GAP = S.MINT_MIN_GAP_MS;

const EXISTING = [
  { name: 'Morning Brief', tagline: 'Daily what-changed digest' },
  { name: 'Deep-Dive Research', tagline: 'Sourced brief on a question' }
];
const GEAR = ['dish', 'cabinet', 'notebook', 'workbench', 'studio', 'connector'];

const GOOD = [
  'NAME: Stock Radar',
  'EMOJI: ⊙',
  'TAGLINE: Watchlist movers with the why',
  'BLURB: Scans your tickers, separates noise from real moves, and briefs the drivers with sources.',
  'CATEGORY: research',
  'TAGS: research=0.8, general=0.2',
  'GEAR: dish, teleporter',
  'PARAM: tickers | Watchlist | e.g. NVDA, AMD, TSM',
  'TASK: Check {tickers} for meaningful moves today; lead with what moved and why, cite sources, skip noise.',
  'WHY: you asked about semiconductor stocks and NVDA earnings repeatedly this week'
].join('\n');

/* ---------- decide: named bindings + kind alternation ---------- */
let s = S.fresh(T0);
A.eq(S.decide(s, { now: T0, warm: false }).binding, 'cold', 'a cold station never mints');
A.eq(S.decide(s, { now: T0, warm: true }).binding, 'cooldown', 'no earned runs -> cooldown binds');
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) s = S.noteRun(s, T0);
A.ok(S.decide(s, { now: T0, warm: true }).fire, 'earned runs + warm + never-minted fires');
// stamp a mint, then the gap binds
s = S.stampAttempt(s, 'recipe', { now: T0 });
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) s = S.noteRun(s, T0);
A.eq(S.decide(s, { now: T0 + 1, warm: true }).binding, 'gap', 'a second attempt inside the min gap is blocked');
const d1 = S.decide(s, { now: T0 + GAP + 1, warm: true });
A.ok(d1.fire, 'past the gap it fires');
A.eq(d1.kind, 'prospect', 'a tie alternates away from the last kind (last was recipe)');
// fill one kind to MAX_LIVE: the other kind is chosen; fill both: full binds
let full = s;
for (let i = 0; i < S.MAX_LIVE; i++) full = S.stage(full, { id: 'p' + i, kind: 'prospect', draft: { name: 'x' + i }, why: 'w', fingerprint: 'fp-p' + i }, { now: T0 });
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) full = S.noteRun(full, T0);
const d2 = S.decide(full, { now: T0 + GAP + 1, warm: true });
A.eq(d2.kind, 'recipe', 'a full prospect shelf routes the attempt to recipes');
for (let i = 0; i < S.MAX_LIVE; i++) full = S.stage(full, { id: 'r' + i, kind: 'recipe', draft: { name: 'y' + i }, why: 'w', fingerprint: 'fp-r' + i }, { now: T0 });
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) full = S.noteRun(full, T0);
A.eq(S.decide(full, { now: T0 + 2 * GAP + 2, warm: true }).binding, 'full', 'both shelves full -> full binds');

/* ---------- buildRecipeDirective ---------- */
const dir = S.buildRecipeDirective({
  interestsBlock: '• stock research (seen 4×) — e.g. "NVDA earnings"',
  existingRecipes: EXISTING, gearKeys: GEAR, launchedOften: ['Morning Brief']
});
A.ok(dir.indexOf('NVDA earnings') >= 0, 'the directive embeds the interest evidence');
A.ok(dir.indexOf('Deep-Dive Research') >= 0, 'the directive lists the existing library');
A.ok(/NONE/.test(dir), 'the directive offers NONE');
A.ok(dir.indexOf('Morning Brief') >= 0, 'the launch-history hint is embedded');

/* ---------- parseRecipe: round-trip ---------- */
const good = S.parseRecipe(GOOD, { existingRecipes: EXISTING, gearKeys: GEAR });
A.ok(good && !good.none && good.draft, 'a well-formed reply parses to a draft');
A.eq(good.draft.name, 'Stock Radar', 'name carried');
A.eq(good.draft.category, 'research', 'category carried');
A.eq(good.draft.tags, { research: 0.8, general: 0.2 }, 'tags clamp to the real lanes');
A.eq(good.draft.gear, ['dish'], 'unknown gear keys are soft-dropped (advisory, never a reject)');
A.eq(good.draft.params.length, 1, 'params carried');
A.eq(good.draft.params[0].key, 'tickers', 'param key carried');
A.ok(good.draft.task.indexOf('{tickers}') >= 0, 'the task template carries the token');
A.eq(good.draft.source, 'scout', 'the draft is stamped as scout-born');
A.ok(/semiconductor/.test(good.why), 'the grounded WHY is carried');

/* ---------- parseRecipe: HARD rejections ---------- */
A.ok(S.parseRecipe('NONE', {}) && S.parseRecipe('NONE', {}).none, 'NONE parses to the sentinel');
A.eq(S.parseRecipe('NAME: X', {}), null, 'a partial draft is rejected');
A.eq(S.parseRecipe(GOOD.replace('{tickers}', 'the watchlist'), { existingRecipes: [], gearKeys: GEAR }), null, 'a declared param missing from the task template is rejected');
A.eq(S.parseRecipe(GOOD.replace('Check {tickers}', 'Check {tickers} in {timeframe}'), { existingRecipes: [], gearKeys: GEAR }), null, 'an undeclared {token} in the task is rejected');
A.eq(S.parseRecipe(GOOD.replace('PARAM: tickers', 'PARAM: Bad Key!'), { existingRecipes: [], gearKeys: GEAR }), null, 'an illegal param key is rejected');
const dupName = S.parseRecipe(GOOD.replace('Stock Radar', 'Morning Brief'), { existingRecipes: EXISTING, gearKeys: GEAR });
A.eq(dupName, null, 'an exact name clash with the library is rejected');
const denied = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR, denylist: [S.fingerprint('Stock Radar Watchlist movers with the why')] });
A.eq(denied, null, 'a denylisted fingerprint never re-mints');
// tags fallback: garbage tags -> honest general
const noTags = S.parseRecipe(GOOD.replace('TAGS: research=0.8, general=0.2', 'TAGS: vibes=high'), { existingRecipes: [], gearKeys: GEAR });
A.eq(noTags.draft.tags, { general: 1 }, 'invalid tags degrade to general, never invented lanes');

/* ---------- parseRecipe: WHY GROUNDING (mirrors interests.parse's evidence guard) ---------- */
const CORPUS = '• stock research (seen 4×) — e.g. "NVDA earnings"\n• you asked about semiconductor stocks';
const grounded = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR, grounding: CORPUS });
A.ok(grounded && grounded.draft, 'a WHY citing real evidence passes the grounding guard');
const invented = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR, grounding: 'kubernetes cluster upgrades and yaml drift' });
A.eq(invented, null, 'a WHY citing NOTHING in the grounding corpus is rejected (invented pitch dies here)');
const ungated = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR });
A.ok(ungated && ungated.draft, 'no grounding corpus provided -> the guard stays off (back-compat)');

/* ---------- reducers ---------- */
let r = S.fresh(T0);
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) r = S.noteRun(r, T0);
r = S.stage(r, { id: 'a1', kind: 'recipe', draft: good.draft, why: good.why, fingerprint: good.fingerprint }, { now: T0 });
A.eq(r.staged.length, 1, 'stage appends the item');
A.eq(r.runsSinceMint, 0, 'stage spends the cadence');
A.eq(r.lastKind, 'recipe', 'stage stamps the kind');
const afterDismiss = S.dismiss(r, 'a1', { now: T0 + 1 });
A.eq(afterDismiss.staged.length, 0, 'dismiss removes the item');
A.ok(afterDismiss.denylist.indexOf(good.fingerprint) >= 0, 'dismiss denylists the fingerprint');
const reparse = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR, denylist: afterDismiss.denylist });
A.eq(reparse, null, 'the dismissed shape never re-mints (deny feeds parse)');
const afterAccept = S.accept(r, 'a1', { now: T0 + 1 });
A.eq(afterAccept.staged.length, 0, 'accept removes the item');
A.eq(afterAccept.denylist.length, 0, 'accept never denylists');
A.eq(S.dismiss(r, 'nope', { now: T0 }).staged.length, 1, 'dismissing an unknown id is a no-op');

/* ---------- ledger: every outcome recorded, capped ---------- */
let l = S.fresh(T0);
l = S.note(l, { kind: 'recipe', outcome: 'rejected', reason: 'near-duplicate of Morning Brief', title: 'Daily Digest' }, { now: T0 });
A.eq(l.ledger.length, 1, 'note appends a ledger entry');
A.eq(l.ledger[0].outcome, 'rejected', 'the outcome is recorded');
for (let i = 0; i < S.LEDGER_CAP + 10; i++) l = S.note(l, { kind: 'pass', outcome: 'none', reason: 'r' + i }, { now: T0 + i });
A.eq(l.ledger.length, S.LEDGER_CAP, 'the ledger caps FIFO');
A.eq(l.ledger[l.ledger.length - 1].reason, 'r' + (S.LEDGER_CAP + 9), 'the newest entries survive the cap');

/* ---------- context push: bounded, never trusted raw ---------- */
let cx = S.setContext(S.fresh(T0), {
  customClasses: [{ name: 'Songsmith', tagline: 'lyrics and hooks' }, { bad: true }],
  customRecipes: new Array(200).fill({ name: 'X', tagline: 'y' }),
  worksignalSummary: 'w'.repeat(500), topRecommendation: 'researcher'
}, { now: T0 });
A.eq(cx.context.customClasses.length, 1, 'malformed context rows are dropped');
A.eq(cx.context.customRecipes.length, 80, 'context lists are capped');
A.ok(cx.context.worksignalSummary.length <= 200, 'context strings are clipped');
A.eq(cx.context.topRecommendation, 'researcher', 'the recruiter top pick rides the context');

/* ---------- engagement telemetry: launch counters, capped + ranked ---------- */
let u = S.fresh(T0);
u = S.noteLaunch(u, { id: 'morning-brief', name: 'Morning Brief' }, { now: T0 });
u = S.noteLaunch(u, { id: 'morning-brief', name: 'Morning Brief' }, { now: T0 + 1 });
u = S.noteLaunch(u, { id: 'fix-bug', name: 'Fix a Bug' }, { now: T0 + 2 });
A.eq(u.usage.launches['morning-brief'].n, 2, 'repeat launches count up');
A.eq(S.topLaunched(u, 5), ['Morning Brief', 'Fix a Bug'], 'topLaunched ranks by count, ties newest-first');
A.eq(S.noteLaunch(u, { id: '' }, { now: T0 }).usage.launches['morning-brief'].n, 2, 'a bad launch record is a no-op');
let uc = S.fresh(T0);
for (let i = 0; i < S.USAGE_CAP + 8; i++) uc = S.noteLaunch(uc, { id: 'r' + i, name: 'R' + i }, { now: T0 + i });
uc = S.noteLaunch(uc, { id: 'heavy', name: 'Heavy' }, { now: T0 + 1000 });
uc = S.noteLaunch(uc, { id: 'heavy', name: 'Heavy' }, { now: T0 + 1001 });
A.ok(Object.keys(uc.usage.launches).length <= S.USAGE_CAP, 'launch counters cap at USAGE_CAP');
A.ok(!!uc.usage.launches['heavy'] && uc.usage.launches['heavy'].n === 2, 'the recent heavy hitter survives eviction and keeps its count');
// usage survives a hydrate round-trip
const ur = S.normalize(JSON.parse(JSON.stringify(u)), T0);
A.eq(ur.usage.launches['fix-bug'].n, 1, 'usage round-trips normalize');

/* ---------- normalize: corrupt saves degrade, never throw ---------- */
const n = S.normalize({ staged: [{ id: 'ok', kind: 'recipe', draft: { name: 'x' } }, { id: '', kind: 'recipe', draft: {} }, { id: 'bad-kind', kind: 'zork', draft: {} }], denylist: [1, 'fp', ''], ledger: 'nope', runsSinceMint: 'NaN', lastMintAt: -5 }, T0);
A.eq(n.staged.length, 1, 'malformed staged items are dropped on hydrate');
A.eq(n.denylist, ['1', 'fp'], 'denylist entries coerce to strings, empties dropped');
A.eq(n.ledger.length, 0, 'a corrupt ledger degrades to empty');
A.eq(n.runsSinceMint, 0, 'a corrupt counter degrades to 0');
A.eq(n.lastMintAt, 0, 'a negative stamp degrades to 0');

console.log('scout.test: OK');
