'use strict';
const { normalizeScoutRequest, scoutDirective } = require('./open-source-scout.js');
function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
function list(value, cap, width) { return [...new Set((Array.isArray(value) ? value : []).map(x => text(x, width)).filter(Boolean))].slice(0, cap); }
function normalizeRecurringDefinition(input) {
  const row = input && typeof input === 'object' ? input : {}, template = row.template && typeof row.template === 'object' ? row.template : {};
  const scheduleId = text(row.scheduleId, 80), roleId = text(row.roleId, 80), recurrence = text(row.recurrence, 160);
  const workflow = template.workflow === 'open-source-scout' ? 'open-source-scout' : null;
  let workflowConfig = null;
  if (workflow) workflowConfig = normalizeScoutRequest(Object.assign({}, template.scout || {}, { scoutId: scheduleId }));
  const title = text(template.title, 240) || (workflow ? 'Daily Open-Source Scout: ' + workflowConfig.scope.topic : '');
  const requiredCapabilities = workflow ? ['discover_open_source', 'research', 'recommend'] : list(template.requiredCapabilities, 24, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(scheduleId)) throw new Error('recurring objective requires a safe scheduleId');
  if (!roleId || !recurrence || !title || !requiredCapabilities.length) throw new Error('recurring objective requires roleId, recurrence, and a capable objective template');
  if (workflow && roleId !== 'operations.open_source_scout') throw new Error('open-source Scout workflow requires the Scout role');
  const maxModelTier = workflow ? 'economy' : (['economy', 'balanced', 'deep'].includes(template.maxModelTier) ? template.maxModelTier : 'deep');
  const normalized = { scheduleId, roleId, recurrence, timezone: text(row.timezone, 80) || null, enabled: row.enabled !== false,
    template: { title, description: workflow ? scoutDirective(workflowConfig.scope) : text(template.description, 2000), requiredCapabilities, maxModelTier,
      protectedAction: workflow ? false : template.protectedAction === true, priority: ['low', 'normal', 'high', 'urgent'].includes(template.priority) ? template.priority : 'normal',
      workflow, workflowConfig },
    safety: { spendingAuthorityUsd: 0, unattendedGrants: [], externalDelivery: false } };
  normalized.signature = JSON.stringify({ roleId: normalized.roleId, recurrence: normalized.recurrence, timezone: normalized.timezone, template: normalized.template });
  return normalized;
}
function recurringMeta(definition) {
  return { pineStarRecurring: { scheduleId: definition.scheduleId, roleId: definition.roleId, signature: definition.signature,
    template: definition.template, safety: definition.safety } };
}
function publicRecurringJob(job) {
  const meta = job && job.meta && job.meta.pineStarRecurring;
  if (!meta) return null;
  return { scheduleId: meta.scheduleId, cronJobId: job.id, roleId: meta.roleId, template: meta.template, enabled: job.enabled !== false,
    recurrence: job.scheduleDisplay, schedule: job.schedule, createdAt: job.createdAt, nextRunAt: job.nextRunAt, lastRunAt: job.lastRunAt,
    lastRunId: job.lastRunId, lastOutcome: job.lastStatus, lastError: job.lastError, retryCount: Number(job.retryCount) || 0,
    consecutiveFailures: Number(job.consecutiveFailures) || 0, disabledReason: job.disabledReason || null, state: job.state };
}
module.exports = { normalizeRecurringDefinition, recurringMeta, publicRecurringJob };
