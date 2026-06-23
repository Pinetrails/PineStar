/* node test/onboarding.context.test.js — the CONTEXT sub-interview's merge invariant (onboarding THEME 2).

   The open "where am i standing?" question lets the Commander layer in several facets (what they're building,
   who they are, the stack, what good looks like) ONE at a time. The one thing that must NEVER happen — the bug
   this design replaced — is a later facet erasing an earlier one. ctxMerge is the pure core the live awakening
   uses: it only ever APPENDS a real facet, retires the answered chip, and treats a bare scaffold as a no-op. */
'use strict';
const A = require('./_assert.js');
const Onboarding = require('../frontend/app/onboarding.js');
const merge = Onboarding._ctxMerge;
A.ok(typeof merge === 'function', 'ctxMerge is exported for testing');

const FACETS = [
  { label: "What I'm building", value: "what i'm building: " },
  { label: 'Who I am', value: 'who i am, and how i work: ' },
  { label: 'The stack', value: 'the stack and tools we work in: ' }
];

/* answer the first facet — it's captured and its chip retires */
let m = merge([], FACETS.slice(), "what i'm building: a crypto trading bot");
A.eq(m.parts, ["what i'm building: a crypto trading bot"], 'first facet is captured');
A.eq(m.remaining.length, 2, 'the answered facet is retired from the chip list');
A.ok(m.remaining.every(c => c.value.toLowerCase().indexOf("what i'm building") !== 0), 'the right facet (the answered one) is removed');

/* answer a SECOND facet — THE INVARIANT: the first must survive */
m = merge(m.parts, m.remaining, 'who i am, and how i work: solo founder, ships fast');
A.eq(m.parts.length, 2, 'two facets now accumulated');
A.eq(m.parts[0], "what i'm building: a crypto trading bot", 'INVARIANT: the first facet is NOT erased by the second');
A.eq(m.parts[1], 'who i am, and how i work: solo founder, ships fast', 'the second facet is appended after the first');
A.eq(m.remaining.length, 1, 'two facets retired, one remains');

/* a bare scaffold (tapped a chip, typed nothing) commits nothing and mutates no state */
const before = { parts: m.parts.slice(), remaining: m.remaining.slice() };
const bareM = merge(m.parts, m.remaining, 'the stack and tools we work in:');
A.eq(bareM.bare, true, 'a bare scaffold is detected');
A.eq(bareM.real, '', 'a bare scaffold commits nothing');
A.eq(bareM.parts, before.parts, 'a bare scaffold leaves the accumulated facets untouched');
A.eq(bareM.remaining.length, before.remaining.length, 'a bare scaffold retires no chip');

/* the bare scaffold with trailing spaces is still bare (the live input keeps the chip's trailing space) */
A.eq(merge([], FACETS.slice(), 'what i’m building:  ').bare === false, true, 'a curly-apostrophe label mismatch is NOT treated as bare (straight vs curly are different strings)');
A.eq(merge([], FACETS.slice(), "what i'm building:").bare, true, 'an exact bare scaffold (trimmed) is detected');

/* free-typed text (no chip tapped) is accepted as a facet and retires nothing */
const freeM = merge([], FACETS.slice(), 'we build trading systems for crypto desks');
A.eq(freeM.parts, ['we build trading systems for crypto desks'], 'free-typed context is captured');
A.eq(freeM.remaining.length, FACETS.length, 'free text retires no specific facet chip');

/* whitespace / empty / null are no-ops that never lose prior parts */
A.eq(merge([], FACETS.slice(), '   ').real, '', 'whitespace commits nothing');
A.eq(merge(['x'], [], null).parts, ['x'], 'null input leaves prior parts unchanged');
A.eq(merge(['x', 'y'], [], '').parts, ['x', 'y'], 'empty input never drops accumulated facets');

/* end-to-end: four taps in a row only ever grow the picture, never shrink it */
let parts = [], remaining = FACETS.slice();
for (const line of ["what i'm building: a", 'who i am, and how i work: b', 'the stack and tools we work in: c']) {
  const r = merge(parts, remaining, line);
  A.ok(r.parts.length === parts.length + 1, 'each real facet grows parts by exactly one');
  parts = r.parts; remaining = r.remaining;
}
A.eq(parts.length, 3, 'all three facets accumulated in order');
A.eq(remaining.length, 0, 'all three chips retired');

A.report('onboarding.context.test');
