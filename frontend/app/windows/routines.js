/* STARNET — windows/routines.js : the ROUTINES window (extracted verbatim from stationui.js).
   Loads AFTER stationui.js (see index.html) and registers itself via StationUI.registerWindow;
   the only stationui internals it touches are the enumerated StationUI.h helper surface
   (esc/sfx/notify/fmtRel, mountConsole + its consoleSection store, and the live present/sel views). */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const H = StationUI.h;
  const esc = H.esc, sfx = H.sfx, notify = H.notify, fmtRel = H.fmtRel;
  const mountConsole = H.mountConsole, consoleSection = H.consoleSection;
  let routineAgentId = 'agent'; // selected roster agent for new scheduled routines (window-local state)

  /* ============== ROUTINES — scheduled autonomous runs (server-owned cron) ==============
     A routine wakes on a schedule and runs the agent UNATTENDED. The definitions live SERVER-side
     (schedule + boot-frozen secrets never touch the browser), so this panel is a thin CRUD client over
     /api/cron — render from GET, mutate via POST, re-fetch. Honest by construction: it shows a next-fire /
     last-result only from real server data, and says plainly when the scheduler tick is off. */
  function buildRoutines(body) {
    const roster = H.present.length ? H.present : [{ id: 'agent', name: 'Agent', color: 'var(--ph)' }];
    const hasSelected = roster.some(a => a && a.id === routineAgentId);
    if (!hasSelected) routineAgentId = (H.present[H.sel] && H.present[H.sel].id) || (roster[0] && roster[0].id) || 'agent';
    function agentFor(id) { return roster.find(a => a && a.id === id) || null; }
    function agentLabel(id) {
      const a = agentFor(id);
      if (!a) return id || 'agent';
      const nm = a.name || a.id;
      return nm === a.id ? nm : (nm + ' [' + a.id + ']');
    }
    function agentButton(a) {
      const id = (a && a.id) || 'agent';
      const nm = (a && (a.name || a.id)) || id;
      const active = id === routineAgentId;
      return '<button type="button" class="rt-agent-btn' + (active ? ' active' : '') + '" data-agent="' + esc(id) + '" aria-pressed="' + (active ? 'true' : 'false') + '" style="--rt-agent-color:' + esc((a && a.color) || 'var(--ph)') + '">' +
        '<span class="rt-agent-dot"></span><span class="rt-agent-name">' + esc(nm) + '</span><span class="rt-agent-id">' + esc(id) + '</span></button>';
    }
    // CONSOLE MODE: two sections — ACTIVE ROUTINES (the state you check: gate badge + suggest CTA + list) and
    // CREATE ROUTINE (the whole form + preview + run-output). A third grouping felt forced, so 2 it is. Every id /
    // data-attr / wiring stays; the markup just moved into panes (mountConsole appends its host to `body`, so the
    // body.querySelector wiring below resolves unchanged).
    const secActive =
      '<div id="rt-gate" class="set-about"></div>' +
      // SELF-INITIATION (autonomy Slice 2): let the agent propose standing jobs grounded in what it knows about you.
      '<button class="bb sm" id="rt-propose" style="margin:2px 0 6px">✦ SUGGEST ROUTINES</button>' +
      '<div id="rt-list" class="mc-list"><span class="loading pulse">loading…</span></div>' +
      // P0 #11: a RUN NOW result renders HERE, inline under the row the user clicked — never into the hidden CREATE
      // pane. It lives in the ACTIVE pane (sibling of #rt-list) so a list re-render can't destroy it; positionOut()
      // re-slots it under its row after each refresh.
      '<div id="rt-out" class="msg rt-out" hidden></div>';
    const secCreate =
      '<div class="brief-block"><div class="brief-k">HOW IT WORKS</div>' +
        '<div class="brief-v">A routine wakes on a schedule and runs your agent <b>unattended</b>, using your connected key + model. ' +
        'With no one watching, ungranted file writes are denied silently unless you have pre-approved them. ' +
        // TERMINAL HONESTY (2026-07-25, from a user report): web/files/memory/images/browser all work unattended,
        // but shell.exec + verify.run need the explicit per-routine grant below (the #rt-term checkbox) — the
        // authority gate strips them on every non-interactive surface otherwise, and placing a WORKBENCH on the
        // floor does NOT grant them here. Users were writing "run my tests nightly" routines, getting nothing,
        // and placing a workbench to fix it. Say both halves where the routine is actually written.
        'Web, files, memory, images and the browser all work. The <b>terminal</b> and your <b>connected tools</b> are ' +
        'off unless you grant them below — placing a WORKBENCH on the floor does not grant them to a routine. ' +
        '<span class="dim">(Schedules: "every 30m", "every 1h", "in 2h", "0 9 * * *", or an ISO timestamp like 2026-07-01T09:00.)</span></div></div>' +
      '<div class="mc-form">' +
        '<input id="rt-name" class="key-input" placeholder="name — e.g. Morning AI brief" maxlength="80" autocomplete="off">' +
        '<textarea id="rt-prompt" class="key-input" rows="2" placeholder="what should it do each run? e.g. search for new AI-policy news and summarize the top 3" style="resize:vertical"></textarea>' +
        '<input id="rt-sched" class="key-input" placeholder="schedule — every 30m · 0 9 * * * · in 2h" autocomplete="off">' +
        '<div id="rt-preview" class="dim" style="min-height:1em;font-size:.9em"></div>' +
        '<div class="rt-agent-pick" role="group" aria-label="Routine agent">' + roster.map(agentButton).join('') + '</div>' +
        '<input id="rt-agent" type="hidden" value="' + esc(routineAgentId) + '">' +
        '<details class="brief-block" style="margin:4px 0"><summary>ADVANCED RUNTIME</summary>' +
          '<div class="mc-form" style="margin-top:8px">' +
            '<input id="rt-skills" class="key-input" placeholder="saved skills (comma-separated names)">' +
            '<input id="rt-context" class="key-input" placeholder="upstream routine ids (comma-separated)">' +
            '<input id="rt-workdir" class="key-input" placeholder="approved project folder (optional absolute path)">' +
            '<input id="rt-script" class="key-input" placeholder="pre-check script (relative to workspace/project)">' +
            '<label class="rt-term"><input type="checkbox" id="rt-no-agent"> script only — do not call a model</label>' +
            '<input id="rt-toolsets" class="key-input" placeholder="allowed toolsets (comma-separated; blank = station defaults)">' +
            '<select id="rt-deliver" class="key-input"><option value="local">keep result in StarNet</option><option value="origin">return result to this conversation</option></select>' +
            '<label class="rt-term"><input type="checkbox" id="rt-continue"> keep delivery continuable in its conversation</label>' +
          '</div>' +
        '</details>' +
        // UNATTENDED TERMINAL GRANT — default OFF, and it must stay a deliberate tick: this is the one control
        // that lets a scheduled run execute commands with nobody watching. The label states the risk plainly
        // rather than selling the feature (truthful telemetry applies to consent copy too).
        '<label class="rt-term" for="rt-term" style="display:flex;gap:.5em;align-items:flex-start;cursor:pointer">' +
          '<input type="checkbox" id="rt-term" style="margin-top:.25em">' +
          '<span>Let this routine use the <b>terminal</b> ' +
          '<span class="dim">— runs shell commands and tests unattended, with nobody watching. Only for routines you trust.</span></span>' +
        '</label>' +
        // UNATTENDED CONNECTOR GRANT — separate tick from the terminal: an MCP call reaches an outside service
        // but gets no host-process capability, so the two have genuinely different blast radii and must not be
        // bundled behind one consent. Also default OFF.
        '<label class="rt-term" for="rt-conn" style="display:flex;gap:.5em;align-items:flex-start;cursor:pointer">' +
          '<input type="checkbox" id="rt-conn" style="margin-top:.25em">' +
          '<span>Let this routine use your <b>connected tools</b> ' +
          '<span class="dim">— the MCP connectors you set up in TOOLSETS, called unattended on your behalf. Connectors you switched off stay off.</span></span>' +
        '</label>' +
        '<button class="bb sm" id="rt-add">+ ADD ROUTINE</button>' +
      '</div>' +
      '<div id="rt-msg" class="msg"></div>';
    const frag = h => (el => { el.innerHTML = h; });
    mountConsole(body, 'routines', [
      { id: 'active', label: 'ACTIVE ROUTINES', glyph: '◷', desc: 'Standing jobs that fire on a schedule — their next run, last result, and whether the scheduler is armed.', build: frag(secActive) },
      { id: 'create', label: 'CREATE ROUTINE', glyph: '✦', desc: 'Put your agent to work on a schedule — a morning brief, a nightly summary, a recurring check.', build: frag(secCreate) }
    ], { search: false });

    const listEl = body.querySelector('#rt-list'), gateEl = body.querySelector('#rt-gate');
    const msgEl = body.querySelector('#rt-msg'), outEl = body.querySelector('#rt-out');
    const post = (path, payload) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    // P0 #11 — run-output placement. lastRunId = the routine whose RUN NOW result #rt-out currently shows.
    // schedulerArmed mirrors GET /api/cron `.enabled` (set in refresh) so the create-confirm can tell the honest
    // armed/disarmed story via AutoJobs.armStateLine. #rt-out lives in the ACTIVE pane (sibling of #rt-list); when a
    // run fires we splice it in right AFTER its row, and after every list re-render positionOut() re-slots it there.
    let lastRunId = null, schedulerArmed = false;
    function showRunOut(rowEl, id) {
      lastRunId = id;
      const nmEl = rowEl && rowEl.querySelector('.mc-top b');
      const nm = (nmEl && nmEl.textContent) || 'routine';
      outEl.hidden = false;
      outEl.innerHTML = '<div class="rt-out-h">▶ RAN <b>' + esc(nm) + '</b><button class="rt-out-x bb xs" type="button" title="dismiss">✕</button></div><div class="rt-out-b">running…</div>';
      if (rowEl) rowEl.insertAdjacentElement('afterend', outEl);
    }
    function positionOut() {
      if (outEl.hidden) return;
      let placed = false;
      if (lastRunId) listEl.querySelectorAll('.mc-row').forEach(r => { if (!placed && r.dataset.id === lastRunId) { r.insertAdjacentElement('afterend', outEl); placed = true; } });
      if (!placed) listEl.insertAdjacentElement('afterend', outEl);   // its row is gone (deleted) → park below the list
    }
    outEl.addEventListener('click', ev => { if (ev.target.closest('.rt-out-x')) { outEl.hidden = true; outEl.innerHTML = ''; lastRunId = null; sfx('click'); } });

    function lastResult(j) {
      if (!j.lastRunAt) return '<span class="dim">never run</span>';
      const ok = j.lastStatus === 'ok';
      return '<span class="' + (ok ? 'pos' : '') + '"' + (ok ? '' : ' style="color:var(--bad)"') + '>' + (ok ? '✓ ok' : '✕ ' + esc(j.lastReason || 'error')) + '</span> <span class="dim">' + esc(fmtRel(j.lastRunAt)) + '</span>';
    }
    // TICKER HEALTH (scheduler-audit GA-9): armed alone can't prove ticks are completing. GET /api/cron carries a
    // real observed `health` block; render it beside the armed banner. Only meaningful when armed (a disarmed
    // scheduler is honestly idle — the OFF banner already owns that story), so return '' otherwise.
    function tickHealthLine(cron) {
      const hh = cron && cron.health;
      if (!cron || !cron.enabled || !hh) return '';
      // cronHealth timestamps are epoch-ms NUMBERS (Date.now()), not ISO strings like the per-job fields — normalize
      // to ISO so fmtRel (which Date.parse()es a string) reads them instead of falling through to '—'.
      const relOf = t => fmtRel(typeof t === 'number' ? new Date(t).toISOString() : t);
      if (hh.healthy) {
        const age = hh.lastSuccessAt != null ? relOf(hh.lastSuccessAt) : 'just now';
        return ' <span class="dim">· tick healthy — last success ' + esc(age) + '</span>';
      }
      // Armed but not proven healthy: surface WHY, never a fake-green. A real tick error wins; otherwise we honestly
      // say we're still waiting for the first successful tick (no success timestamp yet).
      if (hh.lastTickError) return ' <span style="color:var(--bad)">· tick error — ' + esc(hh.lastTickError) + '</span>';
      return ' <span class="dim">· waiting for first tick…</span>';
    }
    // Per-job DELIVERY OUTCOME (scheduler-audit): a routine can succeed while its channel notification fails — that
    // failure is durable (cron-store markDelivery) and must be visible, never swallowed. Show ONLY a failure (the
    // error string already carries the channel in [brackets]); a success or a never-delivered job shows nothing
    // (honest no-signal — we never invent a "delivered" state the job never attempted).
    function deliveryLine(j) {
      if (!j.lastDeliveryAt || j.lastDeliveryOk !== false) return '';
      return '<div class="mc-detail" style="color:var(--bad)">✕ delivery failed — ' + esc(j.lastDeliveryError || 'notification could not be sent') +
        ' <span class="dim">' + esc(fmtRel(j.lastDeliveryAt)) + '</span></div>';
    }
    function row(j) {
      const on = j.enabled;
      const stateBadge = on ? '<span style="color:var(--gold)">● scheduled</span>' : '<span class="dim">○ paused</span>';
      const next = on && j.nextRunAt ? esc(fmtRel(j.nextRunAt)) : '—';
      // R3 provenance: a routine minted from a recipe (meta.recipeId) shows "from recipe: <name>". Resolve the live
      // recipe name when we can; fall back to the id (never lies — a deleted recipe still shows its id). Tolerates
      // an absent meta (every pre-R3 job) — no badge then.
      const recipeId = j.meta && j.meta.recipeId;
      let fromRecipe = '';
      if (recipeId) {
        const rec = (typeof Recipes !== 'undefined' && Recipes.get) ? Recipes.get(recipeId) : null;
        fromRecipe = ' <span class="mc-from-recipe" title="scheduled from a recipe">❒ from recipe: ' + esc(rec ? rec.name : recipeId) + '</span>';
      }
      // UNATTENDED TERMINAL GRANT — a standing permission to run commands with nobody watching must be VISIBLE
      // on the row that holds it, not buried in the record. Absent/empty on every ungranted routine -> no badge.
      const grantsOf = Array.isArray(j.unattendedGrants) ? j.unattendedGrants : [];
      const grantBadge = (on2, label, title) => on2
        ? ' <span class="mc-term-grant" title="' + esc(title) + '" style="color:var(--warn,var(--gold))">' + label + '</span>'
        : '';
      const termBadge =
        grantBadge(grantsOf.indexOf('workbench') >= 0, '⌘ terminal', 'this routine may run shell commands unattended') +
        grantBadge(grantsOf.indexOf('connectors') >= 0, '⧉ connected tools', 'this routine may call your MCP connectors unattended');
      const runtimeBadge =
        grantBadge(!!j.noAgent, '⚙ script only', 'this routine completes without calling a model') +
        grantBadge(!!j.script && !j.noAgent, '⚙ pre-check', 'a script decides whether the agent should wake') +
        grantBadge(!!(j.skills && j.skills.length), '✦ ' + j.skills.length + ' skill' + (j.skills.length === 1 ? '' : 's'), 'saved skills preload on every run') +
        grantBadge(!!(j.contextFrom && j.contextFrom.length), '⇢ pipeline', 'uses successful output from upstream routines') +
        grantBadge(j.enabledToolsets != null, '⊣ restricted tools', 'this routine has an explicit per-job toolset intersection') +
        grantBadge(String(j.deliver || 'local') !== 'local', '↗ delivery', 'results are delivered to approved destinations');
      return '<div class="mc-row" data-id="' + esc(j.id) + '" data-on="' + (on ? '1' : '0') + '">' +
        '<div class="mc-top"><b>' + esc(j.name || '(unnamed)') + '</b> <span class="dim">' + esc(j.scheduleDisplay || '') + '</span> ' + stateBadge + termBadge + runtimeBadge + fromRecipe + '</div>' +
        '<div class="mc-url dim">runs as ' + esc(agentLabel(j.agentId || 'agent')) + ' · next ' + next + ' · last ' + lastResult(j) + '</div>' +
        (j.lastError ? '<div class="mc-detail">' + esc(j.lastError) + '</div>' : '') +
        deliveryLine(j) +
        '<div class="mc-acts">' +
          '<button class="bb xs" data-act="run">▶ RUN NOW</button>' +
          '<button class="bb xs" data-act="toggle">' + (on ? '⏸ DISABLE' : '▶ ENABLE') + '</button>' +
          // REVOKE — a standing unattended permission must be withdrawable without deleting the routine.
          // Only rendered when there is something to revoke, so an ordinary routine's action row is unchanged.
          (grantsOf.length ? '<button class="bb xs" data-act="revoke" title="stop this routine using the terminal / your connected tools">⌫ REVOKE ACCESS</button>' : '') +
          '<button class="bb xs danger" data-act="remove">✕ DELETE</button>' +
        '</div></div>';
    }
    async function refresh() {
      try {
        const j = await Harness.api.get('/api/cron');
        const jobs = (j && j.jobs) || [];
        // the live cronArmed — feeds the create-confirm's honest arm-state line. A HALTED scheduler is not armed no
        // matter what the intent flag says, or the create-confirm promises a fire that an E-STOP is holding down.
        schedulerArmed = !!(j && j.enabled && !j.halted);
        // HONEST disabled-state + one-click ENABLE (G4.6): when the scheduler is OFF, say plainly that routines
        // will NOT fire and offer a one-click ENABLE that arms the live timer (no env edit / restart). When ON,
        // show the armed state + a DISABLE control. `enabled` comes straight from GET /api/cron (the live
        // cronArmed), so the badge reflects a runtime arm/disarm immediately.
        // G4.6 — when OFF, this is not a whisper: promote it to a .brief-block banner (same vocabulary the quest
        // APPROVE ask uses) with the ENABLE SCHEDULING action inline, so "saved but won't fire" reads loudly and
        // the fix is one click away. When ON, the calm one-liner + DISABLE control is enough. `#rt-arm`/data-arm
        // stay identical so the arm/disarm wiring below binds unchanged.
        // E-STOP WINS OVER `enabled` (bug-sweep P0). GET /api/cron carries `halted` — the durable stand-down written
        // by the emergency stop. `enabled` still records the user's ARM INTENT while halted, so rendering off
        // `enabled` alone printed "● scheduler armed — routines fire automatically" over a frozen timer. Say the
        // truth loudly and offer the one-click lift (POST /api/cron/arm {enabled:true} clears the halt server-side,
        // which is exactly what the existing #rt-arm data-arm="1" handler already does). Mirrors windows/loops.js.
        gateEl.innerHTML = j && j.halted
          ? '<div class="brief-block" style="border-left-color:var(--bad);margin-bottom:8px">' +
              '<div class="brief-k" style="color:var(--bad)">✕ SCHEDULING IS STOPPED (E-STOP)</div>' +
              '<div class="brief-v">Your routines are saved but <b>will not fire</b> — an emergency stop is engaged and it survives a restart.' +
              '<div style="margin-top:8px"><button class="bb xs" id="rt-arm" data-arm="1">▶ RESUME SCHEDULING</button></div>' +
            '</div></div>'
          : j && j.enabled
          ? '<span style="color:var(--gold)">● scheduler armed</span> <span class="dim">— routines fire automatically.</span>' + tickHealthLine(j) + ' ' +
            '<button class="bb xs" id="rt-arm" data-arm="0">⏸ DISABLE SCHEDULING</button>'
          : '<div class="brief-block" style="border-left-color:var(--bad);margin-bottom:8px">' +
              '<div class="brief-k" style="color:var(--bad)">○ SCHEDULING IS OFF</div>' +
              '<div class="brief-v">Your routines are saved but <b>will not fire</b> — the scheduler is disarmed. ' +
              'Enable scheduling to arm the live timer now (no restart needed).' +
              '<div style="margin-top:8px"><button class="bb xs" id="rt-arm" data-arm="1">▶ ENABLE SCHEDULING</button></div>' +
            '</div></div>';
        const armBtn = gateEl.querySelector('#rt-arm');
        if (armBtn) armBtn.addEventListener('click', async () => {
          const want = armBtn.dataset.arm === '1';
          armBtn.disabled = true; armBtn.textContent = want ? '… enabling' : '… disabling';
          try {
            const r = await (await post('/api/cron/arm', { enabled: want })).json();
            if (r && r.ok) { notify(want ? 'scheduling enabled — routines will now fire' : 'scheduling disabled', want ? 'good' : 'warn'); sfx('click'); }
            else { notify((r && r.error) || 'could not change scheduling', 'warn'); sfx('bad'); }
          } catch (_) { notify('could not reach the sidecar', 'warn'); sfx('bad'); }
          refresh();   // re-render the badge from the authoritative GET /api/cron enabled
        });
        if (jobs.length) { listEl.innerHTML = jobs.map((j, i) => row(j).replace('<div class="mc-row"', '<div class="mc-row" style="--ci:' + i + '"')).join(''); }
        else {
          listEl.innerHTML = '<div class="empty-state"><span class="es-glyph">◷</span>' +
            '<b>NO ROUTINES YET</b><span>Put your agent to work on a schedule — a morning brief, a nightly summary, a recurring check.</span>' +
            '<button class="es-cta" id="rt-empty-cta" type="button">+ ADD A ROUTINE</button></div>';
          const cta = listEl.querySelector('#rt-empty-cta');
          // jump the console to the CREATE section (mirrors buildAgents' CONFIG jump: set the remembered section,
          // then re-activate the console tab) and focus the name field once the pane is visible.
          if (cta) cta.addEventListener('click', () => {
            sfx('click');
            consoleSection['routines'] = 'create';
            const tab = body.querySelector('#con-tab-routines-create');
            if (tab) tab.click();
            const nm = body.querySelector('#rt-name'); if (nm) nm.focus();
          });
        }
        positionOut();   // re-slot a live RUN NOW result under its row after the list re-renders (P0 #11)
      } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to manage routines.</div>'; }
    }

    // SELF-INITIATION: the agent reasons out a few standing-job proposals from the dossier, the Commander approves
    // the ones they want (a Dialogue beat), and each approved one is created via POST /api/cron — then we refresh
    // the list so the new routines appear inline. An explicit ask, always allowed (it's the manual counterpart to
    // the one-time proactive offer). Falls back gracefully if the engine/store isn't present.
    const propBtn = body.querySelector('#rt-propose');
    if (propBtn) propBtn.addEventListener('click', async () => {
      if (typeof AutoJobStore === 'undefined' || !AutoJobStore.propose) { notify('self-initiation is unavailable', 'warn'); return; }
      propBtn.disabled = true; sfx('click');
      try {
        const r = await AutoJobStore.propose();
        if (r && r.scheduled) { notify(r.scheduled + ' routine' + (r.scheduled === 1 ? '' : 's') + ' scheduled', 'good'); refresh(); }
      } catch (_) {} finally { propBtn.disabled = false; }
    });

    // live schedule preview (debounced) — the honest "next fires", straight from the server math.
    let pvTimer = null;
    const schedInp = body.querySelector('#rt-sched'), pvEl = body.querySelector('#rt-preview');
    schedInp.addEventListener('input', () => {
      clearTimeout(pvTimer);
      const v = schedInp.value.trim();
      if (!v) { pvEl.textContent = ''; return; }
      pvTimer = setTimeout(async () => {
        try {
          const r = await (await post('/api/cron/preview', { schedule: v })).json();
          if (r && r.ok) {
            // show the LOCAL wall-clock time the routine fires (with its tz), not just a relative delta, so a
            // cron schedule reads honestly across DST (e.g. "next: 9:00 AM EDT (in 3h)"). Falls back to the
            // relative-only line when the server didn't supply a localNext (interval/once).
            const ln = Array.isArray(r.localNext) ? r.localNext : [];
            const tzNote = (r.kind === 'cron' && r.tz && r.tz !== 'UTC') ? ' <span class="dim">[' + esc(r.tz) + ']</span>' : '';
            const nxt = r.next.slice(0, 3).map((t, i) => {
              const local = ln[i] ? esc(ln[i]) : '';
              return local ? (local + ' <span class="dim">(' + esc(fmtRel(t)) + ')</span>') : esc(fmtRel(t));
            }).join(', ');
            pvEl.innerHTML = '✓ ' + esc(r.display) + tzNote + ' → next: ' + nxt;
          }
          else pvEl.innerHTML = '<span style="color:var(--bad)">' + esc((r && r.error) || 'unrecognized schedule') + '</span>';
        } catch (_) {}
      }, 300);
    });

    body.querySelectorAll('.rt-agent-btn').forEach(btn => btn.addEventListener('click', () => {
      routineAgentId = btn.dataset.agent || 'agent';
      const input = body.querySelector('#rt-agent');
      if (input) input.value = routineAgentId;
      body.querySelectorAll('.rt-agent-btn').forEach(b => {
        const on = b.dataset.agent === routineAgentId;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      sfx('click');
    }));

    // row actions: run-now (stream + show the reply), toggle enable/disable, delete (two-step arm/confirm).
    listEl.addEventListener('click', async ev => {
      const btn = ev.target.closest('button[data-act]'); if (!btn) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      const act = btn.dataset.act;
      if (act === 'remove') {
        if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = '✕ CONFIRM'; sfx('bad'); setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = '✕ DELETE'; } }, 5000); return; }
        // ⛔ FETCH RESOLVES ON 4xx/5xx. `await post(...)` only rejects on a network failure, so the toast used to
        // announce a delete the sidecar had REFUSED — and then refresh() re-drew the still-present row underneath it.
        sfx('bad');
        try { const r = await post('/api/cron/remove', { id }); notify(r.ok ? 'routine deleted' : 'could not delete this routine', r.ok ? 'good' : 'warn'); }
        catch (_) { notify('could not reach the station — the routine was not deleted', 'warn'); }
        refresh(); return;
      }
      if (act === 'revoke') {
        // withdraw every unattended grant. Immediate and unconfirmed BY DESIGN: revoking a permission is the
        // safe direction, so it must never be harder than granting it was (delete keeps its two-step arm).
        sfx('click');
        // A REVOKE CLAIM MUST BE PROVEN, not assumed: a rejected request left the standing unattended grant in
        // force while the station said "access revoked" — the one lie a permission surface can never tell.
        try { const r = await post('/api/cron/update', { id, patch: { unattendedGrants: [] } }); notify(r.ok ? 'access revoked' : 'could NOT revoke access — the routine still has it', r.ok ? 'good' : 'warn'); }
        catch (_) { notify('could not reach the station — access was NOT revoked', 'warn'); }
        refresh(); return;
      }
      if (act === 'toggle') {
        sfx('click'); const on = rowEl.dataset.on === '1';
        try { await post('/api/cron/update', { id, patch: { enabled: !on } }); } catch (_) {} refresh(); return;
      }
      if (act === 'run') {
        sfx('click'); btn.disabled = true; const old = btn.textContent; btn.textContent = '… running';
        showRunOut(rowEl, id);   // P0 #11: the result panel opens inline right under THIS row (visible ACTIVE pane)
        const ob = outEl.querySelector('.rt-out-b');
        try {
          const resp = await post('/api/cron/run', { id });
          if (!resp.ok || !resp.body) { const e = await resp.json().catch(() => ({})); ob.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.error) || ('http ' + resp.status)) + '</span>'; sfx('bad'); }
          else {
            // latch the run's OWN runId from the first run.start and key everything to it (mirrors
            // harness.js chat): a forwarded CHILD run's error/tokens riding the same stream must never
            // hijack this run's reply or fail its verdict.
            const reader = resp.body.getReader(), dec = new TextDecoder(); let sbuf = '', reply = '', err = '', ownRunId = null;
            const mine = (p) => !p || !p.runId || !ownRunId || p.runId === ownRunId;
            for (;;) {
              const r = await reader.read(); if (r.done) break;
              sbuf += dec.decode(r.value, { stream: true });
              let nl; while ((nl = sbuf.indexOf('\n')) >= 0) { const line = sbuf.slice(0, nl); sbuf = sbuf.slice(nl + 1); if (!line.trim()) continue; try { const e = JSON.parse(line); const p = e.payload || {}; if (e.name === 'agent.run.start' && !ownRunId && p.runId) ownRunId = p.runId; else if (e.name === 'agent.token' && mine(p)) reply += (p.delta || ''); else if (e.name === 'agent.run.error' && mine(p)) err = p.message || 'run error'; } catch (_) {} }
            }
            ob.innerHTML = err ? ('<span style="color:var(--bad)">✕ ' + esc(err) + '</span>') : esc(reply || '(no output)');
            notify(err ? 'routine run failed' : 'routine ran', err ? 'warn' : 'good');
          }
        } catch (e) { ob.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.message) || 'run failed') + '</span>'; sfx('bad'); }
        btn.disabled = false; btn.textContent = old; refresh();
      }
    });

    body.querySelector('#rt-add').addEventListener('click', async () => {
      const name = (body.querySelector('#rt-name').value || '').trim();
      const prompt = (body.querySelector('#rt-prompt').value || '').trim();
      const schedule = (body.querySelector('#rt-sched').value || '').trim();
      const agentId = (body.querySelector('#rt-agent').value || '').trim();
      const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : undefined;
      if (!prompt || !schedule) { sfx('bad'); msgEl.textContent = 'a prompt and a schedule are required'; return; }
      msgEl.textContent = 'saving…';
      try {
        // tz honesty (G4.1): send the browser's IANA timezone so a wall-clock schedule ("every morning 9:00")
        // fires in the user's LOCAL time, not the server host's. Backend validates + persists it (invalid tz 400s).
        const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch (_) { return undefined; } })();
        // UNATTENDED TERMINAL GRANT: send it only when ticked, so an untouched form posts exactly the body it
        // always did. The server whitelists the value and the authority re-filters it at the gate.
        const grants = [];
        if ((body.querySelector('#rt-term') || {}).checked) grants.push('workbench');
        if ((body.querySelector('#rt-conn') || {}).checked) grants.push('connectors');
        const split = id => (body.querySelector(id).value || '').split(',').map(x => x.trim()).filter(Boolean);
        const script = (body.querySelector('#rt-script').value || '').trim();
        const toolsetText = (body.querySelector('#rt-toolsets').value || '').trim();
        const workdir = (body.querySelector('#rt-workdir').value || '').trim();
        const deliveryMode = body.querySelector('#rt-deliver').value;
        const activeSession = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
        const r = await (await post('/api/cron', {
          name, prompt, schedule, agentId: agentId || undefined, provider, tz,
          unattendedGrants: grants.length ? grants : undefined,
          skills: split('#rt-skills'), contextFrom: split('#rt-context'),
          workdir: workdir || undefined, script: script || undefined,
          noAgent: !!body.querySelector('#rt-no-agent').checked,
          enabledToolsets: toolsetText ? split('#rt-toolsets') : undefined,
          deliver: deliveryMode,
          origin: deliveryMode === 'origin' && activeSession ? { sessionId: activeSession.id, streamId: activeSession.id, sessionTitle: activeSession.title || '' } : undefined,
          attachToSession: !!body.querySelector('#rt-continue').checked
        })).json();
        if (r && r.error) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc(r.error) + '</span>'; sfx('bad'); }
        else {
          msgEl.textContent = '';
          // HONEST create-confirm: don't claim "scheduled" if the scheduler that fires it is off. armStateLine
          // returns null when armed (→ the normal "scheduled for <agent>" line) and an honest {text} when disarmed
          // ("saved, but the scheduler is off — this won't run until you enable scheduling"). Built for exactly this.
          const arm = (typeof AutoJobs !== 'undefined' && AutoJobs.armStateLine) ? AutoJobs.armStateLine(schedulerArmed) : null;
          if (arm) notify('routine "' + (name || 'unnamed') + '" ' + arm.text, 'warn');
          else notify('routine "' + (name || 'unnamed') + '" scheduled for ' + agentLabel(agentId || 'agent'), 'good');
          sfx('click');
          ['#rt-name', '#rt-prompt', '#rt-sched'].forEach(s => { body.querySelector(s).value = ''; });
          ['#rt-term', '#rt-conn'].forEach(s => { const el = body.querySelector(s); if (el) el.checked = false; });   // a grant is never sticky across creates
          pvEl.textContent = '';
        }
      } catch (e) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.message) || 'failed to reach the sidecar') + '</span>'; sfx('bad'); }
      refresh();
    });

    refresh();
  }

  StationUI.registerWindow('routines', 'ROUTINES', buildRoutines, { console: true });
})();
