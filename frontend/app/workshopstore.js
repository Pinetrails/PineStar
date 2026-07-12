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

   The W1/W2 backend is LIVE on trunk (routes /api/workshop/grant|queue|pending|decide|shift|backlog), so
   this store talks to the real sidecar only — no dev stub. */
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
  // ---- reads ----
  // undecided manifests the Commander hasn't acted on. Filters out anything they said "Later" to this
  // session (anti-nag) and anything already shown this session (poll-race guard). Fail-open to [].
  // which agents to poll for pending deliverables. The backend keys the backlog per-agent and requires an
  // explicit ?agent=<id>, so we ask for each live agent (the hero + any crew) and flatten. deps.agentIds()
  // is injected by app.js; absent → just the hero.
  function agentIds() { try { const a = deps.agentIds ? deps.agentIds() : null; return (Array.isArray(a) && a.length) ? a : ['agent']; } catch (_) { return ['agent']; } }

  async function fetchPending() {
    let list = [];
    for (const id of agentIds()) {
      try {
        const r = await fetch('/api/workshop/pending?agent=' + encodeURIComponent(id), { cache: 'no-store' });
        if (!r.ok) continue;
        const j = await r.json();
        const arr = Array.isArray(j) ? j : (j && Array.isArray(j.pending) ? j.pending : []);
        for (const m of arr) { if (m && m.runId) { if (!m.agentId) m.agentId = id; list.push(m); } }
      } catch (_) { /* fail-open: this agent just contributes nothing */ }
    }
    if (!ready()) state = hydrate(load());
    return list.filter(m => m && m.runId && !state.later[m.runId] && state.seen.indexOf(m.runId) === -1);
  }

  // ---- away-mode truth (item #2) ----
  // HOW "AWAY" ACTUALLY WORKS (verified against sidecar/index.js, not the audit's guess):
  //   • A queued idea lands in the agent's durable backlog (POST /api/workshop/queue). The queue does NOT check
  //     the grant — it succeeds even with the grant OFF (the item just sits there, never built). That silent
  //     dead-end is the real bug the audit half-saw ("fails quietly"); it doesn't fail, it succeeds-and-stalls.
  //   • The BUILD is a per-agent WORKSHOP SHIFT: a recurring cron routine (~every 6h) that the "build while away"
  //     GRANT arms (handleWorkshopGrant → armWorkshopShift, which also arms the scheduler). It fires on that
  //     cadence while the STATION IS RUNNING — it is NOT gated on the app being closed. So the honest condition is
  //     "grant on + station running", NOT "app closed". The return DIGEST (returnstore.js heartbeat) is the part
  //     that's about the app being closed — a different subsystem the audit conflated with the build.
  // The confirm copy therefore states the grant + recurring-shift truth, and never the false "runs while closed".
  function queueConfirmLine(name) {
    const who = String(name || 'it').trim() || 'it';
    return '◈ queued for the away workshop — ' + who + ' will build this in its private sandbox on its next away shift '
      + '(a recurring build that runs on its own while the station is up). you’ll review the result on return.';
  }

  // read the agent's live "build while away" grant (GET /api/workshop/backlog returns { granted }). Fail-open to
  // null (unknown) so a render site degrades to neutral copy rather than asserting a grant state it couldn't read.
  async function grantOf(agentId) {
    try {
      const r = await fetch('/api/workshop/backlog?agent=' + encodeURIComponent(agentId || 'agent'), { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      return j && typeof j.granted === 'boolean' ? j.granted : null;
    } catch (_) { return null; }
  }

  // ---- writes ----
  // queue an idea for an agent to build while away. item: { agentId, text, sourceType, sourceId? }.
  // Returns { ok, error?, warn?, needsGrant?, agentId }. Never throws — the caller shows a one-line notice off the
  // result. On a successful queue we probe the grant: if it's OFF the item will NEVER be built until the Commander
  // turns "build while away" on, so we return a VISIBLE warn + needsGrant so the render site can offer that toggle
  // (openGrant below) — turning the old silent stall into an honest, actionable state.
  async function queue(item) {
    const text = String((item && item.text) || '').trim();
    // PINNED-contract → live backend shape: the sidecar's /api/workshop/queue takes { agentId, title,
    // detail?, source: 'quest'|'queued', id? }. Our callers speak {text, sourceType, sourceId}; map here so
    // the entry points stay simple. 'quest' is the only special source; everything else is a plain queued idea.
    const body = {
      agentId: (item && item.agentId) || 'agent',
      title: text,
      source: ((item && item.sourceType) === 'quest') ? 'quest' : 'queued'
    };
    if (item && item.sourceId) body.id = String(item.sourceId).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    if (!text) return { ok: false, error: 'nothing to build' };
    const aid = body.agentId;
    try {
      const r = await fetch('/api/workshop/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      // ok:true → added/exists (already-queued is a benign success). ok:false → duplicate/discarded:
      // surface the backend's own plain, anti-retry message so we never re-queue the same thing.
      if (r.ok && j && j.ok === true) {
        // GRANT PROBE (item #2): the queue succeeded, but the item only ever BUILDS if the away grant is on. If it's
        // OFF, say so with a way to fix it — never let it stall silently. `granted:null` (couldn't read) → no warn,
        // rather than a maybe-wrong claim.
        const granted = await grantOf(aid);
        if (granted === false) {
          const who = String((item && item.name) || aid || 'this agent');   // display name if the caller passed one, else the id
          return { ok: true, reason: j.reason, agentId: aid, needsGrant: true,
            warn: 'saved to the build list — but “build while away” is OFF for ' + who + ', so it won’t be built yet. turn it on to let the away shift build it.' };
        }
        return { ok: true, reason: j.reason, agentId: aid };
      }
      if (r.ok && j && j.ok === false) return { ok: false, error: j.message || 'already handled' };
      return { ok: false, error: (j && (j.error || j.message)) || 'queue failed' };
    } catch (_) { return { ok: false, error: 'queue error' }; }
  }

  // turn the "build while away" grant ON for an agent (POST /api/workshop/grant) — the action the queue's
  // needsGrant warning offers. Arms the workshop shift server-side. Returns { ok, error? }; never throws.
  async function openGrant(agentId) {
    try {
      const r = await fetch('/api/workshop/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: agentId || 'agent', on: true }) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok) return { ok: true };
      return { ok: false, error: (j && (j.error || j.message)) || 'could not enable it' };
    } catch (_) { return { ok: false, error: 'could not reach the station' }; }
  }

  // decide a return card. decision: 'keep' (destPath required) | 'later' | 'discard'.
  // keep → copy the run dir's files to destPath; discard → wipe the run dir + denylist the backlog item;
  // later → just dismiss (server keeps it pending). Returns { ok, destPath?, error? }. Never throws.
  async function decide(agentId, runId, decision, destPath, extra) {
    if (!ready()) state = hydrate(load());
    // record locally FIRST so a poll race can't re-show a card the Commander just acted on.
    if (decision === 'later') { state.later[runId] = true; }
    if (state.seen.indexOf(runId) === -1) { state.seen.push(runId); if (state.seen.length > 200) state.seen = state.seen.slice(-200); }
    save();
    const body = { agentId: agentId || 'agent', runId: runId, decision: decision };
    if (decision === 'keep' && destPath) body.destPath = destPath;
    try {
      const r = await fetch('/api/workshop/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok !== false) {
        const keptPath = (j && j.destPath) || body.destPath;
        // Keep is a filesystem copy only. Renderer IPC cannot prove a fresh user
        // gesture, so a run may not launch an OS file manager on the user's desktop.
        return { ok: true, destPath: keptPath, opened: false };
      }
      return { ok: false, error: (j && j.error) || 'could not save your decision' };
    } catch (_) { return { ok: false, error: 'decision failed to reach the station' }; }
  }

  // read a file inside the deliverable for the viewer, via the EXISTING jailed read-only route /api/file
  // (resolveInside proves the path can't escape the agent's workspace). The deliverable's files are relative
  // to the run dir, so we prefix workshop/<runId>/. Auth: the hardened window.fetch (harness.js) attaches the
  // per-launch token header to every /api/ URL, so we don't hand-append ?token= here. Fail-open to '' so a
  // missing/edited file never throws.
  async function readFile(agentId, runId, relPath) {
    try {
      const rel = 'workshop/' + runId + '/' + relPath;
      const url = '/api/file?agent=' + encodeURIComponent(agentId || 'agent') + '&path=' + encodeURIComponent(rel);
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return '';
      return await r.text();
    } catch (_) { return ''; }
  }

  // W7 — the URL that RUNS a workshop file in a browser tab, served from the jailed read-only /workshop-run/ static
  // route. A tab navigation (window.open) can't send the token header, so it rides ?token= exactly like /api/file.
  // The per-launch token is injected synchronously into the page (window.__STARNET_API_TOKEN__), so read it directly
  // (Harness.apiToken() is a promise — not usable in a sync href). Returns '' if the token isn't present yet.
  function runUrl(agentId, runId, relPath) {
    const tok = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) ? String(window.__STARNET_API_TOKEN__) : '';
    if (!tok) return '';
    // Desktop: the page's origin is the Tauri webview (bundled frontend), NOT the sidecar, and the injected
    // fetch shim only rewrites '/api/'-prefixed strings — so this URL must carry the sidecar base explicitly
    // (window.__STARNET_API__ = http://127.0.0.1:<port>). Browser build: __STARNET_API__ is unset → relative.
    const base = (typeof window !== 'undefined' && window.__STARNET_API__) ? String(window.__STARNET_API__) : '';
    const parts = String(relPath || '').split('/').map(encodeURIComponent).join('/');
    return base + '/workshop-run/' + encodeURIComponent(agentId || 'agent') + '/' + encodeURIComponent(runId) + '/' + parts
      + '?token=' + encodeURIComponent(tok);
  }

  // W7 — OS launch is intentionally unavailable: neither loopback API possession nor
  // renderer IPC proves a fresh human gesture. The caller presents manual-open guidance.
  async function openFile(agentId, runId, relPath) {
    return { ok: false, error: 'Open this file manually; StarNet cannot launch desktop applications from a run.' };
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
    const aid = m.agentId || 'agent';
    Chat.workshopReturn(m, {
      readFile: readFile,
      desktopDefault: desktopDefault(),
      runUrl: (relPath) => runUrl(aid, m.runId, relPath),          // W7: URL that RUNS a web file in a tab
      openFile: (relPath) => openFile(aid, m.runId, relPath),      // W7: manual-open guidance; never OS-launch
      onDecide: (decision, destPath, extra) => decide(aid, m.runId, decision, destPath, extra)
    });
  }

  // init({ enabled, desktopDefault }) — called from enterGame. enabled:false (the awakening) skips the beat.
  function init(opts) {
    opts = opts || {};
    deps = { desktopDefault: opts.desktopDefault, agentIds: opts.agentIds };
    state = hydrate(load());
    if (opts.enabled !== false) setTimeout(() => { maybePresent().catch(() => {}); }, ATTACH_DELAY_MS);
  }

  // S2/new-hero: a fresh Commander inherits no prior "later" list.
  function reset() { state = hydrate(null); fired = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, queue, decide, readFile, runUrl, openFile, desktopDefault, fetchPending, reset, queueConfirmLine, grantOf, openGrant, _hydrate: hydrate };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { WorkshopStore };
