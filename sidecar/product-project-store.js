'use strict';
const { makeDurableJsonStore } = require('./durable-store.js');
const CAP = 500;
const STATUSES = ['idea', 'research', 'planned', 'production', 'qa', 'listing_ready', 'approval_required', 'published', 'archived'];
const NEXT = { idea: ['research', 'planned', 'archived'], research: ['planned', 'archived'], planned: ['production', 'archived'], production: ['qa', 'archived'], qa: ['production', 'listing_ready', 'archived'], listing_ready: ['qa', 'approval_required', 'archived'], approval_required: ['listing_ready', 'published', 'archived'], published: ['archived'], archived: [] };
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function strings(v, cap, n) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, n)).filter(Boolean))].slice(0, cap); }
function money(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 10000) / 10000 : null; }
function slug(v) { return text(v, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); }
function listingDraft(v) { if (!v || typeof v !== 'object') return null; const title = text(v.title, 200), description = text(v.description, 2000); if (!title || !description) return null; return { title, description, tags: strings(v.tags, 13, 80), seoKeywords: strings(v.seoKeywords, 20, 100), targetMarketplaces: strings(v.targetMarketplaces, 8, 100) }; }
function makeProductProjectStore(deps) {
  deps = deps || {}; const now = typeof deps.now === 'function' ? deps.now : Date.now, newId = typeof deps.newId === 'function' ? deps.newId : () => { throw new Error('product project store requires newId'); };
  const objectiveExists = typeof deps.objectiveExists === 'function' ? deps.objectiveExists : () => false;
  const reportExists = typeof deps.reportExists === 'function' ? deps.reportExists : () => false;
  const durable = deps.durable || makeDurableJsonStore({ fs: deps.fs, path: deps.path, writeDurable: deps.writeDurable,
    fileFor: () => deps.path.join(deps.workspaces, 'pine-star.product-projects.json'), onRecover: deps.onRecover, onCorrupt: deps.onCorrupt });
  function build(input) {
    const row = input && typeof input === 'object' ? input : {}, title = text(row.title || row.name, 200), stamp = Math.max(0, Number(now()) || 0);
    if (!title) throw new Error('product project requires a title');
    const id = slug(row.projectId) || ('product-project:' + text(newId(), 100));
    const status = STATUSES.includes(row.status) ? row.status : 'idea';
    if (status === 'published') throw new Error('publication requires protected approval');
    return { schema: 'pine-star.product-project.v1', id, title, description: text(row.description, 2000), productType: text(row.productType || row.category, 100) || 'digital-product',
      status, owningDepartment: text(row.owningDepartment, 80) || 'business', owningRoleId: text(row.owningRoleId, 100) || null,
      targetMarketplaces: strings(row.targetMarketplaces, 8, 100), targetCustomer: text(row.targetCustomer || row.useCase, 500), assetRequirements: strings(row.assetRequirements, 20, 240), deliverables: strings(row.deliverables, 20, 240),
      linkedObjectiveIds: [], linkedReportIds: [], evidenceRefs: strings(row.evidenceRefs, 24, 300), blockers: strings(row.blockers, 12, 240),
      qaState: ['not_started', 'in_progress', 'passed', 'failed'].includes(row.qaState) ? row.qaState : 'not_started', listingState: 'not_started', publicationState: status === 'approval_required' ? 'approval_required' : 'not_published',
      estimatedCostUsd: money(row.estimatedCostUsd), actualCostUsd: money(row.actualCostUsd), revenueUsd: money(row.revenueUsd), spendingAuthorityUsd: 0,
      listingDraft: listingDraft(row.listingDraft), notes: text(row.notes, 1200), nextAction: text(row.nextAction, 300), createdAt: stamp, updatedAt: stamp, revision: 1 };
  }
  function list(limit, status) { const rows = durable.get('station'), cap = Math.max(1, Math.min(250, Number(limit) || 50)); return (Array.isArray(rows) ? rows : []).filter(x => x && (!status || x.status === status)).slice(-cap).reverse(); }
  function get(id) { const rows = durable.get('station'); return (Array.isArray(rows) ? rows : []).find(x => x && x.id === String(id || '')) || null; }
  async function create(input) {
    const candidate = build(input); let result;
    await durable.update('station', stored => { const rows = Array.isArray(stored) ? stored.slice() : [], existing = rows.find(x => x && x.id === candidate.id);
      if (existing) { if (existing.title === candidate.title && existing.productType === candidate.productType) { result = { project: existing, idempotent: true }; return undefined; } throw new Error('projectId already belongs to another product project'); }
      if (rows.length >= CAP) throw new Error('product project capacity exceeded'); rows.push(candidate); result = { project: candidate, idempotent: false }; return rows; }); return result;
  }
  async function update(id, patch, options) {
    let updated = null; const p = patch && typeof patch === 'object' ? patch : {};
    await durable.update('station', stored => { const rows = Array.isArray(stored) ? stored.slice() : [], i = rows.findIndex(x => x && x.id === String(id || '')); if (i < 0) throw new Error('product project not found');
      const cur = rows[i]; if (p.revision != null && Number(p.revision) !== cur.revision) throw new Error('product project revision conflict');
      const nextStatus = p.status == null ? cur.status : text(p.status, 40); if (!STATUSES.includes(nextStatus)) throw new Error('invalid product project status');
      if (nextStatus !== cur.status && !NEXT[cur.status].includes(nextStatus)) throw new Error('invalid product project status transition');
      if (nextStatus === 'listing_ready' && (p.qaState || cur.qaState) !== 'passed') throw new Error('listing readiness requires passed QA');
      if (nextStatus === 'approval_required' && nextStatus !== cur.status && !(options && options.publicationApprovalRequested === true)) throw new Error('approval request requires protected workflow');
      if (cur.status === 'approval_required' && nextStatus === 'listing_ready' && !(options && options.publicationApprovalWithdrawn === true)) throw new Error('approval withdrawal requires protected workflow');
      if (cur.status === 'approval_required' && nextStatus === 'archived') throw new Error('pending publication approval must be withdrawn before archival');
      if (nextStatus === 'published' && !(options && options.publicationApproved === true)) throw new Error('publication requires protected approval');
      const stamp = Math.max(Number(cur.updatedAt) || 0, Number(now()) || 0), qa = ['not_started', 'in_progress', 'passed', 'failed'].includes(p.qaState) ? p.qaState : cur.qaState;
      updated = Object.assign({}, cur, { title: p.title == null ? cur.title : text(p.title, 200) || cur.title, description: p.description == null ? cur.description : text(p.description, 2000), status: nextStatus,
        owningDepartment: p.owningDepartment == null ? cur.owningDepartment : text(p.owningDepartment, 80), owningRoleId: p.owningRoleId == null ? cur.owningRoleId : text(p.owningRoleId, 100) || null,
        targetMarketplaces: p.targetMarketplaces == null ? cur.targetMarketplaces : strings(p.targetMarketplaces, 8, 100), targetCustomer: p.targetCustomer == null ? cur.targetCustomer : text(p.targetCustomer, 500),
        assetRequirements: p.assetRequirements == null ? cur.assetRequirements : strings(p.assetRequirements, 20, 240), deliverables: p.deliverables == null ? cur.deliverables : strings(p.deliverables, 20, 240), evidenceRefs: p.evidenceRefs == null ? cur.evidenceRefs : strings(p.evidenceRefs, 24, 300), blockers: p.blockers == null ? cur.blockers : strings(p.blockers, 12, 240),
        qaState: qa, listingState: nextStatus === 'listing_ready' || nextStatus === 'approval_required' || nextStatus === 'published' ? 'ready' : cur.listingState,
        publicationState: nextStatus === 'published' ? 'published' : (nextStatus === 'approval_required' ? 'approval_required' : (options && options.publicationApprovalWithdrawn === true ? 'not_published' : cur.publicationState)),
        estimatedCostUsd: p.estimatedCostUsd === undefined ? cur.estimatedCostUsd : money(p.estimatedCostUsd), actualCostUsd: p.actualCostUsd === undefined ? cur.actualCostUsd : money(p.actualCostUsd), revenueUsd: p.revenueUsd === undefined ? cur.revenueUsd : money(p.revenueUsd),
        listingDraft: p.listingDraft === undefined ? cur.listingDraft : listingDraft(p.listingDraft), notes: p.notes == null ? cur.notes : text(p.notes, 1200), nextAction: p.nextAction == null ? cur.nextAction : text(p.nextAction, 300), updatedAt: stamp, revision: cur.revision + 1 });
      rows[i] = updated; return rows; }); return updated;
  }
  async function link(id, input) {
    const body = input && typeof input === 'object' ? input : {}, objectiveIds = strings(body.objectiveIds, 40, 120), reportIds = strings(body.reportIds, 40, 120);
    const missingObjective = objectiveIds.find(x => !objectiveExists(x)), missingReport = reportIds.find(x => !reportExists(x));
    if (missingObjective) throw new Error('linked objective not found: ' + missingObjective); if (missingReport) throw new Error('linked report not found: ' + missingReport);
    let updated = null; await durable.update('station', stored => { const rows = Array.isArray(stored) ? stored.slice() : [], i = rows.findIndex(x => x && x.id === String(id || '')); if (i < 0) throw new Error('product project not found');
      const cur = rows[i], objectives = strings(cur.linkedObjectiveIds.concat(objectiveIds), 40, 120), reports = strings(cur.linkedReportIds.concat(reportIds), 40, 120);
      if (objectives.length === cur.linkedObjectiveIds.length && reports.length === cur.linkedReportIds.length) { updated = cur; return undefined; }
      updated = Object.assign({}, cur, { linkedObjectiveIds: objectives, linkedReportIds: reports, updatedAt: Math.max(Number(cur.updatedAt) || 0, Number(now()) || 0), revision: cur.revision + 1 }); rows[i] = updated; return rows; }); return updated;
  }
  function progress(project) { const p = typeof project === 'string' ? get(project) : project; if (!p) return null; return { projectId: p.id, status: p.status, qaState: p.qaState, listingState: p.listingState, publicationState: p.publicationState,
    objectives: p.linkedObjectiveIds.map(id => { const x = objectiveExists(id); return x ? { id, status: typeof x === 'object' ? x.status : 'linked', assignedRoleId: typeof x === 'object' ? x.assignedRoleId || null : null } : null; }).filter(Boolean),
    reports: p.linkedReportIds.map(id => { const x = reportExists(id); return x ? { id, type: typeof x === 'object' ? x.type : 'linked', createdAt: typeof x === 'object' ? Number(x.createdAt) || 0 : 0 } : null; }).filter(Boolean), blockers: p.blockers.slice(), nextAction: p.nextAction }; }
  return { create, update, link, list, get, progress, readStatus: () => durable.readKey('station'), _durable: durable };
}
module.exports = { makeProductProjectStore, STATUSES, NEXT, CAP };
