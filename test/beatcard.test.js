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
ctl.reset();
const fresh = ctl.claim({ kind: 'study', runId: 'run-fresh', node: { id: 'study-fresh', isConnected: true } });
A.ok(fresh, 'a fresh COMMS generation may claim the slot');
A.eq(oldThread.isCurrent(), false, 'the old async handle is stale after reset');
A.eq(oldThread.finish({ delay: 0 }), false, 'a stale async completion cannot schedule cleanup');
clock.tick(100);
A.eq(ctl.visibleBeat(), 'study', 'the stale completion cannot release or replace the fresh card');
A.eq(vanished.indexOf('study-fresh'), -1, 'the fresh card was not touched by stale cleanup');

A.report('beatcard.test');
