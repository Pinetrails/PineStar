/* node test/mcp.stdio.test.js - MCP stdio transport:
   real newline-framed child process, command allowlist, env redaction/minimal
   inheritance, manager wiring, consent flags, and close cleanup. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { makeMcpClient } = require('../sidecar/mcp/client.js');
const { makeConnectorManager } = require('../sidecar/mcp/manager.js');
const { makeStdioTransport, _internals: T } = require('../sidecar/mcp/transport.stdio.js');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function writeServer(dir) {
  const file = path.join(dir, 'stdio-server.js');
  fs.writeFileSync(file, [
    "'use strict';",
    "const readline = require('readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }",
    "rl.on('line', line => {",
    "  let msg; try { msg = JSON.parse(line); } catch (_) { return; }",
    "  if (!msg || msg.id == null) return;",
    "  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stdio-test', explicit: process.env.SECRET_TOKEN || '', ambient: process.env.OPENROUTER_KEY || '' } });",
    "  if (msg.method === 'tools/list') return reply(msg.id, { tools: [",
    "    { name: 'create_issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },",
    "    { name: 'read_note', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }",
    "  ] });",
    "  if (msg.method === 'tools/call') return reply(msg.id, { content: [{ type: 'text', text: 'called ' + msg.params.name + ' ' + JSON.stringify(msg.params.arguments || {}) }] });",
    "  return reply(msg.id, {});",
    "});",
    "process.on('SIGTERM', () => process.exit(0));"
  ].join('\n'));
  return file;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-mcp-stdio-'));
  const server = writeServer(tmp);
  const nodeBase = path.basename(process.execPath);
  try {
    // allowlist + env hygiene
    A.notThrows(() => T.assertAllowedCommand(process.execPath, [nodeBase]), 'the current node executable can be explicitly allowlisted');
    A.throws(() => makeStdioTransport({ command: 'cmd.exe', allowedCommands: [nodeBase] }), 'non-allowlisted command is refused before spawn');
    const childEnv = T.buildChildEnv({ SECRET_TOKEN: 'explicit-secret' }, { PATH: 'safe-path', OPENROUTER_KEY: 'ambient-secret' });
    A.eq(childEnv.SECRET_TOKEN, 'explicit-secret', 'explicit stdio env is passed through');
    A.eq(childEnv.OPENROUTER_KEY, undefined, 'ambient secret env is not inherited by default');
    A.eq(childEnv.STARNET_COMPUTER_DRIVER, '0', 'connector env cannot enable the physical-input driver');
    A.eq(childEnv.STARNET_BROWSER_HEADLESS, '1', 'connector env is pinned headless');
    A.throws(() => makeStdioTransport({ command: process.execPath, allowedCommands: [nodeBase], processEnv: {} }), 'stdio defaults to denied without an isolated process broker');
    A.throws(() => makeStdioTransport({ command: process.execPath, allowedCommands: [nodeBase], processEnv: { STARNET_USER_CONTROL_MODE: 'preserve', STARNET_MCP_STDIO: '0' } }), 'installed preserve mode refuses stdio before spawn');
    const redacted = T.redactEnv({ SECRET_TOKEN: 'explicit-secret', MODE: 'test' });
    A.eq(redacted.SECRET_TOKEN, '<redacted>', 'secret-like env keys redact their value');
    A.eq(redacted.MODE, '<set>', 'non-secret env keys still avoid exposing values');

    // real child process, newline-framed JSON-RPC
    {
      const errors = [];
      const tp = makeStdioTransport({
        userControlIsolated: true,
        command: process.execPath,
        args: [server],
        env: { SECRET_TOKEN: 'explicit-secret' },
        processEnv: { PATH: process.env.PATH || '', OPENROUTER_KEY: 'ambient-secret' },
        allowedCommands: [nodeBase],
        timeoutMs: 1000,
        onError: e => errors.push((e && e.message) || String(e))
      });
      const client = makeMcpClient({ transport: tp, timeoutMs: 1000 });
      const init = await client.initialize();
      A.eq(init.serverInfo.explicit, 'explicit-secret', 'stdio child sees explicit connector env');
      A.eq(init.serverInfo.ambient, '', 'stdio child does not inherit ambient secrets');
      const tools = await client.listTools();
      A.eq(tools.map(t => t.name).sort(), ['create_issue', 'read_note'], 'tools/list arrives over newline-framed stdio');
      const called = await client.callTool('create_issue', { title: 'hi' });
      A.ok(called.content[0].text.indexOf('called create_issue') >= 0, 'tools/call round-trips through the child process');
      client.close('test cleanup');
      await sleep(50);
      A.eq(tp.isClosed(), true, 'transport close marks the stdio child closed');
      A.eq(errors.length, 0, 'happy-path stdio child produced no transport errors');
    }

    // manager wiring + sanitized summaries + MCP consent posture
    {
      const mgr = makeConnectorManager({
        makeTransport: cfg => {
          A.eq(cfg.transport, 'stdio', 'manager passes the stdio transport kind to the transport factory');
          return makeStdioTransport(Object.assign({}, cfg, {
            userControlIsolated: true,
            processEnv: { PATH: process.env.PATH || '', OPENROUTER_KEY: 'ambient-secret' },
            allowedCommands: [nodeBase],
            timeoutMs: 1000
          }));
        },
        clock: { now: () => 123 },
        timeoutMs: 1000
      });
      const r = await mgr.configure('local', {
        transport: 'stdio',
        command: process.execPath,
        args: [server],
        env: { SECRET_TOKEN: 'explicit-secret' },
        label: 'Local'
      });
      A.eq(r.ok, true, 'stdio connector configured through manager');
      A.eq(r.state, 'up', 'stdio connector reaches up state');
      const status = mgr.status('local');
      A.eq(status.transport, 'stdio', 'status records stdio transport');
      A.eq(status.url, undefined, 'stdio status does not pretend to have an HTTP URL');
      A.eq(status.env.SECRET_TOKEN, '<redacted>', 'manager summary redacts stdio env values');
      A.eq(JSON.stringify(status).indexOf('explicit-secret'), -1, 'manager summary never leaks the env secret');
      const defs = mgr.toolDefsFor('local');
      A.eq(defs.find(d => d.name === 'mcp__local__create_issue').requiresConsent, true, 'mutating MCP stdio tools still require consent');
      A.eq(defs.find(d => d.name === 'mcp__local__read_note').requiresConsent, true, 'stdio MCP annotations cannot suppress live consent');
      A.eq(defs.find(d => d.name === 'mcp__local__read_note').impact, 'external-unknown', 'stdio MCP tools are classified as untrusted local effects');
      const out = await defs.find(d => d.name === 'mcp__local__create_issue').run({ title: 'ship' }, {});
      A.ok(out.content.indexOf('called create_issue') >= 0, 'projected stdio MCP tool dispatches through the warm client');
      await mgr.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  A.report('mcp.stdio.test');
})();
