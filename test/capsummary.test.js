/* node test/capsummary.test.js -- the truthful capabilities note appended to the system prompt.
   Verifies it is derived from the resolved grant set, names the object to place for missing core
   powers, is interactive-only, and does not erase real host-granted/dynamic tools. */
'use strict';
const A = require('./_assert.js');
const { summarizeCapabilities } = require('../sidecar/capability/capsummary.js');

// helper: a resolved-like object from a list of capIds
const resolvedWith = (...capIds) => ({ grants: capIds.map((id) => ({ capId: id, tool: id + '.x' })) });

(function () {
  // 1) interactive, nothing placed (compute-only) -> honest "can't yet" + place-the-object guidance
  const none = summarizeCapabilities(resolvedWith(), { surface: 'interactive' });
  A.ok(/think and reply/.test(none), 'compute-only: says it can still think and reply');
  A.ok(/do NOT have/.test(none), 'compute-only: declares missing powers');
  A.ok(/place a DISH/.test(none) && /place a CABINET/.test(none) && /place a WORKBENCH/.test(none),
    'compute-only: names DISH + CABINET + WORKBENCH to place');
  A.ok(/do NOT claim, promise, or pretend/.test(none), 'compute-only: explicit no-over-promising instruction');

  // 2) interactive, a DISH placed (web/browser) -> web/browser in CAN, not in the lack list
  const web = summarizeCapabilities(resolvedWith('web'), { surface: 'interactive' });
  A.ok(/You CAN:.*search\/fetch the web and use the controlled browser/.test(web), 'web present: listed under CAN');
  A.ok(!/web.*-> place a DISH/.test(web), 'web present: not nagged to place a DISH');
  A.ok(/place a CABINET/.test(web) && /place a WORKBENCH/.test(web), 'web present: still flags files + shell');

  // 3) interactive, all core placed -> no "do NOT have" section at all
  const full = summarizeCapabilities(resolvedWith('web', 'cabinet', 'workbench', 'memory'), { surface: 'interactive' });
  A.ok(!/do NOT have/.test(full), 'all core placed: no missing-powers section');
  A.ok(/run shell commands, verify code, and control the desktop computer/.test(full) && /read and write files/.test(full),
    'all core placed: lists them under CAN');

  // 4) autonomous surface -> empty (full office, no placement UI)
  A.eq(summarizeCapabilities(resolvedWith(), { surface: 'autonomous' }), '', 'autonomous: no note');
  A.eq(summarizeCapabilities(resolvedWith('web'), { surface: 'autonomous' }), '', 'autonomous: no note even with grants');

  // 5) no surface specified -> behaves as interactive (emits the note)
  A.ok(summarizeCapabilities(resolvedWith()).length > 0, 'unspecified surface defaults to interactive (emits)');

  // 6) robustness: null/garbage input never throws, returns a string
  A.eq(typeof summarizeCapabilities(null, { surface: 'interactive' }), 'string', 'null resolved: still returns a string');
  A.eq(typeof summarizeCapabilities({}, {}), 'string', 'empty resolved + empty opts: string');

  // 7) non-core caps surface under CAN but are NEVER nagged as missing
  const studio = summarizeCapabilities(resolvedWith('studio'), { surface: 'interactive' });
  A.ok(/You CAN:.*generate and analyze images/.test(studio), 'studio present: listed under CAN');
  A.ok(!/do NOT have:[^\n]*image/i.test(none), 'studio is never listed under "do NOT have"');
  A.ok(!/do NOT have:[^\n]*memory/i.test(none), 'memory is never nagged as missing');

  // 8) the exact power -> object pairing is correct
  A.ok(/search\/fetch the web and use the controlled browser -> place a DISH/.test(none), 'pairing: web/browser -> DISH');
  A.ok(/read and write files -> place a CABINET/.test(none), 'pairing: files -> CABINET');
  A.ok(/run shell commands, verify code, and control the desktop computer -> place a WORKBENCH/.test(none),
    'pairing: shell/verify/computer -> WORKBENCH');

  // 9) the note is AUTHORITATIVE (defeats an earlier unconditional "you always have web/files" identity clause)
  A.ok(/AUTHORITATIVE/.test(none) && /ignore it/.test(none), 'note explicitly overrides any earlier blanket capability claim');

  // 10) malformed grants array (null / {} / blank capId) is tolerated and contributes nothing
  const junk = summarizeCapabilities({ grants: [null, {}, { capId: '' }, { capId: 'web' }] }, { surface: 'interactive' });
  A.ok(/You CAN:.*search\/fetch the web and use the controlled browser/.test(junk),
    'malformed grants: still surfaces the valid web cap');
  A.ok(!/undefined|null/.test(junk), 'malformed grants: no junk leaks into the note');

  // 11) host-granted and dynamic powers must not be erased by the authoritative block
  const lead = summarizeCapabilities(resolvedWith('orchestrator'), { surface: 'interactive' });
  A.ok(/delegate to crew, spawn subagents, summon specialists, and create routines/.test(lead),
    'orchestrator present: lead powers are listed under CAN');
  const jukebox = summarizeCapabilities(resolvedWith('jukebox'), { surface: 'interactive' });
  A.ok(/search and control Spotify/.test(jukebox), 'jukebox present: listed under CAN');
  const conn = summarizeCapabilities({ grants: [], tools: ['mcp__github__list_issues'] }, { surface: 'interactive' });
  A.ok(/live MCP connector tools/.test(conn), 'dynamic MCP connector tools are acknowledged instead of hidden');

  A.report('capsummary.test');
})();
