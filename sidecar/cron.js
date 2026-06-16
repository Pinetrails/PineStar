/* sidecar/cron.js — the PURE cron-math core of the scheduled-routines subsystem (CRON Commit 1).

   The determinism keystone of the whole cron feature: every function here is a pure transform
   over (input, now) — `now` is always a PARAMETER (injected ms epoch), never the wall clock. There
   is NO Date.now / Math.random / setTimeout / fs in this file, so it passes lint-determinism.js and
   is headless-testable exactly like loop.js / permissions.js. The ambient half (the setInterval
   timer, the real now-source, id minting, persistence) lives only in sidecar/index.js — see
   docs/CRON_INTEGRATION_PLAN.md §3.1.

   v1 scope (andro, 2026-06-14): `interval` + `once` schedules only. 5-field cron expressions are
   RECOGNISED (so the UI can say "not yet") but DEFERRED — kept as {kind:'cron',supported:false},
   never fired. Interval + once are duration-anchored, so DST never bites them (§3.1).

   Surface:
     parseSchedule(str, now)               -> schedule | null     // "every 30m" / "in 2h" / ISO / cron
     nextFireAt(schedule, lastRunIso, now) -> int ms | null       // the single next fire after the anchor
     planTick(jobs, now)                   -> { fire[], skipped[], next[] }   // the whole tick as DATA
     dueJobs(jobs, now)                    -> { fire[], advanced[] }          // the no-backlog pair (fire + advance)
     computeGraceMs(schedule)              -> int ms               // catch-up tolerance window

   A `schedule` is one of:
     { kind:'interval', minutes:int, display:str }
     { kind:'once', runAt:int(ms epoch), display:str }
     { kind:'cron', expr:str, supported:false, display:str }      // deferred — never fires in v1 */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).cron = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const UNIT_MS = { s: 1000, m: MIN, h: HOUR, d: DAY };

  // normalize a unit token to one of s/m/h/d, or null if unrecognised.
  function normalizeUnit(u) {
    u = String(u || '').toLowerCase();
    if (/^(s|sec|secs|second|seconds)$/.test(u)) return 's';
    if (/^(m|min|mins|minute|minutes)$/.test(u)) return 'm';
    if (/^(h|hr|hrs|hour|hours)$/.test(u)) return 'h';
    if (/^(d|day|days)$/.test(u)) return 'd';
    return null;
  }

  // ms (with an argument — the lint bans only the zero-arg new Date()) -> ISO string. Deterministic in ms.
  function iso(ms) { return new Date(ms).toISOString(); }

  // a compact human label for an interval/duration in ms: prefers whole days/hours, else minutes.
  function humanDuration(ms) {
    const min = Math.round(ms / MIN);
    if (min > 0 && min % 1440 === 0) return (min / 1440) + 'd';
    if (min > 0 && min % 60 === 0) return (min / 60) + 'h';
    return min + 'm';
  }

  // The interval period in ms (0 for non-interval schedules).
  function periodMs(schedule) {
    return schedule && schedule.kind === 'interval' ? schedule.minutes * MIN : 0;
  }

  /* parseSchedule(str, now) — turn a human string into a tagged schedule, or null if unparseable.
     `now` is used ONLY to resolve a relative duration ("in 2h") into an absolute runAt; it is a
     parameter so the result is reproducible. Match order: interval -> once-duration -> ISO -> cron. */
  function parseSchedule(str, now) {
    const raw = String(str == null ? '' : str).trim();
    if (!raw) return null;
    now = now || 0;
    const lower = raw.toLowerCase();

    // 1. INTERVAL — "every <N> <unit>" (N optional => 1, e.g. "every hour"). Minute-granular: m/h/d only.
    let m = lower.match(/^every\s+(?:(\d+)\s*)?([a-z]+)$/);
    if (m) {
      const n = m[1] ? parseInt(m[1], 10) : 1;
      const u = normalizeUnit(m[2]);
      if (!u || u === 's' || n <= 0) return null;           // sub-minute intervals are meaningless vs a 60s tick
      const minutes = n * (u === 'm' ? 1 : u === 'h' ? 60 : 1440);
      // (the guard above already forces u∈{m,h,d} and n≥1, so minutes≥1 here — no sub-minute case to reject)
      return { kind: 'interval', minutes: minutes, display: 'every ' + humanDuration(minutes * MIN) };
    }

    // 2. ONCE (relative) — "in <N> <unit>" or a bare "<N><unit>". Seconds allowed for a one-shot.
    m = lower.match(/^(?:in\s+)?(\d+)\s*([a-z]+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      const u = normalizeUnit(m[2]);
      if (!u || n <= 0) return null;
      const runAt = now + n * UNIT_MS[u];
      return { kind: 'once', runAt: runAt, display: 'once at ' + iso(runAt) };
    }

    // 3. ONCE (absolute) — an ISO-8601-ish timestamp.
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const t = Date.parse(raw);
      if (!isNaN(t)) return { kind: 'once', runAt: t, display: 'once at ' + iso(t) };
    }

    // 4. CRON — a 5-field expression. Recognised but DEFERRED (never fires in v1); flagged for the UI.
    if (/^[\d*,/\-\s]+$/.test(raw) && raw.split(/\s+/).length === 5) {
      return { kind: 'cron', expr: raw.split(/\s+/).join(' '), supported: false, display: 'cron ' + raw };
    }

    return null;
  }

  /* nextFireAt(schedule, lastRunIso, now) — the SINGLE next fire time strictly after the anchor
     (the last run if present, else now). Returns null when there is no future fire (a once-job that
     has already run, or an unsupported/cron schedule). Pure: no clock read. */
  function nextFireAt(schedule, lastRunIso, now) {
    if (!schedule) return null;
    now = now || 0;
    if (schedule.kind === 'once') {
      if (lastRunIso) return null;            // one-shot already ran -> permanently ineligible
      return schedule.runAt;
    }
    if (schedule.kind === 'interval') {
      const p = periodMs(schedule);
      if (p <= 0) return null;
      const parsed = lastRunIso ? Date.parse(lastRunIso) : NaN;
      const anchor = isNaN(parsed) ? now : parsed;
      return anchor + p;                      // the next occurrence one period after the anchor
    }
    return null;                              // cron deferred (supported:false)
  }

  /* computeGraceMs(schedule) — how late a recurring fire may be and still run once (vs being declared a
     stale missed run and fast-forwarded). Mirrors Hermes's half-period clamped 2min..2h. */
  function computeGraceMs(schedule) {
    if (schedule && schedule.kind === 'interval') {
      return Math.max(2 * MIN, Math.min(2 * HOUR, periodMs(schedule) / 2));
    }
    return 5 * MIN;                            // unused for once-jobs (they fire whenever first noticed)
  }

  // current due time for a job: the persisted nextRunAt if present, else freshly computed. ms | null.
  function dueAtOf(job, now) {
    if (job && job.nextRunAt) { const t = Date.parse(job.nextRunAt); return isNaN(t) ? null : t; }
    return nextFireAt(job && job.schedule, job && job.lastRunAt, now);
  }

  /* planTick(jobs, now) — the entire scheduler tick expressed as DATA (no side effects). For each
     ENABLED job it decides: fire now / skip-as-caught-up / leave alone, and what next-fire to persist.
       fire    : [{ jobId, scheduledFor }]               the jobs to launch this tick
       skipped : [{ jobId, reason, scheduledFor }]       stale recurring jobs fast-forwarded (no backlog)
       next    : [{ jobId, nextAt, prevAt }]             the advanced next-fire to persist (advance-before-run)
     The host (index.js) applies this: persist `next`, then launch `fire`, emitting cron.* events.
     Disabled jobs and cron/invalid schedules are ignored entirely (no skip noise). */
  function planTick(jobs, now) {
    now = now || 0;
    const fire = [], skipped = [], next = [];
    for (const job of (jobs || [])) {
      if (!job || job.enabled === false) continue;
      const sched = job.schedule;
      if (!sched || (sched.kind !== 'once' && sched.kind !== 'interval')) continue;
      if (sched.kind === 'once' && job.lastRunAt) continue;     // one-shot already ran

      const dueAt = dueAtOf(job, now);
      if (dueAt == null || isNaN(dueAt) || dueAt > now) continue;   // not due yet (or no computable fire)

      if (sched.kind === 'once') {
        // fire a one-shot whenever we first notice it is due — never silently drop a scheduled run.
        // markRun (the store reducer) sets lastRunAt afterward, making it permanently ineligible.
        fire.push({ jobId: job.id, scheduledFor: dueAt });
        continue;                                              // one-shots don't recur -> no `next`
      }

      // interval (recurring)
      const p = periodMs(sched);
      const lateness = now - dueAt;
      if (lateness <= computeGraceMs(sched)) {
        fire.push({ jobId: job.id, scheduledFor: dueAt });
        next.push({ jobId: job.id, nextAt: now + p, prevAt: dueAt });
      } else {
        // stale missed run: fast-forward to the next FUTURE occurrence and SKIP (at-most-one catch-up,
        // never a backlog burst). O(1) arithmetic — no unbounded loop even after long downtime.
        const periods = Math.floor(lateness / p) + 1;          // smallest k with dueAt + k*p > now
        next.push({ jobId: job.id, nextAt: dueAt + periods * p, prevAt: dueAt });
        skipped.push({ jobId: job.id, reason: 'caught-up', scheduledFor: dueAt });
      }
    }
    return { fire: fire, skipped: skipped, next: next };
  }

  /* dueJobs(jobs, now) — the no-backlog PAIR: the fire set AND the advanced next-fire that must be
     persisted together (advancing nextFireAt without the planTick fast-forward loses the guarantee). */
  function dueJobs(jobs, now) {
    const r = planTick(jobs, now);
    return { fire: r.fire, advanced: r.next };
  }

  return {
    parseSchedule: parseSchedule,
    nextFireAt: nextFireAt,
    planTick: planTick,
    dueJobs: dueJobs,
    computeGraceMs: computeGraceMs,
    periodMs: periodMs,
    _internals: { normalizeUnit: normalizeUnit, humanDuration: humanDuration, iso: iso, dueAtOf: dueAtOf }
  };
});
