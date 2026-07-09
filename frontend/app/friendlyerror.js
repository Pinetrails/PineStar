/* STARNET — friendlyerror.js : turn a raw failure into something a beginner can act on.
   Pure + testable (UMD: a `Friendly` global in the browser, module.exports under node).

   The COMMS panel used to surface raw plumbing on a failed turn — "sidecar HTTP 500", an OpenRouter
   payload, a capdenied string — and the ↻ retry chip fired blindly regardless of WHY it failed. This
   maps any error (the thrown Error from Harness.chat + an optional HTTP status) to:

     friendlyError(err, status) -> { userMessage, kind, retryable, action, raw }

   • userMessage — one plain-language sentence to LEAD the error row with.
   • kind        — a stable class (mirrors the sidecar classifier's reasons, plus the UI-level
                   `network` / `capdenied` / `user_abort` cases the browser sees but the API layer doesn't).
   • retryable   — whether a plain "↻ Try again" makes sense.
   • action      — null | 'settings' | 'skills' | 'store' | 'refit' | 'reload': a context-aware DESTINATION
                   instead of a blind retry. capdenied's true unlock is REFIT (place the gear) —
                   NOT the SKILLS list — because a station quest, minted on the denial, completes
                   by PLACEMENT (stationqueststore.js). auth/no-key opens the PROVIDERS key field.
   • cap         — (capdenied only) the resolved capability id ('web'|'cabinet'|…) parsed from the
                   raw 'no <need> — …' message, so copy can name WHICH power was missing + its gear.
   • raw         — the original technical text, kept for a de-emphasized sub-line / title tooltip.

   RENDERING THE ACTION (the door): `actionButton(verdict)` maps a verdict to { label, run } — a
   ready-to-wire button that OPENS the exact surface (Build.open() for REFIT, the settings PROVIDERS
   section for keys, StationUI SKILLS for a skill toggle). The consumer (chat.js offerRetry) calls
   it instead of re-deriving the label/route per action, so a new action door is added in ONE place.

   INTEGRATION (not duplication): when the sidecar classifier module is reachable (node/tests), we delegate
   to classifyApiError() to derive the reason, then translate that reason into a beginner-facing message —
   so the truth table stays single-sourced. In the browser the sidecar module isn't loaded, so we fall back
   to a lightweight pattern-match over the SAME kind vocabulary on the UI-level error strings Harness throws
   ('sidecar HTTP <status>', 'cannot reach the STARNET sidecar…', a forwarded 'no <cap> — …'). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Friendly = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // optional: the sidecar's pure API-error classifier (node/test only). Never required in the browser.
  let classifyApiError = null;
  try { if (typeof require === 'function') classifyApiError = require('../../sidecar/providers/errorClass.js').classifyApiError; } catch (_) {}

  // The capability a `no <need> — …` denial names → the plain power word + the placeable GEAR that grants it.
  // Single-sourced from the sidecar's capsummary CAPS table (id/object) + worldmodel's CAP_LABEL power words, so
  // a beginner reads "needs FILE ACCESS — the CABINET isn't on station" instead of a raw cap token. `compute` is
  // the loop's turn-precondition (the DESK/workstation); the rest are placeable floor gear closed in REFIT.
  const CAP_INFO = {
    compute:      { power: 'a WORKSTATION', gear: 'a DESK',       does: 'run at all' },
    web:          { power: 'WEB ACCESS',    gear: 'a DISH',       does: 'search or fetch the web' },
    cabinet:      { power: 'FILE ACCESS',   gear: 'a CABINET',    does: 'read or write files' },
    workbench:    { power: 'a TERMINAL',    gear: 'a WORKBENCH',  does: 'run commands or control the computer' },
    memory:       { power: 'MEMORY',        gear: 'a NOTEBOOK',   does: 'keep long-term memory' },
    studio:       { power: 'IMAGE TOOLS',   gear: 'a STUDIO',     does: 'generate or analyze images' },
    jukebox:      { power: 'SPOTIFY',       gear: 'a JUKEBOX',    does: 'search or control Spotify' },
    orchestrator: { power: 'the LEAD role', gear: 'the ORCHESTRATOR role', does: 'delegate to crew' }
  };
  // aliases the raw message may carry for the same capability (prop objectType ↔ cap id, or a tool family word).
  const CAP_ALIAS = {
    computer: 'compute', desk: 'compute', workstation: 'compute',
    dish: 'web', search: 'web', browser: 'web', fetch: 'web',
    files: 'cabinet', file: 'cabinet', fs: 'cabinet',
    terminal: 'workbench', shell: 'workbench', exec: 'workbench', desktop: 'workbench',
    notebook: 'memory', recall: 'memory',
    images: 'studio', image: 'studio',
    spotify: 'jukebox', music: 'jukebox'
  };

  // kind -> beginner-facing copy + whether a plain retry helps + where to send them instead.
  // action: 'settings' (fix the model key) · 'refit' (place the missing gear) · 'skills' (toggle a skill
  //   family) · 'store' (top up managed credit) · null (just retry / nothing).
  const KINDS = {
    server_error:  { retryable: true,  action: null,       msg: 'The local StarNet service hit an error — give it a moment and try again.' },
    network:       { retryable: true,  action: null,       msg: "Can't reach StarNet's local service — make sure the app is still running, then try again." },
    rate_limit:    { retryable: true,  action: null,       msg: 'The model provider is busy (too many requests) — wait a few seconds and try again.' },
    // auth: the pure message is context-blind (classify time can't know if ChatGPT is already connected). It names the
    // one honest next step; the action BUTTON (actionButton) tailors the door — "add a key" vs "sign in with ChatGPT".
    auth:          { retryable: false, action: 'settings', msg: 'No model is connected yet — add a provider key (or sign in with ChatGPT) to let it run.' },
    oauth:         { retryable: false, action: 'settings', msg: 'Your ChatGPT sign-in expired — reconnect it (or add a provider key instead).' },
    billing:       { retryable: false, action: 'settings', msg: "Your provider account is out of credit — top it up, then try again." },
    // managed StarNet credits ran out (only reachable when a managed-credit backend is wired). Point at the STORE
    // to top up; a BYOK station never hits this kind (it gets `billing`/`auth` instead).
    managed_credit:{ retryable: false, action: 'store',    msg: "You're out of StarNet credits — add more in the STORE, or connect your own provider key." },
    // capdenied copy is REBUILT per-error in friendlyError() to name the exact power + gear; this is the fallback
    // when the capability can't be parsed. The door is REFIT (place the gear), NOT the SKILLS list.
    capdenied:     { retryable: false, action: 'refit',    msg: "This task needed a tool this agent doesn't have on station yet — open REFIT to place the gear it's missing." },
    timeout:       { retryable: true,  action: null,       msg: 'That took too long and timed out — try again.' },
    user_abort:    { retryable: false, action: null,       msg: 'Stopped.' },
    context_overflow: { retryable: false, action: null,    msg: 'This conversation got too long for the model — start a fresh chat or shorten it.' },
    model_not_found:  { retryable: false, action: 'settings', msg: "That model isn't available — pick a different one in Settings." },
    content_policy_blocked: { retryable: false, action: null, msg: 'The model declined that request on safety grounds — try rephrasing it.' },
    // JUKEBOX is placed (the Spotify tools ARE granted) but Spotify's OAuth session isn't connected yet — the
    // real second half of the unlock chain. The door is SETTINGS (connect Spotify), NOT REFIT (the gear is
    // already on station), so this is distinct from `capdenied` which fires when no JUKEBOX is placed at all.
    spotify_not_connected: { retryable: false, action: 'settings', msg: 'The JUKEBOX is on station, but Spotify isn’t connected yet — connect it in Settings, then try again.' },
    // the one-run-at-a-time mutex: the SIDECAR message names the holder (age/source) + the doors (ROUTINES,
    // E-STOP) — friendlyError passes it through verbatim instead of flattening to `unknown` (2026-07-07 escape:
    // the user got "Something went wrong" in a loop while the real answer was one sentence away).
    agent_busy:    { retryable: true,  action: null,       msg: 'That agent is still busy with a previous run — wait for it to finish, or press E-STOP to abort everything.' },
    // the SIDECAR's own token gate said no (a 403 with "forbidden token/origin/host"): after a sidecar
    // crash+respawn the page still holds the OLD X-StarNet-Token, so EVERY action 403s. Retrying is doomed and
    // "add a key" is the wrong door — the page needs the fresh boot token, which only a reload fetches.
    stale_session: { retryable: false, action: 'reload',   msg: 'The station restarted — reload this page to reconnect.' },
    unknown:       { retryable: true,  action: null,       msg: 'Something went wrong on that turn — try again.' }
  };

  // the sidecar classifier speaks in `reason`s; map each onto our UI kind. (Most are 1:1; `overloaded` and
  // `format_error` fold into the closest beginner-facing bucket.)
  const REASON_TO_KIND = {
    auth: 'auth', billing: 'billing', rate_limit: 'rate_limit', overloaded: 'server_error',
    server_error: 'server_error', timeout: 'timeout', context_overflow: 'context_overflow',
    model_not_found: 'model_not_found', content_policy_blocked: 'content_policy_blocked',
    format_error: 'unknown', unknown: 'unknown'
  };

  function rawText(err) {
    if (err == null) return '';
    if (typeof err === 'string') return err;
    return String((err && err.message) || err);
  }
  // a user-initiated stop (Esc / Stop button → AbortController) reads as an AbortError or an "abort" message.
  // A user abort is NOT a fault — it must not produce a scary error row.
  function isUserAbort(err) {
    if (!err || typeof err === 'string') return /\babort/i.test(String(err || ''));
    return err.name === 'AbortError' || /\babort/i.test(String(err.message || ''));
  }

  // Parse WHICH capability a capdenied names, from the raw error text. The sidecar/harness build the message as
  //   'no <need> — <reason>'   (need ∈ compute|web|cabinet|workbench|memory|studio|jukebox), OR
  //   'capability denied: no capability for <tool> in room <room>'  (a tool-level denial, cap unknown up front).
  // Returns a CAP_INFO key or null. Never throws.
  function capFromRaw(raw) {
    const low = String(raw || '').toLowerCase();
    // preferred shape: "no <need> — …" — pull the word between "no " and the em/en dash or hyphen separator.
    let m = low.match(/\bno\s+([a-z_]+)\s*[—–-]/);
    let word = m ? m[1] : null;
    if (!word) { m = low.match(/\bno\s+([a-z_]+)\s+capability\b/); word = m ? m[1] : null; }
    if (word) {
      if (CAP_INFO[word]) return word;
      if (CAP_ALIAS[word]) return CAP_ALIAS[word];
    }
    // fall back to any capability/alias token appearing anywhere in the message (e.g. the tool-level denial text).
    for (const k of Object.keys(CAP_INFO)) { if (new RegExp('\\b' + k + '\\b').test(low)) return k; }
    for (const a of Object.keys(CAP_ALIAS)) { if (new RegExp('\\b' + a + '\\b').test(low)) return CAP_ALIAS[a]; }
    return null;
  }

  // Build the beginner capdenied sentence naming the exact power + its gear, e.g.
  //   "This task needs FILE ACCESS — the CABINET isn't on station. Open REFIT to place it."
  // Falls back to the generic KINDS.capdenied copy when the capability can't be parsed.
  function capdeniedMessage(cap) {
    const info = cap && CAP_INFO[cap];
    if (!info) return KINDS.capdenied.msg;
    return 'This task needs ' + info.power + ' — ' + info.gear + " isn't on station. Open REFIT to place it and try again.";
  }

  // browser fallback: classify the UI-level error string + optional HTTP status into a kind, using the SAME
  // vocabulary the sidecar reasons map onto. Order: most-specific intent first.
  function kindFromRaw(raw, status) {
    const low = String(raw || '').toLowerCase();
    // Harness pre-flight guards ("no API key set" / "no model selected"): a misconfig, not a fault — point at
    // Settings instead of offering a doomed retry. (Match before capdenied, which the em-dash-less strings miss.)
    if (/chatgpt.*sign-?in|sign-?in.*chatgpt|not signed in to chatgpt|codex_not_connected|codex auth|codex_auth|chatgpt subscription.*connect/.test(low)) return 'oauth';
    if (/no api key set|no model selected/.test(low)) return 'auth';
    // a forwarded capability denial ("no web — …" / "capdenied")
    if (/\bcapdenied\b/.test(low) || /^no\s+\w+\s+—/.test(low) || /needs a capability|capability.*(off|denied)/.test(low)) return 'capdenied';
    // the sidecar is unreachable (fetch threw — Harness throws "cannot reach the STARNET sidecar…")
    if (/cannot reach|can'?t reach|unreachable|failed to fetch|fetch failed|networkerror|load failed|connection (refused|reset)|disconnected/.test(low)) return 'network';
    // content / policy beats a status
    if (/content[ _]?policy|moderation|flagged|safety|content_filter/.test(low)) return 'content_policy_blocked';
    // HTTP status from "sidecar HTTP <status>" or an explicit status arg
    const s = status || (low.match(/\b(?:http|status)\s+(\d{3})\b/) ? Number(RegExp.$1) : null);
    if (s) {
      // OUR OWN sidecar's token gate (crash+respawn → stale X-StarNet-Token): a "sidecar HTTP 403" throw or a
      // "forbidden token/origin/host" body means reload for the fresh boot token — never the provider-key door.
      if (s === 403 && (/sidecar http/.test(low) || /\bforbidden\b/.test(low))) return 'stale_session';
      if (s === 401 || s === 403) return 'auth';
      if (s === 402) return /(resets? at|retry[- ]?after|rate limit)/.test(low) ? 'rate_limit' : 'billing';
      if (s === 404) return 'model_not_found';
      if (s === 408 || s === 504) return 'timeout';
      if (s === 429) return 'rate_limit';
      if (s >= 500) return 'server_error';
      if (s === 400 || s === 413 || s === 422) return /context length|maximum context|context window|too many tokens|reduce the length/.test(low) ? 'context_overflow' : 'unknown';
    }
    // message patterns (no status / in-band error text)
    if (/rate limit|too many requests|rate-limit/.test(low)) return 'rate_limit';
    if (/insufficient|out of credit|not enough credit|quota|payment required|add credits|billing/.test(low)) return 'billing';
    if (/unauthorized|invalid api key|invalid key|no auth credentials|authentication|key was rejected|rejected/.test(low)) return 'auth';
    if (/no endpoints|model not found|not a valid model|unknown model/.test(low)) return 'model_not_found';
    if (/timed out|timeout/.test(low)) return 'timeout';
    if (/context length|maximum context|context window|too many tokens/.test(low)) return 'context_overflow';
    return 'unknown';
  }

  /* err: the thrown Error / in-band error string from Harness.chat. status: an optional HTTP status if the
     caller has it separately. Returns a complete, well-typed verdict — never throws. */
  function friendlyError(err, status) {
    const raw = rawText(err);
    if (isUserAbort(err)) {
      const k = KINDS.user_abort;
      return { userMessage: k.msg, kind: 'user_abort', retryable: k.retryable, action: k.action, raw: raw };
    }
    let kind = null;
    // Managed-credit exhaustion (only emitted when a credits backend is wired) — a UI-level fault the sidecar
    // classifier doesn't model. Catch it before everything else so the CTA points at the STORE, not blind retry.
    if (/managed credit|add credits in the store|out of managed credit/.test(raw.toLowerCase())) {
      kind = 'managed_credit';
    } else
    // Harness pre-flight misconfig ("no API key set" / "no model selected") is UI-level — catch before delegating
    // (the sidecar classifier never sees these) so both paths point at Settings, not a blind retry.
    // `sign[- ]?in` (space allowed): the sidecar's dead-refresh-token errors say "Sign in with ChatGPT again"
    // — the old `sign-?in` missed the space and the consumed-token escape fell through to a generic door.
    if (/chatgpt.*sign[- ]?in|sign[- ]?in.*chatgpt|not signed in to chatgpt|codex_not_connected|codex auth|codex_auth|codex (token )?refresh|refresh_token_reused|chatgpt subscription.*connect/.test(raw.toLowerCase())) {
      kind = 'oauth';
    } else if (/no api key set|no model selected/.test(raw.toLowerCase())) {
      kind = 'auth';
    } else if (/spotify is not connected|spotify.*not connected|connect (it in settings|spotify)/.test(raw.toLowerCase())) {
      // the JUKEBOX is placed but Spotify's OAuth isn't linked — a settings step, not a REFIT one.
      kind = 'spotify_not_connected';
    } else if (/\bcapdenied\b/.test(raw.toLowerCase()) || /^no\s+\w+\s+—/.test(raw.toLowerCase()) || /needs a capability/.test(raw.toLowerCase())) {
      // a capability denial is UI-level (the sidecar classifier doesn't model it) — catch it before delegating.
      kind = 'capdenied';
    } else if (/already running a task/.test(raw.toLowerCase())) {
      // the per-agent run mutex — UI-level, and the sidecar message already names the holder + doors.
      kind = 'agent_busy';
    } else if (/sidecar http 403\b/.test(raw.toLowerCase()) || (status === 403 && /\bforbidden\b/.test(raw.toLowerCase()))) {
      // OUR OWN sidecar's token gate said no (stale X-StarNet-Token after a crash+respawn) — UI-level, caught
      // BEFORE delegating: the sidecar API classifier would read a bare 403 as provider `auth` and the error row
      // would offer "🔑 Add a key", the wrong door (EL-11 FIX 2). The only fix is the fresh boot token → reload.
      kind = 'stale_session';
    } else if (classifyApiError) {
      // delegate to the single-sourced truth table; synthesize the err shape it expects (status + message).
      try {
        const probe = (err && typeof err === 'object') ? err : new Error(raw);
        if (status != null && probe.status == null) { try { probe.status = status; } catch (_) {} }
        const verdict = classifyApiError(probe, {});
        kind = REASON_TO_KIND[verdict.reason] || 'unknown';
        // a bare network failure ("cannot reach the sidecar") classifies as `unknown` upstream (it never reached
        // the API) — promote it to the friendlier `network` bucket so the message points at the sidecar.
        if (kind === 'unknown' && /cannot reach|can'?t reach|unreachable|failed to fetch|fetch failed|networkerror|disconnected/.test(raw.toLowerCase())) kind = 'network';
      } catch (_) { kind = kindFromRaw(raw, status); }
    } else {
      kind = kindFromRaw(raw, status);
    }
    const k = KINDS[kind] || KINDS.unknown;
    // capdenied: name the exact power + gear parsed from the raw message, and route to REFIT (the true unlock —
    // a station quest minted on this denial completes by PLACEMENT, not a SKILLS toggle).
    if (kind === 'capdenied') {
      const cap = capFromRaw(raw);
      return { userMessage: capdeniedMessage(cap), kind: kind, retryable: k.retryable, action: k.action, cap: cap, raw: raw };
    }
    // agent_busy: the sidecar composed the full truthful sentence (who holds the agent, since when, the doors)
    // — show THAT, not a flattened generic. Falls back to the canned line if the raw is somehow bare.
    if (kind === 'agent_busy' && /already running a task/.test(raw.toLowerCase())) {
      return { userMessage: raw, kind: kind, retryable: k.retryable, action: k.action, raw: raw };
    }
    return { userMessage: k.msg, kind: kind, retryable: k.retryable, action: k.action, raw: raw };
  }

  /* ---- The DOOR: map a verdict to a ready-to-wire action button { label, run }. ONE place owns every
     error→surface route, so the consumer (chat.js offerRetry) never re-derives per-action labels/wiring, and a
     new door is added here alone. Returns null when the verdict has no actionable door (a plain retry / nothing).
     run() is a no-op-safe opener: it feature-detects each global (Build / StationUI / Harness) so it degrades
     quietly if a surface isn't loaded, never throwing. Routing is context-aware where it matters:
       • auth/oauth → if ChatGPT (Codex) is already connected, offer "sign in with ChatGPT"; else the key field.
       • capdenied  → REFIT (Build.open) — place the missing gear the message just named.
       • settings/store → the PROVIDERS section of Settings (openSettingsSection when Lane C ships it; plain
         openTerm('settings') is the safe fallback until then).                                                */
  function codexConnected() {
    try {
      if (typeof Harness === 'undefined') return false;
      if (Harness.hasStoredCredential) return !!Harness.hasStoredCredential('codex');
      if (Harness.getProv) return Harness.getProv() === 'codex';
    } catch (_) {}
    return false;
  }
  // open Settings, landing on a specific section when the host supports it (Lane C's openTerm(key, section)); the
  // bare openTerm('settings') is the graceful fallback so this works today.
  function openSettings(section) {
    if (typeof StationUI === 'undefined') return;
    try {
      if (section && StationUI.openTerm && StationUI.openTerm.length >= 2) { StationUI.openTerm('settings', section); return; }
      if (StationUI.openTerm) StationUI.openTerm('settings');
    } catch (_) { try { if (StationUI.openTerm) StationUI.openTerm('settings'); } catch (_) {} }
  }
  function actionButton(verdict) {
    if (!verdict) return null;
    switch (verdict.action) {
      case 'refit':
        return { label: '🔧 Open REFIT', run: () => { try { if (typeof Build !== 'undefined' && Build.open) Build.open(); else if (typeof Build !== 'undefined' && Build.toggle && !(Build.isOpen && Build.isOpen())) Build.toggle(); } catch (_) {} } };
      case 'settings':
        // A codex sign-in-class failure (dead/consumed refresh token, not-signed-in) ALWAYS gets the reconnect
        // door — the 2026-07-08 escape was exactly this error landing with only a generic "add a key" path.
        // Settings→PROVIDERS is where the row's ⏼ RE-SIGN-IN action now lives.
        if (verdict.kind === 'oauth')
          return { label: '⏼ RECONNECT CHATGPT', run: () => openSettings('providers') };
        // other auth/no-key: if ChatGPT is already the connected brain, the honest door is still "reconnect";
        // otherwise the provider key field. Both land on the same PROVIDERS section.
        if (verdict.kind === 'auth' && codexConnected())
          return { label: '⏼ RECONNECT CHATGPT', run: () => openSettings('providers') };
        if (verdict.kind === 'auth')
          return { label: '🔑 Add a key', run: () => openSettings('providers') };
        return { label: '⚙ Open Settings', run: () => openSettings(verdict.kind === 'model_not_found' ? 'models' : 'providers') };
      case 'reload':
        // stale_session: the page holds a dead boot token — a reload is the ONE honest reconnect (the token is
        // injected at serve time; there is no in-page re-fetch handshake). Degrades quietly outside a browser.
        return { label: '↻ RELOAD & RECONNECT', run: () => { try { if (typeof location !== 'undefined' && location.reload) location.reload(); } catch (_) {} } };
      case 'store':
        return { label: '🛒 Open STORE', run: () => openSettings('providers') };
      case 'skills':
        return { label: '✦ Open SKILLS', run: () => { try { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('skills'); } catch (_) {} } };
      default:
        return null;
    }
  }

  return { friendlyError, actionButton, KINDS, CAP_INFO,
    _internals: { kindFromRaw, isUserAbort, REASON_TO_KIND, capFromRaw, capdeniedMessage, codexConnected } };
});
