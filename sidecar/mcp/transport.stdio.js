/* sidecar/mcp/transport.stdio.js — the MCP STDIO client transport (the local-process I/O edge).
   Spawns a local MCP server child (e.g. `npx @modelcontextprotocol/server-filesystem`) and speaks
   JSON-RPC 2.0 over its stdio, framed as NEWLINE-DELIMITED JSON — ONE message per line (the MCP stdio
   transport framing; it is NOT the LSP Content-Length header framing the HTTP/SSE edge uses). It exposes
   the SAME { send, onMessage, close } duplex contract as transport.http.js, so client.js / translate.js /
   manager.js are reused VERBATIM — only the byte-edge differs.

   makeStdioTransport({ spawn, command, args?, env?, cwd?, isAllowed?, isWin?, killSpawn?, processKill?,
                        onError? }) -> transport
     transport = { send(message)->Promise, onMessage(cb), close() }

   SECURITY — a stdio server runs an ARBITRARY local command, so this transport carries TWO guards the HTTP
   edge does not need (the HTTP edge only POSTs to a Commander-typed URL):
     1. The connector capability + consent gate still apply at dispatch (translate.js / registry), AND the
        host only constructs a stdio transport for a connector the Commander explicitly placed + enabled.
     2. A spawn-time command ALLOWLIST (isAllowed) — node / npx / npmx / uvx / pnpm-dlx etc. — with an
        npx-AWARE package-spec parser: it REJECTS `--package`/`-p`/`--registry`, a URL/tarball/git spec, and
        default-denies unknown flags, so `npx --package evil <spec>` can NOT smuggle an arbitrary package.
        A blocked command NEVER spawns: the transport enters a permanently-failed state and every send fails.

   DETERMINISM: spawn is INJECTED (so the framing/lifecycle/allowlist are unit-testable with a fake child and
   the determinism lint stays green — no Date.now/Math.random here); the request TIMEOUT lives in client.js
   (injected setTimeout), never here. processKill/killSpawn are injected so tree-kill is testable too. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.mcp = root.SK.mcp || {}).transportStdio = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const JSONRPC = '2.0';
  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';

  // ---- command allowlist (the default isAllowed) -------------------------------------------------------
  // Only well-known package-runner / interpreter binaries may host an MCP server. Bare binary name only
  // (no path) so a "node" allow can't be subverted by "/evil/node". An npx-family runner additionally goes
  // through the npx-aware spec parser below.
  const ALLOWED_BASE = new Set(['node', 'npx', 'npm', 'pnpm', 'pnpx', 'bun', 'bunx', 'deno', 'uv', 'uvx', 'python', 'python3']);
  const NPX_FAMILY = new Set(['npx', 'pnpx', 'bunx', 'uvx']);

  // strip a Windows .cmd/.exe/.bat suffix and any directory, lowercase — to compare against the allowlist by
  // BASE name. We reject anything with a path separator outright (must be a bare command resolved off PATH).
  function baseName(command) {
    const c = String(command || '');
    if (/[\\/]/.test(c)) return null;                 // a pathed command is not an allowlisted bare runner
    return c.replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
  }

  // npx-AWARE arg validation. npx flags that change WHICH package executes are the injection surface:
  //   -p / --package   pick an arbitrary package to install+run regardless of the positional spec
  //   --registry / --userconfig / -c / --call / --node-arg etc. — config/exec surface
  // We DEFAULT-DENY unknown flags and only allow a small benign set (-y/--yes, -q/--quiet, --no-install).
  // The positional package spec must be a plain registry name (optionally scoped, optionally @version),
  // NEVER a URL / tarball / git / file spec (those let npx fetch+run arbitrary code).
  const NPX_BENIGN_FLAGS = new Set(['-y', '--yes', '-q', '--quiet', '--no-install', '--prefer-offline', '--prefer-online']);
  // a safe package spec: optional @scope/, name, optional @version — registry names only. No ://, no path,
  // no .tgz, no git+, no leading . or / (file spec), no '#' (git ref).
  const SAFE_PKG_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.\-+*]+)?$/i;

  function npxSpecOk(args) {
    const a = Array.isArray(args) ? args.slice() : [];
    let sawPackageSpec = false;
    for (let i = 0; i < a.length; i++) {
      const tok = String(a[i]);
      if (tok === '--') { /* end of npx flags; everything after is the program's own argv */ for (let j = i + 1; j < a.length; j++) { if (!sawPackageSpec) { if (!SAFE_PKG_SPEC.test(String(a[j]))) return false; sawPackageSpec = true; } } return sawPackageSpec; }
      if (tok.charAt(0) === '-') {
        // a flag. The injection flags are rejected by name; any unknown flag is DEFAULT-DENIED.
        if (tok === '-p' || tok === '--package' || tok.indexOf('--package=') === 0 || tok.indexOf('-p=') === 0) return false;
        if (tok === '--registry' || tok.indexOf('--registry=') === 0) return false;
        if (tok === '-c' || tok === '--call' || tok === '--userconfig' || tok.indexOf('--userconfig=') === 0) return false;
        if (tok === '--node-arg' || tok.indexOf('--node-arg=') === 0 || tok === '--node-options' || tok.indexOf('--node-options=') === 0) return false;
        if (NPX_BENIGN_FLAGS.has(tok)) continue;
        return false;   // default-deny any unrecognized flag
      }
      // a positional: the FIRST positional is the package spec and must be a safe registry name.
      if (!sawPackageSpec) {
        if (!SAFE_PKG_SPEC.test(tok)) return false;   // URL / tarball / git / file spec -> reject
        sawPackageSpec = true;
      }
      // later positionals are the server's own args — passed through (the jail/consent gate the server).
    }
    return sawPackageSpec;   // must name exactly one safe package
  }

  // the default allowlist predicate: { ok:true } | { ok:false, reason }
  function defaultIsAllowed(command, args) {
    const base = baseName(command);
    if (!base || !ALLOWED_BASE.has(base)) return { ok: false, reason: 'command "' + command + '" is not on the MCP stdio allowlist' };
    if (NPX_FAMILY.has(base) && !npxSpecOk(args)) return { ok: false, reason: 'npx-style package spec rejected (no --package/-p/--registry/URL/tarball/git; one plain registry package only)' };
    return { ok: true };
  }

  // ---- the transport ----------------------------------------------------------------------------------
  // _internals exposes the diagnostics the test asserts (the last lines written to the child stdin, the
  // pure validators) without widening the public duplex contract.
  const _internals = { lastSentLines: null, defaultIsAllowed: defaultIsAllowed, npxSpecOk: npxSpecOk, baseName: baseName, SAFE_PKG_SPEC: SAFE_PKG_SPEC };

  function makeStdioTransport(deps) {
    deps = deps || {};
    const spawn = deps.spawn;
    if (typeof spawn !== 'function') throw new Error('mcp stdio transport requires an injected spawn');
    const isWin = (deps.isWin != null) ? deps.isWin : WIN;
    const isAllowed = (typeof deps.isAllowed === 'function') ? deps.isAllowed : defaultIsAllowed;
    const killSpawn = (typeof deps.killSpawn === 'function') ? deps.killSpawn : spawn;
    const processKill = (typeof deps.processKill === 'function') ? deps.processKill : ((typeof process !== 'undefined' && process.kill) ? process.kill.bind(process) : function () {});
    const onError = typeof deps.onError === 'function' ? deps.onError : function () {};

    const rawCommand = String(deps.command || '');
    const args = Array.isArray(deps.args) ? deps.args.slice() : [];
    const env = (deps.env && typeof deps.env === 'object') ? deps.env : null;
    const cwd = deps.cwd || undefined;

    let onMsg = null;
    let child = null;
    let closed = false;
    let stdoutBuf = '';           // INBOUND framing buffer: partial line carried across chunks
    const sentLines = [];         // every line written to the child (diagnostics / test assertion)

    // SPAWN-TIME ALLOWLIST: a blocked command NEVER spawns. We record the denial and fail every send.
    const verdict = isAllowed(rawCommand, args);
    let permError = (verdict && verdict.ok) ? null : ('mcp stdio command not permitted: ' + ((verdict && verdict.reason) || rawCommand));
    // a permitted command spawns EAGERLY at construction (the child boots; initialize is then the first send)
    // — so stdout/exit handlers are wired before any request, an exit can't be missed, and the allowlist still
    // strictly gates spawn (a blocked command sets permError above and never reaches spawn).

    // deliver an inbound message: drop our local inflight tracking for a correlated response (so a later exit
    // can't double-fail an already-answered id), then hand it to the host's onMessage handler.
    function deliver(msg) {
      if (msg && msg.id != null && (('result' in msg) || ('error' in msg))) inflight.delete(msg.id);
      if (onMsg) { try { onMsg(msg); } catch (e) { onError(e); } }
    }
    // turn a transport-level failure on a REQUEST into a JSON-RPC error response so the client's pending
    // promise rejects PROMPTLY (instead of hanging until its timeout); a notification has no id to fail.
    function failTo(id, message) { if (id != null) deliver({ jsonrpc: JSONRPC, id, error: { code: -32000, message: message } }); else onError(new Error(message)); }

    // route ONE newline-delimited stdout chunk: split on \n, parse each WHOLE line as JSON, deliver; carry a
    // trailing partial line into stdoutBuf; a non-JSON line (a server's stray log on stdout) is SKIPPED, never
    // crashing routing (parity with the HTTP transport's parseSse tolerance).
    function onStdout(chunk) {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        let line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);   // tolerate CRLF
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch (e) { continue; }          // non-JSON log line -> skip
        deliver(msg);
      }
    }

    // a child that exits/crashes with requests OUTSTANDING: those pending promises must reject with an EXITED
    // error PROMPTLY, not wait for the client's request timeout. We track every request id we've written but
    // not yet seen a reply for in `inflight` (below); on exit/error we synthesize a JSON-RPC error response for
    // each (failAllInflight -> failTo), which the client correlates by id and rejects. A reply clears the id
    // first (in deliver), so an already-answered request is never double-failed.
    function ensureChild() {
      if (permError) return false;
      if (child) return true;
      // Resolve the Windows .cmd shim: npx/uvx/etc. are `npx.cmd` on Windows. We spawn with shell:false and
      // un-mangled argv (shell:true would turn args into a shell string and weaken the allowlist), so we must
      // append the .cmd suffix ourselves for the runner shims that need it.
      let cmd = rawCommand;
      if (isWin) {
        const base = baseName(rawCommand);
        if (base && base !== 'node' && !/\.(cmd|exe|bat|ps1)$/i.test(rawCommand)) cmd = rawCommand + '.cmd';
      }
      const opts = { cwd: cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
      if (env) opts.env = Object.assign({}, (typeof process !== 'undefined' ? process.env : {}), env);
      if (!isWin) opts.detached = true;   // POSIX: lead a new process group so close() can tree-kill the group
      try { child = spawn(cmd, args, opts); }
      catch (e) { permError = 'mcp stdio spawn failed: ' + ((e && e.message) || e); failAllInflight(permError); return false; }

      try { if (typeof child.unref === 'function') child.unref(); } catch (_) {}
      if (child.stdout && child.stdout.on) child.stdout.on('data', onStdout);
      // stderr is NEVER routed to onMessage — it is the server's diagnostic channel, off the message path.
      if (child.stderr && child.stderr.on) child.stderr.on('data', function () {});
      if (child.on) {
        child.on('error', (e) => { const m = 'mcp stdio child error: ' + ((e && e.message) || e); permError = permError || m; failAllInflight(m); });
        const onGone = (code, sig) => { const m = 'mcp stdio child exited (' + (code != null ? 'code ' + code : 'signal ' + sig) + ')'; failAllInflight(m); };
        child.on('exit', onGone);
        child.on('close', onGone);
      }
      return true;
    }

    // in-flight request ids whose line we've written but no reply has arrived — so an exit can fail them.
    const inflight = new Set();
    function failAllInflight(message) {
      const ids = Array.from(inflight); inflight.clear();
      for (const id of ids) failTo(id, message);
    }

    // write ONE newline-terminated line to the child's stdin. The child spawns eagerly at construction, so by
    // send() time stdin exists; a write to an already-dead pipe is caught and reported as a write failure.
    function writeLine(line) {
      try {
        if (child && child.stdin && typeof child.stdin.write === 'function') { child.stdin.write(line); return true; }
        return false;
      } catch (e) { return false; }
    }

    function send(message) {
      const id = message && message.id;
      if (closed) { failTo(id, 'mcp stdio transport closed'); return Promise.resolve(); }
      if (permError) { failTo(id, permError); return Promise.resolve(); }
      if (!ensureChild()) { failTo(id, permError || 'mcp stdio child unavailable'); return Promise.resolve(); }
      let line;
      try { line = JSON.stringify(message) + '\n'; } catch (e) { failTo(id, 'mcp stdio could not serialize message'); return Promise.resolve(); }
      if (id != null) inflight.add(id);
      sentLines.push(line.trim());
      _internals.lastSentLines = sentLines;
      const ok = writeLine(line);
      if (!ok) { if (id != null) inflight.delete(id); failTo(id, 'mcp stdio write failed'); }
      // a reply (or an exit) clears the inflight id; we clear it opportunistically when a matching response is
      // routed (in onStdout via deliver, the client settles by id — we just drop our local tracking on exit).
      return Promise.resolve();
    }

    function onMessage(cb) { onMsg = cb; }   // inflight-id clearing happens in deliver() above

    function treeKill() {
      if (!child) return;
      try { child.kill && child.kill('SIGKILL'); } catch (_) {}
      try {
        if (isWin && child.pid) killSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else if (!isWin && child.pid) processKill(-child.pid, 'SIGKILL');   // negative pid -> the whole group (npx's node grandchild)
      } catch (_) { /* the child may already be gone */ }
    }

    function close() {
      if (closed) return;       // idempotent
      closed = true;
      failAllInflight('mcp stdio transport closed');
      treeKill();
      child = null;
    }

    // boot the child now (only if the command passed the allowlist). A blocked command leaves permError set
    // and never spawns; ensureChild() is a no-op in that case.
    ensureChild();

    return { send, onMessage, close };
  }

  return { makeStdioTransport, _internals };
});
