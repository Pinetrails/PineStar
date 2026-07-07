/* sidecar/channels/secrets.js — the secret-vs-config split for channel secrets (T1.4 + P1 key hygiene).

   Channel configs (Telegram/Discord) live at WORKSPACES/channels/secrets.json. Historically the whole record —
   INCLUDING the bot token AND the resolved provider API `key` — was persisted plaintext there. On the desktop
   build BOTH secrets belong in the OS keychain (keyring service "ai.skynet.harness"): the bot token under account
   "channel:<id>", the BYOK provider key under the provider's own account — both injected into the sidecar env at
   spawn (SKYNET_<ID>_TOKEN / SKYNET_<PROVIDER>_API_KEY) and live-pushed via token-gated endpoints. The sidecar
   resolves the provider key at connect/run time from that runtime layer (providerRuntimeKey -> runtimeKeys/env),
   so it NEVER needs the plaintext `key` on desktop. The bare sidecar (npm start / tests) can't reach the keychain,
   so it HONESTLY keeps the plaintext bot token as its only fallback — that token path is unchanged.

   Two secret classes, stripped together but handled differently:
     • token  — a keychain-IMPORT candidate: the sidecar reports a plaintext bot token so the shell can adopt it
                 into the keychain (the sidecar can't write keyring itself). Reported in `imports`.
     • key    — STRIP-ONLY: the provider key already lives in the shell's keychain / env (it is pushed to the
                 sidecar via /api/key, never authored here), so a plaintext copy is pure leak. Removed from the
                 persisted config, NEVER re-imported (there is nothing for the sidecar to hand back).

   This module is the pure, deterministic, injectable core so the migration + fallback logic is unit-testable
   without Tauri. It knows nothing about fs, keyring, or env — the host injects those decisions:

     TOKEN_FIELDS                      -> secret keys that are keychain-IMPORT candidates (just `token`)
     STRIP_FIELDS                      -> every secret key removed from plaintext in keychain mode (`token` + `key`)
     splitSecret(record)               -> { config, token }   // config = non-secret remainder (both secrets out);
                                                               // token = the extracted bot token (import candidate)
     stripTokens(secrets)              -> secrets with every channel's token AND key removed (what desktop persists)
     migratePlaintext(secrets, { keychainMode, hasChannelToken }) ->
         { config, imports, changed }  // config to persist; imports=[{id,token}] to hand the keychain; changed=did we strip anything

   `keychainMode` = "is this the desktop shell?" (host passes STARNET_DESKTOP_SHELL === '1'). When false the record
   is returned untouched (browser/dev keeps its plaintext secrets). When true, any plaintext bot token is reported
   as an `import` and stripped, and any plaintext provider key is stripped (never imported); an already-migrated
   token (hasChannelToken(id) true) is stripped without a duplicate import. `changed` is true if ANY secret (token
   OR key) was stripped, so a legacy file carrying only a plaintext `key` still triggers the scrub-rewrite. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.secrets = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the channels whose records carry secrets; other top-level keys (notifyAutonomous) are never secret.
  const CHANNEL_IDS = ['telegram', 'discord'];
  // keychain-IMPORT candidates: a plaintext value here is reported so the shell can adopt it into the keychain.
  const TOKEN_FIELDS = ['token'];
  // EVERY secret field removed from a channel record under keychain mode. `key` is strip-only (the provider API
  // key already lives in the shell keychain / env and is pushed via /api/key — a plaintext copy is pure leak).
  const STRIP_FIELDS = ['token', 'key'];

  function isChannelRecord(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  // pull the secret fields out of ONE channel record. Returns { config, token } where config is a shallow clone
  // MINUS every secret field (token AND key) and token is the extracted bot token (import candidate; '' when absent).
  function splitSecret(record) {
    const config = {};
    let token = '';
    if (isChannelRecord(record)) {
      for (const k of Object.keys(record)) {
        if (TOKEN_FIELDS.indexOf(k) >= 0) { if (record[k]) token = String(record[k]); continue; }   // extract + drop the import candidate
        if (STRIP_FIELDS.indexOf(k) >= 0) continue;                                                    // drop the strip-only secrets (key)
        config[k] = record[k];
      }
    }
    return { config, token };
  }

  // return a deep-ish clone of `secrets` with every channel's secret fields (token AND key) removed (config only).
  function stripTokens(secrets) {
    const out = {};
    const src = (secrets && typeof secrets === 'object') ? secrets : {};
    for (const k of Object.keys(src)) {
      if (CHANNEL_IDS.indexOf(k) >= 0 && isChannelRecord(src[k])) { out[k] = splitSecret(src[k]).config; }
      else out[k] = src[k];
    }
    return out;
  }

  // does ONE channel record still carry any strip-only secret (currently `key`) in plaintext? Used so the boot
  // migration flags a change (and rewrites the file) even when there is no bot token left to import.
  function hasStrippableSecret(record) {
    if (!isChannelRecord(record)) return false;
    for (const k of Object.keys(record)) {
      if (TOKEN_FIELDS.indexOf(k) >= 0) continue;                 // the token is counted by splitSecret().token
      if (STRIP_FIELDS.indexOf(k) >= 0 && record[k]) return true; // a non-empty strip-only secret (key)
    }
    return false;
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
        const hadStrippable = hasStrippableSecret(src[k]);      // a plaintext `key` (or other strip-only secret)
        const s = splitSecret(src[k]);
        if (s.token) {
          changed = true;                                   // there WAS a plaintext token -> we must strip it
          if (!has(k)) imports.push({ id: k, token: s.token });   // keychain doesn't have it yet -> import it
        }
        if (hadStrippable) changed = true;                  // a plaintext provider key alone forces the scrub-rewrite
        config[k] = s.config;
      } else {
        config[k] = src[k];
      }
    }
    return { config, imports, changed };
  }

  return { CHANNEL_IDS, TOKEN_FIELDS, STRIP_FIELDS, splitSecret, stripTokens, hasStrippableSecret, migratePlaintext };
});
