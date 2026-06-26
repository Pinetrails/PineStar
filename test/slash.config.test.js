/* node test/slash.config.test.js -- static pins for Plan 4 slash config hooks. */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');

A.ok(app.indexOf('currentAgent: () => agent') >= 0, 'App exposes the current agent for slash status/config commands');
A.ok(app.indexOf('applyConfig: applyAgentConfig') >= 0, 'App exposes the existing config application path');
A.ok(app.indexOf("typeof patch.model === 'string'") >= 0, 'App config applies model changes');
A.ok(app.indexOf("typeof patch.personaId === 'string'") >= 0, 'App config applies personality changes');
A.ok(app.indexOf("typeof patch.approvalMode === 'string'") >= 0, 'App config applies approval mode changes');
A.ok(chat.indexOf('App.applyConfig') >= 0, 'chat slash commands use the App config seam');
A.ok(chat.indexOf('/api/skills?placed=') >= 0, 'skills command reads the sidecar skill catalog');

A.report('slash.config.test');
