'use strict';

const A = require('./_assert.js');
const { makeRunExecutionState } = require('../sidecar/run-execution-state.js');

const observed = [];
const state = makeRunExecutionState({
  initialTaint: 'scheduled input',
  artifacts: { observe: value => observed.push(value), list: () => observed.slice() }
});

A.eq(state.taintedBy(), 'scheduled input', 'initial taint is explicit');
A.eq(state.latchTaint('later source'), 'scheduled input', 'taint latches the first source');
A.ok(!state.repeated('same', 1), 'new calls are not repeat-blocked');
state.recordResult('same', { isError: true }, false);
A.ok(!state.repeated('same', 1), 'one failure is within a maxRepeat of one');
state.recordResult('same', { isError: true }, false);
A.ok(state.repeated('same', 1), 'the next identical failure is blocked');
state.recordResult('same', { ok: true }, false);
A.ok(!state.repeated('same', 1), 'success clears the failure streak');
A.eq(state.toolsOk(), 1, 'successful real tools count as completed work');
state.recordResult('brief', { ok: true }, true);
A.eq(state.toolsOk(), 1, 'internal bookkeeping does not count as completed work');

let bounded = state.boundToolResult({ content: '1234' }, 6);
A.eq(bounded.content, '1234', 'output within the budget is unchanged');
bounded = state.boundToolResult({ content: '5678' }, 6);
A.ok(bounded.content.startsWith('56\n…[truncated'), 'crossing the budget truncates at the remaining payload bytes');
A.ok(state.toolBytes() > 6, 'the accounting includes the visible truncation marker');
bounded = state.boundToolResult({ content: 'later' }, 6);
A.ok(bounded.content.startsWith('[tool output omitted'), 'later output is replaced after exhaustion');
state.resetToolBytes();
A.eq(state.toolBytes(), 0, 'compaction can reset the output budget');

A.eq(state.checkpointTurn(), 0, 'checkpoint sequence starts at zero');
A.eq(state.advanceCheckpoint(), 1, 'checkpoint sequence advances explicitly');
A.ok(!state.journalStarted(), 'journal starts false');
state.startJournal();
A.ok(state.journalStarted(), 'journal start latches true');
state.observeArtifact({ toolName: 'fs.write' });
A.eq(state.artifactList(), [{ toolName: 'fs.write' }], 'artifact collector is owned by the run state');

A.ok(state.consumeToolCall(2), 'first task-bounded tool call is admitted');
A.ok(state.consumeToolCall(2), 'second task-bounded tool call is admitted');
A.ok(!state.consumeToolCall(2), 'task-bounded tool calls stop at the exact cap');
A.eq(state.toolCallsStarted(), 2, 'tool-call budget counter is owned by the run state');
state.observeToolEvent('agent.tool_call', { callId: 'call-1', name: 'web_fetch' }, 100);
state.observeToolEvent('agent.tool_result', { callId: 'call-1', ok: false, isError: true, ms: 25, summary: 'x'.repeat(300) }, 125);
const trace = state.toolTraceList();
A.eq(trace[0].name, 'web_fetch', 'tool timing records the actual tool name');
A.eq(trace[0].ms, 25, 'tool timing records measured milliseconds');
A.eq(trace[0].endedAt, 125, 'tool timing derives a stable end time from the measured duration');
A.ok(trace[0].summary.length <= 240, 'tool timing summaries are bounded');
trace[0].name = 'mutated';
A.eq(state.toolTraceList()[0].name, 'web_fetch', 'tool timing snapshots cannot mutate run state');
const clocked = makeRunExecutionState({ now: () => 777 });
clocked.observeToolEvent('agent.tool_call', { callId: 'clocked', name: 'verify.run' });
A.eq(clocked.toolTraceList()[0].startedAt, 777, 'tool timing uses the injected run clock');

const clean = makeRunExecutionState();
A.eq(clean.latchTaint('browser.read'), 'browser.read', 'first runtime taint is retained');
A.eq(clean.artifactList(), [], 'missing artifact collector safely produces an empty list');

A.report('run-execution-state.test');
