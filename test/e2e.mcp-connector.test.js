/* node test/e2e.mcp-connector.test.js - real sidecar proof for MCP connectors.

   Boots the actual sidecar with a fake MCP HTTP server and fake OpenRouter.
   Configures the connector through /api/connectors, runs a manual routine, and
   proves the model can call the discovered MCP tool with SSE portal activity. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

function startMockMcp() {
  const calls = [];
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const msg = await readJsonBody(req);
      calls.push({ msg, headers: req.headers });
      const reply = (result, status) => {
        const headers = { 'Content-Type': 'application/json' };
        if (msg.method === 'initialize') headers['Mcp-Session-Id'] = 'sess-demo';
        res.writeHead(status || 200, headers);
        if ((status || 200) === 202) { res.end(); return; }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') {
        reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo-mcp' } });
        return;
      }
      if (msg.method === 'notifications/initialized') { reply({}, 202); return; }
      if (msg.method === 'tools/list') {
        reply({ tools: [{
          name: 'lookup',
          description: 'Lookup demo data',
          annotations: { readOnlyHint: true },
          inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }
        }] });
        return;
      }
      if (msg.method === 'tools/call') {
        const q = msg.params && msg.params.arguments && msg.params.arguments.query;
        reply({ content: [{ type: 'text', text: 'lookup result for ' + q }], isError: false });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
    });
    server.listen(0, HOST, () => resolve({ server, calls, url: 'http://' + HOST + ':' + server.address().port + '/mcp' }));
  });
}

function startMockOpenRouter() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [
          { id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
          { id: 'test/no-tools', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: [] }
        ] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = {}, msgs = [];
          try { parsed = JSON.parse(body); msgs = parsed.messages || []; } catch (_) {}
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          const hasToolResult = toolResults > 0;
          const hasMcpTool = (parsed.tools || []).some(t => t && t.function && t.function.name === 'mcp__demo__lookup');
          const hasInspectTool = (parsed.tools || []).some(t => t && t.function && t.function.name === 'station_inspect');
          const wantsInspect = msgs.some(m => m && m.role === 'user' && String(m.content || '').indexOf('SELF_INSPECT') >= 0);
          const messageContent = m => typeof (m && m.content) === 'string' ? m.content : JSON.stringify((m && m.content) || '');
          const hasInspectResult = msgs.some(m => m && m.role === 'tool' && /\"schemaVersion\":1/.test(messageContent(m)) && /\"scheduler\":/.test(messageContent(m)));
          // A conversation carrying this sentinel asks for FOUR connector calls in a row — the shape of the
          // reported repeated-approval bug. Sentinel-gated so every other scenario in this file is untouched.
          const wantsMany = msgs.some(m => m && m.role === 'user' && String(m.content || '').indexOf('FOURLOOKUPS') >= 0);
          requests.push(parsed);

          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (wantsInspect && hasInspectTool && !hasInspectResult) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'station_inspect_1', type: 'function', function: { name: 'station_inspect', arguments: '{}' } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else if (wantsInspect && hasInspectResult) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Harness snapshot checked.' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else if (wantsMany && hasMcpTool && toolResults < 4) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mcp_lookup_' + toolResults, type: 'function', function: { name: 'mcp__demo__lookup', arguments: JSON.stringify({ query: 'asset-' + toolResults }) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else if (!hasToolResult && hasMcpTool) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mcp_lookup', type: 'function', function: { name: 'mcp__demo__lookup', arguments: JSON.stringify({ query: 'alpha' }) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else if (!hasToolResult) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'MCP unavailable in autonomous run' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'MCP answer delivered' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function startSseCollector(url) {
  const ac = new AbortController();
  const events = [];
  const waiters = [];
  const res = await fetch(url, { signal: ac.signal });
  A.eq(res.status, 200, 'SSE feed opens with token');
  const reader = res.body.getReader();
  function notify() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      try {
        if (w.pred(events)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(events); }
      } catch (e) { waiters.splice(i, 1); clearTimeout(w.timer); w.reject(e); }
    }
  }
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || line[0] === ':') continue;
          if (line.indexOf('data:') === 0) {
            const raw = line.slice(5).trim();
            try { events.push(JSON.parse(raw)); notify(); } catch (_) {}
          }
        }
      }
    } catch (_) {}
  })();
  return {
    events,
    waitFor(pred, ms, label) {
      if (pred(events)) return Promise.resolve(events);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms);
        waiters.push({ pred, resolve, reject, timer });
      });
    },
    close() { try { ac.abort(); } catch (_) {} }
  };
}

async function readNdjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { events.push(JSON.parse(line)); } catch (_) {} }
    }
  }
  return events;
}

(async () => {
  const mcp = await startMockMcp();
  const llm = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mcp-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base,
    STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-mcp-fake',
    STARNET_OPENROUTER_KEY: 'sk-or-v1-mcp-fake',
    SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_DEFAULT_MODEL: 'test/model'
  };
  let booted = await boot(9020 + (process.pid % 50), env, 20);
  let child = booted.child;
  let port = booted.port;
  let B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    let token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // PL-06: a permanently-invalid transport URL is INPUT validation, not a failed connection.
    // It must be rejected before either the config or its bearer token reaches durable storage.
    const invalidSecret = 'mcp-invalid-scheme-secret';
    const invalid = await fetch(B + '/api/connectors', {
      method: 'POST', headers,
      body: JSON.stringify({ id: 'invalid-scheme', label: 'Invalid scheme', transport: 'http', url: 'file:///etc/passwd', token: invalidSecret })
    });
    A.eq(invalid.status, 400, 'non-http(s) connector URL is rejected as bad input');
    const invalidBody = await invalid.json();
    A.ok(invalidBody.ok === false && invalidBody.saved === false && invalidBody.code === 'INVALID_URL', 'invalid URL response explicitly says it was not saved');
    const afterInvalid = await (await fetch(B + '/api/connectors', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok(!(afterInvalid.connectors || []).some(c => c.id === 'invalid-scheme'), 'invalid connector is absent from the live/config projection');
    const connectorFile = path.join(ws, 'connectors', 'state.json');
    const invalidDisk = fs.existsSync(connectorFile) ? fs.readFileSync(connectorFile, 'utf8') : '';
    A.ok(invalidDisk.indexOf('invalid-scheme') < 0 && invalidDisk.indexOf(invalidSecret) < 0, 'invalid connector id and secret never reach disk');

    // A syntactically-valid endpoint may simply be offline. Saving that configuration is useful, but the
    // response must state BOTH facts so the panel never turns a successful save into an ambiguous 502.
    const unreachable = await fetch(B + '/api/connectors', {
      method: 'POST', headers,
      body: JSON.stringify({ id: 'offline-demo', label: 'Offline demo', transport: 'http', url: 'http://127.0.0.1:1/mcp', token: 'offline-secret', timeoutMs: 1000 })
    });
    A.eq(unreachable.status, 200, 'valid but unreachable connector returns a saved-state envelope');
    const unreachableBody = await unreachable.json();
    A.ok(unreachableBody.ok === false && unreachableBody.saved === true && unreachableBody.connected === false && unreachableBody.state === 'error', 'offline envelope distinguishes saved from connected');
    A.ok(/saved.*not connected/i.test(unreachableBody.error || ''), 'offline envelope explains saved-but-not-connected in plain language');

    const upsert = await fetch(B + '/api/connectors', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'demo', label: 'Demo MCP', transport: 'http', url: mcp.url, token: 'mcp-secret-token' })
    });
    A.eq(upsert.status, 200, 'configured MCP connector');
    const configured = await upsert.json();
    A.eq(configured.state, 'up', 'connector state is up');
    A.eq(configured.toolCount, 1, 'one MCP tool discovered');
    A.eq(configured.status.hasToken, true, 'connector status reports token presence');
    A.eq('token' in configured.status, false, 'connector status does not leak token value');

    const listed = await (await fetch(B + '/api/connectors', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok((listed.connectors || []).some(c => c.id === 'demo' && c.tools && c.tools.indexOf('lookup') >= 0), '/api/connectors lists the discovered MCP tool');

    // HARNESS SELF-KNOWLEDGE: plant all three mutable sources, then make a REAL /api/run call the
    // always-present station.inspect tool. The returned bytes must agree with the same live stores the
    // APIs above use — not a prompt summary or scripted fixture inside the tool.
    const cronCreate = await fetch(B + '/api/cron', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Inspect proof', prompt: 'report station health', schedule: 'every 1h', agentId: 'mcp-agent', model: 'test/model', provider: 'openrouter' })
    });
    A.eq(cronCreate.status, 200, 'planted one real routine for station.inspect');
    const failedRun = await fetch(B + '/api/run', {
      method: 'POST', headers,
      body: JSON.stringify({ key: 'sk-or-v1-mcp-fake', model: 'test/no-tools', agentId: 'inspect-agent', streamId: 'inspect-fail', isTask: true, messages: [{ role: 'user', content: 'plant one diagnostic failure' }] })
    });
    await failedRun.text();
    const inspectRun = await fetch(B + '/api/run', {
      method: 'POST', headers,
      body: JSON.stringify({ key: 'sk-or-v1-mcp-fake', model: 'test/model', agentId: 'inspect-agent', streamId: 'inspect-live', isTask: true, messages: [{ role: 'user', content: 'SELF_INSPECT the harness; do not guess' }] })
    });
    A.eq(inspectRun.status, 200, 'real run admitted the self-inspection request');
    await readNdjson(inspectRun);
    const inspectRequest = llm.requests.find(r => (r.messages || []).some(m => m && m.role === 'tool' && /\"schemaVersion\":1/.test(String(m.content || '')) && /\"scheduler\":/.test(String(m.content || ''))));
    const inspectAdvertised = llm.requests.filter(r => (r.messages || []).some(m => m && m.role === 'user' && String(m.content || '').indexOf('SELF_INSPECT') >= 0))
      .flatMap(r => (r.tools || []).map(t => t && t.function && t.function.name).filter(Boolean));
    const inspectTrace = llm.requests.filter(r => (r.messages || []).some(m => m && m.role === 'user' && String(m.content || '').indexOf('SELF_INSPECT') >= 0))
      .map(r => (r.messages || []).map(m => ({ role: m.role, name: m.name || '', calls: (m.tool_calls || []).map(c => c && c.function && c.function.name), content: String(m.content || '').slice(0, 120) })));
    A.ok(!!inspectRequest, 'the model received station.inspect and called it through the real wire-name boundary (advertised: ' + inspectAdvertised.join(',') + '; trace: ' + JSON.stringify(inspectTrace) + ')');
    A.ok(llm.requests.some(r => (r.tools || []).some(t => t && t.function && t.function.name === 'station_inspect')),
      'station.inspect is advertised under its provider-legal wire name');
    const inspectToolMessage = ((inspectRequest && inspectRequest.messages) || []).find(m => m && m.role === 'tool' && /\"scheduler\":/.test(String(m.content || '')));
    const inspectSnapshot = JSON.parse((inspectToolMessage && inspectToolMessage.content) || '{}');
    A.eq(inspectSnapshot.scheduler.status, 'confirmed', 'scheduler section is confirmed');
    A.eq(inspectSnapshot.scheduler.data.jobCount, 1, 'station.inspect saw the planted real routine');
    A.ok(inspectSnapshot.connectors.data.connected.some(c => c.id === 'demo' && c.state === 'up'), 'station.inspect saw the planted live MCP connector');
    A.ok(inspectSnapshot.diagnostics.data.errorCount >= 1, 'station.inspect saw the planted recorded provider error');
    A.ok(inspectSnapshot.diagnostics.data.recentErrors.some(e => /does not support tool calls/.test(e.message)), 'the planted error detail reached the bounded diagnostic tail');
    A.eq(inspectSnapshot.build.status, 'confirmed', 'the exact build section is confirmed from the version authority');
    A.eq(inspectSnapshot.runtime.data.agentId, 'inspect-agent', 'the snapshot identifies the live inspecting agent');

    // ── connector CATALOG (GET /api/connectors/catalog): the curated one-click browse route ──
    const catRes = await fetch(B + '/api/connectors/catalog', { headers: { 'X-StarNet-Token': token, Origin: B } });
    A.eq(catRes.status, 200, 'catalog route responds 200');
    const cat = await catRes.json();
    A.ok(Array.isArray(cat.groups) && cat.groups.length >= 1, 'catalog returns category groups');
    A.ok(Array.isArray(cat.connectors) && cat.connectors.length >= 10, 'catalog returns the seed connectors');
    const dw = cat.connectors.find(c => c.id === 'deepwiki');
    const notion = cat.connectors.find(c => c.id === 'notion');
    A.ok(dw && dw.installable === true, 'a no-auth connector (deepwiki) is installable today');
    A.ok(notion && notion.installable === false, 'an oauth connector (notion) is listed but NOT installable yet');
    A.ok(cat.connectors.every(c => !('token' in c)), 'catalog entries never carry a token');
    A.ok(cat.connectors.every(c => c.installed === false), 'nothing marked installed before we add a catalog id');
    // installing a connector whose id AND url match a catalog entry flips `installed`. Use the entry's REAL url +
    // enabled:false so no network connect happens; the config still records id+url for the cross-ref.
    const dwUrl = (cat.connectors.find(c => c.id === 'deepwiki') || {}).url;
    const addDw = await fetch(B + '/api/connectors', { method: 'POST', headers, body: JSON.stringify({ id: 'deepwiki', label: 'DeepWiki', transport: 'http', url: dwUrl, enabled: false }) });
    A.eq(addDw.status, 200, 'installed a connector by a catalog id+url');
    const cat2 = await (await fetch(B + '/api/connectors/catalog', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.eq((cat2.connectors.find(c => c.id === 'deepwiki') || {}).installed, true, 'catalog marks deepwiki installed after adding its real url (id+url cross-ref)');
    // TRUTHFUL TELEMETRY: a connector that reuses a catalog id but points at a FOREIGN url must NOT flip the vendor card
    await fetch(B + '/api/connectors', { method: 'POST', headers, body: JSON.stringify({ id: 'stripe', label: 'not stripe', transport: 'http', url: 'https://mcp.example.invalid/mcp', enabled: false }) });
    const cat3 = await (await fetch(B + '/api/connectors/catalog', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.eq((cat3.connectors.find(c => c.id === 'stripe') || {}).installed, false, 'a foreign-url id collision does NOT mark the vetted vendor card installed');

    // EL-3 PU-02: disabled connectors are durable MANAGEMENT state. They must remain visible after
    // restart even though they are deliberately absent from the live runtime/tool projection.
    // Before the fix, boot skips disabled configs and GET /api/connectors lists manager state only,
    // so both rows vanish while their config (and possible secret) remains on disk.
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => child.once('exit', resolve));
    booted = await boot(port, env, 20);
    child = booted.child;
    port = booted.port;
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    let afterRestart = { connectors: [] };
    for (let i = 0; i < 50; i++) {
      afterRestart = await (await fetch(B + '/api/connectors', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      if ((afterRestart.connectors || []).some(c => c.id === 'demo' && c.state === 'up')) break;
      await sleep(100);
    }
    const restartedDemo = (afterRestart.connectors || []).find(c => c.id === 'demo');
    const restartedDeepwiki = (afterRestart.connectors || []).find(c => c.id === 'deepwiki');
    const restartedStripe = (afterRestart.connectors || []).find(c => c.id === 'stripe');
    const restartedOffline = (afterRestart.connectors || []).find(c => c.id === 'offline-demo');
    A.ok(restartedDemo && restartedDemo.state === 'up', 'enabled connector rewarms after restart');
    A.ok(restartedDeepwiki && restartedDeepwiki.enabled === false, 'disabled catalog connector remains listed after restart');
    A.ok(restartedStripe && restartedStripe.enabled === false, 'disabled manual connector remains listed after restart');
    A.ok(restartedOffline && restartedOffline.enabled === true && restartedOffline.state === 'error' && restartedOffline.hasToken === true, 'valid offline connector remains durably saved and truthfully offline after restart');
    A.ok(!(afterRestart.connectors || []).some(c => c.id === 'invalid-scheme'), 'invalid-scheme connector remains absent after restart');
    A.ok(JSON.stringify(afterRestart).indexOf('mcp-secret-token') === -1, 'restart list never leaks a persisted connector token');
    A.ok(JSON.stringify(afterRestart).indexOf(invalidSecret) === -1, 'restart projection never contains the rejected secret');
    const restartDisk = fs.existsSync(connectorFile) ? fs.readFileSync(connectorFile, 'utf8') : '';
    A.ok(restartDisk.indexOf('invalid-scheme') < 0 && restartDisk.indexOf(invalidSecret) < 0, 'restart readback proves invalid connector and token were never persisted');

    sse = await startSseCollector(B + '/api/channels/events?token=' + encodeURIComponent(token));
    const create = await fetch(B + '/api/cron', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'MCP proof', prompt: 'use the demo connector lookup for alpha', schedule: 'every 1h', agentId: 'mcp-agent', model: 'test/model', provider: 'openrouter' })
    });
    A.eq(create.status, 200, 'created MCP proof routine');
    const job = (await create.json()).job;

    const run = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    A.eq(run.status, 200, 'Run Now returns a stream');
    const panel = await readNdjson(run);
    A.ok(!panel.some(e => e.name === 'agent.tool_call' && e.payload && e.payload.name === 'mcp__demo__lookup'), 'autonomous panel stream never calls an unknown external tool');
    A.ok(panel.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('').indexOf('MCP unavailable in autonomous run') >= 0, 'panel stream truthfully completes without MCP authority');
    A.ok(!mcp.calls.some(c => c.msg && c.msg.method === 'tools/call'), 'autonomous run never reaches the MCP server tool endpoint');
    A.ok(mcp.calls.some(c => c.headers && c.headers.authorization === 'Bearer mcp-secret-token'), 'MCP transport sent bearer token to the configured connector');
    const autonomousRequests = llm.requests.filter(r => (r.messages || []).some(m => m && m.role === 'user' && String(m.content || '').indexOf('use the demo connector lookup for alpha') >= 0));
    A.ok(autonomousRequests.length > 0 && autonomousRequests.every(r => !(r.tools || []).some(t => t.function && t.function.name === 'mcp__demo__lookup')), 'autonomous model request does not expose the unknown MCP tool');

    await sse.waitFor(events => events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'mcp-agent'), 5000, 'SSE run end');

    /* UNATTENDED CONNECTOR GRANT (2026-07-25) — the SAME routine shape, but the Commander ticked "let this
       routine use your connected tools". Everything above proves the ungranted default is unchanged; this
       proves the grant actually reaches the real MCP server, end to end, with nobody watching. */
    const mcpCallsBefore = mcp.calls.filter(c => c.msg && c.msg.method === 'tools/call').length;
    const grantedCreate = await fetch(B + '/api/cron', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'MCP granted', prompt: 'use the demo connector lookup for alpha', schedule: 'every 1h', agentId: 'mcp-agent', model: 'test/model', provider: 'openrouter', unattendedGrants: ['connectors'] })
    });
    A.eq(grantedCreate.status, 200, 'created a connector-granted routine');
    const grantedJob = (await grantedCreate.json()).job;
    A.ok(grantedJob.unattendedGrants.indexOf('connectors') >= 0, 'the connector grant persisted on the job');

    const grantedRun = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: grantedJob.id }) });
    A.eq(grantedRun.status, 200, 'granted Run Now returns a stream');
    const grantedPanel = await readNdjson(grantedRun);
    const grantedCall = grantedPanel.find(e => e.name === 'agent.tool_call' && e.payload && e.payload.name === 'mcp__demo__lookup');
    A.ok(grantedCall, 'a GRANTED unattended run calls the MCP tool');
    const grantedResult = grantedPanel.find(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === (grantedCall && grantedCall.payload.callId));
    A.ok(grantedResult && grantedResult.payload.ok === true, 'the MCP call SUCCEEDS (not withheld, not consent-denied)');
    A.ok(mcp.calls.filter(c => c.msg && c.msg.method === 'tools/call').length > mcpCallsBefore, 'the granted run genuinely reached the MCP server tool endpoint');
    A.ok(grantedPanel.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('').indexOf('MCP answer delivered') >= 0, 'the granted run completes using the MCP answer');
    // the grant is per-ROUTINE: the earlier ungranted job must still be refused if fired again.
    const reRun = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    const rePanel = await readNdjson(reRun);
    A.ok(!rePanel.some(e => e.name === 'agent.tool_call' && e.payload && e.payload.name === 'mcp__demo__lookup'),
      'the UNGRANTED routine is still refused after a granted one ran (the grant never leaks between routines)');

    /* ── THE WATCHED SURFACE: one popup, not one per call (repeated-approval fix, 2026-07-27) ──────────────
       Reported live: an agent doing four `get_draft_asset` reads asked for approval four times while the user
       kept clicking "Full access". Cause: the host-authority layer prompted per call and collapsed
       once/always/full to a boolean, so the grade was never recorded and the consent broker was skipped
       entirely. This drives the real /api/run stream and answers over the real POST /api/consent. */
    async function driveWatched(who, input, decision) {
      const res = await fetch(B + '/api/run', {
        method: 'POST', headers,
        // isTask:true is what makes the run advertise tools at all; the connector portal itself is
        // account-level, so composeOffice rides it onto the interactive office without a `placed` entry.
        body: JSON.stringify({ key: 'sk-or-v1-mcp-fake', model: 'test/model', agentId: who, isTask: true, messages: [{ role: 'user', content: input }] })
      });
      A.eq(res.status, 200, 'watched /api/run returns a stream');
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = '', runId = '';
      const prompts = [], calls = [], results = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.name === 'agent.run.start') runId = ev.payload.runId;
          if (ev.name === 'agent.tool_call' && ev.payload.name === 'mcp__demo__lookup') calls.push(ev.payload);
          if (ev.name === 'agent.tool_result') results.push(ev.payload);
          if (ev.name === 'permission.prompt') {
            prompts.push(ev.payload);
            fetch(B + '/api/consent', { method: 'POST', headers, body: JSON.stringify({ runId, promptId: ev.payload.promptId, decision }) }).catch(() => {});
          }
        }
      }
      return { prompts, calls, results };
    }

    // THE EXACT REPORTED CASE. Before the fix this was four popups for four calls, every "Full access" click
    // discarded. Ordering below matters: a DENY grants nothing, "Full access" is a per-AGENT blanket, and
    // "Always" is a GLOBAL standing grant — so each grade gets a fresh agent, and deny runs before always.
    const full = await driveWatched('mcp-agent', 'FOURLOOKUPS please read four theme assets', 'full');
    A.eq(full.calls.length, 4, 'the watched run made four connector tool calls');
    A.eq(full.prompts.length, 1, 'FOUR connector calls raise exactly ONE approval popup after "Full access"');
    A.eq(full.prompts[0].tool, 'mcp__demo__lookup', 'the one popup names the connector tool');
    A.eq(full.results.filter(r => r.ok === true).length, 4, 'all four connector calls succeeded under the single grant');

    // Full Access is per-AGENT and outlives the run (in memory, until restart) — so the NEXT run is silent too.
    const again = await driveWatched('mcp-agent', 'FOURLOOKUPS read them again', 'deny');
    A.eq(again.calls.length, 4, 'the follow-up run made four connector calls');
    A.eq(again.prompts.length, 0, 'a granted agent is not re-asked on its next run either');

    // The wildcard is now part of the REAL permissions authority surface, rather than invisible process state.
    const afterFullPermissions = await (await fetch(B + '/api/permissions', {
      headers: { 'X-StarNet-Token': token, Origin: B }
    })).json();
    const fullRow = (afterFullPermissions.blanket || []).find(b => b && b.agentId === 'mcp-agent');
    A.ok(fullRow && fullRow.key === 'blanket:mcp-agent', 'GET /api/permissions exposes the exact agent wildcard');
    A.eq(fullRow.scope, 'watched sessions, until the app restarts', 'the authority readout truthfully bounds Full Access to watched sessions');

    // ORIGINAL unattended escape: the same agent's ungranted routine must remain unable to call the connector,
    // even while its watched-session wildcard is live. Consent to a watched card is not cron/Telegram/night-shift consent.
    const unattendedAfterFull = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    const unattendedAfterFullPanel = await readNdjson(unattendedAfterFull);
    A.ok(!unattendedAfterFullPanel.some(e => e.name === 'agent.tool_call' && e.payload && e.payload.name === 'mcp__demo__lookup'),
      'a watched Full Access wildcard does NOT authorize the same agent\'s unattended routine');

    // The row's REVOKE door must remove the live process-lifetime authority, not merely repaint the panel.
    const revokeFullRes = await fetch(B + '/api/permissions/revoke', {
      method: 'POST', headers, body: JSON.stringify({ key: fullRow.key })
    });
    const revokeFull = await revokeFullRes.json();
    A.ok(revokeFullRes.status === 200 && revokeFull.ok === true && revokeFull.revoked === true,
      'POST /api/permissions/revoke withdraws the live wildcard');
    const afterRevokePermissions = await (await fetch(B + '/api/permissions', {
      headers: { 'X-StarNet-Token': token, Origin: B }
    })).json();
    A.ok(!(afterRevokePermissions.blanket || []).some(b => b && b.agentId === 'mcp-agent'),
      'the next authoritative permissions read no longer lists the revoked wildcard');
    const afterRevoke = await driveWatched('mcp-agent', 'FOURLOOKUPS after revoke', 'deny');
    A.ok(afterRevoke.prompts.length >= 1, 'the same watched agent is asked again after REVOKE');
    A.eq(afterRevoke.results.filter(r => r.ok === true).length, 0, 'a denied post-revoke run performs no connector action');

    // A DENY still refuses — the fix records a yes, it never invents one. Fresh agent: no blanket in play.
    const denied = await driveWatched('mcp-agent-deny', 'FOURLOOKUPS deny this one', 'deny');
    A.ok(denied.prompts.length >= 1, 'an ungranted agent is still asked');
    A.eq(denied.results.filter(r => r.ok === true).length, 0, 'no denied connector call ever performed an action');
    A.ok(denied.results.some(r => r.ok === false), 'the denied connector call comes back as a refusal');

    /* "Always" — the narrower grade: one standing grant on the danger CLASS (capability:scope) that the
       Commander can SEE and revoke, which a one-shot answer never was. Runs last: it persists globally. */
    const alwaysRun = await driveWatched('mcp-agent-always', 'FOURLOOKUPS read the four assets again', 'always');
    A.eq(alwaysRun.calls.length, 4, 'the "always" run also made four connector calls');
    A.eq(alwaysRun.prompts.length, 1, '"Always" is likewise asked once, not once per call');
    A.eq(alwaysRun.results.filter(r => r.ok === true).length, 4, 'all four calls succeeded under the standing grant');
    const perms = await (await fetch(B + '/api/permissions', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok(JSON.stringify(perms).indexOf('mcp:demo') >= 0, 'the "Always" grant is visible in the Permissions panel, so it can be revoked');

    const remove = await fetch(B + '/api/connectors/remove', { method: 'POST', headers, body: JSON.stringify({ id: 'demo' }) });
    const removed = await remove.json();
    A.ok(remove.status === 200 && removed.saved === true && removed.removed === true, 'connector removal returns one verified durable result');
    const removedDisk = JSON.parse(fs.readFileSync(connectorFile, 'utf8'));
    A.ok(!(removedDisk.configs || []).some(c => c.id === 'demo'), 'connector removal read-back has no matching config');
    A.ok(!(removedDisk.oauth && removedDisk.oauth.byId && removedDisk.oauth.byId.demo), 'connector removal read-back has no matching OAuth credential');
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mcp.server.close(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('e2e.mcp-connector.test');
})().catch(e => { console.log('FAIL: e2e.mcp-connector.test threw - ' + (e && e.stack || e)); process.exit(1); });
