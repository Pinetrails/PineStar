/* STARNET — xp.js : the AGENT-GROWTH model — XP, Level, and a Confidence (reliability) gauge.
   Pure + testable (UMD: an `Xp` global in the browser, module.exports under node).

   Two HONEST meters, read off explicit user satisfaction — never fabricated, mirroring ctxgauge.js:
     • XP / LEVEL  — cumulative, MONOTONIC user trust. You never lose a level.
                     Curve: cumulative XP to REACH level n = LEVEL_K * n * (n-1)
                     (L2=50, L3=150, L5=500, L10=2250, L28=18900).
     • CONFIDENCE  — a recency-weighted (EWMA) satisfaction %, moves BOTH ways. Reports
                     known:false ("calibrating") until MIN_SAMPLES user feedback samples exist, so a
                     fresh agent never shows a made-up number.

   The design rule: these DESCRIBE the agent's user-approved growth/reliability — they never GATE it. No
   capability is ever locked behind a level. The station-wide rollup uses the SAME engine fed
   the same events, so "STATION Lv 28" is just the colony's cumulative, user-approved track record. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Xp = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- tunables (one place to retune the whole feel) ----
  const LEVEL_K = 25;       // cumulative XP to REACH level n = LEVEL_K * n * (n-1)
  const ALPHA = 0.25;       // EWMA weight — how fast satisfaction tracks recent feedback
  const SEED_CONF = 50;     // neutral starting confidence (held, not shown, until calibrated)
  const MIN_SAMPLES = 3;    // user feedback samples needed before confidence is "known"
  const FEEDBACK_XP_PER_DELTA = 10; // explicit positive user turn-in feedback is the only XP mint
  const FEEDBACK_XP_CAP = 50;       // cap one feedback event so one huge delta cannot jump many levels
  // G2.4 task-size weighting (the locked leveling-redesign TODO): an optional payload.size hint
  // ('small'|'medium'|'large', derived from REAL tool count + spend — see workSize) SCALES the minted
  // XP, never invents it: no positive verdict, no XP, whatever the size; FEEDBACK_XP_CAP stays the
  // hard ceiling. Absent/unknown size = 1 (fully additive — every existing payload is unchanged).
  const SIZE_MULT = { small: 1, medium: 1.25, large: 1.5 };

  // derive the honest size hint from a run's REAL work: successful tool calls + reconciled spend.
  // Pure + shared so the rate-the-work caller (chat.js) and tests agree on one derivation.
  function workSize(w) {
    const tools = Math.max(0, (w && w.tools) | 0);
    const usd = Math.max(0, (w && typeof w.usd === 'number' && isFinite(w.usd)) ? w.usd : 0);
    if (tools >= 6 || usd >= 0.5) return 'large';
    if (tools >= 3 || usd >= 0.08) return 'medium';
    return 'small';
  }

  function feedbackReason(p) {
    return String((p && p.reason) || '').trim().toLowerCase();
  }
  function turnInFeedbackQuality(reason) {
    if (reason === 'kept' || reason === 'edited') return 1;
    if (reason === 'discarded') return 0;
    // The post-run "rate the work" beat (chat.js) rides this SAME mint path with a synthetic id, called
    // directly into XpStore (never the bus / never the sidecar memory store — so memory trust is untouched).
    if (reason === 'work_great') return 1;     // 👍 nailed it — full positive: mints size-weighted XP + confidence up
    if (reason === 'work_ok') return 0.5;      // 👌 close — a neutral satisfaction sample only: never mints XP
    if (reason === 'work_miss') return 0;      // 👎 missed — confidence down, no XP, and NO penalty
    return null;
  }

  // ---- XP + satisfaction per event ----
  // XP comes ONLY from explicit positive user feedback — a turn-in Keep/Edit OR a 👍 "rate the work" verdict
  // (both ride memory.feedback). Operational events still feed counters but never level an agent on their own.
  // returns { xp, quality } : xp is positive-only (failures/negative feedback never subtract);
  // quality in [0,1] feeds satisfaction confidence, or null when the event carries no user judgment.
  function scoreEvent(name, p) {
    p = p || {};
    switch (name) {
      case 'agent.run.end': {
        switch (p.reason) {
          case 'done':      return { xp: 0, quality: null };
          case 'max_iters': return { xp: 0, quality: null };
          case 'budget':    return { xp: 0, quality: null };
          case 'refusal':   return { xp: 0, quality: null };
          case 'error':     return { xp: 0, quality: null };
          case 'cancelled': return { xp: 0, quality: null };
          default:          return { xp: 0, quality: null };
        }
      }
      case 'agent.tool_result':  return { xp: 0, quality: null };
      case 'memory.write':       return { xp: 0, quality: null };
      case 'memory.used':        return { xp: 0, quality: null };
      case 'memory.feedback': {
        const quality = turnInFeedbackQuality(feedbackReason(p));
        if (quality === null) return { xp: 0, quality: null };
        const d = (typeof p.delta === 'number' && Number.isFinite(p.delta)) ? p.delta : 0;
        const eff = Math.min(Math.max(d, 0), 10);
        // ONLY a full positive (quality 1 = kept/edited/work_great) mints; a 👌 work_ok (0.5) is a satisfaction
        // sample with no XP. Gate on >=1 so the neutral middle rung never levels an agent.
        // An optional size hint scales the mint (task-size weighting); the CAP stays the ceiling.
        const mult = SIZE_MULT[String(p.size || '')] || 1;
        return { xp: quality >= 1 && d > 0 ? Math.min(FEEDBACK_XP_CAP, Math.round(eff * FEEDBACK_XP_PER_DELTA * mult)) : 0, quality };
      }
      case 'workitem.delivered': return { xp: 0, quality: null };
      case 'channel.delivery':   return { xp: 0, quality: null };
      default:                   return { xp: 0, quality: null };
    }
  }

  // ---- the curve ----
  function xpForLevel(level) { level = Math.max(1, Math.floor(level || 1)); return LEVEL_K * level * (level - 1); }
  function levelForXp(xp) {
    if (!Number.isFinite(xp)) return 1;   // defensive: a corrupted save must never yield Infinity/NaN levels
    xp = Math.max(0, Math.floor(xp));
    // largest n with LEVEL_K*n*(n-1) <= xp  ->  n = floor((1 + sqrt(1 + 4*xp/LEVEL_K)) / 2)
    return Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / LEVEL_K)) / 2));
  }

  // agents with established positive user feedback grow FASTER: a trust multiplier on earned XP, but ONLY
  // once calibrated, and NEVER a penalty (sub-45% confidence just earns base). Tiers align with the bands in compute().
  function trustMult(s) {
    if ((s.samples || 0) < MIN_SAMPLES) return 1;
    const c = s.confidence || 0;
    return c >= 85 ? 1.5 : c >= 65 ? 1.3 : c >= 45 ? 1.15 : 1;
  }

  // ---- the stats shape (used for BOTH a single agent and the station rollup) ----
  function fresh() { return { xp: 0, level: 1, lifetimeXp: 0, confidence: SEED_CONF, samples: 0, counters: {}, milestones: [] }; }
  function clone(s) { return s ? JSON.parse(JSON.stringify(s)) : fresh(); }
  // defensive: a corrupted / hand-edited save must never let a non-finite value (NaN/Infinity) poison the
  // meters. The schema validator blocks these at the bus; this is belt-and-suspenders on the persisted state.
  function num(v, d) { return Number.isFinite(v) ? v : d; }
  function sanitize(s) {
    s.confidence = Math.max(0, Math.min(100, num(s.confidence, SEED_CONF)));
    s.xp = Math.max(0, Math.floor(num(s.xp, 0)));
    s.lifetimeXp = Math.max(0, Math.floor(num(s.lifetimeXp, 0)));
    s.samples = Math.max(0, Math.floor(num(s.samples, 0)));
    s.level = Math.max(1, Math.floor(num(s.level, 1)));
    return s;
  }

  // ---- milestones — declarative; each fires ONCE when its predicate first holds ----
  // each carries a display label + the unlock HINT shown on its locked badge (drives the trophy case).
  const MILESTONES = [
    { id: 'first_light', label: 'FIRST LIGHT', hint: 'ship 1 task',       when: (c) => (c.tasksDone || 0) >= 1 },     // first task shipped
    { id: 'approved',    label: 'APPROVED',    hint: 'earn positive feedback', when: (c) => (c.positiveFeedback || 0) >= 1 }, // first user approval
    { id: 'pack_rat',    label: 'PACK RAT',    hint: 'reuse a memory',    when: (c) => (c.memReused || 0) >= 1 },     // first memory reused
    { id: 'archivist',   label: 'ARCHIVIST',   hint: '10 memories saved', when: (c) => (c.memWrites || 0) >= 10 },    // built a real memory bank
    { id: 'workhorse',   label: 'WORKHORSE',   hint: '25 tasks',          when: (c) => (c.tasksDone || 0) >= 25 },    // 25 tasks shipped
    { id: 'centurion',   label: 'CENTURION',   hint: '100 tasks',         when: (c) => (c.tasksDone || 0) >= 100 },   // 100 tasks shipped
    { id: 'night_shift', label: 'NIGHT SHIFT', hint: '1 delivery',        when: (c) => (c.delivered || 0) >= 1 },     // delivered work via an external channel
    { id: 'trusted',     label: 'TRUSTED',     hint: 'satisfaction 85%',  when: (c, s) => s.samples >= MIN_SAMPLES && s.confidence >= 85 },   // satisfaction -> TRUSTED
    { id: 'veteran',     label: 'VETERAN',     hint: 'reach Lv 10',       when: (c, s) => s.level >= 10 },            // reached level 10
  ];
  function bump(c, k) { c[k] = (c[k] || 0) + 1; }

  // ---- the one transform: fold a real event into a stats object (pure: returns a NEW object) ----
  // ev = { name, payload }.  returns { stats, awards } where
  //   awards = { xp, levelFrom, levelTo, levelUp, milestones[] }
  function applyEvent(stats, ev) {
    const s = sanitize(clone(stats));
    if (!s.counters) s.counters = {};
    if (!s.milestones) s.milestones = [];
    if (!s.run || typeof s.run !== 'object') s.run = { id: null, toolXp: 0 };
    const name = (ev && ev.name) || '', p = (ev && ev.payload) || {};
    const sc = scoreEvent(name, p);
    const awards = { xp: 0, levelFrom: s.level, levelTo: s.level, levelUp: false, milestones: [] };

    // base XP: explicit positive user feedback only. Operational events can still update counters below,
    // but they cannot mint XP or move the level ladder by themselves.
    let base = sc.xp;

    // XP — monotonic, scaled by the agent's ESTABLISHED satisfaction (trust bonus uses pre-update confidence)
    if (base > 0) {
      const gained = Math.round(base * trustMult(s));
      s.xp += gained; s.lifetimeXp += gained; awards.xp = gained;
      const lvl = levelForXp(s.xp);
      if (lvl > s.level) { awards.levelUp = true; awards.levelTo = lvl; }
      s.level = lvl;
    }

    // CONFIDENCE — bidirectional EWMA; only explicit user feedback moves it
    if (sc.quality !== null && sc.quality !== undefined) {
      s.samples += 1;
      s.confidence = Math.max(0, Math.min(100, s.confidence + ALPHA * (sc.quality * 100 - s.confidence)));
    }

    // COUNTERS — drive milestones + the dossier
    if (name === 'agent.run.end') { bump(s.counters, 'runs'); if (p.reason === 'done') bump(s.counters, 'tasksDone'); }
    else if (name === 'agent.tool_result' && p.ok && !p.isError) bump(s.counters, 'toolsOk');
    else if (name === 'memory.write') bump(s.counters, 'memWrites');
    else if (name === 'memory.used') bump(s.counters, 'memReused');
    else if (name === 'memory.feedback') {
      const quality = turnInFeedbackQuality(feedbackReason(p));
      if (quality === 1) bump(s.counters, 'positiveFeedback');
      else if (quality === 0) bump(s.counters, 'negativeFeedback');
    }
    else if (name === 'workitem.delivered') bump(s.counters, 'delivered');

    // MILESTONES — fire once
    for (const m of MILESTONES) {
      if (s.milestones.indexOf(m.id) === -1 && m.when(s.counters, s)) { s.milestones.push(m.id); awards.milestones.push(m.id); }
    }
    return { stats: s, awards };
  }

  // ---- render-state for the gauges (pure transform → render-agnostic, mirrors CtxGauge.compute) ----
  function compute(stats) {
    const s = stats || fresh();
    const level = Math.max(1, Math.floor(num(s.level, 1)));
    const base = xpForLevel(level), next = xpForLevel(level + 1), span = Math.max(1, next - base);
    const xp = Math.max(0, Math.floor(num(s.xp, 0)));
    const inLevel = Math.max(0, xp - base);
    const frac = Math.max(0, Math.min(1, inLevel / span));
    const known = Math.max(0, Math.floor(num(s.samples, 0))) >= MIN_SAMPLES;   // honesty: no fabricated % before calibration
    const conf = Math.round(Math.max(0, Math.min(100, num(s.confidence, 0))));
    const bonus = Math.round((trustMult(s) - 1) * 100);     // current feedback XP bonus as a percent (0 / 15 / 30 / 50)
    return {
      level, xp, lifetimeXp: Math.max(0, s.lifetimeXp || 0),
      inLevel, span, toNext: Math.max(0, next - xp),
      frac, pct: Math.round(frac * 100),
      known, confidence: known ? conf : null, confLabel: known ? (conf + '%') : '—', bonus,
      band: !known ? 'calibrating' : conf >= 85 ? 'trusted' : conf >= 65 ? 'reliable' : conf >= 45 ? 'steady' : 'building',
      tasksDone: Math.max(0, Math.floor(num(s.counters && s.counters.tasksDone, 0))),   // shipped-task count for the dossier
      positiveFeedback: Math.max(0, Math.floor(num(s.counters && s.counters.positiveFeedback, 0))),
      negativeFeedback: Math.max(0, Math.floor(num(s.counters && s.counters.negativeFeedback, 0))),
      samples: Math.max(0, Math.floor(num(s.samples, 0))),                              // feedback samples behind the confidence %
      milestones: (s.milestones || []).slice(),
    };
  }

  // the FULL milestone catalogue as render-state: every badge with its label, unlock hint, and earned flag —
  // earned ones lit, locked ones shown with what unlocks them. Pure → drives the trophy case in the dossier.
  function milestones(stats) {
    const earned = (stats && Array.isArray(stats.milestones)) ? stats.milestones : [];
    return MILESTONES.map(m => ({ id: m.id, label: m.label, hint: m.hint, earned: earned.indexOf(m.id) !== -1 }));
  }

  return { fresh, clone, applyEvent, compute, scoreEvent, levelForXp, xpForLevel, milestones, MILESTONES, LEVEL_K, MIN_SAMPLES, workSize };
});
