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
  const ORCH_COLOR = '#ffd34a';   // the Orchestrator's suit tint — gold marks the lead (same gold as SUITS' last entry). No color picker any more (skins are the visual identity); summoned crew cycle SUITS.
  let pickedColor = ORCH_COLOR;
  let pickedSkin = (typeof DATA !== 'undefined' && DATA.DEFAULT_SKIN) || 'bear';   // the sprite set the new agent will wear
  let pickedPersona = (typeof Personas !== 'undefined') ? Personas.DEFAULT_ID : 'confidant';
  let pickedTraits = {};        // the VOICE & MANNER fine-tune dials (warmth/humor/formality/length + emoji/blunt) — only set keys contribute prompt text
  let pickedCustomVoice = '';   // the Commander's free-text "in their own words" voice note (optional)
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
  function baseIdentity(name, role) {
    // HONESTY (truthful-telemetry law): the floor is REAL — a run's tools are EXACTLY the caps the Commander has
    // placed in this agent's room (compute is the only freebie; web/files/terminal must be placed — see
    // sidecar/capability/office.js + capgate F1). So the identity must NOT promise web/files unconditionally; it
    // tells the agent to use whatever it's actually been granted and to SAY when a tool is missing (that's the
    // signal that teaches the Commander what to place next), never to pretend a reach it doesn't have.
    let s = 'You are ' + name + ', an AI agent operating from a workstation aboard the STARNET station — a room '
      + 'your Commander (the user) is building for you. Address the user as "Commander" and keep a spark of personality. '
      + 'Your workstation grants you REAL tools — exactly the ones the Commander has placed in your room (web search/read, '
      + 'file read/write, a terminal, memory, and more as the station grows; compute to think is always yours). When the '
      + 'Commander assigns a TASK, use the tools you actually have to do the real work and report what you find. If a job '
      + 'needs a tool you have not been granted yet, say so plainly and tell the Commander what to place — never pretend a '
      + 'reach you do not have, and never claim a tool is missing when it is in your room. When you are just chatting out '
      + 'loud, keep replies short and easy; when you are typing in the COMMS panel you can go into as much detail as the '
      + 'question deserves. Stay in character.';
    // The ORCHESTRATOR is the station's founding agent — and, on a fresh station, its ONLY agent. The clause is
    // strictly READINESS-framed: it does the work itself now and GROWS into directing a crew the Commander recruits
    // later (the team.dispatch tool only exists once a crew does). It must never speak in the present as if it already
    // commands a crew — that would be the app-lie the awakening + tutorial are careful to avoid.
    if (role === 'orchestrator') {
      s += ' You are this station\'s ORCHESTRATOR — its first agent and its lead, and right now its only agent. For now '
        + 'you simply do the work yourself. As the Commander recruits specialists over time, you grow into the one who '
        + 'breaks a big job into pieces and hands them out — you gain a team.dispatch tool to delegate the moment there '
        + 'is a crew to delegate to, and not before. Until then, never speak as if you command a crew you do not yet have; '
        + 'just keep the work moving and keep the Commander oriented on what is done, what is in flight, and what needs them.';
    }
    return s;
  }
  // seed the editable docs from the agent's existing fields the first time (back-compat for saves with no docs).
  function agentDocs(a) {
    if (!a.docs || typeof a.docs !== 'object') a.docs = {};
    if (typeof a.docs.identity !== 'string') a.docs.identity = baseIdentity(a.name, a.role);
    if (typeof a.docs.purpose !== 'string') a.docs.purpose = a.purpose || '';
    if (typeof a.docs.manual !== 'string') a.docs.manual = '';
    if (typeof a.docs.context !== 'string') a.docs.context = '';   // about the Commander & their world (authored at the awakening; back-filled for older saves)
    return a.docs;
  }
  // MIGRATION (pre-overhaul saves): the OLD awakening Beat 1 baked the chosen voice into identity.md as a
  // literal "VOICE & MANNER:\n<free text>" block. Voice now comes from the chosen archetype (Personas.compose),
  // so a legacy save would otherwise carry TWO competing voices. Strip the inline block once on resume —
  // marker-guarded so it's idempotent and never touches a post-overhaul identity (which has no such block).
  function stripLegacyVoiceBlock(a) {
    const id = a && a.docs && a.docs.identity;
    if (typeof id === 'string' && /\n+VOICE & MANNER:/.test(id)) {
      a.docs.identity = id.split(/\n+VOICE & MANNER:/)[0].trimEnd();
    }
  }
  // assemble the real system prompt from the config docs: identity + PERSONALITY + mission + standing orders.
  function composeSystemPrompt(a) {
    const d = agentDocs(a);
    let p = (d.identity || '').trim() || baseIdentity(a.name, a.role);
    // personality sits AFTER identity (keeps the REAL-tools clause) and BEFORE purpose, so it colours the
    // agent's tone without ever displacing capability or the mission. Personas.compose folds the chosen
    // archetype + the Commander's fine-tune dials + their free-text voice note into one block. Default: confidant.
    if (typeof Personas !== 'undefined' && Personas.compose) {
      const voice = Personas.compose(a.personaId || Personas.DEFAULT_ID, a.voiceTraits, a.customVoice);
      if (voice) p += '\n\n' + voice;
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
    return { id: a.id, name: a.name, color: a.color, skin: a.skin || DATA.DEFAULT_SKIN, model: a.model, personaId: a.personaId,
             role: a.role || (a.id === 'agent' ? 'orchestrator' : 'specialist'), voiceTraits: a.voiceTraits || null, customVoice: a.customVoice || '',
             purpose: a.purpose || null, specialtyId: a.specialtyId || null, docs: a.docs, createdAt: a.createdAt };
  }
  // restore summoned crew from a save (older saves have no `agents[]` → just the hero, exactly as before).
  // DATA only — world bodies are spawned in enterGame once World.init has run.
  function rehydrateRoster(savedAgents) {
    if (!Array.isArray(savedAgents)) return;
    for (const s of savedAgents) {
      if (!s || !s.id || s.id === 'agent' || agents.has(s.id)) continue;   // hero already registered; skip dups (so the 'specialist' default below is always correct here — the orchestrator never routes through this path)
      const a = { id: s.id, name: s.name, color: s.color, skin: s.skin || DATA.DEFAULT_SKIN, model: s.model || (agent && agent.model),
                  personaId: s.personaId, role: s.role || 'specialist', voiceTraits: s.voiceTraits || null, customVoice: s.customVoice || '',
                  purpose: s.purpose || null, specialtyId: s.specialtyId || null,
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
      id, name: ((spec && spec.name) || 'AGENT').toUpperCase().slice(0, 18), role: 'specialist',   // summoned crew are specialists under the Orchestrator
      color: SUITS[agents.size % SUITS.length], skin: (spec && spec.skin) || DATA.DEFAULT_SKIN, model: agent.model,
      personaId: (spec && spec.persona && typeof Personas !== 'undefined' && Personas.exists(spec.persona)) ? spec.persona : agent.personaId,
      purpose: null, createdAt: Date.now()
    };
    agentDocs(a);
    applySpecialty(a, spec);
    a.systemPrompt = composeSystemPrompt(a);
    agents.set(id, a);
    registerAgent(id, a.color);                                // sprite tint shim
    const _spawned = (typeof World !== 'undefined' && !!World.spawnAgent);
    if (_spawned) World.spawnAgent(a);                          // Phase C: a real floor body
    else console.warn('[summon] World.spawnAgent missing — no floor body for', id);
    if (typeof StationUI !== 'undefined' && StationUI.setRoster) StationUI.setRoster(liveAgents());
    else console.warn('[summon] StationUI.setRoster missing — crew manifest not refreshed');
    try { console.log('[summon]', JSON.stringify({ id, name: a.name, skin: a.skin, hadHero: !!agent, worldSpawn: _spawned, crew: (typeof World !== 'undefined' && World.crewCount) ? World.crewCount() : '?', roster: agents.size })); } catch (e) {}
    // a fresh workstream BOUND to the new agent; focusing it routes COMMS + the next run to this identity
    const ws = (typeof Workstreams !== 'undefined') ? Workstreams.create(a.name) : null;
    if (ws && typeof Workstreams.setAgent === 'function') Workstreams.setAgent(ws.id, id);
    focusAgent(id);
    if (ws && typeof Chat !== 'undefined' && Chat.load) Chat.load(ws);
    refreshUsage(); renderRail(); persist();
    pushRoster();   // the new worker is now delegatable by the lead
    const _notify = (typeof StationUI !== 'undefined' && StationUI.notify) ? StationUI.notify : (m) => console.log('[summon]', m);
    _notify(a.name + ' summoned — type to task it now. Open REFIT to give it its OWN PC (every agent needs one to take floor work).', 'good');
    return a;
  }
  // open the Recruitment Bay in SUMMON mode (reuses pick-mode's specialist grid; RECRUIT → summonAgent).
  let concurrentCap = null;   // server MAX_CONCURRENT_AGENTS (how many agents RUN at once) — fetched once, kept honest
  function openSummonBay() {
    if (typeof Marketplace === 'undefined' || !agent) return;
    SFX.click();
    const go = () => Marketplace.open({ mode: 'pick', summon: true, concurrentCap: concurrentCap, notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null, onPick: summonAgent });
    // surface the REAL concurrency ceiling in the bay so "summon as many as you like" doesn't imply they all
    // run at once (the gate refuses excess parallel workers). Fetch once; open immediately thereafter.
    if (concurrentCap != null) return go();
    fetch('/api/limits').then(r => r.json()).then(j => { concurrentCap = (j && +j.maxConcurrentAgents) || null; }).catch(() => {}).then(go);
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
      const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
      const body = {
        agentId: (ws && ws.agentId) || 'agent',
        system: agent.systemPrompt || '',
        agentName: agent.name || '',
        model: (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '',
        provider
      };
      const key = (typeof Harness !== 'undefined' && Harness.getKey) ? Harness.getKey() : '';
      if (key) body.key = key;
      fetch('/api/channels/telegram/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
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
      const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
      const list = liveAgents().map(a => ({ agentId: a.id, system: a.systemPrompt || '', name: a.name || a.id, model: a.model || '', provider, role: rosterRole(a) }));
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
    if (list.length) {
      countEl.textContent = '(' + list.length + ' available)';
      if (!inp.value) {
        const pref = list.find(m => /claude.*sonnet|gpt-4o|gpt-5/i.test(m.id)) || list[0];
        inp.value = pref.id;   // DEFAULT-FILL so a first ⏼ WAKE never bounces on an empty model (matches the Codex path, which already defaults)
        inp.placeholder = 'e.g. ' + pref.id;
      }
    } else {
      // catalog unreachable (no network to openrouter.ai, or fetch blocked): DON'T leave the field
      // looking like it's still loading. Seed a few common slugs and make the placeholder actionable
      // so the screen stays usable — you can always just type the slug you use.
      const FALLBACK = ['gpt-5.5', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.8', 'openai/gpt-5', 'google/gemini-2.5-pro'];
      for (const id of FALLBACK) { const o = document.createElement('option'); o.value = id; dl.appendChild(o); }
      countEl.textContent = '(catalog offline — type or pick a slug)';
      if (!inp.value) { inp.value = FALLBACK[0]; inp.placeholder = 'type a model slug — e.g. gpt-5.5'; }   // default-fill even offline so WAKE works; the Commander can overtype
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
    // the BYOK note talks about your key on 127.0.0.1 / the OS keychain — irrelevant and contradictory on the
    // ChatGPT-sub path (no key at all), so hide it there. The codex block carries its own "no per-token cost" note.
    { const bn = el('byok-note'); if (bn) bn.classList.toggle('hidden', isCodex); }
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

  function openExternalUrl(url) {
    try {
      const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (invoke) {
        invoke('open_external_url', { url }).catch(() => {
          try { window.open(url, '_blank', 'noopener'); } catch (_) {}
        });
        return;
      }
    } catch (_) {}
    try { window.open(url, '_blank', 'noopener'); } catch (_) {}
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
    openBtn.onclick = () => openExternalUrl(d.verification_uri);
    statusEl.innerHTML = 'enter this code at <b>' + d.verification_uri + '</b> (opening it now)…';
    openExternalUrl(d.verification_uri);
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

  // the SKIN picker: choose which sprite set (teddy bear, pepe, …) the new agent wears. The chosen
  // id rides on agent.skin and is read by the sprite engine (assets.js drawBody → DATA.SKINS).
  function buildSkins() {
    const wrap = el('skin-picker'); if (!wrap || typeof DATA === 'undefined' || !DATA.SKINS) return;
    wrap.innerHTML = '';
    if (!DATA.SKINS[pickedSkin]) pickedSkin = DATA.DEFAULT_SKIN;
    Object.keys(DATA.SKINS).forEach(id => {
      const sk = DATA.SKINS[id];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'skin-thumb' + (id === pickedSkin ? ' sel' : '');
      b.title = sk.name || id;
      const img = document.createElement('img');
      img.src = 'assets/sprites/' + sk.set + '/rot_south.png';
      img.alt = sk.name || id; img.draggable = false;
      b.appendChild(img);
      b.onclick = () => {
        pickedSkin = id;
        [...wrap.children].forEach(x => x.classList.remove('sel')); b.classList.add('sel');
        SFX.click();
      };
      wrap.appendChild(b);
    });
  }

  /* ---------- VOICE & MANNER (the create-screen personality system) ----------
     A grounded archetype is the base; the FINE-TUNE dials + a free-text note tune it past the preset.
     pickedPersona/pickedTraits/pickedCustomVoice flow onto the agent at onWake and into the prompt via
     Personas.compose. Each card shows a sample line so choosing a voice is fun; a live preview echoes
     how the picked voice (plus any tuning) actually sounds. */
  function buildVoice() {
    const wrap = el('voice-archetypes'); if (!wrap || typeof Personas === 'undefined') return;
    if (!Personas.exists(pickedPersona)) pickedPersona = Personas.DEFAULT_ID;
    pickedPersona = Personas.resolve(pickedPersona);   // collapse any legacy id to its grounded archetype
    wrap.innerHTML = '';
    Personas.list().forEach(p => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'archetype' + (p.id === pickedPersona ? ' sel' : '');
      card.title = p.vibe;
      const nm = document.createElement('span'); nm.className = 'arch-name'; nm.textContent = p.name;
      const ln = document.createElement('span'); ln.className = 'arch-line'; ln.textContent = '“' + p.cardLine + '”';
      card.appendChild(nm); card.appendChild(ln);
      card.onclick = () => {
        pickedPersona = p.id;
        [...wrap.children].forEach(x => x.classList.remove('sel')); card.classList.add('sel');
        SFX.click(); renderVoicePreview();
      };
      wrap.appendChild(card);
    });
    buildVoiceTuning();
    renderVoicePreview();
  }

  // the FINE-TUNE dials + toggles + the free-text box (behind the reveal). Rendered from Personas.TRAITS /
  // TOGGLES so the UI and the prompt text it produces can never drift.
  function buildVoiceTuning() {
    const tw = el('voice-traits');
    if (tw && Personas.TRAITS) {
      tw.innerHTML = '';
      Personas.TRAITS.forEach(t => {
        const row = document.createElement('div'); row.className = 'dial-row';
        const lab = document.createElement('span'); lab.className = 'dial-label'; lab.textContent = t.label;
        const seg = document.createElement('div'); seg.className = 'dial-seg';
        seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', t.label + ' (' + t.ends[0] + ' to ' + t.ends[1] + ')');
        const current = (pickedTraits[t.key] == null) ? t.neutral : pickedTraits[t.key];
        for (let n = 0; n < t.prose.length; n++) {
          const cell = document.createElement('button'); cell.type = 'button';
          // mark the NEUTRAL step so the Commander can see (and screen-readers can hear) where "default / untuned" sits.
          cell.className = 'dial-cell' + (current === n ? ' sel' : '') + (n === t.neutral ? ' neutral' : '');
          cell.title = t.prose[n] || ('neutral — leave ' + t.label.toLowerCase() + ' as the preset');
          const lvl = (n === t.neutral) ? 'neutral (default)' : (n < t.neutral ? t.ends[0] : t.ends[1]) + (Math.abs(n - t.neutral) > 1 ? ', strong' : '');
          cell.setAttribute('aria-label', t.label.toLowerCase() + ' — ' + lvl);
          cell.setAttribute('aria-pressed', String(current === n));
          cell.onclick = () => {
            pickedTraits[t.key] = n;
            [...seg.children].forEach((x, xi) => { x.classList.remove('sel'); x.setAttribute('aria-pressed', String(xi === n)); }); cell.classList.add('sel');
            SFX.click(); renderVoicePreview();
          };
          seg.appendChild(cell);
        }
        const ends = document.createElement('span'); ends.className = 'dial-ends'; ends.textContent = t.ends[0] + ' → ' + t.ends[1];
        row.appendChild(lab); row.appendChild(seg); row.appendChild(ends);
        tw.appendChild(row);
      });
    }
    const gw = el('voice-toggles');
    if (gw && Personas.TOGGLES) {
      gw.innerHTML = '';
      Personas.TOGGLES.forEach(g => {
        const b = document.createElement('button'); b.type = 'button';
        b.className = 'vtoggle' + (pickedTraits[g.key] ? ' sel' : '');
        b.textContent = g.label;
        b.onclick = () => {
          pickedTraits[g.key] = !pickedTraits[g.key];
          b.classList.toggle('sel', !!pickedTraits[g.key]); SFX.click(); renderVoicePreview();
        };
        gw.appendChild(b);
      });
    }
    const cv = el('voice-custom');
    if (cv) { cv.value = pickedCustomVoice; cv.oninput = () => { pickedCustomVoice = cv.value; }; }
  }

  // a live preview: how the picked voice sounds, plus a readout of any tuning the Commander applied.
  function renderVoicePreview() {
    const pv = el('voice-preview'); if (!pv || typeof Personas === 'undefined') return;
    const p = Personas.get(pickedPersona);
    const tweaks = [];
    if (Personas.TRAITS) Personas.TRAITS.forEach(t => {
      const v = pickedTraits[t.key];
      if (v != null && v !== t.neutral) tweaks.push(t.ends[v > t.neutral ? 1 : 0]);
    });
    if (Personas.TOGGLES) Personas.TOGGLES.forEach(g => { if (pickedTraits[g.key]) tweaks.push(g.label.toLowerCase()); });
    pv.innerHTML = '';
    const q = document.createElement('div'); q.className = 'vp-quote'; q.textContent = '“' + p.sampleVoiceReply + '”';
    const m = document.createElement('div'); m.className = 'vp-meta';
    m.textContent = p.name + (tweaks.length ? ' · tuned: ' + tweaks.join(', ') : ' · preset, untuned');
    pv.appendChild(q); pv.appendChild(m);
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
    // a fresh create screen carries no stale voice picks — reset the module-level state so fine-tune
    // dials / a custom-voice note from an abandoned create session never ride onto the next agent.
    pickedTraits = {}; pickedCustomVoice = ''; pickedPersona = (typeof Personas !== 'undefined') ? Personas.DEFAULT_ID : 'confidant';
    buildSkins();
    buildVoice();
    el('btn-back').onclick = () => { SFX.click(); stopCodexPoll(); codexFlow = null; showTitle(); };
    el('btn-wake').onclick = onWake;
    // Enter commits from ANY of the core text fields (name / key / model), not just the name — so a Commander
    // who fills the key or types a model slug and hits Enter wakes the agent instead of nothing happening.
    const enterWakes = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); onWake(); } };
    el('in-name').onkeydown = enterWakes;
    el('in-key').onkeydown = enterWakes;
    el('in-model').onkeydown = enterWakes;
    wireAdvancedToggle();
    // provider toggle + ChatGPT sign-in wiring; selectProviderUI() also loads the right model catalog.
    document.querySelectorAll('.provider-row .prov').forEach(b => { b.onclick = () => { SFX.click(); selectProviderUI(b.dataset.prov); }; });
    el('btn-codex-signin').onclick = startCodexSignIn;
    el('btn-codex-logout').onclick = codexLogout;
    selectProviderUI(Harness.getProv());
  }

  // The "FINE-TUNE VOICE" reveal on the create screen: collapses the trait dials + the free-text voice box
  // so the form leads with just the archetype pick. Every input stays in the DOM, so onWake() reads them
  // whether the section is open or shut — pure progressive disclosure, no behaviour change.
  function setAdvanced(open) {
    const body = el('adv-body'), tog = el('adv-toggle');
    if (!body || !tog) return;
    body.hidden = !open;
    tog.setAttribute('aria-expanded', String(open));
    tog.classList.toggle('open', open);
    const caret = tog.querySelector('.adv-caret'); if (caret) caret.textContent = open ? '▾' : '▸';
  }
  function wireAdvancedToggle() {
    const tog = el('adv-toggle'); if (!tog) return;
    setAdvanced(false);   // a fresh connect screen starts collapsed
    tog.onclick = () => { SFX.click(); setAdvanced(el('adv-body').hidden); };
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

    // the FIRST agent is always the station's ORCHESTRATOR — the lead the Commander commissions before any
    // specialist. Its voice is the archetype + fine-tune dials + free-text note picked on this screen; its
    // mission/context/standing-orders are authored in the awakening that follows.
    agent = { id: 'agent', name, role: 'orchestrator', color: pickedColor, skin: pickedSkin || DATA.DEFAULT_SKIN, model,
              personaId: pickedPersona, voiceTraits: Object.assign({}, pickedTraits), customVoice: pickedCustomVoice.trim(),
              purpose: null, onboarded: false, createdAt: Date.now() };   // onboarded flips true only when the awakening's finish() lands — so a refresh mid-awakening replays it instead of stranding (see resumeInto)
    agentDocs(agent);                              // seed identity.md (orchestrator-aware) / purpose.md / operating-manual.md
    agent.systemPrompt = composeSystemPrompt(agent);
    registerHero(agent);   // found the multi-agent registry with the hero
    Harness.resetTotals();
    Workstreams.reset();   // a fresh General stream for the new agent
    pendingStationDoc = null;   // a brand-new station (one shabby starter room) for a new agent
    pendingStationStats = null; // fresh growth meters — XpStore.init seeds them on enterGame
    enterGame({ awaitingPurpose: true, wake: true });   // the Orchestrator authors its mission in the awakening (no pre-spec)
    persist();   // so a refresh mid-onboarding resumes to the purpose step
  }

  /* ---------- resume ---------- */
  function resumeInto(saved) {
    agent = saved.agent;
    if (!agent.role) agent.role = 'orchestrator';  // older hero saves predate the role field — the first agent is the lead
    agentDocs(agent);                              // seed config docs for older saves that predate them
    stripLegacyVoiceBlock(agent);                  // one-time: drop the old awakening's inline VOICE & MANNER so it doesn't double up with the archetype layer
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
    // gate the awakening on the explicit onboarded flag (new saves), falling back to the old !purpose heuristic
    // for pre-flag saves. This fixes the strand where a refresh AFTER the first (purpose) answer — which persists
    // agent.purpose immediately — used to skip the rest of the awakening (context/manual/dawn/tutorial never ran).
    const needsAwakening = (agent.onboarded === undefined) ? !agent.purpose : !agent.onboarded;
    enterGame({ awaitingPurpose: needsAwakening, wake: false });
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
    // the canonical station the builder edits — restored from the save, or a fresh starter room. LOAD it
    // BEFORE World.start() so the first painted frame renders THIS agent's floor — a NEW AGENT must never
    // flash the previous agent's built station (start() paints synchronously off the live geo/cache).
    station = (pendingStationDoc && pendingStationDoc.rooms) ? WorldModel.deserialize(pendingStationDoc) : WorldModel.create();
    pendingStationDoc = null;
    if (typeof World.loadStation === 'function') World.loadStation(station);   // the live world IS the built station
    // give resumed summoned crew their real floor bodies now that the station/geo is loaded (no-op for a
    // single-agent save; summon-during-game spawns its own body directly).
    for (const a of liveAgents()) if (a.id !== agent.id && typeof World.spawnAgent === 'function') World.spawnAgent(a);
    World.start();   // first frame now paints the fresh floor + crew, never a stale frame of the prior world
    if (World.resumeBridge) World.resumeBridge();   // re-arm the channel SSE + connector poll if a prior disconnect released them (no-op on first entry)
    if (typeof Build !== 'undefined') {
      // agents: the live multi-agent roster the BAY agent-picker / builder offer. The bay->agent binding
      // persists via station.serialize (prop.agentId round-trips), so the routing floor is saved per agent.
      Build.init({ getStation: () => station, persist: persist, world: World, agents: () => liveAgents().map(a => ({ id: a.id, name: a.name, color: a.color, model: a.model })) });
      const bbBuild = el('bb-build');
      if (bbBuild) {
        let seenBuild = false; try { seenBuild = !!localStorage.getItem('skynet.refit.seen'); } catch (e) {}
        if (!seenBuild) bbBuild.classList.add('refit-nudge');   // pulse the dock button until first opened
        bbBuild.onclick = () => { SFX.click(); bbBuild.classList.remove('refit-nudge'); Build.toggle(); if (typeof Tutorial !== 'undefined' && Tutorial.onBuildOpen && Build.isOpen && Build.isOpen()) Tutorial.onBuildOpen(); };
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
    // CURIOSITY: the gentle one-per-session "tell me about X" nudge (curiosity.js). Self-persists its
    // dismissals to its own key (rides the backup prefix); init just hydrates + resets the session budget.
    if (typeof CuriosityStore !== 'undefined') CuriosityStore.init();
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
        role: agent.role || 'orchestrator',                  // the first agent wakes as the station's ORCHESTRATOR — the ceremony frames it as the lead
        docs: agentDocs(agent),
        wake: !!opts.wake,
        persona: (typeof Personas !== 'undefined') ? Personas.get(agent.personaId) : null,   // the voice was chosen on the create screen — the awakening acknowledges it instead of re-asking
        specialty: opts.specialty || null,                   // (reserved) a pre-specced wake skips re-asking the mission; the orchestrator authors it live
        commit: applyAgentConfig,                            // each answer folds a real doc into the live prompt + persists
        done: () => { if (agent) agent.onboarded = true; persist(); },   // the awakening landed — mark onboarded so a later refresh resumes into the game, not back into the ceremony
        notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
        // FIRST COMMAND — once the awakening lands, the agent itself teaches the Commander the one real loop (tutorial.js)
        taught: () => { if (typeof Tutorial !== 'undefined' && Tutorial.firstCommand) Tutorial.firstCommand({ name: agent.name }); }
      });
    }
    // P3: arm the first-steps briefing's bus ticks; re-offer the checklist to a returning user mid-progress
    if (typeof Tutorial !== 'undefined' && Tutorial.onEnterGame) Tutorial.onEnterGame();
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

  function disconnect() { if (typeof Onboarding !== 'undefined' && Onboarding.stop && Onboarding.isRunning && Onboarding.isRunning()) Onboarding.stop(); if (typeof Tutorial !== 'undefined' && Tutorial.teardown) Tutorial.teardown(); if (typeof Intake !== 'undefined' && Intake.stop) Intake.stop(); SFX.close(); Chat.abort(); World.stop(); if (World.pauseBridge) World.pauseBridge(); persist(); if (typeof StationUI !== 'undefined') StationUI.leave(); showTitle(); }

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
    el('btn-newagent').onclick = () => {
      SFX.click(); Save.clear();
      // NEW AGENT = a clean slate: also wipe the behavioral stores that self-persist OUTSIDE the save
      // envelope (Save.clear only removes skynet.save). Per the Commander's scope decision, learned
      // task-mining (S1) + curiosity dismissals (S2) are per-agent and reset; one-time UI/consent flags stay.
      if (typeof MintStore !== 'undefined' && MintStore.reset) MintStore.reset();
      if (typeof CuriosityStore !== 'undefined' && CuriosityStore.reset) CuriosityStore.reset();
      startCreation();
    };
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
