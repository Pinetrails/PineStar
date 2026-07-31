/* dev/seed-clarify.js — DEV-ONLY live-proof launcher for IN-TURN CLARIFY.

   Same shape as seed-calm-errors.js (real sidecar + real frontend + in-process mock OpenRouter on a
   scratch workspace, $0), but the mock model calls brief_ask on its first turn. The proof: the COMMS
   clarify card renders mid-run, clicking a chip resumes the SAME run (no new runId, endReason 'done',
   the final text carries the picked answer) — versus the old flow where the question ended the run.
   Not part of any test/build; SKYNET_DEV never ships. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'seed-workspace');
const SCRATCH = path.join(__dirname, '.scratch-clarify');
const SIDECAR = path.join(REPO, 'sidecar', 'index.js');
const PORT = String(process.env.SKYNET_PORT || '9231');

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const ev of events) res.write('data: ' + JSON.stringify(ev) + '\n\n');
  res.write('data: [DONE]\n\n'); res.end();
}

function startMock() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let b = ''; req.on('data', d => b += d); req.on('end', () => {
          let answered = '';
          try {
            const msgs = (JSON.parse(b).messages) || [];
            const t = msgs.filter(m => m && m.role === 'tool').map(m => String(m.content || '')).join(' ');
            const m = t.match(/The Commander answered: "([^"]+)"/);
            if (m) answered = m[1];
          } catch (_) {}
          if (!answered) {
            // turn 1: one host-validated material question
            sse(res, [
              { choices: [{ delta: { tool_calls: [
                { index: 0, id: 'call_ask_1', type: 'function', function: { name: 'brief_ask', arguments: JSON.stringify({
                  dimension: 'audience',
                  question: 'who is this dashboard primarily for?',
                  options: ['operators', 'executives', 'customers'],
                  recommended: 'operators',
                  reason: 'Audience changes information density and navigation.',
                  discoverable: false
                }) } }
              ] } }] },
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }
            ]);
          } else {
            // turn 2: the SAME run continues with the live answer
            sse(res, [
              { choices: [{ delta: { content: 'CLARIFY PROOF: same run resumed — building for ' + answered + '.' } }] },
              { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }
            ]);
          }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port + '/api/v1'));
  });
}

(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.cpSync(FIXTURE, SCRATCH, { recursive: true });
  const now = Date.now();
  try {
    const sp = path.join(SCRATCH, 'agent.save.json');
    const w = JSON.parse(fs.readFileSync(sp, 'utf8'));
    w.updatedAt = now; w.savedAt = now;
    if (w.doc) { w.doc.updatedAt = now; if (w.doc.agent) w.doc.agent.model = 'test/model'; }
    fs.writeFileSync(sp, JSON.stringify(w, null, 2));
  } catch (_) {}
  const base = await startMock();
  const env = Object.assign({}, process.env, {
    SKYNET_DEV: '1', SKYNET_FULL_ACCESS: '1',
    SKYNET_WORKSPACES: SCRATCH, SKYNET_PORT: PORT,
    SKYNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-mock', SKYNET_DEFAULT_MODEL: 'test/model'
  });
  console.log('[seed-clarify] mock provider at ' + base + ' -> http://127.0.0.1:' + PORT);
  const child = spawn(process.execPath, [SIDECAR], { cwd: REPO, env, stdio: 'inherit' });
  process.on('SIGINT', () => { try { child.kill(); } catch (_) {} });
  child.on('exit', c => process.exit(c == null ? 0 : c));
})();
