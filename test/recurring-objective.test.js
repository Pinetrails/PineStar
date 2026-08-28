'use strict';
const A = require('./_assert.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const { normalizeRecurringDefinition, recurringMeta, publicRecurringJob } = require('../sidecar/recurring-objective.js');
const { makeObjectiveStore } = require('../sidecar/objective-store.js');
const { makeRoleRegistry } = require('../sidecar/role-registry.js');
const { SEEDS } = require('../shared/pine-star-roles.js');
const T0 = 1700000000000, flush = () => new Promise(resolve => setImmediate(resolve));

let rows, sequence = 0;
const durable = { get: () => rows, readKey: () => ({ status: rows ? 'ok' : 'absent', value: rows }), update: async (key, mutate) => { const next = await mutate(rows); if (next !== undefined) rows = next; return next; } };
const objectives = makeObjectiveStore({ durable, registry: makeRoleRegistry(SEEDS), now: () => T0 + sequence, newId: () => 'rec-' + (++sequence) });

function definition(extra) {
  return normalizeRecurringDefinition(Object.assign({ scheduleId: 'daily-scout', roleId: 'operations.open_source_scout', recurrence: 'every 1h', timezone: 'America/New_York', enabled: true,
    template: { title: 'Daily Scout', description: 'Research and recommend only.', requiredCapabilities: ['discover_open_source', 'research', 'recommend'], maxModelTier: 'economy' } }, extra));
}
function scheduledJob(def, enabled) {
  return cronStore.makeJob({ id: 'cron-recurring', name: 'Recurring Scout', prompt: def.template.description, agentId: 'scout_agent',
    schedule: cron.parseSchedule(def.recurrence, T0), enabled: enabled !== false, unattendedGrants: [], deliver: 'local', meta: recurringMeta(def) }, { id: 'cron-recurring', now: T0 });
}

(async () => {
  const def = definition();
  A.eq(def.safety, { spendingAuthorityUsd: 0, unattendedGrants: [], externalDelivery: false }, 'recurring definition preserves zero-spend and no unattended grants');
  A.eq(def.template.maxModelTier, 'economy', 'recurring template preserves the model-tier ceiling');
  A.eq(def.template.requiredCapabilities.length, 3, 'recurring template preserves bounded capabilities');
  A.eq(normalizeRecurringDefinition(Object.assign({}, def, { scheduleId: 'x', template: Object.assign({}, def.template, { description: 'z'.repeat(3000) }) })).template.description.length, 2000, 'recurring description is bounded');
  let unsafeId = false; try { normalizeRecurringDefinition({ scheduleId: '../bad', roleId: 'x', recurrence: 'every 1h', template: { title: 'x', requiredCapabilities: ['x'] } }); } catch (e) { unsafeId = /safe scheduleId/.test(e.message); }
  A.ok(unsafeId, 'unsafe schedule identities are rejected');

  const first = await objectives.createRecurringOccurrence(Object.assign({}, def, { cronJobId: 'cron-recurring', cronRunId: 'cron-run-1', scheduledFor: T0 }), 'daily-scout:' + T0);
  A.eq(first.objective.assignedRoleId, 'operations.open_source_scout', 'occurrence routes to its owning specialist role');
  A.eq(first.objective.status, 'assigned', 'safe occurrence enters the normal assigned lifecycle');
  A.eq(first.objective.recurringOccurrence.cronRunId, 'cron-run-1', 'occurrence links scheduler run identity');
  const retry = await objectives.createRecurringOccurrence(Object.assign({}, def, { cronRunId: 'cron-run-retry' }), 'daily-scout:' + T0);
  A.eq(retry.idempotent, true, 'same scheduled occurrence is idempotent after retry/restart');
  A.eq(retry.objective.id, first.objective.id, 'retry returns the original durable objective');
  A.eq(objectives.list(50).filter(x => x.recurringOccurrence && x.recurringOccurrence.key === 'daily-scout:' + T0).length, 1, 'retry cannot mint a duplicate objective');
  const shiftedRetry = await objectives.createRecurringOccurrence(Object.assign({}, def, { scheduledFor: T0 + 60000 }), 'daily-scout:' + (T0 + 60000));
  A.eq(shiftedRetry.objective.id, first.objective.id, 'retry with a shifted cron timestamp reuses unresolved schedule work');
  A.eq(shiftedRetry.reusedPending, true, 'shifted retry reports pending-occurrence reuse');
  A.eq(first.objective.workflowAudit[0].event, 'recurring_occurrence_created', 'occurrence creation records bounded workflow audit evidence');
  await objectives.updateStatus(first.objective.id, 'completed', ['run:daily-scout-first']);
  const nextOccurrence = await objectives.createRecurringOccurrence(Object.assign({}, def, { scheduledFor: T0 + 3600000 }), 'daily-scout:' + (T0 + 3600000));
  A.ok(nextOccurrence.objective.id !== first.objective.id, 'next genuine recurrence creates new work after prior settlement');
  const protectedDef = definition({ scheduleId: 'protected-review', roleId: 'operations.coordinator', template: { title: 'Protected recurring work', requiredCapabilities: ['coordinate'], protectedAction: true } });
  const protectedOccurrence = await objectives.createRecurringOccurrence(protectedDef, 'protected-review:' + T0);
  A.eq(protectedOccurrence.objective.status, 'approval_required', 'protected recurring occurrence remains approval required');
  const scoutWorkflowDef = normalizeRecurringDefinition({ scheduleId: 'structured-scout', roleId: 'operations.open_source_scout', recurrence: '0 9 * * *',
    template: { workflow: 'open-source-scout', scout: { topic: 'Windows automation', recommendationLimit: 3 } } });
  const scoutOccurrence = await objectives.createRecurringOccurrence(scoutWorkflowDef, 'structured-scout:' + T0);
  A.eq(scoutOccurrence.objective.scoutRequest.scope.recommendationLimit, 3, 'recurring Scout occurrence reuses structured Scout report contract');
  A.ok(/Do not install/.test(scoutOccurrence.objective.description), 'recurring Scout reuses the existing no-install runtime directive');

  async function driverCase(result, enabled) {
    let jobs = [scheduledJob(def, enabled)], delegated = 0, directRuns = 0, seenSignal;
    const driver = makeCronDriver({ getJobs: () => jobs, setJobs: next => { jobs = next; return true; },
      runOnce: () => { directRuns++; return Promise.resolve(); }, runPineStarObjective: args => { delegated++; seenSignal = args.signal; return typeof result === 'function' ? result(args) : Promise.resolve(result); },
      emit: () => {}, newId: () => 'cron-run', newAbort: () => new AbortController(), now: () => T0 + 3600000,
      getKey: () => '', hasCredential: () => false, defaultModel: '', persona: '' });
    const tick = driver.applyTick(T0 + 3600000); await flush(); await flush();
    return { driver, tick, delegated: () => delegated, directRuns: () => directRuns, signal: () => seenSignal, job: () => cronStore.getJob(jobs, 'cron-recurring') };
  }
  const success = await driverCase({ ok: true, summary: 'objective completed' });
  A.eq(success.delegated(), 1, 'due recurring schedule delegates exactly once to objective execution');
  A.eq(success.directRuns(), 0, 'recurring schedule never also invokes cron runOnce');
  A.eq(success.job().lastStatus, 'ok', 'successful objective truth synchronizes to cron outcome');
  A.ok(success.job().nextRunAt && success.job().lastRunId === 'cron-run', 'cron retains next-run and last-run inspection metadata');
  success.driver.applyTick(T0 + 3600000); await flush();
  A.eq(success.delegated(), 1, 'advance-before-run prevents duplicate fire at the same instant');
  const disabled = await driverCase({ ok: true }, false);
  A.eq(disabled.delegated(), 0, 'disabled recurring schedule creates no objective occurrence');
  const failure = await driverCase({ ok: false, reason: 'runtime admission failed' });
  A.eq(failure.job().lastStatus, 'error', 'objective admission failure synchronizes truthfully to cron');
  A.ok(failure.job().consecutiveFailures >= 1 && failure.job().lastError, 'existing cron reducer records bounded failure/retry state');

  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const cancelled = await driverCase(() => pending);
  A.eq(cancelled.driver.abortAllLeases(), 1, 'existing cron E-stop aborts the recurring objective lease');
  A.eq(cancelled.signal().aborted, true, 'E-stop signal propagates to objective delegate');
  release({ ok: false, reason: 'cancelled' }); await flush(); await flush();
  A.eq(cancelled.job().lastStatus, 'error', 'cancelled recurring execution settles cron truthfully');
  const publicRow = publicRecurringJob(cancelled.job());
  A.eq(publicRow.scheduleId, 'daily-scout', 'inspection exposes stable schedule identity');
  A.eq(publicRow.lastOutcome, 'error', 'inspection exposes last outcome without another store');
  A.report('recurring-objective.test');
})().catch(e => { console.error(e); process.exit(1); });
