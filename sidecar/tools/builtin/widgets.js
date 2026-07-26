/* sidecar/tools/builtin/widgets.js — the AGENT-FED WIDGET surface: widget.set.

   The chrome's widget rails (frontend/app/widgets.js) can pin AGENT-FED instruments —
   a small named readout ANY agent keeps fresh (app revenue, AI news, subscriber count…).
   This tool is the ONLY writer. The frontend polls GET /api/widgets and renders each
   record with PROVENANCE ("<agent> · <age>"): the app never asserts the value is true,
   only that this agent reported it at that time — truthful telemetry for external data.

   Pure, sandboxed, no filesystem path-escape surface, no network. Backed by an injected
   store ({get,set,update} — the durable station-scoped store in the sidecar; in-memory in
   tests), the notebook.js pattern. NEVER emits: the frozen shared/events.js contract has
   no widget event, and the poll transport needs none.

   makeWidgetTools({ store, clock, redact }) -> { setTool, list(), register(registry) }
     store  : { get(key) -> value|undefined, set(key, value), update?(key, mutator) }
     clock  : { now() -> ms }   (injected; lint-determinism — no ambient Date.now)
     redact : secret scrub applied to every persisted string (a fed value can carry a
              key/token the agent just saw; it must never persist in cleartext). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).widgets = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY = 'station';          // ONE station-scoped record list (widgets are station chrome, not per-agent)
  const MAX_WIDGETS = 12;         // the rails are small; a fleet of stale gauges is noise, not signal
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
  const LIM = { label: 28, value: 24, sub: 28, listItem: 90, listLen: 5, sparkLen: 24 };
  const TONES = ['ok', 'warn', 'bad'];    // the instrument tint palette — semantic, theme-mapped by the chrome

  const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  // spark: keep only finite numbers, cap the series; <2 points can't draw a line → null
  const cleanSpark = (raw) => {
    if (!Array.isArray(raw)) return null;
    const pts = raw.slice(0, LIM.sparkLen).map(Number).filter(v => isFinite(v));
    return pts.length >= 2 ? pts : null;
  };
  const cleanProgress = (raw) => {
    const n = Number(raw);
    return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  };

  function makeWidgetTools(deps) {
    deps = deps || {};
    const store = deps.store;
    const clock = deps.clock || { now: () => 0 };
    const redact = typeof deps.redact === 'function' ? deps.redact : (x => x);

    const listOf = () => { const v = store.get(KEY); return Array.isArray(v) ? v : []; };
    // P1 SAFE WRITE: serialize through store.update when the host provides it (durable store);
    // plain get->mutate->set for a standalone in-memory store (tests). notebook.js discipline.
    const updateList = (mutator) => {
      if (store && typeof store.update === 'function') return store.update(KEY, cur => mutator(Array.isArray(cur) ? cur : []));
      const next = mutator(listOf());
      if (next !== undefined) store.set(KEY, next);
      return Promise.resolve(next);
    };

    const setTool = {
      // NO consent gate: a widget record is a sandboxed local write to the station's OWN chrome
      // (no filesystem reach, no network, no outward effect) — the same trust class as notebook.write.
      name: 'widget.set', capability: 'memory', scope: 'write', requiresConsent: false,
      /* Trimmed 2026-07-26 (tool-schema cost pass; widest tool in the harness at 2,361 B on the wire). This
         text is re-sent on EVERY turn, so it may only carry what CHANGES A DECISION *and* has nowhere better
         to live. The old version narrated value/sub/list/tone/spark/progress/clear one by one — every one of
         which the `schema` below already describes at the point of use, and more precisely (it carries the
         max lengths this prose did not). What survives is what a per-field description structurally cannot
         say: what the instrument IS, the cross-turn freshness contract, the cross-field "only when the data
         has that shape" rule, and SKIP — which has no runtime guard behind it, so it stays spelled out. */
      description: 'Publish or update a small named readout on the station’s widget rails — a live instrument the Commander can pin ' +
        'on screen (e.g. app revenue, top AI headlines, subscriber count). The display always carries YOUR name and the time you ' +
        'set it, so a stale figure is attributable to you: re-set the same id whenever you have a newer one (a routine is the ' +
        'natural driver), and setting an existing id overwrites it. Reach for tone/spark/progress only when the data genuinely ' +
        'has that shape — a real trend series, a real completion fraction — never as decoration. ' +
        'SKIP: secrets, walls of text, anything you cannot back with a real source when asked.',
      schema: {
        type: 'object', required: ['id'],
        properties: {
          id: { type: 'string', description: 'Stable slug for this readout: lowercase letters/digits/dashes, max 24 chars (e.g. "app-revenue").' },
          label: { type: 'string', description: 'The instrument’s small caption label, e.g. "APP REVENUE" (max 28 chars).' },
          value: { type: 'string', description: 'The big figure, kept short (max 24 chars), e.g. "$​1,240".' },
          sub: { type: 'string', description: 'Optional small line under/next to the value, e.g. "today" (max 28 chars).' },
          list: { type: 'array', items: { type: 'string' }, description: 'Up to 5 short lines rendered as a cycling ticker (headlines). Use INSTEAD of value.' },
          tone: { type: 'string', enum: ['ok', 'warn', 'bad'], description: 'Optional semantic tint for the figure: "ok" (good), "warn", "bad". Omit for neutral.' },
          spark: { type: 'array', items: { type: 'number' }, description: 'Optional trend series (2-24 numbers, oldest first) drawn as a tiny sparkline beside the value.' },
          progress: { type: 'number', description: 'Optional completion fraction 0-100 drawn as a small bar (e.g. a goal or quota).' },
          clear: { type: 'boolean', description: 'true = remove this readout from the rails.' }
        }
      },
      run: async (args, ctx) => {
        const id = args && String(args.id || '').toLowerCase().trim();
        // error paths THROW — the registry turns a throw into an isError result the model can react to.
        if (!ID_RE.test(id)) throw new Error('id must be 1-24 chars of lowercase letters/digits/dashes, e.g. "app-revenue"');
        const aid = (ctx && ctx.agentId) || 'agent';

        if (args.clear === true) {
          let existed = false;
          await updateList(list => {
            const next = list.filter(w => w && w.id !== id);
            existed = next.length !== list.length;
            return next;
          });
          return existed
            ? { content: 'Cleared widget "' + id + '" — it is off the rails now.', summary: 'cleared ' + id }
            : { content: 'No widget "' + id + '" exists — nothing to clear.', summary: 'no-op' };
        }

        const hasValue = args.value !== undefined && args.value !== null && String(args.value).trim() !== '';
        const rawList = Array.isArray(args.list) ? args.list.map(x => String(x)).filter(x => x.trim() !== '') : [];
        if (!hasValue && !rawList.length) throw new Error('give a `value` (a short figure) or a `list` (up to 5 lines) — a widget with neither has nothing to show');

        const rec = {
          id: id,
          label: trunc(redact(String(args.label !== undefined && String(args.label).trim() !== '' ? args.label : id).toUpperCase()), LIM.label),
          value: hasValue ? trunc(redact(String(args.value)), LIM.value) : null,
          sub: (args.sub !== undefined && String(args.sub).trim() !== '') ? trunc(redact(String(args.sub)), LIM.sub) : null,
          list: rawList.slice(0, LIM.listLen).map(x => trunc(redact(x), LIM.listItem)),
          tone: TONES.indexOf(args.tone) >= 0 ? args.tone : null,
          spark: cleanSpark(args.spark),
          progress: cleanProgress(args.progress),
          agentId: aid,
          runId: ctx && ctx.runId ? String(ctx.runId) : null,   // provenance: which run fed it
          updatedAt: clock.now()
        };

        let created = false;
        await updateList(list => {
          const idx = list.findIndex(w => w && w.id === id);
          if (idx >= 0) { const next = list.slice(); next[idx] = rec; return next; }
          // the cap binds NEW ids only — updating an existing readout must always work
          if (list.length >= MAX_WIDGETS) throw new Error('the station already has ' + MAX_WIDGETS + ' widgets — clear one (widget.set {id, clear:true}) before adding another');
          created = true;
          return list.concat([rec]);
        });

        return {
          content: (created ? 'Published' : 'Updated') + ' widget "' + rec.label + '" (' + id + '). ' +
            'It shows your name and this timestamp; the Commander can pin it from the rail’s ＋ menu.',
          summary: (created ? 'published ' : 'updated ') + id
        };
      }
    };

    return {
      setTool,
      list: listOf,   // the GET /api/widgets read surface (host route) — same records, no reshaping
      register(reg) { reg.register(setTool); return reg; }
    };
  }

  return { makeWidgetTools, MAX_WIDGETS: MAX_WIDGETS, ID_RE: ID_RE };
});
