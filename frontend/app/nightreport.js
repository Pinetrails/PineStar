/* STARNET — nightreport.js : the PURE engine for the MORNING REPORT (NS-4).

   THE PROMISE: Andrew must never again wonder "what did you do all night, and if nothing, why?". On the first
   activity after a real absence, the station owes ONE honest digest — the acts it fired AND the honest other half
   (what it DECLINED, and the one plain reason it did nothing at all). This module composes that digest from the
   three truthful-telemetry surfaces the night-shift already serves:

     • GET /api/nightshift/status  → { active, away, beatsUsedToday, leashPerDay, lastBeatAt, nextEligibleAt, binding }
     • GET /api/autonomy/ledger    → recent decisions (source:'nightshift', kind:'act'|'decline'|'note', binding, reason)
     • GET /api/nightshift/drafts  → the acts left on the desk ({ title, archetype, at, body, note })

   EVERY line here maps to one of those provable fields — the report never asserts state the harness can't prove
   (the product's core law). PURE + node-testable, mirroring autonomy.js / autopilot.js: a `NightReport` global in
   the browser, module.exports under node. NO Date.now / Math.random — the report is a deterministic function of the
   three payloads + an explicit `nowMs`. Time formatting takes an explicit tz-offset so LOCAL time is testable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.NightReport = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The night-shift decision gates, in the order the driver checks them (nightshift.js). Each maps to ONE plain,
  // honest sentence naming why a beat could not fire — so an empty night reads as a reason, never a shrug.
  //   posture: the dial itself forbade acting; present: Andrew was here; the rest are transient runtime gates.
  const BINDING_PHRASE = {
    posture: "the dial was below 'build' — I'm not allowed to act unattended",
    present: 'you were here — the night shift only runs while you’re away',
    halt: 'the emergency stop was engaged',
    leash: 'the daily leash was already spent',
    cooldown: 'it wasn’t time for the next beat yet',
    concurrency: 'the desk was busy with another run',
    'in-flight': 'a beat was still running',
    'persist-failed': 'the station couldn’t safely record the work, so it stood down'
  };

  // a stable, HONEST label for a binding we don't recognise (forward-compat: a new gate name renders as itself,
  // never a fabricated reason). Used by both the report's idle sentence and the panel's decision trail.
  function bindingPhrase(binding) {
    if (binding == null || binding === '') return 'no gate is blocking a beat right now';
    return BINDING_PHRASE[binding] || ('held back by the ' + String(binding) + ' gate');
  }

  // ---- LOCAL-TIME formatting (GB-13 timezone honesty) ------------------------------------------------------------
  // Format an epoch-ms as a LOCAL "1:10 AM" clock. tzOffsetMin = minutes to ADD to UTC to reach local (i.e. the
  // NEGATIVE of Date#getTimezoneOffset — the browser store passes -new Date().getTimezoneOffset()). Pure + testable:
  // no Date construction, no ambient zone. 0/invalid ms → '' (a report never prints a fake "12:00 AM" for no data).
  function fmtLocalTime(ms, tzOffsetMin) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const off = Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) : 0;
    const local = n + off * 60000;
    let mins = Math.floor(local / 60000) % 1440;
    if (mins < 0) mins += 1440;
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h < 12 ? 'AM' : 'PM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  }

  // pluralise a count with its noun ("1 beat" / "2 beats"). Pure helper the headline + lines share.
  function plural(n, noun) { return n + ' ' + noun + (n === 1 ? '' : 's'); }

  // ---- report composition ----------------------------------------------------------------------------------------
  // compose({ status, ledger, drafts, awaySince, nowMs, tzOffsetMin }) → the full morning-report view model, or
  // { hasReport:false } when there is genuinely nothing to say (so the caller shows NO beat — never a nag).
  //
  //   status  : GET /api/nightshift/status payload (or null if unreachable)
  //   ledger  : array of ledger entries (already newest-first); we scope to source:'nightshift' + the away window
  //   drafts  : GET /api/nightshift/drafts payload's drafts array
  //   awaySince: ms epoch the away window opened (only decisions after this belong to THIS absence)
  //
  // hasReport is true iff the night shift ACTED (≥1 draft/act) OR DECLINED at least once in this window — i.e. there
  // is a real decision to report. A window with zero night-shift decisions (the shift never even considered a beat,
  // e.g. the dial was off the whole time) → { hasReport:false }: nothing happened AND nothing was suppressed, so
  // there is nothing honest to announce. (The panel still shows the always-on posture; the BEAT stays silent.)
  function compose(input) {
    input = input || {};
    const status = input.status || null;
    const nowMs = Number(input.nowMs) || 0;
    const awaySince = Number(input.awaySince) || 0;
    const tz = input.tzOffsetMin;

    // ledger: only THIS station's night-shift decisions inside the away window, newest-first as given.
    const rawLedger = Array.isArray(input.ledger) ? input.ledger : [];
    const scoped = rawLedger.filter(e => e && e.source === 'nightshift' && Number(e.ts) >= awaySince && e.kind !== 'note');
    const acts = scoped.filter(e => e.kind === 'act');
    const declines = scoped.filter(e => e.kind === 'decline');

    // drafts are the RICHEST act surface (real titles + bodies); they lead. Fall back to ledger acts for a title
    // when the drafts route was unreachable but the ledger recorded the act (honest, never invented).
    const rawDrafts = Array.isArray(input.drafts) ? input.drafts : [];
    const draftList = rawDrafts
      .filter(d => d && Number(d.at) >= awaySince && d.title)
      .map(d => ({ title: String(d.title), at: Number(d.at) || 0, body: String(d.body || ''), note: String(d.note || ''), archetype: d.archetype || '' }));

    const actCount = Math.max(draftList.length, acts.length);
    const declineCount = declines.length;

    // NOTHING to report: no act, no decline in this window. Caller shows no beat.
    if (actCount === 0 && declineCount === 0) return { hasReport: false, actCount: 0, declineCount: 0 };

    // NS-5b: the report LEADS with the declared night FOCUS + its cited evidence, so a wrong guess is visible and
    // correctable ("actually, focus on Y"). Every claim maps to status.focus (truthful telemetry — never invented).
    const focus = (status && status.focus) || input.focus || null;
    let priorityLine = '';
    if (focus && (focus.label || focus.ref)) {
      const why = Array.isArray(focus.why) ? focus.why.filter(Boolean).join('; ') : '';
      priorityLine = 'priority: ' + String(focus.label || focus.ref) + (focus.source === 'steer' ? ' (you steered this)' : '') + (why ? ' — because ' + why : '');
    }

    // headline — "N beats fired, M drafts on your desk" (reuse the beats/drafts vocabulary the digest already uses).
    const headline = actCount > 0
      ? (plural(actCount, 'beat') + ' fired' + (draftList.length ? ', ' + plural(draftList.length, 'draft') + ' on your desk' : ''))
      : (plural(declineCount, 'beat') + ' skipped — nothing landed on your desk');

    // ACT lines: one per draft (real title). If the drafts route was down but the ledger has acts, list the count.
    const actLines = draftList.length
      ? draftList.map(d => '✓ ' + d.title)
      : (acts.length ? [plural(acts.length, 'beat') + ' fired (drafts unavailable to list)'] : []);

    // DECLINE lines: the honest other half. Group declines by their binding, name the gate + the time of the last
    // occurrence in LOCAL clock ("2 beats skipped — leash spent by 1:10 AM"). Deterministic ordering by binding.
    const byBinding = {};
    for (const d of declines) {
      const b = (d.binding == null || d.binding === '') ? 'unknown' : String(d.binding);
      if (!byBinding[b]) byBinding[b] = { count: 0, lastTs: 0 };
      byBinding[b].count += 1;
      const ts = Number(d.ts) || 0;
      if (ts > byBinding[b].lastTs) byBinding[b].lastTs = ts;
    }
    const declineLines = Object.keys(byBinding).sort().map(b => {
      const g = byBinding[b];
      const when = fmtLocalTime(g.lastTs, tz);
      return '— ' + plural(g.count, 'beat') + ' skipped: ' + bindingPhrase(b) + (when ? ' (by ' + when + ')' : '');
    });

    // THE "DID NOTHING AND WHY" sentence: only when the shift fired zero acts. Derive the dominant reason from the
    // most-common decline binding in the window; if there were no declines either the current live binding (status)
    // explains it. Always ONE plain sentence, always provable.
    let idleReason = '';
    if (actCount === 0) {
      let dominant = null, best = -1;
      for (const b of Object.keys(byBinding)) { if (byBinding[b].count > best) { best = byBinding[b].count; dominant = b; } }
      const bind = dominant || (status && status.binding) || null;
      idleReason = 'Nothing landed on your desk — ' + bindingPhrase(bind === 'unknown' ? null : bind) + '.';
    }

    return {
      hasReport: true,
      actCount: actCount,
      declineCount: declineCount,
      priorityLine: priorityLine,
      headline: headline,
      actLines: actLines,
      declineLines: declineLines,
      idleReason: idleReason,
      drafts: draftList   // the caller reveals full bodies on "show me"
    };
  }

  // ---- the NIGHT SHIFT PANEL view model (item #2) -----------------------------------------------------------------
  // panelModel({ status, tzOffsetMin, nowMs }) → the honest status surface for the dial panel. Every field maps to a
  // status route field; a null status → an explicit unreachable model (never a fake-zero). No decision-trail here —
  // the panel renders that straight from the ledger rows (see trailLine).
  function panelModel(input) {
    input = input || {};
    const s = input.status;
    const tz = input.tzOffsetMin;
    if (!s || typeof s !== 'object') {
      return { reachable: false, stateText: 'station telemetry unreachable', detail: '' };
    }
    const active = !!s.active;
    const away = !!s.away;
    const used = Number(s.beatsUsedToday) || 0;
    // leashPerDay is null when never configured (the status route sends null, not 0). Number(null)===0 is finite, so
    // guard on the RAW value being a real number before trusting it — a null leash must never render as "used/0".
    const leash = (typeof s.leashPerDay === 'number' && Number.isFinite(s.leashPerDay)) ? s.leashPerDay : null;
    // STATE: ACTIVE (armed) vs OFF, and the honest WHY when OFF (the live binding names the blocking gate).
    const off = !active;
    const stateText = off ? 'OFF' : (away ? 'ACTIVE · on watch' : 'ACTIVE · standing by');
    const whyOff = off ? bindingPhrase(s.binding) : (s.binding ? bindingPhrase(s.binding) : bindingPhrase(null));
    return {
      reachable: true,
      active: active,
      away: away,
      stateText: stateText,
      why: whyOff,
      presence: away ? 'you’re away' : 'you’re present',
      leashText: leash == null ? (used + ' beats today') : (used + '/' + leash + ' beats today'),
      leashSpent: leash != null && used >= leash,
      lastBeatText: fmtLocalTime(s.lastBeatAt, tz) || 'no beat yet',
      nextEligibleText: fmtLocalTime(s.nextEligibleAt, tz) || 'when the next window opens'
    };
  }

  // one decision-trail row for the panel's scrollable ledger: "1:10 AM · declined · leash spent". Pure; a bad row
  // still renders its time + kind (never throws). kindLabel keeps the vocabulary honest (act/decline/note → words).
  function trailLine(entry, tzOffsetMin) {
    const e = entry || {};
    const when = fmtLocalTime(e.ts, tzOffsetMin) || '—';
    const kind = e.kind === 'act' ? 'acted' : (e.kind === 'decline' ? 'declined' : 'noted');
    let tail = '';
    if (e.kind === 'decline') tail = bindingPhrase(e.binding);
    else if (e.kind === 'act') tail = (e.detail && e.detail.title) ? String(e.detail.title) : (e.reason || 'left a draft');
    else tail = e.reason || (e.detail && e.detail.title) || '';
    return when + ' · ' + kind + (tail ? ' · ' + tail : '');
  }

  return { compose, panelModel, trailLine, fmtLocalTime, bindingPhrase, plural, BINDING_PHRASE };
});
