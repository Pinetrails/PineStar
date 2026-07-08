/* node test/quests-tool.test.js — the quest.update builtin tool (sidecar/tools/builtin/quests.js, QUEST V2 §B).
   Drives the tool against a REAL questStore over an in-memory fs (no disk, deterministic — every timestamp
   injected via the tool's clock). Proves: op routing (progress / attest_complete / mint / unknown); agent
   SCOPING (progress rejects a quest that isn't open for the calling agent); attest EVIDENCE requirement + the
   honest "proposed, not complete" copy + mechanical-contract rejection passthrough; mint contract-rule + cap
   error passthrough VERBATIM; and that it is wired into CAP_REGISTRY under the universally-granted memory family. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeQuestStore } = require('../sidecar/quest-store.js');
const { makeQuestTools } = require('../sidecar/tools/builtin/quests.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

function memFs() {
  const files = new Map();
  return {
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, data) { files.set(String(f), String(data)); },
    renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); },
    mkdirSync() {}, unlinkSync(f) { files.delete(String(f)); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
}
const writeDurable = ({ fs }, file, data) => { fs.writeFileSync(file, data); };
function fresh() { return makeQuestStore({ fs: memFs(), path, workspaces: '/ws', writeDurable }); }
// a monotonic injected clock so the tool's now() is deterministic.
function toolFor(store) { let t = 0; return makeQuestTools({ store, clock: { now: () => ++t } }).questUpdateTool; }
const ctxOf = (agentId, runId) => ({ agentId, runId });

(async () => {

  // ---- CAP_REGISTRY: quest.update is granted under the universally-present `notebook` (memory) object ----
  {
    const rows = (CAP_REGISTRY.notebook || []).filter(g => g.tool === 'quest.update');
    A.eq(rows.length, 1, 'quest.update is registered exactly once under the notebook object');
    A.eq(rows[0].capId, 'memory', 'quest.update belongs to the universally-granted memory capability');
    A.eq(rows[0].requiresConsent, false, 'quest.update is consent-free (same trust class as notebook/todo)');
  }

  // ---- op:progress — agent scoping + step ticking ----
  {
    const store = fresh();
    const tool = toolFor(store);
    const q = await store.mint({ title: 'Automate CSV', contract: { type: 'run', key: 'r1' },
      steps: [{ key: 'a', label: 'gather' }, { key: 'b', label: 'script' }], agentId: 'hero', kind: 'work' }, 1);
    A.ok(q.ok, 'seed: a hero work quest with steps');

    // a DIFFERENT agent cannot progress hero's quest (agent scoping via openForAgent)
    const denied = await tool.run({ op: 'progress', id: q.id, stepKey: 'a', note: 'x' }, ctxOf('intruder', 'run9'));
    A.ok(/not one of your open quests/.test(denied.content), 'progress is rejected for an agent the quest is not open for');
    A.eq(store.get(q.id).steps[0].done, false, 'the step stayed un-ticked after the scoped rejection');

    // the owner CAN progress it
    const ok = await tool.run({ op: 'progress', id: q.id, stepKey: 'a', note: 'gathered the columns' }, ctxOf('hero', 'run1'));
    A.ok(/Ticked step "a"/.test(ok.content), 'the owning agent ticks the step');
    A.eq(store.get(q.id).steps[0].done, true, 'the step is now done in the store');
    A.eq(store.get(q.id).steps[0].note, 'gathered the columns', 'the progress note is recorded on the step');

    // missing id / stepKey / unknown step are honest no-ops
    A.ok(/Pass the quest id/.test((await tool.run({ op: 'progress', stepKey: 'a' }, ctxOf('hero'))).content), 'progress with no id → asks for id');
    A.ok(/Pass the stepKey/.test((await tool.run({ op: 'progress', id: q.id }, ctxOf('hero'))).content), 'progress with no stepKey → asks for stepKey');
    A.ok(/No open step "zzz"/.test((await tool.run({ op: 'progress', id: q.id, stepKey: 'zzz' }, ctxOf('hero'))).content), 'progress on an unknown step → honest no-op');
  }

  // ---- op:attest_complete — evidence required, proposes (never completes), mechanical rejected ----
  {
    const store = fresh();
    const tool = toolFor(store);
    const attestQ = await store.mint({ title: 'Draft launch email', contract: { type: 'attest', key: '' }, agentId: 'hero' }, 1);
    const runQ = await store.mint({ title: 'Build the thing', contract: { type: 'run', key: 'r2' }, agentId: 'hero', kind: 'work' }, 1);

    // no evidence → rejected by the tool BEFORE the store
    const noEv = await tool.run({ op: 'attest_complete', id: attestQ.id }, ctxOf('hero', 'run1'));
    A.ok(/needs concrete evidence/.test(noEv.content), 'attest_complete without evidence is rejected');
    A.eq(store.get(attestQ.id).attest, null, 'no pending attest was set without evidence');

    // real evidence → PROPOSED, never completed
    const proposed = await tool.run({ op: 'attest_complete', id: attestQ.id, evidence: 'wrote a 3-paragraph email tailored to the launch, saved to workspace' }, ctxOf('hero', 'run1'));
    A.ok(/proposed/i.test(proposed.content) && /NOT complete/.test(proposed.content), 'attest copy is honest: proposed, not complete');
    A.eq(store.get(attestQ.id).status, 'open', 'the quest is STILL open after attest (Commander must confirm)');
    const at = store.get(attestQ.id).attest;
    A.eq(at.confirmed, null, 'the attest is pending (confirmed=null)');
    A.eq(at.agentId, 'hero', 'the attest carries the calling agentId from ctx');
    A.eq(at.runId, 'run1', 'the attest carries the runId from ctx');

    // a MECHANICAL (run) contract cannot be attested — the store's error string passes through
    const mech = await tool.run({ op: 'attest_complete', id: runQ.id, evidence: 'I say it is done, trust me' }, ctxOf('hero', 'run1'));
    A.ok(/completes mechanically/.test(mech.content), 'attesting a mechanical quest surfaces the store rejection verbatim');
    A.eq(store.get(runQ.id).attest, null, 'no attest was set on the mechanical quest');
  }

  // ---- op:mint — contract enforced, generated/agent-scoped, error passthrough VERBATIM ----
  {
    const store = fresh();
    const tool = toolFor(store);

    // no contract → the store's exact error string
    const noC = await tool.run({ op: 'mint', title: 'do a thing' }, ctxOf('hero', 'run1'));
    A.ok(/needs a valid completion contract/.test(noC.content), 'mint with no contract surfaces the store error verbatim');

    // valid mint → generated + createdBy agent:<id> + agent-scoped
    const ok = await tool.run({ op: 'mint', title: 'Learn the CSV flow', contract: { type: 'attest', key: '' }, groundedIn: 'dossier: works with CSVs daily' }, ctxOf('hero', 'run1'));
    A.ok(/Minted quest q:\d+/.test(ok.content), 'a valid mint returns the new quest id');
    const minted = store.list().find(q => q.title === 'Learn the CSV flow');
    A.eq(minted.kind, 'generated', 'minted quest is kind:generated');
    A.eq(minted.createdBy, 'agent:hero', 'minted quest createdBy is agent:<callingAgent>');
    A.eq(minted.agentId, 'hero', 'minted quest is scoped to the calling agent');
    A.eq(minted.groundedIn, 'dossier: works with CSVs daily', 'groundedIn is carried through');

    // the ≤3-open-generated cap: 2 more ok, the 4th rejected with the store's verbatim message. NOTE: each mint is
    // on a DISTINCT runId so the per-run mint cap (below) doesn't mask the store's open-generated cap.
    await tool.run({ op: 'mint', title: 'Gen two', contract: { type: 'attest', key: '' } }, ctxOf('hero', 'runB'));
    await tool.run({ op: 'mint', title: 'Gen three', contract: { type: 'attest', key: '' } }, ctxOf('hero', 'runC'));
    const capped = await tool.run({ op: 'mint', title: 'Gen four', contract: { type: 'attest', key: '' } }, ctxOf('hero', 'runD'));
    A.ok(/max open generated quests/.test(capped.content), 'the 4th open generated mint is rejected with the store cap message');
  }

  // ---- op:mint — the MECHANICAL per-run cap: at most ONE successful mint per run ----
  {
    const store = fresh();
    const tool = toolFor(store);

    // first mint on run7 succeeds
    const first = await tool.run({ op: 'mint', title: 'First quest', contract: { type: 'attest', key: '' } }, ctxOf('hero', 'run7'));
    A.ok(/Minted quest q:\d+/.test(first.content), 'the first mint of a run succeeds');

    // a SECOND mint in the SAME run is rejected mechanically (not a store cap — a per-run cap in the tool)
    const second = await tool.run({ op: 'mint', title: 'Second quest', contract: { type: 'attest', key: '' } }, ctxOf('hero', 'run7'));
    A.ok(/one quest per run/.test(second.content), 'a second mint in the same run is rejected with the per-run cap message');
    A.eq(store.list().filter(q => q.title === 'Second quest').length, 0, 'the second quest was NOT persisted (the store was never reached)');

    // a DIFFERENT run may mint again (the cap is per-run, not per-agent)
    const nextRun = await tool.run({ op: 'mint', title: 'Third quest', contract: { type: 'attest', key: '' } }, ctxOf('hero', 'run8'));
    A.ok(/Minted quest q:\d+/.test(nextRun.content), 'a new run gets a fresh mint budget');

    // a REJECTED mint does not burn the run's budget: on a fresh run, a bad-contract mint fails, then a good one still lands
    const badFirst = await tool.run({ op: 'mint', title: 'No contract quest' }, ctxOf('hero', 'run9'));
    A.ok(/needs a valid completion contract/.test(badFirst.content), 'a bad mint is rejected (no contract)');
    const goodAfterBad = await tool.run({ op: 'mint', title: 'Good after bad', contract: { type: 'attest', key: '' } }, ctxOf('hero', 'run9'));
    A.ok(/Minted quest q:\d+/.test(goodAfterBad.content), 'a rejected mint did not consume the per-run budget — a valid mint still lands');

    // a run with NO runId can't be tracked → the mechanical cap simply does not apply (store cap still bounds).
    // Uses a fresh agent so hero's now-full ≤3-open-generated store cap doesn't mask what we're testing here.
    const noRunA = await tool.run({ op: 'mint', title: 'Runless one', contract: { type: 'attest', key: '' } }, ctxOf('scout', null));
    const noRunB = await tool.run({ op: 'mint', title: 'Runless two', contract: { type: 'attest', key: '' } }, ctxOf('scout', null));
    A.ok(/Minted quest q:\d+/.test(noRunA.content) && /Minted quest q:\d+/.test(noRunB.content), 'without a runId the per-run cap does not fire (mints bounded only by the store cap)');
  }

  // ---- unknown op ----
  {
    const tool = toolFor(fresh());
    A.ok(/Unknown op "frobnicate"/.test((await tool.run({ op: 'frobnicate' }, ctxOf('hero'))).content), 'an unknown op is reported honestly');
  }

  A.report('quests-tool.test');
})();
