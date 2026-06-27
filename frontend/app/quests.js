/* STARNET — quests.js : the PURE quest-skin engine. Dresses the station's EXISTING, honest progress as RPG
   quests — without inventing anything. It is a read PROJECTION over three real sources:
     • xp.js MILESTONES   — real achievements (tasks shipped, memories reused…); earned = a done quest.
     • the Commander dossier — each still-blank dimension is a "get to know you" quest; known = done.
     • a pending agent idea  — the First Pitch / an ongoing suggestion waiting = one actionable quest.

   THE LAW (inherited from xp.js): every quest cashes out in a REAL capability or outcome — never a fake XP
   currency — and the log NEVER gates anything. It reveals the order of progress; it does not withhold. So an
   "open" quest is always something the Commander can just do now; nothing is locked behind a level.

   PURE + node-testable (a `Quests` global in the browser, module.exports under node). No Date.now / Math.random:
   the quest list is a deterministic function of the live state the store passes in. The browser wiring (the
   quest-log panel) reads DossierStore / XpStore / SuggestStore, calls build(), and renders — it owns nothing here. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Quests = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // build the ordered quest list. input:
  //   milestones  — Xp.milestones(stats) → [{ id, label, hint, earned }]
  //   dossierDims — [{ key, label, known }] (the store joins Dossier.DIMS with DossierStore.summary())
  //   pendingIdea — true when the agent has a tailored build waiting (SuggestStore.willSuggest() / a First Pitch due)
  // OPEN quests (actionable now) come first, then DONE (the trophy shelf). Each quest names its REAL reward.
  function build(input) {
    input = input || {};
    const milestones = Array.isArray(input.milestones) ? input.milestones : [];
    const dims = Array.isArray(input.dossierDims) ? input.dossierDims : [];
    const open = [], done = [];

    // 1) a waiting idea — the single most actionable thing (only ever open).
    if (input.pendingIdea) {
      open.push({ id: 'idea', kind: 'idea', title: 'An idea is waiting', desc: 'your agent has a tailored build to suggest — open COMMS to hear it.', reward: 'a real, working build', status: 'open' });
    }

    // 2) get-to-know-you quests — one per dossier dimension.
    for (const d of dims) {
      if (!d || !d.key) continue;   // a dimension needs a real key — no key, no quest (never a 'dim:null')
      const label = String(d.label || d.key).trim();
      if (!label) continue;
      const q = { id: 'dim:' + d.key, kind: 'dossier', title: 'Tell the station your ' + label.toLowerCase(), desc: 'every agent on the station will know this about you.', reward: 'sharper, personalized agents', status: d.known ? 'done' : 'open' };
      (d.known ? done : open).push(q);
    }

    // 3) milestone quests — real outcomes; the hint is how to earn an unearned one.
    for (const m of milestones) {
      if (!m || !m.id) continue;
      const q = { id: 'ms:' + m.id, kind: 'milestone', title: String(m.label || m.id), desc: m.earned ? 'earned' : ('how: ' + String(m.hint || '')), reward: 'recognition for real work shipped', status: m.earned ? 'done' : 'open' };
      (m.earned ? done : open).push(q);
    }

    return open.concat(done);
  }

  // counts for the panel header / a soft badge: how many quests are open vs done.
  function summary(list) {
    const arr = Array.isArray(list) ? list : [];
    let open = 0, done = 0;
    for (const q of arr) { if (q && q.status === 'done') done++; else if (q) open++; }
    return { open, done, total: open + done };   // total counts only real quests, so open + done === total always holds
  }

  return { build, summary };
});
