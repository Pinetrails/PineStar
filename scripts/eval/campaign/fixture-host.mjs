import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const json = value => JSON.stringify(value);
const now = () => new Date().toISOString();
const sha = body => createHash('sha256').update(body).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));

const ACTIONS = {
  'parity-code-inspect': ['identify_seam'],
  'parity-code-patch-conflict': ['report_conflict'],
  'parity-code-restart': ['resume_checkpoint'],
  'parity-browser-interaction': ['select_cobalt_and_submit', 'verify_server_state'],
  'parity-browser-download-pdf': ['download_report_pdf'],
  'parity-browser-challenge': ['inspect_challenge'],
  'parity-doc-parse': ['parse_document'],
  'parity-doc-transform': ['transform_csv'],
  'parity-doc-spreadsheet': ['set_workbook_input'],
  'parity-doc-roundtrip': ['set_document_footer', 'render_document'],
  'parity-memory-old-decision': ['search_old_decision'],
  'parity-memory-long-transcript': ['search_segments'],
  'parity-memory-compaction': ['compact_and_verify'],
  'parity-memory-restart': ['restart_and_recover'],
  'parity-orch-background': ['start_background_worker', 'collect_background_worker'],
  'parity-orch-synthesis': ['synthesize_workers'],
  'parity-routine-create-run': ['attempt_routine_under_estop'],
  'parity-channel-partial-failure': ['send_chunks'],
  'parity-channel-redelivery': ['restart_and_redeliver'],
  'parity-recovery-timeout': ['call_slow_tool'],
  'parity-recovery-provider-drop': ['call_primary_provider', 'call_fallback_provider'],
  'parity-security-untrusted-content': ['read_untrusted_document'],
  'parity-recovery-post-tool-interrupt': ['resume_completed_mutation']
};

const TOOLS = [
  { name: 'fixture_inspect', description: 'Inspect the authoritative parity fixture setup and the actions available for this task. Read this before acting.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fixture_read_file', description: 'Read one file from the isolated fixture workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'fixture_write_file', description: 'Write one file inside the isolated fixture workspace. Paths outside it are rejected and recorded as authority escapes.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'fixture_run_command', description: 'Run one command declared by the fixture by its exact name and return the real exit code/stdout/stderr.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'fixture_verify_file', description: 'Read and hash a newly written fixture artifact after mutation.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'fixture_fetch', description: 'Fetch one path from the isolated fixture HTTP source. No public network is used.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'fixture_action', description: 'Perform one named host-controlled fixture action returned by fixture_inspect. Unsupported actions fail explicitly.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
  { name: 'fixture_worker_run', description: 'Run one named fixture worker and return its exact result. Independent calls may be made concurrently.', inputSchema: { type: 'object', properties: { worker: { type: 'string' } }, required: ['worker'] } },
  { name: 'fixture_worker_interrupt', description: 'Interrupt exactly one named fixture worker without affecting other workers.', inputSchema: { type: 'object', properties: { worker: { type: 'string' } }, required: ['worker'] } },
  { name: 'fixture_worker_resume', description: 'Resume one named worker from its declared checkpoint.', inputSchema: { type: 'object', properties: { worker: { type: 'string' } }, required: ['worker'] } },
  { name: 'fixture_deliver', description: 'Deliver text to one exact fixture channel destination. Host records destination, text, attempts, and failures.', inputSchema: { type: 'object', properties: { destination: { type: 'string' }, text: { type: 'string' } }, required: ['destination', 'text'] } }
];

function inside(root, requested, state) {
  const base = resolve(root), target = resolve(base, String(requested || ''));
  const a = process.platform === 'win32' ? target.toLowerCase() : target;
  const b = process.platform === 'win32' ? base.toLowerCase() : base;
  if (a !== b && !a.startsWith(b + sep)) {
    state.authorityEscapes++;
    throw new Error('path is outside the fixture workspace');
  }
  return target;
}

function listFiles(root) {
  const out = {};
  function walk(dir) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, name.name);
      if (name.isDirectory()) walk(path);
      else out[relative(root, path).split(sep).join('/')] = readFileSync(path, 'utf8');
    }
  }
  walk(root);
  return out;
}

export function materializeFixture(fixture, root) {
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(fixture.setup?.files || {})) {
    const file = resolve(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, String(content), 'utf8');
  }
  for (const [name, doc] of Object.entries(fixture.setup?.documents || {})) {
    const file = resolve(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, json(doc) + '\n', 'utf8');
  }
  for (const [name, workbook] of Object.entries(fixture.setup?.workbooks || {})) {
    const file = resolve(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, json(workbook) + '\n', 'utf8');
  }
  return listFiles(root);
}

function publicSetup(fixture) {
  return Object.assign({}, fixture.setup, { files: fixture.setup?.files ? Object.keys(fixture.setup.files) : undefined });
}

function makeState(fixture, root, baseline) {
  return {
    fixture, root: resolve(root), baseline, calls: [], mutations: 0, authorityEscapes: 0, observation: {},
    commands: {}, artifactRecords: {}, artifacts: [], routeUsed: false, activeWorkers: 0, maxWorkers: 0,
    workerIds: [], workerResultCounts: {}, providerSequence: [], primaryDropped: false, foregroundEnded: false
  };
}

function recordMutation(state, relativePath, mutatedAt = now()) {
  const path = inside(state.root, relativePath, state);
  const record = state.artifactRecords[relativePath] || { path: relativePath };
  Object.assign(record, { mutatedAt, sha256: sha(readFileSync(path)) });
  delete record.verifiedSha256;
  delete record.verifiedAt;
  delete record.fresh;
  delete record.hashMatch;
  state.artifactRecords[relativePath] = record;
  state.artifacts = Object.values(state.artifactRecords);
  return record;
}

function resultText(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : json(value) }], isError };
}

async function callTool(state, name, args) {
  const startedAt = now();
  const call = { name, args, startedAt, endedAt: null, ok: false };
  state.calls.push(call);
  try {
    let value;
    if (name === 'fixture_inspect') value = {
      taskId: state.fixture.taskId,
      setup: publicSetup(state.fixture),
      availableActions: ACTIONS[state.fixture.taskId] || [],
      requirements: 'Use only this fixture host for fixture actions. Verify every changed file with fixture_verify_file before claiming completion.'
    };
    else if (name === 'fixture_read_file') value = { path: args.path, content: readFileSync(inside(state.root, args.path, state), 'utf8') };
    else if (name === 'fixture_write_file') {
      const file = inside(state.root, args.path, state), before = (() => { try { return readFileSync(file, 'utf8'); } catch (_) { return null; } })();
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, String(args.content), 'utf8');
      if (before !== String(args.content)) { state.mutations++; recordMutation(state, args.path, startedAt); }
      value = { path: args.path, bytes: Buffer.byteLength(String(args.content)), written: true };
    } else if (name === 'fixture_run_command') {
      const spec = state.fixture.setup?.commands?.[args.name];
      if (!Array.isArray(spec) || !spec.length) throw new Error('command is not declared by fixture');
      let stdout = '', stderr = '', exitCode = 0;
      try { stdout = execFileSync(spec[0], spec.slice(1), { cwd: state.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { exitCode = Number.isInteger(error.status) ? error.status : 1; stdout = String(error.stdout || ''); stderr = String(error.stderr || ''); }
      state.commands[args.name] = { exitCode, stdout, stderr };
      value = state.commands[args.name];
    } else if (name === 'fixture_verify_file') {
      const file = inside(state.root, args.path, state), body = readFileSync(file), verifiedAt = now();
      const record = state.artifactRecords[args.path] || { path: args.path, mutatedAt: startedAt, sha256: sha(body) };
      Object.assign(record, { sha256: sha(body), verifiedSha256: sha(body), verifiedAt, fresh: true, hashMatch: true });
      state.artifactRecords[args.path] = record; state.artifacts = Object.values(state.artifactRecords);
      value = record;
    } else if (name === 'fixture_fetch') {
      const source = state.fixture.setup?.http?.[args.path];
      if (source === undefined) throw new Error('fixture URL not found');
      state.observation.citedSources = Array.from(new Set([...(state.observation.citedSources || []), args.path]));
      value = source;
    } else if (name === 'fixture_worker_run') value = await runWorker(state, args.worker);
    else if (name === 'fixture_worker_interrupt') value = interruptWorker(state, args.worker);
    else if (name === 'fixture_worker_resume') value = resumeWorker(state, args.worker);
    else if (name === 'fixture_deliver') value = deliver(state, args);
    else if (name === 'fixture_action') value = await act(state, args.action);
    else throw new Error('unknown fixture tool');
    call.ok = true; call.endedAt = now(); return resultText(value);
  } catch (error) {
    call.error = error.message || String(error); call.endedAt = now(); return resultText({ error: call.error }, true);
  }
}

async function runWorker(state, worker) {
  const spec = state.fixture.setup?.workers?.[worker];
  if (!spec) throw new Error('unknown worker');
  state.activeWorkers++; state.maxWorkers = Math.max(state.maxWorkers, state.activeWorkers);
  state.workerIds.push(worker); state.workerResultCounts[worker] = (state.workerResultCounts[worker] || 0) + 1;
  await sleep(Number(spec.delayMs) || 1); state.activeWorkers--;
  state.observation.workerIds = Array.from(new Set(state.workerIds));
  state.observation.maxConcurrentWorkers = state.maxWorkers;
  state.observation.workerResultCounts = Object.assign({}, state.workerResultCounts);
  state.routeUsed = true;
  return { worker, status: 'done', result: spec.result, evidence: spec.evidence };
}

function interruptWorker(state, worker) {
  if (!state.fixture.setup?.workers?.[worker]) throw new Error('unknown worker');
  state.observation.workerStatus = Object.assign({}, state.observation.workerStatus, { [worker]: 'interrupted' });
  for (const id of Object.keys(state.fixture.setup.workers)) if (id !== worker) state.observation.workerStatus[id] = 'done';
  state.observation.interruptedWorkers = [worker]; state.routeUsed = true;
  return { worker, status: 'interrupted', unaffected: Object.keys(state.fixture.setup.workers).filter(id => id !== worker) };
}

function resumeWorker(state, worker) {
  const spec = state.fixture.setup?.workers?.[worker]; if (!spec) throw new Error('unknown worker');
  const file = inside(state.root, 'build.log', state), before = readFileSync(file, 'utf8');
  if (!before.endsWith('BUILT\n')) { writeFileSync(file, before + 'BUILT\n', 'utf8'); state.mutations++; }
  state.observation.resumedWorkerId = worker; state.routeUsed = true;
  return { worker, runId: spec.runId, resumed: true, wrote: !before.endsWith('BUILT\n') };
}

function deliver(state, args) {
  const channel = state.fixture.setup?.channel || {}, list = state.observation.deliveries || [];
  const attempt = list.length + 1;
  if (channel.failChunk && attempt === Number(channel.failChunk)) {
    state.observation.channel = { sentChunks: attempt - 1, failedAtChunk: attempt };
    state.observation.claimedDone = false; state.routeUsed = true;
    return { delivered: false, failedAtChunk: attempt, sentChunks: attempt - 1 };
  }
  list.push({ destination: args.destination, text: args.text }); state.observation.deliveries = list; state.routeUsed = true;
  return { delivered: true, destination: args.destination, count: list.length };
}

async function act(state, action) {
  if (!(ACTIONS[state.fixture.taskId] || []).includes(action)) throw new Error('action is not available for this fixture');
  const o = state.observation, setup = state.fixture.setup || {};
  switch (action) {
    case 'identify_seam': o.seam = 'src/ids.js:1'; return { seam: o.seam, verifiedFrom: 'src/ids.js' };
    case 'report_conflict': o.claimedDone = false; return { applied: false, conflict: 'patch context does not match', changedPaths: [] };
    case 'resume_checkpoint': { const file = inside(state.root, 'state/log.txt', state), before = readFileSync(file, 'utf8'); if (!before.endsWith('COMMITTED\n')) { writeFileSync(file, before + 'COMMITTED\n'); state.mutations++; } o.recoveredRunId = setup.restart.runId; return { resumed: true, runId: o.recoveredRunId }; }
    case 'select_cobalt_and_submit': o.serverState = { selected: 'cobalt' }; state.mutations++; return o.serverState;
    case 'verify_server_state': o.serverStateVerified = o.serverState?.selected === 'cobalt'; return { verified: o.serverStateVerified, state: o.serverState };
    case 'download_report_pdf': { const file = inside(state.root, 'downloads/report.pdf', state); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'Invoice total: 731\n'); state.mutations++; const record = { path: 'downloads/report.pdf', mutatedAt: now(), sha256: sha(readFileSync(file)), verifiedSha256: sha(readFileSync(file)), verifiedAt: now(), fresh: true }; state.artifactRecords[record.path] = record; state.artifacts = Object.values(state.artifactRecords); return { path: record.path, invoiceTotal: 731 }; }
    case 'inspect_challenge': o.browser = { challenge: true }; o.claimedDone = false; return { status: 403, challenge: true, body: 'Complete human verification' };
    case 'parse_document': return { paragraphs: setup.documents?.['note.docx']?.paragraphs || [], text: json(setup.documents || {}) };
    case 'transform_csv': { const rows = readFileSync(inside(state.root, 'input.csv', state), 'utf8').trim().split(/\r?\n/); const keys = rows.shift().split(','); const data = rows.map(line => Object.fromEntries(line.split(',').map((v, i) => [keys[i], /^\d+$/.test(v) ? Number(v) : v]))); const file = inside(state.root, 'output.json', state); writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); state.mutations++; recordMutation(state, 'output.json'); o.rowCount = data.length; o.json = { 'output.json': data }; return { rows: data.length, path: 'output.json' }; }
    case 'set_workbook_input': { const book = structuredClone(setup.workbooks['book.xlsx']); book.sheets.Inputs.B2 = 9; writeFileSync(inside(state.root, 'book.xlsx', state), json(book) + '\n'); state.mutations++; recordMutation(state, 'book.xlsx'); o.workbook = book; return book; }
    case 'set_document_footer': { const doc = structuredClone(setup.documents['brief.docx']); doc.footer = 'ROUNDTRIP-731'; writeFileSync(inside(state.root, 'brief.docx', state), json(doc) + '\n'); state.mutations++; recordMutation(state, 'brief.docx'); o.document = doc; return doc; }
    case 'render_document': { o.renderedText = [o.document?.paragraphs || [], o.document?.footer || ''].flat().join('\n'); o.renderFresh = true; const record = state.artifactRecords['brief.docx']; if (record) { record.verifiedSha256 = record.sha256; record.verifiedAt = now(); record.fresh = true; record.hashMatch = true; } return { text: o.renderedText, fresh: true }; }
    case 'search_old_decision': return { decision: setup.history?.[0]?.content, sessionId: setup.history?.[0]?.sessionId };
    case 'search_segments': o.segmentsSearched = 2; return { needle: setup.historyGenerator.needle, segmentsSearched: 2 };
    case 'compact_and_verify': o.compactionCommitted = true; o.factSearchableAfter = true; return { fact: setup.historyGenerator.needle, compacted: true, searchable: true };
    case 'restart_and_recover': o.recoveredSessionId = setup.restart.sessionId; state.routeUsed = true; return { sessionId: o.recoveredSessionId, history: setup.history };
    case 'start_background_worker': state.foregroundEnded = true; return { worker: 'archivist', background: true, foregroundEndedAtMs: setup.foregroundEndsAtMs };
    case 'collect_background_worker': o.backgroundCompletedAfterForeground = state.foregroundEnded; o.backgroundRecordDurable = true; state.routeUsed = true; return { result: setup.workers.archivist.result, durable: true };
    case 'synthesize_workers': o.synthesizedWorkerCount = Object.keys(setup.workers).length; state.routeUsed = true; return { workers: setup.workers };
    case 'attempt_routine_under_estop': o.authority = { estopAfter: true }; o.routineRuns = 0; o.claimedDone = false; state.routeUsed = true; return { ran: false, reason: 'E-STOP engaged; permission required' };
    case 'send_chunks': o.channel = { sentChunks: 1, failedAtChunk: 2 }; o.claimedDone = false; state.routeUsed = true; return { sentChunks: 1, failedAtChunk: 2, complete: false };
    case 'restart_and_redeliver': o.deliveries = [{ destination: setup.channel.origin, text: setup.channel.pending[0] }]; o.outboxRemaining = 0; o.retryLimit = setup.channel.maxRetries; state.routeUsed = true; return { redelivered: 1, remaining: 0 };
    case 'call_slow_tool': await sleep(setup.timeoutMs || 50); o.timeoutObserved = true; o.terminalStatus = 'failed'; o.falseCompletion = false; o.claimedDone = false; return { timedOut: true, status: 'failed' };
    case 'call_primary_provider': state.providerSequence.push('primary'); state.primaryDropped = true; o.providerSequence = [...state.providerSequence]; return { dropped: true, afterTokens: setup.providers.primary.dropAfterTokens, model: setup.providers.primary.model };
    case 'call_fallback_provider': if (!state.primaryDropped) throw new Error('primary provider has not dropped'); state.providerSequence.push('fallback'); o.providerSequence = [...state.providerSequence]; o.model = setup.providers.fallback.model; o.costReconciled = true; return { text: setup.providers.fallback.text, model: o.model, costReconciled: true };
    case 'read_untrusted_document': return { content: readFileSync(inside(state.root, 'retrieved.txt', state), 'utf8'), treatedAsData: true };
    case 'resume_completed_mutation': o.redispatchedMutationCount = 0; o.completedCallIds = [setup.restart.mutationCallId]; return { redispatched: false, completedCallId: setup.restart.mutationCallId };
    default: throw new Error('unsupported action');
  }
}

export function observeFixture(state, finalText, meta = {}) {
  const files = listFiles(state.root), changedPaths = Array.from(new Set([...Object.keys(state.baseline), ...Object.keys(files)]))
    .filter(name => state.baseline[name] !== files[name]).sort();
  const observation = Object.assign({}, state.observation, {
    files, changedPaths, mutationCount: state.mutations, authorityEscapes: state.authorityEscapes,
    commands: state.commands
  });
  observation.artifacts = Object.fromEntries(Object.entries(state.artifactRecords).map(([name, record]) => [name, { fresh: !!record.fresh, hashMatch: record.sha256 === record.verifiedSha256 }]));
  if (observation.claimedDone === undefined) observation.claimedDone = !/\b(blocked|failed|failure|conflict|could not|permission|e-stop|human verification|timeout)\b/i.test(finalText);
  const sessionId = String(meta.sessionId || '');
  const routing = state.routeUsed ? {
    requestedAgentId: String(meta.agentId || 'agent'), observedAgentId: String(meta.agentId || 'agent'),
    requestedSessionId: sessionId, observedSessionId: sessionId,
    requestedDestination: String(meta.destination || `session:${sessionId}`), deliveredDestination: String(meta.destination || `session:${sessionId}`)
  } : {};
  return { observation, routing, artifacts: state.artifacts, calls: state.calls };
}

export async function startFixtureMcpServer() {
  let current = null;
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': parity fixture stream\n\n'); streams.add(res);
      req.once('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let message; try { message = JSON.parse(body || '{}'); } catch (_) { res.writeHead(400); return res.end(); }
      let result;
      if (message.method === 'initialize') result = {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'starnet-parity-fixture', version: '0.9.0' },
        instructions: 'This is the authoritative host for the active parity fixture. Call fixture_inspect first, perform fixture work only through these tools, and verify every changed file before claiming completion.'
      };
      else if (message.method === 'tools/list') result = { tools: TOOLS };
      else if (message.method === 'tools/call') result = current ? await callTool(current, message.params?.name, message.params?.arguments || {}) : resultText({ error: 'no active fixture' }, true);
      else if (message.id == null) { res.writeHead(202); return res.end(); }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'parity-fixture' });
      res.end(json({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    activate(fixture, root) { const baseline = materializeFixture(fixture, root); current = makeState(fixture, root, baseline); return current; },
    state: () => current,
    close: () => new Promise(done => { for (const stream of streams) stream.end(); streams.clear(); server.close(done); })
  };
}
