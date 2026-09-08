'use strict';
// PS-2026-073: deterministic facts are authoritative; model content is advisory only.
const AuditV2 = require('./auditor-json-audit-v2.js');

const REPORT_SCHEMA = 'pine-star.hybrid-auditor-report.v1';
function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
function strings(value, cap, width) { return [...new Set((Array.isArray(value) ? value : []).map((v) => text(v, width)).filter(Boolean))].slice(0, cap); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function verifyObjective(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('objective verification requires a record');
  const mechanical = AuditV2.expected('objective-store-audit-v2', Buffer.from(JSON.stringify([target])), null);
  return Object.freeze({
    schema: 'pine-star.auditor-verified-facts.v1', authority: 'deterministic-mechanical-verifier',
    verifierContract: AuditV2.CONTRACT.version, targetObjectiveId: text(target.id, 120),
    targetStatus: text(target.status, 40), targetSettled: ['completed', 'failed', 'cancelled'].includes(target.status),
    completionEvidenceRefs: Object.freeze(strings(target.completionEvidenceRefs, 24, 240)),
    facts: Object.freeze({ validJson: mechanical.validJson, recordCount: mechanical.recordCount,
      issueCount: mechanical.issueCount, evidenceRefs: Object.freeze(mechanical.evidenceRefs.slice()) }),
    sourceRefs: Object.freeze(['objective:' + text(target.id, 120)].concat(strings(target.completionEvidenceRefs, 24, 240)))
  });
}

function interpretationDirective(verified) {
  return [
    'HYBRID AUDITOR BOUNDARY:',
    'The VERIFIED FACT block below was computed deterministically and is authoritative.',
    'Do not revise, contradict, replace, or recalculate its JSON validity, record count, schema/state issues, evidence references, or target status.',
    'Perform judgment work only: explain significance, prioritize anomalies, state uncertainty, and recommend bounded follow-up.',
    'Return only a JSON object with exactly these string/string-array fields: {"modelInterpretation":"string","uncertainty":["string"],"recommendedFollowUp":["string"]}.',
    'VERIFIED FACT:', JSON.stringify(verified)
  ].join('\n');
}

function composeReport(auditObjective, modelSections) {
  const verified = auditObjective && auditObjective.auditRequest && auditObjective.auditRequest.verifiedFacts;
  if (!verified || verified.authority !== 'deterministic-mechanical-verifier') throw new Error('hybrid report requires persisted deterministic facts');
  const model = modelSections && typeof modelSections === 'object' && !Array.isArray(modelSections) ? modelSections : {};
  const allowed = ['modelInterpretation', 'recommendedFollowUp', 'uncertainty'];
  if (Object.keys(model).some((key) => !allowed.includes(key))) throw new Error('model output may contain interpretation fields only');
  return {
    schema: REPORT_SCHEMA, auditObjectiveId: auditObjective.id, targetObjectiveId: auditObjective.auditTargetObjectiveId,
    verifiedFact: clone(verified),
    modelInterpretation: text(model.modelInterpretation, 4000) || 'UNKNOWN',
    uncertainty: strings(model.uncertainty, 24, 500),
    recommendedFollowUp: strings(model.recommendedFollowUp, 24, 500),
    sourceRefs: strings(verified.sourceRefs, 30, 500),
    boundary: 'verifiedFact is deterministic and authoritative; modelInterpretation is advisory and cannot override it'
  };
}

module.exports = { REPORT_SCHEMA, verifyObjective, interpretationDirective, composeReport };
