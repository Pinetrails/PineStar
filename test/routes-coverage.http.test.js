/* node test/routes-coverage.http.test.js — direct HTTP-path coverage for 19 sidecar routes that were
   live-proven truthful during the routes-area Atlas audit but carried NO machine test on the HTTP path
   itself (Atlas finding 43edd6f5, EL-3: a shipped promise should not be unguarded). Boots the REAL host
   (sidecar/index.js) against an isolated temp workspace on a free ephemeral port, then drives each route
   over real sockets with a happy path + an honest-failure assertion (and the token gate on a sample).

   ZERO model spend: none of these routes hit a provider — they read/serve store + descriptor state, or
   validate-and-reject. Provider keys are cleared so no route can wander onto the network. The dialog/native
   and network-live siblings from the finding (POST /api/projects/pickfolder, GET /api/auth/{codex,grok,kimi}/
   models) stay KNOWN by nature; /api/auth/codex/status IS covered here (status is offline-truthful).

   NOT in test:fast (a child-process boot test shouldn't gate other agents' merges); run via test:http. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// spawn the host; resolve once it logs its listen URL, retry the next port on EADDRINUSE.
function boot(port, workspaces, attemptsLeft, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, {
        SKYNET_PORT: String(port), STARNET_PORT: String(port),
        SKYNET_WORKSPACES: workspaces, STARNET_WORKSPACES: workspaces,
        // clear every provider key so no route can reach the network (determinism + zero spend).
        OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
        OPENROUTER_API_KEY: '', STARNET_OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_API_KEY: '',
        ANTHROPIC_API_KEY: '', STARNET_ANTHROPIC_API_KEY: '', SKYNET_ANTHROPIC_API_KEY: '',
        GEMINI_API_KEY: '', STARNET_GEMINI_API_KEY: '', SKYNET_GEMINI_API_KEY: '',
        // keep DEV off by default so POST /api/dev/inbound proves its 404 gate deterministically.
        STARNET_DEV: '', SKYNET_DEV: '',
        STARNET_APP_VERSION: '9.9.9-routes-test'
      }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, workspaces, attemptsLeft - 1, extraEnv));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 45000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-routes-'));
  fs.writeFileSync(path.join(ws, 'deliverables.library.json'), JSON.stringify({ v: 2, appliedSeq: 0, rows: [{ id: 'http-product-artifact', agentId: 'fixture', runId: 'fixture-run', title: 'Verified product artifact', source: 'test-fixture', status: 'kept', kind: 'files', summary: 'Existing artifact evidence for the isolated HTTP fixture.', files: [{ path: 'trail-kit.pdf', bytes: 128 }], createdAt: 1, updatedAt: 1 }], undo: [] }));
  const booted = await boot(8890 + (process.pid % 40), ws, 20);
  const { child, port } = booted;
  const B = 'http://' + HOST + ':' + port;
  let apiToken = '';
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;
    if (apiToken) headers['Origin'] = B;
    const r = await fetch(B + p, { method: m, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };
  // a raw (tokenless) call to prove the auth seam gates a route.
  const raw = (m, p, body) => fetch(B + p, { method: m, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });

  try {
    apiToken = await bootToken(B, B);
    A.ok(apiToken.length >= 32, 'served index.html carried a high-entropy API token');

    // ---- the auth seam gates these data routes (spot-check across GET + POST; the finding notes none are exempt) ----
    for (const [m, p] of [['GET', '/api/quests'], ['GET', '/api/journey'], ['GET', '/api/toolsets'], ['GET', '/api/widgets'], ['GET', '/api/workspace/dir?agent=agent'], ['POST', '/api/activity'], ['POST', '/api/dev/inbound']]) {
      const g = await raw(m, p, m === 'POST' ? {} : undefined);
      A.eq(g.status, 403, m + ' ' + p + ' WITHOUT a token -> 403 (auth seam holds)');
    }

    // ---- (1) GET /api/nightshift/drafts — an empty night is an honest empty list ----
    const drafts = await j('GET', '/api/nightshift/drafts');
    A.eq(drafts.status, 200, 'GET /api/nightshift/drafts -> 200');
    A.ok(Array.isArray(drafts.body.drafts), 'drafts route returns {drafts:[...]} (empty on a fresh workspace)');
    A.eq(drafts.body.drafts.length, 0, 'fresh workspace has no night-shift drafts');

    // ---- Pine Star shared-report boundary: authenticated, durable, idempotent, and projection-only ----
    const reportInput = { id: 'brief:http-1', type: 'morning-brief', createdAt: 10, headline: 'one task completed', completed: ['task A'], rawTranscript: 'must not survive' };
    const reportWrite = await j('POST', '/api/reports', reportInput);
    A.eq(reportWrite.status, 200, 'POST /api/reports -> 200');
    A.eq(reportWrite.body.added, true, 'first report write is appended');
    A.eq((await j('POST', '/api/reports', reportInput)).body.added, false, 'duplicate report id is idempotent');
    const reportRead = await j('GET', '/api/reports?limit=5');
    A.eq(reportRead.body.reports.length, 1, 'GET /api/reports returns the durable report');
    A.eq(reportRead.body.reports[0].rawTranscript, undefined, 'shared route drops raw/unapproved fields');
    A.eq((await raw('GET', '/api/reports')).status, 403, 'shared reports remain behind the API token gate');
    const morning = await j('POST', '/api/reports/morning-brief', { id: 'morning:http-1', periodStart: 1, periodEnd: 100 });
    A.eq(morning.status, 201, 'POST /api/reports/morning-brief creates a shared report');
    A.eq(morning.body.report.type, 'morning-brief', 'Morning Brief uses the shared report architecture');
    A.eq((await j('POST', '/api/reports/morning-brief', { id: 'morning:http-1', periodStart: 1, periodEnd: 100 })).status, 200, 'Morning Brief generation is idempotent by report id');
    A.eq((await raw('POST', '/api/reports/morning-brief', {})).status, 403, 'Morning Brief generation remains behind the API token gate');
    const controlStatus = await j('GET', '/api/control/status');
    A.eq(controlStatus.body.schema, 'pine-star.control-status.v1', 'control status exposes a versioned machine contract');
    A.eq(controlStatus.body.reportCount, 2, 'control status reconciles to both durable shared reports');
    A.eq(controlStatus.body.externalSync.enabled, false, 'external/Obsidian synchronization is truthfully off');
    A.eq(controlStatus.body.spendingAuthorityUsd, 0, 'control status preserves the zero-spend default');

    // ---- Pine Star role discovery + durable objective lifecycle ----
    A.eq((await raw('GET', '/api/roles')).status, 403, 'role discovery remains behind the API token gate');
    A.eq((await raw('POST', '/api/objectives', {})).status, 403, 'objective creation remains behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/intake', {})).status, 403, 'objective intake remains behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/decompose', {})).status, 403, 'objective decomposition remains behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/audit', {})).status, 403, 'objective audit requests remain behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/scout', {})).status, 403, 'Scout requests remain behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/scout/report', {})).status, 403, 'Scout reports remain behind the API token gate');
    A.eq((await raw('GET', '/api/objectives/recurring')).status, 403, 'recurring objective inspection remains behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/recurring', {})).status, 403, 'recurring objective creation remains behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/recurring/status', {})).status, 403, 'recurring objective status remains behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/admit', {})).status, 403, 'objective admission remains behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/activate', {})).status, 403, 'objective activation remains behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/cancel', {})).status, 403, 'objective cancellation remains behind the API token gate');
    A.eq((await raw('GET', '/api/objectives/away')).status, 403, 'Away objective inspection remains behind the API token gate');
    A.eq((await raw('POST', '/api/objectives/away', {})).status, 403, 'Away objective enqueue remains behind the API token gate');
    A.eq((await raw('DELETE', '/api/objectives/away', {})).status, 403, 'Away objective cancellation remains behind the API token gate');
    A.eq((await raw('GET', '/api/product-projects')).status, 403, 'product project inspection remains behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects', {})).status, 403, 'product project creation remains behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects/update', {})).status, 403, 'product project updates remain behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects/link', {})).status, 403, 'product project links remain behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects/ideas', {})).status, 403, 'product idea intake remains behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects/research-decision', {})).status, 403, 'product research decisions remain behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects/production-plan', {})).status, 403, 'product production plans remain behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects/qa', {})).status, 403, 'product QA finalization remains behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects/publication-approval-request', {})).status, 403, 'publication approval requests remain behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects/publication-approval-withdrawal', {})).status, 403, 'publication approval withdrawals remain behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects/pine-trail-printables', {})).status, 403, 'Pine Trail printable intake remains behind the API token gate');
    A.eq((await raw('POST', '/api/product-projects/pine-trail-printables/production-plan', {})).status, 403, 'Pine Trail production planning remains behind the API token gate');
    A.eq((await raw('GET', '/api/business/commerce-records')).status, 403, 'commerce records remain behind the API token gate');
    A.eq((await raw('POST', '/api/business/commerce-records', {})).status, 403, 'commerce record writes remain behind the API token gate');
    A.eq((await raw('GET', '/api/business/ledger')).status, 403, 'business ledger remains behind the API token gate');
    A.eq((await raw('POST', '/api/business/ledger', {})).status, 403, 'business ledger writes remain behind the API token gate');
    A.eq((await raw('POST', '/api/business/growth-experiments', {})).status, 403, 'growth experiment planning remains behind the API token gate');
    A.eq((await raw('POST', '/api/business/growth-experiments/result', {})).status, 403, 'growth experiment results remain behind the API token gate');
    const roles = await j('GET', '/api/roles');
    A.eq(roles.status, 200, 'GET /api/roles -> 200');
    A.ok(roles.body.roles.some(role => role.id === 'research.general_researcher'), 'role discovery exposes stable system role IDs');
    const created = await j('POST', '/api/objectives', { title: 'Verify HTTP objective durability', requiredCapabilities: ['research', 'verify'], maxModelTier: 'economy' });
    A.eq(created.status, 201, 'POST /api/objectives -> 201');
    A.eq(created.body.objective.assignedRoleId, 'research.general_researcher', 'runtime objective persists its routing assignment');
    const objectiveId = created.body.objective.id;
    const objectiveRead = await j('GET', '/api/objectives?limit=5');
    A.ok(objectiveRead.body.objectives.some(objective => objective.id === objectiveId), 'objective is readable after its durable write');
    const objectiveDone = await j('POST', '/api/objectives/status', { id: objectiveId, status: 'completed', completionEvidenceRefs: ['test:http'] });
    A.eq(objectiveDone.body.objective.status, 'completed', 'objective status API records completion');
    const protectedCreated = await j('POST', '/api/objectives', { title: 'External publication', requiredCapabilities: ['publish'], protectedAction: true });
    A.eq(protectedCreated.body.objective.status, 'approval_required', 'protected runtime objective persists without execution');
    const protectedAdmission = await j('POST', '/api/objectives/admit', { id: protectedCreated.body.objective.id });
    A.eq(protectedAdmission.status, 409, 'protected objective admission is rejected');
    A.eq(protectedAdmission.body.code, 'approval_required', 'protected admission names the approval boundary');
    const protectedActivation = await j('POST', '/api/objectives/activate', { id: protectedCreated.body.objective.id });
    A.eq(protectedActivation.body.code, 'approval_required', 'protected objective cannot activate through the runtime API');
    const unboundCreated = await j('POST', '/api/objectives', { title: 'Unbound runtime identity', requiredCapabilities: ['audit'] });
    const awayQueued = await j('POST', '/api/objectives/away', { id: unboundCreated.body.objective.id });
    A.eq(awayQueued.status, 200, 'safe assigned objective can be durably queued for Away work');
    A.eq((await j('GET', '/api/objectives/away')).body.objectives[0].awayWork.state, 'queued', 'Away queue is inspectable without activating work');
    A.eq((await j('POST', '/api/objectives/away', { id: protectedCreated.body.objective.id })).status, 409, 'protected objective cannot enter unattended Away work');
    A.eq((await j('DELETE', '/api/objectives/away', { id: unboundCreated.body.objective.id })).body.objective.awayWork.state, 'cancelled', 'queued Away work is cancellable before activation');
    const unboundAdmission = await j('POST', '/api/objectives/admit', { id: unboundCreated.body.objective.id });
    A.eq(unboundAdmission.body.code, 'runtime_identity_missing', 'admission refuses a role with no approved runtime binding');
    const protectedAdvance = await j('POST', '/api/objectives/status', { id: protectedCreated.body.objective.id, status: 'in_progress' });
    A.eq(protectedAdvance.status, 400, 'status API cannot bypass protected-objective approval');
    const objectiveControlStatus = await j('GET', '/api/control/status');
    A.eq(objectiveControlStatus.body.objectiveCount, 3, 'control status reconciles to the durable objective store');
    A.eq(objectiveControlStatus.body.approvalRequiredCount, 1, 'control status exposes the protected objective backlog');
    const auditRequest = await j('POST', '/api/objectives/audit', { targetObjectiveId: objectiveId, auditId: 'http-audit-1' });
    A.eq(auditRequest.status, 201, 'POST /api/objectives/audit -> 201');
    A.eq(auditRequest.body.objective.assignedRoleId, 'operations.auditor', 'audit request creates directly assigned Auditor work');
    A.eq(auditRequest.body.objective.auditTargetObjectiveId, objectiveId, 'audit objective durably links the settled target');
    A.eq((await j('POST', '/api/objectives/audit', { targetObjectiveId: objectiveId, auditId: 'http-audit-1' })).status, 200, 'audit request retry is idempotent');
    const scoutRequest = await j('POST', '/api/objectives/scout', { scoutId: 'http-scout-1', topic: 'Windows developer utilities', recommendationLimit: 3 });
    A.eq(scoutRequest.status, 201, 'POST /api/objectives/scout -> 201');
    A.eq(scoutRequest.body.objective.assignedRoleId, 'operations.open_source_scout', 'HTTP Scout request routes to the specialist');
    A.eq(scoutRequest.body.objective.status, 'assigned', 'HTTP Scout request does not auto-execute');
    await j('POST', '/api/objectives/status', { id: scoutRequest.body.objective.id, status: 'completed', completionEvidenceRefs: ['run:http-scout-fixture'] });
    const scoutFinal = await j('POST', '/api/objectives/scout/report', { id: scoutRequest.body.objective.id, discoveries: [{ name: 'Fixture project', source: 'Test fixture', url: 'https://example.invalid/fixture', purpose: 'Exercise the report path', recommendation: 'WATCH', evidenceRefs: ['fixture:http'] }] });
    A.eq(scoutFinal.status, 201, 'settled Scout findings create a shared report');
    A.eq(scoutFinal.body.report.discoveries[0].license, 'UNKNOWN', 'HTTP Scout report preserves unknown license truthfully');
    A.eq(scoutFinal.body.objective.workflowAudit[0].event, 'scout_report_created', 'HTTP Scout report records objective audit evidence');
    const scoutReports = await j('GET', '/api/reports?limit=10');
    A.ok(scoutReports.body.reports.some(x => x.id === 'scout-report:http-scout-1'), 'Scout report is readable through the existing shared report API');
    const productCreate = await j('POST', '/api/product-projects', { projectId: 'http-planner', title: 'HTTP Trail Planner', targetMarketplaces: ['Marketplace A'], estimatedCostUsd: 'UNKNOWN', publishAutomatically: true });
    A.eq(productCreate.status, 201, 'POST /api/product-projects -> 201');
    A.eq(productCreate.body.project.spendingAuthorityUsd, 0, 'product project preserves zero-spend authority');
    A.eq(productCreate.body.project.estimatedCostUsd, null, 'unknown product cost remains unknown');
    A.eq((await j('POST', '/api/product-projects', { projectId: 'http-planner', title: 'HTTP Trail Planner' })).status, 200, 'product project creation is idempotent by stable scope');
    const productLink = await j('POST', '/api/product-projects/link', { id: 'http-planner', objectiveIds: [objectiveId], reportIds: ['scout-report:http-scout-1'] });
    A.eq(productLink.status, 200, 'product project links existing objective and report records');
    A.eq(productLink.body.progress.objectives[0].status, 'completed', 'linked objective progress remains inspectable through HTTP');
    const productUpdate = await j('POST', '/api/product-projects/update', { id: 'http-planner', patch: { status: 'research', revision: productLink.body.project.revision, nextAction: 'Compare customer needs' } });
    A.eq(productUpdate.status, 200, 'valid product workflow transition persists');
    A.eq((await j('POST', '/api/product-projects/update', { id: 'http-planner', patch: { status: 'published' } })).status, 400, 'safe product API cannot publish externally');
    const productRead = await j('GET', '/api/product-projects?id=http-planner');
    A.eq(productRead.body.project.status, 'research', 'product project survives durable read-after-write');
    const ideaIntake = await j('POST', '/api/product-projects/ideas', { ideaId: 'http-idea-lab', title: 'HTTP Idea Lab Printable', targetCustomer: 'Trail planners', assumptions: ['A printable may reduce forgotten supplies'] });
    A.eq(ideaIntake.status, 201, 'POST /api/product-projects/ideas -> 201');
    A.eq(ideaIntake.body.parent.assignedRoleId, 'operations.coordinator', 'HTTP idea parent routes to Coordinator');
    A.eq(ideaIntake.body.children.map(x => x.assignedRoleId), ['research.general_researcher', 'business.idea_lab'], 'HTTP idea work routes to useful specialists');
    A.eq(ideaIntake.body.project.linkedObjectiveIds.length, 3, 'HTTP idea project links its objective graph');
    A.eq(ideaIntake.body.project.linkedReportIds, ['product-idea:http-idea-lab'], 'HTTP idea project links its intake report');
    A.eq((await j('POST', '/api/product-projects/ideas', { ideaId: 'http-idea-lab', title: 'HTTP Idea Lab Printable' })).status, 200, 'HTTP idea retry is idempotent');
    A.ok((await j('GET', '/api/reports?limit=20')).body.reports.some(x => x.id === 'product-idea:http-idea-lab'), 'Idea Lab report is readable through the shared report API');
    const pineTrailSpec = { productId: 'http-trail-checklist', title: 'HTTP Trail Checklist', family: 'checklist', useCase: 'Prepare for a day hike', targetCustomer: 'New hikers', assumptions: ['A compact checklist may reduce forgotten gear'] };
    const pineTrail = await j('POST', '/api/product-projects/pine-trail-printables', pineTrailSpec);
    A.eq(pineTrail.status, 201, 'Pine Trail preset enters the existing product intake pipeline');
    A.eq(pineTrail.body.project.id, 'pine-trail-http-trail-checklist', 'Pine Trail product uses a stable namespaced identity');
    A.eq(pineTrail.body.project.productType, 'pine-trail-printable:checklist', 'Pine Trail printable family persists on the product project');
    A.ok(pineTrail.body.project.assetRequirements.some(x => /Original Pine Trail-owned/.test(x)), 'Pine Trail project requires original distributable assets');
    A.eq(pineTrail.body.children.map(x => x.assignedRoleId), ['research.general_researcher', 'business.idea_lab'], 'Pine Trail preset reuses existing specialist routing');
    A.eq(pineTrail.body.externalAction, false, 'Pine Trail intake performs no external commerce action');
    A.eq(pineTrail.body.spendingAuthorityUsd, 0, 'Pine Trail intake grants no spend');
    A.eq((await j('POST', '/api/product-projects/pine-trail-printables', pineTrailSpec)).status, 200, 'Pine Trail intake retry is idempotent');
    await j('POST', '/api/objectives/status', { id: pineTrail.body.children[0].id, status: 'completed', completionEvidenceRefs: ['fixture:pine-trail-market'] });
    await j('POST', '/api/objectives/status', { id: pineTrail.body.children[1].id, status: 'completed', completionEvidenceRefs: ['fixture:pine-trail-concept'] });
    const pineTrailResearch = await j('POST', '/api/product-projects/research-decision', { projectId: pineTrail.body.project.id, researchObjectiveId: pineTrail.body.children[0].id, conceptObjectiveId: pineTrail.body.children[1].id, decision: 'go', rationale: 'Fixture evidence supports bounded printable planning.', findings: ['Fixture need'], risks: ['Fixture evidence limited'], evidenceRefs: ['fixture:pine-trail-market', 'fixture:pine-trail-concept'] });
    A.eq(pineTrailResearch.body.project.status, 'planned', 'evidenced Pine Trail research reaches the existing planning gate');
    const pineTrailProductionSpec = { projectId: pineTrail.body.project.id, planId: 'http-v1', productSpecification: 'Fixture Pine Trail checklist specification', additionalQaChecks: ['Verify checkbox alignment'] };
    const pineTrailProduction = await j('POST', '/api/product-projects/pine-trail-printables/production-plan', pineTrailProductionSpec);
    A.eq(pineTrailProduction.status, 201, 'planned Pine Trail product enters the existing production planner');
    A.eq(pineTrailProduction.body.preset.family, 'checklist', 'production preset derives the persisted Pine Trail family');
    A.eq(pineTrailProduction.body.preset.deliverables, ['Editable checklist source', 'US Letter checklist PDF', 'A4 checklist PDF'], 'production preset creates family-specific expected deliverables');
    A.ok(pineTrailProduction.body.preset.qaChecklist.some(x => /original Pine Trail-owned/.test(x)) && pineTrailProduction.body.preset.qaChecklist.includes('Verify checkbox alignment'), 'production preset combines original-asset and product QA checks');
    A.eq(pineTrailProduction.body.children.map(x => x.assignedRoleId), ['business.product_designer', 'business.product_designer', 'operations.quality_reviewer'], 'Pine Trail production reuses Product Designer and independent QA routing');
    A.eq(pineTrailProduction.body.externalAction, false, 'Pine Trail production planning performs no external action');
    A.eq(pineTrailProduction.body.spendingAuthorityUsd, 0, 'Pine Trail production planning grants zero spend');
    A.eq((await j('POST', '/api/product-projects/pine-trail-printables/production-plan', pineTrailProductionSpec)).status, 200, 'Pine Trail production retry is idempotent');
    await j('POST', '/api/objectives/status', { id: ideaIntake.body.children[0].id, status: 'completed', completionEvidenceRefs: ['report:http-market'] });
    await j('POST', '/api/objectives/status', { id: ideaIntake.body.children[1].id, status: 'completed', completionEvidenceRefs: ['report:http-concept'] });
    const researchDecisionSpec = { projectId: 'http-idea-lab', researchObjectiveId: ideaIntake.body.children[0].id, conceptObjectiveId: ideaIntake.body.children[1].id, decision: 'go', rationale: 'Fixture evidence supports bounded planning.', findings: ['Fixture customer need'], risks: ['Fixture evidence is limited'], evidenceRefs: ['fixture:market', 'fixture:concept'] };
    const researchDecision = await j('POST', '/api/product-projects/research-decision', researchDecisionSpec);
    A.eq(researchDecision.status, 201, 'completed specialist evidence creates a product research decision');
    A.eq(researchDecision.body.project.status, 'planned', 'go decision advances the project to planning');
    A.eq(researchDecision.body.project.spendingAuthorityUsd, 0, 'research decision preserves zero-spend authority');
    A.eq(researchDecision.body.report.id, 'product-research:http-idea-lab', 'research decision creates a stable linked shared report');
    A.eq((await j('POST', '/api/product-projects/research-decision', researchDecisionSpec)).status, 200, 'same product research decision is idempotent');
    const productionSpec = { projectId: 'http-idea-lab', planId: 'http-v1', productSpecification: 'Fixture printable specification', deliverables: ['US Letter PDF', 'A4 PDF'], qaChecklist: ['No clipped text', 'Legible at actual size'], constraints: ['Original assets only'] };
    const productionPlan = await j('POST', '/api/product-projects/production-plan', productionSpec);
    A.eq(productionPlan.status, 201, 'planned project creates a bounded production plan');
    A.eq(productionPlan.body.project.status, 'production', 'production plan advances project to production without publishing');
    A.eq(productionPlan.body.children.map(x => x.assignedRoleId), ['business.product_designer', 'business.product_designer', 'operations.quality_reviewer'], 'production work routes to product and QA specialists');
    A.eq(productionPlan.body.children[2].dependsOnObjectiveIds, [productionPlan.body.children[1].id], 'HTTP QA waits for deliverable preparation');
    A.eq(productionPlan.body.project.spendingAuthorityUsd, 0, 'production planning preserves zero spending authority');
    A.eq((await j('POST', '/api/product-projects/production-plan', productionSpec)).status, 200, 'same production plan is idempotent');
    await j('POST', '/api/objectives/status', { id: productionPlan.body.children[2].id, status: 'completed', completionEvidenceRefs: ['deliverable:http-product-artifact', 'report:product-production-plan:http-idea-lab:http-v1'] });
    const qaSpec = { projectId: 'http-idea-lab', qaObjectiveId: productionPlan.body.children[2].id, outcome: 'passed', artifactIds: ['http-product-artifact'], deliverableEvidence: productionSpec.deliverables.map(deliverable => ({ deliverable, artifactId: 'http-product-artifact' })), reportIds: ['product-production-plan:http-idea-lab:http-v1'], checks: ['No clipped text', 'Legible at actual size'], listingDraft: { title: 'HTTP Idea Lab Printable', description: 'A bounded fixture listing draft that is not published.', tags: ['trail printable'], seoKeywords: ['trail planning printable'], targetMarketplaces: ['Marketplace A'] } };
    const qaFinal = await j('POST', '/api/product-projects/qa', qaSpec);
    A.eq(qaFinal.status, 201, 'completed QA with verified artifact/report evidence finalizes through HTTP');
    A.eq(qaFinal.body.project.status, 'listing_ready', 'passed QA reaches internal listing readiness');
    A.eq(qaFinal.body.project.listingState, 'ready', 'listing readiness is explicit');
    A.eq(qaFinal.body.project.publicationState, 'not_published', 'QA and listing preparation do not publish');
    A.eq(qaFinal.body.project.listingDraft.seoKeywords, ['trail planning printable'], 'bounded SEO metadata persists');
    A.eq((await j('POST', '/api/product-projects/qa', qaSpec)).status, 200, 'same QA finalization is idempotent');
    const publicationRequestSpec = { projectId: 'http-idea-lab', requestId: 'marketplace-a-v1', qaReportId: qaFinal.body.report.id, rationale: 'Reviewed fixture request only.', targetMarketplaces: ['Marketplace A'] };
    const publicationRequest = await j('POST', '/api/product-projects/publication-approval-request', publicationRequestSpec);
    A.eq(publicationRequest.status, 201, 'listing-ready evidence creates a protected publication approval request');
    A.eq(publicationRequest.body.objective.status, 'approval_required', 'publication request remains stopped for Commander approval');
    A.eq(publicationRequest.body.publicationPerformed, false, 'publication request performs no publication');
    A.eq(publicationRequest.body.project.status, 'approval_required', 'project truthfully waits at the approval boundary');
    A.eq((await j('POST', '/api/product-projects/publication-approval-request', publicationRequestSpec)).status, 200, 'same publication approval request is idempotent');
    A.eq((await j('POST', '/api/product-projects/update', { id: 'http-idea-lab', patch: { status: 'published' } })).status, 400, 'listing-ready project still cannot publish through safe update API');
    const withdrawalSpec = { projectId: 'http-idea-lab', requestId: 'marketplace-a-v1', reason: 'Fixture copy needs revision' }, withdrawal = await j('POST', '/api/product-projects/publication-approval-withdrawal', withdrawalSpec);
    A.eq(withdrawal.status, 201, 'authenticated pending publication request can be withdrawn');
    A.eq(withdrawal.body.objective.status, 'cancelled', 'withdrawal cancels the protected objective');
    A.eq(withdrawal.body.objective.approvalState, 'withdrawn', 'withdrawal records truthful approval state');
    A.eq(withdrawal.body.project.status, 'listing_ready', 'withdrawal restores listing-ready project state');
    A.eq(withdrawal.body.project.publicationState, 'not_published', 'withdrawal clears the waiting-publication projection');
    A.eq(withdrawal.body.publicationPerformed, false, 'withdrawal performs no external publication');
    A.eq((await j('POST', '/api/product-projects/publication-approval-withdrawal', withdrawalSpec)).status, 200, 'same withdrawal is idempotent');
    A.eq((await j('POST', '/api/product-projects/publication-approval-request', publicationRequestSpec)).status, 400, 'withdrawn stable request identity cannot reactivate cancelled approval work');
    const revisedPublicationRequest = await j('POST', '/api/product-projects/publication-approval-request', Object.assign({}, publicationRequestSpec, { requestId: 'marketplace-a-v2', rationale: 'Fixture copy revised for a new review.' }));
    A.eq(revisedPublicationRequest.status, 201, 'revised publication review uses a new stable request identity');
    A.eq(revisedPublicationRequest.body.objective.status, 'approval_required', 'revised request creates new stopped protected work');
    A.eq(revisedPublicationRequest.body.project.status, 'approval_required', 'revised request truthfully returns project to approval boundary');
    A.eq(revisedPublicationRequest.body.publicationPerformed, false, 'revised request performs no external publication');
    const commerceSpec = { recordId: 'http-marketplace-draft', projectId: 'http-idea-lab', marketplace: 'Marketplace A', state: 'draft', externalListingId: 'draft-42' };
    const commerceWrite = await j('POST', '/api/business/commerce-records', commerceSpec);
    A.eq(commerceWrite.status, 201, 'commerce reference is durably recorded');
    A.eq(commerceWrite.body.record.recordsExternalAction, false, 'commerce API does not perform publication');
    A.eq(commerceWrite.body.record.spendingAuthorityUsd, 0, 'commerce API grants no spending authority');
    A.eq((await j('POST', '/api/business/commerce-records', commerceSpec)).status, 200, 'commerce retry is idempotent');
    A.eq((await j('POST', '/api/business/commerce-records', { projectId: 'http-idea-lab', marketplace: 'Marketplace A', state: 'observed_published' })).status, 400, 'publication observations require evidence');
    A.eq((await j('GET', '/api/business/commerce-records?projectId=http-idea-lab')).body.records.length, 1, 'commerce references are readable by product project');
    const businessAt = Date.now(), revenueSpec = { entryId: 'http-sale-1', type: 'revenue', amountUsd: 14.5, projectId: 'http-idea-lab', source: 'fixture marketplace export', evidenceRefs: ['fixture:export-row-1'], occurredAt: businessAt };
    const revenueWrite = await j('POST', '/api/business/ledger', revenueSpec);
    A.eq(revenueWrite.status, 201, 'evidenced revenue is durably recorded');
    A.eq(revenueWrite.body.entry.recordsExternalAction, false, 'business ledger does not initiate payments');
    A.eq((await j('POST', '/api/business/ledger', revenueSpec)).status, 200, 'business ledger retry is idempotent');
    A.eq((await j('POST', '/api/business/ledger', { type: 'expense', amountUsd: 3, occurredAt: businessAt })).status, 400, 'business ledger rejects unevidenced amounts');
    await j('POST', '/api/business/ledger', { entryId: 'http-fee-1', type: 'expense', amountUsd: 2.5, projectId: 'http-idea-lab', source: 'fixture receipt', evidenceRefs: ['fixture:receipt-1'], occurredAt: businessAt });
    const businessRead = await j('GET', '/api/business/ledger?projectId=http-idea-lab&periodStart=' + (businessAt - 1) + '&periodEnd=' + (businessAt + 1));
    A.eq(businessRead.body.summary.netUsd, 12, 'business ledger exposes a truthful evidenced net total');
    A.eq(businessRead.body.entries.length, 2, 'business ledger retains both source entries');
    const businessBrief = await j('POST', '/api/reports/morning-brief', { id: 'morning:http-business', periodStart: businessAt - 1, periodEnd: businessAt + 1 });
    A.ok(businessBrief.body.report.decisions.some(x => /\$14\.50 revenue/.test(x) && /net \$12\.00/.test(x)), 'Morning Brief integrates recorded business totals');
    A.ok(businessBrief.body.report.sourceRefs.includes('business-entry:http-sale-1'), 'Morning Brief retains business entry provenance');
    const growthPlanSpec = { projectId: 'http-idea-lab', experimentId: 'title-clarity', hypothesis: 'A clearer benefit title improves qualified interest.', metric: 'qualified-interest-rate', direction: 'increase', baselineValue: 0.1, targetValue: 0.15, method: 'Analyze user-supplied reviewed observations.', evidenceRefs: ['report:product-qa:http-idea-lab'] };
    const growthPlan = await j('POST', '/api/business/growth-experiments', growthPlanSpec);
    A.eq(growthPlan.status, 201, 'listing-ready product creates a bounded growth experiment');
    A.eq(growthPlan.body.objective.assignedRoleId, 'business.growth_analyst', 'growth experiment routes to the Growth Analyst specialist');
    A.eq(growthPlan.body.objective.maxModelTier, 'economy', 'growth analysis uses economy tier');
    A.eq(growthPlan.body.externalAction, false, 'growth planning does not advertise, publish, or contact anyone');
    A.eq(growthPlan.body.spendingAuthorityUsd, 0, 'growth planning grants no advertising spend');
    A.eq((await j('POST', '/api/business/growth-experiments', growthPlanSpec)).status, 200, 'growth plan retry is idempotent');
    A.eq((await j('POST', '/api/business/growth-experiments/result', { projectId: 'http-idea-lab', experimentId: 'title-clarity', objectiveId: growthPlan.body.objective.id, observedValue: .16, sampleSize: 20, outcome: 'supported', evidenceRefs: ['fixture:growth-observations'] })).status, 400, 'growth outcome waits for completed specialist work');
    await j('POST', '/api/objectives/status', { id: growthPlan.body.objective.id, status: 'completed', completionEvidenceRefs: ['fixture:growth-observations'] });
    const growthAt = Date.now(), growthResultSpec = { projectId: 'http-idea-lab', experimentId: 'title-clarity', objectiveId: growthPlan.body.objective.id, observedValue: .16, sampleSize: 20, outcome: 'supported', interpretation: 'Observed value exceeded the target.', evidenceRefs: ['fixture:growth-observations'] };
    const growthResult = await j('POST', '/api/business/growth-experiments/result', growthResultSpec);
    A.eq(growthResult.status, 201, 'completed evidenced growth work creates a result');
    A.eq(growthResult.body.externalAction, false, 'recording a growth result does not scale or execute it');
    A.eq((await j('POST', '/api/business/growth-experiments/result', growthResultSpec)).status, 200, 'growth result retry is idempotent');
    const growthBrief = await j('POST', '/api/reports/morning-brief', { id: 'morning:http-growth', periodStart: growthAt - 1, periodEnd: growthAt + 1000 });
    A.ok(growthBrief.body.report.decisions.some(x => /^SUPPORTED:/.test(x)), 'Business Morning Brief includes the evidenced growth outcome');
    A.ok(growthBrief.body.report.sourceRefs.includes('report:growth-experiment-result:http-idea-lab:title-clarity'), 'Business Morning Brief links the growth result report');
    A.ok(growthBrief.body.report.decisions.some(x => /^Product pipeline:/.test(x) && /listing-ready/.test(x)), 'Business Morning Brief includes current product pipeline counts');
    A.ok(growthBrief.body.report.sourceRefs.includes('product-project:http-idea-lab'), 'Business Morning Brief retains product-project provenance');
    const recurringSpec = { scheduleId: 'http-daily-scout', roleId: 'operations.open_source_scout', recurrence: '0 9 * * *', timezone: 'America/New_York', enabled: false,
      template: { workflow: 'open-source-scout', scout: { topic: 'Windows developer utilities', recommendationLimit: 3, compatibilityTarget: 'Windows 11' } } };
    const recurringCreate = await j('POST', '/api/objectives/recurring', recurringSpec);
    A.eq(recurringCreate.status, 201, 'POST /api/objectives/recurring -> 201');
    A.eq(recurringCreate.body.schedule.enabled, false, 'recurring objective can be created disabled without execution');
    A.eq(recurringCreate.body.schedule.roleId, 'operations.open_source_scout', 'recurring Scout preserves owning role');
    A.eq((await j('POST', '/api/objectives/recurring', recurringSpec)).status, 200, 'same recurring definition is idempotent');
    const recurringConflict = await j('POST', '/api/objectives/recurring', Object.assign({}, recurringSpec, { recurrence: '0 10 * * *' }));
    A.eq(recurringConflict.status, 409, 'same schedule identity cannot silently change definition');
    A.eq((await j('POST', '/api/objectives/recurring/status', { scheduleId: 'http-daily-scout', enabled: true })).status, 400, 'enable fails closed without an approved runtime-role binding');
    const recurringRoster = await j('POST', '/api/roster', { agents: [{ agentId: 'scout_runtime', name: 'Scout Runtime', role: 'research', system: 'Research only.', model: 'fixture/model', provider: 'openrouter', systemRoleIds: ['operations.open_source_scout'] }] });
    A.eq(recurringRoster.status, 200, 'test roster binds one approved runtime identity');
    const recurringEnabled = await j('POST', '/api/objectives/recurring/status', { scheduleId: 'http-daily-scout', enabled: true });
    A.eq(recurringEnabled.status, 200, 'recurring objective enables through existing cron state');
    A.eq(recurringEnabled.body.schedule.enabled, true, 'enabled recurring objective exposes next-run state');
    A.ok(recurringEnabled.body.schedule.nextRunAt, 'enabled recurring objective has scheduler-owned nextRunAt');
    const recurringList = await j('GET', '/api/objectives/recurring');
    A.ok(recurringList.body.schedules.some(x => x.scheduleId === 'http-daily-scout'), 'recurring definition is inspectable from existing cron records');
    A.eq((await j('POST', '/api/objectives/recurring/status', { scheduleId: 'http-daily-scout', enabled: false })).body.schedule.enabled, false, 'recurring objective can be disabled through cron pause');
    const coordinator = await j('POST', '/api/objectives/intake', { title: 'Coordinate research and implementation' });
    A.eq(coordinator.status, 201, 'POST /api/objectives/intake -> 201');
    A.eq(coordinator.body.objective.assignedRoleId, 'operations.coordinator', 'deterministic intake routes explicit coordination to the system role');
    const decomposition = await j('POST', '/api/objectives/decompose', { id: coordinator.body.objective.id, decompositionId: 'http-plan-1', children: [
      { title: 'Research the source', maxModelTier: 'economy' }, { title: 'Implement the code', dependsOn: [0] }
    ] });
    A.eq(decomposition.status, 201, 'POST /api/objectives/decompose -> 201');
    A.eq(decomposition.body.children.length, 2, 'atomic decomposition creates bounded durable children');
    A.eq(decomposition.body.children[1].dependsOnObjectiveIds, [decomposition.body.children[0].id], 'HTTP decomposition preserves dependency ordering');
    const decompositionRetry = await j('POST', '/api/objectives/decompose', { id: coordinator.body.objective.id, decompositionId: 'http-plan-1', children: [
      { title: 'Research the source', maxModelTier: 'economy' }, { title: 'Implement the code', dependsOn: [0] }
    ] });
    A.eq(decompositionRetry.status, 200, 'decomposition retry is idempotent');
    const coordinatorRead = await j('GET', '/api/objectives?limit=10');
    A.ok(coordinatorRead.body.objectives.some(x => x.id === coordinator.body.objective.id && x.decomposition.childIds.length === 2), 'parent/child relationships survive authenticated read-after-write');

    // ---- (2) GET /api/quests — the ledger read ----
    const quests0 = await j('GET', '/api/quests');
    A.eq(quests0.status, 200, 'GET /api/quests -> 200');
    A.eq(quests0.body.ok, true, 'quests route reports ok:true');
    A.ok(Array.isArray(quests0.body.quests), 'quests route returns a quests array');

    // ---- (3) POST /api/quests/mint — happy path mints an id; bad JSON -> 400 ----
    const mint = await j('POST', '/api/quests/mint', { title: 'HTTP coverage quest', contract: { type: 'artifact', key: 'coverage.txt' }, desc: 'seeded by the routes coverage test', steps: [{ key: 's1', label: 'do the thing' }] });
    A.eq(mint.status, 200, 'POST /api/quests/mint (valid title+contract) -> 200');
    A.eq(mint.body.ok, true, 'mint reports ok:true');
    A.ok(mint.body.id && typeof mint.body.id === 'string', 'mint returns the new quest id');
    const questId = mint.body.id;
    const mintBad = await fetch(B + '/api/quests/mint', { method: 'POST', headers: { 'X-StarNet-Token': apiToken, Origin: B }, body: '{not json' });
    A.eq(mintBad.status, 400, 'POST /api/quests/mint with malformed JSON -> 400');
    // the minted quest is now visible in the ledger read (the store round-trip is real)
    const quests1 = await j('GET', '/api/quests');
    A.ok(quests1.body.quests.some(q => q && q.id === questId), 'the minted quest appears in GET /api/quests');

    // ---- (4) POST /api/quests/update — happy tick; missing id -> 400; unknown op -> 400 ----
    const upd = await j('POST', '/api/quests/update', { id: questId, op: 'tick' });
    A.eq(upd.status, 200, 'POST /api/quests/update {op:tick} -> 200');
    A.eq(typeof upd.body.ok, 'boolean', 'update returns an ok boolean');
    const updNoId = await j('POST', '/api/quests/update', { op: 'tick' });
    A.eq(updNoId.status, 400, 'POST /api/quests/update without an id -> 400');
    A.eq(updNoId.body.error, 'which quest?', 'update names the missing id honestly');
    const updBadOp = await j('POST', '/api/quests/update', { id: questId, op: 'nonsense' });
    A.eq(updBadOp.status, 400, 'POST /api/quests/update with an unknown op -> 400');
    A.eq(updBadOp.body.error, 'unknown op', 'update rejects an unknown op by name');

    // ---- (5) POST /api/quests/confirm — happy verdict; missing id -> 400 ----
    const conf = await j('POST', '/api/quests/confirm', { id: questId, ok: true, note: 'coverage confirm' });
    A.eq(conf.status, 200, 'POST /api/quests/confirm {ok:true} -> 200');
    A.eq(typeof conf.body.ok, 'boolean', 'confirm returns an ok boolean (whether a verdict was recorded)');
    const confNoId = await j('POST', '/api/quests/confirm', { ok: true });
    A.eq(confNoId.status, 400, 'POST /api/quests/confirm without an id -> 400');

    // ---- (6) POST /api/quests/dismiss — happy path (removes the seeded quest); missing id -> 400 ----
    const dismNoId = await j('POST', '/api/quests/dismiss', {});
    A.eq(dismNoId.status, 400, 'POST /api/quests/dismiss without an id -> 400');
    const dism = await j('POST', '/api/quests/dismiss', { id: questId });
    A.eq(dism.status, 200, 'POST /api/quests/dismiss {id} -> 200');
    A.eq(typeof dism.body.ok, 'boolean', 'dismiss returns an ok boolean');

    // ---- Commander journey: durable metric round-trip + honest invalid operation ----
    const journey0 = await j('GET', '/api/journey');
    A.eq(journey0.status, 200, 'GET /api/journey -> 200');
    A.eq(journey0.body.journey.evolution.goalsReached, 0, 'fresh journey makes no progress claim');
    const metric = await j('POST', '/api/journey', { op: 'metric.create', goalId: 'goal:http', label: 'Paying users', baseline: 0, target: 10, unit: 'users' });
    A.eq(metric.status, 200, 'POST /api/journey metric.create -> 200');
    A.ok(metric.body.ok && metric.body.metric.id, 'metric.create returns the durable metric id');
    const metricReached = await j('POST', '/api/journey', { op: 'metric.update', id: metric.body.metric.id, current: 10, note: 'Commander checked billing' });
    A.eq(metricReached.status, 200, 'POST /api/journey metric.update -> 200');
    A.eq(metricReached.body.journey.evolution.goalsReached, 0, 'reaching one metric cannot overclaim the whole life goal');
    A.eq(metricReached.body.journey.outcomes[0].kind, 'metric', 'reached metric still lands as a provenance-bearing outcome');
    const journey1 = await j('GET', '/api/journey');
    A.eq(journey1.body.journey.metrics[0].current, 10, 'journey metric survives a real HTTP read-after-write');
    const journeyBad = await j('POST', '/api/journey', { op: 'invent.level' });
    A.eq(journeyBad.status, 400, 'unknown journey operation -> 400');
    const journeyReset = await j('POST', '/api/journey', { op: 'journey.reset', epoch: 2 });
    A.eq(journeyReset.status, 200, 'journey reset advances to a new Commander generation');
    const staleJourney = await j('POST', '/api/journey', { op: 'metric.create', epoch: 1, label: 'Stale tab metric', baseline: 0, target: 1 });
    A.eq(staleJourney.status, 409, 'a stale Commander generation cannot mutate the new journey');
    const currentJourney = await j('POST', '/api/journey', { op: 'metric.create', epoch: 2, label: 'Current tab metric', baseline: 0, target: 1 });
    A.eq(currentJourney.status, 200, 'the active Commander generation can mutate its journey');

    // ---- (7) POST /api/activity — arrival IS the signal; always 200 with the recorded timestamp ----
    const before = Date.now();
    const act = await j('POST', '/api/activity', {});
    A.eq(act.status, 200, 'POST /api/activity -> 200');
    A.eq(act.body.ok, true, 'activity reports ok:true');
    A.ok(typeof act.body.at === 'number' && act.body.at >= before - 1000, 'activity returns the recorded lastUserActivityAt (a real number, not a guess)');

    // ---- (8) POST /api/dev/inbound — dev-gated: on a NON-dev boot the route 404s (the gate holds) ----
    const devInbound = await j('POST', '/api/dev/inbound', { text: 'ping' });
    A.eq(devInbound.status, 404, 'POST /api/dev/inbound on a non-dev boot -> 404 (STARNET_DEV gate holds)');
    A.eq(devInbound.body.error, 'not found', 'the dev-gate 404 is honest');

    // ---- (9) POST /api/workshop/remove — no-such-idea -> 404; bad agentId -> 400 ----
    const rmBadAgent = await j('POST', '/api/workshop/remove', { agentId: 'bad agent!', backlogId: 'x' });
    A.eq(rmBadAgent.status, 400, 'POST /api/workshop/remove with an invalid agentId -> 400');
    A.eq(rmBadAgent.body.error, 'choose a valid agent', 'workshop/remove validates the agent id by name');
    const rmMissing = await j('POST', '/api/workshop/remove', { agentId: 'agent', backlogId: 'no-such-idea-xyz' });
    A.eq(rmMissing.status, 404, 'POST /api/workshop/remove for an unknown idea -> 404');
    A.eq(rmMissing.body.ok, false, 'workshop/remove reports ok:false when nothing was removed');

    // ---- (10) GET /api/auth/codex/status — offline-truthful status, never a token ----
    const codex = await j('GET', '/api/auth/codex/status');
    A.eq(codex.status, 200, 'GET /api/auth/codex/status -> 200');
    A.eq(typeof codex.body.connected, 'boolean', 'codex status reports a connected boolean');
    A.ok(JSON.stringify(codex.body).indexOf('sk-') < 0, 'codex status leaks no key-shaped secret');

    // ---- (11) GET /api/channels/telegram/status — configured/connected truth, no token echoed ----
    const tg = await j('GET', '/api/channels/telegram/status');
    A.eq(tg.status, 200, 'GET /api/channels/telegram/status -> 200');
    A.eq(tg.body.configured, false, 'unconfigured telegram reports configured:false');
    A.eq(typeof tg.body.connected, 'boolean', 'telegram status reports a connected boolean');
    A.ok(typeof tg.body.state === 'string', 'telegram status reports a transport state string');

    // ---- (12) GET /api/execution — the execution-environment descriptor ----
    const exec = await j('GET', '/api/execution');
    A.eq(exec.status, 200, 'GET /api/execution -> 200');
    A.ok(exec.body && typeof exec.body === 'object' && !Array.isArray(exec.body), 'execution returns a descriptor object');

    // ---- (13) GET /api/fallback/chain — the model fallback chain readout ----
    const fb = await j('GET', '/api/fallback/chain');
    A.eq(fb.status, 200, 'GET /api/fallback/chain -> 200');
    A.ok(Array.isArray(fb.body.chain), 'fallback chain returns a chain array');
    A.eq(typeof fb.body.saved, 'boolean', 'fallback chain reports whether a saved override exists');
    A.ok(Array.isArray(fb.body.envDefault), 'fallback chain exposes the env default chain');
    A.eq(typeof fb.body.maxEntries, 'number', 'fallback chain exposes maxEntries');

    // ---- (14) GET /api/fs/dirstat — honest-in-body: non-absolute vs a real dir (the workspace itself) ----
    const dsRel = await j('GET', '/api/fs/dirstat?path=' + encodeURIComponent('not/absolute'));
    A.eq(dsRel.status, 200, 'GET /api/fs/dirstat (non-absolute) -> 200 (honest-fail in the body, never a 5xx)');
    A.eq(dsRel.body.exists, false, 'a non-absolute path is reported not-existing');
    A.eq(dsRel.body.reason, 'not-absolute', 'the reason names the non-absolute path');
    const dsReal = await j('GET', '/api/fs/dirstat?path=' + encodeURIComponent(ws));
    A.eq(dsReal.status, 200, 'GET /api/fs/dirstat (a real dir inside WORKSPACES) -> 200');
    A.eq(dsReal.body.exists, true, 'the workspace dir is reported existing');
    A.eq(dsReal.body.isDir, true, 'the workspace dir is reported as a directory');

    // ---- (15) GET /api/spotify/status — connection truth, never a token ----
    const sp = await j('GET', '/api/spotify/status');
    A.eq(sp.status, 200, 'GET /api/spotify/status -> 200');
    A.eq(typeof sp.body.connected, 'boolean', 'spotify status reports a connected boolean');
    A.eq(sp.body.connected, false, 'unconfigured spotify is not connected');
    A.ok(JSON.stringify(sp.body).indexOf('sk-') < 0 && JSON.stringify(sp.body).indexOf('Bearer') < 0, 'spotify status leaks no token');

    // ---- (16) GET /api/study/proposals — happy readout; a bad agent id is forbidden ----
    const study = await j('GET', '/api/study/proposals?agent=agent&run=nope');
    A.eq(study.status, 200, 'GET /api/study/proposals -> 200');
    A.ok(Array.isArray(study.body.proposals), 'study proposals returns a proposals array (empty on a fresh workspace)');
    const studyBad = await fetch(B + '/api/study/proposals?agent=' + encodeURIComponent('../evil'), { headers: { 'X-StarNet-Token': apiToken, Origin: B } });
    A.eq(studyBad.status, 403, 'GET /api/study/proposals with a jail-escape agent id -> 403');

    // ---- (17) GET /api/toolsets — the placeable-capability catalog ----
    const ts = await j('GET', '/api/toolsets');
    A.eq(ts.status, 200, 'GET /api/toolsets -> 200');
    A.ok(Array.isArray(ts.body.toolsets) && ts.body.toolsets.length > 0, 'toolsets returns a non-empty catalog');
    A.ok(ts.body.toolsets.every(t => t && typeof t.id === 'string' && typeof t.enabled === 'boolean'), 'every toolset row carries an id + enabled flag');

    // ---- (18) GET /api/widgets — the agent-fed widget readouts ----
    const wid = await j('GET', '/api/widgets');
    A.eq(wid.status, 200, 'GET /api/widgets -> 200');
    A.ok(wid.body && Object.prototype.hasOwnProperty.call(wid.body, 'widgets'), 'widgets route returns a {widgets} payload');

    // ---- (19) GET /api/workspace/dir — jailed abs path; a jail-escape agent id is forbidden ----
    const wdir = await j('GET', '/api/workspace/dir?agent=agent');
    A.eq(wdir.status, 200, 'GET /api/workspace/dir?agent=agent -> 200');
    A.ok(typeof wdir.body.dir === 'string' && wdir.body.dir.length > 0, 'workspace/dir returns an absolute jailed path');
    A.ok(wdir.body.dir.indexOf(ws) >= 0, 'the returned dir is jailed under the WORKSPACES root');
    const wdirEscape = await fetch(B + '/api/workspace/dir?agent=' + encodeURIComponent('../../etc'), { headers: { 'X-StarNet-Token': apiToken, Origin: B } });
    A.eq(wdirEscape.status, 403, 'GET /api/workspace/dir with a jail-escape agent id -> 403');

  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('routes-coverage.http.test');
})().catch(e => { console.log('FAIL: routes-coverage.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
