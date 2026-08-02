/* sidecar/run-journal.js — durable, append-only active-run recovery journal.
 *
 * A finished transcript is not enough when the process dies between a tool dispatch and runOnce's
 * final transcript drain.  This journal records provider-valid message checkpoints plus tool intent/result
 * boundaries.  Recovery is deliberately conservative: an intent without a durable result is never replayed.
 */
'use strict';

const fsDefault = require('fs');
const pathDefault = require('path');
const crypto = require('crypto');

const VERSION = 1;
const MAX_STRING = 200000;

function stable(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

function hashRecord(r) {
  return crypto.createHash('sha256').update(stable({
    v: r.v, runId: r.runId, seq: r.seq, ts: r.ts, type: r.type,
    payload: r.payload, prev: r.prev
  })).digest('hex');
}

function isSecretKey(key) {
  const norm = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return /^(?:password|passwd|passphrase|token|secret|api_key|authorization|cookie|credentials?|private_key)$/.test(norm)
    || /(?:^|_)(?:password|passwd|passphrase|token|secret|api_key|authorization|cookie|credentials?|private_key)(?:_|$)/.test(norm);
}
function cloneSafe(value, redact, depth, key) {
  if (depth > 20) return '[depth limit]';
  // Credential containers are as sensitive as credential scalars. Check the key before branching on value type.
  if (key && isSecretKey(key)) return '[redacted]';
  if (typeof value === 'string') {
    // Tool arguments/results commonly arrive as serialized JSON. Scrub credential-shaped fields inside that
    // envelope instead of trusting a value-pattern redactor to recognize an otherwise ordinary secret.
    if (key === 'argsRaw' || key === 'content') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') return JSON.stringify(cloneSafe(parsed, redact, depth + 1, key));
      } catch (_) {}
    }
    let out = value.slice(0, MAX_STRING);
    try { out = String(redact(out)); } catch (_) {}
    return out.slice(0, MAX_STRING);
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 1000).map(v => cloneSafe(v, redact, depth + 1, key));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 200)) out[k] = cloneSafe(value[k], redact, depth + 1, k);
    return out;
  }
  return String(value);
}

function runFileName(runId) {
  return crypto.createHash('sha256').update(String(runId || '')).digest('hex') + '.jsonl';
}

function writeAll(fs, fd, data) {
  const buf = Buffer.from(data, 'utf8');
  let at = 0;
  while (at < buf.length) {
    const n = fs.writeSync(fd, buf, at, buf.length - at, null);
    if (!(n > 0)) throw new Error('run journal short write');
    at += n;
  }
}

function makeFsIo(opts) {
  const fs = opts.fs || fsDefault;
  const path = opts.path || pathDefault;
  const dir = String(opts.dir || '');
  if (!dir) throw new Error('run journal directory is required');
  fs.mkdirSync(dir, { recursive: true });

  function file(runId) { return path.join(dir, runFileName(runId)); }
  function append(runId, line, fresh) {
    const target = file(runId);
    let fd = null;
    try {
      fd = fs.openSync(target, fresh ? 'wx' : 'a');
      writeAll(fs, fd, line + '\n');
      fs.fsyncSync(fd);
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    }
  }
  return {
    create(runId, line) { append(runId, line, true); },
    append(runId, line) { append(runId, line, false); },
    read(runId) { return fs.readFileSync(file(runId), 'utf8'); },
    list() { return fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}\.jsonl$/.test(n)).map(n => path.join(dir, n)); },
    readFile(filePath) { return fs.readFileSync(filePath, 'utf8'); },
    remove(runId) { try { fs.unlinkSync(file(runId)); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; } },
    quarantine(filePath) {
      const to = filePath + '.corrupt';
      try { fs.renameSync(filePath, to); } catch (_) {}
      return to;
    },
    repair(filePath, records) {
      const nonce = crypto.randomBytes(5).toString('hex');
      const backup = filePath + '.corrupt-' + nonce;
      const tmp = filePath + '.repair-' + nonce;
      const body = records.map(r => JSON.stringify(r)).join('\n') + '\n';
      let fd = null;
      try {
        fd = fs.openSync(tmp, 'wx'); writeAll(fs, fd, body); fs.fsyncSync(fd);
      } finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
      fs.copyFileSync(filePath, backup);     // preserve the forensic original without removing the active path
      try {
        fs.renameSync(tmp, filePath);        // atomic replacement on platforms that support replace-existing
      } catch (_) {
        // Windows may reject replace-existing rename. Keep the discoverable active pathname throughout the
        // fallback; the forensic backup above lets the next boot recover even if power fails during this rewrite.
        let active = null;
        try {
          active = fs.openSync(filePath, 'r+');
          const bytes = Buffer.from(body, 'utf8');
          let at = 0;
          while (at < bytes.length) {
            const n = fs.writeSync(active, bytes, at, bytes.length - at, at);
            if (!(n > 0)) throw new Error('run journal repair short write');
            at += n;
          }
          fs.ftruncateSync(active, bytes.length); fs.fsyncSync(active);
        } finally {
          if (active != null) { try { fs.closeSync(active); } catch (__) {} }
          try { fs.unlinkSync(tmp); } catch (__) {}
        }
      }
      return backup;
    }
  };
}

function parseRecords(raw) {
  const records = [];
  let prev = '', corrupt = false;
  const lines = String(raw || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { corrupt = true; break; }
    if (!r || r.v !== VERSION || r.seq !== records.length + 1 || r.prev !== prev || r.hash !== hashRecord(r)) {
      corrupt = true; break;
    }
    records.push(r); prev = r.hash;
  }
  return { records, corrupt };
}

function analyze(records, corrupt) {
  const first = records[0] || null;
  const last = records[records.length - 1] || null;
  const intents = new Map();
  const completed = [];
  let baseCheckpoint = null;
  let latestCheckpoint = null;
  for (const r of records) {
    if (r.type === 'checkpoint') {
      if (r.payload && r.payload.phase === 'initial' && !baseCheckpoint) baseCheckpoint = r.payload;
      else latestCheckpoint = r.payload;
    }
    if (r.type === 'tool_intent' && r.payload && r.payload.callId) intents.set(String(r.payload.callId), r.payload);
    if (r.type === 'tool_result' && r.payload && r.payload.callId) {
      const callId = String(r.payload.callId);
      if (intents.has(callId)) completed.push({ intent: intents.get(callId), result: r.payload });
      intents.delete(callId);
    }
  }
  const uncertain = Array.from(intents.values());
  const terminal = !!(last && last.type === 'finish');
  const transcriptAck = !!(terminal && last.payload && last.payload.transcriptAck === true);
  let checkpoint = latestCheckpoint || baseCheckpoint || (first && first.type === 'begin' ? first.payload : {});
  if (baseCheckpoint && latestCheckpoint) {
    checkpoint = Object.assign({}, latestCheckpoint, {
      messages: (Array.isArray(baseCheckpoint.messages) ? baseCheckpoint.messages : [])
        .concat(Array.isArray(latestCheckpoint.messages) ? latestCheckpoint.messages : [])
    });
  }
  return {
    runId: first ? first.runId : '', records: records.length, corrupt: !!corrupt, terminal,
    // A terminal run event cannot prove what happened inside a tool that returned no durable result. The intent
    // remains review-required even if the loop caught an exception and cleanly emitted run.end afterward.
    status: uncertain.length ? 'needs_review' : (terminal ? (transcriptAck ? 'finished' : 'awaiting_commit') : 'resumable'),
    meta: first && first.type === 'begin' ? first.payload : {},
    uncertain, completed, baseCheckpoint: baseCheckpoint || {}, deltaCheckpoint: latestCheckpoint || {},
    checkpoint: checkpoint || {}, finish: terminal ? last.payload : null
  };
}

function makeRunJournal(opts) {
  opts = opts || {};
  const io = opts.io || makeFsIo(opts);
  // The ambient host injects real time. A pure caller that omits it gets a deterministic zero stamp.
  const now = opts.clock && typeof opts.clock.now === 'function' ? () => opts.clock.now() : () => 0;
  const redact = typeof opts.redact === 'function' ? opts.redact : s => s;
  const live = new Map();

  function record(runId, type, payload, fresh) {
    runId = String(runId || '');
    if (!runId) throw new Error('run journal runId is required');
    const prior = live.get(runId) || { seq: 0, hash: '' };
    const r = { v: VERSION, runId, seq: prior.seq + 1, ts: now(), type, payload: cloneSafe(payload || {}, redact, 0), prev: prior.hash };
    r.hash = hashRecord(r);
    const line = JSON.stringify(r);
    if (fresh) io.create(runId, line); else io.append(runId, line);
    live.set(runId, { seq: r.seq, hash: r.hash });
    return r;
  }

  return {
    begin(meta) { return record(meta && meta.runId, 'begin', meta, true); },
    checkpoint(runId, payload) { return record(runId, 'checkpoint', payload); },
    toolIntent(runId, payload) { return record(runId, 'tool_intent', payload); },
    toolResult(runId, payload) { return record(runId, 'tool_result', payload); },
    finish(runId, payload) { return record(runId, 'finish', payload); },
    remove(runId) { live.delete(String(runId || '')); io.remove(runId); },
    inspect(runId) { const p = parseRecords(io.read(runId)); return analyze(p.records, p.corrupt); },
    recoverAll() {
      const out = [];
      for (const file of io.list()) {
        let parsed;
        try { parsed = parseRecords(io.readFile(file)); }
        catch (_) { parsed = { records: [], corrupt: true }; }
        const state = analyze(parsed.records, parsed.corrupt);
        state.file = file;
        try {
          if (parsed.corrupt && parsed.records.length && typeof io.repair === 'function') {
            state.repairedFrom = io.repair(file, parsed.records);
          } else if (parsed.corrupt && !parsed.records.length && typeof io.quarantine === 'function') {
            state.quarantinedTo = io.quarantine(file);
          }
        } catch (e) { state.repairError = String((e && e.message) || e); }
        out.push(state);
        if (state.runId && parsed.records.length) {
          const last = parsed.records[parsed.records.length - 1];
          live.set(state.runId, { seq: last.seq, hash: last.hash });
        }
      }
      return out;
    },
    _internals: { parseRecords, analyze, hashRecord, runFileName, cloneSafe, writeAll }
  };
}

module.exports = { makeRunJournal, makeFsIo, _internals: { parseRecords, analyze, hashRecord, runFileName, cloneSafe, writeAll } };
