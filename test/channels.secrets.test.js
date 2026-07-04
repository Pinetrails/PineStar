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

// ---- A. splitSecret: token out, everything else stays ----
{
  const { config, token } = S.splitSecret({ token: 'BOT:123', model: 'x/y', enabled: true, ownerId: '42' });
  A.eq(token, 'BOT:123', 'splitSecret extracts the token');
  A.eq(config, { model: 'x/y', enabled: true, ownerId: '42' }, 'splitSecret keeps every non-secret field');
  A.ok(!('token' in config), 'splitSecret config carries no token');
  A.eq(S.splitSecret({ model: 'x/y' }).token, '', 'splitSecret token is empty when absent');
  A.eq(S.splitSecret(null).config, {}, 'splitSecret tolerates a non-object record');
}

// ---- B. stripTokens: every channel token gone, non-channel keys untouched ----
{
  const secrets = {
    telegram: { token: 'T:1', model: 'm1', enabled: true },
    discord: { token: 'D:2', model: 'm2', ownerId: 'o' },
    notifyAutonomous: true
  };
  const stripped = S.stripTokens(secrets);
  A.ok(!stripped.telegram.token && !stripped.discord.token, 'stripTokens removes both channel tokens');
  A.eq(stripped.telegram, { model: 'm1', enabled: true }, 'stripTokens keeps telegram config');
  A.eq(stripped.discord, { model: 'm2', ownerId: 'o' }, 'stripTokens keeps discord config');
  A.eq(stripped.notifyAutonomous, true, 'stripTokens keeps non-channel keys');
  // original is not mutated
  A.eq(secrets.telegram.token, 'T:1', 'stripTokens does not mutate the input');
}

// ---- C. migratePlaintext: bare mode leaves everything (plaintext fallback) ----
{
  const secrets = { telegram: { token: 'T:1', model: 'm' } };
  const res = S.migratePlaintext(secrets, { keychainMode: false });
  A.eq(res.config, secrets, 'bare mode: config is untouched');
  A.eq(res.imports, [], 'bare mode: nothing to import');
  A.eq(res.changed, false, 'bare mode: unchanged');
}

// ---- D. migratePlaintext: desktop mode imports + strips a plaintext token ----
{
  const secrets = { telegram: { token: 'T:1', model: 'm', enabled: true }, discord: { token: 'D:2', model: 'm2' }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => false });
  A.eq(res.changed, true, 'desktop: a plaintext token forces a change');
  A.ok(!res.config.telegram.token && !res.config.discord.token, 'desktop: tokens stripped from persisted config');
  A.eq(res.config.telegram, { model: 'm', enabled: true }, 'desktop: telegram config preserved');
  A.eq(res.config.notifyAutonomous, true, 'desktop: non-channel keys preserved');
  const ids = res.imports.map(i => i.id).sort();
  A.eq(ids, ['discord', 'telegram'], 'desktop: both tokens reported for keychain import');
  A.eq(res.imports.find(i => i.id === 'telegram').token, 'T:1', 'desktop: import carries the real token');
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

// ---- F. migratePlaintext: a tokenless desktop config is a no-op (no needless rewrite) ----
{
  const secrets = { telegram: { model: 'm', enabled: false }, notifyAutonomous: true };
  const res = S.migratePlaintext(secrets, { keychainMode: true, hasChannelToken: () => false });
  A.eq(res.changed, false, 'desktop: no plaintext token -> no change');
  A.eq(res.imports, [], 'desktop: nothing to import');
}

// ---- G. sidecar host wiring (static guard on index.js) ----
{
  const src = fs.readFileSync(path.join(root, 'sidecar', 'index.js'), 'utf8');
  A.ok(/require\(['"]\.\/channels\/secrets\.js['"]\)/.test(src), 'index.js requires the secrets module');
  A.ok(/DESKTOP_SHELL\s*=\s*\/\^\(1\|true\|yes\|on\)/.test(src), 'index.js derives DESKTOP_SHELL from the shell env');
  A.ok(/channelTokenRuntime/.test(src), 'index.js has a runtime channel-token layer');
  A.ok(/SKYNET_TELEGRAM_TOKEN|TELEGRAM_TOKEN/.test(src) && /DISCORD_TOKEN/.test(src), 'index.js seeds tokens from env');
  A.ok(/DESKTOP_SHELL\s*\?\s*channelSecretsMod\.stripTokens/.test(src), 'saveChannelSecrets strips tokens under the desktop shell');
  A.ok(/migratePlaintext/.test(src), 'index.js runs the boot migration');
  A.ok(/'\/api\/channels\/token'/.test(src) && /handleSetChannelToken/.test(src), 'index.js wires the token-push route');
  // the push handler is IPC-token gated and never returns the token
  const h = src.slice(src.indexOf('function handleSetChannelToken'));
  const body = h.slice(0, h.indexOf('\n}\n') + 3);
  A.ok(/IPC_TOKEN/.test(body), '/api/channels/token is gated by the per-launch IPC token');
  A.ok(!/token:\s*(tok|body\.token|channelTokenRuntime)/.test(body), '/api/channels/token never echoes the token back');
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
