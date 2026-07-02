/* STARNET — queststate.js : the PURE durable-quest-memory engine behind the quest log.

   quests.js projects the CURRENT truth (open/done) and is deliberately stateless; this engine gives that
   projection a PAST. It folds successive projections into a small durable record:
     • firstSeenAt / completedAt per quest id — when a quest entered the log and when it REALLY finished
       (the future TROPHY CASE reads completedAt, so it is recorded from day one).
     • dismissal — the Commander waved a quest off. Dismissed = STOP FOREVER (the anti-nag law, same as
       curiosity questions): it never re-renders and never re-fires, even if the underlying thing later
       completes. Only suggestion-class quests are dismissible (dossier "get to know you" asks); milestones
       are achievements — an achievement can't nag, so it can't be dismissed.
     • completion detection = a STATUS DIFF between projections: a quest last seen open that is now done
       has genuinely completed (the real thing happened), and that edge is worth exactly one celebration.
       A quest FIRST seen already done is backfilled (completedAt recorded) but never celebrated — resuming
       a pre-G1a save must not fire a celebration storm for old history.

   THE LAW (inherited from xp.js): quests never mint XP. A completion pays out sound + toast + flourish
   (the store's job) — leveling stays locked to user feedback on real built work.

   PURE + node-testable (mirrors quests.js): no Date.now / Math.random — the caller injects the clock. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.QuestState = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fresh() { return { v: 1, seen: {}, dismissed: {} }; }

  // defensively rebuild a persisted slice: every entry re-validated, junk dropped (never a crash on a bad save).
  function hydrate(raw) {
    const s = fresh();
    if (!raw || typeof raw !== 'object') return s;
    const seen = (raw.seen && typeof raw.seen === 'object') ? raw.seen : {};
    for (const id of Object.keys(seen)) {
      const r = seen[id];
      if (!id || !r || typeof r !== 'object') continue;
      const first = Number(r.firstSeenAt);
      if (!Number.isFinite(first)) continue;
      const comp = Number(r.completedAt);
      s.seen[id] = {
        firstSeenAt: first,
        completedAt: Number.isFinite(comp) ? comp : null,
        lastStatus: r.lastStatus === 'done' ? 'done' : 'open'
      };
    }
    const dis = (raw.dismissed && typeof raw.dismissed === 'object') ? raw.dismissed : {};
    for (const id of Object.keys(dis)) {
      const t = Number(dis[id]);
      if (id && Number.isFinite(t)) s.dismissed[id] = t;
    }
    return s;
  }

  // which quests MAY be waved off: only the suggestion-class "get to know you" asks. Milestones are
  // achievements (they never nag, so hide-not-dismiss doesn't apply); the idea quest's cadence is owned
  // by SuggestStore in COMMS — dismissing it here would silently fight that store's own budget.
  function dismissible(q) { return !!(q && q.kind === 'dossier'); }

  // fold ONE projection into the state (in place, like Dossier.upsert). Returns the quests that made an
  // open→done transition THIS fold — the celebratable completions. First sight is baseline only:
  // a quest already done when first seen backfills completedAt and stays silent.
  function fold(state, quests, now) {
    const completions = [];
    if (!state || !state.seen) return { state, completions };
    const arr = Array.isArray(quests) ? quests : [];
    for (const q of arr) {
      if (!q || !q.id) continue;
      if (state.dismissed[q.id] != null) continue;   // dismissed = stop forever: no tracking, no celebration
      const status = q.status === 'done' ? 'done' : 'open';
      const rec = state.seen[q.id];
      if (!rec) {
        state.seen[q.id] = { firstSeenAt: now, completedAt: status === 'done' ? now : null, lastStatus: status };
        continue;
      }
      if (rec.lastStatus !== 'done' && status === 'done') { rec.completedAt = now; completions.push(q); }
      rec.lastStatus = status;   // done→open regressions (e.g. a forgotten belief) keep the LAST completedAt; a later re-completion is a genuinely new edge and celebrates again
    }
    return { state, completions };
  }

  // wave a quest off forever. Returns true only when the dismissal actually took (dismissible kind).
  function dismiss(state, quest, now) {
    if (!state || !state.dismissed || !quest || !quest.id || !dismissible(quest)) return false;
    if (state.dismissed[quest.id] != null) return false;   // already gone — idempotent
    state.dismissed[quest.id] = now;
    return true;
  }

  const isDismissed = (state, id) => !!(state && state.dismissed && id && state.dismissed[id] != null);

  // the render filter: a dismissed quest NEVER re-renders.
  function visible(state, quests) {
    const arr = Array.isArray(quests) ? quests : [];
    if (!state || !state.dismissed) return arr;
    return arr.filter(q => q && q.id && state.dismissed[q.id] == null);
  }

  // the per-quest durable record (or null): { firstSeenAt, completedAt, lastStatus, dismissedAt }.
  function stateOf(state, id) {
    if (!state || !id) return null;
    const rec = state.seen && state.seen[id];
    const dismissedAt = (state.dismissed && state.dismissed[id] != null) ? state.dismissed[id] : null;
    if (!rec && dismissedAt == null) return null;
    return {
      firstSeenAt: rec ? rec.firstSeenAt : null,
      completedAt: rec ? rec.completedAt : null,
      lastStatus: rec ? rec.lastStatus : null,
      dismissedAt: dismissedAt
    };
  }

  return { fresh, hydrate, fold, dismiss, dismissible, isDismissed, visible, stateOf };
});
