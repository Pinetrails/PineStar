'use strict';
const RECOMMENDATIONS = new Set(['IGNORE', 'WATCH', 'TEST', 'ADD']);
const SOURCE_ADAPTERS = Object.freeze([
  Object.freeze({ id: 'runtime.web_research', kind: 'runtime', live: true, description: 'Existing runtime web research tools; availability and evidence depend on the admitted agent run.' })
]);
function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
function list(value, cap, width) { return [...new Set((Array.isArray(value) ? value : []).map(x => text(x, width)).filter(Boolean))].slice(0, cap); }
function normalizeScoutRequest(input) {
  const row = input && typeof input === 'object' ? input : {}, scoutId = text(row.scoutId, 120), topic = text(row.topic, 240);
  if (!scoutId || !topic) throw new Error('scout request requires scoutId and topic');
  const recommendationLimit = Number(row.recommendationLimit == null ? 5 : row.recommendationLimit);
  if (!Number.isInteger(recommendationLimit) || recommendationLimit < 3 || recommendationLimit > 5) throw new Error('Scout recommendationLimit must be 3-5');
  const scope = { topic, dateScope: text(row.dateScope, 80) || 'current', recommendationLimit,
    allowedLicenses: list(row.allowedLicenses, 12, 80), compatibilityTarget: text(row.compatibilityTarget, 160) || 'Windows / Pine Star',
    sourceAdapterIds: list(row.sourceAdapterIds, 8, 80).length ? list(row.sourceAdapterIds, 8, 80) : ['runtime.web_research'] };
  const known = new Set(SOURCE_ADAPTERS.map(x => x.id));
  if (scope.sourceAdapterIds.some(id => !known.has(id))) throw new Error('unknown Scout source adapter');
  return { scoutId, scope, safety: { spendingAuthorityUsd: 0, installSoftware: false, executeDownloads: false, createAccounts: false, startSubscriptions: false, publishExternally: false, approveIntegrations: false } };
}
function normalizeDiscovery(input) {
  const row = input && typeof input === 'object' ? input : {}, name = text(row.name, 160), source = text(row.source, 100), reference = text(row.url || row.reference, 500);
  if (!name || !source || !reference) throw new Error('Scout discovery requires name, source, and URL/reference');
  const recommendation = text(row.recommendation, 20).toUpperCase();
  if (!RECOMMENDATIONS.has(recommendation)) throw new Error('invalid Scout recommendation');
  return { name, source, reference, purpose: text(row.purpose, 300), relevance: text(row.relevance || row.whyPineStarMightCare, 300), category: text(row.category, 80) || 'UNKNOWN',
    compatibility: text(row.compatibility, 180) || 'UNKNOWN', license: text(row.license, 120) || 'UNKNOWN', cost: text(row.cost || row.freeStatus, 120) || 'UNKNOWN',
    activityEvidence: text(row.activityEvidence, 300) || 'UNKNOWN', integrationDifficulty: text(row.integrationDifficulty, 80) || 'UNKNOWN',
    risk: text(row.risk || row.caveat, 300) || 'UNKNOWN', recommendation, recommendedOwnerRoleId: text(row.recommendedOwnerRoleId, 100) || 'operations.coordinator',
    evidenceRefs: list(row.evidenceRefs, 8, 500) };
}
function normalizeDiscoveries(input, limit) {
  const rows = Array.isArray(input) ? input : [];
  if (rows.length < 1 || rows.length > limit) throw new Error('Scout findings exceed the requested bounded result count');
  const out = [], seen = new Set();
  for (const item of rows) {
    const row = normalizeDiscovery(item), key = (row.reference || row.name).toLowerCase();
    if (seen.has(key)) continue; seen.add(key); out.push(row);
  }
  if (!out.length) throw new Error('Scout findings contain no valid unique discoveries');
  return out;
}
function scoutReport(objective, findings, now) {
  const request = objective.scoutRequest, rows = normalizeDiscoveries(findings, request.scope.recommendationLimit);
  return { id: 'scout-report:' + request.id, type: 'open-source-scout', createdAt: Math.max(0, Number(now) || 0),
    headline: 'Open-source Scout: ' + request.scope.topic, completed: rows.map(x => x.name + ' — ' + x.recommendation),
    exceptions: rows.filter(x => x.license === 'UNKNOWN' || x.cost === 'UNKNOWN').map(x => x.name + ': license/cost remains UNKNOWN'),
    decisions: rows.map(x => x.recommendation + ': ' + x.name + ' → ' + x.recommendedOwnerRoleId),
    nextActions: rows.filter(x => x.recommendation === 'TEST' || x.recommendation === 'ADD').map(x => x.name + ': route to ' + x.recommendedOwnerRoleId + ' for separate review/approval'),
    sourceRefs: [...new Set(rows.flatMap(x => [x.reference].concat(x.evidenceRefs)))].slice(0, 12), discoveries: rows };
}
module.exports = { SOURCE_ADAPTERS, RECOMMENDATIONS, normalizeScoutRequest, normalizeDiscovery, normalizeDiscoveries, scoutReport };
