/* sidecar/channels/secrets.js — the token-vs-config split for channel secrets (T1.4).

   Channel configs (Telegram/Discord) live at WORKSPACES/channels/secrets.json. Historically the whole record —
   INCLUDING the bot token — was persisted plaintext there. On the desktop build the token now belongs in the OS
   keychain (same posture provider API keys already have: keyring service "ai.skynet.harness", account
   "channel:<id>", injected into the sidecar env at spawn as SKYNET_<ID>_TOKEN, live-pushed via a token-gated
   endpoint). The bare sidecar (npm start / tests) can't reach the keychain, so it HONESTLY falls back to the
   plaintext file — that path is unchanged.

   This module is the pure, deterministic, injectable core so the migration + fallback logic is unit-testable
   without Tauri. It knows nothing about fs, keyring, or env — the host injects those decisions:

     TOKEN_FIELDS                      -> the secret keys stripped in keychain mode (currently just `token`)
     splitSecret(record, { keychain }) -> { config, token }   // config = non-secret remainder; token pulled out
     stripTokens(secrets)              -> secrets with every channel's token removed (what desktop persists)
     migratePlaintext(secrets, { keychainMode, hasChannelToken }) ->
         { config, imports, changed }  // config to persist; imports=[{id,token}] to hand the keychain; changed=did we strip anything

   `keychainMode` = "is this the desktop shell?" (host passes STARNET_DESKTOP_SHELL === '1'). When false the record
   is returned untouched (browser/dev keeps its plaintext token). When true, any plaintext token is reported as an
   `import` and stripped from the on-disk config — UNLESS the keychain already holds that channel's token
   (hasChannelToken(id) true), in which case we only strip (no duplicate import). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.secrets = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the channels whose records carry a bot token; other top-level keys (notifyAutonomous) are never secret.
  const CHANNEL_IDS = ['telegram', 'discord'];
  // fields that are SECRET inside a channel record and must never sit in plaintext under keychain mode.
  const TOKEN_FIELDS = ['token'];

  function isChannelRecord(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  // pull the secret fields out of ONE channel record. Returns { config, token } where config is a shallow clone
  // MINUS the token fields and token is the extracted bot token (or '' when absent).
  function splitSecret(record) {
    const config = {};
    let token = '';
    if (isChannelRecord(record)) {
      for (const k of Object.keys(record)) {
        if (TOKEN_FIELDS.indexOf(k) >= 0) { if (record[k]) token = String(record[k]); continue; }
        config[k] = record[k];
      }
    }
    return { config, token };
  }

  // return a deep-ish clone of `secrets` with every channel's token field removed (non-secret config only).
  function stripTokens(secrets) {
    const out = {};
    const src = (secrets && typeof secrets === 'object') ? secrets : {};
    for (const k of Object.keys(src)) {
      if (CHANNEL_IDS.indexOf(k) >= 0 && isChannelRecord(src[k])) { out[k] = splitSecret(src[k]).config; }
      else out[k] = src[k];
    }
    return out;
  }

  // boot migration: given the loaded plaintext secrets, decide what to persist and what to import to the keychain.
  //   opts.keychainMode  = desktop shell? (only then do we import + strip)
  //   opts.hasChannelToken(id) -> bool  = does the keychain ALREADY hold this channel's token? (skip re-import)
  // Returns { config, imports:[{id,token}], changed }. In non-keychain mode config === secrets and imports === [].
  function migratePlaintext(secrets, opts) {
    const o = opts || {};
    const src = (secrets && typeof secrets === 'object') ? secrets : {};
    if (!o.keychainMode) return { config: src, imports: [], changed: false };
    const has = (typeof o.hasChannelToken === 'function') ? o.hasChannelToken : function () { return false; };
    const imports = [];
    let changed = false;
    const config = {};
    for (const k of Object.keys(src)) {
      if (CHANNEL_IDS.indexOf(k) >= 0 && isChannelRecord(src[k])) {
        const s = splitSecret(src[k]);
        if (s.token) {
          changed = true;                                   // there WAS a plaintext token -> we must strip it
          if (!has(k)) imports.push({ id: k, token: s.token });   // keychain doesn't have it yet -> import it
        }
        config[k] = s.config;
      } else {
        config[k] = src[k];
      }
    }
    return { config, imports, changed };
  }

  return { CHANNEL_IDS, TOKEN_FIELDS, splitSecret, stripTokens, migratePlaintext };
});
