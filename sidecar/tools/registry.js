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

  const okResult = (content, summary) => ({ ok: true, isError: false, content: content, summary: summary || 'ok' });
  const errResult = (content, summary) => ({ ok: false, isError: true, content: content, summary: summary || 'error' });

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
        if (out && typeof out === 'object' && 'content' in out) return okResult(out.content, out.summary);
        return okResult(out == null ? '' : out);
      } catch (e) {
        if (e && e.__timeout) return errResult('tool ' + call.name + ' timed out after ' + timeoutMs + 'ms', 'timeout');
        return errResult('tool ' + call.name + ' failed: ' + (e && e.message ? e.message : String(e)));
      }
    }

    return { register, get, list, wireFormat, dispatch };
  }

  return { makeRegistry };
});
