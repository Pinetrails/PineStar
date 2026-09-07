'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Prepared = require('./prepared-auditor-v2-experiment.js');
const Worker = require('./auditor-v2-durable-worker.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pine-star-auditor-v2-'));
const workspace = path.join(root, 'workspace');
for (const task of Prepared.PLAN.tasks) {
  const target = path.join(workspace, task.immutableSnapshotRef); fs.mkdirSync(path.dirname(target), { recursive: true });
  // Initialization must reject synthetic bytes because production hashes are immutable.
  fs.writeFileSync(target, '[]');
}
assert.throws(() => Worker.initialize(path.join(root, 'bad'), workspace), /snapshot hash mismatch/);
(async () => {
  const receipt = Worker.initialReceipt(workspace);
  assert.strictEqual(receipt.slots.length, 18); assert.strictEqual(receipt.launchCount, 0); assert.strictEqual(receipt.challengerProductionActive, false); assert.strictEqual(receipt.externalCostUsd, 0);
  assert.strictEqual(Worker.validateReceipt(receipt), receipt);
  receipt.slots[0].state = 'claimed'; receipt.slots[0].claimOrdinal = 1; receipt.launchCount = 1;
  assert.strictEqual(Worker.reconcileClaimed(receipt, '2026-09-07T00:00:00.000Z'), true);
  assert.strictEqual(receipt.slots[0].state, 'cancelled'); assert.strictEqual(receipt.launchCount, 1);
  assert.strictEqual(Worker.reconcileClaimed(receipt, '2026-09-07T00:00:01.000Z'), false);
  assert.throws(() => Worker.validateReceipt({ ...receipt, planDigest: 'bad' }), /receipt identity mismatch/);
  assert.throws(() => Worker.validateReceipt({ ...receipt, slots: receipt.slots.map((s, i) => i ? s : { ...s, taskId: 'other' }) }), /slot binding mismatch/);
  assert.throws(() => Worker.validateReceipt({ ...receipt, launchCount: 19 }), /launch ceiling violated/);
  assert.deepStrictEqual(Prepared.PLAN.slots.filter((s) => s.arm === 'challenger').map((s) => s.arm), Array(9).fill('challenger'));
  const stoppedRoot = path.join(root, 'stopped'); const p = Worker.paths(stoppedRoot); fs.mkdirSync(p.receiptDir, { recursive: true });
  fs.writeFileSync(p.receipt, JSON.stringify(Worker.initialReceipt(workspace))); fs.writeFileSync(p.stop, 'synthetic E-stop');
  const stopped = await Worker.run(stoppedRoot); assert.strictEqual(stopped.status, 'cancelled'); assert.strictEqual(stopped.launchCount, 0); assert.ok(stopped.slots.every((s) => s.state === 'cancelled'));
  const resumed = await Worker.run(stoppedRoot); assert.strictEqual(resumed.launchCount, 0); assert.ok(resumed.slots.every((s) => s.state === 'cancelled'));
  Worker.acquireLock(p.lock); assert.throws(() => Worker.acquireLock(p.lock), /worker already active/); fs.unlinkSync(p.lock);
  process.stdout.write('PASS durable receipt, recovery, duplicate prevention, ceiling, digest, E-stop, isolation, zero-cost boundaries\n');
})().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
