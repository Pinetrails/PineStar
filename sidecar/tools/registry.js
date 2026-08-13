/* sidecar/tools/registry.js — tool registration, per-call tool list, wire format, and the
   host-side dispatch pipeline (the security boundary). Enforcement happens BEFORE the model
   ever runs a tool, never by the model.

   makeRegistry() -> {
     register(def) -> tool,
     get(name), list(capSet) -> tool[],          // capSet = Set/array of allowed tool names or capIds
     wireFormat(tools?) -> OpenAI tools[] ,       // {type:'function', function:{name,description,parameters}}
     dispatch(call, ctx) -> { ok, isError, content, summary }   // async; NEVER throws
   }

   dispatch order (each step short-circuits to an isError result; run() is reached only if all pass):
     parseError -> unknown-tool -> capability gate (ctx.canUse) -> schema-validate ->
     consent gate (tool.requiresConsent && ctx.consent) -> pre-tool hook -> durable dispatch callback ->
     per-tool timeout -> run() once. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('../../shared/schema.js'), require('./tool.js'));
  } else {
    root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {};
    root.SK.tools.registry = factory(root.SK.schema, root.SK.tools.tool);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (schema, toolMod) {
  'use strict';

  /* CENTRAL TOOL-OUTPUT CAP (ref-parity: the reference harness's tool_output_limits). Every builtin clamps its own output today,
     which means the protection is a CONVENTION — a new tool, or an MCP server behind a new connector,
     inherits none of it, and one unbounded result is enough to blow the context window and end a run.
     This is the backstop at the single point every result already passes through, so it cannot be forgotten.

     Deliberately ABOVE the per-tool clamps (shell's maxBytes and the MCP door both sit at 64k) so those stay
     authoritative and this only ever fires for output nobody bounded — no double-truncation of a result that
     already carries its own honest "truncated" note.

     HEAD AND TAIL, not head alone: a stack trace, a test summary and an exit line all live at the END of
     command output, and a head-only cut throws away the part that answers the question. */
  const OUTPUT_MAX = (function () {
    try {
      const raw = (typeof process !== 'undefined' && process.env) ? process.env.SKYNET_TOOL_OUTPUT_MAX : '';
      const n = Number(String(raw == null ? '' : raw).trim());
      return (Number.isFinite(n) && n > 0) ? Math.floor(n) : 80000;
    } catch (_) { return 80000; }
  })();
  /* PARKING (2026-07-27): the middle of an over-cap result used to be DESTROYED. The note told the model to
     "narrow it", which is sound advice for a search but useless for output that was already the answer — a
     600k-line log, a full test run, a big query result. The work was done and paid for, and the part that
     mattered could be exactly the part thrown away, with no way to get it back except re-running the call.
     When the host wires a parker (ctx.parkOutput), the FULL output is written to the agent's workspace first
     and the note points at the file, so nothing is lost and the model can page it back at its own pace.
     No parker wired = the old behavior verbatim (tests, the /api/file helper, any bare registry). */
  function clampOutput(content, parkedPath) {
    if (typeof content !== 'string' || content.length <= OUTPUT_MAX) return content;
    const head = Math.floor(OUTPUT_MAX * 0.7), tail = OUTPUT_MAX - head;
    const dropped = content.length - head - tail;
    // The note names a NEXT ACTION. "truncated" alone invites the model to run the identical call again.
    const note = parkedPath
      ? '\n\n[... ' + dropped + ' characters elided here by the host output cap. Full size: ' + content.length + ' characters / ' + utf8Bytes(content) + ' UTF-8 bytes. THE FULL OUTPUT WAS SAVED to '
        + parkedPath + ' — read that file (in ranges if it is large) to see the part that is missing, or search '
        + 'it. Do NOT repeat this call to recover it. The end of the output follows ...]\n\n'
      : '\n\n[... ' + dropped + ' characters removed by the host output cap. Full size: ' + content.length + ' characters / ' + utf8Bytes(content) + ' UTF-8 bytes. Do not repeat this call as-is — '
        + 'narrow it: filter, page, request a smaller range, or write the full output to a file and read it back '
        + 'in parts. The end of the output follows ...]\n\n';
    return content.slice(0, head) + note + content.slice(content.length - tail);
  }

  // `images` rides ALONGSIDE content, never inside it: a tool result is a string on every wire we speak, so
  // pixels have to travel as their own field and be rendered by the loop (see loop.js SCREENSHOTS AS PIXELS).
  /* parkedPath is RETURNED, not just baked into the note text, because the loop's per-turn budget may clamp
     this same content again — and a second head+tail cut can eat the note that says where the full output
     went. The re-clamp has to be able to rewrite that pointer itself. */
  // Preserve the pre-clamp character count alongside the model-visible preview. A later aggregate/run cap may
  // have to shorten this result again; without the original count it can only say "some output was omitted",
  // which is both unhelpful and impossible to audit against the parked file.
  function utf8Bytes(value) {
    const text = String(value == null ? '' : value);
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(text, 'utf8');
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }
  const okResult = (content, summary, control, parkedPath, images, outputChars, outputBytes, mutationReceipt) => ({ ok: true, isError: false, content: clampOutput(content, parkedPath), summary: summary || 'ok', control: control || null, images: Array.isArray(images) && images.length ? images : null, parkedPath: parkedPath || null, outputChars: Number.isFinite(Number(outputChars)) ? Number(outputChars) : (typeof content === 'string' ? content.length : null), outputBytes: Number.isFinite(Number(outputBytes)) ? Number(outputBytes) : (typeof content === 'string' ? utf8Bytes(content) : null), mutationReceipt: mutationReceipt || null, receipt: mutationReceipt || null });
  const errResult = (content, summary, parkedPath, outputChars, outputBytes, mutationReceipt) => ({ ok: false, isError: true, content: clampOutput(content, parkedPath), summary: summary || 'error', parkedPath: parkedPath || null, outputChars: Number.isFinite(Number(outputChars)) ? Number(outputChars) : (typeof content === 'string' ? content.length : null), outputBytes: Number.isFinite(Number(outputBytes)) ? Number(outputBytes) : (typeof content === 'string' ? utf8Bytes(content) : null), mutationReceipt: mutationReceipt || null, receipt: mutationReceipt || null });

  // Ask the host to keep the full output. Never throws and never blocks a result: a parker that fails just
  // means we fall back to the plain clamp — losing the tail must never also lose the answer.
  async function parkIfOver(content, call, ctx) {
    if (typeof content !== 'string' || content.length <= OUTPUT_MAX) return null;
    if (!ctx || typeof ctx.parkOutput !== 'function') return null;
    try {
      const r = await ctx.parkOutput(content, { tool: (call && call.name) || 'tool' });
      return (r && r.path) ? String(r.path) : null;
    } catch (_) { return null; }
  }

  function intrinsicReceipt(preview, fullChars, fullBytes, parkedPath) {
    const note = parkedPath
      ? '[full-output receipt: ' + fullChars + ' characters / ' + fullBytes + ' UTF-8 bytes before truncation; saved once to ' + parkedPath
        + '. Read that file in ranges; do not rerun the tool merely to recover output.]'
      : '[full-output receipt: ' + fullChars + ' characters / ' + fullBytes + ' UTF-8 bytes before truncation; durable storage could not be verified. '
        + 'Do not assume the omitted bytes are recoverable.]';
    return String(preview == null ? '' : preview) + '\n\n' + note;
  }

  // Race a promise against a timeout. onTimeout (if given) fires BEFORE the reject so the caller can abort the
  // underlying work — otherwise a timed-out tool keeps running and SPENDING (worst case: a team.dispatch fan-out
  // whose workers burn tokens long after the lead gave up). The timer is always cleared on settle either way.
  function withTimeout(value, ms, onTimeout) {
    if (!ms || ms <= 0) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          if (typeof onTimeout === 'function') { try { onTimeout(); } catch (_) {} }   // abort the work BEFORE we reject
          const e = new Error('timeout'); e.__timeout = true; reject(e);
        }
      }, ms);
      Promise.resolve(value).then(
        v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        e => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
      );
    });
  }

  // Chain a child AbortController to an optional parent signal: the child aborts when the parent aborts OR when
  // the per-tool timeout fires. Threaded into ctx.signal for the dispatched run() so signal-honoring tools
  // (team.dispatch → cancel workers, web_* → cancel the fetch, shell/verify → kill the child) actually STOP on
  // timeout instead of running on. Tools that ignore ctx.signal behave exactly as before (no regression).
  function childAbort(parent) {
    const ctrl = new AbortController();
    let detach = function () {};
    if (parent) {
      if (parent.aborted) { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }
      else {
        const onAbort = () => { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } };
        try {
          parent.addEventListener('abort', onAbort, { once: true });
          detach = () => { try { parent.removeEventListener('abort', onAbort); } catch (_) {} };
        } catch (_) {}
      }
    }
    return { ctrl, detach };
  }

  function makeRegistry() {
    const tools = {};

    function register(def, registration) {
      const provenance = registration && registration.provenance === 'connector' ? 'connector' : 'host';
      const t = toolMod.makeTool(Object.assign({}, def, { provenance }));
      tools[t.name] = t;
      return t;
    }
    function get(name) { return tools[name]; }

    function list(capSet) {
      const all = Object.keys(tools).map(k => tools[k]);
      if (!capSet) return all;
      const allow = capSet instanceof Set ? capSet : new Set(capSet || []);
      return all.filter(t => allow.has(t.name) || (t.capability && allow.has(t.capability)));
    }

    function wireFormat(toolList) {
      const src = toolList || list();
      return src.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
    }

    async function dispatch(call, ctx) {
      ctx = ctx || {};
      if (call.parseError) return errResult('invalid tool arguments: ' + call.parseError);
      const tool = tools[call.name];
      if (!tool) return errResult('unknown tool: ' + call.name);

      // User-control authority is a host hardline and runs before capability/consent. Full
      // Access, cached approvals, model wording, or a lying external tool annotation cannot
      // turn an ordinary task into physical/visible desktop authority.
      let authority = null;
      if (typeof ctx.authorize === 'function') {
        try { authority = await ctx.authorize(call, tool); } catch (e) { authority = { ok: false, reason: 'authority error' }; }
        if (!authority || authority.ok !== true) return errResult('user-control denied: ' + ((authority && authority.reason) || call.name), 'user-control-denied');
      } else if (tool.impact === 'physical-input' || tool.impact === 'visible-desktop' || tool.impact === 'external-unknown') {
        return errResult('user-control denied: no run authority for ' + tool.impact, 'user-control-denied');
      }

      // capability gate (M1.3): is this tool granted to the agent right now?
      if (ctx.canUse) {
        const g = ctx.canUse(call, tool);
        if (!g || !g.ok) return errResult('capability denied: ' + ((g && g.reason) || call.name), 'capdenied');
      }

      // schema-validate args; on failure run() is NOT called
      const v = schema.validate(tool.schema || {}, call.args);
      if (!v.ok) return errResult('invalid arguments for ' + call.name + ': ' + v.errors.join('; '));

      // consent gate (M1.4): a denied/cancelled prompt performs NO action
      // external-unknown authority is itself an exact, non-cacheable one-call prompt.
      if (tool.requiresConsent && ctx.consent && !(authority && authority.oneShot === true)) {
        let c;
        try { c = await ctx.consent(call, tool); } catch (e) { c = { allow: false, reason: 'consent error' }; }
        if (!c || !c.allow) return errResult('consent denied for ' + call.name + (c && c.reason ? ': ' + c.reason : ''), 'denied');
      }

      /* HOOKS — pre_tool_call. Placed HERE, and the position is the whole security argument: it is the last
         thing before the tool runs and it is AFTER the user-control authority, the capability gate, schema
         validation and the consent broker. A hook therefore reaches only calls the station had already
         decided to allow, and the only thing it can do is take that permission away. It cannot approve what
         a gate refused, because a refusal returned above this line and never got here.
         Unwired (`ctx.hooks` absent) = every existing caller and test, byte-identical. */
      const hooks = (ctx.hooks && typeof ctx.hooks.invoke === 'function') ? ctx.hooks : null;
      const hookPayload = {
        tool_name: call.name, tool_input: call.args,
        session_id: String(ctx.runId || ''), cwd: String(ctx.cwd || ''),
        extra: { agent_id: String(ctx.agentId || ''), tool_call_id: String(call.id || ''), capability: String(tool.capability || ''), scope: String(tool.scope || '') }
      };
      if (hooks) {
        let pre = null;
        try { pre = await hooks.invoke('pre_tool_call', hookPayload); } catch (_) { pre = null; }
        if (pre && pre.blocked) {
          // Named, because "blocked" with no author is the most frustrating message a harness can print: the
          // Commander needs to know WHICH of their scripts stopped this, and the model needs to know it was
          // policy rather than a broken tool so it stops retrying.
          return errResult('blocked by your hook' + (pre.by ? ' `' + pre.by + '`' : '') + ': ' + pre.reason, 'hook-blocked');
        }
      }

      // post_tool_call is OBSERVE-ONLY (hooks.js refuses to let it block): by this point the result exists and
      // the agent is entitled to it. Its verdict is deliberately discarded — a hook that could retract a
      // finished result would be rewriting history the model may already have acted on.
      const notifyPost = async (res, ms) => {
        if (!hooks) return res;
        try {
          await hooks.invoke('post_tool_call', Object.assign({}, hookPayload, {
            extra: Object.assign({}, hookPayload.extra, {
              status: res.isError ? 'error' : 'ok',
              result: typeof res.content === 'string' ? res.content : '',
              duration_ms: ms
            })
          }));
        } catch (_) { /* an observer must never change the outcome it observed */ }
        return res;
      };

      // run once, bounded by the per-tool timeout; any throw becomes an isError result. A per-call AbortController
      // (chained to the run's parent signal) is threaded in as ctx.signal so that on TIMEOUT we abort() the work
      // before rejecting — a timed-out tool no longer keeps running/spending in the background.
      const timeoutMs = tool.timeoutMs || ctx.timeoutMs || 0;
      const child = childAbort(ctx.signal);
      const ac = child.ctrl;
      const runCtx = ac !== ctx.signal ? Object.assign({}, ctx, { signal: ac.signal }) : ctx;
      const startedAt = (ctx.clock && typeof ctx.clock.now === 'function') ? ctx.clock.now() : 0;
      const elapsed = () => ((ctx.clock && typeof ctx.clock.now === 'function') ? ctx.clock.now() - startedAt : 0);
      try {
        // This is the final host-owned seam before tool.run can begin. The run journal uses it to distinguish a
        // merely prepared mutation (safe to retry) from a dispatched mutation (outcome uncertain after a crash).
        // A failed callback returns a terminal error and the tool is NOT invoked; registry.dispatch still honors
        // its never-throw contract.
        if (typeof ctx.beforeToolExecute === 'function') {
          let boundary;
          try { boundary = await ctx.beforeToolExecute(call, tool); }
          catch (e) {
            boundary = Object.assign(errResult('tool dispatch boundary failed: ' + ((e && e.message) || String(e)), 'dispatch-boundary-failed'), {
              control: { final: true, reason: 'error', text: 'I stopped before the tool ran because its dispatch boundary failed.' }
            });
          }
          if (boundary && boundary.ok === false) return boundary;
        }
        const out = await withTimeout(tool.run(call.args, runCtx), timeoutMs, () => { try { ac.abort(new Error('tool timeout')); } catch (_) { try { ac.abort(); } catch (_) {} } });
        const shaped = (out && typeof out === 'object' && 'content' in out);
        const raw = shaped ? out.content : (out == null ? '' : out);
        // A narrower tool ceiling may already have produced a preview. `fullContent` crosses this persistence
        // seam once and is never placed directly in model context.
        const full = shaped && typeof out.fullContent === 'string' ? out.fullContent : raw;
        // Park BEFORE clamping — the clamp is what destroys the middle, so the full text has to be on disk first.
        let parked = null;
        if (typeof full === 'string' && (full !== raw || full.length > OUTPUT_MAX) && ctx && typeof ctx.parkOutput === 'function') {
          try { const p = await ctx.parkOutput(full, { tool: (call && call.name) || 'tool' }); parked = p && p.path ? String(p.path) : null; } catch (_) {}
        } else {
          parked = await parkIfOver(raw, call, ctx);
        }
        const fullBytes = typeof full === 'string' ? utf8Bytes(full) : null;
        const visible = full !== raw && typeof full === 'string' ? intrinsicReceipt(raw, full.length, fullBytes, parked) : raw;
        return await notifyPost(okResult(visible, shaped ? out.summary : undefined, shaped ? out.control : undefined, parked, shaped ? out.images : undefined, typeof full === 'string' ? full.length : null, fullBytes, shaped ? out.mutationReceipt : null), elapsed());
      } catch (e) {
        if (e && e.__timeout) return await notifyPost(errResult('tool ' + call.name + ' timed out after ' + timeoutMs + 'ms', 'timeout'), elapsed());
        const errorText = 'tool ' + call.name + ' failed: ' + (e && e.message ? e.message : String(e));
        const fullError = e && typeof e.fullContent === 'string' ? e.fullContent : errorText;
        let parked = null;
        if (fullError !== errorText || fullError.length > OUTPUT_MAX) {
          try { const p = ctx && typeof ctx.parkOutput === 'function' ? await ctx.parkOutput(fullError, { tool: call.name }) : null; parked = p && p.path ? String(p.path) : null; } catch (_) {}
        }
        const fullErrorBytes = utf8Bytes(fullError);
        const visibleError = fullError !== errorText ? intrinsicReceipt(errorText, fullError.length, fullErrorBytes, parked) : errorText;
        return await notifyPost(errResult(visibleError, 'error', parked, fullError.length, fullErrorBytes, e && e.mutationReceipt), elapsed());
      } finally {
        // A long run may execute hundreds of tools against one parent signal. Once this call settles, its child
        // controller no longer needs cancellation propagation; retaining every listener until run end leaks the
        // whole per-call closure graph and eventually trips EventTarget listener-pressure warnings.
        child.detach();
      }
    }

    return { register, get, list, wireFormat, dispatch };
  }

  return { makeRegistry };
});
