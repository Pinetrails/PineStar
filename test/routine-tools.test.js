/* node test/routine-tools.test.js -- agent-facing StarNet ROUTINES tools.
   Locks the bugfix for "cron" requests: the lead gets a real routine.create tool, it routes research/news
   routines to a research specialist, writes through the injected cron creator, and arms the scheduler by default. */
'use strict';
const A = require('./_assert.js');
const { makeRoutineTools } = require('../sidecar/tools/builtin/routines.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');

const call = (name, args) => ({ id: 'c1', name, args: args || {}, argsRaw: JSON.stringify(args || {}), parseError: null });

(async () => {
  const roster = new Map([
    ['agent', { name: 'Commander Lead', role: 'orchestrator' }],
    ['researcher-2', { name: 'Research Agent', role: 'researcher', purpose: 'web research and source synthesis' }],
    ['scribe-1', { name: 'Scribe', role: 'scribe' }]
  ]);
  let jobs = [];
  let createdSpec = null;
  let armed = false;

  const tools = makeRoutineTools({
    roster: () => roster,
    listJobs: () => jobs,
    schedulerState: () => armed,
    normalizeProvider: (p) => p === 'codex' || p === 'openrouter' ? p : '',
    armScheduler: (enabled) => { armed = enabled === true; return armed; },
    createRoutine: (spec) => {
      createdSpec = spec;
      const job = {
        id: 'job_1',
        name: spec.name,
        prompt: spec.prompt,
        agentId: spec.agentId,
        provider: spec.provider,
        model: spec.model,
        scheduleDisplay: 'cron ' + spec.schedule,
        enabled: spec.enabled !== false,
        state: spec.enabled === false ? 'paused' : 'scheduled',
        nextRunAt: '2026-06-29T13:00:00.000Z',
        lastRunAt: null,
        lastStatus: null
      };
      jobs = jobs.concat([job]);
      return job;
    }
  });

  // ---- create: research/news/latest routes to the research specialist and arms by default ----
  {
    const out = await tools.createTool.run({
      name: 'Daily AI news brief',
      prompt: 'Research the latest AI related news, cite sources, and summarize the top items.',
      schedule: '0 9 * * *',
      provider: 'codex'
    }, { agentId: 'agent' });
    A.eq(createdSpec.agentId, 'researcher-2', 'research/news/latest routine auto-routes to the research specialist');
    A.eq(createdSpec.provider, 'codex', 'provider is normalized and stored');
    A.eq(armed, true, 'routine.create arms the scheduler by default so the job will actually fire');
    const body = JSON.parse(out.content);
    A.eq(body.routedTo, 'researcher-2', 'tool result reports the routed agent');
    A.eq(body.schedulerArmed, true, 'tool result reports the scheduler armed state');
    A.eq(body.job.id, 'job_1', 'tool result carries the created routine');
  }

  // ---- list: reads the same server-owned job snapshot shape the ROUTINES panel renders ----
  {
    const out = await tools.listTool.run({}, { agentId: 'agent' });
    const body = JSON.parse(out.content);
    A.eq(body.jobs.length, 1, 'routine.list returns created routines');
    A.eq(body.jobs[0].agentId, 'researcher-2', 'routine.list includes the target agent');
    A.eq(body.schedulerArmed, true, 'routine.list includes scheduler armed state');
  }

  // ---- explicit unknown agent is rejected instead of silently scheduling a ghost routine ----
  {
    let threw = false;
    try {
      await tools.createTool.run({ prompt: 'x', schedule: 'every 1h', agentId: 'ghost' }, { agentId: 'agent' });
    } catch (e) {
      threw = /unknown routine agentId/.test(String(e && e.message));
    }
    A.ok(threw, 'unknown explicit agentId is rejected');
  }

  // ---- registry: routine.create is capability- and consent-gated ----
  {
    let created = 0;
    const reg = makeRegistry();
    makeRoutineTools({
      roster: () => roster,
      createRoutine: () => { created++; return { id: 'job_x', name: 'x', agentId: 'agent', enabled: true, state: 'scheduled' }; }
    }).register(reg);

    const noGrant = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: [], approvalRules: {} }, { emit: () => {} });
    const deniedCap = await reg.dispatch(call('routine.create', { prompt: 'x', schedule: 'every 1h' }), noGrant);
    A.ok(deniedCap.isError && /capability denied/.test(deniedCap.content), 'routine.create denied without orchestrator grant');
    A.eq(created, 0, 'capability denial does not create a routine');

    const grant = { agentId: 'agent', room: 'office', hasCompute: true, tools: ['routine.create'], approvalRules: {} };
    const deniedConsent = await reg.dispatch(call('routine.create', { prompt: 'x', schedule: 'every 1h' }),
      makeCapCtx(grant, { emit: () => {}, consent: async () => ({ allow: false, reason: 'no' }) }));
    A.ok(deniedConsent.isError && /consent denied/.test(deniedConsent.content), 'routine.create asks consent before persisting');
    A.eq(created, 0, 'consent denial does not create a routine');

    const allowed = await reg.dispatch(call('routine.create', { prompt: 'x', schedule: 'every 1h' }),
      makeCapCtx(grant, { emit: () => {}, consent: async () => ({ allow: true }) }));
    A.ok(!allowed.isError, 'routine.create runs when granted and approved');
    A.eq(created, 1, 'approved routine.create reaches the creator');
  }

  A.report('routine-tools');
})().catch(e => { console.log('FAIL: routine-tools threw -- ' + (e && e.stack || e)); process.exit(1); });
