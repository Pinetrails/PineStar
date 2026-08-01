'use strict';
const A = require('./_assert.js');
const { makeRunJournal, _internals } = require('../sidecar/run-journal.js');
const { runAgentLoop } = require('../sidecar/loop.js');

function memoryIo() {
  const files = new Map();
  return {
    create(id, line) { files.set(id, line + '\n'); },
    append(id, line) { files.set(id, (files.get(id) || '') + line + '\n'); },
    read(id) { return files.get(id); }, list() { return Array.from(files.keys()); },
    readFile(id) { return files.get(id); }, remove(id) { files.delete(id); }, files
  };
}
function provider() {
  let turn = 0;
  return { async *stream() {
    if (turn++ === 0) {
      yield { type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' };
      yield { type: 'tool_args', index: 0, chunk: '{"path":"a.txt","content":"ok"}' };
      yield { type: 'done', finishReason: 'tool_calls' };
    } else {
      yield { type: 'text', delta: 'saved' };
      yield { type: 'done', finishReason: 'stop' };
    }
  } };
}

(async () => {
  const io = memoryIo();
  let tick = 0;
  const journal = makeRunJournal({ io, clock: { now: () => ++tick } });
  const messages = [{ role: 'user', content: 'write it' }];
  journal.begin({ runId: 'r', agentId: 'a' });
  const result = await runAgentLoop({
    messages, provider: provider(), emit() {}, model: 'm', agentId: 'a', runId: 'r',
    onCheckpoint({ phase, messages: current, turn }) { journal.checkpoint('r', { phase, turn, messages: current }); },
    async dispatch(call) {
      journal.toolIntent('r', { callId: call.id, name: call.name, argsRaw: call.argsRaw, mutating: true });
      const out = { ok: true, content: 'wrote a.txt', summary: 'saved' };
      journal.toolResult('r', { callId: call.id, ok: true, content: out.content, summary: out.summary });
      return out;
    },
    capCtx: {}
  });
  journal.finish('r', { reason: result.reason });
  const rows = _internals.parseRecords(io.read('r')).records;
  A.eq(rows.map(r => r.type), ['begin', 'checkpoint', 'tool_intent', 'tool_result', 'checkpoint', 'checkpoint', 'finish'], 'assistant is durable before intent and result before the next model turn');
  A.eq(rows[1].payload.phase, 'assistant', 'provider-valid tool-call assistant checkpoint is first');
  A.eq(rows[4].payload.phase, 'tool_results', 'paired tool results receive their own checkpoint');
  A.eq(journal.inspect('r').status, 'finished', 'fully paired terminal run is settled');

  const io2 = memoryIo();
  const uncertain = makeRunJournal({ io: io2, clock: { now: () => 1 } });
  uncertain.begin({ runId: 'u', agentId: 'a' });
  const failed = await runAgentLoop({
    messages: [{ role: 'user', content: 'mutate then fail' }], provider: provider(), emit() {}, model: 'm', agentId: 'a', runId: 'u',
    onCheckpoint({ phase, messages: current }) { uncertain.checkpoint('u', { phase, messages: current }); },
    async dispatch(call) {
      uncertain.toolIntent('u', { callId: call.id, name: call.name, mutating: true });
      throw new Error('process lost result boundary');
    }, capCtx: {}
  });
  uncertain.finish('u', { reason: failed.reason });
  A.eq(failed.reason, 'done', 'the loop may recover from a thrown dispatch and still answer');
  A.eq(uncertain.inspect('u').status, 'needs_review', 'terminal error never makes an unmatched mutation replayable');

  A.report('run-journal.loop.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
