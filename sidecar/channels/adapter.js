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
    function ownerOk(userId) {
      const uid = String(userId == null ? '' : userId);
      if (!owner) { if (!uid) return false; owner = uid; if (onOwnerClaim) { try { onOwnerClaim(uid); } catch (_) {} } return true; }
      return uid === owner;
    }

    // DM-only first cut: a direct message is always admitted; a group/channel message only if whitelisted.
    function admitted(m) {
      if (m.chatType === 'dm') return true;
      return allowed.has(String(m.chatId));
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
      try { n = normalize(raw); } catch (e) { return; }   // a malformed update is skipped, never crashes the loop
      if (!n) return;                                       // non-text / uninteresting update
      if (Number.isFinite(n.offset)) offset = Math.max(offset, n.offset + 1);   // advance so each update is processed once
      if (n.message) {
        const m = n.message;
        if (!admitted(m)) return;
        if (m.chatType === 'dm' && !ownerOk(m.userId)) return;   // a non-owner DM never reaches the run host
        onInbound({
          channel: name,
          chatId: String(m.chatId),
          chatType: m.chatType === 'group' ? 'group' : 'dm',
          userId: m.userId == null ? '' : String(m.userId),
          userName: m.userName,
          text: m.text == null ? '' : String(m.text),
          messageId: m.messageId == null ? '' : String(m.messageId),
          ts: clock.now()
        });
      } else if (n.callback && onCallback) {
        if (!owner || String(n.callback.userId) === owner) onCallback(n.callback);   // only the owner's taps act
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
                }
              }
              // the next poll uses `offset` (= last backlog id + 1), which confirms+discards the backlog; we did NOT dispatch it.
              // Best-effort notice: never throw (a failed notice must not stop connect); the loop below still starts.
              for (const [cid, count] of droppedByChat) {
                if (stopped) break;
                const plural = count === 1 ? 'message' : 'messages';
                try { await transport.send(cid, 'I was offline — ' + count + ' ' + plural + ' arrived while I was away and were not processed.', {}); }
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
