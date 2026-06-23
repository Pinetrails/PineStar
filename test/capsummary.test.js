/* node test/capsummary.test.js — the truthful capabilities note appended to the system prompt.
   Verifies it is derived from the resolved grant set, names the object to place for missing core
   powers, and is interactive-only. */
'use strict';
const A = require('./_assert.js');
const { summarizeCapabilities } = require('../sidecar/capability/capsummary.js');

// helper: a resolved-like object from a list of capIds
const resolvedWith = (...capIds) => ({ grants: capIds.map((id) => ({ capId: id, tool: id + '.x' })) });

(function () {
  // 1) interactive, nothing placed (compute-only) → honest "can't yet" + place-the-object guidance
  const none = summarizeCapabilities(resolvedWith(), { surface: 'interactive' });
  A.ok(/think and reply/.test(none), 'compute-only: says it can still think and reply');
  A.ok(/do NOT have/.test(none), 'compute-only: declares missing powers');
  A.ok(/place a DISH/.test(none) && /place a CABINET/.test(none) && /place a WORKBENCH/.test(none),
    'compute-only: names DISH + CABINET + WORKBENCH to place');
  A.ok(/do NOT claim, promise, or pretend/.test(none), 'compute-only: explicit no-over-promising instruction');

  // 2) interactive, a DISH placed (web) → web in CAN, not in the lack list; files+shell still flagged
  const web = summarizeCapabilities(resolvedWith('web'), { surface: 'interactive' });
  A.ok(/You CAN:.*search and fetch the web/.test(web), 'web present: listed under CAN');
  A.ok(!/web.*→ place a DISH/.test(web), 'web present: not nagged to place a DISH');
  A.ok(/place a CABINET/.test(web) && /place a WORKBENCH/.test(web), 'web present: still flags files + shell');

  // 3) interactive, all core placed → no "do NOT have" section at all
  const full = summarizeCapabilities(resolvedWith('web', 'cabinet', 'workbench', 'memory'), { surface: 'interactive' });
  A.ok(!/do NOT have/.test(full), 'all core placed: no missing-powers section');
  A.ok(/run shell commands/.test(full) && /read and write files/.test(full), 'all core placed: lists them under CAN');

  // 4) autonomous surface → empty (full office, no placement UI)
  A.eq(summarizeCapabilities(resolvedWith(), { surface: 'autonomous' }), '', 'autonomous: no note');
  A.eq(summarizeCapabilities(resolvedWith('web'), { surface: 'autonomous' }), '', 'autonomous: no note even with grants');

  // 5) no surface specified → behaves as interactive (emits the note)
  A.ok(summarizeCapabilities(resolvedWith()).length > 0, 'unspecified surface defaults to interactive (emits)');

  // 6) robustness: null/garbage input never throws, returns a string
  A.eq(typeof summarizeCapabilities(null, { surface: 'interactive' }), 'string', 'null resolved: still returns a string');
  A.eq(typeof summarizeCapabilities({}, {}), 'string', 'empty resolved + empty opts: string');

  A.report('capsummary.test');
})();
