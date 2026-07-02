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
  let tab = 'agents';                            // 'agents' | 'recipes'
  let glassOpen = false;
  let pickedSummonSkin = null;
  let pickedSummonModel = null;   // SUMMON-only per-agent model choice: { model, provider, effort } or null = inherit the orchestrator's
  let focusAgent = null, focusRecipe = null;     // the spec/recipe id shown in the dossier (per tab)
  let laneFilter = 'all';                        // 'all' | 'code' | 'research' | 'general'
  let query = '';
  let buildAccent = '#ffaa33', buildModel = 'balanced';   // the custom-class builder's picked accent + tier
  let buildKit = [], buildSkills = [], buildEffort = null;   // the custom-class builder's picked loadout (Class Loadouts S3)

  const hasRecipes = () => typeof Recipes !== 'undefined';
  const hasIcons = () => typeof ClassIcons !== 'undefined';
  const mintApi = () => (typeof MintStore !== 'undefined' && MintStore.candidates) ? MintStore : null;

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
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function voiceName(personaId) { return (typeof Personas !== 'undefined' && Personas.get(personaId) && Personas.get(personaId).name) || personaId; }

  /* ---------- the class seal (engraved coin) ---------- */
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
        skillCatalog = map; return map;
      }).catch(() => { skillCatalog = {}; return skillCatalog; });
    return skillCatalogPending;
  }

  /* ---------- open / close ---------- */
  function open(context) {
    if (!has()) return;
    const trigger = (typeof document !== 'undefined' && document.activeElement) || null;
    close();
    opener = trigger;
    ctx = context || {};
    view = 'grid'; editingId = null; editingRecipeId = null; launchId = null; pendingMintKey = null; pendingMintTemplate = null;
    laneFilter = 'all'; query = '';
    tab = (ctx.mode !== 'pick' && ctx.tab === 'recipes' && hasRecipes()) ? 'recipes' : 'agents';
    glassOpen = !acked();
    pickedSummonSkin = null;
    pickedSummonModel = null;
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
          '<span>CLEARANCE&nbsp;&nbsp;<b>◆◆◆</b> DEEP&nbsp;·&nbsp;<b>◆◆</b> BALANCED&nbsp;·&nbsp;<b>◆</b> FAST</span>' +
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
    renderBar();
    renderStage();
    const panel = root.querySelector('.mkt'); if (panel) panel.focus();
  }
  function close() {
    if (!root) return;
    document.removeEventListener('keydown', onKey, true);
    root.remove(); root = null; ctx = null; view = 'grid';
    editingId = null; editingRecipeId = null; launchId = null; pendingMintKey = null; pendingMintTemplate = null;
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
  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { sfx('close'); close(); return; }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) { e.preventDefault(); const p = root.querySelector('.mkt'); if (p) p.focus(); return; }
      const first = f[0], last = f[f.length - 1], act = document.activeElement;
      if (!root.contains(act)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
    }
  }
  function subtitle() {
    if (ctx && ctx.mode === 'pick') return ctx.summon
      ? ('summon a new agent onto your crew — it gets its own workstream'
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
    const pool = (tab === 'recipes' && hasRecipes()) ? Recipes.builtins() : Specialties.builtins();
    const counts = { all: pool.length, code: 0, research: 0, general: 0 };
    pool.forEach(it => { counts[laneOf(it)] = (counts[laneOf(it)] || 0) + 1; });
    const lane = (id, label) => '<button class="mkt-lane' + (laneFilter === id ? ' on' : '') + '" data-lane="' + id + '">' +
      label + '<span class="ct">' + (counts[id] || 0) + '</span></button>';
    html += '<span class="mkt-lanes-lbl">FILTER</span><div class="mkt-lanes">' +
      lane('all', 'ALL') + lane('code', 'CODE') + lane('research', 'RESEARCH') + lane('general', 'OPS') + '</div>';
    bar.innerHTML = html;
    bar.querySelectorAll('.mkt-tab').forEach(b => b.addEventListener('click', () => {
      const next = b.dataset.tab; if (!next || next === tab) return;
      tab = next; view = 'grid'; laneFilter = 'all'; sfx('click');
      renderBar(); renderStage(); syncSub();
    }));
    bar.querySelectorAll('.mkt-lane').forEach(b => b.addEventListener('click', () => {
      const next = b.dataset.lane; if (next === laneFilter) return;
      laneFilter = next; sfx('click'); renderBar(); renderStage();
    }));
  }
  function syncSub() { const s = root && root.querySelector('#mkt-sub'); if (s) s.textContent = subtitle(); }

  /* ---------- stage: two-pane (roster + dossier) OR a full-width form ---------- */
  function renderStage() {
    const stage = root && root.querySelector('#mkt-stage'); if (!stage) return;
    if (view === 'save' || view === 'recipesave' || view === 'launch' || view === 'build') {
      stage.className = 'mkt-stage form';
      stage.innerHTML = view === 'save' ? saveFormHTML() : view === 'recipesave' ? recipeSaveFormHTML()
        : view === 'build' ? buildFormHTML() : launchFormHTML();
      if (view === 'save') wireSaveForm(stage);
      else if (view === 'recipesave') wireRecipeSaveForm(stage);
      else if (view === 'build') wireBuildForm(stage);
      else wireLaunchForm(stage);
      return;
    }
    stage.className = 'mkt-stage';
    stage.innerHTML = '<div class="mkt-roster" id="mkt-roster">' + rosterHTML() + '</div>' +
                      '<div class="mkt-dossier" id="mkt-dossier">' + dossierHTML() + '</div>';
    wireRoster(stage);
    wireDossier(stage);
    paintDossierAccent();
    if (tab !== 'recipes') hydrateSkillRows();   // fill real skill names/descriptions once the catalog loads
    if (!root.contains(document.activeElement)) { const p = root.querySelector('.mkt'); if (p) p.focus(); }
  }
  function renderDossier() {
    const d = root && root.querySelector('#mkt-dossier'); if (!d) return;
    d.innerHTML = dossierHTML();
    wireDossier(root);
    paintDossierAccent();
    if (tab !== 'recipes') hydrateSkillRows();   // fill real skill names/descriptions once the catalog loads
    const fid = tab === 'recipes' ? focusRecipe : focusAgent;
    root.querySelectorAll('.mkt-card').forEach(c => c.classList.toggle('sel', c.dataset.id === fid));
  }

  /* ---------- filtering ---------- */
  function matchq(it) {
    if (!query) return true;
    return ((it.name || '') + ' ' + (it.tagline || '') + ' ' + (it.blurb || '')).toLowerCase().includes(query);
  }
  function passLane(it) { return laneFilter === 'all' || laneOf(it) === laneFilter; }
  function filt(list) { return list.filter(it => passLane(it) && matchq(it)); }

  /* ---------- roster (left pane) ---------- */
  function rosterHTML() {
    return (tab === 'recipes' && hasRecipes()) ? recipesRosterHTML() : agentsRosterHTML();
  }
  function agentsRosterHTML() {
    const deploy = !ctx || ctx.mode !== 'pick';
    const toolbar = deploy
      ? '<div class="mkt-toolbar">' +
          '<button class="bb sm mkt-saveas">＋ SAVE THIS AGENT AS A SPECIALTY</button>' +
          '<label class="mkt-adopt"><input type="checkbox" class="mkt-adopt-cb"> adopt its voice too</label>' +
        '</div>'
      : '<div class="mkt-toolbar"><span class="mkt-hint">picking one pre-fills the wake screen — name, voice &amp; purpose, ready to tweak</span></div>';
    let html = toolbar;
    html += summonSkinBarHTML();
    html += summonModelBarHTML();
    html += glassHTML();
    html += recShelfHTML();
    const builtins = filt(Specialties.builtins());
    const customs = filt(Specialties.customs());
    html += '<div class="mkt-sect-h">▮ CLASS ROSTER</div>';
    html += builtins.length ? '<div class="mkt-grid">' + builtins.map(cardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no classes match your filter.</div>';
    // the build tile (＋) is always available at the bottom — author a brand-new class however you want
    const buildTile = '<button class="mkt-build" type="button" aria-label="build a custom class">' +
      '<span class="mkt-build-plus" aria-hidden="true">＋</span><span class="mkt-build-lbl">BUILD A CUSTOM CLASS</span></button>';
    html += '<div class="mkt-sect-h">▮ YOUR SPECIALISTS</div>';
    if (!customs.length) html += '<p class="mkt-hint mkt-yours-hint">none yet — build one from scratch below' + (deploy ? ', or save the live agent as a specialty above' : '') + '.</p>';
    html += '<div class="mkt-grid">' + customs.map(cardHTML).join('') + buildTile + '</div>';
    return html;
  }
  function recipesRosterHTML() {
    if (!hasRecipes()) return '<div class="mkt-empty">the recipe library isn’t available.</div>';
    let html = '<div class="mkt-toolbar"><button class="bb sm mkt-recipe-saveas">＋ SAVE A RECIPE</button>' +
      '<span class="mkt-hint">pick a recipe, fill in the blanks, and ' + esc((ctx && ctx.agentName) || 'your agent') + ' runs it in a fresh workstream</span></div>';
    html += glassHTML();
    html += suggestedShelfHTML();
    html += recipeRecShelfHTML();
    const builtins = filt(Recipes.builtins());
    const customs = filt(Recipes.customs());
    html += '<div class="mkt-sect-h">▮ RECIPE LIBRARY</div>';
    html += builtins.length ? '<div class="mkt-grid">' + builtins.map(recipeCardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no recipes match your filter.</div>';
    html += '<div class="mkt-sect-h">▮ YOUR RECIPES</div>';
    html += customs.length ? '<div class="mkt-grid">' + customs.map(recipeCardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no saved recipes yet — hit “＋ save a recipe” above to turn a job you do often into a one-tap recipe you own.</div>';
    return html;
  }

  // SUMMON-only: pick the new agent's APPEARANCE (its own choice — independent of class).
  function summonSkinBarHTML() {
    if (!(ctx && ctx.mode === 'pick' && ctx.summon) || typeof DATA === 'undefined' || !DATA.SKINS) return '';
    if (!pickedSummonSkin || !DATA.SKINS[pickedSummonSkin]) pickedSummonSkin = DATA.DEFAULT_SKIN;
    const thumbs = Object.keys(DATA.SKINS).map(id => {
      const sk = DATA.SKINS[id];
      return '<button type="button" class="skin-thumb' + (id === pickedSummonSkin ? ' sel' : '') +
        '" data-skin="' + esc(id) + '" title="' + esc(sk.name || id) + '">' +
        '<img src="assets/sprites/' + esc(sk.set) + '/rot_south.png" alt="' + esc(sk.name || id) + '" draggable="false"></button>';
    }).join('');
    return '<div class="mkt-skinbar"><label class="mkt-skinlabel">APPEARANCE <span class="mkt-hint">— the character this agent wears (your call, any class)</span></label>' +
      '<div class="skin-picker" id="mkt-skin-picker">' + thumbs + '</div></div>';
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
  function cardHTML(s) {
    const deploy = !ctx || ctx.mode !== 'pick';
    const here = deploy && ctx && ctx.currentSpecialtyId === s.id;
    const sel = (focusAgent === s.id);
    return '<button class="mkt-card' + (sel ? ' sel' : '') + '" type="button" data-id="' + esc(s.id) + '" style="--accent:' + esc(s.accent) + '">' +
      sealHTML(s, true) +
      '<div class="mkt-card-id">' +
        '<div class="mkt-name">' + esc(s.name) +
          (here ? ' <span class="mkt-badge mkt-here">DEPLOYED</span>' : '') +
          (s.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
        '<div class="mkt-tag">' + esc(s.tagline) + '</div>' +
        '<div class="mkt-meta"><span class="mkt-chip lane">' + esc(laneLabelOf(s)) + '</span>' +
          pipsOf(s.model) + ' <span class="mkt-tier">' + esc(clearanceLabel(s.model)) + '</span></div>' +
      '</div>' +
    '</button>';
  }
  function recipeCardHTML(r) {
    const sel = (focusRecipe === r.id);
    const n = (r.params || []).length;
    const setup = n ? ('▤ ' + n + ' input' + (n === 1 ? '' : 's')) : '◷ no setup';
    return '<button class="mkt-card' + (sel ? ' sel' : '') + '" type="button" data-id="' + esc(r.id) + '" style="--accent:' + esc(r.accent) + '">' +
      sealHTML(r, true) +
      '<div class="mkt-card-id">' +
        '<div class="mkt-name">' + esc(r.name) + (r.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
        '<div class="mkt-tag">' + esc(r.tagline) + '</div>' +
        '<div class="mkt-meta"><span class="mkt-chip lane">' + esc(laneLabelOf(r)) + '</span>' +
          '<span class="mkt-chip">' + setup + '</span></div>' +
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
  function dossierHTML() {
    return (tab === 'recipes' && hasRecipes()) ? recipeDossierHTML() : agentDossierHTML();
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
    const rows = kit.map(t => {
      const present = have.has(t);
      if (!present) missing++;
      return '<div class="mkt-kit-row' + (present ? '' : ' mkt-kit-missing') + '">' +
        '<span class="mkt-kit-obj">' + esc(kitPropLabel(t)) + '</span>' +
        '<span class="mkt-kit-grant">' + esc(capGrant(t)) + '</span>' +
        '<span class="mkt-kit-state">' + (present ? 'on station' : 'not on station — add in REFIT') + '</span></div>';
    }).join('');
    const note = missing
      ? 'shared station gear this class draws on under the overseer — ' + missing + ' not on the station yet (add ' + (missing === 1 ? 'it' : 'them') + ' in REFIT for its full toolkit).'
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

  function agentDossierHTML() {
    const s = (focusAgent && Specialties.get(focusAgent)) || Specialties.builtins()[0];
    if (!s) return '<div class="mkt-dos-empty">no class selected.</div>';
    const deploy = !ctx || ctx.mode !== 'pick';
    const here = deploy && ctx && ctx.currentSpecialtyId === s.id;
    const t = s.tags || {};
    const bar = (k, label) => { const v = Math.round((t[k] || 0) * 100);
      return '<div class="mkt-barrow"><span class="bk">' + label + '</span><span class="trk"><span class="fill" style="width:' + v + '%"></span></span><span class="bv">' + v + '%</span></div>'; };
    const badges = (here ? ' <span class="mkt-badge mkt-here">DEPLOYED</span>' : '') + (s.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '');
    const ctaLabel = deploy ? ('⏼ DEPLOY TO ' + esc(((ctx && ctx.agentName) || 'AGENT')).toUpperCase()) : ('⏼ SUMMON ' + esc(s.name).toUpperCase());
    const ctaSub = deploy
      ? 're-specs ' + esc((ctx && ctx.agentName) || 'your agent') + '’s purpose &amp; standing orders'
      : 'opens a fresh workstream · pre-fills name, voice &amp; purpose — <b>you pick its character next</b>';
    const custActs = s.custom
      ? '<div class="mkt-cta-row"><button class="bb sm mkt-edit" data-id="' + esc(s.id) + '">✎ EDIT</button>' +
        '<button class="bb sm danger mkt-del" data-id="' + esc(s.id) + '">⌫ DELETE</button></div>' : '';
    // CLEARANCE is honest about what summon APPLIES vs INHERITS: the reasoning effort is applied to the agent
    // record at summon; the model is a tier that resolves to the pinned/station-default model (advisory pip).
    const effort = s.reasoningEffort ? esc(String(s.reasoningEffort).toUpperCase()) : null;
    const clearRow =
      '<span class="k">CLEARANCE</span><span class="v">' + pipsOf(s.model) + ' ' + esc(clearanceLabel(s.model)) +
        ' <span class="mkt-clr-note">model: station default</span></span>' +
      '<span class="k">EFFORT</span><span class="v">' +
        (effort ? '<span class="mkt-chip">' + effort + '</span> <span class="mkt-clr-note">applied at summon</span>'
                : '<span class="mkt-clr-note">station default</span>') + '</span>';
    return '<div class="mkt-dos-label">▮ CLASS DOSSIER</div>' +
      '<div class="mkt-dos-hero">' + sealHTML(s, true) +
        '<div class="mkt-dos-hi"><div class="mkt-dos-name">' + esc(s.name) + badges + '</div>' +
          '<div class="mkt-dos-tag">' + esc(s.tagline) + '</div>' +
          '<div class="mkt-dos-class">CLASS · ' + esc(codeOf(s)) + '</div></div></div>' +
      '<div class="mkt-spec">' +
        clearRow +
        '<span class="k">VOICE</span><span class="v">◈ ' + esc(voiceName(s.persona)) + '</span>' +
        '<span class="k">FOCUS</span><span class="v"><span class="mkt-chip lane">' + esc(laneLabelOf(s)) + '</span></span>' +
      '</div>' +
      '<div class="mkt-block"><div class="bh">FOCUS LANES</div><div class="mkt-bars">' + bar('code', 'CODE') + bar('research', 'RESEARCH') + bar('general', 'OPS') + '</div></div>' +
      kitBlockHTML(s) +
      skillPackageHTML(s) +
      '<div class="mkt-block"><div class="bh">PURPOSE</div><p class="bp">' + esc(s.purpose) + '</p></div>' +
      (s.manual ? '<div class="mkt-block"><div class="bh">STANDING ORDERS</div><pre>' + esc(s.manual) + '</pre></div>' : '') +
      (s.starters && s.starters.length ? '<div class="mkt-block"><div class="bh">TRY ASKING</div><ul class="mkt-starters">' + s.starters.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : '') +
      '<div class="mkt-dos-cta">' + custActs +
        '<button class="mkt-cta-main mkt-deploy" data-id="' + esc(s.id) + '">' + ctaLabel + ' ▸</button>' +
        '<div class="mkt-cta-sub">' + ctaSub + '</div>' +
      '</div>';
  }
  function recipeDossierHTML() {
    const r = (focusRecipe && Recipes.get(focusRecipe)) || Recipes.builtins()[0];
    if (!r) return '<div class="mkt-dos-empty">no recipe selected.</div>';
    const who = (ctx && ctx.agentName) || 'your agent';
    const n = (r.params || []).length;
    const inputs = n ? '<div class="mkt-block"><div class="bh">INPUTS</div><ul class="mkt-starters">' +
      r.params.map(p => '<li>' + esc(p.label) + (p.required ? '' : ' <i>(optional)</i>') + '</li>').join('') + '</ul></div>' : '';
    const custActs = r.custom
      ? '<div class="mkt-cta-row"><button class="bb sm mkt-recipe-edit" data-id="' + esc(r.id) + '">✎ EDIT</button>' +
        '<button class="bb sm danger mkt-recipe-del" data-id="' + esc(r.id) + '">⌫ DELETE</button></div>' : '';
    return '<div class="mkt-dos-label">▮ RECIPE DOSSIER</div>' +
      '<div class="mkt-dos-hero">' + sealHTML(r, true) +
        '<div class="mkt-dos-hi"><div class="mkt-dos-name">' + esc(r.name) + (r.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
          '<div class="mkt-dos-tag">' + esc(r.tagline) + '</div></div></div>' +
      '<div class="mkt-block"><div class="bh">WHAT IT SENDS</div><pre>' + esc(r.task) + '</pre></div>' +
      inputs +
      '<div class="mkt-dos-cta">' + custActs +
        '<button class="mkt-cta-main mkt-launch" data-id="' + esc(r.id) + '">' + (n ? '▸ SET UP &amp; LAUNCH' : '▸ LAUNCH RECIPE') + '</button>' +
        '<div class="mkt-cta-sub">opens a fresh workstream · sets <b>' + esc(who) + '</b> to work on it</div>' +
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
  function rankItems(items, excludeId) {
    const ps = profileApi(); if (!ps) return null;
    const summ = ps.summary(); if (!summ || !summ.dominant) return null;
    if (ps.enabled && !ps.enabled()) return null;
    const ranked = (items || [])
      .map((it, idx) => ({ it, idx, score: ps.score(it.tags || {}) }))
      .filter(r => r.it.id !== excludeId && r.score > 0)
      .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
      .slice(0, 3);
    return ranked.length ? ranked.map(r => r.it) : null;
  }
  function becauseText(s) {
    const ps = profileApi(); if (!ps || !ps.explain) return '';
    const t = ps.explain(s.tags || {});
    return t ? (BECAUSE[t] || '') : '';
  }
  function recShelfHTML() {
    if (ctx && ctx.mode === 'pick') return '';
    const items = rankItems(Specialties.builtins(), ctx && ctx.currentSpecialtyId); if (!items) return '';
    return '<div class="mkt-sect-h mkt-rec-sect">★ RECOMMENDED FOR YOU</div><div class="mkt-rec-rail">' + items.map(recCardHTML).join('') + '</div>';
  }
  function recipeRecShelfHTML() {
    if (!hasRecipes()) return '';
    const items = rankItems(Recipes.builtins(), null); if (!items) return '';
    return '<div class="mkt-sect-h mkt-rec-sect">★ RECOMMENDED FOR YOU</div><div class="mkt-rec-rail">' + items.map(recipeRecCardHTML).join('') + '</div>';
  }
  function recCardHTML(s) {
    const why = becauseText(s);
    return '<button class="mkt-rec" type="button" data-id="' + esc(s.id) + '" style="--accent:' + esc(s.accent) + '">' +
      '<div class="mkt-rec-top">' + sealHTML(s, false) +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(s.name) + '</div><div class="mkt-rec-tag">' + esc(s.tagline) + '</div></div></div>' +
      (why ? '<div class="mkt-rec-why"><span class="mkt-rec-why-k">WHY</span> ' + esc(why) + '</div>' : '') + '</button>';
  }
  function recipeRecCardHTML(r) {
    const why = becauseText(r);
    return '<button class="mkt-rec" type="button" data-id="' + esc(r.id) + '" style="--accent:' + esc(r.accent) + '">' +
      '<div class="mkt-rec-top">' + sealHTML(r, false) +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(r.name) + '</div><div class="mkt-rec-tag">' + esc(r.tagline) + '</div></div></div>' +
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
    const cands = suggestedMissions(); if (!cands.length) return '';
    return '<div class="mkt-sect-h mkt-suggest-sect">✨ SUGGESTED — from what you keep asking</div><div class="mkt-rec-rail">' + cands.map(suggestCardHTML).join('') + '</div>';
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
    if (build) build.addEventListener('click', () => { sfx('click'); buildAccent = '#ffaa33'; buildModel = 'balanced'; buildKit = []; buildSkills = []; buildEffort = null; view = 'build'; renderStage(); });
    const recipeSaveas = stage.querySelector('.mkt-recipe-saveas');
    if (recipeSaveas) recipeSaveas.addEventListener('click', () => { sfx('click'); view = 'recipesave'; editingRecipeId = null; pendingMintKey = null; pendingMintTemplate = null; renderStage(); });

    const skinWrap = stage.querySelector('#mkt-skin-picker');
    if (skinWrap) skinWrap.querySelectorAll('.skin-thumb').forEach(b => b.addEventListener('click', () => {
      pickedSummonSkin = b.dataset.skin;
      skinWrap.querySelectorAll('.skin-thumb').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel'); sfx('click');
    }));

    // SUMMON model picker: fill the catalog async, then track the choice ('' model → inherit the orchestrator's).
    const modelWrap = stage.querySelector('#mkt-model-pick');
    if (modelWrap && typeof ModelPicker !== 'undefined') {
      ModelPicker.populate(modelWrap, { current: pickedSummonModel || {} }).catch(() => {});
      ModelPicker.onChange(modelWrap, (sel) => {
        pickedSummonModel = (sel && sel.model) ? { model: sel.model, provider: sel.provider, effort: sel.effort || '' } : null;
        sfx('click');
      });
    }

    wireGlass(stage);
    wireSuggest(stage);
  }

  /* ---------- wiring: dossier (the action button + custom edit/delete) ---------- */
  function wireDossier(scope) {
    const sc = scope || root; if (!sc) return;
    const deployBtn = sc.querySelector('.mkt-deploy');
    if (deployBtn) deployBtn.addEventListener('click', () => {
      const s = Specialties.get(deployBtn.dataset.id); if (!s) return;
      sfx('click');
      if (ctx && ctx.mode === 'pick') {
        if (ctx.onPick) ctx.onPick(ctx.summon ? Object.assign({}, s, { skin: pickedSummonSkin || (typeof DATA !== 'undefined' && DATA.DEFAULT_SKIN), modelPin: pickedSummonModel || null }) : s);
        close();
      } else {
        const cb = root && root.querySelector('.mkt-adopt-cb');
        const adoptVoice = !!(cb && cb.checked);
        if (ctx && ctx.onDeploy) ctx.onDeploy(s, { adoptVoice });
        note(s.name + ' deployed to ' + ((ctx && ctx.agentName) || 'your agent') + (adoptVoice ? ' (+ voice)' : ''), 'good');
        close();
      }
    });
    const launchBtn = sc.querySelector('.mkt-launch');
    if (launchBtn) launchBtn.addEventListener('click', () => {
      if (!hasRecipes()) return;
      const r = Recipes.get(launchBtn.dataset.id); if (!r) return;
      sfx('click');
      if (r.params && r.params.length) { launchId = r.id; view = 'launch'; renderStage(); }
      else launchRecipeNow(r, {});
    });
    const edit = sc.querySelector('.mkt-edit');
    if (edit) edit.addEventListener('click', () => { editingId = edit.dataset.id; sfx('click'); view = 'save'; renderStage(); });
    const rEdit = sc.querySelector('.mkt-recipe-edit');
    if (rEdit) rEdit.addEventListener('click', () => { editingRecipeId = rEdit.dataset.id; pendingMintKey = null; pendingMintTemplate = null; sfx('click'); view = 'recipesave'; renderStage(); });
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
  // two-step arm/confirm on a destructive button (the bay's idiom — never a native confirm)
  function armDelete(b, label, run) {
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1'; b.classList.add('armed'); b.textContent = 'SURE?'; sfx('bad');
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
    if (famForget) famForget.addEventListener('click', () => {
      if (famForget.dataset.armed !== '1') {
        famForget.dataset.armed = '1'; famForget.classList.add('armed'); famForget.textContent = 'SURE? WIPE'; sfx('bad');
        setTimeout(() => { if (famForget.isConnected) { famForget.dataset.armed = '0'; famForget.classList.remove('armed'); famForget.textContent = '⌫ FORGET'; } }, 4000);
        return;
      }
      const ps = profileApi(); if (ps && ps.forget) ps.forget();
      if (mintApi() && MintStore.forget) MintStore.forget();
      sfx('close'); note('profile wiped — the station forgot what it learned', 'good'); renderStage();
    });
  }

  /* ---------- wiring: suggested (mint) ---------- */
  function wireSuggest(scope) {
    const sc = scope || root;
    sc.querySelectorAll('.mkt-suggest-review').forEach(b => b.addEventListener('click', () => {
      const c = suggestedMissions().find(x => x.key === b.dataset.key);
      if (!c) { renderStage(); return; }
      pendingMintKey = c.key; pendingMintTemplate = c.template; editingRecipeId = null;
      sfx('click'); view = 'recipesave'; renderStage();
    }));
    sc.querySelectorAll('.mkt-suggest-dismiss').forEach(b => b.addEventListener('click', () => {
      if (mintApi()) MintStore.markDismissed(b.dataset.key);
      sfx('close'); renderStage();
    }));
  }

  /* ---------- launch a recipe ---------- */
  function launchRecipeNow(r, values) {
    const ok = !ctx || !ctx.onLaunch || ctx.onLaunch(r, values) !== false;
    if (ok) { note('recipe launched: ' + r.name + ' — ' + ((ctx && ctx.agentName) || 'your agent') + ' is on it', 'good'); close(); }
    else { sfx('bad'); note('could not launch ' + r.name + ' — nothing to send', 'bad'); }
  }
  function launchFormHTML() {
    const r = launchId && hasRecipes() ? Recipes.get(launchId) : null;
    if (!r) { view = 'grid'; return '<div class="mkt-roster">' + rosterHTML() + '</div>'; }
    const who = (ctx && ctx.agentName) || 'your agent';
    const fields = (r.params || []).map(p =>
      '<label class="mkt-lbl">' + esc(p.label) +
        (p.required ? ' <span class="mkt-req" title="required">*</span>' : ' <span class="mkt-opt">(optional)</span>') +
        '<textarea class="mkt-in mkt-p-in" data-key="' + esc(p.key) + '" rows="2" placeholder="' + esc(p.placeholder || '') + '"></textarea></label>').join('');
    return '<div class="mkt-save mkt-launch-form">' +
      '<div class="mkt-save-h">' + esc('▸ LAUNCH — ' + r.name) + '</div>' +
      '<p class="mkt-hint">' + esc(r.blurb || r.tagline) + '</p>' +
      (fields || '<p class="mkt-hint">this recipe needs no setup — just launch it.</p>') +
      '<p class="mkt-launch-note">▸ opens a fresh workstream and sets <b>' + esc(who) + '</b> to work on it.</p>' +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button><button class="bb sm mkt-do-launch">▸ LAUNCH RECIPE</button></div></div>';
  }
  function wireLaunchForm(stage) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); view = 'grid'; launchId = null; renderStage(); });
    stage.querySelectorAll('.mkt-p-in').forEach(inp => inp.addEventListener('input', () => inp.classList.remove('mkt-bad')));
    const go = stage.querySelector('.mkt-do-launch');
    if (go) go.addEventListener('click', () => {
      const r = launchId && hasRecipes() ? Recipes.get(launchId) : null;
      if (!r) { view = 'grid'; launchId = null; renderStage(); return; }
      const values = {};
      stage.querySelectorAll('.mkt-p-in').forEach(inp => { values[inp.dataset.key] = inp.value; });
      const missing = Recipes.requiredMissing(r, values);
      if (missing.length) {
        sfx('bad');
        missing.forEach(k => { const f = stage.querySelector('.mkt-p-in[data-key="' + k + '"]'); if (f) f.classList.add('mkt-bad'); });
        const f0 = stage.querySelector('.mkt-p-in[data-key="' + missing[0] + '"]'); if (f0) f0.focus();
        note('fill in: ' + missing.join(', '), 'bad'); return;
      }
      launchId = null; launchRecipeNow(r, values);
    });
    const first = stage.querySelector('.mkt-p-in'); if (first) first.focus();
  }

  /* ---------- author / edit a mission ---------- */
  function recipeTokenHint(task) {
    if (!hasRecipes()) return '';
    const ps = Recipes.paramsFromTemplate(task);
    if (!ps.length) return '<span class="mkt-r-tok-none">◷ one-tap recipe — no fill-ins</span>';
    return '<span class="mkt-r-tok-lbl">asks for</span> ' + ps.map(p => '<span class="mkt-r-tok">' + esc(p.label) + '</span>').join(' ');
  }
  function recipeSaveFormHTML() {
    const editing = editingRecipeId && hasRecipes() ? Recipes.get(editingRecipeId) : null;
    const minting = !editing && !!pendingMintTemplate;
    const d = editing || (minting
      ? { emoji: '✦', name: pendingMintTemplate.replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 28), tagline: '', task: pendingMintTemplate }
      : { emoji: '✦', name: '', tagline: '', task: '' });
    const title = editing ? 'EDIT RECIPE' : minting ? 'SAVE THIS AS A RECIPE' : 'SAVE A RECIPE';
    const intro = minting
      ? 'you’ve done this a few times — saving it makes it a one-tap recipe you own. Tweak the wording, wrap any blanks in <b>{braces}</b>, then save.'
      : 'write the directive your agent should run. Wrap each blank in <b>{braces}</b> — “Brief me on <b>{topic}</b>” — and it becomes a fill-in at launch.';
    return '<div class="mkt-save mkt-recipe-form">' +
      '<div class="mkt-save-h">' + esc(title) + '</div>' +
      '<p class="mkt-hint">' + intro + '</p>' +
      '<div class="mkt-save-row"><label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-r-emoji" maxlength="2" value="' + esc(d.emoji || '✦') + '"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-r-name" maxlength="28" value="' + esc(d.name || '') + '" placeholder="e.g. Morning Standup"></label></div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-r-tag" maxlength="48" value="' + esc(d.tagline || '') + '" placeholder="one line — what it’s for"></label>' +
      '<label class="mkt-lbl">DIRECTIVE TEMPLATE<textarea class="mkt-in mkt-r-task" id="mkt-r-task" rows="4" placeholder="e.g. Summarize {project} progress since {since} and flag blockers.">' + esc(d.task || '') + '</textarea></label>' +
      '<div class="mkt-r-tokens" id="mkt-r-tokens"></div>' +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-do-recipe-save">' + (editing ? '✓ SAVE CHANGES' : '✓ SAVE RECIPE') + '</button></div></div>';
  }
  function wireRecipeSaveForm(stage) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); view = 'grid'; editingRecipeId = null; pendingMintKey = null; pendingMintTemplate = null; renderStage(); });
    const taskIn = stage.querySelector('#mkt-r-task'), tokens = stage.querySelector('#mkt-r-tokens');
    const paint = () => { if (tokens && taskIn) tokens.innerHTML = recipeTokenHint(taskIn.value); };
    if (taskIn) taskIn.addEventListener('input', paint); paint();
    const save = stage.querySelector('.mkt-do-recipe-save');
    if (save) save.addEventListener('click', () => {
      const editing = editingRecipeId && hasRecipes() ? Recipes.get(editingRecipeId) : null;
      const name = (stage.querySelector('#mkt-r-name').value || '').trim();
      const task = (stage.querySelector('#mkt-r-task').value || '').trim();
      if (!name) { sfx('bad'); note('give your recipe a name', 'bad'); stage.querySelector('#mkt-r-name').focus(); return; }
      if (!task) { sfx('bad'); note('write the directive your agent should run', 'bad'); stage.querySelector('#mkt-r-task').focus(); return; }
      const rec = { name, emoji: (stage.querySelector('#mkt-r-emoji').value || '✦').trim() || '✦', tagline: (stage.querySelector('#mkt-r-tag').value || '').trim(), task };
      if (editing) rec.id = editing.id;
      try {
        const saved = Recipes.saveCustom(rec);
        if (pendingMintKey && mintApi()) MintStore.markMinted(pendingMintKey);
        pendingMintKey = null; pendingMintTemplate = null;
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
    const sw = BUILD_ACCENTS.map(c => '<button type="button" class="mkt-sw' + (c === buildAccent ? ' sel' : '') +
      '" data-acc="' + c + '" style="background:' + c + '" aria-label="accent ' + c + '"></button>').join('');
    const seg = (m, l) => '<button type="button" class="mkt-seg' + (buildModel === m ? ' sel' : '') + '" data-model="' + m + '">' + l + '</button>';
    return '<div class="mkt-save mkt-build-form">' +
      '<div class="mkt-save-h">BUILD A CUSTOM CLASS</div>' +
      '<p class="mkt-hint">define your own class — its job, its standing orders, its look. it joins <b>YOUR SPECIALISTS</b>, ready to deploy or summon.</p>' +
      '<div class="mkt-build-preview"><div class="mkt-coin" id="mkt-build-coin" style="--accent:' + esc(buildAccent) + '">' +
        '<span class="mkt-coin-emoji" id="mkt-build-emoji">✦</span></div><span class="mkt-hint">live preview — your class seal</span></div>' +
      '<div class="mkt-save-row"><label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-b-emoji" maxlength="2" value="✦"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-b-name" maxlength="28" placeholder="e.g. Growth Hacker"></label></div>' +
      '<label class="mkt-lbl">ACCENT</label><div class="mkt-swatches" id="mkt-b-acc">' + sw + '</div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-b-tag" maxlength="48" placeholder="one line — what it’s for"></label>' +
      '<label class="mkt-lbl">CLEARANCE</label><div class="mkt-segs" id="mkt-b-model">' +
        seg('reasoning', '◆◆◆ DEEP') + seg('balanced', '◆◆ BALANCED') + seg('fast', '◆ FAST') + '</div>' +
      // EFFORT — the reasoning effort applied at summon (independent of the clearance tier/model).
      '<label class="mkt-lbl">REASONING EFFORT <span class="mkt-lbl-hint">— applied at summon</span></label><div class="mkt-segs" id="mkt-b-effort">' +
        effSeg(null, 'DEFAULT') + effSeg('high', 'HIGH') + effSeg('medium', 'MEDIUM') + effSeg('low', 'LOW') + '</div>' +
      // STATION GEAR — capability objectTypes this class draws on under the overseer (informational; labels from
      // the LIVE catalog). Not per-agent props — shared station gear; the picks round-trip into the saved spec.
      '<label class="mkt-lbl">STATION GEAR IT DRAWS ON <span class="mkt-lbl-hint">— shared gear it uses under the overseer</span></label>' +
      '<div class="mkt-chips" id="mkt-b-kit">' + buildKitChipsHTML() + '</div>' +
      // SKILL PACKAGE — bundled recipes enabled for this class (from the live /api/skills catalog, filled async).
      '<label class="mkt-lbl">SKILL PACKAGE <span class="mkt-lbl-hint">— recipes it follows when a task matches</span></label>' +
      '<div class="mkt-chips" id="mkt-b-skills"><span class="mkt-hint mkt-chips-loading">loading the skill library…</span></div>' +
      '<label class="mkt-lbl">PURPOSE<textarea class="mkt-in mkt-b-area" id="mkt-b-purpose" rows="3" placeholder="what this class is FOR — its job, in its own words."></textarea></label>' +
      '<label class="mkt-lbl">STANDING ORDERS<textarea class="mkt-in mkt-b-area" id="mkt-b-manual" rows="4" placeholder="- the rules it always follows\n- one per line"></textarea></label>' +
      '<div class="mkt-save-acts"><button class="bb sm mkt-cancel">‹ BACK</button><button class="bb sm mkt-do-build">✓ CREATE CLASS</button></div></div>';
  }
  // the pickable kit objectTypes — the auto-requisitionable capabilities (computer/connector are per-agent
  // manual-bind, per-agent bound props, never shared station gear a class draws on). Labels from the live source.
  const KIT_PICKABLE = ['dish', 'cabinet', 'notebook', 'workbench', 'studio'];
  function buildKitChipsHTML() {
    return KIT_PICKABLE.map(t => {
      const on = buildKit.indexOf(t) >= 0;
      return '<button type="button" class="mkt-chip pick' + (on ? ' sel' : '') + '" data-kit="' + esc(t) + '" ' +
        'title="' + esc(capGrant(t)) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(kitPropLabel(t)) + '</button>';
    }).join('');
  }
  const effSeg = (e, l) => '<button type="button" class="mkt-seg' + ((buildEffort === e || (e === null && !buildEffort)) ? ' sel' : '') + '" data-effort="' + (e == null ? '' : e) + '">' + l + '</button>';
  function wireBuildForm(stage) {
    const back = stage.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); view = 'grid'; renderStage(); });
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
      const name = (stage.querySelector('#mkt-b-name').value || '').trim();
      if (!name) { sfx('bad'); note('give your class a name', 'bad'); stage.querySelector('#mkt-b-name').focus(); return; }
      const spec = {
        name,
        emoji: (stage.querySelector('#mkt-b-emoji').value || '✦').trim() || '✦',
        accent: buildAccent, model: buildModel,
        tagline: (stage.querySelector('#mkt-b-tag').value || '').trim(),
        purpose: (stage.querySelector('#mkt-b-purpose').value || '').trim(),
        manual: (stage.querySelector('#mkt-b-manual').value || '').trim(),
        // LOADOUT (Class Loadouts S3): the picked kit/skills/effort round-trip into the saved custom spec
        // (Specialties.normCustom normalizes + freezes them) so a user class is a full loadout, applied at summon.
        kit: buildKit.slice(), skills: buildSkills.slice(), reasoningEffort: buildEffort
      };
      try {
        const saved = Specialties.saveCustom(spec);
        focusAgent = saved.id; view = 'grid';
        sfx('click'); note('created class: ' + saved.name, 'good');
        renderStage();
      } catch (e) { sfx('bad'); note((e && e.message) || 'could not save', 'bad'); }
    });
    const nameIn = stage.querySelector('#mkt-b-name'); if (nameIn) nameIn.focus();
  }

  return { open, close };
})();
