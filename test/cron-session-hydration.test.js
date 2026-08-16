/* Regression coverage for unattended-session hydration.

   A durable cron transcript can contain blank assistant envelopes around tool calls before its
   final prose. Those envelopes are transport mechanics, not user-visible output: they must not
   satisfy the backfill dedupe guard, and a just-finished transcript gets a short bounded retry so
   the session cannot settle as a prompt-only conversation during the persistence race. */
'use strict';
const A = require('./_assert.js');

(async () => {
  const sessions = new Map();
  const seed = {
    id: 'cron-run-blank-envelope', title: 'AI news', agentId: 'researcher', lane: 'active',
    history: [
      { role: 'user', content: 'Find the news' },
      { role: 'assistant', content: '' }
    ]
  };
  sessions.set(seed.id, seed);
  global.Workstreams = {
    get: id => sessions.get(id) || null,
    adopt: row => {
      if (!sessions.has(row.id)) sessions.set(row.id, Object.assign({}, row));
      return sessions.get(row.id);
    },
    appendRun: () => {},
    activeId: () => ''
  };
  global.Channels = { end: () => {}, isBusy: () => false, busyIds: () => [] };
  global.App = { persist: () => {}, refreshRail: () => {} };

  let transcriptReads = 0;
  global.fetch = async url => {
    if (url === '/api/cron') return { ok: true, json: async () => ({ jobs: [] }) };
    if (url.indexOf('/api/runs?') === 0) return { ok: true, json: async () => ({ runs: [{
      runId: 'run-blank-envelope', streamId: seed.id, title: 'AI news', agentId: 'researcher',
      reason: 'done', ts: 1700000000000
    }] }) };
    if (url.indexOf('/api/transcript?') === 0) {
      transcriptReads++;
      return { ok: true, json: async () => ({ turns: transcriptReads === 1 ? [
        { role: 'user', content: 'Find the news' },
        { role: 'assistant', content: '' }
      ] : [
        { role: 'user', content: 'Find the news' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: 'The finished report is attached.' }
      ] }) };
    }
    throw new Error('unexpected request: ' + url);
  };

  const { AutoSessions } = require('../frontend/app/autosessions.js');
  const I = AutoSessions._internals;
  await I.backfill({ sleep: () => Promise.resolve() });

  A.eq(transcriptReads, 2, 'a blank assistant envelope does not block backfill and the incomplete transcript is retried');
  A.eq(seed.history.filter(x => x.role === 'assistant').map(x => x.content), ['The finished report is attached.'], 'only readable assistant output is folded into the session');
  A.ok(I.hasReadableOutput(seed.history), 'the final prose satisfies the output guard');
  A.ok(!I.hasReadableOutput([{ role: 'assistant', content: '' }]), 'an empty assistant envelope is not output');

  let failedReads = 0;
  global.fetch = async () => { failedReads++; throw new Error('offline'); };
  const unavailable = await I.fetchTranscript('researcher', 'cron-run-offline', { waits: [0, 0], sleep: () => Promise.resolve() });
  A.eq(failedReads, 3, 'an unreachable transcript is retried a bounded number of times');
  A.ok(!unavailable.fetchOk, 'exhausted transcript reads remain distinguishable from an honestly empty transcript');

  const pending = { id: 'cron-run-unreachable', history: [] };
  I.foldTurns(pending, [{ role: 'user', content: 'Generate a report' }, { role: 'assistant', content: '' }], 'ok', '', false, 1700000000001);
  const marker = pending.history.find(x => x && x.transcriptPending);
  A.ok(marker && marker.sys && marker.error && /retry/i.test(marker.content), 'an unreachable transcript leaves a visible retryable status instead of a blank session');
  A.ok(!I.hasReadableOutput(pending.history), 'the pending status does not poison the next recovery attempt');

  A.report('cron-session-hydration.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
