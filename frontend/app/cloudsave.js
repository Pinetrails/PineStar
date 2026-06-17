/* SKYNET — cloudsave.js : write the agent through to the durable sidecar, and pull it back on boot.

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

  let timer = null;
  let pending = null;                  // newest doc awaiting a flush (older queued docs are superseded)

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function isSave(d) { return !!(d && typeof d === 'object' && d.schema === 'skynet.save' && d.agent && typeof d.agent === 'object'); }

  // NOTE: no `keepalive` here — browsers cap a keepalive body at 64KB, and a save with workstreams + station
  // can exceed that. The normal debounced flush is a plain fetch; the unload path uses sendBeacon instead.
  function postNow(doc) {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc)
    });
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const doc = pending; pending = null;
    if (!isSave(doc)) return Promise.resolve(false);
    return postNow(doc).then(() => true).catch(() => false);   // fail soft — the cache is still authoritative locally
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
    let remote = null;
    try { remote = await pull(); } catch (_) { remote = null; }
    if (!isSave(remote)) {             // nothing durable yet — seed the server from local if we have one
      if (isSave(local)) push(local);
      return local;
    }
    if (!isSave(local) || num(remote.updatedAt) > num(local.updatedAt)) {
      // adopt remote into the cache, then re-read it through Save.load() so the MIGRATION LADDER runs on it.
      // The durable mirror is designed to outlive the cache and survive app updates, so it can legitimately be
      // an OLDER schema (v1/v2) than this build. resumeInto() assumes a current-schema doc (reads .workstreams,
      // expects .agent.stats); adopting a raw v1/v2 remote would silently drop history + skip the XP seed.
      try { localStorage.setItem('skynet.save', JSON.stringify(remote)); } catch (_) {}
      try { const migrated = (typeof Save !== 'undefined' && Save.load) ? Save.load() : null; if (migrated) return migrated; } catch (_) {}
      return remote;   // fallback only if Save is somehow unavailable — better the raw doc than nothing
    }
    if (num(local.updatedAt) > num(remote.updatedAt)) push(local);   // local is ahead — let the server catch up
    return local;
  }

  // a close/hide can land before the debounce fires; beacon the pending doc so the last save is never dropped.
  function installUnloadFlush() {
    const beacon = () => {
      if (!isSave(pending)) return;
      try {
        const blob = new Blob([JSON.stringify(pending)], { type: 'application/json' });
        if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) { pending = null; return; }
      } catch (_) {}
      flush();                         // fallback if sendBeacon is unavailable/rejected
    };
    try {
      window.addEventListener('pagehide', beacon);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') beacon(); });
    } catch (_) {}
  }

  return { push, pull, reconcile, flush, installUnloadFlush, _isSave: isSave };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CloudSave;
