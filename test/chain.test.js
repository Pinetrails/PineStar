/* test/chain.test.js — the agentic-graph executor (sidecar/routing/chain.js).
   Pure orchestration: a fake nextAgent (the drawn floor) + a fake runAgent (the harness), injected clock.
   No provider, no DOM, no wall-clock. The last block wires the REAL compiler + REAL router so "the line the
   Commander drew" and "the runs the sidecar buys" are proven to be one decision. */
'use strict';
const A = require('./_assert.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');

// a scripted harness: agentId -> { text, usd } | fn(text) — plus a log of what each stage was handed
function harness(script, log) {
  return async ({ agentId, text, hop, from }) => {
    if (log) log.push({ agentId, hop, from, text });
    const r = script[agentId];
    return typeof r === 'function' ? r(text) : (r || { text: agentId + ' output' });
  };
}
const line = map => a => map[a] || null;      // the drawn floor, as a plain edge map
let T = 0; const clock = () => (T += 10);

(async () => {

  /* ---- a two-stage line runs BOTH agents; the reply is the LAST stage's ---- */
  {
    const log = [], events = [];
    const c = makeChainRunner({
      nextAgent: line({ researcher: 'writer' }),
      runAgent: harness({ writer: { text: 'the polished draft', usd: 0.02 } }, log),
      emit: (n, p) => events.push(n + ':' + p.agentId), now: clock
    });
    const res = await c.advance({ agentId: 'researcher', text: 'raw findings', originalText: 'write me a brief' });
    A.eq(res.text, 'the polished draft', 'the LAST stage of the line produces the answer');
    A.eq(res.agentId, 'writer', 'and the reply is attributed to it');
    A.eq(res.hops.length, 1, 'one downstream hop ran');
    A.eq(res.stopped, null, 'the line ran to its end');
    A.eq(res.usd, 0.02, "the chain accounts for the downstream stage's spend");
    A.eq(log[0].from, 'researcher', 'the handoff names the upstream stage');
    A.ok(/raw findings/.test(log[0].text), "the downstream stage is handed the upstream stage's output");
    A.ok(/write me a brief/.test(log[0].text), 'AND the original request — a writer handed only research invents the ask');
    A.eq(events.join('|'), 'workitem.placed:writer|workitem.delivered:writer', 'every hop rides as a real crate');
  }

  /* ---- a terminal dock hands off to nobody: today's single-agent behaviour, byte for byte ---- */
  {
    let ran = 0;
    const c = makeChainRunner({ nextAgent: line({}), runAgent: async () => { ran++; return { text: 'x' }; }, now: clock });
    const res = await c.advance({ agentId: 'solo', text: 'the answer' });
    A.eq(res.text, 'the answer', 'a lone dock delivers its own reply unchanged');
    A.eq(ran, 0, 'and buys no extra runs');
    A.eq(res.hops.length, 0, 'no hops');
  }

  /* ---- A FAILED STAGE KEEPS THE LAST GOOD ANSWER (the belt is never a gate) ---- */
  {
    const c = makeChainRunner({
      nextAgent: line({ a: 'b', b: 'c' }),
      runAgent: harness({ b: { text: 'stage b work', usd: 0.01 }, c: { error: 'provider exploded' } }), now: clock
    });
    const res = await c.advance({ agentId: 'a', text: 'stage a work' });
    A.eq(res.text, 'stage b work', 'the reply is the last stage that actually worked');
    A.eq(res.agentId, 'b', 'attributed to the agent that produced it');
    A.ok(/^c failed: provider exploded/.test(res.stopped), 'and the stop reason names the stage and the failure');
    A.ok(/work line stopped early/.test(c.stopNote(res)), 'the note is honest about the line not finishing');
    A.eq(c.stopNote({ stopped: null }), '', 'a complete line adds no note');
  }

  /* ---- an EMPTY stage output is never handed on (it would buy a run that can only hallucinate its input) ---- */
  {
    let ran = 0;
    const c = makeChainRunner({
      nextAgent: line({ a: 'b' }), runAgent: async () => { ran++; return { text: '' }; }, now: clock
    });
    const res = await c.advance({ agentId: 'a', text: '   ' });
    A.eq(ran, 0, 'a blank upstream output stops the line before it spends anything');
    A.ok(/produced no output/.test(res.stopped), 'and says so');
  }

  /* ---- NEVER RUN AN AGENT TWICE IN ONE CHAIN (a plan re-posted mid-chain can reintroduce a loop) ---- */
  {
    const seen = [];
    const c = makeChainRunner({
      nextAgent: line({ a: 'b', b: 'a' }),                    // a loop the compiler would have refused
      runAgent: harness({ b: { text: 'b work' } }, seen), now: clock
    });
    const res = await c.advance({ agentId: 'a', text: 'a work' });
    A.eq(seen.length, 1, 'the loop closes after ONE hop — not forever');
    A.ok(/loops back to a/.test(res.stopped), 'and the reason names the loop');
  }

  /* ---- the hop cap and the spend cap both stop the line, honestly ---- */
  {
    const c = makeChainRunner({
      nextAgent: a => ({ s0: 's1', s1: 's2', s2: 's3' })[a] || null,
      runAgent: harness({ s1: { text: 'one' }, s2: { text: 'two' }, s3: { text: 'three' } }),
      maxHops: 2, now: clock
    });
    const res = await c.advance({ agentId: 's0', text: 'seed' });
    A.eq(res.hops.length, 2, 'exactly maxHops downstream stages ran');
    A.eq(res.text, 'two', 'the answer is the last stage that ran');
    A.ok(/longer than 2 stages/.test(res.stopped), 'the cap is reported, never silent');
  }
  {
    const c = makeChainRunner({
      nextAgent: a => ({ s0: 's1', s1: 's2' })[a] || null,
      runAgent: harness({ s1: { text: 'one', usd: 5 }, s2: { text: 'two', usd: 5 } }),
      maxUsd: 1, now: clock
    });
    const res = await c.advance({ agentId: 's0', text: 'seed' });
    A.eq(res.hops.length, 1, 'the line stops once the chain has blown its ceiling');
    A.ok(/\$1\.00 limit/.test(res.stopped), 'and names the limit');
  }

  /* ---- E-STOP: an aborted signal stops the line where it stands ---- */
  {
    const c = makeChainRunner({ nextAgent: line({ a: 'b' }), runAgent: harness({}), now: clock });
    const res = await c.advance({ agentId: 'a', text: 'work', signal: { aborted: true } });
    A.eq(res.hops.length, 0, 'nothing runs after an E-STOP');
    A.eq(res.stopped, 'stopped', 'and it says stopped');
  }

  /* ================= THE DRAWN FLOOR IS THE PIPELINE (compiler + router + executor) ================= */
  {
    const belt = (x, y, dir) => ({ x, y, dir });
    const plan = P.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'bA', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'researcher' },
              { id: 'bB', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer' },
              { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
    });
    const router = makeRouter();
    A.ok(router.setPlan(plan).ok, 'the drawn floor deploys');
    A.eq(router.resolveTarget({ tag: 'x' }), 'researcher', 'inbound work enters at the first dock');

    const log = [];
    const c = makeChainRunner({
      nextAgent: (a, ctx) => router.chainNext(a, ctx),
      runAgent: harness({ writer: { text: 'FINAL COPY', usd: 0.01 } }, log), now: clock
    });
    const res = await c.advance({ agentId: 'researcher', text: 'findings', originalText: 'brief me' });
    A.eq(res.agentId, 'writer', 'the BELTS decided that the writer runs second — nothing else was configured');
    A.eq(res.text, 'FINAL COPY', "and the writer's output is what leaves the station");
    A.eq(res.stopped, null, 'the line ran to the OUTBOX');
    A.eq(log.length, 1, 'exactly one downstream run was bought');
  }

  /* ---- a floor whose docks feed each other in a loop is REFUSED before it can spend anything ---- */
  {
    const belt = (x, y, dir) => ({ x, y, dir });
    const plan = P.compileRoutingPlan({
      props: [{ id: 'bA', t: 'bay', x: 2, y: 0, w: 1, h: 1, agentId: 'ping' },
              { id: 'bB', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'pong' }],
      belts: [belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'), belt(6, 1, 'S'), belt(6, 2, 'W'),
              belt(5, 2, 'W'), belt(4, 2, 'W'), belt(3, 2, 'W'), belt(2, 2, 'N'), belt(2, 1, 'N')]
    });
    const router = makeRouter();
    const r = router.setPlan(plan);
    A.ok(!r.ok, 'the sidecar refuses a looping work line');
    A.ok(r.codes.indexOf('CHAIN_CYCLE') >= 0, 'naming CHAIN_CYCLE as the reason');
    A.eq(router.chainNext('ping', {}), null, 'and no chain edge is served from a refused plan');
  }

  A.report('chain');
})();
