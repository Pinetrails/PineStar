/* STARNET — xpstore.js : the live wiring that turns REAL harness events into agent + station growth.

   Subscribes (read-only) to the U.bus event spine — every harness event is already re-emitted there
   by harness.js — runs each outcome through the pure Xp engine, mutates the persisted agent.stats and
   the station rollup, saves, and fires the in-world celebration (a gold level-up pulse + a dossier toast).

   It NEVER emits a bus event: the frozen shared/events.js contract is owned elsewhere and stays untouched.
   Celebration is a direct call into World + StationUI, so the lint-emits gate has nothing to catch. */
'use strict';
const XpStore = (() => {
  let getAgent = () => null;
  let allAgents = null;          // S4: every agent whose trophy case needs reconciling at boot (optional)
  let station = null;            // the station-wide rollup stats (same shape as an agent's .stats)
  let persistFn = () => {};
  let credentialFn = () => {};   // S3: fired ONLY when an agent's coarse track record actually changes
  let wired = false;

  // the real events that feed growth. Only explicit turn-in memory.feedback mints XP; operational events
  // update counters/milestones so the dossier still shows shipped work without leveling from chatter.
  const FEED = ['agent.run.end', 'agent.tool_result', 'memory.write', 'memory.used', 'memory.feedback', 'workitem.delivered', 'channel.delivery'];

  // the announce sentence per badge. Kept complete on purpose: an id with no entry used to fall through to the
  // raw slug, so ARCHIVIST/WORKHORSE/NIGHT SHIFT/VETERAN really did toast "Milestone — night_shift" at the
  // Commander. milestoneLabel() below is the backstop for anything added to the catalogue later.
  const MILESTONE_TEXT = {
    first_light: 'Milestone — first task shipped',
    still_here: 'Milestone — 5 tasks shipped',
    approved: 'Milestone — first positive feedback',
    pack_rat: 'Milestone — first memory reused',
    long_memory: 'Milestone — 10 memories reused',
    archivist: 'Milestone — 10 memories saved',
    hands_on: 'Milestone — 25 successful tool calls',
    workhorse: 'Milestone — 25 tasks shipped',
    centurion: 'Milestone — 100 tasks shipped',
    night_shift: 'Milestone — first external delivery',
    trusted: 'Milestone — satisfaction reached TRUSTED',
    dependable: 'Milestone — finish rate reached DEPENDABLE',
    seasoned: 'Milestone — reached Level 5',
    veteran: 'Milestone — reached Level 10',
  };

  function eventAgentId(payload) {
    const id = payload && typeof payload.agentId === 'string' ? payload.agentId.trim() : '';
    return id || 'agent';
  }

  function isSatisfactionFeedback(name, payload) {
    if (name !== 'memory.feedback' || typeof Xp === 'undefined' || !Xp.scoreEvent) return false;
    const sc = Xp.scoreEvent(name, payload || {});
    return !!(sc && sc.quality !== null && sc.quality !== undefined);
  }

  function resolveAgent(agentId) {
    let a = null;
    try { a = getAgent(agentId); } catch (_) { a = null; }
    if (!a && agentId === 'agent') { try { a = getAgent(); } catch (_) {} }   // back-compat for old no-arg callers
    return a || null;
  }

  function pushToWorld(a) {
    if (typeof World === 'undefined' || !World.setXp || typeof Xp === 'undefined') return;
    World.setXp(a && a.id ? a.id : 'agent', a && a.stats ? Xp.compute(a.stats) : null);   // station headline now rides the top-bar chip (pushTopbar)
  }

  // the always-on STATION level chip in the top bar — the colony's headline number.
  function pushTopbar() {
    if (typeof Xp === 'undefined' || !station) return;
    const el = document.getElementById('gt-station');
    if (el) el.textContent = 'Lv ' + Xp.compute(station).level;
  }

  function celebrateAgent(a, level) {
    if (typeof World !== 'undefined' && World.pulseLevelUp) World.pulseLevelUp(a && a.id ? a.id : 'agent', level);
    if (typeof SFX !== 'undefined' && SFX.level) { try { SFX.level(); } catch (_) {} }
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify((a.name || 'Agent') + ' reached Level ' + level, 'gold');
    // COMMS: a terse ambient station broadcast — the codename tinted with the agent's suit colour (the one
    // established colour exception). Not a beat-slot card; coalesced + in-game-gated inside Chat.broadcast.
    if (typeof Chat !== 'undefined' && Chat.broadcast) {
      const nm = String((a && a.name) || 'AGENT').toUpperCase();
      try { Chat.broadcast(nm + ' REACHED LEVEL ' + level, { highlight: nm, tint: (a && a.color) || null }); } catch (_) {}
    }
    if (typeof Tutorial !== 'undefined' && Tutorial.onLevelUp) Tutorial.onLevelUp(level);   // first-touch coachmark: what leveling means
  }
  function celebrateStation(level) {
    pushTopbar();
    const chip = document.getElementById('tb-station');   // gold pulse on the top-bar STATION chip
    if (chip) { chip.classList.remove('lvup'); void chip.offsetWidth; chip.classList.add('lvup'); }
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('STATION advanced to Level ' + level, 'gold');
  }
  // a milestone's short trophy title for the broadcast (the notify text carries the fuller sentence). Read from
  // the xp.js catalogue rather than a second hand-kept map: the labels ARE the trophy-case labels, so the badge
  // the Commander sees lit and the name the broadcast shouts cannot drift apart. Slug-case is the last resort.
  function milestoneLabel(id) {
    if (typeof Xp !== 'undefined' && Array.isArray(Xp.MILESTONES)) {
      const m = Xp.MILESTONES.find(x => x && x.id === id);
      if (m && m.label) return String(m.label);
    }
    return String(id || '').toUpperCase().replace(/_/g, ' ');
  }
  function announceMilestone(id) {
    // G3a: a milestone lands with its own sting — grander than a quest, smaller than a level-up (was mute).
    if (typeof SFX !== 'undefined' && SFX.milestone) { try { SFX.milestone(); } catch (_) {} }
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(MILESTONE_TEXT[id] || ('Milestone — ' + milestoneLabel(id)), 'gold');
    // COMMS: the trophy broadcast — rarer than a level, so the brighter gold treatment.
    if (typeof Chat !== 'undefined' && Chat.broadcast) {
      const nm = milestoneLabel(id);
      try { Chat.broadcast('TROPHY EARNED · ' + nm, { highlight: nm, tone: 'gold' }); } catch (_) {}
    }
  }

  // fold one real event into BOTH the agent's stats and the station rollup (same engine, same path).
  function onEvent(name, payload) {
    const agentId = eventAgentId(payload);
    const a = resolveAgent(agentId);
    if (!a || typeof Xp === 'undefined') return;
    if (!a.stats) a.stats = Xp.fresh();
    if (!station) station = Xp.fresh();
    const ev = { name, payload: payload || {} };

    /* S3 — republish the roster ONLY when this agent's COARSE credential moves (a tier crossing or a band
       flip), never on every XP tick. Xp.credential is quantized precisely so this key is stable across the
       hundreds of ordinary events a working agent emits; without the before/after comparison this would fire
       a full /api/roster POST (every agent's whole composed system prompt) on every single run. */
    const credBefore = (Xp.credential && a.stats) ? Xp.credential(a.stats).key : '';
    const ra = Xp.applyEvent(a.stats, ev); a.stats = ra.stats;
    const rs = Xp.applyEvent(station, ev); station = rs.stats;
    if (Xp.credential) {
      const credAfter = Xp.credential(a.stats).key;
      if (credAfter !== credBefore) { try { credentialFn(a.id || agentId, credAfter); } catch (_) {} }
    }

    pushToWorld(a);
    pushTopbar();

    if (ra.awards.levelUp) celebrateAgent(a, ra.awards.levelTo);
    for (const id of ra.awards.milestones) announceMilestone(id);   // agent-scoped milestones
    if (rs.awards.levelUp) celebrateStation(rs.awards.levelTo);

    // persist at run end (captures counters) and on explicit user turn-in feedback/level-up/milestone. Feedback can
    // arrive after the run stream has closed, so it must persist on its own even when it does not level up.
    if (name === 'agent.run.end' || isSatisfactionFeedback(name, payload) || ra.awards.levelUp || rs.awards.levelUp || ra.awards.milestones.length || rs.awards.milestones.length) { try { persistFn(); } catch (_) {} }
  }

  /* S4 — BACKFILL the trophy case at boot. A save written before a badge existed already holds the record that
     earns it, so without this the case shows a locked badge whose unlock hint the dossier above it has visibly
     already met. Silent by design (Xp.reconcile's `earned` list is deliberately not announced): these are past
     facts being recognized, not moments — announcing would fire a burst of gold TROPHY EARNED broadcasts at
     boot for work done weeks ago. No persist here either; the reconciled stats ride the next ordinary save,
     and the call is idempotent, so a boot that never saves simply reconciles again next time. */
  function reconcileTrophies() {
    if (typeof Xp === 'undefined' || !Xp.reconcile) return;
    let list = [];
    try { list = (allAgents ? allAgents() : null) || []; } catch (_) { list = []; }
    if (!list.length) { const hero = resolveAgent('agent'); if (hero) list = [hero]; }   // no roster hook → at least the hero
    for (const ag of list) { if (ag && ag.stats) { try { ag.stats = Xp.reconcile(ag.stats).stats; } catch (_) {} } }
    if (station) { try { station = Xp.reconcile(station).stats; } catch (_) {} }
  }

  function init(opts) {
    opts = opts || {};
    if (opts.getAgent) getAgent = opts.getAgent;
    if (opts.agents) allAgents = opts.agents;                  // S4: the whole registry, so a specialist's case is reconciled too
    if (opts.persist) persistFn = opts.persist;
    if (opts.onCredential) credentialFn = opts.onCredential;   // S3: app.js re-pushes the roster so the dispatch briefing stays true
    // resumed rollup from the save, else a fresh one. NB: fall back to fresh (not the prior in-memory
    // station) so creating a NEW agent mid-session doesn't inherit the previous colony's XP.
    station = (opts.station && typeof opts.station === 'object') ? opts.station : (typeof Xp !== 'undefined' ? Xp.fresh() : null);
    const a = resolveAgent('agent');
    if (a && !a.stats && typeof Xp !== 'undefined') a.stats = Xp.fresh();   // seed new OR migrated-but-empty agents
    reconcileTrophies();   // …then light whatever the record already earned, before anything renders it
    pushToWorld(a);
    pushTopbar();
    if (!wired && typeof U !== 'undefined' && U.bus) {
      for (const n of FEED) U.bus.on(n, p => { try { onEvent(n, p); } catch (e) { console.warn('[xp]', n, e); } });
      wired = true;
    }
  }

  // the station-wide rollup, included in the save envelope by App.persist()
  function stationStats() { return station; }

  return { init, stationStats, onEvent };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { XpStore };
