/* sidecar/channels/adapter.js — the generic, transport-agnostic messaging-channel adapter (C1).

   The reference harness attaches an agent to ANY messaging platform through one transport-agnostic base
   class (`BasePlatformAdapter`) that owns the inbound poll/normalize/admission pipeline and a `send`, and
   translates the wire format into two normalized shapes — inbound `MessageEvent`, outbound `SendResult`.
   The agent runtime is reached through a single injected message-handler callback; the base imports no
   LLM/agent SDK. We re-derive the SMALLEST honest version of that shape for our Node sidecar:

     makeChannelAdapter({ transport, normalize, name, maxMessageLength, allowedChats,
                          onInbound, onCallback?, onStatus?, clock, pollTimeoutSec?, backoffMs?, sleep? })
       -> { name, MAX_MESSAGE_LENGTH, connect(), disconnect(), send(chatId,text,opts?), chatInfo(chatId) }

   The adapter is PURE and platform-agnostic: it owns the long-poll loop, offset tracking, the DM/allowlist
   admission gate, the timestamp stamp (from the injected clock), and the `onInbound(InboundMessage)` push
   to the runtime — it knows nothing of the loop/provider/agent (the runtime-agnostic half of the reference
   harness's contract). All wire I/O lives behind the injected `transport` (a thin fetch wrapper supplied by the
   composition root); every test injects a FAKE transport, so no test ever hits the network. The
   PLATFORM-SPECIFIC parse of a raw update is the injected `normalize(rawUpdate)` (Telegram supplies it in
   C2), keeping `transport` a dumb HTTPS shim.

   Normalized shapes (plain objects, no classes — Node, not Python dataclasses):
     InboundMessage = { channel, chatId, chatType:'dm'|'group', userId, userName?, text, messageId, ts }
     SendResult     = { ok, messageId?, error?, retryable? }

   Deterministic: no Date.now / Math.random / new Date() — `ts` comes from clock.now(); backoff is a fixed
   ladder with NO jitter; `sleep` is injected so tests advance instantly. Chunking the reply to the 4096
   limit is the HUB's job (C5), not the adapter's — `send` emits exactly one message. This commit ships the
   pure module + its fake-transport test only; the real Telegram transport (C2) and the run-host wiring (C5)
   come later. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.adapter = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_BACKOFF = [1000, 2000, 5000, 15000, 30000];   // fixed exponential ladder, capped, NO jitter (determinism)
  const DEFAULT_POLL_TIMEOUT_SEC = 50;                        // long-poll: a quiet getUpdates parks this long server-side

  // a poll error whose .fatal is set (e.g. a 401 invalid-token) stops the loop for good rather than backing off.
  const isFatal = (e) => !!(e && e.fatal);
  const isAbort = (e) => !!(e && (e.name === 'AbortError' || e.aborted));

  function normalizeAllowed(allowedChats) {
    const s = new Set();
    if (Array.isArray(allowedChats)) for (const c of allowedChats) s.add(String(c));
    else if (allowedChats && typeof allowedChats.forEach === 'function') allowedChats.forEach(c => s.add(String(c)));
    return s;
  }

  function makeChannelAdapter(opts) {
    const o = opts || {};
    const transport = o.transport;
    const normalize = o.normalize;
    if (!transport || typeof transport.getUpdates !== 'function' || typeof transport.send !== 'function')
      throw new Error('makeChannelAdapter: transport must provide getUpdates() and send()');
    if (typeof normalize !== 'function') throw new Error('makeChannelAdapter: normalize(rawUpdate) is required');
    const clock = o.clock;
    if (!clock || typeof clock.now !== 'function') throw new Error('makeChannelAdapter: an injected clock is required');

    const name = o.name || 'channel';
    const MAX_MESSAGE_LENGTH = o.maxMessageLength || 4096;
    const allowed = normalizeAllowed(o.allowedChats);
    const onInbound = typeof o.onInbound === 'function' ? o.onInbound : function () {};
    const onCallback = typeof o.onCallback === 'function' ? o.onCallback : null;   // C6: inline-keyboard taps
    const onStatus = typeof o.onStatus === 'function' ? o.onStatus : null;         // channel.connect telemetry
    const pollTimeoutSec = o.pollTimeoutSec || DEFAULT_POLL_TIMEOUT_SEC;
    const backoff = Array.isArray(o.backoffMs) && o.backoffMs.length ? o.backoffMs.slice() : DEFAULT_BACKOFF.slice();
    const sleep = typeof o.sleep === 'function' ? o.sleep : (ms => new Promise(r => setTimeout(r, ms)));
    const dropPending = o.dropPendingOnConnect === true;   // generic default OFF; the Telegram layer turns it on

    // owner-only admission for DMs (trust-on-first-use): the FIRST direct message claims ownership; every later
    // DM from a DIFFERENT user is dropped BEFORE onInbound — i.e. before any model key is spent or memory is read.
    // A preset ownerUserId (restored from saved config) skips the claim. Empty string == unclaimed. Group access
    // stays governed by allowedChats, independently.
    let owner = o.ownerUserId ? String(o.ownerUserId) : '';
    const onOwnerClaim = typeof o.onOwnerClaim === 'function' ? o.onOwnerClaim : null;
    // Chats whose offline backlog we discarded while the owner was still UNCLAIMED (a fresh install, or any
    // first contact). We cannot apologise at connect: claiming ownership from stale backlog is exactly the
    // anti-stale-directive behaviour we preserve, and answering a chat we have NOT yet proven is the owner
    // would break owner-only silence toward a stranger who found a discoverable bot. So the notice waits here
    // until that chat proves it IS the owner by sending a live message. Bounded — a flood of stranger DMs
    // while the bot was down must not grow this without limit.
    const deferredOfflineNotice = new Set();
    const MAX_DEFERRED_NOTICE = 50;
    // ONE wording for both paths. It deliberately states NO count: getUpdates({offset:-1}) returns only the
    // LAST pending update, yet advancing past it discards every earlier one too — so a tally of what we could
    // SEE would under-report what we actually DROPPED, and "1 message arrived" when three did is exactly the
    // kind of confident-but-wrong claim this project treats as a defect.
    const OFFLINE_NOTICE = 'I was offline — anything you sent while I was away was not processed. Please resend whatever still matters.';
    function ownerOk(userId) {
      const uid = String(userId == null ? '' : userId);
      if (!owner) { if (!uid) return false; owner = uid; if (onOwnerClaim) { try { onOwnerClaim(uid); } catch (_) {} } return true; }
      return uid === owner;
    }

    /* GROUP DISCIPLINE (2026-07-29). We used to answer EVERY message in a whitelisted group, and never checked
       whether the sender was a bot. In a room with any traffic that is a model call per message — the member
       pays for a conversation they are not in — and two StarNet bots in one group would answer each other
       forever. Three gates, each independently disableable, all no-ops for a DM:

         ignoreBots     (default ON)  — a message from another bot never runs. This one is not a preference:
                                        bot-to-bot is an unbounded spend loop with no human in it.
         requireMention (default ON)  — in a GROUP, run only when the message addresses us: an @mention of our
                                        username, a reply to one of OUR messages, or a slash command that is
                                        either bare or @-suffixed with our name. A group message that addresses
                                        nobody is somebody else's conversation.
         allowedUsers   (default off) — when set, only these user ids run, ON TOP of the existing owner gate for
                                        DMs and the chat allowlist for groups. It NARROWS, it never widens.

       A DM is untouched: it is already owner-only, and requiring the Commander to @-mention a bot in their own
       private chat would be absurd. */
    /* botUsername may be a STRING or a FUNCTION. The station bot learns its own @name from getMe() at connect,
       which resolves AFTER the adapter is constructed — a string captured here would be '' forever and the
       mention gate would sit permanently dormant (a flag with no reader, the exact bug class this project
       keeps re-finding). Reading it lazily means the gate arms the moment the name is known. */
    const botUsernameFn = (typeof o.botUsername === 'function') ? o.botUsername : () => o.botUsername;
    const botUsernameNow = () => String(botUsernameFn() || '').replace(/^@/, '').trim().toLowerCase();
    const requireMention = o.requireMention !== false;
    const ignoreBots = o.ignoreBots !== false;
    const allowedUsers = normalizeAllowed(o.allowedUsers);

    // Does this group message address US? (Only meaningful when botUsername is known.)
    function addressesUs(m) {
      const botUsername = botUsernameNow();
      if (!botUsername) return true;   // we don't know our own name — never silence the room over that
      const mentions = Array.isArray(m.mentions) ? m.mentions : [];
      if (mentions.indexOf(botUsername) !== -1) return true;
      // a reply to one of OUR messages is an address, and it is how a thread of follow-ups stays natural
      if (m.replyTo && String(m.replyTo.userName || '').trim().toLowerCase() === botUsername) return true;
      // a slash command with NO @suffix is aimed at whatever bot is listening; with a suffix it is aimed by name
      // (and that name landed in `mentions` above, so a command for a DIFFERENT bot has already failed the check)
      const t = String(m.text == null ? '' : m.text);
      if (/^\/[A-Za-z0-9_]+(\s|$)/.test(t)) return true;
      return false;
    }

    // DM-only first cut: a direct message is always admitted; a group/channel message only if whitelisted.
    function admitted(m) {
      if (ignoreBots && m.fromBot) return false;                       // never answer another bot, in any chat
      if (allowedUsers.size && !allowedUsers.has(String(m.userId == null ? '' : m.userId))) return false;
      if (m.chatType === 'dm') return true;
      if (!allowed.has(String(m.chatId))) return false;
      return requireMention ? addressesUs(m) : true;
    }

    let started = false, stopped = false, down = false, confirmed = false;
    let offset = Number.isFinite(o.startOffset) ? o.startOffset : 0;   // next update id to fetch from
    let ac = null;          // aborts the in-flight getUpdates on disconnect
    let loopDone = null;    // resolves when the poll loop has fully exited

    // HONEST CONNECT: `confirmed` stays false until the FIRST successful poll round-trip — only then do we assert
    // 'up'. Before that the channel is genuinely just 'connecting' (the composition root reports that state), so the
    // panel never claims CONNECTED on an unproven token. After the first success, statusUp/statusDown track live
    // transport health exactly as before (a transient error still emits 'down' then 'up' on recovery).
    function statusUp() {
      if (!confirmed) { confirmed = true; down = false; onStatus && onStatus({ state: 'up' }); return; }
      if (down) { down = false; onStatus && onStatus({ state: 'up' }); }
    }
    function statusDown(detail) { if (!down) { down = true; onStatus && onStatus({ state: 'down', detail: detail }); } }

    function dispatch(raw) {
      let n;
      try { n = normalize(raw); }
      catch (e) {
        /* A malformed update must be SKIPPED — which means getting past it, not just declining to handle it.
           Returning here without advancing left `offset` pinned to the bad update, and since getUpdates keeps
           returning everything at-or-after `offset` until a higher one confirms it, the poll loop would re-fetch
           and re-throw on the same update forever: a hot spin against the Bot API with the channel permanently
           deaf to every message behind it. Advance past it from the RAW id (the only field we still trust) so
           one unparseable update costs one dropped message instead of the whole channel. */
        const bad = raw && raw.update_id;
        if (Number.isFinite(bad)) offset = Math.max(offset, bad + 1);
        try { console.error('[' + name + '] unparseable update ' + String(bad) + ' skipped:', (e && e.message) || e); } catch (_) {}
        return;
      }
      if (!n) return;                                       // non-text / uninteresting update
      if (Number.isFinite(n.offset)) offset = Math.max(offset, n.offset + 1);   // advance so each update is processed once
      if (n.message) {
        const m = n.message;
        if (!admitted(m)) return;
        if (m.chatType === 'dm' && !ownerOk(m.userId)) return;   // a non-owner DM never reaches the run host
        // This chat had backlog discarded while the owner was unclaimed, and has now PROVEN it is the owner by
        // getting admitted. Pay the deferred apology before its reply — otherwise the Commander's first
        // impression of a bot that was simply switched off is silence, which is what a broken bot looks like.
        // Detached + best-effort by design: the notice must never delay or block the real message.
        if (deferredOfflineNotice.delete(String(m.chatId))) {
          Promise.resolve()
            .then(() => transport.send(String(m.chatId), OFFLINE_NOTICE, {}))
            .catch(e => { try { console.error('[' + name + '] deferred offline-notice failed for chat ' + m.chatId + ':', (e && e.message) || e); } catch (_) {} });
        }
        const im = {
          channel: name,
          chatId: String(m.chatId),
          chatType: m.chatType === 'group' ? 'group' : 'dm',
          userId: m.userId == null ? '' : String(m.userId),
          userName: m.userName,
          text: m.text == null ? '' : String(m.text),
          messageId: m.messageId == null ? '' : String(m.messageId),
          ts: clock.now()
        };
        // media rides through untouched (additive): [{ kind, fileId, name, mime, size }] from the platform's
        // normalize. The hub downloads the bytes via this adapter's getFile and turns them into attachments.
        // mediaGroupId marks one album part; the hub debounce-merges parts sharing it into a single turn.
        if (Array.isArray(m.media) && m.media.length) im.media = m.media;
        if (m.mediaGroupId != null && m.mediaGroupId !== '') im.mediaGroupId = String(m.mediaGroupId);
        // replyTo ({ text, userName?, fromBot?, media? }) rides through untouched, same additive contract as
        // media: the platform's normalize decides whether this message quotes an earlier one, the hub decides
        // how to render it. A platform that never sets it is byte-identical to before.
        if (m.replyTo && typeof m.replyTo === 'object') im.replyTo = m.replyTo;
        if (Array.isArray(m.mentions) && m.mentions.length) im.mentions = m.mentions.slice();
        onInbound(im);
      } else if (n.callback && onCallback) {
        /* Only the owner's taps act — and an UNCLAIMED owner is not a licence, it is the absence of one.
           `!owner ||` made this fail OPEN, and ownership is claimed on the DM path alone (a group message
           never calls ownerOk), so a bot reachable only in a whitelisted group had owner === '' forever and
           ANY member's tap counted — including approve/deny on the /approvals keyboards. A callback can
           never be the trust-on-first-use moment either: the keyboard is on a message WE sent, so it proves
           nothing about who is talking. Fail closed, exactly like the empty-userId DM case. */
        if (owner && String(n.callback.userId) === owner) onCallback(n.callback);
      }
    }

    // Client-side long-poll deadline: getUpdates parks server-side for pollTimeoutSec; a half-open socket can leave
    // the fetch hanging FAR past that (no bytes ever arrive). Race the poll against a hard wall-clock =
    // pollTimeoutSec*1000 + 15s slack so a stall aborts in seconds, not the ~5min default socket timeout. The
    // disconnect abort (ac.signal) still wins — we compose both so either fires; a deadline-fire is NOT a disconnect
    // (we distinguish by ac.signal.aborted below) so it just backs off and re-polls. Degrades gracefully on old
    // platforms without AbortSignal.any/timeout (then only ac.signal governs, as before).
    const POLL_DEADLINE_MS = pollTimeoutSec * 1000 + 15000;
    function pollSignal() {
      if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return ac.signal;
      const deadline = AbortSignal.timeout(POLL_DEADLINE_MS);
      return (typeof AbortSignal.any === 'function') ? AbortSignal.any([ac.signal, deadline]) : deadline;
    }

    async function loop() {
      let attempt = 0;
      while (!stopped) {
        let raw;
        try {
          raw = await transport.getUpdates({ offset: offset, timeoutSec: pollTimeoutSec, signal: pollSignal() });
        } catch (e) {
          // Only a REAL disconnect (stopped / the disconnect signal aborted) exits the loop. A deadline-timeout
          // abort has stopped=false and ac.signal.aborted=false, so it falls through to backoff+retry (a stalled
          // poll must recover, not kill the channel).
          if (stopped || (ac && ac.signal && ac.signal.aborted)) break;
          if (isFatal(e)) { onStatus && onStatus({ state: 'error', detail: (e && e.message) || 'fatal' }); break; }
          statusDown((e && e.message) || 'poll error');
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
          attempt++;
          continue;
        }
        attempt = 0;
        statusUp();
        const updates = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.updates) ? raw.updates : []);
        for (let i = 0; i < updates.length; i++) {
          if (stopped) break;
          dispatch(updates[i]);
        }
      }
    }

    return {
      name: name,
      MAX_MESSAGE_LENGTH: MAX_MESSAGE_LENGTH,

      // start the inbound long-poll loop; resolves once listening (the loop runs detached until disconnect()).
      // dropPendingOnConnect (default true): before the first real poll, prime the offset past everything already
      // buffered server-side (getUpdates offset:-1 returns only the last pending update) and DISCARD that backlog,
      // so a restart never replays hours of stale DMs and autonomously runs stale directives. Skipped when an
      // explicit startOffset was given (the caller pinned a resume point).
      connect() {
        if (started) return Promise.resolve();
        started = true; stopped = false;
        ac = new AbortController();
        loopDone = (async () => {
          // proactively clear any stale webhook on this token so getUpdates can't 409 forever (Telegram-only;
          // guarded so generic transports/fakes without the method are unaffected).
          if (typeof transport.deleteWebhook === 'function') { try { await transport.deleteWebhook(); } catch (_) {} }
          if (dropPending && !Number.isFinite(o.startOffset)) {
            try {
              const raw = await transport.getUpdates({ offset: -1, timeoutSec: 0, signal: ac.signal });
              const ups = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.updates) ? raw.updates : []);
              // Count the backlog we're about to DISCARD and remember which chat(s) it came from, so we can post a
              // one-line "I was offline" notice per chat (honesty: the message arrived and was NOT processed). We
              // only count messages that WOULD have been admitted (owner DM / whitelisted group) — a stranger's DM
              // or an off-list group was never going to run, so its drop needs no apology and no key spend.
              const droppedByChat = new Map();   // chatId -> count of admitted-but-discarded backlog messages
              for (const ru of ups) {
                let n; try { n = normalize(ru); } catch (_) {}
                if (n && Number.isFinite(n.offset)) offset = Math.max(offset, n.offset + 1);
                // Pure admission peek — must NOT mutate owner state. ownerOk() claims ownership as a side effect,
                // so we can't call it here (that would let a STALE backlog DM claim the account). A DM counts only
                // when the owner is already known and matches; if the owner is still unclaimed we discard silently
                // (claiming from stale backlog is exactly the anti-stale-directive behavior we're preserving).
                const m = n && n.message;
                const admit = m && (m.chatType === 'dm'
                  ? (!!owner && String(m.userId == null ? '' : m.userId) === owner)
                  : allowed.has(String(m.chatId)));
                if (admit) {
                  const cid = String(m.chatId);
                  droppedByChat.set(cid, (droppedByChat.get(cid) || 0) + 1);
                } else if (m && m.chatType === 'dm' && !owner && deferredOfflineNotice.size < MAX_DEFERRED_NOTICE) {
                  // Owner still unclaimed, so we cannot tell yet whether this is the Commander or a stranger.
                  // DEFER the apology rather than drop it: this is the first-run case where someone messages a
                  // bot that is not running, and answering with nothing at all reads as a broken bot.
                  deferredOfflineNotice.add(String(m.chatId));
                }
              }
              // the next poll uses `offset` (= last backlog id + 1), which confirms+discards the backlog; we did NOT dispatch it.
              // Best-effort notice: never throw (a failed notice must not stop connect); the loop below still starts.
              for (const cid of droppedByChat.keys()) {
                if (stopped) break;
                try { await transport.send(cid, OFFLINE_NOTICE, {}); }
                catch (e) { try { console.error('[' + name + '] offline-notice send failed for chat ' + cid + ':', (e && e.message) || e); } catch (_) {} }
              }
            } catch (e) { if (stopped || isAbort(e)) return; /* fatal/transient handled by the loop below */ }
          }
          if (!stopped) await loop();
        })();
        return Promise.resolve();
      },

      // stop the loop and abort the in-flight getUpdates; resolves once the loop has fully exited.
      async disconnect() {
        stopped = true;
        try { if (ac) ac.abort(); } catch (_) {}
        try { await loopDone; } catch (_) {}
        started = false;
      },

      // send ONE message (the hub chunks long replies to MAX_MESSAGE_LENGTH before calling this). A transport
      // result with { ok:false, retryable:true } gets exactly ONE bounded resend (the reference harness's bounded-resend, minimal),
      // and on a 429 we WAIT out the server's retry_after (capped) first, so the resend lands after the flood window
      // instead of bouncing instantly into it.
      async send(chatId, text, sendOpts) {
        const t = text == null ? '' : String(text);
        let r = await transport.send(String(chatId), t, sendOpts || {});
        if (r && r.ok === false && r.retryable) {
          const waitMs = Math.min((Number(r.retryAfter) > 0 ? Number(r.retryAfter) : 1) * 1000, 30000);
          await sleep(waitMs);
          r = await transport.send(String(chatId), t, sendOpts || {});
        }
        return r;
      },

      // Fire one "typing…" chat-action (transport-optional, like getFile): { ok, error?, retryable?, retryAfter? },
      // never throws. A transport without sendChatAction answers ok:false NON-retryable, so the hub's keep-alive
      // loop stops after one probe instead of hammering a channel that can't show typing at all.
      chatAction(chatId) {
        if (typeof transport.sendChatAction !== 'function') return Promise.resolve({ ok: false, error: 'typing not supported on this channel', retryable: false });
        try { return Promise.resolve(transport.sendChatAction(String(chatId))); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'sendChatAction threw', retryable: false }); }
      },

      // ---- inline-keyboard round-trip (C6) ---------------------------------------------------------------
      // All three are transport-OPTIONAL and follow the chatAction/getFile pattern exactly: a channel whose
      // transport lacks the method answers { ok:false, error } instead of throwing, and the hub then falls back
      // to its numbered-text rendering. That fallback is what keeps Discord/Slack/Matrix/Signal working unchanged
      // while Telegram gets real buttons.

      // Acknowledge one inline-keyboard tap (kills the button's spinner; optional toast text).
      answerCallback(callbackId, text) {
        if (typeof transport.answerCallback !== 'function') return Promise.resolve({ ok: false, error: 'inline keyboards not supported on this channel' });
        try { return Promise.resolve(transport.answerCallback(String(callbackId), text)); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'answerCallback threw' }); }
      },

      // Rewrite an already-sent message (and strip its keyboard by omitting reply_markup from opts).
      editMessage(chatId, messageId, text, editOpts) {
        if (typeof transport.editMessage !== 'function') return Promise.resolve({ ok: false, error: 'message editing not supported on this channel' });
        try { return Promise.resolve(transport.editMessage(String(chatId), String(messageId), text == null ? '' : String(text), editOpts || {})); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'editMessage threw' }); }
      },

      // Publish the bot's slash-command menu (one-shot, at connect).
      setCommands(list) {
        if (typeof transport.setCommands !== 'function') return Promise.resolve({ ok: false, error: 'command menus not supported on this channel' });
        try { return Promise.resolve(transport.setCommands(list)); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'setCommands threw' }); }
      },

      // ---- OUTBOUND MEDIA (transport-optional, same probe-and-degrade contract) ---------------------------
      // A channel whose transport cannot upload answers { ok:false, error } and the hub falls back to naming
      // the file's workspace path in text. That fallback is the whole reason this is a capability method and
      // not a hard dependency: Discord/Slack/Matrix/Signal keep working untouched until they grow their own.
      sendMedia(chatId, item, mediaOpts) {
        if (typeof transport.sendMedia !== 'function') return Promise.resolve({ ok: false, error: 'sending files is not supported on this channel', retryable: false });
        try { return Promise.resolve(transport.sendMedia(String(chatId), item, mediaOpts || {})); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'sendMedia threw', retryable: false }); }
      },

      sendMediaGroup(chatId, items, groupOpts) {
        if (typeof transport.sendMediaGroup !== 'function') return Promise.resolve({ ok: false, error: 'albums are not supported on this channel', retryable: false });
        try { return Promise.resolve(transport.sendMediaGroup(String(chatId), items, groupOpts || {})); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'sendMediaGroup threw', retryable: false }); }
      },

      // Download one media file's bytes (transport-optional): { ok, buffer?, error? }, never throws. A transport
      // without getFile answers honestly instead of pretending — the hub's note then says media isn't supported.
      getFile(fileId, opts2) {
        if (typeof transport.getFile !== 'function') return Promise.resolve({ ok: false, error: 'media download not supported on this channel' });
        try { return Promise.resolve(transport.getFile(fileId, opts2)); }
        catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || 'getFile threw' }); }
      },

      // minimal identity (the reference harness's chat-info lookup -> {name,type}); transports may override with a richer lookup.
      chatInfo(chatId) {
        if (typeof transport.chatInfo === 'function') return transport.chatInfo(String(chatId));
        return { id: String(chatId), type: allowed.has(String(chatId)) ? 'group' : 'dm' };
      },

      _internals: { admitted, ownerOk, normalizeAllowed, dispatch, isFatal, isAbort, DEFAULT_BACKOFF, get offset() { return offset; }, get owner() { return owner; } }
    };
  }

  return { makeChannelAdapter, normalizeAllowed, _internals: { isFatal, isAbort, DEFAULT_BACKOFF, DEFAULT_POLL_TIMEOUT_SEC } };
});
