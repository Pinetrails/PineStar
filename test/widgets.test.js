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

/* ============================ 5. feed:* layout ids (agent-fed pins survive) ============================ */

s = Widgets._sanitizeLayout({ top: ['feed:app-revenue', 'runs24'], bot: ['feed:Bad Id', 'feed:'] }, KNOWN);
A.eq(s.top.join(','), 'feed:app-revenue,runs24', 'a well-formed feed pin survives sanitize (its record may poll in later)');
A.eq(s.bot.length, 0, 'malformed feed ids are dropped');

/* ============================ 6. sanitizeFeedRecord (trust nothing off the wire) ============================ */

let r = Widgets._sanitizeFeedRecord({ id: 'app-revenue', label: 'App Revenue', value: '$1,240', sub: 'today', agentId: 'nova', updatedAt: 777 });
A.eq(r.slug + '|' + r.label + '|' + r.value + '|' + r.sub + '|' + r.agentId + '|' + r.updatedAt,
  'app-revenue|App Revenue|$1,240|today|nova|777', 'a clean record round-trips');

A.eq(Widgets._sanitizeFeedRecord({ id: 'Bad Id!', value: 'x' }), null, 'a malformed id → null (never rendered)');
A.eq(Widgets._sanitizeFeedRecord({ id: 'empty' }), null, 'no value AND no list → null (never an empty gauge)');
A.eq(Widgets._sanitizeFeedRecord(null), null, 'garbage → null, never a throw');

r = Widgets._sanitizeFeedRecord({ id: 'news', list: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], agentId: 'scout' });
A.eq(r.list.length, 5, 'a ticker keeps at most 5 lines');
A.eq(r.value, null, 'a pure ticker has no big value');

r = Widgets._sanitizeFeedRecord({ id: 'long', value: 'V'.repeat(99), label: 'L'.repeat(99) });
A.ok(r.value.length <= 24 && r.label.length <= 28, 'over-long strings truncate defensively');

r = Widgets._sanitizeFeedRecord({ id: 'noname', value: '1' });
A.eq(r.label, 'NONAME', 'a missing label falls back to the slug');
A.eq(r.agentId, 'agent', 'a missing agentId falls back honestly');

/* ============================ 7. fmtAge (a trust cue, coarse on purpose) ============================ */

A.eq(Widgets._fmtAge(10000, 0), 'now', 'under 45s reads "now"');
A.eq(Widgets._fmtAge(3 * 60000, 0), '3m', 'minutes');
A.eq(Widgets._fmtAge(2 * 3600000, 0), '2h', 'hours');
A.eq(Widgets._fmtAge(4 * 86400000, 0), '4d', 'days');
A.eq(Widgets._fmtAge(0, 999999), 'now', 'a future timestamp clamps to "now", never negative');

console.log('widgets.test.js OK');
