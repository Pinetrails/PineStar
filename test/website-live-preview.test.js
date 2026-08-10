/* The homepage preview embeds the real frontend and crops to #stage. The stage geometry
   changes as the application shell evolves, so the crop must come from the live iframe DOM,
   never from another hard-coded snapshot that can silently age out. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'website', 'live-preview.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'website', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'website', 'index.html'), 'utf8');

A.ok(/contentDocument/.test(js) && /querySelector\(['"]#stage['"]\)/.test(js),
  'the homepage derives its crop from the embedded app stage');
A.ok(/getBoundingClientRect\(\)/.test(js) && /--appx/.test(js) && /--appy/.test(js) && /--app-aspect/.test(js),
  'the measured stage rectangle drives offset, scale, and aspect ratio');
A.ok(/ResizeObserver/.test(js) && /frame\.addEventListener\(['"]load['"]/.test(js),
  'the crop re-measures after iframe load and later layout changes');
A.ok(/aspect-ratio:var\(--app-aspect/.test(css) && /translate\(var\(--appx/.test(css),
  'the preview CSS consumes the live geometry variables');
A.eq(/clip\.clientWidth\s*\/\s*666/.test(js), false,
  'the current preview scale is not pinned to the retired 666px stage width');
A.ok(/live-preview\.js\?v=20260809/.test(html),
  'the homepage cache-busts the corrected preview controller');

A.report('website-live-preview.test');
