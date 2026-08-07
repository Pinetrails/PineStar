'use strict';
const A = require('./_assert');
const { makeRunJournal } = require('../sidecar/run-journal');
const Recovery = require('../sidecar/run-recovery');

function memoryIo() {
  const files = new Map();
  return {
    create(id, line) { if (files.has(id)) throw new Error('exists'); files.set(id, line + '\n'); },
    append(id, line) { if (!files.has(id)) throw new Error('missing'); files.set(id, files.get(id) + line + '\n'); },
    read(id) { return files.get(id); }, list() { return Array.from(files.keys()); },
    readFile(id) { return files.get(id); }, remove(id) { files.delete(id); }, files
  };
}

let now = 10;
const io = memoryIo();
const journal = makeRunJournal({ io, clock: { now: () => ++now } });
const argsRaw = '{"delta":1,"label":"once"}';
const fingerprint = Recovery.replayFingerprint('fixture.increment', argsRaw);
journal.begin({ runId: 'crashed', agentId: 'agent', streamId: 'global', model: 'fixture/model' });
journal.checkpoint('crashed', { phase: 'initial', turn: 0, messages: [
  { role: 'system', content: 'fixture system' }, { role: 'user', content: 'increment exactly once' }
] });
journal.checkpoint('crashed', { phase: 'assistant', turn: 1, messages: [{
  role: 'assistant', content: '', tool_calls: [{ id: 'call-once', type: 'function', function: { name: 'fixture_increment', arguments: argsRaw } }]
}] });
journal.toolIntent('crashed', { callId: 'call-once', name: 'fixture.increment', argsRaw, replayFingerprint: fingerprint, mutating: true });

let counter = 0;
counter++; // deterministic side effect happened, then the process died before tool_result could be journaled.
let recovered = journal.inspect('crashed');
A.eq(recovered.status, 'needs_review', 'crash after mutation and before result requires operator review');
journal.resolve('crashed', {
  resolutionId: 'resolution-once', operator: 'local',
  outcomes: [{ callId: 'call-once', outcome: 'happened' }]
});
recovered = journal.inspect('crashed');
const plan = Recovery.continuationPlan(recovered);
A.eq(plan.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'system'], 'continuation pairs the outstanding provider tool call before adding operator context');
A.ok(/verified.*happened/i.test(plan.messages[3].content), 'the provider sees the explicit verified outcome as its tool result');
A.ok(/no reviewed mutating call/i.test(plan.messages[4].content), 'the provider receives the explicit durable no-replay continuation context');
A.eq(plan.blockedFingerprints, [fingerprint], 'the host plan carries the reviewed mutation fingerprint');

const barrier = Recovery.makeReplayBarrier(plan.blockedFingerprints);
const replay = barrier.check('fixture.increment', '{"label":"once","delta":1}', true);
A.eq(replay.ok, false, 'canonical argument ordering cannot evade the replay barrier');
if (replay.ok) counter++;
A.eq(counter, 1, 'the reviewed mutation occurred exactly once across crash, review, and attempted resume replay');
A.eq(barrier.check('fixture.increment', '{"delta":2,"label":"different"}', true).ok, true, 'a genuinely different follow-up mutation is not mistaken for replay');

const ready = journal.prepareContinuation('crashed', {
  continuationId: 'continue-once', operator: 'local', blockedFingerprints: plan.blockedFingerprints,
  context: plan.context
});
A.eq(ready.continuation.state, 'ready', 'continuation intent is durable before any provider call');
A.eq(journal.prepareContinuation('crashed', {
  continuationId: 'continue-once', operator: 'local', blockedFingerprints: plan.blockedFingerprints,
  context: plan.context
}).records, ready.records, 'retrying continuation preparation is idempotent');
journal.startContinuation('crashed', { continuationId: 'continue-once', continuedRunId: 'continued-run' });
journal.finishContinuation('crashed', { continuationId: 'continue-once', continuedRunId: 'continued-run', reason: 'done' });
const secondBoot = makeRunJournal({ io, clock: { now: () => ++now } }).recoverAll()[0];
A.eq(secondBoot.continuation.state, 'finished', 'a second reboot preserves completed continuation state');
A.eq(secondBoot.continuation.continuedRunId, 'continued-run', 'the durable audit links the original and continued runs');

const unknownIo = memoryIo();
const unknown = makeRunJournal({ io: unknownIo, clock: { now: () => ++now } });
unknown.begin({ runId: 'unknown-run', agentId: 'agent' });
unknown.checkpoint('unknown-run', { phase: 'assistant', messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'u1', type: 'function', function: { name: 'fixture_increment', arguments: '{"delta":1}' } }] }] });
unknown.toolIntent('unknown-run', { callId: 'u1', name: 'fixture.increment', argsRaw: '{"delta":1}', replayFingerprint: Recovery.replayFingerprint('fixture.increment', '{"delta":1}'), mutating: true });
unknown.resolve('unknown-run', { resolutionId: 'resolution-unknown', outcomes: [{ callId: 'u1', outcome: 'unknown' }] });
A.throws(() => Recovery.continuationPlan(unknown.inspect('unknown-run')), 'an unknown operator outcome cannot continue');

A.report('run-recovery-continuation.test');
