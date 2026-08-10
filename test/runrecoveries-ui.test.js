'use strict';
const A = require('./_assert');
const R = require('../frontend/app/runrecoveries');

const row = R.normalizeRecovery({
  runId: 'run-1', agentId: 'owned-agent', status: 'needs_review', recoveryToken: 'snapshot-token', canResolve: true,
  cronJobName: 'Morning sync', uncertain: [
    { callId: 'call-a', name: 'connector.update', args: { secret: 'must not be consumed' } },
    { callId: 'call-b', name: 'fs.write' }
  ], checkpoint: { messages: [{ role: 'assistant', content: 'working' }] }
});
A.eq(row.title, 'Morning sync', 'the operator sees the human run title');
A.eq(row.uncertain, [{ callId: 'call-a', name: 'connector.update' }, { callId: 'call-b', name: 'fs.write' }], 'the UI model consumes only bounded call identity, never arguments');
A.throws(() => R.makeResolutionPayload(row, { 'call-a': 'happened' }, '', true, 'resolution-1'), 'every uncertain call needs an outcome');
A.throws(() => R.makeResolutionPayload(row, { 'call-a': 'happened', 'call-b': 'unknown' }, '', false, 'resolution-1'), 'the UI requires explicit no-replay consent');
const payload = R.makeResolutionPayload(row, { 'call-a': 'happened', 'call-b': 'unknown' }, 'checked audit log', true, 'resolution-1');
A.eq(payload.confirmedNoReplay, true, 'the POST carries explicit no-replay consent');
A.eq(payload.outcomes, [{ callId: 'call-a', outcome: 'happened' }, { callId: 'call-b', outcome: 'unknown' }], 'the POST accounts for calls in the server snapshot order');
A.eq(payload.recoveryToken, 'snapshot-token', 'the POST is bound to the inspected recovery snapshot');
const resolved = R.normalizeRecovery({
  runId: 'run-1', agentId: 'owned-agent', streamId: 'stream-1', status: 'resolved', recoveryToken: 'resolved-token', canContinue: true,
  uncertain: [{ callId: 'call-a', name: 'connector.update' }],
  resolution: { outcomes: [{ callId: 'call-a', outcome: 'happened' }] }
});
const continuation = R.makeContinuationPayload(resolved, true, 'continuation-1');
A.eq(continuation, {
  runId: 'run-1', agentId: 'owned-agent', recoveryToken: 'resolved-token', continuationId: 'continuation-1', confirmedSafeContinuation: true
}, 'safe continuation carries explicit consent and is bound to the resolved snapshot');
A.throws(() => R.makeContinuationPayload(Object.assign({}, resolved, { resolution: { outcomes: [{ callId: 'call-a', outcome: 'unknown' }] } }), true, 'continuation-1'), 'unknown outcomes cannot continue');
A.eq(R.visibleRecoveries([
  Object.assign({}, resolved, { continuation: { state: 'finished', continuedRunId: 'run-2', reason: 'done' } })
]).length, 1, 'finished recovery linkage remains visible instead of disappearing after continuation');
A.ok(/harness\.chat\s*\(\{/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'runrecoveries.js'), 'utf8')), 'the recovery UI resumes only through the ordinary harness run host');
A.report('runrecoveries-ui.test');
