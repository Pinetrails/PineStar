'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const Plan = require('../frontend/js/sprite-load-plan.js');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'assets', 'sprites', 'manifest.json'), 'utf8'));
const grouped = Plan.groupTracks(manifest.sprites);
const all = Object.entries(manifest.sprites);
const planned = Object.values(grouped).flat();
const initial = Plan.initialTracks(grouped, ['blank', 'ultron', 'blank']);
const totalFrames = Plan.frameCount(all);
const initialFrames = Plan.frameCount(initial);
const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'assets.js'), 'utf8');

A.eq(planned.length, all.length, 'every valid manifest track belongs to exactly one set');
A.ok(grouped.blank && grouped.ultron, 'default skin and station leader have loadable sets');
A.eq(initial.length, grouped.blank.length + grouped.ultron.length, 'startup plan de-duplicates requested sets');
A.ok(initialFrames > 0 && initialFrames < totalFrames * 0.12, 'startup fetches less than twelve percent of sprite frames');
A.ok(totalFrames > 3000, 'budget assertion covers the expanded production manifest rather than a fixture');
A.eq(Plan.groupTracks({ broken: 'not-an-array', 'valid.rot.south': ['valid.png'] }),
  { valid: [['valid.rot.south', ['valid.png']]] }, 'malformed tracks cannot crash or pollute a load plan');
A.ok(/tracksBySet = SpriteLoadPlan\.groupTracks\(man\.sprites\)/.test(loaderSource), 'runtime uses the tested manifest planner');
A.ok(/Promise\.all\(\[loadSet\(defSet\), loadSet\('ultron'\)\]\)/.test(loaderSource), 'runtime startup is limited to the default and station-leader sets');
A.ok(/if \(!loadedSets\.has\(set\)\) \{ loadSet\(set\); return null; \}/.test(loaderSource), 'an unseen skin starts one lazy load and renders the honest fallback meanwhile');

A.report('sprite-loading.test');
