/* sidecar/channels/store.js — durable per-chat memory for the messaging ingress (C4).

   The run host (index.js /api/run) is STATELESS: the caller supplies the full `messages` array each call, and
   browser history lives only in localStorage. A messaging chat has no browser holding its transcript, so the
   adapter must own its own durable per-chat memory. This module is that store:

     makeChannelStore({ fs, pathMod, root, clock, limits? }) -> {
       loadHistory(agentId)            -> [{role,content,ts}]     // [] on missing/corrupt (fail-closed)
       appendTurn(agentId, role, text) -> messages[]             // appends + trims tail, persists atomically
       loadChatMap()                   -> { version, chats }
       getChatRecord(chatId)           -> record | undefined
       saveChatRecord(chatId, patch)   -> record                 // merge-and-persist one chat's mapping/config
     }

   Files live under WORKSPACES/channels/ — SIBLINGS of the notebook store, OUTSIDE the agent's fs jail
   (WORKSPACES/<agentId>/), so the agent's own fs.* tools can neither read nor corrupt its conversation history
   or the chat→agent map (the same containment the notebook already has):
     • <root>/<agentId>.history.json  = { version:1, messages:[{role,content,ts}] }
     • <root>/chatmap.json            = { version:1, chats:{ "<chatId>": { agentId, model, persona, ... } } }

   Save-safe: versioned; atomic temp+rename; a missing/corrupt file loads as empty and NEVER throws. History is
   trimmed (lossy) on write to a bounded tail so the file and the replayed prompt stay within budget. Pure +
   deterministic: all I/O is the injected `fs` (sync), time is the injected `clock` — no Date.now/rng. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.store = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;            // same agentId grammar as the notebook/fs jail
  const DEFAULTS = { maxTurns: 40, maxChars: 24000 };  // bound the on-disk + replayed transcript

  const ROLES = { user: 1, assistant: 1, system: 1 };

  function trimTail(messages, maxTurns, maxChars) {
    let m = messages.slice(-maxTurns);
    let total = 0;
    for (const x of m) total += (x && typeof x.content === 'string') ? x.content.length : 0;
    while (m.length > 1 && total > maxChars) {
      total -= (m[0] && typeof m[0].content === 'string') ? m[0].content.length : 0;
      m = m.slice(1);
    }
    return m;
  }

  function makeChannelStore(deps) {
    const d = deps || {};
    const fs = d.fs;
    const pathMod = d.pathMod;
    const root = d.root;
    const clock = d.clock;
    if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.writeFileSync !== 'function' || typeof fs.renameSync !== 'function')
      throw new Error('makeChannelStore: an injected fs (readFileSync/writeFileSync/renameSync[/mkdirSync]) is required');
    if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeChannelStore: an injected pathMod is required');
    if (!root) throw new Error('makeChannelStore: a root dir is required');
    if (!clock || typeof clock.now !== 'function') throw new Error('makeChannelStore: an injected clock is required');
    const limits = Object.assign({}, DEFAULTS, d.limits || {});

    let tmpSeq = 0;   // deterministic, process-unique tmp suffix (no pid/rng needed for a single host)
    // P2: when the host injects writeDurable (writeFileDurable — fsync-before-rename), every write is power-loss
    // durable; standalone (browser/tests) it degrades to the atomic temp+rename below. onRecover (optional) is
    // called when a torn/corrupt main was recovered from its .bak last-known-good.
    const writeDurable = (typeof d.writeDurable === 'function') ? d.writeDurable : null;
    const onRecover = (typeof d.onRecover === 'function') ? d.onRecover : function () {};

    function ensureRoot() { try { if (fs.mkdirSync) fs.mkdirSync(root, { recursive: true }); } catch (_) {} }
    function historyFile(agentId) {
      if (!AID_RE.test(String(agentId))) throw new Error('bad channel agentId: ' + agentId);
      return pathMod.join(root, agentId + '.history.json');
    }
    const chatMapFile = () => pathMod.join(root, 'chatmap.json');

    function readRaw(file) {   // parse-or-undefined for ONE file (missing / zero-length / corrupt -> undefined)
      try { const raw = fs.readFileSync(file, 'utf8'); if (raw == null || String(raw).length === 0) return undefined; return JSON.parse(raw); }
      catch (_) { return undefined; }
    }
    function readJson(file) {   // recovery-aware: try the main file, then the <file>.bak last-known-good
      const m = readRaw(file);
      if (m !== undefined) return m;
      const b = readRaw(file + '.bak');
      if (b !== undefined) { try { onRecover(file); } catch (_) {} return b; }   // a torn/corrupt main recovered from .bak
      return undefined;   // genuinely absent OR unrecoverable -> caller treats as empty (channels is fail-closed)
    }
    function writeRaw(file, value) {
      ensureRoot();
      if (writeDurable) { writeDurable({ fs: fs, path: pathMod }, file, JSON.stringify(value)); return; }
      const tmp = file + '.' + (++tmpSeq) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, file);   // atomic replace
    }
    function writeJsonAtomic(file, value) {
      // snapshot the current GOOD main to <file>.bak BEFORE overwriting it, so a torn replace can be recovered.
      // A corrupt current main is NOT copied (never clobber a possibly-good .bak with garbage). The read-modify-
      // write in appendTurn/saveChatRecord is fully SYNCHRONOUS (no await between readJson and writeJsonAtomic),
      // so it is inherently serialized per file by the event loop — concurrent in-process writers cannot lose an
      // update — and now it is durable + recoverable too.
      const prev = readRaw(file);
      if (prev !== undefined) { try { writeRaw(file + '.bak', prev); } catch (_) {} }
      writeRaw(file, value);
    }

    return {
      loadHistory(agentId) {
        const raw = readJson(historyFile(agentId));
        const msgs = raw && Array.isArray(raw.messages) ? raw.messages : [];
        // defend against a hand-corrupted file: keep only well-formed {role,content} turns
        return msgs.filter(m => m && ROLES[m.role] && typeof m.content === 'string');
      },

      appendTurn(agentId, role, text) {
        if (!ROLES[role]) throw new Error('bad role: ' + role);
        const file = historyFile(agentId);
        const raw = readJson(file);
        const prev = raw && Array.isArray(raw.messages) ? raw.messages.filter(m => m && ROLES[m.role] && typeof m.content === 'string') : [];
        prev.push({ role: role, content: String(text == null ? '' : text), ts: clock.now() });
        const next = trimTail(prev, limits.maxTurns, limits.maxChars);
        writeJsonAtomic(file, { version: 1, messages: next });
        return next;
      },

      loadChatMap() {
        const raw = readJson(chatMapFile());
        return { version: 1, chats: (raw && raw.chats && typeof raw.chats === 'object') ? raw.chats : {} };
      },

      getChatRecord(chatId) {
        const map = this.loadChatMap();
        return map.chats[String(chatId)];
      },

      saveChatRecord(chatId, patch) {
        const id = String(chatId);
        const map = this.loadChatMap();
        const merged = Object.assign({}, map.chats[id], patch || {}, { lastSeen: clock.now() });
        map.chats[id] = merged;
        writeJsonAtomic(chatMapFile(), { version: 1, chats: map.chats });
        return merged;
      },

      _internals: { trimTail, historyFile, chatMapFile, AID_RE, limits }
    };
  }

  return { makeChannelStore, trimTail, _internals: { AID_RE, DEFAULTS } };
});
