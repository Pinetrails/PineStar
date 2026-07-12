#!/usr/bin/env node
/*
 * W1 installed first-value journey.
 *
 * This is deliberately stricter than Beginner Run. It attaches to an already-running,
 * genuinely installed Tauri desktop through CDP and proves one fresh-user result:
 *
 *   visible provider failure -> attended recovery -> Overseer creation -> the tutorial's
 *   real fs.write/fs.read hello.txt task -> independently hashed file -> real OPEN click.
 *
 * A provider reply is never a deliverable. Browser/dev, existing-user, unattested isolation,
 * mismatched candidate/artifact, missing credentials, synthetic files, and an unobserved OPEN
 * all fail closed. Credential bytes are accepted only as an attended runtime input and are
 * never copied into logs or evidence.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectCDP, evalJS, sleep } from '../lib/cdp.mjs';
import { KINDS } from './product-perfect/provenance.mjs';

export const MAX_JOURNEY_MS = 10 * 60 * 1000;
export const RECEIPT_SCHEMA = 1;
export const LINK_RECEIPT_SCHEMA = 1;
export const RESULTS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLOCKED' });
export const FIRST_TASK_ID = 'tutorial-hello-file-v1';
export const FIRST_TASK_PATH = 'hello.txt';
export const FIRST_TASK_CONTENT = 'starnet online';
export const TAURI_ORIGINS = new Set([
  'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'app://localhost'
]);

const RESULT_SET = new Set(Object.values(RESULTS));
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;
const ISOLATION_AUTHORITIES = new Set(['separate-windows-user', 'virtual-machine', 'clean-machine']);
const BYOK_PROVIDERS = new Set([
  'openrouter', 'openai', 'anthropic', 'gemini', 'xai', 'groq', 'mistral',
  'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras'
]);

const str = value => value == null ? '' : String(value);
const lower = value => str(value).trim().toLowerCase();
const basename = value => str(value).replace(/\\/g, '/').split('/').pop();
const sha256Text = value => crypto.createHash('sha256').update(str(value), 'utf8').digest('hex');

function normalizedArtifact(value) {
  if (!value || typeof value !== 'object') return null;
  const sha256 = lower(value.sha256);
  const size = Number(value.size);
  const file = str(value.path).trim();
  if (!file || !SHA256.test(sha256) || !Number.isSafeInteger(size) || size <= 0) return null;
  return { path: file, sha256, size };
}

function normalizedEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  const file = str(value.path).trim().replace(/\\/g, '/');
  const sha256 = lower(value.sha256);
  const size = Number(value.size);
  if (!file || !SHA256.test(sha256) || !Number.isSafeInteger(size) || size <= 0) return null;
  return { path: file, sha256, size };
}

export function containsSecretMaterial(text, secrets = []) {
  const body = str(text);
  for (const secret of secrets) {
    const s = str(secret);
    if (s.length >= 6 && body.includes(s)) return true;
  }
  return /(?:sk|xox[baprs]|gh[pousr])-[A-Za-z0-9_\-]{12,}/i.test(body)
    || /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*["'=:\s]+(?:bearer\s+)?[A-Za-z0-9._\-]{12,}/i.test(body)
    || /[?&](?:token|key|secret)=[^\s&#]+/i.test(body);
}

export function validateInstalledIdentity(observed, expected) {
  observed = observed || {}; expected = expected || {};
  const errors = [];
  const candidateCommit = lower(expected.candidateCommit);
  const candidateTree = lower(expected.candidateTree);
  const artifact = normalizedArtifact(expected.artifact);
  const shell = observed.shell && typeof observed.shell === 'object' ? observed.shell : {};
  const version = observed.version && typeof observed.version === 'object' ? observed.version : {};
  const origin = str(observed.origin).trim();
  const mode = str(observed.mode).trim();
  const buildCommit = lower(shell.sha || shell.fullCommit);
  const sourceTree = lower(shell.sourceTree);
  const buildKind = lower(shell.provenanceKind);
  const runtimeSha256 = lower(shell.executableSha256);
  const runtimeSize = Number(shell.executableSize);

  if (!SHA40.test(candidateCommit)) errors.push('candidate-commit-missing');
  if (!SHA40.test(candidateTree)) errors.push('candidate-tree-missing');
  if (!artifact) errors.push('candidate-artifact-missing');
  if (!TAURI_ORIGINS.has(origin) || mode !== 'desktop') errors.push('not-installed-desktop');
  if (!SHA40.test(buildCommit) || buildCommit !== candidateCommit) errors.push('build-commit-mismatch');
  if (!SHA40.test(sourceTree) || sourceTree !== candidateTree) errors.push('source-tree-mismatch');
  if (shell.dirty !== false || version.buildDirty !== false) errors.push('dirty-or-unknown-build');
  if (![KINDS.REPRODUCIBLE_SOURCE, KINDS.CUSTOM].includes(buildKind)) errors.push('untrusted-build-kind');
  if (!artifact || runtimeSha256 !== artifact.sha256 || runtimeSize !== artifact.size) errors.push('runtime-artifact-mismatch');
  if (lower(version.buildSha) !== candidateCommit) errors.push('sidecar-commit-mismatch');
  if (!str(version.app).trim() || str(shell.version).trim() !== str(version.app).trim()) errors.push('app-version-mismatch');
  if (!str(shell.describe).trim() || str(shell.describe).trim() !== str(version.harness).trim()) errors.push('build-description-mismatch');
  return { ok: errors.length === 0, errors };
}

export function validateFreshPrecondition(observed, isolation, providerId) {
  observed = observed || {}; isolation = isolation || {};
  const errors = [];
  if (isolation.attended !== true) errors.push('attended-operator-unproven');
  if (isolation.freshProfile !== true) errors.push('fresh-profile-unattested');
  if (!SAFE_ID.test(str(isolation.id).trim())) errors.push('isolation-id-invalid');
  if (!ISOLATION_AUTHORITIES.has(str(isolation.authority))) errors.push('fresh-profile-authority-invalid');
  if (!['screen-splash', 'screen-connect'].includes(str(observed.activeScreen))) errors.push('fresh-screen-not-visible');
  if (observed.saveStatus !== 'none' || observed.savePresent !== false) errors.push('existing-save-present');
  if (observed.currentAgentPresent !== false || Number(observed.rosterCount) !== 0) errors.push('existing-agent-present');
  if (observed.recoveryVisible !== false) errors.push('recovery-mode-present');
  if (observed.providerConfigured !== false) errors.push('provider-already-configured');
  if (lower(observed.providerChecked) !== lower(providerId)) errors.push('provider-precondition-unchecked');
  return { ok: errors.length === 0, errors };
}

export function validateLinkReceipt(receipt, expected) {
  receipt = receipt || {}; expected = expected || {};
  const errors = [];
  const artifact = normalizedArtifact(expected.artifact);
  const evidence = Array.isArray(receipt.evidence) ? receipt.evidence.map(normalizedEvidence).filter(Boolean) : [];
  if (receipt.schemaVersion !== LINK_RECEIPT_SCHEMA) errors.push('link-schema-mismatch');
  if (receipt.producer !== 'installed-link-transport-v1') errors.push('link-producer-mismatch');
  if (lower(receipt.candidateCommit) !== lower(expected.candidateCommit)) errors.push('link-candidate-mismatch');
  if (lower(receipt.candidateTree) !== lower(expected.candidateTree)) errors.push('link-tree-mismatch');
  if (!artifact || lower(receipt.artifact && receipt.artifact.sha256) !== artifact.sha256 || Number(receipt.artifact && receipt.artifact.size) !== artifact.size)
    errors.push('link-artifact-mismatch');
  if (receipt.mode !== 'desktop' || !TAURI_ORIGINS.has(str(receipt.origin))) errors.push('link-not-installed-desktop');
  if (!receipt.healthyIdle || receipt.healthyIdle.observed !== true || receipt.healthyIdle.stayedUp !== true ||
      Number(receipt.healthyIdle.durationMs) <= 40000 || receipt.healthyIdle.state !== 'UP') errors.push('healthy-idle-up-unproven');
  if (!receipt.connectionLoss || receipt.connectionLoss.observed !== true || receipt.connectionLoss.actualLoss !== true ||
      receipt.connectionLoss.transitionedDown !== true || receipt.connectionLoss.state !== 'DOWN') errors.push('actual-loss-down-unproven');
  if (!str(receipt.stampIso).trim() || !Number.isFinite(Date.parse(receipt.stampIso))) errors.push('link-stamp-invalid');
  if (!Array.isArray(receipt.evidence) || evidence.length !== receipt.evidence.length || evidence.length === 0) errors.push('link-evidence-invalid');
  if (containsSecretMaterial(JSON.stringify(receipt))) errors.push('link-evidence-secret-bearing');
  return { ok: errors.length === 0, errors, evidence };
}

class JourneyFault extends Error {
  constructor(code, result = RESULTS.FAIL) {
    super(code); this.name = 'JourneyFault'; this.code = code; this.result = result;
  }
}

function requireCondition(condition, code, result) {
  if (!condition) throw new JourneyFault(code, result);
}

function publicIdentity(observed) {
  const shell = observed && observed.shell || {};
  const version = observed && observed.version || {};
  return {
    origin: str(observed && observed.origin), mode: str(observed && observed.mode),
    appVersion: str(version.app), buildCommit: lower(shell.sha || shell.fullCommit),
    sourceTree: lower(shell.sourceTree), buildDescribe: str(shell.describe),
    buildDirty: shell.dirty === true, buildKind: lower(shell.provenanceKind),
    runtimeExecutable: { sha256: lower(shell.executableSha256), size: Number(shell.executableSize) || 0 }
  };
}

function makeReceipt(state) {
  const task = state.task || {};
  const deliverable = task.deliverable || {};
  const opened = state.opened || {};
  return {
    schemaVersion: RECEIPT_SCHEMA,
    stampIso: str(state.stampIso),
    result: RESULT_SET.has(state.result) ? state.result : RESULTS.BLOCKED,
    reasonCode: str(state.reasonCode || 'unclassified'),
    candidateCommit: lower(state.candidateCommit),
    candidateTree: lower(state.candidateTree),
    artifact: normalizedArtifact(state.artifact),
    installed: state.identity ? publicIdentity(state.identity) : null,
    isolation: {
      id: str(state.isolation && state.isolation.id), attended: state.isolation && state.isolation.attended === true,
      authority: str(state.isolation && state.isolation.authority),
      freshProfile: state.isolation && state.isolation.freshProfile === true,
      observedFresh: state.fresh?.ok === true
    },
    provider: {
      id: lower(state.provider && state.provider.id), model: str(state.provider && state.provider.model),
      failureStateObserved: state.providerFailure?.visible === true,
      failureKind: str(state.providerFailure && state.providerFailure.kind),
      recovered: state.created?.providerConnected === true
    },
    overseer: {
      created: state.created?.overseerCreated === true,
      id: str(state.created && state.created.agentId), role: str(state.created && state.created.role)
    },
    task: {
      contract: FIRST_TASK_ID,
      started: task.started === true, completed: task.completed === true, reason: str(task.reason),
      runIdSha256: task.runId ? sha256Text(task.runId) : '',
      realProvider: task.realProvider === true,
      permissionPromptObserved: task.permissionPromptObserved === true,
      approvedOnce: task.approvedOnce === true
    },
    deliverable: {
      eventObserved: deliverable.eventObserved === true,
      path: str(deliverable.path), sha256: lower(deliverable.sha256), size: Number(deliverable.size) || 0,
      contentVerified: deliverable.contentVerified === true,
      opened: opened.opened === true, pointerClick: opened.pointerClick === true,
      mechanism: str(opened.mechanism), targetScheme: str(opened.targetScheme)
    },
    timing: {
      maxMs: MAX_JOURNEY_MS, totalMs: Number(state.totalMs) || 0,
      underTenMinutes: Number(state.totalMs) < MAX_JOURNEY_MS,
      steps: (state.steps || []).map(step => ({ id: str(step.id), ok: step.ok === true, ms: Number(step.ms) || 0, code: str(step.code) }))
    }
  };
}

export function validateJourneyReceipt(receipt) {
  receipt = receipt || {};
  const errors = [];
  if (receipt.schemaVersion !== RECEIPT_SCHEMA) errors.push('receipt-schema-mismatch');
  if (!RESULT_SET.has(receipt.result)) errors.push('receipt-result-invalid');
  if (!str(receipt.stampIso) || !Number.isFinite(Date.parse(receipt.stampIso))) errors.push('receipt-time-invalid');
  if (containsSecretMaterial(JSON.stringify(receipt))) errors.push('receipt-secret-bearing');
  if (receipt.result !== RESULTS.BLOCKED) {
    if (!SHA40.test(lower(receipt.candidateCommit)) || !SHA40.test(lower(receipt.candidateTree))) errors.push('receipt-candidate-invalid');
    if (!normalizedArtifact(receipt.artifact)) errors.push('receipt-artifact-invalid');
  }
  if (receipt.result === RESULTS.PASS) {
    if (!receipt.installed || receipt.installed.mode !== 'desktop' || !TAURI_ORIGINS.has(receipt.installed.origin)) errors.push('receipt-installed-unproven');
    if (!receipt.isolation || !receipt.isolation.attended || !receipt.isolation.freshProfile || !receipt.isolation.observedFresh ||
        !ISOLATION_AUTHORITIES.has(receipt.isolation.authority)) errors.push('receipt-fresh-unproven');
    if (!receipt.provider || !receipt.provider.failureStateObserved || !receipt.provider.recovered) errors.push('receipt-provider-recovery-unproven');
    if (!receipt.overseer || !receipt.overseer.created || receipt.overseer.role !== 'orchestrator') errors.push('receipt-overseer-unproven');
    if (!receipt.task || !receipt.task.started || !receipt.task.completed || receipt.task.reason !== 'done' || !receipt.task.realProvider ||
        !receipt.task.permissionPromptObserved || !receipt.task.approvedOnce) errors.push('receipt-real-task-unproven');
    if (!receipt.deliverable || !receipt.deliverable.eventObserved || basename(receipt.deliverable.path).toLowerCase() !== FIRST_TASK_PATH ||
        !SHA256.test(lower(receipt.deliverable.sha256)) || Number(receipt.deliverable.size) <= 0 || !receipt.deliverable.contentVerified ||
        !receipt.deliverable.opened || !receipt.deliverable.pointerClick || !receipt.deliverable.mechanism) errors.push('receipt-open-deliverable-unproven');
    if (!receipt.timing || !receipt.timing.underTenMinutes || Number(receipt.timing.totalMs) >= MAX_JOURNEY_MS) errors.push('receipt-ten-minute-bar-failed');
  }
  return { ok: errors.length === 0, errors };
}

/* Injectable orchestration core. The driver owns CDP/user actions; the core owns the
 * no-fake-green classification and the secret-free, candidate-bound receipt. */
export function makeInstalledFirstRun(options = {}) {
  const driver = options.driver || {};
  const clock = options.clock || {};
  const now = typeof clock.now === 'function' ? clock.now : () => Date.now();
  const nowIso = typeof clock.nowIso === 'function' ? clock.nowIso : () => new Date().toISOString();
  const io = options.io || {};
  const log = typeof io.log === 'function' ? io.log : () => {};
  const candidateCommit = lower(options.candidateCommit);
  const candidateTree = lower(options.candidateTree);
  const artifact = normalizedArtifact(options.artifact);
  const isolation = options.isolation || {};
  const provider = options.provider || {};
  const credential = str(provider.credential);
  const providerId = lower(provider.id);
  const model = str(provider.model).trim();

  async function run() {
    const startedAt = now();
    const state = {
      stampIso: nowIso(), result: RESULTS.BLOCKED, reasonCode: 'prerequisites-unchecked',
      candidateCommit, candidateTree, artifact, isolation,
      provider: { id: providerId, model }, steps: []
    };
    let session = null;

    const elapsed = () => Math.max(0, now() - startedAt);
    const enforceBudget = () => requireCondition(elapsed() < MAX_JOURNEY_MS, 'ten-minute-budget-exceeded', RESULTS.FAIL);
    async function step(id, fn) {
      enforceBudget();
      const start = now();
      try {
        const value = await fn(startedAt + MAX_JOURNEY_MS);
        enforceBudget();
        state.steps.push({ id, ok: true, ms: Math.max(0, now() - start), code: '' });
        return value;
      } catch (error) {
        const fault = error instanceof JourneyFault
          ? error : new JourneyFault('driver-' + id + '-failed', RESULTS.FAIL);
        state.steps.push({ id, ok: false, ms: Math.max(0, now() - start), code: fault.code });
        throw fault;
      }
    }

    try {
      requireCondition(SHA40.test(candidateCommit), 'candidate-commit-missing', RESULTS.BLOCKED);
      requireCondition(SHA40.test(candidateTree), 'candidate-tree-missing', RESULTS.BLOCKED);
      requireCondition(!!artifact, 'candidate-artifact-missing', RESULTS.BLOCKED);
      requireCondition(isolation.attended === true && isolation.freshProfile === true && SAFE_ID.test(str(isolation.id)) &&
        ISOLATION_AUTHORITIES.has(str(isolation.authority)),
        'isolated-fresh-profile-unattested', RESULTS.BLOCKED);
      requireCondition(provider.attended === true, 'attended-provider-action-unproven', RESULTS.BLOCKED);
      requireCondition(providerId === 'codex' || BYOK_PROVIDERS.has(providerId), 'provider-unsupported', RESULTS.BLOCKED);
      requireCondition(!!model, 'provider-model-missing', RESULTS.BLOCKED);
      if (BYOK_PROVIDERS.has(providerId)) requireCondition(credential.length >= 6, 'attended-provider-credential-missing', RESULTS.BLOCKED);
      requireCondition(typeof driver.attach === 'function', 'cdp-driver-missing', RESULTS.BLOCKED);

      session = await step('attach-installed-desktop', async deadline => {
        try { return await driver.attach({ deadline }); }
        catch (_) { throw new JourneyFault('installed-cdp-unreachable', RESULTS.BLOCKED); }
      });
      requireCondition(session && typeof session.readIdentity === 'function', 'installed-cdp-session-invalid', RESULTS.BLOCKED);

      state.identity = await step('exact-installed-identity', async () => {
        const observed = await session.readIdentity();
        const verdict = validateInstalledIdentity(observed, { candidateCommit, candidateTree, artifact });
        requireCondition(verdict.ok, verdict.errors[0] || 'installed-identity-unproven', RESULTS.BLOCKED);
        return observed;
      });

      state.fresh = await step('isolated-fresh-user', async () => {
        requireCondition(typeof session.readFreshState === 'function', 'fresh-state-driver-missing', RESULTS.BLOCKED);
        const observed = await session.readFreshState(providerId);
        const verdict = validateFreshPrecondition(observed, isolation, providerId);
        requireCondition(verdict.ok, verdict.errors[0] || 'fresh-profile-unproven', RESULTS.BLOCKED);
        return { ok: true };
      });

      state.providerFailure = await step('visible-provider-failure', async deadline => {
        requireCondition(typeof session.exerciseProviderFailure === 'function', 'provider-failure-driver-missing', RESULTS.BLOCKED);
        const observed = await session.exerciseProviderFailure({ id: providerId, model, deadline });
        requireCondition(observed && observed.visible === true, 'provider-failure-not-visible', RESULTS.FAIL);
        requireCondition(['credential-required', 'signin-required'].includes(str(observed.kind)), 'provider-failure-wrong-state', RESULTS.FAIL);
        return { visible: true, kind: str(observed.kind) };
      });

      state.created = await step('provider-recovery-and-overseer', async deadline => {
        requireCondition(typeof session.connectProviderAndCreate === 'function', 'provider-connect-driver-missing', RESULTS.BLOCKED);
        const observed = await session.connectProviderAndCreate({ id: providerId, model, credential, deadline });
        requireCondition(observed && observed.providerConnected === true, 'provider-recovery-failed', RESULTS.FAIL);
        requireCondition(observed.overseerCreated === true && observed.agentId === 'agent' && observed.role === 'orchestrator',
          'overseer-creation-failed', RESULTS.FAIL);
        return {
          providerConnected: true, overseerCreated: true, agentId: 'agent', role: 'orchestrator'
        };
      });

      state.task = await step('real-first-task-and-file', async deadline => {
        requireCondition(typeof session.completeFirstTask === 'function', 'first-task-driver-missing', RESULTS.BLOCKED);
        const observed = await session.completeFirstTask({ deadline, taskId: FIRST_TASK_ID, path: FIRST_TASK_PATH });
        const deliverable = observed && observed.deliverable || {};
        requireCondition(observed && observed.started === true, 'real-task-never-started', RESULTS.FAIL);
        requireCondition(observed.completed === true && observed.reason === 'done', 'real-task-did-not-complete', RESULTS.FAIL);
        requireCondition(observed.realProvider === true, 'real-provider-run-unproven', RESULTS.FAIL);
        requireCondition(observed.permissionPromptObserved === true && observed.approvedOnce === true,
          'real-consent-loop-unproven', RESULTS.FAIL);
        requireCondition(deliverable.eventObserved === true, 'assistant-reply-is-not-a-deliverable', RESULTS.FAIL);
        requireCondition(basename(deliverable.path).toLowerCase() === FIRST_TASK_PATH, 'hello-file-not-produced', RESULTS.FAIL);
        requireCondition(SHA256.test(lower(deliverable.sha256)) && Number(deliverable.size) > 0 && deliverable.contentVerified === true,
          'hello-file-bytes-unproven', RESULTS.FAIL);
        return {
          started: true, completed: true, reason: 'done', runId: str(observed.runId), realProvider: true,
          permissionPromptObserved: true, approvedOnce: true,
          deliverable: {
            eventObserved: true, path: str(deliverable.path), sha256: lower(deliverable.sha256),
            size: Number(deliverable.size), contentVerified: true
          }
        };
      });

      state.opened = await step('open-real-deliverable', async deadline => {
        requireCondition(typeof session.openDeliverable === 'function', 'deliverable-open-driver-missing', RESULTS.BLOCKED);
        const observed = await session.openDeliverable({ deadline, deliverable: state.task.deliverable });
        requireCondition(observed && observed.pointerClick === true, 'deliverable-open-was-not-user-action', RESULTS.FAIL);
        requireCondition(observed.opened === true, 'deliverable-open-not-observed', RESULTS.FAIL);
        requireCondition(observed.deliverableSha256 === state.task.deliverable.sha256, 'opened-deliverable-mismatch', RESULTS.FAIL);
        requireCondition(['target-created', 'window-open-accepted', 'native-open-accepted'].includes(str(observed.mechanism)),
          'deliverable-open-mechanism-unproven', RESULTS.FAIL);
        return {
          pointerClick: true, opened: true, mechanism: str(observed.mechanism),
          targetScheme: str(observed.targetScheme), deliverableSha256: str(observed.deliverableSha256)
        };
      });

      state.totalMs = elapsed();
      requireCondition(state.totalMs < MAX_JOURNEY_MS, 'ten-minute-budget-exceeded', RESULTS.FAIL);
      state.result = RESULTS.PASS;
      state.reasonCode = 'installed-first-value-proven';
    } catch (error) {
      const fault = error instanceof JourneyFault
        ? error : new JourneyFault('unexpected-runner-failure', RESULTS.FAIL);
      state.totalMs = elapsed();
      state.result = fault.result;
      state.reasonCode = fault.code;
      log('result=' + state.result + ' reason=' + state.reasonCode);
    } finally {
      if (session && typeof session.close === 'function') {
        try { await session.close(); } catch (_) {}
      }
    }

    let receipt = makeReceipt(state);
    const secrets = credential ? [credential] : [];
    if (containsSecretMaterial(JSON.stringify(receipt), secrets)) {
      state.result = RESULTS.BLOCKED; state.reasonCode = 'secret-bearing-evidence-refused';
      receipt = makeReceipt(state);
    }

    const writeEvidence = typeof io.writeEvidence === 'function' ? io.writeEvidence : () => null;
    const writeStamp = typeof io.writeStamp === 'function' ? io.writeStamp : () => '';
    const readStamp = typeof io.readStamp === 'function' ? io.readStamp : () => null;
    let evidence = null;
    try { evidence = normalizedEvidence(writeEvidence(receipt)); } catch (_) { evidence = null; }
    if (!evidence) {
      state.result = RESULTS.BLOCKED; state.reasonCode = 'journey-evidence-write-failed';
      receipt = makeReceipt(state);
      return { result: state.result, receipt, evidence: null };
    }

    let stamp = Object.assign({}, receipt, { evidence: [evidence] });
    let stampPath = '';
    try { stampPath = str(writeStamp(stamp)); } catch (_) { stampPath = ''; }
    let persisted = null;
    try { persisted = readStamp(); } catch (_) {}
    const valid = validateJourneyReceipt(stamp);
    if (!stampPath || !valid.ok || JSON.stringify(persisted) !== JSON.stringify(stamp)) {
      state.result = RESULTS.BLOCKED; state.reasonCode = 'journey-receipt-readback-failed';
      receipt = makeReceipt(state);
      stamp = Object.assign({}, receipt, { evidence: [evidence] });
      try { stampPath = str(writeStamp(stamp)); } catch (_) {}
    }
    log('result=' + state.result + ' evidence=' + evidence.path + ' receipt=' + stampPath);
    return { result: state.result, receipt: stamp, evidence, stampPath };
  }

  return { run };
}

/* ─────────────────────────────── REAL CDP DRIVER ─────────────────────────────── */

export const INSTALLED_IDENTITY_PROBE = `(async () => {
  const out = { origin: String(location.origin || ''), mode: '', shell: null, version: null };
  try {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') return out;
    out.shell = await core.invoke('starnet_build_info');
  } catch (_) {}
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    if (r && r.ok) out.version = await r.json();
  } catch (_) {}
  try {
    const r = await fetch('/api/diagnostics', { cache: 'no-store' });
    if (r && r.ok) {
      const j = await r.json(); const report = j && j.report ? j.report : j;
      out.mode = String(report && report.mode || '');
    }
  } catch (_) {}
  return out;
})()`;

const OBSERVER_INSTALL = `(() => {
  if (window.__STARNET_W1_OBS__) return true;
  if (typeof U === 'undefined' || !U.bus) return false;
  const cap = (a, v) => { a.push(v); if (a.length > 20) a.shift(); };
  const out = window.__STARNET_W1_OBS__ = { starts: [], ends: [], deliverables: [], permissions: [], responses: [] };
  U.bus.on('agent.run.start', p => cap(out.starts, { runId: String(p && p.runId || ''), agentId: String(p && p.agentId || ''), model: String(p && p.model || '') }));
  U.bus.on('agent.run.end', p => cap(out.ends, { runId: String(p && p.runId || ''), agentId: String(p && p.agentId || ''), reason: String(p && p.reason || '') }));
  U.bus.on('deliverable', p => cap(out.deliverables, { title: String(p && p.title || ''), kind: String(p && p.kind || ''), agentId: String(p && p.agentId || '') }));
  U.bus.on('permission.prompt', p => cap(out.permissions, { promptId: String(p && p.promptId || ''), tool: String(p && p.tool || '') }));
  U.bus.on('permission.response', p => cap(out.responses, { promptId: String(p && p.promptId || ''), decision: String(p && p.decision || '') }));
  return true;
})()`;

function cdpDeadline(deadline, capMs) {
  return Math.min(Number(deadline) || (Date.now() + capMs), Date.now() + capMs);
}

function safeScheme(url) {
  try {
    const protocol = new URL(str(url), 'http://invalid.local/').protocol;
    return ['blob:', 'http:', 'https:', 'file:'].includes(protocol) ? protocol : '';
  } catch (_) { return ''; }
}

export function makeCdpInstalledDriver(options = {}) {
  const port = Number(options.port) || 9333;
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : sleep;

  return {
    async attach() {
      const cdp = await connectCDP(port);
      try { await cdp.send('Runtime.enable'); } catch (_) {}
      try { await cdp.send('Page.enable'); } catch (_) {}
      try { await cdp.send('Target.setDiscoverTargets', { discover: true }); } catch (_) {}
      const targetEvents = [];
      cdp.on('Target.targetCreated', event => {
        const info = event && event.targetInfo || {};
        targetEvents.push({ at: Date.now(), type: str(info.type), scheme: safeScheme(info.url) });
        if (targetEvents.length > 20) targetEvents.shift();
      });

      async function waitValue(read, deadline, interval = 250) {
        while (Date.now() < deadline) {
          let value = null;
          try { value = await read(); } catch (_) {}
          if (value) return value;
          await sleepFn(interval);
        }
        return null;
      }

      async function rectFor(selector, text) {
        const result = await evalJS(cdp, `(() => {
          const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
          const want = ${JSON.stringify(text || '')}.trim().toLowerCase();
          const el = nodes.find(n => {
            const r = n.getBoundingClientRect();
            const visible = r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden';
            return visible && (!want || String(n.textContent || '').trim().toLowerCase() === want);
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
        })()`);
        return result && result.width > 0 && result.height > 0 ? result : null;
      }

      async function clickAt(x, y) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }

      async function clickSelector(selector, text) {
        const rect = await rectFor(selector, text);
        if (!rect) return false;
        await clickAt(rect.x, rect.y);
        return true;
      }

      async function pressEnter() {
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, key));
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, key));
      }

      async function fill(selector, value) {
        const rect = await rectFor(selector);
        if (!rect) return false;
        await clickAt(rect.x, rect.y);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
        await cdp.send('Input.insertText', { text: str(value) });
        return true;
      }

      async function ensureConnect(deadline) {
        return !!(await waitValue(async () => {
          const screen = await evalJS(cdp, `((document.querySelector('.screen.active') || {}).id || '')`);
          if (screen === 'screen-splash') { await pressEnter(); return false; }
          if (screen !== 'screen-connect') return false;
          return await evalJS(cdp, `(() => {
            const ids = ['in-name','in-key','in-model','btn-wake'];
            return ids.every(id => { const e = document.getElementById(id); return !!(e && e.getBoundingClientRect().width); });
          })()`);
        }, cdpDeadline(deadline, 45000), 300));
      }

      async function pageState() {
        return await evalJS(cdp, `(() => {
          const visible = e => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
          const caps = (() => { try { return (World.heroCaps('agent') || []).map(c => typeof c === 'string' ? c : String(c && c.id || '')); } catch (_) { return []; } })();
          const obs = window.__STARNET_W1_OBS__ || { starts: [], ends: [], deliverables: [], permissions: [], responses: [] };
          const option = Array.from(document.querySelectorAll('#chat-panel .fnv-opts button.fnv-opt')).find(b => visible(b) && !b.classList.contains('skip') && !b.classList.contains('custom'));
          const consent = Array.from(document.querySelectorAll('.cmsg.consent .consent-btn')).find(b => visible(b) && String(b.textContent || '').trim() === 'Approve once');
          const link = Array.from(document.querySelectorAll('.cmsg.deliverable .deliverable-link, .cmsg.recap .deliverable-link')).find(a => visible(a) && /(^|[\\/])hello\.txt$/i.test(String(a.title || a.textContent || '').trim()));
          return {
            screen: String((document.querySelector('.screen.active') || {}).id || ''),
            dialogueOption: !!option, consent: !!consent, link: !!link,
            buildOpen: !!(typeof Build !== 'undefined' && Build.isOpen && Build.isOpen()),
            caps, observer: JSON.parse(JSON.stringify(obs)), busy: !!(typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy())
          };
        })()`);
      }

      let placementAttempt = 0;
      let connectedProviderId = '';
      let connectedModel = '';
      const placementPoints = [
        [0.50, 0.43], [0.60, 0.43], [0.40, 0.43], [0.70, 0.43], [0.30, 0.43],
        [0.50, 0.55], [0.60, 0.55], [0.40, 0.55], [0.70, 0.55], [0.30, 0.55],
        [0.50, 0.31], [0.60, 0.31], [0.40, 0.31], [0.70, 0.31], [0.30, 0.31]
      ];

      async function placeCabinetByPointer() {
        const rect = await rectFor('.refit-canvas');
        if (!rect) return false;
        const p = placementPoints[placementAttempt++ % placementPoints.length];
        const left = rect.x - rect.width / 2, top = rect.y - rect.height / 2;
        await clickAt(left + rect.width * p[0], top + rect.height * p[1]);
        return true;
      }

      async function fileProof() {
        return await evalJS(cdp, `(async () => {
          try {
            const r = (typeof Harness !== 'undefined' && Harness.apiFetch)
              ? await Harness.apiFetch('/api/file?agent=agent&path=' + encodeURIComponent('hello.txt'), { cache: 'no-store' })
              : await fetch('/api/file?agent=agent&path=' + encodeURIComponent('hello.txt'), { cache: 'no-store' });
            if (!r || !r.ok) return null;
            const bytes = new Uint8Array(await r.arrayBuffer());
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
            const text = new TextDecoder().decode(bytes);
            return { path: 'hello.txt', sha256: hash, size: bytes.byteLength, contentVerified: text.trim() === 'starnet online' };
          } catch (_) { return null; }
        })()`);
      }

      return {
        async readIdentity() { return await evalJS(cdp, INSTALLED_IDENTITY_PROBE); },

        async readFreshState(providerId) {
          const ready = await waitValue(async () => {
            const screen = await evalJS(cdp, `((document.querySelector('.screen.active') || {}).id || '')`);
            return ['screen-splash', 'screen-connect'].includes(screen) ? screen : null;
          }, Date.now() + 45000, 300);
          if (!ready) throw new JourneyFault('fresh-screen-timeout', RESULTS.BLOCKED);
          return await evalJS(cdp, `(() => {
            const provider = ${JSON.stringify(lower(providerId))};
            const activeScreen = String((document.querySelector('.screen.active') || {}).id || '');
            let status = 'error', present = true, current = true, count = -1, configured = true;
            try { const s = Save.loadStatus(); status = String(s && s.status || 'error'); present = !!Save.has(); } catch (_) {}
            try { current = !!App.currentAgent(); count = (App.agents() || []).length; } catch (_) {}
            try { configured = !!Harness.configured(provider); } catch (_) {}
            const recovery = document.getElementById('cc-recovery');
            return { activeScreen, saveStatus: status, savePresent: present, currentAgentPresent: current,
              rosterCount: count, recoveryVisible: !!(recovery && !recovery.classList.contains('hidden')),
              providerChecked: provider, providerConfigured: configured };
          })()`);
        },

        async exerciseProviderFailure({ id, model, deadline }) {
          if (!await ensureConnect(deadline)) throw new JourneyFault('connect-screen-timeout', RESULTS.FAIL);
          if (!await clickSelector('.prov[data-prov="' + lower(id) + '"]')) throw new JourneyFault('provider-control-missing', RESULTS.FAIL);
          if (!await fill('#in-name', 'W1 OVERSEER')) throw new JourneyFault('overseer-name-control-missing', RESULTS.FAIL);
          if (!await fill('#in-model', model)) throw new JourneyFault('provider-model-control-missing', RESULTS.FAIL);
          if (id !== 'codex') await fill('#in-key', '');
          if (!await clickSelector('#btn-wake')) throw new JourneyFault('wake-control-missing', RESULTS.FAIL);
          const kind = await waitValue(async () => {
            return await evalJS(cdp, `(() => {
              const m = String((document.getElementById('connect-msg') || {}).textContent || '').toLowerCase();
              if (/sign in.*chatgpt|sign in first/.test(m)) return 'signin-required';
              if (/api key|enter your .* key/.test(m)) return 'credential-required';
              return '';
            })()`);
          }, cdpDeadline(deadline, 15000), 250);
          return { visible: !!kind, kind: str(kind) };
        },

        async connectProviderAndCreate({ id, model, credential, deadline }) {
          if (id === 'codex') {
            if (!await clickSelector('#btn-codex-signin')) throw new JourneyFault('codex-signin-control-missing', RESULTS.FAIL);
            const connected = await waitValue(async () => await evalJS(cdp, `(() => {
              const e = document.getElementById('codex-status'); return !!(e && e.classList.contains('ok'));
            })()`), cdpDeadline(deadline, 5 * 60 * 1000), 1000);
            if (!connected) throw new JourneyFault('attended-codex-signin-timeout', RESULTS.FAIL);
            await fill('#in-model', model);
          } else {
            if (!await fill('#in-key', credential)) throw new JourneyFault('provider-credential-control-missing', RESULTS.FAIL);
          }
          if (!await clickSelector('#btn-wake')) throw new JourneyFault('wake-control-missing', RESULTS.FAIL);
          const created = await waitValue(async () => await evalJS(cdp, `(() => {
            const game = document.getElementById('screen-game');
            const a = (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null;
            if (!game || !game.classList.contains('active') || !a) return null;
            const provider = String(a.provider || (Harness.getProv && Harness.getProv()) || '').toLowerCase();
            return { providerConnected: provider === ${JSON.stringify(lower(id))}, overseerCreated: a.id === 'agent', agentId: String(a.id || ''), role: String(a.role || '') };
          })()`), cdpDeadline(deadline, 45000), 300);
          if (!created) throw new JourneyFault('overseer-create-timeout', RESULTS.FAIL);
          const observerReady = await evalJS(cdp, OBSERVER_INSTALL);
          if (!observerReady) throw new JourneyFault('journey-observer-unavailable', RESULTS.BLOCKED);
          connectedProviderId = lower(id);
          connectedModel = str(model);
          return created;
        },

        async completeFirstTask({ deadline }) {
          let approvedOnce = false;
          while (Date.now() < deadline) {
            const state = await pageState();
            const starts = state.observer && state.observer.starts || [];
            const ends = state.observer && state.observer.ends || [];
            const deliverables = state.observer && state.observer.deliverables || [];
            const permissions = state.observer && state.observer.permissions || [];
            const responses = state.observer && state.observer.responses || [];
            const start = starts.find(x => x && x.agentId === 'agent') || null;
            const end = start ? [...ends].reverse().find(x => x && x.runId === start.runId) : null;
            const event = [...deliverables].reverse().find(x => x && basename(x.title).toLowerCase() === FIRST_TASK_PATH) || null;
            approvedOnce = approvedOnce || responses.some(x => x && x.decision === 'once');
            if (start && end && event && state.link) {
              const proof = await fileProof();
              return {
                started: true, completed: end.reason === 'done', reason: end.reason, runId: start.runId,
                realProvider: !!connectedProviderId && connectedProviderId !== 'replay' && str(start.model) === connectedModel,
                permissionPromptObserved: permissions.length > 0,
                approvedOnce, deliverable: Object.assign({ eventObserved: true }, proof || { path: event.title })
              };
            }

            if (state.consent) {
              if (await clickSelector('.cmsg.consent .consent-btn', 'Approve once')) approvedOnce = true;
              await sleepFn(350); continue;
            }

            const caps = new Set((state.caps || []).map(lower));
            const hasCabinet = caps.has('cabinet');
            const allCaps = ['cabinet', 'dish', 'workbench', 'notebook'].every(cap => caps.has(cap));
            if (state.buildOpen) {
              if (allCaps) { await clickSelector('#refit-done'); await sleepFn(400); continue; }
              if (hasCabinet) {
                const req = await clickSelector('.tut-coach .tut-coach-ok', '⚡ requisition the rest');
                if (req) { await sleepFn(1200); continue; }
              } else {
                const toolActive = await evalJS(cdp, `!!document.querySelector('.refit-tool[data-tool="prop"].active')`);
                if (!toolActive) { await clickSelector('.refit-tool[data-tool="prop"]'); await sleepFn(300); continue; }
                const tierActive = await evalJS(cdp, `!!document.querySelector('.refit-tier-functional.active')`);
                if (!tierActive) { await clickSelector('.refit-tier-functional'); await sleepFn(300); continue; }
                const catActive = await evalJS(cdp, `!!document.querySelector('.refit-propcat[data-cat="capability"].active')`);
                if (!catActive) { await clickSelector('.refit-propcat[data-cat="capability"]'); await sleepFn(300); continue; }
                const propActive = await evalJS(cdp, `!!document.querySelector('.refit-proptile[data-prop="war_intelcab"].active')`);
                if (!propActive) { await clickSelector('.refit-proptile[data-prop="war_intelcab"]'); await sleepFn(300); continue; }
                await placeCabinetByPointer(); await sleepFn(500); continue;
              }
            }

            if (state.dialogueOption) {
              await clickSelector('#chat-panel .fnv-opts button.fnv-opt:not(.skip):not(.custom)');
              await sleepFn(500); continue;
            }
            if (await clickSelector('#bb-build')) { await sleepFn(400); continue; }
            if (await clickSelector('.bb-group[data-group="build"] .bb-grp')) { await sleepFn(400); continue; }
            await sleepFn(300);
          }
          throw new JourneyFault('first-task-timeout', RESULTS.FAIL);
        },

        async openDeliverable({ deadline, deliverable }) {
          await evalJS(cdp, `(() => {
            if (window.__STARNET_W1_OPEN_INSTRUMENTED__) return true;
            const original = window.open;
            window.__STARNET_W1_OPEN_ORIGINAL__ = original;
            window.__STARNET_W1_OPEN_CALLS__ = [];
            window.open = function(url) {
              let accepted = false, ret = null;
              try { ret = original.apply(this, arguments); accepted = !!ret; return ret; }
              finally {
                let scheme = ''; try { scheme = new URL(String(url || ''), location.href).protocol; } catch (_) {}
                window.__STARNET_W1_OPEN_CALLS__.push({ accepted, scheme });
              }
            };
            window.__STARNET_W1_OPEN_INSTRUMENTED__ = true;
            return true;
          })()`);
          const eventStart = targetEvents.length;
          const clicked = await clickSelector('.cmsg.deliverable .deliverable-link, .cmsg.recap .deliverable-link', 'hello.txt');
          if (!clicked) return { pointerClick: false, opened: false, deliverableSha256: str(deliverable && deliverable.sha256) };
          const observed = await waitValue(async () => {
            const call = await evalJS(cdp, `(() => {
              const a = window.__STARNET_W1_OPEN_CALLS__ || []; return a.length ? a[a.length - 1] : null;
            })()`);
            const target = targetEvents.slice(eventStart).find(x => x && ['blob:', 'http:', 'https:', 'file:'].includes(x.scheme));
            if (target) return { mechanism: 'target-created', targetScheme: target.scheme };
            if (call && call.accepted) return { mechanism: 'window-open-accepted', targetScheme: safeScheme(call.scheme) || str(call.scheme) };
            return null;
          }, cdpDeadline(deadline, 12000), 250);
          return {
            pointerClick: true, opened: !!observed,
            mechanism: observed ? observed.mechanism : '', targetScheme: observed ? observed.targetScheme : '',
            deliverableSha256: str(deliverable && deliverable.sha256)
          };
        },

        async close() {
          try {
            await evalJS(cdp, `(() => {
              if (window.__STARNET_W1_OPEN_INSTRUMENTED__ && window.__STARNET_W1_OPEN_ORIGINAL__) window.open = window.__STARNET_W1_OPEN_ORIGINAL__;
              delete window.__STARNET_W1_OPEN_ORIGINAL__; delete window.__STARNET_W1_OPEN_CALLS__; delete window.__STARNET_W1_OPEN_INSTRUMENTED__;
              return true;
            })()`);
          } catch (_) {}
          try { cdp.ws.close(); } catch (_) {}
        }
      };
    }
  };
}

/* ─────────────────────────────── CLI AMBIENT IO ─────────────────────────────── */

const INVOKED_DIRECTLY = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch (_) { return false; }
})();

function hashFile(file) {
  try {
    const resolved = path.resolve(file);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0) return null;
    const bytes = fs.readFileSync(resolved);
    return { path: resolved, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  } catch (_) { return null; }
}

if (INVOKED_DIRECTLY) (async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, '..', '..');
  const candidateCommit = lower(process.env.STARNET_PRODUCT_PERFECT_CANDIDATE_SHA || process.env.STARNET_FIRST_RUN_EXPECTED_HEAD);
  const candidateTree = (() => {
    if (!SHA40.test(candidateCommit)) return '';
    const result = spawnSync('git', ['rev-parse', candidateCommit + '^{tree}'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    const value = lower(result.stdout);
    return result.status === 0 && SHA40.test(value) ? value : '';
  })();
  const artifact = hashFile(process.env.STARNET_FIRST_RUN_ARTIFACT || process.env.STARNET_SMOKE_ARTIFACT || '');
  const attended = process.env.STARNET_FIRST_RUN_ATTENDED === '1';
  const isolation = {
    id: str(process.env.STARNET_FIRST_RUN_ISOLATION_ID).trim(),
    authority: str(process.env.STARNET_FIRST_RUN_ISOLATION_AUTHORITY).trim(),
    freshProfile: process.env.STARNET_FIRST_RUN_FRESH_PROFILE === '1',
    attended
  };
  const provider = {
    id: lower(process.env.STARNET_FIRST_RUN_PROVIDER || 'openrouter'),
    model: str(process.env.STARNET_FIRST_RUN_MODEL).trim(),
    credential: str(process.env.STARNET_FIRST_RUN_PROVIDER_SECRET),
    attended
  };
  const port = Number(process.env.STARNET_FIRST_RUN_CDP_PORT || process.env.STARNET_SMOKE_CDP_PORT) || 9333;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(repo, 'qa', 'installed', 'smoke-' + stamp + '-first-run');
  const evidenceFile = path.join(runDir, 'journey.json');
  const receiptFile = path.join(runDir, 'receipt.json');
  const rel = file => path.relative(repo, file).replace(/\\/g, '/');

  const io = {
    log: (...parts) => console.log('[qa:first-run:installed]', ...parts),
    writeEvidence(receipt) {
      try {
        const text = JSON.stringify(receipt, null, 2) + '\n';
        if (containsSecretMaterial(text, provider.credential ? [provider.credential] : [])) return null;
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(evidenceFile, text, 'utf8');
        const bytes = fs.readFileSync(evidenceFile);
        return { path: rel(evidenceFile), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      } catch (_) { return null; }
    },
    writeStamp(receipt) {
      try {
        const text = JSON.stringify(receipt, null, 2) + '\n';
        if (containsSecretMaterial(text, provider.credential ? [provider.credential] : [])) return '';
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(receiptFile, text, 'utf8');
        return rel(receiptFile);
      } catch (_) { return ''; }
    },
    readStamp() {
      try { return JSON.parse(fs.readFileSync(receiptFile, 'utf8')); }
      catch (_) { return null; }
    }
  };

  io.log('candidate=' + (candidateCommit || '(missing)') + ' cdp=127.0.0.1:' + port +
    ' isolation=' + (isolation.authority || '(missing)') + '/' + (isolation.id || '(missing)') +
    ' provider=' + (provider.id || '(missing)'));
  if (!ISOLATION_AUTHORITIES.has(isolation.authority)) {
    io.log('BLOCKED — isolation authority must be separate-windows-user, virtual-machine, or clean-machine; APPDATA/LOCALAPPDATA process redirection is not isolation');
  }
  if (!provider.model) io.log('BLOCKED — set STARNET_FIRST_RUN_MODEL');
  if (BYOK_PROVIDERS.has(provider.id) && !provider.credential) io.log('BLOCKED — set STARNET_FIRST_RUN_PROVIDER_SECRET in the attended shell (its value is never logged or written)');

  const runner = makeInstalledFirstRun({
    driver: makeCdpInstalledDriver({ port }), candidateCommit, candidateTree, artifact,
    isolation, provider, io
  });
  const result = await runner.run();
  process.exit(result.result === RESULTS.PASS ? 0 : (result.result === RESULTS.FAIL ? 1 : 2));
})();
