'use strict';

/* textsize-screen-space.test.js — THE "TEXT SIZE is a type dial, not a magnifying glass" gate.
 *
 * Two reports from Andrew, one root cause. TEXT SIZE is a `zoom` on <body> (stationui.js
 * applySettings) and zoom multiplies into EVERY descendant length, so it scaled things that are
 * HARDWARE rather than content:
 *   2026-08-02, the tube: "it kind of ruins the look… enlarges it in a strange way." The glass
 *     overlay's beam pitch is authored in hard px, so it stretched with the text — measured live at
 *     1440x900, a 3px pitch rendered at 3.45 / 3.90 / 4.35px at LARGE / X-LARGE / HUGE.
 *   2026-08-03, the cabinet: measured live at 1911x935, the crew rail went 232→336px and COMMS
 *     360→522px, which squeezed the station view 1279→995px — asking for bigger text made the thing
 *     you actually watch 29% SMALLER, while the nameplates, the baked logo, the dock and every
 *     corner radius inflated 45%.
 *
 * The law: the tube and the cabinet are HARDWARE — they sit in front of and around the picture,
 * they are not part of it. Only what you READ scales. stationui publishes `--sn-unzoom` (the exact
 * reciprocal of the zoom it applies); `body` binds it to `--cz`, and every hardware length is
 * written `calc(<designed>px * var(--cz))` so it lands back at the size it was drawn at.
 *
 * Guarded here, because each is one careless edit away:
 *   1. the reciprocal stops being published (or stops being removed at 100%) -> everything stretches
 *      again, or 100% stops being the untouched shipped default;
 *   2. a gradient re-tune drops `* var(--cz)` off one stop -> that stop stretches while its
 *      neighbours don't, which is worse than the original bug;
 *   3. a cabinet dimension gets written as a bare px -> the frame starts eating the station again;
 *   4. something inside a counter-zoomed block positions itself with U.uiZoom() -> it lands off by
 *      the zoom factor, because the cabinet's local frame is visual px while <body> is zoomed.
 *
 * Deliberately NOT guarded: the VALUES. Stop alphas, radii, rail widths are a look — tuned in
 * crtlab and by eye — and this gate must not freeze the look, only the screen-space property of it.
 */

const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
// strip comments: this file's own prose names the very things it forbids (`background-size`,
// `zoom:`), and control-floor-theming.test hit the same self-trip before it.
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const stationui = read('frontend', 'app', 'stationui.js');
const styleCss = read('frontend', 'css', 'style.css');
const marketCss = read('frontend', 'css', 'marketplace.css');

// ---- 1. stationui publishes the reciprocal beside the zoom it applies ---------------------
A.ok(/document\.body\.style\.zoom\s*=\s*String\(tz\s*\/\s*100\)/.test(stationui),
  'stationui still applies TEXT SIZE as a body zoom (this gate is about that zoom)');
A.ok(/setProperty\(\s*'--sn-unzoom'\s*,\s*String\(100\s*\/\s*tz\)\s*\)/.test(stationui),
  'stationui publishes --sn-unzoom as the EXACT reciprocal of the applied zoom (100 / tz)');
A.ok(/removeProperty\(\s*'--sn-unzoom'\s*\)/.test(stationui),
  'stationui removes --sn-unzoom at 100%, so the plain-desktop default leaves no inline style behind');
// The reciprocal is only correct if it is written from the SAME resolved scale as the zoom. Both
// must read `tz` (resolveTextScale's output), never the raw stored setting — AUTO stores 0 and
// resolves to a screen-derived percent, so a reciprocal taken from the raw value would be nonsense.
A.ok(/const tz = resolveTextScale\(s\.textScale\);[\s\S]{0,2000}?'--sn-unzoom'/.test(stationui),
  'the --sn-unzoom publish sits in the same applySettings block that resolves tz');
// ...and `body` turns it into the multiplier every hardware length is written against.
A.ok(/--cz:\s*var\(--sn-unzoom,\s*1\)/.test(styleCss),
  'style.css `body` binds --cz from --sn-unzoom, defaulting to 1 (= the untouched shipped look)');

// ---- the two screen-space glass layers ---------------------------------------------------
// marketplace.css's own comment names body::after as its source of truth ("retune both together"),
// so they are gated together by that same rule.
const LAYERS = [
  { what: 'style.css body::after (the station glass)', css: styleCss, sel: 'body::after' },
  { what: 'marketplace.css .mkt-scrim::after (the bay glass)', css: marketCss, sel: '.mkt-scrim::after' },
];

// every rule in the sheet whose selector ENDS in this exact selector (base rule + @media overrides)
function rulesFor(css, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (css.match(new RegExp('(?:^|[},])[^{}]*?' + esc + '\\s*\\{[^{}]*\\}', 'gm')) || [])
    .map(r => r.slice(r.indexOf('{') + 1, r.lastIndexOf('}')));
}

for (const layer of LAYERS) {
  const all = rulesFor(layer.css, layer.sel);
  A.ok(all.length, layer.what + ' still exists as a rule');

  // ---- 2. the layer re-binds the reciprocal (base rule; @media overrides inherit it) ------
  A.ok(all.some(b => /--cz:\s*var\(--sn-unzoom,\s*1\)/.test(b)),
    layer.what + ' re-binds --cz from --sn-unzoom, defaulting to 1 (= the untouched shipped look)');

  // ---- 3. EVERY px stop in EVERY glass gradient carries the reciprocal --------------------
  // The hi-DPI (min-resolution) branch is a SEPARATE rule with its own full copy of the
  // gradients — a re-tune that only fixes the base branch leaves dense displays stretching.
  const painting = all.filter(b => b.includes('repeating-linear-gradient'));
  A.ok(painting.length >= 2, layer.what + ' has both the base gradients and their hi-DPI override');

  painting.forEach((body, i) => {
    const tag = `${layer.what} rule #${i + 1}`;
    A.ok(/repeating-linear-gradient\(0deg/.test(body), tag + ' still paints the beam scanlines');
    A.ok(/repeating-linear-gradient\(90deg/.test(body), tag + ' still paints the aperture grille');
    // every non-zero px length in the rule...
    const lengths = (body.match(/\b\d+(?:\.\d+)?px\b/g) || []).filter(s => parseFloat(s) !== 0);
    // ...must appear as calc(<px> * var(--cz)). `0px`/`0` is the gradient origin: it scales trivially.
    const wrapped = body.match(/calc\(\s*\d+(?:\.\d+)?px\s*\*\s*var\(--cz\)\s*\)/g) || [];
    A.ok(lengths.length > 0, tag + ' actually declares beam geometry');
    A.eq(wrapped.length, lengths.length,
      tag + ': every non-zero px stop is calc(<px> * var(--cz)) — ' +
      `${lengths.length} px length(s) present, ${wrapped.length} carrying the reciprocal`);
  });

  // ---- 4. the glass must not fight the layout it sits over --------------------------------
  // The reciprocal is applied to the gradient STOPS on purpose. Applying it as `zoom`/`transform`
  // on the overlay instead would change the fixed-position containing block and the stacking
  // order; a tiled `background-size` would re-introduce the tile-seam moire that the hi-DPI
  // branch exists to avoid. Keep both out of the glass rules.
  for (const body of all) {
    A.ok(!/(?:^|[\s;{])zoom\s*:/.test(body), layer.what + ' cancels the zoom in its stops, not with its own zoom');
    A.ok(!/(?:^|[\s;{])transform\s*:/.test(body), layer.what + ' does not scale itself with a transform');
    A.ok(!/(?:^|[\s;{])background-size\s*:/.test(body), layer.what + ' keeps ONE continuous rasterisation (no tiled background-size)');
  }
}

/* ================= THE CABINET ================= */
const appCss = read('frontend', 'css', 'app.css');

// ---- 5. every cabinet DIMENSION is written against the multiplier -------------------------
// This is the one that keeps the station view whole: the rails, the bar heights and the frame
// padding must resolve to the size they were designed at, so `1fr` hands the rest to the stage.
const grid = rulesFor(appCss, '#screen-game.active')[0];   // rulesFor escapes the selector itself
A.ok(grid, 'app.css still lays the station grid out on #screen-game.active');
/* Strip every balanced `calc(… * var(--cz))` group. Whatever px survives is a length that does
   NOT ride the multiplier — a bare regex can't do this because `calc(var(--chat-w, 360px) *
   var(--cz))` nests parens, and that 360px IS covered (the whole var expression is multiplied). */
function stripMultiplied(decl) {
  for (;;) {
    const i = decl.indexOf('calc(');
    if (i < 0) return decl;
    let depth = 0, end = -1;
    for (let j = i + 4; j < decl.length; j++) {
      if (decl[j] === '(') depth++;
      else if (decl[j] === ')' && --depth === 0) { end = j; break; }
    }
    if (end < 0) return decl;                       // unbalanced — leave it to be counted
    const inner = decl.slice(i + 5, end);
    const covered = /\*\s*var\(--cz\)\s*$/.test(inner.trim());
    decl = decl.slice(0, i) + (covered ? ' ' : ' ‹' + inner + '› ') + decl.slice(end + 1);
    if (!covered) decl = decl.replace('‹', '').replace('›', '');   // keep its px, drop the calc()
  }
}
for (const prop of ['grid-template-rows', 'grid-template-columns', 'padding', 'gap']) {
  const m = new RegExp(prop + ':([^;]*);').exec(grid || '');
  A.ok(m, `the grid still declares ${prop}`);
  if (!m) continue;
  const left = (stripMultiplied(m[1]).match(/\b\d+(?:\.\d+)?px\b/g) || []).filter(s => parseFloat(s) !== 0);
  A.eq(left, [],
    `${prop} is cabinet — every px must be calc(<designed>px * var(--cz)), or the frame eats the ` +
    `station again. Not riding the multiplier: ${left.join(', ') || 'none'}`);
}
// --chat-w rides the multiplier too, so a width the Commander dragged means the same thing at
// every text size instead of silently meaning 45% more at HUGE.
A.ok(/var\(--chat-w[^)]*\)\s*\*\s*var\(--cz\)/.test(grid || ''),
  'the dragged COMMS width is measured in the same visual frame as the rest of the cabinet');

// ---- 6. the counter-zoomed blocks --------------------------------------------------------
// Their boxes are fixed by the grid above, so their CONTENTS have to come back to 1:1 or they
// overflow a box that no longer grows with them. `--cz: 1` inside keeps the shared
// `calc(<designed>px * var(--cz))` rules correct on both sides of that line.
const frameRule = /([^{}]*)\{\s*zoom:\s*var\(--sn-unzoom,\s*1\);\s*--cz:\s*1;\s*\}/.exec(appCss);
A.ok(frameRule, 'app.css counter-zooms the cabinet blocks back to 1:1 and resets --cz to 1 inside them');
for (const sel of ['#topbar', '#bottombar', '#logo', '#left > h3', '#chat-panel > h3', '.ws-head']) {
  A.ok(frameRule && frameRule[1].includes(sel), `${sel} is cabinet — it holds its designed size`);
}

// ---- 7. the bezel keeps the geometry it was drawn with ------------------------------------
// A zoomed 9px corner reads as 13px and the casing goes blobby; the phosphor ring thickens the
// same way. These are the panels that KEEP the type zoom, so they need the multiplier explicitly.
A.ok(/#topbar, #left, #right, #bottombar, #center\s*\{[^{}]*border-radius:\s*calc\(9px \* var\(--cz\)\)/.test(styleCss),
  'the panel bezel radius holds its drawn size at every text size');
for (const sel of ['#stage-wrap', '#chat-panel']) {
  const body = rulesFor(appCss, sel).find(b => /border-radius/.test(b));
  A.ok(body, `${sel} still declares its bezel`);
  if (!body) continue;
  A.ok(/border-radius:\s*calc\([^)]*var\(--cz\)\)/.test(body), `${sel}'s corner holds its drawn radius`);
  A.ok(/box-shadow:[^;]*calc\([^)]*var\(--cz\)\)/.test(body), `${sel}'s phosphor ring holds its drawn thickness`);
}

// ---- 8. the coordinate law follows the counter-zoom ---------------------------------------
// uiZoom() is only the right divisor for a <body> CHILD. Anything positioned INSIDE a cabinet
// block writes visual px, so it must measure the zoom the engine actually applied to it.
const util = read('frontend', 'js', 'util.js');
A.ok(/elZoom\(el\)/.test(util), 'U.elZoom exists — the divisor for an element that may live in the cabinet');
A.ok(/getComputedStyle\(n\)\.zoom/.test(util), 'U.elZoom composes the zooms the engine actually applied, rather than assuming');
const navdock = read('frontend', 'app', 'navdock.js');
const clamp = /function clampMenu\([\s\S]*?\n  \}/.exec(navdock);
A.ok(clamp, 'navdock still clamps its popover');
if (clamp) {
  A.ok(/U\.elZoom\(menu\)/.test(clamp[0]),
    'the dock popover divides by ITS OWN zoom — it lives inside #bottombar, which is counter-zoomed');
  A.ok(!/U\.uiZoom\(\)/.test(clamp[0]),
    'the dock popover no longer uses the <body> zoom, which is now the wrong frame for it');
}

A.report('textsize-screen-space.test');
