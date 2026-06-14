/* SKYNET — save.js : local persistence for the agent + session.
   A VERSIONED envelope so saves survive future changes. localStorage for now;
   the same shape + migration ladder moves to the SQLite sidecar later. */
'use strict';

const Save = (() => {
  const KEY = 'skynet.save';
  const CURRENT = 2;

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

  function write(state) {
    const doc = Object.assign({ schema: 'skynet.save', version: CURRENT, updatedAt: Date.now() }, state);
    try { localStorage.setItem(KEY, JSON.stringify(doc)); return true; }
    catch (e) { console.warn('[save] write failed:', e); return false; }
  }

  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }
  function has() { try { return !!localStorage.getItem(KEY); } catch (e) { return false; } }

  return { load, write, clear, has, CURRENT };
})();
