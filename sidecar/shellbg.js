/* sidecar/shellbg.js — background / long-running shell processes (H2.2).

   shell.exec is synchronous: it blocks until the command finishes, so the agent literally cannot start a dev
   server (or any long-running process) and keep working. This is the manager behind `shell.exec background:true`
   + the shell.bg.status / shell.bg.kill tools: it spawns a DETACHED child, returns a handle immediately, streams
   output into a bounded ring buffer, and announces a `shell.bg.exit` event when the process ends — even after
   the originating run's stream has closed (the host wires onExit to the durable SSE bus, chanEmit).

   It is a SINGLETON (module-level in index.js), NOT per-run: a backgrounded dev server must survive the run that
   started it so a LATER run can use it. Per-agent concurrency is capped; children are unref'd so they never block
   the sidecar from exiting, and killAll() reaps everything on shutdown / E-STOP.

   Local-first only — same fs jail + cwd as shell.exec; no docker/ssh/modal. PURE deps (spawn/clock/redact/onExit
   injected) so it is headless-testable with a fake spawn and determinism-clean (ms via the injected clock).

     makeShellBg({ spawn, clock?, redact?, onExit?, maxPerAgent?, ringBytes?, isWin? }) ->
       { start({agentId,cmd,cwd,isWin?}), status(agentId,bgId?), kill(agentId,bgId), killAll(agentId?), count(agentId) } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).shellbg = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';

  function killTree(spawn, child, isWin) {
    try { child.kill(); } catch (_) {}
    try {
      if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else if (child.pid) process.kill(child.pid, 'SIGKILL');
    } catch (_) {}
  }

  function makeShellBg(deps) {
    deps = deps || {};
    const spawn = deps.spawn;
    if (typeof spawn !== 'function') throw new Error('shellbg requires an injected spawn');
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : () => 0;
    const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
    const onExit = typeof deps.onExit === 'function' ? deps.onExit : () => {};
    const isWinDefault = (deps.isWin != null) ? deps.isWin : WIN;
    const MAX = deps.maxPerAgent || 5;
    const RING = deps.ringBytes || 16000;
    // persistent PID ledger (procledger.js): killAll() only reaps on a GRACEFUL stop; a force-killed sidecar
    // (desktop shell TerminateProcess) runs no handlers, so recorded children are swept at the NEXT boot.
    const ledger = (deps.ledger && typeof deps.ledger.record === 'function') ? deps.ledger : null;

    const procs = new Map();   // bgId -> rec
    let seq = 0;

    // a KILLED proc frees its cap slot immediately (it's being torn down; its 'close' just hasn't fired yet).
    function count(agentId) { let n = 0; for (const p of procs.values()) if (p.agentId === agentId && p.running && !p.killed) n++; return n; }
    function view(r) {
      return {
        bgId: r.bgId, pid: r.child && r.child.pid || null, cmd: r.cmd, running: r.running, exitCode: r.exitCode, killed: r.killed,
        ms: Math.max(0, (r.endedAt != null ? r.endedAt : now()) - r.startedAt),
        tail: r.out.slice(-2000)
      };
    }

    function start(o) {
      o = o || {};
      const agentId = String(o.agentId || 'agent');
      const cmd = String(o.cmd || '').trim();
      const isWin = (o.isWin != null) ? o.isWin : isWinDefault;
      if (!cmd) return { ok: false, error: 'empty command' };
      if (count(agentId) >= MAX) return { ok: false, error: 'too many background processes (max ' + MAX + ') — kill one with shell.bg.kill first' };
      let child;
      // detached on POSIX so the child leads its own group (clean tree-kill); windowsHide everywhere. unref so a
      // live bg child never keeps the sidecar process alive on its own.
      try { child = spawn(cmd, { cwd: o.cwd, shell: true, windowsHide: true, detached: !isWin }); }
      catch (e) { return { ok: false, error: 'could not start: ' + ((e && e.message) || e) }; }
      try { if (typeof child.unref === 'function') child.unref(); } catch (_) {}
      // record a REDACTED command to the on-disk ledger — a backgrounded command can carry a secret on its argv
      // (e.g. curl -H "Authorization: Bearer …"), and proc-ledger.json persists across sessions. redact() is a
      // no-op for the common secret-free dev-server command, so the PID-reuse token match is unaffected there.
      try { if (ledger && child.pid) ledger.record({ pid: child.pid, cmd: redact(cmd), kind: 'shell.bg' }); } catch (_) {}
      const bgId = 'bg_' + (++seq);
      const rec = { bgId, agentId, cmd, child, out: '', running: true, exitCode: null, killed: false, startedAt: now(), endedAt: null };
      const append = (buf) => { let s = ''; try { s = redact(String(buf)); } catch (_) { s = String(buf); } rec.out += s; if (rec.out.length > RING) rec.out = rec.out.slice(rec.out.length - RING); };
      if (child.stdout && child.stdout.on) child.stdout.on('data', append);
      if (child.stderr && child.stderr.on) child.stderr.on('data', append);
      const settle = (code) => {
        if (!rec.running) return;
        rec.running = false; rec.endedAt = now();
        rec.exitCode = (typeof code === 'number') ? code : -1;
        try { if (ledger && child.pid) ledger.release(child.pid); } catch (_) {}
        try { onExit({ agentId, bgId, exitCode: rec.exitCode, ms: Math.max(0, rec.endedAt - rec.startedAt), killed: rec.killed }); } catch (_) {}
      };
      if (child.on) { child.on('close', settle); child.on('error', () => settle(-1)); }
      procs.set(bgId, rec);
      return { ok: true, bgId, max: MAX };
    }

    function status(agentId, bgId) {
      agentId = String(agentId || 'agent');
      if (bgId) { const r = procs.get(String(bgId)); return (r && r.agentId === agentId) ? view(r) : null; }
      const out = []; for (const r of procs.values()) if (r.agentId === agentId) out.push(view(r));
      return out;
    }

    function kill(agentId, bgId) {
      const r = procs.get(String(bgId));
      if (!r || r.agentId !== String(agentId || 'agent')) return { ok: false, error: 'no such background process' };
      if (!r.running) return { ok: true, alreadyExited: true };
      r.killed = true;
      killTree(spawn, r.child, isWinDefault);
      return { ok: true };
    }

    // reap: an agent's procs (signal abort) or everything (sidecar shutdown / E-STOP).
    function killAll(agentId) {
      let n = 0;
      for (const r of procs.values()) {
        if (agentId != null && r.agentId !== String(agentId)) continue;
        if (r.running && !r.killed) { r.killed = true; killTree(spawn, r.child, isWinDefault); n++; }
      }
      return n;
    }

    return { start, status, kill, killAll, count, _internals: { procs, view, killTree } };
  }

  return { makeShellBg };
});
