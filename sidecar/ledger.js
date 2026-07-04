/* sidecar/ledger.js — the append-only spend logbook. One immutable line per finished run
   ({ runId, agentId, turns, usd, tokens, ts }), so cumulative spend survives restarts and can
   be questioned across runs/agents/days. This is the missing "cron spend ledger" Hermes never
   had (parity study, hole #1) and the substrate budget.js governs over.

   PURE given its injected edges: `io` (the disk adapter — readAll/append, provided by the Node
   host) and `clock` (now()). No ambient time/IO here, so it passes lint-determinism and is
   testable headlessly with an in-memory io. The host owns the atomic file append.

   makeLedger({ io, clock, dayMs? }) -> {
     record({ runId, agentId, turns, usd, tokens }) -> entry,   // stamps ts, appends, returns it
     recordStrict({ runId, agentId, turns, usd, tokens }) -> entry, // same, but append failure throws
     all() -> entry[],            count() -> int,
     totalUsd() -> number,                                       // every recorded run, ever
     usdSince(ts) -> number,      usdForDay(now?) -> number,     // trailing `dayMs` window
     usdForRun(runId) -> number,  usdForAgent(agentId) -> number
   } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).ledger = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const UNKNOWN_MODEL = '(unknown)';
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function modelName(v) { const s = str(v).trim(); return (s || UNKNOWN_MODEL).slice(0, 80); }

  function makeLedger(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const dayMs = opts.dayMs || DAY_MS;

    // in-memory mirror of the on-disk log, loaded once. Append keeps it and disk in lockstep so
    // queries are O(n) over RAM, never a re-read per question. A corrupt/missing file -> empty (fail-open;
    // a budget can't read what was never written, so it degrades to "unspent", never crashes a run).
    //
    // DELIBERATELY NOT RAM-TRIMMED (unlike runstore/transcript): every query here AGGREGATES over the full
    // `rows` — totalUsd()/usdForDay()/usdSince()/usdForAgent() sum arbitrary-ts predicate windows, and budget.js
    // governs day/global spend pools off these sums. Splicing the oldest rows would silently UNDER-COUNT spend
    // and hand a capped Commander unintended headroom — the exact "app lies about state" failure this hardening
    // exists to prevent. The boot load is already bounded (readBoundedJsonl caps it at ~LOG_MAX_BYTES of the
    // newest lines), and in-process growth over a single session is far below that cap, so RAM stays bounded
    // WITHOUT trimming. If lifetime-accurate totals past the boot cap are ever needed, keep running totals on a
    // rolled segment — do NOT trim these rows. (Documented in the Phase-5 report + docs/PERSISTENCE_HARDENING.md.)
    let rows = [];
    try { const raw = io.readAll(); if (Array.isArray(raw)) rows = raw.filter(r => r && typeof r === 'object'); }
    catch (e) { rows = []; }

    function makeEntry(e) {
      e = e || {};
      return {
        runId: str(e.runId), agentId: str(e.agentId),
        turns: num(e.turns), usd: num(e.usd), tokens: num(e.tokens),
        model: modelName(e.model),
        unmetered: !!e.unmetered,
        ts: num(e.ts) || clock.now()
      };
    }

    function record(e) {
      const entry = makeEntry(e);
      rows.push(entry);
      try { io.append(entry); } catch (_) { /* persistence failure must never crash the run; RAM mirror still answers */ }
      return entry;
    }

    function recordStrict(e) {
      const entry = makeEntry(e);
      io.append(entry);
      rows.push(entry);
      return entry;
    }

    function sum(pred) { let t = 0; for (let i = 0; i < rows.length; i++) if (!pred || pred(rows[i])) t += num(rows[i].usd); return t; }

    return {
      record,
      recordStrict,
      all() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; },
      totalUsd() { return sum(null); },
      usdSince(ts) { ts = num(ts); return sum(r => num(r.ts) >= ts); },
      usdForDay(now) { const n = num(now) || clock.now(); return sum(r => num(r.ts) > n - dayMs); },
      usdForRun(runId) { runId = str(runId); return sum(r => r.runId === runId); },
      usdForAgent(agentId) { agentId = str(agentId); return sum(r => r.agentId === agentId); }
    };
  }

  return { makeLedger };
});
