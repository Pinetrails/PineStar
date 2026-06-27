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
  const QUESTIONS = [
    { dim: 'identity',
      pre: 'let me actually get to know my Commander — not just take orders from a silhouette.',
      ask: 'who are you, and what are you building?',
      chips: [{ label: 'skip', value: '', skip: true }] },

    { dim: 'stack',
      pre: 'so i reach for the right tools instead of guessing —',
      ask: 'what languages, frameworks, or tools do you live in?',
      chips: [
        { label: 'TypeScript / JS', value: 'Works mostly in TypeScript / JavaScript.' },
        { label: 'Python', value: 'Works mostly in Python.' },
        { label: 'Rust', value: 'Works mostly in Rust.' },
        { label: 'skip', value: '', skip: true }
      ] },

    { dim: 'goals',
      pre: 'and the thing that actually matters right now —',
      ask: 'what are you trying to get done?',
      chips: [{ label: 'skip', value: '', skip: true }] },

    { dim: 'pain',
      pre: 'now the one that tells me the most about where i can help —',
      ask: 'what did you do this week you wish you never had to do again?',
      chips: [
        { label: 'Repetitive busywork', value: 'Loses time to repetitive busywork they wish were automated.' },
        { label: 'Context-switching', value: 'Loses time to constant context-switching between tools.' },
        { label: 'Wrangling data by hand', value: 'Loses time wrangling, cleaning, or moving data by hand.' },
        { label: 'skip', value: '', skip: true }
      ] },

    { dim: 'style',
      pre: 'how you want me to carry myself when i work for you —',
      ask: 'terse or thorough? ask-first, or run-with-it?',
      chips: [
        { label: 'Terse & fast', value: 'Prefers terse, fast, high-signal replies.' },
        { label: 'Thorough', value: 'Prefers thorough, detailed work.' },
        { label: 'Ask first', value: 'Wants to be asked before any significant or irreversible action.' },
        { label: 'Run with it', value: 'Prefers the agent acts autonomously, then reports back.' },
        { label: 'skip', value: '', skip: true }
      ] },

    { dim: 'standing_orders',
      pre: 'last one — the lines i hold to no matter what.',
      ask: 'any standing rules every agent should always follow?',
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
  function beliefFromAnswer(question, text) {
    if (!question) return null;
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    return { dim: question.dim, text: t, source: 'interview' };
  }

  // the single question for a dimension — used by the just-in-time curiosity nudge (Phase B slice 2) to ask
  // about ONE blank dimension without running the whole interview.
  function questionFor(dim) { return QUESTIONS.find(q => q.dim === dim) || null; }

  return { QUESTIONS, plan, beliefFromAnswer, questionFor };
});
