/* node test/freshstart.test.js — unreachable-screen reset ordering and browser-state scope. */
'use strict';
const A = require('./_assert.js');
const FreshStart = require('../frontend/app/freshstart.js');

function storage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] || null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    removeItem(k) { map.delete(k); },
    snapshot() { return Object.fromEntries(map); }
  };
}

(async () => {
  const store = storage({
    'starnet.save': 'station',
    'starnet.dev.pullFault': 'unreachable',
    'skynet.save': 'legacy',
    'unrelated.host.preference': 'keep'
  });
  let sawCacheBeforeNative = false;
  const result = await FreshStart.resetDesktop({
    async invoke(command) {
      A.eq(command, 'starnet_start_fresh', 'uses the native path that works without sidecar HTTP');
      sawCacheBeforeNative = store.getItem('starnet.save') === 'station';
      return { ok: true, listening: true, quarantine: 'safe-copy' };
    }
  }, store);
  A.eq(sawCacheBeforeNative, true, 'durable quarantine succeeds before browser cache is cleared');
  A.eq(result.listening, true, 'native listening truth is returned to the gate');
  A.eq(result.browserKeysCleared, 3, 'both StarNet namespaces are cleared');
  A.eq(store.snapshot(), { 'unrelated.host.preference': 'keep' }, 'unrelated origin state is untouched');

  const refused = storage({ 'starnet.save': 'last-readable-copy' });
  let error = '';
  try {
    await FreshStart.resetDesktop({ async invoke() { throw new Error('workspace still owned'); } }, refused);
  } catch (e) { error = String(e && e.message || e); }
  A.ok(error.includes('workspace still owned'), 'native refusal reaches the user');
  A.eq(refused.getItem('starnet.save'), 'last-readable-copy', 'failed preservation never clears the browser fallback');

  A.report('freshstart.test');
})().catch(e => { console.log('FAIL: unhandled — ' + (e && e.stack || e)); process.exit(1); });
