/* node test/xpstore.test.js - browser XP wiring for multi-agent level-up ownership.
   Locks the bug where a summoned worker's level-up was credited and animated on the overseer because
   XpStore read the focused agent instead of the event payload's agentId. Also locks the satisfaction-XP
   rule: run completions update counters, but positive user feedback drives XP and levels. */
'use strict';
const A = require('./_assert.js');

global.Xp = require('../frontend/app/xp.js');
const bus = A.makeBus();
global.U = { bus };
global.document = { getElementById: () => null };

const world = { setXp: [], pulse: [] };
global.World = {
  setXp(agentId, xp) { world.setXp.push({ agentId, xp }); },
  pulseLevelUp(agentId, level) { world.pulse.push({ agentId, level }); }
};

const notices = [];
global.StationUI = { notify: (text, kind) => notices.push({ text, kind }) };
let sfx = 0;
global.SFX = { level: () => { sfx++; } };
global.Tutorial = { onLevelUp: () => {} };

const { XpStore } = require('../frontend/app/xpstore.js');

const overseer = { id: 'agent', name: 'OVERSEER' };
const researcher = { id: 'researcher', name: 'RESEARCHER' };
const agents = new Map([['agent', overseer], ['researcher', researcher]]);
let focused = overseer;
let persists = 0;

XpStore.init({
  getAgent: (id) => agents.get(id || (focused && focused.id) || 'agent') || null,
  station: Xp.fresh(),
  persist: () => { persists++; }
});

function done(agentId, n) {
  bus.emit('agent.run.end', { agentId, runId: agentId + '-' + n, reason: 'done' });
}
function approve(agentId, n) {
  bus.emit('memory.feedback', { agentId, id: agentId + '-fb-' + n, delta: 2, reason: 'kept' });
}
function reject(agentId, n) {
  bus.emit('memory.feedback', { agentId, id: agentId + '-bad-' + n, delta: -1, reason: 'discarded' });
}
function notebookRating(agentId, n, rating, delta) {
  bus.emit('memory.feedback', { agentId, id: agentId + '-note-' + n, delta, reason: rating });
}

for (let i = 1; i <= 4; i++) done('researcher', i);

A.eq(overseer.stats.level, 1, 'researcher runs do not level the overseer');
A.eq(researcher.stats.level, 1, 'run completions alone do not level the researcher');
A.eq(researcher.stats.xp, 0, 'run completions alone award no xp');
A.eq(researcher.stats.counters.tasksDone, 4, 'run completions still update researcher task counters');
A.eq(world.pulse.length, 0, 'no level pulse fires from run completions alone');

for (let i = 1; i <= 3; i++) approve('researcher', i);

A.eq(overseer.stats.level, 1, 'researcher feedback does not level the overseer');
A.eq(researcher.stats.level, 2, 'researcher owns its feedback-driven level-up stats');
A.eq(researcher.stats.counters.positiveFeedback, 3, 'researcher records positive feedback receipts');
A.eq(world.pulse, [{ agentId: 'researcher', level: 2 }], 'level-up pulse is addressed to the researcher');
A.ok(!world.pulse.some(p => p.agentId === 'agent'), 'no overseer pulse fires for a researcher level-up');
A.ok(notices.some(n => /RESEARCHER reached Level 2/.test(n.text)), 'toast names the researcher');
A.ok(!notices.some(n => /OVERSEER reached Level 2/.test(n.text)), 'toast does not name the overseer');
A.ok(world.setXp.some(x => x.agentId === 'researcher' && x.xp && x.xp.level === 2), 'world XP snapshot is stored under researcher');
A.ok(!world.setXp.some(x => x.agentId === 'agent' && x.xp && x.xp.level === 2), 'researcher XP snapshot is not stored under overseer');
A.eq(sfx, 1, 'agent level-up sound fires once');
A.ok(persists >= 1, 'level-up persists the owning agent stats');

const beforeRejectXp = researcher.stats.xp;
const beforeRejectPersists = persists;
reject('researcher', 1);
A.eq(researcher.stats.xp, beforeRejectXp, 'negative feedback does not subtract xp');
A.eq(researcher.stats.counters.negativeFeedback, 1, 'negative feedback is recorded on the owning agent');
A.ok(persists > beforeRejectPersists, 'negative feedback persists even without a level-up');

const beforeNotebook = {
  xp: researcher.stats.xp,
  samples: researcher.stats.samples,
  positive: researcher.stats.counters.positiveFeedback,
  negative: researcher.stats.counters.negativeFeedback,
  persists,
};
notebookRating('researcher', 1, 'helpful', 2);
notebookRating('researcher', 2, 'unhelpful', -1);
A.eq(researcher.stats.xp, beforeNotebook.xp, 'notebook ratings do not award or subtract XP');
A.eq(researcher.stats.samples, beforeNotebook.samples, 'notebook ratings do not calibrate satisfaction');
A.eq(researcher.stats.counters.positiveFeedback, beforeNotebook.positive, 'notebook helpful is not a user approval receipt');
A.eq(researcher.stats.counters.negativeFeedback, beforeNotebook.negative, 'notebook unhelpful is not a user rejection receipt');
A.eq(persists, beforeNotebook.persists, 'notebook ratings do not persist unchanged XP stats');

focused = researcher;
for (let i = 1; i <= 4; i++) done('agent', i);
for (let i = 1; i <= 3; i++) approve('agent', i);

A.eq(overseer.stats.level, 2, 'overseer still levels from overseer feedback events');
A.eq(researcher.stats.level, 2, 'overseer events do not mutate researcher');
A.ok(world.pulse.some(p => p.agentId === 'agent' && p.level === 2), 'overseer pulse still works when addressed');
A.eq((XpStore.stationStats().counters || {}).tasksDone, 8, 'station rollup still includes all agents tasks');
A.eq((XpStore.stationStats().counters || {}).positiveFeedback, 6, 'station rollup includes all agents positive feedback');

/* ---- S4: the boot-time TROPHY RECONCILE + honest announce copy ----
   A save written before a badge existed holds the record that earns it and none of the credit. Without the
   reconcile the trophy case renders that badge LOCKED, with an unlock hint the dossier above it has visibly
   already met — the app contradicting its own state. It must run for EVERY agent (a specialist's case is not
   the hero's), it must reach the station rollup, and it must stay SILENT: these are past facts being
   recognized, not moments happening now. */
const broadcasts = [];
global.Chat = { broadcast: (text, opts) => broadcasts.push({ text, opts }) };

// two mid-curve saves that predate S4's badges: 8 shipped tasks + 30 successful tool calls, nothing lit.
const mkLegacy = (id, name) => ({ id, name, stats: { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: { tasksDone: 8, runs: 9, toolsOk: 30 }, milestones: [] } });
const oldHero = mkLegacy('agent', 'OVERSEER');
const oldSpec = mkLegacy('scribe', 'SCRIBE');
const oldRoster = new Map([['agent', oldHero], ['scribe', oldSpec]]);
const noticesBefore = notices.length, sfxBefore = sfx;

XpStore.init({
  getAgent: (id) => oldRoster.get(id || 'agent') || null,
  agents: () => Array.from(oldRoster.values()),
  station: { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: { tasksDone: 40, runs: 42, toolsOk: 120 }, milestones: [] },
  persist: () => { persists++; }
});

A.ok(oldHero.stats.milestones.indexOf('still_here') !== -1, 'boot lights the badge the hero had already earned (8 tasks)');
A.ok(oldHero.stats.milestones.indexOf('hands_on') !== -1, 'boot lights HANDS ON off the tool-call record it already had');
A.eq(oldHero.stats.milestones.indexOf('workhorse'), -1, 'boot lights only what was EARNED — 8 tasks is not 25');
A.ok(oldSpec.stats.milestones.indexOf('still_here') !== -1, 'a SPECIALIST case is reconciled too, not just the hero');
A.ok((XpStore.stationStats().milestones || []).indexOf('workhorse') !== -1, 'the station rollup is reconciled off its own record (40 tasks)');
A.eq(oldHero.stats.xp, 0, 'the backfill mints no XP');
A.eq(notices.length, noticesBefore, 'the backfill is SILENT — no gold toast for work done weeks ago');
A.eq(broadcasts.length, 0, '…and no TROPHY EARNED broadcast burst at boot');
A.eq(sfx, sfxBefore, '…and no sting');

// a badge earned LIVE still announces — and now as a sentence + its real trophy-case label, never a raw slug.
// (ARCHIVIST/WORKHORSE/NIGHT SHIFT/VETERAN used to fall through to "Milestone — night_shift".)
bus.emit('workitem.delivered', { agentId: 'agent', workitemId: 'w1', finalQueueId: 'q1' });
A.ok(oldHero.stats.milestones.indexOf('night_shift') !== -1, 'a real delivery still earns NIGHT SHIFT live');
A.ok(notices.some(n => n.text === 'Milestone — first external delivery'), 'the live toast reads as a sentence, not a slug');
A.ok(broadcasts.some(b => b.text === 'TROPHY EARNED · NIGHT SHIFT'), 'the broadcast shouts the trophy-case label');
A.ok(!notices.some(n => /night_shift/.test(n.text)) && !broadcasts.some(b => /night_shift/.test(b.text)), 'no raw slug reaches the Commander');
// the label comes from the xp.js catalogue, so a badge added there can never announce as an id.
A.ok(Xp.MILESTONES.every(m => broadcasts.every(b => !b.text.includes('_'))), 'every announced name is a real label');

A.report('xpstore.test');
