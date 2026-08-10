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
  let resolution = null;
  let finishPayload = null;
  let continuation = null;
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
    if (r.type === 'resolution' && r.payload) resolution = r.payload;
    if (r.type === 'finish') finishPayload = r.payload || {};
    if (r.type === 'continuation_ready' && r.payload) continuation = Object.assign({ state: 'ready' }, r.payload);
    if (r.type === 'continuation_start' && r.payload && continuation) continuation = Object.assign({}, continuation, r.payload, { state: 'started' });
    if (r.type === 'continuation_finish' && r.payload && continuation) continuation = Object.assign({}, continuation, r.payload, { state: 'finished' });
  }
  // An explicit read intent is safe to replay from the provider-valid checkpoint: it cannot have changed host
  // state before the missing result boundary. Legacy/unknown intents remain conservative (review-required), as
  // do all declared mutations. Keep the reads visible separately so recovery UIs and receipts can prove exactly
  // what will be re-dispatched instead of silently treating them as completed.
  const pending = Array.from(intents.values());
  const replayableReads = pending.filter(intent => intent && intent.mutating === false);
  const uncertain = pending.filter(intent => !intent || intent.mutating !== false);
  const terminal = finishPayload !== null;
  const transcriptAck = !!(terminal && finishPayload.transcriptAck === true);
  let checkpoint = latestCheckpoint || baseCheckpoint || (first && first.type === 'begin' ? first.payload : {});
  if (baseCheckpoint && latestCheckpoint) {
    checkpoint = Object.assign({}, latestCheckpoint, {
      messages: (Array.isArray(baseCheckpoint.messages) ? baseCheckpoint.messages : [])
        .concat(Array.isArray(latestCheckpoint.messages) ? latestCheckpoint.messages : [])
    });
  }
  const uncertainIds = uncertain.map(x => String(x.callId || '')).sort();
  const resolutionIds = resolution && Array.isArray(resolution.outcomes)
    ? resolution.outcomes.map(x => String((x && x.callId) || '')).sort() : [];
  const resolutionValid = !!(resolution && uncertainIds.length && stable(uncertainIds) === stable(resolutionIds)
    && resolution.outcomes.every(x => x && /^(?:happened|did_not_happen|unknown)$/.test(String(x.outcome || ''))));
  return {
    runId: first ? first.runId : '', records: records.length, corrupt: !!corrupt, terminal,
    // A terminal run event cannot prove what happened inside a tool that returned no durable result. The intent
    // remains review-required even if the loop caught an exception and cleanly emitted run.end afterward.
    status: resolutionValid ? 'resolved' : (uncertain.length ? 'needs_review' : (terminal ? (transcriptAck ? 'finished' : 'awaiting_commit') : 'resumable')),
    meta: first && first.type === 'begin' ? first.payload : {},
    uncertain, replayableReads, completed, baseCheckpoint: baseCheckpoint || {}, deltaCheckpoint: latestCheckpoint || {},
    checkpoint: checkpoint || {}, finish: finishPayload,
    resolution: resolutionValid ? resolution : null,
    continuation: resolutionValid ? continuation : null
  };
}

function resolutionError(message) {
  const e = new Error(message); e.code = 'RUN_RESOLUTION_CONFLICT'; return e;
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

  function inspect(runId) {
    const p = parseRecords(io.read(runId));
    return analyze(p.records, p.corrupt);
  }

  function recoverFile(file) {
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
    if (state.runId && parsed.records.length) {
      const last = parsed.records[parsed.records.length - 1];
      live.set(state.runId, { seq: last.seq, hash: last.hash });
    }
    return state;
  }

  return {
    begin(meta) { return record(meta && meta.runId, 'begin', meta, true); },
    checkpoint(runId, payload) { return record(runId, 'checkpoint', payload); },
    toolIntent(runId, payload) { return record(runId, 'tool_intent', payload); },
    toolResult(runId, payload) { return record(runId, 'tool_result', payload); },
    finish(runId, payload) { return record(runId, 'finish', payload); },
    resolve(runId, payload) {
      payload = payload || {};
      const state = inspect(runId);
      const normalized = {
        resolutionId: String(payload.resolutionId || ''),
        operator: String(payload.operator || 'local'),
        resolvedAt: Number(payload.resolvedAt || now()),
        outcomes: (Array.isArray(payload.outcomes) ? payload.outcomes : []).map(x => ({
          callId: String((x && x.callId) || ''), outcome: String((x && x.outcome) || '')
        })),
        note: String(payload.note || '').slice(0, 500)
      };
      if (!normalized.resolutionId) throw resolutionError('resolutionId is required');
      if (state.resolution) {
        const existing = state.resolution;
        const sameDecision = existing.resolutionId === normalized.resolutionId
          && stable(existing.outcomes || []) === stable(normalized.outcomes)
          && String(existing.note || '') === normalized.note;
        if (sameDecision) return state;
        throw resolutionError('run already has a different durable resolution');
      }
      if (state.status !== 'needs_review' || state.corrupt) throw resolutionError('run is not safely resolvable');
      const expected = state.uncertain.map(x => String(x.callId || '')).sort();
      const actual = normalized.outcomes.map(x => x.callId).sort();
      if (!expected.length || stable(expected) !== stable(actual)
        || new Set(actual).size !== actual.length
        || normalized.outcomes.some(x => !/^(?:happened|did_not_happen|unknown)$/.test(x.outcome))) {
        throw resolutionError('resolution must account for every uncertain call exactly once');
      }
      record(runId, 'resolution', normalized);
      return inspect(runId);
    },
    prepareContinuation(runId, payload) {
      payload = payload || {};
      const state = inspect(runId);
      const continuationId = String(payload.continuationId || '');
      if (!continuationId) throw resolutionError('continuationId is required');
      if (state.continuation) {
        if (state.continuation.continuationId === continuationId) return state;
        throw resolutionError('run already has a different durable continuation');
      }
      if (state.status !== 'resolved' || !state.resolution || state.corrupt) throw resolutionError('run is not safely continuable');
      record(runId, 'continuation_ready', {
        continuationId,
        operator: String(payload.operator || 'local'),
        preparedAt: Number(payload.preparedAt || now()),
        blockedFingerprints: (Array.isArray(payload.blockedFingerprints) ? payload.blockedFingerprints : []).map(String).sort(),
        context: String(payload.context || '').slice(0, 4000)
      });
      return inspect(runId);
    },
    startContinuation(runId, payload) {
      payload = payload || {};
      const state = inspect(runId);
      const continuationId = String(payload.continuationId || '');
      const continuedRunId = String(payload.continuedRunId || '');
      if (!state.continuation || state.continuation.continuationId !== continuationId) throw resolutionError('continuation was not durably prepared');
      if (state.continuation.state !== 'ready') {
        if (state.continuation.continuedRunId === continuedRunId) return state;
        throw resolutionError('continuation already started');
      }
      if (!continuedRunId) throw resolutionError('continuedRunId is required');
      record(runId, 'continuation_start', { continuationId, continuedRunId, startedAt: Number(payload.startedAt || now()) });
      return inspect(runId);
    },
    finishContinuation(runId, payload) {
      payload = payload || {};
      const state = inspect(runId);
      const continuationId = String(payload.continuationId || '');
      const continuedRunId = String(payload.continuedRunId || '');
      if (!state.continuation || state.continuation.continuationId !== continuationId
        || state.continuation.continuedRunId !== continuedRunId) throw resolutionError('continuation identity does not match');
      if (state.continuation.state === 'finished') return state;
      if (state.continuation.state !== 'started') throw resolutionError('continuation has not started');
      record(runId, 'continuation_finish', {
        continuationId, continuedRunId, finishedAt: Number(payload.finishedAt || now()),
        reason: String(payload.reason || 'unknown')
      });
      return inspect(runId);
    },
    finishAndRetire(runId, payload) {
      record(runId, 'finish', payload);
      const state = inspect(runId);
      if (state.status !== 'finished') return { retired: false, state };
      const retired = this.remove(runId);
      return { retired: !!retired, state };
    },
    // Retirement is a safety boundary, not a raw unlink. A terminal record does not settle an unmatched tool
    // intent: that journal is the only durable evidence that a side effect may have happened, so ordinary host
    // teardown must retain it for review. Corrupt/unreadable journals also fail closed and remain recoverable.
    remove(runId) {
      let state;
      try { state = inspect(runId); } catch (_) { return false; }
      if (!state || state.status !== 'finished') return false;
      live.delete(String(runId || ''));
      io.remove(runId);
      return true;
    },
    inspect,
    recoverAll() {
      return io.list().sort().map(recoverFile);
    },
    // Lazy/paged recovery preserves every journal while preventing thousands of failed runs
    // from blocking process startup or producing one unbounded API response. Stable filename
    // ordering makes offset pagination deterministic; no file is deleted here.
    recoverPage(options) {
      options = options || {};
      const files = io.list().sort();
      const offset = Math.max(0, Number(options.offset) || 0);
      const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
      return { rows: files.slice(offset, offset + limit).map(recoverFile), total: files.length, offset, limit };
    },
    _internals: { parseRecords, analyze, hashRecord, runFileName, cloneSafe, writeAll }
  };
}

module.exports = { makeRunJournal, makeFsIo, _internals: { parseRecords, analyze, hashRecord, runFileName, cloneSafe, writeAll } };
