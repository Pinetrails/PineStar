/* node test/save.test.js — durable server-side agent save store (M-save).
   An in-memory fake fs proves: a save envelope round-trips, missing/corrupt -> undefined (fail-closed),
   writes are atomic (temp+rename, no .tmp left behind), the agentId jail-grammar is enforced, and a STALE
   write (older updatedAt) is refused so a background tab can't clobber a newer save. Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path');
const { makeSaveStore } = require('../sidecar/savestore.js');

// in-memory fs: records writes/renames so we can assert atomicity (write to .tmp, then rename onto target).
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

let clk = 1000;
const clock = { now: () => clk };
const ROOT = '/ws';
const mk = (fs) => makeSaveStore({ fs, pathMod, root: ROOT, clock });
const envelope = (over) => Object.assign({ schema: 'skynet.save', version: 3, updatedAt: 100, agent: { id: 'agent', name: 'NOVA', stats: { xp: 42, level: 3 } } }, over || {});

// ---- A. construction guards ----
{
  A.throws(() => makeSaveStore({ pathMod, root: ROOT, clock }), 'missing fs throws');
  A.throws(() => makeSaveStore({ fs: memFs(), root: ROOT, clock }), 'missing pathMod throws');
  A.throws(() => makeSaveStore({ fs: memFs(), pathMod, clock }), 'missing root throws');
  A.throws(() => makeSaveStore({ fs: memFs(), pathMod, root: ROOT }), 'missing clock throws');
}

// ---- B. empty / missing save loads as undefined (fail-closed, never throws) ----
{
  const s = mk(memFs());
  A.eq(s.load('agent'), undefined, 'missing save -> undefined');
}

// ---- C. save round-trips the exact doc; persisted atomically (write .tmp then rename); survives a fresh store ----
{
  const fs = memFs();
  let s = mk(fs);
  clk = 1234;
  const r = s.save('agent', envelope({ updatedAt: 500 }));
  A.eq(r.ok, true, 'save ok');
  A.eq(r.updatedAt, 500, 'returns the stored updatedAt');
  A.eq(s.load('agent').agent.name, 'NOVA', 'load returns the persisted agent verbatim');
  A.eq(s.load('agent').agent.stats.xp, 42, 'nested stats preserved');
  // atomicity: every persisted file arrived via a rename from a .tmp; nothing left behind
  const renames = fs.events.filter(e => e[0] === 'rename');
  A.ok(renames.length >= 1, 'save renamed a temp onto the target');
  A.ok(renames.every(e => /\.tmp$/.test(e[1]) && !/\.tmp$/.test(e[2])), 'rename goes .tmp -> final');
  A.ok(![...fs.files.keys()].some(k => /\.tmp$/.test(k)), 'no .tmp file left behind');
  A.ok(fs.files.has(pathMod.join(ROOT, 'agent.save.json')), 'final save file exists');
  // a fresh store rebuilt from the same fs sees the persisted record (durable across restarts)
  s = mk(fs);
  A.eq(s.load('agent').agent.name, 'NOVA', 'save survives a fresh store instance');
}

// ---- D. corrupt save file -> undefined and a fresh save still works ----
{
  const fs = memFs();
  fs.files.set(pathMod.join(ROOT, 'agent.save.json'), '{not json');
  const s = mk(fs);
  A.eq(s.load('agent'), undefined, 'corrupt save -> undefined');
  A.eq(s.save('agent', envelope({ updatedAt: 10 })).ok, true, 'save recovers over a corrupt file');
  A.eq(s.load('agent').agent.name, 'NOVA', 'recovered save loads');
}

// ---- E. anti-clobber: an OLDER updatedAt is refused; equal/newer is accepted (monotonic in time) ----
{
  const fs = memFs();
  const s = mk(fs);
  s.save('agent', envelope({ updatedAt: 200, agent: { id: 'agent', name: 'NEW' } }));
  // a stale background tab tries to push an older snapshot -> refused, on-disk save unchanged
  const stale = s.save('agent', envelope({ updatedAt: 150, agent: { id: 'agent', name: 'OLD' } }));
  A.eq(stale.ok, false, 'older updatedAt refused');
  A.eq(stale.stale, true, 'flagged stale');
  A.eq(s.load('agent').agent.name, 'NEW', 'on-disk save not clobbered by the stale write');
  // equal updatedAt is allowed (idempotent re-push / same-ms update)
  A.eq(s.save('agent', envelope({ updatedAt: 200, agent: { id: 'agent', name: 'SAME' } })).ok, true, 'equal updatedAt accepted');
  A.eq(s.load('agent').agent.name, 'SAME', 'equal-ts write applied');
  // a newer save wins
  A.eq(s.save('agent', envelope({ updatedAt: 999, agent: { id: 'agent', name: 'NEWER' } })).ok, true, 'newer updatedAt accepted');
  A.eq(s.load('agent').agent.name, 'NEWER', 'newer write applied');
}

// ---- F. a doc with no updatedAt is treated as time 0 (first write lands; later real saves supersede it) ----
{
  const fs = memFs();
  const s = mk(fs);
  A.eq(s.save('agent', { schema: 'skynet.save', agent: { id: 'agent' } }).ok, true, 'first write with no updatedAt lands');
  A.eq(s.save('agent', envelope({ updatedAt: 5 })).ok, true, 'a stamped save supersedes the unstamped one');
  A.eq(s.load('agent').agent.name, 'NOVA', 'stamped save won');
}

// ---- G. agentId jail-grammar enforced (no path traversal via a crafted agentId) ----
{
  const s = mk(memFs());
  A.throws(() => s.load('../escape'), 'traversal agentId rejected on load');
  A.throws(() => s.save('a/b', envelope()), 'slash agentId rejected on save');
  A.throws(() => s.save('agent', null), 'null doc rejected');
  A.throws(() => s.save('agent', 'nope'), 'non-object doc rejected');
}

// ---- H. when the fs supports it, the durable write fsyncs the temp BEFORE the rename (power-loss safety) ----
{
  const calls = [];
  const files = new Map();
  let cur = null;
  const fsyncFs = {
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync() { calls.push('writeFileSync'); },   // the durable path must NOT use this when openSync is present
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); calls.push('rename'); },
    mkdirSync() {},
    openSync(p) { cur = { path: p, buf: '' }; calls.push('open'); return 7; },
    writeSync(fd, data) { cur.buf = String(data); calls.push('write'); },
    fsyncSync() { calls.push('fsync'); },
    closeSync() { files.set(cur.path, cur.buf); calls.push('close'); }   // commit the buffered temp on close
  };
  const s = makeSaveStore({ fs: fsyncFs, pathMod, root: ROOT, clock });
  s.save('agent', envelope({ updatedAt: 1 }));
  A.ok(calls.indexOf('fsync') >= 0, 'durable path fsyncs the temp file');
  A.ok(calls.indexOf('fsync') < calls.indexOf('rename'), 'fsync happens BEFORE the rename');
  A.eq(calls.indexOf('writeFileSync'), -1, 'plain writeFileSync NOT used when fsync is available');
  A.eq(s.load('agent').agent.name, 'NOVA', 'durable-path write round-trips');
}

A.report('save.test');
