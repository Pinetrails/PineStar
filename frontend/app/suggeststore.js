/* STARNET — suggeststore.js : the browser wiring for ONGOING SUGGESTIONS (the recurring counterpart to the
   one-time First Pitch). Slice 3 of "the agent that points you."

   Where pitchstore.js fires ONCE (the graduation beat), this keeps the reverse value-flow alive: as the station
   keeps learning about its Commander (the dossier grows via curiosity/the interview), the agent occasionally
   offers ONE fresh, tailored, buildable idea — gently. It reuses the pure pitch engine for content
   (Pitch.buildDirective / parsePitch) and the same reason-only model path (Harness.chat, placed:[]) so the idea
   is grounded in what the agent genuinely knows (the live system prompt carries the dossier block).

   "Putting the pieces together" = anti-nag coordination. This does NOT pop the heavy Dialogue panel; it renders a
   GENTLE COMMS nudge (Chat.nudge), and it shares chat.js's single post-run beat slot with the curiosity nudge —
   chat.js cedes that one beat to a due suggestion (SuggestStore.willSuggest → fire) BEFORE asking curiosity, so
   the agent never stacks an idea and a question on the same task. The cadence (cooldown + per-session cap +
   only-when-the-dossier-grew) lives in the pure Pitch.shouldSuggest; this is just the live glue + the counter.

   Discipline mirrors curiositystore.js / pitchstore.js: READ-ONLY citizen of U.bus (subscribes to count tasks,
   NEVER emits), self-persists its own key (no save.js change), node-exportable for its test. */
'use strict';
const SuggestStore = (() => {
  const KEY = 'starnet.suggest.v1';
  let state = null;        // { v:1, lastFamiliarity:number|null, tasksSinceLast:int }
  let deps = {};           // accessors/actions injected by app.js
  let sessionShown = 0;    // ideas shown THIS session (in-memory; resets each app run)
  let firing = false;      // re-entrancy guard while an idea is mid-flight

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof Pitch !== 'undefined' && state;

  function hydrate(raw) {
    const s = { v: 1, lastFamiliarity: null, tasksSinceLast: 0 };
    if (raw && typeof raw === 'object') {
      if (Number.isFinite(raw.lastFamiliarity)) s.lastFamiliarity = raw.lastFamiliarity;
      if (Number.isFinite(raw.tasksSinceLast) && raw.tasksSinceLast >= 0) s.tasksSinceLast = raw.tasksSinceLast;
    }
    return s;
  }

  // opts: { getSystem(), getCaps(), getRecentTask(), launchRecipe(recipe,values), launchDirective(text) }
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    sessionShown = 0; firing = false;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) U.bus.on('agent.run.end', onRunEnd);
  }

  const pitchDone = () => (typeof PitchStore !== 'undefined' && PitchStore.done) ? PitchStore.done() : false;
  function summary() { return (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null; }
  function familiarityNow() { const s = summary(); return s && Number.isFinite(s.familiarity) ? s.familiarity : null; }

  // THE COUNTER (read-only on the bus): every clean hero task advances the cooldown — independent of whether a
  // beat is actually shown. Also lazily establishes the familiarity baseline once the First Pitch has happened, so
  // ongoing ideas fire only on growth ABOVE what the agent already knew at graduation.
  function onRunEnd(p) {
    if (!ready()) return;
    p = p || {};
    if (p.reason !== 'done') return;
    if ((p.agentId || 'agent') !== 'agent') return;
    state.tasksSinceLast = (state.tasksSinceLast || 0) + 1;
    if (state.lastFamiliarity == null && pitchDone()) {
      const fam = familiarityNow();
      if (fam != null) state.lastFamiliarity = fam;   // baseline = what it knew when it graduated
    }
    save();
  }

  // the sync gate chat.js consults in its single post-run beat slot (read-only — no mutation, no model call).
  function willSuggest() {
    if (!ready() || firing) return false;
    const sum = summary();
    const known = sum ? sum.known : [];
    const fam = sum && Number.isFinite(sum.familiarity) ? sum.familiarity : 0;
    const gate = Pitch.shouldSuggest({
      firstPitchDone: pitchDone(),
      knownDims: known,
      familiarity: fam,
      lastFamiliarity: (state.lastFamiliarity == null ? fam : state.lastFamiliarity),   // no baseline yet → nothing-new
      tasksSinceLast: state.tasksSinceLast || 0,
      sessionShown: sessionShown
    });
    return gate.go;
  }

  // run the idea directive → parse → render a GENTLE nudge → route "build it". Awaitable for the test. Called by
  // chat.js only when willSuggest() is true and the shared beat slot is free.
  async function fire() {
    if (firing || !ready()) return;
    if (typeof Harness === 'undefined' || !Harness.chat) return;
    if (typeof Chat === 'undefined' || !Chat.nudge) return;
    firing = true;
    try {
      const recipes = (typeof Recipes !== 'undefined' && Recipes.list)
        ? Recipes.list().map(r => ({ id: r.id, name: r.name, tagline: r.tagline })) : [];
      const caps = deps.getCaps ? deps.getCaps() : [];
      const directive = Pitch.buildDirective({ recipes, capabilities: caps, recentTask: deps.getRecentTask ? deps.getRecentTask() : '' });
      const system = deps.getSystem ? deps.getSystem() : '';
      const res = await Harness.chat({ system, messages: [{ role: 'user', content: directive }], agentId: 'agent', isTask: false, placed: [] });
      const parsed = (res && !res.error) ? Pitch.parsePitch(res.text) : null;
      if (!parsed) { state.tasksSinceLast = 0; save(); return; }   // model hiccup → back off a full cooldown, don't hammer

      const why = parsed.why ? (' ' + parsed.why) : '';
      const gap = parsed.gap ? (' i’d need one thing from you: ' + parsed.gap) : '';
      const line = '✦ a fresh idea — ' + parsed.title + '.' + why + gap;
      Chat.nudge(line, [{ label: 'let’s build it', value: 'build' }, { label: 'not now', value: 'no', skip: true }], choice => {
        if (choice && choice.value === 'build') doBuild(parsed);
      });

      sessionShown++;                                   // spend this session's single idea (anti-nag)
      const fam = familiarityNow();
      if (fam != null) state.lastFamiliarity = fam;     // advance the baseline so the NEXT idea needs further growth
      state.tasksSinceLast = 0;                         // restart the cooldown
      save();
    } catch (_) {
    } finally {
      firing = false;
    }
  }

  // "build it" → a real run starts immediately. Same routing as the First Pitch: a fully-runnable recipe launches;
  // a recipe that still needs its gap (or an unknown recipe) becomes the gap-asking directive — never an empty
  // template. (Kept local rather than shared so pitchstore.js stays untouched.)
  function doBuild(parsed) {
    try {
      const b = parsed.build || {};
      if (b.kind === 'recipe' && b.recipeId && typeof Recipes !== 'undefined' && Recipes.get) {
        const r = Recipes.get(b.recipeId);
        const missing = r ? ((typeof Recipes.requiredMissing === 'function') ? Recipes.requiredMissing(r, {}) : []) : ['_unknown'];
        if (r && deps.launchRecipe && !missing.length) { deps.launchRecipe(r, null); return; }
      }
      const gapLine = parsed.gap ? (' First, ask me: ' + parsed.gap + '.') : '';
      const directive = "Let's build it — " + parsed.title + '.' + gapLine;
      if (deps.launchDirective) deps.launchDirective(directive);
      else if (typeof Chat !== 'undefined' && Chat.send && !Chat.isBusy()) Chat.send(directive);
    } catch (_) {}
  }

  // S2: a brand-new hero starts fresh (no baseline, no cooldown carryover). Own key, like curiositystore.
  function reset() { state = { v: 1, lastFamiliarity: null, tasksSinceLast: 0 }; sessionShown = 0; firing = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  // _-prefixed handles are for the deterministic node test (harmless in the browser).
  return { init, reset, onRunEnd, willSuggest, fire, _state: () => state, _session: () => sessionShown };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { SuggestStore };
