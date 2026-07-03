/* STARNET — recipe-catalog/creator.js : CREATOR persona recipes (R4 catalog content).

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light
   module pattern as recipes.js: a `RecipeCatalogCreator` global in the browser, module.exports
   under node. NO logic here — pure data.

   Voice contract (match the 10 builtins in recipes.js exactly): imperative DIRECTIVE, answer-first,
   {token} params (0–2 each). Gear is honest — most creator work is pure text (no gear); dish only
   when it must pull real audience/comment data off the web; studio only for real image work;
   cabinet only when it writes drafts to a file. cadence on recurring planners/digests; else null.
   Schema v2: { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
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
      blurb: 'Takes one finished piece and reshapes it for other channels — without flattening the voice.',
      tags: { general: 1 },
      params: [
        { key: 'source', label: 'Source piece', placeholder: 'paste the post / script / article' },
        { key: 'targets', label: 'Turn it into', placeholder: 'e.g. a thread, a newsletter blurb, 3 shorts', required: false, default: 'a short thread and a newsletter blurb' }
      ],
      task: 'Repurpose this into {targets}:\n\n{source}\n\nKeep the core idea and the voice — do not blandly summarize. Reshape it to fit each format\'s rhythm, and give each as a ready-to-post draft. Flag anything that does not translate to a format rather than forcing it.',
      category: 'creator', gear: [], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'hook-drafts', name: 'Hook Drafts', emoji: '⌁', tagline: 'Ten openings that earn the next line',
      accent: '#cf8a7d',
      blurb: 'Drafts a batch of scroll-stopping hooks for a piece — varied angles, none of them clickbait-hollow.',
      tags: { general: 1 },
      params: [{ key: 'topic', label: 'Topic / piece', placeholder: 'what the content is about' }],
      task: 'Draft 10 opening hooks for content about {topic}. Vary the angle — curiosity, contrarian, stakes, story, direct value. Each must earn the next line honestly; no hollow clickbait that the piece cannot pay off. Mark your top three and say why they land.',
      category: 'creator', gear: [], skills: ['creative-ideation', 'humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'title-ab-ideas', name: 'Title A/B Ideas', emoji: '⊞', tagline: 'Titles worth testing against each other',
      accent: '#d9a85a',
      blurb: 'Generates distinct title options built to actually differ — so an A/B test tells you something.',
      tags: { general: 1 },
      params: [{ key: 'subject', label: 'Video / post subject', placeholder: 'what it is about' }],
      task: 'Give me 8 title options for content about {subject}, built to A/B test — each pulling a genuinely different lever (benefit, curiosity, number, contrarian, emotional) so a test result is meaningful, not two near-duplicates. Note which pairing would be the sharpest test.',
      category: 'creator', gear: [], skills: ['creative-ideation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'comment-digest', name: 'Comment Digest', emoji: '▤', tagline: 'What your audience is actually saying',
      accent: '#6fbcc0',
      blurb: 'Reads a pile of comments and distills the real themes — praise, complaints, and content requests.',
      tags: { general: 0.7, research: 0.3 },
      params: [{ key: 'comments', label: 'Comments', placeholder: 'paste the comments / replies' }],
      task: 'Digest these comments:\n\n{comments}\n\nCluster them into themes — what people loved, what they pushed back on, and what they are asking you to make next. Lead with the single most actionable signal. Surface any recurring request or complaint I might be missing, with rough frequency.',
      category: 'creator', gear: [], skills: ['digest-composer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'script-outline', name: 'Script Outline', emoji: '◇', tagline: 'A beat-by-beat outline that holds attention',
      accent: '#b790c0',
      blurb: 'Turns an idea into a paced outline — hook, beats, payoff — before you write a word of script.',
      tags: { general: 1 },
      params: [
        { key: 'idea', label: 'The idea', placeholder: 'what the video / episode is about' },
        { key: 'length', label: 'Rough length', placeholder: 'e.g. 8 minutes', required: false, default: 'a short-to-mid length piece' }
      ],
      task: 'Outline {idea} at {length}. Give me the beat-by-beat structure — hook, the promise, the middle beats that keep tension, and the payoff — with a one-line note on pacing at each. Flag the spot most likely to lose the viewer so I can shore it up.',
      category: 'creator', gear: [], skills: ['creative-ideation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'audience-question-mining', name: 'Question Mining', emoji: '⊙', tagline: 'The content ideas hiding in questions',
      accent: '#6fbcc0',
      blurb: 'Pulls the recurring questions out of your comments or a community — each one a content seed.',
      tags: { general: 0.6, research: 0.4 },
      params: [{ key: 'topic', label: 'Niche / topic', placeholder: 'e.g. home espresso, indie game dev' }],
      task: 'Mine the recurring questions people ask about {topic}. Search where the audience actually gathers, then give me the real, repeated questions grouped by theme — each one a content seed. Lead with the highest-demand, lowest-answered questions, sourced. Skip the ones already answered to death.',
      category: 'creator', gear: ['dish'], skills: ['web-research'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'posting-schedule', name: 'Posting Plan', emoji: '▦', tagline: 'A publishing cadence you can keep',
      accent: '#d9a85a',
      blurb: 'Turns a batch of ideas into a realistic posting calendar sized to what you can actually sustain.',
      tags: { general: 1 },
      params: [
        { key: 'ideas', label: 'Ideas / pillars', placeholder: 'your content ideas or themes' },
        { key: 'cadence', label: 'How often', placeholder: 'e.g. 3 posts a week', required: false, default: 'a sustainable weekly cadence' }
      ],
      task: 'Turn {ideas} into a posting plan at {cadence}. Sequence them so the calendar has variety and momentum, group the ones that can batch-produce together, and be honest about whether the pace is sustainable. Give me a clear week-by-week schedule, not a vague list.',
      category: 'creator', gear: [], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'thumbnail-ideas', name: 'Thumbnail Concepts', emoji: '▨', tagline: 'Visual directions for the frame that sells',
      accent: '#cf8a7d',
      blurb: 'Sketches distinct thumbnail concepts — composition, focal point, text — and can render a rough mock.',
      tags: { general: 1 },
      params: [{ key: 'subject', label: 'Video subject', placeholder: 'what the thumbnail is for' }],
      task: 'Give me 5 thumbnail concepts for a video about {subject}. For each: the focal image, the composition, the 2–4 word overlay, and the emotion it should trigger. Make them genuinely distinct. If it helps, rough out a mock of the strongest one so I can respond to something real.',
      category: 'creator', gear: ['studio'], skills: ['meme-generation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'newsletter-draft', name: 'Newsletter Draft', emoji: '✉', tagline: 'An issue drafted in your voice',
      accent: '#6fbcc0',
      blurb: 'Turns your notes and links into a full newsletter draft — structured, warm, ready to edit.',
      tags: { general: 0.8, research: 0.2 },
      params: [{ key: 'material', label: 'Notes / links', placeholder: 'paste what goes in this issue' }],
      task: 'Draft a newsletter issue from this material:\n\n{material}\n\nGive it a hooky subject line, a warm short intro, the pieces organized so the best lands first, and a clear closing. Keep it in a personal, human voice — not corporate. Draft only; I will edit before it sends.',
      category: 'creator', gear: [], skills: ['humanizer', 'announcement-kit'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'caption-variants', name: 'Caption Variants', emoji: '⌯', tagline: 'The same post, tuned per platform',
      accent: '#b790c0',
      blurb: 'Writes platform-tuned captions for one post — each fitting the channel\'s length and tone.',
      tags: { general: 1 },
      params: [
        { key: 'post', label: 'The post / idea', placeholder: 'what you are posting' },
        { key: 'platforms', label: 'Platforms', placeholder: 'e.g. X, Instagram, LinkedIn', required: false, default: 'X, Instagram, and LinkedIn' }
      ],
      task: 'Write captions for {post}, tuned for {platforms}. Each should fit that platform\'s length, tone, and hashtag norm — not one caption pasted everywhere. Keep the through-line consistent but let the voice flex per channel. Give each as a ready-to-post block.',
      category: 'creator', gear: [], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
