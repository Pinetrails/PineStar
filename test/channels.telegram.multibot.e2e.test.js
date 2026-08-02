/* node test/channels.telegram.multibot.e2e.test.js - true sidecar proof for MULTI-BOT Telegram.

   Boots the actual sidecar with a TOKEN-AWARE fake Bot API (each /bot<TOKEN>/<method> is a separate bot
   with its own getMe identity, update queue and send log) plus a fake OpenRouter. Drives the REAL routes:
   a bad token is refused by the getMe probe, two extra bots are added and poll side by side with the
   station bot, each DM runs the bound agent (hard-lock) and replies + typing-indicates through its OWN
   token only, per-bot owner claim refuses a stranger, and disconnect stops exactly that bot's poller. */
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
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Bound answer' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
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

// token-aware fake Bot API: bots = { TOKEN: { id, username } }. Unknown token -> 401 (like real Telegram).
function startMockTelegramMulti(bots) {
  const perToken = {};   // TOKEN -> { calls, sends, actions, queued, waiters }
  for (const t of Object.keys(bots)) perToken[t] = { calls: [], sends: [], actions: [], queued: [], waiters: [] };
  let updateId = 1000, messageId = 2000;
  function respond(res, obj) { try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (_) {} }
  function flush(st) {
    while (st.queued.length && st.waiters.length) respond(st.waiters.shift().res, { ok: true, result: [st.queued.shift()] });
  }
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      const m = /^\/bot([^/]+)\/([^/?]+)/.exec(String(req.url || ''));
      if (!m) { res.writeHead(404); res.end(); return; }
      const token = m[1], method = m[2];
      const body = await readJsonBody(req);
      const known = bots[token];
      if (!known) { respond(res, { ok: false, error_code: 401, description: 'Unauthorized' }); return; }
      const st = perToken[token];
      st.calls.push({ method, body });
      if (method === 'getMe') { respond(res, { ok: true, result: { id: known.id, is_bot: true, first_name: known.username + ' Bot', username: known.username } }); return; }
      if (method === 'deleteWebhook') { respond(res, { ok: true, result: true }); return; }
      if (method === 'sendChatAction') { st.actions.push(body); respond(res, { ok: true, result: true }); return; }
      if (method === 'sendMessage') { st.sends.push(body); respond(res, { ok: true, result: { message_id: ++messageId } }); return; }
      if (method === 'getUpdates') {
        if (body.offset === -1) { respond(res, { ok: true, result: [] }); return; }
        if (st.queued.length) { respond(res, { ok: true, result: [st.queued.shift()] }); return; }
        // park like the real long-poll, but resolve EMPTY after a short timeout (the real API returns [] after
        // `timeout` seconds) — the adapter's honest-connect needs a completed round-trip to prove 'up'.
        const waiter = { res };
        st.waiters.push(waiter);
        const timer = setTimeout(() => { const i = st.waiters.indexOf(waiter); if (i >= 0) { st.waiters.splice(i, 1); respond(res, { ok: true, result: [] }); } }, 400);
        req.on('close', () => { clearTimeout(timer); const i = st.waiters.indexOf(waiter); if (i >= 0) st.waiters.splice(i, 1); });
        return;
      }
      respond(res, { ok: false, error_code: 404, description: 'unknown method' });
    });
    server.listen(0, HOST, () => resolve({
      perToken,
      base: 'http://' + HOST + ':' + server.address().port,
      pushText(token, chatId, userId, text) {
        const st = perToken[token];
        st.queued.push({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: userId, username: 'commander' }, text } });
        flush(st);
      },
      close(done) {
        for (const t of Object.keys(perToken)) while (perToken[t].waiters.length) respond(perToken[t].waiters.shift().res, { ok: true, result: [] });
        server.close(done || (() => {}));
      }
    }));
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

async function waitUntil(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + label);
}

const STATION = 'STATIONTOKEN', TOK_A = 'TOKAAA', TOK_B = 'TOKBBB';

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegramMulti({
    [STATION]: { id: 100, username: 'StationBot' },
    [TOK_A]: { id: 111, username: 'NovaBot' },
    [TOK_B]: { id: 222, username: 'ScoutBot' }
  });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tg-multibot-e2e-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-multibot-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-multibot-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_TELEGRAM_TOKEN: STATION, STARNET_TELEGRAM_TOKEN: STATION,
    SKYNET_TELEGRAM_API_BASE: tg.base, STARNET_TELEGRAM_API_BASE: tg.base
  };
  const { child, port } = await boot(9060 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const api = (method, url, body) => fetch(B + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));

    // station bot polling (auto-started from env)
    await waitUntil(() => tg.perToken[STATION].calls.some(c => c.method === 'getUpdates'), 5000, 'station bot polls');

    // ---- 1. bad token: the getMe probe refuses it with a clean 400; nothing persists ----
    const bad = await api('POST', '/api/channels/telegram/bots/connect', { token: 'NOTREAL', agentId: 'agent', model: 'test/model' });
    A.eq(bad.status, 400, 'unknown token -> 400');
    A.ok(/Telegram rejected/.test(bad.j.error || ''), 'refusal names the getMe failure');

    // ---- 2. the station bot token cannot double as an agent bot (one poller per token) ----
    const dupe = await api('POST', '/api/channels/telegram/bots/connect', { token: STATION, agentId: 'agent', model: 'test/model' });
    A.eq(dupe.status, 400, 'station token as agent bot -> 400');
    A.ok(/station bot/.test(dupe.j.error || ''), 'refusal explains it IS the station bot');

    // ---- 3. add TWO agent bots; each starts polling with its OWN token ----
    const addA = await api('POST', '/api/channels/telegram/bots/connect', { token: TOK_A, agentId: 'agent', agentName: 'NOVA', model: 'test/model' });
    A.eq(addA.status, 200, 'bot A added');
    A.eq(addA.j.botId, '111', 'bot A keyed by its getMe id');
    A.eq(addA.j.username, 'NovaBot', 'bot A username surfaced');
    const addB = await api('POST', '/api/channels/telegram/bots/connect', { token: TOK_B, agentId: 'scout_1', agentName: 'SCOUT', model: 'test/model' });
    A.eq(addB.status, 200, 'bot B added');
    A.eq(addB.j.botId, '222', 'bot B keyed by its getMe id');
    await waitUntil(() => tg.perToken[TOK_A].calls.some(c => c.method === 'getUpdates'), 5000, 'bot A polls');
    await waitUntil(() => tg.perToken[TOK_B].calls.some(c => c.method === 'getUpdates'), 5000, 'bot B polls');

    // status: both listed, connected (first poll round-trip proves 'up')
    await waitUntil(async () => {
      const st = (await api('GET', '/api/channels/telegram/status')).j;
      const bots = st.bots || [];
      return bots.length === 2 && bots.every(b => b.connected === true);
    }, 5000, 'both bots CONNECTED in status');

    // Each bot has its own explicit local-to-Telegram owner enrollment. First DM is not authority.
    const pairBot = async (botId, botToken) => {
      const pair = await api('POST', '/api/channels/telegram/bots/' + botId + '/owner/pair', {});
      A.eq(pair.status, 200, 'bot ' + botId + ' issued an owner pairing code');
      A.ok(/^[-A-Z0-9]{11}$/.test(String(pair.j.code || '')), 'bot ' + botId + ' pairing code shape');
      tg.pushText(botToken, 900, 77, '/pair ' + pair.j.code);
      await waitUntil(() => tg.perToken[botToken].sends.some(s => String(s.chat_id) === '900' && /Owner paired/i.test(String(s.text || ''))), 8000, 'bot ' + botId + ' pairing acknowledgement');
    };
    await pairBot('111', TOK_A);
    await pairBot('222', TOK_B);
    const botBSendsBeforeA = tg.perToken[TOK_B].sends.length;
    const stationSendsBeforeA = tg.perToken[STATION].sends.length;

    // ---- 4. DM bot A: hard-locked run as its bound agent; typing + reply through TOKEN A ONLY ----
    tg.pushText(TOK_A, 900, 77, 'do a thing');
    await waitUntil(() => tg.perToken[TOK_A].sends.some(s => String(s.chat_id) === '900' && String(s.text || '').indexOf('Bound answer') >= 0), 8000, 'bot A replies');
    const botAReply = tg.perToken[TOK_A].sends.find(s => String(s.chat_id) === '900' && String(s.text || '').indexOf('Bound answer') >= 0);
    A.ok(String(botAReply.text || '').indexOf('Bound answer') >= 0, 'bot A reply came from the provider');
    A.eq(String(botAReply.chat_id), '900', 'bot A replied to its own chat');
    A.ok(tg.perToken[TOK_A].actions.some(a => a.action === 'typing' && String(a.chat_id) === '900'), 'bot A showed the typing indicator during the run');
    A.eq(tg.perToken[TOK_B].sends.length, botBSendsBeforeA, 'bot B sent NOTHING for bot A\'s chat (no cross-talk)');
    A.eq(tg.perToken[STATION].sends.length, stationSendsBeforeA, 'the station bot sent NOTHING for bot A\'s chat');
    // hard-lock: the durable CHANNEL history landed under the BOUND agent, not a tg_<chatId> fallback.
    // (read the channel store straight from disk — /api/transcript serves per-STREAM history, not per-agent.)
    const chanHist = (agentId) => {
      try { return (JSON.parse(fs.readFileSync(path.join(ws, 'channels', agentId + '.history.json'), 'utf8')).messages || []); }
      catch (_) { return []; }
    };
    A.ok(chanHist('agent').some(t => t.role === 'user' && String(t.content || '').indexOf('do a thing') >= 0), 'bot A turn persisted under the BOUND agent (hard-lock)');
    A.eq(chanHist('tg_900').length, 0, 'no tg_<chatId> fallback agent was created for bot A\'s chat');

    // ---- 5. DM bot B — SAME chatId (Telegram private chatId == userId, identical across bots): isolated ----
    tg.pushText(TOK_B, 900, 77, 'scout task here');
    await waitUntil(() => tg.perToken[TOK_B].sends.some(s => String(s.chat_id) === '900' && String(s.text || '').indexOf('Bound answer') >= 0), 8000, 'bot B replies');
    const botBReply = tg.perToken[TOK_B].sends.find(s => String(s.chat_id) === '900' && String(s.text || '').indexOf('Bound answer') >= 0);
    A.eq(String(botBReply.chat_id), '900', 'bot B replied in its own chat');
    A.ok(tg.perToken[TOK_B].actions.some(a => a.action === 'typing'), 'bot B typing indicator fired too');
    A.ok(chanHist('scout_1').some(t => t.role === 'user' && String(t.content || '').indexOf('scout task here') >= 0), 'bot B turn persisted under ITS bound agent');
    A.ok(!chanHist('scout_1').some(t => String(t.content || '').indexOf('do a thing') >= 0), 'bot A\'s chat never bled into bot B\'s agent');

    // ---- 6. per-bot owner claim: user 77 claimed bot A above; a STRANGER's DM is refused before any run ----
    const aSendsBefore = tg.perToken[TOK_A].sends.length;
    tg.pushText(TOK_A, 999, 88, 'stranger trying to use the bot');
    await sleep(1200);   // enough for a poll cycle; an admitted message would have replied well within this
    A.eq(tg.perToken[TOK_A].sends.length, aSendsBefore, 'a non-owner DM to bot A got NO reply (owner-locked)');
    // ...while the owner still works
    tg.pushText(TOK_A, 900, 77, 'owner again');
    await waitUntil(() => tg.perToken[TOK_A].sends.length > aSendsBefore, 8000, 'owner still gets replies after the stranger');

    // ---- 7. disconnect bot A: ITS poller stops; bot B keeps polling ----
    const off = await api('POST', '/api/channels/telegram/bots/111/disconnect', {});
    A.eq(off.status, 200, 'bot A disconnect 200');
    await sleep(400);
    const aPollsAfterOff = tg.perToken[TOK_A].calls.filter(c => c.method === 'getUpdates').length;
    const bPollsAtOff = tg.perToken[TOK_B].calls.filter(c => c.method === 'getUpdates').length;
    await sleep(1200);
    A.eq(tg.perToken[TOK_A].calls.filter(c => c.method === 'getUpdates').length, aPollsAfterOff, 'bot A stopped polling after disconnect');
    await waitUntil(() => tg.perToken[TOK_B].calls.filter(c => c.method === 'getUpdates').length >= bPollsAtOff, 2000, 'bot B unaffected');
    const stAfter = (await api('GET', '/api/channels/telegram/status')).j;
    const rowA = (stAfter.bots || []).find(b => b.botId === '111');
    const rowB = (stAfter.bots || []).find(b => b.botId === '222');
    A.ok(rowA && rowA.enabled === false && rowA.connected === false && rowA.configured === true, 'bot A: off but token kept (RESUME-able)');
    A.ok(rowB && rowB.connected === true, 'bot B still connected in status');

    // ---- 8. forget bot B: record purged from the durable secrets file (read straight from disk) ----
    const forget = await api('POST', '/api/channels/telegram/bots/222/disconnect', { purge: true });
    A.eq(forget.j.purged, true, 'forget claims purged only with read-back proof');
    const onDisk = JSON.parse(fs.readFileSync(path.join(ws, 'channels', 'secrets.json'), 'utf8'));
    A.ok(!(onDisk.telegramBots && onDisk.telegramBots['222']), 'bot B record is GONE from disk');
    A.ok(onDisk.telegramBots && onDisk.telegramBots['111'] && onDisk.telegramBots['111'].token === TOK_A, 'bot A record (disconnected, not forgotten) still on disk with its token');
  } finally {
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => tg.close(resolve));
    try { llm.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('channels.telegram.multibot.e2e.test');
})().catch(e => { console.log('FAIL: channels.telegram.multibot.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
