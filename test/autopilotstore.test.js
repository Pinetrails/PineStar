/* node test/autopilotstore.test.js — the thin idle-driver store (autonomy Slice A). Drives the live loop with an
   injected clock + a fake curiosity hand-off (install:false skips the DOM): activity stamping, the once-per-idle-
   episode beat, the posture gate, and the new-hero reset. Plus source-guards for the browser-flow wiring that
   isn't node-loadable (the chat.js offerCuriosity hand-off + the app.js init). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

global.Autopilot = require('../frontend/app/autopilot.js');
const { AutopilotStore } = require('../frontend/app/autopilotstore.js');

let nowMs = 1000000;
const IDLE = 120000;
let posture = { enabled: true, actsUnattended: false };   // SUGGEST: enabled, but not permitted to act
let offers = 0;
const fresh = () => [{ text: 'x', createdAt: nowMs, updatedAt: nowMs }];
let dossier = { known: ['stack'], blank: ['goals'], familiarity: 1 / 7 };   // cold (no goals)
const beliefs = { stack: fresh() };

AutopilotStore.init({
  install: false,
  now: () => nowMs,
  getPosture: () => posture,
  getDossier: () => dossier,
  getBeliefs: (dim) => beliefs[dim] || [],
  offerCuriosity: () => { offers++; return true; },
  idleMs: IDLE
});

/* ---------- a just-active station does nothing ---------- */
A.eq(AutopilotStore.tick().mode, 'none', 'fresh init starts ACTIVE → no fire (reason: not idle)');
A.eq(offers, 0, 'no curiosity asked while the Commander is active');

/* ---------- going idle earns ONE thing ---------- */
nowMs += IDLE;
let d = AutopilotStore.tick();
A.eq([d.go, d.mode], [true, 'earn'], 'idle + enabled + cold → earn');
A.eq(offers, 1, 'exactly one gentle ask on going idle');

/* ---------- still idle → one beat per episode, no nag ---------- */
nowMs += IDLE * 5;
AutopilotStore.tick();
A.eq(offers, 1, 'staying idle does NOT re-ask (one autopilot beat per idle episode)');

/* ---------- interaction re-arms; a NEW idle episode earns again ---------- */
AutopilotStore.noteActivity();
A.eq(AutopilotStore._state().armed, false, 'activity re-arms the next idle beat');
A.eq(AutopilotStore.tick().mode, 'none', 'right after activity the station is active again, not idle');
nowMs += IDLE;
AutopilotStore.tick();
A.eq(offers, 2, 'a fresh idle episode earns once more');

/* ---------- WAIT posture never fires, even when idle ---------- */
posture = { enabled: false, actsUnattended: false };
AutopilotStore.noteActivity(); nowMs += IDLE;
A.eq(AutopilotStore.tick().mode, 'none', 'WAIT (disabled) posture never acts on its own');
A.eq(offers, 2, 'disabled → no ask');

/* ---------- a HOT + acting dial decides ACT (A1 still earns as the interim, A2 wires the real job) ---------- */
posture = { enabled: true, actsUnattended: true };
dossier = { known: ['goals', 'stack', 'pain', 'identity'], blank: [], familiarity: 4 / 7 };
beliefs.goals = fresh(); beliefs.pain = fresh(); beliefs.identity = fresh();
AutopilotStore.noteActivity(); nowMs += IDLE;
A.eq(AutopilotStore.decideNow().mode, 'act', 'idle + hot + acting dial → the engine decides ACT');

/* ---------- reset disarms ---------- */
AutopilotStore.reset();
A.eq(AutopilotStore._state().armed, false, 'reset clears the idle/armed state for a new hero');

/* ---------- read-only: the store took no U.bus and cannot emit ---------- */
A.ok(typeof global.U === 'undefined', 'AutopilotStore ran with no U.bus present — it never subscribes or emits');

/* ---------- source-guards for the browser-flow wiring (not node-loadable) ---------- */
const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
A.ok(chatSrc.indexOf('function offerCuriosity') > 0, 'chat.js defines offerCuriosity (the idle earn-context hand-off)');
const offerBody = chatSrc.slice(chatSrc.indexOf('function offerCuriosity'), chatSrc.indexOf('function offerCuriosity') + 900);
A.ok(/CuriosityStore\.consider\(\)/.test(offerBody), 'offerCuriosity routes through CuriosityStore (shares the per-session anti-nag cap)');
A.ok(/if \(activeNudge\) return false/.test(offerBody), 'offerCuriosity stands down when a gentle beat is already live (never stacks)');
A.ok(/Dialogue\.isOpen/.test(offerBody), 'offerCuriosity stands down when a focused panel is open');
A.ok(/offerCuriosity/.test(chatSrc.slice(chatSrc.lastIndexOf('return {'))), 'chat.js exports offerCuriosity');

const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
A.ok(/AutopilotStore\.init\(/.test(appSrc), 'app.js initialises AutopilotStore');
A.ok(/offerCuriosity:\s*\(\)\s*=>/.test(appSrc), 'app.js wires Chat.offerCuriosity into the autopilot earn branch');

A.report('autopilotstore.test');
