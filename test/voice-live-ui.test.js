'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'frontend', 'app', 'voice-live.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend', 'css', 'app.css'), 'utf8');

assert.match(source, /document\.body\.appendChild\(panel\)/, 'live controller is app-global, not mounted inside COMMS');
assert.doesNotMatch(source, /insertBefore\(panel,\s*chatLog\)/, 'live controller must not consume transcript space');
assert.match(source, /button\.onclick\s*=\s*\(\)\s*=>\s*active\s*\?\s*end\(\)\s*:\s*start\(false\)/, 'live button toggles the session off');
assert.match(source, /addEventListener\('pointermove'/, 'floating controller supports pointer dragging');
assert.match(source, /POSITION_KEY/, 'floating position is remembered');
assert.match(source, /seq\s*!==\s*sessionSeq/, 'late microphone permission cannot resurrect a closed session');
assert.match(source, /requestPartial\(utterance,\s*utteranceSeq\)/, 'long turns surface local partial transcription');
assert.match(source, /scheduleReconnect\(/, 'lost microphones enter the reconnect state machine');
assert.match(source, /approvalCommand\(lower\)/, 'run-scoped approvals can be answered by an explicit voice command');
assert.match(source, /agentCommand\(value,\s*lower\)/, 'voice can select the active Starnet agent without provider coupling');
assert.match(source, /Harness\.getProv/, 'the controller reports the active Starnet provider');
assert.doesNotMatch(source, /CODEX OAUTH/, 'provider-agnostic voice UI does not claim Codex is required');
assert.match(css, /\.live-voice-panel\s*\{[^}]*position:\s*fixed/s, 'controller follows the user across StarNet views');
assert.match(css, /\.lv-head\s*\{[^}]*cursor:\s*grab/s, 'header advertises the drag affordance');

console.log('voice-live-ui.test.js: ok');
