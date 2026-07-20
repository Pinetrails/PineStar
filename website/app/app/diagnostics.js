/* STARNET — diagnostics.js : one-click "COPY DIAGNOSTICS" for a paste-ready bug report (T3.9).

   A public user who hits a wall needs to email a useful report without leaking anything. The SIDECAR assembles
   the report server-side from real state (GET /api/diagnostics -> { report, text }); this thin browser module
   just fetches it, copies the plain-text block to the clipboard, and tells the user where to send it.

   The report NEVER contains a key, token, transcript, or prompt — that guarantee lives in the sidecar
   (sidecar/diagnostics.js + the always-on redact()). This file only copies what the sidecar already sanitized.

   ONE constant owns the support destination — SUPPORT_EMAIL — so when the real address changes it is a
   single-line swap (support decision, today: email-only for launch). If that constant is ever left unset OR
   still holds the ANDREW_SUPPORT_EMAIL build placeholder, the app must NOT show a fake/placeholder address:
   `supportEmail()` normalizes to '' in that case and `hasSupport()` reports false, so every render site
   (Settings copy, copy-success toast) OMITS the email clause entirely instead of telling a user to write to a
   placeholder. Truthful-telemetry law: never assert a support address the product can't actually receive at.

   Exposes a `Diag` global: Diag.SUPPORT_EMAIL, Diag.supportEmail(), Diag.hasSupport(), Diag.fetchText(),
   Diag.copy({ notify?, onDone? }). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Diag = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SUPPORT_EMAIL = 'androo.agi@gmail.com';
  // The build-time placeholder that means "no support address chosen yet". Kept as a sentinel so an un-swapped
  // build (or a cleared constant) is treated as "unconfigured" — never rendered literally to a user.
  const SUPPORT_PLACEHOLDER = 'ANDREW_SUPPORT_EMAIL';

  // Pure normalizer (testable without mutating the const): a raw support value → a plausible address or ''.
  // '' whenever the value is empty, still the placeholder sentinel, or not a plausible email (an '@' with
  // non-space text either side). This is the ONE gate that keeps a placeholder/unset value from ever rendering.
  function normSupport(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || s === SUPPORT_PLACEHOLDER) return '';
    return /^[^@\s]+@[^@\s]+$/.test(s) ? s : '';
  }
  // The normalized support destination for THIS build, or '' when none is configured. Every render site (Settings
  // copy, copy toast) calls this so a placeholder/unset value omits the email clause instead of faking one.
  function supportEmail() { return normSupport(SUPPORT_EMAIL); }
  // is a real support address configured? (bool — drives whether the email clause renders at all.)
  function hasSupport() { return supportEmail() !== ''; }

  // clipboard write — mirrors chat.js copyText (Clipboard API with a legacy execCommand fallback). Local so this
  // module has no cross-file dependency and works even if chat.js hasn't loaded (e.g. very early boot).
  function copyToClipboard(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
      }
    } catch (_) {}
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea'); ta.value = text;
      ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (_) { return false; }
  }

  // GET the paste-ready block from the sidecar. window.fetch is token-hardened for /api/ (harness.js), so a bare
  // fetch carries the API token automatically. Returns the plain-text string, or '' on any failure.
  function fetchText() {
    return fetch('/api/diagnostics', { cache: 'no-store' })
      .then(r => (r && r.ok) ? r.json() : null)
      .then(j => (j && typeof j.text === 'string') ? j.text : '')
      .catch(() => '');
  }

  function notify(msg, kind) {
    try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(msg, kind || 'good'); } catch (_) {}
  }

  /* P1.5 build provenance: the git commit/tree + taxonomy this desktop binary was compiled from (stamped by
     src-tauri/build.rs, exposed via the starnet_build_info Tauri command). Returns a formatted one-liner
     "build <version> @ <commit> [<kind> tree <prefix>][ DIRTY]" or '' when unavailable — in a plain browser there is NO
     binary provenance to report, so this MUST fail soft to '' and the caller omits the line. Truthful-telemetry:
     never render a fake commit for a browser session that wasn't built from any binary. */
  function tauriCore() {
    try {
      return (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core &&
        typeof window.__TAURI__.core.invoke === 'function') ? window.__TAURI__.core : null;
    } catch (_) { return null; }
  }
  // Format a build-info object into the one honest line, or '' if it's missing/malformed.
  function formatBuild(info) {
    if (!info || typeof info !== 'object') return '';
    const version = String(info.version || '').trim();
    const commit = String(info.commit || '').trim();
    if (!version && !commit) return '';
    let line = 'build ' + (version || '?') + ' @ ' + (commit || 'unknown');
    const tree = String(info.sourceTree || '').trim().toLowerCase();
    let kind = String(info.provenanceKind || '').trim().toLowerCase();
    if (info.dirty) kind = 'dirty-dev';
    // `official` is earned only by external installed-artifact evidence. BuildInfo reports
    // the binary's base class, so a self-asserted official value is displayed as custom.
    if (kind === 'official') kind = 'custom';
    if (['reproducible-source', 'custom', 'dirty-dev'].includes(kind) && /^[0-9a-f]{40}$/.test(tree)) {
      line += ' [' + kind + ' tree ' + tree.slice(0, 12) + ']';
    }
    if (info.dirty) line += ' DIRTY';
    return line;
  }
  // Resolve the build line asynchronously. In browser mode (no Tauri) → '' (no binary, nothing to prove).
  function buildLine() {
    const core = tauriCore();
    if (!core) return Promise.resolve('');   // browser session — fail soft, omit the line
    return Promise.resolve(core.invoke('starnet_build_info')).then(formatBuild).catch(() => '');   // old shell w/o the command → ''
  }

  /* Fetch → copy → tell the user. opts.notify (default true) shows a toast; opts.onDone(ok, text) fires after.
     Always resolves (never throws) with the boolean success so a caller can flip button state. */
  function copy(opts) {
    opts = opts || {};
    const wantNotify = opts.notify !== false;
    return fetchText().then(text => {
      if (!text) { if (wantNotify) notify('could not read diagnostics — is the app still running?', 'warn'); if (opts.onDone) opts.onDone(false, ''); return false; }
      return copyToClipboard(text).then(ok => {
        // Honest copy: name the support address only when one is actually configured; otherwise just confirm the
        // copy (no placeholder, no fake address). A user is never told to email an address that can't receive.
        const dest = supportEmail();
        const okMsg = dest ? ('diagnostics copied — paste it into an email to ' + dest) : 'diagnostics copied — paste it into a bug report';
        if (wantNotify) notify(ok ? okMsg : 'copy failed — the report is shown below, select it and copy manually', ok ? 'good' : 'warn');
        if (opts.onDone) opts.onDone(!!ok, text);
        return !!ok;
      });
    });
  }

  /* THE COPY-FAILURE FALLBACK (T3.9): clipboard writes fail silently on some desktops / locked-down browsers, which
     strands a user who was told "copied" but has nothing on their clipboard. showBlock(host) renders the diagnostic
     text ON-SCREEN in a selectable <pre> with a "copy again" button, so the report is ALWAYS obtainable manually.
     Idempotent per host (reuses its own `.diag-block` node). opts.text pre-supplies the text (e.g. the block a failed
     copy() already fetched — avoids a second round-trip); otherwise it fetches. Resolves with the rendered text (''
     on failure). Never throws — a stuck user must never hit a second dead-end here. */
  function showBlock(host, opts) {
    opts = opts || {};
    if (!host || !host.appendChild) return Promise.resolve('');
    const paint = (text) => {
      if (!text) {
        let err = host.querySelector('.diag-block');
        if (!err) { err = document.createElement('div'); err.className = 'diag-block msg'; host.appendChild(err); }
        err.textContent = 'could not read diagnostics — is the app still running?';
        return '';
      }
      let block = host.querySelector('.diag-block');
      if (!block) {
        block = document.createElement('div');
        block.className = 'diag-block';
        const pre = document.createElement('pre');
        pre.className = 'diag-pre';
        // selectable + scrollable; wraps long lines so nothing overflows the panel horizontally.
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.overflow = 'auto';
        pre.style.maxHeight = '40vh';
        pre.setAttribute('tabindex', '0');
        block.appendChild(pre);
        const bar = document.createElement('div'); bar.className = 'diag-block-bar';
        const again = document.createElement('button'); again.type = 'button'; again.className = 'bb sm'; again.textContent = '📋 copy again';
        again.addEventListener('click', () => {
          const t = pre.textContent || '';
          copyToClipboard(t).then(ok => {
            again.textContent = ok ? '✓ copied' : 'select the text above to copy';
            if (ok) setTimeout(() => { try { again.textContent = '📋 copy again'; } catch (_) {} }, 2000);
          });
        });
        bar.appendChild(again);
        // help the manual path: one click selects the whole block so Ctrl+C just works.
        const selectAll = document.createElement('button'); selectAll.type = 'button'; selectAll.className = 'bb sm'; selectAll.textContent = 'select all';
        selectAll.addEventListener('click', () => {
          try { const r = document.createRange(); r.selectNodeContents(pre); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); pre.focus(); } catch (_) {}
        });
        bar.appendChild(selectAll);
        block.appendChild(bar);
        host.appendChild(block);
      }
      block.querySelector('.diag-pre').textContent = text;
      block.hidden = false;
      return text;
    };
    if (typeof opts.text === 'string' && opts.text) return Promise.resolve(paint(opts.text));
    return fetchText().then(paint).catch(() => paint(''));
  }

  return { SUPPORT_EMAIL, supportEmail, hasSupport, fetchText, copy, showBlock, buildLine, _internals: { copyToClipboard, fallbackCopy, normSupport, SUPPORT_PLACEHOLDER, formatBuild, tauriCore } };
});
