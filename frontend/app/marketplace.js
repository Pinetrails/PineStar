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
  let root = null, ctx = null, view = 'grid';   // 'grid' | 'save'
  let opener = null;                            // the element focus came from, restored on close
  let editingId = null;                         // when set, the save form edits this custom (not a new save)
  let glassOpen = false;                        // the "what I've learned about you" panel expanded? (per-session)
  const expanded = {};                          // specId -> preview open (persists across re-renders)

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
    view = 'grid'; editingId = null;
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
    root.remove(); root = null; ctx = null; view = 'grid'; editingId = null;
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
    return ctx && ctx.mode === 'pick'
      ? 'choose a specialist to wake your agent as'
      : 'deploy a specialty onto ' + ((ctx && ctx.agentName) || 'your agent') + ' — or save this one as a template';
  }

  /* ---------- render ---------- */
  function render() {
    if (!root) return;
    const body = root.querySelector('.mkt-body');
    body.innerHTML = view === 'save' ? saveFormHTML() : gridHTML();
    if (view === 'save') wireSaveForm(body);
    else {
      wireGrid(body);
      // a re-render (delete / view switch) can orphan focus on a removed node — keep it inside the dialog
      if (!root.contains(document.activeElement)) { const p = root.querySelector('.mkt'); if (p) p.focus(); }
    }
  }

  function gridHTML() {
    const deploy = !ctx || ctx.mode !== 'pick';
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
    html += glassHTML();        // "STATION FAMILIARITY" — the glass box of what the station has learned (deploy mode)
    html += recShelfHTML();     // "RECOMMENDED FOR YOU" — the affinity-ranked shelf, pinned above the full catalog
    html += '<div class="mkt-sect-h">▮ CATALOG</div>';
    html += '<div class="mkt-grid">' + builtins.map(cardHTML).join('') + '</div>';
    html += '<div class="mkt-sect-h">▮ YOUR SPECIALISTS</div>';
    html += customs.length
      ? '<div class="mkt-grid">' + customs.map(cardHTML).join('') + '</div>'
      : '<div class="mkt-empty">no saved specialists yet — ' + (deploy ? 'hit “＋ save this agent as a specialty” above' : 'save an agent as a specialty in-game') + ' to grow your own roster.</div>';
    return html;
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
      ? '<div class="mkt-fam-consent">SKYNET learns what you work on to tailor these picks — <b>locally, on this machine, 0 bytes sent.</b> ' +
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

  /* ---------- the recommender: rank the catalog by the Commander's affinity, top 3 above the fold ---------- */
  function recommended() {
    if (ctx && ctx.mode === 'pick') return null;
    const ps = profileApi(); if (!ps) return null;
    const summ = ps.summary(); if (!summ || !summ.dominant) return null;   // no signal (or seed) yet → no shelf
    if (ps.enabled && !ps.enabled()) return null;                          // paused → don't push picks
    const curId = ctx && ctx.currentSpecialtyId;
    const ranked = Specialties.builtins()
      .map((s, idx) => ({ s, idx, score: ps.score(s.tags || {}) }))
      .filter(r => r.s.id !== curId && r.score > 0)                        // skip what's already deployed
      .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))             // score desc, catalog order as a stable tiebreak
      .slice(0, 3);
    return ranked.length ? ranked.map(r => r.s) : null;
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

    /* ---- the glass box: expand/collapse, first-run consent, pause, forget ---- */
    const famHead = body.querySelector('.mkt-fam-head');
    if (famHead) famHead.addEventListener('click', () => { glassOpen = !glassOpen; sfx('click'); render(); });

    const famAck = body.querySelector('.mkt-fam-ack');
    if (famAck) famAck.addEventListener('click', e => { e.stopPropagation(); setAcked(); sfx('click'); render(); });

    const famPause = body.querySelector('.mkt-fam-pause');
    if (famPause) famPause.addEventListener('click', () => {
      const ps = profileApi(); if (!ps || !ps.setEnabled) return;
      const on = ps.enabled ? ps.enabled() : true;
      ps.setEnabled(!on); sfx(on ? 'bad' : 'click');
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
      sfx('close'); note('profile wiped — the station forgot what it learned', 'good'); render();
    });
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
