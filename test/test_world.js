/* headless behavior validator: node test/test_world.js
   boots util+data+map+sim+agents (no DOM) and runs hours of station time,
   asserting that every intentional-movement system actually fires and that
   no body ever strands, walks off the floor, or loses a deliverable.
   Phase 0.0 wrapper: ONLY the engine-load path is repointed to ../frontend/js/.
   The ported engine files themselves remain byte-for-byte identical to v7. */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeRng } = require('../shared/clock-rng.js');

const worldRng = makeRng('test_world');
Math.random = () => worldRng.next();

const load = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', f), 'utf8');

const [U, SFX] = eval(load('util.js') + '\n[U, SFX];');
global.U = U; global.SFX = SFX;
SFX.on = false;
global.DATA = eval(load('data.js') + '\nDATA;');
global.MAP = eval(load('map.js') + '\nMAP;');
global.SIM = eval(load('sim.js') + '\nSIM;');
global.WORLD = eval(load('agents.js') + '\nWORLD;');

/* ---- instrumentation ---- */
const stats = {
  deliverables: 0, handoffsAtDesk: 0, parcels: 0, publishTasks: 0,
  flaggedTrips: 0, intel: 0
};
U.bus.on('deliverable', () => stats.deliverables++);
U.bus.on('parcel', () => stats.parcels++);
U.bus.on('flagged', () => stats.flaggedTrips++);
U.bus.on('intel', () => stats.intel++);
U.bus.on('task', t => { if (t.kind === 'publish' && t.status === 'todo' && !t._seen) { t._seen = true; stats.publishTasks++; } });

SIM.init();
WORLD.init();

let fail = 0;
const err = m => { fail++; console.log('FAIL: ' + m); };

const seen = {
  ship: 0, shipDone: 0, visit: 0, prop: 0, pool: 0, poolPair: 0,
  inspect: 0, bridge: 0, brief: 0, meets: 0, glances: 0, leisure: {}, aborts: 0
};
const lastPlanTag = {};
const lastAct = {};

/* simulate: dt=100ms world ticks; 1 game-minute per 4 world ticks (speed 2.5x) */
const HOURS = 8;
const STEP = 100;
const STEPS = HOURS * 60 * 4; // game-minutes * ticks-per-minute
let tMs = 0;

for (let i = 0; i < STEPS; i++) {
  tMs += STEP;
  if (i % 4 === 3) SIM.tick(1);
  try {
    WORLD.tick(STEP, tMs);
  } catch (e) {
    err('WORLD.tick threw at step ' + i + ': ' + e.stack);
    break;
  }

  for (const id in WORLD.bodies) {
    const b = WORLD.bodies[id];
    // bodies must always sit on real floor
    if (!MAP.walkable(b.tile.x, b.tile.y)) err(id + ' on unwalkable tile ' + b.tile.x + ',' + b.tile.y + ' @step ' + i);
    // track behavior coverage
    if (b.plan && b.plan.tag !== lastPlanTag[id]) {
      lastPlanTag[id] = b.plan.tag;
      if (b.plan.tag === 'ship') seen.ship++;
      if (b.plan.tag === 'visit') seen.visit++;
      if (b.plan.tag === 'prop') seen.prop++;
      if (b.plan.tag === 'pool') seen.pool++;
      if (b.plan.tag === 'inspect') seen.inspect++;
      if (b.plan.tag === 'bridge') seen.bridge++;
      if (b.plan.tag === 'brief') seen.brief++;
    }
    if (!b.plan) lastPlanTag[id] = null;
    if (b.meet) seen.meets++;
    if (b.glance && b.glance.until > tMs) seen.glances++;
    if (b.state === 'social' && b.act && b.act !== lastAct[id]) { lastAct[id] = b.act; seen.leisure[b.act] = (seen.leisure[b.act] || 0) + 1; }
  }
  if (fail > 25) break;
}

/* stuck check: agents with tasks should be at/near their stations over time */
for (const id in WORLD.bodies) {
  const b = WORLD.bodies[id];
  if (b.state === 'walk' && !b.path.length) err(id + ' stranded in walk state with no path');
}

/* every deliverable must have produced exactly one publish task (handoff or fallback) */
const S = SIM.S;
if (S.shipQueue.length > 3) err('shipQueue backed up: ' + S.shipQueue.length + ' undelivered');
if (stats.deliverables === 0) err('no deliverables were produced in ' + HOURS + 'h — generators broken?');
// exact invariant: heraldHandoff atomically converts every shipQueue entry into one publish task
if (stats.publishTasks < stats.deliverables - S.shipQueue.length)
  err('publish tasks lost: ' + stats.publishTasks + ' publishes for ' + stats.deliverables + ' deliverables (' + S.shipQueue.length + ' in flight)');
if (stats.publishTasks > stats.deliverables) err('publish tasks duplicated: ' + stats.publishTasks + ' > ' + stats.deliverables);

/* behavior coverage */
if (seen.ship === 0) err('no hand-carry (ship) errands ran');
if (seen.visit === 0) err('no buddy visits happened');
if (seen.prop === 0) err('no focus-prop checks happened');
if (seen.pool === 0) err('no pool sessions happened');
if (seen.inspect === 0) err('ULTRON never did an inspection round');
if (seen.brief === 0) err('no research briefings were walked over');
if (seen.meets === 0) err('no hallway encounters happened');
if (seen.glances === 0) err('no glances happened');
if (stats.parcels === 0) err('no parcels ever rode a belt');
if (stats.intel === 0) err('no intel events fired');
if (Object.keys(seen.leisure).length < 2) err('leisure variety too low: ' + JSON.stringify(seen.leisure));

/* save round-trip: serialize -> load -> serialize must be stable, and the world must keep running */
{
  const blob = SIM.serialize();
  if (!SIM.load(blob)) err('SIM.load rejected its own serialize output');
  const blob2 = SIM.serialize();
  if (blob2.length < blob.length * 0.9) err('save shrank suspiciously across round-trip (' + blob.length + ' -> ' + blob2.length + ')');
  for (let i = 0; i < 240; i++) { tMs += STEP; if (i % 4 === 3) SIM.tick(1); WORLD.tick(STEP, tMs); } // 1h post-load soak
  for (const id in WORLD.bodies) {
    const b = WORLD.bodies[id];
    if (!MAP.walkable(b.tile.x, b.tile.y)) err(id + ' on unwalkable tile after save round-trip');
  }
}

/* party round-trip: everyone (minus ULTRON) reaches quarters, then returns */
SIM.playerMessage('take a break everyone');
let inQuarters = 0;
for (let i = 0; i < 1800; i++) { // 3 sim-min of real time @100ms
  tMs += STEP; if (i % 4 === 3) SIM.tick(0); // freeze sim clock: party persists
  WORLD.tick(STEP, tMs);
}
for (const id in WORLD.bodies) {
  if (id === 'ULTRON') continue;
  const b = WORLD.bodies[id];
  if (MAP.roomAt(b.tile.x, b.tile.y) === 'quarters') inQuarters++;
}
if (inQuarters < 12) err('party attendance low: ' + inQuarters + '/16 in quarters');
SIM.playerMessage('back to work');
for (let i = 0; i < 2400; i++) { tMs += STEP; if (i % 4 === 3) SIM.tick(1); WORLD.tick(STEP, tMs); }
let stillPartying = 0;
for (const id in WORLD.bodies) {
  const b = WORLD.bodies[id];
  if (b.state === 'social' && !(SIM.S.party > SIM.S.time)) stillPartying++;
}
// a couple may be on a legit leisure break; more than 4 means return-to-work is broken
if (stillPartying > 4) err(stillPartying + ' agents stuck in social state after party ended');

console.log('--- coverage over ' + HOURS + 'h station time ---');
console.log('deliverables:', stats.deliverables, '| ship errands:', seen.ship, '| publish tasks:', stats.publishTasks, '| in flight:', S.shipQueue.length);
console.log('visits:', seen.visit, '| prop checks:', seen.prop, '| pool sessions:', seen.pool, '| inspections:', seen.inspect, '| bridge trips:', seen.bridge, '| briefings:', seen.brief);
console.log('hallway meets (body-ticks):', seen.meets, '| glance ticks:', seen.glances);
console.log('leisure:', JSON.stringify(seen.leisure));
console.log('party attendance:', inQuarters + '/16');
console.log(fail ? fail + ' problem(s)' : 'OK: all behavior systems verified');
process.exit(fail ? 1 : 0);
