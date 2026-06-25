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
       sessionSearch(args, ctx?) -> object,         // Hermes-like browse/discover/read/scroll over transcript rows
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
    // Stable message ids for Hermes-style anchored scroll. Legacy rows get deterministic in-memory ids from
    // their append position; new rows persist ids, so a restart keeps anchors stable as the transcript grows.
    let nextId = 1;
    rows = rows.map((r, i) => {
      const id = num(r.id) > 0 ? Math.floor(num(r.id)) : i + 1;
      if (id >= nextId) nextId = id + 1;
      return Object.assign({}, r, { id, streamId: normStream(r.streamId) });
    });

    // a bad/missing streamId collapses to 'global' — exactly index.js's rule (bad streamId -> the global stream).
    function normStream(v) { const s = str(v); return SID_RE.test(s) ? s : 'global'; }
    function tokenize(s) { return (str(s).toLowerCase().match(/[a-z0-9]+/g)) || []; }
    function clamp(n, lo, hi, fallback) {
      n = Number(n);
      if (!isFinite(n)) n = fallback;
      n = Math.floor(n);
      return Math.max(lo, Math.min(hi, n));
    }
    function byStream(streamId) {
      const want = normStream(streamId);
      return rows.filter(r => r.streamId === want);
    }
    function shapeMessage(r, anchorId) {
      const out = { id: r.id, streamId: r.streamId, role: r.role, content: r.content, timestamp: r.ts || 0 };
      if (r.toolCalls) out.toolCalls = r.toolCalls;
      if (r.toolCallId) out.toolCallId = r.toolCallId;
      if (anchorId != null && r.id === anchorId) out.anchor = true;
      return out;
    }
    function sessionMeta(streamId) {
      const sid = normStream(streamId);
      const rs = byStream(sid);
      if (!rs.length) return null;
      const first = rs[0], last = rs[rs.length - 1];
      const titleRow = rs.find(r => r.role === 'user' && str(r.content).trim()) || first;
      return {
        sessionId: sid, streamId: sid,
        title: str(titleRow.content).replace(/\s+/g, ' ').slice(0, 120),
        startedAt: first.ts || 0, lastActive: last.ts || 0,
        messageCount: rs.length,
        preview: str(last.content).replace(/\s+/g, ' ').slice(0, 180)
      };
    }
    function streamIdsNewestFirst() {
      const seen = {}, ids = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const sid = rows[i].streamId;
        if (!seen[sid]) { seen[sid] = 1; ids.push(sid); }
      }
      return ids;
    }
    function snippet(content, terms) {
      const text = str(content).replace(/\s+/g, ' ');
      const low = text.toLowerCase();
      let pos = -1;
      for (const t of terms) {
        const p = low.indexOf(t);
        if (p >= 0 && (pos < 0 || p < pos)) pos = p;
      }
      if (pos < 0) return text.slice(0, 240);
      const start = Math.max(0, pos - 80);
      const end = Math.min(text.length, pos + 180);
      return (start ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
    }
    function getWindow(streamId, id, window) {
      const rs = byStream(streamId);
      const anchorId = Math.floor(Number(id) || 0);
      const idx = rs.findIndex(r => r.id === anchorId);
      if (idx < 0) return null;
      const w = clamp(window, 1, 20, 5);
      const start = Math.max(0, idx - w);
      const end = Math.min(rs.length, idx + w + 1);
      return {
        messages: rs.slice(start, end).map(r => shapeMessage(r, anchorId)),
        messagesBefore: start,
        messagesAfter: rs.length - end
      };
    }
    function bookends(streamId, count) {
      const rs = byStream(streamId);
      const n = clamp(count, 0, 10, 3);
      if (!n) return { start: [], end: [] };
      return {
        start: rs.slice(0, n).map(r => shapeMessage(r)),
        end: rs.slice(Math.max(0, rs.length - n)).map(r => shapeMessage(r))
      };
    }

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

    function browseSessions(o) {
      o = o || {};
      const limit = clamp(o.limit, 1, 50, 10);
      const current = o.currentStreamId ? normStream(o.currentStreamId) : null;
      const out = [];
      for (const sid of streamIdsNewestFirst()) {
        if (current && sid === current) continue;
        const meta = sessionMeta(sid);
        if (meta) out.push(meta);
        if (out.length >= limit) break;
      }
      return {
        success: true, mode: 'browse', results: out, count: out.length,
        message: 'Pass query to discover, sessionId to read, or sessionId+aroundMessageId to scroll.'
      };
    }

    function readSession(streamId, o) {
      o = o || {};
      const sid = normStream(streamId);
      const meta = sessionMeta(sid);
      if (!meta) return { success: false, mode: 'read', error: 'sessionId not found: ' + sid };
      const rs = byStream(sid);
      const head = clamp(o.head, 1, 50, 20);
      const tail = clamp(o.tail, 1, 50, 10);
      const truncated = rs.length > head + tail;
      const shaped = (truncated ? rs.slice(0, head).concat(rs.slice(Math.max(head, rs.length - tail))) : rs).map(r => shapeMessage(r));
      const out = { success: true, mode: 'read', sessionId: sid, sessionMeta: meta, messageCount: rs.length, truncated, messages: shaped };
      if (truncated) out.message = 'Session has ' + rs.length + ' messages; showing first ' + head + ' and last ' + tail + '. Use aroundMessageId to scroll the middle.';
      return out;
    }

    function scrollSession(streamId, aroundMessageId, o) {
      o = o || {};
      const sid = normStream(streamId);
      const meta = sessionMeta(sid);
      if (!meta) return { success: false, mode: 'scroll', error: 'sessionId not found: ' + sid };
      const view = getWindow(sid, aroundMessageId, o.window);
      if (!view) return { success: false, mode: 'scroll', error: 'aroundMessageId ' + aroundMessageId + ' not in sessionId ' + sid };
      return Object.assign({ success: true, mode: 'scroll', sessionId: sid, aroundMessageId: Math.floor(Number(aroundMessageId) || 0), sessionMeta: meta, window: clamp(o.window, 1, 20, 5) }, view);
    }

    function ftsDiscover(query, o) {
      o = o || {};
      const terms = Array.from(new Set(tokenize(query)));
      if (!terms.length) return { success: true, mode: 'discover', query: str(query), results: [], count: 0, message: 'No query terms.' };
      const limit = clamp(o.limit, 1, 10, 3);
      const current = o.currentStreamId ? normStream(o.currentStreamId) : null;
      const docs = rows.map(r => tokenize(r.content));
      const df = {};
      for (const toks of docs) {
        const seen = {};
        for (const t of toks) if (!seen[t]) { seen[t] = 1; df[t] = (df[t] || 0) + 1; }
      }
      const N = Math.max(1, rows.length);
      const phrase = terms.join(' ');
      const hits = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (current && r.streamId === current) continue;
        const tf = {};
        for (const t of docs[i]) tf[t] = (tf[t] || 0) + 1;
        let score = 0, distinct = 0, freq = 0;
        for (const t of terms) {
          const f = tf[t] || 0;
          if (!f) continue;
          distinct++; freq += f;
          const d = df[t] || 0;
          const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
          score += idf * ((f * 2.2) / (f + 1.2));
        }
        if (!distinct) continue;
        if (phrase && str(r.content).toLowerCase().indexOf(phrase) >= 0) score += 3;
        score += distinct * 2 + Math.min(freq, 8) * 0.05 + (r.ts || 0) / 1e15;
        hits.push({ row: r, score, idx: i });
      }
      hits.sort((a, b) => (b.score - a.score) || ((b.row.ts || 0) - (a.row.ts || 0)) || (b.idx - a.idx));
      const bySession = {};
      const results = [];
      for (const h of hits) {
        const sid = h.row.streamId;
        if (bySession[sid]) continue;
        bySession[sid] = 1;
        const view = getWindow(sid, h.row.id, o.window);
        const be = bookends(sid, o.bookend == null ? 3 : o.bookend);
        results.push({
          sessionId: sid, streamId: sid, sessionMeta: sessionMeta(sid),
          matchedRole: h.row.role, matchMessageId: h.row.id,
          snippet: snippet(h.row.content, terms), score: h.score,
          bookendStart: be.start, messages: view ? view.messages : [shapeMessage(h.row, h.row.id)],
          bookendEnd: be.end,
          messagesBefore: view ? view.messagesBefore : 0,
          messagesAfter: view ? view.messagesAfter : 0
        });
        if (results.length >= limit) break;
      }
      return { success: true, mode: 'discover', query: str(query), results, count: results.length, sessionsSearched: Object.keys(bySession).length };
    }

    function append(e) {
      e = e || {};
      let content = str(e.content).slice(0, CONTENT_MAX);
      try { content = str(redact(content)).slice(0, CONTENT_MAX); } catch (_) { /* redact must never crash a run */ }
      const entry = {
        id: num(e.id) > 0 ? Math.floor(num(e.id)) : nextId++,
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

    function sessionSearch(args, ctx) {
      args = args || {}; ctx = ctx || {};
      const sessionId = args.sessionId || args.session_id || args.streamId || args.stream;
      const around = args.aroundMessageId != null ? args.aroundMessageId : args.around_message_id;
      const query = args.query;
      const currentStreamId = ctx.currentStreamId || ctx.streamId || null;
      if (sessionId && around != null) return scrollSession(sessionId, around, { window: args.window });
      if (sessionId) return readSession(sessionId, { head: args.head, tail: args.tail });
      if (query && str(query).trim()) return ftsDiscover(query, { limit: args.limit, window: args.window, bookend: args.bookend, currentStreamId });
      return browseSessions({ limit: args.limit, currentStreamId });
    }

    return {
      append, appendTurns, history, reconstruct, search,
      browseSessions, readSession, scrollSession, ftsDiscover, sessionSearch,
      all() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; },
      _internals: { normStream, SID_RE }
    };
  }

  return { makeTranscriptStore, _internals: { SID_RE, ROLES } };
});
