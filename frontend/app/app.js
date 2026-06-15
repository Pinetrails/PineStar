/* SKYNET — app.js : screen flow + wiring.
   title -> connect (create a character) -> game.  Auto-resumes a saved agent on refresh. */
'use strict';

const App = (() => {
  const el = id => document.getElementById(id);
  const SUITS = ['#5ad0ff', '#3dff70', '#ff8f3d', '#c08bff', '#ff5c9d', '#ffd34a'];

  let agent = null;           // {id,name,color,model,purpose,systemPrompt,createdAt}
  let resumingSaved = null;   // a save awaiting a re-entered key
  let pickedColor = SUITS[0];
  let pickedPersona = (typeof Personas !== 'undefined') ? Personas.DEFAULT_ID : 'worker-homie';
  let station = null;         // the canonical WorldModel station (the builder's source of truth)
  let pendingStationDoc = null; // a saved station doc awaiting enterGame()

  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el(id).classList.add('active');
  }

  function refreshUsage() {
    const t = Harness.totals();
    el('gt-cost').textContent = '$' + t.cost.toFixed(6);
    el('gt-tok').textContent = String(t.tokens);
    const wc = el('ws-cost');
    if (wc && typeof Workstreams !== 'undefined') {
      const a = Workstreams.active();
      const c = a ? Workstreams.costOf(a.id) : null;
      wc.textContent = (c && c.usd) ? '$' + c.usd.toFixed(4) + ' · this stream' : '';
    }
  }

  /* ---------- agent config DOCS (the markdown files the Commander writes) ----------
     The dossier surfaces three editable .md files — identity.md / purpose.md / operating-manual.md —
     and composeSystemPrompt() assembles them into the EXACT system prompt sent to the model each run.
     They are not decoration: editing one in the dossier re-shapes the live agent (see applyAgentConfig). */
  function baseIdentity(name) {
    return 'You are ' + name + ', an AI agent operating from a workstation aboard the SKYNET station — a room '
      + 'your Commander (the user) is building for you. Address the user as "Commander" and keep a spark of personality. '
      + 'When the Commander assigns you a TASK you have REAL tools at your workstation — you can search and read the '
      + 'live web and read/write files in your workspace — so actually do the work and report what you find; never '
      + 'claim you lack web or file access. When you are just chatting out loud, keep replies short and easy; when you are '
      + 'typing in the COMMS panel you can go into as much detail as the question deserves. Stay in character.';
  }
  // seed the editable docs from the agent's existing fields the first time (back-compat for saves with no docs).
  function agentDocs(a) {
    if (!a.docs || typeof a.docs !== 'object') a.docs = {};
    if (typeof a.docs.identity !== 'string') a.docs.identity = baseIdentity(a.name);
    if (typeof a.docs.purpose !== 'string') a.docs.purpose = a.purpose || '';
    if (typeof a.docs.manual !== 'string') a.docs.manual = '';
    return a.docs;
  }
  // assemble the real system prompt from the config docs: identity + PERSONALITY + mission + standing orders.
  function composeSystemPrompt(a) {
    const d = agentDocs(a);
    let p = (d.identity || '').trim() || baseIdentity(a.name);
    // personality preset sits AFTER identity (keeps the REAL-tools clause) and BEFORE purpose, so it
    // colours the agent's tone without ever displacing capability or the mission. Default: worker-homie.
    if (typeof Personas !== 'undefined') {
      const persona = Personas.get(a.personaId || Personas.DEFAULT_ID);
      if (persona && persona.promptInjection) p += '\n\n' + persona.promptInjection;
    }
    const purpose = (d.purpose || '').trim();
    if (purpose) p += '\n\nYOUR PURPOSE (purpose.md):\n' + purpose;
    else p += '\n\nYou have not yet been given a purpose — you are eager for your Commander to assign one.';
    const manual = (d.manual || '').trim();
    if (manual) p += '\n\nSTANDING ORDERS (operating-manual.md) — always follow these:\n' + manual;
    return p;
  }
  // the dossier calls this when the Commander edits & saves a config file: fold the patch into the
  // docs, recompose the live system prompt, hand it to the running chat, and persist.
  function applyAgentConfig(patch) {
    if (!agent) return;
    const d = agentDocs(agent);
    if (patch && typeof patch === 'object') {
      if (typeof patch.identity === 'string') d.identity = patch.identity;
      if (typeof patch.purpose === 'string') { d.purpose = patch.purpose; agent.purpose = patch.purpose.trim(); }
      if (typeof patch.manual === 'string') d.manual = patch.manual;
    }
    agent.systemPrompt = composeSystemPrompt(agent);
    if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(agent.systemPrompt);
    syncChannels();   // keep a connected Telegram bot on the SAME (updated) identity — no reconnect needed
    persist();
  }

  // push the live agent identity (the run agentId + composed system prompt) to the sidecar so any connected
  // messaging channel (Telegram) runs as the SAME agent. Fire-and-forget; a no-op if no channel is connected.
  function syncChannels() {
    try {
      if (!agent) return;
      const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
      fetch('/api/channels/telegram/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: (ws && ws.agentId) || 'agent', system: agent.systemPrompt || '', agentName: agent.name || '' })
      }).catch(() => {});
    } catch (_) {}
  }

  function persist() {
    if (!agent) return;
    Save.write(Object.assign({ agent, usage: Harness.totals(), station: station ? station.serialize() : undefined }, Workstreams.serialize()));
    if (typeof StationUI !== 'undefined') StationUI.flashSave();
  }

  /* ---------- connect screen ---------- */
  async function loadModels() {
    const dl = el('model-list'), countEl = el('model-count'), inp = el('in-model');
    el('model-hint').textContent = 'loading model catalog…';
    const list = await Harness.listModels();
    dl.innerHTML = '';
    for (const m of list) { const o = document.createElement('option'); o.value = m.id; dl.appendChild(o); }
    countEl.textContent = list.length ? '(' + list.length + ' available)' : '(offline — type a slug)';
    if (list.length && !inp.value) {
      const pref = list.find(m => /claude.*sonnet|gpt-4o|gpt-5/i.test(m.id)) || list[0];
      inp.placeholder = 'e.g. ' + pref.id;
    }
    updateHint();
  }

  function updateHint() {
    const id = el('in-model').value.trim(), hint = el('model-hint');
    const p = Harness.priceOf(id);
    if (p) hint.innerHTML = 'pricing: <b>$' + p.in.toFixed(2) + '</b> /1M in · <b>$' + p.out.toFixed(2) + '</b> /1M out';
    else hint.textContent = id ? 'custom slug — live cost shown as you spend' : 'pick or type a model slug';
  }

  function buildSwatches() {
    const wrap = el('swatches'); wrap.innerHTML = '';
    SUITS.forEach(c => {
      const s = document.createElement('div');
      s.className = 'swatch' + (c === pickedColor ? ' sel' : '');
      s.style.background = c; s.title = c;
      s.onclick = () => { pickedColor = c; [...wrap.children].forEach(x => x.classList.remove('sel')); s.classList.add('sel'); SFX.click(); };
      wrap.appendChild(s);
    });
  }

  // the PERSONALITY picker: pick the agent's preset vibe at creation (default worker-homie). The chosen
  // id rides on agent.personaId and shapes the system prompt via composeSystemPrompt → personas.js.
  function buildPersonas() {
    const wrap = el('persona-picker'); if (!wrap || typeof Personas === 'undefined') return;
    wrap.innerHTML = '';
    const hint = el('persona-hint');
    if (!Personas.exists(pickedPersona)) pickedPersona = Personas.DEFAULT_ID;
    const showHint = p => { if (hint) hint.textContent = p.vibe; };
    Personas.list().forEach(p => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'persona' + (p.id === pickedPersona ? ' sel' : '');
      b.textContent = p.name; b.title = p.vibe;
      b.onclick = () => {
        pickedPersona = p.id;
        [...wrap.children].forEach(x => x.classList.remove('sel')); b.classList.add('sel');
        showHint(p); SFX.click();
      };
      b.onmouseenter = () => showHint(p);
      wrap.appendChild(b);
    });
    showHint(Personas.get(pickedPersona));
  }

  function initConnect(prefillName) {
    el('in-key').value = Harness.getKey();
    el('in-model').value = Harness.getModel();
    el('in-model').oninput = updateHint;
    if (prefillName) el('in-name').value = prefillName;
    buildSwatches();
    buildPersonas();
    el('btn-back').onclick = () => { SFX.click(); showTitle(); };
    el('btn-wake').onclick = onWake;
    el('in-name').onkeydown = e => { if (e.key === 'Enter') onWake(); };
    loadModels();
  }

  function onWake() {
    SFX.boot(); SFX.open();
    const key = el('in-key').value.trim();
    const model = el('in-model').value.trim();
    const name = (el('in-name').value.trim() || 'AGENT').toUpperCase();
    const msg = el('connect-msg'); msg.className = 'msg';
    if (!key) { msg.textContent = 'enter your OpenRouter API key (openrouter.ai/keys).'; return; }
    if (!model) { msg.textContent = 'choose or type a model slug.'; return; }
    Harness.setKey(key); Harness.setModel(model); Harness.setProv('openrouter');

    if (resumingSaved) { const s = resumingSaved; resumingSaved = null; s.agent.model = model; resumeInto(s); return; }

    agent = { id: 'agent', name, color: pickedColor, model, personaId: pickedPersona, purpose: null, createdAt: Date.now() };
    agentDocs(agent);                              // seed identity.md / purpose.md / operating-manual.md
    agent.systemPrompt = composeSystemPrompt(agent);
    Harness.resetTotals();
    Workstreams.reset();   // a fresh General stream for the new agent
    pendingStationDoc = null;   // a brand-new station (one shabby starter room) for a new agent
    enterGame({ awaitingPurpose: true, wake: true });
    persist();   // so a refresh mid-onboarding resumes to the purpose step
  }

  /* ---------- resume ---------- */
  function resumeInto(saved) {
    agent = saved.agent;
    agentDocs(agent);                              // seed config docs for older saves that predate them
    agent.systemPrompt = composeSystemPrompt(agent);
    Harness.setModel(agent.model || Harness.getModel());
    Harness.setTotals(saved.usage || { tokens: 0, cost: 0, calls: 0 });
    Workstreams.init({ workstreams: saved.workstreams, activeId: saved.activeId, generalId: saved.generalId });
    pendingStationDoc = saved.station || null;   // restore the built station (if any)
    enterGame({ awaitingPurpose: !agent.purpose, wake: false });
    persist();   // lock any v1->v2 migration to disk now (don't re-migrate every load)
  }

  function enterGame(opts) {
    registerAgent(agent.id, agent.color);
    el('gt-agent').textContent = agent.name;
    el('gt-model').textContent = agent.model;
    refreshUsage();
    show('screen-game');
    SPRITES.init();
    World.init(el('stage'));
    World.spawn(agent);
    World.setOnClick(() => { if (typeof StationUI !== 'undefined') StationUI.openAgent(0); });
    if (opts.wake) { World.wakeIn(); SFX.level(); }
    World.start();
    // the canonical station the builder edits — restored from the save, or a fresh starter room
    station = (pendingStationDoc && pendingStationDoc.rooms) ? WorldModel.deserialize(pendingStationDoc) : WorldModel.create();
    pendingStationDoc = null;
    if (typeof World.loadStation === 'function') World.loadStation(station);   // the live world IS the built station
    if (typeof Build !== 'undefined') {
      Build.init({ getStation: () => station, persist: persist, world: World });
      const bbBuild = el('bb-build');
      if (bbBuild) {
        let seenBuild = false; try { seenBuild = !!localStorage.getItem('skynet.refit.seen'); } catch (e) {}
        if (!seenBuild) bbBuild.classList.add('refit-nudge');   // pulse the dock button until first opened
        bbBuild.onclick = () => { SFX.click(); bbBuild.classList.remove('refit-nudge'); Build.toggle(); };
      }
    }
    if (typeof StationUI !== 'undefined') {
      StationUI.enter([agent], {
        totals: () => Harness.totals(),
        activity: () => (World.getActivity ? World.getActivity() : 'idle'),
        config: { apply: applyAgentConfig }   // dossier edits to identity/purpose/manual .md re-shape the live prompt
      });
      StationUI.notify(agent.name + ' is online — ' + agent.model, 'good');
    }
    Chat.init({ system: agent.systemPrompt, name: agent.name, ws: Workstreams.active(), awaitingPurpose: opts.awaitingPurpose, onPurpose: onPurpose, onTurn: persist });
    if (typeof Voice !== 'undefined') Voice.init({ name: agent.name, personaId: agent.personaId });   // mic + this agent's voice & acks
    syncChannels();   // if a Telegram bot auto-started from saved config, refresh it to THIS agent's live identity
    renderRail();
    el('ws-new').onclick = newWorkstream;
    if (opts.awaitingPurpose) {
      setTimeout(() => {
        Chat.localLine('…i am awake, Commander, but i don’t know what i’m for yet. tell me — what is my purpose?');
        World.say('what is my purpose?');
      }, opts.wake ? 950 : 250);
    }
    el('btn-disconnect').onclick = disconnect;
  }

  function onPurpose(text) {
    agent.purpose = text;
    agentDocs(agent).purpose = text;               // the interview answer IS purpose.md
    agent.systemPrompt = composeSystemPrompt(agent);
    Chat.setSystem(agent.systemPrompt);
    syncChannels();                                // keep a connected Telegram bot on the new identity
    // persisted by the turn's onTurn() once the agent replies
  }

  /* ---------- workstreams rail (left) ---------- */
  function renderRail() {
    const ul = el('workstreams');
    if (!ul || typeof Workstreams === 'undefined') return;
    const activeId = Workstreams.activeId();
    ul.innerHTML = Workstreams.list().map(w => {
      const title = w.title || 'General';
      const c = (w.cost && w.cost.usd) ? '$' + w.cost.usd.toFixed(4) : '';
      return '<li class="ws-row' + (w.id === activeId ? ' sel' : '') + '" data-id="' + w.id + '">' +
        '<span class="ws-dot lane-' + w.lane + '"></span>' +
        '<span class="ws-title">' + U.esc(title) + '</span>' +
        (c ? '<span class="ws-c">' + c + '</span>' : '') +
        '</li>';
    }).join('');
    ul.querySelectorAll('.ws-row').forEach(li => li.onclick = () => switchWorkstream(li.dataset.id));
    if (typeof StationUI !== 'undefined' && StationUI.refreshBoard) StationUI.refreshBoard();
  }
  // no switching mid-run: one #chat-log streams the active run, so a swap would render into the wrong stream.
  function switchWorkstream(id) {
    if (Chat.isBusy && Chat.isBusy()) return;
    if (id === Workstreams.activeId()) return;
    const ws = Workstreams.switch(id); if (!ws) return;
    SFX.click(); Chat.load(ws); refreshUsage(); renderRail(); persist();
  }
  function newWorkstream() {
    if (Chat.isBusy && Chat.isBusy()) return;
    const ws = Workstreams.create(null);
    SFX.open(); Chat.load(ws); refreshUsage(); renderRail(); persist();
  }

  function disconnect() { SFX.close(); Chat.abort(); World.stop(); persist(); if (typeof StationUI !== 'undefined') StationUI.leave(); showTitle(); }

  /* ---------- title ---------- */
  function showTitle() {
    const saved = Save.has() ? Save.load() : null;
    const has = !!(saved && saved.agent);
    el('btn-resume').classList.toggle('hidden', !has);
    el('btn-newagent').classList.toggle('hidden', !has);
    el('btn-begin').classList.toggle('hidden', has);
    if (has) el('btn-resume').textContent = '▮ RESUME — ' + saved.agent.name + ' ▮';
    show('screen-title');
  }

  function startCreation() { SFX.boot(); SFX.open(); resumingSaved = null; show('screen-connect'); initConnect(); }

  /* ---------- boot ---------- */
  function init() {
    if (typeof StationUI !== 'undefined') StationUI.init();   // applies saved theme/CRT settings, wires the bottom bar
    el('btn-begin').onclick = startCreation;
    el('btn-newagent').onclick = () => { SFX.click(); Save.clear(); startCreation(); };
    el('btn-resume').onclick = () => { const s = Save.load(); if (s) { SFX.open(); resumeInto(s); } };

    const saved = Save.load();
    if (saved && saved.agent) {
      if (Harness.getKey()) { resumeInto(saved); return; }   // auto-resume on refresh
      resumingSaved = saved;
      show('screen-connect'); initConnect(saved.agent.name);
      el('connect-msg').textContent = 're-enter your key to resume ' + saved.agent.name + '.';
      return;
    }
    showTitle();
  }
  init();

  return { show, refreshUsage, persist, refreshRail: renderRail };
})();
