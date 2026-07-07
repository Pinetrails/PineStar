/* node test/channels.secrets.test.js — the channel-token keychain seam (T1.4).

   Proves the pure token-vs-config split + migration logic (sidecar/channels/secrets.js) and static-guards the
   host wiring on BOTH sides:
     • splitSecret pulls the bot token out and leaves every non-secret field.
     • stripTokens removes every channel token (what the desktop build persists) and keeps the rest.
     • migratePlaintext: bare mode = untouched; desktop mode imports the plaintext token AND strips it; an
       already-migrated channel (keychain has it) is stripped but NOT re-imported; a tokenless config is a no-op.
     • the sidecar host resolves tokens from runtime/env and strips before writing under STARNET_DESKTOP_SHELL,
       and exposes a token-gated /api/channels/token push that never echoes the token.
     • the Rust shell injects SKYNET_<ID>_TOKEN from the keychain, migrates plaintext, and gates the command. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const S = require('../sidecar/channels/secrets.js');

const root = path.resolve(__dirname, '..');

// ---- A. splitSecret: BOTH secrets (token + key) out, everything else stays ----
{
  const { config, token } = S.splitSecret({ token: 'BOT:123', key: 'sk-live-abc', model: 'x/y', enabled: true, ownerId: '42' });
  A.eq(token, 'BOT:123', 'splitSecret extracts the token');
  A.eq(config, { model: 'x/y', enabled: true, ownerId: '42' }, 'splitSecret keeps every non-secret field');
  A.ok(!('token' in config), 'splitSecret config carries no token');
  A.ok(!('key' in config), 'splitSecret config carries no provider key (P1 hygiene)');   // the leak this fix closes
  A.eq(S.splitSecret({ model: 'x/y' }).token, '', 'splitSecret token is empty when absent');
  A.eq(S.splitSecret(null).config, {}, 'splitSecret tolerates a non-object record');
  // a record that ONLY carries a key (no bot token) still loses the key and reports no token
  const k = S.splitSecret({ key: 'sk-only', model: 'm' });
  A.eq(k.token, '', 'splitSecret: no token to extract when only a key is present');
  A.ok(!('key' in k.config), 'splitSecret: a lone provider key is still stripped');
  A.ok('STRIP_FIELDS' in S && S.STRIP_FIELDS.indexOf('key') >= 0, 'STRIP_FIELDS lists the provider key');
}

// ---- B. stripTokens: every channel token AND provider key gone, non-channel keys untouched ----
{
  const secrets = {
    telegram: { token: 'T:1', key: 'sk-tg', model: 'm1', enabled: true },
    discord: { token: 'D:2', key: 'sk-dc', model: 'm2', ownerId: 'o' },
    notifyAutonomous: true
  };
  const stripped = S.stripTokens(secrets);
  A.ok(!stripped.telegram.token && !stripped.discord.token, 'stripTokens removes both channel tokens');
  A.ok(!('key' in stripped.telegram) && !('key' in stripped.discord), 'stripTokens removes both provider keys (P1)');
  A.eq(stripped.telegram, { model: 'm1', enabled: true }, 'stripTokens keeps telegram config');
  A.eq(stripped.discord, { model: 'm2', ownerId: 'o' }, 'stripTokens keeps discord config');
  A.eq(stripped.notifyAutonomous, true, 'stripTokens keeps non-channel keys');
  // the whole persisted blob must contain no secret substring anywhere
  const blob = JSON.stringify(stripped);
  A.ok(blob.indexOf('T:1') < 0 && blob.indexOf('D:2') < 0 && blob.indexOf('sk-tg') < 0 && blob.indexOf('sk-dc') < 0,
    'stripTokens output serializes with NO token/key substring');
  // original is not mutated
  A.eq(secrets.telegram.token, 'T:1', 'stripTokens does not mutate the input');
  A.eq(secrets.telegram.key, 'sk-tg', 'stripTokens does not mutate the input key');
}

// ---- C. migratePlaintext: bare mode leaves everything (plaintext fallback) ----
{
  const secrets = { telegram: { token: 'T:1', model: 'm' } };
  const res = S.migratePlaintext(secrets, { keychainMode: false });
  A.eq(res.config, secrets, 'bare mode: config is untouched');
  A.eq(res.imports, [], 'bare mode: nothing to import');
  A.eq(res.changed, false, 'bare mode: unchanged');
}

// ---- D. migratePlaintext: desktop mode imports the token + strips BOTH token and key ----
{
  const secrets = { telegram: { token: 'T:1', key: 'sk-tg', model: 'm', enabled: true }, discord: { token: 'D:2', key: 'sk-dc', model: 'm2' }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => false });
  A.eq(res.changed, true, 'desktop: a plaintext token forces a change');
  A.ok(!res.config.telegram.token && !res.config.discord.token, 'desktop: tokens stripped from persisted config');
  A.ok(!('key' in res.config.telegram) && !('key' in res.config.discord), 'desktop: provider keys stripped from persisted config (P1)');
  A.eq(res.config.telegram, { model: 'm', enabled: true }, 'desktop: telegram config preserved');
  A.eq(res.config.notifyAutonomous, true, 'desktop: non-channel keys preserved');
  const ids = res.imports.map(i => i.id).sort();
  A.eq(ids, ['discord', 'telegram'], 'desktop: both tokens reported for keychain import');
  A.eq(res.imports.find(i => i.id === 'telegram').token, 'T:1', 'desktop: import carries the real token');
  // the KEY is stripped but NEVER handed back as an import (nothing for the sidecar to adopt — it lives in the shell)
  A.ok(!res.imports.some(i => 'key' in i || i.token === 'sk-tg' || i.token === 'sk-dc'), 'desktop: provider key is strip-only, never imported');
}

// ---- E. migratePlaintext: an already-migrated channel is stripped but NOT re-imported ----
{
  const secrets = { telegram: { token: 'T:1', model: 'm' }, discord: { token: 'D:2', model: 'm2' } };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: (id) => id === 'telegram' });
  A.eq(res.changed, true, 'desktop: still changed (discord needs stripping)');
  const ids = res.imports.map(i => i.id);
  A.eq(ids, ['discord'], 'desktop: only the un-migrated channel is imported');
  A.ok(!res.config.telegram.token, 'desktop: the already-migrated token is still stripped from plaintext');
}

// ---- F. migratePlaintext: a secret-free desktop config is a no-op (no needless rewrite) ----
{
  const secrets = { telegram: { model: 'm', enabled: false }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => false });
  A.eq(res.changed, false, 'desktop: no plaintext token or key -> no change');
  A.eq(res.imports, [], 'desktop: nothing to import');
}

// ---- F2. migratePlaintext: a KEY-ONLY legacy record (token already migrated) still forces the scrub ----
{
  // the exact P1 regression case: an already-token-migrated channel whose plaintext `key` was still being written.
  const secrets = { telegram: { key: 'sk-leaked', model: 'm', enabled: true }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => true });
  A.eq(res.changed, true, 'desktop: a lone plaintext key forces a rewrite (scrub)');
  A.eq(res.imports, [], 'desktop: a lone key imports nothing (strip-only)');
  A.ok(!('key' in res.config.telegram), 'desktop: the lone key is stripped from persisted config');
  A.eq(res.config.telegram, { model: 'm', enabled: true }, 'desktop: config minus the key is preserved');
  A.ok(JSON.stringify(res.config).indexOf('sk-leaked') < 0, 'desktop: no key substring survives migration');
  // bare mode leaves the key alone (honest plaintext fallback; there is no keychain to be more secure than a file)
  const bare = S.migratePlaintext(secrets, { keychainMode: false });
  A.eq(bare.config, secrets, 'bare mode: key-carrying config is untouched (honest fallback)');
  A.eq(bare.changed, false, 'bare mode: nothing stripped');
  // hasStrippableSecret is the exported predicate the boot .bak-scrub relies on
  A.ok(S.hasStrippableSecret({ key: 'x', model: 'm' }) === true, 'hasStrippableSecret true for a plaintext key');
  A.ok(S.hasStrippableSecret({ token: 't', model: 'm' }) === false, 'hasStrippableSecret false for a token-only record (token counted separately)');
  A.ok(S.hasStrippableSecret({ model: 'm' }) === false, 'hasStrippableSecret false for a secret-free record');
}

// ---- G. sidecar host wiring (static guard on index.js) ----
{
  const src = fs.readFileSync(path.join(root, 'sidecar', 'index.js'), 'utf8');
  A.ok(/require\(['"]\.\/channels\/secrets\.js['"]\)/.test(src), 'index.js requires the secrets module');
  A.ok(/DESKTOP_SHELL\s*=\s*\/\^\(1\|true\|yes\|on\)/.test(src), 'index.js derives DESKTOP_SHELL from the shell env');
  A.ok(/channelTokenRuntime/.test(src), 'index.js has a runtime channel-token layer');
  A.ok(/SKYNET_TELEGRAM_TOKEN|TELEGRAM_TOKEN/.test(src) && /DISCORD_TOKEN/.test(src), 'index.js seeds tokens from env');
  A.ok(/DESKTOP_SHELL\s*\?\s*channelSecretsMod\.stripTokens/.test(src), 'saveChannelSecrets strips secrets under the desktop shell');
  A.ok(/migratePlaintext/.test(src), 'index.js runs the boot migration');
  A.ok(/'\/api\/channels\/token'/.test(src) && /handleSetChannelToken/.test(src), 'index.js wires the token-push route');
  // P1 key hygiene: the boot migration also sweeps the .bak, and the provider key is resolved from the runtime
  // layer (never persisted). Guard the .bak-scrub wiring and that no write path re-persists a resolved key.
  A.ok(/function scrubChannelSecretsBak/.test(src), 'index.js defines the .bak secret scrub');
  A.ok(/scrubChannelSecretsBak\(\)/.test(src.slice(src.indexOf('migrateChannelSecretsToKeychain'))), 'the boot migration calls scrubChannelSecretsBak()');
  A.ok(/writeFileDurable\(\{\s*fs:\s*fs,\s*path:\s*path\s*\},\s*bak,/.test(src), 'the .bak scrub uses the durable write helper (house style)');
  A.ok(/providerRuntimeKey\(provider,\s*t\.key\s*\|\|\s*''\)/.test(src), 'telegram secrets() resolves the key via providerRuntimeKey (runtime/env fallback, not the persisted plaintext)');
  // the push handler is IPC-token gated and never returns the token
  const h = src.slice(src.indexOf('function handleSetChannelToken'));
  const body = h.slice(0, h.indexOf('\n}\n') + 3);
  A.ok(/IPC_TOKEN/.test(body), '/api/channels/token is gated by the per-launch IPC token');
  A.ok(!/token:\s*(tok|body\.token|channelTokenRuntime)/.test(body), '/api/channels/token never echoes the token back');
}

// ---- G2. on-disk round-trip through the REAL durable-store path: key never lands on disk; a legacy file is scrubbed ----
{
  // index.js self-boots a server and can't be required, so drive the exact seam it uses: stripTokens (desktop
  // persist) + writeJsonResilient/readJsonResilient (the durable store saveChannelSecrets/loadResilient call).
  const DS = require('../sidecar/durable-store.js');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-secret-'));
  const file = path.join(dir, 'secrets.json');
  const deps = { fs: fs, path: path };
  try {
    // (a) desktop WRITE path: a record carrying token+key is stripped before it hits disk -> no secret on disk or .bak.
    const live = { telegram: { token: 'T:disk', key: 'sk-disk', model: 'm', enabled: true }, notifyAutonomous: true };
    DS.writeJsonResilient(deps, file, S.stripTokens(live));   // == saveChannelSecrets(live) under DESKTOP_SHELL
    const onDisk = fs.readFileSync(file, 'utf8');
    A.ok(onDisk.indexOf('sk-disk') < 0 && onDisk.indexOf('T:disk') < 0, 'WRITE: neither key nor token round-trips to secrets.json');
    A.ok(onDisk.indexOf('"model":"m"') >= 0, 'WRITE: non-secret config still persisted');
    const loadedBack = DS.readJsonResilient(deps, file);
    A.ok(loadedBack.value && loadedBack.value.telegram && !('key' in loadedBack.value.telegram), 'WRITE: reload carries no key');

    // (b) LEGACY-file scrub: a pre-fix file WITH a plaintext key (as older builds wrote) is detected + rewritten clean,
    //     and crucially the .bak snapshot the rewrite creates is ALSO swept (mirrors scrubChannelSecretsBak()).
    const legacy = { telegram: { token: 'T:old', key: 'sk-legacy', model: 'm', enabled: true } };
    DS.writeJsonResilient(deps, file, legacy);               // simulate the old plaintext file on disk
    A.ok(fs.readFileSync(file, 'utf8').indexOf('sk-legacy') >= 0, 'LEGACY: precondition — the leaked key is on disk');
    // boot scrub: migratePlaintext flags changed, we persist the stripped config, THEN sweep the .bak.
    const res = S.migratePlaintext(legacy, { keychainMode: true, hasChannelToken: () => true });
    A.eq(res.changed, true, 'LEGACY: boot migration flags the file for a scrub');
    DS.writeJsonResilient(deps, file, S.stripTokens(res.config));   // saveChannelSecrets(res.config)
    // the durable write just snapshotted the pre-scrub (leaky) main into .bak — sweep it exactly as index.js does.
    const bak = file + '.bak';
    const bakRaw = fs.readFileSync(bak, 'utf8');
    if (JSON.stringify(S.stripTokens(JSON.parse(bakRaw))) !== bakRaw) {
      require('../sidecar/durable-write.js').writeFileDurable(deps, bak, JSON.stringify(S.stripTokens(JSON.parse(bakRaw))));
    }
    A.ok(fs.readFileSync(file, 'utf8').indexOf('sk-legacy') < 0, 'LEGACY: main secrets.json scrubbed of the key');
    A.ok(fs.readFileSync(bak, 'utf8').indexOf('sk-legacy') < 0, 'LEGACY: the .bak last-known-good scrubbed of the key too');
    A.ok(fs.readFileSync(file, 'utf8').indexOf('"model":"m"') >= 0, 'LEGACY: config survives the scrub');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- H. apiauth exempts the IPC-gated channel-token push (like /api/key) ----
{
  const auth = fs.readFileSync(path.join(root, 'sidecar', 'apiauth.js'), 'utf8');
  A.ok(/'\/api\/channels\/token'/.test(auth), 'apiauth TOKEN_EXEMPT includes /api/channels/token');
  const { requiresApiToken } = require('../sidecar/apiauth.js');
  A.ok(requiresApiToken({ method: 'POST', url: '/api/channels/token' }) === false, '/api/channels/token is not API-token gated (uses its own IPC token)');
  A.ok(requiresApiToken({ method: 'POST', url: '/api/channels/telegram/connect' }) === true, 'the connect route still requires the API token');
}

// ---- I. Rust shell wiring (static guard on main.rs) ----
{
  const rs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
  A.ok(/SIDECAR_CHANNEL_TOKEN_ENVS/.test(rs), 'main.rs declares the channel-token env table');
  A.ok(/"telegram",\s*"SKYNET_TELEGRAM_TOKEN"/.test(rs) && /"discord",\s*"SKYNET_DISCORD_TOKEN"/.test(rs), 'main.rs maps both channels to their spawn env vars');
  A.ok(/channel:\{channel\}|channel:\{\}/.test(rs) || /format!\("channel:/.test(rs), 'main.rs uses the channel:<id> keychain account');
  A.ok(/read_channel_token\(channel\)/.test(rs) && /cmd\.env\(env_name, token\)/.test(rs), 'main.rs injects the keychain token into the sidecar env at spawn');
  A.ok(/migrate_channel_tokens_from_plaintext/.test(rs), 'main.rs migrates plaintext channel tokens into the keychain');
  A.ok(/fn harness_store_channel_token/.test(rs) && /fn harness_has_channel_token/.test(rs), 'main.rs exposes the store/has channel-token commands');
  A.ok(/harness_store_channel_token,\s*\n\s*harness_has_channel_token/.test(rs), 'both channel-token commands are registered in the invoke handler');
  // the store command must write the keychain (set_password/delete) and push, never return the token
  A.ok(/fn harness_store_channel_token[\s\S]*?set_password[\s\S]*?push_channel_token/.test(rs), 'store command writes the keychain then pushes to the sidecar');
}

// ---- J. frontend routes the token through the keychain on desktop, POST-body on browser ----
{
  const harness = fs.readFileSync(path.join(root, 'frontend', 'app', 'harness.js'), 'utf8');
  A.ok(/function storeChannelToken/.test(harness), 'harness.js exposes storeChannelToken');
  A.ok(/harness_store_channel_token/.test(harness), 'harness.js invokes the Tauri channel-token command');
  A.ok(/if\s*\(!DESKTOP[\s\S]{0,40}\)\s*return Promise\.resolve\(false\)/.test(harness), 'browser build no-ops storeChannelToken (keeps the POST-body path)');
  const ui = fs.readFileSync(path.join(root, 'frontend', 'app', 'stationui.js'), 'utf8');
  A.ok(/Harness\.storeChannelToken\('telegram'/.test(ui) && /Harness\.storeChannelToken\('discord'/.test(ui), 'both connect handlers park the token in the keychain first');
  A.ok((ui.match(/if \(stored\) bodyToken = ''/g) || []).length >= 2, 'a keychain-stored token is omitted from the connect POST body');
}

A.report('channels.secrets.test');
