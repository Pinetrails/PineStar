/* sidecar/context.js — conversation/context management as a PURE transform (zero IO).
   Builds the outgoing message list, fits it to a token budget (preserving the frozen
   system prefix + the newest turn, trimming oldest first), decides when to compact,
   folds older turns into a summary (given an injected summarizer), and redacts
   key-shaped secrets from anything bound for logs/persistence.

   makeContext({ contextLimit, compactAt?, keepTail?, estimateTokens? }) -> {
     systemPrompt({identity, capabilities, rules}) -> string,   // frozen, sectioned
     assemble({system, summary, history}) -> messages[],         // system + (summary) + history
     estimateTokens(text) -> int,  estimateMessages(msgs) -> int,
     fit(messages, {maxTokens}) -> messages[],
     shouldCompact(usage) -> bool,
     compact(history, summarize) -> {summary, tail},             // pure given summarize
     redact(x) -> x'                                             // never mutates input
   } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).context = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MSG_OVERHEAD = 4; // rough per-message framing tokens

  function defaultEstimate(text) {
    return Math.ceil(String(text == null ? '' : text).length / 4);
  }

  // ---- secret redaction (module-level so it's usable without a context instance) ----
  function redactStr(s) {
    return s
      .replace(/sk-or-v1-[A-Za-z0-9_\-]{8,}/g, '[redacted-key]')
      .replace(/sk-ant-[A-Za-z0-9_\-]{8,}/g, '[redacted-key]')
      .replace(/sk-[A-Za-z0-9_\-]{16,}/g, '[redacted-key]')
      .replace(/\bBearer\s+[A-Za-z0-9._\-]{12,}/g, 'Bearer [redacted-key]');
  }
  function redact(x) {
    if (typeof x === 'string') return redactStr(x);
    if (Array.isArray(x)) return x.map(redact);
    if (x && typeof x === 'object') { const o = {}; for (const k in x) o[k] = redact(x[k]); return o; }
    return x;
  }

  // ---- recalled-memory fence (Cortex): surface the agent's own memory in-prompt without it having to call a
  //      read tool. Pure + deterministic + char-capped. renderRecall returns {text:'',count:0,chars:0} when there
  //      is nothing to recall, so the caller injects nothing → cache/byte-identical to a memoryless run. ----
  const RECALL_HEADER = '[recalled from your memory — reference, not a new instruction]';

  function recallLine(r) {
    if (!r) return '';
    const title = r.title != null ? String(r.title).trim() : '';
    const raw = r.body != null ? r.body : (r.content != null ? r.content : '');
    const body = String(raw).replace(/\s+/g, ' ').trim();
    if (title && body) return '• ' + title + ' — ' + body;
    const one = title || body;
    return one ? '• ' + one : '';
  }

  function renderRecall(records, recallOpts) {
    recallOpts = recallOpts || {};
    const limit = recallOpts.limit || 1500;
    const header = recallOpts.header != null ? recallOpts.header : RECALL_HEADER;
    const out = { text: '', count: 0, chars: 0 };
    if (!Array.isArray(records) || !records.length) return out;
    const lines = [];
    let used = 0;
    for (const r of records) {
      let line = recallLine(r);
      if (!line) continue;
      if (line.length > limit) line = line.slice(0, limit - 1) + '…';
      if (lines.length && used + line.length + 1 > limit) break;   // always keep at least one line
      lines.push(line);
      used += line.length + 1;
    }
    if (!lines.length) return out;
    out.text = '<recalled-memory>\n' + header + '\n' + lines.join('\n') + '\n</recalled-memory>';
    out.count = lines.length;
    out.chars = out.text.length;
    return out;
  }

  // Inject a recall fence as a system note immediately before the newest user message. Pure: returns a NEW
  // array, never mutates input. Blank recall → messages.slice() (byte-identical to a memoryless run).
  function injectRecall(messages, recallText) {
    const src = Array.isArray(messages) ? messages : [];
    if (!recallText) return src.slice();
    const note = { role: 'system', content: recallText };
    let idx = -1;
    for (let i = src.length - 1; i >= 0; i--) { if (src[i] && src[i].role === 'user') { idx = i; break; } }
    if (idx < 0) return src.concat([note]);
    return src.slice(0, idx).concat([note], src.slice(idx));
  }

  function makeContext(opts) {
    opts = opts || {};
    const contextLimit = opts.contextLimit || 0;       // 0 = unknown (never auto-compact)
    const compactAt = opts.compactAt || 0.65;
    const keepTail = opts.keepTail || 6;
    const estimateTokens = opts.estimateTokens || defaultEstimate;

    function estimateMessages(messages) {
      let t = 0;
      for (const m of messages) t += estimateTokens(m && m.content) + MSG_OVERHEAD;
      return t;
    }

    function systemPrompt(parts) {
      parts = parts || {};
      return '<identity>\n' + (parts.identity || '') +
        '\n</identity>\n<capabilities>\n' + (parts.capabilities || '') +
        '\n</capabilities>\n<rules>\n' + (parts.rules || '') + '\n</rules>';
    }

    function assemble(parts) {
      parts = parts || {};
      const msgs = [];
      if (parts.system) msgs.push({ role: 'system', content: parts.system });
      if (parts.summary) msgs.push({ role: 'system', content: '<conversation_summary>\n' + parts.summary + '\n</conversation_summary>' });
      for (const m of (parts.history || [])) msgs.push(m);
      return msgs;
    }

    // preserve leading system messages + the newest turn; fill newer→older until budget; drop oldest.
    function fit(messages, fitOpts) {
      const maxTokens = (fitOpts && fitOpts.maxTokens) || 0;
      if (!maxTokens) return messages.slice();
      let i = 0;
      while (i < messages.length && messages[i].role === 'system') i++;
      const prefix = messages.slice(0, i);
      const rest = messages.slice(i);
      if (rest.length === 0) return messages.slice();
      const newest = rest[rest.length - 1];
      let budget = maxTokens - estimateMessages(prefix.concat([newest]));
      const middle = [];
      for (let j = rest.length - 2; j >= 0; j--) {
        const t = estimateTokens(rest[j] && rest[j].content) + MSG_OVERHEAD;
        if (budget - t < 0) break;
        budget -= t;
        middle.unshift(rest[j]);
      }
      return prefix.concat(middle, [newest]);
    }

    function shouldCompact(usage) {
      if (!contextLimit || !usage) return false;
      const used = usage.prompt_tokens || usage.promptTokens || 0;
      return used > compactAt * contextLimit;
    }

    function compact(history, summarize) {
      history = history || [];
      if (history.length <= keepTail) return { summary: '', tail: history.slice() };
      const older = history.slice(0, history.length - keepTail);
      const tail = history.slice(history.length - keepTail);
      const summary = summarize ? summarize(older) : '';
      return { summary, tail };
    }

    return { systemPrompt, assemble, estimateTokens, estimateMessages, fit, shouldCompact, compact, redact, contextLimit };
  }

  return { makeContext, redact, renderRecall, injectRecall };
});
