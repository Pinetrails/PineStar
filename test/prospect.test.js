/* node test/prospect.test.js — the pure prospect generator (frontend/app/prospect.js) + the store cadence/denylist
   (frontend/app/prospectstore.js).
   Locks Slice 4's promises: buildDirective constrains kit/skills to the real sets + supports a NONE reply; parse
   round-trips a well-formed draft; HARD validation rejects an unknown kit key, an unknown skill slug, a near-
   duplicate of an existing class, and a partial spec; NONE parses to a sentinel (no draft); cold-start mints
   nothing; the growth+cooldown+warm gate holds; and dismissing a prospect denylists it so an equivalent never
   re-mints. Deterministic — no clock/rng in the pure module. */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/prospect.js');

const CAPS = ['dish', 'cabinet', 'notebook', 'workbench', 'studio', 'connector'];
const SLUGS = ['web-research', 'price-watch', 'humanizer'];
const EXISTING = [
  { name: 'Researcher', tagline: 'Web research & sourced briefs', tags: { research: 1 } },
  { name: 'Engineer', tagline: 'Write, debug & ship code', tags: { code: 1 } }
];
const opts = { allowedKit: CAPS, allowedSkills: SLUGS, existingClasses: EXISTING };

// a well-formed model reply (a role no existing class serves: a market-intel specialist)
const GOOD = [
  'NAME: Market Analyst',
  'EMOJI: ⊞',
  'TAGLINE: Live competitive-pricing intel',
  'PURPOSE: You track competitor pricing across the live web and brief the Commander on moves that matter.',
  'MANUAL: Fetch real listings | Cite every price with source + date | Flag only meaningful moves',
  'KIT: dish, cabinet, notebook',
  'SKILLS: price-watch, web-research',
  'WHY: most of your recent work used the dish for competitive research and no class produces a pricing brief'
].join('\n');

/* ---------- buildDirective: constrains to the real sets + offers NONE ---------- */
const dir = P.buildDirective({ capabilityKeys: CAPS, skillSlugs: SLUGS, rosterClasses: [{ name: 'Chief of Staff' }], catalogSummary: EXISTING.map(c => ({ id: c.name.toLowerCase(), tagline: c.tagline })), worksignalSummary: 'dish-heavy (research)', topRecommendation: 'researcher' });
A.ok(dir.indexOf('dish') >= 0 && dir.indexOf('price-watch') >= 0, 'the directive lists the real capability + skill sets');
A.ok(/NONE/.test(dir), 'the directive offers a NONE reply when a class already serves the gap');
A.ok(dir.indexOf('researcher') >= 0, 'the directive names the recruiter top pick so the draft avoids duplicating it');

/* ---------- parse round-trip: a well-formed draft ---------- */
const good = P.parse(GOOD, opts);
A.ok(good && !good.none && good.draft, 'a well-formed reply parses to a draft');
A.eq(good.draft.name, 'Market Analyst', 'parse carries the name');
A.eq(good.draft.tagline, 'Live competitive-pricing intel', 'parse carries the tagline');
A.eq(good.draft.kit, ['dish', 'cabinet', 'notebook'], 'parse carries the validated kit');
A.eq(good.draft.skills, ['price-watch', 'web-research'], 'parse carries the validated skills');
A.ok(good.draft.manual.indexOf('- Fetch real listings') >= 0, 'MANUAL splits on | into standing-order bullets');
A.ok(good.why.length > 0, 'parse carries the grounded WHY');
A.eq(good.draft.custom, true, 'the draft is a custom spec');

/* an EMPTY field (SKILLS:) followed by another field must NOT swallow the next line — a common real LLM shape */
const emptySkills = [
  'NAME: Cold Caller', 'EMOJI: ☎', 'TAGLINE: outbound sales outreach drafts',
  'PURPOSE: Drafts outbound outreach the Commander can send.', 'MANUAL: keep it short',
  'KIT: cabinet, notebook', 'SKILLS:',   // deliberately empty, immediately before WHY
  'WHY: your work leaned on files with no outreach role rostered'
].join('\n');
const es = P.parse(emptySkills, opts);
A.ok(es && es.draft, 'a draft with an EMPTY SKILLS field still parses (empty field does not swallow the next line)');
A.eq(es.draft.skills, [], 'an empty SKILLS field yields no skills (not the WHY line miscaptured)');
A.ok(/outreach/.test(es.why), 'WHY is captured correctly even when the preceding field was empty');

/* ---------- NONE handling ---------- */
A.eq(P.parse('NONE', opts).none, true, 'a bare NONE reply parses to the no-mint sentinel');
A.eq(P.parse('  none  ', opts).none, true, 'NONE is case/space tolerant');
const fullWithNoneWord = GOOD + '\nEXTRA: this role is NONE of the others';   // a full draft that merely mentions "none"
A.ok(P.parse(fullWithNoneWord, opts) && P.parse(fullWithNoneWord, opts).draft, 'a full draft that merely mentions the word none is still parsed as a draft, not NONE');

/* ---------- HARD validation: reject bad kit / skill / duplicate / partial ---------- */
const badKit = GOOD.replace('KIT: dish, cabinet, notebook', 'KIT: dish, teleporter');   // teleporter is not a real cap
A.eq(P.parse(badKit, opts), null, 'an unknown kit key rejects the whole draft (no fabricated capability)');
const badSkill = GOOD.replace('SKILLS: price-watch, web-research', 'SKILLS: price-watch, telepathy');
A.eq(P.parse(badSkill, opts), null, 'an unknown skill slug rejects the draft');
const noKit = GOOD.replace('KIT: dish, cabinet, notebook', 'KIT: ');
A.eq(P.parse(noKit, opts), null, 'a specialist with no kit is rejected (not a real role)');
const partial = 'NAME: Foo\nEMOJI: x\nKIT: dish';   // missing tagline/purpose/why
A.eq(P.parse(partial, opts), null, 'a partial spec (missing load-bearing fields) is rejected');

/* near-duplicate of an existing class → rejected */
const dupName = GOOD.replace('NAME: Market Analyst', 'NAME: Researcher');
A.eq(P.parse(dupName, opts), null, 'an exact name clash with an existing class is rejected');
const dupTag = [
  'NAME: Web Digger', 'EMOJI: ◎', 'TAGLINE: Web research and sourced briefs',
  'PURPOSE: Does web research and writes sourced briefs.', 'MANUAL: cite sources',
  'KIT: dish, notebook', 'SKILLS: web-research',
  'WHY: your work used the dish a lot'
].join('\n');
A.eq(P.parse(dupTag, opts), null, 'a heavy tag/tagline overlap with an existing class is rejected as a near-duplicate');

/* a distinct role with the SAME kit as an existing class is still allowed (kit overlap != duplicate) */
A.ok(P.parse(GOOD, opts).draft, 'a distinct role sharing kit with an existing class is NOT a duplicate');

/* ---------- fingerprint stability (denylist keying) ---------- */
A.eq(P.fingerprint('Market Analyst'), P.fingerprint('analyst market'), 'the fingerprint is order-insensitive (reordered names match)');

/* ---------- store: cold-start mints nothing + the gate ---------- */
global.Prospect = P;   // prospectstore.js reads the pure engine as a browser global
const { ProspectStore } = require('../frontend/app/prospectstore.js');
// no U/localStorage in node → init tolerates their absence; drive the gate through _shouldMint with injected deps.
global.localStorage = { _s: {}, getItem(k){ return this._s[k] == null ? null : this._s[k]; }, setItem(k,v){ this._s[k]=v; }, removeItem(k){ delete this._s[k]; } };

// COLD: warmth 0 → never mints
ProspectStore.init({ now: () => 1000, getWarmth: () => 0, getFamiliarity: () => 0 });
A.eq(ProspectStore._shouldMint(), false, 'a cold station (warmth 0) never attempts a mint');

// WARM but cooldown not cleared (fresh install starts at COOLDOWN so it's allowed; force it low)
ProspectStore.init({ now: () => 1000, getWarmth: () => 0.5, getFamiliarity: () => 0.3 });
A.eq(ProspectStore._shouldMint(), true, 'a warm station past cooldown with growth is due for a mint attempt');

/* ---------- denylist blocks re-mint (end-to-end through maybeMint) ---------- */
(async () => {
  ProspectStore.reset();
  const chat = async () => ({ text: GOOD });
  const deps = {
    now: () => 2000, chat,
    getWarmth: () => 0.6, getFamiliarity: () => 0.4,
    getCapabilityKeys: () => CAPS, getSkillSlugs: () => SLUGS, getCatalogSummary: () => EXISTING,
    getWorksignalSummary: () => 'dish-heavy'
  };
  ProspectStore.init(deps);
  const rec = await ProspectStore.maybeMint();
  A.ok(rec && rec.draft && rec.draft.name === 'Market Analyst', 'a warm+due station mints a valid prospect from the model reply');
  A.eq(ProspectStore.list().length, 1, 'the minted prospect is staged');

  // dismiss it → denylisted
  const ok = ProspectStore.dismiss(rec.id);
  A.eq(ok, true, 'dismiss removes the prospect');
  A.eq(ProspectStore.list().length, 0, 'the dismissed prospect leaves the staging list');
  A.eq(ProspectStore.isDenied(rec.fingerprint), true, 'the dismissed fingerprint is denylisted');

  // a fresh session tries to mint the SAME draft → blocked by the denylist
  ProspectStore.init(deps);   // new session (sessionAttempted resets) but denylist persists via localStorage
  const rec2 = await ProspectStore.maybeMint();
  A.eq(rec2, null, 'the denylist blocks re-minting an equivalent prospect (dismissed != regenerate)');
  A.eq(ProspectStore.list().length, 0, 'no prospect is re-staged after a dismissal');

  // NONE reply → no mint, silent
  ProspectStore.reset();
  ProspectStore.init(Object.assign({}, deps, { chat: async () => ({ text: 'NONE' }) }));
  const none = await ProspectStore.maybeMint();
  A.eq(none, null, 'a NONE model reply mints nothing (silent no-mint)');

  A.report('prospect');
})();
