/* STARNET — cloudsave.js : write the agent through to the durable sidecar, and pull it back on boot.

   localStorage is a fast CACHE that a browser wipe can erase. The sidecar's <workspaces>/<id>.save.json is the
   DURABLE copy (app-data dir, survives a cache wipe / different browser). This module keeps them in sync:

     • push(doc)      — debounced best-effort POST /api/save on every persist; coalesces bursts of turns.
     • pull()         — GET /api/save?agent=agent → the stored envelope (or null).
     • reconcile(local) — on boot, adopt whichever of {local, remote} is NEWER (by updatedAt), write the winner
                          back into the localStorage cache, and nudge the server if local was ahead. This is
                          what restores the agent after a cache wipe: local is gone, remote brings it back.
     • installUnloadFlush() — a pagehide/visibility beacon so the LAST debounced save isn't lost on close.

   Best-effort throughout: if the sidecar is unreachable (e.g. the UI-only dev preview), every call fails soft
   and the localStorage cache still works exactly as before. No secret crosses the wire — the save envelope
   never contains the API key/tokens. */
'use strict';

const CloudSave = (() => {
  const AGENT_ID = 'agent';            // single agent per save today; mirrors the rest of the app
  const DEBOUNCE_MS = 1200;
  const ENDPOINT = '/api/save';        // same-origin: the sidecar serves the frontend in the real app

  // pure retry/health brain — see cloudsavecore.js (unit-tested in Node). Fail soft if it's absent
  // (order-of-load safety): a null-object Core keeps the old best-effort behavior with no retry/health.
  const Core = (typeof CloudSaveCore !== 'undefined') ? CloudSaveCore
    : (typeof require !== 'undefined' ? (() => { try { return require('./cloudsavecore.js'); } catch (_) { return null; } })() : null);

  let timer = null;                    // debounce timer for a fresh push
  let retryTimer = null;               // backoff timer scheduling the next attempt after a failure
  let pending = null;                  // newest doc awaiting a flush (older queued docs are superseded)
  let health = Core ? Core.freshHealth() : { lastPushOkAt: 0, lastPushFailAt: 0, consecutiveFailures: 0, nextRetryAt: 0 };
  let warnedStale = false;             // ONE console warn per failing↔healthy transition, never per attempt

  function now() { return Date.now(); }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function isSave(d) { return !!(d && typeof d === 'object' && d.schema === 'starnet.save' && d.agent && typeof d.agent === 'object'); }

  // this build's readable schema ceiling. A save/remote whose version exceeds this was written by a NEWER
  // StarNet and MUST NOT be adopted into the cache (that would clobber the local doc with fields this code
  // can't read). Mirror Save.CURRENT when available; fall back to a literal only if Save hasn't loaded yet.
  function currentVersion() { return (typeof Save !== 'undefined' && Number.isFinite(Save.CURRENT)) ? Save.CURRENT : 5; }
  function isFutureSave(d) { return isSave(d) && num(d.version) > currentVersion(); }
  // the sentinel reconcile hands the boot path when a durable remote is from a newer build. Distinct object
  // (never a real save envelope) so the boot path can raise the honest "update the app" gate. localStorage is
  // left byte-unchanged — we never setItem a future remote.
  function futureSentinel(version) { return { __futureSave: true, version: num(version) }; }

  // NOTE: no `keepalive` here — browsers cap a keepalive body at 64KB, and a save with workstreams + station
  // can exceed that. The normal debounced flush is a plain fetch; the unload path uses sendBeacon instead.
  function postNow(doc) {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc)
    });
  }

  // record a push outcome into the health brain + drive the one-warn-per-state-change console policy.
  // Kept fail-soft: a missing Core (order-of-load) just no-ops the telemetry, never throws.
  function markOk() {
    if (Core) health = Core.recordSuccess(health, now());
    else health = { lastPushOkAt: now(), lastPushFailAt: health.lastPushFailAt, consecutiveFailures: 0, nextRetryAt: 0 };
    if (warnedStale) { warnedStale = false; try { console.info('[cloudsave] durable mirror sync recovered.'); } catch (_) {} }
  }
  function markFail() {
    if (Core) health = Core.recordFailure(health, now());
    else health = { lastPushOkAt: health.lastPushOkAt, lastPushFailAt: now(), consecutiveFailures: health.consecutiveFailures + 1, nextRetryAt: 0 };
    // warn EXACTLY once when we first cross into stale territory — not once per attempt (no console spam,
    // no throw into callers). The UI save-dot carries the ongoing signal; this is just a dev breadcrumb.
    const stale = Core ? Core.isStale(health, now()) : false;
    if (stale && !warnedStale) {
      warnedStale = true;
      try { console.warn('[cloudsave] durable mirror has not synced; retrying with backoff. Local cache is intact.'); } catch (_) {}
    }
  }

  // (re)arm the backoff retry so a dropped push is never silently abandoned. Newest-wins: whatever is
  // in `pending` when the timer fires is what gets sent, so a burst during backoff still coalesces to one.
  function scheduleRetry() {
    if (retryTimer || !isSave(pending)) return;
    const delay = Core ? Math.max(0, num(health.nextRetryAt) - now()) : 5000;
    try { retryTimer = setTimeout(() => { retryTimer = null; flush(); }, delay); } catch (_) { retryTimer = null; }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    // honor the backoff window — if a failure streak is live and the next attempt isn't due yet, hold the
    // doc in `pending` and re-arm rather than hammering the sidecar every debounce.
    if (Core && isSave(pending) && !Core.retryDue(health, now())) { scheduleRetry(); return Promise.resolve(false); }
    const doc = pending; pending = null;
    if (!isSave(doc)) return Promise.resolve(false);
    return postNow(doc)
      .then(r => {
        // a non-ok HTTP status (e.g. 409 stale, 500) is a FAILURE, not a success — fetch only rejects on
        // network error, so we must inspect r.ok ourselves or we'd stamp health OK on a rejected write.
        if (r && r.ok === false) { throw new Error('save HTTP ' + r.status); }
        markOk();
        return true;
      })
      .catch(() => {
        markFail();
        // re-queue the newest doc (newest-wins: a fresher push during the attempt already replaced it) and
        // arm the backoff retry. Fail soft — the cache is still authoritative locally, nothing throws out.
        if (!isSave(pending)) pending = doc;
        scheduleRetry();
        return false;
      });
  }

  // queue a write-through; coalesces a burst of persists into one POST after the debounce settles.
  // SINGLE-WRITER assumption: the app is single-agent/single-session, so this mirrors whatever localStorage
  // holds with last-write-wins (the sidecar rejects only a STALE-timestamp write). Two live tabs editing the
  // SAME agent at once can still clobber each other envelope-for-envelope — the same limitation the localStorage
  // layer it shadows already has. A cross-tab write-leader (storage-event/BroadcastChannel) is the fix if/when
  // multi-tab editing becomes a real workflow; out of scope while one session is the design.
  function push(doc) {
    if (!isSave(doc)) return;
    pending = doc;                     // keep only the newest
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, DEBOUNCE_MS);
  }

  // bounded so a hung/slow sidecar can never block boot — on timeout we abort and fall back to the local cache.
  function pull() {
    let ctl = null, t = null;
    try { ctl = new AbortController(); t = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, 2500); } catch (_) {}
    return fetch(ENDPOINT + '?agent=' + encodeURIComponent(AGENT_ID), { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(r => r.ok ? r.json() : null)
      .then(j => { const s = j && j.save; return isSave(s) ? s : null; })
      .catch(() => null)              // unreachable/slow sidecar -> no remote, fall back to local
      .then(v => { if (t) clearTimeout(t); return v; });
  }

  // pick the newer of local/remote, refresh the local cache to match, and push local up if it was ahead.
  // Returns the winning doc (or local/null) for the boot path to resume from.
  async function reconcile(local) {
    // FORWARD-VERSION GUARD (P0.3): a local cache written by a NEWER build must never be pushed up or resumed
    // by this older code. Surface the gate before we even pull — the boot path stops here and asks to update.
    if (isFutureSave(local)) return futureSentinel(num(local.version));
    let remote = null;
    try { remote = await pull(); } catch (_) { remote = null; }
    if (!isSave(remote)) {             // nothing durable yet — seed the server from local if we have one
      if (isSave(local)) push(local);
      return local;
    }
    // FORWARD-VERSION GUARD (P0.3): a durable remote from a NEWER build must NOT be adopted into the cache —
    // setItem-ing it and re-migrating would clobber the local doc with fields this build can't read (silent
    // contamination, brutal to debug). Leave localStorage byte-unchanged and raise the honest update gate.
    if (isFutureSave(remote)) return futureSentinel(num(remote.version));
    if (!isSave(local) || num(remote.updatedAt) > num(local.updatedAt)) {
      // adopt remote into the cache, then re-read it through Save.load() so the MIGRATION LADDER runs on it.
      // The durable mirror is designed to outlive the cache and survive app updates, so it can legitimately be
      // an OLDER schema (v1/v2) than this build. resumeInto() assumes a current-schema doc (reads .workstreams,
      // expects .agent.stats); adopting a raw v1/v2 remote would silently drop history + skip the XP seed.
      const priorLocalRaw = (() => { try { return localStorage.getItem('starnet.save'); } catch (_) { return null; } })();
      try { localStorage.setItem('starnet.save', JSON.stringify(remote)); } catch (_) {}
      try {
        // re-validate through Save.load(): it re-checks the forward-version guard on the just-adopted doc and
        // runs the migration ladder. A migrated, current-schema save is the only thing we hand back.
        const migrated = (typeof Save !== 'undefined' && Save.load) ? Save.load() : null;
        if (isSave(migrated) && num(migrated.version) <= currentVersion()) return migrated;
      } catch (_) {}
      // adoption produced no readable current-schema doc (Save unavailable, or the re-read failed the guard).
      // NEVER return the raw, unmigrated remote — resumeInto() would misread it. Roll the cache back to the
      // prior local and prefer it; if there was no prior local, fall through to null (boot onboards cleanly).
      try { if (priorLocalRaw != null) localStorage.setItem('starnet.save', priorLocalRaw); else localStorage.removeItem('starnet.save'); } catch (_) {}
      try { console.warn('[cloudsave] adopted remote did not re-validate; kept prior local cache.'); } catch (_) {}
      return isSave(local) ? local : null;
    }
    if (num(local.updatedAt) > num(remote.updatedAt)) push(local);   // local is ahead — let the server catch up
    return local;
  }

  // the boot path uses this to tell reconcile()'s future-save sentinel apart from a normal winning doc.
  function isFutureSentinel(d) { return !!(d && typeof d === 'object' && d.__futureSave === true); }

  // a close/hide can land before the debounce fires; beacon the pending doc so the last save is never dropped.
  function installUnloadFlush() {
    const beacon = () => {
      if (!isSave(pending)) return;
      try {
        const blob = new Blob([JSON.stringify(pending)], { type: 'application/json' });
        // sendBeacon returns true only when the browser accepts the payload for background send. That's a
        // best-effort dispatch (not a confirmed 200), but it's the strongest signal we get on unload, so
        // stamp health OK on it — leaving the record frozen here would falsely read stale on the NEXT boot.
        if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) { pending = null; markOk(); return; }
      } catch (_) {}
      flush();                         // fallback if sendBeacon is unavailable/rejected
    };
    try {
      window.addEventListener('pagehide', beacon);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') beacon(); });
    } catch (_) {}
  }

  // live durability health for the UI (save-dot) + diagnostics. `stale` is the TRUTHFUL verdict the
  // dot renders: persists are landing locally but the durable backup hasn't confirmed a write in > 60 min
  // AND there's a live failure streak. Never asserts "backed up" the harness can't prove.
  function healthNow() {
    return Core ? Core.snapshot(health, now())
      : { lastPushOkAt: health.lastPushOkAt, lastPushFailAt: health.lastPushFailAt, consecutiveFailures: health.consecutiveFailures, nextRetryAt: 0, stale: false };
  }

  return { push, pull, reconcile, flush, installUnloadFlush, health: healthNow, isFutureSentinel, _isSave: isSave, _isFutureSave: isFutureSave };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CloudSave;
