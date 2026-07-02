/* STARNET — goalstore.js : the live wiring around the pure GOAL-TREE engine (goals.js) — GROWTH Tier 2.

   The glue that turns a flat dossier goals-belief into a confirmed, persisted PATH the Commander watches fill in:
     • THE DECOMPOSITION FLOW — when a goals-dim belief exists with no goal tree yet, it runs the pure
       Goals.buildDirective through the EXISTING reason-only model path (the same Harness.chat plumbing pitchstore
       uses: placed:[], isTask:false, internal:true), parses the reply (Goals.parseDecomposition, value-floor +
       redact + cap), and offers ONE confirm beat ("here's how I'd break this down — good?") at the LOWEST post-run
       priority (memory turn-in + study proposals win first). Confirm persists the tree; Not-now re-offers ONLY
       after the dossier's goals belief changes (never nags). The confirm panel is a focused Dialogue, like the
       First Pitch — chat.js drives the arbitration through the shared beat slot's arc participant.
     • THE QUEST PROJECTION — the active goal renders as a header + progress meter with its next OPEN milestone as
       an actionable quest (joined into QuestStore.view via Goals.project). Accepting the milestone quest routes
       through the EXISTING work-quest path (WorkQuestStore.accept), binding the real build to the milestone so
       completing the REAL work completes the milestone — never a manual tick.
     • THE CHAINING + EVIDENCE — on every clean run end it re-reads WorkQuestStore's projection; a bound milestone
       whose work quest went done folds the milestone done (Goals.foldMilestoneDone), WRITES the run-summary line
       as evidence, advances the bar, surfaces the NEXT milestone quest, bumps Study salience (fail-open), and —
       on the last milestone — completes the whole goal. The completion rides the EXISTING queststatestore
       celebration (its open→done fold sees arc-step/arc-goal edges in the shared projection).
     • DRIFT — if the Study Engine retires the source goals belief (dossier.forget), sync() detects the belief is
       gone and retires the goal tree (kept for history, hidden from the active quest log).

   Discipline mirrors studystore.js / workqueststore.js:
   - READ-ONLY citizen of U.bus — subscribes to agent.run.end, NEVER emits (the frozen shared/events.js contract
     is owned elsewhere; lint-emits stays green).
   - Self-persists its OWN localStorage key (the goal trees + the not-now re-offer fingerprints) — no save.js
     change (the established growth-store pattern). Mirrors the active goal to the sidecar (POST /api/goals) so
     server-composed cron runs can see it, exactly like DossierStore.pushToSidecar.
   - node-exportable for its test; all DECISION logic lives in the pure Goals engine, this is the edge. */
'use strict';
const GoalStore = (() => {
  const KEY = 'starnet.goals.v1';
  const GOAL_CAP = 24;          // keep at most this many goal trees (FIFO by createdAt) — history, never unbounded
  let state = null;             // { v, goals:[goalNode], offered:{ beliefFp: 1 } } — offered = decompositions declined/pending, keyed by the belief fingerprint (re-offer only on change)
  let deps = {};                // { getSystem, getName, getCaps } injected by app.js (all optional; fail-open)
  let bound = false;
  let firing = false;           // re-entrancy guard while a decomposition confirm is mid-flight
  const boundQuests = {};       // work-quest id -> { goalId, milestoneId } claimed the arm window (in-memory; the tree persists the questRef)
  let arming = null;            // { goalId, milestoneId } awaiting the launched work-quest id after a milestone accept

  const now = () => { try { if (typeof deps.now === 'function') return deps.now(); } catch (_) {} return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; };
  const ready = () => typeof Goals !== 'undefined' && state;

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function poke() { try { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('quests'); } catch (_) {} }

  // defensively rebuild the persisted slice — every goal + milestone re-validated, junk dropped (never a crash).
  function hydrate(raw) {
    const s = { v: 1, goals: [], offered: {} };
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.goals)) {
        for (const g of raw.goals) {
          if (!g || typeof g !== 'object' || !g.id) continue;
          const created = Number(g.createdAt);
          if (!Number.isFinite(created)) continue;
          const ms = Array.isArray(g.milestones) ? g.milestones.map(m => ({
            id: String((m && m.id) || ''),
            text: String((m && m.text) || '').slice(0, 140),
            status: (m && m.status === 'done') ? 'done' : 'open',
            questRef: (m && m.questRef != null) ? String(m.questRef) : null,
            evidence: String((m && m.evidence) || '').slice(0, 160),
            doneAt: (m && Number.isFinite(Number(m.doneAt))) ? Number(m.doneAt) : null
          })).filter(m => m.id) : [];
          if (!ms.length) continue;
          const status = (g.status === 'done' || g.status === 'retired') ? g.status : 'active';
          s.goals.push({
            id: String(g.id), text: String(g.text || '').slice(0, 280),
            sourceBeliefId: g.sourceBeliefId == null ? null : String(g.sourceBeliefId),
            status, milestones: ms, createdAt: created,
            updatedAt: Number.isFinite(Number(g.updatedAt)) ? Number(g.updatedAt) : created
          });
        }
      }
      if (raw.offered && typeof raw.offered === 'object') for (const k in raw.offered) if (raw.offered[k]) s.offered[String(k)] = 1;
    }
    s.goals.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    while (s.goals.length > GOAL_CAP) s.goals.shift();
    return s;
  }

  // a stable fingerprint of a goals belief (its id + significant text tokens) — so a not-now decision re-offers
  // ONLY when the belief genuinely CHANGES (new id, or the text was edited), never on every idle tick.
  function beliefFingerprint(b) {
    if (!b) return '';
    const toks = String(b.text == null ? '' : b.text).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return String(b.id || '') + '|' + Array.from(new Set(toks)).sort().join(' ');
  }

  // the live goals-dim beliefs (the decomposition source). [] when the dossier is absent/cold.
  function goalsBeliefs() {
    try {
      if (typeof DossierStore !== 'undefined' && DossierStore.beliefs) { const arr = DossierStore.beliefs('goals'); return Array.isArray(arr) ? arr : []; }
    } catch (_) {}
    return [];
  }

  // mirror the ACTIVE goal to the sidecar (fire-and-forget) so server-composed cron runs can see the current path.
  // Mirrors DossierStore.pushToSidecar exactly: a plain POST, a no-op if unreachable. Only the active goal's text +
  // progress + next step travel (a compact, cron-useful summary — never the whole history).
  function pushToSidecar() {
    if (!ready() || typeof fetch !== 'function') return;
    try {
      const g = Goals.activeGoal(state.goals);
      let payload = null;
      if (g) {
        const pr = Goals.progress(g);
        const next = Goals.nextMilestone(g);
        payload = { text: g.text, done: pr.done, total: pr.total, pct: pr.pct, next: next ? next.text : null };
      }
      fetch('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: payload }) }).catch(() => {});
    } catch (_) {}
  }

  /* ---------- THE DECOMPOSITION FLOW ---------- */
  // is there a goals belief with NO goal tree yet, whose decomposition we haven't already offered for THIS belief
  // state? Returns the belief to decompose, or null. Re-offer discipline: an offered/declined belief re-surfaces
  // only when its fingerprint changes (never nags). A belief already bound to an active/done goal is skipped.
  function pendingDecomposition() {
    if (!ready()) return null;
    const beliefs = goalsBeliefs();
    if (!beliefs.length) return null;
    for (const b of beliefs) {
      if (!b || !b.id || !b.text) continue;
      // already has a goal tree (active or done — a shipped goal isn't re-decomposed; a retired one may re-offer)?
      const has = state.goals.some(g => g.sourceBeliefId === String(b.id) && (g.status === 'active' || g.status === 'done'));
      if (has) continue;
      const fp = beliefFingerprint(b);
      if (state.offered[fp]) continue;   // offered/declined for this exact belief state — wait for a change
      return b;
    }
    return null;
  }
  // whether an arc confirm beat is worth ATTEMPTING now (chat.js gates the actual slot). Pure read: a pending
  // belief exists, we're not mid-flight, and the model path is reachable.
  function willOfferDecomposition() {
    if (!ready() || firing) return false;
    if (typeof Harness === 'undefined' || !Harness.chat) return false;
    return !!pendingDecomposition();
  }

  // run the decomposition directive → parse → return { belief, texts } (the proposed path) or null. Awaitable so
  // the test can drive it. Fail-open: a model hiccup / unparseable / under-3-milestone reply yields null and marks
  // NOTHING offered (so a later, better reply can still land) — EXCEPT we DO mark offered when the model gave a
  // usable-but-declined path (handled in the confirm side). Redaction rides via the injected redact dep.
  async function proposeDecomposition() {
    if (!ready() || firing) return null;
    if (typeof Harness === 'undefined' || !Harness.chat) return null;
    const belief = pendingDecomposition();
    if (!belief) return null;
    try {
      const directive = Goals.buildDirective(belief.text);
      const system = deps.getSystem ? deps.getSystem() : '';
      const res = await Harness.chat({ system, messages: [{ role: 'user', content: directive }], agentId: 'agent', isTask: false, placed: [], internal: true });
      if (!res || res.error) return null;
      const texts = Goals.parseDecomposition(res.text, { redact: deps.redact });
      if (!texts.length) return null;   // under-decomposed / unusable — leave un-offered so a later belief change retries
      return { belief, texts };
    } catch (_) { return null; }
  }

  // CONFIRM a decomposition: persist the goal tree from the (possibly edited) milestone texts, bound to the belief.
  // Returns the new goal node (or null on a too-short/invalid path). Marks the belief offered (so it never re-offers
  // for THIS belief state) and mirrors to the sidecar. The caller (chat.js confirm panel) calls this on "Confirm".
  function confirm(belief, texts) {
    if (!ready() || !belief) return null;
    const goal = Goals.makeGoal(belief.text, texts, belief.id, now());
    if (!goal) { markOffered(belief); return null; }   // an edited-down-to-nothing path still counts as offered (don't loop)
    state.goals.push(goal);
    while (state.goals.length > GOAL_CAP) state.goals.shift();
    markOffered(belief);
    save(); pushToSidecar(); poke();
    return goal;
  }
  // NOT-NOW: mark this belief state offered so it re-surfaces only after the belief changes (never nags). The
  // Commander can still return to the arc anytime; this just stops the proactive confirm beat for this belief.
  function declineDecomposition(belief) { if (ready() && belief) { markOffered(belief); save(); } }
  function markOffered(belief) { const fp = beliefFingerprint(belief); if (fp) state.offered[fp] = 1; }

  /* ---------- THE MILESTONE → WORK-QUEST BINDING ---------- */
  // accept the next milestone of the active goal as a real build: route it through the EXISTING work-quest path so
  // completing the real work completes the milestone. Returns the milestone accepted (or null). The store arms a
  // short window to claim the work-quest id WorkQuestStore mints (mirrors WorkQuestStore's own run-arm idiom).
  function acceptMilestone(goalId, milestoneId) {
    if (!ready()) return null;
    const goal = state.goals.find(g => g.id === goalId && g.status === 'active');
    if (!goal) return null;
    const m = goal.milestones.find(x => x && x.id === milestoneId && x.status === 'open');
    if (!m) return null;
    const next = Goals.nextMilestone(goal);
    if (!next || next.id !== m.id) return null;   // only the CURRENT front milestone is acceptable (honest chaining)
    // route through the work-quest path as a workflow build (the milestone text IS the directive). WorkQuestStore
    // mints a trackable build + returns its id; bind that id to the milestone so its completion folds the milestone.
    let wqId = null;
    try {
      if (typeof WorkQuestStore !== 'undefined' && WorkQuestStore.accept) {
        wqId = WorkQuestStore.accept({ title: m.text, build: { kind: 'workflow', recipeId: null } });
      }
    } catch (_) {}
    if (wqId) { Goals.bindMilestoneQuest(goal, m.id, wqId); arming = null; boundQuests[String(wqId)] = { goalId: goal.id, milestoneId: m.id }; }
    else { arming = { goalId: goal.id, milestoneId: m.id }; }   // no id yet → claim the next launched work quest
    save();
    // fire the real run for this milestone (the no-dead-gap promise) — the same launch path the pitch build uses.
    try { if (deps.launchDirective) deps.launchDirective("Let's work toward: " + m.text); } catch (_) {}
    return m;
  }

  /* ---------- CHAINING + EVIDENCE (the honesty core) ---------- */
  // after a clean run, re-read WorkQuestStore's projection: any bound milestone whose work quest went DONE folds
  // the milestone done, writes the run-summary evidence, advances the bar, and — on the last one — completes the
  // goal. Only REAL completed work moves the bar (never a manual tick). Fail-open + idempotent.
  function reconcile(runSummary) {
    if (!ready()) return;
    let doneWq = null;
    try {
      if (typeof WorkQuestStore !== 'undefined' && WorkQuestStore.quests) {
        const wq = WorkQuestStore.quests() || [];
        doneWq = {};
        for (const q of wq) if (q && q.id && q.status === 'done') doneWq[String(q.id)] = true;
      }
    } catch (_) { doneWq = null; }
    if (!doneWq) return;
    let changed = false, anyGoalDone = false;
    for (const g of state.goals) {
      if (g.status !== 'active' || !Array.isArray(g.milestones)) continue;
      for (const m of g.milestones) {
        if (!m || m.status !== 'open' || !m.questRef) continue;
        if (!doneWq[String(m.questRef)]) continue;
        const ev = clipEvidence(runSummary, m.text);
        const r = Goals.foldMilestoneDone(g, m.id, ev, now());
        if (r.changed) { changed = true; if (r.goalDone) anyGoalDone = true; bumpStudySalience(g, m); }
      }
    }
    if (changed) { save(); pushToSidecar(); poke(); }
    if (anyGoalDone) celebrateGoalDone();
  }
  // a goal completing (all milestones done): the whole-arc celebration — sound + a gold toast (a MOMENT, never a
  // beat-slot ask; mirrors queststatestore.celebrate) — plus the suggestion-gate bump (§5). The per-milestone
  // step edges already celebrate via QuestState; this is the capstone for the goal itself.
  function celebrateGoalDone() {
    try { if (typeof SFX === 'object' && SFX.quest) SFX.quest(); } catch (_) {}
    try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('◆ goal reached — every milestone shipped.', 'gold'); } catch (_) {}
    noteGoalDone();
  }
  // the evidence line folded onto a completed milestone: prefer a real run summary, else name the milestone.
  function clipEvidence(runSummary, milestoneText) {
    const s = String(runSummary == null ? '' : runSummary).trim();
    if (s) return ('done via: ' + s).slice(0, 160);
    return ('completed: ' + String(milestoneText || '')).slice(0, 160);
  }
  // FEEDBACK LOOP (§5): a milestone completing is a goal-progress note the Tier 1 Study engine can weight. Additive
  // + fail-open — a missing hook is a silent no-op; it never blocks the fold. Uses StudyStore's optional salience
  // hook when present (Tier 1 may or may not expose it), so this store degrades cleanly on an older bundle.
  function bumpStudySalience(goal, milestone) {
    try {
      if (typeof StudyStore !== 'undefined' && typeof StudyStore.noteGoalProgress === 'function') {
        StudyStore.noteGoalProgress({ goalText: goal.text, milestoneText: milestone.text });
      }
    } catch (_) {}
  }
  // a goal completing bumps the suggestion gate too (§5): SuggestStore may fire on goal-progress, not only
  // familiarity growth. Additive OR — a missing hook is a no-op; existing caps/gates are untouched.
  function noteGoalDone() {
    try { if (typeof SuggestStore !== 'undefined' && typeof SuggestStore.noteGoalProgress === 'function') SuggestStore.noteGoalProgress(); } catch (_) {}
  }

  /* ---------- DRIFT: retire a goal whose source belief the Study engine forgot ---------- */
  // if the dossier no longer holds a goal's source belief (a study RETIRE landed), retire the tree. Kept for
  // history, hidden from the active quest log. Only ACTIVE goals retire (a done goal stays a trophy).
  function syncDrift() {
    if (!ready()) return false;
    const liveIds = new Set(goalsBeliefs().map(b => b && b.id ? String(b.id) : '').filter(Boolean));
    let changed = false;
    for (const g of state.goals) {
      if (g.status !== 'active' || g.sourceBeliefId == null) continue;
      if (!liveIds.has(String(g.sourceBeliefId))) { if (Goals.retireBySource(g, g.sourceBeliefId, now())) changed = true; }
    }
    if (changed) { save(); pushToSidecar(); poke(); }
    return changed;
  }

  /* ---------- lifecycle + bus ---------- */
  const ARM_MS = 8000;
  function onRunStart(p) {
    // claim the launched work-quest id for a just-accepted milestone (WorkQuestStore.accept returned no id
    // synchronously in the launch-first path). We can't read the wq id from the run start, so we let
    // WorkQuestStore own the run binding; the milestone's questRef is set at accept time when the id was returned.
    // This hook exists only to expire a stale arm window.
    if (arming && (now() - (arming.at || 0)) > ARM_MS) arming = null;
  }
  function onRunEnd(p) {
    if (!ready() || !p) return;
    if (p.reason !== 'done') { return; }             // only a clean run advances the bar / retires on drift
    if ((p.agentId || 'agent') !== 'agent') return;  // hero runs only (a summoned worker never moves the arc)
    // a summary line for the evidence: the ended run's recorded title, if the app injects one.
    let summary = '';
    try { summary = (typeof deps.getRunSummary === 'function') ? String(deps.getRunSummary(p.runId || p.id) || '') : ''; } catch (_) {}
    syncDrift();
    reconcile(summary);
  }
  function bind() {
    if (bound) return;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) {
      U.bus.on('agent.run.start', onRunStart);   // subscription only — NEVER an emit
      U.bus.on('agent.run.end', onRunEnd);
      bound = true;
    }
  }
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    firing = false; arming = null;
    for (const k in boundQuests) delete boundQuests[k];
    bind();
    pushToSidecar();
  }
  // a brand-new hero starts with no goals (own key; Save.clear only wipes the main envelope — mirrors the siblings).
  function reset() { state = hydrate(null); firing = false; arming = null; for (const k in boundQuests) delete boundQuests[k]; try { localStorage.removeItem(KEY); } catch (_) {} pushToSidecar(); }

  // re-read on the quest-log heartbeat: retire drift + reconcile completed work before the fold (like the sibling
  // sync()s buildQuests calls). Cheap + idempotent.
  function sync() { if (!ready()) return; syncDrift(); reconcile(''); }

  /* ---------- the projection consumed by QuestStore.view ---------- */
  function quests() { return ready() ? Goals.project(state.goals) : []; }
  function activeGoal() { return ready() ? Goals.activeGoal(state.goals) : null; }

  // re-entrancy handle for the confirm flow (chat.js latches it around the focused Dialogue panel).
  function setFiring(v) { firing = !!v; }
  function isFiring() { return firing; }

  return {
    init, reset, sync, quests, activeGoal, pushToSidecar,
    willOfferDecomposition, pendingDecomposition, proposeDecomposition, confirm, declineDecomposition,
    acceptMilestone, reconcile, syncDrift, setFiring, isFiring, beliefFingerprint,
    _state: () => state, _onRunEnd: onRunEnd
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { GoalStore };
