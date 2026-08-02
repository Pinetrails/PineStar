/* node test/autonomystore.test.js — the thin browser wiring around the pure autonomy engine
   (frontend/app/autonomystore.js). autonomystore.js is glue: hydrate / persist / new-hero reset, all logic in the
   pure autonomy.js (tested separately). This fakes localStorage with the REAL engine wired in, and locks:
     - init() hydrates from its OWN key, clamped to a valid posture (corrupt/old → the safe floor)
     - the writers (applyPreset / setInitiative / setReach / setLeash) commit AND persist
     - summary() / describe() delegate to the engine
     - the posture round-trips through localStorage (survives reload); reset() clears the key + re-arms the floor
     - it NEVER emits on U.bus (read-only citizen) */
'use strict';
const A = require('./_assert.js');

global.Autonomy = require('../frontend/app/autonomy.js');   // real pure engine (we want the integration)

const mem = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};
const KEY = 'starnet.autonomy.v1';
const posturePosts = [];
global.fetch = (_path, opts) => { posturePosts.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true }); };

const { AutonomyStore } = require('../frontend/app/autonomystore.js');

/* ---------- init: empty store → the safe floor ---------- */
AutonomyStore.init();
A.eq(AutonomyStore.get(), { v: 1, initiative: 'wait', reach: 'sandbox', leashPerDay: 3 }, 'a fresh store hydrates to the safe floor (fully wait-for-me, Sandbox ceiling)');
A.eq(AutonomyStore.summary().enabled, false, 'the floor does nothing unattended');
A.eq(posturePosts[posturePosts.length - 1].resumeHalt, false, 'boot posture mirror is not consent to lift E-STOP');

/* ---------- applyPreset: commits + persists ---------- */
AutonomyStore.applyPreset('build');
A.eq(AutonomyStore.get().initiative, 'leash', "applyPreset('build') sets leash initiative");
A.eq(AutonomyStore.get().reach, 'sandbox', "applyPreset('build') sets sandbox reach");
A.ok(mem[KEY] && JSON.parse(mem[KEY]).initiative === 'leash', 'the posture persists to its own localStorage key');
A.eq(posturePosts[posturePosts.length - 1].resumeHalt, true, 'a deliberate dial writer carries explicit resume consent');

// even the most autonomous preset keeps reach at sandbox (the safety rule, end-to-end through the store)
AutonomyStore.applyPreset('free');
A.eq([AutonomyStore.summary().actsUnattended, AutonomyStore.summary().reachesOut], [true, false], "'free' acts unattended but never reaches out (sandbox-capped)");

/* ---------- single-axis writers ---------- */
AutonomyStore.setReach('reach');
A.eq(AutonomyStore.summary().reachesOut, true, 'setReach(reach) raises the ceiling to reach-out (a deliberate opt-in)');
AutonomyStore.setInitiative('wait');
A.eq(AutonomyStore.summary().enabled, false, 'setInitiative(wait) turns autonomy fully off');
AutonomyStore.setLeash(7);
A.eq(AutonomyStore.get().leashPerDay, 7, 'setLeash persists a clamped allowance');
A.ok(mem[KEY] && JSON.parse(mem[KEY]).leashPerDay === 7, 'the leash change persisted');

/* ---------- describe() delegates + stays honest ---------- */
AutonomyStore.applyPreset('free');
A.ok(/freely toward your goals/i.test(AutonomyStore.describe()), 'describe() reflects the live posture (free)');
A.ok(AutonomyStore.describe().indexOf('see everything it did') >= 0, 'describe() always promises legibility');

/* ---------- persistence round-trip: survives a reload ---------- */
AutonomyStore.applyPreset('build'); AutonomyStore.setReach('observe');
AutonomyStore.init();   // simulate a page reload (re-hydrate from the key)
A.eq(AutonomyStore.get(), { v: 1, initiative: 'leash', reach: 'observe', leashPerDay: 7 }, 'a posture survives reload (re-hydrated from its own key)');
A.eq(posturePosts[posturePosts.length - 1].resumeHalt, false, 'reload mirror cannot impersonate a deliberate dial write');

/* ---------- corrupt / old key → the safe floor, never a crash ---------- */
mem[KEY] = '{not valid json';
AutonomyStore.init();
A.eq(AutonomyStore.get().initiative, 'wait', 'an unparseable key degrades to the floor, never throws');
mem[KEY] = JSON.stringify({ initiative: 'bogus', reach: 'orbit', leashPerDay: 999 });
AutonomyStore.init();
A.eq(AutonomyStore.get(), { v: 1, initiative: 'wait', reach: 'sandbox', leashPerDay: 12 }, 'out-of-enum fields clamp to the floor; leash clamps to the max');

/* ---------- reset: a brand-new hero re-arms the floor + drops the key ---------- */
AutonomyStore.applyPreset('free');
AutonomyStore.reset();
A.eq(mem[KEY], undefined, 'reset() removes the persisted key');
A.eq(AutonomyStore.get(), { v: 1, initiative: 'wait', reach: 'sandbox', leashPerDay: 3 }, 'after reset the posture is the safe floor again');

/* ---------- read-only: the store never emits on U.bus ---------- */
let emitted = 0;
global.U = { bus: { emit: () => { emitted++; }, on: () => {} } };
const { AutonomyStore: Fresh } = (() => { delete require.cache[require.resolve('../frontend/app/autonomystore.js')]; return require('../frontend/app/autonomystore.js'); })();
Fresh.init(); Fresh.applyPreset('free'); Fresh.setReach('reach'); Fresh.reset();
A.eq(emitted, 0, 'AutonomyStore never emits on U.bus (read-only citizen; lint-emits stays green)');

A.report('autonomystore.test');
