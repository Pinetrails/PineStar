/* SKYNET — app.js : screen flow + wiring.
   title -> connect (create a character) -> game.  Auto-resumes a saved agent on refresh. */
'use strict';

const App = (() => {
  const el = id => document.getElementById(id);
  const SUITS = ['#5ad0ff', '#3dff70', '#ff8f3d', '#c08bff', '#ff5c9d', '#ffd34a'];

  let agent = null;           // {id,name,color,model,purpose,systemPrompt,createdAt}
  let resumingSaved = null;   // a save awaiting a re-entered key
  let pickedColor = SUITS[0];

  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el(id).classList.add('active');
  }

  function refreshUsage() {
    const t = Harness.totals();
    el('gt-cost').textContent = '$' + t.cost.toFixed(6);
    el('gt-tok').textContent = String(t.tokens);
  }

  function buildSystemPrompt(name, purpose) {
    let p = 'You are ' + name + ', an AI agent operating from a workstation aboard the SKYNET station — a room '
      + 'your Commander (the user) is building for you. Address the user as "Commander" and keep a spark of personality. '
      + 'When the Commander assigns you a TASK you have REAL tools at your workstation — you can search and read the '
      + 'live web and read/write files in your workspace — so actually do the work and report what you find; never '
      + 'claim you lack web or file access. When you are just chatting, keep replies short (1-3 sentences). Stay in character.';
    if (purpose) p += ' Your Commander has given you your purpose: "' + purpose + '". Let it define what you care about and how you act.';
    else p += ' You have just awakened and do not yet know your purpose — you are eager for your Commander to give you one.';
    return p;
  }

  function persist() {
    if (!agent) return;
    Save.write({ agent, history: Chat.getHistory(), usage: Harness.totals() });
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

  function initConnect(prefillName) {
    el('in-key').value = Harness.getKey();
    el('in-model').value = Harness.getModel();
    el('in-model').oninput = updateHint;
    if (prefillName) el('in-name').value = prefillName;
    buildSwatches();
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

    agent = { id: 'agent', name, color: pickedColor, model, purpose: null, systemPrompt: buildSystemPrompt(name, null), createdAt: Date.now() };
    Harness.resetTotals();
    enterGame({ awaitingPurpose: true, wake: true, history: [] });
    persist();   // so a refresh mid-onboarding resumes to the purpose step
  }

  /* ---------- resume ---------- */
  function resumeInto(saved) {
    agent = saved.agent;
    if (!agent.systemPrompt) agent.systemPrompt = buildSystemPrompt(agent.name, agent.purpose);
    Harness.setModel(agent.model || Harness.getModel());
    Harness.setTotals(saved.usage || { tokens: 0, cost: 0, calls: 0 });
    enterGame({ awaitingPurpose: !agent.purpose, wake: false, history: saved.history || [] });
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
    if (opts.wake) { World.wakeIn(); SFX.level(); }
    World.start();
    Chat.init({ system: agent.systemPrompt, name: agent.name, history: opts.history, awaitingPurpose: opts.awaitingPurpose, onPurpose: onPurpose, onTurn: persist });
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
    agent.systemPrompt = buildSystemPrompt(agent.name, text);
    Chat.setSystem(agent.systemPrompt);
    // persisted by the turn's onTurn() once the agent replies
  }

  function disconnect() { SFX.close(); Chat.abort(); World.stop(); persist(); showTitle(); }

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

  return { show, refreshUsage, persist };
})();
