/* node test/dock-terms-open.test.js — the dock-button OPEN seam for the QUEST LOG and UPDATE CENTER windows.

   Closes Atlas finding 5c8f6921: the data-term="quests" / data-term="updates" dock buttons open their .term
   windows live (world audit), but NO machine assertion guarded the dock-button OPEN itself — the quests tests
   guard only the quest STORE, and updates had empty coverage. A shoot state was the owner-suggested route, but
   the OPEN is a static wiring chain that a source-lock pins deterministically without a browser:

     index.html .bb[data-term=KEY] button  →  stationui init() binds every .bb[data-term] click to
     toggleTerm(k, BUILDERS[k][0..2])  →  BUILDERS[KEY] = [TITLE, builderFn, opts]  →  builderFn exists.

   A break at ANY link (button removed, BUILDERS entry dropped, builder renamed) fails here BY NAME, not in a
   demo. Pure + fast (static source read, no DOM/boot). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');

const html = fs.readFileSync(require.resolve('../frontend/index.html'), 'utf8');
const sui = fs.readFileSync(require.resolve('../frontend/app/stationui.js'), 'utf8');

// (1) the generic dock-button binding: every .bb[data-term] click routes through toggleTerm via BUILDERS[k].
// This is the ONE seam that carries a data-term button to its window; if it regresses, NO dock button opens.
A.ok(/querySelectorAll\('\.bb\[data-term\]'\)[\s\S]{0,200}addEventListener\('click'/.test(sui),
  'stationui init() binds every .bb[data-term] dock button to a click handler');
A.ok(/const k = b\.dataset\.term, def = BUILDERS\[k\];[\s\S]{0,80}toggleTerm\(k, def\[0\], def\[1\], def\[2\]\)/.test(sui),
  'the dock-button click opens the window keyed by data-term via BUILDERS[k] → toggleTerm');

// (2) + (3) per-term chain: the button exists in the dock, the BUILDERS entry names the right window + builder,
// and the builder function is defined. Table-driven so each term fails by its own name.
// NAV CONDENSE 2 (2026-08-04): UPDATES is no longer a dock window — it is a SETTINGS section, reached
// by the same dock chain via data-term="settings"; its own chain is locked separately below.
const TERMS = [
  { key: 'quests', title: 'QUEST LOG', builder: 'buildQuests' }
];
for (const t of TERMS) {
  A.ok(new RegExp('<button class="bb" data-term="' + t.key + '"').test(html),
    'index.html has the ' + t.key.toUpperCase() + ' dock button (.bb[data-term="' + t.key + '"])');
  // BUILDERS[key] = ['TITLE', builderFn, ...] — assert the title + builder are bound to this key.
  const entry = new RegExp(t.key + ':\\s*\\[\\s*\'' + t.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\'[\\s\\S]{0,40}?' + t.builder + '\\b');
  A.ok(entry.test(sui), 'BUILDERS.' + t.key + " maps to ['" + t.title + "', " + t.builder + ', …] (title + builder bound to the dock key)');
  A.ok(new RegExp('function ' + t.builder + '\\b').test(sui) || new RegExp(t.builder + '\\s*=\\s*function').test(sui) || new RegExp('const ' + t.builder + '\\s*=').test(sui),
    t.builder + ' is a defined window builder (the OPEN produces a real panel, never a dead key)');
}

// (4) openTerm (the deep-link door the mission board / quest-review rows use to reach the SAME window) also
// routes through BUILDERS, so a beginner reaches the QUEST LOG from either the dock OR a projection click.
A.ok(/function openTerm\(key, section\)[\s\S]{0,300}const def = BUILDERS\[key\]/.test(sui),
  'openTerm(key) resolves the SAME BUILDERS map (dock button + projection deep-links share one open path)');

// (5) the UPDATE CENTER's new chain (NAV CONDENSE 2): the SETTINGS dock button exists, the SETTINGS
// console declares an 'updates' section built by buildUpdates, and the retired 'updates' term aliases
// into it — so every old deep link (and the dock) still lands on a real update surface.
A.ok(/<button class="bb" data-term="settings"/.test(html), 'index.html has the SETTINGS dock button');
A.ok(/id: 'updates', label: 'UPDATES'[\s\S]{0,120}buildUpdates\(/.test(sui),
  "SETTINGS declares the UPDATES section and builds it with buildUpdates");
A.ok(/function buildUpdates\b/.test(sui), 'buildUpdates is still a defined builder (Updates.render host)');
A.ok(/updates:\s*\{\s*term: 'settings',\s*section: 'updates'/.test(sui),
  "TERM_ALIAS routes the retired 'updates' key to SETTINGS ▸ UPDATES");

A.report('dock-terms-open.test');
