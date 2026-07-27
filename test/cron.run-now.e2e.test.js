/* node test/cron.run-now.e2e.test.js - real sidecar proof for routine Run Now.

   This boots the actual sidecar, creates a routine, opens the station SSE feed,
   presses /api/cron/run, and proves the manual fire is visible in every layer:
   panel NDJSON, mocked provider request, workitem.placed, and run lifecycle SSE. */
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

function startMockOpenRouter() {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'AI news found' } }] }) + '\n\n');
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
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cron-run-now-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-run-now-fake',
    SKYNET_DEFAULT_MODEL: 'test/model'
  };
  const { child, port } = await boot(8910 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const create = await fetch(B + '/api/cron', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'AI news', prompt: 'gather relevant AI news', schedule: 'every 1h', agentId: 'research-agent', model: 'test/model', provider: 'openrouter' })
    });
    A.eq(create.status, 200, 'created routine');
    const job = (await create.json()).job;
    A.ok(job && job.id, 'routine id returned');

    sse = await startSseCollector(B + '/api/channels/events?token=' + encodeURIComponent(token));
    const run = await fetch(B + '/api/cron/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: job.id })
    });
    A.eq(run.status, 200, 'Run Now returns a stream');
    const panel = await readNdjson(run);
    const panelNames = panel.map(e => e.name);
    A.ok(panelNames.indexOf('agent.run.start') >= 0, 'panel stream includes agent.run.start');
    A.ok(panel.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('').indexOf('AI news found') >= 0, 'panel stream includes provider output');
    A.ok(panelNames.indexOf('agent.run.end') >= 0, 'panel stream includes agent.run.end');
    A.ok(mock.requests.length >= 1, 'mock provider was called');

    await sse.waitFor(events => events.some(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'research-agent' && e.payload.kind === 'cron'), 5000, 'cron workitem');
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'research-agent' && e.payload.trigger === 'schedule'), 5000, 'SSE run start');
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'research-agent'), 5000, 'SSE run end');

    /* RUN NOW MUST FIRE THE WHOLE WORK LINE, exactly like the scheduled fire. This route calls runOnce
       DIRECTLY, so it bypasses the cron driver's advanceChain seam — it shipped running four stages on
       schedule and ONE stage from the button (caught live 2026-07-27), the same "one routine, two
       behaviours" bug the slash-command redirect in this route already exists to prevent. */
    const Pipeline = require('../frontend/app/pipeline.js');
    const belt = (x, y, dir) => ({ x, y, dir });
    const plan = Pipeline.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent' },
              { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent' },
              { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
    });
    A.eq(plan.chains['research-agent'].next, ['writer-agent'], 'the drawn floor chains the two docks');
    for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer'];   // an unequipped bay grants no compute
    const posted = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(plan) });
    A.eq(posted.status, 200, 'the two-stage floor deploys');

    const callsBefore = mock.requests.length;
    const run2 = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    A.eq(run2.status, 200, 'Run Now returns a stream (second fire)');
    const panel2 = await readNdjson(run2);
    const starts = panel2.filter(e => e.name === 'agent.run.start').map(e => e.payload.agentId);
    A.ok(starts.indexOf('research-agent') >= 0, 'stage one ran');
    A.ok(starts.indexOf('writer-agent') >= 0, 'RUN NOW fired the DOWNSTREAM stage too (was one stage before)');
    A.ok(mock.requests.length >= callsBefore + 2, 'two provider calls — the line really bought both runs');
    await sse.waitFor(events => events.some(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'writer-agent' && e.payload.kind === 'chain'), 5000, 'the handoff rides as a chain crate');
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('cron.run-now.e2e.test');
})().catch(e => { console.log('FAIL: cron.run-now.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
