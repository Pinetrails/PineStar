/* sidecar/memoryprovider.js - local-first memory provider lifecycle.
   Pure orchestration: provider hooks are injected objects, no ambient I/O here.

   makeMemoryManager() owns:
     - builtin providers plus at most one external provider slot
     - system/prefetch/pre-compress fanout
     - queued background hooks with flushPending() for tests/shutdown
     - optional provider-owned tools

   makeLocalCortexProvider() adapts the current notebook + context memory helpers to that interface. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.memoryprovider = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BUILTIN_NAMES = { 'local-cortex': true, builtin: true, cortex: true };

  function isFn(v) { return typeof v === 'function'; }
  function asString(v) { return v == null ? '' : String(v); }
  function trim(v) { return asString(v).trim(); }
  function nowOf(clock, fallback) {
    try { if (clock && isFn(clock.now)) return clock.now(); } catch (_) {}
    return typeof fallback === 'number' ? fallback : 0;
  }
  function providerName(p, i) {
    const n = trim(p && p.name);
    return n || ('memory-provider-' + (i + 1));
  }
  function isBuiltinProvider(p) {
    if (!p) return false;
    if (p.builtin === true || p.kind === 'builtin' || p.type === 'builtin') return true;
    return !!BUILTIN_NAMES[providerName(p, 0)];
  }
  function available(p, ctx) {
    if (!p) return false;
    if (!isFn(p.isAvailable)) return true;
    try { return p.isAvailable(ctx || {}) !== false; } catch (_) { return false; }
  }
  function recordError(errors, provider, hook, err) {
    errors.push({
      provider: providerName(provider || {}, 0),
      hook: hook,
      message: (err && err.message) || String(err || 'error')
    });
  }
  function normalizeBlock(value, provider, hook) {
    if (value == null || value === false) return null;
    if (typeof value === 'string') {
      const text = trim(value);
      return text ? { provider: providerName(provider, 0), hook: hook, text: text, count: 1, chars: text.length, usedIds: [] } : null;
    }
    if (Array.isArray(value)) {
      const parts = [];
      let usedIds = [];
      let count = 0;
      for (const v of value) {
        const b = normalizeBlock(v, provider, hook);
        if (!b) continue;
        parts.push(b.text);
        count += b.count || 1;
        usedIds = usedIds.concat(b.usedIds || []);
      }
      const text = parts.join('\n\n').trim();
      return text ? { provider: providerName(provider, 0), hook: hook, text: text, count: count, chars: text.length, usedIds: dedupe(usedIds) } : null;
    }
    if (typeof value === 'object') {
      const text = trim(value.text != null ? value.text : (value.content != null ? value.content : value.block));
      if (!text) return null;
      return {
        provider: value.provider || providerName(provider, 0),
        hook: hook,
        text: text,
        count: typeof value.count === 'number' ? value.count : 1,
        chars: typeof value.chars === 'number' ? value.chars : text.length,
        usedIds: Array.isArray(value.usedIds) ? dedupe(value.usedIds.map(String)) : []
      };
    }
    const text = trim(value);
    return text ? { provider: providerName(provider, 0), hook: hook, text: text, count: 1, chars: text.length, usedIds: [] } : null;
  }
  function joinBlocks(blocks) {
    return blocks.map(b => b.text).filter(Boolean).join('\n\n').trim();
  }
  function dedupe(list) {
    const seen = {};
    const out = [];
    for (const item of (Array.isArray(list) ? list : [])) {
      const k = String(item || '');
      if (!k || seen[k]) continue;
      seen[k] = true; out.push(k);
    }
    return out;
  }
  function latestUser(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
    }
    return '';
  }
  function messagesText(messages) {
    if (typeof messages === 'string') return messages;
    if (!Array.isArray(messages)) return '';
    return messages.map(m => {
      const role = (m && m.role) || 'msg';
      const content = (m && typeof m.content === 'string') ? m.content : JSON.stringify((m && m.content) || '');
      return role + ': ' + content;
    }).join('\n');
  }

  function makeMemoryManager(opts) {
    opts = opts || {};
    const providers = [];
    const errors = [];
    let externalName = null;
    let chain = Promise.resolve();
    let pending = 0;

    function snapshotErrors() { return errors.slice(); }
    function active(ctx) { return providers.filter(p => available(p, ctx)); }
    function enqueue(provider, hook, fn) {
      pending++;
      const task = () => Promise.resolve().then(fn).catch(e => recordError(errors, provider, hook, e)).then(() => { pending--; });
      chain = chain.then(task, task);
      return chain;
    }

    function addProvider(provider) {
      if (!provider || typeof provider !== 'object') throw new Error('memory provider must be an object');
      const p = Object.assign({}, provider);
      p.name = providerName(p, providers.length);
      if (providers.some(x => x.name === p.name)) throw new Error('duplicate memory provider: ' + p.name);
      const builtin = isBuiltinProvider(p);
      p.builtin = builtin;
      if (!builtin) {
        if (externalName) throw new Error('only one external memory provider may be registered (' + externalName + ' already owns the slot)');
        externalName = p.name;
      }
      providers.push(p);
      return p;
    }

    function buildSystemPrompt(ctx) {
      const blocks = [];
      for (const p of active(ctx)) {
        if (!isFn(p.systemPromptBlock)) continue;
        try {
          const b = normalizeBlock(p.systemPromptBlock(ctx || {}), p, 'systemPromptBlock');
          if (b) blocks.push(b);
        } catch (e) { recordError(errors, p, 'systemPromptBlock', e); }
      }
      return joinBlocks(blocks);
    }

    async function prefetchAll(query, ctx) {
      const blocks = [];
      for (const p of active(ctx)) {
        if (!isFn(p.prefetch)) continue;
        try {
          const b = normalizeBlock(await p.prefetch(query, ctx || {}), p, 'prefetch');
          if (b) blocks.push(b);
        } catch (e) { recordError(errors, p, 'prefetch', e); }
      }
      return {
        blocks: blocks,
        text: joinBlocks(blocks),
        count: blocks.reduce((n, b) => n + (b.count || 0), 0),
        chars: blocks.reduce((n, b) => n + (b.chars || (b.text || '').length), 0),
        usedIds: dedupe([].concat.apply([], blocks.map(b => b.usedIds || [])))
      };
    }

    function queuePrefetchAll(query, ctx) {
      let queued = 0;
      for (const p of active(ctx)) {
        const hook = isFn(p.queuePrefetch) ? 'queuePrefetch' : (isFn(p.prefetch) ? 'prefetch' : '');
        if (!hook) continue;
        queued++;
        enqueue(p, hook, () => p[hook](query, ctx || {}));
      }
      return { queued: queued, pending: pending };
    }

    function syncTurnAll(user, assistant, ctx) {
      let queued = 0;
      for (const p of active(ctx)) {
        if (!isFn(p.syncTurn)) continue;
        queued++;
        enqueue(p, 'syncTurn', () => p.syncTurn(user, assistant, ctx || {}));
      }
      return { queued: queued, pending: pending };
    }

    function onTurnStart(turn, message, ctx) {
      fanout('onTurnStart', [turn, message, ctx || {}], ctx);
    }
    function onSessionEnd(messages, ctx) {
      fanout('onSessionEnd', [messages || [], ctx || {}], ctx);
    }
    function onSessionSwitch(newSessionId, ctx) {
      fanout('onSessionSwitch', [newSessionId, ctx || {}], ctx);
    }
    function onMemoryWrite(action, target, content, ctx) {
      fanout('onMemoryWrite', [action, target, content, ctx || {}], ctx);
    }
    function fanout(hook, args, ctx) {
      for (const p of active(ctx)) {
        if (!isFn(p[hook])) continue;
        try { p[hook].apply(p, args); } catch (e) { recordError(errors, p, hook, e); }
      }
    }

    function onPreCompress(messages, ctx) {
      const blocks = [];
      for (const p of active(ctx)) {
        if (!isFn(p.onPreCompress)) continue;
        try {
          const b = normalizeBlock(p.onPreCompress(messages || [], ctx || {}), p, 'onPreCompress');
          if (b) blocks.push(b);
        } catch (e) { recordError(errors, p, 'onPreCompress', e); }
      }
      return joinBlocks(blocks);
    }

    function providerToolDefs(ctx) {
      const defs = [];
      const seen = {};
      for (const p of active(ctx)) {
        let raw = [];
        try {
          if (Array.isArray(p.tools)) raw = p.tools;
          else if (isFn(p.tools)) raw = p.tools(ctx || {}) || [];
          else if (isFn(p.toolDefs)) raw = p.toolDefs(ctx || {}) || [];
          else if (isFn(p.getToolDefs)) raw = p.getToolDefs(ctx || {}) || [];
        } catch (e) { recordError(errors, p, 'toolDefs', e); raw = []; }
        for (const def of (Array.isArray(raw) ? raw : [])) {
          if (!def || !def.name || seen[def.name]) {
            if (def && def.name) recordError(errors, p, 'toolDefs', new Error('duplicate provider tool: ' + def.name));
            continue;
          }
          seen[def.name] = true;
          defs.push(def);
        }
      }
      return defs;
    }

    function registerTools(registry, ctx) {
      const names = [];
      if (!registry || !isFn(registry.register)) return { registered: names };
      for (const def of providerToolDefs(ctx)) {
        try { registry.register(def); names.push(def.name); }
        catch (e) { recordError(errors, { name: def && def.name }, 'registerTools', e); }
      }
      return { registered: names };
    }

    async function handleToolCall(name, args, ctx) {
      for (const p of active(ctx)) {
        if (!isFn(p.handleToolCall)) continue;
        try {
          const r = await p.handleToolCall(name, args || {}, ctx || {});
          if (r != null) return r;
        } catch (e) { recordError(errors, p, 'handleToolCall', e); }
      }
      return null;
    }

    function flushPending() {
      const p = chain;
      return p.then(() => ({ ok: true, pending: pending, errors: snapshotErrors() }));
    }

    return {
      addProvider,
      providers: () => providers.slice(),
      activeProviders: active,
      errors: snapshotErrors,
      pending: () => pending,
      buildSystemPrompt,
      prefetchAll,
      queuePrefetchAll,
      syncTurnAll,
      onTurnStart,
      onSessionEnd,
      onSessionSwitch,
      onPreCompress,
      onMemoryWrite,
      toolDefs: providerToolDefs,
      registerTools,
      handleToolCall,
      flushPending
    };
  }

  function makeLocalCortexProvider(deps) {
    deps = deps || {};
    const store = deps.store;
    const clock = deps.clock || { now: () => 0 };
    const rank = deps.rank;
    const renderRecall = deps.renderRecall;
    const compactionMemoryBlock = deps.compactionMemoryBlock;

    function records(ctx) {
      if (!store || !isFn(store.get)) return [];
      const agentId = (ctx && ctx.agentId) || deps.agentId || 'agent';
      const raw = store.get('notebook:' + agentId);
      return Array.isArray(raw) ? raw : [];
    }
    function now(ctx) { return typeof (ctx && ctx.now) === 'number' ? ctx.now : nowOf(clock, 0); }

    return {
      name: 'local-cortex',
      builtin: true,
      isAvailable: () => !!store,
      systemPromptBlock: () => '',
      prefetch: (query, ctx) => {
        ctx = ctx || {};
        const recs = records(ctx);
        if (!recs.length || !isFn(rank) || !isFn(renderRecall)) return null;
        const q = query || ctx.query || latestUser(ctx.messages);
        const ranked = rank(recs, q, { now: now(ctx), streamId: ctx.streamId || null, k: ctx.k || 8 });
        const recall = renderRecall(ranked, { limit: ctx.limit || 1500 });
        if (!recall || !recall.text) return null;
        return {
          text: recall.text,
          count: recall.count || 0,
          chars: recall.chars || recall.text.length,
          usedIds: recall.usedIds || []
        };
      },
      queuePrefetch: () => null,
      syncTurn: () => null,
      onTurnStart: () => null,
      onSessionEnd: () => null,
      onSessionSwitch: () => null,
      onMemoryWrite: () => null,
      onPreCompress: (messages, ctx) => {
        ctx = ctx || {};
        if (!isFn(compactionMemoryBlock)) return '';
        const recs = records(ctx);
        if (!recs.length) return '';
        const text = ctx.text || messagesText(messages);
        return compactionMemoryBlock(recs, text, {
          now: now(ctx),
          k: ctx.k || 5,
          limit: ctx.limit || 800,
          streamId: ctx.streamId || null
        });
      },
      toolDefs: () => []
    };
  }

  return { makeMemoryManager, makeLocalCortexProvider };
});
