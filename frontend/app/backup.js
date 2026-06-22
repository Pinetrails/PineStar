/* SKYNET — backup.js : export/import the whole local agent as one portable JSON file.

   Browser localStorage is the FRAGILE store. A cache wipe, a different browser, or a different
   machine loses the agent the user built up — identity, XP/level/confidence, personalization
   (dossier docs + persona), workstreams (chat history) and the station layout all live in
   localStorage under the `skynet.*` keys. This module is the safety net: one click bundles EVERY
   skynet.* key plus a read-only snapshot of the agent's backend memory (notebook) into a
   downloadable file, and import restores the local half on any browser.

   v1 restores the browser-side state (which is what a wipe destroys). The notebook lives on the
   sidecar's own disk and is preserved IN the file for portability + a future restore route, but is
   not pushed back here — see docs note. Pure-ish: side effects are download + localStorage writes
   only; everything else returns plain summaries and never throws. */
'use strict';

const Backup = (() => {
  const SCHEMA = 'skynet.backup';
  const VERSION = 1;

  // every key we own lives under this prefix (skynet.save, skynet.specialties.v1, skynet.refit.seen,
  // theme/CRT prefs, ...). Capturing by prefix is future-proof: new keys ride along automatically
  // instead of needing this list kept in sync.
  const PREFIX = 'skynet.';

  function collectStore() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) out[k] = localStorage.getItem(k);
      }
    } catch (_) {}
    return out;
  }

  function agentName() {
    try {
      const doc = JSON.parse(localStorage.getItem('skynet.save') || 'null');
      return (doc && doc.agent && doc.agent.name) || 'agent';
    } catch (_) { return 'agent'; }
  }

  function slug(s) {
    return String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  }

  function stamp(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // pull the agent's backend memory so the file is COMPLETE (portable to a fresh machine). Best-effort:
  // if the sidecar is unreachable we still export the local state.
  async function snapshotNotebook() {
    try {
      if (typeof Harness === 'undefined' || !Harness.notebook) return null;
      const notes = await Harness.notebook('agent');
      return Array.isArray(notes) ? notes : null;
    } catch (_) { return null; }
  }

  async function build() {
    return {
      schema: SCHEMA, version: VERSION, app: 'skynet',
      exportedAt: Date.now(),
      agentName: agentName(),
      store: collectStore(),
      notebook: await snapshotNotebook()
    };
  }

  function triggerDownload(filename, text) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
      return true;
    } catch (e) { console.warn('[backup] download failed:', e); return false; }
  }

  async function exportAll() {
    const bundle = await build();
    const file = 'skynet-' + slug(bundle.agentName) + '-' + stamp(new Date()) + '.json';
    const ok = triggerDownload(file, JSON.stringify(bundle, null, 2));
    return { ok, file, keys: Object.keys(bundle.store).length, notes: bundle.notebook ? bundle.notebook.length : 0 };
  }

  // validate a parsed bundle WITHOUT mutating anything — callers decide whether to apply.
  function validate(doc) {
    if (!doc || typeof doc !== 'object') return 'not a JSON object';
    if (doc.schema !== SCHEMA) return 'not a STARNET backup file';
    if (!doc.store || typeof doc.store !== 'object') return 'backup has no data';
    if (typeof doc.store['skynet.save'] !== 'string') return 'backup has no agent';
    return null;   // ok
  }

  // restore the local (browser) half: write every captured skynet.* key back verbatim. Returns a
  // summary; never throws. The notebook is preserved in the file but not pushed to the sidecar in v1.
  function applyBundle(doc) {
    const err = validate(doc);
    if (err) return { ok: false, error: err };
    let n = 0;
    try {
      const store = doc.store;
      for (const k in store) {
        if (Object.prototype.hasOwnProperty.call(store, k) && k.indexOf(PREFIX) === 0 && typeof store[k] === 'string') {
          localStorage.setItem(k, store[k]); n++;
        }
      }
    } catch (e) { return { ok: false, error: (e && e.message) || 'write failed' }; }
    return { ok: true, keys: n, agentName: doc.agentName || agentName(), memories: Array.isArray(doc.notebook) ? doc.notebook.length : 0 };
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      try {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error || new Error('read failed'));
        fr.readAsText(file);
      } catch (e) { reject(e); }
    });
  }

  // push the bundle's memory snapshot back to the sidecar so a restored/moved agent isn't amnesiac. The route
  // merges additively (existing notes win), so this is safe to call even over an agent that already has memory.
  // Best-effort: a UI-only preview or unreachable sidecar just yields 0 restored.
  function restoreNotebook(notes) {
    return fetch('/api/notebook/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent', notes: notes })
    }).then(r => r.ok ? r.json() : null).then(j => (j && j.ok) ? (j.added || 0) : 0).catch(() => 0);
  }

  async function importFile(file) {
    let doc;
    try { doc = JSON.parse(await readFileText(file)); }
    catch (_) { return { ok: false, error: 'file is not valid JSON' }; }
    const res = applyBundle(doc);
    if (res.ok) {
      // re-stamp the imported save to NOW and write it through to the durable sidecar mirror. The bundle carries
      // the export-time updatedAt; without this, a boot-reconcile on a machine whose sidecar holds a NEWER save
      // would silently revert the just-imported agent. Stamping now() makes the import win the anti-clobber guard.
      try {
        const raw = localStorage.getItem('skynet.save');
        if (raw) {
          const d = JSON.parse(raw); d.updatedAt = Date.now();
          localStorage.setItem('skynet.save', JSON.stringify(d));
          if (typeof CloudSave !== 'undefined' && CloudSave.push) CloudSave.push(d);
        }
      } catch (_) {}
    }
    if (res.ok && Array.isArray(doc.notebook) && doc.notebook.length) {
      res.memoriesRestored = await restoreNotebook(doc.notebook);   // fold memory back into the sidecar
    }
    return res;
  }

  return { exportAll, importFile, applyBundle, validate, collectStore, build, SCHEMA, VERSION };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Backup;
