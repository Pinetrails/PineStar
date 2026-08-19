/* node test/failopen-ratchet.test.js — the fail-open RATCHET (2026-08-18 sweep).
   A bare silent promise catch — .catch with an empty/constant handler — on a background pass hid
   reflection's 100% failure rate for weeks. The 2026-08-18 sweep converted every dangerous sidecar
   site to swallow(tag) from sidecar/failopen.js and hand-audited the remainder as benign (shutdown
   reaps, CDP teardown, value defaults, reconnect loops that re-arm themselves). This test locks that
   audited baseline PER FILE: counts may only go DOWN. If it failed on your change, don't raise the
   number — use `.catch(swallow('your.tag'))` (or `.catch(swallow('your.tag', null))` for a value
   default), or handle the error. Lowering a count? Lower the baseline here in the same commit. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..', 'sidecar');

// the swallow class: .catch( () => {} ) / .catch(e => null) / => undefined / 0 / false — one silent
// constant-result handler, any single-identifier arg, with or without parens. Matches comments too;
// the baseline includes the two historical comment mentions on purpose (deleting them only lowers counts).
const SILENT_CATCH = /\.catch\(\s*\(?\s*_?\w*\s*\)?\s*=>\s*(\{\s*\}|null|undefined|0|false)\s*\)/g;

/* Audited baseline (forward-slash paths relative to sidecar/). Every file not listed must be CLEAN. */
const BASELINE = {
  'acp/serve.js': 1,                  // run-cancel relay on an already-torn-down session
  'channels/hub.js': 3,               // reaction cosmetics + message delete (documented best-effort)
  'index.js': 11,                     // shutdown reaps, inputGuard diagnostics, value defaults, 1 comment
  'local-voice.js': 2,                // ASR/TTS serialization tails (the queued run carries its own errors)
  'loopjob-driver.js': 1,             // snapshot degrade -> loopcheck already treats null as "cannot prove"
  'lsp-manager.js': 3,                // idle-close / pid-pin / closeAll teardown
  'mcp/manager.js': 1,                // connect() re-arms scheduleReconnect on failure (self-healing)
  'mcp/serve.js': 3,                  // SSE starts; the 3s reconnect timer re-arms on failure
  'mcp/transport.http.js': 1,         // best-effort MCP session DELETE on close
  'media-service.js': 1,              // voice-cache eviction (retried every 32 misses)
  'procledger.js': 1,                 // opportunistic pid identity pin (probe dedupes)
  'providers/anthropic.js': 1,        // catalog warm; a later call retries
  'providers/gemini.js': 1,           // catalog warm; a later call retries
  'providers/openai-compatible.js': 1,// catalog warm; a later call retries
  'providers/openrouter.js': 1,       // catalog warm; a later call retries
  'providers/provider.js': 2,         // reader.cancel() on timeout/abort teardown
  'shellbg.js': 1,                    // opportunistic pid identity pin (fail-closed to cmd matching)
  'spotify/store.js': 1,              // r.json() value default on an error body
  'terminal-sessions.js': 1,          // opportunistic pid identity pin
  'tools/builtin/browser.js': 9,      // CDP best-effort sends on adopt/close/failRequest seams
  'tools/builtin/image.js': 1,        // r.json() value default
  'tools/builtin/orchestration.js': 1,// pending-promise guard (result read elsewhere)
  'tools/builtin/webreader.js': 1,    // debugger session close on teardown
};

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT, []);
A.ok(files.length > 50, 'scanner sees the sidecar tree (' + files.length + ' js files)');

let totalOver = 0;
const seen = {};
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const src = fs.readFileSync(f, 'utf8');
  const n = (src.match(SILENT_CATCH) || []).length;
  seen[rel] = n;
  const cap = BASELINE[rel] || 0;
  if (n > cap) {
    totalOver++;
    A.ok(false, rel + ' has ' + n + ' bare silent catch(es), baseline allows ' + cap +
      ' — wrap the new one(s) in swallow(tag) from sidecar/failopen.js instead of a silent handler');
  }
}
A.eq(totalOver, 0, 'no sidecar file exceeds its audited silent-catch baseline');

// the ratchet's own hygiene: a baseline row for a deleted/renamed file is stale — prune it so the
// lock list stays a truthful map of the audited surface.
for (const rel of Object.keys(BASELINE)) {
  A.ok(rel in seen, 'baseline row exists on disk: ' + rel + ' (file moved/deleted? prune the row)');
}

// helper presence: the alternative this test points authors at must actually exist and load.
A.notThrows(() => require('../sidecar/failopen.js').swallow('ratchet.selftest'), 'failopen helper loads');

A.report('fail-open ratchet');
