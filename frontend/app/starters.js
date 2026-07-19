/* STARNET — starters.js : the PURE session-opener chip engine.

   The COMMS empty state used to show the same three chips forever ("what can you do here" /
   Recipes.list()[0] / "brief me on this station") — right for minute one, dead weight by day two.
   This engine picks the chips from what the station HONESTLY knows, client-side, at render time:

     • FRESH STATION (no session history anywhere, nothing ever launched) → the proven orientation
       set, unchanged: tour chip, first catalog recipe, station brief. First-run users need a map.
     • RETURNING COMMANDER →
         1. their USUAL recipe — the most recently launched catalog recipe, chip carries the
            LaunchMemory values so the directive comes back prefilled (kill the retype tax);
         2. a DISCOVERY recipe — cadence-due first (a 'morning' recipe only in the morning),
            otherwise a deterministic day-rotated pick from recipes they have never launched,
            so the catalog reveals itself over time instead of pinning slot 2 to list()[0];
         3. "pitch me an idea" — leans on the existing dossier-grounded pitch surface: the live
            system prompt carries what the agent genuinely knows, so the answer is grounded.

   HONESTY RULES: a chip only ever fills the composer (send/recipe-insert) — it never asserts
   station state, so nothing here can claim what the harness can't prove. "Usual" is defined as
   "you launched this, most recently" (LaunchMemory timestamps), never inferred. The while-away
   digest belongs to returnstore.js — this engine deliberately mints no catch-up chip.

   PURE + node-testable (a `Starters` global; module.exports under node): no DOM, no clock, no
   storage — the caller injects recipes, launch history, hour and day. Deterministic by design
   (day-seeded rotation, never rng). Fail-open everywhere: bad/missing signals → the classic set. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Starters = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_CHIPS = 3;

  // the classic openers — the fresh-station set, and the pad when richer signals run dry.
  const TOUR = { kind: 'send', label: 'what can you do here', send: 'What can you do here? Give me a short tour of what you can actually do for me.' };
  const BRIEF = { kind: 'send', label: 'brief me on this station', send: 'Brief me on this station — what is around me and what I can do from here.' };
  const PITCH = { kind: 'send', label: 'pitch me an idea', send: 'Pitch me one concrete, buildable task you could take on for me right now, based on what you actually know about me. Keep it small.' };

  // cadence gate: only 'morning' implies a time of day. Morning = 05:00–11:59 local.
  function isMorning(hour) { return typeof hour === 'number' && hour >= 5 && hour < 12; }
  function cadenceDue(cadence, hour) { return cadence === 'morning' && isMorning(hour); }
  // a morning recipe outside the morning is an off-hours suggestion — keep it out of discovery.
  function offHours(recipe, hour) { return recipe && recipe.cadence === 'morning' && !isMorning(hour); }

  function recipeChip(recipe, values) {
    const chip = { kind: 'recipe', label: String(recipe.name || recipe.id), recipe: recipe };
    if (values && typeof values === 'object' && Object.keys(values).length) {
      chip.values = values;
      chip.label = '↺ ' + chip.label;   // ↺ — "again, with your last inputs" at a glance
    }
    return chip;
  }

  /* pick(signals) → up to MAX_CHIPS chips, each one of:
       { kind:'send',   label, send }                       — fills the composer and sends
       { kind:'recipe', label, recipe, values? }            — inserts the directive (prefilled) to edit
     signals (all optional; anything missing degrades toward the classic set):
       recipes   — Recipes.list() array ({id,name,task,params,cadence,category,...})
       recent    — [{id,at}] catalog launches, newest first (LaunchMemory.recent())
       valuesOf  — fn(recipeId) → {key:value}|null last-used inputs (LaunchMemory.get)
       returning — true when the station has ANY prior life (other sessions with history, or launches)
       hour      — local hour 0–23;  day — integer day index (drives discovery rotation) */
  function pick(signals) {
    const s = signals || {};
    const recipes = Array.isArray(s.recipes) ? s.recipes.filter(r => r && r.id) : [];
    const recent = Array.isArray(s.recent) ? s.recent.filter(e => e && e.id) : [];
    const valuesOf = typeof s.valuesOf === 'function' ? s.valuesOf : (() => null);
    const hour = (typeof s.hour === 'number' && isFinite(s.hour)) ? s.hour : 12;
    const day = (typeof s.day === 'number' && isFinite(s.day)) ? Math.floor(Math.abs(s.day)) : 0;

    if (!s.returning) {
      // FRESH STATION — the orientation set, byte-identical to the pre-engine behavior.
      const chips = [TOUR];
      if (recipes[0]) chips.push(recipeChip(recipes[0], null));
      chips.push(BRIEF);
      return chips.slice(0, MAX_CHIPS);
    }

    const chips = [];
    const used = {};   // recipe ids already on a chip
    const byId = {};
    for (const r of recipes) byId[r.id] = r;

    // 1. the USUAL — most recent launch still in the catalog, prefilled with its last inputs.
    for (const e of recent) {
      const r = byId[e.id];
      if (r) { chips.push(recipeChip(r, valuesOf(r.id))); used[r.id] = true; break; }
    }

    // 2. DISCOVERY — cadence-due beats rotation; rotation prefers never-launched, skips off-hours.
    const launched = {};
    for (const e of recent) launched[e.id] = true;
    const due = recipes.find(r => !used[r.id] && cadenceDue(r.cadence, hour));
    if (due) { chips.push(recipeChip(due, valuesOf(due.id))); used[due.id] = true; }
    else {
      const fresh = recipes.filter(r => !used[r.id] && !launched[r.id] && !offHours(r, hour));
      const pool = fresh.length ? fresh : recipes.filter(r => !used[r.id] && !offHours(r, hour));
      if (pool.length) { const r = pool[day % pool.length]; chips.push(recipeChip(r, null)); used[r.id] = true; }
    }

    // 3. the generative chip — the dossier-grounded pitch. V3 §6: it EXPLICITLY invites a recommendation, so
    // it rides the shared readiness gate (signals.ready, from Understanding.readiness). Below the gate the
    // slot pads with the classic openers instead — the station never advertises advice it isn't allowed to
    // give. (`undefined` keeps legacy behavior for callers without the readiness read.)
    if (s.ready !== false) chips.push(PITCH);

    // pad a signal-starved station (e.g. empty catalog) back up with the classic openers.
    if (chips.length < MAX_CHIPS) chips.push(BRIEF);
    if (chips.length < MAX_CHIPS) chips.unshift(TOUR);
    return chips.slice(0, MAX_CHIPS);
  }

  return { pick, MAX_CHIPS, _cadenceDue: cadenceDue };
});
