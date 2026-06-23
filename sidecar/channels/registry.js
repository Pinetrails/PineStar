/* sidecar/channels/registry.js — the channel registry + a generic wire-up (H6.2).

   Telegram was bound by ~90 lines of bespoke wiring in index.js; Discord shipped a fully-tested adapter
   (channels/discord.js + .transport.js) that the host NEVER started — so "Discord support" existed in code but
   not in the running app. This module is the missing seam: a small DESCRIPTOR list ({ id, makeAdapter, transport,
   maxMessageLength, env }) plus `wireChannel(descriptor, deps)` that builds the SAME makeChannelHub + the
   descriptor's adapter and returns them connected-ready. One generic path drives every channel through the one
   real `runOnce`, so adding a channel is a registry row, not a fork. Enterprise surfaces (slack/signal/matrix)
   are deliberately OUT (off-moat).

   The live gateways still need a real token to connect for real — but the registry + wire path is fully testable
   with an injected adapter factory + fake hub, exactly as the per-channel adapter tests already inject transports.

     makeChannelRegistry({ adapters?, extra? }) -> { list, ids, has, get, register }
     wireChannel(descriptor, { hub, adapter, makeHub? }) -> { hub, adapter }   // send-ref closure tied for you */
'use strict';
(function (root, factory) {
  const api = factory(
    (typeof require === 'function') ? require('./hub.js') : (root.SK && root.SK.channels && { makeChannelHub: root.SK.channels.hub && root.SK.channels.hub.makeChannelHub }),
    (typeof require === 'function') ? require('./telegram.js') : (root.SK && root.SK.channels && root.SK.channels.telegram),
    (typeof require === 'function') ? require('./discord.js') : (root.SK && root.SK.channels && root.SK.channels.discord)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.registry = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (hubMod, tgMod, dcMod) {
  'use strict';
  const makeChannelHubDefault = hubMod && hubMod.makeChannelHub;

  // the two SUPPORTED channels. env names mirror index.js's existing auto-start (token + shared key/model).
  function defaultDescriptors(adapters) {
    const a = adapters || {};
    return [
      { id: 'telegram', label: 'Telegram', maxMessageLength: 4096,
        makeAdapter: a.telegram || (tgMod && tgMod.makeTelegramAdapter),
        env: { tokenVar: 'SKYNET_TELEGRAM_TOKEN', keyVar: 'SKYNET_OPENROUTER_KEY', modelVar: 'SKYNET_DEFAULT_MODEL' } },
      { id: 'discord', label: 'Discord', maxMessageLength: (dcMod && dcMod.MAX_MESSAGE_LENGTH) || 2000,
        makeAdapter: a.discord || (dcMod && dcMod.makeDiscordAdapter),
        env: { tokenVar: 'SKYNET_DISCORD_TOKEN', keyVar: 'SKYNET_OPENROUTER_KEY', modelVar: 'SKYNET_DEFAULT_MODEL' } }
    ];
  }

  function makeChannelRegistry(opts) {
    opts = opts || {};
    const map = new Map();
    const add = (d) => { if (d && d.id) map.set(String(d.id), d); };
    defaultDescriptors(opts.adapters).forEach(add);
    (opts.extra || []).forEach(add);   // tests/host can register additional descriptors
    return {
      list() { return Array.from(map.values()); },
      ids() { return Array.from(map.keys()); },
      has(id) { return map.has(String(id)); },
      get(id) { return map.get(String(id)) || null; },
      register(d) { add(d); return this; }
    };
  }

  // build hub + adapter for ONE descriptor, tying the send-ref closure (hub.send -> adapter.send) and routing the
  // adapter's inbound/callback/status into the hub. `deps.hub` is the makeChannelHub bag MINUS channel/send/
  // maxMessageLength (filled here); `deps.adapter` is the adapter-specific bag (fetch/token/clock/owner...).
  function wireChannel(descriptor, deps) {
    if (!descriptor || typeof descriptor.makeAdapter !== 'function') throw new Error('wireChannel: descriptor.makeAdapter required');
    deps = deps || {};
    const makeHub = deps.makeHub || makeChannelHubDefault;
    if (typeof makeHub !== 'function') throw new Error('wireChannel: makeChannelHub unavailable');
    let adapterRef = null;
    const hub = makeHub(Object.assign({
      channel: descriptor.id,
      maxMessageLength: descriptor.maxMessageLength,
      send: (chatId, text, o) => adapterRef ? adapterRef.send(chatId, text, o) : Promise.resolve({ ok: false, error: 'no adapter' })
    }, deps.hub));
    const adapterOpts = Object.assign({}, deps.adapter, {
      onInbound: (deps.adapter && deps.adapter.onInbound) || hub.onInbound,
      onCallback: (deps.adapter && deps.adapter.onCallback) || hub.onCallback,
      onStatus: (deps.adapter && deps.adapter.onStatus) || hub.onStatus
    });
    const adapter = descriptor.makeAdapter(adapterOpts);
    adapterRef = adapter;
    return { hub, adapter };
  }

  return { makeChannelRegistry, wireChannel, _internals: { defaultDescriptors } };
});
