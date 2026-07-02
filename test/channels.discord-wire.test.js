/* node test/channels.discord-wire.test.js — the HOST wiring for the Discord channel (P0-4, settings gap audit).
   The Discord adapter + transport shipped fully-tested (channels.discord*.test.js) and the registry knows it
   (channels.registry.test.js), but the running sidecar never exposed it: no /api/channels/discord/* endpoints and
   the Messaging panel had no Discord card. This guards THAT seam:
   1) BACKEND source-guard over sidecar/index.js — the four discord endpoints are routed, dispatch to handlers that
      mirror the Telegram ones, start/stop through startDiscord/stopDiscord, and the status handler NEVER echoes the
      token (secret-safety, matching the Telegram contract).
   2) FRONTEND source-guard over the Messaging card — a Discord card with a masked token, connect/disconnect, a live
      status line, the shared autonomous-ping opt-in, and inline "how to get a bot token" help, mirroring Telegram.
   3) A behavioural check that the real registry's discord descriptor is startable + participates in the generic
      wire path (belt-and-braces over the registry test), and that connect()/disconnect() are clean with no gateway
      (the honest no-WS default): connect does not throw, disconnect does not throw, send still returns a SendResult. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeChannelRegistry, wireChannel } = require('../sidecar/channels/registry.js');
const { makeDiscordTransport } = require('../sidecar/channels/discord.transport.js');

function fakeStore() {
  const hist = new Map();
  return { loadHistory(a) { return (hist.get(a) || []).slice(); },
           appendTurn(a, r, c) { const arr = hist.get(a) || []; arr.push({ role: r, content: c }); hist.set(a, arr); return arr; },
           getChatRecord() { return null; } };
}
const ids = () => { let i = 0; return () => 'r' + (++i); };
function fakeFetch() { return async () => ({ ok: true, status: 200, async json() { return { id: '1' }; }, headers: { get: () => null } }); }

(async () => {
  // ---------- 1. BACKEND source-guard: the four discord endpoints + handlers exist and mirror Telegram ----------
  const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');

  // Telegram (the model we mirror) is untouched — additive-only guarantee.
  A.ok(/\/api\/channels\/telegram\/connect/.test(idx), 'Telegram connect route still present (not regressed)');
  A.ok(/function startTelegram/.test(idx), 'startTelegram still present');

  // the four Discord routes are wired into the request dispatcher
  A.ok(/req\.url === '\/api\/channels\/discord\/connect'/.test(idx), 'POST /api/channels/discord/connect routed');
  A.ok(/req\.url === '\/api\/channels\/discord\/disconnect'/.test(idx), 'POST /api/channels/discord/disconnect routed');
  A.ok(/req\.url === '\/api\/channels\/discord\/status'/.test(idx), 'GET /api/channels/discord/status routed');
  A.ok(/req\.url === '\/api\/channels\/discord\/sync'/.test(idx), 'POST /api/channels/discord/sync routed');

  // each route dispatches to its handler
  A.ok(/function handleDiscordConnect/.test(idx), 'handleDiscordConnect defined');
  A.ok(/function handleDiscordDisconnect/.test(idx), 'handleDiscordDisconnect defined');
  A.ok(/function handleDiscordStatus/.test(idx), 'handleDiscordStatus defined');
  A.ok(/function handleDiscordSync/.test(idx), 'handleDiscordSync defined');

  // the connect/disconnect path drives the real adapter lifecycle (started the SAME way Telegram is)
  A.ok(/startDiscord\(token,/.test(idx), 'handleDiscordConnect starts the adapter via startDiscord');
  A.ok(/function stopDiscord/.test(idx), 'stopDiscord present (disconnect lifecycle)');
  A.ok(/stopDiscord\(\)/.test(idx), 'disconnect handler stops the adapter');

  // P2-E: the host injects the REAL gateway WS client (full-duplex), not an inert no-WS default. Guard that
  // startDiscord actually wires connectGateway from discord.gateway.js — else ingress silently regresses to inert.
  A.ok(/require\('\.\/channels\/discord\.gateway\.js'\)/.test(idx), 'index requires the real Discord gateway client');
  const startBody = (idx.split('function startDiscord')[1] || '').split('function stopDiscord')[0];
  A.ok(/connectGateway:\s*makeConnectGateway\(/.test(startBody), 'startDiscord injects a real connectGateway (full-duplex ingress)');
  A.ok(/onState:/.test(startBody), 'the gateway reports transport health into discordStatus (truthful status line)');

  // SECRET-SAFETY: the status handler reports only booleans/state — never the token/key. Guard the shape.
  const dcStatusBody = (idx.split('function handleDiscordStatus')[1] || '').split('function ')[0];
  A.ok(/configured:\s*!!d\.token/.test(dcStatusBody), 'status reports a boolean "configured" from the token, not the token itself');
  A.ok(!/token:\s*d\.token/.test(dcStatusBody), 'status handler never puts the raw token in its JSON');
  A.ok(!/\bkey:\s*d\.key/.test(dcStatusBody), 'status handler never puts the raw key in its JSON');
  A.ok(/notifyAutonomous/.test(dcStatusBody), 'status surfaces the shared autonomous-ping opt-in (parity with Telegram)');

  // ---------- 2. FRONTEND source-guard: the Messaging Discord card mirrors the Telegram card ----------
  const station = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');

  // Telegram card intact (additive-only)
  A.ok(/id="tg-token"/.test(station) && /id="tg-connect"/.test(station), 'Telegram card preserved (not regressed)');

  // the Discord card: header, masked token field, connect + disconnect, live status, notify opt-in, message line
  A.ok(/>DISCORD</.test(station), 'DISCORD card header present in the Messaging panel');
  A.ok(/id="dc-token"[^>]*type="password"/.test(station), 'Discord token field is masked (type=password), matching Telegram');
  A.ok(/id="dc-connect"/.test(station) && /id="dc-disconnect"/.test(station), 'Discord connect + disconnect controls present');
  A.ok(/id="dc-status"/.test(station), 'Discord live status line present');
  A.ok(/id="dc-notify"/.test(station), 'Discord autonomous-ping opt-in present');
  A.ok(/id="dc-msg"/.test(station), 'Discord message/feedback line present');

  // the card talks to the real endpoints
  A.ok(/\/api\/channels\/discord\/connect/.test(station), 'Discord card CONNECT hits the connect endpoint');
  A.ok(/\/api\/channels\/discord\/disconnect/.test(station), 'Discord card DISCONNECT hits the disconnect endpoint');
  A.ok(/\/api\/channels\/discord\/status/.test(station), 'Discord card reads the status endpoint');

  // beginner help: a one-line pointer to where the bot token comes from
  A.ok(/Developer Portal/.test(station), 'inline help points at the Discord Developer Portal for the bot token');
  A.ok(/MESSAGE CONTENT INTENT/.test(station), 'inline help flags the message-content intent gotcha');

  // P2-E: the "send-only" disclosure is GONE — Discord is now full-duplex, and the card must claim two-way honestly.
  A.ok(!/Send-only for now/.test(station), 'the "Send-only for now" disclaimer was removed (Discord now receives)');
  A.ok(!/don\\?'t reach the agent yet/.test(station), 'the "replies don\'t reach the agent yet" line was removed');
  A.ok(/Two-way chat on Discord/.test(station), 'the Discord card now advertises two-way chat (truthful full-duplex)');
  // the status line reflects that receive works when connected.
  A.ok(/CONNECTED — receiving/.test(station), 'the connected status says it is receiving (not just sending)');

  // keep-saved-when-blank contract (reconnect without re-pasting), same as Telegram
  A.ok(/paste your Discord bot token first/.test(station), 'first-time setup requires a token; a saved token allows blank reconnect');

  // ---------- 3. BEHAVIOUR: the real registry's discord descriptor is startable + clean without a gateway ----------
  {
    const reg = makeChannelRegistry();
    A.ok(reg.has('discord'), 'registry exposes the discord channel the host starts');
    // no connectGateway injected -> ingress is inert (honest no-WS default). connect/disconnect must NOT throw and
    // send must still return a normalized SendResult — the "clear error state, not a crash" the task asks for.
    const transport = makeDiscordTransport({ fetch: fakeFetch(), token: 'T', parkMs: 1 });
    const { adapter } = wireChannel(reg.get('discord'), {
      hub: { runOnce: async () => {}, store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: ids() },
      adapter: { transport, clock: { now: () => 1 } }
    });
    A.notThrows(() => adapter.connect(), 'discord adapter connects cleanly with no gateway (inert ingress, no crash)');
    const sr = await adapter.send('chan', 'hi');
    A.ok(sr && typeof sr.ok === 'boolean', 'send returns a normalized SendResult even with no real gateway');
    await A.notThrows(() => adapter.disconnect(), 'discord adapter disconnects cleanly');
  }

  A.report('channels.discord-wire');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
