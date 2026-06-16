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

  function withTimeout(value, ms) {
    if (!ms || ms <= 0) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; const e = new Error('timeout'); e.__timeout = true; reject(e); } }, ms);
      Promise.resolve(value).then(
        v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        e => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
      );
    });
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

      // capability gate (M1.3): is this tool granted to the agent right now? dispatch is a GENERIC dispatcher;
      // the capability layer is supplied by the edge (index.js makeCapCtx always provides canUse for real runs).
      // Its ABSENCE is the explicit "no-gate" mode used by unit tests that exercise a tool in isolation.
      if (ctx.canUse) {
        const g = ctx.canUse(call, tool);
        if (!g || !g.ok) return errResult('capability denied: ' + ((g && g.reason) || call.name), 'capdenied');
      }

      // schema-validate args; on failure run() is NOT called
      const v = schema.validate(tool.schema || {}, call.args);
      if (!v.ok) return errResult('invalid arguments for ' + call.name + ': ' + v.errors.join('; '));

      // consent gate (M1.4): a denied/cancelled prompt performs NO action
      if (tool.requiresConsent && ctx.consent) {
        let c;
        try { c = await ctx.consent(call, tool); } catch (e) { c = { allow: false, reason: 'consent error' }; }
        if (!c || !c.allow) return errResult('consent denied for ' + call.name + (c && c.reason ? ': ' + c.reason : ''), 'denied');
      }

      // run once, bounded by the per-tool timeout; any throw becomes an isError result. NOTE: the timeout
      // bounds only the RESULT — fs/notebook builtins have no AbortSignal, so a write that "times out" may
      // still land on disk. web.* tools self-abort via their own AbortController.
      const timeoutMs = tool.timeoutMs || ctx.timeoutMs || 0;
      try {
        const out = await withTimeout(tool.run(call.args, ctx), timeoutMs);
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
