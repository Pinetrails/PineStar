'use strict';

/* station-tooltip.test.js — the OS never paints StarNet's UI.
 *
 * Companion to control-floor-theming.test.js. That one keeps the browser from painting our CONTROLS;
 * this one keeps it from painting our DIALOGS and our TOOLTIPS — the other two surfaces the user agent
 * will happily draw in system chrome if nobody stops it:
 *   1. window.confirm/alert/prompt — an OS modal over the phosphor terminal (armconfirm.js exists
 *      precisely so no call site needs one).
 *   2. title="…" — the native hover bubble, grey and in the system font, on the OS's own timer.
 *      tooltip.js adopts every [title] into [data-tip] and draws the station's own card instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
// Strip block comments AND trailing line comments — this file's own prose says "prompt (persona…"
// and "system prompt (…", which a naive scan reads as a call. The `[^:]` guard keeps `https://` intact.
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---- 1. no native dialog anywhere in the shipped frontend ---------------------------------
const jsFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) walk(rel);
    else if (entry.name.endsWith('.js')) jsFiles.push(rel);
  }
})('frontend/app');

for (const rel of jsFiles) {
  const code = stripComments(read(rel));
  // window.alert(...) / window.confirm(...) / window.prompt(...) — the qualified form
  A.ok(!/window\s*\.\s*(alert|confirm|prompt)\s*\(/.test(code),
    rel + ' calls no native window dialog (use ArmConfirm / a station panel instead)');
  // the bare form, but NOT `Foo.confirm(` / `function confirm(` — the app has its own confirm() APIs
  A.ok(!/(?:^|[;{}()\s])(?:alert|prompt)\s*\(/m.test(code.replace(/\.\s*(alert|prompt)\s*\(/g, '.X(')),
    rel + ' calls no bare alert()/prompt()');
}

// the discard flow specifically — this is the one that regressed into window.confirm
const deliverables = read('frontend/app/deliverables.js');
A.ok(/ArmConfirm\.wire\(/.test(deliverables), 'the DELIVERABLES discard arms through ArmConfirm');
A.ok(/armedLabel:/.test(deliverables), 'the armed discard label admits what is about to happen');
A.ok(/permanently/i.test(deliverables), 'the permanence warning the native dialog used to carry still exists');

// ---- 2. every control the app renders carries a surface class ------------------------------
// A class-less <button> is not a paint bug any more (the CONTROL FLOOR catches it) but it still
// ships without station chrome — cramped, UA-sized, square. These three were the last of them.
for (const rel of ['frontend/app/deliverables.js', 'frontend/app/stationui.js']) {
  const code = read(rel);
  for (const id of ['dl-clean-apply', 'dl-undo', 'ag-ws-now']) {
    const m = new RegExp('<button[^>]*id="' + id + '"').exec(code);
    if (!m) continue;
    const tag = code.slice(m.index, code.indexOf('>', m.index) + 1);
    A.ok(/class="[^"]*\bbb\b/.test(tag), id + ' renders as a station button (class="bb …"), not a bare <button>');
  }
}

// ---- 3. the tooltip controller is shipped, wired, and adopts every title -------------------
const tooltip = read('frontend/app/tooltip.js');
const indexHtml = read('frontend/index.html');
A.ok(/<script src="app\/tooltip\.js">/.test(indexHtml), 'tooltip.js is loaded by index.html');
A.ok(/removeAttribute\('title'\)/.test(tooltip), 'the controller REMOVES title — that is what silences the OS bubble');
A.ok(/data-tip/.test(tooltip), 'the adopted text lives on data-tip');
A.ok(/data-no-tip/.test(tooltip), 'an element that owns a richer tip can opt out');
A.ok(/aria-describedby/.test(tooltip), 'the live card is announced as the description');
// the uiZoom law: a body-child fixed card MUST divide rects by the zoom factor
A.ok(/style\.zoom/.test(tooltip) && /\/\s*z\b/.test(tooltip),
  'tooltip.js honours the uiZoom law (rects are visual px, body-child style px are zoomed)');
A.ok(/\.station-tip\s*\{/.test(read('frontend/css/app.css')), 'the station tooltip card is styled');

// the ONE element allowed to keep a native title would still let the OS paint — so none may.
const titlesInHtml = (indexHtml.match(/\stitle="/g) || []).length;
A.ok(!/id="model-dock-toggle"[^>]*\stitle="/.test(indexHtml),
  'the model dock keeps no native title (it owns .model-dock-tip and opted out)');

// ---- 4. the pure geometry, exercised ------------------------------------------------------
const T = require('../frontend/app/tooltip.js');
const vp = { width: 1000, height: 800 }, tip = { width: 200, height: 40 };
const above = T.place({ left: 400, top: 300, width: 100, height: 20 }, tip, vp);
A.eq(above.below, false, 'a tip with room above renders above its anchor');
A.eq(above.left + tip.width / 2, 450, 'and is centred on the anchor');
const flipped = T.place({ left: 400, top: 10, width: 100, height: 20 }, tip, vp);
A.eq(flipped.below, true, 'a tip with no room above flips below');
const clampedL = T.place({ left: 0, top: 300, width: 20, height: 20 }, tip, vp);
A.ok(clampedL.left >= 0, 'a tip at the left edge stays on screen');
const clampedR = T.place({ left: 980, top: 300, width: 20, height: 20 }, tip, vp);
A.ok(clampedR.left + tip.width <= vp.width, 'a tip at the right edge stays on screen');
A.ok(clampedR.arrowX <= tip.width - 10 && clampedR.arrowX >= 10,
  'the arrow stays inside the card after clamping (it must keep pointing at the anchor, not off the corner)');
A.ok(T.adopt(null) === '', 'adopt() tolerates a null element');

A.report('station-tooltip.test');
