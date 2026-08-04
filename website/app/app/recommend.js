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
     { kind, why, dim?, base?, streak?, declines?, strength?, quality? }
       kind     — the channel id (see PRIORITY). Its beat-slot family is slotKindOf(kind).
       why      — the evidence string, derived from REAL state by the channel adapter. Required.
       dim      — optional dossier dimension this offer targets (enables the value-of-information term).
       base     — optional explicit base score override (tests / future channels).
       streak   — optional non-negative run of corroborating signal (trust's approval streak).
       declines — optional count of recent declines on this channel (a soft penalty, never a hard block;
                  the per-channel session caps/denylists remain the real floor and live in their stores).
       strength — optional 0..1 EVIDENCE STRENGTH (recquality.js): how well-grounded this candidate's citation
                  actually is — dim confidence, belief freshness, a real repeat counter. Weak evidence is
                  DISCOUNTED within its tier; it never fabricates a bonus, and an absent reading is NEUTRAL.
       quality  — optional CHANNEL QUALITY WEIGHT (recqualitystore.js): the EWMA of the outcomes this channel's
                  accepted offers really produced. Neutral 1, floored at 0.5 so quality alone can never silence
                  a channel — a dud channel gets quieter, never mute.

   Scoring is deterministic and TIER-STABLE ON PURPOSE. The per-kind base tier is BASE_STEP apart and the SUM of
   every modifier is clamped to ±BASE_STEP/2 (MOD_CAP) — so the best a tier can score is exactly the worst the
   tier above it can score, and pick()'s rank tie-break hands that tie to the higher priority. Strength and
   quality therefore reorder candidates WITHIN a priority band and can never move one across a band: priority
   order stays the spine's law. (Clamping the SUM is what makes that claim true — bounding each modifier
   individually, as this scorer originally did, still let two stacked modifiers cross a tier.) */
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
  const MOD_CAP = BASE_STEP / 2;   // the TOTAL modifier budget, ± — see the tier-stability note in the header

  /* THE TWO DAMPED MULTIPLIERS (quality loop, Q1/Q2). Both are read as multipliers in the [floor..1(..cap)]
     range and converted into a bounded WITHIN-TIER term: `MAX × (multiplier − 1)`. That shape is deliberate —
       · a NEUTRAL reading (1) contributes exactly 0, so a cold station scores identically to the pre-quality
         spine. Absent state is never a penalty and never a bonus (fail-open, truthful telemetry);
       · a WEAK reading only ever SUBTRACTS. The station does not promote an offer for having strong evidence;
         it declines to shout about one whose evidence is thin. */
  const STRENGTH_MAX = 30;      // the within-tier swing thin evidence may cost a candidate
  const STRENGTH_FLOOR = 0.5;   // strength 0 → ×0.5 → −STRENGTH_MAX/2. Half a tier's modifier budget, no more.
  const QUALITY_MAX = 30;       // the within-tier swing a channel's real outcome history may move it
  const QUALITY_FLOOR = 0.5;    // matches recquality.js Q_FLOOR — a dud channel is quieter, NEVER silent
  const QUALITY_CAP = 1.25;     // matches recquality.js Q_CAP — a proven channel earns a small, bounded edge

  // an unreadable / absent multiplier is NEUTRAL (1) — the station never invents a reading it does not have.
  function damp(v, floor, cap) {
    const n = Number(v);
    if (v == null || !Number.isFinite(n)) return 1;
    return n < floor ? floor : n > cap ? cap : n;
  }
  // strength arrives 0..1 (recquality.js) and maps onto the [STRENGTH_FLOOR..1] multiplier band.
  function strengthDamp(candidate) {
    const v = candidate && candidate.strength;
    const n = Number(v);
    if (v == null || !Number.isFinite(n)) return 1;
    return STRENGTH_FLOOR + (1 - STRENGTH_FLOOR) * (n < 0 ? 0 : n > 1 ? 1 : n);
  }
  function qualityDamp(candidate) { return damp(candidate && candidate.quality, QUALITY_FLOOR, QUALITY_CAP); }

  function rank(kind) {
    const i = PRIORITY.indexOf(String(kind || ''));
    return i < 0 ? PRIORITY.length : i;
  }
  function slotKindOf(kind) {
    const k = String(kind || '');
    return Object.prototype.hasOwnProperty.call(SLOT_KIND, k) ? SLOT_KIND[k] : k;
  }
  // the only leading words whyLine may de-capitalize: sentence-starter pronouns/determiners that carry no
  // identity of their own. Never a proper noun, a language, a product, or a person's name.
  const STARTER = /^(You|It|This|That|These|Those|We|They|There|I)\b/;
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
    const mod = voi(candidate, uRead) + streak - declines
      + STRENGTH_MAX * (strengthDamp(candidate) - 1)
      + QUALITY_MAX * (qualityDamp(candidate) - 1);
    // the whole modifier budget is clamped to half a tier, so no stack of modifiers can cross a priority band.
    return base + Math.max(-MOD_CAP, Math.min(MOD_CAP, mod));
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
    // a citation that already opens with its own preposition is a complete phrase ("from the task you gave me:
    // …") — "because from …" is not English. Return it as written; the framing is already there.
    if (/^(?:from|after)\b/i.test(s)) return s;
    /* THE SPINE NEVER REWRITES THE COMMANDER'S WORDS (fixed 2026-08-04). This used to lower-case any plain
       leading capital so the clause joined mid-sentence — which quietly mangled the evidence itself: a belief
       citing "Python is your stack" rendered "because python…", and a RETIRE citation naming a person renamed
       them. The evidence is quoted material; only the FRAMING word the spine itself adds may be adjusted. So we
       de-capitalize exactly one thing: a leading sentence-starter pronoun in an UNQUOTED citation. Any citation
       carrying a quote is passed through untouched, and every proper noun survives. */
    if (STARTER.test(s) && s.indexOf('“') < 0 && s.indexOf('"') < 0) s = s.charAt(0).toLowerCase() + s.slice(1);
    return 'because ' + s;
  }

  return {
    score, pick, whyLine, citable, rank, slotKindOf, asksBudget, strengthDamp, qualityDamp,
    PRIORITY: PRIORITY.slice(), SLOT_KIND: Object.assign({}, SLOT_KIND),
    BASE_STEP, VOI_MAX, SESSION_ASK_MAX, MOD_CAP, STRENGTH_MAX, STRENGTH_FLOOR, QUALITY_MAX, QUALITY_FLOOR, QUALITY_CAP
  };
});
