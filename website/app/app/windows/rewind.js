/* STARNET — windows/rewind.js : the RESTORE POINTS (REWIND) window (extracted verbatim from stationui.js).
   Loads AFTER stationui.js (see index.html) and registers itself via StationUI.registerWindow;
   the only stationui internals it touches are the enumerated StationUI.h helper surface
   (incl. the shared per-agent roster switcher + the live present/sel views). */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const H = StationUI.h;
  const esc = H.esc, sfx = H.sfx, fmtRel = H.fmtRel, notify = H.notify;
  const rosterSwitchHtml = H.rosterSwitchHtml, wireRosterSwitch = H.wireRosterSwitch;

  /* ============== REWIND — restore points (the execution-spine checkpoint net) ==============
     Every command an agent runs auto-saves a workspace snapshot FIRST; this lists them per agent and
     restores one with a two-step confirm. Server-owned (GET/POST /api/checkpoint); honest — only real
     snapshots show, and it says plainly when there are none yet. */
  function buildRewind(body) {
    const a = H.present[H.sel] || {};   // live core state via the h getters
    const agentId = a.id || 'agent';
    const nm = a.name || agentId;   // display NAME, never the raw id
    body.innerHTML =
      '<h4 class="ms-h">RESTORE POINTS — ' + esc(nm) + '</h4>' +
      rosterSwitchHtml(agentId) +
      '<p class="set-about">A snapshot of <b>' + esc(nm) + '</b>\'s workspace is auto-saved <b>before every command it runs</b> ' +
      '(and before file edits when checkpoints are on). Restoring rolls the workspace back and removes anything ' +
      'created since. <span class="dim">Use it to undo a bad change.</span></p>' +
      '<div class="mc-acts" style="margin:0 0 8px"><button class="bb xs" id="rw-refresh" title="re-read this agent\'s restore points">↻ REFRESH</button></div>' +
      '<div id="rw-list" class="mc-list"><span class="loading pulse">loading…</span></div>' +
      '<div id="rw-msg" class="msg"></div>';
    wireRosterSwitch(body, 'rewind');
    const listEl = body.querySelector('#rw-list'), msgEl = body.querySelector('#rw-msg');
    function row(s) {
      const when = s.ts ? esc(fmtRel(new Date(s.ts).toISOString())) : '';
      return '<div class="mc-row" data-id="' + esc(s.id) + '" data-when="' + when + '">' +
        '<div class="mc-top"><b>' + esc(s.label || 'snapshot') + '</b> <span class="dim">' + when + '</span></div>' +
        '<div class="mc-url dim">' + esc(String(s.id).slice(0, 12)) + ' · turn ' + (s.turn || 0) + (s.files ? (' · ' + s.files + ' file' + (s.files === 1 ? '' : 's')) : '') + '</div>' +
        '<div class="mc-acts"><button class="bb xs danger" data-act="restore">↶ RESTORE</button></div>' +
        '</div>';
    }
    async function refresh() {
      try {
        const j = await Harness.api.get('/api/checkpoint?agent=' + encodeURIComponent(agentId));
        const snaps = ((j && j.snapshots) || []).slice().reverse();   // newest first
        // honest empty-state: file-edit snapshots are opt-in (SKYNET_CHECKPOINTS); shell commands ALWAYS snapshot.
        // Tell the user what actually triggers a restore point under their current config, not an aspirational promise.
        const empty = (j && j.enabled)
          ? 'NO RESTORE POINTS YET.<br><span>They appear once this agent runs a command or edits a file at a WORKBENCH.</span>'
          : 'NO RESTORE POINTS YET.<br><span>They appear once this agent runs a <b>shell command</b>. File-edit snapshots aren\'t enabled on this station.</span>';
        listEl.innerHTML = snaps.length ? snaps.map(row).join('') : '<div class="fb-empty">' + empty + '</div>';
      } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to manage restore points.</div>'; }
    }
    let armTimer = 0;
    listEl.addEventListener('click', async ev => {
      const btn = ev.target.closest('button[data-act="restore"]'); if (!btn) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      if (!btn.dataset.armed) {
        // arm + STATE THE STAKES: name what a restore removes (everything created since this point's time).
        btn.dataset.armed = '1'; btn.textContent = '↶ CONFIRM'; sfx('bad');
        const when = rowEl.dataset.when || 'this point';
        msgEl.className = 'msg'; msgEl.innerHTML = '<span class="dim">removes anything <b>' + esc(nm) + '</b> created since <b>' + esc(when) + '</b> — CONFIRM to roll back</span>';
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { if (btn.isConnected && btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = '↶ RESTORE'; msgEl.innerHTML = ''; } }, 5000);
        return;
      }
      clearTimeout(armTimer); delete btn.dataset.armed;
      sfx('bad'); btn.disabled = true; msgEl.className = 'msg'; msgEl.textContent = 'restoring…';
      try {
        const r = (await Harness.api.post('/api/checkpoint/restore', { agentId: agentId, snapshotId: id })).j;
        if (r && r.ok) { notify('rewound ' + nm + ' to an earlier restore point', 'warn'); msgEl.className = 'msg ok'; msgEl.textContent = '✓ restored.'; }
        else { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((r && r.error) || 'restore failed') + '</span>'; sfx('bad'); }
      } catch (e) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.message) || 'restore failed') + '</span>'; sfx('bad'); }
      btn.disabled = false; refresh();
    });
    const refreshBtn = body.querySelector('#rw-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => { sfx('click'); listEl.innerHTML = '<span class="loading pulse">loading…</span>'; refresh(); });
    refresh();
  }

  StationUI.registerWindow('rewind', 'RESTORE POINTS', buildRewind, { w: '520px' });
})();
