/* node test/servicekeys.env.test.js — the KEYS-tab → shell-child COMPOSITION (servicekeys.js × environment.js).

   WHY THIS FILE EXISTS (regression, 2026-07-24): servicekeys.test.js proved applyEnv against a FAKE env
   object and environment.test.js proved sanitizeChildEnv in isolation — both green, while the seam BETWEEN
   them was severed. sanitizeChildEnv strips every name matching _KEY/_TOKEN/_SECRET/…, and
   deriveEnvVar ALWAYS ends in _API_KEY, so 100% of KEYS-tab entries were scrubbed out of the shell child's
   environment while servicekeys.promptBlock still told the model "available to your shell commands as an
   environment variable — use it to call that service's API directly (curl etc.)". Every pasted key expanded
   to an empty string and the agent got a 401. A user hit this trying to connect Printify.

   The prompt PROMISES the variable is there. These tests are what make that promise true. */
'use strict';
const A = require('./_assert.js');
const OS = require('os');
const K = require('../sidecar/servicekeys.js');
const { makeEnvironmentManager, sanitizeChildEnv } = require('../sidecar/environment.js');

const RESERVED = new Set(['OPENROUTER_API_KEY']);   // stands in for the host's model-provider keyEnv set

// A local backend whose spawn is captured, so we assert on the REAL env a shell child would receive.
function harness(hostEnv, getKeys) {
  let captured = null;
  const child = { on() {}, kill() {}, stdout: { on() {} }, stderr: { on() {} } };
  // runProcess calls spawn(file, opts) when args is not an Array, spawn(file, args, opts) when it is.
  const spawn = (file, a, b) => { captured = (Array.isArray(a) ? b : a).env; return child; };
  const env = makeEnvironmentManager({
    spawn, fs: require('fs'), pathMod: require('path'), root: OS.tmpdir() + '/starnet-sk-env-test',
    env: hostEnv,
    serviceEnv: () => K.runEnv(getKeys(), hostEnv, { reservedEnv: RESERVED })
  });
  return {
    shellEnv() {
      captured = null;
      env.execute({ agentId: 'a', cmd: 'echo hi' }).catch(() => {});
      return captured || {};
    }
  };
}

// ---- A. the scrub that caused the bug is still in force for everything else ----
{
  const out = sanitizeChildEnv({ PATH: 'p', SOME_API_KEY: 'v', A_TOKEN: 'v', B_SECRET: 'v', PLAIN: 'v' });
  A.eq(out.PATH, 'p', 'ordinary vars pass through');
  A.eq(out.PLAIN, 'v', 'non-secret-shaped vars pass through');
  A.ok(!('SOME_API_KEY' in out), 'sanitizeChildEnv still strips *_API_KEY by default');
  A.ok(!('A_TOKEN' in out), 'sanitizeChildEnv still strips *_TOKEN');
  A.ok(!('B_SECRET' in out), 'sanitizeChildEnv still strips *_SECRET');
}

// ---- B. runEnv is a pure selector over the host env ----
{
  const host = { PRINTIFY_API_KEY: 'tok', GONE_API_KEY: 'x' };
  const keys = [
    { id: 'printify', name: 'Printify', envVar: 'PRINTIFY_API_KEY', key: 'tok', enabled: true },
    { id: 'off', name: 'Off', envVar: 'OFF_API_KEY', key: 'y', enabled: false },
    { id: 'unset', name: 'Unset', envVar: 'UNSET_API_KEY', key: 'z', enabled: true }
  ];
  const out = K.runEnv(keys, host, { reservedEnv: RESERVED });
  A.eq(out.PRINTIFY_API_KEY, 'tok', 'enabled key present, value resolved from the host env');
  A.ok(!('OFF_API_KEY' in out), 'disabled key excluded');
  A.ok(!('UNSET_API_KEY' in out), 'a row whose var is absent from the host env is not invented');
  A.eq(Object.keys(host).length, 2, 'runEnv never mutates the host env');

  const reserved = K.runEnv(
    [{ id: 'o', name: 'O', envVar: 'OPENROUTER_API_KEY', key: 'k', enabled: true }],
    { OPENROUTER_API_KEY: 'BILLING' }, { reservedEnv: RESERVED });
  A.ok(!('OPENROUTER_API_KEY' in reserved), 'a reserved provider/billing var is never handed to a shell');
}

// ---- C. THE REGRESSION: a pasted key actually reaches the shell child ----
{
  const host = { PATH: 'p', OPENROUTER_API_KEY: 'BILLING-SECRET' };
  let keys = [];
  let owned = {};
  const apply = () => { owned = K.applyEnv(keys, host, owned, { reservedEnv: RESERVED }); };
  const h = harness(host, () => keys);

  A.ok(!('PRINTIFY_API_KEY' in h.shellEnv()), 'no key pasted -> var absent');

  keys = K.upsert(keys, { name: 'Printify', key: 'tok-123' }, 1, { reservedEnv: RESERVED }).list;
  apply();
  const withKey = h.shellEnv();
  A.eq(withKey.PRINTIFY_API_KEY, 'tok-123',
    'a KEYS-tab paste REACHES the shell child (the promptBlock promise) — and with NO sidecar restart, ' +
    'so the boot-time childEnv snapshot is not the source of truth');

  // the general scrub must still hold for everything the Commander did NOT paste
  A.ok(!('OPENROUTER_API_KEY' in withKey), 'a model-provider/billing key still never reaches a shell child');
  A.eq(withKey.PATH, 'p', 'ordinary inherited vars survive the merge');

  // host authority is not overridable by a pasted row
  A.eq(withKey.STARNET_USER_CONTROL_MODE, 'preserve', 'reserved safety pin intact after the merge');
  A.eq(withKey.STARNET_COMPUTER_DRIVER, '0', 'computer-driver pin intact after the merge');

  keys = K.setEnabled(keys, 'printify', false, 2).list;
  apply();
  A.ok(!('PRINTIFY_API_KEY' in h.shellEnv()), 'disabling a key removes it from the very next run');

  keys = K.setEnabled(keys, 'printify', true, 3).list;
  apply();
  keys = K.remove(keys, 'printify').list;
  apply();
  A.ok(!('PRINTIFY_API_KEY' in h.shellEnv()), 'removing a key removes it from the very next run');
}

// ---- D. a pasted row can never smuggle in host authority or an execution hook ----
{
  const host = { PATH: 'p' };
  // hand the merge a hostile map directly — runEnv's reserved filter is one guard, mergeServiceEnv is the other.
  const hostile = {
    STARNET_COMPUTER_DRIVER: '1',        // would re-enable physical input
    STARNET_MCP_STDIO: '1',              // would re-enable unsandboxed local MCP children
    NODE_OPTIONS: '--require=/tmp/evil',  // would hijack every node child
    COMSPEC: 'C:\\evil.exe',
    GOOD_API_KEY: 'ok'
  };
  const h = harness(host, () => []);
  const { mergeServiceEnv } = makeEnvironmentManager({
    spawn: () => ({ on() {}, kill() {}, stdout: { on() {} }, stderr: { on() {} } }),
    fs: require('fs'), pathMod: require('path'), root: OS.tmpdir() + '/starnet-sk-env-test', env: host
  })._internals;

  const merged = mergeServiceEnv(sanitizeChildEnv(host), hostile);
  A.eq(merged.STARNET_COMPUTER_DRIVER, '0', 'a pasted var cannot re-enable the computer driver');
  A.eq(merged.STARNET_MCP_STDIO, '0', 'a pasted var cannot re-enable local MCP children');
  A.ok(!('NODE_OPTIONS' in merged), 'a pasted var cannot set an execution hook');
  A.ok(!merged.COMSPEC || !/evil/i.test(merged.COMSPEC), 'a pasted var cannot repoint COMSPEC');
  A.eq(merged.GOOD_API_KEY, 'ok', 'an ordinary service var still merges');
  A.ok(h, 'harness constructed');
}

// report() LAST — it is what exits non-zero. A file ending in a bare console.log prints FAIL and still
// exits 0, so the fast gate scores it green (6 gate files currently do exactly that; see the lane notes).
A.report('servicekeys.env.test.js');
