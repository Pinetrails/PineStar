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

const { runAgentLoop } = require('./loop.js');
const { makeCostEngine } = require('./cost.js');
const { makeLedger } = require('./ledger.js');
const { makeBudget } = require('./budget.js');
const { killAll } = require('./halt.js');
const { makeRegistry } = require('./tools/registry.js');
const { makeWebTools } = require('./tools/builtin/web.js');
const { makeFsTools } = require('./tools/builtin/fs.js');
const { makeNotebookTools } = require('./tools/builtin/notebook.js');
const { makeSaveStore } = require('./savestore.js');
const { mergeNotes } = require('./notebookrestore.js');
const { makeRunStore } = require('./runstore.js');
const { resolveTools } = require('./capability/resolve.js');
const { makeCapCtx } = require('./capability/capGate.js');
const { makeOpenRouterProvider } = require('./providers/openrouter.js');
const { selectProvider } = require('./providers/factory.js');
const codexAuth = require('./providers/codex-auth.js');
const { makeEmitter } = require('../shared/emitter.js');
const { redact, renderRecall, injectRecall, rank, makeContext } = require('./context.js');
const { reflect, worthReflecting, recordFromProposal, feedbackFor } = require('./reflect.js');
const memcore = require('./memcore.js');
const { makeConsentBroker } = require('./permissions.js');
const { makeTelegramAdapter } = require('./channels/telegram.js');
const { makeChannelStore } = require('./channels/store.js');
const { makeChannelHub } = require('./channels/hub.js');
const { makeSseHub } = require('./channels/sse.js');
const { makeRouter } = require('./routing/router.js');
const { makeConnectorManager } = require('./mcp/manager.js');
const { makeHttpTransport } = require('./mcp/transport.http.js');
const Classify = require('../frontend/app/classify.js');   // the SAME task-vs-talk classifier the browser uses

const PORT = Number(process.env.SKYNET_PORT || process.env.PORT) || 8787;
// Desktop build: the live BYOK key — seeded from the OS keychain via env at spawn, and updated
// in place via the token-guarded POST /api/key (the parent shell pushes changes; no restart).
let runtimeKey = String(process.env.SKYNET_OPENROUTER_KEY || '').trim();
const FRONTEND = path.resolve(__dirname, '..', 'frontend');
// the agent workspaces + their protected siblings (notebook/ledger/permissions/channels). Defaults to
// sidecar/workspaces; SKYNET_WORKSPACES relocates it (isolated tests, multi-instance deploys, a data volume).
const WORKSPACES = process.env.SKYNET_WORKSPACES ? path.resolve(process.env.SKYNET_WORKSPACES) : path.resolve(__dirname, 'workspaces');
const CAPS = { maxIters: 16, maxCostUsd: 1.00, maxRepeat: 3, toolTimeoutMs: 30000, maxToolBytes: 120000 };
// Spend governance ("Balanced" posture): per-RUN hard ceiling (the loop's maxCostUsd) + SOFT cross-run pools
// (per-day, global) governed over the persisted ledger, each with one-click resume. Env-overridable so a deploy
// can retune without a code change. perRun ($3) replaces the conservative $1 dev default once a budget is live.
// num() passes a parsed value through (including 0 -> UNGOVERNED via budget.js capOf, e.g. SKYNET_BUDGET_PER_DAY=0
// disables the day pool); only an empty/missing/negative/non-numeric value falls back to the default.
const num = (v, d) => { if (v == null || String(v).trim() === '') return d; const n = Number(v); return (typeof n === 'number' && !isNaN(n) && n >= 0) ? n : d; };
const BUDGET_CAPS = {
  perRun: num(process.env.SKYNET_BUDGET_PER_RUN, 3),
  perDay: num(process.env.SKYNET_BUDGET_PER_DAY, 40),
  global: num(process.env.SKYNET_BUDGET_GLOBAL, 100)
};
const CONSENT_TIMEOUT_MS = 120000;   // a live permission.prompt left unanswered this long auto-denies (never hangs a run)
// The agent's toolset is NOT a host-side constant — it is projected from the objects placed in the
// agent's room (CAP_REGISTRY: computer/dish/cabinet/notebook). See handleRun's station + resolveTools.

// last-resort nets so a single run's failure never takes the whole host (and all other runs) down.
process.on('unhandledRejection', e => console.error('unhandledRejection:', (e && e.stack) || e));
process.on('uncaughtException', e => console.error('uncaughtException:', (e && e.stack) || e));

try { fs.mkdirSync(WORKSPACES, { recursive: true }); } catch (e) {}

/* ---- spend ledger + budget (Wave 1 cost spine) ----
   The ledger is an append-only JSONL of finished runs (sibling of the fs jail, so the agent's own fs.* tools can
   neither read nor rewrite the spend record). Each append is fsync'd to disk so the day/global pools survive even
   a hard power loss (not just a clean crash) — otherwise an un-flushed tail would silently hand a capped Commander
   unintended headroom after restart. The budget governs the soft cross-run pools; the host injects the wall clock
   at this composition boundary. */
const LEDGER_FILE = path.join(WORKSPACES, 'ledger.jsonl');
const ledgerIo = {
  readAll() {
    try {
      return fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    } catch (e) { return []; }
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
  }
};
const ledger = makeLedger({ io: ledgerIo, clock: { now: () => Date.now() } });
const budget = makeBudget({ caps: { day: BUDGET_CAPS.perDay, global: BUDGET_CAPS.global }, ledger, clock: { now: () => Date.now() } });

// run-history log (M-save P4): the OUTCOME of each finished run ({runId, agentId, reason, turns, tokens, usd,
// title, ts}), append-only + fsync'd like the ledger and a sibling of the fs jail (the agent can't rewrite its
// own history). The ledger answers "what did it cost"; this answers "what happened" — the durable substrate a
// future autopsy/replay view reads. It learns nothing; the cortex does that from the live message log.
const RUNS_FILE = path.join(WORKSPACES, 'runs.jsonl');
const runsIo = {
  readAll() {
    try {
      return fs.readFileSync(RUNS_FILE, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    } catch (e) { return []; }
  },
  append(entry) {
    let fd = null;
    try { fd = fs.openSync(RUNS_FILE, 'a'); fs.writeSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd); }
    catch (e) { console.warn('[runs] append failed:', (e && e.message) || e); }
    finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
  }
};
const runStore = makeRunStore({ io: runsIo, clock: { now: () => Date.now() } });

const runs = new Map();          // runId -> AbortController (the kill path)
let lastSearchAt = 0;            // module-level web_search throttle (≥1.1s between DDG hits, any run)

// jail helper reused by the read-only /api/file route (resolveInside proves a path stays in the workspace)
const fsJail = makeFsTools({ fsp, pathMod: path, root: WORKSPACES })._internals;

// PERSISTENT notebook (memory) — JSON file per agent, atomic write, survives sidecar restarts. Stored as a
// SIBLING of the agent's workspace dir (WORKSPACES/<aid>.notebook.json), OUTSIDE the fs-jailed
// WORKSPACES/<aid>/, so the agent's own fs.* tools can neither read nor corrupt its memory. Sync get/set to
// match the notebook tool's store contract.
function notebookFile(key) {
  const aid = String(key).replace(/^notebook:/, '') || 'agent';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(aid)) throw new Error('bad notebook agentId');
  return path.join(WORKSPACES, aid + '.notebook.json');
}
const notebookStore = {
  get(key) { try { return JSON.parse(fs.readFileSync(notebookFile(key), 'utf8')); } catch (e) { return undefined; } },
  set(key, value) {
    try {
      const f = notebookFile(key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = f + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, f);   // atomic replace
    } catch (e) { console.warn('[notebook] persist failed:', (e && e.message) || e); }
  }
};

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
    if (usd) { try { ledger.record({ runId, agentId, turns: 0, usd, tokens }); } catch (_) {} }
  }
}

/* ---- consent (P1.5): the four-tier broker's host-side state ----
   Full Access is FROZEN at boot: a tool or model output cannot flip it at runtime — closes the
   prompt-injection escalation path (mirrors Hermes' import-frozen YOLO flag). */
const FULL_ACCESS = /^(1|true|yes|on)$/i.test(String(process.env.SKYNET_FULL_ACCESS || '').trim());
// permanent allowlist of danger-class keys (capability:scope) the user has blessed forever. Lives BESIDE
// the notebook store (sibling of the fs jail) so the agent's own fs.* tools can neither read nor rewrite it.
const ALLOWLIST_FILE = path.join(WORKSPACES, 'permissions.allow.json');
function loadAllowlist() {
  try {
    const raw = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
    return new Set((raw && Array.isArray(raw.allow) ? raw.allow : []).filter(x => typeof x === 'string'));
  } catch (e) { return new Set(); }   // missing or corrupt -> nothing pre-allowed (fail-closed)
}
function persistAllowlist(nextAllow) {   // throws on failure -> the broker degrades the grant to a deny
  const tmp = ALLOWLIST_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, allow: nextAllow }));
  fs.renameSync(tmp, ALLOWLIST_FILE);    // atomic replace
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
// unconditional hardline floor: protected files no flag (not even Full Access) can write. The authoritative
// resolved-abs-path floor belongs in dispatch AFTER resolveInside; this catches the reachable relative cases.
function hardlineFloor(call) {
  const p = call && call.args && call.args.path;
  if (typeof p === 'string' && (/(^|[\\/])\.env(\.|$)/i.test(p) || /(^|[\\/])\.git([\\/]|$)/i.test(p)))
    return 'writing ' + p + ' is blocked by the protected-file floor';
  return null;
}

/* ---- messaging channels (C5): a Telegram bot the Commander connects from the in-app Messaging tab.
   The bot token + the OpenRouter key/model persist in a PROTECTED sibling file (outside the fs jail, never on
   the bus, never returned by /status) so polling survives a restart with no browser open. The adapter is the
   lone ambient-I/O edge (injected globalThis.fetch); the hub drives the SAME runOnce host with
   surface:'autonomous' (a headless chat has no browser to answer a consent prompt — ungranted writes
   default-deny and the run continues). Opt-in: nothing starts unless the Commander connects (or env is set). */
const TELEGRAM_PERSONA = 'You are the Commander\'s AI agent aboard the SKYNET station, reachable over Telegram. '
  + 'Address the user as "Commander", keep a spark of personality, and keep replies concise and chat-friendly. '
  + 'When the Commander gives you a task you have REAL tools (web search/read, files, memory) — use them and '
  + 'report what you actually found; never claim you cannot act.';
const VOICE_CACHE_DIR = path.join(WORKSPACES, 'voice-cache');
try { fs.mkdirSync(VOICE_CACHE_DIR, { recursive: true }); } catch (e) {}
let ttsMissCount = 0, evictingVoiceCache = false;   // opportunistic, throttled voice-cache eviction
const CHANNELS_DIR = path.join(WORKSPACES, 'channels');
const CHANNEL_SECRETS_FILE = path.join(CHANNELS_DIR, 'secrets.json');
function loadChannelSecrets() {
  try { const raw = JSON.parse(fs.readFileSync(CHANNEL_SECRETS_FILE, 'utf8')); return (raw && typeof raw === 'object') ? raw : {}; }
  catch (e) { return {}; }   // missing/corrupt -> nothing configured
}
function saveChannelSecrets(obj) {   // protected sibling of the fs jail; the agent's own fs.* tools can't read/write it
  try {
    fs.mkdirSync(CHANNELS_DIR, { recursive: true });
    const tmp = CHANNEL_SECRETS_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CHANNEL_SECRETS_FILE);
  } catch (e) { console.warn('[channels] secrets persist failed:', (e && e.message) || e); }
}
let channelSecrets = loadChannelSecrets();
const channelStore = makeChannelStore({ fs, pathMod: path, root: CHANNELS_DIR, clock: { now: () => Date.now() } });

// ---- Codex (personal ChatGPT subscription) OAuth tokens — a protected sibling of the fs jail, SAME posture
//      as the channel secrets above: the agent's own fs.* tools can't reach it, and the access/refresh tokens
//      are NEVER placed on the event bus. Shape: { access_token, refresh_token, last_refresh, auth_mode }. ----
const CODEX_TOKENS_FILE = path.join(WORKSPACES, 'codex', 'tokens.json');
function loadCodexTokens() {
  try { const raw = JSON.parse(fs.readFileSync(CODEX_TOKENS_FILE, 'utf8')); return (raw && typeof raw === 'object' && raw.access_token) ? raw : null; }
  catch (e) { return null; }
}
function saveCodexTokens(obj) {
  try {
    fs.mkdirSync(path.dirname(CODEX_TOKENS_FILE), { recursive: true });
    const tmp = CODEX_TOKENS_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CODEX_TOKENS_FILE);
  } catch (e) { console.warn('[codex] token persist failed:', (e && e.message) || e); }
}
function clearCodexTokens() { try { fs.unlinkSync(CODEX_TOKENS_FILE); } catch (e) {} }
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
  try { const raw = JSON.parse(fs.readFileSync(CONNECTORS_FILE, 'utf8')); return (raw && Array.isArray(raw.connectors)) ? raw.connectors : []; }
  catch (e) { return []; }   // missing/corrupt -> nothing configured
}
let connectorConfigs = loadConnectorConfigs();
function saveConnectorConfigs() {
  try {
    fs.mkdirSync(CONNECTORS_DIR, { recursive: true });
    const tmp = CONNECTORS_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, connectors: connectorConfigs }));
    fs.renameSync(tmp, CONNECTORS_FILE);   // atomic replace
  } catch (e) { console.warn('[connectors] persist failed:', (e && e.message) || e); }
}
const connectors = makeConnectorManager({
  makeTransport: makeHttpTransport, clock: { now: () => Date.now() }, timeoutMs: CAPS.toolTimeoutMs,
  onEvent: (e) => { try { console.log('[connector]', e.type, e.connectorId || '', e.state || e.detail || ''); } catch (_) {} }
});

let telegram = null;                                    // { adapter, hub } when connected, else null
let telegramStatus = { connected: false, state: 'down', detail: '' };

function startTelegram(token, key, model, agentCfg) {
  stopTelegram();
  const cfg = agentCfg || {};
  // Persist the SAME agentId + composed system prompt the app uses, so a Telegram run IS the same agent
  // (shared notebook/memory/workspace + identity), just a different session. `agentId`/`system` are read
  // LIVE by the hub each message, so /sync can refresh them (dossier edits) without a reconnect.
  channelSecrets = Object.assign({}, channelSecrets, { telegram: {
    token: token, key: key, model: model, enabled: true,
    agentId: cfg.agentId || undefined, system: cfg.system || undefined, name: cfg.name || undefined
  } });
  saveChannelSecrets(channelSecrets);
  let adapterRef = null;
  const hub = makeChannelHub({
    channel: 'telegram', runOnce: runOnce, store: channelStore,
    send: (chatId, text, opts) => adapterRef ? adapterRef.send(chatId, text, opts) : Promise.resolve({ ok: false, error: 'no adapter' }),
    secrets: () => { const t = (channelSecrets && channelSecrets.telegram) || {}; return { key: t.key, model: t.model, agentId: t.agentId, system: t.system }; },
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

const server = http.createServer((req, res) => {
  // Desktop build serves the frontend from the Tauri origin, so its /api/* calls are cross-origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.writeHead(204); return res.end();
  }
  if (req.method === 'POST' && req.url === '/api/run') return handleRun(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/tts') return handleTts(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/cancel') return handleCancel(req, res);
  if (req.method === 'POST' && req.url === '/api/halt') return handleHalt(req, res);
  if (req.method === 'POST' && req.url === '/api/consent') return handleConsent(req, res);
  if (req.method === 'POST' && req.url === '/api/key') return handleSetKey(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/connect') return handleChannelConnect(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/sync') return handleChannelSync(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/disconnect') return handleChannelDisconnect(req, res);
  if (req.method === 'GET' && req.url === '/api/channels/telegram/status') return handleChannelStatus(req, res);
  if (req.method === 'GET' && req.url === '/api/channels/events') return handleChannelEvents(req, res);
  if (req.method === 'POST' && req.url === '/api/routing') return handleRouting(req, res);
  if (req.method === 'GET' && req.url === '/api/budget/status') return handleBudgetStatus(req, res);
  if (req.method === 'POST' && req.url === '/api/budget/resume') return handleBudgetResume(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/codex/start') return handleCodexStart(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/codex/poll') return handleCodexPoll(req, res);
  if (req.method === 'GET' && req.url === '/api/auth/codex/status') return handleCodexStatus(req, res);
  if (req.method === 'GET' && req.url === '/api/auth/codex/models') return handleCodexModels(req, res);
  if (req.method === 'POST' && req.url === '/api/auth/codex/logout') return handleCodexLogout(req, res);
  if (req.method === 'GET' && req.url === '/api/connectors') return handleConnectorsList(req, res);
  if (req.method === 'POST' && req.url === '/api/connectors') return handleConnectorUpsert(req, res);
  if (req.method === 'POST' && req.url === '/api/connectors/remove') return handleConnectorRemove(req, res);
  if (req.method === 'POST' && req.url === '/api/connectors/refresh') return handleConnectorRefresh(req, res);
  if (req.method === 'GET' && req.url === '/api/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' && req.url.indexOf('/api/file') === 0) return serveWorkspaceFile(req, res);
  if (req.method === 'POST' && req.url === '/api/notebook/restore') return handleNotebookRestore(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/notebook') === 0) return serveNotebook(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/save') === 0) return serveSaveLoad(req, res);
  if (req.method === 'POST' && req.url === '/api/save') return handleSaveWrite(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/runs') === 0) return serveRuns(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/memory/proposals') === 0) return serveProposals(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/turnin') return handleMemoryTurnin(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/memory/records') === 0) return serveMemoryRecords(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/pin') return handleMemoryPin(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/edit') return handleMemoryEdit(req, res);
  if (req.method === 'POST' && req.url === '/api/memory/forget') return handleMemoryForget(req, res);
  return serveStatic(req, res);
});
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') console.error('✗ Port ' + PORT + ' is already in use (another sidecar already running?). Stop it, or set SKYNET_PORT=<n> and retry.');
  else if (e && e.code === 'EACCES') console.error('✗ Port ' + PORT + ' needs elevated privileges — pick a port >= 1024 via SKYNET_PORT.');
  else console.error('✗ sidecar listen error:', e);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('▲ SKYNET sidecar → http://127.0.0.1:' + PORT + '   (serving frontend + agent runtime)');
  // warm the key-independent /models catalog once so priceOf / contextLimit are live for every run
  makeOpenRouterProvider({ fetch: globalThis.fetch }).listModels().then(
    ms => { if (ms && ms.length) console.log('  · model catalog warmed (' + ms.length + ' models)'); },
    () => {}
  );
  // auto-start a previously-connected Telegram bot (saved config), else an env-provided one (headless deploys).
  try {
    const t = (channelSecrets && channelSecrets.telegram) || {};
    const envTok = String(process.env.SKYNET_TELEGRAM_TOKEN || '').trim();
    const envKey = String(process.env.SKYNET_OPENROUTER_KEY || '').trim();
    const envModel = String(process.env.SKYNET_DEFAULT_MODEL || '').trim();
    if (t.enabled && t.token && t.key && t.model) { startTelegram(t.token, t.key, t.model, { agentId: t.agentId, system: t.system, name: t.name }); console.log('  · telegram auto-started from saved config'); }
    else if (envTok && envKey && envModel) { startTelegram(envTok, envKey, envModel, {}); console.log('  · telegram auto-started from env'); }
  } catch (e) { console.warn('[channels] telegram auto-start failed:', (e && e.message) || e); }
  // warm every configured+enabled connector so its tools are ready on the first run (fire-and-forget; a
  // connector that is down/errors simply projects no tools — it never blocks the host or a run).
  try {
    for (const c of connectorConfigs) { if (c && c.enabled !== false && c.url) connectors.configure(c.id, c).catch(() => {}); }
    if (connectorConfigs.length) console.log('  · ' + connectorConfigs.length + ' MCP connector(s) warming');
  } catch (e) { console.warn('[connectors] warm failed:', (e && e.message) || e); }
});

/* ---- SSE bridge: forward validated channel/work-item telemetry to the live station HUD ---- */
function handleChannelEvents(req, res) {
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
  const token = String(process.env.SKYNET_IPC_TOKEN || '');
  if (!token || req.headers['x-skynet-token'] !== token) { res.writeHead(403); return res.end('forbidden'); }
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
  const url = String(body.url || '').trim();
  if (!url) return json(400, { error: 'a server URL is required' });
  const prev = connectorConfigs.find(c => c.id === id) || {};
  const cfg = {
    id: id, url: url,
    token: ('token' in body && body.token !== '') ? String(body.token) : (prev.token || ''),   // a blank token keeps the saved one
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

/* ------------------------------- the run endpoint ------------------------------- */
async function handleRun(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 2 << 20)); }
  catch (e) { res.writeHead(400); return res.end('bad json'); }
  const { model, system, messages = [], agentId = 'agent', isTask = false, provider } = body || {};
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

  // all setup + the run live inside ONE try, so any failure becomes a clean agent.run.error + closed stream
  try {
    // The browser is WATCHED, so an ungranted mutation asks live (interactive surface + promptConsent) instead
    // of default-denying. The SAME run host (runOnce) is reused by the messaging hub with surface:'autonomous'.
    await runOnce({
      key, model, system, messages, agentId, isTask, provider,
      emit, signal: ac.signal, runId, trigger: 'directive',
      surface: 'interactive', prompt: promptConsent,
      reflect: true   // only the WATCHED browser run reflects -> a turn-in beat; the headless hub omits this
    });
  } catch (e) {
    try { emit('agent.run.error', { agentId, runId, message: 'sidecar failure: ' + ((e && e.message) || e), transient: false }); } catch (_) {}
  } finally {
    runs.delete(runId);
    grantsSession.delete(runId);     // drop this run's session-scoped grants
    const p = pendingByRun.get(runId);   // deny any prompt still open (belt-and-suspenders; the loop normally awaits)
    if (p) { for (const f of p.values()) { try { f('deny'); } catch (_) {} } pendingByRun.delete(runId); }
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
  const { key, model, system, messages = [], agentId = 'agent', isTask = false, emit, signal, runId } = o;
  const surface = o.surface || 'interactive';
  const prompt = o.prompt;
  const trigger = o.trigger || 'directive';

  // ---- tools (registered fresh per run; cheap) ----
  const registry = makeRegistry();
  makeWebTools({ openrouter: { apiKey: key, model } }).register(registry);   // web_search/web_fetch (DDG/Jina, OR fallback)
  makeFsTools({ fsp, pathMod: path, root: WORKSPACES, limits: { writeBytes: 1 << 20, readReturn: 24000 } }).register(registry);
  makeNotebookTools({ store: notebookStore, clock: { now: () => Date.now() } }).register(registry);
  throttleSearch(registry);

  // ---- capabilities: each placed object IS a capability grant (CAP_REGISTRY): computer = compute gate · dish =
  //      web · cabinet = files · notebook = memory. resolveTools projects them into the agent's tools FRESH per
  //      run — no host-side toolset policy. Phase B5: a routed bay passes its OWN station (o.station) built from
  //      the objects in that bay's room, so per-bay caps are isolated; absent (browser chat / unrouted work) =
  //      the full default office, unchanged. ----
  const defaultObjects = [
    { instanceId: 'pc1', objectType: 'computer' },
    { instanceId: 'dish1', objectType: 'dish' },
    { instanceId: 'cab1', objectType: 'cabinet' },
    { instanceId: 'nb1', objectType: 'notebook' }
  ];
  // the single-agent browser office also gets every configured connector portal — there is exactly ONE agent
  // here, so this IS per-agent; routed multi-agent bays instead pass their OWN room objects (o.station) so each
  // bay only reaches the connectors physically placed in it.
  for (const cid of connectors.ids()) defaultObjects.push({ instanceId: 'conn_' + cid, objectType: 'connector', connectorId: cid });
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
  const consent = makeConsentBroker({
    bypass: FULL_ACCESS, hardline: hardlineFloor, sessionKey: runId,
    grantsSession, grantsPermanent, persist: persistAllowlist, grantsBlanket: blanketSetFor(agentId),
    networkOf: (call) => !!resolved.networkCaps[call.name],
    surface: surface, prompt: prompt
  });
  // B1 (Cortex seam): thread runId onto capCtx so a tool's dispatch can stamp provenance (sourceRunId)
  // on memory writes. makeCapCtx merges `extra` verbatim; the consumer arrives with M-mem.2.
  const capCtx = makeCapCtx(resolved, { emit, consent, timeoutMs: CAPS.toolTimeoutMs, runId });

  // ---- provider + cost ----
  // Codex (personal ChatGPT subscription) authenticates with a freshly-refreshed OAuth access_token instead of
  // an API key. A dead/missing token surfaces as a clean run.error so the UI can prompt a re-sign-in; everything
  // downstream of the provider seam (loop, cost, gauge) is identical to the OpenRouter path.
  const usingCodex = (o.provider === 'codex' || o.provider === 'openai-codex');
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
    provider = selectProvider({ provider: 'codex', fetch: globalThis.fetch, token: codexToken });
  } else {
    provider = selectProvider({ provider: 'openrouter', fetch: globalThis.fetch, key });
  }
  const cost = makeCostEngine({ priceOf: provider.priceOf });

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
  async function summarize(older) {
    const transcript = older.map(mm => {
      const c = (mm && typeof mm.content === 'string') ? mm.content : JSON.stringify((mm && mm.content) || '');
      return (mm && mm.role ? mm.role : 'msg') + ': ' + c;
    }).join('\n').slice(0, 16000);
    const req = { model, stream: true, signal, messages: [
      { role: 'system', content: 'You compress an earlier slice of an agent conversation into a dense factual summary. Preserve decisions made, facts and data learned (with sources), files written, tool results, and any still-open tasks. Drop pleasantries. Output ONLY the summary prose.' },
      { role: 'user', content: 'Summarize this earlier part of the conversation so it can replace the raw turns:\n\n' + transcript }
    ] };
    let out = '', usage = null;
    for await (const ev of provider.stream(req)) {
      if (ev && ev.type === 'text') out += ev.delta;
      else if (ev && ev.type === 'usage') usage = ev.usage;
    }
    const c = cost.reconcile(usage, model);
    emit('agent.cost', { agentId, runId, usd: c.usd || 0, model, reconciled: true });   // display-only; no token fields (gauge-safe)
    return { summary: out.trim(), usd: c.usd || 0, tokens: (c.tokensIn || 0) + (c.tokensOut || 0) };
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
  const dispatch = async (c, ctx) => {
    if (fromWire.has(c.name)) c = Object.assign({}, c, { name: fromWire.get(c.name) });   // wire -> real (dotted) name
    const sig = (c.name + '|' + (c.argsRaw || '')).slice(0, 400);
    const n = (seen.get(sig) || 0) + 1; seen.set(sig, n);
    if (n > CAPS.maxRepeat) return { ok: false, isError: true, content: 'repeated identical call blocked (loop guard)', summary: 'loop-break' };
    let r = await registry.dispatch(c, ctx);
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
  const toolNote = (isTask && wireNames.length)
    ? '\n\n[HARNESS] You are running in a REAL agent harness on the Commander\'s machine, at a workstation with '
      + 'these LIVE tools: ' + wireNames.join(', ') + '. '
      + 'Actually use them — never say you cannot reach the web or files; call the tool instead. '
      + 'Ground every factual claim in what web_search / web_fetch actually return, and cite the source URLs; '
      + 'do not invent facts, figures, or links. '
      + 'Save substantive deliverables (reports, code, notes) to your workspace with fs_write / fs_append, and record '
      + 'durable facts you\'ll want later with notebook_write. '
      + 'Saving a file shows the Commander a quick one-click approval prompt — so just CALL the write tool when you '
      + 'are ready; do not ask permission in chat or claim you cannot save. If they decline, carry on without it. '
      + 'Keep working across as many tool calls as the task needs; when it is fully done, give the Commander a clear '
      + 'final report of what you found/did and which files you saved.'
    : '';
  const sys = (system || '') + toolNote;
  let msgs = sys ? [{ role: 'system', content: sys }, ...messages] : messages.slice();
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
    const ranked = rank(recs, q, { now: Date.now() });
    const recall = renderRecall(ranked, { limit: 1500 });
    if (recall.text) {
      msgs = injectRecall(msgs, recall.text);
      emit('memory.recall', { agentId, runId, count: recall.count, chars: recall.chars });
      // M-mem.6: surfacing a record IS a use — fold useCount++ / lastUsedAt back onto the stored record (the
      // reduction that makes the Memory Core stats AND rank()'s recency/trust boosts REAL), then emit. One
      // store write per run (only when something changed); the bumped recs don't affect THIS run's ranking.
      if (runId) {
        const usedAt = Date.now();
        let updated = recs;
        for (let i = 0; i < recall.count && i < ranked.length; i++) {
          const r = ranked[i]; if (!r || !r.id) continue;
          updated = memcore.reduceStats(updated, { name: 'memory.used', payload: { id: r.id } }, { now: usedAt });
          emit('memory.used', { agentId, runId, id: r.id });
        }
        if (updated !== recs) notebookStore.set('notebook:' + agentId, updated);
      }
    }
  } catch (_) {}

  let result;
  try {
    result = await runAgentLoop({
      messages: msgs, provider, emit, cost, tools: toolDefs, dispatch, capCtx,
      // per-RUN hard ceiling = the Balanced perRun cap; the soft day/global pools ride on `budget`. A perRun of
      // 0/Infinity means UNGOVERNED per-run (Infinity), NOT "block every run" — the loop reads maxCostUsd that way.
      limits: { maxIters: CAPS.maxIters, maxCostUsd: (BUDGET_CAPS.perRun > 0 && isFinite(BUDGET_CAPS.perRun)) ? BUDGET_CAPS.perRun : Infinity },
      budget: runBudget, context: ctxMgr, summarize,
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
    try { ledger.record({ runId, agentId, turns: (result && result.turns) || 0, usd: (result && result.usd) || 0, tokens: (result && result.tokens) || 0 }); } catch (_) {}
    // record the run OUTCOME (durable history) — reason + a short title from the triggering user message. Fail-open.
    try {
      let title = '';
      for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i] && msgs[i].role === 'user' && typeof msgs[i].content === 'string') { title = msgs[i].content; break; } }
      runStore.record({ runId, agentId, reason: (result && result.reason) || 'done', turns: (result && result.turns) || 0, tokens: (result && result.tokens) || 0, usd: (result && result.usd) || 0, title: title });
    } catch (_) {}
    budget.clearLive(runId);
  }

  // Cortex M-mem.5b: post-run reflection (browser runs only; the hub omits o.reflect). Fire-and-forget so the
  // reply has no added latency and the input isn't held — proposals arrive a beat later over the SSE bus as a
  // Keep/Edit/Discard turn-in. Gated to a COMPLETED run with a substantive exchange; reflect() dedups vs the
  // store and never auto-writes (§5.6). result.messages is the live conversation (the agent's replies included).
  if (o.reflect && result && result.reason === 'done' && !signal.aborted && worthReflecting(result.messages)) {
    runReflection({ agentId, runId, messages: result.messages.slice(), provider, model, cost }).catch(() => {});
  }
  return result;
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
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ halted }));
}

// POST /api/channels/telegram/connect { token, key, model } — the Messaging tab hands over the BotFather token
// plus the app's current OpenRouter key+model; the sidecar persists them (protected sibling file) and starts the
// bot. Headless polling then works even with no browser open. The secrets are NEVER echoed back.
async function handleChannelConnect(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let body; try { body = JSON.parse(await readBody(req, 1 << 16)) || {}; } catch (e) { return json(400, { error: 'bad json' }); }   // room for the composed system prompt
  // reuse the saved values when the request omits them, so RECONNECT is one click (no re-pasting the token).
  const saved = (channelSecrets && channelSecrets.telegram) || {};
  const token = String(body.token || '').trim() || String(saved.token || '');
  const key = String(body.key || '').trim() || String(saved.key || '');
  const model = String(body.model || '').trim() || String(saved.model || '');
  // the app's REAL agent identity, so Telegram runs as the same agent (shared memory) with the same voice.
  const agentId = String(body.agentId || '').trim() || String(saved.agentId || '');
  const system = (typeof body.system === 'string' && body.system) ? body.system : String(saved.system || '');
  const name = String(body.agentName || '').trim() || String(saved.name || '');
  if (!token) return json(400, { error: 'missing bot token — create one with @BotFather and paste it here' });
  if (!key || !model) return json(400, { error: 'connect your agent first (an OpenRouter key + model are required)' });
  try { startTelegram(token, key, model, { agentId, system, name }); } catch (e) { return json(500, { error: (e && e.message) || 'failed to start' }); }
  json(200, { connected: true, state: telegramStatus.state });
}

// POST /api/channels/telegram/sync { agentId?, system?, model?, key?, agentName? } — refresh the agent identity
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
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://localhost', 'X-Title': 'SKYNET' },
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
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8'
};

// GET /api/file?agent=<id>&path=<rel> — read-only view of a file the agent produced, jailed to its
// workspace (resolveInside proves the path can't escape WORKSPACES/<agentId>/). Lets the user OPEN a
// deliverable from the app instead of digging through the filesystem. Served inline, never as an attachment.
async function serveWorkspaceFile(req, res) {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const agent = u.searchParams.get('agent') || 'agent';
    const rel = u.searchParams.get('path') || '';
    const { abs } = await fsJail.resolveInside(agent, rel);   // throws on jail escape / bad agentId / '..'
    const data = await fsp.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Disposition': 'inline; filename="' + path.basename(abs).replace(/[^A-Za-z0-9_.-]/g, '_') + '"',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  } catch (e) {
    const msg = (e && e.message) || '';
    if (/escape|illegal|bad agentId|bad notebook/.test(msg)) { res.writeHead(403); return res.end('forbidden'); }
    res.writeHead(404); res.end('not found');
  }
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
    const prev = notebookStore.get('notebook:' + agent);
    const existing = Array.isArray(prev) ? prev : [];
    const merged = mergeNotes(existing, incoming);
    notebookStore.set('notebook:' + agent, merged);
    json(200, { ok: true, total: merged.length, added: merged.length - existing.length });
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
  const stored = notebookStore.get('notebook:' + agentId);
  const list = Array.isArray(stored) ? stored : [];
  writtenId = memcore.nextNoteId(list);   // collision-proof (positional length reuses a slot freed by forget)
  const rec = recordFromProposal(prop, { now: Date.now(), runId: runId || prop.sourceRunId, id: writtenId, content });
  rec.trust = memcore.nextTrust(rec.trust, fb.delta);   // M-mem.6: the keep/edit verdict seeds real trust (a reduction, not 0)
  list.push(rec);
  notebookStore.set('notebook:' + agentId, list);
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
    const records = Array.isArray(raw) ? raw.map(r => redact(memcore.projectRecord(r))) : [];
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
  const stored = notebookStore.get(key);
  const list = Array.isArray(stored) ? stored : [];
  const r = op(list, body, agentId);
  if (r.error) return json(400, { error: r.error });
  if (!r.found) return json(404, { error: 'no such memory' });
  notebookStore.set(key, r.records);
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
    const data = await fsp.readFile(abs);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('not found'); }
}
