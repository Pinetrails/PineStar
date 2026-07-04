/* sidecar/transcriptstore.js — durable per-workstream conversation transcript (P0.1).

   The spend ledger records the COST of a run; runstore.js records the OUTCOME (one line per finished
   run). NEITHER keeps WHAT was said: `runstore.js`'s own header notes "the full message log is discarded
   once the SSE stream closes." So a sidecar restart wipes the agent's memory of the actual dialogue — the
   single most jarring day-to-day regression vs a production-class agent (which resumes its transcript). This
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
    function tokenize(s) { return (str(s).toLowerCase().match(/[a-z0-9]+/g)) || []; }

    // H1.3: keyword recall over ONE stream's transcript — the substrate for the agent-callable recall_conversation
    // tool, so it can find weeks-old dialogue no longer in context. Lightweight BM25-ish: rank a row by how many
    // DISTINCT query terms it contains (primary), then total term frequency, then recency. Dependency-free + pure.
    function search(streamId, query, o) {
      o = o || {};
      const limit = num(o.limit) > 0 ? Math.min(num(o.limit), 50) : 10;
      const terms = Array.from(new Set(tokenize(query)));
      if (!terms.length) return [];
      const want = normStream(streamId);
      const scored = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.streamId !== want) continue;
        const tf = {}; for (const t of tokenize(r.content)) tf[t] = (tf[t] || 0) + 1;
        let distinct = 0, freq = 0;
        for (const t of terms) { if (tf[t]) { distinct++; freq += tf[t]; } }
        if (distinct) scored.push({ idx: i, role: r.role, content: r.content, ts: r.ts, score: distinct * 1000 + freq });
      }
      scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts) || (b.idx - a.idx));
      return scored.slice(0, limit).map(x => ({ role: x.role, content: x.content, ts: x.ts, score: x.score }));
    }

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
      // H1.1: optional structured fields so a RESUME can rebuild the EXACT OpenAI-format turn — an assistant's
      // tool_calls and a tool result's tool_call_id. Redacted like content; absent fields => byte-identical to before.
      if (e.toolCalls != null) {
        let tc = '';
        try { tc = str(redact(typeof e.toolCalls === 'string' ? e.toolCalls : JSON.stringify(e.toolCalls))).slice(0, CONTENT_MAX); } catch (_) {}
        if (tc) entry.toolCalls = tc;
      }
      if (e.toolCallId != null) { const id = str(e.toolCallId).slice(0, 200); if (id) entry.toolCallId = id; }
      rows.push(entry);
      try { io.append(entry); } catch (_) { /* persistence failure must never crash the run; RAM mirror still answers */ }
      return entry;
    }

    // H1.1: append a SLICE of an OpenAI-format messages array (a run's new turns) as full transcript rows —
    // user / assistant (with tool_calls) / tool (with tool_call_id). Skips injected 'system' fences (recall,
    // loop-guard, compaction) so the transcript stays the real dialogue. Returns the count appended. PURE +
    // testable: the host passes result.messages + the pre-loop boundary index.
    function appendTurns(streamId, agentId, messages, fromIndex) {
      if (!Array.isArray(messages)) return 0;
      let n = 0;
      for (let i = Math.max(0, num(fromIndex)); i < messages.length; i++) {
        const m = messages[i];
        if (!m || !ROLES[m.role] || m.role === 'system') continue;
        const content = (typeof m.content === 'string') ? m.content
          : (Array.isArray(m.content) ? m.content.map(p => (p && typeof p.text === 'string') ? p.text : '').join(' ') : '');
        append({ streamId: streamId, agentId: agentId, role: m.role, content: content, toolCalls: m.tool_calls, toolCallId: m.tool_call_id });
        n++;
      }
      return n;
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

    // H1.2: rebuild the recent dialogue for a stream as an OpenAI-format messages array, so a fresh run (empty
    // browser history) can RESUME exact prior state. Pairing-safe: a tool message needs its assistant tool_call,
    // so we drop a leading orphaned 'tool' (truncated-slice start) and strip tool_calls off a trailing assistant
    // whose results got cut — keeping the array valid for the provider.
    function reconstruct(streamId, o) {
      const rows = history(streamId, o);   // chronological, capped
      const out = [];
      for (const r of rows) {
        if (r.role === 'user') out.push({ role: 'user', content: r.content });
        else if (r.role === 'assistant') {
          const m = { role: 'assistant', content: r.content || '' };
          if (r.toolCalls) { try { const tc = JSON.parse(r.toolCalls); if (Array.isArray(tc) && tc.length) m.tool_calls = tc; } catch (_) {} }
          out.push(m);
        } else if (r.role === 'tool') {
          out.push({ role: 'tool', content: r.content, tool_call_id: str(r.toolCallId) });
        }
      }
      while (out.length && out[0].role === 'tool') out.shift();                 // orphaned tool at a truncated start
      const last = out[out.length - 1];
      if (last && last.role === 'assistant' && last.tool_calls) delete last.tool_calls;   // results cut off the end
      return out;
    }

    return {
      append, appendTurns, history, reconstruct, search,
      all() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; },
      _internals: { normStream, SID_RE }
    };
  }

  return { makeTranscriptStore, _internals: { SID_RE, ROLES } };
});
