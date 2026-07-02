/* STARNET — pitchstore.js : the browser wiring around the pure First Pitch engine (pitch.js).

   The wiring half of "the agent that points you." It listens (read-only) for the agent finishing its first
   real task, then — once the station knows enough about the Commander — has the agent REASON OUT one tailored,
   buildable suggestion and offers to build it. This is the graduation beat: order-taker → advisor.

   How the pitch is generated without a template: it runs Pitch.buildDirective through the EXISTING model path
   (Harness.chat) as a REASON-ONLY call (placed:[] so it can touch no tools, isTask:false). The agent's live
   system prompt already carries the COMMANDER dossier block (app.js composeSystemPrompt), so the agent reasons
   from what it genuinely knows about the Commander — the pitch is personalized for free, no context re-injection.

   Discipline (mirrors curiositystore.js / dossierstore.js):
   - READ-ONLY citizen of U.bus — it .on()s 'agent.run.end' and NEVER .emit()s (the frozen contract is owned
     elsewhere; lint-emits stays green).
   - Fire-once + anti-nag: self-persists a single {pitched} flag to its OWN localStorage key (no save.js change),
     and a re-entrancy guard means a pitch never doubles up.
   - Honest gate lives in the pure engine (Pitch.shouldPitch); this module only supplies the live inputs.

   All decision logic is in pitch.js (pure, tested). This is just the live glue: the bus hook, the model call,
   the Dialogue beat, and routing "build it" into a real run with no dead gap. node-exportable for its test. */
'use strict';
const PitchStore = (() => {
  const KEY = 'starnet.pitch.v1';
  let state = null;            // { v:1, pitched:bool } — the fire-once flag (self-persisted)
  let deps = {};               // accessors/actions injected by app.js (kept app-private otherwise)
  let firing = false;          // re-entrancy guard while a pitch is mid-flight (a new run.end can't double-fire)

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof Pitch !== 'undefined' && state;

  function hydrate(raw) {
    const s = (typeof Pitch !== 'undefined') ? Pitch.fresh() : { v: 1, pitched: false };
    if (raw && typeof raw === 'object' && raw.pitched) s.pitched = true;
    return s;
  }

  // opts: { getSystem(), getCaps(), getName(), getRecentTask(), launchRecipe(recipe,values), launchDirective(text) }
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    firing = false;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) U.bus.on('agent.run.end', onRunEnd);
  }

  // the GATE (live inputs → the pure engine). Side-effect free so the test can assert it directly. Returns the
  // Pitch.shouldPitch verdict, or an early {go:false,reason} for a wiring-level reason (not the hero, busy, etc.).
  function decide(p) {
    if (!ready()) return { go: false, reason: 'not-ready' };
    if (firing) return { go: false, reason: 'firing' };
    if (state.pitched) return { go: false, reason: 'already-pitched' };
    p = p || {};
    if (p.reason !== 'done') return { go: false, reason: 'not-done' };          // only a cleanly completed task graduates
    if ((p.agentId || 'agent') !== 'agent') return { go: false, reason: 'not-hero' };   // summoned crew never pitch
    // GRADUATION IS EARNED BY REAL WORK, NOT CHATTER. The agent.run.end payload carries no isTask flag, so app.js
    // injects wasTaskRun(runId) (backed by Chat's run-meta ledger). Only a genuine TASK (tools available) graduates
    // the agent from order-taker to advisor — a casual question/answer never triggers the First Pitch. (Back-compat:
    // when the dep is absent — e.g. the pure decide() unit test — the check is skipped and prior behavior holds.)
    if (deps.wasTaskRun && !deps.wasTaskRun(p.runId)) return { go: false, reason: 'not-task' };
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return { go: false, reason: 'onboarding' };
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return { go: false, reason: 'intake' };
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return { go: false, reason: 'dialogue-open' };   // never stomp the awakening/tutorial panel
    const sum = (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null;
    const known = sum ? sum.known : [];
    return Pitch.shouldPitch({ firstTaskDone: true, alreadyPitched: state.pitched, knownDims: known });
  }

  function onRunEnd(p) { if (decide(p).go) fire(p); }

  // run the directive → parse → present the beat → route the choice. Awaitable so the test can drive it. `p` is the
  // triggering agent.run.end payload; its runId lets getRecentTask name the run that ACTUALLY just finished (not
  // whatever workstream happens to be on screen — they differ if the Commander switched streams mid-run).
  async function fire(p) {
    if (firing || !ready()) return;
    if (typeof Harness === 'undefined' || !Harness.chat || typeof Dialogue === 'undefined') return;
    firing = true;
    try {
      const recipes = (typeof Recipes !== 'undefined' && Recipes.list)
        ? Recipes.list().map(r => ({ id: r.id, name: r.name, tagline: r.tagline })) : [];
      const caps = deps.getCaps ? deps.getCaps() : [];
      const directive = Pitch.buildDirective({ recipes, capabilities: caps, recentTask: deps.getRecentTask ? deps.getRecentTask(p && p.runId) : '' });
      const system = deps.getSystem ? deps.getSystem() : '';
      const name = deps.getName ? deps.getName() : 'AGENT';

      if (typeof Chat !== 'undefined' && Chat.clearNudge) Chat.clearNudge();   // retire any stale gentle nudge from a prior run before the focused panel opens over it
      Dialogue.open({ name });
      await Dialogue.say('give me a second — now that i know you a little, let me think about what would actually be worth building for you…');
      const res = await Harness.chat({ system, messages: [{ role: 'user', content: directive }], agentId: 'agent', isTask: false, placed: [], internal: true });
      const parsed = (res && !res.error) ? Pitch.parsePitch(res.text) : null;
      if (!parsed) {   // graceful: no usable pitch (model hiccup / unparseable) → say nothing, stay un-pitched so a later run can retry
        if (Dialogue.isOpen()) Dialogue.close();
        return;
      }
      // G3a seed callout: a pitch that reuses a recipe the Commander SAVED AS A SEED credits it out loud —
      // one appended sentence (a credit line, never a separate beat), only when provenance genuinely links.
      let presented = Pitch.present(parsed);
      if (typeof SeedCredit !== 'undefined' && parsed.build && parsed.build.recipeId && typeof Recipes !== 'undefined' && Recipes.get) {
        const credit = SeedCredit.creditForRecipe(Recipes.get(parsed.build.recipeId));
        if (credit) presented += ' ' + credit;
      }
      if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }   // G3a: the pitch beat gets its soft chime (was mute)
      const choice = await Dialogue.node({ lines: presented, options: Pitch.choices() });
      state.pitched = true; save();   // we DID deliver a pitch — never offer the first one again (a transient error above leaves it un-pitched)
      if (Dialogue.isOpen()) Dialogue.close();
      if (choice && choice.value === 'build') doBuild(parsed);
      // 'other' → graceful: the panel closes, the Commander stays in control, the dossier keeps learning for sharper future ideas
    } catch (_) {
      try { if (Dialogue.isOpen()) Dialogue.close(); } catch (__) {}
    } finally {
      firing = false;
    }
  }

  // "let's build it" → a real run starts immediately (the no-dead-gap promise). A recipe pitch instantiates the
  // recipe; a workflow pitch is sent as a directive that also asks for the one gap, so the build IS the Commander
  // making it theirs (the intentional-gap beat).
  function doBuild(parsed) {
    try {
      // G1c: the accepted First Pitch becomes a trackable WORK quest (multi-step, rides the QuestState
      // celebration). Minted BEFORE the launch so its store can claim the run the launch kicks off. Additive.
      try { if (typeof WorkQuestStore !== 'undefined' && WorkQuestStore.accept) WorkQuestStore.accept(parsed); } catch (_) {}
      const b = parsed.build || {};
      if (b.kind === 'recipe' && b.recipeId && typeof Recipes !== 'undefined' && Recipes.get) {
        const r = Recipes.get(b.recipeId);
        // launch the recipe directly ONLY if it is fully runnable as-is. If it still needs a required value (its
        // "gap"), or the proposed recipe doesn't exist, fall through to the directive path — which starts a real
        // run AND asks the Commander for the one gap, so the build is genuinely theirs, never an empty template.
        const missing = r ? ((typeof Recipes.requiredMissing === 'function') ? Recipes.requiredMissing(r, {}) : []) : ['_unknown'];
        if (r && deps.launchRecipe && !missing.length) { deps.launchRecipe(r, null); return; }
      }
      const gapLine = parsed.gap ? (' First, ask me: ' + parsed.gap + '.') : '';
      const directive = "Let's build it — " + parsed.title + '.' + gapLine;
      if (deps.launchDirective) deps.launchDirective(directive);
      else if (typeof Chat !== 'undefined' && Chat.send && !Chat.isBusy()) Chat.send(directive);
    } catch (_) {}
  }

  // THE HANDOFF OFFER — the tutorial's demo run ends INSIDE the tour, where the auto path correctly stands
  // down (the dialogue-open guard exists to never stomp a live ceremony). At the tour's close, the tutorial
  // hands the stage over DELIBERATELY: same pure-engine gate + the same earned-work honesty check as the auto
  // path (a skipped demo never graduates — no advice before proof-of-life), minus only the stage-protection
  // guards that no longer apply because the tour is the one offering the stage. Resolves true only when a
  // pitch beat was actually DELIVERED (fire() latches state.pitched exactly then), so the tour knows whether
  // the pitch replaced its classic close; any quiet outcome resolves false and leaves the pitch armed.
  async function offerAtHandoff(runId) {
    try {
      if (!ready() || firing || state.pitched) return false;
      if (typeof Harness === 'undefined' || !Harness.chat || typeof Dialogue === 'undefined') return false;
      if (!deps.wasTaskRun || !deps.wasTaskRun(runId)) return false;   // stricter than the auto path: the tour MUST prove the run was a real task
      const sum = (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null;
      const v = Pitch.shouldPitch({ firstTaskDone: true, alreadyPitched: state.pitched, knownDims: sum ? sum.known : [] });
      if (!v.go) return false;
      await fire({ reason: 'done', agentId: 'agent', runId });
      return !!(state && state.pitched);
    } catch (_) { return false; }
  }

  // S2: a brand-new hero re-earns its First Pitch. Drop the self-persisted flag (Save.clear() only wipes the
  // main save envelope; this store owns its own key, like curiositystore).
  function reset() { state = (typeof Pitch !== 'undefined') ? Pitch.fresh() : { v: 1, pitched: false }; firing = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  // has the one-time First Pitch already fired? (read by the ongoing-suggestion engine — graduation gates it).
  function done() { return !!(state && state.pitched); }

  // _-prefixed handles are exposed for the deterministic node test (harmless in the browser).
  return { init, reset, onRunEnd, done, offerAtHandoff, _decide: decide, _fire: fire, _state: () => state };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { PitchStore };
