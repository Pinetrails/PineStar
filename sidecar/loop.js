/* sidecar/loop.js — the agentic loop. Single messages-array while-loop (Claude Code shape);
   the only mutable state is `messages`. Pure & deterministic given injected provider / emit /
   clock / signal. Every observable transition is a validated U.bus event (via the injected emit).

   runAgentLoop({ messages, provider, emit, tools, limits, signal, clock, cost, dispatch, capCtx,
                  agentId, runId, model, trigger }) -> { reason, messages, usd, turns }

   Invariants:
     - GUARDS run before any paid call (cancelled / max_iters / budget).
     - Tool calls accumulate BY INDEX (id+name on first fragment, arg-string concat on the rest);
       JSON.parse happens once after the stream, guarded.
     - STOP iff zero tool calls accumulated (defends vs providers mis-reporting finish_reason).
     - Every requested tool-call id gets exactly one tool_result before the next model call
       (assertPaired); errors/timeouts/denials become isError results, never thrown out of the loop.
   Tool execution (dispatch/capCtx) arrives at M1.2+; with no dispatcher a tool request is a
   typed error rather than a crash. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./providers/sanitize.js'), require('./providers/errorClass.js'));
  else { root.SK = root.SK || {}; root.SK.loop = factory(root.SK.providers && root.SK.providers.sanitize, root.SK.providers && root.SK.providers.errorClass); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sanitize, errorClass) {
  'use strict';

  // tool-call argument repair (L2): recover mechanically-broken JSON from non-Anthropic models. Degrades to
  // identity if the module is absent (e.g. a browser build that never runs the loop).
  const repairToolCallArguments = (sanitize && sanitize.repairToolCallArguments) || ((s) => s);
  // API error classification (L3): makes `transient` on agent.run.error honest. Degrades to non-retryable if absent.
  const classifyApiError = (errorClass && errorClass.classifyApiError) || (() => ({ retryable: false, message: '' }));

  function summarize(s, n) { s = String(s == null ? '' : s); n = n || 80; return s.length > n ? s.slice(0, n) : s; }
  function clip(s, n) { s = String(s == null ? '' : s); n = n || 80; return s.length > n ? s.slice(0, n) + '…' : s; }
  function onlyStructural(s) { return /^[\s{}\[\],:]*$/.test(String(s == null ? '' : s)); }

  function parseCall(tc, index) {
    let args = {}, parseError = null;
    if (tc.args) { try { args = JSON.parse(tc.args); } catch (e) { parseError = 'invalid tool arguments JSON'; } }
    return { id: tc.id || ('call_' + index), name: tc.name, args, argsRaw: tc.args || '', parseError };
  }

  // Recover mechanically-broken tool-call argument JSON BEFORE the call is discarded as a parseError. A genuine
  // structural fix rewrites args + argsRaw (so the replayed assistant turn carries valid JSON) and clears
  // parseError, emitting one tool.args.repaired. A give-up '{}' on content-bearing args is NOT accepted — the
  // call keeps its parseError and becomes one clean isError result downstream (never a silent empty-args run).
  // Pure: same calls -> same emits -> byte-identical stream.
  function repairCalls(calls, emit, agentId, runId) {
    for (const c of calls) {
      if (!c.parseError) continue;
      const fixed = repairToolCallArguments(c.argsRaw);
      if (fixed === c.argsRaw) continue;
      let parsed = null; try { parsed = JSON.parse(fixed); } catch (e) { continue; }
      if (fixed === '{}' && !onlyStructural(c.argsRaw)) continue;   // unrepairable content -> keep the parseError
      emit('tool.args.repaired', { agentId, runId, callId: c.id, name: c.name || 'unknown', before: clip(c.argsRaw), after: clip(fixed) });
      c.args = parsed; c.argsRaw = fixed; c.parseError = null;
    }
  }

  function assistantTurn(text, calls) {
    const msg = { role: 'assistant', content: text || '' };
    if (calls.length) {
      msg.tool_calls = calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argsRaw || '{}' } }));
    }
    return msg;
  }

  function toolResultMsg(callId, isError, content) {
    const body = String(content == null ? '' : content);
    return { role: 'tool', tool_call_id: callId, content: isError ? ('ERROR: ' + body) : body };
  }

  function assertPaired(calls, results) {
    const a = calls.map(c => c.id).sort();
    const b = results.map(r => r.callId).sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error('tool id pairing violated: requested [' + a + '] answered [' + b + ']');
    }
  }

  // read-only concurrent / mutating sequential is a later optimization; M1 runs sequentially.
  // Every call gets exactly one result (success / error / timeout / denial) — never thrown.
  async function executeCalls(calls, dispatch, capCtx, emit, meta) {
    const results = [];
    for (const c of calls) {
      emit('agent.tool_call', { agentId: meta.agentId, runId: meta.runId, callId: c.id, name: c.name || 'unknown', argsSummary: summarize(c.argsRaw) });
      const t0 = meta.clock ? meta.clock.now() : 0;
      let r;
      try { r = await dispatch(c, capCtx); }
      catch (e) { r = { ok: false, isError: true, content: 'tool dispatch threw: ' + (e && e.message), summary: 'error' }; }
      r = r || { ok: false, isError: true, content: 'tool returned nothing', summary: 'error' };
      const t1 = meta.clock ? meta.clock.now() : 0;
      results.push({ callId: c.id, isError: !!r.isError, ok: !!r.ok, content: r.content });
      emit('agent.tool_result', {
        agentId: meta.agentId, runId: meta.runId, callId: c.id, ok: !!r.ok,
        ms: Math.max(0, t1 - t0), summary: r.summary || (r.isError ? 'error' : 'ok'), isError: !!r.isError
      });
    }
    return results;
  }

  async function runAgentLoop(o) {
    const messages = o.messages;
    const provider = o.provider;
    const emit = o.emit;
    const tools = o.tools || [];
    const limits = o.limits || {};
    const maxIters = limits.maxIters || 10;
    const maxCostUsd = (limits.maxCostUsd != null) ? limits.maxCostUsd : Infinity;
    const signal = o.signal || { aborted: false };
    const clock = o.clock;
    const cost = o.cost;
    const dispatch = o.dispatch;
    const capCtx = o.capCtx;
    const agentId = o.agentId || 'agent';
    const runId = o.runId || 'run';
    const model = o.model || 'replay/model';
    const trigger = o.trigger || 'directive';
    const approxTokens = o.approxTokens || 0;   // initial rough estimate; feeds the error classifier's overflow ratio
    const contextLimit = o.contextLimit || 0;   // 0 = unknown (cold catalog) -> the ratio heuristic is skipped
    // OPTIONAL cross-run cost governor (sidecar/budget.js): consulted in the guards each turn; null = ungoverned
    // (every existing caller/test, byte-identical). The per-RUN ceiling stays maxCostUsd below.
    const budget = o.budget;
    // OPTIONAL context manager (sidecar/context.js) + summarizer for auto-compaction; both absent = never compact.
    const context = o.context;
    const summarize = o.summarize;

    let spentUsd = 0, turns = 0, spentTokens = 0;
    let lastUsage = null;   // the previous turn's usage, used to decide compaction before the next paid call
    function end(reason) {
      emit('agent.run.end', { agentId, runId, reason, turns, usd: spentUsd });
      return { reason, messages, usd: spentUsd, turns, tokens: spentTokens };
    }

    // Fold older history into a summary when the live prompt is past the context manager's threshold, so a long
    // run shrinks instead of overflowing. Tool-pairing-safe (planCompaction snaps the boundary); only compacts
    // when a REAL summary comes back (a failed/empty summarizer skips this turn — never a silent context drop).
    async function maybeCompact() {
      if (!context || !lastUsage || !context.shouldCompact(lastUsage)) return;
      let i = 0;
      while (i < messages.length && messages[i].role === 'system') i++;   // leading system prefix kept verbatim
      const prefix = messages.slice(0, i);
      const plan = context.planCompaction(messages.slice(i));
      if (!plan.older.length) return;                                     // nothing safely foldable yet
      const beforeTokens = lastUsage.prompt_tokens || lastUsage.promptTokens || 0;
      let summary = '';
      try { summary = summarize ? await summarize(plan.older) : ''; } catch (e) { return; }
      if (signal.aborted || !summary) return;
      const note = { role: 'system', content: '<conversation_summary>\n' + summary + '\n</conversation_summary>' };
      const rebuilt = prefix.concat([note], plan.tail);
      const afterTokens = context.estimateMessages(rebuilt);
      messages.length = 0; for (const mm of rebuilt) messages.push(mm);
      lastUsage = null;   // the next turn re-measures against the compacted prompt before considering another fold
      emit('agent.compact', { agentId, runId, beforeTokens, afterTokens, removed: Math.max(0, beforeTokens - afterTokens), reason: 'context' });
    }

    emit('agent.run.start', { agentId, runId, trigger, model });

    while (true) {
      // (1) GUARDS — before any paid call
      if (signal.aborted) return end('cancelled');
      if (turns >= maxIters) return end('max_iters');
      if (spentUsd >= maxCostUsd) return end('budget');   // per-RUN hard ceiling
      // CROSS-RUN BUDGET: day/global pool over the ledger. check() emits any threshold crossing itself and
      // returns a block descriptor when a soft cap is reached (no resume headroom left) -> stop as 'budget'.
      if (budget) {
        const b = budget.check(spentUsd);
        if (b) return end('budget');
      }
      // COMPUTE GATE: a model turn needs a compute capability (a computer in the room).
      if (capCtx && typeof capCtx.canRun === 'function' && !capCtx.canRun()) {
        emit('capdenied', { agentId, need: 'compute', reason: capCtx.computeReason || 'no compute capability in room' });
        return end('error');
      }
      // CONTEXT COMPACTION: fold older turns into a summary if the last prompt crossed the threshold (no-op
      // until a context manager + summarizer are injected). Runs before turns++ so it cannot inflate the count.
      await maybeCompact();
      if (signal.aborted) return end('cancelled');   // a cancel during summarization ends cleanly
      turns++;

      // (2) STREAM one model call
      const acc = { text: '', toolCalls: {} };
      let usage = null;
      try {
        const req = { model, messages, tools, signal, stream: true };
        for await (const ev of provider.stream(req)) {
          if (signal.aborted) break;
          if (ev.type === 'text') { acc.text += ev.delta; emit('agent.token', { agentId, runId, delta: ev.delta }); }
          else if (ev.type === 'tool_start') { acc.toolCalls[ev.index] = { id: ev.id, name: ev.name, args: '' }; }
          else if (ev.type === 'tool_args') { if (acc.toolCalls[ev.index]) acc.toolCalls[ev.index].args += (ev.chunk || ''); }
          else if (ev.type === 'usage') { usage = ev.usage; if (cost) emit('cost.estimate', Object.assign({ agentId, runId }, cost.estimate(usage, model))); }
          // 'tool_done' / 'done' need no action here
        }
      } catch (e) {
        // classify the API failure so `transient` is honest (classifier-derived, not hardcoded false). The
        // shouldFallback/shouldCompress hints have no consumer yet (single model per run, context.js unwired) —
        // they are the documented extension point for the future failover/compaction layers; for now end('error').
        const cls = classifyApiError(e, { model: model, approxTokens: approxTokens, contextLimit: contextLimit });
        emit('agent.run.error', { agentId, runId, message: cls.message || String((e && e.message) || e), transient: !!cls.retryable });
        return end('error');
      }

      // cancellation mid-stream: keep partial text, then stop
      if (signal.aborted) { messages.push(assistantTurn(acc.text, [])); return end('cancelled'); }

      // (3) RECONCILE cost (authoritative; overwrites the estimate)
      const final = cost ? cost.reconcile(usage, model) : { usd: 0, tokensIn: 0, tokensOut: 0, reasoningTokens: 0, cachedTokens: 0 };
      spentUsd += final.usd || 0;
      spentTokens += (final.tokensIn || 0) + (final.tokensOut || 0);
      lastUsage = usage;   // feeds the next turn's compaction decision (shouldCompact reads prompt_tokens)
      emit('agent.cost', {
        agentId, runId, usd: final.usd || 0, tokensIn: final.tokensIn || 0, tokensOut: final.tokensOut || 0,
        reasoningTokens: final.reasoningTokens || 0, cachedTokens: final.cachedTokens || 0, model, reconciled: true
      });

      // (4) APPEND assistant turn FIRST
      const calls = Object.keys(acc.toolCalls).sort((a, b) => a - b).map((k, i) => parseCall(acc.toolCalls[k], i));
      repairCalls(calls, emit, agentId, runId);   // L2: fix broken tool-call JSON before it is used or discarded
      messages.push(assistantTurn(acc.text, calls));

      // (5) STOP iff no tool calls accumulated
      if (calls.length === 0) return end('done');

      // (6) EXECUTE — needs a dispatcher (M1.2+)
      if (!dispatch) {
        for (const c of calls) messages.push(toolResultMsg(c.id, true, 'no tool dispatcher configured'));
        emit('agent.run.error', { agentId, runId, message: 'tool call requested but no dispatcher configured', transient: false });
        return end('error');
      }
      let results;
      try {
        results = await executeCalls(calls, dispatch, capCtx, emit, { agentId, runId, clock });
        assertPaired(calls, results); // (7) HARD INVARIANT
      } catch (e) {
        emit('agent.run.error', { agentId, runId, message: String((e && e.message) || e), transient: false });
        return end('error');
      }
      for (const r of results) messages.push(toolResultMsg(r.callId, r.isError, r.content));
    }
  }

  return { runAgentLoop, _internals: { parseCall, repairCalls, assistantTurn, toolResultMsg, assertPaired, executeCalls } };
});
