/* sidecar/tools/builtin/connectors.js — `connectors.list`: the agent's readout of the station's INTEGRATIONS.

   WHY THIS EXISTS (a measured truthful-telemetry gap, not a nice-to-have). Three things were true at once:
     1. CONFIGURED service keys already ride the prompt (servicekeys.promptBlock — names only, never values).
     2. INSTALLED connectors already project their tools straight into the run's tool list (mcp/manager.js).
     3. Nothing ever told the agent about the integrations that are ONE CLICK AWAY but not yet added.
   So an agent asked "what is this harness missing?" answered with things the Commander could have had in
   thirty seconds — GitHub, Notion, Stripe, Google Workspace — because from inside the run they were
   indistinguishable from unbuildable. That is the station lying by omission about its own reach.

   This tool closes (3) ONLY. It is a READER: pure local state, no network, no consent, and it can neither
   install nor authenticate anything. Adding a connector spends the Commander's credentials and is their
   click, in ABILITIES › CONNECTORS (or the KEYS tab) — the agent's job is to know the offer exists and say so.

   NEVER ECHOES A SECRET. Connector summaries carry `hasToken`, never the token (mcp/manager.js summary());
   service keys are reported as NAME + ENV VAR only, exactly like the prompt block. There is no code path
   here that reads a key's value.

   capability 'web' on the `dish` object — the same grant as web_request, which is the route an agent
   actually SPENDS a service key through. A station with no dish can neither call an API nor drive a
   connector, so advertising the catalog there would teach a reach the run does not have.

   makeConnectorTools({ connectors?, serviceKeys?, connectorCatalog?, keysCatalog? }) -> { listTool, register(reg), _internals }
     connectors        : the live manager — { list() -> summary[] }        (omit → "none connected")
     serviceKeys       : () -> record[] (the raw KEYS list; only name/envVar/enabled/autonomous/docsUrl are read)
     connectorCatalog  : mcp/catalog.js      — { browse(installed) -> { connectors:[{id,name,category,authType,installed,blurb,via}] } }
     keysCatalog       : servicekeys-catalog — { PLATFORMS:[{id,name,category,envVar,docsUrl}] }
   Every dep is optional: a missing one degrades that SECTION to silence, never to a fake empty answer. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).connectors = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCOPES = ['all', 'connected', 'available'];
  const MAX_AVAILABLE = 40;      // the catalogs are curated and small; this is a runaway guard, not a policy
  const MAX_CHARS = 6000;        // a tool result is re-read by the model every turn — stay cheap

  const str = v => String(v == null ? '' : v).trim();
  const low = v => str(v).toLowerCase();

  // Does this row match the agent's free-text filter? Matched over the fields a human would name it by.
  function matches(q, ...fields) {
    if (!q) return true;
    const hay = fields.map(low).join(' ');
    return q.split(/\s+/).filter(Boolean).every(term => hay.indexOf(term) >= 0);
  }

  // A live connector, rendered honestly: state comes from the manager's real handshake, never from the catalog.
  function connectedLine(c) {
    const name = str(c.label) || str(c.id);
    const state = str(c.state) || 'unknown';
    const bits = [];
    if (c.enabled === false) bits.push('disabled');
    bits.push(state === 'up' ? (c.toolCount || 0) + ' tools' : state + (c.detail ? ': ' + str(c.detail).slice(0, 120) : ''));
    if (c.oauth) bits.push('oauth');
    return '- ' + str(c.id) + (name && name !== str(c.id) ? ' (' + name + ')' : '') + ' — ' + bits.join(', ');
  }

  function makeConnectorTools(deps) {
    deps = deps || {};
    const mgr = deps.connectors || null;
    const keysOf = typeof deps.serviceKeys === 'function' ? deps.serviceKeys : null;
    const mcpCatalog = deps.connectorCatalog || null;
    const keyCatalog = deps.keysCatalog || null;

    // ---- the three sections, each independently fail-open (a thrown dep degrades to a silent section) ----

    function sectionConnected(q) {
      if (!mgr || typeof mgr.list !== 'function') return null;
      let rows = [];
      try { rows = mgr.list() || []; } catch (_) { return null; }
      rows = rows.filter(c => c && matches(q, c.id, c.label));
      if (!rows.length) return { label: 'connected', count: 0, head: 'CONNECTED (0)', body: ['(no MCP connectors added yet)'] };
      return {
        label: 'connected', count: rows.length,
        head: 'CONNECTED (' + rows.length + ') — a connector\'s tools reach an agent whose room has that connector object placed',
        body: rows.map(connectedLine)
      };
    }

    function sectionKeys(q) {
      if (!keysOf) return null;
      let rows = [];
      try { rows = keysOf() || []; } catch (_) { return null; }
      // Mirror promptBlock's filter: enabled rows that actually hold a key. `key` is only ever TESTED for
      // presence here — its value is never read into the output.
      rows = rows.filter(r => r && r.enabled !== false && r.envVar && r.key && matches(q, r.name, r.envVar));
      if (!rows.length) return { label: 'keys', count: 0, head: 'KEYS (0)', body: ['(no platform API keys connected yet)'] };
      return {
        label: 'keys', count: rows.length,
        head: 'KEYS (' + rows.length + ') — spend these with web_request by writing ${ENV_VAR} in a header; you never see the value',
        body: rows.slice().sort((a, b) => str(a.name).localeCompare(str(b.name))).map(r =>
          '- ' + str(r.name) + ': ${' + str(r.envVar) + '}'
          + (r.autonomous === true ? '' : ' [watched sessions only]')
          + (r.docsUrl ? ' — ' + str(r.docsUrl) : ''))
      };
    }

    /* The point of the whole tool: what the Commander could add but has not. Two catalogs, one list.
       An MCP row is only reported as available when it is NOT installed; a KEYS row only when its env var
       is not already connected — otherwise this would nag the Commander to add what they already have. */
    function sectionAvailable(q) {
      // NO catalog wired at all = we cannot see the offer, which is NOT the same as "there is nothing to add".
      // Returning a confident AVAILABLE (0) here would be the exact lie this tool was built to end.
      if (!mcpCatalog && !keyCatalog) return null;
      const out = [];
      let haveEnv = new Set();
      if (keysOf) { try { for (const r of (keysOf() || [])) { if (r && r.envVar && r.enabled !== false && r.key) haveEnv.add(str(r.envVar)); } } catch (_) {} }

      if (mcpCatalog && typeof mcpCatalog.browse === 'function') {
        let installed = [];
        if (mgr && typeof mgr.list === 'function') { try { installed = (mgr.list() || []).map(c => c && { id: str(c.id), url: '' }); } catch (_) {} }
        let entries = [];
        try { entries = (mcpCatalog.browse(installed) || {}).connectors || []; } catch (_) { entries = []; }
        for (const e of entries) {
          if (!e || e.installed) continue;
          if (!matches(q, e.id, e.name, e.category, e.blurb)) continue;
          const auth = e.authType === 'none' ? 'no credentials' : e.authType === 'oauth' ? 'sign-in' : 'api key';
          out.push('- ' + str(e.name) + ' [' + str(e.category) + '] — connector, ' + auth
            + (e.via ? ' via ' + str(e.via) : '') + (e.blurb ? '. ' + str(e.blurb).slice(0, 140) : ''));
        }
      }

      if (keyCatalog && Array.isArray(keyCatalog.PLATFORMS)) {
        for (const p of keyCatalog.PLATFORMS) {
          if (!p || haveEnv.has(str(p.envVar))) continue;
          if (!matches(q, p.id, p.name, p.category, p.blurb)) continue;
          out.push('- ' + str(p.name) + ' [' + str(p.category) + '] — API key (' + str(p.envVar) + ')'
            + (p.docsUrl ? ', docs ' + str(p.docsUrl) : ''));
        }
      }

      if (!out.length) return { label: 'available', count: 0, head: 'AVAILABLE (0)', body: ['(nothing left in the catalogs matches)'] };
      const shown = out.slice(0, MAX_AVAILABLE);
      // The count is the REAL total, not the shown slice — a truncated list that reports its own length as the
      // total would understate the offer, which is the failure this tool exists to fix.
      const head = 'AVAILABLE (' + out.length + ')' + (shown.length < out.length ? ', showing ' + shown.length : '')
        + ' — NOT installed. The Commander adds a connector in ABILITIES › CONNECTORS, and a platform key in the KEYS tab. You cannot add these yourself; offer, never assume.';
      return { label: 'available', count: out.length, head: head, body: shown };
    }

    const listTool = {
      name: 'connectors.list', capability: 'web', scope: 'read', requiresConsent: false, timeoutMs: 8000,
      description: 'List the station\'s INTEGRATIONS: MCP connectors already connected, platform API keys already '
        + 'connected, and — the part you cannot otherwise know — the vetted connectors and platform keys the '
        + 'Commander could add but has not (GitHub, Notion, Stripe, Google Workspace, Printify, Etsy and more). '
        + 'Check this BEFORE telling the Commander that StarNet cannot reach a service: it usually can, and the '
        + 'honest answer is "that one is one click away in ABILITIES › CONNECTORS — want me to walk you through '
        + 'it?". Read-only: you cannot install or authenticate anything, and you never see a key\'s value. '
        + 'Optional `query` filters by service or category; `scope` narrows to connected or available.',
      schema: {
        type: 'object', properties: {
          scope: { type: 'string', enum: SCOPES, description: 'all (default), connected (what is live now), or available (what could be added)' },
          query: { type: 'string', description: 'filter by name, id, or category — e.g. "github", "payments"' }
        }
      },
      run: async (args) => {
        args = args || {};
        const scope = SCOPES.indexOf(low(args.scope)) >= 0 ? low(args.scope) : 'all';
        const q = low(args.query);

        const parts = [];
        if (scope === 'all' || scope === 'connected') { parts.push(sectionConnected(q), sectionKeys(q)); }
        if (scope === 'all' || scope === 'available') { parts.push(sectionAvailable(q)); }

        const blocks = parts.filter(Boolean).map(s => s.head + '\n' + s.body.join('\n'));
        if (!blocks.length) return { content: 'No integration state is readable on this station.', summary: 'no data' };

        let text = blocks.join('\n\n');
        if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n… (truncated — narrow it with `query`)';
        // The floor summary counts ENTRIES, not rendered lines — "connected:1" for a station with zero
        // connectors (one "(none yet)" line) is exactly the kind of small lie this file is against.
        const counts = parts.filter(Boolean).map(s => s.label + ':' + s.count).join(' ');
        return { content: text, summary: counts };
      }
    };

    return {
      listTool: listTool,
      register(reg) { reg.register(listTool); return reg; },
      _internals: { matches, connectedLine, sectionConnected, sectionKeys, sectionAvailable, MAX_AVAILABLE, MAX_CHARS }
    };
  }

  return { makeConnectorTools: makeConnectorTools };
});
