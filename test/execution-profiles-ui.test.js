'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');

for (const id of ['safe-cell', 'trusted-project', 'this-computer']) A.ok(ui.includes("id: '" + id + "'"), 'dossier offers ' + id);
A.ok(/id="ag-execution-chips"/.test(ui) && /setExecutionProfile/.test(ui), 'dossier profile control writes the live roster');
A.ok(/id="perm-execution"/.test(ui) && /data-perm-profile/.test(ui), 'Settings offers per-agent execution profiles too');
A.ok(/REQUESTS <b>/.test(ui) && /ACTIVE <b>/.test(ui), 'UI distinguishes requested from effective backend');
A.ok(/backend change requires a station restart/.test(ui), 'backend mismatch is stated, never painted as active isolation');
A.ok(/never grants real mouse, keyboard, or screen control/.test(ui), 'profile card names the separate desktop lease');
A.ok(/RUN WITHOUT PROMPTS/.test(ui) && /does not add tools, widen filesystem scope, choose a runtime/.test(ui), 'approval copy is narrow and honest');
A.ok(!/holds <b>FULL ACCESS<\/b>/.test(ui), 'Settings no longer presents approval bypass as machine-wide access');
A.ok(/executionProfile: executionProfileOf\(a\)/.test(app), 'profile persists in the browser save and roster push');
A.ok(/setAgentExecutionProfile/.test(app), 'profile has an independent app setter');
A.ok(/approvalMode: .*executionProfile:/.test(app), 'approval and profile ride the roster as separate fields');
A.ok(/approval prompts and execution scope are separate/.test(html), 'genesis teaches the separated axes');

A.report('execution-profiles-ui.test');
