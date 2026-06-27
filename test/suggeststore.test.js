/* node test/suggeststore.test.js — the ongoing-suggestion wiring (frontend/app/suggeststore.js).
   Decisions live in the pure pitch.js (Pitch.shouldSuggest, tested separately); this is glue (task counter +
   model call + gentle Chat.nudge beat + build routing). Fakes the globals with REAL-ish shapes and locks:
     - read-only counter: every clean hero task advances the cooldown; non-done / non-hero ignored
     - baseline: once the First Pitch has fired, the next task records the familiarity baseline
     - willSuggest fires only after the dossier GREW past that baseline, past the cooldown, within budget
     - fire() runs a reason-only directive, renders a gentle nudge, routes "build it", spends the session,
       advances the baseline + resets the cooldown; a model hiccup backs off without burning the session
     - reset() re-arms for a new hero */
'use strict';
const A = require('./_assert.js');
global.Pitch = require('../frontend/app/pitch.js');

const mem = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};

const bus = A.makeBus();
global.U = { bus };

let dsKnown = ['goals', 'identity'];
let dsFam = 0.4;
global.DossierStore = { summary: () => ({ known: dsKnown, familiarity: dsFam, blank: [] }) };

let pitchDoneFlag = false;
global.PitchStore = { done: () => pitchDoneFlag };

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

const chat = { nudges: [], sent: null, nudge(text, opts, cb) { this.nudges.push({ text, opts, cb }); }, send(t) { this.sent = t; }, isBusy: () => false };
global.Chat = chat;

const hn = { calls: [], next: { text: '' }, chat(args) { this.calls.push(args); return Promise.resolve(this.next); } };
global.Harness = hn;

let launchedRecipe = null, launchedDirective = null;
const SYSTEM = 'SYSTEM PROMPT\nWHAT YOU KNOW ABOUT YOUR COMMANDER: goals — ship the dossier.';
const deps = {
  getSystem: () => SYSTEM,
  getCaps: () => [{ id: 'computer', label: 'run code' }],
  getRecentTask: () => 'shipped a small fix',
  launchRecipe: (r) => { launchedRecipe = r; },
  launchDirective: (t) => { launchedDirective = t; }
};

const { SuggestStore } = require('../frontend/app/suggeststore.js');

const emitDone = (over) => bus.emit('agent.run.end', Object.assign({ reason: 'done', agentId: 'agent' }, over || {}));
const clickBuild = () => { const n = chat.nudges[chat.nudges.length - 1]; n.cb({ value: 'build' }); };
function clearFakes() { hn.calls = []; chat.nudges = []; chat.sent = null; launchedRecipe = null; launchedDirective = null; }

/* ---------- init: subscribes read-only to the bus ---------- */
SuggestStore.init(deps);
A.ok(bus._h['agent.run.end'] && bus._h['agent.run.end'].length === 1, 'init subscribes exactly one agent.run.end listener');

/* ---------- the counter: clean hero tasks advance the cooldown; others are ignored ---------- */
SuggestStore.reset();
emitDone();
A.eq(SuggestStore._state().tasksSinceLast, 1, 'a clean hero task advances the cooldown counter');
emitDone({ reason: 'error' });
A.eq(SuggestStore._state().tasksSinceLast, 1, 'a failed run does not advance the counter');
emitDone({ agentId: 'worker-2' });
A.eq(SuggestStore._state().tasksSinceLast, 1, 'a non-hero run does not advance the counter');

/* ---------- baseline: established only once the First Pitch has fired ---------- */
A.eq(SuggestStore._state().lastFamiliarity, null, 'no baseline before the First Pitch');
pitchDoneFlag = true; dsFam = 0.4;
emitDone();
A.eq(SuggestStore._state().lastFamiliarity, 0.4, 'the first task after the First Pitch records the familiarity baseline');

/* ---------- willSuggest: the cadence gate ---------- */
pitchDoneFlag = false;
A.eq(SuggestStore.willSuggest(), false, 'no ongoing idea before the First Pitch happened');
pitchDoneFlag = true;

dsFam = 0.4;   // baseline is 0.4; nothing new learned
A.eq(SuggestStore.willSuggest(), false, 'stays quiet until the dossier grows past the baseline');

dsFam = 0.6;   // learned something new, but cooldown: tasksSinceLast is 2 (<3)
A.eq(SuggestStore._state().tasksSinceLast, 2, 'counter is at 2 from the two baseline-era tasks');
A.eq(SuggestStore.willSuggest(), false, 'holds for the task cooldown even with something new to say');
emitDone();   // → 3
A.eq(SuggestStore.willSuggest(), true, 'suggests once it has grown AND the cooldown has passed');

// defensive: a missing dossier summary must not crash the gate — it just stays quiet
const _summ = global.DossierStore.summary;
global.DossierStore.summary = () => null;
A.eq(SuggestStore.willSuggest(), false, 'a null dossier summary → no idea, never throws');
global.DossierStore.summary = _summ;

(async () => {
  try {
    /* ---------- fire: renders a gentle nudge, spends the session, advances baseline + resets cooldown ---------- */
    clearFakes();
    hn.next = { text: 'PITCH: a weekly digest of your repo\nWHY: you ship small fixes often\nBUILD: recipe:quick-note\nGAP: which repo' };
    await SuggestStore.fire();

    A.eq(hn.calls.length, 1, 'fire makes exactly one model call');
    const call = hn.calls[0];
    A.eq(call.system, SYSTEM, 'the idea is reasoned from the LIVE system prompt (dossier-grounded)');
    A.eq(call.isTask, false, 'reason-only call (isTask:false)');
    A.eq(call.placed, [], 'reason-only call gets no capabilities (placed:[])');
    A.eq(chat.nudges.length, 1, 'it renders exactly one gentle COMMS nudge (not the heavy Dialogue panel)');
    A.ok(chat.nudges[0].text.indexOf('a weekly digest of your repo') >= 0, 'the nudge carries the idea');
    A.eq(chat.nudges[0].opts.length, 2, 'the nudge offers two options — build it / not now (never a menu)');
    A.eq(SuggestStore._session(), 1, 'firing spends this session\'s one idea');
    A.eq(SuggestStore._state().lastFamiliarity, 0.6, 'the baseline advances to the new familiarity');
    A.eq(SuggestStore._state().tasksSinceLast, 0, 'the cooldown restarts after an idea');
    A.eq(SuggestStore.willSuggest(), false, 'no second idea this session (session-spent)');

    // "build it" on a fully-runnable recipe launches the recipe
    clickBuild();
    A.ok(launchedRecipe && launchedRecipe.id === 'quick-note', '"build it" launches a fully-runnable recipe (no dead gap)');

    /* ---------- build routing: a recipe that needs its gap → the gap-asking directive ---------- */
    clearFakes(); SuggestStore.reset();
    hn.next = { text: 'PITCH: a daily brief\nBUILD: recipe:morning-brief\nGAP: which topic' };
    await SuggestStore.fire();
    clickBuild();
    A.eq(launchedRecipe, null, 'a recipe needing a required value is not launched as an empty template');
    A.ok(launchedDirective && launchedDirective.indexOf('which topic') >= 0, 'instead the build asks for the gap');

    /* ---------- build routing: workflow → directive ---------- */
    clearFakes(); SuggestStore.reset();
    hn.next = { text: 'PITCH: a custom thing\nBUILD: workflow\nGAP: the detail' };
    await SuggestStore.fire();
    clickBuild();
    A.eq(launchedRecipe, null, 'a workflow idea launches no recipe');
    A.ok(launchedDirective && launchedDirective.indexOf('a custom thing') >= 0, 'a workflow idea sends a real directive');

    /* ---------- graceful: a model hiccup backs off a cooldown without burning the session ---------- */
    clearFakes(); SuggestStore.reset();
    SuggestStore._state().tasksSinceLast = 5;
    hn.next = { error: true, text: '' };
    await SuggestStore.fire();
    A.eq(chat.nudges.length, 0, 'no nudge on a model error');
    A.eq(SuggestStore._session(), 0, 'a model error does not spend the session');
    A.eq(SuggestStore._state().tasksSinceLast, 0, 'a model error backs off a full cooldown (no hammering)');

    clearFakes(); SuggestStore.reset();
    SuggestStore._state().tasksSinceLast = 5;
    hn.next = { text: 'no tagged pitch here' };
    await SuggestStore.fire();
    A.eq(chat.nudges.length, 0, 'no nudge on an unparseable reply');
    A.eq(SuggestStore._session(), 0, 'an unparseable reply does not spend the session');

    /* ---------- persistence + reset ---------- */
    clearFakes(); SuggestStore.reset();
    SuggestStore._state().lastFamiliarity = 0.8; SuggestStore._state().tasksSinceLast = 2;
    bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });   // triggers a save via the counter
    A.ok(mem['starnet.suggest.v1'] && JSON.parse(mem['starnet.suggest.v1']).lastFamiliarity === 0.8, 'state self-persists to its own key (no save.js)');
    SuggestStore.reset();
    A.eq(mem['starnet.suggest.v1'], undefined, 'reset() removes the persisted key');
    A.eq(SuggestStore._state().lastFamiliarity, null, 'reset() clears the baseline for a new hero');

    /* ---------- re-entrancy: willSuggest() is false while an idea is mid-flight (no double-fire) ---------- */
    clearFakes(); SuggestStore.reset();
    SuggestStore._state().lastFamiliarity = 0.4; SuggestStore._state().tasksSinceLast = 5; dsFam = 0.6; pitchDoneFlag = true;
    A.eq(SuggestStore.willSuggest(), true, 're-entrancy setup: an idea is due');
    let release; hn.next = new Promise(r => { release = () => r({ text: 'PITCH: x\nBUILD: workflow' }); });
    const inflight = SuggestStore.fire();   // do NOT await — leave it mid-flight (firing === true)
    A.eq(SuggestStore.willSuggest(), false, 'willSuggest() is false while a fire() is mid-flight (firing guard → no double-fire)');
    release(); await inflight;

    /* ---------- after a model hiccup the cooldown reset holds off the next idea ---------- */
    clearFakes(); SuggestStore.reset();
    SuggestStore._state().lastFamiliarity = 0.4; SuggestStore._state().tasksSinceLast = 5; dsFam = 0.6;
    hn.next = { error: true, text: '' };
    await SuggestStore.fire();
    A.eq(SuggestStore.willSuggest(), false, 'after a model hiccup, the cooldown reset holds off the next idea');

    A.report('suggeststore.test');
  } catch (e) {
    A.ok(false, 'unexpected throw: ' + (e && e.stack || e));
    A.report('suggeststore.test');
  }
})();
