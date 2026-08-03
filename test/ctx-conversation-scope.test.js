/* node test/ctx-conversation-scope.test.js — regression guard for THE CONTEXT GAUGE READING THE WRONG CHAT.

   THE DEFECT (proven live 2026-08-03, seeded station on a real OpenRouter turn). Context occupancy was
   stored per AGENT: `contextByAgent[agentId] = { used: prompt_tokens }`. The bottom-bar gauge labels
   itself "MEMORY OF THIS CHAT". Those two are not the same quantity. Opening a new workstream — or
   switching to any other one — left the previous conversation's fill on screen: a stream with ZERO turns
   read "13k / 200k (7% full)", inherited from a 4-turn sibling. After a long session that is a gauge
   telling you an empty chat has eaten 60% of the window. Nothing in the harness could prove that claim,
   which makes it the exact failure the truthful-telemetry rule exists to stop.

   WHY BEHAVIOURAL AND NOT A SOURCE LOCK. A grep for `streamId` passes on any code that merely mentions
   it; the bug is about WHICH bucket a cost event lands in and which bucket a read comes out of. So this
   runs the REAL registerRun / foldContextCost / endContextRun / contextState bodies sliced out of
   harness.js in a vm sandbox (the idiom from ctx-model-catalog.test.js — harness.js is browser-flow and
   not node-loadable as a whole) against the REAL CtxGauge estimator, and replays the actual sequence:
   run in stream A, then read stream B. Reverting to per-agent keying makes assertion 2 fail on a VALUE. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CtxGauge = require('../frontend/app/ctxgauge.js');
const SRC = path.join(__dirname, '..', 'frontend', 'app', 'harness.js');
const source = fs.readFileSync(SRC, 'utf8');

/* ---------- slice the real bodies out of harness.js ---------- */

function region(label, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  A.ok(start >= 0, 'harness.js still contains ' + label);
  const end = source.indexOf(endMarker, start);
  A.ok(end > start, label + ' has a locatable end');
  return source.slice(start, end);
}
// the whole occupancy block: state + convKey + registerRun + foldContextCost + endContextRun
const occupancy = region('the context-occupancy block', '  let contextByKey = {};', '\n  // Desktop (Tauri) build:');
const readSide = region('contextState', '  function contextState(agentId, streamId, messages) {', '\n  function normalizeModel(');

let LIMITS = { 'model-a': 200000 };
let ACTIVE_MODEL = 'model-a';
const store = new Map();   // the calibration is persisted across reloads; stub the shelf it lives on
const sandbox = {
  CtxGauge,
  console: { warn() {}, log() {} },
  getModel: () => ACTIVE_MODEL,
  contextLimitOf: id => LIMITS[id] || 0,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); }
  }
};

const api = vm.runInNewContext(
  occupancy + '\n' + readSide +
  '\n({ registerRun, foldContextCost, endContextRun, contextState, internalRuns, peek: () => contextByKey, overheads: () => overheadByModel });',
  sandbox,
  { filename: 'harness.js#occupancy' }
);

/* ---------- fixtures: two conversations owned by the SAME agent ---------- */

const msg = (role, chars) => ({ role, content: 'x'.repeat(chars) });
const CHAT_A = [msg('user', 400), msg('assistant', 1200)];   // a real conversation
const CHAT_B = [];                                            // a brand-new session, nothing said

// one real turn in stream A: 13,170 prompt tokens (the measurement from the live repro)
function runTurnInA(runId, tokensIn, messages) {
  api.registerRun(runId, 'agent', 'ws_A', messages);
  api.foldContextCost({ agentId: 'agent', runId, model: 'model-a', tokensIn, tokensOut: 159 });
}

runTurnInA('run-1', 13170, CHAT_A);

/* 1. the conversation that actually ran reports its own measurement */
const a = api.contextState('agent', 'ws_A', CHAT_A);
A.eq(a.used, 13170, 'stream A reports the prompt_tokens its own run measured');
A.eq(a.measured, true, 'stream A is a real measurement while its run is live');
A.eq(a.limit, 200000, 'the limit comes from the catalog for the run\'s model');

/* 2. ⛔ THE DEFECT: a DIFFERENT conversation must never inherit that fill.
      Pre-fix both reads hit contextByAgent['agent'] and B reported 13170 over an empty transcript. */
const b = api.contextState('agent', 'ws_B', CHAT_B);
A.ok(b.used !== 13170, 'a new session does NOT inherit the other conversation\'s measured occupancy');
A.eq(b.measured, false, 'a conversation that has never run reports no measurement of its own');

/* 3. …but it is not blank either: the overhead learned from A's REAL request projects B honestly.
      An empty chat still costs the system prompt + tool schemas, and that is the number to show. */
const overheadA = 13170 - CtxGauge.estimateMessages(CHAT_A);
A.eq(b.projected, true, 'the empty session is projected, not measured');
A.eq(b.used, overheadA + CtxGauge.estimateMessages(CHAT_B), 'projection = learned overhead + this chat\'s own dialogue');
A.ok(b.used > 0 && b.used < 13170, 'an empty chat projects the harness floor — below A, above zero');

/* 4. the projection is anchored to a MEASUREMENT, never invented: with no calibrated overhead for the
      model there is nothing to derive from, and the gauge says so rather than guessing. */
ACTIVE_MODEL = 'model-z';
LIMITS['model-z'] = 128000;
const cold = api.contextState('agent', 'ws_C', CHAT_A);
A.eq(cold.measured, false, 'an uncalibrated model has no measurement');
A.eq(cold.projected, false, 'an uncalibrated model projects NOTHING — no fabricated fill');
A.eq(cold.used, 0, 'no calibration, no number');
ACTIVE_MODEL = 'model-a';

/* 5. a live agentic run reports the provider's real prompt growth (tool results the model IS holding),
      but once the run ENDS the reading falls back to the next request's projection — the accumulated
      tool results are never resent, so freezing on that peak would overstate the chat by 3-4x. */
api.registerRun('run-2', 'agent', 'ws_A', CHAT_A);
api.foldContextCost({ agentId: 'agent', runId: 'run-2', model: 'model-a', tokensIn: 13200 });
api.foldContextCost({ agentId: 'agent', runId: 'run-2', model: 'model-a', tokensIn: 61000 });   // turn 4, tool results piled up
A.eq(api.contextState('agent', 'ws_A', CHAT_A).used, 61000, 'mid-run the gauge tracks what the model is holding NOW');
A.eq(api.contextState('agent', 'ws_A', CHAT_A).measured, true, 'mid-run that is a real measurement');
api.endContextRun({ runId: 'run-2' });
const settled = api.contextState('agent', 'ws_A', CHAT_A);
A.eq(settled.used, 13200, 'after the run ends the gauge settles to the run\'s FIRST-turn measurement of this transcript');
A.ok(settled.used < 20000, 'it does NOT freeze on the tool-result peak the next request will never resend');
A.eq(settled.measured, true, 'that settled number is a real measurement of exactly these messages, not a projection');

/* 6. calibration is learned from the FIRST cost of a run only. Turn 4 of run-2 carried 61k against the
      same messages; if that had been allowed to calibrate, the overhead would have jumped to ~60k and
      every later projection would have been ~4x too big. run-2's own first turn (13200) is the newest
      honest calibration, so that is what the map holds. */
const overheads = api.overheads();
const key = 'agent' + String.fromCharCode(0) + 'model-a';
A.eq(overheads[key], 13200 - CtxGauge.estimateMessages(CHAT_A), 'the overhead comes from a FIRST turn, never a tool-heavy later one');
A.ok(overheads[key] < 20000, 'the 61k tool-result turn never became the overhead');

/* 7. growth is visible without waiting for a reply: adding to the transcript moves the projection. */
const grown = CHAT_A.concat([msg('user', 40000)]);            // a big paste
const before = api.contextState('agent', 'ws_A', CHAT_A).used;
const after = api.contextState('agent', 'ws_A', grown).used;
A.ok(after - before >= 9000, 'a 40k-char paste moves the gauge immediately (~10k tokens), not after the reply');

/* 8. internal side-runs (retitle / goal-judge / pitch) stay gauge-invisible — they are tiny prompts on
      the same agent, and letting them fold made the gauge snap back to ~1% after every real turn. */
api.internalRuns.add('run-internal');
api.registerRun('run-internal', 'agent', 'ws_A', []);
api.foldContextCost({ agentId: 'agent', runId: 'run-internal', model: 'model-a', tokensIn: 300 });
A.ok(api.contextState('agent', 'ws_A', CHAT_A).used > 1000, 'an internal side-run never becomes the chat\'s occupancy');

/* 9. a server-launched run with no registered conversation (cron / channel) folds to the agent's
      streamless bucket — real occupancy, but it must not repaint whichever chat happens to be open. */
api.foldContextCost({ agentId: 'agent', runId: 'run-cron', model: 'model-a', tokensIn: 90000 });
A.ok(api.contextState('agent', 'ws_A', CHAT_A).used < 20000, 'a background run does not repaint the open chat');
A.eq(api.peek()['agent' + String.fromCharCode(0) + ''].used, 90000, 'it is still recorded, under the streamless bucket');

/* 10. the calibration SURVIVES A RELOAD. It is the difference between a gauge that works and one that
       goes blank every refresh until you pay for another turn — which is most of what "it never works"
       felt like. Rebuild the module against the same storage and read a never-before-seen stream. */
const reloaded = vm.runInNewContext(
  occupancy + '\n' + readSide + '\n({ contextState });',
  Object.assign({}, sandbox), { filename: 'harness.js#occupancy-reloaded' }
);
const afterReload = reloaded.contextState('agent', 'ws_FRESH', CHAT_A);
A.eq(afterReload.projected, true, 'after a reload the learned overhead is still there to project from');
A.eq(afterReload.used, 13200 - CtxGauge.estimateMessages(CHAT_A) + CtxGauge.estimateMessages(CHAT_A),
  'and the projection reproduces the measured cost of that transcript');
A.ok(store.size > 0, 'the calibration is actually written to storage, not just held in memory');

/* 11. the web build ships the same panel — a fix in one copy is a fix half the users never get */
const web = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'app', 'harness.js'), 'utf8');
A.ok(web.indexOf('let contextByKey') >= 0, 'the website mirror carries the per-conversation keying too');
A.ok(/function contextState\(agentId, streamId, messages\)/.test(web), 'the website mirror carries the conversation-scoped read too');

A.report('ctx-conversation-scope');
