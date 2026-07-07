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
     splitKeyOnly(record)              -> config              // config MINUS strip-only secrets (key) but KEEPING token
     stripTokens(secrets, isDurable)   -> secrets with the provider key removed everywhere, and the bot token removed
                                          ONLY for channels where isDurable(id) is true (default: all durable = legacy
                                          behaviour). A NON-durable channel keeps its plaintext token — that plaintext
                                          copy is the honest last-known-good fallback, exactly like the bare sidecar.
     migratePlaintext(secrets, { keychainMode, hasChannelToken }) ->
         { config, imports, changed }  // config to persist; imports=[{id,token}] to hand the keychain; changed=did we strip anything

   `keychainMode` = "is this the desktop shell?" (host passes STARNET_DESKTOP_SHELL === '1'). When false the record
   is returned untouched (browser/dev keeps its plaintext secrets). When true, any plaintext bot token is reported
   as an `import` — but it is ONLY removed from the persisted config when hasChannelToken(id) proves the keychain
   already holds it. When the keychain does NOT (yet) hold it, the token is reported as an import AND kept in the
   persisted config: a plaintext token on disk is strictly better than a lost token (the invariant: never remove the
   last copy of a secret without proof another durable home holds it). A plaintext provider key is always stripped
   (never imported — it lives in the shell keychain and is pushed via /api/key). `changed` is true if ANY secret was
   removed OR re-homed, so a legacy file still triggers the scrub-rewrite. */
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

  // clone ONE channel record MINUS the strip-only secrets (key) but KEEPING the bot token. Used for a NON-durable
  // channel: the provider key still lives in the shell keychain (safe to drop), but the bot token has no proven
  // durable home, so its plaintext copy on disk is the honest last-known-good fallback and must survive.
  function splitKeyOnly(record) {
    const config = {};
    if (isChannelRecord(record)) {
      for (const k of Object.keys(record)) {
        if (TOKEN_FIELDS.indexOf(k) >= 0) { config[k] = record[k]; continue; }   // KEEP the token (not durable elsewhere)
        if (STRIP_FIELDS.indexOf(k) >= 0) continue;                               // drop the strip-only secrets (key)
        config[k] = record[k];
      }
    }
    return config;
  }

  // return a deep-ish clone of `secrets` for the desktop persist path. The provider `key` is ALWAYS stripped (it
  // lives in the shell keychain / env). The bot `token` is stripped ONLY for channels whose token is DURABLE
  // elsewhere (isDurable(id) true — in the keychain or spawn-env). A non-durable channel KEEPS its plaintext token:
  // that plaintext copy is the only surviving home, and losing it is the exact bug this guard closes. `isDurable`
  // defaults to always-true so a caller that omits it gets the legacy "strip every token" behaviour.
  function stripTokens(secrets, isDurable) {
    const out = {};
    const src = (secrets && typeof secrets === 'object') ? secrets : {};
    const durable = (typeof isDurable === 'function') ? isDurable : function () { return true; };
    for (const k of Object.keys(src)) {
      if (CHANNEL_IDS.indexOf(k) >= 0 && isChannelRecord(src[k])) {
        out[k] = durable(k) ? splitSecret(src[k]).config : splitKeyOnly(src[k]);
      } else out[k] = src[k];
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
          if (has(k)) {
            // The keychain PROVABLY holds this token -> the plaintext copy is now redundant; strip it. Also report
            // it as an import so the runtime layer stays live this session (harmless duplicate the host de-dupes).
            changed = true;
            imports.push({ id: k, token: s.token });
            config[k] = s.config;                            // token removed from persisted config
          } else {
            // The keychain does NOT (yet) hold it. NEVER remove the last copy: keep the token in the persisted
            // config, but still report it as an import so the shell can adopt it into the keychain on this launch
            // (self-healing — once stored, a later boot with has(k) true strips it). Only the `key` is dropped.
            if (hadStrippable) changed = true;                // dropping the plaintext key is the only rewrite here
            imports.push({ id: k, token: s.token });
            config[k] = splitKeyOnly(src[k]);                 // KEEP token, drop key
          }
        } else {
          if (hadStrippable) changed = true;                // a plaintext provider key alone forces the scrub-rewrite
          config[k] = s.config;
        }
      } else {
        config[k] = src[k];
      }
    }
    return { config, imports, changed };
  }

  return { CHANNEL_IDS, TOKEN_FIELDS, STRIP_FIELDS, splitSecret, splitKeyOnly, stripTokens, hasStrippableSecret, migratePlaintext };
});
