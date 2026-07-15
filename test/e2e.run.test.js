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
const { bootToken } = require('./_httpToken.js');
const fs = require('fs');
const { spawn } = require('child_process');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

// ---- a mock OpenRouter: /models -> a minimal catalog; /chat/completions -> a short SSE completion ----
function startMockOpenRouter() {
  const requests = [];   // H1.2: capture each request's messages so a test can assert what reached the provider
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const write = () => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ', world' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          };
          // DRIPFEED sentinel: a LONG slow stream (40 chunks × 150ms ≈ 6s) so a test can kill the client
          // socket mid-generation and observe the sidecar noticing. res 'close' stops the drip (req 'close'
          // fires at message completion on Node ≥15 — the very trap the F1 disconnect test guards).
          if (body.indexOf('DRIPFEED') >= 0) {
            let i = 0;
            const t = setInterval(() => {
              try {
                if (res.writableEnded || res.destroyed) { clearInterval(t); return; }
                if (i < 40) { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'drip ' } }] }) + '\n\n'); i++; }
                else {
                  clearInterval(t);
                  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 40, total_tokens: 44 } }) + '\n\n');
                  res.write('data: [DONE]\n\n'); res.end();
                }
              } catch (_) { clearInterval(t); }
            }, 150);
            res.on('close', () => clearInterval(t));
            return;
          }
          // SLOWPOKE sentinel: stall before answering so the sidecar's run stream sits event-silent — the
          // window the NDJSON keep-alive heartbeat must cover.
          if (body.indexOf('SLOWPOKE') >= 0) setTimeout(write, 300); else write();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
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
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_STREAM_KA_MS: '40' };   // fast heartbeat so the KA test observes it in ms, not 20s
  const { child, port } = await boot(8840 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    // a bootstrapped API token is required for privileged /api routes (api-hardening).
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');

    // drive a real streaming run and collect the NDJSON event stream
    const res = await fetch(B + '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
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
    const firstReq = mock.requests[0] || {};
    const firstSystem = (((firstReq.messages || [])[0] || {}).content) || '';
    A.ok(firstSystem.indexOf('[RUNTIME]') >= 0, 'runtime identity block reaches the provider system prompt');
    A.ok(firstSystem.indexOf('Provider: openrouter') >= 0, 'runtime block names the selected provider');
    A.ok(firstSystem.indexOf('Requested model at run start: test/model') >= 0, 'runtime block names the requested model');
    A.ok(firstSystem.indexOf('If the Commander asks what model') >= 0, 'runtime block tells the agent to answer model/provider questions from host state');

    // H1.1: the run's full dialogue was persisted to the durable transcript (not just title+final) — fetch it back.
    const tr = await (await fetch(B + '/api/transcript?stream=global&agent=e2e&limit=20', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const turns = (tr && tr.turns) || [];
    A.ok(turns.some(t => t.role === 'user' && t.content === 'hi'), 'transcript captured the user directive');
    A.ok(turns.some(t => t.role === 'assistant' && String(t.content).indexOf('Hello') >= 0), 'transcript captured the assistant reply turn');

    // H1.2: bulletproof resume — a 2nd run on the SAME stream with EMPTY history must seed the prior dialogue.
    async function drive(streamId, text) {
      const r = await fetch(B + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e', streamId, messages: [{ role: 'user', content: text }] }) });
      const rd = r.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; }   // drain
    }
    await drive('s1', 'remember alpha-token-42');   // run A: establishes the s1 transcript
    await drive('s1', 'what was it');               // run B: EMPTY history, same stream -> must seed run A back
    const lastReq = mock.requests[mock.requests.length - 1];
    const seeded = JSON.stringify((lastReq && lastReq.messages) || []);
    A.ok(seeded.indexOf('alpha-token-42') >= 0, 'H1.2: run B (empty history) seeded the prior turn from the transcript');
    A.ok(seeded.indexOf('what was it') >= 0, 'run B still carries its own new directive last');

    // H3.2: the RUNS history rows carry their streamId — the join that lets a row open its transcript.
    const runsJson = await (await fetch(B + '/api/runs?agent=e2e&limit=20', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    A.ok((runsJson.runs || []).some(r => r.streamId === 's1'), 'H3.2: a RUNS row records its streamId (joins outcome -> transcript)');

    // ---- NDJSON keep-alive heartbeat (2026-07-07 multi-agent escape): while the run produces no events
    //      (provider stalled / a long tool like team.dispatch), the stream must NOT go byte-silent — blank
    //      lines prove the socket is alive, and every consumer skips them. SLOWPOKE stalls the mock 300ms
    //      with KA at 40ms, so heartbeats MUST appear between events; the run must still parse clean. ----
    {
      const r = await fetch(B + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e-ka', messages: [{ role: 'user', content: 'SLOWPOKE say hi' }] }) });
      const rd = r.body.getReader(); const dc = new TextDecoder(); let raw = '';
      while (true) { const { value, done } = await rd.read(); if (done) break; raw += dc.decode(value, { stream: true }); }
      const kaLines = raw.split('\n').filter(l => l.trim() === '').length;
      A.ok(kaLines >= 2, 'blank keep-alive lines rode the stream during the silent provider stall (got ' + kaLines + ')');
      const evs = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      A.ok(evs.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), 'the heartbeated run still streams and completes clean');
    }

    // ---- diagnostics error tail SURVIVES A RESTART (2026-07-07 escape: run failed -> user restarted ->
    //      "Recent errors: (none recorded this session)" — the one artifact that explained the failure was
    //      RAM-only). Provoke a recorded run error (same-agent mutex), reboot on the same workspace, and
    //      the error must still be in the report. ----
    {
      const drive2 = (agentId, text) => fetch(B + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId, messages: [{ role: 'user', content: text }] }) });
      const slow = drive2('dup-agent', 'SLOWPOKE hold the desk');            // holds dup-agent in flight ~300ms
      await new Promise(r => setTimeout(r, 60));                            // let the first run be admitted
      const clash = await drive2('dup-agent', 'collide');                    // same agent -> run.error (mutex)
      await clash.text(); await (await slow).text();                         // drain both
      const d1 = await (await fetch(B + '/api/diagnostics', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.ok(d1.text.indexOf('already running a task') >= 0, 'the run error is in this session\'s diagnostics tail');
    }

    // ---- F1 escape (2026-07-14 adversarial sweep): a client that VANISHES mid-stream (reload / tab close /
    //      crash) must cancel the run PROMPTLY. Before the fix, handleRun attached req.on('close') AFTER
    //      readBody() had consumed the request — Node ≥15 emits req 'close' at message completion, so the
    //      listener never fired: the abandoned run streamed on unwatched (real-provider spend), held the
    //      same-agent mutex for minutes ("already running" with nothing visible), and the reloaded COMMS
    //      claimed the turn failed while the harness was still driving it. The fix listens on res 'close'. ----
    {
      const hdr = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
      // raw http.request so the CLIENT socket is destroyable mid-stream (fetch cannot half-kill a socket)
      const seen = await new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('no stream data before destroy')), 8000);
        const rq = http.request({ host: HOST, port: port, path: '/api/run', method: 'POST', headers: hdr }, (rs) => {
          let n = 0;
          rs.on('data', () => { n++; if (n >= 2) { clearTimeout(guard); rq.destroy(); resolve(n); } });
          rs.on('error', () => {});
        });
        rq.on('error', () => {});   // ECONNRESET after our own destroy is expected noise
        rq.end(JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e-dc', messages: [{ role: 'user', content: 'DRIPFEED long answer' }] }));
      });
      A.ok(seen >= 2, 'the doomed run really streamed to the client before the client vanished');
      // the abandoned run must settle into the durable log as CANCELLED within seconds (not minutes, not never)
      let settled = null;
      for (let i = 0; i < 40 && !settled; i++) {
        await new Promise(r => setTimeout(r, 250));
        const rows = (await (await fetch(B + '/api/runs?agent=e2e-dc&limit=10', { headers: { 'X-StarNet-Token': token, Origin: B } })).json()).runs || [];
        settled = rows.find(r => String(r.title || '').indexOf('DRIPFEED') >= 0) || null;
      }
      A.ok(!!settled, 'the abandoned run settled into runs.jsonl within 10s of the disconnect');
      A.eq(settled && settled.reason, 'cancelled', 'the abandoned run settled honestly as cancelled');
      // and the same-agent mutex is FREE: a new run on the same agent admits and completes immediately
      const r2 = await fetch(B + '/api/run', { method: 'POST', headers: hdr,
        body: JSON.stringify({ key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e-dc', messages: [{ role: 'user', content: 'hi again' }] }) });
      const rd2 = r2.body.getReader(); const dc2 = new TextDecoder(); let raw2 = '';
      while (true) { const { value, done } = await rd2.read(); if (done) break; raw2 += dc2.decode(value, { stream: true }); }
      A.ok(raw2.indexOf('already running a task') < 0, 'no mutex ghost: the agent is not "already running" after its watcher died');
      const evs2 = raw2.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      A.ok(evs2.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), 'the follow-up run on the same agent completes clean');
    }
  } finally {
    try { child.kill(); } catch (_) {}
  }

  // reboot the sidecar on the SAME workspace: the persisted diag tail must come back.
  {
    const boot2 = await boot(8890 + (process.pid % 50), env, 20);
    const B2 = 'http://' + HOST + ':' + boot2.port;
    try {
      const token2 = await bootToken(B2, B2);
      const d2 = await (await fetch(B2 + '/api/diagnostics', { headers: { 'X-StarNet-Token': token2, Origin: B2 } })).json();
      A.ok(d2.text.indexOf('already running a task') >= 0, 'RESTART-SAFE: the error tail survived the sidecar restart (diag.errors.json)');
      A.ok(d2.text.indexOf('(none recorded)') < 0, 'the report no longer claims an empty tail after restart');
    } finally {
      try { boot2.child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
    }
  }
  A.report('e2e.run.test');
})().catch(e => { console.error(e); process.exit(1); });
