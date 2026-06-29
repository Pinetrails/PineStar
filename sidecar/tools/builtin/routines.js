/* sidecar/tools/builtin/routines.js -- StarNet ROUTINES tools.

   These tools let the lead/orchestrator create and inspect scheduled routines through the SAME server-owned
   cron store that backs the ROUTINES panel. They intentionally do not use shell, crontab, Windows Task
   Scheduler, or any OS-level scheduler: a created job is a StarNet CronJob and fires through the harness. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).routines = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const NAME_CHARS = 80;
  const PROMPT_CHARS = 12000;

  function clean(s, n) {
    s = String(s == null ? '' : s).trim();
    return n && s.length > n ? s.slice(0, n) : s;
  }
  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }
  function validId(id) { return ID_RE.test(String(id || '')); }

  function asEntries(rosterLike) {
    const out = [];
    if (rosterLike && typeof rosterLike.forEach === 'function') {
      rosterLike.forEach((ident, id) => out.push({ id: String(id || ''), ident: ident || {} }));
    } else if (rosterLike && typeof rosterLike === 'object') {
      for (const id in rosterLike) out.push({ id: String(id || ''), ident: rosterLike[id] || {} });
    }
    return out.filter(e => validId(e.id));
  }

  function agentHaystack(e) {
    const i = e.ident || {};
    return lower([
      e.id, i.name, i.role, i.purpose, i.specId, i.specialty, i.persona, i.system
    ].filter(Boolean).join(' '));
  }

  const ROUTES = [
    {
      name: 'research',
      triggers: ['research', 'news', 'latest', 'source', 'sources', 'web', 'paper', 'papers', 'arxiv', 'scan', 'monitor', 'brief'],
      roles: ['research', 'researcher', 'scout', 'analyst', 'intelligence', 'web']
    },
    {
      name: 'engineering',
      triggers: ['code', 'repo', 'bug', 'test', 'build', 'implement', 'fix', 'debug', 'ci'],
      roles: ['engineer', 'engineering', 'developer', 'coder', 'reviewer']
    },
    {
      name: 'writing',
      triggers: ['write', 'draft', 'copy', 'post', 'email', 'newsletter', 'document', 'summary'],
      roles: ['scribe', 'writer', 'liaison', 'editor']
    },
    {
      name: 'ops',
      triggers: ['check', 'remind', 'watch', 'backup', 'sync', 'ops', 'operate', 'admin'],
      roles: ['operator', 'ops', 'chief']
    },
    {
      name: 'design',
      triggers: ['design', 'image', 'visual', 'ui', 'ux', 'mockup', 'sprite'],
      roles: ['designer', 'design', 'artist']
    }
  ];

  function words(s) {
    const m = lower(s).match(/[a-z0-9_-]{4,}/g);
    return m || [];
  }

  function hasAny(text, arr) {
    for (const x of arr) if (text.indexOf(x) >= 0) return true;
    return false;
  }

  function scoreEntry(e, intent) {
    const hay = agentHaystack(e);
    let score = 0;
    const hint = clean(intent.hint, 80);
    if (hint) {
      const h = lower(hint);
      if (e.id.toLowerCase() === h) score += 100;
      if (hay.indexOf(h) >= 0) score += 35;
    }
    for (const r of ROUTES) {
      if (!hasAny(intent.text, r.triggers)) continue;
      if (hasAny(hay, r.roles)) score += 30;
      if (hasAny(lower(e.id), r.roles)) score += 10;
      if (hasAny(lower((e.ident && e.ident.name) || ''), r.roles)) score += 8;
    }
    for (const w of words(intent.text).slice(0, 24)) {
      if (hay.indexOf(w) >= 0) score += 1;
    }
    return score;
  }

  function chooseAgent(args, ctx, rosterEntries) {
    const requested = clean(args && args.agentId, 80);
    if (requested) {
      if (!validId(requested)) throw new Error('agentId must be one of your station agents');
      const known = rosterEntries.some(e => e.id === requested);
      if (rosterEntries.length && !known && requested !== 'agent') {
        throw new Error('unknown routine agentId "' + requested + '" (known: ' + rosterEntries.map(e => e.id).join(', ') + ')');
      }
      return { agentId: requested, reason: 'requested' };
    }

    const fallback = (ctx && validId(ctx.agentId)) ? ctx.agentId : 'agent';
    if (!rosterEntries.length) return { agentId: fallback, reason: 'no roster available; used current agent' };

    const intent = {
      hint: clean((args && args.agentHint) || '', 80),
      text: lower([args && args.name, args && args.prompt, args && args.agentHint].filter(Boolean).join(' '))
    };
    let best = null;
    for (const e of rosterEntries) {
      const score = scoreEntry(e, intent);
      if (!best || score > best.score) best = { entry: e, score: score };
    }
    if (best && best.score > 0) return { agentId: best.entry.id, reason: 'matched roster specialty' };
    if (rosterEntries.some(e => e.id === fallback)) return { agentId: fallback, reason: 'used current agent' };
    if (rosterEntries.some(e => e.id === 'agent')) return { agentId: 'agent', reason: 'used default agent' };
    return { agentId: rosterEntries[0].id, reason: 'used first available agent' };
  }

  function packJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      name: job.name,
      agentId: job.agentId,
      scheduleDisplay: job.scheduleDisplay,
      enabled: !!job.enabled,
      state: job.state,
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt,
      lastStatus: job.lastStatus,
      provider: job.provider || null,
      model: job.model || null
    };
  }

  function makeRoutineTools(deps) {
    deps = deps || {};
    const listJobs = typeof deps.listJobs === 'function' ? deps.listJobs : function () { return []; };
    const createRoutine = deps.createRoutine;
    const armScheduler = deps.armScheduler;
    const schedulerState = typeof deps.schedulerState === 'function' ? deps.schedulerState : function () { return false; };
    const roster = typeof deps.roster === 'function' ? deps.roster : function () { return new Map(); };
    const normalizeProvider = typeof deps.normalizeProvider === 'function' ? deps.normalizeProvider : function (p) {
      p = lower(p).trim();
      if (!p) return null;
      return p === 'codex' || p === 'openai-codex' ? 'codex' : (p === 'openrouter' ? 'openrouter' : '');
    };

    const listTool = {
      name: 'routine.list', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'List StarNet ROUTINES scheduled jobs. Use this to check existing routines before creating another one.',
      schema: { type: 'object', properties: { agentId: { type: 'string' } } },
      run: async (args) => {
        const agentId = clean(args && args.agentId, 80);
        if (agentId && !validId(agentId)) throw new Error('agentId must be one of your station agents');
        let jobs = (listJobs() || []).map(packJob).filter(Boolean);
        if (agentId) jobs = jobs.filter(j => j.agentId === agentId);
        return { content: JSON.stringify({ schedulerArmed: !!schedulerState(), jobs: jobs }), summary: jobs.length + ' routine(s)' };
      }
    };

    const createTool = {
      name: 'routine.create', capability: 'orchestrator', scope: 'write', requiresConsent: true, timeoutMs: 15000,
      description: 'Create a StarNet ROUTINES scheduled job in the built-in harness scheduler. Use this whenever the Commander asks for a cron, routine, recurring task, reminder, standing job, or scheduled research. Do NOT use shell.exec, crontab, Windows Task Scheduler, Python scripts, or OS schedulers for this. If agentId is omitted, this tool routes the routine to the best matching station agent from the live roster (research/news/latest -> research/scout/analyst agents). arm defaults to true so saved routines actually fire.',
      schema: {
        type: 'object',
        required: ['prompt', 'schedule'],
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string', description: 'The instruction the target agent will run every time the routine fires.' },
          schedule: { type: 'string', description: 'Examples: every 30m, every 6h, 0 9 * * *, in 2h, or an ISO timestamp.' },
          agentId: { type: 'string', description: 'Optional exact station agent id. Omit to auto-route by specialty.' },
          agentHint: { type: 'string', description: 'Optional specialty hint such as research, engineer, scribe, operator, designer.' },
          timezone: { type: 'string', description: 'Optional IANA timezone for cron expressions, e.g. America/New_York.' },
          provider: { type: 'string', enum: ['openrouter', 'codex'] },
          model: { type: 'string' },
          enabled: { type: 'boolean' },
          arm: { type: 'boolean', description: 'Default true. When true, also enables the scheduler so routines will fire.' },
          repeatTimes: { type: ['integer', 'null'], description: 'Omit/null for recurring forever; one-shot schedules still run once.' }
        }
      },
      run: async (args, ctx) => {
        if (typeof createRoutine !== 'function') throw new Error('routine creation unavailable');
        const prompt = clean(args && args.prompt, PROMPT_CHARS);
        const schedule = clean(args && args.schedule, 200);
        if (!prompt) throw new Error('prompt is required');
        if (!schedule) throw new Error('schedule is required');

        const entries = asEntries(roster());
        const route = chooseAgent(args || {}, ctx || {}, entries);
        let provider = null;
        if (args && args.provider != null && args.provider !== '') {
          provider = normalizeProvider(args.provider);
          if (!provider) throw new Error('provider must be openrouter or codex');
        }
        const repeatTimes = (args && Object.prototype.hasOwnProperty.call(args, 'repeatTimes')) ? args.repeatTimes : null;
        const spec = {
          name: clean((args && args.name) || 'Scheduled routine', NAME_CHARS),
          prompt: prompt,
          schedule: schedule,
          timezone: clean((args && args.timezone) || '', 80),
          agentId: route.agentId,
          provider: provider,
          model: args && args.model != null ? clean(args.model, 120) : null,
          enabled: !(args && args.enabled === false),
          repeat: { times: repeatTimes == null ? null : Math.max(1, parseInt(repeatTimes, 10) || 1) }
        };
        const job = await createRoutine(spec);

        let armError = null;
        if (!args || args.arm !== false) {
          try { if (typeof armScheduler === 'function') armScheduler(true); }
          catch (e) { armError = (e && e.message) || String(e); }
        }

        const body = {
          ok: true,
          schedulerArmed: !!schedulerState(),
          armError: armError,
          routedTo: route.agentId,
          routingReason: route.reason,
          job: packJob(job)
        };
        return {
          content: JSON.stringify(body),
          summary: 'scheduled routine for ' + route.agentId + (armError ? ' (arm failed)' : '')
        };
      }
    };

    return {
      listTool: listTool,
      createTool: createTool,
      _chooseAgent: chooseAgent,
      register(reg) { reg.register(listTool); reg.register(createTool); return reg; }
    };
  }

  return { makeRoutineTools };
});
