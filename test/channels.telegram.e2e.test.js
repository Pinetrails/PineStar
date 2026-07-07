/* node test/channels.telegram.e2e.test.js - true sidecar proof for Telegram ingress.

   Boots the actual sidecar process with a fake Telegram Bot API and fake OpenRouter.
   A direct message enters through getUpdates, drives the real runOnce host, replies via
   sendMessage, mirrors lifecycle to SSE, and persists the headless transcript. */
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

function startMockOpenRouter() {
  const requests = [];
  // gate lets the snapshot test HOLD a completion in-flight: when armed, the handler writes the first delta (so
  // agent.run.start has fired and the hub run is registered in inflight) then AWAITS release() before the finishing
  // chunk. Default = not armed (instant reply) so every other flow is unchanged. `started` resolves when a held
  // completion has emitted its first delta — the point at which the run is provably in-flight.
  const gate = { armed: false, _release: null, _startedResolve: null, started: null };
  gate.arm = () => { gate.armed = true; gate.started = new Promise(r => { gate._startedResolve = r; }); };
  gate.release = () => { const r = gate._release; gate._release = null; if (r) r(); };
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', async () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Telegram answer' } }] }) + '\n\n');
          if (gate.armed) {
            gate.armed = false;   // hold only the FIRST completion after arming
            await new Promise(r => { gate._release = r; if (gate._startedResolve) gate._startedResolve(); });
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, gate, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function startMockTelegram() {
  const calls = [];
  const sends = [];
  const queued = [];
  const waiters = [];
  let updateId = 1000;
  let messageId = 2000;

  function respond(res, obj) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    } catch (_) {}
  }

  function flush() {
    while (queued.length && waiters.length) {
      const w = waiters.shift();
      respond(w.res, { ok: true, result: [queued.shift()] });
    }
  }

  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const method = String(req.url || '').split('/').pop();
      const body = await readJsonBody(req);
      calls.push({ method, body });

      if (method === 'deleteWebhook') {
        respond(res, { ok: true, result: true });
        return;
      }
      if (method === 'getUpdates') {
        if (body.offset === -1) {
          respond(res, { ok: true, result: [] });
          return;
        }
        if (queued.length) {
          respond(res, { ok: true, result: [queued.shift()] });
          return;
        }
        const waiter = { res };
        waiters.push(waiter);
        req.on('close', () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
        });
        return;
      }
      if (method === 'sendMessage') {
        sends.push(body);
        respond(res, { ok: true, result: { message_id: ++messageId } });
        return;
      }
      respond(res, { ok: false, error_code: 404, description: 'unknown method' });
    });
    server.listen(0, HOST, () => {
      resolve({
        calls,
        sends,
        base: 'http://' + HOST + ':' + server.address().port,
        pushText(chatId, userId, text) {
          queued.push({
            update_id: ++updateId,
            message: {
              message_id: ++messageId,
              date: Math.floor(Date.now() / 1000),
              chat: { id: chatId, type: 'private' },
              from: { id: userId, username: 'commander' },
              text
            }
          });
          flush();
        },
        close(done) {
          while (waiters.length) respond(waiters.shift().res, { ok: true, result: [] });
          server.close(done || (() => {}));
        }
      });
    });
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

async function waitUntil(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;   // await so an async predicate (e.g. a snapshot fetch) is honored, not truthy-Promise-passed
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegram();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-telegram-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base,
    STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-telegram-fake',
    STARNET_OPENROUTER_KEY: 'sk-or-v1-telegram-fake',
    SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_TELEGRAM_TOKEN: 'TESTTOKEN',
    STARNET_TELEGRAM_TOKEN: 'TESTTOKEN',
    SKYNET_TELEGRAM_API_BASE: tg.base,
    STARNET_TELEGRAM_API_BASE: tg.base
  };
  const { child, port } = await boot(8960 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    sse = await startSseCollector(B + '/api/channels/events?token=' + encodeURIComponent(token));

    await waitUntil(() => tg.calls.some(c => c.method === 'getUpdates' && c.body && c.body.offset === -1), 5000, 'telegram drop-pending poll');
    tg.pushText(4242, 99, 'research AI trend now');

    await waitUntil(() => tg.sends.length >= 1, 8000, 'telegram sendMessage reply');
    A.eq(tg.sends[0].chat_id, '4242', 'reply sent to the inbound chat');
    A.ok(String(tg.sends[0].text || '').indexOf('Telegram answer') >= 0, 'reply text came from the mocked provider');
    A.ok(llm.requests.length >= 1, 'mock provider was called from Telegram ingress');

    await sse.waitFor(events => events.some(e => e.name === 'workitem.placed' && e.payload && e.payload.kind === 'telegram' && e.payload.agentId === 'tg_4242'), 5000, 'telegram workitem');
    await sse.waitFor(events => events.some(e => e.name === 'channel.inbound' && e.payload && e.payload.channel === 'telegram' && e.payload.chatId === '4242' && e.payload.agentId === 'tg_4242'), 5000, 'channel inbound');
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'tg_4242' && e.payload.trigger === 'event'), 5000, 'SSE run start');
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'tg_4242'), 5000, 'SSE run end');
    await sse.waitFor(events => events.some(e => e.name === 'channel.delivery' && e.payload && e.payload.channel === 'telegram' && e.payload.chatId === '4242' && e.payload.ok === true), 5000, 'channel delivery');

    const tr = await (await fetch(B + '/api/transcript?stream=global&agent=tg_4242&limit=20', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
    const turns = (tr && tr.turns) || [];
    A.ok(turns.some(t => t.role === 'user' && String(t.content || '').indexOf('research AI trend now') >= 0), 'transcript captured Telegram user turn');
    A.ok(turns.some(t => t.role === 'assistant' && String(t.content || '').indexOf('Telegram answer') >= 0), 'transcript captured Telegram assistant reply');

    // ---- P1 1.2: a live channel run must appear in GET /api/state/snapshot so an SSE reconnect keeps its agent's
    // floor/HUD state (reconcileFromSnapshot clears any agent NOT listed). Drive a SECOND message on a fresh chat,
    // HOLD it in-flight via the mock gate, prove the snapshot lists it (attributed + sourced 'telegram'), then
    // release and prove it's gone once the run ends — exactly tracking the hub's inflight lifecycle. ----
    const snapshot = async () => {
      const r = await fetch(B + '/api/state/snapshot', { headers: { 'X-StarNet-Token': token, Origin: B } });
      A.eq(r.status, 200, 'GET /api/state/snapshot -> 200');
      return r.json();
    };
    // baseline: with the first run long settled, no channel run is listed.
    const base = await snapshot();
    A.ok(Array.isArray(base.runs) && !base.runs.some(x => x && x.agentId === 'tg_4243'), 'snapshot has no tg_4243 run before the second message');

    llm.gate.arm();                                  // the NEXT completion holds after its first delta
    tg.pushText(4243, 99, 'hold this run please');   // a fresh chat -> agentId tg_4243, its own run
    await llm.gate.started;                           // resolves once the held completion emitted its first delta (run is provably in-flight)
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'tg_4243'), 5000, 'second SSE run start');

    // WHILE HELD: the snapshot lists this live channel run, attributed to the acting agent and sourced 'telegram'.
    const during = await snapshot();
    const live = (during.runs || []).find(x => x && x.agentId === 'tg_4243');
    A.ok(!!live, 'a live Telegram hub run IS listed in the snapshot while in-flight');
    A.eq(live.source, 'telegram', "the channel run's source is 'telegram'");
    A.ok(typeof live.runId === 'string' && live.runId.length > 0, 'the listed channel run carries a runId');
    A.ok(typeof live.startedAt === 'number' && during.ts >= live.startedAt, "the run's startedAt is a real server timestamp (<= snapshot ts)");

    llm.gate.release();                              // let the held completion finish
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'tg_4243'), 5000, 'second SSE run end');
    // AFTER IT ENDS: the run drops out of the snapshot (inflight cleared in the hub's finally) — no phantom clock.
    await waitUntil(async () => { const s = await snapshot(); return !(s.runs || []).some(x => x && x.agentId === 'tg_4243'); }, 5000, 'tg_4243 run leaves the snapshot after it ends');

    // ---- P2 supersede race: a SECOND message to the SAME busy chat must NOT be silently dropped on the transient
    // "already running a task" refusal. Repro: HOLD run #1 for chat 5555 in-flight (slot held), then send message #2
    // to 5555 — the hub aborts #1 and immediately starts #2, which loses the same-agent workspace-mutex race in the
    // host (index.js concurrencyGate.inFlight>0) and is refused TRANSIENTLY. The hub must RETRY with backoff until
    // #1's aborted run releases the slot, then deliver #2's real answer — never the raw mutex refusal to the user. --
    const sendsToChatBefore = tg.sends.filter(s => String(s.chat_id) === '5555').length;
    A.eq(sendsToChatBefore, 0, 'no prior reply to chat 5555');

    llm.gate.arm();                                  // run #1 will HOLD after its first delta (keeps its slot)
    tg.pushText(5555, 99, 'first message — will be held and superseded');
    await llm.gate.started;                           // run #1 is provably in-flight (slot held) now
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'tg_5555'), 5000, 'run #1 start (tg_5555)');

    // SECOND message to the SAME chat: aborts #1, then races the still-held workspace slot -> transient refusal ->
    // the hub's bounded retry recovers once #1's abort frees the slot.
    tg.pushText(5555, 99, 'second message — should supersede and still get answered');

    // the user's SECOND message must EVENTUALLY get a real answer delivered to chat 5555 (the whole point of the fix).
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '5555' && String(s.text || '').indexOf('Telegram answer') >= 0), 12000, 'chat 5555 eventually gets the real answer for message #2');

    // TRUTHFUL TELEMETRY: the raw internal mutex message ("already running a task") must NEVER be delivered to the
    // user on ANY reply to chat 5555 — the fix converts that transient refusal into a retry (or, if it truly never
    // frees, an honest "still busy" reply), never a leaked internal string.
    const chat5555Replies = tg.sends.filter(s => String(s.chat_id) === '5555');
    A.ok(chat5555Replies.length >= 1, 'chat 5555 received at least one reply');
    A.ok(chat5555Replies.every(s => String(s.text || '').indexOf('already running a task') === -1), 'no reply to chat 5555 leaked the internal "already running a task" mutex message');

    // Prove the RETRY PATH actually engaged (not merely that the race happened not to fire): the transient
    // "already running a task" refusal is teed whole to the channels SSE feed (sse.js runTeeView), and it must be
    // FOLLOWED by a successful run.end for the same agent — i.e. the hub retried and recovered rather than giving up.
    const sawTransientRefusal = sse.events.some(e => e.name === 'agent.run.error' && e.payload
      && e.payload.agentId === 'tg_5555' && e.payload.transient === true
      && String(e.payload.message || '').indexOf('already running a task') >= 0);
    if (sawTransientRefusal) {
      await sse.waitFor(events => {
        // a run.end for tg_5555 that is NOT the aborted/error one: the recovered retry's clean finish.
        return events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'tg_5555' && e.payload.reason && e.payload.reason !== 'error');
      }, 8000, 'tg_5555 recovered with a successful run after the transient refusal (retry worked)');
      console.log('  · supersede race reproduced AND recovered (transient refusal -> retry -> real answer)');
    } else {
      // The race is timing-sensitive; if the slot happened to free before #2's admission, the message still got its
      // real answer above (the invariant that matters). Note it so the run log is honest about what was exercised.
      console.log('  · supersede race did not fire this run; #2 still delivered its real answer (invariant holds)');
    }
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => tg.close(resolve));
    try { llm.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('channels.telegram.e2e.test');
})().catch(e => { console.log('FAIL: channels.telegram.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
