'use strict';
// autonotify.test.js — autonomy B4: the cron→channel notifier. Watches the cron event stream and pings the
// agent's opted-in chats ONLY when an autonomous run finished 'ok' (anti-spam); lists any files it wrote.
const assert = require('assert');
const { makeAutoNotifier, composeMessage } = require('../sidecar/autonotify.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// --- composeMessage ---
eq(composeMessage('Weekly digest', []), '✦ "Weekly digest" ran on its own.', 'no files → just names the routine');
eq(composeMessage('Weekly digest', ['drafts/a.md', 'drafts/b.md']), '✦ "Weekly digest" ran on its own — wrote drafts/a.md, drafts/b.md.', 'files → lists them');
eq(composeMessage('', []), '✦ "a routine" ran on its own.', 'empty name falls back');

// a harness: jobId→{agent,name}; per-agent opted-in chats; record every send.
function harness(jobs, chatsByAgent) {
  const sent = [];
  const nf = makeAutoNotifier({
    send: (chatId, text) => { sent.push({ chatId, text }); return Promise.resolve(); },
    chatsFor: (aid) => (chatsByAgent[aid] || []),
    jobName: (jid) => (jobs[jid] || {}).name || 'a routine',
    jobAgent: (jid) => (jobs[jid] || {}).agent || null
  });
  return { nf, sent };
}
const JOBS = { j1: { agent: 'agent', name: 'Weekly digest' }, j2: { agent: 'other', name: 'Other job' } };

(async () => {
  // --- the happy path: fire → deliverable → ok result → ping with the file ---
  {
    const h = harness(JOBS, { agent: ['111'] });
    h.nf.onEvent('cron.fire', { jobId: 'j1', runId: 'r1' });
    h.nf.onEvent('deliverable', { agentId: 'agent', title: 'drafts/plan.md', kind: 'file' });
    h.nf.onEvent('cron.result', { jobId: 'j1', runId: 'r1', outcome: 'ok' });
    await Promise.resolve();
    eq(h.sent.length, 1, 'one ping on a work-producing ok run');
    eq(h.sent[0].chatId, '111', 'sent to the agent opted-in chat');
    ok(/Weekly digest/.test(h.sent[0].text) && /drafts\/plan\.md/.test(h.sent[0].text), 'message names the routine + the file');
    eq(h.nf._buckets().size, 0, 'the deliverable bucket is drained after the result');
  }

  // --- ok with NO files still pings (the routine produced a result = work) ---
  {
    const h = harness(JOBS, { agent: ['111'] });
    h.nf.onEvent('cron.fire', { jobId: 'j1' });
    h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });
    eq(h.sent.length, 1, 'an ok run with no file still pings (it did its job)');
    ok(!/wrote/.test(h.sent[0].text), 'no "wrote" clause when nothing was written');
  }

  // --- anti-spam: 'silent' and 'failed' never ping ---
  {
    const h = harness(JOBS, { agent: ['111'] });
    h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'silent' });
    h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'failed' });
    eq(h.sent.length, 0, "a 'silent' or 'failed' run never notifies (anti-spam)");
  }

  // --- opt-in: no opted-in chats → no ping (even on ok) ---
  {
    const h = harness(JOBS, { /* agent has no chats */ });
    h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });
    eq(h.sent.length, 0, 'no opted-in chat → no ping (opt-in respected)');
  }

  // --- isolation: a deliverable for a DIFFERENT agent never leaks into this run's ping ---
  {
    const h = harness(JOBS, { agent: ['111'] });
    h.nf.onEvent('cron.fire', { jobId: 'j1', runId: 'r1' });          // agent's run starts
    h.nf.onEvent('deliverable', { agentId: 'other', title: 'drafts/not-mine.md' });   // a DIFFERENT agent's file
    h.nf.onEvent('cron.result', { jobId: 'j1', runId: 'r1', outcome: 'ok' });
    ok(!/not-mine/.test(h.sent[0].text), "another agent's deliverable never leaks into this agent's ping");
  }

  // --- a result with no resolvable agent → no throw, no ping ---
  {
    const h = harness({}, { agent: ['111'] });
    h.nf.onEvent('cron.result', { jobId: 'unknown', outcome: 'ok' });
    eq(h.sent.length, 0, 'an unknown job (no agent) is a safe no-op');
  }

  // --- fan-out: multiple opted-in chats each get the ping ---
  {
    const h = harness(JOBS, { agent: ['111', '222'] });
    h.nf.onEvent('cron.result', { jobId: 'j1', outcome: 'ok' });
    eq(h.sent.map(s => s.chatId).sort(), ['111', '222'], 'pings every opted-in chat for the agent');
  }

  // --- source-locks for the (non-node-loadable) wiring: sidecar cron→notifier + the opt-in route + the UI toggle ---
  const fs = require('fs'); const path = require('path');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  ok(/require\('\.\/autonotify\.js'\)/.test(idx), 'index.js requires the autonotify engine');
  ok(/makeAutoNotifier\(/.test(idx), 'index.js instantiates the notifier');
  ok(/emit:\s*cronEmitNotify/.test(idx), 'the cron driver emit is wrapped (cronEmitNotify) to feed the notifier');
  ok(/'\/api\/channels\/notify'/.test(idx) && /function handleChannelNotify/.test(idx), '/api/channels/notify route + handler are wired');
  ok(/notifyAutonomous/.test(idx), 'index.js persists/reads the global opt-in flag (channelSecrets.notifyAutonomous)');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  ok(/id="tg-notify"/.test(ui), 'the Messaging panel renders the opt-in checkbox');
  ok(/\/api\/channels\/notify/.test(ui), 'the checkbox POSTs the opt-in toggle');

  console.log('autonotify.test.js OK —', n, 'assertions');
})().catch(e => { console.error(e); process.exit(1); });
