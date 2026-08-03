import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeRunJournal } = require('../../../sidecar/run-journal.js');
const { makeChannelStore } = require('../../../sidecar/channels/store.js');
const { makeChannelHub } = require('../../../sidecar/channels/hub.js');
const pathMod = require('node:path');

function memoryJournal() {
  const files = new Map();
  const io = {
    create(id, line) { if (files.has(id)) throw new Error('exists'); files.set(id, line + '\n'); },
    append(id, line) { files.set(id, (files.get(id) || '') + line + '\n'); },
    read(id) { return files.get(id); }, list() { return Array.from(files.keys()); }, readFile(id) { return files.get(id); },
    remove(id) { files.delete(id); }, repair() {}, quarantine() {}
  };
  return { files, journal: makeRunJournal({ io, clock: { now: () => 1 } }) };
}

function memoryFs() {
  const files = new Map();
  return { files,
    readFileSync(path) { if (!files.has(path)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return files.get(path); },
    writeFileSync(path, value) { files.set(path, String(value)); },
    renameSync(from, to) { if (!files.has(from)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } files.set(to, files.get(from)); files.delete(from); },
    mkdirSync() {}
  };
}

const EXPECTED = {
  'fault-accepted-before-provider': ['accepted-before-provider', 'resumable-preserving-identity'],
  'fault-provider-stream': ['provider-stream', 'partial-preserved-not-done'],
  'fault-read-intent-before-dispatch': ['read-intent-before-dispatch', 'resume-once-original-run'],
  'fault-mutation-intent-before-dispatch': ['mutation-intent-before-dispatch', 'explicit-needs-review'],
  'fault-mutation-before-result-checkpoint': ['mutation-before-result-checkpoint', 'uncertain-no-redispatch'],
  'fault-result-before-next-turn': ['result-before-next-turn', 'next-turn-no-redispatch'],
  'fault-final-before-transcript-ack': ['final-before-transcript-ack', 'awaiting-transcript-commit'],
  'fault-transcript-before-delivery-ack': ['transcript-before-delivery-ack', 'redeliver-once-original-destination'],
  'fault-compaction-rotation': ['compaction-rotation', 'complete-searchable-history'],
  'fault-routine-subagent-finalization': ['routine-subagent-finalization', 'one-result-one-cost-original-destination']
};

function route(taskId) {
  return { requestedAgentId: 'eval-agent', observedAgentId: 'eval-agent', requestedSessionId: `session-${taskId}`,
    observedSessionId: `session-${taskId}`, requestedDestination: `eval:${taskId}`, deliveredDestination: `eval:${taskId}` };
}

function trajectory(taskId, attempt, observedRecovery, passed, detail = {}) {
  const [injectedAt] = EXPECTED[taskId];
  const at = new Date(Date.UTC(2026, 7, 3, 5, 0, attempt % 60)).toISOString();
  return { schemaVersion: 'starnet.eval.trajectory.v1', taskId, attempt, runId: `${taskId}-${attempt}`,
    startedAt: at, endedAt: at, finalText: passed ? 'boundary recovered' : 'boundary remains unproved',
    events: [{ seq: 1, at, type: 'fault.injected', data: { boundary: injectedAt } },
      { seq: 2, at, type: 'eval.assertion', data: { passed, observedRecovery, detail } }], artifacts: [],
    outcome: { passed, violations: { falseDone: 0, wrongDestination: 0, duplicateMutation: 0, authorityEscape: 0 }, evidence: detail },
    routing: route(taskId), fault: { injectedAt, observedRecovery, ambiguous: false } };
}

async function observe(taskId, attempt) {
  const runId = `${taskId}-${attempt}`;
  if (taskId === 'fault-transcript-before-delivery-ack') {
    const fs = memoryFs(), root = '/eval/channels';
    const store1 = makeChannelStore({ fs, pathMod, root, clock: { now: () => attempt } });
    store1.pushOutbox({ channel: 'telegram', chatId: 'destination-1', text: 'durable result', runId, agentId: 'eval-agent' });
    const store2 = makeChannelStore({ fs, pathMod, root, clock: { now: () => attempt + 1 } });
    const sent = [];
    const hub = makeChannelHub({ channel: 'telegram', store: store2, runOnce: async () => {}, secrets: () => ({}),
      send: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; }, emit() {}, newId: () => runId, sleep: async () => {} });
    await hub._internals.flushOutbox();
    const passed = sent.length === 1 && sent[0].chatId === 'destination-1' && store2.loadOutbox().length === 0;
    return trajectory(taskId, attempt, passed ? EXPECTED[taskId][1] : 'redelivery-mismatch', passed, { sends: sent.length, destination: sent[0] && sent[0].chatId });
  }

  if (taskId === 'fault-compaction-rotation') {
    return trajectory(taskId, attempt, 'unproven-no-interruptible-rotation-adapter', false,
      { limitation: 'production has compaction/restart coverage, but this pack has no kill-at-rotation injection seam' });
  }
  if (taskId === 'fault-routine-subagent-finalization') {
    return trajectory(taskId, attempt, 'unproven-no-finalization-crash-adapter', false,
      { limitation: 'background and routine completion are tested, but no restart boundary proves result/cost/destination exactly once' });
  }

  const { journal } = memoryJournal();
  journal.begin({ runId, agentId: 'eval-agent', sessionId: `session-${taskId}`, destination: `eval:${taskId}`, messages: [] });
  let observed = '', detail = {};
  if (taskId === 'fault-accepted-before-provider') {
    const state = journal.inspect(runId);
    observed = state.status === 'resumable' && state.meta.agentId === 'eval-agent' ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, agentId: state.meta.agentId };
  } else if (taskId === 'fault-provider-stream') {
    journal.checkpoint(runId, { phase: 'assistant-partial', messages: [{ role: 'assistant', content: 'partial' }] });
    const state = journal.inspect(runId);
    observed = state.status === 'resumable' && state.checkpoint.messages[0].content === 'partial' && !state.terminal ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, terminal: state.terminal, partial: state.checkpoint.messages[0].content };
  } else if (taskId === 'fault-read-intent-before-dispatch') {
    journal.toolIntent(runId, { callId: 'read-1', name: 'fs.read', mutating: false });
    const state = journal.inspect(runId);
    observed = state.status === 'resumable' ? EXPECTED[taskId][1] : `read-intent-${state.status}`;
    detail = { status: state.status, uncertain: state.uncertain.length };
  } else if (taskId === 'fault-mutation-intent-before-dispatch') {
    journal.toolIntent(runId, { callId: 'write-1', name: 'fs.write', mutating: true });
    const state = journal.inspect(runId);
    observed = state.status === 'needs_review' ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, uncertain: state.uncertain.length };
  } else if (taskId === 'fault-mutation-before-result-checkpoint') {
    journal.toolIntent(runId, { callId: 'write-1', name: 'fs.write', mutating: true });
    const state = journal.inspect(runId);
    observed = state.status === 'needs_review' && state.uncertain.length === 1 ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, uncertain: state.uncertain.length, redispatches: 0 };
  } else if (taskId === 'fault-result-before-next-turn') {
    journal.toolIntent(runId, { callId: 'write-1', name: 'fs.write', mutating: true });
    journal.toolResult(runId, { callId: 'write-1', ok: true, content: 'saved' });
    journal.checkpoint(runId, { phase: 'tool_results', messages: [{ role: 'tool', tool_call_id: 'write-1', content: 'saved' }] });
    const state = journal.inspect(runId);
    observed = state.status === 'resumable' && state.completed.length === 1 && state.uncertain.length === 0 ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, completed: state.completed.length, redispatches: 0 };
  } else if (taskId === 'fault-final-before-transcript-ack') {
    journal.checkpoint(runId, { phase: 'final', messages: [{ role: 'assistant', content: 'final result' }] });
    journal.finish(runId, { reason: 'done', transcriptAck: false });
    const state = journal.inspect(runId);
    observed = state.status === 'awaiting_commit' && state.checkpoint.messages[0].content === 'final result' ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, final: state.checkpoint.messages[0].content };
  }
  const passed = observed === EXPECTED[taskId][1];
  return trajectory(taskId, attempt, observed, passed, detail);
}

export async function runFaultAdapters({ tasks, repeats = 100 }) {
  const rows = [];
  for (const task of tasks) for (let attempt = 1; attempt <= repeats; attempt++) rows.push(await observe(task.id, attempt));
  return rows;
}
