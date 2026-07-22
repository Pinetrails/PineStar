/* sidecar/channels/telegram.transport.js — the ONLY network-touching piece of the Telegram channel (C2).

   A thin fetch wrapper over the Telegram Bot API (https://api.telegram.org/bot<token>/<method>), exposing the
   exact two methods the generic adapter (channels/adapter.js) drives:

     getUpdates({ offset, timeoutSec, signal }) -> Promise<Update[]>   // long-poll; returns the RAW Update[]
        (the injected `normalize` in telegram.js parses each one); THROWS on error so the adapter's poll loop
        governs backoff — a 401/404 (bad/closed token) is thrown with `.fatal=true` so the loop stops for good.
     send(chatId, text, opts?) -> Promise<SendResult>                  // sendMessage; NEVER throws — always a
        normalized { ok, messageId?, error?, retryable?, retryAfter? } so the adapter's one-shot resend can act.

   The bot token is held in closure and appears ONLY in the URL path — never on an event, the bus, or a log.
   `fetch` is INJECTED (index.js passes globalThis.fetch; tests pass a fake), so this module touches no real
   network under test and stays the lone ambient-I/O edge of the channel. Deterministic: no clock/rng/Date. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.telegramTransport = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALLOWED_UPDATES = ['message', 'callback_query'];   // ignore edited/channel/poll/etc. updates server-side
  const DEFAULT_API_BASE = 'https://api.telegram.org';

  function makeTelegramTransport(opts) {
    const o = opts || {};
    const fetchImpl = o.fetch;
    const token = o.token;
    if (typeof fetchImpl !== 'function') throw new Error('makeTelegramTransport: an injected fetch is required');
    if (!token || typeof token !== 'string') throw new Error('makeTelegramTransport: a bot token is required');
    const BASE = (o.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '') + '/bot' + token;   // token only ever here

    // one Bot API call -> { res, data }. data.ok distinguishes success ({result}) from error ({error_code,description}).
    async function call(method, payload, signal) {
      const res = await fetchImpl(BASE + '/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: signal
      });
      let data;
      try { data = await res.json(); }
      catch (e) { data = { ok: false, error_code: (res && res.status) || 0, description: 'non-JSON response' }; }
      return { res: res, data: data };
    }

    return {
      // best-effort: drop any webhook this bot token may still have set (a prior tutorial/curl/another tool),
      // which would otherwise make every getUpdates fail with 409. Never throws — a failure just means no webhook.
      async deleteWebhook() {
        try { await call('deleteWebhook', { drop_pending_updates: false }); } catch (_) {}
      },

      async getUpdates(args) {
        const a = args || {};
        const { data, res } = await call('getUpdates', {
          offset: a.offset, timeout: a.timeoutSec, allowed_updates: ALLOWED_UPDATES
        }, a.signal);
        if (data && data.ok) return Array.isArray(data.result) ? data.result : [];
        const code = (data && data.error_code) || (res && res.status) || 0;
        const desc = (data && data.description) || '';
        const err = new Error('telegram getUpdates failed: ' + code + ' ' + desc);
        err.code = code;
        if (code === 401 || code === 404) err.fatal = true;   // invalid/unknown token -> stop polling for good
        // 409: another poller or a webhook owns this token. We proactively deleteWebhook on connect, so a
        // persistent 409 means a SECOND instance is polling — stop with an actionable status instead of looping.
        if (code === 409 || /terminated by other getupdates|another.*instance|webhook is active/i.test(desc)) {
          err.fatal = true;
          err.message = 'another instance or a webhook is using this bot token — stop the other poller (or it will keep stealing updates)';
        }
        throw err;
      },

      // Download ONE file the user sent the bot (photo/video/voice/document bytes). Two-step Bot API dance:
      // getFile(file_id) -> result.file_path, then GET <apiBase>/file/bot<token>/<file_path>. NEVER throws —
      // always { ok, buffer?, error? } so the hub's per-item degrade stays a note, not a crashed inbound.
      // maxBytes (caller-supplied) refuses oversized bodies BEFORE buffering them (content-length when present,
      // else a post-read length check). The token appears only in the URL, same as every other call here.
      async getFile(fileId, opts2) {
        const o3 = opts2 || {};
        try {
          const { data } = await call('getFile', { file_id: String(fileId) }, o3.signal);
          if (!data || !data.ok || !data.result || !data.result.file_path) {
            return { ok: false, error: (data && data.description) || 'getFile failed' };
          }
          const url = (o.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '') + '/file/bot' + token + '/' + String(data.result.file_path);
          const res = await fetchImpl(url, { method: 'GET', signal: o3.signal });
          if (!res || !res.ok) return { ok: false, error: 'file download failed: http ' + ((res && res.status) || 0) };
          const max = Number(o3.maxBytes) > 0 ? Number(o3.maxBytes) : Infinity;
          const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
          if (len > max) return { ok: false, error: 'file too large (' + len + ' bytes)' };
          const ab = await res.arrayBuffer();
          const buffer = Buffer.from(ab);
          if (buffer.length > max) return { ok: false, error: 'file too large (' + buffer.length + ' bytes)' };
          if (!buffer.length) return { ok: false, error: 'empty file' };
          return { ok: true, buffer: buffer };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.aborted)) return { ok: false, error: 'aborted' };
          return { ok: false, error: (e && e.message) || 'network error' };
        }
      },

      // never throws: a network/abort/HTTP error becomes a SendResult so the adapter's bounded resend can run.
      async send(chatId, text, sendOpts) {
        const o2 = sendOpts || {};
        const payload = { chat_id: chatId, text: text };
        for (const k in o2) if (k !== 'signal' && Object.prototype.hasOwnProperty.call(o2, k)) payload[k] = o2[k];
        try {
          const { data, res } = await call('sendMessage', payload, o2.signal);
          if (data && data.ok) return { ok: true, messageId: String((data.result && data.result.message_id) != null ? data.result.message_id : '') };
          const code = (data && data.error_code) || (res && res.status) || 0;
          const retryAfter = data && data.parameters && data.parameters.retry_after;
          return { ok: false, error: (data && data.description) || ('http ' + code), retryable: code === 429 || code >= 500, retryAfter: retryAfter };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.aborted)) return { ok: false, error: 'aborted', retryable: false };
          return { ok: false, error: (e && e.message) || 'network error', retryable: true };   // transient transport failure
        }
      }
    };
  }

  return { makeTelegramTransport, ALLOWED_UPDATES, DEFAULT_API_BASE };
});
