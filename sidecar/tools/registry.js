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
     consent gate (tool.requiresConsent && ctx.consent) -> per-tool timeout -> run() once. */
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

  /* CENTRAL TOOL-OUTPUT CAP (Hermes parity: tool_output_limits). Every builtin clamps its own output today,
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
      ? '\n\n[... ' + dropped + ' characters elided here by the host output cap. THE FULL OUTPUT WAS SAVED to '
        + parkedPath + ' — read that file (in ranges if it is large) to see the part that is missing, or search '
        + 'it. Do NOT repeat this call to recover it. The end of the output follows ...]\n\n'
      : '\n\n[... ' + dropped + ' characters removed by the host output cap. Do not repeat this call as-is — '
        + 'narrow it: filter, page, request a smaller range, or write the full output to a file and read it back '
        + 'in parts. The end of the output follows ...]\n\n';
    return content.slice(0, head) + note + content.slice(content.length - tail);
  }

  const okResult = (content, summary, control, parkedPath) => ({ ok: true, isError: false, content: clampOutput(content, parkedPath), summary: summary || 'ok', control: control || null });
  const errResult = (content, summary, parkedPath) => ({ ok: false, isError: true, content: clampOutput(content, parkedPath), summary: summary || 'error' });

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
    if (parent) {
      if (parent.aborted) { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }
      else { try { parent.addEventListener('abort', () => { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }, { once: true }); } catch (_) {} }
    }
    return ctrl;
  }

  function makeRegistry() {
    const tools = {};

    function register(def) { const t = toolMod.makeTool(def); tools[t.name] = t; return t; }
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

      // run once, bounded by the per-tool timeout; any throw becomes an isError result. A per-call AbortController
      // (chained to the run's parent signal) is threaded in as ctx.signal so that on TIMEOUT we abort() the work
      // before rejecting — a timed-out tool no longer keeps running/spending in the background.
      const timeoutMs = tool.timeoutMs || ctx.timeoutMs || 0;
      const ac = childAbort(ctx.signal);
      const runCtx = ac !== ctx.signal ? Object.assign({}, ctx, { signal: ac.signal }) : ctx;
      try {
        const out = await withTimeout(tool.run(call.args, runCtx), timeoutMs, () => { try { ac.abort(new Error('tool timeout')); } catch (_) { try { ac.abort(); } catch (_) {} } });
        const shaped = (out && typeof out === 'object' && 'content' in out);
        const raw = shaped ? out.content : (out == null ? '' : out);
        // Park BEFORE clamping — the clamp is what destroys the middle, so the full text has to be on disk first.
        const parked = await parkIfOver(raw, call, ctx);
        return okResult(raw, shaped ? out.summary : undefined, shaped ? out.control : undefined, parked);
      } catch (e) {
        if (e && e.__timeout) return errResult('tool ' + call.name + ' timed out after ' + timeoutMs + 'ms', 'timeout');
        return errResult('tool ' + call.name + ' failed: ' + (e && e.message ? e.message : String(e)));
      }
    }

    return { register, get, list, wireFormat, dispatch };
  }

  return { makeRegistry };
});
