'use strict';

const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'frontend', 'app', 'stationui.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend', 'css', 'app.css'), 'utf8');

// These components landed as one Commander Dossier redesign. A later merge kept the markup but
// dropped its CSS, leaving prompt text overflowing the window and starter chips rendered as raw
// browser controls. Keep the render contract coupled so that class of lost work fails test:fast.
const required = [
  'cd-brief', 'cd-brief-head', 'cd-brief-h', 'cd-brief-meter', 'cd-brief-text',
  'cd-brief-empty', 'cd-brief-foot', 'cd-flows', 'cd-flow', 'cd-brief-copy',
  'cd-trim-tag', 'cd-dims', 'cd-starters', 'cd-starter'
];

for (const cls of required) {
  A.ok(ui.includes(cls), 'Commander Dossier markup still emits .' + cls);
  A.ok(new RegExp('\\.' + cls + '(?:[\\s:{.,>#]|$)').test(css), 'Commander Dossier CSS still styles .' + cls);
}

A.ok(/\.cd-brief-text\s*\{[^}]*white-space:\s*pre-wrap;[^}]*word-break:\s*break-word;/s.test(css),
  'verbatim briefing text wraps inside its terminal well');
A.ok(/\.cd-dims\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s.test(css),
  'Commander dimensions retain their bounded two-column layout');

A.report('commander-dossier-css.test');
