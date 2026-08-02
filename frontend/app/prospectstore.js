/* STARNET — prospectstore.js : the SCOUT CLIENT (was: the client-side prospect minter).

   HISTORY — this store used to OWN the prospect mint: localStorage state, one silent attempt per browser
   session, right after a qualifying run. In practice that funnel almost never fired and every rejection was
   invisible, so the bay looked like a static preset shelf. The mint moved SERVER-SIDE (sidecar scout:
   interests.js + scout.js + the post-run cycle in index.js) where it persists across sessions, retries on a
   real cadence, and writes every attempt to a visible ledger. This file is now the thin client of that:

     • GET  /api/scout          — warm/gate + interests (with evidence) + staged drafts (prospects AND
                                  recipe drafts) + the attempt ledger. Cached here; the bay reads the cache.
     • POST /api/scout/context  — pushes the facts only the browser knows (custom classes/recipes,
                                  worksignal summary, the recruiter's top pick) so server drafting dedupes
                                  against them. Sent at init, on bay open, and after each post-run refresh.
     • POST /api/scout/decide   — accept/dismiss verdicts (dismiss denylists server-side: never re-minted).

   The PUBLIC SURFACE the bay consumes (list/get/dismiss/accept + item shape {id, draft, why, fingerprint})
   is UNCHANGED, so marketplace.js's prospect shelf renders server drafts exactly as it rendered local ones.
   New reads: recipeDrafts() (the SUGGESTED shelf's scout cards), interests(), gate() (honest shelf copy).

   LEGACY: the old 'starnet.prospects.v1' localStorage key is still hydrated READ-ONLY so a draft staged by a
   pre-scout build keeps rendering and can be decided (decided locally; new mints are server-only).

   READ-ONLY on U.bus (frozen contract): subscribes to agent.run.end only to schedule a delayed re-read —
   the server cycle runs post-run, so the shelf refreshes itself right after a mint could have landed. */
'use strict';
const ProspectStore = (() => {
  const KEY = 'starnet.prospects.v1';   // legacy client-mint store (read-only hydrate; no new writes beyond decides)
  const REFRESH_DELAY_MS = 6000;        // post-run: give the server cycle time to extract/mint before re-reading
  let legacy = null;
  let cache = null;                     // the last GET /api/scout payload (server truth, re-read not mutated blind)
  let deps = {};
  let bound = false;
  let refreshTimer = null;
  let recommendationSeq = 0;
  let recommendationIds = {};

  const now = () => (deps.now ? deps.now() : (typeof Date !== 'undefined' ? Date.now() : 0));
  // the token-carrying fetch (Harness.apiFetch); injectable for tests.
  const api = (u, init) => (deps.fetch ? deps.fetch(u, init)
    : (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch(u, init)
    : Promise.reject(new Error('no api fetch')));

  function loadLegacy() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function saveLegacy() { try { localStorage.setItem(KEY, JSON.stringify(legacy)); } catch (_) {} }
  function hydrateLegacy(raw) {
    const s = { v: 1, prospects: [], denylist: [] };
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.prospects)) s.prospects = raw.prospects.filter(p => p && p.draft && p.id).slice(-3);
      if (Array.isArray(raw.denylist)) s.denylist = raw.denylist.filter(x => typeof x === 'string').slice(-200);
    }
    return s;
  }

  // deps: { fetch?, now?, getCustomClasses?, getCustomRecipes?, getWorksignalSummary?, getTopRecommendation? }
  function init(opts) {
    deps = opts || {};
    legacy = hydrateLegacy(loadLegacy());
    cache = null;
    if (!bound && typeof U !== 'undefined' && U.bus && U.bus.on) {
      U.bus.on('agent.run.end', onRunEnd);
      bound = true;
    }
    pushContext();
    refresh();
  }

  // a clean run end means the server cycle may have just minted — re-read shortly after (one timer, coalesced).
  function onRunEnd(p) {
    if (!p || p.reason !== 'done') return;
    try { if (refreshTimer) clearTimeout(refreshTimer); } catch (_) {}
    try {
      refreshTimer = setTimeout(() => { refreshTimer = null; pushContext(); refresh(); }, REFRESH_DELAY_MS);
    } catch (_) {}
  }

  // re-read server truth; on success, live-refresh the open bay (no-op when closed). Best-effort, silent.
  async function refresh() {
    try {
      const r = await api('/api/scout', { cache: 'no-store' });
      if (!r || !r.ok) return false;
      cache = await r.json();
      if (cache && typeof cache.personalizationEnabled === 'boolean' && deps.setLearningEnabled) deps.setLearningEnabled(cache.personalizationEnabled);
      poke();
      return true;
    } catch (_) { return false; }
  }

  // push the browser-only dedup facts. Bounded server-side; best-effort (a miss just means weaker dedup this pass).
  async function pushContext() {
    try {
      const body = {
        customClasses: deps.getCustomClasses ? (deps.getCustomClasses() || []) : [],
        customRecipes: deps.getCustomRecipes ? (deps.getCustomRecipes() || []) : [],
        worksignalSummary: deps.getWorksignalSummary ? (deps.getWorksignalSummary() || '') : '',
        topRecommendation: deps.getTopRecommendation ? (deps.getTopRecommendation() || '') : ''
      };
      await api('/api/scout/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return true;
    } catch (_) { return false; }
  }

  function poke() { try { if (typeof Marketplace !== 'undefined' && Marketplace.refreshIfOpen) Marketplace.refreshIfOpen(); } catch (_) {} }

  const stagedOf = kind => (cache && Array.isArray(cache.staged)) ? cache.staged.filter(it => it && it.kind === kind) : [];
  const toCard = it => ({ id: it.id, draft: it.draft, why: it.why, fingerprint: it.fingerprint, mintedAt: it.at });

  /* ---- read surface (the bay consumes these) ---- */
  function list() {   // prospect drafts: any surviving legacy ones + the server-staged ones
    const loc = legacy ? legacy.prospects.slice() : [];
    return loc.concat(stagedOf('prospect').map(toCard));
  }
  function recipeDrafts() { return stagedOf('recipe').map(toCard); }
  function get(id) { return list().concat(recipeDrafts()).find(p => p.id === id) || null; }
  function interests() { return (cache && Array.isArray(cache.interests)) ? cache.interests : []; }
  function gate() { return (cache && cache.gate) || null; }
  function warm() { return !!(cache && cache.warm); }
  function preferenceModel() { return (cache && cache.preferenceModel) || null; }
  // the scout's visible ATTEMPT LEDGER (server truth: GET /api/scout .ledger, tail already sliced server-side).
  // Every entry is one recorded mint outcome { at, kind, outcome, reason, title } — the bay renders it so a
  // dismissed draft is never the whole story (truthful telemetry). Empty until a /api/scout read lands.
  function ledger() { return (cache && Array.isArray(cache.ledger)) ? cache.ledger : []; }

  function noteRecommendation(surface, item, meta) {
    if (cache && cache.personalizationEnabled === false) return '';
    const target = item && item.id ? String(item.id) : '';
    const lane = String(surface || 'scout');
    if (!target) return '';
    const key = lane + ':' + target;
    if (recommendationIds[key]) return recommendationIds[key];
    const id = 'ui:' + lane + ':' + target.slice(0, 60) + ':' + now() + ':' + (++recommendationSeq);
    recommendationIds[key] = id;
    meta = meta || {};
    try { api('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      id, surface: lane, kind: meta.kind || lane, title: item.name || item.title || target, target,
      traits: meta.traits || [], evidence: meta.why ? [{ id: meta.evidenceId || 'rank', type: 'ranking', quote: meta.why }] : [],
      readiness: meta.readiness || null, contextId: meta.contextId || (lane + ':minute:' + Math.floor(now() / 60000)), rank: meta.rank, scoreComponents: meta.scoreComponents || {}, modelVersion: 'unified-ui-v1'
    }) }).catch(() => {}); } catch (_) {}
    return id;
  }
  function recommendationVerdict(surface, target, state, reason) {
    const key = String(surface || '') + ':' + String(target || '');
    const id = recommendationIds[key];
    if (!id) return false;
    try { api('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, state, reason }) }).catch(() => {}); } catch (_) {}
    return true;
  }
  function recommendationOutcome(surface, target, outcome) {
    const id = recommendationIds[String(surface || '') + ':' + String(target || '')];
    if (!id) return false;
    try { api('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, outcome: outcome || {} }) }).catch(() => {}); } catch (_) {}
    return true;
  }

  /* ---- decide surface ----
     A legacy (local) draft is decided locally, same semantics as before (dismiss denylists the fingerprint).
     A server draft is decided optimistically here (drop from the cache so the shelf re-render is instant) and
     the verdict POSTs fire-and-forget — the next refresh() re-reads server truth either way. */
  function decideServer(id, decision) {
    if (!cache || !Array.isArray(cache.staged)) return false;
    const idx = cache.staged.findIndex(it => it && it.id === id);
    if (idx < 0) return false;
    cache.staged.splice(idx, 1);
    try { api('/api/scout/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, decision: decision }) }).catch(() => {}); } catch (_) {}
    return true;
  }
  function dismiss(id) {
    if (!id) return false;
    if (legacy) {
      const idx = legacy.prospects.findIndex(p => p.id === id);
      if (idx >= 0) {
        const fp = legacy.prospects[idx].fingerprint;
        legacy.prospects.splice(idx, 1);
        if (fp && legacy.denylist.indexOf(fp) < 0) { legacy.denylist.push(fp); while (legacy.denylist.length > 200) legacy.denylist.shift(); }
        saveLegacy();
        return true;
      }
    }
    return decideServer(id, 'dismiss');
  }
  function accept(id) {
    if (!id) return false;
    if (legacy) {
      const idx = legacy.prospects.findIndex(p => p.id === id);
      if (idx >= 0) { legacy.prospects.splice(idx, 1); saveLegacy(); return true; }
    }
    return decideServer(id, 'accept');
  }

  const isDenied = fp => !!fp && !!legacy && legacy.denylist.indexOf(fp) >= 0;

  /* ---- engagement telemetry (lane 5) ---- */
  // count a REAL recipe launch server-side (counters only, no content) + mirror it into the local cache so the
  // FOR-YOU rank reflects it immediately. Fire-and-forget; a miss just means a weaker rank this session.
  function noteLaunch(recipe) {
    if (!recipe || !recipe.id) return;
    if (cache && cache.personalizationEnabled === false) return;
    try {
      if (cache) {
        cache.usage = cache.usage || { launches: {} };
        const cur = cache.usage.launches[recipe.id];
        // `rated` RIDES THROUGH: a launch never erases the outcome counters (the same law Scout.noteLaunch holds
        // server-side). Dropping them here made the local mirror disagree with the server until the next refresh,
        // silently zeroing the outcome term that rankRecipes had just used to rank this very recipe.
        cache.usage.launches[recipe.id] = { name: recipe.name || (cur && cur.name) || '', n: (cur && cur.n || 0) + 1, lastAt: now(), rated: (cur && cur.rated) || { great: 0, ok: 0, miss: 0 } };
      }
      api('/api/scout/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'recipe.launch', id: recipe.id, name: recipe.name || '' }) }).catch(() => {});
      recommendationVerdict('recipe', recipe.id, 'started', 'accepted');
    } catch (_) {}
  }
  // outcome telemetry (lane B): fold a rate-the-work verdict onto the recipe that launched the run. What actually
  // HELPED ranks the FOR-YOU shelf, not just what was clicked. Counters only, mirrored locally so the shelf
  // re-ranks this session. Fire-and-forget; a miss just means a weaker rank until the next server read.
  function noteRated(recipeId, verdict) {
    const id = recipeId ? String(recipeId) : '';
    const v = (verdict === 'great' || verdict === 'ok' || verdict === 'miss') ? verdict : null;
    if (!id || !v) return;
    if (cache && cache.personalizationEnabled === false) return;
    try {
      if (cache) {
        cache.usage = cache.usage || { launches: {} };
        const cur = cache.usage.launches[id] || { name: '', n: 0, lastAt: 0 };
        cur.rated = cur.rated || { great: 0, ok: 0, miss: 0 };
        cur.rated[v] = (cur.rated[v] || 0) + 1;
        cache.usage.launches[id] = cur;
      }
      api('/api/scout/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'recipe.rated', id: id, verdict: v }) }).catch(() => {});
      recommendationVerdict('recipe', id, v === 'miss' ? 'declined' : 'completed', v === 'miss' ? 'bad_quality' : 'completed');
      recommendationOutcome('recipe', id, { quality: v === 'great' ? 1 : v === 'ok' ? 0.5 : -1, adopted: v !== 'miss', completedAt: now() });
    } catch (_) {}
  }
  // the per-recipe launch counters ({id: {name, n, lastAt, rated?}}) — rankRecipes' engagement + outcome signal.
  function launches() { return (cache && cache.usage && cache.usage.launches) || {}; }

  // a brand-new hero drops the browser-side state; the server store is the station's own memory (kept).
  function reset() { legacy = hydrateLegacy(null); cache = null; recommendationIds = {}; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, refresh, pushContext, list, recipeDrafts, get, interests, gate, warm, preferenceModel, ledger, dismiss, accept, reset,
    noteLaunch, noteRated, launches, noteRecommendation, recommendationVerdict, recommendationOutcome,
    isDenied: fp => isDenied(fp), _hydrateLegacy: hydrateLegacy, _setCacheForTest: c => { cache = c; } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ProspectStore };
