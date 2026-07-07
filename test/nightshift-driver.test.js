/* node test/nightshift-driver.test.js — the night-shift TICK DRIVER (NS-1).

   Proves the index.js-owned driver is correct with every ambient dep FAKED (fake clock, fake beat, capturing
   ledger + persisted state) — no http server, no real timer, no wall-clock read. Asserts:
     · a clear tick FIRES the beat and PERSISTS the leash spend IMMEDIATELY (before the async beat resolves)
     · a blocked tick does NOT fire and records a 'decline' ledger entry naming the binding
     · ONE beat at a time: a tick during an in-flight beat is a no-op (binding:'in-flight')
     · the leash is ENFORCED: after leashPerDay fires, further ticks decline with binding:'leash'
     · a DAY ROLLOVER re-enables firing and the persisted counter resets
     · every tick writes the decision trail (decline/beat + outcome) to the ledger
     · abortBeat aborts an in-flight beat (E-STOP hook) */
'use strict';
const A = require('./_assert.js');
const { makeNightshiftDriver } = require('../sidecar/nightshift-driver.js');
const ns = require('../sidecar/nightshift.js');

const DAY = 86400000;
const T0 = 1700000000000;
const flush = () => new Promise(r => setImmediate(r));

function setup(over) {
  over = over || {};
  let state = ns.fresh(T0);
  let clock = T0;
  const persisted = [];        // every setState the driver committed (the durability trail)
  const ledger = [];           // every ledger entry
  const beats = [];            // every beat({agentId,signal}) call
  let beatResolve = null;      // hold a beat open to test the in-flight guard
  const cfg = {
    getState: () => state,
    setState: (s) => { state = s; persisted.push(s); },
    getPosture: () => ({ actsUnattended: over.actsUnattended !== false, leashPerDay: over.leashPerDay != null ? over.leashPerDay : 3 }),
    lastActivity: () => (over.lastActivity != null ? over.lastActivity : clock - 20 * 60000),   // away by default
    isHalted: () => !!over.halted,
    concurrencyFree: () => over.concurrencyFree !== false,
    beat: (o) => { beats.push(o); return new Promise((res) => { beatResolve = res; if (over.autoResolve !== false) res({ delivered: true, title: 'X', archetype: 'advance-goal' }); }); },
    newAbort: () => { let aborted = false; return { signal: { get aborted() { return aborted; } }, abort: () => { aborted = true; } }; },
    now: () => clock,
    ledger: (e) => ledger.push(e),
    agentId: 'agent',
    awayThresholdMs: 15 * 60000,
    beatIntervalMs: 45 * 60000
  };
  const driver = makeNightshiftDriver(cfg);
  return { driver, get state() { return state; }, persisted, ledger, beats, setClock: (t) => { clock = t; }, resolveBeat: (r) => beatResolve && beatResolve(r) };
}

// ---- a clear tick fires + persists the spend immediately ----
(async function firesAndPersists() {
  const h = setup({ autoResolve: false });   // hold the beat open so we can inspect state mid-flight
  const r = h.driver.applyTick(T0);
  A.eq(r.fired, true, 'clear tick fires');
  A.eq(h.driver.runInFlight(), true, 'a beat is in flight');
  // the spend was persisted synchronously at accept-time (before the beat resolves):
  A.eq(h.state.beatsUsedToday, 1, 'leash spent immediately (crash-safe accounting)');
  A.eq(h.beats.length, 1, 'beat launched once');
  // a decision ledger entry for the beat exists:
  A.ok(h.ledger.some(e => e.kind === 'beat'), 'ledger records the beat decision');
  // resolve the beat → guard clears + an outcome is logged.
  h.resolveBeat({ delivered: true, title: 'X', archetype: 'advance-goal' });
  await flush();
  A.eq(h.driver.runInFlight(), false, 'guard clears after the beat settles');
  A.ok(h.ledger.some(e => e.kind === 'outcome' && e.delivered === true), 'ledger records the outcome');
})();

// ---- a blocked tick declines with a named binding ----
(function declines() {
  const h = setup({ actsUnattended: false });
  const r = h.driver.applyTick(T0);
  A.eq(r.fired, false, 'posture-blocked tick does not fire');
  A.eq(r.binding, 'posture', 'names the binding');
  A.ok(h.ledger.some(e => e.kind === 'decline' && e.binding === 'posture'), 'ledger records the decline + binding');
})();

// ---- one beat at a time ----
(async function oneAtATime() {
  const h = setup({ autoResolve: false });
  h.driver.applyTick(T0);                    // starts a beat, held open
  const r2 = h.driver.applyTick(T0 + 1000);  // second tick while in flight
  A.eq(r2.fired, false, 'no second beat while one is in flight');
  A.eq(r2.binding, 'in-flight', 'names in-flight');
  A.eq(h.beats.length, 1, 'still only one beat launched');
  h.resolveBeat({ delivered: false, reason: 'stood-down' });
  await flush();
})();

// ---- the leash is enforced across ticks ----
(async function leashEnforced() {
  const h = setup({ leashPerDay: 2 });
  // beat 1 at T0
  h.driver.applyTick(T0); await flush();
  // beat 2 must wait past the cooldown (45 min); advance the clock.
  const t1 = T0 + 46 * 60000;
  h.setClock(t1);
  h.driver.applyTick(t1); await flush();
  A.eq(h.state.beatsUsedToday, 2, 'two beats spent');
  // beat 3 (past cooldown again) is refused — leash spent.
  const t2 = t1 + 46 * 60000;
  h.setClock(t2);
  const r = h.driver.applyTick(t2);
  A.eq(r.fired, false, 'third beat refused (leash 2 spent)');
  A.eq(r.binding, 'leash', 'binding is leash');
})();

// ---- day rollover re-enables + resets the persisted counter ----
(async function rollover() {
  const h = setup({ leashPerDay: 1 });
  h.driver.applyTick(T0); await flush();
  A.eq(h.state.beatsUsedToday, 1, 'day-1 beat spent the single leash');
  const nextDay = T0 + DAY;
  h.setClock(nextDay);
  const r = h.driver.applyTick(nextDay);
  A.eq(h.state.beatsUsedToday, 1, 'a beat fired on the new day (counter is 1 = this new beat, not 2)');
  A.eq(r.fired, true, 'the new day re-enabled firing');
})();

// ---- abortBeat is the E-STOP hook ----
(async function estop() {
  const h = setup({ autoResolve: false });
  h.driver.applyTick(T0);
  A.eq(h.driver.runInFlight(), true, 'beat in flight');
  const n = h.driver.abortBeat();
  A.eq(n, 1, 'abortBeat aborts the in-flight beat');
  h.resolveBeat({ delivered: false, reason: 'aborted' });
  await flush();
  A.eq(h.driver.runInFlight(), false, 'guard cleared after abort settles');
})();

setTimeout(() => A.report('nightshift-driver.test'), 50);
