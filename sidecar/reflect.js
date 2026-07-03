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

  // Accepted kinds match the advertised FACT/PREFERENCE/SKILL contract. NOTE was dropped: it was a loose
  // catch-all the model used for run-specific chatter ("we discussed X"), which is exactly the low-value noise
  // the Commander complained about. KIND_LABEL keeps 'note' for legacy KEPT records, but reflection no longer mints it.
  const KIND = { FACT: 'fact', SKILL: 'skill', PREFERENCE: 'profile', PROFILE: 'profile' };
  const KIND_LABEL = { fact: 'Fact', skill: 'Skill', profile: 'Preference', note: 'Note' };
  const MAX_CONTENT = 280;        // a memory is a short durable belief, not a transcript
  const MIN_CONTENT = 8;          // below this it isn't a durable belief — a value floor against trivia
  const MIN_TOKENS = 2;           // a belief needs at least this many significant (non-stopword) words
  const DEFAULT_MAX = 5;          // never dump a wall of proposals at the turn-in beat
  const PROMPT_CAP = 4000;        // chars of recent exchange fed to the aux model
  const MIN_REFLECT_CHARS = 200;  // skip reflection on trivial exchanges (one cheap call still costs)
  const LINE = /^\s*[-*•]?\s*(FACT|SKILL|PREFERENCE|PROFILE)\s*[:\-—]\s*(.+?)\s*$/i;
  // transient openers that mark a line as run-specific narration rather than a durable belief — dropped by the floor.
  const TRANSIENT = /^(the user (said|asked|wanted|mentioned|requested)|we (discussed|talked|covered|went over)|in this (run|task|session|conversation)|this (run|task|session)|today (i|we)|the (task|conversation) (was|is))\b/i;

  // strip a recall fence the model may have echoed, so a forged <recalled-memory> block can't be reflected
  // into a durable memory (mirrors context.stripRecallFence — kept inline so reflect stays standalone).
  const RECALL_FENCE = /<recalled-memory>[\s\S]*?<\/recalled-memory>|<\/?recalled-memory>/gi;

  // the reflection prompt: the recent user/assistant exchange (system + tool turns stripped), tail-capped.
  function buildPrompt(messages, cap) {
    cap = cap || PROMPT_CAP;
    const turns = [];
    for (const msg of (Array.isArray(messages) ? messages : [])) {
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const c = typeof msg.content === 'string' ? msg.content.replace(RECALL_FENCE, '') : '';
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
      const kind = KIND[m[1].toUpperCase()];
      if (content && kind) out.push({ kind: kind, content: content });
    }
    return out;
  }

  const textOf = r => (r && (r.content != null ? r.content : ((r.title || '') + ' ' + (r.body || '')))) || '';

  // near-duplicate guard (Hermes-parity Jaccard; mirrors memcore.tokenJaccard, inlined so reflect stays standalone):
  // exact-text dedup misses PARAPHRASES ("prefers npm start" vs "the user prefers running npm start"), which would
  // re-surface a belief the user already kept and clutter the turn-in beat. Drop a candidate >= SIM_THRESHOLD-similar.
  const SIM_THRESHOLD = 0.6;
  const SIM_STOP = new Set(('a an the of to in on for and or but is are was were be been it its this that with as at by from your you i we they').split(/\s+/));
  function simTokens(s) {
    const set = new Set();
    for (const t of String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3 && !SIM_STOP.has(t)) set.add(t);
    return set;
  }
  function jaccard(a, b) {
    const A = simTokens(a), B = simTokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }

  // the VALUE FLOOR: a deterministic backstop against the low-value memories the prompt alone failed to suppress.
  // Reject content that is too short to be a durable belief, carries too few significant words, or is run-specific
  // narration ("we discussed X", "the task was Y"). Conservative on purpose — better to drop a borderline line than
  // to keep cluttering the turn-in beat with trivia (the user's "remembers things that don't matter" complaint).
  // significant-word count for the FLOOR only: like simTokens but admits 2-char tech names (Go, AI, ML, Vi) so a
  // terse-but-real belief ("prefers Go", "expert in AI") isn't swallowed. Dedup still uses the stricter >=3 simTokens.
  function floorTokens(s) {
    const set = new Set();
    for (const t of String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 2 && !SIM_STOP.has(t)) set.add(t);
    return set.size;
  }
  function lowValue(content) {
    const c = String(content == null ? '' : content).trim();
    if (c.length < MIN_CONTENT) return true;
    if (floorTokens(c) < MIN_TOKENS) return true;
    if (TRANSIENT.test(c)) return true;
    return false;
  }

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
    const priorTexts = [];   // existing beliefs + already-accepted proposals, for near-dupe (paraphrase) rejection
    for (const r of (Array.isArray(opts.existing) ? opts.existing : [])) { const t = textOf(r).trim(); seen[t.toLowerCase()] = 1; if (t) priorTexts.push(t); }
    const now = clock.now();
    const proposals = [];
    for (const cand of parse(raw)) {
      let content = redact(String(cand.content)).trim();
      if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT - 1) + '…';
      const key = content.toLowerCase();
      if (!content || seen[key]) continue;        // drop empties + EXACT dupes (vs existing AND earlier proposals)
      if (lowValue(content)) continue;            // drop trivia / run-specific narration (the value floor)
      let near = false;                           // drop PARAPHRASE dupes (Jaccard) vs the same set
      for (const pt of priorTexts) { if (jaccard(pt, content) >= SIM_THRESHOLD) { near = true; break; } }
      if (near) continue;
      seen[key] = 1; priorTexts.push(content);
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

  // did the run do REAL WORK — i.e. actually reach for a tool (the project's honest "real work" signal: a tool-role
  // result, or an assistant turn carrying tool_calls)? A run answered purely from the model's own knowledge did not.
  function usedTools(messages) {
    for (const m of (Array.isArray(messages) ? messages : [])) {
      if (!m) continue;
      if (m.role === 'tool') return true;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
    }
    return false;
  }

  // SALIENCE GATE (decision 3 — "fire on the worth of the work"). PURELY ADDITIVE over the old worthReflecting floor:
  // it keeps the same real-exchange baseline (so nothing that reflected before is suppressed — decision 2: never
  // silently drop a memory the user would want), and ADDS two reasons a SHORT run still earns a reflection pass:
  // real tool work, or a RECURRING task shape. What's "durable vs basic" is decided downstream by reflect()'s value
  // floor + the model's NONE reply — NOT by a char count here (a char gate can't tell a terse durable preference
  // from a quick Q&A, so using one to suppress would drop real short memories).
  function reflectSalient(messages, recurring) {
    const arr = Array.isArray(messages) ? messages : [];
    let chars = 0, hasUser = false, hasAgent = false;
    for (const m of arr) {
      if (!m || typeof m.content !== 'string') continue;
      if (m.role === 'user') { hasUser = true; chars += m.content.length; }
      else if (m.role === 'assistant') { hasAgent = true; chars += m.content.length; }
    }
    const tools = usedTools(arr);
    if (!hasUser || (!hasAgent && !tools)) return false;   // need a user turn + (a reply OR real tool work)
    if (recurring) return true;                            // recurring shape — pick up on it even when terse (decision 3)
    if (tools) return true;                                // real tool work — worth a durable-fact pass even when terse
    return chars >= MIN_REFLECT_CHARS;                     // else the SAME real-exchange floor as before (no regression)
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
  // (the agent proposed something not worth remembering); Veto = negative (the silent-save UX: the user undid an
  // auto-saved memory — the same "not worth remembering" signal as a discard) — so confidence honestly tracks
  // proposal acceptance across BOTH the old confirm deck and the new one-tap veto.
  function feedbackFor(verdict) {
    if (verdict === 'keep') return { delta: 2, reason: 'kept' };
    if (verdict === 'edit') return { delta: 1, reason: 'edited' };
    if (verdict === 'discard') return { delta: -1, reason: 'discarded' };
    if (verdict === 'veto') return { delta: -1, reason: 'vetoed' };
    return null;   // unknown verdict -> no feedback
  }

  // HIGH-STAKES GATE (silent-save UX): most reflection proposals now auto-save with no user confirmation, but a
  // conservative set must NOT — they fall back to the old Keep/Edit/Discard confirm deck. A proposal is high-stakes
  // when its content carries a CREDENTIAL / PII shape (an api key, password, token, or secret; an email, phone
  // number, or street address) or a STANDING-INSTRUCTION phrasing ("always …", "never …", "from now on …") — the
  // kind of durable directive the Commander should get to approve before it silently steers every future run.
  // Deliberately conservative (better to auto-save a borderline line than to nag on the common case): redact()
  // already ran upstream, so a live secret is usually already scrubbed — this is the belief-shaped backstop.
  const HIGH_STAKES = [
    /\bapi[\s_-]?keys?\b/i,                 // "api key", "api_key"
    /\bpasswords?\b/i,
    // bare "token(s)" is deliberately NOT matched — in an AI harness ordinary memories talk about token
    // budgets/costs/limits constantly; only credential-shaped token phrases are high-stakes.
    /\b(?:access|auth|bearer|secret|refresh|session|oauth)[\s_-]?tokens?\b/i,
    /\bsecrets?\b/i,
    /\bcredentials?\b/i,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,               // an email address
    /\+?\d(?:[\s().-]*\d){9,}/,                                      // a phone number (>=10 digits, common seps between)
    /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+)*\s+(?:st(?:reet)?|ave(?:nue)?|road|rd|blvd|boulevard|lane|ln|drive|dr|court|ct|way|place|pl)\b/i,   // a street address
    /(?:^|[^A-Za-z])(?:always|never)\b/i,                           // a standing instruction ("always …", "never …")
    /\bfrom now on\b/i
  ];
  function highStakes(content) {
    const c = String(content == null ? '' : content);
    if (!c.trim()) return false;
    for (const re of HIGH_STAKES) if (re.test(c)) return true;
    return false;
  }

  return { reflect, buildPrompt, parse, worthReflecting, usedTools, reflectSalient, recordFromProposal, feedbackFor, highStakes, KIND_LABEL };
});
