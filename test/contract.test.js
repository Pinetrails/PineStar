/* node test/contract.test.js — the U.bus event contract + emitter behavior. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');

// 1. registry sanity
A.ok(events.names().length > 10, 'registry has the full event set');
A.ok(events.isKnown('agent.run.start'), 'knows agent.run.start');
A.ok(events.isKnown('agent.tool_call'), 'tool_call frozen up front');
A.ok(events.isKnown('agent.tool_result'), 'tool_result frozen up front');
A.ok(events.isKnown('budget.threshold'), 'budget event frozen up front');
A.ok(!events.isKnown('nope.nope'), 'rejects unknown name');
A.eq(events.SCHEMA_VERSION, 1, 'schema version is 1');

// the registry is frozen (immutable)
A.throws(() => { 'use strict'; events.EVENTS['hacked'] = {}; }, 'EVENTS is frozen (no new keys)');

// 2. valid vs invalid payloads for representative events
const cases = [
  ['agent.run.start', { agentId: 'a', runId: 'r', trigger: 'directive', model: 'm' }, { agentId: 'a', runId: 'r', trigger: 'nope', model: 'm' }],
  ['agent.token', { agentId: 'a', runId: 'r', delta: 'hi' }, { agentId: 'a', runId: 'r', delta: 5 }],
  ['agent.tool_call', { agentId: 'a', runId: 'r', callId: 'c1', name: 'notebook.write' }, { agentId: 'a', runId: 'r', name: 'x' }],
  ['agent.tool_result', { agentId: 'a', runId: 'r', callId: 'c1', ok: true, isError: false }, { agentId: 'a', runId: 'r', callId: 'c1', ok: 'yes', isError: false }],
  ['tool.args.repaired', { agentId: 'a', runId: 'r', callId: 'c1', name: 'fs_write', before: '{', after: '{}' }, { agentId: 'a', runId: 'r', callId: 'c1' }],
  ['agent.cost', { agentId: 'a', runId: 'r', usd: 0.1, reconciled: true }, { agentId: 'a', runId: 'r', usd: 0.1, reconciled: false }],
  ['agent.run.end', { agentId: 'a', runId: 'r', reason: 'done', turns: 2, usd: 0.2 }, { agentId: 'a', runId: 'r', reason: 'whoops', turns: 2, usd: 0.2 }],
  ['provider.fallback', { agentId: 'a', runId: 'r', fromModel: 'm1', toModel: 'm2', reason: 'rate_limit', rotate: true }, { agentId: 'a', runId: 'r', fromModel: 'm1', toModel: 'm2' }],
  ['budget.threshold', { scope: 'run', usd: 1, cap: 5 }, { scope: 'weekly', usd: 1, cap: 5 }],
  ['permission.response', { promptId: 'p', decision: 'full' }, { promptId: 'p', decision: 'maybe' }],
  ['memory.recall', { agentId: 'a', runId: 'r', count: 3, chars: 120 }, { agentId: 'a', runId: 'r', count: 'three' }],
  ['memory.write', { agentId: 'a', runId: 'r', id: 'mem_1', kind: 'note', scope: 'global' }, { agentId: 'a', runId: 'r', id: 'mem_1' }],
  ['memory.forget', { agentId: 'a', id: 'mem_1', reason: 'discarded' }, { agentId: 'a', reason: 'discarded' }],
  ['agent.compact', { agentId: 'a', runId: 'r', beforeTokens: 9000, afterTokens: 3000, removed: 12, reason: 'overflow' }, { agentId: 'a', runId: 'r', beforeTokens: 'lots' }],
  ['memory.proposed', { agentId: 'a', runId: 'r', id: 'mem_2', kind: 'learned', scope: 'agent' }, { agentId: 'a', runId: 'r', id: 'mem_2' }],
  ['memory.used', { agentId: 'a', runId: 'r', id: 'mem_1' }, { agentId: 'a', runId: 'r' }],
  ['memory.feedback', { agentId: 'a', id: 'mem_1', delta: -0.1, reason: 'discarded' }, { agentId: 'a', id: 'mem_1', delta: 'down' }],
  ['channel.inbound', { channel: 'telegram', chatId: 'c', agentId: 'tg_c', userId: 'u', kind: 'dm' }, { channel: 'telegram', chatId: 'c', agentId: 'tg_c', kind: 'sms' }],
  ['channel.delivery', { channel: 'telegram', chatId: 'c', runId: 'r', ok: true, chunks: 2, reason: 'done' }, { channel: 'telegram', chatId: 'c', runId: 'r', ok: 'yes' }],
  ['channel.connect', { channel: 'telegram', state: 'up' }, { channel: 'telegram', state: 'flapping' }],
  ['cron.tick', { fired: 1, skipped: 0, planned: 2 }, { fired: 'one', skipped: 0 }],
  ['cron.fire', { jobId: 'j1', runId: 'r', scheduledFor: 1700000000000 }, { jobId: 'j1' }],
  ['cron.skipped', { jobId: 'j1', reason: 'already-running' }, { jobId: 'j1', reason: 'because' }],
  ['cron.result', { jobId: 'j1', runId: 'r', outcome: 'ok', reason: 'done' }, { jobId: 'j1', runId: 'r', outcome: 'maybe' }],
  ['checkpoint.created', { agentId: 'a', runId: 'r', turn: 2, snapshotId: 's1', files: 3, bytes: 900 }, { agentId: 'a', runId: 'r', snapshotId: 's1' }],
  ['checkpoint.restored', { agentId: 'a', runId: 'r', toSnapshotId: 's1', reason: 'rewind' }, { agentId: 'a', runId: 'r' }],
  ['shell.exec', { agentId: 'a', runId: 'r', callId: 'c1', cmdSummary: 'npm test', cwd: '/w', exitCode: 0, ms: 12, truncated: false }, { agentId: 'a', runId: 'r', callId: 'c1', exitCode: 'zero' }],
  ['shell.bg.exit', { agentId: 'a', bgId: 'bg_1', exitCode: 0, ms: 4200, killed: false }, { agentId: 'a', bgId: 'bg_1', exitCode: 'done' }],
  ['verify.result', { agentId: 'a', runId: 'r', tool: 'tsserver', passed: true, added: 0, removed: 1, summary: 'clean' }, { agentId: 'a', runId: 'r', passed: 'yes' }],
  ['notify', 'a station log line', 123],
  ['task', { id: 't1', status: 'running' }, { id: 't1', status: 'invented' }],
];
for (const [name, good, badp] of cases) {
  A.ok(events.validate(name, good).ok, 'valid ' + name);
  A.ok(!events.validate(name, badp).ok, 'invalid ' + name + ' rejected');
}
A.ok(!events.validate('agent.run.start', { agentId: 'a' }).ok, 'missing required fields rejected');
A.ok(!events.validate('definitely.unknown', {}).ok, 'unknown event name rejected');

// 3. emitter: a valid emit reaches the bus, logs nothing
const bus = A.makeBus();
const seen = A.collectBus(bus, events.names());
const logs = [];
const emit = makeEmitter(bus, e => logs.push(e));

A.eq(emit('agent.token', { agentId: 'a', runId: 'r', delta: 'x' }), true, 'valid emit returns true');
A.eq(seen.length, 1, 'bus saw exactly one event');
A.eq(seen[0].name, 'agent.token', 'bus saw the right event');
A.eq(logs.length, 0, 'no warnings for a valid emit');

// 4. a malformed payload is DROPPED + logged, never reaches the bus, never throws
A.notThrows(() => emit('agent.token', { agentId: 'a', runId: 'r', delta: 5 }), 'malformed emit does not throw');
A.eq(emit('agent.token', { agentId: 'a', runId: 'r', delta: 5 }), false, 'malformed emit returns false');
A.eq(seen.length, 1, 'bus did NOT see the malformed event');
A.ok(logs.length >= 1, 'malformed emit was logged');
A.eq(logs[0].kind, 'invalid-event', 'logged as invalid-event');

// 5. an unknown event name is dropped + logged, not thrown
A.notThrows(() => emit('totally.unknown', {}), 'unknown event does not throw');
A.eq(emit('totally.unknown', {}), false, 'unknown event returns false');
A.eq(seen.length, 1, 'bus did NOT see the unknown event');

// 6. a THROWING handler does not break emit (mirrors U.bus swallow) — asserted after the run
bus.on('notify', () => { throw new Error('boom'); });
A.notThrows(() => emit('notify', 'hello'), 'a throwing handler does not propagate out of emit');
A.eq(emit('notify', 'hello again'), true, 'emit still succeeds despite a throwing handler');

A.report('contract.test');
