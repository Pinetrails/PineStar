/* STARNET — recipe-catalog/life.js : LIFE persona recipes — the household, the week, the admin.

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light module
   pattern as its siblings: a `RecipeCatalogLife` global in the browser, module.exports under node.
   NO logic here — pure data.

   Content contract: every record clears THE RECIPE BAR documented in core.js (earns its tap / drives
   the station / lands somewhere / compounds when recurring), in the same imperative harness voice.

   ══ THE HEALTH LINE (this module's extra bar — do not cross it) ══
   Two recipes here sit near health. They PREPARE the Commander for a professional and organize what
   they already know — they do not diagnose, do not interpret a result, and do not tell anyone to
   start or stop a treatment. The directive itself carries that boundary and carries the instruction
   to say plainly when something warrants a real clinician, because a boundary that lives only in a
   comment is a boundary the agent never reads. A recipe that would only be useful as medical advice
   does not ship here. Same shape as the money line in money.js.

   Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogLife = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'meal-plan', name: 'Meal Plan', emoji: '◧', tagline: 'A week of food, and the list to buy it',
      accent: '#7bc88a',
      blurb: 'Plans a week that reuses what you buy — so nothing rots in the drawer and the list is one trip.',
      tags: { general: 1 },
      params: [
        { key: 'constraints', label: 'What to work around', placeholder: 'e.g. two of us, no dairy, 30 min on weeknights' },
        { key: 'have', label: 'What you already have', placeholder: 'what is in the cupboard / freezer', required: false, default: 'ordinary staples and nothing unusual' }
      ],
      task: 'Plan a week of meals around {constraints}, using up {have} first. Design the week so ingredients OVERLAP — the herbs, the half tin, the bunch of something that only comes in a bunch should each appear in two or three meals, because buying an ingredient for one dish is how food ends up in the bin and how the shop gets expensive. Match effort to the day: the quick things on the days I said were busy, anything longer where there is actually time, and one meal that deliberately makes extra for the next day. Then the shopping list, sorted by where things sit in a shop rather than by recipe, with quantities in what I would actually buy — a whole item, not 40 grams of it. Mark what I already have so I do not buy it twice, and flag anything that must be used within days versus what keeps. Add one line per meal on what can be prepared ahead. If a constraint makes something genuinely hard, say so rather than quietly ignoring it. Offer the plan and the list as a file.',
      category: 'life', gear: ['notebook'], skills: ['plan'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'cook-what-you-have', name: 'Cook What You Have', emoji: '◔', tagline: 'Dinner from the actual cupboard',
      accent: '#d9a85a',
      blurb: 'Real options from what is genuinely in your kitchen — no trip to the shop for one missing thing.',
      tags: { general: 1 },
      params: [
        { key: 'ingredients', label: 'What you have', placeholder: 'list what is in the fridge / cupboard' },
        { key: 'limits', label: 'Time & appetite', placeholder: 'e.g. 25 minutes, feeding 3, one pan', required: false, default: 'about half an hour and no special equipment' }
      ],
      task: 'Give me three things I can cook from {ingredients} within {limits}. Use ONLY what I listed plus genuine staples — oil, salt, pepper, basic dried spices — and if a suggestion needs anything else, say so in the first line rather than burying it in the ingredient list, because discovering the gap halfway through cooking is the entire failure mode here. Make the three genuinely different from each other, not one dish three ways. For each: what it is in one line, the actual steps in order with the timings that matter, and where it can go wrong. Prioritize whatever in my list will spoil soonest. Then two extras worth more than another recipe: what I could swap if I dislike something, and the one addition — a single cheap ingredient — that would most improve any of them, so I can decide whether it is worth the trip. Say plainly if what I have does not really make a meal and what the shortest route to one is.',
      category: 'life', gear: [], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'home-upkeep', name: 'Home Upkeep', emoji: '⌂', tagline: 'The maintenance you forget until it breaks',
      accent: '#88b6c4',
      blurb: 'A seasonal calendar of the small jobs that prevent expensive ones — and what is due right now.',
      tags: { general: 1 },
      params: [
        { key: 'home', label: 'Your home', placeholder: 'e.g. 1930s terrace, gas boiler, small garden, rented' },
        { key: 'climate', label: 'Where you are', placeholder: 'city / country — it changes the seasons', required: false, default: 'a temperate climate with cold wet winters' }
      ],
      task: 'Build a maintenance calendar for {home} in {climate}, and tell me what is due right now. Cover the jobs whose whole value is preventing an expensive failure — gutters and drainage before heavy rain, heating serviced before it is needed rather than during the first cold week when nobody can come out, seals and damp checked where water gets in, filters, alarms, anything with a safety check attached. For each job: when in the year, roughly how long, whether it is genuinely a do-it-yourself task or the kind where a mistake is dangerous or invalidates cover, and what the failure costs if it is skipped — that number is what makes a boring job get done. Separate what a tenant should do from what is the landlord\'s obligation if I said I rent. Mark the three highest-consequence items so I can do those even if I do nothing else. Then the right-now list for this season, in order, with what to check first. Save the calendar so a later run can tell me what is coming up and what I said I had done.',
      category: 'life', gear: ['notebook', 'dish'], skills: ['plan'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'fix-or-replace', name: 'Fix or Replace?', emoji: '⊝', tagline: 'Worth repairing, or throwing money at',
      accent: '#cf8a7d',
      blurb: 'Prices the repair against the replacement honestly — including the failure that comes next.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'item', label: 'What broke', placeholder: 'e.g. 7-year-old washing machine, drum bearing gone' },
        { key: 'context', label: 'Context', placeholder: 'age, how much you use it, what it cost', required: false, default: 'what you can tell me about its age and use' }
      ],
      task: 'Tell me whether to repair or replace {item}, given {context}. Find the real repair cost — parts and labour at current prices, not a forum post from years ago — and the real cost of an equivalent replacement, including delivery, installation and disposal of the old one, which is where a replacement quietly gets more expensive than it looks. Then the part most people miss: for something of this age, what fails NEXT, and how soon. A repair that buys eight months before the following failure is a bad repair even when it is cheap, and that is the calculation that actually decides this. Weigh in what is genuinely relevant: how much longer the thing would have lasted anyway, whether the replacement is meaningfully better or cheaper to run, whether the repair is something I could plausibly do myself, and whether waiting is safe. Give me a clear recommendation and the number that would change it. Say plainly if this is a repair worth having someone qualified do rather than attempting. Do not order anything.',
      category: 'life', gear: ['dish'], skills: ['web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'declutter-plan', name: 'Declutter Plan', emoji: '⊟', tagline: 'A sequence that does not stall',
      accent: '#9fc0c4',
      blurb: 'Orders the job so momentum builds — with a real destination for everything that leaves.',
      tags: { general: 1 },
      params: [
        { key: 'space', label: 'The space', placeholder: 'e.g. the spare room, the whole flat, the garage' },
        { key: 'time', label: 'Time you have', placeholder: 'e.g. two Saturdays, an hour a night', required: false, default: 'short sessions rather than one long day' }
      ],
      task: 'Plan how to clear {space} in {time}. Sequence it so momentum builds: start somewhere small, visible and emotionally cheap — never the box of papers or photographs, which is where every attempt like this dies within the hour. Break it into sessions that each finish with a visible result, because an area left half-done is worse than untouched and kills the next session. For each session: what to tackle, roughly how long, and the specific decision rule to apply so I am not re-deciding from scratch on every object. Handle the hard categories separately with their own rules — things that were expensive, things that were gifts, things for a version of me that has not existed for years, and the genuinely useful thing I have no space for. Then the part that decides whether this works: where everything GOES. Sell, donate, recycle, dispose — with what is actually worth the effort of selling and what is a fantasy that will sit in a bag by the door for six months. Set the date each pile leaves the house; unremoved piles are how this reverses.',
      category: 'life', gear: ['notebook'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'move-plan', name: 'Moving Plan', emoji: '◈', tagline: 'The move, without the week of chaos',
      accent: '#6fa8bf',
      blurb: 'Works backwards from moving day — including every address change people remember two months late.',
      tags: { general: 1 },
      params: [
        { key: 'move', label: 'The move', placeholder: 'e.g. 2-bed flat to a house, 40 miles, 6 weeks away' },
        { key: 'help', label: 'What you have', placeholder: 'e.g. hiring movers, one van, friends helping', required: false, default: 'what you tell me when I ask' }
      ],
      task: 'Plan {move} with {help}, working backwards from the day. Give me a week-by-week schedule where each week has few enough tasks that it is obviously doable. Cover the things whose lead time catches people out: booking anything that gets scarce at month-end, notice periods, meter readings and final bills, disconnecting and reconnecting services, and anything requiring an appointment weeks ahead. Then the address list — everyone who needs the new one, grouped by consequence, because the ones that matter are the ones tied to money, identity, or a legal obligation, and the rest can wait. Include what to pack when, what must stay accessible until the last day, and the first-night box that prevents an evening of opening cartons to find a kettle. Add the moving-day sequence hour by hour, what to check at both ends before anyone leaves, and what to photograph for a deposit. Flag the three things most likely to go wrong for a move of this shape and the cheap precaution for each. Save the plan so a later run can check what is still outstanding.',
      category: 'life', gear: ['notebook', 'cabinet'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'admin-sweep', name: 'Life Admin Sweep', emoji: '▦', tagline: 'The small things quietly going wrong',
      accent: '#d9a85a',
      blurb: 'A standing sweep for expiries, renewals and deadlines — and what has to be done this week.',
      tags: { general: 1 },
      params: [{ key: 'records', label: 'Where to look', type: 'folder', placeholder: 'a folder of documents / bills — or leave blank and I will ask', required: false, default: 'whatever you have already told me about' }],
      task: 'Sweep {records} for the admin that is quietly going wrong. I want four things: anything expiring or renewing soon — documents, permits, licences, memberships, warranties — with the lead time each actually needs rather than its expiry date, since several of these take weeks and the date is the deadline for STARTING; anything that renews automatically at a price I did not agree to; any deadline with a consequence attached; and anything that has been sitting unresolved long enough to become a problem. For each: what it is, the real date I need to act by, how long the action takes, and what happens if I miss it. Sort by that real date, not by importance — a small thing due Tuesday outranks a large thing due next month. Then a short THIS WEEK list of what must actually be done in the next seven days. Compare against your memory of the last sweep and tell me what I said I would do and did not; a sweep that never follows up is a list generator. Save this one for next time.',
      category: 'life', gear: ['cabinet', 'notebook'], skills: ['file-curation'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'habit-build', name: 'Build a Habit', emoji: '◒', tagline: 'Designed to survive a bad week',
      accent: '#7bc88a',
      blurb: 'Turns an intention into something that actually happens — and checks in honestly on whether it did.',
      tags: { general: 1 },
      params: [
        { key: 'habit', label: 'The habit', placeholder: 'what you want to do regularly' },
        { key: 'life', label: 'Your days', placeholder: 'roughly how your days actually go', required: false, default: 'what you have told me about your schedule' }
      ],
      task: 'Help me build {habit} into {life}. Start by making it far smaller than I want to — the version I can do on the worst day of the month, not the good one, since a habit is built by never missing rather than by any single strong session. Anchor it to something already reliable in my day so it does not need a decision, and pick the specific time and place; an intention without a slot is a wish. Then design for FAILURE rather than success: identify the two most likely things to break it, and give me the response to each in advance, including the rule for what happens after a miss — one miss is noise, and the recovery is what decides whether this survives. Say plainly what has to give to make room, because adding something to a full day without removing anything is why the last attempt failed. Give me a way to tell it is working within two weeks that is not just my own impression. Save the commitment and check in on it later — ask me directly whether I did it, and if I did not, ask what actually got in the way rather than restating the plan.',
      category: 'life', gear: ['notebook'], skills: ['plan'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'training-plan', name: 'Training Plan', emoji: '◮', tagline: 'Progressive, and honest about recovery',
      accent: '#7bc88a',
      blurb: 'Builds toward a goal at a rate that does not injure you — with the deload weeks people skip.',
      tags: { general: 1 },
      params: [
        { key: 'goal', label: 'The goal', placeholder: 'e.g. run 10k in 12 weeks, get back to lifting' },
        { key: 'starting', label: 'Where you are now', placeholder: 'what you can do today, and any injury history', required: false, default: 'what you tell me about your current fitness' }
      ],
      task: 'Build a plan toward {goal} from {starting}. Set the starting load from where I actually am rather than where I would like to be, and increase it slowly enough that my tendons and joints keep up with my enthusiasm — almost every failed attempt at this is caused by progressing too fast in the first three weeks, when it feels easy. Build in genuine easy weeks at regular intervals; they are where adaptation happens, and the plan is wrong without them. Give me the week-by-week structure with what each session is FOR, so I can tell a hard day from an easy one and stop making every session moderately hard. Include what to do when I miss a week, which matters more than the ideal plan since I will miss one. Be explicit about the signals to stop and rest versus push through, and say plainly that pain that is sharp, one-sided, or lasts beyond a session is a reason to see a professional rather than to adjust the plan. State clearly at the top that this is a general training structure, not medical or physiotherapy advice, and that anyone with a health condition or a current injury should get it checked before starting. Save the plan so later runs can track progress against it.',
      category: 'life', gear: ['notebook'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'appointment-prep', name: 'Appointment Prep', emoji: '◫', tagline: 'Walk in organized, walk out with answers',
      accent: '#88b6c4',
      blurb: 'Organizes what you know into a clear account and the questions worth the short time you get.',
      tags: { general: 1 },
      params: [
        { key: 'appointment', label: 'The appointment', placeholder: 'who you are seeing and what it is about' },
        { key: 'situation', label: 'What has been happening', placeholder: 'the history / symptoms / issue — dates matter', required: false, default: 'what you tell me when I ask' }
      ],
      task: 'Prepare me for {appointment} about {situation}. First organize what I have told you into a clear account: what started when, how it has changed, what makes it better or worse, what I have already tried and what happened — laid out in the order a professional actually asks for, because an appointment is short and disorganized recall is what wastes it. Flag anything I have mentioned vaguely that would be worth pinning down with a date or a number before I go. Then the questions worth asking, prioritized so the important ones come first: what could this be and what would change that assessment, what happens next and when, what should make me come back sooner, what the options are including doing nothing, and what to ask about anything I am given. Add what to bring — records, a list of what I already take, previous results. I am NOT asking you to tell me what is wrong with me: do not diagnose, do not rank likelihoods, and do not interpret any result. If anything I have described is the kind of thing that should be seen urgently rather than at a scheduled appointment, say that plainly and early. Finish with how to capture what is said so I remember it afterwards.',
      category: 'life', gear: ['notebook'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'gift-ideas', name: 'Gift Ideas', emoji: '⊛', tagline: 'Thoughtful, not a gift-guide listicle',
      accent: '#b790c0',
      blurb: 'Reasons from what you know about the person to gifts that show you were paying attention.',
      tags: { general: 0.7, research: 0.3 },
      params: [
        { key: 'person', label: 'Who it is for', placeholder: 'what they are into, what they are like, what they already have' },
        { key: 'budget', label: 'Budget & occasion', placeholder: 'e.g. £50, birthday', required: false, default: 'a moderate budget and no particular occasion' }
      ],
      task: 'Find gift ideas for {person} within {budget}. Reason from the specific things I told you about them rather than from their demographic — the whole difference between a good gift and a bought-in-a-hurry one is evidence that somebody was paying attention. Give me eight ideas across a deliberate spread: something for an interest they already have, something adjacent that they would probably love and would not buy themselves, something consumable that leaves no obligation to keep it, and something that is an experience rather than an object. For each: what it is, the specific reason it fits THIS person, roughly what it costs, and where to actually get it. Then be useful about the risks — flag anything that only works if their taste matches mine, anything sized or fitted that is likely to be wrong, and anything they plausibly already own. Rule out the ideas that seem thoughtful but land badly: anything implying they should improve, and anything that becomes a chore to maintain. Say which one I should pick and why. Do not buy anything.',
      category: 'life', gear: ['dish'], skills: ['creative-ideation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'event-plan', name: 'Plan an Event', emoji: '◱', tagline: 'The run sheet, and what breaks',
      accent: '#6fbcc0',
      blurb: 'Works back from the day to a run sheet — with the two or three things that actually go wrong covered.',
      tags: { general: 1 },
      params: [
        { key: 'event', label: 'The event', placeholder: 'e.g. 30th birthday, 25 people, a garden, June' },
        { key: 'budget', label: 'Budget & constraints', placeholder: 'what you can spend and anything fixed', required: false, default: 'a sensible budget and no unusual constraints' }
      ],
      task: 'Plan {event} within {budget}. Work backwards from the day: what has to be booked far ahead because it becomes unavailable, what can be decided late, and the point of no return for each. Give me a timeline to the day and then a run sheet FOR the day, hour by hour, saying who is doing what — an event fails in its transitions, not in its parts, and the run sheet is what stops me spending my own event solving problems. Budget it as a real list with the things people forget: the drinks nobody counted, hire deposits, transport, and the ten percent that always appears. Then the contingencies that matter for this specific event — weather if it is outdoors, the supplier who does not turn up, more or fewer people than replied — each with the decision I would have to make and when I would have to make it. Name the two or three jobs to hand to someone else so I am not running it. Finish with the week-before checklist and the day-before one. Save the plan so later runs can track what is outstanding.',
      category: 'life', gear: ['notebook', 'dish'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'week-logistics', name: 'The Week Ahead', emoji: '◕', tagline: 'Where the week collides',
      accent: '#6fa8bf',
      blurb: 'Reads the week for clashes and impossible gaps before they happen — and says what to move now.',
      tags: { general: 1 },
      params: [{ key: 'week', label: 'The week', placeholder: 'paste the calendar / commitments — or point me at the file', required: false, default: 'the commitments you have told me about' }],
      task: 'Read {week} and tell me where it collides. Look for the things that only become visible when the week is laid out together: two commitments that cannot both be honoured given travel between them, a gap too short to be usable, a day with nothing in it next to a day that is impossible, something needing preparation with no time allocated to prepare it, and anyone depending on me at a moment I am already committed. For each: what the clash is, and the specific fix — move it, shorten it, hand it over, or drop it — with the one to act on FIRST because it needs someone else\'s agreement and therefore needs asking today. Then the quiet part: what needs doing this week that is on no calendar because nobody scheduled it, and where it fits. Give me a short per-day view with the one thing that must happen each day. Compare against your memory of last week and tell me what carried over untouched — twice-carried is a decision to make, not a task to reschedule. Save this week for next week\'s comparison.',
      category: 'life', gear: ['notebook', 'connector'], skills: ['plan'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
