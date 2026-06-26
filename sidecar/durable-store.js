/* sidecar/durable-store.js — crash-safe + concurrency-safe + recovery-aware single-file JSON stores.

   Three problems this fixes for the protected sibling stores (notebook, roster, dossier, channel
   secrets, codex tokens, connectors, allowlist), all of which today do an UNLOCKED read-modify-write
   over a plain writeFileSync->rename:

   P1 CONCURRENCY CLOBBER — callers do get() -> mutate -> set(). Two writers to the SAME key that each
      computed from a stale snapshot whole-array-overwrite each other -> a committed update is silently
      lost. The fix is `update(key, mutator)`: a per-KEY async mutex serializes every write, and the
      mutator RE-READS the current committed state inside the lock before merging (the same re-read-
      under-lock discipline cron already uses under cron-lock). Even an async mutator is fully serialized,
      so no number of concurrent in-process writers can lose an update.

   P2 NON-DURABLE + FAIL-OPEN-TO-EMPTY — a plain rename is atomic but NOT power-loss durable, so a hard
      kill can leave a store zero-length, and the old loaders catch-and-return-empty -> the app boots
      AMNESIAC and the next write persists that empty state forever. The fix: every write goes through
      writeFileDurable (fsync-before-rename) AND snapshots the prior good value to a `<file>.bak`
      last-known-good copy first; the loader DETECTS a zero-length/corrupt main and recovers from the
      .bak instead of silently wiping. A genuinely-absent file (new agent) is the ONLY thing that loads
      as empty.

   This is a pure, injected-I/O module (no ambient clock/rng — it reuses durable-write.js's crypto nonce),
   so it passes lint-determinism and is unit-testable against an in-memory fs. The Node host
   (sidecar/index.js) injects the real fs/path and composes these into its notebook/roster/etc. stores.

   makeKeyedMutex() -> { run(key, fn) -> Promise, size() }
   readJsonResilient({ fs }, file) -> { value, status }     status: 'ok'|'recovered'|'absent'|'corrupt'
   writeJsonResilient({ fs, path, writeDurable? }, file, value) -> void   (throws on a real write failure)
   makeDurableJsonStore({ fs, path, fileFor, writeDurable?, mutex?, onRecover?, onCorrupt? }) ->
       { get(key), set(key,value), update(key,mutator)->Promise, readKey(key), mutex } */
'use strict';

const { writeFileDurable } = require('./durable-write.js');

/* ---- per-key async mutex: serialize fn()s that share a key into one promise chain ----
   Each key owns a tail promise; a new run chains after it (running fn whether the prior settled or
   threw, so one failure never wedges the queue) and becomes the new tail. The tail is pruned when it
   is the last in line, so the Map never grows without bound across many distinct keys. */
function makeKeyedMutex() {
  const tails = new Map();   // key -> Promise (the tail of that key's queue)
  function run(key, fn) {
    const k = String(key);
    const prev = tails.get(k) || Promise.resolve();
    // run fn AFTER prev regardless of prev's outcome; `result` is what the caller awaits.
    const result = prev.then(fn, fn);
    // a settle-swallowing tail keeps the chain alive without leaking rejections, and lets us prune.
    const tail = result.then(function () {}, function () {});
    tails.set(k, tail);
    tail.then(function () { if (tails.get(k) === tail) tails.delete(k); });
    return result;
  }
  return { run: run, size: function () { return tails.size; } };
}

/* ---- recovery-aware read ----
   Tries the main file; on missing/zero-length/corrupt falls back to the <file>.bak last-known-good.
   Returns a STATUS so the caller can distinguish a genuinely-new store (absent -> load empty, fine)
   from a torn/corrupt one that was recovered, or an unrecoverable one that must be surfaced LOUDLY and
   never silently treated as empty.
     'ok'        — main parsed cleanly.
     'recovered' — main was missing/zero-length/corrupt but .bak parsed cleanly (value is the .bak).
     'absent'    — neither main nor .bak exists (a brand-new key; load empty is correct).
     'corrupt'   — main is present-but-bad and there is no usable .bak (caller must surface loudly). */
function readOne(fs, file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { kind: 'absent' }; }                      // ENOENT (or unreadable) -> treat as absent for this file
  if (raw == null || String(raw).length === 0) return { kind: 'empty' };   // zero-length = torn write
  try { return { kind: 'ok', value: JSON.parse(raw) }; }
  catch (_) { return { kind: 'corrupt' }; }
}

function readJsonResilient(deps, file) {
  const fs = deps.fs;
  const m = readOne(fs, file);
  if (m.kind === 'ok') return { value: m.value, status: 'ok' };
  const b = readOne(fs, file + '.bak');
  if (b.kind === 'ok') return { value: b.value, status: 'recovered' };
  if (m.kind === 'absent' && b.kind !== 'ok') return { value: undefined, status: 'absent' };
  // main present-but-bad (empty/corrupt) and no usable .bak -> unrecoverable; do NOT silently empty.
  return { value: undefined, status: 'corrupt' };
}

/* ---- durable write with a last-known-good snapshot ----
   Before overwriting main, copy the CURRENT good main to <file>.bak (durably) so the prior committed
   value survives a torn replace. A current main that is itself corrupt is NOT copied (never clobber a
   possibly-good .bak with garbage). Then write the new value to main durably (fsync-before-rename). */
function writeJsonResilient(deps, file, value) {
  const fs = deps.fs;
  const pathMod = deps.path;
  const wd = (typeof deps.writeDurable === 'function') ? deps.writeDurable : writeFileDurable;
  const data = JSON.stringify(value);
  try {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur && String(cur).length) {
      try { JSON.parse(cur); wd({ fs: fs, path: pathMod }, file + '.bak', cur); }
      catch (_) { /* current main is corrupt — leave the existing .bak (it may be the real last-good) */ }
    }
  } catch (_) { /* no current main (first write) — nothing to back up */ }
  wd({ fs: fs, path: pathMod }, file, data);
}

/* ---- keyed, durable, recovery-aware JSON store ----
   get/set are recovery-aware + durable; update(key, mutator) is the SAFE write: it serializes per key
   and re-reads the current committed state inside the lock before the mutator merges, then persists the
   result durably. Returning undefined from the mutator skips the write (a no-op update). */
function makeDurableJsonStore(deps) {
  const fs = deps.fs;
  const pathMod = deps.path;
  const fileFor = deps.fileFor;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('makeDurableJsonStore: an injected fs is required');
  if (typeof fileFor !== 'function') throw new Error('makeDurableJsonStore: fileFor(key)->path is required');
  const wd = (typeof deps.writeDurable === 'function') ? deps.writeDurable : writeFileDurable;
  const mutex = deps.mutex || makeKeyedMutex();
  const onRecover = (typeof deps.onRecover === 'function') ? deps.onRecover : function () {};
  const onCorrupt = (typeof deps.onCorrupt === 'function') ? deps.onCorrupt : function () {};

  function readKey(key) {
    const file = fileFor(key);
    const r = readJsonResilient({ fs: fs }, file);
    if (r.status === 'recovered') { try { onRecover(key, file, r); } catch (_) {} }
    else if (r.status === 'corrupt') { try { onCorrupt(key, file, r); } catch (_) {} }
    return r;
  }
  function get(key) {
    const r = readKey(key);
    return (r.status === 'ok' || r.status === 'recovered') ? r.value : undefined;
  }
  function set(key, value) {
    const file = fileFor(key);
    try { if (pathMod && pathMod.dirname && fs.mkdirSync) fs.mkdirSync(pathMod.dirname(file), { recursive: true }); } catch (_) {}
    writeJsonResilient({ fs: fs, path: pathMod, writeDurable: wd }, file, value);
  }
  function update(key, mutator) {
    return mutex.run(key, async function () {
      const cur = get(key);                 // RE-READ the current committed state INSIDE the lock
      const next = await mutator(cur);      // mutator may be sync or async; the lock is held throughout
      if (next !== undefined) set(key, next);
      return next;
    });
  }
  return { get: get, set: set, update: update, readKey: readKey, mutex: mutex };
}

module.exports = { makeKeyedMutex, readJsonResilient, writeJsonResilient, makeDurableJsonStore, _internals: { readOne } };
