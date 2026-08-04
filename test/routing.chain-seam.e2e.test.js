/* node test/routing.chain-seam.e2e.test.js - real sidecar proof for GET /api/routing/chain.

   This is the ONE seam the browser's COMMS work line runs on (frontend/app/chat.js nextStageOf): the
   in-app turn streams to the browser, so the browser asks the sidecar's router where the dock's output
   goes and drives the hops itself. Until now this route had zero coverage. Boots the actual sidecar and
   proves: the route is behind the per-launch token gate, answers null with no posted floor, names the
   downstream agent once a chained plan deploys, and answers null for a terminal dock / unknown agent. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-chain-seam-'));
  const env = { SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws };
  const { child, port } = await boot(9110 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const chainOf = async (agentId, tag) => {
      const r = await fetch(B + '/api/routing/chain?agentId=' + encodeURIComponent(agentId) + '&tag=' + encodeURIComponent(tag || ''), { headers });
      A.eq(r.status, 200, 'chain seam answers 200 for ' + agentId);
      return (await r.json()).next;
    };

    // ---- 1. the seam is behind the SAME per-launch token gate as every /api route (not TOKEN_EXEMPT) ----
    const bare = await fetch(B + '/api/routing/chain?agentId=research-agent', { headers: { Origin: B } });
    A.eq(bare.status, 403, 'no token -> 403 (the browser seam is token-gated)');

    // ---- 2. no posted floor: every dock is terminal ----
    A.eq(await chainOf('research-agent'), null, 'no routing plan -> next is null');

    // ---- 3. deploy a two-stage line (INTAKE -> research-agent -> writer-agent -> OUTBOX) ----
    const Pipeline = require('../frontend/app/pipeline.js');
    const belt = (x, y, dir) => ({ x, y, dir });
    const plan = Pipeline.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent' },
              { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent' },
              { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
    });
    A.eq(plan.chains['research-agent'].next, ['writer-agent'], 'the drawn floor chains the two docks');
    for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer'];
    const posted = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(plan) });
    A.eq(posted.status, 200, 'the two-stage floor deploys');

    // ---- 4. a dock with a chain edge names its downstream agent; a terminal dock answers null ----
    A.eq(await chainOf('research-agent'), 'writer-agent', 'chained dock -> the downstream agent');
    A.eq(await chainOf('writer-agent'), null, 'terminal dock -> null');
    A.eq(await chainOf('no-such-agent'), null, 'unknown agent -> null');

    // ---- 5. clearing the floor makes every dock terminal again (the browser line honestly stops) ----
    const cleared = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(null) });
    A.eq(cleared.status, 200, 'the floor clears');
    A.eq(await chainOf('research-agent'), null, 'cleared floor -> next is null again');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('routing.chain-seam.e2e.test');
})().catch(e => { console.log('FAIL: routing.chain-seam.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
