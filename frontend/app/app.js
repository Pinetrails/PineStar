/* SKYNET — app.js : screen flow + wiring.
   title -> connect (create a character) -> game.  Auto-resumes a saved agent on refresh. */
'use strict';

const App = (() => {
  const el = id => document.getElementById(id);
  const SUITS = ['#5ad0ff', '#3dff70', '#ff8f3d', '#c08bff', '#ff5c9d', '#ffd34a'];

  let agent = null;           // the FOCUSED agent — COMMS + camera target. Every existing `agent.` reference still
                              //   reads "the agent in front of you"; summon adds more, focus repoints this pointer.
  const agents = new Map();   // agentId -> agent object (hero + summoned crew) — the live multi-agent roster
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
  let pendingDossier = null;      // a saved Commander-dossier slice awaiting DossierStore.init() in enterGame()

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
    // THE COMMANDER DOSSIER: the station-wide model of the user, folded in so every agent knows the
    // Commander (durable beliefs only → the prefix stays byte-stable for the cache). '' until something
    // is known, so a cold station adds nothing here.
    if (typeof DossierStore !== 'undefined') {
      const cd = DossierStore.composeBlock();
      if (cd) p += '\n\n' + cd;
    }
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
    if (typeof DossierStore !== 'undefined') DossierStore.syncDocs(d);   // seed the dossier from any newly-authored onboarding doc (first-seed-wins per doc) BEFORE the recompose
    agent.systemPrompt = composeSystemPrompt(agent);
    if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(agent.systemPrompt);
    syncChannels();   // keep a connected Telegram bot on the SAME (updated) identity — no reconnect needed
    pushRoster();     // a re-specced agent's new identity must reach the sidecar roster (for delegation)
    persist();
  }

  /* ---------- the live agent registry (multi-agent) ----------
     `agent` is the FOCUSED agent; `agents` holds the whole crew. liveAgents() is what the world / bay /
     builder / dossier read. focusAgent(id) repoints COMMS + the run identity at one crew member — the
     focus follows whichever workstream is active (switchWorkstream calls it with the stream's agentId). */
  function liveAgents() { return [...agents.values()]; }
  function registerHero(a) { agents.clear(); agents.set(a.id, a); }   // wake/resume: the hero founds the registry
  function focusAgent(id) {
    const a = agents.get(id) || agents.get('agent');
    if (!a) return;
    agent = a;
    if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(a.systemPrompt);   // runs carry the FOCUSED agent's identity
    const gtA = el('gt-agent'); if (gtA) gtA.textContent = a.name;
    const gtM = el('gt-model'); if (gtM) gtM.textContent = a.model;
    if (typeof World !== 'undefined' && World.focusBody) World.focusBody(a.id);   // Phase C: reframe the camera onto this body
  }
  // the persisted shape of a crew member (systemPrompt is derived, recomposed on rehydrate).
  function serializeAgentLite(a) {
    return { id: a.id, name: a.name, color: a.color, model: a.model, personaId: a.personaId,
             purpose: a.purpose || null, specialtyId: a.specialtyId || null, docs: a.docs, createdAt: a.createdAt };
  }
  // restore summoned crew from a save (older saves have no `agents[]` → just the hero, exactly as before).
  // DATA only — world bodies are spawned in enterGame once World.init has run.
  function rehydrateRoster(savedAgents) {
    if (!Array.isArray(savedAgents)) return;
    for (const s of savedAgents) {
      if (!s || !s.id || s.id === 'agent' || agents.has(s.id)) continue;   // hero already registered; skip dups
      const a = { id: s.id, name: s.name, color: s.color, model: s.model || (agent && agent.model),
                  personaId: s.personaId, purpose: s.purpose || null, specialtyId: s.specialtyId || null,
                  docs: s.docs, createdAt: s.createdAt || Date.now() };
      agentDocs(a);
      a.systemPrompt = composeSystemPrompt(a);
      agents.set(a.id, a);
      registerAgent(a.id, a.color);   // sprite tint shim
    }
  }

  /* ---------- THE RECRUITMENT BAY (in-game) ----------
     Open the marketplace against the LIVE agent: DEPLOY a specialty (re-specs purpose + standing orders
     through the very same applyAgentConfig path the dossier uses) or SAVE this agent as a reusable
     specialty. Voice + spend are left untouched — deploy re-shapes the job, not the personality. */
  function openDeployBay(startTab) {
    if (typeof Marketplace === 'undefined' || !agent) return;
    SFX.click();
    Marketplace.open({
      mode: 'deploy',
      tab: (startTab === 'recipes') ? 'recipes' : 'agents',   // the bay opens on this tab (RECIPES = the mission library)
      agentName: agent.name,
      currentSpecialtyId: agent.specialtyId || null,   // lets the bay flag which card is already DEPLOYED
      notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
      draftFromAgent: () => (typeof Specialties !== 'undefined') ? Specialties.fromAgent(agent) : null,
      onDeploy: deploySpecialty,
      onLaunch: launchRecipe   // the RECIPES tab hands a filled mission back here to run
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

  /* ---------- SUMMON: wake a NEW live agent onto the crew ----------
     The backend already runs any agentId concurrently and isolates its notebook / fs / cost / caps; the
     missing piece was a frontend that mints more than one. summonAgent does exactly that: a conforming
     agentId, a composed identity (reusing the hero's model/provider in Stage 1), its own workstream, and
     focus — so the Commander can task it immediately and it fires a REAL independent run. */
  // fold a specialty's preset purpose + standing orders into an agent's docs — the ONE composer shared by
  // both the wake path and summon, so a recruited identity is assembled identically everywhere.
  function applySpecialty(a, spec) {
    if (!spec || typeof Specialties === 'undefined') return;
    const patch = Specialties.compose(spec);
    if (!patch) return;
    agentDocs(a);
    a.docs.purpose = patch.purpose; a.docs.manual = patch.manual;
    a.purpose = (patch.purpose || '').trim();
    a.specialtyId = spec.id;
  }
  // a backend-valid, collision-free agentId for a summon (never the hero's reserved 'agent').
  function allocAgentId(spec) {
    const seed = (spec && (spec.id || spec.name)) || 'agent';
    return (typeof AgentId !== 'undefined') ? AgentId.alloc(seed, agents) : ('summon-' + (agents.size + 1));
  }
  function summonAgent(spec) {
    if (!agent) return null;                                   // need a base context (model/provider): a woken hero
    const id = allocAgentId(spec);
    const a = {
      id, name: ((spec && spec.name) || 'AGENT').toUpperCase().slice(0, 18),
      color: SUITS[agents.size % SUITS.length], model: agent.model,
      personaId: (spec && spec.persona && typeof Personas !== 'undefined' && Personas.exists(spec.persona)) ? spec.persona : agent.personaId,
      purpose: null, createdAt: Date.now()
    };
    agentDocs(a);
    applySpecialty(a, spec);
    a.systemPrompt = composeSystemPrompt(a);
    agents.set(id, a);
    registerAgent(id, a.color);                                // sprite tint shim
    if (typeof World !== 'undefined' && World.spawnAgent) World.spawnAgent(a);   // Phase C: a real floor body
    if (typeof StationUI !== 'undefined' && StationUI.setRoster) StationUI.setRoster(liveAgents());
    // a fresh workstream BOUND to the new agent; focusing it routes COMMS + the next run to this identity
    const ws = (typeof Workstreams !== 'undefined') ? Workstreams.create(a.name) : null;
    if (ws && typeof Workstreams.setAgent === 'function') Workstreams.setAgent(ws.id, id);
    focusAgent(id);
    if (ws && typeof Chat !== 'undefined' && Chat.load) Chat.load(ws);
    refreshUsage(); renderRail(); persist();
    pushRoster();   // the new worker is now delegatable by the lead
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(a.name + ' summoned — give it a task', 'good');
    return a;
  }
  // open the Recruitment Bay in SUMMON mode (reuses pick-mode's specialist grid; RECRUIT → summonAgent).
  function openSummonBay() {
    if (typeof Marketplace === 'undefined' || !agent) return;
    SFX.click();
    Marketplace.open({ mode: 'pick', summon: true, notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null, onPick: summonAgent });
  }

  // LAUNCH a recipe (from the Recipe library's RECIPES tab): mint a fresh workstream named after the mission, then
  // Chat.send the param-filled directive so the agent picks it up. A recipe sends WORK to whatever agent is deployed
  // — it never re-specs identity (that is what the AGENTS tab / deploy is for), so it never touches the agent's
  // purpose or specialtyId. Chat.send classifies it as a real task AND folds its interest tag into the profile, so
  // launching missions also sharpens future recommendations. Returns true once the run is kicked off, false on a
  // no-op (no agent / empty directive) so the bay can report success honestly. Mirrors newWorkstream() + the send.
  function launchRecipe(recipe, values) {
    if (!agent || typeof Recipes === 'undefined' || !recipe) return false;
    const text = Recipes.fillTask(recipe, values || {});
    if (!text) return false;                                              // nothing to send → report the no-op honestly
    const ws = (typeof Workstreams !== 'undefined') ? Workstreams.create(recipe.name || 'Mission') : null;
    if (ws && typeof Chat !== 'undefined' && Chat.load) Chat.load(ws);   // make the new stream the compose target before sending
    refreshUsage(); renderRail();
    if (typeof Chat !== 'undefined' && Chat.send && !Chat.isBusy()) Chat.send(text);   // kicks off the run on the fresh stream
    persist();
    return true;
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

  // Stage 2: push the LIVE crew identities to the sidecar so a lead's team.dispatch can run a worker AS itself
  // (its composed system prompt + model) and the lead's prompt can list the crew. Fire-and-forget; called at the
  // few roster-change points (summon / wake / resume / config edit). Base prompts only — the lead's [YOUR CREW]
  // block is injected server-side, so workers never carry a delegate instruction.
  function rosterRole(a) {
    const spec = (a.specialtyId && typeof Specialties !== 'undefined' && Specialties.get) ? Specialties.get(a.specialtyId) : null;
    if (spec) return String(spec.tagline || spec.name || '').slice(0, 120);
    return String(a.purpose || 'general specialist').slice(0, 120);
  }
  function pushRoster() {
    try {
      const list = liveAgents().map(a => ({ agentId: a.id, system: a.systemPrompt || '', name: a.name || a.id, model: a.model || '', role: rosterRole(a) }));
      fetch('/api/roster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents: list }) }).catch(() => {});
    } catch (_) {}
  }

  function persist() {
    if (!agent) return;
    // the save ROOT is ALWAYS the hero ('agent'), never the transiently-FOCUSED crew member — otherwise a
    // persist while a summoned agent is focused would overwrite the hero identity and corrupt resume.
    const hero = agents.get('agent') || agent;
    const stationStats = (typeof XpStore !== 'undefined') ? XpStore.stationStats() : undefined;
    const prov = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : undefined;   // persist the provider so a codex agent resumes without a key prompt after a wipe/origin-reset
    const profile = (typeof ProfileStore !== 'undefined') ? ProfileStore.serialize() : undefined;
    const roster = liveAgents();
    const dossier = (typeof DossierStore !== 'undefined') ? DossierStore.serialize() : undefined;   // the station-wide Commander model
    const doc = Save.write(Object.assign({ agent: hero, agents: roster.length > 1 ? roster.map(serializeAgentLite) : undefined, usage: Harness.totals(), prov, station: station ? station.serialize() : undefined, stationStats, profile, dossier }, Workstreams.serialize()));
    if (doc && typeof CloudSave !== 'undefined') CloudSave.push(doc);   // durable write-through to the sidecar (debounced, best-effort)
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
    if (pickedSpecialty) applySpecialty(agent, pickedSpecialty);   // a roster-recruited wake is specced before the prompt composes
    agent.systemPrompt = composeSystemPrompt(agent);
    registerHero(agent);   // found the multi-agent registry with the hero
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
    registerHero(agent);                           // found the registry with the hero…
    rehydrateRoster(saved.agents);                 // …then restore any summoned crew (older saves: no-op)
    if (saved.prov && Harness.setProv) Harness.setProv(saved.prov);   // keep the provider with the agent (codex vs openrouter)
    Harness.setModel(agent.model || Harness.getModel());
    Harness.setTotals(saved.usage || { tokens: 0, cost: 0, calls: 0 });
    Workstreams.init({ workstreams: saved.workstreams, activeId: saved.activeId, generalId: saved.generalId });
    pendingStationDoc = saved.station || null;   // restore the built station (if any)
    pendingStationStats = saved.stationStats || null;   // restore the station-growth rollup (XP/level/confidence)
    pendingProfile = saved.profile || null;   // restore the learned user-affinity profile
    pendingDossier = saved.dossier || null;   // restore the station-wide Commander dossier
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
    // give resumed summoned crew their real floor bodies now that the station/geo is loaded (no-op for a
    // single-agent save; summon-during-game spawns its own body directly).
    for (const a of liveAgents()) if (a.id !== agent.id && typeof World.spawnAgent === 'function') World.spawnAgent(a);
    if (typeof Build !== 'undefined') {
      // agents: the live multi-agent roster the BAY agent-picker / builder offer. The bay->agent binding
      // persists via station.serialize (prop.agentId round-trips), so the routing floor is saved per agent.
      Build.init({ getStation: () => station, persist: persist, world: World, agents: () => liveAgents().map(a => ({ id: a.id, name: a.name, color: a.color })) });
      const bbBuild = el('bb-build');
      if (bbBuild) {
        let seenBuild = false; try { seenBuild = !!localStorage.getItem('skynet.refit.seen'); } catch (e) {}
        if (!seenBuild) bbBuild.classList.add('refit-nudge');   // pulse the dock button until first opened
        bbBuild.onclick = () => { SFX.click(); bbBuild.classList.remove('refit-nudge'); Build.toggle(); };
      }
    }
    const bbRoster = el('bb-roster');
    if (bbRoster) bbRoster.onclick = () => openDeployBay('agents');   // the in-game Recruitment Bay (AGENTS tab)
    const bbSummon = el('bb-summon');
    if (bbSummon) bbSummon.onclick = openSummonBay;   // SUMMON a NEW agent onto the crew

    const bbMissions = el('bb-missions');
    if (bbMissions) bbMissions.onclick = () => openDeployBay('recipes');   // straight to the RECIPES (mission) library tab
    if (typeof StationUI !== 'undefined') {
      StationUI.enter(liveAgents(), {
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
    // AUTO-MINT: watch for recurring task shapes so the bay can propose saving them as one-tap missions. Self-
    // persists to its own localStorage key (rides the backup prefix), so init just hydrates from there. One learning
    // switch: reconcile mint to the PROFILE's enabled flag (the source of truth) so a partial restore can't leave the
    // glass-box PAUSE and the SUGGESTED shelf disagreeing.
    if (typeof MintStore !== 'undefined') {
      MintStore.init();
      if (typeof ProfileStore !== 'undefined' && ProfileStore.enabled && MintStore.setEnabled) MintStore.setEnabled(ProfileStore.enabled());
    }
    // COMMANDER DOSSIER: the one station-wide model of the user (dossier.js engine). Resume the saved slice,
    // seed it once from the onboarding docs the Commander authored, and fold it into EVERY agent's system
    // prompt so a freshly-deployed agent already knows the Commander. A panel edit recomposes the live prompt.
    if (typeof DossierStore !== 'undefined') {
      DossierStore.init({
        dossier: pendingDossier, docs: agentDocs(agent), persist: persist,
        onMutate: () => { if (!agent) return; agent.systemPrompt = composeSystemPrompt(agent); if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(agent.systemPrompt); persist(); }
      });
      pendingDossier = null;
      agent.systemPrompt = composeSystemPrompt(agent);   // include the dossier block before Chat.init reads it below
    }
    Chat.init({ system: agent.systemPrompt, name: agent.name, ws: Workstreams.active(), onTurn: persist });
    if (typeof Voice !== 'undefined') Voice.init({ name: agent.name, personaId: agent.personaId, resumeCue: !opts.awaitingPurpose });   // mic + this agent's per-persona voice; offer hands-free resume except during the awakening
    syncChannels();   // if a Telegram bot auto-started from saved config, refresh it to THIS agent's live identity
    pushRoster();     // Stage 2: seed the sidecar with the live crew so the lead can delegate (no-op for a solo station)
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
    SFX.click();
    focusAgent(ws.agentId || 'agent');   // the focused agent follows the stream's binding (multi-agent COMMS)
    Chat.load(ws); refreshUsage(); renderRail(); persist();
  }
  function newWorkstream() {
    const ws = Workstreams.create(null);
    SFX.open(); Chat.load(ws); refreshUsage(); renderRail(); persist();
  }

  function disconnect() { if (typeof Onboarding !== 'undefined' && Onboarding.stop) Onboarding.stop(); if (typeof Intake !== 'undefined' && Intake.stop) Intake.stop(); SFX.close(); Chat.abort(); World.stop(); persist(); if (typeof StationUI !== 'undefined') StationUI.leave(); showTitle(); }

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
      const mem = (typeof r.memoriesRestored === 'number') ? r.memoriesRestored
        : (r.memories ? r.memories + ' in file' : 0);
      dataStatus('restored ' + (r.agentName || 'agent') + ' — ' + r.keys + ' keys'
        + (mem ? ' + ' + mem + ' memories' : ''));
      showTitle();   // re-render so RESUME surfaces the restored agent
    };

    // durable restore: adopt whichever of {localStorage cache, sidecar mirror} is NEWER. This is what brings
    // the agent back after a browser-cache wipe (local gone, the sidecar still holds it) and refreshes the
    // cache to match. Best-effort: an unreachable sidecar just falls back to the local cache.
    if (typeof CloudSave !== 'undefined') CloudSave.installUnloadFlush();
    const saved = (typeof CloudSave !== 'undefined') ? await CloudSave.reconcile(Save.load()) : Save.load();
    // restore the provider BEFORE the credential check so a codex agent (tokens server-side) jumps straight
    // in after a wipe/origin-reset instead of being misrouted to an OpenRouter key prompt.
    if (saved && saved.prov && Harness.setProv) Harness.setProv(saved.prov);
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
