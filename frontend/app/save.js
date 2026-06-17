/* SKYNET — save.js : local persistence for the agent + session.
   A VERSIONED envelope so saves survive future changes. localStorage for now;
   the same shape + migration ladder moves to the SQLite sidecar later. */
'use strict';

const Save = (() => {
  const KEY = 'skynet.save';
  const CURRENT = 3;

  // forward-only migrations: { fromVersion: (doc) => upgradedDoc }
  const migrations = {
    // v1 (one agent + one flat history) -> v2 (Workstreams): fold the whole conversation into a
    // single "General" stream (cost seeded from lifetime usage so nothing looks invented); agent +
    // lifetime usage stay at the envelope root. Delegates to the unit-tested pure migrator.
    1: doc => {
      const slice = (typeof Workstreams !== 'undefined')
        ? Workstreams.migrateV1(doc)
        : { workstreams: [], activeId: null, generalId: null };
      return { agent: doc.agent, usage: doc.usage, workstreams: slice.workstreams, activeId: slice.activeId, generalId: slice.generalId };
    },
    // v2 -> v3 (agent growth): seed the XP/level/confidence stats on the agent + a station-wide rollup.
    // Honest cold-start: fresh meters (confidence shows "calibrating" until real outcomes arrive). The
    // literal keeps save.js decoupled from xp.js load order; it mirrors Xp.fresh() exactly.
    2: doc => {
      const fresh = () => ({ xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: {}, milestones: [] });
      if (doc.agent && typeof doc.agent === 'object' && (!doc.agent.stats || typeof doc.agent.stats !== 'object')) doc.agent.stats = fresh();
      if (!doc.stationStats || typeof doc.stationStats !== 'object') doc.stationStats = fresh();
      return doc;
    }
  };

  function migrate(doc) {
    let v = doc.version || 0;
    while (v < CURRENT && migrations[v]) { doc = migrations[v](doc); v++; doc.version = v; }
    doc.version = CURRENT;
    return doc;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      let doc = JSON.parse(raw);
      if (!doc || doc.schema !== 'skynet.save' || !doc.agent) return null;
      return migrate(doc);
    } catch (e) { console.warn('[save] load failed:', e); return null; }
  }

  // returns the persisted doc (so callers can mirror the EXACT envelope to the durable sidecar), or null on
  // failure. The doc carries a fresh updatedAt stamp, which the sidecar uses to reject stale write-throughs.
  function write(state) {
    const doc = Object.assign({ schema: 'skynet.save', version: CURRENT, updatedAt: Date.now() }, state);
    try { localStorage.setItem(KEY, JSON.stringify(doc)); return doc; }
    catch (e) { console.warn('[save] write failed:', e); return null; }
  }

  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }
  function has() { try { return !!localStorage.getItem(KEY); } catch (e) { return false; } }

  return { load, write, clear, has, CURRENT };
})();
