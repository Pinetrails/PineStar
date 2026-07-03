/* STARNET — recipe-catalog/research.js : RESEARCHER persona recipes (R4 catalog content).

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light
   module pattern as recipes.js: a `RecipeCatalogResearch` global in the browser, module.exports
   under node. NO logic here — pure data.

   Voice contract (match the 10 builtins in recipes.js exactly): imperative DIRECTIVE, answer-first,
   {token} params (0–2 each). Gear is honest (dish=web/browser is the researcher's core tool;
   cabinet=writing findings to files; workbench only when running/extracting locally). cadence on
   the naturally-recurring watches/digests; else null. skills only where a bundled skill pairs.
   Schema v2: { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogResearch = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'feed-watch', name: 'Feed Watch', emoji: '◉', tagline: 'Keep an eye on a source for me',
      accent: '#6fa8bf',
      blurb: 'Watches a site, feed, or topic and pings you only when something genuinely new lands.',
      tags: { research: 1 },
      params: [
        { key: 'source', label: 'Source / topic', placeholder: 'e.g. a blog, subreddit, or "OpenAI releases"' },
        { key: 'lens', label: 'What matters', placeholder: 'anything material', required: false, default: 'anything materially new' }
      ],
      task: 'Watch {source} and surface {lens}. Check what changed since last time, and tell me ONLY what is genuinely new and worth knowing — lead with the single most important item, sourced. If nothing material happened, say so in one line rather than padding.',
      category: 'research', gear: ['dish'], skills: ['feed-watch'], cadence: 'sixhourly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'literature-review', name: 'Literature Review', emoji: '◫', tagline: 'Map what is known on a question',
      accent: '#88b6c4',
      blurb: 'Surveys the serious sources on a topic and synthesizes the state of the art — agreements and open gaps.',
      tags: { research: 1 },
      params: [{ key: 'topic', label: 'Question / field', placeholder: 'e.g. RAG vs long-context for retrieval' }],
      task: 'Do a literature review on {topic}. Survey the credible sources, then synthesize: what is well-established, where sources disagree, and what is still open. Lead with the state-of-the-art in a paragraph, then the evidence with citations. Separate consensus from one loud paper.',
      category: 'research', gear: ['dish', 'cabinet'], skills: ['web-research', 'source-triangulation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'competitor-tracking', name: 'Competitor Tracking', emoji: '◎', tagline: 'What a rival shipped or announced',
      accent: '#6fa8bf',
      blurb: 'Tracks a competitor and reports moves that matter — launches, pricing, positioning — not press-release fluff.',
      tags: { research: 0.8, general: 0.2 },
      params: [{ key: 'competitor', label: 'Competitor', placeholder: 'e.g. a company or product name' }],
      task: 'Track {competitor} and brief me on what actually changed: product launches, pricing moves, positioning shifts, notable hires or funding. Lead with the one move that matters most and why it matters to us. Cite sources; skip the press-release adjectives.',
      category: 'research', gear: ['dish', 'cabinet'], skills: ['domain-intel', 'web-research'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'claim-fact-check', name: 'Deep Fact-Check', emoji: '⊜', tagline: 'Verify a claim across the record',
      accent: '#88b6c4',
      blurb: 'Takes a contested claim and triangulates it across independent sources before ruling.',
      tags: { research: 0.9, general: 0.1 },
      params: [{ key: 'claim', label: 'The claim', placeholder: 'paste the statement to verify' }],
      task: 'Fact-check this claim by triangulating independent sources: "{claim}". Verdict first (true / false / misleading / unverifiable), then the evidence trail — who says what, and which sources actually corroborate versus just repeat each other. Never launder a single source into fact.',
      category: 'research', gear: ['dish', 'cabinet'], skills: ['source-triangulation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'topic-monitor', name: 'Topic Monitor', emoji: '◐', tagline: 'Standing watch on a subject',
      accent: '#6fa8bf',
      blurb: 'Keeps a running pulse on a subject and reports the shifts — new developments, shifting sentiment.',
      tags: { research: 1 },
      params: [{ key: 'topic', label: 'Topic', placeholder: 'e.g. EU AI regulation' }],
      task: 'Monitor {topic} and report the shifts since last check: new developments, changing sentiment, notable new sources. Lead with the single most consequential change, sourced. If the picture is unchanged, say so plainly — do not manufacture movement.',
      category: 'research', gear: ['dish'], skills: ['feed-watch', 'web-research'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'paper-summarize', name: 'Summarize a Paper', emoji: '◫', tagline: 'The paper, minus the jargon',
      accent: '#9fc0c4',
      blurb: 'Reads a paper or long document and gives you the claim, the method, and whether it holds up.',
      tags: { research: 0.7, general: 0.3 },
      params: [{ key: 'paper', label: 'Paper / link / text', placeholder: 'paste a link, DOI, or the text' }],
      task: 'Summarize {paper} for a smart non-specialist. Lead with the one-sentence claim, then: what they actually did, what they found, and how much I should trust it — sample size, caveats, conflicts. Flag any gap between what the abstract claims and what the results show.',
      category: 'research', gear: ['dish'], skills: ['arxiv-research', 'pdf-document-extraction'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'source-compare', name: 'Source Compare', emoji: '⊞', tagline: 'Where the sources actually disagree',
      accent: '#88b6c4',
      blurb: 'Puts several sources side by side on one question and isolates exactly where they diverge and why.',
      tags: { research: 1 },
      params: [{ key: 'question', label: 'The question', placeholder: 'e.g. did X cause Y?' }],
      task: 'Compare how the main sources answer: {question}. Lay them side by side, then isolate exactly where they agree, where they diverge, and the likeliest reason for the divergence — different data, framing, or bias. Give me your best synthesis at the end, clearly marked as your read.',
      category: 'research', gear: ['dish', 'cabinet'], skills: ['source-triangulation', 'web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'trend-scan', name: 'Trend Scan', emoji: '◇', tagline: 'What is rising in a space',
      accent: '#d9a85a',
      blurb: 'Scans a field for what is genuinely gaining momentum versus what is just loud this week.',
      tags: { research: 0.9, general: 0.1 },
      params: [{ key: 'space', label: 'Space / field', placeholder: 'e.g. developer tooling' }],
      task: 'Scan {space} for real trends. Distinguish what is genuinely gaining traction — funding, adoption, repeated independent signals — from what is just this week\'s noise. Lead with the two or three that matter, each with the evidence for why it is real, not hype.',
      category: 'research', gear: ['dish'], skills: ['web-research', 'domain-intel'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'background-check', name: 'Background Brief', emoji: '◈', tagline: 'What is on the public record',
      accent: '#9fc0c4',
      blurb: 'Pulls together the public record on a person, company, or product from open sources only.',
      tags: { research: 0.8, general: 0.2 },
      params: [{ key: 'subject', label: 'Subject', placeholder: 'a person, company, or product' }],
      task: 'Build a background brief on {subject} from public sources only. Lead with a two-sentence "who/what this is", then the verified facts — history, track record, notable events — each sourced. Clearly separate confirmed from rumored, and note anything you could not verify.',
      category: 'research', gear: ['dish', 'cabinet'], skills: ['osint-public-records', 'source-triangulation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'research-digest', name: 'Research Digest', emoji: '▤', tagline: 'A themed roundup on your topics',
      accent: '#6fa8bf',
      blurb: 'Gathers the week on your chosen topics into one tight digest — themed, sourced, skimmable.',
      tags: { research: 1 },
      params: [
        { key: 'topics', label: 'Topics', placeholder: 'e.g. AI agents, robotics, chip supply' },
        { key: 'window', label: 'Window', placeholder: 'the past week', required: false, default: 'the past week' }
      ],
      task: 'Compile a research digest on {topics} covering {window}. Group findings by theme, lead each theme with its single most important item, and keep it skimmable — sourced bullets, no filler. End with a two-line "what this means" read. Skip anything stale or trivial.',
      category: 'research', gear: ['dish', 'cabinet'], skills: ['digest-composer', 'web-research'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
