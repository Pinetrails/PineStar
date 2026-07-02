/* node test/workqueststore.test.js — the live wiring around the pure work-quest generator
   (frontend/app/workqueststore.js). Verifies the G1c accepted-idea→build contract end to end:
     • accept(parsed) mints a build; a recipe with still-missing required params → gap steps resolved from the
       LIVE recipe; a runnable/workflow build → a single run step;
     • the NEXT hero run.start within the arm window claims the build's run, ticks its gap steps + binds the id;
       the run's clean end completes it (honest completion — the build actually ran; no claim);
     • a run.end with reason≠done does not complete; a summoned worker's run is ignored;
     • dismissal is permanent; reset clears;
     • THE LAW: work quests never mint XP and the store never emits on U.bus — tripwire stubs throw if touched.
       Plus source-level locks on the acceptance-path wiring (pitchstore + suggeststore call accept). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

/* ---------- stubs: storage, engine, live recipe reads, tripwires ---------- */
global.localStorage = {
  _s: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; }
};
global.WorkQuests = require('../frontend/app/workquests.js');

// a tiny live recipe catalog: 'brief' needs a required 'topic' (a real gap); 'ready' has no required params.
const RECIPES = {
  brief: { id: 'brief', name: 'Morning brief', params: [{ key: 'topic', label: 'Topic', required: true }, { key: 'window', label: 'Look-back', required: false, default: 'today' }] },
  ready: { id: 'ready', name: 'Ready recipe', params: [{ key: 'x', label: 'X', required: false, default: 'ok' }] }
};
global.Recipes = {
  get: id => RECIPES[id] || null,
  requiredMissing: (r, v) => (r.params || []).filter(p => p.required && !(v && v[p.key])).map(p => p.key)
};

// THE LAW tripwires: a work quest must never touch XP and the store must never emit on the bus.
global.Xp = { applyEvent: () => { throw new Error('LAW VIOLATION: work quests must never mint XP'); } };
global.XpStore = { onEvent: () => { throw new Error('LAW VIOLATION: work quests must never feed the XP engine'); } };
const listeners = {};
global.U = {
  bus: {
    emit: () => { throw new Error('LAW VIOLATION: workqueststore must never emit on U.bus'); },
    on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); }
  }
};
const rerenders = [];
global.StationUI = { rerender: k => rerenders.push(k) };

const { WorkQuestStore } = require('../frontend/app/workqueststore.js');
const start = (agentId, runId) => (listeners['agent.run.start'] || []).forEach(fn => fn({ agentId, runId, trigger: 'directive' }));
const end = (agentId, runId, reason) => (listeners['agent.run.end'] || []).forEach(fn => fn({ agentId, runId, reason: reason || 'done' }));

/* ---------- init binds the run lifecycle (subscription only) ---------- */
WorkQuestStore.init();
A.ok((listeners['agent.run.start'] || []).length === 1 && (listeners['agent.run.end'] || []).length === 1, 'init subscribes to the run lifecycle exactly once each');
A.eq(WorkQuestStore.quests().length, 0, 'a fresh store has no quests');

/* ---------- accept a recipe-with-gaps → a multi-step build ---------- */
const gapId = WorkQuestStore.accept({ title: 'the morning brief', build: { kind: 'recipe', recipeId: 'brief' }, gap: 'the topic' });
A.ok(gapId, 'accepting a pitch mints a build');
let qs = WorkQuestStore.quests();
A.eq(qs.length, 1, 'one accepted idea → one work quest');
A.eq(qs[0].kind, 'work', 'kind is work');
A.ok(/0 of 2/.test(qs[0].desc), 'a recipe with one missing required param → 1 gap step + 1 launch step (2 total)');
A.ok(rerenders.indexOf('quests') >= 0, 'the quest-log is poked');

/* ---------- the launched run claims the build: gap steps tick, the run binds ---------- */
start('agent', 'run-a');
qs = WorkQuestStore.quests();
A.ok(/1 of 2/.test(qs[0].desc), 'the launch ticked the gap step (the build genuinely started, gaps folded into the directive)');
A.eq(qs[0].status, 'open', 'still open — the launch/run step remains');

/* ---------- the run finishing completes the build (honest completion) ---------- */
end('agent', 'run-a', 'done');
qs = WorkQuestStore.quests();
A.eq(qs.find(q => q.id === gapId).status, 'done', 'the run finishing completes the build (no claim button)');
A.ok(/^built —/.test(qs.find(q => q.id === gapId).title), 'a completed build reads as built');

/* ---------- a runnable/workflow build → a single run step; a non-done end never completes ---------- */
const runId = WorkQuestStore.accept({ title: 'the price watcher', build: { kind: 'workflow', recipeId: null } });
start('agent', 'run-b');
end('agent', 'run-b', 'max_iters');   // the run stopped, didn't finish clean
A.eq(WorkQuestStore.quests().find(q => q.id === runId).status, 'open', 'a run that did NOT finish clean does not complete the build');
end('agent', 'run-b', 'done');
A.eq(WorkQuestStore.quests().find(q => q.id === runId).status, 'done', 'a clean finish completes it');

/* ---------- a summoned worker's run never claims a build ---------- */
const wId = WorkQuestStore.accept({ title: 'another build', build: { kind: 'workflow', recipeId: null } });
start('worker-7', 'run-c');   // NOT the hero
end('worker-7', 'run-c', 'done');
A.eq(WorkQuestStore.quests().find(q => q.id === wId).status, 'open', "a worker's run never completes the hero's build");

/* ---------- dismissal + reset ---------- */
A.eq(WorkQuestStore.dismiss(wId), true, 'dismissing an open build takes');
A.eq(WorkQuestStore.quests().some(q => q.id === wId), false, 'a dismissed build never re-renders');
WorkQuestStore.init();   // reload
A.eq(WorkQuestStore.isDismissed(wId), true, 'dismissal survives a reload');
WorkQuestStore.reset();
A.eq(global.localStorage.getItem('starnet.workquests.v1'), null, 'reset removes the self-persisted key');
A.eq(WorkQuestStore.quests().length, 0, 'a reset store has no quests until the next init');

/* ---------- source-level locks: the acceptance-path wiring ---------- */
const qsSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/queststore.js'), 'utf8');
A.ok(/WorkQuestStore/.test(qsSrc) && /workQuests/.test(qsSrc), 'queststore.view joins the work quests into the one projection');
const pitchSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/pitchstore.js'), 'utf8');
A.ok(/WorkQuestStore\.accept/.test(pitchSrc), 'the First Pitch "build it" mints a work quest');
const sugSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/suggeststore.js'), 'utf8');
A.ok(/WorkQuestStore\.accept/.test(sugSrc), 'an ongoing-idea "build it" mints a work quest');
const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
A.ok(/WorkQuestStore\.init\(\)/.test(appSrc) && /WorkQuestStore\.reset\(\)/.test(appSrc), 'app.js inits + resets the generator');
const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
A.ok(/app\/workquests\.js/.test(html) && /app\/workqueststore\.js/.test(html), 'index.html loads the engine and the store');

A.report('workqueststore.test');
