/* node test/starters.test.js — the pure session-opener chip engine (frontend/app/starters.js)
   plus LaunchMemory.recent() (its "usual recipe" signal). Locks:
     - FRESH STATION: the classic orientation set, verbatim (tour / first recipe / station brief)
     - RETURNING: only EARNED chips — usual recipe (prefilled + ↺), cadence-due recipe,
       next-step-on-session, pitch ask; cap 3
     - NO random discovery: off-cadence hours never pitch an unlaunched catalog recipe
     - a returning Commander NEVER sees the orientation chips (tour / station brief)
     - usual skips launches whose recipe left the catalog; prefill values ride the chip
     - cadence: a 'morning' recipe is due 05–11 only
     - session chip: most recent titled session, truncated label, no state assertion
     - fail-open: garbage signals / empty catalog still yield tappable chips, never a throw
     - LaunchMemory.recent(): newest-first, capped, corrupt store → [] */
'use strict';
const A = require('./_assert.js');
const Starters = require('../frontend/app/starters.js');
const LaunchMemory = require('../frontend/app/launchmemory.js');

const CATALOG = [
  { id: 'morning-brief', name: 'Morning Brief', cadence: 'morning', task: 'Brief me on {topic} over {window}.', params: [{ key: 'topic' }, { key: 'window', default: 'the last 24 hours' }] },
  { id: 'deep-dive', name: 'Deep Dive', cadence: null, task: 'Deep dive on {topic}.', params: [{ key: 'topic' }] },
  { id: 'bug-hunt', name: 'Bug Hunt', cadence: null, task: 'Hunt bugs in {repo}.', params: [{ key: 'repo' }] },
  { id: 'weekly-review', name: 'Weekly Review', cadence: 'weekly', task: 'Review my week.', params: [] }
];

// ---- fresh station: the classic orientation set, unchanged ----
{
  const chips = Starters.pick({ recipes: CATALOG, recent: [], returning: false, hour: 9 });
  A.eq(chips.length, 3, 'fresh: three chips');
  A.eq(chips[0].label, 'what can you do here', 'fresh: tour chip first');
  A.ok(chips[1].kind === 'recipe' && chips[1].recipe.id === 'morning-brief', 'fresh: first catalog recipe second');
  A.ok(!chips[1].values, 'fresh: recipe chip carries no prefill');
  A.eq(chips[2].label, 'brief me on this station', 'fresh: station brief third');
}

// ---- returning: usual (prefilled) + session next-step + pitch — no random catalog pushes ----
{
  const vals = { 'deep-dive': { topic: 'AI agents' } };
  const chips = Starters.pick({
    recipes: CATALOG,
    recent: [{ id: 'deep-dive', at: 200 }, { id: 'morning-brief', at: 100 }],
    valuesOf: id => vals[id] || null,
    sessions: [{ title: 'Ship the landing page', at: 500 }, { title: 'Old thing', at: 100 }],
    returning: true, hour: 20
  });
  A.eq(chips.length, 3, 'returning: three chips');
  A.ok(chips[0].kind === 'recipe' && chips[0].recipe.id === 'deep-dive', 'returning: usual = most recent launch');
  A.eq(chips[0].values, { topic: 'AI agents' }, 'returning: usual carries last inputs');
  A.eq(chips[0].label, '↺ Deep Dive', 'returning: prefilled chip wears the ↺ mark');
  A.eq(chips[1].label, 'next step: ship the landing page', 'returning: slot 2 = next step on the latest titled session');
  A.ok(chips[1].send.indexOf('"Ship the landing page"') >= 0, 'returning: session title rides the send verbatim');
  A.eq(chips[2].label, 'pitch me an idea', 'returning: pitch ask third');
}

// ---- no random discovery: off-cadence + no sessions → usual + pitch ONLY, never a catalog push ----
{
  const chips = Starters.pick({
    recipes: CATALOG, recent: [{ id: 'deep-dive', at: 200 }], returning: true, hour: 20
  });
  A.eq(chips.length, 2, 'no-signal: two chips only — no padding');
  A.ok(chips[0].kind === 'recipe' && chips[0].recipe.id === 'deep-dive', 'no-signal: usual first');
  A.eq(chips[1].label, 'pitch me an idea', 'no-signal: pitch second');
  A.ok(chips.every(c => c.label !== 'brief me on this station' && c.label !== 'what can you do here'),
    'no-signal: returning never sees orientation chips');
}

// ---- cadence-due survives: morning hour surfaces the morning recipe in slot 2 ----
{
  const chips = Starters.pick({
    recipes: CATALOG, recent: [{ id: 'deep-dive', at: 200 }], returning: true, hour: 8
  });
  A.ok(chips[1].kind === 'recipe' && chips[1].recipe.id === 'morning-brief', 'cadence: 8am slot 2 = morning recipe');
}

// ---- cap 3: usual + due + session squeezes the pitch out ----
{
  const chips = Starters.pick({
    recipes: CATALOG, recent: [{ id: 'deep-dive', at: 200 }],
    sessions: [{ title: 'Ship the landing page', at: 500 }],
    returning: true, hour: 8
  });
  A.eq(chips.length, 3, 'cap: three chips max');
  A.eq(chips.map(c => c.label)[2], 'next step: ship the landing page', 'cap: session chip kept, pitch dropped');
}

// ---- session chip: long titles truncate in the label, ride full in the send ----
{
  const title = 'Rebuild the entire onboarding flow end to end';
  const chips = Starters.pick({ sessions: [{ title, at: 1 }], returning: true, hour: 20 });
  A.ok(chips[0].label.length <= 'next step: '.length + 28, 'session: label truncated');
  A.ok(chips[0].send.indexOf('"' + title + '"') >= 0, 'session: full title in the send');
  A.ok(chips[0].label.indexOf('…') >= 0, 'session: truncation is visible');
}

// ---- session chip: blank/garbage titles are skipped, not rendered ----
{
  const chips = Starters.pick({ sessions: [{ title: '   ', at: 9 }, { title: 'Real work', at: 1 }, null], returning: true, hour: 20 });
  A.eq(chips[0].label, 'next step: real work', 'session: blank titles skipped for the next real one');
}

// ---- usual skips a launch whose recipe left the catalog ----
{
  const chips = Starters.pick({
    recipes: CATALOG, recent: [{ id: 'gone-recipe', at: 300 }, { id: 'bug-hunt', at: 100 }], returning: true, hour: 20
  });
  A.ok(chips[0].kind === 'recipe' && chips[0].recipe.id === 'bug-hunt', 'usual: dead catalog id skipped for the next real one');
}

// ---- fail-open: garbage signals and empty catalog still yield chips ----
{
  A.notThrows(() => Starters.pick(null), 'fail-open: null signals');
  A.notThrows(() => Starters.pick({ recipes: 'nope', recent: 42, valuesOf: 7, hour: 'x', sessions: 'bad', returning: true }), 'fail-open: garbage signals');
  const none = Starters.pick({ recipes: [], recent: [], returning: true, hour: 10 });
  A.ok(none.length >= 1 && none.every(c => c.kind === 'send'), 'fail-open: empty catalog → live send chip(s), no throw');
  A.eq(none[none.length - 1].label, 'pitch me an idea', 'fail-open: pitch always survives');
  const freshNone = Starters.pick({ recipes: [], returning: false });
  A.eq(freshNone.map(c => c.label), ['what can you do here', 'brief me on this station'], 'fail-open: fresh + empty catalog → classic send pair');
}

// ---- LaunchMemory.recent(): newest-first, capped, corrupt-store honest ----
{
  const mem = {};
  LaunchMemory._setStoreForTest({
    getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
  });
  LaunchMemory.reset();
  A.eq(LaunchMemory.recent(), [], 'recent: empty store → []');
  LaunchMemory.save('a', { topic: 'one' }, 100);
  LaunchMemory.save('b', { topic: 'two' }, 300);
  LaunchMemory.save('c', { topic: 'three' }, 200);
  A.eq(LaunchMemory.recent().map(e => e.id), ['b', 'c', 'a'], 'recent: newest-first');
  A.eq(LaunchMemory.recent(2).map(e => e.id), ['b', 'c'], 'recent: cap honored');
  mem[LaunchMemory.KEY] = '{corrupt';
  A.eq(LaunchMemory.recent(), [], 'recent: corrupt store → [] (never a crash)');
}

A.report('starters');
