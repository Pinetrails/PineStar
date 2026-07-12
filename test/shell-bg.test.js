/* node test/shell-bg.test.js — background shell process manager (H2.2).
   Proves the lifecycle with an injected fake spawn (no real processes): start returns a handle without blocking,
   status reports running + streams output into a bounded tail, a natural close fires shell.bg.exit (via onExit),
   the per-agent cap refuses excess, kill reaps a running child + reports killed on exit, killAll reaps, and
   procs are agent-scoped. Deterministic (injected clock); isWin:true so kill uses taskkill (no real process.kill). */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeShellBg } = require('../sidecar/shellbg.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');

// a fake spawn: each child exposes _emit(data) and _close(code) so the test drives the lifecycle by hand.
function makeFakeSpawn() {
  const spawn = function (cmd, opts) {
    if (cmd === 'taskkill') { spawn.taskkills++; return { pid: 0, on() {}, stdout: { on() {} }, stderr: { on() {} } }; }
    let dataCb = null, closeCb = null, errCb = null;
    const child = {
      cmd, opts, pid: 1000 + spawn.children.length, killed: false, unrefed: false,
      stdout: { on: (ev, fn) => { if (ev === 'data') dataCb = fn; } },
      stderr: { on: () => {} },
      on: (ev, fn) => { if (ev === 'close') closeCb = fn; else if (ev === 'error') errCb = fn; },
      unref: function () { this.unrefed = true; },
      kill: function () { this.killed = true; },
      _emit: (s) => { if (dataCb) dataCb(Buffer.from(String(s))); },
      _close: (code) => { if (closeCb) closeCb(code); },
      _err: () => { if (errCb) errCb(new Error('spawn err')); }
    };
    spawn.children.push(child);
    return child;
  };
  spawn.children = []; spawn.taskkills = 0;
  return spawn;
}

let T = 1000; const clock = { now: () => T };

// ---- start / status / streaming / natural exit ----
{
  const spawn = makeFakeSpawn();
  const exits = [];
  const bg = makeShellBg({ spawn, clock, onExit: (e) => exits.push(e), maxPerAgent: 2, isWin: true });

  T = 1000;
  const s1 = bg.start({ agentId: 'a', cmd: 'npm run dev', cwd: '/ws/a' });
  A.ok(s1.ok && s1.bgId === 'bg_1', 'start returns a handle immediately (non-blocking)');
  A.eq(bg.count('a'), 1, 'one running process');
  A.ok(spawn.children[0].unrefed, 'the child is unref\'d (never blocks sidecar exit)');
  let st = bg.status('a', 'bg_1');
  A.ok(st && st.running && st.exitCode === null, 'status reports running');

  spawn.children[0]._emit('Server listening on :3000\n');
  A.ok(bg.status('a', 'bg_1').tail.indexOf('listening on :3000') >= 0, 'stdout streams into the status tail');

  // cap: a 2nd is fine, a 3rd is refused
  A.ok(bg.start({ agentId: 'a', cmd: 'sleep 99' }).ok, 'second within cap');
  const over = bg.start({ agentId: 'a', cmd: 'sleep 99' });
  A.ok(!over.ok && /too many/.test(over.error), 'over the per-agent cap -> refused');

  // natural exit -> shell.bg.exit
  T = 5200;
  spawn.children[0]._close(0);
  A.eq(exits.length, 1, 'one shell.bg.exit fired on close');
  A.eq(exits[0].bgId, 'bg_1', 'exit names the process'); A.eq(exits[0].exitCode, 0, 'exit code captured');
  A.eq(exits[0].killed, false, 'a natural exit is not "killed"'); A.eq(exits[0].ms, 4200, 'elapsed ms from the injected clock');
  A.ok(!bg.status('a', 'bg_1').running, 'status now reports not-running'); A.eq(bg.count('a'), 1, 'running count drops');
}

// ---- kill reaps a running child and reports killed on its (simulated) close ----
{
  const spawn = makeFakeSpawn();
  const exits = [];
  const bg = makeShellBg({ spawn, clock, onExit: (e) => exits.push(e), maxPerAgent: 5, isWin: true });
  bg.start({ agentId: 'a', cmd: 'sleep 99' });   // bg_1
  const k = bg.kill('a', 'bg_1');
  A.ok(k.ok, 'kill ok'); A.ok(spawn.children[0].killed, 'the child was killed');
  spawn.children[0]._close(137);   // the OS reaps it after the kill
  A.eq(exits[0].killed, true, 'a killed process reports killed:true on exit');
  A.ok(!bg.kill('a', 'nope').ok, 'killing an unknown id -> not ok');
}

// ---- redacted command + exact OS identity pin ----
{
  const spawn = makeFakeSpawn();
  const ledgerCalls = { records: [], pins: [] };
  const ledger = {
    record: (entry) => ledgerCalls.records.push(entry),
    pinIdentity: async (pid) => { ledgerCalls.pins.push(pid); },
    release: () => {}
  };
  const bg = makeShellBg({
    spawn, clock, maxPerAgent: 5, isWin: true, ledger,
    redact: (s) => String(s).replace(/super-secret-value/g, '[REDACTED]')
  });
  bg.start({ agentId: 'secret', cmd: 'curl -H "Authorization: Bearer super-secret-value" http://127.0.0.1' });
  A.eq(ledgerCalls.records.length, 1, 'background child is recorded in the persistent ledger');
  A.ok(ledgerCalls.records[0].cmd.indexOf('super-secret-value') < 0, 'ledger record receives only the redacted command');
  A.eq(ledgerCalls.pins.join(','), String(spawn.children[0].pid), 'background child asks the ledger to pin exact OS identity after spawn');
}

// ---- agent isolation + killAll ----
{
  const spawn = makeFakeSpawn();
  const bg = makeShellBg({ spawn, clock, maxPerAgent: 5, isWin: true });
  bg.start({ agentId: 'a', cmd: 'x' });
  bg.start({ agentId: 'b', cmd: 'y' });
  A.eq(bg.status('a').length, 1, 'agent a sees only its own process');
  A.eq(bg.status('b', bg.status('b')[0].bgId).bgId !== undefined, true, 'agent b sees its own');
  A.eq(bg.status('a', bg.status('b')[0].bgId), null, 'agent a cannot see agent b\'s process by id (isolation)');
  A.eq(bg.killAll('a'), 1, 'killAll(agent) reaps only that agent\'s running procs');
  A.eq(bg.count('a'), 0, 'a has none running'); A.eq(bg.count('b'), 1, 'b untouched');
  A.eq(bg.killAll(), 1, 'killAll() reaps everything remaining');
}

// ---- the shell TOOLS delegate to the manager (background:true + shell.bg.status/kill) ----
(async () => {
  const spawn = makeFakeSpawn();
  const bg = makeShellBg({ spawn, clock, maxPerAgent: 5, isWin: true });
  const fs = { mkdirSync: function () {}, existsSync: function () { return true; } };
  const tools = makeShellTool({ spawn, fs, pathMod: path, root: path.join('root'), clock, bg, platform: 'win32' });
  const ctx = { agentId: 'a' };

  const r = await tools.execTool.run({ cmd: 'npm run dev', background: true }, ctx);
  A.ok(/Started background process bg_/.test(r.content), 'shell.exec background:true starts a bg process via the manager');
  A.eq(bg.count('a'), 1, 'the manager tracks the backgrounded process');

  const st = await tools.bgStatusTool.run({}, ctx);
  A.ok(/RUNNING/.test(st.content) && /bg_1/.test(st.content), 'shell.bg.status lists it running');

  const k = await tools.bgKillTool.run({ id: 'bg_1' }, ctx);
  A.ok(/Killed/.test(k.content), 'shell.bg.kill stops it');
  A.eq(bg.count('a'), 0, 'the slot is freed after kill');

  A.report('shell-bg.test');
})().catch(function (e) { console.error(e); process.exit(1); });
