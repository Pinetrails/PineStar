'use strict';
const A = require('./_assert.js');
const { makeMatchedMeasurementStore } = require('../sidecar/matched-measurement-store.js');
let rows; const durable = { get: () => rows, readKey: async () => rows, update: async (key, fn) => { const next = await fn(rows); if (next !== undefined) rows = next; return next; } };
const authority = Symbol('host-observation');
const store = makeMatchedMeasurementStore({ durable, authority, now: () => 500 });
const base = { measurementId: 'cohort-a-champion-task-1', cohortId: 'cohort-a', arm: 'champion', roleId: 'operations.auditor', configurationId: 'auditor-local-v1', taskId: 'inspect-json-1', conditionsDigest: 'a'.repeat(64), objectiveId: 'objective:c1', runId: 'run:c1', state: 'completed', completionEvidenceRefs: ['artifact:result-c1.json'], durationMs: 12, costUsd: 0, tokens: 40, provider: 'local', model: 'deterministic-auditor', usage: { inputTokens: 25, outputTokens: 15 }, wastedWork: { retryCount: 0, recoveryAttemptCount: 0, wastedCostUsd: 0 }, sourceRefs: ['objective:objective:c1', 'run:run:c1', 'artifact:result-c1.json'] };
(async () => {
  let denied = false; try { await store.recordObserved(base, Symbol('fake')); } catch (e) { denied = /host-observed/.test(e.message); } A.ok(denied, 'callers cannot manufacture authoritative measurements');
  const first = await store.recordObserved(base, authority); A.eq(first.measurement.schema, 'pine-star.matched-measurement.v1', 'authoritative measurement contract is durable');
  A.eq(first.measurement.configurationActivated, false, 'measurement cannot activate a configuration'); A.eq(first.measurement.spendingAuthorityUsd, 0, 'measurement grants no spend');
  A.eq(first.measurement.durationMs, 12, 'measured runtime persists'); A.eq(first.measurement.usage.outputTokens, 15, 'provider usage persists when observed');
  A.eq((await store.recordObserved(base, authority)).idempotent, true, 'exact observation replay is idempotent');
  let conflict = false; try { await store.recordObserved(Object.assign({}, base, { durationMs: 13 }), authority); } catch (e) { conflict = /differently/.test(e.message); } A.ok(conflict, 'stable measurement identity is immutable');
  let noEvidence = false; try { await store.recordObserved(Object.assign({}, base, { measurementId: 'missing-evidence', completionEvidenceRefs: [] }), authority); } catch (e) { noEvidence = /completion evidence/.test(e.message); } A.ok(noEvidence, 'completed observations require completion evidence');
  let noProvenance = false; try { await store.recordObserved(Object.assign({}, base, { measurementId: 'missing-provenance', sourceRefs: [] }), authority); } catch (e) { noProvenance = /provenance/.test(e.message); } A.ok(noProvenance, 'objective and run provenance are mandatory');
  A.report('matched-measurement-store.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
