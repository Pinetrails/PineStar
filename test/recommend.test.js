/* node test/recommend.test.js — the pure recommendation spine: one voice, evidence or silence. */
'use strict';
const A = require('./_assert.js');
const Recommend = require('../frontend/app/recommend.js');
const BeatCard = require('../frontend/app/beatcard.js');

/* ── 1. the priority order is the beat-slot order, with the nudge family expanded in ladder order ── */
for (let i = 0; i < BeatCard.DEFAULT_PRIORITY.length - 1; i++) {
  const kind = BeatCard.DEFAULT_PRIORITY[i];
  if (kind === 'nudge') continue;
  A.ok(Recommend.PRIORITY.indexOf(kind) >= 0, 'the spine knows the beat kind ' + kind);
}
A.eq(Recommend.PRIORITY.slice(0, 6), ['memory', 'study', 'arc', 'trust', 'thread', 'rate'],
  'the spine head is beatcard DEFAULT_PRIORITY');
A.eq(Recommend.PRIORITY.slice(6), ['suggest', 'seed', 'routine', 'recruit', 'curiosity'],
  'the gentle tail keeps the old wireCuriosity ladder precedence');
A.eq(Recommend.slotKindOf('curiosity'), 'nudge', 'every gentle channel shares the one nudge slot family');
A.eq(Recommend.slotKindOf('study'), 'study', 'a turn-in channel keeps its own slot family');
A.eq(Recommend.slotKindOf('mystery'), 'mystery', 'an unknown kind passes through unchanged');

/* ── 2. EVIDENCE OR SILENCE ── */
A.eq(Recommend.citable({ kind: 'study', why: 'you said invoices eat your Sundays' }), true, 'a cited candidate may speak');
A.eq(Recommend.citable({ kind: 'study' }), false, 'a candidate with no why is not citable');
A.eq(Recommend.citable({ kind: 'study', why: '   ' }), false, 'whitespace is not evidence');
A.eq(Recommend.citable(null), false, 'a null candidate is not citable');
A.eq(Recommend.pick([{ kind: 'study' }, { kind: 'curiosity' }]), null,
  'a field of uncitable candidates produces SILENCE, never a fallback pick');
A.eq(Recommend.pick([]), null, 'no candidates is silence');
A.eq(Recommend.pick(null), null, 'a missing candidate list is silence');
A.eq(Recommend.pick([{ kind: 'study' }, { kind: 'curiosity', why: 'i still do not know your goals' }]).kind, 'curiosity',
  'an uncitable higher-priority candidate cannot block a cited lower-priority one');

/* ── 3. ONE VOICE, by priority — not by who armed first ── */
const field = [
  { kind: 'curiosity', why: 'i still do not know your goals' },
  { kind: 'thread', why: 'you said "we should automate the invoice thing"' },
  { kind: 'study', why: 'from "ship the billing rewrite by Friday"' },
  { kind: 'trust', why: '5 approvals in a row' }
];
A.eq(Recommend.pick(field).kind, 'study', 'the best candidate speaks regardless of list order');
A.eq(Recommend.pick(field.slice().reverse()).kind, 'study', 'the pick is order-independent');

/* ── 4. tier stability: no modifier may leapfrog a priority tier ── */
const hotCuriosity = { kind: 'curiosity', why: 'x', dim: 'goals', streak: 99 };
const coldTrust = { kind: 'trust', why: 'y', declines: 99 };
const uRead = { dims: { goals: { weight: 1, conf: 0 }, style: { weight: 0.2, conf: 0.9 } } };
A.eq(Recommend.pick([hotCuriosity, coldTrust], uRead).kind, 'trust',
  'a maxed-out low-priority candidate still loses to a penalized higher-priority one');
A.ok(Recommend.VOI_MAX < Recommend.BASE_STEP, 'the VOI term is bounded below one priority tier');

/* ── 5. the VOI term orders WITHIN a tier, reusing weight × (1 − conf) ── */
const wide = { kind: 'curiosity', why: 'a', dim: 'goals' };
const narrow = { kind: 'curiosity', why: 'b', dim: 'style' };
A.ok(Recommend.score(wide, uRead) > Recommend.score(narrow, uRead),
  'the dimension with the larger weight × (1 − conf) gap scores higher');
A.eq(Recommend.pick([narrow, wide], uRead).why, 'a', 'the higher-VOI question wins its own tier');
A.eq(Recommend.score(wide, null), Recommend.score({ kind: 'curiosity', why: 'a' }, null),
  'no understanding read → no VOI bonus (fail-open, never fabricated)');
A.eq(Recommend.score({ kind: 'curiosity', why: 'a', dim: 'nope' }, uRead), Recommend.score({ kind: 'curiosity', why: 'a' }, uRead),
  'an unknown dimension contributes nothing');

/* ── 6. streak and decline hooks are bounded ── */
const plain = { kind: 'trust', why: 'w' };
A.ok(Recommend.score({ kind: 'trust', why: 'w', streak: 3 }) > Recommend.score(plain), 'a real streak helps');
A.eq(Recommend.score({ kind: 'trust', why: 'w', streak: 1000 }), Recommend.score({ kind: 'trust', why: 'w', streak: 4 }),
  'the streak bonus saturates');
A.ok(Recommend.score({ kind: 'trust', why: 'w', declines: 2 }) < Recommend.score(plain), 'recent declines soften the ask');
A.eq(Recommend.score({ kind: 'trust', why: 'w', declines: 1000 }), Recommend.score({ kind: 'trust', why: 'w', declines: 3 }),
  'the decline penalty saturates');
A.eq(Recommend.score({ kind: 'trust', why: 'w', streak: -5, declines: -5 }), Recommend.score(plain),
  'negative hooks are clamped, never inverted');

/* ── 7. an explicit base override wins over the derived tier ── */
A.eq(Recommend.pick([{ kind: 'curiosity', why: 'a', base: 9000 }, { kind: 'study', why: 'b' }]).kind, 'curiosity',
  'an explicit base lets a caller stage a candidate deliberately');

/* ── 8. determinism ── */
const twice = [Recommend.score(field[0], uRead), Recommend.score(field[0], uRead)];
A.eq(twice[0], twice[1], 'scoring has no clock and no randomness');

/* ── 9. whyLine — ONE grammar for COMMS and the FOR YOU shelf ── */
A.eq(Recommend.whyLine({ why: 'you said invoices eat your Sundays' }), 'because you said invoices eat your Sundays', 'the base grammar');
A.eq(Recommend.whyLine({ why: 'because the last 3 runs hit this wall' }), 'because the last 3 runs hit this wall', 'an already-because string is not doubled');
A.eq(Recommend.whyLine({ why: 'Since you keep hand-launching it' }), 'because you keep hand-launching it', 'other connectives normalize too');
A.eq(Recommend.whyLine({ why: 'You mentioned Sundays.' }), 'because you mentioned Sundays', 'a leading capital joins mid-sentence; trailing punctuation goes');
A.eq(Recommend.whyLine({ why: 'MCP connectors keep timing out' }), 'because MCP connectors keep timing out', 'an acronym keeps its case');
A.eq(Recommend.whyLine({ why: '  you   said   this  ' }), 'because you said this', 'whitespace is collapsed');
A.eq(Recommend.whyLine({ why: '' }), '', 'nothing to cite renders nothing');
A.eq(Recommend.whyLine(null), '', 'a null candidate renders nothing');
A.eq(Recommend.whyLine({ why: 'because' }), '', 'a bare connective is not evidence');

/* ── 10. the spine is pure: no DOM, no fetch, no timers ── */
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'recommend.js'), 'utf8');
A.eq(/\bdocument\b/.test(src), false, 'recommend.js touches no DOM');
A.eq(/\bfetch\s*\(/.test(src), false, 'recommend.js performs no I/O');
A.eq(/\bsetTimeout\b|Date\.now|Math\.random/.test(src), false, 'recommend.js is clock-free and deterministic');

/* ── 11. THE ONE CARD GRAMMAR (source-lock — chat.js is DOM-flow, not node-loadable) ──
   Every proactive consent offer renders through ONE renderer, in one order:
   eyebrow → evidence (the Commander's words) → proposal → consent buttons. */
const fs = require('fs'), path = require('path');
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'app.css'), 'utf8');
const iRecCard = chatSrc.indexOf('function recCard(spec)');
A.ok(iRecCard > 0, 'chat.js defines the ONE offer-card renderer');
const recBody = chatSrc.slice(iRecCard, iRecCard + 2600);
A.ok(/rec-eyebrow/.test(recBody) && /rec-glyph/.test(recBody), 'the card leads with the eyebrow, glyph boxed on its own');
A.ok(recBody.indexOf('rec-evidence') < recBody.indexOf("className = 'turnin-text'"),
  'the EVIDENCE line is rendered BEFORE the proposal (noticed → because → propose)');
A.ok(recBody.indexOf("className = 'turnin-text'") < recBody.indexOf("className = 'consent-btns'"),
  'the proposal precedes the consent buttons');
A.ok(/classList\.add\('turnin'\)/.test(recBody), 'the card extends the established .turnin family, not a new visual language');
A.ok(/textContent/.test(recBody) && !/innerHTML/.test(recBody), 'every dynamic string is set via textContent');
// all three consent channels route their presentation through it (one shape, not seven)
for (const fn of ['studyCard', 'trustCard', 'threadCard']) {
  const i = chatSrc.indexOf('function ' + fn);
  A.ok(i > 0 && /recCard\(\{/.test(chatSrc.slice(i, i + 2400)), fn + ' renders through the shared offer card');
}
// the why-string grammar is shared with the FOR YOU shelf
A.ok(/Recommend\.whyLine\(\{ why: raw \}\)/.test(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'marketplace.js'), 'utf8')),
  'the FOR YOU shelf speaks the same "because …" grammar as the COMMS cards');
/* ── 11b. THE CARD NEVER PUTS WORDS IN THE COMMANDER'S MOUTH (truthful telemetry, 2026-08-04) ──
   `because you said "…"` was rendered for EVERY citation the card had. But study.js falls back to the run's
   DIRECTIVE when the model returns no QUOTE line (evidenceRef.kind = 'directive'), and a directive is very often
   machine-composed (routine, recipe, scheduled brief); threadmine locates its quote in the whole exchange, which
   includes the AGENT's turns. Each source now gets its own honest phrasing. */
const iCite = chatSrc.indexOf('function recCite');
A.ok(iCite > 0, 'chat.js has ONE citation composer, discriminated by source');
const citeBody = chatSrc.slice(iCite, iCite + 700);
A.ok(/kind === 'verbatim'\) return 'you said/.test(citeBody), 'only a VERBATIM quote may be rendered as speech');
A.ok(/kind === 'directive'\) return 'from the task you gave me/.test(citeBody), 'a directive is cited as the task, not as words spoken');
A.ok(/kind === 'conversation'\) return 'from the conversation/.test(citeBody), 'an unattributed quote is cited as the conversation');
A.ok(/return 'from “' \+ t \+ '”';/.test(citeBody), 'anything unlabelled falls back to a neutral quote that claims no speaker');
for (const [fn, probe] of [['function studyCard', /recCite\(prop\.evidence, prop\.evidenceRef && prop\.evidenceRef\.kind\)/],
                           ['async function studyCandidate', /recCite\(prop\.evidence, prop\.evidenceRef && prop\.evidenceRef\.kind\)/],
                           ['function threadCard', /recCite\(prop\.spec, threadCiteKind\(prop\)\)/],
                           ['async function threadCandidate', /recCite\(prop\.spec, threadCiteKind\(prop\)\)/]]) {
  const i = chatSrc.indexOf(fn);
  A.ok(i > 0 && probe.test(chatSrc.slice(i, i + 2000)), fn.replace(/^(async )?function /, '') + ' cites by SOURCE, never blanket "you said"');
}
A.ok(/prop\.speaker === 'user'/.test(chatSrc.slice(iCite - 400, iCite + 1400)),
  'a mined thread claims speech only when threadmine located the quote in the Commander’s own turns');
// …and the producer stamps that discrimination in the first place
A.ok(/speaker: \(nq && spoken\.indexOf\(nq\) >= 0\) \? 'user' : 'other'/.test(fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'threadmine.js'), 'utf8')),
  'threadmine stamps WHO said the quote it mined');
// a cut directive ends in an ellipsis, so the citation can never read as a sentence the Commander never finished
A.ok(/dir\.length > 140 \? \(dir\.slice\(0, 139\) \+ '…'\) : dir/.test(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'study.js'), 'utf8')),
  'a truncated directive citation is visibly truncated');

const iRecWhy = chatSrc.indexOf('function recWhy');
A.ok(iRecWhy > 0 && /Recommend\.whyLine/.test(chatSrc.slice(iRecWhy, iRecWhy + 420)), 'the cards route their citation through whyLine');
// styling: matte, dark-only, no gloss, no white control, entrance mirrors the vanish timing
A.ok(/\.cmsg\.turnin\.rec\b/.test(cssSrc), 'app.css styles the offer card inside the .turnin family');
A.ok(/@keyframes rec-card-in/.test(cssSrc) && /animation: rec-card-in \.26s/.test(cssSrc),
  'the entrance mirrors the .beat-vanish timing (.26s) — one motion vocabulary');
A.ok(/prefers-reduced-motion[\s\S]{0,80}rec\b/.test(cssSrc) || /rec-card-in[\s\S]*prefers-reduced-motion/.test(cssSrc),
  'the entrance collapses under prefers-reduced-motion');
const recCss = cssSrc.slice(cssSrc.indexOf('THE OFFER CARD (recommendation spine)'), cssSrc.indexOf('THE OFFER CARD (recommendation spine)') + 2600);
A.eq(/#fff|#ffffff|white/i.test(recCss), false, 'no white controls or white paint anywhere in the card');
A.eq(/gradient|blur\(|backdrop-filter/i.test(recCss), false, 'matte, not glossy — no gradients or glass on the card');
A.ok(/\.rec-glyph[\s\S]{0,220}width: 11px/.test(recCss), 'the ◈ symbol glyph is BOX-sized, never padded from font-size');

A.report('recommend.test');
