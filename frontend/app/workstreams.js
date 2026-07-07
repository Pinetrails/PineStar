/* STARNET — workstreams.js : the unified unit-of-work record (session organization).
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
    const lane = LANES.indexOf(opts.lane) >= 0 ? opts.lane : 'todo';
    return {
      id: opts.id || uid(),
      title: opts.title != null ? clamp(opts.title, 80) : null,    // null = the General default stream
      agentId: opts.agentId || 'agent',
      roomId: opts.roomId != null ? opts.roomId : null,            // dormant builder seam: a room IS a channel, later
      lane: lane,
      // TASK-BOARD TRUTH: 'task' = a deliberate board directive (renders as a card); 'chat' = a plain session
      // (rail-only, never on the board). A NEW record honours opts.kind ('task' only when asked, else 'chat').
      // On the idempotent re-normalize of a SAVED record, kind is preserved verbatim; a pre-upgrade save with NO
      // kind is INFERRED — only the two lanes a human board action can produce (todo/shipped) imply a task; every
      // other saved stream (including auto-advanced 'active' sessions) was a chat. The inference runs ONLY when
      // opts.kind is absent/invalid, so a saved 'chat' in the 'shipped' lane (impossible today) still can't lie.
      kind: (opts.kind === 'task' || opts.kind === 'chat')
        ? opts.kind
        : ((lane === 'todo' || lane === 'shipped') ? 'task' : 'chat'),
      history: Array.isArray(opts.history) ? opts.history.slice() : [],
      runIds: Array.isArray(opts.runIds) ? opts.runIds.slice() : [],
      deliverables: Array.isArray(opts.deliverables) ? opts.deliverables.slice() : [],
      cost: { tokens: +c.tokens || 0, usd: +c.usd || 0, calls: +c.calls || 0 },
      pinned: !!opts.pinned,
      archived: !!opts.archived,
      // true = a machine-derived placeholder title, eligible for the one-shot LLM summary upgrade after the
      // stream's first run. A manual rename() flips it false so the upgrade (and any future auto-title) can
      // never stomp a title the human chose. Defaults true; preserved verbatim through init()'s re-normalize.
      titleAuto: opts.titleAuto != null ? !!opts.titleAuto : true,
      // /goal AUTONOMOUS LOOP state (chat.js owns the shape via GoalLoop.normalize) — carried through verbatim so a
      // standing goal survives a reload/switch exactly like the thread history. Undefined for a stream with no loop.
      goalLoop: (opts.goalLoop && typeof opts.goalLoop === 'object') ? opts.goalLoop : undefined,
      createdAt: opts.createdAt || t,
      lastActiveAt: opts.lastActiveAt || t,
      // when the Commander last had this stream OPEN. unread = lastActiveAt > lastReadAt (truthful:
      // both are real stored timestamps — no invented counts). A record saved before this field
      // existed defaults to its lastActiveAt so an upgrade never floods the rail with false unreads.
      lastReadAt: opts.lastReadAt != null ? opts.lastReadAt : (opts.lastActiveAt || t)
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
    const a = active();
    if (a && (a.lastActiveAt || 0) > (a.lastReadAt || 0)) a.lastReadAt = a.lastActiveAt;   // boot renders it — read
    return a;
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
  function switchTo(id) { const w = find(id); if (w) { activeId = id; w.lastReadAt = now(); } return w; }
  // opening a stream reads it; new activity on the OPEN stream is read as it lands (touch/appendRun sync below).
  function markRead(id) { const w = find(id); if (!w) return false; w.lastReadAt = now(); return true; }
  function isUnread(w) {
    w = (w && w.id) ? w : find(w);
    return !!w && w.id !== activeId && (w.lastActiveAt || 0) > (w.lastReadAt || 0);
  }

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
    // create() always mints a 'todo' record, so make()'s lane-inference would read it as a task — pass an
    // EXPLICIT kind so a freshly-created stream is 'chat' UNLESS the caller is a board directive (kind:'task').
    const w = make({ title: title || null, lane: 'todo', agentId: opts.agentId, kind: opts.kind === 'task' ? 'task' : 'chat' });   // summon binds a stream to its NEW agent
    ws.push(w);
    if (opts.activate !== false) activeId = w.id;   // board "add" passes {activate:false} so it won't hijack the active chat
    return w;
  }
  // ADOPT a workstream with a CALLER-CHOSEN id (idempotent): if one already exists with opts.id it is
  // returned untouched; otherwise a new record is minted from opts and inserted WITHOUT stealing the active
  // stream (never sets activeId — the caller decides whether to focus it). This is the seam the autosessions
  // layer uses to surface an unattended cron run as a session keyed by its own 'cron-<runId>' stream id, so
  // the rail row and the durable server transcript share one identity. Returns the (existing or new) record.
  function adopt(opts) {
    opts = opts || {};
    if (opts.id) { const ex = find(opts.id); if (ex) return ex; }
    const w = make(opts);
    ws.push(w);
    return w;
  }

  // a MANUAL rename: locks the title (titleAuto=false) so the auto-summary upgrade never overwrites it.
  function rename(id, title) { const w = find(id); if (!w) return false; w.title = title ? clamp(title, 80) : null; w.titleAuto = false; return true; }
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
  function touch(id) { const w = find(id); if (w) { w.lastActiveAt = now(); if (id === activeId) w.lastReadAt = w.lastActiveAt; } return !!w; }

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
  // DOSSIER › DELETE AGENT support: drop every (non-General) stream bound to a now-deleted agent so the rail
  // can't reopen a stream with no agent behind it. General is never bound to a specialist, so it's untouched;
  // if the active stream was one of the removed, activeId falls back to General (via del). Returns the count.
  function removeByAgent(agentId) {
    const aid = String(agentId == null ? '' : agentId);
    if (!aid) return 0;
    let n = 0;
    for (const w of ws.slice()) { if (w.id !== generalId && w.agentId === aid && del(w.id)) n++; }
    return n;
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
  // name an untitled, non-General stream from its first user message (no-op otherwise). This is the INSTANT
  // placeholder (first-sentence truncation); retitle() later upgrades it to a model-written summary.
  function autoTitle(id, text) {
    const w = find(id);
    if (!w || w.id === generalId || w.title != null) return false;
    const tt = deriveTitle(text);
    if (!tt) return false;
    w.title = tt; w.titleAuto = true; return true;
  }
  // UPGRADE an auto-derived placeholder to a concise model-written summary (chat.js fires this once, after a
  // new stream's first run, passing a 3-6 word LLM title). Honors the human: a stream whose title was MANUALLY
  // renamed (titleAuto === false) is never stomped, and General is never titled. Returns false (no change) when
  // locked / General / the summary is empty — so a model hiccup just leaves the instant placeholder in place.
  function retitle(id, title) {
    const w = find(id);
    if (!w || w.id === generalId || w.titleAuto === false) return false;
    const tt = clamp(String(title == null ? '' : title).trim().replace(/\s+/g, ' '), 80);
    if (!tt) return false;
    w.title = tt; w.titleAuto = true; return true;
  }

  // ---------- runs · deliverables · cost (filed onto the stream that spawned them) ----------
  function appendRun(id, runId) {
    const w = find(id); if (!w || !runId) return false;
    if (w.runIds.indexOf(runId) < 0) w.runIds.push(runId);   // tolerate dup / no-op runs (e.g. the no-tool-support early error)
    if (w.lane === 'todo') w.lane = 'active';                // hybrid-honest: a REAL run fired
    w.lastActiveAt = now();
    if (id === activeId) w.lastReadAt = w.lastActiveAt;      // the open stream is being watched, not unread
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
  // starnet.save v1 { agent, history, usage } -> the v2 workstreams slice. The entire legacy
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
    create, adopt, get, active, activeId: getActiveId, generalId: getGeneralId,
    switch: switchTo, rename, setAgent, setLane, pin, archive, del, removeByAgent, touch, markRead, unread: isUnread,
    autoTitle, retitle, deriveTitle,
    appendRun, recordDeliverable, addCost, costOf,
    migrateV1, importTasks,
    LANES
  };
});
