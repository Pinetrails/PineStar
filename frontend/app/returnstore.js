/* STARNET — returnstore.js : the thin live wiring around the pure return-ritual engine (returns.js).

   Owns what the pure engine can't: the durable lastSeenAt HEARTBEAT (localStorage, stamped every
   30s while the app runs + on unload — so "away" means the app was genuinely CLOSED, and a run that
   finished while any tab was open never lands in the digest), the once-per-page-session digest
   budget, the /api/runs + /api/cron reads, and the hand-off to the COMMS beats (Chat.awayDigest /
   Chat.awayReview) + the OUTBOX crate count the world renders. Self-persists to its own key (rides
   the backup prefix, like mintstore) — no save.js change. NEVER emits on U.bus; XP flows through
   the same direct rate-the-work path every attended run uses (chat.js rateWork). */
'use strict';
const ReturnStore = (() => {
  const KEY = 'starnet.return.v1';
  const HEARTBEAT_MS = 30000;
  const DIGEST_DELAY_MS = 1600;   // let the floor + COMMS settle before the session-open beat
  let state = null;
  let fired = false;    // ONE digest per page session (anti-nag) — survives enterGame re-entry
  let hbTimer = 0;
  let wired = false;    // unload stamp wired once

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { if (state) localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof Returns !== 'undefined' && !!state;

  function beat() { if (!ready()) return; state = Returns.heartbeat(state, Date.now()); save(); }

  // fetch this station's run history (ALL agents — cron routines run on crew too) + the routine
  // catalogue, then compose the digest rows. Fail-open: any error -> [] (the beat just doesn't fire).
  async function composeRows(sinceMs) {
    let runs = [];
    try {
      const r = await fetch('/api/runs?agent=*&limit=200&since=' + encodeURIComponent(sinceMs), { cache: 'no-store' });
      if (r.ok) runs = (await r.json()).runs || [];
    } catch (_) { return []; }
    // the away boundary is the PREVIOUS session's stamp — the live state has already heartbeat-ed
    // to "now", so it MUST be passed explicitly (returns.test locks this regression).
    const rows = Returns.unattended(state, runs, sinceMs);
    if (!rows.length) return rows;
    try {
      const r = await fetch('/api/cron', { cache: 'no-store' });
      if (r.ok) Returns.matchRoutines(rows, ((await r.json()) || {}).jobs || []);
    } catch (_) { /* routine names are cosmetic — rows stand on their honest titles */ }
    return rows;
  }

  async function maybeDigest(sinceMs) {
    if (fired || !ready()) return;
    const rows = await composeRows(sinceMs);
    if (!rows.length) return;                       // NEVER an empty digest
    fired = true;                                   // one per session, even if the beat is later dismissed
    state = Returns.fold(state, rows); save();      // listed once, never re-listed; crates now pending
    if (typeof Chat !== 'undefined' && Chat.awayDigest) Chat.awayDigest(rows, { onRated: resolve });
  }

  /* init({ enabled }) — called from enterGame. Captures the PREVIOUS session's lastSeenAt (the
     "away since" mark) BEFORE the first heartbeat overwrites it, then arms the attendance clock.
     enabled:false (the awakening) still heartbeats — a first session must stamp attendance so the
     SECOND session has an honest baseline — it just never fires the beat. */
  function init(opts) {
    opts = opts || {};
    state = (typeof Returns !== 'undefined') ? Returns.hydrate(load()) : null;
    if (!state) return;
    const awaySince = state.lastSeenAt;             // 0 on the first-ever session -> engine digests nothing
    beat();                                          // we are attended NOW
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(beat, HEARTBEAT_MS);
    if (!wired) {
      wired = true;
      try { window.addEventListener('beforeunload', beat); } catch (_) {}
    }
    if (opts.enabled !== false) setTimeout(() => { maybeDigest(awaySince); }, DIGEST_DELAY_MS);
  }

  // ---- the OUTBOX crate surface (world.js renders from these; clicking the chute reviews) ----
  function pendingCount() { return ready() ? Returns.pendingCount(state) : 0; }
  // open the collect/review beat for the OLDEST uncollected run (FIFO — crates clear in arrival order)
  function reviewNext() {
    if (!ready()) return false;
    const row = Returns.oldestPending(state);
    if (!row || typeof Chat === 'undefined' || !Chat.awayReview) return false;
    Chat.awayReview(row, { onRated: resolve });
    return true;
  }
  // rated (collected) — clear the crate
  function resolve(runId) { if (ready() && runId) { state = Returns.resolve(state, runId); save(); } }

  // S2/new-hero: a fresh Commander inherits no prior pending crates or attendance trail.
  function reset() { state = null; fired = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, pendingCount, reviewNext, resolve, reset };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ReturnStore };
