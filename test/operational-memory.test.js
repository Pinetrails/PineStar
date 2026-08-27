'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeMemoryStore, memoryFileFor, appendInternalRecord, appendSharedReport, listSharedReports, normalizeSharedReport } = require('../sidecar/memory-store.js');

function memFs() {
  const files = new Map(), fds = new Map(); let nextFd = 10;
  return { files,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); }, renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); }, mkdirSync() {},
    openSync(p) { const fd = nextFd++; fds.set(fd, { path: p, buf: '' }); files.set(p, ''); return fd; },
    writeSync(fd, data) { const h = fds.get(fd); h.buf += String(data); files.set(h.path, h.buf); }, fsyncSync() {}, closeSync(fd) { fds.delete(fd); }
  };
}

(async () => {
  const root = '/ws', fs = memFs(), store = makeMemoryStore({ fs, path, workspaces: root });
  A.eq(memoryFileFor(root, path, 'internal:station'), path.join(root, 'pine-star.internal-memory.json'), 'private operational memory has its own station file');
  A.eq(memoryFileFor(root, path, 'reports:station'), path.join(root, 'pine-star.shared-reports.json'), 'shareable reports have a distinct station file');

  await appendInternalRecord(store, { id: 'run:1', type: 'runtime-lesson', createdAt: 10, payload: { privateContext: 'not for reports' } });
  const first = await appendSharedReport(store, { id: 'brief:1', type: 'morning-brief', createdAt: 20, headline: '2 tasks completed', completed: ['A', 'B'], sourceRefs: ['/api/runs'] });
  A.eq(first.added, true, 'a concise report is durably appended');
  A.eq((await appendSharedReport(store, first.report)).added, false, 'report ids are idempotent');
  const reports = listSharedReports(store, 10);
  A.eq(reports.length, 1, 'shared reader returns only report records');
  A.eq(reports[0].payload, undefined, 'shared records cannot carry private payloads');
  A.ok(!JSON.stringify(reports).includes('privateContext'), 'private internal content never leaks through the report reader');
  A.ok(fs.files.has(path.join(root, 'pine-star.internal-memory.json')) && fs.files.has(path.join(root, 'pine-star.shared-reports.json')), 'both boundaries use durable sibling files');

  const bounded = normalizeSharedReport({ id: 'x', type: 'daily', headline: 'h', completed: Array.from({ length: 20 }, (_, i) => 'item-' + i), rawTranscript: 'secret raw log' });
  A.eq(bounded.completed.length, 10, 'report sections are concise and bounded');
  A.eq(bounded.rawTranscript, undefined, 'unknown/raw fields are dropped by projection');
  A.throws(() => normalizeSharedReport({ type: 'daily' }), 'incomplete reports are rejected');
  A.report('operational-memory.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
