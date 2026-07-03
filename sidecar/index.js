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
const { makeCredits } = require('./credits.js');   // managed-credit backend adapter (inert unless STARNET_CREDITS_URL is set)
const budgetCaps = require('./budgetcaps.js');   // pure resolve(env,overrides) + validate patch — SETTINGS→Budget (P0-2)
const fallbackChain = require('./fallbackchain.js');   // pure resolve(env,saved) + validate patch — SETTINGS→Models fallback chain (P0-3)
const { makeConcurrencyGate } = require('./concurrency.js');
const { killAll } = require('./halt.js');
const { makeRegistry } = require('./tools/registry.js');
const { makeWebTools } = require('./tools/builtin/web.js');
const { makeBrowserTools } = require('./tools/builtin/browser.js');
const { makeComputerTools } = require('./tools/builtin/computer.js');
const { makeDesktopTools } = require('./tools/builtin/desktop.js');
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
const { makeArtifactCollector } = require('./artifacts.js');   // work-visibility: per-run "what did it produce" ledger
const { makeTranscriptStore } = require('./transcriptstore.js');
const { makeSkillStore } = require('./skillstore.js');             // H4: per-agent owned skill library (singleton)
const { makeCredPool } = require('./credpool.js');
const { resolveTools } = require('./capability/resolve.js');
const { CAP_REGISTRY } = require('./capability/registry.js');
const { toolsetRows, toggleableCaps } = require('./capability/toolsets.js');   // TOOLSETS console: capId families derived from CAP_REGISTRY
const { makeCapCtx } = require('./capability/capGate.js');
const { composeOffice } = require('./capability/office.js');   // THE MOAT: interactive office = compute freebie + placed caps
const { summarizeCapabilities } = require('./capability/capsummary.js');   // truthful "what you can/can't do" so the agent stops over-promising
const { starnetManual } = require('./manual.js');   // truthful "how StarNet works" so the agent can guide a stuck Commander (interactive only)
const { makeOpenRouterProvider } = require('./providers/openrouter.js');
const {
  selectProvider,
  listProviderProfiles,
  getProviderProfile,
  normalizeProviderId: normalizeProviderIdFromRegistry,
  providerUsesCodex: registryProviderUsesCodex,
  defaultReasoningEffortForProvider: registryDefaultReasoningEffort,
  providerRequiresKey,
  providerRequiresBaseUrl
} = require('./providers/factory.js');
const { DEFAULT_MODEL: CODEX_DEFAULT_MODEL } = require('./providers/codex.js');
const codexAuth = require('./providers/codex-auth.js');
const codexTokenStore = require('./providers/codex-token-store.js');
const { effectiveModel: resolveEffectiveModel, effectiveUsd } = require('./spend.js');
const { makeEmitter } = require('../shared/emitter.js');
const { redact, renderRecall, injectRecall, rank, makeContext, compactionMemoryBlock, compactionSummaryPrompt } = require('./context.js');
const { reflect, reflectSalient, recordFromProposal, feedbackFor, highStakes } = require('./reflect.js');
// GROWTH Tier 1 — the pure STUDY ENGINE (the dossier's Phase B). A UMD frontend module that also exports under
// node, so the sidecar reuses the SAME parse/salience/dedup the browser consent path uses. Fail-open: if it can't
// load, study just never fires (a run stays byte-identical). No new npm dep — it's a first-party file.
let Study = null; try { Study = require('../frontend/app/study.js'); } catch (_) { Study = null; }
const { runtimeIdentityBlock } = require('./runtimeinfo.js');
const memcore = require('./memcore.js');
const { makeConsentBroker } = require('./permissions.js');
const { makeGrantManager } = require('./permgrants.js');
const { makeTelegramAdapter } = require('./channels/telegram.js');
const { makeChannelStore } = require('./channels/store.js');
const { makeChannelHub } = require('./channels/hub.js');
const { makeChannelRegistry, wireChannel } = require('./channels/registry.js');   // H6.2: channel descriptors + generic wire-up
const { makeConnectGateway } = require('./channels/discord.gateway.js');           // P2-E: the real Discord gateway WS client (inbound)
const { makeSseHub, runTeeView } = require('./channels/sse.js');
const { makeRouter } = require('./routing/router.js');
const { makeConnectorManager } = require('./mcp/manager.js');
const { makeHttpTransport } = require('./mcp/transport.http.js');
const { makeStdioTransport } = require('./mcp/transport.stdio.js');
const cron = require('./cron.js');                         // pure schedule math (parse/nextFire/planTick)
const cronStore = require('./cron-store.js');              // pure CronJob lifecycle reducer
const { makeCronDriver } = require('./cron-driver.js');    // the autonomous tick driver (ambient deps injected here)
const { makeAutoNotifier } = require('./autonotify.js');   // B4: ping a connected channel when a cron run produces work
const configExport = require('./configexport.js');   // P1-7: station backup — export/import/reset (pure shape+redaction; index wires the live stores)
const { writeFileDurable } = require('./durable-write.js'); // G4.2: crash-safe atomic+durable single-file replace (fsync-before-rename)
const { makeKeyedMutex, readJsonResilient, writeJsonResilient } = require('./durable-store.js'); // P1/P2: per-key serialized + last-known-good-recoverable single-file JSON stores
const { makeMemoryStore, resetAgentMemory, restoreDeclined } = require('./memory-store.js'); // durable notebook:/todo:/declined: sibling stores
const { makeWorkshopStore } = require('./workshop-store.js'); // durable per-agent away-workshop grant + backlog + discard denylist
const { tailLines, loadBounded, rotateIfLarge } = require('./logbound.js'); // P3: bounded boot-load + size rotation for the append-only JSONL logs
const { makeCronLock } = require('./cron-lock.js');         // G4.3: cross-process exactly-once advisory lock (O_EXCL+pid:nonce+stale-break)
const { withDossier } = require('./dossierinject.js');     // Phase C: fold the Commander dossier into server-composed (cron) personas
const skillsCatalog = require('./skills/catalog.js');      // bundled capability-gated recipe library (parse/load/gate/compose)
const { makeSkillPrefs } = require('./skills/prefs.js');   // persisted enable/disable choices for the recipe library
const runtimeSkills = require('./skills/runtime.js');       // runtime-created skill index (metadata only)
const skillPackages = require('./skills/package.js');       // package-backed SKILL.md mirror for runtime skills
const skillGuard = require('./skills/guard.js');            // guard scanner for runtime/external skill packages
const skillReview = require('./skillreview.js');            // background skill maintenance trigger/prompt
const skillCurator = require('./skillcurator.js');          // skill lifecycle/consolidation maintenance
const slash = require('./slash.js');                       // slash-command catalog + dispatch descriptors
const Recipes = require('../frontend/app/recipes.js');     // built-in mission recipes, also exposed as slash commands
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
const sharedSpecialties = require('../shared/specialties.js');   // Class Loadouts S1: the ONE class catalog — no hardcoded class prose here
// the specialist classes as {id, tagline}, composed from the shared catalog so team.summon's class list +
// the [ORCHESTRATION] teamNote never drift from the Recruitment Bay (single source of truth).
const SPECIALIST_CLASSES = (sharedSpecialties.BUILTINS || []).map(s => ({ id: s.id, tagline: s.tagline || '' }));

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
// the per-launch token (GET data routes included) except a small header-less set. Native media/file loads
// can pass the same token as ?token= on /api/file only; all other fetch-driven calls use the custom header.
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
  // Native browser surfaces (<img>, <video>, <audio>, and clicked links) cannot attach custom headers.
  // Keep /api/file token-gated by accepting the same per-launch token in the query string for GET/HEAD only.
  if ((req.method === 'GET' || req.method === 'HEAD') && apiauth.pathOf(req.url) === '/api/file' && apiauth.queryTokenOk(req, API_TOKEN)) return false;
  res.writeHead(403); res.end('forbidden token'); return true;
}
// Desktop build: live BYOK keys are seeded from the OS keychain via env at spawn, and updated
// in place via the token-guarded POST /api/key (the parent shell pushes changes; no restart).
// runtimeKey remains the OpenRouter back-compat alias for older routes/tool shims.
const runtimeKeys = Object.create(null);
const runtimeBaseUrls = Object.create(null);
let runtimeKey = String(ENV('OPENROUTER_KEY') || '').trim();
if (runtimeKey) runtimeKeys.openrouter = runtimeKey;
// OpenRouter base URL override (env SKYNET_OPENROUTER_BASE). Default undefined -> the provider's own
// https://openrouter.ai/api/v1. Lets a user point at an OR-compatible proxy, and lets the boot+run E2E aim
// the provider at a local mock so the real streaming path is tested end-to-end without a live key.
const OPENROUTER_BASE = String(ENV('OPENROUTER_BASE') || '').trim() || undefined;
const FRONTEND = path.resolve(__dirname, '..', 'frontend');
// Class Loadouts S1: the browser needs the SHARED catalog (shared/specialties.js) as a <script>, but the
// static server jails to FRONTEND (a /../shared request is 403). Serve the shared/ dir through a narrow,
// read-only, .js-only allowlist so the browser + the desktop bundle (which ships ../shared as a resource)
// can load it without escaping into arbitrary repo files. Path-jailed to SHARED exactly like FRONTEND.
const SHARED = path.resolve(__dirname, '..', 'shared');
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

/* ---- P1-9 ADVANCED runtime knobs: a handful of limits that were environment-only (MAX_ITERS,
   MAX_CONCURRENT_AGENTS, the consent timeout, the cron tick) are now editable + PERSISTED so a beginner who can't
   set env vars can still tune them. PRECEDENCE is strict and disclosed in the UI: an explicit ENVIRONMENT VARIABLE
   ALWAYS WINS (a locked-down deploy stays in control), else a value SAVED here, else the built-in default. Read at
   BOOT (these feed const CAPS / gates), so a change applies on the next restart — the UI says so. Stored in a
   PROTECTED sibling of the fs jail (runtime.knobs.json). Loaded with a tiny self-contained reader (this runs before
   loadResilient/num are defined); a torn/absent file → no overrides (fail-soft to env/default). */
const RUNTIME_KNOBS_FILE = path.join(WORKSPACES, 'runtime.knobs.json');
let runtimeKnobs = (function loadRuntimeKnobsAtBoot() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_KNOBS_FILE, 'utf8'));
    const k = (raw && typeof raw === 'object' && raw.knobs && typeof raw.knobs === 'object') ? raw.knobs : {};
    const out = {};
    for (const key of ['maxIters', 'maxConcurrentAgents', 'consentTimeoutMs', 'cronTickMs']) {
      const v = k[key];
      if (typeof v === 'number' && isFinite(v) && v >= 0) out[key] = Math.floor(v);
    }
    return out;
  } catch (_) { return {}; }
})();
// resolve a knob: explicit env (via ENV suffix) > saved override > built-in default. envSuffix null = no env for it.
function resolveKnob(envSuffix, savedKey, def) {
  if (envSuffix) { const e = ENV(envSuffix); if (e != null && String(e).trim() !== '' && Number(e) >= 0) return Math.floor(Number(e)); }
  const s = runtimeKnobs[savedKey];
  return (typeof s === 'number' && s >= 0) ? s : def;
}
function knobEnvLocked(envSuffix) { const e = envSuffix ? ENV(envSuffix) : null; return e != null && String(e).trim() !== '' && Number(e) >= 0; }

// maxIters: per-run tool-turn ceiling. Raised 16→40 (P0.3) so real multi-step work isn't truncated early;
// env-overridable, now also UI-tunable (resolveKnob: env > saved > default). The loop adds one grace turn on top.
const CAPS = { maxIters: resolveKnob('MAX_ITERS', 'maxIters', 40), maxCostUsd: 1.00, maxRepeat: 3, toolTimeoutMs: 30000, maxToolBytes: 120000 };
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
const MAX_CONCURRENT_AGENTS = resolveKnob('MAX_CONCURRENT_AGENTS', 'maxConcurrentAgents', 3);   // P1-9: env > saved > default
// Stage 2: per-WORKER USD ceiling for a delegated sub-run, so the lead fanning out to a crew can't let one
// runaway worker blow the lead's own per-run cap. 0 = ungoverned (the cross-run pools still apply).
const ORCH_PER_WORKER = num(ENV('BUDGET_PER_WORKER'), 1);
// ---- MANAGED CREDITS (opt-in, config-gated). The whole managed-credit path is INERT unless STARNET_CREDITS_URL
// points at a credits backend: no payment client is built, admission stays pure BYOK, no STORE UI renders, and
// /api/credits 404s (the honesty law — a control that does nothing is a bug). When wired, a managed account can
// run without BYOK: each run RESERVES its per-run cap against the account before the model is called, and the
// unused headroom is refunded at settle (see sidecar/credits.js + sidecar/billing.js). The purchase flow is an
// external link only — this app never renders a payment form. STARNET_CREDITS_ACCOUNT names the account to bill.
const CREDITS_URL = String(ENV('CREDITS_URL') || '').trim();
const CREDITS_API_KEY = String(ENV('CREDITS_API_KEY') || '').trim();
const CREDITS_ACCOUNT = String(ENV('CREDITS_ACCOUNT') || '').trim();
const CREDITS_PURCHASE_URL = String(ENV('CREDITS_PURCHASE_URL') || '').trim();
// a live permission.prompt left unanswered this long auto-denies (never hangs a run). P1-9: env
// STARNET_CONSENT_TIMEOUT_MS > a UI-saved override > the 120s default; the frozen resolve keeps it constant per boot.
const CONSENT_TIMEOUT_MS = resolveKnob('CONSENT_TIMEOUT_MS', 'consentTimeoutMs', 120000);
// ---- cron / scheduled routines (autonomous, OPT-IN). The whole subsystem is INERT unless SKYNET_CRON_ENABLED
// is set: no timer is armed, no run is fired, and the browser path is byte-identical. A fire uses the same
// provider seam as /api/run: OpenRouter needs the live BYOK key (runtimeKey), while Codex uses the protected
// ChatGPT OAuth token. A job with no model falls back to the selected agent model or SKYNET_DEFAULT_MODEL;
// absent model/credentials, a due job no-capability-skips rather than firing. Cadence + the self-healing lease
// ceiling are env-tunable. The fire's consent surface is 'autonomous' (default-deny ungranted mutation).
const CRON_ENABLED = /^(1|true|yes|on)$/i.test(String(ENV('CRON_ENABLED') || '').trim());
const CRON_TICK_MS = resolveKnob('CRON_TICK_MS', 'cronTickMs', 60000);   // P1-9: env > saved > default
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
   secrets, codex tokens, connectors, allowlist, notebook, cron routines). Each of these was a plain
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
/* ---- managed credits (config-gated). Shares the SAME spend ledger as the run finalizer, so a managed run's
   final truth lands in one place. INERT (configured() === false) unless CREDITS_URL is set — then admission can
   reserve/refund against a managed account and the STORE surface + /api/credits come alive. */
// NB: no `ledger` is passed — the run finalizer below is the SINGLE ledger writer (drives the budget pools).
// billing.js therefore does refund-only settlement here; the managed account's own spend record lives on the
// credits backend (posted via debit/credit), so the local ledger is never double-counted for a managed run.
const credits = makeCredits({
  url: CREDITS_URL, apiKey: CREDITS_API_KEY, accountId: CREDITS_ACCOUNT, purchaseUrl: CREDITS_PURCHASE_URL,
  fetch: globalThis.fetch, clock: { now: () => Date.now() },
  onError: (stage, err) => console.warn('[credits] ' + stage + ' failed:', (err && err.message) || err)
});
if (credits.configured()) { credits.refresh().catch(() => {}); }   // warm the balance cache at boot (fail-open)

/* ---- P0-2 budget-caps persistence (SETTINGS → Budget). The four USD caps were env-only; now they persist in a
   PROTECTED sibling file (durable + .bak, like connectors/permissions) and apply LIVE to the running governor
   without a restart. PRECEDENCE (additive, never breaks an env deploy): a persisted key wins, else the env
   default (BUDGET_CAPS). A persisted key may be 0 = "no cap" (ungoverned) — that is a REAL saved choice and
   overrides a non-zero env default, so a Commander can dial a cap OFF from the UI. `effectiveCaps` is the single
   mutable source the status endpoint + loop read; BUDGET_CAPS stays the frozen env-default fallback. */
const BUDGET_FILE = path.join(WORKSPACES, 'budget.json');
const BUDGET_CAP_KEYS = budgetCaps.KEYS;
// the caps actually in force this process = persisted-or-env, recomputed by applyBudgetCaps(). Starts = env defaults.
let effectiveCaps = Object.assign({}, BUDGET_CAPS);
let budgetOverrides = {};   // only the keys the user has explicitly saved (each a finite >=0 number); absent = use env
function loadBudgetOverrides() {
  try {
    const raw = loadResilient(BUDGET_FILE, 'budget');
    const caps = (raw && typeof raw.caps === 'object' && raw.caps) ? raw.caps : {};
    return budgetCaps.cleanOverrides(caps);   // drops any junk/negative value -> that key silently falls back to env
  } catch (e) { return {}; }   // unrecoverable -> fall back entirely to env defaults
}
function saveBudgetOverrides() {
  try { saveResilient(BUDGET_FILE, { version: 1, caps: budgetOverrides }); }   // fsync-durable + .bak last-known-good
  catch (e) { console.warn('[budget] persist failed:', (e && e.message) || e); }
}
// recompute effectiveCaps from (persisted override ?? env default) and push the cross-run pools into the live
// governor. Called at boot and after every saved cap change — no restart needed.
function applyBudgetCaps() {
  effectiveCaps = budgetCaps.resolveCaps(BUDGET_CAPS, budgetOverrides);
  // perDay/perAgent/global are the SOFT cross-run pools the governor owns; perRun is the loop's per-run hard ceiling
  // (read from effectiveCaps at run time — see runAgentLoop limits), so it needs no setCaps push.
  budget.setCaps({ agent: effectiveCaps.perAgent, day: effectiveCaps.perDay, global: effectiveCaps.global });
}
budgetOverrides = loadBudgetOverrides();
applyBudgetCaps();

/* ---- P0-3 fallback-chain persistence (SETTINGS → Models). The ordered "if the primary model fails, try these
   next" list was env-only (SKYNET_FALLBACK_MODELS) — nothing but that env var ever set it. Now it persists in a
   PROTECTED sibling file (durable + .bak, like budget/connectors) and applies LIVE to every run path (browser,
   cron, channels) without a restart. PRECEDENCE (additive, never breaks an env deploy): a SAVED chain wins — even
   the saved-empty "no fallback" choice beats a non-empty env default (that's how the UI turns the chain OFF); an
   ABSENT saved chain (never saved) follows the env default. An explicit per-RUN request list (o.fallbackModels
   from the browser) still overrides both — that layering lives in runOnce. `fallbackSaved` is null until the user
   saves; ENV_FALLBACK is the frozen env-default baseline. The loop CONSUMES this chain on a shouldFallback /
   shouldRotateCredential error class (errorClass.js): overloaded (502/503), server_error (500), model_not_found
   (404), and auth/billing/rate_limit — see loop.js. */
const FALLBACK_FILE = path.join(WORKSPACES, 'fallback.json');
const ENV_FALLBACK = fallbackChain.parseEnvChain(ENV('FALLBACK_MODELS') || '');   // frozen env default baseline
let fallbackSaved = null;   // null = never saved (use env); an array (incl. []) = an explicit saved choice that wins
function loadFallbackChain() {
  try {
    const raw = loadResilient(FALLBACK_FILE, 'fallback');
    if (raw && Array.isArray(raw.models)) return fallbackChain.cleanChain(raw.models);   // present (incl. empty) -> explicit choice
    return null;   // no file / no models key -> never saved -> env default
  } catch (e) { return null; }   // unrecoverable -> fall back entirely to env default
}
function saveFallbackChain() {
  // null = the user reset to env default: remove the file so a torn/leftover blob can't resurrect a stale chain.
  if (fallbackSaved == null) { try { fs.unlinkSync(FALLBACK_FILE); } catch (_) {} try { fs.unlinkSync(FALLBACK_FILE + '.bak'); } catch (_) {} return; }
  try { saveResilient(FALLBACK_FILE, { version: 1, models: fallbackSaved }); }   // fsync-durable + .bak last-known-good
  catch (e) { console.warn('[fallback] persist failed:', (e && e.message) || e); }
}
// the fallback chain actually in force for a run that DOESN'T carry its own per-run list = saved-or-env.
function effectiveFallbackChain() { return fallbackChain.resolveChain(ENV_FALLBACK, fallbackSaved); }
fallbackSaved = loadFallbackChain();

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
const SKILL_PACKAGES_DIR = path.join(WORKSPACES, 'skill-packages');
const skillPackageStore = skillPackages.makePackageStore({ fs, pathMod: path, root: SKILL_PACKAGES_DIR });
const skillStore = makeSkillStore({ io: skillsIo, clock: { now: () => Date.now() }, redact, packageStore: skillPackageStore, guard: skillGuard });

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
// LIVE STEERING: runId -> [pending Commander notes]. POST /api/run/steer appends; the loop's injected steer()
// drains once per iteration (see runAgentLoop o.steer). A note only lands while the run is IN-FLIGHT (its runId
// is still in `runs`); once the run ends the entry is dropped, so a stale steer can never reach a later run.
const steerBuffers = new Map();
function drainSteer(runId) { const b = steerBuffers.get(runId); if (!b || !b.length) return []; steerBuffers.set(runId, []); return b; }
const STEER_MAX_PENDING = 8;      // bound the buffer so a spammed steer can't grow unbounded between iterations
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
      approvalMode: ((a && a.approvalMode) === 'full') ? 'full' : 'ask',   // per-agent consent posture: 'full' bypasses the gate (see runOnce)
      // Class Loadouts S1 (additive): the agent's class SKILL PACKAGE + applied reasoning effort. Old rosters
      // without these load unchanged (skills -> [], reasoningEffort -> null). skills are slugs, deduped + capped.
      skills: Array.isArray(a && a.skills) ? [...new Set(a.skills.map(s => String(s || '').trim()).filter(Boolean))].slice(0, 40) : [],
      reasoningEffort: (a && a.reasoningEffort) ? String(a.reasoningEffort) : null
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
    const agents = [...agentRoster].map(([agentId, a]) => ({ agentId, system: a.system || '', name: a.name || agentId, model: a.model || null, provider: a.provider || null, role: a.role || '', skills: Array.isArray(a.skills) ? a.skills : [], reasoningEffort: a.reasoningEffort || null }));   // Class Loadouts S1: persist per-agent skill package + effort
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
  onCorrupt: (key, file) => quarantineCorrupt(file, String(key).indexOf('todo:') === 0 ? 'todo' : (String(key).indexOf('declined:') === 0 ? 'declined' : 'notebook')),
  warn: (...args) => console.warn.apply(console, args)
});

// AWAY WORKSHOP — per-agent durable state for "Build things while I'm away": the Commander's recorded grant,
// the build backlog, and the permanent discarded-backlogId denylist. A sibling of the notebooks (WORKSPACES/
// <aid>.workshop.json), OUTSIDE the agent's fs jail so its own fs.* tools can neither read nor corrupt it. Same
// durable+recovery discipline as notebookStore. workshopOf(agentId) is the pure predicate the consent broker
// consults (W1): an autonomous, jail-scoped WRITE clears the cache tier ONLY for a granted agent.
const workshopStore = makeWorkshopStore({
  fs: fs, path: path, workspaces: WORKSPACES, writeDurable: writeFileDurable,
  onRecover: (key, file) => console.warn('[workshop] recovered ' + file + ' from .bak last-known-good after a torn/corrupt main.'),
  onCorrupt: (key, file) => quarantineCorrupt(file, 'workshop'),
  warn: (...args) => console.warn.apply(console, args)
});
function workshopOf(agentId) { try { return workshopStore.hasGrant(String(agentId || '')); } catch (_) { return false; } }

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

// GROWTH Tier 2 — the ACTIVE goal-arc summary, pushed by the browser (POST /api/goals) and folded into server-
// composed autonomous personas (cron) so an unattended run knows the current direction (goal + progress + next
// step). A sibling of the dossier block (outside every agent's fs jail); survives a restart. A null goal clears it
// (no active arc). Contract-free: plain HTTP, no bus event — mirrors commanderDossier exactly.
const GOALS_FILE = path.join(WORKSPACES, '_commander.goals.json');
const commanderGoals = {
  _goal: null,
  get() { return this._goal; },
  set(goal) {
    this._goal = (goal && typeof goal === 'object') ? {
      text: String(goal.text || '').slice(0, 280),
      done: Number(goal.done) | 0, total: Number(goal.total) | 0, pct: Number(goal.pct) | 0,
      next: goal.next == null ? null : String(goal.next).slice(0, 200)
    } : null;
    try {
      fs.mkdirSync(WORKSPACES, { recursive: true });
      saveResilient(GOALS_FILE, { goal: this._goal });
    } catch (e) { console.warn('[goals] persist failed:', (e && e.message) || e); }
  },
  load() { const o = loadResilient(GOALS_FILE, 'goals'); if (o && o.goal && typeof o.goal === 'object') this._goal = o.goal; },
  // the one-line note folded into a cron persona: "Current goal: X (2/5 milestones done). Next: Y." '' when none.
  note() {
    const g = this._goal;
    if (!g || !g.text) return '';
    let s = 'Current goal: ' + g.text + ' (' + g.done + '/' + g.total + ' milestones done).';
    if (g.next) s += ' Next step: ' + g.next + '.';
    return s;
  }
};
commanderGoals.load();

function cronIdentityFor(agentId) {
  const id = String(agentId || 'agent');
  const ident = agentRoster.get(id);
  if (!ident) return null;
  const system = String(ident.system || '').trim();
  return {
    model: ident.model || null,
    provider: ident.provider || null,
    system: system ? withDossier(system + CRON_ROUTINE_NOTE, dossierWithGoals()) : null,
    name: ident.name || id
  };
}
// GROWTH Tier 2: the dossier block a cron persona folds in, with the active goal-arc note appended (direction the
// unattended run should work toward). Empty when both are empty → withDossier stays a no-op (the cron test invariant).
function dossierWithGoals() {
  const block = commanderDossier.get();
  const note = commanderGoals.note();
  if (!note) return block;
  return block ? (block + '\n\n' + note) : note;
}
function cronSystemFor(agentId) {
  const ident = cronIdentityFor(agentId);
  return (ident && ident.system) || withDossier(CRON_PERSONA, dossierWithGoals());
}
function cronModelFor(job) {
  const ident = cronIdentityFor(job && job.agentId);
  const rosterModel = ident && ident.model ? String(ident.model).trim() : '';
  return ((job && job.model) ? String(job.model).trim() : '') || rosterModel || CRON_DEFAULT_MODEL;
}
function normalizeProviderId(value) {
  return normalizeProviderIdFromRegistry(value, '');
}
function envFirst(names) {
  for (const name of (Array.isArray(names) ? names : [])) {
    const direct = process.env[name];
    if (direct != null && String(direct).trim()) return String(direct).trim();
    const scoped = ENV(name);
    if (scoped != null && String(scoped).trim()) return String(scoped).trim();
  }
  return '';
}
function providerRuntimeKey(provider, explicitKey) {
  const id = normalizeProvider(provider);
  if (registryProviderUsesCodex(id)) return '';
  const explicit = String(explicitKey || '').trim();
  if (explicit) return explicit;
  const runtime = String(runtimeKeys[id] || '').trim();
  if (runtime) return runtime;
  const profile = getProviderProfile(id);
  if (id === 'openrouter') return runtimeKey || envFirst(profile && profile.keyEnv);
  return envFirst(profile && profile.keyEnv);
}
function providerRuntimeBaseUrl(provider, explicitBaseUrl) {
  const id = normalizeProvider(provider);
  const explicit = String(explicitBaseUrl || '').trim();
  if (explicit) return explicit;
  const runtime = String(runtimeBaseUrls[id] || '').trim();
  if (runtime) return runtime;
  const profile = getProviderProfile(id);
  return envFirst(profile && profile.baseUrlEnv) || (profile && profile.baseUrl) || '';
}
function providerHasCredential(provider, key, baseUrl) {
  const id = normalizeProvider(provider);
  if (registryProviderUsesCodex(id)) return !!(codexTokens && codexTokens.access_token);
  if (providerRequiresBaseUrl(id) && !String(baseUrl || '').trim()) return false;
  if (providerRequiresKey(id) && !String(key || '').trim()) return false;
  return true;
}
function providerCredentialError(provider) {
  const id = normalizeProvider(provider);
  const profile = getProviderProfile(id);
  const label = (profile && profile.label) || id;
  if (registryProviderUsesCodex(id)) return 'connect ChatGPT first - a signed-in ChatGPT account + model are required';
  if (providerRequiresBaseUrl(id)) return 'configure the ' + label + ' base URL';
  if (providerRequiresKey(id)) return 'connect a ' + label + ' API key';
  return 'provider is not configured';
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
  return providerRuntimeKey(provider, '');
}
function cronHasCredential(provider, key) {
  return providerHasCredential(provider, key, providerRuntimeBaseUrl(provider, ''));
}
function cronCredentialError(provider) {
  return providerCredentialError(provider) + ' to run this routine';
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
const DECLINED_CAP = 200;   // permanent per-agent reject-list of Discarded proposals (FIFO) fed into reflection dedup
const REFLECT_COOLDOWN_MS = 180000;    // batch rapid-fire runs: at most one turn-in beat per agent per few minutes (default)
const STUDY_COOLDOWN_MS = 1800000;     // GROWTH Tier 1: the STUDY (dossier Phase B) gate — RARER than reflection
                                       // (default 30m; was 10m — beat-fat trim 2026-07-03). Still user-tunable
                                       // live via memoryConfig.studyCooldownMs (P1-10 MEMORY controls).
const STUDY_TIMEOUT_MS = 30000;
/* ---- P1-10 MEMORY controls: user-facing knobs on the reflection ("turn-in") loop, persisted + HONORED live at
   the reflect gate below (not decorative). `reflectEnabled` (default on) master-switches whether a completed run
   proposes memories at all; `reflectCooldownMs` (default 180s) is the min gap between turn-in beats per agent.
   Both read live on every run (no restart) and stored in a protected sibling of the fs jail. ---- */
const MEMORY_CONFIG_FILE = path.join(WORKSPACES, 'memory.config.json');
let memoryConfig = (function loadMemoryConfig() {
  try {
    const raw = loadResilient(MEMORY_CONFIG_FILE, 'memory-config');
    const c = (raw && typeof raw === 'object') ? raw : {};
    const cd = Number(c.reflectCooldownMs);
    const sd = Number(c.studyCooldownMs);
    return {
      reflectEnabled: c.reflectEnabled !== false,   // default ON
      reflectCooldownMs: (isFinite(cd) && cd >= 0) ? Math.floor(cd) : REFLECT_COOLDOWN_MS,
      // GROWTH Tier 1: study (dossier Phase B) is RARER than memory reflection by construction — its own longer
      // cooldown so the station doesn't propose belief updates every few minutes (default 10m). Master-switch too.
      studyEnabled: c.studyEnabled !== false,       // default ON
      studyCooldownMs: (isFinite(sd) && sd >= 0) ? Math.floor(sd) : STUDY_COOLDOWN_MS
    };
  } catch (_) { return { reflectEnabled: true, reflectCooldownMs: REFLECT_COOLDOWN_MS, studyEnabled: true, studyCooldownMs: STUDY_COOLDOWN_MS }; }
})();
function saveMemoryConfig() {
  try { saveResilient(MEMORY_CONFIG_FILE, { version: 1, reflectEnabled: memoryConfig.reflectEnabled, reflectCooldownMs: memoryConfig.reflectCooldownMs, studyEnabled: memoryConfig.studyEnabled, studyCooldownMs: memoryConfig.studyCooldownMs }); }
  catch (e) { console.warn('[memory-config] persist failed:', (e && e.message) || e); }
}
const proposalsByRun = new Map();      // runId -> { agentId, runId, createdAt, proposals:[{id,kind,content,scope}] }
const latestProposalRun = new Map();   // agentId -> newest pending runId (fetch fallback when the runId is unknown)
const lastReflectAt = new Map();       // agentId -> ts of the last reflection we fired (the cooldown gate)
const reflectingNow = new Set();       // agentIds with a reflection in flight — closes the gap before lastReflectAt is armed
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
      { role: 'system', content: 'You are an agent reflecting right after finishing a task. Extract only DURABLE, reusable memories worth keeping for future runs — stable user preferences or learned facts (state the gist, not the whole result). These are beliefs about the user or the world, never instructions, procedures, or advice you gave during the run. One per line, each tagged FACT: or PREFERENCE:. Skip anything transient, run-specific, or already obvious. If nothing is worth keeping, reply NONE.' },
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
    // §5.6 "discard = never again": fold the permanently-declined proposals into the dedup corpus so reflect()
    // never re-proposes a belief the Commander already rejected (stored as plain text → wrapped so textOf reads it).
    const declined = notebookStore.get('declined:' + agentId);
    const declinedRecs = Array.isArray(declined) ? declined.map(t => ({ content: String(t) })) : [];
    const out = await reflect({ agentId, runId, messages }, { propose, redact, existing: existing.concat(declinedRecs), clock: { now: () => Date.now() }, max: 5 });
    const proposals = (out && out.proposals) || [];
    if (proposals.length) {
      // arm the cooldown ONLY when a beat actually fires — so a trivial/floored/all-deduped run (zero proposals)
      // never spends the window and blocks a following substantive run's turn-in (honours "always confirm").
      lastReflectAt.set(agentId, Date.now());
      // SILENT-SAVE UX: split the batch. NORMAL proposals auto-save immediately (no confirmation) via the ONE
      // write path — a passive "◈ remembered" receipt in COMMS, one-tap ✕ to veto. HIGH-STAKES proposals
      // (credentials / PII / standing instructions) are NOT auto-saved — they still stash + emit memory.proposed
      // so the old Keep/Edit/Discard confirm deck fires for just those (rare-confirm).
      const highStakesProps = [], normalProps = [];
      for (const p of proposals) (highStakes(p.content) ? highStakesProps : normalProps).push(p);

      // auto-save the normal ones. Silent save = NEUTRAL trust (trustDelta 0): there was no user validation to
      // reward (the +2 keep bonus was the Commander confirming). Skills go to the skill library as before.
      const saved = [];
      for (const p of normalProps) {
        try {
          const w = await writeMemoryRecord(agentId, p, { runId, trustDelta: 0, source: 'reflection' });
          if (w.ok) saved.push({ id: w.id, kind: w.kind, content: p.content, scope: p.scope || 'global', saved: true });
        } catch (_) {}   // one failed write never sinks the batch
      }
      // stash ONE batch (mixed: saved receipts carry saved:true + a real record id; high-stakes carry the pending
      // prop_N id). The frontend fetches it via /api/memory/proposals — renders a passive receipt for saved:true
      // items and the Keep/Edit/Discard confirm deck for the rest. A single stash per runId (a second stashProposals
      // for the same runId would OVERWRITE the first — so merge here).
      const pending = highStakesProps.map(p => ({ id: p.id, kind: p.kind, content: p.content, scope: p.scope || 'global' }));
      const combined = saved.concat(pending);
      if (combined.length) stashProposals(agentId, runId, combined);
      // memory.write already emitted per-record inside writeMemoryRecord — that is the receipt TRIGGER. Auto-saved
      // items get NO memory.proposed (they must NOT claim the one-beat slot — study/arc/trust stay free). Only the
      // high-stakes ones emit memory.proposed so the confirm deck fires for just those (and claims the slot).
      for (const p of highStakesProps) chanEmit('memory.proposed', { agentId, runId, id: p.id, kind: p.kind, scope: p.scope || 'global' });
    }
  } catch (e) { console.warn('[cortex] reflection failed:', (e && e.message) || e); }
  finally {
    clearTimeout(timer);
    // book the reflection's own spend into the append-only ledger so the day/global pools stay honest (the run
    // already booked the loop's spend before this fired). A second entry for the same runId just sums.
    if (usd) { try { ledger.record({ runId, agentId, turns: 0, usd, tokens, model: model || '', unmetered }); } catch (_) {} }
  }
}

/* ---- GROWTH Tier 1: the STUDY loop (dossier Phase B — work → understanding) ----
   Alongside reflection, a salient completed run also earns a STUDY pass: a SEPARATE aux call (same model
   plumbing) reads the run's directive + transcript + the Commander-dossier block and proposes DOSSIER belief
   updates (goals/pain/stack/style/… ADD or RETIRE). Proposals are stashed server-side and served to the browser,
   which surfaces them at the SAME turn-in beat (chat.js) — Keep → DossierStore.upsert, Discard → a permanent
   studyDeclined denylist. Its OWN, longer cooldown makes study rarer than memory reflection. Fail-open: a failed
   study never touches the run. NB: the final dedup vs the LIVE dossier + the declined/ignore denylists happens in
   the browser StudyStore (which holds the structured beliefs); the server does a light block-text dedup + floor. */
const STUDY_CAP = 32;
const STUDY_DECLINED_CAP = 200;        // per-agent studyDeclined mirror (browser-owned; pushed on every /api/study/resolve)
const studyByRun = new Map();          // runId -> { agentId, runId, createdAt, proposals:[{id,dim,kind,text,evidence,source,sourceRunId}] }
const latestStudyRun = new Map();      // agentId -> newest pending study runId (fetch fallback when the runId is unknown)
const lastStudyAt = new Map();         // agentId -> ts of the last study we fired (the cooldown gate)
const studyingNow = new Set();         // agentIds with a study in flight — closes the gap before lastStudyAt is armed
const studyDeclinedByAgent = new Map();   // agentId -> [text] — the browser's PERMANENT studyDeclined denylist, mirrored
                                          // here (via /api/study/resolve) so runStudy() dedups at the source. In-memory
                                          // like the proposal stash: a restart just re-learns it on the next resolve.
function stashStudy(agentId, runId, proposals) {
  studyByRun.set(runId, { agentId, runId, createdAt: Date.now(), proposals });
  latestStudyRun.set(agentId, runId);
  while (studyByRun.size > STUDY_CAP) { const k = studyByRun.keys().next().value; studyByRun.delete(k); }
}
// pull the existing-belief texts out of the composed dossier block ("- Goals: a; b" → ['a','b']) so the pure
// study() can dedup an ADD vs what's already known WITHOUT the sidecar mirroring the structured beliefs.
function beliefsFromBlock(block) {
  const beliefs = {};
  for (const ln of String(block == null ? '' : block).split('\n')) {
    const m = /^-\s*[^:]+:\s*(.+)$/.exec(ln.trim());
    if (!m) continue;
    for (const seg of m[1].split(';')) { const t = seg.trim(); if (t) (beliefs.goals = beliefs.goals || []).push({ text: t }); }
  }
  return beliefs;   // dim-agnostic bucket is fine: existingTexts() flattens ALL dims for the ADD/RETIRE match
}
// fire-and-forget; never throws. Own abort signal + timeout, exactly like runReflection.
async function runStudy(o) {
  if (!Study || typeof Study.study !== 'function') return;
  const { agentId, runId, messages, directive, provider, model, cost } = o;
  const unmetered = !!(o && o.unmetered);
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, STUDY_TIMEOUT_MS);
  let usd = 0, tokens = 0;
  const propose = async (prompt) => {
    const req = { model, stream: true, signal: ac.signal, messages: [
      { role: 'system', content: 'You update a durable profile of your Commander from finished work. Propose ONLY evidenced, durable belief changes, one per line, each tagged with a dimension and ADD or RETIRE. Skip anything transient, guessed, or already known. If nothing changed, reply NONE.' },
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
    const block = (typeof commanderDossier !== 'undefined' && commanderDossier.get) ? commanderDossier.get() : '';
    const out = await Study.study({ agentId, runId, directive, messages }, {
      propose, redact, clock: { now: () => Date.now() },
      // declined = the browser's permanent studyDeclined denylist, mirrored here on every /api/study/resolve —
      // so a belief the Commander discarded is deduped AT THE SOURCE and never even stashed again.
      dossierBlock: block, beliefs: beliefsFromBlock(block), declined: studyDeclinedByAgent.get(agentId) || [], max: Study.DEFAULT_MAX
    });
    const proposals = (out && out.proposals) || [];
    if (proposals.length) {
      // arm the cooldown ONLY when proposals actually survive — a floored/all-dedup run never blocks the next study.
      lastStudyAt.set(agentId, Date.now());
      stashStudy(agentId, runId, proposals.map(p => ({ id: p.id, dim: p.dim, kind: p.kind, text: p.text, evidence: p.evidence || '', source: 'study', sourceRunId: p.sourceRunId || runId })));
      // NB: NO chanEmit — study needs no bus event. The browser fetches /api/study/proposals on agent.run.end
      // (a frozen event it already listens to), so the shared/events.js contract stays untouched.
    }
  } catch (e) { console.warn('[study] pass failed:', (e && e.message) || e); }
  finally {
    clearTimeout(timer);
    if (usd) { try { ledger.record({ runId, agentId, turns: 0, usd, tokens, model: model || '', unmetered }); } catch (_) {} }
  }
}

const SKILL_REVIEW_TIMEOUT_MS = num(process.env.SKYNET_SKILL_REVIEW_TIMEOUT_MS, 45000);
const SKILL_REVIEW_MAX_COST_USD = num(process.env.SKYNET_SKILL_REVIEW_MAX_USD, 0.08);
const SKILL_CURATOR_INTERVAL_MS = num(process.env.SKYNET_SKILL_CURATOR_INTERVAL_MS, 24 * 60 * 60 * 1000);
const SKILL_CURATOR_MAX_COST_USD = num(process.env.SKYNET_SKILL_CURATOR_MAX_USD, 0.12);
const skillCuratorLastRun = new Map();
async function runBackgroundSkillReview(o) {
  const { agentId, runId, messages, provider, model, cost, loadedSkills, managedSkills } = o || {};
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, SKILL_REVIEW_TIMEOUT_MS);
  const reviewRunId = String(runId || 'run') + '_skill_review';
  let result = null;
  try {
    const registry = makeRegistry();
    // A2: un-silence the review. The quiet loop's own emit stays a no-op (no run.start/tool chatter on the bus),
    // but every skillbase MUTATION fires the EXISTING `deliverable` event + one auditable log line via this
    // observer — that is what surfaces the new skill in the SKILLS panel and the one COMMS aside.
    const reviewObserver = skillReview.makeReviewObserver({ emit: chanEmit, log: (s) => console.log(s), now: () => Date.now(), source: 'skill-review' });
    makeSkillTools({ store: skillStore, onManage: (skill, ctx, action) => reviewObserver.onManage(skill, action) }).register(registry);
    const allowed = ['skill.write', 'skill.manage', 'skill.list', 'skill.view'];
    const resolved = {
      agentId, room: 'skill-review', hasCompute: true, tools: allowed.slice(),
      approvalRules: {}, networkCaps: {}
    };
    const toolDefs = registry.wireFormat(registry.list(new Set(allowed)));
    const fromWire = new Map();
    for (const d of toolDefs) {
      const real = d.function.name;
      const w = real.replace(/\./g, '_');
      fromWire.set(w, real);
      d.function.name = w;
    }
    const capCtx = makeCapCtx(resolved, {
      // the tool's own emitSkill stays silent here (no-op emit); the SINGLE, deduped, testable deliverable +
      // audit line comes from reviewObserver.onManage below — so a create-then-edit in one pass emits once.
      emit: () => {},
      timeoutMs: CAPS.toolTimeoutMs,
      runId: reviewRunId,
      signal: ac.signal,
      skillReview: true,
      createdBy: 'background-review'
    });
    const dispatch = async (c, ctx) => {
      if (fromWire.has(c.name)) c = Object.assign({}, c, { name: fromWire.get(c.name) });
      return registry.dispatch(c, ctx);
    };
    const prompt = skillReview.buildPrompt({
      agentId, runId, messages,
      loadedSkills: loadedSkills || [],
      managedSkills: managedSkills || [],
      memories: Array.isArray(notebookStore.get('notebook:' + agentId)) ? notebookStore.get('notebook:' + agentId).slice(-12) : [],
      skills: skillStore.list(agentId, { includeArchived: true })
    });
    result = await runAgentLoop({
      messages: [
        { role: 'system', content: 'You are a quiet StarNet skillbase maintenance worker. Use only skill tools, then stop.' },
        { role: 'user', content: prompt }
      ],
      provider, emit: () => {}, cost, tools: toolDefs, dispatch, capCtx,
      limits: { maxIters: 6, maxCostUsd: SKILL_REVIEW_MAX_COST_USD, grace: false },
      signal: ac.signal, clock: { now: () => Date.now() },
      agentId, runId: reviewRunId, model, trigger: 'event'
    });
  } catch (e) { console.warn('[skills] background review failed:', (e && e.message) || e); }
  finally {
    clearTimeout(timer);
    if (result && result.usd) {
      try { ledger.record({ runId: reviewRunId, agentId, turns: result.turns || 0, usd: result.usd || 0, tokens: result.tokens || 0 }); } catch (_) {}
    }
  }
}

async function runSkillCurator(o) {
  const { agentId, runId, provider, model, cost } = o || {};
  const nowMs = Date.now();
  if (SKILL_CURATOR_INTERVAL_MS > 0 && (nowMs - (skillCuratorLastRun.get(agentId) || 0)) < SKILL_CURATOR_INTERVAL_MS) return;
  const all = skillStore.list(agentId, { includeArchived: true });
  skillStore.curate(agentId, { now: nowMs });
  if (process.env.SKYNET_SKILL_CURATOR_LLM !== '1' || !skillCurator.shouldCurate(all)) {
    skillCuratorLastRun.set(agentId, nowMs);
    return;
  }
  skillCuratorLastRun.set(agentId, nowMs);
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, SKILL_REVIEW_TIMEOUT_MS);
  const curatorRunId = String(runId || 'run') + '_skill_curator';
  let result = null;
  try {
    const registry = makeRegistry();
    // A2: same un-silencing for the curator — merges/archives now surface a deliverable + audit line once each.
    const curatorObserver = skillReview.makeReviewObserver({ emit: chanEmit, log: (s) => console.log(s), now: () => Date.now(), source: 'skill-curator' });
    makeSkillTools({ store: skillStore, onManage: (skill, ctx, action) => curatorObserver.onManage(skill, action) }).register(registry);
    const allowed = ['skill.write', 'skill.manage', 'skill.list', 'skill.view'];
    const resolved = { agentId, room: 'skill-curator', hasCompute: true, tools: allowed.slice(), approvalRules: {}, networkCaps: {} };
    const toolDefs = registry.wireFormat(registry.list(new Set(allowed)));
    const fromWire = new Map();
    for (const d of toolDefs) { const real = d.function.name; const w = real.replace(/\./g, '_'); fromWire.set(w, real); d.function.name = w; }
    const capCtx = makeCapCtx(resolved, { emit: () => {}, timeoutMs: CAPS.toolTimeoutMs, runId: curatorRunId, signal: ac.signal, createdBy: 'curator' });
    const dispatch = async (c, ctx) => { if (fromWire.has(c.name)) c = Object.assign({}, c, { name: fromWire.get(c.name) }); return registry.dispatch(c, ctx); };
    result = await runAgentLoop({
      messages: [
        { role: 'system', content: 'You are a quiet StarNet skill curator. Use only skill tools, then stop.' },
        { role: 'user', content: skillCurator.buildPrompt({ skills: all }) }
      ],
      provider, emit: () => {}, cost, tools: toolDefs, dispatch, capCtx,
      limits: { maxIters: 10, maxCostUsd: SKILL_CURATOR_MAX_COST_USD, grace: false },
      signal: ac.signal, clock: { now: () => Date.now() },
      agentId, runId: curatorRunId, model, trigger: 'event'
    });
  } catch (e) { console.warn('[skills] curator failed:', (e && e.message) || e); }
  finally {
    clearTimeout(timer);
    if (result && result.usd) {
      try { ledger.record({ runId: curatorRunId, agentId, turns: result.turns || 0, usd: result.usd || 0, tokens: result.tokens || 0 }); } catch (_) {}
    }
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
// ADDITIVE provenance (B1.1): a sibling `meta` map { dangerKey: { grantedAt } } persisted INSIDE the same file
// as a NEW field. Old files with no `meta` load fine (→ {}); the broker never reads it. Only well-formed rows
// for still-held keys are kept, so a hand-edited/legacy file can't inject junk provenance.
function loadAllowMeta() {
  try {
    const raw = loadResilient(ALLOWLIST_FILE, 'permissions');
    const m = raw && raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
    const out = {};
    for (const k of Object.keys(m)) {
      const g = m[k] && typeof m[k] === 'object' ? m[k].grantedAt : null;
      out[k] = { grantedAt: (typeof g === 'number' && isFinite(g)) ? g : null };
    }
    return out;
  } catch (e) { return {}; }
}
const grantsPermanent = loadAllowlist();   // process-wide, restored from disk
const grantMeta = loadAllowMeta();         // process-wide provenance, restored alongside (additive; may be {})
// throws on failure -> the broker degrades the grant to a deny. Two callers, ONE durable format:
//   • permgrants.js passes (nextAllow, nextMeta) — the panel's grant/revoke ships the provenance it computed.
//   • permissions.js (the broker's 'always' path) passes ONLY (nextAllow) — we preserve the live grantMeta and
//     opportunistically STAMP a grantedAt for any newly-blessed key so a mid-run "always" is also timestamped.
function persistAllowlist(nextAllow, nextMeta) {   // throws on failure -> the broker degrades the grant to a deny
  let metaToWrite;
  if (nextMeta && typeof nextMeta === 'object') {
    metaToWrite = nextMeta;
  } else {
    // broker path: keep existing provenance, drop rows for keys no longer allowed, stamp any brand-new key.
    const nowMs = Date.now();
    metaToWrite = {};
    for (const k of nextAllow) metaToWrite[k] = grantMeta[k] || { grantedAt: nowMs };
  }
  saveResilient(ALLOWLIST_FILE, { version: 1, allow: nextAllow, meta: metaToWrite });   // fsync-durable + .bak; throws on a real write failure
  // commit the provenance to the shared in-memory store ONLY after the durable write succeeds (fail-closed):
  // mirror-replace so a revoke's dropped rows and a grant's new stamp both land coherently.
  for (const k of Object.keys(grantMeta)) delete grantMeta[k];
  for (const k of Object.keys(metaToWrite)) grantMeta[k] = { grantedAt: metaToWrite[k] && metaToWrite[k].grantedAt != null ? metaToWrite[k].grantedAt : null };
}
// the standing-grant manager behind the Permissions Panel (B1): proactively grant / see / revoke the curated,
// LOCAL-only danger classes (cabinet:write = autonomous file writes). It mutates the SAME grantsPermanent Set
// every per-run broker reads, so a grant takes effect for the very next autonomous run with no restart; persist
// is the same fail-closed durable sink the broker's 'always' path uses. `meta` shares grantMeta so the panel's
// grantedAt provenance survives a round-trip and the broker path stays untouched.
const grantManager = makeGrantManager({ grantsPermanent, persist: persistAllowlist, meta: grantMeta, now: () => Date.now() });
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
// Optional Bot API base override. Production defaults to Telegram; tests point this at a local fake server so the
// real sidecar polling/send path can be validated without network or a live bot token.
const TELEGRAM_API_BASE = String(ENV('TELEGRAM_API_BASE') || '').trim() || undefined;
const VOICE_CACHE_DIR = path.join(WORKSPACES, 'voice-cache');
try { fs.mkdirSync(VOICE_CACHE_DIR, { recursive: true }); } catch (e) {}
let ttsMissCount = 0, evictingVoiceCache = false;   // opportunistic, throttled voice-cache eviction

// STT model for /api/stt — an audio-INPUT-capable chat model on OpenRouter (verified live). Overridable so a
// better/cheaper transcription model can be swapped without a code change. gemini-3.1-flash-lite-preview
// documents audio input/ASR; a comma-list lets us try fallbacks in order if the first is unavailable.
const STT_MODELS = String(ENV('STT_MODELS') || 'google/gemini-3.1-flash-lite-preview,google/gemini-2.5-flash')
  .split(',').map(s => s.trim()).filter(Boolean);

// Voice round-trips (TTS/STT) are the app's hottest external calls, back-to-back to one host. Node's global
// fetch (undici) already pools + keep-alives connections, but a dedicated dispatcher lets us widen the pool and
// give TTS/STT their own generous timeouts without touching every other fetch. undici isn't a resolvable module
// in this Node build (it's the internal impl, not a package), so this is guarded: on failure we simply pass no
// dispatcher and rely on the default pool — never a hack, never a hard dependency.
let voiceDispatcher = null;
(async () => {
  try {
    const u = await import('undici');
    if (u && u.Agent) voiceDispatcher = new u.Agent({ keepAliveTimeout: 30000, keepAliveMaxTimeout: 60000, connections: 8 });
  } catch (_) { voiceDispatcher = null; }   // internal undici not importable → default global pool (still keep-alived)
})();
function voiceFetchOpts(base) { return voiceDispatcher ? Object.assign({ dispatcher: voiceDispatcher }, base) : base; }
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
  try {
    return codexTokenStore.loadCodexTokensWithMigration({
      currentFile: CODEX_TOKENS_FILE,
      candidateFiles: codexTokenStore.candidateCodexTokenFiles({ pathMod: path, env: process.env, currentWorkspaces: WORKSPACES, defaultWorkspaces, sidecarDir: __dirname }),
      pathMod: path,
      load: (file, tag) => loadResilient(file, tag),
      save: (_file, raw) => saveCodexTokens(raw),
      onMigrate: (from, to) => console.warn('[codex] migrated ChatGPT OAuth tokens from legacy workspace ' + from + ' to ' + to + '.')
    });
  }
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

/* ---- TOOLSETS kill-switch store (the Hermes-style "toolsets" surface): a per-capId-FAMILY on/off flag
   layered on top of object=capability. available = the granting object is placed AND the toolset is enabled.
   Default = enabled for every family; we only PERSIST the ones a user explicitly turned OFF (a sparse
   { capId:false } map), so a fresh install is byte-identical to no file and adding a new family never needs a
   migration. `compute` is NEVER in this map (the COMPUTE GATE freebie — resolveTools ignores it, and the
   toggle route refuses it). Same durable sibling-file idiom as connectors/cron (temp->fsync->rename + .bak).
   Lives in the PROTECTED WORKSPACES dir so the agent's own fs.* tools can't reach in and re-grant itself. */
const TOOLSETS_FILE = path.join(WORKSPACES, 'toolsets.json');
const TOGGLEABLE_CAPS = toggleableCaps(CAP_REGISTRY);   // the only capIds a switch may target
function loadToolsetState() {
  try {
    const raw = loadResilient(TOOLSETS_FILE, 'toolsets');
    const src = (raw && raw.disabled && typeof raw.disabled === 'object') ? raw.disabled : {};
    const out = {};
    // fail-safe: only honour KNOWN toggleable capIds set explicitly to false; ignore compute / junk keys.
    for (const c of TOGGLEABLE_CAPS) { if (src[c] === false) out[c] = false; }
    return out;
  } catch (_) { return {}; }   // unrecoverable -> everything enabled (fail OPEN: a broken flag never silently strips tools)
}
let toolsetDisabled = loadToolsetState();   // { capId: false } for OFF families (absent = ON)
function saveToolsetState() {
  try {
    const disabled = {};
    for (const c of TOGGLEABLE_CAPS) { if (toolsetDisabled[c] === false) disabled[c] = false; }
    saveResilient(TOOLSETS_FILE, { version: 1, disabled });   // fsync-durable + .bak last-known-good
  } catch (e) { console.warn('[toolsets] persist failed:', (e && e.message) || e); }
}
// the disabledCaps view resolveTools consumes: a live snapshot of OFF families (compute can never appear).
function disabledCapsSet() {
  const s = {};
  for (const c of TOGGLEABLE_CAPS) { if (toolsetDisabled[c] === false) s[c] = true; }
  return s;
}

/* ---- cron / scheduled routines store + tick driver (CRON Commit 4b). The job DEFINITIONS persist in a
   PROTECTED sibling of the fs jail (WORKSPACES/cron.jobs.json, the allowlist idiom above: versioned envelope,
   atomic + DURABLE temp->fsync->rename + .bak last-known-good (G4.2: no double-fire on a crash in the
   advance-before-run window, and no silent routine wipe after a torn/corrupt main),
   load->recover .bak; unrecoverable corrupt->quarantine+empty fail-closed) so the agent's own fs.* tools can neither read nor rewrite
   its own schedule. The cron-math + lifecycle reducer are pure (cron.js / cron-store.js); the timer, the
   now-source, id minting and this fs are the ambient half that lives ONLY here. The driver is constructed
   unconditionally (cheap, no I/O), but it only ever runs when the boot block below arms the timer behind the
   SKYNET_CRON_ENABLED gate — so with cron off this is dead weight, never a behavior change. ---- */
const CRON_FILE = path.join(WORKSPACES, 'cron.jobs.json');
function loadCronJobs() {
  try {
    const raw = loadResilient(CRON_FILE, 'cron');   // missing -> empty; torn/corrupt main -> recover .bak or quarantine loudly
    return cronStore.loadEnvelope(raw).jobs;
  } catch (e) {
    console.warn('[cron] load failed:', (e && e.message) || e);
    return [];
  }
}
let cronJobs = loadCronJobs();
function saveCronJobs() {   // throws on failure (the CRUD routes let it surface); the driver's setJobs catches+logs
  // G4.2: crash-SAFE persistence. The advance-before-run window (cron-driver persists the ADVANCED nextRunAt
  // BEFORE launching a fire) is the one place a lost/zero-length write would DOUBLE-FIRE a routine on restart,
  // so we don't just rename — we fsync the temp file's bytes to stable storage BEFORE the rename (per-pid+random
  // tmp so concurrent writers never collide), then best-effort fsync the directory after (Windows-safe). Same
  // durability the ledger/runs appends already get; the protected-state helper also snapshots the prior good
  // envelope to cron.jobs.json.bak before replacing main, so a torn/corrupt main never boots as amnesiac.
  saveResilient(CRON_FILE, cronStore.toEnvelope(cronJobs));
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
// B4 — autonomous notifications: when a cron run PRODUCES WORK, ping the Commander's connected channel(s). The
// opt-in is a single global flag (channelSecrets.notifyAutonomous, default off) — chatsFor returns [] when off, so
// the notifier engine stays opt-in-agnostic. send/chatsFor read telegram/discord/channelSecrets LIVE (closures), so
// they resolve correctly even though the channel adapters connect after this point in boot.
const autoNotifier = makeAutoNotifier({
  send: (chatId, text, channel) => { const ch = (channel === 'discord') ? discord : telegram; return (ch && ch.adapter) ? ch.adapter.send(chatId, redact(text)) : Promise.resolve({ ok: false }); },
  chatsFor: (agentId) => {
    if (!(channelSecrets && channelSecrets.notifyAutonomous)) return [];   // global opt-in gate (default off — anti-spam)
    try { const map = channelStore.loadChatMap(); return Object.keys(map.chats || {}).filter(cid => map.chats[cid] && map.chats[cid].agentId === agentId).map(cid => ({ chatId: cid, channel: (map.chats[cid] && map.chats[cid].channel) || 'telegram' })); } catch (_) { return []; }
  },
  jobName: (jobId) => { const j = (cronJobs || []).find(x => x && x.id === jobId); return (j && j.name) || 'a routine'; },
  jobAgent: (jobId) => { const j = (cronJobs || []).find(x => x && x.id === jobId); return (j && j.agentId) || null; }
});
// feed every cron event to the notifier alongside the validated SSE/console emit; it never throws into the cron pass.
const cronEmitNotify = (name, payload) => { const r = cronEmit(name, payload); try { autoNotifier.onEvent(name, payload); } catch (_) {} return r; };
function placeCronWorkitem(agentId, prompt, runId) {
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
  // the SAME run host the browser uses (hoisted decl below). AWAY WORKSHOP: a workshop shift routine stores the
  // WORKSHOP_MARK sentinel as its prompt; when the driver fires it, redirect to runWorkshopShift (which pops the
  // agent's backlog, builds under workshop/<runId>/, validates the manifest, emits workshop.built). An empty
  // backlog makes runWorkshopShift a silent no-op — the cron machinery still records a clean run. Any other
  // routine runs unchanged.
  runOnce: (opts) => {
    const first = opts && Array.isArray(opts.messages) && opts.messages[0] && String(opts.messages[0].content || '');
    if (first && first.indexOf(WORKSHOP_MARK) === 0) {
      return runWorkshopShift(opts.agentId, { runId: opts.runId, emit: opts.emit, signal: opts.signal });
    }
    return runOnce(opts);
  },
  emit: cronEmitNotify, newId: () => crypto.randomUUID(), newAbort: () => new AbortController(), now: () => Date.now(),
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
  placeWorkitem: placeCronWorkitem,
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
  return normalizeProviderIdFromRegistry(provider, 'openrouter');
}
function providerUsesCodex(provider) { return registryProviderUsesCodex(normalizeProvider(provider)); }
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
  return registryDefaultReasoningEffort(normalizeProvider(provider));
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
    token: token, key: key, model: model, provider: provider, baseUrl: cfg.baseUrl || cfg.base_url || '', reasoningEffort: reasoningEffort, enabled: true,
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
      const key = providerRuntimeKey(provider, t.key || '');
      const baseUrl = providerRuntimeBaseUrl(provider, t.baseUrl || t.base_url || '');
      return { key, model: t.model, provider, baseUrl, configured: providerHasCredential(provider, key, baseUrl), reasoningEffort: resolveReasoningEffort(provider, t.reasoningEffort), agentId: t.agentId, system: t.system };
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
    fetch: globalThis.fetch, token: token, apiBase: TELEGRAM_API_BASE, clock: { now: () => Date.now() },
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
  const reasoningEffort = resolveReasoningEffort(provider, cfg.reasoningEffort);
  const prev = (channelSecrets && channelSecrets.discord) || {};
  channelSecrets = Object.assign({}, channelSecrets, { discord: {
    token: token, key: key, model: model, provider: provider, baseUrl: cfg.baseUrl || cfg.base_url || '', reasoningEffort: reasoningEffort, enabled: true,
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
        const k = providerRuntimeKey(provider, d.key || '');
        const baseUrl = providerRuntimeBaseUrl(provider, d.baseUrl || d.base_url || '');
        return { key: k, model: d.model, provider, baseUrl, configured: providerHasCredential(provider, k, baseUrl), reasoningEffort: resolveReasoningEffort(provider, d.reasoningEffort), agentId: d.agentId, system: d.system };
      },
      persona: DISCORD_PERSONA, classify: Classify.isTaskDirective, redact: redact, emit: chanEmit,
      newId: () => crypto.randomUUID(),
      resolveAgent: (ctx) => router.resolveTarget(ctx),
      getTag: (text) => (Classify.getTag ? Classify.getTag(text) : undefined),
      resolveStation: (agentId) => router.stationFor(agentId)
    },
    adapter: {
      fetch: globalThis.fetch, token: token, clock: { now: () => Date.now() },
      // P2-E: the REAL default injection — a live Discord gateway v10 WS client turning the bot token into a push
      // of raw MESSAGE_CREATE payloads. Its transport-health states flow into discordStatus so the UI can tell the
      // truth (connecting / up / reconnecting / down / error). Tests keep injecting a fake connectGateway instead.
      connectGateway: makeConnectGateway({
        fetch: globalThis.fetch,
        WebSocketImpl: (typeof WebSocket !== 'undefined' ? WebSocket : undefined),
        now: () => Date.now(), random: Math.random,   // composition root injects real time/rng (heartbeat+backoff jitter)
        log: (m) => { try { console.log('  · [discord gw] ' + m); } catch (_) {} },
        onState: (s) => {
          const state = (s && s.state) || 'down';
          const connected = state === 'up';
          discordStatus = { connected, state, detail: (s && s.detail) || '' };
          try { chanEmit('channel.connect', { channel: 'discord', ok: connected, state, detail: (s && s.detail) || '' }); } catch (_) {}
        }
      }),
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
        // The gateway's onState (above) is authoritative for CONNECTION truth (connecting/up/reconnecting/down/error),
        // since the transport's getUpdates just drains a buffer and never surfaces the real WS health. Here we only
        // forward the adapter's poll telemetry to the hub for its SSE broadcast; we don't clobber discordStatus.
        if (wired && wired.hub) wired.hub.onStatus(s);
      }
    }
  });
  discord = { adapter: wired.adapter, hub: wired.hub };
  // start in "connecting" — the injected gateway's onState will flip this to up/reconnecting/down/error as the real
  // WebSocket connects and lives. (No gateway injected in a degraded build => stays connecting, honestly.)
  discordStatus = { connected: false, state: 'connecting', detail: '' };
  wired.adapter.connect();
  console.log('  · discord channel connecting (gateway)');
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
  if (req.method === 'POST' && (req.url === '/api/stt' || req.url.indexOf('/api/stt?') === 0)) return handleStt(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/cancel') return handleCancel(req, res);
  if (req.method === 'POST' && req.url === '/api/run/steer') return handleRunSteer(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'GET' && req.url === '/api/version') return handleVersion(req, res);
  if (req.method === 'POST' && req.url === '/api/halt') return handleHalt(req, res);
  if (req.method === 'POST' && req.url === '/api/consent') return handleConsent(req, res);
  if (req.method === 'GET' && req.url === '/api/permissions') return handlePermissionsList(req, res);
  if (req.method === 'POST' && req.url === '/api/permissions/grant') return handlePermissionsGrant(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/permissions/revoke') return handlePermissionsRevoke(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/autonomy/write') return handleAutonomyWrite(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/summon/ack') return handleSummonAck(req, res);
  if (req.method === 'POST' && req.url === '/api/key') return handleSetKey(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/connect') return handleChannelConnect(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/sync') return handleChannelSync(req, res);
  if (req.method === 'POST' && req.url === '/api/roster') return handleRoster(req, res);
  if (req.method === 'POST' && req.url === '/api/dossier') return handleDossier(req, res);
  if (req.method === 'POST' && req.url === '/api/goals') return handleGoals(req, res);   // GROWTH Tier 2: the active goal-arc summary for cron personas
  if (req.method === 'POST' && req.url === '/api/channels/telegram/disconnect') return handleChannelDisconnect(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/discord/connect') return handleDiscordConnect(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/discord/sync') return handleDiscordSync(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/discord/disconnect') return handleDiscordDisconnect(req, res);
  if (req.method === 'GET' && req.url === '/api/channels/discord/status') return handleDiscordStatus(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/notify') return handleChannelNotify(req, res);
  if (req.method === 'GET' && req.url === '/api/channels/telegram/status') return handleChannelStatus(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/channels/events') return handleChannelEvents(req, res);   // path match: the SSE url carries a ?token= query now
  if (req.method === 'POST' && req.url === '/api/routing') return handleRouting(req, res);
  if (req.method === 'GET' && req.url === '/api/budget/status') return handleBudgetStatus(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/credits') return handleCredits(req, res);   // 404s (no surface) unless managed credits are configured
  if (req.method === 'POST' && req.url === '/api/budget/caps') return handleBudgetCaps(req, res);
  if (req.method === 'POST' && req.url === '/api/budget/resume') return handleBudgetResume(req, res);
  if (req.method === 'GET' && req.url === '/api/fallback/chain') return handleFallbackStatus(req, res);
  if (req.method === 'POST' && req.url === '/api/fallback/chain') return handleFallbackChain(req, res);
  if (req.method === 'POST' && req.url === '/api/config/export') return handleConfigExport(req, res);   // P1-7 station backup
  if (req.method === 'POST' && req.url === '/api/config/import') return handleConfigImport(req, res);
  if (req.method === 'POST' && req.url === '/api/config/reset') return handleConfigReset(req, res);
  if (req.method === 'GET' && req.url === '/api/runtime/knobs') return handleRuntimeKnobsGet(req, res);   // P1-9 advanced knobs
  if (req.method === 'POST' && req.url === '/api/runtime/knobs') return handleRuntimeKnobsSet(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/codex/start') return handleCodexStart(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/codex/poll') return handleCodexPoll(req, res);
  if (req.method === 'GET' && req.url === '/api/auth/codex/status') return handleCodexStatus(req, res);
  if (req.method === 'GET' && req.url === '/api/auth/codex/models') return handleCodexModels(req, res);
  if (req.method === 'GET' && req.url === '/api/providers') return handleProviders(req, res);
  if (req.method === 'GET' && req.url.split('?')[0].indexOf('/api/models/') === 0) return handleProviderModels(req, res).catch(() => { try { res.end(JSON.stringify({ models: [] })); } catch (_) {} });
  if (req.method === 'GET' && req.url === '/api/models/openrouter') return handleOpenRouterModels(req, res).catch(() => { try { res.end(JSON.stringify({ models: [] })); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/auth/codex/logout') return handleCodexLogout(req, res);
  if (req.method === 'GET' && req.url === '/api/connectors') return handleConnectorsList(req, res);
  if (req.method === 'POST' && req.url === '/api/connectors') return handleConnectorUpsert(req, res);
  if (req.method === 'POST' && req.url === '/api/connectors/remove') return handleConnectorRemove(req, res);
  if (req.method === 'POST' && req.url === '/api/connectors/refresh') return handleConnectorRefresh(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/toolsets') === 0) return handleToolsetsList(req, res);
  if (req.method === 'POST' && req.url.indexOf('/api/toolsets/') === 0) return handleToolsetToggle(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/slash/catalog') === 0) return serveSlashCatalog(req, res);
  if (req.method === 'POST' && req.url === '/api/slash/dispatch') return handleSlashDispatch(req, res);
  if (req.method === 'POST' && req.url === '/api/skills/toggle') return handleSkillToggle(req, res);
  if (req.method === 'POST' && req.url === '/api/agent-skills/manage') return handleAgentSkillManage(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/agent-skills') === 0) return serveAgentSkills(req, res);
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
  // ---- away workshop (W1/W2): grant toggle, backlog queue, pending deliverables, decide, force-fire a shift ----
  if (req.method === 'POST' && req.url === '/api/workshop/grant') return handleWorkshopGrant(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/workshop/queue') return handleWorkshopQueue(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/workshop/backlog') return handleWorkshopBacklog(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/workshop/pending') return handleWorkshopPending(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/workshop/decide') return handleWorkshopDecide(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/workshop/shift') return handleWorkshopShiftNow(req, res).catch(() => { try { res.end(); } catch (_) {} });
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
  if (req.method === 'GET' && req.url.indexOf('/api/study/proposals') === 0) return serveStudyProposals(req, res);   // GROWTH Tier 1: dossier belief-update proposals for a run
  if (req.method === 'POST' && req.url === '/api/study/resolve') return handleStudyResolve(req, res);   // GROWTH Tier 1: consume one decided study proposal + mirror the denylist
  if (req.method === 'POST' && req.url === '/api/memory/reset') return handleMemoryReset(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/declined/restore') return handleDeclinedRestore(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/memory/declined') === 0) return serveDeclined(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/memory/records') === 0) return serveMemoryRecords(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/pin') return handleMemoryPin(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/edit') return handleMemoryEdit(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/forget') return handleMemoryForget(req, res);
  if (req.method === 'GET' && req.url === '/api/memory/config') return handleMemoryConfigGet(req, res);   // P1-10 memory controls
  if (req.method === 'POST' && req.url === '/api/memory/config') return handleMemoryConfigSet(req, res);
  if (req.method === 'GET' && /^\/shared\//.test((req.url || '').split('?')[0])) return serveShared(req, res);
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
  makeOpenRouterProvider({ fetch: globalThis.fetch, baseUrl: providerRuntimeBaseUrl('openrouter', '') || OPENROUTER_BASE }).listModels().then(
    ms => { if (ms && ms.length) console.log('  · model catalog warmed (' + ms.length + ' models)'); },
    () => {}
  );
  // auto-start a previously-connected Telegram bot (saved config), else an env-provided one (headless deploys).
  try {
    const t = (channelSecrets && channelSecrets.telegram) || {};
    const envTok = String(ENV('TELEGRAM_TOKEN') || '').trim();
    const envKey = String(ENV('OPENROUTER_KEY') || '').trim();
    const envModel = String(ENV('DEFAULT_MODEL') || '').trim();
    if (t.enabled && t.token && t.model && providerHasCredential(t.provider, providerRuntimeKey(t.provider, t.key || ''), providerRuntimeBaseUrl(t.provider, t.baseUrl || t.base_url || ''))) { startTelegram(t.token, t.key || '', t.model, { agentId: t.agentId, system: t.system, name: t.name, provider: t.provider, baseUrl: t.baseUrl || t.base_url || '', reasoningEffort: t.reasoningEffort }); console.log('  · telegram auto-started from saved config'); }
    else if (envTok && envKey && envModel) { startTelegram(envTok, envKey, envModel, {}); console.log('  · telegram auto-started from env'); }
  } catch (e) { console.warn('[channels] telegram auto-start failed:', (e && e.message) || e); }
  // H6.2: same auto-start for Discord (saved config else env), through the generic registry path.
  try {
    const d = (channelSecrets && channelSecrets.discord) || {};
    const envTok = String(ENV('DISCORD_TOKEN') || '').trim();
    const envKey = String(ENV('OPENROUTER_KEY') || '').trim();
    const envModel = String(ENV('DEFAULT_MODEL') || '').trim();
    if (d.enabled && d.token && d.model && providerHasCredential(d.provider, providerRuntimeKey(d.provider, d.key || ''), providerRuntimeBaseUrl(d.provider, d.baseUrl || d.base_url || ''))) { startDiscord(d.token, d.key || '', d.model, { agentId: d.agentId, system: d.system, name: d.name, provider: d.provider, baseUrl: d.baseUrl || d.base_url || '', reasoningEffort: d.reasoningEffort }); console.log('  · discord auto-started from saved config'); }
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
  const now = Date.now();
  // caps: the EFFECTIVE (persisted-or-env) values the UI edits; `overrides` marks which were saved (vs env default),
  // so the Budget panel can show "env default" honestly. spentToday/lifetime are the real ledger reads the floor HUD
  // + cost tests already consume — never re-parsed in the frontend.
  res.end(JSON.stringify(Object.assign({
    caps: {
      perRun: effectiveCaps.perRun, perAgent: effectiveCaps.perAgent,
      perDay: effectiveCaps.perDay, global: effectiveCaps.global
    },
    saved: Object.assign({}, budgetOverrides),        // only the keys the user explicitly saved
    envDefaults: { perRun: BUDGET_CAPS.perRun, perAgent: BUDGET_CAPS.perAgent, perDay: BUDGET_CAPS.perDay, global: BUDGET_CAPS.global },
    perRun: effectiveCaps.perRun,                     // back-compat: pre-existing flat field kept
    spentToday: ledger.usdForDay(now),
    lifetime: ledger.totalUsd(),
    totalUsd: ledger.totalUsd(), runs: ledger.count()
  }, budget.status(now))));
}
/* ---- GET /api/credits — the managed-credit STORE surface (balance + recent history + the external purchase URL).
   HONESTY LAW: 404s when managed credits are NOT configured, so the frontend renders no STORE card and shows no
   dead balance. Never emits a secret (no api key, no account internals beyond the display id). Read-only. ---- */
async function handleCredits(req, res) {
  if (!credits.configured()) { res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ configured: false })); }
  await credits.refresh(CREDITS_ACCOUNT).catch(() => {});   // reconcile the cached balance before we report it
  const hist = await credits.history(CREDITS_ACCOUNT, 20).catch(() => ({ entries: [] }));
  const snap = credits.snapshot();
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    configured: true,
    accountId: snap.accountId,               // display id only (the API key is never surfaced)
    balanceUsd: snap.balanceUsd,             // null when the backend hasn't answered yet (UI shows "—")
    purchaseUrl: snap.purchaseUrl,           // external link the STORE opens; this app renders no payment form
    perRun: effectiveCaps.perRun,            // the reservation size a run will hold
    history: Array.isArray(hist.entries) ? hist.entries : [],
    reachable: !hist.error
  }));
}
/* ---- POST /api/budget/caps { perRun?, perAgent?, perDay?, global? } — set one or more USD caps. Each value:
   a positive number = a real cap; 0 (or "0") = NO CAP (ungoverned) — an explicit saved choice; null / "" = CLEAR
   the override so that key falls back to its env default. Strictly validated (finite, >= 0, sane ceiling), persisted
   durably, and applied LIVE to the governor (no restart). Additive: leaves env-only setups untouched until saved. ---- */
async function handleBudgetCaps(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const v = budgetCaps.validateOverridesPatch(body, budgetOverrides);   // pure: strict parse + merge onto current
  if (!v.ok) return json(400, { error: v.error });
  budgetOverrides = v.overrides;
  saveBudgetOverrides();
  applyBudgetCaps();   // live, no restart
  return handleBudgetStatus(req, res);   // echo the fresh status so the UI repaints from one round-trip
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

/* ---- best-effort catalog for fallback-id validation. Returns a Set of known OpenRouter model ids from the WARM
   catalog (cached module-level after the boot warmup), or null if the catalog is cold. null => the endpoint skips
   validation entirely and accepts the ids with no warnings (never false-refuse a brand-new / stale-catalog slug). */
async function warmModelCatalogSet() {
  try {
    const provider = makeOpenRouterProvider({ fetch: globalThis.fetch, baseUrl: providerRuntimeBaseUrl('openrouter', '') || OPENROUTER_BASE });
    const models = await provider.listModels();   // cache hit after boot warmup; a cold fetch is bounded by the provider
    if (!Array.isArray(models) || !models.length) return null;
    const s = new Set();
    for (const m of models) { if (m && m.id) s.add(String(m.id)); }
    return s.size ? s : null;
  } catch (_) { return null; }
}

/* ---- GET /api/fallback/chain — the ordered fallback model chain the SETTINGS→Models panel edits (P0-3).
   Read-only. Reports the EFFECTIVE chain (saved-or-env), whether it's a saved override vs the env default, and the
   raw env baseline — so the panel can honestly show "env default" when nothing is saved. ---- */
function handleFallbackStatus(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    chain: effectiveFallbackChain(),                 // the list actually in force for a run with no per-run override
    saved: fallbackSaved != null,                    // true = an explicit saved choice; false = following the env default
    envDefault: ENV_FALLBACK.slice(),                // the SKYNET_FALLBACK_MODELS baseline (frozen at boot)
    maxEntries: fallbackChain.MAX_ENTRIES
  }));
}

/* ---- POST /api/fallback/chain { models: ["slug", …] | null } — set (or clear) the ordered fallback chain.
   { models: [...] } SAVES that ordered chain (even []=off, an explicit "no fallback" choice that beats a non-empty
   env default); { models: null } (or { clear:true } / {}) CLEARS the override so the chain follows the env default
   again. Persisted durably (+ .bak) and applied LIVE to every run path (no restart). Unknown model ids are WARNED,
   never refused (catalogs go stale; a brand-new model must still be settable). Additive: leaves env-only setups
   untouched until saved. Echoes the fresh status so the UI repaints from one round-trip. ---- */
async function handleFallbackChain(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 8192)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const catalog = await warmModelCatalogSet();     // null when cold -> validation skipped (warn, never refuse)
  const v = fallbackChain.validateChainPatch(body, { catalog: catalog });
  if (!v.ok) return json(400, { error: v.error });
  fallbackSaved = v.present ? v.chain : null;       // present:false = CLEAR -> back to env default
  saveFallbackChain();                              // durable + .bak (or remove the file on reset)
  // echo the fresh status + any unknown-id warnings so the panel can surface them (non-blocking).
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    chain: effectiveFallbackChain(), saved: fallbackSaved != null, envDefault: ENV_FALLBACK.slice(),
    maxEntries: fallbackChain.MAX_ENTRIES, warnings: v.warnings || []
  }));
}

/* ---- P1-7 STATION BACKUP: export / import / reset the station's persisted config to ONE portable JSON file.
   The SERVER-side stores (budget/fallback/roster/dossier/permissions/connectors) are read/written here directly;
   the BROWSER-owned slices (settings/autonomy/notifyPrefs — localStorage state) are carried in the request body
   on export and echoed back to the app on import (the sidecar can't reach localStorage). SECURITY: secrets never
   enter the envelope — configexport.js redacts connector auth to a configured-marker; provider keys / bot tokens
   / OAuth are omitted entirely and surfaced as "re-enter your key" on import. Every route is token-gated (main
   route table) like all /api. ---- */

// gather the SERVER-side live config into the plain snapshot buildExport reads. Browser-owned sections are
// overlaid from the request body (the app knows its own localStorage). NO secrets are ever read in.
function collectExportSnapshot(bodySections) {
  const b = (bodySections && typeof bodySections === 'object') ? bodySections : {};
  const roster = [...agentRoster].map(([agentId, a]) => ({ agentId, name: a.name, model: a.model, provider: a.provider, role: a.role, system: a.system }));
  const connectors = (connectorConfigs || []).map(c => Object.assign({}, c, { hasToken: !!(c && (c.token || c.hasToken)) }));
  const snap = {
    budget: Object.assign({}, budgetOverrides),
    fallback: effectiveFallbackChain(),
    roster: roster,
    dossier: commanderDossier.get(),
    permissions: [...grantsPermanent],
    connectors: connectors
  };
  // browser-owned slices, only if the app supplied them (partial export stays clean).
  if (b.settings && typeof b.settings === 'object') snap.settings = b.settings;
  if (b.autonomy && typeof b.autonomy === 'object') snap.autonomy = b.autonomy;
  if (b.notifyPrefs && typeof b.notifyPrefs === 'object') snap.notifyPrefs = b.notifyPrefs;
  return snap;
}

/* POST /api/config/export { sections?: {settings,autonomy,notifyPrefs}, only?: [names] } -> the export envelope.
   POST (not GET) because the browser-owned localStorage sections ride in the body. Never emits a secret. */
async function handleConfigExport(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 20)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const snap = collectExportSnapshot(body.sections);
  const env = configExport.buildExport(snap, { now: Date.now(), app: 'StarNet', only: Array.isArray(body.only) ? body.only : null });
  return json(200, env);
}

/* POST /api/config/import { envelope, only?: [names] } -> validate + APPLY to the server-side stores, live.
   Returns { ok, applied:[names], secretsNeeded:[...], notes:[...], browser:{settings,autonomy,notifyPrefs} } so
   the app can (a) surface re-enter-your-key states and (b) restore its own localStorage slices. Additive/durable:
   each store's own save path runs, so nothing bypasses the .bak/fsync discipline. */
async function handleConfigImport(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 20)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const envelope = body.envelope || body;   // tolerate a bare envelope or a wrapped one
  const parsed = configExport.parseImport(envelope);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const only = Array.isArray(body.only) && body.only.length ? new Set(body.only) : null;
  const want = (name) => (!only || only.has(name)) && Object.prototype.hasOwnProperty.call(parsed.sections, name);
  const applied = [];
  const sec = parsed.sections;

  if (want('budget')) {
    const v = budgetCaps.cleanOverrides(sec.budget || {});
    budgetOverrides = v; saveBudgetOverrides(); applyBudgetCaps(); applied.push('budget');
  }
  if (want('fallback')) {
    const models = (sec.fallback && Array.isArray(sec.fallback.models)) ? fallbackChain.cleanChain(sec.fallback.models) : [];
    fallbackSaved = models; saveFallbackChain(); applied.push('fallback');
  }
  if (want('roster') && Array.isArray(sec.roster)) {
    // MERGE over the live roster: an imported entry updates/adds metadata but preserves the live system prompt
    // (never in the export). A roster with no live match is added with an empty system (re-woken later).
    for (const a of sec.roster) {
      const cur = agentRoster.get(a.agentId) || { system: '', name: a.agentId, model: null, provider: null, role: '', approvalMode: 'ask' };
      agentRoster.set(a.agentId, Object.assign({}, cur, {
        name: a.name || cur.name, model: a.model || cur.model,
        provider: a.provider ? normalizeProviderId(a.provider) : cur.provider, role: a.role || cur.role
      }));
    }
    saveAgentRoster(); applied.push('roster');
  }
  if (want('dossier') && sec.dossier) { commanderDossier.set(sec.dossier.block || ''); applied.push('dossier'); }
  if (want('permissions') && sec.permissions && Array.isArray(sec.permissions.allow)) {
    // UNION with existing grants (import never silently REVOKES a live grant); stamp provenance for new keys.
    const next = new Set([...grantsPermanent]);
    for (const k of sec.permissions.allow) next.add(k);
    grantsPermanent.clear(); for (const k of next) grantsPermanent.add(k);
    const meta = Object.assign({}, grantMeta);
    for (const k of grantsPermanent) { if (!meta[k]) meta[k] = { grantedAt: Date.now() }; }
    try { persistAllowlist(grantsPermanent, meta); Object.assign(grantMeta, meta); } catch (_) {}
    applied.push('permissions');
  }
  if (want('connectors') && Array.isArray(sec.connectors)) {
    // upsert each imported connector by id (secrets stripped → they land unconfigured; user re-enters). Preserve
    // any live secret for an id that already exists so a re-import doesn't wipe a working connector's token.
    const byId = new Map((connectorConfigs || []).map(c => [c.id, c]));
    for (const c of sec.connectors) {
      const live = byId.get(c.id);
      const merged = Object.assign({}, c);
      if (live && live.token) merged.token = live.token;             // keep an existing secret
      if (live && live.headers) merged.headers = Object.assign({}, c.headers, redactSecretKeep(live.headers, c.headers));
      byId.set(c.id, merged);
    }
    connectorConfigs = [...byId.values()];
    saveConnectorConfigs(); applied.push('connectors');
  }

  // browser-owned slices are echoed back for the app to restore into its own localStorage.
  const browser = {};
  if (want('settings') && sec.settings) browser.settings = sec.settings;
  if (want('autonomy') && sec.autonomy) browser.autonomy = sec.autonomy;
  if (want('notifyPrefs') && sec.notifyPrefs) browser.notifyPrefs = sec.notifyPrefs;

  return json(200, { ok: true, applied, secretsNeeded: parsed.secretsNeeded || [], notes: parsed.notes || [], browser });
}

// tiny helper: keep a live header value only for keys the imported config left blank (i.e. the redacted ones),
// so re-importing a redacted export doesn't clobber a header the user already re-entered live.
function redactSecretKeep(liveHeaders, importedHeaders) {
  const out = {}; const imp = importedHeaders || {};
  for (const k of Object.keys(liveHeaders || {})) { if (!(k in imp)) out[k] = liveHeaders[k]; }
  return out;
}

/* POST /api/config/reset { section } -> reset ONE server-side section to its environment/empty default, live.
   section ∈ budget|fallback|roster|dossier|permissions|connectors. Browser sections (settings/autonomy/
   notifyPrefs) reset in the app itself (localStorage). Returns { ok, section }. */
async function handleConfigReset(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const section = String(body.section || '').trim();
  switch (section) {
    case 'budget': budgetOverrides = {}; saveBudgetOverrides(); applyBudgetCaps(); break;
    case 'fallback': fallbackSaved = null; saveFallbackChain(); break;
    case 'roster': agentRoster.clear(); saveAgentRoster(); break;
    case 'dossier': commanderDossier.set(''); break;
    case 'permissions': {
      grantsPermanent.clear();
      for (const k of Object.keys(grantMeta)) delete grantMeta[k];
      try { persistAllowlist(grantsPermanent, {}); } catch (_) {}
      break;
    }
    case 'connectors': connectorConfigs = []; saveConnectorConfigs(); break;
    default: return json(400, { error: 'unknown or non-resettable section: ' + (section || '(empty)') });
  }
  return json(200, { ok: true, section });
}

/* ---- P1-9 ADVANCED runtime knobs API. GET reports each knob's effective/default/saved value + whether an env
   var locks it (so the UI can gray it out honestly). POST persists overrides (env-locked knobs ignore the write).
   Saved values apply at NEXT BOOT (they feed the boot-frozen constants) — the UI discloses this. ---- */
const RUNTIME_KNOB_DEFS = [
  { key: 'maxIters', env: 'MAX_ITERS', def: 40, min: 1, max: 200 },
  { key: 'maxConcurrentAgents', env: 'MAX_CONCURRENT_AGENTS', def: 3, min: 0, max: 32 },
  { key: 'consentTimeoutMs', env: 'CONSENT_TIMEOUT_MS', def: 120000, min: 5000, max: 600000 },
  { key: 'cronTickMs', env: 'CRON_TICK_MS', def: 60000, min: 5000, max: 600000 }
];
function saveRuntimeKnobs() {
  try { saveResilient(RUNTIME_KNOBS_FILE, { version: 1, knobs: runtimeKnobs }); }
  catch (e) { console.warn('[knobs] persist failed:', (e && e.message) || e); }
}
function runtimeKnobsStatus() {
  const fields = {};
  for (const d of RUNTIME_KNOB_DEFS) {
    const locked = knobEnvLocked(d.env);
    const saved = (typeof runtimeKnobs[d.key] === 'number') ? runtimeKnobs[d.key] : null;
    const effective = resolveKnob(d.env, d.key, d.def);
    fields[d.key] = { effective, default: d.def, saved, envLocked: locked, min: d.min, max: d.max };
  }
  return { fields };
}
function handleRuntimeKnobsGet(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(runtimeKnobsStatus()));
}
async function handleRuntimeKnobsSet(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const next = Object.assign({}, runtimeKnobs);
  for (const d of RUNTIME_KNOB_DEFS) {
    if (!Object.prototype.hasOwnProperty.call(body, d.key)) continue;
    if (knobEnvLocked(d.env)) continue;                 // an env-locked knob can't be overridden from the UI
    const v = body[d.key];
    if (v == null || v === '') { delete next[d.key]; continue; }   // clear the override
    const n = Number(v);
    if (!isFinite(n) || n < d.min || n > d.max) return json(400, { error: d.key + ' must be ' + d.min + '–' + d.max });
    next[d.key] = Math.floor(n);
  }
  runtimeKnobs = next;
  saveRuntimeKnobs();
  return json(200, runtimeKnobsStatus());
}

function setProviderRuntimeConfig(provider, patch) {
  const id = normalizeProviderIdFromRegistry(provider, '');
  if (!id || !getProviderProfile(id)) return null;
  patch = patch || {};
  if (Object.prototype.hasOwnProperty.call(patch, 'key')) {
    const key = String(patch.key || '').trim();
    if (key) runtimeKeys[id] = key;
    else delete runtimeKeys[id];
    if (id === 'openrouter') runtimeKey = key;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'baseUrl')) {
    const baseUrl = String(patch.baseUrl || '').trim();
    if (baseUrl) runtimeBaseUrls[id] = baseUrl;
    else delete runtimeBaseUrls[id];
  }
  return id;
}

/* desktop key push: the parent shell sets live BYOK/provider config here (token-gated), so changing a
   key never restarts the sidecar. Legacy text/plain bodies still update the OpenRouter key. */
async function handleSetKey(req, res) {
  const token = String(ENV('IPC_TOKEN') || '');
  if (!token || (req.headers['x-starnet-token'] || req.headers['x-skynet-token']) !== token) { res.writeHead(403); return res.end('forbidden'); }
  let raw = '';
  try { raw = String(await readBody(req, 1 << 16) || ''); } catch (_) {}
  let provider = 'openrouter';
  let patch = { key: raw };
  const trimmed = raw.trim();
  if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
    try {
      const body = JSON.parse(trimmed);
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        provider = body.provider || body.id || provider;
        patch = {};
        if (Object.prototype.hasOwnProperty.call(body, 'key')) patch.key = body.key;
        if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) patch.key = body.apiKey;
        if (Object.prototype.hasOwnProperty.call(body, 'api_key')) patch.key = body.api_key;
        if (Object.prototype.hasOwnProperty.call(body, 'baseUrl')) patch.baseUrl = body.baseUrl;
        if (Object.prototype.hasOwnProperty.call(body, 'base_url')) patch.baseUrl = body.base_url;
      }
    } catch (_) {}
  }
  const id = setProviderRuntimeConfig(provider, patch);
  if (!id) { res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ error: 'unknown provider' })); }
  const key = providerRuntimeKey(id, '');
  const baseUrl = providerRuntimeBaseUrl(id, '');
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  return res.end(JSON.stringify({ ok: true, provider: id, configured: providerHasCredential(id, key, baseUrl) }));
}

/* ---- /api/toolsets: the TOOLSETS console. GET lists every toggleable capId family (DERIVED from CAP_REGISTRY,
   never a hand-kept parallel list) with its enabled flag, the granting objectType, its tools, a consent summary,
   and whether that object is PLACED anywhere on the station (the client passes ?placed=<types> — the same
   station-wide placement source SKILLS uses; we never guess). POST /api/toolsets/:id { enabled } flips the
   persisted kill-switch and applies LIVE (the next resolveTools call reflects it). `compute` is refused. ---- */
function handleToolsetsList(req, res) {
  let placedTypes = [];
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    placedTypes = placedTypesFrom(u.searchParams.get('placed') || '');
  } catch (_) {}
  const placedSet = {}; for (const t of placedTypes) placedSet[t] = true;
  const rows = toolsetRows(CAP_REGISTRY).map(r => ({
    id: r.id,
    label: r.label,
    glyph: r.glyph,
    desc: r.desc,
    object: r.object,                         // the objectType that must be placed to grant this family
    tools: r.tools,
    toolCount: r.tools.length,
    enabled: toolsetDisabled[r.id] !== false, // default ON; only false when explicitly persisted OFF
    placed: !!(r.object && placedSet[r.object]),
    consentGated: r.consentGated              // does any tool in the family ask first?
  }));
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ toolsets: rows }));
}
async function handleToolsetToggle(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let id = '';
  try { id = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/api\/toolsets\//, '')); } catch (_) {}
  id = String(id || '').trim();
  if (!id) return json(400, { error: 'a toolset id is required' });
  if (id === 'compute') return json(400, { error: 'compute is the always-on compute gate and cannot be toggled' });
  if (TOGGLEABLE_CAPS.indexOf(id) < 0) return json(404, { error: 'unknown toolset: ' + id });
  let body; try { body = JSON.parse(await readBody(req, 1 << 12)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  if (typeof body.enabled !== 'boolean') return json(400, { error: 'enabled must be a boolean' });
  if (body.enabled) delete toolsetDisabled[id]; else toolsetDisabled[id] = false;   // sparse: only OFF is persisted
  saveToolsetState();   // durable; the in-memory map is already live for the next resolveTools call
  return json(200, { ok: true, id, enabled: body.enabled });
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
  // ADDITIVE: optional custom HTTP headers (object of strings) + an optional per-connector timeout (ms).
  let headers = (prev.headers && typeof prev.headers === 'object') ? Object.assign({}, prev.headers) : {};
  if ('headers' in body) {
    if (!body.headers || typeof body.headers !== 'object' || Array.isArray(body.headers)) return json(400, { error: 'http headers must be an object' });
    headers = {};
    for (const k of Object.keys(body.headers)) headers[String(k)] = String(body.headers[k] == null ? '' : body.headers[k]);
  }
  let timeoutMs = (typeof prev.timeoutMs === 'number' && prev.timeoutMs > 0) ? prev.timeoutMs : undefined;
  if ('timeout' in body || 'timeoutMs' in body) {
    const raw = ('timeoutMs' in body) ? body.timeoutMs : body.timeout;
    if (raw === '' || raw == null) { timeoutMs = undefined; }
    else {
      const n = Number(raw);
      if (!isFinite(n) || n <= 0) return json(400, { error: 'timeout must be a positive number of milliseconds' });
      timeoutMs = Math.max(1000, Math.min(600000, Math.round(n)));
    }
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
    headers: transport === 'http' ? headers : {},
    label: String(body.label || prev.label || id),
    enabled: body.enabled !== false
  };
  if (timeoutMs) cfg.timeoutMs = timeoutMs;
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
  if (!p) { const e = new Error('provider is not registered'); e.code = 400; throw e; }
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

// POST /api/cron — create a routine. body: { name, prompt, schedule:<string>, agentId?, model?, provider?, deliver?, enabled?, repeat?, meta? }
//   meta (R3): an optional provenance bag, e.g. { recipeId } stamped by the recipe MAKE-ROUTINE flow. Additive.
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
        enabled: body.enabled, repeat: body.repeat,
        // R3: pass through the caller-supplied provenance bag ({ recipeId } from MAKE ROUTINE). cron-store normMeta
        // keeps only a plain object; absent → null. Additive — no existing caller sends it and old jobs load fine.
        meta: body.meta
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
  placeCronWorkitem(job.agentId, job.prompt, runId);
  try {
    await runOnce({
      key: key, model: model, system: cronSystemFor(job.agentId), messages: [{ role: 'user', content: String(job.prompt || '') }],
      agentId: job.agentId, isTask: true, emit: teeEmit, signal: ac.signal,
      // streamId 'cron-'+runId matches the SCHEDULED fire (cron-driver.js): Run Now must persist its transcript
      // under the SAME per-run stream so the frontend cron-session (autosessions.js), which forms off the
      // identical cron.fire/cron.result events, can fetch the real output via /api/transcript?stream=cron-<runId>.
      // Per-run id keeps the seed empty (index.js reconstructs a stream only when messages<=1) — no behavior drift.
      runId: runId, streamId: 'cron-' + runId, surface: 'autonomous', trigger: 'schedule', provider: provider, broadcast: true
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

/* ============================ AWAY WORKSHOP (W2 — the away-work driver) ============================
   When the Commander grants "Build things while I'm away" for an agent, a per-agent WORKSHOP SHIFT (reusing the
   cron scheduler — see armWorkshopShift below) pops the top backlog item and fires a runOnce on the AUTONOMOUS
   surface (isTask, jail-scoped writes unlocked by the W1 grant) with a persona that REQUIRES building the
   deliverable under workshop/<runId>/ and writing a deliverable.json manifest (pinned schema, plan §4). On
   completion the manifest is VALIDATED against the real files on disk; only a valid manifest emits workshop.built.
   Empty backlog → a silent no-op (no toast, no event). Nothing is ever auto-applied to the user's real projects. */

// the WORKSHOP shift prompt/persona. Plain language (ease-of-use law): it tells the agent to actually BUILD, where
// to put it, and to describe it honestly. The '[WORKSHOP_SHIFT]' first line is also the cron routine's stored
// prompt sentinel (armWorkshopShift) — the injected runOnce wrapper detects it and redirects to runWorkshopShift.
const WORKSHOP_MARK = '[WORKSHOP_SHIFT]';
function workshopPrompt(runId, item) {
  const dir = 'workshop/' + runId;
  const what = (item && (item.title || item.detail)) ? ((item.title || '') + (item.detail ? ('\n\nDetails: ' + item.detail) : '')) : 'a small, genuinely useful deliverable';
  return WORKSHOP_MARK + '\n'
    + 'You are working in your private workshop while the Commander is away — build something real and reviewable.\n\n'
    + 'BUILD THIS:\n' + what + '\n\n'
    + 'RULES:\n'
    + '- Put every file for this deliverable UNDER the folder "' + dir + '/" in your workspace (use fs.write with paths like "' + dir + '/<file>").\n'
    + '- Do the actual work with your real tools (web search/read, files, memory). Ground factual claims in what the tools return.\n'
    + '- You CANNOT run commands or tests here, so do not claim anything was tested — list what a human still needs to verify.\n'
    + '- When finished, write a manifest to "' + dir + '/deliverable.json" with EXACTLY this shape:\n'
    + '  { "v": 1, "runId": "' + runId + '", "agentId": "<your id>", "backlogId": "' + ((item && item.id) || '') + '",\n'
    + '    "title": "<short name>", "kind": "tool|fix|draft|doc|other", "summary": "<one paragraph, plain language>",\n'
    + '    "files": [{ "path": "<relative to ' + dir + '>", "bytes": <number> }],\n'
    + '    "howToUse": "<how the Commander uses it>", "notVerified": ["<what you could not check>"] }\n'
    + '- The manifest MUST list the real files you wrote (paths relative to "' + dir + '/"). This is required — a shift with no manifest is discarded.';
}

// validate a run's deliverable.json against the pinned schema v1 AND the real files on disk. Returns the parsed
// manifest (normalized) on success, or null with a reason logged. Truthful telemetry: workshop.built is emitted
// ONLY when this passes, so the return-card never asserts a deliverable the harness can't prove exists.
async function validateWorkshopManifest(agentId, runId) {
  const relDir = 'workshop/' + runId;
  let manAbs, base;
  try { const r = await fsJail.resolveInside(agentId, relDir + '/deliverable.json'); manAbs = r.abs; base = r.base; }
  catch (e) { console.warn('[workshop] manifest path rejected for', agentId, runId, '-', (e && e.message) || e); return null; }
  let raw;
  try { raw = await fsp.readFile(manAbs, 'utf8'); }
  catch (_) { console.warn('[workshop] no deliverable.json for', agentId, 'run', runId, '— not emitting'); return null; }
  let man; try { man = JSON.parse(raw); } catch (_) { console.warn('[workshop] deliverable.json is not valid JSON for run', runId); return null; }
  if (!man || typeof man !== 'object' || man.v !== 1) { console.warn('[workshop] manifest missing v:1 for run', runId); return null; }
  if (!Array.isArray(man.files) || !man.files.length) { console.warn('[workshop] manifest lists no files for run', runId); return null; }
  // PROVE each listed file exists inside the run dir (jail-checked). Recompute bytes from disk (never trust the
  // model's number) and drop any listed file that isn't actually there — an empty proven set fails validation.
  const runDirRel = relDir + '/';
  const provenFiles = [];
  for (const f of man.files) {
    const p = String((f && f.path) || '').replace(/^[\\/]+/, '');
    if (!p || p === 'deliverable.json') continue;
    let abs; try { ({ abs } = await fsJail.resolveInside(agentId, runDirRel + p)); } catch (_) { continue; }
    let st; try { st = await fsp.stat(abs); } catch (_) { continue; }
    if (st && st.isFile()) provenFiles.push({ path: p, bytes: st.size });
  }
  if (!provenFiles.length) { console.warn('[workshop] no listed file actually exists on disk for run', runId, '— not emitting'); return null; }
  // return a normalized, disk-proven manifest (the card renders THIS, not the model's raw claims).
  return {
    v: 1, runId: String(runId), agentId: String(agentId), backlogId: String(man.backlogId || ''),
    title: String(man.title || 'Untitled deliverable').slice(0, 200),
    kind: ['tool', 'fix', 'draft', 'doc', 'other'].indexOf(man.kind) >= 0 ? man.kind : 'other',
    summary: String(man.summary || '').slice(0, 4000),
    files: provenFiles,
    howToUse: String(man.howToUse || '').slice(0, 4000),
    notVerified: Array.isArray(man.notVerified) ? man.notVerified.map(s => String(s).slice(0, 500)).slice(0, 40) : []
  };
}

// run ONE workshop shift for an agent: claim the top backlog item, build it under workshop/<runId>/, validate the
// manifest, and (only if valid) emit workshop.built. Reuses the SAME runOnce host + autonomous posture as cron.
// Returns { fired, runId?, reason }. An empty/denied backlog is a SILENT no-op (fired:false, no event, no toast).
async function runWorkshopShift(agentId, opts) {
  const o = opts || {};
  const id = String(agentId || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { fired: false, reason: 'bad-agent' };
  if (!workshopOf(id)) return { fired: false, reason: 'not-granted' };   // grant revoked between arm and fire
  const runId = o.runId || crypto.randomUUID();
  const item = await workshopStore.claimNext(id, runId);
  if (!item) return { fired: false, reason: 'empty-backlog' };           // nothing to build → silent no-op

  const model = cronModelFor({ agentId: id });
  const provider = cronProviderFor({ agentId: id });
  const key = cronKeyFor(provider);
  if (!model || !cronHasCredential(provider, key)) {
    await workshopStore.releaseClaim(id, runId);                          // couldn't run → return the item to the queue
    return { fired: false, reason: 'no-capability' };
  }

  const ac = o.signal ? null : new AbortController();
  const signal = o.signal || (ac && ac.signal);
  if (ac) runs.set(runId, ac);
  const emit = typeof o.emit === 'function' ? o.emit : function () {};
  const prompt = workshopPrompt(runId, item);
  try { placeCronWorkitem(id, 'Workshop: ' + (item.title || 'build'), runId); } catch (_) {}
  let threw = null;
  try {
    await runOnce({
      key: key, model: model, system: cronSystemFor(id),
      messages: [{ role: 'user', content: prompt }],
      agentId: id, isTask: true, emit: emit, signal: signal,
      runId: runId, streamId: 'workshop-' + runId, surface: 'autonomous', trigger: 'schedule', provider: provider, broadcast: !!o.broadcast
    });
  } catch (e) { threw = e; }
  finally { if (ac) runs.delete(runId); }

  // VALIDATE the manifest against the real files. Only a proven manifest emits workshop.built (truthful telemetry).
  const manifest = await validateWorkshopManifest(id, runId);
  if (!manifest) {
    await workshopStore.releaseClaim(id, runId);   // no deliverable produced → item stays queued for a later shift
    return { fired: true, runId: runId, reason: threw ? 'run-failed' : 'no-manifest' };
  }
  await workshopStore.markBuilt(id, item.id, runId);
  try { chanEmit('workshop.built', { agentId: id, runId: runId, manifest: manifest }); } catch (_) {}
  return { fired: true, runId: runId, reason: 'built', manifest: manifest };
}

/* ---- the WORKSHOP SHIFT ROUTINE: a per-agent cron routine, armed when the toggle flips ON, disarmed OFF.
   We REUSE the cron scheduler rather than build a new one: the routine's stored prompt is the WORKSHOP_MARK
   sentinel, and the runOnce wrapper injected into the cron driver (below) detects it and redirects the fire to
   runWorkshopShift(). Default cadence: a slow recurring shift so an away agent picks up queued work on its own;
   force-fireable via POST /api/workshop/shift for an attended test. Idempotent: at most ONE workshop routine per
   agent (found by meta.workshop). ---- */
const WORKSHOP_SHIFT_SCHEDULE = String(ENV('WORKSHOP_SHIFT_SCHEDULE') || 'every 360m');   // slow by default; overridable
function findWorkshopRoutine(agentId) {
  const id = String(agentId || '');
  return (cronJobs || []).find(j => j && j.meta && j.meta.workshop === true && j.agentId === id) || null;
}
function armWorkshopShift(agentId) {
  const id = String(agentId || '');
  if (findWorkshopRoutine(id)) return false;   // already armed (idempotent)
  let schedule; try { schedule = parseCronScheduleOr400(WORKSHOP_SHIFT_SCHEDULE, Date.now()); } catch (_) { schedule = cron.parseSchedule('every 360m', Date.now()); }
  const jobId = crypto.randomUUID();
  try {
    withCronWrite(jobs => cronStore.createJob(jobs, {
      id: jobId, name: 'Away workshop — ' + id, prompt: WORKSHOP_MARK, schedule: schedule,
      agentId: id, enabled: true, meta: { workshop: true }
    }, { id: jobId, now: Date.now() }));
  } catch (e) { console.warn('[workshop] arm routine failed:', (e && e.message) || e); return false; }
  // arming the shift needs the tick timer running so it actually fires unattended; arm cron if it isn't already.
  try { if (!cronArmed) { cronArmed = true; saveCronArmed(true); armCron(); } } catch (_) {}
  return true;
}
function disarmWorkshopShift(agentId) {
  const j = findWorkshopRoutine(agentId);
  if (!j) return false;
  try { withCronWrite(jobs => cronStore.removeJob(jobs, j.id)); } catch (e) { console.warn('[workshop] disarm routine failed:', (e && e.message) || e); return false; }
  return true;
}

// POST /api/workshop/grant { agentId, on } — record/clear the Commander's "Build things while I'm away" consent
// for an agent, and arm/disarm its workshop shift routine accordingly. Plain-language surface; not a jargon knob.
async function handleWorkshopGrant(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { return json(400, { error: 'bad request' }); }
  const agentId = String(body.agentId || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(400, { error: 'choose a valid agent' });
  const on = body.on === true || body.on === 'true';
  try { await workshopStore.setGrant(agentId, on); } catch (e) { return json(500, { error: 'could not save that setting' }); }
  try { if (on) armWorkshopShift(agentId); else disarmWorkshopShift(agentId); } catch (_) {}
  json(200, { ok: true, agentId: agentId, on: on });
}

// POST /api/workshop/queue { agentId, title, detail?, source? } — add a build request ("Build this while I'm
// away"). Returns the queued item, or a plain error if the agent isn't granted / the id was already discarded.
async function handleWorkshopQueue(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad request' }); }
  const agentId = String(body.agentId || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(400, { error: 'choose a valid agent' });
  const title = String(body.title || '').trim();
  if (!title && !String(body.detail || '').trim()) return json(400, { error: 'say what to build' });
  const item = { id: (body.id && /^[A-Za-z0-9_-]{1,64}$/.test(String(body.id))) ? String(body.id) : crypto.randomUUID(), title: title, detail: body.detail, source: (body.source === 'quest' ? 'quest' : 'queued') };
  let r;
  try { r = await workshopStore.queue(agentId, item, Date.now()); } catch (e) { return json(500, { error: 'could not queue that' }); }
  // DEDUP DOCTRINE (mint-ledger lane): never re-create work that already exists. A duplicate/discarded add returns
  // ok:false with a plain, anti-retry-style message so the model/UI stops re-queuing the same thing.
  if (r.reason === 'duplicate') return json(200, { ok: false, reason: 'duplicate', item: r.item, message: 'That is already on the build list — no need to add it again.' });
  if (r.reason === 'discarded') return json(200, { ok: false, reason: 'discarded', message: 'That work was discarded before and will not be built again — do not re-queue it.' });
  if (r.reason === 'exists') return json(200, { ok: true, item: r.item, reason: 'exists', message: 'Already queued.' });
  json(200, { ok: true, item: r.item, reason: 'added' });
}

// GET /api/workshop/backlog?agent=<id> — the raw queued/building/built items for an agent (the "what's lined up" view).
async function handleWorkshopBacklog(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const agentId = String((new URL(req.url, 'http://x')).searchParams.get('agent') || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(400, { error: 'choose a valid agent' });
  let rec; try { rec = workshopStore.read(agentId); } catch (e) { return json(500, { error: 'could not read the backlog' }); }
  json(200, { ok: true, agentId: agentId, granted: rec.grant, backlog: rec.backlog });
}

// GET /api/workshop/pending?agent=<id> — undecided deliverable manifests (built, not yet kept/discarded/dismissed).
// Reads each built item's on-disk manifest (re-validated so a wiped/edited dir never shows a phantom deliverable).
async function handleWorkshopPending(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const agentId = String((new URL(req.url, 'http://x')).searchParams.get('agent') || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(400, { error: 'choose a valid agent' });
  const rec = workshopStore.read(agentId);
  const out = [];
  for (const it of rec.backlog) {
    if (!it.builtRunId) continue;
    const man = await validateWorkshopManifest(agentId, it.builtRunId);   // re-prove it still exists
    if (man) out.push(man);
  }
  json(200, { ok: true, agentId: agentId, pending: out });
}

// POST /api/workshop/decide { agentId, runId, decision: 'keep'|'discard'|'later', destPath? } — the return-card's
// verdict. keep = copy the run dir's files to destPath under normal interactive consent; discard = delete the run
// dir + denylist the backlogId; later = dismiss only (leave everything in the workshop). Emits workshop.decided.
async function handleWorkshopDecide(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad request' }); }
  const agentId = String(body.agentId || '');
  const runId = String(body.runId || '');
  const decision = String(body.decision || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(400, { error: 'choose a valid agent' });
  if (['keep', 'discard', 'later'].indexOf(decision) < 0) return json(400, { error: 'unknown decision' });
  const item = workshopStore.itemForRun(agentId, runId);
  const relDir = 'workshop/' + runId;

  if (decision === 'later') {
    try { chanEmit('workshop.decided', { agentId, runId, decision: 'later' }); } catch (_) {}
    return json(200, { ok: true, decision: 'later' });
  }

  if (decision === 'discard') {
    // wipe the run dir (jail-checked) and denylist the backlogId so it isn't silently rebuilt.
    try { const { abs } = await fsJail.resolveInside(agentId, relDir); await fsp.rm(abs, { recursive: true, force: true }); } catch (_) {}
    if (item) { try { await workshopStore.discard(agentId, item.id); } catch (_) {} }
    try { chanEmit('workshop.decided', { agentId, runId, decision: 'discard' }); } catch (_) {}
    return json(200, { ok: true, decision: 'discard' });
  }

  // keep: copy the deliverable's real files out to destPath. destPath is an ABSOLUTE, user-chosen folder — this is
  // an interactive, user-initiated action (they clicked Keep and picked a folder), so it writes OUTSIDE the jail
  // by design. We validate the manifest first (only copy proven files) and never touch anything but destPath.
  const destPath = String(body.destPath || '');
  if (!destPath) return json(400, { error: 'choose where to keep it' });
  const man = await validateWorkshopManifest(agentId, runId);
  if (!man) return json(404, { error: 'that deliverable is no longer available' });
  let copied = 0;
  try {
    for (const f of man.files) {
      const { abs: srcAbs } = await fsJail.resolveInside(agentId, relDir + '/' + f.path);
      const destAbs = path.join(destPath, f.path);
      await fsp.mkdir(path.dirname(destAbs), { recursive: true });
      await fsp.copyFile(srcAbs, destAbs);
      copied++;
    }
  } catch (e) { return json(500, { error: 'could not copy the files: ' + ((e && e.message) || e) }); }
  try { chanEmit('workshop.decided', { agentId, runId, decision: 'keep', destPath: destPath }); } catch (_) {}
  json(200, { ok: true, decision: 'keep', destPath: destPath, copied: copied });
}

// POST /api/workshop/shift { agentId } — force-fire ONE workshop shift NOW (attended test of the unattended path).
// Streams the run as NDJSON like /api/cron/run, then reports whether a deliverable was built.
async function handleWorkshopShiftNow(req, res) {
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { res.writeHead(400); return res.end('bad json'); }
  const agentId = String(body.agentId || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'choose a valid agent' })); }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const bus = { emit: (name, payload) => { try { res.write(JSON.stringify({ name, payload: redact(payload) }) + '\n'); } catch (_) {} } };
  const emit = makeEmitter(bus, e => { if (e && e.event !== 'tool.web') console.warn('[event]', e.kind, e.event, (e.errors || []).join(';')); });
  let result;
  try { result = await runWorkshopShift(agentId, { emit: emit, broadcast: true }); }
  catch (e) { result = { fired: false, reason: 'error: ' + ((e && e.message) || e) }; }
  try { res.write(JSON.stringify({ name: 'workshop.shift.result', payload: result }) + '\n'); } catch (_) {}
  try { res.end(); } catch (_) {}
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

// POST /api/goals { goal } — GROWTH Tier 2: the browser pushes the ACTIVE goal-arc summary whenever it changes
// (or null to clear it), so server-composed autonomous runs (cron) can fold in the current direction. Contract-
// free: plain HTTP, no bus event. Mirrors handleDossier.
async function handleGoals(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 1 << 16)); }
  catch (e) { res.writeHead(400); return res.end('bad json'); }
  commanderGoals.set(body && body.goal);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, goal: commanderGoals.get() }));
}

function placedTypesFrom(v) {
  if (Array.isArray(v)) return v.map(e => (e && typeof e === 'object') ? e.objectType : e).map(s => String(s || '').trim()).filter(Boolean);
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

function slashOptions(placedTypes) {
  const skills = skillsCatalog.catalog(SKILL_LIBRARY, { overrides: skillPrefs.overrides(), placedTypes: placedTypes || [] });
  const recipes = (Recipes && Recipes.builtins) ? Recipes.builtins() : [];
  return { skills, recipes };
}

// GET /api/slash/catalog -- server-owned command metadata for chat palettes and future gateway surfaces.
function serveSlashCatalog(req, res) {
  let placedTypes = [];
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    placedTypes = placedTypesFrom(u.searchParams.get('placed') || '');
  } catch (_) {}
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(slash.catalog(slashOptions(placedTypes))));
}

// POST /api/slash/dispatch { input } -- resolve a slash command to a typed client directive. The browser
// performs local UI actions for Plan 1; this endpoint establishes the shared dispatch seam without changing
// shared bus/schema contracts.
async function handleSlashDispatch(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 14)) || {}; } catch (e) { return json(400, { ok: false, error: 'bad json' }); }
  const input = body.input != null ? body.input : ('/' + String(body.command || ''));
  const out = slash.dispatch(input, slashOptions(placedTypesFrom(body.placed)));
  json(out.ok ? 200 : (out.status || 400), out);
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

// GET /api/agent-skills?agent=<id>&archived=1&body=1 - runtime-created skills for the selected agent.
// Distinct from /api/skills, which is the bundled recipe catalog. This endpoint is for the human-visible
// owned skillbase; the model still sees only the prompt index and must use skill.view for bodies.
function serveAgentSkills(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agentId = u.searchParams.get('agent') || 'agent';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(403, { error: 'forbidden' });
    const includeArchived = u.searchParams.get('archived') === '1' || u.searchParams.get('state') === 'all';
    const includeBody = u.searchParams.get('body') === '1';
    let skills = skillStore.list(agentId, { includeArchived });
    if (includeBody) {
      skills = skills.map(s => skillStore.view(agentId, s.id, { includeArchived: true, bump: false }) || s);
    }
    json(200, { agentId, skills });
  } catch (e) { json(200, { skills: [] }); }
}

// POST /api/agent-skills/manage { agentId, action, ... } - user-visible runtime skill management.
async function handleAgentSkillManage(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 20)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const agentId = String(body.agentId || 'agent');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(403, { error: 'forbidden' });
  const r = skillStore.manage(Object.assign({}, body, { agentId, createdBy: 'user' }));
  if (!r.ok) return json(400, { error: r.error || 'could not update skill' });
  chanEmit('deliverable', { id: r.skill.id, agentId, kind: 'skill', title: r.skill.name });
  json(200, { ok: true, action: r.action, skill: r.skill });
}

/* ------------------------------- the run endpoint ------------------------------- */
async function handleRun(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 2 << 20)); }
  catch (e) { res.writeHead(400); return res.end('bad json'); }
  const { model, system, messages = [], agentId = 'agent', isTask = false, provider, fallbackModels, fallbackProviders } = body || {};
  const recurring = !!(body && body.recurring);   // the browser's mint detector saw this task SHAPE before → salience boost for reflection
  const runProvider = normalizeProvider(provider);
  const reasoningEffort = resolveReasoningEffort(runProvider, body && (body.reasoningEffort || body.reasoning_effort || (body.reasoning && body.reasoning.effort)));
  const preloadSkills = Array.isArray(body && body.preloadSkills) ? body.preloadSkills.map(s => String(s || '').trim()).filter(Boolean).slice(0, 8) : [];
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
  // Class Loadouts (shared-gear model): the STATION-WIDE gear the agent draws on under the overseer. Used ONLY for
  // SKILL availability (a class's recipes need the station to have the gear, not the agent's desk-room) — the TOOL
  // projection stays gated by extraObjects/`placed` (room-scoped). Absent (older client / headless) -> undefined,
  // and the compose site falls back to the room's placedTypes exactly as before.
  const stationObjects = (body && Array.isArray(body.stationPlaced)) ? placedTypesFrom(body.stationPlaced) : null;
  const usingCodex = providerUsesCodex(runProvider);   // Codex authenticates by OAuth token, not an API key
  // Desktop build: the key lives in runtimeKey (from the keychain, seeded via env at spawn and updatable
  // via /api/key). The browser build still sends body.key, which wins.
  const baseUrl = providerRuntimeBaseUrl(runProvider, body && (body.baseUrl || body.base_url));
  const key = providerRuntimeKey(runProvider, body && body.key);
  if (!model || !providerHasCredential(runProvider, key, baseUrl)) { res.writeHead(400); return res.end('missing key/model'); }

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
      key, model, system, messages, agentId, isTask, provider: runProvider, baseUrl, reasoningEffort, fallbackModels, fallbackProviders,
      emit, signal: ac.signal, runId, trigger: 'directive',
      surface: 'interactive', prompt: promptConsent, summon: summonRequest,   // team.summon → live summonAgent() round-trip
      streamId,        // M-mem.2b: scope this run's working memory + recall boost to the active workstream
      preloadSkills,
      extraObjects,    // a placed WORKBENCH -> shell.exec + verify.run, additive on the default office
      stationObjects,  // Class Loadouts (shared-gear): station-wide gear for SKILL availability (tools stay room-scoped)
      reflect: true,  // only the WATCHED browser run reflects -> a turn-in beat; the headless hub omits this
      recurring,      // salience signal: did the mint detector see this task shape before? (decision 3)
      lead: true      // Stage 2: ONLY the browser-commanded run is a lead — it alone gets the orchestrator object
                      // (delegate tool). A delegated worker runs via team.dispatch with lead falsy -> cannot re-delegate.
    });
  } catch (e) {
    try { emit('agent.run.error', { agentId, runId, message: 'sidecar failure: ' + ((e && e.message) || e), transient: false }); } catch (_) {}
  } finally {
    runs.delete(runId);
    steerBuffers.delete(runId);      // drop any un-drained steering notes so they can't leak to a later run
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
  // P1-6 per-agent model/provider OVERRIDE: when a run carries NO explicit model/provider (headless hub, delegated
  // worker, or any caller that didn't pass one), fall back to THIS AGENT's pinned identity in the roster before the
  // station default. An explicit per-run o.model/o.provider still wins (the interactive dock path is unchanged), so
  // this only fills a gap — it never overrides a choice the caller actually made. Honest: the pin lives in the same
  // roster the dossier writes + cron already reads (cronModelFor), so what the UI shows == what the run uses.
  const rosterIdent = agentRoster.get(String(agentId || '')) || null;
  const providerId = normalizeProvider(o.provider || (rosterIdent && rosterIdent.provider) || '');
  const usingCodex = providerUsesCodex(providerId);
  const providerUnmetered = !!((getProviderProfile(providerId) || {}).unmetered);
  // Class Loadouts S1: reasoning-effort precedence = explicit run-option > this agent's roster record (the class
  // applied default) > provider default. An explicit per-run choice still wins; the roster only fills a gap.
  const reasoningEffort = resolveReasoningEffort(providerId, o.reasoningEffort || o.reasoning_effort || (o.reasoning && o.reasoning.effort) || (rosterIdent && rosterIdent.reasoningEffort));
  let model = String((o && o.model) || '').trim() || (rosterIdent && rosterIdent.model ? String(rosterIdent.model).trim() : '') || (usingCodex ? CODEX_DEFAULT_MODEL : CRON_DEFAULT_MODEL);
  const baseUrl = providerRuntimeBaseUrl(providerId, o.baseUrl || o.base_url || '');
  const runKey = providerRuntimeKey(providerId, key);
  const streamId = o.streamId || null;   // M-mem.2b (browser run only; the headless hub omits it → global memory)
  const surface = o.surface || 'interactive';
  const prompt = o.prompt;
  const summon = o.summon;   // the live team.summon round-trip closure (browser runs only); undefined for headless/workers → tool degrades gracefully
  const trigger = o.trigger || 'directive';
  // P1 (WIRING_AUDIT slice 2): a server-initiated run (telegram/routed/manual-cron) has NO browser-local copy of its
  // lifecycle, so the station floor never lights for it. When a caller opts in via o.broadcast, ALSO mirror the
  // run-lifecycle events to the floor over SSE. Gated on the explicit flag — NOT on trigger — so the hero's
  // directive run never double-counts. Scheduled cron forwards lifecycle via its cron driver emit sink; manual
  // Run Now opts into broadcast because its primary stream is panel-local. WHAT may tee (and in what shape) is
  // the runTeeView policy (channels/sse.js, unit-tested): run.start/cost/end whole; EVERY agent.tool_call as a
  // NAME-ONLY view (agentId/runId/callId/name — args stripped structurally, so G0's per-tool prop pulses fire
  // live for autonomous runs without tool arguments ever leaving the sidecar); agent.token never (that noise
  // decision stands). redact() still runs over the view as a second backstop. Re-using the name `emit` means
  // every existing emit(...) call site below tees automatically, with no per-site change.
  const rawEmit = o.emit;
  const emit = o.broadcast
    ? (name, payload) => {
        try { rawEmit(name, payload); } catch (_) {}
        const view = runTeeView(name, payload);
        if (view) { try { sse.broadcast(name, redact(view)); } catch (_) {} }
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
  // did admission reserve managed credit? Declared OUTSIDE the try so it is in scope in the outer `finally`
  // leak-guard below — a `let` declared INSIDE a try block is NOT visible in that try's finally (referencing it
  // there throws a ReferenceError, which would swallow the return and skip concurrencyGate.leave → a hung run).
  let billed = false;
  // Everything below is wrapped so the admission slot is ALWAYS released (early-return refusals above run
  // before tryEnter; every exit below — return, throw, or the normal finish — passes through leave()).
  try {

  // ---- managed-credit admission (config-gated; INERT unless STARNET_CREDITS_URL is set) ----
  // A metered run (BYOK-shaped, real $ cost) reserves its per-run cap against the managed account BEFORE the
  // model is called; unused headroom refunds at settle. Codex/unmetered runs never touch managed credit. When
  // credits aren't configured, credits.beginRun() is an inert byok pass-through — zero behaviour change.
  // The per-run cap the loop enforces (o.maxCostUsd override, else the Balanced perRun; 0/∞ => ungoverned).
  const runCapUsd = (o.maxCostUsd > 0 && isFinite(o.maxCostUsd)) ? o.maxCostUsd
    : ((effectiveCaps.perRun > 0 && isFinite(effectiveCaps.perRun)) ? effectiveCaps.perRun : Infinity);
  const managedRun = credits.configured() && !providerUnmetered;
  if (managedRun) {
    // a managed reservation needs a FINITE cap to hold; an ungoverned per-run can't be pre-authorized.
    if (!(runCapUsd > 0 && isFinite(runCapUsd))) {
      emit('agent.run.start', { agentId, runId, trigger, model });
      emit('agent.run.error', { agentId, runId, transient: false, message: 'Managed credits need a per-run budget cap — set STARNET_BUDGET_PER_RUN to a dollar amount.' });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 });
      return;   // the outer finally releases the concurrency slot; nothing was reserved (billed stays false)
    }
    await credits.refresh(CREDITS_ACCOUNT).catch(() => {});   // reconcile the cached balance right before admission
    const adm = credits.beginRun({ runId, agentId, capUsd: runCapUsd });
    if (!adm || adm.ok === false) {
      // fail closed — never spend against an unknown/exhausted managed balance. Surface it as a billing fault
      // so the UI (friendlyerror) can point at the STORE, and the error string carries the 'credit' vocabulary.
      const exhausted = adm && adm.reason === 'managed_credits_exhausted';
      const msg = exhausted
        ? 'Out of managed credit — add credits in the STORE to keep running (or connect your own provider key).'
        : 'Managed credits are unavailable right now — the credits service did not answer (try again, or use your own provider key).';
      emit('agent.run.start', { agentId, runId, trigger, model });
      emit('agent.run.error', { agentId, runId, transient: !exhausted, reason: 'billing', message: msg });
      emit('agent.run.end', { agentId, runId, reason: 'error', turns: 0, usd: 0 });
      return;   // the outer finally releases the concurrency slot; nothing was reserved (billed stays false)
    }
    billed = adm.managed === true;
  }

  // ---- tools (registered fresh per run; cheap) ----
  const registry = makeRegistry();
  const loadedSkills = [];
  const managedSkills = [];
  const seenLoadedSkills = new Set();
  const openrouterToolKey = providerId === 'openrouter' ? runKey : runtimeKey;
  makeWebTools({ openrouter: openrouterToolKey ? { apiKey: openrouterToolKey, model } : null }).register(registry);   // web_search/web_fetch (DDG/Jina, OR fallback)
  // STUDIO media tools, built up-front so browser.vision can borrow its multimodal analyze path
  // (one provider seam, no duplication). Registered below; here we only need its vision callback.
  const imageTools = makeImageTools({ openrouter: openrouterToolKey ? { apiKey: openrouterToolKey, model } : null, fsp, pathMod: path, root: WORKSPACES });
  // browser.vision uses the SAME vision model as image_analyze when a key exists; with no key it
  // reports "unavailable" honestly (never a success-shaped stub). Pass the dep only when usable.
  makeBrowserTools({ vision: imageTools.hasVision ? imageTools.browserVision : null }).register(registry);   // browser.* automation: exposed only through the web/dish capability
  makeDesktopTools({}).register(registry);   // desktop.open: open URL/app on the user's REAL screen (visible), web/dish capability
  makeFsTools({ fsp, pathMod: path, root: WORKSPACES, environment: executionEnvironment, limits: { writeBytes: 1 << 20, readReturn: 24000 }, redact }).register(registry);   // redact: scrub secrets out of surfaced fs.search lines (§5.6)
  makeNotebookTools({ store: notebookStore, clock: { now: () => Date.now() }, redact, rank, nextTrust: memcore.nextTrust }).register(registry);   // §5.6: scrub secrets at the write boundary; rank: explicit read shares auto-recall's relevance order; nextTrust: notebook.feedback rating fold
  makeRecallTool({ transcriptStore }).register(registry);   // H1.3: recall_conversation — agent searches its own past dialogue (transcriptstore); joins the NOTEBOOK (memory) capability
  makeSkillTools({
    store: skillStore,
    onView: (skill) => {
      if (!skill || seenLoadedSkills.has(skill.id)) return;
      seenLoadedSkills.add(skill.id);
      loadedSkills.push({ id: skill.id, name: skill.name, summary: skill.summary, state: skill.state });
    },
    onManage: (skill, ctx, action) => {
      if (skill) managedSkills.push({ id: skill.id, name: skill.name, action: action || 'manage' });
    }
  }).register(registry);   // H4: skill.write/list/view/manage — the agent's reusable procedure library (memory capability)
  Todo.makeTodoTool({ store: notebookStore }).register(registry);   // in-session task plan — shares the notebook's per-agent kv store ('todo:'+agentId)
  // STUDIO (media skills): image_generate / image_analyze use an OpenRouter key when one is available.
  // Gated by a 'studio' object (in the default office below) exactly like web/files; outputs save to the workspace.
  imageTools.register(registry);
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
    runOnce, roster: () => agentRoster, key: runKey, model, provider: providerId, baseUrl, reasoningEffort, subagents,
    classes: SPECIALIST_CLASSES,   // Class Loadouts S1: the summon-tool class list, composed from the shared catalog (no hardcoded prose)
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
  // TOOLSET kill-switch: a family the Commander switched OFF in the TOOLSETS console is dropped here, so the
  // next model turn reflects it live (no restart). compute is never in this set; MCP connectors are projected
  // below and keep their own per-connector enabled flag, so they are unaffected.
  const resolved = resolveTools(agentId, station, undefined, { disabledCaps: disabledCapsSet() });
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
    // AWAY WORKSHOP (W1): the Commander's recorded per-agent grant. The broker only consults it for an autonomous
    // cabinet:write / notebook:write (jail-scoped) — exec stays locked, non-jail tools unchanged. A read of the
    // live store each check keeps it honest (a toggle flip takes effect on the very next tool call, no restart).
    workshop: (call, tool) => workshopOf(agentId),
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
    provider = selectProvider({ provider: providerId, fetch: globalThis.fetch, token: codexToken, baseUrl, reasoningEffort });
  } else {
    provider = selectProvider({ provider: providerId, fetch: globalThis.fetch, key: runKey, baseUrl, reasoningEffort });
  }
  const cost = makeCostEngine({ priceOf: provider.priceOf });

  // Provider FALLBACK chain (consumes the loop's failover seam). Cost-correct by construction: each entry reuses
  // THIS provider object (same priceOf catalog) with an alternate model, so a fallback's spend is priced right.
  // Source PRECEDENCE (P0-3, additive): an explicit per-run request list (o.fallbackModels) wins; else the
  // SETTINGS→Models persisted chain (effectiveFallbackChain: saved-or-env); env SKYNET_FALLBACK_MODELS remains the
  // default when nothing is saved. On overload/5xx/404/auth/billing/rate_limit the loop retries the turn on the
  // next model instead of dying (errorClass shouldFallback/shouldRotateCredential). Empty = off.
  const fallbackModels = (Array.isArray(o.fallbackModels) ? o.fallbackModels : effectiveFallbackChain())
    .map(s => String(s || '').trim()).filter(s => s && s !== model);
  // CREDENTIAL ROTATION (P0.2): on a rate-limit/auth/billing failure the loop rotates to an alternate KEY for the
  // SAME model BEFORE trying alternate models. Pool source: o.keyPool (array) or env SKYNET_KEY_POOL (comma list).
  // credPool sinks cooled (recently-failed) keys to the back; each entry is a fresh provider on that key (priceOf
  // is key-independent → cost stays correct) tagged with credKey so the loop's onFallback can cool it on failure.
  // OpenRouter only (Codex authenticates by OAuth token, not an API key). Empty pool = byte-identical to today.
  let rotationFallbacks = [];
  const primaryProfile = getProviderProfile(providerId);
  if (!usingCodex && primaryProfile && primaryProfile.credentialPool) {
    const pool = (Array.isArray(o.keyPool) ? o.keyPool : String(ENV('KEY_POOL') || '').split(','))
      .map(s => String(s || '').trim()).filter(s => s && s !== runKey);
    rotationFallbacks = credPool.order(pool).map(rk => ({
      provider: selectProvider({ provider: providerId, fetch: globalThis.fetch, key: rk, baseUrl, reasoningEffort }),
      model, credKey: rk
    }));
  }
  const providerFallbacks = [];
  const rawProviderFallbacks = Array.isArray(o.fallbackProviders) ? o.fallbackProviders : [];
  for (const fb of rawProviderFallbacks) {
    if (!fb || typeof fb !== 'object') continue;
    const fbProviderId = normalizeProvider(fb.provider || providerId);
    const fbModel = String(fb.model || '').trim();
    if (!fbModel || (fbProviderId === providerId && fbModel === model)) continue;
    const fbBaseUrl = providerRuntimeBaseUrl(fbProviderId, fb.baseUrl || fb.base_url || '');
    const fbKey = providerRuntimeKey(fbProviderId, fb.key || fb.apiKey || fb.api_key || '');
    if (!providerHasCredential(fbProviderId, fbKey, fbBaseUrl)) continue;
    let fbProvider;
    if (providerUsesCodex(fbProviderId)) {
      let fbToken;
      try { fbToken = await ensureCodexAccessToken(); } catch (_) { continue; }
      fbProvider = selectProvider({ provider: fbProviderId, fetch: globalThis.fetch, token: fbToken, baseUrl: fbBaseUrl, reasoningEffort });
    } else {
      fbProvider = selectProvider({ provider: fbProviderId, fetch: globalThis.fetch, key: fbKey, baseUrl: fbBaseUrl, reasoningEffort });
    }
    providerFallbacks.push({ provider: fbProvider, model: fbModel, credKey: fbKey || null, cost: makeCostEngine({ priceOf: fbProvider.priceOf }) });
  }
  const fallbacks = rotationFallbacks
    .concat(fallbackModels.map(m => ({ provider, model: m })))
    .concat(providerFallbacks);

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
  // WORK VISIBILITY (slice 1): fold every successful tool call into this run's artifacts ledger — what the
  // run PRODUCED (files/images/channel sends) — recorded onto the runStore row at run end and served over
  // GET /api/runs. Pure + capped (sidecar/artifacts.js); a collector hiccup must never break a run.
  const artifactLedger = makeArtifactCollector();
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
    // observe BEFORE the tool-output budget clip below, so the collector parses the tool's REAL result text.
    try { artifactLedger.observe({ toolName: c.name, args: c.args, result: r }); } catch (_) { /* never breaks a run */ }
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
    // Class Loadouts S1: the class list here is composed from the SHARED catalog (id + tagline), never hardcoded,
    // so the summon prose can't drift from the Recruitment Bay's actual classes as new ones are added.
    const classListLine = SPECIALIST_CLASSES.map(c => c.id + (c.tagline ? ' — ' + c.tagline : '')).join('; ');
    teamNote += '\n• SUMMON a NEW specialist with team.summon when the Commander wants an agent you don\'t have yet '
      + '(e.g. "create a research agent for me"): pass a class via specId — one of: ' + classListLine + ' — '
      + 'or a custom name + purpose. It returns the new '
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
  let runtimeSkillBlock = '';
  let preloadedSkillBlock = '';
  try {
    const sRoom = station.rooms && station.agents && station.agents[agentId] && station.rooms[station.agents[agentId].room];
    const roomTypes = ((sRoom && sRoom.objects) || []).map(x => x.objectType);
    // Class Loadouts (shared-gear model): skills are RECIPES, and the gear they need is SHARED STATION gear used
    // under the overseer — so a class's SKILL PACKAGE is available when the STATION has the required gear, even for
    // a specialist that owns only its desk (its room objects would be compute-only). o.stationObjects (the browser's
    // station-wide caps) drives availability when present; absent (headless worker / older client) we fall back to
    // the room objects — which for an autonomous worker is already the full default office, so its skills still gate
    // correctly. This does NOT widen tool reach (resolveTools stays room-scoped) — only which recipes are offered.
    const skillPlacedTypes = (Array.isArray(o.stationObjects) && o.stationObjects.length)
      ? Array.from(new Set(roomTypes.concat(o.stationObjects)))   // union: the agent's own room + the shared station gear
      : roomTypes;
    // Class Loadouts S1: union the running agent's per-agent class SKILL PACKAGE (roster record) with the global
    // prefs — ADD-only (see catalog.compose). Still gated by the station gear + the budget; package composes first.
    const agentSkills = (rosterIdent && Array.isArray(rosterIdent.skills)) ? rosterIdent.skills : [];
    skillBlock = skillsCatalog.compose(SKILL_LIBRARY, { overrides: skillPrefs.overrides(), placedTypes: skillPlacedTypes, agentSkills: agentSkills });
  } catch (_) { /* a skill-injection hiccup must never break a run */ }
  // STARNET OPERATOR MANUAL: how the station works, so the agent can guide a stuck Commander. Interactive
  // only (same gate as capsummary — a Commander is present to help and the build UI exists). Sits right
  // BEFORE the authoritative <capabilities_ground_truth>, which it defers to, so the two never disagree.
  const manualBlock = (surface === 'interactive') ? starnetManual() : '';
  const runtimeBlock = runtimeIdentityBlock({ provider: providerId, model, agentId, runId, surface, trigger, fallbackModels });
  // RUNTIME SKILL LIBRARY (skill-builder-gap): index the agent's own authored skills + preload any it invokes,
  // riding the same skill.view/skill.manage capability gate. Never breaks a run.
  try {
    if (resolved.tools.indexOf('skill.view') >= 0) {
      const rs = runtimeSkills.composeIndex(skillStore.list(agentId), {
        budget: 6000,
        platform: process.platform,
        canManage: resolved.tools.indexOf('skill.manage') >= 0
      });
      runtimeSkillBlock = rs.text || '';
      if (rs.ids && rs.ids.length && typeof skillStore.markUsed === 'function') skillStore.markUsed(agentId, rs.ids);
    }
  } catch (_) { /* runtime skill indexing must never break a run */ }
  try {
    if (resolved.tools.indexOf('skill.view') >= 0) {
      const names = (Array.isArray(preloadSkills) ? preloadSkills : []).concat(runtimeSkills.extractInvocations(messages));
      const seenNames = new Set();
      const loaded = [];
      for (const name of names) {
        const key = String(name || '').toLowerCase();
        if (!key || seenNames.has(key)) continue;
        seenNames.add(key);
        const v = skillStore.view(agentId, name);
        if (!v) continue;
        loaded.push(v);
        if (!seenLoadedSkills.has(v.id)) {
          seenLoadedSkills.add(v.id);
          loadedSkills.push({ id: v.id, name: v.name, summary: v.summary, state: v.state });
        }
      }
      preloadedSkillBlock = runtimeSkills.composeLoaded(loaded);
    }
  } catch (_) { /* explicit skill preload must never break a run */ }
  const sys = (system || '') + runtimeBlock + toolNote + teamNote + manualBlock + summarizeCapabilities(resolved, { surface }) + skillBlock + runtimeSkillBlock + preloadedSkillBlock;   // ground-truth caps: name the object to place instead of promising work it has no tool for
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
      limits: { maxIters: CAPS.maxIters, maxCostUsd: runCapUsd },   // runCapUsd computed once at admission (also the managed reservation)
      budget: runBudget, context: ctxMgr, summarize, fallbacks,
      // P0.2 credential rotation: the live key + a hook the loop calls as it rotates away from a failed one,
      // so a rate-limit/auth/billing key gets a cooldown (credPool) and isn't tried first next run.
      credKey: providerUnmetered ? null : runKey,
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
      steer: () => drainSteer(runId),   // LIVE STEERING: fold any mid-run /steer notes into the next model call
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
    const finalUsd = effectiveUsd({ usd: (result && result.usd) || 0, unmetered: providerUnmetered, unpricedUsage: result && result.unpricedUsage, priceOf: provider && provider.priceOf });
    const finalTurns = (result && result.turns) || 0;
    const finalTokens = (result && result.tokens) || 0;
    try { ledger.record({ runId, agentId, turns: finalTurns, usd: finalUsd, tokens: finalTokens, model: finalModel, unmetered: providerUnmetered }); } catch (_) {}
    // managed-credit SETTLE: reconcile the reservation to the real spend — refund the unused headroom to the
    // account (billing.js caps finalUsd at the reservation). Inert/no-op unless this run actually reserved credit.
    if (billed) { try { credits.finishRun({ runId, agentId, usd: finalUsd, tokens: finalTokens, turns: finalTurns, reason: (result && result.reason) || 'done' }); } catch (_) {} }
    // record the run OUTCOME (durable history) — reason + a short title from the triggering user message. Fail-open.
    try {
      let title = '';
      for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i] && msgs[i].role === 'user' && typeof msgs[i].content === 'string') { title = msgs[i].content; break; } }
      runStore.record({ runId, agentId, reason: (result && result.reason) || 'done', turns: finalTurns, tokens: finalTokens, usd: finalUsd, title: title, streamId: o.streamId || '', model: finalModel, unmetered: providerUnmetered, artifacts: artifactLedger.list() });   // H3.2/H3.3/G6 + work-visibility: transcript join + honest model/spend/deliverables
      // P0.1/H1.1: persist the full DIALOGUE (not just the outcome) — a durable server-side transcript for EVERY
      // run, incl. headless ones (cron/Telegram/delegated). Append the triggering user directive, then EVERY new
      // turn the loop produced (assistant incl. tool_calls + tool results), so a resume can rebuild exact state.
      if (title) transcriptStore.append({ streamId: o.streamId, agentId, role: 'user', content: title });
      if (result && Array.isArray(result.messages)) transcriptStore.appendTurns(o.streamId, agentId, result.messages, _txStart);
    } catch (_) {}
    budget.clearLive(runId);
  }

  // Cortex M-mem.5b: post-run reflection — fire on SALIENCE, not after every run (the "beat too often" fix). Only a
  // real TASK run (isTask — never conversational chatter) that COMPLETED, with a substantive exchange, and OUTSIDE
  // the per-agent cooldown, earns a Keep/Edit/Discard beat. Fire-and-forget so the reply has no added latency;
  // reflect() then applies a value floor + dedups vs the notebook AND the permanent declined list, so a one-off or
  // low-value run yields nothing and raises no beat (§5.6). REFLECT_MODEL optionally points reflection at a cheaper
  // aux model; it defaults to the run's own model (no behaviour change unless configured).
  const reflectModel = String(ENV('REFLECT_MODEL') || '').trim();
  if (o.reflect && memoryConfig.reflectEnabled && isTask && result && result.reason === 'done' && !signal.aborted && reflectSalient(result.messages, o.recurring)
      && !reflectingNow.has(agentId) && (Date.now() - (lastReflectAt.get(agentId) || 0) >= memoryConfig.reflectCooldownMs)) {
    // NB: the cooldown is ARMED inside runReflection only when proposals actually survive (a beat fires), not here —
    // so a run that yields nothing never blocks the next substantive run's turn-in. reflectingNow closes the window
    // BETWEEN this gate and that arming: two same-agent runs finishing inside one reflection's round-trip would both
    // read the un-armed timestamp and both fire — the in-flight guard makes the second cede instead.
    reflectingNow.add(agentId);
    runReflection({ agentId, runId, messages: result.messages.slice(), provider, model: reflectModel || resolveEffectiveModel({ result, requestedModel: o.model, usingCodex, codexDefaultModel: CODEX_DEFAULT_MODEL, defaultModel: CRON_DEFAULT_MODEL }), cost, unmetered: providerUnmetered }).catch(() => {}).finally(() => { reflectingNow.delete(agentId); });
  }
  // GROWTH Tier 1: the STUDY pass (dossier Phase B) rides the SAME salience gate as reflection but on its OWN,
  // longer cooldown (studyCooldownMs) — so the station proposes belief updates RARELY, never every few minutes.
  // Same fire-and-forget / in-flight-guard discipline as reflection. Fail-open: if Study didn't load, this no-ops.
  if (Study && o.reflect && memoryConfig.studyEnabled && isTask && result && result.reason === 'done' && !signal.aborted && Study.studySalient(result.messages, o.recurring)
      && !studyingNow.has(agentId) && (Date.now() - (lastStudyAt.get(agentId) || 0) >= memoryConfig.studyCooldownMs)) {
    studyingNow.add(agentId);
    let studyDirective = '';
    for (let i = result.messages.length - 1; i >= 0; i--) { const m = result.messages[i]; if (m && m.role === 'user' && typeof m.content === 'string') { studyDirective = m.content; break; } }
    runStudy({ agentId, runId, messages: result.messages.slice(), directive: studyDirective, provider, model: reflectModel || resolveEffectiveModel({ result, requestedModel: o.model, usingCodex, codexDefaultModel: CODEX_DEFAULT_MODEL, defaultModel: CRON_DEFAULT_MODEL }), cost, unmetered: providerUnmetered }).catch(() => {}).finally(() => { studyingNow.delete(agentId); });
  }
  if (process.env.SKYNET_SKILL_REVIEW !== '0' && result && result.reason === 'done' && !signal.aborted && skillReview.shouldReviewRun(result)) {
    runBackgroundSkillReview({ agentId, runId, messages: result.messages.slice(), provider, model, cost, loadedSkills, managedSkills }).catch(() => {});
  }
  if (process.env.SKYNET_SKILL_CURATOR !== '0' && result && result.reason === 'done' && !signal.aborted) {
    runSkillCurator({ agentId, runId, provider, model, cost }).catch(() => {});
  }
  return result;

  } finally {
    // safety net: if managed credit was reserved but a throw before the inner finally left it unsettled, settle it
    // now (full refund on usd=0). billing.js's finishRun is idempotent, so a normal settle above makes this a no-op.
    if (billed) { try { credits.finishRun({ runId, agentId, usd: 0, reason: 'leak-guard' }); } catch (_) {} }
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

// GET /api/permissions — the Permissions Panel's read: every standing grant the agent can use without asking
// (honest — includes any non-curated class blessed via a past prompt) + the curated catalog the panel may add.
// Privileged: behind the same x-starnet-token + loopback gate as every other /api route (apiauth, not TOKEN_EXEMPT).
function handlePermissionsList(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(grantManager.snapshot()));
}
// POST /api/permissions/grant { key } — proactively PRE-BLESS a curated, LOCAL-only capability (cabinet:write)
// so an autonomous run can use it with no mid-run prompt. Refuses any non-curated/exec/network class; fail-closed
// (returns 400 ok:false) if the durable write throws, so the grant never silently "takes" without persisting.
async function handlePermissionsGrant(req, res) {
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { res.writeHead(400); return res.end('bad json'); }
  const r = grantManager.grant(body && body.key);
  res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(r));
}
// POST /api/permissions/revoke { key } — withdraw ANY standing grant (consent is always revocable, even a
// non-curated class). Fail-closed: a torn persist keeps the grant rather than reporting a phantom revoke.
async function handlePermissionsRevoke(req, res) {
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { res.writeHead(400); return res.end('bad json'); }
  const r = grantManager.revoke(body && body.key);
  res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(r));
}

// POST /api/autonomy/write { agentId?, path, content } — autonomy Stage B / B2. Deterministically write a PRE-VETTED
// autopilot deliverable into the agent's workspace, gated by the REAL consent broker on the AUTONOMOUS surface:
// cabinet:write grant clears the cache tier → allow; the hardline floor still blocks .env/.git; an ungranted write
// default-denies ("silence is not consent"). The workspace is CHECKPOINTED first, so the write is one rollback away.
// It reuses the SAME registry + fs tools + broker + checkpoint pieces runOnce assembles — the security comes from
// REUSE, never a hand-rolled allow. Privileged (token-gated like every /api route; not TOKEN_EXEMPT). NOTE: the
// cabinet-OBJECT-placed requirement (the B1 honesty story) is the autopilot's client-side gate (Autopilot.canWrite);
// the server's authoritative boundary here is the cabinet:write GRANT + the fs-jail + the hardline floor.
async function handleAutonomyWrite(req, res) {
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 20)) || {}; } catch (e) { res.writeHead(400); return res.end('bad json'); }
  const agentId = String(body.agentId || 'agent');
  const rel = body.path, content = body.content;
  if (typeof rel !== 'string' || !rel || typeof content !== 'string') return sendJson(400, { ok: false, reason: 'missing path or content' });
  // a one-off registry carrying the cabinet (fs) tools — assembled exactly like runOnce (same makeFsTools args).
  const reg = makeRegistry();
  makeFsTools({ fsp, pathMod: path, root: WORKSPACES, environment: executionEnvironment, limits: { writeBytes: 1 << 20 }, redact }).register(reg);
  // the REAL broker on the autonomous surface — NOT a hardcoded allow. hardline: hardlineFloor keeps .env/.git
  // unwritable; granted cabinet:write clears the cache tier; otherwise the autonomous mutation default-denies.
  const sessionKey = 'autowrite-' + Date.now();
  const consent = makeConsentBroker({ bypass: FULL_ACCESS, hardline: hardlineFloor, sessionKey: sessionKey, grantsSession, grantsPermanent, persist: persistAllowlist, grantsBlanket: blanketSetFor(agentId), surface: 'autonomous' });
  // CHECKPOINT NET: snapshot BEFORE the write (mirrors the runOnce dispatch wrapper) so it's one rollback away.
  // Keep the snapshot id EVEN when created:false — an unchanged workspace returns the existing HEAD, which is a
  // valid, restorable PRE-write rollback point (the common case for a fresh drafts/* write). Discarding it on
  // created:false would leave B3 with no undo target exactly when nothing else had changed.
  let snapshot = null;
  try { const snap = await checkpointStore.snapshot(agentId, { runId: sessionKey, turn: 0, label: 'fs.write' }); if (snap && snap.id) snapshot = snap.id; } catch (_) { /* a checkpoint hiccup must never block the write */ }
  const call = { name: 'fs.write', args: { path: rel, content: content }, id: sessionKey };
  const r = await reg.dispatch(call, { agentId: agentId, consent: consent, emit: function () {}, timeoutMs: 10000 });
  if (r && r.ok) return sendJson(200, { ok: true, path: rel, snapshot: snapshot, summary: r.summary });
  return sendJson((r && r.summary === 'denied') ? 403 : 400, { ok: false, path: rel, reason: (r && (r.content || r.summary)) || 'write failed' });
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

// POST /api/run/steer { runId, text } — LIVE MID-RUN STEERING. Append a Commander note to an IN-FLIGHT run's steer
// buffer; the loop's injected steer() drains it before the NEXT model call and folds it in as a <steering_note>.
// Only a run whose id is still in `runs` (i.e. actually in flight) accepts a steer — a stale/unknown runId is a
// clean 404, so a note can never queue against a finished run. Bounded to STEER_MAX_PENDING pending notes per run.
async function handleRunSteer(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const runId = String(body.runId || '');
  const text = String(body.text == null ? '' : body.text).trim();
  if (!text) return json(400, { error: 'empty steering note' });
  if (!runId || !runs.has(runId)) return json(404, { error: 'no in-flight run for that id' });
  const buf = steerBuffers.get(runId) || [];
  if (buf.length >= STEER_MAX_PENDING) return json(429, { error: 'steer buffer full', pending: buf.length });
  buf.push(text.slice(0, 2000));   // clamp a single note so one steer can't blow up the prompt
  steerBuffers.set(runId, buf);
  json(200, { ok: true, pending: buf.length });
}

// GET /api/version — the honest build/version surface for /version. Reads the repo package.json (harness version)
// and, when present, the Tauri desktop app version; both are best-effort so a missing file never 500s.
let _versionCache = null;
function handleVersion(req, res) {
  if (!_versionCache) {
    const out = { harness: '', app: '', node: process.version };
    try { out.harness = String(require('../package.json').version || ''); } catch (_) {}
    try {
      const t = require('../src-tauri/tauri.conf.json');
      out.app = String((t && (t.version || (t.package && t.package.version))) || '');
    } catch (_) {}
    _versionCache = out;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(_versionCache));
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
  const key = providerRuntimeKey(provider, String(body.key || '').trim() || String(saved.key || ''));
  const baseUrl = providerRuntimeBaseUrl(provider, body.baseUrl || body.base_url || saved.baseUrl || saved.base_url || '');
  const model = String(body.model || '').trim() || String(saved.model || '');
  const reasoningEffort = resolveReasoningEffort(provider, body.reasoningEffort || body.reasoning_effort || saved.reasoningEffort);
  // the app's REAL agent identity, so Telegram runs as the same agent (shared memory) with the same voice.
  const agentId = String(body.agentId || '').trim() || String(saved.agentId || '');
  const system = (typeof body.system === 'string' && body.system) ? body.system : String(saved.system || '');
  const name = String(body.agentName || '').trim() || String(saved.name || '');
  if (!token) return json(400, { error: 'missing bot token — create one with @BotFather and paste it here' });
  if (!model) return json(400, { error: 'connect your agent first (choose a model on the title screen)' });
  if (!providerHasCredential(provider, key, baseUrl)) return json(400, { error: providerCredentialError(provider) });
  try { startTelegram(token, providerUsesCodex(provider) ? '' : key, model, { agentId, system, name, provider, reasoningEffort, baseUrl }); } catch (e) { return json(500, { error: (e && e.message) || 'failed to start' }); }
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
  res.end(JSON.stringify({ connected: telegramStatus.connected, configured: !!t.token, state: telegramStatus.state, detail: telegramStatus.detail || '', notifyAutonomous: !!(channelSecrets && channelSecrets.notifyAutonomous) }));
}

// POST /api/channels/discord/connect { token, key?, model, provider? } — the Messaging tab's Discord card hands over
// the bot token (Discord Developer Portal) plus the app's current provider config, exactly like the Telegram connect.
// The sidecar persists the channel config (protected sibling file) and starts the adapter through the generic
// registry/wireChannel path. Secrets are NEVER echoed back. Mirrors handleChannelConnect (Telegram).
async function handleDiscordConnect(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const saved = (channelSecrets && channelSecrets.discord) || {};
  const provider = normalizeProvider(body.provider || saved.provider);
  const token = String(body.token || '').trim() || String(saved.token || '');
  const key = providerRuntimeKey(provider, String(body.key || '').trim() || String(saved.key || ''));
  const baseUrl = providerRuntimeBaseUrl(provider, body.baseUrl || body.base_url || saved.baseUrl || saved.base_url || '');
  const model = String(body.model || '').trim() || String(saved.model || '');
  const reasoningEffort = resolveReasoningEffort(provider, body.reasoningEffort || body.reasoning_effort || saved.reasoningEffort);
  const agentId = String(body.agentId || '').trim() || String(saved.agentId || '');
  const system = (typeof body.system === 'string' && body.system) ? body.system : String(saved.system || '');
  const name = String(body.agentName || '').trim() || String(saved.name || '');
  if (!token) return json(400, { error: 'missing bot token — create a bot in the Discord Developer Portal and paste its token here' });
  if (!model) return json(400, { error: 'connect your agent first (choose a model on the title screen)' });
  if (!providerHasCredential(provider, key, baseUrl)) return json(400, { error: providerCredentialError(provider) });
  try { startDiscord(token, providerUsesCodex(provider) ? '' : key, model, { agentId, system, name, provider, reasoningEffort, baseUrl }); } catch (e) { return json(500, { error: (e && e.message) || 'failed to start' }); }
  json(200, { connected: true, state: discordStatus.state });
}

// POST /api/channels/discord/sync — refresh the agent identity the Discord bot runs as (mirrors handleChannelSync).
async function handleDiscordSync(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const d = (channelSecrets && channelSecrets.discord) || null;
  if (!d || !d.token) return json(200, { synced: false });
  const patch = {};
  if (typeof body.agentId === 'string' && body.agentId.trim()) patch.agentId = body.agentId.trim();
  if (typeof body.system === 'string') patch.system = body.system;
  if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
  if (typeof body.provider === 'string' && body.provider.trim()) patch.provider = normalizeProvider(body.provider.trim());
  if (body.reasoningEffort || body.reasoning_effort) patch.reasoningEffort = normalizeReasoningEffort(body.reasoningEffort || body.reasoning_effort);
  if (typeof body.key === 'string' && body.key.trim()) patch.key = body.key.trim();
  if (typeof body.agentName === 'string') patch.name = body.agentName;
  channelSecrets = Object.assign({}, channelSecrets, { discord: Object.assign({}, d, patch) });
  saveChannelSecrets(channelSecrets);
  json(200, { synced: true });
}

// POST /api/channels/discord/disconnect — stop the bot and mark it disabled (kept in config so the token can be
// re-enabled without re-entry). Mirrors handleChannelDisconnect (Telegram).
async function handleDiscordDisconnect(req, res) {
  stopDiscord();
  if (channelSecrets && channelSecrets.discord) {
    channelSecrets = Object.assign({}, channelSecrets, { discord: Object.assign({}, channelSecrets.discord, { enabled: false }) });
    saveChannelSecrets(channelSecrets);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ connected: false }));
}

// GET /api/channels/discord/status — booleans + gateway state ONLY; never the token/key. Mirrors handleChannelStatus.
function handleDiscordStatus(req, res) {
  const d = (channelSecrets && channelSecrets.discord) || {};
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  // `ownerLocked` proves a saved Discord owner survived restart without disclosing who that owner is.
  res.end(JSON.stringify({ connected: discordStatus.connected, configured: !!d.token, state: discordStatus.state, detail: discordStatus.detail || '', notifyAutonomous: !!(channelSecrets && channelSecrets.notifyAutonomous), ownerLocked: !!d.ownerId }));
}

// POST /api/channels/notify { on } — the GLOBAL opt-in (default off): ping a connected channel when an AUTONOMOUS
// (cron) run produces work. Persisted in channelSecrets so the server-side cron path reads it at fire time. Token-
// gated like every /api route; no chatId needed (the notifier fans out to the agent's connected chats).
async function handleChannelNotify(req, res) {
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { res.writeHead(400); return res.end('bad json'); }
  const on = !!body.on;
  channelSecrets = Object.assign({}, channelSecrets, { notifyAutonomous: on });
  try { saveChannelSecrets(channelSecrets); } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'persist failed' })); }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: true, notifyAutonomous: on }));
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
function publicModel(m) {
  return {
    id: m.id,
    name: m.name || m.id,
    context_length: m.context_length || 0,
    max_completion_tokens: m.max_completion_tokens || null,
    pricing: m.pricing || null,
    supportsTools: m.supportsTools !== false,
    supportsReasoning: !!m.supportsReasoning,
    supported_parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
    reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts : []
  };
}

function handleProviders(req, res) {
  const providers = listProviderProfiles().map(p => {
    const key = providerRuntimeKey(p.id, '');
    const baseUrl = providerRuntimeBaseUrl(p.id, '');
    return Object.assign({}, p, { configured: providerHasCredential(p.id, key, baseUrl), currentBaseUrl: baseUrl || '' });
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ providers }));
}

async function listModelsForProvider(providerId, opts) {
  opts = opts || {};
  const id = normalizeProvider(providerId);
  const profile = getProviderProfile(id);
  const baseUrl = providerRuntimeBaseUrl(id, opts.baseUrl || '');
  const key = providerRuntimeKey(id, opts.key || '');
  const needsKey = providerRequiresKey(id) && (!profile || profile.modelsRequireAuth !== false);
  if ((providerRequiresBaseUrl(id) && !String(baseUrl || '').trim()) || (needsKey && !String(key || '').trim())) {
    const err = new Error(providerCredentialError(id));
    err.code = 'provider_not_configured';
    throw err;
  }
  let provider;
  if (providerUsesCodex(id)) {
    const token = await ensureCodexAccessToken();
    provider = selectProvider({ provider: id, fetch: globalThis.fetch, token, baseUrl });
  } else {
    provider = selectProvider({ provider: id, fetch: globalThis.fetch, key, baseUrl });
  }
  return await provider.listModels();
}

async function handleProviderModels(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let providerId = '';
  let baseUrl = '';
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    providerId = decodeURIComponent(u.pathname.slice('/api/models/'.length));
    baseUrl = u.searchParams.get('baseUrl') || u.searchParams.get('base_url') || '';
  } catch (_) {}
  const id = normalizeProvider(providerId);
  if (!getProviderProfile(id)) return json(404, { models: [], error: 'unknown provider' });
  try {
    const models = await listModelsForProvider(id, { baseUrl });
    json(200, { provider: id, models: models.map(publicModel) });
  } catch (e) {
    json(200, { provider: id, models: [], error: (e && e.message) || 'model catalog unavailable', code: (e && e.code) || '' });
  }
}

async function handleOpenRouterModels(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const provider = makeOpenRouterProvider({ fetch: globalThis.fetch, baseUrl: providerRuntimeBaseUrl('openrouter', '') || OPENROUTER_BASE });
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
    // Rich objects now (id + display/reasoning metadata) so the model dock can render per-model chips.
    // The bare `id` is still present on every entry, so older consumers that read m.id keep working.
    const rich = models.map(m => ({
      id: m.id,
      displayName: m.displayName || m.name || m.id,
      description: m.description || '',
      context_length: m.context_length || 0,
      max_completion_tokens: m.max_completion_tokens || null,
      reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts : [],
      defaultReasoningLevel: m.defaultReasoningLevel || 'medium',
      reasoningLevelDescriptions: m.reasoningLevelDescriptions || null
    }));
    json(200, { models: rich, default: (rich[0] && rich[0].id) || null });
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
  // per-persona delivery style (personas.js:ttsStyle) — Gemini TTS is steered by a natural-language
  // instruction PREPENDED to the input ("Say the following in <style>: <text>"). Optional; capped so a
  // malformed client can't blow the input past the model's limit. Empty style → plain synthesis (unchanged).
  const style = String((body && body.style) || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!text) return fallback('no text');
  if (!key) return fallback('no key');

  // fold the style into the spoken input the way Gemini TTS documents (a leading directive it obeys but
  // does not read aloud). Kept separate from `text` so the cache key can include the style (below).
  const input = style ? ('Say the following in ' + style + ': ' + text) : text;

  // cache the synthesized (speed-independent) audio by model+voice+STYLE+text; per-personality pacing is
  // applied client-side via Audio.playbackRate, so it stays out of the key for better cache hits. Style
  // MUST be in the key — same words in a different delivery are a different clip.
  const ck = crypto.createHash('sha1').update(model + '|' + voice + '|' + style + '|' + text).digest('hex');
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
  const payload = { model, input, voice, response_format: 'pcm' };
  let or;
  try {
    or = await fetch('https://openrouter.ai/api/v1/audio/speech', voiceFetchOpts({
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://localhost', 'X-Title': 'STARNET' },
      body: JSON.stringify(payload)
    }));
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

// read a raw binary request body into a single Buffer (readBody concatenates as a string, which mangles
// non-UTF8 audio bytes). Capped like readBody so a hostile client can't OOM the host.
function readBodyBuffer(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* POST /api/stt — speech-to-text for the DESKTOP voice path (WebView2 has no SpeechRecognition, so the
   frontend records mic audio and posts it here). Accepts the audio two ways, whichever the client finds
   simplest:
     • raw bytes    — Content-Type: audio/webm | audio/wav | …  (the recorder-provider default; smallest)
     • JSON base64  — { audio: <base64>, format: 'webm'|'wav', key }
   Transcribes via an audio-input chat model on OpenRouter (STT_MODELS, tried in order). Returns {text}.
   On ANY failure returns 200 {text:'', reason} so the frontend degrades gracefully (never a hard error that
   would wedge the hands-free loop) — the caller surfaces `reason` in a console.warn + status line. */
const STT_MAX_BYTES = 10 * 1024 * 1024;   // ~10MB — a ~30s opus clip is well under this; a JSON base64 body is ~1.33x
const STT_PROMPT = 'Transcribe this audio verbatim. Output ONLY the transcribed words, nothing else. If there is no speech, output nothing.';
async function handleStt(req, res) {
  const ok = (text) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ text: String(text || '') })); };
  const degrade = (reason) => { console.warn('[stt] →', reason); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ text: '', reason })); };

  const u = new URL(req.url, 'http://127.0.0.1');
  const ctReq = String(req.headers['content-type'] || '').toLowerCase();
  let audioB64 = '', format = '', key = '';
  try {
    if (ctReq.indexOf('application/json') === 0) {
      const body = JSON.parse((await readBodyBuffer(req, Math.ceil(STT_MAX_BYTES * 1.4)).catch(() => Buffer.alloc(0))).toString('utf8') || '{}');
      audioB64 = String((body && body.audio) || '').replace(/^data:[^,]*,/, '');   // tolerate a data: URL prefix
      format = String((body && body.format) || '').trim();
      key = String((body && body.key) || '').trim();
    } else {
      const buf = await readBodyBuffer(req, STT_MAX_BYTES);
      audioB64 = buf.toString('base64');
      // derive format from the content-type: audio/webm → webm, audio/wav|x-wav → wav, audio/ogg → ogg
      const m = ctReq.match(/audio\/(?:x-)?([a-z0-9]+)/);
      format = m ? m[1] : '';
      // key travels out-of-band for the raw path: query ?key= or an X-OpenRouter-Key header
      key = String(u.searchParams.get('key') || req.headers['x-openrouter-key'] || '').trim();
    }
  } catch (e) { return degrade('body: ' + ((e && e.message) || e)); }

  key = key || runtimeKey;   // desktop: key lives in the keychain-seeded env, not the request
  if (!key) return degrade('no key');
  if (!audioB64) return degrade('no audio');
  // OpenRouter's input_audio format field wants a codec name; normalize the common WebView2/browser containers.
  // 'webm' (opus) and 'wav' are the two we produce; ogg/opus map to their documented names.
  format = (format === 'x-wav' || format === 'wave') ? 'wav' : (format || 'webm');

  const payload = (model) => ({
    model,
    messages: [{ role: 'user', content: [
      { type: 'input_audio', input_audio: { data: audioB64, format } },
      { type: 'text', text: STT_PROMPT }
    ] }]
  });

  let lastReason = 'no model';
  for (const model of STT_MODELS) {
    let r;
    try {
      r = await fetch('https://openrouter.ai/api/v1/chat/completions', voiceFetchOpts({
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://localhost', 'X-Title': 'STARNET' },
        body: JSON.stringify(payload(model))
      }));
    } catch (e) { lastReason = 'network: ' + ((e && e.message) || e); continue; }
    if (!r.ok) {
      let detail = ''; try { detail = (await r.text()).slice(0, 200); } catch (_) {}
      lastReason = model + ' → openrouter ' + r.status + (detail ? ' — ' + detail : '');
      // a 4xx that names the model/modality is "this model can't do audio" — try the next candidate. Other
      // errors (auth, rate) will repeat on every model, but the loop is short so it's cheap either way.
      continue;
    }
    let j; try { j = await r.json(); } catch (e) { lastReason = 'bad json from ' + model; continue; }
    const text = String(((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '')).trim();
    return ok(text);   // empty string is a valid "no speech heard" result — deliver it, don't fall through
  }
  return degrade(lastReason);
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
// GET /api/runs?agent=<id>&limit=<n>&since=<ms>[&runId=<id>] — the agent's run history (M-save P4), newest-first.
// Rows carry the run's `artifacts` ledger (work-visibility); an explicit runId narrows to that single run's
// entry (the end-of-run recap's fetch). Read-only; the store is append-only and a sibling of the fs jail, so the
// agent can neither read nor rewrite its own history. G2.2 (additive): agent=* returns EVERY agent's runs (the
// while-away digest covers crew routines too), and a since=<ms> filter keeps the answer to runs that finished
// after the caller's last-attended stamp.
function serveRuns(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    if (agent !== '*' && !/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(403, { error: 'forbidden' });
    const runId = u.searchParams.get('runId') || '';
    if (runId) return json(200, { runs: runStore.list(agent, { limit: 1000 }).filter(r => r.runId === runId) });
    const limit = Math.max(1, Math.min(500, Number(u.searchParams.get('limit')) || 100));
    const since = Math.max(0, Number(u.searchParams.get('since')) || 0);
    let rows = runStore.list(agent === '*' ? null : agent, { limit });
    if (since > 0) rows = rows.filter(r => (r.ts || 0) > since);
    json(200, { runs: rows });
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

// GET /api/study/proposals?agent=<id>&run=<id> — GROWTH Tier 1: the pending dossier belief-update proposals a
// STUDY pass raised for a run (with text). Read-only; falls back to the agent's newest pending study batch when
// the runId is unknown. The DOSSIER write itself happens client-side (the dossier lives in the browser); the
// browser then CONSUMES the decided proposal via POST /api/study/resolve below.
function serveStudyProposals(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(403, { error: 'forbidden' });
    const runId = u.searchParams.get('run') || '';
    let batch = runId && studyByRun.get(runId);
    if (!batch) { const lr = latestStudyRun.get(agent); batch = lr && studyByRun.get(lr); }
    if (!batch || batch.agentId !== agent) return json(200, { runId: runId || null, agentId: agent, proposals: [] });
    json(200, { runId: batch.runId, agentId: agent, proposals: batch.proposals });
  } catch (e) { json(200, { proposals: [] }); }
}

// POST /api/study/resolve { agentId, runId, id, declined:[] } — GROWTH Tier 1: CONSUME one decided study proposal
// (mirrors the memory turn-in dropping its batch entry at handleMemoryTurnin): remove it from the pending stash so
// the latestStudyRun fallback can never re-serve it, delete the batch when it empties, and mirror the browser's
// PERMANENT studyDeclined denylist so the next runStudy() dedups at the source. The dossier write already happened
// client-side — this endpoint only reconciles server state, so a stale/unknown id is a harmless ok:true no-op.
async function handleStudyResolve(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const agentId = String(body.agentId || 'agent');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(403, { error: 'forbidden' });
  const runId = String(body.runId || '');
  const id = String(body.id || '');
  // mirror the browser's studyDeclined denylist (capped, strings only) — runStudy() feeds it into the engine dedup.
  if (Array.isArray(body.declined)) {
    const list = body.declined.filter(x => typeof x === 'string' && x.trim()).slice(-STUDY_DECLINED_CAP);
    studyDeclinedByAgent.set(agentId, list);
  }
  const batch = runId && studyByRun.get(runId);
  if (batch && batch.agentId === agentId && id) {
    batch.proposals = batch.proposals.filter(p => p && p.id !== id);
    if (!batch.proposals.length) { studyByRun.delete(runId); if (latestStudyRun.get(agentId) === runId) latestStudyRun.delete(agentId); }
  }
  json(200, { ok: true });
}

// POST /api/memory/turnin { agentId, runId, id, verdict:'keep'|'edit'|'discard', content? } — resolve ONE proposal.
// Keep/Edit COMMIT a real §5.2 record (the user's click IS the consent §5.6) -> memory.write; EVERY verdict ->
// memory.feedback (Keep/Edit positive, Discard negative) so the agent's confidence tracks proposal acceptance.
// Events ride the SSE bus (the run stream is closed) so they reach the browser U.bus exactly once — no double-count.
function skillNameFromReflection(content) {
  const raw = String(content || '').trim().split(/\r?\n/)[0].replace(/^(learned|skill|procedure)\s*[:\-]\s*/i, '');
  const first = raw.split(/[.;:]/)[0].trim() || 'Learned skill';
  return first.replace(/[<>:"|?*\\/]/g, ' ').replace(/\s+/g, ' ').slice(0, 70) || 'Learned skill';
}

// THE ONE MEMORY WRITE PATH (silent-save UX). A proposal reaches the notebook (or the skill library) via EXACTLY
// this helper — whether the Commander clicked Keep/Edit on the confirm deck OR reflection auto-saved it silently.
// It writes under the per-agent lock (re-reading so a concurrent memory.write isn't clobbered), mints the id, seeds
// trust from `trustDelta` (the keep/edit bonus for a user-confirmed record; 0 for a silent auto-save — there was no
// user validation to reward), and emits the frozen memory.write / deliverable SSE rungs. It does NOT emit
// memory.feedback — the caller owns that (the semantics differ: keep=+2, edit=+1, silent auto-save=none). Returns
// { ok, id, kind, skill? } or { ok:false, error }. `opts.source` labels a skill's provenance ('reflection').
async function writeMemoryRecord(agentId, prop, opts) {
  opts = opts || {};
  const content = String(opts.content != null ? opts.content : (prop && prop.content) || '').trim();
  if (!content) return { ok: false, error: 'a kept memory cannot be empty' };
  const runId = opts.runId || (prop && prop.sourceRunId) || '';
  const trustDelta = Number(opts.trustDelta) || 0;
  // skill-builder-gap: a proposal tagged kind:'skill' becomes a saved skill package, not a notebook note.
  if (prop && prop.kind === 'skill') {
    const skillName = String(opts.skillName || skillNameFromReflection(content)).trim();
    const skillBody = String(opts.skillBody || content).trim();
    const summary = String(opts.summary || content).trim();
    const r = skillStore.write({ agentId, name: skillName, summary, body: skillBody, createdBy: opts.source || 'reflection', sourceRunId: runId || (prop && prop.sourceRunId) });
    if (!r.ok) return { ok: false, error: r.error || 'could not save skill' };
    chanEmit('deliverable', { id: r.skill.id, agentId, kind: 'skill', title: r.skill.name });
    return { ok: true, id: r.skill.id, kind: 'skill', skill: r.skill };
  }
  // P1: write the notebook record under the per-agent lock, RE-READING the list so the id (positional) is minted
  // against the current notebook and a concurrent run's memory.write isn't clobbered by this whole-array set.
  let writtenId = null, rec = null;
  await notebookStore.update('notebook:' + agentId, (stored) => {
    const list = Array.isArray(stored) ? stored : [];
    writtenId = memcore.nextNoteId(list);   // collision-proof (positional length reuses a slot freed by forget)
    rec = recordFromProposal(prop || {}, { now: Date.now(), runId: runId || (prop && prop.sourceRunId), id: writtenId, content });
    if (trustDelta) rec.trust = memcore.nextTrust(rec.trust, trustDelta);   // M-mem.6: keep/edit seeds real trust; silent auto-save leaves it neutral
    list.push(rec);
    return list;
  });
  chanEmit('memory.write', { agentId, runId: runId || rec.sourceRunId || writtenId, id: writtenId, kind: rec.kind, scope: rec.scope });
  return { ok: true, id: writtenId, kind: rec.kind };
}

// §5.6 "discard/veto = never again": append the rejected belief text to the permanent per-agent declined list
// (capped FIFO) so reflection's dedup suppresses it forever. Idempotent (no dup entries). A failed write never
// fails the caller (the reject-list is best-effort observability; the negative feedback still calibrates trust).
async function appendDeclined(agentId, text) {
  const t = String(text || '').trim();
  if (!t) return;
  try {
    await notebookStore.update('declined:' + agentId, (stored) => {
      const list = Array.isArray(stored) ? stored.slice() : [];
      if (list.indexOf(t) < 0) { list.push(t); while (list.length > DECLINED_CAP) list.shift(); }
      return list;
    });
  } catch (_) {}
}

async function handleMemoryTurnin(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const agentId = String(body.agentId || 'agent');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(403, { error: 'forbidden' });
  const runId = String(body.runId || '');
  const id = String(body.id || '');
  const verdict = String(body.verdict || '');
  const fb = feedbackFor(verdict);
  if (!fb) return json(400, { error: 'verdict must be keep, edit, discard, or veto' });

  // VETO (silent-save UX): the memory was ALREADY auto-saved; this UNDOES it. It targets a SAVED record id (a
  // notebook id, or a skill id when kind:'skill'), NOT a pending proposal — so it does not touch proposalsByRun.
  // Idempotent: a record already gone is a harmless ok:true no-op. The undone text joins the permanent denylist
  // (never re-proposed); Memory Core Restore is the undo-for-the-undo.
  if (verdict === 'veto') {
    if (!id) return json(400, { error: 'veto needs the saved record id' });
    const text = String(body.content || '').trim();
    if (String(body.kind || '') === 'skill') {
      const r = skillStore.manage({ agentId, action: 'archive', id });   // soft-delete (archive) = "delete the skill"
      if (!r.ok && !/no such skill/i.test(String(r.error || ''))) return json(400, { error: r.error || 'could not undo skill' });
    } else {
      // remove the notebook record under the per-agent lock (re-read so a concurrent write isn't clobbered).
      let found = false;
      await notebookStore.update('notebook:' + agentId, (stored) => {
        const r = memcore.applyForget(Array.isArray(stored) ? stored : [], id);
        found = r.found;
        return found ? r.records : undefined;   // no write when the record is already gone (idempotent)
      });
      if (found) chanEmit('memory.forget', { agentId, id });
    }
    await appendDeclined(agentId, text);   // the undone belief is never proposed again
    chanEmit('memory.feedback', { agentId, id, delta: fb.delta, reason: fb.reason });   // -1, reason 'vetoed'
    return json(200, { ok: true, verdict, id });
  }

  const batch = proposalsByRun.get(runId);
  const prop = batch && batch.agentId === agentId && batch.proposals.find(p => p.id === id);
  if (!prop) return json(404, { error: 'no such proposal (it may have expired)' });
  // AUTO-SAVED items ride the same stash (saved:true, carrying a REAL notebook/skill id) so the frontend can fetch
  // the receipt batch — but they are already written. A keep/edit here would mint a DUPLICATE record; a discard
  // would denylist the text while the record silently survives. Only veto (handled above) may target them.
  if (prop.saved) return json(409, { error: 'already saved — use verdict veto to undo it' });
  // resolved either way — drop it from the pending batch (and the batch entry when it empties)
  batch.proposals = batch.proposals.filter(p => p.id !== id);
  if (!batch.proposals.length) { proposalsByRun.delete(runId); if (latestProposalRun.get(agentId) === runId) latestProposalRun.delete(agentId); }

  if (verdict === 'discard') {
    // §5.6 "discard = never again": no NOTEBOOK record is written, but the rejected text IS recorded to the
    // permanent per-agent declined list so reflection's dedup suppresses it forever. Negative feedback calibrates confidence.
    await appendDeclined(agentId, prop.content);
    chanEmit('memory.feedback', { agentId, id: prop.id, delta: fb.delta, reason: fb.reason });
    return json(200, { ok: true, verdict, id: null });
  }
  // keep/edit -> commit a real §5.2 record via the ONE write path (shared with silent auto-save). The keep/edit
  // verdict seeds real trust (fb.delta); a skill proposal becomes a saved skill instead of a note.
  const content = (verdict === 'edit' ? String(body.content != null ? body.content : prop.content) : prop.content).trim();
  const w = await writeMemoryRecord(agentId, prop, {
    content, runId, trustDelta: fb.delta,
    skillName: body.skillName || body.name, skillBody: body.skillBody || body.body, summary: body.summary
  });
  if (!w.ok) return json(400, { error: w.error || 'could not save that memory' });
  const writtenId = w.id;
  chanEmit('memory.feedback', { agentId, id: writtenId, delta: fb.delta, reason: fb.reason });
  json(200, { ok: true, verdict, id: writtenId, kind: w.kind });
}

// POST /api/memory/reset { agent } — wipe a hero's SERVER-SIDE memory on new-hero commission, so a fresh Commander
// never inherits a stranger's kept memories (notebook:), pending plan (todo:), or — new in this change — permanently
// declined proposals (declined:). The frontend's onWake already resets the browser advice stores; this closes the
// matching server-side bleed (the project's "a fresh agent must not inherit a stranger's state" hard rule).
async function handleMemoryReset(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const agentId = String(body.agent || body.agentId || 'agent');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(403, { error: 'forbidden' });
  await resetAgentMemory(notebookStore, agentId);   // wipe notebook:/declined:/todo: (pure helper — unit-tested)
  // also drop any in-memory pending proposals for this agent so a stale turn-in can't land on the new hero
  for (const [rid, b] of proposalsByRun) { if (b && b.agentId === agentId) proposalsByRun.delete(rid); }
  latestProposalRun.delete(agentId); lastReflectAt.delete(agentId); reflectingNow.delete(agentId);
  // GROWTH Tier 1: also drop any pending STUDY proposals so a fresh Commander never inherits a stranger's belief-update queue.
  for (const [rid, b] of studyByRun) { if (b && b.agentId === agentId) studyByRun.delete(rid); }
  latestStudyRun.delete(agentId); lastStudyAt.delete(agentId); studyingNow.delete(agentId); studyDeclinedByAgent.delete(agentId);
  return json(200, { ok: true, agent: agentId });
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

// GET /api/memory/declined?agent=<id> — the permanent reject-list: beliefs the Commander Discarded, which
// reflection will never re-propose (§5.6 "discard = never again"). Read-only observability for the Memory Core
// panel so the denylist is visible (and, via restore below, reversible). Redacted on the way out (defence-in-depth).
function serveDeclined(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agent)) return json(403, { error: 'forbidden' });
    const raw = notebookStore.get('declined:' + agent);
    const declined = Array.isArray(raw) ? raw.map(t => redact(String(t))) : [];
    json(200, { agentId: agent, declined });
  } catch (e) { json(200, { declined: [] }); }
}

// POST /api/memory/declined/restore { agent, text } — REMOVE one entry from the permanent reject-list so a belief
// the Commander discarded by mistake can be proposed again (the undo-a-discard escape hatch). The user's click IS
// the consent — they are editing their OWN visible store — so there is no permission prompt. { ok, removed }.
async function handleDeclinedRestore(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  const agentId = String(body.agentId || body.agent || 'agent');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return json(403, { error: 'forbidden' });
  const text = String(body.text || '').trim();
  if (!text) return json(400, { error: 'text required' });
  const removed = await restoreDeclined(notebookStore, agentId, text);
  json(200, { ok: true, removed });
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
/* ---- P1-10 MEMORY controls API. GET reports the live reflection config + a plain-English scope note (what the
   station may remember). POST persists { reflectEnabled?, reflectCooldownMs? } and applies LIVE (the reflect gate
   reads memoryConfig on every run). Cooldown clamps to a sane 0–1h so a typo can't wedge or spam the loop. ---- */
function memoryScopeNote() {
  return 'After a completed task, the station may propose short factual notes it learned about your work — always ' +
    'shown for you to Keep, Edit or Discard first. Nothing is remembered without your say-so; a Discard is remembered ' +
    'as "never propose this again". Turn reflection off to stop it proposing new memories entirely.';
}
function handleMemoryConfigGet(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    reflectEnabled: memoryConfig.reflectEnabled,
    reflectCooldownMs: memoryConfig.reflectCooldownMs,
    defaultCooldownMs: REFLECT_COOLDOWN_MS,
    scopeNote: memoryScopeNote()
  }));
}
async function handleMemoryConfigSet(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 4096)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }
  if (Object.prototype.hasOwnProperty.call(body, 'reflectEnabled')) memoryConfig.reflectEnabled = !!body.reflectEnabled;
  if (Object.prototype.hasOwnProperty.call(body, 'reflectCooldownMs')) {
    const n = Number(body.reflectCooldownMs);
    if (!isFinite(n) || n < 0 || n > 3600000) return json(400, { error: 'reflectCooldownMs must be 0–3600000 (up to 1 hour)' });
    memoryConfig.reflectCooldownMs = Math.floor(n);
  }
  saveMemoryConfig();
  return handleMemoryConfigGet(req, res);
}
// Class Loadouts S1: serve read-only .js from the shared/ dir for the browser (the shared specialty catalog).
// Path-jailed to SHARED and restricted to .js so it can never leak arbitrary repo files. Mirrors serveStatic.
async function serveShared(req, res) {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);   // e.g. /shared/specialties.js
    const rel = url.replace(/^\/shared\/+/, '');
    if (!/^[A-Za-z0-9_.-]+\.js$/.test(rel)) { res.writeHead(403); return res.end('forbidden'); }
    const abs = path.resolve(SHARED, rel);
    if (abs.indexOf(SHARED + path.sep) !== 0) { res.writeHead(403); return res.end('forbidden'); }
    const data = await fsp.readFile(abs);
    res.writeHead(200, { 'Content-Type': MIME['.js'] || 'application/javascript', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('not found'); }
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
