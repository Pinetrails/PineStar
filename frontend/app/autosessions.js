/* STARNET — autosessions.js : surface an UNATTENDED cron/routine run as a readable SESSION.

   THE BUG THIS CLOSES. A cron routine fires headless (cron-driver.js fireJob → runOnce with
   surface:'autonomous', trigger:'schedule'). Its reply text is buffered server-side and only an
   OUTCOME enum escapes on cron.result — so the Commander hears the HUD chime + the away-digest
   toast but can never READ what the routine actually produced. There was no session, no thread,
   no output. This module makes an unattended run appear as a real workstream the instant it fires
   (rail row, marked busy) and folds its durable transcript into that session when it completes —
   Claude-Code / Hermes session-list parity.

   HOW IT WORKS (no new events; the contract is OWNED). The sidecar now runs every cron fire under
   a PER-RUN stream id 'cron-<runId>' (cron-driver.js), so its dialogue persists durably via the
   same transcriptStore every attended run uses. This layer is a READ-ONLY citizen of U.bus:
     · cron.fire {jobId, runId}  → ADOPT a workstream id 'cron-<runId>' (title = routine name from
       the /api/cron catalogue, agentId = the job's agent, lane 'active', history seeded with the
       routine's prompt as the user turn) and mark it busy — WITHOUT stealing the Commander's
       focus. The rail row appears immediately.
     · cron.result {jobId, runId, outcome} → GET /api/transcript?stream=cron-<runId>, fold the
       assistant turns into that session's history in chat.js's exact shape, clear busy, persist,
       re-render. A 'failed' outcome appends an honest error line; a bare '[SILENT]' reply is
       shown as a quiet marker (truthful telemetry — never fake content, never hidden real content).
     · BOOT BACKFILL: on init, read /api/runs?agent=*, and for every run whose streamId starts
       'cron-' with no live session, adopt + backfill it — so routines that ran while the browser
       was CLOSED are also readable. Bounded + fail-open (a route error → no crash, no fake rows).

   Follows the *store.js wiring pattern (returnstore/autojobstore): a plain init()/reset() surface,
   never .emit()s (lint-emits stays green), self-contained, reads the same /api routes the return
   ritual reads. Depends on the Workstreams / Channels / Chat / App globals loaded before it. */
'use strict';
const AutoSessions = (() => {
  const STREAM_PREFIX = 'cron-';
  let routines = null;         // jobId -> { name, agentId, prompt } cache from /api/cron (lazy)
  let wired = false;           // U.bus subscriptions installed once
  let backfilling = false;     // in-flight boot backfill guard (idempotent)

  // presence guards use `typeof X` (bare identifier) — App/Chat are top-level `const`s, NOT window props,
  // so `window.App` is undefined even though the `App` binding resolves. Match how chat.js probes App.
  const hasWS = () => typeof Workstreams !== 'undefined' && Workstreams;
  const hasCh = () => typeof Channels !== 'undefined' && Channels;
  const hasChat = () => typeof Chat !== 'undefined' && Chat;
  const hasApp = () => typeof App !== 'undefined' && App;
  const hasU = () => typeof U !== 'undefined' && U && U.bus && U.bus.on;
  const streamOf = (runId) => STREAM_PREFIX + String(runId);
  // 'cron-' + a runId (crypto.randomUUID: hex + hyphens) fits the workstream/stream grammar (/^[A-Za-z0-9_-]{1,64}$/).
  function validStream(id) { return /^cron-[A-Za-z0-9_-]{1,58}$/.test(String(id || '')); }

  // ---- routine catalogue (names + prompts) ----------------------------------------------------
  async function loadRoutines() {
    try {
      const r = await fetch('/api/cron', { cache: 'no-store' });
      if (!r.ok) return (routines = routines || {});
      const jobs = ((await r.json()) || {}).jobs || [];
      const map = Object.create(null);
      for (const j of jobs) {
        if (!j || !j.id) continue;
        map[j.id] = { name: String(j.name || '').trim(), agentId: String(j.agentId || 'agent'), prompt: String(j.prompt || '') };
      }
      routines = map;
    } catch (_) { routines = routines || {}; }   // fail-open: names are cosmetic, a session still forms
    return routines;
  }
  function routineFor(jobId) { return (routines && routines[jobId]) || null; }

  // ---- session lifecycle ----------------------------------------------------------------------
  // Adopt (idempotent) the session for one cron run and mark it busy WITHOUT stealing focus. `job`
  // (optional) supplies the human title / agent / seeding prompt; absent, the row still forms honestly.
  function beginSession(runId, job) {
    if (!hasWS()) return null;
    const id = streamOf(runId);
    if (!validStream(id)) return null;
    const title = (job && job.name) || 'Routine';
    const agentId = (job && job.agentId) || 'agent';
    const seed = (job && job.prompt) ? [{ role: 'user', content: String(job.prompt) }] : [];
    const ws = Workstreams.adopt({ id: id, title: title, agentId: agentId, lane: 'active', history: seed });
    // mark the row busy via the SAME per-workstream channel state chat.js drives (Channels.begin) so the
    // rail's railRowState paints the pulsing "running" dot — reused, not a bespoke busy flag.
    if (hasCh() && !Channels.isBusy(id)) Channels.begin(id, Date.now());
    refreshRail();
    persist();
    return ws;
  }

  // Fold a completed run's durable transcript into its session, clear busy, persist, re-render.
  async function completeSession(runId, outcome, reason) {
    if (!hasWS()) return;
    const id = streamOf(runId);
    if (!validStream(id)) return;
    // event-ordering safety: result may arrive before we processed fire (or after a backfill miss) — ensure
    // the session exists, seeding from the routine cache when we have it.
    let ws = Workstreams.get(id);
    if (!ws) ws = beginSession(runId, routineFor(/* jobId unknown here */ '') || null);
    if (!ws) return;

    let turns = [];
    try {
      const r = await fetch('/api/transcript?agent=' + encodeURIComponent(ws.agentId || 'agent') + '&stream=' + encodeURIComponent(id) + '&limit=200', { cache: 'no-store' });
      if (r.ok) turns = ((await r.json()) || {}).turns || [];
    } catch (_) { turns = []; }   // fail-open: no fabricated content

    foldTurns(ws, turns, outcome, reason);
    if (hasCh()) Channels.end(id);   // clear the busy/running channel state
    // if this session is the one on screen, re-render it so the folded output is visible immediately.
    if (hasChat() && Workstreams.activeId && Workstreams.activeId() === id) Chat.load(ws);
    refreshRail();
    persist();
  }

  // Fold server transcript rows into ws.history in chat.js's EXACT native shape ({role, content, error?}).
  // Attended history only ever holds user/assistant turns (chat.js never pushes 'tool' rows), so we match
  // that: keep user + assistant prose, drop 'tool'/'system' mechanics. Idempotent-ish — we replace history
  // rather than append duplicates when re-folding the same run (a backfill that races a live result).
  function foldTurns(ws, turns, outcome, reason) {
    const next = [];
    for (const t of (turns || [])) {
      if (!t || (t.role !== 'user' && t.role !== 'assistant')) continue;   // mechanics (tool/system) stay out of COMMS
      const content = String(t.content == null ? '' : t.content);
      if (t.role === 'user') { next.push({ role: 'user', content: content }); continue; }
      // assistant: a bare '[SILENT]' reply is a REAL, honest outcome (the routine chose to stay quiet) — mark
      // it as such rather than dropping it to a blank thread. Empty prose (tool-only turn) is skipped.
      if (content.trim() === '[SILENT]') { next.push({ role: 'assistant', content: '— routine ran, nothing to report —' }); continue; }
      if (content.trim()) next.push({ role: 'assistant', content: content });
    }
    // a FAILED run must never look like it produced nothing: append an honest error line from the outcome.
    if (outcome === 'failed') {
      const why = String(reason || 'run failed').trim();
      next.push({ role: 'assistant', content: '⚠ Routine failed — ' + why, error: true });
    } else if (!next.some(m => m.role === 'assistant')) {
      // no assistant prose AND not failed → be truthful that the run settled without readable output.
      next.push({ role: 'assistant', content: '— routine ran, nothing to report —' });
    }
    ws.history = next;
    if (hasWS() && Workstreams.appendRun) Workstreams.appendRun(ws.id, ws.id);   // hybrid-honest: a real run fired → todo advances to active
  }

  // ---- boot backfill: sessions for cron runs that finished while the browser was CLOSED ---------
  async function backfill() {
    if (backfilling || !hasWS()) return;
    backfilling = true;
    try {
      await loadRoutines();   // names first so backfilled rows are titled
      let runs = [];
      try {
        const r = await fetch('/api/runs?agent=*&limit=100', { cache: 'no-store' });
        if (r.ok) runs = ((await r.json()) || {}).runs || [];
      } catch (_) { return; }   // route error → nothing to backfill, never crash
      const seen = Object.create(null);
      for (const run of runs) {
        const sid = run && run.streamId;
        if (!sid || String(sid).indexOf(STREAM_PREFIX) !== 0 || !validStream(sid)) continue;
        if (seen[sid] || Workstreams.get(sid)) continue;   // dedupe: one session per stream id
        seen[sid] = 1;
        const runId = String(sid).slice(STREAM_PREFIX.length);
        // adopt an idle (not busy) session then fold its transcript — a while-away run is already DONE.
        Workstreams.adopt({ id: sid, title: String(run.title || 'Routine').split('\n')[0].slice(0, 80) || 'Routine', agentId: String(run.agentId || 'agent'), lane: 'active', history: [] });
        const ws = Workstreams.get(sid);
        if (!ws) continue;
        let turns = [];
        try {
          const tr = await fetch('/api/transcript?agent=' + encodeURIComponent(ws.agentId || 'agent') + '&stream=' + encodeURIComponent(sid) + '&limit=200', { cache: 'no-store' });
          if (tr.ok) turns = ((await tr.json()) || {}).turns || [];
        } catch (_) { turns = []; }
        const outcome = (run.reason === 'error' || run.error) ? 'failed' : 'ok';
        foldTurns(ws, turns, outcome, run.error || run.reason);
      }
      refreshRail();
      persist();
    } finally { backfilling = false; }
  }

  // ---- App bridges (fail-soft: the module still forms sessions even if a bridge is missing) -----
  function refreshRail() { try { if (hasApp() && App.refreshRail) App.refreshRail(); } catch (_) {} }
  function persist() { try { if (hasApp() && App.persist) App.persist(); } catch (_) {} }

  // ---- U.bus wiring (read-only) ----------------------------------------------------------------
  function onFire(p) {
    if (!p || !p.runId) return;
    let job = routineFor(p.jobId);
    if (!job && p.jobId) {
      // unknown routine → refresh the catalogue, then (re)seed the session's title once names arrive.
      loadRoutines().then(() => { const j = routineFor(p.jobId); const ws = Workstreams.get && Workstreams.get(streamOf(p.runId)); if (j && ws && (ws.title === 'Routine' || !ws.title)) { ws.title = j.name || 'Routine'; if (ws.agentId === 'agent' && j.agentId) ws.agentId = j.agentId; if (!ws.history.length && j.prompt) ws.history.push({ role: 'user', content: j.prompt }); refreshRail(); persist(); } });
    }
    beginSession(p.runId, job);
  }
  function onResult(p) {
    if (!p || !p.runId) return;
    completeSession(p.runId, p.outcome, p.reason);
  }

  function init() {
    if (!wired && hasU()) {
      wired = true;
      U.bus.on('cron.fire', onFire);
      U.bus.on('cron.result', onResult);
    }
    // backfill after boot; delayed so the save load + rail have settled (mirrors ReturnStore's digest delay).
    setTimeout(() => { backfill(); }, 1400);
  }
  function reset() { routines = null; }   // a fresh Commander re-reads the catalogue; sessions are cleared by Workstreams.reset()

  return { init, reset, _internals: { beginSession, completeSession, foldTurns, backfill, loadRoutines, routineFor, validStream, streamOf } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { AutoSessions };
