#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { evaluate, readJsonl, recordTrajectory, writeJsonl } from './core.mjs';
import { compareHarnesses, evaluateFaultGauntlet, makeReceipt, validateComparisonContract, validateScenarioPack } from './comparison.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  tasks: join(HERE, 'fixtures', 'tasks.jsonl'),
  candidate: join(HERE, 'fixtures', 'candidate.jsonl'),
  baseline: join(HERE, 'fixtures', 'baseline.jsonl'),
  contract: join(HERE, 'contracts', 'v0.9.0.json'),
  claims: resolve(HERE, '..', '..', 'qa', 'product-perfect', 'claims.json'),
  faultPack: join(HERE, 'packs', 'fault-v0.9.0.jsonl'),
  parityPack: join(HERE, 'packs', 'parity-v0.9.0.jsonl')
};

function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) out._.push(arg);
    else {
      const [key, inline] = arg.slice(2).split('=', 2);
      out[key] = inline === undefined ? argv[++i] : inline;
    }
  }
  return out;
}

function ensureParent(file) { mkdirSync(dirname(resolve(file)), { recursive: true }); }
function readJson(file) { return JSON.parse(readFileSync(resolve(file), 'utf8').replace(/^\uFEFF/, '')); }
function sha256File(file) {
  const buf = readFileSync(resolve(file));
  return createHash('sha256').update(buf).digest('hex');
}
function git(args, fallback = '') {
  try { return execFileSync('git', args, { cwd: resolve(HERE, '..', '..'), encoding: 'utf8' }).trim(); }
  catch (_) { return fallback; }
}
function subjectMeta(opts) {
  const pkg = readJson(resolve(HERE, '..', '..', 'package.json'));
  const executable = opts.executable ? resolve(opts.executable) : '';
  let executableInfo = null;
  if (executable) {
    const st = statSync(executable);
    executableInfo = { path: executable, bytes: st.size, sha256: sha256File(executable) };
  }
  return {
    name: 'StarNet', version: pkg.version || '', commit: git(['rev-parse', 'HEAD']),
    sourceTree: { algorithm: 'git-tree', value: git(['rev-parse', 'HEAD^{tree}']) },
    executable: executableInfo,
    platform: { platform: process.platform, arch: process.arch, node: process.version },
    dirty: !!git(['status', '--porcelain'], '')
  };
}
function writeReceipt(file, receipt) {
  ensureParent(file);
  writeFileSync(resolve(file), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  console.log('[agent-eval] receipt ' + resolve(file));
}

function printReport(report, reportFile = '') {
  const s = report.summary;
  console.log(`[agent-eval] ${s.pass ? 'PASS' : 'FAIL'} active=${s.active} passed=${s.passed} failed=${s.failed} pending=${s.pending}`);
  for (const result of report.results) {
    if (result.status === 'pending') console.log(`[agent-eval] SKIP ${result.taskId} — pending adapter ${result.adapter || 'unassigned'}`);
    else console.log(`[agent-eval] ${result.pass ? 'PASS' : 'FAIL'} ${result.taskId}${result.failures && result.failures.length ? ' — ' + result.failures.join('; ') : ''}`);
  }
  if (reportFile) console.log('[agent-eval] report ' + resolve(reportFile));
}

async function run(opts) {
  const tasksFile = resolve(opts.tasks || DEFAULTS.tasks);
  const baselineFile = resolve(opts.baseline || DEFAULTS.baseline);
  let candidateRows;
  if (opts.candidate) candidateRows = readJsonl(resolve(opts.candidate));
  else {
    const { runBridgeAdapters } = await import('./adapters/bridge.mjs');
    candidateRows = readJsonl(DEFAULTS.candidate).filter(row => !String(row.taskId).startsWith('bridge-'));
    candidateRows.push(...await runBridgeAdapters());
  }
  if (opts['candidate-out']) {
    ensureParent(opts['candidate-out']);
    writeJsonl(resolve(opts['candidate-out']), candidateRows);
  }
  const report = evaluate({ tasks: readJsonl(tasksFile), candidateRows, baselineRows: readJsonl(baselineFile) });
  if (opts.report) {
    ensureParent(opts.report);
    writeFileSync(resolve(opts.report), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  printReport(report, opts.report);
  return report.summary.pass ? 0 : 1;
}

function record(opts) {
  if (!opts.task || !opts.input || !opts.output) throw new Error('record requires --task, --input, and --output');
  const rawEvents = readJsonl(resolve(opts.input));
  const meta = opts.meta ? JSON.parse(readFileSync(resolve(opts.meta), 'utf8')) : {};
  const trajectory = recordTrajectory({ taskId: opts.task, rawEvents, ...meta });
  ensureParent(opts.output);
  writeJsonl(resolve(opts.output), [trajectory]);
  console.log(`[agent-eval] recorded ${rawEvents.length} redacted events for ${opts.task} -> ${resolve(opts.output)}`);
  return 0;
}

function contractCheck(opts) {
  const contractFile = resolve(opts.contract || DEFAULTS.contract);
  const result = validateComparisonContract(readJson(contractFile), readJson(opts.claims || DEFAULTS.claims));
  console.log(`[agent-eval] CONTRACT ${result.ok ? 'PASS' : 'FAIL'} claims=${result.summary.claims} classified=${result.summary.classified}`);
  for (const error of result.errors) console.log('[agent-eval] FAIL ' + error);
  return result.ok ? 0 : 1;
}

function fault(opts) {
  if (!opts.candidate) throw new Error('fault requires --candidate <trajectory.jsonl>');
  const contract = readJson(opts.contract || DEFAULTS.contract);
  const contractResult = validateComparisonContract(contract, readJson(opts.claims || DEFAULTS.claims));
  if (!contractResult.ok) throw new Error('comparison contract is invalid: ' + contractResult.errors.join('; '));
  const tasks = readJsonl(resolve(opts.tasks || DEFAULTS.faultPack));
  const pack = validateScenarioPack(tasks, { expectedCount: 10, categories: { 'run-boundary': 10 } });
  if (!pack.ok) throw new Error('fault pack is invalid: ' + pack.errors.join('; '));
  const result = evaluateFaultGauntlet({ tasks, candidateRows: readJsonl(resolve(opts.candidate)) });
  const receipt = makeReceipt({ kind: 'fault', contract, subject: subjectMeta(opts), result,
    evidence: { tasks: resolve(opts.tasks || DEFAULTS.faultPack), candidate: resolve(opts.candidate) } });
  writeReceipt(opts.receipt || join('.dogfood', 'eval', 'fault-receipt.json'), receipt);
  console.log(`[agent-eval] FAULT ${result.pass ? 'PASS' : 'FAIL'} passed=${result.report.summary.passed}/${result.report.summary.active}`);
  return result.pass ? 0 : 1;
}

function compare(opts) {
  if (!opts.starnet || !opts.reference) throw new Error('compare requires --starnet <trajectory.jsonl> and --reference <trajectory.jsonl>');
  const contract = readJson(opts.contract || DEFAULTS.contract);
  const contractResult = validateComparisonContract(contract, readJson(opts.claims || DEFAULTS.claims));
  if (!contractResult.ok) throw new Error('comparison contract is invalid: ' + contractResult.errors.join('; '));
  const tasks = readJsonl(resolve(opts.tasks || DEFAULTS.parityPack));
  const pack = validateScenarioPack(tasks, { expectedCount: 32, categories: {
    'coding-file': 6, 'research-browser': 4, 'document-data': 4, 'memory-history': 4,
    orchestration: 6, 'routine-channel': 4, 'recovery-security': 4
  } });
  if (!pack.ok) throw new Error('parity pack is invalid: ' + pack.errors.join('; '));
  const result = compareHarnesses({ tasks, starnetRows: readJsonl(resolve(opts.starnet)), referenceRows: readJsonl(resolve(opts.reference)), contract });
  const receipt = makeReceipt({ kind: 'parity', contract, subject: subjectMeta(opts), reference: contract.reference, result,
    evidence: { tasks: resolve(opts.tasks || DEFAULTS.parityPack), starnet: resolve(opts.starnet), reference: resolve(opts.reference) } });
  writeReceipt(opts.receipt || join('.dogfood', 'eval', 'parity-receipt.json'), receipt);
  console.log(`[agent-eval] PARITY ${result.pass ? 'PASS' : 'FAIL'} StarNet=${result.summary.starnetPassRatePct.toFixed(1)}% reference=${result.summary.referencePassRatePct.toFixed(1)}% gap=${result.summary.gapPoints.toFixed(1)}pt`);
  return result.pass ? 0 : 1;
}

async function baseline(opts) {
  const contract = readJson(opts.contract || DEFAULTS.contract);
  const contractResult = validateComparisonContract(contract, readJson(opts.claims || DEFAULTS.claims));
  if (!contractResult.ok) throw new Error('comparison contract is invalid: ' + contractResult.errors.join('; '));
  const { collectPerformanceBaseline } = await import('./performance.mjs');
  const result = await collectPerformanceBaseline({ samples: Number(opts.samples || 15) });
  const receipt = makeReceipt({ kind: 'performance', contract, subject: subjectMeta(opts), result,
    evidence: { scope: 'dependency-free source harness; no provider or installed desktop' },
    limitations: ['first-token, useful-artifact, installed cold-boot, and 48-hour resource measurements remain pending'] });
  writeReceipt(opts.receipt || join('.dogfood', 'eval', 'performance-baseline.json'), receipt);
  console.log(`[agent-eval] PERFORMANCE BASELINE samples=${result.samples} bridgeMedian=${result.measurements.bridgeAdapterPackMs.median}ms evalMedian=${result.measurements.evaluationPackMs.median}ms`);
  return 0;
}

try {
  const opts = argsOf(process.argv.slice(2));
  const command = opts._[0] || 'run';
  if (command === 'run') process.exitCode = await run(opts);
  else if (command === 'record') process.exitCode = record(opts);
  else if (command === 'contract') process.exitCode = contractCheck(opts);
  else if (command === 'fault') process.exitCode = fault(opts);
  else if (command === 'compare') process.exitCode = compare(opts);
  else if (command === 'baseline') process.exitCode = await baseline(opts);
  else throw new Error('usage: runner.mjs [run|record|contract|fault|compare|baseline] [options]');
} catch (error) {
  console.error('[agent-eval] ERROR ' + ((error && error.message) || error));
  process.exitCode = 2;
}
