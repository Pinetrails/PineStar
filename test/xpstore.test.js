/* node test/xpstore.test.js - browser XP wiring for multi-agent level-up ownership.
   Locks the bug where a summoned worker's level-up was credited and animated on the overseer because
   XpStore read the focused agent instead of the event payload's agentId. */
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

for (let i = 1; i <= 4; i++) done('researcher', i);

A.eq(overseer.stats.level, 1, 'researcher runs do not level the overseer');
A.eq(researcher.stats.level, 2, 'researcher owns its level-up stats');
A.eq(world.pulse, [{ agentId: 'researcher', level: 2 }], 'level-up pulse is addressed to the researcher');
A.ok(!world.pulse.some(p => p.agentId === 'agent'), 'no overseer pulse fires for a researcher level-up');
A.ok(notices.some(n => /RESEARCHER reached Level 2/.test(n.text)), 'toast names the researcher');
A.ok(!notices.some(n => /OVERSEER reached Level 2/.test(n.text)), 'toast does not name the overseer');
A.ok(world.setXp.some(x => x.agentId === 'researcher' && x.xp && x.xp.level === 2), 'world XP snapshot is stored under researcher');
A.ok(!world.setXp.some(x => x.agentId === 'agent' && x.xp && x.xp.level === 2), 'researcher XP snapshot is not stored under overseer');
A.eq(sfx, 1, 'agent level-up sound fires once');
A.ok(persists >= 1, 'level-up persists the owning agent stats');

focused = researcher;
for (let i = 1; i <= 4; i++) done('agent', i);

A.eq(overseer.stats.level, 2, 'overseer still levels from overseer events');
A.eq(researcher.stats.level, 2, 'overseer events do not mutate researcher');
A.ok(world.pulse.some(p => p.agentId === 'agent' && p.level === 2), 'overseer pulse still works when addressed');
A.eq((XpStore.stationStats().counters || {}).tasksDone, 8, 'station rollup still includes all agents');

A.report('xpstore.test');
