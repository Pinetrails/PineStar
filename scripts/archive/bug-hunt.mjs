#!/usr/bin/env node
// bug-hunt.mjs - one-command StarNet bug-finding evidence sweep.
//
// This runner composes the existing high-signal detectors without replacing them:
// coordination board, map/world sanity, behavioral audit, visual golden review,
// and optional full gates. It writes a timestamped bundle under .bugloops/ so a
// loop agent can fix from evidence instead of from vibes.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coerceTimeoutMs, runBoundedCommand } from './lib/run-command.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const FULL = args.has('--full');
const NO_VISUAL = args.has('--no-visual');
const NO_AUDIT = args.has('--no-audit');
const LIVE_AUDIT = args.has('--live-audit');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const OUT = resolve(process.env.STARNET_BUG_HUNT_DIR || join(ROOT, '.bugloops', 'bug-hunt-' + STAMP));
const LATEST = join(ROOT, '.bugloops', 'bug-hunt-latest');
const STEP_TIMEOUT_MS = coerceTimeoutMs(process.env.STARNET_BUG_HUNT_STEP_TIMEOUT_MS || 900000);
const nodeCmd = process.execPath;
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function tail(s, n = 7000) {
  s = String(s || '');
  return s.length > n ? s.slice(s.length - n) : s;
}
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
function statusLabel(status) {
  return status === 'pass' ? 'PASS'
    : status === 'review' ? 'REVIEW'
    : status === 'skip' ? 'SKIP'
    : 'FAIL';
}
function readJsonMaybe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function copyIfExists(src, destName) {
  try {
    if (!existsSync(src)) return;
    const dest = join(OUT, destName);
    ensureDir(dirname(dest));
    copyFileSync(src, dest);
  } catch (_) {}
}

async function runStep(step) {
  ensureDir(OUT);
  if (step.skip) {
    return Object.assign({}, step, {
      status: 'skip',
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      logFile: null,
      outputTail: step.reason || ''
    });
  }

  console.log('[bug-hunt] ' + step.id + ' - ' + step.title);
  const logFile = join(OUT, step.id + '.log');
  const result = await runBoundedCommand({
    cmd: step.cmd,
    args: step.args || [],
    cwd: ROOT,
    env: step.env || process.env,
    timeoutMs: step.timeoutMs || STEP_TIMEOUT_MS,
    label: 'bug-hunt/' + step.id
  });
  writeFileSync(logFile, result.output);
  const review = Array.isArray(step.reviewExitCodes) && step.reviewExitCodes.includes(result.exitCode);
  const status = result.exitCode === 0 ? 'pass' : review ? 'review' : 'fail';
  console.log('[bug-hunt]   ' + statusLabel(status) + ' exit=' + result.exitCode);
  return Object.assign({}, step, {
    status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    logFile,
    outputTail: tail(result.output),
    reason: result.timedOut ? 'Timed out after ' + (step.timeoutMs || STEP_TIMEOUT_MS) + 'ms.' : ''
  });
}

function writeSummary(results) {
  const auditRan = results.some(r => r.id === 'audit' && r.status !== 'skip');
  const goldenRan = results.some(r => r.id === 'golden' && r.status !== 'skip');
  if (auditRan) copyIfExists(join(ROOT, '.uiaudit', 'audit-report.json'), 'audit-report.json');
  if (goldenRan) copyIfExists(join(ROOT, '.uigolden', 'golden-report.json'), 'golden-report.json');

  const golden = goldenRan ? readJsonMaybe(join(ROOT, '.uigolden', 'golden-report.json')) : null;
  const goldenFlagged = golden && Array.isArray(golden.flagged) ? golden.flagged : [];
  for (const f of goldenFlagged) {
    if (f && f.frame) copyIfExists(f.frame, join('golden-frames', basename(f.frame)));
  }
  const fail = results.filter(r => r.status === 'fail').length;
  const review = results.filter(r => r.status === 'review').length;
  const pass = results.filter(r => r.status === 'pass').length;
  const skip = results.filter(r => r.status === 'skip').length;
  const verdict = fail ? 'red' : review ? 'review' : 'green';
  const summary = {
    generatedAt: new Date().toISOString(),
    outDir: OUT,
    mode: FULL ? 'full' : 'quick',
    verdict,
    counts: { pass, review, fail, skip },
    goldenFlagged,
    results: results.map(r => ({
      id: r.id,
      title: r.title,
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: !!r.timedOut,
      logFile: r.logFile,
      class: r.class || '',
      reason: r.reason || ''
    }))
  };
  writeFileSync(join(OUT, 'bug-hunt-status.json'), JSON.stringify(summary, null, 2));

  let md = '# StarNet Bug Hunt Evidence\n\n';
  md += '- Generated: `' + summary.generatedAt + '`\n';
  md += '- Mode: `' + summary.mode + '`\n';
  md += '- Verdict: `' + summary.verdict + '`\n\n';
  md += '| Status | Step | Class | Notes |\n|---|---|---|---|\n';
  for (const r of results) {
    const note = r.status === 'skip' ? (r.reason || '')
      : r.timedOut ? (r.reason || 'Timed out.')
      : 'exit ' + r.exitCode;
    md += '| ' + statusLabel(r.status) + ' | `' + r.id + '` ' + mdEscape(r.title) + ' | '
      + mdEscape(r.class || '') + ' | ' + mdEscape(note) + ' |\n';
  }

  if (summary.goldenFlagged.length) {
    md += '\n## Golden Review Queue\n\n';
    for (const f of summary.goldenFlagged) {
      md += '- `' + f.name + '` diff `' + (f.diff == null ? 'new/missing' : f.diff) + '` frame `' + f.frame + '`\n';
    }
  }

  md += '\n## Fix Loop\n\n';
  md += '1. Fix any FAIL step before visual blessing.\n';
  md += '2. For REVIEW golden frames, inspect only the listed PNGs.\n';
  md += '3. If the frame is a regression, patch the smallest owner surface and rerun this command.\n';
  md += '4. If the frame is an intentional improvement, bless only after inspection.\n';
  md += '5. Before merge, rerun with `--full` and keep `npm run test:fast` green.\n';
  writeFileSync(join(OUT, 'summary.md'), md);

  rmSync(LATEST, { recursive: true, force: true });
  cpSync(OUT, LATEST, { recursive: true });
  return summary;
}

async function main() {
  ensureDir(OUT);
  const auditEnv = Object.assign({}, process.env);
  if (LIVE_AUDIT) auditEnv.SKYNET_AUDIT_LIVE_PROVIDER = '1';

  const steps = [
    { id: 'board', title: 'Coordination board and hot-file surface', cmd: nodeCmd, args: ['scripts/board.mjs'], class: 'coordination' },
    { id: 'validate-map', title: 'Static map/layout validity', cmd: npmCmd, args: ['run', 'validate'], class: 'static' },
    { id: 'test-world', title: 'Deterministic world behavior simulation', cmd: npmCmd, args: ['run', 'test:world'], class: 'simulation' },
    { id: 'audit', title: LIVE_AUDIT ? 'Behavioral audit with live provider' : 'Behavioral audit with deterministic provider', cmd: nodeCmd, args: ['scripts/audit.mjs'], env: auditEnv, skip: NO_AUDIT, reason: '--no-audit supplied', class: 'behavior' },
    { id: 'golden', title: 'Visual golden diff review', cmd: nodeCmd, args: ['scripts/golden.mjs'], skip: NO_VISUAL, reason: '--no-visual supplied', reviewExitCodes: [3], class: 'visual' },
    { id: 'test-fast', title: 'Full fast unit/contract gate', cmd: npmCmd, args: ['run', 'test:fast'], skip: !FULL, reason: 'quick mode; pass --full before merge', class: 'gate' },
    { id: 'test-http', title: 'HTTP/e2e sidecar gate', cmd: npmCmd, args: ['run', 'test:http'], skip: !FULL, reason: 'quick mode; pass --full for route/HTTP changes', class: 'gate' }
  ];

  const results = [];
  for (const step of steps) {
    const r = await runStep(step);
    results.push(r);
    if (r.status === 'fail') break;
  }
  const summary = writeSummary(results);
  console.log('[bug-hunt] evidence: ' + OUT);
  console.log('[bug-hunt] latest: ' + LATEST);
  if (summary.verdict === 'red') process.exit(1);
  if (summary.verdict === 'review') process.exit(3);
}

main().catch(e => {
  console.error('[bug-hunt] FATAL: ' + ((e && e.stack) || e));
  process.exit(1);
});
