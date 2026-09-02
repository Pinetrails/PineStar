'use strict';
const { makeDurableJsonStore } = require('./durable-store.js');
const CAP = 1000;
const COMMERCE_STATES = ['planned', 'draft', 'approval_required', 'observed_published', 'archived'];
const ENTRY_TYPES = ['revenue', 'expense', 'refund'];
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function strings(v, cap, n) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, n)).filter(Boolean))].slice(0, cap); }
function slug(v) { return text(v, 120).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); }
function amount(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : null; }
function makeBusinessRecordStore(deps) {
  deps = deps || {}; const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const projectExists = typeof deps.projectExists === 'function' ? deps.projectExists : () => false;
  const newId = typeof deps.newId === 'function' ? deps.newId : () => { throw new Error('business record store requires newId'); };
  const durable = deps.durable || makeDurableJsonStore({ fs: deps.fs, path: deps.path, writeDurable: deps.writeDurable,
    fileFor: () => deps.path.join(deps.workspaces, 'pine-star.business-records.json'), onRecover: deps.onRecover, onCorrupt: deps.onCorrupt });
  function state() { const v = durable.get('station'); return v && typeof v === 'object' ? v : { commerce: [], ledger: [] }; }
  function listCommerce(limit, projectId) { const rows = state().commerce || [], cap = Math.max(1, Math.min(250, Number(limit) || 50)); return rows.filter(x => !projectId || x.projectId === projectId).slice(-cap).reverse(); }
  function listLedger(limit, projectId, type) { const rows = state().ledger || [], cap = Math.max(1, Math.min(500, Number(limit) || 100)); return rows.filter(x => (!projectId || x.projectId === projectId) && (!type || x.type === type)).slice(-cap).reverse(); }
  async function recordCommerce(input) {
    const x = input && typeof input === 'object' ? input : {}, projectId = text(x.projectId, 120), marketplace = text(x.marketplace, 100);
    if (!projectId || !projectExists(projectId)) throw new Error('commerce record requires an existing product project');
    if (!marketplace) throw new Error('commerce record requires a marketplace');
    const commerceState = COMMERCE_STATES.includes(x.state) ? x.state : 'planned', evidenceRefs = strings(x.evidenceRefs, 20, 300);
    if (commerceState === 'observed_published' && !evidenceRefs.length) throw new Error('observed publication requires evidence');
    const id = slug(x.recordId) || ('commerce:' + slug(newId())), stamp = Math.max(0, Number(now()) || 0);
    const row = { schema: 'pine-star.commerce-record.v1', id, projectId, marketplace, state: commerceState,
      externalListingId: text(x.externalListingId, 200) || null, listingUrl: text(x.listingUrl, 1000) || null,
      evidenceRefs, notes: text(x.notes, 1000), recordsExternalAction: false, spendingAuthorityUsd: 0, createdAt: stamp, updatedAt: stamp };
    let result; await durable.update('station', stored => { const s = stored && typeof stored === 'object' ? { commerce: (stored.commerce || []).slice(), ledger: (stored.ledger || []).slice() } : { commerce: [], ledger: [] };
      const prior = s.commerce.find(r => r && r.id === id); if (prior) { if (JSON.stringify(Object.assign({}, prior, { createdAt: 0, updatedAt: 0 })) === JSON.stringify(Object.assign({}, row, { createdAt: 0, updatedAt: 0 }))) { result = { record: prior, idempotent: true }; return undefined; } throw new Error('commerce recordId already recorded differently'); }
      if (s.commerce.length >= CAP) throw new Error('commerce record capacity exceeded'); s.commerce.push(row); result = { record: row, idempotent: false }; return s; }); return result;
  }
  async function recordLedger(input) {
    const x = input && typeof input === 'object' ? input : {}, type = text(x.type, 30), amountUsd = amount(x.amountUsd), projectId = text(x.projectId, 120) || null;
    if (!ENTRY_TYPES.includes(type)) throw new Error('ledger entry requires revenue, expense, or refund type');
    if (amountUsd == null) throw new Error('ledger entry requires a non-negative amountUsd');
    if (projectId && !projectExists(projectId)) throw new Error('ledger entry product project not found');
    const source = text(x.source, 200), evidenceRefs = strings(x.evidenceRefs, 20, 300), occurredAt = Math.max(0, Number(x.occurredAt) || 0);
    if (!source || !evidenceRefs.length || !occurredAt) throw new Error('ledger entry requires source, evidenceRefs, and occurredAt');
    const id = slug(x.entryId) || ('business-entry:' + slug(newId())), stamp = Math.max(0, Number(now()) || 0);
    const row = { schema: 'pine-star.business-ledger-entry.v1', id, type, amountUsd, currency: 'USD', projectId, source,
      evidenceRefs, occurredAt, notes: text(x.notes, 1000), recordsExternalAction: false, spendingAuthorityUsd: 0, createdAt: stamp };
    let result; await durable.update('station', stored => { const s = stored && typeof stored === 'object' ? { commerce: (stored.commerce || []).slice(), ledger: (stored.ledger || []).slice() } : { commerce: [], ledger: [] };
      const prior = s.ledger.find(r => r && r.id === id); if (prior) { if (JSON.stringify(Object.assign({}, prior, { createdAt: 0 })) === JSON.stringify(Object.assign({}, row, { createdAt: 0 }))) { result = { entry: prior, idempotent: true }; return undefined; } throw new Error('ledger entryId already recorded differently'); }
      if (s.ledger.length >= CAP) throw new Error('business ledger capacity exceeded'); s.ledger.push(row); result = { entry: row, idempotent: false }; return s; }); return result;
  }
  function summary(start, end) { const from = Math.max(0, Number(start) || 0), through = Math.max(from, Number(end) || Number(now()) || 0), rows = (state().ledger || []).filter(x => x && x.occurredAt > from && x.occurredAt <= through);
    const total = type => rows.filter(x => x.type === type).reduce((sum, x) => sum + x.amountUsd, 0);
    const revenueUsd = total('revenue'), expenseUsd = total('expense'), refundUsd = total('refund');
    const grouped = new Map(); for (const row of rows) { if (!row.projectId) continue; const item = grouped.get(row.projectId) || { projectId: row.projectId, entryCount: 0, revenueUsd: 0, expenseUsd: 0, refundUsd: 0 }; item.entryCount++; item[row.type + 'Usd'] += row.amountUsd; grouped.set(row.projectId, item); }
    const byProject = [...grouped.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)).slice(0, 250).map(x => Object.assign(x, { revenueUsd: Math.round(x.revenueUsd * 10000) / 10000, expenseUsd: Math.round(x.expenseUsd * 10000) / 10000, refundUsd: Math.round(x.refundUsd * 10000) / 10000, netUsd: Math.round((x.revenueUsd - x.expenseUsd - x.refundUsd) * 10000) / 10000 }));
    return { schema: 'pine-star.business-summary.v1', periodStart: from, periodEnd: through, entryCount: rows.length, revenueUsd, expenseUsd, refundUsd, netUsd: Math.round((revenueUsd - expenseUsd - refundUsd) * 10000) / 10000, projectEntryCount: rows.filter(x => x.projectId).length, unallocatedEntryCount: rows.filter(x => !x.projectId).length, byProject, sourceRefs: rows.map(x => 'business-entry:' + x.id).slice(0, 50) };
  }
  return { recordCommerce, recordLedger, listCommerce, listLedger, summary, readStatus: () => durable.readKey('station'), _durable: durable };
}
module.exports = { makeBusinessRecordStore, COMMERCE_STATES, ENTRY_TYPES, CAP };
