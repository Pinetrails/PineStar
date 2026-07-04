/* node test/diagnostics.test.js — the paste-ready bug-report assembler (sidecar/diagnostics.js, T3.9).

   THE HARD REQUIREMENT this test exists to enforce: no secret ever survives into the diagnostics block. We feed
   fake API keys, channel/OAuth tokens, a JWT, and prompt-shaped junk through EVERY free-text field and assert none
   of it appears in either the structured report OR the plain-text block. It uses the REAL production redact()
   (sidecar/context.js) so the test tracks the actual scrubber, not a stub. Also checks the truthful-telemetry
   contract: missing fields render as 'unknown'/omitted, never invented; and structured booleans stay shape-only. */
'use strict';
const A = require('./_assert.js');
const { makeDiagnostics } = require('../sidecar/diagnostics.js');
const { redact } = require('../sidecar/context.js');   // the real always-on secret scrubber

const diag = makeDiagnostics({ redact });

// ---- a battery of real-shaped secrets that must NEVER appear anywhere in the output ----
const SECRETS = [
  'sk-or-v1-abcdef0123456789abcdef0123456789',            // OpenRouter key
  'sk-ant-abcdef0123456789abcdef',                        // Anthropic key
  'sk-proj-abcdef0123456789abcdef0123456789',             // OpenAI project key
  '123456789:AAF-abcdefghijklmnopqrstuvwxyz0123456',      // Telegram bot token
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',           // GitHub token
  'xoxb-1234567890-abcdefghijklmnop',                     // Slack token
  'eyJhbGciOiJIUzI1Ni019.eyJzdWIiOiIxMjM0NTY3ODk019.abcDEFghiJKL',  // JWT
  'ya29.abcdefghijklmnopqrstuvwxyz0123456789'             // Google OAuth access token
];

// build a snapshot that stuffs every secret into the error tail (the one free-text channel) + into model/provider
// (which must be treated as slugs, but we prove even a poisoned one is scrubbed by the second backstop).
const poisoned = diag.assemble({
  version: { harness: '0.1.7', app: '0.1.7', node: 'v20.0.0' },
  platform: { os: 'win32', arch: 'x64', node: 'v20.0.0' },
  mode: 'desktop',
  provider: 'openrouter ' + SECRETS[0],       // a hostile value smuggled into a "slug" field
  model: 'anthropic/claude-sonnet-4.6 ' + SECRETS[1],
  keyPresent: true,
  agentCount: 3,
  uptimeMs: 8100000,                           // 2h 15m
  workspacePresent: true,
  lastRun: { runId: 'run-abc123', status: 'error', ts: 1720000000000 },
  errors: SECRETS.map((s, i) => ({ ts: 1720000000000 + i, message: 'run failed: Authorization: Bearer ' + s + ' -----BEGIN PRIVATE KEY-----' + s + '-----END PRIVATE KEY-----' }))
});

const blob = JSON.stringify(poisoned) + '\n' + poisoned.text;   // scan BOTH the structured report and the text block
for (const s of SECRETS) {
  A.ok(blob.indexOf(s) < 0, 'secret is fully scrubbed everywhere: ' + s.slice(0, 12) + '…');
}
A.ok(blob.indexOf('BEGIN PRIVATE KEY') < 0, 'private-key block never survives into diagnostics');
// a redaction marker SHOULD be present (proves the field wasn't just dropped silently — the error was recorded)
A.ok(/redacted/.test(poisoned.text), 'scrubbed errors leave a visible [redacted-…] marker, not a silent drop');

// ---- truthful telemetry: honest fields pass through; missing fields are omitted/unknown, never invented ----
A.ok(poisoned.text.indexOf('App version:   0.1.7') >= 0, 'app version is surfaced verbatim');
A.ok(poisoned.text.indexOf('Mode:          desktop') >= 0, 'desktop-vs-browser mode is surfaced');
A.ok(poisoned.text.indexOf('Credential:    configured') >= 0, 'key PRESENCE is surfaced as a boolean, not the key');
A.ok(poisoned.text.indexOf('Workspace dir: present') >= 0, 'workspace presence is a boolean');
A.ok(poisoned.text.indexOf('run-abc123 — error') >= 0, 'last run id + status are surfaced');
A.ok(poisoned.text.indexOf('2h 15m') >= 0, 'uptime renders as a human duration');
A.eq(poisoned.report.keyPresent, true, 'keyPresent stays a strict boolean');
A.eq(poisoned.report.workspacePresent, true, 'workspacePresent stays a strict boolean');

// an EMPTY snapshot never fabricates values — everything degrades to unknown/none, and nothing throws.
const empty = diag.assemble({});
A.ok(empty.text.indexOf('App version:   unknown') >= 0, 'missing version -> unknown, not invented');
A.ok(empty.text.indexOf('Mode:          unknown') >= 0, 'missing mode -> unknown');
A.ok(empty.text.indexOf('Provider:      unknown') >= 0, 'missing provider -> unknown');
A.ok(empty.text.indexOf('Last run:      none yet') >= 0, 'no run yet is stated honestly');
A.ok(empty.text.indexOf('(none recorded this session)') >= 0, 'no errors is stated honestly');
A.eq(empty.report.keyPresent, false, 'absent credential -> false, never a guessed true');
A.eq(empty.report.workspacePresent, false, 'absent workspace flag -> false');

// a completely garbage input must not throw (the endpoint wraps this, but the assembler is defensive too).
A.notThrows(() => diag.assemble(null), 'null snapshot does not throw');
A.notThrows(() => diag.assemble({ errors: 'not-an-array', lastRun: 42, uptimeMs: 'x' }), 'malformed fields do not throw');

// the block advertises its own safety (a small honesty cue for the user pasting it).
A.ok(/no keys, tokens, or message content/.test(poisoned.text), 'block states it contains no secrets');

A.report('diagnostics');
