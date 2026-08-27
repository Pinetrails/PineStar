/* Pine Star shared reports — read-only human-facing projection of durable operational history. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Reports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function dateText(ms) { const n = Number(ms); if (!n) return ''; try { return new Date(n).toLocaleString(); } catch (_) { return ''; } }
  function list(label, rows) { const items = (Array.isArray(rows) ? rows : []).filter(Boolean); return items.length ? '<section><h4>' + esc(label) + '</h4><ul>' + items.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></section>' : ''; }
  function reportHtml(row) {
    const r = row || {};
    return '<article class="cfg-card ps-report"><div class="dim">' + esc(String(r.type || 'report').toUpperCase()) + ' · ' + esc(dateText(r.createdAt)) + '</div><h3>' + esc(r.headline || 'Untitled report') + '</h3>' + list('COMPLETED', r.completed) + list('EXCEPTIONS', r.exceptions) + list('DECISIONS', r.decisions) + list('NEXT ACTIONS', r.nextActions) + (r.sourceRefs && r.sourceRefs.length ? '<div class="dim">SOURCES · ' + r.sourceRefs.map(esc).join(' · ') + '</div>' : '') + '</article>';
  }
  function exportBundle(rows, createdAt) {
    return { schema: 'pine-star.shared-report-export.v1', createdAt: Math.max(0, Number(createdAt) || 0), destination: null, externalWritePerformed: false, reports: (Array.isArray(rows) ? rows : []).slice() };
  }
  function markdown(rows) {
    const out = ['# Pine Star shared reports', '', '_Local export only — no external vault was modified._', ''];
    const safe = value => String(value == null ? '' : value).replace(/\r?\n/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const r of (Array.isArray(rows) ? rows : [])) {
      out.push('## ' + safe(r.headline || 'Untitled report'), '', '- Type: `' + safe(r.type || 'report').replace(/`/g, '') + '`', '- Created: `' + String(r.createdAt || 0) + '`');
      for (const [label, key] of [['Completed', 'completed'], ['Exceptions', 'exceptions'], ['Decisions', 'decisions'], ['Next actions', 'nextActions']]) {
        const items = Array.isArray(r[key]) ? r[key] : []; if (!items.length) continue;
        out.push('', '### ' + label, '', ...items.map(x => '- ' + safe(x)));
      }
      out.push('');
    }
    return out.join('\n');
  }
  function download(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  async function mount(body) {
    body.innerHTML = '<div class="cfg"><h3>REPORTS / SHARED OPERATIONAL HISTORY</h3><p class="muted">Concise, human-readable outcomes only. Private agent memory, transcripts, and raw runtime payloads stay outside this view.</p><div id="ps-control" class="dim">checking memory boundary…</div><p><button class="bb sm" id="ps-export-json" disabled>EXPORT JSON</button> <button class="bb sm" id="ps-export-md" disabled>EXPORT MARKDOWN</button></p><div id="ps-reports"><p class="muted">loading reports…</p></div></div>';
    try {
      const [rr, sr] = await Promise.all([fetch('/api/reports?limit=40', { cache: 'no-store' }), fetch('/api/control/status', { cache: 'no-store' })]);
      const reports = rr.ok ? await rr.json() : { reports: [] }, status = sr.ok ? await sr.json() : null;
      const control = body.querySelector('#ps-control');
      if (control && status) control.textContent = 'PRIVATE MEMORY · ' + String(status.internalMemory || 'unknown').toUpperCase() + '  |  SHARED REPORTS · ' + String(status.sharedReports || 'unknown').toUpperCase() + '  |  EXTERNAL SYNC · OFF';
      const host = body.querySelector('#ps-reports'), rows = Array.isArray(reports.reports) ? reports.reports : [];
      if (host) host.innerHTML = rows.length ? rows.map(reportHtml).join('') : '<p class="muted">No shared reports yet. A morning brief will appear after Night Shift has real activity or exceptions to report.</p>';
      const jsonBtn = body.querySelector('#ps-export-json'), mdBtn = body.querySelector('#ps-export-md');
      if (jsonBtn) { jsonBtn.disabled = !rows.length; jsonBtn.onclick = () => download('pine-star-shared-reports.json', 'application/json', JSON.stringify(exportBundle(rows, Date.now()), null, 2)); }
      if (mdBtn) { mdBtn.disabled = !rows.length; mdBtn.onclick = () => download('pine-star-shared-reports.md', 'text/markdown', markdown(rows)); }
    } catch (_) { const host = body.querySelector('#ps-reports'); if (host) host.innerHTML = '<p class="bad">Reports are temporarily unavailable.</p>'; }
  }
  return { mount, reportHtml, dateText, exportBundle, markdown };
});
