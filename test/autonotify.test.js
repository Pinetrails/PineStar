'use strict';
// autonotify.test.js — autonomy B4: the cron→channel notifier. Pings the agent's opted-in chats ONLY on a clean
// work-producing run (cron.result outcome 'ok'); routes by channel; never lists per-file deliverables (unsound to
// correlate without a runId on that event — see autonotify.js header). Plus wiring source-locks.
const assert = require('assert');
const { makeAutoNotifier, composeMessage } = require('../sidecar/autonotify.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// --- composeMessage ---
eq(composeMessage('Weekly digest'), '✦ "Weekly digest" ran on its own.', 'names the routine');
eq(composeMessage(''), '✦ "a routine" ran on its own.', 'empty name falls back');
eq(composeMessage(null), '✦ "a routine" ran on its own.', 'null name falls back');

// harness: jobId→{agent,name}; per-agent chats (as {chatId,channel}); records every send (chatId,text,channel).
function harness(jobs, chatsByAgent) {
  const sent = [];
  const nf = makeAutoNotifier({
    send: (chatId, text, channel) => { sent.push({ chatId, text, channel }); return Promise.resolve(); },
    chatsFor: (aid) => (chatsByAgent[aid] || []),
    jobName: (jid) => (jobs[jid] || {}).name || 'a routine',
    jobAgent: (jid) => (jobs[jid] || {}).agent || null
  });
  return { nf, sent };
}
const JOBS = { j1: { agent: 'agent', name: 'Weekly digest' }, j2: { agent: 'other', name: 'Other job' } };

// --- ok → pings the agent's opted-in chat, routed by channel ---
{
  const h = harness(JOBS, { agent: [{ chatId: '111', channel: 'telegram' }] });
  h.nf.onEvent('cron.result', { jobId: 'j1', runId: 'r1', outcome: 'ok' });
  eq(h.sent.length, 1, 'one ping on a clean ok run');
  eq([h.sent[0].chatId, h.sent[0].channel], ['111', 'telegram'], 'sent to the right chat + channel');
  ok(/Weekly digest/.test(h.sent[0].text), 'message names the routine');
}

// --- anti-spam: silent + failed never ping ---
{
  const h = harness(JOBS, { agent: [{ chatId: '111', channel: 'telegram' }] });
  h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'silent' });
  h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'failed' });
  h.nf.onEvent('cron.fire', { jobId: 'j1' });           // non-result events are ignored entirely
  h.nf.onEvent('deliverable', { agentId: 'agent', title: 'x.md' });
  eq(h.sent.length, 0, "only outcome 'ok' pings — silent/failed/other events never do");
}

// --- opt-in: no chats → no ping ---
{
  const h = harness(JOBS, {});
  h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });
  eq(h.sent.length, 0, 'no opted-in chat → no ping');
}

// --- unknown job (no agent) → safe no-op ---
{
  const h = harness({}, { agent: [{ chatId: '111' }] });
  h.nf.onEvent('cron.result', { jobId: 'nope', outcome: 'ok' });
  eq(h.sent.length, 0, 'an unknown job is a safe no-op');
}

// --- cross-agent isolation: a result for agent X only pings X's chats (never another agent's) ---
{
  const h = harness(JOBS, { agent: [{ chatId: 'A1', channel: 'telegram' }], other: [{ chatId: 'B1', channel: 'discord' }] });
  h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });   // j1 belongs to 'agent'
  eq(h.sent.map(s => s.chatId), ['A1'], "only the run's own agent chats are pinged (no cross-agent leak)");
}

// --- fan-out: every opted-in chat for the agent gets it ---
{
  const h = harness(JOBS, { agent: [{ chatId: '111', channel: 'telegram' }, { chatId: '222', channel: 'discord' }] });
  h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });
  eq(h.sent.map(s => [s.chatId, s.channel]).sort(), [['111', 'telegram'], ['222', 'discord']], 'pings every opted-in chat, each on its own channel');
}

// --- never throws even if send is hostile ---
{
  const nf = makeAutoNotifier({ send: () => { throw new Error('boom'); }, chatsFor: () => [{ chatId: '1' }], jobName: () => 'x', jobAgent: () => 'agent' });
  nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });   // must not throw
  ok(true, 'a throwing send never escapes onEvent (cron pipeline stays safe)');
}

// --- source-locks for the (non-node-loadable) wiring ---
const fs = require('fs'); const path = require('path');
const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
ok(/require\('\.\/autonotify\.js'\)/.test(idx), 'index.js requires the autonotify engine');
ok(/makeAutoNotifier\(/.test(idx), 'index.js instantiates the notifier');
ok(/emit:\s*cronEmitNotify/.test(idx), 'the cron driver emit is wrapped (cronEmitNotify) to feed the notifier');
ok(/'\/api\/channels\/notify'/.test(idx) && /function handleChannelNotify/.test(idx), '/api/channels/notify route + handler wired');
ok(/notifyAutonomous/.test(idx), 'index.js persists/reads the global opt-in flag');
ok(/redact\(text\)/.test(idx), 'the outbound notification text is redacted before send (no secret egress)');
const hub = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'channels', 'hub.js'), 'utf8');
ok(/saveChatRecord\(/.test(hub), 'the inbound hub persists the chat→agent binding (so the notifier can find chats)');
const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
ok(/id="tg-notify"/.test(ui) && /\/api\/channels\/notify/.test(ui), 'the Messaging panel has the opt-in toggle + posts it');

console.log('autonotify.test.js OK —', n, 'assertions');
