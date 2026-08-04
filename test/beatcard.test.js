/* node test/beatcard.test.js — pure COMMS beat lifecycle with a fake clock. */
'use strict';
const A = require('./_assert.js');
const BeatCard = require('../frontend/app/beatcard.js');

function fakeClock() {
  let now = 0, next = 1;
  const jobs = new Map();
  return {
    setTimeout(fn, ms) { const id = next++; jobs.set(id, { at: now + Number(ms || 0), fn }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let pick = null;
        for (const [id, job] of jobs) if (job.at <= end && (!pick || job.at < pick.job.at || (job.at === pick.job.at && id < pick.id))) pick = { id, job };
        if (!pick) break;
        jobs.delete(pick.id); now = pick.job.at; pick.job.fn();
      }
      now = end;
    }
  };
}

const clock = fakeClock();
const vanished = [];
const ctl = BeatCard.create({
  timers: clock,
  vanish(node, done) { vanished.push(node && node.id); if (node) node.isConnected = false; if (done) done(); }
});

const study = ctl.claim({ kind: 'study', runId: 'run-1', node: { id: 'study-1', isConnected: true } });
A.ok(study, 'the first offer claims the shared slot');
A.eq(ctl.claim({ kind: 'trust', runId: 'run-1' }), null, 'a simultaneous lower-priority offer cannot stack');
A.eq(ctl.visibleBeat(), 'study', 'exactly one beat is visible');

let ignored = 0;
study.ifCurrent(rec => { rec.onExpire = () => { ignored += 1; }; });
ctl.scheduleExpire('study', 25);
clock.tick(24);
A.eq(ctl.busy(), true, 'the card remains live before its expiry');
clock.tick(1);
A.eq(ignored, 1, 'expiry invokes the feature ignore hook once');
A.eq(vanished[0], 'study-1', 'expiry retires the visible node through the injected vanish path');
A.eq(ctl.visibleBeat(), null, 'expiry releases the shared slot');

const trust = ctl.claim({ kind: 'trust', runId: 'run-2', node: { id: 'trust-2', isConnected: true } });
A.eq(trust.decide(), true, 'the first decision owns the card');
A.eq(trust.decide(), false, 'a second decision is rejected');
A.eq(ctl.expire('trust'), false, 'a decided card cannot be miscounted as ignored');
A.eq(trust.finish({ delay: 40 }), true, 'the decided card arms its vanish');
clock.tick(39);
A.eq(ctl.busy('trust'), true, 'the verdict remains visible during its flash');
clock.tick(1);
A.eq(vanished[1], 'trust-2', 'the decided card vanishes after the verdict flash');
A.eq(ctl.busy(), false, 'decision cleanup releases the active card');

A.eq(ctl.once('study', 'run-3'), true, 'a run is admitted once for its feature');
A.eq(ctl.once('study', 'run-3'), false, 'the same run cannot re-offer that feature');
A.eq(ctl.once('thread', 'run-3'), true, 'the same run may independently feed another feature family');

ctl.reserve('memory', 'run-memory');
A.eq(ctl.canOffer('study'), 'memory', 'an in-flight memory proposal blocks a lower-priority offer');
ctl.releaseReservation('memory', 'run-memory');
A.eq(ctl.canOffer('study'), 'free', 'an empty memory fetch releases the reservation');

const oldThread = ctl.claim({ kind: 'thread', runId: 'run-old', node: { id: 'thread-old', isConnected: true } });
A.eq(oldThread.decide(), true, 'the old async action starts while its card is current');
let staleFinish = null;
clock.setTimeout(() => { staleFinish = oldThread.finish({ delay: 0 }); }, 10);   // stand-in for a late fetch completion
ctl.reset();
const fresh = ctl.claim({ kind: 'study', runId: 'run-fresh', node: { id: 'study-fresh', isConnected: true } });
A.ok(fresh, 'a fresh COMMS generation may claim the slot');
A.eq(oldThread.isCurrent(), false, 'the old async handle is stale after reset');
clock.tick(100);
A.eq(staleFinish, false, 'a stale async completion cannot schedule cleanup');
A.eq(ctl.visibleBeat(), 'study', 'the stale completion cannot release or replace the fresh card');
A.eq(vanished.indexOf('study-fresh'), -1, 'the fresh card was not touched by stale cleanup');

/* THE STARVE FIX (recommendation spine S2): a sweep armed for one kind must free the slot from whatever
   UNDECIDED card is holding it — the old kind-matched sweep let an unanswered nudge starve every offer. */
ctl.reset();
const stuck = ctl.claim({ kind: 'nudge', runId: 'run-stuck', node: { id: 'nudge-stuck', isConnected: true } });
let nudgeIgnored = 0;
stuck.ifCurrent(rec => { rec.onExpire = () => { nudgeIgnored += 1; }; });
A.eq(ctl.visibleBeat(), 'nudge', 'the gentle aside holds the one slot');
ctl.scheduleExpire('study', 20);            // a NEW task end sweeps the previous moment
clock.tick(20);
A.eq(nudgeIgnored, 1, 'the mismatched holder fires its OWN ignore hook, not the sweeper kind\'s');
A.eq(ctl.visibleBeat(), null, 'a cross-kind sweep frees the slot instead of starving the queue');
A.ok(ctl.claim({ kind: 'study', runId: 'run-after', node: { id: 'study-after', isConnected: true } }),
  'the higher-value offer can now take the freed moment');

// a DECIDED card is still immune — a verdict is never miscounted as an ignore.
ctl.reset();
const answered = ctl.claim({ kind: 'nudge', runId: 'run-answered', node: { id: 'nudge-answered', isConnected: true } });
let answeredIgnored = 0;
answered.ifCurrent(rec => { rec.onExpire = () => { answeredIgnored += 1; }; });
A.eq(answered.decide(), true, 'the Commander answered the aside');
ctl.scheduleExpire('thread', 20);
clock.tick(20);
A.eq(answeredIgnored, 0, 'a decided card is never swept as ignored');
A.eq(ctl.sweepExpire(), false, 'a direct sweep also refuses a decided card');

A.report('beatcard.test');
