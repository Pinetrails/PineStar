/* STARNET — xpstore.js : the live wiring that turns REAL harness events into agent + station growth.

   Subscribes (read-only) to the U.bus event spine — every harness event is already re-emitted there
   by harness.js — runs each outcome through the pure Xp engine, mutates the persisted agent.stats and
   the station rollup, saves, and fires the in-world celebration (a gold level-up pulse + a dossier toast).

   It NEVER emits a bus event: the frozen shared/events.js contract is owned elsewhere and stays untouched.
   Celebration is a direct call into World + StationUI, so the lint-emits gate has nothing to catch. */
'use strict';
const XpStore = (() => {
  let getAgent = () => null;
  let station = null;            // the station-wide rollup stats (same shape as an agent's .stats)
  let persistFn = () => {};
  let wired = false;

  // the REAL outcomes that feed growth. run.end + channel.delivery + memory.feedback move CONFIDENCE
  // (reliability); the rest are XP-only (tool successes are per-run capped in the engine). All flow on U.bus.
  const FEED = ['agent.run.end', 'agent.tool_result', 'memory.write', 'memory.used', 'memory.feedback', 'workitem.delivered', 'channel.delivery'];

  const MILESTONE_TEXT = {
    first_light: 'Milestone — first task shipped',
    pack_rat: 'Milestone — first memory reused',
    centurion: 'Milestone — 100 tasks shipped',
    trusted: 'Milestone — reliability reached TRUSTED',
  };

  function pushToWorld(a) {
    if (typeof World === 'undefined' || !World.setXp || typeof Xp === 'undefined') return;
    World.setXp(a && a.stats ? Xp.compute(a.stats) : null);   // station headline now rides the top-bar chip (pushTopbar)
  }

  // the always-on STATION level chip in the top bar — the colony's headline number.
  function pushTopbar() {
    if (typeof Xp === 'undefined' || !station) return;
    const el = document.getElementById('gt-station');
    if (el) el.textContent = 'Lv ' + Xp.compute(station).level;
  }

  function celebrateAgent(a, level) {
    if (typeof World !== 'undefined' && World.pulseLevelUp) World.pulseLevelUp(level);
    if (typeof SFX !== 'undefined' && SFX.level) { try { SFX.level(); } catch (_) {} }
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify((a.name || 'Agent') + ' reached Level ' + level, 'gold');
    if (typeof Tutorial !== 'undefined' && Tutorial.onLevelUp) Tutorial.onLevelUp(level);   // first-touch coachmark: what leveling means
  }
  function celebrateStation(level) {
    pushTopbar();
    const chip = document.getElementById('tb-station');   // gold pulse on the top-bar STATION chip
    if (chip) { chip.classList.remove('lvup'); void chip.offsetWidth; chip.classList.add('lvup'); }
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('STATION advanced to Level ' + level, 'gold');
  }
  function announceMilestone(id) {
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(MILESTONE_TEXT[id] || ('Milestone — ' + id), 'gold');
  }

  // fold one real event into BOTH the agent's stats and the station rollup (same engine, same path).
  function onEvent(name, payload) {
    const a = getAgent();
    if (!a || typeof Xp === 'undefined') return;
    if (!a.stats) a.stats = Xp.fresh();
    if (!station) station = Xp.fresh();
    const ev = { name, payload: payload || {} };

    const ra = Xp.applyEvent(a.stats, ev); a.stats = ra.stats;
    const rs = Xp.applyEvent(station, ev); station = rs.stats;

    pushToWorld(a);
    pushTopbar();

    if (ra.awards.levelUp) celebrateAgent(a, ra.awards.levelTo);
    for (const id of ra.awards.milestones) announceMilestone(id);   // agent-scoped milestones
    if (rs.awards.levelUp) celebrateStation(rs.awards.levelTo);

    // persist at run end (captures the whole run's accrual) and on any level-up/milestone — not on every
    // mid-run tool tick (onTurn already saves per turn; this just avoids chatty writes).
    if (name === 'agent.run.end' || ra.awards.levelUp || rs.awards.levelUp || ra.awards.milestones.length || rs.awards.milestones.length) { try { persistFn(); } catch (_) {} }
  }

  function init(opts) {
    opts = opts || {};
    if (opts.getAgent) getAgent = opts.getAgent;
    if (opts.persist) persistFn = opts.persist;
    // resumed rollup from the save, else a fresh one. NB: fall back to fresh (not the prior in-memory
    // station) so creating a NEW agent mid-session doesn't inherit the previous colony's XP.
    station = (opts.station && typeof opts.station === 'object') ? opts.station : (typeof Xp !== 'undefined' ? Xp.fresh() : null);
    const a = getAgent();
    if (a && !a.stats && typeof Xp !== 'undefined') a.stats = Xp.fresh();   // seed new OR migrated-but-empty agents
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
