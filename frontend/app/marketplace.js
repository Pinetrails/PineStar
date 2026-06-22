/* SKYNET — marketplace.js : THE RECRUITMENT BAY — a browsable "app store" of agent specialties.

   Renders the Specialties catalog (built-ins + the Commander's saved customs) as a gallery of cards.
   Self-contained: it builds its own full-screen overlay (scrim + panel), owns all its DOM + events,
   and themes purely off the existing CSS vars (marketplace.css) so it never touches a shared stylesheet.

   Two modes, both opened by the app:
     • 'deploy'  (in-game)  — DEPLOY a specialty onto the CURRENT agent (re-specs its purpose + standing
                              orders via the app's real applyAgentConfig path; optionally adopts its voice),
                              SAVE the current agent as a reusable custom specialty, and EDIT/DELETE customs.
     • 'pick'    (at wake)  — choose a specialist to wake a NEW agent as; hands the chosen spec back so the
                              connect screen can pre-fill persona / suit / name and seed the dossier.

   Accessibility: the overlay is a real modal dialog (role=dialog, aria-modal, labelled by its title), it
   moves focus into the panel on open, TRAPS Tab inside it, and restores focus to the opener on close. The
   destructive delete uses the app's own arm/confirm idiom — never a native window.confirm.

   The app injects everything coupling-sensitive (onDeploy / onPick / draft-from-agent / notify / the live
   agent's specialtyId); the bay talks to Specialties directly for the catalog + custom round-trip.
   UMD-light: a `Marketplace` global. */
'use strict';
const Marketplace = (() => {
  let root = null, ctx = null, view = 'grid';   // 'grid' | 'save' | 'launch'
  let opener = null;                            // the element focus came from, restored on close
  let editingId = null;                         // when set, the save form edits this custom SPECIALTY (not a new save)
  let editingRecipeId = null;                   // when set, the recipe save form edits this custom MISSION
  let launchId = null;                          // when set (view='launch'), the recipe being configured to launch
  let pendingMintKey = null;                    // when minting a SUGGESTED recurring job, the mint shape key (marked minted on save)
  let pendingMintTemplate = null;               // the proposed directive template the recipe save form pre-fills with
  let tab = 'agents';                           // 'agents' (specialties) | 'recipes' (missions) — the deploy-bay tab
  let glassOpen = false;                        // the "what I've learned about you" panel expanded? (per-session)
  const expanded = {};                          // specId/recipeId -> preview open (persists across re-renders)

  const hasRecipes = () => typeof Recipes !== 'undefined';   // the Recipe library is optional (degrades to agents-only)
  // MintStore is the auto-mint wiring; null until enterGame() inits it (so 'pick' mode at wake has no proposals).
  const mintApi = () => (typeof MintStore !== 'undefined' && MintStore.candidates) ? MintStore : null;

  /* ---------- personalization (the recommender's read surface) ---------- */
  const FAM_TAGS = ['code', 'research', 'general'];   // the interest vocabulary (mirrors classify.js / profile.js)
  const TAG_LABEL = { code: 'CODE', research: 'RESEARCH', general: 'GENERAL OPS' };
  // the deterministic "because you…" copy, keyed by the tag that actually dominated an item's score. Phrased
  // to read true whether the signal is a real observation or the onboarding seed ("your focus", not "recent work").
  const BECAUSE = { code: 'matches your focus on code', research: 'matches your focus on research', general: 'fits your day-to-day ops' };
  const ACK_KEY = 'skynet.profile.ack.v1';      // one-time first-run consent acknowledgement

  // ProfileStore is the live wiring; it's null until enterGame() inits it (so 'pick' mode at wake has no profile).
  const profileApi = () => (typeof ProfileStore !== 'undefined' && ProfileStore.summary) ? ProfileStore : null;
  function acked() { try { return typeof localStorage !== 'undefined' && !!localStorage.getItem(ACK_KEY); } catch (_) { return true; } }
  function setAcked() { try { if (typeof localStorage !== 'undefined') localStorage.setItem(ACK_KEY, '1'); } catch (_) {} }

  const has = () => typeof Specialties !== 'undefined';
  const sfx = n => { try { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); } catch (_) {} };
  const note = (m, k) => { try { if (ctx && ctx.notify) ctx.notify(m, k); } catch (_) {} };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  // a human voice label from a persona id (the chip used to show the raw slug); safe fallback to the id.
  function voiceName(personaId) {
    return (typeof Personas !== 'undefined' && Personas.get(personaId) && Personas.get(personaId).name) || personaId;
  }

  /* ---------- open / close ---------- */
  function open(context) {
    if (!has()) return;
    const trigger = (typeof document !== 'undefined' && document.activeElement) || null;
    close();                                    // tear down any prior instance first…
    opener = trigger;                           // …then remember who opened us (close() cleared it)
    ctx = context || {};
    view = 'grid'; editingId = null; editingRecipeId = null; launchId = null; pendingMintKey = null; pendingMintTemplate = null;
    // start on the requested tab (deploy mode only — pick mode at wake has no recipes to launch)
    tab = (ctx.mode !== 'pick' && ctx.tab === 'recipes' && hasRecipes()) ? 'recipes' : 'agents';
    glassOpen = !acked();                        // first run: open the glass box so the consent note is seen once
    root = el('div', 'mkt-scrim');
    root.innerHTML =
      '<div class="mkt" role="dialog" aria-modal="true" aria-labelledby="mkt-title" aria-describedby="mkt-sub" tabindex="-1">' +
        '<div class="mkt-head">' +
          '<span class="mkt-title" id="mkt-title">▮ RECRUITMENT BAY</span>' +
          '<span class="mkt-sub" id="mkt-sub">' + esc(subtitle()) + '</span>' +
          '<button class="mkt-x" aria-label="Close recruitment bay" title="close">✕</button>' +
        '</div>' +
        '<div class="mkt-body scrolly"></div>' +
      '</div>';
    document.body.appendChild(root);
    // scrim click (outside the panel) closes; panel clicks do not bubble out
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });
    root.querySelector('.mkt-x').addEventListener('click', () => { sfx('close'); close(); });
    document.addEventListener('keydown', onKey, true);   // capture, so the Tab-trap beats default tab order
    sfx('open');
    render();
    const panel = root.querySelector('.mkt'); if (panel) panel.focus();   // move focus into the dialog (announces it)
  }
  function close() {
    if (!root) return;
    document.removeEventListener('keydown', onKey, true);
    root.remove(); root = null; ctx = null; view = 'grid'; editingId = null; editingRecipeId = null; launchId = null; pendingMintKey = null; pendingMintTemplate = null;
    const o = opener; opener = null;
    try { if (o && o.focus) o.focus(); } catch (_) {}   // restore focus to whatever opened the bay
  }
  function focusables() {
    if (!root) return [];
    return Array.from(root.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(e => e.offsetWidth > 0 || e.offsetHeight > 0 || e === document.activeElement);
  }
  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { sfx('close'); close(); return; }
    if (e.key === 'Tab') {                               // focus trap — Tab never escapes the modal
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
      ? 'launch a ready-made mission — ' + who + ' picks it up in a fresh workstream'
      : 'deploy a specialty onto ' + who + ' — or save this one as a template';
  }

  /* ---------- render ---------- */
  function render() {
    if (!root) return;
    const body = root.querySelector('.mkt-body');
    const sub = root.querySelector('#mkt-sub'); if (sub) sub.textContent = subtitle();   // keep the header line tab-aware
    body.innerHTML = view === 'save' ? saveFormHTML()
      : view === 'recipesave' ? recipeSaveFormHTML()
      : view === 'launch' ? launchFormHTML()
      : gridHTML();
    if (view === 'save') wireSaveForm(body);
    else if (view === 'recipesave') wireRecipeSaveForm(body);
    else if (view === 'launch') wireLaunchForm(body);
    else {
      wireGrid(body);
      // a re-render (delete / view switch) can orphan focus on a removed node — keep it inside the dialog
      if (!root.contains(document.activeElement)) { const p = root.querySelector('.mkt'); if (p) p.focus(); }
    }
  }

  // the two-tab head: AGENTS (specialties) | RECIPES (missions). Deploy mode only — at wake (pick mode) the
  // bay is specialties-only, and if the Recipe library module didn't load we silently degrade to agents-only.
  function tabsHTML() {
    if (ctx && ctx.mode === 'pick') return '';
    if (!hasRecipes()) return '';
    const t = (id, label) => '<button class="mkt-tab' + (tab === id ? ' on' : '') + '" role="tab" aria-selected="' +
      (tab === id ? 'true' : 'false') + '" data-tab="' + id + '">' + label + '</button>';
    return '<div class="mkt-tabs" role="tablist">' + t('agents', '☰ AGENTS') + t('recipes', '❒ RECIPES') + '</div>';
  }

  function gridHTML() {
    const deploy = !ctx || ctx.mode !== 'pick';
    let html = tabsHTML();
    html += glassHTML();        // "STATION FAMILIARITY" — the shared glass box of what the station has learned (deploy mode, both tabs)
    html += (deploy && tab === 'recipes') ? recipesPaneHTML() : agentsPaneHTML(deploy);
    return html;
  }

  // the AGENTS tab — the specialty catalog (the bay's original content) + its affinity-ranked shelf
  function agentsPaneHTML(deploy) {
    const toolbar = deploy
      ? '<div class="mkt-toolbar">' +
          '<button class="bb sm mkt-saveas">＋ SAVE THIS AGENT AS A SPECIALTY</button>' +
          '<label class="mkt-adopt"><input type="checkbox" class="mkt-adopt-cb"> adopt its voice too</label>' +
          '<span class="mkt-hint">deploy re-specs ' + esc((ctx && ctx.agentName) || 'your agent') + '’s purpose &amp; standing orders</span>' +
        '</div>'
      : '<div class="mkt-toolbar"><span class="mkt-hint">picking one pre-fills the wake screen — name, voice &amp; mission, ready to tweak</span></div>';
    const builtins = Specialties.builtins();
    const customs = Specialties.customs();
    let html = toolbar;
    html += recShelfHTML();     // "RECOMMENDED FOR YOU" — the affinity-ranked shelf, pinned above the full catalog
    html += '<div class="mkt-sect-h">▮ CATALOG</div>';
    html += '<div class="mkt-grid">' + builtins.map(cardHTML).join('') + '</div>';
    html += '<div class="mkt-sect-h">▮ YOUR SPECIALISTS</div>';
    html += customs.length
      ? '<div class="mkt-grid">' + customs.map(cardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no saved specialists yet — ' + (deploy ? 'hit “＋ save this agent as a specialty” above' : 'save an agent as a specialty in-game') + ' to grow your own roster.</div>';
    return html;
  }

  // the RECIPES tab — the Mission Library: ready-made parameterized jobs you launch into a fresh workstream
  function recipesPaneHTML() {
    if (!hasRecipes()) return '<div class="mkt-empty">the recipe library isn’t available.</div>';
    const builtins = Recipes.builtins();
    const customs = Recipes.customs();
    let html = '<div class="mkt-toolbar">' +
      '<button class="bb sm mkt-recipe-saveas">＋ SAVE A MISSION</button>' +
      '<span class="mkt-hint">pick a mission, fill in the blanks, and ' +
        esc((ctx && ctx.agentName) || 'your agent') + ' runs it in a fresh workstream</span>' +
    '</div>';
    html += suggestedShelfHTML();   // "✨ SUGGESTED" — auto-mint: recurring jobs the station noticed you doing
    html += recipeRecShelfHTML();   // "RECOMMENDED FOR YOU" — recipes ranked by the same affinity engine
    html += '<div class="mkt-sect-h">▮ MISSION LIBRARY</div>';
    html += '<div class="mkt-grid">' + builtins.map(recipeCardHTML).join('') + '</div>';
    html += '<div class="mkt-sect-h">▮ YOUR MISSIONS</div>';
    html += customs.length
      ? '<div class="mkt-grid">' + customs.map(recipeCardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no saved missions yet — hit “＋ save a mission” above to turn a job you do often into a one-tap mission you own (and that exports with you).</div>';
    return html;
  }

  // one recipe card: emoji/name/tagline, blurb, a collapsed preview of the directive + its inputs, and LAUNCH.
  function recipeCardHTML(r) {
    const isOpen = !!expanded[r.id];
    const nParams = (r.params || []).length;
    const setupChip = '<span class="mkt-chip" title="inputs this mission asks for">' +
      (nParams ? ('▤ ' + nParams + ' input' + (nParams === 1 ? '' : 's')) : '◷ no setup') + '</span>';
    const paramList = nParams
      ? '<div class="mkt-prev-h">INPUTS</div><ul class="mkt-starters">' +
          r.params.map(p => '<li>' + esc(p.label) + (p.required ? '' : ' <i>(optional)</i>') + '</li>').join('') + '</ul>'
      : '';
    const preview =
      '<div class="mkt-prevbox">' +
        '<div class="mkt-prev-h">WHAT IT SENDS</div><pre class="mkt-prev-pre">' + esc(r.task) + '</pre>' +
        paramList +
      '</div>';
    const launchLabel = nParams ? '▸ SET UP &amp; LAUNCH' : '▸ LAUNCH';
    return '<div class="mkt-card' + (isOpen ? ' open' : '') + '" data-id="' + esc(r.id) + '" style="--accent:' + esc(r.accent) + '">' +
      '<div class="mkt-card-top">' +
        '<span class="mkt-emoji" aria-hidden="true">' + esc(r.emoji) + '</span>' +
        '<div class="mkt-card-id">' +
          '<div class="mkt-name">' + esc(r.name) + (r.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
          '<div class="mkt-tag">' + esc(r.tagline) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mkt-blurb">' + esc(r.blurb || r.tagline) + '</div>' +
      '<div class="mkt-chips">' + setupChip + '</div>' +
      preview +
      '<div class="mkt-card-acts">' +
        '<button class="bb sm mkt-prev" data-id="' + esc(r.id) + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' + (isOpen ? '▾ HIDE' : '▸ PREVIEW') + '</button>' +
        (r.custom ? '<button class="bb sm mkt-recipe-edit" data-id="' + esc(r.id) + '" aria-label="Edit saved mission ' + esc(r.name) + '" title="edit">✎</button>' : '') +
        (r.custom ? '<button class="bb sm danger mkt-recipe-del" data-id="' + esc(r.id) + '" aria-label="Delete saved mission ' + esc(r.name) + '" title="delete">⌫</button>' : '') +
        '<button class="bb sm mkt-launch" data-id="' + esc(r.id) + '">' + launchLabel + '</button>' +
      '</div>' +
    '</div>';
  }

  function cardHTML(s) {
    const deploy = !ctx || ctx.mode !== 'pick';
    const here = deploy && ctx && ctx.currentSpecialtyId && ctx.currentSpecialtyId === s.id;   // already deployed on this agent
    const primaryLabel = deploy ? ('▸ DEPLOY TO ' + esc(((ctx && ctx.agentName) || 'AGENT')).toUpperCase()) : '▸ RECRUIT';
    const isOpen = !!expanded[s.id];
    const chips =
      '<span class="mkt-chip" title="recommended voice">◈ ' + esc(voiceName(s.persona)) + '</span>' +
      '<span class="mkt-chip" title="' + esc(Specialties.tierNote(s)) + '">⚙ ' + esc(s.model) + ' model</span>';
    // the preview box is always emitted (collapsed via CSS) so it can animate open without a re-render
    const preview =
      '<div class="mkt-prevbox">' +
        '<div class="mkt-prev-h">PURPOSE</div><p class="mkt-prev-p">' + esc(s.purpose) + '</p>' +
        '<div class="mkt-prev-h">STANDING ORDERS</div><pre class="mkt-prev-pre">' + esc(s.manual) + '</pre>' +
        (s.starters && s.starters.length
          ? '<div class="mkt-prev-h">TRY ASKING</div><ul class="mkt-starters">' + s.starters.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul>'
          : '') +
      '</div>';
    return '<div class="mkt-card' + (isOpen ? ' open' : '') + '" data-id="' + esc(s.id) + '" style="--accent:' + esc(s.accent) + '">' +
      '<div class="mkt-card-top">' +
        '<span class="mkt-emoji" aria-hidden="true">' + esc(s.emoji) + '</span>' +
        '<div class="mkt-card-id">' +
          '<div class="mkt-name">' + esc(s.name) +
            (here ? ' <span class="mkt-badge mkt-here">DEPLOYED</span>' : '') +
            (s.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
          '<div class="mkt-tag">' + esc(s.tagline) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mkt-blurb">' + esc(s.blurb || s.tagline) + '</div>' +
      '<div class="mkt-chips">' + chips + '</div>' +
      preview +
      '<div class="mkt-card-acts">' +
        '<button class="bb sm mkt-prev" data-id="' + esc(s.id) + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' + (isOpen ? '▾ HIDE' : '▸ PREVIEW') + '</button>' +
        (s.custom ? '<button class="bb sm mkt-edit" data-id="' + esc(s.id) + '" aria-label="Edit saved specialty ' + esc(s.name) + '" title="rename / re-icon">✎</button>' : '') +
        (s.custom ? '<button class="bb sm danger mkt-del" data-id="' + esc(s.id) + '" aria-label="Delete saved specialty ' + esc(s.name) + '" title="delete">⌫</button>' : '') +
        '<button class="bb sm mkt-primary" data-id="' + esc(s.id) + '">' + primaryLabel + '</button>' +
      '</div>' +
    '</div>';
  }

  /* ---------- the glass box: "STATION FAMILIARITY" (what the station has learned about the Commander) ----------
     Renders only in deploy mode (the profile is the Commander's, not an agent's) and only once ProfileStore is
     live. Honest by construction: CALIBRATING until the sample floor, every lane shown with its real weight, a
     plain local-first promise, and one-tap PAUSE / FORGET — the consent surface, co-located with the picks it powers. */
  function glassHTML() {
    if (ctx && ctx.mode === 'pick') return '';
    const ps = profileApi(); if (!ps) return '';
    const summ = ps.summary(); if (!summ) return '';            // ProfileStore not initialized yet → stay silent
    const on = ps.enabled ? ps.enabled() : true;
    const pct = Math.round((summ.familiarity || 0) * 100);
    const meter = !on ? 'PAUSED' : (summ.calibrating ? 'CALIBRATING' : pct + '%');
    const dom = summ.dominant ? (TAG_LABEL[summ.dominant] || summ.dominant) : '—';
    const note = !on ? 'learning paused — nothing new is being folded in'
      : summ.dominant ? ('leaning ' + dom.toLowerCase() + ' · ' + summ.samples + ' signal' + (summ.samples === 1 ? '' : 's') + ' so far')
      : 'still getting to know you — set an agent to work and I’ll learn what you focus on';

    const head =
      '<button class="mkt-fam-head" aria-expanded="' + (glassOpen ? 'true' : 'false') + '">' +
        '<span class="mkt-fam-ico" aria-hidden="true">◉</span>' +
        '<span class="mkt-fam-ttl">STATION FAMILIARITY</span>' +
        '<span class="mkt-fam-meter ' + (on && !summ.calibrating ? 'known' : 'cal') + '">' + meter + '</span>' +
        '<span class="mkt-fam-note">' + esc(note) + '</span>' +
        '<span class="mkt-fam-caret" aria-hidden="true">' + (glassOpen ? '▾' : '▸') + '</span>' +
      '</button>';
    if (!glassOpen) return '<div class="mkt-fam' + (on ? '' : ' paused') + '">' + head + '</div>';

    const bars = FAM_TAGS.map(k => {
      const v = Math.round((summ.affinity[k] || 0) * 100);
      return '<div class="mkt-fam-bar">' +
        '<span class="mkt-fam-k">' + TAG_LABEL[k] + '</span>' +
        '<span class="mkt-fam-trk"><span class="mkt-fam-fill" style="width:' + v + '%;"></span></span>' +
        '<span class="mkt-fam-v">' + v + '%</span></div>';
    }).join('');
    const consent = !acked()
      ? '<div class="mkt-fam-consent">STARNET learns what you work on to tailor these picks — <b>locally, on this machine, 0 bytes sent.</b> ' +
        'Pause or wipe it anytime, right here. <button class="bb sm mkt-fam-ack">GOT IT</button></div>'
      : '';
    const acts =
      '<div class="mkt-fam-acts">' +
        '<span class="mkt-fam-priv">◇ local-first · your profile never leaves this machine</span>' +
        '<button class="bb sm mkt-fam-pause">' + (on ? '❚❚ PAUSE LEARNING' : '▸ RESUME LEARNING') + '</button>' +
        '<button class="bb sm danger mkt-fam-forget">⌫ FORGET</button>' +
      '</div>';
    return '<div class="mkt-fam open' + (on ? '' : ' paused') + '">' + head +
      '<div class="mkt-fam-body">' + consent + '<div class="mkt-fam-bars">' + bars + '</div>' + acts + '</div></div>';
  }

  /* ---------- the recommender: rank a catalog by the Commander's affinity, top 3 above the fold ----------
     The engine (Profile.score/explain) is item-type-agnostic — it only needs each item's `tags` weight map —
     so the SAME ranker drives the AGENTS shelf (specialties) and the RECIPES shelf (missions). Returns null
     (no shelf) unless there's a profile, a dominant signal, and learning is on — a shelf only shows when earned. */
  function rankItems(items, excludeId) {
    const ps = profileApi(); if (!ps) return null;
    const summ = ps.summary(); if (!summ || !summ.dominant) return null;   // no signal (or seed) yet → no shelf
    if (ps.enabled && !ps.enabled()) return null;                          // paused → don't push picks
    const ranked = (items || [])
      .map((it, idx) => ({ it, idx, score: ps.score(it.tags || {}) }))
      .filter(r => r.it.id !== excludeId && r.score > 0)                   // skip the excluded id (e.g. already-deployed)
      .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))             // score desc, catalog order as a stable tiebreak
      .slice(0, 3);
    return ranked.length ? ranked.map(r => r.it) : null;
  }
  function recommended() {
    if (ctx && ctx.mode === 'pick') return null;
    return rankItems(Specialties.builtins(), ctx && ctx.currentSpecialtyId);   // skip what's already deployed
  }
  function recommendedRecipes() {
    if (!hasRecipes()) return null;
    return rankItems(Recipes.builtins(), null);                            // recipes aren't "deployed" — nothing to exclude
  }
  // the honest because-line for an item: the tag that actually dominated its score (or '' if nothing did).
  function becauseText(s) {
    const ps = profileApi(); if (!ps || !ps.explain) return '';
    const t = ps.explain(s.tags || {});
    return t ? (BECAUSE[t] || '') : '';
  }
  function recShelfHTML() {
    const items = recommended(); if (!items) return '';
    return '<div class="mkt-sect-h mkt-rec-sect">★ RECOMMENDED FOR YOU</div>' +
      '<div class="mkt-rec-rail">' + items.map(recCardHTML).join('') + '</div>';
  }
  function recipeRecShelfHTML() {
    const items = recommendedRecipes(); if (!items) return '';
    return '<div class="mkt-sect-h mkt-rec-sect">★ RECOMMENDED FOR YOU</div>' +
      '<div class="mkt-rec-rail">' + items.map(recipeRecCardHTML).join('') + '</div>';
  }

  /* ---------- auto-mint: "✨ SUGGESTED" — recurring jobs the station noticed, proposed as missions ----------
     PROPOSE-AND-CONFIRM only: each card shows the induced template + how often you've asked it; REVIEW opens the
     authoring form pre-filled (you confirm/edit/name it), DISMISS silences it. Suppressed when learning is paused. */
  function suggestedMissions() {
    const mp = mintApi(); if (!mp) return [];
    const ps = profileApi();
    if (ps && ps.enabled && !ps.enabled()) return [];   // the glass-box PAUSE governs the shelf too — single switch
    if (mp.enabled && !mp.enabled()) return [];          // and mint's own flag (belt-and-suspenders vs a skew)
    return mp.candidates() || [];
  }
  function suggestedShelfHTML() {
    const cands = suggestedMissions(); if (!cands.length) return '';
    return '<div class="mkt-sect-h mkt-suggest-sect">✨ SUGGESTED — from what you keep asking</div>' +
      '<div class="mkt-rec-rail">' + cands.map(suggestCardHTML).join('') + '</div>';
  }
  function suggestCardHTML(c) {
    return '<div class="mkt-rec mkt-suggest" data-key="' + esc(c.key) + '">' +
      '<div class="mkt-rec-top">' +
        '<span class="mkt-rec-emoji mkt-suggest-spark" aria-hidden="true">✨</span>' +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(c.template) + '</div>' +
          '<div class="mkt-rec-tag">you’ve asked this ' + c.count + ' times</div></div>' +
      '</div>' +
      '<div class="mkt-suggest-acts">' +
        '<button class="bb sm mkt-suggest-review" data-key="' + esc(c.key) + '">▸ REVIEW &amp; SAVE</button>' +
        '<button class="bb sm mkt-suggest-dismiss" data-key="' + esc(c.key) + '" aria-label="dismiss this suggestion" title="not a mission">✕</button>' +
      '</div>' +
    '</div>';
  }
  function recipeRecCardHTML(r) {
    const why = becauseText(r);
    return '<div class="mkt-rec" style="--accent:' + esc(r.accent) + '">' +
      '<div class="mkt-rec-top">' +
        '<span class="mkt-rec-emoji" aria-hidden="true">' + esc(r.emoji) + '</span>' +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(r.name) + '</div>' +
          '<div class="mkt-rec-tag">' + esc(r.tagline) + '</div></div>' +
      '</div>' +
      (why ? '<div class="mkt-rec-why"><span class="mkt-rec-why-k">WHY</span> ' + esc(why) + '</div>' : '') +
      '<button class="bb sm mkt-launch mkt-rec-go" data-id="' + esc(r.id) + '">' + ((r.params || []).length ? '▸ SET UP' : '▸ LAUNCH') + '</button>' +
    '</div>';
  }
  function recCardHTML(s) {
    const deploy = !ctx || ctx.mode !== 'pick';
    const why = becauseText(s);
    return '<div class="mkt-rec" style="--accent:' + esc(s.accent) + '">' +
      '<div class="mkt-rec-top">' +
        '<span class="mkt-rec-emoji" aria-hidden="true">' + esc(s.emoji) + '</span>' +
        '<div class="mkt-rec-id"><div class="mkt-rec-name">' + esc(s.name) + '</div>' +
          '<div class="mkt-rec-tag">' + esc(s.tagline) + '</div></div>' +
      '</div>' +
      (why ? '<div class="mkt-rec-why"><span class="mkt-rec-why-k">WHY</span> ' + esc(why) + '</div>' : '') +
      '<button class="bb sm mkt-primary mkt-rec-go" data-id="' + esc(s.id) + '">' + (deploy ? '▸ DEPLOY' : '▸ RECRUIT') + '</button>' +
    '</div>';
  }

  function wireGrid(body) {
    const saveas = body.querySelector('.mkt-saveas');
    if (saveas) saveas.addEventListener('click', () => { sfx('click'); view = 'save'; editingId = null; render(); });

    // PREVIEW toggles IN PLACE (no full re-render) so it animates and keeps keyboard focus on the button
    body.querySelectorAll('.mkt-prev').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.id, card = b.closest('.mkt-card');
      const nowOpen = !expanded[id]; expanded[id] = nowOpen;
      if (card) card.classList.toggle('open', nowOpen);
      b.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      b.textContent = nowOpen ? '▾ HIDE' : '▸ PREVIEW';
      sfx('click');
    }));

    // EDIT a saved custom — load it into the save form (metadata: name / icon / tagline)
    body.querySelectorAll('.mkt-edit').forEach(b => b.addEventListener('click', () => {
      editingId = b.dataset.id; sfx('click'); view = 'save'; render();
    }));

    // DELETE a saved custom — themed two-step arm/confirm (the app's idiom), never a native dialog
    body.querySelectorAll('.mkt-del').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.id;
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1'; b.classList.add('armed'); b.textContent = 'SURE?'; sfx('bad');
        setTimeout(() => { if (b.isConnected) { b.dataset.armed = '0'; b.classList.remove('armed'); b.textContent = '⌫'; } }, 4000);
        return;
      }
      const s = Specialties.get(id);
      Specialties.removeCustom(id); delete expanded[id];
      sfx('close'); note('removed specialty: ' + ((s && s.name) || id), 'good'); render();
    }));

    body.querySelectorAll('.mkt-primary').forEach(b => b.addEventListener('click', () => {
      const s = Specialties.get(b.dataset.id);
      if (!s) return;
      sfx('click');
      if (ctx && ctx.mode === 'pick') { if (ctx.onPick) ctx.onPick(s); close(); }
      else {
        const cb = root && root.querySelector('.mkt-adopt-cb');
        const adoptVoice = !!(cb && cb.checked);
        if (ctx && ctx.onDeploy) ctx.onDeploy(s, { adoptVoice });
        note(s.name + ' deployed to ' + ((ctx && ctx.agentName) || 'your agent') + (adoptVoice ? ' (+ voice)' : ''), 'good');
        close();
      }
    }));

    // TAB switch: AGENTS ⇄ RECIPES (deploy mode). Drop any open sub-view; the glass box state carries over.
    body.querySelectorAll('.mkt-tab').forEach(b => b.addEventListener('click', () => {
      const next = b.dataset.tab;
      if (!next || next === tab) return;
      tab = next; view = 'grid'; editingId = null; editingRecipeId = null; launchId = null; pendingMintKey = null; pendingMintTemplate = null; sfx('click'); render();
    }));

    // LAUNCH a recipe: if it asks for inputs, step into the param form; otherwise fire it straight off.
    body.querySelectorAll('.mkt-launch').forEach(b => b.addEventListener('click', () => {
      if (!hasRecipes()) return;
      const r = Recipes.get(b.dataset.id); if (!r) return;
      sfx('click');
      if (r.params && r.params.length) { launchId = r.id; view = 'launch'; render(); }
      else launchRecipeNow(r, {});
    }));

    // AUTHOR a mission: open the recipe save form (＋ SAVE A MISSION) or edit an existing custom mission.
    const recipeSaveas = body.querySelector('.mkt-recipe-saveas');
    if (recipeSaveas) recipeSaveas.addEventListener('click', () => { sfx('click'); view = 'recipesave'; editingRecipeId = null; pendingMintKey = null; pendingMintTemplate = null; render(); });
    body.querySelectorAll('.mkt-recipe-edit').forEach(b => b.addEventListener('click', () => {
      editingRecipeId = b.dataset.id; pendingMintKey = null; pendingMintTemplate = null; sfx('click'); view = 'recipesave'; render();
    }));

    // AUTO-MINT proposals: REVIEW opens the authoring form pre-filled with the suggested template (propose-and-
    // confirm — saving marks the shape minted); the ✕ DISMISS silences a shape so it's never proposed again.
    body.querySelectorAll('.mkt-suggest-review').forEach(b => b.addEventListener('click', () => {
      const cands = suggestedMissions();
      const c = cands.find(x => x.key === b.dataset.key);
      if (!c) { render(); return; }
      pendingMintKey = c.key; pendingMintTemplate = c.template; editingRecipeId = null;
      sfx('click'); view = 'recipesave'; render();
    }));
    body.querySelectorAll('.mkt-suggest-dismiss').forEach(b => b.addEventListener('click', () => {
      if (mintApi()) MintStore.markDismissed(b.dataset.key);
      sfx('close'); render();
    }));
    // DELETE a saved mission — themed two-step arm/confirm (the bay's idiom), never a native dialog
    body.querySelectorAll('.mkt-recipe-del').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.id;
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1'; b.classList.add('armed'); b.textContent = 'SURE?'; sfx('bad');
        setTimeout(() => { if (b.isConnected) { b.dataset.armed = '0'; b.classList.remove('armed'); b.textContent = '⌫'; } }, 4000);
        return;
      }
      const r = hasRecipes() ? Recipes.get(id) : null;
      if (hasRecipes()) Recipes.removeCustom(id);
      delete expanded[id];
      sfx('close'); note('removed mission: ' + ((r && r.name) || id), 'good'); render();
    }));

    /* ---- the glass box: expand/collapse, first-run consent, pause, forget ---- */
    const famHead = body.querySelector('.mkt-fam-head');
    if (famHead) famHead.addEventListener('click', () => { glassOpen = !glassOpen; sfx('click'); render(); });

    const famAck = body.querySelector('.mkt-fam-ack');
    if (famAck) famAck.addEventListener('click', e => { e.stopPropagation(); setAcked(); sfx('click'); render(); });

    const famPause = body.querySelector('.mkt-fam-pause');
    if (famPause) famPause.addEventListener('click', () => {
      const ps = profileApi(); if (!ps || !ps.setEnabled) return;
      const on = ps.enabled ? ps.enabled() : true;
      ps.setEnabled(!on);
      if (mintApi() && MintStore.setEnabled) MintStore.setEnabled(!on);   // one pause governs ALL learning (profile + auto-mint)
      sfx(on ? 'bad' : 'click');
      if (on) note('learning paused — nothing new will be folded in');
      else note('learning resumed', 'good');
      render();
    });

    const famForget = body.querySelector('.mkt-fam-forget');
    if (famForget) famForget.addEventListener('click', () => {
      if (famForget.dataset.armed !== '1') {          // themed two-step arm/confirm (the bay's idiom)
        famForget.dataset.armed = '1'; famForget.classList.add('armed'); famForget.textContent = 'SURE? WIPE'; sfx('bad');
        setTimeout(() => { if (famForget.isConnected) { famForget.dataset.armed = '0'; famForget.classList.remove('armed'); famForget.textContent = '⌫ FORGET'; } }, 4000);
        return;
      }
      const ps = profileApi(); if (ps && ps.forget) ps.forget();
      if (mintApi() && MintStore.forget) MintStore.forget();   // FORGET clears the recurring-job memory too
      sfx('close'); note('profile wiped — the station forgot what it learned', 'good'); render();
    });
  }

  /* ---------- launch a recipe (fill its params, then hand it to the app) ----------
     Handing back is a single ctx.onLaunch(recipe, values) — the app mints a workstream and Chat.send()s the
     filled directive (the recipe analogue of onDeploy). The bay never touches Workstreams/Chat itself. */
  function launchRecipeNow(r, values) {
    // the app's onLaunch returns false on a no-op (no agent / empty directive); only claim success + close if it
    // actually fired. A missing onLaunch (e.g. a synthetic context) is treated as success so the bay still closes.
    const ok = !ctx || !ctx.onLaunch || ctx.onLaunch(r, values) !== false;
    if (ok) {
      note('mission launched: ' + r.name + ' — ' + ((ctx && ctx.agentName) || 'your agent') + ' is on it', 'good');
      close();
    } else { sfx('bad'); note('could not launch ' + r.name + ' — nothing to send', 'bad'); }
  }
  function launchFormHTML() {
    const r = launchId && hasRecipes() ? Recipes.get(launchId) : null;
    if (!r) return gridHTML();   // recipe vanished mid-flight → fall back to the grid (defensive)
    const who = (ctx && ctx.agentName) || 'your agent';
    const fields = (r.params || []).map(p =>
      '<label class="mkt-lbl">' + esc(p.label) +
        (p.required ? ' <span class="mkt-req" title="required">*</span>' : ' <span class="mkt-opt">(optional)</span>') +
        '<textarea class="mkt-in mkt-p-in" data-key="' + esc(p.key) + '" rows="2" placeholder="' + esc(p.placeholder || '') + '"></textarea>' +
      '</label>').join('');
    return '<div class="mkt-save mkt-launch-form">' +
      '<div class="mkt-save-h">' + esc('▸ LAUNCH — ' + r.name) + '</div>' +
      '<p class="mkt-hint">' + esc(r.blurb || r.tagline) + '</p>' +
      (fields || '<p class="mkt-hint">this mission needs no setup — just launch it.</p>') +
      '<p class="mkt-hint mkt-launch-note">▸ opens a fresh workstream and sets <b>' + esc(who) + '</b> to work on it.</p>' +
      '<div class="mkt-save-acts">' +
        '<button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-do-launch">▸ LAUNCH MISSION</button>' +
      '</div>' +
    '</div>';
  }
  function wireLaunchForm(body) {
    const back = body.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); view = 'grid'; launchId = null; render(); });
    // clear the error highlight as soon as the Commander starts typing in a flagged field
    body.querySelectorAll('.mkt-p-in').forEach(inp => inp.addEventListener('input', () => inp.classList.remove('mkt-bad')));
    const go = body.querySelector('.mkt-do-launch');
    if (go) go.addEventListener('click', () => {
      const r = launchId && hasRecipes() ? Recipes.get(launchId) : null;
      if (!r) { view = 'grid'; launchId = null; render(); return; }
      const values = {};
      body.querySelectorAll('.mkt-p-in').forEach(inp => { values[inp.dataset.key] = inp.value; });
      const missing = Recipes.requiredMissing(r, values);
      if (missing.length) {
        sfx('bad');
        missing.forEach(k => { const f = body.querySelector('.mkt-p-in[data-key="' + k + '"]'); if (f) f.classList.add('mkt-bad'); });
        const f0 = body.querySelector('.mkt-p-in[data-key="' + missing[0] + '"]'); if (f0) f0.focus();
        note('fill in: ' + missing.join(', '), 'bad');
        return;
      }
      launchId = null;
      launchRecipeNow(r, values);
    });
    const first = body.querySelector('.mkt-p-in'); if (first) first.focus();
  }

  /* ---------- author / edit a mission (a custom recipe) ----------
     The Commander writes a directive TEMPLATE with {tokens}; each distinct token auto-becomes a fill-in at launch
     (the template IS the spec — no separate param editor). This is the owned, exportable library the moat compounds
     into: saved under skynet.recipes.v1, which backup.js already carries by prefix, so a mission travels with you. */
  function recipeTokenHint(task) {
    if (!hasRecipes()) return '';
    const ps = Recipes.paramsFromTemplate(task);
    if (!ps.length) return '<span class="mkt-r-tok-none">◷ one-tap mission — no fill-ins</span>';
    return '<span class="mkt-r-tok-lbl">asks for</span> ' + ps.map(p => '<span class="mkt-r-tok">' + esc(p.label) + '</span>').join(' ');
  }
  function recipeSaveFormHTML() {
    const editing = editingRecipeId && hasRecipes() ? Recipes.get(editingRecipeId) : null;
    // minting a SUGGESTED recurring job → pre-fill the form with the proposed template + a suggested name
    const minting = !editing && !!pendingMintTemplate;
    const d = editing || (minting
      ? { emoji: '✦', name: pendingMintTemplate.replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 28), tagline: '', task: pendingMintTemplate }
      : { emoji: '✦', name: '', tagline: '', task: '' });
    const title = editing ? 'EDIT MISSION' : minting ? 'SAVE THIS AS A MISSION' : 'SAVE A MISSION';
    const intro = minting
      ? 'you’ve done this a few times — saving it makes it a one-tap mission you own. Tweak the wording, wrap any blanks in <b>{braces}</b>, then save.'
      : 'write the directive your agent should run. Wrap each blank in <b>{braces}</b> — “Brief me on <b>{topic}</b>” — and it becomes a fill-in at launch.';
    return '<div class="mkt-save mkt-recipe-form">' +
      '<div class="mkt-save-h">' + esc(title) + '</div>' +
      '<p class="mkt-hint">' + intro + '</p>' +
      '<div class="mkt-save-row">' +
        '<label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-r-emoji" maxlength="2" value="' + esc(d.emoji || '✦') + '"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-r-name" maxlength="28" value="' + esc(d.name || '') + '" placeholder="e.g. Morning Standup"></label>' +
      '</div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-r-tag" maxlength="48" value="' + esc(d.tagline || '') + '" placeholder="one line — what it’s for"></label>' +
      '<label class="mkt-lbl">DIRECTIVE TEMPLATE<textarea class="mkt-in mkt-r-task" id="mkt-r-task" rows="4" placeholder="e.g. Summarize {project} progress since {since} and flag blockers.">' + esc(d.task || '') + '</textarea></label>' +
      '<div class="mkt-r-tokens" id="mkt-r-tokens"></div>' +
      '<div class="mkt-save-acts">' +
        '<button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-do-recipe-save">' + (editing ? '✓ SAVE CHANGES' : '✓ SAVE MISSION') + '</button>' +
      '</div>' +
    '</div>';
  }
  function wireRecipeSaveForm(body) {
    const back = body.querySelector('.mkt-cancel');
    if (back) back.addEventListener('click', () => { sfx('click'); view = 'grid'; editingRecipeId = null; pendingMintKey = null; pendingMintTemplate = null; render(); });
    // live readout of the fill-ins the template will ask for (the inputs are derived from its {tokens})
    const taskIn = body.querySelector('#mkt-r-task'), tokens = body.querySelector('#mkt-r-tokens');
    const paint = () => { if (tokens && taskIn) tokens.innerHTML = recipeTokenHint(taskIn.value); };
    if (taskIn) taskIn.addEventListener('input', paint);
    paint();
    const save = body.querySelector('.mkt-do-recipe-save');
    if (save) save.addEventListener('click', () => {
      const editing = editingRecipeId && hasRecipes() ? Recipes.get(editingRecipeId) : null;
      const name = (body.querySelector('#mkt-r-name').value || '').trim();
      const task = (body.querySelector('#mkt-r-task').value || '').trim();
      if (!name) { sfx('bad'); note('give your mission a name', 'bad'); body.querySelector('#mkt-r-name').focus(); return; }
      if (!task) { sfx('bad'); note('write the directive your agent should run', 'bad'); body.querySelector('#mkt-r-task').focus(); return; }
      const rec = {
        name,
        emoji: (body.querySelector('#mkt-r-emoji').value || '✦').trim() || '✦',
        tagline: (body.querySelector('#mkt-r-tag').value || '').trim(),
        task
      };
      if (editing) rec.id = editing.id;   // upsert in place (saveCustom keeps the existing custom id)
      try {
        const saved = Recipes.saveCustom(rec);   // params auto-derive from the template's {tokens}
        if (pendingMintKey && mintApi()) MintStore.markMinted(pendingMintKey);   // this suggestion is now a saved mission — stop proposing it
        pendingMintKey = null; pendingMintTemplate = null;
        sfx('click'); note((editing ? 'updated' : 'saved') + ' mission: ' + saved.name, 'good');
        editingRecipeId = null; view = 'grid'; render();
      } catch (e) { sfx('bad'); note((e && e.message) || 'could not save', 'bad'); }
    });
    const nameIn = body.querySelector('#mkt-r-name');
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
      '<div class="mkt-save-row">' +
        '<label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-f-emoji" maxlength="2" value="' + esc(d.emoji || '✦') + '"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-f-name" maxlength="28" value="' + esc(d.name || '') + '" placeholder="e.g. Night-Shift Researcher"></label>' +
      '</div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-f-tag" maxlength="48" value="' + esc(d.tagline || '') + '" placeholder="one line — what it’s for"></label>' +
      '<div class="mkt-save-acts">' +
        '<button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-do-save' + ctaCls + '">' + ctaText + '</button>' +
      '</div>' +
    '</div>';
  }
  function wireSaveForm(body) {
    body.querySelector('.mkt-cancel').addEventListener('click', () => { sfx('click'); view = 'grid'; editingId = null; render(); });
    body.querySelector('.mkt-do-save').addEventListener('click', () => {
      const editing = editingId ? Specialties.get(editingId) : null;
      const base = editing || (ctx && ctx.draftFromAgent && ctx.draftFromAgent()) || {};
      const name = (body.querySelector('#mkt-f-name').value || '').trim();
      if (!name) { sfx('bad'); note('give your specialty a name', 'bad'); return; }
      const spec = Object.assign({}, base, {
        name,
        emoji: (body.querySelector('#mkt-f-emoji').value || '✦').trim() || '✦',
        tagline: (body.querySelector('#mkt-f-tag').value || '').trim()
      });
      if (editing) spec.id = editing.id;   // upsert in place (saveCustom keeps an existing custom id)
      try {
        const saved = Specialties.saveCustom(spec);
        sfx('click'); note((editing ? 'updated' : 'saved') + ' specialty: ' + saved.name, 'good');
        editingId = null; view = 'grid'; render();
      } catch (e) { sfx('bad'); note((e && e.message) || 'could not save', 'bad'); }
    });
    const nameIn = body.querySelector('#mkt-f-name');
    if (nameIn) { nameIn.focus(); nameIn.setSelectionRange(nameIn.value.length, nameIn.value.length); }
  }

  return { open, close };
})();
