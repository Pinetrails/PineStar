'use strict';
// Explicit host entry point. init creates the sole receipt; run/resume never creates one.
const path = require('path');
const Worker = require('./auditor-v2-durable-worker.js');
const command = process.argv[2];
const root = path.resolve(process.argv[3] || path.join(process.cwd(), 'output', 'auditor-v2-experiment'));
const workspace = process.argv[4] || 'C:\\Users\\troyn\\AppData\\Local\\StarNet\\workspaces';
(async () => {
  if (command === 'init') { Worker.initialize(root, workspace); process.stdout.write(Worker.paths(root).receipt + '\n'); return; }
  if (command === 'run' || command === 'resume') { const receipt = await Worker.run(root); process.stdout.write(JSON.stringify({ receiptId: receipt.receiptId, status: receipt.status, launchCount: receipt.launchCount }) + '\n'); return; }
  throw new Error('usage: node run-auditor-v2-experiment.js init|run|resume [durable-root] [workspace]');
})().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
