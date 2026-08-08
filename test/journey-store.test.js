/* node test/journey-store.test.js — durable, verified, non-gating Commander journey progression. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeJourneyStore, normalize, tierFor, evolutionFor } = require('../sidecar/journey-store.js');

function memFs() {
  const files = new Map();
  return {
    _files: files,
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, data) { files.set(String(f), String(data)); },
    renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); }, mkdirSync() {}, unlinkSync(f) { files.delete(String(f)); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
}
const writeDurable = ({ fs }, file, data) => fs.writeFileSync(file, data);
const fresh = fs => makeJourneyStore({ fs: fs || memFs(), path, workspaces: '/ws', writeDurable });

(async () => {
  A.eq(normalize(null), { v: 1, seq: 0, metrics: [], outcomes: [], mastery: [], receipts: [], goalsReached: [], suppressed: {} }, 'missing journey state hydrates safely');
  A.eq([tierFor(0), tierFor(1), tierFor(3), tierFor(7)], ['unproven', 'tested', 'practiced', 'proven'], 'mastery tiers cross only on verified outcome counts');
  A.eq(evolutionFor(['a', 'b']).name, 'ORBIT', 'station evolution is derived from distinct goals reached');
  A.eq(evolutionFor(Array.from({ length: 9 }, (_, i) => String(i))).stage, 9, 'station evolution remains uncapped across a long Commander journey');

  const fs = memFs();
  const s = fresh(fs);
  const made = await s.createMetric({ goalId: 'goal:saas', label: 'Monthly recurring revenue', unit: 'USD', baseline: 100, target: 1000 }, 10);
  A.ok(made.ok && made.metric.current === 100, 'a Commander metric starts at its explicit baseline');
  A.eq(s.snapshot({ id: 'goal:saas', text: 'Grow the SaaS', done: 1, total: 4, next: 'Find ten users' }).activeGoal.next, 'Find ten users', 'active goal context is projected without being inferred');
  A.ok((await s.updateMetric({ id: made.metric.id, current: 700, note: 'billing dashboard' }, 20)).ok, 'a current value can advance without claiming the target');
  A.eq(s.snapshot().evolution.goalsReached, 0, 'station does not evolve before the real target is reached');
  const reached = await s.updateMetric({ id: made.metric.id, current: 1000, note: 'verified in billing dashboard' }, 30);
  A.ok(reached.ok && reached.outcome && reached.outcome.verifiedBy === 'commander-client', 'reaching an explicit metric writes a provenance-bearing outcome');
  A.eq(s.snapshot().evolution.goalsReached, 0, 'a reached metric proves itself but cannot claim the whole goal complete');
  await s.updateMetric({ id: made.metric.id, current: 1200, note: 'later month' }, 40);
  A.eq(s.snapshot().outcomes.filter(o => o.kind === 'metric').length, 1, 'later updates cannot re-award the same metric target');

  const quest = n => ({ id: 'q:' + n, status: 'done', title: 'Ship build ' + n, domain: 'building', completedBy: 'builder',
    goalId: 'goal:game', contract: { type: 'artifact', key: 'game-' + n + '.zip' }, completedAt: 100 + n });
  const first = await s.recordQuest(quest(1), null, 101);
  A.ok(first.ok && first.receipt && first.receipt.tier === 'tested', 'first verified domain outcome creates a visible tested receipt');
  A.eq(first.outcome.verifiedBy, 'harness-contract', 'mechanical quest completion names harness authority');
  const duplicate = await s.recordQuest(quest(1), null, 102);
  A.ok(duplicate.duplicate, 'replayed quest completion is idempotent');
  for (let n = 2; n <= 7; n++) await s.recordQuest(quest(n), null, 100 + n);
  const mastery = s.snapshot().mastery.find(m => m.agentId === 'builder' && m.domain === 'building');
  A.eq([mastery.count, mastery.tier], [7, 'proven'], 'seven distinct verified outcomes reach proven mastery exactly once');
  A.eq(s.snapshot().receipts.filter(r => r.agentId === 'builder').map(r => r.tier), ['tested', 'practiced', 'proven'], 'receipts explain each actual adaptation threshold');

  const attest = { id: 'q:attest', status: 'done', title: 'Interview five users', domain: 'research', agentId: 'scout',
    contract: { type: 'attest', key: '' }, attest: { agentId: 'scout', evidence: 'Commander confirmed five interview notes', confirmed: true } };
  const attested = await s.recordQuest(attest, null, 200);
  A.eq(attested.outcome.verifiedBy, 'commander-confirmed', 'real-world attest mastery cannot claim harness authority');
  A.ok((await s.recordQuest({ id: 'q:bare-claim', status: 'done', title: 'Bare claim', contract: { type: 'attest', key: '' } }, null, 201)).ok === false, 'an attest without Commander-confirmed evidence cannot enter the journey ledger');

  A.ok(/building: 7 verified outcomes/.test(s.adaptationBlock('builder')), 'prompt adaptation names only verified mastery evidence');
  await s.setSuppressed('builder', 'building', true, 300);
  A.eq(s.adaptationBlock('builder'), '', 'Commander correction immediately removes that planning prior');
  A.ok(s.snapshot().receipts.filter(r => r.agentId === 'builder').every(r => r.dismissedAt === 300), 'suppression is visible on its receipts');
  await s.setSuppressed('builder', 'building', false, 301);
  A.ok(/building: 7 verified outcomes/.test(s.adaptationBlock('builder')), 'Commander can resume the corrected track');

  const milestone = { goalId: 'goal:game', milestoneId: 'm:launch', milestoneText: 'Launch the playable game', evidence: 'Release build linked in the task', agentId: 'builder', domain: 'building', goalDone: true };
  A.ok((await s.recordMilestone(milestone, 400)).ok, 'a proven final milestone completes its goal');
  A.ok((await s.recordMilestone(milestone, 401)).duplicate, 'milestone replay cannot evolve the station twice');
  A.eq(s.snapshot().evolution.goalsReached, 1, 'one final verified goal milestone produces one evolution beacon');

  const saasDone = { goalId: 'goal:saas', milestoneId: 'm:finish', milestoneText: 'Reach the SaaS goal', evidence: 'Final goal arc milestone verified', agentId: 'builder', domain: 'growth', goalDone: true };
  await s.recordMilestone(saasDone, 410);
  A.eq(s.snapshot().evolution.goalsReached, 2, 'two distinct final goal milestones produce two evolution beacons');

  const restarted = fresh(fs);
  A.eq(restarted.snapshot().evolution.goalsReached, 2, 'metrics, mastery, receipts, and evolution survive process restart');
  A.eq(restarted.snapshot().mastery.find(m => m.agentId === 'builder').count, 8, 'restart preserves the exact verified mastery count');
  A.eq(Object.keys(restarted.snapshot()).includes('capabilities'), false, 'journey state has no capability/unlock field by construction');
  await restarted.reset();
  A.eq(restarted.snapshot().evolution.goalsReached, 0, 'a new Commander can start with a truly clean journey');

  A.report('journey-store.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
