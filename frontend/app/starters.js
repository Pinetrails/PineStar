/* STARNET — starters.js : the PURE session-opener chip engine.

   The COMMS empty state used to show the same three chips forever ("what can you do here" /
   Recipes.list()[0] / "brief me on this station") — right for minute one, dead weight by day two.
   This engine picks the chips from what the station HONESTLY knows, client-side, at render time:

     • FRESH STATION (no session history anywhere, nothing ever launched) → the proven orientation
       set, unchanged: tour chip, first catalog recipe, station brief. First-run users need a map.
     • RETURNING COMMANDER → only chips EARNED by real prior activity, in this order, cap 3:
         1. their USUAL recipe — the most recently launched catalog recipe, chip carries the
            LaunchMemory values so the directive comes back prefilled (kill the retype tax);
         2. a cadence-DUE recipe — a 'morning' recipe, in the morning. Due-ness is the ONLY
            discovery left: the old day-rotated random catalog pick pushed recipes the
            Commander never asked for ("Release Notes" to someone who never shipped notes)
            and is gone. No signal → no chip.
         3. NEXT STEP on their most recent titled session — the one thing they were actually
            doing. The send is phrased like the pitch ask ("what you actually know") so it
            never presumes recall the agent may not have.
         4. "pitch me an idea" — leans on the existing dossier-grounded pitch surface: the live
            system prompt carries what the agent genuinely knows, so the answer is grounded.
       A returning Commander NEVER sees the orientation chips again — tour/brief are minute-one
       chips; a short row of earned chips beats a padded row of dead ones.

   HONESTY RULES: a chip only ever fills the composer (send/recipe-insert) — it never asserts
   station state, so nothing here can claim what the harness can't prove. "Usual" is defined as
   "you launched this, most recently" (LaunchMemory timestamps), never inferred. The while-away
   digest belongs to returnstore.js — this engine deliberately mints no catch-up chip.

   PURE + node-testable (a `Starters` global; module.exports under node): no DOM, no clock, no
   storage — the caller injects recipes, launch history, sessions and hour. Deterministic, never
   rng. Fail-open: bad/missing signals just mean fewer chips (fresh station → the classic set). */
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
       sessions  — [{title,at}] OTHER real sessions (titled, with history), newest first
       valuesOf  — fn(recipeId) → {key:value}|null last-used inputs (LaunchMemory.get)
       returning — true when the station has ANY prior life (other sessions with history, or launches)
       hour      — local hour 0–23 (drives cadence due-ness) */
  function pick(signals) {
    const s = signals || {};
    const recipes = Array.isArray(s.recipes) ? s.recipes.filter(r => r && r.id) : [];
    const recent = Array.isArray(s.recent) ? s.recent.filter(e => e && e.id) : [];
    const valuesOf = typeof s.valuesOf === 'function' ? s.valuesOf : (() => null);
    const hour = (typeof s.hour === 'number' && isFinite(s.hour)) ? s.hour : 12;

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

    // 2. cadence-DUE only — a recipe whose moment is NOW (morning recipe, in the morning).
    // The old fallback (day-rotated random catalog pick) recommended work the Commander never
    // asked for; earned-context law: no signal → no chip.
    const due = recipes.find(r => !used[r.id] && cadenceDue(r.cadence, hour));
    if (due) { chips.push(recipeChip(due, valuesOf(due.id))); used[due.id] = true; }

    // 3. NEXT STEP on the most recent titled session — the thing they were actually doing.
    // Phrased like the pitch ask: grounded in "what you actually know", never presuming recall.
    const sess = Array.isArray(s.sessions) ? s.sessions.find(x => x && typeof x.title === 'string' && x.title.trim()) : null;
    if (sess) {
      const t = sess.title.trim();
      const short = t.length > 28 ? t.slice(0, 27).trimEnd() + '…' : t;
      chips.push({
        kind: 'send', label: 'next step: ' + short.toLowerCase(),
        send: 'Next step on "' + t + '" — based on what you actually know about that work, propose the single next concrete step. If you are missing context, ask me one sharp question instead.'
      });
    }

    // 4. the generative chip — the dossier-grounded pitch. Always earned (dossier exists), so a
    // signal-starved returning station still gets one live chip — never the orientation pads.
    chips.push(PITCH);
    return chips.slice(0, MAX_CHIPS);
  }

  return { pick, MAX_CHIPS, _cadenceDue: cadenceDue };
});
