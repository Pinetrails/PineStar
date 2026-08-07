'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'app.css'), 'utf8');

for (const id of ['safe-cell', 'remote-ssh', 'trusted-project', 'this-computer']) A.ok(ui.includes("id: '" + id + "'"), 'dossier offers ' + id);
A.ok(/id="ag-execution-chips"/.test(ui) && /setExecutionProfile/.test(ui), 'dossier profile control writes the live roster');
A.ok(/id="perm-execution"/.test(ui) && /data-perm-profile/.test(ui), 'Settings offers per-agent execution profiles too');
A.ok(/ROUTES NEXT COMMAND TO <b>/.test(ui) && /AVAILABILITY <b>/.test(ui), 'dossier shows the per-agent routed backend and readiness truth');
A.ok(/routes next command to/.test(ui) && /availability/.test(ui), 'Settings shows the per-agent runtime selected for the next command');
A.ok(!/backend change requires a station restart/.test(ui), 'profile selection is not falsely described as a boot-only setting');
A.ok(/never grants real mouse, keyboard, or screen control/.test(ui), 'profile card names the separate desktop lease');
A.ok(/RUN WITHOUT PROMPTS/.test(ui) && /does not add tools, widen filesystem scope, choose a runtime/.test(ui), 'approval copy is narrow and honest');
A.ok(!/holds <b>FULL ACCESS<\/b>/.test(ui), 'Settings no longer presents approval bypass as machine-wide access');
A.ok(/executionProfile: executionProfileOf\(a\)/.test(app), 'profile persists in the browser save and roster push');
A.ok(/setAgentExecutionProfile/.test(app), 'profile has an independent app setter');
A.ok(/approvalMode: .*executionProfile:/.test(app), 'approval and profile ride the roster as separate fields');
A.ok(/approval prompts and execution scope are separate/.test(html), 'genesis teaches the separated axes');
A.ok(/data-ssh-host/.test(ui) && /data-ssh-root/.test(ui) && /SAVE &amp; PROBE/.test(ui), 'Settings exposes owner-configured SSH target fields');
A.ok(/StrictHostKeyChecking|strict known_hosts/.test(ui), 'SSH copy names the strict host-key boundary');
A.ok(/\/api\/execution\/sync/.test(ui) && /PUSH NOW/.test(ui) && /PULL NOW/.test(ui), 'Settings exposes explicit remote workspace sync controls');
A.ok(/\/api\/execution\/policy/.test(ui) && /STOP IDLE CELL/.test(ui), 'Settings exposes stop-only idle-cell policy and action');
A.ok(/\.perm-agent\[data-profile-agent\][^{]*\{display:grid/.test(css) && />\.exec-ssh\{grid-column:1\/-1/.test(css), 'SSH disclosure occupies its own profile-row lane instead of sitting beneath cleanup controls');

A.report('execution-profiles-ui.test');
