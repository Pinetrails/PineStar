/* node test/starters.test.js — the pure session-opener chip engine (frontend/app/starters.js)
   plus LaunchMemory.recent() (its "usual recipe" signal). Locks:
     - FRESH STATION: the classic orientation set, verbatim (tour / first recipe / station brief)
     - RETURNING: usual recipe (most recent launch, prefilled + ↺-marked), discovery, pitch ask
     - usual skips launches whose recipe left the catalog; prefill values ride the chip
     - cadence: a 'morning' recipe is due 05–11 only; off-hours it is kept OUT of discovery
     - discovery rotates deterministically by day over never-launched recipes
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
  const chips = Starters.pick({ recipes: CATALOG, recent: [], returning: false, hour: 9, day: 3 });
  A.eq(chips.length, 3, 'fresh: three chips');
  A.eq(chips[0].label, 'what can you do here', 'fresh: tour chip first');
  A.ok(chips[1].kind === 'recipe' && chips[1].recipe.id === 'morning-brief', 'fresh: first catalog recipe second');
  A.ok(!chips[1].values, 'fresh: recipe chip carries no prefill');
  A.eq(chips[2].label, 'brief me on this station', 'fresh: station brief third');
}

// ---- returning: usual (prefilled) + discovery + pitch ----
{
  const vals = { 'deep-dive': { topic: 'AI agents' } };
  const chips = Starters.pick({
    recipes: CATALOG,
    recent: [{ id: 'deep-dive', at: 200 }, { id: 'morning-brief', at: 100 }],
    valuesOf: id => vals[id] || null,
    returning: true, hour: 20, day: 0
  });
  A.eq(chips.length, 3, 'returning: three chips');
  A.ok(chips[0].kind === 'recipe' && chips[0].recipe.id === 'deep-dive', 'returning: usual = most recent launch');
  A.eq(chips[0].values, { topic: 'AI agents' }, 'returning: usual carries last inputs');
  A.eq(chips[0].label, '↺ Deep Dive', 'returning: prefilled chip wears the ↺ mark');
  A.ok(chips[1].kind === 'recipe' && chips[1].recipe.id !== 'deep-dive', 'returning: discovery is a different recipe');
  A.ok(chips[1].recipe.id !== 'morning-brief', 'returning: 8pm discovery never suggests a morning recipe');
  A.eq(chips[2].label, 'pitch me an idea', 'returning: pitch ask third');
}

// ---- cadence-due beats rotation: morning hour surfaces the morning recipe ----
{
  const chips = Starters.pick({
    recipes: CATALOG, recent: [{ id: 'deep-dive', at: 200 }], returning: true, hour: 8, day: 5
  });
  A.ok(chips[1].kind === 'recipe' && chips[1].recipe.id === 'morning-brief', 'cadence: 8am slot 2 = morning recipe');
}

// ---- usual skips a launch whose recipe left the catalog ----
{
  const chips = Starters.pick({
    recipes: CATALOG, recent: [{ id: 'gone-recipe', at: 300 }, { id: 'bug-hunt', at: 100 }], returning: true, hour: 20, day: 0
  });
  A.ok(chips[0].kind === 'recipe' && chips[0].recipe.id === 'bug-hunt', 'usual: dead catalog id skipped for the next real one');
}

// ---- discovery rotates by day over never-launched recipes, deterministically ----
{
  const sig = day => ({ recipes: CATALOG, recent: [{ id: 'morning-brief', at: 100 }], returning: true, hour: 20, day });
  const d0 = Starters.pick(sig(0))[1].recipe.id;
  const d1 = Starters.pick(sig(1))[1].recipe.id;
  const d0b = Starters.pick(sig(0))[1].recipe.id;
  A.eq(d0, d0b, 'discovery: same day → same pick (deterministic)');
  A.ok(d0 !== d1, 'discovery: different day → rotated pick');
  A.ok(d0 !== 'morning-brief' && d1 !== 'morning-brief', 'discovery: usual/launched recipe not re-pitched off-hours');
}

// ---- fail-open: garbage signals and empty catalog still yield chips ----
{
  A.notThrows(() => Starters.pick(null), 'fail-open: null signals');
  A.notThrows(() => Starters.pick({ recipes: 'nope', recent: 42, valuesOf: 7, hour: 'x', day: NaN, returning: true }), 'fail-open: garbage signals');
  const none = Starters.pick({ recipes: [], recent: [], returning: true, hour: 10, day: 1 });
  A.ok(none.length >= 2 && none.every(c => c.kind === 'send'), 'fail-open: empty catalog → send chips only');
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

// ---- V3 §6: the pitch chip rides the shared readiness gate ----
{
  const sig = { recipes: CATALOG, recent: [{ id: 'morning-brief', at: 5 }], valuesOf: () => null, returning: true, hour: 9, day: 3 };
  A.ok(Starters.pick(Object.assign({}, sig, { ready: true })).some(c => c.label === 'pitch me an idea'), 'ready station keeps the pitch chip');
  const gated = Starters.pick(Object.assign({}, sig, { ready: false }));
  A.eq(gated.some(c => c.label === 'pitch me an idea'), false, 'below the readiness gate the pitch chip is gone');
  A.eq(gated.length, 3, 'the gated slot pads back to a full chip row (classic openers)');
  A.ok(Starters.pick(sig).some(c => c.label === 'pitch me an idea'), 'undefined ready keeps legacy behavior (callers without the read)');
}

A.report('starters');
