/* The homepage preview embeds the real frontend and crops to #stage. The stage geometry
   changes as the application shell evolves, so the crop must come from the live iframe DOM,
   never from another hard-coded snapshot that can silently age out. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'website', 'live-preview.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'website', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'website', 'index.html'), 'utf8');
const demo = fs.readFileSync(path.join(ROOT, 'website', 'app', 'demo-boot.js'), 'utf8');

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
A.ok(/app\/embed\.htm\?v=20260810-current-station-v2/.test(html),
  'the homepage uses the cache-busted dashboard-upload-safe station document');

function bootDemo(initial) {
  const rows = Object.assign({}, initial || {});
  const localStorage = {
    getItem: (key) => Object.prototype.hasOwnProperty.call(rows, key) ? rows[key] : null,
    setItem: (key, value) => { rows[key] = String(value); }
  };
  vm.runInNewContext(demo, {
    window: {}, localStorage,
    setInterval: () => 1,
    clearInterval: () => {},
    console
  });
  return rows;
}

const upgraded = bootDemo({ 'starnet.save': '{"retired":"station"}' });
const upgradedSave = JSON.parse(upgraded['starnet.save']);
const upgradedRoom = upgradedSave.station.rooms.r1;
A.eq(upgradedRoom.floorStyle, 'walnut', 'the website demo uses the current seeded floor style');
A.eq(upgradedRoom.floorMat, 'plank', 'the website demo uses the current seeded floor material');
A.eq(upgradedRoom.wallMat, 'ribbed', 'the website demo uses the current seeded wall material');
A.eq(upgradedRoom.hullStyle, 'ember', 'the website demo uses the current seeded hull style');
A.eq(upgradedRoom.hullMat, 'brick', 'the website demo uses the current seeded hull material');
A.eq(upgraded['starnet.website.demo.rev'], '2026-08-10-current-station-v2',
  'a versioned marker moves returning visitors off the retired captured save');

const currentRev = upgraded['starnet.website.demo.rev'];
const alreadyCurrent = bootDemo({
  'starnet.website.demo.rev': currentRev,
  'starnet.save': '{"preserved":true}'
});
A.eq(alreadyCurrent['starnet.save'], '{"preserved":true}',
  'the demo revision migrates once instead of overwriting storage on every page load');

A.report('website-live-preview.test');
