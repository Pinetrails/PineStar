/* SKYNET — xpstore.js : the live wiring that turns REAL harness events into agent + station growth.

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

  // which REAL events feed growth in this first slice. The engine handles more (tool_result,
  // memory.write, workitem.delivered, channel.delivery); we start narrow + honest and widen later.
  const FEED = ['agent.run.end', 'memory.used'];

  const MILESTONE_TEXT = {
    first_light: 'Milestone — first task shipped',
    pack_rat: 'Milestone — first memory reused',
    centurion: 'Milestone — 100 tasks shipped',
    trusted: 'Milestone — reliability reached TRUSTED',
  };

  function pushToWorld(a) {
    if (typeof World === 'undefined' || !World.setXp || typeof Xp === 'undefined') return;
    World.setXp(a && a.stats ? Xp.compute(a.stats) : null, station ? Xp.compute(station) : null);
  }

  function celebrateAgent(a, level) {
    if (typeof World !== 'undefined' && World.pulseLevelUp) World.pulseLevelUp();
    if (typeof SFX !== 'undefined' && SFX.level) { try { SFX.level(); } catch (_) {} }
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify((a.name || 'Agent') + ' reached Level ' + level, 'gold');
  }
  function celebrateStation(level) {
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

    if (ra.awards.levelUp) celebrateAgent(a, ra.awards.levelTo);
    for (const id of ra.awards.milestones) announceMilestone(id);   // agent-scoped milestones
    if (rs.awards.levelUp) celebrateStation(rs.awards.levelTo);

    if (ra.awards.xp || rs.awards.xp || ra.awards.levelUp) { try { persistFn(); } catch (_) {} }
  }

  function init(opts) {
    opts = opts || {};
    if (opts.getAgent) getAgent = opts.getAgent;
    if (opts.persist) persistFn = opts.persist;
    // resumed rollup from the save, else a fresh one
    station = (opts.station && typeof opts.station === 'object') ? opts.station : (station || (typeof Xp !== 'undefined' ? Xp.fresh() : null));
    const a = getAgent();
    if (a && !a.stats && typeof Xp !== 'undefined') a.stats = Xp.fresh();   // seed new OR migrated-but-empty agents
    pushToWorld(a);
    if (!wired && typeof U !== 'undefined' && U.bus) {
      for (const n of FEED) U.bus.on(n, p => { try { onEvent(n, p); } catch (e) { console.warn('[xp]', n, e); } });
      wired = true;
    }
  }

  // the station-wide rollup, included in the save envelope by App.persist()
  function stationStats() { return station; }

  return { init, stationStats, onEvent };
})();
