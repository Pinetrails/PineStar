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

   TWO-WAY, AND READABLE PAST THE TAIL (2026-07-29). For a long time this was start/status/kill only, which
   made a background process write-only in both directions:
     - No STDIN. The agent could start `npm create vite@latest` or a `python` REPL and then had no way to
       answer a single prompt — the process sat wedged until it was killed. write/submit/closeStdin fix that.
     - No PAGING. `status` returned the last 2000 characters of a 16KB ring, so a stack trace 500 lines up
       the log was simply unreachable; the agent's only recourse was to re-run the command in the foreground
       and hope it failed the same way. read() pages and searches by LINE, and says so when the ring has
       dropped output rather than pretending line 1 is the beginning.

     makeShellBg({ spawn, clock?, redact?, onExit?, maxPerAgent?, ringBytes?, isWin? }) ->
       { start({agentId,cmd,cwd,isWin?}), status(agentId,bgId?), read(agentId,bgId,opts?),
         write(agentId,bgId,{input,submit?}), closeStdin(agentId,bgId),
         kill(agentId,bgId), killAll(agentId?), count(agentId) } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).shellbg = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';

  function killTree(spawn, child, isWin) {
    /* On Windows taskkill must see the LIVE root in order to discover `/T` descendants. Killing the shell
       leader first races that discovery: taskkill then reports "process not found" while the command and its
       grandchildren keep running. Let the tree reaper own the first attempt; direct child.kill is only the
       fallback when taskkill itself cannot start or exits unsuccessfully. */
    if (isWin && child.pid) {
      let fellBack = false;
      const fallback = () => {
        if (fellBack) return;
        fellBack = true;
        try { child.kill(); } catch (_) {}
      };
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        if (killer && typeof killer.on === 'function') {
          killer.on('error', fallback);
          killer.on('close', (code) => { if (code !== 0) fallback(); });
        }
        try { if (killer && typeof killer.unref === 'function') killer.unref(); } catch (_) {}
        return;
      } catch (_) {
        fallback();
        return;
      }
    }
    try { child.kill(); } catch (_) {}
    try {
      if (child.pid) process.kill(child.pid, 'SIGKILL');
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
    /* 16KB held about 200 lines of a dev server — the ring lapped before the agent got back to look, so the
       compile error that killed the run had already scrolled off. Paging is worthless over a buffer that
       small, so the ring and the paging landed together. 256KB x 5 procs/agent is a bounded ~1.25MB. */
    const RING = deps.ringBytes || 262144;
    const READ_LINES = deps.readLines || 200;      // default page size; the model can ask for more
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
      try { child = spawn(cmd, { cwd: o.cwd, shell: true, windowsHide: true, detached: !isWin, env: o.env }); }
      catch (e) { return { ok: false, error: 'could not start: ' + ((e && e.message) || e) }; }
      try { if (typeof child.unref === 'function') child.unref(); } catch (_) {}
      // record a REDACTED command to the on-disk ledger — a backgrounded command can carry a secret on its argv
      // (e.g. curl -H "Authorization: Bearer …"), and proc-ledger.json persists across sessions. Exact OS identity
      // below means boot cleanup never needs the plaintext command to recognize this child.
      try {
        if (ledger && child.pid) {
          ledger.record({ pid: child.pid, cmd: redact(cmd), kind: 'shell.bg' });
          // Exact (pid, OS creation time) identity lets boot sweep reap secret-bearing commands without ever
          // persisting their plaintext argv. Best-effort/fail-closed: an unpinned entry falls back to cmd matching.
          if (typeof ledger.pinIdentity === 'function') Promise.resolve(ledger.pinIdentity(child.pid)).catch(() => {});
        }
      } catch (_) {}
      const bgId = 'bg_' + (++seq);
      const rec = { bgId, agentId, cmd, child, out: '', running: true, exitCode: null, killed: false, startedAt: now(), endedAt: null, dropped: 0, stdinClosed: false };
      const append = (buf) => {
        let s = ''; try { s = redact(String(buf)); } catch (_) { s = String(buf); }
        rec.out += s;
        if (rec.out.length > RING) {
          let cut = rec.out.length - RING;
          /* Snap the cut FORWARD to a line boundary. A ring that lands mid-line makes the first line of every
             page a fragment, and a fragment reads as a real line to anything counting them — so line 1 of a
             paged read would be a lie in a way the caller cannot detect. Bounded scan: if the next newline is
             absurdly far (one enormous line), keep the raw cut rather than discarding the whole buffer. */
          const nl = rec.out.indexOf('\n', cut);
          if (nl >= 0 && nl - cut < 4096) cut = nl + 1;
          rec.dropped += cut;
          rec.out = rec.out.slice(cut);
        }
      };
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

    // ownership is the ONE gate on every by-id operation: an agent may only touch a process it started.
    function own(agentId, bgId) {
      const r = procs.get(String(bgId));
      return (r && r.agentId === String(agentId || 'agent')) ? r : null;
    }

    /* PAGED / SEARCHABLE OUTPUT. `offset` is 0-based over the lines currently held; NEGATIVE counts back
       from the end (-50 = the last 50 lines), which is what "show me the end of the log" actually means and
       saves a round trip to learn totalLines first. `grep` filters to matching lines, keeping each line's
       real number so the caller can page around a hit.

       `dropped` is reported, never hidden: once the ring laps, line 1 is NOT the first line the process
       printed, and a reader that assumes otherwise draws wrong conclusions about where a failure began. */
    function read(agentId, bgId, opts) {
      opts = opts || {};
      const r = own(agentId, bgId);
      if (!r) return { ok: false, error: 'no such background process' };
      const all = r.out === '' ? [] : r.out.split('\n');
      // a trailing newline yields a final '' that is not a line the process wrote
      if (all.length && all[all.length - 1] === '') all.pop();

      const limit = Math.max(1, Math.min(2000, Number(opts.limit) || READ_LINES));
      const needle = (opts.grep == null || opts.grep === '') ? null : String(opts.grep).toLowerCase();

      let numbered;
      if (needle) {
        numbered = [];
        for (let i = 0; i < all.length; i++) if (all[i].toLowerCase().indexOf(needle) >= 0) numbered.push([i + 1, all[i]]);
      } else {
        numbered = new Array(all.length);
        for (let i = 0; i < all.length; i++) numbered[i] = [i + 1, all[i]];
      }

      let off = Number(opts.offset);
      if (!Number.isFinite(off)) off = needle ? 0 : Math.max(0, numbered.length - limit);   // no offset -> the END, like tail
      if (off < 0) off = Math.max(0, numbered.length + off);
      if (off > numbered.length) off = numbered.length;
      const page = numbered.slice(off, off + limit);

      return {
        ok: true, bgId: r.bgId, running: r.running, exitCode: r.exitCode, killed: r.killed, cmd: r.cmd,
        lines: page.map(x => x[1]), firstLineNo: page.length ? page[0][0] : 0, lineNos: page.map(x => x[0]),
        offset: off, returned: page.length,
        totalLines: all.length, matchedLines: needle ? numbered.length : null, grep: opts.grep || null,
        droppedBytes: r.dropped, truncatedStart: r.dropped > 0
      };
    }

    /* STDIN. Without this a background process is write-only: an installer that asks one question, or any
       REPL, wedges forever and the only move left is to kill it. `submit` appends the newline, because the
       overwhelmingly common case is answering a prompt and a payload without it just sits in the pipe
       looking like nothing happened. */
    function write(agentId, bgId, o) {
      o = o || {};
      const r = own(agentId, bgId);
      if (!r) return { ok: false, error: 'no such background process' };
      if (!r.running) return { ok: false, error: 'process ' + r.bgId + ' has already exited (' + r.exitCode + ') — nothing is listening on its stdin' };
      if (r.stdinClosed) return { ok: false, error: 'stdin for ' + r.bgId + ' was already closed with eof' };
      const stdin = r.child && r.child.stdin;
      if (!stdin || typeof stdin.write !== 'function') return { ok: false, error: 'this process has no writable stdin' };
      const data = String(o.input == null ? '' : o.input) + (o.submit === false ? '' : '\n');
      try { stdin.write(data); }
      catch (e) { return { ok: false, error: 'write failed: ' + ((e && e.message) || e) }; }
      return { ok: true, bytes: data.length };
    }

    // EOF. Distinct from kill: many commands (a pipe consumer, an interactive prompt reading to EOF) only
    // do their work once stdin CLOSES, so killing them instead of closing destroys the result.
    function closeStdin(agentId, bgId) {
      const r = own(agentId, bgId);
      if (!r) return { ok: false, error: 'no such background process' };
      if (r.stdinClosed) return { ok: true, alreadyClosed: true };
      const stdin = r.child && r.child.stdin;
      if (!stdin || typeof stdin.end !== 'function') return { ok: false, error: 'this process has no writable stdin' };
      try { stdin.end(); } catch (e) { return { ok: false, error: 'close failed: ' + ((e && e.message) || e) }; }
      r.stdinClosed = true;
      return { ok: true };
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

    return { start, status, read, write, closeStdin, kill, killAll, count, _internals: { procs, view, killTree, own } };
  }

  return { makeShellBg };
});
