'use strict';
const { makeDurableJsonStore } = require('./durable-store.js');
const CAP = 200;
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function slug(v) { return text(v, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); }
function strings(v, cap, width) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, width)).filter(Boolean))].slice(0, cap); }
function same(a, b) { return !!a && ['candidateId', 'configurationId', 'replacesConfigurationId', 'roleId', 'evaluationReportId', 'summary', 'intendedChanges', 'risks', 'rollbackPlan', 'evidenceRefs'].every(k => JSON.stringify(a[k]) === JSON.stringify(b[k])); }

function makeConfigurationCandidateStore(deps) {
  const d = deps || {}, now = typeof d.now === 'function' ? d.now : Date.now;
  const getReport = typeof d.getReport === 'function' ? d.getReport : () => null;
  const durable = d.durable || makeDurableJsonStore({ fs: d.fs, path: d.path, writeDurable: d.writeDurable,
    fileFor: () => d.path.join(d.workspaces, 'pine-star.configuration-candidates.json'), onRecover: d.onRecover, onCorrupt: d.onCorrupt });
  function build(input) {
    const x = input && typeof input === 'object' ? input : {}, candidateId = slug(x.candidateId), configurationId = text(x.configurationId, 100), replacesConfigurationId = text(x.replacesConfigurationId, 100);
    const roleId = text(x.roleId, 100), evaluationReportId = text(x.evaluationReportId, 120), report = getReport(evaluationReportId);
    if (!candidateId || !configurationId || !replacesConfigurationId || !roleId || !evaluationReportId) throw new Error('configuration candidate requires stable candidate, configuration, replaced configuration, role, and evaluation report IDs');
    if (configurationId === replacesConfigurationId) throw new Error('candidate configuration must differ from the champion');
    if (!report || report.type !== 'champion-challenger-evaluation') throw new Error('configuration candidate requires an existing champion/challenger evaluation report');
    if (!(Array.isArray(report.decisions) && report.decisions.some(v => /^challenger_recommended:/.test(String(v))))) throw new Error('configuration candidate requires a challenger recommendation');
    if (!(Array.isArray(report.sourceRefs) && report.sourceRefs.includes('evaluation-evidence:complete-v1'))) throw new Error('configuration candidate requires a complete measured evaluation');
    const stamp = Math.max(0, Number(now()) || 0), evidenceRefs = strings(['report:' + evaluationReportId].concat(Array.isArray(x.evidenceRefs) ? x.evidenceRefs : []), 24, 500);
    return { schema: 'pine-star.configuration-candidate.v1', id: 'configuration-candidate:' + candidateId, candidateId, configurationId, replacesConfigurationId, roleId, evaluationReportId,
      summary: text(x.summary, 500), intendedChanges: strings(x.intendedChanges, 20, 240), risks: strings(x.risks, 20, 240), rollbackPlan: text(x.rollbackPlan, 500), evidenceRefs,
      status: 'review_required', commanderDecision: null, advisoryOnly: true, admitted: false, activated: false, configurationChanged: false, spendingAuthorityUsd: 0, externalAction: false, createdAt: stamp };
  }
  async function create(input) {
    const candidate = build(input); let result;
    await durable.update('station', stored => { const rows = Array.isArray(stored) ? stored.slice() : [], prior = rows.find(x => x && x.id === candidate.id);
      if (prior) { if (!same(prior, candidate)) throw new Error('configuration candidate already recorded differently'); result = { candidate: prior, idempotent: true }; return undefined; }
      if (rows.length >= CAP) throw new Error('configuration candidate capacity exceeded'); rows.push(candidate); result = { candidate, idempotent: false }; return rows; });
    return result;
  }
  function list(limit) { const rows = durable.get('station'), cap = Math.max(1, Math.min(200, Number(limit) || 50)); return (Array.isArray(rows) ? rows : []).filter(Boolean).slice(-cap).reverse(); }
  function get(id) { return list(CAP).find(x => x.id === String(id || '') || x.candidateId === String(id || '')) || null; }
  return { create, list, get, readStatus: () => durable.readKey('station'), _durable: durable };
}
module.exports = { makeConfigurationCandidateStore, CAP };
