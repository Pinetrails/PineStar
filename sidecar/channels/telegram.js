/* sidecar/channels/telegram.js — Telegram as the first concrete channel (C2).

   Composes the two pure pieces into a ready adapter: the generic transport-agnostic pipeline
   (channels/adapter.js) + the Bot API fetch transport (channels/telegram.transport.js) + a Telegram-specific
   `normalize(update)` that turns a raw Bot API Update into the adapter's neutral shape. This is the analogue of
   a Hermes platform subclass: it supplies ONLY the wire translation (normalize) and the limits (4096), and
   inherits the loop/offset/admission/onInbound/send/backoff from the generic adapter.

     makeTelegramAdapter({ fetch, token, apiBase?, allowedChats?, onInbound, onCallback?, onStatus?, clock,
                           pollTimeoutSec?, backoffMs?, sleep?, startOffset? }) -> adapter

   `normalize` maps the two update kinds we admit:
     • a TEXT message  -> { offset, message }   (chat.type 'private' => 'dm', else 'group')
     • a callback_query -> { offset, callback }  (inline-keyboard taps, used by consent in C6)
     • anything else (sticker/photo/edited/…) -> { offset, message:null }  (advance the offset, deliver nothing)
   It is pure and exported standalone so the parse is unit-tested without any transport. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./adapter.js'), require('./telegram.transport.js'));
  } else {
    root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {};
    root.SK.channels.telegram = factory(root.SK.channels.adapter, root.SK.channels.telegramTransport);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (adapterMod, transportMod) {
  'use strict';

  const { makeChannelAdapter } = adapterMod;
  const { makeTelegramTransport } = transportMod;

  const MAX_MESSAGE_LENGTH = 4096;   // Bot API hard limit, in UTF-16 code units == JS String.length (no utf16_len port)

  function normalize(u) {
    if (!u || typeof u.update_id !== 'number') return null;   // not a real update -> skip without advancing
    const offset = u.update_id;
    if (u.message && typeof u.message.text === 'string') {
      const m = u.message;
      const chat = m.chat || {};
      const from = m.from || {};
      return { offset: offset, message: {
        chatId: chat.id,
        chatType: chat.type === 'private' ? 'dm' : 'group',
        userId: from.id,
        userName: from.username || from.first_name,
        text: m.text,
        messageId: m.message_id
      } };
    }
    if (u.callback_query) {
      const cq = u.callback_query;
      const chat = (cq.message && cq.message.chat) || {};
      return { offset: offset, callback: {
        chatId: chat.id,
        userId: cq.from && cq.from.id,
        data: cq.data,
        callbackId: cq.id,
        messageId: cq.message && cq.message.message_id
      } };
    }
    return { offset: offset, message: null };   // non-text/other update: advance past it, deliver nothing
  }

  function makeTelegramAdapter(opts) {
    const o = opts || {};
    const transport = makeTelegramTransport({ fetch: o.fetch, token: o.token, apiBase: o.apiBase });
    return makeChannelAdapter({
      transport: transport,
      normalize: normalize,
      name: 'telegram',
      maxMessageLength: MAX_MESSAGE_LENGTH,
      allowedChats: o.allowedChats,
      onInbound: o.onInbound,
      onCallback: o.onCallback,
      onStatus: o.onStatus,
      clock: o.clock,
      pollTimeoutSec: o.pollTimeoutSec,
      backoffMs: o.backoffMs,
      sleep: o.sleep,
      startOffset: o.startOffset
    });
  }

  return { makeTelegramAdapter, normalize, MAX_MESSAGE_LENGTH };
});
