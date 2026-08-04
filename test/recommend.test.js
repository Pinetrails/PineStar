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

A.report('recommend.test');
