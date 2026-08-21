#!/usr/bin/env node
/* scripts/qa/soak.mjs — the SCRIPTED, HERMETIC, UNATTENDED soak (reliability item 4).
 *
 * WHY THIS EXISTS: until now "soak" meant a human left the packaged app running on the dev desktop for
 * 15–48h and eyeballed it. It blocked the desktop, produced no machine-readable verdict, and its one
 * failure (the first v0.10.0 soak) cost ~15h before anyone could say what broke. This runner boots a
 * hermetic SOURCE sidecar (scratch workspace + scratch app-data profile, free port, MOCK provider — zero
 * provider spend), drives a repeating workload for `--minutes N`, samples the process every tick, and
 * writes a receipt with an explicit PASS/FAIL per rule. A 6-minute smoke and a 12-hour soak are the
 * same harness with a different `--minutes`.
 *
 * WORKLOAD (per tick, see runSoak):
 *   · /api/health latency probe (3 GETs; median + max)     · /api/diagnostics read (swallowed tally, error ring)
 *   · /api/state/snapshot read                             · OS-level RSS sample of the sidecar pid
 *   · every `--run-every` ticks: a real /api/run conversation (deterministic mock answer)
 *   · every `--tool-every` ticks: a real /api/run that the mock steers into shell_exec (a real child process)
 *   · a routine "every 1 minute" armed at start; the cron driver fires it on its own (fires are counted)
 *   · every `--restart-every` minutes: stop → boot on the SAME workspace → every persisted entity must come back
 *
 * VERDICT RULES (evaluate): see RULES below — each rule states its threshold and the reason for it in the
 * receipt. An unobtainable metric is `null` with a reason, never 0.
 *
 * HOUSE PATTERN (matches scripts/qa/packaged-lifecycle.mjs): the CORE (arg parsing, statistics, evaluate,
 * receipt) is pure and tests headlessly (test/soak.test.js); the orchestrator takes injected `drivers`;
 * the INVOKED_DIRECTLY block is the one place the real sidecar, fs, and OS process tools live.
 *
 * NO NEW DEPS: node built-ins only. Reuses test/helpers/sidecar-fixture.js for the hermetic boot contract.
 *
 * NOT A REPLACEMENT for the attended packaged-desktop soak (docs/RELEASE_RUNBOOK.md): this is the source
 * sidecar under a mock provider — it cannot see the Tauri shell, WebView2, the installer, or real provider
 * behavior. It is the mandatory machine verdict that runs BEFORE the human spends desktop hours.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

/* ─────────────────────────────── PURE CORE ─────────────────────────────── */

export const RECEIPT_SCHEMA = 'starnet.soak-receipt.v1';
export const MOCK_MODEL = 'soak/mock';
export const SOAK_AGENT = 'soak_agent';
export const SOAK_STREAM = 'soak-stream';
export const CONVERSATION_REPLY = 'SOAK_REPLY: acknowledged.';
export const TOOL_MARKER = 'SOAK_TOOL';
export const TOOL_STDOUT = 'SOAK_TOOL_OK';

export const DEFAULTS = Object.freeze({
  minutes: 20,
  tickSeconds: 15,
  runEvery: 2,          // ticks between conversation runs
  toolEvery: 4,         // ticks between tool runs
  restartEvery: 10,     // minutes between restart cycles (clamped to fit ≥1 cycle in short soaks)
  maxSamples: 600,      // receipt tick samples are downsampled to this many points
  cronTickMs: 10_000,   // the sidecar's scheduler tick while soaking (routine is "every 1 minute")
});

/* THE RULES — thresholds + why. Every number here is printed into the receipt beside the measurement. */
export const RULES = Object.freeze({
  completed: {
    title: 'soak ran to its planned end',
    why: 'an interrupted soak has measured nothing about the tail, which is where leaks and stalls show; INCOMPLETE is a FAIL, never a PASS by absence of evidence',
  },
  runs: {
    title: 'run failures',
    tolerance: 0,
    minRuns: 1,
    why: 'the provider is a deterministic local mock that never errors, so every run error is a harness defect; a soak with zero completed runs measured no workload and fails too',
  },
  routine: {
    title: 'scheduled routine fired',
    minFires: 1,
    why: 'the cron driver is the seam a long-running station depends on most; zero fires across the whole soak means the scheduler never ran',
  },
  swallowed: {
    title: 'swallowed-error pressure (failopen tally)',
    maxRatePerMin: 0.2,
    minCount: 3,
    why: 'with a mock provider the steady-state fail-open count should be ~0; a permanently broken 60s maintenance loop shows as ≥1/min, so a sustained ≥0.2/min over the LAST THIRD (and at least 3 events, so a single blip cannot fail a short soak) is unbounded growth. Tallies reset on restart, so deltas are summed within a boot epoch only',
  },
  rss: {
    title: 'RSS leak trend',
    maxSlopeMBPerMin: 2,
    minGrowthPct: 20,
    minPoints: 5,
    why: 'least-squares slope of RSS over the LAST HALF of the longest boot epoch in that half. 2 MB/min compounds to ~1.4 GB over a 12h soak — a leak by any definition; GC noise on a ~100 MB heap swings tens of MB but not monotonically, so BOTH the slope and ≥20% growth across the window are required. Epochs under 5 points are not judged (null, with reason)',
  },
  latency: {
    title: '/api/health p95 latency (event-loop stall proxy)',
    maxP95Ms: 500,
    why: 'loopback health on a healthy loop answers in single-digit ms; a p95 over 500 ms across the LAST HALF means the event loop is stalling (blocked timers, sync I/O, GC thrash) — the class of degradation a human soak catches only as "it feels sluggish"',
  },
  restart: {
    title: 'restart cycles keep every persisted entity',
    why: 'agents, routines, run history, and conversation turns a user expects to survive must round-trip a stop/boot on the same workspace; any id present before and missing after is data loss (the top recurring bug class)',
  },
  process: {
    title: 'sidecar never died and never orphaned a child',
    why: 'an unplanned exit is a crash; a child process alive after the sidecar stopped is the close-zombie class (0.10.5/0.10.6)',
  },
});

export function parseArgs(argv) {
  const o = {};
  for (const a of argv || []) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) o[m[1]] = m[2] === undefined ? true : m[2];
  }
  const num = (k, d, min) => {
    if (o[k] === undefined || o[k] === true) return d;
    const n = Number(o[k]);
    if (!Number.isFinite(n) || n < min) throw new Error(`--${k} must be a number ≥ ${min}`);
    return n;
  };
  const minutes = num('minutes', DEFAULTS.minutes, 1);
  const tickSeconds = num('tick-seconds', DEFAULTS.tickSeconds, 5);
  // a short soak must still contain ≥1 restart cycle: clamp the interval to half the soak
  const restartEvery = Math.min(num('restart-every', DEFAULTS.restartEvery, 1), Math.max(1, Math.floor(minutes / 2)));
  return {
    minutes,
    tickSeconds,
    runEvery: num('run-every', DEFAULTS.runEvery, 1),
    toolEvery: num('tool-every', DEFAULTS.toolEvery, 1),
    restartEvery,
    maxSamples: num('max-samples', DEFAULTS.maxSamples, 10),
    out: typeof o.out === 'string' && o.out ? o.out : null,
    aux: o.aux === true || o.aux === 'true',
    help: o.help === true,
  };
}

export function percentile(values, p) {
  const xs = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

/** Least-squares slope of y over x (x in minutes). null when under two distinct x. */
export function linearSlope(points) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) * (p.x - mx); }
  return den === 0 ? null : num / den;
}

/** Even downsample to at most `max` points, always keeping the first and last. */
export function boundSamples(samples, max) {
  const xs = Array.isArray(samples) ? samples : [];
  if (xs.length <= max) return xs.slice();
  const out = [];
  const step = (xs.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(xs[Math.round(i * step)]);
  return out;
}

function tail(xs, fraction) { return xs.slice(Math.floor(xs.length * (1 - fraction))); }
function minutesFrom(t0, t) { return (t - t0) / 60_000; }

/* A tick sample:
   { at, epoch, rssBytes|null, rssReason?, healthMs:{median,max}|null, swallowedTotal|null, swallowedTags:{tag:n}|null,
     errorRing:[ts...]|null, workspaceBytes|null, runs:{ok,failed}, routineFires } */

export function evaluate(input) {
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const restarts = Array.isArray(input.restarts) ? input.restarts : [];
  const runs = input.runs || { ok: 0, failed: 0, errors: [] };
  const routineFires = Number(input.routineFires) || 0;
  const process = input.process || { unexpectedExits: 0, orphans: [] };
  const t0 = samples.length ? samples[0].at : 0;
  const rules = {};

  // completed
  rules.completed = { pass: input.completed === true, actual: { completed: input.completed === true, reason: input.stopReason || null }, expected: { completed: true }, why: RULES.completed.why };

  // runs
  rules.runs = {
    pass: (runs.failed || 0) <= RULES.runs.tolerance && (runs.ok || 0) >= RULES.runs.minRuns,
    actual: { ok: runs.ok || 0, failed: runs.failed || 0, errors: (runs.errors || []).slice(0, 10) },
    expected: { failed: `<= ${RULES.runs.tolerance}`, ok: `>= ${RULES.runs.minRuns}` }, why: RULES.runs.why,
  };

  // routine
  rules.routine = { pass: routineFires >= RULES.routine.minFires, actual: { fires: routineFires }, expected: { fires: `>= ${RULES.routine.minFires}` }, why: RULES.routine.why };

  // swallowed: sum positive within-epoch deltas over the last third
  {
    const third = tail(samples, 1 / 3).filter((s) => Number.isFinite(s.swallowedTotal));
    if (third.length < 2) {
      rules.swallowed = { pass: true, actual: { ratePerMin: null, count: null, reason: 'fewer than 2 swallowed-tally samples in the last third' }, expected: { ratePerMin: `<= ${RULES.swallowed.maxRatePerMin}`, orCount: `< ${RULES.swallowed.minCount}` }, why: RULES.swallowed.why };
    } else {
      let count = 0;
      for (let i = 1; i < third.length; i++) {
        if (third[i].epoch !== third[i - 1].epoch) continue;
        count += Math.max(0, third[i].swallowedTotal - third[i - 1].swallowedTotal);
      }
      const span = minutesFrom(third[0].at, third[third.length - 1].at);
      const rate = span > 0 ? count / span : (count > 0 ? Infinity : 0);
      const tags = third[third.length - 1].swallowedTags || null;
      rules.swallowed = {
        pass: !(rate > RULES.swallowed.maxRatePerMin && count >= RULES.swallowed.minCount),
        actual: { ratePerMin: Number.isFinite(rate) ? +rate.toFixed(3) : rate, count, windowMinutes: +span.toFixed(2), lastTags: tags, totalAtEnd: third[third.length - 1].swallowedTotal },
        expected: { ratePerMin: `<= ${RULES.swallowed.maxRatePerMin}`, orCount: `< ${RULES.swallowed.minCount}` }, why: RULES.swallowed.why,
      };
    }
  }

  // rss: longest epoch inside the last half
  {
    const half = tail(samples, 1 / 2).filter((s) => Number.isFinite(s.rssBytes));
    const byEpoch = new Map();
    for (const s of half) { if (!byEpoch.has(s.epoch)) byEpoch.set(s.epoch, []); byEpoch.get(s.epoch).push(s); }
    let best = null;
    for (const [epoch, xs] of byEpoch) if (!best || xs.length > best.xs.length) best = { epoch, xs };
    if (!best || best.xs.length < RULES.rss.minPoints) {
      const reason = half.length ? `longest boot epoch in the last half has ${best ? best.xs.length : 0} RSS points (< ${RULES.rss.minPoints})` : (samples.some((s) => s.rssReason) ? samples.find((s) => s.rssReason).rssReason : 'no RSS samples');
      rules.rss = { pass: true, actual: { slopeMBPerMin: null, growthPct: null, reason }, expected: { slopeMBPerMin: `<= ${RULES.rss.maxSlopeMBPerMin}`, orGrowthPct: `< ${RULES.rss.minGrowthPct}` }, why: RULES.rss.why };
    } else {
      const xs = best.xs;
      const slopeB = linearSlope(xs.map((s) => ({ x: minutesFrom(t0, s.at), y: s.rssBytes })));
      const slopeMB = slopeB / (1024 * 1024);
      const growthPct = ((xs[xs.length - 1].rssBytes - xs[0].rssBytes) / xs[0].rssBytes) * 100;
      rules.rss = {
        pass: !(slopeMB > RULES.rss.maxSlopeMBPerMin && growthPct >= RULES.rss.minGrowthPct),
        actual: { slopeMBPerMin: +slopeMB.toFixed(3), growthPct: +growthPct.toFixed(1), epoch: best.epoch, points: xs.length, firstMB: +(xs[0].rssBytes / 1048576).toFixed(1), lastMB: +(xs[xs.length - 1].rssBytes / 1048576).toFixed(1), peakMB: +(Math.max(...samples.filter((s) => Number.isFinite(s.rssBytes)).map((s) => s.rssBytes)) / 1048576).toFixed(1) },
        expected: { slopeMBPerMin: `<= ${RULES.rss.maxSlopeMBPerMin}`, orGrowthPct: `< ${RULES.rss.minGrowthPct}` }, why: RULES.rss.why,
      };
    }
  }

  // latency: p95 of per-tick max over the last half
  {
    const half = tail(samples, 1 / 2).map((s) => s.healthMs && s.healthMs.max).filter((v) => Number.isFinite(v));
    const p95 = percentile(half, 95);
    const all = samples.map((s) => s.healthMs && s.healthMs.median).filter((v) => Number.isFinite(v));
    rules.latency = {
      pass: p95 === null ? true : p95 <= RULES.latency.maxP95Ms,
      actual: { p95Ms: p95, points: half.length, medianOfMediansMs: percentile(all, 50), maxMs: half.length ? Math.max(...half) : null, reason: p95 === null ? 'no health latency samples in the last half' : undefined },
      expected: { p95Ms: `<= ${RULES.latency.maxP95Ms}` }, why: RULES.latency.why,
    };
  }

  // restart
  {
    const cycles = restarts.map((r) => {
      const lost = {};
      for (const k of Object.keys(r.before || {})) {
        const b = new Set(r.before[k] || []), a = new Set((r.after || {})[k] || []);
        const missing = [...b].filter((id) => !a.has(id));
        if (missing.length) lost[k] = missing.slice(0, 20);
      }
      return { at: r.at, epoch: r.epoch, bootMs: r.bootMs ?? null, stopMode: r.stopMode || null, counts: Object.fromEntries(Object.keys(r.before || {}).map((k) => [k, { before: (r.before[k] || []).length, after: ((r.after || {})[k] || []).length }])), lost, ok: Object.keys(lost).length === 0 && r.error == null, error: r.error || null };
    });
    rules.restart = { pass: cycles.length > 0 && cycles.every((c) => c.ok), actual: { cycles: cycles.length, failed: cycles.filter((c) => !c.ok).length, detail: cycles, reason: cycles.length ? undefined : 'no restart cycle completed' }, expected: { cycles: '>= 1', lost: 'none' }, why: RULES.restart.why };
  }

  // process
  rules.process = { pass: (process.unexpectedExits || 0) === 0 && (process.orphans || []).length === 0, actual: { unexpectedExits: process.unexpectedExits || 0, orphans: (process.orphans || []).slice(0, 20), orphanCheck: process.orphanCheck || null }, expected: { unexpectedExits: 0, orphans: 0 }, why: RULES.process.why };

  const failed = Object.keys(rules).filter((k) => !rules[k].pass);
  return { verdict: failed.length ? 'FAIL' : 'PASS', failedRules: failed, rules };
}

export function buildReceipt(input) {
  const ev = evaluate(input);
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const ws = samples.map((s) => s.workspaceBytes).filter((v) => Number.isFinite(v));
  const ring = samples.map((s) => s.errorRingSeen).filter((v) => Number.isFinite(v));
  return {
    schema: RECEIPT_SCHEMA,
    verdict: ev.verdict,
    failedRules: ev.failedRules,
    sidecarHead: input.meta && input.meta.sidecarHead || null,
    startedAt: input.startedAt ? new Date(input.startedAt).toISOString() : null,
    endedAt: input.endedAt ? new Date(input.endedAt).toISOString() : null,
    plannedMinutes: input.plannedMinutes ?? null,
    actualMinutes: input.startedAt && input.endedAt ? +((input.endedAt - input.startedAt) / 60_000).toFixed(2) : null,
    options: input.options || null,
    meta: input.meta || {},
    rules: ev.rules,
    measurements: {
      // measurements without a verdict rule — reported, never judged
      workspaceBytes: ws.length ? { first: ws[0], last: ws[ws.length - 1], growth: ws[ws.length - 1] - ws[0] } : { first: null, last: null, growth: null, reason: 'workspace size not sampled' },
      errorRingSeen: ring.length ? ring[ring.length - 1] : null,
      heapBytes: null, heapReason: 'the sidecar exposes no process.memoryUsage endpoint; RSS is sampled at the OS level instead',
      openHandles: null, openHandlesReason: 'open-handle counts need an in-process hook or a native tool; not obtainable from outside the sidecar with built-ins',
      restarts: (input.restarts || []).length,
      ticks: samples.length,
    },
    processSnapshots: (input.processSnapshots || []).slice(-50),
    samples: boundSamples(samples, input.maxSamples || DEFAULTS.maxSamples),
  };
}

export function renderSummary(r) {
  const L = [];
  L.push(`# StarNet soak — ${r.verdict}`);
  L.push('');
  L.push(`- schema: ${r.schema}`);
  L.push(`- sidecar head: ${r.sidecarHead || 'unknown'}`);
  L.push(`- window: ${r.startedAt} → ${r.endedAt} (${r.actualMinutes} of ${r.plannedMinutes} planned minutes)`);
  L.push(`- ticks: ${r.measurements.ticks} · restarts: ${r.measurements.restarts} · stop mode: ${r.meta && r.meta.stopMode || 'unknown'}`);
  L.push('');
  L.push('| rule | verdict | measured | threshold |');
  L.push('|---|---|---|---|');
  for (const [k, v] of Object.entries(r.rules)) {
    const actual = Object.assign({}, v.actual); delete actual.detail; delete actual.lastTags; delete actual.errors;
    L.push(`| ${k} | ${v.pass ? 'PASS' : 'FAIL'} | \`${JSON.stringify(actual)}\` | \`${JSON.stringify(v.expected)}\` |`);
  }
  L.push('');
  L.push('## Measurements (no rule)');
  L.push(`- workspace bytes: ${JSON.stringify(r.measurements.workspaceBytes)}`);
  L.push(`- diagnostics error ring entries seen: ${r.measurements.errorRingSeen}`);
  L.push(`- heap: null (${r.measurements.heapReason})`);
  L.push(`- open handles: null (${r.measurements.openHandlesReason})`);
  L.push('');
  L.push('## Why each threshold');
  for (const [k, v] of Object.entries(r.rules)) L.push(`- **${k}** — ${v.why}`);
  L.push('');
  L.push('This is the scripted source-sidecar soak under a mock provider. It does not replace the attended packaged-desktop soak.');
  return L.join('\n') + '\n';
}

/* ─────────────────────────────── ORCHESTRATOR (injected drivers) ─────────────────────────────── */

/* drivers = {
     boot(): Promise<{pid}>        restart(): Promise<{pid, bootMs}>      stop(): Promise<void>
     isAlive(): bool               childrenOf(pid): Promise<number[]|null>
     json(method, route, body): Promise<{status, body}>     runConversation(text): Promise<{reason, events}>
     rss(pid): Promise<number|null>     workspaceBytes(): number|null
     now(): number     sleep(ms): Promise<void>     log(msg)
   } */
export async function runSoak(drivers, opts, hooks) {
  const now = drivers.now, log = drivers.log || (() => {});
  const state = {
    samples: [], restarts: [], processSnapshots: [],
    runs: { ok: 0, failed: 0, errors: [] }, routineFires: 0,
    process: { unexpectedExits: 0, orphans: [], orphanCheck: null },
    epoch: 0, completed: false, stopReason: null,
  };
  const seenRoutineRuns = new Set();
  const errorRingSeen = new Set();
  const startedAt = now();
  const endAt = startedAt + opts.minutes * 60_000;
  let lastRestartAt = startedAt;
  let routineId = null;

  const entities = async () => {
    const out = { agents: [], routines: [], runs: [], turns: [] };
    try { const d = await drivers.json('GET', '/api/diagnostics'); const n = d.body && d.body.report && d.body.report.agentCount; out.agents = Array.from({ length: Number(n) || 0 }, (_, i) => 'agent#' + i); } catch (e) { out.agents = null; }
    try { const c = await drivers.json('GET', '/api/cron'); out.routines = (c.body && c.body.jobs || []).map((j) => j.id); } catch (e) { out.routines = null; }
    try { const r = await drivers.json('GET', '/api/runs?agent=*&limit=500'); out.runs = (r.body && r.body.runs || []).map((x) => x.runId); } catch (e) { out.runs = null; }
    try { const t = await drivers.json('GET', `/api/transcript?agent=${SOAK_AGENT}&stream=${SOAK_STREAM}&limit=500`); out.turns = (t.body && t.body.turns || []).map((x, i) => i + '|' + (x.ts || '') + '|' + (x.role || '')); } catch (e) { out.turns = null; }
    for (const k of Object.keys(out)) if (out[k] === null) delete out[k];   // unreadable before → cannot judge; never a fake empty set
    return out;
  };

  const seed = async () => {
    const roster = await drivers.json('POST', '/api/roster', { updatedAt: now(), agents: [{ agentId: SOAK_AGENT, name: 'SOAK', system: 'You are the soak agent. Answer briefly.', provider: 'openrouter', model: MOCK_MODEL, approvalMode: 'full', executionProfile: 'trusted-project' }] });
    if (!(roster.body && roster.body.ok)) throw new Error('roster seed failed: ' + JSON.stringify(roster.body).slice(0, 300));
    const cron = await drivers.json('POST', '/api/cron', { name: 'soak heartbeat routine', prompt: 'Soak routine: reply with one line.', schedule: 'every 1 minute', agentId: SOAK_AGENT, model: MOCK_MODEL, provider: 'openrouter', deliver: 'local', enabled: true, misfire: 'fire_once' });
    if (!(cron.body && cron.body.ok && cron.body.job)) throw new Error('routine create failed: ' + JSON.stringify(cron.body).slice(0, 300));
    routineId = cron.body.job.id;
    const armed = await drivers.json('POST', '/api/cron/arm', { enabled: true });
    log(`[soak] seeded agent ${SOAK_AGENT}, routine ${routineId} (arm → ${armed.status})`);
  };

  const sample = async (tick) => {
    const s = { at: now(), tick, epoch: state.epoch, rssBytes: null, healthMs: null, swallowedTotal: null, swallowedTags: null, errorRingSeen: null, workspaceBytes: null, runs: { ok: state.runs.ok, failed: state.runs.failed }, routineFires: state.routineFires };
    const lat = [];
    for (let i = 0; i < 3; i++) { const t = now(); try { await drivers.json('GET', '/api/health'); lat.push(now() - t); } catch (e) { lat.push(NaN); } }
    const good = lat.filter(Number.isFinite);
    s.healthMs = good.length ? { median: percentile(good, 50), max: Math.max(...good), failed: 3 - good.length } : null;
    try {
      const d = await drivers.json('GET', '/api/diagnostics');
      const rep = d.body && d.body.report;
      if (rep && rep.swallowed && rep.swallowed.present) {
        s.swallowedTotal = rep.swallowed.total;
        s.swallowedTags = Object.fromEntries((rep.swallowed.tags || []).map((t) => [t.tag, t.count]));
      } else s.swallowedReason = 'diagnostics.swallowed not present';
      for (const e of (rep && rep.errors) || []) errorRingSeen.add(`${e.ts}|${e.message}`);
      s.errorRingSeen = errorRingSeen.size;
    } catch (e) { s.swallowedReason = 'diagnostics unreadable: ' + (e && e.message); }
    try { await drivers.json('GET', '/api/state/snapshot'); } catch (e) { s.snapshotError = String(e && e.message); }
    try { const pid = drivers.pid(); const r = await drivers.rss(pid); if (Number.isFinite(r)) s.rssBytes = r; else s.rssReason = 'OS memory probe returned nothing for pid ' + pid; } catch (e) { s.rssReason = 'OS memory probe failed: ' + (e && e.message); }
    try { const b = drivers.workspaceBytes(); s.workspaceBytes = Number.isFinite(b) ? b : null; } catch (e) { s.workspaceBytes = null; }
    try {
      const c = await drivers.json('GET', '/api/cron');
      const job = (c.body && c.body.jobs || []).find((j) => j.id === routineId);
      if (job && job.lastRunId && !seenRoutineRuns.has(job.lastRunId)) { seenRoutineRuns.add(job.lastRunId); state.routineFires++; s.routineFires = state.routineFires; s.routineLast = { status: job.lastStatus, reason: job.lastReason }; }
    } catch (e) { /* measurement only */ }
    state.samples.push(s);
    if (hooks && hooks.onSample) hooks.onSample(s);
    return s;
  };

  const doRun = async (kind) => {
    const text = kind === 'tool' ? `${TOOL_MARKER} run the soak command` : 'Soak conversation: say hello.';
    try {
      const r = await drivers.runConversation(text);
      const toolOk = kind !== 'tool' || r.toolOk === true;
      if (r.reason === 'done' && toolOk) state.runs.ok++;
      else { state.runs.failed++; state.runs.errors.push({ at: now(), kind, reason: r.reason, toolOk, detail: r.detail || null }); }
    } catch (e) { state.runs.failed++; state.runs.errors.push({ at: now(), kind, reason: 'exception', detail: String(e && e.message) }); }
  };

  const restartCycle = async () => {
    const rec = { at: now(), epoch: state.epoch, before: null, after: null, bootMs: null, stopMode: drivers.stopMode || null, error: null };
    try {
      rec.before = await entities();
      const pid = drivers.pid();
      await drivers.stop();
      const kids = await drivers.childrenOf(pid);
      state.process.orphanCheck = kids === null ? 'child enumeration unavailable on this host' : 'enumerated after stop';
      if (Array.isArray(kids) && kids.length) state.process.orphans.push(...kids.map((k) => ({ pid: k, afterStopOf: pid })));
      const t = now();
      const booted = await drivers.restart();
      rec.bootMs = now() - t;
      state.epoch++;
      state.processSnapshots.push({ at: now(), event: 'restart', epoch: state.epoch, pid: booted.pid, bootMs: rec.bootMs });
      rec.after = await entities();
    } catch (e) { rec.error = String(e && e.message); }
    state.restarts.push(rec);
    log(`[soak] restart #${state.restarts.length}: boot ${rec.bootMs}ms ${rec.error ? 'ERROR ' + rec.error : ''}`);
  };

  try {
    const booted = await drivers.boot();
    state.processSnapshots.push({ at: now(), event: 'boot', epoch: 0, pid: booted.pid });
    await seed();
    let tick = 0;
    while (now() < endAt) {
      tick++;
      if (!drivers.isAlive()) { state.process.unexpectedExits++; state.stopReason = 'sidecar exited unexpectedly'; log('[soak] sidecar died'); break; }
      if (tick % opts.runEvery === 0) await doRun('conversation');
      if (tick % opts.toolEvery === 0) await doRun('tool');
      const s = await sample(tick);
      log(`[soak] t+${((now() - startedAt) / 60000).toFixed(1)}m tick ${tick} epoch ${state.epoch} rss=${s.rssBytes ? (s.rssBytes / 1048576).toFixed(0) + 'MB' : 'n/a'} health=${s.healthMs ? s.healthMs.median + '/' + s.healthMs.max + 'ms' : 'n/a'} swallowed=${s.swallowedTotal} runs=${state.runs.ok}/${state.runs.failed} fires=${state.routineFires}`);
      if (now() - lastRestartAt >= opts.restartEvery * 60_000 && now() + 30_000 < endAt) { await restartCycle(); lastRestartAt = now(); }
      if (hooks && hooks.shouldStop && hooks.shouldStop()) { state.stopReason = 'interrupted'; break; }
      const next = Math.min(endAt, s.at + opts.tickSeconds * 1000);
      const wait = next - now();
      if (wait > 0) await drivers.sleep(wait);
    }
    if (!state.stopReason) state.completed = true;
  } catch (e) {
    state.stopReason = 'harness error: ' + (e && e.stack || e);
    log(state.stopReason);
  } finally {
    try { const pid = drivers.pid(); await drivers.stop(); const kids = await drivers.childrenOf(pid); if (Array.isArray(kids) && kids.length) state.process.orphans.push(...kids.map((k) => ({ pid: k, afterStopOf: pid, final: true }))); } catch (e) { /* teardown */ }
  }
  const endedAt = now();
  return Object.assign({}, state, { startedAt, endedAt, plannedMinutes: opts.minutes, options: opts, maxSamples: opts.maxSamples });
}

/* ─────────────────────────────── REAL DRIVERS (ambient) ─────────────────────────────── */

/** In-process OpenRouter double: deterministic text; a TOOL_MARKER prompt is steered into one shell_exec. */
export function startMockProvider() {
  const calls = { total: 0 };
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: MOCK_MODEL, context_length: 16000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      calls.total++;
      let body = {}; try { body = JSON.parse(raw); } catch (e) { /* ignore */ }
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const users = msgs.filter((m) => m && m.role === 'user');
      const last = users.length ? String(users[users.length - 1].content || '') : '';
      // only tool results AFTER the last user turn count: the stream's replayed history carries earlier runs' tool turns
      let lastUserIdx = -1; msgs.forEach((m, i) => { if (m && m.role === 'user') lastUserIdx = i; });
      const toolResults = msgs.slice(lastUserIdx + 1).filter((m) => m && m.role === 'tool');
      const hasShell = (body.tools || []).some((t) => t && t.function && t.function.name === 'shell_exec');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
      const toolCall = (id, name, args) => {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + '\n\n');
      };
      const hasBrief = (body.tools || []).some((t) => t && t.function && t.function.name === 'brief_proceed');
      const wantsTool = last.indexOf(TOOL_MARKER) >= 0;
      // a TASK run walks the real task-brief gate first (brief_proceed), then one real shell_exec, then the final line
      if (wantsTool && toolResults.length === 0 && hasBrief) {
        toolCall('soak_brief_1', 'brief_proceed', { objective: 'run the soak command', deliverable: 'the command output', assumptions: ['use the host shell'] });
      } else if (wantsTool && toolResults.length === (hasBrief ? 1 : 0) && hasShell) {
        toolCall('soak_shell_1', 'shell_exec', { cmd: `node -e "process.stdout.write('${TOOL_STDOUT}')"` });
      } else {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: CONVERSATION_REPLY } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, calls, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1',
    close() { try { if (server.closeAllConnections) server.closeAllConnections(); server.close(); } catch (e) { /* teardown */ } },
  })));
}

function rssOf(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      const m = /"([\d.,\s]+)\s*K"\s*$/m.exec(out.trim());
      return m ? Number(m[1].replace(/[^\d]/g, '')) * 1024 : null;
    }
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    const kb = Number(out.trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch (e) { return null; }
}

function childrenOf(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      if (r.status !== 0) return null;
      return (r.stdout || '').split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    }
    const r = spawnSync('ps', ['-o', 'pid=', '--ppid', String(pid)], { encoding: 'utf8' });
    if (r.status !== 0 && !(r.stdout || '').trim()) return [];
    return (r.stdout || '').split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  } catch (e) { return null; }
}

function dirBytes(dir) {
  let total = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); try { if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } catch (x) { /* racing writes */ } } };
  try { walk(dir); } catch (e) { return null; }
  return total;
}

function gitHead(cwd) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(); } catch (e) { return null; }
}

export function makeRealDrivers({ fixture, logFile }) {
  const flushLog = () => { try { const o = fixture.output(); if (o) { fs.appendFileSync(logFile, o); fixture._output = ''; } } catch (e) { /* best effort */ } };
  return {
    stopMode: process.platform === 'win32' ? 'terminate (TerminateProcess, as the desktop shell stops it)' : 'SIGTERM (graceful shutdown path)',
    pid: () => (fixture.child ? fixture.child.pid : null),
    async boot() { await fixture.start(); return { pid: fixture.child.pid }; },
    async restart() { flushLog(); await fixture.start(); return { pid: fixture.child.pid }; },
    async stop() { flushLog(); await fixture.stop(); flushLog(); },
    isAlive() { const c = fixture.child; return !!(c && c.exitCode === null && !c.signalCode); },
    childrenOf: async (pid) => childrenOf(pid),
    json: (m, r, b) => fixture.json(m, r, b),
    async runConversation(text) {
      const response = await fixture.request('/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'sk-or-v1-soak-mock', provider: 'openrouter', model: MOCK_MODEL, agentId: SOAK_AGENT, streamId: SOAK_STREAM, isTask: text.indexOf(TOOL_MARKER) >= 0, placed: [], messages: [{ role: 'user', content: text }] }),
      });
      if (response.status !== 200) return { reason: 'http_' + response.status, detail: (await response.text()).slice(0, 200) };
      const reader = response.body.getReader(); const dec = new TextDecoder();
      let buf = '', reason = 'no_end', toolOk = false, detail = null;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.name === 'agent.run.end') reason = ev.payload && ev.payload.reason;
          if (ev.name === 'agent.tool_result' && ev.payload && ev.payload.callId === 'soak_shell_1') { toolOk = ev.payload.ok === true && ev.payload.isError !== true; if (!toolOk) detail = JSON.stringify(ev.payload).slice(0, 300); }
          if (ev.name === 'agent.error') detail = JSON.stringify(ev.payload).slice(0, 300);
        }
      }
      return { reason, toolOk, detail };
    },
    rss: async (pid) => rssOf(pid),
    workspaceBytes: () => dirBytes(fixture.workspace),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(m),
  };
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node scripts/qa/soak.mjs --minutes=N [--tick-seconds=15] [--run-every=2] [--tool-every=4] [--restart-every=10] [--max-samples=600] [--out=dir] [--aux]');
    return process.exit(0);
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.out ? path.resolve(opts.out) : path.join(repo, '.dogfood', 'soak', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(outDir, 'sidecar.log');
  const require = createRequire(import.meta.url);
  const { SidecarFixture } = require(path.join(repo, 'test', 'helpers', 'sidecar-fixture.js'));
  const mock = await startMockProvider();
  const env = {
    SKYNET_OPENROUTER_BASE: mock.baseUrl, STARNET_OPENROUTER_BASE: mock.baseUrl,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-soak-mock', STARNET_OPENROUTER_KEY: 'sk-or-v1-soak-mock',
    SKYNET_DEFAULT_MODEL: MOCK_MODEL, STARNET_DEFAULT_MODEL: MOCK_MODEL,
    SKYNET_CRON_ENABLED: '1', STARNET_CRON_ENABLED: '1',
    SKYNET_CRON_TICK_MS: String(DEFAULTS.cronTickMs), STARNET_CRON_TICK_MS: String(DEFAULTS.cronTickMs),
    SKYNET_CONSENT_TIMEOUT_MS: '2000',
  };
  if (!opts.aux) { env.SKYNET_AUX_BUDGET = '0'; env.STARNET_AUX_BUDGET = '0'; }   // aux passes off by default: deterministic mock answers feed them garbage
  const fixture = SidecarFixture.create({ prefix: 'starnet-soak-', timeoutMs: 20000, env });
  const drivers = makeRealDrivers({ fixture, logFile });
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; });
  console.log(`[soak] ${opts.minutes} min · tick ${opts.tickSeconds}s · restart every ${opts.restartEvery} min · out ${outDir}`);
  console.log(`[soak] hermetic: workspace=${fixture.workspace} profile=${fixture.profile} provider=mock@${mock.baseUrl}`);
  const result = await runSoak(drivers, opts, { shouldStop: () => interrupted });
  mock.close();
  const meta = { sidecarHead: gitHead(repo), platform: `${process.platform} ${os.release()} ${os.arch()}`, node: process.version, host: os.hostname(), stopMode: drivers.stopMode, provider: 'mock (in-process OpenRouter double)', mockCalls: mock.calls.total, workspace: fixture.workspace, auxPasses: opts.aux ? 'default' : 'disabled (SKYNET_AUX_BUDGET=0)' };
  const receipt = buildReceipt(Object.assign({}, result, { meta }));
  fs.writeFileSync(path.join(outDir, 'soak-receipt.json'), JSON.stringify(receipt, null, 2));
  fs.writeFileSync(path.join(outDir, 'SUMMARY.md'), renderSummary(receipt));
  await fixture.dispose();
  console.log(renderSummary(receipt));
  console.log(`[soak] receipt → ${path.join(outDir, 'soak-receipt.json')}\n[soak] VERDICT: ${receipt.verdict}${receipt.failedRules.length ? ' — ' + receipt.failedRules.join(', ') : ''}`);
  process.exit(receipt.verdict === 'PASS' ? 0 : 1);
}

const INVOKED_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (INVOKED_DIRECTLY) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
