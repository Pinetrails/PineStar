'use strict';

/* Primary-brand regression guard for the temporary text-only Pine Star identity.
 * The old test validated an excluded StarNet SVG mask. Pine Star intentionally keeps the proven
 * topbar positioning/occlusion structure while removing that asset dependency. This test guards
 * the new truthful state and retains the useful z-order contract.
 */

const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'frontend', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');

// Primary visible brand surfaces are text-only Pine Star.
A.ok(/<title>PINE STAR<\/title>/.test(html), 'document title identifies PINE STAR');
A.ok(/class="boot-mark"[^>]*>[^<]*PINE STAR</.test(html), 'boot veil visibly identifies PINE STAR');
A.ok(/class="sp-logo brand-text"[^>]*aria-label="Pine Star"[^>]*>PINE STAR<\/div>/.test(html),
  'splash uses accessible text-only Pine Star branding');
A.ok(/class="logo-img"[^>]*aria-label="Pine Star"[^>]*>PINE STAR<\/span>/.test(html),
  'primary topbar uses accessible text-only Pine Star branding');
const consoleTags = Array.from(html.matchAll(/class="cc-tb-tag">([^<]+)<\/span>/g), m => m[1]);
A.ok(consoleTags.length >= 1 && consoleTags.every(tag => tag === 'PINE STAR'),
  'every primary console header tag visibly identifies PINE STAR');

// Excluded upstream wordmark/logo assets are not required by the primary shell.
A.ok(!/assets\/brand\/starnet-logo(?:-small)?\.png/.test(html),
  'primary frontend does not reference an excluded StarNet logo PNG');
A.ok(!/assets\/brand\/starnet-wordmark\.svg/.test(html),
  'primary frontend markup does not reference the excluded StarNet SVG wordmark');
const markRule = (css.match(/\.logo-img\s*\{[^}]*\}/) || [])[0] || '';
A.ok(markRule, 'style.css retains the .logo-img structural rule');
A.ok(!/(?:-webkit-)?mask\s*:|url\([^)]*starnet-wordmark\.svg/i.test(markRule),
  'primary topbar brand rule has no StarNet mask dependency');
A.ok(/font-size:/.test(markRule) && /letter-spacing:/.test(markRule),
  'text-only topbar brand keeps explicit readable typography');

// Preserve the established overlay/window behavior around the hoisted brand container.
const logoRule = (css.match(/#logo\s*\{[^}]*\}/) || [])[0] || '';
const logoZ = Number((logoRule.match(/z-index:\s*(\d+)/) || [])[1]);
const glassZ = (css.match(/body::(?:before|after)\s*\{[^}]*z-index:\s*(\d+)/g) || [])
  .map(s => Number((s.match(/z-index:\s*(\d+)/) || [])[1]))
  .filter(Number.isFinite);
A.ok(Number.isFinite(logoZ), '#logo declares a z-index');
A.ok(glassZ.length === 2, 'both CRT glass layers declare a z-index');
A.ok(logoZ < Math.min(...glassZ),
  `#logo z-index ${logoZ} remains under CRT glass layers ${glassZ.join('/')}`);
A.ok(logoZ > 10, `#logo z-index ${logoZ} remains above #screen-game for existing occlusion wiring`);
A.ok(/<div id="logo-anchor" aria-hidden="true"><\/div>/.test(html),
  'topbar still reserves the hoisted brand seat through #logo-anchor');
A.ok(/<script src="app\/logoclip\.js"><\/script>/.test(html),
  'existing window-occlusion wiring remains loaded');

A.report('brand-wordmark-mask.test');
