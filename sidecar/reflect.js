/* sidecar/reflect.js — Cortex M-mem.5 reflection: a PURE post-run "what's worth remembering?" producer.
   Given a run's conversation + an INJECTED aux-model `propose(prompt) -> text`, it builds a reflection
   prompt, parses the model's tagged lines into candidate memory records, and guardrails them (redact
   secrets §5.6, trim, cap length + count, dedup vs the existing store and within the batch) — so the
   turn-in beat (M-mem.5b) can offer Keep / Edit / Discard.

   No IO, no ambient time/rng: `clock`, `propose`, and `redact` are injected, so it is deterministic and
   replay-safe. Auto-proposals are CANDIDATES ONLY — they never auto-write (§5.6, D-mem.1). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).reflect = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KIND = { FACT: 'fact', SKILL: 'skill', PREFERENCE: 'profile', PROFILE: 'profile', NOTE: 'note' };
  const MAX_CONTENT = 280;        // a memory is a short durable belief, not a transcript
  const DEFAULT_MAX = 5;          // never dump a wall of proposals at the turn-in beat
  const PROMPT_CAP = 4000;        // chars of recent exchange fed to the aux model
  const LINE = /^\s*[-*•]?\s*(FACT|SKILL|PREFERENCE|PROFILE|NOTE)\s*[:\-—]\s*(.+?)\s*$/i;

  // the reflection prompt: the recent user/assistant exchange (system + tool turns stripped), tail-capped.
  function buildPrompt(messages, cap) {
    cap = cap || PROMPT_CAP;
    const turns = [];
    for (const msg of (Array.isArray(messages) ? messages : [])) {
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const c = typeof msg.content === 'string' ? msg.content : '';
      if (c) turns.push((msg.role === 'user' ? 'USER: ' : 'AGENT: ') + c);
    }
    let body = turns.join('\n');
    if (body.length > cap) body = body.slice(body.length - cap);   // keep the most recent exchange
    return 'From this exchange, list ONLY durable facts, preferences, or skills worth remembering for future ' +
      'runs — one per line, each tagged FACT:, PREFERENCE:, or SKILL:. Skip anything transient or already ' +
      'obvious. If nothing is worth keeping, reply NONE.\n\n' + body;
  }

  // parse the aux model's reply into {kind, content} candidates; untagged lines are ignored (conservative).
  function parse(raw) {
    const out = [];
    for (const ln of String(raw == null ? '' : raw).split('\n')) {
      const m = LINE.exec(ln);
      if (!m) continue;
      const content = m[2].trim();
      if (content) out.push({ kind: KIND[m[1].toUpperCase()] || 'note', content: content });
    }
    return out;
  }

  const textOf = r => (r && (r.content != null ? r.content : ((r.title || '') + ' ' + (r.body || '')))) || '';

  // reflect(run, {propose, clock, redact, existing, max}) -> { proposals[], prompt }
  // run: { agentId, runId, messages }.  proposals: { id, kind, content, scope, streamId, sourceRunId, createdAt }.
  async function reflect(run, opts) {
    run = run || {}; opts = opts || {};
    const clock = opts.clock || { now: () => 0 };
    const redact = typeof opts.redact === 'function' ? opts.redact : (x => x);
    const max = opts.max || DEFAULT_MAX;
    const propose = opts.propose;
    if (typeof propose !== 'function') return { proposals: [] };

    const prompt = buildPrompt(run.messages, PROMPT_CAP);
    let raw;
    try { raw = await propose(prompt); } catch (_) { return { proposals: [], prompt: prompt }; }   // a failed reflection never hurts the run

    const seen = {};
    for (const r of (Array.isArray(opts.existing) ? opts.existing : [])) seen[textOf(r).trim().toLowerCase()] = 1;
    const now = clock.now();
    const proposals = [];
    for (const cand of parse(raw)) {
      let content = redact(String(cand.content)).trim();
      if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT - 1) + '…';
      const key = content.toLowerCase();
      if (!content || seen[key]) continue;        // drop empties + dupes (vs existing AND earlier proposals)
      seen[key] = 1;
      proposals.push({
        id: 'prop_' + (proposals.length + 1), kind: cand.kind, content: content,
        scope: 'global', streamId: null, sourceRunId: run.runId || null, createdAt: now
      });
      if (proposals.length >= max) break;
    }
    return { proposals: proposals, prompt: prompt };
  }

  return { reflect, buildPrompt, parse };
});
