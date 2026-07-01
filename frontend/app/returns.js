/* STARNET — returns.js : the RETURN RITUAL engine (Game session, Phase G2 / Layer 5).

   Pure decision logic for the "while you were away" loop: which finished runs count as UNATTENDED
   WORK the Commander hasn't collected yet, the durable lastSeenAt heartbeat that defines "away",
   and the pending-crate ledger the OUTBOX renders from. No IO, no clock, no DOM — the caller
   (returnstore.js) owns localStorage + fetch + the live beat; node tests drive this directly.

   HONESTY RULES (Part 4 laws):
     • A digest row is a REAL run row from the sidecar's append-only run history (/api/runs) —
       never synthesized, never padded. reason 'done' only: a max_iters/budget/error run is SLAG
       and already has its own post-mortem path.
     • "Away" is defined by the persisted lastSeenAt heartbeat. A FRESH state (lastSeenAt 0 —
       first ever session) digests NOTHING: no prior attendance means nothing was missed.
     • Once a run is folded into a digest it is marked (digested ring) and NEVER re-listed —
       dismissed = gone, the anti-nag law. The pending ledger is the separate "uncollected crate"
       trail; rating a run resolves it. Both are capped so state can't grow unbounded. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Returns = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DIGEST_CAP = 8;      // max rows one digest beat lists (newest first; the rest stays in run history)
  const PENDING_CAP = 24;    // max uncollected crates tracked (oldest dropped — the OUTBOX shows 5 + counter)
  const DIGESTED_CAP = 200;  // runId ring: once listed, never re-listed
  const TITLE_MAX = 90;

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }

  // hydrate a persisted blob (or null/corrupt) into a sane state object.
  function hydrate(raw) {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return {
      v: 1,
      lastSeenAt: Math.max(0, num(s.lastSeenAt)),
      pending: Array.isArray(s.pending) ? s.pending.filter(r => r && typeof r === 'object' && r.runId).slice(0, PENDING_CAP) : [],
      digested: Array.isArray(s.digested) ? s.digested.filter(id => typeof id === 'string' && id).slice(-DIGESTED_CAP) : []
    };
  }

  // the attendance stamp — monotonic (a stale timer tick can never move it backwards).
  function heartbeat(state, nowMs) {
    const s = hydrate(state);
    s.lastSeenAt = Math.max(s.lastSeenAt, num(nowMs));
    return s;
  }

  /* unattended(state, runs) -> digest rows.
     runs = /api/runs rows (newest-first): { runId, agentId, reason, turns, tokens, usd, title, ts, model }.
     Filters: finished clean ('done'), landed AFTER the last attended moment, not already digested,
     not already pending. Fresh state (lastSeenAt 0) -> [] always. */
  function unattended(state, runs) {
    const s = hydrate(state);
    if (s.lastSeenAt <= 0) return [];                      // first-ever session: nothing was "missed"
    if (!Array.isArray(runs)) return [];
    const digested = {}; for (const id of s.digested) digested[id] = true;
    const pending = {}; for (const r of s.pending) pending[r.runId] = true;
    const out = [];
    for (const r of runs) {
      if (out.length >= DIGEST_CAP) break;
      if (!r || typeof r !== 'object') continue;
      const runId = str(r.runId); if (!runId) continue;
      if (r.reason !== 'done') continue;                   // slag has its own post-mortem path
      if (num(r.ts) <= s.lastSeenAt) continue;             // happened while attended (or before)
      if (digested[runId] || pending[runId]) continue;     // once listed, never re-listed
      out.push({
        runId: runId,
        agentId: str(r.agentId) || 'agent',
        title: str(r.title).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX),
        routine: '',                                       // matchRoutines() fills this best-effort
        usd: Math.max(0, num(r.usd)),
        turns: Math.max(0, num(r.turns)),
        ts: num(r.ts)
      });
    }
    return out;
  }

  // best-effort routine naming: a cron-fired run's recorded title IS the job's prompt (the tick
  // driver sends the prompt as the user message), so a whitespace-normalized match names the row.
  // Purely cosmetic — an unmatched row keeps its honest title.
  function matchRoutines(rows, jobs) {
    if (!Array.isArray(rows) || !Array.isArray(jobs) || !jobs.length) return rows || [];
    const norm = t => str(t).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
    const byPrompt = {};
    for (const j of jobs) { if (j && j.prompt && j.name) byPrompt[norm(j.prompt)] = str(j.name); }
    for (const r of rows) { const hit = byPrompt[norm(r.title)]; if (hit) r.routine = hit; }
    return rows;
  }

  // fold freshly-digested rows into state: mark them digested (never re-listed) and stack them on
  // the pending (uncollected-crate) ledger. FIFO caps on both.
  function fold(state, rows) {
    const s = hydrate(state);
    for (const r of (rows || [])) {
      if (!r || !r.runId) continue;
      if (s.digested.indexOf(r.runId) === -1) s.digested.push(r.runId);
      if (!s.pending.some(p => p.runId === r.runId)) s.pending.push(r);
    }
    if (s.digested.length > DIGESTED_CAP) s.digested = s.digested.slice(-DIGESTED_CAP);
    while (s.pending.length > PENDING_CAP) s.pending.shift();
    return s;
  }

  // a crate was collected (the run got its rating) — drop it from the pending ledger.
  function resolve(state, runId) {
    const s = hydrate(state);
    s.pending = s.pending.filter(p => p.runId !== runId);
    return s;
  }

  function pendingCount(state) { return hydrate(state).pending.length; }
  function oldestPending(state) { const s = hydrate(state); return s.pending.length ? s.pending[0] : null; }

  return { hydrate, heartbeat, unattended, matchRoutines, fold, resolve, pendingCount, oldestPending, DIGEST_CAP, PENDING_CAP };
});
