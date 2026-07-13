/* STARNET — questrefreshstore.js : the QUEST V3 standing-refresh engine's frontend citizen.

   The sidecar owns a standing quest-refresh engine (sidecar/questrefresh.js + the ambient half in
   sidecar/index.js): every 24h (and on the caught-up fast path) it re-derives the Commander's NORTH STAR
   and mints step-quests toward it, recording an honest ledger of every attempt (minted / rejected: why /
   skipped: why). Two routes expose it:
     • GET  /api/quests/refresh      → { northStar, lastCycleAt, dueAt, due, why, binding, inFlight, ledger }
     • POST /api/quests/refresh/run  → force a cycle NOW ({ started:true } or the honest reason why not)

   Until this store nothing in the frontend called EITHER route — the north star, the "what the refresher
   tried and why" ledger, and the manual refresh were invisible. This thin live store is their browser-side
   read+write surface. It POLLS the status route on the station's tick cadence — THROTTLED (a real network
   fetch at most every POLL_MS, and immediately after a run) so the tick never floods the sidecar — and
   caches the last-good status, so a fetch failure keeps the previous view (the truthful-degradation idiom
   every sibling store uses: workshopstore / questledgerstore).

   Truthful telemetry: every field the panel shows is real engine state read off this cache — nothing is
   synthesized. NO U.bus emits (the frozen shared/events.js contract is owned elsewhere). node-exportable. */
'use strict';
const QuestRefreshStore = (() => {
  const POLL_MS = 6000;         // throttle: a live /api/quests/refresh fetch at most this often (24h engine — no need to poll hard)
  let cache = null;             // last-good status object (null until the first successful fetch)
  let lastFetch = 0;            // ms of the last SUCCESSFUL fetch (0 = force next sync to fetch)
  let inflight = false;         // one fetch at a time — a slow response never stacks
  let running = false;          // a manual run POST is in flight (button guard, distinct from the engine's own inFlight)

  // shape the status JSON into a stable read shape, guarding every field so a junk/partial payload degrades
  // to a safe view rather than throwing (fail-soft, like the sibling stores' normalizers).
  function shape(j) {
    if (!j || typeof j !== 'object') return null;
    const ns = (j.northStar && typeof j.northStar === 'object' && String(j.northStar.text || '').trim())
      ? {
          text: String(j.northStar.text).trim(),
          groundedIn: String(j.northStar.groundedIn || ''),
          at: Number(j.northStar.at) || 0,
          source: j.northStar.source === 'goal' ? 'goal' : 'model',
          status: j.northStar.status === 'proposed' ? 'proposed' : 'adopted'
        }
      : null;
    const ledger = Array.isArray(j.ledger) ? j.ledger.filter(e => e && typeof e === 'object').map(e => ({
      at: Number(e.at) || 0,
      outcome: String(e.outcome || ''),
      reason: String(e.reason || ''),
      title: String(e.title || '')
    })) : [];
    return {
      enabled: j.enabled !== false,
      northStar: ns,
      lastCycleAt: Number(j.lastCycleAt) || 0,
      dueAt: Number(j.dueAt) || 0,
      due: !!j.due,
      why: j.why || null,
      binding: j.binding || null,
      inFlight: !!j.inFlight,
      openCount: Number(j.openCount) || 0,
      ledger: ledger
    };
  }

  async function refetch() {
    if (inflight) return;
    inflight = true;
    try {
      const res = await fetch('/api/quests/refresh', { cache: 'no-store' });   // hardened window.fetch attaches the apiauth token
      if (res.ok) {
        const j = await res.json().catch(() => null);
        const s = shape(j);
        if (s) { cache = s; lastFetch = Date.now(); }
      }
    } catch (_) { /* fail-soft: keep the last-good cache, never blank the panel */ }
    finally { inflight = false; }
  }

  // THROTTLED poll — safe to call every tick + every quest-log render. Only actually hits the network once the
  // POLL_MS window has elapsed since the last good fetch (or on the very first call / after a run reset it).
  function sync() {
    if (Date.now() - lastFetch >= POLL_MS) refetch();   // fire-and-forget; the cache read stays synchronous
  }

  // ---- synchronous read (the panel consumes this off the last-good cache) ----
  function status() { return cache; }
  function isRunning() { return running || !!(cache && cache.inFlight); }

  // ---- write: force a refresh cycle NOW (the REFRESH QUESTS button). Honest reply: { ok, started, error }.
  // Immediately refetches so the ledger/inFlight reflect the launch without waiting for the next poll.
  async function run() {
    if (running) return { ok: false, started: false, error: 'a refresh is already running' };
    running = true;
    let out = { ok: false, started: false, error: 'refresh failed' };
    try {
      const res = await fetch('/api/quests/refresh/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await res.json().catch(() => null);
      out = j && typeof j === 'object' ? { ok: !!j.ok, started: !!j.started, error: j.error || '' } : out;
    } catch (_) { out = { ok: false, started: false, error: 'could not reach the station' }; }
    finally { running = false; lastFetch = 0; await refetch(); }   // immediate: inFlight/ledger reflect the launch now
    return out;
  }

  // init on enter-game: a clean fetch so the first quest-log render already has the status (the tick keeps it fresh).
  function init() { cache = null; lastFetch = 0; running = false; refetch(); }
  // a fresh Commander inherits no cached status (mirrors the sibling stores' reset).
  function reset() { cache = null; lastFetch = 0; running = false; }

  return { init, sync, status, isRunning, run, reset, _shape: shape };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { QuestRefreshStore };
