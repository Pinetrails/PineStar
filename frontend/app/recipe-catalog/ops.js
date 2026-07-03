/* STARNET — recipe-catalog/ops.js : OPS / PERSONAL persona recipes (R4 catalog content).

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light
   module pattern as recipes.js: a `RecipeCatalogOps` global in the browser, module.exports under
   node. NO logic here — pure data.

   Voice contract (match the 10 builtins in recipes.js exactly): imperative DIRECTIVE, answer-first,
   {token} params (0–2 each). Gear is honest — most planning/decision work is pure text (no gear);
   dish only where it must pull live info off the web (prices, travel, stock); cabinet only where it
   writes an artifact to a file. cadence on the recurring reviews/watches/briefs; else null.
   Schema v2: { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogOps = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'inbox-triage-brief', name: 'Inbox Triage', emoji: '⊟', tagline: 'What in your inbox actually needs you',
      accent: '#6fa8bf',
      blurb: 'Reads a batch of messages and sorts them into reply-now, later, and ignore — with a one-line why.',
      tags: { general: 1 },
      params: [{ key: 'messages', label: 'Messages', placeholder: 'paste the emails / threads' }],
      task: 'Triage these messages:\n\n{messages}\n\nSort them into Reply now / Reply later / FYI-only / Ignore, each with a one-line reason. Lead with anything time-sensitive or from someone important. For the reply-now ones, note in a few words what the reply needs to say. Do not send anything.',
      category: 'ops', gear: [], skills: ['digest-composer'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'meeting-prep', name: 'Meeting Prep', emoji: '◱', tagline: 'Walk in ready, not cold',
      accent: '#6fa8bf',
      blurb: 'Pulls together a tight prep brief for a meeting — context, likely topics, and your talking points.',
      tags: { general: 0.7, research: 0.3 },
      params: [
        { key: 'meeting', label: 'The meeting', placeholder: 'who / what it is about' },
        { key: 'context', label: 'Context', placeholder: 'paste agenda / prior notes', required: false, default: 'what you already know about it' }
      ],
      task: 'Prep me for {meeting}, using {context}. Give me a one-paragraph situation brief, the three topics most likely to come up, the questions I should be ready to answer, and two or three points I should make. If anything needs a quick fact-check first, flag it. Keep it to a single skim.',
      category: 'ops', gear: [], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'weekly-review', name: 'Weekly Review', emoji: '▤', tagline: 'Close the week, aim the next',
      accent: '#7bc88a',
      blurb: 'Walks your week — what got done, what slipped, what matters next — into a short honest review.',
      tags: { general: 1 },
      params: [{ key: 'notes', label: 'This week', placeholder: 'paste your notes / done list / calendar', required: false, default: 'what you tell me about this week' }],
      task: 'Run my weekly review from {notes}. Lead with an honest read of the week: what actually moved, what slipped and why, and what I am avoiding. Then give me the three things that most deserve next week, in priority order. Be a straight mirror, not a cheerleader.',
      category: 'ops', gear: [], skills: ['decision-1-3-1'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'travel-plan', name: 'Travel Plan', emoji: '◈', tagline: 'A trip mapped end to end',
      accent: '#d9a85a',
      blurb: 'Researches a trip and drafts a realistic plan — route, timing, and the bookings that need you.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'trip', label: 'The trip', placeholder: 'e.g. 4 days in Lisbon in October' },
        { key: 'priorities', label: 'What matters', placeholder: 'e.g. food, walkable, budget-conscious', required: false, default: 'a good balance of highlights and downtime' }
      ],
      task: 'Plan {trip} around {priorities}. Research the real options, then give me a day-by-day plan that is actually walkable in the time — where to stay, the route, timing, and the few bookings I should lock early. Lead with a quick summary, then the detail. Flag prices and anything time-sensitive; do not book anything.',
      category: 'ops', gear: ['dish', 'cabinet'], skills: ['web-research', 'plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'price-watch', name: 'Price Watch', emoji: '◉', tagline: 'Tell me when it moves',
      accent: '#6fa8bf',
      blurb: 'Watches the price of something and pings you on a meaningful move — a drop, a spike, back in stock.',
      tags: { general: 0.7, research: 0.3 },
      params: [
        { key: 'item', label: 'What to watch', placeholder: 'a product, ticker, or "flights to Tokyo"' },
        { key: 'trigger', label: 'Tell me when', placeholder: 'it moves meaningfully', required: false, default: 'it moves meaningfully or comes back in stock' }
      ],
      task: 'Watch the price of {item} and tell me when {trigger}. Check the current price, compare to recent levels, and surface it ONLY when there is a real move worth acting on — with the number and the source. If nothing changed, say so in one line rather than reporting a non-event.',
      category: 'ops', gear: ['dish'], skills: ['price-watch'], cadence: 'sixhourly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'subscription-audit', name: 'Subscription Audit', emoji: '⊡', tagline: 'What you are paying for and forgot',
      accent: '#cf8a7d',
      blurb: 'Reviews your recurring charges and flags the ones to cancel, downgrade, or actually use.',
      tags: { general: 1 },
      params: [{ key: 'charges', label: 'Subscriptions / statement', placeholder: 'paste your recurring charges' }],
      task: 'Audit these subscriptions:\n\n{charges}\n\nFor each: keep, downgrade, or cancel — with a one-line reason and the monthly/yearly cost. Lead with the biggest easy savings, flag any duplicates or things I likely forgot I pay for, and total up what cancelling the "cancel" pile would save. I decide; you just make it obvious.',
      category: 'ops', gear: [], skills: ['ledger-upkeep'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'decision-memo', name: 'Decision Memo', emoji: '◇', tagline: 'One page to make the call',
      accent: '#b790c0',
      blurb: 'Turns a hard choice into a clean one-page memo — the options, the trade-offs, a recommendation.',
      tags: { general: 1 },
      params: [{ key: 'decision', label: 'The decision', placeholder: 'the choice you are weighing' }],
      task: 'Write a one-page decision memo for: {decision}. State the real question, lay out the viable options with honest trade-offs, name what you would need to know to be sure, then give a clear recommendation and the reasoning. Mark your confidence. Do not hedge into uselessness — take a position.',
      category: 'ops', gear: [], skills: ['decision-1-3-1'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'learning-plan', name: 'Learning Plan', emoji: '◫', tagline: 'A path from zero to competent',
      accent: '#7bc88a',
      blurb: 'Designs a realistic study path for a skill — sequenced, sourced, sized to the time you have.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'skill', label: 'What to learn', placeholder: 'e.g. SQL, sourdough, Rust' },
        { key: 'budget', label: 'Time budget', placeholder: 'e.g. 3 hours a week', required: false, default: 'a few hours a week' }
      ],
      task: 'Design a learning plan for {skill} on {budget}. Sequence it from foundations to competent, with concrete milestones and a good resource for each stage — no bloated reading list. Include how I will know I actually learned each part. Be honest about how long real progress takes.',
      category: 'ops', gear: ['dish', 'cabinet'], skills: ['study-plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'daily-standup', name: 'Daily Standup', emoji: '☀', tagline: 'Your day, focused before it starts',
      accent: '#d9a85a',
      blurb: 'A short morning brief — what is on today, what matters most, and the one thing to protect.',
      tags: { general: 1 },
      params: [{ key: 'context', label: 'Today', placeholder: 'paste your calendar / tasks', required: false, default: 'today\'s calendar and tasks' }],
      task: 'Give me a focused standup for {context}. Lead with the single most important thing to get done today and protect time for it. Then the rest, ordered — meetings, deadlines, follow-ups. Flag any conflict or over-packed stretch. Keep it to a ten-second read.',
      category: 'ops', gear: [], skills: ['plan'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'stock-watch', name: 'Market Watch', emoji: '◐', tagline: 'A pulse on what you hold or track',
      accent: '#6fa8bf',
      blurb: 'Checks the names you follow and reports moves that matter — with the why, not just the number.',
      tags: { general: 0.5, research: 0.5 },
      params: [{ key: 'watchlist', label: 'Watchlist', placeholder: 'e.g. tickers or assets you follow' }],
      task: 'Give me a market pulse on {watchlist}. Report only the names that moved meaningfully, each with the number and the likely reason — news, earnings, sector move — sourced. Lead with the biggest mover. Skip the flat ones. This is a briefing, not advice; do not tell me to buy or sell.',
      category: 'ops', gear: ['dish'], skills: ['web-research'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
