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
  async function mount(body) {
    body.innerHTML = '<div class="cfg"><h3>REPORTS / SHARED OPERATIONAL HISTORY</h3><p class="muted">Concise, human-readable outcomes only. Private agent memory, transcripts, and raw runtime payloads stay outside this view.</p><div id="ps-control" class="dim">checking memory boundary…</div><div id="ps-reports"><p class="muted">loading reports…</p></div></div>';
    try {
      const [rr, sr] = await Promise.all([fetch('/api/reports?limit=40', { cache: 'no-store' }), fetch('/api/control/status', { cache: 'no-store' })]);
      const reports = rr.ok ? await rr.json() : { reports: [] }, status = sr.ok ? await sr.json() : null;
      const control = body.querySelector('#ps-control');
      if (control && status) control.textContent = 'PRIVATE MEMORY · ' + String(status.internalMemory || 'unknown').toUpperCase() + '  |  SHARED REPORTS · ' + String(status.sharedReports || 'unknown').toUpperCase() + '  |  EXTERNAL SYNC · OFF';
      const host = body.querySelector('#ps-reports'), rows = Array.isArray(reports.reports) ? reports.reports : [];
      if (host) host.innerHTML = rows.length ? rows.map(reportHtml).join('') : '<p class="muted">No shared reports yet. A morning brief will appear after Night Shift has real activity or exceptions to report.</p>';
    } catch (_) { const host = body.querySelector('#ps-reports'); if (host) host.innerHTML = '<p class="bad">Reports are temporarily unavailable.</p>'; }
  }
  return { mount, reportHtml, dateText };
});
