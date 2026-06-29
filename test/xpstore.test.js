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

focused = researcher;
for (let i = 1; i <= 4; i++) done('agent', i);
for (let i = 1; i <= 3; i++) approve('agent', i);

A.eq(overseer.stats.level, 2, 'overseer still levels from overseer feedback events');
A.eq(researcher.stats.level, 2, 'overseer events do not mutate researcher');
A.ok(world.pulse.some(p => p.agentId === 'agent' && p.level === 2), 'overseer pulse still works when addressed');
A.eq((XpStore.stationStats().counters || {}).tasksDone, 8, 'station rollup still includes all agents tasks');
A.eq((XpStore.stationStats().counters || {}).positiveFeedback, 6, 'station rollup includes all agents positive feedback');

A.report('xpstore.test');
