/* STARNET — permissions.js : the PURE engine for the PERMISSIONS PANEL (autonomy Stage B / B1).

   The user-facing "how autonomous" SPECTRUM + the curated catalog of standing capability grants. This is the
   trust UX the Commander picked: an OS-style panel where they dial the station from "never acts on its own" all
   the way to "fully autonomous" (acts AND writes real local files), and where every standing grant is visible
   and revocable.

   THE SPECTRUM is one legible choice that composes TWO underlying systems coherently:
     • POSTURE (autonomy.js) — the INITIATIVE intent (wait→propose→leash→free), set via a cadence PRESET.
     • CONSENT (sidecar grantsPermanent) — the standing capability GRANTS (cabinet:write = real local writes).
   A level sets both. The GRANT is what separates "draft for me" from "fully autonomous": both intend to work
   locally (reach=sandbox), but only the top level holds the cabinet:write consent that lets a write actually land.

       never   → preset wait    + no grants   → does nothing on its own
       suggest → preset suggest + no grants   → proposes; you approve
       draft   → preset build   + no grants   → acts + leaves finished drafts on the desk (today's Stage A)
       full    → preset free    + cabinet:write → acts AND writes real files into its own workspace, on its own

   LOCAL-ONLY by design: the only grantable class is cabinet:write (jailed fs writes; .env/.git always blocked;
   every write checkpointed + reversible). Never send / publish / spend / execute — those aren't on the spectrum.

   PURE + node-testable, mirroring autonomy.js: a `Permissions` global in the browser, module.exports under node.
   NO Date.now / Math.random — every output is a deterministic function of (level | posture+grants). The store
   owns the live api calls + the AutonomyStore hand-off. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Permissions = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the spectrum, low → high.
  const LEVELS = ['never', 'suggest', 'draft', 'full'];

  // the curated catalog the panel may GRANT — decorates the sidecar's permgrants.GRANTABLE with copy. The KEY
  // set is cross-locked against sidecar/permgrants.js in the test (single source of truth for what's grantable).
  const CATALOG = [
    {
      key: 'cabinet:write',
      label: 'Write files on its own',
      desc: "Create and edit files in its own workspace while you're away. Stays inside the workspace — .env/.git are always protected — and every change is checkpointed, so you can undo anything it does."
    }
  ];

  // each level → the coherent posture PRESET (autonomy.js cadence id) + the standing GRANTS it should hold.
  const PLANS = {
    never:   { preset: 'wait',    grants: [] },
    suggest: { preset: 'suggest', grants: [] },
    draft:   { preset: 'build',   grants: [] },
    full:    { preset: 'free',    grants: ['cabinet:write'] }
  };

  // honest one-liners — the panel shows these so the choice is never a mystery.
  const BLURB = {
    never:   "Stays put. Never acts on its own — you drive everything.",
    suggest: "Lines up ideas while you're away; nothing happens until you approve it.",
    draft:   "Acts on its own and leaves finished drafts on your desk — but never writes files, sends, or spends.",
    full:    "Acts on its own AND writes real files into its workspace while you're away. Everything it does is logged and reversible; it still can't send, publish, spend, or run commands."
  };

  function isLevel(x) { return LEVELS.indexOf(x) >= 0; }
  function normalizeLevel(x) { return isLevel(x) ? x : 'never'; }
  function levelPlan(level) { return PLANS[normalizeLevel(level)]; }
  function describeLevel(level) { return BLURB[normalizeLevel(level)]; }

  // the curated grantable keys (what the panel offers to ADD). Mirrors permgrants.GRANTABLE.
  function grantableKeys() { return CATALOG.map(c => c.key); }
  function isGrantable(key) { return grantableKeys().indexOf(key) >= 0; }
  function catalogEntry(key) { return CATALOG.filter(c => c.key === key)[0] || null; }
  function catalogLabel(key) { const e = catalogEntry(key); return e ? e.label : String(key || ''); }
  // a human line for ANY standing grant — curated ones get their catalog desc; a non-curated class (blessed via
  // a past interactive prompt) still gets a truthful, revocable line so nothing the agent can do is hidden.
  function describeGrant(key) { const e = catalogEntry(key); return e ? e.desc : (String(key || '') + ' — granted earlier; you can revoke it here.'); }

  // keep only well-formed danger keys (capability:scope). Defensive against a malformed api payload.
  function normalizeGrants(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const k of arr) if (typeof k === 'string' && /^[a-z_]+:[a-z]+$/.test(k) && out.indexOf(k) < 0) out.push(k);
    return out.sort();
  }

  // DERIVE the current level from live posture + standing grants (best-effort label for highlighting). The write
  // grant is the hinge: holding cabinet:write while the agent acts (leash/free) = fully autonomous; acting without
  // it = draft-only. An orphan grant under a non-acting posture reads as its posture level (never/suggest) — the
  // panel still lists the raw grant separately, so the consent is never hidden, just not "in effect".
  function levelFromState(posture, grants) {
    const p = posture || {};
    const init = p.initiative || 'wait';
    const acts = (init === 'leash' || init === 'free') || !!p.actsUnattended;
    const hasWrite = normalizeGrants(grants).indexOf('cabinet:write') >= 0;
    if (acts) return hasWrite ? 'full' : 'draft';
    if (init === 'propose') return 'suggest';
    return 'never';
  }

  // what to GRANT / REVOKE to move to a target level — over the CURATED catalog ONLY. Non-curated standing
  // grants (e.g. a network class the user blessed once) are NEVER auto-touched by a level change; the panel
  // revokes those one at a time, deliberately.
  function reconcileToLevel(level, currentGrants) {
    const target = new Set(levelPlan(level).grants);
    const cur = normalizeGrants(currentGrants);
    const toGrant = grantableKeys().filter(k => target.has(k) && cur.indexOf(k) < 0);
    const toRevoke = grantableKeys().filter(k => !target.has(k) && cur.indexOf(k) >= 0);
    return { toGrant, toRevoke };
  }

  return {
    LEVELS, CATALOG, PLANS,
    isLevel, normalizeLevel, levelPlan, describeLevel,
    grantableKeys, isGrantable, catalogEntry, catalogLabel, describeGrant,
    normalizeGrants, levelFromState, reconcileToLevel
  };
});
