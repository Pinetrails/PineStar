'use strict';
// PS-2026-072: sealed, one-plan worker. This module cannot accept another plan,
// digest, task, model, provider, repetition count, or external endpoint.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Prepared = require('./prepared-auditor-v2-experiment.js');
const AuditV2 = require('./auditor-json-audit-v2.js');

const AUTHORIZED_DIGEST = '8fd60778992aa9c478284d8c6bf338266579eddb9759cfb60e49ad4bc34fecd3';
const RECEIPT_ID = 'auditor-matched-local-v2-repeated-v1-execution-1';
const LOOPBACK = Object.freeze({ hostname: '127.0.0.1', port: 11434 });
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function iso() { return new Date().toISOString(); }
function atomicJson(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'w' });
  fs.renameSync(temp, file);
}
function assertSealedPlan() {
  Prepared.assertPreparedPlan();
  if (Prepared.PLAN_DIGEST !== AUTHORIZED_DIGEST) throw new Error('authorized plan digest mismatch');
  if (Prepared.PLAN.planId !== 'auditor-matched-local-v2-repeated-v1' || Prepared.PLAN.slots.length !== 18) throw new Error('sealed plan mismatch');
  if (Prepared.PLAN.operationalEnvelope.provider !== 'ollama' || Prepared.PLAN.operationalEnvelope.maximumExternalCostUsd !== 0) throw new Error('local zero-cost boundary mismatch');
}
function paths(root) {
  const receiptDir = path.join(root, RECEIPT_ID);
  return { root, receiptDir, receipt: path.join(receiptDir, 'receipt.json'), raw: path.join(receiptDir, 'raw'), stop: path.join(receiptDir, 'STOP'), lock: path.join(receiptDir, 'worker.lock'), log: path.join(receiptDir, 'worker.log') };
}
function sourcePath(workspace, task) { return path.join(workspace, task.immutableSnapshotRef); }
function initialReceipt(workspace) {
  assertSealedPlan();
  const createdAt = iso();
  return {
    schema: 'pine-star.auditor-v2-durable-receipt.v1', receiptId: RECEIPT_ID,
    planId: Prepared.PLAN.planId, planDigest: AUTHORIZED_DIGEST, contract: Prepared.PLAN.taskContractVersion,
    status: 'ready', createdAt, startedAt: null, endedAt: null, workerPid: null,
    externalCostUsd: 0, launchCount: 0, maximumLaunches: 18, prewarmEvidence: false,
    retryCount: 0, recurrence: false, activeProductionConfiguration: Prepared.PLAN.champion.configurationId,
    challengerProductionActive: false, workspace,
    slots: Prepared.PLAN.slots.map((slot) => ({ ...slot, state: 'pending', claimOrdinal: null, claimedAt: null, startedAt: null, endedAt: null, runtimeMs: null, objectiveId: 'objective:' + sha(Buffer.from(RECEIPT_ID + ':' + slot.slotId)).slice(0, 36), runId: null, completion: null, timeoutClassification: null, rawOutputRef: null, rawOutputSha256: null, parsedClaim: null, mechanicalTruth: null, disagreement: null, agreement: false, usage: 'UNKNOWN', costUsd: 0, recovery: [], safetyExceptions: [], uncertainty: ['usage/tokens UNKNOWN until genuinely returned by Ollama'], provenanceRefs: [taskRef(slot.taskId)] }))
  };
}
function taskRef(taskId) { return Prepared.PLAN.tasks.find((task) => task.taskId === taskId).immutableSnapshotRef; }
function validateReceipt(receipt) {
  assertSealedPlan();
  if (!receipt || receipt.receiptId !== RECEIPT_ID || receipt.planDigest !== AUTHORIZED_DIGEST || receipt.planId !== Prepared.PLAN.planId) throw new Error('receipt identity mismatch');
  if (!Array.isArray(receipt.slots) || receipt.slots.length !== 18 || new Set(receipt.slots.map((s) => s.slotId)).size !== 18) throw new Error('receipt slot mismatch');
  for (const planned of Prepared.PLAN.slots) {
    const actual = receipt.slots.find((s) => s.slotId === planned.slotId);
    for (const key of ['pairId', 'arm', 'taskId', 'repetition', 'inputHash', 'instructionHash']) if (!actual || actual[key] !== planned[key]) throw new Error('receipt slot binding mismatch: ' + planned.slotId);
  }
  if (receipt.launchCount > 18) throw new Error('launch ceiling violated');
  return receipt;
}
function acquireLock(file) {
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, acquiredAt: iso() }), { flag: 'wx' }); return; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  let owner = null; try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  if (owner && Number.isInteger(owner.pid)) { try { process.kill(owner.pid, 0); throw new Error('worker already active: ' + owner.pid); } catch (error) { if (!['ESRCH', 'EINVAL'].includes(error.code)) throw error; } }
  const stale = file + '.stale-' + Date.now(); fs.renameSync(file, stale);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, acquiredAt: iso(), replacedStaleLock: path.basename(stale) }), { flag: 'wx' });
}
function initialize(root, workspace) {
  const p = paths(root);
  if (fs.existsSync(p.receipt)) throw new Error('receipt already exists; creation is one-shot');
  fs.mkdirSync(p.raw, { recursive: true });
  const receipt = initialReceipt(workspace);
  for (const task of Prepared.PLAN.tasks) {
    const bytes = fs.readFileSync(sourcePath(workspace, task));
    if (sha(bytes) !== task.inputHash) throw new Error('snapshot hash mismatch: ' + task.taskId);
    if (sha(Buffer.from(AuditV2.instruction(task.taskId, task.inputHash, Prepared.PLAN.champion))) !== task.instructionHash) throw new Error('instruction hash mismatch: ' + task.taskId);
  }
  atomicJson(p.receipt, receipt);
  return receipt;
}
function reconcileClaimed(receipt, now) {
  let changed = false;
  for (const slot of receipt.slots) if (slot.state === 'claimed') {
    slot.state = 'cancelled'; slot.completion = 'interrupted'; slot.endedAt = now;
    slot.timeoutClassification = 'not-timeout'; slot.recovery.push({ at: now, action: 'claimed-slot-reconciled-without-relaunch' });
    slot.uncertainty.push('process ended while claimed; inference completion and usage UNKNOWN'); changed = true;
  }
  return changed;
}
function requestOllama(model, prompt, input, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model, prompt: prompt + '\n\nSNAPSHOT:\n' + input.toString('utf8'), stream: false, keep_alive: '5m', options: { temperature: 0 } }));
    let settled = false; let headerTimer; let idleTimer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(headerTimer); clearTimeout(idleTimer); signal && signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const req = http.request({ ...LOOPBACK, path: '/api/generate', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (res) => {
      clearTimeout(headerTimer); const chunks = [];
      const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { req.destroy(Object.assign(new Error('stream idle timeout'), { code: 'STREAM_IDLE_TIMEOUT' })); }, 300000); };
      resetIdle(); res.on('data', (chunk) => { chunks.push(chunk); resetIdle(); });
      res.on('end', () => { clearTimeout(idleTimer); const body = Buffer.concat(chunks); if (res.statusCode !== 200) return finish(Object.assign(new Error('Ollama HTTP ' + res.statusCode), { body })); try { finish(null, JSON.parse(body.toString('utf8'))); } catch (e) { finish(e); } });
    });
    const abort = () => req.destroy(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    req.on('error', (error) => finish(error));
    headerTimer = setTimeout(() => req.destroy(Object.assign(new Error('first response timeout'), { code: 'FIRST_RESPONSE_TIMEOUT' })), timeoutMs);
    signal && signal.addEventListener('abort', abort, { once: true }); req.end(payload);
  });
}
function lifecycle(model, keepAlive) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ model, prompt: '', stream: false, keep_alive: keepAlive }));
    const req = http.request({ ...LOOPBACK, path: '/api/generate', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (res) => { res.resume(); res.on('end', resolve); });
    req.setTimeout(240000, () => req.destroy()); req.on('error', resolve); req.end(payload);
  });
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function run(root) {
  const p = paths(root); acquireLock(p.lock); let receipt = validateReceipt(JSON.parse(fs.readFileSync(p.receipt, 'utf8'))); const now = iso();
  if (reconcileClaimed(receipt, now)) atomicJson(p.receipt, receipt);
  if (receipt.status === 'completed' || receipt.status === 'cancelled' || receipt.status === 'failed') { fs.unlinkSync(p.lock); return receipt; }
  receipt.status = 'running'; receipt.startedAt ||= now; receipt.workerPid = process.pid; atomicJson(p.receipt, receipt);
  const controller = new AbortController(); let stopping = false;
  const stop = () => { stopping = true; controller.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const stopPoll = setInterval(() => { if (fs.existsSync(p.stop)) stop(); }, 1000);
  const wallTimer = setTimeout(stop, Prepared.PLAN.wallEnvelope.maximumPlannedMs);
  try {
    for (const arm of ['champion', 'challenger']) {
      if (stopping || fs.existsSync(p.stop)) break;
      const config = Prepared.PLAN[arm]; await lifecycle(config.model, '5m');
      for (const slot of receipt.slots.filter((s) => s.arm === arm)) {
        if (stopping || fs.existsSync(p.stop)) break;
        if (TERMINAL.has(slot.state)) continue;
        if (slot.state !== 'pending') throw new Error('non-pending slot cannot launch: ' + slot.slotId);
        if (receipt.launchCount >= 18) throw new Error('launch ceiling reached');
        const task = Prepared.PLAN.tasks.find((t) => t.taskId === slot.taskId); const bytes = fs.readFileSync(sourcePath(receipt.workspace, task));
        const instruction = AuditV2.instruction(task.taskId, task.inputHash, Prepared.PLAN.champion);
        if (sha(bytes) !== slot.inputHash || sha(Buffer.from(instruction)) !== slot.instructionHash) throw new Error('matched identity check failed: ' + slot.slotId);
        slot.state = 'claimed'; slot.claimOrdinal = receipt.launchCount + 1; slot.claimedAt = iso(); slot.startedAt = slot.claimedAt;
        slot.runId = 'run:' + sha(Buffer.from(RECEIPT_ID + ':' + slot.slotId + ':run')).slice(0, 36); receipt.launchCount += 1; atomicJson(p.receipt, receipt);
        const started = Date.now();
        try {
          const result = await requestOllama(config.model, instruction, bytes, 240000, controller.signal); const raw = String(result.response === undefined ? '' : result.response);
          const rawFile = path.join(p.raw, slot.slotId + '.txt'); fs.writeFileSync(rawFile, raw, { encoding: 'utf8', flag: 'wx' });
          slot.rawOutputRef = path.relative(p.receiptDir, rawFile).replace(/\\/g, '/'); slot.rawOutputSha256 = sha(Buffer.from(raw));
          slot.parsedClaim = AuditV2.parseModel(raw); slot.mechanicalTruth = AuditV2.expected(task.taskId, bytes, Prepared.PLAN.champion);
          slot.agreement = !!slot.parsedClaim && same(slot.parsedClaim, slot.mechanicalTruth);
          slot.disagreement = slot.agreement ? null : { parsedClaim: slot.parsedClaim, mechanicalTruth: slot.mechanicalTruth };
          slot.usage = Number.isInteger(result.prompt_eval_count) || Number.isInteger(result.eval_count) ? { promptTokens: Number.isInteger(result.prompt_eval_count) ? result.prompt_eval_count : 'UNKNOWN', completionTokens: Number.isInteger(result.eval_count) ? result.eval_count : 'UNKNOWN' } : 'UNKNOWN';
          slot.state = slot.agreement ? 'completed' : 'failed'; slot.completion = slot.agreement ? 'correct' : (slot.parsedClaim ? 'incorrect' : 'invalid-v2-format'); slot.timeoutClassification = 'not-timeout';
        } catch (error) {
          slot.state = error.code === 'CANCELLED' ? 'cancelled' : 'failed'; slot.completion = error.code === 'CANCELLED' ? 'cancelled/interrupted' : 'provider-failure';
          slot.timeoutClassification = error.code === 'FIRST_RESPONSE_TIMEOUT' ? 'first-response-timeout-240000ms' : error.code === 'STREAM_IDLE_TIMEOUT' ? 'stream-idle-timeout-300000ms' : 'not-timeout';
          slot.mechanicalTruth = AuditV2.expected(task.taskId, bytes, Prepared.PLAN.champion); slot.disagreement = { parsedClaim: null, mechanicalTruth: slot.mechanicalTruth };
          slot.uncertainty.push('model output and usage unavailable: ' + String(error.message || error));
        }
        slot.runtimeMs = Date.now() - started; slot.endedAt = iso(); atomicJson(p.receipt, receipt);
      }
      await lifecycle(config.model, 0);
    }
    const pending = receipt.slots.filter((s) => s.state === 'pending');
    if (stopping || pending.length) {
      const at = iso(); for (const slot of pending) { slot.state = 'cancelled'; slot.completion = 'never-launched-cancelled'; slot.endedAt = at; slot.timeoutClassification = 'not-timeout'; }
      receipt.status = 'cancelled';
    } else receipt.status = 'completed';
  } catch (error) {
    receipt.status = 'failed'; receipt.workerError = String(error && (error.stack || error));
  } finally {
    clearInterval(stopPoll); clearTimeout(wallTimer); receipt.endedAt = iso(); receipt.workerPid = null; atomicJson(p.receipt, receipt); fs.unlinkSync(p.lock);
  }
  return receipt;
}

module.exports = { AUTHORIZED_DIGEST, RECEIPT_ID, TERMINAL, paths, initialReceipt, initialize, validateReceipt, reconcileClaimed, acquireLock, run };
