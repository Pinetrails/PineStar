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
  let pickedSpecialty = null;   // a Recruitment-Bay specialty chosen at the connect screen — seeds the new agent's purpose/manual at wake
  let prePickPersona = null;    // the persona selected BEFORE a roster pick overrode it — restored if the pick is cleared
  let pickedProvider = 'openrouter';   // 'openrouter' (BYO API key) | 'codex' (personal ChatGPT subscription via OAuth)
  let codexConnected = false;          // last-known /api/auth/codex/status — gates waking on the Codex provider
  let codexFlow = null;                // the in-flight device-code login { device_auth_id, user_code, verification_uri, deadline }
  let codexPoll = null;                // the setTimeout handle for the device-code poll loop
  let station = null;         // the canonical WorldModel station (the builder's source of truth)
  let pendingStationDoc = null; // a saved station doc awaiting enterGame()
  let pendingStationStats = null; // a saved station-growth rollup (XP/level/confidence) awaiting enterGame()
  let pendingProfile = null;      // a saved user-affinity profile slice awaiting ProfileStore.init() in enterGame()

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
    if (typeof a.docs.context !== 'string') a.docs.context = '';   // about the Commander & their world (authored at the awakening; back-filled for older saves)
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
    const context = (d.context || '').trim();
    if (context) p += '\n\nABOUT YOUR COMMANDER & THEIR WORLD (context.md):\n' + context;
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
      if (typeof patch.context === 'string') d.context = patch.context;
    }
    agent.systemPrompt = composeSystemPrompt(agent);
    if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(agent.systemPrompt);
    syncChannels();   // keep a connected Telegram bot on the SAME (updated) identity — no reconnect needed
    persist();
  }

  /* ---------- THE RECRUITMENT BAY (in-game) ----------
     Open the marketplace against the LIVE agent: DEPLOY a specialty (re-specs purpose + standing orders
     through the very same applyAgentConfig path the dossier uses) or SAVE this agent as a reusable
     specialty. Voice + spend are left untouched — deploy re-shapes the job, not the personality. */
  function openDeployBay() {
    if (typeof Marketplace === 'undefined' || !agent) return;
    SFX.click();
    Marketplace.open({
      mode: 'deploy',
      agentName: agent.name,
      currentSpecialtyId: agent.specialtyId || null,   // lets the bay flag which card is already DEPLOYED
      notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
      draftFromAgent: () => (typeof Specialties !== 'undefined') ? Specialties.fromAgent(agent) : null,
      onDeploy: deploySpecialty
    });
  }
  function deploySpecialty(spec, opts) {
    if (!agent || typeof Specialties === 'undefined') return;
    opts = opts || {};
    // opt-in: also adopt the specialty's recommended VOICE. Set personaId BEFORE the recompose so the new
    // voice folds into the live prompt; we deliberately don't re-init Voice (that would drop hands-free mode) —
    // the spoken TTS timbre catches up on the next load, the text voice changes immediately.
    if (opts.adoptVoice && spec.persona && typeof Personas !== 'undefined' && Personas.exists(spec.persona)) agent.personaId = spec.persona;
    agent.specialtyId = spec.id;
    const patch = Specialties.compose(spec);
    if (patch) applyAgentConfig(patch);   // folds purpose + manual (+ any new persona) into the live prompt, persists, syncs channels
    if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('agents');   // refresh an open dossier
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
    const stationStats = (typeof XpStore !== 'undefined') ? XpStore.stationStats() : undefined;
    const profile = (typeof ProfileStore !== 'undefined') ? ProfileStore.serialize() : undefined;
    Save.write(Object.assign({ agent, usage: Harness.totals(), station: station ? station.serialize() : undefined, stationStats, profile }, Workstreams.serialize()));
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
    if (pickedProvider === 'codex') { hint.textContent = 'included in your ChatGPT subscription — no per-token cost'; return; }
    const p = Harness.priceOf(id);
    if (p) hint.innerHTML = 'pricing: <b>$' + p.in.toFixed(2) + '</b> /1M in · <b>$' + p.out.toFixed(2) + '</b> /1M out';
    else hint.textContent = id ? 'custom slug — live cost shown as you spend' : 'pick or type a model slug';
  }

  /* ---------- provider toggle + ChatGPT (Codex OAuth) sign-in ---------- */
  // Offline FALLBACK only — the real list is fetched per-account from /api/auth/codex/models (see
  // loadCodexModels). The ChatGPT-account Codex lineup drifts: stale slugs (e.g. gpt-5.1-codex) get
  // 400-rejected by the backend, so we never hardcode the menu when we can discover it.
  const CODEX_MODELS = ['gpt-5.3-codex', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

  function selectProviderUI(p) {
    pickedProvider = (p === 'codex') ? 'codex' : 'openrouter';
    document.querySelectorAll('.provider-row .prov').forEach(b => b.classList.toggle('sel', b.dataset.prov === pickedProvider));
    const isCodex = pickedProvider === 'codex';
    el('key-block').classList.toggle('hidden', isCodex);
    el('codex-block').classList.toggle('hidden', !isCodex);
    if (isCodex) {
      loadCodexModels();      // live per-account discovery (falls back to CODEX_MODELS when not connected)
      refreshCodexStatus();
    } else {
      stopCodexPoll(); codexFlow = null;
      loadModels();
    }
  }

  // Populate the model datalist with EXACTLY the slugs the connected account's Codex backend accepts, so the
  // user can't pick a 400-rejected model. Falls back to the curated list when discovery fails / not connected.
  async function loadCodexModels() {
    let models = CODEX_MODELS, def = CODEX_MODELS[0];
    try {
      const r = await fetch('/api/auth/codex/models'); const j = await r.json();
      if (Array.isArray(j.models) && j.models.length) { models = j.models; def = j.default || j.models[0]; }
    } catch (_) {}
    const dl = el('model-list'); dl.innerHTML = '';
    for (const id of models) { const o = document.createElement('option'); o.value = id; dl.appendChild(o); }
    el('model-count').textContent = '(ChatGPT subscription)';
    const mi = el('in-model'); if (!models.includes(mi.value)) mi.value = def;
    updateHint();
  }

  // GET /api/auth/codex/status -> reflect connected/not into the sign-in block (never touches the tokens).
  async function refreshCodexStatus() {
    const statusEl = el('codex-status'), signinBtn = el('btn-codex-signin'), logoutBtn = el('btn-codex-logout');
    let j = { connected: false };
    try { const r = await fetch('/api/auth/codex/status'); j = await r.json(); } catch (_) {}
    codexConnected = !!j.connected;
    if (codexConnected) {
      statusEl.innerHTML = '<span class="conn-dot" style="background:#69ff8e;box-shadow:0 0 8px rgba(105,255,142,.7)"></span>connected to ChatGPT — your agents can run on your subscription';
      statusEl.className = 'codex-status ok';
      signinBtn.textContent = '↻ RE-SIGN IN';
      logoutBtn.classList.remove('hidden');
    } else {
      statusEl.textContent = 'not connected — sign in to use your ChatGPT subscription';
      statusEl.className = 'codex-status';
      signinBtn.textContent = '⏼ SIGN IN WITH CHATGPT ▸';
      logoutBtn.classList.add('hidden');
    }
  }

  // Kick off the device-code flow: request a code, show it + open the verification page, then poll until done.
  async function startCodexSignIn() {
    SFX.click();
    const statusEl = el('codex-status'), codeEl = el('codex-code'), openBtn = el('btn-codex-open');
    stopCodexPoll();
    statusEl.textContent = 'requesting a sign-in code…'; statusEl.className = 'codex-status';
    let d;
    try { const r = await fetch('/api/auth/codex/start', { method: 'POST' }); d = await r.json(); if (!r.ok) throw new Error(d.error || ('start failed (' + r.status + ')')); }
    catch (e) { statusEl.textContent = 'could not start sign-in: ' + ((e && e.message) || e); statusEl.className = 'codex-status bad'; return; }
    codexFlow = { device_auth_id: d.device_auth_id, user_code: d.user_code, verification_uri: d.verification_uri, deadline: Date.now() + ((d.expires_in || 900) * 1000) };
    codeEl.textContent = d.user_code; codeEl.classList.remove('hidden');
    openBtn.classList.remove('hidden');
    openBtn.onclick = () => { try { window.open(d.verification_uri, '_blank', 'noopener'); } catch (_) {} };
    statusEl.innerHTML = 'enter this code at <b>' + d.verification_uri + '</b> (opening it now)…';
    try { window.open(d.verification_uri, '_blank', 'noopener'); } catch (_) {}
    pollCodex(d.interval || 5);
  }

  // One poll tick on a timer; the sidecar reports pending until the user finishes, then connects + persists.
  function pollCodex(intervalS) {
    codexPoll = setTimeout(async () => {
      if (!codexFlow) return;
      if (Date.now() > codexFlow.deadline) { el('codex-status').textContent = 'sign-in timed out — start again'; el('codex-status').className = 'codex-status bad'; codexFlow = null; return; }
      let j;
      try {
        const r = await fetch('/api/auth/codex/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_auth_id: codexFlow.device_auth_id, user_code: codexFlow.user_code }) });
        j = await r.json();
      } catch (e) { j = { status: 'pending' }; }   // transient network blip — keep polling
      if (!codexFlow) return;                        // bailed out (back/disconnect) while awaiting
      if (j.status === 'connected') { codexFlow = null; el('codex-code').classList.add('hidden'); el('btn-codex-open').classList.add('hidden'); SFX.open(); refreshCodexStatus(); loadCodexModels(); return; }
      if (j.status === 'error') { el('codex-status').textContent = 'sign-in failed: ' + (j.error || 'try again'); el('codex-status').className = 'codex-status bad'; codexFlow = null; return; }
      pollCodex(intervalS);                          // pending — schedule the next tick
    }, Math.max(2, intervalS) * 1000);
  }
  function stopCodexPoll() { if (codexPoll) { clearTimeout(codexPoll); codexPoll = null; } }

  async function codexLogout() {
    SFX.click(); stopCodexPoll(); codexFlow = null;
    el('codex-code').classList.add('hidden'); el('btn-codex-open').classList.add('hidden');
    try { await fetch('/api/auth/codex/logout', { method: 'POST' }); } catch (_) {}
    refreshCodexStatus();
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
    // desktop: the key lives in the OS keychain (getKey returns ''); show that it's already set.
    if (Harness.configured && Harness.configured() && !el('in-key').value) {
      el('in-key').placeholder = '•••••••• stored in keychain — leave blank to keep';
    }
    el('in-model').value = Harness.getModel();
    el('in-model').oninput = updateHint;
    if (prefillName) el('in-name').value = prefillName;
    buildSwatches();
    buildPersonas();
    pickedSpecialty = null; prePickPersona = null; resetRosterPick();   // a fresh connect screen carries no stale specialty pick
    const br = el('btn-roster'); if (br) br.onclick = openRosterPicker;
    const bc = el('btn-roster-clear'); if (bc) bc.onclick = clearRosterPick;
    el('btn-back').onclick = () => { SFX.click(); stopCodexPoll(); codexFlow = null; showTitle(); };
    el('btn-wake').onclick = onWake;
    el('in-name').onkeydown = e => { if (e.key === 'Enter') onWake(); };
    // provider toggle + ChatGPT sign-in wiring; selectProviderUI() also loads the right model catalog.
    document.querySelectorAll('.provider-row .prov').forEach(b => { b.onclick = () => { SFX.click(); selectProviderUI(b.dataset.prov); }; });
    el('btn-codex-signin').onclick = startCodexSignIn;
    el('btn-codex-logout').onclick = codexLogout;
    selectProviderUI(Harness.getProv());
  }

  // THE ROSTER at create-time: open the Recruitment Bay in PICK mode; the chosen specialty pre-fills the
  // form (voice + a suggested name) and is stashed to seed purpose.md / operating-manual.md at wake.
  function openRosterPicker() {
    SFX.click();
    if (typeof Marketplace === 'undefined') return;
    Marketplace.open({
      mode: 'pick',
      notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
      onPick: applyRosterPick
    });
  }
  function applyRosterPick(spec) {
    if (prePickPersona === null) prePickPersona = pickedPersona;   // remember the pre-recruit voice so a CLEAR can restore it
    pickedSpecialty = spec;
    // adopt the specialty's recommended VOICE (the Commander can still re-pick a persona below)
    if (typeof Personas !== 'undefined' && Personas.exists(spec.persona)) { pickedPersona = spec.persona; buildPersonas(); }
    const nameEl = el('in-name'); if (nameEl && !nameEl.value.trim()) nameEl.value = (spec.name || '').toUpperCase().slice(0, 18);
    const pick = el('roster-pick');
    if (pick) { pick.textContent = spec.emoji + ' ' + spec.name + ' — ' + spec.tagline + ' · tap to change'; pick.classList.add('chosen'); pick.onclick = openRosterPicker; }
    const bc = el('btn-roster-clear'); if (bc) bc.classList.remove('hidden');
  }
  // CLEAR a roster pick: drop the specialty, restore the pre-pick voice, and return the form to "none chosen".
  function clearRosterPick() {
    SFX.click();
    pickedSpecialty = null;
    if (prePickPersona !== null && typeof Personas !== 'undefined') { pickedPersona = prePickPersona; buildPersonas(); }
    prePickPersona = null;
    resetRosterPick();
  }
  function resetRosterPick() {
    const pick = el('roster-pick');
    if (pick) { pick.textContent = "none chosen — you'll set its mission at wake"; pick.classList.remove('chosen'); pick.onclick = null; }
    const bc = el('btn-roster-clear'); if (bc) bc.classList.add('hidden');
  }

  async function onWake() {
    SFX.boot(); SFX.open();
    stopCodexPoll();   // leaving the connect screen — drop any in-flight sign-in poll
    const model = el('in-model').value.trim();
    const name = (el('in-name').value.trim() || 'AGENT').toUpperCase().slice(0, 18);   // single funnel for agent.name → honor the 18-char design cap (covers the roster-pick path too)
    const msg = el('connect-msg'); msg.className = 'msg';
    if (!model) { msg.textContent = 'choose or type a model slug.'; return; }
    if (pickedProvider === 'codex') {
      if (!codexConnected) { msg.textContent = 'sign in with ChatGPT first, or switch to OpenRouter.'; return; }
      Harness.setKey('');                                   // the Codex path authenticates by OAuth token, not a key
      Harness.setModel(model); Harness.setProv('codex');
    } else {
      const key = el('in-key').value.trim();
      const configured = !!(Harness.configured && Harness.configured());
      if (!key && !configured) { msg.textContent = 'enter your OpenRouter API key (openrouter.ai/keys).'; return; }
      // Only (re)store when a key was actually typed — desktop keeps the existing keychain key on blank.
      // setKey is async in desktop (writes the keychain + pushes it to the sidecar); await so the run has it.
      if (key) await Harness.setKey(key);
      Harness.setModel(model); Harness.setProv('openrouter');
    }

    if (resumingSaved) { const s = resumingSaved; resumingSaved = null; s.agent.model = model; resumeInto(s); return; }

    agent = { id: 'agent', name, color: pickedColor, model, personaId: pickedPersona, purpose: null, createdAt: Date.now() };
    agentDocs(agent);                              // seed identity.md / purpose.md / operating-manual.md
    // if the Commander recruited a specialty from the Roster, the agent wakes already specced: fold the
    // preset purpose + standing orders in BEFORE composing the prompt (the awakening then skips re-asking).
    if (pickedSpecialty && typeof Specialties !== 'undefined') {
      const patch = Specialties.compose(pickedSpecialty);
      if (patch) {
        agent.docs.purpose = patch.purpose; agent.docs.manual = patch.manual;
        agent.purpose = (patch.purpose || '').trim();
        agent.specialtyId = pickedSpecialty.id;
      }
    }
    agent.systemPrompt = composeSystemPrompt(agent);
    Harness.resetTotals();
    Workstreams.reset();   // a fresh General stream for the new agent
    pendingStationDoc = null;   // a brand-new station (one shabby starter room) for a new agent
    pendingStationStats = null; // fresh growth meters — XpStore.init seeds them on enterGame
    enterGame({ awaitingPurpose: true, wake: true, specialty: pickedSpecialty });
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
    pendingStationStats = saved.stationStats || null;   // restore the station-growth rollup (XP/level/confidence)
    pendingProfile = saved.profile || null;   // restore the learned user-affinity profile
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
    World.setOnArcade(() => { if (typeof StationUI !== 'undefined' && StationUI.openArcade) StationUI.openArcade(); });   // click a cabinet → BREACH PROTOCOL
    if (opts.awaitingPurpose) World.beginAwakening();        // wake in darkness — the awakening lifts the room to first light (set BEFORE start so there's no flash of the lit room)
    else if (opts.wake) { World.wakeIn(); SFX.level(); }
    World.start();
    // the canonical station the builder edits — restored from the save, or a fresh starter room
    station = (pendingStationDoc && pendingStationDoc.rooms) ? WorldModel.deserialize(pendingStationDoc) : WorldModel.create();
    pendingStationDoc = null;
    if (typeof World.loadStation === 'function') World.loadStation(station);   // the live world IS the built station
    if (typeof Build !== 'undefined') {
      // agents: the roster the BAY agent-picker offers (Phase B4d). Today the app runs one agent; this is the
      // seam a multi-agent roster flows through. The bay->agent binding itself persists via station.serialize
      // (prop.agentId round-trips), so a single-agent app already saves its routing floor.
      Build.init({ getStation: () => station, persist: persist, world: World, agents: () => (agent ? [{ id: agent.id, name: agent.name, color: agent.color }] : []) });
      const bbBuild = el('bb-build');
      if (bbBuild) {
        let seenBuild = false; try { seenBuild = !!localStorage.getItem('skynet.refit.seen'); } catch (e) {}
        if (!seenBuild) bbBuild.classList.add('refit-nudge');   // pulse the dock button until first opened
        bbBuild.onclick = () => { SFX.click(); bbBuild.classList.remove('refit-nudge'); Build.toggle(); };
      }
    }
    const bbRoster = el('bb-roster');
    if (bbRoster) bbRoster.onclick = openDeployBay;   // the in-game Recruitment Bay
    if (typeof StationUI !== 'undefined') {
      StationUI.enter([agent], {
        totals: () => Harness.totals(),
        activity: () => (World.getActivity ? World.getActivity() : 'idle'),
        config: { apply: applyAgentConfig }   // dossier edits to identity/purpose/manual .md re-shape the live prompt
      });
      if (!opts.awaitingPurpose) StationUI.notify(agent.name + ' is online — ' + agent.model, 'good');   // during the awakening the finale announces it instead
    }
    // AGENT GROWTH: subscribe XP/Level/Confidence to the real run-outcome bus. Seeds agent.stats +
    // the station rollup, pushes the live numbers to the world HUD, and fires level-up celebrations.
    if (typeof XpStore !== 'undefined') { XpStore.init({ getAgent: () => agent, station: pendingStationStats, persist: persist }); pendingStationStats = null; }
    // PERSONALIZATION: the local user-affinity profile — folds the interest tag of each task + shipped work
    // into a tiny histogram (profile.js engine). Resume the saved slice, else start fresh + seed cold-start
    // from the agent's deployed specialty domain so day-one suggestions aren't blank.
    if (typeof ProfileStore !== 'undefined') {
      ProfileStore.init({ profile: pendingProfile, persist: persist }); pendingProfile = null;
      if (agent.specialtyId && typeof Specialties !== 'undefined' && typeof Classify !== 'undefined') {
        const sp = Specialties.get(agent.specialtyId);
        if (sp) ProfileStore.seed(Classify.getTag((sp.purpose || '') + ' ' + (sp.tagline || '')));
      }
    }
    Chat.init({ system: agent.systemPrompt, name: agent.name, ws: Workstreams.active(), onTurn: persist });
    if (typeof Voice !== 'undefined') Voice.init({ name: agent.name, personaId: agent.personaId, resumeCue: !opts.awaitingPurpose });   // mic + this agent's per-persona voice; offer hands-free resume except during the awakening
    syncChannels();   // if a Telegram bot auto-started from saved config, refresh it to THIS agent's live identity
    renderRail();
    el('ws-new').onclick = newWorkstream;
    if (opts.awaitingPurpose && typeof Onboarding !== 'undefined') {
      // THE AWAKENING — a guided first meeting that authors identity/purpose/context/operating-manual.md
      // while the room rises from dark to first light. Replaces the old single "what is my purpose?" beat.
      Onboarding.start({
        name: agent.name,
        docs: agentDocs(agent),
        wake: !!opts.wake,
        specialty: opts.specialty || null,                   // if recruited from the Roster, the awakening skips re-asking the mission
        commit: applyAgentConfig,                            // each answer folds a real doc into the live prompt + persists
        done: persist,
        notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null
      });
    }
    el('btn-disconnect').onclick = disconnect;
  }

  // (the single-question purpose interview was replaced by the AWAKENING — Onboarding authors purpose.md
  //  and the other config docs through applyAgentConfig; see onboarding.js + enterGame.)

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
  // switching mid-run is fine now: each workstream keeps its own run-state in Channels (channels.js) and
  // Chat.load re-renders the in-flight stream on switch — the run you left keeps streaming in the background.
  function switchWorkstream(id) {
    if (id === Workstreams.activeId()) return;
    const ws = Workstreams.switch(id); if (!ws) return;
    SFX.click(); Chat.load(ws); refreshUsage(); renderRail(); persist();
  }
  function newWorkstream() {
    const ws = Workstreams.create(null);
    SFX.open(); Chat.load(ws); refreshUsage(); renderRail(); persist();
  }

  function disconnect() { if (typeof Onboarding !== 'undefined' && Onboarding.stop) Onboarding.stop(); SFX.close(); Chat.abort(); World.stop(); persist(); if (typeof StationUI !== 'undefined') StationUI.leave(); showTitle(); }

  /* ---------- title ---------- */
  function showTitle() {
    const saved = Save.has() ? Save.load() : null;
    const has = !!(saved && saved.agent);
    el('btn-resume').classList.toggle('hidden', !has);
    el('btn-newagent').classList.toggle('hidden', !has);
    el('btn-begin').classList.toggle('hidden', has);
    el('btn-export').classList.toggle('hidden', !has);   // only export when there's an agent to back up
    if (has) el('btn-resume').textContent = '▮ RESUME — ' + saved.agent.name + ' ▮';
    show('screen-title');
  }

  function startCreation() { SFX.boot(); SFX.open(); resumingSaved = null; show('screen-connect'); initConnect(); }

  /* ---------- boot ---------- */
  async function init() {
    if (Harness.init) await Harness.init();   // desktop: load the keychain "configured?" flag first
    if (typeof StationUI !== 'undefined') StationUI.init();   // applies saved theme/CRT settings, wires the bottom bar
    el('btn-begin').onclick = startCreation;
    el('btn-newagent').onclick = () => { SFX.click(); Save.clear(); startCreation(); };
    el('btn-resume').onclick = () => { const s = Save.load(); if (s) { SFX.open(); resumeInto(s); } };

    // data portability — the safety net for the localStorage-fragile agent. Export bundles every
    // skynet.* key + a memory snapshot into one file; import restores it on any browser.
    const dataStatus = m => { const n = el('data-status'); if (n) n.textContent = m || ''; };
    el('btn-export').onclick = async () => {
      SFX.click(); dataStatus('exporting…');
      const r = await Backup.exportAll();
      dataStatus(r && r.ok
        ? 'saved ' + r.file + ' — ' + r.keys + ' keys' + (r.notes ? ' + ' + r.notes + ' memories' : '')
        : 'export failed');
    };
    const fileImport = el('file-import');
    el('btn-import').onclick = () => { SFX.click(); fileImport.value = ''; fileImport.click(); };
    fileImport.onchange = async () => {
      const f = fileImport.files && fileImport.files[0];
      if (!f) return;
      const r = await Backup.importFile(f);
      if (!r.ok) { dataStatus('import failed — ' + r.error); SFX.error && SFX.error(); return; }
      SFX.boot();
      dataStatus('restored ' + (r.agentName || 'agent') + ' — ' + r.keys + ' keys' + (r.memories ? ' (' + r.memories + ' memories in file)' : ''));
      showTitle();   // re-render so RESUME surfaces the restored agent
    };

    const saved = Save.load();
    if (saved && saved.agent) {
      // auto-resume on refresh: an OpenRouter key in hand, the desktop keychain holds one (configured),
      // OR the Codex provider (which holds its OAuth tokens server-side — a missing/expired token surfaces
      // as a run error that prompts re-sign-in).
      if (Harness.getKey() || (Harness.configured && Harness.configured()) || Harness.getProv() === 'codex') { resumeInto(saved); return; }
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
