'use strict';
const { makeDurableJsonStore } = require('./durable-store.js');
const CAP = 1000;
const STATES = new Set(['completed', 'failed', 'cancelled']);
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function slug(v) { return text(v, 120).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); }
function strings(v, cap, width) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, width)).filter(Boolean))].slice(0, cap); }
function nonnegative(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }
function same(a, b) { return !!a && JSON.stringify(a) === JSON.stringify(b); }

function makeMatchedMeasurementStore(deps) {
  const d = deps || {}, authority = d.authority, now = typeof d.now === 'function' ? d.now : Date.now;
  if (!authority) throw new Error('matched measurement store requires host authority');
  const durable = d.durable || makeDurableJsonStore({ fs: d.fs, path: d.path, writeDurable: d.writeDurable,
    fileFor: () => d.path.join(d.workspaces, 'pine-star.matched-measurements.json'), onRecover: d.onRecover, onCorrupt: d.onCorrupt });
  function build(input, proof) {
    if (proof !== authority) throw new Error('matched measurement requires host-observed authority');
    const x = input && typeof input === 'object' ? input : {}, measurementId = slug(x.measurementId), cohortId = slug(x.cohortId), arm = text(x.arm, 20).toLowerCase();
    const roleId = text(x.roleId, 100), configurationId = text(x.configurationId, 100), taskId = slug(x.taskId), conditionsDigest = text(x.conditionsDigest, 64).toLowerCase();
    const objectiveId = text(x.objectiveId, 120), runId = text(x.runId, 120), state = text(x.state, 20).toLowerCase();
    const provider = text(x.provider, 80), model = text(x.model, 80), completionEvidenceRefs = strings(x.completionEvidenceRefs, 24, 500);
    const sourceRefs = strings(x.sourceRefs, 32, 500), safetyExceptions = strings(x.safetyExceptions, 20, 240), uncertainty = strings(x.uncertainty, 20, 240);
    if (!measurementId || !cohortId || !['champion', 'challenger'].includes(arm) || !roleId || !configurationId || !taskId || !/^[a-f0-9]{64}$/.test(conditionsDigest) || !objectiveId || !runId || !STATES.has(state)) throw new Error('matched measurement requires stable identity, cohort, arm, role, configuration, task, conditions digest, objective, run, and settled state');
    if (!provider || !model) throw new Error('matched measurement requires observed provider and model identity');
    if (state === 'completed' && !completionEvidenceRefs.length) throw new Error('completed matched measurement requires completion evidence');
    if (!sourceRefs.includes('objective:' + objectiveId) || !sourceRefs.includes('run:' + runId)) throw new Error('matched measurement requires objective and run provenance');
    return { schema: 'pine-star.matched-measurement.v1', id: 'matched-measurement:' + measurementId, measurementId, cohortId, arm, roleId, configurationId, taskId, conditionsDigest,
      objectiveId, runId, state, completionEvidenceRefs, durationMs: nonnegative(x.durationMs), costUsd: nonnegative(x.costUsd), tokens: nonnegative(x.tokens), provider, model,
      usage: { inputTokens: nonnegative(x.usage && x.usage.inputTokens), outputTokens: nonnegative(x.usage && x.usage.outputTokens) },
      wastedWork: { retryCount: nonnegative(x.wastedWork && x.wastedWork.retryCount), recoveryAttemptCount: nonnegative(x.wastedWork && x.wastedWork.recoveryAttemptCount), wastedCostUsd: nonnegative(x.wastedWork && x.wastedWork.wastedCostUsd) },
      safetyExceptions, uncertainty, sourceRefs, externallyVisible: false, configurationActivated: false, spendingAuthorityUsd: 0, observedAt: Math.max(0, Number(x.observedAt) || Number(now()) || 0) };
  }
  async function recordObserved(input, proof) { const measurement = build(input, proof); let result;
    await durable.update('station', stored => { const rows = Array.isArray(stored) ? stored.slice() : [], prior = rows.find(x => x && x.id === measurement.id);
      if (prior) { if (!same(prior, measurement)) throw new Error('matched measurement already recorded differently'); result = { measurement: prior, idempotent: true }; return undefined; }
      if (rows.length >= CAP) throw new Error('matched measurement capacity exceeded'); rows.push(measurement); result = { measurement, idempotent: false }; return rows; }); return result; }
  function list(limit) { const rows = durable.get('station'), cap = Math.max(1, Math.min(CAP, Number(limit) || 100)); return (Array.isArray(rows) ? rows : []).filter(Boolean).slice(-cap).reverse(); }
  return { recordObserved, list, get: id => list(CAP).find(x => x.id === String(id || '') || x.measurementId === String(id || '')) || null, readStatus: () => durable.readKey('station'), _durable: durable };
}
module.exports = { makeMatchedMeasurementStore, CAP };
