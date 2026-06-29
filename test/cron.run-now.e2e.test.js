/* node test/cron.run-now.e2e.test.js -- true Run Now regression test.

   Boots the real sidecar, points OpenRouter at a local mock, opens the same SSE stream world.js consumes,
   creates a routine, and POSTs /api/cron/run. This proves Run Now is not just a panel-local stream: it also
   places a cron work item and broadcasts schedule-triggered lifecycle events so the target agent visibly works. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startMockOpenRouter() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Run now worked' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
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
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, out: () => out }); }
      else if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

function makeSseCollector(base, token) {
  const ac = new AbortController();
  const events = [];
  const ready = fetch(base + '/api/channels/events?token=' + encodeURIComponent(token), { signal: ac.signal })
    .then(async res => {
      A.eq(res.status, 200, 'SSE event stream opens');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          buf += dec.decode(r.value, { stream: true });
          let cut;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
            const line = frame.split(/\r?\n/).find(x => x.indexOf('data: ') === 0);
            if (!line) continue;
            try { events.push(JSON.parse(line.slice(6))); } catch (_) {}
          }
        }
      } catch (e) {
        if (!ac.signal.aborted) throw e;
      }
    });
  return { events, ready, stop: () => ac.abort() };
}

async function collectNdjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) { try { events.push(JSON.parse(line)); } catch (_) {} }
    }
  }
  return events;
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cron-run-now-'));
  let booted = null;
  try {
    booted = await boot(9010 + (process.pid % 40), {
      SKYNET_WORKSPACES: ws,
      SKYNET_OPENROUTER_BASE: mock.base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-run-now-fake'
    }, 20);
    const base = 'http://' + HOST + ':' + booted.port;
    const token = await bootToken(base, base);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base };

    const sse = makeSseCollector(base, token);
    await sleep(50);

    const create = await fetch(base + '/api/cron', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Run Now AI brief', prompt: 'research current AI news', schedule: 'every 1h', agentId: 'research-agent', model: 'test/model', provider: 'openrouter' })
    });
    A.eq(create.status, 200, 'created the routine');
    const created = await create.json();
    const id = created && created.job && created.job.id;
    A.ok(!!id, 'created routine has an id');

    const run = await fetch(base + '/api/cron/run', {
      method: 'POST', headers,
      body: JSON.stringify({ id })
    });
    A.eq(run.status, 200, 'Run Now streams 200');
    const streamEvents = await collectNdjson(run);
    const streamNames = streamEvents.map(e => e.name);
    A.ok(streamNames.indexOf('agent.run.start') >= 0, 'Run Now panel stream includes agent.run.start');
    A.ok(streamEvents.some(e => e.name === 'agent.token' && /Run now worked/.test(String(e.payload && e.payload.delta || ''))), 'Run Now panel stream includes model output');
    A.ok(streamEvents.some(e => e.name === 'agent.run.end' && e.payload && e.payload.reason === 'done'), 'Run Now panel stream includes done');
    A.ok(mock.requests.length >= 1, 'mock provider received the routine run');

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const hasBox = sse.events.some(e => e.name === 'workitem.placed' && e.payload && e.payload.kind === 'cron' && e.payload.agentId === 'research-agent');
      const hasStart = sse.events.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'research-agent' && e.payload.trigger === 'schedule');
      const hasEnd = sse.events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'research-agent' && e.payload.reason === 'done');
      if (hasBox && hasStart && hasEnd) break;
      await sleep(25);
    }
    sse.stop();
    await sse.ready.catch(() => {});

    A.ok(sse.events.some(e => e.name === 'workitem.placed' && e.payload && e.payload.kind === 'cron' && e.payload.agentId === 'research-agent'), 'Run Now SSE places a cron work item for the target agent');
    A.ok(sse.events.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'research-agent' && e.payload.trigger === 'schedule'), 'Run Now SSE broadcasts schedule-triggered run start');
    A.ok(sse.events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'research-agent' && e.payload.reason === 'done'), 'Run Now SSE broadcasts run end');
  } finally {
    if (booted && booted.child) { try { booted.child.kill(); } catch (_) {} }
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('cron.run-now.e2e.test');
})().catch(e => { console.log('FAIL: cron.run-now.e2e.test threw -- ' + (e && e.stack || e)); process.exit(1); });
