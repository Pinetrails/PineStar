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
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./telegram.format.js'));
  else {
    root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {};
    root.SK.channels.telegramTransport = factory(root.SK.channels.telegramFormat);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fmt) {
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

      // getMe — validate a token and learn WHO this bot is ({ id, username, name }) BEFORE anything is persisted.
      // The multi-bot connect flow keys each bot instance by the stable numeric id (usernames can be renamed) and
      // uses the username as the card label. NEVER throws — { ok:false, error } lets the route answer a clean 400.
      async getMe() {
        try {
          const { data, res } = await call('getMe', {});
          if (data && data.ok && data.result && data.result.id != null) {
            return { ok: true, id: String(data.result.id), username: String(data.result.username || ''), name: String(data.result.first_name || '') };
          }
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: (data && data.description) || ('http ' + code) };
        } catch (e) {
          return { ok: false, error: (e && e.message) || 'network error' };
        }
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

      // sendChatAction — the "typing…" bubble (Hermes parity). Telegram shows it for ~5s per call; the hub's
      // keep-alive loop refreshes it while a run is in flight. NEVER throws — always { ok, error?, retryable?,
      // retryAfter? } (same normalized shape as send) so the hub's loop can back off on 429 or stop on a hard
      // error. Purely cosmetic: a failure here must never affect the real reply path.
      async sendChatAction(chatId, action) {
        try {
          const { data, res } = await call('sendChatAction', { chat_id: chatId, action: action || 'typing' });
          if (data && data.ok) return { ok: true };
          const code = (data && data.error_code) || (res && res.status) || 0;
          const retryAfter = data && data.parameters && data.parameters.retry_after;
          return { ok: false, error: (data && data.description) || ('http ' + code), retryable: code === 429 || code >= 500, retryAfter: retryAfter };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.aborted)) return { ok: false, error: 'aborted', retryable: false };
          return { ok: false, error: (e && e.message) || 'network error', retryable: true };
        }
      },

      // answerCallbackQuery — MANDATORY after every inline-keyboard tap. Telegram spins a loading indicator on the
      // button until this lands (and gives up after ~15s showing a client-side error), so an unanswered tap reads
      // as "the bot is broken" even when the decision was recorded fine. `text` (optional) pops a small toast.
      // NEVER throws — a failed ack is cosmetic and must not abort the decision it is acknowledging.
      async answerCallback(callbackId, text) {
        try {
          const payload = { callback_query_id: String(callbackId) };
          if (text) payload.text = String(text).slice(0, 200);   // Bot API caps the toast at 200 chars
          const { data, res } = await call('answerCallbackQuery', payload);
          if (data && data.ok) return { ok: true };
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: (data && data.description) || ('http ' + code) };
        } catch (e) {
          return { ok: false, error: (e && e.message) || 'network error' };
        }
      },

      // editMessageText — rewrite a message we already sent, and (by omitting reply_markup) STRIP its keyboard.
      // This is how a resolved prompt stops being tappable: the buttons are replaced by the decision they made,
      // in place, so the transcript reads as a record instead of a dead control. NEVER throws.
      // Telegram answers 400 "message is not modified" when the text is byte-identical — harmless and reported
      // as-is; callers treat any failure as cosmetic (the decision is already recorded server-side).
      async editMessage(chatId, messageId, text, editOpts) {
        const o2 = editOpts || {};
        const raw = text == null ? '' : String(text);
        const payload = { chat_id: chatId, message_id: messageId, text: raw };
        for (const k in o2) if (k !== 'signal' && Object.prototype.hasOwnProperty.call(o2, k)) payload[k] = o2[k];
        // Same markdown->HTML treatment as send(). Without it a consent card that was DELIVERED formatted would
        // be rewritten into raw `**syntax**` the instant its button was tapped — the exact leak send() fixes,
        // showing up at the one moment the member is looking straight at the message.
        let formatted = false;
        if (!payload.parse_mode && raw) {
          try {
            const f = fmt.toTelegramHtml(raw);
            if (f && f.converted) { payload.text = f.html; payload.parse_mode = 'HTML'; formatted = true; }
          } catch (_) { /* never cost the stamp over formatting */ }
        }
        try {
          let { data, res } = await call('editMessageText', payload, o2.signal);
          if (!(data && data.ok) && formatted && fmt.isParseError(data && data.description)) {
            const plain = { chat_id: chatId, message_id: messageId, text: fmt.toPlainText(raw) };
            for (const k in o2) if (k !== 'signal' && Object.prototype.hasOwnProperty.call(o2, k)) plain[k] = o2[k];
            delete plain.parse_mode;
            ({ data, res } = await call('editMessageText', plain, o2.signal));
          }
          if (data && data.ok) return { ok: true };
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: (data && data.description) || ('http ' + code) };
        } catch (e) {
          return { ok: false, error: (e && e.message) || 'network error' };
        }
      },

      // setMyCommands — publish the bot's command list so Telegram's blue "/" menu offers the SAME commands the
      // hub actually implements. Called once per connect from the hub's own command table (one source of truth),
      // so the menu can never drift from what `/help` claims or what parseCommand accepts. NEVER throws — an
      // empty menu is a cosmetic loss, never a reason to fail a connect.
      async setCommands(list) {
        try {
          const commands = (Array.isArray(list) ? list : [])
            .filter(c => c && c.command)
            .map(c => ({ command: String(c.command).toLowerCase().slice(0, 32), description: String(c.description || '').slice(0, 256) }))
            .slice(0, 100);   // Bot API hard cap
          const { data, res } = await call('setMyCommands', { commands: commands });
          if (data && data.ok) return { ok: true, count: commands.length };
          const code = (data && data.error_code) || (res && res.status) || 0;
          return { ok: false, error: (data && data.description) || ('http ' + code) };
        } catch (e) {
          return { ok: false, error: (e && e.message) || 'network error' };
        }
      },

      /* never throws: a network/abort/HTTP error becomes a SendResult so the adapter's bounded resend can run.

         MARKDOWN -> HTML (2026-07-28). Replies used to go out as plain text with no `parse_mode`, so an LLM's
         ordinary markdown landed on the phone as raw syntax — literal `**bold**`, backticks, `## headings`.
         channels/telegram.format.js converts the balanced subset it can prove is safe. A caller that sets its
         OWN parse_mode is left completely alone.

         THE FALLBACK IS THE POINT. A malformed entity string is a 400 and the message is LOST, which would be
         a far worse bug than the raw syntax we started with. So a parse rejection resends ONCE without
         parse_mode, stripped of the markdown punctuation — the floor is exactly the old behaviour, minus the
         syntax noise. Only entity errors are retried: a 403 (blocked) or "chat not found" fails identically
         the second time and must not be sent twice. */
      async send(chatId, text, sendOpts) {
        const o2 = sendOpts || {};
        const raw = text == null ? '' : String(text);
        const payload = { chat_id: chatId, text: raw };
        for (const k in o2) if (k !== 'signal' && Object.prototype.hasOwnProperty.call(o2, k)) payload[k] = o2[k];
        let formatted = false;
        if (!payload.parse_mode && raw) {
          try {
            const f = fmt.toTelegramHtml(raw);
            if (f && f.converted) { payload.text = f.html; payload.parse_mode = 'HTML'; formatted = true; }
          } catch (_) { /* a formatter fault must never cost the message — send it as-is */ }
        }
        try {
          let { data, res } = await call('sendMessage', payload, o2.signal);
          if (!(data && data.ok) && formatted && fmt.isParseError(data && data.description)) {
            const plain = { chat_id: chatId, text: fmt.toPlainText(raw) };
            for (const k in o2) if (k !== 'signal' && Object.prototype.hasOwnProperty.call(o2, k)) plain[k] = o2[k];
            delete plain.parse_mode;
            ({ data, res } = await call('sendMessage', plain, o2.signal));
          }
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
