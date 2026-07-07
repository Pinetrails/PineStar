/* node test/dialogue.test.js — the GENESIS naming guard (frontend/app/dialogue.js).

   dialogue.js is browser-flow code, but its naming primitives (codename / isUnnamed) are PURE and touch no DOM
   at module load, so they load under node like xp.js. The invariant: a blank / whitespace / placeholder overseer
   name never leaves the awakening labelled with the bland generic 'AGENT' — it mints a real station codename
   instead, WITHOUT hard-blocking the flow (sandbox-no-gating: never trap the Commander on the name field). A real
   typed name is always honoured verbatim (trimmed + clamped to the 18-char nameplate cap). */
'use strict';
const A = require('./_assert.js');
const { Dialogue } = require('../frontend/app/dialogue.js');

// ---- codename(): a real, eerie-not-cute designation — never blank, never over the nameplate cap, never 'AGENT' ----
A.ok(typeof Dialogue.codename === 'function', 'codename() is exported');
const picks = [];
for (let i = 0; i < 200; i++) picks.push(Dialogue.codename());
A.ok(picks.every(n => typeof n === 'string' && n.length > 0), 'every codename is a non-empty string');
A.ok(picks.every(n => n.length <= 18), 'every codename honours the 18-char nameplate cap');
A.ok(picks.every(n => n === n.toUpperCase()), 'codenames are uppercase (station designation style)');
A.ok(picks.every(n => n.trim().toUpperCase() !== 'AGENT'), 'a minted codename is NEVER the bland generic AGENT');
A.ok(new Set(picks).size >= 5, 'the codename pool has real variety (>=5 distinct over 200 draws)');

// ---- isUnnamed(): blank / whitespace / the AGENT placeholder all read as "no real identity"; a real name does not ----
A.ok(typeof Dialogue.isUnnamed === 'function', 'isUnnamed() is exported');
A.eq(Dialogue.isUnnamed(''), true, 'empty string is unnamed');
A.eq(Dialogue.isUnnamed('   '), true, 'whitespace-only is unnamed');
A.eq(Dialogue.isUnnamed(null), true, 'null is unnamed');
A.eq(Dialogue.isUnnamed(undefined), true, 'undefined is unnamed');
A.eq(Dialogue.isUnnamed('AGENT'), true, 'the bland literal AGENT is treated as unnamed (the sentinel the WAKE funnel passes for a blank input)');
A.eq(Dialogue.isUnnamed('agent'), true, 'AGENT is matched case-insensitively');
A.eq(Dialogue.isUnnamed('  agent  '), true, 'AGENT with surrounding whitespace still reads as the placeholder');
A.eq(Dialogue.isUnnamed('ORION'), false, 'a real name is NOT unnamed');
A.eq(Dialogue.isUnnamed('Agent Smith'), false, 'a real name that merely CONTAINS agent is not the placeholder');

// ---- setName never hard-blocks and never regresses to the bland placeholder (pure-logic reachable in node: no DOM
//      is touched because the panel is not mounted, so speakerEl is null and the textContent write is skipped) ----
A.notThrows(() => Dialogue.setName(''), 'setName("") never throws or traps — the flow always advances');
A.notThrows(() => Dialogue.setName(null), 'setName(null) is safe');
A.notThrows(() => Dialogue.setName('NOVA'), 'setName with a real name is safe');

A.report('dialogue.test');
