/* sidecar/providers/sanitize.js — tool-call argument repair (Hermes-derived, L2.S1).

   Non-Anthropic models routed via OpenRouter (GLM / Kimi / Qwen / smaller locals) routinely emit
   tool-call argument JSON that is mechanically broken — a trailing comma, an unclosed brace, a raw
   newline inside a string, a doubled closer. The loop's JSON.parse-once then discards the whole call
   as a parseError (registry.js short-circuits it), throwing away an action the model genuinely intended.

   repairToolCallArguments(raw) -> string
     A pure, deterministic, bounded best-effort: returns a STRING that is guaranteed to JSON.parse
     (worst case '{}'). It NEVER invents argument VALUES — every pass is a mechanical syntactic fix
     (strip trailing commas, escape in-string control chars, balance/append/strip delimiters); when no
     pass yields parseable JSON it degrades to '{}'  (recovery of intent, NOT a schema bypass — a tool
     whose schema requires args still correctly fails validation downstream).

   This module is wired into the loop in L2.S2 (behind a new `tool.args.repaired` event); this commit
   ships the pure module + its test only. No clock, no rng, no IO — bounded loops cap at 50 iterations
   so a pathological payload can never spin. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.sanitize = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ITERS = 50;   // hard cap on every repair loop — a deep/pathological payload terminates, never spins.

  function tryParse(s) { try { return { ok: true, value: JSON.parse(s) }; } catch (e) { return { ok: false }; } }

  // Replace raw control chars (U+0000–U+001F) that appear INSIDE a string literal with \uXXXX — strict
  // JSON forbids them unescaped (a literal newline/tab in "..." is the single most common model mistake).
  // Backslash escapes are respected so an already-escaped sequence is left untouched.
  function escapeControlsInStrings(s) {
    let out = '', inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i], code = s.charCodeAt(i);
      if (inStr) {
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { out += ch; inStr = false; continue; }
        if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
        out += ch; continue;
      }
      if (ch === '"') { inStr = true; out += ch; continue; }
      out += ch;
    }
    return out;
  }

  // Rebalance delimiters in one stack-based pass: DROP a spurious closer that doesn't match the current
  // open (a doubled or mis-nested '}'/']' anywhere, not just at the tail), and APPEND closers for anything
  // still open at the end (a dangling string first, then '{'/'[' in correct nesting order). Bounded by MAX_ITERS.
  function balanceDelimiters(s) {
    const stack = [];
    let inStr = false, esc = false, out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        out += ch;
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; out += ch; }
      else if (ch === '{' || ch === '[') { stack.push(ch); out += ch; }
      else if (ch === '}') { if (stack[stack.length - 1] === '{') { stack.pop(); out += ch; } /* else drop spurious */ }
      else if (ch === ']') { if (stack[stack.length - 1] === '[') { stack.pop(); out += ch; } /* else drop spurious */ }
      else out += ch;
    }
    if (inStr) out += '"';   // close a dangling string before its containers
    let guard = 0;
    while (stack.length && guard++ < MAX_ITERS) { const o = stack.pop(); out += (o === '{' ? '}' : ']'); }
    return out;
  }

  const stripTrailingCommas = (s) => s.replace(/,\s*([}\]])/g, '$1');

  // Ordered repair ladder — each pass is tried on the trimmed input; the first to yield parseable JSON wins.
  // The final pass composes the cheap transforms (escape in-string controls -> rebalance -> strip the commas
  // that only become trailing once the closers exist) so a payload needing several fixes at once still recovers.
  const PASSES = [
    ['clean', (s) => s],
    ['trailing-comma', stripTrailingCommas],
    ['escape-controls', escapeControlsInStrings],
    ['balance', balanceDelimiters],
    ['composed', (s) => stripTrailingCommas(balanceDelimiters(escapeControlsInStrings(s)))]
  ];

  function repairToolCallArguments(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (s === '' || s === 'None' || s === 'null' || s === 'undefined') return '{}';   // empties / python-ish nulls
    for (let i = 0; i < PASSES.length; i++) {
      let cand;
      try { cand = PASSES[i][1](s); } catch (e) { continue; }
      if (tryParse(cand).ok) return cand;
    }
    return '{}';   // unrepairable — recover intent as an empty object, NOT a validation bypass
  }

  return {
    repairToolCallArguments,
    _internals: { tryParse, escapeControlsInStrings, balanceDelimiters, stripTrailingCommas, PASSES, MAX_ITERS }
  };
});
