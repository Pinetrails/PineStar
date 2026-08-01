#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { evaluate, readJsonl, recordTrajectory, writeJsonl } from './core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  tasks: join(HERE, 'fixtures', 'tasks.jsonl'),
  candidate: join(HERE, 'fixtures', 'candidate.jsonl'),
  baseline: join(HERE, 'fixtures', 'baseline.jsonl')
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

function printReport(report, reportFile = '') {
  const s = report.summary;
  console.log(`[agent-eval] ${s.pass ? 'PASS' : 'FAIL'} active=${s.active} passed=${s.passed} failed=${s.failed} pending=${s.pending}`);
  for (const result of report.results) {
    if (result.status === 'pending') console.log(`[agent-eval] SKIP ${result.taskId} — pending adapter ${result.adapter || 'unassigned'}`);
    else console.log(`[agent-eval] ${result.pass ? 'PASS' : 'FAIL'} ${result.taskId}${result.failures && result.failures.length ? ' — ' + result.failures.join('; ') : ''}`);
  }
  if (reportFile) console.log('[agent-eval] report ' + resolve(reportFile));
}

function run(opts) {
  const tasksFile = resolve(opts.tasks || DEFAULTS.tasks);
  const candidateFile = resolve(opts.candidate || DEFAULTS.candidate);
  const baselineFile = resolve(opts.baseline || DEFAULTS.baseline);
  const report = evaluate({ tasks: readJsonl(tasksFile), candidateRows: readJsonl(candidateFile), baselineRows: readJsonl(baselineFile) });
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

try {
  const opts = argsOf(process.argv.slice(2));
  const command = opts._[0] || 'run';
  if (command === 'run') process.exitCode = run(opts);
  else if (command === 'record') process.exitCode = record(opts);
  else throw new Error('usage: runner.mjs [run|record] [--tasks file --candidate file --baseline file --report file]');
} catch (error) {
  console.error('[agent-eval] ERROR ' + ((error && error.message) || error));
  process.exitCode = 2;
}
