/* STARNET — study.js : the PURE STUDY ENGINE — the dossier's missing Phase B (work → understanding).

   Phase A (dossier.js) is a one-time intake form: the dossier grows ONLY from the Commander's own onboarding
   docs + explicit panel edits (dossierstore.js:9 — "folds nothing automatically"). This engine is Phase B:
   after a SALIENT completed run, the station STUDIES the work (its directive + a transcript slice + the
   existing dossier block) and proposes DOSSIER BELIEF UPDATES, tagged by dimension — observed goals, new pain,
   stack facts, working-style, plus DRIFT/OBSOLETION ("goal X looks shipped — retire it?"). The Commander then
   consents via the same turn-in Keep/Edit/Discard beat (studystore.js + chat.js wire the live half).

   Mirrors sidecar/reflect.js discipline exactly — it is the dossier's counterpart to reflection:
   - PURE + node-testable: `Study` global in the browser, module.exports under node. No IO, no ambient
     time/rng — `clock`, `propose`, and `redact` are INJECTED (deterministic + replay-safe).
   - Reuses reflection's salience philosophy (a real user turn + a reply OR real tool work; recurrence lets a
     terse run through), a value floor, and Jaccard near-dup dedup vs both the existing beliefs AND a permanent
     studyDeclined denylist (the memory-overhaul "discard = never again" rule, applied to the dossier).
   - Auto-proposals are CANDIDATES ONLY — nothing is written until the Commander taps Keep (the consent §5.6).

   Fail-open everywhere: a failed / empty / malformed study yields ZERO proposals and never touches the run. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Study = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the dossier dimensions the study may tag a proposal with — MUST match dossier.js DIM_KEYS (kept inline so
  // study stays standalone + node-loadable without a hard dossier.js dependency; a mismatch is caught by test).
  const DIMS = ['identity', 'stack', 'goals', 'style', 'standing_orders', 'pain', 'ambition'];
  const DIM_SET = new Set(DIMS);
  // the model tags a line "<DIM> <ADD|RETIRE>: <text>". ADD = a new belief; RETIRE = drift/obsoletion of an
  // existing one ("this goal looks shipped"). Anything else is ignored (conservative, like reflect.parse).
  const LINE = /^\s*[-*•]?\s*(identity|stack|goals?|style|standing[_\s-]?orders?|pain|ambition|ambitions?)\s+(add|retire|new|drift|done|shipped|obsolete)\s*[:\-—]\s*(.+?)\s*$/i;
  // normalise the model's loose dimension word to a canonical DIM key.
  const DIM_ALIAS = { goal: 'goals', ambitions: 'ambition', 'standing order': 'standing_orders', 'standingorders': 'standing_orders', 'standing-orders': 'standing_orders' };
  // which tag words mean "retire this belief" vs "add a new one".
  const RETIRE_WORDS = new Set(['retire', 'drift', 'done', 'shipped', 'obsolete']);

  const MAX_CONTENT = 280;        // a belief is a short durable line, not a transcript (mirrors dossier.TEXT_CHARS)
  const MIN_CONTENT = 8;          // below this it isn't a durable belief — a value floor against trivia
  const MIN_TOKENS = 2;           // a belief needs at least this many significant words
  const DEFAULT_MAX = 3;          // study is RARER than reflection — never dump a wall (anti-nag; host shows ≤1/run)
  const PROMPT_CAP = 3000;        // chars of directive + transcript slice fed to the aux model
  const SIM_THRESHOLD = 0.6;      // Jaccard near-dup floor — same as reflect.js

  // run-specific narration openers (dropped by the floor) — a study belief is durable, never "in this run…".
  const TRANSIENT = /^(the user (said|asked|wanted|mentioned|requested)|we (discussed|talked|covered|went over)|in this (run|task|session|conversation)|this (run|task|session)|today (i|we)|the (task|conversation) (was|is))\b/i;
  const RECALL_FENCE = /<recalled-memory>[\s\S]*?<\/recalled-memory>|<\/?recalled-memory>/gi;

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
  // significant-word count for the FLOOR (admits 2-char tech names Go/AI/ML/Vi, like reflect.floorTokens).
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

  // canonicalise the model's dimension word to a DIM key, or null if it isn't a real dimension.
  function canonDim(word) {
    let w = String(word == null ? '' : word).toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (DIM_ALIAS[w]) w = DIM_ALIAS[w];
    if (w === 'goal') w = 'goals';
    if (w === 'ambitions') w = 'ambition';
    return DIM_SET.has(w) ? w : null;
  }

  // did the run do REAL WORK — a tool-role result or an assistant turn carrying tool_calls (the project's honest
  // "real work" signal). Mirrors reflect.usedTools so study fires on the SAME notion of a substantive run.
  function usedTools(messages) {
    for (const m of (Array.isArray(messages) ? messages : [])) {
      if (!m) continue;
      if (m.role === 'tool') return true;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
    }
    return false;
  }

  // SALIENCE GATE — the SAME philosophy as reflect.reflectSalient (a real user turn + a reply OR real tool work;
  // recurrence lets a terse run through), so study fires on the worth of the work, never a raw char count. Kept
  // deliberately identical so study and reflection agree on "was this run substantive?".
  const MIN_STUDY_CHARS = 200;
  function studySalient(messages, recurring) {
    const arr = Array.isArray(messages) ? messages : [];
    let chars = 0, hasUser = false, hasAgent = false;
    for (const m of arr) {
      if (!m || typeof m.content !== 'string') continue;
      if (m.role === 'user') { hasUser = true; chars += m.content.length; }
      else if (m.role === 'assistant') { hasAgent = true; chars += m.content.length; }
    }
    const tools = usedTools(arr);
    if (!hasUser || (!hasAgent && !tools)) return false;
    if (recurring) return true;
    if (tools) return true;
    return chars >= MIN_STUDY_CHARS;
  }

  // the study PROMPT: the run's directive + a recent transcript slice + the current dossier block, asking the
  // model to propose dossier belief updates as tagged lines. Terse (constraint: keep aux prompts short).
  function buildPrompt(o) {
    o = o || {};
    const directive = String(o.directive == null ? '' : o.directive).replace(RECALL_FENCE, '').trim();
    const block = String(o.dossierBlock == null ? '' : o.dossierBlock).trim();
    const turns = [];
    for (const msg of (Array.isArray(o.messages) ? o.messages : [])) {
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const c = typeof msg.content === 'string' ? msg.content.replace(RECALL_FENCE, '') : '';
      if (c) turns.push((msg.role === 'user' ? 'USER: ' : 'AGENT: ') + c);
    }
    let body = turns.join('\n');
    const cap = Number.isFinite(o.cap) ? o.cap : PROMPT_CAP;
    if (body.length > cap) body = body.slice(body.length - cap);   // keep the most recent exchange
    return 'You just finished a task for your Commander. From the WORK below, update what the station believes ' +
      'about them. Propose ONLY durable, evidenced belief changes — one per line, tagged with a dimension and ' +
      'ADD (a new belief) or RETIRE (a belief that now looks stale/shipped). Dimensions: goals, pain, ambition, ' +
      'stack, style, identity, standing_orders. Examples:\n' +
      'goals ADD: shipping a local-first agent harness\nstyle ADD: prefers terse, verified answers\n' +
      'goals RETIRE: ship the dossier (this work shows it landed)\n' +
      'Skip anything transient, guessed, or already known. If nothing changed, reply NONE.\n\n' +
      (block ? 'WHAT THE STATION ALREADY BELIEVES:\n' + block + '\n\n' : '') +
      (directive ? 'THE DIRECTIVE:\n' + directive + '\n\n' : '') +
      'THE WORK:\n' + body;
  }

  // parse the aux reply into { dim, kind:'add'|'retire', text } candidates; untagged / unknown-dim lines ignored.
  function parse(raw) {
    const out = [];
    for (const ln of String(raw == null ? '' : raw).split('\n')) {
      const m = LINE.exec(ln);
      if (!m) continue;
      const dim = canonDim(m[1]);
      if (!dim) continue;
      const kind = RETIRE_WORDS.has(String(m[2]).toLowerCase()) ? 'retire' : 'add';
      const text = m[3].trim();
      if (text) out.push({ dim: dim, kind: kind, text: text });
    }
    return out;
  }

  // read every existing belief's text out of a { dim: [{text}] } beliefs map (for dedup vs what's already known).
  function existingTexts(beliefs) {
    const out = [];
    if (!beliefs || typeof beliefs !== 'object') return out;
    for (const k of DIMS) {
      const arr = beliefs[k];
      if (!Array.isArray(arr)) continue;
      for (const b of arr) { const t = b && (typeof b === 'string' ? b : b.text); if (t) out.push(String(t).trim()); }
    }
    return out;
  }

  // study(run, opts) -> { proposals[], prompt }.
  //   run: { agentId, runId, directive, messages }
  //   opts: { propose(prompt)->text, clock:{now()}, redact(s)->s, beliefs:{dim:[{text}]}, declined:[text], max }
  //   proposals: { id, dim, kind:'add'|'retire', text, evidence, source:'study', sourceRunId, createdAt }
  // 'add' dedups vs existing beliefs + the declined denylist (Jaccard). 'retire' must MATCH an existing belief
  //   (you can't retire a belief the station doesn't hold) and is deduped only vs the declined list.
  async function study(run, opts) {
    run = run || {}; opts = opts || {};
    const clock = opts.clock || { now: () => 0 };
    const redact = typeof opts.redact === 'function' ? opts.redact : (x => x);
    const max = opts.max || DEFAULT_MAX;
    const propose = opts.propose;
    if (typeof propose !== 'function') return { proposals: [] };

    const prompt = buildPrompt({ directive: run.directive, messages: run.messages, dossierBlock: opts.dossierBlock });
    let raw;
    try { raw = await propose(prompt); } catch (_) { return { proposals: [], prompt: prompt }; }   // a failed study never hurts the run

    const beliefTexts = existingTexts(opts.beliefs);
    const declined = (Array.isArray(opts.declined) ? opts.declined : []).map(t => String(t).trim()).filter(Boolean);
    const now = clock.now();
    const seen = {};                 // exact-text dedup within the batch (keyed dim+text)
    const acceptedTexts = [];        // near-dup dedup vs earlier accepted proposals in THIS batch
    const proposals = [];
    for (const cand of parse(raw)) {
      let text = redact(String(cand.text)).trim();
      if (text.length > MAX_CONTENT) text = text.slice(0, MAX_CONTENT - 1) + '…';
      if (!text) continue;
      if (lowValue(text)) continue;                       // trivia / run-narration floor
      const key = cand.dim + '::' + text.toLowerCase();
      if (seen[key]) continue;
      // permanently-declined (studyDeclined denylist): never re-propose a belief the Commander rejected.
      let killed = false;
      for (const d of declined) { if (jaccard(d, text) >= SIM_THRESHOLD) { killed = true; break; } }
      if (killed) continue;
      if (cand.kind === 'add') {
        // an ADD the station already believes (exact or paraphrase) is redundant — drop it.
        let dup = false;
        for (const bt of beliefTexts) { if (bt.toLowerCase() === text.toLowerCase() || jaccard(bt, text) >= SIM_THRESHOLD) { dup = true; break; } }
        if (dup) continue;
      } else {
        // a RETIRE must reference a belief the station ACTUALLY holds (evidence of what's being retired). Without a
        // match it's a hallucinated retraction — drop it (you can't retire what isn't there).
        let matches = false;
        for (const bt of beliefTexts) { if (jaccard(bt, text) >= SIM_THRESHOLD) { matches = true; break; } }
        if (!matches) continue;
      }
      // near-dup vs earlier accepted proposals in this batch (a reworded repeat).
      let near = false;
      for (const at of acceptedTexts) { if (jaccard(at, text) >= SIM_THRESHOLD) { near = true; break; } }
      if (near) continue;
      seen[key] = 1; acceptedTexts.push(text);
      proposals.push({
        id: 'study_' + (proposals.length + 1), dim: cand.dim, kind: cand.kind, text: text,
        evidence: (typeof run.directive === 'string' && run.directive) ? String(run.directive).slice(0, 140) : '',
        source: 'study', sourceRunId: run.runId || null, createdAt: now
      });
      if (proposals.length >= max) break;
    }
    return { proposals: proposals, prompt: prompt };
  }

  // ---- RATINGS → TASTE (mission §4): consecutive 👍/👎 on the same archetype mints ONE style-dim study proposal.
  // Pure decision over a persisted per-archetype tally { archetype: { up, down, upMinted, downMinted } }. The host
  // (studystore.js) supplies the archetype + verdict + the tally; this returns a proposal to raise (or null), and
  // the caller marks the archetype minted so it can never re-mint (once per archetype ever, per direction). ----
  const STREAK_N = 3;   // three consecutive same-direction verdicts on one archetype = a real taste signal
  // fold one verdict into a tally entry, resetting the OTHER direction's streak (consecutive, not cumulative).
  function foldRating(entry, verdict) {
    const e = entry || { up: 0, down: 0, upMinted: false, downMinted: false };
    if (verdict === 'great') { e.up = (e.up || 0) + 1; e.down = 0; }
    else if (verdict === 'miss') { e.down = (e.down || 0) + 1; e.up = 0; }
    else { e.up = 0; e.down = 0; }   // 'ok' (👌) breaks BOTH streaks — it's neither a like nor a dislike
    return e;
  }
  // given an archetype + its (already-folded) tally entry, mint ONE style proposal iff a fresh 3-streak crossed
  // and that direction hasn't minted before. Returns { proposal, mintedKey } or null.
  function tasteProposal(archetype, entry, clock) {
    if (!archetype || !entry) return null;
    const now = (clock && clock.now) ? clock.now() : 0;
    if ((entry.up || 0) >= STREAK_N && !entry.upMinted) {
      return { mintedKey: 'upMinted', proposal: {
        id: 'taste_up_' + archetype, dim: 'style', kind: 'add',
        text: 'Commander consistently likes ' + archetype + ' work — lean into it.',
        evidence: STREAK_N + ' consecutive 👍 on ' + archetype, source: 'study', sourceRunId: null, createdAt: now
      } };
    }
    if ((entry.down || 0) >= STREAK_N && !entry.downMinted) {
      return { mintedKey: 'downMinted', proposal: {
        id: 'taste_down_' + archetype, dim: 'style', kind: 'add',
        text: 'Commander has been unhappy with ' + archetype + ' work — take extra care there (verify before turning it in).',
        evidence: STREAK_N + ' consecutive 👎 on ' + archetype, source: 'study', sourceRunId: null, createdAt: now
      } };
    }
    return null;
  }

  // classify a run's DIRECTIVE into a coarse, stable work "archetype" label — the streak key for the taste path.
  // Deliberately simple + deterministic (keyword buckets, first match wins) so the same kind of ask always tallies
  // to the same bucket. 'general' is the honest fallback (an unclassifiable ask still streaks as 'general work').
  const ARCH_BUCKETS = [
    { id: 'writing',  re: /\b(write|writing|draft|email|blog|post|copy|essay|article|letter|caption|script|newsletter)\b/i },
    { id: 'coding',   re: /\b(code|coding|debug|refactor|function|bug|script|api|test|compile|deploy|program|implement)\b/i },
    { id: 'research', re: /\b(research|find|search|look up|investigate|compare|summariz|analyz|explore|gather)\b/i },
    { id: 'planning', re: /\b(plan|planning|schedule|organiz|outline|roadmap|strategy|prioriti|breakdown|steps)\b/i },
    { id: 'design',   re: /\b(design|layout|mockup|ui|ux|style|palette|logo|graphic|visual|wireframe)\b/i },
    { id: 'data',     re: /\b(data|spreadsheet|csv|table|chart|graph|metric|number|calculate|report|dashboard)\b/i }
  ];
  function classifyArchetype(directive) {
    const s = String(directive == null ? '' : directive);
    for (const b of ARCH_BUCKETS) if (b.re.test(s)) return b.id;
    return 'general';
  }

  // near-dup helper exposed so studystore can dedup a taste/study proposal vs the live studyDeclined list too.
  function isDeclined(text, declined) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return false;
    for (const d of (Array.isArray(declined) ? declined : [])) { if (jaccard(String(d), t) >= SIM_THRESHOLD) return true; }
    return false;
  }

  /* ---- THE BEAT SLOT (pure, node-testable): the one-post-run-beat arbiter chat.js drives. ----
     Exists because the memory turn-in and the study card arrive on DIFFERENT clocks — memory.proposed lands only
     after reflection's LLM round-trip (seconds after agent.run.end) — so "check the DOM at offer time" produces
     false negatives and can put TWO consent beats on screen. This state machine is the single source of truth
     for who holds the visible post-run beat; BOTH sides route their render/queue decisions through it, so the
     "never two beats" invariant is enforced in ONE tested place instead of scattered DOM checks. MEMORY WINS:
     while any reflection is proposed-but-unresolved, study cedes; a memory deck arriving over a visible study
     card QUEUES (never stacks) and renders the moment the study card resolves.

     visible ∈ { null, 'memory', 'study', 'arc' }; pendingMemory = runIds whose memory.proposed arrived but whose
     deck hasn't resolved yet (covers the whole LLM→fetch→deck window, incl. the 350ms fetch gap). Contract:
       memoryProposed(runId)     — reflection announced proposals: reserve memory's claim (call BEFORE the fetch).
       memoryDeck()              — a fetched deck wants to render: 'render' (slot was free) | 'queue' (a beat is up).
       memoryDone(runId, more)   — the visible deck resolved; more=true keeps the slot held for the queued next deck.
       memoryEmpty(runId)        — the fetch came back empty / notify-only: release the claim (deck never rendered).
       canStudy()                — 'free' | 'busy' (a beat is visible) | 'memory' (reflection in flight — memory wins).
       studyShown()/studyDone(more) — the study card opened / resolved; more=true hands the slot to a queued memory deck.
       visibleBeat()             — 'memory' | 'study' | 'arc' | null. THE tested invariant: never two at once.

     GROWTH Tier 2 (ADDITIVE): the GOAL-ARC confirm beat is a THIRD, LOWEST-priority participant — memory turn-in
     and study proposals both win the moment before it, so an arc confirm only fires on a genuinely free slot
     (canArc() === 'free'). It cannot preempt anything and nothing preempts a VISIBLE arc panel (a focused Dialogue
     confirm, like the First Pitch, owns the screen until the Commander answers). The pre-Tier-2 surface is
     untouched: memory/study behavior is byte-identical (canStudy still sees only visible + pendingMemory), so the
     128 study.test assertions hold unchanged. canArc()/arcShown()/arcDone() are the only additions.

     GROWTH Tier 3 (ADDITIVE): the EARNED-AUTONOMY offer beat is a FOURTH, EVEN-LOWER-priority participant — memory
     turn-in, study proposals, AND the arc confirm all win the moment before it (priority: memory > study > arc >
     trust). A trust offer may only take a WHOLLY FREE slot (canTrust() === 'free'); it cannot preempt anything, and
     nothing preempts a VISIBLE trust card until the Commander answers Accept / Not-yet. The Tier-1/Tier-2 surface is
     byte-identical: canStudy()/canArc() still see only visible + pendingMemory, and 'trust' is just another visible
     value they read as 'busy' — so the 128 study.test + the goalstore §8 arc assertions hold unchanged.
     canTrust()/trustShown()/trustDone() are the only additions. */
  function makeBeatSlot() {
    const pendingMemory = new Set();
    let visible = null;
    return {
      memoryProposed(runId) { if (runId) pendingMemory.add(runId); },
      memoryDeck() { if (visible !== null) return 'queue'; visible = 'memory'; return 'render'; },
      memoryShown() { visible = 'memory'; },   // idempotent hard-claim for the actual deck render (already arbitrated)
      memoryDone(runId, more) { if (runId) pendingMemory.delete(runId); visible = more ? 'memory' : null; },
      memoryEmpty(runId) { if (runId) pendingMemory.delete(runId); },
      canStudy() {
        if (visible !== null) return 'busy';
        if (pendingMemory.size) return 'memory';   // reflection in flight ANYWHERE — memory wins the moment
        return 'free';
      },
      studyShown() { visible = 'study'; },
      studyDone(more) { visible = more ? 'memory' : null; },
      // GROWTH Tier 2 — the arc confirm beat cedes to BOTH memory and study: it may only take a wholly free slot.
      // 'busy' = a beat (memory/study/arc/trust) is visible; 'memory' = reflection in flight (memory wins the moment).
      canArc() {
        if (visible !== null) return 'busy';
        if (pendingMemory.size) return 'memory';
        return 'free';
      },
      arcShown() { visible = 'arc'; },
      // more=true hands the slot straight to a memory deck that QUEUED behind the visible arc panel (a late
      // memory.proposed during a minutes-long confirm) — mirrors studyDone(more): the deck renders with no gap
      // where another beat could steal the moment, and pendingMemory can't strand canStudy/canArc on 'memory'.
      arcDone(more) { visible = more ? 'memory' : null; },
      // GROWTH Tier 3 — the earned-autonomy offer beat: the LOWEST priority. It cedes to memory, study AND the arc;
      // like canArc it may only take a wholly free slot. 'busy' = ANY beat (memory/study/arc/trust) is visible.
      canTrust() {
        if (visible !== null) return 'busy';
        if (pendingMemory.size) return 'memory';
        return 'free';
      },
      trustShown() { visible = 'trust'; },
      // more=true hands the slot to a memory deck that QUEUED behind the visible trust card (mirrors arcDone/studyDone):
      // the deck renders with no gap where another beat could steal the moment, and pendingMemory can't strand the lanes.
      trustDone(more) { visible = more ? 'memory' : null; },
      // NS-6 (ADDITIVE) — the THREAD turn-in beat: a FIFTH participant, the LOWEST priority (memory > study >
      // arc > trust > thread — study always wins the moment first, per the turn-in conventions). Like canArc /
      // canTrust it may only take a WHOLLY FREE slot; 'thread' is just another visible value the other lanes
      // read as 'busy', so every prior assertion holds unchanged.
      canThread() {
        if (visible !== null) return 'busy';
        if (pendingMemory.size) return 'memory';
        return 'free';
      },
      threadShown() { visible = 'thread'; },
      // more=true hands the slot to a memory deck that QUEUED behind the visible thread card (mirrors trustDone).
      threadDone(more) { visible = more ? 'memory' : null; },
      visibleBeat() { return visible; },
      _pending() { return pendingMemory.size; }
    };
  }

  return {
    study, buildPrompt, parse, studySalient, usedTools, lowValue, canonDim, jaccard,
    foldRating, tasteProposal, isDeclined, existingTexts, classifyArchetype, makeBeatSlot,
    DIMS, STREAK_N, SIM_THRESHOLD, DEFAULT_MAX
  };
});
