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
const { makeRegistry } = require('./tools/registry.js');
const { makeWebTools } = require('./tools/builtin/web.js');
const { makeFsTools } = require('./tools/builtin/fs.js');
const { makeNotebookTools } = require('./tools/builtin/notebook.js');
const { resolveTools } = require('./capability/resolve.js');
const { makeCapCtx } = require('./capability/capGate.js');
const { makeOpenRouterProvider } = require('./providers/openrouter.js');
const { makeEmitter } = require('../shared/emitter.js');
const { redact, renderRecall, injectRecall } = require('./context.js');
const { makeConsentBroker } = require('./permissions.js');
const { makeTelegramAdapter } = require('./channels/telegram.js');
const { makeChannelStore } = require('./channels/store.js');
const { makeChannelHub } = require('./channels/hub.js');
const { makeSseHub } = require('./channels/sse.js');
const Classify = require('../frontend/app/classify.js');   // the SAME task-vs-talk classifier the browser uses

const PORT = Number(process.env.SKYNET_PORT || process.env.PORT) || 8787;
const FRONTEND = path.resolve(__dirname, '..', 'frontend');
const WORKSPACES = path.resolve(__dirname, 'workspaces');
const CAPS = { maxIters: 16, maxCostUsd: 1.00, maxRepeat: 3, toolTimeoutMs: 30000, maxToolBytes: 120000 };
const CONSENT_TIMEOUT_MS = 120000;   // a live permission.prompt left unanswered this long auto-denies (never hangs a run)
// The agent's toolset is NOT a host-side constant — it is projected from the objects placed in the
// agent's room (CAP_REGISTRY: computer/dish/cabinet/notebook). See handleRun's station + resolveTools.

// last-resort nets so a single run's failure never takes the whole host (and all other runs) down.
process.on('unhandledRejection', e => console.error('unhandledRejection:', (e && e.stack) || e));
process.on('uncaughtException', e => console.error('uncaughtException:', (e && e.stack) || e));

try { fs.mkdirSync(WORKSPACES, { recursive: true }); } catch (e) {}

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
    newId: () => crypto.randomUUID(), maxMessageLength: 4096
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
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'POST' && req.url === '/api/run') return handleRun(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/cancel') return handleCancel(req, res);
  if (req.method === 'POST' && req.url === '/api/consent') return handleConsent(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/connect') return handleChannelConnect(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/sync') return handleChannelSync(req, res);
  if (req.method === 'POST' && req.url === '/api/channels/telegram/disconnect') return handleChannelDisconnect(req, res);
  if (req.method === 'GET' && req.url === '/api/channels/telegram/status') return handleChannelStatus(req, res);
  if (req.method === 'GET' && req.url === '/api/channels/events') return handleChannelEvents(req, res);
  if (req.method === 'GET' && req.url === '/api/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' && req.url.indexOf('/api/file') === 0) return serveWorkspaceFile(req, res);
  if (req.method === 'GET' && req.url.indexOf('/api/notebook') === 0) return serveNotebook(req, res);
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

/* ------------------------------- the run endpoint ------------------------------- */
async function handleRun(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 2 << 20)); }
  catch (e) { res.writeHead(400); return res.end('bad json'); }
  const { key, model, system, messages = [], agentId = 'agent', isTask = false } = body || {};
  if (!key || !model) { res.writeHead(400); return res.end('missing key/model'); }

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
      key, model, system, messages, agentId, isTask,
      emit, signal: ac.signal, runId, trigger: 'directive',
      surface: 'interactive', prompt: promptConsent
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

  // ---- capabilities: the office workstation. Each placed object IS a capability grant (CAP_REGISTRY):
  //      computer = compute gate · dish = web · cabinet = files · notebook = memory. resolveTools
  //      projects them into the agent's tools FRESH per run — no host-side toolset policy. ----
  const station = { agents: { [agentId]: { id: agentId, room: 'office' } }, rooms: { office: { id: 'office', objects: [
    { instanceId: 'pc1', objectType: 'computer' },
    { instanceId: 'dish1', objectType: 'dish' },
    { instanceId: 'cab1', objectType: 'cabinet' },
    { instanceId: 'nb1', objectType: 'notebook' }
  ] } } };
  const resolved = resolveTools(agentId, station);
  // P1.5: the real informed-consent broker. surface:'interactive' + prompt ⇒ ungranted mutations ask live;
  // surface:'autonomous' (no one watching, e.g. a Telegram chat) ⇒ default-deny on any ungranted mutation
  // (silence is not consent). Read-only/non-network auto-allows; the hardline floor sits below Full Access.
  const consent = makeConsentBroker({
    bypass: FULL_ACCESS, hardline: hardlineFloor, sessionKey: runId,
    grantsSession, grantsPermanent, persist: persistAllowlist, grantsBlanket: blanketSetFor(agentId),
    networkOf: (call) => !!resolved.networkCaps[call.name],
    surface: surface, prompt: prompt
  });
  const capCtx = makeCapCtx(resolved, { emit, consent, timeoutMs: CAPS.toolTimeoutMs });

  // ---- provider + cost ----
  const provider = makeOpenRouterProvider({ fetch: globalThis.fetch, key });
  const cost = makeCostEngine({ priceOf: provider.priceOf });

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
  // Cortex (M-mem.1): surface the agent's OWN memory in-prompt — inject a recalled-memory fence (newest notes
  // first, char-capped) right before the triggering user message, so the agent never has to call notebook.read
  // to remember. Empty notebook => nothing injected (byte-identical to a memoryless run). Never fails the run.
  try {
    const stored = notebookStore.get('notebook:' + agentId);
    const recall = renderRecall(Array.isArray(stored) ? stored.slice().reverse() : [], { limit: 1500 });
    if (recall.text) { msgs = injectRecall(msgs, recall.text); emit('memory.recall', { agentId, runId, count: recall.count, chars: recall.chars }); }
  } catch (_) {}

  await runAgentLoop({
    messages: msgs, provider, emit, cost, tools: toolDefs, dispatch, capCtx,
    limits: { maxIters: CAPS.maxIters, maxCostUsd: CAPS.maxCostUsd },
    signal: signal, clock: { now: () => Date.now() },
    agentId, runId, model, trigger: trigger,
    // rough initial estimate for the error classifier's context-overflow ratio; contextLimit is 0 until the
    // /models catalog warms, which (by design) disables the ratio so a bare 400 is never mislabelled.
    approxTokens: Math.ceil(JSON.stringify(msgs).length / 4), contextLimit: provider.contextLimit(model)
  });
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

/* ------------------------------- helpers ------------------------------- */
// a short, human-readable summary of WHAT a consent prompt is approving — the file path for fs.* (what the user
// actually cares about), else the compact args. Never echoes secrets (redact() also runs on the emitted event).
function consentSummary(call) {
  const a = (call && call.args) || {};
  if (typeof a.path === 'string' && a.path) return a.path;
  try { const s = JSON.stringify(a); return s.length > 80 ? s.slice(0, 77) + '…' : s; } catch (_) { return ''; }
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
