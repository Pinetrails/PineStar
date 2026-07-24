/* node test/slash-actions.test.js -- server-side execution for dispatch:'server' slash commands.

   These run against INJECTED deps (no sidecar, no disk), so they pin the contract that matters: what the user
   is TOLD. The recurring failure this guards is a command that reports success the store never performed —
   a created routine that cannot fire, a queued build behind an OFF grant, a deleted routine that still exists. */
'use strict';

const A = require('./_assert.js');
const { makeSlashActions } = require('../sidecar/slash-actions.js');

function job(over) {
  return Object.assign({
    id: 'j1', name: 'check build', prompt: 'check the build', scheduleDisplay: 'every 30m',
    enabled: true, nextRunAt: '2026-07-24T10:00:00.000Z', lastStatus: null, lastError: null
  }, over || {});
}

// a recorder-backed dep set; every call is logged so a test can prove the STORE was actually asked.
function deps(over) {
  const calls = [];
  const base = {
    now: () => 1000,
    cron: {
      jobs: () => [],
      armed: () => true,
      preview: (s) => ({ ok: true, display: 'every 30m', localNext: ['Fri, Jul 24, 10:00 AM EDT'] }),
      create: async (spec) => { calls.push(['create', spec]); return { ok: true, job: job({ name: spec.name }) }; },
      update: async (id, patch) => { calls.push(['update', id, patch]); return { ok: true, job: job({ enabled: patch.enabled }) }; },
      remove: async (id) => { calls.push(['remove', id]); return { ok: true }; }
    },
    workshop: {
      state: async () => ({ ok: true, backlog: [], granted: true, pending: 0 }),
      grant: async (a, on) => { calls.push(['grant', a, on]); return { ok: true }; },
      queue: async (a, text) => { calls.push(['queue', a, text]); return { ok: true, granted: true }; },
      shiftNow: async () => ({ ok: true, fired: true, built: 'a thing' })
    }
  };
  const d = Object.assign({}, base, over || {});
  if (over && over.cron) d.cron = Object.assign({}, base.cron, over.cron);
  if (over && over.workshop) d.workshop = Object.assign({}, base.workshop, over.workshop);
  d._calls = calls;
  return d;
}
const mk = (over) => { const d = deps(over); return { S: makeSlashActions(d), calls: d._calls }; };

(async () => {
  /* ---------------- /routine ---------------- */
  {
    const { S } = mk();
    const r = await S.run('routine', '');
    A.ok(r.ok, 'empty routine list is not an error');
    A.ok(/\/routine add/.test(r.text), 'empty list teaches the add syntax');
  }

  {
    // DISARMED SCHEDULER — the single most misleading state: routines exist and never fire.
    const { S } = mk({ cron: { armed: () => false, jobs: () => [job()] } });
    const r = await S.run('routine', 'list');
    A.ok(r.lines.some(l => /NOT armed/.test(l)), 'a disarmed scheduler is stated in the listing');
    A.ok(r.lines.some(l => /\/cron on/.test(l)), 'the listing names the command that fixes it');
  }

  {
    const { S } = mk({ cron: { jobs: () => [job(), job({ id: 'j2', name: 'paused one', enabled: false })] } });
    const r = await S.run('routine', 'list');
    A.eq(r.title, 'Routines (2)', 'listing counts the routines');
    A.ok(/^1\. check build/.test(r.lines[0]), 'listing numbers routines from 1');
    A.ok(/paused/.test(r.lines[1]), 'a paused routine reads as paused, not scheduled');
  }

  {
    // The pipe is REQUIRED: both halves contain spaces, so guessing the split would silently mis-schedule.
    const { S, calls } = mk();
    const r = await S.run('routine', 'add every 30m check the build');
    A.eq(r.ok, false, 'add without a pipe is refused');
    A.ok(/\|/.test(r.text), 'the refusal shows the pipe syntax');
    A.eq(calls.length, 0, 'a malformed add never reaches the store');
  }

  {
    const { S, calls } = mk();
    const r = await S.run('routine', 'add every 30m | check whether the build went green');
    A.ok(r.ok, 'a well-formed add succeeds');
    A.eq(calls[0][1].schedule, 'every 30m', 'the schedule half is passed through verbatim');
    A.eq(calls[0][1].prompt, 'check whether the build went green', 'the task half becomes the prompt');
    A.ok(/every 30m/.test(r.text), 'the confirmation states the cadence it actually stored');
  }

  {
    // TRUTHFUL TELEMETRY: created + disarmed must not read as "this will run".
    const { S } = mk({ cron: { armed: () => false } });
    const r = await S.run('routine', 'add every 30m | check the build');
    A.ok(r.ok, 'creating while disarmed still succeeds');
    A.ok(/NOT armed/.test(r.text), 'creating while disarmed says it will not fire');
  }

  {
    const { S } = mk({ cron: { create: async () => ({ ok: true, duplicate: true, job: job({ name: 'check build' }) }) } });
    const r = await S.run('routine', 'add every 30m | check build');
    A.ok(/already exists/.test(r.text), 'a mint-gate duplicate is reported as existing, not created');
    A.ok(!/created/i.test(r.text), 'a duplicate never claims a creation happened');
  }

  {
    const { S } = mk({ cron: { create: async () => ({ ok: false, declined: true }) } });
    const r = await S.run('routine', 'add every 30m | check build');
    A.eq(r.ok, false, 'a declined name is refused');
    A.ok(/deleted/.test(r.text), 'the refusal explains WHY (you deleted it before)');
  }

  {
    const bad = await mk({ cron: { preview: () => ({ ok: false, error: "couldn't read that schedule" }) } })
      .S.run('routine', 'preview haha');
    A.eq(bad.ok, false, 'an unparseable schedule is refused');
    A.ok(/couldn't read/.test(bad.text), 'the parser\'s own reason reaches the user');
    const good = await mk().S.run('routine', 'preview 0 9 * * *');
    A.ok(good.lines.length >= 1, 'a valid schedule previews its next fire times');
    A.ok(/10:00 AM/.test(good.lines[0]), 'the preview shows real local fire times');
  }

  {
    // position-addressing: "2" means the 2nd row of the SAME list the user just read.
    const { S, calls } = mk({ cron: { jobs: () => [job(), job({ id: 'j2' })] } });
    const r = await S.run('routine', 'pause 2');
    A.eq(calls[0][1], 'j2', 'a positional argument resolves to the right routine id');
    A.ok(/paused/.test(r.text), 'the pause is confirmed');
    const miss = await S.run('routine', 'pause 9');
    A.eq(miss.ok, false, 'an out-of-range position is refused');
    A.ok(/No routine 9/.test(miss.text), 'the refusal names what was not found');
  }

  {
    const { S, calls } = mk({ cron: { jobs: () => [job()] } });
    const r = await S.run('routine', 'rm 1');
    A.eq(calls[0][0], 'remove', 'rm reaches the store remove');
    A.ok(/Deleted/.test(r.text), 'deletion is confirmed');
  }

  {
    const { S } = mk({ cron: { remove: async () => ({ ok: false, error: 'the write failed' }), jobs: () => [job()] } });
    const r = await S.run('routine', 'rm 1');
    A.eq(r.ok, false, 'a failed delete is reported as a failure');
    A.ok(/Could not delete/.test(r.text), 'a failed write never reads as success');
  }

  {
    const { S } = mk();
    const r = await S.run('routine', 'frobnicate');
    A.eq(r.ok, false, 'an unknown verb is refused');
    A.ok(/list, add, preview/.test(r.text), 'the refusal lists the verbs that do exist');
  }

  {
    const { S } = mk();
    const r = await S.run('routine', 'run 1');
    A.eq(r.ok, false, 'run-now is honestly declined here');
    A.ok(/ROUTINES panel/.test(r.text), 'it names the surface that DOES have run-now');
  }

  /* ---------------- /away ---------------- */
  {
    const { S, calls } = mk();
    const r = await S.run('away', 'a dashboard for my build times', { agentId: 'scout' });
    A.eq(calls[0][0], 'queue', 'free text queues a build');
    A.eq(calls[0][1], 'scout', 'the queue targets the agent the stream is talking to');
    A.eq(calls[0][2], 'a dashboard for my build times', 'the build request is passed verbatim');
    A.ok(r.ok, 'queueing succeeds');
  }

  {
    // GRANT OFF: queued work that cannot be built must say so in the same breath.
    const { S } = mk({ workshop: { queue: async () => ({ ok: true, granted: false }) } });
    const r = await S.run('away', 'build me a thing');
    A.ok(/OFF/.test(r.text), 'queueing with the grant off says the grant is off');
    A.ok(/\/away on/.test(r.text), 'it names the command that turns it on');
  }

  {
    const { S, calls } = mk();
    await S.run('away', 'on', { agentId: 'scout' });
    A.eq(calls[0], ['grant', 'scout', true], '/away on grants');
    const { S: S2, calls: c2 } = mk();
    await S2.run('away', 'off', { agentId: 'scout' });
    A.eq(c2[0], ['grant', 'scout', false], '/away off revokes');
  }

  {
    // WORD-BOUNDARY: a reserved verb only counts as the WHOLE argument.
    const { S, calls } = mk();
    await S.run('away', 'on-call dashboard for the team');
    A.eq(calls[0][0], 'queue', '"on-call …" is a build request, not the on toggle');
    A.eq(calls[0][2], 'on-call dashboard for the team', 'the full text survives');
  }

  {
    const { S } = mk({
      workshop: {
        state: async () => ({ ok: true, granted: false, pending: 2, backlog: [{ title: 'a thing' }, { title: 'built thing', builtRunId: 'r1' }] })
      }
    });
    const r = await S.run('away', 'list');
    A.ok(/2 queued/.test(r.title), 'the listing counts the backlog');
    A.ok(/built — waiting in OUTBOX/.test(r.lines[1]), 'a finished build is marked as waiting');
    A.ok(r.lines.some(l => /waiting for your keep\/discard/.test(l)), 'pending builds are surfaced');
    A.ok(r.lines.some(l => /Build while away: OFF/.test(l)), 'the grant state is always stated');
  }

  {
    const { S } = mk({ workshop: { shiftNow: async () => ({ ok: true, fired: false, reason: 'empty-backlog' }) } });
    const r = await S.run('away', 'now');
    A.ok(/No away shift ran/.test(r.text), 'a shift that did not fire never claims it did');
    A.ok(/nothing queued to build/.test(r.text), 'a machine reason code is translated to something actionable');
    // 'no-capability' is what a keyless station returns — the most likely real-world case, and the least
    // legible raw. It must name the door that fixes it.
    const cap = await mk({ workshop: { shiftNow: async () => ({ ok: true, fired: false, reason: 'no-capability' }) } })
      .S.run('away', 'now');
    A.ok(/PROVIDERS/.test(cap.text), 'a missing credential names where to add one');
    // an UNKNOWN code is passed through verbatim rather than swallowed or guessed at
    const odd = await mk({ workshop: { shiftNow: async () => ({ ok: true, fired: false, reason: 'brand-new-code' }) } })
      .S.run('away', 'now');
    A.ok(/brand-new-code/.test(odd.text), 'an unrecognized reason code still reaches the user');
  }

  /* ---------------- contract ---------------- */
  {
    const { S } = mk();
    const r = await S.run('nope', '');
    A.eq(r.status, 404, 'an unknown action reports 404 so the caller can tell it never executed');
  }

  {
    // A dep that throws must degrade to an honest line, never a rejected promise (the HTTP caller would 500).
    const { S } = mk({ workshop: { state: async () => { throw new Error('disk gone'); } } });
    const r = await S.run('away', 'list');
    A.eq(r.ok, false, 'a throwing dep is reported as a failure');
    A.ok(/disk gone/.test(r.text), 'the real error text reaches the user');
  }

  {
    // an unwired subsystem must refuse, not pretend
    const S = makeSlashActions({});
    const r = await S.run('routine', 'list');
    A.eq(r.ok, false, 'routines with no cron dep refuse honestly');
    const w = await S.run('away', 'list');
    A.eq(w.ok, false, 'away with no workshop dep refuses honestly');
  }

  A.report('slash-actions.test');
})();
