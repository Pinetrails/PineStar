/* STARNET — recipe-catalog/creator.js : CREATOR persona recipes (R4 catalog content).

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light
   module pattern as recipes.js: a `RecipeCatalogCreator` global in the browser, module.exports
   under node. NO logic here — pure data.

   Content contract: every record must clear THE RECIPE BAR documented in core.js (earns its tap /
   drives the station / lands somewhere / compounds when recurring). The creator pack's edge is
   encoding CRAFT: hooks, pacing, retention, platform norms — judgment a creator would have to
   learn the hard way, plus live research of the niche where the web genuinely helps. Voice
   matches the core builtins. Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogCreator = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'content-repurpose', name: 'Repurpose Content', emoji: '⊕', tagline: 'One piece into many formats',
      accent: '#b790c0',
      blurb: 'Finds the core idea and strongest line first, then reshapes per format — never a flattened summary.',
      tags: { general: 1 },
      params: [
        { key: 'source', label: 'Source piece', placeholder: 'paste the post / script / article — or a file path' },
        { key: 'targets', label: 'Turn it into', placeholder: 'e.g. a thread, a newsletter blurb, 3 shorts', required: false, default: 'a short thread and a newsletter blurb' }
      ],
      task: 'Repurpose this into {targets}:\n\n{source}\n\nFirst name the core idea and the single strongest line — those survive every format. Then reshape for each target respecting its native rhythm: a thread needs a hook and a payoff per beat, a newsletter blurb needs a reason to click, a short needs one visual moment. Deliver each as a ready-to-use draft in my voice, not a compression of the original. If a format genuinely weakens the idea, say so instead of forcing it.',
      category: 'creator', gear: [], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'hook-drafts', name: 'Hook Drafts', emoji: '⌁', tagline: 'Ten openings that earn the next line',
      accent: '#cf8a7d',
      blurb: 'Scouts what already works in the niche, then writes hooks built to stand apart — every one payable.',
      tags: { general: 0.6, research: 0.4 },
      params: [{ key: 'topic', label: 'Topic / piece', placeholder: 'what the content is about' }],
      task: 'Draft 10 opening hooks for content about {topic}. Before writing, search what is already earning attention in this niche — then write mine to stand apart from those, not blend in. Vary the mechanism: curiosity gap, contrarian take, concrete stakes, story cold-open, naked value. Every hook must be a promise the content can actually pay off; a hook the piece cannot cash buys one view and costs a subscriber. Mark your top three with one line on why each earns the next second of attention.',
      category: 'creator', gear: ['dish'], skills: ['creative-ideation', 'humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'title-ab-ideas', name: 'Title A/B Ideas', emoji: '⊞', tagline: 'Titles worth testing against each other',
      accent: '#d9a85a',
      blurb: 'Eight titles pulling genuinely different levers — plus which pairing to test first and what a win means.',
      tags: { general: 1 },
      params: [{ key: 'subject', label: 'Video / post subject', placeholder: 'what it is about' }],
      task: 'Give me 8 title options for content about {subject}, engineered to A/B test. Each must pull a genuinely different lever — benefit, curiosity, number, contrarian, urgency, authority — because two near-duplicates teach you nothing. Keep every title honest to the actual content. Then name the sharpest pairing to test FIRST, and what a win for either side would tell us about this audience — the test should buy information, not just a click.',
      category: 'creator', gear: [], skills: ['creative-ideation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'comment-digest', name: 'Comment Digest', emoji: '▤', tagline: 'What your audience is actually saying',
      accent: '#6fbcc0',
      blurb: 'Weights signal over volume — one thoughtful paragraph beats fifty "nice" — and finds the content gaps.',
      tags: { general: 0.7, research: 0.3 },
      params: [{ key: 'comments', label: 'Comments', placeholder: 'paste the comments / replies' }],
      task: 'Digest these comments:\n\n{comments}\n\nCluster into: what landed, what people pushed back on, what they are asking for next, and what confused them — confusion is a content gap, not a dumb audience. Weight by signal, not volume: one thoughtful paragraph outweighs fifty "nice". Lead with the single most actionable takeaway. Surface any recurring request I might be blind to, with rough counts, and flag the one comment most worth replying to personally.',
      category: 'creator', gear: [], skills: ['digest-composer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'script-outline', name: 'Script Outline', emoji: '◇', tagline: 'A beat-by-beat outline that holds attention',
      accent: '#b790c0',
      blurb: 'Promise → proof → payoff structure, the retention lull pre-armed, and the actual opening line written.',
      tags: { general: 1 },
      params: [
        { key: 'idea', label: 'The idea', placeholder: 'what the video / episode is about' },
        { key: 'length', label: 'Rough length', placeholder: 'e.g. 8 minutes', required: false, default: 'a short-to-mid length piece' }
      ],
      task: 'Outline {idea} at {length}. Structure it as promise → proof → payoff: the hook makes a specific promise in the first ten seconds, every beat either advances that promise or opens a new loop, and the payoff lands bigger than the hook implied. Give the beat-by-beat with a one-line pacing note each, mark where retention typically dies (the middle lull) and what to place there to survive it, and write the actual opening line — the words, not a description of them.',
      category: 'creator', gear: [], skills: ['creative-ideation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'audience-question-mining', name: 'Question Mining', emoji: '⊙', tagline: 'The content ideas hiding in questions',
      accent: '#6fbcc0',
      blurb: 'Mines where the audience gathers for high-demand, weakly-answered questions — verbatim, for titles.',
      tags: { general: 0.6, research: 0.4 },
      params: [{ key: 'topic', label: 'Niche / topic', placeholder: 'e.g. home espresso, indie game dev' }],
      task: 'Mine the recurring questions people ask about {topic}. Search where the audience actually gathers — forums, comment sections, communities — and pull the questions that keep coming back, grouped by theme. Rank by demand-versus-supply: high-frequency questions with weak existing answers are content gold; questions already answered to death are landfill. Quote a real example question verbatim for each theme, sourced — real phrasing beats my paraphrase when it becomes a title.',
      category: 'creator', gear: ['dish'], skills: ['web-research'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'posting-schedule', name: 'Posting Plan', emoji: '▦', tagline: 'A publishing cadence you can keep',
      accent: '#d9a85a',
      blurb: 'Sequences for momentum, batches what produces together, and stays honest about what pace will hold.',
      tags: { general: 1 },
      params: [
        { key: 'ideas', label: 'Ideas / pillars', placeholder: 'your content ideas or themes' },
        { key: 'cadence', label: 'How often', placeholder: 'e.g. 3 posts a week', required: false, default: 'a sustainable weekly cadence' }
      ],
      task: 'Turn {ideas} into a posting plan at {cadence}. Sequence for momentum: lead with the strongest hook to earn attention, alternate heavy and light pieces so production never stalls, and group what can batch-shoot or batch-write into the same week. Be brutally honest about sustainability — a plan that slips in week two is worse than a lighter one that holds. Deliver a week-by-week calendar with a one-line brief per slot, plus the single piece to make first and why it is first.',
      category: 'creator', gear: [], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'thumbnail-ideas', name: 'Thumbnail Concepts', emoji: '▨', tagline: 'Visual directions for the frame that sells',
      accent: '#cf8a7d',
      blurb: 'Five concepts that read at phone size in one second, distinct psychologies — plus a rendered rough mock.',
      tags: { general: 1 },
      params: [{ key: 'subject', label: 'Video subject', placeholder: 'what the thumbnail is for' }],
      task: 'Give me 5 thumbnail concepts for a video about {subject}. Each must pass the phone test: readable in under a second at thumbnail size — one focal point, one emotion, three-ish words of overlay at most. Vary the psychology across the five: face-reaction, object-curiosity, before/after, warning, absurd-scale. For each: the focal image, the composition, the overlay text, and the feeling it triggers. Then render a rough mock of the strongest one so I respond to something real, not a description.',
      category: 'creator', gear: ['studio'], skills: ['meme-generation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'newsletter-draft', name: 'Newsletter Draft', emoji: '✉', tagline: 'An issue drafted in your voice',
      accent: '#6fbcc0',
      blurb: 'Five subject lines with a pick, best-first sequencing, a personal take per item — the reason they subscribe.',
      tags: { general: 0.8, research: 0.2 },
      params: [{ key: 'material', label: 'Notes / links', placeholder: 'paste what goes in this issue — or a file path' }],
      intake: [
        { dimension: 'constraints', question: 'What length is this issue?', options: ['short and punchy', 'standard issue', 'deep dive'], recommended: 'standard issue', reason: 'length changes the sequencing and how many items make the cut' }
      ],
      task: 'Draft a newsletter issue from this material:\n\n{material}\n\nSubject line first — write five options and mark your pick, because the subject is half the open rate. Open with one warm human line that earns the scroll. Sequence the pieces best-first, each with a one-line personal take — the take is why they subscribe to ME and not a feed. Close with one clear next thing: a question, a link, a promise. Draft only; I edit before anything goes out.',
      category: 'creator', gear: [], skills: ['humanizer', 'announcement-kit'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'caption-variants', name: 'Caption Variants', emoji: '⌯', tagline: 'The same post, tuned per platform',
      accent: '#b790c0',
      blurb: 'Checks what each platform currently rewards before writing — one through-line, native voice per channel.',
      tags: { general: 1 },
      params: [
        { key: 'post', label: 'The post / idea', placeholder: 'what you are posting' },
        { key: 'platforms', label: 'Platforms', placeholder: 'e.g. X, Instagram, LinkedIn', required: false, default: 'X, Instagram, and LinkedIn' }
      ],
      task: 'Write captions for {post}, tuned for {platforms}. Check what each platform currently rewards before you write — length norms, hashtag culture, and link handling shift constantly, so verify rather than assume. Keep one through-line but let the voice flex: the same idea is a hot take on X, a story on LinkedIn, a punchy visual caption on Instagram. Deliver each as a ready-to-paste block with hashtags only where they actually help, and note anything platform-specific I should know before posting.',
      category: 'creator', gear: ['dish'], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
