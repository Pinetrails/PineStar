/* node test/quests.test.js — the pure quest-skin engine (frontend/app/quests.js).
   Locks the projection: a pending idea is the first (open) quest; blank dossier dims are open, known are done;
   unearned milestones are open (with their hint), earned are done; ALL open quests precede done; every quest
   names a real reward; honest counts. Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const Q = require('../frontend/app/quests.js');

/* ---------- defensive ---------- */
A.eq(Q.build({}), [], 'no inputs → no quests');
A.eq(Q.build(), [], 'undefined input → no quests, never throws');
A.eq(Q.summary(null), { open: 0, done: 0, total: 0 }, 'summary of nothing is all-zero');

const dims = [
  { key: 'identity', label: 'Identity', known: true },
  { key: 'stack', label: 'Stack & tools', known: false },
  { key: 'goals', label: 'Goals', known: true }
];
const ms = [
  { id: 'first_light', label: 'FIRST LIGHT', hint: 'ship 1 task', earned: true },
  { id: 'pack_rat', label: 'PACK RAT', hint: 'reuse a memory', earned: false }
];
const list = Q.build({ milestones: ms, dossierDims: dims, pendingIdea: true });

/* ---------- the idea is the first, most-actionable quest ---------- */
A.eq(list[0].kind, 'idea', 'a pending idea is the first quest');
A.eq(list[0].status, 'open', 'the idea quest is open');

/* ---------- open before done ---------- */
const statuses = list.map(q => q.status);
A.eq(statuses.indexOf('done') > statuses.lastIndexOf('open'), true, 'all open quests come before all done quests');

/* ---------- dossier dims: blank → open, known → done ---------- */
const stackQ = list.find(q => q.id === 'dim:stack');
A.eq(stackQ.status, 'open', 'a blank dossier dimension is an open quest');
A.ok(/stack & tools/i.test(stackQ.title), 'the dossier quest names the dimension');
A.eq(list.find(q => q.id === 'dim:identity').status, 'done', 'a known dimension is a done quest');

/* ---------- milestones: earned → done, unearned → open (with the how-to) ---------- */
A.eq(list.find(q => q.id === 'ms:first_light').status, 'done', 'an earned milestone is done');
const packRat = list.find(q => q.id === 'ms:pack_rat');
A.eq(packRat.status, 'open', 'an unearned milestone is open');
A.ok(/reuse a memory/.test(packRat.desc), 'an open milestone shows how to earn it');

/* ---------- honest rewards (real outcomes, never a fake currency) ---------- */
A.ok(list.every(q => typeof q.reward === 'string' && q.reward.length > 0), 'every quest names a real reward');
A.ok(!list.some(q => /\bXP\b|points|coins|gold/i.test(q.reward)), 'no quest rewards a fake currency');

/* ---------- no pending idea → no idea quest ---------- */
A.eq(Q.build({ milestones: ms, dossierDims: dims, pendingIdea: false }).some(q => q.kind === 'idea'), false, 'no idea quest when none is pending');

/* ---------- summary counts ---------- */
const sum = Q.summary(list);
A.eq(sum.total, list.length, 'summary total matches the list');
A.eq(sum.open + sum.done, sum.total, 'open + done = total');
A.eq(sum.open, 3, 'three open quests (idea + stack + pack_rat)');
A.eq(sum.done, 3, 'three done quests (identity + goals + first_light)');

/* ---------- malformed entries are skipped, never crash; a key-only dim falls back to the key ---------- */
const malformed = Q.build({ milestones: [null, { id: '' }], dossierDims: [{ key: 'x' }, null, {}] });
A.eq(malformed.length, 1, 'null/empty entries are skipped; only the key-only dim yields a quest');
A.eq(malformed[0].id, 'dim:x', 'a dim with a key but no label still makes a quest (key as the label)');

/* ---------- deterministic ---------- */
A.eq(JSON.stringify(Q.build({ milestones: ms, dossierDims: dims, pendingIdea: true })), JSON.stringify(list), 'build is deterministic for the same input');

A.report('quests.test');
