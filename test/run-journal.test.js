'use strict';
const A = require('./_assert');
const J = require('../sidecar/run-journal');

function memoryIo() {
  const files = new Map();
  return {
    create(id, line) { if (files.has(id)) throw new Error('exists'); files.set(id, line + '\n'); },
    append(id, line) { if (!files.has(id)) throw new Error('missing'); files.set(id, files.get(id) + line + '\n'); },
    read(id) { return files.get(id); }, list() { return Array.from(files.keys()); },
    readFile(id) { return files.get(id); }, remove(id) { files.delete(id); }, quarantine(id) { files.set(id + '.corrupt', files.get(id)); files.delete(id); return id + '.corrupt'; },
    repair(id, records) { files.set(id + '.corrupt', files.get(id)); files.set(id, records.map(r => JSON.stringify(r)).join('\n') + '\n'); return id + '.corrupt'; },
    files
  };
}

let tick = 100;
const io = memoryIo();
const j = J.makeRunJournal({ io, clock: { now: () => ++tick }, redact: s => s.replace(/secret/g, '[redacted]') });
j.begin({ runId: 'r1', agentId: 'a', messages: [{ role: 'user', content: 'secret request' }] });
j.checkpoint('r1', { phase: 'assistant', messages: [{ role: 'assistant', content: 'working' }] });
j.toolIntent('r1', { callId: 'c1', name: 'fs.write', argsRaw: '{"value":"secret"}', mutating: true });
let state = j.inspect('r1');
A.eq(state.status, 'needs_review', 'an unmatched tool intent requires review');
A.eq(state.uncertain.length, 1, 'the uncertain boundary is retained');
A.ok(!io.read('r1').includes('secret'), 'journal strings are redacted before persistence');

j.toolResult('r1', { callId: 'c1', ok: true, content: 'saved' });
j.checkpoint('r1', { phase: 'tool_results', messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] }, { role: 'tool', tool_call_id: 'c1', content: 'saved' }] });
state = j.inspect('r1');
A.eq(state.status, 'resumable', 'a paired result is safe to resume');
A.eq(state.checkpoint.phase, 'tool_results', 'latest provider-valid checkpoint wins');
A.eq(state.completed.length, 1, 'paired intent/result evidence survives recovery analysis');
A.eq(state.meta.agentId, 'a', 'run metadata remains available to the restart reconciler');

j.finish('r1', { reason: 'done', transcriptAck: true });
state = j.inspect('r1');
A.eq(state.status, 'finished', 'a terminal record is not offered as interrupted work');
j.remove('r1');
A.eq(io.files.has('r1'), false, 'settled journals can be removed after transcript persistence');

const badIo = memoryIo();
const bad = J.makeRunJournal({ io: badIo, clock: { now: () => 1 } });
bad.begin({ runId: 'broken', messages: [] });
badIo.files.set('broken', badIo.files.get('broken') + '{bad-json\n');
const recovered = bad.recoverAll();
A.eq(recovered.length, 1, 'corrupt-tail journal is discovered');
A.eq(recovered[0].corrupt, true, 'corrupt tail is disclosed');
A.eq(recovered[0].status, 'resumable', 'valid prefix remains recoverable');
bad.checkpoint('broken', { phase: 'after-repair', messages: [] });
A.eq(bad.inspect('broken').records, 2, 'new records remain visible after a torn tail is repaired');

const unknownIo = memoryIo();
const unknown = J.makeRunJournal({ io: unknownIo, clock: { now: () => 2 } });
unknown.begin({ runId: 'unknown', messages: [] });
unknown.toolIntent('unknown', { callId: 'side-effect', name: 'shell.exec', mutating: true });
unknown.finish('unknown', { reason: 'error' });
A.eq(unknown.inspect('unknown').status, 'needs_review', 'run.end cannot erase an unknown side-effect outcome');

const pendingIo = memoryIo();
const pending = J.makeRunJournal({ io: pendingIo, clock: { now: () => 3 } });
pending.begin({ runId: 'pending', messages: [] });
pending.finish('pending', { reason: 'done', transcriptAck: false });
A.eq(pending.inspect('pending').status, 'awaiting_commit', 'terminal run remains recoverable until transcript durability is acknowledged');

const scrubIo = memoryIo();
const scrub = J.makeRunJournal({ io: scrubIo, clock: { now: () => 4 } });
scrub.begin({ runId: 'scrub', messages: [] });
scrub.toolIntent('scrub', { callId: 'x', name: 'connector.write', argsRaw: '{"password":"hunter2","nested":{"api_key":"ordinary-value"},"safe":"kept"}' });
const scrubbedBytes = scrubIo.read('scrub');
A.ok(!/hunter2|ordinary-value/.test(scrubbedBytes), 'serialized JSON credential fields are scrubbed by key');
A.ok(/kept/.test(scrubbedBytes), 'non-secret tool arguments remain reviewable');
scrub.toolResult('scrub', { callId: 'x', content: JSON.stringify({ credentials: { value: 'nested-secret' }, authorization: { value: 'Basic abc123' }, compass: 'north' }) });
const containerBytes = scrubIo.read('scrub');
A.ok(!/nested-secret|abc123/.test(containerBytes), 'credential-shaped object containers are scrubbed as a whole');
A.ok(/compass/.test(containerBytes), 'ordinary keys containing pass-like letters are not over-redacted');

const contextIo = memoryIo();
const contextJournal = J.makeRunJournal({ io: contextIo, clock: { now: () => 5 } });
contextJournal.begin({ runId: 'context', agentId: 'a' });
contextJournal.checkpoint('context', { phase: 'initial', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'request' }] });
contextJournal.checkpoint('context', { phase: 'assistant', messages: [{ role: 'assistant', content: 'work', tool_calls: [{ id: 'c' }] }] });
const contextState = contextJournal.inspect('context');
A.eq(contextState.checkpoint.messages.map(m => m.role), ['system', 'user', 'assistant'], 'recovery checkpoint combines initial provider context with the latest run delta');
A.eq(contextState.baseCheckpoint.messages.length, 2, 'initial provider context remains separately inspectable');

// The real fs writer must retry short writes instead of accepting a torn record.
const chunks = [];
const fakeFs = {
  writeSync(fd, buf, off, len) { const n = Math.min(3, len); chunks.push(Buffer.from(buf.subarray(off, off + n))); return n; }
};
J._internals.writeAll(fakeFs, 1, 'abcdefghij');
A.eq(Buffer.concat(chunks).toString(), 'abcdefghij', 'short writes are completed fully');

A.report('run-journal.test');
