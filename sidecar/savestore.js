/* sidecar/savestore.js — durable server-side persistence for the agent the user builds (M-save).

   The browser's localStorage is the FRAGILE store: a cache wipe, a different browser, or a fresh
   machine loses the agent (identity, XP/level/confidence, personalization, workstreams, station).
   `save.js` itself says "localStorage for now ... moves to the SQLite sidecar later." This module is
   that move: a durable mirror of the save envelope on the sidecar's own disk (the app-data dir that
   survives a browser wipe). The frontend keeps localStorage as a fast cache and writes through to here.

     makeSaveStore({ fs, pathMod, root, clock }) -> {
       load(agentId)        -> doc | undefined        // the stored save envelope; undefined if none/corrupt
       save(agentId, doc)   -> { ok, stale?, updatedAt }  // atomic; refuses to REGRESS updatedAt (anti-clobber)
     }

   The file lives at <root>/<agentId>.save.json — a SIBLING of the notebook/channels stores, OUTSIDE the
   agent's fs jail (<root>/<agentId>/), so the agent's own fs.* tools can neither read nor corrupt the
   record of its own growth. It holds NO secret: the API key/OAuth tokens are stored separately and are
   never part of the save envelope, so mirroring it to disk leaks nothing.

   Save-safe like its siblings: atomic temp+rename; a missing/corrupt file loads as undefined and NEVER
   throws; an incoming write whose updatedAt is older than what's on disk is rejected (a stale tab cannot
   clobber a newer save). Pure + deterministic: all I/O is the injected `fs` (sync), time is the injected
   `clock` — no Date.now/rng, so it replays identically under test. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.savestore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;   // same agentId grammar as the notebook / fs jail / channels store

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  function makeSaveStore(deps) {
    const d = deps || {};
    const fs = d.fs;
    const pathMod = d.pathMod;
    const rootDir = d.root;
    const clock = d.clock;
    if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.writeFileSync !== 'function' || typeof fs.renameSync !== 'function')
      throw new Error('makeSaveStore: an injected fs (readFileSync/writeFileSync/renameSync[/mkdirSync]) is required');
    if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeSaveStore: an injected pathMod is required');
    if (!rootDir) throw new Error('makeSaveStore: a root dir is required');
    if (!clock || typeof clock.now !== 'function') throw new Error('makeSaveStore: an injected clock is required');

    let tmpSeq = 0;   // deterministic process-unique tmp suffix (a single host; no pid/rng needed)

    function ensureRoot() { try { if (fs.mkdirSync) fs.mkdirSync(rootDir, { recursive: true }); } catch (_) {} }
    function saveFile(agentId) {
      if (!AID_RE.test(String(agentId))) throw new Error('bad save agentId: ' + agentId);
      return pathMod.join(rootDir, agentId + '.save.json');
    }
    // reads + parses a save file path, returning a TAGGED result so callers can tell a genuinely-absent file
    // from one that EXISTS but couldn't be READ (locked/EBUSY/EACCES on Windows) versus one that read but has
    // GARBAGE bytes. The distinction is load-bearing for the anti-clobber gate. The agentId grammar is validated
    // by the caller via saveFile() BEFORE this.
    //   { status: 'ok', wrapper }      — read + parsed
    //   { status: 'absent' }           — ENOENT: no file at all (safe to write a fresh save)
    //   { status: 'unreadable', err }  — present but a non-ENOENT errno blocked the read (locked/EACCES): bytes
    //                                     are probably FINE, freshness UNKNOWN — do NOT clobber (conservative)
    //   { status: 'corrupt', err }     — present + read but the bytes don't parse: unrecoverable garbage, safe to
    //                                     overwrite (a corrupt save is already lost — preserves prior product behavior)
    function readTaggedRaw(file) {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch (e) {
        if (e && e.code === 'ENOENT') return { status: 'absent' };
        return { status: 'unreadable', err: e };   // present but locked/EACCES/etc. — NOT absent, bytes intact
      }
      // a zero-length main is a TORN write (crash between temp-open and rename, or an interrupted legacy write):
      // treat it like corrupt so the .bak recovery path below kicks in rather than loading empty.
      if (raw == null || String(raw).length === 0) return { status: 'corrupt', err: new Error('zero-length save file') };
      try { return { status: 'ok', wrapper: JSON.parse(raw) }; }
      catch (e) { return { status: 'corrupt', err: e }; }   // present + read but garbage — recoverable-over
    }
    // quarantine a corrupt main aside (rename to <file>.corrupt-<seq>) so it's preserved for forensics but no
    // longer blocks the store, then recover from <file>.bak if it holds a clean prior save. Best-effort + loud.
    function quarantine(file, why) {
      try {
        const dead = file + '.corrupt-' + (++tmpSeq);
        try { if (typeof fs.unlinkSync === 'function') fs.unlinkSync(dead); } catch (_) {}   // clear any stale target (Windows rename-onto fails)
        fs.renameSync(file, dead);
        try { console.warn('[savestore] quarantined corrupt save ' + file + ' -> ' + dead + ' (' + why + ')'); } catch (_) {}
      } catch (_) { /* couldn't move it (locked/gone) — leave it; recovery below still tries .bak */ }
    }
    // RESILIENT tagged read: main first; on a corrupt/torn main, quarantine it and recover from <file>.bak. An
    // 'unreadable' main is NOT quarantined (bytes are fine, just locked) — surfaced as-is so the caller stays
    // conservative. Adds status 'recovered' (main was bad, .bak was clean -> the .bak value is authoritative).
    function readTagged(file) {
      const m = readTaggedRaw(file);
      if (m.status === 'ok') return m;
      if (m.status === 'unreadable') return m;   // locked/EBUSY: don't roll back to a possibly-stale .bak
      // main is absent OR corrupt/torn — try the last-known-good .bak.
      const b = readTaggedRaw(file + '.bak');
      if (b.status === 'ok') {
        if (m.status === 'corrupt') quarantine(file, 'main unparseable; recovered from .bak');
        return { status: 'recovered', wrapper: b.wrapper, err: m.err };
      }
      // no usable .bak. A genuinely-absent main with no .bak is just a new agent (absent). A corrupt main with
      // no clean .bak is unrecoverable — quarantine it so the next write starts fresh (preserves prior "corrupt
      // save is already lost" product behavior) and report corrupt.
      if (m.status === 'corrupt') { quarantine(file, 'main unparseable and no usable .bak'); }
      return m.status === 'absent' ? { status: 'absent' } : { status: 'corrupt', err: m.err };
    }
    // back-compat convenience: the parsed wrapper, or undefined when absent/unreadable/corrupt.
    // 'recovered' (from .bak) is a usable value, so it returns the wrapper too.
    function readWrapper(file) { const r = readTagged(file); return (r.status === 'ok' || r.status === 'recovered') ? r.wrapper : undefined; }
    // atomic temp+rename, with the temp file fsync'd before the rename so the DURABLE store of record actually
    // survives a hard power loss (the ledger/runs siblings fsync their appends; this is the same guarantee). The
    // fsync is capability-guarded: the real node:fs supplies openSync/writeSync/fsyncSync, while the in-memory
    // test fs (writeFileSync/renameSync only) falls back to the plain path — keeps the store deterministic + testable.
    function writeDurable(file, data) {
      const tmp = file + '.' + (++tmpSeq) + '.tmp';
      if (typeof fs.openSync === 'function' && typeof fs.fsyncSync === 'function' && typeof fs.writeSync === 'function') {
        let fd = null;
        try { fd = fs.openSync(tmp, 'w'); fs.writeSync(fd, data); fs.fsyncSync(fd); }
        finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
      } else {
        fs.writeFileSync(tmp, data);   // test/in-memory fs: no fsync available, plain write
      }
      fs.renameSync(tmp, file);   // atomic replace
    }
    function writeAtomic(file, value) {
      ensureRoot();
      // LAST-KNOWN-GOOD snapshot: before overwriting main, copy the CURRENT clean main to <file>.bak (durably)
      // so a torn replace of main can be recovered from the prior committed save. A main that is itself corrupt/
      // torn is NOT copied (never clobber a possibly-good .bak with garbage). Best-effort — a .bak failure must
      // never block the real save.
      try {
        const cur = fs.readFileSync(file, 'utf8');
        if (cur && String(cur).length) { try { JSON.parse(cur); writeDurable(file + '.bak', cur); } catch (_) {} }
      } catch (_) { /* no current main (first write) — nothing to back up */ }
      writeDurable(file, JSON.stringify(value));   // atomic + durable replace of main
    }

    return {
      // the stored save envelope (the exact doc the frontend persisted), or undefined when there is none or
      // the file is unreadable/corrupt. Never throws on a bad file — a wiped agent reads as "nothing yet".
      load(agentId) {
        const w = readWrapper(saveFile(agentId));   // saveFile() validates the id (throws on traversal) before any read
        return (w && typeof w === 'object' && w.doc && typeof w.doc === 'object') ? w.doc : undefined;
      },

      // persist the save envelope durably. Wrapped with the server receive time + the doc's own updatedAt so
      // a later read can compare freshness without parsing the frontend schema. ANTI-CLOBBER: if the incoming
      // doc is OLDER than what's on disk (updatedAt regressed), the write is refused — a stale background tab
      // can never overwrite a newer save. Returns the authoritative on-disk updatedAt either way.
      save(agentId, doc) {
        if (!doc || typeof doc !== 'object') throw new Error('save: a doc object is required');
        const file = saveFile(agentId);   // validates the id (throws on traversal)
        const prevRead = readTagged(file);
        // CONSERVATIVE anti-clobber on an UNREADABLE prior: the file EXISTS but a non-ENOENT errno blocked the
        // read (locked/EBUSY/EACCES), so the bytes are probably a perfectly good — possibly NEWER — save we just
        // couldn't read this instant. We cannot prove this incoming write isn't a lower-progress overwrite, so we
        // refuse rather than blow it away (the Windows errno conflation would otherwise treat it as progress=0 and
        // always accept, silently wiping the record). A genuinely CORRUPT prior (read but garbage) still recovers-
        // over as before. Report unreadable distinctly so the caller can retry/surface.
        if (prevRead.status === 'unreadable') {
          try { console.warn('[savestore] refusing save for ' + String(agentId) + ' — existing record is unreadable (' + ((prevRead.err && prevRead.err.code) || 'EUNKNOWN') + '); not clobbering a possibly-newer save'); } catch (_) {}
          return { ok: false, stale: true, unreadable: true, updatedAt: 0 };
        }
        // a prior read cleanly ('ok') OR recovered from .bak ('recovered') is an authoritative prior for the
        // anti-clobber freshness gate — a torn main whose .bak we restored must still not be regressed.
        const prev = (prevRead.status === 'ok' || prevRead.status === 'recovered') ? prevRead.wrapper : undefined;
        const prevUpdated = prev && typeof prev === 'object' ? num(prev.updatedAt) : 0;
        const incomingUpdated = num(doc.updatedAt);
        if (prev && incomingUpdated < prevUpdated) return { ok: false, stale: true, updatedAt: prevUpdated };
        writeAtomic(file, { version: 1, agentId: String(agentId), updatedAt: incomingUpdated, savedAt: clock.now(), doc: doc });
        return { ok: true, updatedAt: incomingUpdated };
      },

      _internals: { saveFile, AID_RE, num, readTagged }
    };
  }

  return { makeSaveStore, _internals: { AID_RE, num } };
});
