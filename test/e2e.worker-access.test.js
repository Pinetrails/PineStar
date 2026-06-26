/* node test/e2e.worker-access.test.js — proves M4: a delegated worker has the SAME access as the orchestrator.
   Boots the REAL sidecar (Full Access lead) with a mock OpenRouter that makes the lead team.dispatch a worker,
   and makes that WORKER call fs.write — a consent-gated mutation an old autonomous worker was hard-DENIED. We then
   assert the file actually landed on disk, proving the worker inherited the lead's full-access consent broker.
   No real key/model/browser. NOT in test:fast (child-process boot); run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');
const fs = require('fs');
const { spawn } = require('child_process');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const WORKER_MARK = 'WORKER_SYS_MARKER';

// mock OpenRouter. Distinguishes the LEAD run from the WORKER run by the system-prompt marker, and the FIRST turn
// of each from the SECOND by whether a tool result is already in the messages. Lead: dispatch → done. Worker:
// fs.write → wrote.
function startMockOpenRouter() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let msgs = []; try { msgs = (JSON.parse(body).messages) || []; } catch (_) {}
          const sys = (msgs[0] && msgs[0].role === 'system') ? String(msgs[0].content || '') : '';
          const isWorker = sys.indexOf(WORKER_MARK) >= 0;
          const hasToolResult = msgs.some(m => m && m.role === 'tool');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          const text = (t) => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); };
          if (isWorker) {
            if (!hasToolResult) tool('w_write', 'fs_write', { path: 'proof.txt', content: 'PROOF_OK' });
            else text('wrote proof.txt');
          } else {
            if (!hasToolResult) tool('l_disp', 'team_dispatch', { workers: [{ agentId: 'worker-1', prompt: 'write a file named proof.txt' }] });
            else text('delegation complete');
          }
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

// recursively hunt for a file by name under dir; return its contents or null.
function findFile(dir, name) {
  let hit = null;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { const r = findFile(p, name); if (r != null) return r; }
    else if (ent.name === name) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } }
  }
  return hit;
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-waccess-'));
  // SKYNET_FULL_ACCESS = the lead is in full-auto; the worker shares that broker → its fs.write is allowed.
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_FULL_ACCESS: '1' };
  const { child, port } = await boot(8930 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // register the worker on the roster (so team.dispatch can find it) with a detectable system marker
    const roster = await fetch(B + '/api/roster', { method: 'POST', headers: H, body: JSON.stringify({ agents: [
      { agentId: 'worker-1', system: WORKER_MARK + ' — you are a worker. Do exactly as asked.', name: 'WORKER', model: 'test/model', provider: 'openrouter', approvalMode: 'ask' }
    ] }) });
    A.eq(roster.status, 200, 'POST /api/roster registers the worker');

    // drive the lead; the mock makes it dispatch the worker, and the worker write a file
    const res = await fetch(B + '/api/run', {
      method: 'POST', headers: H,
      body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: 'have a worker write proof.txt' }] })
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

    // the lead's own run completed cleanly
    const ends = events.filter(e => e.name === 'agent.run.end' && (!e.payload.runId || true));
    A.ok(events.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), 'the run completed (reason done)');

    // THE PROOF: the worker actually wrote the file — a consent-gated mutation a plain autonomous worker is DENIED.
    // It only succeeds because the worker shared the lead's FULL-ACCESS consent broker (same access as the orchestrator).
    const proof = findFile(ws, 'proof.txt');
    A.ok(proof !== null, 'the worker actually wrote proof.txt to the workspace (consent-gated write succeeded)');
    A.ok(proof && proof.indexOf('PROOF_OK') >= 0, 'the written file has the worker-supplied content');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
  }
  A.report('e2e.worker-access.test');
})().catch(e => { console.error(e); process.exit(1); });
