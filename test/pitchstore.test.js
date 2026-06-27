/* node test/pitchstore.test.js — the browser wiring around the First Pitch engine (frontend/app/pitchstore.js).
   pitchstore.js is glue (bus hook + model call + Dialogue beat + build routing); its DECISIONS live in the pure
   pitch.js (tested separately). This test fakes the globals it talks to (U.bus / Harness / Dialogue /
   DossierStore / Recipes) and locks the wiring promises deterministically:
     - it subscribes read-only to agent.run.end (never emits)
     - the gate fires only for a clean, hero, non-onboarding, knows-enough run, exactly once
     - it runs the directive as a REASON-ONLY call (placed:[], isTask:false) on the live system prompt
     - it renders the confident beat and routes "build it" into a real run (recipe or directive), no dead gap
     - a model error / unparseable reply degrades gracefully and stays un-pitched so a later run can retry
     - reset() re-arms the First Pitch for a brand-new hero */
'use strict';
const A = require('./_assert.js');

// real pure engine (we want the integration, not a fake of it) + fakes for everything browser-only.
global.Pitch = require('../frontend/app/pitch.js');

const bus = A.makeBus();
global.U = { bus };

let knownDims = ['goals', 'identity'];
global.DossierStore = { summary: () => ({ known: knownDims, blank: [] }) };

global.Recipes = {
  list: () => [{ id: 'morning-brief', name: 'Morning Brief', tagline: 'daily digest' }, { id: 'inbox-triage', name: 'Inbox Triage' }],
  get: (id) => ({ id, name: 'R-' + id })
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

/* ---------- fire: recipe build (the happy path) ---------- */
(async () => {
  try {
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: a daily standup brief\nWHY: matches your goal of shipping the dossier\nBUILD: recipe:morning-brief\nGAP: which repo to watch' };
    dlg.nextChoice = { value: 'build' };
    await PitchStore._fire();

    A.eq(hn.calls.length, 1, 'fire makes exactly one model call');
    const call = hn.calls[0];
    A.eq(call.system, SYSTEM, 'the call uses the LIVE system prompt (which carries the dossier block)');
    A.eq(call.isTask, false, 'the pitch is a reason-only call (isTask:false)');
    A.eq(call.placed, [], 'the pitch call gets NO capabilities (placed:[]) — it cannot touch tools');
    A.eq(call.agentId, 'agent', 'the pitch runs as the hero');
    const directive = call.messages[0].content;
    A.ok(/PITCH:/.test(directive) && directive.indexOf('recipe:morning-brief') >= 0, 'the directive carries the strict format + the real recipe shelf');
    A.ok(directive.indexOf('run code') >= 0, 'the directive lists the agent\'s real capabilities');
    A.ok(directive.indexOf('wrote a hello file') >= 0, 'the directive references the task just completed');

    A.ok(dlg.opened >= 1 && dlg.said.length >= 1, 'it opens the Dialogue and speaks a lead-in beat');
    A.eq(dlg.noded, 1, 'it renders exactly one choice node');
    A.eq(dlg.lastNode.options.length, 2, 'the beat offers the confident single pitch — two options, never a menu');
    A.eq(PitchStore._state().pitched, true, 'a delivered pitch sets the fire-once flag');
    A.ok(dlg.closed >= 1, 'the Dialogue is closed after the choice');
    A.ok(launchedRecipe && launchedRecipe.id === 'morning-brief', '"build it" launches the proposed recipe (no dead gap)');
    A.eq(launchedDirective, null, 'a recipe build does not also send a raw directive');

    // fire-once: a delivered pitch is never offered again
    A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'already-pitched' }, 'the First Pitch fires once, ever');

    /* ---------- fire: workflow build (no recipe) routes to a directive ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: a custom invoice sorter\nWHY: you do it by hand every week\nBUILD: workflow\nGAP: where the invoices live' };
    dlg.nextChoice = { value: 'build' };
    await PitchStore._fire();
    A.eq(launchedRecipe, null, 'a workflow pitch does not launch a recipe');
    A.ok(launchedDirective && launchedDirective.indexOf('a custom invoice sorter') >= 0, 'a workflow build sends a real directive (run starts immediately)');
    A.ok(launchedDirective.indexOf('where the invoices live') >= 0, 'the build directive asks for the one gap (make it theirs)');

    /* ---------- fire: "something else" closes gracefully, still fires-once ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: x\nBUILD: workflow' };
    dlg.nextChoice = { value: 'other' };
    await PitchStore._fire();
    A.eq(launchedRecipe, null, '"something else" launches nothing');
    A.eq(launchedDirective, null, '"something else" sends no directive');
    A.eq(PitchStore._state().pitched, true, 'declining still spends the one-time pitch (anti-nag)');
    A.ok(dlg.closed >= 1, 'the panel closes after declining');

    /* ---------- graceful degradation: model error stays un-pitched (retry later) ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { error: true, text: '' };
    await PitchStore._fire();
    A.eq(PitchStore._state().pitched, false, 'a model error does NOT burn the pitch — a later run can retry');
    A.eq(dlg.noded, 0, 'no choice node is rendered on a model error');
    A.ok(dlg.closed >= 1, 'the panel is cleaned up after a model error');

    /* ---------- graceful degradation: unparseable reply stays un-pitched ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'sorry, I have no idea' };
    await PitchStore._fire();
    A.eq(PitchStore._state().pitched, false, 'an unparseable reply does not burn the pitch');
    A.eq(dlg.noded, 0, 'no beat is shown when there is no usable pitch');

    /* ---------- reset re-arms for a brand-new hero ---------- */
    PitchStore._state().pitched = true;
    PitchStore.reset();
    A.eq(PitchStore._state().pitched, false, 'reset() re-arms the First Pitch for a new hero');

    A.report('pitchstore.test');
  } catch (e) {
    A.ok(false, 'unexpected throw: ' + (e && e.stack || e));
    A.report('pitchstore.test');
  }
})();
