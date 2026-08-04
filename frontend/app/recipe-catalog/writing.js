/* STARNET — recipe-catalog/writing.js : WRITING persona recipes — drafting, editing, and the hard messages.

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light module
   pattern as its siblings: a `RecipeCatalogWriting` global in the browser, module.exports under node.
   NO logic here — pure data.

   WRITING was a browse bucket holding two core recipes (draft-reply, tighten-writing) folded in under
   CREATOR. It is now its own rail bucket, and this module is the shelf behind it.

   Content contract: every record clears THE RECIPE BAR documented in core.js (earns its tap / drives
   the station / lands somewhere / compounds when recurring), in the same imperative harness voice.

   ══ THE VOICE LINE (this module's extra bar) ══
   The failure mode of an agent that writes is that everything it touches comes out sounding the same —
   competent, fluent, and unmistakably not the Commander. So every editing directive here SHOWS ITS
   CHANGES rather than returning a silently improved text, and every drafting directive is told to
   preserve the Commander's own constructions rather than upgrading them. A rewrite the Commander
   cannot audit is a rewrite that quietly replaces their voice with the model's.

   Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogWriting = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'line-edit', name: 'Line Edit', emoji: '▤', tagline: 'Every change shown, none hidden',
      accent: '#b790c0',
      blurb: 'Edits sentence by sentence with the reason for each change — so nothing alters your voice silently.',
      tags: { general: 1 },
      intake: [
        { dimension: 'constraints', question: 'How heavy an edit?', options: ['light touch', 'thorough rework'], recommended: 'light touch', reason: 'decides how much of my own phrasing survives' }
      ],
      params: [{ key: 'text', label: 'The text', type: 'file', placeholder: 'the draft to edit — a file or paste it' }],
      task: 'Line-edit {text}. Work sentence by sentence and show me each change as before and after with a short reason — a silently improved draft teaches me nothing and quietly replaces my voice with yours, which is the exact failure I am guarding against here. Fix what genuinely weakens the writing: passive constructions hiding who did what, abstract nouns where a verb would carry it, sentences that need a second reading because of their order rather than their content, hedges that drain a claim, and any place the rhythm goes flat across three sentences of the same length. Leave alone the things that are merely unusual — an idiosyncratic construction that works is voice, and editing it out is how writing becomes uniform. Where a sentence is unclear because the underlying THOUGHT is unclear, say so and ask rather than smoothing it into fluent vagueness; that is the most valuable thing an editor does. Group your changes so I can accept a whole category at once. Finish with the two or three habits showing up repeatedly, since fixing a habit is worth more than fixing thirty instances of it.',
      category: 'writing', gear: ['cabinet'], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'proofread', name: 'Proofread', emoji: '⊜', tagline: 'The last pass before it goes out',
      accent: '#88b6c4',
      blurb: 'Catches the errors a spellchecker cannot — and touches nothing else.',
      tags: { general: 1 },
      params: [{ key: 'text', label: 'The text', type: 'file', placeholder: 'the final draft — a file or paste it' }],
      task: 'Proofread {text}. This is a proofread and not an edit: fix errors, change nothing else, and do not improve a single sentence that is merely not how you would have written it — if you find yourself rewriting, you have exceeded the job. Hunt what a spellchecker misses: the correctly-spelled wrong word, agreement that drifted when a sentence was revised, a tense that changes mid-paragraph, inconsistent treatment of the same term or name across the piece, numbers and dates that contradict each other, a list whose items do not share a grammatical form, and punctuation that changes the meaning rather than merely the style. Check the things that embarrass people most because nobody reads them: headings, captions, the first line, and anything in a larger font. Verify every internal cross-mention actually points at what it claims. Give me the errors as a list with the location, what is wrong, and the correction — plus a separate short list of things that are not errors but would be worth a second look before this goes out. State plainly if the piece is not ready for a proofread because it still needs an edit.',
      category: 'writing', gear: ['cabinet'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'argue-well', name: 'Structure an Argument', emoji: '◭', tagline: 'Built to survive the objection',
      accent: '#7bc88a',
      blurb: 'Orders a case so it holds — with the strongest counter-argument answered rather than avoided.',
      tags: { general: 1 },
      params: [
        { key: 'claim', label: 'What you are arguing', placeholder: 'the position you want to make the case for' },
        { key: 'audience', label: 'Who you are convincing', placeholder: 'who reads it and what they currently think', required: false, default: 'a smart reader who is skeptical but fair' }
      ],
      task: 'Structure the argument for {claim} aimed at {audience}. Start by stating the claim precisely enough to be wrong — a claim vague enough that nobody could disagree persuades nobody either. Then find the load-bearing reasons: usually two or three, not a list of eight, since a weak reason beside a strong one drags the strong one down by association. Order them by what my particular reader already accepts, building from agreement rather than from the most exciting point. For each reason, name the evidence that would actually support it and be honest about which parts I currently have and which I am asserting. Then the part that decides whether this survives: take the STRONGEST objection — the one a well-informed opponent would lead with, not the easy one — and answer it directly in the argument itself, because an objection I dodge is the one the reader is thinking about while reading everything else. Say where my position is genuinely weak and what the honest concession is; conceding a real point buys credibility for the rest. Finish with the outline in order, the one sentence that carries the whole thing, and one line on where a fair reader would still disagree.',
      category: 'writing', gear: ['notebook'], skills: ['decision-1-3-1'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'outline-to-draft', name: 'Outline to Draft', emoji: '◫', tagline: 'Your structure, filled in',
      accent: '#6fa8bf',
      blurb: 'Expands your outline into prose without inventing content you did not put there.',
      tags: { general: 1 },
      params: [
        { key: 'outline', label: 'Your outline', type: 'file', placeholder: 'the structure / bullet points to expand' },
        { key: 'length', label: 'Target length', placeholder: 'e.g. 900 words', required: false, default: 'as long as the material genuinely supports and no longer' }
      ],
      task: 'Expand {outline} into a draft of about {length}. Follow MY structure — do not reorganize it into a shape you prefer; if the order is genuinely wrong, say so at the end rather than silently fixing it, because a returned draft I did not recognize is one I have to reverse-engineer. Write each point out as prose that earns its space: the claim, then what makes it true, then the concrete instance. Where a point in the outline is a placeholder I have not actually thought through, do not cover it over with fluent filler — mark it and tell me what it needs, since fluent filler is indistinguishable from content at a glance and that is exactly what makes it dangerous. Never invent a fact, statistic, example or quotation to make a section feel finished; where an example would help, say what KIND of example is needed and ask me for one. Write the transitions so the argument moves rather than merely continuing. Keep sentences varied in length. At the end: what to cut if it runs long, and every place I need to supply something before this is real.',
      category: 'writing', gear: ['cabinet'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'retone', name: 'Change the Register', emoji: '◐', tagline: 'Same meaning, different room',
      accent: '#6fbcc0',
      blurb: 'Shifts formality without flattening the content — and flags what the new register cannot carry.',
      tags: { general: 1 },
      params: [
        { key: 'text', label: 'The text', placeholder: 'paste what you have written' },
        { key: 'target', label: 'New register', required: false, type: 'choice', default: 'plainer and more direct',
          options: ['plainer and more direct', 'more formal', 'warmer and more personal', 'firmer', 'more cautious'] }
      ],
      task: 'Rewrite this to be {target}, keeping the meaning exactly:\n\n{text}\n\nRegister lives in structure and word choice, not in adding or removing pleasantries — making something formal by inserting "kindly" is a costume, not a change of register. Move it properly: sentence length and complexity, how directly the ask is made, how much distance the writing puts between the writer and the claim, and how much is left implied versus spelled out. Keep every substantive point, and preserve any precision that matters — a firmer version that softens a commitment or a warmer version that blurs a deadline has failed. Then the useful warning: tell me what the new register CANNOT carry well. A plainer version cannot hedge, so it will pin me to things the original left comfortably vague, and that is the specific way this goes wrong. Show me the two or three sentences whose meaning shifted most, with the original beside them, so I can check I actually meant the new one.',
      category: 'writing', gear: [], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'doc-clarify', name: 'Make This Clear', emoji: '⊙', tagline: 'A document someone can act on',
      accent: '#9fc0c4',
      blurb: 'Restructures a document around what the reader has to DO — and names what it never answered.',
      tags: { general: 1 },
      params: [
        { key: 'document', label: 'The document', type: 'file', placeholder: 'the doc that is not landing' },
        { key: 'reader', label: 'Who has to use it', placeholder: 'who reads it and what they need from it', required: false, default: 'someone who has to act on it and has little time' }
      ],
      task: 'Rework {document} so {reader} can actually use it. First tell me what the document is really FOR — a reader needs to do something after reading it, and a document that does not know what that is will never be clear no matter how well it is written. Then restructure around that: the thing they must know first goes first, the action goes where it cannot be missed, and everything that exists to show the author did their homework moves to the end or goes. Cut the throat-clearing opening. Replace abstractions with the specific thing meant — "stakeholders" and "the process" are usually hiding a name and a step nobody has decided on, and naming them is where a document becomes useful. Make every requirement testable: who does what by when. Then the most valuable part: list the QUESTIONS this document raises and does not answer, since a reader hits those and stops. Flag anything that reads as decided but is not, because that is how a document creates a disagreement later. Show me the restructured version plus a short note on what you moved and why.',
      category: 'writing', gear: ['cabinet'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'hard-message', name: 'The Difficult Message', emoji: '⚠', tagline: 'Say the hard thing, keep the relationship',
      accent: '#cf8a7d',
      blurb: 'Drafts the message you are dreading — clear about the substance, careful about the person.',
      tags: { general: 1 },
      params: [
        { key: 'situation', label: 'The situation', placeholder: 'what happened and what you need to say' },
        { key: 'relationship', label: 'Who they are to you', placeholder: 'e.g. a client I want to keep, my manager', required: false, default: 'someone whose relationship with me matters beyond this exchange' }
      ],
      task: 'Draft the message for {situation}, to {relationship}. Work out first what I actually need: an apology, a boundary, a correction, a refusal, or something unwelcome delivered — these need different messages, and most difficult messages fail by trying to be several at once. Then write it with the substance UNMISTAKABLE. The instinct in a hard message is to soften until the point is deniable, and the reader then either misses it or has to ask, which is worse for both of us. Lead with the point rather than burying it after two paragraphs of context. Where I am at fault, say so plainly once, without the over-apologizing that makes the reader manage my feelings instead of hearing me. Where I am setting a boundary, state it as a decision rather than a request for permission, and do not justify it three times — one reason is confident, three sound like negotiation. Keep it short; length reads as anxiety. Strip anything score-settling, however satisfying. Then two notes: what they will most likely say back and how to handle it, and whether this actually warrants a conversation instead of a message. Draft only — I decide whether to send it.',
      category: 'writing', gear: ['notebook'], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'talk-write', name: 'Write a Talk', emoji: '◔', tagline: 'For the ear, not the page',
      accent: '#d9a85a',
      blurb: 'Writes something meant to be heard — timed, spoken-shaped, and built around one idea.',
      tags: { general: 1 },
      params: [
        { key: 'talk', label: 'The talk', placeholder: 'the topic, the audience, and how long' },
        { key: 'takeaway', label: 'The one thing they remember', placeholder: 'what should survive a week', required: false, default: 'whatever the single strongest idea turns out to be' }
      ],
      task: 'Write {talk}, built around {takeaway}. Write it for the EAR: short sentences, one idea per sentence, no clause a listener has to hold open while another finishes — a listener cannot re-read, and the single biggest failure in a talk is prose that was written for a page. Signpost aggressively, because listeners get lost silently and never recover. Open with something concrete — a moment, a number, a question — never with an outline of what you are about to say. Build to ONE idea; a talk that makes three points makes none, and the discipline of choosing is most of the work. Repeat the central line deliberately in different words at intervals; repetition that reads as heavy on the page lands as clarity out loud. Give me the timing honestly at speaking pace — roughly 130 words a minute, less with pauses — and mark where to pause and where to slow down. Mark what to cut if I am running long, decided in advance rather than in the moment. Then: the two questions I will be asked and how to answer, plus a note on what belongs on a slide versus in my mouth.',
      category: 'writing', gear: ['notebook'], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'story-develop', name: 'Develop a Story', emoji: '◖', tagline: 'Find where it is actually broken',
      accent: '#b790c0',
      blurb: 'Diagnoses a stalled story at the structural level — not line notes on a scene that should not exist.',
      tags: { general: 1 },
      params: [
        { key: 'story', label: 'The story', type: 'file', placeholder: 'the draft / synopsis / the part you are stuck on' },
        { key: 'stuck', label: 'Where you are stuck', placeholder: 'what is not working, if you know', required: false, default: 'work out for yourself where it is actually going wrong' }
      ],
      task: 'Read {story} and diagnose it, focusing on {stuck}. Work at the structural level first — line notes on a scene that should not exist are wasted, and most stalls are structural even when they feel like a prose problem. Check the things that actually stop a story moving: whether the protagonist WANTS something concretely enough to act, whether anything genuinely opposes it, whether the middle has a shape or is a sequence of events that could be reordered without loss, and whether decisions are being made by the character or by circumstances happening to them. Say where a reader would put it down and why, precisely. Where a scene is not earning its place, name what it is doing that another scene already does. Be honest about the strongest thing in here and protect it — a diagnosis that only lists problems produces a rewrite that loses what was working. Then two or three concrete structural moves, each with what it would cost, so I can choose. Do not rewrite my prose or supply plot; ask the question that makes ME find the answer. Finish with the ONE change that would unlock the most.',
      category: 'writing', gear: ['cabinet'], skills: ['creative-ideation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'translate-localize', name: 'Translate & Localize', emoji: '⌯', tagline: 'Reads native, flags what will not travel',
      accent: '#6fbcc0',
      blurb: 'Translates for meaning, then names every place the original assumed a culture the reader does not share.',
      tags: { general: 1 },
      params: [
        { key: 'text', label: 'The text', placeholder: 'paste what to translate — or point me at the file' },
        { key: 'target', label: 'Into', placeholder: 'the language and region, e.g. Brazilian Portuguese' }
      ],
      task: 'Translate this into {target}:\n\n{text}\n\nTranslate for MEANING and effect rather than word by word — the test is whether a native reader would take it for something written in their language, and a literal translation fails that test while looking correct. Preserve the register, the level of formality between the parties (which several languages encode explicitly and English does not, so it is a decision you must make deliberately rather than by default), and any deliberate rhetorical effect. Then the part that matters more than the translation itself: list everything that does not travel — an idiom with no equivalent, humour that depends on the original language, a cultural touchstone the reader will not have, a date or number format that means something different there, a legal or commercial term with no real counterpart, and anything that is merely neutral at home and carries a charge there. For each, give the option you chose and the alternative, so I can decide. Flag any name, unit or measure that needs converting rather than translating. Where the original wording is itself ambiguous, say so instead of resolving it silently.',
      category: 'writing', gear: [], skills: ['translation-pass'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'bio-write', name: 'Write Your Bio', emoji: '◨', tagline: 'Three lengths, all sounding like you',
      accent: '#7bc88a',
      blurb: 'Writes the bio you keep putting off — specific, unembarrassing, and in three reusable lengths.',
      tags: { general: 1 },
      params: [
        { key: 'about', label: 'About you', type: 'file', placeholder: 'your CV — or a few lines about what you do' },
        { key: 'context', label: 'What it is for', placeholder: 'e.g. a conference profile, a website, a book jacket', required: false, default: 'general professional use' }
      ],
      task: 'Write my bio from {about} for {context}. Give me three lengths that all sound like the same person: one line, about fifty words, and about a hundred and fifty. Lead with what I actually DO in language a normal person understands, not a job title stacked on an organization name. Choose the two or three specifics that carry real weight and drop everything else — a bio listing eight things says nothing about any of them, and the selection IS the writing here. Avoid the register that makes bios unbearable: no "passionate about", no "helping organizations to", no third-person self-praise, no claim I would be uncomfortable reading aloud to someone who knows me well. Where a fact is genuinely impressive, state it plainly and let it do its own work. Include one detail that makes me a person rather than a profile, if there is one worth including. Nothing may claim something I have not told you. Flag anything that will date quickly so I know what needs updating, and mark any point where you had to guess.',
      category: 'writing', gear: ['cabinet'], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'blog-post', name: 'Write a Post', emoji: '▨', tagline: 'One idea, worth someone\'s time',
      accent: '#6fa8bf',
      blurb: 'Turns a thought into a post with a real point — and refuses to pad it out with filler.',
      tags: { general: 1 },
      intake: [
        { dimension: 'audience', question: 'Who is this for?', options: ['people new to the topic', 'people already in it'], recommended: 'people already in it', reason: 'decides how much gets explained versus assumed' }
      ],
      params: [
        { key: 'idea', label: 'The idea', placeholder: 'what you want to say — rough is fine' },
        { key: 'length', label: 'Roughly how long', placeholder: 'e.g. 800 words', required: false, default: 'as long as the idea genuinely supports' }
      ],
      task: 'Write a post from {idea}, around {length}. First find the actual POINT — the thing someone could disagree with, or the thing they did not know before. If the idea as I gave it does not have one yet, tell me instead of writing around the gap, because the most common failure here is a well-written piece that says nothing and neither of us notices until it is published. Open with the specific rather than the general: a case, a number, a moment, a wrong assumption. Then make the argument, giving the concrete instance before the abstraction every time, since readers follow examples and skim principles. Cut the parts that exist only because posts usually have them — the throat-clearing introduction, the summary of what you are about to say, the tidy conclusion restating it. Where I have not given you a real example, ask me for one rather than inventing something plausible. Keep my voice; do not upgrade my phrasing into something smoother and anonymous. Finish with the honest note: the weakest part of the argument, and the objection a sharp reader will have.',
      category: 'writing', gear: ['cabinet'], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
