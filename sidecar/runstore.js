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
     record({ runId, agentId, reason, turns, tokens, usd, title, artifacts? }) -> entry,   // stamps ts, appends, returns it
     list(agentId?, { limit }?) -> entry[]   // newest-first; filtered to agentId when given; capped
     all() -> entry[],   count() -> int
   }

   Work-visibility slice 1 (ADDITIVE): `artifacts` — what the run PRODUCED, as small sanitized records
   ({ kind:'file'|'image'|'message', path?, target?, bytes? }, max 50, strings cut at 260). Collected by
   sidecar/artifacts.js during the run; defaults to []. Rows persisted before the field existed simply
   lack it and still parse/list fine (fail-open — proven in runstore.test.js). */
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
  const ARTIFACT_KINDS = { file: 1, image: 1, message: 1 };
  const ARTIFACTS_MAX = 50;         // a run that writes 500 files still records a bounded row
  const ARTIFACT_STR_MAX = 260;     // classic MAX_PATH — a path/target is a display label, not a blob
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function modelName(v) { const s = str(v).trim(); return (s || UNKNOWN_MODEL).slice(0, 80); }
  // sanitize the collector's artifact records at the persistence boundary (defense in depth: the collector
  // already caps, but a foreign caller can't write an unbounded/garbage blob into the append-only log).
  function artifactList(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const a of v) {
      if (out.length >= ARTIFACTS_MAX) break;
      if (!a || typeof a !== 'object' || !ARTIFACT_KINDS[a.kind]) continue;
      const rec = { kind: a.kind };
      if (a.path != null && str(a.path)) rec.path = str(a.path).slice(0, ARTIFACT_STR_MAX);
      if (a.target != null && str(a.target)) rec.target = str(a.target).slice(0, ARTIFACT_STR_MAX);
      if (typeof a.bytes === 'number' && isFinite(a.bytes) && a.bytes >= 0) rec.bytes = Math.floor(a.bytes);
      if (rec.path || rec.target) out.push(rec);
    }
    return out;
  }

  // RAM mirror ceiling: the largest served query is list({ limit: 1000 }) (insights) / 500 (run list), so keep
  // generous headroom (~3x) and splice the oldest off when the in-process mirror grows past it. On-disk history
  // stays complete (the append-only log + its rotated segment); only the RAM mirror is bounded so a 24/7 process
  // can't grow it without limit. Disk boot-load is already bounded (readBoundedJsonl), so this matches behavior:
  // the whole-station insights fold already reads only the most-recent bounded window, never lifetime history.
  const RAM_ROWS_MAX = 3000;

  function makeRunStore(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const cap = num(opts.limit) || DEFAULT_LIMIT;
    const ramMax = num(opts.ramMax) > 0 ? num(opts.ramMax) : RAM_ROWS_MAX;

    // in-memory mirror loaded once; append keeps RAM + disk in lockstep so list() is O(n) over RAM.
    let rows = [];
    try { const raw = io.readAll(); if (Array.isArray(raw)) rows = raw.filter(r => r && typeof r === 'object'); }
    catch (e) { rows = []; }
    if (rows.length > ramMax) rows = rows.slice(rows.length - ramMax);   // bound even a large bounded-boot load

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
        artifacts: artifactList(e.artifacts),   // work-visibility: what the run PRODUCED (additive; [] default)
        ts: num(e.ts) || clock.now()
      };
      rows.push(entry);
      // bound the RAM mirror: splice the oldest off past the ceiling. Disk keeps the full append-only log; only
      // this in-process array is capped so a long-lived process doesn't leak. The cap is well above every served
      // query horizon (≤1000), so no list()/insights query is ever short-changed within the window it reads.
      if (rows.length > ramMax) rows.splice(0, rows.length - ramMax);
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
