/* node test/worker-iteration-cap.test.js — source-lock for the DELEGATED-WORKER iteration ceiling.

   The bug this locks: orchestration.js has always computed `workerMaxIters` and passed it to runOnce as
   `maxIters:`, but runOnce NEVER READ `o.maxIters` — the only assignment was a hardcoded
   `limits: { maxIters: CAPS.maxIters }`. The host also never supplied `workerMaxIters`, so the dep fell to
   its literal default and was then discarded anyway. Net effect: every delegated worker ran the LEAD's full
   turn budget instead of its own smaller one. The per-worker USD cap (o.maxCostUsd) was honored the whole
   time, so spend stayed bounded and nothing looked wrong.

   Why the existing coverage missed it: test/orchestration.test.js asserts `ro.calls[0].maxIters` against a
   FAKE runOnce. That proves the PRODUCER passes the value and is a correct test of orchestration.js — but it
   is structurally incapable of noticing that the real CONSUMER ignores it. Producer and consumer each passed
   alone; the seam between them was untested. (Same shape as the servicekeys/environment/shell seam:
   "when two modules each pass alone, test the COMPOSITION".)

   sidecar/index.js boots a server on require, so — following test/harness-internal.test.js, which locks a
   sidecar invariant the same way — this is a SOURCE-LOCK, not a behavioural proof. It asserts the wire is
   connected at both ends and that the clamp is one-directional. The producer half stays behaviourally
   covered by test/orchestration.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const sidecar = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
const orch = fs.readFileSync(path.join(__dirname, '../sidecar/tools/builtin/orchestration.js'), 'utf8');

// --- PRODUCER half: orchestration.js still computes and sends a per-worker ceiling ---
A.ok(/workerMaxIters/.test(orch), 'orchestration.js still computes a per-worker iteration ceiling');
A.ok(/maxIters:\s*workerMaxIters/.test(orch), 'orchestration.js passes it to runOnce as maxIters');

// --- HOST half 1: the station actually SUPPLIES workerMaxIters (it previously never did) ---
A.ok(/const\s+ORCH_WORKER_MAX_ITERS\s*=/.test(sidecar),
  'index.js defines a per-worker iteration knob');
A.ok(/workerMaxIters:\s*ORCH_WORKER_MAX_ITERS/.test(sidecar),
  'index.js passes workerMaxIters into makeOrchestrationTools (the dep was previously never supplied)');

// --- HOST half 2: runOnce CONSUMES o.maxIters, and only ever downward ---
A.ok(/const\s+runMaxIters\s*=/.test(sidecar), 'runOnce computes a per-run iteration ceiling');
A.ok(/o\.maxIters/.test(sidecar), 'runOnce reads the caller-supplied o.maxIters (it previously never did)');
A.ok(/runMaxIters[\s\S]{0,240}Math\.min\([\s\S]{0,80}CAPS\.maxIters\)/.test(sidecar),
  'the caller cap is clamped by Math.min against CAPS.maxIters — a caller may LOWER but never RAISE the ceiling');

// --- HOST half 3: the limits object uses the computed value, not the raw station cap ---
A.ok(/limits:\s*\{\s*maxIters:\s*runMaxIters/.test(sidecar),
  'the loop limits use runMaxIters');
A.ok(!/limits:\s*\{\s*maxIters:\s*CAPS\.maxIters\s*,/.test(sidecar),
  'the old hardcoded limits.maxIters = CAPS.maxIters assignment is gone (that line WAS the bug)');

// --- the default path is unchanged: an ordinary run supplies no o.maxIters and still gets CAPS.maxIters ---
A.ok(/:\s*CAPS\.maxIters\s*;/.test(sidecar),
  'runMaxIters falls back to CAPS.maxIters, so a normal (non-delegated) run is byte-identical to before');

A.report('worker-iteration-cap.test');
