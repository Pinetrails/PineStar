/* sidecar/tools/builtin/orchestration.js — team.dispatch: the LEAD delegates subtasks to its summoned
   WORKER crew. The Stage-2 moat: a lead decomposes a task and hands subtasks to specialist workers, each of
   which runs its OWN real, independent agent loop (web/files/memory), and returns its result for the lead to
   synthesize. CONTRACT-FREE: no shared/events.js change — children emit the SAME frozen agent.run.* events,
   forwarded (lifecycle + cost only) onto the lead's bus so the floor can ANIMATE the handoff.

   makeOrchestrationTools({ runOnce, roster, key, model, provider, reasoningEffort, perWorker, newId, maxWorkers })
     runOnce   : the SAME run host the browser/cron use (injected to avoid a require cycle) — async (o) -> result
     roster    : () -> Map(agentId -> { system, name, model }) — the live crew identities (pushed by the browser)
     key       : this run's API key (per-run)        model : the lead's model (worker fallback)
     reasoningEffort: the lead's active reasoning effort, inherited by worker runs
     perWorker : per-WORKER USD ceiling (a runaway worker can't blow the lead's per-run cap)
     newId     : () -> a fresh runId for each child (crypto.randomUUID, injected so this UMD stays dep-free)
     maxWorkers: hard cap on workers per dispatch (defensive)

   Safety (verified against the run host): each worker is a DISTINCT agentId so it takes its own concurrency
   slot + its own ledger/live-budget entry while the lead's slot stays held; ctx.signal is threaded into every
   child so cancelling the lead aborts all workers; the child runOnce returning undefined (concurrency refusal /
   up-front error) is null-guarded; only the worker's FINAL assistant message is returned (never the full
   transcript) to stay under the per-run tool-output cap. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).orchestration = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  // events forwarded from a child run onto the LEAD's bus — ENOUGH to animate the handoff + keep cost honest,
  // but NOT the child's tokens/tool-calls (those would clutter the lead's COMMS). The lead reads the worker's
  // actual output from the tool RESULT, not the stream.
  const FORWARD = { 'agent.run.start': 1, 'agent.run.end': 1, 'agent.run.error': 1, 'agent.cost': 1 };

  function lastAssistant(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
    }
    return '';
  }

  function makeOrchestrationTools(deps) {
    deps = deps || {};
    const runOnce = deps.runOnce;
    const roster = (typeof deps.roster === 'function') ? deps.roster : (() => new Map());
    const key = deps.key;
    const model = deps.model;
    const provider = deps.provider || null;
    const reasoningEffort = deps.reasoningEffort || 'medium';
    const perWorker = (typeof deps.perWorker === 'number' && isFinite(deps.perWorker) && deps.perWorker > 0) ? deps.perWorker : 0;
    let _seq = 0;
    const newId = (typeof deps.newId === 'function') ? deps.newId : (() => 'child_' + (++_seq));
    const maxWorkers = (typeof deps.maxWorkers === 'number' && deps.maxWorkers > 0) ? deps.maxWorkers : 4;
    // A dispatch AWAITS one or more full worker agent-loops (each web-searching + multi-turn), which routinely
    // run for minutes. The host wraps every tool call in CAPS.toolTimeoutMs (30s — sized for fast web/file
    // tools), so WITHOUT this override team.dispatch is guaranteed to time out before any real worker returns:
    // the lead then abandons delegation and does the job solo while the orphaned worker keeps spending. So the
    // dispatch tool carries its OWN generous wall-clock backstop. Real runaway is already bounded per-worker by
    // the cost cap (perWorker) + the worker's own maxIters/per-tool timeouts; this is just the outer ceiling.
    const dispatchTimeoutMs = (typeof deps.dispatchTimeoutMs === 'number' && deps.dispatchTimeoutMs > 0) ? deps.dispatchTimeoutMs : 600000;

    const dispatchTool = {
      // own wall-clock (minutes, not the 30s fast-tool default) — see dispatchTimeoutMs above.
      timeoutMs: dispatchTimeoutMs,
      // NO consent gate: delegating to your OWN summoned crew is internal orchestration, not an outward mutation
      // (cf. notebook). The real safety is the LEAD-ONLY gate (only the watched browser run gets this tool) + the
      // per-worker/day/global budget caps + the concurrency ceiling + workers running autonomous (default-deny
      // their own mutations). Prompting on every delegation would be pure consent-fatigue.
      name: 'team.dispatch', capability: 'orchestrator', scope: 'execute', requiresConsent: false,
      description: 'Delegate subtasks to your specialist crew. Each worker runs its OWN real agent loop (live web search/read, files, memory) and returns its result for you to synthesize into the final answer. Address workers by the agentId listed under YOUR TEAM. Runs sequentially by default; pass parallel:true to run them at once.',
      schema: {
        type: 'object', required: ['workers'], properties: {
          workers: {
            type: 'array', items: {
              type: 'object', required: ['agentId', 'prompt'],
              properties: { agentId: { type: 'string' }, prompt: { type: 'string' } }
            }
          },
          parallel: { type: 'boolean' }
        }
      },
      run: async (args, ctx) => {
        if (typeof runOnce !== 'function') return { content: 'orchestration unavailable (no run host)', summary: 'error' };
        const leadId = (ctx && ctx.agentId) || 'agent';
        const crew = roster() || new Map();
        const reqs = Array.isArray(args.workers) ? args.workers.slice(0, maxWorkers) : [];
        if (!reqs.length) return { content: 'No workers specified.', summary: 'noop' };

        // forward ONLY lifecycle/cost from children onto the lead's bus (the floor animation reads agent.run.start).
        const childEmit = (name, payload) => { if (FORWARD[name] && ctx && typeof ctx.emit === 'function') { try { ctx.emit(name, payload); } catch (_) {} } };

        // validate every target up front: a real, live, OTHER worker (never self, never an unknown agentId).
        const jobs = reqs.map(w => {
          const aid = w && String(w.agentId || '');
          if (!ID_RE.test(aid)) return { agentId: aid, error: 'invalid agentId' };
          if (aid === leadId) return { agentId: aid, error: 'cannot delegate to yourself' };
          if (!crew.has(aid)) return { agentId: aid, error: 'no such live worker — summon them first, or check the agentId against YOUR TEAM' };
          return { agentId: aid, prompt: String((w && w.prompt) || ''), ident: crew.get(aid) };
        });

        const runJob = async (job) => {
          if (job.error) return { agentId: job.agentId, reason: 'error', result: job.error, usd: 0 };
          let result;
          try {
            result = await runOnce({
              key, provider,
              model: (job.ident && job.ident.model) || model,
              reasoningEffort,
              system: (job.ident && job.ident.system) || '',
              messages: [{ role: 'user', content: job.prompt }],
              agentId: job.agentId, isTask: true,
              emit: childEmit,                 // lifecycle/cost ride the lead's stream -> the floor lights the worker
              signal: ctx && ctx.signal,       // cancelling the lead aborts every worker at its pre-paid guard
              runId: newId(), trigger: 'directive', surface: 'autonomous',
              maxCostUsd: perWorker            // a runaway worker can't blow the lead's per-run ceiling
            });
          } catch (e) {
            return { agentId: job.agentId, reason: 'error', result: 'worker run failed: ' + ((e && e.message) || e), usd: 0 };
          }
          if (!result) return { agentId: job.agentId, reason: 'refused', result: 'worker could not start — the concurrency cap (SKYNET_MAX_CONCURRENT_AGENTS) is full or a sign-in is needed. Try fewer at once, or run sequentially.', usd: 0 };
          return {
            agentId: job.agentId,
            reason: result.reason || 'done',
            result: lastAssistant(result.messages) || '(the worker returned no text)',
            usd: result.usd || 0
          };
        };

        let out;
        if (args.parallel) out = await Promise.all(jobs.map(runJob));   // fan out (bounded by the concurrency gate)
        else { out = []; for (const j of jobs) out.push(await runJob(j)); }   // sequential: legible, one box at a time

        const ok = out.filter(r => r.reason === 'done').length;
        return { content: JSON.stringify(out), summary: 'dispatched ' + jobs.length + ' worker(s), ' + ok + ' done' };
      }
    };

    return { dispatchTool, register(reg) { reg.register(dispatchTool); return reg; } };
  }

  return { makeOrchestrationTools };
});
