/* test/_assert.js — zero-dep assertion helpers + a fake U.bus, matching the
   err()-counter + process.exit(fail?1:0) convention used by the v7 headless tests.
   Each test file: run assertions, then call report() last. */
'use strict';

let fail = 0, pass = 0;
const err = m => { fail++; console.log('FAIL: ' + m); };

// Safety net: an async test that throws BEFORE reaching report() must FAIL the run, not pass silently.
// Several async suites use a bare `(async () => { ... })()` with no .catch(); this guarantees an
// unhandled rejection aborts non-zero regardless of the Node --unhandled-rejections flag.
process.on('unhandledRejection', e => { console.log('FAIL: unhandledRejection — ' + ((e && e.stack) || e)); process.exit(1); });

function ok(cond, msg) { if (cond) pass++; else err(msg || 'expected truthy value'); }

function eq(actual, expected, msg) {
  const A = JSON.stringify(actual), B = JSON.stringify(expected);
  if (A === B) pass++; else err((msg || 'eq') + ' — expected ' + B + ', got ' + A);
}

function throws(fn, msg) {
  try { fn(); err((msg || 'throws') + ' — did not throw'); }
  catch (e) { pass++; }
}

function notThrows(fn, msg) {
  try { fn(); pass++; }
  catch (e) { err((msg || 'notThrows') + ' — threw: ' + (e && e.message)); }
}

/* a fake bus mirroring frontend/js/util.js U.bus: handler throws are swallowed. */
function makeBus() {
  const h = {};
  return {
    _h: h,
    on(ev, fn) { (h[ev] = h[ev] || []).push(fn); },
    emit(ev, data) { (h[ev] || []).forEach(fn => { try { fn(data); } catch (e) { /* swallowed, as in U.bus */ } }); }
  };
}

/* subscribe to the given event names; returns an array filled in emit order. */
function collectBus(bus, names) {
  const log = [];
  for (const n of names) bus.on(n, payload => log.push({ name: n, payload }));
  return log;
}

function report(title) {
  console.log((title || 'tests') + ': ' + (fail ? (fail + ' problem(s), ' + pass + ' ok') : ('OK (' + pass + ' assertions)')));
  process.exit(fail ? 1 : 0);
}

module.exports = { ok, eq, throws, notThrows, makeBus, collectBus, report, fails: () => fail };
