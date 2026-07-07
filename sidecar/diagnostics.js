/* sidecar/diagnostics.js — assemble a PASTE-READY bug-report block from real harness state (T3.9).

   A public user who hits a wall needs to email a useful report without leaking a secret. This module is
   the PURE assembler: given a plain snapshot of already-collected state (index.js does the collecting from
   its live stores), it returns BOTH a structured object and a plain-text block a beginner can paste into an
   email. It performs ZERO IO and ZERO guessing.

   TWO LAWS this module exists to uphold:
   1. TRUTHFUL TELEMETRY — every field is provable from real state the caller passed in. Anything the caller
      couldn't prove is passed as null/'' and rendered as 'unknown' or omitted — never fabricated.
   2. SANITIZATION — the block must NEVER carry an API key, channel/OAuth token, transcript content, or a
      user prompt. The caller injects the always-on `redact` (sidecar/context.js) and EVERY free-text field
      (error tails especially) is run through it here as a second backstop. Structured fields are shape-only
      booleans / enums / short ids that cannot contain a secret by construction.

   makeDiagnostics({ redact }) -> { assemble(snapshot) -> { report, text } }

     snapshot (all optional; missing => 'unknown'/omitted, never invented):
       version:   { harness, app, node }
       platform:  { os, arch, node }            // os/arch from process; harmless
       mode:      'desktop' | 'browser' | ''     // provable from the request origin
       provider:  string                         // active agent's provider id
       model:     string                         // active agent's model SLUG (never a key)
       keyPresent: bool                          // is a credential configured? (bool ONLY — never the key)
       lastRun:   { runId, status, ts } | null   // newest run outcome (status = the run's reason enum)
       errors:    [{ ts, message }]              // recent error tail (messages are redacted here)
       uptimeMs:  number                         // process uptime
       workspacePresent: bool                    // does the workspaces dir exist? (bool ONLY — never the path)
       agentCount: number                        // roster size (shape only)
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).diagnostics = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ERRORS = 5;        // tail length — enough to see a pattern, bounded so the block stays pasteable
  const MSG_MAX = 300;         // per-error message cap after redaction
  const IDENT = /* the fields that are shape-only by construction can still be length-clamped for readability */ 200;

  // collapse control chars + whitespace onto one clamped line (a message must not inject blank lines / smuggle
  // a fake field into the plain-text block). Mirrors runtimeinfo.oneLine's intent; kept local so this stays pure.
  function oneLine(v, max) {
    const s = (v == null ? '' : String(v)).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.slice(0, max || IDENT);
  }
  function bool(v) { return v === true; }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  // ms -> a compact human duration ("2h 13m", "47s") for the readout. Pure, no clock.
  function fmtUptime(ms) {
    ms = num(ms);
    if (ms <= 0) return 'unknown';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const parts = [];
    if (d) parts.push(d + 'd');
    if (h) parts.push(h + 'h');
    if (m) parts.push(m + 'm');
    if (!d && !h) parts.push(sec + 's');   // only show seconds for short uptimes
    return parts.join(' ') || (sec + 's');
  }

  function makeDiagnostics(opts) {
    opts = opts || {};
    // redact is REQUIRED for the sanitization law; degrade to identity only so a misuse can't crash (tests inject the real one).
    const redact = typeof opts.redact === 'function' ? opts.redact : (x => x);
    const redactStr = (s) => oneLine(redact(String(s == null ? '' : s)), MSG_MAX);
    // clamp AND redact any field to a single line — EVERY string field goes through this so a value the caller
    // wrongly treats as a "slug" (a poisoned provider/model) can never smuggle a secret into the block. redact()
    // is a no-op on a real slug, so honest values pass through unchanged; only key-shaped junk is scrubbed.
    const clean = (s, max) => oneLine(redact(String(s == null ? '' : s)), max);

    function assemble(snapshot) {
      const s = snapshot || {};
      const ver = s.version || {};
      const plat = s.platform || {};
      const lastRun = s.lastRun && typeof s.lastRun === 'object' ? s.lastRun : null;

      // ---- structured report (shape-only fields; free text is redacted) ----
      const report = {
        app: clean(ver.app, 40) || 'unknown',
        harness: clean(ver.harness, 40) || 'unknown',
        node: clean(ver.node || plat.node, 40) || 'unknown',
        platform: (clean(plat.os, 40) || 'unknown') + (plat.arch ? ' (' + clean(plat.arch, 20) + ')' : ''),
        mode: (s.mode === 'desktop' || s.mode === 'browser') ? s.mode : 'unknown',
        provider: clean(s.provider, 60) || 'unknown',
        model: clean(s.model, 120) || 'unknown',          // SLUG only — the caller never passes a key here; redacted anyway
        keyPresent: bool(s.keyPresent),
        agentCount: num(s.agentCount),
        uptime: fmtUptime(s.uptimeMs),
        workspacePresent: bool(s.workspacePresent),
        lastRun: lastRun ? {
          runId: clean(lastRun.runId, 80) || 'unknown',
          status: clean(lastRun.status, 40) || 'unknown',
          ts: num(lastRun.ts) || null
        } : null,
        errors: (Array.isArray(s.errors) ? s.errors : []).slice(-MAX_ERRORS).map(e => ({
          ts: num(e && e.ts) || null,
          message: redactStr(e && e.message)   // SECOND redaction backstop over the caller's already-redacted tail
        })).filter(e => e.message)
      };

      return { report, text: render(report) };
    }

    // ---- plain-text block: what a user pastes into a bug-report email ----
    function render(r) {
      const iso = (ts) => { try { return ts ? new Date(ts).toISOString() : ''; } catch (_) { return ''; } };
      const lines = [
        '--- StarNet diagnostics ---',
        'App version:   ' + r.app,
        'Harness:       ' + r.harness,
        'Node:          ' + r.node,
        'Platform:      ' + r.platform,
        'Mode:          ' + r.mode,
        'Provider:      ' + r.provider,
        'Model:         ' + r.model,
        'Credential:    ' + (r.keyPresent ? 'configured' : 'none'),
        'Agents:        ' + r.agentCount,
        'Uptime:        ' + r.uptime,
        'Workspace dir: ' + (r.workspacePresent ? 'present' : 'missing')
      ];
      if (r.lastRun) {
        lines.push('Last run:      ' + r.lastRun.runId + ' — ' + r.lastRun.status + (r.lastRun.ts ? ' @ ' + iso(r.lastRun.ts) : ''));
      } else {
        lines.push('Last run:      none yet');
      }
      lines.push('Recent errors:');
      if (r.errors.length) {
        for (const e of r.errors) lines.push('  · ' + (e.ts ? iso(e.ts) + ' ' : '') + e.message);
      } else {
        lines.push('  (none recorded)');   // the error tail persists across restarts (diag.errors.json) — "this session" would undersell it
      }
      lines.push('--- end diagnostics — contains no keys, tokens, or message content ---');
      return lines.join('\n');
    }

    return { assemble, _internals: { render, fmtUptime, oneLine } };
  }

  return { makeDiagnostics };
});
