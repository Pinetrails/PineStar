/* node test/e2e.run.test.js — TRUE end-to-end: boot the ACTUAL sidecar process and drive a streaming run over
   HTTP through the real loop/provider/cost/SSE path, with the upstream LLM mocked via SKYNET_OPENROUTER_BASE.
   This is the gap the readiness sweep flagged: every other suite is unit/replay-level; nothing booted the real
   server AND streamed a run. Here we POST /api/run and assert the NDJSON carries agent.run.start, agent.token
   deltas, a reconciled agent.cost, and exactly one agent.run.end{reason:'done'} — no real key, no network. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

// ---- a mock OpenRouter: /models -> a minimal catalog; /chat/completions -> a short SSE completion ----
function startMockOpenRouter() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ', world' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// spawn the real sidecar; resolve once it logs its listen URL. Retries the next port on EADDRINUSE.
function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base };
  const { child, port } = await boot(8840 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    // a session token is required for the privileged POST /api/run (api-hardening).
    const sess = await fetch(B + '/api/session', { method: 'POST', headers: { Origin: B } });
    const token = String((await sess.json()).token || '');
    A.ok(token.length >= 32, 'got a session API token');

    // drive a real streaming run and collect the NDJSON event stream
    const res = await fetch(B + '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skynet-Token': token, Origin: B },
      body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e', messages: [{ role: 'user', content: 'hi' }] })
    });
    A.eq(res.status, 200, 'POST /api/run streams (200)');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', events = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (line) { try { events.push(JSON.parse(line)); } catch (_) {} }
      }
    }
    const names = events.map(e => e.name);
    A.ok(names.indexOf('agent.run.start') >= 0, 'stream begins with agent.run.start');
    const tokens = events.filter(e => e.name === 'agent.token');
    A.ok(tokens.length >= 1, 'real token deltas streamed from the mocked provider');
    A.ok(tokens.map(t => t.payload.delta).join('').indexOf('Hello') >= 0, 'the streamed text is the mock completion');
    const cost = events.filter(e => e.name === 'agent.cost').pop();
    A.ok(cost && cost.payload.reconciled === true, 'a reconciled agent.cost is emitted');
    const ends = events.filter(e => e.name === 'agent.run.end');
    A.eq(ends.length, 1, 'exactly one agent.run.end');
    A.eq(ends[0].payload.reason, 'done', 'the run completes with reason done');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
  }
  A.report('e2e.run.test');
})().catch(e => { console.error(e); process.exit(1); });
