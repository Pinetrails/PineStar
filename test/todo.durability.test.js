/* node test/todo.durability.test.js - durable todo storage regression.

   Guards the StarNet goal 5-6 bug: todo:<agent> keys must not be treated as unsupported notebook keys
   and swallowed by the host store. The todo tool writes through the same injected memory store as notebook,
   but persists to its own sibling file so task plans survive restart and compaction. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const { makeMemoryStore, memoryFileFor, resetAgentMemory, restoreDeclined } = require('../sidecar/memory-store.js');
const { makeTodoTool, formatForInjection } = require('../sidecar/tools/builtin/todo.js');

function memFs() {
  const files = new Map();
  const fds = new Map();
  let nextFd = 10;
  const stats = { fsync: 0, rename: 0 };
  return {
    files, stats,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; } files.set(b, files.get(a)); files.delete(a); stats.rename++; },
    mkdirSync() {},
    openSync(p, flags) {
      const fd = nextFd++;
      if (flags === 'r') {
        if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
        fds.set(fd, { path: p, buf: files.get(p), read: true });
      } else {
        fds.set(fd, { path: p, buf: '' });
        files.set(p, '');
      }
      return fd;
    },
    writeSync(fd, data) { const h = fds.get(fd); h.buf += String(data); files.set(h.path, h.buf); },
    fsyncSync() { stats.fsync++; },
    closeSync(fd) { fds.delete(fd); }
  };
}

(async () => {
  const ROOT = '/ws';

  A.eq(memoryFileFor(ROOT, path, 'notebook:hero'), path.join(ROOT, 'hero.notebook.json'), 'notebook keys map to notebook sibling files');
  A.eq(memoryFileFor(ROOT, path, 'todo:hero'), path.join(ROOT, 'hero.todo.json'), 'todo keys map to todo sibling files');
  A.eq(memoryFileFor(ROOT, path, 'declined:hero'), path.join(ROOT, 'hero.declined.json'), 'declined keys map to declined sibling files');
  A.eq(memoryFileFor(ROOT, path, 'minted:hero'), path.join(ROOT, 'hero.minted.json'), 'minted keys map to minted sibling files (W6 mint ledger)');
  A.throws(() => memoryFileFor(ROOT, path, 'todo:../bad'), 'invalid todo agent ids are rejected');
  A.throws(() => memoryFileFor(ROOT, path, 'declined:../bad'), 'invalid declined agent ids are rejected');
  A.throws(() => memoryFileFor(ROOT, path, 'minted:../bad'), 'invalid minted agent ids are rejected');
  A.throws(() => memoryFileFor(ROOT, path, 'other:hero'), 'unknown memory keys are rejected');

  const fs = memFs();
  const store = makeMemoryStore({ fs, path, workspaces: ROOT });
  const { todoTool } = makeTodoTool({ store });

  const write = await todoTool.run({ todos: [
    { id: 'a', content: 'audit current todo behavior', status: 'completed' },
    { id: 'b', content: 'persist todo list durably', status: 'in_progress' },
    { id: 'c', content: 'run regression tests', status: 'pending' }
  ] }, { agentId: 'hero' });
  A.ok(/3 tasks/.test(write.summary), 'todo write succeeds through the durable host store');

  const todoFile = path.join(ROOT, 'hero.todo.json');
  const notebookFile = path.join(ROOT, 'hero.notebook.json');
  A.ok(fs.files.has(todoFile), 'todo:<agent> persisted to a real .todo.json file');
  A.ok(!fs.files.has(notebookFile), 'todo writes do not create or clobber the notebook file');
  A.ok(fs.stats.fsync > 0, 'todo write used the durable fsync-before-rename path');

  await todoTool.run({ merge: true, todos: [{ id: 'b', status: 'completed' }] }, { agentId: 'hero' });
  A.ok(fs.files.has(todoFile + '.bak'), 'second todo write snapshotted the prior plan to .bak');

  const afterRestart = makeMemoryStore({ fs, path, workspaces: ROOT });
  const { todoTool: restartedTodo } = makeTodoTool({ store: afterRestart });
  const read = await restartedTodo.run({}, { agentId: 'hero' });
  A.ok(/\[x\] b\. persist todo list durably/.test(read.content), 'fresh store reads the persisted todo list after restart');

  const inj = formatForInjection(afterRestart, 'hero');
  A.ok(/preserved across context compaction/.test(inj), 'active todo list is available for compaction reinjection');
  A.ok(inj.indexOf('run regression tests') >= 0 && inj.indexOf('audit current todo behavior') < 0, 'injection keeps pending items and omits completed ones');

  /* ---------- resetAgentMemory: the new-hero clean slate (no prior Commander's state bleeds into a fresh agent) ---------- */
  const rstore = makeMemoryStore({ fs: memFs(), path, workspaces: ROOT });
  await rstore.update('notebook:hero', () => [{ content: 'a kept belief' }]);
  await rstore.update('declined:hero', () => ['a permanently-rejected belief']);
  await rstore.update('todo:hero', () => [{ id: 'x', content: 'a plan item', status: 'pending' }]);
  await rstore.update('minted:hero', () => [{ fp: 'ultron daily operating loop', title: 'ULTRON daily operating loop', status: 'created', at: 1 }]);
  await rstore.update('notebook:other', () => [{ content: 'a DIFFERENT hero belief' }]);
  await resetAgentMemory(rstore, 'hero');
  A.eq(rstore.get('notebook:hero'), [], 'reset wipes the kept notebook (no inherited memories)');
  A.eq(rstore.get('declined:hero'), [], 'reset wipes the declined reject-list (no inherited suppression)');
  A.eq(rstore.get('todo:hero'), [], 'reset wipes the active todo plan');
  A.eq(rstore.get('minted:hero'), [], 'reset wipes the mint ledger (a fresh hero re-earns its own routines)');
  A.eq(rstore.get('notebook:other'), [{ content: 'a DIFFERENT hero belief' }], 'reset is scoped to ONE agent — a different agent is untouched');

  /* ---------- restoreDeclined: the undo-a-discard escape hatch removes ONE entry from the reject-list ---------- */
  const dstore = makeMemoryStore({ fs: memFs(), path, workspaces: ROOT });
  await dstore.update('declined:hero', () => ['keep this one', 'restore me', 'and keep this']);
  A.eq(await restoreDeclined(dstore, 'hero', 'restore me'), true, 'restoreDeclined reports it removed the matched entry');
  A.eq(dstore.get('declined:hero'), ['keep this one', 'and keep this'], 'only the matched belief is lifted off the reject-list');
  A.eq(await restoreDeclined(dstore, 'hero', 'not present'), false, 'restoring a belief that was never declined is a no-op (removed=false)');
  A.eq(await restoreDeclined(dstore, 'hero', '   '), false, 'a blank text restores nothing');
  A.eq(dstore.get('declined:hero'), ['keep this one', 'and keep this'], 'the reject-list is unchanged by no-op restores');

  A.report('todo.durability.test');
})();
