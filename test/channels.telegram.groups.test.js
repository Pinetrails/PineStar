/* node test/channels.telegram.groups.test.js — P2 voice-in, P3 group discipline, sender attribution,
   and fenced-code chunking (2026-07-29).

   Four gaps, all of which cost the member something real:

     · A VOICE NOTE WAS DEAD INPUT. We saved the .ogg and told the model "saved to <path>" — a path it cannot
       hear — while the station has owned an STT engine the whole time.
     · WE ANSWERED EVERY MESSAGE IN A WHITELISTED GROUP and never checked whether the sender was a bot. That is
       a model call per message in a room the member is not even talking in, and two bots in one group answer
       each other forever.
     · GROUP MESSAGES CARRIED NO SENDER. `userName` was captured on every inbound and never reached the model,
       so the agent read a merged stream with no idea who said what.
     · A FENCED CODE BLOCK SPLIT ACROSS THE 4096 LIMIT left chunk 2 holding an unpaired ``` — so the second half
       of a script rendered as raw prose with a stray marker in it.

   Fakes only: no network, no clock, no STT engine. */
'use strict';
const A = require('./_assert.js');
const { normalize, mentionsOf } = require('../sidecar/channels/telegram.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const { makeChannelHub, chunkText } = require('../sidecar/channels/hub.js');

const GROUP = { id: -1001, type: 'supergroup' };
const DM = { id: 111, type: 'private' };
const ME = { id: 5, username: 'andro' };

function fakeStore() {
  const hist = new Map(), appends = [];
  return {
    hist, appends,
    loadHistory: (a) => (hist.get(a) || []).slice(),
    appendTurn: (a, role, content) => { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); appends.push({ a, role, content }); return arr; },
    getChatRecord: () => null, saveChatRecord: () => {}
  };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };

// an adapter whose dispatch we drive directly, with the group gates configured
function mkAdapter(opts) {
  const got = [];
  const ad = makeChannelAdapter(Object.assign({
    transport: { getUpdates: async () => [], send: async () => ({ ok: true }) },
    normalize: (r) => r, name: 'telegram', clock: { now: () => 1 },
    allowedChats: ['-1001'], ownerUserId: '5',
    onInbound: (im) => got.push(im)
  }, opts || {}));
  return { ad, got };
}
const groupMsg = (extra) => ({ offset: 1, message: Object.assign({ chatId: -1001, chatType: 'group', userId: '9', userName: 'Ana', text: 'hello', messageId: '1' }, extra) });

async function run() {
  // ---- A. mentionsOf: who a message addresses, by UTF-16 offset (Telegram's own unit) ----
  {
    A.eq(mentionsOf({ text: '@starnetbot look at this', entities: [{ type: 'mention', offset: 0, length: 12 }] }), ['starnetbot'], 'an @mention is extracted by offset/length');
    // an emoji ahead of the mention: byte offsets would slice the wrong window, UTF-16 offsets do not
    const withEmoji = { text: '🔥 @starnetbot go', entities: [{ type: 'mention', offset: 3, length: 11 }] };
    A.eq(mentionsOf(withEmoji), ['starnetbot'], 'offsets are UTF-16 — an emoji before the mention does not shift it');
    A.eq(mentionsOf({ text: 'x', entities: [{ type: 'text_mention', offset: 0, length: 1, user: { id: 3, username: 'Ana' } }] }), ['ana'], 'a text_mention contributes its username, lowercased');
    A.eq(mentionsOf({ text: '/status@otherbot' }), ['otherbot'], 'a command @suffix is an addressing form too');
    A.eq(mentionsOf({ caption: '@starnetbot', caption_entities: [{ type: 'mention', offset: 0, length: 11 }] }), ['starnetbot'], 'a photo CAPTION can address us as well');
    A.eq(mentionsOf({ text: 'no mentions here' }), [], 'plain text addresses nobody');
  }

  // ---- B. requireMention: an unmentioned group message costs ZERO model calls ----
  {
    const { ad, got } = mkAdapter({ botUsername: 'starnetbot' });
    ad._internals.dispatch(groupMsg({ text: 'just chatting with Bob' }));
    A.eq(got.length, 0, 'an unaddressed group message is DROPPED — this is the spend fix');

    ad._internals.dispatch(groupMsg({ text: '@starnetbot what is the status?', mentions: ['starnetbot'] }));
    A.eq(got.length, 1, 'an @mention of US runs');

    ad._internals.dispatch(groupMsg({ text: '@otherbot what is the status?', mentions: ['otherbot'] }));
    A.eq(got.length, 1, 'a mention of a DIFFERENT bot does not');

    ad._internals.dispatch(groupMsg({ text: 'and the other thing?', replyTo: { text: 'here is the status', userName: 'starnetbot', fromBot: true } }));
    A.eq(got.length, 2, 'a REPLY to one of our own messages is an address — follow-ups stay natural');

    ad._internals.dispatch(groupMsg({ text: 'and this?', replyTo: { text: 'something', userName: 'Ana' } }));
    A.eq(got.length, 2, 'a reply to SOMEONE ELSE is not');

    ad._internals.dispatch(groupMsg({ text: '/status' }));
    A.eq(got.length, 3, 'a bare slash command in a group still works (hub-handled, no model spend)');
    ad._internals.dispatch(groupMsg({ text: '/status@otherbot', mentions: ['otherbot'] }));
    A.eq(got.length, 3, 'a command aimed at another bot by name does not');
  }

  // ---- B2. the gates are configurable, and a DM is never touched by them ----
  {
    const off = mkAdapter({ botUsername: 'starnetbot', requireMention: false });
    off.ad._internals.dispatch(groupMsg({ text: 'just chatting' }));
    A.eq(off.got.length, 1, 'requireMention:false restores the old answer-everything behaviour');

    const unknown = mkAdapter({});   // no botUsername configured
    unknown.ad._internals.dispatch(groupMsg({ text: 'just chatting' }));
    A.eq(unknown.got.length, 1, 'with no botUsername we do NOT silence the room — we cannot prove we were not addressed');

    const dm = mkAdapter({ botUsername: 'starnetbot' });
    dm.ad._internals.dispatch({ offset: 1, message: { chatId: 111, chatType: 'dm', userId: '5', text: 'hi', messageId: '1' } });
    A.eq(dm.got.length, 1, 'a DM never needs a mention — it is already owner-only');
  }

  // ---- B3. ignoreBots: bot-to-bot is an unbounded spend loop with no human in it ----
  {
    const { ad, got } = mkAdapter({ botUsername: 'starnetbot' });
    ad._internals.dispatch(groupMsg({ text: '@starnetbot hello', mentions: ['starnetbot'], fromBot: true }));
    A.eq(got.length, 0, 'another BOT is ignored even when it mentions us by name');
    ad._internals.dispatch({ offset: 2, message: { chatId: 111, chatType: 'dm', userId: '5', text: 'hi', messageId: '2', fromBot: true } });
    A.eq(got.length, 0, 'and ignored in a DM too — the loop is the same shape either way');
  }

  // ---- B4. allowedUsers NARROWS; it never widens ----
  {
    const { ad, got } = mkAdapter({ botUsername: 'starnetbot', allowedUsers: ['9'] });
    ad._internals.dispatch(groupMsg({ userId: '9', text: '@starnetbot go', mentions: ['starnetbot'] }));
    A.eq(got.length, 1, 'a listed user runs');
    ad._internals.dispatch(groupMsg({ userId: '77', text: '@starnetbot go', mentions: ['starnetbot'] }));
    A.eq(got.length, 1, 'an unlisted user does not');
    // and it does not bypass the owner gate on a DM
    const other = mkAdapter({ allowedUsers: ['77'], ownerUserId: '5' });
    other.ad._internals.dispatch({ offset: 1, message: { chatId: 111, chatType: 'dm', userId: '77', text: 'hi', messageId: '1' } });
    A.eq(other.got.length, 0, 'being on allowedUsers does NOT make a stranger the owner — the gates stack');
  }

  // ---- B5. normalize marks a bot sender and carries the mentions through ----
  {
    const n = normalize({ update_id: 1, message: { message_id: 1, chat: GROUP, from: { id: 42, is_bot: true, username: 'rival' }, text: '@starnetbot hi', entities: [{ type: 'mention', offset: 0, length: 11 }] } });
    A.eq(n.message.fromBot, true, 'a bot sender is marked at the parse');
    A.eq(n.message.mentions, ['starnetbot'], 'and the mention it made is carried');
    A.eq('fromBot' in normalize({ update_id: 2, message: { message_id: 2, chat: DM, from: ME, text: 'hi' } }).message, false, 'a human message carries no fromBot key (additive only)');
  }

  // ---- C. VOICE: the transcript becomes the message the model reads ----
  {
    const store = fakeStore(); let lastRun = null; const asked = [];
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const mk = (transcribe, classify) => makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }),
      classify: classify || (() => false), newId: idGen(),
      fetchMedia: () => Promise.resolve({ ok: true, buffer: Buffer.from('OGGBYTES') }),
      saveAttachment: (a, name) => Promise.resolve({ ok: true, id: name, name, path: '.attachments/' + name, mediaType: 'audio/ogg', kind: 'file' }),
      expandAttachments: (m) => Promise.resolve(m),
      transcribe: transcribe
    });

    const voice = (chatId) => ({ channel: 'telegram', chatId: chatId, chatType: 'dm', userId: 'u1', text: '', messageId: '1', ts: 1,
      media: [{ kind: 'audio', fileId: 'v1', name: 'voice-message.ogg', mime: 'audio/ogg', size: 900, voice: true }] });

    await mk((buf, mime, name) => { asked.push({ len: buf.length, mime, name }); return Promise.resolve({ ok: true, text: 'check the deploy logs' }); })
      .onInbound(voice('90'));
    A.eq(asked.length, 1, 'a voice note is transcribed');
    A.eq(asked[0].mime, 'audio/ogg', 'the engine is told the container it is getting');
    const turn = String(lastRun.messages[lastRun.messages.length - 1].content);
    A.ok(/check the deploy logs/.test(turn), 'THE WORDS reach the model — this is the whole fix');
    A.ok(/transcribed automatically/.test(turn), 'and are labelled as a transcription, so the agent never quotes them as verbatim user text');
    A.ok(/can mishear/.test(turn), 'the label states the failure mode rather than implying certainty');

    // a MUSIC file is audio too — transcribing it would be spend with no meaning
    asked.length = 0;
    const music = voice('91'); music.media[0].voice = false; music.media[0].name = 'song.mp3';
    await mk(() => { asked.push(1); return Promise.resolve({ ok: true, text: 'la la la' }); }).onInbound(music);
    A.eq(asked.length, 0, 'a forwarded music file is NOT transcribed — only a real voice note is');

    // STT failure must never cost the turn
    await mk(() => Promise.resolve({ ok: false, reason: 'no key' })).onInbound(voice('92'));
    const failTurn = String(lastRun.messages[lastRun.messages.length - 1].content);
    A.ok(/could not be transcribed/.test(failTurn) && /no key/.test(failTurn), 'a failure is an honest note naming the reason');
    A.ok(/\.attachments\//.test(failTurn), 'and still points at the saved audio file');
    A.ok(lastRun, 'the run happened anyway — a failed transcription never costs the turn');

    // silence is not an error
    await mk(() => Promise.resolve({ ok: true, text: '   ' })).onInbound(voice('93'));
    A.ok(/no speech we could make out/.test(String(lastRun.messages[lastRun.messages.length - 1].content)), 'an empty transcript says so instead of sending a blank turn');

    // a host with no engine wired degrades to exactly the old behaviour
    await mk(null).onInbound(voice('94'));
    A.ok(/saved to \.attachments\//.test(String(lastRun.messages[lastRun.messages.length - 1].content)), 'no engine wired = the old saved-file note, unchanged');

    // a SPOKEN task still earns the task prompt (the words only exist after ingest)
    await mk(() => Promise.resolve({ ok: true, text: 'research the competitors' }), (t) => /research/.test(String(t || ''))).onInbound(voice('95'));
    A.eq(lastRun.isTask, true, 'a spoken directive is classified once its words exist');
    A.ok(/task/i.test(lastRun.system), 'and the run gets the task system prompt');
  }

  // ---- D. GROUP ATTRIBUTION: the agent can tell who said what ----
  {
    const store = fakeStore(); let lastRun = null;
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({ runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });

    await hub.onInbound({ channel: 'telegram', chatId: '-1001', chatType: 'group', userId: '9', userName: 'Ana', text: 'can you check the logs?', messageId: '1', ts: 1 });
    A.eq(String(lastRun.messages[lastRun.messages.length - 1].content), 'Ana: can you check the logs?', 'a group message names its speaker');

    await hub.onInbound({ channel: 'telegram', chatId: '777', chatType: 'dm', userId: '5', userName: 'andro', text: 'hi', messageId: '2', ts: 1 });
    A.eq(String(lastRun.messages[lastRun.messages.length - 1].content), 'hi', 'a DM is left alone — one human in the room, a name prefix would be noise every turn');
  }

  // ---- E. FENCED CODE across a chunk boundary ----
  {
    const body = 'here is the script\n```js\n' + Array.from({ length: 40 }, (_, i) => 'const line' + i + ' = ' + i + ';').join('\n') + '\n```\nthat is all';
    const cs = chunkText(body, 300);
    A.ok(cs.length > 2, 'the block really did split');
    A.eq(cs.every(c => ((c.match(/^[ \t]{0,3}```/gm) || []).length) % 2 === 0), true, 'EVERY chunk is fence-balanced — no chunk renders as prose with a stray marker');
    A.eq(cs.every(c => c.length <= 300), true, 'and the added markers still fit under the limit');
    // content preservation: drop every fence LINE from both sides (the added ones and the originals) and the
    // remaining text must be identical — nothing lost, nothing duplicated by the re-fencing.
    const noFences = (s) => s.split('\n').filter(l => !/^[ \t]{0,3}```/.test(l)).join('\n').replace(/\n+/g, '\n').trim();
    A.eq(noFences(cs.join('\n')), noFences(body), 'no content was lost or duplicated by the re-fencing');

    // an ordinary long reply keeps its EXACT old boundaries — this must not perturb the common case
    const plain = 'x'.repeat(1000);
    A.eq(chunkText(plain, 300).length, Math.ceil(1000 / 300), 'unfenced text chunks exactly as before');
    A.eq(chunkText('a ``` in a sentence is not a fence', 300), ['a ``` in a sentence is not a fence'], 'a mid-line ``` is not treated as a block delimiter');
  }

  /* ---- F. THE ESCAPE HATCH: /mention on|off -------------------------------------------------------------
     The mention gate above is the right default, but it shipped as a hardcoded constant with no command, no
     route and no UI — a behaviour change with no way back. A room that wanted the bot to answer everything had
     no way to say so, and the bot's silence is indistinguishable from the bot being broken. The gate now reads
     the CHAT's own saved setting on every message. */
  {
    // the option takes a FUNCTION, and it is consulted per message — not captured once at construction
    const asked = [];
    const { ad, got } = mkAdapter({
      botUsername: 'starnetbot',
      allowedChats: ['-1001', '-1002'],
      requireMention: (chatId) => { asked.push(String(chatId)); return String(chatId) !== '-1002'; }
    });
    ad._internals.dispatch(groupMsg({ text: 'nobody is addressed here' }));
    A.eq(got.length, 0, 'the gate still holds in a chat that wants it');
    ad._internals.dispatch({ offset: 2, message: { chatId: -1002, chatType: 'group', userId: '9', text: 'nobody is addressed here either', messageId: '2' } });
    A.eq(got.length, 1, 'and lets everything through in a chat that turned it off');
    A.eq(asked.length, 2, 'the setting is read PER MESSAGE — a flip takes effect on the very next one, not at the next restart');

    // a store hiccup must not throw the room open
    const b = mkAdapter({ botUsername: 'starnetbot', requireMention: () => { throw new Error('store down'); } });
    b.ad._internals.dispatch(groupMsg({ text: 'unaddressed' }));
    A.eq(b.got.length, 0, 'a throwing lookup keeps the gate ON — the failure mode is quiet, not expensive');

    // and a plain boolean still works exactly as before
    const c = mkAdapter({ botUsername: 'starnetbot', requireMention: false });
    c.ad._internals.dispatch(groupMsg({ text: 'unaddressed' }));
    A.eq(c.got.length, 1, 'a boolean option is unchanged (no caller had to be updated)');
  }
  {
    // the command half: it writes the record the gate reads, and only claims success once the write returned
    const sent = [];
    const saves = [];
    const store = fakeStore();
    store.saveChatRecord = (chatId, patch) => { saves.push({ chatId, patch }); return patch; };
    const hub = makeChannelHub({
      runOnce: async () => {}, store,
      send: (chatId, text) => { sent.push(text); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen()
    });
    const say = (text, chatType) => hub.onInbound({ channel: 'telegram', chatId: '-1001', chatType: chatType || 'group', userId: '9', text, messageId: '1', ts: 1 });

    await say('/mention off');
    A.eq(saves.length, 1, 'the setting is persisted');
    A.eq(saves[0].patch.requireMention, false, 'as requireMention:false — the exact field the adapter reads');
    A.ok(/answer every message/.test(sent[sent.length - 1]), 'and the reply says what changed');
    A.ok(/spend/.test(sent[sent.length - 1]), 'including the cost of it — every message in the room is now a real run');

    await say('/mention on');
    A.eq(saves[1].patch.requireMention, true, 'and back on again');

    sent.length = 0; saves.length = 0;
    await say('/mention maybe');
    A.eq(saves.length, 0, 'an unparseable argument changes nothing');
    A.ok(/Usage: \/mention on/.test(sent[0]), 'and answers with the usage line');

    sent.length = 0;
    await say('/mention', 'dm');
    A.eq(saves.length, 0, 'a DM stores nothing — the setting cannot apply there');
    A.ok(/only applies to groups/.test(sent[0]), 'and says so honestly rather than pretending the control worked');

    // truthful telemetry: a failed write must not report success
    sent.length = 0;
    store.saveChatRecord = () => { throw new Error('disk full'); };
    await say('/mention off');
    A.ok(/Could not save/.test(sent[0]), 'a failed write is reported as a failure');
    A.ok(/still/.test(sent[0]), 'and states what the setting actually still is');
  }

  A.report('channels.telegram.groups');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
