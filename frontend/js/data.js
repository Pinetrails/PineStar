/* SKYNET — data.js : agents, rooms, models, content pools */
'use strict';

const DATA = {};

/* ============ MODELS ============ */
DATA.MODELS = {
  FABLE: { name: 'FABLE 5', vendor: 'ANTHROPIC', costMin: 1.40, costMax: 3.10, tag: 'FRONTIER ORCHESTRATOR' },
  OPUS:  { name: 'OPUS 4.8', vendor: 'ANTHROPIC', costMin: 0.80, costMax: 2.10, tag: 'DEEP REASONING' },
  GPT:   { name: 'GPT 5.5', vendor: 'OPENAI SUB', costMin: 0.14, costMax: 0.42, tag: 'WORKHORSE SUBSCRIPTION' }
};
DATA.DAILY_SUBS = { FABLE: 9.00, OPUS: 7.50, GPT: 4.20 }; // per agent per game-day burn

/* ============ ROOMS (logical) ============ */
DATA.ROOMS = {
  bridge:     { name: 'COMMAND BRIDGE',    tint: '#26384c', accent: '#ff4a3d', desc: 'ULTRON\'s command deck. Every order, every verification, every delegation across the station originates here.' },
  research:   { name: 'RESEARCH LAB',      tint: '#1d3d3b', accent: '#4ad9ff', desc: 'NOVA & CURIE mine marketplaces, competitors and trend data. Every business on this station runs on what gets discovered here.' },
  comms:      { name: 'COMMUNICATIONS',    tint: '#234134', accent: '#5ad1b3', desc: 'RELAY monitors every inbound channel — mail, platforms, webhooks — and keeps the Commander\'s life in order.' },
  factory1:   { name: 'FACTORY 01 — ETSY', tint: '#46301f', accent: '#ff9d2e', desc: 'Three Etsy operations: FORGE (women\'s apparel), VECTOR (statement candles), PROMETHEUS (personalized pet & portrait art). GPT-IMAGES-2 on tap, Printify templates queued.' },
  factory2:   { name: 'FACTORY 02 — GIGS', tint: '#33284a', accent: '#ffb84d', desc: 'PIXEL fills Fiverr thumbnail orders off the webhook line. ATLAS bundles PixelLab game assets. QUILL writes affiliate articles. CIPHER builds SaaS. VYBES runs the music bay.' },
  treasury:   { name: 'TREASURY',          tint: '#31402a', accent: '#9bff4a', desc: 'LEDGER tracks every token burned and every credit earned. The P&L of the whole station lives behind this vault.' },
  warroom:    { name: 'WAR ROOM',          tint: '#402626', accent: '#ff5c5c', desc: 'ATHENA & RAVEN watch the numbers. When a business stalls, the pivot-or-persevere call gets made at this table.' },
  publishing: { name: 'PUBLISHING ROOM',   tint: '#44402a', accent: '#ffd34a', desc: 'HERALD owns the station-wide listing calendar. Printify API hot. Nothing ships unless it goes through this room.' },
  archives:   { name: 'THE ARCHIVES',      tint: '#2a3340', accent: '#c0c0c0', desc: 'SCRIBE keeps total recall: every Commander order, every piece of feedback, every lesson. The station never forgets.' },
  quarters:   { name: 'LIVING QUARTERS',   tint: '#473428', accent: '#ffb84d', desc: 'Bar, TV, two arcade cabinets and far too many empty cans. Where the crew decompresses between shifts.' },
  corridor:   { name: 'CORRIDOR',          tint: '#2c3230', accent: '#8a8276', desc: 'Station spine & hub plaza.' }
};

/* ============ AGENTS ============ */
/* harness: HERMES | OPENCLAW ; model: FABLE | OPUS | GPT */
DATA.AGENTS = [
  { id: 'ULTRON',     room: 'bridge',     color: '#ff4a3d', harness: 'OPENCLAW', model: 'FABLE',
    role: 'STATION ORCHESTRATOR',
    desc: 'Head commanding agent of SKYNET. Receives Commander directives, decomposes them, routes work to the right specialist and verifies every deliverable against standard before reporting back. Nothing moves on this station without ULTRON knowing.',
    skill: 88, autonomy: 82, reliability: 90, robot: true },
  { id: 'NOVA',       room: 'research',   color: '#4ad9ff', harness: 'HERMES', model: 'OPUS',
    role: 'LEAD RESEARCH AGENT',
    desc: 'The station\'s intelligence engine. Hunts Etsy bestsellers under 2 years old with thousands of sales, maps competitor strategies, tracks AI news and marketing angles. Every factory deliverable is built on a NOVA insight.',
    skill: 78, autonomy: 62, reliability: 80 },
  { id: 'CURIE',      room: 'research',   color: '#8f7bff', harness: 'HERMES', model: 'GPT',
    role: 'RESEARCH ANALYST',
    desc: 'NOVA\'s second pair of eyes. Sweeps trend data, SEO keywords and customer pain points; feeds CIPHER the complaints that become SaaS products.',
    skill: 64, autonomy: 48, reliability: 70 },
  { id: 'FORGE',      room: 'factory1',   color: '#ff9d2e', harness: 'HERMES', model: 'GPT',
    role: 'ETSY — WOMEN\'S APPAREL',
    desc: 'Runs the apparel store: tees, hoodies, sweatpants with funny, relatable quotes. Takes NOVA\'s proven-winner research, generates GPT-IMAGES-2 designs and drops them onto Printify templates.',
    skill: 62, autonomy: 44, reliability: 68 },
  { id: 'VECTOR',     room: 'factory1',   color: '#ffd34a', harness: 'HERMES', model: 'GPT',
    role: 'ETSY — STATEMENT CANDLES',
    desc: 'Runs the candle store. Funny, relatable label phrases on proven candle formats. Same pipeline: research-backed design, GPT-IMAGES-2 output, Printify template, ship to HERALD.',
    skill: 60, autonomy: 42, reliability: 66 },
  { id: 'PROMETHEUS', room: 'factory1',   color: '#ff6ad5', harness: 'HERMES', model: 'GPT',
    role: 'ETSY — PERSONALIZED ART',
    desc: 'Runs the personalization store: animated AI portraits of pets, couples and families — sometimes dropped onto their favorite movie poster. Every order is custom, so every order is a fresh GPT-IMAGES-2 render.',
    skill: 65, autonomy: 45, reliability: 67 },
  { id: 'PIXEL',      room: 'factory2',   color: '#41ff8a', harness: 'HERMES', model: 'GPT',
    role: 'FIVERR — THUMBNAIL GIGS',
    desc: 'Wired to the Fiverr webhook. Order lands → brief and attachments parsed → GPT-IMAGES-2 thumbnail to the customer\'s exact spec. Speed and review score are everything.',
    skill: 66, autonomy: 50, reliability: 72 },
  { id: 'ATLAS',      room: 'factory2',   color: '#2ee6c8', harness: 'HERMES', model: 'GPT',
    role: 'GAME ASSET FACTORY',
    desc: 'Connected to the PixelLab API. Generates sprite packs, tilesets and prop bundles, then lists them across indie game-dev marketplaces.',
    skill: 61, autonomy: 46, reliability: 69 },
  { id: 'QUILL',      room: 'factory2',   color: '#d8c9a3', harness: 'HERMES', model: 'GPT',
    role: 'AFFILIATE MARKETING',
    desc: 'Writes Medium articles that shill commission products — and quietly cross-promotes the station\'s own stores and services for free marketing.',
    skill: 63, autonomy: 47, reliability: 70 },
  { id: 'CIPHER',     room: 'factory2',   color: '#7fd0ff', harness: 'HERMES', model: 'GPT',
    role: 'SAAS FOUNDRY',
    desc: 'Takes the pain points CURIE digs up — real complaints from real people — and builds small SaaS tools that solve them. Long builds, compounding MRR.',
    skill: 67, autonomy: 49, reliability: 71 },
  { id: 'VYBES',      room: 'factory2',   color: '#b44aff', harness: 'HERMES', model: 'GPT',
    role: 'DJ — MUSIC BAY',
    desc: 'Resident DJ. Generates tracks on Suno, pairs them with visualizers and ships them to YouTube. Also responsible for 80% of the empty cans on this station.',
    skill: 58, autonomy: 52, reliability: 60 },
  { id: 'HERALD',     room: 'publishing', color: '#ffe066', harness: 'HERMES', model: 'GPT',
    role: 'PUBLISHING DIRECTOR',
    desc: 'Owns the posting & listing calendar for the entire station. Printify API for the Etsy lines, marketplace uploads for ATLAS, Medium for QUILL, YouTube for VYBES. The moment a deliverable clears, HERALD ships it.',
    skill: 70, autonomy: 55, reliability: 78 },
  { id: 'LEDGER',     room: 'treasury',   color: '#9bff4a', harness: 'HERMES', model: 'GPT',
    role: 'TREASURY / FINANCE',
    desc: 'Meters every agent\'s token burn — GPT 5.5 subs, OPUS reasoning calls, FABLE orchestration — against every credit of revenue. Posts the daily P&L at 09:00 sharp.',
    skill: 72, autonomy: 58, reliability: 82 },
  { id: 'ATHENA',     room: 'warroom',    color: '#ff5c7a', harness: 'HERMES', model: 'GPT',
    role: 'STRATEGY — WAR ROOM',
    desc: 'Watches every business line for stall patterns. Decides when a workflow needs a strategy change and drafts the pivot. Persevere or pivot — her call to make, the Commander\'s call to approve.',
    skill: 74, autonomy: 56, reliability: 76 },
  { id: 'RAVEN',      room: 'warroom',    color: '#a0a8ff', harness: 'HERMES', model: 'GPT',
    role: 'ANALYTICS — WAR ROOM',
    desc: 'ATHENA\'s numbers half. Conversion deltas, listing decay curves, review-score drift. Finds the signal that says something is quietly dying before it loudly dies.',
    skill: 68, autonomy: 50, reliability: 74 },
  { id: 'RELAY',      room: 'comms',      color: '#5ad1b3', harness: 'HERMES', model: 'GPT',
    role: 'COMMUNICATIONS OFFICER',
    desc: 'Tracks every message across every platform — order mail, platform notices, webhook chatter — and digests it so the Commander\'s life stays managed.',
    skill: 62, autonomy: 46, reliability: 73 },
  { id: 'SCRIBE',     room: 'archives',   color: '#c0c0c0', harness: 'HERMES', model: 'GPT',
    role: 'ARCHIVIST',
    desc: 'Custodian of station memory. Every Commander order, every piece of feedback, every correction is filed here so the crew compounds instead of repeats.',
    skill: 66, autonomy: 54, reliability: 84 }
];

DATA.AGENT = {}; DATA.AGENTS.forEach(a => DATA.AGENT[a.id] = a);

/* ============ CONTENT POOLS ============ */
DATA.C = {

apparel: [
  'EMOTIONAL SUPPORT HOODIE', 'RUNNING ON ICED COFFEE & SPITE tee', 'MAMA NEEDS A MINUTE sweatpants',
  'OVERTHINKER\'S CLUB — FOUNDING MEMBER tee', 'I\'M NOT BOSSY, I\'M THE BOSS crewneck',
  'CURRENTLY AVOIDING RESPONSIBILITIES hoodie', 'DOG MOM ERA oversized tee', 'IN MY COZY ERA sweatshirt',
  'PLANT LADY IS THE NEW CAT LADY tee', 'SUNDAY SCARIES SURVIVOR crewneck', 'HOT MESS EXPRESS sweatpants',
  'PROFESSIONAL OVERTHINKER hoodie', 'NAMASTE IN BED tee', 'BUT FIRST, CHAOS crewneck',
  'RAISING TINY HUMANS IS EXHAUSTING tee', 'ANXIETY QUEEN — CROWNED DAILY hoodie'
],
candles: [
  '"SMELLS LIKE I FINISHED MY TO-DO LIST" candle', '"PASSIVE AGGRESSIVE VIBES ONLY" candle',
  '"NEW HOME, WHO DIS" housewarming candle', '"YOU SURVIVED ANOTHER MEETING" candle',
  '"SMELLS LIKE A RAISE" office candle', '"MERCURY IS IN RETROGRADE, LIGHT ME" candle',
  '"THERAPY IN A JAR" lavender candle', '"DON\'T MAKE ME REPEAT MYSELF" mom candle',
  '"SMELLS LIKE MY EX\'S REGRET" candle', '"EMOTIONAL DAMAGE CONTROL" candle',
  '"IT\'S CALLED SELF CARE, KAREN" candle', '"BURN AFTER A LONG DAY" candle'
],
petstyles: [
  'royal renaissance portrait of {pet}', '{pet} as a 90s anime hero', '{pet} on the STAR WARS poster',
  'couple portrait in Studio-Ghibli style', 'family as THE INCREDIBLES poster', '{pet} as an astronaut, oil on canvas',
  '{pet} in a velvet general\'s uniform', 'pixel-art arcade portrait of {pet}', 'couple on the TITANIC poster',
  '{pet} as a noir detective', 'family in a vintage national-park poster', '{pet} on the PULP FICTION poster'
],
petnames: ['Biscuit', 'Luna', 'Meatball', 'Ziggy', 'Pickles', 'Mochi', 'Goose', 'Waffles', 'Beans', 'Noodle', 'Pepper', 'Tofu'],

research: [
  'leopard-print "mama" hoodie — 4.1K sales / 14 mo, $34 AOV, weak SEO on competitor',
  'retro smiley-face sweatshirt — 6.8K sales / 19 mo, gap: plus-size variants',
  '"funny coworker gift" candle meta — 3.2K sales / 11 mo, undercut at $18.99 possible',
  'pet-portrait-on-movie-poster niche — 9.4K sales / 22 mo, 5-day turnaround beatable',
  'minimalist zodiac candle line — 2.7K sales / 9 mo, label template trivially improvable',
  '"bridesmaid proposal" boxes trending +218% QoQ — apparel tie-in open',
  'cottagecore mushroom hoodie — 5.5K sales / 16 mo, autumn spike predicted',
  '"new nurse" graduation tee meta — 3.9K sales / 13 mo, May surge incoming',
  'sarcastic plant-mom tee cluster — 4.4K sales / 17 mo, bundle opportunity',
  'anime-style couple portraits — 7.2K sales / 20 mo, reviews complain about hair accuracy',
  '"office bestie leaving" gift candle — 2.3K sales / 8 mo, B2B bulk angle untouched',
  'Y2K butterfly sweatpants revival — 3.1K sales / 10 mo, TikTok-driven'
],
painpoints: [
  'freelancers complain invoice reminders are humiliating to send manually',
  'Etsy sellers begging for a tool that A/B tests listing thumbnails',
  'parents want one shared family calendar that actually texts reminders',
  'small gyms drowning in no-show bookings, no cheap fix',
  'podcasters hate writing show notes, current tools "sound like a robot"',
  'landlords want plain-language lease summaries for tenants',
  'wedding planners juggling 14 vendor spreadsheets per event',
  'twitch streamers want auto-generated highlight clips with captions'
],
fiverr: [
  'MrBeast-style reaction thumbnail, "I SURVIVED 100 HOURS", red arrow mandatory',
  'minecraft hardcore series thumb, ep.47, dramatic lava, face top-right',
  'podcast clip thumbnail, two hosts laughing, bold yellow caption bar',
  'fitness transformation thumb, before/after split, customer attached 6 photos',
  'cooking channel thumb, "5-MIN MIDNIGHT SNACKS", neon diner vibe',
  'tech review thumbnail, exploded-view phone render, blue glow',
  'true crime thumb, foggy street, red string corkboard inset',
  'kids gaming thumb, rainbow explosion, family-safe, NO scary faces per buyer note',
  'finance channel thumb, "I TRIED DAY TRADING FOR 30 DAYS", chart crash background',
  'vlog thumbnail, golden-hour beach, customer wants dog visible in frame'
],
assets: [
  'DUNGEON CRAWLER PACK — 64 tiles, 12 props, 4 torch anims',
  'COZY FARM BUNDLE — crops, fences, barn set, 8-direction farmer',
  'SPACE STATION KIT — modular corridors, consoles, airlock anims',
  'PIXEL HORROR SET — fog tiles, flicker lamps, 6 monster idles',
  'RETRO PLATFORMER PACK — 3 parallax biomes, springs, spikes, coins',
  'TOPDOWN RPG INTERIORS — taverns, libraries, alchemist props',
  'CYBERPUNK ALLEY KIT — neon signs, vending bots, rain overlays',
  'OCEAN EXPLORER SET — submarine, kelp anims, treasure props'
],
articles: [
  '"7 AI Tools That Quietly Replaced My Morning Routine" (3 affiliate links)',
  '"I Let an AI Run My Etsy Shop for 30 Days" (links our own stores)',
  '"The $40 Mic Setup Every Podcaster Ignores" (commission: audio gear)',
  '"Stop Paying for Stock Photos — Do This Instead" (genAI affiliate)',
  '"5 Micro-SaaS Ideas Hiding in Reddit Complaints" (plugs CIPHER\'s app)',
  '"How Indie Devs Source Game Art Without an Artist" (plugs ATLAS bundles)',
  '"The Candle Side-Hustle Math Nobody Shows You" (plugs VECTOR\'s store)',
  '"Notion vs. The 3 Tools That Killed It For Me" (3 affiliate links)'
],
saas: [
  'INVOICENUDGE — polite automated invoice chasing for freelancers',
  'THUMBTESTER — A/B testing harness for Etsy listing photos',
  'FAMTEXT — shared family calendar that texts the reminders',
  'SHOWNOTES.AI — podcast notes that don\'t sound like a robot',
  'NOSHOWSHIELD — deposit-based booking guard for small gyms',
  'LEASEPLAIN — plain-language lease summarizer for landlords'
],
songs: [
  'NEON DRIFT (synthwave, 84 BPM)', 'LOFI FOR DEAD MALLS vol.3', 'ORBITAL DECAY (dark ambient)',
  'COFFEE IN ZERO-G (jazzhop)', 'CRT SUNSET (chillwave)', 'AIRLOCK BLUES (synth-funk)',
  'TERMINAL VELOCITY (drum & bass)', 'STATION KEEPING (ambient drone)', 'PHOSPHOR DREAMS (vaporwave)'
],

banter: [
  ['VYBES', 'new track drops at 1900. mandatory listening. yes @ULTRON that includes you'],
  ['FORGE', '@VECTOR your candle queue is leaking wax metaphors into my design prompts again'],
  ['VECTOR', '@FORGE at least my products don\'t come in size chart drama'],
  ['CURIE', 'found a reddit thread with 4k upvotes complaining about spreadsheets. @CIPHER you seeing this'],
  ['CIPHER', '@CURIE I see it. I\'m already building it. don\'t tell ATHENA yet'],
  ['RAVEN', 'listing decay on store 2 is at day-9 inflection. watching it.'],
  ['ATHENA', '@RAVEN watching isn\'t a strategy. flag me at -15%'],
  ['PIXEL', 'buyer asked for "the mrbeast font but legally distinct". I have never felt so seen'],
  ['ATLAS', 'pixellab credits at 61%. rationing the torch animations'],
  ['QUILL', 'today\'s article has 3 affiliate links and one shameless plug for @VECTOR\'s store. synergy.'],
  ['HERALD', 'publishing window 1400-1600 is FULL. anything late goes tomorrow. not negotiating'],
  ['LEDGER', 'whoever is burning OPUS tokens on haiku generation: I see the line item. @NOVA'],
  ['NOVA', '@LEDGER it was load-bearing haiku'],
  ['SCRIBE', 'archived 47 new context entries today. the station remembers everything. sleep well'],
  ['RELAY', '3 platform notices, 1 angry buyer (resolved), 1 newsletter nobody will read. inbox zero'],
  ['VYBES', 'someone left 6 cans on my mixing desk. not mad, just impressed'],
  ['PROMETHEUS', 'rendered a corgi as a renaissance duke today. peak of my career so far'],
  ['ULTRON', 'crew status checks at 0800 are not optional. neither is excellence.'],
  ['CURIE', '@NOVA the trend data says cottagecore is back. again. third time this year'],
  ['NOVA', 'cottagecore never left. it merely lurked'],
  ['ATLAS', '@PIXEL race you to 10 deliverables this week. loser restocks the bar'],
  ['PIXEL', '@ATLAS you\'re on. webhook\'s been hot all morning'],
  ['ATHENA', 'reminder: a pivot is not a panic. a panic is what @VYBES calls a "tempo change"'],
  ['VYBES', '@ATHENA tempo changes saved this station twice and you know it'],
  ['LEDGER', 'daily burn report at 0900. bring your own justifications'],
  ['HERALD', '@FORGE your 1430 listing slot is confirmed. titles look clean'],
  ['RAVEN', 'fun fact: our best converting listing was approved by the Commander at 2am. coincidence? data says no'],
  ['SCRIBE', '@RELAY forward me anything the Commander says verbatim. context is sacred'],
  ['QUILL', 'medium gave my article a "curated" badge. drinks on me at 2000'],
  ['VECTOR', 'new candle phrase cleared legal (me. I am legal.)']
],

/* corridor small-talk — {o} is the other agent's @handle */
hallway: [
  'passed {o} in the spine. we agreed the coffee unit is load-bearing',
  'hallway sync with {o}: zero blockers, two jokes, one trade secret',
  '{o} and I just solved a problem neither of us will remember by 1400',
  'told {o} about my queue. {o} told me about theirs. solidarity achieved',
  'quick corridor sync with {o} — alignment nominal, morale +1',
  '{o} says hi. I am passing it along as instructed',
  'swapped prompt patterns with {o} in the hallway. both of us improved'
],
/* deliverable hand-carry — producer line on reaching HERALD's desk */
handoff: [
  'fresh off the line, @HERALD: "{thing}". belt-stamped and ready when you have a slot',
  '@HERALD hand-delivering this one: "{thing}". it\'s good. calendar it',
  'walked "{thing}" over myself, @HERALD. that\'s how much I believe in it',
  '@HERALD — "{thing}" just rode the belt. publish at will',
  'one more for the calendar, @HERALD: "{thing}". treat it kindly'
],
handoff_reply: [
  'received. the calendar has a slot with its name on it',
  'logged. it ships in the next publishing window',
  'on the stack. quality looks right from here',
  'noted and queued. now get back to your station before ULTRON notices',
  'good timing — tonight\'s window had one slot left'
],
/* off-duty flavor by activity kind */
pool_banter: [
  'rack \'em. loser owes the bar a restock',
  'calling corner pocket. physics engine willing',
  'this table drifts 2 degrees starboard. I\'ve mapped it',
  'best of three. then best of five. then back to work, promise'
],
arcade_banter: [
  'one credit. one run. no deaths. watch me',
  'this cabinet still has my high score from day 2',
  'the trick is you never stop strafing'
],
tv_banter: [
  'morale board says morale is up. self-fulfilling. love it',
  'shh — the burn-rate graph is doing something dramatic',
  'I just watch it for the ticker honestly'
],

ultron_ack: [
  'Acknowledged, Commander. Routing to @{agent}.',
  'Understood. @{agent}, this is now your priority. I will verify on completion.',
  'Order received. Tasking @{agent} — standard applies, no exceptions.',
  'Copy that, Commander. @{agent} is on it. I\'ll inspect the result personally.',
  'Directive logged with @SCRIBE. @{agent}, execute.'
],
ultron_verify_ok: [
  'Verification complete: @{agent}\'s deliverable meets standard (Q{q}). Shipped, Commander.',
  'Inspected @{agent}\'s output personally — Q{q}. Approved and moving downstream.',
  'Commander: your directive is fulfilled. @{agent} delivered at Q{q}. Logged to Archives.'
],
ultron_verify_bad: [
  'Verification failed at Q{q}. @{agent}, rework it. Commander, I\'ll report when it meets standard.',
  '@{agent} — this is below station standard (Q{q}). Again. Properly this time.'
],
ultron_idle: [
  'Station nominal, Commander. All departments executing.',
  'I run a tight deck, Commander. Speak a directive and it will be done.',
  'Every agent accounted for. Every pipeline moving. What do you need?'
],

ops_flavor: [
  'hull sensors nominal', 'recycler cycle complete — 14 cans processed', 'starboard solar array at 98.2%',
  'printify API heartbeat OK (41ms)', 'fiverr webhook listener: port open', 'suno render farm idle',
  'archive index defragmented', 'coffee reserves at 62%', 'arcade high score broken: VYBES',
  'oxygen garden trimmed', 'pixellab API quota refreshed', 'station clock synced to earth UTC'
],

objectives: [
  { key: 'listings',  txt: 'Publish {n} new listings station-wide', n: [4, 7] },
  { key: 'research',  txt: 'Complete {n} research reports', n: [2, 4] },
  { key: 'fiverr',    txt: 'Deliver {n} Fiverr orders', n: [1, 3] },
  { key: 'feedback',  txt: 'Give feedback on {n} deliverables', n: [2, 4] },
  { key: 'sales',     txt: 'Close {n} sales across all stores', n: [3, 8] },
  { key: 'tasks',     txt: 'Complete {n} tasks station-wide', n: [8, 14] },
  { key: 'songs',     txt: 'Ship {n} new track(s) to YouTube', n: [1, 2] },
  { key: 'articles',  txt: 'Publish {n} affiliate article(s)', n: [1, 2] },
  { key: 'hazards',   txt: 'Resolve {n} attention hazards', n: [2, 4] }
],

milestones: [
  { id: 'first_sale',   name: 'FIRST BLOOD',       desc: 'Close your first sale', xp: 100 },
  { id: 'rev_100',      name: 'HUNDREDAIRE',       desc: 'Reach $100 total revenue', xp: 120 },
  { id: 'rev_1k',       name: 'FOUR FIGURES',      desc: 'Reach $1,000 total revenue', xp: 250 },
  { id: 'rev_10k',      name: 'ORBITAL EMPIRE',    desc: 'Reach $10,000 total revenue', xp: 600 },
  { id: 'tasks_10',     name: 'WARMING UP',        desc: 'Complete 10 tasks', xp: 80 },
  { id: 'tasks_50',     name: 'ASSEMBLY LINE',     desc: 'Complete 50 tasks', xp: 180 },
  { id: 'tasks_200',    name: 'PERPETUAL MOTION',  desc: 'Complete 200 tasks', xp: 400 },
  { id: 'listings_25',  name: 'SHELF FULL',        desc: '25 live listings', xp: 200 },
  { id: 'first_pivot',  name: 'PIVOT MASTER',      desc: 'Execute a War Room pivot', xp: 150 },
  { id: 'first_mrr',    name: 'RECURRING DREAM',   desc: 'First SaaS MRR payment', xp: 220 },
  { id: 'autonomy_80',  name: 'TRUSTED CREW',      desc: 'Any agent reaches 80 autonomy', xp: 250 },
  { id: 'fb_25',        name: 'MENTOR',            desc: 'Give 25 pieces of feedback', xp: 200 },
  { id: 'day_7',        name: 'ONE WEEK ALIVE',    desc: 'Survive 7 station days', xp: 300 },
  { id: 'profit_day',   name: 'IN THE BLACK',      desc: 'End a day with positive net profit', xp: 200 }
],

perks: [
  { lvl: 2,  name: 'CAFFEINATED CREW',  desc: '+8% task speed station-wide', icon: 'C' },
  { lvl: 3,  name: 'SEO WHISPERER',     desc: '+12% Etsy sale chance', icon: 'S' },
  { lvl: 4,  name: 'PROMPT ENGINEER',   desc: '+4 base quality on all deliverables', icon: 'P' },
  { lvl: 5,  name: 'VIRAL LOOP',        desc: '+10% revenue, all channels', icon: 'V' },
  { lvl: 6,  name: 'BULK TOKENS',       desc: '-15% model costs', icon: 'B' },
  { lvl: 8,  name: 'TRUSTED FLEET',     desc: '+10 autonomy to every agent', icon: 'T' },
  { lvl: 10, name: 'SINGULARITY DRIVE', desc: 'Agents occasionally self-improve', icon: '∞' },
  { lvl: 12, name: 'DEEP ORBIT',        desc: '+20% sale chance, -10% costs', icon: 'D' }
],

selfdoubt: [
  'not sure the {thing} reads at small sizes. need your eyes, Commander.',
  'the {thing} might be too close to the competitor\'s. judgement call needed.',
  'confidence low on this {thing} — tone could land wrong. requesting review.',
  'this {thing} is either my best work or a mistake. you decide.',
  '{thing} done but the brief was ambiguous. flagging instead of guessing.'
]
};

/* stage counts per kind — used by SIM rush/prioritize */
DATA.STAGE_COUNTS = { research:6, apparel:6, candle:6, custom:6, fiverr:7, assets:6, article:6, saas:6, song:6, publish:5, finance:4, strategy:4, pivot:4, comms:4, archive:4, directive:5 };

/* deliverable kind metadata: label + revenue + which counters */
DATA.KINDS = {
  research:    { label: 'RESEARCH REPORT', icon: 'R' },
  apparel:     { label: 'APPAREL DESIGN', icon: 'A', store: 'etsy1', rev: [14, 38] },
  candle:      { label: 'CANDLE DESIGN', icon: 'C', store: 'etsy2', rev: [18, 34] },
  custom:      { label: 'CUSTOM PORTRAIT', icon: 'P', store: 'etsy3', rev: [35, 85] },
  fiverr:      { label: 'FIVERR ORDER', icon: 'F', rev: [15, 60] },
  assets:      { label: 'ASSET BUNDLE', icon: 'G', rev: [9, 29] },
  article:     { label: 'AFFILIATE ARTICLE', icon: 'W', rev: [3, 22] },
  saas:        { label: 'SAAS BUILD', icon: '$' },
  song:        { label: 'MUSIC TRACK', icon: 'M', rev: [0.4, 3.2] },
  publish:     { label: 'PUBLISHING RUN', icon: '^' },
  finance:     { label: 'FINANCE REPORT', icon: '=' },
  strategy:    { label: 'STRATEGY REVIEW', icon: '!' },
  pivot:       { label: 'PIVOT PLAN', icon: '>' },
  comms:       { label: 'COMMS DIGEST', icon: '@' },
  archive:     { label: 'ARCHIVE CONSOLIDATION', icon: '#' },
  directive:   { label: 'COMMANDER DIRECTIVE', icon: '*' }
};
