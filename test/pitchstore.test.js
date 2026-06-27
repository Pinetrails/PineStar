/* node test/pitchstore.test.js — the browser wiring around the First Pitch engine (frontend/app/pitchstore.js).
   pitchstore.js is glue (bus hook + model call + Dialogue beat + build routing); its DECISIONS live in the pure
   pitch.js (tested separately). This test fakes the globals it talks to (U.bus / Harness / Dialogue /
   DossierStore / Recipes / localStorage) — with shapes that match the REAL APIs so a green test means a green
   browser — and locks the wiring promises deterministically:
     - subscribes read-only to agent.run.end (never emits); the real emit→onRunEnd→fire path is exercised
     - the gate fires only for a clean, hero, non-onboarding, non-intake, dialogue-closed, knows-enough run, once
     - it runs the directive as a REASON-ONLY call (placed:[], isTask:false) on the live system prompt
     - it renders the confident beat and routes "build it" into a real run: a fully-runnable recipe launches; a
       recipe that still needs its gap (or an unknown recipe) becomes the gap-asking directive — never an empty template
     - a model error / unparseable reply degrades gracefully and stays un-pitched so a later run can retry
     - the fire-once flag round-trips through localStorage (survives reload); reset() re-arms for a new hero */
'use strict';
const A = require('./_assert.js');

// real pure engine (we want the integration, not a fake of it) + fakes for everything browser-only.
global.Pitch = require('../frontend/app/pitch.js');

// in-memory localStorage so the self-persist round-trip is actually exercised (Node has none).
const mem = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};

const bus = A.makeBus();
global.U = { bus };

let knownDims = ['goals', 'identity'];
global.DossierStore = { summary: () => ({ known: knownDims, blank: [] }) };

// recipe fakes shaped like the REAL Recipes API: get() returns null for an unknown id; a recipe can carry
// required params; requiredMissing() reports which required params lack a value (mirrors recipes.js).
global.Recipes = {
  list: () => [
    { id: 'morning-brief', name: 'Morning Brief', tagline: 'daily digest', task: 'Brief me on {topic}.' },
    { id: 'quick-note', name: 'Quick Note', task: 'Jot a quick note.' }
  ],
  get: (id) => ({
    'morning-brief': { id: 'morning-brief', name: 'Morning Brief', task: 'Brief me on {topic}.', params: [{ key: 'topic', required: true }] },
    'quick-note': { id: 'quick-note', name: 'Quick Note', task: 'Jot a quick note.', params: [] }
  })[id] || null,
  requiredMissing: (r, v) => (r && r.params ? r.params.filter(p => p.required && !((v || {})[p.key] && String((v || {})[p.key]).trim())).map(p => p.key) : [])
};

const dlg = {
  opened: 0, said: [], noded: 0, closed: 0, _open: false, nextChoice: { value: 'build' }, lastNode: null,
  open() { this._open = true; this.opened++; },
  say(s) { this.said.push(String(s)); return Promise.resolve(); },
  node(cfg) { this.noded++; this.lastNode = cfg; return Promise.resolve(this.nextChoice); },
  close() { this._open = false; this.closed++; },
  isOpen() { return this._open; }
};
global.Dialogue = dlg;

const hn = { calls: [], next: { text: '' }, chat(args) { this.calls.push(args); return Promise.resolve(this.next); } };
global.Harness = hn;

let launchedRecipe = null, launchedDirective = null;
const SYSTEM = 'SYSTEM PROMPT\nWHAT YOU KNOW ABOUT YOUR COMMANDER: goals — ship the dossier.';
const deps = {
  getSystem: () => SYSTEM,
  getName: () => 'NOVA',
  getCaps: () => [{ id: 'computer', label: 'run code' }],
  getRecentTask: () => 'wrote a hello file',
  launchRecipe: (r) => { launchedRecipe = r; },
  launchDirective: (t) => { launchedDirective = t; }
};

const { PitchStore } = require('../frontend/app/pitchstore.js');

const tick = ms => new Promise(r => setTimeout(r, ms));
function clearFakes() {
  hn.calls = []; dlg.opened = dlg.noded = dlg.closed = 0; dlg.said = []; dlg._open = false; dlg.nextChoice = { value: 'build' };
  launchedRecipe = null; launchedDirective = null;
}

/* ---------- init: subscribes read-only to the bus ---------- */
PitchStore.init(deps);
A.ok(bus._h['agent.run.end'] && bus._h['agent.run.end'].length === 1, 'init subscribes exactly one agent.run.end listener');

/* ---------- the gate (decide) — sync, side-effect free ---------- */
A.eq(PitchStore._decide({ reason: 'error', agentId: 'agent' }).go, false, 'a failed run never pitches');
A.eq(PitchStore._decide({ reason: 'done', agentId: 'worker-2' }), { go: false, reason: 'not-hero' }, 'only the hero pitches');
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: true, reason: 'ready' }, 'a clean hero run that knows enough → pitch');

knownDims = ['identity', 'stack'];
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'missing:goals' }, 'cannot pitch without knowing the goal');
knownDims = ['goals', 'identity'];

dlg._open = true;
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'dialogue-open' }, 'never stomps an open Dialogue (awakening/tutorial)');
dlg._open = false;

global.Onboarding = { isRunning: () => true };
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'onboarding' }, 'never fires during the awakening');
global.Onboarding = undefined;

global.Intake = { isRunning: () => true };
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'intake' }, 'never fires while the intake interview runs');
global.Intake = undefined;

// the live gate degrades gracefully if the dossier model is absent (no summary → too-cold, never a crash)
const _ds = global.DossierStore;
global.DossierStore = undefined;
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'missing:goals' }, 'no dossier yet → stays quiet (missing goals), never throws');
global.DossierStore = _ds;

(async () => {
  try {
    /* ---------- fire: a fully-runnable recipe (no required params) launches the recipe ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: a quick standup note\nWHY: matches your goal\nBUILD: recipe:quick-note\nGAP: none' };
    dlg.nextChoice = { value: 'build' };
    await PitchStore._fire();

    A.eq(hn.calls.length, 1, 'fire makes exactly one model call');
    const call = hn.calls[0];
    A.eq(call.system, SYSTEM, 'the call uses the LIVE system prompt (which carries the dossier block)');
    A.eq(call.isTask, false, 'the pitch is a reason-only call (isTask:false)');
    A.eq(call.placed, [], 'the pitch call gets NO capabilities (placed:[]) — it cannot touch tools');
    A.eq(call.agentId, 'agent', 'the pitch runs as the hero');
    A.eq(call.internal, true, 'the pitch is flagged internal → harness.js suppresses its run.start/end bus re-emit (the self-talk never counts as a shipped task in XP/quests/throughput)');
    const directive = call.messages[0].content;
    A.ok(/PITCH:/.test(directive) && directive.indexOf('recipe:morning-brief') >= 0, 'the directive carries the strict format + the real recipe shelf');
    A.ok(directive.indexOf('run code') >= 0, 'the directive lists the agent\'s real capabilities');
    A.ok(directive.indexOf('wrote a hello file') >= 0, 'the directive references the task just completed');

    A.ok(dlg.opened >= 1 && dlg.said.length >= 1, 'it opens the Dialogue and speaks a lead-in beat');
    A.eq(dlg.noded, 1, 'it renders exactly one choice node');
    A.eq(dlg.lastNode.options.length, 2, 'the beat offers the confident single pitch — two options, never a menu');
    A.eq(PitchStore._state().pitched, true, 'a delivered pitch sets the fire-once flag');
    A.ok(dlg.closed >= 1, 'the Dialogue is closed after the choice');
    A.ok(launchedRecipe && launchedRecipe.id === 'quick-note', 'a fully-runnable recipe is launched directly (no dead gap)');
    A.eq(launchedDirective, null, 'a runnable recipe build does not also send a raw directive');
    A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'already-pitched' }, 'the First Pitch fires once, ever');

    /* ---------- fire: a recipe that still needs its gap → the gap-asking directive (NOT an empty template) ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: a daily brief\nBUILD: recipe:morning-brief\nGAP: which repo to watch' };
    dlg.nextChoice = { value: 'build' };
    await PitchStore._fire();
    A.eq(launchedRecipe, null, 'a recipe with an unfilled required param is NOT launched as an empty template');
    A.ok(launchedDirective && launchedDirective.indexOf('which repo to watch') >= 0, 'instead the build directive asks for the gap (the required value) — making it theirs');

    /* ---------- fire: an unknown/hallucinated recipe id → graceful directive, never a broken build ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: a thing\nBUILD: recipe:ghost-recipe\nGAP: the detail' };
    dlg.nextChoice = { value: 'build' };
    await PitchStore._fire();
    A.eq(launchedRecipe, null, 'an unknown recipe id launches no recipe');
    A.ok(launchedDirective && launchedDirective.indexOf('a thing') >= 0, 'an unknown recipe falls through to a real directive run (no dead gap)');

    /* ---------- fire: workflow build (no recipe) routes to a directive ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: a custom invoice sorter\nWHY: you do it by hand\nBUILD: workflow\nGAP: where the invoices live' };
    dlg.nextChoice = { value: 'build' };
    await PitchStore._fire();
    A.eq(launchedRecipe, null, 'a workflow pitch does not launch a recipe');
    A.ok(launchedDirective && launchedDirective.indexOf('a custom invoice sorter') >= 0, 'a workflow build sends a real directive (run starts immediately)');
    A.ok(launchedDirective.indexOf('where the invoices live') >= 0, 'the build directive asks for the one gap');

    /* ---------- fire: "something else" closes gracefully, still fires-once ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: x\nBUILD: workflow' };
    dlg.nextChoice = { value: 'other' };
    await PitchStore._fire();
    A.eq(launchedRecipe, null, '"something else" launches nothing');
    A.eq(launchedDirective, null, '"something else" sends no directive');
    A.eq(PitchStore._state().pitched, true, 'declining still spends the one-time pitch (anti-nag)');
    A.ok(dlg.closed >= 1, 'the panel closes after declining');

    /* ---------- graceful degradation: model error / unparseable reply stays un-pitched (retry later) ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { error: true, text: '' };
    await PitchStore._fire();
    A.eq(PitchStore._state().pitched, false, 'a model error does NOT burn the pitch — a later run can retry');
    A.eq(dlg.noded, 0, 'no choice node is rendered on a model error');
    A.ok(dlg.closed >= 1, 'the panel is cleaned up after a model error');

    clearFakes(); PitchStore.reset();
    hn.next = { text: 'sorry, I have no idea' };
    await PitchStore._fire();
    A.eq(PitchStore._state().pitched, false, 'an unparseable reply does not burn the pitch');
    A.eq(dlg.noded, 0, 'no beat is shown when there is no usable pitch');

    /* ---------- integration: a real agent.run.end emit drives onRunEnd → fire (the wiring, not just decide) ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: y\nBUILD: workflow' };
    dlg.nextChoice = { value: 'other' };
    bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });
    await tick(10);
    A.eq(hn.calls.length, 1, 'emitting agent.run.end actually runs the pitch (onRunEnd → fire)');

    clearFakes(); PitchStore.reset();
    dlg._open = true;   // an open Dialogue must block a real emit, not just a direct decide()
    bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });
    await tick(10);
    A.eq(hn.calls.length, 0, 'an open Dialogue blocks the pitch on a real emit');
    dlg._open = false;

    /* ---------- fire-once persists through localStorage (survives a reload) ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: persist me\nBUILD: workflow' };
    dlg.nextChoice = { value: 'other' };
    await PitchStore._fire();
    A.ok(mem['starnet.pitch.v1'] && JSON.parse(mem['starnet.pitch.v1']).pitched === true, 'a delivered pitch persists to its own localStorage key (no save.js)');
    PitchStore.init(deps);   // simulate a page reload
    A.eq(PitchStore._state().pitched, true, 'a fresh init hydrates the persisted fire-once flag (survives reload)');
    A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'already-pitched' }, 'the persisted flag blocks a re-pitch after reload');

    /* ---------- reset re-arms for a brand-new hero ---------- */
    PitchStore.reset();
    A.eq(mem['starnet.pitch.v1'], undefined, 'reset() removes the persisted key');
    PitchStore.init(deps);
    A.eq(PitchStore._state().pitched, false, 'after reset + reload the new hero re-earns the First Pitch');

    A.report('pitchstore.test');
  } catch (e) {
    A.ok(false, 'unexpected throw: ' + (e && e.stack || e));
    A.report('pitchstore.test');
  }
})();
