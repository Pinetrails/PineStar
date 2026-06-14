/* sidecar/permissions.js — the informed-consent broker (roadmap P1.5a).

   A PURE, injected-dependency decision function that the host dispatch pipeline consumes as
   `ctx.consent(call, tool)` (registry.js:76). It performs NO IO, never reads the wall clock, and
   never touches process.env: the frozen Full-Access bypass, the session/permanent grant stores, the
   persist() sink, the per-tool network hint, and the interactive prompt() channel are all injected by
   the sidecar edge (index.js) so the same module is deterministic and headless-testable.

   makeConsentBroker({ bypass, hardline, sessionKey, grantsSession, grantsPermanent, persist,
                       networkOf, surface, prompt, grantsBlanket }) -> consent
     consent(call, tool)              -> { allow, reason, scope } | Promise<…>   // the four-tier ladder
     consent.grant(decision,call,tool)-> { allow, reason, scope }   // record a human once/session/always/full decision
     consent.snapshot()               -> { permanent:[...], session:{...} }   // read-only, for tests/telemetry

   The ladder, in FIXED order (each tier short-circuits):
     1. HARDLINE — an injected, unconditional deny floor; checked FIRST so no flag can reach past it.
                   Its reason carries an anti-retry suffix so the model stops re-attempting it.
     2. BYPASS   — Full Access: allow anything NOT on the hardline floor (flag frozen at boot upstream).
     3. CACHE    — allow if this dangerKey was previously granted for THIS session, permanently, or under
                   a blanket full-access grant ('*' in grantsBlanket).
     4. RESOLVE  — a read-only, non-network call auto-allows; a mutation with no grant DEFAULT-DENIES
                   under an autonomous surface ('silence is not consent'). Under an INTERACTIVE surface
                   with a wired prompt(), it asks the human and routes the answer back through grant();
                   with no prompt wired, it fails closed. Only this branch is async — tiers 1–3 and the
                   read-only/autonomous paths stay synchronous, so direct-result callers are unaffected.

   dangerKey = (tool.capability || tool.name) + ':' + tool.scope — the danger CLASS, never args/paths/keys.
   (The makeTool object carries no `network` flag — that lives in resolved.networkCaps — so the read-only
    tier asks the injected networkOf(); index.js wires it to (call)=>!!resolved.networkCaps[call.name].) */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).permissions = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // appended to every hardline denial: stop the model from burning turns re-attempting a floor-blocked action.
  const ANTI_RETRY = ' — do this yourself outside the agent; do not retry or rephrase.';
  // returned when an autonomous run reaches an ungranted mutation: the absence of a human yes is a NO.
  const SILENCE = 'autonomous run cannot self-approve this action — silence is not consent';

  function scopeOf(tool) { return (tool && tool.scope) || 'read'; }

  function dangerKey(tool) {
    const cls = (tool && (tool.capability || tool.name)) || 'unknown';
    return cls + ':' + scopeOf(tool);
  }

  // The makeTool object has no network flag; the sidecar edge injects networkOf when wiring. The
  // default consults tool/call hints so the read-only tier is still correct in isolation.
  function defaultNetworkOf(call, tool) {
    return !!(tool && tool.network) || !!(call && call.network);
  }

  function makeConsentBroker(opts) {
    opts = opts || {};
    const bypass = !!opts.bypass;
    const hardline = typeof opts.hardline === 'function' ? opts.hardline : null;
    const sessionKey = opts.sessionKey || 'default';
    const grantsSession = opts.grantsSession instanceof Map ? opts.grantsSession : new Map();
    const grantsPermanent = opts.grantsPermanent instanceof Set ? opts.grantsPermanent : new Set(opts.grantsPermanent || []);
    const persist = typeof opts.persist === 'function' ? opts.persist : null;
    const networkOf = typeof opts.networkOf === 'function' ? opts.networkOf : defaultNetworkOf;
    const surface = opts.surface || 'autonomous';
    const prompt = typeof opts.prompt === 'function' ? opts.prompt : null;                     // (call,tool) -> Promise<decision>
    const grantsBlanket = opts.grantsBlanket instanceof Set ? opts.grantsBlanket : null;       // full-access wildcard store ('*')

    function sessionSet(create) {
      let s = grantsSession.get(sessionKey);
      if (!s && create) { s = new Set(); grantsSession.set(sessionKey, s); }
      return s;
    }
    function granted(key) {
      if (grantsBlanket && grantsBlanket.has('*')) return true;   // full-access (blanket) grant covers every danger class
      if (grantsPermanent.has(key)) return true;
      const s = grantsSession.get(sessionKey);
      return !!(s && s.has(key));
    }

    function consent(call, tool) {
      const scope = scopeOf(tool);
      // 1. HARDLINE — unreachable past any flag.
      const hr = hardline ? hardline(call, tool) : null;
      if (hr) return { allow: false, scope: scope, hardline: true, reason: String(hr) + ANTI_RETRY };
      // 2. BYPASS — Full Access.
      if (bypass) return { allow: true, scope: scope, reason: 'full-access' };
      // 3. CACHE — a prior session/permanent grant for this danger class.
      if (granted(dangerKey(tool))) return { allow: true, scope: scope, reason: 'previously granted' };
      // 4. RESOLVE.
      if (scope === 'read' && !networkOf(call, tool)) return { allow: true, scope: scope, reason: 'read-only, non-network' };
      if (surface === 'autonomous') return { allow: false, scope: scope, reason: SILENCE };
      // INTERACTIVE: ask the human. dispatch awaits consent(), so returning this Promise PAUSES the run until a
      // decision arrives; the answer routes back through the SAME grant() ladder (once/always/full/deny). This is
      // the ONLY async branch — every tier above already returned a plain object.
      if (prompt) return Promise.resolve(prompt(call, tool)).then(function (d) { return consent.grant(d, call, tool); });
      // no channel wired -> fail closed.
      return { allow: false, scope: scope, reason: 'no consent channel — interactive prompt not wired' };
    }

    // Record a human decision (from the future interactive prompt, or seeded in tests). NEVER called
    // automatically by consent() in autonomous mode — a default-deny stands until a real yes arrives.
    consent.grant = function (decision, call, tool) {
      const scope = scopeOf(tool);
      const key = dangerKey(tool);
      if (decision === 'once') return { allow: true, scope: scope, reason: 'granted once' };
      if (decision === 'session') { sessionSet(true).add(key); return { allow: true, scope: scope, reason: 'granted for session' }; }
      if (decision === 'always') {
        // fail-closed: commit the grant ONLY if it durably persisted (a thrown persist denies).
        if (persist) {
          const next = Array.from(grantsPermanent); if (!grantsPermanent.has(key)) next.push(key);
          try { persist(next); }
          catch (e) { return { allow: false, scope: scope, reason: 'could not persist grant — denied' }; }
        }
        grantsPermanent.add(key);
        return { allow: true, scope: scope, reason: 'granted permanently' };
      }
      if (decision === 'full') {
        // blanket "full access": allow EVERY danger class for the life of the injected grantsBlanket store. The
        // sidecar wires it to an in-memory per-agent set, so it lasts the session and RESETS on restart — never
        // persisted to disk. Still sits BELOW the hardline floor (tier 1 is checked before the cache tier).
        if (grantsBlanket) grantsBlanket.add('*');
        return { allow: true, scope: scope, reason: 'full access granted' };
      }
      return { allow: false, scope: scope, reason: 'denied' };
    };

    consent.snapshot = function () {
      const session = {};
      grantsSession.forEach((set, k) => { session[k] = Array.from(set).sort(); });
      return { permanent: Array.from(grantsPermanent).sort(), session: session };
    };

    return consent;
  }

  return { makeConsentBroker, ANTI_RETRY, SILENCE };
});
