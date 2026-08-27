'use strict';
const A = require('./_assert.js');
const { SEEDS } = require('../shared/pine-star-roles.js');
const { makeRoleRegistry } = require('../sidecar/role-registry.js');
const { makeObjectiveStore } = require('../sidecar/objective-store.js');
const { normalizeScoutRequest, normalizeDiscoveries, scoutReport, SOURCE_ADAPTERS } = require('../sidecar/open-source-scout.js');
const { appendSharedReport } = require('../sidecar/memory-store.js');
let rows, seq = 0;
const durable = { get: () => rows, readKey: () => ({ status: rows ? 'ok' : 'absent', value: rows }), update: async (key, mutate) => { const next = await mutate(rows); if (next !== undefined) rows = next; return next; } };
const store = makeObjectiveStore({ durable, registry: makeRoleRegistry(SEEDS), now: () => 100 + seq, newId: () => 'scout-' + (++seq) });
(async () => {
  const role = makeRoleRegistry(SEEDS).get('operations.open_source_scout');
  A.ok(role && role.availability === 'active', 'Scout is registered as a real active system role');
  A.eq(role.permissions.installSoftware, false, 'Scout role cannot install software');
  A.eq(SOURCE_ADAPTERS[0].id, 'runtime.web_research', 'Scout exposes an extensible truthful source-adapter contract');
  const request = normalizeScoutRequest({ scoutId: 'daily-2026-08-27', topic: 'local AI developer tools', recommendationLimit: 3, allowedLicenses: ['MIT'], compatibilityTarget: 'Windows 11' });
  const made = await store.createScout(request);
  A.eq(made.objective.assignedRoleId, 'operations.open_source_scout', 'Scout objective routes directly to the specialist');
  A.eq(made.objective.assignedModelTier, 'economy', 'Scout uses the economy model tier');
  A.eq(made.objective.requiredCapabilities, ['discover_open_source', 'research', 'recommend'], 'Scout declares research/recommendation capabilities only');
  A.eq(made.objective.status, 'assigned', 'Scout request does not auto-admit or auto-activate');
  A.eq(made.objective.scoutRequest.safety.spendingAuthorityUsd, 0, 'Scout request preserves zero spending authority');
  A.eq(made.objective.scoutRequest.safety.installSoftware, false, 'Scout request explicitly forbids installation');
  A.ok(/Do not install/.test(made.objective.description) && /must remain UNKNOWN/.test(made.objective.description), 'runtime directive preserves safety and unknown-fact rules');
  A.eq((await store.createScout(request)).idempotent, true, 'same Scout request is idempotent');
  let conflict = false; try { await store.createScout(normalizeScoutRequest({ scoutId: request.scoutId, topic: 'different scope', recommendationLimit: 3 })); } catch (e) { conflict = /another scope/.test(e.message); }
  A.ok(conflict, 'Scout identity cannot silently change scope');
  let badLimit = false; try { normalizeScoutRequest({ scoutId: 'bad', topic: 'x', recommendationLimit: 9 }); } catch (e) { badLimit = /3-5/.test(e.message); }
  A.ok(badLimit, 'Scout result count is bounded to 3-5');
  let malformed = false; try { normalizeDiscoveries([{ name: 'Missing source' }], 3); } catch (e) { malformed = /requires/.test(e.message); }
  A.ok(malformed, 'malformed discoveries are rejected');
  const fixture = { name: 'Example Tool', source: 'Fixture', url: 'https://example.invalid/tool', purpose: 'Test normalization', recommendation: 'watch', evidenceRefs: ['fixture:evidence'] };
  const normalized = normalizeDiscoveries([fixture, Object.assign({}, fixture)], 3);
  A.eq(normalized.length, 1, 'duplicate findings collapse by reference');
  A.eq(normalized[0].recommendation, 'WATCH', 'recommendation classification normalizes safely');
  A.eq(normalized[0].license, 'UNKNOWN', 'unknown license remains UNKNOWN');
  A.eq(normalized[0].cost, 'UNKNOWN', 'unknown cost remains UNKNOWN');
  await store.updateStatus(made.objective.id, 'completed', ['run:fixture-scout']);
  const settled = store.get(made.objective.id), report = scoutReport(settled, [fixture], 200);
  A.eq(report.discoveries[0].evidenceRefs, ['fixture:evidence'], 'evidence remains attached to the discovery');
  let reports; const reportStore = { update: async (key, mutate) => { const next = await mutate(reports); if (next !== undefined) reports = next; } };
  A.eq((await appendSharedReport(reportStore, report)).added, true, 'Scout creates a shared report through the existing report system');
  const linked = await store.recordScoutReport(settled.id, report.id);
  A.eq(linked.scoutReportId, report.id, 'Scout objective links its shared report');
  A.eq(linked.workflowAudit[0].event, 'scout_report_created', 'Scout report creation records durable audit evidence');
  const protectedObjective = await store.create({ title: 'Install a discovery', requiredCapabilities: ['code'], protectedAction: true });
  A.eq(protectedObjective.status, 'approval_required', 'protected follow-on action remains blocked');
  A.report('objective-scout.test');
})().catch(e => { console.error(e); process.exit(1); });
