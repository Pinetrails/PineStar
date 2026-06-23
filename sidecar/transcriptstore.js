/* sidecar/transcriptstore.js — durable per-workstream conversation transcript (P0.1).

   The spend ledger records the COST of a run; runstore.js records the OUTCOME (one line per finished
   run). NEITHER keeps WHAT was said: `runstore.js`'s own header notes "the full message log is discarded
   once the SSE stream closes." So a sidecar restart wipes the agent's memory of the actual dialogue — the
   single most jarring day-to-day regression vs a Hermes-class agent (which resumes its transcript). This
   module closes that: an append-only, per-stream conversation log on the sidecar's own disk (the app-data
   WORKSPACES dir that survives a browser wipe), so a restart can reload the recent dialogue per workstream.

   Same discipline as its siblings (runstore/ledger): PURE given an injected `io` (readAll/append — the host
   owns the fsync'd disk append) and `clock`. No ambient time/IO, so it passes lint-determinism and tests
   headlessly with an in-memory io. A missing/corrupt store -> empty history (fail-open; a run is NEVER
   crashed by an unreadable transcript). Content is run through the injected `redact` on write so a
   secret-shaped token can't be laundered into a durable file (consistent with the SSE/NDJSON redaction).

   It lives at <root>/transcript.jsonl — a SIBLING of the fs jail (<root>/<agentId>/), so the agent's own
   fs.* tools can neither read nor corrupt the record of its own conversations. It holds no key (those are
   stored separately and never appear in message content after redaction).

     makeTranscriptStore({ io, clock, redact?, limit? }) -> {
       append({ streamId, agentId, role, content }) -> entry,   // stamps ts, redacts content, appends, returns it
       history(streamId, { limit }?) -> entry[],   // CHRONOLOGICAL (oldest-first) for replay; last `limit` of that stream
       all() -> entry[],   count() -> int
     } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).transcriptstore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // same workstream grammar index.js validates streamId against
  const ROLES = { user: 1, assistant: 1, tool: 1, system: 1 };
  const DEFAULT_LIMIT = 400;        // a sane cap so history() never returns an unbounded transcript
  const CONTENT_MAX = 200000;       // per-turn guard against a pathological payload bloating the file
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }

  function makeTranscriptStore(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const redact = typeof opts.redact === 'function' ? opts.redact : (s) => s;
    const cap = num(opts.limit) || DEFAULT_LIMIT;

    // in-memory mirror loaded once; append keeps RAM + disk in lockstep so history() is O(n) over RAM.
    let rows = [];
    try { const raw = io.readAll(); if (Array.isArray(raw)) rows = raw.filter(r => r && typeof r === 'object'); }
    catch (e) { rows = []; }

    // a bad/missing streamId collapses to 'global' — exactly index.js's rule (bad streamId -> the global stream).
    function normStream(v) { const s = str(v); return SID_RE.test(s) ? s : 'global'; }

    function append(e) {
      e = e || {};
      let content = str(e.content).slice(0, CONTENT_MAX);
      try { content = str(redact(content)).slice(0, CONTENT_MAX); } catch (_) { /* redact must never crash a run */ }
      const entry = {
        streamId: normStream(e.streamId),
        agentId: str(e.agentId),
        role: ROLES[e.role] ? e.role : 'user',     // clamp to the known enum
        content: content,
        ts: num(e.ts) || clock.now()
      };
      rows.push(entry);
      try { io.append(entry); } catch (_) { /* persistence failure must never crash the run; RAM mirror still answers */ }
      return entry;
    }

    // the recent dialogue for ONE workstream, oldest-first (ready to replay back into COMMS). We keep the LAST
    // `limit` turns of that stream (the most recent), then return them in chronological order.
    function history(streamId, o) {
      o = o || {};
      const limit = num(o.limit) > 0 ? num(o.limit) : cap;
      const want = normStream(streamId);
      const out = [];
      for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
        if (rows[i].streamId === want) out.push(Object.assign({}, rows[i]));
      }
      out.reverse();   // newest-first scan -> chronological for replay
      return out;
    }

    return {
      append, history,
      all() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; },
      _internals: { normStream, SID_RE }
    };
  }

  return { makeTranscriptStore, _internals: { SID_RE, ROLES } };
});
