/* Candidate-specific locks for the non-overlapping product hunks proven by the state-truth journey. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const world = read('frontend/app/world.js');
const station = read('frontend/app/stationui.js');

A.ok(/function workerFoot\([\s\S]{0,700}seen\.add\(ht\.x \+ ',' \+ ht\.y\)/.test(world),
  'summoned-worker occupancy includes the hero, so the first worker cannot hide underneath it');
A.ok(/function agHead\(a, act\)[\s\S]{0,500}const live = !!\(a && agentLive\(a\.id\)\)[\s\S]{0,700}live \? 'WORKING'/.test(station),
  'the dossier headline derives WORKING from the selected agent');
A.ok(/x\.id === focusedId && act === 'talk' \? 'talking' : 'working'/.test(station),
  'a different worker never inherits the focused agent conversation label');
A.ok(/const selectedLive = !!\(selected && agentLive\(selected\.id\)\)[\s\S]{0,500}selectedLive \? 'WORKING'/.test(station),
  'live dossier repaint remains scoped to the selected worker');
A.ok(/a\.id === focusedId && act === 'talk' \? 'in conversation' : 'working at the terminal'/.test(station),
  'crew summary rows label conversation only for the focused agent');
A.ok(/const unhealthyChannels = new Set\(\)[\s\S]*?state === 'up'[\s\S]*?reconnected[\s\S]*?key: toastKey/.test(world),
  'a proven channel recovery replaces the active outage claim instead of leaving a stale red toast');
A.ok(/const toastKey = String\(\(opts && opts\.key\)[\s\S]*?dataset\.toastKey === toastKey[\s\S]*?prior\.remove\(\)/.test(station),
  'keyed transient toasts remove the prior live-state card before rendering its replacement');

A.eq(read('website/app/app/world.js'), world, 'website world mirror carries worker spawn truth exactly');
A.eq(read('website/app/app/stationui.js'), station, 'website dossier mirror carries per-worker status truth exactly');

A.report('state-truth-overlap');
