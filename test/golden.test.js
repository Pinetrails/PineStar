/* node test/golden.test.js — golden.mjs's DISMISSED-FRAME gate (pure classifier), fed
   hand-built signatures + baseline + a suppressed-fingerprint Set. Zero disk, zero capture,
   zero sidecar (golden.mjs no longer boots anything on import — the pure classifier +
   fingerprint helpers are exported behind an INVOKED_DIRECTLY guard, like ledger/guardian).

   THE LAW UNDER TEST (task P0.1b): a frame whose CURRENT fingerprint is on the QA ledger's
   dismissed/known baseline is REVIEW-CLEAN (excused, gate stays green) — so the known-noisy
   `sys-rewind` frame can never pin the Green Guardian dashboard RED. But a genuinely NEW
   regression (new frame, different frame, or a diff on a NON-dismissed frame) must STILL flag
   and exit nonzero. This test proves BOTH: the narrow excuse path AND the untouched negative
   path. The excuse key is the ledger's own fingerprint (goldenFrameFingerprint == the Green
   Guardian's per-frame fingerprint), never an ad-hoc match. */
'use strict';
const A = require('./_assert.js');
const { classifyFrames, goldenFrameFingerprint } = require('../scripts/golden.mjs');
const { fingerprintOf } = require('../scripts/qa/ledger.mjs');

// Build a signature array of a constant byte value, length SIG_W*SIG_H (64*40) so sigDiff is
// well-defined. Two constant sigs differ by |a-b| (mean-abs-diff), so we can dial the diff.
const SIG_LEN = 64 * 40;
const sig = (v) => Array.from({ length: SIG_LEN }, () => v);

// ---- A. the frame fingerprint IS the ledger's Green-Guardian golden fingerprint (one key) ----
{
  const fp = goldenFrameFingerprint('sys-rewind');
  A.eq(fp, fingerprintOf({ crew: 'Green Guardian', checkId: 'golden', subject: 'frame/sys-rewind' }),
    'goldenFrameFingerprint == the ledger fingerprint the Guardian derives for that frame (one dedup key)');
  A.eq(fp, '01c40465', 'sys-rewind maps to the real dismissed finding fingerprint 01c40465 (the actual ledger id)');
}

// ---- B. POSITIVE PATH: a changed frame whose fingerprint IS suppressed → excused, NOT flagged ----
{
  const golden = { states: { 'sys-rewind': sig(0), 'ingame': sig(0) } };
  const sigs = { 'sys-rewind': sig(10), 'ingame': sig(0) };       // sys-rewind diffs by 10 (>thr), ingame clean
  const suppressed = new Set([goldenFrameFingerprint('sys-rewind')]);   // dismissed baseline
  const { flagged, excused } = classifyFrames({ sigs, golden, thr: 1.5, suppressed });
  A.eq(flagged.length, 0, 'a dismissed-fingerprint frame that diffed is NOT flagged (gate stays green)');
  A.eq(excused.length, 1, 'it is recorded as excused (never a silent pass)');
  A.eq(excused[0].name, 'sys-rewind', 'the excused frame is named');
  A.ok(/01c40465/.test(excused[0].reason), 'the excuse reason cites the matching dismissed fingerprint');
}

// ---- C. NEGATIVE PATH #1: same frame, diff, but fingerprint NOT suppressed → STILL flagged ----
{
  const golden = { states: { 'sys-rewind': sig(0) } };
  const sigs = { 'sys-rewind': sig(10) };
  const { flagged, excused } = classifyFrames({ sigs, golden, thr: 1.5, suppressed: new Set() });  // nothing dismissed
  A.eq(flagged.length, 1, 'with NO dismissed baseline, a real diff still flags (regression survives)');
  A.eq(excused.length, 0, 'nothing excused when the fingerprint is not on the baseline');
  A.eq(flagged[0].name, 'sys-rewind', 'the flagged frame is named');
}

// ---- D. NEGATIVE PATH #2: a DIFFERENT frame diffs — a suppressed sys-rewind does NOT excuse it ----
{
  const golden = { states: { 'sys-rewind': sig(0), 'crew-roster': sig(0) } };
  const sigs = { 'sys-rewind': sig(10), 'crew-roster': sig(10) };   // BOTH diff
  const suppressed = new Set([goldenFrameFingerprint('sys-rewind')]); // only sys-rewind is dismissed
  const { flagged, excused } = classifyFrames({ sigs, golden, thr: 1.5, suppressed });
  A.eq(flagged.length, 1, 'the NON-dismissed frame still flags (excuse is per-frame, not global)');
  A.eq(flagged[0].name, 'crew-roster', 'the flagged frame is the un-dismissed one');
  A.eq(excused.length, 1, 'only sys-rewind is excused');
  A.eq(excused[0].name, 'sys-rewind', 'sys-rewind excused, crew-roster flagged');
}

// ---- E. NEGATIVE PATH #3: a brand-NEW frame (no baseline) flags even if some OTHER fp is dismissed ----
{
  const golden = { states: {} };                                   // no baseline at all
  const sigs = { 'brand-new-panel': sig(5) };
  const suppressed = new Set([goldenFrameFingerprint('sys-rewind')]); // sys-rewind dismissed, unrelated
  const { flagged, excused } = classifyFrames({ sigs, golden, thr: 1.5, suppressed });
  A.eq(flagged.length, 1, 'a new frame (new subject → new fingerprint) is NOT excused by an unrelated dismissal');
  A.eq(excused.length, 0, 'nothing excused');
  A.ok(/new state/.test(flagged[0].reason), 'the new frame is flagged as a new state');
}

// ---- F. NEGATIVE PATH #4: a frame in the baseline but MISSING this run → flagged (never excused) ----
{
  const golden = { states: { 'sys-rewind': sig(0), 'gone': sig(0) } };
  const sigs = { 'sys-rewind': sig(0) };                            // 'gone' absent this run
  const suppressed = new Set([goldenFrameFingerprint('sys-rewind'), goldenFrameFingerprint('gone')]);
  const { flagged } = classifyFrames({ sigs, golden, thr: 1.5, suppressed });
  A.eq(flagged.length, 1, 'a missing frame flags even if its fingerprint is dismissed (no live signature to trust)');
  A.eq(flagged[0].name, 'gone', 'the missing frame is named');
  A.ok(/missing this run/.test(flagged[0].reason), 'flagged as missing this run');
}

// ---- G. a clean run (no diffs) → nothing flagged, nothing excused ----
{
  const golden = { states: { 'sys-rewind': sig(0), 'ingame': sig(0) } };
  const sigs = { 'sys-rewind': sig(0), 'ingame': sig(0) };
  const { flagged, excused } = classifyFrames({ sigs, golden, thr: 1.5, suppressed: new Set() });
  A.eq(flagged.length, 0, 'no diffs → nothing flagged');
  A.eq(excused.length, 0, 'no diffs → nothing excused');
}

A.report('golden.test');
