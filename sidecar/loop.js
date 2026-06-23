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
    let provider = o.provider;
    const emit = o.emit;
    const tools = o.tools || [];
    const limits = o.limits || {};
    const maxIters = limits.maxIters || 10;
    // GRACE TURN (P0.3): when a run hits the iteration ceiling, give it ONE final no-tools turn to deliver its
    // best answer instead of dead-stopping at 'max_iters' (the Hermes grace-call pattern). Default on; pass
    // limits.grace === false to test/force the raw hard cap. Bounded: exactly one grace turn per run.
    const graceEnabled = (limits.grace !== false);
    let graceUsed = false;
    const maxCostUsd = (limits.maxCostUsd != null) ? limits.maxCostUsd : Infinity;
    const signal = o.signal || { aborted: false };
    const clock = o.clock;
    let cost = o.cost;   // swappable: a cross-provider fallback entry can carry its own cost engine (fb.cost) so
                         // spend is priced by the NEW provider's catalog after a switch (P3.1 per-provider cost).
    const dispatch = o.dispatch;
    const capCtx = o.capCtx;
    const agentId = o.agentId || 'agent';
    const runId = o.runId || 'run';
    let model = o.model || 'replay/model';
    const trigger = o.trigger || 'directive';
    const approxTokens = o.approxTokens || 0;   // initial rough estimate; feeds the error classifier's overflow ratio
    const contextLimit = o.contextLimit || 0;   // 0 = unknown (cold catalog) -> the ratio heuristic is skipped
    // OPTIONAL cross-run cost governor (sidecar/budget.js): consulted in the guards each turn; null = ungoverned
    // (every existing caller/test, byte-identical). The per-RUN ceiling stays maxCostUsd below.
    const budget = o.budget;
    // OPTIONAL context manager (sidecar/context.js) + summarizer for auto-compaction; both absent = never compact.
    const context = o.context;
    const summarize = o.summarize;
    // OPTIONAL provider FALLBACK chain — the consumer for errorClass's shouldFallback/shouldRotateCredential hints
    // (previously computed then discarded). On a classified failover (overloaded/5xx/auth/billing/rate-limit/
    // model-not-found) the loop advances to the next entry and RETRIES the same turn instead of dying — the
    // Hermes try_activate_fallback pattern. Each entry: { provider, model? }. Empty = no fallback (existing
    // callers byte-identical). Cost stays honest when entries reuse the primary provider (shared priceOf catalog).
    const fallbacks = Array.isArray(o.fallbacks) ? o.fallbacks.slice() : [];
    let fbIndex = 0;
    // OPTIONAL credential-rotation hook (P0.2): a chain entry may carry a `credKey`; the loop tracks which
    // credential is live and, as it ROTATES AWAY from one on a failover, calls onFallback({ reason, rotate,
    // credKey }) where credKey is the OUTGOING (just-failed) key. index.js uses this to cool a rate-limited /
    // auth-failed key (credpool.js) so it isn't tried first next run. No hook / no credKey = byte-identical.
    const onFallback = (typeof o.onFallback === 'function') ? o.onFallback : null;
    let activeCredKey = (o.credKey != null) ? o.credKey : null;
    // OPTIONAL todo re-injection: after a compaction folds older turns away, re-append the agent's ACTIVE task
    // plan so a long run never loses it (Hermes' todo survives context compression the same way). A function
    // returning the plan text (or null); absent = no-op (existing callers byte-identical).
    const todoNote = (typeof o.todoNote === 'function') ? o.todoNote : null;
    // LOOP GUARD (default ON): a tool called with IDENTICAL arguments that keeps FAILING is a stuck loop, not
    // progress. Warn once (a system nudge the model can act on) at warnAfter, then hard-stop at stopAfter so a
    // degraded run can't burn the whole budget spinning. Only errored, byte-identical (name+args) calls count;
    // any success of that signature clears it. limits.loopGuard === false disables it; { warnAfter, stopAfter }
    // overrides the thresholds (0 disables that tier). Pure: identical calls -> identical emits -> stable stream.
    const _lg = limits.loopGuard;
    const LG_WARN = (_lg === false) ? 0 : (_lg && _lg.warnAfter != null ? _lg.warnAfter : 3);
    const LG_STOP = (_lg === false) ? 0 : (_lg && _lg.stopAfter != null ? _lg.stopAfter : 6);
    const lgFails = new Map();    // signature (name\0args) -> failure count
    const lgWarned = new Set();   // signatures already nudged (the warn fires once)

    let spentUsd = 0, turns = 0, spentTokens = 0;
    let lastUsage = null;   // the previous turn's usage, used to decide compaction before the next paid call
    function end(reason) {
      emit('agent.run.end', { agentId, runId, reason, turns, usd: spentUsd });
      return { reason, messages, usd: spentUsd, turns, tokens: spentTokens };
    }

    // Fold older history into a summary when the live prompt is past the context manager's threshold, so a long
    // run shrinks instead of overflowing. Tool-pairing-safe (planCompaction snaps the boundary); only compacts
    // when a REAL summary comes back (a failed/empty summarizer skips — never a silent context drop). The
    // summarizer is itself a PAID sub-call: when summarize() returns {summary,usd,tokens} its reconciled cost is
    // folded into spentUsd/spentTokens HERE, so the per-run ceiling + cross-run pool guards on the NEXT turn (and
    // the run total) see it — not just at run end. After 2 consecutive failed/empty summaries, compaction gives
    // up for the rest of the run, bounding wasted paid calls against a degraded model.
    let compactionFails = 0, compactionOff = false, lowSavingsStreak = 0;
    // H5.2: a conversation_summary note from an EARLIER fold must be MERGED into the next one (one running summary),
    // never left to stack alongside a new note. Detect/strip it anywhere; its inner text seeds the merge.
    const isSummaryNote = (m) => m && m.role === 'system' && typeof m.content === 'string' && m.content.indexOf('<conversation_summary>') === 0;
    const summaryInner = (c) => String(c).replace(/^<conversation_summary>\n?/, '').replace(/\n?<\/conversation_summary>$/, '').trim();
    // force=true skips the threshold gate (used by the context_overflow error-recovery path: compact, then retry
    // the turn instead of dying). Returns true iff history was actually folded — the caller only retries on true,
    // so a no-foldable-history overflow can't spin. Existing callers pass no arg and ignore the return.
    async function maybeCompact(force) {
      if (compactionOff || !context) return false;
      if (!force && (!lastUsage || !context.shouldCompact(lastUsage))) return false;
      // H5.2: lift any prior summary OUT of the working set first — its text seeds the merge, and the rebuild below
      // re-inserts exactly ONE note, so successive folds keep a single running summary instead of stacking notes.
      let prevSummary = '';
      const working = [];
      for (const m of messages) { if (isSummaryNote(m)) { if (!prevSummary) prevSummary = summaryInner(m.content); } else working.push(m); }
      let i = 0;
      while (i < working.length && working[i].role === 'system') i++;   // leading system prefix kept verbatim
      const prefix = working.slice(0, i);
      const plan = context.planCompaction(working.slice(i));
      if (!plan.older.length) return false;                               // nothing safely foldable yet (no paid call)
      const beforeTokens = (lastUsage && (lastUsage.prompt_tokens || lastUsage.promptTokens)) || context.estimateMessages(messages);
      let r;
      try { r = summarize ? await summarize(plan.older, prevSummary) : ''; }   // prevSummary => the summarizer MERGE-updates it (H5.2)
      catch (e) { if (++compactionFails >= 2) compactionOff = true; lastUsage = null; return false; }   // summarizer threw -> skip
      if (signal.aborted) return false;
      const summary = (typeof r === 'string') ? r : ((r && r.summary) || '');
      if (!summary) { if (++compactionFails >= 2) compactionOff = true; lastUsage = null; return false; }   // empty -> don't drop history
      compactionFails = 0;
      const note = { role: 'system', content: '<conversation_summary>\n' + summary + '\n</conversation_summary>' };
      let rebuilt = prefix.concat([note], plan.tail);
      // re-append the active task plan so it rides through the compaction (folded into the after-count below)
      if (todoNote) { try { const tn = todoNote(); if (tn) rebuilt = rebuilt.concat([{ role: 'system', content: String(tn) }]); } catch (e) {} }
      const afterTokens = context.estimateMessages(rebuilt);
      messages.length = 0; for (const mm of rebuilt) messages.push(mm);
      if (r && typeof r === 'object') { spentUsd += r.usd || 0; spentTokens += r.tokens || 0; }   // count the summarizer's own spend
      lastUsage = null;   // the next turn re-measures against the compacted prompt before considering another fold
      emit('agent.compact', { agentId, runId, beforeTokens, afterTokens, removed: Math.max(0, beforeTokens - afterTokens), reason: 'context' });
      // H5.2 anti-thrash: a fold that barely shrinks the prompt isn't worth another paid summarizer call. After two
      // folds in a row that each freed <10% of the prompt, stop compacting for the rest of the run (same
      // circuit-breaker shape as compactionFails) — bounds wasted spend when the kept tail/summary already dominate.
      const savings = beforeTokens > 0 ? (beforeTokens - afterTokens) / beforeTokens : 0;
      if (savings < 0.10) { if (++lowSavingsStreak >= 2) compactionOff = true; } else { lowSavingsStreak = 0; }
      return true;
    }

    emit('agent.run.start', { agentId, runId, trigger, model });

    while (true) {
      // (1) GUARDS — before any paid call
      if (signal.aborted) return end('cancelled');
      if (turns >= maxIters) {                            // per-RUN iteration ceiling
        if (graceUsed || !graceEnabled) return end('max_iters');
        graceUsed = true;                                 // spend ONE grace turn on a final, tool-free answer
        messages.push({ role: 'system', content: '<iteration_limit>You have reached the maximum number of tool-using turns (' + maxIters + '). Do NOT call any more tools. Give your best final answer to the user now using what you already have.</iteration_limit>' });
        // fall through: the grace turn runs below; if it still calls tools, the next pass ends max_iters.
      }
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

      // (2) STREAM one model call — with classified RECOVERY (compress on overflow / fall back on a failover) so a
      //     transient backend failure retries the SAME turn instead of killing the run. Bounded: at most one
      //     compaction plus one switch per fallback entry, so a degraded backend can't spin.
      const acc = { text: '', toolCalls: {} };
      let usage = null, fatal = null;
      let recoveries = 0;
      const maxRecoveries = 1 + fallbacks.length;
      while (true) {
        acc.text = ''; acc.toolCalls = {}; usage = null;
        let streamErr = null;
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
        } catch (e) { streamErr = e; }
        if (!streamErr) break;                       // stream succeeded
        if (signal.aborted) break;                   // a cancel mid-stream: fall through to the cancel check below
        // classify so `transient` is honest, and so the shouldCompress / shouldFallback / shouldRotateCredential
        // hints drive recovery instead of being discarded.
        const cls = classifyApiError(streamErr, { model: model, approxTokens: approxTokens, contextLimit: contextLimit });
        if (recoveries < maxRecoveries && cls.shouldCompress && context && summarize) {
          // context_overflow: fold older turns away, then retry the turn. Only counts as recovery if it shrank.
          if (await maybeCompact(true)) { recoveries++; continue; }
        }
        if (recoveries < maxRecoveries && (cls.shouldFallback || cls.shouldRotateCredential) && fbIndex < fallbacks.length) {
          const fb = fallbacks[fbIndex++];
          if (fb && fb.provider) {
            // notify BEFORE switching: activeCredKey is still the OUTGOING key that just failed (cool it if rotate).
            if (onFallback) { try { onFallback({ reason: cls.reason, rotate: !!cls.shouldRotateCredential, credKey: activeCredKey, retryAfterMs: cls.retryAfterMs, resetAtMs: cls.resetAtMs }); } catch (_) {} }   // H6.1: pass the server-stated wait so the cooldown honors it
            // observable failover telemetry (P3.1): which model we left, which we moved to, and why.
            emit('provider.fallback', { agentId, runId, fromModel: model, toModel: (fb.model || model), reason: cls.reason, rotate: !!cls.shouldRotateCredential });
            if (fb.credKey != null) activeCredKey = fb.credKey;   // the entry we switch TO becomes the live credential
            if (fb.cost) cost = fb.cost;                          // cross-provider: price subsequent turns by the new provider's catalog
            provider = fb.provider;
            if (fb.model) model = fb.model;   // the next agent.cost carries the switched model — the visible failover signal
            recoveries++;
            continue;
          }
        }
        fatal = cls;                                 // unrecoverable / chain exhausted
        break;
      }
      if (fatal) {
        emit('agent.run.error', { agentId, runId, message: fatal.message || 'model call failed', transient: !!fatal.retryable });
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

      // (8) LOOP GUARD — break out of a run that keeps making the SAME failing tool call. Warn once, then stop.
      if (LG_WARN || LG_STOP) {
        const sigOf = {};
        for (const c of calls) sigOf[c.id] = (c.name || '') + ' ' + (c.argsRaw || '');
        for (const r of results) {
          const sig = sigOf[r.callId];
          if (sig == null) continue;
          if (!r.isError) { lgFails.delete(sig); lgWarned.delete(sig); continue; }   // a success clears the streak
          const n = (lgFails.get(sig) || 0) + 1; lgFails.set(sig, n);
          const nm = sig.split(' ')[0] || 'a tool';
          if (LG_STOP && n >= LG_STOP) {
            emit('agent.run.error', { agentId, runId, message: 'loop guard: ' + nm + ' failed ' + n + ' times with identical arguments — stopping a stuck loop', transient: false });
            return end('error');
          }
          if (LG_WARN && n === LG_WARN && !lgWarned.has(sig)) {
            lgWarned.add(sig);
            messages.push({ role: 'system', content: '<loop_guard>You have called ' + nm + ' with the same arguments ' + n + ' times and it keeps failing. Do not repeat the identical call — change the arguments, try another approach, or stop and report the problem.</loop_guard>' });
          }
        }
      }
    }
  }

  return { runAgentLoop, _internals: { parseCall, repairCalls, assistantTurn, toolResultMsg, assertPaired, executeCalls } };
});
