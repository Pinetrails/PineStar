#!/usr/bin/env node
/* scripts/qa/installed-smoke.mjs — EL-4 / EL-8: the INSTALLED-EXE smoke.
 *
 * WHY THIS EXISTS: every other detector (Guardian / Beginner / Journeys / Cartographer) boots a
 * DEV sidecar and drives HEADLESS Chrome. None of them can ever see the WebView2-cache class of
 * bug (docs/MISTAKES.md "Desktop / installed-app traps"): the desktop UI is the frontend COMPILED
 * INTO THE EXE, served over `http://tauri.localhost`, and WebView2 caches it and never revalidates.
 * The ONLY proof of installed-UI behavior is a CDP-attach to the RUNNING packaged exe. This runner
 * is that proof, kept to a SMOKE (minutes, a handful of assertions) — not the full Atlas.
 *
 * HOW YOU RUN IT (operator, on Andrew's machine):
 *   1. Relaunch the installed StarNet with the WebView2 debug port open:
 *        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'
 *        & "$env:LOCALAPPDATA\..\StarNet.exe"     # or the Start-menu shortcut
 *      (9333 is the convention prior installed-exe CDP work used — desktop-bundles /
 *       voice-system memory. Override with STARNET_SMOKE_CDP_PORT.)
 *   2. `npm run qa:smoke:installed`  → attaches to that port, sweeps, writes the stamp.
 *
 * THE STAMP CONTRACT (read by the qa:ready gate — scripts/qa/ready.mjs, lane agent/ready-gate):
 *   qa/installed/last-smoke.json = { stampIso, appVersion, trunkHead, result, evidence, notes }
 *   result ∈ "GREEN" | "RED" | "BLOCKED". Do NOT change this shape without flagging the ready-gate lane.
 *
 * NO-FAKE-GREEN (Charter Part 5): can't attach, or can't PROVE the app version → result BLOCKED
 * + a P0 ledger finding (never a silent GREEN). A parity assertion that fails on the installed
 * build → result RED + a P1 finding. Only a real attach that proves the version AND passes every
 * assertion is GREEN. Findings go through scripts/qa/ledger.mjs (the ONE dedup/known authority).
 *
 * HOUSE PATTERN (matches scripts/qa/{ledger,cartographer}.mjs + the sidecar stores): the CORE is a
 * set of PURE, dependency-injected functions (attach / io / clock / gitHead are all injected), so the
 * classifier + stamp writer/validator test headlessly with fakes (test/qa-installed-smoke.test.js).
 * The INVOKED_DIRECTLY block is the one place ambient effects (real CDP, real fs, real ledger CLI,
 * real git) live — exactly like ledger.mjs's CLI block.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connectCDP, evalJS, collectDiagnostics } from '../lib/cdp.mjs';

/* ─────────────────────────────── PURE CORE ─────────────────────────────── */

export const RESULTS = { GREEN: 'GREEN', RED: 'RED', BLOCKED: 'BLOCKED' };
const RESULT_SET = new Set([RESULTS.GREEN, RESULTS.RED, RESULTS.BLOCKED]);
export const SMOKE_CREW = 'Installed Smoke';

function str(v) { return v == null ? '' : String(v); }

// The in-page probe. A self-contained async IIFE returning
// { appVersion, appSource, mode, bootSane, checks:[{name,ok,detail}], notes }.
// PRODUCTION-SAFE: unlike journeys' PARITY_PROBE it never touches window.__SKYNET_TEST__ (a dev/seed-
// only hook absent from the packaged build) — it is the smoke-scoped cousin of parityCheck, asserting
// only invariants a real production page exposes (the launch token, /api/version, /api/diagnostics,
// the world/canvas, and the Workstreams/Channels no-forever-running truth when the board is open).
//
// AUTH HEADER (ledger finding 4d9992d9) — the probe MUST send X-StarNet-Token, never an "Authorization: Bearer"
// header. The sidecar authenticates on X-StarNet-Token (a Bearer token is rejected as "forbidden token"), and its
// CORS Access-Control-Allow-Headers lists only Content-Type,X-StarNet-Token,X-Skynet-Token. On the packaged desktop
// exe the page origin is http://tauri.localhost while the sidecar is http://127.0.0.1:<port>, so every /api/* call is
// CROSS-ORIGIN: a stray Authorization header makes the OPTIONS preflight request a header the sidecar won't allow, the
// preflight is rejected, and fetch() dies with "Failed to fetch" BEFORE any response — appVersion reads blank and the
// smoke goes BLOCKED even though /api/version is serving the honest version. Same-origin dev/headless never preflights,
// which is why this only ever surfaced on the installed build. (Kept OUTSIDE the probe string so the auth-scheme name
// isn't part of SMOKE_PROBE — test/qa-installed-smoke.test.js A0 statically forbids those words appearing in it.)
export const SMOKE_PROBE = `(async () => {
  const out = { appVersion: '', appSource: '', harness: '', mode: '', bootSane: false, checks: [], notes: '' };
  const add = (name, ok, detail) => out.checks.push({ name: String(name), ok: !!ok, detail: String(detail == null ? '' : detail) });
  const tok = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) ? String(window.__STARNET_API_TOKEN__) : '';
  // X-StarNet-Token is the sidecar's auth header AND the only auth header its CORS allow-list accepts on the
  // cross-origin packaged build. See the long note above SMOKE_PROBE (finding 4d9992d9) before changing this.
  const authHeaders = tok ? { 'X-StarNet-Token': tok } : {};
  add('boot/api-token-present', !!tok, tok ? 'per-launch token injected into the page' : 'no window.__STARNET_API_TOKEN__ — is this the app page?');

  // ---- app version (token-gated GET /api/version): the whole point of the smoke — WHICH build is this? ----
  try {
    const r = await fetch('/api/version', { headers: authHeaders });
    if (r.ok) {
      const v = await r.json();
      out.appVersion = String((v && v.app) || '');
      out.appSource = String((v && v.appSource) || '');
      out.harness = String((v && v.harness) || '');
      add('version/app-nonblank', !!out.appVersion, 'app=' + (out.appVersion || '(blank)') + ' source=' + out.appSource + ' harness=' + out.harness);
    } else {
      add('version/app-nonblank', false, 'GET /api/version -> HTTP ' + r.status);
    }
  } catch (e) { add('version/app-nonblank', false, 'fetch /api/version threw: ' + (e && e.message)); }

  // ---- diagnostics mode (desktop vs browser): additional proof + surfaces the exe origin ----
  try {
    const r = await fetch('/api/diagnostics', { headers: authHeaders });
    if (r.ok) { const d = await r.json(); const rep = (d && d.report) ? d.report : d; out.mode = String((rep && rep.mode) || ''); }
  } catch (e) { /* diagnostics is a nice-to-have; version is the load-bearing proof */ }

  // ---- boot state sane: the world actually rendered ----
  const hasWorld = (typeof window !== 'undefined') && (!!window.__world || !!window.__SKYNET_WORLD || !!document.querySelector('canvas'));
  add('boot/world-present', hasWorld, hasWorld ? 'world model / canvas present' : 'no __world and no <canvas> — app did not render');
  const hasStage = !!document.querySelector('#stage, canvas, .station, #app, .stage');
  add('boot/stage-rendered', hasStage, hasStage ? 'stage/app root present in DOM' : 'no stage/app root element');

  // ---- production-safe parity subset (cousin of journeys parityCheck; no __SKYNET_TEST__ needed) ----
  const WS = (typeof Workstreams !== 'undefined') ? Workstreams : null;
  const CH = (typeof Channels !== 'undefined') ? Channels : null;
  if (WS && WS.list) {
    let list = null; try { list = WS.list(); } catch (e) { /* fall through to well-formed=false */ }
    const wellFormed = Array.isArray(list);
    add('store/workstreams-wellformed', wellFormed, wellFormed ? (list.length + ' workstream(s) in the store') : 'Workstreams.list() did not return an array');
    // no forever-running: if nothing is busy, no card may still show a RUNNING chip (same invariant as J5).
    const cardEls = Array.from(document.querySelectorAll('.kb-card'));
    const busyIds = (CH && CH.busyIds) ? CH.busyIds() : [];
    if (cardEls.length && Array.isArray(busyIds) && busyIds.length === 0) {
      const stuck = cardEls.filter(c => c.querySelector('.kb-state.running')).map(c => c.dataset.id).filter(Boolean);
      add('board/no-forever-running', stuck.length === 0, stuck.length ? 'RUNNING chip with nothing busy: ' + stuck.join(',') : 'no stuck RUNNING chip while idle');
    } else {
      add('board/no-forever-running', true, cardEls.length ? ((Array.isArray(busyIds) ? busyIds.length : 0) + ' run(s) legitimately in flight') : 'TASKS board closed — no cards to inspect');
    }
  } else {
    add('store/workstreams-wellformed', true, 'Workstreams not exposed on this page yet — smoke tolerates (pre-boot store)');
  }

  out.bootSane = hasWorld && hasStage;
  out.notes = 'checks=' + out.checks.length + ' mode=' + (out.mode || '?');
  return out;
})()`;

// Decide the smoke result from what we managed to observe. The order encodes no-fake-green:
// unreachable OR unversioned is BLOCKED (we proved nothing), a failed assertion is RED, all-pass GREEN.
export function classifyResult(obs) {
  obs = obs || {};
  if (!obs.attached) return RESULTS.BLOCKED;
  if (!str(obs.appVersion).trim()) return RESULTS.BLOCKED;   // can't prove the build → never green
  const checks = Array.isArray(obs.checks) ? obs.checks : [];
  const anyFail = checks.some(c => c && c.ok === false);
  return anyFail ? RESULTS.RED : RESULTS.GREEN;
}

// Coerce arbitrary input into the exact stamp shape ready-gate reads. An unknown/blank result clamps to
// BLOCKED (no-fake-green: a stamp that can't say GREEN honestly must not read GREEN).
export function normalizeStamp(input, opts) {
  input = input || {}; opts = opts || {};
  const clock = opts.clock || {};
  const isoNow = typeof clock.nowIso === 'function' ? clock.nowIso() : '';
  const result = RESULT_SET.has(input.result) ? input.result : RESULTS.BLOCKED;
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.map(str).map(s => s.trim()).filter(Boolean)
    : (input.evidence ? [str(input.evidence).trim()].filter(Boolean) : []);
  return {
    stampIso: str(input.stampIso || isoNow).trim(),
    appVersion: str(input.appVersion).trim(),
    trunkHead: str(input.trunkHead).trim(),
    result,
    evidence,
    notes: str(input.notes).trim()
  };
}

// Validate a stamp against the contract the ready-gate depends on. Returns { ok, errors[] }.
export function validateStamp(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['stamp is not an object'] };
  if (typeof obj.stampIso !== 'string' || !obj.stampIso.trim()) errors.push('stampIso missing/blank');
  else if (isNaN(Date.parse(obj.stampIso))) errors.push('stampIso is not a parseable ISO timestamp');
  if (!RESULT_SET.has(obj.result)) errors.push('result must be one of GREEN|RED|BLOCKED');
  if (typeof obj.appVersion !== 'string') errors.push('appVersion must be a string');
  if (typeof obj.trunkHead !== 'string') errors.push('trunkHead must be a string');
  if (!Array.isArray(obj.evidence)) errors.push('evidence must be an array');
  if (typeof obj.notes !== 'string') errors.push('notes must be a string');
  // A GREEN stamp that can't name the build or carry an artifact is a lie — reject it as invalid.
  if (obj.result === RESULTS.GREEN && (typeof obj.appVersion !== 'string' || !obj.appVersion.trim()))
    errors.push('GREEN requires a non-blank appVersion (no-fake-green)');
  if (obj.result === RESULTS.GREEN && (!Array.isArray(obj.evidence) || obj.evidence.length === 0))
    errors.push('GREEN requires at least one evidence path (no-fake-green)');
  return { ok: errors.length === 0, errors };
}

// Build the ledger finding for a non-GREEN result. Pure so the test can assert its shape/severity.
export function buildFinding(result, notes, failedChecks, evidence, stampPath) {
  const fc = Array.isArray(failedChecks) ? failedChecks : [];
  const ev = (Array.isArray(evidence) && evidence.length) ? evidence : [stampPath || 'qa/installed/last-smoke.json'];
  if (result === RESULTS.BLOCKED) {
    return {
      crew: SMOKE_CREW, severity: 'P0', checkId: 'installed-smoke',
      subject: 'installed-exe-unreachable-or-unversioned',
      title: ('Installed-exe smoke BLOCKED: ' + (notes || 'could not attach / could not prove app version')).slice(0, 160),
      detail: 'The installed-exe smoke could not prove installed-UI behavior: ' + notes +
        '. A detector that cannot run (or cannot prove the build) is a P0 (no-fake-green law) — treat as red until it runs clean.',
      evidence: ev, status: 'open'
    };
  }
  // RED — a real parity divergence on the installed build.
  return {
    crew: SMOKE_CREW, severity: 'P1', checkId: 'installed-smoke',
    subject: 'installed-exe-parity:' + fc.map(c => c.name).sort().join('|'),
    title: ('Installed-exe smoke RED: ' + fc.length + ' parity assertion(s) failed on the installed build').slice(0, 160),
    detail: notes + (fc.length ? ('\n' + fc.map(c => '- ' + c.name + ': ' + c.detail).join('\n')) : ''),
    evidence: ev, status: 'open'
  };
}

/* makeSmoke — the orchestrator, fully dependency-injected.
 *   attach()  -> Promise<session>  (rejects/throws when the exe is unreachable). session = {
 *                  probe() -> Promise<probeResult>,   // evaluates SMOKE_PROBE in the page
 *                  diagnostics?() -> { consoleMsgs, exceptions },
 *                  close?() -> void|Promise }
 *   io.writeEvidence(name, text) -> repo-relative path (or '')
 *   io.writeStamp(stampObj)      -> repo-relative path (defaults to qa/installed/last-smoke.json)
 *   io.fileFinding(finding)      -> bool (true = handled by the ledger, incl. dedup/known)
 *   io.log(...args)              -> void
 *   clock.nowIso() -> ISO string ; gitHead -> trunk HEAD sha string
 */
export function makeSmoke(opts) {
  opts = opts || {};
  const attach = typeof opts.attach === 'function' ? opts.attach : async () => { throw new Error('no attach injected'); };
  const clock = opts.clock || { nowIso: () => new Date(0).toISOString() };
  const gitHead = str(opts.gitHead);
  const io = opts.io || {};
  const log = typeof io.log === 'function' ? io.log : () => {};
  const writeEvidence = typeof io.writeEvidence === 'function' ? io.writeEvidence : () => '';
  const writeStamp = typeof io.writeStamp === 'function' ? io.writeStamp : () => '';
  const fileFinding = typeof io.fileFinding === 'function' ? io.fileFinding : () => true;

  async function run() {
    const evidence = [];
    let attached = false, session = null, probe = null, blockReason = '';

    try { session = await attach(); attached = true; }
    catch (e) { blockReason = 'CDP attach failed: ' + (e && e.message ? e.message : str(e)); log('BLOCKED — ' + blockReason); }

    if (attached) {
      try { probe = await session.probe(); }
      catch (e) { blockReason = 'in-page probe threw: ' + (e && e.message ? e.message : str(e)); probe = null; log('BLOCKED — ' + blockReason); }
      let diag = null; try { diag = session.diagnostics ? session.diagnostics() : null; } catch (e) { /* diag optional */ }
      const p = writeEvidence('probe.json', JSON.stringify({ probe, diagnostics: diag }, null, 2));
      if (p) evidence.push(p);
      try { if (session.close) await session.close(); } catch (e) { /* best-effort */ }
    } else {
      const p = writeEvidence('smoke-blocked.txt', blockReason + '\n');
      if (p) evidence.push(p);
    }

    const appVersion = probe ? str(probe.appVersion) : '';
    const checks = probe ? (Array.isArray(probe.checks) ? probe.checks : []) : [];
    const result = (!attached || !probe)
      ? RESULTS.BLOCKED
      : classifyResult({ attached, appVersion, checks });

    const failedChecks = checks.filter(c => c && c.ok === false);
    const notes = (() => {
      if (!attached) return blockReason;
      if (!probe) return blockReason || 'probe returned nothing';
      const parts = ['appVersion=' + (appVersion || '(blank)') + ' mode=' + (probe.mode || '?') +
        ' checks ' + (checks.length - failedChecks.length) + '/' + checks.length + ' pass'];
      if (failedChecks.length) parts.push('FAILED: ' + failedChecks.map(c => c.name).join(', '));
      return parts.join(' · ');
    })().slice(0, 500);

    const stamp = normalizeStamp({ stampIso: clock.nowIso(), appVersion, trunkHead: gitHead, result, evidence, notes }, { clock });
    const stampPath = writeStamp(stamp) || 'qa/installed/last-smoke.json';
    log('result=' + result + ' app=' + (appVersion || '(unproven)') + ' → ' + stampPath);

    if (result !== RESULTS.GREEN) {
      fileFinding(buildFinding(result, notes, failedChecks, evidence, stampPath));
    }
    return { result, stamp, stampPath, evidence, failedChecks };
  }

  return { run };
}

/* ─────────────────────────────── CLI (ambient effects) ─────────────────────────────── */

const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch (_) { return false; }
})();

if (INVOKED_DIRECTLY) (async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(__dirname, '..', '..');          // scripts/qa/ -> repo root
  const LEDGER_CLI = path.join(REPO, 'scripts', 'qa', 'ledger.mjs');
  const OUT_DIR = path.join(REPO, 'qa', 'installed');
  const STAMP_FILE = path.join(OUT_DIR, 'last-smoke.json');
  const PORT = parseInt(process.env.STARNET_SMOKE_CDP_PORT || '9333', 10);

  const stampIsoNow = new Date().toISOString();
  const RUN_DIR = path.join(OUT_DIR, 'smoke-' + stampIsoNow.replace(/[:.]/g, '-'));
  const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/');

  const gitHead = (() => {
    try { const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true }); return String(r.stdout || '').trim(); }
    catch (_) { return ''; }
  })();

  const io = {
    log: (...a) => console.log('[qa:smoke:installed]', ...a),
    writeEvidence(name, text) {
      try { fs.mkdirSync(RUN_DIR, { recursive: true }); fs.writeFileSync(path.join(RUN_DIR, name), text, 'utf8'); return rel(path.join(RUN_DIR, name)); }
      catch (e) { console.error('[qa:smoke:installed] evidence write failed:', e && e.message); return ''; }
    },
    writeStamp(obj) {
      try { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(STAMP_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8'); return rel(STAMP_FILE); }
      catch (e) { console.error('[qa:smoke:installed] stamp write failed:', e && e.message); return ''; }
    },
    fileFinding(finding) {
      const r = spawnSync(process.execPath, [LEDGER_CLI, '--add', '--json', JSON.stringify(finding)], { cwd: REPO, encoding: 'utf8', windowsHide: true });
      const out = String(r.stdout || '').trim(); const err = String(r.stderr || '').trim();
      if (out) io.log('ledger:', out);
      if (err) console.error('[qa:smoke:installed] ledger:', err);
      return (r.status === 0 || r.status === 2);   // exit 2 = refused/known — a HANDLED outcome, not our error
    }
  };

  // Real attach: connect to the ALREADY-RUNNING installed exe's WebView2 debug port (reuses cdp.mjs).
  const attach = async () => {
    const cdp = await connectCDP(PORT);                       // retries ~10s, throws if the port never answers
    try { await cdp.send('Runtime.enable', {}); } catch (_) {}
    const diag = collectDiagnostics(cdp);
    return {
      async probe() { return await evalJS(cdp, SMOKE_PROBE); },
      diagnostics() { return diag; },
      async close() { try { cdp.ws.close(); } catch (_) {} }
    };
  };

  io.log('attaching to installed exe CDP on 127.0.0.1:' + PORT + ' (relaunch it with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=' + PORT + ')');
  const smoke = makeSmoke({ attach, clock: { nowIso: () => stampIsoNow }, gitHead, io });
  const { result } = await smoke.run();
  // Exit codes mirror the Cartographer: 0 clean (GREEN) · 1 red · 2 blocked.
  process.exit(result === RESULTS.GREEN ? 0 : (result === RESULTS.RED ? 1 : 2));
})();
