/* node test/transcript-history-v2.test.js — scaled lifetime-history persistence proof. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');

function temp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-' + name + '-')); }
function remove(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function ioAt(base, extra) {
  return makeSegmentedTranscriptIo(Object.assign({
    fs, path, root: path.join(base, 'history'), segmentBytes: 700, recentPerStream: 8,
    legacyFiles: [path.join(base, 'transcript.jsonl.1'), path.join(base, 'transcript.jsonl')]
  }, extra || {}));
}

// More than 64 tiny segments is a scaled >64 MB lifetime: oldest recall survives restart
// while the RAM mirror remains capped and every closed segment has a durable index.
{
  const dir = temp('history-scale');
  try {
    let io = ioAt(dir);
    let store = makeTranscriptStore({ io, clock: { now: () => 7777 }, ramPerStream: 8 });
    let first;
    for (let i = 0; i < 600; i++) {
      const row = store.append({
        streamId: i % 11 === 0 ? 'quiet' : 'loud', role: i % 2 ? 'assistant' : 'user',
        content: (i === 0 ? 'oldest zircon beacon ' : 'ordinary message ') + i + ' ' + 'x'.repeat(80),
        ts: 1000 + Math.floor(i / 2)
      });
      if (i === 0) first = row;
    }
    const before = io.status();
    A.ok(before.segments.length > 64, 'scaled lifetime rolled through more than 64 immutable numbered segments');
    A.ok(store.count() <= 16, 'RAM mirror remains per-stream bounded while disk retains lifetime history');
    const firstSegment = path.join(dir, 'history', 'segment-000001.jsonl');
    const firstBytes = fs.readFileSync(firstSegment);
    A.ok(fs.existsSync(path.join(dir, 'history', 'segment-000001.index.json')), 'closed first segment has a durable term index');
    for (let i = 600; i < 625; i++) store.append({ streamId: 'loud', role: 'user', content: 'later append ' + i + ' ' + 'y'.repeat(80), ts: 2000 + i });
    A.eq(Buffer.compare(fs.readFileSync(firstSegment), firstBytes), 0, 'closed numbered segment remains byte-immutable after later appends');
    A.ok(io.readById(first.rowId).content.indexOf('oldest zircon') >= 0, 'strict durable append/read-back API retrieves oldest stable row id');

    io = ioAt(dir); // sidecar restart
    store = makeTranscriptStore({ io, clock: { now: () => 9999 }, ramPerStream: 8 });
    const hits = store.search('loud', 'zircon beacon', { scope: 'all', limit: 5 });
    A.eq(hits.length, 1, 'oldest record remains indexed and searchable after restart');
    A.eq(hits[0].rowId, first.rowId, 'search returns the same stable row id after restart');
    const window = io.around(first.streamId, 'tx-' + first.rowId, { window: 2 });
    A.eq(window[0].rowId, first.rowId, 'stable anchor resolves the exact timestamp-colliding row');
    A.ok(io.streams({ limit: 20 }).find(s => s.streamId === 'loud').turns > 500, 'browse count spans every segment, not the RAM tail');
  } finally { remove(dir); }
}

// A crash after persisting a roll pointer but before creating its first row must not reopen the closed tail.
{
  const dir = temp('history-roll-gap');
  try {
    let io = ioAt(dir, { segmentBytes: 300 });
    for (let i = 0; i < 8; i++) io.appendDurable({ streamId: 'g', role: 'user', content: 'gap ' + i + ' ' + 'q'.repeat(100), ts: i + 1 });
    const state = io.status();
    const closed = path.join(dir, 'history', state.segments[0].file);
    const closedBytes = fs.readFileSync(closed);
    const manifestFile = path.join(dir, 'history', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.activeSegment = Math.max.apply(null, manifest.segments.map(s => s.number)) + 1;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest)); // models the durable roll-pointer / no-row crash gap
    io = ioAt(dir, { segmentBytes: 300 });
    io.appendDurable({ streamId: 'g', role: 'assistant', content: 'post restart', ts: 99 });
    A.eq(Buffer.compare(fs.readFileSync(closed), closedBytes), 0, 'restart honors a higher empty active pointer and never reopens a closed segment');
    A.ok(fs.existsSync(path.join(dir, 'history', 'segment-' + String(manifest.activeSegment).padStart(6, '0') + '.jsonl')), 'post-restart append lands in the intended new segment');
  } finally { remove(dir); }
}

// Legacy .1 then live logs migrate chronologically; originals remain untouched and repeat boot is idempotent.
{
  const dir = temp('history-migrate');
  try {
    const oldFile = path.join(dir, 'transcript.jsonl.1');
    const liveFile = path.join(dir, 'transcript.jsonl');
    const oldBytes = JSON.stringify({ streamId: 'm', role: 'user', content: 'legacy oldest cobalt', ts: 1 }) + '\n';
    const liveBytes = JSON.stringify({ streamId: 'm', role: 'assistant', content: 'legacy newest', ts: 2 }) + '\n';
    fs.writeFileSync(oldFile, oldBytes); fs.writeFileSync(liveFile, liveBytes);
    let io = ioAt(dir);
    const migrated = io.history('m', { limit: 10 });
    A.eq(migrated.map(r => r.content), ['legacy oldest cobalt', 'legacy newest'], 'archive migrates before active legacy log');
    A.ok(migrated.every(r => !Object.prototype.hasOwnProperty.call(r, 'legacyKey')), 'internal migration keys never leak through transcript reads');
    A.eq(fs.readFileSync(oldFile, 'utf8'), oldBytes, 'legacy archive is not removed or rewritten');
    A.eq(fs.readFileSync(liveFile, 'utf8'), liveBytes, 'legacy active file is not removed or rewritten');
    io = ioAt(dir);
    A.eq(io.streams({ limit: 10 })[0].turns, 2, 'restart does not duplicate migrated legacy rows');
    A.eq(io.search('m', 'cobalt', { limit: 5 })[0].content, 'legacy oldest cobalt', 'migrated oldest content is indexed');
  } finally { remove(dir); }
}

// A malformed closed segment line and index are isolated; later history remains searchable and writable.
{
  const dir = temp('history-corrupt');
  const warnings = [];
  try {
    let io = ioAt(dir, { onWarning: m => warnings.push(m) });
    for (let i = 0; i < 40; i++) io.appendDurable({ streamId: 'c', role: 'user', content: 'record ' + i + (i === 39 ? ' final-neon' : ''), ts: i + 1 });
    const status = io.status();
    const first = path.join(dir, 'history', status.segments[0].file);
    fs.appendFileSync(first, '{broken-json\n');
    fs.writeFileSync(path.join(dir, 'history', 'segment-000001.index.json'), '{broken-index');
    io = ioAt(dir, { onWarning: m => warnings.push(m) });
    io.search('c', 'record 0', { limit: 5 }); // lazily touches/rebuilds the damaged early index
    A.eq(io.search('c', 'final neon', { limit: 5 }).length, 1, 'corrupt early segment does not hide later searchable history');
    A.ok(warnings.some(m => /corrupt line/.test(m)), 'corrupt segment line is surfaced and isolated');
    const added = io.appendDurable({ streamId: 'c', role: 'assistant', content: 'still writable', ts: 99 });
    A.eq(io.readById(added.rowId).content, 'still writable', 'store remains durably writable after corruption isolation');
  } finally { remove(dir); }
}

// Exact OpenAI assistant/tool pairing remains intact even when a pair straddles segments.
{
  const dir = temp('history-pairing');
  try {
    const io = ioAt(dir, { segmentBytes: 300 });
    let tick = 1;
    const store = makeTranscriptStore({ io, clock: { now: () => tick++ }, ramPerStream: 20 });
    store.append({ streamId: 'p', role: 'user', content: 'read it ' + 'z'.repeat(180) });
    store.append({ streamId: 'p', role: 'assistant', content: '', toolCalls: [{ id: 'tc1', function: { name: 'fs_read', arguments: '{}' } }] });
    store.append({ streamId: 'p', role: 'tool', content: 'contents', toolCallId: 'tc1' });
    store.append({ streamId: 'p', role: 'assistant', content: 'done' });
    const restarted = makeTranscriptStore({ io: ioAt(dir, { segmentBytes: 300 }), clock: { now: () => 9 }, ramPerStream: 20 });
    const rebuilt = restarted.reconstruct('p', { limit: 10 });
    A.eq(rebuilt.map(m => m.role), ['user', 'assistant', 'tool', 'assistant'], 'restart reconstructs the exact cross-segment role sequence');
    A.eq(rebuilt[1].tool_calls[0].id, 'tc1', 'assistant tool call survives segmentation');
    A.eq(rebuilt[2].tool_call_id, 'tc1', 'tool result remains paired to the call');
  } finally { remove(dir); }
}

A.report('transcript-history-v2.test');
