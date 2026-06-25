/* node test/notebookstore.test.js - hardened notebook persistence. */
'use strict';

const A = require('./_assert.js');
const pathMod = require('path');
const { makeNotebookStore } = require('../sidecar/notebookstore.js');

function memFs() {
  const files = new Map();
  const events = [];
  return {
    files, events,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); events.push(['write', p]); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; } files.set(b, files.get(a)); files.delete(a); events.push(['rename', a, b]); },
    mkdirSync() {}
  };
}

let now = 1000;
const clock = { now: () => now };
const ROOT = '/ws';
const mk = (fs, limits) => makeNotebookStore({ fs, pathMod, root: ROOT, clock, limits });
const key = 'notebook:ag';
const rec = (id, body) => ({ id, kind: 'note', title: id, body, content: body, createdAt: 1000, ts: 1000, trust: 0, useCount: 0 });

// ---- A. construction guards and jail grammar ----
{
  A.throws(() => makeNotebookStore({ pathMod, root: ROOT, clock }), 'missing fs throws');
  A.throws(() => makeNotebookStore({ fs: memFs(), root: ROOT, clock }), 'missing pathMod throws');
  A.throws(() => makeNotebookStore({ fs: memFs(), pathMod, clock }), 'missing root throws');
  A.throws(() => makeNotebookStore({ fs: memFs(), pathMod, root: ROOT }), 'missing clock throws');
  const s = mk(memFs());
  A.throws(() => s.get('notebook:../escape'), 'bad agent id rejected');
}

// ---- B. get/set round-trip and atomic temp rename ----
{
  const fs = memFs();
  const s = mk(fs);
  A.eq(s.get(key), undefined, 'missing notebook -> undefined');
  const r = s.set(key, [rec('note_1', 'first memory')]);
  A.eq(r.ok, true, 'set ok');
  A.eq(s.get(key)[0].body, 'first memory', 'set round-trips');
  const renames = fs.events.filter(e => e[0] === 'rename');
  A.ok(renames.length >= 1, 'write renamed a temp file into place');
  A.ok(renames.every(e => /\.tmp$/.test(e[1]) && !/\.tmp$/.test(e[2])), 'rename goes temp -> final');
  A.ok(![...fs.files.keys()].some(k => /\.tmp$/.test(k)), 'no temp file left behind');
}

// ---- C. CAS drift detection: a stale reader cannot clobber an out-of-band edit ----
{
  const fs = memFs();
  const s1 = mk(fs);
  const s2 = mk(fs);
  s1.set(key, [rec('note_1', 'base')]);
  A.eq(s1.get(key)[0].body, 'base', 's1 read establishes its expected hash');
  s2.set(key, [rec('note_1', 'newer')]);
  A.throws(() => s1.set(key, [rec('note_1', 'stale')]), 'stale set is refused');
  A.eq(s2.get(key)[0].body, 'newer', 'newer disk state survived stale writer');
}

// ---- D. mutate and batch are atomic read-modify-write operations ----
{
  const fs = memFs();
  const s = mk(fs);
  const m = s.mutate(key, list => ({ records: list.concat([rec('note_1', 'alpha')]), value: { added: 'note_1' } }));
  A.eq(m.value.added, 'note_1', 'mutate returns caller value');
  A.eq(s.get(key).length, 1, 'mutate persisted');
  s.batch(key, [
    { op: 'add', record: rec('note_2', 'beta') },
    { op: 'pin', id: 'note_1', pinned: true },
    { op: 'edit', id: 'note_2', content: 'beta edited' },
    { op: 'forget', id: 'note_1' }
  ]);
  const out = s.get(key);
  A.eq(out.length, 1, 'batch forget removed one record');
  A.eq(out[0].id, 'note_2', 'batch kept the expected record');
  A.eq(out[0].body, 'beta edited', 'batch edit applied');
  A.eq(out[0].pinned, undefined, 'forgotten pinned record is gone');
}

// ---- E. budgets reject oversize records, too many records, duplicate ids, and preserve prior disk state ----
{
  const fs = memFs();
  const s = mk(fs, { maxRecords: 2, maxRecordChars: 12, maxAgentBytes: 512 });
  s.set(key, [rec('note_1', 'short')]);
  A.throws(() => s.set(key, [rec('note_1', 'short'), rec('note_2', 'ok'), rec('note_3', 'ok')]), 'record count budget enforced');
  A.eq(s.get(key).length, 1, 'count-budget failure did not clobber prior store');
  A.throws(() => s.set(key, [rec('note_1', 'this body is much too long')]), 'record char budget enforced');
  A.eq(s.get(key)[0].body, 'short', 'char-budget failure did not clobber prior store');
  A.throws(() => s.set(key, [rec('note_1', 'one'), rec('note_1', 'two')]), 'duplicate ids rejected');
}

// ---- F. corrupt files fail closed on read but can be recovered by an intentional write ----
{
  const fs = memFs();
  fs.files.set(pathMod.join(ROOT, 'ag.notebook.json'), '{bad json');
  const s = mk(fs);
  A.eq(s.get(key), undefined, 'corrupt notebook reads as undefined');
  s.set(key, [rec('note_1', 'recovered')]);
  A.eq(s.get(key)[0].body, 'recovered', 'intentional write recovers a corrupt notebook');
}

A.report('notebookstore.test');
