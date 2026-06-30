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

  return {
    idleFor, readiness, decide, newestStamp,
    DEFAULT_IDLE_MS, DEFAULT_TICK_MS, REQUIRE_DIM, WARM_MIN, HOT_MIN, STALE_MS
  };
});
