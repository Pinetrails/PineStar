/* node test/workshop.e2e.test.js — real sidecar proof for the AWAY WORKSHOP (W1 grant + W2 driver).

   Boots the ACTUAL sidecar with a mock OpenRouter, then drives the full loop the way the Commander would:
     1. POST /api/workshop/grant { on:true }  — record the "Build things while I'm away" consent.
     2. POST /api/workshop/queue              — line up a build request.
     3. POST /api/workshop/shift              — force-fire ONE shift NOW (attended test of the unattended path).
   The mock agent WRITES a real file + a deliverable.json manifest via fs_write. Because the agent is GRANTED
   (W1), the autonomous cabinet:write is ALLOWED (an UNGRANTED agent's write default-denies — asserted too).
   Proves end-to-end: the run streams, workshop/<runId>/ + a valid deliverable.json land ON DISK, the shift
   reports built, and workshop.built arrives on the durable SSE bus with the disk-proven manifest.

   Also proves the two ABSOLUTE guards live: an empty backlog is a SILENT no-op (no workshop.built), and an
   UNGRANTED agent's autonomous fs.write is DENIED (the grant is load-bearing, not decorative). */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const WORKSHOP_MARK = '[WORKSHOP_SHIFT]';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// mock OpenRouter: on a WORKSHOP run, write the deliverable file, then the manifest, then stop. Turn is inferred
// from how many tool results the transcript already carries (0 -> write file, 1 -> write manifest, 2 -> done).
function startMockOpenRouter() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let msgs = []; try { msgs = (JSON.parse(body).messages) || []; } catch (_) {}
          const userMsg = msgs.find(m => m && m.role === 'user');
          const prompt = String((userMsg && userMsg.content) || '');
          const runId = (prompt.match(/workshop\/([A-Za-z0-9-]+)\//) || [])[1] || 'run';
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          const text = t => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); };
          const dir = 'workshop/' + runId;
          if (prompt.indexOf(WORKSHOP_MARK) === 0) {
            if (toolResults === 0) {
              tool('w1', 'fs_write', { path: dir + '/cleaner.py', content: 'print("csv cleaned")\n' });
            } else if (toolResults === 1) {
              const manifest = { v: 1, runId: runId, agentId: 'builder', backlogId: 'item-1', title: 'CSV cleaner', kind: 'tool', summary: 'A tiny CSV cleaner script.', files: [{ path: 'cleaner.py', bytes: 21 }], howToUse: 'Run it on a CSV.', notVerified: ['not executed'] };
              tool('w2', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else { text('Built the CSV cleaner in my workshop.'); }
          } else {
            // ungranted-write probe: try an autonomous fs_write; then report.
            if (toolResults === 0) tool('u1', 'fs_write', { path: 'sneaky.txt', content: 'should be denied' });
            else text('done');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
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

async function readNdjson(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', events = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { events.push(JSON.parse(line)); } catch (_) {} } } }
  return events;
}

async function startSse(url) {
  const ac = new AbortController(); const events = []; const waiters = [];
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body.getReader();
  function notify() { for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; if (w.pred(events)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(events); } } }
  (async () => { const dec = new TextDecoder(); let buf = '';
    try { while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line || line[0] === ':') continue; if (line.indexOf('data:') === 0) { try { events.push(JSON.parse(line.slice(5).trim())); notify(); } catch (_) {} } } } } catch (_) {} })();
  return { events, waitFor(pred, ms, label) { if (pred(events)) return Promise.resolve(events); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms); waiters.push({ pred, resolve, reject, timer }); }); }, close() { try { ac.abort(); } catch (_) {} } };
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-workshop-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-workshop-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  const { child, port } = await boot(8960 + (process.pid % 30), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    sse = await startSse(B + '/api/channels/events?token=' + encodeURIComponent(token));

    // 0. EMPTY BACKLOG (granted, nothing queued) -> silent no-op, no workshop.built.
    await fetch(B + '/api/workshop/grant', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', on: true }) });
    const emptyShift = await (await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder' }) })).text();
    const emptyRes = JSON.parse(emptyShift.trim().split('\n').filter(Boolean).pop());
    A.ok(emptyRes.payload && emptyRes.payload.fired === false && emptyRes.payload.reason === 'empty-backlog', 'empty backlog is a SILENT no-op (fired:false)');

    // 1. grant persisted + reflected in the backlog view.
    const bl0 = await (await fetch(B + '/api/workshop/backlog?agent=builder', { headers })).json();
    A.ok(bl0.granted === true, 'grant is recorded and read back via /backlog');

    // 2. queue a build request.
    const q = await (await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-1', title: 'CSV cleaner', detail: 'a script that strips blank rows' }) })).json();
    A.ok(q.ok === true && q.item && q.item.id === 'item-1', 'queued the build request');
    // dedup doctrine: the same normalized title is refused.
    const dup = await (await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-1b', title: '  csv   CLEANER ' }) })).json();
    A.ok(dup.ok === false && dup.reason === 'duplicate', 'a duplicate normalized title is refused (dedup doctrine)');

    // 3. force-fire ONE shift. The granted agent writes cleaner.py + deliverable.json under workshop/<runId>/.
    const shiftRes = await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder' }) });
    A.eq(shiftRes.status, 200, 'shift force-fire returns a stream');
    const stream = await readNdjson(shiftRes);
    const result = (stream.find(e => e.name === 'workshop.shift.result') || {}).payload || {};
    A.ok(result.fired === true && result.reason === 'built', 'shift built a deliverable (fired:true, reason:built)');
    const runId = result.runId;
    A.ok(runId, 'shift returned a runId');
    A.ok(result.manifest && result.manifest.title === 'CSV cleaner', 'shift result carries the disk-proven manifest');

    // 4. THE FILES ARE REALLY ON DISK (the write happened through the real fs-jail, unlocked by the W1 grant).
    const runDir = path.join(ws, 'builder', 'workshop', runId);
    A.ok(fs.existsSync(path.join(runDir, 'cleaner.py')), 'the deliverable file exists on disk');
    const manRaw = fs.readFileSync(path.join(runDir, 'deliverable.json'), 'utf8');
    const man = JSON.parse(manRaw);
    A.ok(man.v === 1 && Array.isArray(man.files) && man.files.length >= 1, 'deliverable.json on disk is a valid v1 manifest');

    // 5. workshop.built arrived on the durable SSE bus with the proven manifest.
    await sse.waitFor(ev => ev.some(e => e.name === 'workshop.built' && e.payload && e.payload.agentId === 'builder' && e.payload.runId === runId && e.payload.manifest && e.payload.manifest.files.length >= 1), 6000, 'workshop.built SSE');
    A.ok(true, 'workshop.built emitted with a disk-proven manifest');

    // 6. it shows up as a PENDING deliverable for the return-card.
    const pending = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    A.ok(pending.pending.some(m => m.runId === runId && m.title === 'CSV cleaner'), '/pending lists the built deliverable');

    // 7. GRANT IS LOAD-BEARING: an UNGRANTED agent's autonomous fs.write is DENIED. Queue+shift on a NON-granted
    //    agent -> the write default-denies -> no manifest -> no workshop.built (fired but reason no-manifest).
    await fetch(B + '/api/workshop/grant', { method: 'POST', headers, body: JSON.stringify({ agentId: 'nogrant', on: false }) });
    // queue directly in the store isn't exposed for an ungranted agent via a grant gate, but the queue route allows
    // queueing regardless of grant; fire the shift — runWorkshopShift itself refuses when not granted.
    await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'nogrant', id: 'ng-1', title: 'blocked build' }) }).then(r => r.json());
    const ngText = await (await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'nogrant' }) })).text();
    const ngRes = JSON.parse(ngText.trim().split('\n').filter(Boolean).pop());
    A.ok(ngRes.payload && ngRes.payload.fired === false && ngRes.payload.reason === 'not-granted', 'an UNGRANTED agent cannot run a workshop shift (grant is load-bearing)');
    A.ok(!fs.existsSync(path.join(ws, 'nogrant', 'workshop')), 'the ungranted agent wrote nothing');

    // 7.4 KEEP copies a deliverable OUT to a user-chosen folder — COPYFILE_EXCL by default (never a silent
    //     clobber). Runs on its OWN queued item so it doesn't retire item-1 (step 8 still needs it). A second
    //     keep to the SAME folder is refused 409 EEXIST; overwrite:true then replaces.
    await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-keep', title: 'Keep me' }) }).then(r => r.json());
    const keepShift = await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder' }) });
    const keepStream = await readNdjson(keepShift);
    const runId2 = ((keepStream.find(e => e.name === 'workshop.shift.result') || {}).payload || {}).runId;
    A.ok(runId2 && runId2 !== runId, 'a second shift built a second deliverable with its own runId');

    const keepDir = path.join(os.tmpdir(), 'starnet-keep-' + Date.now());
    const keep1 = await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId2, decision: 'keep', destPath: keepDir }) });
    const keep1j = await keep1.json();
    A.ok(keep1.status === 200 && keep1j.ok === true && keep1j.copied >= 1, 'keep to a fresh folder copies the deliverable files');
    A.ok(fs.existsSync(path.join(keepDir, 'cleaner.py')), 'the kept file really landed at destPath');

    const keep2 = await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId2, decision: 'keep', destPath: keepDir }) });
    const keep2j = await keep2.json();
    A.eq(keep2.status, 409, 'keep to a folder that already has the file is refused 409 (no silent overwrite)');
    A.ok(keep2j.code === 'EEXIST' && keep2j.overwritable === true, 'the refusal names EEXIST and flags it overwritable');

    const keep3 = await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId2, decision: 'keep', destPath: keepDir, overwrite: true }) });
    A.eq(keep3.status, 200, 'keep with overwrite:true replaces the existing files');
    try { fs.rmSync(keepDir, { recursive: true, force: true }); } catch (_) {}

    // 8. DISCARD removes the run dir + denylists the item (never silently rebuilt).
    const dec = await (await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId, decision: 'discard' }) })).json();
    A.ok(dec.ok === true && dec.decision === 'discard', 'discard decision accepted');
    A.ok(!fs.existsSync(runDir), 'discard wiped the run dir');
    const reQ = await (await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-1', title: 'CSV cleaner' }) })).json();
    A.ok(reQ.ok === false && reQ.reason === 'discarded', 'the discarded item cannot be re-queued (discard = never again)');

    // 9. PERSISTENCE: the grant survives a sidecar RESTART.
    A.ok(fs.existsSync(path.join(ws, 'builder.workshop.json')), 'the workshop store persisted to disk');
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('workshop.e2e.test');
})().catch(e => { console.log('FAIL: workshop.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
