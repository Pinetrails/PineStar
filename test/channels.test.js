/* node test/channels.test.js — per-workstream COMMS run-state (frontend/app/channels.js).
   Locks THE GATE: the state model that lets two workstreams run concurrently and survive a
   selection switch. The old chat.js kept ONE global busy/runId/stream and wiped the DOM on
   switch; this proves the replacement keeps run-state isolated per workstream so:
     - two streams can be busy AT ONCE (the central multi-agent claim),
     - each owns its own runId / in-flight text / tool lines / pending approval,
     - ending or clearing one never touches the other,
     - a snapshot is a copy (chat.js re-renders from it without mutating live state),
     - the compose target is independent of selection (war-room D2). */
'use strict';
const A = require('./_assert.js');
const C = require('../frontend/app/channels.js');

C.reset();

/* ---------- lazy get/create + peek does not create ---------- */
A.eq(C.peek('a'), null, 'peek does not create a channel');
const ca = C.get('a');
A.ok(ca && ca.wsId === 'a', 'get creates+returns the channel');
A.ok(C.get('a') === ca, 'get is idempotent (same object)');
A.eq(C.get(null), null, 'get(null) is null (no channel for no workstream)');

/* ---------- begin marks busy + thinking; clears stale state ---------- */
C.reset();
C.appendToken('a', 'stale'); C.addTool('a', 'old');     // pre-existing crud
C.begin('a');
A.ok(C.isBusy('a'), 'begin marks the stream busy');
A.eq(C.statusOf('a'), 'thinking…', 'begin sets status thinking');
A.eq(C.snapshot('a').acc, '', 'begin clears stale acc');
A.eq(C.snapshot('a').tools, [], 'begin clears stale tool lines');

/* ---------- THE CORE: two workstreams busy AT THE SAME TIME, fully isolated ---------- */
C.reset();
C.begin('a'); C.begin('b');
A.ok(C.isBusy('a') && C.isBusy('b'), 'TWO streams busy at once (the multi-agent gate)');
A.eq(C.busyCount(), 2, 'busyCount sees both');
A.eq(C.busyIds().sort(), ['a', 'b'], 'busyIds lists both');

C.setRunId('a', 'run-A'); C.setRunId('b', 'run-B');
C.appendToken('a', 'alpha '); C.appendToken('a', 'one');
C.appendToken('b', 'beta');
C.addTool('a', '▶ web.search', false);
C.addTool('b', '◁ fs.write', true);
C.setPending('b', { promptId: 'p1', tool: 'fs.write', argsSummary: 'plan.md', runId: 'run-B' });

A.eq(C.runIdOf('a'), 'run-A', 'a keeps its own runId');
A.eq(C.runIdOf('b'), 'run-B', 'b keeps its own runId');
A.eq(C.snapshot('a').acc, 'alpha one', 'a accumulates its own tokens');
A.eq(C.snapshot('b').acc, 'beta', 'b accumulates its own tokens (no cross-contamination)');
A.eq(C.snapshot('a').tools.length, 1, 'a has its own tool line');
A.eq(C.snapshot('b').tools[0].isErr, true, 'b tool line keeps its error flag');
A.eq(C.pendingOf('a'), null, 'a has no pending approval');
A.eq(C.pendingOf('b').promptId, 'p1', 'b holds its own live consent');
A.eq(C.pendingIds(), ['b'], 'pendingIds finds only the blocked stream');
A.eq(C.statusOf('b'), 'awaiting your approval…', 'a pending approval drives b\'s status');

/* ---------- ending/clearing ONE does not disturb the other ---------- */
C.end('a');
A.ok(!C.isBusy('a'), 'end clears a');
A.ok(C.isBusy('b'), 'b is STILL busy after a ends (isolation)');
A.eq(C.snapshot('a').acc, '', 'end drops a\'s transient text');
A.eq(C.busyCount(), 1, 'only b remains busy');

C.clearPending('b');
A.eq(C.pendingOf('b'), null, 'clearPending drops b\'s consent');
A.eq(C.statusOf('b'), 'working…', 'b stays "working" after a consent clears mid-run');
A.eq(C.runIdOf('b'), 'run-B', 'clearPending leaves the run itself intact');

/* ---------- snapshot is a COPY (chat.js re-render must not mutate live state) ---------- */
C.reset();
C.begin('a'); C.appendToken('a', 'live'); C.addTool('a', 't');
const snap = C.snapshot('a');
snap.acc = 'TAMPERED'; snap.tools.push({ text: 'x', isErr: false }); snap.busy = false;
A.eq(C.snapshot('a').acc, 'live', 'snapshot.acc is a copy (tamper did not leak)');
A.eq(C.snapshot('a').tools.length, 1, 'snapshot.tools is a copy');
A.ok(C.isBusy('a'), 'snapshot.busy is a copy');

/* ---------- compose target is independent of selection (war-room D2) ---------- */
C.reset();
A.eq(C.composeTarget(), null, 'no compose target initially');
C.setComposeTarget('a');
A.eq(C.composeTarget(), 'a', 'compose target settable');
C.begin('b');                                  // a run starts on a DIFFERENT stream
A.eq(C.composeTarget(), 'a', 'starting a run elsewhere does NOT move the compose target');

/* ---------- drop + reset ---------- */
C.drop('b');
A.ok(!C.has('b'), 'drop removes a channel');
C.setComposeTarget('z'); C.begin('z'); C.reset();
A.eq(C.busyCount(), 0, 'reset clears all channels');
A.eq(C.composeTarget(), null, 'reset clears the compose target');

A.report('channels');
