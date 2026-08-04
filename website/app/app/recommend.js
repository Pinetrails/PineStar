/* STARNET — recommend.js : THE RECOMMENDATION SPINE (pure, node-testable, zero DOM / zero fetch).

   The station used to talk to its Commander through ~9 independent proactive channels (study, arc, trust,
   thread, rate, suggestion, seed, routine, recruitment, curiosity), each with its own timer. Whoever armed
   EARLIEST won the one post-run beat, so the LOWEST-value ask usually spoke first and the priority order
   baked into beatcard.js was inert. This module is the single relevance bar they all pass through.

   Two laws it enforces, both of them the product's truthful-telemetry law applied to recommendations:

     1. ONE VOICE — pick() returns at most ONE candidate. Best-first, or silence.
     2. EVIDENCE OR SILENCE — a candidate with no non-empty `why` is DROPPED, never shown. The station may
        only make a proactive offer it can justify out of real state (the Commander's own words, a real
        streak count, a real targeted gap). No citable evidence means the channel stays quiet.

   A candidate is a plain object:
     { kind, why, dim?, base?, streak?, declines? }
       kind     — the channel id (see PRIORITY). Its beat-slot family is slotKindOf(kind).
       why      — the evidence string, derived from REAL state by the channel adapter. Required.
       dim      — optional dossier dimension this offer targets (enables the value-of-information term).
       base     — optional explicit base score override (tests / future channels).
       streak   — optional non-negative run of corroborating signal (trust's approval streak).
       declines — optional count of recent declines on this channel (a soft penalty, never a hard block;
                  the per-channel session caps/denylists remain the real floor and live in their stores).

   Scoring is deterministic and tier-stable ON PURPOSE: the per-kind base tier is BASE_STEP apart and every
   modifier is bounded strictly below BASE_STEP, so a lower-priority kind can never leapfrog a higher one.
   The modifiers only order candidates WITHIN a tier and make the numbers meaningful for future tuning. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Recommend = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* The one priority order. Its head is beatcard.js's DEFAULT_PRIORITY (memory > study > arc > trust >
     thread > rate > nudge); its tail expands the single 'nudge' slot family into the five gentle channels
     in the EXACT precedence the old wireCuriosity if/return ladder used (suggestion → seed → routine →
     recruitment → curiosity), so consolidating the ladder changes who can speak, never the pecking order. */
  const PRIORITY = ['memory', 'study', 'arc', 'trust', 'thread', 'rate', 'suggest', 'seed', 'routine', 'recruit', 'curiosity'];

  // channel id → the beat-slot kind beatcard.js arbitrates on. The five gentle channels all render through
  // chat.js's shared nudge() aside, so they share the one 'nudge' slot family.
  const SLOT_KIND = {
    memory: 'memory', study: 'study', arc: 'arc', trust: 'trust', thread: 'thread', rate: 'rate',
    suggest: 'nudge', seed: 'nudge', routine: 'nudge', recruit: 'nudge', curiosity: 'nudge'
  };

  /* THE SESSION ASK BUDGET. Per-channel caps are the second floor, but nothing bounded the TOTAL number of
     unprompted consent cards a single browser session could stack up — five channels each spending their own
     one-per-session cap is still five interruptions. This is the spine-level ceiling on PROACTIVE asks.
     TUNABLE: raise/lower this one number to make the station more or less talkative.
     Two kinds are EXEMPT because the run itself earns them rather than the station choosing to interrupt:
       · memory — the Commander's own reflection deck; it is the run reporting back, and it never routes
                  through the pass at all (it reserves the slot directly on memory.proposed).
       · rate   — the primary leveling beat for work that was just done, and the one control the Commander
                  is asking FOR when they finish a task. */
  const SESSION_ASK_MAX = 4;
  const ASK_EXEMPT = { memory: true, rate: true };
  function asksBudget(kind) { return !Object.prototype.hasOwnProperty.call(ASK_EXEMPT, String(kind || '')); }

  const BASE_STEP = 100;   // one full priority tier
  const VOI_MAX = 60;      // value-of-information term ceiling (< BASE_STEP: never flips a tier)
  const STREAK_STEP = 5;   // per corroborating signal…
  const STREAK_MAX = 20;   // …bounded
  const DECLINE_STEP = 15; // per recent decline…
  const DECLINE_MAX = 45;  // …bounded

  function rank(kind) {
    const i = PRIORITY.indexOf(String(kind || ''));
    return i < 0 ? PRIORITY.length : i;
  }
  function slotKindOf(kind) {
    const k = String(kind || '');
    return Object.prototype.hasOwnProperty.call(SLOT_KIND, k) ? SLOT_KIND[k] : k;
  }
  function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
  function text(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

  // a candidate may speak only if it can cite. This is the evidence-or-silence law in one predicate.
  function citable(candidate) {
    return !!(candidate && typeof candidate === 'object' && text(candidate.why).length > 0);
  }

  /* the value-of-information term for a dim-targeted candidate: the SAME weight × (1 − conf) gap the
     understanding engine already computes (understanding.js) and CuriosityStore.voiOrder() already ranks
     on — generalized here rather than duplicated. Returns 0 when the read or the dim is unavailable, so a
     cold station simply falls back to pure priority order (fail-open, never a fabricated bonus). */
  function voi(candidate, uRead) {
    if (!candidate || !candidate.dim) return 0;
    const dims = uRead && uRead.dims;
    const d = dims && dims[candidate.dim];
    if (!d) return 0;
    const gap = Math.max(0, Math.min(1, num(d.weight) * (1 - num(d.conf))));
    return gap * VOI_MAX;
  }

  /* score(candidate, uRead) → number. Higher speaks first. Deterministic: no clock, no randomness. */
  function score(candidate, uRead) {
    if (!candidate) return 0;
    const base = Number.isFinite(Number(candidate.base))
      ? Number(candidate.base)
      : (PRIORITY.length - rank(candidate.kind)) * BASE_STEP;
    const streak = Math.min(STREAK_MAX, Math.max(0, num(candidate.streak)) * STREAK_STEP);
    const declines = Math.min(DECLINE_MAX, Math.max(0, num(candidate.declines)) * DECLINE_STEP);
    return base + voi(candidate, uRead) + streak - declines;
  }

  /* pick(candidates, uRead) → the one candidate that may speak, or null.
     Drops every uncitable candidate FIRST (evidence or silence), then takes the highest score. Ties break
     by priority rank, then by input order — so the result never depends on Object key order or timing. */
  function pick(candidates, uRead) {
    const list = (Array.isArray(candidates) ? candidates : []).filter(citable);
    let best = null, bestScore = 0, bestRank = 0, bestIndex = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const s = score(c, uRead);
      const r = rank(c.kind);
      if (!best || s > bestScore || (s === bestScore && (r < bestRank || (r === bestRank && i < bestIndex)))) {
        best = c; bestScore = s; bestRank = r; bestIndex = i;
      }
    }
    return best;
  }

  /* whyLine(candidate) → the normalized display string, one grammar for every card and the FOR YOU shelf:
     "because <the evidence, in the Commander's own words>". Idempotent (an already-"because …" string is
     not doubled), trailing sentence punctuation trimmed, never invents text. '' when there is nothing to
     cite — a caller that gets '' must render nothing. */
  function whyLine(candidate) {
    let s = text(candidate && candidate.why);
    if (!s) return '';
    s = s.replace(/^(?:because|since|as)\b\s*/i, '');
    s = s.replace(/[.…]+$/, '');
    if (!s) return '';
    // lower-case a plain leading capital so it joins mid-sentence — but leave acronyms/proper-ish tokens
    // (two leading capitals, or a quote/symbol opener) exactly as the source wrote them.
    if (/^[A-Z][a-z]/.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
    return 'because ' + s;
  }

  return {
    score, pick, whyLine, citable, rank, slotKindOf, asksBudget,
    PRIORITY: PRIORITY.slice(), SLOT_KIND: Object.assign({}, SLOT_KIND),
    BASE_STEP, VOI_MAX, SESSION_ASK_MAX
  };
});
