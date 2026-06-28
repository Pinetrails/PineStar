/* STARNET — save.js : local persistence for the agent + session.
   A VERSIONED envelope so saves survive future changes. localStorage for now;
   the same shape + migration ladder moves to the SQLite sidecar later. */
'use strict';

const Save = (() => {
  const KEY = 'starnet.save';
  const PRE_MIGRATE_BACKUP_KEY = 'starnet.save.pre-migrate.backup';
  const LEGACY_SCHEMA = 'skynet.save';   // Skynet→StarNet rename: saves written before the rename carry this schema tag (the
  const SCHEMA = 'starnet.save';         // legacymigrate boot pass copies the OLD `skynet.save` localStorage KEY forward; load() still accepts the old TAG inside the value).
  const CURRENT = 5;

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
    },
    // v3 -> v4 (personalization): seed an empty, valid user-affinity profile slice. Cold-start-safe —
    // a user who never finished the awakening still gets a learnable, all-zero profile. The literal
    // mirrors Profile.fresh() to keep save.js decoupled from profile.js load order.
    3: doc => {
      if (!doc.profile || typeof doc.profile !== 'object') doc.profile = { v: 1, tags: {}, seed: null, enabled: true, total: 0 };
      return doc;
    },
    // v4 -> v5 (Commander Dossier): seed an empty, valid station-wide dossier slice. Cold-start-safe — an
    // older save (or one whose owner never finished the awakening) gets a learnable, all-empty dossier; it
    // then seeds from the agent's onboarding docs at DossierStore.init. The literal mirrors Dossier.fresh()
    // to keep save.js decoupled from dossier.js load order.
    4: doc => {
      if (!doc.dossier || typeof doc.dossier !== 'object') doc.dossier = { v: 1, dims: { identity: [], stack: [], goals: [], style: [], standing_orders: [], pain: [], ambition: [] }, seededFrom: {}, updatedAt: 0 };
      return doc;
    }
  };

  function migrate(doc) {
    let v = doc.version || 0;
    while (v < CURRENT && migrations[v]) { doc = migrations[v](doc); v++; doc.version = v; }
    doc.version = CURRENT;
    return doc;
  }

  function backupBeforeMigrate(raw, doc) {
    try {
      const v = Number(doc && doc.version || 0);
      if (v >= CURRENT) return;
      if (!localStorage.getItem(PRE_MIGRATE_BACKUP_KEY)) localStorage.setItem(PRE_MIGRATE_BACKUP_KEY, raw);
    } catch (_) {}
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      let doc = JSON.parse(raw);
      if (!doc || (doc.schema !== SCHEMA && doc.schema !== LEGACY_SCHEMA) || !doc.agent) return null;
      backupBeforeMigrate(raw, doc);
      return migrate(doc);
    } catch (e) { console.warn('[save] load failed:', e); return null; }
  }

  // returns the persisted doc (so callers can mirror the EXACT envelope to the durable sidecar), or null on
  // failure. The doc carries a fresh updatedAt stamp, which the sidecar uses to reject stale write-throughs.
  function write(state) {
    const doc = Object.assign({ schema: SCHEMA, version: CURRENT, updatedAt: Date.now() }, state);
    try { localStorage.setItem(KEY, JSON.stringify(doc)); return doc; }
    catch (e) { console.warn('[save] write failed:', e); return null; }
  }

  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }
  function has() { try { return !!localStorage.getItem(KEY); } catch (e) { return false; } }

  return { load, write, clear, has, CURRENT, PRE_MIGRATE_BACKUP_KEY };
})();
