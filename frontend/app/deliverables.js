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
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });

  function mount(body) {
    let rows = [], blobUrl = '', loadSeq = 0;
    const revoke = () => { if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (_) {} blobUrl = ''; } };
    body.innerHTML = '<div class="cfg"><h3>DELIVERABLES / WORKSHOP LIBRARY</h3><p class="muted">Real run artifacts and Workshop builds. HTML opens in an opaque-origin sandbox; Markdown and CSV previews are escaped and bounded.</p>' +
      '<div class="row"><input id="dl-query" aria-label="Search deliverables" placeholder="search title, run, source"><select id="dl-status" aria-label="Filter deliverables"><option value="">ALL STATUS</option><option>pending</option><option>kept</option><option>discarded</option><option>produced</option><option>failed</option></select><button id="dl-refresh">REFRESH</button><button id="dl-clean">CLEAN OLD RECORDS</button></div>' +
      '<div id="dl-msg" class="msg" aria-live="polite"></div><div id="dl-cleanup"></div><div id="dl-list"></div><div id="dl-preview" aria-live="polite"></div></div>';
    const q = body.querySelector('#dl-query'), status = body.querySelector('#dl-status'), list = body.querySelector('#dl-list'), preview = body.querySelector('#dl-preview'), msg = body.querySelector('#dl-msg'), cleanup = body.querySelector('#dl-cleanup');
    const say = (s, bad) => { msg.textContent = s || ''; msg.className = 'msg ' + (bad ? 'bad' : 'ok'); };
    function render() {
      list.innerHTML = rows.length ? rows.map((r, i) => '<article class="cfg-block deliverable-row" data-i="' + i + '"><div><b>' + esc(r.title || 'Untitled output') + '</b> <span class="tag">' + esc(r.status) + '</span></div><small>' + esc(r.source) + ' · ' + esc(r.agentId || 'station') + ' · ' + fmtSize(r.size) + ' · ' + esc(r.createdAt ? new Date(r.createdAt).toLocaleString() : 'time unknown') + '</small><p>' + esc(r.summary || '') + '</p><div class="row">' +
        ((r.actions && r.actions.open) ? (r.files || []).filter(f => f.openUrl).map((f, fi) => '<button data-file="' + fi + '">OPEN ' + esc(f.path) + '</button>').join('') : '') + ((r.actions && r.actions.keep) ? '<button data-act="keep">KEEP</button>' : '') + ((r.actions && r.actions.discard) ? '<button data-act="discard">DISCARD</button>' : '') + '</div></article>').join('') : '<p class="muted">No deliverables match this view.</p>';
    }
    async function load() {
      const seq = ++loadSeq; say('Loading…');
      const url = '/api/deliverables?query=' + encodeURIComponent(q.value) + '&status=' + encodeURIComponent(status.value);
      try { const j = await fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); if (seq !== loadSeq) return; rows = j.items || []; render(); say(rows.length + ' real record' + (rows.length === 1 ? '' : 's')); }
      catch (e) { say('Could not load the library: ' + e.message, true); }
    }
    async function openRow(r, fileIndex) {
      revoke(); const f = r.files && r.files[Number(fileIndex) || 0]; if (!f || !f.openUrl) return say('That file is no longer available.', true);
      if (!f.preview || f.sandboxed) { window.open(openUrl(f.openUrl, token()), '_blank', 'noopener'); return; }
      preview.innerHTML = '<p class="muted">Loading safe preview…</p>';
      try {
        const response = await fetch(openUrl(f.openUrl, token()), { cache: 'no-store' }); if (!response.ok) throw new Error('HTTP ' + response.status);
        if (f.preview === 'image') {
          blobUrl = URL.createObjectURL(await response.blob()); preview.innerHTML = '<img class="deliverable-image" alt="Preview of ' + esc(f.path) + '">';
          const img = preview.querySelector('img'); const expiry = setTimeout(revoke, 30000); img.onload = img.onerror = () => { clearTimeout(expiry); revoke(); }; img.src = blobUrl;
        } else { const text = await response.text(); preview.innerHTML = '<div class="cfg-block"><b>SAFE PREVIEW · ' + esc(f.path) + '</b>' + (f.preview === 'markdown' ? safeMarkdown(text) : safeCsv(text, 50, 20)) + '</div>'; }
      } catch (e) { preview.innerHTML = ''; say('Could not preview that file: ' + e.message, true); }
    }
    list.addEventListener('click', async ev => {
      const b = ev.target.closest('button[data-act],button[data-file]'); if (!b) return; const card = b.closest('[data-i]'), r = rows[Number(card.dataset.i)]; if (!r) return;
      if (b.hasAttribute('data-file')) return openRow(r, b.dataset.file);
      if (b.dataset.act === 'discard' && !window.confirm('Discard “' + r.title + '” and permanently remove its Workshop files?')) return;
      b.disabled = true;
      try { const j = await post('/api/workshop/decide', { agentId: r.agentId, runId: r.runId, decision: b.dataset.act }); say(j.decision === 'keep' ? ('Kept ' + r.title + (j.destPath ? ' in ' + j.destPath : '')) : ('Discarded ' + r.title)); await load(); }
      catch (e) { b.disabled = false; say(e.message, true); }
    });
    let debounce = 0; q.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 180); }); status.addEventListener('change', load); body.querySelector('#dl-refresh').addEventListener('click', load);
    body.querySelector('#dl-clean').addEventListener('click', async () => {
      try { const p = await post('/api/deliverables/cleanup-preview', { statuses: ['discarded', 'failed'] }); cleanup.innerHTML = '<div class="cfg-block"><b>CLEANUP PREVIEW</b><p>' + p.targets.length + ' discarded/failed lifecycle record(s) will be removed. ' + p.protected.length + ' pending, kept, or produced record(s) are protected. Files are not deleted.</p><ul>' + p.targets.map(r => '<li>' + esc(r.title) + ' · ' + esc(r.status) + ' · ' + esc(r.runId || r.id) + '</li>').join('') + '</ul><button id="dl-clean-apply" ' + (p.targets.length ? '' : 'disabled') + '>REMOVE EXACTLY THESE ' + p.targets.length + ' RECORDS</button></div>'; const apply = cleanup.querySelector('#dl-clean-apply'); if (apply) apply.addEventListener('click', async () => { try { const c = await post('/api/deliverables/cleanup', { statuses: p.statuses, fingerprint: p.fingerprint }); cleanup.innerHTML = '<div class="msg ok">Removed ' + c.removed + ' record(s). <button id="dl-undo">UNDO</button></div>'; cleanup.querySelector('#dl-undo').addEventListener('click', async () => { const u = await post('/api/deliverables/cleanup-undo', { undoToken: c.undoToken }); say('Restored ' + u.restored + ' record(s).'); cleanup.innerHTML = ''; await load(); }); await load(); } catch (e) { say(e.message, true); } }); }
      catch (e) { say('Could not preview cleanup: ' + e.message, true); }
    });
    body._deliverablesCleanup = revoke;
    load();
  }
  return { esc, safeMarkdown, safeCsv, openUrl, mount };
});
