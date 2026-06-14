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
const { redact } = require('./context.js');
const { makeConsentBroker } = require('./permissions.js');

const PORT = Number(process.env.SKYNET_PORT || process.env.PORT) || 8787;
const FRONTEND = path.resolve(__dirname, '..', 'frontend');
const WORKSPACES = path.resolve(__dirname, 'workspaces');
const CAPS = { maxIters: 16, maxCostUsd: 1.00, maxRepeat: 3, toolTimeoutMs: 30000, maxToolBytes: 120000 };
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
// unconditional hardline floor: protected files no flag (not even Full Access) can write. The authoritative
// resolved-abs-path floor belongs in dispatch AFTER resolveInside; this catches the reachable relative cases.
function hardlineFloor(call) {
  const p = call && call.args && call.args.path;
  if (typeof p === 'string' && (/(^|[\\/])\.env(\.|$)/i.test(p) || /(^|[\\/])\.git([\\/]|$)/i.test(p)))
    return 'writing ' + p + ' is blocked by the protected-file floor';
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'POST' && req.url === '/api/run') return handleRun(req, res).catch(() => { try { res.end(); } catch (_) {} });
  if (req.method === 'POST' && req.url === '/api/cancel') return handleCancel(req, res);
  if (req.method === 'GET' && req.url === '/api/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' && req.url.indexOf('/api/file') === 0) return serveWorkspaceFile(req, res);
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
});

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
  req.on('close', () => { ac.abort(); runs.delete(runId); });   // tab closed / DISCONNECT → stop spend

  // the "bus" writes one validated, REDACTED NDJSON line per event (key-shaped secrets are scrubbed even
  // if a tool ever echoes one back); makeEmitter validates against the frozen registry first.
  const bus = { emit: (name, payload) => { try { res.write(JSON.stringify({ name, payload: redact(payload) }) + '\n'); } catch (_) {} } };
  const emit = makeEmitter(bus, e => { if (e && e.event !== 'tool.web') console.warn('[event]', e.kind, e.event, (e.errors || []).join(';')); });

  // all setup + the run live inside ONE try, so any failure becomes a clean agent.run.error + closed stream
  try {
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
    // P1.5: the real informed-consent broker replaces the allow-all stub. Autonomous surface ⇒ default-deny
    // on any ungranted mutation (silence is not consent); read-only/non-network auto-allows; the hardline
    // floor sits below Full Access. The live diegetic prompt (interactive surface) arrives with the WS bridge.
    const consent = makeConsentBroker({
      bypass: FULL_ACCESS, hardline: hardlineFloor, sessionKey: runId,
      grantsSession, grantsPermanent, persist: persistAllowlist,
      networkOf: (call) => !!resolved.networkCaps[call.name], surface: 'autonomous'
    });
    const capCtx = makeCapCtx(resolved, { emit, consent, timeoutMs: CAPS.toolTimeoutMs });

    // ---- provider + cost ----
    const provider = makeOpenRouterProvider({ fetch: globalThis.fetch, key });
    const cost = makeCostEngine({ priceOf: provider.priceOf });

    // a task needs tool calls — refuse a model we KNOW can't call tools, up front, with an actionable message
    // (supportsTools returns null when the catalog is cold, so this never false-refuses a real model).
    if (isTask && provider.supportsTools(model) === false) {
      emit('agent.run.start', { agentId, runId, trigger: 'directive', model });
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
        + 'Keep working across as many tool calls as the task needs; when it is fully done, give the Commander a clear '
        + 'final report of what you found/did and which files you saved.'
      : '';
    const sys = (system || '') + toolNote;
    const msgs = sys ? [{ role: 'system', content: sys }, ...messages] : messages.slice();

    await runAgentLoop({
      messages: msgs, provider, emit, cost, tools: toolDefs, dispatch, capCtx,
      limits: { maxIters: CAPS.maxIters, maxCostUsd: CAPS.maxCostUsd },
      signal: ac.signal, clock: { now: () => Date.now() },
      agentId, runId, model, trigger: 'directive',
      // rough initial estimate for the error classifier's context-overflow ratio; contextLimit is 0 until the
      // /models catalog warms, which (by design) disables the ratio so a bare 400 is never mislabelled.
      approxTokens: Math.ceil(JSON.stringify(msgs).length / 4), contextLimit: provider.contextLimit(model)
    });
  } catch (e) {
    try { emit('agent.run.error', { agentId, runId, message: 'sidecar failure: ' + ((e && e.message) || e), transient: false }); } catch (_) {}
  } finally {
    runs.delete(runId);
    grantsSession.delete(runId);     // drop this run's session-scoped grants
    try { res.end(); } catch (_) {}
  }
}

async function handleCancel(req, res) {
  let runId;
  try { runId = (JSON.parse(await readBody(req, 4096)) || {}).runId; } catch (e) {}
  const ac = runId && runs.get(runId);
  if (ac) ac.abort();
  res.writeHead(200); res.end('ok');
}

/* ------------------------------- helpers ------------------------------- */
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
