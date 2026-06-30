/* sidecar/autonotify.js — autonomy B4: ping the Commander over a connected channel (Telegram/Discord) when an
   AUTONOMOUS (cron) run PRODUCES WORK while they're out. Opt-in + anti-spam: ONLY a clean 'ok' outcome notifies —
   a 'silent' (decided nothing) or 'failed' run never pings. Pure + injected‑deps (no IO / clock / rng) so it is
   node‑testable; index.js wires the live adapter.send + the channel store + the cron jobs into it.

   makeAutoNotifier({ send, chatsFor, jobName, jobAgent }) -> { onEvent(name, payload), _buckets() }
     send(chatId, text) -> Promise        // the live channel send (adapter.send); failures are swallowed
     chatsFor(agentId)  -> [chatId,...]    // the agent's CONNECTED + opted-in chats ([] if none → no ping)
     jobName(jobId)     -> string          // the routine's display name (for the message)
     jobAgent(jobId)    -> agentId | null  // map a cron.result back to its agent (cron.result carries no agentId)

   It watches the cron event stream index.js already emits:
     'cron.fire'   {jobId,runId}         → start a fresh deliverable bucket for that agent
     'deliverable' {agentId,title,kind}  → remember a file that agent produced (this event has NO runId, so it is
                                           bucketed per‑AGENT — a safe approximation for a single‑user station)
     'cron.result' {jobId,runId,outcome} → on 'ok', compose (routine name + any files) + SEND to the agent's
                                           opted‑in chats, then drain the bucket. 'silent'/'failed' → nothing. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).autonotify = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the message body — honest + compact. Names the routine and, when it wrote files, lists them. Pure.
  function composeMessage(name, titles) {
    const n = String(name == null ? '' : name).trim() || 'a routine';
    const files = (Array.isArray(titles) ? titles : []).filter(Boolean).map(String);
    const head = '✦ "' + n + '" ran on its own';
    return files.length ? (head + ' — wrote ' + files.join(', ') + '.') : (head + '.');
  }

  function makeAutoNotifier(opts) {
    const o = opts || {};
    const send = typeof o.send === 'function' ? o.send : function () {};
    const chatsFor = typeof o.chatsFor === 'function' ? o.chatsFor : function () { return []; };
    const jobName = typeof o.jobName === 'function' ? o.jobName : function () { return 'a routine'; };
    const jobAgent = typeof o.jobAgent === 'function' ? o.jobAgent : function () { return null; };

    const buckets = new Map();   // agentId -> [deliverable titles produced during its current run]

    function onEvent(name, payload) {
      const p = payload || {};
      try {
        if (name === 'cron.fire') {
          const aid = jobAgent(p.jobId);
          if (aid) buckets.set(aid, []);                       // fresh run → fresh bucket
        } else if (name === 'deliverable') {
          const aid = p.agentId;
          if (aid && p.title) { const b = buckets.get(aid) || []; b.push(String(p.title)); buckets.set(aid, b); }
        } else if (name === 'cron.result') {
          const aid = jobAgent(p.jobId);
          const titles = (aid && buckets.get(aid)) || [];
          if (aid) buckets.delete(aid);                        // drain regardless of outcome
          if (p.outcome === 'ok' && aid) {                     // ONLY a clean, work-producing run pings (anti-spam)
            const chats = chatsFor(aid) || [];
            if (chats.length) {
              const text = composeMessage(jobName(p.jobId), titles);
              for (const chatId of chats) { try { Promise.resolve(send(chatId, text)).catch(function () {}); } catch (_) {} }
            }
          }
        }
      } catch (_) { /* a notification must NEVER break the cron pipeline */ }
    }

    return { onEvent: onEvent, _buckets: function () { return buckets; } };
  }

  return { makeAutoNotifier: makeAutoNotifier, composeMessage: composeMessage };
});
