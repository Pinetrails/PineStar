/* node test/harness.integration.test.js — THE real-harness contract, end to end and headless.
   Wires the SAME graph the sidecar host builds (registry + web + fs + notebook tools, object=capability
   resolution, the dotted->underscore wire-name boundary, the dispatch guard) and drives a four-step
   mission — web_search -> web_fetch -> fs.write -> final answer — through the UNCHANGED agentic loop on
   the replay provider. Zero network, zero spend (fetch + DNS injected). Proves the agent can actually ACT.

   This is the test that would have caught BOTH default-path showstoppers: the dotted tool names (the wire
   regex assertion) and a CAP_REGISTRY/registration drift (the resolved-toolset assertion). */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makeNotebookTools } = require('../sidecar/tools/builtin/notebook.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { makeConsentBroker } = require('../sidecar/permissions.js');

const ROOT = path.join(os.tmpdir(), 'skynet-itest-' + process.pid);

// canned web: a DDG results page for search, a Jina Reader body for fetch. (No real network.)
const DDG_HTML = '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Farticle">Example Article</a>' +
  '<div class="result__snippet">A great article about the answer.</div>';
function cannedFetch(url) {
  const u = String(url);
  if (u.indexOf('duckduckgo') >= 0) return Promise.resolve({ status: 200, text: async () => DDG_HTML });
  if (u.indexOf('r.jina.ai') >= 0) return Promise.resolve({ status: 200, text: async () => 'Title: Example\nURL Source: https://example.com/article\nMarkdown Content:\nThe top result confirms the answer is 42.' });
  return Promise.resolve({ status: 404, text: async () => '', headers: { get: () => '' } });
}

// the model's scripted run: search -> fetch -> write -> report. Tool names are the WIRE names the model
// would actually return (fs_write, not fs.write) — the dispatch boundary maps them back.
const fixture = {
  models: [{ id: 'replay/model', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' }, supportsTools: true }],
  turns: [
    [ { type: 'text', delta: 'On it, Commander — searching.' },
      { type: 'tool_start', index: 0, id: 'c1', name: 'web_search' },
      { type: 'tool_args', index: 0, chunk: '{"query":"the answer"}' },
      { type: 'usage', usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } },
      { type: 'done', finishReason: 'tool_calls' } ],
    [ { type: 'tool_start', index: 0, id: 'c2', name: 'web_fetch' },
      { type: 'tool_args', index: 0, chunk: '{"url":"https://example.com/article"}' },
      { type: 'usage', usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 } },
      { type: 'done', finishReason: 'tool_calls' } ],
    [ { type: 'tool_start', index: 0, id: 'c3', name: 'fs_write' },
      { type: 'tool_args', index: 0, chunk: '{"path":"report.md","content":"# Report\\nThe answer is 42."}' },
      { type: 'usage', usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 } },
      { type: 'done', finishReason: 'tool_calls' } ],
    [ { type: 'text', delta: 'Done, Commander. Saved report.md.' },
      { type: 'usage', usage: { prompt_tokens: 90, completion_tokens: 9, total_tokens: 99 } },
      { type: 'done', finishReason: 'stop' } ]
  ]
};

(async () => {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});

  // ---- build the graph EXACTLY as sidecar/index.js does ----
  const registry = makeRegistry();
  makeWebTools({ fetchImpl: cannedFetch, lookup: null }).register(registry);
  makeFsTools({ fsp, pathMod: path, root: ROOT, limits: { writeBytes: 1 << 20, readReturn: 24000 } }).register(registry);
  makeNotebookTools({ store: new Map(), clock: { now: () => 0 } }).register(registry);

  const station = { agents: { agent: { id: 'agent', room: 'office' } }, rooms: { office: { id: 'office', objects: [
    { instanceId: 'pc1', objectType: 'computer' }, { instanceId: 'd1', objectType: 'dish' },
    { instanceId: 'cab1', objectType: 'cabinet' }, { instanceId: 'nb1', objectType: 'notebook' }
  ] } } };
  const resolved = resolveTools('agent', station);
  // P1.5: drive the mission through the REAL consent broker, not an allow-all stub. The mission's single
  // write (report.md) is sanctioned up-front via a session grant on its danger class (cabinet:write), so it
  // flows through the cache tier — proving a granted mutation is allowed without resorting to Full Access.
  const consent = makeConsentBroker({ sessionKey: 'itest', surface: 'autonomous' });
  consent.grant('session', { name: 'fs.write' }, registry.get('fs.write'));
  const capCtx = makeCapCtx(resolved, { emit, consent, timeoutMs: 5000 });

  // ---- DRIFT GUARDS (these alone would have caught both default-path showstoppers) ----
  const EXPECTED = ['web_search', 'web_fetch', 'fs.read', 'fs.write', 'fs.list', 'fs.append', 'fs.edit', 'notebook.read', 'notebook.write'];
  A.eq(resolved.tools.slice().sort(), EXPECTED.slice().sort(), 'office objects resolve to the full toolset (object=capability is real)');
  for (const name of EXPECTED) A.ok(registry.get(name), 'tool registered: ' + name);

  const toolDefs = registry.wireFormat(registry.list(new Set(resolved.tools)));
  const fromWire = new Map();
  for (const d of toolDefs) { const real = d.function.name; const w = real.replace(/\./g, '_'); fromWire.set(w, real); d.function.name = w; }
  for (const d of toolDefs) A.ok(/^[A-Za-z0-9_-]{1,64}$/.test(d.function.name), 'wire tool name is provider-legal: ' + d.function.name);

  const dispatch = async (c, ctx) => {
    if (fromWire.has(c.name)) c = Object.assign({}, c, { name: fromWire.get(c.name) });
    return registry.dispatch(c, ctx);
  };

  // ---- run the mission ----
  const provider = makeReplayProvider(fixture);
  const cost = makeCostEngine({ priceOf: provider.priceOf });
  const res = await runAgentLoop({
    messages: [{ role: 'user', content: 'find the answer and write report.md' }],
    provider, emit, cost, tools: toolDefs, dispatch, capCtx,
    model: 'replay/model', agentId: 'agent', runId: 'itest',
    limits: { maxIters: 8, maxCostUsd: 1 }, clock: { now: () => 0 }
  });

  // ---- assert the agent actually ACTED ----
  A.eq(res.reason, 'done', 'multi-step mission ends done');
  A.eq(provider.callCount(), 4, 'four model turns (search, fetch, write, report)');

  const calls = seq.filter(e => e.name === 'agent.tool_call').map(e => e.payload.name);
  A.eq(calls, ['web_search', 'web_fetch', 'fs_write'], 'tools called in order (wire names)');

  const tr = seq.filter(e => e.name === 'agent.tool_result').map(e => e.payload);
  A.eq(tr.length, 3, 'exactly one result per call (pairing held)');
  A.ok(tr.every(r => r.isError === false), 'every tool succeeded — no 400, no capdenied, no jail/SSRF block');
  A.ok(seq.find(e => e.name === 'agent.run.error') === undefined, 'no run error across the whole multi-tool run');

  const dl = seq.find(e => e.name === 'deliverable');
  A.ok(dl && dl.payload.kind === 'file' && dl.payload.title === 'report.md', 'fs.write produced a deliverable');

  const onDisk = await fsp.readFile(path.join(ROOT, 'agent', 'report.md'), 'utf8');
  A.ok(/answer is 42/.test(onDisk), 'the report was REALLY written into the agent workspace on disk');

  A.ok(seq.filter(e => e.name === 'agent.token').some(e => /Saved report\.md/.test(e.payload.delta)), 'the final answer streamed to the user');

  // ---- P1.5 default-deny: an UN-granted mutation under an autonomous surface is denied, body never runs ----
  // (a fresh broker with no grant — the same fs.write the model is fully capable of calling otherwise.)
  const denyCtx = makeCapCtx(resolved, { emit, consent: makeConsentBroker({ sessionKey: 'deny', surface: 'autonomous' }), timeoutMs: 5000 });
  const denied = await dispatch({ name: 'fs_write', args: { path: 'unsanctioned.md', content: 'nope' } }, denyCtx);
  A.eq(denied.isError, true, 'un-granted mutation default-denies');
  A.eq(denied.summary, 'denied', 'denial surfaced as a consent denial, not a crash');
  A.ok(/silence is not consent/.test(denied.content), 'denial carries the silence-is-not-consent reason');
  let wrote = true; try { await fsp.access(path.join(ROOT, 'agent', 'unsanctioned.md')); } catch (e) { wrote = false; }
  A.ok(!wrote, 'the denied write never touched disk (no action on deny)');

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  A.report('harness.integration.test');
})();
