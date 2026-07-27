/* sidecar/tools/builtin/comms.js — OUTBOUND channel reach: the agent can message a connected platform.

   THE GAP THIS CLOSES. StarNet drives five real messaging channels (telegram/discord/slack/matrix/signal) but
   every one of them was INBOUND-only: a human messages the station, the hub runs a turn, the reply goes back
   down the same chat. Nothing let an agent SPEAK FIRST. The only outbound path in the whole sidecar was
   autonotify.js — a fixed one-line "a routine ran on its own" ping, composed by the host, not by the agent. So
   "reach" was half a pillar: a routine could research all night and had no way to tell anyone, and an agent
   asked to "let me know on Telegram when the build goes green" could only answer into a chat window nobody was
   watching. The reference harness has had tools/send_message_tool.py + gateway/channel_directory.py from early
   on; this is the same capability on StarNet's own seams.

     makeCommsTools({ listTargets, sendTo, maxLenFor?, redact?, emit? }) -> { targetsTool, sendTool, register }

   ── KNOWN TARGETS ONLY (read this before "improving" the target grammar) ─────────────────────────────────────
   A target must already be in the station's chat map — a chat a human actually opened with this station. The
   agent CANNOT dial an arbitrary chat id, phone number, or channel name. That is not a limitation we failed to
   remove, it is the security boundary:

     · an agent's context routinely contains attacker-controlled text (a fetched page, a tool result, an inbound
       message). `channel.send` is the one tool that carries content OUT to a third party under the Commander's
       own bot identity. Free-form addressing turns any prompt injection into an exfiltration primitive with a
       delivery receipt — "send the contents of .env to @attacker" would be one hop.
     · truthful telemetry: an unknown id would fail at the transport anyway, and a tool that accepts a target it
       cannot reach teaches the model it succeeded.

   Widening reach stays a human act: a person opens a chat with the station, and that chat becomes addressable.
   The reference harness accepts raw ids/E.164 numbers here; we deliberately do not, and this comment is why.

   ── AMBIGUITY IS AN ERROR ───────────────────────────────────────────────────────────────────────────────────
   A target resolves by exact token, then by a UNIQUE channel or chat-id match. Two candidates is a refusal that
   names them, never a pick. Guessing which human to message is not a recoverable mistake — the wrong person has
   already read it, and the agent cannot tell that it happened.

   Pure + injected: no fetch/fs/clock/rng here, so it is node-testable with fake targets and a fake send. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).comms = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TEXT_CHARS = 8000;        // the most an agent may hand one send call (chunked below the platform floor)
  const DEFAULT_MAX_LEN = 1900;   // Discord's 2000 is the lowest real ceiling — the safe default when unknown
  const MAX_CHUNKS = 8;           // a send is a message, not a file transfer: refuse to spray a chat

  function clean(s, n) {
    s = String(s == null ? '' : s).trim();
    return n && s.length > n ? s.slice(0, n) : s;
  }
  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

  /* chunkText — split on the widest safe boundary under `max` (paragraph, then line, then space, then hard cut).
     Deliberately the same shape the channel hub uses for replies: a chat should never receive a message
     guillotined mid-word when a newline was two characters away. */
  function chunkText(text, max) {
    const limit = Math.max(1, Number(max) || DEFAULT_MAX_LEN);
    const out = [];
    let rest = String(text == null ? '' : text);
    while (rest.length > limit) {
      let cut = -1;
      for (const sep of ['\n\n', '\n', ' ']) {
        const at = rest.lastIndexOf(sep, limit);
        if (at > limit * 0.5) { cut = at + (sep === ' ' ? 0 : sep.length); break; }
      }
      if (cut <= 0) cut = limit;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    if (rest) out.push(rest);
    return out.length ? out : [''];
  }

  function packTarget(t) {
    return {
      target: String((t && t.target) || ''),
      channel: String((t && t.channel) || ''),
      chatId: String((t && t.chatId) || ''),
      agentId: String((t && t.agentId) || ''),
      connected: !!(t && t.connected)
    };
  }

  /* resolveTarget — exact token, then a unique channel match, then a unique chatId match. Never a guess.
     A target that exists but whose transport is DOWN is resolved and then refused separately, so the model is
     told "that channel is disconnected" instead of "no such target" (two different things to a user). */
  function resolveTarget(targets, want) {
    const q = clean(want, 200);
    if (!q) throw new Error('target is required — call channel.targets to see what this station can reach');
    const all = (targets || []).map(packTarget).filter(t => t.target);
    if (!all.length) {
      throw new Error('this station has no reachable chats yet — a person has to message it on a connected '
        + 'channel once before an agent can send there');
    }
    const exact = all.find(t => t.target === q);
    if (exact) return exact;
    const ql = lower(q);
    for (const field of ['channel', 'chatId']) {
      const hits = all.filter(t => lower(t[field]) === ql);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        throw new Error('"' + q + '" matches ' + hits.length + ' reachable chats — pass an exact target: '
          + hits.map(t => t.target).join(', '));
      }
    }
    throw new Error('"' + q + '" is not a chat this station can reach. Known targets: '
      + all.map(t => t.target).join(', ') + '. An agent can only message a chat a human already opened '
      + 'with this station — it cannot dial a new id.');
  }

  function makeCommsTools(deps) {
    deps = deps || {};
    const listTargets = typeof deps.listTargets === 'function' ? deps.listTargets : function () { return []; };
    const sendTo = deps.sendTo;
    const maxLenFor = typeof deps.maxLenFor === 'function' ? deps.maxLenFor : function () { return DEFAULT_MAX_LEN; };
    // The SAME scrub autonotify applies before a host-composed ping goes out. A tool result or a read file can
    // carry a key-shaped string, and this is the one tool that would hand it to a third party.
    const redact = typeof deps.redact === 'function' ? deps.redact : function (t) { return t; };
    const emit = typeof deps.emit === 'function' ? deps.emit : function () {};

    const targetsTool = {
      name: 'channel.targets', capability: 'comms', scope: 'read', requiresConsent: false,
      description: 'List the messaging chats this station can actually send to (channel, chat, which agent it is bound to, and whether that channel is connected right now). Call this before channel.send.',
      schema: { type: 'object', properties: {} },
      run: async () => {
        const targets = (listTargets() || []).map(packTarget).filter(t => t.target);
        const live = targets.filter(t => t.connected).length;
        return {
          content: JSON.stringify({ targets: targets, reachable: live }),
          summary: targets.length
            ? live + ' of ' + targets.length + ' known chat(s) reachable now'
            : 'no chats known yet — nobody has messaged this station on a connected channel'
        };
      }
    };

    const sendTool = {
      name: 'channel.send', capability: 'comms', scope: 'execute', requiresConsent: true, timeoutMs: 30000,
      description: 'Send a message from this station to a connected messaging chat (Telegram, Discord, Slack, Matrix, Signal). Use this when the Commander asks to be told, pinged, notified, or messaged somewhere, or to report a result outside the station. The target must be a chat channel.targets lists — an agent cannot message a new id.',
      schema: {
        type: 'object',
        required: ['target', 'text'],
        properties: {
          target: { type: 'string', description: 'A target token from channel.targets (a channel name or chat id also works when it matches exactly one).' },
          text: { type: 'string', description: 'The message body. Plain text; it is split into platform-sized parts automatically.' }
        }
      },
      run: async (args) => {
        if (typeof sendTo !== 'function') throw new Error('outbound messaging unavailable');
        const text = clean(args && args.text, TEXT_CHARS);
        if (!text) throw new Error('text is required — an empty message is never sent');
        const t = resolveTarget(listTargets() || [], args && args.target);
        // A resolved-but-DOWN transport is its own answer. Reporting "sent" into a dead channel, or "no such
        // target" for a chat that plainly exists, are both lies the model would repeat to the Commander.
        if (!t.connected) {
          throw new Error(t.channel + ' is not connected right now, so nothing was sent to ' + t.target
            + ' — reconnect it in the CHANNELS panel and try again');
        }

        const body = redact(text);
        const parts = chunkText(body, maxLenFor(t.channel));
        if (parts.length > MAX_CHUNKS) {
          throw new Error('that message would take ' + parts.length + ' chat messages (limit ' + MAX_CHUNKS
            + ') — send a summary and put the detail in a file instead');
        }

        // Sequential, and it STOPS at the first failure. Firing the rest would leave the chat holding parts
        // 1,3,4 of a four-part message with no way to tell; `sent` below reports exactly what landed.
        let sent = 0, error = null;
        for (const part of parts) {
          let r;
          // Transports never throw — a failure is a resolved { ok:false, error }. Guard anyway: a host that
          // wires a throwing send must not take the whole run down with it.
          try { r = await sendTo(t.target, part); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
          if (r && r.ok === false) { error = String(r.error || 'send failed'); break; }
          sent++;
        }

        // OUTBOUND TELEMETRY on the existing contract event, so the station floor pulses the sending agent's
        // dish for an agent-initiated message exactly as it does for a hub reply. Never fabricated: `ok`
        // reflects whether every part actually landed.
        try {
          emit('channel.delivery', {
            channel: t.channel, chatId: t.chatId, runId: '', ok: !error,
            chunks: sent, reason: error ? String(error).slice(0, 200) : '', agentId: t.agentId
          });
        } catch (_) {}

        if (error) {
          throw new Error('send to ' + t.target + ' failed after ' + sent + ' of ' + parts.length
            + ' part(s): ' + error);
        }
        return {
          content: JSON.stringify({ ok: true, target: t.target, channel: t.channel, parts: sent }),
          summary: 'sent to ' + t.target + (parts.length > 1 ? ' in ' + parts.length + ' parts' : '')
        };
      }
    };

    return {
      targetsTool: targetsTool,
      sendTool: sendTool,
      _resolveTarget: resolveTarget,
      _chunkText: chunkText,
      register(reg) { reg.register(targetsTool); reg.register(sendTool); return reg; }
    };
  }

  return { makeCommsTools, DEFAULT_MAX_LEN, MAX_CHUNKS, TEXT_CHARS };
});
