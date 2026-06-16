/* SKYNET — marketplace.js : THE RECRUITMENT BAY — a browsable "app store" of agent specialties.

   Renders the Specialties catalog (built-ins + the Commander's saved customs) as a gallery of cards.
   Self-contained: it builds its own full-screen overlay (scrim + panel), owns all its DOM + events,
   and themes purely off the existing CSS vars (marketplace.css) so it never touches a shared stylesheet.

   Two modes, both opened by the app:
     • 'deploy'  (in-game)  — DEPLOY a specialty onto the CURRENT agent (re-specs its purpose + standing
                              orders via the app's real applyAgentConfig path) and SAVE the current agent
                              as a reusable custom specialty.
     • 'pick'    (at wake)  — choose a specialist to wake a NEW agent as; hands the chosen spec back so the
                              connect screen can pre-fill persona / suit / name and seed the dossier.

   The app injects everything coupling-sensitive (onDeploy / onPick / draft-from-agent / notify); the bay
   talks to Specialties directly for the catalog + custom round-trip. UMD-light: a `Marketplace` global. */
'use strict';
const Marketplace = (() => {
  let root = null, ctx = null, view = 'grid';   // 'grid' | 'save'
  const expanded = {};                          // specId -> preview open

  const has = () => typeof Specialties !== 'undefined';
  const sfx = n => { try { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); } catch (_) {} };
  const note = (m, k) => { try { if (ctx && ctx.notify) ctx.notify(m, k); } catch (_) {} };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  /* ---------- open / close ---------- */
  function open(context) {
    if (!has()) return;
    close();
    ctx = context || {};
    view = 'grid';
    root = el('div', 'mkt-scrim');
    root.innerHTML =
      '<div class="mkt" role="dialog" aria-label="Recruitment Bay">' +
        '<div class="mkt-head">' +
          '<span class="mkt-title">▮ RECRUITMENT BAY</span>' +
          '<span class="mkt-sub">' + esc(subtitle()) + '</span>' +
          '<button class="mkt-x" title="close">✕</button>' +
        '</div>' +
        '<div class="mkt-body scrolly"></div>' +
      '</div>';
    document.body.appendChild(root);
    // scrim click (outside the panel) closes; panel clicks do not bubble out
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });
    root.querySelector('.mkt-x').addEventListener('click', () => { sfx('close'); close(); });
    document.addEventListener('keydown', onKey);
    sfx('open');
    render();
  }
  function close() {
    if (!root) return;
    document.removeEventListener('keydown', onKey);
    root.remove(); root = null; ctx = null; view = 'grid';
  }
  function onKey(e) { if (e.key === 'Escape') { sfx('close'); close(); } }
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
    if (view === 'save') wireSaveForm(body); else wireGrid(body);
  }

  function gridHTML() {
    const deploy = !ctx || ctx.mode !== 'pick';
    const toolbar = deploy
      ? '<div class="mkt-toolbar"><button class="bb sm mkt-saveas">＋ SAVE THIS AGENT AS A SPECIALTY</button>' +
        '<span class="mkt-hint">re-specs ' + esc((ctx && ctx.agentName) || 'your agent') + '’s purpose &amp; standing orders — its voice &amp; spend stay yours</span></div>'
      : '<div class="mkt-toolbar"><span class="mkt-hint">picking one pre-fills the wake screen — name, voice &amp; mission, ready to tweak</span></div>';
    const specs = Specialties.list();
    return toolbar + '<div class="mkt-grid">' + specs.map(cardHTML).join('') + '</div>';
  }

  function cardHTML(s) {
    const deploy = !ctx || ctx.mode !== 'pick';
    const primaryLabel = deploy ? ('▸ DEPLOY TO ' + esc(((ctx && ctx.agentName) || 'AGENT')).toUpperCase()) : '▸ RECRUIT';
    const open = !!expanded[s.id];
    const chips =
      '<span class="mkt-chip" title="recommended voice">◈ ' + esc(s.persona) + '</span>' +
      '<span class="mkt-chip" title="' + esc(Specialties.tierNote(s)) + '">⚙ ' + esc(s.model) + '</span>';
    const preview = open ? (
      '<div class="mkt-prevbox">' +
        '<div class="mkt-prev-h">PURPOSE</div><p class="mkt-prev-p">' + esc(s.purpose) + '</p>' +
        '<div class="mkt-prev-h">STANDING ORDERS</div><pre class="mkt-prev-pre">' + esc(s.manual) + '</pre>' +
        (s.starters && s.starters.length
          ? '<div class="mkt-prev-h">TRY ASKING</div><ul class="mkt-starters">' + s.starters.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul>'
          : '') +
      '</div>'
    ) : '';
    return '<div class="mkt-card" data-id="' + esc(s.id) + '" style="--accent:' + esc(s.accent) + '">' +
      '<div class="mkt-card-top">' +
        '<span class="mkt-emoji">' + esc(s.emoji) + '</span>' +
        '<div class="mkt-card-id">' +
          '<div class="mkt-name">' + esc(s.name) + (s.custom ? ' <span class="mkt-badge">CUSTOM</span>' : '') + '</div>' +
          '<div class="mkt-tag">' + esc(s.tagline) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mkt-blurb">' + esc(s.blurb || s.tagline) + '</div>' +
      '<div class="mkt-chips">' + chips + '</div>' +
      preview +
      '<div class="mkt-card-acts">' +
        '<button class="bb sm mkt-prev" data-id="' + esc(s.id) + '">' + (open ? '▾ HIDE' : '▸ PREVIEW') + '</button>' +
        (s.custom ? '<button class="bb sm danger mkt-del" data-id="' + esc(s.id) + '" title="delete this saved specialty">⌫</button>' : '') +
        '<button class="bb sm mkt-primary" data-id="' + esc(s.id) + '">' + primaryLabel + '</button>' +
      '</div>' +
    '</div>';
  }

  function wireGrid(body) {
    const saveas = body.querySelector('.mkt-saveas');
    if (saveas) saveas.addEventListener('click', () => { sfx('click'); view = 'save'; render(); });
    body.querySelectorAll('.mkt-prev').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.id; expanded[id] = !expanded[id]; sfx('click'); render();
    }));
    body.querySelectorAll('.mkt-del').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.id, s = Specialties.get(id);
      if (s && confirm('Delete saved specialty "' + s.name + '"? This cannot be undone.')) {
        Specialties.removeCustom(id); sfx('close'); note('removed specialty: ' + s.name, 'good'); render();
      }
    }));
    body.querySelectorAll('.mkt-primary').forEach(b => b.addEventListener('click', () => {
      const s = Specialties.get(b.dataset.id);
      if (!s) return;
      sfx('click');
      if (ctx && ctx.mode === 'pick') { if (ctx.onPick) ctx.onPick(s); close(); }
      else { if (ctx && ctx.onDeploy) ctx.onDeploy(s); note(s.name + ' deployed to ' + ((ctx && ctx.agentName) || 'your agent'), 'good'); close(); }
    }));
  }

  /* ---------- save-this-agent-as-a-specialty form ---------- */
  function saveFormHTML() {
    const d = (ctx && ctx.draftFromAgent && ctx.draftFromAgent()) || { name: 'My Specialist', emoji: '⭐', tagline: '', purpose: '', manual: '' };
    const hasMission = (d.purpose && d.purpose.trim()) || (d.manual && d.manual.trim());
    return '<div class="mkt-save">' +
      '<div class="mkt-save-h">SAVE ' + esc(((ctx && ctx.agentName) || 'THIS AGENT')).toUpperCase() + ' AS A SPECIALTY</div>' +
      '<p class="mkt-hint">captures this agent’s current purpose + standing orders as a reusable template you can deploy later.' +
        (hasMission ? '' : ' <b>heads up:</b> this agent has no purpose/standing-orders set yet, so the template would be near-empty.') + '</p>' +
      '<div class="mkt-save-row">' +
        '<label class="mkt-lbl">ICON<input class="mkt-in mkt-emoji-in" id="mkt-f-emoji" maxlength="2" value="' + esc(d.emoji || '⭐') + '"></label>' +
        '<label class="mkt-lbl mkt-grow">NAME<input class="mkt-in" id="mkt-f-name" maxlength="28" value="' + esc(d.name || '') + '" placeholder="e.g. Night-Shift Researcher"></label>' +
      '</div>' +
      '<label class="mkt-lbl">TAGLINE<input class="mkt-in" id="mkt-f-tag" maxlength="48" value="' + esc(d.tagline || '') + '" placeholder="one line — what it’s for"></label>' +
      '<div class="mkt-save-acts">' +
        '<button class="bb sm mkt-cancel">‹ BACK</button>' +
        '<button class="bb sm mkt-do-save">✓ SAVE SPECIALTY</button>' +
      '</div>' +
    '</div>';
  }
  function wireSaveForm(body) {
    body.querySelector('.mkt-cancel').addEventListener('click', () => { sfx('click'); view = 'grid'; render(); });
    body.querySelector('.mkt-do-save').addEventListener('click', () => {
      const draft = (ctx && ctx.draftFromAgent && ctx.draftFromAgent()) || {};
      const name = (body.querySelector('#mkt-f-name').value || '').trim();
      if (!name) { sfx('bad'); note('give your specialty a name', 'bad'); return; }
      const spec = Object.assign({}, draft, {
        name,
        emoji: (body.querySelector('#mkt-f-emoji').value || '⭐').trim() || '⭐',
        tagline: (body.querySelector('#mkt-f-tag').value || '').trim()
      });
      try {
        const saved = Specialties.saveCustom(spec);
        sfx('click'); note('saved specialty: ' + saved.name, 'good');
        view = 'grid'; render();
      } catch (e) { sfx('bad'); note((e && e.message) || 'could not save', 'bad'); }
    });
    const nameIn = body.querySelector('#mkt-f-name');
    if (nameIn) { nameIn.focus(); nameIn.setSelectionRange(nameIn.value.length, nameIn.value.length); }
  }

  return { open, close };
})();
