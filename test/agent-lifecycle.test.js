/* node test/agent-lifecycle.test.js — deterministic per-agent lifecycle coordination. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeWorkspaceLease } = require('../sidecar/workspace-lease.js');
const { makeAgentLifecycle } = require('../sidecar/agent-lifecycle.js');

(async () => {
  let active = 0;
  const lease = makeWorkspaceLease({ waitMs: 1000, now: () => 1 });
  const life = makeAgentLifecycle({ workspaceLease: lease, isActive: () => active > 0 });

  // Restore/autonomy-style mutations serialize through the same workspace lease as run tools.
  const runLease = await lease.acquire('a', 'run-1');
  A.eq(runLease.ok, true, 'active mutation holds workspace lease');
  let mutationAcquired = false;
  const mutationP = life.acquireMutation('a', 'restore-1').then(x => { mutationAcquired = x.ok; return x; });
  await Promise.resolve();
  A.eq(mutationAcquired, false, 'lifecycle mutation waits behind active workspace mutation');
  lease.release('a', 'run-1');
  const mutation = await mutationP;
  A.eq(mutation.ok, true, 'lifecycle mutation acquires after active mutation drains');
  mutation.release();

  // Deletion safely rejects an agent with active runs.
  active = 1;
  const refused = await life.beginDelete('a', 'delete-1');
  A.eq(refused.active, true, 'active agent deletion is rejected');
  A.eq(life.canStart('a'), true, 'rejected deletion leaves future runs enabled');
  active = 0;

  // Once deletion reserves the lifecycle, new runs and late non-run writes cannot enter.
  const deleting = await life.beginDelete('a', 'delete-2');
  A.eq(deleting.ok, true, 'idle agent deletion reserves the lifecycle');
  A.eq(life.canStart('a'), false, 'new run admission is blocked during archive');
  const lateWrite = await life.acquireMutation('a', 'autowrite-late');
  A.eq(lateWrite.deleting, true, 'late autonomy/restore write is rejected during archive');
  deleting.finish();
  A.eq(life.canStart('a'), true, 'finishing archive releases lifecycle reservation');

  // Source wiring guard: all three routes use the policy and run admission observes deletion.
  const source = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/agentLifecycle\.acquireMutation\(agentId,\s*operationId\)[\s\S]{0,900}checkpointStore\.restore/.test(source),
    'checkpoint restore acquires the lifecycle mutation lease');
  A.ok(/handleAutonomyWrite[\s\S]{0,2600}agentLifecycle\.acquireMutation\(agentId,\s*sessionKey\)/.test(source),
    'autonomy write acquires the lifecycle mutation lease');
  A.ok(/handleAgentDelete[\s\S]{0,900}agentLifecycle\.beginDelete/.test(source),
    'agent deletion reserves the lifecycle before archive');
  A.ok(/agentLifecycle\.canStart\(agentId\)[\s\S]{0,900}concurrencyGate\.tryEnter/.test(source),
    'run admission rejects work while deletion is reserved');
  A.ok(/checkpointMutation:\s*async[\s\S]{0,1800}checkpointStore\.snapshot\(agentId,[\s\S]{0,500}workTree: workTree/.test(source),
    'run context snapshots the resolved mutation root instead of assuming the agent jail');
  A.ok(/preciseCheckpoint[\s\S]{0,900}environmentCheckpoints && mutatesWorkspace[\s\S]{0,200}!preciseCheckpoint/.test(source),
    'generic checkpoint hook defers fs, shell.exec, and verify.run to their precise-root boundary');
  A.ok(/checkpointMutation:\s*async[\s\S]{0,500}supports\.checkpoints === false\) return null/.test(source),
    'precise checkpoint hook honors the selected backend capability instead of snapshotting an unrelated local tree');

  const rewind = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'rewind.js'), 'utf8');
  A.ok(/s\.workTree[\s\S]{0,260}PROJECT ROOT/.test(rewind),
    'restore UI identifies external project-root snapshots explicitly');
  A.ok(/data-root=/.test(rewind) && /rolls back <b>' \+ esc\(root\)/.test(rewind),
    'restore confirmation names the exact root whose files will change');
  A.ok(/restoreAvailable/.test(rewind) && /PROJECT ACCESS REVOKED/.test(rewind),
    'restore UI blocks a project restore whose path grant is no longer active');

  A.report('agent-lifecycle');
})().catch(e => { console.log('FAIL: agent-lifecycle threw - ' + (e && e.stack || e)); process.exit(1); });
