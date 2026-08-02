/* node test/questrefresh.e2e.test.js — TRUE end-to-end proof of the QUEST REFRESH orchestration (QUEST V3).

   questrefresh.test.js proves the pure gates/parse; this suite boots the REAL sidecar with a mock OpenRouter
   and asserts the whole ambient chain in sidecar/index.js: boot catch-up tick → decide (never-cycled = due)
   → the ONE aux model call → parse → questStore.mint → the quests visible at GET /api/quests + the north
   star + attempt ledger at GET /api/quests/refresh + the durable files on disk.

   BOOT 1 — THE HAPPY CHAIN: a never-refreshed save with a dossier + active goal boots; the due cycle fires
     off the boot look, the mock's grounded QUEST reply mints station-wide generated quests with real
     contracts, the north star adopts the Commander's ACTIVE GOAL (user-set outranks inferred), and both
     `_station.quests.json` and `_station.questrefresh.json` persist.

   BOOT 2 — THE HONEST-FAILURE CHAIN: a well-formed reply whose WHY cites nothing observed is rejected by
     the grounding guard — ZERO quests minted, a visible 'rejected' ledger note (never a silent no-mint),
     and the cycle still spends the cadence (no tick-hammering).

   ZERO network, zero real key (SKYNET_OPENROUTER_KEY is a fake routed to the mock). Part of test:http. */
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- the mock OpenRouter: the quest-master system marker routes to the canned refresh reply ---- */
function startMock(refreshReply) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const text = t => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }) + '\n\n');
            res.write('data: [DONE]\n\n'); res.end();
          };
          if (body.indexOf('quest master') >= 0) text(refreshReply);   // runQuestRefreshCycle's system marker
          else text('ok, done.');
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
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

// seed the evidence the directive shows the model: a dossier + the Commander's ACTIVE goal arc.
function seedEvidence(ws) {
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, '_commander.dossier.json'), JSON.stringify({
    block: 'COMMANDER DOSSIER\n- Goals: grow the youtube channel to sustainable income\n- Stack: davinci resolve, notion'
  }));
  fs.writeFileSync(path.join(ws, '_commander.goals.json'), JSON.stringify({
    goal: { text: 'Grow the channel to 10k subs', done: 1, total: 4, pct: 25, next: 'publish episode 3' }
  }));
}

async function pollRefresh(B, token, pred, label, ms) {
  const until = Date.now() + (ms || 20000);
  let last = null;
  while (Date.now() < until) {
    try { last = await (await fetch(B + '/api/quests/refresh', { headers: { 'X-StarNet-Token': token, Origin: B } })).json(); } catch (_) {}
    if (last && pred(last)) return last;
    await sleep(300);
  }
  throw new Error('timed out waiting for: ' + label + '\nlast /api/quests/refresh: ' + JSON.stringify(last));
}

const QUIET = { SKYNET_THREAD_MINE: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_SCOUT: '0' };
// the cycle's standalone provider seam: env key + default model route the aux call to the mock.
const CRED = { SKYNET_OPENROUTER_KEY: 'sk-or-v1-questrefresh-fake', SKYNET_DEFAULT_MODEL: 'test/model' };

(async () => {
  /* ================= BOOT 1 — the happy chain ================= */
  {
    const mock = await startMock([
      'NORTH_STAR: Grow the channel to sustainable income',
      'QUEST: Publish episode 3',
      'DESC: Finish the edit and get episode 3 live.',
      'REWARD: a published episode moving the channel forward',
      'CONTRACT: attest',
      'STEPS: final cut; thumbnail; upload',
      'WHY: your active goal names publish episode 3 as the next step',
      'QUEST: Put guest research on tap',
      'DESC: Bring the web dish online so an agent compiles guest research for every episode.',
      'REWARD: research on tap for every episode',
      'CONTRACT: prop dish',
      'WHY: growing the youtube channel needs recurring guest research'
    ].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    seedEvidence(ws);   // NO _station.questrefresh.json: a never-cycled state is due at the boot look
    const { child, port } = await boot(8985 + (process.pid % 10), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);

      // the boot look fires the due cycle; poll the STATUS route until the mints land in its ledger.
      const st = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'minted'),
        'the boot-look refresh cycle minting quests');
      A.ok(true, 'ORCHESTRATION: a due refresh fired off the boot look and minted end-to-end');
      A.ok(st.northStar && st.northStar.text === 'Grow the channel to 10k subs', 'the north star is the Commander\'s ACTIVE GOAL (user-set outranks the model line)');
      A.eq(st.northStar.source, 'goal', 'the star carries source:goal');
      A.ok(st.lastCycleAt > 0, 'the cycle spent the cadence (lastCycleAt stamped)');
      A.eq(st.ledger.filter(e => e.outcome === 'minted').length, 2, 'both grounded quests minted');

      // the quests are REAL ledger quests (GET /api/quests), station-wide, contract-carrying.
      const q = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      const minted = (q.quests || []).filter(x => x.createdBy === 'system:quest-refresh');
      A.eq(minted.length, 2, 'GET /api/quests serves the two minted quests');
      const ep = minted.find(x => x.title === 'Publish episode 3');
      A.ok(ep && ep.contract.type === 'attest' && ep.agentId === null && ep.kind === 'generated', 'attest quest: station-wide, kind generated');
      A.eq(ep.steps.map(s => s.label), ['final cut', 'thumbnail', 'upload'], 'steps rode through the store');
      const dish = minted.find(x => x.title === 'Put guest research on tap');
      A.ok(dish && dish.contract.type === 'prop' && dish.contract.key === 'dish', 'prop quest carries the placeable contract key');
      A.ok(ep.groundedIn && ep.groundedIn.indexOf('episode 3') >= 0, 'groundedIn cites the real evidence');

      // durable truth on disk (restart-safety is the point of the harness-owned ledger).
      const onDiskQuests = JSON.parse(fs.readFileSync(path.join(ws, '_station.quests.json'), 'utf8'));
      A.ok(JSON.stringify(onDiskQuests).indexOf('Publish episode 3') >= 0, '_station.quests.json persisted the mint');
      const onDiskState = JSON.parse(fs.readFileSync(path.join(ws, '_station.questrefresh.json'), 'utf8'));
      A.ok(onDiskState.state && onDiskState.state.northStar && onDiskState.state.northStar.source === 'goal', '_station.questrefresh.json persisted the north star');

      // MANUAL OVERRIDE: POST /refresh/run fires a real cycle NOW (gates bypassed). The mock replays the
      // same two quests — both titles are now OPEN, so the parse dedup drops them and the cycle records an
      // honest 'rejected' (proving the route ran a full real cycle, and dup-mint spam is impossible).
      const runRes = await (await fetch(B + '/api/quests/refresh/run', { method: 'POST', headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.ok(runRes.ok && runRes.started, 'the manual refresh route launches a cycle');
      const st2 = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'rejected'),
        'the manual cycle deduping the replayed quests');
      A.eq(st2.ledger.filter(e => e.outcome === 'minted').length, 2, 'the manual re-run minted NOTHING new (dedup held)');
      const q2 = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq((q2.quests || []).filter(x => x.createdBy === 'system:quest-refresh').length, 2, 'still exactly two quests on the ledger');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ================= BOOT 2 — the honest-failure chain (anti-silent-no-mint) ================= */
  {
    const mock = await startMock([
      'NORTH_STAR: Achieve maximum synergy',
      'QUEST: Embrace the grindset',
      'DESC: A quest citing nothing the station observed.',
      'REWARD: vibes',
      'CONTRACT: attest',
      'WHY: hustle culture demands relentless morning routines'   // ungroundable: cites nothing real
    ].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    seedEvidence(ws);
    const { child, port } = await boot(8995 + (process.pid % 10), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      const st = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'rejected'),
        "a visible 'rejected' ledger note for the ungrounded reply");
      A.ok(true, 'HONEST FAILURE: the ungrounded reply was rejected AND the ledger says so');
      A.ok(!(st.ledger || []).some(e => e.outcome === 'minted'), 'nothing minted from the invented pitch');
      A.ok(st.lastCycleAt > 0, 'the failed attempt still spent the cadence (no tick-hammering)');
      const q = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq((q.quests || []).filter(x => x.createdBy === 'system:quest-refresh').length, 0, 'the quest ledger stayed clean');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ================= BOOT 3 — the cold-save guard (no evidence → no model call, honest skip) ================= */
  {
    const mock = await startMock('NORTH_STAR: should never be requested');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    // NO dossier, NO goal, NO activity: the due boot-look cycle must SKIP before spending the model call.
    const { child, port } = await boot(9005 + (process.pid % 10), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      const st = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'skipped' && /not enough is known/.test(e.reason)),
        "the cold-save 'skipped' ledger note");
      A.ok(true, 'COLD SAVE: the due cycle skipped honestly instead of paying to guess');
      A.ok(!(st.ledger || []).some(e => e.outcome === 'minted' || e.outcome === 'rejected'), 'no model round-trip happened on the cold save');
      A.ok(!st.northStar, 'no invented north star on a cold save');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ================= BOOT 4 — the SLATE-FULL fast path (cost + honesty, QUEST V3 slice 2) ================= */
  {
    // the model must NEVER be called: if it were, this reply would mint. The skip happens before the call.
    const mock = await startMock(['NORTH_STAR: should never be requested', 'QUEST: Should never mint', 'CONTRACT: attest', 'WHY: grow the youtube channel'].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    seedEvidence(ws);   // full evidence — proving the skip is the SLATE-FULL guard, not the cold-save guard
    // seed the store already at the cap: 3 OPEN station-wide (agentId:null) generated quests.
    fs.writeFileSync(path.join(ws, '_station.quests.json'), JSON.stringify({ v: 1, seq: 3, quests: [1, 2, 3].map(i => ({
      id: 'q:' + i, title: 'Seeded generated ' + i, kind: 'generated', agentId: null, createdBy: 'system:quest-refresh',
      contract: { type: 'attest', key: '' }, status: 'open', createdAt: 1
    })) }));
    const { child, port } = await boot(9015 + (process.pid % 10), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      const st = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'skipped' && /slate full/i.test(e.reason)),
        "the slate-full 'skipped' ledger note");
      A.ok(true, 'SLATE FULL: a cycle at the open-generated cap skipped honestly instead of paying for foredoomed mints');
      A.ok(!(st.ledger || []).some(e => e.outcome === 'minted' || e.outcome === 'rejected'), 'no model round-trip happened at the cap (no minted/rejected trail)');
      A.eq(st.openCount, 3, 'the three seeded generated quests are the open slate');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ============ BOOT 5 — north-star PROPOSE-AND-CONFIRM from inference (QUEST V3 slice 3) ============ */
  {
    const STAR = 'Become a full-time independent creator';
    const mock = await startMock([
      'NORTH_STAR: ' + STAR,
      'QUEST: Storyboard the next series',
      'DESC: Plan the arc of the next three episodes.',
      'REWARD: a clear production runway',
      'CONTRACT: attest',
      'WHY: growing the youtube channel needs a planned series'
    ].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    // dossier ONLY — NO goal file, so the north star comes from INFERENCE (the propose-and-confirm path).
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, '_commander.dossier.json'), JSON.stringify({
      block: 'COMMANDER DOSSIER\n- Goals: grow the youtube channel to sustainable income\n- Stack: davinci resolve, notion'
    }));
    const { child, port } = await boot(9025 + (process.pid % 10), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    const post = (body) => fetch(B + '/api/quests/refresh/northstar', { method: 'POST', headers: { 'X-StarNet-Token': token, Origin: B, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    let token;
    try {
      token = await bootToken(B, B);
      const st = await pollRefresh(B, token,
        p => p.northStar && p.northStar.text === STAR,
        'the inferred north star surfacing as a proposal');
      // NOT silently adopted: it's a PROPOSAL awaiting the Commander's verdict (truthful telemetry).
      A.eq(st.northStar.source, 'model', 'the inferred star carries source:model');
      A.eq(st.northStar.status, 'proposed', 'an inference is labelled unconfirmed, never silently adopted');
      A.eq(st.northStarProposed, true, 'the status route flags a pending north-star proposal');
      // The model's inferred direction is not authority to create work. Its quest batch is durable but staged;
      // only the Commander's confirm may turn it into the open quest ledger.
      A.ok((st.ledger || []).some(e => e.outcome === 'staged'), 'quests inferred under the proposal remain staged');
      A.eq(st.pendingQuestCount, 1, 'status exposes the pending quest count without claiming an open quest');
      const beforeQuests = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq((beforeQuests.quests || []).filter(x => x.createdBy === 'system:quest-refresh').length, 0, 'no quest mints before direction confirmation');
      // on-disk: the proposal is durable, the adopted star is still empty (nothing silently persisted as adopted).
      const disk = JSON.parse(fs.readFileSync(path.join(ws, '_station.questrefresh.json'), 'utf8')).state;
      A.ok(disk.proposedNorthStar && disk.proposedNorthStar.text === STAR, 'the proposal persisted to disk');
      A.ok(!disk.northStar, 'nothing was silently adopted');

      // CONFIRM → the proposal becomes the adopted star.
      const cRes = await post({ decision: 'confirm' });
      A.ok(cRes.ok && cRes.applied, 'the confirm verdict applied');
      A.eq(cRes.minted, 1, 'confirm mints the staged quest batch');
      A.eq(cRes.northStarProposed, false, 'after confirm no proposal is pending');
      const after = await (await fetch(B + '/api/quests/refresh', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq(after.northStar.status, 'adopted', 'the confirmed star reads adopted');
      A.eq(after.northStar.text, STAR, 'the adopted star is the one the Commander confirmed');
      A.eq(after.northStarProposed, false, 'no proposal pending after confirm');
      A.eq(after.pendingQuestCount, 0, 'the staged quest batch clears after confirm');
      const afterQuests = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq((afterQuests.quests || []).filter(x => x.createdBy === 'system:quest-refresh').length, 1, 'the quest becomes open only after confirmation');
      const disk2 = JSON.parse(fs.readFileSync(path.join(ws, '_station.questrefresh.json'), 'utf8')).state;
      A.ok(disk2.northStar && disk2.northStar.text === STAR && !disk2.proposedNorthStar, 'confirm persisted the adoption + cleared the proposal');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ===== BOOT 6 — the SHARED DECLINED INDEX cross-wire: a decline in ANOTHER engine suppresses a quest re-propose ===== */
  {
    // the mock proposes TWO grounded quests. One title ("Publish episode 3") was DECLINED as a thread in a DIFFERENT
    // engine (seeded threads.json below); the shared declined index must suppress ONLY it, letting the other mint.
    const mock = await startMock([
      'NORTH_STAR: Grow the channel to sustainable income',
      'QUEST: Publish episode 3',
      'DESC: Finish the edit and get episode 3 live.',
      'REWARD: a published episode moving the channel forward',
      'CONTRACT: attest',
      'WHY: your active goal names publish episode 3 as the next step',
      'QUEST: Put guest research on tap',
      'DESC: Bring the web dish online so an agent compiles guest research for every episode.',
      'REWARD: research on tap for every episode',
      'CONTRACT: prop dish',
      'WHY: growing the youtube channel needs recurring guest research'
    ].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    seedEvidence(ws);
    // the CROSS-ENGINE decline: "Publish episode 3" is a DECLINED thread (a different engine's store). The quest
    // refresher never consults threads for dedup on its own — only the shared declined index bridges them.
    fs.writeFileSync(path.join(ws, 'threads.json'), JSON.stringify({
      threads: [{ id: 't:1', title: 'Publish episode 3', spec: '', state: 'declined', declineReason: 'not now', createdAt: 1, updatedAt: 1 }],
      declined: []
    }));
    const { child, port } = await boot(9035 + (process.pid % 10), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      // wait for the cycle to settle: at least one mint landed (the non-declined quest).
      const st = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'minted'),
        'the cross-wire cycle minting the non-declined quest');
      A.ok((st.ledger || []).some(e => e.outcome === 'rejected' && /declined elsewhere/i.test(e.reason) && e.title === 'Publish episode 3'),
        "CROSS-WIRE: the quest whose title was declined as a thread is rejected 'declined elsewhere'");
      A.eq(st.ledger.filter(e => e.outcome === 'minted').length, 1, 'exactly one quest minted (the cross-engine decline suppressed the other)');
      const q = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      const minted = (q.quests || []).filter(x => x.createdBy === 'system:quest-refresh');
      A.eq(minted.length, 1, 'GET /api/quests serves only the non-declined quest');
      A.ok(minted.some(x => x.title === 'Put guest research on tap'), 'the non-declined quest minted');
      A.ok(!minted.some(x => x.title === 'Publish episode 3'), 'the thread-declined quest was never minted');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  A.report('questrefresh.e2e.test');
})().catch(e => { console.log('FAIL: questrefresh.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
