/* sidecar/tools/builtin/orchestration.js — team.dispatch: the LEAD delegates subtasks to its summoned
   WORKER crew. The Stage-2 moat: a lead decomposes a task and hands subtasks to specialist workers, each of
   which runs its OWN real, independent agent loop (web/files/memory), and returns its result for the lead to
   synthesize. CONTRACT-FREE: no shared/events.js change — children emit the SAME frozen agent.run.* events,
   forwarded (lifecycle + cost only) onto the lead's bus so the floor can ANIMATE the handoff.

   makeOrchestrationTools({ runOnce, roster, key, model, provider, reasoningEffort, perWorker, newId, maxWorkers })
     runOnce   : the SAME run host the browser/cron use (injected to avoid a require cycle) — async (o) -> result
     roster    : () -> Map(agentId -> { system, name, model }) — the live crew identities (pushed by the browser)
     key       : this run's API key (per-run)        model : the lead's model (worker fallback)
     perWorker : per-WORKER USD ceiling (a runaway worker can't blow the lead's per-run cap)
     workerMaxIters: per-WORKER iteration ceiling (a runaway worker can't burn the lead's full loop)
     newId     : () -> a fresh runId for each child (crypto.randomUUID, injected so this UMD stays dep-free)
     maxWorkers: hard cap on workers per dispatch (defensive)

   Safety (verified against the run host): each worker is a DISTINCT agentId so it takes its own concurrency
   slot + its own ledger/live-budget entry while the lead's slot stays held; ctx.signal is threaded into every
   child so cancelling the lead aborts all workers; the child runOnce returning undefined (concurrency refusal /
   up-front error) is null-guarded; only the worker's FINAL assistant message is returned (never the full
   transcript) to stay under the per-run tool-output cap. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).orchestration = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  // events forwarded from a child run onto the LEAD's bus — ENOUGH to animate the handoff + keep cost honest,
  // but NOT the child's tokens/tool-calls (those would clutter the lead's COMMS). The lead reads the worker's
  // actual output from the tool RESULT, not the stream.
  // 'deliverable' forwards too (2026-07-07 escape): a worker's saved image/file was INVISIBLE — no COMMS card,
  // no crate, no notify — because the event died here. The payload already carries the OWNING agentId and its
  // jail-relative path, and the frontend card opens /api/file?agent=<owner>, so forwarding is the whole fix.
  const FORWARD = { 'agent.run.start': 1, 'agent.run.end': 1, 'agent.run.error': 1, 'agent.cost': 1, 'deliverable': 1 };
  // a delegated worker's added kit, on top of the autonomous full office (compute/web/files/memory/studio/jukebox):
  // the WORKBENCH (terminal). Paired with the SHARED lead consent broker, shell/writes follow the lead's APPROVAL
  // posture — so a worker has the same reach as the orchestrator, gated by the same approvals.
  const WORKER_KIT = [{ instanceId: 'wb_worker', objectType: 'workbench' }];

  function lastAssistant(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
    }
    return '';
  }

  function makeOrchestrationTools(deps) {
    deps = deps || {};
    const runOnce = deps.runOnce;
    const roster = (typeof deps.roster === 'function') ? deps.roster : (() => new Map());
    const key = deps.key;
    const model = deps.model;
    const provider = deps.provider || null;
    const baseUrl = deps.baseUrl || deps.base_url || '';
    const reasoningEffort = deps.reasoningEffort || 'medium';
    const subagents = deps.subagents || null;
    // the LEAD's OWN base identity (system prompt), threaded from the run host so team.spawn can clone it. Empty
    // string when absent → a spawned subagent still runs, just without an inherited persona.
    const selfSystem = (typeof deps.selfSystem === 'string') ? deps.selfSystem : '';
    const taskContext = (typeof deps.taskContext === 'string') ? deps.taskContext.trim() : '';
    function workerSystem(base) {
      const identity = String(base || '');
      if (!taskContext) return identity;
      return identity + '\n\n' + taskContext
        + '\n\n[DELEGATED EXECUTION] Treat the task context above as settled input from the Commander. Do not ask the Commander another discovery question. If a truly blocking gap remains, report that gap to the lead agent.';
    }
    const perWorker = (typeof deps.perWorker === 'number' && isFinite(deps.perWorker) && deps.perWorker > 0) ? deps.perWorker : 0;
    const workerMaxIters = (typeof deps.workerMaxIters === 'number' && isFinite(deps.workerMaxIters) && deps.workerMaxIters > 0) ? Math.floor(deps.workerMaxIters) : 10;
    let _seq = 0;
    const newId = (typeof deps.newId === 'function') ? deps.newId : (() => 'child_' + (++_seq));
    // Cross-provider dispatch: a roster identity carries its OWN mirrored provider (model is a roster
    // property). Sending a worker's model down the LEAD's wire when they differ is an instant 400 (e.g. an
    // anthropic slug at the codex backend), so the host injects providerAuth(providerId) -> { provider, key,
    // baseUrl } | null to resolve the worker's own server-held credential. No resolver / no credential ->
    // the worker runs on the LEAD's provider+model (never a foreign model on the lead's wire) with an honest
    // note in the dispatch result.
    const providerAuth = (typeof deps.providerAuth === 'function') ? deps.providerAuth : null;
    function workerWire(ident) {
      const wanted = (ident && ident.provider) ? String(ident.provider) : '';
      const ownModel = (ident && ident.model) ? String(ident.model) : '';
      if (!wanted || wanted === provider || !ownModel) {
        return { provider, key, baseUrl, model: ownModel || model, note: '' };
      }
      const auth = providerAuth ? providerAuth(wanted) : null;
      if (auth) return { provider: auth.provider || wanted, key: auth.key || '', baseUrl: auth.baseUrl || '', model: ownModel, note: '' };
      return { provider, key, baseUrl, model, note: 'worker provider "' + wanted + '" has no credential on this station — ran on the lead\'s model instead' };
    }
    const maxWorkers = (typeof deps.maxWorkers === 'number' && deps.maxWorkers > 0) ? deps.maxWorkers : 4;
    // A dispatch AWAITS one or more full worker agent-loops (each web-searching + multi-turn), which routinely
    // run for minutes. The host wraps every tool call in CAPS.toolTimeoutMs (30s — sized for fast web/file
    // tools), so WITHOUT this override team.dispatch is guaranteed to time out before any real worker returns:
    // the lead then abandons delegation and does the job solo while the orphaned worker keeps spending. So the
    // dispatch tool carries its OWN generous wall-clock backstop. Real runaway is already bounded per-worker by
    // the cost cap (perWorker) + the worker's own maxIters/per-tool timeouts; this is just the outer ceiling.
    const dispatchTimeoutMs = (typeof deps.dispatchTimeoutMs === 'number' && deps.dispatchTimeoutMs > 0) ? deps.dispatchTimeoutMs : 600000;

    const dispatchTool = {
      // own wall-clock (minutes, not the 30s fast-tool default) — see dispatchTimeoutMs above.
      timeoutMs: dispatchTimeoutMs,
      // CONSENT-GATED (2026-07-14, closes the parked P1): delegation fans out REAL autonomous agent loops that
      // spend budget — if untrusted content in the lead's context (a fetched page, a channel message) injects
      // "dispatch a worker to do X", the human must get a say first. Same semantics as team.summon: the APPROVAL
      // beat in 'ask' mode (a session grant stops per-call fatigue), bypassed by Full Access — so a trusting
      // user keeps the frictionless flow by choosing it. Lead-only conferral + budget caps + the concurrency
      // ceiling + autonomous workers (default-deny) all still stand underneath.
      name: 'team.dispatch', capability: 'orchestrator', scope: 'execute', requiresConsent: true,
      description: 'Delegate subtasks to your specialist crew. Each worker runs its OWN real agent loop (live web search/read, files, memory) and returns its result for you to synthesize into the final answer. Address workers by the agentId listed under YOUR TEAM. Runs sequentially by default; pass parallel:true to run them at once. Pass background:true to start watchable workers and keep working. FILES: each worker saves into its OWN private workspace — you cannot fs.read another agent\'s files, so never "verify" a worker\'s file with your own file tools (absence in YOUR workspace proves nothing). The result\'s artifacts list is the proof of what each worker saved, and the Commander is shown those files as cards automatically — reference them as "<workerId>\'s workspace: <path>".',
      schema: {
        type: 'object', required: ['workers'], properties: {
          workers: {
            type: 'array', items: {
              type: 'object', required: ['agentId', 'prompt'],
              properties: { agentId: { type: 'string' }, prompt: { type: 'string' } }
            }
          },
          parallel: { type: 'boolean' },
          background: { type: 'boolean' }
        }
      },
      run: async (args, ctx) => {
        if (typeof runOnce !== 'function') return { content: 'orchestration unavailable (no run host)', summary: 'error' };
        const leadId = (ctx && ctx.agentId) || 'agent';
        const crew = roster() || new Map();
        const reqs = Array.isArray(args.workers) ? args.workers.slice(0, maxWorkers) : [];
        if (!reqs.length) return { content: 'No workers specified.', summary: 'noop' };

        // forward ONLY lifecycle/cost from children onto the lead's bus (the floor animation reads agent.run.start).
        const childEmit = (name, payload) => { if (FORWARD[name] && ctx && typeof ctx.emit === 'function') { try { ctx.emit(name, payload); } catch (_) {} } };

        // validate every target up front: a real, live, OTHER worker (never self, never an unknown agentId).
        const jobs = reqs.map(w => {
          const aid = w && String(w.agentId || '');
          if (!ID_RE.test(aid)) return { agentId: aid, error: 'invalid agentId' };
          if (aid === leadId) return { agentId: aid, error: 'cannot delegate to yourself' };
          if (!crew.has(aid)) return { agentId: aid, error: 'no such live worker — summon them first, or check the agentId against YOUR TEAM' };
          return { agentId: aid, prompt: String((w && w.prompt) || ''), ident: crew.get(aid) };
        });

        const runWorker = async (job, o2) => {
          o2 = o2 || {};
          if (job.error) return { agentId: job.agentId, reason: 'error', result: job.error, usd: 0 };
          const wire = workerWire(job.ident);   // the worker's OWN provider+model when resolvable (see workerWire)
          let result;
          try {
            result = await runOnce({
              key: wire.key, provider: wire.provider, baseUrl: wire.baseUrl,
              // Class Loadouts S1: the WORKER runs at its OWN class-applied reasoning effort (roster record), not the
              // lead's — a dispatched specialist honors its loadout. Falls back to the lead's effort when unset.
              reasoningEffort: (job.ident && job.ident.reasoningEffort) || reasoningEffort,
              model: wire.model,
              system: workerSystem((job.ident && job.ident.system) || ''),
              messages: [{ role: 'user', content: job.prompt }],
              agentId: job.agentId, isTask: true,
              emit: o2.emit || childEmit,      // lifecycle/cost ride the lead/global stream -> the floor lights the worker
              signal: o2.signal || (ctx && ctx.signal),
              runId: o2.runId || newId(), trigger: 'directive', surface: 'autonomous',
              // Share the lead's consent broker so a worker's WRITES follow the lead's APPROVAL posture
              // (full-auto bypass, or a prompt forwarded to the watched lead) instead of the headless default-deny.
              // NOT "same access as the orchestrator" — a worker runs surface:'autonomous' (below), and
              // enforceRunAuthority strips WORKSPACE_PROCESS tools on any non-interactive surface *before* consent is
              // ever consulted. So of the WORKBENCH grant a worker receives, shell.exec and verify.run never reach the
              // model at all; only its background-shell and browser-test tools survive. Widening that is a deliberate
              // permissions-surface decision, not something to fix by editing this comment.
              consent: ctx && ctx.consent,
              extraObjects: WORKER_KIT,
              maxCostUsd: perWorker,           // a runaway worker can't blow the lead's per-run ceiling
              maxIters: workerMaxIters         // a runaway worker can't burn the lead's full iteration budget
            });
          } catch (e) {
            return { agentId: job.agentId, reason: 'error', result: 'worker run failed: ' + ((e && e.message) || e), usd: 0 };
          }
          if (!result) return { agentId: job.agentId, reason: 'refused', result: 'worker could not start — the concurrency cap (STARNET_MAX_CONCURRENT_AGENTS) is full or a sign-in is needed. Try fewer at once, or run sequentially.', usd: 0 };
          const row = {
            agentId: job.agentId,
            reason: result.reason || 'done',
            result: lastAssistant(result.messages) || '(the worker returned no text)',
            usd: result.usd || 0
          };
          if (wire.note) row.note = wire.note;   // honest credential-fallback disclosure (never silent)
          // WORK VISIBILITY (ghost-file fix): what the worker PROVABLY produced (its runOnce artifact ledger),
          // stamped with the OWNING agentId. Files live in the WORKER's private workspace — the lead cannot
          // fs.read them and must reference them as the worker's (they are already shown to the Commander as
          // cards via the forwarded deliverable events). Never invent paths beyond this list.
          if (Array.isArray(result.artifacts) && result.artifacts.length) {
            row.artifacts = result.artifacts.map(a => Object.assign({}, a, { agentId: job.agentId, workspace: job.agentId }));
          }
          return row;
        };

        const runJob = async (job) => runWorker(job);

        if (args.background) {
          if (!subagents || typeof subagents.start !== 'function') return { content: 'background subagents unavailable (no subagent manager)', summary: 'error' };
          const started = jobs.map(job => {
            if (job.error) return { agentId: job.agentId, reason: 'error', result: job.error };
            return subagents.start({ leadId, agentId: job.agentId, prompt: job.prompt, runId: newId() }, async (h) => {
              const r = await runWorker(job, { runId: h.runId, signal: h.signal, emit: h.emit });
              return { status: r.reason === 'done' ? 'done' : 'error', reason: r.reason, result: r.result, usd: r.usd || 0 };
            });
          });
          return { content: JSON.stringify(started), summary: 'started ' + started.filter(r => r && r.id).length + ' background worker(s)' };
        }

        let out;
        if (args.parallel) out = await Promise.all(jobs.map(runJob));   // fan out (bounded by the concurrency gate)
        else { out = []; for (const j of jobs) out.push(await runJob(j)); }   // sequential: legible, one box at a time

        const ok = out.filter(r => r.reason === 'done').length;
        return { content: JSON.stringify(out), summary: 'dispatched ' + jobs.length + ' worker(s), ' + ok + ' done' };
      }
    };

    // team.spawn: the LEAD spawns EPHEMERAL sub-agents — anonymous CLONES OF ITSELF — to work subtasks in PARALLEL.
    // The "Meeseeks": a throwaway worker that does its one task, returns its result, then vanishes. UNLIKE
    // team.dispatch (which delegates to NAMED roster crew with their own persistent identity), these have NO roster
    // identity — each is a clone of the lead (the lead's OWN base system + model), narrowed to a focused subtask with
    // its own cost budget and a fresh ephemeral id. Routed through the durable subagent registry so each emits
    // task{kind:'subagent'} + the frozen agent.run.* — the floor's Meeseeks-sprite feed, CONTRACT-FREE. FLAT DEPTH:
    // a clone is handed the WORKBENCH but NOT the orchestrator object, so team.spawn/dispatch are never EXPOSED to it
    // → it cannot spawn its own sub-agents. The SAME gating that already stops a delegated worker re-delegating.
    const spawnTool = {
      timeoutMs: dispatchTimeoutMs,
      // CONSENT-GATED like team.dispatch (see its note): spawning clones fans out autonomous budget-spending
      // loops off text in the lead's context — 'ask' mode gets the APPROVAL beat, Full Access bypasses.
      name: 'team.spawn', capability: 'orchestrator', scope: 'execute', requiresConsent: true,
      description: 'Spawn EPHEMERAL sub-agents — clones of yourself — to work subtasks in parallel. Each runs its OWN agent loop on the one subtask you give it, returns its result, then vanishes (it is NOT added to your roster, and it cannot spawn its own sub-agents). Use this to decompose a task or fan out parallel work without summoning named crew first. Each task takes a prompt (the focused subtask) and an optional label. Pass background:true to spawn watchable workers and keep working while they run.',
      schema: {
        type: 'object', required: ['tasks'], properties: {
          tasks: {
            type: 'array', items: {
              type: 'object', required: ['prompt'],
              properties: { prompt: { type: 'string' }, label: { type: 'string' } }
            }
          },
          background: { type: 'boolean' }
        }
      },
      run: async (args, ctx) => {
        if (typeof runOnce !== 'function') return { content: 'orchestration unavailable (no run host)', summary: 'error' };
        if (!subagents || typeof subagents.start !== 'function') return { content: 'ephemeral subagents unavailable (no subagent manager)', summary: 'unavailable' };
        const leadId = (ctx && ctx.agentId) || 'agent';
        const reqs = Array.isArray(args.tasks) ? args.tasks.slice(0, maxWorkers) : [];
        if (!reqs.length) return { content: 'No tasks specified.', summary: 'noop' };

        // forward ONLY lifecycle/cost onto the lead's bus so the floor materializes/pops the Meeseeks live; the
        // durable record (via h.emit) keeps the full watch tail for team.subagents/interrupt/resume.
        const childEmit = (name, payload) => { if (FORWARD[name] && ctx && typeof ctx.emit === 'function') { try { ctx.emit(name, payload); } catch (_) {} } };

        const spawnOne = (task, i) => {
          const label = String((task && task.label) || ('subagent ' + (i + 1))).slice(0, 60);
          const prompt = String((task && task.prompt) || '');
          const ephemeralId = ('sub-' + newId()).slice(0, 40);   // anonymous, ID_RE-valid; NEVER a roster agentId
          let settle; const done = new Promise(res => { settle = res; });
          const runner = async (h) => {
            if (!prompt.trim()) { const r = { label, agentId: ephemeralId, reason: 'error', result: 'empty subtask prompt', usd: 0 }; settle(r); return { status: 'error', reason: 'error', result: r.result, usd: 0 }; }
            let result;
            try {
              result = await runOnce({
                key, provider, baseUrl, reasoningEffort, model,      // the lead's OWN model - a clone of self
                system: workerSystem(selfSystem),           // the lead's OWN identity plus settled task context
                                                            // composes its own caps for its (narrowed) toolset
                messages: [{ role: 'user', content: prompt }],
                agentId: ephemeralId, isTask: true,
                emit: (n, p) => { try { h.emit(n, p); } catch (_) {} childEmit(n, p); },   // durable record + lead stream
                signal: h.signal, runId: h.runId,
                trigger: 'directive', surface: 'autonomous',
                consent: ctx && ctx.consent,                // same approval posture as the orchestrator
                extraObjects: WORKER_KIT,                   // WORKBENCH only — NO 'lead' → no orchestrator object →
                                                            // team.spawn never exposed to it → FLAT DEPTH (no re-spawn)
                maxCostUsd: perWorker,                       // a runaway clone can't blow the lead's per-run ceiling
                maxIters: workerMaxIters                     // a runaway clone can't burn the lead's full iteration budget
              });
            } catch (e) {
              const r = { label, agentId: ephemeralId, reason: 'error', result: 'subagent run failed: ' + ((e && e.message) || e), usd: 0 };
              settle(r); return { status: 'error', reason: 'error', result: r.result, usd: 0 };
            }
            if (!result) {
              const r = { label, agentId: ephemeralId, reason: 'refused', result: 'subagent could not start — the concurrency cap (STARNET_MAX_CONCURRENT_AGENTS) is full or a sign-in is needed. Try fewer at once.', usd: 0 };
              settle(r); return { status: 'error', reason: 'refused', result: r.result, usd: 0 };
            }
            const r = { label, agentId: ephemeralId, reason: result.reason || 'done', result: lastAssistant(result.messages) || '(the subagent returned no text)', usd: result.usd || 0 };
            // ghost-file fix (same as runWorker): the clone's proven outputs, stamped with the owning workspace.
            if (Array.isArray(result.artifacts) && result.artifacts.length) r.artifacts = result.artifacts.map(a => Object.assign({}, a, { agentId: ephemeralId, workspace: ephemeralId }));
            settle(r);
            return { status: r.reason === 'done' ? 'done' : 'error', reason: r.reason, result: r.result, usd: r.usd, artifacts: r.artifacts };
          };
          const view = subagents.start({ leadId, agentId: ephemeralId, prompt: prompt, runId: newId() }, runner);
          return { label, view, done };
        };

        const spawned = reqs.map(spawnOne);
        if (args.background) {
          return { content: JSON.stringify(spawned.map(s => Object.assign({ label: s.label }, s.view))), summary: 'spawned ' + spawned.length + ' subagent(s)' };
        }
        const results = await Promise.all(spawned.map(s => s.done));
        const ok = results.filter(r => r.reason === 'done').length;
        return { content: JSON.stringify(results), summary: 'spawned ' + results.length + ' subagent(s), ' + ok + ' done' };
      }
    };

    // team.summon: the LEAD creates a NEW worker on the crew, LIVE, for the Commander — the same action the
    // Commander takes in the Recruitment Bay. CONTRACT: emits crew.summon.request down the run stream (added to
    // shared/events.js); the browser runs the real summonAgent() and POSTs /api/summon/ack with the new agentId,
    // which resolves ctx.summon (mirroring the consent round-trip). The new id is returned so the lead can hand it
    // work with team.dispatch in the SAME run. consent-gated (APPROVAL beat); ctx.summon is only present on a
    // live interactive lead run, so a headless/worker call degrades to a clear "not available" message.
    // Class Loadouts S1: the specialist class list is composed from the SHARED catalog (deps.classes =
    // [{id, tagline}]), NOT hardcoded here, so it never drifts from the Recruitment Bay. Falls back to a
    // static list only if no catalog was injected (keeps the tool self-describing under a bare unit test).
    const SPEC_IDS = (Array.isArray(deps.classes) && deps.classes.length)
      ? deps.classes.map(c => c && c.id).filter(Boolean).join(', ')
      : 'researcher, engineer, operator, scribe, analyst, reviewer, scout, archivist, designer, chief, liaison';
    const summonTool = {
      // own wall-clock above the summon's 120s browser-ack backstop, so a stalled ack returns a clean "not
      // completed" instead of tripping the 30s fast-tool default mid-wait. The happy path acks in well under a second.
      timeoutMs: 180000,
      name: 'team.summon', capability: 'orchestrator', scope: 'write', requiresConsent: true,
      description: 'Summon a NEW specialist agent onto the crew for the Commander, live — the same thing they would do in the Recruitment Bay. Use this when a specialist you need does not exist yet; if it is already listed under YOUR TEAM, delegate to it with team.dispatch instead. Pick a class with specId (one of: ' + SPEC_IDS + ') or describe a custom one with name + purpose. Returns the new agentId, which you can immediately delegate to. In APPROVAL mode the Commander confirms the summon first.',
      schema: {
        type: 'object', required: ['name'], properties: {
          name: { type: 'string' },        // the new agent's display name (e.g. "RESEARCHER")
          specId: { type: 'string' },       // optional built-in class to base it on (see SPEC_IDS)
          purpose: { type: 'string' },      // optional standing orders for a custom class
          persona: { type: 'string' },      // optional voice/persona id
          skin: { type: 'string' }          // optional sprite skin id
        }
      },
      run: async (args, ctx) => {
        if (!ctx || typeof ctx.summon !== 'function') return { content: 'Summoning is only available on the live station (an interactive run). Ask the Commander to summon this agent from the Recruitment Bay.', summary: 'unavailable' };
        const a = args || {};
        const spec = {
          name: String(a.name || '').trim().slice(0, 40),
          specId: String(a.specId || '').trim().slice(0, 40),
          purpose: String(a.purpose || '').trim().slice(0, 400),
          persona: String(a.persona || '').trim().slice(0, 40),
          skin: String(a.skin || '').trim().slice(0, 40)
        };
        if (!spec.name && !spec.specId) return { content: 'Provide a name or a specId for the new agent.', summary: 'noop' };
        let newId;
        try { newId = await ctx.summon(spec); }
        catch (e) { return { content: 'summon failed: ' + ((e && e.message) || e), summary: 'error' }; }
        if (!newId) return { content: 'The summon was not completed — the Commander declined it, or the station did not respond. No agent was created.', summary: 'declined' };
        return { content: JSON.stringify({ agentId: newId, name: spec.name || spec.specId }), summary: 'summoned ' + newId + ' — now delegate work to it with team.dispatch' };
      }
    };

    const subagentsTool = {
      name: 'team.subagents', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'List or inspect your background subagents. Pass id for one worker, or omit id to list recent workers for this lead. Returned records include status, event tail, result, and whether they can be interrupted or resumed.',
      schema: { type: 'object', properties: { id: { type: 'string' }, agentId: { type: 'string' }, status: { type: 'string' } } },
      run: async (args, ctx) => {
        if (!subagents) return { content: 'background subagents unavailable', summary: 'unavailable' };
        const leadId = (ctx && ctx.agentId) || 'agent';
        if (args && args.id) {
          const r = subagents.get(String(args.id));
          if (!r || r.leadId !== leadId) return { content: 'No such background subagent for this lead.', summary: 'not found' };
          return { content: JSON.stringify(r), summary: r.status };
        }
        const rows = subagents.list({ leadId, agentId: args && args.agentId, status: args && args.status });
        return { content: JSON.stringify(rows), summary: rows.length + ' background subagent(s)' };
      }
    };

    function resumeRunnerFor(ctx) {
      return async function (h) {
        const rec = h.record || {};
        const crew = roster() || new Map();
        const ident = crew.get(rec.agentId);
        if (!ident) return { status: 'error', reason: 'error', result: 'worker is no longer in the live roster', usd: 0 };
        const wire = workerWire(ident);   // same cross-provider resolution as a fresh dispatch
        let result;
        try {
          result = await runOnce({
            key: wire.key, provider: wire.provider, baseUrl: wire.baseUrl,
            reasoningEffort: (ident && ident.reasoningEffort) || reasoningEffort,   // Class Loadouts S1: worker's own class effort (see runWorker)
            model: wire.model,
            system: workerSystem((ident && ident.system) || ''),
            messages: [{ role: 'user', content: rec.prompt || '' }],
            agentId: rec.agentId, isTask: true,
            emit: h.emit, signal: h.signal, runId: h.runId,
            trigger: 'directive', surface: 'autonomous',
            consent: ctx && ctx.consent,
            extraObjects: WORKER_KIT,
            maxCostUsd: perWorker,
            maxIters: workerMaxIters
          });
        } catch (e) {
          return { status: 'error', reason: 'error', result: 'worker run failed: ' + ((e && e.message) || e), usd: 0 };
        }
        if (!result) return { status: 'error', reason: 'refused', result: 'worker could not restart', usd: 0 };
        return { status: result.reason === 'done' ? 'done' : 'error', reason: result.reason || 'done', result: lastAssistant(result.messages) || '(the worker returned no text)', usd: result.usd || 0 };
      };
    }

    const interruptTool = {
      name: 'team.interrupt', capability: 'orchestrator', scope: 'write', requiresConsent: false,
      description: 'Interrupt one of your running background subagents by id. This aborts its run and keeps its event/result record for inspection or resume.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: async (args, ctx) => {
        if (!subagents) return { content: 'background subagents unavailable', summary: 'unavailable' };
        const r = subagents.interrupt(String(args.id || ''), (ctx && ctx.agentId) || 'agent');
        return { content: JSON.stringify(r), summary: r.ok ? (r.alreadyDone ? 'already done' : 'interrupted') : 'not interrupted' };
      }
    };

    const resumeTool = {
      name: 'team.resume', capability: 'orchestrator', scope: 'execute', requiresConsent: false,
      description: 'Resume a stale/interrupted/failed background subagent by id. The worker restarts with the same prompt and appends to the same durable record.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: async (args, ctx) => {
        if (!subagents) return { content: 'background subagents unavailable', summary: 'unavailable' };
        const leadId = (ctx && ctx.agentId) || 'agent';
        const rec = subagents.get(String(args.id || ''));
        if (!rec || rec.leadId !== leadId) return { content: 'No such background subagent for this lead.', summary: 'not found' };
        const r = subagents.resume(rec.id, resumeRunnerFor(ctx));
        return { content: JSON.stringify(r), summary: r.ok ? 'resumed' : 'not resumed' };
      }
    };

    return {
      dispatchTool, spawnTool, summonTool, subagentsTool, interruptTool, resumeTool,
      register(reg) { [dispatchTool, spawnTool, summonTool, subagentsTool, interruptTool, resumeTool].forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeOrchestrationTools };
});
