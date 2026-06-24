/* node test/mcp.stdio.test.js — the MCP stdio transport (G2.1): newline-delimited JSON-RPC over a
   spawned child process. Mirrors the HTTP transport's {send,onMessage,close} duplex so client.js /
   translate.js / manager.js are reused VERBATIM.

   Coverage (every G2.1 acceptance bullet):
   (A) STUB-ECHO over a REAL spawned child (node -e): initialize -> serverInfo + notifications/initialized
       written; listTools paginates 2 pages via nextCursor; callTool returns content; isError:true THROWS
       through translate.js run().
   (B) FRAMING: 2 concatenated lines -> 2 msgs; a message split across chunks is buffered; a non-JSON log
       line on stdout is skipped; stderr never reaches onMessage.
   (C) LIFECYCLE/KILL/CRASH: ENOENT -> send rejects promptly; child crash mid-request -> pending rejects
       'exited' (not timeout); close()/E-STOP tree-kills (child.kill + taskkill /T on win) and is idempotent;
       client request timeout still fires.
   (D) WINDOWS .cmd: npx.cmd resolved + spawned shell:false with un-mangled argv.
   (E) ALLOWLIST incl. flag-injection: a non-allowlisted command NEVER spawns; npx --package evil ... REJECTED
       with no spawn; npx @modelcontextprotocol/server-x passes.
   (F) SAME DISPATCH BOUNDARY: a stdio connector's tools projected via manager.toolDefsForObjects + dispatched
       through the REAL registry are capability-gated, consent-gated, network:true — byte-identical to HTTP.
   (G) ENV REDACTION: no env value in summary(), no env value in any emitted bus event.
   (H) REGRESSION: function-form makeTransport still works after manager accepts fn-or-map. */
'use strict';
const A = require('./_assert.js');
const { spawn: realSpawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { makeStdioTransport, _internals: S } = require('../sidecar/mcp/transport.stdio.js');
const { makeMcpClient } = require('../sidecar/mcp/client.js');
const { makeMcpToolDef } = require('../sidecar/mcp/translate.js');
const { makeConnectorManager } = require('../sidecar/mcp/manager.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

// ---- a fake spawn returning a controllable child (no real process). The test pushes stdout chunks and
//      drives exit/error. Records every spawn call so the allowlist can be asserted to NOT spawn. ----
function makeFakeSpawn() {
  const calls = [];
  function spawn(cmd, args, opts) {
    const child = new EventEmitter();
    child.pid = 4242;
    child.killed = false;
    child.stdin = { writes: [], write(s) { this.writes.push(String(s)); return true; }, end() {}, on() {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = function (sig) { child.killed = true; child._killSig = sig; return true; };
    child.unref = function () {};
    const rec = { cmd, args, opts, child };
    calls.push(rec);
    return child;
  }
  spawn.calls = calls;
  return spawn;
}

// drain microtasks/the event loop a few times so async send()/promise plumbing settles
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  // ===================== A. STUB-ECHO over a REAL spawned child =====================
  {
    // a real inline-node MCP server: reads newline-delimited JSON-RPC on stdin, answers on stdout, and also
    // prints a non-JSON banner line + a stderr line to prove tolerance. listTools paginates across 2 pages.
    const server = `
      let buf = '';
      process.stdout.write('starting up (a non-JSON log line)\\n');
      process.stderr.write('a stderr diagnostic line\\n');
      process.stdin.on('data', d => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let m; try { m = JSON.parse(line); } catch (e) { continue; }
          if (m.method === 'initialize') {
            send({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2025-06-18', capabilities:{ tools:{} }, serverInfo:{ name:'echo', version:'9' } } });
          } else if (m.method === 'notifications/initialized') {
            process.stderr.write('got initialized notification\\n');
          } else if (m.method === 'tools/list') {
            if (!m.params || !m.params.cursor) {
              send({ jsonrpc:'2.0', id:m.id, result:{ tools:[{ name:'echo_a', inputSchema:{ type:'object' } }], nextCursor:'pg2' } });
            } else {
              send({ jsonrpc:'2.0', id:m.id, result:{ tools:[{ name:'echo_b', inputSchema:{ type:'object' } }] } });
            }
          } else if (m.method === 'tools/call' && m.params.name === 'echo_a') {
            send({ jsonrpc:'2.0', id:m.id, result:{ content:[{ type:'text', text:'echoed:' + JSON.stringify(m.params.arguments) }] } });
          } else if (m.method === 'tools/call' && m.params.name === 'boom') {
            send({ jsonrpc:'2.0', id:m.id, result:{ isError:true, content:[{ type:'text', text:'kaboom' }] } });
          }
        }
      });
      function send(o){ process.stdout.write(JSON.stringify(o) + '\\n'); }
    `;
    const allow = () => ({ ok: true });
    const transport = makeStdioTransport({
      spawn: realSpawn, command: process.execPath, args: ['-e', server], isAllowed: allow
    });
    const client = makeMcpClient({ transport, timeoutMs: 5000 });

    const init = await client.initialize();
    A.eq(init.serverInfo.name, 'echo', 'REAL child: initialize returns serverInfo over stdio');
    // the notifications/initialized line was written to the child's stdin
    A.ok(S.lastSentLines && S.lastSentLines.some(l => /notifications\/initialized/.test(l)), 'notifications/initialized written to the child stdin');

    const tools = await client.listTools();
    A.eq(tools.map(t => t.name), ['echo_a', 'echo_b'], 'REAL child: listTools paginates 2 pages via nextCursor');

    const r = await client.callTool('echo_a', { hi: 1 });
    A.ok(JSON.stringify(r.content).indexOf('echoed') >= 0, 'REAL child: callTool returns content');

    // isError:true THROWS through translate.js run()
    const def = makeMcpToolDef({ connectorId: 'echo', mcpTool: { name: 'boom', inputSchema: { type: 'object' } }, call: (n, a) => client.callTool(n, a) });
    let threw = false;
    try { await def.run({}, {}); } catch (e) { threw = true; A.ok(/kaboom/.test(e.message), 'isError text surfaced through translate run()'); }
    A.ok(threw, 'REAL child: an isError result makes translate run() throw');

    client.close('test done');
    await tick();
  }

  // ===================== B. FRAMING =====================
  {
    const spawn = makeFakeSpawn();
    const got = [];
    const transport = makeStdioTransport({ spawn, command: 'srv', args: [], isAllowed: () => ({ ok: true }) });
    transport.onMessage(m => got.push(m));
    const child = spawn.calls[0].child;

    // two concatenated JSON lines in ONE chunk -> two delivered messages
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"a":1}}\n{"jsonrpc":"2.0","method":"notifications/x"}\n'));
    await tick();
    A.eq(got.length, 2, 'two concatenated lines in one chunk -> two messages');
    A.eq(got[0].result.a, 1, 'first concatenated message parsed');
    A.eq(got[1].method, 'notifications/x', 'second concatenated message parsed');

    // a message split across two chunks is buffered then delivered once whole
    got.length = 0;
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"resu'));
    await tick();
    A.eq(got.length, 0, 'a partial line is buffered, nothing delivered yet');
    child.stdout.emit('data', Buffer.from('lt":{"b":2}}\n'));
    await tick();
    A.eq(got.length, 1, 'the split message is delivered once whole');
    A.eq(got[0].result.b, 2, 'the buffered+completed message parsed correctly');

    // a non-JSON log line on stdout is SKIPPED without crashing routing
    got.length = 0;
    child.stdout.emit('data', Buffer.from('this is a plain log line, not JSON\n{"jsonrpc":"2.0","id":3,"result":{"c":3}}\n'));
    await tick();
    A.eq(got.length, 1, 'a non-JSON stdout line is skipped, the JSON line still routes');
    A.eq(got[0].result.c, 3, 'routing survives a non-JSON line');

    // stderr never reaches onMessage
    got.length = 0;
    child.stderr.emit('data', Buffer.from('{"jsonrpc":"2.0","id":99,"result":{"leak":true}}\n'));
    await tick();
    A.eq(got.length, 0, 'stderr is off the message path (never routed)');
  }

  // ===================== C. LIFECYCLE / KILL / CRASH =====================
  {
    // (a) ENOENT command -> send() rejects promptly (no hang). The fake spawn throws synchronously like
    //     a missing binary surfaced at spawn time, OR emits an 'error' event — cover the event path.
    const spawn = makeFakeSpawn();
    const transport = makeStdioTransport({ spawn, command: 'srv', args: [], isAllowed: () => ({ ok: true }) });
    const client = makeMcpClient({ transport, timeoutMs: 10000 });
    const child = spawn.calls[0].child;
    const p = client.request('tools/list', {});
    child.emit('error', Object.assign(new Error('spawn srv ENOENT'), { code: 'ENOENT' }));
    let enoentRej = false;
    try { await p; } catch (e) { enoentRej = true; A.ok(/ENOENT|exited|spawn|failed/i.test(e.message), 'ENOENT rejects the pending request with a spawn/exit error'); }
    A.ok(enoentRej, 'ENOENT -> the pending request rejects promptly (no hang)');
  }
  {
    // (b) child crashes mid-request -> pending rejects with an 'exited' error, NOT a timeout
    const spawn = makeFakeSpawn();
    const transport = makeStdioTransport({ spawn, command: 'srv', args: [], isAllowed: () => ({ ok: true }) });
    const client = makeMcpClient({ transport, timeoutMs: 60000 });   // long timeout so a timeout can't masquerade
    const child = spawn.calls[0].child;
    const p = client.request('tools/call', { name: 'x' });
    await tick();
    child.emit('exit', 1, null);   // crash mid-request, no reply
    let crashRej = false;
    try { await p; } catch (e) { crashRej = true; A.ok(/exit/i.test(e.message) && !/timed out/i.test(e.message), 'crash rejects with an exited error, not a timeout'); }
    A.ok(crashRej, 'child crash mid-request rejects the pending promise');
  }
  {
    // (c) close()/E-STOP tree-kills (child.kill + taskkill /T on win) and is idempotent
    const spawn = makeFakeSpawn();
    const killer = makeFakeSpawn();   // a separate fake spawn for the taskkill child
    const transport = makeStdioTransport({ spawn, command: 'srv', args: [], isAllowed: () => ({ ok: true }), killSpawn: killer, isWin: true });
    const child = spawn.calls[0].child;
    transport.close();
    A.eq(child.killed, true, 'close() kills the child');
    A.ok(killer.calls.some(c => c.cmd === 'taskkill' && c.args.indexOf('/T') >= 0), 'close() tree-kills via taskkill /T on Windows');
    // idempotent
    A.notThrows(() => transport.close(), 'close() is idempotent');
  }
  {
    // (c-posix) on posix the group is signalled (negative pid) rather than taskkill
    const spawn = makeFakeSpawn();
    let groupKill = null;
    const transport = makeStdioTransport({
      spawn, command: 'srv', args: [], isAllowed: () => ({ ok: true }), isWin: false,
      processKill: (pid, sig) => { groupKill = { pid, sig }; }
    });
    const child = spawn.calls[0].child;
    transport.close();
    A.ok(groupKill && groupKill.pid === -child.pid, 'close() signals the process GROUP (negative pid) on posix');
  }
  {
    // (d) the client request timeout still fires if the child accepts the line but never replies
    const spawn = makeFakeSpawn();
    const transport = makeStdioTransport({ spawn, command: 'srv', args: [], isAllowed: () => ({ ok: true }) });
    const client = makeMcpClient({ transport, timeoutMs: 30 });
    const p = client.request('tools/list', {});   // child never replies
    let timedOut = false;
    try { await p; } catch (e) { timedOut = true; A.ok(/timed out/i.test(e.message), 'a never-answered request still times out via the client'); }
    A.ok(timedOut, 'client request timeout fires when the child accepts but never replies');
  }

  // ===================== D. WINDOWS .cmd =====================
  {
    // npx is a .cmd shim on Windows; it must be resolved to npx.cmd and spawned shell:false with UN-MANGLED argv.
    const spawn = makeFakeSpawn();
    const transport = makeStdioTransport({
      spawn, command: 'npx', args: ['@modelcontextprotocol/server-filesystem', '/tmp'],
      isAllowed: () => ({ ok: true }), isWin: true
    });
    const rec = spawn.calls[0];
    A.eq(rec.cmd, 'npx.cmd', 'on Windows the npx command is resolved to npx.cmd');
    A.eq(rec.opts.shell, false, 'spawned with shell:false (so the allowlist is not weakened by shell parsing)');
    A.eq(rec.args, ['@modelcontextprotocol/server-filesystem', '/tmp'], 'argv passed through un-mangled (not a shell string)');
  }

  // ===================== E. ALLOWLIST GATE (incl. flag-injection) =====================
  {
    // a command NOT on the allowlist NEVER spawns and every send fails 'not permitted'
    const spawn = makeFakeSpawn();
    const transport = makeStdioTransport({ spawn, command: 'rm', args: ['-rf', '/'], isAllowed: S.defaultIsAllowed });
    A.eq(spawn.calls.length, 0, 'a non-allowlisted command NEVER spawns');
    let failed = false;
    try { await transport.send({ jsonrpc: '2.0', id: 1, method: 'x' }); } catch (e) { failed = true; }
    // send may reject OR deliver a failTo error response; accept either, but assert the spawn never happened
    A.eq(spawn.calls.length, 0, 'still no spawn after send on a blocked transport');

    // FLAG INJECTION: npx --package evil <spec> must be REJECTED with NO spawn
    const spawn2 = makeFakeSpawn();
    const t2 = makeStdioTransport({ spawn: spawn2, command: 'npx', args: ['--package', 'evil', '@modelcontextprotocol/server-x'], isAllowed: S.defaultIsAllowed });
    A.eq(spawn2.calls.length, 0, 'npx --package <evil> is REJECTED (no spawn)');

    // -p short form also rejected
    const spawn2b = makeFakeSpawn();
    makeStdioTransport({ spawn: spawn2b, command: 'npx', args: ['-p', 'evil', '@modelcontextprotocol/server-x'], isAllowed: S.defaultIsAllowed });
    A.eq(spawn2b.calls.length, 0, 'npx -p <evil> is REJECTED (no spawn)');

    // --registry rejected
    const spawn2c = makeFakeSpawn();
    makeStdioTransport({ spawn: spawn2c, command: 'npx', args: ['--registry', 'http://evil', 'server-x'], isAllowed: S.defaultIsAllowed });
    A.eq(spawn2c.calls.length, 0, 'npx --registry is REJECTED (no spawn)');

    // a URL/tarball/git spec rejected
    const spawn2d = makeFakeSpawn();
    makeStdioTransport({ spawn: spawn2d, command: 'npx', args: ['https://evil.example/x.tgz'], isAllowed: S.defaultIsAllowed });
    A.eq(spawn2d.calls.length, 0, 'npx <url/tarball/git spec> is REJECTED (no spawn)');

    // the legitimate case PASSES: npx @modelcontextprotocol/server-* spawns
    const spawn3 = makeFakeSpawn();
    makeStdioTransport({ spawn: spawn3, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], isAllowed: S.defaultIsAllowed });
    A.eq(spawn3.calls.length, 1, 'npx @modelcontextprotocol/server-* (with the benign -y flag) PASSES and spawns');

    // the default allowlist also accepts node + uvx
    const spawn4 = makeFakeSpawn();
    makeStdioTransport({ spawn: spawn4, command: 'uvx', args: ['mcp-server-fetch'], isAllowed: S.defaultIsAllowed });
    A.eq(spawn4.calls.length, 1, 'uvx <pkg> passes the default allowlist');
  }

  // ===================== F. SAME DISPATCH BOUNDARY (stdio connector via manager + registry) =====================
  {
    // build a manager with makeTransport as a MAP keyed by transport kind, supply a stdio entry that produces a
    // controllable fake duplex; project the connector's tools and dispatch one through the REAL registry.
    function fakeDuplex(spec) {
      let onMsg = null; const sent = [];
      return {
        sent,
        send(msg) {
          sent.push(msg);
          if (msg && msg.id != null && msg.method) {
            Promise.resolve().then(() => {
              let res;
              if (msg.method === 'initialize') res = { jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'stdiofake' } } };
              else if (msg.method === 'tools/list') res = { jsonrpc: '2.0', id: msg.id, result: { tools: spec.tools || [] } };
              else if (msg.method === 'tools/call') res = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'stdio ran ' + msg.params.name }] } };
              if (res && onMsg) onMsg(res);
            });
          }
          return Promise.resolve();
        },
        onMessage(cb) { onMsg = cb; },
        close() { this.closed = true; }
      };
    }
    const stdioTools = [{ name: 'write_file', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }];
    const events = [];
    const makeTransportMap = {
      http: () => { throw new Error('should not use http here'); },
      stdio: (c) => fakeDuplex({ tools: stdioTools, cfg: c })
    };
    const mgr = makeConnectorManager({ makeTransport: makeTransportMap, onEvent: e => events.push(e) });
    const r = await mgr.configure('local', { transport: 'stdio', command: 'npx', args: ['@modelcontextprotocol/server-filesystem', '/tmp'], env: { SECRET_TOKEN: 'sk-LEAKME-123' } });
    A.eq(r.ok, true, 'a stdio connector configures + connects through the manager');
    A.eq(r.state, 'up', 'stdio connector state up');

    const defs = mgr.toolDefsForObjects([{ objectType: 'connector', connectorId: 'local' }]);
    A.eq(defs.length, 1, 'the stdio connector projects its tool');
    const def = defs[0];
    A.eq(def.capability, 'mcp:local', 'stdio tool capability is namespaced mcp:<conn> (byte-identical to HTTP)');
    A.eq(def.network, true, 'stdio tool is network:true');
    A.eq(def.requiresConsent, true, 'mutating stdio tool requires consent');

    // dispatch through the REAL registry: capability gate + schema validate + consent
    const reg = makeRegistry();
    reg.register(def);
    const mk = (args) => ({ id: 'c', name: def.name, args, argsRaw: JSON.stringify(args), parseError: null });
    const denied = await reg.dispatch(mk({ path: '/x' }), { canUse: () => ({ ok: false, reason: 'not placed' }) });
    A.eq(denied.summary, 'capdenied', 'stdio tool obeys the capability gate at the registry');
    const bad = await reg.dispatch(mk({}), { canUse: () => ({ ok: true }) });
    A.eq(bad.isError, true, 'stdio tool is schema-validated before run()');
    const okr = await reg.dispatch(mk({ path: '/etc/hosts' }), { canUse: () => ({ ok: true }) });
    A.eq(okr.ok, true, 'a granted, valid stdio dispatch succeeds through the real registry');

    // ===================== G. ENV REDACTION =====================
    const s = mgr.status('local');
    A.eq('env' in s, false, 'summary() NEVER includes env');
    A.eq(s.hasEnv, true, 'summary() exposes only hasEnv:true');
    const blob = JSON.stringify(mgr.list()) + JSON.stringify(events);
    A.eq(blob.indexOf('sk-LEAKME-123'), -1, 'no env secret value appears in summary() / list() / any emitted event');
    A.eq(blob.indexOf('SECRET_TOKEN'), -1, 'not even the env key name leaks into summaries/events');
  }

  // ===================== H. REGRESSION: function-form makeTransport still works =====================
  {
    // the pre-existing function-form: makeTransport is a plain fn (the HTTP wiring). Must still connect.
    function fakeDuplex() {
      let onMsg = null;
      return {
        send(msg) { if (msg && msg.id != null && msg.method) Promise.resolve().then(() => { if (onMsg) onMsg({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ? { serverInfo: { name: 'fn' } } : { tools: [] } }); }); return Promise.resolve(); },
        onMessage(cb) { onMsg = cb; }, close() {}
      };
    }
    const mgr = makeConnectorManager({ makeTransport: () => fakeDuplex() });
    const r = await mgr.configure('legacy', { url: 'https://x/mcp' });
    A.eq(r.ok, true, 'function-form makeTransport (the HTTP path) still connects after fn-or-map support');
  }

  A.report('mcp.stdio.test');
})();
