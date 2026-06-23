/* node test/transcript.test.js — the durable per-workstream conversation transcript (P0.1).
   An in-memory io proves the behavior a daily-driver needs: a turn round-trips, the role is clamped, content
   is length-capped AND redacted on write, history() returns ONE stream's recent turns in chronological order
   capped to the limit, a bad streamId collapses to 'global', and — the headline — the on-disk log replays
   into a fresh store so a SIDECAR RESTART does not wipe the dialogue. Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');

// in-memory io mirroring the host's JSONL adapter (readAll + append).
function memIo() {
  const lines = [];
  return { lines, readAll() { return lines.slice(); }, append(e) { lines.push(e); } };
}
let clk = 1000;
const clock = { now: () => clk };
// a redact stub shaped like the real one (scrubs sk- / Bearer tokens) so we prove redaction is applied on write.
const redact = (s) => String(s).replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]');

// ---- A. append stamps ts from the clock, returns the entry, persists it ----
{
  const io = memIo();
  const s = makeTranscriptStore({ io, clock, redact });
  clk = 1111;
  const e = s.append({ streamId: 'general', agentId: 'agent', role: 'user', content: 'hello there' });
  A.eq(e.streamId, 'general', 'streamId recorded');
  A.eq(e.role, 'user', 'role recorded');
  A.eq(e.content, 'hello there', 'content recorded');
  A.eq(e.ts, 1111, 'ts stamped from injected clock');
  A.eq(s.count(), 1, 'one row');
  A.eq(io.lines.length, 1, 'appended to io');
}

// ---- B. role clamped to the known enum; unknown -> 'user' ----
{
  const s = makeTranscriptStore({ io: memIo(), clock, redact });
  A.eq(s.append({ streamId: 'x', role: 'assistant', content: 'hi' }).role, 'assistant', 'assistant role kept');
  A.eq(s.append({ streamId: 'x', role: 'tool', content: 'r' }).role, 'tool', 'tool role kept');
  A.eq(s.append({ streamId: 'x', role: 'kaboom', content: 'r' }).role, 'user', 'unknown role clamped to user');
  A.eq(s.append({ streamId: 'x', content: 'r' }).role, 'user', 'missing role defaults to user');
}

// ---- C. content is length-capped (no unbounded blob on disk) ----
{
  const s = makeTranscriptStore({ io: memIo(), clock, redact });
  const e = s.append({ streamId: 'x', content: 'y'.repeat(300000) });
  A.ok(e.content.length <= 200000, 'content capped to 200000 chars');
}

// ---- D. redaction applied on write — a secret-shaped token can't be laundered into the durable file ----
{
  const io = memIo();
  const s = makeTranscriptStore({ io, clock, redact });
  const e = s.append({ streamId: 'x', content: 'my key is sk-ABCD1234EFGH5678 ok' });
  A.ok(e.content.indexOf('sk-ABCD1234') === -1, 'secret scrubbed from returned entry');
  A.ok(JSON.stringify(io.lines[0]).indexOf('sk-ABCD1234') === -1, 'secret scrubbed from the persisted line');
}

// ---- E. history(): chronological, filtered by streamId, limit keeps the MOST RECENT n ----
{
  const s = makeTranscriptStore({ io: memIo(), clock, redact });
  clk = 1; s.append({ streamId: 'A', content: 'a1' });
  clk = 2; s.append({ streamId: 'B', content: 'b1' });
  clk = 3; s.append({ streamId: 'A', content: 'a2' });
  clk = 4; s.append({ streamId: 'A', content: 'a3' });
  A.eq(s.history('A').map(r => r.content), ['a1', 'a2', 'a3'], 'stream A in chronological order');
  A.eq(s.history('B').map(r => r.content), ['b1'], 'stream B filtered');
  A.eq(s.history('A', { limit: 2 }).map(r => r.content), ['a2', 'a3'], 'limit keeps the most-recent n, chronological');
  A.eq(s.history('NONE'), [], 'unknown stream -> empty');
}

// ---- F. bad/missing streamId collapses to 'global' (matches index.js's rule) ----
{
  const s = makeTranscriptStore({ io: memIo(), clock, redact });
  A.eq(s.append({ streamId: 'has spaces!', content: 'x' }).streamId, 'global', 'invalid streamId -> global');
  A.eq(s.append({ content: 'x' }).streamId, 'global', 'missing streamId -> global');
  A.eq(s.history('global').length, 2, 'both land in the global stream');
}

// ---- G. durable: a fresh store replays the on-disk log (THE restart round-trip) ----
{
  const io = memIo();
  let s = makeTranscriptStore({ io, clock, redact });
  clk = 10; s.append({ streamId: 'general', role: 'user', content: 'first message' });
  clk = 11; s.append({ streamId: 'general', role: 'assistant', content: 'first reply' });
  clk = 12; s.append({ streamId: 'general', role: 'user', content: 'second message' });
  s = makeTranscriptStore({ io, clock, redact });   // <-- simulate a SIDECAR RESTART: rebuilt from the same disk
  A.eq(s.count(), 3, 'transcript replayed into a fresh store after restart');
  A.eq(s.history('general').map(r => r.content), ['first message', 'first reply', 'second message'], 'dialogue intact + ordered after restart');
}

// ---- H. corrupt/missing log -> empty history, append still works (fail-open) ----
{
  const bad = { readAll() { throw new Error('corrupt'); }, append() {} };
  const s = makeTranscriptStore({ io: bad, clock, redact });
  A.eq(s.count(), 0, 'corrupt log -> empty');
  A.eq(s.append({ streamId: 'x', content: 'still works' }).content, 'still works', 'append still works over a corrupt log');
}

// ---- I. no redact injected -> content passes through unchanged (decoupled) ----
{
  const s = makeTranscriptStore({ io: memIo(), clock });
  A.eq(s.append({ streamId: 'x', content: 'plain text' }).content, 'plain text', 'works without an injected redact');
}

A.report('transcript.test');
