/* SKYNET — workstreams.js : the unified unit-of-work record (session organization).
   A WORKSTREAM is one named conversation that simultaneously IS the Comms thread (its
   `history`), IS a kanban card (its `lane`), and OWNS its backend runs + deliverables +
   per-conversation cost. This module is the single owner of workstreams[] + activeId +
   generalId — one record, no fourth silo.

   Pure + dependency-free (no DOM / localStorage / Harness): exposes a `Workstreams` global in
   the browser, module.exports under node — so it is unit-testable headless like classify.js.
   It persists by handing serialize() to App.persist(); save.js delegates its v1->v2 upgrade to
   migrateV1() (the migration lives HERE because save.js has no module export — and so a v2 save
   never reaches the live app until the slice-2 wiring lands with it).

   Two invariants from the locked design:
   - TRUTHFUL TELEMETRY: per-stream cost is accumulated from the SAME real model-usage deltas
     that mint the lifetime total (chat.js feeds addCost a copy-snapshotted Harness.totals()
     diff) — never an invented number.
   - HYBRID-HONEST LANES: appendRun auto-advances todo->active the instant a real run fires;
     'shipped' is only ever set by a deliberate human turn-in via setLane. A lane can't lie. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Workstreams = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LANES = ['todo', 'active', 'shipped'];
  const LANE_OF_COL = { todo: 'todo', doing: 'active', done: 'shipped' };  // station kanban col -> lane

  // ---------- internal store (the single source of truth for sessions) ----------
  let ws = [];          // Workstream[]
  let activeId = null;
  let generalId = null;

  // frontend module: ambient time/rng is fine here (lint-determinism scans only shared/ + sidecar/).
  function now() { return Date.now(); }
  function uid() { return 'ws_' + now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  function clamp(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
  function zeroCost() { return { tokens: 0, usd: 0, calls: 0 }; }
  function find(id) { for (const w of ws) if (w.id === id) return w; return null; }

  // The one canonical Workstream shape. Idempotent on an already-formed record (ids/timestamps
  // are preserved), so init() can re-normalize a saved slice without reshaping it.
  function make(opts) {
    opts = opts || {};
    const t = opts.t || opts.createdAt || now();
    const c = opts.cost || {};
    return {
      id: opts.id || uid(),
      title: opts.title != null ? clamp(opts.title, 80) : null,    // null = the General default stream
      agentId: opts.agentId || 'agent',
      roomId: opts.roomId != null ? opts.roomId : null,            // dormant builder seam: a room IS a channel, later
      lane: LANES.indexOf(opts.lane) >= 0 ? opts.lane : 'todo',
      history: Array.isArray(opts.history) ? opts.history.slice() : [],
      runIds: Array.isArray(opts.runIds) ? opts.runIds.slice() : [],
      deliverables: Array.isArray(opts.deliverables) ? opts.deliverables.slice() : [],
      cost: { tokens: +c.tokens || 0, usd: +c.usd || 0, calls: +c.calls || 0 },
      pinned: !!opts.pinned,
      archived: !!opts.archived,
      createdAt: opts.createdAt || t,
      lastActiveAt: opts.lastActiveAt || t
    };
  }

  // ---------- lifecycle ----------
  // adopt or mint the General default; guarantees there is always exactly one home for casual chat.
  function ensureGeneral() {
    let g = generalId ? find(generalId) : null;
    if (!g) g = ws.filter(w => w.title == null && !w.archived)[0] || null;
    if (!g) { g = make({ title: null, lane: 'active' }); ws.push(g); }
    generalId = g.id;
    return g;
  }

  // hydrate from a saved slice { workstreams, activeId, generalId }; ensures a General exists and
  // the active id is valid. Returns the active workstream (for Chat.load on enter/resume).
  function init(slice) {
    slice = slice || {};
    ws = Array.isArray(slice.workstreams) ? slice.workstreams.map(make) : [];
    generalId = (slice.generalId && find(slice.generalId)) ? slice.generalId : null;
    ensureGeneral();
    activeId = (slice.activeId && find(slice.activeId)) ? slice.activeId : generalId;
    return active();
  }

  // wipe to a single fresh General (NEW AGENT clears everything).
  function reset() { ws = []; activeId = generalId = null; const g = ensureGeneral(); activeId = g.id; return active(); }

  // the persisted slice — App.persist() serializes this alongside { agent, usage }.
  function serialize() { return { workstreams: ws, activeId, generalId }; }
  function all() { return ws; }

  // ---------- selection ----------
  function active() { return find(activeId); }
  function get(id) { return find(id); }
  function getActiveId() { return activeId; }
  function getGeneralId() { return generalId; }
  function switchTo(id) { const w = find(id); if (w) { activeId = id; } return w; }

  // display order: pinned first, then most-recently-active; archived hidden unless asked.
  function list(opts) {
    opts = opts || {};
    return ws.filter(w => opts.includeArchived ? true : !w.archived)
      .slice()
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.lastActiveAt - a.lastActiveAt));
  }

  // ---------- create / mutate ----------
  // start a new (untitled) workstream and make it active; it auto-titles on its first message.
  function create(title, opts) {
    opts = opts || {};
    const w = make({ title: title || null, lane: 'todo', agentId: opts.agentId });   // summon binds a stream to its NEW agent
    ws.push(w);
    if (opts.activate !== false) activeId = w.id;   // board "add" passes {activate:false} so it won't hijack the active chat
    return w;
  }
  function rename(id, title) { const w = find(id); if (!w) return false; w.title = title ? clamp(title, 80) : null; return true; }
  // bind this stream to an agent (the multi-agent summon seam). The id must match the backend's agentId
  // grammar (^[A-Za-z0-9_-]{1,40}$) — an invalid id is rejected so a stream can never route to a bad path.
  function setAgent(id, agentId) {
    const w = find(id); if (!w) return false;
    agentId = String(agentId == null ? '' : agentId);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return false;
    w.agentId = agentId; return true;
  }
  function setLane(id, lane) { const w = find(id); if (!w || LANES.indexOf(lane) < 0) return false; w.lane = lane; return true; }
  function pin(id, val) { const w = find(id); if (!w) return false; w.pinned = val !== false; return true; }
  function touch(id) { const w = find(id); if (w) w.lastActiveAt = now(); return !!w; }

  // General can never be archived or deleted (it's the always-present chat home); archiving/deleting
  // the active stream falls back to General so the UI is never left pointing at nothing.
  function archive(id, val) {
    if (id === generalId) return false;
    const w = find(id); if (!w) return false;
    w.archived = val !== false;
    if (w.archived && activeId === id) activeId = generalId;
    return true;
  }
  function del(id) {
    if (id === generalId) return false;
    const i = ws.findIndex(w => w.id === id);
    if (i < 0) return false;
    ws.splice(i, 1);
    if (activeId === id) activeId = generalId;
    return true;
  }

  // ---------- titles ----------
  function deriveTitle(text) {
    let t = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
    if (!t) return null;
    t = (t.split(/[.!?\n]/)[0] || t).trim() || t;   // first sentence
    const CAP = 60;
    if (t.length <= CAP) return t;
    let cut = t.slice(0, CAP);
    const sp = cut.lastIndexOf(' ');
    if (sp > 0) cut = cut.slice(0, sp);             // never cut mid-word
    return cut.replace(/[\s,.;:!?-]+$/, '') + '…';
  }
  // name an untitled, non-General stream from its first user message (no-op otherwise).
  function autoTitle(id, text) {
    const w = find(id);
    if (!w || w.id === generalId || w.title != null) return false;
    const tt = deriveTitle(text);
    if (!tt) return false;
    w.title = tt; return true;
  }

  // ---------- runs · deliverables · cost (filed onto the stream that spawned them) ----------
  function appendRun(id, runId) {
    const w = find(id); if (!w || !runId) return false;
    if (w.runIds.indexOf(runId) < 0) w.runIds.push(runId);   // tolerate dup / no-op runs (e.g. the no-tool-support early error)
    if (w.lane === 'todo') w.lane = 'active';                // hybrid-honest: a REAL run fired
    w.lastActiveAt = now();
    return true;
  }
  function recordDeliverable(id, d) {
    const w = find(id); if (!w || !d) return false;
    w.deliverables.push({ title: String(d.title || ''), kind: d.kind || 'file', runId: d.runId || null, t: d.t || now() });
    return true;
  }
  // accumulate a per-stream usage delta (chat.js passes a copy-snapshotted Harness.totals() diff).
  function addCost(id, delta) {
    const w = find(id); if (!w || !delta) return false;
    w.cost.tokens += +delta.tokens || 0;
    w.cost.usd += +delta.usd || 0;
    w.cost.calls += +delta.calls || 0;
    return true;
  }
  function costOf(id) { const w = find(id); return w ? { tokens: w.cost.tokens, usd: w.cost.usd, calls: w.cost.calls } : zeroCost(); }

  // ---------- search (title + message bodies; client-side, localStorage scale) ----------
  function search(q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const w of ws) {
      const hay = [w.title || 'general'].concat(w.history.map(m => (m && m.content) || '')).join('\n');
      const i = hay.toLowerCase().indexOf(q);
      if (i >= 0) {
        const start = Math.max(0, i - 20);
        out.push({ id: w.id, title: w.title, snippet: hay.slice(start, start + 60).replace(/\s+/g, ' ').trim() });
      }
    }
    return out;
  }

  // ---------- migrations / imports (pure; save.js + stationui.js delegate here) ----------
  // skynet.save v1 { agent, history, usage } -> the v2 workstreams slice. The entire legacy
  // conversation becomes a single General stream; its cost is SEEDED from the existing lifetime
  // usage so the per-stream number matches reality (nothing invented). agent + lifetime usage stay
  // at the envelope root (save.js merges this slice in) — they remain the billing source of truth.
  function migrateV1(doc) {
    doc = doc || {};
    const u = doc.usage || {};
    const t = doc.updatedAt || now();
    const general = make({
      id: 'ws_general', title: null, lane: 'active',
      history: Array.isArray(doc.history) ? doc.history : [],
      cost: { tokens: +u.tokens || 0, usd: +u.cost || 0, calls: +u.calls || 0 },
      createdAt: t, lastActiveAt: t
    });
    return { workstreams: [general], activeId: general.id, generalId: general.id };
  }

  // one-shot import of the legacy station kanban tasks[] into real workstreams (col -> lane,
  // empty history). The caller (slice 3) guards this to run exactly once, then clears tasks[].
  function importTasks(tasks) {
    const created = (Array.isArray(tasks) ? tasks : []).map(tk => make({
      title: (tk && tk.title) || null,
      lane: LANE_OF_COL[tk && tk.col] || 'todo',
      createdAt: (tk && tk.t) || now(), lastActiveAt: (tk && tk.t) || now()
    }));
    for (const w of created) ws.push(w);
    return created;
  }

  return {
    init, reset, serialize, all, list, search,
    create, get, active, activeId: getActiveId, generalId: getGeneralId,
    switch: switchTo, rename, setAgent, setLane, pin, archive, del, touch,
    autoTitle, deriveTitle,
    appendRun, recordDeliverable, addCost, costOf,
    migrateV1, importTasks,
    LANES
  };
});
