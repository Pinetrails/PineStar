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
  const KIND_LABEL = { fact: 'Fact', skill: 'Skill', profile: 'Preference', note: 'Note' };
  const MAX_CONTENT = 280;        // a memory is a short durable belief, not a transcript
  const DEFAULT_MAX = 5;          // never dump a wall of proposals at the turn-in beat
  const PROMPT_CAP = 4000;        // chars of recent exchange fed to the aux model
  const MIN_REFLECT_CHARS = 200;  // skip reflection on trivial exchanges (one cheap call still costs)
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

  // ---- M-mem.5b turn-in helpers (pure; the host injects now/id/runId so this stays deterministic) ----

  // Is this exchange worth one reflection call? Needs at least one user + one agent string turn and enough
  // total substance — so a trivial "thanks"/"ok" run never burns an aux-model call.
  function worthReflecting(messages, minChars) {
    minChars = minChars == null ? MIN_REFLECT_CHARS : minChars;
    let chars = 0, hasUser = false, hasAgent = false;
    for (const m of (Array.isArray(messages) ? messages : [])) {
      if (!m || typeof m.content !== 'string') continue;
      if (m.role === 'user') { hasUser = true; chars += m.content.length; }
      else if (m.role === 'assistant') { hasAgent = true; chars += m.content.length; }
    }
    return hasUser && hasAgent && chars >= minChars;
  }

  // Map a Kept/Edited proposal into the §5.2 notebook record shape — so rank()/renderRecall AND the legacy
  // title/body readers (notebook.read, the dossier) all render it. `content` (the possibly user-edited belief)
  // mirrors into `body`; `title` is the kind label so a list of typed memories reads cleanly. Stats stay 0 —
  // useCount/trust ride the agent.* event log (memory.used/feedback), never seeded here.
  function recordFromProposal(prop, opts) {
    prop = prop || {}; opts = opts || {};
    const now = opts.now != null ? opts.now : 0;
    const kind = prop.kind || 'note';
    const content = String(opts.content != null ? opts.content : (prop.content || '')).trim();
    return {
      id: opts.id || 'note_1', kind: kind,
      title: KIND_LABEL[kind] || 'Note', body: content, content: content,
      scope: prop.scope || 'global', streamId: prop.streamId || null,
      sourceRunId: opts.runId || prop.sourceRunId || null,
      createdAt: now, ts: now, lastUsedAt: null, useCount: 0, trust: 0, pinned: false
    };
  }

  // The signed trust/XP feedback for a turn-in verdict (§5.7). Keep = strong positive (the user confirmed the
  // agent's judgment); Edit = lighter positive (it was worth keeping but needed fixing); Discard = negative
  // (the agent proposed something not worth remembering) — so confidence honestly tracks proposal acceptance.
  function feedbackFor(verdict) {
    if (verdict === 'keep') return { delta: 2, reason: 'kept' };
    if (verdict === 'edit') return { delta: 1, reason: 'edited' };
    if (verdict === 'discard') return { delta: -1, reason: 'discarded' };
    return null;   // unknown verdict -> no feedback
  }

  return { reflect, buildPrompt, parse, worthReflecting, recordFromProposal, feedbackFor, KIND_LABEL };
});
