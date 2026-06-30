'use strict';
// provider-connections-ui.test.js - source guard for additive provider credentials in Settings.
// ChatGPT/Codex OAuth and OpenRouter BYOK must coexist: signing into Codex must not erase,
// hide, or leak the OpenRouter key path.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const harness = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
const station = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const tauri = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'main.rs'), 'utf8');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const hostedProviders = ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras'];

ok(!/Harness\.setKey\(\s*['"]{2}\s*\)/.test(app), 'Codex wake does not clear the OpenRouter BYOK slot');
ok(/provider\s*!==\s*'codex'[\s\S]{0,80}reqBody\.key\s*=\s*key/.test(harness), 'browser BYOK key is sent only for key-backed provider runs');

ok(/fetch\('\/api\/auth\/codex\/status'/.test(station), 'Settings checks real Codex OAuth status');
ok(/let\s+codexConnectionKnown\s*=\s*null/.test(station), 'Codex OAuth status is independent from active provider selection');
ok(/if\s*\(active\s*!==\s*'openrouter'\)\s*addProvider\('openrouter'\)/.test(station), 'Settings can list OpenRouter independently from the active provider');
ok(/const\s+addProvider\s*=\s*active\s*===\s*'codex'\s*\?\s*'openrouter'\s*:\s*active/.test(station), 'Codex-active add-key row targets OpenRouter');
ok(/id="key-in-new"/.test(station) && /data-act="add"/.test(station) && /data-provider=/.test(station), 'add-key controls carry their target provider');
ok(/const\s+provider\s*=\s*b\.dataset\.provider\s*\|\|\s*activeProv\(\)/.test(station), 'add-key save writes to the row provider, not necessarily the active provider');

for (const id of hostedProviders) {
  ok(index.includes('data-prov="' + id + '"'), id + ' appears in the connect provider picker');
  ok(station.includes("id: '" + id + "'"), id + ' appears in Settings provider cards');
  ok(tauri.includes('"' + id + '"'), id + ' appears in desktop keychain provider status');
}
ok(/PROVIDERS\.forEach\(p\s*=>\s*addProvider\(p\.id\)\)/.test(station), 'Settings lists any configured provider, not only the active provider');

console.log('provider-connections-ui.test.js OK -', n, 'assertions');
