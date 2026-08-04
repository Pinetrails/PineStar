/* STARNET — recipe-catalog/career.js : CAREER persona recipes — getting the job, and growing in it.

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light module
   pattern as its siblings: a `RecipeCatalogCareer` global in the browser, module.exports under node.
   NO logic here — pure data.

   Content contract: every record clears THE RECIPE BAR documented in core.js (earns its tap / drives
   the station / lands somewhere / compounds when recurring), in the same imperative harness voice.

   ══ THE CAREER LINE (this module's extra bar) ══
   Every directive here works from what the Commander HAS actually done. A recipe that would invent
   experience, inflate a title, or write a claim the Commander cannot back in a room does not ship —
   not as a matter of taste but because the failure mode is being caught in an interview. Where a
   directive sharpens a claim it says so and shows the original, so nothing gets upgraded silently.

   Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogCareer = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'resume-tailor', name: 'Tailor a Résumé', emoji: '◩', tagline: 'One posting, one version',
      accent: '#7bc88a',
      blurb: 'Rewrites your CV against one specific posting — reordered, re-worded, and never inflated.',
      tags: { general: 1 },
      intake: [
        { dimension: 'constraints', question: 'How far may the rewrite go?', options: ['reorder and reword only', 'restructure freely'], recommended: 'reorder and reword only', reason: 'decides how much of my own voice survives' }
      ],
      params: [
        { key: 'cv', label: 'Your CV', type: 'file', placeholder: 'your current CV file — or paste it' },
        { key: 'posting', label: 'The job posting', placeholder: 'paste the posting — or the link to it' }
      ],
      task: 'Tailor {cv} to this specific posting:\n\n{posting}\n\nRead the posting for what they are ACTUALLY hiring for — the repeated phrases and the first-listed responsibilities are the real job; the wish-list at the bottom mostly is not. Then reorder my experience so the closest-matching work is what a ten-second skim lands on, and rewrite the bullets in their vocabulary where mine says the same thing in different words. Every bullet must lead with the outcome and carry a number where I have given you one — never invent a metric, and where a bullet is vague say WHAT you need from me to sharpen it rather than filling the gap yourself. Nothing may claim experience I have not described to you. Finish with an honest gap read: the requirements I genuinely do not meet, which of those are usually flexible, and one line on how to address the biggest one in a cover letter. Show me the changed bullets side by side with the originals so I can see exactly what you altered. Offer the tailored version as a file.',
      category: 'career', gear: ['cabinet'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'interview-prep', name: 'Interview Prep', emoji: '◫', tagline: 'The questions they will actually ask',
      accent: '#6fa8bf',
      blurb: 'Researches the company and the role, predicts the real questions, and drills your answers with the follow-ups.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'role', label: 'Role & company', placeholder: 'e.g. backend engineer at Acme' },
        { key: 'background', label: 'Your background', type: 'file', placeholder: 'your CV — or a few lines about your experience', required: false, default: 'what you have already told me about your experience' }
      ],
      task: 'Prepare me for an interview for {role}, given {background}. First find out where this company actually is right now — recent announcements, how they make money, what the team I would join is visibly working on, and any public trouble worth knowing about. That context is what separates a candidate who read the careers page from one who did the work. Then predict the ten questions most likely to come up for THIS role at THIS company, weighted by what the posting emphasized, and for each: the answer shape that works, the specific story from my background that fits, and the follow-up they will push with when the first answer is thin. Include the two or three questions I should dread — where my experience is weakest — and how to answer honestly without talking myself out of the job. Then give me questions to ask THEM that are worth their time and reveal whether I want this. End with what to send afterwards. Do not contact anyone.',
      category: 'career', gear: ['dish', 'cabinet'], skills: ['web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'cover-letter', name: 'Cover Letter', emoji: '⌫', tagline: 'One that is clearly not a template',
      accent: '#b790c0',
      blurb: 'Connects your actual experience to their actual problem — short, specific, and in your voice.',
      tags: { general: 1 },
      params: [
        { key: 'posting', label: 'The posting', placeholder: 'paste the posting — or the link' },
        { key: 'angle', label: 'Your angle', placeholder: 'the one thing that makes you right for it', required: false, default: 'whatever in my experience fits it best — you pick' }
      ],
      task: 'Write a cover letter for this posting, leading on {angle}:\n\n{posting}\n\nWork out what problem they are hiring to solve — a posting is a description of a difficulty someone is having — then make the whole letter about the evidence that I have solved that kind of problem before. Open with something specific enough that it could not be sent to another company; never open by naming the role and saying I am excited, which is what every other letter does. Keep it under 250 words, in my voice rather than corporate register, and make every claim traceable to something I actually told you. No superlatives about myself, no restating the CV. Close with a concrete next step. Then give me a two-line note on the weakest sentence and why, so I can decide whether to keep it. Do not send it anywhere.',
      category: 'career', gear: ['cabinet'], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'job-scan', name: 'Job Scan', emoji: '◰', tagline: 'New postings worth your time',
      accent: '#6fa8bf',
      blurb: 'A standing sweep that remembers what it already showed you — so every run is only what is new.',
      tags: { research: 0.6, general: 0.4 },
      params: [
        { key: 'target', label: 'What you are after', placeholder: 'e.g. senior product design, remote, EU timezone' },
        { key: 'dealbreakers', label: 'Dealbreakers', placeholder: 'e.g. no on-site, nothing under 70k', required: false, default: 'nothing beyond what I have already told you' }
      ],
      task: 'Sweep for new openings matching {target}, ruling out {dealbreakers}. Check the real posting boards and the careers pages of companies that fit, and compare everything against your memory of what you have already shown me — a repeat listing is noise and re-surfacing it trains me to stop opening these. For each genuinely new one: the role, the company in one honest line (including anything that should give me pause — layoffs, a bad reputation among staff, a stale posting that has been open for months), the compensation if it is stated or a realistic range if it is not, and the single reason it fits me. Rank by fit, not recency. Say plainly when a listing looks like a ghost posting. If nothing new is worth my time, say exactly that and stop. Record what you surfaced so the next run has something to compare against.',
      category: 'career', gear: ['dish', 'notebook'], skills: ['web-research', 'opportunity-scan'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'salary-benchmark', name: 'Salary Benchmark', emoji: '◮', tagline: 'What the role really pays',
      accent: '#d9a85a',
      blurb: 'Triangulates real pay data for your role, level and location — with the number you should actually say.',
      tags: { research: 0.6, general: 0.4 },
      params: [
        { key: 'role', label: 'Role & level', placeholder: 'e.g. senior data engineer, 6 years, Berlin' },
        { key: 'current', label: 'Current package', placeholder: 'what you earn now, including bonus / equity', required: false, default: 'what I tell you when you ask' }
      ],
      task: 'Benchmark what {role} actually pays, against my current {current}. Triangulate across several kinds of evidence — published ranges in real postings, pay-transparency filings where the law requires them, aggregate reports, and community-reported numbers — and tell me how much to trust each, because self-reported data skews high and aggregators lag the market by a year. Give me the honest range with the median, and separately the number at the top end that is still defensible rather than fantasy. Break out the parts people forget to compare: bonus structure and whether it actually pays out, equity and what it is really worth at this stage of company, pension, and the benefits that are worth real money. Then the practical part: the single number I should say when asked, why that one, and how to answer the current-salary question without anchoring myself low. Note where the evidence was thin instead of smoothing over it.',
      category: 'career', gear: ['dish'], skills: ['web-research', 'source-triangulation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'negotiate-offer', name: 'Negotiate an Offer', emoji: '⊛', tagline: 'The counter, and the words for it',
      accent: '#7bc88a',
      blurb: 'Reads the whole offer, finds what is actually movable, and gives you the counter to send.',
      tags: { general: 1 },
      params: [
        { key: 'offer', label: 'The offer', placeholder: 'paste the offer — salary, equity, benefits, start date' },
        { key: 'priorities', label: 'What you want most', placeholder: 'e.g. base over equity, remote days', required: false, default: 'the highest total value, weighted toward guaranteed money' }
      ],
      task: 'Help me counter this offer, optimizing for {priorities}:\n\n{offer}\n\nStart by valuing the whole package honestly, including the parts designed to look bigger than they are — equity with a long cliff at a private valuation is not cash, and a signing bonus is one year of money dressed as a raise. Then identify what is genuinely movable: base is usually harder than a signing bonus, start date and title are often free, and remote arrangements depend entirely on who is asking. Give me a counter with a specific number and the justification behind it, plus the fallback if they hold firm, and the point at which I should accept rather than push again. Draft the actual message — warm, brief, no apologizing for negotiating, and never an ultimatum I am not prepared to honor. Flag anything in the offer that should worry me: an unusual clause, a vague bonus, a probation term that undercuts everything else. Do not send it — the message is mine.',
      category: 'career', gear: ['cabinet'], skills: ['decision-1-3-1'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'career-story', name: 'Your Career Story', emoji: '◔', tagline: 'The thread through your jobs',
      accent: '#b790c0',
      blurb: 'Finds the real narrative connecting your roles — the answer to "walk me through your CV".',
      tags: { general: 1 },
      params: [{ key: 'history', label: 'Your history', type: 'file', placeholder: 'your CV — or the jobs in order with what you did' }],
      task: 'Build my career story from {history}. Find the actual thread — the problem I keep being drawn to, the capability that compounded across roles, the thing I got measurably better at — and say it in one sentence I could open an interview with. A career rarely looks intentional from the inside, but there is almost always a real pattern, and I want the true one rather than a flattering fiction. Then give me the two-minute spoken version, with each move explained as a deliberate step rather than a thing that happened to me. Handle the awkward parts head-on: gaps, short stints, a sideways move, a title that went backwards — each needs a one-line answer that is honest and does not invite a follow-up. Finish with the three stories from my history that are worth rehearsing because they will answer half of all behavioral questions, and what each one demonstrates. Flag anything you needed and did not have instead of writing around it.',
      category: 'career', gear: ['cabinet', 'notebook'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'perf-review-prep', name: 'Review Prep', emoji: '◱', tagline: 'Evidence, before you walk in',
      accent: '#88b6c4',
      blurb: 'Assembles what you actually shipped into the case your manager needs — with the counter-argument prepared.',
      tags: { general: 1 },
      params: [
        { key: 'period', label: 'The period', placeholder: 'e.g. the last 6 months' },
        { key: 'evidence', label: 'Your evidence', type: 'folder', placeholder: 'notes / shipped work / your log — or leave blank and I will ask', required: false, default: 'whatever you can tell me about what you shipped' }
      ],
      task: 'Prepare my performance review for {period} from {evidence}. Assemble what I actually delivered, and for each item state the OUTCOME rather than the activity — nobody is moved by a list of tasks, they are moved by what changed because of them. Where I have a number, use it; where I do not, say what number would have made the case so I can go and find it before the meeting. Group by the things my organization visibly rewards rather than by chronology. Then the part people skip: prepare the counter-argument. What is the strongest case against my rating, what did I visibly not do well in this period, and what is the honest answer to it — being ready for that beats another accomplishment bullet. Finish with the specific ask (rating, raise, scope, title), the evidence that supports it, and one line on what I want next period so the conversation ends forward-looking. Save this so the next review can show the arc across periods.',
      category: 'career', gear: ['cabinet', 'notebook'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'promotion-case', name: 'Promotion Case', emoji: '⊕', tagline: 'The written argument for the next level',
      accent: '#7bc88a',
      blurb: 'Measures you against the actual next-level bar and builds the document — including where you fall short.',
      tags: { general: 1 },
      params: [
        { key: 'level', label: 'The level you want', placeholder: 'e.g. senior → staff' },
        { key: 'rubric', label: 'The rubric', type: 'file', placeholder: 'your company\'s levelling guide, if you have one', required: false, default: 'the widely-understood expectations for that level' }
      ],
      task: 'Build my case for {level} against {rubric}. Work from the real bar: promotion is usually granted for already OPERATING at the next level, not for excelling at the current one, so go through each expectation and mark it honestly as demonstrated, partially demonstrated, or not yet — with the specific evidence beside each one. Do not round anything up; a case that overclaims gets picked apart by the one person in the room who knows better, and I would rather find that gap now. For everything short of demonstrated, name the concrete piece of work over the next quarter that would close it, in priority order. Then write the case itself: a page that leads with the strongest evidence, is written in the language of the rubric, and makes the reviewer\'s job easy. Add the two questions a skeptical panel will ask and my answers. Tell me plainly if the honest read is that I am a cycle away — that is a more useful answer than a case that fails.',
      category: 'career', gear: ['cabinet'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'networking-outreach', name: 'Outreach That Lands', emoji: '⌁', tagline: 'A message a stranger will answer',
      accent: '#6fbcc0',
      blurb: 'Researches the person first, then writes the short specific note that actually earns a reply.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'person', label: 'Who', placeholder: 'name / role / company — or the link to their profile' },
        { key: 'ask', label: 'What you want', placeholder: 'e.g. 20 minutes about their team, a referral', required: false, default: 'a short conversation, nothing transactional' }
      ],
      task: 'Write outreach to {person} asking for {ask}. First find out what they have actually said or built publicly — talks, posts, projects, anything with their fingerprints on it. A message that could have been sent to a hundred people gets the response a hundred-person message deserves, and the specific detail is the entire difference. Then write it short: one line establishing the genuine connection or reason I am writing to THEM, one line on who I am that is relevant to them, and one clear small ask with an easy way to say no. Under 120 words. No flattery that reads as researched flattery, no listing my credentials, no asking for something big from a stranger. Give me one alternate opening in a different register so I can pick the one that sounds like me. Add a note on the right moment and channel to send it, and what a reasonable follow-up looks like if there is no reply — once, and then let it go. Do not send anything.',
      category: 'career', gear: ['dish'], skills: ['web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'skill-gap-career', name: 'Skill Gap for a Role', emoji: '◒', tagline: 'What is missing, in the order to fix it',
      accent: '#d9a85a',
      blurb: 'Compares where you are against where the role expects you to be, and sequences the shortest path.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'target', label: 'Target role', placeholder: 'e.g. engineering manager, ML engineer' },
        { key: 'now', label: 'Where you are', type: 'file', placeholder: 'your CV — or a few lines on what you can do now', required: false, default: 'what you already know about my experience' }
      ],
      task: 'Compare {now} against what {target} actually requires and give me the gap. Work out the real expectations from live postings and from what people in the role describe doing day to day, not from a course syllabus — the two differ a lot, and the second one is the truth. Then sort the gaps into three piles: things I already have and merely fail to evidence (these are the cheapest wins and usually the largest pile), things I could genuinely close in a few months, and things that need a year or a change of job to get. Be blunt about which gaps are actually disqualifying versus which are wish-list items nobody enforces. Sequence the closable ones by what unblocks the most, and for each name the specific thing to build or do — a real project or responsibility, never "take a course", because the evidence is what counts. End with the single move that would most change how I look on paper in the next 90 days.',
      category: 'career', gear: ['dish', 'notebook'], skills: ['web-research', 'plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'portfolio-review', name: 'Portfolio Review', emoji: '▧', tagline: 'Through a hiring manager\'s eyes',
      accent: '#cf8a7d',
      blurb: 'Reviews your portfolio the way someone with 90 seconds and thirty tabs open actually reviews it.',
      tags: { general: 0.7, research: 0.3 },
      params: [
        { key: 'portfolio', label: 'Your portfolio', placeholder: 'the link — or point me at the folder / files' },
        { key: 'role', label: 'The role you want', placeholder: 'what you want it to win you', required: false, default: 'the kind of work you have told me you want' }
      ],
      task: 'Review {portfolio} the way a hiring manager filling {role} would — someone with ninety seconds, thirty tabs open, and a bias toward saying no. Tell me what they understand about me after the first screen alone, and whether that is the impression I want. Then go piece by piece: which items are carrying the portfolio, which are actively hurting it (an old weak piece drags the whole set down more than it adds range), and which are unclear about what I actually did versus what the team did. Check whether each piece shows the DECISIONS and not just the finished artifact — that is what distinguishes a portfolio from a gallery. Then the practical fixes in priority order: what to cut, what to reorder, what needs a two-line framing to make its value legible, and the one missing piece that would most strengthen the set. Be specific and be harsh; a polite review is a wasted one.',
      category: 'career', gear: ['dish', 'cabinet'], skills: ['adversarial-review-pass'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'leaving-well', name: 'Leaving Well', emoji: '⌦', tagline: 'Resign without burning anything',
      accent: '#9fc0c4',
      blurb: 'The resignation note, the handover doc, and the counter-offer decision made before you are in the room.',
      tags: { general: 1 },
      params: [
        { key: 'situation', label: 'The situation', placeholder: 'role, notice period, how it has been going' },
        { key: 'handover', label: 'What you own', placeholder: 'the work / systems that are yours', required: false, default: 'what you tell me you are responsible for' }
      ],
      task: 'Help me leave well, given {situation}, handing over {handover}. Three things. First the resignation message: short, warm, no reasons beyond a general one, no grievances — the note gets forwarded and lives forever, and everything I might want to say belongs in a conversation instead. Second the handover: what I own, its current state, what breaks without me and who should hold it, the things only I know that are written down nowhere, and the access that needs transferring — sequenced so the last week is a handover and not a scramble. Third, the counter-offer decision made NOW rather than in the room: what would genuinely have to change for me to stay, why the reasons I am leaving usually survive a raise, and the number or condition below which the answer is no. Add what to say in the exit conversation and what to keep back, plus the practical checklist people forget — final pay, unused leave, who will vouch for me later, anything vesting, and copies of work I am entitled to keep.',
      category: 'career', gear: ['notebook'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
