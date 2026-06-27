/* STARNET — queststore.js : the thin, STATELESS read-join behind the QUEST LOG panel.

   No state, no persistence, no bus subscription — it just gathers the live, honest progress the station
   already tracks and hands it to the pure Quests engine:
     • the STATION xp rollup (XpStore.stationStats → Xp.compute meter + Xp.milestones) — real achievements,
     • the Commander dossier's known/blank dimensions (DossierStore) — get-to-know-you quests,
     • whether a tailored idea is currently due (SuggestStore.willSuggest) — one actionable quest.

   A projection, not an owner (mirrors the dossierstore read-surface idiom). NEVER emits on U.bus. Every read
   is guarded so a missing subsystem degrades to "fewer quests", never a crash. node-exportable for its test. */
'use strict';
const QuestStore = (() => {
  function gather() {
    const sStats = (typeof XpStore !== 'undefined' && XpStore.stationStats) ? XpStore.stationStats() : null;
    const meter = (typeof Xp !== 'undefined' && sStats) ? Xp.compute(sStats) : null;
    const milestones = (typeof Xp !== 'undefined' && sStats) ? Xp.milestones(sStats) : [];
    const sum = (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null;
    const dimDefs = (typeof DossierStore !== 'undefined' && DossierStore.dims) ? DossierStore.dims() : [];
    const known = (sum && Array.isArray(sum.known)) ? sum.known : [];
    const dossierDims = (Array.isArray(dimDefs) ? dimDefs : []).map(d => ({ key: d.key, label: d.label, known: known.indexOf(d.key) >= 0 }));
    const pendingIdea = (typeof SuggestStore !== 'undefined' && SuggestStore.willSuggest) ? !!SuggestStore.willSuggest() : false;
    return { meter, milestones, dossierDims, pendingIdea };
  }

  // the whole panel read: the station meter + the ordered quest list + open/done counts.
  function view() {
    const g = gather();
    const quests = (typeof Quests !== 'undefined') ? Quests.build({ milestones: g.milestones, dossierDims: g.dossierDims, pendingIdea: g.pendingIdea }) : [];
    const summary = (typeof Quests !== 'undefined') ? Quests.summary(quests) : { open: 0, done: 0, total: 0 };
    return { meter: g.meter, quests: quests, summary: summary };
  }

  return { view };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { QuestStore };
