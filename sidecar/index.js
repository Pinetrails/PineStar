/* sidecar/index.js — the Node host. The ONLY module with ambient I/O (http / fs / fetch /
   process.env). It (1) serves the static frontend/ and (2) exposes POST /api/run, which
   assembles the EXISTING proven seams — registry + web/fs/notebook tools + capability gate +
   cost engine + the real OpenRouter provider — runs the unchanged agentic loop, and streams the
   frozen `agent.*` U.bus events to the browser as newline-delimited JSON (one validated event
   per line). One command: `node sidecar/index.js`. Node 18+ only — no dependencies. */
'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const { runAgentLoop } = require('./loop.js');
const { makeCostEngine } = require('./cost.js');
const { makeLedger } = require('./ledger.js');
const { makeBudget } = require('./budget.js');
const { makeConcurrencyGate } = require('./concurrency.js');
const { killAll } = require('./halt.js');
const { makeRegistry } = require('./tools/registry.js');
const { makeWebTools } = require('./tools/builtin/web.js');
const { makeBrowserTools } = require('./tools/builtin/browser.js');
const { makeComputerTools } = require('./tools/builtin/computer.js');
const { makeFsTools } = require('./tools/builtin/fs.js');
const { makeNotebookTools } = require('./tools/builtin/notebook.js');
const { makeRecallTool } = require('./tools/builtin/recall.js');
const { makeSkillTools } = require('./tools/builtin/skills.js');    // H4: the agent's reusable skill library tools
const Todo = require('./tools/builtin/todo.js');
const { makeImageTools } = require('./tools/builtin/image.js');           // STUDIO: image_generate / image_analyze (OpenRouter multimodal)
const { makeSpotifyTools } = require('./tools/builtin/spotify.js');       // JUKEBOX: control/query the user's Spotify
const { makeSpotifyStore } = require('./spotify/store.js');               // Spotify OAuth (PKCE) token store + auto-refresh
const spotifyPkce = require('./spotify/pkce.js');                          // pure PKCE helpers (verifier/challenge/urls)
const { makeSaveStore } = require('./savestore.js');
const { mergeNotes } = require('./notebookrestore.js');
const { makeRunStore } = require('./runstore.js');
const { makeTranscriptStore } = require('./transcriptstore.js');
const { makeSkillStore } = require('./skillstore.js');             // H4: per-agent owned skill library (singleton)
const { makeCredPool } = require('./credpool.js');
const { resolveTools } = require('./capability/resolve.js');
const { makeCapCtx } = require('./capability/capGate.js');
const { composeOffice } = require('./capability/office.js');   // THE MOAT: interactive office = compute freebie + placed caps
const { summarizeCapabilities } = require('./capability/capsummary.js');   // truthful "what you can/can't do" so the agent stops over-promising
const { starnetManual } = require('./manual.js');   // truthful "how StarNet works" so the agent can guide a stuck Commander (interactive only)
const { makeOpenRouterProvider } = require('./providers/openrouter.js');
const { selectProvider } = require('./providers/factory.js');
const { DEFAULT_MODEL: CODEX_DEFAULT_MODEL } = require('./providers/codex.js');
const codexAuth = require('./providers/codex-auth.js');
const { effectiveModel: resolveEffectiveModel, effectiveUsd } = require('./spend.js');
const { makeEmitter } = require('../shared/emitter.js');
const { redact, renderRecall, injectRecall, rank, makeContext, compactionMemoryBlock, compactionSummaryPrompt } = require('./context.js');
const { reflect, worthReflecting, recordFromProposal, feedbackFor } = require('./reflect.js');
const { runtimeIdentityBlock } = require('./runtimeinfo.js');
const memcore = require('./memcore.js');
const { makeConsentBroker } = require('./permissions.js');
const { makeTelegramAdapter } = require('./channels/telegram.js');
const { makeChannelStore } = require('./channels/store.js');
const { makeChannelHub } = require('./channels/hub.js');
const { makeChannelRegistry, wireChannel } = require('./channels/registry.js');   // H6.2: channel descriptors + generic wire-up
const { makeSseHub } = require('./channels/sse.js');
const { makeRouter } = require('./routing/router.js');
const { makeConnectorManager } = require('./mcp/manager.js');
const { makeHttpTransport } = require('./mcp/transport.http.js');
const { makeStdioTransport } = require('./mcp/transport.stdio.js');
const cron = require('./cron.js');                         // pure schedule math (parse/nextFire/planTick)
const cronStore = require('./cron-store.js');              // pure CronJob lifecycle reducer
const { makeCronDriver } = require('./cron-driver.js');    // the autonomous tick driver (ambient deps injected here)
const { writeFileDurable } = require('./durable-write.js'); // G4.2: crash-safe atomic+durable single-file replace (fsync-before-rename)
const { makeKeyedMutex, readJsonResilient, writeJsonResilient } = require('./durable-store.js'); // P1/P2: per-key serialized + last-known-good-recoverable single-file JSON stores
const { makeMemoryStore } = require('./memory-store.js'); // durable notebook:<agent> and todo:<agent> sibling stores
const { tailLines, loadBounded, rotateIfLarge } = require('./logbound.js'); // P3: bounded boot-load + size rotation for the append-only JSONL logs
const { makeCronLock } = require('./cron-lock.js');         // G4.3: cross-process exactly-once advisory lock (O_EXCL+pid:nonce+stale-break)
const { withDossier } = require('./dossierinject.js');     // Phase C: fold the Commander dossier into server-composed (cron) personas
const skillsCatalog = require('./skills/catalog.js');      // bundled capability-gated recipe library (parse/load/gate/compose)
const { makeSkillPrefs } = require('./skills/prefs.js');   // persisted enable/disable choices for the recipe library
const { makeCheckpointStore } = require('./checkpoint-store.js');   // the shadow-git rollback net (ambient edge)
const { makeShellTool } = require('./tools/builtin/shell.js');      // the workbench capability: shell.exec
const { makeShellBg } = require('./shellbg.js');                    // H2.2: singleton background-process manager
const { makeEnvironmentManager } = require('./environment.js');     // Hermes-style execution backend boundary
const { foldInsights } = require('./insights.js');                  // H3.3: usage insights folded from run history
const { makeVerifyTool } = require('./tools/builtin/verify.js');    // the workbench verify.run check-runner
const { makeOrchestrationTools } = require('./tools/builtin/orchestration.js');   // Stage 2: team.dispatch (lead->worker delegation)
const { makeRoutineTools } = require('./tools/builtin/routines.js'); // ROUTINES: agent-created StarNet cron jobs
const { execFile, spawn: childSpawn } = require('node:child_process');   // shadow-git runner + shell subprocess — ambient, here only
const { makeSubagentManager } = require('./subagents.js');          // durable background worker registry
const Classify = require('../frontend/app/classify.js');   // the SAME task-vs-talk classifier the browser uses

// ---- Skynet→StarNet env back-compat ------------------------------------------------------------
// The project was renamed Skynet → StarNet; its env vars moved SKYNET_* → STARNET_*. ENV() reads the
// NEW name first and falls back to the LEGACY one, so existing launch configs / shells / the desktop
// shell keep working unchanged. Membership test (not truthiness) so a deliberately-empty STARNET_X
// still wins over a set SKYNET_X — preserving each downstream var's exact empty-vs-unset semantics.
function ENV(suffix) { const k = 'STARNET_' + suffix; return (k in process.env) ? process.env[k] : process.env['SKYNET_' + suffix]; }

const PORT = Number(ENV('PORT') || process.env.PORT) || 8787;
const API_TOKEN = String(ENV('API_TOKEN') || crypto.randomBytes(32).toString('hex'));
// DEV fast-path (the `npm run dev:seed` launcher sets this): when on, the served index.html carries a small
// boot payload (window.__STARNET_DEV__ = {model, prov}) so a fresh browser origin auto-resumes the server-
// seeded save with no connect screen / awakening. Holds NO secret — the API key stays in runtimeKey. Never
// set in a packaged build, so this is inert in shipping. Loopback-only like the rest of the server.
const DEV_MODE = /^(1|true|yes|on)$/i.test(String(ENV('DEV') || '').trim());
// API auth/guard DECISIONS live in the unit-tested ./apiauth.js (full threat model documented there);
// index.js keeps only the thin res-writing wrappers below. Hardened posture: EVERY /api/* route now requires
// the per-launch token (GET data routes included) except a small header-less set — a CSRF/exfil fence that
// does NOT rely on Origin being present, since the token is a custom header a foreign site can neither set
// (CORS preflight) nor read (opaque cross-origin responses).
const apiauth = require('./apiauth.js');
const { isAllowedApiOrigin, isAllowedHost, requiresApiToken } = apiauth;
function applyApiCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin && isAllowedApiOrigin(origin, PORT)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-StarNet-Token,X-Skynet-Token');   // accept the legacy header name too (old Tauri shell)
  res.setHeader('Access-Control-Max-Age', '600');
}
function rejectApi(req, res) {
  if (!isAllowedHost(req.headers.host)) { res.writeHead(403); res.end('forbidden host'); return true; }
  if (!isAllowedApiOrigin(String(req.headers.origin || ''), PORT)) { res.writeHead(403); res.end('forbidden origin'); return true; }
  return false;
}
function rejectBadApiToken(req, res) {
  if (!requiresApiToken(req)) return false;
  if (apiauth.apiTokenOk(req, API_TOKEN)) return false;
  res.writeHead(403); res.end('forbidden token'); return true;
}
// Desktop build: the live BYOK key — seeded from the OS keychain via env at spawn, and updated
// in place via the token-guarded POST /api/key (the parent shell pushes changes; no restart).
let runtimeKey = String(ENV('OPENROUTER_KEY') || '').trim();
// OpenRouter base URL override (env SKYNET_OPENROUTER_BASE). Default undefined -> the provider's own
// https://openrouter.ai/api/v1. Lets a user point at an OR-compatible proxy, and lets the boot+run E2E aim
// the provider at a local mock so the real streaming path is tested end-to-end without a live key.
const OPENROUTER_BASE = String(ENV('OPENROUTER_BASE') || '').trim() || undefined;
const FRONTEND = path.resolve(__dirname, '..', 'frontend');
// the agent workspaces + their protected siblings (notebook/ledger/permissions/channels). SKYNET_WORKSPACES
// wins (the desktop shell + isolated tests set it); otherwise resolve a PER-USER, writable OS app-data dir.
// CRITICAL for a packaged install: NEVER default under __dirname — a shipped app lives in read-only Program
// Files, so writing beside the .js source EACCES-fails on first boot and silently kills ALL persistence
// (ledger/memory/secrets/cron) and degrades every permission grant to a deny. App-data is always writable.
function defaultWorkspaces() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA            // Windows: %LOCALAPPDATA% (machine-local app data)
    || process.env.XDG_DATA_HOME                                          // Linux XDG
    || path.join(os.homedir() || '.', '.local', 'share');                 // POSIX fallback
  // Skynet→StarNet rename back-compat: prefer the NEW dir; if it doesn't exist yet but the OLD one does, keep
  // using the old one IN PLACE (no move) so existing data is never lost and any old-code process that still
  // looks for \Skynet\ keeps sharing the same data (no split-brain). Fresh installs land under \StarNet\.
  const neu = path.join(base, 'StarNet', 'workspaces');
  const old = path.join(base, 'Skynet', 'workspaces');   // legacy pre-rename location — read in place, never renamed
  try { if (!fs.existsSync(neu) && fs.existsSync(old)) return old; } catch (_) {}
  return neu;
}
const WORKSPACES = ENV('WORKSPACES') ? path.resolve(ENV('WORKSPACES')) : defaultWorkspaces();
// maxIters: per-run tool-turn ceiling. Raised 16→40 (P0.3) so real multi-step work isn't truncated early;
// env-overridable. Parsed inline (num() is defined below). The loop adds one grace turn on top to finish cleanly.
const CAPS = { maxIters: (Number(ENV('MAX_ITERS')) > 0 ? Math.floor(Number(ENV('MAX_ITERS'))) : 40), maxCostUsd: 1.00, maxRepeat: 3, toolTimeoutMs: 30000, maxToolBytes: 120000 };
// Spend governance ("Balanced" posture): per-RUN hard ceiling (the loop's maxCostUsd) + SOFT cross-run pools
// (per-day, global) governed over the persisted ledger, each with one-click resume. Env-overridable so a deploy
// can retune without a code change. perRun ($3) replaces the conservative $1 dev default once a budget is live.
// num() passes a parsed value through (including 0 -> UNGOVERNED via budget.js capOf, e.g. SKYNET_BUDGET_PER_DAY=0
// disables the day pool); only an empty/missing/negative/non-numeric value falls back to the default.
const num = (v, d) => { if (v == null || String(v).trim() === '') return d; const n = Number(v); return (typeof n === 'number' && !isNaN(n) && n >= 0) ? n : d; };
const BUDGET_CAPS = {
  perRun: num(ENV('BUDGET_PER_RUN'), 3),
  perAgent: num(ENV('BUDGET_PER_AGENT'), 5),   // multi-agent fairness rail: one agent's cumulative spend (0 = ungoverned)
  perDay: num(ENV('BUDGET_PER_DAY'), 40),
  global: num(ENV('BUDGET_GLOBAL'), 100)
};
// Multi-agent fan-out ceiling: the max number of DISTINCT agents that may have paid runs in flight at once
// (hero + summoned crew). The day/global pools already cap aggregate $; this caps how many loops light up in
// parallel so a summoned crew can't accidentally burn N streams at once. 0 = unlimited. See concurrency.js.
const MAX_CONCURRENT_AGENTS = num(ENV('MAX_CONCURRENT_AGENTS'), 3);
// Stage 2: per-WORKER USD ceiling for a delegated sub-run, so the lead fanning out to a crew can't let one
// runaway worker blow the lead's own per-run cap. 0 = ungoverned (the cross-run pools still apply).
const ORCH_PER_WORKER = num(ENV('BUDGET_PER_WORKER'), 1);
const CONSENT_TIMEOUT_MS = 120000;   // a live permission.prompt left unanswered this long auto-denies (never hangs a run)
// ---- cron / scheduled routines (autonomous, OPT-IN). The whole subsystem is INERT unless SKYNET_CRON_ENABLED
// is set: no timer is armed, no run is fired, and the browser path is byte-identical. A fire uses the same
// provider seam as /api/run: OpenRouter needs the live BYOK key (runtimeKey), while Codex uses the protected
// ChatGPT OAuth token. A job with no model falls back to the selected agent model or SKYNET_DEFAULT_MODEL;
// absent model/credentials, a due job no-capability-skips rather than firing. Cadence + the self-healing lease
// ceiling are env-tunable. The fire's consent surface is 'autonomous' (default-deny ungranted mutation).
const CRON_ENABLED = /^(1|true|yes|on)$/i.test(String(ENV('CRON_ENABLED') || '').trim());
const CRON_TICK_MS = num(ENV('CRON_TICK_MS'), 60000);
// Host IANA timezone, captured ONCE at boot as a boot-frozen constant (G4.1). A cron schedule with no
// explicit tz fires on this LOCAL wall-clock (so "0 9 * * *" means 09:00 here and shifts across DST),
// while the pure cron-math (sidecar/cron.js) stays determinism-clean by receiving this as an INJECTED
// defaultTz rather than reading the ambient clock itself. Override with SKYNET_CRON_TZ (e.g. for a
// headless server that should run routines in a specific zone); an invalid value falls back to UTC so a
// typo never wedges the scheduler. A schedule's OWN tz always wins over this default.
const CRON_HOST_TZ = (function () {
  const override = String(ENV('CRON_TZ') || '').trim();
  const candidate = override || (function () {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
  })();
  return cron.isValidTz(candidate) ? (candidate || 'UTC') : 'UTC';
})();
const CRON_MAX_RUN_MS = num(ENV('CRON_MAX_RUN_MS'), CAPS.maxIters * CAPS.toolTimeoutMs);   // ≈8-min worst-case run bound
// G4.4 global concurrency cap: at most this many cron runs may be IN-FLIGHT across all routines at once.
// A tick whose due set would exceed it DEFERS the extra jobs to the next tick (without advancing their
// nextRunAt, so they stay due) — a burst of simultaneously-due routines drains `maxParallel` at a time
// rather than flooding the run host / spend all at once. Threaded as an INJECTED int so the cron driver
// stays determinism-clean (it never reads process.env itself). Default 4.
const CRON_MAX_PARALLEL = num(ENV('CRON_MAX_PARALLEL'), 4);
// Stage 2: the lead's team.dispatch awaits full worker agent-loops (minutes), so it CANNOT inherit the 30s
// fast-tool timeout (CAPS.toolTimeoutMs) or it always times out before a real worker returns. Give it the same
// ≈8-min single-run worst-case bound; env-tunable. Per-worker spend is still capped by ORCH_PER_WORKER.
const ORCH_DISPATCH_TIMEOUT_MS = num(ENV('DISPATCH_TIMEOUT_MS'), CRON_MAX_RUN_MS);
const CRON_DEFAULT_MODEL = String(ENV('DEFAULT_MODEL') || '').trim();
const CRON_PERSONA = 'You are an autonomous STARNET station agent running a SCHEDULED routine — no human is watching. '
  + 'Carry out the task with your REAL tools (web search/read, files, memory); ground every factual claim in what the '
  + 'tools actually return and cite sources; save any durable deliverable to your workspace with fs_write. Be concise. '
  + 'If there is genuinely nothing new or noteworthy to report this run, reply with EXACTLY "[SILENT]" and nothing else.';
const CRON_ROUTINE_NOTE = '\n\n[ROUTINE] This is an unattended scheduled routine. Use your normal agent identity, '
  + 'carry out the saved prompt without waiting for the Commander, and keep the result concise. If there is genuinely '
  + 'nothing new or noteworthy to report this run, reply with EXACTLY "[SILENT]" and nothing else.';
// The agent's toolset is NOT a host-side constant — it is projected from the objects placed in the
// agent's room (CAP_REGISTRY: computer/dish/cabinet/notebook). See handleRun's station + resolveTools.

// last-resort nets so a single run's failure never takes the whole host (and all other runs) down.
process.on('unhandledRejection', e => console.error('unhandledRejection:', (e && e.stack) || e));
process.on('uncaughtException', e => console.error('uncaughtException:', (e && e.stack) || e));

try { fs.mkdirSync(WORKSPACES, { recursive: true }); } catch (e) {}

/* ---- P2 crash-safe persistence helpers for the single-file sibling stores (roster, dossier, channel
   secrets, codex tokens, connectors, allowlist, notebook). Each of these was a plain
   writeFileSync->rename (atomic but NOT power-loss durable) with a catch-and-return-empty loader (so a
   torn/zero-length file booted the app AMNESIAC and the next write made it permanent). These route every
   write through writeFileDurable (fsync-before-rename) + a .bak last-known-good snapshot, and every load
   through readJsonResilient (recover the .bak on a torn/corrupt main; quarantine+log loudly when there is
   no usable .bak — NEVER silently empty). A genuinely-absent file (new install/agent) is the only thing
   that loads empty. These stores hold a FULL in-memory state snapshot on each write (not a disk-snapshot
   read-modify-write), so they have no lost-update hazard and need no per-key lock — durability + recovery
   is the fix they needed. (notebook + channels DO read-modify-write a per-key disk snapshot, so those get
   the per-key serialized update() / sync-RMW path instead.) */
let _quarantineSeq = 0;
function quarantineCorrupt(file, tag) {
  try {
    const dest = file + '.corrupt-' + process.pid + '-' + (++_quarantineSeq);
    fs.renameSync(file, dest);
    console.error('[' + (tag || 'store') + '] CORRUPT store ' + file + ' could not be recovered from .bak — quarantined to ' + dest + ' and loading empty (data NOT silently wiped).');
  } catch (e) { console.error('[' + (tag || 'store') + '] CORRUPT store ' + file + ' could not be recovered and could not be quarantined:', (e && e.message) || e); }
}
// load a single-file JSON store with last-known-good recovery; returns undefined for absent/corrupt.
function loadResilient(file, tag) {
  const r = readJsonResilient({ fs: fs }, file);
  if (r.status === 'recovered') console.warn('[' + (tag || 'store') + '] recovered ' + file + ' from .bak last-known-good after a torn/corrupt main.');
  else if (r.status === 'corrupt') quarantineCorrupt(file, tag);
  return (r.status === 'ok' || r.status === 'recovered') ? r.value : undefined;
}
// durable single-file write: fsync-before-rename + snapshot the prior good value to <file>.bak.
function saveResilient(file, value) { writeJsonResilient({ fs: fs, path: path, writeDurable: writeFileDurable }, file, value); }

/* ---- P3 bounded append-only JSONL logs ----
   The ledger / run-history / transcript are append-only and were read into RAM IN FULL at boot
   (fs.readFileSync(FILE).split('\n')) and never rotated, so months of 24/7 use grow them without bound
   until a single boot-time readFileSync crash-loops startup. readBoundedJsonl loads only the last
   LOG_MAX_BYTES of (archive + live) at boot (newest lines), and rotateJsonl rolls the live file to
   <file>.1 once it passes the cap — so BOOT memory/latency AND on-disk size stay bounded no matter how
   old the history is. 16 MB of JSONL is far more than any display/query reads (run lists cap at ≤500,
   insights bucket the last 24 h), so this is behavior-neutral in practice; the one residual — a global
   ledger total can under-count only past ~2×LOG_MAX_BYTES of lifetime spend, which is far beyond any
   default cap — is documented in docs/PERSISTENCE_HARDENING.md. Env-overridable. */
const LOG_MAX_BYTES = Math.max(1 << 20, num(ENV('LOG_MAX_BYTES'), 16 * 1024 * 1024));
function readBoundedJsonl(file) {
  return loadBounded({ fs: fs }, file, LOG_MAX_BYTES)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
function rotateJsonl(file) { try { rotateIfLarge({ fs: fs }, file, LOG_MAX_BYTES); } catch (_) {} }

/* ---- spend ledger + budget (Wave 1 cost spine) ----
   The ledger is an append-only JSONL of finished runs (sibling of the fs jail, so the agent's own fs.* tools can
   neither read nor rewrite the spend record). Each append is fsync'd to disk so the day/global pools survive even
   a hard power loss (not just a clean crash) — otherwise an un-flushed tail would silently hand a capped Commander
   unintended headroom after restart. The budget governs the soft cross-run pools; the host injects the wall clock
   at this composition boundary. */
const LEDGER_FILE = path.join(WORKSPACES, 'ledger.jsonl');
const ledgerIo = {
  readAll() {
    try { return readBoundedJsonl(LEDGER_FILE); } catch (e) { return []; }   // P3: bounded boot-load
  },
  append(entry) {
    // open(O_APPEND) -> write -> fsync -> close, all fail-open: a persistence error must never crash the run
    // (the in-memory ledger mirror still answers for this process's lifetime).
    let fd = null;
    try {
      fd = fs.openSync(LEDGER_FILE, 'a');
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(fd);
    } catch (e) { console.warn('[ledger] append failed:', (e && e.message) || e); }
    finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
    rotateJsonl(LEDGER_FILE);   // P3: roll to <file>.1 once the live segment passes the cap (bounds disk)
  }
};
const ledger = makeLedger({ io: ledgerIo, clock: { now: () => Date.now() } });
const budget = makeBudget({ caps: { agent: BUDGET_CAPS.perAgent, day: BUDGET_CAPS.perDay, global: BUDGET_CAPS.global }, ledger, clock: { now: () => Date.now() } });
// admission gate: bounds how many distinct agents run paid loops concurrently (multi-agent fan-out guard).
const concurrencyGate = makeConcurrencyGate({ max: MAX_CONCURRENT_AGENTS });

// run-history log (M-save P4): the OUTCOME of each finished run ({runId, agentId, reason, turns, tokens, usd,
// title, ts}), append-only + fsync'd like the ledger and a sibling of the fs jail (the agent can't rewrite its
// own history). The ledger answers "what did it cost"; this answers "what happened" — the durable substrate a
// future autopsy/replay view reads. It learns nothing; the cortex does that from the live message log.
const RUNS_FILE = path.join(WORKSPACES, 'runs.jsonl');
const runsIo = {
  readAll() {
    try { return readBoundedJsonl(RUNS_FILE); } catch (e) { return []; }   // P3: bounded boot-load
  },
  append(entry) {
    let fd = null;
    try { fd = fs.openSync(RUNS_FILE, 'a'); fs.writeSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd); }
    catch (e) { console.warn('[runs] append failed:', (e && e.message) || e); }
    finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
    rotateJsonl(RUNS_FILE);   // P3: roll to <file>.1 once the live segment passes the cap (bounds disk)
  }
};
const runStore = makeRunStore({ io: runsIo, clock: { now: () => Date.now() } });

// durable per-workstream CONVERSATION transcript (P0.1): append-only + fsync'd like the runs log, a SIBLING of
// the fs jail. runStore answers "what happened" (one line per run); this keeps WHAT WAS SAID — a server-
// authoritative, append-only record covering EVERY surface, including headless cron/Telegram/delegated runs
// that have no browser ws.history (the interactive browser conversation already persists durably via the
// save-envelope mirror in cloudsave.js/savestore.js). Hermes keeps a SQLite transcript for all surfaces; this
// closes that gap for the headless paths + gives an autopsy/replay substrate. Content is redacted on write.
const TRANSCRIPT_FILE = path.join(WORKSPACES, 'transcript.jsonl');
const transcriptIo = {
  readAll() {
    try { return readBoundedJsonl(TRANSCRIPT_FILE); } catch (e) { return []; }   // P3: bounded boot-load
  },
  append(entry) {
    let fd = null;
    try { fd = fs.openSync(TRANSCRIPT_FILE, 'a'); fs.writeSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd); }
    catch (e) { console.warn('[transcript] append failed:', (e && e.message) || e); }
    finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
    rotateJsonl(TRANSCRIPT_FILE);   // P3: roll to <file>.1 once the live segment passes the cap (bounds disk)
  }
};
const transcriptStore = makeTranscriptStore({ io: transcriptIo, clock: { now: () => Date.now() }, redact });

// H4: the agent's OWNED skill library — per-agent named procedure documents, append-only + fsync'd, a SIBLING of
// the fs jail (the agent's fs.* tools can't reach it). Singleton (persists across runs); redacted on write.
const SKILLS_FILE = path.join(WORKSPACES, 'skills.jsonl');
const skillsIo = {
  readAll() {
    try {
      return fs.readFileSync(SKILLS_FILE, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    } catch (e) { return []; }
  },
  append(entry) {
    let fd = null;
    try { fd = fs.openSync(SKILLS_FILE, 'a'); fs.writeSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd); }
    catch (e) { console.warn('[skills] append failed:', (e && e.message) || e); }
    finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
  }
};
const skillStore = makeSkillStore({ io: skillsIo, clock: { now: () => Date.now() }, redact });

// BUNDLED SKILL LIBRARY (capability-gated recipe packs shipped WITH StarNet — distinct from skillStore above,
// which holds what the agent SAVES at runtime). Loaded once from sidecar/skills/library/*.md; the user's
// enable/disable choices persist append-only (same fsync discipline as skillStore). Injected into each run's
// system prompt below, gated by requires ⊆ the agent's placed objects (object = capability — the moat).
const SKILL_LIBRARY = skillsCatalog.loadDir(path.join(__dirname, 'skills', 'library'), fs, path);
const SKILL_PREFS_FILE = path.join(WORKSPACES, 'skillprefs.jsonl');
const skillPrefsIo = {
  readAll() {
    try { return fs.readFileSync(SKILL_PREFS_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }
    catch (e) { return []; }
  },
  append(entry) {
    let fd = null;
    try { fd = fs.openSync(SKILL_PREFS_FILE, 'a'); fs.writeSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd); }
    catch (e) { console.warn('[skills] prefs append failed:', (e && e.message) || e); }
    finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
  }
};
const skillPrefs = makeSkillPrefs({ io: skillPrefsIo, clock: { now: () => Date.now() } });

// credential pool (P0.2): orders the primary OpenRouter key + alternates and cools a key that just hit a
// rotate-reason failure (rate_limit/auth/billing) so it isn't retried first next run. In-memory only; never
// logged/persisted. Singleton so the cooldown survives across runs within a sidecar process.
const credPool = makeCredPool({ clock: { now: () => Date.now() } });

const runs = new Map();          // runId -> AbortController (the kill path)
let lastSearchAt = 0;            // module-level web_search throttle (≥1.1s between DDG hits, any run)
// Stage 2: the crew roster the browser pushes (POST /api/roster) so team.dispatch can run a WORKER as its
// own identity (its composed system prompt + model/provider). agentId -> { system, name, model, provider }.
// The browser replaces it on every push; a protected on-disk mirror lets headless cron fires still run as the
// selected agent after a sidecar restart. Not an event (contract-free).
const agentRoster = new Map();
const AGENT_ROSTER_FILE = path.join(WORKSPACES, 'agent.roster.json');
function replaceAgentRoster(list) {
  agentRoster.clear();
  for (const a of (Array.isArray(list) ? list : [])) {
    const id = a && String(a.agentId || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    agentRoster.set(id, {
      system: String((a && a.system) || ''),
      name: String((a && a.name) || id).slice(0, 40),
      model: (a && a.model) ? String(a.model) : null,
      provider: normalizeProviderId((a && a.provider) || ''),
      role: String((a && a.role) || '').slice(0, 120),
      approvalMode: ((a && a.approvalMode) === 'full') ? 'full' : 'ask'   // per-agent consent posture: 'full' bypasses the gate (see runOnce)
    });
  }
}
function loadAgentRoster() {
  try {
    const raw = loadResilient(AGENT_ROSTER_FILE, 'roster');   // last-known-good recovery; never silent-wipe
    if (raw) replaceAgentRoster(raw && raw.agents);
  } catch (_) {}
}
function saveAgentRoster() {
  try {
    fs.mkdirSync(WORKSPACES, { recursive: true });
    const agents = [...agentRoster].map(([agentId, a]) => ({ agentId, system: a.system || '', name: a.name || agentId, model: a.model || null, provider: a.provider || null, role: a.role || '' }));
    saveResilient(AGENT_ROSTER_FILE, { version: 1, agents });   // fsync-durable + .bak last-known-good
  } catch (e) { console.warn('[roster] persist failed:', (e && e.message) || e); }
}
loadAgentRoster();

// jail helper reused by the read-only /api/file route (resolveInside proves a path stays in the workspace)
const fsJail = makeFsTools({ fsp, pathMod: path, root: WORKSPACES })._internals;

// SPOTIFY (the JUKEBOX skill): ONE durable OAuth session for the station, persisted OUTSIDE any agent jail
// (WORKSPACES/.secrets/spotify.json — not reachable via /api/file). PKCE flow → client_id only, never a secret.
// The redirect URI is fixed + must be registered verbatim in the user's Spotify app (loopback IP, not localhost).
const SPOTIFY_REDIRECT = 'http://127.0.0.1:' + PORT + '/api/spotify/callback';
const spotifyStore = makeSpotifyStore({ fsp, pathMod: path, dir: path.join(WORKSPACES, '.secrets'), fetchImpl: globalThis.fetch, now: () => Date.now() });
// in-flight PKCE verifiers keyed by the OAuth `state` (a round-trip completes in seconds). Pruned on each start.
const spotifyPending = new Map();

// PERSISTENT memory KV - JSON file per agent/key family, durable write, survives sidecar restarts. Stored as
// SIBLINGS of the agent's workspace dir (WORKSPACES/<aid>.notebook.json and <aid>.todo.json), OUTSIDE the
// fs-jailed WORKSPACES/<aid>/, so the agent's own fs.* tools can neither read nor corrupt them. update(key,
// mutator) is the SAFE per-agent/key serialized write (P1), and every write is fsync-durable + keeps a .bak
// last-known-good (P2).
const notebookStore = makeMemoryStore({
  fs: fs, path: path, workspaces: WORKSPACES, writeDurable: writeFileDurable,
  onRecover: (key, file) => console.warn('[memory] recovered ' + file + ' from .bak last-known-good after a torn/corrupt main.'),
  onCorrupt: (key, file) => quarantineCorrupt(file, String(key).indexOf('todo:') === 0 ? 'todo' : 'notebook'),
  warn: (...args) => console.warn.apply(console, args)
});

// PHASE C — the station-wide Commander dossier block (what the station knows about the user), pushed by the
// browser (POST /api/dossier) and folded into server-composed autonomous personas (cron) so an unattended
// run still knows who it works for. Persisted as a sibling of the notebooks (outside every agent's fs jail,
// so the agent's own fs.* tools can't read/corrupt it) → it survives a restart for a headless cron fire.
const DOSSIER_FILE = path.join(WORKSPACES, '_commander.dossier.json');
const commanderDossier = {
  _block: '',
  get() { return this._block; },
  set(block) {
    this._block = String(block == null ? '' : block).slice(0, 4096);   // the frontend caps it ~800; this is a hard safety ceiling
    try {
      fs.mkdirSync(WORKSPACES, { recursive: true });
      saveResilient(DOSSIER_FILE, { block: this._block });   // fsync-durable + .bak last-known-good
    } catch (e) { console.warn('[dossier] persist failed:', (e && e.message) || e); }
  },
  load() { const o = loadResilient(DOSSIER_FILE, 'dossier'); if (o) this._block = String((o && o.block) || ''); }
};
commanderDossier.load();

function cronIdentityFor(agentId) {
  const id = String(agentId || 'agent');
  const ident = agentRoster.get(id);
  if (!ident) return null;
  const system = String(ident.system || '').trim();
  return {
    model: ident.model || null,
    provider: ident.provider || null,
    system: system ? withDossier(system + CRON_ROUTINE_NOTE, commanderDossier.get()) : null,
    name: ident.name || id
  };
}
function cronSystemFor(agentId) {
  const ident = cronIdentityFor(agentId);
  return (ident && ident.system) || withDossier(CRON_PERSONA, commanderDossier.get());
}
function cronModelFor(job) {
  const ident = cronIdentityFor(job && job.agentId);
  const rosterModel = ident && ident.model ? String(ident.model).trim() : '';
  return ((job && job.model) ? String(job.model).trim() : '') || rosterModel || CRON_DEFAULT_MODEL;
}
function normalizeProviderId(value) {
  const p = String(value || '').trim().toLowerCase();
  if (p === 'codex' || p === 'openai-codex') return 'codex';
  if (p === 'openrouter') return 'openrouter';
  return '';
}
function cronProviderFor(job) {
  const ident = cronIdentityFor(job && job.agentId);
  const explicit = normalizeProviderId((job && job.provider) || (ident && ident.provider) || '');
  if (explicit) return explicit;
  // Back-compat for already-persisted rosters/jobs from before provider was mirrored: if there is no
  // OpenRouter key but a ChatGPT OAuth token exists, inherit the only runnable provider.
  if (!runtimeKey && codexTokens && codexTokens.access_token) return 'codex';
  return 'openrouter';
}
function cronKeyFor(provider) {
  return normalizeProviderId(provider) === 'codex' ? '' : runtimeKey;
}
function cronHasCredential(provider, key) {
  return normalizeProviderId(provider) === 'codex'
    ? !!(codexTokens && codexTokens.access_token)
    : !!key;
}
function cronCredentialError(provider) {
  return normalizeProviderId(provider) === 'codex'
    ? 'connect ChatGPT first — a signed-in ChatGPT account + model are required to run this routine'
    : 'connect OpenRouter first — an API key + model are required to run this routine';
}

// PERSISTENT agent save (M-save) — a durable mirror of the browser's localStorage save envelope, written to
// the sidecar's own disk (the app-data dir that survives a browser cache wipe). Same containment as the
// notebook: a sibling of the fs jail. Holds NO secret (the key/tokens live elsewhere). The frontend keeps
// localStorage as a fast cache and writes through here on every persist; on boot it pulls the newer of the two.
const saveStore = makeSaveStore({ fs, pathMod: path, root: WORKSPACES, clock: { now: () => Date.now() } });

/* ---- Cortex M-mem.5b: post-run reflection -> Keep/Edit/Discard turn-in ----
   After a substantive browser run COMPLETES, one cheap aux-model call (the same seam summarize() uses)
   proposes durable facts/preferences/skills. The PURE reflect() does the parsing + guardrails (redact,
   dedup vs the store, length/count caps); auto-proposals are CANDIDATES ONLY — they never auto-write (§5.6).
   Proposals are held in-memory (ephemeral — a restart just re-proposes next run) keyed by runId, and the
   frontend turns them in: Keep/Edit -> memory.write (a real §5.2 record), every verdict -> memory.feedback
   (which calibrates the agent's confidence). The run stream is already closed, so the proposed/write/feedback
   events ride the always-on SSE bus (chanEmit) -> the browser U.bus -> XP + the dossier. */
const REFLECT_TIMEOUT_MS = 30000;
const PROPOSALS_CAP = 64;
const proposalsByRun = new Map();      // runId -> { agentId, runId, createdAt, proposals:[{id,kind,content,scope}] }
const latestProposalRun = new Map();   // agentId -> newest pending runId (fetch fallback when the runId is unknown)
function stashProposals(agentId, runId, proposals) {
  proposalsByRun.set(runId, { agentId, runId, createdAt: Date.now(), proposals });
  latestProposalRun.set(agentId, runId);
  while (proposalsByRun.size > PROPOSALS_CAP) { const k = proposalsByRun.keys().next().value; proposalsByRun.delete(k); }
}
// fire-and-forget; never throws. Uses its OWN abort signal (+ timeout) so the closing run stream can't kill it.
async function runReflection(o) {
  const { agentId, runId, messages, provider, model, cost } = o;
  const unmetered = !!(o && o.unmetered);
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, REFLECT_TIMEOUT_MS);
  let usd = 0, tokens = 0;
  // the aux-model call: mirrors summarize() — ONE streamed completion, reconciled for cost. reflect() builds
  // the prompt (recent user/agent exchange) and parses the tagged reply; here we only supply the model.
  const propose = async (prompt) => {
    const req = { model, stream: true, signal: ac.signal, messages: [
      { role: 'system', content: 'You are an agent reflecting right after finishing a task. Extract only DURABLE, reusable memories worth keeping for future runs — stable user preferences, learned facts (state the gist, not the whole result), or repeatable skills. One per line, each tagged FACT:, PREFERENCE:, or SKILL:. Skip anything transient, run-specific, or already obvious. If nothing is worth keeping, reply NONE.' },
      { role: 'user', content: prompt }
    ] };
    let out = '', usage = null;
    for await (const ev of provider.stream(req)) {
      if (ev && ev.type === 'text') out += ev.delta;
      else if (ev && ev.type === 'usage') usage = ev.usage;
    }
    const c = cost.reconcile(usage, model);
    usd += c.usd || 0; tokens += (c.tokensIn || 0) + (c.tokensOut || 0);
    return out;
  };
  try {
    const stored = notebookStore.get('notebook:' + agentId);
    const existing = Array.isArray(stored) ? stored : [];
    const out = await reflect({ agentId, runId, messages }, { propose, redact, existing, clock: { now: () => Date.now() }, max: 5 });
    const proposals = (out && out.proposals) || [];
    if (proposals.length) {
      stashProposals(agentId, runId, proposals.map(p => ({ id: p.id, kind: p.kind, content: p.content, scope: p.scope || 'global' })));
      for (const p of proposals) chanEmit('memory.proposed', { agentId, runId, id: p.id, kind: p.kind, scope: p.scope || 'global' });
    }
  } catch (e) { console.warn('[cortex] reflection failed:', (e && e.message) || e); }
  finally {
    clearTimeout(timer);
    // book the reflection's own spend into the append-only ledger so the day/global pools stay honest (the run
    // already booked the loop's spend before this fired). A second entry for the same runId just sums.
    if (usd) { try { ledger.record({ runId, agentId, turns: 0, usd, tokens, model: model || '', unmetered }); } catch (_) {} }
  }
}

/* ---- consent (P1.5): the four-tier broker's host-side state ----
   Full Access is FROZEN at boot: a tool or model output cannot flip it at runtime — closes the
   prompt-injection escalation path (mirrors Hermes' import-frozen YOLO flag). */
const FULL_ACCESS = /^(1|true|yes|on)$/i.test(String(ENV('FULL_ACCESS') || '').trim());
// permanent allowlist of danger-class keys (capability:scope) the user has blessed forever. Lives BESIDE
// the notebook store (sibling of the fs jail) so the agent's own fs.* tools can neither read nor rewrite it.
const ALLOWLIST_FILE = path.join(WORKSPACES, 'permissions.allow.json');
function loadAllowlist() {
  try {
    const raw = loadResilient(ALLOWLIST_FILE, 'permissions');   // recover blessed grants from .bak on a torn main
    return new Set((raw && Array.isArray(raw.allow) ? raw.allow : []).filter(x => typeof x === 'string'));
  } catch (e) { return new Set(); }   // unrecoverable -> nothing pre-allowed (fail-closed, the safe default)
}
function persistAllowlist(nextAllow) {   // throws on failure -> the broker degrades the grant to a deny
  saveResilient(ALLOWLIST_FILE, { version: 1, allow: nextAllow });   // fsync-durable + .bak; throws on a real write failure
}
const grantsPermanent = loadAllowlist();   // process-wide, restored from disk
const grantsSession = new Map();           // runId -> Set(dangerKey); cleared when the run ends
// full-access ("YOLO") blanket grants the user clicks mid-run: per-AGENT (not per-run), in-memory only, so a
// single click stops the prompts for the rest of this session but RESETS on sidecar restart — never persisted
// (permanent machine-wide YOLO stays the explicit SKYNET_FULL_ACCESS env, frozen at boot).
const grantsBlanketByAgent = new Map();    // agentId -> Set('*')
function blanketSetFor(agentId) {
  let s = grantsBlanketByAgent.get(agentId);
  if (!s) { s = new Set(); grantsBlanketByAgent.set(agentId, s); }
  return s;
}
const pendingByRun = new Map();            // runId -> Map(promptId -> resolve(decision)); the live consent prompts
const pendingSummonByRun = new Map();      // runId -> Map(requestId -> resolve(newAgentId|null)); live team.summon requests awaiting the browser
// unconditional hardline floor: protected files no flag (not even Full Access) can write. The authoritative
// resolved-abs-path floor belongs in dispatch AFTER resolveInside; this catches the reachable relative cases.
function hardlineFloor(call) {
  const p = call && call.args && call.args.path;
  if (typeof p === 'string' && (/(^|[\\/])\.env(\.|$)/i.test(p) || /(^|[\\/])\.git([\\/]|$)/i.test(p)))
    return 'writing ' + p + ' is blocked by the protected-file floor';
  return null;
}

/* ---- messaging channels (C5): a Telegram bot the Commander connects from the in-app Messaging tab.
   The bot token + provider credentials persist in a PROTECTED sibling file (outside the fs jail, never on
   the bus, never returned by /status) so polling survives a restart with no browser open. The adapter is the
   lone ambient-I/O edge (injected globalThis.fetch); the hub drives the SAME runOnce host with
   surface:'autonomous' (a headless chat has no browser to answer a consent prompt — ungranted writes
   default-deny and the run continues). Opt-in: nothing starts unless the Commander connects (or env is set). */
const TELEGRAM_PERSONA = 'You are the Commander\'s AI agent aboard the STARNET station, reachable over Telegram. '
  + 'Address the user as "Commander", keep a spark of personality, and keep replies concise and chat-friendly. '
  + 'When the Commander gives you a task you have REAL tools (web search/read, files, memory) — use them and '
  + 'report what you actually found; never claim you cannot act.';
const VOICE_CACHE_DIR = path.join(WORKSPACES, 'voice-cache');
try { fs.mkdirSync(VOICE_CACHE_DIR, { recursive: true }); } catch (e) {}
let ttsMissCount = 0, evictingVoiceCache = false;   // opportunistic, throttled voice-cache eviction
const CHANNELS_DIR = path.join(WORKSPACES, 'channels');
const CHANNEL_SECRETS_FILE = path.join(CHANNELS_DIR, 'secrets.json');
function loadChannelSecrets() {
  try { const raw = loadResilient(CHANNEL_SECRETS_FILE, 'channels'); return (raw && typeof raw === 'object') ? raw : {}; }
  catch (e) { return {}; }   // unrecoverable -> nothing configured
}
function saveChannelSecrets(obj) {   // protected sibling of the fs jail; the agent's own fs.* tools can't read/write it
  try {
    fs.mkdirSync(CHANNELS_DIR, { recursive: true });
    saveResilient(CHANNEL_SECRETS_FILE, obj);   // fsync-durable + .bak last-known-good (bot token survives power loss)
  } catch (e) { console.warn('[channels] secrets persist failed:', (e && e.message) || e); }
}
let channelSecrets = loadChannelSecrets();
const channelStore = makeChannelStore({ fs, pathMod: path, root: CHANNELS_DIR, clock: { now: () => Date.now() }, writeDurable: writeFileDurable, onRecover: (file) => console.warn('[channels] recovered ' + file + ' from .bak last-known-good after a torn/corrupt main.') });

// ---- Codex (personal ChatGPT subscription) OAuth tokens — a protected sibling of the fs jail, SAME posture
//      as the channel secrets above: the agent's own fs.* tools can't reach it, and the access/refresh tokens
//      are NEVER placed on the event bus. Shape: { access_token, refresh_token, last_refresh, auth_mode }. ----
const CODEX_TOKENS_FILE = path.join(WORKSPACES, 'codex', 'tokens.json');
function loadCodexTokens() {
  try { const raw = loadResilient(CODEX_TOKENS_FILE, 'codex'); return (raw && typeof raw === 'object' && raw.access_token) ? raw : null; }
  catch (e) { return null; }
}
function saveCodexTokens(obj) {
  try {
    fs.mkdirSync(path.dirname(CODEX_TOKENS_FILE), { recursive: true });
    saveResilient(CODEX_TOKENS_FILE, obj);   // fsync-durable + .bak last-known-good (OAuth tokens survive power loss)
  } catch (e) { console.warn('[codex] token persist failed:', (e && e.message) || e); }
}
// clear must also drop the .bak so a signed-out session can't be "recovered" from the last-known-good on reload.
function clearCodexTokens() { try { fs.unlinkSync(CODEX_TOKENS_FILE); } catch (e) {} try { fs.unlinkSync(CODEX_TOKENS_FILE + '.bak'); } catch (e) {} }
let codexTokens = loadCodexTokens();

// Hand a Codex run a FRESH access_token: refresh when the JWT exp is within the skew window, persisting the
// rotated tokens. Throws an auth error otherwise — `reloginRequired` tells the caller whether to prompt a new
// ChatGPT sign-in (dead/missing refresh token) or surface a transient "retry later" (quota/network).
async function ensureCodexAccessToken() {
  if (!codexTokens || !codexTokens.access_token) {
    const e = new Error('Not signed in to ChatGPT — connect a ChatGPT subscription first.');
    e.code = 'codex_not_connected'; e.reloginRequired = true; throw e;
  }
  if (!codexAuth.accessTokenIsExpiring(codexTokens.access_token, codexAuth.REFRESH_SKEW_SECONDS, Date.now())) return codexTokens.access_token;
  const next = await codexAuth.refreshTokens({ fetch: globalThis.fetch, refresh_token: codexTokens.refresh_token, now: Date.now() });
  codexTokens = Object.assign({}, codexTokens, next);
  saveCodexTokens(codexTokens);
  return codexTokens.access_token;
}
// channel.* / workitem.* / queue.* telemetry: validated + redacted, logged to the sidecar console AND
// forwarded to open browser EventSources (the station HUD). The bot token / OR key are NEVER placed on a
// payload — nothing to leak here — and redact() runs before validate() as a second backstop.
const sse = makeSseHub();
const chanBus = { emit: (name, payload) => {
  try { console.log('[channel]', name, JSON.stringify(payload)); } catch (_) {}
  try { sse.broadcast(name, payload); } catch (_) {}
} };
const chanEmitValidated = makeEmitter(chanBus, e => console.warn('[channel-event]', e.kind, e.event, (e.errors || []).join(';')));
const chanEmit = (name, payload) => { try { return chanEmitValidated(name, redact(payload)); } catch (_) {} };

// H2.2: the SINGLETON background-process manager — persists across runs so a backgrounded dev server survives the
// run that started it. shell.bg.exit fires AFTER the originating run's NDJSON stream closed, so it rides the
// durable channel bus (chanEmit). Children are unref'd; killAll() reaps them on E-STOP (handleHalt) / shutdown.
const shellBg = makeShellBg({ spawn: childSpawn, redact: redact, clock: { now: () => Date.now() }, onExit: (e) => chanEmit('shell.bg.exit', e), maxPerAgent: 5 });
const executionEnvironment = makeEnvironmentManager({ spawn: childSpawn, fs: fs, pathMod: path, root: WORKSPACES, bg: shellBg, redact: redact, clock: { now: () => Date.now() }, env: process.env });
try { console.log('[exec-env]', JSON.stringify(executionEnvironment.describe())); } catch (_) {}
const subagents = makeSubagentManager({ fs: fs, pathMod: path, file: path.join(WORKSPACES, 'subagents.json'), clock: { now: () => Date.now() }, emit: chanEmit, newId: () => crypto.randomUUID(), keep: 200 });

// per-agent inbound work-item depth (backpressure): bumped when a message is admitted, dropped when its
// run finishes. Drives queue.status -> the queue-depth HUD. Keyed by the SAME agentId the hub routes to.
const QUEUE_CAP = 64;
const queueDepth = new Map();
const activeItem = new Map();   // agentId -> the newest in-flight workitemId; older ones the hub superseded
function bumpQueue(agentId, d) { const n = Math.max(0, (queueDepth.get(agentId) || 0) + d); queueDepth.set(agentId, n); return n; }

// the placed floor's RoutingPlan (posted by the app on every geo change). resolveTarget answers "which agent
// runs this work-item?"; a non-deployable plan (cycle/orphan/dead-bay) is refused so routing can't loop.
const router = makeRouter();

/* ---- MCP connectors (the "connectors" capability): configured MCP servers whose live tools become real
   agent tools. Tokens persist in a PROTECTED sibling file (outside the fs jail, never on the bus, never
   returned by /api/connectors — only `hasToken`); the manager keeps one warm client per connector and projects
   its tools/list into per-agent registry tools at run time. Mirrors the Telegram channel's config lifecycle. */
const CONNECTORS_DIR = path.join(WORKSPACES, 'connectors');
const CONNECTORS_FILE = path.join(CONNECTORS_DIR, 'connectors.json');
function loadConnectorConfigs() {
  try { const raw = loadResilient(CONNECTORS_FILE, 'connectors'); return (raw && Array.isArray(raw.connectors)) ? raw.connectors : []; }
  catch (e) { return []; }   // unrecoverable -> nothing configured
}
let connectorConfigs = loadConnectorConfigs();
function saveConnectorConfigs() {
  try {
    fs.mkdirSync(CONNECTORS_DIR, { recursive: true });
    saveResilient(CONNECTORS_FILE, { version: 1, connectors: connectorConfigs });   // fsync-durable + .bak last-known-good
  } catch (e) { console.warn('[connectors] persist failed:', (e && e.message) || e); }
}
const connectors = makeConnectorManager({
  makeTransport: (cfg) => cfg && cfg.transport === 'stdio' ? makeStdioTransport(cfg) : makeHttpTransport(cfg),
  clock: { now: () => Date.now() }, timeoutMs: CAPS.toolTimeoutMs,
  onEvent: (e) => { try { console.log('[connector]', e.type, e.connectorId || '', e.state || e.detail || ''); } catch (_) {} }
});

/* ---- cron / scheduled routines store + tick driver (CRON Commit 4b). The job DEFINITIONS persist in a
   PROTECTED sibling of the fs jail (WORKSPACES/cron.jobs.json, the allowlist idiom above: versioned envelope,
   atomic + DURABLE temp→fsync→rename (G4.2 — no double-fire on a crash in the advance-before-run window),
   load→corrupt→empty fail-closed) so the agent's own fs.* tools can neither read nor rewrite
   its own schedule. The cron-math + lifecycle reducer are pure (cron.js / cron-store.js); the timer, the
   now-source, id minting and this fs are the ambient half that lives ONLY here. The driver is constructed
   unconditionally (cheap, no I/O), but it only ever runs when the boot block below arms the timer behind the
   SKYNET_CRON_ENABLED gate — so with cron off this is dead weight, never a behavior change. ---- */
const CRON_FILE = path.join(WORKSPACES, 'cron.jobs.json');
function loadCronJobs() {
  try { return cronStore.loadEnvelope(fs.readFileSync(CRON_FILE, 'utf8')).jobs; }
  catch (e) { return []; }   // missing/corrupt -> nothing scheduled (fail-closed)
}
let cronJobs = loadCronJobs();
function saveCronJobs() {   // throws on failure (the CRUD routes let it surface); the driver's setJobs catches+logs
  // G4.2: crash-SAFE persistence. The advance-before-run window (cron-driver persists the ADVANCED nextRunAt
  // BEFORE launching a fire) is the one place a lost/zero-length write would DOUBLE-FIRE a routine on restart,
  // so we don't just rename — we fsync the temp file's bytes to stable storage BEFORE the rename (per-pid+random
  // tmp so concurrent writers never collide), then best-effort fsync the directory after (Windows-safe). Same
  // durability the ledger/runs appends already get; happy-path behavior (versioned envelope, atomic replace) is
  // identical to the old temp+rename.
  writeFileDurable({ fs: fs, path: path }, CRON_FILE, JSON.stringify(cronStore.toEnvelope(cronJobs)));
}

/* ---- G4.6: persisted "is the scheduler armed?" flag, so a one-click ENABLE in the UI arms the timer WITHOUT
   an env edit + restart. The whole subsystem stays INERT unless armed: the boot block ORs SKYNET_CRON_ENABLED
   with this persisted flag to decide the INITIAL armed state, and a live arm/disarm route flips an IN-MEMORY
   `cronArmed` + (re)starts/clears the tick timer NOW. We do NOT mutate process.env at runtime — that would be
   a hidden lie about the boot-frozen gate; the persisted flag is the durable record, the in-memory bool the
   live state. The flag lives in the PROTECTED WORKSPACES dir (sibling of the fs jail, like cron.jobs.json) and
   is written through the SAME durable temp→fsync→rename helper (G4.2), so a crash never leaves a torn flag.
   INERT-WHEN-OFF guarantee: a user who never enables cron has no cron.armed.json (load fails closed to false),
   no SKYNET_CRON_ENABLED, so cronArmed=false at boot, no timer is armed, and the off-path is byte-identical. ---- */
const CRON_ARMED_FILE = path.join(WORKSPACES, 'cron.armed.json');
function loadCronArmed() {
  // fail-closed: missing/corrupt/non-boolean -> false (an unreadable flag must never silently ARM the scheduler).
  try {
    const env = JSON.parse(fs.readFileSync(CRON_ARMED_FILE, 'utf8'));
    return !!(env && env.armed === true);
  } catch (_) { return false; }
}
function saveCronArmed(armed) {   // durable like the jobs file; throws on a real write failure so the route surfaces it
  writeFileDurable({ fs: fs, path: path }, CRON_ARMED_FILE, JSON.stringify({ version: 1, armed: armed === true }));
}
// the LIVE armed state: SKYNET_CRON_ENABLED (env, boot-frozen) OR the persisted runtime flag. Mutated only by
// armCron()/disarmCron() (below) — never via process.env. GET /api/cron reports THIS so the panel is honest.
let cronArmed = CRON_ENABLED || loadCronArmed();

/* ---- G4.3: cross-process / reentrancy EXACTLY-ONCE lock. Two sidecars sharing one WORKSPACES dir (or a
   second sidecar's boot-resume reconcile racing the first's timer tick, or a CRUD save racing an advance)
   would otherwise BOTH read the same due store and BOTH fire, and a CRUD write can clobber an advance
   (last-write-wins on the jobs mirror). One advisory lockfile (WORKSPACES/cron.lock) serializes every cron
   WRITE — applyTick AND each CRUD save — so at most one writer is ever in the critical section. The lock is
   the portable O_EXCL+pid:nonce+read-back path (Windows has no flock) with a maxRunMs stale break so a
   crashed holder never wedges cron forever; reclaim of a stale lock is a SINGLE atomic rename (the loser
   no-ops). It is re-entrant within this process, so applyTick(lock) -> setJobs -> saveCronJobs(lock) nests
   safely. now() uses the same Date.now the driver does (the staleness comparison is the only clock read). ---- */
const CRON_LOCK_FILE = path.join(WORKSPACES, 'cron.lock');
const cronLock = makeCronLock({ fs: fs, path: path, lockfile: CRON_LOCK_FILE, now: () => Date.now(), maxRunMs: CRON_MAX_RUN_MS });

// withCronWrite — run a cron mutation as a re-read-modify-write UNDER the lock: re-load the freshest store
// from disk (so a concurrent process's advance is visible), apply `mutate(jobs)` to it, mirror + persist
// durably. This is the fix for the last-write-wins clobber: a CRUD save no longer operates on a STALE
// in-memory snapshot taken before an advance — it re-reads first, so the advance survives. If the lock is
// held by a LIVE other process we briefly spin (the critical section is one file write, sub-ms); if still
// contended we fall back to a best-effort local save (a human-paced CRUD edit must not be silently dropped).
function withCronWrite(mutate) {
  const run = () => { cronJobs = mutate(loadCronJobs()); saveCronJobs(); };   // re-read -> apply -> persist
  for (let i = 0; i < 50; i++) {                      // ~50ms bounded spin for a live cross-process holder
    const r = cronLock.withLock(run);
    if (r.ran) return;
    const until = Date.now() + 1; while (Date.now() < until) { /* 1ms busy-wait between acquire attempts */ }
  }
  // contended beyond the spin budget (a wedged peer the stale break hasn't reclaimed yet): persist locally so
  // the user's edit is never lost. The advance/clobber race this guards is cron-internal, not CRUD-vs-CRUD.
  cronJobs = mutate(loadCronJobs()); saveCronJobs();
}
// validated + redacted cron telemetry -> the sidecar console AND the live station HUD (the SAME SSE bridge the
// channel/work-item events ride). No secret is ever on a cron.* payload; redact() runs as a second backstop.
const cronBus = { emit: (name, payload) => {
  try { console.log('[cron]', name, JSON.stringify(payload)); } catch (_) {}
  try { sse.broadcast(name, payload); } catch (_) {}
} };
const cronEmitValidated = makeEmitter(cronBus, e => console.warn('[cron-event]', e.kind, e.event, (e.errors || []).join(';')));
const cronEmit = (name, payload) => { try { return cronEmitValidated(name, redact(payload)); } catch (_) { return false; } };

function placeCronWorkitem(agentId, prompt) {
  try {
    const preview = String(prompt || '').replace(/\s+/g, ' ').slice(0, 40);
    chanEmit('workitem.placed', { workitemId: crypto.randomUUID(), queueId: agentId, agentId, kind: 'cron', preview, queueDepth: 0, ts: Date.now() });
  } catch (_) {}
}
// the autonomous tick driver — pure orchestration with every ambient dep injected here
// (timer/now/id/fs/provider credentials).
const cronDriver = makeCronDriver({
  getJobs: () => cronJobs,
  // setJobs persists the driver's computed store UNDER the lock (G4.3). Inside a lock-wrapped applyTick this
  // is a re-entrant nested acquire (no double-take, no premature release), so the ADVANCE-before-run write is
  // always serialized with the fire. A direct call (finishFire settling after the tick released the lock)
  // takes the lock fresh; if a live peer holds it we briefly spin, then fall back to a local persist so a
  // settled run's outcome record is never silently lost. The driver hands a fully-computed array (mirror +
  // persist only) — the re-read-modify-write that prevents the CRUD clobber lives in withCronWrite.
  setJobs: (jobs) => {
    try {
      for (let i = 0; i < 50; i++) {
        const r = cronLock.withLock(() => { cronJobs = jobs; saveCronJobs(); });
        if (r.ran) return;
        const until = Date.now() + 1; while (Date.now() < until) { /* 1ms between attempts */ }
      }
      cronJobs = jobs; saveCronJobs();   // contended beyond budget: persist locally (advance already serialized in-tick)
    } catch (e) { console.warn('[cron] persist failed:', (e && e.message) || e); }
  },
  runOnce: (opts) => runOnce(opts),                       // the SAME run host the browser uses (hoisted decl below)
  emit: cronEmit, newId: () => crypto.randomUUID(), newAbort: () => new AbortController(), now: () => Date.now(),
  getKey: (provider) => cronKeyFor(provider),
  providerForJob: (job) => cronProviderFor(job),
  hasCredential: (provider, key) => cronHasCredential(provider, key),
  defaultModel: CRON_DEFAULT_MODEL, maxRunMs: CRON_MAX_RUN_MS,
  maxParallel: CRON_MAX_PARALLEL,                          // G4.4 global concurrency cap: at most N cron runs in-flight; the rest defer
  defaultTz: CRON_HOST_TZ,                                 // boot-frozen host tz: a tz-less schedule fires on LOCAL wall-clock (G4.1)
  identityForAgent: (agentId) => cronIdentityFor(agentId),
  // a fired routine rides its instruction onto the CONVEYOR as a CRON box bound for its agent — the SAME
  // workitem.placed plumbing a Telegram message uses (-> SSE -> the floor), so a scheduled fire is VISIBLE: a
  // crate arrives at the agent's bay and (with the run-lifecycle binding in world.js) the agent goes to work.
  // The agentId is the job's (server-authoritative), so the box lands on exactly the agent the run executes as.
  placeWorkitem: (agentId, prompt, runId) => {
    placeCronWorkitem(agentId, prompt);
  },
  // persona is a GETTER so each fire folds in the LIVE Commander dossier (it changes as the user edits it);
  // withDossier is a no-op when the dossier is empty, so this is byte-identical to CRON_PERSONA until one exists.
  persona: (agentId) => cronSystemFor(agentId)
});
let cronTimer = null;

/* ---- G4.6: arm/disarm the live scheduler tick. armCron() runs ONE immediate reconcile tick (catching up any
   fires missed while the timer was off — at-most-one within grace, else fast-forward+skip, never a backlog)
   UNDER the cross-process lock (G4.3), then arms the interval; it is IDEMPOTENT (a no-op when a timer already
   runs). disarmCron() clears the interval so no further ticks fire. Both are called at boot (behind the
   cronArmed gate) AND at runtime by POST /api/cron/arm — arming starts a due job firing within ONE tick with
   NO restart, disarming stops it immediately. The lock re-enters cleanly through applyTick -> setJobs ->
   saveCronJobs. ---- */
function armCron() {
  if (cronTimer) return false;   // already armed — idempotent (a second arm must not stack two timers)
  console.log('  · cron enabled — ' + cronJobs.length + ' routine(s); running boot reconcile');
  // G4.3: wrap BOTH the resume reconcile and every timer tick in the cross-process lock so two sidecars (or
  // this reconcile racing the first timer tick) can never both fire — whoever holds the lock ticks, the other
  // no-ops this pass. The reconcile runs BEFORE the interval arms so a catch-up never overlaps the first tick.
  try { cronLock.withLock(() => cronDriver.applyTick(Date.now())); } catch (e) { console.warn('[cron] reconcile error:', (e && e.message) || e); }
  cronTimer = setInterval(() => { try { cronLock.withLock(() => cronDriver.applyTick(Date.now())); } catch (e) { console.warn('[cron] tick error:', (e && e.message) || e); } }, CRON_TICK_MS);
  if (cronTimer.unref) cronTimer.unref();   // the http server keeps the process alive; the ticker alone shouldn't
  console.log('  · cron tick armed (' + Math.round(CRON_TICK_MS / 1000) + 's)');
  return true;
}
function disarmCron() {
  if (!cronTimer) return false;
  try { clearInterval(cronTimer); } catch (_) {}
  cronTimer = null;
  console.log('  · cron tick DISARMED — no routine will fire until re-enabled');
  return true;
}

/* ---- execution spine: the checkpoint rollback net (Commit 1). A per-agent shadow-git store under
   WORKSPACES/.checkpoints/<agentId>/ — a SIBLING of the fs jail, so the agent's own fs.* and shell tools can
   neither read nor rewrite its own history. The auto-snapshot-before-a-mutating-tool hook (in dispatch) is OPT-IN
   via SKYNET_CHECKPOINTS (default OFF = the existing run path is byte-identical) and FAIL-OPEN (a git problem
   never breaks a run); the restore route is always available. The pure index/rollback math is checkpoint.js;
   the git/fs is here, the one ambient-I/O edge. ---- */
const CHECKPOINTS_ENABLED = /^(1|true|yes|on)$/i.test(String(ENV('CHECKPOINTS') || '').trim());
const mutatesWorkspace = (name) => /^fs\.(write|append|edit)$/.test(name) || /^(shell|verify)\./.test(name);
function runGit(args, opts) {   // resolves (never rejects); a missing/failing git becomes a fail-open skip upstream
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd: (opts && opts.cwd) || WORKSPACES, timeout: 15000, windowsHide: true, maxBuffer: 8 << 20 },
        (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    } catch (e) { resolve({ code: 1, stdout: '', stderr: String((e && e.message) || e) }); }
  });
}
const checkpointStore = makeCheckpointStore({ fs, pathMod: path, root: WORKSPACES, runGit: runGit, clock: { now: () => Date.now() }, keep: 50 });
// checkpoint.* telemetry to the war-room HUD (the manual restore route has no run stream of its own); validated+redacted.
const checkpointBus = { emit: (name, payload) => {
  try { console.log('[checkpoint]', name, JSON.stringify(payload)); } catch (_) {}
  try { sse.broadcast(name, payload); } catch (_) {}
} };
const checkpointEmitValidated = makeEmitter(checkpointBus, e => console.warn('[checkpoint-event]', e.kind, e.event, (e.errors || []).join(';')));
const checkpointEmit = (name, payload) => { try { return checkpointEmitValidated(name, redact(payload)); } catch (_) { return false; } };

let telegram = null;                                    // { adapter, hub } when connected, else null
let telegramStatus = { connected: false, state: 'down', detail: '' };
let discord = null;                                     // H6.2: { adapter, hub } when connected, else null
let discordStatus = { connected: false, state: 'down', detail: '' };
const channelRegistry = makeChannelRegistry();          // H6.2: telegram + discord descriptors

function normalizeProvider(provider) {
  return (provider === 'codex' || provider === 'openai-codex') ? 'codex' : 'openrouter';
}
function providerUsesCodex(provider) { return normalizeProvider(provider) === 'codex'; }
function normalizeReasoningEffort(value) {
  const key = String(value || 'medium').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const map = {
    off: 'none', none: 'none', no: 'none', disabled: 'none',
    min: 'minimal', minimal: 'minimal',
    low: 'low',
    med: 'medium', mid: 'medium', medium: 'medium',
    high: 'high',
    extra: 'xhigh', xtra: 'xhigh', extrahigh: 'xhigh', xhigh: 'xhigh',
    max: 'max'
  };
  return map[key] || 'medium';
}
function defaultReasoningEffortForProvider(provider) {
  return providerUsesCodex(provider) ? 'low' : 'medium';
}
function resolveReasoningEffort(provider, value) {
  return normalizeReasoningEffort(value || defaultReasoningEffortForProvider(provider));
}

function startTelegram(token, key, model, agentCfg) {
  stopTelegram();
  const cfg = agentCfg || {};
  const provider = normalizeProvider(cfg.provider);
  const reasoningEffort = resolveReasoningEffort(provider, cfg.reasoningEffort);
  const prev = (channelSecrets && channelSecrets.telegram) || {};
  // Persist the SAME agentId + composed system prompt the app uses, so a Telegram run IS the same agent
  // (shared notebook/memory/workspace + identity), just a different session. `agentId`/`system` are read
  // LIVE by the hub each message, so /sync can refresh them (dossier edits) without a reconnect.
  channelSecrets = Object.assign({}, channelSecrets, { telegram: {
    token: token, key: key, model: model, provider: provider, reasoningEffort: reasoningEffort, enabled: true,
    agentId: cfg.agentId || undefined, system: cfg.system || undefined, name: cfg.name || undefined,
    ownerId: cfg.ownerId || prev.ownerId || undefined
  } });
  saveChannelSecrets(channelSecrets);
  let adapterRef = null;
  const hub = makeChannelHub({
    channel: 'telegram', runOnce: runOnce, store: channelStore,
    send: (chatId, text, opts) => adapterRef ? adapterRef.send(chatId, text, opts) : Promise.resolve({ ok: false, error: 'no adapter' }),
    secrets: () => {
      const t = (channelSecrets && channelSecrets.telegram) || {};
      const provider = normalizeProvider(t.provider);
      const key = provider === 'openrouter' ? (t.key || runtimeKey) : '';
      return { key, model: t.model, provider, reasoningEffort: resolveReasoningEffort(provider, t.reasoningEffort), agentId: t.agentId, system: t.system };
    },
    persona: TELEGRAM_PERSONA, classify: Classify.isTaskDirective, redact: redact, emit: chanEmit,
    newId: () => crypto.randomUUID(), maxMessageLength: 4096,
    // Phase B: the placed floor decides WHICH agent runs (resolveTarget); null -> the hub's own resolution
    // (configured agentId else tg_<chatId>), so a no-floor or mis-wired station never stalls real work.
    resolveAgent: (ctx) => router.resolveTarget(ctx),
    getTag: (text) => (Classify.getTag ? Classify.getTag(text) : undefined),   // B3 supplies the real classifier
    resolveStation: (agentId) => router.stationFor(agentId)                     // B5: a bay's room objects = that agent's caps
  });
  const adapter = makeTelegramAdapter({
    fetch: globalThis.fetch, token: token, clock: { now: () => Date.now() },
    // owner-only admission: the first DM claims the bot; persist that userId so it survives restarts.
    ownerUserId: (channelSecrets.telegram && channelSecrets.telegram.ownerId) || '',
    onOwnerClaim: (uid) => {
      try {
        const t = (channelSecrets && channelSecrets.telegram) || {};
        channelSecrets = Object.assign({}, channelSecrets, { telegram: Object.assign({}, t, { ownerId: String(uid) }) });
        saveChannelSecrets(channelSecrets);
        console.log('  · telegram owner claimed (userId ' + String(uid) + ') — other DMs are now refused');
      } catch (_) {}
    },
    onInbound: (m) => {
      // WORK-ITEM INTERCEPT: an admitted message becomes a box that rides the player-laid belts to the
      // agent. This is pure VISUALIZATION telemetry — hub.onInbound still runs the real work regardless of
      // whether any belt/INTAKE exists. agentId MIRRORS the hub's OWN resolution (a configured agentId else
      // tg_<chatId>) so the HUD attributes work to the same agent the hub actually runs (hub.js AID_RE/secrets).
      let agentId = '', workitemId = '';
      try {
        const sec = (channelSecrets && channelSecrets.telegram) || {};
        agentId = (sec.agentId && /^[A-Za-z0-9_-]{1,40}$/.test(String(sec.agentId))) ? String(sec.agentId) : hub._internals.agentIdFor(String(m && m.chatId));
        workitemId = crypto.randomUUID();
        const preview = String((m && m.text) || '').replace(/\s+/g, ' ').slice(0, 40);
        // a prior in-flight item for this chat is about to be ABORTED by the hub — drop its box off the belt.
        const prior = activeItem.get(agentId);
        if (prior && prior !== workitemId) chanEmit('workitem.superseded', { workitemId: prior, agentId, ts: Date.now() });
        activeItem.set(agentId, workitemId);
        const depth = bumpQueue(agentId, +1);
        chanEmit('workitem.placed', { workitemId, queueId: agentId, agentId, kind: 'telegram', preview, queueDepth: depth, ts: Date.now() });
        chanEmit('queue.status', { queueId: agentId, depth, maxCapacity: QUEUE_CAP, nextAdvanceAt: 0 });
      } catch (e) { console.warn('[telegram] intake intercept error:', (e && e.message) || e); }
      Promise.resolve(hub.onInbound(m))
        .catch(e => console.warn('[telegram] inbound error:', (e && e.message) || e))
        .then(() => {
          if (!agentId) return;
          const d = bumpQueue(agentId, -1);
          if (activeItem.get(agentId) === workitemId) {        // finished WITHOUT being superseded → the reply went out
            activeItem.delete(agentId);
            chanEmit('workitem.delivered', { workitemId, finalQueueId: 'outbox', agentId, box: '', ms: 0, ts: Date.now() });
          }
          chanEmit('queue.status', { queueId: agentId, depth: d, maxCapacity: QUEUE_CAP, nextAdvanceAt: 0 });
        });
    },

    onCallback: hub.onCallback,
    onStatus: (s) => {
      const state = (s && s.state) || 'down';
      // a fatal (401/invalid-token) error stops the poll loop -> mark disconnected so /status is honest.
      telegramStatus = { connected: state === 'error' ? false : !!telegram, state: state, detail: (s && s.detail) || '' };
      hub.onStatus(s);
    }
  });
  adapterRef = adapter;
  telegram = { adapter: adapter, hub: hub };
  telegramStatus = { connected: true, state: 'up', detail: '' };
  adapter.connect();
  console.log('  · telegram channel connected');
}
function stopTelegram() {
  if (telegram && telegram.adapter) { try { telegram.adapter.disconnect(); } catch (_) {} }
  telegram = null;
  telegramStatus = { connected: false, state: 'down', detail: '' };
}

// H6.2: Discord — the adapter shipped fully-tested but the host never started it. Wire it the SAME way as
// Telegram, but through the generic channelRegistry/wireChannel so there is one inbound->runOnce path. The live
// gateway connects over a real WebSocket from the bot token (transport default); everything else is the shared hub.
const DISCORD_PERSONA = 'You are the Commander\'s AI agent aboard the StarNet station, reachable over Discord. '
  + 'Address the user as "Commander", keep a spark of personality, and keep replies concise and chat-friendly. '
  + 'When the Commander gives you a task you have REAL tools (web search/read, files, memory) — use them and '
  + 'report what you actually found; never claim you cannot act.';
function startDiscord(token, key, model, agentCfg) {
  stopDiscord();
  const cfg = agentCfg || {};
  const provider = normalizeProvider(cfg.provider);
  const prev = (channelSecrets && channelSecrets.discord) || {};
  channelSecrets = Object.assign({}, channelSecrets, { discord: {
    token: token, key: key, model: model, provider: provider, enabled: true,
    agentId: cfg.agentId || undefined, system: cfg.system || undefined, name: cfg.name || undefined,
    ownerId: cfg.ownerId || prev.ownerId || undefined
  } });
  saveChannelSecrets(channelSecrets);
  const wired = wireChannel(channelRegistry.get('discord'), {
    hub: {
      runOnce: runOnce, store: channelStore,
      secrets: () => {
        const d = (channelSecrets && channelSecrets.discord) || {};
        const provider = normalizeProvider(d.provider);
        const k = provider === 'openrouter' ? (d.key || runtimeKey) : '';
        return { key: k, model: d.model, provider, agentId: d.agentId, system: d.system };
      },
      persona: DISCORD_PERSONA, classify: Classify.isTaskDirective, redact: redact, emit: chanEmit,
      newId: () => crypto.randomUUID(),
      resolveAgent: (ctx) => router.resolveTarget(ctx),
      getTag: (text) => (Classify.getTag ? Classify.getTag(text) : undefined),
      resolveStation: (agentId) => router.stationFor(agentId)
    },
    adapter: {
      fetch: globalThis.fetch, token: token, clock: { now: () => Date.now() },
      ownerUserId: (channelSecrets.discord && channelSecrets.discord.ownerId) || '',
      onOwnerClaim: (uid) => {
        try {
          const d = (channelSecrets && channelSecrets.discord) || {};
          channelSecrets = Object.assign({}, channelSecrets, { discord: Object.assign({}, d, { ownerId: String(uid) }) });
          saveChannelSecrets(channelSecrets);
          console.log('  · discord owner claimed (userId ' + String(uid) + ') — other DMs are now refused');
        } catch (_) {}
      },
      onStatus: (s) => {
        const state = (s && s.state) || 'down';
        discordStatus = { connected: state === 'error' ? false : !!discord, state: state, detail: (s && s.detail) || '' };
        if (wired && wired.hub) wired.hub.onStatus(s);
      }
    }
  });
  discord = { adapter: wired.adapter, hub: wired.hub };
  discordStatus = { connected: true, state: 'up', detail: '' };
  wired.adapter.connect();
  console.log('  · discord channel connected');
}
function stopDiscord() {
  if (discord && discord.adapter) { try { discord.adapter.disconnect(); } catch (_) {} }
  discord = null;
  discordStatus = { connected: false, state: 'down', detail: '' };
}

const server = http.createServer((req, res) => {
  const isApi = String(req.url || '').indexOf('/api/') === 0 || req.url === '/api';
  if (isApi) {
    // Desktop serves the frontend from a Tauri app origin, while browser mode is same-origin loopback.
    // Mirror only trusted origins and reject browser-driven localhost calls from arbitrary sites.
    applyApiCors(req, res);
    if (rejectApi(req, res)) return;
  }
  if (req.method === 'OPTIONS') {
    if (!isApi) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(204); return res.end();
  }
  if (isApi && rejectBadApiToken(req, res)) return;
  if (req.method === 'POST' && req.url === '/api/session') return handleApiSession(req, res);
  if (req.method === 'POST' && req.url === '/api/run') return handleRun(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/tts') return handleTts(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/cancel') return handleCancel(req, res);
  if (req.method === 'POST' && req.url === '/api/halt') return handleHalt(req, res);
  if (req.method === 'POST' && req.url === '/api/consent') return handleConsent(req, res);
  if (req.method === 'POST' && req.url === '/api/summon/ack') return handleSummonAck(req, res);
  if (req.method === 'POST' && req.url === '/api/key') return handleSetKey(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/connect') return handleChannelConnect(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/sync') return handleChannelSync(req, res);
  if (req.method === 'POST' && req.url === '/api/roster') return handleRoster(req, res);
  if (req.method === 'POST' && req.url === '/api/dossier') return handleDossier(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/disconnect') return handleChannelDisconnect(req, res);
  if (req.method === 'GET' && req.url === '/api/channels/telegram/status') return handleChannelStatus(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/channels/events') return handleChannelEvents(req, res);   // path match: the SSE url carries a ?token= query now
  if (req.method === 'POST' && req.url === '/api/routing') return handleRouting(req, res);
  if (req.method === 'GET' && req.url === '/api/budget/status') return handleBudgetStatus(req, res);
  if (req.method === 'POST' && req.url === '/api/budget/resume') return handleBudgetResume(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/codex/start') return handleCodexStart(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/codex/poll') return handleCodexPoll(req, res);
  if (req.method === 'GET' && req.url === '/api/auth/codex/status') return handleCodexStatus(req, res);
  if (req.method === 'GET' && req.url === '/api/auth/codex/models') return handleCodexModels(req, res);
  if (req.method === 'GET' && req.url === '/api/models/openrouter') return handleOpenRouterModels(req, res).catch(() => { try { res.end(JSON.stringify({ models: [] })); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/auth/codex/logout') return handleCodexLogout(req, res);
  if (req.method === 'GET' && req.url === '/api/connectors') return handleConnectorsList(req, res);
  if (req.method === 'POST' && req.url === '/api/connectors') return handleConnectorUpsert(req, res);
  if (req.method === 'POST' && req.url === '/api/connectors/remove') return handleConnectorRemove(req, res);
  if (req.method === 'POST' && req.url === '/api/connectors/refresh') return handleConnectorRefresh(req, res);
  if (req.method === 'POST' && req.url === '/api/skills/toggle') return handleSkillToggle(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/skills') === 0) return serveSkills(req, res);
  if (req.method === 'POST' && req.url === '/api/spotify/auth/start') return handleSpotifyStart(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/spotify/callback') === 0) return handleSpotifyCallback(req, res);
  if (req.method === 'GET' && req.url === '/api/spotify/status') return handleSpotifyStatus(req, res);
  if (req.method === 'POST' && req.url === '/api/spotify/disconnect') return handleSpotifyDisconnect(req, res);
  if (req.method === 'GET' && req.url === '/api/cron') return handleCronList(req, res);
  if (req.method === 'POST' && req.url === '/api/cron') return handleCronCreate(req, res);
  if (req.method === 'POST' && req.url === '/api/cron/update') return handleCronUpdate(req, res);
  if (req.method === 'POST' && req.url === '/api/cron/remove') return handleCronRemove(req, res);
  if (req.method === 'POST' && req.url === '/api/cron/preview') return handleCronPreview(req, res);
  if (req.method === 'POST' && req.url === '/api/cron/arm') return handleCronArm(req, res);
  if (req.method === 'POST' && req.url === '/api/cron/run') return handleCronRun(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/checkpoint/restore') return handleCheckpointRestore(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/checkpoint') === 0) return handleCheckpointList(req, res);
  if (req.method === 'GET' && req.url === '/api/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' && req.url === '/api/execution') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(executionEnvironment.describe())); }
  if (req.method === 'GET' && req.url.indexOf('/api/subagents') === 0) return handleSubagentsList(req, res);
  if (req.method === 'POST' && req.url === '/api/subagents/interrupt') return handleSubagentInterrupt(req, res);
  // honest concurrency surface: how many distinct agents can RUN at once (the gate that silently 'refuses'
  // excess parallel workers). The summon bay reads this so the ceiling is visible BEFORE a fan-out, not only
  // inside the model's tool result. (WIRING_AUDIT P4: lie #7.)
  if (req.method === 'GET' && req.url === '/api/limits') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ maxConcurrentAgents: concurrencyGate.max() })); }
  if ((req.method === 'GET' || req.method === 'HEAD') && req.url.indexOf('/api/file') === 0) return serveWorkspaceFile(req, res);
  if (req.method === 'POST' && req.url === '/api/notebook/restore') return handleNotebookRestore(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/notebook') === 0) return serveNotebook(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/save') === 0) return serveSaveLoad(req, res);
  if (req.method === 'POST' && req.url === '/api/save') return handleSaveWrite(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/insights') === 0) return serveInsights(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/runs') === 0) return serveRuns(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/transcript') === 0) return serveTranscript(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/memory/proposals') === 0) return serveProposals(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/turnin') return handleMemoryTurnin(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/memory/records') === 0) return serveMemoryRecords(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/pin') return handleMemoryPin(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/edit') return handleMemoryEdit(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/forget') return handleMemoryForget(req, res);
  return serveStatic(req, res);
});
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') console.error('✗ Port ' + PORT + ' is already in use (another sidecar already running?). Stop it, or set STARNET_PORT=<n> and retry.');
  else if (e && e.code === 'EACCES') console.error('✗ Port ' + PORT + ' needs elevated privileges — pick a port >= 1024 via STARNET_PORT.');
  else console.error('✗ sidecar listen error:', e);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + PORT;
  const bar = '═'.repeat(58);
  console.log('\n' + bar);
  console.log('  ▲ STARNET — THE FULL APP IS RUNNING (UI + agent engine).');
  console.log('     Open in your browser:  ' + url);
  console.log('     This one process IS the complete product — the UI you see and');
  console.log('     the agents/web-search/tools behind it are all served from here.');
  if (DEV_MODE) console.log('     ⚡ DEV SEED MODE — onboarding auto-skipped; the page resumes the seeded agent.');
  console.log(bar + '\n');
  // warm the key-independent /models catalog once so priceOf / contextLimit are live for every run
  makeOpenRouterProvider({ fetch: globalThis.fetch, baseUrl: OPENROUTER_BASE }).listModels().then(
    ms => { if (ms && ms.length) console.log('  · model catalog warmed (' + ms.length + ' models)'); },
    () => {}
  );
  // auto-start a previously-connected Telegram bot (saved config), else an env-provided one (headless deploys).
  try {
    const t = (channelSecrets && channelSecrets.telegram) || {};
    const envTok = String(ENV('TELEGRAM_TOKEN') || '').trim();
    const envKey = String(ENV('OPENROUTER_KEY') || '').trim();
    const envModel = String(ENV('DEFAULT_MODEL') || '').trim();
    if (t.enabled && t.token && t.model && (providerUsesCodex(t.provider) || t.key || runtimeKey)) { startTelegram(t.token, t.key || '', t.model, { agentId: t.agentId, system: t.system, name: t.name, provider: t.provider, reasoningEffort: t.reasoningEffort }); console.log('  · telegram auto-started from saved config'); }
    else if (envTok && envKey && envModel) { startTelegram(envTok, envKey, envModel, {}); console.log('  · telegram auto-started from env'); }
  } catch (e) { console.warn('[channels] telegram auto-start failed:', (e && e.message) || e); }
  // H6.2: same auto-start for Discord (saved config else env), through the generic registry path.
  try {
    const d = (channelSecrets && channelSecrets.discord) || {};
    const envTok = String(ENV('DISCORD_TOKEN') || '').trim();
    const envKey = String(ENV('OPENROUTER_KEY') || '').trim();
    const envModel = String(ENV('DEFAULT_MODEL') || '').trim();
    if (d.enabled && d.token && d.model && (providerUsesCodex(d.provider) || d.key || runtimeKey)) { startDiscord(d.token, d.key || '', d.model, { agentId: d.agentId, system: d.system, name: d.name, provider: d.provider }); console.log('  · discord auto-started from saved config'); }
    else if (envTok && envKey && envModel) { startDiscord(envTok, envKey, envModel, {}); console.log('  · discord auto-started from env'); }
  } catch (e) { console.warn('[channels] discord auto-start failed:', (e && e.message) || e); }
  // warm every configured+enabled connector so its tools are ready on the first run (fire-and-forget; a
  // connector that is down/errors simply projects no tools — it never blocks the host or a run).
  try {
    for (const c of connectorConfigs) { if (c && c.enabled !== false && (c.url || c.command)) connectors.configure(c.id, c).catch(() => {}); }
    if (connectorConfigs.length) console.log('  · ' + connectorConfigs.length + ' MCP connector(s) warming');
  } catch (e) { console.warn('[connectors] warm failed:', (e && e.message) || e); }
  // cron (OPT-IN): the scheduler arms iff SKYNET_CRON_ENABLED OR the persisted runtime cronArmed flag is set
  // (G4.6 — `cronArmed` is that OR, computed at the store). armCron() RESUMES by running ONE immediate reconcile
  // tick — catching up any fires missed while the host was down (at-most-one within grace, else fast-forward+
  // skip; never a backlog) — BEFORE arming the interval. Inert when off: no timer, no fire, the browser path is
  // byte-identical for a user who never enables cron (no env var, no cron.armed.json -> cronArmed=false).
  try {
    if (cronArmed) armCron();
  } catch (e) { console.warn('[cron] start failed:', (e && e.message) || e); }
});

/* ---- SSE bridge: forward validated channel/work-item telemetry to the live station HUD ---- */
function handleChannelEvents(req, res) {
  // SSE can't carry a custom header (EventSource), so the live HUD passes the token as ?token=… instead.
  if (!apiauth.queryTokenOk(req, API_TOKEN)) { res.writeHead(403); return res.end('forbidden token'); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  try { res.write('retry: 3000\n\n'); } catch (_) {}        // EventSource auto-reconnects after 3s if dropped
  sse.add(res);
  const done = () => { clearInterval(ka); sse.remove(res); };   // evict on disconnect — mirrors /api/run cleanup; idempotent
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) { done(); } }, 25000);   // keep-alive; self-evicts on write failure
  req.on('close', done); req.on('aborted', done); res.on('error', done);
}

/* ---- POST /api/routing: the app posts its compiled RoutingPlan on every floor change; the router stores
   it (or REFUSES a non-deployable one), and from then on the floor decides which agent each inbound runs. ---- */
function handleRouting(req, res) {
  readBody(req, 1 << 20).then(raw => {
    let plan = null;
    if (raw && raw.trim()) { try { plan = JSON.parse(raw); } catch (_) { res.writeHead(400); return res.end('bad json'); } }
    const r = router.setPlan(plan);
    res.writeHead(r.ok ? 200 : 422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }).catch(() => { try { res.writeHead(400); res.end(); } catch (_) {} });
}

/* ---- GET /api/budget/status — the live spend pools (day + global) vs their caps, plus session resume headroom.
   Read-only; safe to poll for the budget HUD. The ledger + in-flight tallies back it, so it survives restarts. ---- */
function handleBudgetStatus(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(Object.assign({ perRun: BUDGET_CAPS.perRun, totalUsd: ledger.totalUsd(), runs: ledger.count() }, budget.status(Date.now()))));
}
function handleApiSession(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: true }));
}
/* ---- POST /api/budget/resume { scope } — the one-click "keep going" after a SOFT pool cap is hit: grant another
   base-cap of headroom to that scope for the rest of the session. scope ∈ {day, global}. ---- */
async function handleBudgetResume(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const scope = String(body.scope || '').trim();
  if (scope !== 'day' && scope !== 'global') return json(400, { error: 'scope must be "day" or "global"' });
  const cap = budget.resume(scope);
  if (cap == null) return json(409, { error: 'that budget scope is not governed (no cap set)' });
  json(200, { resumed: scope, cap, status: budget.status(Date.now()) });
}

/* desktop key push: the parent shell sets the live BYOK key here (token-gated), so changing the
   key never restarts the sidecar. SKYNET_IPC_TOKEN is a per-launch secret only the shell knows. */
async function handleSetKey(req, res) {
  const token = String(ENV('IPC_TOKEN') || '');
  if (!token || (req.headers['x-starnet-token'] || req.headers['x-skynet-token']) !== token) { res.writeHead(403); return res.end('forbidden'); }
  try { runtimeKey = String(await readBody(req, 1 << 14) || '').trim(); } catch (_) {}
  res.writeHead(200); return res.end('ok');
}

/* ---- /api/connectors: the Connectors panel manages MCP servers. A token is accepted here, persisted to the
   protected sibling file, and NEVER echoed back (list/status carry `hasToken` only, never the value). ---- */
function handleConnectorsList(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ connectors: connectors.list() }));
}
async function handleConnectorUpsert(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const id = String(body.id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return json(400, { error: 'connector id must be 1-40 chars of [A-Za-z0-9_-]' });
  const prev = connectorConfigs.find(c => c.id === id) || {};
  const transport = String(body.transport || prev.transport || (body.command ? 'stdio' : 'http')).toLowerCase();
  if (transport !== 'http' && transport !== 'stdio') return json(400, { error: 'connector transport must be "http" or "stdio"' });
  const url = String(body.url || (transport === 'http' ? (prev.url || '') : '')).trim();
  const command = String(body.command || (transport === 'stdio' ? (prev.command || '') : '')).trim();
  if (transport === 'http' && !url) return json(400, { error: 'a server URL is required' });
  if (transport === 'stdio' && !command) return json(400, { error: 'a stdio command is required' });
  let args = Array.isArray(prev.args) ? prev.args.slice() : [];
  if ('args' in body) {
    if (!Array.isArray(body.args)) return json(400, { error: 'stdio args must be an array' });
    args = body.args.map(a => String(a == null ? '' : a));
  }
  let env = (prev.env && typeof prev.env === 'object') ? Object.assign({}, prev.env) : {};
  if ('env' in body) {
    if (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)) return json(400, { error: 'stdio env must be an object' });
    env = {};
    for (const k of Object.keys(body.env)) env[k] = String(body.env[k] == null ? '' : body.env[k]);
  }
  const cfg = {
    id: id,
    transport: transport,
    url: transport === 'http' ? url : '',
    token: transport === 'http' ? (('token' in body && body.token !== '') ? String(body.token) : (prev.token || '')) : '',   // a blank token keeps the saved one for HTTP only
    command: transport === 'stdio' ? command : '',
    args: transport === 'stdio' ? args : [],
    cwd: transport === 'stdio' ? String(body.cwd || prev.cwd || '') : '',
    env: transport === 'stdio' ? env : {},
    label: String(body.label || prev.label || id),
    enabled: body.enabled !== false
  };
  connectorConfigs = connectorConfigs.filter(c => c.id !== id).concat([cfg]);
  saveConnectorConfigs();
  let result; try { result = await connectors.configure(id, cfg); } catch (e) { result = { ok: false, state: 'error', error: (e && e.message) || 'configure failed' }; }
  json(result.ok ? 200 : 502, Object.assign({ status: connectors.status(id) }, result));
}
async function handleConnectorRemove(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const id = String(body.id || '').trim();
  connectorConfigs = connectorConfigs.filter(c => c.id !== id);
  saveConnectorConfigs();
  await connectors.remove(id);
  json(200, { ok: true });
}
async function handleConnectorRefresh(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const id = String(body.id || '').trim();
  let result; try { result = await connectors.refresh(id); } catch (e) { result = { ok: false, state: 'error', error: (e && e.message) || 'refresh failed' }; }
  json(200, Object.assign({ status: connectors.status(id) }, result));
}

/* ---- /api/spotify: OAuth 2.0 Authorization-Code-with-PKCE for the JUKEBOX skill. NO client secret is ever
   stored (that's the point of PKCE). The user creates a Spotify app at developer.spotify.com, whitelists the
   redirect URI (SPOTIFY_REDIRECT) verbatim, and provides its Client ID once; /start opens the consent page,
   the browser returns to /callback, we exchange the code for tokens and persist the refresh token. The callback
   is intentionally UNGUARDED — Spotify's redirect (the browser) hits it, not the app. 127.0.0.1-bound. ---- */
function spotifyJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function spotifyEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function spotifyHtml(res, code, title, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><meta charset=utf-8><title>' + spotifyEsc(title) + '</title>' +
    '<body style="font:16px/1.5 system-ui,sans-serif;background:#0b0f14;color:#bfe8d4;display:grid;place-items:center;height:90vh;text-align:center">' +
    '<div><h2 style="margin:.2em 0">' + spotifyEsc(title) + '</h2><p>' + spotifyEsc(body) + '</p>' +
    '<p style="opacity:.55;font-size:.9em">You can close this window and return to StarNet.</p></div>');
}

async function handleSpotifyStart(req, res) {
  let body = {}; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (_) {}
  let clientId = String(body.clientId || '').trim();
  if (clientId) { try { await spotifyStore.setClientId(clientId); } catch (_) {} }
  else { try { clientId = (await spotifyStore.getClientId()) || ''; } catch (_) {} }
  if (!clientId) clientId = String(ENV('SPOTIFY_CLIENT_ID') || '').trim();
  if (!clientId) return spotifyJson(res, 400, { error: 'A Spotify Client ID is required. Create an app at https://developer.spotify.com/dashboard, add the redirect URI ' + SPOTIFY_REDIRECT + ' to it, then send its Client ID.', redirectUri: SPOTIFY_REDIRECT });
  // prune stale pending states (> 10 min) so the map can't grow unbounded
  const cutoff = Date.now() - 600000;
  for (const [k, v] of spotifyPending) if (!v || v.at < cutoff) spotifyPending.delete(k);
  const verifier = spotifyPkce.makeVerifier(crypto.randomBytes(48));
  const challenge = spotifyPkce.challengeOf(verifier);
  const state = crypto.randomBytes(16).toString('hex');
  spotifyPending.set(state, { verifier, clientId, redirectUri: SPOTIFY_REDIRECT, at: Date.now() });
  const scope = Array.isArray(body.scope) ? body.scope : (body.scope ? String(body.scope).split(/\s+/) : undefined);
  const url = spotifyPkce.authorizeUrl({ clientId, redirectUri: SPOTIFY_REDIRECT, challenge, state, scope });
  spotifyJson(res, 200, { url, redirectUri: SPOTIFY_REDIRECT });
}

async function handleSpotifyCallback(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const err = u.searchParams.get('error');
  if (err) return spotifyHtml(res, 400, 'Spotify connection cancelled', err);
  const code = u.searchParams.get('code') || '';
  const state = u.searchParams.get('state') || '';
  const pending = spotifyPending.get(state);
  spotifyPending.delete(state);
  if (!code || !pending) return spotifyHtml(res, 400, 'Link expired', 'That sign-in link is no longer valid — start again from StarNet Settings.');
  try {
    const r = await globalThis.fetch(spotifyPkce.TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: spotifyPkce.tokenExchangeBody({ code, redirectUri: pending.redirectUri, clientId: pending.clientId, verifier: pending.verifier })
    });
    const json = await r.json().catch(() => null);
    if (!r.ok || !json || !json.access_token) {
      const m = (json && (json.error_description || json.error)) || ('HTTP ' + r.status);
      return spotifyHtml(res, 502, 'Spotify connection failed', typeof m === 'string' ? m : JSON.stringify(m));
    }
    await spotifyStore.setClientId(pending.clientId);
    await spotifyStore.setTokens(spotifyPkce.tokensFromResponse(json, Date.now(), ''));
    spotifyHtml(res, 200, '✓ Spotify connected', 'Your agents can now search and control your Spotify.');
  } catch (e) {
    spotifyHtml(res, 502, 'Spotify connection failed', (e && e.message) || 'unknown error');
  }
}

async function handleSpotifyStatus(req, res) {
  let st; try { st = await spotifyStore.status(); } catch (_) { st = { connected: false, hasClientId: false, scope: '', expiresAt: 0 }; }
  spotifyJson(res, 200, Object.assign({}, st, { redirectUri: SPOTIFY_REDIRECT }));
}

async function handleSpotifyDisconnect(req, res) {
  let st; try { st = await spotifyStore.clear(); } catch (_) { st = { connected: false }; }
  spotifyJson(res, 200, Object.assign({ ok: true }, st));
}

/* ----------------------------- /api/cron: the ROUTINES CRUD + preview + run-now -----------------------------
   The job DEFINITIONS are server-owned (the schedule + the boot-frozen secrets, never on the bus, §3.7) so the
   panel is a thin CRUD client over these routes — render from GET, mutate via POST, re-fetch. The pure store
   reducers (cron-store.js) own the record math; these handlers are the ambient glue (parse a schedule string,
   mint an id, persist via the throwing saveCronJobs so a failed write surfaces as a 500). A persisted CronJob
   never embeds the API key — a fire pulls it from runtimeKey at run time. Schedule strings are parsed with the
   injected wall clock; interval, once, ISO, and deterministic 5-field cron schedules are accepted only when
   the pure scheduler can compute their next fire. 127.0.0.1-bound like every other route. */

// parse a user-supplied schedule string into a stored schedule, or throw a 400-able Error. Rejects an
// unparseable string (including impossible cron dates, AND an invalid IANA tz) before it can be persisted —
// a typo'd tz fails the parse rather than silently firing on UTC (G4.1).
function parseCronScheduleOr400(str, now, tz) {
  const opts = (tz != null && tz !== '') ? { tz: String(tz) } : undefined;
  const sched = cron.parseSchedule(String(str == null ? '' : str), now, opts);
  if (!sched) {
    const why = (opts && !cron.isValidTz(opts.tz))
      ? ('unknown timezone "' + opts.tz + '" — use an IANA zone like America/New_York')
      : "couldn't read that schedule — try \"every 30m\", \"in 2h\", \"0 9 * * *\", or an ISO timestamp like 2026-07-01T09:00";
    const e = new Error(why); e.code = 400; throw e;
  }
  return sched;
}
function parseCronAgentIdOr400(value) {
  const id = String(value == null || value === '' ? 'agent' : value).trim();
  if (!cronStore.isValidId(id)) { const e = new Error('agent must be one of your station agents'); e.code = 400; throw e; }
  return id;
}
function parseCronProviderOr400(value) {
  if (value == null || value === '') return null;
  const p = normalizeProviderId(value);
  if (!p) { const e = new Error('provider must be openrouter or codex'); e.code = 400; throw e; }
  return p;
}

// GET /api/cron — the job snapshot the panel renders from (no secrets in a CronJob). `enabled` = is the tick
// driver actually armed (the LIVE cronArmed = SKYNET_CRON_ENABLED OR the persisted runtime flag, G4.6) so the
// panel can honestly say whether routines will fire — and reflects a runtime arm/disarm WITHOUT a restart.
function handleCronList(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ jobs: cronJobs, enabled: cronArmed, tickMs: CRON_TICK_MS }));
}

// POST /api/cron/arm — runtime one-click ENABLE/DISABLE of the scheduler (G4.6). body: { enabled:bool }.
// Privileged: this route is behind the SAME x-starnet-token gate as the cron CRUD routes (rejectBadApiToken
// runs before dispatch for private /api/* routes; /api/key has its own desktop IPC token), so a browser-driven
// cross-site call can't arm the autonomous scheduler. It (a) PERSISTS the cronArmed flag durably and (b)
// ACTUALLY arms/disarms the live timer NOW — arming fires a due job within ONE tick with no restart; the
// honest GET /api/cron `enabled` flips immediately. We do NOT touch process.env (the boot-frozen gate stays
// truthful); the persisted flag is the durable record OR'd at the next boot.
function handleCronArm(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  readBody(req, 4096).then(raw => {
    let body; try { body = JSON.parse(raw) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
    if (typeof body.enabled !== 'boolean') return json(400, { error: 'enabled (boolean) is required' });
    const want = body.enabled;
    try { saveCronArmed(want); }                       // durable persist FIRST so a crash can't drop the user's intent
    catch (e) { return json(500, { error: 'could not persist the arm flag: ' + ((e && e.message) || e) }); }
    cronArmed = want;                                  // live in-memory state (GET /api/cron reflects this)
    if (want) armCron(); else disarmCron();            // start/stop the live tick NOW — a due job fires within one tick
    json(200, { ok: true, enabled: cronArmed, tickMs: CRON_TICK_MS });
  }).catch(() => { try { json(400, { error: 'bad request' }); } catch (_) {} });
}

// POST /api/cron — create a routine. body: { name, prompt, schedule:<string>, agentId?, model?, provider?, deliver?, enabled?, repeat? }
function handleCronCreate(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  readBody(req, 1 << 16).then(raw => {
    let body; try { body = JSON.parse(raw) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
    let schedule; try { schedule = parseCronScheduleOr400(body.schedule, Date.now()); } catch (e) { return json(e.code || 400, { error: e.message }); }
    let agentId; try { agentId = parseCronAgentIdOr400(body.agentId); } catch (e) { return json(e.code || 400, { error: e.message }); }
    let provider; try { provider = parseCronProviderOr400(body.provider); } catch (e) { return json(e.code || 400, { error: e.message }); }
    const id = crypto.randomUUID();
    try {
      // G4.3: re-read-modify-write UNDER the cron lock so a concurrent advance/CRUD save is not clobbered.
      withCronWrite(jobs => cronStore.createJob(jobs, {
        id: id, name: body.name, prompt: body.prompt, schedule: schedule,
        agentId: agentId, model: body.model, provider: provider, deliver: body.deliver,
        enabled: body.enabled, repeat: body.repeat
      }, { id: id, now: Date.now() }));
    } catch (e) { return json(500, { error: 'could not save the routine: ' + ((e && e.message) || e) }); }
    json(200, { ok: true, job: cronStore.getJob(cronJobs, id) });
  }).catch(() => { try { json(400, { error: 'bad request' }); } catch (_) {} });
}

// POST /api/cron/update — edit fields + pause/resume (folded via an `enabled` flag in the patch). body: { id, patch }
function handleCronUpdate(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  readBody(req, 1 << 16).then(raw => {
    let body; try { body = JSON.parse(raw) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
    const id = String(body.id || '');
    if (!cronStore.getJob(cronJobs, id)) return json(404, { error: 'no such routine' });
    const patch = Object.assign({}, body.patch || {});
    if (Object.prototype.hasOwnProperty.call(patch, 'schedule')) {
      try { patch.schedule = parseCronScheduleOr400(patch.schedule, Date.now()); } catch (e) { return json(e.code || 400, { error: e.message }); }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'agentId')) {
      try { patch.agentId = parseCronAgentIdOr400(patch.agentId); } catch (e) { return json(e.code || 400, { error: e.message }); }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'provider')) {
      try { patch.provider = parseCronProviderOr400(patch.provider); } catch (e) { return json(e.code || 400, { error: e.message }); }
    }
    // pause/resume is not an EDITABLE field on updateJob — pull it out and apply via the dedicated reducers.
    let enabled; if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) { enabled = patch.enabled !== false; delete patch.enabled; }
    try {
      // G4.3: the full edit (updateJob + optional pause/resume) is ONE re-read-modify-write under the lock,
      // so it cannot clobber a concurrent advance and the pause/resume sees the just-updated job.
      withCronWrite(jobs => {
        let next = cronStore.updateJob(jobs, id, patch, { now: Date.now() });
        if (enabled === true) next = cronStore.resumeJob(next, id, { now: Date.now() });
        else if (enabled === false) next = cronStore.pauseJob(next, id);
        return next;
      });
    } catch (e) { return json(500, { error: 'could not save: ' + ((e && e.message) || e) }); }
    json(200, { ok: true, job: cronStore.getJob(cronJobs, id) });
  }).catch(() => { try { json(400, { error: 'bad request' }); } catch (_) {} });
}

// POST /api/cron/remove — delete a routine. body: { id }
function handleCronRemove(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  readBody(req, 4096).then(raw => {
    let body; try { body = JSON.parse(raw) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
    const id = String(body.id || '');
    try { withCronWrite(jobs => cronStore.removeJob(jobs, id)); }   // G4.3: re-read-modify-write under the lock
    catch (e) { return json(500, { error: 'could not save: ' + ((e && e.message) || e) }); }
    json(200, { ok: true });
  }).catch(() => { try { json(400, { error: 'bad request' }); } catch (_) {} });
}

// POST /api/cron/preview — validate a schedule string + return the next up-to-5 fire times (the injected clock,
// never bare Date.now in the math). Net-new GUI value Hermes lacks entirely. A tz-less cron schedule previews
// (and fires) on the host's LOCAL wall-clock (CRON_HOST_TZ); the response carries the resolved tz + a
// human-readable LOCAL time per fire (e.g. "9:00 AM EDT") so the GUI shows when a routine actually runs (G4.1).
// body: { schedule:<string>, tz?:<IANA string> }
function handleCronPreview(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  readBody(req, 4096).then(raw => {
    let body; try { body = JSON.parse(raw) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
    const now = Date.now();
    let sched; try { sched = parseCronScheduleOr400(body.schedule, now, body.tz); } catch (e) { return json(e.code || 400, { ok: false, error: e.message }); }
    // a cron schedule resolves under its own tz, else the host tz; interval/once are absolute-ms (UTC display).
    const tz = sched.kind === 'cron' ? cron._internals.tzFor(sched, CRON_HOST_TZ) : 'UTC';
    const localFmt = (ms) => {
      try {
        return new Intl.DateTimeFormat('en-US', {
          timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
          weekday: 'short', month: 'short', day: 'numeric', timeZoneName: 'short'
        }).format(ms);
      } catch (_) { return cron._internals.iso(ms); }
    };
    const next = [], localNext = [];
    let t = cron.nextFireAt(sched, null, now, { defaultTz: CRON_HOST_TZ });
    for (let i = 0; i < 5 && t != null && !isNaN(t); i++) {
      next.push(cron._internals.iso(t));
      localNext.push(localFmt(t));
      if (sched.kind === 'once') break;                                 // a one-shot has exactly one fire
      t = cron.nextFireAt(sched, cron._internals.iso(t), t, { defaultTz: CRON_HOST_TZ });   // advance one period
    }
    json(200, { ok: true, kind: sched.kind, display: sched.display, tz: tz, next: next, localNext: localNext });
  }).catch(() => { try { json(400, { error: 'bad request' }); } catch (_) {} });
}

/* POST /api/cron/run — run a routine NOW, streamed as NDJSON exactly like /api/run (strictly better than Hermes,
   whose `cron run` only nudges next_run_at). The manual fire uses the SAME autonomous posture the scheduled fire
   will (surface:'autonomous', trigger:'schedule') so "test it now" exercises the real unattended path, and it
   records the outcome into the job's last-run record + emits cron.fire/cron.result to the HUD. body: { id } */
async function handleCronRun(req, res) {
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { res.writeHead(400); return res.end('bad json'); }
  const job = cronStore.getJob(cronJobs, String(body.id || ''));
  if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'no such routine' })); }
  const model = cronModelFor(job);
  const provider = cronProviderFor(job);
  const key = cronKeyFor(provider);
  if (!model || !cronHasCredential(provider, key)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: (!model ? 'choose a model for this routine agent first' : cronCredentialError(provider)) }));
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const ac = new AbortController();
  const runId = crypto.randomUUID();
  runs.set(runId, ac);
  req.on('close', () => { ac.abort(); runs.delete(runId); });
  const bus = { emit: (name, payload) => { try { res.write(JSON.stringify({ name, payload: redact(payload) }) + '\n'); } catch (_) {} } };
  const emit = makeEmitter(bus, e => { if (e && e.event !== 'tool.web') console.warn('[event]', e.kind, e.event, (e.errors || []).join(';')); });
  // tee: stream every event to the watching browser AND capture the outcome so the last-run record is honest.
  const state = { buf: '', errMsg: null, reason: null, transient: false };
  const teeEmit = (name, payload) => {
    try { emit(name, payload); } catch (_) {}
    const p = payload || {};
    if (name === 'agent.token') state.buf += (p.delta || '');
    else if (name === 'agent.run.error') { state.errMsg = p.message || 'run error'; state.transient = !!p.transient; }
    else if (name === 'agent.run.end') state.reason = p.reason;
  };
  try { cronEmit('cron.fire', { jobId: job.id, runId: runId, scheduledFor: Date.now() }); } catch (_) {}
  placeCronWorkitem(job.agentId, job.prompt);
  try {
    await runOnce({
      key: key, model: model, system: cronSystemFor(job.agentId), messages: [{ role: 'user', content: String(job.prompt || '') }],
      agentId: job.agentId, isTask: true, emit: teeEmit, signal: ac.signal,
      runId: runId, surface: 'autonomous', trigger: 'schedule', provider: provider, broadcast: true
    });
  } catch (e) {
    state.errMsg = state.errMsg || ('sidecar failure: ' + ((e && e.message) || e));
    try { emit('agent.run.error', { agentId: job.agentId, runId: runId, message: state.errMsg, transient: false }); } catch (_) {}
  } finally {
    runs.delete(runId);
    const ok = !state.errMsg;
    try {
      // G4.3: record the manual run's outcome as a re-read-modify-write under the lock (don't clobber a
      // concurrent advance/CRUD save with a stale in-memory snapshot).
      withCronWrite(jobs => cronStore.markRun(jobs, job.id, { runId: runId, status: ok ? 'ok' : 'error', reason: state.reason || (ok ? 'done' : 'error'), error: state.errMsg || undefined, transient: state.transient }, { now: Date.now() }));
    } catch (_) {}
    try { cronEmit('cron.result', { jobId: job.id, runId: runId, outcome: !ok ? 'failed' : ((state.buf || '').trim() === '[SILENT]' ? 'silent' : 'ok'), reason: state.reason || (ok ? 'done' : 'error') }); } catch (_) {}
    try { res.end(); } catch (_) {}
  }
}

/* POST /api/checkpoint/restore { agentId, snapshotId } — the manual "rewind": hard-reset an agent's workspace to
   a recorded snapshot (and drop files created since). Only restores a snapshotId IN that agent's index (never an
   arbitrary git ref); 127.0.0.1-bound. The auto-snapshots that feed this come from the opt-in dispatch hook. */
async function handleCheckpointRestore(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const agentId = String(body.agentId || '');
  const snapshotId = String(body.snapshotId || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(400, { error: 'bad agentId' });
  if (!checkpointStore.isValidId(snapshotId)) return json(400, { error: 'bad snapshotId' });
  let ok; try { ok = await checkpointStore.restore(agentId, snapshotId); } catch (e) { return json(500, { error: 'restore failed: ' + ((e && e.message) || e) }); }
  if (!ok) return json(404, { error: 'no such snapshot for that agent' });
  try { checkpointEmit('checkpoint.restored', { agentId: agentId, runId: '', toSnapshotId: snapshotId, reason: 'manual' }); } catch (_) {}
  json(200, { ok: true });
}

// GET /api/checkpoint?agent=<id> — the read-only snapshot index a "rewind" affordance lists from.
function handleCheckpointList(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(400, { error: 'bad agentId' });
    json(200, { enabled: CHECKPOINTS_ENABLED, snapshots: checkpointStore.list(agent).snapshots });
  } catch (e) { json(200, { enabled: CHECKPOINTS_ENABLED, snapshots: [] }); }
}

// POST /api/roster { agents:[{ agentId, system, name, model, provider }] } — the browser pushes the live crew identities
// so team.dispatch can run a WORKER as itself (its composed system prompt + model/provider). Replaces the whole roster
// each push (the browser sends the full live set on summon/focus). Contract-free: plain HTTP, no bus event.
function handleSubagentsList(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const id = u.searchParams.get('id');
    if (id) {
      const rec = subagents.get(id);
      return json(rec ? 200 : 404, rec || { error: 'not found' });
    }
    json(200, { records: subagents.list({ leadId: u.searchParams.get('leadId') || undefined, agentId: u.searchParams.get('agentId') || undefined, status: u.searchParams.get('status') || undefined }) });
  } catch (e) { json(500, { error: 'subagents list failed' }); }
}

async function handleSubagentInterrupt(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  try { json(200, subagents.interrupt(String(body.id || ''), body.leadId ? String(body.leadId) : undefined)); }
  catch (e) { json(400, { ok: false, error: (e && e.message) || String(e) }); }
}

async function handleRoster(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 2 << 20)); }
  catch (e) { res.writeHead(400); return res.end('bad json'); }
  const list = (body && Array.isArray(body.agents)) ? body.agents : [];
  replaceAgentRoster(list);
  saveAgentRoster();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, count: agentRoster.size }));
}

// POST /api/dossier { block } — the browser pushes the composed Commander-dossier block whenever it changes,
// so server-composed autonomous runs (cron) can fold in who they work for. Contract-free: plain HTTP, no bus
// event. An empty block clears it (the user turned the dossier off / forgot everything).
async function handleDossier(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 1 << 16)); }
  catch (e) { res.writeHead(400); return res.end('bad json'); }
  commanderDossier.set(body && body.block);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, chars: commanderDossier.get().length }));
}

// GET /api/skills?placed=cabinet,workbench — the bundled recipe library + per-workstation flags for the SKILLS
// panel. `placed` (the selected agent's real floor objects, from World.heroCaps) drives the available/locked
// readout; the enabled flag is the station-wide choice. Bodies are included so the panel can expand without a
// second fetch (what the user reads == what the run is told — no divergence).
function serveSkills(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const placedTypes = String(u.searchParams.get('placed') || '').split(',').map(s => s.trim()).filter(Boolean);
    json(200, { skills: skillsCatalog.catalog(SKILL_LIBRARY, { overrides: skillPrefs.overrides(), placedTypes: placedTypes }) });
  } catch (e) { json(200, { skills: [] }); }
}
// POST /api/skills/toggle { slug, enabled } — persist a station-wide enable/disable choice for a library recipe.
// Station-wide by design: per-AGENT reach stays the capability gate (the placed objects), not a per-agent toggle.
async function handleSkillToggle(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const slug = String(body.slug || '').trim();
  if (!slug) return json(400, { error: 'slug required' });
  const r = skillPrefs.set(slug, !!body.enabled);
  if (!r.ok) return json(400, { error: r.error || 'could not save' });
  json(200, { ok: true, slug: r.slug, enabled: r.enabled });
}

/* ------------------------------- the run endpoint ------------------------------- */
async function handleRun(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 2 << 20)); }
  catch (e) { res.writeHead(400); return res.end('bad json'); }
  const { model, system, messages = [], agentId = 'agent', isTask = false, provider, fallbackModels } = body || {};
  const runProvider = normalizeProvider(provider);
  const reasoningEffort = resolveReasoningEffort(runProvider, body && (body.reasoningEffort || body.reasoning_effort || (body.reasoning && body.reasoning.effort)));
  const streamId = (body && body.streamId && /^[A-Za-z0-9_-]{1,64}$/.test(String(body.streamId))) ? String(body.streamId) : null;   // M-mem.2b: the active workstream (bounded; bad → global)
  // THE MOAT (FLOOR-REAL): the browser sends the agent's REAL placed capability objects (World.heroCaps) so this
  // interactive run grants exactly what's ON THE FLOOR — additive on top of the compute-only interactive office
  // (see runOnce). dish→web · cabinet→files · workbench→terminal · notebook→memory · studio→image · jukebox→spotify.
  // A placed WORKBENCH still walks the full consent ladder + auto-checkpoints before every command. Legacy clients
  // send just `workbench:true`; that path is preserved so an older build still grants the terminal.
  let extraObjects = [];
  if (body && Array.isArray(body.placed)) {
    extraObjects = body.placed
      .filter(e => e && (typeof e === 'string' || e.objectType))
      .map((e, i) => {
        const ot = String(typeof e === 'string' ? e : e.objectType);
        const ob = { instanceId: 'placed_' + i + '_' + ot, objectType: ot };
        if (e && typeof e === 'object' && e.connectorId) ob.connectorId = e.connectorId;
        return ob;
      });
  } else if (body && body.workbench) {
    extraObjects = [{ instanceId: 'wb_placed', objectType: 'workbench' }];
  }
  const usingCodex = (provider === 'codex' || provider === 'openai-codex');   // Codex authenticates by OAuth token, not an API key
  // Desktop build: the key lives in runtimeKey (from the keychain, seeded via env at spawn and updatable
  // via /api/key). The browser build still sends body.key, which wins.
  const key = String((body && body.key) || '').trim() || runtimeKey;
  if (!model || (!key && !usingCodex)) { res.writeHead(400); return res.end('missing key/model'); }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  });

  const ac = new AbortController();
  const runId = crypto.randomUUID();
  runs.set(runId, ac);
  const pending = new Map();          // promptId -> finish(decision); the consent prompts awaiting a human
  pendingByRun.set(runId, pending);
  const pendingSummon = new Map();    // requestId -> finish(newAgentId|null); the team.summon requests awaiting the browser
  pendingSummonByRun.set(runId, pendingSummon);
  req.on('close', () => { ac.abort(); runs.delete(runId); });   // tab closed / DISCONNECT → stop spend

  // the "bus" writes one validated, REDACTED NDJSON line per event (key-shaped secrets are scrubbed even
  // if a tool ever echoes one back); makeEmitter validates against the frozen registry first.
  const bus = { emit: (name, payload) => { try { res.write(JSON.stringify({ name, payload: redact(payload) }) + '\n'); } catch (_) {} } };
  const emit = makeEmitter(bus, e => { if (e && e.event !== 'tool.web') console.warn('[event]', e.kind, e.event, (e.errors || []).join(';')); });

  // THE LIVE CONSENT CHANNEL: emit a permission.prompt down the NDJSON stream and return a Promise that the loop's
  // dispatch await-pauses on. The browser answers via POST /api/consent (handleConsent), which calls the stored
  // finisher. Fail-closed safety: a disconnect (ac abort) or a CONSENT_TIMEOUT_MS stall auto-DENIES so a forgotten
  // prompt can never hold a billable run open. Settles exactly once.
  function promptConsent(call, tool) {
    return new Promise((resolve) => {
      const promptId = crypto.randomUUID();
      let settled = false, timer = null;
      function onAbort() { finish('deny'); }
      function finish(decision) {
        if (settled) return; settled = true;
        pending.delete(promptId);
        if (timer) clearTimeout(timer);
        try { ac.signal.removeEventListener('abort', onAbort); } catch (_) {}
        resolve(decision);
      }
      pending.set(promptId, finish);
      if (ac.signal.aborted) return finish('deny');
      ac.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish('deny'), CONSENT_TIMEOUT_MS);
      emit('permission.prompt', { promptId, agentId, tool: call.name, scope: (tool && tool.scope) || 'write', argsSummary: consentSummary(call) });
    });
  }

  // THE LIVE SUMMON CHANNEL (mirrors promptConsent): the orchestrator's team.summon tool calls ctx.summon(spec);
  // this emits crew.summon.request down the SAME NDJSON stream, the browser runs the REAL summonAgent() and POSTs
  // /api/summon/ack with the new agentId (handleSummonAck), which resolves this Promise. Fail-closed identically: a
  // disconnect (ac abort) or a CONSENT_TIMEOUT_MS stall settles to null (no agent created) so a forgotten request
  // can never hold a billable run open. Settles exactly once. The new id flows back to the lead for team.dispatch.
  function summonRequest(spec) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      let settled = false, timer = null;
      function onAbort() { finish(null); }
      function finish(newAgentId) {
        if (settled) return; settled = true;
        pendingSummon.delete(requestId);
        if (timer) clearTimeout(timer);
        try { ac.signal.removeEventListener('abort', onAbort); } catch (_) {}
        resolve(newAgentId || null);
      }
      pendingSummon.set(requestId, finish);
      if (ac.signal.aborted) return finish(null);
      ac.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(null), CONSENT_TIMEOUT_MS);
      const s = spec || {};
      emit('crew.summon.request', {
        requestId, agentId,
        name: String(s.name || ''), specId: String(s.specId || ''),
        persona: String(s.persona || ''), skin: String(s.skin || ''), purpose: String(s.purpose || '')
      });
    });
  }

  // all setup + the run live inside ONE try, so any failure becomes a clean agent.run.error + closed stream
  try {
    // The browser is WATCHED, so an ungranted mutation asks live (interactive surface + promptConsent) instead
    // of default-denying. The SAME run host (runOnce) is reused by the messaging hub with surface:'autonomous'.
    await runOnce({
      key, model, system, messages, agentId, isTask, provider, reasoningEffort, fallbackModels,
      emit, signal: ac.signal, runId, trigger: 'directive',
      surface: 'interactive', prompt: promptConsent, summon: summonRequest,   // team.summon → live summonAgent() round-trip
      streamId,        // M-mem.2b: scope this run's working memory + recall boost to the active workstream
      extraObjects,    // a placed WORKBENCH -> shell.exec + verify.run, additive on the default office
      reflect: true,  // only the WATCHED browser run reflects -> a turn-in beat; the headless hub omits this
      lead: true      // Stage 2: ONLY the browser-commanded run is a lead — it alone gets the orchestrator object
                      // (delegate tool). A delegated worker runs via team.dispatch with lead falsy -> cannot re-delegate.
    });
  } catch (e) {
    try { emit('agent.run.error', { agentId, runId, message: 'sidecar failure: ' + ((e && e.message) || e), transient: false }); } catch (_) {}
  } finally {
    runs.delete(runId);
    grantsSession.delete(runId);     // drop this run's session-scoped grants
    const p = pendingByRun.get(runId);   // deny any prompt still open (belt-and-suspenders; the loop normally awaits)
    if (p) { for (const f of p.values()) { try { f('deny'); } catch (_) {} } pendingByRun.delete(runId); }
    const ps = pendingSummonByRun.get(runId);   // settle any summon request still open → null (no agent created)
    if (ps) { for (const f of ps.values()) { try { f(null); } catch (_) {} } pendingSummonByRun.delete(runId); }
    try { res.end(); } catch (_) {}
  }
}

/* runOnce — the reusable RUN HOST. Assembles the proven seams (fresh tool registry + the office-workstation
   capability projection + the consent broker + the OpenRouter provider + cost engine), does the tool-capable
   pre-check, injects the Cortex memory-recall fence, and drives the unchanged agentic loop. Extracted verbatim
   from handleRun so BOTH the browser /api/run route AND the messaging hub (channels/hub.js) drive the identical
   pipeline. The CALLER owns: the runId, the abort signal, the emit sink (NDJSON for the browser; an in-process
   reply-assembler for the hub), the run lifecycle/cleanup, AND the consent SURFACE — 'interactive' + a live
   `prompt` for the watched browser; 'autonomous' (default-deny on ungranted mutation) for a headless chat. */
async function runOnce(o) {
  const { key, system, messages = [], agentId = 'agent', isTask = false, signal, runId } = o;
  const usingCodex = (o.provider === 'codex' || o.provider === 'openai-codex');
  const providerId = usingCodex ? 'codex' : 'openrouter';
  const reasoningEffort = resolveReasoningEffort(providerId, o.reasoningEffort || o.reasoning_effort || (o.reasoning && o.reasoning.effort));
  let model = String((o && o.model) || '').trim() || (usingCodex ? CODEX_DEFAULT_MODEL : CRON_DEFAULT_MODEL);
  const streamId = o.streamId || null;   // M-mem.2b (browser run only; the headless hub omits it → global memory)
  const surface = o.surface || 'interactive';
  const prompt = o.prompt;
  const summon = o.summon;   // the live team.summon round-trip closure (browser runs only); undefined for headless/workers → tool degrades gracefully
  const trigger = o.trigger || 'directive';
  // P1 (WIRING_AUDIT slice 2): a server-initiated run (telegram/routed) has NO browser-local copy of its
  // lifecycle, so the station floor never lights for it. When a caller opts in via o.broadcast, ALSO mirror the
  // run-lifecycle events to the floor over SSE. Gated on the explicit flag — NOT on trigger — so the hero's
  // directive run does not double-count; scheduled cron forwards through cronEmit, while manual Run Now opts in
  // here because its primary stream is local to the ROUTINES panel. Restricted to run.start/cost/end so
  // agent.token/tool noise never floods the SSE bus. Re-using the
  // name `emit` means every existing emit(...) call site below tees automatically, with no per-site change.
  const rawEmit = o.emit;
  const emit = o.broadcast
    ? (name, payload) => {
        try { rawEmit(name, payload); } catch (_) {}
        if (name === 'agent.run.start' || name === 'agent.cost' || name === 'agent.run.end') {
          try { sse.broadcast(name, redact(payload)); } catch (_) {}
        } else if (name === 'agent.tool_call' && payload && typeof payload.name === 'string' && payload.name.indexOf('mcp__') === 0) {
          // P3: a routed run's MCP tool call pulses its connector portal on the floor. Only mcp__ calls are
          // teed (not fs/shell), so the SSE bus stays quiet while the on-ramp still lights when it really fires.
          try { sse.broadcast(name, redact(payload)); } catch (_) {}
        }
      }
    : rawEmit;

  // ---- concurrency admission (multi-agent fan-out guard) ----
  // Refuse a run only when a NEW distinct agent would exceed the in-flight cap; a 2nd run of an already-
  // admitted agent always passes (no new slot). On refusal emit the same start→error→end shape every other
  // up-front refusal uses (Codex sign-in / non-tool model), reason 'error', transient (a slot may free up).
  if (!concurrencyGate.tryEnter(agentId)) {
    emit('agent.run.start', { agentId, runId, trigger: trigger, model });
    emit('agent.run.error', { agentId, runId, transient: true, message: 'Too many agents are working at once (limit ' + concurrencyGate.max() + '). Wait for one to finish, or raise STARNET_MAX_CONCURRENT_AGENTS.' });
    emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 });
    return;
  }
  // Everything below is wrapped so the admission slot is ALWAYS released (early-return refusals above run
  // before tryEnter; every exit below — return, throw, or the normal finish — passes through leave()).
  try {

  // ---- tools (registered fresh per run; cheap) ----
  const registry = makeRegistry();
  makeWebTools({ openrouter: { apiKey: key, model } }).register(registry);   // web_search/web_fetch (DDG/Jina, OR fallback)
  makeBrowserTools({}).register(registry);   // browser.* automation: exposed only through the web/dish capability
  makeFsTools({ fsp, pathMod: path, root: WORKSPACES, environment: executionEnvironment, limits: { writeBytes: 1 << 20, readReturn: 24000 }, redact }).register(registry);   // redact: scrub secrets out of surfaced fs.search lines (§5.6)
  makeNotebookTools({ store: notebookStore, clock: { now: () => Date.now() }, redact, rank, nextTrust: memcore.nextTrust }).register(registry);   // §5.6: scrub secrets at the write boundary; rank: explicit read shares auto-recall's relevance order; nextTrust: notebook.feedback rating fold
  makeRecallTool({ transcriptStore }).register(registry);   // H1.3: recall_conversation — agent searches its own past dialogue (transcriptstore); joins the NOTEBOOK (memory) capability
  makeSkillTools({ store: skillStore }).register(registry);   // H4: skill.write/list/view — the agent's reusable procedure library (memory capability)
  Todo.makeTodoTool({ store: notebookStore }).register(registry);   // in-session task plan — shares the notebook's per-agent kv store ('todo:'+agentId)
  // STUDIO (media skills): image_generate / image_analyze ride the SAME BYOK OpenRouter key + key the run uses.
  // Gated by a 'studio' object (in the default office below) exactly like web/files; outputs save to the workspace.
  makeImageTools({ openrouter: { apiKey: key, model }, fsp, pathMod: path, root: WORKSPACES }).register(registry);
  // JUKEBOX (Spotify): registered every run, EXPOSED via a 'jukebox' object; no-op (clear error) until the user
  // connects Spotify in Settings. The OAuth session + auto-refresh live in the station-wide spotifyStore above.
  makeSpotifyTools({ store: spotifyStore }).register(registry);
  // shell.exec (the workbench capability): registered every run, but only EXPOSED + dispatchable when a 'workbench'
  // object is in the agent's room (resolveTools gates it) — no object, no shell. redact() scrubs stdout of secrets.
  makeShellTool({ spawn: childSpawn, fs: fs, pathMod: path, root: WORKSPACES, environment: executionEnvironment, redact: redact, clock: { now: () => Date.now() }, bg: shellBg }).register(registry);
  // verify.run (same workbench gate as shell): run the project check + emit verify.result. Also workbench-only.
  makeVerifyTool({ spawn: childSpawn, fs: fs, pathMod: path, root: WORKSPACES, environment: executionEnvironment, redact: redact, clock: { now: () => Date.now() } }).register(registry);
  // computer.use (same workbench gate): desktop control is execute-scoped, consent-gated, and driver-injected by desktop builds.
  makeComputerTools({}).register(registry);
  // team.dispatch (Stage 2 orchestrator): registered every run but only EXPOSED when an 'orchestrator' object is
  // in the room — conferred ONLY on the lead run (below), so a delegated worker can never re-delegate. It calls
  // THIS SAME runOnce per worker; the roster supplies each worker's composed identity (system prompt + model).
  makeOrchestrationTools({
    runOnce, roster: () => agentRoster, key, model, provider: o.provider, reasoningEffort, subagents,
    selfSystem: system,   // team.spawn clones the LEAD's OWN base identity into each ephemeral subagent (Meeseeks)
    perWorker: ORCH_PER_WORKER, newId: () => crypto.randomUUID(),
    dispatchTimeoutMs: ORCH_DISPATCH_TIMEOUT_MS   // minutes, not the 30s fast-tool cap (see constant)
  }).register(registry);
  // routine.create/list: the lead can schedule real StarNet ROUTINES through the same cron store the panel uses.
  makeRoutineTools({
    roster: () => agentRoster,
    listJobs: () => cronJobs,
    schedulerState: () => cronArmed,
    normalizeProvider: normalizeProviderId,
    createRoutine: (spec) => {
      spec = spec || {};
      const id = crypto.randomUUID();
      const schedule = parseCronScheduleOr400(spec.schedule, Date.now(), spec.timezone);
      let created = null;
      withCronWrite(jobs => {
        const next = cronStore.createJob(jobs, {
          id: id, name: spec.name, prompt: spec.prompt, schedule: schedule,
          agentId: spec.agentId, model: spec.model, provider: spec.provider,
          deliver: spec.deliver, enabled: spec.enabled, repeat: spec.repeat
        }, { id: id, now: Date.now() });
        created = cronStore.getJob(next, id);
        return next;
      });
      return created || cronStore.getJob(cronJobs, id);
    },
    armScheduler: (enabled) => {
      const want = enabled === true;
      saveCronArmed(want);
      cronArmed = want;
      if (want) armCron(); else disarmCron();
      return cronArmed;
    }
  }).register(registry);
  throttleSearch(registry);

  // ---- capabilities: each placed object IS a capability grant (CAP_REGISTRY): computer = compute gate · dish =
  //      web · cabinet = files · notebook = memory. resolveTools projects them into the agent's tools FRESH per
  //      run — no host-side toolset policy. Phase B5: a routed bay passes its OWN station (o.station) built from
  //      the objects in that bay's room, so per-bay caps are isolated; absent (browser chat / unrouted work) the
  //      office is composed below. ----
  // THE MOAT (FLOOR-REAL) lives in composeOffice (./capability/office.js, pure + tested): on the INTERACTIVE
  // (browser COMMS) surface the floor is REAL — the office starts COMPUTE-ONLY (the single freebie: an agent can
  // ALWAYS think, so a brand-new agent works out of the box and the floor is never a dead wall) and the agent's
  // actual placed caps (o.extraObjects: dish→web · cabinet→files · workbench→terminal · …) are appended, so it
  // grants exactly what the Commander placed. AUTONOMOUS/headless runs keep the full default office (no floor UI in
  // the moment; stripping a scheduled/delegated run's web+files would regress shipped work). Connectors are
  // account-level (both surfaces); the LEAD alone gets the orchestrator object so a delegated worker can't re-delegate.
  const defaultObjects = composeOffice({ surface, lead: o.lead, connectorIds: connectors.ids(), extraObjects: o.extraObjects });
  const station = o.station || { agents: { [agentId]: { id: agentId, room: 'office' } }, rooms: { office: { id: 'office', objects: defaultObjects } } };
  const resolved = resolveTools(agentId, station);
  // MCP CONNECTORS (per-agent): a connector object placed in THIS agent's room grants its server's live tools.
  // Register them into this run's fresh registry and union their names into the resolved set so the capability
  // gate, network classification, and the wire tool-list treat them exactly like a built-in. Never breaks a run.
  try {
    const room = station.rooms && station.agents && station.agents[agentId] && station.rooms[station.agents[agentId].room];
    for (const def of connectors.toolDefsForObjects((room && room.objects) || [])) {
      registry.register(def);
      if (resolved.tools.indexOf(def.name) < 0) resolved.tools.push(def.name);
      resolved.networkCaps[def.name] = true;
      resolved.approvalRules[def.name] = { requiresConsent: !!def.requiresConsent, scope: def.scope, network: true };
    }
  } catch (e) { console.warn('[mcp] connector tool projection failed:', (e && e.message) || e); }
  // P1.5: the real informed-consent broker. surface:'interactive' + prompt ⇒ ungranted mutations ask live;
  // surface:'autonomous' (no one watching, e.g. a Telegram chat) ⇒ default-deny on any ungranted mutation
  // (silence is not consent). Read-only/non-network auto-allows; the hardline floor sits below Full Access.
  // per-agent FULL ACCESS (chosen at create / in the dossier) bypasses the gate too — same effect as the global
  // SKYNET_FULL_ACCESS env, but scoped to this agent. The hardline floor still applies below it.
  const agentFullAccess = ((agentRoster.get(agentId) || {}).approvalMode === 'full');
  // A delegated/summoned worker SHARES the lead's consent broker (o.consent) so it has the SAME access the
  // orchestrator has: the lead's APPROVAL posture (full-auto bypass, or a live prompt forwarded to the WATCHED
  // lead's COMMS) and its session grants. A top-level run builds its own. Safe across surfaces: a headless cron
  // lead's broker is autonomous (default-deny + exec-lockout), so its workers inherit "no self-approved shell"
  // — only a watched, interactive lead can let a worker write/run shell, and only with a human's click.
  const consent = o.consent || makeConsentBroker({
    bypass: FULL_ACCESS || agentFullAccess, hardline: hardlineFloor, sessionKey: runId,
    grantsSession, grantsPermanent, persist: persistAllowlist, grantsBlanket: blanketSetFor(agentId),
    networkOf: (call) => !!resolved.networkCaps[call.name],
    surface: surface, prompt: prompt
  });
  // B1 (Cortex seam): thread runId onto capCtx so a tool's dispatch can stamp provenance (sourceRunId)
  // on memory writes. makeCapCtx merges `extra` verbatim; the consumer arrives with M-mem.2.
  const capCtx = makeCapCtx(resolved, { emit, consent, summon, timeoutMs: CAPS.toolTimeoutMs, runId, streamId, signal: signal });

  // ---- provider + cost ----
  // Codex (personal ChatGPT subscription) authenticates with a freshly-refreshed OAuth access_token instead of
  // an API key. A dead/missing token surfaces as a clean run.error so the UI can prompt a re-sign-in; everything
  // downstream of the provider seam (loop, cost, gauge) is identical to the OpenRouter path.
  let provider;
  if (usingCodex) {
    let codexToken;
    try { codexToken = await ensureCodexAccessToken(); }
    catch (e) {
      emit('agent.run.start', { agentId, runId, trigger: trigger, model });
      emit('agent.run.error', { agentId, runId, transient: !(e && e.reloginRequired), message: 'ChatGPT sign-in needed: ' + ((e && e.message) || e) });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 });
      return;
    }
    provider = selectProvider({ provider: 'codex', fetch: globalThis.fetch, token: codexToken, reasoningEffort });
  } else {
    provider = selectProvider({ provider: 'openrouter', fetch: globalThis.fetch, key, baseUrl: OPENROUTER_BASE, reasoningEffort });
  }
  const cost = makeCostEngine({ priceOf: provider.priceOf });

  // Provider FALLBACK chain (consumes the loop's failover seam). Cost-correct by construction: each entry reuses
  // THIS provider object (same priceOf catalog) with an alternate model, so a fallback's spend is priced right.
  // Source: o.fallbackModels (array of slugs from the run request) or env SKYNET_FALLBACK_MODELS (comma list).
  // On overload/429/5xx/auth/billing the loop retries the turn on the next model instead of dying. Empty = off.
  const fallbackModels = (Array.isArray(o.fallbackModels) ? o.fallbackModels : String(ENV('FALLBACK_MODELS') || '').split(','))
    .map(s => String(s || '').trim()).filter(s => s && s !== model);
  // CREDENTIAL ROTATION (P0.2): on a rate-limit/auth/billing failure the loop rotates to an alternate KEY for the
  // SAME model BEFORE trying alternate models. Pool source: o.keyPool (array) or env SKYNET_KEY_POOL (comma list).
  // credPool sinks cooled (recently-failed) keys to the back; each entry is a fresh provider on that key (priceOf
  // is key-independent → cost stays correct) tagged with credKey so the loop's onFallback can cool it on failure.
  // OpenRouter only (Codex authenticates by OAuth token, not an API key). Empty pool = byte-identical to today.
  let rotationFallbacks = [];
  if (!usingCodex) {
    const pool = (Array.isArray(o.keyPool) ? o.keyPool : String(ENV('KEY_POOL') || '').split(','))
      .map(s => String(s || '').trim()).filter(s => s && s !== key);
    rotationFallbacks = credPool.order(pool).map(rk => ({ provider: selectProvider({ provider: 'openrouter', fetch: globalThis.fetch, key: rk, baseUrl: OPENROUTER_BASE, reasoningEffort }), model, credKey: rk }));
  }
  const fallbacks = rotationFallbacks.concat(fallbackModels.map(m => ({ provider, model: m })));

  // ---- context auto-compaction: fold older turns into a summary once the live prompt passes 65% of the model's
  //      window, so a long run shrinks instead of overflowing. contextLimit is 0 until the catalog warms (then the
  //      loop never compacts — safe). The summarizer is ONE cheap model call over the older slice; on any failure
  //      the loop keeps the full history (never a silent drop). ----
  const ctxMgr = makeContext({ contextLimit: provider.contextLimit(model), compactAt: 0.65, keepTail: 6 });
  // The summarizer is itself a paid model call. It RETURNS its reconciled {usd,tokens} so the loop folds the
  // spend into the run's running tally IN THE SAME TURN — so the per-run ceiling + cross-run pool guards (and the
  // run total -> ledger) all see it, not just at run end. It also surfaces a display-only agent.cost so live
  // spend stays visible; that event deliberately OMITS tokensIn/tokensOut so the context-occupancy gauge (which
  // reads agent.cost.tokensIn as "current prompt size") is not transiently corrupted by the summarizer's small
  // prompt. The loop owns the accounting; this emit is for the cost stream only.
  async function summarize(older, prevSummary) {
    const transcript = older.map(mm => {
      const c = (mm && typeof mm.content === 'string') ? mm.content : JSON.stringify((mm && mm.content) || '');
      return (mm && mm.role ? mm.role : 'msg') + ': ' + c;
    }).join('\n').slice(0, 16000);
    // on_pre_compress (MEMORY-CORTEX): rank the agent's durable memory against the slice being folded and PREPEND
    // it, so beliefs like "user prefers X" survive when the raw turns are discarded. '' when nothing to preserve
    // (prepend nothing → byte-identical compaction). Fail-open: a memory hiccup must never block the summary.
    let memBlock = '';
    try {
      const recs = notebookStore.get('notebook:' + agentId);
      if (Array.isArray(recs) && recs.length) memBlock = compactionMemoryBlock(recs, transcript, { now: Date.now(), k: 5, limit: 800, streamId: o.streamId || null });
    } catch (_) {}
    const prev = (typeof prevSummary === 'string' && prevSummary.trim()) ? prevSummary.trim() : '';   // H5.2: a prior fold's running summary to merge into
    const prevBlock = prev ? 'PREVIOUS SUMMARY (update this — merge the new turns in, drop anything now obsolete):\n' + prev + '\n\n' : '';
    const userMsg = (memBlock ? memBlock + '\n\n' : '') + prevBlock + 'Summarize this earlier part of the conversation so it can replace the raw turns:\n\n' + transcript;
    const req = { model, stream: true, signal, messages: [
      { role: 'system', content: compactionSummaryPrompt({ prevSummary: !!prev }) },   // H5.1 structured template; H5.2 merge-update variant when a prior summary exists
      { role: 'user', content: userMsg }
    ] };
    let out = '', usage = null;
    for await (const ev of provider.stream(req)) {
      if (ev && ev.type === 'text') out += ev.delta;
      else if (ev && ev.type === 'usage') usage = ev.usage;
    }
    const c = cost.reconcile(usage, model);
    emit('agent.cost', { agentId, runId, usd: c.usd || 0, model, reconciled: true });   // display-only; no token fields (gauge-safe)
    const r = { summary: out.trim(), usd: c.usd || 0, tokens: (c.tokensIn || 0) + (c.tokensOut || 0) };
    if (c.unpriced) r.unpricedUsage = [{ model, tokensIn: c.tokensIn || 0, tokensOut: c.tokensOut || 0 }];
    return r;
  }
  // per-run adapter onto the shared cross-run budget: the loop calls check(spentThisRun) each turn; the budget
  // emits any threshold crossing down THIS run's bus and returns a block when a soft pool cap is hit.
  const runBudget = { check: (spentThisRun) => budget.check(runId, agentId, spentThisRun, Date.now(), emit) };

  // a task needs tool calls — refuse a model we KNOW can't call tools, up front, with an actionable message
  // (supportsTools returns null when the catalog is cold, so this never false-refuses a real model).
  if (isTask && provider.supportsTools(model) === false) {
    emit('agent.run.start', { agentId, runId, trigger: trigger, model });
    emit('agent.run.error', { agentId, runId, transient: false, message: 'The model "' + model + '" does not support tool calls, so it can\'t run tasks. Pick a tool-capable model (e.g. anthropic/claude-sonnet-4.6 or openai/gpt-4o) on the connect screen.' });
    emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 });
    return;
  }

  // ---- per-call tool list (task runs only). Internal names are dotted (fs.write, notebook.read) but the
  //      OpenAI/OpenRouter function-name grammar is ^[A-Za-z0-9_-]{1,64}$ — a '.' 400s the request — so on
  //      the WIRE we expose underscored names and translate the model's call name back before dispatch. ----
  const toolDefs = isTask ? registry.wireFormat(registry.list(new Set(resolved.tools))) : [];
  const fromWire = new Map();
  for (const d of toolDefs) { const real = d.function.name; const w = real.replace(/\./g, '_'); fromWire.set(w, real); d.function.name = w; }

  const seen = new Map();
  let toolBytes = 0;   // running total of tool-output chars fed back into the model this run
  let cpTurn = 0;      // per-run checkpoint sequence (a pseudo-turn for the snapshot index/lineage)
  const dispatch = async (c, ctx) => {
    if (fromWire.has(c.name)) c = Object.assign({}, c, { name: fromWire.get(c.name) });   // wire -> real (dotted) name
    const sig = (c.name + '|' + (c.argsRaw || '')).slice(0, 400);
    const n = (seen.get(sig) || 0) + 1; seen.set(sig, n);
    if (n > CAPS.maxRepeat) return { ok: false, isError: true, content: 'repeated identical call blocked (loop guard)', summary: 'loop-break' };
    // CHECKPOINT NET: snapshot the workspace BEFORE a mutating tool so the turn is one rollback away. The general
    // fs.* net is opt-in (SKYNET_CHECKPOINTS); a shell.* call is ALWAYS snapshotted (the safety coupling that makes
    // command execution undo-able, independent of the flag). Content-deduped + fail-open: an unchanged workspace
    // or a git hiccup costs nothing and never throws into the run.
    if (mutatesWorkspace(c.name) && (CHECKPOINTS_ENABLED || /^(shell|verify)\./.test(c.name))) {
      try {
        const snap = await checkpointStore.snapshot(agentId, { runId, turn: cpTurn, label: c.name });
        if (snap && snap.created) { emit('checkpoint.created', { agentId, runId, turn: cpTurn, snapshotId: snap.id, files: snap.files || 0, bytes: snap.bytes || 0, label: c.name }); cpTurn++; }
      } catch (_) { /* a checkpoint failure must never break a run */ }
    }
    const dctx = (ctx && ctx.callId !== c.id) ? Object.assign({}, ctx, { callId: c.id }) : ctx;   // per-call id for shell.exec telemetry
    let r = await registry.dispatch(c, dctx);
    // bound the TOTAL tool output across a run so a few big fetches/reads can't blow the context window or cost
    if (r && typeof r.content === 'string' && r.content.length) {
      if (toolBytes >= CAPS.maxToolBytes) {
        r = Object.assign({}, r, { content: '[tool output omitted — this run hit its ' + Math.round(CAPS.maxToolBytes / 1000) + 'KB tool-output budget; finish with what you already have]' });
      } else if (toolBytes + r.content.length > CAPS.maxToolBytes) {
        r = Object.assign({}, r, { content: r.content.slice(0, CAPS.maxToolBytes - toolBytes) + '\n…[truncated — per-run tool-output budget reached]' });
      }
      toolBytes += r.content.length;
    }
    return r;
  };

  // tell the model, plainly + capability-driven, that it has real tools right now (so it never claims it can't act)
  const wireNames = toolDefs.map(d => d.function.name);
  const hasWebTools = wireNames.indexOf('web_search') >= 0 || wireNames.indexOf('web_fetch') >= 0;
  const hasWriteTools = wireNames.indexOf('fs_write') >= 0 || wireNames.indexOf('fs_append') >= 0 ||
    wireNames.indexOf('fs_edit') >= 0 || wireNames.indexOf('fs_patch') >= 0;
  const hasReadTools = wireNames.indexOf('fs_read') >= 0 || wireNames.indexOf('fs_list') >= 0 ||
    wireNames.indexOf('fs_search') >= 0;
  const hasPatchTool = wireNames.indexOf('fs_patch') >= 0;
  const hasShellExec = wireNames.indexOf('shell_exec') >= 0;
  const hasVerifyRun = wireNames.indexOf('verify_run') >= 0;
  const hasBgStatus = wireNames.indexOf('shell_bg_status') >= 0;
  const hasBrowserTools = wireNames.some(n => /^browser_/.test(n));
  const hasNotebookWrite = wireNames.indexOf('notebook_write') >= 0;
  const workDisciplineNote = ''
    + (hasShellExec ? 'When the Commander names a local project folder, first anchor shell_exec.cwd to that exact folder, then keep later shell paths relative to it. After a path or cwd failure, run one small working-directory diagnostic plus a listing, and change strategy instead of retrying the same bad path. ' : '')
    + (hasReadTools ? 'Inspect before editing with fs_search/fs_list/fs_read, or one small shell diagnostic when the file tools cannot see the project; do not guess file contents or shotgun failed paths. ' : '')
    + (hasWriteTools ? (hasPatchTool
      ? 'For source changes, prefer fs_patch for multi-line edits and fs_edit only for small exact replacements. Avoid temporary patch scripts, giant quoted shell rewrites, or minified/quoting-mangled edits unless the normal file tools cannot do the job; leave code readable. '
      : 'For source changes, prefer fs_edit/fs_write over giant quoted shell rewrites, and leave code readable. ') : '')
    + ((hasVerifyRun || hasShellExec) ? 'After edits, run the narrowest real verification that proves the change: verify_run when it matches the project, otherwise shell_exec for syntax/build/tests. ' : '')
    + (hasShellExec && hasBgStatus ? 'For dev servers, start them with shell_exec background:true, then call shell_bg_status to confirm the handle is alive before finalizing. ' : '')
    + (hasBrowserTools ? 'For browser, UI, or game changes, use browser_navigate plus browser_console/browser_snapshot/browser_vision when the target is a public/reachable URL. For local/private dev servers that browser_navigate is not allowed to open, verify with shell_exec/shell_bg_status or an HTTP probe and report that browser verification was unavailable. ' : '')
    + ((hasShellExec || hasWriteTools || hasBrowserTools) ? 'Final reports must name changed files, verification commands/results, and any running server URL/background id or remaining limitation. ' : '');
  const toolNote = (isTask && wireNames.length)
    ? '\n\n[HARNESS] You are running in a REAL agent harness on the Commander\'s machine, at a workstation with '
      + 'these LIVE tools: ' + wireNames.join(', ') + '. '
      + 'Actually use the listed tools when relevant; never claim a listed tool is unavailable. '
      + (wireNames.indexOf('routine_create') >= 0
        ? 'When the Commander asks for a cron, routine, scheduled/recurring task, reminder, or standing job, use routine_create/routine_list in StarNet ROUTINES; do not use shell_exec, crontab, Windows Task Scheduler, Python scripts, or OS schedulers. '
        : '')
      + (hasWebTools ? 'Ground every current factual claim in what web_search / web_fetch actually return, and cite the source URLs; ' : '')
      + 'do not invent facts, figures, or links. '
      + (hasWriteTools ? 'Save substantive deliverables (reports, code, notes) to your workspace with fs_write / fs_append. ' : '')
      + (hasNotebookWrite ? 'Record durable facts you\'ll want later with notebook_write. ' : '')
      + workDisciplineNote
      + (hasShellExec ? 'Do not guess Bash-style /c paths for Windows when the Commander gave you a real Windows path. ' : '')
      + (hasWriteTools ? 'Saving a file shows the Commander a quick one-click approval prompt — so just CALL the write tool when you are ready; do not ask permission in chat or claim you cannot save. If they decline, carry on without it. ' : '')
      + 'Keep working across as many tool calls as the task needs; when it is fully done, give the Commander a clear '
      + 'final report of what you found/did' + (hasWriteTools ? ' and which files you saved.' : '.')
    : '';
  // Stage 2/3: a LEAD run is told it can DELEGATE to existing crew (team.dispatch, listed FRESH from the roster
  // the browser pushed via /api/roster) AND SUMMON new specialists (team.summon). Only the lead gets this (it alone
  // gets the orchestrator object above); a non-lead worker stays byte-identical (empty) so it can never re-delegate.
  let teamNote = '';
  if (o.lead) {
    teamNote = '\n\n[ORCHESTRATION] You are the lead orchestrator. You can build and direct a crew for the Commander:';
    const lines = [];
    for (const [aid, ident] of agentRoster) { if (aid === agentId) continue; lines.push('  - ' + aid + ' (' + (ident.name || aid) + ')' + (ident.role ? ' — ' + ident.role : '')); }
    if (lines.length) teamNote += '\n• DELEGATE to your existing specialist crew with team.dispatch — call it with '
      + 'workers:[{agentId, prompt}] and synthesize their returned results into your final answer:\n' + lines.join('\n');
    teamNote += '\n• SPAWN temporary same-identity subagents with team.spawn for one-off parallel subtasks when no named specialist is needed. '
      + 'Use background:true for watchable long-running spawned workers, then inspect/control them with team.subagents, team.interrupt, and team.resume.';
    teamNote += '\n• SUMMON a NEW specialist with team.summon when the Commander wants an agent you don\'t have yet '
      + '(e.g. "create a research agent for me"): pass a class via specId (researcher, engineer, operator, scribe, '
      + 'analyst, reviewer, scout, archivist, designer, chief, liaison) or a custom name + purpose. It returns the new '
      + 'agentId, which you can immediately hand work to with team.dispatch. When the Commander asks you to create or '
      + 'summon an agent, actually DO it with team.summon — don\'t just describe it or claim you cannot. '
      + 'For scheduled work, create StarNet routines with routine_create; if the work clearly belongs to a specialist '
      + '(research/news/latest => researcher/scout/analyst), target that agentId, or summon the specialist first.';
  }
  // INSTALLED SKILLS (bundled recipe library): inject the bodies of the recipes the Commander ENABLED whose
  // required objects are actually on THIS agent's floor (object = capability — the same gate the tools use). Empty
  // when none qualify → byte-identical to a skill-less prompt. Riding the ONE place the final system prompt is
  // assembled means it covers every surface (browser chat, cron, delegated worker) with no per-path change.
  let skillBlock = '';
  try {
    const sRoom = station.rooms && station.agents && station.agents[agentId] && station.rooms[station.agents[agentId].room];
    const placedTypes = ((sRoom && sRoom.objects) || []).map(x => x.objectType);
    skillBlock = skillsCatalog.compose(SKILL_LIBRARY, { overrides: skillPrefs.overrides(), placedTypes: placedTypes });
  } catch (_) { /* a skill-injection hiccup must never break a run */ }
  // STARNET OPERATOR MANUAL: how the station works, so the agent can guide a stuck Commander. Interactive
  // only (same gate as capsummary — a Commander is present to help and the build UI exists). Sits right
  // BEFORE the authoritative <capabilities_ground_truth>, which it defers to, so the two never disagree.
  const manualBlock = (surface === 'interactive') ? starnetManual() : '';
  const runtimeBlock = runtimeIdentityBlock({ provider: providerId, model, agentId, runId, surface, trigger, fallbackModels });
  const sys = (system || '') + runtimeBlock + toolNote + teamNote + manualBlock + summarizeCapabilities(resolved, { surface }) + skillBlock;   // ground-truth caps: name the object to place instead of promising work it has no tool for
  // H1.2: bulletproof resume — if this run arrives with NO prior history (a fresh restart whose browser save was
  // wiped, or any caller that only sent the new directive) AND it names an explicit workstream, seed the
  // conversation from the durable server transcript so the agent remembers the dialogue. Never overrides real
  // history the caller already supplied; gated to an explicit streamId (the global catch-all is not auto-seeded).
  let convo = messages;
  try {
    if (streamId && Array.isArray(messages) && messages.filter(m => m && m.role !== 'system').length <= 1) {
      const seed = transcriptStore.reconstruct(streamId, { limit: 100 });
      if (seed.length) convo = seed.concat(messages);   // prior dialogue first, the new directive stays last
    }
  } catch (_) { /* resume is best-effort; a bad transcript never blocks a run */ }
  let msgs = sys ? [{ role: 'system', content: sys }, ...convo] : convo.slice();
  // Cortex (M-mem.3): surface the agent's OWN memory in-prompt — RANK it by relevance to this message
  // (BM25 + recency/trust/pin), inject the top few as a recalled-memory fence before the triggering user
  // message, and emit memory.used per surfaced record (-> useCount/trust + the XP reuse path). The recency
  // floor keeps recent notes recallable on an off-topic turn (no M-mem.1 regression). Empty notebook =>
  // nothing injected (byte-identical to a memoryless run). Never fails the run.
  try {
    const stored = notebookStore.get('notebook:' + agentId);
    const recs = Array.isArray(stored) ? stored : [];
    let q = '';
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i] && messages[i].role === 'user' && typeof messages[i].content === 'string') { q = messages[i].content; break; } }
    const ranked = rank(recs, q, { now: Date.now(), streamId });   // M-mem.2b: boost the active workstream's working memory
    const recall = renderRecall(ranked, { limit: 1500 });
    if (recall.text) {
      msgs = injectRecall(msgs, redact(recall.text));   // §5.6 belt-and-suspenders: a legacy plaintext note can't reach the provider verbatim
      emit('memory.recall', { agentId, runId, count: recall.count, chars: recall.chars });
      // M-mem.6: surfacing a record IS a use — fold useCount++ / lastUsedAt back onto the stored record (the
      // reduction that makes the Memory Core stats AND rank()'s recency/trust boosts REAL), then emit. One
      // store write per run (only when something changed); the bumped recs don't affect THIS run's ranking.
      // Credit memory.used ONLY for the records whose real content actually surfaced — renderRecall returns
      // those ids (it EXCLUDES the [blocked] poisoned records + any skipped/char-capped ones), so a withheld
      // record never gains useCount/recency (which would otherwise make it a sticky slot-squatter), and the
      // old positional ranked[i] aliasing is gone.
      if (runId && recall.usedIds && recall.usedIds.length) {
        const usedAt = Date.now();
        // P1: fold the useCount/recency bumps under the per-agent lock, RE-READING the current notebook so a
        // note the agent wrote this run (or a concurrent run/UI edit for the same agent) is not clobbered by a
        // whole-array overwrite from this run's start-of-run snapshot.
        await notebookStore.update('notebook:' + agentId, (cur) => {
          const base = Array.isArray(cur) ? cur : [];
          let updated = base;
          for (const id of recall.usedIds) {
            updated = memcore.reduceStats(updated, { name: 'memory.used', payload: { id } }, { now: usedAt });
            emit('memory.used', { agentId, runId, id });
          }
          return updated !== base ? updated : undefined;   // skip the write when nothing changed
        });
      }
    }
  } catch (_) {}

  let result;
  const _txStart = msgs.length;   // H1.1: boundary — turns the loop appends to msgs after this ARE this run's new dialogue
  try {
    result = await runAgentLoop({
      messages: msgs, provider, emit, cost, tools: toolDefs, dispatch, capCtx,
      // per-RUN hard ceiling = the Balanced perRun cap; the soft day/global pools ride on `budget`. A perRun of
      // 0/Infinity means UNGOVERNED per-run (Infinity), NOT "block every run" — the loop reads maxCostUsd that way.
      // Stage 2: a delegated worker passes o.maxCostUsd (the per-worker cap) which overrides the lead's perRun.
      limits: { maxIters: CAPS.maxIters, maxCostUsd: (o.maxCostUsd > 0 && isFinite(o.maxCostUsd)) ? o.maxCostUsd : ((BUDGET_CAPS.perRun > 0 && isFinite(BUDGET_CAPS.perRun)) ? BUDGET_CAPS.perRun : Infinity) },
      budget: runBudget, context: ctxMgr, summarize, fallbacks,
      // P0.2 credential rotation: the live key + a hook the loop calls as it rotates away from a failed one,
      // so a rate-limit/auth/billing key gets a cooldown (credPool) and isn't tried first next run.
      credKey: usingCodex ? null : key,
      onFallback: ({ rotate, credKey, retryAfterMs, resetAtMs }) => {
        if (!rotate || !credKey) return;
        // H6.1: honor a server-stated wait — a relative Retry-After directly, or an absolute reset_at minus now.
        // Falsy/expired => undefined => credPool's default cooldown (and it clamps any absurd value).
        let ttlMs;
        if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) ttlMs = retryAfterMs;
        else if (typeof resetAtMs === 'number') { const d = resetAtMs - Date.now(); if (d > 0) ttlMs = d; }
        credPool.penalize(credKey, ttlMs);
      },
      todoNote: () => Todo.formatForInjection(notebookStore, agentId),   // re-inject the active task plan after a compaction
      signal: signal, clock: { now: () => Date.now() },
      agentId, runId, model, trigger: trigger,
      // rough initial estimate for the error classifier's context-overflow ratio; contextLimit is 0 until the
      // /models catalog warms, which (by design) disables the ratio so a bare 400 is never mislabelled.
      approxTokens: Math.ceil(JSON.stringify(msgs).length / 4), contextLimit: provider.contextLimit(model)
    });
  } finally {
    // book this run's spend into the append-only ledger (so day/global pools persist across runs), THEN drop its
    // in-flight tally — record-before-clear so the spend is always counted by at least one source, never neither.
    // result.usd/tokens already INCLUDE the summarizer's spend (the loop folds it into spentUsd as it accrues).
    const finalModel = resolveEffectiveModel({ result, requestedModel: o.model, usingCodex, codexDefaultModel: CODEX_DEFAULT_MODEL, defaultModel: CRON_DEFAULT_MODEL });
    const finalUsd = effectiveUsd({ usd: (result && result.usd) || 0, unmetered: usingCodex, unpricedUsage: result && result.unpricedUsage, priceOf: provider && provider.priceOf });
    const finalTurns = (result && result.turns) || 0;
    const finalTokens = (result && result.tokens) || 0;
    try { ledger.record({ runId, agentId, turns: finalTurns, usd: finalUsd, tokens: finalTokens, model: finalModel, unmetered: usingCodex }); } catch (_) {}
    // record the run OUTCOME (durable history) — reason + a short title from the triggering user message. Fail-open.
    try {
      let title = '';
      for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i] && msgs[i].role === 'user' && typeof msgs[i].content === 'string') { title = msgs[i].content; break; } }
      runStore.record({ runId, agentId, reason: (result && result.reason) || 'done', turns: finalTurns, tokens: finalTokens, usd: finalUsd, title: title, streamId: o.streamId || '', model: finalModel, unmetered: usingCodex });   // H3.2/H3.3/G6: transcript join + honest model/spend insights
      // P0.1/H1.1: persist the full DIALOGUE (not just the outcome) — a durable server-side transcript for EVERY
      // run, incl. headless ones (cron/Telegram/delegated). Append the triggering user directive, then EVERY new
      // turn the loop produced (assistant incl. tool_calls + tool results), so a resume can rebuild exact state.
      if (title) transcriptStore.append({ streamId: o.streamId, agentId, role: 'user', content: title });
      if (result && Array.isArray(result.messages)) transcriptStore.appendTurns(o.streamId, agentId, result.messages, _txStart);
    } catch (_) {}
    budget.clearLive(runId);
  }

  // Cortex M-mem.5b: post-run reflection (browser runs only; the hub omits o.reflect). Fire-and-forget so the
  // reply has no added latency and the input isn't held — proposals arrive a beat later over the SSE bus as a
  // Keep/Edit/Discard turn-in. Gated to a COMPLETED run with a substantive exchange; reflect() dedups vs the
  // store and never auto-writes (§5.6). result.messages is the live conversation (the agent's replies included).
  if (o.reflect && result && result.reason === 'done' && !signal.aborted && worthReflecting(result.messages)) {
    runReflection({ agentId, runId, messages: result.messages.slice(), provider, model: resolveEffectiveModel({ result, requestedModel: o.model, usingCodex, codexDefaultModel: CODEX_DEFAULT_MODEL, defaultModel: CRON_DEFAULT_MODEL }), cost, unmetered: usingCodex }).catch(() => {});
  }
  return result;

  } finally {
    concurrencyGate.leave(agentId);   // release the admission slot on EVERY exit (normal, early-return, or throw)
  }
}

// POST /api/consent { runId, promptId, decision } — the browser's answer to a live permission.prompt. Resolves the
// run's awaiting dispatch. Unknown/illegal decisions fail closed to 'deny'. A stale runId/promptId is a harmless
// no-op (the run already ended or auto-denied).
async function handleConsent(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { res.writeHead(400); return res.end('bad json'); }
  let decision = body.decision;
  if (decision !== 'once' && decision !== 'session' && decision !== 'always' && decision !== 'full') decision = 'deny';
  const pend = pendingByRun.get(body.runId);
  const finish = pend && pend.get(body.promptId);
  if (finish) finish(decision);
  res.writeHead(200); res.end('ok');
}

// POST /api/summon/ack { runId, requestId, agentId } — the browser's answer to a live crew.summon.request: it ran
// the REAL summonAgent() and reports the new agentId (or null if it couldn't). Resolves the run's awaiting
// team.summon tool. A stale runId/requestId is a harmless no-op (the run ended or the request auto-settled to null).
async function handleSummonAck(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { res.writeHead(400); return res.end('bad json'); }
  const pend = pendingSummonByRun.get(body.runId);
  const finish = pend && pend.get(body.requestId);
  const newId = (body.agentId != null && /^[A-Za-z0-9_-]{1,40}$/.test(String(body.agentId))) ? String(body.agentId) : null;
  if (finish) finish(newId);
  res.writeHead(200); res.end('ok');
}

async function handleCancel(req, res) {
  let runId;
  try { runId = (JSON.parse(await readBody(req, 4096)) || {}).runId; } catch (e) {}
  const ac = runId && runs.get(runId);
  if (ac) ac.abort();
  res.writeHead(200); res.end('ok');
}

// POST /api/halt — the E-STOP. Abort EVERY in-flight run so one click stops all spend immediately: the browser
// runs (the `runs` Map) AND any messaging-hub/Telegram runs (the hub keeps each run's AbortController in its
// inflight map). Idempotent. Each run's own finally cleans its maps + auto-denies any open consent prompt; hub
// runs are marked `superseded` first so their (now stale) partial reply isn't delivered after the kill.
function handleHalt(req, res) {
  const inflight = (telegram && telegram.hub && telegram.hub._internals) ? telegram.hub._internals.inflight : null;
  const halted = killAll(runs, inflight);   // browser runs + messaging-hub runs, in one kill (see sidecar/halt.js)
  try { executionEnvironment.killAllBackground(); } catch (_) {}   // H2.2/Phase 0: E-STOP also reaps backend-owned background processes
  try { subagents.interruptAll(); } catch (_) {}   // Phase 1: E-STOP aborts watchable background workers too
  try { cronLock.release(); } catch (_) {}  // G4.3: drop any cron lock this process holds so an E-STOP mid-tick never wedges the next tick (standalone halt-block addition; G2 will add connectors.close here)
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ halted }));
}

// POST /api/channels/telegram/connect { token, key?, model, provider? } — the Messaging tab hands over the
// BotFather token plus the app's current provider config; OpenRouter uses a key, Codex uses server-side OAuth.
// The sidecar persists the channel config (protected sibling file) and starts the bot. Headless polling then
// works even with no browser open. The secrets are NEVER echoed back.
async function handleChannelConnect(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }   // room for the composed system prompt
  // reuse the saved values when the request omits them, so RECONNECT is one click (no re-pasting the token).
  const saved = (channelSecrets && channelSecrets.telegram) || {};
  const provider = normalizeProvider(body.provider || saved.provider);
  const token = String(body.token || '').trim() || String(saved.token || '');
  const key = String(body.key || '').trim() || String(saved.key || '') || (provider === 'openrouter' ? runtimeKey : '');
  const model = String(body.model || '').trim() || String(saved.model || '');
  const reasoningEffort = resolveReasoningEffort(provider, body.reasoningEffort || body.reasoning_effort || saved.reasoningEffort);
  // the app's REAL agent identity, so Telegram runs as the same agent (shared memory) with the same voice.
  const agentId = String(body.agentId || '').trim() || String(saved.agentId || '');
  const system = (typeof body.system === 'string' && body.system) ? body.system : String(saved.system || '');
  const name = String(body.agentName || '').trim() || String(saved.name || '');
  if (!token) return json(400, { error: 'missing bot token — create one with @BotFather and paste it here' });
  if (!model) return json(400, { error: 'connect your agent first (choose a model on the title screen)' });
  if (!providerUsesCodex(provider) && !key) return json(400, { error: 'connect your agent first (OpenRouter key + model are required)' });
  try { startTelegram(token, providerUsesCodex(provider) ? '' : key, model, { agentId, system, name, provider, reasoningEffort }); } catch (e) { return json(500, { error: (e && e.message) || 'failed to start' }); }
  json(200, { connected: true, state: telegramStatus.state });
}

// POST /api/channels/telegram/sync { agentId?, system?, model?, key?, provider?, agentName? } — refresh the agent identity
// the bot runs as (e.g. after the Commander edits identity/purpose/manual in the dossier) WITHOUT a reconnect.
// The hub reads channelSecrets.telegram live, so the next inbound uses the updated prompt. No-op if unconfigured.
async function handleChannelSync(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const t = (channelSecrets && channelSecrets.telegram) || null;
  if (!t || !t.token) return json(200, { synced: false });   // nothing connected/configured — ignore quietly
  const patch = {};
  if (typeof body.agentId === 'string' && body.agentId.trim()) patch.agentId = body.agentId.trim();
  if (typeof body.system === 'string') patch.system = body.system;
  if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
  if (typeof body.provider === 'string' && body.provider.trim()) patch.provider = normalizeProvider(body.provider.trim());
  if (body.reasoningEffort || body.reasoning_effort) patch.reasoningEffort = normalizeReasoningEffort(body.reasoningEffort || body.reasoning_effort);
  if (typeof body.key === 'string' && body.key.trim()) patch.key = body.key.trim();
  if (typeof body.agentName === 'string') patch.name = body.agentName;
  channelSecrets = Object.assign({}, channelSecrets, { telegram: Object.assign({}, t, patch) });
  saveChannelSecrets(channelSecrets);
  json(200, { synced: true });
}

// POST /api/channels/telegram/disconnect — stop the bot and mark it disabled (kept in config so the token can be
// re-enabled without re-entry; clear the token by connecting a new one).
async function handleChannelDisconnect(req, res) {
  stopTelegram();
  if (channelSecrets && channelSecrets.telegram) {
    channelSecrets = Object.assign({}, channelSecrets, { telegram: Object.assign({}, channelSecrets.telegram, { enabled: false }) });
    saveChannelSecrets(channelSecrets);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ connected: false }));
}

// GET /api/channels/telegram/status — booleans + poll state ONLY; never the token/key (those stay server-side).
function handleChannelStatus(req, res) {
  const t = (channelSecrets && channelSecrets.telegram) || {};
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ connected: telegramStatus.connected, configured: !!t.token, state: telegramStatus.state, detail: telegramStatus.detail || '' }));
}

/* ----------------------- Codex (ChatGPT subscription) OAuth ----------------------- */
// The device-code flow is driven from the browser in three short requests so no long connection is held open:
//   POST /start         -> { user_code, verification_uri, device_auth_id, interval }   (show the code, open the URL)
//   POST /poll {…}       -> { status:'pending' } until the user finishes, then exchanges + persists -> { status:'connected' }
//   GET  /status         -> { connected, configured }   (never returns the tokens themselves)
//   POST /logout         -> forgets the stored tokens
// Tokens live ONLY in the protected CODEX_TOKENS_FILE (loadCodexTokens/saveCodexTokens) — never on the bus.

// POST /api/auth/codex/start — ask OpenAI for a device/user code. Returns the code + the URL the user opens.
async function handleCodexStart(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const d = await codexAuth.startDeviceLogin({ fetch: globalThis.fetch });
    json(200, { user_code: d.user_code, verification_uri: d.verification_uri, device_auth_id: d.device_auth_id, interval: d.interval, expires_in: d.expires_in });
  } catch (e) {
    json(502, { error: (e && e.message) || 'failed to start ChatGPT sign-in', code: (e && e.code) || 'device_code_request_failed' });
  }
}

// POST /api/auth/codex/poll { device_auth_id, user_code } — one poll tick. Pending until the user finishes in the
// browser; on completion it exchanges the authorization_code for tokens and persists them.
async function handleCodexPoll(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const device_auth_id = String(body.device_auth_id || ''), user_code = String(body.user_code || '');
  if (!device_auth_id || !user_code) return json(400, { error: 'missing device_auth_id / user_code' });
  try {
    const poll = await codexAuth.pollDeviceLogin({ fetch: globalThis.fetch, device_auth_id, user_code });
    if (poll.pending) return json(200, { status: 'pending' });
    const creds = await codexAuth.exchangeCode({ fetch: globalThis.fetch, authorization_code: poll.authorization_code, code_verifier: poll.code_verifier, now: Date.now() });
    codexTokens = { access_token: creds.access_token, refresh_token: creds.refresh_token, last_refresh: creds.last_refresh, auth_mode: creds.auth_mode };
    saveCodexTokens(codexTokens);
    console.log('  · ChatGPT subscription connected (Codex OAuth) — agents can now run on it');
    json(200, { status: 'connected' });
  } catch (e) {
    json(502, { status: 'error', error: (e && e.message) || 'ChatGPT sign-in failed', code: (e && e.code) || 'device_code_poll_error' });
  }
}

// GET /api/auth/codex/status — booleans only; never the tokens.
function handleCodexStatus(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ connected: !!(codexTokens && codexTokens.access_token), last_refresh: (codexTokens && codexTokens.last_refresh) || '' }));
}

// GET /api/auth/codex/models — the ACCOUNT's real Codex model list (live-discovered with a fresh token), so
// the connect screen offers exactly the slugs the backend will accept. Falls back to the provider's curated
// list (and reports the error) when not connected / discovery fails, so the dropdown is never empty.
async function handleOpenRouterModels(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const provider = makeOpenRouterProvider({ fetch: globalThis.fetch, baseUrl: OPENROUTER_BASE });
    const models = await provider.listModels();
    json(200, {
      models: models.map(m => ({
        id: m.id,
        name: m.name || m.id,
        context_length: m.context_length || 0,
        pricing: m.pricing || null,
        supportsTools: m.supportsTools !== false,
        supportsReasoning: !!m.supportsReasoning,
        supported_parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
        reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts : []
      }))
    });
  } catch (e) {
    json(200, { models: [], error: (e && e.message) || 'OpenRouter catalog unavailable' });
  }
}

async function handleCodexModels(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const token = await ensureCodexAccessToken();
    const provider = selectProvider({ provider: 'codex', fetch: globalThis.fetch, token });
    const models = await provider.listModels();
    const ids = models.map(m => m.id);
    json(200, { models: ids, default: ids[0] || null });
  } catch (e) {
    json(200, { models: [], default: null, error: (e && e.message) || 'not connected', code: (e && e.code) || '' });
  }
}

// POST /api/auth/codex/logout — forget the stored ChatGPT credentials.
function handleCodexLogout(req, res) {
  codexTokens = null; clearCodexTokens();
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ connected: false }));
}

/* ------------------------------- helpers ------------------------------- */
// a short, human-readable summary of WHAT a consent prompt is approving — the file path for fs.* (what the user
// actually cares about), else the compact args. Never echoes secrets (redact() also runs on the emitted event).
function consentSummary(call) {
  const a = (call && call.args) || {};
  if (typeof a.path === 'string' && a.path) return a.path;
  try { const s = JSON.stringify(a); return s.length > 80 ? s.slice(0, 77) + '…' : s; } catch (_) { return ''; }
}

/* POST /api/tts — neural text-to-speech via OpenRouter's /audio/speech (same BYOK key the browser
   already sends to /api/run; no extra secret). Returns mp3 bytes, or a small {fallback:true} JSON so
   the browser drops back to its built-in speechSynthesis. Results are cached on disk by
   (model,voice,speed,text) so repeated lines (acks, catchphrases) cost nothing and play instantly. */
const TTS_DEFAULT_MODEL = 'google/gemini-3.1-flash-tts-preview';
// prepend a 44-byte WAV header so the browser can play raw PCM (Gemini TTS only outputs pcm).
function pcmToWav(pcm, sampleRate, channels) {
  const bits = 16, blockAlign = channels * bits / 8, byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
// the voice cache writes one file per distinct spoken line and never pruned them — over weeks as the
// PRIMARY interaction that's hundreds of MB of orphaned audio. Sweep opportunistically (throttled, after
// the response, never blocking it): unlink stale .tmp orphans, then evict oldest by mtime past a cap.
async function maybeEvictVoiceCache() {
  if (evictingVoiceCache) return;
  evictingVoiceCache = true;
  try {
    const names = await fsp.readdir(VOICE_CACHE_DIR);
    const now = Date.now();
    const audio = []; let total = 0;
    for (const n of names) {
      const fp = path.join(VOICE_CACHE_DIR, n);
      let st; try { st = await fsp.stat(fp); } catch (_) { continue; }
      if (!st.isFile()) continue;
      if (n.endsWith('.tmp')) { if (now - st.mtimeMs > 5 * 60 * 1000) { try { await fsp.unlink(fp); } catch (_) {} } continue; }
      audio.push({ fp, mtime: st.mtimeMs, size: st.size }); total += st.size;
    }
    const MAX_FILES = 600, MAX_BYTES = 200 * 1024 * 1024, LOW = 0.8;
    if (audio.length <= MAX_FILES && total <= MAX_BYTES) return;
    audio.sort((a, b) => a.mtime - b.mtime);   // oldest first
    let files = audio.length, bytes = total;
    for (const f of audio) {
      if (files <= MAX_FILES * LOW && bytes <= MAX_BYTES * LOW) break;
      try { await fsp.unlink(f.fp); files--; bytes -= f.size; } catch (_) {}
    }
  } catch (_) { /* eviction must never throw into the request path */ }
  finally { evictingVoiceCache = false; }
}
async function handleTts(req, res) {
  const fallback = (reason) => { console.error('[tts] fallback →', reason); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ fallback: true, reason })); };
  let body;
  try { body = JSON.parse(await readBody(req, 1 << 16)); }   // text only — 64KB cap
  catch (e) { return fallback('bad json'); }
  // browser sends body.key; desktop build falls back to the live keychain key (runtimeKey)
  const key = String((body && body.key) || '').trim() || runtimeKey;
  let text = String((body && body.text) || '').replace(/\s+/g, ' ').trim();
  // backstop cap (the client already segments to <1000): if it ever overruns, cut back to the last
  // sentence boundary within the window rather than chopping mid-word.
  if (text.length > 1200) { const head = text.slice(0, 1200); const m = head.match(/[\s\S]*[.!?]["')\]]?(?=\s|$)/); text = (m && m[0].length > 600 ? m[0] : head).trim(); }
  const model = String((body && body.model) || TTS_DEFAULT_MODEL).trim();
  const voice = String((body && body.voice) || 'Umbriel').trim();
  if (!text) return fallback('no text');
  if (!key) return fallback('no key');

  // cache the synthesized (speed-independent) audio by model+voice+text; per-personality pacing is
  // applied client-side via Audio.playbackRate, so it stays out of the key for better cache hits.
  const ck = crypto.createHash('sha1').update(model + '|' + voice + '|' + text).digest('hex');
  const serveCached = async () => {
    for (const ext of ['wav', 'mp3']) {
      try {
        const buf = await fsp.readFile(path.join(VOICE_CACHE_DIR, ck + '.' + ext));
        res.writeHead(200, { 'Content-Type': ext === 'mp3' ? 'audio/mpeg' : 'audio/wav', 'Cache-Control': 'no-store', 'X-Voice-Cache': 'hit' });
        res.end(buf); return true;
      } catch (_) { /* try next ext */ }
    }
    return false;
  };
  if (await serveCached()) return;

  // pcm is the only format Gemini TTS supports (and is widely available); we wrap it to WAV below.
  const payload = { model, input: text, voice, response_format: 'pcm' };
  let or;
  try {
    or = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://localhost', 'X-Title': 'STARNET' },
      body: JSON.stringify(payload)
    });
  } catch (e) { return fallback('network: ' + ((e && e.message) || e)); }
  if (!or.ok) {
    let detail = ''; try { detail = (await or.text()).slice(0, 300); } catch (_) {}
    return fallback('openrouter ' + or.status + (detail ? ' — ' + detail : ''));
  }
  const ct = (or.headers.get('content-type') || '').toLowerCase();
  let buf;
  try { buf = Buffer.from(await or.arrayBuffer()); } catch (e) { return fallback('read: ' + ((e && e.message) || e)); }
  if (!buf || !buf.length) return fallback('empty audio');

  // raw PCM (e.g. "audio/pcm;rate=24000;channels=1") → wrap into a playable WAV; otherwise pass through.
  let outType = 'audio/wav', ext = 'wav';
  if (/pcm|octet-stream/.test(ct) || /rate=|channels=/.test(ct)) {
    const rate = parseInt((ct.match(/rate=(\d+)/) || [])[1], 10) || 24000;
    const channels = parseInt((ct.match(/channels=(\d+)/) || [])[1], 10) || 1;
    buf = pcmToWav(buf, rate, channels);
  } else if (/mpeg|mp3/.test(ct)) { outType = 'audio/mpeg'; ext = 'mp3'; }
  else if (/wav/.test(ct)) { outType = 'audio/wav'; ext = 'wav'; }
  else if (/ogg/.test(ct)) { outType = 'audio/ogg'; ext = 'ogg'; }
  // anything else (e.g. a 200 with a JSON error body, or an unexpected codec) is NOT silently wrapped as
  // WAV — that would ship a corrupt blob the browser fails to decode into silence. Fall back cleanly.
  else { return fallback('unexpected content-type: ' + ct); }

  try { const tmp = path.join(VOICE_CACHE_DIR, ck + '.' + ext + '.' + crypto.randomUUID() + '.tmp'); await fsp.writeFile(tmp, buf); await fsp.rename(tmp, path.join(VOICE_CACHE_DIR, ck + '.' + ext)); } catch (_) {}
  res.writeHead(200, { 'Content-Type': outType, 'Cache-Control': 'no-store', 'X-Voice-Cache': 'miss' });
  res.end(buf);
  // every 32nd miss, sweep the cache AFTER the response so it never adds latency to a spoken reply.
  if (++ttsMissCount % 32 === 0) setImmediate(() => { maybeEvictVoiceCache().catch(() => {}); });
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let b = '', n = 0;
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('body too large')); req.destroy(); } else b += c; });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

function throttleSearch(registry) {
  const t = registry.get('web_search');
  if (!t) return;
  const orig = t.run.bind(t);
  t.run = async (args, ctx) => {
    const now = Date.now();
    const at = Math.max(now, lastSearchAt + 1100);   // reserve this slot synchronously, BEFORE awaiting (concurrency-safe)
    lastSearchAt = at;
    const wait = at - now;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    return orig(args, ctx);
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  // media types so an agent-produced clip serves with the right content-type and the chat can <video>/<audio> it.
  // Webp/jpeg already covered above (image set). mkv/avi stream fine but most browsers can't decode them — the
  // COMMS player falls back to an "open" link in that case, mirroring Hermes's OpenMediaButton.
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.opus': 'audio/ogg; codecs=opus'
};
const ACTIVE_DELIVERABLE_EXTS = new Set([
  '.html', '.htm', '.xhtml', '.js', '.mjs', '.cjs', '.svg', '.xml', '.xsl', '.xslt', '.wasm'
]);
function safeDownloadName(abs) {
  return path.basename(abs).replace(/[^A-Za-z0-9_.-]/g, '_') || 'download';
}
function isActiveDeliverable(abs) {
  return ACTIVE_DELIVERABLE_EXTS.has(path.extname(abs).toLowerCase());
}

// parse a single-range `Range: bytes=a-b` header against a known size. Returns { start, end } (inclusive,
// clamped) or null when there's no/blank range, or { unsatisfiable: true } when the range can't be served
// (so the caller can answer 416). We honor only the first range — enough for <video>/<audio> seeking, which
// is exactly what FileResponse / Electron's net stack give Hermes for free.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return { unsatisfiable: true };
  let start, end;
  if (m[1] === '') {                                  // suffix range: last N bytes
    const n = parseInt(m[2], 10);
    if (!n) return { unsatisfiable: true };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (!(start >= 0) || start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

// GET /api/file?agent=<id>&path=<rel> — read-only view of a file the agent produced, jailed to its
// workspace (resolveInside proves the path can't escape WORKSPACES/<agentId>/). Lets the user OPEN a
// deliverable from the app instead of digging through the filesystem. Served inline, never as an attachment.
// STREAMS the bytes (createReadStream, never the whole file in memory) and honors HTTP Range so the COMMS
// <video>/<audio> elements can seek — the Node analogue of Starlette's FileResponse in the Hermes gateway.
async function serveWorkspaceFile(req, res) {
  let abs;
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    const rel = u.searchParams.get('path') || '';
    ({ abs } = await fsJail.resolveInside(agent, rel));   // throws on jail escape / bad agentId / '..'
  } catch (e) {
    const msg = (e && e.message) || '';
    if (/escape|illegal|bad agentId|bad notebook/.test(msg)) { res.writeHead(403); return res.end('forbidden'); }
    res.writeHead(404); return res.end('not found');
  }
  let st;
  try { st = await fsp.stat(abs); } catch (_) { res.writeHead(404); return res.end('not found'); }
  if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }

  const ext = path.extname(abs).toLowerCase();
  const active = isActiveDeliverable(abs);
  const headers = {
    'Content-Type': active ? 'application/octet-stream' : (MIME[ext] || 'text/plain; charset=utf-8'),
    'Cache-Control': 'no-store',
    'Content-Disposition': (active ? 'attachment' : 'inline') + '; filename="' + safeDownloadName(abs) + '"',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes'   // advertise range support so the browser asks for byte ranges when seeking
  };
  if (active) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'";

  const range = parseRange(req.headers && req.headers.range, st.size);
  let start = 0, end = st.size - 1, code = 200;
  if (range && range.unsatisfiable) {
    res.writeHead(416, { 'Content-Range': 'bytes */' + st.size, 'Accept-Ranges': 'bytes' });
    return res.end();
  }
  if (range) {
    start = range.start; end = range.end; code = 206;
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
  }
  headers['Content-Length'] = (end - start + 1);

  // HEAD: browsers/players probe with it before streaming — answer headers only.
  if (req.method === 'HEAD') { res.writeHead(code, headers); return res.end(); }

  res.writeHead(code, headers);
  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => { try { res.destroy(); } catch (_) {} });
  req.on('close', () => { try { stream.destroy(); } catch (_) {} });   // client navigated away / closed the tab
  stream.pipe(res);
}
// GET /api/notebook?agent=<id> — read-only JSON view of the agent's own notebook (its memory.md in the
// dossier). The agent WRITES these notes itself via the notebook tool during runs; this route only reads
// them. Jailed by the same agentId validation as the notebook store; never writable over HTTP, and the
// store already lives outside the fs jail so the agent's fs.* tools can't touch it either.
function serveNotebook(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(403, { error: 'forbidden' });
    const raw = notebookStore.get('notebook:' + agent);
    const notes = Array.isArray(raw)
      ? raw.map(n => ({ id: n && n.id, title: String((n && n.title) || ''), body: String((n && n.body) || ''), ts: (n && n.ts) || 0 }))
      : [];
    json(200, { notes });
  } catch (e) { json(200, { notes: [] }); }   // tolerate missing/corrupt — empty memory, never a 500
}
// POST /api/notebook/restore { agent?, notes:[...] } — fold a backup's memory snapshot back into the agent's
// notebook (M-save P2). This is the ONLY HTTP write to the notebook, and it is user-initiated (import/restore),
// never reachable by the agent itself: the web tool's SSRF guard blocks 127.0.0.1 and the fs jail can't reach
// the store, so a run/prompt-injection cannot drive it. ADDITIVE merge by id (existing notes always win), so a
// restore can only ADD memory the target lacks — it can never destroy or mutate what the agent already formed.
async function handleNotebookRestore(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 8 << 20)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const agent = String(body.agent || 'agent');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(400, { error: 'agentId must be 1-40 chars of [A-Za-z0-9_-]' });
  const incoming = Array.isArray(body.notes) ? body.notes : [];
  try {
    // P1: merge under the per-agent lock, re-reading existing so a concurrent run's memory.write isn't lost.
    let existingLen = 0, mergedLen = 0;
    await notebookStore.update('notebook:' + agent, (prev) => {
      const existing = Array.isArray(prev) ? prev : [];
      const merged = mergeNotes(existing, incoming);
      existingLen = existing.length; mergedLen = merged.length;
      return merged;
    });
    json(200, { ok: true, total: mergedLen, added: mergedLen - existingLen });
  } catch (e) { json(400, { error: (e && e.message) || 'restore failed' }); }
}

// GET /api/save?agent=<id> — the durable agent save mirror (M-save). Returns the stored save envelope so the
// frontend can adopt it after a localStorage wipe (or pull the newer of local/remote on a normal boot). No
// secret is returned: the envelope never contains the API key/tokens. Missing -> { save: null }, never a 500.
function serveSaveLoad(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(403, { error: 'forbidden' });
    const doc = saveStore.load(agent);
    json(200, { save: doc || null });
  } catch (e) { json(200, { save: null }); }
}
// POST /api/save { agent?, ...envelope } — write through the localStorage save to durable disk. The body IS the
// save envelope (with its schema/version/updatedAt); `agent` selects the record (defaults to 'agent'). The
// store refuses a write whose updatedAt regressed, so a stale tab can't clobber a newer save (returns stale:true).
async function handleSaveWrite(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 8 << 20)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }   // up to 8MB (station + workstreams can be large)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'a save envelope object is required' });
  // the record key is the agent's OWN id — body.agent is the agent OBJECT ({id,name,...}), not a selector
  // string, so derive from body.agent.id (an explicit body.agentId wins if a future caller sends one).
  const agentId = String(body.agentId || (body.agent && body.agent.id) || 'agent');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(400, { error: 'agentId must be 1-40 chars of [A-Za-z0-9_-]' });
  try {
    const result = saveStore.save(agentId, body);
    json(200, result);
  } catch (e) { json(400, { error: (e && e.message) || 'save failed' }); }
}
// GET /api/runs?agent=<id>&limit=<n> — the agent's run history (M-save P4), newest-first. Read-only; the store
// is append-only and a sibling of the fs jail, so the agent can neither read nor rewrite its own history.
function serveRuns(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(403, { error: 'forbidden' });
    const limit = Math.max(1, Math.min(500, Number(u.searchParams.get('limit')) || 100));
    json(200, { runs: runStore.list(agent, { limit }) });
  } catch (e) { json(200, { runs: [] }); }   // tolerate any error — empty history, never a 500
}

// GET /api/insights?agent=<id> — H3.3: aggregate usage folded from the run history (overview, per-model spend,
// outcome breakdown, per-agent, runs/spend-over-time). Read-only; fail-open to an empty fold, never a 500.
function serveInsights(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent');
    if (agent && !/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(403, { error: 'forbidden' });
    const rows = agent ? runStore.list(agent, { limit: 1000 }) : runStore.all();   // agent-scoped or whole station
    json(200, foldInsights(rows, { nowMs: Date.now(), bucketMs: 3600000, buckets: 24 }));
  } catch (e) { json(200, { totalRuns: 0, totalUsd: 0, byModel: [], byReason: {}, byAgent: [], overTime: [] }); }
}

// GET /api/transcript?stream=<id>&agent=<id>&limit=<n> — the durable per-workstream conversation transcript
// (P0.1), chronological. Feeds a server-side autopsy/replay view and recovers headless-run dialogue (the
// browser's own COMMS history persists via the save-envelope mirror). Read-only; fail-open, never a 500.
function serveTranscript(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(403, { error: 'forbidden' });
    const stream = u.searchParams.get('stream') || 'global';
    const limit = Math.max(1, Math.min(500, Number(u.searchParams.get('limit')) || 200));
    json(200, { stream, turns: transcriptStore.history(stream, { limit }) });
  } catch (e) { json(200, { turns: [] }); }   // tolerate any error — empty transcript, never a 500
}

// GET /api/memory/proposals?agent=<id>&run=<id> — the pending Keep/Edit/Discard candidates reflection raised
// for a run (with content; the memory.proposed SSE event is just the trigger and carries no content). Read-only;
// falls back to the agent's newest pending batch when the runId is unknown. Empty (never a 500) if none.
function serveProposals(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(403, { error: 'forbidden' });
    const runId = u.searchParams.get('run') || '';
    let batch = runId && proposalsByRun.get(runId);
    if (!batch) { const lr = latestProposalRun.get(agent); batch = lr && proposalsByRun.get(lr); }
    if (!batch || batch.agentId !== agent) return json(200, { runId: runId || null, agentId: agent, proposals: [] });
    json(200, { runId: batch.runId, agentId: agent, proposals: batch.proposals });
  } catch (e) { json(200, { proposals: [] }); }
}

// POST /api/memory/turnin { agentId, runId, id, verdict:'keep'|'edit'|'discard', content? } — resolve ONE proposal.
// Keep/Edit COMMIT a real §5.2 record (the user's click IS the consent §5.6) -> memory.write; EVERY verdict ->
// memory.feedback (Keep/Edit positive, Discard negative) so the agent's confidence tracks proposal acceptance.
// Events ride the SSE bus (the run stream is closed) so they reach the browser U.bus exactly once — no double-count.
async function handleMemoryTurnin(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const agentId = String(body.agentId || 'agent');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(403, { error: 'forbidden' });
  const runId = String(body.runId || '');
  const id = String(body.id || '');
  const verdict = String(body.verdict || '');
  const fb = feedbackFor(verdict);
  if (!fb) return json(400, { error: 'verdict must be keep, edit, or discard' });
  const batch = proposalsByRun.get(runId);
  const prop = batch && batch.agentId === agentId && batch.proposals.find(p => p.id === id);
  if (!prop) return json(404, { error: 'no such proposal (it may have expired)' });
  // resolved either way — drop it from the pending batch (and the batch entry when it empties)
  batch.proposals = batch.proposals.filter(p => p.id !== id);
  if (!batch.proposals.length) { proposalsByRun.delete(runId); if (latestProposalRun.get(agentId) === runId) latestProposalRun.delete(agentId); }

  let writtenId = null;
  if (verdict === 'discard') {
    // no record is written; the negative feedback still calibrates confidence (a quality=0 sample). The proposal's
    // transient id won't match a stored record — that's fine; this signal is "the agent's pick was rejected".
    chanEmit('memory.feedback', { agentId, id: prop.id, delta: fb.delta, reason: fb.reason });
    return json(200, { ok: true, verdict, id: null });
  }
  const content = (verdict === 'edit' ? String(body.content != null ? body.content : prop.content) : prop.content).trim();
  if (!content) return json(400, { error: 'a kept memory cannot be empty' });
  // P1: write the kept record under the per-agent lock, RE-READING the list so the id (positional) is minted
  // against the current notebook and a concurrent run's memory.write isn't clobbered by this whole-array set.
  let rec = null;
  await notebookStore.update('notebook:' + agentId, (stored) => {
    const list = Array.isArray(stored) ? stored : [];
    writtenId = memcore.nextNoteId(list);   // collision-proof (positional length reuses a slot freed by forget)
    rec = recordFromProposal(prop, { now: Date.now(), runId: runId || prop.sourceRunId, id: writtenId, content });
    rec.trust = memcore.nextTrust(rec.trust, fb.delta);   // M-mem.6: the keep/edit verdict seeds real trust (a reduction, not 0)
    list.push(rec);
    return list;
  });
  chanEmit('memory.write', { agentId, runId: runId || rec.sourceRunId || writtenId, id: writtenId, kind: rec.kind, scope: rec.scope });
  chanEmit('memory.feedback', { agentId, id: writtenId, delta: fb.delta, reason: fb.reason });
  json(200, { ok: true, verdict, id: writtenId, kind: rec.kind });
}

// GET /api/memory/records?agent=<id> — the FULL §5.2 records for the Memory Core panel (the /api/notebook
// route deliberately projects away kind/provenance/stats). Read-only; redacted on the way out (defence in
// depth — a hand-jotted note never went through redact at write time); empty on any error, never a 500.
function serveMemoryRecords(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(403, { error: 'forbidden' });
    const raw = notebookStore.get('notebook:' + agent);
    const nowMs = Date.now();   // surface effectiveTrust (time-decayed) so the panel shows earned-vs-current trust
    const records = Array.isArray(raw) ? raw.map(r => redact(memcore.projectRecord(r, nowMs))) : [];
    json(200, { agentId: agent, records });
  } catch (e) { json(200, { records: [] }); }
}

// the three Memory Core mutations (pin / edit / forget). The user's click IS the consent (§5.6) — this is the
// user editing their OWN visible store, not an agent outward effect, so there is no permission prompt. Each
// validates agentId, mutates the store through a PURE memcore op, and (forget) emits the frozen memory.forget
// rung over the SSE bus. `op(list, body)` -> { records, found, error?, emit?, extra? }.
async function handleMemoryMutate(req, res, op) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const agentId = String(body.agentId || 'agent');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(403, { error: 'forbidden' });
  if (!String(body.id || '')) return json(400, { error: 'id required' });
  const key = 'notebook:' + agentId;
  // P1: apply the pure memcore op under the per-agent lock, RE-READING the list so a concurrent run's
  // memory.write/used fold isn't clobbered by this whole-array set. Only persist on a real change.
  let r = null;
  await notebookStore.update(key, (stored) => {
    const list = Array.isArray(stored) ? stored : [];
    r = op(list, body, agentId);
    return (r.error || !r.found) ? undefined : r.records;   // skip the write on error / not-found
  });
  if (r.error) return json(400, { error: r.error });
  if (!r.found) return json(404, { error: 'no such memory' });
  if (r.emit) { try { chanEmit(r.emit.name, r.emit.payload); } catch (_) {} }
  return json(200, Object.assign({ ok: true, id: String(body.id) }, r.extra || {}));
}
function handleMemoryPin(req, res) {
  return handleMemoryMutate(req, res, (list, body) => {
    const out = memcore.applyPin(list, String(body.id), !!body.pinned);
    out.extra = { pinned: !!body.pinned };
    return out;
  });
}
function handleMemoryEdit(req, res) {
  return handleMemoryMutate(req, res, (list, body) => {
    const content = redact(String(body.content == null ? '' : body.content)).trim();   // §5.6: scrub secrets before persisting
    if (!content) return { found: false, error: 'edited memory cannot be empty' };
    return memcore.applyEdit(list, String(body.id), content);
  });
}
function handleMemoryForget(req, res) {
  return handleMemoryMutate(req, res, (list, body, agentId) => {
    const out = memcore.applyForget(list, String(body.id));
    // memory.forget's FIRST producer (the rung was frozen in M-mem.1 with no emitter until now).
    if (out.found) out.emit = { name: 'memory.forget', payload: { agentId, id: String(body.id), reason: String(body.reason || 'user') } };
    return out;
  });
}
async function serveStatic(req, res) {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = (url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
    const abs = path.resolve(FRONTEND, rel);
    if (abs !== FRONTEND && abs.indexOf(FRONTEND + path.sep) !== 0) { res.writeHead(403); return res.end('forbidden'); }
    let data = await fsp.readFile(abs);
    if (abs.toLowerCase() === path.resolve(FRONTEND, 'index.html').toLowerCase()) {
      let boot = '<script>window.__STARNET_API_TOKEN__=' + JSON.stringify(API_TOKEN) + ';';
      // DEV fast-path: hand the page a model + provider hint so a fresh origin auto-resumes the seeded
      // save with no setup. No secret crosses here — the key stays server-side in runtimeKey.
      if (DEV_MODE) boot += 'window.__STARNET_DEV__=' + JSON.stringify({ model: CRON_DEFAULT_MODEL || '', prov: (!runtimeKey && codexTokens && codexTokens.access_token) ? 'codex' : 'openrouter' }) + ';';
      boot += '</script>';
      data = Buffer.from(String(data).replace(/<\/head>/i, boot + '\n</head>'), 'utf8');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('not found'); }
}
