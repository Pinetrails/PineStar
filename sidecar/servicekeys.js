/* sidecar/servicekeys.js — custom service API keys (the KEYS tab's "add an unlisted platform" store).

   A third credential class beside provider keys (model access) and connector/channel tokens (MCP auth):
   "the user's key for ANY external service" — pasted once in TOOLSETS & CONNECTORS → KEYS, consumed by
   agents as an environment variable in their shell runs (spawn inherits process.env), and advertised to
   the model by NAME ONLY via a system-prompt block. The value itself never rides the prompt, the bus, or
   any /api response (list responses carry a masked last4) — truthful telemetry applies to secrets too.

   This is the pure, deterministic core (secrets.js idiom): no fs, no process, no ambient env. The host
   (index.js) owns persistence + the real process.env; this module answers:

     deriveEnvVar(name)                  -> 'ACME_CO_API_KEY' (uppercase, non-alnum → '_', collapsed)
     slug(name)                          -> stable record id ('acme-co')
     validate({name,key,docsUrl})        -> { ok } | { ok:false, error }
     mask(key)                           -> '····abcd' (never more than the last 4 chars)
     toPublic(record)                    -> the list-response shape: NO key, masked last4
     upsert(list, {name,key,docsUrl}, now, {reservedEnv})
                                         -> { list, record } | { error }   (same name = update in place;
                                            an empty key on update KEEPS the saved key, like mc-token;
                                            a name deriving a RESERVED env var — a model-provider keyEnv —
                                            is refused: a KEYS paste must never become billing credentials)
     setEnabled(list, id, enabled)       -> { list, record } | { error }
     remove(list, id)                    -> { list, removed } | { error }
     applyEnv(list, env, owned, {reservedEnv})
                                         -> owned'  — writes enabled keys into `env`, removes vars WE set
                                            that are gone/disabled, and NEVER clobbers a var that already
                                            existed but isn't ours (a real deployment env wins over a paste).
                                            Reserved (provider) vars are never written — belt to upsert's braces
     promptBlock(list)                   -> the <service_keys> system-prompt block naming env vars (no values);
                                            '' when nothing is enabled (byte-identical no-op for the seam) */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.servicekeys = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NAME_MAX = 64;
  const KEY_MAX = 4096;
  const URL_MAX = 512;
  const LIST_MAX = 100;   // sanity bound, not a product gate

  function slug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_MAX);
  }

  // "Acme Co." -> ACME_CO_API_KEY. Always suffixed _API_KEY unless the name itself already says so
  // ("Foo API key" -> FOO_API_KEY, not FOO_API_KEY_API_KEY). A digit-leading name gets a K_ prefix
  // (env var names can't start with a digit).
  function deriveEnvVar(name) {
    let base = String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    base = base.replace(/_?API_?KEY$/, '').replace(/_+$/, '');
    if (!base) return '';
    if (/^[0-9]/.test(base)) base = 'K_' + base;
    return base + '_API_KEY';
  }

  function validate(input) {
    const o = (input && typeof input === 'object') ? input : {};
    const name = String(o.name == null ? '' : o.name).trim();
    if (!name) return { ok: false, error: 'name is required' };
    if (name.length > NAME_MAX) return { ok: false, error: 'name is too long (max ' + NAME_MAX + ' chars)' };
    if (!slug(name)) return { ok: false, error: 'name needs at least one letter or digit' };
    if (!deriveEnvVar(name)) return { ok: false, error: 'name needs at least one letter or digit' };
    if ('key' in o && o.key != null && o.key !== '') {
      const key = String(o.key);
      if (key.length > KEY_MAX) return { ok: false, error: 'key is too long (max ' + KEY_MAX + ' chars)' };
      // one line of printable ASCII (every real API key is) — control chars / spaces are paste accidents
      if (/[^!-~]/.test(key)) return { ok: false, error: 'key must be a single line of printable characters (no spaces or line breaks)' };
    }
    if (o.docsUrl) {
      const u = String(o.docsUrl).trim();
      if (u.length > URL_MAX) return { ok: false, error: 'docs URL is too long' };
      if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'docs URL must start with http:// or https://' };
    }
    return { ok: true };
  }

  function mask(key) {
    const k = String(key || '');
    if (!k) return '';
    return '····' + k.slice(-4);
  }

  function isRecord(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  // the shape every /api response carries — by construction there is no `key` field to leak.
  function toPublic(record) {
    const r = isRecord(record) ? record : {};
    return {
      id: String(r.id || ''),
      name: String(r.name || ''),
      envVar: String(r.envVar || ''),
      docsUrl: String(r.docsUrl || ''),
      enabled: r.enabled !== false,
      addedAt: (typeof r.addedAt === 'number') ? r.addedAt : 0,
      last4: mask(r.key)
    };
  }

  function cleanList(list) { return (Array.isArray(list) ? list : []).filter(isRecord); }

  // normalize a caller-supplied reserved-env option (array or Set of var names) to a lookup Set.
  function reservedSet(opts) {
    const raw = opts && opts.reservedEnv;
    if (raw instanceof Set) return raw;
    return new Set(Array.isArray(raw) ? raw : []);
  }

  // add-or-update by name-slug. Never mutates the input list. `now` injected (no ambient clock).
  // opts.reservedEnv = the host's model-provider keyEnv names (plus STARNET_/SKYNET_ scoped forms):
  // a KEYS paste deriving one of those would silently become BILLING credentials via envFirst()'s
  // process.env read — refused here with a pointer to the right surface instead.
  function upsert(list, input, now, opts) {
    const v = validate(input);
    if (!v.ok) return { error: v.error };
    const src = cleanList(list);
    const name = String(input.name).trim();
    const id = slug(name);
    const prev = src.find(r => r.id === id) || null;
    const key = (input.key == null || input.key === '') ? (prev ? String(prev.key || '') : '') : String(input.key);
    if (!key) return { error: 'key is required' };
    if (!prev && src.length >= LIST_MAX) return { error: 'too many service keys (max ' + LIST_MAX + ')' };
    const envVar = deriveEnvVar(name);
    if (reservedSet(opts).has(envVar)) {
      return { error: name + ' is a model provider — add model keys under SETTINGS, not here' };
    }
    // a rename collision (two names deriving the same env var under different ids) would silently
    // shadow one key with the other in the run env — refuse it instead.
    if (src.some(r => r.id !== id && r.envVar === envVar)) return { error: 'another entry already uses ' + envVar };
    const record = {
      id: id, name: name, envVar: envVar, key: key,
      docsUrl: input.docsUrl ? String(input.docsUrl).trim() : (prev ? String(prev.docsUrl || '') : ''),
      enabled: prev ? (prev.enabled !== false) : true,
      addedAt: prev ? (prev.addedAt || 0) : (typeof now === 'number' ? now : 0)
    };
    return { list: src.filter(r => r.id !== id).concat([record]), record: record };
  }

  function setEnabled(list, id, enabled) {
    const src = cleanList(list);
    const prev = src.find(r => r.id === String(id || ''));
    if (!prev) return { error: 'no such service key' };
    const record = Object.assign({}, prev, { enabled: !!enabled });
    return { list: src.map(r => (r.id === prev.id ? record : r)), record: record };
  }

  function remove(list, id) {
    const src = cleanList(list);
    const prev = src.find(r => r.id === String(id || ''));
    if (!prev) return { error: 'no such service key' };
    return { list: src.filter(r => r.id !== prev.id), removed: prev };
  }

  /* Write every ENABLED key into `env` and return the new owned-set (env var name -> true).
     Ownership is the clobber guard: we only ever DELETE or OVERWRITE a var that WE set on a previous
     apply (`owned`), so a var the operator exported before launch (a real RESEND_API_KEY in the shell
     env) always wins over a pasted one — the paste is simply skipped and stays skipped until the
     ambient var goes away. Disabled/removed keys we own are scrubbed from env. */
  function applyEnv(list, env, owned, opts) {
    const e = env || {};
    const prevOwned = (owned && typeof owned === 'object') ? owned : {};
    const nextOwned = {};
    const want = {};
    const reserved = reservedSet(opts);
    for (const r of cleanList(list)) {
      if (r.enabled === false) continue;
      if (reserved.has(r.envVar)) continue;   // a pre-guard persisted record must still never shadow a provider key
      if (r.envVar && r.key) want[r.envVar] = String(r.key);
    }
    for (const k of Object.keys(want)) {
      if ((k in e) && !prevOwned[k]) continue;   // ambient var wins; never clobber what isn't ours
      e[k] = want[k];
      nextOwned[k] = true;
    }
    for (const k of Object.keys(prevOwned)) {
      if (!(k in want) && prevOwned[k]) { try { delete e[k]; } catch (_) {} }
    }
    return nextOwned;
  }

  /* The system-prompt block. NAMES only — the value never enters the prompt (the model uses the env
     var from its shell). '' when nothing is enabled, so the assembly seam stays byte-identical for a
     user with no service keys. The caller gates this on shell.exec being in the run's resolved tools:
     advertising an env var the run can't read would be the exact truthful-telemetry violation the
     quest block comments warn about. */
  function promptBlock(list) {
    const rows = cleanList(list).filter(r => r.enabled !== false && r.envVar && r.key);
    if (!rows.length) return '';
    const lines = rows
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map(r => '- ' + r.name + ': environment variable ' + r.envVar + (r.docsUrl ? ' (API docs: ' + r.docsUrl + ')' : ''));
    return '<service_keys>\n'
      + 'The Commander has connected API keys for these services. Each key is available to your shell '
      + 'commands as an environment variable — use it to call that service\'s API directly (curl etc.). '
      + 'NEVER print, echo, or write the key\'s value anywhere; reference it only as the variable.\n'
      + lines.join('\n')
      + '\n</service_keys>';
  }

  return { NAME_MAX, KEY_MAX, LIST_MAX, slug, deriveEnvVar, validate, mask, toPublic, upsert, setEnabled, remove, applyEnv, promptBlock };
});
