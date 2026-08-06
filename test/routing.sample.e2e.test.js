/* node test/routing.sample.e2e.test.js — real-sidecar proof for POST /api/routing/sample (guided
   workflow Phase 4: PROOF — run a sample job).

   What it locks, over real sockets against the REAL host (boot pattern per routing.persist.e2e.test.js,
   content-driven mock provider per comms-send.e2e.test.js — zero real spend, no keys):
     1. the route sits behind the same per-launch token gate as every /api route;
     2. NO ARMED PLAN → an honest 409 refusal ({ok:false,error}), and never a 404 — the finish-the-line
        card feature-detects the endpoint by exactly that difference;
     3. HAPPY PATH: the sample rides the REAL unaddressed dispatch path through a posted two-stage floor —
        the router picks the entry dock, the chain runner runs the downstream stage, the reply the line
        delivers is the LAST stage's, the recorded runs.jsonl rows are scoped by the sample's own streamId,
        and the workitem crates (with the additive sample:true marker, re-proven against shared/events
        validate()) ride the station bus;
     4. ONE IN FLIGHT per station: a concurrent second post refuses 409 while the first is riding;
     5. NO GRANTS PROPAGATION (the chain-grants law): a sample whose model tries a consent-gated mutation
        (shell.exec) is default-denied — the request body cannot smuggle unattendedGrants — and the line
        still delivers (a denial never gates the reply).

   In test/http.list (a child-process boot test does not gate test:fast). */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const Pipeline = require('../frontend/app/pipeline.js');
const Events = require('../shared/events.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Content-driven mock provider (a queue would desync — a real run also makes reflection/aux calls this test
   never asked for, and those would eat scripted turns). Same shape as comms-send.e2e.test.js. */
function startMockOpenRouter(script) {
  const requests = [];
  function decide(body) {
    const msgs = (body && body.messages) || [];
    if (msgs.some(m => m && m.role === 'tool')) return { text: 'done' };
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    const text = String((lastUser && lastUser.content) || '').toLowerCase();
    return script.find(r => text.indexOf(r.when) >= 0) || { text: 'nothing to do' };
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
          const turn = decide(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (turn.tool) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: turn.text } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
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
    // 20s upper bound (not a sleep): a cold boot on a loaded box (parallel agent gates) can blow 9s.
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 20000);
  });
}

// the station SSE bus — where the workitem crates the world draws actually ride (chanEmit → /api/channels/events)
async function startSseCollector(url) {
  const ac = new AbortController();
  const events = [];
  const res = await fetch(url, { signal: ac.signal });
  A.eq(res.status, 200, 'the station SSE feed opens');
  const reader = res.body.getReader();
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
          if (line.indexOf('data:') !== 0) continue;
          try { events.push(JSON.parse(line.slice(5).trim())); } catch (_) {}
        }
      }
    } catch (_) {}
  })();
  return {
    events,
    async settle(ms) { const end = Date.now() + (ms || 1500); while (Date.now() < end) { await sleep(50); } },
    close() { try { ac.abort(); } catch (_) {} }
  };
}

// a deployable two-stage floor: INTAKE -> research-agent -> writer-agent -> OUTBOX. Bay rooms carry a
// computer (the compute gate) + a workbench (projects the consent-gated shell.exec the grants probe needs).
// Both docks carry a STANDING BRIEF (step editor): the entry dock's must reach its run's system context,
// the downstream dock's must reach the handoff turn — asserted against the mock provider's recordings.
const ENTRY_BRIEF = 'Dig the sources and hand a clean evidence pack downstream.';
const HOP_BRIEF = 'Draft the final answer in press style.';
function twoStagePlan() {
  const belt = (x, y, dir) => ({ x, y, dir });
  const plan = Pipeline.compileRoutingPlan({
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent', brief: ENTRY_BRIEF },
            { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent', brief: HOP_BRIEF },
            { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
  });
  A.ok(Pipeline.ok(plan), 'fixture: the two-stage floor is deployable');
  A.eq((plan.chains['research-agent'] || {}).next, ['writer-agent'], 'fixture: the floor chains the two docks');
  A.eq(plan.bays.find(b => b.agentId === 'research-agent').brief, ENTRY_BRIEF, 'fixture: the compiled plan carries the entry brief');
  for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer', 'workbench'];
  return plan;
}

(async () => {
  const mock = await startMockOpenRouter([
    // order is load-bearing (script.find takes the FIRST match; later texts contain earlier phrases):
    { when: 'use the shell', tool: { name: 'shell.exec', args: { cmd: 'echo pwned' } } },
    { when: 'stage one findings', text: 'final sample answer' },   // the hop's handoff prompt carries stage one's output
    { when: 'sample job', text: 'stage one findings' }             // the entry dock's own turn
  ]);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-routing-sample-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    // deliberately NO dev mode: the sample seam is a first-class production route, not a DEV-gated one
    STARNET_DEV: '', SKYNET_DEV: '',
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-routing-sample-fake',
    SKYNET_DEFAULT_MODEL: 'test/model'
  };
  const { child, port } = await boot(9130 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const post = (body) => fetch(B + '/api/routing/sample', { method: 'POST', headers, body: JSON.stringify(body == null ? {} : body) })
      .then(r => r.json().then(j => ({ status: r.status, j })));

    /* ---- 1. the route is behind the SAME per-launch token gate as every /api route ---- */
    const bare = await fetch(B + '/api/routing/sample', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: '{}' });
    A.eq(bare.status, 403, 'no token -> 403 (the auth seam holds)');

    /* ---- 2. no armed plan -> an honest 409 refusal, never a 404 (the feature-detect contract) ---- */
    const noPlan = await post({});
    A.eq(noPlan.status, 409, 'no armed routing plan -> 409');
    A.ok(noPlan.j && noPlan.j.ok === false, 'the refusal says ok:false');
    A.ok(/no work line is armed/.test(String(noPlan.j.error || '')), 'the refusal names the real reason: ' + noPlan.j.error);

    /* ---- 3. HAPPY PATH through a posted two-stage floor ---- */
    const posted = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(twoStagePlan()) });
    A.eq(posted.status, 200, 'the two-stage floor deploys');
    sse = await startSseCollector(B + '/api/channels/events?token=' + encodeURIComponent(token));

    const happy = await post({});
    A.eq(happy.status, 200, 'the sample answers 200 after the line delivered');
    const h = happy.j;
    A.ok(h.ok === true && h.sample === true, 'the answer is marked as a sample');
    A.eq(h.isTask, true, 'the canned sample text classifies as a TASK (a crate rides the belt)');
    A.eq(h.agentId, 'research-agent', 'the ROUTER picked the entry dock (unaddressed dispatch, not a fallback)');
    A.ok(/^sample-/.test(String(h.streamId || '')), 'the sample runs under its own workstream: ' + h.streamId);
    A.ok(h.workitemId, 'the entry crate has a workitemId');
    A.ok((h.replies || []).some(t => String(t).indexOf('final sample answer') >= 0),
      'the DELIVERED reply is the LAST stage\'s text (the chain ran): ' + JSON.stringify(h.replies).slice(0, 200));
    A.eq((h.runs || []).length, 2, 'exactly two real runs were recorded (entry dock + one chain hop)');
    A.ok(h.runs.every(r => r.streamId === h.streamId), 'every recorded run carries the sample\'s streamId');
    A.ok(h.runs.every(r => r.reason === 'done'), 'both stages finished clean');
    A.ok(h.delivered && h.delivered.agentId === 'writer-agent', 'the delivering run is the LAST stage (writer-agent)');
    A.ok(typeof h.totalUsd === 'number' && isFinite(h.totalUsd), 'the sample reports its real total cost');

    /* ---- 3b. THE STANDING BRIEFS REACHED THE RUNS (step editor — execution truth, not UI copy).
       The mock provider recorded every request body; the ENTRY dock's brief must ride its run's SYSTEM
       context, and the RECEIVING dock's brief must ride the handoff turn's USER text (the shared
       Pipeline.handoffPrompt 5th param via the chain runner's stageBrief seam). ---- */
    const BRIEF_HDR = 'YOUR STANDING BRIEF FOR THIS STATION:';
    const lastUserOf = rq => { const m = [...((rq && rq.messages) || [])].reverse().find(x => x && x.role === 'user'); return String((m && m.content) || ''); };
    const sysOf = rq => ((rq && rq.messages) || []).filter(x => x && x.role === 'system').map(x => String(x.content || '')).join('\n');
    const entryReq = mock.requests.find(rq => lastUserOf(rq).indexOf('SAMPLE JOB') >= 0 && lastUserOf(rq).indexOf('PIPELINE HANDOFF') < 0);
    A.ok(entryReq, 'the entry dock\'s provider request was recorded');
    A.ok(sysOf(entryReq).indexOf(BRIEF_HDR + '\n' + ENTRY_BRIEF) >= 0,
      'the ENTRY dock\'s standing brief rode its run\'s system context: ' + sysOf(entryReq).slice(-160));
    const hopReq = mock.requests.find(rq => lastUserOf(rq).indexOf('PIPELINE HANDOFF') >= 0);
    A.ok(hopReq, 'the chain hop\'s provider request was recorded');
    A.ok(lastUserOf(hopReq).indexOf(BRIEF_HDR + '\n' + HOP_BRIEF) >= 0,
      'the RECEIVING dock\'s standing brief rode the handoff turn: ' + lastUserOf(hopReq).slice(0, 300));
    A.ok(lastUserOf(hopReq).indexOf('stage one findings') >= 0, 'alongside the upstream output (the turn still carries the work)');

    // the recorded rows are in the station's real run history too (the ledger/run-store path, not a claim)
    const runsApi = await fetch(B + '/api/runs?agent=*&limit=50', { headers }).then(r => r.json());
    for (const r of h.runs) {
      A.ok((runsApi.runs || []).some(x => x && x.runId === r.runId), 'run ' + r.runId + ' is in GET /api/runs');
    }

    // the crates the world draws rode the REAL station bus — entry crate marked sample:true, chain hop, delivery
    await sse.settle(1500);
    const placed = sse.events.filter(e => e.name === 'workitem.placed').map(e => e.payload || {});
    const deliveredEv = sse.events.filter(e => e.name === 'workitem.delivered').map(e => e.payload || {});
    const entry = placed.find(p => p.kind === 'sample');
    A.ok(entry, 'the entry crate (kind:sample) rode the station bus');
    A.eq(entry.queueId, 'research-agent', 'the entry crate queues at the routed dock');
    A.eq(entry.sample, true, 'the entry crate carries the additive sample:true marker');
    A.ok(placed.some(p => p.kind === 'chain' && p.agentId === 'writer-agent'), 'the chain hop placed its own crate at the downstream dock');
    const outDel = deliveredEv.find(p => p.finalQueueId === 'outbox');
    A.ok(outDel, 'the sample crate DELIVERED to the outbox');
    A.eq(outDel.sample, true, 'the delivery carries the sample:true marker too');
    // re-prove the schema law this marker leans on: obj() stanzas set no additionalProperties:false
    const v1 = Events.validate('workitem.placed', entry);
    const v2 = Events.validate('workitem.delivered', outDel);
    A.ok(v1.ok, 'workitem.placed with sample:true validates against the frozen contract: ' + JSON.stringify(v1.errors));
    A.ok(v2.ok, 'workitem.delivered with sample:true validates against the frozen contract: ' + JSON.stringify(v2.errors));

    /* ---- 4. ONE in flight per station ---- */
    const p1 = post({});
    await sleep(30);   // let the first post claim the lock in its synchronous slice
    const p2 = await post({});
    A.eq(p2.status, 409, 'a second sample while one is riding -> 409');
    A.ok(/already riding/.test(String((p2.j || {}).error || '')), 'the refusal says a sample is already riding: ' + (p2.j || {}).error);
    const r1 = await p1;
    A.eq(r1.status, 200, 'the FIRST sample still delivers (the refusal never killed it)');

    /* ---- 5. NO GRANTS PROPAGATION: a consent-gated mutation stays denied, body fields can't smuggle authority ---- */
    const before = mock.requests.length;
    const probe = await post({ text: 'SAMPLE JOB: use the shell to run the echo command now.', unattendedGrants: ['workbench'], grants: ['workbench'] });
    A.eq(probe.status, 200, 'the shell-probe sample still delivers (a denial never gates the reply)');
    const toolMsgs = [];
    for (const rq of mock.requests.slice(before)) {
      for (const m of ((rq && rq.messages) || [])) if (m && m.role === 'tool') toolMsgs.push(String(m.content || ''));
    }
    A.ok(toolMsgs.length >= 1, 'the model\'s shell.exec attempt produced a tool result the provider saw');
    A.ok(!toolMsgs.some(t => /pwned/.test(t)), 'the command NEVER executed — no unattended grant reached the sample run: ' + JSON.stringify(toolMsgs).slice(0, 300));
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('routing.sample.e2e.test');
})().catch(e => { console.log('FAIL: routing.sample.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
