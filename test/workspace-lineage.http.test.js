/* node test/workspace-lineage.http.test.js — real host reports legacy state with an empty active save. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const TOKEN = 'workspace-lineage-http-token-32bytes';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}
function waitFor(fn, ms) {
  return new Promise((resolve, reject) => {
    const start = Date.now(); const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('sidecar boot timeout'));
      setTimeout(tick, 25);
    }; tick();
  });
}

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-lineage-http-'));
  const appData = path.join(sandbox, 'appdata');
  const current = path.join(appData, 'ai.skynet.harness', 'workspaces');
  const legacy = path.join(appData, 'StarNet', 'workspaces');
  fs.mkdirSync(current, { recursive: true }); fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'agent.save.json'), JSON.stringify({ version: 5, updatedAt: 77, agent: { id: 'agent', name: 'Prior' } }));
  const port = await freePort();
  const child = spawn(process.execPath, [INDEX], {
    env: Object.assign({}, process.env, {
      LOCALAPPDATA: appData, APPDATA: appData,
      SKYNET_WORKSPACES: current, SKYNET_PORT: String(port), SKYNET_API_TOKEN: TOKEN,
      SKYNET_LIVE_PRICES: '0', SKYNET_QUEST_REFRESH: '0', SKYNET_CRON: '0',
      SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: ''
    }), stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  try {
    await waitFor(() => output.includes('http://127.0.0.1:' + port), 20000);
    const r = await fetch('http://127.0.0.1:' + port + '/api/save?agent=agent', { headers: { 'X-StarNet-Token': TOKEN } });
    const body = await r.json();
    A.eq(r.status, 200, 'real save route answers');
    A.eq(body.save, null, 'active workspace is definitively empty');
    A.eq(body.lineage && body.lineage.priorInstallEvidence, true, 'host still proves a prior installation');
    A.eq(body.lineage && body.lineage.onboardingAllowed, false, 'host explicitly refuses the genesis inference');
    A.eq(body.lineage.evidence.some(x => x.kind === 'legacy-workspace'), true, 'receipt identifies the legacy workspace evidence');
    A.report('workspace-lineage.http.test');
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
    await new Promise(resolve => { if (child.exitCode != null || child.signalCode != null) resolve(); else child.once('exit', resolve); });
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
