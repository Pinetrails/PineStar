/* sidecar/compaction-summarizer.js — the context-compaction summarizer, extracted from index.js runOnce.

   WHY THIS FILE EXISTS. The in-line summarizer rendered the whole foldable slice to text and then
   `.slice(0, 16000)` — so on a fold that is routinely 300-500k chars the model saw only the OLDEST ~16k and the
   rest of the run's memory was silently discarded. The loop's contract was fine; the INPUT was truncated.

   CHUNKED FOLD. The slice is rendered to text exactly as before, partitioned into chunks of `chunkChars`
   (default 48000, env STARNET_COMPACT_CHUNK_CHARS), never splitting an assistant tool_call from its tool
   results; chunk 1 is folded against the caller's prevSummary and chunk N against the running summary from
   N-1 (the existing H5.2 MERGE prompt) — SEQUENTIALLY, never in parallel, so each call sees the summary so
   far. Spend (usd/tokens/unpricedUsage) is summed. Beyond `maxChunks` (default 12) the remainder is folded as
   ONE final chunk with a `[truncated N chars]` marker in the input, and `truncatedChars` is reported so the
   loop can put it in agent.compact (truthful telemetry: a lossy fold says so).

   Contract consumed by loop.js maybeCompact: summarize(older, prevSummary, live) -> { summary, usd, tokens,
   unpricedUsage?, chunks, truncatedChars }. An abort (signal.aborted) throws mid-chunk — the loop treats a
   throw as a skipped fold, exactly as before. The aux-tier reliability floor (one retry on the run model when a
   cheap aux model fails) is preserved per chunk. */
'use strict';

const DEFAULT_CHUNK_CHARS = 48000;
const DEFAULT_MAX_CHUNKS = 12;

function envInt(name, dflt) {
  const v = parseInt(String(process.env[name] || ''), 10);
  return (Number.isFinite(v) && v > 0) ? v : dflt;
}

// one message -> one text line, byte-identical to the pre-extraction rendering
function renderMessage(mm) {
  const c = (mm && typeof mm.content === 'string') ? mm.content : JSON.stringify((mm && mm.content) || '');
  return (mm && mm.role ? mm.role : 'msg') + ': ' + c;
}

/* Partition messages into chunks by rendered size. A chunk boundary may only fall at a "turn-group start":
   never directly before a role:'tool' message (its owning assistant tool_call would be on the other side).
   A single turn-group larger than chunkChars becomes its own oversized chunk (never split). Pure. */
function partition(messages, chunkChars) {
  const lines = messages.map(renderMessage);
  const groups = [];   // [{ text, chars }]
  for (let i = 0; i < messages.length; i++) {
    const isTool = messages[i] && messages[i].role === 'tool';
    if (isTool && groups.length) { const g = groups[groups.length - 1]; g.text += '\n' + lines[i]; g.chars = g.text.length; }
    else groups.push({ text: lines[i], chars: lines[i].length });
  }
  const chunks = [];
  let cur = '';
  for (const g of groups) {
    if (cur && cur.length + 1 + g.chars > chunkChars) { chunks.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + g.text : g.text;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* makeSummarizer(deps) -> summarize(older, prevSummary, live)
   deps: streamFn(req) async-iterable of provider events (text/usage) — or provider(live)+... (see below)
         cost            — fallback cost engine (live.cost overrides)
         provider        — fallback provider (live.provider overrides)
         model           — fallback run model (live.model overrides)
         auxModelFor()   — cheap aux model or null
         auxEffortFor(provider, model) — per-request reasoning effort or null
         transcriptDrain(older) — STRICT durable-transcript drain, called ONCE before the fold (may throw)
         memoryBlockFor(transcriptText) — durable-memory block to prepend ('' for none)
         summaryPrompt({prevSummary:bool}) — the H5.1/H5.2 system prompt builder
         emit(name, payload) — bus emit for display-only agent.cost
         signal          — AbortSignal
         agentId, runId
         chunkChars, maxChunks */
function makeSummarizer(deps) {
  deps = deps || {};
  const chunkChars = deps.chunkChars || envInt('STARNET_COMPACT_CHUNK_CHARS', DEFAULT_CHUNK_CHARS);
  const maxChunks = deps.maxChunks || envInt('STARNET_COMPACT_MAX_CHUNKS', DEFAULT_MAX_CHUNKS);
  const signal = deps.signal || { aborted: false };
  const emit = typeof deps.emit === 'function' ? deps.emit : () => {};
  const summaryPrompt = deps.summaryPrompt || (() => 'Summarize.');
  const auxModelFor = deps.auxModelFor || (() => null);
  const auxEffortFor = deps.auxEffortFor || (() => null);
  const memoryBlockFor = deps.memoryBlockFor || (() => '');
  const transcriptDrain = deps.transcriptDrain || (() => {});

  async function summarize(older, prevSummary, live) {
    const sProvider = (live && live.provider) || deps.provider;
    const sCost = (live && live.cost) || deps.cost;
    const runModel = (live && live.model) || deps.model;
    const auxModel = auxModelFor();
    const sModel = auxModel || runModel;
    // TRANSCRIPT DRAIN (before the fold) — strict; a throw here leaves the history unfolded (loop contract).
    transcriptDrain(older);

    let chunks = partition(older, chunkChars);
    let truncatedChars = 0;
    if (chunks.length > maxChunks) {
      const keep = chunks.slice(0, maxChunks - 1);
      const rest = chunks.slice(maxChunks - 1);
      const joined = rest.join('\n');
      truncatedChars = Math.max(0, joined.length - chunkChars);
      keep.push(joined.slice(0, chunkChars) + '\n[truncated ' + truncatedChars + ' chars]');
      chunks = keep;
    }

    let running = (typeof prevSummary === 'string' && prevSummary.trim()) ? prevSummary.trim() : '';
    let usd = 0, tokens = 0, produced = false; const unpriced = [];

    async function attempt(useModel, userMsg, hasPrev) {
      const req = { model: useModel, stream: true, signal, messages: [
        { role: 'system', content: summaryPrompt({ prevSummary: hasPrev }) },
        { role: 'user', content: userMsg }
      ] };
      const effort = auxEffortFor(sProvider, useModel);
      if (effort) req.reasoningEffort = effort;
      let out = '', usage = null;
      const it = deps.streamFn ? deps.streamFn(req, sProvider) : sProvider.stream(req);
      for await (const ev of it) {
        if (ev && ev.type === 'text') out += ev.delta;
        else if (ev && ev.type === 'usage') usage = ev.usage;
      }
      const c = sCost ? sCost.reconcile(usage, useModel) : {};
      emit('agent.cost', { agentId: deps.agentId, runId: deps.runId, usd: c.usd || 0, model: useModel, reconciled: true });
      usd += c.usd || 0; tokens += (c.tokensIn || 0) + (c.tokensOut || 0);
      if (c.unpriced) unpriced.push({ model: useModel, tokensIn: c.tokensIn || 0, tokensOut: c.tokensOut || 0 });
      return out.trim();
    }

    for (let n = 0; n < chunks.length; n++) {
      if (signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const transcript = chunks[n];
      let memBlock = '';
      try { memBlock = n === 0 ? (memoryBlockFor(transcript) || '') : ''; } catch (_) { memBlock = ''; }
      const hasPrev = !!running;
      const prevBlock = hasPrev ? 'PREVIOUS SUMMARY (update this — merge the new turns in, drop anything now obsolete):\n' + running + '\n\n' : '';
      const part = chunks.length > 1 ? ' (part ' + (n + 1) + ' of ' + chunks.length + ')' : '';
      const userMsg = (memBlock ? memBlock + '\n\n' : '') + prevBlock + 'Summarize this earlier part of the conversation' + part + ' so it can replace the raw turns:\n\n' + transcript;
      let out;
      // AUX-TIER RELIABILITY FLOOR: retry ONCE on the run model; an abort is a cancel, never retried.
      if (sModel === runModel) out = await attempt(sModel, userMsg, hasPrev);
      else {
        try { out = await attempt(sModel, userMsg, hasPrev); }
        catch (e) { if (signal.aborted) throw e; out = await attempt(runModel, userMsg, hasPrev); }
      }
      if (out) { running = out; produced = true; }   // an empty chunk summary keeps the running one
    }
    // every chunk came back empty -> '' so the loop refuses to drop history (never fold onto a stale prior summary)
    const r = { summary: produced ? running : '', usd, tokens, chunks: chunks.length, truncatedChars };
    if (unpriced.length) r.unpricedUsage = unpriced;
    return r;
  }
  summarize.drain = transcriptDrain;
  return summarize;
}

module.exports = { makeSummarizer, partition, renderMessage, DEFAULT_CHUNK_CHARS, DEFAULT_MAX_CHUNKS };
