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
  const RECENT_CAP = 8;    // remember the last N pitched-idea fingerprints so the agent never re-pitches the same idea
  let state = null;        // { v:1, lastFamiliarity:number|null, tasksSinceLast:int, recent:[fingerprint] }
  let deps = {};           // accessors/actions injected by app.js
  let sessionShown = 0;    // ideas shown THIS session (in-memory; resets each app run)
  let firing = false;      // re-entrancy guard while an idea is mid-flight
  let pendingChain = null; // G1c: a just-unlocked capability label to chain a follow-up idea off (one-shot, in-memory)
  let goalProgressed = false; // Tier 2: a goal milestone just completed → allow ONE suggestion on progress (not only familiarity growth). One-shot, in-memory.

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof Pitch !== 'undefined' && state;

  // a stable fingerprint of an idea (its title), so a re-pitched same/near-same idea is recognised and skipped:
  // lowercase, keep alphanumeric tokens >=3 chars, sort + unique → reordered/padded restatements still match.
  function fingerprint(title) {
    const toks = String(title == null ? '' : title).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return Array.from(new Set(toks)).sort().join(' ');
  }
  function seenRecently(fp) { return !!fp && Array.isArray(state.recent) && state.recent.indexOf(fp) >= 0; }
  function rememberIdea(fp) {
    if (!fp) return;
    if (!Array.isArray(state.recent)) state.recent = [];
    state.recent.push(fp);
    while (state.recent.length > RECENT_CAP) state.recent.shift();
  }

  function hydrate(raw) {
    const s = { v: 1, lastFamiliarity: null, tasksSinceLast: 0, recent: [] };
    if (raw && typeof raw === 'object') {
      if (Number.isFinite(raw.lastFamiliarity)) s.lastFamiliarity = raw.lastFamiliarity;
      if (Number.isFinite(raw.tasksSinceLast) && raw.tasksSinceLast >= 0) s.tasksSinceLast = raw.tasksSinceLast;
      if (Array.isArray(raw.recent)) s.recent = raw.recent.filter(x => typeof x === 'string').slice(-RECENT_CAP);
    }
    return s;
  }

  // opts: { getSystem(), getCaps(), getRecentTask(), launchRecipe(recipe,values), launchDirective(text) }
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    sessionShown = 0; firing = false; pendingChain = null; goalProgressed = false;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) U.bus.on('agent.run.end', onRunEnd);
  }

  // G1c QUEST CHAINING: a station quest just closed a capability gap (a prop landed → a real capability is live).
  // Arm a ONE-SHOT follow-up so the NEXT natural suggestion (which already rides the cooldown + session cap) is
  // grounded in that fresh capability — "the dish is live, want NOVA to build the price-watcher?". This never
  // FORCES a beat: it only flavors the next due suggestion. If the gate never opens, it drops silently on the
  // next fire (anti-nag; never a queued nag). The latest unlock wins (a stale chain is superseded, not stacked).
  function armChain(capLabel) {
    const c = String(capLabel == null ? '' : capLabel).trim();
    if (c) pendingChain = c.slice(0, 24);
  }

  // GROWTH Tier 2 (§5, ADDITIVE OR): a goal milestone just advanced — a moment worth a fresh idea even if the
  // dossier's familiarity didn't grow. willSuggest() ORs this in ALONGSIDE the existing gates (session cap +
  // cooldown + graduation stay in force); it never bypasses a cap, it only satisfies the "something new to say"
  // clause. One-shot: consumed on the next fire (or dropped if the gate never opens — never a queued nag).
  function noteGoalProgress() { goalProgressed = true; }

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
    } else if (state.lastFamiliarity != null) {
      // RE-FLOOR on a DROP: if familiarity fell below the baseline (e.g. a dossier dim was ADDED so the fraction
      // shrank — 5→7 dims — or a belief was forgotten), lower the baseline to now. Otherwise a one-time denominator
      // change could leave familiarity permanently ≤ baseline and freeze ongoing ideas forever for pre-existing saves.
      const fam = familiarityNow();
      if (fam != null && fam < state.lastFamiliarity) state.lastFamiliarity = fam;
    }
    save();
  }

  // the sync gate chat.js consults in its single post-run beat slot (read-only — no mutation, no model call).
  function willSuggest() {
    if (!ready() || firing) return false;
    const sum = summary();
    const known = sum ? sum.known : [];
    const fam = sum && Number.isFinite(sum.familiarity) ? sum.familiarity : 0;
    // V3 §6: the shared readiness gate (fail-closed — no provable readiness, no idea). Same read pitchstore uses.
    let rd = { ready: false, why: 'no-readiness-read' };
    try {
      if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.readiness) {
        const r = UnderstandingStore.readiness();
        if (r) rd = { ready: !!r.ready, why: (r.reasons && r.reasons[0]) || '' };
      }
    } catch (_) {}
    const gate = Pitch.shouldSuggest({
      firstPitchDone: pitchDone(),
      knownDims: known,
      familiarity: fam,
      lastFamiliarity: (state.lastFamiliarity == null ? fam : state.lastFamiliarity),   // no baseline yet → nothing-new
      tasksSinceLast: state.tasksSinceLast || 0,
      sessionShown: sessionShown,
      ready: rd.ready, readyWhy: rd.why
    });
    if (gate.go) return true;
    // Tier 2 (§5 ADDITIVE OR): if the ONLY thing holding the idea back is "nothing new" and a goal milestone just
    // advanced, that progress IS the new thing — let it through. Every OTHER gate (graduation/require-dims/session
    // cap/cooldown) still applies (a non-'nothing-new' reason still blocks), so no cap is ever bypassed.
    if (goalProgressed && gate.reason === 'nothing-new') return true;
    return false;
  }

  // run the idea directive → parse → render a GENTLE nudge → route "build it". Awaitable for the test. Called by
  // chat.js only when willSuggest() is true and the shared beat slot is free.
  async function fire() {
    if (firing || !ready()) return;
    if (typeof Harness === 'undefined' || !Harness.chat) return;
    if (typeof Chat === 'undefined' || !Chat.nudge) return;
    firing = true;
    // G1c: consume any armed chain ONCE — this fire either uses it or it's dropped (never carried to a later beat).
    const chain = pendingChain; pendingChain = null;
    goalProgressed = false;   // Tier 2: the goal-progress "something new" allowance is spent on THIS fire (one-shot)
    try {
      const recipes = (typeof Recipes !== 'undefined' && Recipes.list)
        ? Recipes.list().map(r => ({ id: r.id, name: r.name, tagline: r.tagline })) : [];
      const caps = deps.getCaps ? deps.getCaps() : [];
      // R3 BELIEF PROBE: when a north-star-critical belief's confidence has sagged, aim this idea at it —
      // the accept/decline below then silently corroborates or counter-evidences that belief (drift detection
      // with zero new asks). Fail-open: no UnderstandingStore / no sagging belief → the normal un-aimed idea.
      let probe = null;
      try { if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.probeTarget) probe = UnderstandingStore.probeTarget(); } catch (_) {}
      const directive = Pitch.buildDirective({ recipes, capabilities: caps, recentTask: deps.getRecentTask ? deps.getRecentTask() : '', unlockedCapability: chain || '', probe: probe });
      const system = deps.getSystem ? deps.getSystem() : '';
      const res = await Harness.chat({ system, messages: [{ role: 'user', content: directive }], agentId: 'agent', isTask: false, placed: [], internal: true });
      const parsed = (res && !res.error) ? Pitch.parsePitch(res.text) : null;
      if (!parsed) { state.tasksSinceLast = 0; save(); return; }   // model hiccup → back off a full cooldown, don't hammer

      // already pitched this idea before? skip it WITHOUT spending the session — but also advance the growth baseline
      // so a repeat needs FURTHER dossier growth before it can fire again. Otherwise a low-diversity model that keeps
      // returning the same idea would burn an aux-model call every cooldown forever; this caps that to once per growth.
      const fp = fingerprint(parsed.title);
      if (seenRecently(fp)) { const fam = familiarityNow(); if (fam != null) state.lastFamiliarity = fam; state.tasksSinceLast = 0; save(); return; }

      const why = parsed.why ? (' ' + parsed.why) : '';
      const gap = parsed.gap ? (' i’d need one thing from you: ' + parsed.gap) : '';
      // G3a seed callout: an idea that reuses a Commander-saved seed credits it inline (a credit line,
      // never a separate beat) — the mint→pitch loop, spoken closed.
      let credit = '';
      if (typeof SeedCredit !== 'undefined' && parsed.build && parsed.build.recipeId && typeof Recipes !== 'undefined' && Recipes.get) {
        const c = SeedCredit.creditForRecipe(Recipes.get(parsed.build.recipeId));
        if (c) credit = ' ' + c;
      }
      const line = '✦ a fresh idea — ' + Pitch.titleSentence(parsed.title) + why + credit + gap;   // shared title→sentence join (no double period)
      if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }   // G3a: the idea beat gets its soft chime (was mute)
      Chat.nudge(line, [{ label: 'let’s build it', value: 'build' }, { label: 'not now', value: 'no', skip: true }], choice => {
        const accepted = !!(choice && choice.value === 'build');
        // R3: settle the probe — the choice on an AIMED idea is evidence about the belief it was aimed at
        // (accept corroborates, decline counter-evidences). An un-aimed idea settles nothing.
        if (probe) { try { if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.noteProbe) UnderstandingStore.noteProbe(probe.dim, accepted); } catch (_) {} }
        if (accepted) doBuild(parsed);
      });

      sessionShown++;                                   // spend this session's single idea (anti-nag)
      rememberIdea(fp);                                 // record the idea so it's never re-pitched as a "fresh idea"
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
      // G1c: the accepted idea becomes a trackable WORK quest (multi-step, rides the QuestState celebration).
      // Minted BEFORE the launch so the store can claim the run the launch kicks off. Additive, best-effort.
      try { if (typeof WorkQuestStore !== 'undefined' && WorkQuestStore.accept) WorkQuestStore.accept(parsed); } catch (_) {}
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
  function reset() { state = { v: 1, lastFamiliarity: null, tasksSinceLast: 0, recent: [] }; sessionShown = 0; firing = false; pendingChain = null; goalProgressed = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  // _-prefixed handles are for the deterministic node test (harmless in the browser).
  return { init, reset, onRunEnd, willSuggest, fire, armChain, noteGoalProgress, _state: () => state, _session: () => sessionShown, _chain: () => pendingChain };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { SuggestStore };
