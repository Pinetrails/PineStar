/* sidecar/cron.js — the PURE cron-math core of the scheduled-routines subsystem (CRON Commit 1).

   The determinism keystone of the whole cron feature: every function here is a pure transform
   over (input, now) — `now` is always a PARAMETER (injected ms epoch), never the wall clock. There
   is NO Date.now / Math.random / setTimeout / fs in this file, so it passes lint-determinism.js and
   is headless-testable exactly like loop.js / permissions.js. The ambient half (the setInterval
   timer, the real now-source, id minting, persistence) lives only in sidecar/index.js — see
   docs/CRON_INTEGRATION_PLAN.md §3.1.

   Scope (andro, 2026-06-18): `interval`, `once`, and a deterministic 5-field cron subset:
   numeric fields with *, lists, ranges, and steps. Cron matching is UTC-based and zero-dep; it is
   intentionally not a full croniter port (no named months/days, seconds/year fields, or IANA tz).

   Surface:
     parseSchedule(str, now)               -> schedule | null     // "every 30m" / "in 2h" / ISO / cron
     nextFireAt(schedule, lastRunIso, now) -> int ms | null       // the single next fire after the anchor
     planTick(jobs, now)                   -> { fire[], skipped[], next[] }   // the whole tick as DATA
     dueJobs(jobs, now)                    -> { fire[], advanced[] }          // the no-backlog pair (fire + advance)
     computeGraceMs(schedule)              -> int ms               // catch-up tolerance window

   A `schedule` is one of:
     { kind:'interval', minutes:int, display:str }
     { kind:'once', runAt:int(ms epoch), display:str }
     { kind:'cron', expr:str, fields:{...}, dayOfMonthWildcard:bool, dayOfWeekWildcard:bool, display:str } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).cron = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const CRON_SEARCH_LIMIT_MS = 5 * 366 * DAY;       // enough to cover leap-day schedules
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

  function parseUInt(s) {
    return /^\d+$/.test(String(s || '')) ? parseInt(s, 10) : NaN;
  }

  function uniqueSorted(values) {
    const seen = Object.create(null), out = [];
    for (const v of values) {
      const k = String(v);
      if (!seen[k]) { seen[k] = true; out.push(v); }
    }
    return out.sort((a, b) => a - b);
  }

  function isFullRange(values, min, max) {
    if (!values || values.length !== (max - min + 1)) return false;
    for (let v = min; v <= max; v++) if (values.indexOf(v) < 0) return false;
    return true;
  }

  function parseCronField(raw, min, max, opts) {
    opts = opts || {};
    const normMin = opts.normMin != null ? opts.normMin : min;
    const normMax = opts.normMax != null ? opts.normMax : max;
    const sevenAsSunday = !!opts.sevenAsSunday;
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return null;
    const values = [];
    const parts = text.split(',');
    for (const part of parts) {
      if (!part) return null;
      const stepBits = part.split('/');
      if (stepBits.length > 2) return null;
      const base = stepBits[0];
      const step = stepBits.length === 2 ? parseUInt(stepBits[1]) : 1;
      if (!step || step <= 0 || isNaN(step)) return null;

      let start, end;
      if (base === '*') {
        start = min; end = max;
      } else if (base.indexOf('-') >= 0) {
        const rangeBits = base.split('-');
        if (rangeBits.length !== 2) return null;
        start = parseUInt(rangeBits[0]); end = parseUInt(rangeBits[1]);
      } else {
        start = parseUInt(base);
        end = stepBits.length === 2 ? max : start;  // "5/10" means 5-max/10
      }
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) return null;
      for (let v = start; v <= end; v += step) values.push(sevenAsSunday && v === 7 ? 0 : v);
    }
    const sorted = uniqueSorted(values);
    if (!sorted.length) return null;
    return { values: sorted, wildcard: isFullRange(sorted, normMin, normMax) };
  }

  function parseCronExpression(raw) {
    const expr = String(raw == null ? '' : raw).trim().split(/\s+/).join(' ');
    const parts = expr ? expr.split(/\s+/) : [];
    if (parts.length !== 5) return null;
    const minute = parseCronField(parts[0], 0, 59);
    const hour = parseCronField(parts[1], 0, 23);
    const dayOfMonth = parseCronField(parts[2], 1, 31);
    const month = parseCronField(parts[3], 1, 12);
    const dayOfWeek = parseCronField(parts[4], 0, 7, { sevenAsSunday: true, normMin: 0, normMax: 6 });
    if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
    return {
      kind: 'cron',
      expr: expr,
      fields: {
        minute: minute.values,
        hour: hour.values,
        dayOfMonth: dayOfMonth.values,
        month: month.values,
        dayOfWeek: dayOfWeek.values
      },
      dayOfMonthWildcard: dayOfMonth.wildcard,
      dayOfWeekWildcard: dayOfWeek.wildcard,
      display: 'cron ' + expr
    };
  }

  function cronSpec(schedule) {
    if (!schedule || schedule.kind !== 'cron') return null;
    const f = schedule.fields;
    if (f && Array.isArray(f.minute) && Array.isArray(f.hour) && Array.isArray(f.dayOfMonth) &&
      Array.isArray(f.month) && Array.isArray(f.dayOfWeek)) return schedule;
    return parseCronExpression(schedule.expr || '');
  }

  function has(values, value) { return values.indexOf(value) >= 0; }

  function cronMatchesSpec(spec, ms) {
    const d = new Date(ms);
    const f = spec.fields;
    if (!has(f.minute, d.getUTCMinutes())) return false;
    if (!has(f.hour, d.getUTCHours())) return false;
    if (!has(f.month, d.getUTCMonth() + 1)) return false;

    const dom = has(f.dayOfMonth, d.getUTCDate());
    const dow = has(f.dayOfWeek, d.getUTCDay());
    // Vixie/croniter-style day semantics: if both DOM and DOW are restricted, either may match.
    // If one is wildcard/full-range, the restricted field controls through ordinary AND matching.
    if (!spec.dayOfMonthWildcard && !spec.dayOfWeekWildcard) return dom || dow;
    return dom && dow;
  }

  function nextCronFireAt(schedule, anchorMs) {
    const spec = cronSpec(schedule);
    if (!spec) return null;
    let t = Math.floor((anchorMs || 0) / MIN) * MIN + MIN;  // strictly after the anchor, minute-granular
    const stop = t + CRON_SEARCH_LIMIT_MS;
    for (; t <= stop; t += MIN) if (cronMatchesSpec(spec, t)) return t;
    return null;
  }

  function isFireable(schedule) {
    return !!(schedule && (schedule.kind === 'once' || schedule.kind === 'interval' || schedule.kind === 'cron'));
  }

  function isRecurring(schedule) {
    return !!(schedule && (schedule.kind === 'interval' || schedule.kind === 'cron'));
  }

  function nextRecurringAt(schedule, now) {
    if (!schedule) return null;
    if (schedule.kind === 'interval') return now + periodMs(schedule);
    if (schedule.kind === 'cron') return nextCronFireAt(schedule, now);
    return null;
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
      if (minutes < 1) return null;
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

    // 4. CRON — deterministic 5-field subset: numeric fields with *, lists, ranges, and steps.
    const cron = parseCronExpression(raw);
    if (cron && nextCronFireAt(cron, now) != null) return cron;

    return null;
  }

  /* nextFireAt(schedule, lastRunIso, now) — the SINGLE next fire time strictly after the anchor
     (the last run if present, else now). Returns null when there is no future fire (a once-job that
     has already run, or an invalid cron schedule). Pure: no clock read. */
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
    if (schedule.kind === 'cron') {
      const parsed = lastRunIso ? Date.parse(lastRunIso) : NaN;
      const anchor = isNaN(parsed) ? now : parsed;
      return nextCronFireAt(schedule, anchor);
    }
    return null;
  }

  /* computeGraceMs(schedule) — how late a recurring fire may be and still run once (vs being declared a
     stale missed run and fast-forwarded). Mirrors Hermes's half-period clamped 2min..2h. */
  function computeGraceMs(schedule, anchor) {
    if (schedule && schedule.kind === 'interval') {
      return Math.max(2 * MIN, Math.min(2 * HOUR, periodMs(schedule) / 2));
    }
    if (schedule && schedule.kind === 'cron') {
      const base = anchor || 0;
      const first = nextCronFireAt(schedule, base);
      const second = first != null ? nextCronFireAt(schedule, first) : null;
      if (first != null && second != null) return Math.max(2 * MIN, Math.min(2 * HOUR, (second - first) / 2));
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
     Disabled/invalid schedules are ignored entirely (no skip noise). */
  function planTick(jobs, now) {
    now = now || 0;
    const fire = [], skipped = [], next = [];
    for (const job of (jobs || [])) {
      if (!job || job.enabled === false) continue;
      const sched = job.schedule;
      if (!isFireable(sched)) continue;
      if (sched.kind === 'once' && job.lastRunAt) continue;     // one-shot already ran

      const dueAt = dueAtOf(job, now);
      if (dueAt == null || isNaN(dueAt) || dueAt > now) continue;   // not due yet (or no computable fire)

      if (sched.kind === 'once') {
        // fire a one-shot whenever we first notice it is due — never silently drop a scheduled run.
        // markRun (the store reducer) sets lastRunAt afterward, making it permanently ineligible.
        fire.push({ jobId: job.id, scheduledFor: dueAt });
        continue;                                              // one-shots don't recur -> no `next`
      }

      // recurring (interval or cron)
      const lateness = now - dueAt;
      if (lateness <= computeGraceMs(sched, dueAt)) {
        const nextAt = nextRecurringAt(sched, now);
        if (nextAt == null) continue;
        fire.push({ jobId: job.id, scheduledFor: dueAt });
        next.push({ jobId: job.id, nextAt: nextAt, prevAt: dueAt });
      } else {
        // stale missed run: fast-forward to the next FUTURE occurrence and SKIP (at-most-one catch-up,
        // never a backlog burst). Intervals use O(1) arithmetic; cron uses the bounded next-fire search.
        let nextAt = null;
        if (sched.kind === 'interval') {
          const p = periodMs(sched);
          if (p <= 0) continue;
          const periods = Math.floor(lateness / p) + 1;        // smallest k with dueAt + k*p > now
          nextAt = dueAt + periods * p;
        } else if (isRecurring(sched)) {
          nextAt = nextRecurringAt(sched, now);
        }
        if (nextAt == null) continue;
        next.push({ jobId: job.id, nextAt: nextAt, prevAt: dueAt });
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
    _internals: {
      normalizeUnit: normalizeUnit,
      humanDuration: humanDuration,
      iso: iso,
      dueAtOf: dueAtOf,
      parseCronExpression: parseCronExpression,
      nextCronFireAt: nextCronFireAt
    }
  };
});
