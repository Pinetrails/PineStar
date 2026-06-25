/* node test/memoryprovider.test.js - MemoryProvider lifecycle parity. */
'use strict';

const A = require('./_assert.js');
const { makeMemoryManager, makeLocalCortexProvider } = require('../sidecar/memoryprovider.js');
const { rank, renderRecall, compactionMemoryBlock } = require('../sidecar/context.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

(async () => {
  // ---- empty manager is a no-op, not a special case callers must guard ----
  {
    const m = makeMemoryManager();
    A.eq(m.providers().length, 0, 'empty manager has no providers');
    A.eq(m.buildSystemPrompt({}), '', 'empty system prompt block');
    A.eq(m.onPreCompress([], {}), '', 'empty pre-compress block');
    const p = await m.prefetchAll('anything', {});
    A.eq(p.text, '', 'empty prefetch text');
    A.eq(m.queuePrefetchAll('anything', {}).queued, 0, 'empty queue prefetch queues nothing');
    A.eq(m.syncTurnAll('u', 'a', {}).queued, 0, 'empty sync turn queues nothing');
    const f = await m.flushPending();
    A.eq(f.ok, true, 'empty flush resolves');
  }

  // ---- one external slot, many builtins ----
  {
    const m = makeMemoryManager();
    m.addProvider({ name: 'local-cortex', builtin: true });
    m.addProvider({ name: 'builtin-two', kind: 'builtin' });
    m.addProvider({ name: 'honcho' });
    A.eq(m.providers().length, 3, 'builtins plus one external registered');
    A.throws(() => m.addProvider({ name: 'mem0' }), 'second external provider is rejected');
    A.throws(() => m.addProvider({ name: 'honcho', builtin: true }), 'duplicate provider name is rejected');
  }

  // ---- sync lifecycle hooks merge in provider order and fail open ----
  {
    const calls = [];
    const m = makeMemoryManager();
    m.addProvider({
      name: 'local-cortex', builtin: true,
      systemPromptBlock: () => 'LOCAL SYS',
      prefetch: () => ({ text: 'LOCAL PREFETCH', count: 2, chars: 14, usedIds: ['m1', 'm1'] }),
      onPreCompress: () => 'LOCAL COMPRESS',
      onTurnStart: (turn, msg) => calls.push('turn:' + turn + ':' + msg.role),
      onSessionEnd: msgs => calls.push('end:' + msgs.length),
      onSessionSwitch: id => calls.push('switch:' + id),
      onMemoryWrite: (action, target) => calls.push('write:' + action + ':' + target)
    });
    m.addProvider({
      name: 'bad-builtin', builtin: true,
      systemPromptBlock: () => { throw new Error('system boom'); },
      prefetch: () => { throw new Error('prefetch boom'); },
      onPreCompress: () => { throw new Error('compress boom'); },
      onTurnStart: () => { throw new Error('turn boom'); }
    });

    A.eq(m.buildSystemPrompt({}), 'LOCAL SYS', 'systemPromptBlock merges good providers despite a throwing one');
    const p = await m.prefetchAll('x', {});
    A.eq(p.text, 'LOCAL PREFETCH', 'prefetchAll returns good provider text');
    A.eq(p.usedIds, ['m1'], 'prefetchAll dedupes used ids');
    A.eq(m.onPreCompress([], {}), 'LOCAL COMPRESS', 'onPreCompress returns good provider block');
    m.onTurnStart(7, { role: 'user' }, {});
    m.onSessionEnd([{ role: 'user' }, { role: 'assistant' }], {});
    m.onSessionSwitch('s2', {});
    m.onMemoryWrite('write', 'notebook:ag', {}, {});
    A.eq(calls, ['turn:7:user', 'end:2', 'switch:s2', 'write:write:notebook:ag'], 'lifecycle fanout calls all supported hooks');
    A.ok(m.errors().length >= 3, 'throwing hooks are captured for diagnostics');
  }

  // ---- queued hooks do not run synchronously, flushPending drains in order ----
  {
    const order = [];
    const m = makeMemoryManager();
    m.addProvider({
      name: 'queue-provider', builtin: true,
      queuePrefetch: q => { order.push('prefetch:' + q); },
      syncTurn: (u, a) => { order.push('sync:' + u + ':' + a); }
    });
    const q = m.queuePrefetchAll('alpha', {});
    const s = m.syncTurnAll('user', 'assistant', {});
    A.eq(q.queued, 1, 'queuePrefetchAll reports one queued task');
    A.eq(s.queued, 1, 'syncTurnAll reports one queued task');
    A.eq(order, [], 'queued hooks are not run synchronously');
    await m.flushPending();
    A.eq(order, ['prefetch:alpha', 'sync:user:assistant'], 'flush drains queued hooks in order');
  }

  // ---- provider tool hooks expose optional tools and route direct calls ----
  {
    const m = makeMemoryManager();
    m.addProvider({
      name: 'tool-provider', builtin: true,
      toolDefs: () => [
        { name: 'memory.remote_search', capability: 'memory', schema: { type: 'object' }, run: async () => 'remote ok' }
      ],
      handleToolCall: async (name, args) => name === 'memory.remote_search' ? { content: 'handled ' + args.query } : null
    });
    const defs = m.toolDefs({});
    A.eq(defs.length, 1, 'provider exposes one tool def');
    const reg = makeRegistry();
    const r = m.registerTools(reg, {});
    A.eq(r.registered, ['memory.remote_search'], 'provider tool registered');
    const dispatched = await reg.dispatch({ name: 'memory.remote_search', args: {}, argsRaw: '{}', parseError: null });
    A.eq(dispatched.content, 'remote ok', 'registered provider tool runs through registry');
    const handled = await m.handleToolCall('memory.remote_search', { query: 'graphite' }, {});
    A.eq(handled.content, 'handled graphite', 'provider handleToolCall can service direct calls');
  }

  // ---- local Cortex provider preserves current recall + pre-compress behavior through the interface ----
  {
    const data = {
      'notebook:ag': [
        { id: 'm1', kind: 'profile', content: 'user prefers terse replies', createdAt: 1000, trust: 0 },
        { id: 'm2', kind: 'note', title: 'db', body: 'nightly postgres dump to s3', createdAt: 1000, trust: 0 }
      ]
    };
    const store = { get: k => data[k], set: (k, v) => { data[k] = v; } };
    const p = makeLocalCortexProvider({ store, clock: { now: () => 1000 }, rank, renderRecall, compactionMemoryBlock });
    const m = makeMemoryManager();
    m.addProvider(p);
    const prefetched = await m.prefetchAll('how does the user like replies', { agentId: 'ag', streamId: 's1' });
    A.ok(prefetched.text.indexOf('user prefers terse replies') >= 0, 'local provider prefetch surfaces relevant memory');
    A.ok(prefetched.usedIds.indexOf('m1') >= 0, 'local provider reports surfaced record ids');
    A.eq(prefetched.usedIds.length, Array.from(new Set(prefetched.usedIds)).length, 'local provider used ids are deduped');
    const block = m.onPreCompress([{ role: 'user', content: 'summarize reply preferences' }], { agentId: 'ag', now: 1000 });
    A.ok(block.indexOf('user prefers terse replies') >= 0, 'local provider onPreCompress preserves durable memory');
    A.ok(block.indexOf('preserve') >= 0, 'local provider uses the compaction preservation header');
  }

  A.report('memoryprovider.test');
})();
