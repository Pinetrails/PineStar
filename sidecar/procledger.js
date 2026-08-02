/* sidecar/procledger.js — persistent ledger of agent-spawned OS processes (mouse-confinement incident, 2026-07-12).

   gracefulShutdown reaps children on SIGINT/SIGTERM — but a FORCE-kill (desktop shell dying, TerminateProcess,
   crash) runs no handlers, and detached/unref'd children (dev servers, CDP browsers) orphan silently. The
   2026-07-12 incident: a smoke-test Edge + vite outlived StarNet entirely, kept playing game audio, and the
   game's cursor confinement was left stuck on the user's desktop.

   This ledger closes the gap ACROSS process death: every long-lived child is recorded to a JSON file the moment
   it spawns and released when it exits. On the NEXT sidecar boot, sweep() reads what the previous life left
   behind, re-probes each PID, and uses exact (PID, OS creation-time) identity wherever the OS probe supplies it.
   Unpinned/legacy entries fall back to command matching; a recycled PID is dropped, never killed.

   PURE deps (fs/clock/probe/kill injected) so it is headless-testable; real win32/posix probes are built from
   an injected execFile only when not supplied.

     makeProcLedger({ fs, pathMod, file, clock, isWin?, execFile?, probe?, killTree?, log? }) ->
       { record({pid,cmd,kind?}), pinIdentity(pid), release(pid), sweep() -> Promise<summary>, list(), _internals } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).procledger = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';
  const MAX_ENTRIES = 100;

  // normalize for the reuse-guard match: collapse whitespace, strip quoting, lowercase.
  function normCmd(s) { return String(s == null ? '' : s).replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  // A recycled PID must not be killed: every token of the recorded command must still appear in the live
  // command line. Token-wise (not one containment) because spawn argv reorders around what we record —
  // a shell:true child runs as `cmd.exe /d /s /c "<recorded cmd>"` (tokens stay adjacent), while a browser
  // records `exePath --user-data-dir=<unique>` whose two tokens are separated by other flags. The unique
  // token (profile dir, workspace path) is what makes PID reuse by an unrelated same-exe process not match.
  function cmdMatches(recordedCmd, liveCmdline) {
    const tokens = normCmd(recordedCmd).split(' ').filter(Boolean).slice(0, 8);
    if (!tokens.length) return false;
    const live = normCmd(liveCmdline);
    return tokens.every(t => live.indexOf(t) >= 0);
  }

  // A probe returns Map<pid, { cmd, created }> — created is the process's start time in epoch ms (null if the
  // platform can't report it). created is the SECOND half of the PID-reuse guard: even if a recycled PID's
  // command line coincidentally matches, a process created AFTER we recorded the entry is provably not ours.
  function makeWin32Probe(execFile) {
    return (pids) => new Promise((resolve) => {
      if (!pids.length) return resolve(new Map());
      const filter = pids.map(p => 'ProcessId=' + Number(p)).join(' OR ');
      // CreationDate → epoch ms so the sweep can compare it to the recorded startedAt (also epoch ms).
      const script = 'Get-CimInstance Win32_Process -Filter "' + filter + '" | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; CommandLine = $_.CommandLine; CreatedMs = [int64]([datetimeoffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress';
      const exe = process.env.SystemRoot ? process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe';
      execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout) => {
        const out = new Map();
        if (err) return resolve(out);   // probe failure -> nothing matches -> nothing killed (safe default)
        try {
          let rows = JSON.parse(String(stdout || '').trim() || '[]');
          if (!Array.isArray(rows)) rows = [rows];
          for (const r of rows) if (r && r.ProcessId != null) out.set(Number(r.ProcessId), { cmd: String(r.CommandLine || ''), created: Number(r.CreatedMs) || null });
        } catch (_) {}
        resolve(out);
      });
    });
  }
  function makePosixProbe(execFile) {
    return (pids) => new Promise((resolve) => {
      if (!pids.length) return resolve(new Map());
      execFile('ps', ['-o', 'pid=,command=', '-p', pids.map(Number).join(',')], { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
        const out = new Map();
        if (err) return resolve(out);
        for (const line of String(stdout || '').split('\n')) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (m) out.set(Number(m[1]), { cmd: m[2], created: null });   // posix start-time parsing is fiddly; fall back to cmd-match only
        }
        resolve(out);
      });
    });
  }
  function makeKillTree(execFile, isWin) {
    return (pid) => new Promise((resolve) => {
      if (isWin) {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, () => resolve());
      } else {
        try { process.kill(-Number(pid), 'SIGKILL'); } catch (_) { try { process.kill(Number(pid), 'SIGKILL'); } catch (_) {} }
        resolve();
      }
    });
  }

  function makeProcLedger(deps) {
    deps = deps || {};
    const fs = deps.fs;
    const P = deps.pathMod;
    const file = deps.file;
    if (!fs || !P || !file) throw new Error('procledger requires fs, pathMod, file');
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : () => 0;
    const isWin = (deps.isWin != null) ? deps.isWin : WIN;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const execFile = deps.execFile || ((typeof require === 'function') ? require('node:child_process').execFile : null);
    const probe = deps.probe || (isWin ? makeWin32Probe(execFile) : makePosixProbe(execFile));
    const killTree = deps.killTree || makeKillTree(execFile, isWin);

    let live = [];    // entries recorded by THIS process life
    let stale = [];   // entries a previous life left behind (consumed by sweep)
    const pinning = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      stale = (raw && Array.isArray(raw.procs) ? raw.procs : []).filter(r => r && Number(r.pid) > 0 && r.cmd);
    } catch (_) { stale = []; }

    function save() {
      try {
        fs.mkdirSync(P.dirname(file), { recursive: true });
        const tmp = file + '.' + (typeof process !== 'undefined' ? process.pid : 'p') + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ procs: stale.concat(live) }));
        fs.renameSync(tmp, file);
      } catch (_) {}
    }

    function record(o) {
      o = o || {};
      const pid = Number(o.pid);
      if (!(pid > 0)) return null;
      // cmd may already be redacted by the caller. Plaintext argv is not durable identity: pinIdentity() records
      // the kernel-reported creation time after spawn, making (pid, created) the exact identity instead.
      const entry = { pid, cmd: String(o.cmd || '').slice(0, 400), kind: String(o.kind || 'proc'), startedAt: now(), created: null };
      live = live.filter(r => r.pid !== pid).concat([entry]).slice(-MAX_ENTRIES);
      save();
      // All callers (including browser children) get exact identity. Callers may also await pinIdentity(pid);
      // concurrent requests dedupe onto the same probe below.
      Promise.resolve(pinIdentity(pid)).catch(() => {});
      return entry;
    }

    // Pin the exact OS identity after spawn without persisting the real command line (which can contain secrets).
    // Failure is deliberately safe: the entry remains unpinned and sweep() falls back to the legacy cmd guard.
    async function pinIdentity(pid) {
      pid = Number(pid);
      const entry = live.find(r => r.pid === pid);
      if (!entry) return null;
      if (Number(entry.created) > 0) return Number(entry.created);
      if (pinning.has(pid)) return pinning.get(pid);
      const work = (async () => {
        let alive;
        try { alive = await probe([pid]); } catch (_) { return null; }
        const info = alive && alive.get ? alive.get(pid) : null;
        const created = (info && typeof info === 'object') ? Number(info.created) : NaN;
        if (!(created > 0) || live.indexOf(entry) < 0) return null;
        // record() runs after spawn. A later creation time means the PID already recycled during the probe.
        if (Number(entry.startedAt) > 0 && created > Number(entry.startedAt)) return null;
        entry.created = created;
        save();
        return created;
      })();
      pinning.set(pid, work);
      try { return await work; } finally { if (pinning.get(pid) === work) pinning.delete(pid); }
    }

    function release(pid) {
      pid = Number(pid);
      const before = live.length + stale.length;
      live = live.filter(r => r.pid !== pid);
      stale = stale.filter(r => r.pid !== pid);
      if (live.length + stale.length !== before) save();
    }

    // Boot-time orphan sweep: reap what the previous sidecar life spawned and could not reap because it was
    // force-killed. Only kills a PID whose live command line still matches the recorded command.
    async function sweep() {
      const entries = stale.slice();
      const summary = { examined: entries.length, killed: 0, reused: 0, gone: 0, probeFailed: false };
      if (!entries.length) { save(); return summary; }
      let alive;
      try { alive = await probe(entries.map(r => r.pid)); }
      catch (e) {
        // A failed OS probe proves NOTHING about liveness. Keep every prior-life receipt intact so the next boot
        // can retry; treating an empty fallback map as "all gone" permanently orphaned owned children.
        summary.probeFailed = true;
        log('[proc-ledger] boot sweep probe failed — retained ' + entries.length + ' ownership receipt(s) for retry (' + ((e && e.message) || e) + ')');
        return summary;
      }
      stale = [];
      for (const r of entries) {
        const info = alive.get(Number(r.pid));
        if (info == null) { summary.gone++; continue; }
        // tolerate both probe shapes: the string form (older/injected probes) and the {cmd, created} form.
        const liveCmd = (typeof info === 'string') ? info : (info && info.cmd) || '';
        const created = (info && typeof info === 'object') ? info.created : null;
        const pinnedCreated = Number(r.created);
        if (pinnedCreated > 0) {
          // Exact identity wins over argv: the stored command may be redacted. Missing or +1ms-different creation
          // time is a recycled/uncertain PID and is NEVER killed.
          if (!(Number(created) > 0) || Number(created) !== pinnedCreated) { summary.reused++; continue; }
        } else {
          if (!cmdMatches(r.cmd, liveCmd)) { summary.reused++; continue; }   // legacy/unpinned entry
          // record() happens after spawn, so even 1ms newer than startedAt is not our original child.
          if (created != null && Number(r.startedAt) > 0 && Number(created) > Number(r.startedAt)) { summary.reused++; continue; }
        }
        try { await killTree(r.pid); summary.killed++; log('[proc-ledger] reaped orphan ' + r.kind + ' pid=' + r.pid + ' (' + String(r.cmd).slice(0, 80) + ')'); } catch (_) {}
      }
      save();
      return summary;
    }

    function list() { return stale.concat(live).map(r => Object.assign({}, r)); }

    return { record, pinIdentity, release, sweep, list, _internals: { save, cmdMatches, normCmd } };
  }

  return { makeProcLedger, _internals: { normCmd, cmdMatches, makeWin32Probe, makePosixProbe, makeKillTree } };
});
