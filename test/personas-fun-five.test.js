/* node test/personas-fun-five.test.js — the FUN-five personality contract (2026-07-17).

   The law that admitted the fun set (Andrew, 2026-07-16): THE BIT NEVER EATS THE WORK — a persona
   changes only the delivery; execution fidelity, exact numbers, and honest failure reporting are
   untouched. That law shipped as prose inside each promptInjection with no lock, so a future copy
   edit could silently drop it. personas.js is a browser IIFE (module-scoped const, no export), so
   like chat-runmeta/outbox-window we lock the shipped source by reading it. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const personas = read('frontend/app/personas.js');
const app = read('frontend/app/app.js');
const chat = read('frontend/app/chat.js');
const css = read('frontend/css/app.css');

/* ---- the ten voices exist: grounded five + fun five, all frozen presets ---- */
const IDS = ['professional', 'friendly', 'direct', 'witty', 'calm', 'unhinged', 'hype', 'overlord', 'gremlin', 'noir'];
for (const id of IDS) {
  A.ok(new RegExp("'" + id + "':\\s*Object\\.freeze\\(\\{").test(personas), "preset '" + id + "' ships as a frozen preset");
}

/* ---- THE BIT NEVER EATS THE WORK: every fun preset pivots back to real execution ---- */
const FUN = ['unhinged', 'hype', 'overlord', 'gremlin', 'noir'];
const blockOf = id => {
  const header = "'" + id + "': Object.freeze({";
  const start = personas.indexOf(header);
  const end = personas.indexOf('Object.freeze({', start + header.length);
  return personas.slice(start, end === -1 ? start + 3000 : end);
};
for (const id of FUN) {
  const b = blockOf(id);
  A.ok(/When real WORK lands/.test(b), id + ': injection carries the "When real WORK lands" execution pivot (the bit never eats the work)');
  A.ok(/promptInjection:/.test(b) && /ambientLines:/.test(b), id + ': full preset shape (injection + ambient set)');
  A.ok(!/ttsVoice|ttsSpeed|ttsShell/.test(b), id + ': defines NO audible-voice override (the station voice is locked — personality changes words, never sound)');
}
// truth-fidelity language, per preset (each phrases the law in its own voice — pin each anchor)
A.ok(/NEVER bend the truth for a joke/.test(blockOf('unhinged')), 'unhinged: truth line pinned');
A.ok(/never oversell a result/.test(blockOf('hype')), 'hype: honest-hype line pinned');
A.ok(/never let the persona touch the facts/.test(blockOf('overlord')), 'overlord: facts line pinned');
A.ok(/never fudge a result for the bit/.test(blockOf('gremlin')), 'gremlin: result line pinned');
A.ok(/facts inside the story are always exact/.test(blockOf('noir')), 'noir: exact-facts line pinned');

/* ---- aliases: old saves land on their true homes; no unreachable gremlin alias ---- */
A.ok(/'hype-buddy':\s*'hype'/.test(personas), "legacy 'hype-buddy' saves resolve to the real HYPE preset");
A.ok(!/'gremlin':\s*'direct'/.test(personas), "the old gremlin->direct alias is gone (the real preset must win)");

/* ---- UNHINGED consent: two-press arm on the create screen, honesty note in chat ---- */
A.ok(/unhingedConfirmed = false/.test(app) && /unhingedConfirmed = true/.test(app), 'create screen: UNHINGED chip carries the house two-press confirm latch');
A.ok(/UNHINGED — SURE\? it swears, for real/.test(app), 'press one names exactly what confirming means');
A.ok(/each fresh create screen re-arms the UNHINGED two-press confirm/.test(app), 'the latch resets per create screen (initConnect)');
A.ok(/swears — for real/.test(chat), '/personality unhinged carries the same honesty note inline');
A.ok(/\.ov-vchip\.arm\s*\{/.test(css), 'the armed-chip warn state ships in css');

A.report('personas-fun-five.test');
