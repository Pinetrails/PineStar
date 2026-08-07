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
  let store = [cronStore.makeJob({ id: 'j1', prompt: 'research the thing', agentId: 'researcher', schedule, unattendedGrants: opts.grants }, { id: 'j1', now: T0 })];
  const events = [], runs = [], chainCalls = [];
  let idN = 0;
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: (j) => { store = j; return true; },
    runOnce: (o) => new Promise((resolve, reject) => { runs.push({ opts: o, resolve, reject }); }),
    emit: (name, payload) => events.push({ name, payload }),
    newId: () => 'run-' + (++idN), newAbort: () => new AbortController(), now: () => clock.now(),
    getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'PERSONA', maxRunMs: 480000,
    advanceChain: opts.advanceChain ? (o) => { chainCalls.push(o); return opts.advanceChain(o); } : undefined,
    stageBriefFor: opts.stageBriefFor
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

  /* ---- GRANTS NEVER FLOW DOWN A LINE (2026-08-04): the unattended grant the Commander recorded names ONE
     agent — the routine's own dock. Stage one runs with it; every downstream hop runs UNGRANTED, so drawing
     a belt to another dock can never silently extend terminal/verify authority onto a different agent. ---- */
  {
    const s = setup({ grants: ['workbench'], advanceChain: async () => ({ text: 'line done', hops: [{ agentId: 'writer' }], stopped: null }) });
    await fireAndSettle(s, 'stage one output');
    A.eq(s.runs[0].opts.unattendedGrants, ['workbench'], "stage one (the routine's own agent) keeps the recorded grant");
    A.eq(s.chainCalls.length, 1, 'the line still advanced');
    A.eq(s.chainCalls[0].unattendedGrants, [], 'the advanceChain seam is handed an EMPTY grants list — hops never inherit authority');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'and the routine still settles ok');
  }

  /* ---- THE DOCK'S STANDING BRIEF RIDES A SCHEDULED ENTRY RUN (inbox-trigger, 2026-08-05). A routine's
     fire was the ONE entry-run path that never briefed its dock: the same agent ran WITH its standing brief
     from a routed message (hub.js) and WITHOUT it from a routine. The driver now asks the injected
     stageBriefFor(agentId) — index.js wires router.stageBrief, the same seam the hub and chain handoffs
     read — and appends the brief to the run's SYSTEM under the hub's exact section header. Prompt text
     only: grants/tools/messages are untouched. ---- */
  {
    const s = setup({ stageBriefFor: (aid) => (aid === 'researcher' ? 'Dig three primary sources, cite them.' : null) });
    await fireAndSettle(s, 'stage one output');
    A.eq(s.runs[0].opts.system, 'PERSONA\n\nYOUR STANDING BRIEF FOR THIS STATION:\nDig three primary sources, cite them.',
      "the entry run's system carries the dock's standing brief under the hub's exact section header");
    A.eq(s.runs[0].opts.messages[0].content, 'research the thing', 'the brief rides SYSTEM — the user message is untouched');
    A.eq(s.runs[0].opts.unattendedGrants, [], 'and a brief never smuggles grants');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'the routine settles ok');
  }

  /* ---- no seam / no brief -> the exact pre-brief system string (byte-identical) ---- */
  {
    const s = setup({});
    await fireAndSettle(s, 'plain');
    A.eq(s.runs[0].opts.system, 'PERSONA', 'no stageBriefFor seam -> pre-brief system, byte-identical');
  }
  {
    const s = setup({ stageBriefFor: () => null });
    await fireAndSettle(s, 'plain');
    A.eq(s.runs[0].opts.system, 'PERSONA', 'a seam with no brief for this dock -> pre-brief system, byte-identical');
  }

  /* ---- a THROWING brief seam never kills the fire (a brief is an enhancement, not a gate) ---- */
  {
    const s = setup({ stageBriefFor: () => { throw new Error('boom'); } });
    await fireAndSettle(s, 'still works');
    A.eq(s.runs[0].opts.system, 'PERSONA', 'a throwing brief seam degrades to the pre-brief system');
    A.eq(lastOf(s.events, 'cron.result').outcome, 'ok', 'and the routine still settles ok');
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

  /* ---- A ROUTINE IS ITS LINE'S OWN TRIGGER — AND ONLY ITS OWN LINE'S ----
     Work belongs to a line (Andrew's ruling, 2026-08-07). A routine fires AT a dock, so the work it starts
     belongs to THAT dock's line and may run its stages. Wired here exactly as the composition root does
     (sidecar/index.js: `lineId: router.lineOfAgent(o.agentId)`), over the REAL router and the REAL chain
     runner, so this proves the semantics rather than a mock's opinion of them. */
  {
    const Pipeline = require('../frontend/app/pipeline.js');
    const { makeRouter } = require('../sidecar/routing/router.js');
    const { makeChainRunner } = require('../sidecar/routing/chain.js');
    const belt = (x, y, dir) => ({ x, y, dir });
    const router = makeRouter();
    A.ok(router.setPlan(Pipeline.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'researcher' },
              { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer' }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E')]
    })).ok, 'the routine floor deploys');

    const hopRuns = [];
    const chain = makeChainRunner({
      nextAgent: (a, ctx) => router.chainNext(a, ctx),
      runAgent: async (h) => { hopRuns.push(h.agentId); return { text: h.agentId + ' output' }; },
      now: () => 0
    });
    // the EXACT shape index.js injects, quoted so the two cannot drift apart unnoticed
    const advanceChain = (o) => chain.advance({
      agentId: o.agentId, text: o.text, originalText: o.originalText, signal: o.signal,
      lineId: router.lineOfAgent(o.agentId)
    });

    const s = setup({ advanceChain });
    await fireAndSettle(s, 'raw findings about the thing');
    A.eq(s.chainCalls.length, 1, 'the routine advanced its line');
    A.eq(hopRuns, ['writer'], "a routine at a DOCK runs that line's next stage — the routine IS the line");

    // the same routine at an agent that crews NO dock: no line to run, and nothing downstream is bought
    hopRuns.length = 0;
    A.eq(router.lineOfAgent('freelancer'), null, 'an undocked agent belongs to no line');
    const off = await chain.advance({ agentId: 'freelancer', text: 'raw findings', lineId: router.lineOfAgent('freelancer') });
    A.eq(off.hops.length, 0, 'so its routine is terminal');
    A.eq(hopRuns.length, 0, 'PROVIDER CALLS: zero — a routine can never spend on a line it is not on');
  }

  A.report('cron.chain');
})();
