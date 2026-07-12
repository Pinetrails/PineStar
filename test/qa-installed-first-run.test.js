/* node test/qa-installed-first-run.test.js — deterministic W1 installed first-value authority. */
'use strict';
const A = require('./_assert.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  MAX_JOURNEY_MS, RECEIPT_SCHEMA, LINK_RECEIPT_SCHEMA, RESULTS,
  FIRST_TASK_ID, FIRST_TASK_PATH, INSTALLED_IDENTITY_PROBE,
  containsSecretMaterial, validateInstalledIdentity, validateFreshPrecondition,
  validateLinkReceipt, validateJourneyReceipt, makeInstalledFirstRun
} = require('../scripts/qa/installed-first-run.mjs');

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const ARTIFACT = { path: 'C:/Program Files/StarNet/skynet-desktop.exe', sha256: 'c'.repeat(64), size: 456789 };
const EVIDENCE = { path: 'qa/installed/smoke-run/link.json', sha256: 'd'.repeat(64), size: 123 };
const ISO = '2026-07-12T12:00:00.000Z';
const SECRET = 'sk-or-v1-attended-runtime-secret-value';
const ISOLATION = { id: 'vm-w1-clean-001', authority: 'virtual-machine', freshProfile: true, attended: true };
const PROVIDER = { id: 'openrouter', model: 'openai/gpt-5', credential: SECRET, attended: true };
const IDENTITY = {
  origin: 'http://tauri.localhost', mode: 'desktop',
  shell: {
    sha: SHA, sourceTree: TREE, dirty: false, provenanceKind: 'reproducible-source',
    executableSha256: ARTIFACT.sha256, executableSize: ARTIFACT.size,
    version: '0.6.0', describe: 'v0.6.0-1-gaaaaaaaa'
  },
  version: { app: '0.6.0', harness: 'v0.6.0-1-gaaaaaaaa', buildSha: SHA, buildDirty: false }
};
const FRESH = {
  activeScreen: 'screen-connect', saveStatus: 'none', savePresent: false,
  currentAgentPresent: false, rosterCount: 0, recoveryVisible: false,
  providerChecked: 'openrouter', providerConfigured: false
};
const TASK = {
  started: true, completed: true, reason: 'done', runId: 'run-real-123', realProvider: true,
  permissionPromptObserved: true, approvedOnce: true,
  deliverable: { eventObserved: true, path: 'hello.txt', sha256: 'e'.repeat(64), size: 15, contentVerified: true }
};
const OPENED = {
  pointerClick: true, opened: true, mechanism: 'target-created', targetScheme: 'blob:',
  deliverableSha256: TASK.deliverable.sha256
};

function memIo(opts = {}) {
  const evidence = [], stamps = [], logs = [];
  return {
    evidence, stamps, logs,
    log: (...parts) => logs.push(parts.join(' ')),
    writeEvidence(receipt) {
      if (opts.failEvidence) return null;
      const text = JSON.stringify(receipt);
      const proof = { path: 'qa/installed/smoke-test/journey.json', sha256: crypto.createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text) };
      evidence.push({ receipt, proof }); return proof;
    },
    writeStamp(stamp) { stamps.push(stamp); return 'qa/installed/smoke-test/receipt.json'; },
    readStamp() { return stamps.length ? stamps[stamps.length - 1] : null; }
  };
}

function scenario(overrides = {}) {
  let ms = 0;
  const tick = n => { ms += n == null ? 25 : n; };
  const session = {
    async readIdentity() { tick(); return overrides.identity || IDENTITY; },
    async readFreshState() { tick(); return overrides.fresh || FRESH; },
    async exerciseProviderFailure() { tick(); return overrides.providerFailure || { visible: true, kind: 'credential-required' }; },
    async connectProviderAndCreate() { tick(); return overrides.created || { providerConnected: true, overseerCreated: true, agentId: 'agent', role: 'orchestrator' }; },
    async completeFirstTask() { tick(overrides.taskMs || 100); return overrides.task || TASK; },
    async openDeliverable() { tick(); return overrides.opened || OPENED; },
    async close() { tick(0); }
  };
  const driver = {
    async attach() { tick(); if (overrides.attachError) throw new Error('unreachable'); return session; }
  };
  const io = overrides.io || memIo(overrides);
  const runner = makeInstalledFirstRun({
    driver, candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT,
    isolation: overrides.isolation || ISOLATION,
    provider: Object.prototype.hasOwnProperty.call(overrides, 'provider') ? overrides.provider : PROVIDER,
    io, clock: { now: () => ms, nowIso: () => ISO }
  });
  return { runner, io };
}

(async () => {
  A.eq(MAX_JOURNEY_MS, 10 * 60 * 1000, 'first value is capped at ten real minutes');
  A.eq(RECEIPT_SCHEMA, 1, 'journey receipt schema is explicit');
  A.eq(LINK_RECEIPT_SCHEMA, 1, 'link companion receipt schema is explicit');
  A.eq(FIRST_TASK_ID, 'tutorial-hello-file-v1', 'runner binds to the product tutorial task');
  A.eq(FIRST_TASK_PATH, 'hello.txt', 'actual file, not a reply, is the deliverable');
  A.ok(/starnet_build_info/.test(INSTALLED_IDENTITY_PROBE), 'identity comes from the running executable');
  A.ok(/\/api\/version/.test(INSTALLED_IDENTITY_PROBE), 'running sidecar identity is cross-checked');

  // Exact installed identity: browser/dev, dirty, wrong source, and wrong executable all fail closed.
  A.eq(validateInstalledIdentity(IDENTITY, { candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT }).ok, true, 'exact installed identity validates');
  A.ok(validateInstalledIdentity(Object.assign({}, IDENTITY, { mode: 'browser' }), { candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT }).errors.includes('not-installed-desktop'), 'browser cannot satisfy installed proof');
  A.ok(validateInstalledIdentity(Object.assign({}, IDENTITY, { shell: Object.assign({}, IDENTITY.shell, { dirty: true }) }), { candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT }).errors.includes('dirty-or-unknown-build'), 'dirty build is rejected');
  A.ok(validateInstalledIdentity(Object.assign({}, IDENTITY, { shell: Object.assign({}, IDENTITY.shell, { sourceTree: 'f'.repeat(40) }) }), { candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT }).errors.includes('source-tree-mismatch'), 'wrong source tree is rejected');
  A.ok(validateInstalledIdentity(Object.assign({}, IDENTITY, { shell: Object.assign({}, IDENTITY.shell, { executableSha256: 'f'.repeat(64) }) }), { candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT }).errors.includes('runtime-artifact-mismatch'), 'different executable bytes are rejected');

  // Fresh proof requires a real isolation authority; process env redirection is deliberately not one.
  A.eq(validateFreshPrecondition(FRESH, ISOLATION, 'openrouter').ok, true, 'separate VM + fresh observed state validates');
  A.ok(validateFreshPrecondition(FRESH, Object.assign({}, ISOLATION, { authority: 'appdata-env-redirect' }), 'openrouter').errors.includes('fresh-profile-authority-invalid'), 'APPDATA/LOCALAPPDATA redirection is not accepted as isolation');
  A.ok(validateFreshPrecondition(Object.assign({}, FRESH, { savePresent: true }), ISOLATION, 'openrouter').errors.includes('existing-save-present'), 'existing save invalidates new-user proof');
  A.ok(validateFreshPrecondition(Object.assign({}, FRESH, { providerConfigured: true }), ISOLATION, 'openrouter').errors.includes('provider-already-configured'), 'pre-existing credential invalidates explicit-connect proof');

  const LINK = {
    schemaVersion: 1, producer: 'installed-link-transport-v1', stampIso: ISO,
    candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT,
    mode: 'desktop', origin: 'http://tauri.localhost',
    healthyIdle: { observed: true, durationMs: 41001, stayedUp: true, state: 'UP' },
    connectionLoss: { observed: true, actualLoss: true, transitionedDown: true, state: 'DOWN' },
    evidence: [EVIDENCE]
  };
  A.eq(validateLinkReceipt(LINK, { candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT }).ok, true, 'candidate-bound UP/DOWN link receipt validates');
  A.ok(validateLinkReceipt(Object.assign({}, LINK, { healthyIdle: Object.assign({}, LINK.healthyIdle, { durationMs: 40000 }) }), { candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT }).errors.includes('healthy-idle-up-unproven'), 'exactly 40s is insufficient; proof must exceed stale threshold');
  A.ok(validateLinkReceipt(Object.assign({}, LINK, { connectionLoss: Object.assign({}, LINK.connectionLoss, { actualLoss: false }) }), { candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT }).errors.includes('actual-loss-down-unproven'), 'simulated label without actual loss is rejected');
  A.ok(validateLinkReceipt(Object.assign({}, LINK, { producer: 'handwritten' }), { candidateCommit: SHA, candidateTree: TREE, artifact: ARTIFACT }).errors.includes('link-producer-mismatch'), 'wrong/handwritten producer contract is rejected');

  A.eq(containsSecretMaterial('safe candidate ' + SHA, [SECRET]), false, 'ordinary receipt material is secret-free');
  A.eq(containsSecretMaterial('oops ' + SECRET, [SECRET]), true, 'exact attended credential is detected');
  A.eq(containsSecretMaterial('api_key = sk-test-abcdefghijklmnop'), true, 'key-shaped material is detected');

  // Full green core: every product observation is independently required and the credential is absent.
  {
    const { runner, io } = scenario();
    const out = await runner.run();
    A.eq(out.result, RESULTS.PASS, 'exact fresh installed journey -> PASS');
    A.eq(validateJourneyReceipt(out.receipt).ok, true, 'PASS receipt validates');
    A.eq(out.receipt.provider.failureStateObserved, true, 'visible provider failure is recorded');
    A.eq(out.receipt.provider.recovered, true, 'provider recovery is recorded');
    A.eq(out.receipt.overseer.created, true, 'real Overseer creation is recorded');
    A.eq(out.receipt.task.permissionPromptObserved, true, 'real consent prompt is recorded');
    A.eq(out.receipt.deliverable.path, 'hello.txt', 'receipt names the actual produced file');
    A.eq(out.receipt.deliverable.opened, true, 'receipt requires the real OPEN action');
    A.eq(out.receipt.timing.underTenMinutes, true, 'journey completed under ten minutes');
    A.eq(JSON.stringify(out.receipt).includes(SECRET), false, 'credential bytes never enter receipt');
    A.eq(JSON.stringify(io.evidence[0].receipt).includes(SECRET), false, 'credential bytes never enter evidence');
  }

  {
    const { runner } = scenario({ attachError: true });
    A.eq((await runner.run()).result, RESULTS.BLOCKED, 'unreachable installed CDP -> BLOCKED');
  }
  {
    const io = memIo();
    const runner = makeInstalledFirstRun({ driver: {}, candidateCommit: '', candidateTree: '', artifact: null,
      isolation: {}, provider: {}, io, clock: { now: () => 0, nowIso: () => ISO } });
    const out = await runner.run();
    A.eq(out.result, RESULTS.BLOCKED, 'missing candidate stays BLOCKED');
    A.eq(out.receipt.reasonCode, 'candidate-commit-missing', 'BLOCKED receipt preserves the first concrete blocker');
    A.eq(out.receipt.isolation.observedFresh, false, 'BLOCKED receipt keeps explicit false precondition fields');
  }
  {
    const { runner } = scenario({ isolation: Object.assign({}, ISOLATION, { authority: 'appdata-env-redirect' }) });
    A.eq((await runner.run()).result, RESULTS.BLOCKED, 'unproven process-local isolation -> BLOCKED');
  }
  {
    const { runner } = scenario({ provider: Object.assign({}, PROVIDER, { credential: '' }) });
    A.eq((await runner.run()).result, RESULTS.BLOCKED, 'missing attended BYOK credential -> BLOCKED');
  }
  {
    const { runner } = scenario({ providerFailure: { visible: false, kind: '' } });
    A.eq((await runner.run()).result, RESULTS.FAIL, 'no visible provider failure/recovery path -> FAIL');
  }
  {
    const replyOnly = Object.assign({}, TASK, { deliverable: { eventObserved: false, path: '', sha256: '', size: 0, contentVerified: false } });
    const { runner } = scenario({ task: replyOnly });
    A.eq((await runner.run()).result, RESULTS.FAIL, 'assistant reply without a produced file -> FAIL');
  }
  {
    const { runner } = scenario({ opened: Object.assign({}, OPENED, { opened: false, mechanism: '' }) });
    A.eq((await runner.run()).result, RESULTS.FAIL, 'file bytes without a real OPEN -> FAIL');
  }
  {
    const { runner } = scenario({ taskMs: MAX_JOURNEY_MS });
    A.eq((await runner.run()).result, RESULTS.FAIL, 'ten-minute overrun -> FAIL');
  }
  {
    const { runner } = scenario({ failEvidence: true });
    A.eq((await runner.run()).result, RESULTS.BLOCKED, 'evidence write failure -> BLOCKED');
  }

  const gate = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'qa', 'product-perfect', 'gates', 'wave-1-installed-first-run.mjs'), 'utf8');
  A.ok(/STARNET_W1_LINK_RECEIPT/.test(gate), 'W1 gate requires the disjoint installed link companion receipt');
  A.ok(/validateLinkReceipt/.test(gate), 'W1 gate validates link receipt semantics');
  A.ok(/installed-first-run\.mjs/.test(gate), 'W1 gate invokes the live installed journey');
  A.ok(!/rev-parse['"`,\s]+HEAD/.test(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'qa', 'installed-first-run.mjs'), 'utf8')), 'runner never substitutes ambient HEAD for the candidate');
  const blockedGate = spawnSync(process.execPath, ['scripts/qa/product-perfect/gates/wave-1-installed-first-run.mjs'], {
    cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { STARNET_PRODUCT_PERFECT_CANDIDATE_SHA: '' }), encoding: 'utf8'
  });
  A.eq(blockedGate.status, 2, 'gate without exact controller candidate exits BLOCKED');

  A.report('qa installed first run');
})().catch(error => { console.error(error); process.exit(1); });
