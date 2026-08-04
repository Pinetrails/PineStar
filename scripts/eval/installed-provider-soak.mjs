#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureMcpServer } from './campaign/fixture-host.mjs';
import { startStarNetDriver } from './campaign/drivers.mjs';
import { validateManifest } from './bind.mjs';
import { makeReceipt } from './comparison.mjs';
import { gradeParityTrajectory, validateParityFixtures } from './independent-grader.mjs';
import { signReceipt } from './receipt-signing.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const iso = ms => new Date(ms).toISOString();
const hashFile = file => createHash('sha256').update(readFileSync(resolve(file))).digest('hex');
function argsOf(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) out[String(argv[i] || '').replace(/^--/, '')] = argv[i + 1]; return out; }
function json(file) { return JSON.parse(readFileSync(resolve(file), 'utf8').replace(/^\uFEFF/, '')); }
function jsonl(file) { return readFileSync(resolve(file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); }
function finite(value, fallback = null) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function writeAtomic(file, value) { const target = resolve(file), temp = target + '.tmp'; mkdirSync(dirname(target), { recursive: true }); writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8'); renameSync(temp, target); }

export function installedRuntimeFingerprint(root, paths = ['frontend', 'sidecar', 'shared']) {
  const base = resolve(root), files = [];
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const path of paths) visit(resolve(base, path));
  files.sort((a, b) => relative(base, a).localeCompare(relative(base, b), 'en'));
  const hash = createHash('sha256');
  for (const file of files) {
    const name = relative(base, file).split(sep).join('/');
    hash.update(name).update('\0').update(createHash('sha256').update(readFileSync(file)).digest('hex')).update('\n');
  }
  return { algorithm: 'path-content-sha256', files: files.length, sha256: hash.digest('hex') };
}

export function requiredSoakCoverage(durationHours, intervalSeconds) {
  if (!(Number(durationHours) > 0) || !(Number(intervalSeconds) > 0)) throw new Error('soak duration and interval must be positive');
  return Math.max(1, Math.floor((Number(durationHours) * 3600 / Number(intervalSeconds)) * 0.99));
}

function processStats(pid) {
  if (process.platform !== 'win32') return { rssBytes: null, cpuSeconds: null };
  try {
    const script = `$p=Get-Process -Id ${Number(pid)} -ErrorAction Stop; [Console]::Write($p.WorkingSet64.ToString()+'|'+$p.CPU.ToString([Globalization.CultureInfo]::InvariantCulture))`;
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim().split('|');
    return { rssBytes: finite(raw[0]), cpuSeconds: finite(raw[1]) };
  } catch (_) { return { rssBytes: null, cpuSeconds: null }; }
}

async function main() {
  const opts = argsOf(process.argv.slice(2));
  for (const key of ['desktop-executable', 'runtime-root', 'workspaces', 'manifest', 'contract', 'fixtures', 'tasks', 'signing-key', 'output', 'receipt', 'output-dir']) if (!opts[key]) throw new Error(`missing --${key}`);
  const durationHours = finite(opts['duration-hours'], 48), healthIntervalSeconds = finite(opts['health-interval-seconds'], 60), activeIntervalSeconds = finite(opts['active-interval-seconds'], 3600);
  if (!(durationHours >= 48) && opts['allow-short-smoke'] !== '1') throw new Error('a qualifying provider-backed soak must run for at least 48 hours');
  if (!(healthIntervalSeconds >= 10) || !(activeIntervalSeconds >= healthIntervalSeconds)) throw new Error('invalid soak sampling intervals');
  const output = resolve(opts.output), receiptPath = resolve(opts.receipt), outputDir = resolve(opts['output-dir']), manifestPath = resolve(opts.manifest);
  const manifest = validateManifest(json(manifestPath)), subject = manifest.subject, tasks = jsonl(opts.tasks), fixtures = jsonl(opts.fixtures), validation = validateParityFixtures(tasks, fixtures);
  if (!validation.ok) throw new Error('fixture pack invalid: ' + validation.errors.join('; '));
  const task = tasks.find(row => row.id === 'parity-code-inspect'), fixture = fixtures.find(row => row.taskId === task?.id);
  if (!task || !fixture) throw new Error('provider activity fixture is missing');
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(outputDir, { recursive: true });
  const runtimePaths = subject.provenance?.runtime?.paths || ['frontend', 'sidecar', 'shared'];
  const initialRuntimeFingerprint = installedRuntimeFingerprint(opts['runtime-root'], runtimePaths);
  const executablePath = resolve(subject.executable.path), expectedExecutableSha256 = subject.executable.sha256;
  const desktopExecutable = resolve(opts['desktop-executable']);
  if (desktopExecutable !== executablePath) throw new Error('soak desktop executable does not match the candidate manifest path');
  const fixtureServer = await startFixtureMcpServer(); let driver = null, interrupted = false;
  const startedAt = Date.now(), deadline = startedAt + durationHours * 3600000;
  const report = {
    schemaVersion: 'starnet.eval.installed-provider-soak.v1', mode: 'installed-provider-backed-active-idle', qualifyingDuration: durationHours >= 48, qualifiesRelease: false,
    startedAt: iso(startedAt), plannedEndAt: iso(deadline), durationHours, healthIntervalSeconds, activeIntervalSeconds,
    runtime: { root: resolve(opts['runtime-root']), workspace: resolve(opts.workspaces), port: null, describe: subject.provenance.describe,
      executable: executablePath, executableSha256: expectedExecutableSha256, rawHealthVersion: null, initialFingerprint: initialRuntimeFingerprint },
    samples: [], providerRuns: [], summary: { pass: false, completed: false, healthChecks: 0, healthFailures: 0, providerChecks: 0, providerFailures: 0, identityFailures: 0, unexpectedExits: 0 }
  };
  const stop = () => { interrupted = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    driver = await startStarNetDriver({ desktopExecutable, root: opts['runtime-root'], workspaces: opts.workspaces, fixtureUrl: fixtureServer.url, outputDir, timeoutMs: 300000 });
    if (driver.identity.mode !== 'installed-desktop' || driver.identity.health?.status !== 'ok' || String(driver.identity.health?.version || '') !== String(subject.provenance.describe)) throw new Error('installed desktop soak health identity does not match the manifest');
    report.runtime.rawHealthVersion = String(driver.identity.health?.version || '');
    report.runtime.port = Number(new URL(driver.base).port);
    report.pid = driver.process.pid; let nextHealth = Date.now(), nextActive = Date.now(), activeAttempt = 0;
    while (!interrupted && Date.now() < deadline) {
      const clock = Date.now();
      if (clock >= nextActive) {
        activeAttempt++; const root = mkdtempSync(join(outputDir, `soak-provider-a${activeAttempt}-`)), state = fixtureServer.activate(fixture, root), began = Date.now();
        try {
          const row = await driver.run({ fixture, state, root, attempt: activeAttempt }), grade = gradeParityTrajectory(task, fixture, row, validation.fixtureSha256);
          const executableHashMatch = hashFile(executablePath) === expectedExecutableSha256;
          const runtimeFingerprint = installedRuntimeFingerprint(opts['runtime-root'], runtimePaths);
          const runtimeFingerprintMatch = runtimeFingerprint.sha256 === initialRuntimeFingerprint.sha256 && runtimeFingerprint.files === initialRuntimeFingerprint.files;
          const ok = grade.passed && row.metrics.provider === 'openai-codex' && row.metrics.model === 'gpt-5.6-luna' && row.hostEvidence.fixtureCalls.length > 0 && executableHashMatch && runtimeFingerprintMatch;
          report.providerRuns.push({ at: iso(began), ok, runId: row.runId, totalMs: row.metrics.totalMs, firstOutputMs: row.metrics.firstOutputMs, model: row.metrics.model, provider: row.metrics.provider, fixtureCalls: row.hostEvidence.fixtureCalls.length, executableHashMatch, runtimeFingerprintMatch, runtimeFingerprint, finalTextSha256: createHash('sha256').update(row.finalText).digest('hex'), failedChecks: grade.checks.filter(check => !check.pass).map(check => check.id) });
          if (!executableHashMatch || !runtimeFingerprintMatch) report.summary.identityFailures++;
          report.summary.providerChecks++; if (!ok) report.summary.providerFailures++;
        } catch (error) {
          report.providerRuns.push({ at: iso(began), ok: false, error: String(error.message || error).slice(0, 1000) }); report.summary.providerChecks++; report.summary.providerFailures++;
        } finally { rmSync(root, { recursive: true, force: true }); }
        while (nextActive <= Date.now()) nextActive += activeIntervalSeconds * 1000;
      }
      if (Date.now() >= nextHealth) {
        const at = Date.now(); let ok = false, status = 0, version = '', error = '';
        let executableHashMatch = false;
        try { executableHashMatch = hashFile(executablePath) === expectedExecutableSha256; } catch (caught) { error = String(caught.message || caught).slice(0, 240); }
        try { const response = await fetch(driver.base + '/health', { signal: AbortSignal.timeout(5000) }); status = response.status; const body = await response.json(); version = String(body.version || ''); ok = response.ok && body.status === 'ok' && version === String(subject.provenance.describe) && executableHashMatch; }
        catch (caught) { error = String(caught.message || caught).slice(0, 240); }
        const stats = processStats(driver.process.pid), exited = driver.process.exitCode != null;
        report.samples.push({ at: iso(at), ok, status, version, executableHashMatch, rssBytes: stats.rssBytes, cpuSeconds: stats.cpuSeconds, exited, error });
        report.summary.healthChecks++; if (!ok) report.summary.healthFailures++; if (!executableHashMatch) report.summary.identityFailures++; if (exited) { report.summary.unexpectedExits++; break; }
        while (nextHealth <= Date.now()) nextHealth += healthIntervalSeconds * 1000;
      }
      const rss = report.samples.map(row => row.rssBytes).filter(Number.isFinite);
      report.summary.rssBytes = rss.length ? { first: rss[0], last: rss.at(-1), min: Math.min(...rss), max: Math.max(...rss) } : null;
      report.updatedAt = iso(Date.now()); writeAtomic(output, report);
      const next = Math.min(nextHealth, nextActive, deadline); await sleep(Math.max(1, Math.min(1000, next - Date.now())));
    }
    report.endedAt = iso(Date.now()); report.interrupted = interrupted; report.summary.completed = !interrupted && Date.now() >= deadline;
    const healthMinimum = requiredSoakCoverage(durationHours, healthIntervalSeconds), activeMinimum = requiredSoakCoverage(durationHours, activeIntervalSeconds);
    const resourcesGood = process.platform !== 'win32' || report.samples.every(row => finite(row.rssBytes, 0) > 0 && finite(row.cpuSeconds, -1) >= 0);
    report.summary.required = { healthMinimum, activeMinimum };
    report.summary.pass = report.qualifyingDuration && report.summary.completed && report.samples.length >= healthMinimum && report.providerRuns.length >= activeMinimum && report.summary.healthFailures === 0 && report.summary.providerFailures === 0 && report.summary.identityFailures === 0 && report.summary.unexpectedExits === 0 && resourcesGood;
    report.qualifiesRelease = report.summary.pass;
    writeAtomic(output, report);
    if (!report.summary.pass) throw new Error('installed provider-backed soak did not meet its qualifying gates');
    const result = { schemaVersion: 'starnet.eval.installed-provider-soak-verdict.v1', pass: true, qualifiesRelease: true, scope: report.mode, durationHours, samples: report.samples.length, providerRuns: report.providerRuns.length, summary: report.summary, resources: { rssBytes: report.summary.rssBytes } };
    let receipt = makeReceipt({ kind: 'installed-provider-soak', contract: json(opts.contract), subject, result,
      evidence: { path: output, bytes: statSync(output).size, sha256: hashFile(output), manifestPath, manifestSha256: hashFile(manifestPath), fixtureSetSha256: validation.fixtureSha256 } });
    receipt = signReceipt(receipt, opts['signing-key']); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    console.log(`[agent-eval] INSTALLED PROVIDER SOAK PASS health=${report.samples.length} provider=${report.providerRuns.length} duration=${durationHours}h`);
    console.log(`[agent-eval] receipt ${receiptPath}`);
  } catch (error) {
    report.endedAt = report.endedAt || iso(Date.now()); report.interrupted = interrupted; report.error = String(error.stack || error).slice(0, 4000); writeAtomic(output, report); throw error;
  } finally { if (driver) await driver.close(); await fixtureServer.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error('[agent-eval] installed provider soak failed:', error && error.message || error); process.exit(1); });
}
