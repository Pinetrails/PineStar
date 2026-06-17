/* node test/memcore.test.js — Cortex M-mem.6 Memory Core: the PURE stats reducer + record ops.
   Proves the per-record stats are a REDUCTION over the memory.* event log (never invented): memory.used
   bumps useCount + stamps lastUsedAt from the injected clock; memory.feedback folds a signed delta into a
   clamped [0,1] trust. pin/edit/forget are pure, non-mutating array transforms; edit preserves provenance
   and mirrors content into body for the legacy readers; projectRecord surfaces the full §5.2 shape. */
'use strict';
const A = require('./_assert.js');
const { nextTrust, nextNoteId, reduceStats, applyPin, applyEdit, applyForget, projectRecord, TRUST_STEP, clamp01 } = require('../sidecar/memcore.js');

const base = () => [
  { id: 'note_1', kind: 'note', title: 'API base', body: 'openrouter.ai/api/v1', useCount: 0, trust: 0, lastUsedAt: null, createdAt: 1000, ts: 1000, sourceRunId: 'run_a', pinned: false },
  { id: 'note_2', kind: 'fact', title: 'Fact', body: 'deploys with npm publish', content: 'deploys with npm publish', useCount: 0, trust: 0, lastUsedAt: null, createdAt: 1000, sourceRunId: 'run_b', pinned: false }
];

// ---- clamp + trust math ----
A.eq(clamp01(-1), 0, 'clamp01 floors at 0');
A.eq(clamp01(2), 1, 'clamp01 ceils at 1');
A.eq(clamp01(0.5), 0.5, 'clamp01 passes through mid-range');
A.ok(Math.abs(nextTrust(0, 2) - 0.30) < 1e-9, 'keep (+2) seeds trust 0.30 from 0');
A.ok(Math.abs(nextTrust(0, 1) - 0.15) < 1e-9, 'edit (+1) seeds trust 0.15 from 0');
A.ok(nextTrust(0, -1) === 0, 'a negative delta from 0 stays clamped at 0');
A.ok(Math.abs(nextTrust(0.5, -1) - 0.35) < 1e-9, 'discard (-1) lowers trust by one step');
A.eq(nextTrust(0.95, 2), 1, 'positive feedback clamps at 1');
A.eq(nextTrust('bad', 2), 0.30, 'a corrupt prior is treated as 0');
A.eq(nextTrust(0.5, NaN), 0.5, 'a non-finite delta is a no-op');

// ---- reduceStats: memory.used -> useCount + lastUsedAt (pure) ----
const recs = base();
const r1 = reduceStats(recs, { name: 'memory.used', payload: { id: 'note_1' } }, { now: 2000 });
A.eq(r1[0].useCount, 1, 'memory.used bumps useCount');
A.eq(r1[0].lastUsedAt, 2000, 'lastUsedAt stamped from the injected clock');
A.eq(recs[0].useCount, 0, 'input array/record NOT mutated (pure)');
A.ok(r1[1] === recs[1], 'untouched records pass through by reference');
const r1b = reduceStats(r1, { name: 'memory.used', payload: { id: 'note_1' } }, { now: 3000 });
A.eq(r1b[0].useCount, 2, 'a second use increments again');
A.eq(r1b[0].lastUsedAt, 3000, 'lastUsedAt advances to the newer use');

// ---- reduceStats: memory.feedback -> trust (clamped, signed) ----
const fb1 = reduceStats(base(), { name: 'memory.feedback', payload: { id: 'note_2', delta: 2 } }, { now: 0 });
A.ok(Math.abs(fb1[1].trust - 0.30) < 1e-9, 'positive feedback raises trust');
const fb2 = reduceStats(fb1, { name: 'memory.feedback', payload: { id: 'note_2', delta: -1 } }, { now: 0 });
A.ok(fb2[1].trust < fb1[1].trust, 'negative feedback lowers trust');

// ---- reduceStats: safe no-ops + determinism ----
A.ok(reduceStats(base(), { name: 'memory.used', payload: { id: 'nope' } }, { now: 1 }) instanceof Array, 'unknown id returns an array');
A.ok(reduceStats(base(), { name: 'memory.used', payload: { id: 'nope' } }, { now: 1 })[0].useCount === 0, 'unknown id no-ops (no bump)');
A.ok(reduceStats(base(), { name: 'agent.run.end', payload: { id: 'note_1' } }, { now: 1 })[0].useCount === 0, 'a non-memory event is ignored');
A.eq(reduceStats([], { name: 'memory.used', payload: { id: 'x' } }, { now: 0 }).length, 0, 'empty store -> empty out');
A.ok(reduceStats(recs, { name: 'memory.used', payload: { id: 'nope' } }, { now: 9 }) === recs, 'no-op returns the SAME array ref (host can skip the write)');
A.eq(JSON.stringify(reduceStats(base(), { name: 'memory.used', payload: { id: 'note_1' } }, { now: 5 })),
     JSON.stringify(reduceStats(base(), { name: 'memory.used', payload: { id: 'note_1' } }, { now: 5 })), 'deterministic for the same inputs');

// ---- applyPin (pure, found/not-found) ----
const pinned = applyPin(base(), 'note_1', true);
A.eq(pinned.found, true, 'pin finds the record');
A.eq(pinned.records[0].pinned, true, 'pin sets pinned');
A.eq(base()[0].pinned, false, 'pin does not mutate the input');
A.eq(applyPin(base(), 'ghost', true).found, false, 'pin reports not-found for a missing id');
A.eq(applyPin(base(), 'note_1', false).records[0].pinned, false, 'unpin clears the flag');

// ---- applyEdit (mirrors into content+body, preserves provenance) ----
const edited = applyEdit(base(), 'note_2', '  refreshed belief  ');   // host trims+redacts; here verify the write
A.eq(edited.found, true, 'edit finds the record');
A.eq(edited.records[1].content, '  refreshed belief  ', 'content replaced (host pre-trims)');
A.eq(edited.records[1].body, '  refreshed belief  ', 'body mirrors content for legacy/recall readers');
A.eq(edited.records[1].sourceRunId, 'run_b', 'provenance (sourceRunId) preserved across an edit');
A.eq(edited.records[1].createdAt, 1000, 'createdAt preserved across an edit');
A.eq(base()[1].content, 'deploys with npm publish', 'edit does not mutate the input');
A.eq(applyEdit(base(), 'ghost', 'x').found, false, 'edit reports not-found for a missing id');

// ---- applyForget (removes, found/not-found, pure) ----
const forgot = applyForget(base(), 'note_1');
A.eq(forgot.found, true, 'forget finds the record');
A.eq(forgot.records.length, 1, 'forget removes exactly one record');
A.eq(forgot.records[0].id, 'note_2', 'the other record survives');
A.eq(base().length, 2, 'forget does not mutate the input');
A.eq(applyForget(base(), 'ghost').found, false, 'forgetting a missing id is a safe no-op (found=false)');

// ---- projectRecord: the full §5.2 view (typed record uses content; note uses body) ----
const pv = projectRecord(base()[1]);
A.eq(pv.kind, 'fact', 'projection carries kind');
A.eq(pv.body, 'deploys with npm publish', 'typed record projects content into body');
A.eq(pv.sourceRunId, 'run_b', 'projection exposes provenance');
A.eq(pv.useCount, 0, 'projection exposes useCount');
A.eq(pv.trust, 0, 'projection exposes trust (clamped)');
A.eq(pv.pinned, false, 'projection exposes pinned');
A.eq(projectRecord(base()[0]).body, 'openrouter.ai/api/v1', 'a note projects its body');
A.eq(projectRecord({ id: 'x', trust: 5 }).trust, 1, 'projection clamps a corrupt trust into [0,1]');
A.eq(projectRecord({ id: 'x' }).createdAt, 0, 'projection tolerates a sparse record');

// ---- nextNoteId: collision-proof (one past the MAX existing N, never positional length) ----
A.eq(nextNoteId([]), 'note_1', 'first id on an empty store');
A.eq(nextNoteId([{ id: 'note_1' }, { id: 'note_2' }, { id: 'note_3' }]), 'note_4', 'grows past the max');
A.eq(nextNoteId([{ id: 'note_1' }, { id: 'note_3' }]), 'note_4', 'after a forget (gap) the next id is max+1, NOT the colliding length+1 (note_3)');
A.eq(nextNoteId([{ id: 'note_5' }]), 'note_6', 'one record at note_5 -> note_6, not note_2');
A.eq(nextNoteId([{ id: 'note_2' }, { id: 'weird' }, null]), 'note_3', 'ignores non-note ids and garbage');

// ---- hardening: a pre-existing duplicate id can never multi-mutate (first match only) ----
const dup = () => [{ id: 'note_3', useCount: 0, trust: 0, pinned: false }, { id: 'note_3', useCount: 0, trust: 0, pinned: false }];
const usedDup = reduceStats(dup(), { name: 'memory.used', payload: { id: 'note_3' } }, { now: 7 });
A.eq(usedDup[0].useCount, 1, 'memory.used bumps only the FIRST of a duplicate pair');
A.eq(usedDup[1].useCount, 0, 'the second duplicate is left untouched');
A.eq(applyForget(dup(), 'note_3').records.length, 1, 'forget removes only ONE of a duplicate pair (never both)');
A.eq(applyPin(dup(), 'note_3', true).records.filter(r => r.pinned).length, 1, 'pin sets only the first of a duplicate pair');
A.eq(applyEdit(dup(), 'note_3', 'x').records.filter(r => r.content === 'x').length, 1, 'edit changes only the first of a duplicate pair');

A.report('memcore.test');
