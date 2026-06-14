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
      async getUpdates(args) {
        const a = args || {};
        const { data, res } = await call('getUpdates', {
          offset: a.offset, timeout: a.timeoutSec, allowed_updates: ALLOWED_UPDATES
        }, a.signal);
        if (data && data.ok) return Array.isArray(data.result) ? data.result : [];
        const code = (data && data.error_code) || (res && res.status) || 0;
        const err = new Error('telegram getUpdates failed: ' + code + ' ' + ((data && data.description) || ''));
        err.code = code;
        if (code === 401 || code === 404) err.fatal = true;   // invalid/unknown token -> stop polling for good
        throw err;
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
