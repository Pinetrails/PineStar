/* STARNET — freshstart.js
   Desktop-only last-resort reset used when the sidecar is too sick to serve its own recovery route.
   The native command quarantines durable station data first; only after that succeeds do we clear
   browser-owned StarNet state. OS-keychain credentials (including the linked credit account) are
   deliberately outside both operations. */
'use strict';

const FreshStart = (() => {
  const PREFIXES = ['starnet.', 'skynet.'];

  function clearBrowserState(storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return 0;
    const keys = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (PREFIXES.some(prefix => String(key || '').startsWith(prefix))) keys.push(key);
      }
      keys.forEach(key => store.removeItem(key));
      return keys.length;
    } catch (_) { return 0; }
  }

  async function resetDesktop(core, storage) {
    if (!core || typeof core.invoke !== 'function') throw new Error('desktop recovery is unavailable');
    // Native first: it moves the durable generation to quarantine and starts a clean sidecar.
    // Never erase the cache when native preservation fails — it may be the user's last readable copy.
    const result = await core.invoke('starnet_start_fresh');
    if (!result || result.ok !== true) throw new Error('StarNet could not preserve the prior station');
    const cleared = clearBrowserState(storage);
    return Object.assign({}, result, { browserKeysCleared: cleared });
  }

  return { clearBrowserState, resetDesktop };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FreshStart;
