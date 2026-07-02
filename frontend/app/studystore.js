/* STARNET — studystore.js : the live wiring around the pure STUDY ENGINE (study.js) — the dossier's Phase B.

   Where dossierstore.js only folds the Commander's OWN onboarding docs + panel edits (Phase A), this is the
   glue that lets the station LEARN from actual work: after a salient run the sidecar studies the transcript and
   stashes belief-update proposals; this store fetches them, gates them (session cap + anti-nag), and applies the
   Commander's Keep / Edit / Discard verdict to the DOSSIER (Keep → DossierStore.upsert source:'study'; Discard →
   a PERMANENT studyDeclined denylist; ignore 2× → stop proposing that belief). It also owns the RATINGS→TASTE
   path (§4): consecutive 👍/👎 on one archetype mints ONE style-dim proposal, once per archetype ever.

   Discipline mirrors curiositystore.js / suggeststore.js:
   - READ-ONLY citizen of U.bus — it NEVER emits (the frozen shared/events.js contract is owned elsewhere).
   - Self-persists its OWN key (declined denylist, per-belief ignore tallies, per-archetype rating tallies +
     minted flags) — no save.js change. The per-session shown counter is in-memory (resets each app run).
   - node-exportable for its test; all DECISION logic lives in the pure Study engine, this is the edge.

   The DOM half — rendering the study turn-in card and sharing chat.js's ONE post-run beat slot at TURN-IN
   priority (memory turn-in wins; a study proposal queues for the next task end) — lives in chat.js, which calls
   this store for the gate + the consent side-effects. */
'use strict';
const StudyStore = (() => {
  const KEY = 'starnet.study.v1';
  const SESSION_CAP = 3;        // at most this many study proposals SHOWN per session (anti-nag, mission constraint)
  const IGNORE_LIMIT = 2;       // ignore a proposed belief this many times → stop proposing it (stop-forever)
  const DECLINED_CAP = 200;     // permanent studyDeclined denylist (FIFO) fed into the engine's dedup

  let state = null;             // persisted: { v, declined:[text], ignores:{fp:int}, ratings:{arch:{up,down,upMinted,downMinted}} }
  let sessionShown = 0;         // proposals shown THIS session (in-memory; resets each app run)
  let deps = {};                // { now, getDossierBlock?, getBeliefs? } — injected by app.js (all optional; fail-open)

  const ready = () => typeof Study !== 'undefined' && state;
  const now = () => { try { if (typeof deps.now === 'function') return deps.now(); } catch (_) {} return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; };

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function hydrate(raw) {
    const s = { v: 1, declined: [], ignores: {}, ratings: {} };
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.declined)) s.declined = raw.declined.filter(x => typeof x === 'string' && x.trim()).slice(-DECLINED_CAP);
      if (raw.ignores && typeof raw.ignores === 'object') for (const k in raw.ignores) { const n = Math.floor(Number(raw.ignores[k])); if (Number.isFinite(n) && n > 0) s.ignores[k] = n; }
      if (raw.ratings && typeof raw.ratings === 'object') for (const k in raw.ratings) {
        const e = raw.ratings[k] || {};
        s.ratings[k] = { up: Math.max(0, Math.floor(Number(e.up)) || 0), down: Math.max(0, Math.floor(Number(e.down)) || 0), upMinted: !!e.upMinted, downMinted: !!e.downMinted };
      }
    }
    return s;
  }

  // a stable fingerprint of a proposed belief (dim + significant tokens) so an ignore/deny recognises the same
  // belief across runs even when the model rewords it slightly (mirrors suggeststore.fingerprint).
  function fingerprint(dim, text) {
    const toks = String(text == null ? '' : text).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return String(dim || '') + '|' + Array.from(new Set(toks)).sort().join(' ');
  }

  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    sessionShown = 0;
  }
  // a brand-new hero starts clean (mirrors the other stores' reset on commission).
  function reset() { state = hydrate(null); sessionShown = 0; try { localStorage.removeItem(KEY); } catch (_) {} }

  // ---- the gate the chat beat consults ----
  // room left in the per-session budget (anti-nag). The per-RUN "≤1 shown" cap is enforced by the caller
  // showing at most one proposal per beat.
  function canShow() { return !!state && sessionShown < SESSION_CAP; }
  // has this exact belief been ignored to the stop-forever limit (or explicitly declined)?
  function isExhausted(dim, text) {
    if (!state) return true;
    const fp = fingerprint(dim, text);
    if ((state.ignores[fp] || 0) >= IGNORE_LIMIT) return true;
    return Study.isDeclined(text, state.declined);
  }
  // pick the first still-live proposal from a fetched batch (drops exhausted/declined ones). Returns it or null.
  function nextLive(proposals) {
    if (!ready() || !Array.isArray(proposals)) return null;
    for (const p of proposals) { if (p && p.text && !isExhausted(p.dim, p.text)) return p; }
    return null;
  }
  // count one shown proposal against the session budget (the caller calls this when it actually renders a card).
  function markShown() { sessionShown++; }

  // fetch the server-side study proposals for a run (with text). [] on any failure (fail-open).
  async function fetchProposals(runId, agentId) {
    try {
      if (typeof Harness === 'undefined' || !Harness.studyProposals) return [];
      const list = await Harness.studyProposals(runId, agentId || 'agent');
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  }

  // the studyDeclined denylist (fed to the sidecar study call so it never re-proposes a rejected belief).
  function declinedList() { return (state && Array.isArray(state.declined)) ? state.declined.slice() : []; }

  // ---- consent verdicts (called by the chat study card) ----
  // KEEP / EDIT: commit the belief to the DOSSIER with source:'study' + observedAt provenance. A 'retire'
  // proposal is applied by FORGETTING the matched existing belief instead of adding one. `text` is the (possibly
  // edited) belief. Returns true on a successful write.
  function accept(prop, text) {
    if (!prop || typeof DossierStore === 'undefined') return false;
    const dim = prop.dim; const body = String(text != null ? text : prop.text).trim();
    if (!dim || !body) return false;
    try {
      if (prop.kind === 'retire') {
        // retire = drift/obsoletion: drop the existing belief this proposal matched (best-effort Jaccard match).
        const beliefs = (typeof DossierStore.beliefs === 'function') ? (DossierStore.beliefs(dim) || []) : [];
        let target = null;
        for (const b of beliefs) { if (b && b.text && Study.jaccard(b.text, body) >= Study.SIM_THRESHOLD) { target = b; break; } }
        if (target && DossierStore.forget) { DossierStore.forget(dim, target.id); return true; }
        return false;   // nothing matched — the belief was already gone; treat as a no-op (not an error card)
      }
      if (DossierStore.upsert) { DossierStore.upsert(dim, { text: body, source: 'study', observedAt: now(), sourceRunId: prop.sourceRunId || null }); return true; }
    } catch (_) {}
    return false;
  }
  // DISCARD: add the belief to the PERMANENT studyDeclined denylist so it's never re-proposed (mirrors the
  // memory turn-in's declined list; §5.6 "discard = never again", applied to the dossier).
  function discard(prop) {
    if (!state || !prop) return;
    const t = String(prop.text || '').trim();
    if (t && state.declined.indexOf(t) < 0) { state.declined.push(t); while (state.declined.length > DECLINED_CAP) state.declined.shift(); save(); }
  }
  // IGNORE (the Commander left the card without deciding): tally it; IGNORE_LIMIT ignores stops the belief for good.
  function ignore(prop) {
    if (!state || !prop || !prop.text) return;
    const fp = fingerprint(prop.dim, prop.text);
    state.ignores[fp] = (state.ignores[fp] || 0) + 1;
    save();
  }

  // ---- RATINGS → TASTE (§4) ----
  // fold ONE work rating (verdict 'great'|'ok'|'miss') for an archetype into the persisted streak tally, then —
  // if a fresh 3-streak crossed and that direction hasn't minted before — return ONE style-dim taste proposal to
  // raise (or null). The caller (chat.rateWork) renders it via the same study beat. Once per archetype/direction
  // ever (the minted flag persists). A taste proposal already on the studyDeclined list is suppressed here.
  function noteRating(archetype, verdict) {
    if (!ready() || !archetype) return null;
    const key = String(archetype);
    const entry = state.ratings[key] = Study.foldRating(state.ratings[key], verdict);
    const t = Study.tasteProposal(key, entry, { now: now });
    save();
    if (!t) return null;
    // suppress a taste belief the Commander already declined, and honour the ignore stop-forever tally.
    if (Study.isDeclined(t.proposal.text, state.declined) || isExhausted('style', t.proposal.text)) { entry[t.mintedKey] = true; save(); return null; }
    entry[t.mintedKey] = true;   // mint ONCE — never re-raise this archetype/direction
    save();
    return t.proposal;
  }

  return {
    init, reset, canShow, isExhausted, nextLive, markShown, fetchProposals,
    declinedList, accept, discard, ignore, noteRating, fingerprint,
    SESSION_CAP, IGNORE_LIMIT,
    _state: () => state
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { StudyStore };
