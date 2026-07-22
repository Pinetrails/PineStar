/* sidecar/channels/telegram.js — Telegram as the first concrete channel (C2).

   Composes the two pure pieces into a ready adapter: the generic transport-agnostic pipeline
   (channels/adapter.js) + the Bot API fetch transport (channels/telegram.transport.js) + a Telegram-specific
   `normalize(update)` that turns a raw Bot API Update into the adapter's neutral shape. This is the analogue of
   a platform subclass in the reference harness: it supplies ONLY the wire translation (normalize) and the limits (4096), and
   inherits the loop/offset/admission/onInbound/send/backoff from the generic adapter.

     makeTelegramAdapter({ fetch, token, apiBase?, allowedChats?, onInbound, onCallback?, onStatus?, clock,
                           pollTimeoutSec?, backoffMs?, sleep?, startOffset? }) -> adapter

   `normalize` maps the update kinds we admit:
     • a TEXT message   -> { offset, message }   (chat.type 'private' => 'dm', else 'group')
     • a MEDIA message  -> { offset, message }   with message.media = [{ kind, fileId, name, mime, size }] and
       message.text = the caption (may be ''). Photos pick the LARGEST size; videos/animations/video notes also
       carry their server-generated preview thumbnail as an extra { kind:'photo' } item so a vision model can SEE
       a frame of the clip even though no provider ingests raw video. Static stickers ride as webp photos.
     • a callback_query -> { offset, callback }  (inline-keyboard taps, used by consent in C6)
     • anything else (edited/poll/…) -> { offset, message:null }  (advance the offset, deliver nothing)
   It is pure and exported standalone so the parse is unit-tested without any transport. Downloading the actual
   bytes is the transport's getFile (driven by the hub); normalize only names WHAT arrived. */
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

  // Collect the media payloads of one Bot API Message into neutral { kind, fileId, name, mime, size } items.
  // `kind` is what the HUB acts on: 'photo' (viewable image), 'video'/'audio'/'document' (saved to the workspace
  // as files). A clip's preview thumbnail rides as its OWN 'photo' item (name marks it as a frame) so the model
  // gets real pixels from the clip. Pure; unknown/absent fields degrade to '' / 0, never throw.
  function mediaOf(m) {
    const items = [];
    const push = function (kind, f, name, mime) {
      if (!f || f.file_id == null) return;
      items.push({ kind: kind, fileId: String(f.file_id), name: String(name || 'file'),
                   mime: String(mime || ''), size: Number(f.file_size) || 0 });
    };
    const thumbOf = function (o) { return o && (o.thumbnail || o.thumb); };   // Bot API 6.x renamed thumb -> thumbnail
    if (Array.isArray(m.photo) && m.photo.length) {
      push('photo', m.photo[m.photo.length - 1], 'photo.jpg', 'image/jpeg');   // sizes are ordered small -> large
    }
    if (m.video) {
      push('video', m.video, m.video.file_name || 'video.mp4', m.video.mime_type || 'video/mp4');
      push('photo', thumbOf(m.video), 'video-preview-frame.jpg', 'image/jpeg');
    }
    if (m.animation) {
      push('video', m.animation, m.animation.file_name || 'animation.mp4', m.animation.mime_type || 'video/mp4');
      push('photo', thumbOf(m.animation), 'animation-preview-frame.jpg', 'image/jpeg');
    }
    if (m.video_note) {
      push('video', m.video_note, 'video-note.mp4', 'video/mp4');
      push('photo', thumbOf(m.video_note), 'video-note-preview-frame.jpg', 'image/jpeg');
    }
    if (m.voice) push('audio', m.voice, 'voice-message.ogg', m.voice.mime_type || 'audio/ogg');
    if (m.audio) push('audio', m.audio, m.audio.file_name || 'audio.mp3', m.audio.mime_type || 'audio/mpeg');
    if (m.document) push('document', m.document, m.document.file_name || 'file', m.document.mime_type || '');
    if (m.sticker && !m.sticker.is_animated && !m.sticker.is_video) push('photo', m.sticker, 'sticker.webp', 'image/webp');
    return items;
  }

  function normalize(u) {
    if (!u || typeof u.update_id !== 'number') return null;   // not a real update -> skip without advancing
    const offset = u.update_id;
    if (u.message && (typeof u.message.text === 'string' || mediaOf(u.message).length)) {
      const m = u.message;
      const chat = m.chat || {};
      const from = m.from || {};
      const media = mediaOf(m);
      const msg = {
        chatId: chat.id,
        chatType: chat.type === 'private' ? 'dm' : 'group',
        userId: from.id,
        userName: from.username || from.first_name,
        text: typeof m.text === 'string' ? m.text : (typeof m.caption === 'string' ? m.caption : ''),
        messageId: m.message_id
      };
      if (media.length) msg.media = media;   // additive — text-only messages keep the exact old shape
      // album marker: N messages of one album share media_group_id; the hub debounce-merges them into ONE turn
      if (media.length && m.media_group_id != null) msg.mediaGroupId = String(m.media_group_id);
      return { offset: offset, message: msg };
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
      startOffset: o.startOffset,
      ownerUserId: o.ownerUserId,
      onOwnerClaim: o.onOwnerClaim,
      dropPendingOnConnect: o.dropPendingOnConnect !== false   // Telegram default: discard offline backlog on connect
    });
  }

  return { makeTelegramAdapter, normalize, mediaOf, MAX_MESSAGE_LENGTH };
});
