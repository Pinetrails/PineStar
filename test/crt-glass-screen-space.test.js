'use strict';

/* crt-glass-screen-space.test.js — THE "TEXT SIZE must not resize the tube" gate.
 *
 * The bug (reported by Andrew 2026-08-02): pick TEXT SIZE = HUGE and the CRT filter looks blown
 * up — the beam lines go fat and widely spaced instead of staying the same lines. Cause: TEXT SIZE
 * is a `zoom` on <body> (stationui.js applySettings), and zoom multiplies into EVERY descendant
 * length — including the glass overlay's hard-px gradient stops. Measured live at 1440x900: the
 * 3px beam pitch rendered at 3.45 / 3.90 / 4.35px at LARGE / X-LARGE / HUGE.
 *
 * The law: the CRT glass is screen-space HARDWARE — the tube sits in front of the picture, it is
 * not part of the picture. Its pitch is a property of the glass and must not move when the content
 * under it is scaled. stationui publishes `--crt-unzoom` (the exact reciprocal of the zoom it
 * applies) and each glass layer re-binds it as `--cz` and multiplies EVERY stop by it.
 *
 * Both failure modes are guarded, because both are one careless edit away:
 *   1. the reciprocal stops being published (or stops being removed at 100%) -> the glass stretches
 *      again, or 100% stops being the untouched shipped default;
 *   2. someone re-tunes the gradients and drops the `* var(--cz)` off a stop -> that one stop
 *      stretches while its neighbours don't, which is worse than the original bug.
 *
 * Deliberately NOT guarded here: the stop VALUES. Those are a look, tuned in crtlab, and this gate
 * must not freeze the look — only the screen-space property of it.
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
A.ok(/setProperty\(\s*'--crt-unzoom'\s*,\s*String\(100\s*\/\s*tz\)\s*\)/.test(stationui),
  'stationui publishes --crt-unzoom as the EXACT reciprocal of the applied zoom (100 / tz)');
A.ok(/removeProperty\(\s*'--crt-unzoom'\s*\)/.test(stationui),
  'stationui removes --crt-unzoom at 100%, so the plain-desktop default leaves no inline style behind');
// The reciprocal is only correct if it is written from the SAME resolved scale as the zoom. Both
// must read `tz` (resolveTextScale's output), never the raw stored setting — AUTO stores 0 and
// resolves to a screen-derived percent, so a reciprocal taken from the raw value would be nonsense.
A.ok(/const tz = resolveTextScale\(s\.textScale\);[\s\S]{0,900}?'--crt-unzoom'/.test(stationui),
  'the --crt-unzoom publish sits in the same applySettings block that resolves tz');

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
  A.ok(all.some(b => /--cz:\s*var\(--crt-unzoom,\s*1\)/.test(b)),
    layer.what + ' re-binds --cz from --crt-unzoom, defaulting to 1 (= the untouched shipped look)');

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

A.report('crt-glass-screen-space.test');
