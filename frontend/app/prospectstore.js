/* STARNET — prospectstore.js : the live wiring around the pure Prospect generator (Slice 4).

   Mints bespoke NEW agent specs over time and stages them as DRAFTS in the Recruitment Bay. It owns the cadence,
   the persistence, the denylist, and the async reason-only model call; the pure engine (prospect.js) owns the
   directive + the hard-validating parse.

   DISCIPLINE (mirrors suggeststore.js / stationqueststore.js):
     • READ-ONLY on U.bus — subscribes to agent.run.end to advance the cooldown; NEVER emits (frozen contract).
     • SELF-PERSISTS to its own versioned key ('starnet.prospects.v1') — no save.js change. Holds { prospects[],
       denylist[], lastMintFamiliarity, lastMintWarmth, tasksSinceMint }.
     • CADENCE = the SAME growth-trigger discipline as ongoing suggestions: a mint is ATTEMPTED only when the
       worksignal is WARM (recruiter's threshold) AND something GREW since the last mint (dossier familiarity or
       worksignal sample count), AND cooldown >=3 task-runs, AND at most ONE attempt per session. A cold station
       mints nothing. The attempt is ASYNC + SILENT: failures (model hiccup / invalid parse / NONE / duplicate /
       denylisted) drop quietly — never a beat about a failed mint.
     • CAP: at most MAX_LIVE (3) live prospects; a new mint evicts the oldest when full.
     • DENYLIST (locked product law): dismissing a prospect records its fingerprint; an equivalent is never re-minted.

   Coherence with recruiter.js: prospects cover what NO catalog class serves. The directive is told the recruiter's
   top existing-class pick and instructed to reply NONE if a class already covers the gap. */
'use strict';
const ProspectStore = (() => {
  const KEY = 'starnet.prospects.v1';
  const MAX_LIVE = 3;
  const COOLDOWN_TASKS = 3;   // >=3 task-runs between mint attempts (the work-earned floor, shared spirit)
  let state = null;
  let deps = {};              // accessors/actions injected by app.js
  let bound = false;
  let sessionAttempted = false;   // one mint attempt per session (in-memory; resets each app run)
  let minting = false;            // re-entrancy guard while a mint is mid-flight

  const now = () => (deps.now ? deps.now() : (typeof Date !== 'undefined' ? Date.now() : 0));

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

  function hydrate(raw) {
    const s = { v: 1, prospects: [], denylist: [], lastMintFamiliarity: null, lastMintWarmth: null, tasksSinceMint: COOLDOWN_TASKS };
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.prospects)) s.prospects = raw.prospects.filter(p => p && p.draft && p.id).slice(-MAX_LIVE);
      if (Array.isArray(raw.denylist)) s.denylist = raw.denylist.filter(x => typeof x === 'string').slice(-200);
      if (Number.isFinite(raw.lastMintFamiliarity)) s.lastMintFamiliarity = raw.lastMintFamiliarity;
      if (Number.isFinite(raw.lastMintWarmth)) s.lastMintWarmth = raw.lastMintWarmth;
      if (Number.isFinite(raw.tasksSinceMint) && raw.tasksSinceMint >= 0) s.tasksSinceMint = raw.tasksSinceMint;
    }
    return s;
  }

  // opts: the accessors/actions injected by app.js (all optional — a missing dep degrades to a no-op mint).
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    sessionAttempted = false; minting = false;
    if (!bound && typeof U !== 'undefined' && U.bus && U.bus.on) {
      U.bus.on('agent.run.end', onRunEnd);
      bound = true;
    }
  }

  // THE COUNTER (read-only): every clean hero task-run advances the cooldown, independent of whether a mint fires.
  function onRunEnd(p) {
    if (!state) return;
    p = p || {};
    if (p.reason !== 'done') return;
    if ((p.agentId || 'agent') !== 'agent') return;
    state.tasksSinceMint = (state.tasksSinceMint || 0) + 1;
    save();
    // a due mint attempt rides the same post-run moment (async, silent) — never blocks the beat slot.
    try { maybeMint(); } catch (_) {}
  }

  const warmth = () => { const w = deps.getWarmth ? deps.getWarmth() : null; return Number.isFinite(w) ? w : null; };
  const familiarity = () => { const f = deps.getFamiliarity ? deps.getFamiliarity() : null; return Number.isFinite(f) ? f : null; };

  // the gate: is a mint attempt DUE? warm signal + growth since last mint + cooldown + one-per-session.
  function shouldMint() {
    if (!state || sessionAttempted || minting) return false;
    if (state.prospects.length >= MAX_LIVE) return false;                    // shelf full — don't over-mint
    const w = warmth();
    if (w == null || w <= 0) return false;                                   // NOT WARM → cold station mints nothing
    if ((state.tasksSinceMint || 0) < COOLDOWN_TASKS) return false;          // cooldown not cleared
    // GROWTH gate: only when familiarity OR warmth grew since the last mint (nothing new → nothing to draft).
    const fam = familiarity();
    const grewWarmth = state.lastMintWarmth == null || (w > state.lastMintWarmth + 1e-9);
    const grewFam = fam != null && (state.lastMintFamiliarity == null || fam > state.lastMintFamiliarity + 1e-9);
    return grewWarmth || grewFam;
  }

  // ASYNC mint attempt: build the directive, run the reason-only model call, hard-parse, and stage the draft.
  // Silent on every failure path. Returns the minted prospect (for the test) or null.
  async function maybeMint() {
    if (!shouldMint()) return null;
    if (typeof Prospect === 'undefined' || !deps.chat) return null;
    sessionAttempted = true;   // spend the session's single attempt up front (even on failure — no retry-hammer)
    minting = true;
    try {
      const directive = Prospect.buildDirective({
        dossierBlock: deps.getDossierBlock ? deps.getDossierBlock() : '',
        worksignalSummary: deps.getWorksignalSummary ? deps.getWorksignalSummary() : '',
        rosterClasses: deps.getRosterClasses ? deps.getRosterClasses() : [],
        catalogSummary: deps.getCatalogSummary ? deps.getCatalogSummary() : [],
        capabilityKeys: deps.getCapabilityKeys ? deps.getCapabilityKeys() : [],
        skillSlugs: deps.getSkillSlugs ? deps.getSkillSlugs() : [],
        topRecommendation: deps.getTopRecommendation ? deps.getTopRecommendation() : ''
      });
      const system = deps.getSystem ? deps.getSystem() : '';
      const res = await deps.chat({ system, messages: [{ role: 'user', content: directive }], agentId: 'agent', isTask: false, placed: [], internal: true });
      const text = (res && !res.error) ? res.text : '';
      const parsed = Prospect.parse(text, {
        allowedKit: deps.getCapabilityKeys ? deps.getCapabilityKeys() : [],
        allowedSkills: deps.getSkillSlugs ? deps.getSkillSlugs() : [],
        existingClasses: deps.getCatalogSummary ? deps.getCatalogSummary() : []
      });
      if (!parsed || parsed.none || !parsed.draft) return null;              // NONE / unparseable / invalid → silent no-mint
      if (isDenied(parsed.fingerprint)) return null;                         // dismissed-equivalent → never re-mint
      if (state.prospects.some(p => p.fingerprint === parsed.fingerprint)) return null;   // already staged this one
      const rec = { id: 'prospect-' + now() + '-' + (state.prospects.length + 1), draft: parsed.draft, why: parsed.why, fingerprint: parsed.fingerprint, mintedAt: now(), sourceSignal: deps.getWorksignalSummary ? deps.getWorksignalSummary() : '' };
      state.prospects.push(rec);
      while (state.prospects.length > MAX_LIVE) state.prospects.shift();     // evict oldest when over cap
      state.lastMintWarmth = warmth();
      state.lastMintFamiliarity = familiarity();
      state.tasksSinceMint = 0;
      save();
      poke();
      return rec;
    } catch (_) { return null; }
    finally { minting = false; }
  }

  // if the bay is open, refresh it so a freshly-minted prospect lands (no-op when closed).
  function poke() { try { if (typeof Marketplace !== 'undefined' && Marketplace.refreshIfOpen) Marketplace.refreshIfOpen(); } catch (_) {} }

  const isDenied = fp => !!fp && !!state && Array.isArray(state.denylist) && state.denylist.indexOf(fp) >= 0;

  // ---- read/act surface (the bay consumes these) ----
  function list() { return state ? state.prospects.slice() : []; }
  function get(id) { return state ? (state.prospects.find(p => p.id === id) || null) : null; }

  // DISMISS: denylist the fingerprint (never re-mint an equivalent) + drop the card. Returns true iff it took.
  function dismiss(id) {
    if (!state || !id) return false;
    const idx = state.prospects.findIndex(p => p.id === id);
    if (idx < 0) return false;
    const fp = state.prospects[idx].fingerprint;
    state.prospects.splice(idx, 1);
    if (fp && state.denylist.indexOf(fp) < 0) { state.denylist.push(fp); while (state.denylist.length > 200) state.denylist.shift(); }
    save();
    return true;
  }

  // ACCEPT: the Commander confirmed a prospect (it became a saved custom). Remove it from the staging list — it's
  // now a real class, not a draft — WITHOUT denylisting (the opposite of dismiss). Best-effort.
  function accept(id) {
    if (!state || !id) return false;
    const idx = state.prospects.findIndex(p => p.id === id);
    if (idx < 0) return false;
    state.prospects.splice(idx, 1);
    save();
    return true;
  }

  // a brand-new hero starts with no prospect history (own key, mirrors curiositystore.reset).
  function reset() { state = hydrate(null); sessionAttempted = false; minting = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, maybeMint, list, get, dismiss, accept, reset, isDenied: fp => isDenied(fp),
    _shouldMint: shouldMint, _hydrate: hydrate, MAX_LIVE, COOLDOWN_TASKS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ProspectStore };
