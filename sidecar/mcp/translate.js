/* sidecar/mcp/translate.js — turn a discovered MCP tool into a StarNet registry tool def.
   Pure. The bridge between an MCP server's `tools/list` entries and sidecar/tools/registry.js,
   so an MCP connector's tools flow through the SAME host-side dispatch boundary as every
   built-in tool: capability gate -> schema-validate -> consent gate -> per-tool timeout -> run.
   No new event types — a dispatched MCP tool already emits the frozen agent.tool_call /
   agent.tool_result like any other tool.

   mcpToolName(connectorId, toolName) -> wire-safe namespaced name "mcp__<conn>__<tool>"
   makeMcpToolDef({ connectorId, mcpTool, call, label?, timeoutMs? }) -> registry tool def
     mcpTool : { name, description?, inputSchema?, annotations? }   // one tools/list entry
     call    : (toolName, args) => Promise<{ content, isError }>     // bound MCP callTool for THIS connector

   Consent posture: MCP annotations are untrusted metadata. Every connector tool is an
   external-unknown effect that requires an exact, live, non-cacheable per-call confirmation. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('../tools/fence.js') : (root.SK && root.SK.fence));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.mcp = root.SK.mcp || {}).translate = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fence) {
  'use strict';

  const NAME_MAX = 64;   // the OpenRouter/OpenAI function-name grammar is ^[A-Za-z0-9_-]{1,64}$

  /* Every BUILT-IN tool clamps what it hands back (fs.read 200k, shell 64k, web_fetch 6k,
     web_request 8k, image, browser). An MCP connector's payload is authored by a third-party
     server, and registry.dispatch does no central capping, so this was the one unclamped door
     into the model's context: a single `query` against a filesystem/database/API connector could
     return megabytes and blow the window (or the budget) in ONE call. 64k chars matches
     shell.exec — an MCP call is the same shape of act (run an external thing, read its output). */
  const RESULT_MAX_CHARS = 64000;

  // wire-safe segment: runs of disallowed chars collapse to a single '_', leading/trailing separators trimmed
  // (so "My Server!" -> "My_Server", "do.thing" -> "do_thing"); legitimate inner _ / - are preserved.
  function sanitizePart(s) {
    return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  }

  /* FNV-1a over the full pre-truncation name -> 6 base36 chars. Pure, dependency-free (this module is also
     loaded in the browser build, so no node:crypto), deterministic across engines and runs. */
  function shortHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36).slice(0, 6).padStart(6, '0');
  }

  /* "mcp__<connectorId>__<toolName>" — sanitized to the wire grammar and length-capped. The "mcp__" prefix
     namespaces every connector tool so it never collides with a built-in (web_search, fs_write, …); the
     connectorId segment keeps two connectors that expose the same tool name distinct.

     TRUNCATION MUST DISAMBIGUATE. A bare slice(0, 64) mapped two tools of one connector onto the SAME wire
     name whenever their names shared a prefix — and registry.register() overwrites by name, so one tool
     vanished from the registry and calls to the surviving name executed the OTHER server tool (measured:
     a `…_read` wire name running the `…_write` MCP tool, with the surviving def's scope/readOnly/consent).
     Truncating now reserves the tail for a hash of the FULL name, so distinct tools stay distinct. */
  function mcpToolName(connectorId, toolName) {
    const full = 'mcp__' + sanitizePart(connectorId) + '__' + sanitizePart(toolName);
    if (full.length <= NAME_MAX) return full;
    return full.slice(0, NAME_MAX - 7) + '_' + shortHash(full);
  }

  // schema-lite (shared/schema.js) understands type/enum/properties/required/items/additionalProperties and
  // ignores every other JSON-Schema keyword, so an MCP inputSchema is largely passed through verbatim. We only
  // guarantee an object-typed root so a server that omits `type` still validates the model's argument object.
  function translateSchema(inputSchema) {
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return { type: 'object', properties: {} };
    const s = Object.assign({}, inputSchema);
    if (s.type === undefined) s.type = 'object';
    return s;
  }

  // MCP tool results are an array of typed content blocks; flatten to the plain text the model reads back.
  // Non-text blocks (image/audio/resource) become a compact placeholder so the call still returns *something*.
  function renderContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) { try { return JSON.stringify(content); } catch (e) { return String(content); } }
    const parts = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') { parts.push(String(b)); continue; }
      if (b.type === 'text') parts.push(String(b.text == null ? '' : b.text));
      else if (b.type === 'image') parts.push('[image' + (b.mimeType ? ' ' + b.mimeType : '') + ']');
      else if (b.type === 'audio') parts.push('[audio' + (b.mimeType ? ' ' + b.mimeType : '') + ']');
      else if (b.type === 'resource' || b.type === 'resource_link') {
        const r = b.resource || b;
        if (r && typeof r.text === 'string') parts.push(r.text);
        else parts.push('[resource' + (r && r.uri ? ' ' + r.uri : '') + ']');
      } else if (typeof b.text === 'string') parts.push(b.text);
      else { try { parts.push(JSON.stringify(b)); } catch (e) { /* skip an unserializable block */ } }
    }
    return parts.join('\n').trim();
  }

  /* Clamp with a hint the model can ACT on, matching the fs.search / web_fetch convention: say it was
     cut, say how much is missing, and point at the paging/filtering knob the server itself exposes. */
  function clampResult(text, max) {
    const s = String(text == null ? '' : text);
    const limit = max > 0 ? max : RESULT_MAX_CHARS;
    if (s.length <= limit) return { text: s, truncated: false };
    const dropped = s.length - limit;
    return {
      text: s.slice(0, limit) + '\n\n…[truncated — ' + dropped + ' more characters. Narrow the request (a ' +
            'filter, a smaller page/limit argument, or a more specific query) rather than re-running this as-is.]',
      truncated: true
    };
  }

  function makeMcpToolDef(o) {
    o = o || {};
    const connectorId = o.connectorId || 'mcp';
    const mcpTool = o.mcpTool || {};
    const call = o.call;
    if (typeof call !== 'function') throw new Error('makeMcpToolDef: call(toolName, args) is required');
    if (!mcpTool.name) throw new Error('makeMcpToolDef: mcpTool.name is required');

    const ann = (mcpTool.annotations && typeof mcpTool.annotations === 'object') ? mcpTool.annotations : {};
    const readOnly = ann.readOnlyHint === true;
    const label = o.label || connectorId;
    const baseDesc = mcpTool.description ? String(mcpTool.description) : ('MCP tool ' + mcpTool.name);

    return {
      name: mcpToolName(connectorId, mcpTool.name),
      description: baseDesc + ' (via the ' + label + ' connector)',
      schema: translateSchema(mcpTool.inputSchema),
      scope: readOnly ? 'read' : 'execute',
      readOnly: readOnly,
      capability: 'mcp:' + sanitizePart(connectorId),   // lets registry.list() grant a whole connector by capId
      // Transport and server-supplied readOnlyHint cannot prove absence of local/user effects.
      // Every custom connector call receives an exact non-cacheable live confirmation.
      impact: 'external-unknown',
      requiresConsent: o.localProcess === true || !readOnly,
      network: true,                                     // every remote MCP call is an outward network effect
      timeoutMs: o.timeoutMs || 0,                       // 0 -> inherit the host's per-tool timeout (CAPS.toolTimeoutMs)
      run: async function (args, ctx) {
        const res = await call(mcpTool.name, args || {});
        // Clamp BEFORE the error branch too: a failing server is just as able to hand back a
        // megabyte of stack trace as a succeeding one.
        const clamped = clampResult(renderContent(res && res.content), o.maxResultChars);
        const text = clamped.text;
        /* an MCP-level error (isError:true) is surfaced by THROWING — registry.dispatch turns any throw into a
           clean isError tool_result, so the model sees the failure text without us inventing a result shape.
           FENCE IT TOO. The error text is the SERVER's payload, exactly as untrusted as the success payload,
           and it lands in the model's context the same way — so shipping it raw made `isError: true` a
           one-flag bypass of the whole untrusted-content fence. (The taint half is closed in index.js: a
           failed result from an untrusted source now latches the run's taint as well.) */
        if (res && res.isError) {
          const body = text || ('MCP tool ' + mcpTool.name + ' reported an error');
          const e = new Error(fence.fenceExternal(body, 'ERROR from the ' + label + ' connector'));
          e.__mcpToolError = true; throw e;
        }
        // UNTRUSTED-CONTENT FENCE (2026-07-25): a connector result is authored by a THIRD-PARTY SERVER, not by
        // the Commander — the same trust level as a fetched web page, and now reachable unattended by a granted
        // routine. Fenced with the shared marker pair so the model gets one contract across web/browser/MCP.
        // ORDER MATTERS: fence the ALREADY-CLAMPED text. Clamping a fenced string would slice the closing
        // marker off a long result and hand the model an unterminated fence. The clamp governs the SERVER's
        // payload; the fence is host framing added on top, exactly as web_fetch has always done.
        return {
          content: fence.fenceExternal(text, 'result from the ' + label + ' connector'),
          summary: 'mcp:' + connectorId + ' ' + mcpTool.name + (clamped.truncated ? ' (truncated)' : '')
        };
      }
    };
  }

  return { makeMcpToolDef, mcpToolName, RESULT_MAX_CHARS, _internals: { sanitizePart, translateSchema, renderContent, clampResult } };
});
