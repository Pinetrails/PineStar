/* sidecar/tools/builtin/quests.js — the QUEST (memory) capability write half: a single `quest.update` tool
   (QUEST V2, plan §B — agent awareness). The read half is questinject.js (the STATION QUESTS prompt block);
   this lets the agent ACT on those quests. It is the ONLY way an agent touches the ledger.

   Ops (op-routed like the todo tool):
     • progress        — tick a NAMED open step with a short note (questStore.tickStep). Agent-scoped: the quest
                         must be OPEN FOR THIS agent (openForAgent) — an agent can't tick a step on a quest that
                         isn't its own / station-wide. Progress is display only; it NEVER completes a quest.
     • attest_complete — PROPOSE a quest done with concrete evidence (questStore.attest). Evidence REQUIRED. This
                         NEVER completes the quest — it sets a pending attest the Commander confirms (rate-the-work
                         beat). The store rejects mechanical (prop/run/fact/artifact) contracts: their completion
                         stays machine-owned. Result copy says "proposed — awaiting confirmation", never "completed".
     • mint            — mint a NEW personalized quest (questStore.mint), kind:'generated', createdBy:'agent:<id>',
                         scoped to the calling agent (generative-minting, plan §E). The store enforces THE CONTRACT
                         RULE (no valid contract → rejected), title-dedup, and the ≤3-open-generated cap; its error
                         strings are surfaced VERBATIM so the model can self-correct.

   capability: 'memory' — the universally-granted builtin family (notebook/todo/skill/recall/widget all live here;
   granted by the `notebook` object, which every default office carries). A quest is the agent's own standing
   objective — reading/updating it is the same trust class as its notebook/todo working memory: no filesystem reach,
   no network, no outward mutation until the Commander confirms an attest. So, like todo, NO consent gate.

   makeQuestTools({ store, clock }) -> { questUpdateTool, register(reg) }
     store : the questStore instance (openForAgent, tickStep, attest, mint)
     clock : { now() } — injected wall-clock (the store takes every timestamp as a parameter). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).quests = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OPS = ['progress', 'attest_complete', 'mint'];
  const str = v => String(v == null ? '' : v).trim();

  function makeQuestTools(deps) {
    deps = deps || {};
    const store = deps.store;
    if (!store) throw new Error('quests.js requires { store }');
    if (!deps.clock || typeof deps.clock.now !== 'function') throw new Error('quests.js requires { clock }');   // injected wall-clock only — determinism law, no ambient Date.now
    const now = () => deps.clock.now();

    const questUpdateTool = {
      name: 'quest.update', capability: 'memory', scope: 'write', requiresConsent: false, timeoutMs: 8000,
      description: 'Act on your STATION QUESTS (listed in your prompt). op:"progress" ticks a named step of a quest '
        + '(pass id, stepKey, and a short note on what you did) — progress is display only and never completes a '
        + 'quest. op:"attest_complete" PROPOSES a quest is done (pass id and concrete evidence of what was '
        + 'accomplished); this NEVER marks it complete — the Commander must confirm. Quests that complete '
        + 'mechanically (a run finishing, a capability going live, a deliverable existing) cannot be attested — leave '
        + 'them to the harness. op:"mint" creates a NEW personalized quest for the Commander (pass title, a completion '
        + 'contract, and groundedIn citing the dossier/memory fact that motivated it); every quest MUST declare a '
        + 'contract. Never claim a quest done in prose — use this tool.',
      schema: {
        type: 'object', required: ['op'], properties: {
          op: { type: 'string', enum: OPS },
          id: { type: 'string' },            // progress / attest_complete: which quest
          stepKey: { type: 'string' },       // progress: which step
          note: { type: 'string' },          // progress: what you did on this step
          evidence: { type: 'string' },      // attest_complete: concrete proof of completion
          title: { type: 'string' },         // mint: the new quest's title
          desc: { type: 'string' },          // mint: optional description
          reward: { type: 'string' },        // mint: the REAL outcome it unlocks (never points)
          contract: {                        // mint: the completion contract (REQUIRED by the store)
            type: 'object', properties: {
              type: { type: 'string', enum: ['prop', 'run', 'fact', 'artifact', 'attest'] },
              key: { type: 'string' }
            }
          },
          steps: {                           // mint: optional progress steps
            type: 'array', items: {
              type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' } }
            }
          },
          groundedIn: { type: 'string' }     // mint: the dossier/memory fact that motivated this quest
        }
      },
      run: async (args, ctx) => {
        args = args || {};
        const op = str(args.op);
        const agentId = (ctx && ctx.agentId) || 'agent';
        const runId = ctx && ctx.runId ? String(ctx.runId) : null;

        // ---- progress: tick a named step, agent-scoped ----
        if (op === 'progress') {
          const id = str(args.id);
          const stepKey = str(args.stepKey);
          if (!id) return { content: 'Pass the quest id to progress (from your STATION QUESTS list).', summary: 'noop' };
          if (!stepKey) return { content: 'Pass the stepKey of the step to tick.', summary: 'noop' };
          // AGENT SCOPING: only a quest OPEN FOR THIS agent (its own or station-wide) can be progressed here.
          const mine = store.openForAgent(agentId).some(q => q.id === id);
          if (!mine) return { content: 'Quest ' + id + ' is not one of your open quests. Only work quests listed for you can be updated.', summary: 'not yours' };
          const ok = await store.tickStep(id, stepKey, args.note, now());
          if (!ok) return { content: 'No open step "' + stepKey + '" on ' + id + ' (it may not exist or already be done).', summary: 'no-op' };
          return { content: 'Ticked step "' + stepKey + '" on ' + id + '.', summary: 'progress ' + id };
        }

        // ---- attest_complete: propose done with evidence (never completes) ----
        if (op === 'attest_complete') {
          const id = str(args.id);
          const evidence = str(args.evidence);
          if (!id) return { content: 'Pass the quest id to attest complete (from your STATION QUESTS list).', summary: 'noop' };
          if (!evidence) return { content: 'attest_complete needs concrete evidence of what was accomplished — attesting without proof is not allowed.', summary: 'noop' };
          const r = await store.attest(id, { agentId: agentId, runId: runId, evidence: evidence }, now());
          if (!r || r.ok === false) return { content: (r && r.error) ? r.error : 'could not attest ' + id, summary: 'rejected' };
          return { content: 'Completion proposed for ' + id + ' — awaiting the Commander\'s confirmation. It is NOT complete yet.', summary: 'attest proposed' };
        }

        // ---- mint: create a new personalized quest (contract-enforced by the store) ----
        if (op === 'mint') {
          const r = await store.mint({
            title: args.title,
            desc: args.desc,
            reward: args.reward,
            contract: args.contract,
            steps: args.steps,
            groundedIn: args.groundedIn,
            kind: 'generated',
            agentId: agentId,
            createdBy: 'agent:' + agentId
          }, now());
          if (!r || r.ok === false) return { content: (r && r.error) ? r.error : 'could not mint quest', summary: 'rejected' };
          return { content: 'Minted quest ' + r.id + '. It is now live in the Commander\'s QUEST LOG.', summary: 'minted ' + r.id };
        }

        return { content: 'Unknown op "' + op + '". Use one of: ' + OPS.join(', ') + '.', summary: 'noop' };
      }
    };

    return { questUpdateTool: questUpdateTool, register(reg) { reg.register(questUpdateTool); return reg; } };
  }

  return { makeQuestTools: makeQuestTools };
});
