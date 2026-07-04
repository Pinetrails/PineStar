/* node test/widgets.test.js — the PURE folds behind the widget rails (frontend/app/widgets.js).

   The rails are a read-only projection (truthful telemetry): RUNS·24H sums the real insights
   overTime buckets, TOKENS prefers the fold's own total and falls back to a byModel sum, and a
   persisted layout is sanitized (known ids only, no cross-rail dupes) so a corrupt/stale store
   can never render a widget the catalog doesn't back. Pure, node-loaded, no DOM. */
'use strict';
const A = require('./_assert.js');
const { Widgets } = require('../frontend/app/widgets.js');

/* ============================ 1. foldRuns (the 24h window) ============================ */

let f = Widgets._foldRuns({ overTime: [{ runs: 2 }, { runs: 0 }, { runs: 5 }] });
A.eq(f.runs, 7, 'runs = the sum of the bucket counts');
A.eq(f.series.join(','), '2,0,5', 'the spark series mirrors the buckets in order');

A.eq(Widgets._foldRuns(null).runs, 0, 'no fold yet → 0, never a throw');
A.eq(Widgets._foldRuns({}).runs, 0, 'missing overTime → 0');
A.eq(Widgets._foldRuns({ overTime: [{ runs: 'x' }, {}, null] }).runs, 0, 'garbage buckets fold to 0, never NaN');

/* ============================ 2. foldTokens (prefer the fold's own total) ============================ */

A.eq(Widgets._foldTokens({ totalTokens: 1234 }), 1234, 'the fold total wins when present');
A.eq(Widgets._foldTokens({ byModel: [{ tokens: 100 }, { tokens: 250 }] }), 350, 'no total → byModel sum');
A.eq(Widgets._foldTokens({ totalTokens: 'nope', byModel: [{ tokens: 7 }] }), 7, 'a non-numeric total falls back to the sum');
A.eq(Widgets._foldTokens(null), 0, 'no insights → 0, never a throw');
A.eq(Widgets._foldTokens({ byModel: [{ tokens: 'x' }, null] }), 0, 'garbage byModel folds to 0, never NaN');

/* ============================ 3. fmtCount (compact, no locale surprises) ============================ */

A.eq(Widgets._fmtCount(950), '950', 'sub-thousand stays whole');
A.eq(Widgets._fmtCount(12400), '12.4K', 'thousands → K with one decimal');
A.eq(Widgets._fmtCount(3200000), '3.2M', 'millions → M with one decimal');
A.eq(Widgets._fmtCount('junk'), '0', 'garbage → 0, never NaN');

/* ============================ 4. sanitizeLayout (a corrupt store never renders) ============================ */

const KNOWN = ['runs24', 'queue', 'cron', 'tokens'];

let s = Widgets._sanitizeLayout({ top: ['runs24', 'bogus'], bot: ['queue'] }, KNOWN);
A.eq(s.top.join(','), 'runs24', 'unknown ids are dropped');
A.eq(s.bot.join(','), 'queue', 'known ids survive on their rail');

s = Widgets._sanitizeLayout({ top: ['queue'], bot: ['queue', 'cron'] }, KNOWN);
A.eq(s.top.join(',') + '|' + s.bot.join(','), 'queue|cron', 'a cross-rail dupe keeps its FIRST placement only');

s = Widgets._sanitizeLayout(null, KNOWN);
A.eq(s.top.length + s.bot.length, 0, 'a null store → empty rails, never a throw');
s = Widgets._sanitizeLayout({ top: 'nope', bot: 42 }, KNOWN);
A.eq(s.top.length + s.bot.length, 0, 'non-array rails → empty rails');

console.log('widgets.test.js OK');
