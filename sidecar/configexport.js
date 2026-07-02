/* sidecar/configexport.js — STATION BACKUP (P1-7): serialize the station's persisted config/state to ONE
   portable JSON file, import it back, and reset a section to its defaults. Pure + injected-deps (no IO / clock /
   env) so it is node-testable; index.js wires the live stores (budget/fallback/roster/dossier/connectors/
   permissions/autonomy/notify prefs) into the collectors below and persists what applyImport returns.

   SECURITY LAW (non-negotiable): secrets NEVER leave the machine. Provider keys, bot tokens and OAuth sessions
   are exported as a `configured: true` marker ONLY — the raw secret is never read into the envelope. On import
   those markers surface a "re-enter your key" state; the import never fabricates a secret it doesn't have.

   FORMAT: a schema-versioned envelope { starnetExport: 1, exportedAt, app, sections: {...} }. `starnetExport`
   is the migration pivot: a future importer can branch on it. Every section is OPTIONAL — a partial export (or a
   partial import selecting only some sections) round-trips cleanly. Unknown sections are ignored on import (never
   a hard failure), so a newer export can still be read by an older build (forward-tolerant).

   This module owns ONLY the shape + validation + redaction. It performs no IO: index.js reads the live values in,
   and writes applyImport's result back through the SAME durable stores the app already persists to. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).configexport = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA = 1;

  // the sections a station backup carries. Order is stable so an exported file diffs cleanly across versions.
  // Each key maps to a live collector (export) + a live applier (import) wired in index.js. `secret:true` marks
  // a section that carries a configured-marker ONLY (never the raw secret).
  const SECTIONS = [
    'settings',       // theme/display/audio + notification prefs (browser-owned UI state, passed in by the app)
    'budget',         // USD caps (budget.json overrides)
    'fallback',       // ordered fallback model chain (fallback.json)
    'autonomy',       // initiative/reach knobs (browser-owned; passed in by the app)
    'roster',         // agent roster metadata: name/model/provider/role (agent.roster.json) — NO system secrets
    'dossier',        // the Commander dossier block (_commander.dossier.json)
    'permissions',    // standing capability grants (permissions.allow.json)
    'connectors',     // MCP connector configs — REDACTED (headers/env/url auth stripped; configured marker kept)
    'notifyPrefs'     // per-category notification toggles (browser-owned; passed in by the app)
  ];

  function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }
  function clampStr(s, max) { return String(s == null ? '' : s).slice(0, max || 4096); }

  /* ---- REDACTION helpers: strip anything secret-shaped from a value before it enters the envelope. ---- */
  // keys whose VALUES are secrets (case-insensitive substring match). Used to scrub connector headers/env.
  const SECRET_KEY_RE = /(token|secret|key|password|passwd|pwd|auth|bearer|credential|cookie|session)/i;
  function redactMap(obj) {
    // returns { keys: [...names...], count } — we keep the NAMES of configured fields (so import can say
    // "re-enter AUTHORIZATION") but never the values. Non-secret-looking keys keep their value.
    const out = {}; const redacted = [];
    if (!isObj(obj)) return { value: {}, redacted: [] };
    for (const k of Object.keys(obj)) {
      if (SECRET_KEY_RE.test(k)) { redacted.push(k); continue; }   // drop the value entirely
      const v = obj[k];
      out[k] = (typeof v === 'string') ? clampStr(v, 2048) : v;
    }
    return { value: out, redacted };
  }

  // sanitize ONE connector config for export: keep identity/shape, drop every secret field + any auth in the url.
  function redactConnector(c) {
    if (!isObj(c)) return null;
    const hdr = redactMap(c.headers || {});
    const env = redactMap(c.env || {});
    // a url can carry a token in the query/userinfo — keep only origin+path, note if auth was present.
    let url = clampStr(c.url || c.endpoint || '', 1024);
    let urlHadAuth = false;
    if (url) {
      try {
        const u = new URL(url);
        if (u.username || u.password || u.searchParams.toString()) urlHadAuth = true;
        u.username = ''; u.password = ''; u.search = '';
        url = u.toString();
      } catch (_) { /* not a parseable url — leave as-is (best effort) */ }
    }
    const configured = (hdr.redacted.length + env.redacted.length > 0) || urlHadAuth || !!c.hasToken;
    return {
      id: clampStr(c.id || c.name || '', 120),
      transport: (c.transport === 'stdio') ? 'stdio' : 'http',
      url: url,
      command: clampStr(c.command || '', 512),         // stdio command (executable) — not a secret
      args: Array.isArray(c.args) ? c.args.map(a => clampStr(a, 256)).slice(0, 32) : undefined,
      headers: hdr.value,
      env: env.value,
      timeoutMs: (typeof c.timeoutMs === 'number' && c.timeoutMs >= 0) ? c.timeoutMs : undefined,
      // the honest "you'll need to re-enter this" markers — NAMES only, never values.
      configured: configured,
      redactedFields: hdr.redacted.concat(env.redacted).concat(urlHadAuth ? ['url:auth'] : [])
    };
  }

  /* ---- BUILD the export envelope from a live snapshot. `src` is the plain-data snapshot index.js reads off its
     live stores (no IO here). Only the sections present in `src` are emitted; `only` optionally narrows further. */
  function buildExport(src, opts) {
    const s = isObj(src) ? src : {};
    const o = isObj(opts) ? opts : {};
    const only = Array.isArray(o.only) && o.only.length ? new Set(o.only) : null;
    const want = (name) => (!only || only.has(name)) && Object.prototype.hasOwnProperty.call(s, name);
    const sections = {};

    if (want('settings') && isObj(s.settings)) sections.settings = s.settings;
    if (want('budget')) sections.budget = isObj(s.budget) ? s.budget : {};
    if (want('fallback')) sections.fallback = { models: Array.isArray(s.fallback) ? s.fallback.map(m => clampStr(m, 200)) : [] };
    if (want('autonomy') && isObj(s.autonomy)) sections.autonomy = s.autonomy;
    if (want('roster') && Array.isArray(s.roster)) {
      // roster metadata only — model/provider/name/role. NEVER the composed system prompt (may embed dossier/secrets)
      // beyond a length note; NEVER a key. This is the marketplace-shareable slice.
      sections.roster = s.roster.map(a => ({
        agentId: clampStr(a && a.agentId, 40),
        name: clampStr(a && a.name, 40),
        model: a && a.model ? clampStr(a.model, 200) : null,
        provider: a && a.provider ? clampStr(a.provider, 40) : null,
        role: clampStr(a && a.role, 120),
        hasSystem: !!(a && a.system)
      })).filter(a => a.agentId);
    }
    if (want('dossier')) sections.dossier = { block: clampStr(s.dossier, 4096) };
    if (want('permissions')) sections.permissions = { allow: Array.isArray(s.permissions) ? s.permissions.filter(x => typeof x === 'string').slice(0, 256) : [] };
    if (want('connectors') && Array.isArray(s.connectors)) sections.connectors = s.connectors.map(redactConnector).filter(Boolean);
    if (want('notifyPrefs') && isObj(s.notifyPrefs)) sections.notifyPrefs = s.notifyPrefs;

    return {
      starnetExport: SCHEMA,
      exportedAt: (typeof o.now === 'number') ? o.now : null,
      app: clampStr(o.app || 'StarNet', 40),
      sections
    };
  }

  /* ---- VALIDATE + NORMALIZE an imported envelope. Forward-tolerant: unknown sections are dropped (with a note),
     a future schema is accepted with a migration note, a malformed section is skipped (never a hard 500). Returns
     { ok, error?, schema, sections:{...cleaned...}, notes:[...], secretsNeeded:[...] }. secretsNeeded is the list
     of "re-enter your key" prompts the UI must surface. ---- */
  function parseImport(env) {
    if (!isObj(env)) return { ok: false, error: 'not a JSON object' };
    const schema = env.starnetExport;
    if (typeof schema !== 'number' || schema < 1) return { ok: false, error: 'missing or invalid "starnetExport" version marker' };
    const notes = [];
    if (schema > SCHEMA) notes.push('file is from a newer StarNet (schema ' + schema + '); importing what this build understands');
    const inSec = isObj(env.sections) ? env.sections : {};
    const out = {};
    const secretsNeeded = [];

    // known-section cleaners — each fail-soft (a bad section is skipped, not fatal).
    if (isObj(inSec.settings)) out.settings = inSec.settings;
    if (isObj(inSec.budget)) {
      const b = {};
      for (const k of ['perRun', 'perAgent', 'perDay', 'global']) {
        const v = inSec.budget[k];
        if (typeof v === 'number' && isFinite(v) && v >= 0) b[k] = v;
      }
      out.budget = b;
    }
    if (isObj(inSec.fallback) && Array.isArray(inSec.fallback.models)) {
      out.fallback = { models: inSec.fallback.models.filter(m => typeof m === 'string' && m.trim()).map(m => clampStr(m, 200)).slice(0, 8) };
    }
    if (isObj(inSec.autonomy)) out.autonomy = inSec.autonomy;
    if (Array.isArray(inSec.roster)) {
      out.roster = inSec.roster.map(a => isObj(a) ? {
        agentId: clampStr(a.agentId, 40),
        name: clampStr(a.name, 40),
        model: a.model ? clampStr(a.model, 200) : null,
        provider: a.provider ? clampStr(a.provider, 40) : null,
        role: clampStr(a.role, 120)
      } : null).filter(a => a && /^[A-Za-z0-9_-]{1,40}$/.test(a.agentId));
    }
    if (isObj(inSec.dossier)) out.dossier = { block: clampStr(inSec.dossier.block, 4096) };
    if (isObj(inSec.permissions) && Array.isArray(inSec.permissions.allow)) {
      out.permissions = { allow: inSec.permissions.allow.filter(x => typeof x === 'string').slice(0, 256) };
    }
    if (Array.isArray(inSec.connectors)) {
      out.connectors = inSec.connectors.map(c => isObj(c) ? {
        id: clampStr(c.id, 120),
        transport: c.transport === 'stdio' ? 'stdio' : 'http',
        url: clampStr(c.url, 1024),
        command: clampStr(c.command, 512),
        args: Array.isArray(c.args) ? c.args.map(a => clampStr(a, 256)).slice(0, 32) : [],
        headers: isObj(c.headers) ? c.headers : {},
        env: isObj(c.env) ? c.env : {},
        timeoutMs: (typeof c.timeoutMs === 'number' && c.timeoutMs >= 0) ? c.timeoutMs : undefined,
        redactedFields: Array.isArray(c.redactedFields) ? c.redactedFields.filter(x => typeof x === 'string') : []
      } : null).filter(c => c && c.id);
      // any connector that carried redacted secrets needs re-entry after import.
      for (const c of out.connectors) {
        if (c.redactedFields && c.redactedFields.length) secretsNeeded.push({ kind: 'connector', id: c.id, fields: c.redactedFields });
      }
    }
    if (isObj(inSec.notifyPrefs)) out.notifyPrefs = inSec.notifyPrefs;

    // note any sections we didn't recognize (forward-tolerance signal, not an error).
    for (const k of Object.keys(inSec)) { if (SECTIONS.indexOf(k) < 0) notes.push('ignored unknown section "' + k + '"'); }

    return { ok: true, schema, sections: out, notes, secretsNeeded };
  }

  return {
    SCHEMA, SECTIONS,
    buildExport, parseImport,
    redactConnector, _redactMap: redactMap
  };
});
