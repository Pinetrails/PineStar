/* STARNET — autopilot.js : the PURE engine for the IDLE SELF-DIRECTION DRIVER (autonomy layer, Slice A).

   This is the missing CONSUMER of the autonomy posture. Slices 1–2 shipped the dial (autonomy.js) and cron
   self-initiation (autojobs.js), but nothing read the posture to actually drive idle behaviour — so the dial had
   no effect on the floor. This engine closes that: when the Commander goes idle, it decides what the station
   should do on its own, GATED by the dial AND by how well it actually knows the Commander.

   THE DECISION (pure + deterministic; the live clock, the dossier reads, and the curiosity hand-off live in the
   thin store, autopilotstore.js):

     idle + posture →  EARN  (learn one thing — ask a gentle get-to-know-you question)
                  or   ACT   (do a small reason/draft job toward their goals)      ← Slice A2
                  or   none

   THE CONFIDENCE FLOOR (the anti-slop heart): an idle agent that confidently does the WRONG work is worse than
   one that does nothing — the first autonomous deliverable sets trust forever. So ACTING is EARNED, not just
   permitted. readiness() reads the (confirmed-only, never-inferred) dossier — breadth, the required dim, and
   recency — into a tier; decide() acts only when the dial permits AND the tier is hot; otherwise it EARNS more
   context first (the flywheel: when it doesn't know enough to act, it acts to know more).

   THE GOVERNING RULE — ceiling vs earned: the dial is the ceiling the Commander PERMITS; the tier is the level the
   station has EARNED; it operates at the LOWER of the two and names which is BINDING (legibility — "you set me
   free, but i'm still learning you, so here's a question instead of a guess"). WAIT means nothing, ever.

   PURE + node-testable, mirroring autonomy.js / autojobs.js / pitch.js: an `Autopilot` global in the browser,
   module.exports under node. NO Date.now / Math.random — a decision is a deterministic function of (posture,
   idleness, dossier-readiness). The store injects the clock. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Autopilot = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // edge defaults (consumed by the store's clock/timer wiring — just numbers, so they live with the engine).
  const DEFAULT_IDLE_MS = 120000;   // "stepped away" = no interaction for 2 minutes
  const DEFAULT_TICK_MS = 20000;    // how often the store re-checks idleness

  // the readiness floor constants. goals is the keystone dim (you can't usefully act without knowing what they
  // want); the breadth bars mirror the existing self-initiation gate (goals + ≥2 known = the propose floor).
  const REQUIRE_DIM = 'goals';
  const WARM_MIN = 2;               // goals usable + this many usable dims → warm (may propose / earn)
  const HOT_MIN = 4;                // goals usable + this many usable dims → hot  (has EARNED the right to act)
  const STALE_MS = 1000 * 60 * 60 * 24 * 45;   // a belief older than ~45 days is stale: still known, but too old to ground ACTING on

  // is the clock idle? (now - lastActivity ≥ the idle span). A bad/unknown clock is never idle (fail safe).
  function idleFor(now, lastActivity, idleMs) {
    if (!Number.isFinite(now) || !Number.isFinite(lastActivity)) return false;
    const span = Number.isFinite(idleMs) ? idleMs : DEFAULT_IDLE_MS;
    return (now - lastActivity) >= span;
  }

  // newest timestamp across a dimension's beliefs (updatedAt, falling back to createdAt). 0 = undated.
  function newestStamp(beliefs) {
    let mx = 0;
    for (const b of (Array.isArray(beliefs) ? beliefs : [])) {
      const t = Number(b && b.updatedAt) || Number(b && b.createdAt) || 0;
      if (t > mx) mx = t;
    }
    return mx;
  }

  // READINESS — derive the confidence tier from the dossier, purely. A dim is USABLE iff it is known AND its
  // freshest belief is not stale (recency matters: old context shouldn't license acting). An undated belief
  // (legacy/seeded, pre-timestamps) counts as fresh — never punish an old save. The dossier is confirmed-only
  // (never auto-inferred), so a usable dim is trustworthy grounding; we only measure breadth + the keystone + age.
  //   dossierSummary — DossierStore.summary() shape: { known:[dim], familiarity:0..1, ... }
  //   beliefsByDim   — fn(dim)->[belief] OR a { dim:[belief] } map (each belief carries updatedAt/createdAt)
  function readiness(dossierSummary, beliefsByDim, now, opts) {
    opts = opts || {};
    const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : STALE_MS;
    const sum = dossierSummary || {};
    const known = Array.isArray(sum.known) ? sum.known : [];
    const get = (dim) => {
      if (typeof beliefsByDim === 'function') { try { return beliefsByDim(dim) || []; } catch (_) { return []; } }
      if (beliefsByDim && typeof beliefsByDim === 'object') return beliefsByDim[dim] || [];
      return [];
    };
    const usableDims = [], staleDims = [];
    for (const dim of known) {
      const newest = newestStamp(get(dim));
      const fresh = !newest || !Number.isFinite(now) || (now - newest) <= staleMs;
      (fresh ? usableDims : staleDims).push(dim);
    }
    const goalsUsable = usableDims.indexOf(REQUIRE_DIM) >= 0;
    let tier = 'cold';
    if (goalsUsable && usableDims.length >= HOT_MIN) tier = 'hot';
    else if (goalsUsable && usableDims.length >= WARM_MIN) tier = 'warm';
    return {
      tier, goalsUsable, usableDims, staleDims,
      familiarity: Number.isFinite(sum.familiarity) ? sum.familiarity : 0
    };
  }

  // THE DECISION. Returns { go, mode:'act'|'earn'|'none', reason, binding } — binding names what holds ACT back
  // (for the honest "still learning you" line), or null when nothing does. Order: WAIT short-circuits to nothing;
  // an active (non-idle) station does nothing; otherwise it ACTS only when the dial permits acting AND the tier is
  // hot AND there's daily budget — else it EARNS context, naming the limiting axis.
  //   enabled        — posture initiative ≥ propose (AutonomyStore.summary().enabled)
  //   actsUnattended — posture initiative ≥ leash    (AutonomyStore.summary().actsUnattended) → the dial permits acting
  //   idle           — Autopilot.idleFor(...)
  //   tier           — readiness().tier
  //   budgetLeft     — remaining leash actions today (omit/Infinity in Slice A1 — the earn branch isn't budgeted)
  function decide(state) {
    state = state || {};
    if (!state.enabled) return { go: false, mode: 'none', reason: 'disabled', binding: null };
    if (!state.idle) return { go: false, mode: 'none', reason: 'active', binding: null };
    const canActDial = !!state.actsUnattended;
    const canActConfidence = state.tier === 'hot';
    const hasBudget = !Number.isFinite(state.budgetLeft) || state.budgetLeft > 0;
    if (canActDial && canActConfidence && hasBudget) return { go: true, mode: 'act', reason: 'ready', binding: null };
    // not act-ready → earn one piece of context, and name what's keeping it from acting (legibility / the flywheel).
    let binding = null;
    if (!canActDial) binding = 'dial';                 // the Commander hasn't dialled it up to acting yet
    else if (!canActConfidence) binding = 'confidence'; // it's allowed to act, but doesn't know them well enough
    else if (!hasBudget) binding = 'budget';            // allowed + confident, but today's leash is spent
    return { go: true, mode: 'earn', reason: 'earn', binding: binding };
  }

  /* ============================ THE ACT BRANCH — anti-slop selection pipeline (Slice A2) ============================
     When decide() returns 'act', the store runs this pure pipeline (the model fills two narrow slots — propose
     candidates, then do the chosen one; everything structural is here): eligibility → a candidate directive →
     a strict parse with the GROUNDING VETO → deterministic score-and-pick-best with a CONFIDENCE GATE → a do
     directive → a tolerant deliverable parse. Anti-slop is the whole game: a candidate that doesn't cite something
     the station actually knows never exists, and if nothing clears the confidence bar the station does NOTHING
     (idle-doing-nothing beats shipping slop). Only score-based selection lets a future LEARN loop re-weight per
     user — the uncopyable moat — so selection is a score, with a FIXED tie-break for predictability. */

  // the five task archetypes (LOCKED). Each is grounded in ONE dossier dimension — no usable belief in that dim,
  // no candidate of that kind. ARRAY ORDER is the tie-break precedence (advance › kill-pain › prep › maintain ›
  // scout) used when scores are close.
  const ARCHETYPES = [
    { id: 'advance-goal',    dim: 'goals', blurb: 'take the next concrete step toward a goal' },
    { id: 'kill-pain',       dim: 'pain',  blurb: 'chip away at a pain point / draft a tool for it' },
    { id: 'prep-next',       dim: 'goals', blurb: 'research / draft / stage something they will need soon' },
    { id: 'maintain-extend', dim: 'goals', blurb: 'improve or extend a prior piece of work' },
    { id: 'scout',           dim: 'stack', blurb: 'watch / scout something in their stack' }
  ];
  const CANDIDATE_MAX = 4;          // ask for a few typed candidates, then pick the best — never act on the first idea
  const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };
  const MIN_ACT_SCORE = 2;          // the confidence gate: nothing scoring below this acts (low-confidence → stay silent)
  const STOPWORDS = { about: 1, there: 1, their: 1, would: 1, could: 1, should: 1, which: 1, where: 1, while: 1, these: 1, those: 1, after: 1, before: 1, every: 1, other: 1, thing: 1, things: 1, stuff: 1, really: 1, around: 1 };

  // which archetypes can even be proposed, given which dims are USABLE grounding (from readiness().usableDims).
  function eligibleArchetypes(usableDims) {
    const u = Array.isArray(usableDims) ? usableDims : [];
    return ARCHETYPES.filter(a => u.indexOf(a.dim) >= 0);
  }

  // significant tokens of a string (lowercased words ≥5 chars, minus a few stopwords) — the basis of the grounding
  // check. Deterministic and dependency-free; a structural floor, NOT a semantic judge.
  function sigTokens(s) {
    const out = {};
    for (const w of String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]+/g) || []) {
      if (w.length >= 5 && !STOPWORDS[w]) out[w] = 1;
    }
    return out;
  }
  // is `grounds` actually anchored in something the station knows? True iff it substring-matches a belief (either
  // direction, normalized) OR shares ≥1 significant token with one. Catches invented grounding (zero overlap) while
  // tolerating paraphrase. beliefTexts = a flat array of belief strings.
  function grounded(grounds, beliefTexts) {
    const g = String(grounds == null ? '' : grounds).toLowerCase().trim();
    if (!g) return false;
    const texts = Array.isArray(beliefTexts) ? beliefTexts : [];
    const gTok = sigTokens(g);
    for (const raw of texts) {
      const b = String(raw == null ? '' : raw).toLowerCase().trim();
      if (!b) continue;
      if (b.indexOf(g) >= 0 || g.indexOf(b) >= 0) return true;
      const bTok = sigTokens(b);
      for (const w in gTok) if (bTok[w]) return true;
    }
    return false;
  }

  // flatten a { dim:[texts] } beliefs map (or pass an array through) to a single belief-text array.
  function flattenBeliefs(beliefs) {
    if (Array.isArray(beliefs)) return beliefs.filter(Boolean);
    const out = [];
    if (beliefs && typeof beliefs === 'object') for (const k in beliefs) for (const t of (beliefs[k] || [])) if (t) out.push(t);
    return out;
  }

  // THE CANDIDATE DIRECTIVE — the reason-only task that asks the model for a few grounded, achievable-now job ideas
  // (it carries the dossier in its live system prompt; this hands the beliefs + the eligible archetypes explicitly so
  // a weak model can't miss them, and hard-constrains output to the reason/draft envelope + a strict tagged format).
  //   ctx: { beliefs:{dim:[texts]}, eligible:[archetype], max }
  function buildCandidateDirective(ctx) {
    ctx = ctx || {};
    const beliefs = (ctx.beliefs && typeof ctx.beliefs === 'object') ? ctx.beliefs : {};
    const eligible = (Array.isArray(ctx.eligible) && ctx.eligible.length) ? ctx.eligible : ARCHETYPES;
    const max = Number.isFinite(ctx.max) ? ctx.max : CANDIDATE_MAX;
    const lines = [];
    lines.push('INTERNAL — SELF-DIRECTED WORK. The Commander is away. Do not run any tools. Reason only, then reply in the exact format below.');
    lines.push('Propose up to ' + max + ' small jobs you could do RIGHT NOW, unattended, to help them — then you will be asked to do the single best one and leave a draft on their desk.');
    const dimLine = (key, label) => { const arr = Array.isArray(beliefs[key]) ? beliefs[key].filter(Boolean) : []; if (arr.length) lines.push('- ' + label + ': ' + arr.join(' | ')); };
    lines.push('What you know about them:');
    dimLine('goals', 'Goals'); dimLine('pain', 'Pain points'); dimLine('ambition', 'Ambitions'); dimLine('stack', 'Stack & tools'); dimLine('standing_orders', 'Standing orders'); dimLine('style', 'Working style');
    lines.push('Each job must be ONE of these kinds: ' + eligible.map(a => a.id + ' (' + a.blurb + ')').join(', ') + '.');
    lines.push('Hard rules:');
    lines.push('- GROUNDED: every job must aim at a SPECIFIC thing above (a real goal / pain / etc). Quote the exact thing in GROUNDS. If you cannot ground it in something you actually know, do not propose it.');
    lines.push('- ACHIEVABLE NOW, UNATTENDED: NO tools, NO web, NO file writes, NO sending. It must be REASONING / DRAFTING / PLANNING you can finish from what you know and leave as a draft. Never propose searching, fetching, posting, or messaging.');
    lines.push('- HONEST CONFIDENCE: rate how sure you are it is genuinely useful AND that you can do it well now (high/medium/low). Low is fine — it is better to admit it than to pad.');
    lines.push('Reply with one block PER job, EXACTLY this format, nothing else:');
    lines.push('JOB: <short title, a few words>');
    lines.push('KIND: <one id from the list>');
    lines.push('GROUNDS: <the exact goal/pain/etc this serves — quote what you know>');
    lines.push('CONFIDENCE: <high | medium | low>');
    lines.push('SPEC: <one line — exactly what the finished draft will contain (your own done-check)>');
    return lines.join('\n');
  }

  // parse the candidate reply, tolerantly + with the GROUNDING VETO. Keeps a candidate only with a title, an
  // eligible KIND, a non-empty SPEC, and GROUNDS that is actually anchored in the provided beliefs (structure
  // overrules the model). opts: { eligible:[archetype], beliefs (map|array), requireGrounding:true }
  function parseCandidates(text, opts) {
    opts = opts || {};
    const eligibleIds = {};
    for (const a of (Array.isArray(opts.eligible) && opts.eligible.length ? opts.eligible : ARCHETYPES)) eligibleIds[a.id] = 1;
    const beliefTexts = flattenBeliefs(opts.beliefs);
    const requireGrounding = opts.requireGrounding !== false;
    const raw = String(text == null ? '' : text);
    const grab = (block, label) => { const m = new RegExp('^\\s*' + label + '\\s*:\\s*(.+?)\\s*$', 'im').exec(block); return m ? m[1].trim() : ''; };
    const parts = raw.split(/(?=^\s*JOB\s*:)/im).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const block of parts) {
      const title = grab(block, 'JOB');
      const kind = grab(block, 'KIND').toLowerCase();
      const grounds = grab(block, 'GROUNDS');
      const spec = grab(block, 'SPEC');
      if (!title || !grounds || !spec) continue;                 // structure: all three are mandatory
      if (!eligibleIds[kind]) continue;                          // an ineligible / hallucinated kind is dropped
      if (requireGrounding && !grounded(grounds, beliefTexts)) continue;   // the grounding veto: invented grounding never survives
      let conf = grab(block, 'CONFIDENCE').toLowerCase();
      if (conf !== 'high' && conf !== 'medium' && conf !== 'low') conf = 'medium';
      out.push({ title: title.slice(0, 80), archetype: kind, grounds, confidence: conf, spec });
    }
    return out;
  }

  // SCORE-AND-PICK-BEST + the CONFIDENCE GATE. Score is dominated by confidence (the slot a future LEARN loop
  // re-weights); ties break by the fixed ARCHETYPES order. If the best clears MIN_ACT_SCORE it is selected; else
  // nothing acts (downgrade to silence — the anti-slop refusal). Returns { selected, score, reason, dropped }.
  function scoreAndSelect(candidates, opts) {
    opts = opts || {};
    const minScore = Number.isFinite(opts.minScore) ? opts.minScore : MIN_ACT_SCORE;
    const list = Array.isArray(candidates) ? candidates.slice() : [];
    if (!list.length) return { selected: null, score: 0, reason: 'no-candidates', dropped: 0 };
    const order = {}; ARCHETYPES.forEach((a, i) => { order[a.id] = i; });
    const scoreOf = (c) => CONFIDENCE_RANK[c.confidence] || 1;
    let best = list[0];
    for (const c of list) {
      const s = scoreOf(c), bs = scoreOf(best);
      if (s > bs) best = c;
      else if (s === bs && (order[c.archetype] != null ? order[c.archetype] : 99) < (order[best.archetype] != null ? order[best.archetype] : 99)) best = c;
    }
    const bestScore = scoreOf(best);
    if (bestScore < minScore) return { selected: null, score: bestScore, reason: 'low-confidence', dropped: list.length };
    return { selected: best, score: bestScore, reason: 'selected', dropped: list.length - 1 };
  }

  // THE DO DIRECTIVE — the reason-only task that actually does the selected job and ends with a titled draft.
  //   selected: a candidate { title, archetype, grounds, spec }; ctx: { name }
  function buildDoDirective(selected, ctx) {
    selected = selected || {}; ctx = ctx || {};
    const lines = [];
    lines.push('INTERNAL — SELF-DIRECTED WORK. The Commander is away. Do not run any tools. Reason only, then reply in the exact format below.');
    lines.push('Do this ONE job now and leave a finished draft on their desk:');
    lines.push('- JOB: ' + String(selected.title || '').trim());
    if (selected.grounds) lines.push('- WHY IT MATTERS TO THEM: ' + String(selected.grounds).trim());
    if (selected.spec) lines.push('- DONE WHEN: ' + String(selected.spec).trim());
    lines.push('Rules: REASONING / DRAFTING only — no tools, no web, no file writes, no sending. Finish it completely from what you know; if a piece genuinely needs info you do not have, draft around it and flag the gap rather than guessing.');
    lines.push('Reply EXACTLY:');
    lines.push('TITLE: <a short title for the draft>');
    lines.push('<the finished draft itself, ready for them to read>');
    return lines.join('\n');
  }

  // parse the do-run output into a deliverable, tolerantly. Pulls a leading TITLE: line; the rest is the draft body.
  // Falls back to the selected job's title. Returns { title, body } or null if there's no usable body.
  function parseDeliverable(text, opts) {
    opts = opts || {};
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    let title = '', body = raw;
    const m = /^\s*TITLE\s*:\s*(.+?)\s*(?:\n|$)/i.exec(raw);
    if (m) { title = m[1].trim(); body = raw.slice(m.index + m[0].length).trim(); }
    if (!title) title = String(opts.fallbackTitle || 'Draft').trim().slice(0, 80);
    if (!body) return null;
    return { title: title.slice(0, 80), body };
  }

  return {
    idleFor, readiness, decide, newestStamp,
    eligibleArchetypes, grounded, sigTokens, flattenBeliefs,
    buildCandidateDirective, parseCandidates, scoreAndSelect, buildDoDirective, parseDeliverable,
    DEFAULT_IDLE_MS, DEFAULT_TICK_MS, REQUIRE_DIM, WARM_MIN, HOT_MIN, STALE_MS,
    ARCHETYPES, CANDIDATE_MAX, MIN_ACT_SCORE, CONFIDENCE_RANK
  };
});
