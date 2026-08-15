/* node test/workshop-implement.e2e.test.js — real sidecar proof that IMPLEMENT actually implements.

   THE GAP THIS CLOSES: the delivery card's Implement action had exactly one way to change anything — apply a
   `kind:"patch"` deliverable to a branch — and that path needs a blessed project AND a project-kind night focus.
   Everywhere else Implement copied files to a folder, so pressing it on a BACKLOG/PLAN produced a .md and nothing
   else ever happened. POST /api/workshop/implement runs the build that does the work the plan describes.

   Boots the ACTUAL sidecar against a mock OpenRouter and drives the true round-trip:
     grant → queue → shift (builds a PLAN, planOnly:true) → implement (builds the REAL thing) → assert on disk.
   It proves:
     • the plan build declares planOnly:true and /pending carries it (the card reads this to decide what Implement means);
     • implement starts a SECOND, DIFFERENT run whose files really exist in the jail (the work happened);
     • the implement run is actually FED the plan (its prompt names the source file — proven by a probe the mock writes);
     • the produced manifest is stamped implementOf ON DISK, so it survives the re-validation every read does;
     • implementing an implementation is refused (loop guard) — a plan can be built, its build cannot;
     • a second implement of the same plan is refused as already-implemented, never a silent double build;
     • unknown run → source-gone; malformed agent/run → 400. */
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
const IMPLEMENT_MARK = '[IMPLEMENT_BUILD]';

// mock OpenRouter. Two build branches keyed on the prompt sentinel: the WORKSHOP shift writes a PLAN (planOnly),
// the IMPLEMENT run writes the real artifact. The implement branch also records whether its prompt actually named
// the source plan's file, so the test can prove the plan was fed to the run rather than assumed.
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
          // the run's OWN dir — take it from the manifest instruction, never the first "workshop/" in the text
          // (an implement prompt names the SOURCE dir first, so a loose match would target the wrong run).
          const runId = (prompt.match(/manifest to "workshop\/([A-Za-z0-9-]+)\/deliverable\.json"/) || [])[1] || 'run';
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          const text = t => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); };
          const dir = 'workshop/' + runId;
          if (prompt.indexOf(IMPLEMENT_MARK) === 0) {
            // THE IMPLEMENT RUN — build the real thing the plan asked for.
            if (toolResults === 0) {
              // probe: did the prompt actually carry the plan's file path, and forbid re-planning?
              const sawSource = /workshop\/[A-Za-z0-9-]+\/automation-backlog\.md/.test(prompt);
              const forbidsPlan = /BUILD, DO NOT RE-PLAN/.test(prompt);
              tool('i0', 'fs_write', { path: dir + '/probe.txt', content: 'SAW_SOURCE=' + sawSource + '\nFORBIDS_REPLAN=' + forbidsPlan + '\n' });
            } else if (toolResults === 1) {
              tool('i1', 'fs_write', { path: dir + '/snapshot.ps1', content: 'Get-ComputerInfo | Select-Object CsName, OsName\n' });
            } else if (toolResults === 2) {
              const manifest = { v: 1, runId: runId, agentId: 'builder', backlogId: 'x', title: 'PC snapshot script', kind: 'tool', planOnly: false,
                summary: 'A PowerShell one-liner that prints the machine summary. Covers the first item of the backlog.',
                files: [{ path: 'probe.txt', bytes: 10 }, { path: 'snapshot.ps1', bytes: 20 }], howToUse: 'Run snapshot.ps1.', notVerified: ['run it once'] };
              tool('i2', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else { text('Built the snapshot script.'); }
          } else if (prompt.indexOf(WORKSHOP_MARK) === 0) {
            // THE PLAN — exactly the shape that used to make Implement a no-op file copy.
            if (toolResults === 0) {
              tool('w1', 'fs_write', { path: dir + '/automation-backlog.md', content: '# Automation backlog\n\n1. A PC snapshot script.\n2. A disk report.\n' });
            } else if (toolResults === 1) {
              const manifest = { v: 1, runId: runId, agentId: 'builder', backlogId: 'item-plan', title: 'Recent-work automation backlog', kind: 'doc', planOnly: true,
                summary: 'A backlog turning repeated workstation questions into automation candidates.',
                files: [{ path: 'automation-backlog.md', bytes: 60 }], howToUse: 'Open automation-backlog.md.', notVerified: ['pick which to build first'] };
              tool('w2', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else { text('Wrote the backlog.'); }
          } else { text('done'); }
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

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-workshop-impl-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-workshop-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  const firstBoot = await boot(8970 + (process.pid % 25), env, 20);
  const child = firstBoot.child;
  const B = 'http://' + HOST + ':' + firstBoot.port;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const post = (p, b) => fetch(B + p, { method: 'POST', headers, body: JSON.stringify(b) });

    // 1. build the PLAN — the deliverable shape that used to make Implement a pure file copy.
    await post('/api/workshop/grant', { agentId: 'builder', on: true });
    await post('/api/workshop/queue', { agentId: 'builder', id: 'item-plan', title: 'Recent-work automation backlog' });
    const shiftEvents = await readNdjson(await post('/api/workshop/shift', { agentId: 'builder' }));
    const shiftRes = ((shiftEvents.find(e => e.name === 'workshop.shift.result') || {}).payload || {});
    A.ok(shiftRes.fired === true && shiftRes.reason === 'built', 'the shift built the plan deliverable');
    const planRun = shiftRes.runId;
    A.ok(fs.existsSync(path.join(ws, 'builder', 'workshop', planRun, 'automation-backlog.md')), 'the plan file exists in the jail');

    // the card reads planOnly to decide what Implement MEANS — it must survive validation out to /pending.
    const pending = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    const planMan = pending.pending.find(m => m.runId === planRun);
    A.ok(planMan, '/pending lists the plan build');
    A.eq(planMan.planOnly, true, '/pending carries planOnly:true — the card knows this DESCRIBES work');
    A.ok(!planMan.implementOf, 'the plan itself is not an implementation');

    // 2. IMPLEMENT — the whole point: a second, real build that does what the plan describes.
    const implEvents = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: planRun }));
    const implRes = ((implEvents.find(e => e.name === 'workshop.implement.result') || {}).payload || {});
    A.ok(implRes.fired === true && implRes.reason === 'built', 'implement ran a real build (fired:true, reason:built)');
    const implRun = implRes.runId;
    A.ok(implRun && implRun !== planRun, 'implement produced a NEW run, distinct from the plan');
    const implDir = path.join(ws, 'builder', 'workshop', implRun);
    A.ok(fs.existsSync(path.join(implDir, 'snapshot.ps1')), 'the implemented artifact really exists on disk — work happened, not a copy');

    // the run must actually be FED the plan, not merely told a plan existed.
    const probe = fs.readFileSync(path.join(implDir, 'probe.txt'), 'utf8');
    A.ok(/SAW_SOURCE=true/.test(probe), 'the implement prompt named the source plan file (the run reads the real plan)');
    A.ok(/FORBIDS_REPLAN=true/.test(probe), 'the implement prompt forbids delivering another plan');

    // 3. the loop guard is stamped ON DISK (every reader re-validates from deliverable.json).
    const onDisk = JSON.parse(fs.readFileSync(path.join(implDir, 'deliverable.json'), 'utf8'));
    A.eq(onDisk.implementOf, planRun, 'the produced manifest is stamped implementOf on disk (survives re-validation)');
    const pending2 = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    const implMan = pending2.pending.find(m => m.runId === implRun);
    A.ok(implMan, '/pending lists the implemented build as its own reviewable deliverable');
    A.eq(implMan.implementOf, planRun, 'and /pending carries implementOf, so the card refuses a second hop');
    A.eq(implMan.planOnly, false, 'the implementation declares planOnly:false — it IS the thing');

    // 4. implementing an IMPLEMENTATION is refused — a plan can be built; its build cannot be built again.
    const loop = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: implRun }));
    const loopRes = ((loop.find(e => e.name === 'workshop.implement.result') || {}).payload || {});
    A.eq(loopRes.reason, 'already-an-implementation', 'implementing an implementation is refused (no plan→plan→plan recursion)');
    A.ok(loopRes.fired === false, 'and it never spends a run to find that out');

    // 5. a SECOND implement of the same plan does not silently build twice.
    const again = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: planRun }));
    const againRes = ((again.find(e => e.name === 'workshop.implement.result') || {}).payload || {});
    A.eq(againRes.reason, 'already-implemented', 're-implementing the same plan is refused honestly, never a double build');

    // 6. gates.
    const gone = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: 'no-such-run' }));
    A.eq(((gone.find(e => e.name === 'workshop.implement.result') || {}).payload || {}).reason, 'source-gone', 'an unknown deliverable is refused as source-gone');
    A.eq((await post('/api/workshop/implement', { agentId: '../etc', runId: planRun })).status, 400, 'a malformed agentId is refused 400');
    A.eq((await post('/api/workshop/implement', { agentId: 'builder', runId: '' })).status, 400, 'a missing runId is refused 400');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report();
})().catch(e => { console.error(e); process.exit(1); });
