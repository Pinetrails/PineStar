/* SKYNET — save.js : local persistence for the agent + session.
   A VERSIONED envelope so saves survive future changes. localStorage for now;
   the same shape + migration ladder moves to the SQLite sidecar later. */
'use strict';

const Save = (() => {
  const KEY = 'skynet.save';
  const CURRENT = 1;

  // forward-only migrations: { fromVersion: (doc) => upgradedDoc }
  const migrations = {
    // 0: doc => ({ ...doc, /* future field */ }),
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
