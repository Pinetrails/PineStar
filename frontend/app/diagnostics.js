/* STARNET — diagnostics.js : one-click "COPY DIAGNOSTICS" for a paste-ready bug report (T3.9).

   A public user who hits a wall needs to email a useful report without leaking anything. The SIDECAR assembles
   the report server-side from real state (GET /api/diagnostics -> { report, text }); this thin browser module
   just fetches it, copies the plain-text block to the clipboard, and tells the user where to send it.

   The report NEVER contains a key, token, transcript, or prompt — that guarantee lives in the sidecar
   (sidecar/diagnostics.js + the always-on redact()). This file only copies what the sidecar already sanitized.

   ONE constant owns the support destination — SUPPORT_EMAIL — so when Andrew picks the real address it is a
   single-line swap (support decision, today: email-only for launch).

   Exposes a `Diag` global: Diag.SUPPORT_EMAIL, Diag.fetchText(), Diag.copy({ notify?, onDone? }). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Diag = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // PLACEHOLDER — swap for the real address when Andrew picks it. Kept as a visible token so nothing ships a fake
  // "support@…" that would silently drop a user's report. The UI shows it verbatim so the copy stays honest.
  const SUPPORT_EMAIL = 'ANDREW_SUPPORT_EMAIL';

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

  /* Fetch → copy → tell the user. opts.notify (default true) shows a toast; opts.onDone(ok, text) fires after.
     Always resolves (never throws) with the boolean success so a caller can flip button state. */
  function copy(opts) {
    opts = opts || {};
    const wantNotify = opts.notify !== false;
    return fetchText().then(text => {
      if (!text) { if (wantNotify) notify('could not read diagnostics — is the sidecar running?', 'warn'); if (opts.onDone) opts.onDone(false, ''); return false; }
      return copyToClipboard(text).then(ok => {
        if (wantNotify) notify(ok ? 'diagnostics copied — paste it into an email to ' + SUPPORT_EMAIL : 'copy failed — the report is safe to paste manually', ok ? 'good' : 'warn');
        if (opts.onDone) opts.onDone(!!ok, text);
        return !!ok;
      });
    });
  }

  return { SUPPORT_EMAIL, fetchText, copy, _internals: { copyToClipboard, fallbackCopy } };
});
