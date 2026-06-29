/* node test/cron.run-now.test.js -- source-lock the manual ROUTINES "Run Now" visibility path.

   A live end-to-end Run Now test would need provider credentials and spend. This keeps the invariant cheap:
   manual /api/cron/run must do the same two visible things as a scheduled fire before launching the run:
     - place a cron work item on the conveyor for the target agent
     - mirror run.start/cost/end over SSE so world.js drives the agent body for the run duration */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
const start = src.indexOf('async function handleCronRun');
const end = src.indexOf('/* POST /api/checkpoint/restore');
A.ok(start >= 0 && end > start, 'handleCronRun source block is present');
const handle = src.slice(start, end);

A.ok(/function\s+placeCronWorkitem\s*\([^)]*\)\s*\{[\s\S]*chanEmit\('workitem\.placed'/.test(src),
  'cron work-item placement helper emits workitem.placed');
A.ok(/placeWorkitem:\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,120}placeCronWorkitem\(agentId,\s*prompt\)/.test(src),
  'scheduled cron fires still use the shared work-item placement helper');
A.ok(/cronEmit\('cron\.fire'/.test(handle), 'Run Now still emits cron.fire before launch');
A.ok(/placeCronWorkitem\(job\.agentId,\s*job\.prompt\)/.test(handle),
  'Run Now places a visible cron work item for the routine agent');
A.ok(/runOnce\(\{[\s\S]*trigger:\s*'schedule'[\s\S]*broadcast:\s*true/.test(handle),
  'Run Now launches as a schedule-triggered autonomous run and broadcasts lifecycle to the floor');
A.ok(/const\s+emit\s*=\s*o\.broadcast[\s\S]*sse\.broadcast\(name,\s*redact\(payload\)\)/.test(src),
  'runOnce broadcast mirrors lifecycle events over SSE');

if (require.main === module) A.report('cron.run-now.test');
