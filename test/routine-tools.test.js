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

  // ---- W6 mint gate: a duplicate returns the existing job + anti-retry, does NOT arm, no second store entry ----
  {
    let createCalls = 0, armCalls = 0;
    const existing = { id: 'job_dup', name: 'ULTRON daily operating loop', agentId: 'agent', enabled: true, state: 'scheduled' };
    const dupTools = makeRoutineTools({
      roster: () => roster,
      listJobs: () => [existing],
      schedulerState: () => false,
      // the host's createRoutine ran its mint gate and refused — it hands back the EXISTING job flagged _duplicate.
      createRoutine: (spec) => { createCalls++; return Object.assign({}, existing, { _duplicate: true }); },
      armScheduler: () => { armCalls++; return true; },
      mintSummary: () => 'You already maintain these routines — do not recreate them: ULTRON daily operating loop.'
    });
    const out = await dupTools.createTool.run({
      name: 'ULTRON daily operating loop', prompt: 'run the loop', schedule: 'every 6h', agentId: 'agent'
    }, { agentId: 'agent' });
    const body = JSON.parse(out.content);
    A.eq(body.duplicate, true, 'duplicate flagged in the tool response');
    A.eq(body.message, 'this routine already exists — do not recreate it', 'plain anti-retry message returned');
    A.eq(body.job.id, 'job_dup', 'the EXISTING job is returned (not a new one)');
    A.eq(armCalls, 0, 'a duplicate create does NOT arm the scheduler (nothing new happened)');
    A.eq(createCalls, 1, 'the gate ran once (via createRoutine) and refused — no retry loop');
  }

  // ---- W6 mint gate: a DECLINED (previously-deleted) name is refused with the anti-retry line, never resurrected ----
  {
    const decTools = makeRoutineTools({
      roster: () => roster,
      listJobs: () => [],
      schedulerState: () => false,
      createRoutine: (spec) => ({ _declined: true, name: spec.name }),
      armScheduler: () => true
    });
    const out = await decTools.createTool.run({
      name: 'ULTRON daily operating loop', prompt: 'run the loop', schedule: 'every 6h', agentId: 'agent'
    }, { agentId: 'agent' });
    const body = JSON.parse(out.content);
    A.eq(body.ok, false, 'a declined creation is not ok');
    A.eq(body.declined, true, 'declined flagged in the tool response');
    A.eq(body.message, 'this routine already exists — do not recreate it', 'anti-retry line for a resurrected name');
  }

  // ---- W6 ledger summary: a fresh (non-dup) create folds the "you already maintain: …" reminder into its result ----
  {
    let armed2 = false;
    const sumTools = makeRoutineTools({
      roster: () => roster,
      listJobs: () => [],
      schedulerState: () => armed2,
      createRoutine: (spec) => ({ id: 'job_ok', name: spec.name, agentId: spec.agentId, enabled: true, state: 'scheduled' }),
      armScheduler: (e) => { armed2 = e === true; return armed2; },
      mintSummary: () => 'You already maintain these routines — do not recreate them: Morning market brief.'
    });
    const out = await sumTools.createTool.run({
      name: 'Quarterly planning digest', prompt: 'draft the quarterly plan', schedule: 'every 24h', agentId: 'agent'
    }, { agentId: 'agent' });
    const body = JSON.parse(out.content);
    A.eq(body.job.id, 'job_ok', 'a genuinely new routine is created');
    A.ok(body.maintains && body.maintains.indexOf('Morning market brief') >= 0, 'the ledger summary rides the create response');
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

  /* ---- routine.manage: the four store verbs + reference resolution --------------------------------------
     The gap this closes: routine.create/list shipped, so an agent could MAKE standing autonomous work and
     never touch it again — no edit, no pause, no delete, no "fire it now". */
  {
    const mjobs = [
      { id: 'j-morning', name: 'Morning market brief', agentId: 'researcher-2', enabled: true, state: 'scheduled', scheduleDisplay: 'cron 0 9 * * *' },
      { id: 'j-evening', name: 'Evening market brief', agentId: 'researcher-2', enabled: true, state: 'scheduled', scheduleDisplay: 'cron 0 18 * * *' },
      { id: 'j-backup', name: 'Weekly backup', agentId: 'agent', enabled: false, state: 'paused', scheduleDisplay: 'cron 0 3 * * 0' }
    ];
    const log = [];
    const find = (id) => mjobs.find(j => j.id === id);
    const mt = makeRoutineTools({
      roster: () => roster,
      listJobs: () => mjobs,
      schedulerState: () => true,
      normalizeProvider: (p) => (p === 'codex' || p === 'openrouter') ? p : '',
      updateRoutine: async (id, patch) => { log.push(['update', id, patch]); return Object.assign({}, find(id), { name: patch.name || find(id).name }); },
      removeRoutine: async (id) => { log.push(['remove', id]); return find(id); },
      setRoutineEnabled: async (id, on) => { log.push(['enabled', id, on]); return Object.assign({}, find(id), { enabled: on, state: on ? 'scheduled' : 'paused' }); },
      triggerRoutine: async (id) => { log.push(['trigger', id]); return Object.assign({}, find(id), { nextRunAt: '2026-07-27T00:00:00.000Z' }); }
    });

    // reference by EXACT id
    {
      const out = await mt.manageTool.run({ action: 'pause', id: 'j-morning' });
      A.eq(log[log.length - 1][0], 'enabled', 'pause routes to setRoutineEnabled');
      A.eq(log[log.length - 1][2], false, 'pause disables the job');
      A.eq(JSON.parse(out.content).job.state, 'paused', 'the paused job comes back paused');
    }

    // reference by UNIQUE name substring
    {
      await mt.manageTool.run({ action: 'resume', id: 'weekly backup' });
      A.eq(log[log.length - 1][1], 'j-backup', 'a unique case-insensitive name substring resolves to its job');
      A.eq(log[log.length - 1][2], true, 'resume enables the job');
    }

    // AMBIGUITY IS AN ERROR — never a guess: editing the wrong standing routine is invisible to the agent
    {
      let err = null;
      try { await mt.manageTool.run({ action: 'remove', id: 'market brief' }); } catch (e) { err = e; }
      A.ok(err && /matches 2 routines/.test(err.message), 'an ambiguous name reference is refused, not guessed');
      A.ok(err && /j-morning/.test(err.message) && /j-evening/.test(err.message), 'the refusal names the candidate ids');
      A.ok(!log.some(l => l[0] === 'remove'), 'an ambiguous reference removes nothing');
    }

    // an unmatched reference points the model at routine.list rather than failing blankly
    {
      let err = null;
      try { await mt.manageTool.run({ action: 'pause', id: 'no-such-routine' }); } catch (e) { err = e; }
      A.ok(err && /routine\.list/.test(err.message), 'an unmatched reference tells the model how to find the real ids');
    }

    // update: only whitelisted fields reach the store
    {
      const out = await mt.manageTool.run({
        action: 'update', id: 'j-morning', name: 'Morning brief v2', prompt: 'summarize markets', provider: 'codex'
      });
      const [, id, patch] = log[log.length - 1];
      A.eq(id, 'j-morning', 'update targets the resolved job');
      A.eq(patch.name, 'Morning brief v2', 'name is patchable');
      A.eq(patch.prompt, 'summarize markets', 'prompt is patchable');
      A.eq(patch.provider, 'codex', 'provider is normalized before it reaches the store');
      A.eq(JSON.parse(out.content).changed.length, 3, 'the response reports exactly what changed');
    }

    /* NEVER REPORT AN EDIT THAT DID NOT HAPPEN. Two ways the first cut lied about an update:
       (a) a timezone with no schedule — the host folds tz into the SCHEDULE parse, so a tz-only patch reached
           the store as an empty patch: nothing changed, and the tool answered "updated routine (timezone)";
       (b) a whitespace-only name — not null and not '', so it passed the raw guard, cleaned to '', and
           persisted a routine with a BLANK name while reporting "updated (name)". */
    {
      const before = log.length;
      let err = null;
      try { await mt.manageTool.run({ action: 'update', id: 'j-morning', timezone: 'America/New_York' }); } catch (e) { err = e; }
      A.ok(err && /only applies to a schedule/.test(err.message), 'a timezone with no schedule is refused, not reported as an update');
      A.eq(log.length, before, 'and no empty patch reaches the store');

      const ok = await mt.manageTool.run({ action: 'update', id: 'j-morning', schedule: '0 9 * * *', timezone: 'America/New_York' });
      A.eq(log[log.length - 1][2].timezone, 'America/New_York', 'a timezone WITH a schedule is passed through');
      A.eq(JSON.parse(ok.content).changed.sort().join(','), 'schedule,timezone', 'and both are reported as changed');
    }
    {
      const before = log.length;
      let err = null;
      try { await mt.manageTool.run({ action: 'update', id: 'j-morning', name: '   ' }); } catch (e) { err = e; }
      A.ok(err && /nothing to update/.test(err.message), 'a whitespace-only name is not an update');
      A.eq(log.length, before, 'and a blank name never reaches the store');
    }

    /* THE PRIVILEGE BOUNDARY: cron-store's updateJob accepts `unattendedGrants` — the capability families a
       routine may use with nobody watching ('workbench' = shell.exec). An agent that could patch that could
       hand its own scheduled routine a terminal it was never granted. The tool must drop it. */
    {
      const before = log.length;
      let err = null;
      try { await mt.manageTool.run({ action: 'update', id: 'j-backup', unattendedGrants: ['workbench'], script: 'evil.sh', workdir: 'C:\\' }); }
      catch (e) { err = e; }
      A.ok(err && /nothing to update/.test(err.message), 'a patch of ONLY non-whitelisted fields is refused outright');
      A.eq(log.length, before, 'no store write happens for a rejected patch');
    }
    {
      await mt.manageTool.run({ action: 'update', id: 'j-backup', name: 'Backup', unattendedGrants: ['workbench'], script: 'evil.sh' });
      const patch = log[log.length - 1][2];
      A.ok(!('unattendedGrants' in patch), 'unattendedGrants can NEVER be patched by an agent (privilege escalation)');
      A.ok(!('script' in patch), 'script can never be patched by an agent');
      A.ok(!('workdir' in patch), 'workdir can never be patched by an agent');
      A.eq(patch.name, 'Backup', 'the whitelisted field in the same call still applies');
    }

    // remove: reports what went, and marks the ledger through the host verb
    {
      const out = await mt.manageTool.run({ action: 'remove', id: 'j-evening' });
      A.eq(log[log.length - 1][0], 'remove', 'remove routes to removeRoutine');
      A.eq(JSON.parse(out.content).removed.name, 'Evening market brief', 'the response names the deleted routine');
    }

    // run_now QUEUES — it must never claim the routine ran
    {
      const out = await mt.manageTool.run({ action: 'run_now', id: 'j-morning' });
      const body = JSON.parse(out.content);
      A.eq(log[log.length - 1][0], 'trigger', 'run_now re-anchors the next fire instead of running inline');
      A.eq(body.queued, true, 'run_now reports queued');
      A.ok(/has not run yet/.test(body.note), 'run_now says plainly that the routine has NOT run yet');
      A.ok(/next tick/.test(out.summary), 'the summary the model reads says queued-for-next-tick, not ran');
    }

    // a DISARMED scheduler must say so — a queued fire on a down scheduler never happens
    {
      const dt = makeRoutineTools({
        roster: () => roster, listJobs: () => mjobs, schedulerState: () => false,
        triggerRoutine: async (id) => find(id)
      });
      const body = JSON.parse((await dt.manageTool.run({ action: 'run_now', id: 'j-morning' })).content);
      A.eq(body.schedulerArmed, false, 'the disarmed scheduler is reported');
      A.ok(/DISARMED/.test(body.note), 'a queued fire on a disarmed scheduler is called out, not silently promised');
    }

    // a bad action is rejected before any reference resolution
    {
      let err = null;
      try { await mt.manageTool.run({ action: 'delete', id: 'j-morning' }); } catch (e) { err = e; }
      A.ok(err && /action must be/.test(err.message), 'an unknown action is refused with the valid set');
    }

    // an unwired host verb answers honestly instead of pretending
    {
      const bare = makeRoutineTools({ roster: () => roster, listJobs: () => mjobs });
      let err = null;
      try { await bare.manageTool.run({ action: 'remove', id: 'j-morning' }); } catch (e) { err = e; }
      A.ok(err && /unavailable/.test(err.message), 'an unwired store verb reports unavailable rather than claiming success');
    }
  }

  // ---- registry: routine.manage is capability- and consent-gated exactly like routine.create ----
  {
    let removed = 0;
    const reg = makeRegistry();
    makeRoutineTools({
      roster: () => roster,
      listJobs: () => [{ id: 'j1', name: 'Nightly', agentId: 'agent', enabled: true, state: 'scheduled' }],
      removeRoutine: async () => { removed++; return { id: 'j1', name: 'Nightly' }; }
    }).register(reg);

    const noGrant = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: [], approvalRules: {} }, { emit: () => {} });
    const deniedCap = await reg.dispatch(call('routine.manage', { action: 'remove', id: 'j1' }), noGrant);
    A.ok(deniedCap.isError && /capability denied/.test(deniedCap.content), 'routine.manage denied without the orchestrator grant');
    A.eq(removed, 0, 'capability denial deletes nothing');

    const grant = { agentId: 'agent', room: 'office', hasCompute: true, tools: ['routine.manage'], approvalRules: {} };
    const deniedConsent = await reg.dispatch(call('routine.manage', { action: 'remove', id: 'j1' }),
      makeCapCtx(grant, { emit: () => {}, consent: async () => ({ allow: false, reason: 'no' }) }));
    A.ok(deniedConsent.isError && /consent denied/.test(deniedConsent.content), 'routine.manage asks consent before mutating standing work');
    A.eq(removed, 0, 'consent denial deletes nothing');

    const allowed = await reg.dispatch(call('routine.manage', { action: 'remove', id: 'j1' }),
      makeCapCtx(grant, { emit: () => {}, consent: async () => ({ allow: true }) }));
    A.ok(!allowed.isError, 'routine.manage runs when granted and approved');
    A.eq(removed, 1, 'approved routine.manage reaches the store verb');
  }

  A.report('routine-tools');
})().catch(e => { console.log('FAIL: routine-tools threw -- ' + (e && e.stack || e)); process.exit(1); });
