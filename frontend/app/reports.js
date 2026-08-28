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
    const r = row || {}, discoveries = Array.isArray(r.discoveries) ? r.discoveries : [];
    const discoveryHtml = discoveries.length ? '<section><h4>DISCOVERIES</h4>' + discoveries.map(x => '<div class="ps-discovery"><strong>' + esc(x.name) + '</strong> · ' + esc(x.recommendation || 'UNKNOWN') + '<div class="dim">' + esc(x.source) + ' · ' + esc(x.license || 'UNKNOWN') + ' · ' + esc(x.cost || 'UNKNOWN') + ' · ' + esc(x.compatibility || 'UNKNOWN') + '</div><p>' + esc(x.purpose || '') + (x.relevance ? ' — ' + esc(x.relevance) : '') + '</p><div class="dim">OWNER · ' + esc(x.recommendedOwnerRoleId || 'operations.coordinator') + ' · RISK · ' + esc(x.risk || 'UNKNOWN') + '</div></div>').join('') + '</section>' : '';
    return '<article class="cfg-card ps-report"><div class="dim">' + esc(String(r.type || 'report').toUpperCase()) + ' · ' + esc(dateText(r.createdAt)) + '</div><h3>' + esc(r.headline || 'Untitled report') + '</h3>' + discoveryHtml + list('COMPLETED', r.completed) + list('EXCEPTIONS', r.exceptions) + list('DECISIONS', r.decisions) + list('NEXT ACTIONS', r.nextActions) + (r.sourceRefs && r.sourceRefs.length ? '<div class="dim">SOURCES · ' + r.sourceRefs.map(esc).join(' · ') + '</div>' : '') + '</article>';
  }
  function objectiveHtml(row) {
    const r = row || {}, capabilities = Array.isArray(r.requiredCapabilities) ? r.requiredCapabilities : [];
    const evidence = Array.isArray(r.completionEvidenceRefs) ? r.completionEvidenceRefs : [];
    const dependencies = Array.isArray(r.dependsOnObjectiveIds) ? r.dependsOnObjectiveIds : [];
    return '<article class="cfg-card ps-objective"><div class="dim">' + esc(String(r.status || 'unknown').toUpperCase()) + ' · ' + esc(dateText(r.updatedAt || r.createdAt)) + '</div><h3>' + esc(r.title || 'Untitled objective') + '</h3>' +
      (r.description ? '<p>' + esc(r.description) + '</p>' : '') +
      '<div class="dim">ROLE · ' + esc(r.assignedRoleId || 'UNASSIGNED') + '  |  TIER · ' + esc(r.assignedModelTier || r.maxModelTier || 'unknown') + '  |  APPROVAL · ' + esc(String(r.approvalState || 'unknown').toUpperCase()) + '</div>' +
      (r.parentObjectiveId ? '<div class="dim">PARENT · ' + esc(r.parentObjectiveId) + '</div>' : '') +
      (r.auditTargetObjectiveId ? '<div class="dim">AUDIT TARGET · ' + esc(r.auditTargetObjectiveId) + '</div>' : '') +
      (r.scoutRequest ? '<div class="dim">SCOUT · ' + esc(r.scoutRequest.id) + ' · LIMIT ' + esc(r.scoutRequest.scope && r.scoutRequest.scope.recommendationLimit) + '</div>' : '') +
      (dependencies.length ? '<div class="dim">DEPENDS ON · ' + dependencies.map(esc).join(' · ') + '</div>' : '') +
      (r.decomposition && Array.isArray(r.decomposition.childIds) ? '<div class="dim">CHILDREN · ' + r.decomposition.childIds.map(esc).join(' · ') + '</div>' : '') +
      (capabilities.length ? '<div class="dim">CAPABILITIES · ' + capabilities.map(esc).join(' · ') + '</div>' : '') +
      (r.routing && r.routing.reason ? '<p class="muted">' + esc(r.routing.reason) + '</p>' : '') +
      (r.settlementReason ? '<p class="muted">RESULT · ' + esc(r.settlementReason) + (r.resultSummary ? ' — ' + esc(r.resultSummary) : '') + '</p>' : '') +
      (evidence.length ? '<div class="dim">EVIDENCE · ' + evidence.map(esc).join(' · ') + '</div>' : '') + '</article>';
  }
  function roleHtml(row) {
    const r = row || {}, capabilities = Array.isArray(r.capabilities) ? r.capabilities : [];
    return '<article class="cfg-card ps-role"><div class="dim">' + esc(String(r.department || 'general').toUpperCase()) + ' · ' + esc(String(r.availability || 'unknown').toUpperCase()) + '</div><h3>' + esc(r.displayName || r.id || 'Unnamed role') + '</h3><div class="dim">' + esc(r.id || '') + '  |  TIER · ' + esc(r.modelTier || 'unknown') + '</div>' + (capabilities.length ? '<p>' + capabilities.map(esc).join(' · ') + '</p>' : '') + '</article>';
  }
  function productProjectHtml(entry) {
    const p = (entry && entry.project) || entry || {}, progress = (entry && entry.progress) || {}, objectives = Array.isArray(progress.objectives) ? progress.objectives : [];
    return '<article class="cfg-card ps-product-project"><div class="dim">' + esc(String(p.status || 'unknown').toUpperCase()) + ' · ' + esc(p.productType || 'digital-product') + ' · ' + esc(dateText(p.updatedAt || p.createdAt)) + '</div><h3>' + esc(p.title || 'Untitled product project') + '</h3>' +
      (p.description ? '<p>' + esc(p.description) + '</p>' : '') + '<div class="dim">OWNER · ' + esc(p.owningRoleId || p.owningDepartment || 'business') + ' | QA · ' + esc(String(p.qaState || 'not_started').toUpperCase()) + ' | PUBLICATION · ' + esc(String(p.publicationState || 'not_published').toUpperCase()) + '</div>' +
      (p.targetCustomer ? '<p class="muted">CUSTOMER · ' + esc(p.targetCustomer) + '</p>' : '') + (objectives.length ? '<div class="dim">OBJECTIVES · ' + objectives.map(x => esc(x.id + ' [' + x.status + ']')).join(' · ') + '</div>' : '') +
      (p.nextAction ? '<p class="muted">NEXT · ' + esc(p.nextAction) + '</p>' : '') + '</article>';
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
    body.innerHTML = '<div class="cfg"><h3>REPORTS / SHARED OPERATIONAL HISTORY</h3><p class="muted">Concise, human-readable outcomes only. Private agent memory, transcripts, and raw runtime payloads stay outside this view.</p><div id="ps-control" class="dim">checking memory boundary…</div><p><button class="bb sm" id="ps-export-json" disabled>EXPORT JSON</button> <button class="bb sm" id="ps-export-md" disabled>EXPORT MARKDOWN</button></p><div id="ps-reports"><p class="muted">loading reports…</p></div><h3>PRODUCT PROJECTS</h3><p class="muted">Business records link to the objectives and reports doing the work. Publication remains approval-protected.</p><div id="ps-product-projects"><p class="muted">loading product projects…</p></div><h3>OBJECTIVES</h3><p class="muted">Durable routing and evidence records. Protected objectives remain stopped for approval; this view cannot approve or execute them.</p><div id="ps-objectives"><p class="muted">loading objectives…</p></div><h3>SYSTEM ROLES</h3><p class="muted">Stable routing roles are separate from visible agent names and roster instances.</p><div id="ps-roles"><p class="muted">loading roles…</p></div></div>';
    try {
      const [rr, sr, pr, or, ro] = await Promise.all([fetch('/api/reports?limit=40', { cache: 'no-store' }), fetch('/api/control/status', { cache: 'no-store' }), fetch('/api/product-projects?limit=100', { cache: 'no-store' }), fetch('/api/objectives?limit=100', { cache: 'no-store' }), fetch('/api/roles', { cache: 'no-store' })]);
      const reports = rr.ok ? await rr.json() : { reports: [] }, status = sr.ok ? await sr.json() : null;
      const productProjects = pr.ok ? await pr.json() : { projects: [] }, objectives = or.ok ? await or.json() : { objectives: [] }, roles = ro.ok ? await ro.json() : { roles: [] };
      const control = body.querySelector('#ps-control');
      if (control && status) control.textContent = 'PRIVATE MEMORY · ' + String(status.internalMemory || 'unknown').toUpperCase() + '  |  SHARED REPORTS · ' + String(status.sharedReports || 'unknown').toUpperCase() + '  |  EXTERNAL SYNC · OFF';
      const host = body.querySelector('#ps-reports'), rows = Array.isArray(reports.reports) ? reports.reports : [];
      if (host) host.innerHTML = rows.length ? rows.map(reportHtml).join('') : '<p class="muted">No shared reports yet. A morning brief will appear after Night Shift has real activity or exceptions to report.</p>';
      const productHost = body.querySelector('#ps-product-projects'), productRows = Array.isArray(productProjects.projects) ? productProjects.projects : [];
      if (productHost) productHost.innerHTML = productRows.length ? productRows.map(productProjectHtml).join('') : '<p class="muted">No digital-product projects have been recorded yet.</p>';
      const objectiveHost = body.querySelector('#ps-objectives'), objectiveRows = Array.isArray(objectives.objectives) ? objectives.objectives : [];
      if (objectiveHost) objectiveHost.innerHTML = objectiveRows.length ? objectiveRows.map(objectiveHtml).join('') : '<p class="muted">No objectives have been recorded yet.</p>';
      const roleHost = body.querySelector('#ps-roles'), roleRows = Array.isArray(roles.roles) ? roles.roles : [];
      if (roleHost) roleHost.innerHTML = roleRows.length ? roleRows.map(roleHtml).join('') : '<p class="muted">Role discovery is temporarily unavailable.</p>';
      const jsonBtn = body.querySelector('#ps-export-json'), mdBtn = body.querySelector('#ps-export-md');
      if (jsonBtn) { jsonBtn.disabled = !rows.length; jsonBtn.onclick = () => download('pine-star-shared-reports.json', 'application/json', JSON.stringify(exportBundle(rows, Date.now()), null, 2)); }
      if (mdBtn) { mdBtn.disabled = !rows.length; mdBtn.onclick = () => download('pine-star-shared-reports.md', 'text/markdown', markdown(rows)); }
    } catch (_) { for (const id of ['#ps-reports', '#ps-product-projects', '#ps-objectives', '#ps-roles']) { const host = body.querySelector(id); if (host) host.innerHTML = '<p class="bad">Operational records are temporarily unavailable.</p>'; } }
  }
  return { mount, reportHtml, productProjectHtml, objectiveHtml, roleHtml, dateText, exportBundle, markdown };
});
