/* node test/environment.test.js - execution backend boundary.

   No real Docker/process dependency: fake child handles prove the manager's
   contract deterministically while keeping test:fast hermetic.
*/
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { makeEnvironmentManager } = require('../sidecar/environment.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');

function makeFakeSpawn() {
  const calls = [];
  function spawn(file, argsOrOpts, maybeOpts) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242 + calls.length;
    child.killed = false;
    child.kill = function () { child.killed = true; };
    const call = {
      file,
      args: Array.isArray(argsOrOpts) ? argsOrOpts.slice() : null,
      opts: Array.isArray(argsOrOpts) ? (maybeOpts || {}) : (argsOrOpts || {}),
      child
    };
    calls.push(call);
    const next = spawn.next || { out: 'ok\n', code: 0 };
    spawn.next = null;
    setImmediate(function () {
      if (next.out) child.stdout.emit('data', Buffer.from(next.out));
      child.emit('close', next.code);
    });
    return child;
  }
  spawn.calls = calls;
  spawn.setNext = function (out, code) { spawn.next = { out: out, code: code == null ? 0 : code }; };
  return spawn;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-env-'));
  const clock = { now: () => 0 };

  try {
    // ---- local backend: old host-shell behavior remains behind the new seam ----
    {
      const spawn = makeFakeSpawn();
      const bgCalls = [];
      const bg = {
        start: (o) => { bgCalls.push(o); return { ok: true, bgId: 'bg_1' }; },
        status: () => [],
        kill: () => ({ ok: true })
      };
      const env = makeEnvironmentManager({ spawn, fs, pathMod: path, root, bg, clock,
        env: { PATH: 'safe-path', SKYNET_API_TOKEN: 'api-secret', STARNET_IPC_TOKEN: 'ipc-secret', OPENAI_API_KEY: 'provider-secret', TELEGRAM_BOT_TOKEN: 'channel-secret', STARNET_COMPUTER_DRIVER: '1', NODE_OPTIONS: '--require evil.js' },
        config: { backend: 'local' } });
      A.eq(env.backendId, 'local', 'local backend selected');
      await env.execute({ agentId: 'a1', cmd: 'echo ok', timeoutMs: 1000 });
      A.eq(spawn.calls[0].file, 'echo ok', 'local executes command through shell string');
      A.eq(spawn.calls[0].opts.shell, true, 'local uses shell:true');
      A.eq(spawn.calls[0].opts.cwd, path.join(root, 'a1'), 'local cwd is the per-agent workspace');
      A.eq(spawn.calls[0].opts.env.PATH, 'safe-path', 'safe build environment survives');
      A.ok(!('SKYNET_API_TOKEN' in spawn.calls[0].opts.env) && !('STARNET_IPC_TOKEN' in spawn.calls[0].opts.env), 'sidecar API/IPC tokens never reach task children');
      A.ok(!('OPENAI_API_KEY' in spawn.calls[0].opts.env) && !('TELEGRAM_BOT_TOKEN' in spawn.calls[0].opts.env), 'provider/channel secrets never reach task children');
      A.ok(!('NODE_OPTIONS' in spawn.calls[0].opts.env), 'ambient execution hooks never reach task children');
      A.eq(spawn.calls[0].opts.env.STARNET_COMPUTER_DRIVER, '0', 'physical-input disable is pinned in task children');
      A.eq(spawn.calls[0].opts.env.STARNET_BROWSER_HEADLESS, '1', 'headless browser mode is pinned in task children');
      A.eq(spawn.calls[0].opts.env.STARNET_USER_CONTROL_MODE, 'preserve', 'user-control preservation mode is pinned');
      fs.mkdirSync(path.join(root, 'a1', 'sub'), { recursive: true });
      env.rememberCwd('a1', path.join(root, 'a1', 'sub'));
      A.eq(env.getCwd('a1'), path.join(root, 'a1', 'sub'), 'local persists in-jail cwd');
      env.rememberCwd('a1', path.join(root, 'outside'));
      A.eq(env.getCwd('a1'), path.join(root, 'a1', 'sub'), 'local refuses out-of-jail cwd persistence');
      env.startBackground({ agentId: 'a1', cmd: 'npm run dev' });
      A.eq(bgCalls[0].cwd, path.join(root, 'a1', 'sub'), 'background local inherits backend cwd');
      A.eq(bgCalls[0].env.STARNET_COMPUTER_DRIVER, '0', 'background processes receive the same safety pins');
      A.ok(!('SKYNET_API_TOKEN' in bgCalls[0].env), 'background processes receive no sidecar token');
    }

    // ---- docker backend: builds a hardened run command around the same workspace ----
    {
      const spawn = makeFakeSpawn();
      const env = makeEnvironmentManager({ spawn, fs, pathMod: path, root, clock, config: {
        backend: 'docker',
        dockerBin: 'dockerx',
        dockerImage: 'starnet-node:test',
        dockerNetwork: 'none',
        dockerCpus: '2',
        dockerMemory: '1g',
        dockerExtraArgs: ['--read-only']
      } });
      await env.execute({ agentId: 'a2', cmd: 'pwd', timeoutMs: 1000 });
      const c = spawn.calls[0];
      A.eq(c.file, 'dockerx', 'docker backend invokes configured docker binary');
      A.ok(c.args.indexOf('run') >= 0 && c.args.indexOf('--rm') >= 0, 'docker uses one-shot removable container');
      A.ok(c.args.indexOf('--cap-drop') >= 0 && c.args.indexOf('ALL') >= 0, 'docker drops capabilities');
      A.ok(c.args.indexOf('no-new-privileges') >= 0, 'docker enables no-new-privileges');
      A.ok(c.args.indexOf('--network') >= 0 && c.args[c.args.indexOf('--network') + 1] === 'none', 'docker network policy is configurable');
      A.ok(c.args.indexOf('--read-only') >= 0, 'docker extra args pass through as JSON list only');
      A.ok(c.args.indexOf('--volume') >= 0 && /a2:\/workspace$/.test(c.args[c.args.indexOf('--volume') + 1].replace(/\\/g, '/')), 'docker bind-mounts the agent workspace');
      A.ok(c.args.indexOf('--workdir') >= 0 && c.args[c.args.indexOf('--workdir') + 1] === '/workspace', 'docker starts in container workspace');
      A.ok(c.args.indexOf('starnet-node:test') >= 0, 'docker image is configurable');
      A.eq(c.args[c.args.length - 3], 'sh', 'docker uses POSIX shell');
      A.eq(c.args[c.args.length - 1], 'pwd', 'docker passes the command as shell payload');
      env.rememberCwd('a2', '/workspace/src');
      A.eq(env.getCwd('a2'), '/workspace/src', 'docker persists container cwd');
      env.rememberCwd('a2', '/etc');
      A.eq(env.getCwd('a2'), '/workspace/src', 'docker refuses out-of-workspace cwd persistence');
    }

    // ---- shell tool: Docker-like environments get POSIX cwd markers, never Windows %CD% markers ----
    {
      let remembered = '';
      const calls = [];
      const fakeEnv = {
        backendId: 'docker',
        ensureWorkspace: (aid) => path.join(root, aid),
        getCwd: () => '/workspace',
        rememberCwd: (_aid, cwd) => { remembered = cwd; },
        execute: (o) => {
          calls.push(o);
          return Promise.resolve({
            out: 'hello\n__SK_CWD__/workspace/app__SK_EC__7__SK_END__',
            exitCode: 0,
            ms: 0,
            truncated: false,
            timedOut: false,
            aborted: false
          });
        }
      };
      const shell = makeShellTool({ environment: fakeEnv, clock, platform: 'win32' }).execTool;
      const r = await shell.run({ cmd: 'cd app; exit 7' }, { agentId: 'a3' });
      A.ok(calls[0].cmd.indexOf('printf "\\n__SK_CWD__%s__SK_EC__%s__SK_END__"') >= 0, 'docker backend uses POSIX marker command');
      A.ok(calls[0].cmd.indexOf('%CD%') < 0, 'docker backend does not inherit Windows marker syntax from host');
      A.eq(remembered, '/workspace/app', 'shell persists container cwd through environment');
      A.ok(/\[exit 7/.test(r.content), 'shell reports marker exit code from environment output');
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  /* ---- the child-env scrub must catch the GLUED secret spellings people actually have ----
     The `_` boundary meant STRIPE_APIKEY / GITHUB_PAT / FOO_ACCESSTOKEN never matched and rode straight
     into every task child's env. StarNet's own KEYS vars always end in _API_KEY, which is why our fixtures
     never showed it. ---- */
  {
    const { sanitizeChildEnv: scrub } = require('../sidecar/environment.js');
    A.eq(typeof scrub, 'function', 'sanitizeChildEnv is reachable (a silently-skipped scrub test is worse than none)');
    {
      const out = scrub({
        OPENAI_API_KEY: 'a', STRIPE_APIKEY: 'b', GITHUB_PAT: 'c', FOO_ACCESSTOKEN: 'd',
        ANTHROPIC_APIKEY: 'e', DB_PASSWORD: 'f',
        PATH: '/usr/bin', PATHEXT: '.EXE', UPDATE_PATH: 'x', LANG: 'en', HOME: '/h'
      });
      for (const k of ['OPENAI_API_KEY', 'STRIPE_APIKEY', 'GITHUB_PAT', 'FOO_ACCESSTOKEN', 'ANTHROPIC_APIKEY', 'DB_PASSWORD'])
        A.eq(out[k], undefined, 'secret-shaped ' + k + ' never reaches a task child');
      for (const k of ['PATH', 'PATHEXT', 'UPDATE_PATH', 'LANG', 'HOME'])
        A.ok(out[k] != null, 'ordinary ' + k + ' still survives (PAT is boundary-anchored, PATH is not a secret)');
    }
  }

  A.report('environment.test');
})().catch(e => { console.log('FAIL: environment.test threw - ' + (e && e.stack || e)); process.exit(1); });
