/* STARNET — workshopstore.js : the AWAY-WORKSHOP return surface (lane W3, frontend).

   The Commander switched an agent's "build things while I'm away" grant on; while they were gone an
   autonomous shift built a deliverable in that agent's jailed sandbox and wrote a manifest. This store
   is the thin live wiring that, on browser attach, asks the sidecar what's UNDECIDED
   (GET /api/workshop/pending) and hands ONE manifest at a time to the gold-inset return-card beat
   (Chat.workshopReturn) — the same "one post-run beat at a time" slot every other return beat rides.

   It also owns the two write paths the rest of the UI calls into:
     • queue(item)   → POST /api/workshop/queue  (the "build this while I'm away" action)
     • decide(...)   → POST /api/workshop/decide  (Keep / Later / Discard on the return card)

   HONESTY RULES (truthful telemetry — the product's core law):
     • A card asserts ONLY what its manifest proves. "tested — N passed" renders solely from a real
       manifest.verified block; otherwise the card says "built, not yet tested". Never invented status.
     • Decided-once: a Keep or Discard drops the manifest from pending server-side; a Later just dismisses
       the card for this session (it may return next session). A locally-seen ledger keeps a single page
       session from re-showing the same card if a poll races. Dismissed = gone, the anti-nag law.
     • Fail-open: any fetch error → no beat (never a fabricated card, never a thrown error at attach).

   NO U.bus emits. Self-persists a tiny "shown this session / declined-later" ledger to its own key
   (rides the backup prefix like returnstore/mintstore) — no save.js change. node-exportable for its test.

   DEV STUB (frontend-only, removable): when the backend routes aren't live yet, ?workshopstub=1 (or
   localStorage 'starnet.workshop.devstub'='1') makes the fetch layer return a canned manifest and accept
   decisions in-memory, so the return-card UI can be verified against the PINNED contract shape before the
   W1/W2 backend lands. Guarded + clearly marked; it is a no-op the moment a real backend answers. */
'use strict';
const WorkshopStore = (() => {
  const KEY = 'starnet.workshop.v1';
  const ATTACH_DELAY_MS = 1800;   // let the floor + COMMS settle before the return beat (mirrors ReturnStore)
  let state = null;               // { v:1, later:{runId:true}, seen:[runId] } — session-scoped anti-nag
  let fired = false;              // one auto-poll per page session
  let deps = {};                  // { desktopDefault() } injected by app.js (a sensible Keep destination)

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { if (state) localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function hydrate(raw) {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return {
      v: 1,
      later: (s.later && typeof s.later === 'object') ? s.later : {},   // runIds the Commander said "Later" to THIS session
      seen: Array.isArray(s.seen) ? s.seen.filter(x => typeof x === 'string').slice(-200) : []
    };
  }
  const ready = () => !!state;

  // ---- dev stub (frontend fetch layer only — see header) ----
  function stubOn() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('starnet.workshop.devstub') === '1') return true;
      if (typeof location !== 'undefined' && /(?:^|[?&])workshopstub=1(?:&|$)/.test(location.search)) return true;
    } catch (_) {}
    return false;
  }
  let STUB = null;   // lazily-built in-memory pending list when the stub is on
  function stubPending() {
    if (!STUB) STUB = [{
      v: 1, runId: 'stub-run-1', agentId: 'agent', backlogId: 'stub-backlog-1',
      title: 'CSV → JSON converter', kind: 'tool',
      summary: 'A small Node script that reads a CSV file and writes the same rows as pretty-printed JSON.',
      files: [ { path: 'convert.js', bytes: 812 }, { path: 'README.md', bytes: 240 } ],
      howToUse: 'Run `node convert.js input.csv > out.json` from the folder.',
      notVerified: ['edge cases with quoted commas untested'],
      verified: null
    }];
    return STUB.slice();
  }

  // ---- reads ----
  // undecided manifests the Commander hasn't acted on. Filters out anything they said "Later" to this
  // session (anti-nag) and anything already shown this session (poll-race guard). Fail-open to [].
  async function fetchPending() {
    let list = [];
    if (stubOn()) { list = stubPending(); }
    else {
      try {
        const r = await fetch('/api/workshop/pending', { cache: 'no-store' });
        if (!r.ok) return [];
        const j = await r.json();
        list = Array.isArray(j) ? j : (j && Array.isArray(j.pending) ? j.pending : []);
      } catch (_) { return []; }
    }
    if (!ready()) state = hydrate(load());
    return list.filter(m => m && m.runId && !state.later[m.runId] && state.seen.indexOf(m.runId) === -1);
  }

  // ---- writes ----
  // queue an idea for an agent to build while away. item: { agentId, text, sourceType, sourceId? }.
  // Returns { ok, error? }. Never throws — the caller shows a one-line notice off the result.
  async function queue(item) {
    const body = {
      agentId: (item && item.agentId) || 'agent',
      text: String((item && item.text) || '').trim(),
      sourceType: (item && item.sourceType) || 'text',
      sourceId: (item && item.sourceId) || null
    };
    if (!body.text) return { ok: false, error: 'nothing to build' };
    if (stubOn()) return { ok: true, stub: true };
    try {
      const r = await fetch('/api/workshop/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok !== false) return { ok: true };
      return { ok: false, error: (j && j.error) || 'queue failed' };
    } catch (_) { return { ok: false, error: 'queue error' }; }
  }

  // decide a return card. decision: 'keep' (destPath required) | 'later' | 'discard'.
  // keep → copy the run dir's files to destPath; discard → wipe the run dir + denylist the backlog item;
  // later → just dismiss (server keeps it pending). Returns { ok, destPath?, error? }. Never throws.
  async function decide(agentId, runId, decision, destPath) {
    if (!ready()) state = hydrate(load());
    // record locally FIRST so a poll race can't re-show a card the Commander just acted on.
    if (decision === 'later') { state.later[runId] = true; }
    if (state.seen.indexOf(runId) === -1) { state.seen.push(runId); if (state.seen.length > 200) state.seen = state.seen.slice(-200); }
    save();
    const body = { agentId: agentId || 'agent', runId: runId, decision: decision };
    if (decision === 'keep' && destPath) body.destPath = destPath;
    if (stubOn()) {
      if (STUB) STUB = STUB.filter(m => m.runId !== runId);
      return { ok: true, stub: true, destPath: body.destPath };
    }
    try {
      const r = await fetch('/api/workshop/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok !== false) return { ok: true, destPath: (j && j.destPath) || body.destPath };
      return { ok: false, error: (j && j.error) || 'could not save your decision' };
    } catch (_) { return { ok: false, error: 'decision failed to reach the station' }; }
  }

  // read a file inside the deliverable for the viewer, via the existing jailed fs read route. Fail-open to ''.
  async function readFile(agentId, runId, relPath) {
    if (stubOn()) {
      const canned = { 'convert.js': "const fs=require('fs');\n// reads a CSV, writes JSON\n// (dev-stub sample content)\n", 'README.md': '# CSV to JSON\n\nRun `node convert.js input.csv`.\n' };
      return canned[relPath] || '(no preview)';
    }
    try {
      const qs = 'agent=' + encodeURIComponent(agentId || 'agent') + '&runId=' + encodeURIComponent(runId) + '&path=' + encodeURIComponent(relPath);
      const r = await fetch('/api/workshop/file?' + qs, { cache: 'no-store' });
      if (!r.ok) return '';
      const ct = (r.headers.get('content-type') || '');
      if (ct.indexOf('application/json') >= 0) { const j = await r.json().catch(() => null); return (j && typeof j.content === 'string') ? j.content : ''; }
      return await r.text();
    } catch (_) { return ''; }
  }

  // the sensible default Keep destination (the Commander's Desktop, when the desktop shell knows it).
  function desktopDefault() { try { return deps.desktopDefault ? (deps.desktopDefault() || '') : ''; } catch (_) { return ''; } }

  // auto-poll on attach: show the OLDEST undecided manifest as one return-card beat. Once per page session.
  async function maybePresent() {
    if (fired || !ready()) return;
    if (typeof Chat === 'undefined' || !Chat.workshopReturn) return;
    const pending = await fetchPending();
    if (!pending.length) return;
    fired = true;
    const m = pending[0];
    if (state.seen.indexOf(m.runId) === -1) { state.seen.push(m.runId); save(); }   // shown once this session
    Chat.workshopReturn(m, {
      readFile: readFile,
      desktopDefault: desktopDefault(),
      onDecide: (decision, destPath) => decide(m.agentId || 'agent', m.runId, decision, destPath)
    });
  }

  // init({ enabled, desktopDefault }) — called from enterGame. enabled:false (the awakening) skips the beat.
  function init(opts) {
    opts = opts || {};
    deps = { desktopDefault: opts.desktopDefault };
    state = hydrate(load());
    if (opts.enabled !== false) setTimeout(() => { maybePresent().catch(() => {}); }, ATTACH_DELAY_MS);
  }

  // S2/new-hero: a fresh Commander inherits no prior "later" list.
  function reset() { state = hydrate(null); fired = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, queue, decide, readFile, desktopDefault, fetchPending, reset, _hydrate: hydrate, _stubOn: stubOn };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { WorkshopStore };
