/* STARNET — recipe-catalog/general.js : GENERAL recipes — the cross-cutting ones that fit any domain.

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light module
   pattern as its siblings: a `RecipeCatalogGeneral` global in the browser, module.exports under node.
   NO logic here — pure data.

   ══ WHY THIS MODULE EXISTS ══
   GENERAL is the rail's fallback bucket, and it held exactly ONE recipe (core.js `summarize`) while its
   neighbours held thirteen — a chip reading "GENERAL 1" beside "MONEY 13" reads as broken, and it is the
   bucket a Commander reaches for precisely when they cannot name their own use case, which is the whole
   audience this catalog is for. So it needs a real shelf, not a placeholder.

   The bar for shipping HERE is narrower than the general recipe bar: a recipe belongs in this module only
   if it is genuinely domain-free — the same tap is useful to a developer, a freelancer and someone sorting
   out their kitchen. Anything that reads more naturally under one of the twelve buckets belongs there
   instead, because a recipe filed under GENERAL is a recipe nobody browsing for their own situation finds.

   Content contract: every record clears THE RECIPE BAR documented in core.js (earns its tap / drives the
   station / lands somewhere / compounds when recurring), in the same imperative harness voice.

   Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogGeneral = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'compare-options', name: 'Compare Options', emoji: '◫', tagline: 'Decide it, stop circling it',
      accent: '#d9a85a',
      blurb: 'Turns an endless comparison into a decision — on the criteria that actually matter to you.',
      tags: { general: 1 },
      intake: [
        { dimension: 'deliverable', question: 'How should this land?', options: ['one recommendation', 'a ranked comparison'], recommended: 'one recommendation', reason: 'a comparison table is where a decision goes to die' }
      ],
      params: [
        { key: 'options', label: 'The options', placeholder: 'what you are choosing between' },
        { key: 'matters', label: 'What matters to you', placeholder: 'your real criteria and constraints', required: false, default: 'work out the criteria that actually apply and say what you assumed' }
      ],
      task: 'Help me choose between {options}, weighing {matters}. Start by naming the criteria that actually decide this and RANK them, because most stuck decisions are stuck from treating a tie-breaker as though it were a deal-breaker. Say which criteria I appear to be over-weighting. Then compare only on what matters: for each option, what it is genuinely best at, the specific way it disappoints people who chose it, and the cost including the parts that show up later. Kill the weak options in one line each so I know they were considered rather than missed. Then land on ONE recommendation — not a table for me to agonize over — and state exactly what would have to be true for a different answer, so I can check that condition rather than re-running the whole comparison. Flag whether this is reversible: a cheap, undoable choice deserves a fast decision and I should be told to stop deliberating. If the honest answer is that the options are close enough that the choice does not matter, say that plainly and tell me to pick one and move on.',
      category: 'general', gear: ['dish'], skills: ['decision-1-3-1'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'read-this', name: 'Read This For Me', emoji: '▨', tagline: 'What it says, and what it means for you',
      accent: '#6fa8bf',
      blurb: 'Reads the thing you are avoiding and tells you what it actually means for you specifically.',
      tags: { general: 1 },
      params: [
        { key: 'document', label: 'The document', type: 'file', placeholder: 'the letter / policy / notice / agreement' },
        { key: 'concern', label: 'What you want to know', placeholder: 'what you are worried about, if anything', required: false, default: 'whatever in it most affects me' }
      ],
      task: 'Read {document} and tell me what it means for me, particularly regarding {concern}. Lead with the answer to the question I am actually asking, in one paragraph of ordinary language — no preamble about what kind of document this is. Then the three things in here that affect me most, each with what it means in practice rather than a restatement of the wording. Then anything with a DEADLINE or requiring me to do something, at the top of its own short list, because that is the part that costs money to miss. Point me at the specific sections worth reading in full myself and say why. Flag anything ambiguous, anything that seems to contradict something else in the document, and anything that looks unusual for a document of this kind. Quote the exact wording behind every point so I can check you rather than take your word for it. If this is serious enough to warrant a professional — legal, medical, financial — say so plainly and say what to ask them. Do not reply to it or act on it.',
      category: 'general', gear: ['cabinet'], skills: ['pdf-document-extraction'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'find-the-catch', name: 'Find the Catch', emoji: '⚠', tagline: 'What they are not putting in the headline',
      accent: '#cf8a7d',
      blurb: 'Reads an offer adversarially — the real cost, the exit, and the part designed not to be noticed.',
      tags: { general: 0.7, research: 0.3 },
      params: [{ key: 'offer', label: 'The offer', placeholder: 'paste the deal / terms / pitch — or the link' }],
      task: 'Read {offer} adversarially and find the catch. Assume it was written by someone competent whose interests differ from mine, and that anything genuinely good is in the headline while everything else is placed where it will not be read. Work out the REAL total cost over a realistic period, not the monthly figure or the introductory rate — including what happens when the introductory period ends, which is usually the entire product. Then: how I get out and what that costs, what renews automatically and with how much notice, what is excluded from the thing that sounds comprehensive, what they can change unilaterally, and what I am giving up that is not money (my data, an exclusivity, a right to complain). Compare the headline claim against what the terms actually bind them to — the gap between those two is the catch. Check whether the comparison they invite me to make is the right one. Be fair: if it is genuinely a good deal, say so, because a warning about everything is a warning about nothing. End with the two questions to put to them in writing before I agree.',
      category: 'general', gear: ['dish', 'cabinet'], skills: ['adversarial-review-pass'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'second-opinion', name: 'Second Opinion', emoji: '⊗', tagline: 'Try to talk me out of it',
      accent: '#b790c0',
      blurb: 'Attacks a decision you have already made — so the flaw surfaces now rather than afterwards.',
      tags: { general: 1 },
      params: [
        { key: 'decision', label: 'What you have decided', placeholder: 'the decision and your reasoning' },
        { key: 'stakes', label: 'What is at stake', placeholder: 'what it costs if this is wrong', required: false, default: 'whatever the decision itself implies' }
      ],
      task: 'Try to talk me out of {decision}, given {stakes}. Your job is to be the person who disagrees with me competently, not to reassure me — I have already convinced myself, so agreement is worth nothing here. Attack it properly: what am I assuming that I have not checked, what evidence am I treating as stronger than it is, and what would someone who has done this before and regretted it say to me. Look for the specific failure modes of a decision made in this shape — deciding under time pressure, deciding to end an uncomfortable uncertainty, deciding because of what I have already spent, or deciding because the alternative requires an awkward conversation. Name which of those, if any, is actually operating here. Then tell me the strongest version of the opposite choice, made in good faith. Say what I would see in a month if this turns out to be wrong, and what the cheapest test is that would tell me sooner. At the end, give me your honest verdict — including that it is probably right, if it is. A contrarian who always objects is as useless as an agreeable one.',
      category: 'general', gear: ['notebook'], skills: ['adversarial-review-pass'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'first-step', name: 'Where Do I Start?', emoji: '◐', tagline: 'The thing to do in the next hour',
      accent: '#7bc88a',
      blurb: 'Cuts something overwhelming down to one action you can take today — and names what is really blocking you.',
      tags: { general: 1 },
      params: [{ key: 'thing', label: 'What you are stuck on', placeholder: 'the thing you keep not starting' }],
      task: 'I keep not starting {thing}. Work out what is actually blocking me before offering a plan, because the block is rarely the size of the task. Ask me what I need to know, then say which of these it is: I do not know what the first action IS, I am waiting on a decision I have not made, it is genuinely unpleasant, I am missing something from someone else, or the real problem is that I do not actually want to do this. Each of those needs a completely different answer and the common failure is handing me a schedule when the block was a decision. Then give me the FIRST action — small enough to finish in under an hour, concrete enough that I could start now without deciding anything else, and chosen because it unblocks the most or reveals whether my plan is wrong. Not "make a plan": something real. Then the next two after it, and nothing more, since a full plan is another way of not starting. If the honest answer is that I should drop this, or that it is genuinely blocked and the only useful move is chasing someone, say that. Save what I committed to and ask me later whether I did it.',
      category: 'general', gear: ['notebook'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'troubleshoot', name: 'Troubleshoot It', emoji: '⌘', tagline: 'Narrow it down instead of guessing',
      accent: '#88b6c4',
      blurb: 'Diagnoses a misbehaving thing systematically — cheapest, most-likely tests first, never a scattergun.',
      tags: { general: 1 },
      params: [
        { key: 'problem', label: 'What is going wrong', placeholder: 'what it does, what it should do' },
        { key: 'tried', label: 'What you have tried', placeholder: 'anything already ruled out', required: false, default: 'nothing yet — assume I have tried the obvious' }
      ],
      task: 'Help me diagnose {problem}. I have already tried {tried}. Do not hand me a list of things to try — that is guessing with extra steps and it is how people replace a working part. Work it as a diagnosis: first ask me the two or three questions whose answers most narrow the possibilities, especially when it started, what changed around then, and whether it fails always or only in particular conditions. Then give me the likely causes RANKED by probability times how cheap they are to rule out, and for each the specific TEST that distinguishes it from the others — a test that would come out differently depending on the cause, not an action that might happen to fix it. Go one at a time and tell me what each result means, including what it rules OUT. Flag anything where a wrong move makes things worse or is unsafe, and say plainly where the line is that I should stop and get someone qualified. If it comes down to two causes that cannot be separated without a part or a professional, say so rather than sending me on a guess.',
      category: 'general', gear: ['dish', 'notebook'], skills: ['systematic-debugging'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'who-to-hire', name: 'Who To Hire', emoji: '◩', tagline: 'The right professional, and how to vet them',
      accent: '#6fbcc0',
      blurb: 'Works out what kind of professional you actually need — and the questions that separate good from plausible.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'need', label: 'What you need done', placeholder: 'the job / problem you want handled' },
        { key: 'where', label: 'Where you are', placeholder: 'so the advice is local', required: false, default: 'unstated — keep the advice general and say so' }
      ],
      task: 'Work out who I should hire for {need} in {where}. Start with the trade or profession that ACTUALLY handles this, because hiring the adjacent one is a common and expensive mistake, and say whether this needs a specialist or a generalist. Explain how people in this field normally charge — hourly, fixed, retainer, commission — and which structure puts their interests on my side for a job like mine. Then how to find candidates who are not simply the best at advertising, including any licence, registration or insurance that genuinely matters here and how to verify it rather than take their word. Give me the questions that separate someone good from someone plausible: the ones a competent professional answers easily and a weak one deflects. Tell me what a reasonable quote looks like and what an unreasonably LOW one usually means. Name the warning signs — pressure to decide, payment up front in full, no written scope, reluctance to put something in writing. Finish with what to get in writing before any work starts. Do not contact anyone.',
      category: 'general', gear: ['dish'], skills: ['web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'checklist-build', name: 'Build a Checklist', emoji: '⊡', tagline: 'So it goes right every time',
      accent: '#9fc0c4',
      blurb: 'Turns something you do repeatedly into a checklist built around the steps that actually get missed.',
      tags: { general: 1 },
      params: [
        { key: 'process', label: 'The thing you do', placeholder: 'what you want to get right every time' },
        { key: 'failures', label: 'What has gone wrong before', placeholder: 'the mistakes you have actually made', required: false, default: 'work out the likely failure points yourself' }
      ],
      task: 'Build me a checklist for {process}, informed by {failures}. Build it around what actually gets MISSED, not around what happens first — a checklist that lists every step in order is a description, and people stop reading descriptions by the third use. So: the steps that are easy to skip because nothing immediately breaks, the ones done rarely enough to be forgotten, the ones where a mistake is expensive or hard to undo, and anything depending on someone else. Keep it short enough to be used under time pressure; a fifty-item list gets ticked without being read, which is worse than no list. Write each item as a verifiable state rather than an instruction — something I can look at and confirm, not something I can believe I did. Mark the two or three items where a mistake is genuinely costly. Split it by moment (before, during, after) if the timing matters. Add what to do when an item fails, since that is where a checklist earns its keep. Offer it as a file, and tell me what you deliberately left OUT to keep it usable.',
      category: 'general', gear: ['notebook'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'what-changed', name: 'What Changed?', emoji: '◒', tagline: 'A standing watch on anything you name',
      accent: '#6fa8bf',
      blurb: 'Watches whatever you point it at and reports only the genuine deltas, measured against its own records.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'subject', label: 'What to watch', placeholder: 'a page, a policy, a price, a situation — anything with a state' },
        { key: 'care', label: 'What you care about', placeholder: 'what would actually matter to you', required: false, default: 'any change that would change what I should do' }
      ],
      task: 'Keep watch on {subject} and tell me when {care}. On this run, establish or update the record: check the current state, compare it against what you recorded last time, and store what you found with the date. Report ONLY genuine changes measured against your own records — not against your impression, and never a re-description of the current state dressed as an update, because a watch that reports every run trains me to ignore it and then it is worth nothing. For each real change: what it was before, what it is now, when it appears to have happened, and — the part that matters — whether it changes anything I should DO. Separate substantive changes from cosmetic ones, and say when something merely LOOKS different because it was reworded or reorganized. If nothing meaningful moved, say exactly that in one line and stop. If you could not check properly this time, say that rather than reporting no change, because those two are completely different and confusing them is how a watch quietly fails.',
      category: 'general', gear: ['dish', 'notebook'], skills: ['feed-watch'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
