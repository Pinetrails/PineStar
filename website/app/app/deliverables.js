/* STARNET deliverable library: safe preview helpers + backend-backed Workshop/artifact browser. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Deliverables = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function safeMarkdown(raw) {
    return String(raw || '').slice(0, 512 * 1024).split(/\r?\n/).map(line => {
      let s = esc(line).replace(/\*\*([^*]{1,500})\*\*/g, '<strong>$1</strong>').replace(/`([^`]{1,500})`/g, '<code>$1</code>');
      const h = s.match(/^(#{1,3})\s+(.+)$/); if (h) return '<h' + h[1].length + '>' + h[2] + '</h' + h[1].length + '>';
      return s ? '<p>' + s + '</p>' : '';
    }).join('');
  }
  function csvRows(raw, maxRows, maxCols) {
    const rows = []; let row = [], cell = '', quoted = false;
    raw = String(raw || '').slice(0, 512 * 1024); maxRows = Math.max(1, maxRows || 50); maxCols = Math.max(1, maxCols || 20);
    for (let i = 0; i <= raw.length && rows.length < maxRows; i++) {
      const c = i < raw.length ? raw[i] : '\n';
      if (quoted && c === '"' && raw[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = !quoted;
      else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
        if (row.length < maxCols) row.push(cell); cell = '';
        if (c === '\r' && raw[i + 1] === '\n') i++;
        if (c !== ',') { rows.push(row); row = []; }
      } else cell += c;
    }
    return rows;
  }
  function safeCsv(raw, maxRows, maxCols) {
    const rows = csvRows(raw, maxRows, maxCols);
    return '<table class="deliverable-csv"><tbody>' + rows.map((r, ri) => '<tr>' + r.map(c => '<' + (ri ? 'td' : 'th') + '>' + esc(c) + '</' + (ri ? 'td' : 'th') + '>').join('') + '</tr>').join('') + '</tbody></table>';
  }
  function openUrl(url, token) { return String(url || '') + (String(url || '').indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(String(token || '')); }
  const fmtSize = n => n == null ? 'size unknown' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const token = () => typeof window !== 'undefined' ? String(window.__STARNET_API_TOKEN__ || '') : '';
  const apiBase = () => typeof window !== 'undefined' ? String(window.__STARNET_API__ || '') : '';
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });

  function fileHref(f) {
    const href = openUrl(f && f.openUrl, token());
    const base = apiBase();
    return base && href.charAt(0) === '/' ? base + href : href;
  }
  // The backend's openUrl already carries the exact jailed path it proved. Read that value instead of
  // rebuilding Workshop paths from display fields (a kept/pending row may have a different lifecycle shape).
  function artifactPath(f) {
    const match = String((f && f.openUrl) || '').match(/[?&]path=([^&#]*)/);
    if (match) { try { return decodeURIComponent(match[1]); } catch (_) {} }
    return String((f && f.path) || '');
  }
  function tauriCore() {
    return (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  }
  function revokePreview(state) {
    if (!state || !state.blobUrl) return;
    try { URL.revokeObjectURL(state.blobUrl); } catch (_) {}
    state.blobUrl = '';
  }
  async function openDesktop(r, f, href, say) {
    const core = tauriCore();
    if (!core || !core.invoke) return false;
    if (f.sandboxed) {
      try { await core.invoke('open_external_url', { url: href }); }
      catch (_) { if (say) say('Could not open that safe preview in your browser.', true); }
      return true;
    }
    try {
      await core.invoke('starnet_open_artifact', { path: artifactPath(f), agentId: r.agentId || 'agent' });
    } catch (err) {
      // Cancel at the host confirmation is an answer. Falling through would bypass the user's refusal.
      if (/declined at the host/i.test(String(err || ''))) return true;
      try { await core.invoke('open_external_url', { url: href }); }
      catch (_) { if (say) say('Could not open that file — use its session or workspace folder to find it on disk.', true); }
    }
    return true;
  }
  async function previewInCard(f, host, state, say) {
    if (!host) return false;
    revokePreview(state);
    if (state && state.previewHost && state.previewHost !== host) state.previewHost.innerHTML = '';
    if (state) state.previewHost = host;
    host.innerHTML = '<p class="muted">Loading safe preview…</p>';
    try {
      const response = await fetch(fileHref(f), { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (f.preview === 'image') {
        const blobUrl = URL.createObjectURL(await response.blob());
        if (state) state.blobUrl = blobUrl;
        host.innerHTML = '<img class="deliverable-image" alt="Preview of ' + esc(f.path) + '">';
        const img = host.querySelector('img');
        const expiry = setTimeout(() => revokePreview(state), 30000);
        img.onload = img.onerror = () => { clearTimeout(expiry); revokePreview(state); };
        img.src = blobUrl;
      } else {
        const text = await response.text();
        host.innerHTML = '<div class="cfg-block"><b>SAFE PREVIEW · ' + esc(f.path) + '</b>' + (f.preview === 'markdown' ? safeMarkdown(text) : safeCsv(text, 50, 20)) + '</div>';
      }
    } catch (e) {
      host.innerHTML = '';
      if (say) say('Could not preview that file: ' + e.message, true);
    }
    return true;
  }
  async function handleOpenClick(ev, rows, state, say) {
    const link = ev && ev.target && ev.target.closest ? ev.target.closest('a[data-file]') : null;
    if (!link) return false;
    const card = link.closest('[data-i]');
    const r = card && rows && rows[Number(card.dataset.i)];
    const f = r && r.files && r.files[Number(link.dataset.file) || 0];
    if (!r || !f || !f.openUrl) return false;

    const core = tauriCore();
    // A browser-only non-preview is already a real href; let the anchor perform its native navigation.
    if ((!core || !core.invoke) && (!f.preview || f.sandboxed)) return false;
    ev.preventDefault();
    ev.stopPropagation();
    if (core && core.invoke) return openDesktop(r, f, fileHref(f), say);
    return previewInCard(f, card.querySelector('[data-preview]'), state || {}, say);
  }

  function mount(body) {
    let rows = [], loadSeq = 0;
    const openState = { blobUrl: '', previewHost: null };
    const revoke = () => revokePreview(openState);
    body.innerHTML = '<div class="cfg"><h3>DELIVERABLES / WORKSHOP LIBRARY</h3><p class="muted">Real run outputs and Workshop builds. Previews open safely inside StarNet in a browser; desktop OPEN uses your file app. Original files remain unchanged until you choose an action.</p>' +
      '<div class="deliverables-toolbar"><input id="dl-query" aria-label="Search deliverables" placeholder="search title, run, source"><select id="dl-status" aria-label="Filter deliverables"><option value="">ALL STATUS</option><option>pending</option><option>kept</option><option>discarded</option><option>produced</option><option>failed</option></select><button class="bb sm" id="dl-refresh">REFRESH</button><button class="bb sm" id="dl-clean">CLEAN OLD RECORDS</button></div>' +
      '<div id="dl-msg" class="msg" aria-live="polite"></div><div id="dl-cleanup"></div><div id="dl-list"></div></div>';
    const q = body.querySelector('#dl-query'), status = body.querySelector('#dl-status'), list = body.querySelector('#dl-list'), msg = body.querySelector('#dl-msg'), cleanup = body.querySelector('#dl-cleanup');
    const say = (s, bad) => { msg.textContent = s || ''; msg.className = 'msg ' + (bad ? 'bad' : 'ok'); };
    function render() {
      list.innerHTML = rows.length ? rows.map((r, i) => '<article class="cfg-block deliverable-row" data-i="' + i + '"><div><b>' + esc(r.title || 'Untitled output') + '</b> <span class="tag">' + esc(r.status) + '</span></div><small>' + esc(r.source) + ' · ' + esc(r.agentId || 'station') + ' · ' + fmtSize(r.size) + ' · ' + esc(r.createdAt ? new Date(r.createdAt).toLocaleString() : 'time unknown') + '</small><p>' + esc(r.summary || '') + '</p><div class="row">' +
        ((r.actions && r.actions.open) ? (r.files || []).map((f, fi) => f.openUrl ? '<a class="bb sm" data-file="' + fi + '" href="' + esc(fileHref(f)) + '" target="_blank" rel="noopener">OPEN ' + esc(f.path) + '</a>' : '').join('') : '') + ((r.actions && r.actions.keep) ? '<button class="bb sm" data-act="keep">KEEP</button>' : '') + ((r.actions && r.actions.discard) ? '<button class="bb sm danger" data-act="discard">DISCARD</button>' : '') + '</div><div class="deliverable-preview" data-preview aria-live="polite"></div></article>').join('') : '<p class="muted">No deliverables match this view.</p>';
      wireDiscards();
    }
    // Re-wired after every render: innerHTML replaces the buttons, so the previous listeners die with the
    // old nodes and there is nothing to dispose. If armconfirm.js somehow did not load, the buttons stay
    // unwired and the delegated handler discards on a single click — we do NOT fork a fourth hand-rolled
    // copy of the arm/confirm idiom here, which is the thing that helper was extracted to prevent.
    function wireDiscards() {
      if (typeof ArmConfirm === 'undefined' || !ArmConfirm.wire) return;
      list.querySelectorAll('button[data-act="discard"]').forEach(b => {
        const r = rows[Number(b.closest('[data-i]').dataset.i)];
        if (!r) return;
        b.dataset.wired = '1';
        ArmConfirm.wire(b, {
          armedLabel: 'DISCARD — SURE?',
          onArm: () => say('Discarding “' + (r.title || 'this output') + '” also removes its Workshop files permanently. Click again to confirm.', true),
          onDisarm: () => say(rows.length + ' real record' + (rows.length === 1 ? '' : 's')),
          onConfirm: () => decide(r, 'discard', b)
        });
      });
    }
    async function load() {
      const seq = ++loadSeq; say('Loading…');
      const url = '/api/deliverables?query=' + encodeURIComponent(q.value) + '&status=' + encodeURIComponent(status.value);
      try { const j = await fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); if (seq !== loadSeq) return; rows = j.items || []; render(); say(rows.length + ' real record' + (rows.length === 1 ? '' : 's')); }
      catch (e) { say('Could not load the library: ' + e.message, true); }
    }
    // DISCARD is irreversible (it deletes the Workshop files), so it asks — but with the station's own
    // 2-step arm/confirm, never `window.confirm`. A native dialog is OS chrome painted over the phosphor
    // terminal, which is exactly what armconfirm.js exists to stop ("no native dialogs inside the phosphor
    // terminal"). The permanence sentence the dialog used to carry moves into the live message line on arm,
    // so nothing is claimed less loudly than before — it is just said in the station's voice.
    async function decide(r, act, b) {
      b.disabled = true;
      try { const j = await post('/api/workshop/decide', { agentId: r.agentId, runId: r.runId, decision: act }); say(j.decision === 'keep' ? ('Kept ' + r.title + (j.destPath ? ' in ' + j.destPath : '')) : ('Discarded ' + r.title)); await load(); }
      catch (e) { b.disabled = false; say(e.message, true); }
    }
    list.addEventListener('click', async ev => {
      const fileLink = ev.target.closest('a[data-file]');
      if (fileLink) return handleOpenClick(ev, rows, openState, say);
      const b = ev.target.closest('button[data-act]'); if (!b) return; const card = b.closest('[data-i]'), r = rows[Number(card.dataset.i)]; if (!r) return;
      if (b.dataset.act === 'discard' && b.dataset.wired === '1') return;   // its own ArmConfirm listener owns it
      decide(r, b.dataset.act, b);
    });
    let debounce = 0; q.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 180); }); status.addEventListener('change', load); body.querySelector('#dl-refresh').addEventListener('click', load);
    body.querySelector('#dl-clean').addEventListener('click', async () => {
      try { const p = await post('/api/deliverables/cleanup-preview', { statuses: ['discarded', 'failed'] }); cleanup.innerHTML = '<div class="cfg-block"><b>CLEANUP PREVIEW</b><p>' + p.targets.length + ' discarded/failed lifecycle record(s) will be removed. ' + p.protected.length + ' pending, kept, or produced record(s) are protected. Files are not deleted.</p><ul>' + p.targets.map(r => '<li>' + esc(r.title) + ' · ' + esc(r.status) + ' · ' + esc(r.runId || r.id) + '</li>').join('') + '</ul><button class="bb sm danger" id="dl-clean-apply" ' + (p.targets.length ? '' : 'disabled') + '>REMOVE EXACTLY THESE ' + p.targets.length + ' RECORDS</button></div>'; const apply = cleanup.querySelector('#dl-clean-apply'); if (apply) apply.addEventListener('click', async () => { try { const c = await post('/api/deliverables/cleanup', { statuses: p.statuses, fingerprint: p.fingerprint }); cleanup.innerHTML = '<div class="msg ok">Removed ' + c.removed + ' record(s). <button class="bb sm" id="dl-undo">UNDO</button></div>'; cleanup.querySelector('#dl-undo').addEventListener('click', async () => { const u = await post('/api/deliverables/cleanup-undo', { undoToken: c.undoToken }); say('Restored ' + u.restored + ' record(s).'); cleanup.innerHTML = ''; await load(); }); await load(); } catch (e) { say(e.message, true); } }); }
      catch (e) { say('Could not preview cleanup: ' + e.message, true); }
    });
    body._deliverablesCleanup = revoke;
    load();
  }
  return { esc, safeMarkdown, safeCsv, openUrl, fileHref, artifactPath, handleOpenClick, mount };
});
