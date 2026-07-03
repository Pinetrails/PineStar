/* STARNET — recipe-catalog/core.js : THE CORE RECIPE CATALOG — the 10 foundational use cases.

   This is DATA, not logic. recipes.js consumes the aggregate (recipe-catalog/index.js) and owns all the
   normalization / freezing / launch primitives. Splitting the catalog out of recipes.js means content scales
   (R4: ~50 use cases across personas) without ever touching the launch logic — a persona file (dev.js /
   research.js / creator.js / ops.js) is a sibling of this one, registered in index.js with a one-line add.

   Schema v2 (each record; recipes.js fills sensible defaults for anything omitted):
     id, name, emoji, tagline, blurb, accent   — identity + card language
     tags: { code|research|general -> weight }  — interest-lane weights the recommender ranks by
     params: [{ key, label, placeholder, required, default }]   — the launch form
     task: '<directive template with {tokens}>' — the imperative directive the agent runs
     gear: [objectType]        — station objects this use case DRAWS ON (advisory only; same vocab as skills
                                 `requires`: dish/cabinet/notebook/workbench/studio/computer/connector). NEVER gates.
     skills: [slug]            — optional bundled-skill references ("pairs with feed-watch")
     cadence: 'morning'|'weekly'|'sixhourly'|'hourly'|null   — a SUGGESTED cadence for naturally-recurring use
                                 cases (null = one-shot by nature). The MAKE-ROUTINE picker defaults to this.
     category: string          — a browse bucket ('research'|'code'|'writing'|'planning'|'general')

   UMD-light: a `RecipeCatalogCore` global in the browser; module.exports (the raw array) under node. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogCore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Every `task` is written as an imperative DIRECTIVE (so Classify.isTaskDirective fires and the agent DOES the
     work instead of just chatting), in the harness voice, leading with the bottom-line ask. {tokens} are
     substituted from the param form at launch. `gear` names the capabilities the use case naturally leans on
     (a research brief wants the WEB → dish; a code review wants FILES → cabinet). It is ADVISORY: a WANT badge +
     quest hook, never a lock. `cadence` is a SUGGESTION — only set on use cases that read as naturally recurring. */
  return [
    {
      id: 'morning-brief', name: 'Morning Brief', emoji: '☀', tagline: 'Daily what-changed digest', accent: '#6fa8bf',
      blurb: 'A tight standup on what moved in your space overnight — answer first, sources under it.',
      tags: { research: 1 }, gear: ['dish'], cadence: 'morning', category: 'research',
      params: [
        { key: 'topic', label: 'Topic', placeholder: 'e.g. AI agent tooling' },
        { key: 'window', label: 'Look-back', placeholder: 'the last 24 hours', required: false, default: 'the last 24 hours' }
      ],
      task: 'Brief me on {topic}: what meaningfully changed in {window}. Lead with the bottom line, then the supporting detail with sources. Skip anything stale or trivial — signal only.'
    },
    {
      id: 'deep-research', name: 'Deep-Dive Research', emoji: '◎', tagline: 'Sourced brief on a question', accent: '#6fa8bf',
      blurb: 'Digs the live web, cross-checks across independent sources, and briefs it tightly.',
      tags: { research: 1 }, gear: ['dish'], cadence: null, category: 'research',
      params: [{ key: 'topic', label: 'Question / topic', placeholder: 'e.g. is X worth adopting?' }],
      task: 'Research {topic} in depth. Cross-check across at least two independent sources, then give me a sourced brief: lead with the answer, then the evidence, and flag what is uncertain or contested.'
    },
    {
      id: 'fact-check', name: 'Fact-Check', emoji: '⊜', tagline: 'Verify a claim, with sources', accent: '#88b6c4',
      blurb: 'Takes one claim, checks it against the record, and tells you true / false / it-depends.',
      tags: { research: 0.8, general: 0.2 }, gear: ['dish'], cadence: null, category: 'research',
      params: [{ key: 'claim', label: 'The claim', placeholder: 'paste the statement to verify' }],
      task: 'Fact-check this claim and cite your sources: "{claim}". Verdict first (true / false / misleading / unverifiable), then the evidence. Never present an unsourced claim as fact.'
    },
    {
      id: 'fix-bug', name: 'Fix a Bug', emoji: '⌗', tagline: 'Diagnose & patch a defect', accent: '#7bc88a',
      blurb: 'Reads the surrounding code first, makes a focused fix, and verifies it actually works.',
      tags: { code: 1 }, gear: ['cabinet', 'workbench'], cadence: null, category: 'code',
      params: [{ key: 'error', label: 'Error / symptom', placeholder: 'paste the error or describe the bug' }],
      task: 'Fix this bug: {error}. Read the surrounding code before changing it, make the smallest focused edit that fixes it, then verify the fix works and report what changed and why.'
    },
    {
      id: 'code-review', name: 'Code Review', emoji: '⊗', tagline: 'Adversarial review pass', accent: '#cf8a7d',
      blurb: 'Stress-tests a change before it ships — bugs, edge cases, weak spots, ranked with fixes.',
      tags: { code: 0.8, general: 0.2 }, gear: ['cabinet'], cadence: null, category: 'code',
      params: [{ key: 'target', label: 'What to review', placeholder: 'a file, a diff, or a plan' }],
      task: 'Review {target} adversarially — actively try to break it. Hunt for bugs, edge cases, and weak spots; rank findings by severity and give a concrete fix for each. Separate real defects from nitpicks.'
    },
    {
      id: 'ship-feature', name: 'Build a Feature', emoji: '⊞', tagline: 'Add something, end to end', accent: '#7bc88a',
      blurb: 'Adds a focused feature in the codebase’s own style and verifies it before calling it done.',
      tags: { code: 1 }, gear: ['cabinet', 'workbench'], cadence: null, category: 'code',
      params: [
        { key: 'feature', label: 'Feature', placeholder: 'what to build' },
        { key: 'where', label: 'Where', placeholder: 'file / module / area', required: false, default: 'the right place in the codebase' }
      ],
      task: 'Add {feature} to {where}. Read the surrounding code first and match its style, keep the diff focused on exactly what the feature needs, then verify it works and summarize what changed.'
    },
    {
      id: 'draft-reply', name: 'Draft a Reply', emoji: '✉', tagline: 'Answer a message in your voice', accent: '#6fbcc0',
      blurb: 'Reads an incoming message and drafts a reply in the tone you pick — ready to send or tweak.',
      tags: { general: 1 }, gear: [], cadence: null, category: 'writing',
      params: [
        { key: 'message', label: 'The message', placeholder: 'paste what you’re replying to' },
        { key: 'tone', label: 'Tone', placeholder: 'warm & concise', required: false, default: 'warm and concise' }
      ],
      task: 'Draft a reply to this message in a {tone} tone:\n\n{message}\n\nGive me one clean draft first. Do not send anything — just draft it for my review.'
    },
    {
      id: 'tighten-writing', name: 'Tighten This', emoji: '✎', tagline: 'Cut filler, keep the meaning', accent: '#b790c0',
      blurb: 'Edits a passage down — sharper, clearer, no fluff — without changing what it says.',
      tags: { general: 1 }, gear: [], cadence: null, category: 'writing',
      params: [{ key: 'text', label: 'The text', placeholder: 'paste the passage to tighten' }],
      task: 'Tighten this writing — cut the filler, favor clear concrete language, and make it land — while preserving the meaning. Flag anything you would change substantively:\n\n{text}'
    },
    {
      id: 'plan-project', name: 'Plan a Project', emoji: '◇', tagline: 'Break a goal into a plan', accent: '#d9a85a',
      blurb: 'Turns a big, fuzzy goal into concrete steps, then flags what needs you.',
      tags: { general: 1 }, gear: [], cadence: null, category: 'planning',
      params: [{ key: 'goal', label: 'The goal', placeholder: 'what you’re trying to accomplish' }],
      task: 'Break {goal} into a concrete, ordered step-by-step plan. Keep steps small and actionable; call out dependencies, risks, and exactly what needs me before we can move.'
    },
    {
      id: 'summarize', name: 'Summarize', emoji: '▤', tagline: 'TL;DR of anything', accent: '#9fc0c4',
      blurb: 'Distills a wall of text down to the bottom line plus the few points that matter.',
      tags: { general: 0.6, research: 0.4 }, gear: [], cadence: null, category: 'general',
      params: [{ key: 'content', label: 'Content', placeholder: 'paste the text / notes / thread' }],
      task: 'Summarize this clearly — lead with the bottom line, then the few points that actually matter:\n\n{content}'
    }
  ];
});
