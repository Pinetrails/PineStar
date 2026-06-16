/* SKYNET — xp.js : the AGENT-GROWTH model — XP, Level, and a Confidence (reliability) gauge.
   Pure + testable (UMD: an `Xp` global in the browser, module.exports under node).

   Two HONEST meters, read off REAL run outcomes — never fabricated, mirroring ctxgauge.js:
     • XP / LEVEL  — cumulative, MONOTONIC "seasoning". You never lose a level.
                     Curve: cumulative XP to REACH level n = LEVEL_K * n * (n-1)
                     (L2=50, L3=150, L5=500, L10=2250, L28=18900).
     • CONFIDENCE  — a recency-weighted (EWMA) reliability %, moves BOTH ways. Reports
                     known:false ("calibrating") until MIN_SAMPLES real outcomes exist, so a
                     fresh agent never shows a made-up number.

   The design rule: these DESCRIBE the agent's growth/reliability — they never GATE it. No
   capability is ever locked behind a level. The station-wide rollup uses the SAME engine fed
   the same events, so "STATION Lv 28" is just the colony's cumulative, honest track record. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Xp = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- tunables (one place to retune the whole feel) ----
  const LEVEL_K = 25;       // cumulative XP to REACH level n = LEVEL_K * n * (n-1)
  const ALPHA = 0.25;       // EWMA weight — how fast confidence tracks recent form
  const SEED_CONF = 50;     // neutral starting confidence (held, not shown, until calibrated)
  const MIN_SAMPLES = 3;    // real reliability signals needed before confidence is "known"
  const TOOL_XP_CAP = 10;   // anti-grind: max RAW tool-success XP counted per run (before the trust bonus)

  // ---- XP + reliability per REAL outcome ----
  // returns { xp, quality } : xp is positive-only (failures never subtract);
  // quality ∈ [0,1] feeds confidence, or null when the event carries no reliability signal.
  function scoreEvent(name, p) {
    p = p || {};
    switch (name) {
      case 'agent.run.end': {
        switch (p.reason) {
          case 'done':      return { xp: 15 + ((typeof p.usd === 'number' && p.usd > 0 && p.usd < 0.5) ? 5 : 0), quality: 1 };
          case 'max_iters': return { xp: 4, quality: 0.5 };
          case 'budget':    return { xp: 4, quality: 0.5 };
          case 'refusal':   return { xp: 0, quality: 0.2 };
          case 'error':     return { xp: 0, quality: 0 };
          case 'cancelled': return { xp: 0, quality: null };   // user aborted — not the agent's reliability
          default:          return { xp: 0, quality: null };
        }
      }
      case 'agent.tool_result': { const ok = !!p.ok && !p.isError; return { xp: ok ? 1 : 0, quality: null }; }   // XP only — one tool slip shouldn't tank reliability; the RUN outcome is the honest signal
      case 'memory.write':       return { xp: 5, quality: null };   // growth/learning, not reliability
      case 'memory.used':        return { xp: 8, quality: null };   // reuse — the behaviour we most want
      case 'memory.feedback': { const d = (typeof p.delta === 'number') ? p.delta : 0; return { xp: d > 0 ? Math.round(d * 5) : 0, quality: d > 0 ? 1 : (d < 0 ? 0 : null) }; }
      case 'workitem.delivered': return { xp: 15, quality: null };  // XP for real async work; reliability rides channel.delivery
      case 'channel.delivery':   return { xp: p.ok ? 3 : 0, quality: p.ok ? 1 : 0 };
      default:                   return { xp: 0, quality: null };
    }
  }

  // ---- the curve ----
  function xpForLevel(level) { level = Math.max(1, Math.floor(level || 1)); return LEVEL_K * level * (level - 1); }
  function levelForXp(xp) {
    xp = Math.max(0, Math.floor(xp || 0));
    // largest n with LEVEL_K*n*(n-1) <= xp  ->  n = floor((1 + sqrt(1 + 4*xp/LEVEL_K)) / 2)
    return Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / LEVEL_K)) / 2));
  }

  // reliable agents grow FASTER: a trust multiplier on earned XP, but ONLY once calibrated, and NEVER a
  // penalty (sub-45% confidence just earns base). Tiers align with the confidence bands in compute().
  function trustMult(s) {
    if ((s.samples || 0) < MIN_SAMPLES) return 1;
    const c = s.confidence || 0;
    return c >= 85 ? 1.5 : c >= 65 ? 1.3 : c >= 45 ? 1.15 : 1;
  }

  // ---- the stats shape (used for BOTH a single agent and the station rollup) ----
  function fresh() { return { xp: 0, level: 1, lifetimeXp: 0, confidence: SEED_CONF, samples: 0, counters: {}, milestones: [] }; }
  function clone(s) { return s ? JSON.parse(JSON.stringify(s)) : fresh(); }

  // ---- milestones — declarative; each fires ONCE when its predicate first holds ----
  const MILESTONES = [
    { id: 'first_light', when: (c) => (c.tasksDone || 0) >= 1 },     // first task shipped
    { id: 'pack_rat',    when: (c) => (c.memReused || 0) >= 1 },     // first memory reused
    { id: 'archivist',   when: (c) => (c.memWrites || 0) >= 10 },    // built a real memory bank
    { id: 'workhorse',   when: (c) => (c.tasksDone || 0) >= 25 },    // 25 tasks shipped
    { id: 'centurion',   when: (c) => (c.tasksDone || 0) >= 100 },   // 100 tasks shipped
    { id: 'night_shift', when: (c) => (c.delivered || 0) >= 1 },     // delivered work via an external channel
    { id: 'trusted',     when: (c, s) => s.samples >= MIN_SAMPLES && s.confidence >= 85 },   // reliability -> TRUSTED
    { id: 'veteran',     when: (c, s) => s.level >= 10 },            // reached level 10
  ];
  function bump(c, k) { c[k] = (c[k] || 0) + 1; }

  // ---- the one transform: fold a real event into a stats object (pure: returns a NEW object) ----
  // ev = { name, payload }.  returns { stats, awards } where
  //   awards = { xp, levelFrom, levelTo, levelUp, milestones[] }
  function applyEvent(stats, ev) {
    const s = clone(stats);
    if (!s.counters) s.counters = {};
    if (!s.milestones) s.milestones = [];
    if (!s.run || typeof s.run !== 'object') s.run = { id: null, toolXp: 0 };
    const name = (ev && ev.name) || '', p = (ev && ev.payload) || {};
    const sc = scoreEvent(name, p);
    const awards = { xp: 0, levelFrom: s.level, levelTo: s.level, levelUp: false, milestones: [] };

    // base XP, with a per-run cap on high-frequency tool successes (anti-grind)
    let base = sc.xp;
    if (name === 'agent.tool_result' && base > 0) {
      if (p.runId !== s.run.id) s.run = { id: p.runId || null, toolXp: 0 };
      base = Math.min(base, Math.max(0, TOOL_XP_CAP - s.run.toolXp));
      s.run.toolXp += base;
    }

    // XP — monotonic, scaled by the agent's ESTABLISHED reliability (trust bonus uses pre-update confidence)
    if (base > 0) {
      const gained = Math.round(base * trustMult(s));
      s.xp += gained; s.lifetimeXp += gained; awards.xp = gained;
      const lvl = levelForXp(s.xp);
      if (lvl > s.level) { awards.levelUp = true; awards.levelTo = lvl; }
      s.level = lvl;
    }

    // CONFIDENCE — bidirectional EWMA; only outcomes with a reliability signal move it
    if (sc.quality !== null && sc.quality !== undefined) {
      s.samples += 1;
      s.confidence = Math.max(0, Math.min(100, s.confidence + ALPHA * (sc.quality * 100 - s.confidence)));
    }

    // COUNTERS — drive milestones + the dossier
    if (name === 'agent.run.end') { bump(s.counters, 'runs'); if (p.reason === 'done') bump(s.counters, 'tasksDone'); }
    else if (name === 'agent.tool_result' && p.ok && !p.isError) bump(s.counters, 'toolsOk');
    else if (name === 'memory.write') bump(s.counters, 'memWrites');
    else if (name === 'memory.used') bump(s.counters, 'memReused');
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
    const level = Math.max(1, s.level || 1);
    const base = xpForLevel(level), next = xpForLevel(level + 1), span = Math.max(1, next - base);
    const xp = Math.max(0, s.xp || 0);
    const inLevel = Math.max(0, xp - base);
    const frac = Math.max(0, Math.min(1, inLevel / span));
    const known = (s.samples || 0) >= MIN_SAMPLES;          // honesty: no fabricated % before calibration
    const conf = Math.round(Math.max(0, Math.min(100, s.confidence || 0)));
    const bonus = Math.round((trustMult(s) - 1) * 100);     // current XP trust bonus as a percent (0 / 15 / 30 / 50)
    return {
      level, xp, lifetimeXp: Math.max(0, s.lifetimeXp || 0),
      inLevel, span, toNext: Math.max(0, next - xp),
      frac, pct: Math.round(frac * 100),
      known, confidence: known ? conf : null, confLabel: known ? (conf + '%') : '—', bonus,
      band: !known ? 'calibrating' : conf >= 85 ? 'trusted' : conf >= 65 ? 'reliable' : conf >= 45 ? 'steady' : 'building',
      milestones: (s.milestones || []).slice(),
    };
  }

  return { fresh, clone, applyEvent, compute, scoreEvent, levelForXp, xpForLevel, MILESTONES, LEVEL_K, MIN_SAMPLES };
});
