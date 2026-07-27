/* node test/loop.verify-on-stop.test.js — VERIFY-ON-STOP.

   The station's promise is that nothing is claimed unless it is proven, and "fake done" — an edit shipped as
   finished with no check ever run against it — is the failure this project pays for most. The system prompt
   already INSTRUCTED the model to verify after editing; nothing ENFORCED it. This proves the enforcement:
   a run that mutated CODE and then tries to end without evidence buys exactly one more turn, and every
   narrowing that keeps the nudge from firing on work that has nothing to verify. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const WRITE_SCHEMA = { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } };
const EXEC_SCHEMA = { type: 'object', required: ['command'], properties: { command: { type: 'string' } } };
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const toolDefs = (...names) => names.map(n => ({ type: 'function', function: { name: n, description: '', parameters: { type: 'object', properties: {} } } }));

function setup() {
  const bus = A.makeBus();
  const emit = makeEmitter(bus, () => {});
  return { emit };
}
// turn 1 calls `name` with `args`; every later turn is a plain tool-free answer.
function fixture(name, args, extraStops) {
  const turns = [[{ type: 'tool_start', index: 0, id: 'c1', name }, { type: 'tool_args', index: 0, chunk: JSON.stringify(args) }, { type: 'done', finishReason: 'tool_calls' }]];
  for (let i = 0; i < (extraStops || 2); i++) turns.push([{ type: 'text', delta: 'All set.' }, { type: 'done', finishReason: 'stop' }]);
  return { turns };
}
function reg(fail) {
  const r = makeRegistry();
  r.register({ name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => { if (fail) throw new Error('EACCES'); return 'wrote ' + a.path; } });
  r.register({ name: 'shell_exec', schema: EXEC_SCHEMA, run: async (a) => 'ran ' + a.command });
  r.register({ name: 'verify_run', schema: { type: 'object', properties: {} }, run: async () => 'PASS 12 passing' });
  return r;
}
async function run(o) {
  const { emit } = setup();
  const provider = makeReplayProvider(o.fixture);
  const messages = [{ role: 'user', content: 'go' }];
  const r = o.registry || reg();
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: o.tools || toolDefs('fs_write', 'verify_run', 'shell_exec'),
    limits: Object.assign({ maxIters: 8, grace: false }, o.limits || {}),
    dispatch: (c, ctx) => r.dispatch(c, ctx), capCtx: openCtx()
  });
  const nudges = messages.filter(m => m.role === 'system' && String(m.content).indexOf('<verify_before_done>') === 0);
  return { res, messages, nudges };
}

(async () => {
  // ---- 1. THE CORE CASE: code changed, run tries to stop, no check ever ran -> one nudge, run continues ----
  {
    const { res, messages, nudges } = await run({ fixture: fixture('fs_write', { path: 'src/app.js', content: 'x' }) });
    A.eq(nudges.length, 1, 'a code edit that ends unverified buys exactly one nudge');
    A.ok(/src\/app\.js/.test(nudges[0].content), 'the nudge NAMES the file it is asking about');
    A.ok(/state what you did NOT verify/.test(nudges[0].content), 'an honest "could not verify" is an accepted way out');
    A.eq(res.reason, 'done', 'the run still terminates after the nudge');
    // The nudge must actually buy a MODEL TURN, not merely append text. Assert structurally: an assistant turn
    // follows it. (res.turns is the wrong ruler here — a re-emitted identical answer is refunded by design.)
    const at = messages.indexOf(nudges[0]);
    A.eq(messages.slice(at + 1).some(m => m.role === 'assistant'), true, 'the model was called again after the nudge');
  }

  // ---- 2. PROSE HAS NOTHING TO RUN. A README/SKILL.md edit must never demand a test. ----
  for (const p of ['NOTES.md', 'docs/guide.mdx', 'README', 'CHANGELOG', 'data/rows.csv']) {
    const { nudges } = await run({ fixture: fixture('fs_write', { path: p, content: 'x' }) });
    A.eq(nudges.length, 0, 'a prose edit (' + p + ') never triggers verify-on-stop');
  }

  // ---- 3. EVIDENCE DISARMS IT — both the dedicated verifier and a shell command that is really a check ----
  {
    const two = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"src/a.js","content":"x"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: 'verify_run' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'green' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ fixture: two })).nudges.length, 0, 'a passing verify_run disarms the guard');

    const viaShell = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"src/a.js","content":"x"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: 'shell_exec' }, { type: 'tool_args', index: 0, chunk: '{"command":"npm test"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'green' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ fixture: viaShell })).nudges.length, 0, 'a real check through shell_exec disarms the guard');

    // ...but a shell command that merely LOOKS AROUND is not evidence that anything passed.
    const looksAround = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"src/a.js","content":"x"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: 'shell_exec' }, { type: 'tool_args', index: 0, chunk: '{"command":"git status"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ fixture: looksAround })).nudges.length, 1, '`git status` is not verification — the guard still fires');
  }

  // ---- 4. NEVER DEMAND THE IMPOSSIBLE: with no verification tool wired there is nothing to ask for ----
  {
    const { nudges } = await run({ fixture: fixture('fs_write', { path: 'src/a.js', content: 'x' }), tools: toolDefs('fs_write') });
    A.eq(nudges.length, 0, 'no verify_run and no shell_exec wired -> no nudge');
  }

  // ---- 5. A FAILED WRITE CHANGED NOTHING. There is no edit to verify. ----
  {
    const { nudges } = await run({ fixture: fixture('fs_write', { path: 'src/a.js', content: 'x' }), registry: reg(true) });
    A.eq(nudges.length, 0, 'a write that errored arms nothing');
  }

  // ---- 6. BOUNDED: a model that ignores the nudge still terminates, and the budget is honored ----
  {
    const { res, nudges } = await run({ fixture: fixture('fs_write', { path: 'src/a.js', content: 'x' }, 6) });
    A.eq(nudges.length, 1, 'at most one nudge per run even when the model keeps refusing to verify');
    A.eq(res.reason, 'done', 'the run terminates rather than looping on the nudge');

    const off = await run({ fixture: fixture('fs_write', { path: 'src/a.js', content: 'x' }), limits: { verifyOnStop: false } });
    A.eq(off.nudges.length, 0, 'limits.verifyOnStop === false disables the guard entirely');
  }

  // ---- 7. the pure classifiers, directly ----
  {
    const { vosIsCodePath, vosIsCheckCommand, vosKey } = _internals;
    A.eq(vosIsCodePath('src/a.js'), true, '.js is code');
    A.eq(vosIsCodePath('a.md'), false, '.md is prose');
    A.eq(vosIsCodePath('Makefile'), true, 'an extension-less build file is code');
    A.eq(vosIsCodePath('LICENSE'), false, 'LICENSE is prose even without an extension');
    A.eq(vosIsCodePath(''), false, 'an empty path arms nothing');
    A.eq(vosIsCheckCommand({ command: 'pytest -q' }), true, 'pytest is a check');
    A.eq(vosIsCheckCommand({ command: 'cargo test' }), true, 'cargo test is a check');
    A.eq(vosIsCheckCommand({ command: 'ls -la' }), false, 'ls is not a check');
    A.eq(vosIsCheckCommand({ command: 'cat package.json' }), false, 'reading a file is not a check');
    A.eq(vosKey('fs.write'), 'fs_write', 'dotted registry names and underscored wire names collapse to one key');
  }

  A.report('loop.verify-on-stop.test');
})().catch(e => { console.log('FAIL: loop.verify-on-stop.test threw -- ' + (e && e.stack || e)); process.exit(1); });
