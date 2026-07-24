/* sidecar/slash-actions.js -- server-side execution for slash commands that declare dispatch:'server'.

   WHY THIS EXISTS. Until now a slash command could only reach the sidecar if someone hand-wrote a fetch()
   inside its handler in frontend/app/chat.js. That made every backend-touching command a bespoke wiring job
   (and let /build-away drift out of the server catalog entirely, since nothing but the browser knew it). A
   command declaring dispatch:'server' instead names an action here; POST /api/slash/dispatch awaits it and
   returns a { type:'say' } directive carrying the finished, honest text. The browser only prints it — so the
   channel hub and the external harness can run the identical command and read the identical answer.

   TRUTHFUL TELEMETRY. Every line these actions return must describe what the store ACTUALLY did. A create
   that the mint gate deduped says "that already exists"; a routine created while the scheduler is disarmed
   says so in the same breath, because a routine that cannot fire must never read as armed.

   Deps are injected (same pattern as makeChannelHub) so this module stays testable without a live sidecar. */
'use strict';

const MAX_LIST = 25;                       // a chat readout is a glance, not a database dump
const RESERVED_AWAY = ['on', 'off', 'list', 'status', 'now'];

function makeSlashActions(deps) {
  const d = deps || {};
  const cron = d.cron || {};
  const workshop = d.workshop || {};
  const now = typeof d.now === 'function' ? d.now : () => 0;

  const say = (text) => ({ ok: true, text: String(text || '') });
  const card = (title, lines) => ({ ok: true, title: String(title || ''), lines: (lines || []).map(String) });
  const fail = (text) => ({ ok: false, text: String(text || '') });

  // "add every 30m | check the build" -> { verb:'add', rest:'every 30m | check the build' }
  function splitVerb(args) {
    const s = String(args || '').trim();
    if (!s) return { verb: '', rest: '' };
    const sp = s.search(/\s/);
    if (sp === -1) return { verb: s.toLowerCase(), rest: '' };
    return { verb: s.slice(0, sp).toLowerCase(), rest: s.slice(sp + 1).trim() };
  }

  // Resolve "3" (1-based position in the SAME order the list command printed) or a raw job id. Position is what
  // a chat user actually has in hand; ids are uuids nobody retypes. Returns null when it matches neither.
  function pickFrom(list, token) {
    const t = String(token || '').trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) {
      const i = parseInt(t, 10) - 1;
      return (i >= 0 && i < list.length) ? list[i] : null;
    }
    return list.find(j => j && String(j.id) === t) || null;
  }

  function jobLine(j, i) {
    const state = j.enabled === false ? 'paused' : 'scheduled';
    const when = j.enabled === false ? 'paused'
      : (j.nextRunAt ? ('next ' + j.nextRunAt) : 'no next fire');
    const last = j.lastStatus ? ('; last ' + j.lastStatus + (j.lastError ? ' (' + String(j.lastError).slice(0, 60) + ')' : '')) : '';
    return (i + 1) + '. ' + (j.name || '(unnamed)') + ' — ' + (j.scheduleDisplay || 'no schedule')
      + ' [' + state + ', ' + when + ']' + last;
  }

  /* ---------------- /routine ---------------- */

  // The scheduler being DISARMED is the single most confusing state in this subsystem: routines exist, look
  // healthy, and never fire. Every routine readout that could be misread as "this will run" carries this.
  function armedNote() {
    if (typeof cron.armed !== 'function') return '';
    return cron.armed() ? '' : ' Routines are NOT armed right now, so nothing will fire — /cron on to arm them.';
  }

  async function routineAction(args) {
    if (!cron || typeof cron.jobs !== 'function') return fail('Routines are not available on this station.');
    const { verb, rest } = splitVerb(args);
    const all = (cron.jobs() || []).filter(Boolean);

    if (!verb || verb === 'list') {
      if (!all.length) return say('No routines yet. /routine add <schedule> | <task> — e.g. /routine add every 30m | check the build.' + armedNote());
      const shown = all.slice(0, MAX_LIST);
      const lines = shown.map(jobLine);
      if (all.length > shown.length) lines.push('… and ' + (all.length - shown.length) + ' more (see the ROUTINES panel).');
      const note = armedNote();
      if (note) lines.push(note.trim());
      return card('Routines (' + all.length + ')', lines);
    }

    if (verb === 'preview') {
      if (!rest) return fail('Usage: /routine preview <schedule> — e.g. /routine preview 0 9 * * *');
      if (typeof cron.preview !== 'function') return fail('Schedule preview is not wired on this station.');
      const p = cron.preview(rest);
      if (!p || p.ok === false) return fail(String((p && p.error) || 'Could not read that schedule.'));
      const lines = (p.localNext || []).map((t, i) => (i + 1) + '. ' + t);
      if (!lines.length) lines.push('(no upcoming fire times — the schedule is valid but never comes due)');
      return card((p.display || rest) + ' — next ' + lines.length, lines);
    }

    if (verb === 'add' || verb === 'new') {
      // "<schedule> | <task>" — a pipe, because both halves legitimately contain spaces ("every 30 minutes",
      // "0 9 * * *", and any English task). Refusing the ambiguous no-pipe form beats guessing wrong.
      const bar = rest.indexOf('|');
      if (bar === -1) {
        return fail('Usage: /routine add <schedule> | <task>. The pipe separates them — e.g. '
          + '/routine add every 30m | check whether the build went green. '
          + 'Schedules: "every 30m", "in 2h", "0 9 * * *", or an ISO timestamp.');
      }
      const schedule = rest.slice(0, bar).trim();
      const task = rest.slice(bar + 1).trim();
      if (!schedule) return fail('That routine has no schedule — /routine add <schedule> | <task>.');
      if (!task) return fail('That routine has no task — say what it should do after the pipe.');
      if (typeof cron.create !== 'function') return fail('Creating routines is not wired on this station.');
      const r = await cron.create({ name: task.slice(0, 60), prompt: task, schedule: schedule });
      if (!r || r.ok === false) {
        if (r && r.declined) return fail('You deleted a routine by that name before, so it will not be re-created.');
        return fail(String((r && r.error) || 'The station refused that routine.'));
      }
      if (r.duplicate) {
        const j = r.job || {};
        return say('A routine named "' + (j.name || task.slice(0, 60)) + '" already exists (' + (j.scheduleDisplay || 'no schedule') + ') — not creating a second one.');
      }
      const j = r.job || {};
      return say('Routine created: "' + (j.name || task.slice(0, 60)) + '" — ' + (j.scheduleDisplay || schedule)
        + (j.nextRunAt ? ', first fire ' + j.nextRunAt : '') + '.' + armedNote());
    }

    // NOTE: no `run` verb. Firing a routine on demand streams NDJSON through handleCronRun, which is welded to
    // its response object; a chat-side copy would have to duplicate the whole run/lease/markRun path. The
    // ROUTINES panel already carries Run Now, so the capability HAS a door — it just isn't this one.
    if (verb === 'run') {
      return fail('Run-now lives in the ROUTINES panel (it streams the run live). /routine list to find it there.');
    }

    if (verb === 'pause' || verb === 'resume') {
      const j = pickFrom(all, rest);
      if (!j) return fail(rest ? ('No routine ' + rest + ' — /routine list to see them.') : ('Usage: /routine ' + verb + ' <number>'));
      if (typeof cron.update !== 'function') return fail('Editing routines is not wired on this station.');
      const want = verb === 'resume';
      const r = await cron.update(j.id, { enabled: want });
      if (!r || r.ok === false) return fail('Could not ' + verb + ' "' + (j.name || j.id) + '": ' + String((r && r.error) || 'the write failed') + '.');
      const nj = r.job || {};
      return say('"' + (nj.name || j.name || j.id) + '" is now ' + (want ? 'scheduled' : 'paused')
        + (want && nj.nextRunAt ? ' — next fire ' + nj.nextRunAt : '') + '.' + (want ? armedNote() : ''));
    }

    if (verb === 'rm' || verb === 'remove' || verb === 'delete') {
      const j = pickFrom(all, rest);
      if (!j) return fail(rest ? ('No routine ' + rest + ' — /routine list to see them.') : 'Usage: /routine rm <number>');
      if (typeof cron.remove !== 'function') return fail('Deleting routines is not wired on this station.');
      const r = await cron.remove(j.id);
      if (!r || r.ok === false) return fail('Could not delete "' + (j.name || j.id) + '": ' + String((r && r.error) || 'the write failed') + '.');
      return say('Deleted routine "' + (j.name || j.id) + '".');
    }

    return fail('Unknown: /routine ' + verb + '. Try list, add, preview, pause, resume, rm.');
  }

  /* ---------------- /away ---------------- */

  // Everything the away workshop does is gated on a per-agent grant. A queued idea with the grant OFF will sit
  // there forever, so the grant state rides every reply that could otherwise read as "this will get built".
  function grantNote(granted) {
    return granted ? '' : ' "Build while away" is OFF for this agent, so nothing will be built yet — /away on to turn it on.';
  }

  // runWorkshopShift reports machine reason codes ('no-capability', 'empty-backlog'). Printing those raw at a
  // beginner is a dead end: true, but unactionable. Translate the known ones and name the next step; an
  // unrecognized code still passes through verbatim rather than being swallowed or guessed at.
  const SHIFT_REASONS = {
    'no-capability': 'this agent has no model credential it can build with yet — add a key in SETTINGS → PROVIDERS',
    'empty-backlog': 'there is nothing queued to build — /away <what to build> adds one',
    'not-granted': '"build while away" is off for this agent — /away on to turn it on',
    'bad-agent': 'that agent id is not one of your station agents'
  };
  function shiftReason(code) {
    const c = String(code || '').trim();
    return SHIFT_REASONS[c] || (c || 'nothing was eligible');
  }

  async function awayAction(args, ctx) {
    if (!workshop || typeof workshop.state !== 'function') return fail('The away workshop is not available on this station.');
    const agentId = String((ctx && ctx.agentId) || 'agent');
    const raw = String(args || '').trim();
    const low = raw.toLowerCase();
    // A reserved verb only counts when it is the WHOLE argument — so "/away on" toggles the grant while
    // "/away on-call dashboard" is still a build request, not a mangled toggle.
    const isReserved = RESERVED_AWAY.indexOf(low) !== -1;

    if (!raw || (isReserved && (low === 'list' || low === 'status'))) {
      const st = await workshop.state(agentId);
      if (!st || st.ok === false) return fail('Could not read the away workshop: ' + String((st && st.error) || 'no answer') + '.');
      const items = (st.backlog || []).slice(0, MAX_LIST);
      const lines = items.map((it, i) => (i + 1) + '. ' + String((it && (it.title || it.detail)) || '(untitled)').slice(0, 120)
        + (it && it.builtRunId ? '  [built — waiting in OUTBOX]' : ''));
      if (!items.length) lines.push('(nothing queued — /away <what to build> adds one)');
      if ((st.backlog || []).length > items.length) lines.push('… and ' + ((st.backlog || []).length - items.length) + ' more.');
      if (st.pending) lines.push('' + st.pending + ' finished build' + (st.pending === 1 ? '' : 's') + ' waiting for your keep/discard — open OUTBOX.');
      lines.push('Build while away: ' + (st.granted ? 'ON' : 'OFF') + '.');
      return card('Away workshop — ' + (st.backlog || []).length + ' queued', lines);
    }

    if (isReserved && (low === 'on' || low === 'off')) {
      const want = low === 'on';
      if (typeof workshop.grant !== 'function') return fail('The away grant is not wired on this station.');
      const r = await workshop.grant(agentId, want);
      if (!r || r.ok === false) return fail('Could not turn "build while away" ' + (want ? 'on' : 'off') + ': ' + String((r && r.error) || 'the write failed') + '.');
      return say(want
        ? '"Build while away" is ON — this agent will work its queue on its next away shift while the station is up.'
        : '"Build while away" is OFF — the queue is kept, but nothing new will be built.');
    }

    if (isReserved && low === 'now') {
      if (typeof workshop.shiftNow !== 'function') return fail('Firing an away shift is not wired on this station.');
      const r = await workshop.shiftNow(agentId);
      if (!r || r.ok === false) return fail('Could not run an away shift: ' + String((r && r.error) || 'the station refused it') + '.');
      if (r.fired === false) return say('No away shift ran — ' + shiftReason(r.reason) + '.');
      return say('Away shift ran' + (r.built ? ' and built "' + String(r.built).slice(0, 80) + '"' : '') + '. Finished work waits in OUTBOX for keep or discard.');
    }

    // Anything else is the thing to build.
    if (typeof workshop.queue !== 'function') return fail('Queueing away builds is not wired on this station.');
    const r = await workshop.queue(agentId, raw);
    if (!r || r.ok === false) return fail('Could not queue that: ' + String((r && r.error) || 'the station refused it') + '.');
    return say('Queued for the away workshop: "' + raw.slice(0, 80) + '".' + grantNote(r.granted !== false));
  }

  const ACTIONS = { routine: routineAction, away: awayAction };

  /* run(action, args, ctx) -> { ok, text? , title?, lines? }. NEVER throws: a broken dep must degrade to an
     honest refusal line, because the caller (an HTTP handler) would otherwise 500 on a typo'd command. */
  async function run(action, args, ctx) {
    const fn = ACTIONS[String(action || '')];
    if (!fn) return { ok: false, status: 404, text: 'That command has no server action.' };
    try { return await fn(String(args == null ? '' : args).trim(), ctx || {}); }
    catch (e) { return { ok: false, text: 'That command failed: ' + ((e && e.message) || String(e)) }; }
  }

  return { run: run, actions: Object.keys(ACTIONS), _internals: { splitVerb, pickFrom, jobLine } };
}

module.exports = { makeSlashActions, MAX_LIST };
