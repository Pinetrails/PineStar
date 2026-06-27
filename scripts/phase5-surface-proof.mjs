#!/usr/bin/env node
// phase5-surface-proof.mjs - browser/computer/desktop evidence classifier for P5.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedCommand } from './lib/run-command.mjs';
import { withoutLiveProviderEnv } from './lib/provider-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.env.STARNET_PHASE5_SURFACE_DIR || join(ROOT, '.dogfood', 'phase5-surface-proof'));
const evidenceFile = join(ROOT, '.dogfood', 'phase5-evidence.json');
const nodeCmd = process.execPath;
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function evidenceTemplate() {
  return {
    generatedAt: new Date().toISOString(),
    operator: process.env.USERNAME || process.env.USER || 'andro',
    workloads: { passed: false, proofLevel: '', screenshots: [], runIds: [], transcriptIds: [], artifactPaths: [], ledgerRows: [], modelNames: [], toolCalls: [], notes: '' },
    surface: {
      browser: { status: 'blocked', proofLevel: '', logs: [], notes: '' },
      computer: { status: 'blocked', proofLevel: '', logs: [], notes: '' }
    },
    soak: { phase4LiveGreen: false, phase5WorkloadGreen: false, restartPreserved: false, notes: '' },
    recovery: { phase4RecoveryGreen: false, phase5RecoveryGreen: false, notes: '' },
    desktop: { status: 'blocked', logs: [], notes: '' }
  };
}
async function runStep(id, cmd, args, timeoutMs = 300000) {
  console.log('[phase5-surface] ' + id);
  const result = await runBoundedCommand({
    cmd,
    args,
    cwd: ROOT,
    env: withoutLiveProviderEnv(),
    timeoutMs,
    label: 'phase5-surface/' + id
  });
  const logFile = join(OUT, id + '.log');
  writeFileSync(logFile, result.output);
  const status = result.exitCode === 0 ? 'pass' : 'fail';
  console.log('[phase5-surface]   ' + status.toUpperCase() + ' exit=' + result.exitCode);
  return { id, status, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, logFile };
}
function cargoAvailable() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const pathEnv = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  return pathEnv.some(p => p && existsSync(join(p, exe)));
}
function unique(xs) {
  return Array.from(new Set((xs || []).filter(x => String(x || '').trim())));
}

ensureDir(OUT);
const results = [];
results.push(await runStep('browser-contract', nodeCmd, ['test/browser.test.js'], 120000));
results.push(await runStep('computer-contract', nodeCmd, ['test/computer.test.js'], 120000));
results.push(await runStep('desktop-prepare', npmCmd, ['run', 'desktop:prepare'], 300000));

let desktopBuild = null;
if (cargoAvailable()) {
  desktopBuild = await runStep('desktop-build', npmCmd, ['run', 'desktop:build'], 600000);
  results.push(desktopBuild);
} else {
  desktopBuild = { id: 'desktop-build', status: 'blocked', exitCode: null, timedOut: false, durationMs: 0, logFile: join(OUT, 'desktop-build.log'), reason: 'cargo not found on PATH' };
  writeFileSync(desktopBuild.logFile, 'blocked: cargo not found on PATH\n');
  results.push(desktopBuild);
  console.log('[phase5-surface]   BLOCKED desktop-build cargo not found on PATH');
}

const browser = results.find(r => r.id === 'browser-contract');
const computer = results.find(r => r.id === 'computer-contract');
const prepare = results.find(r => r.id === 'desktop-prepare');
const fail = results.some(r => r.status === 'fail');
const desktopStatus = prepare && prepare.status === 'pass' && desktopBuild && desktopBuild.status === 'pass'
  ? 'green'
  : (prepare && prepare.status === 'pass' && desktopBuild && desktopBuild.status === 'blocked' ? 'toolchain-blocked' : 'blocked');

const evidence = readJson(evidenceFile, evidenceTemplate());
evidence.generatedAt = new Date().toISOString();
evidence.operator = evidence.operator || process.env.USERNAME || process.env.USER || 'andro';
evidence.surface = evidence.surface || {};
evidence.surface.browser = {
  status: browser && browser.status === 'pass' ? 'contract-green' : 'blocked',
  proofLevel: browser && browser.status === 'pass' ? 'automated-contract' : '',
  logs: unique((evidence.surface.browser && evidence.surface.browser.logs || []).concat(browser && browser.logFile)),
  notes: browser && browser.status === 'pass'
    ? 'Browser automation contract is green. This is not yet Hermes-proven live browser workload evidence.'
    : 'Browser automation contract failed or timed out.'
};
evidence.surface.computer = {
  status: computer && computer.status === 'pass' ? 'contract-green' : 'blocked',
  proofLevel: computer && computer.status === 'pass' ? 'automated-contract' : '',
  logs: unique((evidence.surface.computer && evidence.surface.computer.logs || []).concat(computer && computer.logFile)),
  notes: computer && computer.status === 'pass'
    ? 'Desktop computer-use contract is green. Real attended desktop-driver evidence is still required for ready-to-replace.'
    : 'Desktop computer-use contract failed or timed out.'
};
evidence.desktop = {
  status: desktopStatus,
  logs: unique((evidence.desktop && evidence.desktop.logs || []).concat(results.filter(r => /^desktop-/.test(r.id)).map(r => r.logFile))),
  notes: desktopStatus === 'green'
    ? 'Desktop prepare and Tauri build are green on this machine.'
    : (desktopStatus === 'toolchain-blocked'
      ? 'Desktop prepare is green, but Cargo is not on PATH so clean-machine/Tauri build remains a toolchain evidence item.'
      : 'Desktop readiness is blocked; inspect the desktop logs.')
};
writeJson(evidenceFile, evidence);

const status = {
  generatedAt: new Date().toISOString(),
  verdict: fail ? 'red' : 'green',
  counts: { pass: results.filter(r => r.status === 'pass').length, fail: results.filter(r => r.status === 'fail').length, blocked: results.filter(r => r.status === 'blocked').length },
  results
};
writeJson(join(OUT, 'phase5-surface-status.json'), status);
console.log('[phase5-surface] evidence: ' + OUT);
console.log('[phase5-surface] phase5 evidence: ' + evidenceFile);
process.exit(fail ? 1 : 0);

