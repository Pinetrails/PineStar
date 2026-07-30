/* stationcommands.js — the PAGE half of the station bridge.
 *
 * Sessions and crew are frontend state (App.openWorkstream / summonAgent / selectAgent, workstreams inside
 * agent.save.json), while agent tools run in the sidecar. So a tool that wants to open a session emits
 * `station.command` on the bus; this listens, runs the verb against the live station, and POSTs the outcome
 * back to /api/station/ack.
 *
 * ⛔ EVERY VERB REPORTS TRUTHFULLY. A refusal ("no such agent", "the crew list is not ready") is a real answer
 * and must travel back as ok:false. Never resolve ok:true for something that did not happen — a tool that says
 * "opened a session" with no session behind it is the exact failure this whole bridge is built to prevent.
 * Read-only verbs land first on purpose: they prove the channel with nothing to corrupt.
 */
'use strict';

const StationCommands = (() => {
  const VERBS = {
    /* Everything the station can currently see: which sessions exist, which is active, who is busy, what is
       waiting on approval. Reuses VoiceLive's snapshot so voice and tools cannot drift into two answers. */
    'station.status': () => {
      if (typeof VoiceLive === 'undefined' || !VoiceLive.statusSnapshot) throw new Error('the station view is not ready yet');
      const snap = VoiceLive.statusSnapshot();
      if (!snap || (snap.active === null && !(snap.workstreams || []).length)) {
        throw new Error('the station is still starting up — no sessions are readable yet');
      }
      return snap;
    },

    /* The sessions that exist, by name. This is what turns "the research session" into a real workstream id:
       the sidecar resolves against THIS list and refuses anything it cannot match uniquely, so the resolution
       is only ever as good as the truth here — report ids and titles verbatim, never a guess or a default. */
    'station.sessions': () => {
      if (typeof Workstreams === 'undefined' || !Workstreams.list) throw new Error('sessions are not ready yet');
      const rows = Workstreams.list() || [];
      const activeId = Workstreams.activeId ? Workstreams.activeId() : null;
      const generalId = Workstreams.generalId ? Workstreams.generalId() : null;
      return {
        count: rows.length,
        activeId: activeId,
        sessions: rows.map(w => ({
          id: w.id,
          // General is the untitled home stream; it has no name of its own, so give it the one the UI shows.
          title: w.title != null ? w.title : (w.id === generalId ? 'General' : null),
          agentId: w.agentId || 'agent',
          lane: w.lane || null,
          active: w.id === activeId
        }))
      };
    },

    /* Create a NAMED session. Refuses a duplicate title rather than minting a twin: two sessions with one
       name would make every later name-addressed action (dispatch's `session`, switch below) AMBIGUOUS and
       therefore refused — a create that quietly poisons the namespace is worse than telling the agent to
       reuse what exists. `focus` is honored only when explicitly asked, so an agent opening sessions in the
       background can never steal what the Commander is looking at. */
    'station.new_session': (a) => {
      if (typeof Workstreams === 'undefined' || !Workstreams.create) throw new Error('sessions are not ready yet');
      const title = String((a && a.title) || '').trim().slice(0, 80);
      if (!title) throw new Error('a session needs a title');
      const clash = (Workstreams.list() || []).find(w => String(w.title || (w.id === Workstreams.generalId() ? 'General' : '')).trim().toLowerCase() === title.toLowerCase());
      if (clash) throw new Error('a session called "' + title + '" already exists — delegate into it, focus it, or pick another name');
      const agentId = String((a && a.agentId) || '').trim();
      if (agentId && typeof App !== 'undefined' && App.agents && !(App.agents() || []).some(x => x && x.id === agentId)) {
        throw new Error('no crew member with id "' + agentId + '" — use station.crew for the roster, or omit agentId');
      }
      const ws = Workstreams.create(title, { agentId: agentId || undefined, activate: !!(a && a.focus) });
      if (!ws) throw new Error('the station could not create the session');
      if (a && a.focus && typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
      try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
      try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
      return { id: ws.id, title: ws.title, agentId: ws.agentId || 'agent', focused: !!(a && a.focus) };
    },

    /* Focus an existing session by the name the Commander says (or exact id). SAME resolution law as
       team.dispatch's sidecar-side resolver — exact id, exact title, then UNIQUE substring, and anything
       else refuses with the real names — because a switch that lands on a plausible-but-wrong session
       moves the Commander's eyes somewhere they did not ask to be. */
    'station.switch_session': (a) => {
      if (typeof Workstreams === 'undefined' || !Workstreams.list) throw new Error('sessions are not ready yet');
      const want = String((a && a.session) || '').trim();
      if (!want) throw new Error('name which session to switch to');
      const generalId = Workstreams.generalId ? Workstreams.generalId() : null;
      const rows = (Workstreams.list() || []).map(w => ({ w, title: String(w.title != null ? w.title : (w.id === generalId ? 'General' : '')).trim() }));
      const lower = want.toLowerCase();
      const byId = rows.filter(r => r.w.id === want);
      const byTitle = rows.filter(r => r.title && r.title.toLowerCase() === lower);
      const byPart = rows.filter(r => r.title && r.title.toLowerCase().indexOf(lower) >= 0);
      const hits = byId.length ? byId : (byTitle.length ? byTitle : byPart);
      if (hits.length !== 1) {
        const names = rows.map(r => r.title).filter(Boolean).join(', ');
        throw new Error(hits.length > 1
          ? 'more than one session matches "' + want + '" — name it exactly. Open sessions: ' + names
          : 'there is no session called "' + want + '"' + (names ? '. Open sessions: ' + names : ''));
      }
      const ws = Workstreams.switch(hits[0].w.id);
      if (!ws) throw new Error('the station could not switch sessions');
      if (typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
      try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
      try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
      return { id: ws.id, title: ws.title != null ? ws.title : 'General' };
    },

    /* Fold a finished delegated run's answer into the session it was filed under. APPENDS — a session usually
       already holds the Commander's own conversation, and replacing that history (the way the cron auto-session
       path can, because it OWNS its stream) would delete their thread. Idempotent by runId so a retry, a
       duplicated command, or a re-delivered background worker can never double-post. */
    'station.deliver': (a) => {
      if (typeof Workstreams === 'undefined' || !Workstreams.get) throw new Error('sessions are not ready yet');
      const id = String((a && a.streamId) || '');
      const ws = id && Workstreams.get(id);
      if (!ws) throw new Error('there is no session with id ' + (id || '(none given)') + ' on this station');
      const text = String((a && a.text) || '').trim();
      if (!text) throw new Error('nothing to deliver — the worker returned no text');
      const runId = String((a && a.runId) || '');
      if (runId && (ws.runIds || []).indexOf(runId) >= 0) return { folded: false, reason: 'already delivered', session: ws.title || 'General' };
      const who = String((a && a.agentId) || 'agent');
      const prompt = String((a && a.prompt) || '').trim();
      if (!Array.isArray(ws.history)) ws.history = [];
      /* The instruction goes in as a sys marker, not a user turn: the Commander did not type it here, and
         chat.js excludes sys lines from historyWindow() so it is never replayed to the model as if they had. */
      if (prompt) ws.history.push({ role: 'system', sys: true, content: '— delegated to ' + who + ': ' + prompt.slice(0, 400) + ' —', ts: Date.now() });
      // agentId names the ACTUAL speaker so renderHistory attributes it to the worker, not the session's agent.
      ws.history.push({ role: 'assistant', content: text, agentId: who, ts: Date.now() });
      if (runId && Workstreams.appendRun) Workstreams.appendRun(ws.id, runId);
      else if (Workstreams.touch) Workstreams.touch(ws.id);
      if (Workstreams.markUnread) Workstreams.markUnread(ws.id);   // real new content the Commander has not seen
      const isOpen = Workstreams.activeId && Workstreams.activeId() === ws.id;
      if (isOpen && typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
      try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
      try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
      return { folded: true, session: ws.title || 'General', agentId: who };
    },

    /* Who is on the roster and what each one is for — the list a delegate call has to choose from. */
    'station.crew': () => {
      if (typeof App === 'undefined' || !App.agents) throw new Error('the crew roster is not ready yet');
      const crew = App.agents() || [];
      if (!crew.length) throw new Error('no crew are on this station yet');
      return {
        count: crew.length,
        crew: crew.map(a => ({ id: a.id, name: a.name || a.id, role: a.role || null, model: a.model || null }))
      };
    }
  };

  async function run(id, verb, args) {
    let out;
    try {
      const fn = VERBS[String(verb || '')];
      if (!fn) throw new Error('unknown station verb: ' + verb);
      out = { id, ok: true, result: await fn(args || {}) };
    } catch (error) {
      out = { id, ok: false, error: String((error && error.message) || error) };
    }
    try {
      await fetch('/api/station/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(out)
      });
    } catch (_) {
      // The sidecar's own timeout is the backstop: if the ack cannot be delivered, the command fails there
      // as unattended rather than hanging. Nothing to retry — a retried side-effect is a duplicated action.
    }
  }

  function init() {
    if (typeof U === 'undefined' || !U.bus || !U.bus.on) return;
    U.bus.on('station.command', msg => {
      if (!msg || !msg.id || !msg.verb) return;
      run(String(msg.id), String(msg.verb), msg.args);
    });
  }

  return { init, run, verbs: () => Object.keys(VERBS) };
})();

document.addEventListener('DOMContentLoaded', () => StationCommands.init());
