/* STARNET — marketplace.js : THE RECRUITMENT BAY — a premium "personnel registry" of agent classes.

   Renders the Specialties catalog (built-ins + the Commander's saved customs) as a roster of engraved
   class SEALS (a challenge-coin per class, drawn by classicons.js — NEVER a character skin; the skin is
   the Commander's own choice at summon). A two-pane character-select layout: the roster grid on the left,
   a live CLASS DOSSIER on the right that re-themes to whichever class is in focus. Self-contained overlay
   (scrim + console), owns its DOM + events, themes purely off the shared CRT vars (marketplace.css).

   Two modes, both opened by the app:
     • 'deploy'  (in-game)  — DEPLOY a specialty onto the CURRENT agent (re-specs purpose + standing orders
                              via the app's real applyAgentConfig path; optionally adopts its voice), SAVE
                              the current agent as a reusable custom specialty, browse + launch RECIPES.
     • 'pick'    (at wake / summon) — choose a specialist to wake a NEW agent as; hands the chosen spec back.

   Accessibility: a real modal dialog (role=dialog, aria-modal), moves focus in, TRAPS Tab, restores focus on
   close. Cards are buttons. Destructive deletes use the app's arm/confirm idiom, never window.confirm.
   UMD-light: a `Marketplace` global. */
'use strict';
const Marketplace = (() => {
  let root = null, ctx = null, view = 'grid';   // 'grid' | 'save' | 'recipesave' | 'launch'
  let opener = null;
  let editingId = null, editingRecipeId = null, launchId = null;
  let pendingMintKey = null, pendingMintTemplate = null;
  // SCOUT handoff: the station-drafted recipe being reviewed in the editor. pendingScoutRecipeId is consumed on a
  // successful save (accept — retires the staged draft server-side, never denylists); scoutSeedDraft prefills the
  // whole form (name/emoji/tagline/task — richer than a mint's bare template). Reset wherever the mint keys reset.
  let pendingScoutRecipeId = null, scoutSeedDraft = null;
  // R2 editor working state (the unified fork/create form): the picked gear set, cadence id, category, and the
  // fork provenance carried from a TWEAK. Reset on every open of the editor.
  let editGear = [], editCadence = null, editCategory = 'general', editForkedFrom = null, editParams = [];
  // R5 handoff: the run this editor session is bottling (a mintFromRun proposal's sourceRunId), preserved through
  // save so a bottled recipe keeps honest provenance. null for every other entry point (create / tweak / edit / import).
  let editSourceRunId = null;
  // R3 launch/routine state: the live cron jobs (fetched once when the recipes dossier renders) so a recipe can
  // show a "● live — every morning" indicator, and whether the launch pane is in RUN-NOW or MAKE-ROUTINE mode.
  let cronJobs = null, cronArmed = false, launchMode = 'run', launchCadence = null;
  let tab = 'agents';                            // 'agents' | 'recipes'
  let glassOpen = false;
  let summonConfigOpen = false;                  // the collapsible APPEARANCE+MODEL strip (summon mode) — collapsed by default
  let scoutLogOpen = false;                       // the collapsible SCOUT LOG (attempt ledger) — collapsed by default
  let pendingCardAnim = false;                   // play the staggered card-entrance ONCE per open/tab-switch, not on every filter/search rebuild
  let pickedSummonSkin = null;
  let pickedSummonModel = null;   // SUMMON-only per-agent model choice: { model, provider, effort } or null = inherit the orchestrator's
  let pickedSummonName = '';      // SUMMON-only agent NAME typed in the config strip ('' = default to the class name)
  let focusAgent = null, focusRecipe = null;     // the spec/recipe id shown in the dossier (per tab)
  let laneFilter = 'all';                        // 'all' | 'code' | 'research' | 'general'  (AGENTS tab)
  let archiveOpen = false;                       // SPECIALIST ARCHIVE (deep-cut archetypes) — collapsed by default
  let catFilter = 'all';                         // 'all' | 'mine' | <rail bucket>          (RECIPES tab, R6)
  let query = '';
  let buildAccent = '#ffaa33', buildModel = 'balanced';   // the custom-class builder's picked accent + tier
  let buildKit = [], buildSkills = [], buildEffort = null;   // the custom-class builder's picked loadout (Class Loadouts S3)
  let buildDraft = null;            // Slice 4: a station-drafted prospect pre-filling the builder (name/tagline/purpose/manual/emoji)
  let acceptingProspectId = null;   // Slice 4: the prospect id being reviewed → removed from staging on a successful CREATE
  // ---- IMPORT AGENT (Hermes / OpenClaw migration) — the view='harnessImport' flow's working state ----
  // importStep: 'detect' (list found installs / PICK FOLDER) → 'preview' (the dossier-style scan card).
  // importFound = the /api/harness/detect list (null until the detect call lands, [] = nothing found).
  // importScan = the /api/harness/scan result being previewed; importOrigin = { harness, root } that produced it.
  // All strings shown come straight from the scan (truthful telemetry) — no invented placeholders.
  let importStep = 'detect', importFound = null, importDetecting = false, importScanning = false;
  let importScan = null, importOrigin = null, importName = '', importErr = '';

  const hasRecipes = () => typeof Recipes !== 'undefined';
  const hasIcons = () => typeof ClassIcons !== 'undefined';
  const mintApi = () => (typeof MintStore !== 'undefined' && MintStore.candidates) ? MintStore : null;

  /* ---------- recipe R2/R3 vocabularies ----------
     CADENCE_OPTS mirrors autojobs.js CADENCES (the proven 4-option menu) — each id maps to a schedule STRING the
     sidecar's cron.parseSchedule accepts (interval or a 5-field cron). Kept here so MAKE ROUTINE can convert a
     recipe's suggested cadence id into a real schedule without a round-trip. 'none' = one-shot (RUN NOW only). */
  const CADENCE_OPTS = [
    { id: 'morning',   label: 'every morning',        schedule: '0 9 * * *' },
    { id: 'weekly',    label: 'every Monday morning', schedule: '0 9 * * 1' },
    { id: 'sixhourly', label: 'every 6 hours',        schedule: 'every 6h' },
    { id: 'hourly',    label: 'every hour',           schedule: 'every 1h' }
  ];
  function cadenceOpt(id) { return CADENCE_OPTS.filter(c => c.id === id)[0] || null; }
  function cadenceLabel(id) { const c = cadenceOpt(id); return c ? c.label : 'one-shot'; }
  // the gear objectTypes a recipe editor offers (same pickable set as the class builder — dish/cabinet/notebook/
  // workbench/studio; computer/connector are per-agent binds, not advisory recipe gear). Labels from the live source.
  const RECIPE_GEAR_PICK = ['dish', 'cabinet', 'notebook', 'workbench', 'studio'];
  // the category buckets the EDITOR offers as authorable browse buckets (the R6 discovery-rail personas).
  const RECIPE_CATEGORIES = ['developer', 'research', 'creator', 'ops', 'general'];
  const CAT_LABEL = { developer: 'DEVELOPER', research: 'RESEARCH', creator: 'CREATOR', ops: 'OPS', general: 'GENERAL',
    // legacy aliases older customs may still carry — labeled so a dossier chip never shows a raw slug.
    code: 'DEVELOPER', writing: 'CREATOR', planning: 'OPS' };
  // R6 discovery-rail buckets (in rail order) + how a recipe's raw category maps into one. The catalog authors
  // developer/research/creator/ops/general; legacy customs may carry code/writing/planning — fold those in so the
  // rail groups every recipe under exactly one visible bucket (never a stray slug, never an uncounted recipe).
  const RAIL_BUCKETS = ['developer', 'research', 'creator', 'ops', 'general'];
  const CAT_TO_RAIL = { developer: 'developer', code: 'developer', research: 'research', creator: 'creator',
    writing: 'creator', ops: 'ops', planning: 'ops', general: 'general' };
  function railBucket(r) { return CAT_TO_RAIL[(r && r.category) || 'general'] || 'general'; }

  /* ---------- personalization (the recommender's read surface) ---------- */
  const FAM_TAGS = ['code', 'research', 'general'];
  const TAG_LABEL = { code: 'CODE', research: 'RESEARCH', general: 'GENERAL OPS' };
  const BECAUSE = { code: 'matches your focus on code', research: 'matches your focus on research', general: 'fits your day-to-day ops' };
  const ACK_KEY = 'starnet.profile.ack.v1';
  const profileApi = () => (typeof ProfileStore !== 'undefined' && ProfileStore.summary) ? ProfileStore : null;
  function acked() { try { return typeof localStorage !== 'undefined' && !!localStorage.getItem(ACK_KEY); } catch (_) { return true; } }
  function setAcked() { try { if (typeof localStorage !== 'undefined') localStorage.setItem(ACK_KEY, '1'); } catch (_) {} }

  const has = () => typeof Specialties !== 'undefined';
  const sfx = n => { try { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); } catch (_) {} };
  const note = (m, k) => { try { if (ctx && ctx.notify) ctx.notify(m, k); } catch (_) {} };
  const esc = s => U.esc(s == null ? '' : s);   // delegate to the one complete impl (escapes & < > " ')
  function summonCandidateName(s) {
    const typed = (typeof AgentId !== 'undefined' && AgentId.normalizeName) ? AgentId.normalizeName(pickedSummonName) : String(pickedSummonName || '').trim().toUpperCase();
    if (typed) return typed;
    if (ctx && typeof ctx.nextAgentName === 'function') return ctx.nextAgentName((s && s.name) || 'AGENT');
    return (typeof AgentId !== 'undefined' && AgentId.normalizeName) ? AgentId.normalizeName((s && s.name) || 'AGENT') : String((s && s.name) || 'AGENT').toUpperCase();
  }
  function summonNameIssue() {
    if (!String(pickedSummonName || '').trim()) return '';
    return (typeof AgentId !== 'undefined' && AgentId.nameIssue) ? AgentId.nameIssue(pickedSummonName) : (String(pickedSummonName).length > 18 ? 'too-long' : '');
  }
  function summonNameConflict() {
    return !!(String(pickedSummonName || '').trim() && ctx && typeof ctx.nameConflict === 'function' && ctx.nameConflict(pickedSummonName));
  }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function voiceName(personaId) { return (typeof Personas !== 'undefined' && Personas.get(personaId) && Personas.get(personaId).name) || personaId; }

  /* ---------- the class seal — the engraved SVG coin (the typed-ASCII layer was removed 2026-07-16;
     the vector seal is the one emblem system, with the class emoji as the custom-class fallback) ---------- */
  function coinInner(item) {
    const svg = hasIcons() ? ClassIcons.svg(item) : null;
    return svg ? '<span class="mkt-coin-ico">' + svg + '</span>' : '<span class="mkt-coin-emoji">' + esc(item.emoji || '◆') + '</span>';
  }
  function codeOf(item) { return hasIcons() ? ClassIcons.code(item) : ''; }
  function laneOf(item) { return hasIcons() ? ClassIcons.lane(item) : 'general'; }
  function laneLabelOf(item) { return hasIcons() ? ClassIcons.laneLabel(item) : 'OPS'; }
  function pipsOf(model) { return hasIcons() ? ClassIcons.pipsHTML(model) : ''; }
  function clearanceLabel(model) { return hasIcons() ? ClassIcons.clearance(model).label : String(model || '').toUpperCase(); }
  function sealHTML(item, withCode) {
    return '<div class="mkt-seal"><div class="mkt-coin">' + coinInner(item) + '</div>' +
      (withCode ? '<span class="mkt-seal-code">' + esc(codeOf(item)) + '</span>' : '') + '</div>';
  }

  /* ---------- LOADOUT resolvers (Class Loadouts S3) — labels/grants from LIVE sources, never hardcoded ----------
     Prop labels + plain-English grants for a kit objectType come from WorldModel's OWNED source of truth
     (CAP_LABEL: the power word every UI already shows; CAP_PROP_MAP: the canonical prop) and the live PropSprites
     catalog (the prop's display label). Skill names/descriptions come from the /api/skills catalog the SKILLS
     window already reads. This keeps the dossier honest — it says exactly what the summon will grant. */
  const WM = () => (typeof WorldModel !== 'undefined') ? WorldModel : null;
  // one plain sentence describing what an objectType grants (the CAP_LABEL power word, humanized).
  const CAP_GRANTS = {
    dish: 'the WEB — live search & fetch', cabinet: 'FILES — read, write & search the workspace',
    notebook: 'MEMORY — a durable notebook it can save to & recall', workbench: 'a TERMINAL — run & test real code (approval-gated)',
    studio: 'IMAGES — generate & analyse visuals', computer: 'COMPUTE — its own workstation', connector: 'LIVE TOOLS — a bound MCP server'
  };
  function capGrant(objType) {
    const t = String(objType || '').trim();
    return CAP_GRANTS[t] || (WM() && WM().CAP_LABEL && WM().CAP_LABEL[t] ? String(WM().CAP_LABEL[t]).toLowerCase() : t);
  }
  // the display label for the prop a kit objectType requisitions (from the live PropSprites catalog via the
  // canonical prop for the cap) — never a hardcoded prop name (onboarding-tour law: resolve from the live catalog).
  function kitPropLabel(objType) {
    const t = String(objType || '').trim();
    const wm = WM(), map = (wm && wm.CAP_PROP_MAP) || {};
    // pick the first prop id that maps to this cap, then look up its catalog label.
    let propId = null;
    for (const pid of Object.keys(map)) { if (map[pid] === t) { propId = pid; break; } }
    if (!propId && map[t]) propId = t;   // workbench/studio map 1:1
    if (propId && typeof PropSprites !== 'undefined' && Array.isArray(PropSprites.CATALOG)) {
      const spec = PropSprites.CATALOG.find(c => c && c.id === propId);
      if (spec && spec.label) return spec.label;
    }
    // last resort: the power word (still a live source, never a made-up prop name)
    return (wm && wm.CAP_LABEL && wm.CAP_LABEL[t]) || t.toUpperCase();
  }

  // skill catalog cache: { slug -> { name, description } } from /api/skills. Fetched once, then dossiers hydrate
  // async (the section renders a placeholder, then fills in). Best-effort — a missing catalog degrades to the slug.
  let skillCatalog = null, skillCatalogPending = null;
  function loadSkillCatalog() {
    if (skillCatalog) return Promise.resolve(skillCatalog);
    if (skillCatalogPending) return skillCatalogPending;
    skillCatalogPending = fetch('/api/skills').then(r => r.ok ? r.json() : { skills: [] })
      .then(d => {
        const map = {};
        for (const s of ((d && d.skills) || [])) if (s && s.slug) map[s.slug] = { name: s.name || s.slug, description: s.description || '' };
        skillCatalog = map; skillCatalogPending = null; return map;
      })
      // FAILURE MUST STAY RETRYABLE: a transient sidecar hiccup used to cache `skillCatalog = {}`, and the
      // `if (skillCatalog)` guard above then short-circuited every later open — recipes showed raw slugs for
      // the rest of the session even after the sidecar recovered. Leave skillCatalog null and clear the
      // in-flight marker so the NEXT natural open re-fetches (same retry shape as cronPending below). Return
      // an empty map so THIS call's hydrateSkillRows degrades to slug placeholders instead of throwing.
      .catch(() => { skillCatalogPending = null; return {}; });
    return skillCatalogPending;
  }

  /* ---------- open / close ---------- */
  function open(context) {
    if (!has()) return;
    const trigger = (typeof document !== 'undefined' && document.activeElement) || null;
    close();
    opener = trigger;
    ctx = context || {};
    view = 'grid'; editingId = null; editingRecipeId = null; launchId = null; pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null;
    editForkedFrom = null; editSourceRunId = null;
    importStep = 'detect'; importFound = null; importDetecting = false; importScanning = false;
    importScan = null; importOrigin = null; importName = ''; importErr = '';
    laneFilter = 'all'; catFilter = 'all'; query = '';
    lastDecodedHero = null;   // a fresh bay open replays the hero decode beat once
    // SCOUT: re-read server truth on open (fresh drafts/interests land) and push the browser-only dedup context.
    try { if (typeof ProspectStore !== 'undefined' && ProspectStore.refresh) { ProspectStore.pushContext(); ProspectStore.refresh(); } } catch (_) {}
    tab = (ctx.mode !== 'pick' && ctx.tab === 'recipes' && hasRecipes()) ? 'recipes' : 'agents';
    glassOpen = !acked();
    summonConfigOpen = false;
    scoutLogOpen = false;
    pickedSummonSkin = null;
    pickedSummonModel = null;
    pickedSummonName = '';
    const builtins = Specialties.builtins();
    focusAgent = (ctx.currentSpecialtyId && Specialties.get(ctx.currentSpecialtyId)) ? ctx.currentSpecialtyId : (builtins[0] && builtins[0].id) || null;
    focusRecipe = hasRecipes() ? ((Recipes.builtins()[0] && Recipes.builtins()[0].id) || null) : null;

    root = el('div', 'mkt-scrim');
    root.innerHTML =
      '<div class="mkt" role="dialog" aria-modal="true" aria-labelledby="mkt-title" aria-describedby="mkt-sub" tabindex="-1">' +
        '<span class="mkt-screw tl"></span><span class="mkt-screw tr"></span><span class="mkt-screw bl"></span><span class="mkt-screw br"></span>' +
        '<span class="mkt-brk tl"></span><span class="mkt-brk tr"></span><span class="mkt-brk bl"></span><span class="mkt-brk br"></span>' +
        '<div class="mkt-head">' +
          '<div class="mkt-nameplate"><span class="mkt-title" id="mkt-title">▮ RECRUITMENT BAY</span>' +
            '<span class="mkt-sub" id="mkt-sub">' + esc(subtitle()) + '</span></div>' +
          '<div class="mkt-search">⌕ <input id="mkt-q" type="text" autocomplete="off" spellcheck="false" placeholder="search classes…" aria-label="Search classes"></div>' +
          '<button class="mkt-x" aria-label="Close recruitment bay" title="close">✕</button>' +
        '</div>' +
        '<div class="mkt-bar" id="mkt-bar"></div>' +
        '<div class="mkt-stage" id="mkt-stage"></div>' +
        '<div class="mkt-foot">' +
          '<span id="mkt-foot-legend">' + footLegendHTML() + '</span>' +
          '<span class="reg"><span class="dot"></span> LOCAL REGISTRY · 0 BYTES OFF-MACHINE</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });
    root.querySelector('.mkt-x').addEventListener('click', () => { sfx('close'); close(); });
    const q = root.querySelector('#mkt-q');
    if (q) q.addEventListener('input', () => { query = (q.value || '').toLowerCase().trim(); renderStage(); restoreSearchFocus(); });
    document.addEventListener('keydown', onKey, true);
    sfx('open');
    pendingCardAnim = true;   // the first paint gets the staggered card entrance
    renderBar();
    renderStage();
    const panel = root.querySelector('.mkt'); if (panel) panel.focus();
    maybeConsumeRecipeMint();   // R5: if opened to bottle a run, drop straight into the editor pre-filled from it
    maybeConsumeLaunchSeed();   // lane D: if opened by the routine nudge, drop straight into the launch/SCHEDULE IT form
  }
  // R5 "BOTTLE A RUN" consume: app.js seeds ctx.recipeMint (a Recipes.mintFromRun proposal — a DRAFT custom recipe
  // pre-filled from a 👍-rated run's directive, carrying sourceRunId) before opening the bay on the RECIPES tab.
  // Open the R2 editor on it (same entry as TWEAK, but source:'custom' + sourceRunId preserved), then CLEAR the seed
  // so it's one-shot (a re-render / tab-switch never re-triggers it). Graceful no-op if absent or malformed.
  function maybeConsumeRecipeMint() {
    const seed = ctx && ctx.recipeMint;
    if (!seed || typeof seed !== 'object') return;
    if (ctx) ctx.recipeMint = null;   // one-shot: consume before doing anything that could re-render
    if (!hasRecipes() || tab !== 'recipes') return;
    // a bottled proposal must at least carry a task template to be editable; anything less is a malformed seed.
    if (!seed.task || !String(seed.task).trim()) return;
    pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null;
    // 'create' entry (a brand-new custom, not a fork of an existing recipe) — the proposal is the pre-fill.
    // enterRecipeEditor lifts seed.sourceRunId into editSourceRunId so it survives save.
    enterRecipeEditor(seed, 'create');
  }
  // lane D launch-seed consume (the recipeMint pattern): app.js seeds ctx.launchSeed = { id, mode:'run'|'routine' }
  // before opening the bay on the RECIPES tab (App.openRecipeLaunch — the routine-nudge accept). Drop straight into
  // that recipe's launch form, in routine mode when asked (cadence preset to the recipe's suggestion, cron armed-state
  // warmed) — the same PROPOSE-AND-CONFIRM form every manual schedule goes through. One-shot: the seed is cleared
  // before any render so a tab-switch / re-render never re-triggers it. Graceful no-op on an unknown recipe.
  function maybeConsumeLaunchSeed() {
    const seed = ctx && ctx.launchSeed;
    if (!seed || typeof seed !== 'object') return;
    if (ctx) ctx.launchSeed = null;   // one-shot: consume before doing anything that could re-render
    if (!hasRecipes() || tab !== 'recipes') return;
    const r = Recipes.get(String(seed.id || '')); if (!r) return;
    focusRecipe = r.id;
    launchId = r.id;
    launchMode = (seed.mode === 'routine') ? 'routine' : 'run';
    if (launchMode === 'routine') {
      launchCadence = (r.cadence && cadenceOpt(r.cadence)) ? r.cadence : 'morning';
      loadCronJobs().then(() => { if (view === 'launch') renderStage(); });   // refresh the armed-state note
    }
    view = 'launch';
    renderBar(); renderStage();
  }
  function close() {
    if (!root) return;
    document.removeEventListener('keydown', onKey, true);
    root.remove(); root = null; ctx = null; view = 'grid';
    editingId = null; editingRecipeId = null; launchId = null; pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null;
    const o = opener; opener = null;
    try { if (o && o.focus) o.focus(); } catch (_) {}
  }
  // a stage re-render (from typing in search) rebuilds the input; re-focus it and keep the caret at the end.
  function restoreSearchFocus() {
    const q = root && root.querySelector('#mkt-q');
    if (q) { q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (_) {} }
  }
  function focusables() {
    if (!root) return [];
    return Array.from(root.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(e => e.offsetWidth > 0 || e.offsetHeight > 0 || e === document.activeElement);
  }
  // narrow bay = the responsive breakpoint where the dossier becomes a full-width sheet OVER the roster.
  function isNarrowBay() { try { return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches; } catch (_) { return false; } }
  function isTypingTarget(t) { return !!(t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
  // dismiss the narrow dossier SHEET back to the roster (the stranded-state fix) and restore focus to the card
  // that opened it, so a keyboard user isn't dropped at the top of the list.
  function closeDossierSheet() {
    const mkt = root && root.querySelector('.mkt'); if (!mkt) return;
    mkt.classList.remove('show-dossier'); sfx('click');
    const fid = tab === 'recipes' ? focusRecipe : focusAgent;
    const card = fid && root.querySelector('.mkt-card[data-id="' + fid + '"]');
    if (card && card.focus) { try { card.focus(); } catch (_) {} }
  }
  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') {
      // Esc is a STEP-BACK, not an instant bay-close, whenever there's somewhere to step back to (stranded-user
      // law): (1) a full-width form view routes through its own BACK (which resets the right editor state, never
      // discards silently mid-bay); (2) the narrow dossier-only sheet returns to the roster. Only at the top-level
      // grid does Esc close the whole bay.
      if (view !== 'grid') { const back = root.querySelector('.mkt-cancel'); if (back) { e.preventDefault(); e.stopPropagation(); back.click(); return; } }
      const mkt = root.querySelector('.mkt');
      if (mkt && mkt.classList.contains('show-dossier') && isNarrowBay()) { e.preventDefault(); e.stopPropagation(); closeDossierSheet(); return; }
      sfx('close'); close(); return;
    }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) { e.preventDefault(); const p = root.querySelector('.mkt'); if (p) p.focus(); return; }
      const first = f[0], last = f[f.length - 1], act = document.activeElement;
      if (!root.contains(act)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
      return;
    }
    // "/" jumps to the search box from anywhere in the bay (unless already typing) — the discovery shortcut.
    if (e.key === '/' && !isTypingTarget(e.target)) {
      const q = root.querySelector('#mkt-q');
      if (q) { e.preventDefault(); q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (_) {} }
    }
  }
  function subtitle() {
    if (ctx && ctx.mode === 'pick') return ctx.summon
      ? ('summon a new agent onto your crew — it gets its own chat thread'
         + (ctx.concurrentCap > 0 ? ' · up to ' + ctx.concurrentCap + ' run at once' : ''))
      : 'choose a specialist to wake your agent as';
    const who = (ctx && ctx.agentName) || 'your agent';
    return tab === 'recipes'
      ? 'launch a ready-made recipe — ' + who + ' picks it up in a fresh workstream'
      : 'deploy a specialty onto ' + who + ' — or save this one as a template';
  }

  /* ---------- the bar: tabs + lane filter ---------- */
  function renderBar() {
    const bar = root && root.querySelector('#mkt-bar'); if (!bar) return;
    let html = '';
    if (!(ctx && ctx.mode === 'pick') && hasRecipes()) {
      const t = (id, label) => '<button class="mkt-tab' + (tab === id ? ' on' : '') + '" role="tab" aria-selected="' +
        (tab === id ? 'true' : 'false') + '" data-tab="' + id + '">' + label + '</button>';
      html += '<div class="mkt-tabs" role="tablist">' + t('agents', '☰ AGENTS') + t('recipes', '❒ RECIPES') + '</div>';
    }
    if (tab === 'recipes' && hasRecipes()) {
      // R6 CATEGORY RAIL — persona buckets (developer/research/creator/ops/general) + ALL + MINE, each with a
      // live count. MINE holds the Commander's own customs (saved / forked / imported). An IMPORT button sits at
      // the end of the rail (file → validate → save as custom); EXPORT lives per-recipe in the dossier.
      const builtins = Recipes.builtins(), customs = Recipes.customs();
      const all = builtins.concat(customs);
      const counts = { all: all.length, mine: customs.length };
      RAIL_BUCKETS.forEach(b => counts[b] = 0);
      all.forEach(r => { const rb = railBucket(r); counts[rb] = (counts[rb] || 0) + 1; });
      const cat = (id, label) => '<button class="mkt-lane' + (catFilter === id ? ' on' : '') + '" data-cat="' + id + '">' +
        label + '<span class="ct">' + (counts[id] || 0) + '</span></button>';
      let rail = cat('all', 'ALL');
      RAIL_BUCKETS.forEach(b => { if (counts[b] > 0 || b === 'general') rail += cat(b, CAT_LABEL[b] || b); });
      rail += cat('mine', 'MINE');
      html += '<span class="mkt-lanes-lbl">BROWSE</span><div class="mkt-lanes">' + rail + '</div>' +
        '<button class="mkt-import bb sm" title="import a recipe from a JSON file">⇪ IMPORT</button>' +
        '<input type="file" id="mkt-import-file" accept="application/json,.json" hidden>';
    } else {
      // FILTER counts span the WHOLE roster — built-ins AND the Commander's customs (audit item 8) — so a lane
      // count never undercounts a class the Commander authored. MINE = the customs scope chip (mirrors RECIPES).
      const customs = has() ? Specialties.customs() : [];
      const pool = Specialties.builtins().concat(customs);
      const counts = { all: pool.length, code: 0, research: 0, general: 0, mine: customs.length };
      pool.forEach(it => { counts[laneOf(it)] = (counts[laneOf(it)] || 0) + 1; });
      const lane = (id, label) => '<button class="mkt-lane' + (laneFilter === id ? ' on' : '') + '" data-lane="' + id + '">' +
        label + '<span class="ct">' + (counts[id] || 0) + '</span></button>';
      let rail = lane('all', 'ALL') + lane('code', 'CODE') + lane('research', 'RESEARCH') + lane('general', 'OPS');
      if (customs.length) rail += lane('mine', 'MINE');
      html += '<span class="mkt-lanes-lbl">FILTER</span><div class="mkt-lanes">' + rail + '</div>';
      // IMPORT AGENT: the one-click migration door from OpenClaw / Hermes. Only meaningful when the bay can MINT a
      // new agent (summon/pick mode carries ctx.onPick) — a deploy-only bay has no agent to create. Mirrors the
      // recipes-tab ⇪ IMPORT control's look (mkt-import pushes it to the right; bb sm is the shared button chrome).
      if (ctx && ctx.onPick) {
        html += '<button class="mkt-import mkt-import-agent bb sm" title="bring an agent over from OpenClaw or Hermes">⇪ IMPORT AGENT</button>';
      }
    }
    bar.innerHTML = html;
    // per-tab search placeholder (audit item 8): name what "search" actually spans on this tab.
    const q = root && root.querySelector('#mkt-q');
    if (q) { const ph = (tab === 'recipes') ? 'search recipes…' : 'search classes, codes, purpose…';
      q.placeholder = ph; q.setAttribute('aria-label', tab === 'recipes' ? 'Search recipes' : 'Search classes'); }
    bar.querySelectorAll('.mkt-tab').forEach(b => b.addEventListener('click', () => {
      const next = b.dataset.tab; if (!next || next === tab) return;
      tab = next; view = 'grid'; laneFilter = 'all'; catFilter = 'all'; sfx('click');
      pendingCardAnim = true;   // a tab switch is a fresh context — animate; a filter/search rebuild is not
      renderBar(); renderStage(); syncSub(); syncFoot();
    }));
    bar.querySelectorAll('.mkt-lane[data-lane]').forEach(b => b.addEventListener('click', () => {
      const next = b.dataset.lane; if (next === laneFilter) return;
      laneFilter = next; sfx('click'); renderBar(); renderStage();
      // renderBar rebuilt the chips — return focus to the one just clicked (audit item 8), not to the modal shell.
      const again = root.querySelector('.mkt-lane[data-lane="' + next + '"]'); if (again) again.focus();
    }));
    bar.querySelectorAll('.mkt-lane[data-cat]').forEach(b => b.addEventListener('click', () => {
      const next = b.dataset.cat; if (next === catFilter) return;
      catFilter = next; sfx('click'); renderBar(); renderStage();
      const again = root.querySelector('.mkt-lane[data-cat="' + next + '"]'); if (again) again.focus();
    }));
    const impAgent = bar.querySelector('.mkt-import-agent');
    if (impAgent) impAgent.addEventListener('click', () => { sfx('click'); enterHarnessImport(); });
    wireImport(bar);
  }
  function syncSub() { const s = root && root.querySelector('#mkt-sub'); if (s) s.textContent = subtitle(); }
  // the footer legend explains the CARD glyphs of the CURRENT tab — clearance pips on AGENTS, setup marks on
  // RECIPES (the pips legend was plain wrong on the recipes grid). Swapped on every tab change (audit item 8).
  function footLegendHTML() {
    return (tab === 'recipes' && hasRecipes())
      ? 'SETUP&nbsp;&nbsp;<b>▤</b> needs inputs&nbsp;·&nbsp;<b>◷</b> no setup'
      : 'CLEARANCE&nbsp;&nbsp;<b>◆◆◆</b> DEEP&nbsp;·&nbsp;<b>◆◆</b> BALANCED&nbsp;·&nbsp;<b>◆</b> FAST';
  }
  function syncFoot() { const f = root && root.querySelector('#mkt-foot-legend'); if (f) f.innerHTML = footLegendHTML(); }

  /* ---------- stage: two-pane (roster + dossier) OR a full-width form ---------- */
  function renderStage() {
    const stage = root && root.querySelector('#mkt-stage'); if (!stage) return;
    if (view === 'save' || view === 'recipesave' || view === 'launch' || view === 'build' || view === 'harnessImport') {
      stage.className = 'mkt-stage form';
      stage.innerHTML = view === 'save' ? saveFormHTML() : view === 'recipesave' ? recipeSaveFormHTML()
        : view === 'build' ? buildFormHTML() : view === 'harnessImport' ? harnessImportHTML() : launchFormHTML();
      if (view === 'save') wireSaveForm(stage);
      else if (view === 'recipesave') wireRecipeSaveForm(stage);
      else if (view === 'build') wireBuildForm(stage);
      else if (view === 'harnessImport') wireHarnessImport(stage);
      else wireLaunchForm(stage);
      return;
    }
    stage.className = 'mkt-stage';
    // a fresh grid render (open / tab / filter / search) always returns to the ROSTER view on a narrow bay — the
    // dossier SHEET is only entered by an explicit card click, never left stuck over a rebuilt roster.
    const mkt0 = root.querySelector('.mkt'); if (mkt0) mkt0.classList.remove('show-dossier');
    const animCls = pendingCardAnim ? ' mkt-anim' : ''; pendingCardAnim = false;   // entrance stagger only on open/tab-switch
    stage.innerHTML = '<div class="mkt-roster' + animCls + '" id="mkt-roster">' + rosterHTML() + '</div>' +
                      '<div class="mkt-dossier" id="mkt-dossier">' + dossierHTML() + '</div>';
    wireRoster(stage);
    wireDossier(stage);
    paintDossierAccent();
    decodeHero();
    hydrateSkillRows();                          // fill real skill names once the catalog loads (agent + recipe dossiers)
    if (tab === 'recipes') hydrateLiveRoutines();   // fill the "● live as a routine" indicator once /api/cron loads
    if (!root.contains(document.activeElement)) { const p = root.querySelector('.mkt'); if (p) p.focus(); }
  }
  function renderDossier() {
    const d = root && root.querySelector('#mkt-dossier'); if (!d) return;
    d.innerHTML = dossierHTML();
    wireDossier(root);
    paintDossierAccent();
    decodeHero();
    hydrateSkillRows();                          // fill real skill names once the catalog loads (agent + recipe dossiers)
    if (tab === 'recipes') hydrateLiveRoutines();   // refresh the live-routine indicator for the focused recipe
    const fid = tab === 'recipes' ? focusRecipe : focusAgent;
    root.querySelectorAll('.mkt-card').forEach(c => c.classList.toggle('sel', c.dataset.id === fid));
  }

  /* ---------- filtering ---------- */
  function matchq(it) {
    if (!query) return true;
    // search spans name + tagline + blurb AND the class CODE (e.g. "ENG") + purpose text (audit item 8), so a
    // Commander can find a class by its stamp or by what it actually does, not just its name.
    const hay = (it.name || '') + ' ' + (it.tagline || '') + ' ' + (it.blurb || '') + ' ' +
      (it.purpose || '') + ' ' + codeOf(it);
    return hay.toLowerCase().includes(query);
  }
  // MINE is a scope filter (customs only), handled by the roster; it must PASS-THROUGH here so filt() doesn't
  // strip every card (no card's lane is literally "mine").
  function passLane(it) { return laneFilter === 'all' || laneFilter === 'mine' || laneOf(it) === laneFilter; }
  function filt(list) { return list.filter(it => passLane(it) && matchq(it)); }
  // RECIPES tab filtering (R6): category rail + free-text search. 'all' passes everything, 'mine' passes customs,
  // any other value is a rail bucket. Search (matchq) also spans the blurb — the plan's name/tagline/blurb search.
  function passCat(r) {
    if (catFilter === 'all') return true;
    if (catFilter === 'mine') return !!r.custom;
    return railBucket(r) === catFilter;
  }
  function filtRecipes(list) { return list.filter(r => passCat(r) && matchq(r)); }

  /* ---------- roster (left pane) ---------- */
  function rosterHTML() {
    return (tab === 'recipes' && hasRecipes()) ? recipesRosterHTML() : agentsRosterHTML();
  }
  function agentsRosterHTML() {
    const deploy = !ctx || ctx.mode !== 'pick';
    const summon = !!(ctx && ctx.mode === 'pick' && ctx.summon);
    // search OR a lane filter collapses the top shelves + config so the results grid owns the pane — the same
    // discipline the RECIPES tab uses (audit item 7). MINE is a lane filter value, so it collapses too.
    const filtering = !!query || laneFilter !== 'all';
    // deploy mode keeps the SAVE-THIS-AGENT toolbar; summon drops the stale "pre-fills the wake screen" hint —
    // the subtitle already states the summon promise, and the config strip + shelves carry the rest.
    const toolbar = deploy
      ? '<div class="mkt-toolbar"><button class="bb sm mkt-saveas">＋ SAVE THIS AGENT AS A SPECIALTY</button></div>'
      : '';
    let html = toolbar;

    // TOP OF THE PANE (audit item 3): the class choice is primary, so the earned/recommended shelves + the roster
    // sit up top; APPEARANCE + MODEL compress into a slim collapsible SUMMON CONFIG strip (good defaults, one click
    // to expand). All of it hides while searching/filtering so the filtered grid is uncluttered.
    if (!filtering) {
      if (summon) html += summonConfigHTML();
      html += glassHTML();          // '' in pick mode; STATION FAMILIARITY glass box in deploy mode
      html += recShelfHTML();
      html += prospectShelfHTML();
      html += scoutLogHTML();   // the attempt ledger (both kinds) — clean top-level view only (filtering is false here)
    }

    const buildTile = '<button class="mkt-build" type="button" aria-label="build a custom class">' +
      '<span class="mkt-build-plus" aria-hidden="true">＋</span><span class="mkt-build-lbl">BUILD A CUSTOM CLASS</span></button>';
    const allBuiltins = Specialties.builtins();
    const builtins = filt(allBuiltins);
    const customs = filt(Specialties.customs());
    const hasAnyCustoms = Specialties.customs().length > 0;

    // MINE view: the Commander's own specialists only (matches the RECIPES-tab MINE chip).
    if (laneFilter === 'mine') {
      html += sectH('▮ YOUR SPECIALISTS');
      html += customs.length
        ? '<div class="mkt-grid mkt-rows">' + customs.map(cardHTML).join('') + buildTile + '</div>'
        : '<p class="mkt-hint mkt-yours-hint">' + (query ? 'none of your specialists match your search — '
            : 'none yet — ') + 'build one from scratch below.</p><div class="mkt-grid mkt-rows">' + buildTile + '</div>';
      return html;
    }

    // customs pinned ABOVE the built-in catalog when the Commander has some AND isn't searching (their own classes
    // are the more relevant pick); otherwise CLASS ROSTER leads (beginners keep it above the fold) and YOUR
    // SPECIALISTS + the build tile sit at the bottom. (audit item 7 reconciled with item 3)
    const pinCustoms = hasAnyCustoms && !query;
    if (pinCustoms) {
      html += sectH('▮ YOUR SPECIALISTS');
      html += '<div class="mkt-grid mkt-rows">' + customs.map(cardHTML).join('') + buildTile + '</div>';
    }

    html += sectH('▮ CLASS ROSTER');
    // truthful telemetry: an EMPTY catalog means the shared catalog script failed to load (a wiring
    // fault), not "no matches" — say so loudly instead of rendering a quietly blank roster.
    if (!allBuiltins.length) html += '<div class="mkt-empty">⚠ the class catalog failed to load (shared/specialties.js unreachable) — the built-in roster is unavailable. Restart the app; if it persists, this build is mis-wired.</div>';
    else html += builtins.length ? '<div class="mkt-grid mkt-rows">' + builtins.map(cardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no classes match your ' + (query ? 'search' : 'filter') + '.</div>';

    html += archiveSectionHTML(filtering);

    if (!pinCustoms) {
      html += sectH('▮ YOUR SPECIALISTS');
      if (!customs.length) html += '<p class="mkt-hint mkt-yours-hint">' +
        (query ? 'none of your specialists match your search — ' : 'none yet — ') +
        'build one from scratch below' + (deploy && !query ? ', or save the live agent as a specialty above' : '') + '.</p>';
      html += '<div class="mkt-grid mkt-rows">' + customs.map(cardHTML).join('') + buildTile + '</div>';
    }
    return html;
  }
  /* ---------- SPECIALIST ARCHIVE: the deep-cut archetype pool (never gated, never in the way) ----------
     The default roster is the curated 12; the demoted deep cuts stay one click away here — full specs,
     summonable as-is. Collapsed by default in the clean view; a search or lane filter that matches an
     archetype auto-expands it (search must FIND a class, never hide it — the no-gating law). These same
     archetypes are what the scout drafts onto the DRAFTED-FOR-YOU shelf when the learned interests point
     at one, so this section is the manual door to the pool the station recommends from. */
  function archiveSectionHTML(filtering) {
    const all = (Specialties.archetypes ? Specialties.archetypes() : []);
    if (!all.length) return '';
    const archs = filt(all);
    if (filtering) {
      // searching / lane-filtering: archetypes participate like any class — matches render expanded, no toggle.
      if (!archs.length) return '';
      return sectH('▮ SPECIALIST ARCHIVE — deep cuts') + '<div class="mkt-grid mkt-rows">' + archs.map(cardHTML).join('') + '</div>';
    }
    const head = '<button type="button" class="mkt-sect-h mkt-archive-head" aria-expanded="' + (archiveOpen ? 'true' : 'false') + '">' +
      '<span aria-hidden="true">' + (archiveOpen ? '▾' : '▸') + '</span> SPECIALIST ARCHIVE (' + all.length + ')</button>';
    if (!archiveOpen) return head;
    return head +
      '<p class="mkt-hint">niche classes held off the main roster — fully specified, summon any time. When your real work points at one, the station drafts it onto the shelf above for you.</p>' +
      '<div class="mkt-grid mkt-rows">' + archs.map(cardHTML).join('') + '</div>';
  }
  // SUMMON CONFIG (audit item 3): a compact collapsible strip for APPEARANCE + MODEL. Both carry good defaults
  // (Cadet skin, inherit the orchestrator's model), so it's COLLAPSED by default with a one-line summary of the
  // current picks; expanding reveals the live skin stage + model picker. summonConfigOpen persists across the
  // re-renders within one open bay.
  function summonConfigHTML() {
    if (!(ctx && ctx.mode === 'pick' && ctx.summon)) return '';
    const modelSummary = (pickedSummonModel && pickedSummonModel.model) ? esc(shortModel(pickedSummonModel.model))
      : (pickedSummonModel && pickedSummonModel.effort) ? 'inherit · ' + esc(String(pickedSummonModel.effort).toUpperCase()) + ' effort'
      : 'same as orchestrator';
    const head =
      '<button type="button" class="mkt-cfg-head" aria-expanded="' + (summonConfigOpen ? 'true' : 'false') + '">' +
        '<span class="mkt-cfg-caret" aria-hidden="true">' + (summonConfigOpen ? '▾' : '▸') + '</span>' +
        '<span class="mkt-cfg-ttl">SUMMON CONFIG</span>' +
        '<span class="mkt-cfg-sum"><span class="mkt-cfg-k">NAME</span> <span class="mkt-candidate-name">' + esc(summonCandidateName((focusAgent && Specialties.get(focusAgent)) || null)) + '</span>' +
          ' <span class="mkt-cfg-k">SKIN</span> ' + esc(summonSkinName()) +
          ' <span class="mkt-cfg-k">MODEL</span> ' + modelSummary + '</span>' +
      '</button>';
    if (!summonConfigOpen) return '<div class="mkt-cfg">' + head + '</div>';
    return '<div class="mkt-cfg open">' + head +
      '<div class="mkt-cfg-body">' + summonNameBarHTML() + summonSkinBarHTML() + summonModelBarHTML() + '</div></div>';
  }
  function summonSkinName() {
    const id = (pickedSummonSkin && typeof DATA !== 'undefined' && DATA.SKINS && DATA.SKINS[pickedSummonSkin]) ? pickedSummonSkin : (typeof DATA !== 'undefined' ? DATA.DEFAULT_SKIN : '');
    const sk = (typeof DATA !== 'undefined' && DATA.SKINS) ? DATA.SKINS[id] : null;
    return (sk && sk.name) || id || '—';
  }
  function shortModel(m) { return String(m || '').split('/').pop().replace(/[-_]+/g, ' ').trim() || String(m || ''); }
  // ONE section-header component (audit item 8): amber struck-metal plate for roster ranks. Shelves add their own
  // gold/phosphor modifier class on top of .mkt-sect-h; the config strip uses its own plain .mkt-cfg-ttl label.
  function sectH(label, extra) { return '<div class="mkt-sect-h' + (extra ? ' ' + extra : '') + '">' + label + '</div>'; }
  function recipesRosterHTML() {
    if (!hasRecipes()) return '<div class="mkt-empty">the recipe library isn’t available.</div>';
    let html = '<div class="mkt-toolbar"><button class="bb sm mkt-recipe-saveas">＋ SAVE A RECIPE</button>' +
      '<span class="mkt-hint">pick a recipe, fill in the blanks, and ' + esc((ctx && ctx.agentName) || 'your agent') + ' runs it in a fresh workstream</span></div>';
    html += glassHTML();
    html += suggestedShelfHTML();
    html += forYouShelfHTML();
    if (catFilter === 'all' && !query) html += scoutLogHTML();   // the attempt ledger, in the clean top-level view only
    const builtins = filtRecipes(Recipes.builtins());
    const customs = filtRecipes(Recipes.customs());
    // MINE view: a single "YOUR RECIPES" section (the builtins are all filtered out anyway).
    if (catFilter === 'mine') {
      html += '<div class="mkt-sect-h">▮ YOUR RECIPES</div>';
      html += customs.length ? '<div class="mkt-grid mkt-rows">' + customs.map(recipeCardHTML).join('') + '</div>'
        : '<div class="mkt-empty">' + (query ? 'none of your recipes match your search.'
            : 'no saved recipes yet — hit “＋ save a recipe” above, TWEAK any recipe into your own, or ⇪ IMPORT one from a file.') + '</div>';
      return html;
    }
    const libLabel = catFilter === 'all' ? '▮ RECIPE LIBRARY' : ('▮ ' + (CAT_LABEL[catFilter] || catFilter) + ' RECIPES');
    html += '<div class="mkt-sect-h">' + libLabel + '</div>';
    html += builtins.length ? '<div class="mkt-grid mkt-rows">' + builtins.map(recipeCardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no recipes match your ' + (query ? 'search' : 'filter') + '.</div>';
    html += '<div class="mkt-sect-h">▮ YOUR RECIPES</div>';
    html += customs.length ? '<div class="mkt-grid mkt-rows">' + customs.map(recipeCardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no saved recipes here yet — ＋ save one, TWEAK any recipe, or ⇪ IMPORT from a file.</div>';
    return html;
  }

  // Keep the raw value visible so a 19-character paste can be explained, never silently clipped.
  function summonNameBarHTML() {
    if (!(ctx && ctx.mode === 'pick' && ctx.summon)) return '';
    const used = ((typeof AgentId !== 'undefined' && AgentId.normalizeName) ? AgentId.normalizeName(pickedSummonName) : String(pickedSummonName || '')).length;
    const max = (ctx && ctx.displayNameLimit) || (typeof AgentId !== 'undefined' && AgentId.NAME_MAX) || 18;
    const issue = summonNameIssue(), dup = summonNameConflict();
    const helper = issue === 'too-long' ? 'too long — shorten this name before summoning'
      : dup ? 'duplicate name — summon requires a second confirmation; the agent id will remain unique'
      : 'blank uses the proposed default: ' + summonCandidateName((focusAgent && Specialties.get(focusAgent)) || null);
    return '<div class="mkt-skinbar mkt-namebar"><label class="mkt-skinlabel" for="mkt-summon-name">NAME <span class="mkt-hint">— what this agent answers to</span></label>' +
      '<input class="mkt-in" id="mkt-summon-name" type="text" autocomplete="off" spellcheck="false" aria-invalid="' + (issue ? 'true' : 'false') + '" placeholder="proposed default" value="' + esc(pickedSummonName) + '">' +
      '<div class="mkt-name-meta"><span class="mkt-name-help' + (issue || dup ? ' warn' : '') + '">' + esc(helper) + '</span><span class="mkt-name-count' + (used > max ? ' over' : '') + '">' + used + ' / ' + max + '</span></div></div>';
  }

  // SUMMON-only: pick the new agent's APPEARANCE (its own choice — independent of class). A LIVE preview
  // STAGE (shared SkinStage) plays the picked/hovered skin's real walk cycle big enough to actually read —
  // a 40px still of a chunky sprite is unidentifiable. The picker wells are large + smooth-downscaled so the
  // Commander can judge a skin at a glance; the selected well carries the bracket-ring active treatment.
  function summonSkinBarHTML() {
    if (!(ctx && ctx.mode === 'pick' && ctx.summon) || typeof DATA === 'undefined' || !DATA.SKINS) return '';
    if (!pickedSummonSkin || !DATA.SKINS[pickedSummonSkin]) pickedSummonSkin = DATA.DEFAULT_SKIN;
    const thumbs = Object.keys(DATA.SKINS).map(id => {
      const sk = DATA.SKINS[id];
      return '<button type="button" class="skin-thumb' + (id === pickedSummonSkin ? ' sel' : '') +
        '" data-skin="' + esc(id) + '" title="' + esc(sk.name || id) + '">' +
        '<img src="assets/sprites/' + esc(sk.set) + '/rot_south.png" alt="' + esc(sk.name || id) + '" draggable="false"></button>';
    }).join('');
    // the live stage: SkinStage.mount binds these two ids in wireRoster and plays the picked skin's walk cycle.
    // caption: a static "LIVE PREVIEW —" label + a name span SkinStage fills (mount targets the inner span, so the
    // prefix survives every skin change). Names the live stage for what it is (audit item 8).
    const stage =
      '<figure class="mkt-skin-stage">' +
        '<div class="mkt-skin-stage-frame"><img id="mkt-skin-stage-img" alt="" draggable="false"></div>' +
        '<figcaption class="mkt-skin-stage-name"><span class="mkt-stage-lbl">LIVE PREVIEW —</span> <span id="mkt-skin-stage-name"></span></figcaption>' +
      '</figure>';
    return '<div class="mkt-skinbar"><label class="mkt-skinlabel">APPEARANCE <span class="mkt-hint">— the character this agent wears (your call, any class)</span></label>' +
      '<div class="mkt-skin-section">' +
        '<div class="skin-picker" id="mkt-skin-picker">' + thumbs + '</div>' +
        stage +
      '</div></div>';
  }

  // SUMMON-only: choose the new agent's MODEL (optional — blank inherits the orchestrator's). Reuses the shared
  // ModelPicker so the catalog, grouping and effort options match the COMMS dock and the dossier. The <select>
  // is populated asynchronously after mount (wireRoster), then read at SUMMON time into spec.modelPin.
  function summonModelBarHTML() {
    if (!(ctx && ctx.mode === 'pick' && ctx.summon) || typeof ModelPicker === 'undefined') return '';
    return '<div class="mkt-skinbar mkt-modelbar"><label class="mkt-skinlabel">MODEL <span class="mkt-hint">— which brain it runs on (blank = same as your orchestrator)</span></label>' +
      '<div class="mkt-modelpick" id="mkt-model-pick">' +
        ModelPicker.shellHTML({ id: 'mkt-model', inheritLabel: 'Same as the orchestrator', ariaLabel: 'New agent model', effort: true }) +
      '</div></div>';
  }

  /* ---------- the class card (coin seal in the roster) ---------- */
  function cardHTML(s, i) {
    // DEPLOYED flag is mode-independent: the merged recruit door passes currentSpecialtyId in
    // pick mode too, so the card the current agent already runs as stays honestly marked.
    const here = !!(ctx && ctx.currentSpecialtyId && ctx.currentSpecialtyId === s.id);
    const sel = (focusAgent === s.id);
    // settings-console row shape: [typed mark socket] [name + tagline] ……… [lane · pips · tier / code]
    // — the right cluster is its own column so it right-aligns like the provider rows' status column.
    return '<button class="mkt-card' + (sel ? ' sel' : '') + '" type="button" data-id="' + esc(s.id) + '" style="--accent:' + esc(s.accent) + ';--ci:' + (i || 0) + '">' +
      sealHTML(s, false) +
      '<div class="mkt-card-id">' +
        '<div class="mkt-name">' + esc(s.name) +
          (here ? ' <span class="mkt-badge mkt-here">DEPLOYED</span>' : '') +
          (s.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
        '<div class="mkt-tag">' + esc(s.tagline) + '</div>' +
      '</div>' +
      '<div class="mkt-card-side">' +
        '<div class="mkt-meta"><span class="mkt-chip lane">' + esc(laneLabelOf(s)) + '</span>' +
          pipsOf(s.model) + ' <span class="mkt-tier">' + esc(clearanceLabel(s.model)) + '</span></div>' +
        '<span class="mkt-card-code">' + esc(codeOf(s)) + '</span>' +
      '</div>' +
    '</button>';
  }
  // lane F: the honest-life chip — the Commander's OWN launch count for this recipe (never anyone else's, never
  // a fake "popular"), plus a rated arrow once their own verdicts point somewhere (great>miss ▲ / miss>great ▽).
  // Every number derives from the scout usage read (ProspectStore.launches — real persisted telemetry).
  function recipeLifeChip(r) {
    try {
      if (typeof ProspectStore === 'undefined' || !ProspectStore.launches) return '';
      const u = (ProspectStore.launches() || {})[r.id];
      const n = (u && typeof u === 'object') ? u.n : u;
      if (!Number.isFinite(n) || n <= 0) return '';
      const rated = (u && typeof u === 'object' && u.rated && typeof u.rated === 'object') ? u.rated : null;
      const g = rated ? (Number(rated.great) || 0) : 0, m = rated ? (Number(rated.miss) || 0) : 0;
      const arrow = (g > m && g > 0) ? ' · rated ▲' : (m > g && m > 0) ? ' · rated ▽' : '';
      return '<span class="mkt-chip mkt-life" title="your own launches' + (arrow ? ' + your ratings' : '') + '">↻ ran ' + Math.floor(n) + '×' + esc(arrow) + '</span>';
    } catch (_) { return ''; }
  }
  function recipeCardHTML(r, i) {
    // the SAME settings-console row shape as the class list (the two tabs share one UI language):
    // [seal socket] [name + tagline] ……… [lane · setup / code stamp]
    const sel = (focusRecipe === r.id);
    const n = (r.params || []).length;
    const setup = n ? ('▤ ' + n + ' input' + (n === 1 ? '' : 's')) : '◷ no setup';
    return '<button class="mkt-card' + (sel ? ' sel' : '') + '" type="button" data-id="' + esc(r.id) + '" style="--accent:' + esc(r.accent) + ';--ci:' + (i || 0) + '">' +
      sealHTML(r, false) +
      '<div class="mkt-card-id">' +
        '<div class="mkt-name">' + esc(r.name) + (r.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
        '<div class="mkt-tag">' + esc(r.tagline) + '</div>' +
      '</div>' +
      '<div class="mkt-card-side">' +
        '<div class="mkt-meta"><span class="mkt-chip lane">' + esc(laneLabelOf(r)) + '</span>' +
          '<span class="mkt-chip">' + setup + '</span>' + recipeLifeChip(r) + '</div>' +
        '<span class="mkt-card-code">' + esc(codeOf(r)) + '</span>' +
      '</div>' +
    '</button>';
  }

  /* ---------- the dossier (right pane: focused class detail + the action) ---------- */
  function focusedItem() {
    if (tab === 'recipes' && hasRecipes()) return (focusRecipe && Recipes.get(focusRecipe)) || Recipes.builtins()[0];
    return (focusAgent && Specialties.get(focusAgent)) || Specialties.builtins()[0];
  }
  // the dossier re-themes to the focused class: set its --accent so coin / bars / CTA take on the class colour.
  function paintDossierAccent() {
    const d = root && root.querySelector('#mkt-dossier'); const it = focusedItem();
    if (d && it && it.accent) d.style.setProperty('--accent', it.accent);
  }
  // the DECODE beat: focusing a NEW class resolves its hero (emblem + name) out of glyph static — the
  // station's own AsciiFX register (eerie signal-lock, never confetti). Once per focused id, instant
  // under reduced-motion (the kit handles it), and null-safe when the kit isn't loaded.
  let lastDecodedHero = null;
  function decodeHero() {
    if (typeof AsciiFX === 'undefined' || !AsciiFX.scramble) return;
    const hero = root && root.querySelector('.mkt-dos-hero'); if (!hero) return;
    const it = focusedItem(); const id = (it && it.id) || null;
    if (!id || id === lastDecodedHero) return;
    lastDecodedHero = id;
    try { AsciiFX.scramble(hero, { duration: 460 }); } catch (_) {}
  }
  // narrow-viewport escape hatch: at <=820px the dossier is a full-width sheet OVER the roster, so it needs a
  // visible way back (the stranded-state fix). Hidden at wide widths by CSS (both panes show side by side).
  function dossierBackHTML() {
    return '<button type="button" class="mkt-dos-back" aria-label="back to the class roster">‹ ROSTER</button>';
  }
  function dossierHTML() {
    return dossierBackHTML() + ((tab === 'recipes' && hasRecipes()) ? recipeDossierHTML() : agentDossierHTML());
  }
  // the capability objectTypes the STATION currently has placed anywhere (station-wide shared gear). Under the
  // shared-gear model a specialist owns only its desk and draws on these caps UNDER THE OVERSEER — so a class's
  // gear is checked against the whole station, never a per-agent room. Reads World.stationCaps (the same live
  // source the run's skill availability uses); [] on any hiccup (renders every row as "not on station", honest).
  function stationGearSet() {
    try {
      const caps = (typeof World !== 'undefined' && World.stationCaps) ? World.stationCaps() : [];
      return new Set(caps.map(c => (typeof c === 'string' ? c : c && c.objectType)).filter(Boolean));
    } catch (_) { return new Set(); }
  }
  // DRAWS ON STATION GEAR — one row per objectType the class uses: the prop + what it grants, resolved from the
  // LIVE catalog (never a hardcoded prop label), PLUS an honest present/missing check against the ACTUAL station
  // props. Present gear reads as available; missing gear reads dim ("not on station — add in REFIT"). Capabilities
  // are STATION-level shared gear used under the overseer — the class is NOT issued its own copy (only its desk).
  // Empty kit => the block is omitted (a plain persona-only class).
  function kitBlockHTML(s) {
    const kit = (s && Array.isArray(s.kit)) ? s.kit : [];
    if (!kit.length) return '';
    const have = stationGearSet();
    let missing = 0;
    // A ●/○ status dot carries present/missing (green ● = on station, dim ○ = not yet); the repeated per-row
    // "NOT ON STATION — ADD IN REFIT…" sentence is gone — the single footnote below states it once (audit item 8).
    const rows = kit.map(t => {
      const present = have.has(t);
      if (!present) missing++;
      return '<div class="mkt-kit-row' + (present ? '' : ' mkt-kit-missing') + '">' +
        '<span class="mkt-kit-dot" aria-hidden="true">' + (present ? '●' : '○') + '</span>' +
        '<span class="mkt-kit-obj" data-hint="' + esc(t) + '">' + esc(kitPropLabel(t)) + '</span>' +
        '<span class="mkt-kit-grant">' + esc(capGrant(t)) + '</span></div>';
    }).join('');
    const note = missing
      ? 'shared station gear this class draws on under the overseer — ' + missing + ' not on station yet (add ' + (missing === 1 ? 'it' : 'them') + ' in REFIT for its full toolkit).'
      : 'shared station gear this class draws on under the overseer — all present on the station.';
    return '<div class="mkt-block"><div class="bh">DRAWS ON STATION GEAR</div>' +
      '<div class="mkt-kit">' + rows + '</div>' +
      '<div class="mkt-kit-note">' + note + '</div></div>';
  }
  // SKILL PACKAGE — one row per bundled skill slug: name + one-line description, resolved from the /api/skills
  // catalog the SKILLS window uses. Renders slug-only immediately (so it works offline), then hydrateSkillRows
  // fills real names/descriptions once the catalog resolves. Empty package => the block is omitted.
  function skillPackageHTML(s) {
    const skills = (s && Array.isArray(s.skills)) ? s.skills : [];
    if (!skills.length) return '';
    const cached = skillCatalog || {};
    const rows = skills.map(slug => {
      const meta = cached[slug];
      return '<div class="mkt-skill-row" data-slug="' + esc(slug) + '">' +
        '<span class="mkt-skill-name">' + esc(meta ? meta.name : slug) + '</span>' +
        '<span class="mkt-skill-desc">' + esc(meta ? meta.description : '') + '</span></div>';
    }).join('');
    return '<div class="mkt-block"><div class="bh">SKILL PACKAGE</div>' +
      '<div class="mkt-skills">' + rows + '</div>' +
      '<div class="mkt-kit-note">enabled for this agent on summon (adds to your global skills; still gated by its gear).</div></div>';
  }
  // async: fill real skill names/descriptions into a rendered dossier once the catalog loads. Re-queries the DOM
  // after the await so a dossier swapped mid-fetch is a safe no-op.
  function hydrateSkillRows() {
    loadSkillCatalog().then(map => {
      const d = root && root.querySelector('#mkt-dossier'); if (!d) return;
      d.querySelectorAll('.mkt-skill-row[data-slug]').forEach(row => {
        const meta = map[row.dataset.slug]; if (!meta) return;
        const n = row.querySelector('.mkt-skill-name'); if (n) n.textContent = meta.name;
        const de = row.querySelector('.mkt-skill-desc'); if (de) de.textContent = meta.description;
      });
    });
  }

  /* ---------- R3: live cron routines (the "● live as a routine" provenance) ---------- */
  // cron-job cache: fetched from /api/cron once per open of the recipes tab, then reused. Best-effort — a missing
  // sidecar just means no live-routine badges (the recipe still launches). The window.fetch shim attaches the token.
  let cronPending = null;
  function loadCronJobs(force) {
    if (cronJobs && !force) return Promise.resolve(cronJobs);
    if (cronPending) return cronPending;
    cronPending = fetch('/api/cron').then(r => r.ok ? r.json() : { jobs: [], enabled: false })
      .then(d => { cronJobs = Array.isArray(d && d.jobs) ? d.jobs : []; cronArmed = !!(d && d.enabled); cronPending = null; return cronJobs; })
      .catch(() => { cronJobs = cronJobs || []; cronPending = null; return cronJobs; });
    return cronPending;
  }
  // async: fetch cron jobs, then repaint the focused recipe's dossier so its live-routine badge appears. Re-queries
  // the DOM after the await (a dossier swapped mid-fetch is a safe no-op). Only repaints if the badge would change.
  function hydrateLiveRoutines() {
    const had = cronJobs != null;
    loadCronJobs().then(() => {
      if (!root || tab !== 'recipes') return;
      const d = root.querySelector('#mkt-dossier'); if (!d) return;
      // if this is the first load (badge wasn't rendered), or the badge state differs from what's shown, repaint.
      if (!had) renderDossier();
    });
  }

  function agentDossierHTML() {
    const s = (focusAgent && Specialties.get(focusAgent)) || Specialties.builtins()[0];
    if (!s) return '<div class="mkt-dos-empty">no class selected.</div>';
    const deploy = !ctx || ctx.mode !== 'pick';
    const here = !!(ctx && ctx.currentSpecialtyId && ctx.currentSpecialtyId === s.id);
    const t = s.tags || {};
    const bar = (k, label) => { const v = Math.round((t[k] || 0) * 100);
      return '<div class="mkt-barrow"><span class="bk">' + label + '</span><span class="trk"><span class="fill" style="width:' + v + '%"></span></span><span class="bv">' + v + '%</span></div>'; };
    // FOCUS LANES bars only earn their space when 2+ lanes are actually lit. A one-hot class (a single lane at 100%)
    // is already stated by the FOCUS chip above, so the three bars would just repeat it (audit item 8 declutter).
    const laneSpread = ['code', 'research', 'general'].filter(k => (t[k] || 0) > 0).length >= 2;
    const badges = (here ? ' <span class="mkt-badge mkt-here">DEPLOYED</span>' : '') + (s.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '');
    const ctaLabel = deploy ? ('⏼ DEPLOY TO ' + esc(((ctx && ctx.agentName) || 'AGENT')).toUpperCase()) : ('⏼ SUMMON ' + esc(summonCandidateName(s)));
    const ctaSub = deploy
      ? 're-specs ' + esc((ctx && ctx.agentName) || 'your agent') + '’s purpose &amp; standing orders'
      : 'opens its own <span data-hint="workstream">chat thread</span> — name, voice &amp; purpose pre-filled from this class';
    const custActs = s.custom
      ? '<div class="mkt-cta-row"><button class="bb sm mkt-edit" data-id="' + esc(s.id) + '">✎ EDIT</button>' +
        '<button class="bb sm danger mkt-del" data-id="' + esc(s.id) + '">⌫ DELETE</button></div>' : '';
    // CLEARANCE/EFFORT show the EFFECTIVE resolution (audit item 4): in summon mode a per-agent model/effort pinned
    // in SUMMON CONFIG OVERRIDES the class default; otherwise the class tier resolves to the station-default model.
    const pin = (ctx && ctx.mode === 'pick' && ctx.summon) ? pickedSummonModel : null;
    const modelNote = (pin && pin.model)
      ? 'model: ' + esc(shortModel(pin.model)) + ' — overrides class default'
      : 'model: station default';
    const effortEff = (pin && pin.effort) ? String(pin.effort).toUpperCase()
      : (s.reasoningEffort ? String(s.reasoningEffort).toUpperCase() : null);
    const effortNote = (pin && pin.effort) ? 'your pick — applied at summon'
      : (s.reasoningEffort ? 'class default — applied at summon' : 'station default');
    const clearRow =
      '<span class="k" data-hint="clearance">CLEARANCE</span><span class="v">' + pipsOf(s.model) + ' ' + esc(clearanceLabel(s.model)) +
        ' <span class="mkt-clr-note">' + modelNote + '</span></span>' +
      '<span class="k" data-hint="effort">EFFORT</span><span class="v">' +
        (effortEff ? '<span class="mkt-chip">' + esc(effortEff) + '</span> <span class="mkt-clr-note">' + effortNote + '</span>'
                   : '<span class="mkt-clr-note">station default</span>') + '</span>';
    return '<div class="mkt-dos-label">▮ CLASS DOSSIER</div>' +
      '<div class="mkt-dos-hero">' + sealHTML(s, true) +
        '<div class="mkt-dos-hi"><div class="mkt-dos-name">' + esc(s.name) + badges + '</div>' +
          '<div class="mkt-dos-tag">' + esc(s.tagline) + '</div>' +
          '<div class="mkt-dos-class">CLASS · ' + esc(codeOf(s)) + '</div></div></div>' +
      '<div class="mkt-spec">' +
        clearRow +
        '<span class="k" data-hint="voice">VOICE</span><span class="v">◈ ' + esc(voiceName(s.persona)) + '</span>' +
        '<span class="k" data-hint="focus">FOCUS</span><span class="v"><span class="mkt-chip lane">' + esc(laneLabelOf(s)) + '</span></span>' +
      '</div>' +
      (laneSpread ? '<div class="mkt-block"><div class="bh">FOCUS LANES</div><div class="mkt-bars">' + bar('code', 'CODE') + bar('research', 'RESEARCH') + bar('general', 'OPS') + '</div></div>' : '') +
      kitBlockHTML(s) +
      skillPackageHTML(s) +
      '<div class="mkt-block"><div class="bh">PURPOSE</div><p class="bp">' + esc(s.purpose) + '</p></div>' +
      (s.manual ? '<div class="mkt-block"><details class="mkt-orders"><summary class="bh">STANDING ORDERS</summary><pre>' + esc(s.manual) + '</pre></details></div>' : '') +
      (s.starters && s.starters.length ? '<div class="mkt-block"><div class="bh">TRY ASKING — things you can say to it</div><ul class="mkt-starters">' + s.starters.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : '') +
      '<div class="mkt-dos-cta">' + custActs +
        commitSummaryHTML(s) +
        // adopt-voice sits BESIDE the DEPLOY CTA it modifies (audit item 8), not orphaned up in the toolbar.
        (deploy ? '<label class="mkt-adopt mkt-adopt-cta"><input type="checkbox" class="mkt-adopt-cb"> adopt its voice too</label>' : '') +
        '<button class="mkt-cta-main mkt-deploy" data-id="' + esc(s.id) + '">' + ctaLabel + ' ▸</button>' +
        '<div class="mkt-cta-sub">' + ctaSub + '</div>' +
        // the merged recruit door's SECOND verb: in summon mode, a deploy context (onDeploy +
        // agentName) also offers re-speccing the CURRENT agent as this class — the old ROSTER
        // door's action, now living on the card instead of a separate dock button.
        (!deploy && ctx && ctx.onDeploy && ctx.agentName && !here
          ? '<button class="mkt-cta-alt mkt-deploy-cur" data-id="' + esc(s.id) + '">⏼ DEPLOY TO ' + esc(ctx.agentName).toUpperCase() + ' ▸</button>' +
            '<div class="mkt-cta-sub">no new crew member — re-specs ' + esc(ctx.agentName) + '’s purpose &amp; standing orders</div>'
          : '') +
      '</div>';
  }
  // SUMMON commit summary (audit item 4): a compact confirm row directly above the CTA restating exactly what this
  // summon will create — the SKIN it wears, the MODEL it runs on (pinned or inherited), and the CLASS. Summon-only.
  function commitSummaryHTML(s) {
    if (!(ctx && ctx.mode === 'pick' && ctx.summon) || typeof DATA === 'undefined' || !DATA.SKINS) return '';
    const skinId = (pickedSummonSkin && DATA.SKINS[pickedSummonSkin]) ? pickedSummonSkin : DATA.DEFAULT_SKIN;
    const sk = DATA.SKINS[skinId] || {};
    const modelTxt = (pickedSummonModel && pickedSummonModel.model) ? esc(shortModel(pickedSummonModel.model)) : 'orchestrator model';
    const effortTxt = (pickedSummonModel && pickedSummonModel.effort) ? esc(String(pickedSummonModel.effort).toUpperCase())
      : (s.reasoningEffort ? esc(String(s.reasoningEffort).toUpperCase()) : '');
    return '<div class="mkt-commit" aria-label="what this summon creates">' +
      '<span class="mkt-cs-cell"><span class="mkt-cs-k">NAME</span> <span class="mkt-candidate-name">' + esc(summonCandidateName(s)) + '</span></span>' +
      '<span class="mkt-cs-cell mkt-cs-appear"><img class="mkt-cs-skin" src="assets/sprites/' + esc(sk.set) + '/rot_south.png" alt="" draggable="false"><span>' + esc(sk.name || skinId) + '</span></span>' +
      '<span class="mkt-cs-cell"><span class="mkt-cs-k">MODEL</span> ' + modelTxt + (effortTxt ? ' · ' + effortTxt : '') + '</span>' +
      '<span class="mkt-cs-cell"><span class="mkt-cs-k">CLASS</span> ' + esc(codeOf(s)) + '</span>' +
    '</div>';
  }
  // GEAR the recipe draws on — one advisory row per objectType: prop label + what it grants + a present/WANT
  // check against the live station gear (skills-panel WANT pattern). Missing gear is a WANT badge, NEVER a lock.
  function recipeGearHTML(r) {
    const gear = (r && Array.isArray(r.gear)) ? r.gear : [];
    if (!gear.length) return '';
    const have = stationGearSet();
    const rows = gear.map(t => {
      const present = have.has(t);
      return '<div class="mkt-kit-row' + (present ? '' : ' mkt-kit-missing') + '">' +
        '<span class="mkt-kit-dot" aria-hidden="true">' + (present ? '●' : '○') + '</span>' +
        '<span class="mkt-kit-obj">' + esc(kitPropLabel(t)) + '</span>' +
        '<span class="mkt-kit-grant">' + esc(capGrant(t)) + '</span></div>';
    }).join('');
    return '<div class="mkt-block"><div class="bh">DRAWS ON GEAR</div><div class="mkt-kit">' + rows + '</div>' +
      '<div class="mkt-kit-note">advisory — this use case leans on the above; it still launches without it.</div></div>';
  }
  // SKILLS PAIRING (R6) — the bundled-skill references this use case pairs with, as chips. Renders slug-only
  // immediately (works offline), then hydrateSkillRows fills real names once the /api/skills catalog resolves.
  // Empty skills => the block is omitted. Advisory only — a recipe never enables a skill on its own.
  function recipeSkillsHTML(r) {
    const skills = (r && Array.isArray(r.skills)) ? r.skills : [];
    if (!skills.length) return '';
    const cached = skillCatalog || {};
    const chips = skills.map(slug => {
      const meta = cached[slug];
      return '<span class="mkt-skill-row" data-slug="' + esc(slug) + '"><span class="mkt-skill-name">' +
        esc(meta ? meta.name : slug) + '</span></span>';
    }).join('');
    return '<div class="mkt-block"><div class="bh">PAIRS WITH SKILLS</div><div class="mkt-skills mkt-pair">' + chips + '</div>' +
      '<div class="mkt-kit-note">skills that fit this use case — enable them in SKILLS to sharpen the run.</div></div>';
  }
  // R3 live-routine lookup: the ENABLED cron jobs whose meta.recipeId matches this recipe (from the last
  // /api/cron fetch). Returns { count, cadence } so the dossier can show "● live — every morning" (or "×N").
  function liveRoutinesFor(recipeId) {
    if (!Array.isArray(cronJobs) || !recipeId) return null;
    const mine = cronJobs.filter(j => j && j.enabled && j.meta && j.meta.recipeId === recipeId);
    if (!mine.length) return null;
    return { count: mine.length, display: mine[0].scheduleDisplay || '' };
  }
  function liveRoutineBadgeHTML(r) {
    const live = liveRoutinesFor(r.id);
    if (!live) return '';
    const sched = live.display ? esc(live.display) : 'on a schedule';
    const extra = live.count > 1 ? ' <span class="dim">×' + live.count + '</span>' : '';
    return '<div class="mkt-r-live"><span class="mkt-r-live-dot" aria-hidden="true">●</span> live as a routine — ' + sched + extra + '</div>';
  }
  function recipeDossierHTML() {
    const r = (focusRecipe && Recipes.get(focusRecipe)) || Recipes.builtins()[0];
    if (!r) return '<div class="mkt-dos-empty">no recipe selected.</div>';
    const who = (ctx && ctx.agentName) || 'your agent';
    const n = (r.params || []).length;
    const inputs = n ? '<div class="mkt-block"><div class="bh">INPUTS</div><ul class="mkt-starters">' +
      r.params.map(p => '<li>' + esc(p.label) + (p.required ? '' : ' <i>(optional)</i>') + '</li>').join('') + '</ul></div>' : '';
    // fork provenance: a forked custom names its parent (a live jump would be nice but the parent may be gone).
    const parent = (r.source === 'fork' && r.forkedFrom) ? Recipes.get(r.forkedFrom) : null;
    const forkLine = (r.source === 'fork')
      ? '<div class="mkt-r-fork">⑃ tweaked from <b>' + esc(parent ? parent.name : r.forkedFrom) + '</b></div>' : '';
    const cadHint = r.cadence
      ? '<div class="mkt-r-cadhint">◷ naturally recurring — suggests <b>' + esc(cadenceLabel(r.cadence)) + '</b></div>' : '';
    // TWEAK + EXPORT are on EVERY dossier (fork/export any recipe); EDIT/DELETE only on your own customs.
    const tweakBtn = '<button class="bb sm mkt-recipe-tweak" data-id="' + esc(r.id) + '">✎ TWEAK</button>';
    const exportBtn = '<button class="bb sm mkt-recipe-export" data-id="' + esc(r.id) + '" title="download this recipe as a portable JSON file">⇩ EXPORT</button>';
    const custActs = r.custom
      ? '<div class="mkt-cta-row">' + tweakBtn +
        '<button class="bb sm mkt-recipe-edit" data-id="' + esc(r.id) + '">✐ EDIT</button>' + exportBtn +
        '<button class="bb sm danger mkt-recipe-del" data-id="' + esc(r.id) + '">⌫ DELETE</button></div>'
      : '<div class="mkt-cta-row">' + tweakBtn + exportBtn + '</div>';
    return '<div class="mkt-dos-label">▮ RECIPE DOSSIER</div>' +
      '<div class="mkt-dos-hero">' + sealHTML(r, true) +
        '<div class="mkt-dos-hi"><div class="mkt-dos-name">' + esc(r.name) + (r.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
          '<div class="mkt-dos-tag">' + esc(r.tagline) + '</div>' +
          '<div class="mkt-meta"><span class="mkt-chip lane">' + esc(CAT_LABEL[railBucket(r)] || 'GENERAL') + '</span>' + recipeLifeChip(r) + '</div></div></div>' +
      liveRoutineBadgeHTML(r) + forkLine + cadHint +
      '<div class="mkt-block"><div class="bh">WHAT IT SENDS</div><pre>' + esc(r.task) + '</pre></div>' +
      inputs +
      recipeGearHTML(r) +
      recipeSkillsHTML(r) +
      '<div class="mkt-dos-cta">' + custActs +
        '<button class="mkt-cta-main mkt-launch" data-id="' + esc(r.id) + '">' + (n ? '▸ SET UP &amp; LAUNCH' : '▸ LAUNCH RECIPE') + '</button>' +
        '<div class="mkt-cta-sub">run it now · or put it on a schedule</div>' +
      '</div>';
  }

  /* ---------- glass box: "STATION FAMILIARITY" ---------- */
  function glassHTML() {
    if (ctx && ctx.mode === 'pick') return '';
    const ps = profileApi(); if (!ps) return '';
    const summ = ps.summary(); if (!summ) return '';
    const on = ps.enabled ? ps.enabled() : true;
    const pct = Math.round((summ.familiarity || 0) * 100);
    const meter = !on ? 'PAUSED' : (summ.calibrating ? 'CALIBRATING' : pct + '%');
    const dom = summ.dominant ? (TAG_LABEL[summ.dominant] || summ.dominant) : '—';
    const noteTxt = !on ? 'learning paused — nothing new is being folded in'
      : summ.dominant ? ('leaning ' + dom.toLowerCase() + ' · ' + summ.samples + ' signal' + (summ.samples === 1 ? '' : 's') + ' so far')
      : 'still getting to know you — set an agent to work and I’ll learn what you focus on';
    const head =
      '<button class="mkt-fam-head" aria-expanded="' + (glassOpen ? 'true' : 'false') + '">' +
        '<span class="mkt-fam-ico" aria-hidden="true">◉</span>' +
        '<span class="mkt-fam-ttl">STATION FAMILIARITY</span>' +
        '<span class="mkt-fam-meter ' + (on && !summ.calibrating ? 'known' : 'cal') + '">' + meter + '</span>' +
        '<span class="mkt-fam-note">' + esc(noteTxt) + '</span>' +
        '<span class="mkt-fam-caret" aria-hidden="true">' + (glassOpen ? '▾' : '▸') + '</span>' +
      '</button>';
    if (!glassOpen) return '<div class="mkt-fam' + (on ? '' : ' paused') + '">' + head + '</div>';
    const bars = FAM_TAGS.map(k => {
      const v = Math.round((summ.affinity[k] || 0) * 100);
      return '<div class="mkt-fam-bar"><span class="mkt-fam-k">' + TAG_LABEL[k] + '</span>' +
        '<span class="mkt-fam-trk"><span class="mkt-fam-fill" style="width:' + v + '%;"></span></span>' +
        '<span class="mkt-fam-v">' + v + '%</span></div>';
    }).join('');
    const consent = !acked()
      ? '<div class="mkt-fam-consent">STARNET learns what you work on to tailor these picks — <b>locally, on this machine, 0 bytes sent.</b> ' +
        'Pause or wipe it anytime, right here. <button class="bb sm mkt-fam-ack">GOT IT</button></div>' : '';
    const acts = '<div class="mkt-fam-acts">' +
        '<span class="mkt-fam-priv">◇ local-first · your profile never leaves this machine</span>' +
        '<button class="bb sm mkt-fam-pause">' + (on ? '❚❚ PAUSE LEARNING' : '▸ RESUME LEARNING') + '</button>' +
        '<button class="bb sm danger mkt-fam-forget">⌫ FORGET</button></div>';
    return '<div class="mkt-fam open' + (on ? '' : ' paused') + '">' + head +
      '<div class="mkt-fam-body">' + consent + '<div class="mkt-fam-bars">' + bars + '</div>' + acts + '</div></div>';
  }

  /* ---------- recommender shelves ---------- */
  function becauseText(s) {
    const ps = profileApi(); if (!ps || !ps.explain) return '';
    const t = ps.explain(s.tags || {});
    return t ? (BECAUSE[t] || '') : '';
  }
  /* ---------- specialist recommendations (deploy AND summon/pick) ----------
     Mirrors Recipes.rankRecipes: (profile affinity × 4) + (goal-keyword hits × 2), catalog-order tie-break.
     When BOTH signals are silent (cold start) we fall back to an HONEST lane spread — the first class of each
     distinct interest lane in catalog order — under a header that says so (never a fake "recommended"). This
     shelf now renders in the summon/pick flow too: recruiting a NEW agent is exactly when guidance matters. */
  // common words carry no topic signal — matching a goal on "the" or "with" is noise, and (now that the WHY chip
  // NAMES the hit) reads as a nonsense reason. Skipping them makes both the rank and the reason more honest.
  const GOAL_STOP = new Set(['the', 'and', 'for', 'you', 'your', 'with', 'that', 'this', 'from', 'are', 'was', 'has',
    'have', 'will', 'can', 'all', 'any', 'out', 'get', 'got', 'its', 'our', 'but', 'not', 'who', 'how', 'why', 'what',
    'when', 'into', 'over', 'more', 'most', 'some', 'than', 'then', 'them', 'they', 'use', 'using', 'need', 'want',
    'like', 'just', 'also', 'one', 'two', 'per', 'via']);
  // the ACTUAL goal keywords a class matched (the persisted GOALS belief text ∩ the class's searchable text). The
  // WHY chip names hits[0] so it says WHY truthfully ("matches your goal: X") instead of ×3 boilerplate.
  function specGoalHits(s, gt) {
    if (!s || !gt) return [];
    const words = String(gt).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !GOAL_STOP.has(w));
    if (!words.length) return [];
    const seen = {}; const hits = [];
    const hay = ((s.name || '') + ' ' + (s.tagline || '') + ' ' + Object.keys(s.tags || {}).join(' ')).toLowerCase();
    for (const w of words) { if (seen[w]) continue; seen[w] = true; if (hay.indexOf(w) >= 0) hits.push(w); }
    return hits;
  }
  function specGoalScore(s, gt) { return specGoalHits(s, gt).length; }
  function dominantLane(s) {
    let best = 'general', bv = -Infinity; const t = s.tags || {};
    for (const k in t) { const v = Number(t[k]); if (isFinite(v) && v > bv) { bv = v; best = k; } }
    return best;
  }
  function rankSpecs(items, excludeId) {
    const ps = profileApi();
    const learningOn = !!(ps && (!ps.enabled || ps.enabled()));
    const scoreFn = (learningOn && ps && ps.score) ? (t => ps.score(t)) : null;
    const gt = goalText();
    const pool = (items || []).filter(s => s && s.id !== excludeId);
    let anySignal = false;
    const scored = pool.map((s, idx) => {
      const aff = scoreFn ? (Number(scoreFn(s.tags || {})) || 0) : 0;
      const goalHits = specGoalHits(s, gt);
      const goal = goalHits.length;
      if (aff > 0 || goal > 0) anySignal = true;
      // the honest per-pick WHY: profile affinity beats goal match when both fire (it's the stronger signal). When
      // it's a goal match, NAME the matched keyword (from the persisted goals text) rather than ×3 boilerplate.
      const why = (aff > 0 ? becauseText(s) : '') || (goal > 0 ? ('matches your goal: “' + goalHits[0] + '”') : '');
      return { s, idx, v: aff * 4 + goal * 2, why };
    });
    if (anySignal) {
      return { personalized: true, items: scored.filter(x => x.v > 0).sort((a, b) => (b.v - a.v) || (a.idx - b.idx)).slice(0, 3) };
    }
    // honest cold-start fallback: one class per distinct interest lane (dominant tag), catalog order.
    const byLane = [], used = {}, rest = [];
    pool.forEach(s => { const l = dominantLane(s); if (!used[l]) { used[l] = true; byLane.push(s); } else rest.push(s); });
    return { personalized: false, items: byLane.concat(rest).slice(0, 3).map(s => {
      const lbl = TAG_LABEL[dominantLane(s)] || 'GENERAL OPS';
      return { s, why: 'covers the ' + lbl.toLowerCase() + ' lane' };
    }) };
  }
  function recShelfHTML() {
    if (typeof Specialties === 'undefined' || !Specialties.builtins().length) return '';
    // ADAPTIVE RECRUITMENT: when the station has a WARM read of the Commander's real workflow (the capability
    // histogram past its floor), the shelf becomes a CURATED next-hire pick — the class whose kit covers the work
    // the Commander actually does, with a why derived from a real persisted counter. The curated list already
    // excludes rostered classes and only surfaces classes the work TOUCHES, so it never fabricates a pick. When the
    // signal is cold/thin (or learning is off), fall through to today's honest rankSpecs shelf UNCHANGED.
    const curated = recruiterShelf();
    if (curated) return curated;
    const res = rankSpecs(Specialties.builtins(), ctx && ctx.currentSpecialtyId);
    if (!res.items.length) return '';
    const head = res.personalized
      ? '★ RECOMMENDED FOR YOU — based on your recent runs'
      : '◈ STARTING LINEUP — one per lane while the station learns what you work on · this shelf changes as you use agents';
    return '<div class="mkt-sect-h mkt-rec-sect">' + head + '</div><div class="mkt-rec-rail">' +
      res.items.map(x => recCardHTML(x.s, x.why)).join('') + '</div>';
  }
  // the CURATED-FOR-YOUR-WORKFLOW shelf: returns the shelf HTML when Recruiter has a warm read, else '' (so the
  // caller falls back to the honest lineup). Excludes the currently-focused class (deploy re-spec) like rankSpecs.
  function recruiterShelf() {
    if (typeof RecruiterStore === 'undefined' || !RecruiterStore.recommend) return '';
    let res; try { res = RecruiterStore.recommend(); } catch (_) { return ''; }
    if (!res || !res.warm || !res.items || !res.items.length) return '';
    const excludeId = ctx && ctx.currentSpecialtyId;
    const cards = res.items
      .map(it => ({ s: Specialties.get(it.classId), why: it.why }))
      .filter(x => x.s && x.s.id !== excludeId);
    if (!cards.length) return '';
    return '<div class="mkt-sect-h mkt-rec-sect mkt-curated-sect">◆ CURATED FOR YOUR WORKFLOW — based on your recent runs · the next hire your real work points to</div>' +
      '<div class="mkt-rec-rail">' + cards.map(x => recCardHTML(x.s, x.why)).join('') + '</div>';
  }
  /* ---------- PROSPECTS: bespoke DRAFTS the station authored from the Commander's real work (Slice 4) ----------
     Distinct from the curated shelf (which ranks EXISTING classes): a prospect is a brand-new spec the catalog
     doesn't contain, DRAFTED by the station and awaiting the Commander's confirm (never auto-saved/summoned).
     Honest labelling: "DRAFTED FOR YOU" + a provenance note. Clicking opens the EXISTING custom-class builder
     pre-filled with the draft (mirrors the R5 recipeMint seed path); dismiss denylists it. */
  function prospectShelfHTML() {
    if (typeof ProspectStore === 'undefined' || !ProspectStore.list) return '';
    let items = []; try { items = ProspectStore.list() || []; } catch (_) { return ''; }
    if (!items.length) return '';
    return '<div class="mkt-sect-h mkt-rec-sect mkt-prospect-sect">✦ DRAFTED FOR YOU — new roles the station authored from your work</div>' +
      '<div class="mkt-rec-rail">' + items.map(prospectCardHTML).join('') + '</div>';
  }
  function prospectCardHTML(p) {
    const d = (p && p.draft) || {};
    const emoji = d.emoji || '✦';
    return '<div class="mkt-rec mkt-prospect" data-prospect="' + esc(p.id) + '">' +
      '<div class="mkt-rec-top"><span class="mkt-prospect-glyph" aria-hidden="true">' + esc(emoji) + '</span>' +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(d.name || 'New specialist') + '</div>' +
          '<div class="mkt-rec-tag">' + esc(d.tagline || '') + '</div></div></div>' +
      (p.why ? '<div class="mkt-rec-why"><span class="mkt-rec-why-k">WHY</span> ' + esc(p.why) + '</div>' : '') +
      '<div class="mkt-prospect-prov">◇ drafted by the station from your work — review &amp; save to add it</div>' +
      '<div class="mkt-prospect-acts"><button class="bb sm mkt-prospect-open" data-prospect="' + esc(p.id) + '">▸ REVIEW &amp; SAVE</button>' +
        '<button class="bb sm mkt-prospect-dismiss" data-prospect="' + esc(p.id) + '" aria-label="dismiss this drafted role forever" title="dismiss forever — the station won\'t draft this role again">✕</button></div>' +
    '</div>';
  }
  /* ---------- R6: the "FOR YOU" row (ranked by dossier interest lanes + goal-text keyword match) ----------
     The plan's discovery-front recommender. Distinct from the profile-affinity "RECOMMENDED FOR YOU" shelf above:
     FOR YOU blends the SAME profile affinity with the Commander's GOALS belief text (keyword-matched into the rank),
     and ALWAYS renders (with an honest category-spread fallback when the profile is thin AND no goals are set) — so
     even a cold-start user gets a varied, non-arbitrary starting row. Never a fake "popular" ordering. Shown only in
     the un-filtered top-level view (no active category/search) so it doesn't fight the filtered grid below. */
  function goalText() {
    try {
      if (typeof DossierStore === 'undefined' || !DossierStore.beliefs) return '';
      return (DossierStore.beliefs('goals') || []).map(b => b && b.text).filter(Boolean).join(' ');
    } catch (_) { return ''; }
  }
  function forYouShelfHTML() {
    if (!hasRecipes()) return '';
    if (catFilter !== 'all' || query) return '';   // only in the clean top-level view
    const ps = profileApi();
    const learningOff = !!(ps && ps.enabled && !ps.enabled());
    // the affinity scorer only feeds the rank when learning is ON and the profile has signal; else rankRecipes
    // leans on goal text, then the honest category-spread fallback.
    const scoreFn = (ps && ps.score && !learningOff) ? (tags => ps.score(tags)) : null;
    // launches = the Commander's OWN real per-recipe launch counts (scout usage read) — engagement feeds the rank.
    let launches = null; try { launches = (typeof ProspectStore !== 'undefined' && ProspectStore.launches) ? ProspectStore.launches() : null; } catch (_) {}
    const items = Recipes.rankRecipes(Recipes.list(), { score: scoreFn, goalText: goalText(), launches: launches, limit: 4 });
    if (!items || !items.length) return '';
    return '<div class="mkt-sect-h mkt-foryou-sect">◈ FOR YOU</div><div class="mkt-rec-rail">' +
      items.map(forYouCardHTML).join('') + '</div>';
  }
  function forYouCardHTML(r) {
    const cat = CAT_LABEL[railBucket(r)] || 'GENERAL';
    return '<button class="mkt-rec mkt-foryou" type="button" data-id="' + esc(r.id) + '" style="--accent:' + esc(r.accent) + '">' +
      '<div class="mkt-rec-top">' + sealHTML(r, false) +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(r.name) + '</div><div class="mkt-rec-tag">' + esc(r.tagline) + '</div></div></div>' +
      '<div class="mkt-rec-why"><span class="mkt-rec-why-k">' + esc(cat) + '</span>' + (r.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div></button>';
  }
  function recCardHTML(s, why) {
    // `why` comes from rankSpecs: the profile-affinity reason, a goal-match note, or the cold-start lane label
    return '<button class="mkt-rec" type="button" data-id="' + esc(s.id) + '" style="--accent:' + esc(s.accent) + '">' +
      '<div class="mkt-rec-top">' + sealHTML(s, false) +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(s.name) + '</div><div class="mkt-rec-tag">' + esc(s.tagline) + '</div></div></div>' +
      (why ? '<div class="mkt-rec-why"><span class="mkt-rec-why-k">WHY</span> ' + esc(why) + '</div>' : '') + '</button>';
  }

  /* ---------- auto-mint: "SUGGESTED" ---------- */
  function suggestedMissions() {
    const mp = mintApi(); if (!mp) return [];
    const ps = profileApi();
    if (ps && ps.enabled && !ps.enabled()) return [];
    if (mp.enabled && !mp.enabled()) return [];
    return mp.candidates() || [];
  }
  function suggestedShelfHTML() {
    // two honest sources share this shelf: auto-mint candidates (exact task shapes the Commander keeps typing)
    // and SCOUT recipe drafts (server-authored from the learned interests, each carrying its evidence-grounded WHY).
    const cands = suggestedMissions();
    const drafts = scoutRecipeDrafts();
    if (!cands.length && !drafts.length) return scoutColdStateHTML();
    return '<div class="mkt-sect-h mkt-suggest-sect">✨ SUGGESTED — from what you keep asking</div><div class="mkt-rec-rail">' +
      cands.map(suggestCardHTML).join('') + drafts.map(scoutRecipeCardHTML).join('') + '</div>';
  }
  /* ---------- the SUGGESTED shelf's honest COLD STATE ----------
     An empty shelf used to render as NOTHING — indistinguishable from a broken scout. Truthful telemetry:
     when the server truth (GET /api/scout, cached in ProspectStore) is in hand, say WHERE the scout actually
     is. Every figure below comes from that payload (gate/warm/interests) — nothing invented. When the cache
     has never loaded (no server read yet) we still render '' — the frontend may not assert scout state it
     can't prove. Shown only in the clean top-level view (same discipline as the FOR-YOU shelf). */
  function scoutColdStateHTML() {
    if (catFilter !== 'all' || query) return '';
    if (typeof ProspectStore === 'undefined' || !ProspectStore.gate) return '';
    let gate = null, warm = false, nInterests = 0;
    try {
      gate = ProspectStore.gate();
      warm = !!(ProspectStore.warm && ProspectStore.warm());
      nInterests = (ProspectStore.interests && ProspectStore.interests() || []).length;
    } catch (_) { return ''; }
    if (!gate) return '';   // no /api/scout read yet — assert nothing rather than guess
    let line = '';
    if (gate.fire) {
      line = 'signal locked — the station attempts a new draft after your next run.';
    } else if (gate.binding === 'cold') {
      line = !warm && nInterests > 0
        ? 'CALIBRATING — ' + nInterests + ' early signal' + (nInterests === 1 ? '' : 's') + ' held, none strong enough to draft from yet. Keep working; the station is watching what you work on.'
        : 'CALIBRATING — watching what you work on. Run real tasks and the station learns what to suggest.';
    } else if (gate.binding === 'cooldown') {
      const n = Number(gate.runsSinceMint), N = Number(gate.mintEveryRuns);
      line = 'no draft staged yet — the next attempt earns itself with more runs' +
        (Number.isFinite(n) && Number.isFinite(N) && N > 0 ? ' (' + Math.min(n, N) + '/' + N + ')' : '') + '.';
    } else if (gate.binding === 'gap') {
      line = 'the station attempted a draft recently — cooling down before the next try.';
    } else {
      return '';   // 'full' (or an unknown binding) can't co-occur with an empty shelf — stay silent, stay honest
    }
    return '<div class="mkt-sect-h mkt-suggest-sect">✨ SUGGESTED — from what you keep asking</div>' +
      '<div class="mkt-empty mkt-scout-cold">' + esc(line) + '</div>';
  }
  function scoutRecipeDrafts() {
    try { return (typeof ProspectStore !== 'undefined' && ProspectStore.recipeDrafts) ? (ProspectStore.recipeDrafts() || []) : []; } catch (_) { return []; }
  }

  /* ---------- SCOUT LOG: the attempt ledger (truthful telemetry) ----------
     Every scout mint attempt writes ONE outcome to a server-side ledger (sidecar/scout.js note()) — staged
     (a draft landed), rejected, none (the model judged the library already covers it), expired (a stale draft
     aged out), accepted/dismissed (your own verdict), or error. GET /api/scout returns the tail; the bay reads
     it via ProspectStore.ledger(). Rendering it here makes the engine VISIBLE: a dismissed draft is no longer
     the whole story — the Commander can see what the station tried and the honest reason each time. Collapsed by
     default; EVERY line comes straight from the payload — nothing invented (no fabricated "trying…" filler). */
  const SCOUT_OUT = {
    staged:    { label: 'MINTED',    cls: 'ok' },
    accepted:  { label: 'SAVED',     cls: 'ok' },
    rejected:  { label: 'REJECTED',  cls: 'no' },
    dismissed: { label: 'DISMISSED', cls: 'no' },
    none:      { label: 'NONE',      cls: 'mut' },
    expired:   { label: 'EXPIRED',   cls: 'mut' },
    error:     { label: 'ERROR',     cls: 'err' }
  };
  // relative "Nx ago" for a past epoch-ms stamp (local, tiny — mirrors projects.js relTime). '' when absent.
  function scoutRelTime(ms) {
    const t = Number(ms) || 0; if (!t) return '';
    const d = Date.now() - t; if (d < 60000) return 'now';
    const m = Math.floor(d / 60000); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function scoutLogHTML() {
    if (typeof ProspectStore === 'undefined' || !ProspectStore.ledger) return '';
    let entries = [];
    try { entries = ProspectStore.ledger() || []; } catch (_) { return ''; }
    if (!entries.length) return '';   // no attempts recorded yet — assert nothing (never a fake/empty log)
    const rows = entries.slice().reverse();   // ledger is appended oldest→newest; show newest first
    const n = rows.length;
    const head =
      '<button type="button" class="mkt-scoutlog-head" aria-expanded="' + (scoutLogOpen ? 'true' : 'false') + '">' +
        '<span class="mkt-scoutlog-caret" aria-hidden="true">' + (scoutLogOpen ? '▾' : '▸') + '</span>' +
        '<span class="mkt-scoutlog-ttl">SCOUT LOG</span>' +
        '<span class="mkt-scoutlog-sum">' + n + ' attempt' + (n === 1 ? '' : 's') + ' the station recorded</span>' +
      '</button>';
    if (!scoutLogOpen) return '<div class="mkt-scoutlog">' + head + '</div>';
    return '<div class="mkt-scoutlog open">' + head +
      '<div class="mkt-scoutlog-body">' + rows.map(scoutLogRowHTML).join('') + '</div></div>';
  }
  function scoutLogRowHTML(e) {
    e = e || {};
    const meta = SCOUT_OUT[e.outcome] || { label: String(e.outcome || '·').toUpperCase().slice(0, 12), cls: 'mut' };
    const kind = String(e.kind || '');
    const kindLbl = kind === 'prospect' ? 'class' : kind === 'recipe' ? 'recipe' : kind;   // honest kind, never invented
    const when = scoutRelTime(e.at);
    const title = String(e.title || '');
    const reason = String(e.reason || '');
    return '<div class="mkt-slog-row">' +
      '<span class="mkt-slog-out ' + meta.cls + '">' + esc(meta.label) + '</span>' +
      '<div class="mkt-slog-main">' +
        '<div class="mkt-slog-line">' +
          (kindLbl ? '<span class="mkt-slog-kind">' + esc(kindLbl) + '</span>' : '') +
          (title ? '<span class="mkt-slog-ttl">' + esc(title) + '</span>' : '') +
          (when ? '<span class="mkt-slog-time">' + esc(when) + '</span>' : '') +
        '</div>' +
        (reason ? '<div class="mkt-slog-reason">' + esc(reason) + '</div>' : '') +
      '</div></div>';
  }
  // a station-drafted recipe card — same card family as the prospect shelf (glyph + WHY + provenance + arm-confirmed
  // dismiss), because it makes the same promise: drafted from YOUR observed work, never saved without your review.
  function scoutRecipeCardHTML(p) {
    const d = (p && p.draft) || {};
    return '<div class="mkt-rec mkt-prospect mkt-scout-recipe" data-scout="' + esc(p.id) + '">' +
      '<div class="mkt-rec-top"><span class="mkt-prospect-glyph" aria-hidden="true">' + esc(d.emoji || '✦') + '</span>' +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(d.name || 'New recipe') + '</div>' +
          '<div class="mkt-rec-tag">' + esc(d.tagline || '') + '</div></div></div>' +
      (p.why ? '<div class="mkt-rec-why"><span class="mkt-rec-why-k">WHY</span> ' + esc(p.why) + '</div>' : '') +
      '<div class="mkt-prospect-prov">◇ drafted by the station from your work — review &amp; save to add it</div>' +
      '<div class="mkt-prospect-acts"><button class="bb sm mkt-scout-recipe-open" data-scout="' + esc(p.id) + '">▸ REVIEW &amp; SAVE</button>' +
        '<button class="bb sm mkt-scout-recipe-dismiss" data-scout="' + esc(p.id) + '" aria-label="dismiss this drafted recipe forever" title="dismiss forever — the station won\'t draft this recipe again">✕</button></div>' +
    '</div>';
  }
  function suggestCardHTML(c) {
    return '<div class="mkt-rec mkt-suggest" data-key="' + esc(c.key) + '">' +
      '<div class="mkt-rec-top"><span class="mkt-suggest-spark" aria-hidden="true">✨</span>' +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(c.template) + '</div>' +
          '<div class="mkt-rec-tag">you’ve asked this ' + c.count + ' times</div></div></div>' +
      '<div class="mkt-suggest-acts"><button class="bb sm mkt-suggest-review" data-key="' + esc(c.key) + '">▸ REVIEW &amp; SAVE</button>' +
        '<button class="bb sm mkt-suggest-dismiss" data-key="' + esc(c.key) + '" aria-label="dismiss this suggestion" title="not a recipe">✕</button></div>' +
    '</div>';
  }

  /* ---------- wiring: roster ---------- */
  function focusFromCard(id) {
    if (!id) return;
    if (tab === 'recipes') focusRecipe = id; else focusAgent = id;
    sfx('click'); renderDossier();
    const dos = root.querySelector('#mkt-dossier'); if (dos) dos.scrollTop = 0;
    const mkt = root.querySelector('.mkt'); if (mkt) mkt.classList.add('show-dossier');
  }
  function wireRoster(stage) {
    stage.querySelectorAll('.mkt-card').forEach(b => b.addEventListener('click', () => focusFromCard(b.dataset.id)));
    stage.querySelectorAll('.mkt-rec[data-id]').forEach(b => b.addEventListener('click', () => focusFromCard(b.dataset.id)));

    const saveas = stage.querySelector('.mkt-saveas');
    if (saveas) saveas.addEventListener('click', () => { sfx('click'); view = 'save'; editingId = null; renderStage(); });
    const build = stage.querySelector('.mkt-build');
    // editingId cleared: ＋ is always a FRESH class, never a stale upsert (the edit view can be abandoned by closing the window)
    if (build) build.addEventListener('click', () => { sfx('click'); editingId = null; buildDraft = null; acceptingProspectId = null; buildAccent = '#ffaa33'; buildModel = 'balanced'; buildKit = []; buildSkills = []; buildEffort = null; view = 'build'; renderStage(); });
    const recipeSaveas = stage.querySelector('.mkt-recipe-saveas');
    if (recipeSaveas) recipeSaveas.addEventListener('click', () => { sfx('click'); pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null; enterRecipeEditor(null, 'create'); });

    // SUMMON name field: track keystrokes into pickedSummonName (survives the strip's collapse/expand re-renders).
    // No renderStage on input — a re-render would blow away the focused field mid-typing.
    const nameIn = stage.querySelector('#mkt-summon-name');
    if (nameIn) nameIn.addEventListener('input', () => {
      pickedSummonName = nameIn.value;
      renderDossier();
      const s = (focusAgent && Specialties.get(focusAgent)) || null;
      root.querySelectorAll('.mkt-candidate-name').forEach(e => { e.textContent = summonCandidateName(s); });
      const used = ((typeof AgentId !== 'undefined' && AgentId.normalizeName) ? AgentId.normalizeName(pickedSummonName) : String(pickedSummonName || '')).length;
      const max = (ctx && ctx.displayNameLimit) || (typeof AgentId !== 'undefined' && AgentId.NAME_MAX) || 18;
      const count = root.querySelector('.mkt-name-count'); if (count) { count.textContent = used + ' / ' + max; count.classList.toggle('over', used > max); }
      const issue = summonNameIssue(), dup = summonNameConflict();
      const help = root.querySelector('.mkt-name-help');
      if (help) {
        help.textContent = issue === 'too-long' ? 'too long — shorten this name before summoning'
          : dup ? 'duplicate name — summon requires a second confirmation; the agent id will remain unique'
          : 'blank uses the proposed default: ' + summonCandidateName(s);
        help.classList.toggle('warn', !!(issue || dup));
      }
      nameIn.setAttribute('aria-invalid', issue ? 'true' : 'false');
    });

    const skinWrap = stage.querySelector('#mkt-skin-picker');
    if (skinWrap) {
      skinWrap.querySelectorAll('.skin-thumb').forEach(b => {
        b.addEventListener('click', () => {
          pickedSummonSkin = b.dataset.skin;
          skinWrap.querySelectorAll('.skin-thumb').forEach(x => x.classList.remove('sel'));
          b.classList.add('sel'); sfx('click');
          if (typeof SkinStage !== 'undefined') SkinStage.show(pickedSummonSkin);
        });
        // hover scrubs the live stage so you can compare without committing; leaving snaps back to the pick
        b.addEventListener('mouseenter', () => { if (typeof SkinStage !== 'undefined') SkinStage.show(b.dataset.skin); });
      });
      skinWrap.addEventListener('mouseleave', () => { if (typeof SkinStage !== 'undefined') SkinStage.show(pickedSummonSkin); });
      // bind the live preview stage to the picked skin (the modal is the only stage visible while it's open)
      const stageImg = stage.querySelector('#mkt-skin-stage-img');
      const stageName = stage.querySelector('#mkt-skin-stage-name');
      if (stageImg && typeof SkinStage !== 'undefined') SkinStage.mount(stageImg, stageName, pickedSummonSkin);
    }

    // SUMMON model picker: fill the catalog async, then track the choice ('' model → inherit the orchestrator's).
    const modelWrap = stage.querySelector('#mkt-model-pick');
    if (modelWrap && typeof ModelPicker !== 'undefined') {
      ModelPicker.populate(modelWrap, { current: pickedSummonModel || {} }).catch(() => {});
      ModelPicker.onChange(modelWrap, (sel) => {
        // EFFORT is an independent axis (audit item 5): a chosen effort must survive even when the MODEL is left
        // to inherit the orchestrator's. summonAgent/applyLoadout honor pin.effort independently of pin.model, so
        // carry { model:'', effort } rather than dropping the whole pin the moment model is blank.
        if (sel && sel.model) pickedSummonModel = { model: sel.model, provider: sel.provider, effort: sel.effort || '' };
        else if (sel && sel.effort) pickedSummonModel = { model: '', provider: '', effort: sel.effort };
        else pickedSummonModel = null;
        sfx('click');
        renderDossier();   // repaint CLEARANCE/EFFORT + the commit-summary so they show the EFFECTIVE resolution
      });
    }

    // SUMMON CONFIG strip: toggle expands/collapses APPEARANCE + MODEL (re-renders so wireRoster re-mounts the
    // live skin stage + model picker on expand).
    const cfgHead = stage.querySelector('.mkt-cfg-head');
    if (cfgHead) cfgHead.addEventListener('click', () => { summonConfigOpen = !summonConfigOpen; sfx('click'); renderStage(); });

    // SPECIALIST ARCHIVE: the deep-cut pool expands/collapses (state survives re-renders within one open bay).
    const archHead = stage.querySelector('.mkt-archive-head');
    if (archHead) archHead.addEventListener('click', () => { archiveOpen = !archiveOpen; sfx('click'); renderStage(); });

    wireGridNav(stage);
    wireGlass(stage);
    wireSuggest(stage);
    wireProspect(stage);
  }
  // roving tabindex + arrow-key nav across the class/recipe grid (audit item 8): exactly one card is Tab-reachable
  // (the selected one, else the first); Left/Right walk in DOM order, Up/Down jump a row (columns derived live from
  // the auto-fill layout). Keeps the grid one Tab-stop instead of dozens, and makes it keyboard-drivable.
  function wireGridNav(scope) {
    const cards0 = Array.from(scope.querySelectorAll('.mkt-card'));
    if (!cards0.length) return;
    const fid = tab === 'recipes' ? focusRecipe : focusAgent;
    let activeIdx = cards0.findIndex(c => c.dataset.id === fid); if (activeIdx < 0) activeIdx = 0;
    cards0.forEach((c, i) => { c.tabIndex = (i === activeIdx ? 0 : -1); });
    scope.addEventListener('keydown', e => {
      const cur = document.activeElement;
      if (!cur || !cur.classList || !cur.classList.contains('mkt-card') || !scope.contains(cur)) return;
      if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      const list = Array.from(scope.querySelectorAll('.mkt-card'));
      const i = list.indexOf(cur); if (i < 0) return;
      // columns = how many cards share the first row's top offset (auto-fill layout, read live)
      let cols = 0; const top0 = list[0].offsetTop;
      for (const c of list) { if (c.offsetTop === top0) cols++; else break; }
      cols = Math.max(1, cols);
      let next = i;
      if (e.key === 'ArrowRight') next = i + 1;
      else if (e.key === 'ArrowLeft') next = i - 1;
      else if (e.key === 'ArrowDown') next = i + cols;
      else if (e.key === 'ArrowUp') next = i - cols;
      if (next < 0 || next >= list.length || next === i) { e.preventDefault(); return; }
      e.preventDefault();
      list.forEach(c => { c.tabIndex = -1; });
      list[next].tabIndex = 0; list[next].focus();
    });
  }

  /* ---------- wiring: prospects (station-drafted new classes) ----------
     REVIEW & SAVE seeds the EXISTING custom-class builder with the draft (kit/skills/text pre-filled) — the
     Commander reviews, edits, and confirms → a normal custom specialty is saved (summon path unchanged). Accepting
     removes the prospect from staging (accept, not denylist). Dismiss denylists the fingerprint + re-renders. */
  function wireProspect(scope) {
    const sc = scope || root;
    if (typeof ProspectStore === 'undefined') return;
    sc.querySelectorAll('.mkt-prospect-open').forEach(b => b.addEventListener('click', () => {
      const p = ProspectStore.get ? ProspectStore.get(b.dataset.prospect) : null;
      if (!p || !p.draft) { renderStage(); return; }
      sfx('click');
      prefillBuilderFromProspect(p);
    }));
    // dismiss permanently denylists the fingerprint (the station won't re-draft this role), so it takes a
    // two-step arm/confirm — the armed label admits the permanence. Reuse the shared ArmConfirm helper (the ONE
    // tested arm/confirm primitive, index.html loads it before this) rather than a fourth hand-rolled copy;
    // fall back to the bay's local armDelete only if ArmConfirm isn't loaded in this build, so it never regresses.
    sc.querySelectorAll('.mkt-prospect-dismiss').forEach(b => {
      const confirmDismiss = () => {
        sfx('close');
        if (ProspectStore.dismiss) ProspectStore.dismiss(b.dataset.prospect);
        renderStage();
      };
      if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
        ArmConfirm.wire(b, { armedLabel: 'DISMISS FOREVER?', restLabel: '✕', timeoutMs: 4000, onConfirm: confirmDismiss });
      } else {
        b.addEventListener('click', () => armDelete(b, '✕', confirmDismiss, 'DISMISS FOREVER?'));
      }
    });
  }
  // seed the custom-class builder state from a prospect draft, then open it (mirrors the R5 recipeMint pre-fill).
  // acceptingProspectId is held so a successful CREATE removes the prospect from staging (accept, not dismiss).
  function prefillBuilderFromProspect(p) {
    const d = p.draft || {};
    editingId = null;                                  // a brand-new custom, not an upsert of an existing class
    buildAccent = d.accent || '#ffaa33';
    buildModel = (d.model && ['reasoning', 'balanced', 'fast'].indexOf(d.model) >= 0) ? d.model : 'balanced';
    buildKit = Array.isArray(d.kit) ? d.kit.slice() : [];
    buildSkills = Array.isArray(d.skills) ? d.skills.slice() : [];
    buildEffort = d.reasoningEffort || null;
    buildDraft = { emoji: d.emoji || '✦', name: d.name || '', tagline: d.tagline || '', purpose: d.purpose || '', manual: d.manual || '' };
    acceptingProspectId = p.id;                        // consumed on a successful save
    view = 'build'; renderStage();
  }

  /* ---------- wiring: dossier (the action button + custom edit/delete) ---------- */
  function wireDossier(scope) {
    const sc = scope || root; if (!sc) return;
    const dosBack = sc.querySelector('.mkt-dos-back');
    if (dosBack) dosBack.addEventListener('click', () => closeDossierSheet());
    const deployBtn = sc.querySelector('.mkt-deploy');
    if (deployBtn) {
      if (ctx && ctx.mode === 'pick') {
        // SUMMON (pick mode) — additive, never destructive, so it fires on the first click (no arm). The P0 fix
        // (audit #6): hand back { activate:true } so summonAgent LANDS the Commander in the new agent's chat
        // thread (focus + Chat.load) instead of quietly toasting from behind the still-open bay. The desk-placement
        // chip lives in summonAgent's activate branch, so routing through it delivers that guidance too. Non-summon
        // pick (the wake screen) has no live agent to activate — it just hands the chosen spec back.
        deployBtn.addEventListener('click', () => {
          const s = Specialties.get(deployBtn.dataset.id); if (!s) return;
          const commit = () => {
            sfx('click');
            if (ctx.onPick) {
              if (ctx.summon) ctx.onPick(Object.assign({}, s, { skin: pickedSummonSkin || (typeof DATA !== 'undefined' && DATA.DEFAULT_SKIN), modelPin: pickedSummonModel || null, agentName: summonCandidateName(s) }), { activate: true });
              else ctx.onPick(s);
            }
            close();
          };
          if (ctx.summon && summonNameIssue()) {
            summonConfigOpen = true; sfx('bad'); note('name is too long — use 18 characters or fewer', 'bad'); renderStage();
            const input = root.querySelector('#mkt-summon-name'); if (input) input.focus();
            return;
          }
          if (ctx.summon && summonNameConflict()) return armDelete(deployBtn, deployBtn.textContent, commit, 'SUMMON DUPLICATE NAME?');
          commit();
        });
      } else {
        // DEPLOY TO <current> (deploy mode) — a RE-SPEC that rewrites the live agent's purpose + standing orders.
        // That's consequential, so it arms/confirms ("RE-SPEC <NAME>?") like every other irreversible bay action.
        armCta(deployBtn, 'RE-SPEC ' + String((ctx && ctx.agentName) || 'AGENT').toUpperCase() + '?', () => {
          const s = Specialties.get(deployBtn.dataset.id); if (!s) return;
          const cb = root && root.querySelector('.mkt-adopt-cb');
          const adoptVoice = !!(cb && cb.checked);
          sfx('close');
          if (ctx && ctx.onDeploy) ctx.onDeploy(s, { adoptVoice });
          note(s.name + ' deployed to ' + ((ctx && ctx.agentName) || 'your agent') + (adoptVoice ? ' (+ voice)' : ''), 'good');
          close();
        });
      }
    }
    // second verb on the merged recruit door: DEPLOY TO <current> from summon mode (no voice adoption checkbox in
    // this pane — deploy keeps the agent's voice; the dossier can retune it). Same re-spec, same arm/confirm.
    const deployCurBtn = sc.querySelector('.mkt-deploy-cur');
    if (deployCurBtn) armCta(deployCurBtn, 'RE-SPEC ' + String((ctx && ctx.agentName) || 'AGENT').toUpperCase() + '?', () => {
      const s = Specialties.get(deployCurBtn.dataset.id); if (!s) return;
      sfx('close');
      if (ctx && ctx.onDeploy) ctx.onDeploy(s, { adoptVoice: false });
      note(s.name + ' deployed to ' + ((ctx && ctx.agentName) || 'your agent'), 'good');
      close();
    });
    const launchBtn = sc.querySelector('.mkt-launch');
    if (launchBtn) launchBtn.addEventListener('click', () => {
      if (!hasRecipes()) return;
      const r = Recipes.get(launchBtn.dataset.id); if (!r) return;
      sfx('click');
      // always open the launch pane (even for a no-setup recipe) so BOTH verbs are offered — RUN NOW and MAKE
      // ROUTINE (R3). A param-less recipe simply shows no fill-in fields; the two action buttons still appear.
      launchId = r.id; launchMode = 'run'; launchCadence = null; view = 'launch';
      loadCronJobs();   // warm the armed-state note for the MAKE ROUTINE panel
      renderStage();
    });
    const edit = sc.querySelector('.mkt-edit');
    if (edit) edit.addEventListener('click', () => {
      editingId = edit.dataset.id; sfx('click');
      // A custom class is a full loadout — edit it in the same builder form (so kit/skills/effort are editable),
      // prefilling every picker from the saved spec. (Only customs carry an EDIT button; built-ins stay frozen.)
      const s = Specialties.get(editingId);
      buildAccent = (s && s.accent) || '#ffaa33';
      buildModel = (s && s.model) || 'balanced';
      buildKit = (s && Array.isArray(s.kit)) ? s.kit.slice() : [];
      buildSkills = (s && Array.isArray(s.skills)) ? s.skills.slice() : [];
      buildEffort = (s && s.reasoningEffort) || null;
      view = 'build'; renderStage();
    });
    const rEdit = sc.querySelector('.mkt-recipe-edit');
    if (rEdit) rEdit.addEventListener('click', () => {
      pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null; sfx('click');
      // EDIT an existing custom in place — seed the editor from the saved record so every picker prefills.
      const r = hasRecipes() ? Recipes.get(rEdit.dataset.id) : null;
      enterRecipeEditor(r || {}, 'edit', rEdit.dataset.id);
    });
    // TWEAK — on EVERY recipe dossier (builtin or custom): fork it into a new editable custom, prefilled.
    const rTweak = sc.querySelector('.mkt-recipe-tweak');
    if (rTweak) rTweak.addEventListener('click', () => {
      if (!hasRecipes()) return;
      pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null; sfx('click');
      const forkDraft = Recipes.forkFrom(rTweak.dataset.id);
      if (!forkDraft) { note('could not tweak that recipe', 'bad'); return; }
      enterRecipeEditor(forkDraft, 'fork');
    });
    // EXPORT — download the focused recipe as a portable JSON file (R6). On EVERY dossier (builtins are seeds too).
    const rExport = sc.querySelector('.mkt-recipe-export');
    if (rExport) rExport.addEventListener('click', () => {
      if (!hasRecipes()) return;
      const obj = Recipes.exportRecipe(rExport.dataset.id);
      if (!obj) { sfx('bad'); note('could not export that recipe', 'bad'); return; }
      sfx('click'); downloadRecipeFile(obj);
    });
    const del = sc.querySelector('.mkt-del');
    if (del) del.addEventListener('click', () => armDelete(del, '⌫ DELETE', () => {
      const s = Specialties.get(del.dataset.id);
      Specialties.removeCustom(del.dataset.id);
      if (focusAgent === del.dataset.id) focusAgent = (Specialties.builtins()[0] || {}).id || null;
      note('removed specialty: ' + ((s && s.name) || del.dataset.id), 'good'); renderStage();
    }));
    const rDel = sc.querySelector('.mkt-recipe-del');
    if (rDel) rDel.addEventListener('click', () => armDelete(rDel, '⌫ DELETE', () => {
      const r = hasRecipes() ? Recipes.get(rDel.dataset.id) : null;
      if (hasRecipes()) Recipes.removeCustom(rDel.dataset.id);
      if (focusRecipe === rDel.dataset.id) focusRecipe = ((hasRecipes() && Recipes.builtins()[0]) || {}).id || null;
      note('removed recipe: ' + ((r && r.name) || rDel.dataset.id), 'good'); renderStage();
    }));
  }
  // arm/confirm a CTA (re-spec) in place: prefer the ONE shared ArmConfirm primitive (label swap + .armed +
  // auto-disarm), fall back to the bay's local armDelete only where ArmConfirm isn't loaded. Distinct from
  // armDelete in that the resting label is whatever the button already shows (a full CTA caption), not a fixed one.
  function armCta(btn, armedLabel, onConfirm) {
    if (!btn) return;
    if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
      ArmConfirm.wire(btn, { armedLabel: armedLabel, timeoutMs: 4000, onConfirm: onConfirm });
    } else {
      const rest = btn.textContent;
      btn.addEventListener('click', () => armDelete(btn, rest, onConfirm, armedLabel));
    }
  }
  // two-step arm/confirm on a destructive button (the bay's idiom — never a native confirm)
  // armLabel is the text shown once armed (defaults to 'SURE?'); lets a destructive action admit permanence.
  function armDelete(b, label, run, armLabel) {
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1'; b.classList.add('armed'); b.textContent = armLabel || 'SURE?'; sfx('bad');
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = '0'; b.classList.remove('armed'); b.textContent = label; } }, 4000);
      return;
    }
    sfx('close'); run();
  }

  /* ---------- wiring: glass box ---------- */
  function wireGlass(scope) {
    const sc = scope || root;
    const famHead = sc.querySelector('.mkt-fam-head');
    if (famHead) famHead.addEventListener('click', () => { glassOpen = !glassOpen; sfx('click'); renderStage(); });
    const famAck = sc.querySelector('.mkt-fam-ack');
    if (famAck) famAck.addEventListener('click', e => { e.stopPropagation(); setAcked(); sfx('click'); renderStage(); });
    const famPause = sc.querySelector('.mkt-fam-pause');
    if (famPause) famPause.addEventListener('click', () => {
      const ps = profileApi(); if (!ps || !ps.setEnabled) return;
      const on = ps.enabled ? ps.enabled() : true;
      ps.setEnabled(!on);
      if (mintApi() && MintStore.setEnabled) MintStore.setEnabled(!on);
      sfx(on ? 'bad' : 'click');
      if (on) note('learning paused — nothing new will be folded in'); else note('learning resumed', 'good');
      renderStage();
    });
    const famForget = sc.querySelector('.mkt-fam-forget');
    if (famForget) famForget.addEventListener('click', () => armDelete(famForget, '⌫ FORGET', () => {
      const ps = profileApi(); if (ps && ps.forget) ps.forget();
      if (mintApi() && MintStore.forget) MintStore.forget();
      sfx('close'); note('profile wiped — the station forgot what it learned', 'good'); renderStage();
    }, 'SURE? WIPE'));
  }

  /* ---------- wiring: suggested (mint) ---------- */
  function wireSuggest(scope) {
    const sc = scope || root;
    // SCOUT LOG collapsible: toggle expands/collapses the attempt ledger (re-render, like the SUMMON CONFIG strip).
    const slogHead = sc.querySelector('.mkt-scoutlog-head');
    if (slogHead) slogHead.addEventListener('click', () => { scoutLogOpen = !scoutLogOpen; sfx('click'); renderStage(); });
    sc.querySelectorAll('.mkt-suggest-review').forEach(b => b.addEventListener('click', () => {
      const c = suggestedMissions().find(x => x.key === b.dataset.key);
      if (!c) { renderStage(); return; }
      pendingMintKey = c.key; pendingMintTemplate = c.template;
      sfx('click');
      // a mint review seeds the editor with the observed template (params derive from its {tokens} on save).
      enterRecipeEditor({ task: c.template }, 'create');
    }));
    sc.querySelectorAll('.mkt-suggest-dismiss').forEach(b => b.addEventListener('click', () => {
      if (mintApi()) MintStore.markDismissed(b.dataset.key);
      sfx('close'); renderStage();
    }));
    // SCOUT recipe drafts: REVIEW & SAVE opens the R2 editor fully pre-filled from the draft; the save is the
    // accept (consumed in wireRecipeSaveForm). Dismiss denylists server-side (never re-drafted) → arm/confirm.
    sc.querySelectorAll('.mkt-scout-recipe-open').forEach(b => b.addEventListener('click', () => {
      const p = (typeof ProspectStore !== 'undefined' && ProspectStore.get) ? ProspectStore.get(b.dataset.scout) : null;
      if (!p || !p.draft) { renderStage(); return; }
      sfx('click');
      pendingMintKey = null; pendingMintTemplate = null;
      pendingScoutRecipeId = p.id;
      scoutSeedDraft = p.draft;
      enterRecipeEditor({ task: p.draft.task, gear: p.draft.gear, category: p.draft.category, params: p.draft.params }, 'create');
    }));
    sc.querySelectorAll('.mkt-scout-recipe-dismiss').forEach(b => {
      const confirmDismiss = () => {
        sfx('close');
        if (typeof ProspectStore !== 'undefined' && ProspectStore.dismiss) ProspectStore.dismiss(b.dataset.scout);
        renderStage();
      };
      if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
        ArmConfirm.wire(b, { armedLabel: 'DISMISS FOREVER?', restLabel: '✕', timeoutMs: 4000, onConfirm: confirmDismiss });
      } else {
        b.addEventListener('click', () => armDelete(b, '✕', confirmDismiss, 'DISMISS FOREVER?'));
      }
    });
  }

  /* ---------- R6: export / import a recipe as a portable JSON file ----------
     EXPORT downloads the v2 recipe object (pretty-printed, format-marked) as a single file. IMPORT reads a picked
     file, JSON-parses it, and hands it to Recipes.importRecipe which validates the shape, strips unknown fields,
     and saves it as a fresh custom (never executes anything from the file). A malformed file → an honest inline
     note, no crash. This is the seed of the open-core marketplace unit — a clean portable format, no network. */
  function safeFilename(name) {
    const base = String(name || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return (base || 'recipe') + '.starnet-recipe.json';
  }
  function downloadRecipeFile(obj) {
    try {
      const json = JSON.stringify(obj, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = safeFilename(obj && obj.name); a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (_) {} }, 0);
      note('exported recipe: ' + ((obj && obj.name) || 'recipe') + ' — saved to your downloads', 'good');
    } catch (_) { sfx('bad'); note('could not export the recipe file', 'bad'); }
  }
  // IMPORT: the file-picker button (in the bar) fires a hidden <input type=file>; this reads + parses + imports it.
  function wireImport(scope) {
    const sc = scope || root; if (!sc) return;
    const btn = sc.querySelector('.mkt-import'), file = sc.querySelector('#mkt-import-file');
    if (!btn || !file) return;
    btn.addEventListener('click', () => { sfx('click'); file.value = ''; file.click(); });
    file.addEventListener('change', () => {
      const f = file.files && file.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        let parsed = null;
        try { parsed = JSON.parse(String(reader.result || '')); }
        catch (_) { sfx('bad'); note('that file isn’t valid JSON — nothing imported', 'bad'); return; }
        if (!hasRecipes()) return;
        const res = Recipes.importRecipe(parsed);
        if (!res.ok) { sfx('bad'); note('could not import: ' + (res.error || 'malformed recipe file'), 'bad'); return; }
        // land the Commander on their freshly imported recipe (MINE view, dossier focused on it).
        focusRecipe = res.recipe.id; catFilter = 'mine'; view = 'grid';
        sfx('click'); note('imported recipe: ' + res.recipe.name + ' — it’s in YOUR RECIPES', 'good');
        renderBar(); renderStage();
      };
      reader.onerror = () => { sfx('bad'); note('could not read that file', 'bad'); };
      reader.readAsText(f);
    });
  }

  /* ---------- IMPORT AGENT — the Hermes / OpenClaw migration flow ----------
     A one-click path for a Commander arriving from OpenClaw or hermes-agent: detect installs (or pick a folder),
     preview exactly what the scan found, then RECRUIT mints a StarNet agent with the persona/orders/memory
     pre-filled. Every field shown comes straight from /api/harness/scan — nothing is invented (truthful telemetry).
     Keys are NEVER read or transferred; the preview says so and the KEYS tab is where the Commander re-enters them.
     Backend routes (built in parallel this session): POST /api/harness/detect, POST /api/harness/scan. The folder
     fallback reuses the existing POST /api/projects/pickfolder. If a route is missing the flow degrades to an honest
     empty/error state — it never fakes a detection or a scan. */
  const up = s => String(s == null ? '' : s).toUpperCase();
  // Is this scan's provider a StarNet provider id we can actually pin to? ModelDock.labels.normProvider maps every
  // known alias to its canonical id and buckets anything unknown into 'openrouter' — so 'openrouter' only counts
  // when the raw string literally names it, otherwise an unknown provider would be silently mis-pinned. Returns the
  // canonical id or null (→ no pin; the station's default model runs instead). No ModelDock → null (honest: can't verify).
  function recognizeProvider(raw) {
    const r = String(raw || '').trim().toLowerCase();
    const norm0 = (typeof ModelDock !== 'undefined' && ModelDock.labels && ModelDock.labels.normProvider) ? ModelDock.labels.normProvider : null;
    if (!r || !norm0) return null;
    const norm = norm0(r);
    if (norm === 'openrouter' && !/^open[\s_-]?router$/.test(r)) return null;
    return norm;
  }
  // enter the flow: reset to the detect step and kick the machine scan.
  function enterHarnessImport() {
    view = 'harnessImport'; importStep = 'detect';
    importFound = null; importScan = null; importOrigin = null; importErr = ''; importScanning = false; importName = '';
    renderStage();
    runDetect();
  }
  function runDetect() {
    importDetecting = true;
    fetch('/api/harness/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => r.ok ? r.json() : { ok: false, found: [] })
      .then(d => { importDetecting = false; importFound = (d && d.ok && Array.isArray(d.found)) ? d.found : []; if (view === 'harnessImport' && importStep === 'detect') renderStage(); })
      .catch(() => { importDetecting = false; importFound = []; if (view === 'harnessImport' && importStep === 'detect') renderStage(); });
  }
  // scan a folder as each harness in `harnesses` (in order), stopping at the first ok:true. A detected row passes a
  // single known harness; PICK FOLDER passes ['openclaw','hermes'] (try both). On ok:true → preview step; on total
  // miss → the last honest reason inline.
  function scanHarness(rootPath, harnesses) {
    importScanning = true; importErr = ''; renderStage();
    let lastReason = '';
    const tryOne = i => {
      if (i >= harnesses.length) {
        importScanning = false;
        importErr = lastReason || 'no OpenClaw or Hermes agent found in that folder';
        if (view === 'harnessImport') renderStage();
        return;
      }
      fetch('/api/harness/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ harness: harnesses[i], root: rootPath }) })
        .then(r => r.ok ? r.json() : { ok: false, reason: 'scan failed (http ' + r.status + ')' })
        .then(res => {
          if (res && res.ok) {
            importScanning = false; importScan = res;
            importOrigin = { harness: res.harness || harnesses[i], root: rootPath };
            importName = String(res.name || '').trim();
            importStep = 'preview';
            if (view === 'harnessImport') renderStage();
          } else { lastReason = (res && res.reason) || 'no agent found'; tryOne(i + 1); }
        })
        .catch(() => { lastReason = 'scan request failed'; tryOne(i + 1); });
    };
    tryOne(0);
  }
  // the first non-heading, non-rule line of the persona, clamped — the honest one-line "what it's for". Neutral
  // default when the persona is empty/all-headings so the agent still lands with a real (if generic) purpose.
  function derivePurpose(persona, harnessLabel) {
    const lines = String(persona || '').split(/\r?\n/);
    for (const raw of lines) {
      const t = raw.trim();
      if (!t || /^#+\s*$/.test(t) || /^[-*=_]{2,}$/.test(t)) continue;
      let p = t.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').trim();
      if (!p) continue;
      if (p.length > 140) p = p.slice(0, 139).replace(/\s+\S*$/, '') + '…';
      return p;
    }
    return 'Imported from ' + up(harnessLabel) + ' — tell it what you need.';
  }
  // context.md body: the harness USER.md + the curated memory, each under a labeled header so the agent knows the
  // provenance. Only present sources are included (truthful telemetry). Scan pre-clamps every string server-side;
  // a defensive overall cap keeps a pathological payload from bloating the composed prompt.
  function buildContextDoc(s, harnessLabel) {
    const H = up(harnessLabel);
    const parts = [];
    const uc = String((s && s.userContext) || '').trim();
    const mem = String((s && s.memory && s.memory.curated) || '').trim();
    if (uc) parts.push('## From ' + H + ' USER.md\n' + uc);
    if (mem) parts.push('## Curated memory — from ' + H + '\n' + mem);
    let doc = parts.join('\n\n');
    if (doc.length > 8000) doc = doc.slice(0, 8000);
    return doc;
  }
  function harnessImportHTML() {
    return importStep === 'preview' ? harnessPreviewHTML() : harnessDetectHTML();
  }
  function harnessDetectHTML() {
    let rows;
    if (importDetecting || importFound == null) {
      rows = '<p class="mkt-hint">◌ scanning this machine for OpenClaw / Hermes installs…</p>';
    } else if ((importFound || []).length) {
      rows = importFound.map((f, i) => {
        // the backend label already reads "OpenClaw — main" / "Hermes — profile X"; fall back to the bare harness id.
        const label = up(f.label || f.harness);
        return '<button type="button" class="mkt-imp-row" data-idx="' + i + '">' +
          '<span class="mkt-imp-row-h">' + esc(label) + '</span>' +
          '<span class="mkt-imp-row-path">' + esc(f.root || '') + '</span></button>';
      }).join('');
    } else {
      rows = '<div class="mkt-empty">no Hermes or OpenClaw install detected on this machine — pick a folder to import from instead.</div>';
    }
    const pick = '<button type="button" class="mkt-imp-row mkt-imp-pick">' +
      '<span class="mkt-imp-row-h">▸ PICK FOLDER…</span>' +
      '<span class="mkt-imp-row-path">choose an OpenClaw / Hermes agent folder</span></button>';
    const scanning = importScanning ? '<p class="mkt-hint">◌ reading the agent…</p>' : '';
    const err = importErr ? '<div class="mkt-r-warn">⚠ ' + esc(importErr) + '</div>' : '';
    return '<div class="mkt-save mkt-imp">' +
      '<div class="mkt-save-h">⇪ IMPORT AGENT</div>' +
      '<p class="mkt-hint">bring an agent over from OpenClaw or Hermes — its persona, standing orders and memory come with it. keys never transfer.</p>' +
      '<div class="mkt-imp-rows">' + rows + pick + '</div>' +
      scanning + err +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button></div>' +
    '</div>';
  }
  function harnessPreviewHTML() {
    const s = importScan || {};
    const H = up(s.harness || (importOrigin && importOrigin.harness) || 'harness');
    const rootPath = (importOrigin && importOrigin.root) || '';
    const persona = String(s.persona || '').trim();
    const excerpt = persona
      ? esc(persona.slice(0, 400)) + (persona.length > 400 ? '…' : '')
      : '<span class="mkt-imp-dim">no persona text found</span>';
    const mem = s.memory || {};
    const memChars = String(mem.curated || '').length;
    const dailyCount = +mem.dailyCount || 0;
    const dash = '<span class="mkt-imp-dim">—</span>';
    const t = (k, v) => '<div class="mkt-imp-t"><span class="mkt-imp-t-k">' + k + '</span><span class="mkt-imp-t-v">' + v + '</span></div>';
    let transfers =
      t('INSTRUCTIONS', String(s.instructions || '').trim() ? 'present' : dash) +
      t('USER CONTEXT', String(s.userContext || '').trim() ? 'present' : dash) +
      t('MEMORY', (memChars || dailyCount) ? (memChars + ' chars curated · ' + dailyCount + ' daily') : '<span class="mkt-imp-dim">none</span>');
    // MODEL: a recognized StarNet provider becomes the agent's pin; anything else shows the raw string with an
    // honest note that the station default runs instead (no pin is set).
    const m = s.model || {};
    const rec = recognizeProvider(m.provider);
    if (rec) {
      const lbl = (typeof ModelDock !== 'undefined' && ModelDock.labels && ModelDock.labels.provider) ? ModelDock.labels.provider(rec) : up(rec);
      transfers += t('MODEL', esc(lbl) + ' · ' + esc(String(m.model || m.raw || '')));
    } else {
      transfers += t('MODEL', esc(String(m.raw || 'unknown')) + ' <span class="mkt-imp-dim">— unrecognized here; station default model will be used</span>');
    }
    // warnings: render every entry the scan returned verbatim, and ALWAYS state the keys-never-transfer truth
    // (added only if the scan didn't already say it).
    const warns = Array.isArray(s.warnings) ? s.warnings.slice() : [];
    if (!warns.some(w => /key/i.test(w) && /transfer/i.test(w))) warns.push('keys never transfer — re-enter them in the KEYS tab');
    const warnHTML = warns.map(w => '<div class="mkt-r-warn dim">⚠ ' + esc(w) + '</div>').join('');
    return '<div class="mkt-save mkt-imp mkt-imp-preview">' +
      '<div class="mkt-save-h">⇪ IMPORT — ' + esc(s.name || H) + '</div>' +
      '<label class="mkt-lbl">NAME<input class="mkt-in" id="mkt-imp-name" type="text" autocomplete="off" spellcheck="false" value="' + esc(importName || s.name || '') + '"></label>' +
      '<div class="mkt-imp-origin">' + esc(H) + ' · <span class="mkt-imp-row-path">' + esc(rootPath) + '</span></div>' +
      '<div class="mkt-imp-sect">PERSONA</div><div class="mkt-imp-persona">' + excerpt + '</div>' +
      '<div class="mkt-imp-sect">WHAT TRANSFERS</div><div class="mkt-imp-transfers">' + transfers + '</div>' +
      warnHTML +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-imp-recruit">▸ RECRUIT</button></div>' +
    '</div>';
  }
  function wireHarnessImport(stage) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => {
      sfx('click');
      // preview BACK steps to detect (never discards the whole flow); detect BACK returns to the roster.
      if (importStep === 'preview') { importStep = 'detect'; importScan = null; importOrigin = null; importErr = ''; renderStage(); }
      else { view = 'grid'; renderStage(); }
    });
    stage.querySelectorAll('.mkt-imp-row[data-idx]').forEach(b => b.addEventListener('click', () => {
      const f = (importFound || [])[+b.dataset.idx]; if (!f) return;
      sfx('click'); scanHarness(f.root, [f.harness]);
    }));
    const pick = stage.querySelector('.mkt-imp-pick');
    if (pick) pick.addEventListener('click', () => {
      sfx('click'); importErr = ''; importScanning = true; renderStage();
      fetch('/api/projects/pickfolder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(r => r.ok ? r.json() : { ok: false })
        .then(d => {
          if (d && d.ok && d.path) scanHarness(d.path, ['openclaw', 'hermes']);
          else { importScanning = false; if (view === 'harnessImport') renderStage(); }   // cancelled → quietly stay on detect
        })
        .catch(() => { importScanning = false; importErr = 'could not open the folder picker'; if (view === 'harnessImport') renderStage(); });
    });
    const recruit = stage.querySelector('.mkt-imp-recruit');
    if (recruit) recruit.addEventListener('click', confirmImport);
  }
  // RECRUIT: mint the agent through the real summon seam (ctx.onPick === App.summonAgent), then write its docs
  // through the canonical dossier editor seam (App.applyConfig, exactly what the CONFIG card's Save uses —
  // recompose + persist + pushRoster). Construction-time fields (name/skin/model pin) ride the summon spec because
  // summonAgent bakes them in at creation; the markdown docs go through applyConfig on the freshly-focused new
  // agent (summon with activate:true focuses it), so we reuse the one docs write-path instead of inventing another.
  // The persona is APPENDED under a labeled header beneath the station's own baseIdentity — replacing identity
  // wholesale would strip the locked real-tools/honesty grounding, so we preserve it and add the imported voice.
  function confirmImport() {
    if (!importScan || !(ctx && ctx.onPick)) { close(); return; }
    const s = importScan;
    const harnessLabel = s.harness || (importOrigin && importOrigin.harness) || 'harness';
    const nameIn = root && root.querySelector('#mkt-imp-name');
    const editedName = (nameIn && nameIn.value) || importName || s.name || '';
    const m = s.model || {};
    const rec = recognizeProvider(m.provider);
    let modelId = String(m.model || m.raw || '').trim();
    // direct providers take a BARE model id (anthropic.js passes req.model straight to the API) — only
    // openrouter keeps the 'vendor/model' slug shape. Strip a prefix that just restates the pinned provider.
    if (rec && rec !== 'openrouter' && modelId.toLowerCase().indexOf(rec + '/') === 0) modelId = modelId.slice(rec.length + 1);
    const modelPin = (rec && modelId) ? { model: modelId, provider: rec, effort: '' } : null;
    const spec = {
      name: s.name || harnessLabel,
      agentName: editedName,
      skin: (typeof DATA !== 'undefined' && DATA.DEFAULT_SKIN) || undefined,
      modelPin: modelPin
    };
    sfx('click');
    const created = ctx.onPick(spec, { activate: true });
    try {
      const cur = (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null;
      if (created && cur && cur.id === created.id && typeof App !== 'undefined' && App.applyConfig) {
        const baseId = (created.docs && created.docs.identity) || '';
        const persona = String(s.persona || '').trim();
        const identity = persona ? (baseId + '\n\n## IMPORTED PERSONA — from ' + up(harnessLabel) + '\n' + persona) : baseId;
        App.applyConfig({
          identity: identity,
          manual: String(s.instructions || '').trim(),
          context: buildContextDoc(s, harnessLabel),
          purpose: derivePurpose(s.persona, harnessLabel)
        });
      }
    } catch (_) {}
    close();
  }

  /* ---------- launch a recipe ---------- */
  function launchRecipeNow(r, values) {
    const ok = !ctx || !ctx.onLaunch || ctx.onLaunch(r, values) !== false;
    if (ok) { note('recipe launched: ' + r.name + ' — ' + ((ctx && ctx.agentName) || 'your agent') + ' is on it', 'good'); close(); }
    else { sfx('bad'); note('could not launch ' + r.name + ' — the agent is mid-run (or there was nothing to send). try again when it settles.', 'bad'); }
  }
  // the schedule string a launchCadence id maps to, plus a 'custom' free-text entry the user types (every Nh or
  // a 5-field cron). The sidecar re-validates via cron.parseSchedule, so a bad custom string is caught server-side.
  function scheduleForLaunchCadence(customStr) {
    if (launchCadence === 'custom') return String(customStr || '').trim();
    const c = cadenceOpt(launchCadence); return c ? c.schedule : '';
  }
  function launchCadenceOptionsHTML() {
    let html = CADENCE_OPTS.map(c => '<option value="' + esc(c.id) + '"' + (launchCadence === c.id ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('');
    html += '<option value="custom"' + (launchCadence === 'custom' ? ' selected' : '') + '>custom…</option>';
    return html;
  }
  function launchFormHTML() {
    const r = launchId && hasRecipes() ? Recipes.get(launchId) : null;
    if (!r) { view = 'grid'; return '<div class="mkt-roster">' + rosterHTML() + '</div>'; }
    const who = (ctx && ctx.agentName) || 'your agent';
    // lane C: prefill each field with the value this recipe launched with LAST time (LaunchMemory, own local key).
    // Confirm-by-sight safety: the values sit visibly in the form and nothing runs until the button — plus the
    // hint below names the mechanism. esc() covers the content (U.esc escapes & < > " ', so </textarea> can't break out).
    const lastVals = (typeof LaunchMemory !== 'undefined' && LaunchMemory.get) ? (LaunchMemory.get(r.id) || {}) : {};
    let prefilled = false;
    const fields = (r.params || []).map(p => {
      const val = (typeof lastVals[p.key] === 'string' && lastVals[p.key].trim()) ? lastVals[p.key] : '';
      if (val) prefilled = true;
      return '<label class="mkt-lbl">' + esc(p.label) +
        (p.required ? ' <span class="mkt-req" title="required">*</span>' : ' <span class="mkt-opt">(optional)</span>') +
        '<textarea class="mkt-in mkt-p-in" data-key="' + esc(p.key) + '" rows="2" placeholder="' + esc(p.placeholder || '') + '">' + esc(val) + '</textarea></label>';
    }).join('');
    const prefillHint = prefilled ? '<p class="mkt-hint mkt-prefill-hint">↺ using your last inputs — edit anything before you run</p>' : '';
    // TASK BRIEF v2 intake: the recipe's declared material decisions as one-tap chip rows. The recommended
    // option starts selected (★, gold); "agent decides" opts out — the run then resolves or asks per the
    // task-context doctrine. Answers ride the composed directive (Recipes.fillTask values.__intake).
    const intakeRows = (r.intake || []).map(e =>
      '<div class="mkt-intake" data-dim="' + esc(e.dimension) + '"><div class="mkt-lbl">' + esc(e.question) +
        (e.reason ? ' <span class="mkt-lbl-hint">— ' + esc(e.reason) + '</span>' : '') + '</div>' +
        '<div class="mkt-intake-opts">' +
          e.options.map(o => '<button type="button" class="mkt-intake-opt' + (o === e.recommended ? ' sel rec' : '') + '" data-val="' + esc(o) + '">' + (o === e.recommended ? '★ ' : '') + esc(o) + '</button>').join('') +
          '<button type="button" class="mkt-intake-opt mkt-intake-skip" data-val="">agent decides</button>' +
        '</div></div>'
    ).join('');
    // MAKE ROUTINE panel — revealed when launchMode==='routine'. Cadence defaults to the recipe's suggested one.
    const outbound = hasRecipes() && Recipes.impliesOutbound(r);
    const warnLine = outbound
      ? '<div class="mkt-r-warn">⚠ this routine runs UNATTENDED. its directive looks like it may SEND or WRITE something — while you’re away it can only reason &amp; draft, so it will leave the result on the desk, not actually send. (a heads-up, not a block.)</div>'
      : '';
    const armNote = (cronJobs != null && !cronArmed)
      ? '<div class="mkt-r-warn dim">◷ scheduling is currently OFF — your routine is saved but dormant until you enable the scheduler in ROUTINES.</div>' : '';
    const routinePanel = (launchMode === 'routine')
      ? '<div class="mkt-r-routine">' +
          '<label class="mkt-lbl">CADENCE<select class="mkt-in" id="mkt-l-cad">' + launchCadenceOptionsHTML() + '</select></label>' +
          '<label class="mkt-lbl mkt-l-custom" id="mkt-l-custom-wrap"' + (launchCadence === 'custom' ? '' : ' hidden') + '>CUSTOM SCHEDULE ' +
            '<span class="mkt-lbl-hint">— “every 6h”, “in 2h”, or a 5-field cron “0 9 * * 1”</span>' +
            '<input class="mkt-in" id="mkt-l-custom" placeholder="every 6h"></label>' +
          '<div class="mkt-r-pv" id="mkt-l-pv"></div>' +
          warnLine + armNote +
        '</div>' : '';
    // the action row switches on the mode: RUN NOW + MAKE ROUTINE side by side; in routine mode a CONFIRM button.
    const acts = (launchMode === 'routine')
      ? '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
          '<button class="bb sm mkt-launch-run-alt">▸ RUN NOW INSTEAD</button>' +
          '<button class="bb sm mkt-do-routine">◷ SCHEDULE IT</button></div>'
      : '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
          '<button class="bb sm mkt-do-launch">▸ RUN NOW</button>' +
          '<button class="bb sm mkt-do-makeroutine" title="puts this recipe on a schedule — it becomes a ROUTINE you can manage in ⏱ ROUTINES">◷ MAKE ROUTINE</button></div>';
    const modeNote = (launchMode === 'routine')
      ? '◷ fills the blanks ONCE, then runs the same directive on your chosen cadence as <b>' + esc(who) + '</b> — it becomes a ROUTINE (manage or stop it any time in ⏱ ROUTINES).'
      : '▸ opens a fresh workstream and sets <b>' + esc(who) + '</b> to work on it — or put it on a schedule.';
    return '<div class="mkt-save mkt-launch-form">' +
      '<div class="mkt-save-h">' + esc((launchMode === 'routine' ? '◷ MAKE ROUTINE — ' : '▸ LAUNCH — ') + r.name) + '</div>' +
      '<p class="mkt-hint">' + esc(r.blurb || r.tagline) + '</p>' +
      (fields || '<p class="mkt-hint">this recipe needs no setup — just launch it.</p>') +
      intakeRows +
      prefillHint +
      routinePanel +
      '<p class="mkt-launch-note">' + modeNote + '</p>' +
      acts + '</div>';
  }
  // gather + validate the param values from the launch form; returns { values } or null (with UI feedback) if a
  // required field is blank. Shared by RUN NOW and MAKE ROUTINE (both fill the same params, once).
  function collectLaunchValues(stage, r) {
    const values = {};
    stage.querySelectorAll('.mkt-p-in').forEach(inp => { values[inp.dataset.key] = inp.value; });
    // TASK BRIEF v2: fold the tapped intake decisions in (dimension -> answer). "agent decides" contributes
    // nothing — an unanswered material decision is the run's to resolve, never a fabricated choice.
    const intake = {};
    stage.querySelectorAll('.mkt-intake').forEach(rowEl => {
      const sel = rowEl.querySelector('.mkt-intake-opt.sel');
      const val = sel ? String(sel.dataset.val || '').trim() : '';
      if (val && rowEl.dataset.dim) intake[rowEl.dataset.dim] = val;
    });
    if (Object.keys(intake).length) values.__intake = intake;
    const missing = Recipes.requiredMissing(r, values);
    if (missing.length) {
      sfx('bad');
      missing.forEach(k => { const f = stage.querySelector('.mkt-p-in[data-key="' + k + '"]'); if (f) f.classList.add('mkt-bad'); });
      const f0 = stage.querySelector('.mkt-p-in[data-key="' + missing[0] + '"]'); if (f0) f0.focus();
      note('fill in: ' + missing.join(', '), 'bad'); return null;
    }
    return values;
  }
  function wireLaunchForm(stage) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); view = 'grid'; launchId = null; launchMode = 'run'; renderStage(); });
    stage.querySelectorAll('.mkt-p-in').forEach(inp => inp.addEventListener('input', () => inp.classList.remove('mkt-bad')));
    // TASK BRIEF v2 intake chips: single-select per decision row (tap toggles which chip holds .sel).
    stage.querySelectorAll('.mkt-intake').forEach(rowEl => {
      rowEl.querySelectorAll('.mkt-intake-opt').forEach(btn => btn.addEventListener('click', () => {
        rowEl.querySelectorAll('.mkt-intake-opt').forEach(b => b.classList.remove('sel'));
        btn.classList.add('sel'); sfx('click');
      }));
    });

    // RUN NOW (from run mode) — the existing path, unchanged.
    const go = stage.querySelector('.mkt-do-launch');
    if (go) go.addEventListener('click', () => {
      const r = launchId && hasRecipes() ? Recipes.get(launchId) : null;
      if (!r) { view = 'grid'; launchId = null; renderStage(); return; }
      const values = collectLaunchValues(stage, r); if (!values) return;
      try { if (typeof LaunchMemory !== 'undefined' && LaunchMemory.save) LaunchMemory.save(r.id, values); } catch (_) {}   // lane C: remember what launched
      launchId = null; launchMode = 'run'; launchRecipeNow(r, values);
    });
    // MAKE ROUTINE — reveal the cadence panel (default to the recipe's suggested cadence, else morning).
    const mkRoutine = stage.querySelector('.mkt-do-makeroutine');
    if (mkRoutine) mkRoutine.addEventListener('click', () => {
      const r = launchId && hasRecipes() ? Recipes.get(launchId) : null; if (!r) return;
      // validate the params up front so scheduling can't proceed with a blank required fill-in.
      if (!collectLaunchValues(stage, r)) return;
      launchMode = 'routine';
      launchCadence = (r.cadence && cadenceOpt(r.cadence)) ? r.cadence : 'morning';
      loadCronJobs().then(() => { if (view === 'launch') renderStage(); });   // refresh armed-state note
      sfx('click'); renderStage();
    });
    // RUN NOW INSTEAD (from routine mode) — flip back and run.
    const runAlt = stage.querySelector('.mkt-launch-run-alt');
    if (runAlt) runAlt.addEventListener('click', () => {
      const r = launchId && hasRecipes() ? Recipes.get(launchId) : null; if (!r) return;
      const values = collectLaunchValues(stage, r); if (!values) return;
      try { if (typeof LaunchMemory !== 'undefined' && LaunchMemory.save) LaunchMemory.save(r.id, values); } catch (_) {}   // lane C: remember what launched
      launchId = null; launchMode = 'run'; launchRecipeNow(r, values);
    });

    // cadence picker + custom-schedule reveal + a live preview of the next fires (via /api/cron/preview).
    const cadSel = stage.querySelector('#mkt-l-cad');
    const customWrap = stage.querySelector('#mkt-l-custom-wrap'), customIn = stage.querySelector('#mkt-l-custom'), pv = stage.querySelector('#mkt-l-pv');
    let pvTimer = null;
    const paintSchedPreview = () => {
      if (!pv) return;
      const sched = scheduleForLaunchCadence(customIn && customIn.value);
      if (!sched) { pv.textContent = ''; return; }
      clearTimeout(pvTimer);
      pvTimer = setTimeout(() => {
        fetch('/api/cron/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: sched }) })
          .then(r => r.ok ? r.json() : null).then(d => {
            if (!pv) return;
            if (d && d.ok) pv.textContent = '✓ ' + (d.display || sched);
            else pv.innerHTML = '<span class="mkt-r-warn-inline">' + esc((d && d.error) || 'unrecognized schedule') + '</span>';
          }).catch(() => {});
      }, 250);
    };
    if (cadSel) cadSel.addEventListener('change', () => {
      launchCadence = cadSel.value || 'morning';
      if (customWrap) customWrap.hidden = (launchCadence !== 'custom');
      sfx('click'); paintSchedPreview();
    });
    if (customIn) customIn.addEventListener('input', paintSchedPreview);
    if (launchMode === 'routine') paintSchedPreview();

    // SCHEDULE IT — fill the params ONCE, convert cadence → schedule, POST /api/cron with meta.recipeId.
    const doRoutine = stage.querySelector('.mkt-do-routine');
    if (doRoutine) doRoutine.addEventListener('click', () => {
      const r = launchId && hasRecipes() ? Recipes.get(launchId) : null; if (!r) return;
      const values = collectLaunchValues(stage, r); if (!values) return;
      try { if (typeof LaunchMemory !== 'undefined' && LaunchMemory.save) LaunchMemory.save(r.id, values); } catch (_) {}   // lane C: remember what scheduled
      const schedule = scheduleForLaunchCadence(customIn && customIn.value);
      if (!schedule) { sfx('bad'); note('pick a cadence (or type a custom schedule)', 'bad'); if (customIn) customIn.focus(); return; }
      makeRoutine(r, values, schedule);
    });

    const first = stage.querySelector('.mkt-p-in'); if (first) first.focus();
  }
  // POST /api/cron for MAKE ROUTINE. The filled directive is the routine's prompt (params filled ONCE, now); the
  // meta.recipeId stamps provenance so the ROUTINES console + the recipe dossier can both show the link. The agentId
  // targets the current run's agent (ctx.agentId) if the host handed one, else the default 'agent'.
  function makeRoutine(r, values, schedule) {
    const prompt = Recipes.fillTask(r, values);
    if (!prompt) { sfx('bad'); note('nothing to schedule — the directive is empty', 'bad'); return; }
    const agentId = (ctx && ctx.agentId) || 'agent';
    const body = {
      name: r.name, prompt, schedule, agentId,
      enabled: true, deliver: 'local', repeat: { times: null },
      meta: { recipeId: r.id }
    };
    const btn = root && root.querySelector('.mkt-do-routine'); if (btn) { btn.disabled = true; btn.textContent = '… scheduling'; }
    fetch('/api/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(res => res.json().catch(() => ({})).then(d => ({ ok: res.ok, d })))
      .then(({ ok, d }) => {
        if (!ok || (d && d.error)) { sfx('bad'); note((d && d.error) || 'could not schedule the routine', 'bad'); if (btn) { btn.disabled = false; btn.textContent = '◷ SCHEDULE IT'; } return; }
        cronJobs = null;   // invalidate the cache so the dossier's live-routine badge refreshes
        sfx('click');
        note('routine scheduled: ' + r.name + ' — ' + cadenceLabel(launchCadence === 'custom' ? null : launchCadence).replace('one-shot', 'on your schedule') + '. find it in ROUTINES.', 'good');
        launchId = null; launchMode = 'run'; close();
      })
      .catch(() => { sfx('bad'); note('could not reach the scheduler', 'bad'); if (btn) { btn.disabled = false; btn.textContent = '◷ SCHEDULE IT'; } });
  }

  /* ---------- the unified recipe editor (R2) ----------
     ONE editor component, three entry points: a blank CREATE (＋ SAVE A RECIPE), a mint REVIEW (from a SUGGESTED
     card), and a TWEAK/fork or EDIT (from a dossier). Every path seeds the shared editor state via enterRecipeEditor
     so the form opens fully populated — name/emoji/params/task/gear/cadence/category. Save mints a custom recipe;
     a fork carries source:'fork' + forkedFrom. Builtins are never mutated (a TWEAK forks; only a custom EDITs in place). */

  // seed the editor's working state from a recipe (or a plain draft), then switch to the editor view. `mode`:
  //   'create' — blank/new custom;  'edit' — upsert an existing custom (editingRecipeId set);
  //   'fork'   — a NEW custom pre-filled from `seed` (a Recipes.forkFrom draft; editingRecipeId stays null).
  // `seed` is the recipe/draft to prefill from (null for a truly blank create).
  function enterRecipeEditor(seed, mode, editId) {
    seed = seed || {};
    editingRecipeId = (mode === 'edit') ? (editId || null) : null;
    editForkedFrom = (mode === 'fork') ? (seed.forkedFrom || null) : (seed.forkedFrom || null);
    editGear = Array.isArray(seed.gear) ? seed.gear.slice() : [];
    editCadence = seed.cadence || null;
    // map any legacy/raw category onto a rail bucket so the CATEGORY <select> (developer/research/creator/ops/
    // general) always has a matching option selected; unknown → general.
    editCategory = (seed.category && CAT_TO_RAIL[seed.category]) || 'general';
    // R5 bottled-run provenance: a mintFromRun proposal carries sourceRunId; carry it through save. Every other
    // entry (blank create / tweak / import) has none → null. An EDIT preserves whatever the saved record had.
    editSourceRunId = (seed.sourceRunId != null) ? String(seed.sourceRunId) : null;
    // params: plain, editable copies ({key,label,placeholder,required}). A blank create starts with none — the
    // author writes {tokens} and the param rows are derived on save (paramsFromTemplate) if they leave them empty.
    editParams = (Array.isArray(seed.params) ? seed.params : []).map(p => ({
      key: p.key || '', label: p.label || '', placeholder: p.placeholder || '', required: p.required !== false
    }));
    view = 'recipesave'; renderStage();
  }

  function recipeTokenHint(task) {
    if (!hasRecipes()) return '';
    const ps = Recipes.paramsFromTemplate(task);
    if (!ps.length) return '<span class="mkt-r-tok-none">◷ one-tap recipe — no fill-ins</span>';
    return '<span class="mkt-r-tok-lbl">asks for</span> ' + ps.map(p => '<span class="mkt-r-tok">' + esc(p.label) + '</span>').join(' ');
  }
  function gearPickHTML() {
    return RECIPE_GEAR_PICK.map(t => {
      const on = editGear.indexOf(t) >= 0;
      return '<button type="button" class="mkt-chip pick' + (on ? ' sel' : '') + '" data-gear="' + esc(t) + '" ' +
        'title="' + esc(capGrant(t)) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(kitPropLabel(t)) + '</button>';
    }).join('');
  }
  function catSelectHTML() {
    return RECIPE_CATEGORIES.map(c => '<option value="' + esc(c) + '"' + (editCategory === c ? ' selected' : '') + '>' + esc(CAT_LABEL[c] || c) + '</option>').join('');
  }
  function cadSelectHTML() {
    let html = '<option value=""' + (!editCadence ? ' selected' : '') + '>one-shot — no suggested cadence</option>';
    html += CADENCE_OPTS.map(c => '<option value="' + esc(c.id) + '"' + (editCadence === c.id ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('');
    return html;
  }
  // one editable param row: key + label + placeholder + required toggle + remove. Keys are the {tokens} in the
  // directive; the live preview keys off them. An empty grid means "derive from the template on save".
  function paramRowHTML(p, i) {
    return '<div class="mkt-r-prow" data-i="' + i + '">' +
      '<input class="mkt-in mkt-r-pkey" data-i="' + i + '" maxlength="24" value="' + esc(p.key || '') + '" placeholder="key (e.g. topic)" aria-label="param key">' +
      '<input class="mkt-in mkt-r-plabel" data-i="' + i + '" maxlength="32" value="' + esc(p.label || '') + '" placeholder="label (optional)" aria-label="param label">' +
      '<input class="mkt-in mkt-r-pph" data-i="' + i + '" maxlength="48" value="' + esc(p.placeholder || '') + '" placeholder="hint (optional)" aria-label="param placeholder">' +
      '<label class="mkt-r-preq" title="required at launch"><input type="checkbox" class="mkt-r-preq-cb" data-i="' + i + '"' + (p.required ? ' checked' : '') + '> req</label>' +
      '<button type="button" class="bb xs danger mkt-r-prm" data-i="' + i + '" aria-label="remove param">✕</button>' +
      '</div>';
  }
  function paramsGridHTML() {
    const rows = editParams.map(paramRowHTML).join('');
    return '<div class="mkt-r-params" id="mkt-r-params">' + rows + '</div>' +
      '<button type="button" class="bb xs mkt-r-padd">＋ ADD FILL-IN</button>' +
      '<span class="mkt-hint mkt-r-phint"> — or leave empty and STARNET derives them from the {tokens} in your directive.</span>';
  }
  function recipeSaveFormHTML() {
    const editing = editingRecipeId && hasRecipes() ? Recipes.get(editingRecipeId) : null;
    const minting = !editing && !!pendingMintTemplate;
    const scouting = !editing && !minting && !!scoutSeedDraft;   // a SCOUT draft: the whole form pre-fills from it
    const forking = !editing && !!editForkedFrom;
    const parent = forking && hasRecipes() ? Recipes.get(editForkedFrom) : null;
    const d = editing || (scouting ? scoutSeedDraft : null) || { emoji: '✦', name: '', tagline: '', task: '' };
    const title = editing ? 'EDIT RECIPE' : forking ? 'TWEAK RECIPE' : minting ? 'SAVE THIS AS A RECIPE' : scouting ? 'REVIEW THE STATION’S DRAFT' : 'SAVE A RECIPE';
    const intro = forking
      ? 'a copy of <b>' + esc((parent && parent.name) || 'the recipe') + '</b> — yours to change. adjust the wording, the fill-ins, the gear or cadence, then save it as your own. the original stays put.'
      : minting
      ? 'you’ve done this a few times — saving it makes it a one-tap recipe you own. Tweak the wording, wrap any blanks in <b>{braces}</b>, then save.'
      : scouting
      ? 'the station drafted this from your observed work — review it, change anything, and save to make it yours. Nothing is added without this save.'
      : 'write the directive your agent should run. Wrap each blank in <b>{braces}</b> — “Brief me on <b>{topic}</b>” — and it becomes a fill-in at launch.';
    // when the form is (re)rendered we read the CURRENT working state (editGear/editCadence/... survive across
    // re-renders); name/emoji/tagline/task come from the DOM on save, but seed from `d` here on first paint.
    // For a fork/mint the seed came through enterRecipeEditor; for edit, from `d`. We keep the name/task in the
    // inputs (not editParams) — editParams is only the fill-in grid.
    const seedName = forking && parent ? ((parent.name || 'Recipe') + ' (my version)') : (d.name || '');
    const seedEmoji = (forking && parent ? parent.emoji : d.emoji) || '✦';
    const seedTag = forking && parent ? (parent.tagline || '') : (d.tagline || '');
    const seedTask = editing ? (d.task || '')
      : forking && parent ? (parent.task || '')
      : minting ? pendingMintTemplate : (d.task || '');
    return '<div class="mkt-save mkt-recipe-form">' +
      '<div class="mkt-save-h">' + esc(title) + '</div>' +
      '<p class="mkt-hint">' + intro + '</p>' +
      '<div class="mkt-save-row"><label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-r-emoji" maxlength="2" value="' + esc(seedEmoji) + '"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-r-name" maxlength="40" value="' + esc(seedName) + '" placeholder="e.g. Morning Standup"></label></div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-r-tag" maxlength="48" value="' + esc(seedTag) + '" placeholder="one line — what it’s for"></label>' +
      '<label class="mkt-lbl">DIRECTIVE TEMPLATE<textarea class="mkt-in mkt-r-task" id="mkt-r-task" rows="4" placeholder="e.g. Summarize {project} progress since {since} and flag blockers.">' + esc(seedTask || '') + '</textarea></label>' +
      '<div class="mkt-r-tokens" id="mkt-r-tokens"></div>' +
      '<label class="mkt-lbl">FILL-INS <span class="mkt-lbl-hint">— the blanks filled at launch</span></label>' +
      paramsGridHTML() +
      '<label class="mkt-lbl">LIVE PREVIEW <span class="mkt-lbl-hint">— what your agent receives</span></label>' +
      '<pre class="mkt-r-preview" id="mkt-r-preview"></pre>' +
      '<label class="mkt-lbl">GEAR IT DRAWS ON <span class="mkt-lbl-hint">— advisory; a WANT badge if the station lacks it, never a lock</span></label>' +
      '<div class="mkt-chips" id="mkt-r-gear">' + gearPickHTML() + '</div>' +
      '<div class="mkt-save-row">' +
        '<label class="mkt-lbl mkt-grow">CATEGORY<select class="mkt-in" id="mkt-r-cat">' + catSelectHTML() + '</select></label>' +
        '<label class="mkt-lbl mkt-grow">SUGGESTED CADENCE<select class="mkt-in" id="mkt-r-cad">' + cadSelectHTML() + '</select></label>' +
      '</div>' +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-do-recipe-save">' + (editing ? '✓ SAVE CHANGES' : forking ? '✓ SAVE MY VERSION' : '✓ SAVE RECIPE') + '</button></div></div>';
  }
  function wireRecipeSaveForm(stage) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); view = 'grid'; editingRecipeId = null; editForkedFrom = null; editSourceRunId = null; pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null; renderStage(); });
    const taskIn = stage.querySelector('#mkt-r-task'), tokens = stage.querySelector('#mkt-r-tokens'), preview = stage.querySelector('#mkt-r-preview');
    // read the fill-in grid back into editParams (keys/labels/placeholder/required) from the live inputs.
    const syncParamsFromDOM = () => {
      stage.querySelectorAll('.mkt-r-prow').forEach(row => {
        const i = +row.dataset.i; if (!editParams[i]) return;
        const k = row.querySelector('.mkt-r-pkey'), l = row.querySelector('.mkt-r-plabel'), ph = row.querySelector('.mkt-r-pph'), rq = row.querySelector('.mkt-r-preq-cb');
        if (k) editParams[i].key = (k.value || '').trim();
        if (l) editParams[i].label = (l.value || '').trim();
        if (ph) editParams[i].placeholder = (ph.value || '').trim();
        if (rq) editParams[i].required = !!rq.checked;
      });
    };
    // build the effective recipe for previewing: explicit fill-in rows if any have a key, else derive from tokens.
    const effectiveParams = (task) => {
      const explicit = editParams.filter(p => p.key);
      if (explicit.length) return explicit.map(p => ({ key: p.key, label: p.label || p.key, placeholder: p.placeholder, required: p.required }));
      return Recipes.paramsFromTemplate(task);
    };
    const paintPreview = () => {
      if (!preview || !taskIn) return;
      const task = taskIn.value || '';
      // preview through the REAL fillTask primitive against a throwaway recipe shape (never persisted).
      const draft = Recipes.draft({ task: task, params: effectiveParams(task) });
      const vals = {};
      (draft.params || []).forEach(p => { if (p.required) vals[p.key] = '[' + (p.label || p.key) + ']'; });
      const filled = Recipes.fillTask(draft, vals);
      preview.textContent = filled || '(write a directive above)';
    };
    const paintTokens = () => { if (tokens && taskIn) tokens.innerHTML = recipeTokenHint(taskIn.value); };
    const repaint = () => { paintTokens(); paintPreview(); };
    if (taskIn) taskIn.addEventListener('input', repaint);

    // param grid: add / remove rows, and re-read on any edit so the preview tracks.
    const grid = stage.querySelector('#mkt-r-params');
    const rerenderGrid = () => {
      if (!grid) return;
      grid.innerHTML = editParams.map(paramRowHTML).join('');
      wireGridRows();
      repaint();
    };
    const wireGridRows = () => {
      if (!grid) return;
      grid.querySelectorAll('.mkt-r-prm').forEach(b => b.addEventListener('click', () => {
        syncParamsFromDOM(); editParams.splice(+b.dataset.i, 1); sfx('click'); rerenderGrid();
      }));
      grid.querySelectorAll('.mkt-r-pkey, .mkt-r-plabel, .mkt-r-pph').forEach(inp => inp.addEventListener('input', () => { syncParamsFromDOM(); paintPreview(); }));
      grid.querySelectorAll('.mkt-r-preq-cb').forEach(cb => cb.addEventListener('change', () => { syncParamsFromDOM(); paintPreview(); }));
    };
    wireGridRows();
    const padd = stage.querySelector('.mkt-r-padd');
    if (padd) padd.addEventListener('click', () => { syncParamsFromDOM(); editParams.push({ key: '', label: '', placeholder: '', required: true }); sfx('click'); rerenderGrid(); });

    // gear chips (toggle in/out of editGear).
    stage.querySelectorAll('#mkt-r-gear .mkt-chip.pick').forEach(b => b.addEventListener('click', () => {
      const t = b.dataset.gear, i = editGear.indexOf(t);
      if (i >= 0) editGear.splice(i, 1); else editGear.push(t);
      const on = editGear.indexOf(t) >= 0;
      b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); sfx('click');
    }));
    const catSel = stage.querySelector('#mkt-r-cat');
    if (catSel) catSel.addEventListener('change', () => { editCategory = catSel.value || 'general'; });
    const cadSel = stage.querySelector('#mkt-r-cad');
    if (cadSel) cadSel.addEventListener('change', () => { editCadence = cadSel.value || null; });

    repaint();

    const save = stage.querySelector('.mkt-do-recipe-save');
    if (save) save.addEventListener('click', () => {
      const editing = editingRecipeId && hasRecipes() ? Recipes.get(editingRecipeId) : null;
      const name = (stage.querySelector('#mkt-r-name').value || '').trim();
      const task = (stage.querySelector('#mkt-r-task').value || '').trim();
      if (!name) { sfx('bad'); note('give your recipe a name', 'bad'); stage.querySelector('#mkt-r-name').focus(); return; }
      if (!task) { sfx('bad'); note('write the directive your agent should run', 'bad'); stage.querySelector('#mkt-r-task').focus(); return; }
      syncParamsFromDOM();
      const explicit = editParams.filter(p => p.key).map(p => ({ key: p.key, label: p.label || p.key, placeholder: p.placeholder, required: p.required }));
      const rec = {
        name, emoji: (stage.querySelector('#mkt-r-emoji').value || '✦').trim() || '✦',
        tagline: (stage.querySelector('#mkt-r-tag').value || '').trim(), task,
        gear: editGear.slice(), cadence: editCadence, category: editCategory,
        params: explicit   // empty → normCustom derives from the template tokens
      };
      // provenance: an EDIT keeps its id (and its existing source); a FORK stamps source:'fork' + forkedFrom.
      if (editing) rec.id = editing.id;
      else if (editForkedFrom) { rec.source = 'fork'; rec.forkedFrom = editForkedFrom; }
      // R5: a bottled-run mint carries sourceRunId through save (honest provenance). Prefer the live editor state;
      // on an EDIT of an already-bottled custom, fall back to the saved record's value so it isn't dropped.
      const srid = editSourceRunId != null ? editSourceRunId : (editing && editing.sourceRunId != null ? editing.sourceRunId : null);
      if (srid != null) rec.sourceRunId = srid;
      try {
        const saved = Recipes.saveCustom(rec);
        if (pendingMintKey && mintApi()) MintStore.markMinted(pendingMintKey);
        // a SCOUT draft: the save IS the accept — retire the staged draft server-side (never a denylist).
        if (pendingScoutRecipeId && typeof ProspectStore !== 'undefined' && ProspectStore.accept) ProspectStore.accept(pendingScoutRecipeId);
        pendingMintKey = null; pendingMintTemplate = null; pendingScoutRecipeId = null; scoutSeedDraft = null; editForkedFrom = null; editSourceRunId = null;
        focusRecipe = saved.id;
        sfx('click'); note((editing ? 'updated' : 'saved') + ' recipe: ' + saved.name, 'good');
        editingRecipeId = null; view = 'grid'; renderStage();
      } catch (e) { sfx('bad'); note((e && e.message) || 'could not save', 'bad'); }
    });
    const nameIn = stage.querySelector('#mkt-r-name');
    if (nameIn) { nameIn.focus(); nameIn.setSelectionRange(nameIn.value.length, nameIn.value.length); }
  }

  /* ---------- save / edit a specialty ---------- */
  function saveFormHTML() {
    const editing = editingId ? Specialties.get(editingId) : null;
    const d = editing || (ctx && ctx.draftFromAgent && ctx.draftFromAgent()) || { name: 'My Specialist', emoji: '✦', tagline: '', purpose: '', manual: '' };
    const hasMission = (d.purpose && d.purpose.trim()) || (d.manual && d.manual.trim());
    const title = editing ? 'EDIT SPECIALTY' : ('SAVE ' + (((ctx && ctx.agentName) || 'THIS AGENT')).toUpperCase() + ' AS A SPECIALTY');
    const intro = editing
      ? 'rename or re-icon this saved specialty — its purpose &amp; standing orders are kept as they are.'
      : 'captures this agent’s current purpose + standing orders as a reusable template you can deploy later.' +
        (hasMission ? '' : ' <b>heads up:</b> this agent has no purpose / standing-orders set yet, so the template would be near-empty.');
    const ctaCls = (editing || hasMission) ? '' : ' caution';
    const ctaText = editing ? '✓ SAVE CHANGES' : (hasMission ? '✓ SAVE SPECIALTY' : '✓ SAVE ANYWAY');
    return '<div class="mkt-save">' +
      '<div class="mkt-save-h">' + esc(title) + '</div>' +
      '<p class="mkt-hint">' + intro + '</p>' +
      '<div class="mkt-save-row"><label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-f-emoji" maxlength="2" value="' + esc(d.emoji || '✦') + '"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-f-name" maxlength="28" value="' + esc(d.name || '') + '" placeholder="e.g. Night-Shift Researcher"></label></div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-f-tag" maxlength="48" value="' + esc(d.tagline || '') + '" placeholder="one line — what it’s for"></label>' +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-do-save' + ctaCls + '">' + ctaText + '</button></div></div>';
  }
  function wireSaveForm(stage) {
    stage.querySelector('.mkt-cancel').addEventListener('click', () => { sfx('click'); view = 'grid'; editingId = null; renderStage(); });
    stage.querySelector('.mkt-do-save').addEventListener('click', () => {
      const editing = editingId ? Specialties.get(editingId) : null;
      const base = editing || (ctx && ctx.draftFromAgent && ctx.draftFromAgent()) || {};
      const name = (stage.querySelector('#mkt-f-name').value || '').trim();
      if (!name) { sfx('bad'); note('give your specialty a name', 'bad'); return; }
      const spec = Object.assign({}, base, {
        name, emoji: (stage.querySelector('#mkt-f-emoji').value || '✦').trim() || '✦',
        tagline: (stage.querySelector('#mkt-f-tag').value || '').trim()
      });
      if (editing) spec.id = editing.id;
      try {
        const saved = Specialties.saveCustom(spec);
        focusAgent = saved.id;
        sfx('click'); note((editing ? 'updated' : 'saved') + ' specialty: ' + saved.name, 'good');
        editingId = null; view = 'grid'; renderStage();
      } catch (e) { sfx('bad'); note((e && e.message) || 'could not save', 'bad'); }
    });
    const nameIn = stage.querySelector('#mkt-f-name');
    if (nameIn) { nameIn.focus(); nameIn.setSelectionRange(nameIn.value.length, nameIn.value.length); }
  }

  /* ---------- build a custom class from scratch (the ＋ tile) ----------
     A full authoring form: icon, name, accent (the seal colour), tagline, clearance tier, purpose +
     standing orders — saved straight to YOUR SPECIALISTS via Specialties.saveCustom (tags auto-derive
     from the text, so the new class ranks in the feed and deploys/recruits like any built-in). */
  const BUILD_ACCENTS = ['#ffaa33', '#7bc88a', '#6fa8bf', '#b790c0', '#cf8a7d', '#88b6c4', '#ffd34a', '#6fbcc0', '#9fc0c4'];
  function buildFormHTML() {
    // Custom classes are edited in THIS builder (via editingId) so their loadout pickers are reachable; a fresh
    // ＋ build has no editingId. Every field prefills from the spec being edited. (Built-ins are frozen — no edit.)
    const editing = editingId ? Specialties.get(editingId) : null;
    // a station-drafted prospect (buildDraft) pre-fills the NEW-class form when not editing an existing custom.
    const d = editing || buildDraft || { emoji: '✦', name: '', tagline: '', purpose: '', manual: '' };
    const sw = BUILD_ACCENTS.map(c => '<button type="button" class="mkt-sw' + (c === buildAccent ? ' sel' : '') +
      '" data-acc="' + c + '" style="background:' + c + '" aria-label="accent ' + c + '"></button>').join('');
    const seg = (m, l) => '<button type="button" class="mkt-seg' + (buildModel === m ? ' sel' : '') + '" data-model="' + m + '">' + l + '</button>';
    const previewEmoji = (d.emoji || '✦').trim() || '✦';
    return '<div class="mkt-save mkt-build-form">' +
      '<div class="mkt-save-h">' + (editing ? 'EDIT CUSTOM CLASS' : 'BUILD A CUSTOM CLASS') + '</div>' +
      '<p class="mkt-hint">' + (editing
        ? 'retune this class — its job, standing orders, look, and loadout. changes apply to agents <b>summoned from here on</b>; already-summoned agents keep the loadout they were given.'
        : 'define your own class — its job, its standing orders, its look. it joins <b>YOUR SPECIALISTS</b>, ready to deploy or summon.') + '</p>' +
      '<div class="mkt-build-preview"><div class="mkt-coin" id="mkt-build-coin" style="--accent:' + esc(buildAccent) + '">' +
        '<span class="mkt-coin-emoji" id="mkt-build-emoji">' + esc(previewEmoji) + '</span></div><span class="mkt-hint">live preview — your class seal</span></div>' +
      '<div class="mkt-save-row"><label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-b-emoji" maxlength="2" value="' + esc(previewEmoji) + '"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-b-name" maxlength="28" value="' + esc(d.name || '') + '" placeholder="e.g. Growth Hacker"></label></div>' +
      '<label class="mkt-lbl">ACCENT</label><div class="mkt-swatches" id="mkt-b-acc">' + sw + '</div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-b-tag" maxlength="48" value="' + esc(d.tagline || '') + '" placeholder="one line — what it’s for"></label>' +
      '<label class="mkt-lbl">CLEARANCE</label><div class="mkt-segs" id="mkt-b-model">' +
        seg('reasoning', '◆◆◆ DEEP') + seg('balanced', '◆◆ BALANCED') + seg('fast', '◆ FAST') + '</div>' +
      // EFFORT — the reasoning effort applied at summon (independent of the clearance tier/model).
      '<label class="mkt-lbl">REASONING EFFORT <span class="mkt-lbl-hint">— applied at summon</span></label><div class="mkt-segs" id="mkt-b-effort">' +
        effSeg(null, 'DEFAULT') + effSeg('high', 'HIGH') + effSeg('medium', 'MEDIUM') + effSeg('low', 'LOW') + '</div>' +
      // STATION GEAR — capability objectTypes this class draws on under the overseer (informational; labels from
      // the LIVE catalog). Not per-agent props — shared station gear; the picks round-trip into the saved spec.
      '<label class="mkt-lbl">STATION GEAR IT DRAWS ON <span class="mkt-lbl-hint">— shared gear it uses under the overseer</span></label>' +
      '<div class="mkt-kitpicks" id="mkt-b-kit">' + buildKitChipsHTML() + '</div>' +
      // SKILL PACKAGE — bundled recipes enabled for this class (from the live /api/skills catalog, filled async).
      '<label class="mkt-lbl">SKILL PACKAGE <span class="mkt-lbl-hint">— recipes it follows when a task matches</span></label>' +
      '<div class="mkt-chips" id="mkt-b-skills"><span class="mkt-hint mkt-chips-loading">loading the skill library…</span></div>' +
      '<label class="mkt-lbl">PURPOSE<textarea class="mkt-in mkt-b-area" id="mkt-b-purpose" rows="3" placeholder="what this class is FOR — its job, in its own words.">' + esc(d.purpose || '') + '</textarea></label>' +
      '<label class="mkt-lbl">STANDING ORDERS<textarea class="mkt-in mkt-b-area" id="mkt-b-manual" rows="4" placeholder="- the rules it always follows\n- one per line">' + esc(d.manual || '') + '</textarea></label>' +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button><button class="bb sm mkt-do-build">' + (editing ? '✓ SAVE CHANGES' : '✓ CREATE CLASS') + '</button></div></div>';
  }
  // the pickable kit objectTypes — the auto-requisitionable capabilities (computer/connector are per-agent
  // manual-bind, per-agent bound props, never shared station gear a class draws on). Labels from the live source.
  const KIT_PICKABLE = ['dish', 'cabinet', 'notebook', 'workbench', 'studio'];
  // each kit pick shows its capability blurb (from capGrant) next to the toggle, so a beginner sees what the
  // gear actually grants ("the WEB — live search & fetch") instead of a bare prop label with a hidden title.
  function buildKitChipsHTML() {
    return KIT_PICKABLE.map(t => {
      const on = buildKit.indexOf(t) >= 0;
      return '<div class="mkt-kitpick">' +
        '<button type="button" class="mkt-chip pick' + (on ? ' sel' : '') + '" data-kit="' + esc(t) + '" ' +
          'title="' + esc(capGrant(t)) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(kitPropLabel(t)) + '</button>' +
        '<span class="mkt-kitpick-grant">' + esc(capGrant(t)) + '</span></div>';
    }).join('');
  }
  const effSeg = (e, l) => '<button type="button" class="mkt-seg' + ((buildEffort === e || (e === null && !buildEffort)) ? ' sel' : '') + '" data-effort="' + (e == null ? '' : e) + '">' + l + '</button>';
  function wireBuildForm(stage) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); editingId = null; buildDraft = null; acceptingProspectId = null; view = 'grid'; renderStage(); });
    // live seal preview: icon + accent
    const emojiIn = stage.querySelector('#mkt-b-emoji'), coinEmoji = stage.querySelector('#mkt-build-emoji'), coin = stage.querySelector('#mkt-build-coin');
    if (emojiIn) emojiIn.addEventListener('input', () => { if (coinEmoji) coinEmoji.textContent = (emojiIn.value || '✦').trim() || '✦'; });
    stage.querySelectorAll('#mkt-b-acc .mkt-sw').forEach(b => b.addEventListener('click', () => {
      buildAccent = b.dataset.acc;
      stage.querySelectorAll('#mkt-b-acc .mkt-sw').forEach(x => x.classList.remove('sel')); b.classList.add('sel');
      if (coin) coin.style.setProperty('--accent', buildAccent); sfx('click');
    }));
    stage.querySelectorAll('#mkt-b-model .mkt-seg').forEach(b => b.addEventListener('click', () => {
      buildModel = b.dataset.model;
      stage.querySelectorAll('#mkt-b-model .mkt-seg').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); sfx('click');
    }));
    // EFFORT selector — '' data-effort => default (null).
    stage.querySelectorAll('#mkt-b-effort .mkt-seg').forEach(b => b.addEventListener('click', () => {
      buildEffort = b.dataset.effort || null;
      stage.querySelectorAll('#mkt-b-effort .mkt-seg').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); sfx('click');
    }));
    // KIT chips — toggle a capability objectType in/out of the picked kit.
    const wireKitChips = () => stage.querySelectorAll('#mkt-b-kit .mkt-chip.pick').forEach(b => b.addEventListener('click', () => {
      const t = b.dataset.kit, i = buildKit.indexOf(t);
      if (i >= 0) buildKit.splice(i, 1); else buildKit.push(t);
      const on = buildKit.indexOf(t) >= 0;
      b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); sfx('click');
    }));
    wireKitChips();
    // SKILL chips — fetched from the live catalog, then toggle a slug in/out of the package. Best-effort: an
    // unreachable catalog leaves a hint (the class still saves with whatever kit/effort was picked).
    const skHost = stage.querySelector('#mkt-b-skills');
    if (skHost) loadSkillCatalog().then(map => {
      const slugs = Object.keys(map).sort((a, b) => map[a].name.localeCompare(map[b].name));
      if (!slugs.length) { skHost.innerHTML = '<span class="mkt-hint">no skill library found (is the sidecar running?)</span>'; return; }
      skHost.innerHTML = slugs.map(slug => {
        const on = buildSkills.indexOf(slug) >= 0;
        return '<button type="button" class="mkt-chip pick' + (on ? ' sel' : '') + '" data-skill="' + esc(slug) + '" ' +
          'title="' + esc(map[slug].description) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(map[slug].name) + '</button>';
      }).join('');
      skHost.querySelectorAll('.mkt-chip.pick').forEach(b => b.addEventListener('click', () => {
        const slug = b.dataset.skill, i = buildSkills.indexOf(slug);
        if (i >= 0) buildSkills.splice(i, 1); else buildSkills.push(slug);
        const on = buildSkills.indexOf(slug) >= 0;
        b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); sfx('click');
      }));
    });
    const create = stage.querySelector('.mkt-do-build');
    if (create) create.addEventListener('click', () => {
      // editingId set => upserting an existing custom class through the SAME store path (saveCustom keeps the id).
      const editing = editingId ? Specialties.get(editingId) : null;
      const name = (stage.querySelector('#mkt-b-name').value || '').trim();
      if (!name) { sfx('bad'); note('give your class a name', 'bad'); stage.querySelector('#mkt-b-name').focus(); return; }
      // mirror the prospect drafter's constraint (prospect.js:112): a specialist with no gear is not a real role.
      // an empty kit used to save silently; make it explain itself and point back at the gear picker.
      if (!buildKit.length) {
        sfx('bad'); note('a specialist with no gear is not a real role — pick at least one kit item', 'bad');
        const kitHost = stage.querySelector('#mkt-b-kit'); if (kitHost && kitHost.scrollIntoView) kitHost.scrollIntoView({ block: 'center' });
        return;
      }
      // when editing, start from the saved record so non-authored carried fields (persona, tags, starters, blurb)
      // survive the round-trip; the form fields below overwrite what the builder exposes.
      const spec = Object.assign({}, editing || {}, {
        name,
        emoji: (stage.querySelector('#mkt-b-emoji').value || '✦').trim() || '✦',
        accent: buildAccent, model: buildModel,
        tagline: (stage.querySelector('#mkt-b-tag').value || '').trim(),
        purpose: (stage.querySelector('#mkt-b-purpose').value || '').trim(),
        manual: (stage.querySelector('#mkt-b-manual').value || '').trim(),
        // LOADOUT (Class Loadouts S3): the picked kit/skills/effort round-trip into the saved custom spec
        // (Specialties.normCustom normalizes + freezes them) so a user class is a full loadout, applied at summon.
        kit: buildKit.slice(), skills: buildSkills.slice(), reasoningEffort: buildEffort
      });
      // keep the id (and any non-editable carried fields, e.g. persona/tags/starters) when editing, so the edit
      // is an upsert of the SAME record rather than a new class. Editing does not touch already-summoned agents —
      // they own their loadout on their roster record (applyLoadout snapshots it at summon).
      if (editing) spec.id = editing.id;
      try {
        const saved = Specialties.saveCustom(spec);
        // Slice 4: a saved prospect graduates to a real custom class — remove it from staging (accept, not deny).
        if (acceptingProspectId && typeof ProspectStore !== 'undefined' && ProspectStore.accept) { try { ProspectStore.accept(acceptingProspectId); } catch (_) {} }
        acceptingProspectId = null; buildDraft = null;
        focusAgent = saved.id; editingId = null; view = 'grid';
        sfx('click'); note((editing ? 'updated class: ' : 'created class: ') + saved.name, 'good');
        renderStage();
      } catch (e) { sfx('bad'); note((e && e.message) || 'could not save', 'bad'); }
    });
    const nameIn = stage.querySelector('#mkt-b-name'); if (nameIn) nameIn.focus();
  }

  // Slice 4: let ProspectStore refresh the open bay when a fresh prospect mints (no-op when the bay is closed or
  // not on the grid view — never yanks the user out of the editor).
  function refreshIfOpen() { if (root && view === 'grid') { try { renderStage(); } catch (_) {} } }
  return { open, close, refreshIfOpen };
})();
