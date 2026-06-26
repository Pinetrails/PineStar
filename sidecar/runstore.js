/* sidecar/runstore.js — the append-only run-history logbook (M-save P4).

   The spend ledger records the COST of each run; this records the OUTCOME — one immutable line per finished
   run ({ runId, agentId, reason, turns, tokens, usd, title, ts }). The full message log is discarded once the
   SSE stream closes, so without this a finished run leaves no durable trace of WHAT happened, only what it
   cost. This is the substrate the plan's "drill any fact to the run that earned it" vision needs, and what a
   future autopsy/replay view reads. It does NOT learn or propose memories — that is the cortex's job, fed by
   the live message array at run end; this is purely the durable record.

   Same split as the ledger: PURE given an injected `io` (readAll/append — the host owns the fsync'd disk
   append) and `clock`. No ambient time/IO, so it passes lint-determinism and tests headlessly with an
   in-memory io. A missing/corrupt file -> empty history (fail-open; a run is never crashed by an unreadable log).

   makeRunStore({ io, clock, limit? }) -> {
     record({ runId, agentId, reason, turns, tokens, usd, title }) -> entry,   // stamps ts, appends, returns it
     list(agentId?, { limit }?) -> entry[]   // newest-first; filtered to agentId when given; capped
     all() -> entry[],   count() -> int
   } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).runstore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REASONS = { done: 1, max_iters: 1, budget: 1, cancelled: 1, error: 1, refusal: 1 };
  const DEFAULT_LIMIT = 200;        // a sane cap so list() never returns an unbounded history
  const TITLE_MAX = 120;
  const UNKNOWN_MODEL = '(unknown)';
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function modelName(v) { const s = str(v).trim(); return (s || UNKNOWN_MODEL).slice(0, 80); }

  function makeRunStore(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const cap = num(opts.limit) || DEFAULT_LIMIT;

    // in-memory mirror loaded once; append keeps RAM + disk in lockstep so list() is O(n) over RAM.
    let rows = [];
    try { const raw = io.readAll(); if (Array.isArray(raw)) rows = raw.filter(r => r && typeof r === 'object'); }
    catch (e) { rows = []; }

    function record(e) {
      e = e || {};
      const entry = {
        runId: str(e.runId), agentId: str(e.agentId),
        reason: REASONS[e.reason] ? e.reason : 'done',     // clamp to the known enum (matches agent.run.end)
        turns: num(e.turns), tokens: num(e.tokens), usd: num(e.usd),
        title: str(e.title).slice(0, TITLE_MAX),
        streamId: str(e.streamId),     // H3.2: the run's workstream — joins this outcome row to its transcript (GET /api/transcript?stream=)
        model: modelName(e.model),   // H3.3/G6: actual model used, or explicit (unknown) as a last resort
        unmetered: !!e.unmetered,    // G6.2: subscription usage is counted, not summed as $0 spend
        ts: num(e.ts) || clock.now()
      };
      rows.push(entry);
      try { io.append(entry); } catch (_) { /* persistence failure must never crash the run; RAM mirror still answers */ }
      return entry;
    }

    function list(agentId, o) {
      o = o || {};
      const limit = num(o.limit) > 0 ? num(o.limit) : cap;
      const want = agentId == null ? null : str(agentId);
      const out = [];
      for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {   // newest-first
        if (want == null || rows[i].agentId === want) out.push(Object.assign({}, rows[i]));
      }
      return out;
    }

    return {
      record, list,
      all() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; }
    };
  }

  return { makeRunStore };
});
