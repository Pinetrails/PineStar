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

  // TEXT TOOL-CALL MARKUP SCRUB (model-consistency sweep 2026-07-17; aligned with the reference harness):
  // some models (Kimi/Qwen/GLM/Gemma families) emit tool-call markup — `<tool_call>{"name":…}</tool_call>`,
  // `<function_call>…`, Gemma's `<function name="…">…</function>` — as PLAIN TEXT instead of the tool_calls
  // wire. The markup must NEVER be executed: the reference harness's #47967 class showed weak models ECHO
  // tool-call markup they saw in file contents or tool output, so executing it would let FILE DATA drive
  // tool execution (an injection vector). Instead: strip the blocks from the kept text (raw XML never shows
  // as a "final answer") and, when tools are wired, the caller nudges the model once — the wire here is
  // intact (tools are never dropped; provider-compatibility law), so a model that MEANT to act re-emits the
  // call properly next turn, and an echo of data continues without it. The `<function>` variant is gated on
  // a name= attribute at a block boundary so prose like "use <function> in JS" is preserved.
  const TEXT_MARKUP_RES = [
    /<tool_call>[\s\S]*?<\/tool_call>/gi,
    /<tool_calls>[\s\S]*?<\/tool_calls>/gi,
    /<function_call>[\s\S]*?<\/function_call>/gi,
    /<function_calls>[\s\S]*?<\/function_calls>/gi,
    /(?:(?<=^)|(?<=[\n\r.!?:]))[ \t]*<function\b[^>]*\bname\s*=[^>]*>[\s\S]*?<\/function>/gi
  ];
  function scrubTextToolCallMarkup(text) {
    let t = String(text == null ? '' : text);
    let found = false;
    for (const re of TEXT_MARKUP_RES) {
      re.lastIndex = 0;
      if (!re.test(t)) continue;
      re.lastIndex = 0;
      found = true;
      t = t.replace(re, '');
    }
    if (!found) return null;
    return { text: t.replace(/\n{3,}/g, '\n\n').trim() };
  }

  // REASONING RIDES THE TURN IT CAME FROM. When a provider signs its thinking blocks (Anthropic does), the
  // NEXT request must replay them unedited alongside that turn's tool_calls or the signature check fails and
  // the run dies. The loop stays provider-agnostic: it parks whatever opaque blocks the adapter handed over
  // and hands them straight back. Adapters that emit no 'reasoning' event leave the field absent, so every
  // other provider's message shape is byte-identical to before.
  function assistantTurn(text, calls, reasoning) {
    const msg = { role: 'assistant', content: text || '' };
    if (calls.length) {
      msg.tool_calls = calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argsRaw || '{}' } }));
    }
    if (Array.isArray(reasoning) && reasoning.length) msg.reasoning = reasoning.slice();
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
    let finalControl = null;
    for (const c of calls) {
      if (finalControl) {
        results.push({ callId: c.id, isError: true, ok: false, content: 'skipped: the Task Brief paused for the Commander', control: null });
        continue;
      }
      const hidden = meta.hiddenTools && meta.hiddenTools.has(c.name);
      if (!hidden) emit('agent.tool_call', { agentId: meta.agentId, runId: meta.runId, callId: c.id, name: c.name || 'unknown', argsSummary: summarize(c.argsRaw) });
      const t0 = meta.clock ? meta.clock.now() : 0;
      let r;
      try { r = await dispatch(c, capCtx); }
      catch (e) { r = { ok: false, isError: true, content: 'tool dispatch threw: ' + (e && e.message), summary: 'error' }; }
      r = r || { ok: false, isError: true, content: 'tool returned nothing', summary: 'error' };
      const t1 = meta.clock ? meta.clock.now() : 0;
      results.push({ callId: c.id, isError: !!r.isError, ok: !!r.ok, content: r.content, control: r.control || null });
      if (r.control && r.control.final) finalControl = r.control;
      if (!hidden) emit('agent.tool_result', {
        agentId: meta.agentId, runId: meta.runId, callId: c.id, ok: !!r.ok,
        ms: Math.max(0, t1 - t0), summary: r.summary || (r.isError ? 'error' : 'ok'), isError: !!r.isError
      });
    }
    return results;
  }

  // Pure heuristic for the continuation guard: does a final, tool-free text ANNOUNCE work the model never did?
  // Tuned to the observed narrate-then-stop family: "Let me read…", "I'll fix…", "Now let me check…",
  // "Reading the file now", "Fixing all three now." Deliberately conservative — "let me know…" (a closing
  // pleasantry) never matches. A false positive costs one bounded extra turn; a false negative just keeps
  // today's behavior. Only the tail is scanned: intent that ends a message is what signals a premature stop.
  const CG_VERBS = 'read|re-?read|check|look|open|find|fix|run|apply|write|patch|search|scan|inspect|start|create|update|edit|trace|dig|verify|test|grep|examine|review|implement|investigate|continue|proceed|execute|analy[sz]e|debug';
  const CG_GERUNDS = 'reading|checking|looking|opening|finding|fixing|running|applying|writing|patching|searching|scanning|inspecting|starting|creating|updating|editing|tracing|digging|verifying|testing|examining|reviewing|implementing|investigating|proceeding|executing|analy[sz]ing|debugging';
  const CG_PATTERNS = [
    new RegExp('\\blet me\\s+(?!know\\b)[a-z]', 'i'),                                                       // "Let me read the file"
    new RegExp('\\b(i\'?ll|i\\s+will|i\'?m\\s+going\\s+to|about\\s+to|now\\s+i(?:\'?ll|\\s+will)?)\\s+(now\\s+)?(' + CG_VERBS + ')\\b', 'i'),  // "I'll fix all three"
    new RegExp('\\b(' + CG_GERUNDS + ')\\b[^.!?\\n]{0,80}\\bnow\\b', 'i'),                                  // "Reading the full main.js now"
    new RegExp('\\bnow\\b[^.!?\\n]{0,40}\\b(' + CG_GERUNDS + ')\\b', 'i')                                   // "now fixing the death path"
  ];
  /* VERIFY-ON-STOP (2026-07-27). The station's whole promise is that nothing is claimed unless it is proven,
     and "fake done" — an edit shipped as finished without a single check run against it — is the failure this
     project pays for most. The system prompt already INSTRUCTS the model to verify after editing; nothing
     ENFORCED it, so an instruction was all it was. This turns the passive instruction into a bounded
     follow-up: a run that mutated CODE and then tries to finish with no fresh evidence buys exactly one more
     turn to produce some.

     Deliberately narrow, because a false nudge costs a paid turn:
       · Only a SUCCESSFUL mutation of a non-prose path arms it. A README or a SKILL.md edit has nothing to run.
       · Any successful verification DISARMS it — verify.run, or a shell command that reads like a real check.
       · It never fires without a verification tool actually wired, never on the grace turn (contracted to be
         tool-free), and at most once per run, so a model that refuses to verify still terminates. */
  const VOS_PROSE_EXT = new Set(['md', 'markdown', 'mdx', 'rst', 'txt', 'text', 'adoc', 'asciidoc', 'org', 'log', 'csv', 'tsv', 'json5']);
  const VOS_PROSE_NAME = new Set(['license', 'licence', 'notice', 'authors', 'contributors', 'changelog', 'codeowners', 'readme']);
  // Wire names arrive underscored (the OpenAI function-name grammar forbids '.'), registry names dotted.
  const vosKey = (n) => String(n == null ? '' : n).toLowerCase().replace(/\./g, '_');
  const VOS_MUTATORS = new Set(['fs_write', 'fs_edit', 'fs_patch', 'fs_append']);
  const VOS_VERIFIERS = new Set(['verify_run']);
  // A check is a command whose whole job is to PASS or FAIL. `git status`, `ls`, `cat` are not evidence.
  const VOS_CHECK_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)|\b(pytest|tox|jest|vitest|mocha|ava|tsc|eslint|ruff|mypy|flake8|rubocop|clippy|gradle|mvn|make)\b|\b(cargo|go|dotnet|swift)\s+(test|build|vet)\b|\bnode\s+[^|;&]*\btest\b/i;
  function vosIsCodePath(p) {
    const s = String(p == null ? '' : p).trim();
    if (!s) return false;
    const base = s.split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return !VOS_PROSE_NAME.has(base.toLowerCase());   // extension-less: only prose NAMES are exempt
    const ext = base.slice(dot + 1).toLowerCase();
    if (VOS_PROSE_EXT.has(ext)) return false;
    return !VOS_PROSE_NAME.has(base.slice(0, dot).toLowerCase());
  }
  // The path a mutating call targeted, under any of the arg names the fs tools use.
  function vosPathOf(args) {
    if (!args || typeof args !== 'object') return '';
    for (const k of ['path', 'file', 'filename', 'target', 'rel']) if (typeof args[k] === 'string' && args[k]) return args[k];
    return '';
  }
  function vosIsCheckCommand(args) {
    if (!args || typeof args !== 'object') return false;
    const cmd = args.command || args.cmd || args.script || '';
    return VOS_CHECK_RE.test(String(cmd));
  }

  function announcesIntent(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return false;
    const tail = t.slice(-600);
    for (const re of CG_PATTERNS) if (re.test(tail)) return true;
    return false;
  }

  async function runAgentLoop(o) {
    const messages = o.messages;
    let provider = o.provider;
    const emit = o.emit;
    // COPIED, not aliased: a tool.search reveal APPENDS here, and the caller's array is built once per run and
    // must not grow underneath it.
    const tools = (o.tools || []).slice();
    /* TOOL SEARCH: wire declarations for tools this agent was GRANTED but that are not advertised (CAP_REGISTRY
       `deferred: true`). They are held here, out of the request, until tool.search reveals one. The loop owns
       this rather than the tool because the model can only ever emit a tool_use for a DECLARED tool — so
       revealing is necessarily an act on the request, not something a tool can do to itself. */
    /* Keyed by the WIRE name, because that is the one form both sides can agree on. The caller renames
       dotted tool names to underscores before handing them over (the OpenAI function-name grammar forbids
       '.'), while a reveal signal carries the registry's REAL dotted name — so a raw lookup misses every
       time and the reveal silently does nothing. Underscoring is idempotent, so normalising both sides
       through it is safe whether or not the caller renamed anything. */
    const wireKey = n => String(n == null ? '' : n).replace(/\./g, '_');
    const deferredDefs = new Map();
    for (const d of (o.deferredTools || [])) {
      const n = d && d.function && d.function.name;
      if (n) deferredDefs.set(wireKey(n), d);
    }
    const limits = o.limits || {};
    const maxIters = limits.maxIters || 40;
    // GRACE TURN (P0.3): when a run hits the iteration ceiling, give it ONE final no-tools turn to deliver its
    // best answer instead of dead-stopping at 'max_iters' (the reference harness's grace-call pattern). Default on; pass
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
    // reference harness's try_activate_fallback pattern. Each entry: { provider, model? }. Empty = no fallback (existing
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
    // plan so a long run never loses it (the reference harness's todo survives context compression the same way). A function
    // returning the plan text (or null); absent = no-op (existing callers byte-identical).
    const todoNote = (typeof o.todoNote === 'function') ? o.todoNote : null;
    // OPTIONAL LIVE STEERING (additive): a function drained ONCE per iteration, at the top of the loop, that
    // returns any Commander notes injected mid-run (via POST /api/run/steer). Each drained note becomes ONE
    // <steering_note> system message appended to the working set, so the NEXT model call sees it — exactly at
    // a message boundary (never mid-tool-pairing), so it can neither split a tool_call from its result nor
    // corrupt the assistant/tool interleave. Absent = never steered (existing callers byte-identical). Bounded
    // by the caller's buffer; the loop just injects whatever it's handed and emits one telemetry event.
    const steer = (typeof o.steer === 'function') ? o.steer : null;
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

    // CONTINUATION GUARD (default ON): some models (Kimi K3, live-caught 2026-07-17) end a turn by ANNOUNCING
    // the next action ("Reading the full main.js now — then fixing immediately.") with finish_reason 'stop' and
    // NO tool call. A no-tool turn normally means "final answer", so the run ends 'done' mid-task and the
    // Commander has to prod the agent repeatedly. When the final text clearly announces imminent work AND tools
    // are wired, inject ONE system nudge (act now or say you're done) and give the model another turn instead
    // of ending. Bounded: at most `continueMax` nudges per run (limits.continueGuard === false disables;
    // { max } overrides), and never on a grace turn — a narrate-forever model still terminates.
    const _cg = limits.continueGuard;
    const CG_MAX = (_cg === false) ? 0 : (_cg && _cg.max != null ? _cg.max : 2);
    let cgUsed = 0;
    // Companion nudge budgets (same disable knob as the continuation guard — they are one family):
    //  · markup nudge — the turn's TEXT carried tool-call markup (scrubbed above; NEVER executed). Tell the
    //    model once that text markup is data and to make a REAL call. Bounded like CG.
    //  · empty-after-tools nudge — the reference harness's "weaker models return empty after tool results
    //    instead of continuing" class (its #9400): one bounded push to process the results and continue,
    //    instead of ending the run 'empty' on the first silence.
    let mkUsed = 0;
    let emptyNudgeUsed = false;
    // VERIFY-ON-STOP ledger: code paths this run has CHANGED but not since proven. Any successful verification
    // empties it. limits.verifyOnStop === false disables; { max } raises the nudge budget (default 1).
    const _vos = limits.verifyOnStop;
    const VOS_MAX = (_vos === false) ? 0 : (_vos && _vos.max != null ? _vos.max : 1);
    const vosUnverified = new Set();
    let vosUsed = 0;

    // NO-OP TURN REFUND (reference-harness iteration-budget parity): a turn that produced NO tool call AND no NEW assistant
    // content (empty/whitespace text, OR text byte-identical to the immediately-prior assistant turn) is wasted work
    // — a pure failover/compaction retry that streamed nothing usable. It should NOT count against the effective
    // iteration budget. But an unbounded refund could, in principle, let a pathological all-no-op provider be
    // retried forever, so a HARD FLOOR bounds it: at most `refundMax` turns per run are ever refunded (default 8;
    // limits.refundMax overrides, 0 disables refunding entirely). Past the floor every turn — even a no-op — counts,
    // guaranteeing termination at maxIters. NOTE: this never touches loopguard state (which only advances on
    // tool-call turns, never on a no-op turn), so a refund can neither reset nor confuse a failure streak.
    const REFUND_MAX = (limits.refundMax != null) ? limits.refundMax : 8;
    let refundsUsed = 0;

    let spentUsd = 0, turns = 0, spentTokens = 0;
    const unpricedUsage = [];
    let lastUsage = null;   // the previous turn's usage, used to decide compaction before the next paid call
    let lastFinishReason = null;   // the last done-event finishReason ('length'/'content_filter' surfaced at run end)
    // OPTIONAL injected sleep for bounded mid-stream retry backoff (o.sleep(ms) -> Promise). Absent = retry with
    // NO wait (keeps the loop deterministic + test-fast); when present it honors the classifier's retryAfterMs.
    const sleep = (typeof o.sleep === 'function') ? o.sleep : null;
    // mid-stream retry backoff schedule (same shape as the adapters' pre-stream RETRY_DELAYS).
    const STREAM_RETRY_DELAYS = [400, 1200];
    function noteUnpriced(modelId, c) {
      if (!c || !c.unpriced) return;
      unpricedUsage.push({ model: modelId || '(unknown)', tokensIn: c.tokensIn || 0, tokensOut: c.tokensOut || 0 });
    }
    function end(reason, extra) {
      // A3/Lane5: surface WHY the model stopped when it's a truncation/policy stop, ADDITIVELY — on BOTH the return
      // value (index.js gates reflection/study/skills on it) AND the agent.run.end event (the frontend renders a
      // "cut short" recap instead of a delivered crate). The event field is now schema-declared (optional) so old
      // clean-run payloads — which omit it — stay valid. Only the non-clean reasons are worth surfacing.
      const cut = (lastFinishReason === 'length' || lastFinishReason === 'content_filter') ? lastFinishReason : null;
      const endPayload = { agentId, runId, reason, turns, usd: spentUsd };
      if (cut) endPayload.finishReason = cut;
      // Budget-stop legibility: a 'budget' stop names WHICH cap fired (scope + the effective $ cap), ADDITIVELY,
      // on both the event and the return — the frontend renders "hit the $X per-run spend cap → BUDGET settings"
      // instead of an unexplained stop. Scope is gated to the schema enum so a bad caller can't push an
      // out-of-contract payload; both fields are simply absent on every other reason (old payloads stay valid).
      const bs = extra && extra.budgetScope;
      if (reason === 'budget' && (bs === 'run' || bs === 'agent' || bs === 'day' || bs === 'global')) {
        endPayload.budgetScope = bs;
        if (typeof extra.budgetCapUsd === 'number' && isFinite(extra.budgetCapUsd)) endPayload.budgetCapUsd = extra.budgetCapUsd;
      }
      emit('agent.run.end', endPayload);
      const out = { reason, messages, usd: spentUsd, turns, tokens: spentTokens, model, unpricedUsage: unpricedUsage.slice() };
      if (cut) out.finishReason = cut;
      if (endPayload.budgetScope) { out.budgetScope = endPayload.budgetScope; if (endPayload.budgetCapUsd != null) out.budgetCapUsd = endPayload.budgetCapUsd; }
      return out;
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
      /* MEASURE BOTH SIDES WITH THE SAME RULER. `before` used to be the provider's real prompt_tokens while
         `after` is a local estimate, so `removed` mixed two units: the emitted agent.compact reported a
         fabricated saving (truthful-telemetry law), and `savings` below sat near 1.0 forever, which meant the
         anti-thrash breaker — "two folds in a row that each freed <10% -> stop compacting" — could never fire
         and a degraded run kept paying for a summarizer call every single turn. The provider's count is the
         honest one for DECIDING to compact (shouldCompact still uses it); for measuring what a fold SAVED,
         both ends must come from the same estimator. */
      const beforeTokens = context.estimateMessages(messages);
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
      if (r && typeof r === 'object') {
        spentUsd += r.usd || 0; spentTokens += r.tokens || 0;   // count the summarizer's own spend
        if (Array.isArray(r.unpricedUsage)) for (const u of r.unpricedUsage) unpricedUsage.push(u);
      }
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
      if (spentUsd >= maxCostUsd) return end('budget', { budgetScope: 'run', budgetCapUsd: maxCostUsd });   // per-RUN hard ceiling
      // CROSS-RUN BUDGET: day/global pool over the ledger. check() emits any threshold crossing itself and
      // returns a block descriptor when a soft cap is reached (no resume headroom left) -> stop as 'budget'.
      if (budget) {
        const b = budget.check(spentUsd);
        if (b) return end('budget', { budgetScope: b.scope, budgetCapUsd: b.cap });
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
      // LIVE STEERING: fold any Commander notes queued mid-run into the prompt BEFORE the next paid call. This is
      // a message-boundary injection (the prior iteration's tool results are already appended + paired), so it is
      // structurally safe. Runs after compaction so a fresh note is never folded away in the same turn it lands.
      if (steer) {
        let notes = null;
        try { notes = steer(); } catch (_) { notes = null; }
        if (Array.isArray(notes) && notes.length) {
          for (const n of notes) {
            const t = String(n == null ? '' : n).trim();
            if (!t) continue;
            // surface the note in the live transcript as an agent.token delta (a registered event) so the
            // Commander SEES their steer land, then inject it as a system message for the next model call.
            emit('agent.token', { agentId, runId, delta: '\n[steering] ' + t + '\n' });
            messages.push({ role: 'system', content: '<steering_note>' + t + '</steering_note>' });
          }
        }
      }
      const turnStart = turns;
      turns++;

      // (2) STREAM one model call — with classified RECOVERY (compress on overflow / fall back on a failover) so a
      //     transient backend failure retries the SAME turn instead of killing the run. Bounded: at most one
      //     compaction plus one switch per fallback entry, so a degraded backend can't spin.
      const acc = { text: '', toolCalls: {}, reasoning: [] };
      let usage = null, fatal = null;
      let recoveries = 0;
      const maxRecoveries = 1 + fallbacks.length;
      let retriesUsed = 0;
      const MAX_STREAM_RETRIES = 2;
      // A truncation is its own (cheap, transient) retry class — kept separate from MAX_STREAM_RETRIES and
      // deliberately tighter, because a truncation costs a FULL generation to re-run.
      let truncRetries = 0;
      const MAX_TRUNC_RETRIES = 1;
      while (true) {
        acc.text = ''; acc.toolCalls = {}; acc.reasoning = []; usage = null; lastFinishReason = null;
        let streamErr = null;
        let sawTruncation = false;
        try {
          const req = { model, messages, tools, signal, stream: true };
          for await (const ev of provider.stream(req)) {
            if (signal.aborted) break;
            if (ev.type === 'text') { acc.text += ev.delta; emit('agent.token', { agentId, runId, delta: ev.delta }); }
            else if (ev.type === 'reasoning') { if (ev.block) acc.reasoning.push(ev.block); }
            else if (ev.type === 'tool_start') { acc.toolCalls[ev.index] = { id: ev.id, name: ev.name, args: '' }; }
            else if (ev.type === 'tool_args') { if (acc.toolCalls[ev.index]) acc.toolCalls[ev.index].args += (ev.chunk || ''); }
            else if (ev.type === 'usage') { usage = ev.usage; if (cost) emit('cost.estimate', Object.assign({ agentId, runId }, cost.estimate(usage, model))); }
            else if (ev.type === 'done') { lastFinishReason = ev.finishReason; sawTruncation = !!ev.truncated; }   // A3: remember WHY the turn stopped
            // 'tool_done' needs no action here
          }
        } catch (e) { streamErr = e; }
        if (!streamErr) {
          // TRUNCATED STREAM (truthful-telemetry law). The response body ended CLEANLY mid-generation: the
          // adapter observed neither its protocol's end-of-stream sentinel nor a finish_reason. There is no
          // exception to classify, so this used to fall straight through the `break` below — a half-written
          // answer shipped as a completed delivery, and the turn recorded $0 for tokens the provider still
          // bills. Adapters that genuinely cannot tell report truncated:false, so this is inert for them.
          if (!sawTruncation) break;                 // clean, properly-terminated stream
          if (truncRetries < MAX_TRUNC_RETRIES && !signal.aborted) {
            truncRetries++;                          // a truncation is transient — re-run the turn once
            if (sleep) { try { await sleep(STREAM_RETRY_DELAYS[0]); } catch (_) {} }
            if (signal.aborted) break;
            continue;
          }
          // Retry spent. Hand it to the fatal path, which reconciles the usage the provider WILL bill before
          // ending — so a truncated turn is recorded as the transient provider failure it is, never a delivery.
          fatal = { message: 'model stream ended mid-generation (no completion marker) — the response was truncated in transit', retryable: true };
          break;
        }
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
        // A2: bounded SAME-provider retry for a retryable class that has no failover to take (e.g. `timeout`,
        // transient `unknown`) — or a fallback class whose chain is already exhausted. Without this a hung/idle
        // stream that the watchdog turned into a `timeout` would kill the run on the first blip. Bounded to
        // MAX_STREAM_RETRIES so a persistently-failing backend still terminates. Honors the server-stated wait.
        if (!signal.aborted && cls.retryable && !cls.shouldFallback && retriesUsed < MAX_STREAM_RETRIES) {
          retriesUsed++;
          // NOTE: no provider.fallback emit here — a same-provider retry is NOT a failover; emitting it would
          // inflate the floor's failover counter and lie about a model/credential switch that didn't happen
          // (truthful-telemetry law). The retry is bounded and its outcome (success or the final error) is what
          // surfaces observably.
          if (sleep) { try { await sleep(Math.min(60000, Math.max(STREAM_RETRY_DELAYS[Math.min(retriesUsed - 1, STREAM_RETRY_DELAYS.length - 1)], cls.retryAfterMs || 0))); } catch (_) {} }
          if (signal.aborted) break;   // a cancel during the backoff ends cleanly below
          continue;
        }
        fatal = cls;                                 // unrecoverable / chain exhausted / retries spent
        break;
      }
      if (fatal) {
        // A2 reconcile-on-fatal: if usage arrived before the stream failed, RECORD it before ending 'error' so the
        // ledger/spend reflect tokens the provider will bill — a fatal path must not silently drop billed usage.
        if (usage && cost) {
          const partial = cost.reconcile(usage, model);
          spentUsd += partial.usd || 0;
          spentTokens += (partial.tokensIn || 0) + (partial.tokensOut || 0);
          noteUnpriced(model, partial);
          emit('agent.cost', {
            agentId, runId, usd: partial.usd || 0, tokensIn: partial.tokensIn || 0, tokensOut: partial.tokensOut || 0,
            reasoningTokens: partial.reasoningTokens || 0, cachedTokens: partial.cachedTokens || 0, model, reconciled: true
          });
        }
        emit('agent.run.error', { agentId, runId, message: fatal.message || 'model call failed', transient: !!fatal.retryable });
        return end('error');
      }

      // cancellation mid-stream: keep partial text, then stop
      if (signal.aborted) { messages.push(assistantTurn(acc.text, [], acc.reasoning)); return end('cancelled'); }

      // (3) RECONCILE cost (authoritative; overwrites the estimate)
      const final = cost ? cost.reconcile(usage, model) : { usd: 0, tokensIn: 0, tokensOut: 0, reasoningTokens: 0, cachedTokens: 0 };
      spentUsd += final.usd || 0;
      spentTokens += (final.tokensIn || 0) + (final.tokensOut || 0);
      noteUnpriced(model, final);
      lastUsage = usage;   // feeds the next turn's compaction decision (shouldCompact reads prompt_tokens)
      emit('agent.cost', {
        agentId, runId, usd: final.usd || 0, tokensIn: final.tokensIn || 0, tokensOut: final.tokensOut || 0,
        reasoningTokens: final.reasoningTokens || 0, cachedTokens: final.cachedTokens || 0, model, reconciled: true
      });

      // (4) APPEND assistant turn FIRST. Capture the prior assistant text BEFORE appending, so a no-op turn whose
      // content merely duplicates the previous assistant turn can be detected below.
      let priorAssistantText = null;
      for (let mi = messages.length - 1; mi >= 0; mi--) { if (messages[mi].role === 'assistant') { priorAssistantText = String(messages[mi].content == null ? '' : messages[mi].content); break; } }
      const calls = Object.keys(acc.toolCalls).sort((a, b) => a - b).map((k, i) => parseCall(acc.toolCalls[k], i));
      // TEXT TOOL-CALL MARKUP: a zero-wire-call turn whose TEXT carries tool-call markup is neither a final
      // answer nor a call to execute (echoed markup = data; see scrubTextToolCallMarkup). Strip it from the
      // kept turn; the stop branch below nudges the model to make a REAL call.
      let textMarkup = false;
      if (calls.length === 0) {
        const scrubbed = scrubTextToolCallMarkup(acc.text);
        if (scrubbed) { textMarkup = true; acc.text = scrubbed.text; }
      }
      repairCalls(calls, emit, agentId, runId);   // L2: fix broken tool-call JSON before it is used or discarded
      messages.push(assistantTurn(acc.text, calls, acc.reasoning));

      // (5) STOP iff no tool calls accumulated. A no-op turn (no tool call + no NEW assistant content) is refunded
      //     so it doesn't burn the iteration budget — bounded by REFUND_MAX (the hard floor guaranteeing termination).
      if (calls.length === 0) {
        const text = String(acc.text || '');
        const empty = !text.trim();                                   // nothing usable produced
        const duplicate = !empty && priorAssistantText != null && text === priorAssistantText;   // a re-emitted prior turn
        // MARKUP NUDGE: the turn's text carried tool-call markup (scrubbed above, never executed). Point the
        // model at the real wire once — a model that meant to act re-emits the call properly; an echo of
        // quoted data just continues without it. Shares the continuation-guard disable knob and grace rule.
        if (textMarkup && !graceUsed && CG_MAX > 0 && mkUsed < CG_MAX && tools.length > 0) {
          mkUsed++;
          messages.push({ role: 'system', content: '<tool_markup>Tool-call markup (e.g. <tool_call>…</tool_call>) appeared in your reply TEXT. The harness executes only REAL tool calls made through the tool-calling API — markup inside text is data and is never executed (it may even be quoted file content). If you meant to act, make the actual tool call now; if you were quoting data, continue the task without it.</tool_markup>' });
          continue;
        }
        // EMPTY-AFTER-TOOLS NUDGE (reference-harness parity): weaker models sometimes stream NOTHING right
        // after tool results instead of continuing. One bounded nudge to process the results and continue
        // beats ending the whole run 'empty' on the first silence; the empty turn is still refunded.
        if (empty && !graceUsed && !emptyNudgeUsed && CG_MAX > 0 && tools.length > 0
            && messages.slice(-6).some(m => m && m.role === 'tool')) {
          emptyNudgeUsed = true;
          if (refundsUsed < REFUND_MAX) {
            refundsUsed++;
            turns = turnStart;
            emit('iteration.refunded', { agentId, runId, turn: turnStart, reason: 'empty', refundsUsed });
          }
          messages.push({ role: 'system', content: '<continue_after_tools>You returned an empty reply after tool results. Process the tool results above and continue the task now; if the task is fully complete, give your final answer.</continue_after_tools>' });
          continue;
        }
        // CONTINUATION GUARD: an announce-without-acting final turn ("Reading main.js now…" + zero tool calls)
        // is a premature stop, not a delivery — nudge the model back to work instead of ending 'done' mid-task.
        // Never fires on a grace turn (that turn is CONTRACTED to be tool-free) and never past CG_MAX, so a
        // model that narrates forever still terminates through the normal end below.
        if (!empty && !duplicate && !graceUsed && cgUsed < CG_MAX && tools.length > 0 && announcesIntent(text)) {
          cgUsed++;
          messages.push({ role: 'system', content: '<continuation>Your last message only ANNOUNCED an action but you called no tools — ending your reply without tool calls ends the run with the work not done. Do not narrate intentions. If work remains, make the actual tool call(s) NOW in this same turn; if the task is truly complete, give your final answer without announcing further actions.</continuation>' });
          continue;
        }
        // VERIFY-ON-STOP: the run CHANGED code and is now trying to finish without having run anything against
        // it. Spend one bounded turn asking for evidence instead of shipping an unproven claim of done. Gated
        // on a verification tool actually being wired — demanding proof the run has no way to produce would
        // just burn a turn. Never on the grace turn, which is contracted to be tool-free.
        if (!empty && !graceUsed && vosUsed < VOS_MAX && vosUnverified.size
            && tools.some(t => { const n = vosKey(t && t.function && t.function.name); return VOS_VERIFIERS.has(n) || n === 'shell_exec'; })) {
          vosUsed++;
          const touched = Array.from(vosUnverified).slice(0, 8).join(', ');
          messages.push({ role: 'system', content: '<verify_before_done>You changed code in this run (' + touched + ') and are ending without running anything against it. Code that compiles is not code that works, and an unverified claim of "done" is the one thing this station never ships. Run the narrowest real check that proves the change — the project\'s own test/build command via verify_run, or shell_exec if that fits better — then report what it actually returned. If you genuinely cannot run a check here, say so plainly and state what you did NOT verify.</verify_before_done>' });
          continue;
        }
        if ((empty || duplicate) && refundsUsed < REFUND_MAX) {
          refundsUsed++;
          turns = turnStart;                                          // refund: this turn didn't advance the budget
          emit('iteration.refunded', { agentId, runId, turn: turnStart, reason: empty ? 'empty' : 'duplicate', refundsUsed });
        }
        // TRUTHFUL TELEMETRY (audit 1.7): a final turn that produced ZERO tools AND no text is NOT a clean delivery —
        // a degraded provider streaming empty completions would otherwise read as a successful 'done'. End it as
        // 'empty' (an ADDITIVE agent.run.end reason value; see shared/events.js) so index.js skips reflection/study/
        // skill-review, the cron settle path never emits workitem.delivered, and the frontend renders "ended: empty"
        // instead of a delivered crate. A DUPLICATE turn is different: it re-emitted a REAL prior answer, so it stays
        // 'done' (the answer exists — only the genuinely empty final turn is degraded).
        return end(empty ? 'empty' : 'done');
      }

      // (6) EXECUTE — needs a dispatcher (M1.2+)
      if (!dispatch) {
        for (const c of calls) messages.push(toolResultMsg(c.id, true, 'no tool dispatcher configured'));
        emit('agent.run.error', { agentId, runId, message: 'tool call requested but no dispatcher configured', transient: false });
        return end('error');
      }
      let results;
      try {
        results = await executeCalls(calls, dispatch, capCtx, emit, { agentId, runId, clock, hiddenTools: new Set(o.hiddenTools || []) });
        assertPaired(calls, results); // (7) HARD INVARIANT
      } catch (e) {
        emit('agent.run.error', { agentId, runId, message: String((e && e.message) || e), transient: false });
        return end('error');
      }
      for (const r of results) messages.push(toolResultMsg(r.callId, r.isError, r.content));

      // VERIFY-ON-STOP LEDGER. Only SUCCESSFUL calls move it: a write that errored changed nothing to verify,
      // and a check that errored is not evidence that anything passed. A verification clears the whole set
      // rather than one path — a project's check runs the project, not a file.
      if (VOS_MAX > 0) {
        const okById = {};
        for (const r of results) okById[r.callId] = !!r.ok && !r.isError;
        for (const c of calls) {
          if (!okById[c.id]) continue;
          const k = vosKey(c.name);
          if (VOS_VERIFIERS.has(k) || (k === 'shell_exec' && vosIsCheckCommand(c.args))) { vosUnverified.clear(); continue; }
          if (VOS_MUTATORS.has(k)) { const p = vosPathOf(c.args); if (vosIsCodePath(p)) vosUnverified.add(p); }
        }
      }

      /* TOOL SEARCH reveal — the one thing in a run that changes the advertised tool set, and it only ever
         APPENDS. A revealed tool is callable from the NEXT model call onward; it was already granted, so
         nothing here widens capability (the gate, consent broker and kill-switch never consulted this list).
         A name that is missing from the map was already revealed or was never deferred — skipping is correct
         in both cases and keeps a repeated search idempotent.
         COST NOTE: a provider renders tools BEFORE system, so growing this array invalidates the cached prefix
         for exactly one turn and it re-warms on the next (see providers/anthropic.js). Searches are rare and
         the saving is per-turn, so that trade is strongly positive — but it is why reveals append in one
         batch here rather than trickling one tool at a time. */
      for (const r of results) {
        const reveal = r.control && r.control.revealTools;
        if (!Array.isArray(reveal)) continue;
        for (const name of reveal) {
          const key = wireKey(name);
          const def = deferredDefs.get(key);
          if (!def) continue;
          deferredDefs.delete(key);
          tools.push(def);
        }
      }

      const finalControl = results.map(r => r.control).find(c => c && c.final);
      if (finalControl) {
        const controlText = String(finalControl.text || '').trim();
        if (controlText) {
          messages.push({ role: 'assistant', content: controlText });
          // The delta lands on its OWN line: the client accumulates deltas into one reply string, and a
          // control marker glued to the model's trailing prose ("…one key thing:TASK_QUESTION: …") fails
          // the line-anchored TASK_QUESTION parse — raw marker leaked, no chips (live-caught 2026-07-16).
          emit('agent.token', { agentId, runId, delta: '\n\n' + controlText });
        }
        return end(finalControl.reason || 'done');
      }

      // (8) LOOP GUARD — break out of a run that keeps making the SAME failing tool call. Warn once, then stop.
      if (LG_WARN || LG_STOP) {
        const sigOf = {};
        for (const c of calls) sigOf[c.id] = (c.name || '') + '\u0000' + (c.argsRaw || '');
        for (const r of results) {
          const sig = sigOf[r.callId];
          if (sig == null) continue;
          if (!r.isError) { lgFails.delete(sig); lgWarned.delete(sig); continue; }   // a success clears the streak
          const n = (lgFails.get(sig) || 0) + 1; lgFails.set(sig, n);
          const nm = sig.split('\u0000')[0] || 'a tool';
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

  return { runAgentLoop, _internals: { parseCall, repairCalls, assistantTurn, toolResultMsg, assertPaired, executeCalls, announcesIntent, scrubTextToolCallMarkup, vosIsCodePath, vosIsCheckCommand, vosKey } };
});
