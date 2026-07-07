/* node test/e2e.attachments.test.js — TRUE end-to-end for COMMS user attachments: boot the ACTUAL sidecar and
   (1) upload a photo via POST /api/attachments, (2) fetch it back through the jailed /api/file route, (3) drive
   a real /api/run with the attachment reference on the user turn, and assert the EXACT uploaded bytes reach the
   (mocked) provider as a base64 image_url content block. This proves the whole backend pipeline wired live —
   upload -> workspace save -> run-time expansion -> provider — not just the unit-level pieces. No real key. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');
const fs = require('fs');
const { spawn } = require('child_process');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

// a 1x1 png — real bytes, so we can assert the exact base64 round-trips upload -> disk -> expansion -> provider.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// mock OpenRouter: /models -> a minimal catalog; /chat/completions -> a short SSE completion; capture requests.
function startMockOpenRouter() {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'a red pixel' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function drain(res) { const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '', events = []; while (true) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { events.push(JSON.parse(line)); } catch (_) {} } } } return events; }

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-attach-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base };
  const { child, port } = await boot(8890 + (process.pid % 40), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // 1. UPLOAD a photo -> a lightweight reference; the bytes land in the agent's workspace.
    const up = await fetch(B + '/api/attachments', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'e2e', name: 'pixel.png', dataUrl: 'data:image/png;base64,' + PNG_B64 }) });
    A.eq(up.status, 200, 'POST /api/attachments -> 200');
    const ref = await up.json();
    A.ok(ref.ok && ref.kind === 'image' && /^\.attachments\/.+\.png$/.test(ref.path), 'upload returns an image reference under .attachments/ — ' + JSON.stringify(ref));

    // 2. FETCH the photo back through the jailed /api/file route (proves the thumbnail path is real + serves bytes).
    const fileRes = await fetch(B + '/api/file?agent=e2e&path=' + encodeURIComponent(ref.path) + '&token=' + encodeURIComponent(token), { headers: { Origin: B } });
    A.eq(fileRes.status, 200, 'GET /api/file serves the uploaded attachment');
    A.eq(String(fileRes.headers.get('content-type') || '').indexOf('image/png'), 0, 'served with an image/png content-type');
    const gotBytes = Buffer.from(await fileRes.arrayBuffer());
    A.eq(gotBytes.toString('base64'), PNG_B64, 'the served bytes are exactly the uploaded image');

    // 3. RUN with the attachment on the user turn — the sidecar must expand the reference into an image block.
    const runRes = await fetch(B + '/api/run', { method: 'POST', headers: H, body: JSON.stringify({
      key: 'sk-or-v1-e2e-fake', model: 'test/model', agentId: 'e2e',
      messages: [{ role: 'user', content: 'what colour is this pixel?', attachments: [{ id: ref.id, name: 'pixel.png', path: ref.path, mediaType: 'image/png', kind: 'image' }] }]
    }) });
    A.eq(runRes.status, 200, 'POST /api/run (with an attachment) streams 200');
    const events = await drain(runRes);
    const ends = events.filter(e => e.name === 'agent.run.end');
    A.eq(ends.length, 1, 'exactly one agent.run.end');
    A.eq(ends[0].payload.reason, 'done', 'the run with an attachment completes cleanly');

    // 4. ASSERT the exact uploaded image reached the provider as a base64 image_url content block.
    const req0 = mock.requests[0] || {};
    const userMsg = (req0.messages || []).filter(m => m && m.role === 'user' && Array.isArray(m.content)).pop();
    A.ok(userMsg, 'the provider received a user turn with multi-part (array) content');
    const parts = (userMsg && userMsg.content) || [];
    A.ok(parts.some(p => p && p.type === 'text' && String(p.text).indexOf('what colour is this pixel?') >= 0), 'the typed text reached the provider');
    const imgPart = parts.find(p => p && p.type === 'image_url');
    A.ok(imgPart, 'an image_url part reached the provider');
    const url = imgPart && imgPart.image_url && imgPart.image_url.url;
    A.eq(url, 'data:image/png;base64,' + PNG_B64, 'the EXACT uploaded image bytes reached the provider as a base64 data URL');

    // 5. DELETE the attachment (composer remove-before-send) prunes the workspace file.
    const del = await fetch(B + '/api/attachments', { method: 'POST', headers: H, body: JSON.stringify({ op: 'delete', agent: 'e2e', path: ref.path }) });
    A.eq(del.status, 200, 'POST /api/attachments {op:delete} -> 200');
    const after = await fetch(B + '/api/file?agent=e2e&path=' + encodeURIComponent(ref.path) + '&token=' + encodeURIComponent(token), { headers: { Origin: B } });
    A.eq(after.status, 404, 'the deleted attachment is gone (404)');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
  }
  A.report('e2e.attachments.test');
})().catch(e => { console.error(e); process.exit(1); });
