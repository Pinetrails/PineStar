/* STARNET — interview.js : the PURE engine for THE INTAKE INTERVIEW (Commander Dossier, Phase B).

   The station actively gets to know its Commander: a short, optional, skippable Q&A — one question per
   blank dossier dimension — whose answers become durable dossier beliefs. This is the "deeply research the
   user" move made real (the user is asked directly; nothing is inferred and nothing reaches outside the
   conversation). The flow/COMMS half lives in intake.js (a thin controller mirroring onboarding.js); ALL
   the decision logic — which questions to ask, in what order, and how an answer becomes a belief — lives
   here, pure + node-testable (a `Interview` global in the browser, module.exports under node).

   The question DIMENSIONS are kept in lockstep with dossier.js's DIMS by interview.test.js, so a typo can
   never silently drop a belief into a non-existent dimension. Voice = the awakening's WRY GENIUS, lighter:
   a peer catching up on who it works for, never a form. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Interview = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // one question per dimension (dims mirror dossier.js DIMS — enforced by the test). `chips` are
  // domain-agnostic quick answers (tap) OR the user types their own; a `skip` chip carries an empty value.
  // V3 §7 (scene register, the awakening-question rule sharpened): never ask for the ABSTRACTION — ask for
  // the SCENE that contains it. Every question drops the Commander into a concrete moment of their real life
  // so the answer falls out of them; the agent does the synthesis. Chip taps still land as weight 'seed'
  // (beliefFromAnswer) — prompt-informing, never gate-opening; only their typed words are 'stated'.
  const QUESTIONS = [
    { dim: 'identity',
      pre: 'let me actually get to know my Commander — not just take orders from a silhouette.',
      ask: 'paint me your tuesday — the real one, not the calendar version. where do the hours actually go?',
      chips: [{ label: 'skip', value: '', skip: true }] },

    { dim: 'stack',
      pre: 'so i reach for the right tools instead of guessing —',
      ask: 'what’s open on your screen right now? that’s the honest answer.',
      chips: [
        { label: 'An editor & a terminal', value: 'Works in a code editor and terminal most of the day.' },
        { label: 'Docs & spreadsheets', value: 'Lives in documents and spreadsheets most of the day.' },
        { label: 'Design / media tools', value: 'Lives in design or media tools most of the day.' },
        { label: 'skip', value: '', skip: true }
      ] },

    { dim: 'goals',
      pre: 'and the thing that actually matters right now —',
      ask: 'if this month ends well — what got finished? name the one thing.',
      chips: [{ label: 'skip', value: '', skip: true }] },

    { dim: 'pain',
      pre: 'now the one that tells me the most about where i can help —',
      ask: 'what did you catch yourself complaining about this week — not the big stuff, the dumb recurring thing?',
      chips: [
        { label: 'Repetitive busywork', value: 'Loses time to repetitive busywork they wish were automated.' },
        { label: 'Context-switching', value: 'Loses time to constant context-switching between tools.' },
        { label: 'Wrangling data by hand', value: 'Loses time wrangling, cleaning, or moving data by hand.' },
        { label: 'skip', value: '', skip: true }
      ] },

    { dim: 'ambition',
      pre: 'and the other direction —',
      ask: 'say i work for you for a year, free and tireless — what exists at the end that doesn’t right now?',
      chips: [
        { label: 'A project on the back burner', value: 'Has a project they keep meaning to start but never find time for.' },
        { label: 'Something to automate', value: 'Keeps meaning to automate a recurring task but never gets to it.' },
        { label: 'A skill to pick up', value: 'Keeps meaning to learn or build a new skill but never finds the time.' },
        { label: 'skip', value: '', skip: true }
      ] },

    { dim: 'style',
      pre: 'how you want me to carry myself when i work for you —',
      ask: 'when work lands on your desk — do you want the one-liner or the walkthrough? and should i ask first, or run and report back?',
      chips: [
        { label: 'Terse & fast', value: 'Prefers terse, fast, high-signal replies.' },
        { label: 'Thorough', value: 'Prefers thorough, detailed work.' },
        { label: 'Ask first', value: 'Wants to be asked before any significant or irreversible action.' },
        { label: 'Run with it', value: 'Prefers the agent acts autonomously, then reports back.' },
        { label: 'skip', value: '', skip: true }
      ] },

    { dim: 'people',
      pre: 'work is always FOR someone —',
      ask: 'who’s waiting on something from you this week?',
      chips: [
        { label: 'Just me', value: 'Works solo; the deliverables are for themselves.' },
        { label: 'A team', value: 'Works with a team; deliverables are often shared with teammates.' },
        { label: 'Clients', value: 'Builds for clients; deliverables are client-facing.' },
        { label: 'An audience', value: 'Builds for a public audience (content, community, customers).' },
        { label: 'skip', value: '', skip: true }
      ] },

    { dim: 'schedule',
      pre: 'so i can time things right — schedules, night work, when to have things ready —',
      ask: 'when do you actually work — and when should finished work be waiting for you?',
      chips: [
        { label: 'Early bird', value: 'Works mostly mornings; wants overnight work ready by early morning.' },
        { label: 'Night owl', value: 'Works mostly evenings and nights.' },
        { label: 'Always on', value: 'Works at all hours; no fixed schedule.' },
        { label: 'skip', value: '', skip: true }
      ] },

    { dim: 'standing_orders',
      pre: 'last one — the lines i hold to no matter what.',
      ask: 'what’s the rule you catch yourself repeating to anyone who works with you?',
      chips: [
        { label: 'Cite sources', value: '- Always cite your sources.' },
        { label: 'Ask before risky moves', value: '- Never take an irreversible action without asking first.' },
        { label: 'Keep it brief', value: '- Keep replies brief and to the point.' },
        { label: 'skip', value: '', skip: true }
      ] }
  ];

  // the ordered questions to ask: every question whose dimension is not in `skip`, capped at `max`.
  // The controller passes skip = the dossier's already-known dimensions, so a routine interview asks only
  // what the station doesn't know yet (and stays short); pass skip:[] to re-ask everything (refine mode).
  function plan(opts) {
    opts = opts || {};
    const skip = new Set(Array.isArray(opts.skip) ? opts.skip : []);
    const max = Number.isFinite(opts.max) ? opts.max : QUESTIONS.length;
    const out = [];
    for (const q of QUESTIONS) {
      if (skip.has(q.dim)) continue;
      out.push(q);
      if (out.length >= max) break;
    }
    return out;
  }

  // turn an answer into a durable dossier belief, or null for a blank/skip (never store an empty belief).
  // source:'interview' is the provenance the dossier panel shows ("from the intake interview").
  // V3 §5 (interim until the S4 scene-register bank rewrite): an answer that IS a canned chip string is
  // mechanically-produced text, not the Commander's words — it lands with weight 'seed' (informs the prompt,
  // never opens the readiness gate). A typed answer is theirs: weight 'stated'.
  function beliefFromAnswer(question, text) {
    if (!question) return null;
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const canned = Array.isArray(question.chips) && question.chips.some(c => c && c.value && String(c.value) === t);
    return { dim: question.dim, text: t, source: 'interview', weight: canned ? 'seed' : 'stated' };
  }

  // the single question for a dimension — used by the just-in-time curiosity nudge (Phase B slice 2) to ask
  // about ONE blank dimension without running the whole interview.
  function questionFor(dim) { return QUESTIONS.find(q => q.dim === dim) || null; }

  return { QUESTIONS, plan, beliefFromAnswer, questionFor };
});
