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
    // G3a seed callout: a row whose unattended run genuinely reuses a Commander-saved seed (seedborn custom
    // recipe — matched by routine name or by its task template) gets .seed = the seed's name; the digest
    // label credits it. Cosmetic annotation only — an unmatched row stands unchanged, never guessed.
    try {
      if (typeof SeedCredit !== 'undefined' && typeof Recipes !== 'undefined' && Recipes.customs) SeedCredit.annotate(rows, Recipes.customs());
    } catch (_) {}
    // G3b seed-reuse aggregate: each row now carrying a proven `.seed` is one genuine while-away reuse of a
    // Commander-saved seed. Feed the aggregate (lifetime + 7-day per-seed counts → the TROPHY CASE living-tools
    // shelf; a window crest fires the once-per-week "ran 5× this week" callout). Digested rows are listed once
    // (returns.js never re-lists), so each reuse is counted exactly once. Provenance-only — unmatched rows skip.
    try { if (typeof SeedReuseStore !== 'undefined' && SeedReuseStore.recordAnnotatedRows) SeedReuseStore.recordAnnotatedRows(rows); } catch (_) {}
    return rows;
  }

  async function maybeDigest(sinceMs) {
    if (fired || !ready()) return;
    const rows = await composeRows(sinceMs);
    if (!rows.length) return;                       // NEVER an empty digest
    fired = true;                                   // one per session, even if the beat is later dismissed
    state = Returns.fold(state, rows); save();      // listed once, never re-listed; crates now pending
    if (typeof Chat !== 'undefined' && Chat.awayDigest) Chat.awayDigest(rows, { onRated: resolve, openWork: openWork });
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

  // ---- attendance truth (item #5): a simple, provable read surface UI can consume ----
  // lastSeen() — the durable heartbeat stamp (ms epoch) of the LAST time this app was known to be running. 0 before
  // the first heartbeat. This is the same value that defines "away" for the digest, so any UI keyed on it agrees
  // with the digest boundary (no second, divergent notion of "away").
  function lastSeen() { return ready() ? (state.lastSeenAt || 0) : 0; }
  // isAttended() — is the app being watched RIGHT NOW? True once the store is live and heartbeating (init ran, the
  // 30s timer is armed). The heartbeat only advances while THIS tab runs, so a true here is a provable "someone is
  // here" — the honest inverse of the "away" condition the away-workshop/digest describe. Fail-safe false.
  function isAttended() { return !!(ready() && hbTimer); }

  // the copy a digest-dismiss should show (item #3): dismissing the beat is NOT discarding the work — every listed
  // run's crate is already pending in the OUTBOX and stays collectable there. One honest sentence the render site
  // (chat.js awayDigest, Lane B) drops next to the dismiss control so "dismiss" never reads as "lose it".
  function outboxLine() { return 'the crate on the floor holds these until you review them.'; }

  // ---- the OUTBOX crate surface (world.js renders from these; clicking the chute reviews) ----
  function pendingCount() { return ready() ? Returns.pendingCount(state) : 0; }
  /* openWork(rw) — make the crated run READABLE: open its transcript session in COMMS. The digest rows
     carry the run's streamId (returns.js); a legacy crate (persisted before streamId rode the rows) is
     resolved from the run record. A stream with no live workstream yet (e.g. a nightshift-* run — the
     autosessions layer only adopts cron-*) is adopted read-only and its DURABLE transcript folded in via
     AutoSessions' generic foldTurns, so "review the work" always lands on the actual work — never a hunt
     through TASKS. Fail-open: false when the transcript genuinely can't be reached (the caller says so
     honestly; never a dead click). */
  async function openWork(rw) {
    if (!rw || !rw.runId) return false;
    let sid = String(rw.streamId || '');
    if (!sid) {   // legacy crate — resolve the streamId from the sidecar's run record
      try {
        const r = await fetch('/api/runs?agent=*&limit=200', { cache: 'no-store' });
        if (r.ok) { const hit = (((await r.json()) || {}).runs || []).find(x => x && x.runId === rw.runId); sid = String((hit && hit.streamId) || ''); }
      } catch (_) {}
    }
    if (!sid || typeof Workstreams === 'undefined' || !Workstreams.adopt) return false;
    let w = Workstreams.get(sid);
    if (!w || !(w.history || []).some(m => m && m.role === 'assistant')) {
      // no session yet (or an output-less shell) — adopt + fold the durable transcript so the work is readable.
      // revive:true — this is a DELIBERATE Commander click ("review the work"), the one case that may
      // clear a deleted-session tombstone and bring the session back.
      w = Workstreams.adopt({ id: sid, title: (rw.routine || rw.title || 'finished run').slice(0, 80), agentId: rw.agentId || 'agent', lane: 'active', revive: true });
      if (!w) return false;
      let turns = [], fetchOk = false;
      try {
        const tr = await fetch('/api/transcript?agent=' + encodeURIComponent(rw.agentId || 'agent') + '&stream=' + encodeURIComponent(sid) + '&limit=200', { cache: 'no-store' });
        if (tr.ok) { turns = (((await tr.json()) || {}).turns || []); fetchOk = true; }
      } catch (_) {}
      if (!fetchOk && !(w.history || []).length) return false;   // nothing readable AND nothing already there — honest failure
      try { if (typeof AutoSessions !== 'undefined' && AutoSessions._internals) AutoSessions._internals.foldTurns(w, turns, 'ok', '', fetchOk); } catch (_) {}
    }
    if (typeof App !== 'undefined' && App.openWorkstream) { App.openWorkstream(sid); return true; }
    return false;
  }
  // open the collect/review beat for the OLDEST uncollected run (FIFO — crates clear in arrival order)
  function reviewNext() {
    if (!ready()) return false;
    const row = Returns.oldestPending(state);
    if (!row || typeof Chat === 'undefined' || !Chat.awayReview) return false;
    Chat.awayReview(row, { onRated: resolve, openWork: openWork });
    return true;
  }
  // rated (collected) — clear the crate
  function resolve(runId) { if (ready() && runId) { state = Returns.resolve(state, runId); save(); } }

  // S2/new-hero: a fresh Commander inherits no prior pending crates or attendance trail.
  function reset() { state = null; fired = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, pendingCount, reviewNext, resolve, reset, lastSeen, isAttended, outboxLine, openWork };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ReturnStore };
