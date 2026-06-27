/* STARNET — pitch.js : the PURE engine for THE FIRST PITCH (the agent's first proactive use-case suggestion).

   The keystone of the "agent that points you" loop. The whole station spends the awakening + intake getting to
   KNOW its Commander (the dossier); the First Pitch is the moment that knowledge flows back the other way — the
   agent stops waiting for orders and, once it has done one real task and knows enough about you, turns to you with
   ONE confident, buildable thing to make next. This is the graduation from order-taker to advisor — the single
   most differentiating beat in the app ("i think i know what we should build — want to?").

   Two hard disciplines live here, encoded so they can't rot:
     1. NO FLUFF. A pitch is only ever something the station can actually build — it must map to a real recipe or be
        achievable with the capabilities the agent actually has. buildDirective() constrains the agent to that; a
        pitch it can't deliver would shatter presence (the hype-bot failure).
     2. ONE pitch, not a menu. A confident single suggestion takes the choosing-burden off the user (the whole
        point); a menu hands the blank-canvas paralysis right back. choices() is always [build it] + a soft out.

   The pitch itself is AGENT-REASONED, not templated: buildDirective() produces the self-assigned task the agent
   runs (reading the COMMANDER block already in its system prompt), and parsePitch() reads its structured reply
   back into a beat. This engine is the deterministic skeleton around that real reasoning — the gate (when to
   pitch), the directive (what to ask for), the parse (how to read it), and the presentation (how to say it).

   PURE + node-testable, mirroring curiosity.js / dossier.js: a `Pitch` global in the browser, module.exports
   under node. NO Date.now / Math.random — the only state is a boolean "have we pitched yet" (fire-once, anti-nag,
   same discipline as the curiosity cap); timestamps/ids are not this engine's concern. The COMMS/flow half (the
   controller that runs the directive and renders the beat) lives in the browser wiring, exactly like intake.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Pitch = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the graduation gate defaults: the station won't pitch until it knows what you're trying to do (goals) AND has
  // at least this many dimensions filled — enough to be confident, not a guess from nothing.
  const REQUIRE_DIMS = ['goals'];   // can't propose a build without knowing what the Commander actually wants
  const MIN_KNOWN = 2;              // at least two dossier dimensions filled before the agent dares to advise
  const MAX_RECIPES = 8;            // cap the recipe shelf we show the agent (keeps the directive lean + the prompt warm)
  const SUGGEST_MIN_GAP = 3;        // ongoing ideas: min completed tasks between suggestions (cooldown, anti-nag)
  const SUGGEST_SESSION_CAP = 1;    // ongoing ideas: at most one gentle suggestion per session (mirrors the curiosity cap)

  // the persisted shape: whether the one-time First Pitch has already fired (so it never repeats — fire-once).
  function fresh() { return { v: 1, pitched: false }; }

  // THE GATE — should the agent deliver its First Pitch right now? Returns { go, reason } (reason is honest
  // telemetry: why it stayed quiet, or 'ready'). Order of checks is deliberate: fire-once first, then proof-of-life,
  // then "do we know enough to be confident."
  //   firstTaskDone — has the agent completed one real task? (advice comes AFTER it proves it works, never before)
  //   alreadyPitched — the persisted fire-once flag (fresh().pitched)
  //   knownDims      — dossier dimensions that hold at least one belief (from Dossier.summary().known)
  //   requireDims    — dimensions that MUST be known to pitch (default ['goals'])
  //   minKnown       — minimum count of known dimensions (default MIN_KNOWN)
  function shouldPitch(state) {
    state = state || {};
    if (state.alreadyPitched) return { go: false, reason: 'already-pitched' };
    if (!state.firstTaskDone) return { go: false, reason: 'awaiting-first-task' };
    const known = Array.isArray(state.knownDims) ? state.knownDims : [];
    const require = Array.isArray(state.requireDims) ? state.requireDims : REQUIRE_DIMS;
    const minKnown = Number.isFinite(state.minKnown) ? state.minKnown : MIN_KNOWN;
    for (const d of require) if (known.indexOf(d) < 0) return { go: false, reason: 'missing:' + d };
    if (known.length < minKnown) return { go: false, reason: 'too-cold' };
    return { go: true, reason: 'ready' };
  }

  // THE ONGOING-SUGGESTION CADENCE (Slice 3) — the RECURRING counterpart to the one-time First Pitch. Once the
  // First Pitch has happened, the station offers a fresh tailored idea when it has LEARNED SOMETHING NEW about the
  // Commander (the dossier grew since the last idea) — gently: a per-session cap + a task cooldown, never a nag.
  // Same honesty discipline as shouldPitch: every quiet outcome carries a reason. Order: graduation-first, then
  // can-we-propose-a-build, then budget, then cooldown, then is-there-actually-something-new.
  //   firstPitchDone  — the one-time First Pitch must precede ongoing ideas (graduation first)
  //   knownDims       — dossier dims with a belief (needs 'goals' to propose a build)
  //   familiarity     — current dossier familiarity (0..1, from Dossier.summary().familiarity)
  //   lastFamiliarity — familiarity at the previous idea/pitch; familiarity > lastFamiliarity ⇒ something new to say
  //   tasksSinceLast  — completed tasks since the last idea (cooldown)
  //   minGap          — min tasks between ideas (default SUGGEST_MIN_GAP)
  //   sessionShown    — ideas already shown this session; sessionCap — per-session ceiling (default 1)
  function shouldSuggest(state) {
    state = state || {};
    if (!state.firstPitchDone) return { go: false, reason: 'no-first-pitch' };
    const known = Array.isArray(state.knownDims) ? state.knownDims : [];
    const require = Array.isArray(state.requireDims) ? state.requireDims : REQUIRE_DIMS;
    for (const d of require) if (known.indexOf(d) < 0) return { go: false, reason: 'missing:' + d };
    const cap = Number.isFinite(state.sessionCap) ? state.sessionCap : SUGGEST_SESSION_CAP;
    if ((state.sessionShown || 0) >= cap) return { go: false, reason: 'session-spent' };
    const minGap = Number.isFinite(state.minGap) ? state.minGap : SUGGEST_MIN_GAP;
    if ((state.tasksSinceLast || 0) < minGap) return { go: false, reason: 'cooldown' };
    const fam = Number.isFinite(state.familiarity) ? state.familiarity : 0;
    const last = Number.isFinite(state.lastFamiliarity) ? state.lastFamiliarity : 0;
    if (fam <= last) return { go: false, reason: 'nothing-new' };   // only speak up when it has actually learned more about you
    return { go: true, reason: 'ready' };
  }

  // THE DIRECTIVE — the self-assigned task the agent runs to GENERATE its pitch. The agent already carries the
  // COMMANDER block (what it knows about you) in its system prompt, so this tells it to USE that, not re-state it.
  // It hard-constrains the agent to ONE concrete, BUILDABLE proposal grounded in the real recipes/capabilities, and
  // demands a strict tagged reply so parsePitch() can read it. Deterministic: same ctx → byte-identical directive.
  //   recipes       — [{ id, name, tagline }] the real recipe shelf (the agent should prefer mapping to one)
  //   capabilities  — [{ id, label }] the capabilities the agent actually HAS (the buildable envelope)
  //   recentTask    — the title/text of the first task it just did (so the pitch can build on real behavior)
  //   maxRecipes    — cap on listed recipes (default MAX_RECIPES)
  function buildDirective(ctx) {
    ctx = ctx || {};
    const recipes = (Array.isArray(ctx.recipes) ? ctx.recipes : []).slice(0, Number.isFinite(ctx.maxRecipes) ? ctx.maxRecipes : MAX_RECIPES);
    const caps = Array.isArray(ctx.capabilities) ? ctx.capabilities : [];
    const recent = String(ctx.recentTask == null ? '' : ctx.recentTask).trim();

    const lines = [];
    lines.push('INTERNAL — THE FIRST PITCH. Do not run any tools. Reason only, then reply in the exact format below.');
    lines.push('You now know your Commander (see what you know about them, above). Propose the SINGLE most valuable thing to build for THEM next — a real use case they would actually want, not a generic suggestion.');
    lines.push('Hard rules:');
    lines.push('- Exactly ONE proposal. Never a list, never options. Pick the best and commit to it.');
    lines.push('- It MUST be buildable here: either it maps to one of the recipes below, or it is achievable with the capabilities you actually have. Never propose something you cannot deliver.');
    lines.push('- It must be specific to this Commander — tie it to what you know about their goals and world.');
    lines.push('- If you know what eats their time or the work they want gone (their pain points), aim the pitch straight at removing that — killing a real recurring chore is the most valuable thing you can build for someone.');
    lines.push('- Name the ONE thing only they can give you to make it truly theirs (their context, taste, or a key fact). That is the gap.');
    if (recent) lines.push('- You just did this for them: "' + recent + '". Build on that if it fits.');
    if (recipes.length) {
      lines.push('Recipes you can instantiate (prefer one of these when it fits):');
      for (const r of recipes) lines.push('  - recipe:' + r.id + ' — ' + String(r.name || r.id) + (r.tagline ? ' (' + r.tagline + ')' : ''));
    }
    if (caps.length) {
      lines.push('Capabilities you actually have: ' + caps.map(c => String(c.label || c.id)).join(', ') + '.');
    }
    lines.push('Reply in EXACTLY this format, nothing else:');
    lines.push('PITCH: <one line — what to build>');
    lines.push('WHY: <one sentence — why it fits this Commander>');
    lines.push('BUILD: recipe:<id from the list above>  OR  workflow');
    lines.push('GAP: <the one thing only the Commander can give you to make it theirs>');
    return lines.join('\n');
  }

  // read the agent's structured reply into a pitch object, tolerantly (LLM output): case-insensitive tags, any
  // surrounding chatter ignored, missing optional fields default to ''. Returns null if there is no PITCH line at
  // all (unparseable → the caller falls back gracefully rather than presenting a broken beat).
  function parsePitch(text) {
    const raw = String(text == null ? '' : text);
    const grab = label => {
      const m = new RegExp('^\\s*' + label + '\\s*:\\s*(.+?)\\s*$', 'im').exec(raw);
      return m ? m[1].trim() : '';
    };
    const title = grab('PITCH');
    if (!title) return null;
    const build = grab('BUILD');
    const rm = /recipe\s*:\s*([\w.-]+)/i.exec(build);
    return {
      title,
      why: grab('WHY'),
      gap: grab('GAP'),
      build: rm ? { kind: 'recipe', recipeId: rm[1] } : { kind: 'workflow', recipeId: null }
    };
  }

  // the confident single-pitch beat: ALWAYS exactly two choices — commit, or a soft escape hatch. Never a menu
  // (that would hand the choosing-burden back to the user). The escape hatch keeps the Commander from ever feeling
  // trapped by the agent's guess; choosing it invites more context (which sharpens the next pitch).
  function choices() {
    return [
      { label: "let's build it", value: 'build' },
      { label: 'something else', value: 'other' }
    ];
  }

  // the spoken pitch line, in the awakening's wry-genius lowercase voice — the famous beat lives here so it has one
  // tested home. Composes only from the parsed fields; omits the gap clause cleanly when the agent gave none.
  function present(parsed) {
    if (!parsed || !parsed.title) return '';
    let s = 'i think i know what we should build first — ' + parsed.title + '.';
    if (parsed.why) s += ' ' + parsed.why;
    if (parsed.gap) s += ' the one thing i need from you to make it yours: ' + parsed.gap;
    return s;
  }

  return { fresh, shouldPitch, shouldSuggest, buildDirective, parsePitch, choices, present, REQUIRE_DIMS, MIN_KNOWN, MAX_RECIPES, SUGGEST_MIN_GAP, SUGGEST_SESSION_CAP };
});
