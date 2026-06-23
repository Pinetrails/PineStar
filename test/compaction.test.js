/* node test/compaction.test.js — H5.2 iterative-merge + savings anti-thrash in the agent loop.
   (1) A run that already carries a prior <conversation_summary> note MERGES it (the summarizer receives the prior
       text as prevSummary) and ends with EXACTLY ONE note — successive folds never stack.
   (2) When folds stop freeing meaningful space (<10% each), compaction switches OFF after two in a row, so a long
       run can't burn endless paid summarizer calls re-folding the same near-incompressible prompt.
   Driven through the real runAgentLoop with a replay provider + an injected context (deterministic, no network).
   maybeCompact fires at the TOP of each loop iteration, so the run needs tool-call turns (which keep iterating)
   for a fold to occur on a later turn against the prior turn's usage. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

function setup() { const bus = A.makeBus(); const seq = A.collectBus(bus, events.names()); return { seq, emit: makeEmitter(bus, () => {}) }; }
const openCtx = () => ({ agentId: 'a', canUse: () => ({ ok: true }), canRun: () => ({ ok: true }) });
// a tool-call turn keeps the loop iterating; carries the prompt-token usage maybeCompact measures next turn
const toolTurn = (id, p) => [{ type: 'tool_start', index: 0, id, name: 'noop' }, { type: 'tool_args', index: 0, chunk: '{}' },
  { type: 'usage', usage: { prompt_tokens: p, completion_tokens: 1, total_tokens: p + 1 } }, { type: 'done', finishReason: 'tool_calls' }];
const stopTurn = [{ type: 'text', delta: 'final' }, { type: 'done', finishReason: 'stop' }];
function reg() { const r = makeRegistry(); r.register({ name: 'noop', schema: { type: 'object' }, run: async () => 'ok' }); return r; }

(async () => {
  // ---- 1. ITERATIVE MERGE: a prior summary note is merged, not stacked; exactly one note survives ----
  {
    const { emit } = setup();
    const provider = makeReplayProvider({ turns: [toolTurn('c1', 8), stopTurn] });   // 8 > 6.5 -> fold on iter 2
    const ctx = makeContext({ contextLimit: 10, compactAt: 0.65, keepTail: 2 });
    const R = reg();
    let gotPrev = null, calls = 0;
    const summarize = async (older, prevSummary) => { calls++; gotPrev = prevSummary; return { summary: 'MERGED', usd: 0, tokens: 0 }; };
    const messages = [
      { role: 'system', content: '<conversation_summary>\nOLD RUNNING SUMMARY\n</conversation_summary>' },
      { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' }, { role: 'user', content: 'u3' }
    ];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(), context: ctx, summarize });
    A.eq(res.reason, 'done', 'run completes');
    A.ok(calls >= 1, 'a fold happened');
    A.eq(gotPrev, 'OLD RUNNING SUMMARY', 'the prior summary text was passed to the summarizer to MERGE');
    const notes = messages.filter(m => m.role === 'system' && typeof m.content === 'string' && m.content.indexOf('<conversation_summary>') === 0);
    A.eq(notes.length, 1, 'exactly ONE conversation_summary note after the fold (merged, not stacked)');
    A.ok(/MERGED/.test(notes[0].content) && notes[0].content.indexOf('OLD RUNNING SUMMARY') === -1, 'the surviving note is the new merged summary, the old raw note is gone');
  }

  // ---- 2. SAVINGS ANTI-THRASH: two <10% folds in a row -> compaction turns off (paid calls bounded) ----
  {
    const { seq, emit } = setup();
    const ctx = {                                                   // injected context whose folds barely shrink
      shouldCompact: () => true,
      estimateMessages: () => 96,                                   // after(96) vs before(100 from usage) -> 4% savings
      planCompaction: (arr) => ({ older: arr.slice(0, Math.max(1, arr.length - 1)), tail: arr.slice(Math.max(1, arr.length - 1)) })
    };
    const R = reg();
    let calls = 0;
    const summarize = async () => { calls++; return { summary: 'S', usd: 0, tokens: 0 }; };
    const provider = makeReplayProvider({ turns: [toolTurn('c1', 100), toolTurn('c2', 100), toolTurn('c3', 100), toolTurn('c4', 100), stopTurn] });
    const messages = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: R.wireFormat(), dispatch: (c, ctx2) => R.dispatch(c, ctx2), capCtx: openCtx(), context: ctx, summarize });
    A.eq(res.reason, 'done', 'run completes');
    const compacts = seq.filter(e => e.name === 'agent.compact').length;
    A.eq(calls, 2, 'summarizer called exactly twice — compaction switched off after two sub-10% folds');
    A.eq(compacts, 2, 'exactly two agent.compact events despite four threshold-crossing tool turns');
  }

  A.report('compaction.test');
})();
