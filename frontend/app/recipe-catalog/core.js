/* STARNET — recipe-catalog/core.js : THE CORE RECIPE CATALOG — the 10 foundational use cases.

   This is DATA, not logic. recipes.js consumes the aggregate (recipe-catalog/index.js) and owns all the
   normalization / freezing / launch primitives. Splitting the catalog out of recipes.js means content scales
   (R4: ~50 use cases across personas) without ever touching the launch logic — a persona file (dev.js /
   research.js / creator.js / ops.js) is a sibling of this one, registered in index.js with a one-line add.

   ══ THE RECIPE BAR (2026-07 content overhaul — every built-in, core or persona, must clear ALL four) ══
     1. EARNS ITS TAP  — the directive encodes METHOD and JUDGMENT (steps, quality criteria, output shape)
                         the Commander would never bother typing. A one-line paraphrase of the recipe's own
                         name ("summarize this") is worth LESS than the chat box and does not ship.
     2. DRIVES THE STATION — it leans on real gear: the web (dish), files (cabinet), terminal (workbench),
                         memory (notebook), connected channels (connector) — or a cadence. Paste-boxes are a
                         last resort for material genuinely outside the station's reach, and even then the
                         directive accepts a file / link / channel as the source.
     3. LANDS SOMEWHERE — it ends in a deliverable or a decision (a draft, a ranked call, a delta report,
                         an offered file), plus what to do next. Never "here is some text".
     4. COMPOUNDS      — a naturally-recurring recipe (cadence != null) keeps notes in the agent's memory
                         and reports what CHANGED since the last run, so the Nth run beats the first.
   The scout's auto-mint directive (sidecar/scout.js buildRecipeDirective) enforces the same bar, so
   personalized recipes the station drafts for its Commander never regress below the curated catalog.

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
     quest hook, never a lock. `cadence` is a SUGGESTION — only set on use cases that read as naturally recurring.
     TAG HONESTY: a recipe's tags must include the lane Classify.getTag assigns its filled directive (locked by
     test/recipes.test.js) — keep the lane vocabulary in mind when editing task text. */
  return [
    {
      id: 'morning-brief', name: 'Morning Brief', emoji: '☀', tagline: 'Daily what-changed digest', accent: '#6fa8bf',
      blurb: 'A standing morning sweep that remembers yesterday — so it only ever tells you what is actually new.',
      tags: { research: 1 }, gear: ['dish', 'notebook'], cadence: 'morning', category: 'research',
      params: [
        { key: 'topic', label: 'Topic', placeholder: 'e.g. AI agent tooling' },
        { key: 'window', label: 'Look-back', required: false, type: 'choice', default: 'the last 24 hours',
          options: ['the last 24 hours', 'the last 3 days', 'the last week', 'since your previous brief'] }
      ],
      task: 'Brief me on {topic}: sweep the live web for what meaningfully changed in {window}, cross-check anything surprising before repeating it, and compare against your notes from the previous brief so you only report what is genuinely NEW. Lead with the bottom line, then the supporting detail with sources, then one line on what I should do about it, if anything. Save the key findings to your memory for tomorrow\'s comparison. If nothing material moved, say so in two sentences and stop — a quiet day is a valid report.'
    },
    {
      id: 'deep-research', name: 'Deep-Dive Research', emoji: '◎', tagline: 'Sourced brief on a question', accent: '#6fa8bf',
      blurb: 'Three-pass research — map the landscape, dig the evidence, attack its own conclusion — briefed tight.',
      tags: { research: 1 }, gear: ['dish', 'cabinet'], cadence: null, category: 'research',
      params: [{ key: 'topic', label: 'Question / topic', placeholder: 'e.g. is X worth adopting?' }],
      // TASK BRIEF v2 intake: this task type's material decisions, settled by one tap at launch
      // (dimension must be one of taskbrief-policy's; the launch form renders these as suggested-default chips).
      intake: [
        { dimension: 'deliverable', question: 'How should the findings land?', options: ['tight brief', 'full report with citations', 'bullet digest'], recommended: 'tight brief', reason: 'the shape of the write-up changes the whole final pass' },
        { dimension: 'sources', question: 'What counts as a source?', options: ['broad web', 'primary/expert only'], recommended: 'primary/expert only', reason: 'the source bar decides what evidence is admissible' }
      ],
      task: 'Research {topic} in depth, in three passes. First map the landscape: who the credible voices are and where they disagree. Then dig the strongest evidence on each side from at least three independent sources — primary sources over commentary. Finally pressure-test your own conclusion: actively hunt for what would prove it wrong. Deliver a brief that leads with the answer and your confidence in it, then the evidence, the honest counter-case, and what remains unknown. Offer to save the full brief as a file I can keep.'
    },
    {
      id: 'fact-check', name: 'Fact-Check', emoji: '⊜', tagline: 'Verify a claim, with sources', accent: '#88b6c4',
      blurb: 'Traces a claim to its origin, then verifies against sources that don\'t just quote each other.',
      tags: { research: 0.8, general: 0.2 }, gear: ['dish'], cadence: null, category: 'research',
      params: [{ key: 'claim', label: 'The claim', placeholder: 'paste the statement to verify' }],
      task: 'Fact-check this claim: "{claim}". Trace it to its ORIGINAL source first — most false claims die right there — then verify against at least two independent sources that do not cite each other. Verdict first (true / false / misleading / unverifiable), then the chain of evidence, then where the claim came from and how it mutated along the way if it did. Never present an unsourced claim as fact, including your own.'
    },
    {
      id: 'fix-bug', name: 'Fix a Bug', emoji: '⌗', tagline: 'Diagnose & patch a defect', accent: '#7bc88a',
      intake: [
        { dimension: "constraints", question: "How far may the fix go?", options: ["smallest safe patch","refactor if warranted"], recommended: "smallest safe patch", reason: "sets the blast radius of the change" }
      ],
      blurb: 'Reproduces first, fixes the root cause with the smallest change, and proves the fix before reporting.',
      tags: { code: 1 }, gear: ['cabinet', 'workbench'], cadence: null, category: 'code',
      params: [{ key: 'error', label: 'Error / symptom', placeholder: 'paste the error or describe the bug' }],
      task: 'Fix this bug: {error}. Reproduce it FIRST — if you cannot reproduce it, say so and show what you tried instead of patching blind. Then trace the actual cause, not the symptom: read the surrounding code and follow the data to where it goes wrong. Make the smallest fix that kills the root cause. Prove it: run the failing case again, run the nearby tests, and report exactly what changed, why, and anything else the fix could plausibly affect.'
    },
    {
      id: 'code-review', name: 'Code Review', emoji: '⊗', tagline: 'Adversarial review pass', accent: '#cf8a7d',
      intake: [
        { dimension: "scope", question: "How deep should the review go?", options: ["full adversarial pass","quick sanity pass"], recommended: "full adversarial pass", reason: "depth decides how much of the change gets traced" }
      ],
      blurb: 'Tries to break the change before a user does — edge cases, error paths, a verdict you can act on.',
      tags: { code: 0.8, general: 0.2 }, gear: ['cabinet'], cadence: null, category: 'code',
      params: [{ key: 'target', label: 'What to review', type: 'file', placeholder: 'a file — or type a diff / module / plan' }],
      task: 'Review {target} adversarially — your job is to break it before a user does. Read the code and trace the data flow end to end, hunt the edge cases (empty, huge, concurrent, malformed, unauthorized), walk the error paths, and check whether the tests actually cover the risky parts. Rank findings by severity with a concrete fix for each, separate real defects from style nits, and end with a clear verdict: safe to ship, ship after fixes, or do not ship.'
    },
    {
      id: 'ship-feature', name: 'Build a Feature', emoji: '⊞', tagline: 'Add something, end to end', accent: '#7bc88a',
      intake: [
        { dimension: "acceptance", question: "What proves it done?", options: ["verified live like a user","tests green is enough"], recommended: "verified live like a user", reason: "sets the bar before the work is called finished" }
      ],
      blurb: 'Builds the smallest complete version in the codebase\'s own style, wired fully and verified like a user.',
      tags: { code: 1 }, gear: ['cabinet', 'workbench'], cadence: null, category: 'code',
      params: [
        { key: 'feature', label: 'Feature', placeholder: 'what to build' },
        { key: 'where', label: 'Where', type: 'folder', placeholder: 'the project folder — or type a module / area', required: false, default: 'the right place in the codebase' }
      ],
      task: 'Add {feature} to {where}. Before writing anything, read the surrounding code and how the codebase already solves its nearest neighbor, then match that pattern — style, naming, error handling. Build the smallest COMPLETE version: wired end to end, no dead UI, no stubbed endings. Then verify it the way a user would actually hit it, not just that it compiles. Report what changed, how you verified it, and what you deliberately left out for a later pass.'
    },
    {
      id: 'draft-reply', name: 'Draft a Reply', emoji: '✉', tagline: 'Answer a message in your voice', accent: '#6fbcc0',
      blurb: 'Answers the question under the question, in your voice — one clean draft, ready to send or tweak.',
      tags: { general: 1 }, gear: [], cadence: null, category: 'writing',
      params: [
        { key: 'message', label: 'The message', placeholder: 'paste what you’re replying to' },
        { key: 'tone', label: 'Tone', required: false, type: 'choice', default: 'warm and concise',
          options: ['warm and concise', 'friendly', 'formal', 'direct', 'apologetic'] }
      ],
      task: 'Draft a reply to this message in a {tone} tone:\n\n{message}\n\nRead what the sender actually needs — the question under the question — and answer that first. Match how I write, keep it as short as a real answer allows, and never invent facts or commitments I did not give you. Give me one clean ready-to-send draft, then a one-line note on anything in their message you think I might be missing. Do not send anything — the draft is mine to review.'
    },
    {
      id: 'tighten-writing', name: 'Tighten This', emoji: '✎', tagline: 'Cut filler, keep the meaning', accent: '#b790c0',
      intake: [
        { dimension: "constraints", question: "How hard should I cut?", options: ["light trim (keep the voice)","aggressive cut"], recommended: "light trim (keep the voice)", reason: "decides how much of the original survives" }
      ],
      blurb: 'Cuts filler without flattening the voice — and shows you what it cut, so nothing changes silently.',
      tags: { general: 1 }, gear: [], cadence: null, category: 'writing',
      params: [{ key: 'text', label: 'The text', placeholder: 'paste the passage to tighten' }],
      task: 'Tighten this writing without flattening its voice. Cut filler, hedges, and throat-clearing; favor concrete verbs; keep every load-bearing idea. If a sentence must change meaning to get shorter, flag it instead of silently changing it. Return the tightened version first, then a short list of what you cut and why, and the word count before and after so the trim is visible:\n\n{text}'
    },
    {
      id: 'plan-project', name: 'Plan a Project', emoji: '◇', tagline: 'Break a goal into a plan', accent: '#d9a85a',
      intake: [
        { dimension: "deliverable", question: "What shape of plan?", options: ["one-page plan","full roadmap"], recommended: "one-page plan", reason: "a plan you will read beats a thorough one you will not" }
      ],
      blurb: 'Works backwards from done into steps you can start today — risks named, first move included.',
      tags: { general: 1 }, gear: ['notebook'], cadence: null, category: 'planning',
      params: [{ key: 'goal', label: 'The goal', placeholder: 'what you’re trying to accomplish' }],
      task: 'Break {goal} into a concrete plan I can start today. Work backwards from what done looks like, sequence the steps by what unblocks what, and size each honestly (hours vs days). Call out the riskiest assumption and the cheapest way to test it early, everything that needs ME specifically, and the single first step to take this week. Keep it to one page — a plan I will actually read beats a thorough one I will not. Offer to keep the plan in your memory so we can track progress against it.'
    },
    {
      id: 'summarize', name: 'Summarize', emoji: '▤', tagline: 'TL;DR of anything', accent: '#9fc0c4',
      blurb: 'Summarizes like the person who has to act on it — decisions, deadlines, and the buried surprise first.',
      tags: { general: 0.6, research: 0.4 }, gear: ['cabinet'], cadence: null, category: 'general',
      params: [{ key: 'content', label: 'Content', placeholder: 'paste the text — or point me at a file or link' }],
      intake: [
        { dimension: 'deliverable', question: 'What shape of summary?', options: ['two-sentence TL;DR', 'action bullets', 'one-pager'], recommended: 'action bullets', reason: 'length and shape decide what survives the cut' }
      ],
      task: 'Summarize this as the person who has to act on it, not a book reporter — if it is a file path or a link, go read the real thing first. Lead with the bottom line in two sentences, then the few points that actually change decisions, then anything surprising or buried that I would regret missing. Anything with an action or a deadline goes at the top. Point me at the exact spot worth reading in full, if any:\n\n{content}'
    }
  ];
});
