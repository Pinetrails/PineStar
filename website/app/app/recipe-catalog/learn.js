/* STARNET — recipe-catalog/learn.js : LEARNING persona recipes — understanding something properly.

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light module
   pattern as its siblings: a `RecipeCatalogLearn` global in the browser, module.exports under node.
   NO logic here — pure data.

   Content contract: every record clears THE RECIPE BAR documented in core.js (earns its tap / drives
   the station / lands somewhere / compounds when recurring), in the same imperative harness voice.

   ══ THE LEARNING LINE (this module's extra bar) ══
   These recipes make the Commander ABLE TO DO something — they do not do the coursework for them.
   Where a directive touches assessed work it helps with understanding, planning and practice, and
   says so. The recurring ones (drills, quizzes, review) MUST read the previous run out of memory and
   target what was missed: a quiz that asks fresh random questions every time is a worse tool than a
   deck of cards, and the whole advantage of running this on a station is that it remembers.

   Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogLearn = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'explain-properly', name: 'Explain It Properly', emoji: '◉', tagline: 'Understanding, not a definition',
      accent: '#6fa8bf',
      blurb: 'Builds the idea up from what you already know, then checks you can actually use it.',
      tags: { general: 0.6, research: 0.4 },
      intake: [
        { dimension: 'audience', question: 'Where should I start from?', options: ['assume no background', 'assume I know the basics'], recommended: 'assume I know the basics', reason: 'sets how far back the explanation begins' }
      ],
      params: [
        { key: 'topic', label: 'What to explain', placeholder: 'e.g. how a mortgage rate is set, what a transformer does' },
        { key: 'known', label: 'What you already know', placeholder: 'anything you already understand nearby', required: false, default: 'ordinary general knowledge and nothing specialised' }
      ],
      task: 'Explain {topic}, starting from {known}. Do not open with a definition — a definition is what someone writes when they already understand, and it teaches nobody. Start with the PROBLEM this thing exists to solve, so the idea arrives as an answer to something. Build it up one step at a time, and at each step use an analogy that is accurate rather than merely vivid, then immediately say where the analogy breaks, because a half-true picture is harder to correct later than none. Once the idea is standing, show it working on one real concrete example end to end with actual numbers or specifics. Then name the two or three things people reliably get WRONG about this and why the wrong version is tempting. Finish by asking me two questions I could only answer if I actually understood — not recall questions — and tell me what my getting one wrong would reveal. Go and check anything you are not confident about rather than smoothing over it, and say plainly where the honest answer is that experts disagree.',
      category: 'learn', gear: ['dish'], skills: ['web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'study-plan-build', name: 'Study Plan', emoji: '◱', tagline: 'To a real deadline, with real hours',
      accent: '#d9a85a',
      blurb: 'Works backwards from the exam date through the hours you actually have — and says when the plan does not fit.',
      tags: { research: 0.6, general: 0.4 },
      params: [
        { key: 'subject', label: 'What you are learning', placeholder: 'the subject / syllabus — a file works too' },
        { key: 'deadline', label: 'By when', placeholder: 'e.g. exam on 12 June, 6 hours a week' }
      ],
      task: 'Build me a plan to learn {subject} by {deadline}. First do the arithmetic honestly: total the hours actually available against what this realistically takes, and if it does not fit, say so in the first line and tell me what to cut — a plan that silently assumes I will find time I do not have fails in week two and takes my confidence with it. Sequence topics by what depends on what, front-loading anything everything else builds on. Then structure the time the way learning actually works rather than the way it feels productive: most of it on retrieval and practice problems, only a small share on reading, and REVIEW of earlier material scheduled at widening intervals rather than crammed at the end. Mark the checkpoints where I test myself against real questions, and say what a bad result at each one should change. Name the topic most likely to be quietly skipped because it is unpleasant, since that is the one that shows up in the exam. Keep it to one page and save it so a later run can check my progress against it.',
      category: 'learn', gear: ['notebook', 'cabinet'], skills: ['study-plan', 'plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'quiz-me', name: 'Quiz Me', emoji: '⊜', tagline: 'Recall practice that targets your misses',
      accent: '#7bc88a',
      blurb: 'A recurring drill that reads what you got wrong last time and comes back for it.',
      tags: { research: 0.6, general: 0.4 },
      params: [
        { key: 'material', label: 'The material', type: 'file', placeholder: 'your notes / the syllabus — or name the topic' },
        { key: 'length', label: 'How long', required: false, type: 'choice', default: '10 questions',
          options: ['5 questions', '10 questions', '20 questions', 'until I get 5 in a row right'] }
      ],
      task: 'Quiz me on {material} — {length}. Before you start, read your memory of my previous attempts and WEIGHT the questions toward what I got wrong or answered slowly, plus anything I have not been asked in a while. That targeting is the entire point; asking randomly is what a deck of cards already does for free. Ask ONE question at a time and wait for my answer — never show the answer with the question, and never dump the whole set at once, because reading the answer feels like knowing and is not. Mix recall with questions that need the idea applied to a situation I have not seen. When I am right, say so briefly and move on. When I am wrong, do not just correct me: say what my specific answer suggests I have misunderstood, then give the right answer, then come back to that idea later in the same session with a different question. At the end: what I have solid, what is shaky, what to review before next time. Record the results so the next run targets the gaps.',
      category: 'learn', gear: ['notebook', 'cabinet'], skills: ['study-plan'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'flashcard-build', name: 'Build Flashcards', emoji: '▥', tagline: 'A deck from your own material',
      accent: '#88b6c4',
      blurb: 'Turns your notes into cards that test one idea each — importable, and honest about what it skipped.',
      tags: { research: 0.6, general: 0.4 },
      params: [
        { key: 'material', label: 'Your material', type: 'file', placeholder: 'notes / chapter / slides to turn into cards' },
        { key: 'count', label: 'Roughly how many', placeholder: 'e.g. 40', required: false, default: 'as many as the material genuinely supports' }
      ],
      task: 'Build a flashcard deck from {material}, around {count} cards. One idea per card — a card asking two things teaches neither, and it is the most common way a deck goes bad. Prefer cards that make me RETRIEVE something over cards that ask me to recognize it, and where a fact is only meaningful in context, put enough context in the prompt that the answer is unambiguous. Cover what actually matters rather than what is easiest to make cards from: definitions are cheap to generate and rarely the thing that gets tested, so include cards on relationships, causes, differences between things that are easily confused, and worked steps. Where the material is ambiguous, make the card from what it plainly says and flag it rather than inventing precision. Group the deck by topic and mark the ten cards that carry the most weight. Deliver as a file I can import (two columns, one card per row), and list separately anything important in the material that does NOT suit a card, so I know what the deck is not covering.',
      category: 'learn', gear: ['cabinet'], skills: ['study-plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'teach-back', name: 'Teach It Back', emoji: '◒', tagline: 'The check that finds the holes',
      accent: '#b790c0',
      blurb: 'You explain it, the station finds exactly where your understanding is actually thin.',
      tags: { general: 0.6, research: 0.4 },
      params: [{ key: 'topic', label: 'What you will explain', placeholder: 'the thing you think you understand' }],
      task: 'I am going to explain {topic} to you, and your job is to find the holes. Ask me to explain it as if to someone competent who has never met the idea, then listen for the specific tells of shallow understanding: a piece of jargon used as if it were an explanation, a step asserted without a mechanism, "because that is how it works", and any place I skate quickly over a join. Push exactly there — one question at a time, never a list — and ask the question a genuinely curious person would ask rather than a quiz question. When I cannot answer, do not rescue me immediately: give me one narrowing hint first, since the reach is where the learning happens. Then explain the piece I was missing properly, and ask me to re-explain that part. At the end, give me an honest map: what I genuinely understand, what I can recite but not use, and what I had confidently wrong — that last category is the most valuable thing in this exercise. Then the one thing to go and read. Save the result so a later session can re-test the weak spots.',
      category: 'learn', gear: ['notebook'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'skill-roadmap', name: 'Skill Roadmap', emoji: '◮', tagline: 'Beginner to genuinely competent',
      accent: '#7bc88a',
      blurb: 'Sequences a skill by what unblocks what — with a real thing to make at every stage.',
      tags: { research: 0.6, general: 0.4 },
      params: [
        { key: 'skill', label: 'The skill', placeholder: 'e.g. film colour grading, statistics, welding' },
        { key: 'time', label: 'Time you have', placeholder: 'e.g. 4 hours a week for 3 months', required: false, default: 'a few hours a week, no fixed deadline' }
      ],
      task: 'Map how to actually get good at {skill} with {time}. Find how competent practitioners describe the path — including which conventional advice they say wasted their time, because the standard beginner sequence is often ordered by what is easy to teach rather than what makes you capable. Break it into stages, each defined by what I can DO at the end rather than what I have covered, and each with one concrete thing to make or perform that proves it. Front-load the small number of fundamentals that everything later depends on, and say plainly which popular topics can wait. For each stage: roughly how long at my pace, the single best resource with why that one, the mistake most people make there, and how to tell I am ready to move on rather than grinding. Name the plateau — the point where progress stops feeling visible and most people quit — and what gets through it. Finish with the first session: exactly what to do in the next two hours. Save the roadmap so later runs can check progress.',
      category: 'learn', gear: ['dish', 'notebook'], skills: ['web-research', 'plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'practice-set', name: 'Practice Set', emoji: '▧', tagline: 'Problems at the right difficulty',
      accent: '#d9a85a',
      blurb: 'Generates problems that stretch you slightly — with worked solutions that show the reasoning.',
      tags: { research: 0.6, general: 0.4 },
      params: [
        { key: 'topic', label: 'Topic', placeholder: 'what to practise' },
        { key: 'level', label: 'Your level', placeholder: 'what you can already do', required: false, default: 'whatever level your memory of my previous attempts suggests' }
      ],
      task: 'Give me practice problems on {topic} at {level}. Pitch them just past what I can already do comfortably — too easy teaches nothing and too hard teaches me to give up, and if your memory holds my previous attempts, use them to calibrate. Build a set that VARIES the surface while keeping the underlying idea constant, so I learn the principle instead of learning to recognize one problem shape; include at least one that looks like it needs that approach and does not, because knowing when a tool does not apply is most of real competence. Give me the problems first with nothing else. When I have attempted them, work through each solution showing the REASONING — why that first step, what told you to try it, where a plausible wrong turn leads — not just the algebra. For anything I got wrong, diagnose the specific misunderstanding rather than restating the correct approach, then give me one more problem targeting exactly that. End with what to practise next and what my errors say about where I actually am. Record the outcome for next time.',
      category: 'learn', gear: ['notebook'], skills: ['study-plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'language-drill', name: 'Language Practice', emoji: '⌯', tagline: 'A short daily session that remembers',
      accent: '#6fbcc0',
      blurb: 'A recurring session built around what you got wrong yesterday — conversation, not vocabulary lists.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'language', label: 'Language & level', placeholder: 'e.g. Spanish, can hold a slow conversation' },
        { key: 'focus', label: 'What to work on', placeholder: 'e.g. past tenses, ordering food, sounding less formal', required: false, default: 'whatever your memory says I keep getting wrong' }
      ],
      task: 'Run a short {language} practice session focused on {focus}. Open by reading your memory of my last sessions and bring back two or three things I got wrong then — spaced return is what moves anything into long-term memory, and a session that starts fresh every day is why most practice goes nowhere. Then run a real exchange: give me a situation and play the other person, in the target language at a level just above mine, staying in character. Correct me as a good tutor does — do not interrupt every error, because a learner corrected constantly stops speaking. Let small slips go, fix anything that would actually confuse a listener, and do it by re-saying my sentence correctly in your reply so the correction is absorbed rather than lectured. At the end, and only then, list the three errors worth knowing about with the rule behind each, plus one phrase a native speaker would have used where mine was correct but stiff. Record what I struggled with so tomorrow starts there.',
      category: 'learn', gear: ['notebook'], skills: ['translation-pass'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'misconception-hunt', name: 'What You Have Wrong', emoji: '⚠', tagline: 'The confident mistakes',
      accent: '#cf8a7d',
      blurb: 'Hunts the plausible-but-wrong beliefs in a subject — the ones nobody corrects because you never ask.',
      tags: { research: 0.7, general: 0.3 },
      params: [{ key: 'topic', label: 'The subject', placeholder: 'what you have been learning' }],
      task: 'Hunt down what people confidently get wrong about {topic}. I am not after obscure trivia — I want the beliefs that are widespread, plausible, taught badly, or true-until-a-certain-level-and-then-not, because those are the ones nobody corrects since I would never think to ask. For each: the wrong version as it is normally stated, why it is so tempting (usually it is a reasonable simplification that got frozen, or an analogy taken too far), what is actually true, and the concrete case where believing the wrong version leads somewhere bad. Check your claims against real material rather than repeating the received correction — some popular debunkings are themselves wrong, and a confidently incorrect correction is worse than the original error. Rank by how much damage the mistake does in practice. Then ask me three questions designed so that a person holding the common misconception answers confidently and wrongly, and tell me what each answer would reveal. Say where experts genuinely disagree rather than picking a side.',
      category: 'learn', gear: ['dish'], skills: ['web-research', 'source-triangulation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'book-to-practice', name: 'Book Into Practice', emoji: '◫', tagline: 'What to actually DO about it',
      accent: '#9fc0c4',
      blurb: 'Turns a book you read into the two or three changes worth making — and checks in on them later.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'book', label: 'The book', placeholder: 'title — or point me at your notes / highlights' },
        { key: 'situation', label: 'Your situation', placeholder: 'what you would apply it to', required: false, default: 'what you have told me about your work and life' }
      ],
      task: 'Turn {book} into something I actually do, given {situation}. Skip the chapter summary — I have read it, and a recap is the thing that makes me feel finished without changing anything. Instead: identify the two or three ideas that would genuinely alter how I operate, and for each one give me the specific behaviour change, when and where it would happen, and what I would notice if it were working. Be selective and say why the rest, however interesting, does not apply to me right now. Then push back on the book: which claims are actually well-supported, which are the author generalising from one experience, and which are true but far harder to apply than the book admits — the honest version is more useful than the enthusiastic one. Where the advice conflicts with something else I have told you I am doing, name the conflict and make me choose. Save the two or three commitments so a later run can ask, plainly, whether I did them.',
      category: 'learn', gear: ['notebook', 'cabinet'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'concept-map', name: 'Concept Map', emoji: '⌸', tagline: 'How the pieces connect',
      accent: '#b790c0',
      blurb: 'Lays out a subject as a structure — what depends on what, and where you actually are in it.',
      tags: { research: 0.7, general: 0.3 },
      params: [{ key: 'subject', label: 'The subject', placeholder: 'the field / syllabus / topic to map' }],
      task: 'Map {subject} as a structure rather than a list. Show me the few genuinely load-bearing ideas that everything else hangs from — most subjects have three or four, and knowing which they are is worth more than any amount of coverage. Then lay out how the pieces connect: what must be understood before what, which ideas are the same thing under different names in different sub-fields, and which pairs are routinely confused with each other and why. Mark the difficulty honestly: the parts that are merely unfamiliar versus the two or three that are genuinely hard and where everyone slows down. Show me the edges of the map too — where this subject touches the neighbouring ones, since that is usually where the interesting questions are and where a syllabus stops without saying so. Render it as an indented outline I can read in a terminal AND describe the shape in a paragraph, because the shape is the thing I need to carry in my head. Finish by asking what I already know, then mark where I am on the map and the next step to take.',
      category: 'learn', gear: ['dish', 'notebook'], skills: ['web-research', 'ascii-art'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'exam-prep', name: 'Exam Prep', emoji: '◓', tagline: 'The last stretch, spent well',
      accent: '#cf8a7d',
      blurb: 'Works out where the marks actually are and aims the remaining hours at them.',
      tags: { research: 0.6, general: 0.4 },
      params: [
        { key: 'exam', label: 'The exam', placeholder: 'what it is, its format, and when' },
        { key: 'state', label: 'Where you are', placeholder: 'what is solid and what is not', required: false, default: 'whatever your memory of my practice suggests' }
      ],
      task: 'Plan the run-in to {exam} from {state}. Work out where the MARKS actually are — the format, how they are weighted, and which topics reliably appear — because effort spread evenly across a syllabus is effort spent badly when the paper is not evenly weighted. Then sort my remaining time by marks-per-hour: the shaky topic that carries heavy weight beats both the topic I have already secured and the hard one worth few marks. Say explicitly what to abandon; deciding not to cover something is a strategy, and running out of time having covered everything shallowly is not. Build the schedule around retrieval under timed conditions rather than re-reading, and include one full timed attempt far enough out that a bad result is still fixable. Cover the mechanics that cost people marks they had earned: reading the question properly, time per section, what to do when stuck, and how partial credit works here. Finish with the last 24 hours — light review, no new material, and why cramming new topics now actively costs marks.',
      category: 'learn', gear: ['notebook', 'cabinet'], skills: ['study-plan', 'plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'learn-review', name: 'Weekly Learning Review', emoji: '◕', tagline: 'What stuck, and what did not',
      accent: '#6fa8bf',
      blurb: 'A standing review that tests last week rather than logging it — the forgetting curve, handled.',
      tags: { research: 0.6, general: 0.4 },
      params: [{ key: 'subject', label: 'What you are learning', placeholder: 'the subject — or leave blank for everything you are working on', required: false, default: 'everything you have been learning with me' }],
      task: 'Run my weekly review on {subject}. Do not log what I covered — TEST it. Pull from your memory what I worked on over the last few weeks, weighted so older material gets checked more often than what is still fresh, and ask me a handful of questions on it. Material learned three weeks ago and never revisited is the material I have already lost, and this run exists to catch that. Then report honestly: what has held, what has decayed since I first learned it, and what I never really had. For anything decayed, say whether it is worth restoring or was always peripheral. Compare against last week\'s review so I can see whether the picture is improving — one review is a snapshot, the sequence is the actual signal. Finish with the single topic to spend time on this week and why, and one honest line on whether my current approach is working; if I have been covering new ground while old ground rots, say that plainly. Save this review for next week.',
      category: 'learn', gear: ['notebook'], skills: ['study-plan'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
