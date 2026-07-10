#!/usr/bin/env node
/* StarNet product-perfection controller.
 *
 * The tracked manifest defines goals; this program derives state from verifier receipts. A receipt
 * is valid only for an exact clean commit and the exact manifest/wave definition. Source or policy
 * drift therefore re-queues proof automatically. There is intentionally no mutable "done" flag.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'qa', 'product-perfect', 'waves.json');
export const DEFAULT_RUNTIME_DIR = path.join(REPO_ROOT, '.dogfood', 'product-perfect');
const RECEIPT_SCHEMA = 1;

function str(value) { return value == null ? '' : String(value); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function definitionHash(value) { return sha256(stableJson(value)); }

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['manifest must be an object'] };
  if (manifest.schemaVersion !== 1) errors.push('manifest schemaVersion must be 1');
  if (!Array.isArray(manifest.waves) || manifest.waves.length === 0) errors.push('manifest must contain at least one wave');
  const seen = new Set();
  for (let index = 0; index < (Array.isArray(manifest.waves) ? manifest.waves.length : 0); index += 1) {
    const wave = manifest.waves[index] || {};
    const label = 'waves[' + index + ']';
    if (!/^[A-Z][A-Z0-9-]*$/.test(str(wave.id))) errors.push(label + '.id must be a stable uppercase ID');
    if (seen.has(wave.id)) errors.push(label + '.id is duplicated: ' + wave.id);
    seen.add(wave.id);
    if (!str(wave.name).trim()) errors.push(label + '.name is required');
    if (!str(wave.goal).trim()) errors.push(label + '.goal is required');
    if (!Array.isArray(wave.conditions) || wave.conditions.length === 0 || wave.conditions.some(item => !str(item).trim())) {
      errors.push(label + '.conditions must contain non-blank conditions');
    }
    if (!Array.isArray(wave.dependsOn)) errors.push(label + '.dependsOn must be an array');
    else {
      const expected = index === 0 ? [] : [manifest.waves[index - 1] && manifest.waves[index - 1].id];
      if (stableJson(wave.dependsOn) !== stableJson(expected)) {
        errors.push(label + '.dependsOn must serialize the campaign (' + expected.join(', ') + ')');
      }
    }
    const command = wave.verifier && wave.verifier.command;
    if (!Array.isArray(command) || command.length < 2 || command.some(part => !str(part).trim())) {
      errors.push(label + '.verifier.command must be a non-empty argv array');
    }
    const timeoutMs = Number(wave.verifier && wave.verifier.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) errors.push(label + '.verifier.timeoutMs must be at least 1000');
  }
  return { ok: errors.length === 0, errors };
}

export function receiptValidity(receipt, context) {
  const errors = [];
  context = context || {};
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { ok: false, errors: ['receipt missing or unreadable'] };
  if (receipt.schemaVersion !== RECEIPT_SCHEMA) errors.push('receipt schema mismatch');
  if (receipt.result !== 'PASS') errors.push('receipt result is ' + (receipt.result || 'missing'));
  if (receipt.waveId !== context.wave.id) errors.push('wave ID mismatch');
  if (receipt.candidateSha !== context.candidate.sha) errors.push('candidate commit mismatch');
  if (receipt.manifestHash !== context.manifestHash) errors.push('manifest definition changed');
  if (receipt.waveDefinitionHash !== definitionHash(context.wave)) errors.push('wave definition changed');
  if (!context.candidate.clean) errors.push('working tree is dirty');
  if (!Number.isInteger(receipt.exitCode) || receipt.exitCode !== 0) errors.push('verifier did not exit zero');
  if (!str(receipt.startedAt) || !Number.isFinite(Date.parse(receipt.startedAt))) errors.push('startedAt missing or invalid');
  if (!str(receipt.finishedAt) || !Number.isFinite(Date.parse(receipt.finishedAt))) errors.push('finishedAt missing or invalid');
  return { ok: errors.length === 0, errors };
}

export function deriveStatus(manifest, candidate, receiptsByWave) {
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    return {
      productPerfect: false,
      verdict: 'NOT PRODUCT PERFECT',
      currentWave: null,
      candidate,
      manifestErrors: validation.errors,
      waves: [],
      nextAction: 'Repair the product-perfect manifest before running any wave.'
    };
  }
  const manifestHash = definitionHash(manifest);
  const waves = [];
  let previousPass = true;
  let currentWave = null;
  for (const wave of manifest.waves) {
    const receipt = receiptsByWave && receiptsByWave[wave.id];
    const validity = receiptValidity(receipt, { wave, candidate, manifestHash });
    let status = 'pending';
    let reasons = [];
    if (previousPass) {
      if (validity.ok) status = 'pass';
      else {
        status = receipt && receipt.result === 'FAIL' ? 'fail'
          : receipt && receipt.result === 'BLOCKED' ? 'blocked'
            : receipt ? 'blocked' : (candidate.clean ? 'pending' : 'blocked');
        reasons = validity.errors;
        if (!currentWave) currentWave = wave.id;
        previousPass = false;
      }
    } else {
      status = 'pending';
      reasons = ['dependency not current and passing'];
    }
    waves.push({
      id: wave.id,
      name: wave.name,
      status,
      goal: wave.goal,
      reasons,
      receipt: receipt ? {
        result: receipt.result,
        candidateSha: receipt.candidateSha,
        finishedAt: receipt.finishedAt,
        exitCode: receipt.exitCode
      } : null
    });
  }
  const productPerfect = waves.length > 0 && waves.every(wave => wave.status === 'pass');
  const active = manifest.waves.find(wave => wave.id === currentWave);
  return {
    productPerfect,
    verdict: productPerfect ? str(manifest.terminalVerdict || 'PRODUCT PERFECT') : 'NOT PRODUCT PERFECT',
    currentWave: productPerfect ? null : currentWave,
    candidate,
    manifestHash,
    waves,
    nextAction: productPerfect
      ? 'Pause the controller and report the immutable candidate receipt. Do not publish.'
      : active
        ? 'Run and repair ' + active.id + ' — ' + active.name + ': ' + active.goal
        : 'Repair unverifiable campaign state.'
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
  return { code: result.status, out: str(result.stdout).trim(), err: str(result.stderr).trim(), error: result.error };
}

export function currentCandidate() {
  const head = git(['rev-parse', 'HEAD']);
  if (head.code !== 0 || !/^[0-9a-f]{40}$/i.test(head.out)) throw new Error('could not resolve exact Git HEAD: ' + (head.err || (head.error && head.error.message) || 'unknown error'));
  const status = git(['status', '--porcelain=v1', '--untracked-files=normal']);
  if (status.code !== 0) throw new Error('could not inspect working tree: ' + (status.err || (status.error && status.error.message) || 'unknown error'));
  return { sha: head.out.toLowerCase(), clean: status.out === '', dirtyPaths: status.out ? status.out.split(/\r?\n/).filter(Boolean) : [] };
}

function receiptDir(runtimeDir, candidate) { return path.join(runtimeDir, 'receipts', candidate.sha); }
function receiptFile(runtimeDir, candidate, waveId) { return path.join(receiptDir(runtimeDir, candidate), waveId + '.json'); }

export function loadReceipts(manifest, candidate, runtimeDir = DEFAULT_RUNTIME_DIR) {
  const out = {};
  for (const wave of manifest.waves || []) {
    const receipt = readJson(receiptFile(runtimeDir, candidate, wave.id));
    if (receipt) out[wave.id] = receipt;
  }
  return out;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

function digestOutput(value) {
  const text = str(value);
  return { bytes: Buffer.byteLength(text), sha256: sha256(text) };
}

function resolveVerifier(command) {
  const argv = command.map(str);
  let executable = argv[0];
  const args = argv.slice(1);
  if (executable === 'node') executable = process.execPath;
  if (executable === process.execPath && args[0] && !path.isAbsolute(args[0])) {
    const script = path.resolve(REPO_ROOT, args[0]);
    if (!fs.existsSync(script)) return { blocked: 'verifier script is missing: ' + args[0], executable, args };
  }
  return { executable, args };
}

export function runWaveVerifier(manifest, wave, candidate, runtimeDir = DEFAULT_RUNTIME_DIR, now = () => new Date()) {
  const manifestHash = definitionHash(manifest);
  const waveDefinitionHash = definitionHash(wave);
  const startedAt = now().toISOString();
  const resolved = resolveVerifier(wave.verifier.command);
  let child = null;
  let result = 'BLOCKED';
  let exitCode = null;
  let signal = null;
  let blockReason = resolved.blocked || '';
  if (!blockReason) {
    child = spawnSync(resolved.executable, resolved.args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: Number(wave.verifier.timeoutMs),
      maxBuffer: 16 * 1024 * 1024,
      env: Object.assign({}, process.env, {
        STARNET_PRODUCT_PERFECT_CANDIDATE_SHA: candidate.sha,
        STARNET_PRODUCT_PERFECT_MANIFEST_HASH: manifestHash,
        STARNET_PRODUCT_PERFECT_WAVE: wave.id
      })
    });
    exitCode = Number.isInteger(child.status) ? child.status : null;
    signal = child.signal || null;
    if (child.error) blockReason = child.error.message;
    result = exitCode === 0 ? 'PASS' : (exitCode === 2 || exitCode == null || blockReason ? 'BLOCKED' : 'FAIL');
    try {
      const after = currentCandidate();
      if (after.sha !== candidate.sha || !after.clean) {
        result = 'BLOCKED';
        blockReason = 'source changed or became dirty while verifier was running';
      }
    } catch (error) {
      result = 'BLOCKED';
      blockReason = 'could not reverify source after gate: ' + error.message;
    }
  }
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    waveId: wave.id,
    waveName: wave.name,
    candidateSha: candidate.sha,
    manifestHash,
    waveDefinitionHash,
    result,
    exitCode,
    signal,
    startedAt,
    finishedAt: now().toISOString(),
    verifier: wave.verifier.command,
    verifierOutput: {
      stdout: digestOutput(child && child.stdout),
      stderr: digestOutput(child && child.stderr)
    },
    blockReason
  };
  atomicJson(receiptFile(runtimeDir, candidate, wave.id), receipt);
  return { receipt, stdout: str(child && child.stdout), stderr: str(child && child.stderr) };
}

function render(status) {
  const lines = [];
  lines.push(status.verdict + (status.productPerfect ? ' @ ' + status.candidate.sha : ' — current ' + (status.currentWave || 'unverifiable')));
  lines.push('candidate ' + (status.candidate && status.candidate.sha ? status.candidate.sha : '(unknown)') + ' · ' + (status.candidate && status.candidate.clean ? 'clean' : 'DIRTY'));
  if (status.manifestErrors) for (const error of status.manifestErrors) lines.push('  [BLOCKED] manifest — ' + error);
  for (const wave of status.waves || []) {
    lines.push('  [' + wave.status.toUpperCase() + '] ' + wave.id + ' · ' + wave.name);
    if (wave.id === status.currentWave) for (const reason of wave.reasons || []) lines.push('      - ' + reason);
  }
  lines.push('next: ' + status.nextAction);
  return lines.join('\n');
}

function outputTail(text, max = 4000) {
  text = str(text).trim();
  if (!text) return '';
  return text.length > max ? '…' + text.slice(-max) : text;
}

const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; }
  catch (_) { return false; }
})();

if (INVOKED_DIRECTLY) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const statusOnly = args.includes('--status');
  const waveIndex = args.indexOf('--wave');
  const requestedWave = waveIndex >= 0 ? str(args[waveIndex + 1]).toUpperCase() : '';
  const manifest = readJson(DEFAULT_MANIFEST);
  let candidate;
  try { candidate = currentCandidate(); }
  catch (error) {
    const blocked = { productPerfect: false, verdict: 'NOT PRODUCT PERFECT', currentWave: null, candidate: { sha: '', clean: false }, waves: [], nextAction: error.message };
    console.log(jsonMode ? JSON.stringify(blocked, null, 2) : render(blocked));
    process.exit(2);
  }
  let receipts = manifest ? loadReceipts(manifest, candidate) : {};
  let status = deriveStatus(manifest, candidate, receipts);
  if (statusOnly) {
    console.log(jsonMode ? JSON.stringify(status, null, 2) : render(status));
    process.exit(status.productPerfect ? 0 : 2);
  }
  if (!candidate.clean) {
    console.log(jsonMode ? JSON.stringify(status, null, 2) : render(status));
    process.exit(2);
  }
  if (status.manifestErrors) {
    console.log(jsonMode ? JSON.stringify(status, null, 2) : render(status));
    process.exit(2);
  }

  const runOne = (wave) => {
    const priorIds = wave.dependsOn || [];
    const latest = deriveStatus(manifest, candidate, receipts);
    const unmet = priorIds.filter(id => !latest.waves.some(item => item.id === id && item.status === 'pass'));
    if (unmet.length) return { blocked: 'dependencies not current and passing: ' + unmet.join(', ') };
    const run = runWaveVerifier(manifest, wave, candidate);
    receipts = loadReceipts(manifest, candidate);
    return run;
  };

  let lastRun = null;
  if (requestedWave) {
    const wave = manifest.waves.find(item => item.id === requestedWave);
    if (!wave) {
      console.error('unknown wave ' + requestedWave);
      process.exit(2);
    }
    lastRun = runOne(wave);
    if (lastRun.blocked) {
      console.error(lastRun.blocked);
      process.exit(2);
    }
  } else {
    for (const wave of manifest.waves) {
      status = deriveStatus(manifest, candidate, receipts);
      const row = status.waves.find(item => item.id === wave.id);
      if (row && row.status === 'pass') continue;
      lastRun = runOne(wave);
      if (lastRun.blocked || lastRun.receipt.result !== 'PASS') break;
    }
  }

  status = deriveStatus(manifest, candidate, receipts);
  atomicJson(path.join(DEFAULT_RUNTIME_DIR, 'product-perfect-status.json'), status);
  if (jsonMode) console.log(JSON.stringify({ status, lastReceipt: lastRun && lastRun.receipt }, null, 2));
  else {
    if (lastRun && outputTail(lastRun.stdout)) console.log(outputTail(lastRun.stdout));
    if (lastRun && outputTail(lastRun.stderr)) console.error(outputTail(lastRun.stderr));
    console.log(render(status));
  }
  const lastResult = lastRun && lastRun.receipt && lastRun.receipt.result;
  process.exit(status.productPerfect || (requestedWave && lastResult === 'PASS') ? 0 : (lastResult === 'FAIL' ? 1 : 2));
}
