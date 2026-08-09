'use strict';

/* The station should feel warm and comfortable without solving brightness by flattening the
   light model. Lock the color temperature separately from the existing intensity controls so a
   future polish pass cannot drift the pools back toward white or silently reduce readability. */

const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', name), 'utf8');
const bake = read('stationbake.js');
const world = read('world.js');
const build = read('build.js');
const lab = read('crtlab.js');

const srgb = v => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const luminance = rgb => 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]);
const warm = rgb => rgb[0] - rgb[2];

const oldPool = [250, 236, 206], pool = [246, 224, 188];
const oldGlow = [240, 230, 206], glow = [238, 218, 184];

A.eq((bake.match(/rgba\(246,224,188/g) || []).length, 6,
  'room and corridor gradients share the warm-neutral pool color at every stop');
A.ok(!/rgba\(250,236,206/.test(bake), 'the near-white floor-pool color no longer ships');
A.ok(/rgba\(255,228,184,0\.55\)/.test(bake), 'the wall fixture highlight is warm instead of pure white');
A.ok(/rgba\(238,218,184/.test(world), 'the live simulation shimmer uses the warmer lamp color');
A.ok(/rgba\(238,218,184/.test(build), 'REFIT preview matches the live simulation shimmer color');

A.ok(luminance(pool) < luminance(oldPool), 'floor pools are slightly less luminous than before');
A.ok(luminance(pool) > 0.70, 'floor pools retain a bright source color for readable deck contrast');
A.ok(warm(pool) > warm(oldPool), 'floor pools shift warmer rather than merely darker');
A.ok(luminance(glow) < luminance(oldGlow), 'animated shimmer is slightly less luminous than before');
A.ok(luminance(glow) > 0.65, 'animated shimmer remains visible over the ambient mask');
A.ok(warm(glow) > warm(oldGlow), 'animated shimmer shifts warmer rather than merely darker');

const lightControls = { ambient: '0.77', pool: '1', room: '0.6', corridor: '0.42', door: '0.5', floor: '0.2', crown: '0.45', pitch: '8' };
for (const [key, value] of Object.entries(lightControls)) {
  const lock = new RegExp('\\b' + key + ': ' + value.replace('.', '\\.') + '(?:[, }])');
  A.ok(lock.test(bake), 'the shipped ' + key + ' lighting control remains ' + value);
  A.ok(lock.test(lab), 'the CRT lab reset keeps ' + key + ' at the shipped value');
}

A.report('simulation-lighting');
