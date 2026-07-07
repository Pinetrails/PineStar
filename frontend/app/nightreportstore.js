/* STARNET — nightreportstore.js : the thin live wiring around the pure MORNING-REPORT engine (nightreport.js), NS-4.

   THE JOB: on the FIRST activity after a genuine absence, fetch the three night-shift truthful-telemetry surfaces
   (status + autonomy ledger + drafts) and surface ONE honest COMMS digest beat — the acts fired AND the declined
   half (which gate held them back), or the one plain "did nothing and why" sentence. No absence → no beat (never
   nag). One beat per page session (anti-nag), and it rides Chat.nudge so it obeys one-beat-at-a-time + vanish() on
   decision — the LOCKED COMMS beat rules.

   The AWAY BOUNDARY is borrowed from ReturnStore (the durable lastSeenAt heartbeat that already means "the app was
   genuinely closed") so this report and the run digest agree on exactly one notion of "away" — never a second,
   divergent clock. This store composes NOTHING itself: nightreport.compose() owns every rendered claim, and every
   claim maps to a route field (truthful telemetry). NEVER emits on U.bus; fail-open everywhere (a down route → no
   beat, never a fake one). */
'use strict';
const NightReportStore = (() => {
  const KEY = 'starnet.nightreport.v1';
  const DELAY_MS = 1400;           // let the floor + COMMS settle before the beat (mirrors ReturnStore's cadence)
  const HEARTBEAT_MS = 30000;      // stamp "the app is open" — so "away" means it was genuinely CLOSED
  const MIN_AWAY_MS = 15 * 60000;  // "genuinely away" — matches the sidecar's default NIGHTSHIFT_AWAY_MS (15 min)
  let fired = false;               // ONE report per page session (survives enterGame re-entry)
  let agentId = 'agent';
  let boundary = 0;                // the PREVIOUS session's last-seen stamp (captured at init, before we heartbeat)
  let hbTimer = 0;
  let wired = false;

  // the durable last-seen stamp. Its OWN key (not ReturnStore's) so the two never race over one value: ReturnStore
  // advances its stamp during its init, which would erase the boundary this report needs. Reading our own stamp
  // BEFORE the first heartbeat gives an honest "app was closed since" mark. Bounded to a single number.
  function loadStamp() { try { return Number(localStorage.getItem(KEY)) || 0; } catch (_) { return 0; } }
  function stamp() { try { localStorage.setItem(KEY, String(Date.now())); } catch (_) {} }

  // the LOCAL tz offset in minutes to ADD to UTC (the negative of getTimezoneOffset). Passed to the pure engine so
  // every rendered time is LOCAL and correctly labeled (GB-13 timezone honesty). Recomputed per report (DST-safe).
  function tzOffsetMin() { try { return -new Date().getTimezoneOffset(); } catch (_) { return 0; } }

  async function getJSON(url) {
    try { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) return null; return await r.json(); }
    catch (_) { return null; }
  }

  // the away boundary: our own PREVIOUS-session stamp, captured at init before the first heartbeat overwrote it.
  // 0 (first-ever session) → we never report (nothing to be away from).
  function awayBoundary() { return boundary; }

  // compose + show the report. Guarded: one per session, only after a genuine absence, only when there's something
  // honest to say (compose → hasReport). Fail-open: any missing dependency simply skips the beat.
  async function maybeReport() {
    if (fired) return;
    if (typeof NightReport === 'undefined' || typeof Chat === 'undefined' || !Chat.nudge) return;
    const awaySince = awayBoundary();
    const now = Date.now();
    if (!(awaySince > 0 && (now - awaySince) >= MIN_AWAY_MS)) return;   // no real absence → no beat

    // fetch the three surfaces in parallel; scope drafts/ledger to the away window server-side where we can.
    const [status, ledgerRes, draftsRes] = await Promise.all([
      getJSON('/api/nightshift/status'),
      getJSON('/api/autonomy/ledger?source=nightshift&limit=200'),
      getJSON('/api/nightshift/drafts?since=' + encodeURIComponent(awaySince) + '&limit=20')
    ]);
    // status being null is tolerable (the report can still list acts/declines from the ledger); an entirely
    // unreachable station (no ledger AND no drafts) → nothing to compose, so no beat.
    const ledger = (ledgerRes && Array.isArray(ledgerRes.entries)) ? ledgerRes.entries : [];
    const drafts = (draftsRes && Array.isArray(draftsRes.drafts)) ? draftsRes.drafts : [];

    const tz = tzOffsetMin();
    let report;
    try { report = NightReport.compose({ status, ledger, drafts, awaySince, nowMs: now, tzOffsetMin: tz }); }
    catch (_) { return; }
    if (!report || !report.hasReport) return;   // nothing acted AND nothing suppressed → no beat (never a nag)

    fired = true;   // spend the session's single report even if the beat is later dismissed (anti-nag)

    // the BEAT body: headline + the act lines + the honest declined half (+ the "did nothing and why" sentence when
    // it stood down entirely). Composed ENTIRELY from the report view-model — no invented text.
    const lines = [];
    for (const l of (report.actLines || [])) lines.push(l);
    for (const l of (report.declineLines || [])) lines.push(l);
    if (report.idleReason) lines.push(report.idleReason);
    const body = '✦ welcome back — while you were away: ' + report.headline + (lines.length ? '\n' + lines.join('\n') : '');

    // "show me" prints every draft's full body straight into the feed (transparency law — the report must be able
    // to SHOW the work, not just count it). "got it" dismisses; both LEAVE the beat (nudge vanish()es on decision).
    const reveal = () => {
      if (typeof Chat === 'undefined' || typeof Chat.localLine !== 'function') return;
      const ds = report.drafts || [];
      if (!ds.length) { Chat.localLine('(the night shift left no draft bodies — the acts above are the record)'); return; }
      for (const d of ds) {
        if (!d || !d.title) continue;
        Chat.localLine('▤ ' + String(d.title).trim());
        if (d.body) Chat.localLine(String(d.body));
        if (d.note) Chat.localLine('note: ' + String(d.note));
      }
    };
    const opts = (report.drafts && report.drafts.length)
      ? [{ label: 'show me', value: 'show' }, { label: 'got it', value: 'ok', skip: true }]
      : [{ label: 'got it', value: 'ok', skip: true }];
    Chat.nudge(body, opts, item => { if (item && item.value === 'show') reveal(); });
    if (typeof World !== 'undefined' && World.say) { try { World.say(report.actCount ? '✦ left the night’s work on your desk' : '✦ nothing to report from the night'); } catch (_) {} }
  }

  /* init({ enabled, agentId }) — called from enterGame, AFTER ReturnStore.init (so lastSeen() is the previous
     session's stamp, already captured). enabled:false (the awakening) never fires — a first session has no honest
     "away" baseline. Deferred behind DELAY_MS so it never races the floor/COMMS boot. */
  function init(opts) {
    opts = opts || {};
    if (opts.agentId) agentId = String(opts.agentId);
    boundary = loadStamp();          // capture the PREVIOUS session's stamp BEFORE we heartbeat over it
    stamp();                         // we are attended NOW
    if (hbTimer) { try { clearInterval(hbTimer); } catch (_) {} }
    if (typeof setInterval === 'function') hbTimer = setInterval(stamp, HEARTBEAT_MS);
    if (!wired && typeof window !== 'undefined' && window.addEventListener) { wired = true; try { window.addEventListener('beforeunload', stamp); } catch (_) {} }
    if (opts.enabled === false) return;   // the awakening still stamps attendance, just never fires the beat
    setTimeout(() => { maybeReport().catch(() => {}); }, DELAY_MS);
  }

  // a fresh Commander (S2/new-hero) inherits no report state.
  function reset() { fired = false; boundary = 0; try { localStorage.removeItem(KEY); } catch (_) {} }

  // test/inspection seam: force a report attempt (used by the DOM round-trip proof). An optional { boundary, reset }
  // lets the proof simulate a genuine away window without waiting 15 real minutes. Never used by the live path.
  function _fireNow(o) {
    o = o || {};
    if (o.reset) fired = false;
    if (Number.isFinite(Number(o.boundary))) boundary = Number(o.boundary);
    return maybeReport();
  }

  return { init, reset, _fireNow, _state: () => ({ fired }) };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { NightReportStore };
