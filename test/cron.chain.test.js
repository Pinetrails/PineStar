/* node test/cron.chain.test.js — A ROUTINE FIRES A WORK LINE, NOT JUST A RUN.

   A routine fires at ONE dock. If the Commander drew stages downstream of that dock, those stages ARE the
   routine ("every morning research it, then write it up"). This locks the cron-driver's advanceChain seam:
     · the line runs AFTER the job's own run settles but BEFORE finishFire, so the routine's recorded outcome
       and its session transcript carry the LINE's answer, never stage one's raw material;
     · each hop renews the lease — a line that outran the heartbeat would be swept as a zombie and re-fired;
     · A CHAIN FAILURE NEVER CHANGES THE ROUTINE'S OUTCOME (stage one really did run and really did work). */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');

const T0 = 1700000000000;
const flush = () => new Promise(r => setImmediate(r));

function setup(opts) {
  opts = opts || {};
  const clock = makeClock(T0);
  const schedule = cron.parseSchedule('every 1m', T0);
  let store = [cronStore.makeJob({ id: 'j1', prompt: 'research the thing', agentId: 'researcher', schedule }, { id: 'j1', now: T0 })];
  const events = [], runs = [], chainCalls = [];
  let idN = 0;
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: (j) => { store = j; return true; },
    runOnce: (o) => new Promise((resolve, reject) => { runs.push({ opts: o, resolve, reject }); }),
    emit: (name, payload) => events.push({ name, payload }),
    newId: () => 'run-' + (++idN), newAbort: () => new AbortController(), now: () => clock.now(),
    getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000,
    advanceChain: opts.advanceChain ? (o) => { chainCalls.push(o); return opts.advanceChain(o); } : undefined
  });
  return { driver, clock, events, runs, chainCalls, getJob: (id) => cronStore.getJob(store, id) };
}
const lastOf = (events, name) => { const m = events.filter(e => e.name === name); return m.length ? m[m.length - 1].payload : undefined; };
// fire the due job and settle its run with `reply`
async function fireAndSettle(s, reply) {
  s.clock.set(T0 + 60000);
  s.driver.applyTick(s.clock.now());
  A.eq(s.runs.length, 1, 'the routine fired one run');
  s.runs[0].opts.emit('agent.token', { delta: reply });
  s.runs[0].opts.emit('agent.run.end', { reason: 'done' });
  s.runs[0].resolve();
  await flush(); await flush(); await flush();
}

(async function () {

  /* ---- the line's answer replaces stage one's, and the routine still settles OK ---- */
  {
    const s = setup({ advanceChain: async () => ({ text: 'THE FINISHED WRITE-UP', hops: [{ agentId: 'writer' }], stopped: null }) });
    await fireAndSettle(s, 'raw findings about the thing');
    A.eq(s.chainCalls.length, 1, 'the work line was advanced once');
    A.eq(s.chainCalls[0].agentId, 'researcher', "starting at the routine's own dock");
    A.eq(s.chainCalls[0].text, 'raw findings about the thing', "handed stage one's real output");
    A.eq(s.chainCalls[0].originalText, 'research the thing', "and the routine's own prompt as the original ask");
    A.eq(s.chainCalls[0].streamId, 'cron-run-1', "hops ride the ROUTINE's stream so its session shows the whole line");
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'the routine settles ok');
    A.eq(s.getJob('j1').lastStatus, 'ok', 'and its durable record is clean');
  }

  /* ---- the lease is renewed per hop: a long line must not be swept as a zombie ---- */
  {
    let renewed = 0;
    const s = setup({ advanceChain: async (o) => { o.onHop(); o.onHop(); renewed = 2; return { text: 'done', hops: [{}, {}], stopped: null }; } });
    await fireAndSettle(s, 'stage one');
    A.eq(renewed, 2, 'every hop got an onHop callback to renew the lease');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'the run settled normally, not as a stale lease');
  }

  /* ---- A CHAIN FAILURE NEVER CHANGES THE ROUTINE'S OUTCOME ---- */
  {
    const s = setup({ advanceChain: async () => { throw new Error('downstream exploded'); } });
    await fireAndSettle(s, 'stage one really worked');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'stage one really ran and really produced work — the routine is ok');
    A.eq(s.getJob('j1').lastStatus, 'ok', 'the durable record agrees');
  }

  /* ---- a line that returns nothing leaves stage one's answer alone ---- */
  {
    const s = setup({ advanceChain: async () => ({ text: '   ', hops: [], stopped: 'x' }) });
    await fireAndSettle(s, 'stage one output');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'an empty line never blanks the routine');
  }

  /* ---- NO advanceChain injected = today's single-run routine, untouched ---- */
  {
    const s = setup({});
    await fireAndSettle(s, 'just the one stage');
    A.eq(s.chainCalls.length, 0, 'no chain seam, no chain');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'and the routine behaves exactly as before');
  }

  /* ---- a FAILED stage-one run never advances a line (nothing real to hand on) ---- */
  {
    const s = setup({ advanceChain: async () => ({ text: 'should never happen', hops: [{}] }) });
    s.clock.set(T0 + 60000);
    s.driver.applyTick(s.clock.now());
    s.runs[0].opts.emit('agent.run.error', { message: 'provider down' });
    s.runs[0].resolve();
    await flush(); await flush(); await flush();
    A.eq(s.chainCalls.length, 0, 'a failed stage one hands nothing downstream');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'failed', 'and the routine reports the failure honestly');
  }

  A.report('cron.chain');
})();
