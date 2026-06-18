/* node test/curiosity.test.js — the pure just-in-time curiosity engine (frontend/app/curiosity.js).
   Locks the anti-nag promises: pick() asks about the first still-blank, not-dismissed dimension in
   canonical order; respects the per-session cap; stays silent when everything is known or dismissed; and
   hydrate() rebuilds the persisted dismissals defensively. Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const C = require('../frontend/app/curiosity.js');

/* ---------- pick: first blank, not-dismissed, canonical order ---------- */
A.eq(C.pick({ blank: ['identity', 'stack'], dismissed: {}, count: 0, cap: 1 }), 'identity', 'asks the first blank dimension');
A.eq(C.pick({ blank: ['stack', 'goals'], dismissed: {}, count: 0, cap: 1 }), 'stack', 'order follows the blank list');
A.eq(C.pick({ blank: ['identity', 'stack'], dismissed: { identity: true }, count: 0, cap: 1 }), 'stack', 'skips a dismissed dimension');

/* ---------- silence cases ---------- */
A.eq(C.pick({ blank: [], dismissed: {}, count: 0, cap: 1 }), null, 'stays quiet when nothing is blank (all known)');
A.eq(C.pick({ blank: ['identity'], dismissed: { identity: true }, count: 0, cap: 1 }), null, 'stays quiet when the only blank is dismissed');
A.eq(C.pick({ blank: ['identity'], dismissed: {}, count: 1, cap: 1 }), null, 'stays quiet once the session cap is reached');
A.eq(C.pick({ blank: ['identity'], dismissed: {}, count: 5, cap: 1 }), null, 'stays quiet past the cap');

/* ---------- cap is honored / configurable ---------- */
A.eq(C.pick({ blank: ['identity'], dismissed: {}, count: 0, cap: 2 }), 'identity', 'asks while under a higher cap');
A.eq(C.pick({ blank: ['identity'], dismissed: {}, count: 0 }), 'identity', 'defaults to the built-in cap when unspecified');
A.eq(C.CAP, 1, 'the default cap is one nudge per session (anti-nag)');

/* ---------- defensive inputs ---------- */
A.eq(C.pick({}), null, 'no options → quiet, never throws');
A.eq(C.pick({ blank: null, dismissed: null }), null, 'malformed inputs → quiet, never throws');

/* ---------- fresh + hydrate ---------- */
A.eq(C.fresh(), { v: 1, dismissed: {} }, 'fresh() is an empty dismissal set');
A.eq(C.hydrate(null).dismissed, {}, 'hydrate(null) → empty');
A.eq(C.hydrate('garbage').dismissed, {}, 'hydrate of garbage → empty');
A.eq(C.hydrate({ dismissed: { stack: true, x: false } }).dismissed, { stack: true }, 'hydrate keeps only truthy dismissals');
// a hydrated dismissal actually suppresses the nudge
const st = C.hydrate({ dismissed: { identity: true } });
A.eq(C.pick({ blank: ['identity', 'stack'], dismissed: st.dismissed, count: 0, cap: 1 }), 'stack', 'a hydrated dismissal is honored by pick');

A.report('curiosity.test');
