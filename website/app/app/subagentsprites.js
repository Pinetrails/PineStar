/* STARNET — subagentsprites.js : the PURE ledger fold for the Meeseeks sub-agent sprite layer (G4 feature 3).

   The backend (sidecar/subagents.js) makes a real background sub-agent OBSERVABLE by emitting a frozen `task`
   event — { id, agentId, status, kind:'subagent', title } — on start ('running') and completion ('done'/'failed'
   /'interrupted'). Those events already reach the browser on U.bus (harness re-emit + the channel SSE bridge).

   This module folds that stream into a small LEDGER of live helper sprites: one entry per LIVE sub-agent,
   materialized on the first running/queued event and DE-materialized (poof) on any terminal event. The
   truthfulness law: a helper sprite exists IFF a real sub-agent is live — this fold is the only source of the
   sprite set, so a decorative spawn is impossible. Rendering (materialize-in, working shimmer, dissolve) lives
   in world.js; this module is the pure, node-testable state machine (the ledger + the visible cap + '+N').

   PURE: no DOM, no rAF, no RNG — time is INJECTED (fold(ev, now) / prune/list take the caller's clock) so the
   fold is deterministic under test. A `SubagentSprites` global in the browser, module.exports under node. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SubagentSprites = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIVE = { running: 1, queued: 1, active: 1 };        // states that mean "this sub-agent is still working"
  const MATERIALIZE_MS = 520;                               // the fade/scale-in on spawn
  const DISSOLVE_MS = 640;                                  // the particle poof on completion (kept in the ledger until it finishes)
  const DEFAULT_CAP = 5;                                    // max helper sprites drawn at once; the rest fold into a '+N'

  function makeLedger(opts) {
    opts = opts || {};
    const cap = Number.isFinite(opts.cap) ? opts.cap : DEFAULT_CAP;
    // id -> { id, leadId, title, state:'live'|'dying', bornAt, diedAt }
    const rows = new Map();

    // fold ONE task event into the ledger. Only kind:'subagent' events touch it (everything else is ignored, so
    // the desk-progress 'task' consumer and this one never fight). Returns the affected row (for the caller) or null.
    function fold(ev, now, leadId) {
      if (!ev || ev.kind !== 'subagent' || !ev.id) return null;
      const id = String(ev.id);
      const live = !!LIVE[ev.status];
      let row = rows.get(id);
      if (live) {
        if (!row) { row = { id, leadId: leadId || ev.leadId || null, title: String(ev.title || ''), state: 'live', bornAt: now, diedAt: 0 }; rows.set(id, row); }
        else { row.state = 'live'; row.diedAt = 0; if (leadId) row.leadId = leadId; }   // a re-emitted running (resume) revives it
        return row;
      }
      // terminal (done/failed/interrupted/refused/stale): begin the dissolve if we were tracking it.
      if (row && row.state !== 'dying') { row.state = 'dying'; row.diedAt = now; }
      return row || null;
    }

    // drop rows whose dissolve has finished (call once per frame with the clock). Returns how many were pruned.
    function prune(now) {
      let n = 0;
      for (const [id, r] of rows) { if (r.state === 'dying' && now - r.diedAt >= DISSOLVE_MS) { rows.delete(id); n++; } }
      return n;
    }

    // the sprites to draw THIS frame, each with a 0..1 materialize/dissolve alpha. Capped: the first `cap` (oldest
    // first, stable) render; `overflow` is how many live helpers are hidden behind the '+N' badge.
    function list(now) {
      const all = Array.from(rows.values()).sort((a, b) => a.bornAt - b.bornAt || (a.id < b.id ? -1 : 1));
      const out = [];
      for (const r of all) {
        let phase, alpha;
        if (r.state === 'dying') { phase = 'dissolve'; alpha = Math.max(0, 1 - (now - r.diedAt) / DISSOLVE_MS); }
        else { phase = 'materialize'; alpha = Math.min(1, (now - r.bornAt) / MATERIALIZE_MS); }
        out.push({ id: r.id, leadId: r.leadId, title: r.title, phase, alpha, bornAt: r.bornAt });
      }
      const shown = out.slice(0, cap);
      // overflow counts only LIVE (materialize) helpers beyond the cap — a dissolving one is on its way out.
      const overflow = out.slice(cap).filter(s => s.phase === 'materialize').length;
      return { shown, overflow, liveCount: out.filter(s => s.phase === 'materialize').length, total: out.length };
    }

    function count() { let n = 0; for (const r of rows.values()) if (r.state === 'live') n++; return n; }   // LIVE sub-agents (truthful gauge)
    function clear() { rows.clear(); }

    /* THE LOST-EVENT NET. The fold is driven ENTIRELY by `task` frames, and a terminal frame emitted while the
       SSE socket is down is gone for good — the stream sends no `id:` lines, so there is no Last-Event-ID
       replay. A 'live' row is then rendered at alpha 1 forever and prune() never touches it (it drops only
       'dying' rows), so a helper sprite haunted the desk long after its sub-agent finished. Every other paired
       state in world.js already has this net (sweepStaleStates degrades the run clock; reconcileFromSnapshot
       rebuilds runs/tools/serverLit from server truth) — the ledger was the one that did not, which breaks the
       law in this module's own header: a helper sprite exists IFF a real sub-agent is live.

       A TTL is the WRONG net here: nothing re-emits `running`, so a clock would kill a legitimately long
       sub-agent. Reconcile against the authoritative live set instead (GET /api/subagents?status=running —
       the same truth the LIVE HELPERS panel paints from). Rows the server no longer reports begin their normal
       dissolve, so the correction still LOOKS like a completion rather than a sprite blinking out. Rows the
       server reports that we never saw are ADDED, which is the other half of the IFF (a helper that started
       while the socket was down). Returns what changed, for tests and dbg. */
    function reconcile(liveIds, now) {
      const want = new Set((Array.isArray(liveIds) ? liveIds : []).map(v => String(v && v.id != null ? v.id : v)).filter(Boolean));
      let dropped = 0, added = 0;
      for (const r of rows.values()) {
        if (r.state === 'live' && !want.has(r.id)) { r.state = 'dying'; r.diedAt = now; dropped++; }
      }
      for (const v of (Array.isArray(liveIds) ? liveIds : [])) {
        const id = String(v && v.id != null ? v.id : v);
        if (!id) continue;
        const row = rows.get(id);
        if (!row) { rows.set(id, { id, leadId: (v && v.leadId) || null, title: String((v && v.title) || ''), state: 'live', bornAt: now, diedAt: 0 }); added++; }
        else if (row.state === 'dying') { row.state = 'live'; row.diedAt = 0; }   // a terminal we mis-inferred
      }
      return { dropped, added };
    }

    return { fold, prune, list, count, clear, reconcile, _rows: rows, MATERIALIZE_MS, DISSOLVE_MS, cap };
  }

  return { makeLedger, LIVE, MATERIALIZE_MS, DISSOLVE_MS, DEFAULT_CAP };
});
