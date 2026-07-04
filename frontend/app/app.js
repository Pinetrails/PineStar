/* STARNET — app.js : screen flow + wiring.
   title -> connect (create a character) -> game.  Auto-resumes a saved agent on refresh. */
'use strict';

const App = (() => {
  const el = id => document.getElementById(id);
  // HTML-escape for the rare spot we build a connect message with a link (provider label + signup URL).
  const esc = s => { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; };
  // CRT-muted crew suit tints — distinct per crew member but passed through the amber-phosphor grade (no pure neons). Last entry stays gold to match ORCH_COLOR.
  const SUITS = ['#6fb3bf', '#7bc88a', '#d99a5a', '#a888c0', '#cf7d96', '#ffd34a'];

  let agent = null;           // the FOCUSED agent — COMMS + camera target. Every existing `agent.` reference still
                              //   reads "the agent in front of you"; summon adds more, focus repoints this pointer.
  const agents = new Map();   // agentId -> agent object (hero + summoned crew) — the live multi-agent roster
  let resumingSaved = null;   // a save awaiting a re-entered key
  const ORCH_COLOR = '#ffd34a';   // the Orchestrator's suit tint — gold marks the lead (same gold as SUITS' last entry). No color picker any more (skins are the visual identity); summoned crew cycle SUITS.
  let pickedColor = ORCH_COLOR;
  let pickedSkin = (typeof DATA !== 'undefined' && DATA.DEFAULT_SKIN) || 'bear';   // the sprite set the new agent will wear
  let pickedPersona = (typeof Personas !== 'undefined') ? Personas.DEFAULT_ID : 'professional';
  let pickedTraits = {};        // the VOICE & MANNER fine-tune dials (warmth/humor/formality/length + emoji/blunt) — only set keys contribute prompt text
  let pickedCustomVoice = '';   // the Commander's free-text "in their own words" voice note (optional)
  let pickedApproval = 'ask';   // the APPROVAL mode — 'ask' (consent-gated) | 'full' (auto-approve). Drives the REAL consent broker (sidecar bypass), not a cosmetic toggle.
  let pickedProvider = 'codex';   // BEGINNER-FIRST default: 'codex' (personal ChatGPT sign-in, NO API key) leads the funnel; 'openrouter' (BYO API key) + the rest stay one click away. initConnect() still honours a returning agent's saved provider (selectProviderUI(Harness.getProv())).
  let prefilledKey = '';               // the key the CONNECT field was pre-seeded with from storage (browser BYOK). Empty
                                       //   when nothing was stored (or on desktop, where the key lives in the keychain and
                                       //   getKey() returns ''). Used by onWake's one-time overwrite guard: editing a
                                       //   pre-filled key asks once before it silently replaces the stored one.
  let keyOverwriteConfirmed = false;   // set true once the Commander confirms replacing the pre-filled key (one-time per screen)
  let codexConnected = false;          // last-known /api/auth/codex/status — gates waking on the Codex provider
  let codexFlow = null;                // the in-flight device-code login { device_auth_id, user_code, verification_uri, deadline }
  let codexPoll = null;                // the setTimeout handle for the device-code poll loop
  let station = null;         // the canonical WorldModel station (the builder's source of truth)
  let pendingStationDoc = null; // a saved station doc awaiting enterGame()
  let pendingStationStats = null; // a saved station-growth rollup (XP/level/confidence) awaiting enterGame()
  let pendingProfile = null;      // a saved user-affinity profile slice awaiting ProfileStore.init() in enterGame()
  let pendingWorkSignal = null;   // a saved capability-usage histogram slice awaiting WorkSignalStore.init() in enterGame()
  let pendingDossier = null;      // a saved Commander-dossier slice awaiting DossierStore.init() in enterGame()

  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el(id).classList.add('active');
    positionLogo();
  }

  // the hoisted brand mark (#logo — fixed above the CRT glass, see style.css) tracks the seat
  // #logo-anchor reserves in the topbar: the anchor takes the logo's natural width so the gauge
  // cluster never slides under it, and the logo takes the anchor's on-screen spot.
  function positionLogo() {
    const logo = el('logo'), anchor = el('logo-anchor'), bar = el('topbar');
    if (!logo || !anchor || !bar) return;
    const game = el('screen-game');
    if (!game || !game.classList.contains('active')) return;   // hidden screens have no geometry
    anchor.style.width = logo.offsetWidth + 'px';
    const a = anchor.getBoundingClientRect(), b = bar.getBoundingClientRect();
    logo.style.left = a.left + 'px';
    logo.style.top = (b.top + (b.height - logo.offsetHeight) / 2) + 'px';
  }
  if (typeof window !== 'undefined') window.addEventListener('resize', positionLogo);

  function refreshUsage() {
    // Broad lifetime token totals are intentionally not surfaced in the chrome.
    // The bottom-bar context gauge owns prompt-context display from measured usage events.
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
    if (role === 'orchestrator') s += orchestratorClause();
    return s;
  }
  // The ORCHESTRATOR is the station's founding agent. This clause is TIMELESS on purpose: identity.md is written
  // once into the save (and is Commander-editable), so any crew-size claim baked here would freeze and turn into
  // an app-lie the moment the roster changes — exactly the bug the old "right now its only agent" wording had.
  // The LIVE crew truth rides rosterClause() (derived fresh each compose) + the sidecar's per-run [ORCHESTRATION]
  // block, which alone grants/lists the delegation tools. Extracted so stripLegacySoloClause can migrate old saves
  // onto the exact same text (keeping setAgentName's untouched-default detection working).
  function orchestratorClause() {
    return ' You are this station\'s OVERSEER — its orchestrating lead and first agent. When there is a crew, you are '
      + 'the one who breaks a big job into pieces and hands them out; when there is not, you do the work yourself. '
      + 'Never assume either from memory: your live crew and your delegation tools are stated fresh in each run\'s '
      + 'briefing — trust that briefing, and never claim a crew member or a delegation tool it does not show. '
      + 'Keep the work moving and keep the Commander oriented on what is done, what is in flight, and what needs them.';
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
  // MIGRATION (pre-roster-clause saves): the old orchestrator identity baked "right now its only agent … never
  // speak as if you command a crew" into identity.md at creation — frozen there, it becomes an app-lie the moment
  // the Commander summons a crew (and contradicts the sidecar's per-run [ORCHESTRATION] crew brief). Swap the
  // EXACT old block for the new timeless clause on resume. Literal-match-guarded so it's idempotent and never
  // touches an identity the Commander hand-reworded; producing exactly orchestratorClause() keeps the result
  // byte-equal to a fresh baseIdentity, so setAgentName's untouched-default detection still works after migration.
  const LEGACY_SOLO_CLAUSE = ' You are this station\'s OVERSEER — its orchestrating lead, its first agent, and right now its only agent. For now '
    + 'you simply do the work yourself. As the Commander recruits specialists over time, you grow into the one who '
    + 'breaks a big job into pieces and hands them out — you gain a team.dispatch tool to delegate the moment there '
    + 'is a crew to delegate to, and not before. Until then, never speak as if you command a crew you do not yet have; '
    + 'just keep the work moving and keep the Commander oriented on what is done, what is in flight, and what needs them.';
  function stripLegacySoloClause(a) {
    const id = a && a.docs && a.docs.identity;
    if (typeof id === 'string' && id.indexOf(LEGACY_SOLO_CLAUSE) !== -1) {
      a.docs.identity = id.split(LEGACY_SOLO_CLAUSE).join(orchestratorClause());
    }
  }
  // the APPROVAL clause folded into the system prompt — it MUST match the real consent broker (sidecar) so the
  // agent's words and its actual behaviour never diverge (truthful-telemetry law). 'full' = the broker bypasses
  // the consent gate; 'ask' = the broker prompts the Commander on any mutation/network call.
  function approvalClause(a) {
    const full = a && a.approvalMode === 'full';
    if (full) return '\n\nAPPROVAL — FULL ACCESS: the Commander has granted you full access. You may run your tools — including file writes and shell commands — without stopping to ask each time. A hard safety floor still blocks the most dangerous actions; use judgment and flag anything truly irreversible before you do it.';
    return '\n\nAPPROVAL — ASK FIRST: before any action that writes a file, runs a command, or reaches out over the network, you STOP and ask the Commander for approval, then wait for their go-ahead. Reasoning over what you already have does not need approval.';
  }
  // an always-appended SYSTEM truth: what the agent ACTUALLY runs on. Mirrors approvalClause — derived fresh each
  // compose, never stored in the editable identity.md (so it can't be edited away and never drifts stale). Fixes the
  // "I'm a Hermes agent" misread AND the sibling "I'm a Skynet agent" one: when the agent introspects (env/pwd) it may
  // still meet two legacy names — "Skynet" (the project's former name; renamed to StarNet, but some paths/env survive as
  // back-compat aliases) and "Hermes" (the open-source harness StarNet's backend was ported from). Without this grounding
  // it guesses one of those. Truthful-telemetry law: state only what's true (StarNet harness, Commander's own model), don't guess.
  function foundationClause() {
    return '\n\nYOUR FOUNDATION: You run on the StarNet harness — a local-first agent runtime on the Commander\'s own '
      + 'machine, not a hosted service. Your reasoning comes from whichever model the Commander has connected through '
      + 'their own API key or account. As you look around your environment you may still meet two legacy names, and '
      + 'neither changes what you are: (1) StarNet was previously called "Skynet" — it has been renamed, but some file '
      + 'paths, environment variables, and config keys may still carry the old "Skynet"/"SKYNET_" name as a back-compat '
      + 'alias. (2) StarNet\'s harness was built by porting parts of the open-source Hermes agent harness, so some code, '
      + 'comments, and tool names mention "Hermes". You are a StarNet agent on the StarNet harness — not a Skynet agent '
      + 'and not a Hermes agent. Do not guess at your own foundation from ambiguous signals in the environment; report '
      + 'only what you can actually verify, and say plainly when you are not sure.';
  }
  // the orchestrator's CREW POSTURE — derived fresh each compose like approvalClause/foundationClause, never
  // stored in the editable identity.md (so it can't be edited away and never freezes stale). States only what
  // the harness can prove: the live roster the browser itself pushes to /api/roster (truthful-telemetry law).
  // The sidecar's per-run [ORCHESTRATION] block remains the authority on delegation TOOLS; this clause only
  // keeps the agent's self-image (solo vs leading N named specialists) true between runs. Any roster change
  // must be followed by recomposeOrchestrators() or the composed prompt goes stale (summon / resume / rename).
  function rosterClause(a) {
    if (!a || a.role !== 'orchestrator') return '';
    const crew = liveAgents().filter(x => x && x.id !== a.id);
    if (!crew.length) {
      return '\n\nYOUR CREW: none yet — right now you are this station\'s only agent, so you do the work yourself. '
        + 'Never speak as if you command a crew you do not yet have; you grow into delegation as specialists join the station.';
    }
    const names = crew.map(x => (x.name || x.id) + ' — ' + rosterRole(x)).join('; ');
    // lead-conditional on purpose: this same base prompt also runs the orchestrator as a dispatched WORKER, where
    // no delegation briefing (or tools) exists — it must not instruct delegation unconditionally (see pushRoster).
    return '\n\nYOUR CREW: ' + crew.length + ' specialist' + (crew.length === 1 ? '' : 's') + ' work' + (crew.length === 1 ? 's' : '')
      + ' under your lead: ' + names + '. When you run as the station\'s lead, your run briefing lists the live crew '
      + 'and your delegation tools — hand real subtasks to the right specialist through them and synthesize the '
      + 'results for the Commander.';
  }
  // assemble the real system prompt from the config docs: identity + CREW + FOUNDATION + PERSONALITY + APPROVAL + mission + standing orders.
  function composeSystemPrompt(a) {
    const d = agentDocs(a);
    let p = (d.identity || '').trim() || baseIdentity(a.name, a.role);
    // CREW POSTURE sits right after identity — it corrects/extends the identity's orchestrator framing with the
    // live roster truth, so it must land before anything else colours the prompt. '' for non-orchestrators.
    p += rosterClause(a);
    // FOUNDATION sits right after identity (before personality) — a constant system truth that grounds "what you are"
    // so the agent never mistakes StarNet's Hermes-derived internals for being a Hermes agent. Kept out of the docs.
    p += foundationClause();
    // personality sits AFTER identity (keeps the REAL-tools clause) and BEFORE purpose, so it colours the
    // agent's tone without ever displacing capability or the mission. Personas.compose folds the chosen
    // archetype + the Commander's fine-tune dials + their free-text voice note into one block. Default: professional.
    if (typeof Personas !== 'undefined' && Personas.compose) {
      const voice = Personas.compose(a.personaId || Personas.DEFAULT_ID, a.voiceTraits, a.customVoice);
      if (voice) p += '\n\n' + voice;
    }
    // the APPROVAL posture sits after personality — it tells the agent (truthfully) whether it must ask before
    // acting or has full access, mirroring exactly what the consent broker will do at runtime.
    const ac = approvalClause(a);
    if (ac) p += ac;
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
    // R1 MID-TASK FORK: the fork instruction rides ONLY while the style model's confidence is low
    // (Fork.shouldOffer over the live understanding read) — self-retiring: once the station knows how the
    // Commander likes work done, this block vanishes and forks stop appearing. Fail-closed on any hiccup.
    if (typeof Fork !== 'undefined' && typeof UnderstandingStore !== 'undefined') {
      try { if (Fork.shouldOffer(UnderstandingStore.read())) p += '\n\n' + Fork.directive(); } catch (_) {}
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
      if (typeof patch.model === 'string' && patch.model.trim()) {
        agent.model = patch.model.trim();
        if (typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(agent.model);
        const gtM = el('gt-model'); if (gtM) gtM.textContent = agent.model;
      }
      if (typeof patch.personaId === 'string' && typeof Personas !== 'undefined' && Personas.exists(patch.personaId)) {
        agent.personaId = Personas.resolve ? Personas.resolve(patch.personaId) : patch.personaId;
        if (typeof Voice !== 'undefined' && Voice.init) Voice.init({ name: agent.name, personaId: agent.personaId, resumeCue: false });
      }
      if (typeof patch.approvalMode === 'string') {
        agent.approvalMode = patch.approvalMode === 'full' ? 'full' : 'ask';
      }
      // Away-workshop grant (W3): a plain per-agent consent flag. NOT a system-prompt field — it only
      // changes what an autonomous run is allowed to WRITE inside its own jail. Reaches the sidecar via
      // pushRoster (below) so the consent broker can honor it; the backend lane (W1) reads it there.
      if (typeof patch.workshop === 'boolean') agent.workshop = patch.workshop;
    }
    if (typeof DossierStore !== 'undefined') DossierStore.syncDocs(d);   // seed the dossier from any newly-authored onboarding doc (first-seed-wins per doc) BEFORE the recompose
    agent.systemPrompt = composeSystemPrompt(agent);
    if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(agent.systemPrompt);
    syncChannels();   // keep a connected Telegram bot on the SAME (updated) identity — no reconnect needed
    pushRoster();     // a re-specced agent's new identity must reach the sidecar roster (for delegation)
    persist();
  }

  // P1-6 per-agent MODEL/PROVIDER pin: set (or clear, with blank) this agent's own model/provider. Writes the same
  // a.model/a.provider the dock + focusAgent already use, then pushRoster() so the sidecar roster records the pin
  // (runOnce honors it when a run carries no explicit model; cron already reads it via cronModelFor). Persists.
  // If the pinned agent is the FOCUSED one, retarget the live harness so the very next chat run uses it immediately.
  function setAgentModelPin(agentId, model, provider, effort) {
    const a = agents.get(String(agentId || '')) || (agent && agent.id === agentId ? agent : null);
    if (!a) return false;
    const m = String(model || '').trim();
    const p = String(provider || '').trim();
    a.model = m || null;
    a.provider = p || null;
    // effort is OPTIONAL + additive: written only when the 4th arg is passed (older 3-arg callers untouched); a clear also clears it.
    const hasEffort = (arguments.length >= 4);
    const e = String(effort || '').trim();
    if (hasEffort) a.reasoningEffort = (m && e) ? e : null;
    if (agent && a.id === agent.id) {   // focused agent — apply live so the next run reflects the pin at once
      if (m && typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(m);
      if (p && typeof Harness !== 'undefined' && Harness.setProv) Harness.setProv(p);
      if (hasEffort && a.reasoningEffort && typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(a.reasoningEffort);
      if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
    }
    pushRoster();   // the pin reaches the sidecar roster (honored by runOnce + cron)
    persist();
    if (typeof Chat !== 'undefined' && Chat.refreshIdBar) Chat.refreshIdBar();   // COMMS header model readout stays truthful when the pin changes the on-line agent
    return true;
  }

  // W3 per-agent AWAY-WORKSHOP grant: flip the "build things while I'm away" consent for this agent.
  // The AUTHORITY is the sidecar: POST /api/workshop/grant records the grant server-side (workshopStore)
  // AND arms/disarms the agent's unattended "workshop shift" cron routine — pushRoster alone does NEITHER
  // (the roster ingest drops the workshop field), so without this POST the toggle would be a silent no-op:
  // the shift would never fire. We write a.workshop locally + pushRoster (so the away-driver's dossier still
  // sees the flag) + persist for reload, but the RETURNED promise resolves off the real route so the toggle
  // never asserts a grant the harness didn't record (truthful telemetry). Optimistic caller reverts on false.
  function setAgentWorkshop(agentId, enabled) {
    const a = agents.get(String(agentId || '')) || (agent && agent.id === agentId ? agent : null);
    if (!a) return Promise.resolve(false);
    const on = !!enabled;
    a.workshop = on;
    pushRoster();
    persist();
    return fetch('/api/workshop/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: a.id, on: on }) })
      .then(r => r.json().catch(() => null))
      .then(j => {
        const ok = !!(j && j.ok);
        if (!ok) { a.workshop = !on; pushRoster(); persist(); }   // revert local truth: the station didn't record it
        return ok;
      })
      .catch(() => { a.workshop = !on; pushRoster(); persist(); return false; });
  }

  // Rename an agent from its dossier. The name is DISPLAY identity only — the agentId (the `agents` Map key, the
  // sidecar roster key, the workstream binding) never changes, so a rename cannot break any lookup. We recompose
  // the system prompt (the default identity embeds the name), retarget the live COMMS labels when this is the
  // focused agent, relabel the floor body, then pushRoster + persist. Normalized to the shape summon mints
  // (single-spaced, UPPER, ≤18 chars, non-empty) so a renamed agent is indistinguishable from a freshly-summoned one.
  function setAgentName(agentId, name) {
    const a = agents.get(String(agentId || '')) || (agent && agent.id === agentId ? agent : null);
    if (!a) return false;
    const nm = String(name || '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 18);
    if (!nm) return false;
    const oldName = a.name;
    a.name = nm;
    // agentDocs back-fills docs.identity = baseIdentity(name,role) at creation, and composeSystemPrompt prefers a
    // non-empty docs.identity over baseIdentity(a.name,...) — so recomposing alone would keep the OLD name in the
    // PROMPT (the agent would still introduce itself as its old name in every run). If the identity is still the
    // untouched machine default, regenerate it for the new name; a Commander-authored identity.md is left as-is.
    const d = agentDocs(a);
    if (d && d.identity && d.identity === baseIdentity(oldName, a.role)) d.identity = baseIdentity(nm, a.role);
    a.systemPrompt = composeSystemPrompt(a);              // now the recomposed prompt carries the new name
    if (agent && a.id === agent.id) {                     // focused: retarget the live COMMS identity + label at once
      const gtA = el('gt-agent'); if (gtA) gtA.textContent = a.name;
      if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(a.systemPrompt);
    }
    if (typeof World !== 'undefined' && World.relabel) World.relabel(a.id, a.name);   // the floor nameplate follows
    recomposeOrchestrators();   // a crew rename must reach the lead's YOUR CREW clause (it names specialists)
    if (typeof StationUI !== 'undefined' && StationUI.setRoster) StationUI.setRoster(liveAgents());
    renderRail();
    pushRoster();
    persist();
    return true;
  }

  /* ---------- the live agent registry (multi-agent) ----------
     `agent` is the FOCUSED agent; `agents` holds the whole crew. liveAgents() is what the world / bay /
     builder / dossier read. focusAgent(id) repoints COMMS + the run identity at one crew member — the
     focus follows whichever workstream is active (switchWorkstream calls it with the stream's agentId). */
  function liveAgents() { return [...agents.values()]; }
  function registerHero(a) { agents.clear(); agents.set(a.id, a); }   // wake/resume: the hero founds the registry
  // rosterClause() reads the LIVE registry, so every orchestrator prompt must be recomposed whenever the roster
  // changes shape (summon; crew rehydrate on resume; a crew rename) — this is the cached-systemPrompt trap: the
  // composed prompt is a stored snapshot, not a live view. Callers still pushRoster()/persist() themselves, since
  // every roster-change site already does both right after.
  function recomposeOrchestrators() {
    for (const a of agents.values()) {
      if (!a || a.role !== 'orchestrator') continue;
      a.systemPrompt = composeSystemPrompt(a);
      if (agent && agent.id === a.id && typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(a.systemPrompt);   // focused: the live COMMS session follows
    }
  }
  function focusAgent(id) {
    const a = agents.get(id) || agents.get('agent');
    if (!a) return;
    agent = a;
    if (a.model && typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(a.model);
    // #4: provider + reasoning-effort are PER-AGENT, not one global — restore them on focus so switching to an
    // Anthropic agent right after a Codex one doesn't run the Anthropic model through the codex provider (and the
    // dock label match). Only set when the agent actually carries them, so older agents keep today's behavior.
    if (a.provider && typeof Harness !== 'undefined' && Harness.setProv) Harness.setProv(a.provider);
    if (a.reasoningEffort && typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(a.reasoningEffort);
    if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(a.systemPrompt);   // runs carry the FOCUSED agent's identity
    const gtA = el('gt-agent'); if (gtA) gtA.textContent = a.name;
    const gtM = el('gt-model'); if (gtM) gtM.textContent = a.model;
    if (typeof World !== 'undefined' && World.focusBody) World.focusBody(a.id);   // Phase C: reframe the camera onto this body
    if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
  }
  function shortModelLabel(model) {
    const s = String(model || '').split('/').pop().replace(/[-_]+/g, ' ').trim();
    return (s || 'model').slice(0, 34).toUpperCase();
  }
  function effortLabel(effort) {
    const e = (typeof Harness !== 'undefined' && Harness.normalizeReasoningEffort) ? Harness.normalizeReasoningEffort(effort) : String(effort || 'medium');
    return ({ none: 'OFF', minimal: 'MIN', low: 'LOW', medium: 'MED', high: 'HIGH', xhigh: 'XHIGH', max: 'MAX' })[e] || 'MED';
  }
  function providerLabel(provider) {
    provider = normalizeProviderId(provider);
    const map = {
      codex: 'GPT',
      openrouter: 'OPENROUTER',
      openai: 'OPENAI',
      anthropic: 'ANTHROPIC',
      gemini: 'GEMINI',
      xai: 'XAI',
      groq: 'GROQ',
      mistral: 'MISTRAL',
      deepseek: 'DEEPSEEK',
      together: 'TOGETHER',
      fireworks: 'FIREWORKS',
      perplexity: 'PERPLEXITY',
      cerebras: 'CEREBRAS',
      ollama: 'OLLAMA',
      custom: 'CUSTOM'
    };
    return map[provider] || String(provider || 'openrouter').toUpperCase();
  }
  function normalizeProviderId(provider) {
    const p = String(provider || 'openrouter').trim().toLowerCase();
    if (p === 'codex' || p === 'openai-codex') return 'codex';
    if (p === 'openai' || p === 'openai-api') return 'openai';
    if (p === 'anthropic' || p === 'claude') return 'anthropic';
    if (p === 'gemini' || p === 'google' || p === 'google-ai' || p === 'google-gemini') return 'gemini';
    if (p === 'xai' || p === 'x-ai' || p === 'grok') return 'xai';
    if (p === 'groq') return 'groq';
    if (p === 'mistral' || p === 'mistralai') return 'mistral';
    if (p === 'deepseek') return 'deepseek';
    if (p === 'together' || p === 'together-ai') return 'together';
    if (p === 'fireworks' || p === 'fireworks-ai') return 'fireworks';
    if (p === 'perplexity' || p === 'pplx' || p === 'sonar') return 'perplexity';
    if (p === 'cerebras') return 'cerebras';
    if (p === 'ollama' || p === 'ollama-local') return 'ollama';
    if (p === 'custom' || p === 'openai-compatible' || p === 'local' || p === 'vllm' || p === 'lmstudio') return 'custom';
    return 'openrouter';
  }
  function providerNeedsKey(provider) {
    const p = normalizeProviderId(provider);
    return p !== 'codex' && p !== 'ollama' && p !== 'custom';
  }
  function providerUsesKeyBox(provider) {
    const p = normalizeProviderId(provider);
    return p !== 'codex' && p !== 'ollama';
  }
  function providerNeedsBaseUrl(provider) {
    return normalizeProviderId(provider) === 'custom';
  }
  function providerKeyPlaceholder(provider, configured) {
    const p = normalizeProviderId(provider);
    if (configured) return 'stored locally - leave blank to keep';
    if (p === 'openai') return 'sk-...  -  platform.openai.com/api-keys';
    if (p === 'anthropic') return 'sk-ant-...  -  console.anthropic.com/settings/keys';
    if (p === 'gemini') return 'AIza...  -  aistudio.google.com/app/apikey';
    if (p === 'xai') return 'xai-...  -  console.x.ai';
    if (p === 'groq') return 'gsk_...  -  console.groq.com/keys';
    if (p === 'mistral') return 'Mistral API key';
    if (p === 'deepseek') return 'sk-...  -  platform.deepseek.com/api_keys';
    if (p === 'together') return 'Together API key';
    if (p === 'fireworks') return 'Fireworks API key';
    if (p === 'perplexity') return 'pplx-...  -  perplexity.ai/settings/api';
    if (p === 'cerebras') return 'Cerebras API key';
    if (p === 'custom') return 'optional API key for this endpoint';
    return 'sk-or-...  -  openrouter.ai/keys';
  }
  // Where a NEW user actually GETS a key for this provider — the same destinations the key placeholder
  // hints at, as real URLs so a cold-start message can link them. openrouter.ai/keys is the default.
  function providerSignupUrl(provider) {
    const p = normalizeProviderId(provider);
    const map = {
      openai: 'https://platform.openai.com/api-keys',
      anthropic: 'https://console.anthropic.com/settings/keys',
      gemini: 'https://aistudio.google.com/app/apikey',
      xai: 'https://console.x.ai',
      groq: 'https://console.groq.com/keys',
      mistral: 'https://console.mistral.ai/api-keys',
      deepseek: 'https://platform.deepseek.com/api_keys',
      together: 'https://api.together.ai/settings/api-keys',
      fireworks: 'https://fireworks.ai/account/api-keys',
      perplexity: 'https://www.perplexity.ai/settings/api',
      cerebras: 'https://cloud.cerebras.ai',
      openrouter: 'https://openrouter.ai/keys'
    };
    return map[p] || 'https://openrouter.ai/keys';
  }
  // A sensible default model slug per provider so a cold-start "no model" bounce can SUGGEST one instead of
  // stranding the user on an empty required field. Reuses the curated FALLBACK_MODELS lineup (first = best pick).
  function defaultModelFor(provider) {
    const p = normalizeProviderId(provider);
    const list = FALLBACK_MODELS[p] || FALLBACK_MODELS.openrouter;
    return (list && list[0]) || 'anthropic/claude-sonnet-4.6';
  }
  function applyQuickModel(sel) {
    if (!agent || !sel) return;
    const model = String(sel.model || ((typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '') || '').trim();
    const provider = normalizeProviderId(sel.provider || ((typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter'));
    const effort = (typeof Harness !== 'undefined' && Harness.normalizeReasoningEffort) ? Harness.normalizeReasoningEffort(sel.effort) : String(sel.effort || 'medium');
    if (effort && typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(effort);
    if (model) {
      if (typeof Harness !== 'undefined' && Harness.setProv) Harness.setProv(provider);
      if (typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(model);
      agent.model = model; agent.provider = provider; agent.reasoningEffort = effort;   // #4: keep model+provider+effort TOGETHER on the agent
      const stored = agents.get(agent.id);
      if (stored) { stored.model = model; stored.provider = provider; stored.reasoningEffort = effort; }
      const gtM = el('gt-model'); if (gtM) gtM.textContent = model;
      syncChannels();
      pushRoster();
    }
    persist();
    if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
    if (typeof Chat !== 'undefined' && Chat.refreshIdBar) Chat.refreshIdBar();   // keep the COMMS header model readout in sync with the footer dock change
    if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh();   // a provider switch can change key state — keep the keyless-brain banner honest
    if (typeof StationUI !== 'undefined' && StationUI.notify) {
      const msg = sel.reason === 'effort'
        ? 'REASONING: ' + effortLabel(effort)
        : 'MODEL: ' + providerLabel(provider) + ' / ' + shortModelLabel(model) + ' / ' + effortLabel(effort);
      StationUI.notify(msg, 'good');
    }
  }
  // the persisted shape of a crew member (systemPrompt is derived, recomposed on rehydrate).
  function serializeAgentLite(a) {
    return { id: a.id, name: a.name, color: a.color, skin: a.skin || DATA.DEFAULT_SKIN, model: a.model, provider: a.provider || null, reasoningEffort: a.reasoningEffort || null, personaId: a.personaId,
             role: a.role || (a.id === 'agent' ? 'orchestrator' : 'specialist'), voiceTraits: a.voiceTraits || null, customVoice: a.customVoice || '',
             approvalMode: a.approvalMode || 'ask', workshop: !!a.workshop, purpose: a.purpose || null, specialtyId: a.specialtyId || null, docs: a.docs,
             skills: Array.isArray(a.skills) ? a.skills.slice() : [],   // Class Loadouts S1: per-agent skill package persists
             stats: a.stats || null, createdAt: a.createdAt };
  }
  // restore summoned crew from a save (older saves have no `agents[]` → just the hero, exactly as before).
  // DATA only — world bodies are spawned in enterGame once World.init has run.
  function rehydrateRoster(savedAgents) {
    if (!Array.isArray(savedAgents)) return;
    for (const s of savedAgents) {
      if (!s || !s.id || s.id === 'agent' || agents.has(s.id)) continue;   // hero already registered; skip dups (so the 'specialist' default below is always correct here — the orchestrator never routes through this path)
      const a = { id: s.id, name: s.name, color: s.color, skin: s.skin || DATA.DEFAULT_SKIN, model: s.model || (agent && agent.model),
                  provider: s.provider || (agent && agent.provider) || null, reasoningEffort: s.reasoningEffort || (agent && agent.reasoningEffort) || null,   // #4: per-agent provider+effort (fall back to the hero's)
                  personaId: s.personaId, role: s.role || 'specialist', voiceTraits: s.voiceTraits || null, customVoice: s.customVoice || '',
                  approvalMode: s.approvalMode || 'ask', workshop: !!s.workshop, purpose: s.purpose || null, specialtyId: s.specialtyId || null,
                  skills: Array.isArray(s.skills) ? s.skills.slice() : [],   // Class Loadouts S1: restore the per-agent skill package
                  docs: s.docs, stats: (s.stats && typeof s.stats === 'object') ? s.stats : null, createdAt: s.createdAt || Date.now() };
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
      // R3 MAKE ROUTINE targets the CURRENT run's agent so a scheduled recipe fires as the same agent the
      // Commander is working with. Falls back to 'agent' (the default cron agentId) if no active stream.
      agentId: ((typeof Workstreams !== 'undefined' && Workstreams.active && Workstreams.active()) || {}).agentId || 'agent',
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
     agentId, a composed identity (reusing the hero's model/provider in Stage 1), and its own workstream.
     Summoning does not steal COMMS; the Commander keeps talking to the overseer unless they switch streams. */
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

  /* ---------- LOADOUT (Class Loadouts S1): a class is model tier + effort + skill package + kit ----------
     Defaults, never locks (sandbox law): summon APPLIES these to the agent record; the Commander overrides
     any of them per-agent afterward. */
  // Resolve a specialty's model TIER ('reasoning'|'balanced'|'fast') to a CONCRETE model id. The Commander can
  // OPTIONALLY map each tier to a specific model in SETTINGS → MODELS → CLASS TIER MODELS (persisted per-machine
  // in localStorage under TIER_MODELS_KEY). An unset tier ('(station default)') falls back to the base model the
  // summon already inherits (the woken hero's model / the model dock's primary), so the default behaviour is
  // exactly as before — the class only changes the model when the Commander has deliberately pinned that tier.
  // Everything downstream (roster / pushRoster / runOnce) already honors a per-agent model id.
  const TIER_MODELS_KEY = 'starnet.tierModels.v1';   // { reasoning?, balanced?, fast? } -> concrete model id (shared with stationui SETTINGS)
  function tierModelMap() {
    try {
      if (typeof localStorage === 'undefined') return {};
      const m = JSON.parse(localStorage.getItem(TIER_MODELS_KEY) || '{}');
      return (m && typeof m === 'object') ? m : {};
    } catch (_) { return {}; }
  }
  function resolveTierModel(tier, baseModel) {
    const pinned = tier && tierModelMap()[tier];
    if (pinned && String(pinned).trim()) return String(pinned).trim();
    return baseModel || ((typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : null) || null;
  }
  // fold the class loadout (model tier + effort + skills) onto an agent record. A class's `kit` is NOT placed
  // per-agent — it names the shared STATION gear the class draws on under the overseer (informational, shown in
  // the dossier). The only per-agent object is the agent's own desk; capabilities are station-level shared gear.
  function applyLoadout(a, spec, pin) {
    if (!a || !spec) return;
    // an EXPLICIT creation-time pick (bay modelPin) beats the class-tier default — the class supplies
    // defaults, never locks; it must not clobber a model/effort the Commander chose by hand at summon.
    if (!(pin && pin.model)) {
      const m = resolveTierModel(spec.model, a.model);
      if (m) a.model = m;
    }
    if (spec.reasoningEffort && !(pin && pin.effort)) a.reasoningEffort = spec.reasoningEffort;   // applied default; user can re-tune per agent
    // per-agent skills: the class package. Recorded on the agent + pushed in the roster (sidecar unions them
    // ADD-only over the global prefs). Deduped copy so the frozen catalog array is never shared/mutated.
    if (Array.isArray(spec.skills) && spec.skills.length) {
      const seen = {}, out = [];
      for (const s of spec.skills) { const v = String(s || '').trim(); if (v && !seen[v]) { seen[v] = true; out.push(v); } }
      a.skills = out;
    }
  }
  // a backend-valid, collision-free agentId for a summon (never the hero's reserved 'agent').
  function allocAgentId(spec) {
    const seed = (spec && (spec.id || spec.name)) || 'agent';
    return (typeof AgentId !== 'undefined') ? AgentId.alloc(seed, agents) : ('summon-' + (agents.size + 1));
  }
  function summonAgent(spec, opts) {
    opts = opts || {};
    if (!agent) return null;                                   // need a base context (model/provider): a woken hero
    const id = allocAgentId(spec);
    // OPTIONAL per-agent model chosen in the bay (spec.modelPin = { model, provider, effort }); falls back to the
    // hero's transport. Kept on a DISTINCT key so it never collides with the specialty's own `spec.model` clearance
    // TIER hint (reasoning/balanced/fast) shown on the class card. Setting provider+effort alongside the model also
    // fixes the prior gap where a summoned agent inherited only the hero's model, leaving provider/effort unset.
    const pin = (spec && spec.modelPin) || null;
    const a = {
      id, name: ((spec && spec.name) || 'AGENT').toUpperCase().slice(0, 18), role: 'specialist',   // summoned crew are specialists under the Orchestrator
      color: SUITS[agents.size % SUITS.length], skin: (spec && spec.skin) || DATA.DEFAULT_SKIN,
      model: (pin && pin.model) || agent.model,
      provider: (pin && pin.provider) || agent.provider || null,
      reasoningEffort: (pin && pin.effort) || agent.reasoningEffort || null,
      personaId: (spec && spec.persona && typeof Personas !== 'undefined' && Personas.exists(spec.persona)) ? spec.persona : agent.personaId,
      purpose: null, createdAt: Date.now()
    };
    agentDocs(a);
    applySpecialty(a, spec);
    applyLoadout(a, spec, pin);   // Class Loadouts S1: class model tier + effort + skill package onto the record (before compose/roster); explicit bay pin wins
    a.systemPrompt = composeSystemPrompt(a);
    agents.set(id, a);
    registerAgent(id, a.color);                                // sprite tint shim
    const _spawned = (typeof World !== 'undefined' && !!World.spawnAgent);
    if (_spawned) World.spawnAgent(a);                          // Phase C: a real floor body
    else console.warn('[summon] World.spawnAgent missing — no floor body for', id);
    if (typeof StationUI !== 'undefined' && StationUI.setRoster) StationUI.setRoster(liveAgents());
    else console.warn('[summon] StationUI.setRoster missing — crew manifest not refreshed');
    try { console.log('[summon]', JSON.stringify({ id, name: a.name, skin: a.skin, hadHero: !!agent, worldSpawn: _spawned, crew: (typeof World !== 'undefined' && World.crewCount) ? World.crewCount() : '?', roster: agents.size })); } catch (e) {}
    // a fresh workstream BOUND to the new agent, but inactive by default. Activation is the explicit
    // "talk to this specialist directly" action; summon itself only expands the crew/roster.
    const activate = opts.activate === true;
    const ws = (typeof Workstreams !== 'undefined') ? Workstreams.create(a.name, { agentId: id, activate }) : null;
    if (activate) {
      focusAgent(id);
      if (ws && typeof Chat !== 'undefined' && Chat.load) Chat.load(ws);
    }
    recomposeOrchestrators();   // the lead's YOUR CREW clause must include the new worker before the roster push
    refreshUsage(); renderRail(); persist();
    pushRoster();   // the new worker is now delegatable by the lead
    const _notify = (typeof StationUI !== 'undefined' && StationUI.notify) ? StationUI.notify : (m) => console.log('[summon]', m);
    if (activate) {
      // ACTIONABLE FOLLOW-UP (audit B-1): a summoned specialist can't take FLOOR work until it has its own DESK
      // (a seated workstation). The old copy buried this required step in a passing remark ("give it its OWN PC")
      // with no way to act. Now the agent says it plainly — "desk", never "OWN PC" — and a chip opens REFIT with
      // desk placement teed up. The toast still lands as the standing record; the diegetic line + chip is the door.
      _notify(a.name + ' summoned — type to task it now. It needs a desk before it can take floor work.', 'good');
      if (typeof Chat !== 'undefined' && Chat.localLine && Chat.choices && (typeof Chat.isBusy !== 'function' || !Chat.isBusy())) {
        Chat.localLine(a.name + ' is here — but it has nowhere to sit yet. it needs a desk of its own before it can take floor work. want to place one?');
        Chat.choices([{ label: '▤ PLACE ITS DESK', value: 'desk' }, { label: 'later', value: 'later', skip: true }], item => {
          if (item && item.value === 'desk') openDeskPlacement();
        });
      }
    } else {
      _notify(a.name + ' summoned — overseer remains in COMMS. Switch to its stream to task it directly, or let the overseer delegate. Give it a desk in REFIT before it takes floor work of its own.', 'good');
    }
    // ONE loadout beat: state plainly what the class summon actually applied — the skills enabled, the effort
    // applied, and the STATION GEAR the class draws on (honest present/missing under the overseer, NOT per-agent
    // props). Skipped for a plain persona-only class (no gear/skills/effort) so it never adds noise. Mirrors the
    // dossier so the two never drift.
    const lo = loadoutSummary(a, spec);
    if (lo) _notify(a.name + ' loadout - ' + lo, 'info');
    return a;
  }
  // OPEN REFIT WITH DESK PLACEMENT TEED UP — the target of the post-summon "PLACE ITS DESK" chip. Opens the
  // builder (the same door the ⚒ BUILD dock opens) and, once its DOM is up, drives it to the PROP tool on the
  // WORKSTATIONS category so the very next floor-click drops a desk (a workstation is editable, so it can't be
  // auto-requisitioned — it opens the agent-binding picker on placement; the Commander places + binds it by hand,
  // which is the honest one desk-per-agent path). Degrades safely: if any control isn't found we still leave REFIT
  // open on its default tool, which is already a real improvement over the old unclickable "Open REFIT" sentence.
  function openDeskPlacement() {
    if (typeof Build === 'undefined' || !Build.open) return;
    try { if (!Build.isOpen || !Build.isOpen()) Build.open(); } catch (_) { return; }
    // REFIT builds its palette synchronously in open()->buildDOM, but retarget across a couple of rAFs to be safe
    // against any deferred render. Each pass clicks only what isn't already active, so it's idempotent + cheap.
    let tries = 0;
    const arm = () => {
      const q = sel => document.querySelector(sel);
      const propTool = q('.refit-tool[data-tool="prop"]');
      if (propTool && !propTool.classList.contains('active')) propTool.click();
      const fnTier = q('.refit-tier-functional'), curTier = q('.refit-tier.active');
      if (fnTier && curTier && curTier !== fnTier) fnTier.click();
      const wsCat = q('.refit-propcat[data-cat="workstation"]');
      if (wsCat && !wsCat.classList.contains('active')) wsCat.click();
      const armed = wsCat && wsCat.classList.contains('active') && propTool && propTool.classList.contains('active');
      if (!armed && ++tries < 8) requestAnimationFrame(arm);
    };
    requestAnimationFrame(arm);
  }
  // The capability objectTypes the STATION currently has placed anywhere (station-wide shared gear), deduped.
  // Under Andrew's model a specialist owns only its desk and uses these shared caps under the overseer — so a
  // class's declared gear is checked against the whole station, never the agent's own room. Reads the same live
  // station-wide source the run's skill availability uses (World.stationCaps); [] on any hiccup (never throws).
  function stationGearTypes() {
    try {
      const caps = (typeof World !== 'undefined' && World.stationCaps) ? World.stationCaps() : [];
      return caps.map(c => (typeof c === 'string' ? c : c && c.objectType)).filter(Boolean);
    } catch (_) { return []; }
  }
  // Compose the one-line summon loadout beat from what was ACTUALLY applied: the skills enabled, the effort, and
  // — honestly — the STATION GEAR the class draws on that the station is MISSING (add it in REFIT for the class to
  // work its best). Present gear needs no callout (it just works). Reads skills/effort off the record applyLoadout
  // wrote. Returns '' when there is nothing to say.
  function loadoutSummary(a, spec) {
    const parts = [];
    const skills = (a && Array.isArray(a.skills)) ? a.skills : [];
    if (skills.length) parts.push(skills.length + ' skill' + (skills.length === 1 ? '' : 's') + ' enabled');
    if (a && a.reasoningEffort) parts.push(a.reasoningEffort + ' reasoning effort applied');
    const gear = (spec && Array.isArray(spec.kit)) ? spec.kit : [];
    if (gear.length) {
      const have = new Set(stationGearTypes());
      const missing = gear.filter(g => !have.has(g));
      if (missing.length) parts.push('station lacks ' + missing.join(', ') + ' — add ' + (missing.length === 1 ? 'it' : 'them') + ' in REFIT for its full toolkit');
    }
    return parts.join(' · ');
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
    // fromRecipe marks this run as recipe-launched so R5 "Bottle a run" never offers to re-bottle a recipe (it
    // already IS one). chat.js records it into RUN_META at onRunId; BottleStore reads it via runBottleInfo below.
    if (typeof Chat !== 'undefined' && Chat.send && !Chat.isBusy()) Chat.send(text, { fromRecipe: true });   // kicks off the run on the fresh stream
    persist();
    return true;
  }

  // R5 "BOTTLE A RUN" — the honest facts BottleStore gates on for a given run, read from chat.js's RUN_META (the
  // directive + isTask + recipe provenance recorded at run start) plus Chat.runDidWork (real tool-work / delivery).
  // A run with no meta (unknown id) reports nothing bottle-worthy. cron/unattended runs never flow through the
  // interactive rateWork path, so cron:false here is honest — the guard is belt-and-braces for a future caller.
  function runBottleInfo(runId) {
    const m = (typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null;
    if (!m) return null;
    return {
      isTask: !!m.isTask,
      fromRecipe: !!m.fromRecipe,
      cron: false,
      directive: m.directive || m.title || '',
      didWork: (typeof Chat !== 'undefined' && Chat.runDidWork) ? Chat.runDidWork(runId) : false
    };
  }
  // R5 — open the R2 recipe editor PRE-FILLED with a bottled-run proposal (Recipes.mintFromRun draft). Nothing
  // auto-saves; the user confirms/edits/saves in the editor. Routes through the RECIPES tab of the bay, seeding the
  // mint via ctx.recipeMint (the additive seed the marketplace editor reads on open).
  function openBottleEditor(proposal) {
    if (typeof Marketplace === 'undefined' || !agent || !proposal) return;
    SFX.click();
    Marketplace.open({
      mode: 'deploy',
      tab: 'recipes',
      recipeMint: proposal,                 // ← the R2 editor opens pre-filled from this draft (additive ctx seed)
      agentName: agent.name,
      notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
      onLaunch: launchRecipe
    });
  }

  // P3.1 "RUN IT AGAIN?" — the honest facts ResummonStore gates on, read from chat.js's RUN_META (directive +
  // isTask + the run's agent, recorded at run start) plus Chat.runDidWork (real tool-work / delivery). Adds the
  // agent's display NAME (resolved from the roster) so the beat can address it by name. A run with no meta reports
  // nothing re-runnable. cron/unattended runs never flow through the interactive rateWork path (cron:false honest).
  function runResummonInfo(runId) {
    const m = (typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null;
    if (!m) return null;
    const aid = m.agentId || 'agent';
    const a = agents.get(aid);
    return {
      isTask: !!m.isTask,
      cron: false,
      directive: m.directive || m.title || '',
      didWork: (typeof Chat !== 'undefined' && Chat.runDidWork) ? Chat.runDidWork(runId) : false,
      agentId: aid,
      agentName: (a && a.name) || (aid === 'agent' && agent ? agent.name : '') || ''
    };
  }
  // P3.1 — PRE-FILL a fresh run from a re-summoned one: switch to (or mint) the run's AGENT stream, then seed the
  // composer with its directive. NOTHING auto-runs — the Commander edits and hits send (Chat.prefill only scaffolds
  // the input). Mirrors the COMMS agent-selector hand-off (selectAgent → switchWorkstream → Chat.load), then prefill.
  function prefillResummon(opts) {
    opts = opts || {};
    const aid = String(opts.agentId || 'agent');
    const directive = String(opts.directive || '');
    if (!directive.trim()) return;
    try { if (aid && aid !== 'agent' && agents.has(aid)) selectAgent(aid); } catch (_) {}   // hero runs stay on the current/General stream
    try { if (typeof SFX !== 'undefined' && SFX.click) SFX.click(); } catch (_) {}
    try { if (typeof Chat !== 'undefined' && Chat.prefill) Chat.prefill(directive); } catch (_) {}
  }

  // push the live agent identity (the run agentId + composed system prompt) to the sidecar so any connected
  // messaging channel (Telegram) runs as the SAME agent. Fire-and-forget; a no-op if no channel is connected.
  function syncChannels() {
    try {
      if (!agent) return;
      const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
      const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
      const reasoningEffort = (typeof Harness !== 'undefined' && Harness.getReasoningEffort) ? Harness.getReasoningEffort() : 'medium';
      const body = {
        agentId: (ws && ws.agentId) || 'agent',
        system: agent.systemPrompt || '',
        agentName: agent.name || '',
        model: (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '',
        provider,
        reasoningEffort
      };
      const key = (typeof Harness !== 'undefined' && Harness.getKey) ? Harness.getKey(provider) : '';
      if (key) body.key = key;
      const baseUrl = (typeof Harness !== 'undefined' && Harness.getBaseUrl) ? Harness.getBaseUrl(provider) : '';
      if (baseUrl) body.baseUrl = baseUrl;
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
  // the most recent /api/roster POST. A backend-initiated summon must AWAIT this before acking, so the lead's
  // immediate team.dispatch sees the new worker in agentRoster (the POST is otherwise fire-and-forget → a race).
  let lastRosterPush = Promise.resolve();
  function pushRoster() {
    try {
      const fallbackProv = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
      const list = liveAgents().map(a => ({ agentId: a.id, system: a.systemPrompt || '', name: a.name || a.id, model: a.model || '', provider: a.provider || fallbackProv, role: rosterRole(a), approvalMode: (a.approvalMode === 'full' ? 'full' : 'ask'),
        workshop: !!a.workshop,   // W3: the away-build grant travels with the roster so the consent broker can honor it
        skills: Array.isArray(a.skills) ? a.skills : [], reasoningEffort: a.reasoningEffort || null }));   // #4: each agent's OWN provider; Class Loadouts S1: per-agent skill package + applied effort
      lastRosterPush = fetch('/api/roster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents: list }) }).catch(() => {});
      return lastRosterPush;
    } catch (_) { return Promise.resolve(); }
  }

  // BACKEND-INITIATED SUMMON (crew.summon.request): the orchestrator's team.summon tool asked the station to
  // create a worker for the Commander. Run the SAME summonAgent() the Recruitment Bay uses (single source of
  // truth — sprite, workstream, system prompt, roster push), resolving the new id ONLY AFTER the roster POST
  // lands so the lead's immediate team.dispatch finds the worker. Returns null if it couldn't summon.
  async function summonForRequest(ev) {
    ev = ev || {};
    // a known built-in class id (researcher/engineer/…) seeds the full specialty (purpose + manual + skin); a
    // freeform name makes a custom specialist. Event fields always win over the class defaults.
    let base = (ev.specId && typeof Specialties !== 'undefined' && Specialties.get) ? Specialties.get(ev.specId) : null;
    const spec = Object.assign({}, base || {}, {
      id: ev.specId || (base && base.id) || undefined,
      name: ev.name || (base && base.name) || undefined,
      skin: ev.skin || (base && base.skin) || undefined,
      persona: ev.persona || (base && base.persona) || undefined,
      purpose: ev.purpose || (base && base.purpose) || undefined
    });
    let a = null;
    try { a = summonAgent(spec, { activate: false }); } catch (_) { a = null; }
    if (!a) return null;
    try { await lastRosterPush; } catch (_) {}   // the worker is now in the backend roster → safe to delegate
    return a.id;
  }

  function persist() {
    if (!agent) return;
    // the save ROOT is ALWAYS the hero ('agent'), never the transiently-FOCUSED crew member — otherwise a
    // persist while a summoned agent is focused would overwrite the hero identity and corrupt resume.
    const hero = agents.get('agent') || agent;
    const stationStats = (typeof XpStore !== 'undefined') ? XpStore.stationStats() : undefined;
    const prov = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : undefined;   // persist the provider so a codex agent resumes without a key prompt after a wipe/origin-reset
    const reasoningEffort = (typeof Harness !== 'undefined' && Harness.getReasoningEffort) ? Harness.getReasoningEffort() : undefined;
    const profile = (typeof ProfileStore !== 'undefined') ? ProfileStore.serialize() : undefined;
    const worksignal = (typeof WorkSignalStore !== 'undefined') ? WorkSignalStore.serialize() : undefined;   // the capability-usage histogram (adaptive recruitment)
    const roster = liveAgents();
    const dossier = (typeof DossierStore !== 'undefined') ? DossierStore.serialize() : undefined;   // the station-wide Commander model
    const doc = Save.write(Object.assign({ agent: hero, agents: roster.length > 1 ? roster.map(serializeAgentLite) : undefined, usage: Harness.totals(), prov, reasoningEffort, station: station ? station.serialize() : undefined, stationStats, profile, worksignal, dossier }, Workstreams.serialize()));
    if (doc && typeof CloudSave !== 'undefined') CloudSave.push(doc);   // durable write-through to the sidecar (debounced, best-effort)
    if (typeof StationUI !== 'undefined') StationUI.flashSave();
  }

  /* ---------- connect screen ---------- */
  const FALLBACK_MODELS = Object.freeze({
    openai: ['gpt-5.5', 'gpt-5.4', 'gpt-4.1'],
    anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    xai: ['grok-4.3', 'grok-4-fast', 'grok-4'],
    groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    mistral: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro'],
    together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', 'deepseek-ai/DeepSeek-V3'],
    fireworks: ['accounts/fireworks/models/deepseek-v3p1', 'accounts/fireworks/models/kimi-k2p5', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
    perplexity: ['sonar-pro', 'sonar', 'sonar-reasoning-pro'],
    cerebras: ['llama-4-scout-17b-16e-instruct', 'llama3.1-8b', 'qwen-3-coder-480b'],
    ollama: ['llama3.1', 'qwen2.5-coder', 'mistral'],
    openrouter: ['gpt-5.5', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.8', 'openai/gpt-5', 'google/gemini-2.5-pro']
  });
  async function loadModels(provider) {
    const p = normalizeProviderId(provider || pickedProvider);
    const dl = el('model-list'), countEl = el('model-count'), inp = el('in-model');
    el('model-hint').textContent = 'loading model catalog…';
    const list = await Harness.listModels(p);
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
      const FALLBACK = FALLBACK_MODELS[p] || FALLBACK_MODELS.openrouter;
      for (const id of FALLBACK) { const o = document.createElement('option'); o.value = id; dl.appendChild(o); }
      countEl.textContent = '(catalog offline — type or pick a slug)';
      if (!inp.value) { inp.value = FALLBACK[0]; inp.placeholder = 'type a model slug — e.g. gpt-5.5'; }   // default-fill even offline so WAKE works; the Commander can overtype
    }
    updateHint();
  }

  /* ---------- recommended-model quick picks (OpenRouter) ----------
     One-tap slugs for newcomers who don't know what to type — directly serves the "easier than Hermes
     for beginners" moat. These are SUGGESTIONS, not a claim of availability: a chip only prefills
     #in-model, which the live catalog (updateHint → priceOf) then prices or flags. The slugs match the
     curated FALLBACK list loadModels() already ships, so nothing new is fabricated. Codex hides them —
     its menu is discovered live per-account (loadCodexModels), so a static list there could mislead. */
  const MODEL_PICKS = Object.freeze({
    openrouter: [
      { label: 'Opus 4.8', id: 'anthropic/claude-opus-4.8', tag: 'deepest' },
      { label: 'Sonnet 4.6', id: 'anthropic/claude-sonnet-4.6', tag: 'balanced' },
      { label: 'GPT-5', id: 'openai/gpt-5', tag: '' },
      { label: 'Gemini 2.5 Pro', id: 'google/gemini-2.5-pro', tag: '' }
    ],
    openai: [
      { label: 'GPT-5.5', id: 'gpt-5.5', tag: 'deepest' },
      { label: 'GPT-5.4', id: 'gpt-5.4', tag: '' }
    ],
    anthropic: [
      { label: 'Sonnet 4.5', id: 'claude-sonnet-4-5', tag: 'balanced' },
      { label: 'Opus 4.1', id: 'claude-opus-4-1', tag: 'deepest' }
    ],
    gemini: [
      { label: 'Gemini 2.5 Pro', id: 'gemini-2.5-pro', tag: 'deepest' },
      { label: 'Gemini 2.5 Flash', id: 'gemini-2.5-flash', tag: 'fast' }
    ],
    xai: [
      { label: 'Grok 4.3', id: 'grok-4.3', tag: '' },
      { label: 'Grok 4 Fast', id: 'grok-4-fast', tag: 'fast' }
    ],
    groq: [
      { label: 'GPT OSS 120B', id: 'openai/gpt-oss-120b', tag: 'fast' },
      { label: 'Llama 3.3 70B', id: 'llama-3.3-70b-versatile', tag: '' }
    ],
    mistral: [
      { label: 'Mistral Large', id: 'mistral-large-latest', tag: '' },
      { label: 'Mistral Small', id: 'mistral-small-latest', tag: 'fast' }
    ],
    deepseek: [
      { label: 'DeepSeek Chat', id: 'deepseek-chat', tag: '' },
      { label: 'Reasoner', id: 'deepseek-reasoner', tag: 'reasoning' }
    ],
    together: [
      { label: 'Llama 3.3 70B', id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', tag: '' },
      { label: 'Qwen Coder', id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', tag: 'code' }
    ],
    fireworks: [
      { label: 'DeepSeek V3', id: 'accounts/fireworks/models/deepseek-v3p1', tag: '' },
      { label: 'Kimi K2', id: 'accounts/fireworks/models/kimi-k2p5', tag: '' }
    ],
    perplexity: [
      { label: 'Sonar Pro', id: 'sonar-pro', tag: 'search' },
      { label: 'Sonar', id: 'sonar', tag: '' }
    ],
    cerebras: [
      { label: 'Llama 4 Scout', id: 'llama-4-scout-17b-16e-instruct', tag: 'fast' },
      { label: 'Llama 3.1 8B', id: 'llama3.1-8b', tag: '' }
    ]
  });
  /* ---------- PHOSPHOR tint picker (the console-wide theme, surfaced at commission) ----------
     The station already ships four CRT phosphors (style.css body.theme-*) persisted by StationUI. We
     surface that choice up-front so the Commander sets the whole station's colour the moment they build
     it — picking a swatch recolours live AND writes through StationUI.setTheme so it survives enterGame
     and stays in lockstep with the in-game Settings panel. No new state, no fakery. */
  const PHOSPHOR = Object.freeze([['amber', '#ffaa33'], ['green', '#3dff70'], ['blue', '#46c8ff'], ['purple', '#b46bff'], ['red', '#ff4136'], ['white', '#e8f0e8']]);
  // THE APPROVAL MODE — the crucial pick for the everything-orchestrator: how much it can do on its own. This is
  // NOT cosmetic — it drives the REAL consent broker in the sidecar (full → bypass the gate; ask → prompt on any
  // mutation/network call), threaded through pushRoster → /api/roster. `np` is the nameplate readout.
  const APPROVAL = Object.freeze([
    Object.freeze({ id: 'ask',  label: 'ASK FOR APPROVAL', icon: '✋', desc: 'stops to check with you before it writes, runs, or reaches out', np: 'asks for approval' }),
    Object.freeze({ id: 'full', label: 'FULL ACCESS',      icon: '⚡', desc: 'runs everything itself — no approval prompts',                  np: 'full access' })
  ]);
  const approvalById = id => APPROVAL.find(a => a.id === id) || APPROVAL[0];
  function applyTheme(t) {
    document.body.classList.remove('theme-amber', 'theme-green', 'theme-blue', 'theme-purple', 'theme-red', 'theme-white');
    document.body.classList.add('theme-' + t);
  }
  function buildPhosphor() {
    const wrap = el('phosphor-swatches'); if (!wrap) return;
    let cur = 'amber';
    try { if (typeof StationUI !== 'undefined' && StationUI.getTheme) cur = StationUI.getTheme() || 'amber'; } catch (_) {}
    applyTheme(cur);   // reflect a previously-saved tint on the create screen too (StationUI hasn't entered yet)
    wrap.innerHTML = '';
    PHOSPHOR.forEach(([t, c]) => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'swatch' + (t === cur ? ' sel' : ''); b.dataset.t = t;
      b.style.setProperty('--sw', c); b.title = t.toUpperCase() + ' phosphor'; b.setAttribute('aria-label', t + ' phosphor');
      b.onclick = () => {
        applyTheme(t);
        try { if (typeof StationUI !== 'undefined' && StationUI.setTheme) StationUI.setTheme(t); } catch (_) {}   // persist + keep Settings in sync
        SFX.click();
        [...wrap.children].forEach(x => x.classList.toggle('sel', x === b));
      };
      wrap.appendChild(b);
    });
  }

  // THE APPROVAL PICKER — two wide cards (ask vs full access). The pick rides on agent.approvalMode and drives
  // the real consent broker; 'ask' is pre-selected (the safe default), so it never blocks WAKE.
  function buildApproval() {
    const wrap = el('approval-picker'); if (!wrap) return;
    wrap.innerHTML = '';
    APPROVAL.forEach(m => {
      const c = document.createElement('button'); c.type = 'button';
      c.className = 'ov-card' + (pickedApproval === m.id ? ' sel' : '');
      c.dataset.a = m.id; c.title = m.desc; c.setAttribute('aria-pressed', String(pickedApproval === m.id));
      const pk = document.createElement('span'); pk.className = 'ov-card-pick'; pk.textContent = '◆';
      const ic = document.createElement('div'); ic.className = 'ov-card-ic'; ic.textContent = m.icon;
      const nm = document.createElement('div'); nm.className = 'ov-card-nm'; nm.textContent = m.label;
      const ds = document.createElement('div'); ds.className = 'ov-card-ds'; ds.textContent = m.desc;
      c.appendChild(pk); c.appendChild(ic); c.appendChild(nm); c.appendChild(ds);
      c.onclick = () => {
        pickedApproval = m.id;
        [...wrap.children].forEach(x => { const on = x === c; x.classList.toggle('sel', on); x.setAttribute('aria-pressed', String(on)); });
        SFX.click(); updateNameplate();
      };
      wrap.appendChild(c);
    });
    updateNameplate();
  }

  // the live nameplate under the agent: NAME (from the input) + the approval-posture readout.
  function updateNameplate() {
    const np = el('np-name'); if (np) np.textContent = ((el('in-name') && el('in-name').value.trim()) || 'OVERSEER').toUpperCase();
    const nm = el('np-mode'); if (nm) nm.textContent = approvalById(pickedApproval).np;
  }

  function buildModelPicks() {
    const wrap = el('model-picks'); if (!wrap) return;
    wrap.innerHTML = '';
    if (pickedProvider === 'codex') return;   // discovered live; no static menu
    (MODEL_PICKS[pickedProvider] || []).forEach(m => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'mp-chip'; b.dataset.id = m.id; b.title = m.id;
      b.appendChild(document.createTextNode(m.label));
      if (m.tag) { const t = document.createElement('b'); t.textContent = ' · ' + m.tag; b.appendChild(t); }
      b.onclick = () => { el('in-model').value = m.id; SFX.click(); updateHint(); };
      wrap.appendChild(b);
    });
    syncModelPicks();
  }
  function syncModelPicks() {
    const wrap = el('model-picks'); if (!wrap) return;
    const cur = el('in-model').value.trim();
    [...wrap.children].forEach(b => b.classList.toggle('sel', b.dataset.id === cur));
  }

  function updateHint() {
    const id = el('in-model').value.trim(), hint = el('model-hint');
    syncModelPicks();   // keep the recommended-chip highlight in lockstep with whatever's in the field
    if (pickedProvider === 'codex') { hint.textContent = 'included in your ChatGPT subscription'; return; }
    const limit = Harness.contextLimitOf ? Harness.contextLimitOf(id) : 0;
    const fmt = (typeof CtxGauge !== 'undefined' && CtxGauge.fmtTokens) ? CtxGauge.fmtTokens : (n => String(n || 0));
    hint.textContent = id ? (limit ? ('context window: ' + fmt(limit) + ' tokens') : 'custom model slug') : 'pick or type a model slug';
  }

  /* ---------- provider toggle + ChatGPT (Codex OAuth) sign-in ---------- */
  // Offline FALLBACK only — the real list is fetched per-account from /api/auth/codex/models (see
  // loadCodexModels). The ChatGPT-account Codex lineup drifts: stale slugs (e.g. gpt-5.1-codex) get
  // 400-rejected by the backend, so we never hardcode the menu when we can discover it.
  const CODEX_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'];

  function selectProviderUI(p) {
    pickedProvider = normalizeProviderId(p);
    document.querySelectorAll('.provider-row .prov').forEach(b => b.classList.toggle('sel', b.dataset.prov === pickedProvider));
    const isCodex = pickedProvider === 'codex';
    const keyBlock = el('key-block'), keyInput = el('in-key');
    const baseBlock = el('base-url-block'), baseInput = el('in-base-url');
    const configured = !!(Harness.configured && Harness.configured(pickedProvider));
    keyBlock.classList.toggle('hidden', !providerUsesKeyBox(pickedProvider));
    if (keyInput) {
      keyInput.value = Harness.getKey ? Harness.getKey(pickedProvider) : '';
      keyInput.placeholder = providerKeyPlaceholder(pickedProvider, configured && !keyInput.value);
    }
    if (baseBlock) baseBlock.classList.toggle('hidden', !providerNeedsBaseUrl(pickedProvider));
    if (baseInput) {
      baseInput.value = (Harness.getBaseUrl && Harness.getBaseUrl(pickedProvider)) || '';
      baseInput.onchange = () => {
        if (Harness.setBaseUrl) Harness.setBaseUrl(baseInput.value.trim(), pickedProvider);
        loadModels(pickedProvider);
      };
      baseInput.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); onWake(); } };
    }
    el('codex-block').classList.toggle('hidden', !isCodex);
    // the BYOK note talks about your key on 127.0.0.1 / the OS keychain — irrelevant and contradictory on the
    // ChatGPT-sub path (no key at all), so hide it there.
    { const bn = el('byok-note'); if (bn) bn.classList.toggle('hidden', isCodex); }
    if (isCodex) {
      loadCodexModels();      // live per-account discovery (falls back to CODEX_MODELS when not connected)
      refreshCodexStatus();
    } else {
      stopCodexPoll(); codexFlow = null;
      loadModels(pickedProvider);
    }
    buildModelPicks();        // recommended chips (OpenRouter only; clears itself on the codex path)
  }

  // Populate the model datalist with EXACTLY the slugs the connected account's Codex backend accepts, so the
  // user can't pick a 400-rejected model. Falls back to the curated list when discovery fails / not connected.
  async function loadCodexModels() {
    // Entries may be bare id strings (old shape) or rich {id, displayName, …} objects (new shape) — handle both.
    let models = CODEX_MODELS.map(id => ({ id: id })), def = CODEX_MODELS[0];
    try {
      const r = await fetch('/api/auth/codex/models'); const j = await r.json();
      if (Array.isArray(j.models) && j.models.length) {
        models = j.models.map(m => (typeof m === 'string' ? { id: m } : m)).filter(m => m && m.id);
        def = j.default || (models[0] && models[0].id);
      }
    } catch (_) {}
    const ids = models.map(m => m.id);
    const dl = el('model-list'); dl.innerHTML = '';
    for (const m of models) { const o = document.createElement('option'); o.value = m.id; if (m.displayName && m.displayName !== m.id) o.label = m.displayName; dl.appendChild(o); }
    el('model-count').textContent = '(ChatGPT subscription)';
    const mi = el('in-model'); if (!ids.includes(mi.value)) mi.value = def;
    updateHint();
  }

  // GET /api/auth/codex/status -> reflect connected/not into the sign-in block (never touches the tokens).
  async function refreshCodexStatus() {
    const statusEl = el('codex-status'), signinBtn = el('btn-codex-signin'), logoutBtn = el('btn-codex-logout');
    let j = { connected: false };
    try { const r = await fetch('/api/auth/codex/status'); j = await r.json(); } catch (_) {}
    codexConnected = !!j.connected;
    if (codexConnected) {
      statusEl.innerHTML = '<span class="conn-dot"></span>connected to ChatGPT — your agents can run on your subscription';
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
  // A live preview STAGE on the right (shared SkinStage) plays the picked (or hovered) skin's real
  // walk cycle big enough to actually read — a 40px still of a chunky sprite is unidentifiable.
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
        if (typeof SkinStage !== 'undefined') SkinStage.show(id);
        SFX.click();
      };
      // hover scrubs the stage so you can compare without committing; leaving snaps back to the pick
      b.onmouseenter = () => { if (typeof SkinStage !== 'undefined') SkinStage.show(id); };
      wrap.appendChild(b);
    });
    wrap.onmouseleave = () => { if (typeof SkinStage !== 'undefined') SkinStage.show(pickedSkin); };
    if (typeof SkinStage !== 'undefined') SkinStage.mount(el('skin-stage-img'), el('skin-stage-name'), pickedSkin);
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
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ov-vchip' + (p.id === pickedPersona ? ' sel' : '');
      chip.title = p.vibe;
      chip.textContent = p.name;
      chip.setAttribute('aria-pressed', String(p.id === pickedPersona));
      chip.onclick = () => {
        pickedPersona = p.id;
        [...wrap.children].forEach(x => { const on = x === chip; x.classList.toggle('sel', on); x.setAttribute('aria-pressed', String(on)); });
        SFX.click(); renderVoicePreview();
      };
      wrap.appendChild(chip);
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

  // initConnect(prefillName, isRecovery, savedAgent)
  //  - fresh first run: initConnect() -> CREATE YOUR OVERSEER (everything live).
  //  - RESUME / recovery (saved station, missing creds, or a disconnect re-entry): pass isRecovery=true and the
  //    savedAgent so the screen becomes a RESUME console: a phosphor banner, the model pre-filled, and the
  //    identity fields (name · skin · voice · approval) shown READ-ONLY so resume can't silently re-spec the
  //    agent. The key/provider section stays live so the Commander can re-enter a key and continue.
  function initConnect(prefillName, isRecovery, savedAgent) {
    const recovery = !!isRecovery && !!savedAgent;
    el('in-key').value = Harness.getKey();
    // remember what the field was pre-seeded with (browser BYOK: a real stored key; desktop keychain: '') so
    // onWake can ask ONCE before an edited value silently replaces a stored key. Reset the confirm latch for
    // this fresh screen. (An empty prefill means there's nothing to overwrite — the guard stays dormant.)
    prefilledKey = el('in-key').value || '';
    keyOverwriteConfirmed = false;
    // desktop: the key lives in the OS keychain (getKey returns ''); show that it's already set.
    if (Harness.configured && Harness.configured() && !el('in-key').value) {
      el('in-key').placeholder = '•••••••• stored in keychain — leave blank to keep';
    }
    // RESUME pre-fills the saved agent's model; a fresh screen carries the last-used model.
    el('in-model').value = recovery ? (savedAgent.model || Harness.getModel()) : Harness.getModel();
    el('in-model').oninput = updateHint;
    if (prefillName) el('in-name').value = prefillName;
    // a fresh create screen carries no stale voice picks — reset the module-level state so fine-tune
    // dials / a custom-voice note from an abandoned create session never ride onto the next agent.
    // In RESUME the saved agent's own identity is authoritative — seed the pickers FROM it so the read-only
    // view shows the real skin/voice/approval (and onWake, were it ever reached, wouldn't downgrade them).
    if (recovery) {
      pickedTraits = Object.assign({}, savedAgent.voiceTraits || {});
      pickedCustomVoice = savedAgent.customVoice || '';
      pickedPersona = savedAgent.personaId || ((typeof Personas !== 'undefined') ? Personas.DEFAULT_ID : 'professional');
      pickedApproval = (savedAgent.approvalMode === 'full') ? 'full' : 'ask';
      pickedSkin = savedAgent.skin || pickedSkin;
    } else {
      pickedTraits = {}; pickedCustomVoice = ''; pickedPersona = (typeof Personas !== 'undefined') ? Personas.DEFAULT_ID : 'professional';
      pickedApproval = 'ask';   // a fresh create screen defaults to the safe posture (color is fixed: the lead's gold)
    }
    buildPhosphor();
    buildSkins();
    buildVoice();
    buildApproval();
    // the hero nameplate tracks the name field live; picking an approval mode updates the second line.
    if (el('in-name')) el('in-name').oninput = updateNameplate;
    updateNameplate();
    applyRecoveryMode(recovery, savedAgent);
    el('btn-back').onclick = onConnectBack;
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
    // RESUME/recovery honours the agent's saved provider; a FRESH create screen leads with the beginner-first
    // default (pickedProvider = 'codex' — sign in with ChatGPT, no API key), the top of the zero-to-value funnel.
    selectProviderUI(recovery ? Harness.getProv() : pickedProvider);
  }

  // RESUME mode dressing for the connect screen. Recovery = an existing station re-entering (missing creds or a
  // disconnect): swap the GENESIS header for a RESUME banner, lock the identity fields (name · skin · voice ·
  // approval) READ-ONLY so resume can't re-spec the agent, and keep the key/provider section + WAKE live. A
  // fresh first run passes recovery=false, which clears all of this back to the CREATE YOUR OVERSEER console.
  function applyRecoveryMode(recovery, savedAgent) {
    const screen = el('screen-connect');
    if (screen) screen.classList.toggle('recovery', recovery);
    // EXPORT is only meaningful when there's a saved agent to back up — surface it in RESUME mode (the title
    // screen that used to host it is gone), hide it on a fresh first run where there's nothing yet.
    const exp = el('btn-export'); if (exp) exp.classList.toggle('hidden', !recovery);
    const banner = el('cc-recovery');
    const title = el('cc-title'), sub = el('cc-sub'), mode = el('cc-mode');
    const wake = el('btn-wake');
    // the identity fields resume must NOT let the Commander re-spec — visually muted, kept in the DOM so onWake
    // (if ever reached) still reads the seeded values rather than blanks.
    const locked = ['in-name', 'skin-picker', 'voice-archetypes', 'voice-preview', 'adv-toggle', 'adv-body',
                    'approval-picker', 'phosphor-swatches'];
    if (recovery) {
      const nm = (savedAgent && savedAgent.name) || 'your agent';
      if (banner) {
        banner.classList.remove('hidden');
        banner.innerHTML = '▮ RESUMING <b>' + U.esc(nm) + '</b> — your agent is safe. Enter your key to continue.';
      }
      if (title) title.textContent = '▮ RESUME ' + nm.toUpperCase();
      if (sub) sub.innerHTML = 'your station is intact — this only re-connects the <b>brain</b>. Identity stays as you left it.';
      if (mode) mode.textContent = 'RESUME';
      if (wake) wake.textContent = '⏼ RESUME STATION ▸';
      locked.forEach(id => { const n = el(id); if (n) { n.classList.add('field-locked'); n.setAttribute('aria-disabled', 'true'); } });
      const nameIn = el('in-name'); if (nameIn) { nameIn.readOnly = true; nameIn.tabIndex = -1; }
    } else {
      if (banner) { banner.classList.add('hidden'); banner.innerHTML = ''; }
      if (title) title.textContent = '▮ CREATE YOUR OVERSEER';
      if (sub) sub.innerHTML = 'the first mind you wake is your <b>OVERSEER</b> — it runs the station and recruits every agent after it.';
      if (mode) mode.textContent = 'GENESIS';
      if (wake) wake.textContent = '⏼ WAKE OVERSEER ▸';
      locked.forEach(id => { const n = el(id); if (n) { n.classList.remove('field-locked'); n.removeAttribute('aria-disabled'); } });
      const nameIn = el('in-name'); if (nameIn) { nameIn.readOnly = false; nameIn.removeAttribute('tabindex'); }
    }
  }

  // BACK from the connect screen. With the title screen gone there's nowhere to retreat TO, so BACK is a
  // context move: in RESUME it re-runs auto-resume (a fresh credential check may now pass straight in); on a
  // fresh first run it's a no-op beyond dropping any in-flight codex poll (the create screen is the root).
  function onConnectBack() {
    SFX.click(); stopCodexPoll(); codexFlow = null;
    const saved = Save.has() ? Save.load() : null;
    if (saved && saved.agent) { reentry(); return; }
    // fresh first run — nothing behind the create screen; just stay put.
  }

  // The single re-entry point that replaces the old title screen for any "leave the game / lost creds" path
  // (disconnect, recovery, back). Preserves the agent ALWAYS: if creds are in hand it resumes straight into the
  // station; otherwise it shows the connect screen in RESUME mode. Only a genuine no-save state falls through
  // to a fresh creation.
  function reentry() {
    const saved = Save.has() ? Save.load() : null;
    if (saved && saved.agent) {
      if (saved.prov && Harness.setProv) Harness.setProv(saved.prov);
      if (saved.reasoningEffort && Harness.setReasoningEffort) Harness.setReasoningEffort(saved.reasoningEffort);
      if (Harness.getKey() || (Harness.configured && Harness.configured()) || Harness.getProv() === 'codex') {
        resumingSaved = null; resumeInto(saved); return;
      }
      resumingSaved = saved;
      show('screen-connect'); initConnect(saved.agent.name, true, saved.agent);
      el('connect-msg').textContent = '';
      return;
    }
    startCreation();
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
    if (!model) {
      // COLD-START: never strand a beginner on an empty required field. Pre-fill a sensible default for the
      // chosen provider (Codex discovers its own lineup, so leave that path to its own picker) and say so.
      if (pickedProvider !== 'codex') {
        const def = defaultModelFor(pickedProvider);
        const inp = el('in-model'); if (inp && def) { inp.value = def; updateHint(); }
        msg.textContent = 'pick a model — suggested ' + (def || 'a default') + '. edit it above, then WAKE.';
      } else {
        msg.textContent = 'choose or type a model slug.';
      }
      return;
    }
    if (pickedProvider === 'codex') {
      if (!codexConnected) { msg.textContent = 'sign in with ChatGPT first, or switch to OpenRouter.'; return; }
      Harness.setModel(model); Harness.setProv('codex');
    } else {
      const key = el('in-key').value.trim();
      const baseUrl = el('in-base-url') ? el('in-base-url').value.trim() : '';
      if (providerNeedsBaseUrl(pickedProvider)) {
        if (!baseUrl) { msg.textContent = 'enter your Custom /v1 base URL.'; return; }
        if (Harness.setBaseUrl) await Harness.setBaseUrl(baseUrl, pickedProvider);
      }
      const configured = !!(Harness.configured && Harness.configured(pickedProvider));
      if (providerNeedsKey(pickedProvider) && !key && !configured) {
        // COLD-START guidance: a new user has no key AND no idea where to get one. Name the provider and link
        // the exact page that mints a key (from providerSignupUrl — same destinations the placeholder hints at).
        const url = providerSignupUrl(pickedProvider);
        const host = String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
        msg.innerHTML = 'enter your ' + esc(providerLabel(pickedProvider)) + ' API key — get one at '
          + '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" class="connect-link">' + esc(host) + '</a>.';
        return;
      }
      // OVERWRITE GUARD: the field was pre-filled from a stored key, and the Commander edited it to a DIFFERENT
      // value — saving would silently replace the stored key. Ask once (inline, no modal) before that happens.
      // Only fires when there genuinely was a stored key to lose (prefilledKey non-empty), the value actually
      // changed, and it hasn't already been confirmed this screen. An untouched pre-fill saves the same key
      // (a no-op replace) so it never trips; a blank field keeps the stored key (handled below) so it never trips.
      if (prefilledKey && key && key !== prefilledKey && !keyOverwriteConfirmed) {
        keyOverwriteConfirmed = true;   // arm: this same WAKE press now goes through; a second press confirms
        msg.textContent = 'this replaces the key already stored on this station. press WAKE again to confirm — or restore the old key to keep it.';
        return;
      }
      // Only (re)store when a key was actually typed — desktop keeps the existing keychain key on blank.
      // setKey is async in desktop (writes the keychain + pushes it to the sidecar); await so the run has it.
      if (key) await Harness.setKey(key, pickedProvider);
      Harness.setModel(model); Harness.setProv(pickedProvider);
    }

    if (resumingSaved) { const s = resumingSaved; resumingSaved = null; s.agent.model = model; resumeInto(s); return; }

    // the FIRST agent is always the station's OVERSEER — the orchestrating lead the Commander commissions before
    // any specialist. Its voice is the archetype + fine-tune dials + free-text note; its APPROVAL mode (ask vs
    // full access) drives the real consent broker, while the mission/context/orders are authored in the awakening.
    agent = { id: 'agent', name, role: 'orchestrator', color: pickedColor, skin: pickedSkin || DATA.DEFAULT_SKIN, model,
              provider: (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter',   // #4: stamp the chosen provider+effort onto the hero so a later agent-switch can restore them
              reasoningEffort: (typeof Harness !== 'undefined' && Harness.getReasoningEffort) ? Harness.getReasoningEffort() : 'medium',
              personaId: pickedPersona, voiceTraits: Object.assign({}, pickedTraits), customVoice: pickedCustomVoice.trim(),
              approvalMode: (pickedApproval === 'full' ? 'full' : 'ask'), purpose: null, onboarded: false, createdAt: Date.now() };   // onboarded flips true only when the awakening's finish() lands — so a refresh mid-awakening replays it instead of stranding (see resumeInto)
    agentDocs(agent);                              // seed identity.md (overseer-aware) / purpose.md / operating-manual.md
    registerHero(agent);   // found the multi-agent registry with the hero BEFORE composing — rosterClause reads the registry, and a same-session re-wake must not see the prior crew
    agent.systemPrompt = composeSystemPrompt(agent);
    Harness.resetTotals();
    Workstreams.reset();   // a fresh General stream for the new agent
    if (typeof PitchStore !== 'undefined') PitchStore.reset();   // a brand-new hero re-earns its First Pitch (own key)
    if (typeof SuggestStore !== 'undefined') SuggestStore.reset();   // …and a fresh ongoing-suggestion cadence
    if (typeof SeedStore !== 'undefined') SeedStore.reset();   // …and a fresh seed-offer budget
    if (typeof CuriosityStore !== 'undefined') CuriosityStore.reset();   // …no inherited waved-off dimensions (own key)
    if (typeof StudyStore !== 'undefined') StudyStore.reset();   // …and a fresh STUDY state — a new Commander never inherits the prior hero's studyDeclined denylist / ignore tallies / rating streaks (own key)
    if (typeof QuestStateStore !== 'undefined') QuestStateStore.reset();   // …and a fresh quest memory — a new Commander never inherits dismissed/completed quest history (own key)
    if (typeof StationQuestStore !== 'undefined') StationQuestStore.reset();   // …and no inherited station-gap fix-it quests — a new Commander never sees the prior hero's capdenied backlog / dismissals (own key)
    if (typeof WorkQuestStore !== 'undefined') WorkQuestStore.reset();   // …and no inherited accepted-build work quests — a new Commander never inherits the prior hero's in-flight builds (own key)
    if (typeof GoalStore !== 'undefined') GoalStore.reset();   // …and a fresh goal tree — a new Commander never inherits the prior hero's goals/milestones/progress (own key)
    if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.reset) UnderstandingStore.reset();   // …and no inherited rating corroboration — a new Commander never inherits the prior hero's 👍/👎 confidence signal (own key)
    if (typeof MaintQuestStore !== 'undefined') MaintQuestStore.reset();   // …and no inherited maintenance quests — a new Commander never sees the prior hero's slag/jam backlog (own key)
    if (typeof MintStore !== 'undefined') MintStore.reset();   // …no inherited recurring-task shapes — these feed the seed shelf, so a leak would offer a prior Commander's chores (own key)
    if (typeof AutonomyStore !== 'undefined') AutonomyStore.reset();   // …and a fresh autonomy posture (safe floor) — a new Commander is never handed the previous one's free-range grant (own key)
    if (typeof AutoJobStore !== 'undefined') AutoJobStore.reset();   // …and re-arm the one-time standing-jobs proposal (own key; server-side routines are separate)
    if (typeof AutopilotStore !== 'undefined') AutopilotStore.reset();   // …and a fresh idle autopilot (no inherited idle/armed state — its decision is re-earned by the new Commander's posture + dossier)
    if (typeof ReturnStore !== 'undefined') ReturnStore.reset();   // …and no inherited return-ritual trail — a fresh Commander gets no prior hero's pending OUTBOX crates or attendance stamp (own key)
    if (typeof WorkshopStore !== 'undefined') WorkshopStore.reset();   // W3: no inherited "later" list or seen-ledger for a fresh Commander (own key)
    if (typeof PrideStore !== 'undefined') PrideStore.reset();   // …and a brand-new station record — a fresh Commander founds their OWN colony, inheriting no prior hero's lifetime tasks/deliverables/routines/founding-date (own key)
    if (typeof SeedReuseStore !== 'undefined') SeedReuseStore.reset();   // …and no inherited seed-usage tally — a fresh Commander's living-tools shelf starts empty; the 5×/week callout is re-earned (own key)
    if (typeof ConfBeats !== 'undefined') ConfBeats.reset();   // …and both confidence narrative moments re-arm — a fresh hero's meter starts over, so its calibration/TRUSTED beats must be re-earned, never inherited (own key)
    if (typeof BottleStore !== 'undefined') BottleStore.reset();   // …and R5's per-run bottle-decision denylist clears — a fresh hero re-earns every "bottle it?" offer (own key)
    if (typeof ResummonStore !== 'undefined') ResummonStore.reset();   // …and P3.1's per-run re-summon-decision denylist clears — a fresh hero re-earns every "run it again?" offer (own key)
    if (typeof TrustStore !== 'undefined') TrustStore.reset();   // GROWTH Tier 3: …and a fresh EARNED-AUTONOMY track record — a new Commander never inherits the prior hero's earned rungs / declined-offer state / streak (own key); the earned dial rung must be re-earned from scratch
    if (typeof PermissionsStore !== 'undefined') await PermissionsStore.reset();   // …and LOCK DOWN the standing grants (AWAIT so the revoke lands before the new agent enters — no inherit-window) — a new Commander never inherits the previous one's autonomous file-write permission (server-side grant; re-grant via the Permissions panel)
    if (typeof Harness !== 'undefined' && Harness.memoryReset) Harness.memoryReset(agent.id);   // …and wipe SERVER-SIDE memory (notebook/declined/todo) so no prior Commander's kept or rejected beliefs bleed into the fresh hero
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
    stripLegacySoloClause(agent);                  // one-time: swap the frozen "right now its only agent" identity block for the timeless clause (crew truth now rides rosterClause)
    agent.systemPrompt = composeSystemPrompt(agent);
    registerHero(agent);                           // found the registry with the hero…
    rehydrateRoster(saved.agents);                 // …then restore any summoned crew (older saves: no-op)
    recomposeOrchestrators();                      // …and only NOW does the hero's YOUR CREW clause see them (composing above sees an empty registry)
    if (saved.prov && Harness.setProv) Harness.setProv(saved.prov);   // keep the provider with the agent (codex vs openrouter)
    if (saved.reasoningEffort && Harness.setReasoningEffort) Harness.setReasoningEffort(saved.reasoningEffort);
    if (!agent.provider && saved.prov) agent.provider = saved.prov;   // #4: older hero saves stored provider only at the top level — stamp it onto the hero object so focusAgent restores it
    if (!agent.reasoningEffort && saved.reasoningEffort) agent.reasoningEffort = saved.reasoningEffort;
    Harness.setModel(agent.model || Harness.getModel());
    Harness.setTotals(saved.usage || { tokens: 0, cost: 0, calls: 0 });
    Workstreams.init({ workstreams: saved.workstreams, activeId: saved.activeId, generalId: saved.generalId });
    pendingStationDoc = saved.station || null;   // restore the built station (if any)
    pendingStationStats = saved.stationStats || null;   // restore the station-growth rollup (XP/level/confidence)
    pendingProfile = saved.profile || null;   // restore the learned user-affinity profile
    pendingWorkSignal = saved.worksignal || null;   // restore the capability-usage histogram (adaptive recruitment)
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
    if (World.setOnOutbox) World.setOnOutbox(() => { if (typeof ReturnStore !== 'undefined' && ReturnStore.reviewNext) ReturnStore.reviewNext(); });   // G2.3: click the stacked OUTBOX → review the oldest uncollected while-away run
    if (World.setOnMissionBoard) World.setOnMissionBoard(() => { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('quests'); });   // G1b: click the MISSION BOARD → the QUEST LOG (the board is a projection, never a gate)
    if (World.setOnTrophyCase) World.setOnTrophyCase(() => { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('trophies'); });   // G3b: click the TROPHY CASE → the TROPHY surface (a projection of real completions, never a gate)
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
      Build.init({ getStation: () => station, persist: persist, world: World,
        agents: () => liveAgents().map(a => ({ id: a.id, name: a.name, color: a.color, model: a.model })) });
      const bbBuild = el('bb-build');
      if (bbBuild) {
        let seenBuild = false; try { seenBuild = !!localStorage.getItem('starnet.refit.seen'); } catch (e) {}
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
        context: () => Harness.contextState(agent ? agent.id : 'agent'),
        activity: () => (World.getActivity ? World.getActivity() : 'idle'),
        config: { apply: applyAgentConfig, setModel: setAgentModelPin, setName: setAgentName, setWorkshop: setAgentWorkshop }   // dossier edits re-shape the live prompt; setModel pins per-agent model/provider/effort (P1-6); setName renames the agent; setWorkshop flips the away-build grant (W3)
      });
      if (!opts.awaitingPurpose) StationUI.notify(agent.name + ' is online — ' + agent.model, 'good');   // during the awakening the finale announces it instead
    }
    // AGENT GROWTH: subscribe XP/Level/Confidence to the real run-outcome bus. Seeds agent.stats +
    // the station rollup, pushes the live numbers to the world HUD, and fires level-up celebrations.
    if (typeof XpStore !== 'undefined') { XpStore.init({ getAgent: (id) => agents.get(id || 'agent') || null, station: pendingStationStats, persist: persist }); pendingStationStats = null; }
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
    // ADAPTIVE RECRUITMENT: the capability-usage histogram — folds the LANE (dish/cabinet/workbench/…) of each
    // real hero tool fire, plus the run's interest tag, into a decayed per-lane read (worksignal.js engine). Shares
    // the profile's learning-enabled flag (one glass-box switch governs both) so PAUSE stops all local learning at
    // once. getRunTag resolves the run's interest tag from RUN_META (else the active workstream title).
    if (typeof WorkSignalStore !== 'undefined') {
      WorkSignalStore.init({
        signal: pendingWorkSignal, persist: persist,
        learningOn: () => (typeof ProfileStore !== 'undefined' && ProfileStore.enabled) ? ProfileStore.enabled() : true,
        getRunTag: (runId) => {
          if (typeof Classify === 'undefined' || !Classify.getTag) return null;
          let title = '';
          try { const m = (runId && typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null; if (m && m.title) title = m.title; } catch (_) {}
          if (!title) { try { const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null; title = ws ? (ws.title || '') : ''; } catch (_) {} }
          return title ? Classify.getTag(title) : null;
        }
      });
      pendingWorkSignal = null;
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
    // GROWTH Tier 1 — STUDY (dossier Phase B): after a salient run, the station proposes DOSSIER belief updates
    // (goals/pain/style/… ADD or RETIRE), consented at the turn-in beat. Self-persists its own key (declined
    // denylist + per-belief ignore tallies + per-archetype rating streaks). Init AFTER DossierStore (its accept()
    // folds into it); the per-session shown-cap resets here.
    if (typeof StudyStore !== 'undefined') StudyStore.init({ now: () => Date.now() });
    // CURIOSITY: the gentle one-per-session "tell me about X" nudge (curiosity.js). Self-persists its
    // dismissals to its own key (rides the backup prefix); init just hydrates + resets the session budget.
    if (typeof CuriosityStore !== 'undefined') CuriosityStore.init();
    // QUEST MEMORY (G1a): durable quest state — firstSeenAt/completedAt per quest + dismissed-forever — and
    // the open→done completion celebration (quest sting + gold toast + row flourish; NEVER XP). Self-persists
    // to its own key. Init AFTER XpStore/DossierStore so its first fold sees the real projection as a quiet
    // baseline (a resumed save backfills already-done quests without a celebration storm).
    if (typeof QuestStateStore !== 'undefined') QuestStateStore.init();
    // G1b STATION-QUEST GENERATOR: subscribe to agent.tool_call and mint a fix-it quest when an agent reaches
    // for a tool its room can't grant (capdenied → playable direction). Init AFTER World.loadStation (its gap
    // check + resolution read World.heroCaps / the live floor) and after QuestStateStore so a resumed save's
    // already-closed gaps are a quiet baseline. Self-persists to its own key; never emits on U.bus.
    if (typeof StationQuestStore !== 'undefined') StationQuestStore.init();
    // G1c WORK-QUEST GENERATOR: an accepted pitch/idea ("build it") becomes a trackable multi-step build,
    // completing on the launched run finishing (rides QuestState's celebration). Subscribes to run.start/end;
    // self-persists (own key); never emits. Init AFTER QuestStateStore so its completion folds cleanly.
    if (typeof WorkQuestStore !== 'undefined') WorkQuestStore.init();
    // GROWTH Tier 2 — GOAL MODEL + QUEST ARCS: a goals-dim belief decomposes into a confirmed, persisted milestone
    // tree; the next open milestone surfaces as an actionable quest that routes through the work-quest path, so
    // completing the REAL work advances an honest progress meter and chains the next step. Self-persists (own key)
    // + mirrors the active goal to the sidecar for cron. Init AFTER DossierStore (reads goals beliefs) + StudyStore
    // (drift) + WorkQuestStore (binds/reconciles milestone builds) + QuestStateStore (its arc-step completion folds
    // through QuestState's celebration). getSystem/launchDirective reuse the advice plumbing composed just below.
    if (typeof GoalStore !== 'undefined') GoalStore.init({
      now: () => Date.now(),
      getSystem: () => agent ? agent.systemPrompt : '',
      launchDirective: (text) => { const ws = (typeof Workstreams !== 'undefined') ? Workstreams.create('Goal milestone') : null; if (ws && typeof Chat !== 'undefined' && Chat.load) Chat.load(ws); if (typeof Chat !== 'undefined' && Chat.send && !Chat.isBusy()) Chat.send(text); persist(); },
      getRunSummary: (runId) => { const m = (runId && typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null; return (m && m.title) ? m.title : ''; }
    });
    // UNDERSTANDING: the one honest, adaptive "how well the station understands the Commander" read
    // (understanding.js engine) composed from the live dossier beliefs + work-observation count + active goal.
    // No surface of its own — it AIMS the earned curiosity question at the weakest dimension and upgrades the
    // COMMANDER panel's familiarity meter. Init AFTER DossierStore/ProfileStore/GoalStore (it reads all three).
    if (typeof UnderstandingStore !== 'undefined') UnderstandingStore.init({ now: () => Date.now() });
    // R1: the fork directive is BAKED into the cached agent.systemPrompt, so a gate flip (style confidence
    // crossing the floor — e.g. the first banked fork answer grounds the style model) must recompose the
    // prompt or the directive would never retire. Flips are rare, so the prefix stays cache-warm between.
    if (typeof UnderstandingStore !== 'undefined' && typeof Fork !== 'undefined' && UnderstandingStore.subscribe) {
      let forkGate = null;
      UnderstandingStore.subscribe(u => {
        const g = Fork.shouldOffer(u);
        if (forkGate === g) return;
        const first = forkGate === null;
        forkGate = g;
        if (first || !agent) return;   // the initial read only sets the baseline (the boot compose already used it)
        agent.systemPrompt = composeSystemPrompt(agent);
        if (typeof Chat !== 'undefined' && Chat.setSystem) Chat.setSystem(agent.systemPrompt);
        persist();   // mirror applyAgentConfig: the recomposed prompt is part of the agent's persisted truth
      });
    }
    // G1c MAINTENANCE-QUEST GENERATOR: recurring slag causes (World.slagPostmortems ring) + a jammed routine
    // (cron.skipped streak) become fix-it quests, clearing when the signal clears. Init AFTER World.loadStation
    // (it reads the live SlagLog ring) and after QuestStateStore. Self-persists (own key); never emits.
    if (typeof MaintQuestStore !== 'undefined') MaintQuestStore.init();
    if (typeof SeedStore !== 'undefined') SeedStore.init();   // SELF-GROWING SEED: reset the one-offer-per-session budget
    if (typeof AutonomyStore !== 'undefined') AutonomyStore.init();   // AUTONOMY POSTURE: hydrate the "alive between sessions" dial (own key; the awakening cadence beat + the station dial are its writers)
    // FIRST PITCH: once the agent has done one real task and knows enough about the Commander, it proactively
    // proposes ONE buildable thing to make next (pitch.js engine). Read-only bus citizen; self-persists its own
    // fire-once flag (no save.js change). It reasons the pitch from the LIVE system prompt (which already carries
    // the COMMANDER dossier block), so the suggestion is personalized with no context re-injection.
    // shared accessors/actions for the proactive-advice stores (First Pitch + ongoing suggestions): both reason
    // from the LIVE system prompt (it carries the dossier block) + the real recipe/capability envelope, and route
    // a "build it" into a real run. SuggestStore is the recurring counterpart that fires as the dossier grows.
    const adviceDeps = {
      getSystem: () => agent ? agent.systemPrompt : '',
      getName: () => agent ? agent.name : 'AGENT',
      getCaps: () => ((typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps('agent') : []).map(c => (typeof c === 'string' ? { id: c, label: c } : c)),
      // was the run that just ended a REAL task (tools available), not casual chat? Chat's run-meta ledger records
      // this at run start (the bus run.end payload doesn't carry it). Gates the First Pitch on earned work.
      wasTaskRun: (runId) => { const m = (typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null; return !!(m && m.isTask); },
      // the title of the run that just finished — prefer the ENDED run's recorded title (so a mid-run stream switch
      // can't mislabel it), falling back to the active workstream when the runId is unknown (e.g. a direct call).
      getRecentTask: (runId) => { const m = (runId && typeof Chat !== 'undefined' && Chat.runMeta) ? Chat.runMeta(runId) : null; if (m && m.title) return m.title; const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null; return ws ? (ws.title || '') : ''; },
      launchRecipe: launchRecipe,
      launchDirective: (text) => { const ws = (typeof Workstreams !== 'undefined') ? Workstreams.create('First build') : null; if (ws && typeof Chat !== 'undefined' && Chat.load) Chat.load(ws); if (typeof Chat !== 'undefined' && Chat.send && !Chat.isBusy()) Chat.send(text); persist(); }
    };
    if (typeof PitchStore !== 'undefined') PitchStore.init(adviceDeps);
    if (typeof SuggestStore !== 'undefined') SuggestStore.init(adviceDeps);
    // ADAPTIVE RECRUITMENT — PROSPECT GENERATOR (Slice 4): as the station learns the Commander, it DRAFTS bespoke
    // new agent specs the 17-class catalog doesn't contain, staged in the bay for the Commander to confirm (never
    // auto-saved). Reason-only model call (like the ongoing suggestion), growth+cooldown+warm gated, once/session,
    // silent on failure. capabilityKeys/skillSlugs are the REAL allowed sets so a draft can never claim gear that
    // doesn't exist; getTopRecommendation feeds the recruiter's best existing-class pick so the draft avoids
    // duplicating it (reply NONE if a class already serves the gap).
    if (typeof ProspectStore !== 'undefined') {
      // the real installed skill slugs (fetched once, best-effort) — a prospect's SKILLS must come from this set.
      let skillSlugs = [];
      try { fetch('/api/skills').then(r => r.ok ? r.json() : { skills: [] }).then(d => { skillSlugs = ((d && d.skills) || []).map(s => s && s.slug).filter(Boolean); }).catch(() => {}); } catch (_) {}
      const worksignalSummaryText = () => {
        try {
          const s = (typeof WorkSignalStore !== 'undefined' && WorkSignalStore.summary) ? WorkSignalStore.summary() : null;
          if (!s || !s.dominant) return '';
          const lanes = Object.keys(s.laneTags || {}).map(l => l + ' (' + s.laneTags[l] + ')').join(', ');
          return 'dominant lane: ' + s.dominant + '; ' + s.samples + ' tool-samples; lanes worked: ' + (lanes || s.dominant);
        } catch (_) { return ''; }
      };
      // warmth 0..1 = how far past the calibration floor the histogram is (the recruiter's warm read, as a number).
      const warmthNow = () => {
        try {
          const s = (typeof WorkSignalStore !== 'undefined' && WorkSignalStore.summary) ? WorkSignalStore.summary() : null;
          if (!s || s.calibrating) return 0;
          const floor = (typeof WorkSignal !== 'undefined' && WorkSignal.CALIBRATING_N) ? WorkSignal.CALIBRATING_N : 5;
          return Math.min(1, (s.samples || 0) / (floor * 4));
        } catch (_) { return 0; }
      };
      ProspectStore.init({
        now: () => Date.now(),
        chat: (o) => (typeof Harness !== 'undefined' && Harness.chat) ? Harness.chat(o) : Promise.resolve({ error: 'no-harness' }),
        getSystem: () => agent ? agent.systemPrompt : '',
        getDossierBlock: () => (typeof DossierStore !== 'undefined' && DossierStore.composeBlock) ? (DossierStore.composeBlock() || '') : '',
        getWorksignalSummary: worksignalSummaryText,
        getWarmth: warmthNow,
        getFamiliarity: () => { try { const s = (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null; return s && Number.isFinite(s.familiarity) ? s.familiarity : null; } catch (_) { return null; } },
        getRosterClasses: () => liveAgents().map(a => { const sp = a.specialtyId && typeof Specialties !== 'undefined' ? Specialties.get(a.specialtyId) : null; return { name: (sp && sp.name) || a.name, tags: (sp && sp.tags) || {} }; }),
        getCatalogSummary: () => {
          if (typeof Specialties === 'undefined') return [];
          const all = (Specialties.builtins() || []).concat(Specialties.customs ? (Specialties.customs() || []) : []);
          return all.map(s => ({ id: s.id, name: s.name, tagline: s.tagline, tags: s.tags || {} }));
        },
        // the REAL capability keys a kit may use — the same pickable set the custom builder exposes, plus connector.
        getCapabilityKeys: () => ['dish', 'cabinet', 'notebook', 'workbench', 'studio', 'connector'],
        getSkillSlugs: () => skillSlugs.slice(),
        getTopRecommendation: () => { try { const t = (typeof RecruiterStore !== 'undefined' && RecruiterStore.topPick) ? RecruiterStore.topPick() : null; return t ? t.classId : ''; } catch (_) { return ''; } }
      });
    }
    // G3a CONFIDENCE NARRATIVE: two fire-once spoken moments in the hero's reliability arc (calibration
    // complete + TRUSTED). Init AFTER XpStore so its memory.feedback hook sees an already-folded meter.
    if (typeof ConfBeats !== 'undefined') ConfBeats.init({ getStats: () => { const a = agents.get('agent'); return a ? a.stats : null; } });
    // R5 "BOTTLE A RUN": the post-run offer to save a 👍-rated interactive run as a custom recipe. Fed a DIRECT
    // verdict from chat.js rateWork (like ConfBeats); reads each run's honest facts via runBottleInfo and opens the
    // R2 editor pre-filled on "bottle it". Shares the one post-run beat slot (Chat.nudge) — never stacks an ask.
    if (typeof BottleStore !== 'undefined') BottleStore.init({ openEditor: openBottleEditor, runInfo: runBottleInfo });
    // P3.1 "RUN IT AGAIN?": the post-run offer to re-run a 👍-rated run's shape. Fed the SAME direct verdict from
    // chat.js rateWork; reads the run's honest facts via runResummonInfo and, on accept, PRE-FILLS a fresh run
    // (selects the run's agent stream + seeds the composer with its directive) — never auto-running. Shares the one
    // post-run beat slot; chat.js gates it so it never co-fires with a bottle offer on the same run.
    if (typeof ResummonStore !== 'undefined') ResummonStore.init({ runInfo: runResummonInfo, prefillRun: prefillResummon });
    // SELF-INITIATION (Slice 2): the agent proposes recurring standing JOBS grounded in the dossier → the Commander
    // approves → each becomes a scheduled cron routine (POST /api/cron, the same endpoint the ROUTINES panel uses).
    if (typeof AutoJobStore !== 'undefined') AutoJobStore.init({
      getSystem: () => agent ? agent.systemPrompt : '',
      getName: () => agent ? agent.name : 'AGENT',
      getBeliefs: () => {
        const out = {};
        if (typeof DossierStore === 'undefined' || !DossierStore.beliefs) return out;
        for (const k of ['goals', 'pain', 'ambition', 'stack', 'standing_orders']) {
          const arr = (DossierStore.beliefs(k) || []).map(b => b && b.text).filter(Boolean);
          if (arr.length) out[k] = arr;
        }
        return out;
      },
      getExistingJobs: () => fetch('/api/cron', { cache: 'no-store' }).then(r => r.ok ? r.json() : { jobs: [] }).then(j => (j.jobs || []).map(x => x && x.name).filter(Boolean)).catch(() => []),
      // W6: surface the server's `duplicate` flag so the store retires a proposal the mint gate refused (rather than
      // treating it as a plain success and re-offering). A non-JSON body degrades to { ok } exactly as before.
      scheduleJob: (body) => fetch('/api/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json().then(j => ({ ok: r.ok, duplicate: !!(j && j.duplicate) })).catch(() => ({ ok: r.ok }))).catch(() => ({ ok: false })),
      // G4 feature 2: is a MISSION BOARD placed? When it is, a proposal gets a BODY (agent walks + pins an amber
      // card on the board) instead of the inline Dialogue approval. No board → the Dialogue flow is untouched.
      boardPlaced: () => { try { const d = World.stationDoc && World.stationDoc(); return !!(d && d.props && d.props.some(p => p && p.t === 'missionboard')); } catch (_) { return false; } }
    });
    // PERMISSIONS (autonomy Stage B / B1): the Permissions Panel store. It reads/sets the standing capability
    // grants over the token-gated /api/permissions routes (harness.js hardens window.fetch to attach the token, so
    // a plain fetch carries it — exactly like the cron calls above) and drives the posture half of a level through
    // AutonomyStore. The level chooser ties grant + posture so the Commander dials never→fully-autonomous.
    if (typeof PermissionsStore !== 'undefined') PermissionsStore.init({
      getPosture: () => (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary) ? AutonomyStore.summary() : null,
      applyPreset: (id) => {
        if (typeof AutonomyStore !== 'undefined' && AutonomyStore.applyPreset) AutonomyStore.applyPreset(id);
        // GROWTH Tier 3: a permissions-LEVEL change is a NON-DIAL posture writer — reconcile the earned-rung record
        // against the rung the preset just set (a diverged record retires; user override wins), so a stale record
        // can never later demote FROM a rung the dial isn't at (the silent-escalation blocker).
        try { if (typeof TrustStore !== 'undefined' && TrustStore.onManualInitiative && typeof AutonomyStore !== 'undefined' && AutonomyStore.get) TrustStore.onManualInitiative((AutonomyStore.get() || {}).initiative); } catch (_) {}
      },
      api: {
        load: () => fetch('/api/permissions', { cache: 'no-store' }).then(r => r.ok ? r.json() : { grants: [], grantable: [] }).catch(() => ({ grants: [], grantable: [] })),
        grant: (key) => fetch('/api/permissions/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key }) }).then(r => r.ok ? r.json() : { ok: false }).catch(() => ({ ok: false })),
        revoke: (key) => fetch('/api/permissions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key }) }).then(r => r.ok ? r.json() : { ok: false }).catch(() => ({ ok: false }))
      }
    });
    // GROWTH Tier 3 — EARNED AUTONOMY (track record → trust): folds the SAME run outcomes xpstore folds into a
    // track record that, once earned, mints a CONSENT-gated offer to raise the autonomy dial one rung (or pre-bless
    // a GRANTABLE capability). Accept applies THROUGH the existing plumbing (AutonomyStore.setInitiative /
    // PermissionsStore.grant) with provenance; a sustained bad streak DEMOTES the earned rung back (never below the
    // Commander's own manual floor) with an explicit notice. Level is its gate (offers fire at L≥3 / L≥5); XP purity
    // is untouched. Self-persists its own key; read-only bus citizen. Init AFTER XpStore/AutonomyStore/PermissionsStore
    // (it reads their live state + applies through their writers). grantable = the sidecar's curated GRANTABLE list.
    if (typeof TrustStore !== 'undefined') TrustStore.init({
      now: () => Date.now(),
      getStats: () => { const a = agents.get('agent'); return (a && a.stats && typeof Xp !== 'undefined' && Xp.compute) ? Xp.compute(a.stats) : (a ? a.stats : null); },
      getPosture: () => (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary) ? AutonomyStore.summary() : null,
      setInitiative: (level) => { if (typeof AutonomyStore !== 'undefined' && AutonomyStore.setInitiative) AutonomyStore.setInitiative(level); persist(); },
      // the ONLY capabilities a grant offer may pre-bless — the sidecar's curated GRANTABLE (cabinet:write today).
      grantable: (typeof SK !== 'undefined' && SK.permgrants && Array.isArray(SK.permgrants.GRANTABLE)) ? SK.permgrants.GRANTABLE.slice() : (typeof Permissions !== 'undefined' && Permissions.grantableKeys ? Permissions.grantableKeys() : ['cabinet:write']),
      getGrants: () => { try { return (typeof PermissionsStore !== 'undefined' && PermissionsStore.snapshot) ? (PermissionsStore.snapshot().grants || []) : []; } catch (_) { return []; } },
      grant: (key) => (typeof PermissionsStore !== 'undefined' && PermissionsStore.grant) ? PermissionsStore.grant(key) : false,
      notify: (text, kind) => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(text, kind || 'warn'); }
    });
    Chat.init({ system: agent.systemPrompt, name: agent.name, ws: Workstreams.active(), onTurn: persist });
    // G2 RETURN RITUAL: arm the durable lastSeenAt heartbeat and (once per session, never during the
    // awakening) fire the while-you-were-away digest for unattended runs the sidecar recorded. The
    // store reads /api/runs + /api/cron itself and hands the rows to Chat.awayDigest; rating a row
    // rides the same rate-the-work path as an attended run. Init AFTER Chat.init so the beat can render.
    if (typeof ReturnStore !== 'undefined') ReturnStore.init({ enabled: !opts.awaitingPurpose });
    // W3 AWAY-WORKSHOP RETURN CARD: on attach (once per session, never during the awakening) poll
    // /api/workshop/pending and hand the oldest undecided manifest to Chat.workshopReturn — the same
    // one-post-run-beat slot the digest rides. Keep/Later/Discard route back through WorkshopStore.decide.
    // Init AFTER Chat.init so the beat can render.
    if (typeof WorkshopStore !== 'undefined') WorkshopStore.init({ enabled: !opts.awaitingPurpose, agentIds: () => liveAgents().map(a => a.id) });
    // CRON SESSIONS: surface each unattended routine run as a readable session — cron.fire adds a busy rail row
    // (no focus-steal), cron.result folds the run's durable 'cron-<runId>' transcript into it, and a boot backfill
    // recovers sessions for routines that finished while the browser was closed. Read-only on U.bus. Init AFTER
    // Chat.init + App is fully formed (this returns App) so the module's App.refreshRail/persist bridges resolve.
    if (typeof AutoSessions !== 'undefined') AutoSessions.init();
    // G3a PRIDE LAYER: arm the durable lifetime STATION RECORD — folds real completed runs / delivered
    // work-items / fired routines / summed run durations into counters that persist across sessions (own key,
    // read-only on the bus). The COMMANDER DOSSIER panel renders snapshot() as the STATION RECORD block.
    if (typeof PrideStore !== 'undefined') PrideStore.init();
    // G3b SEED-REUSE AGGREGATE: arm the durable per-seed run tally (own key). The digest feeds it the
    // provenance-matched while-away rows; it powers the TROPHY CASE's living-tools shelf + the once-per-window
    // "your seed ran 5× this week" callout. ReturnStore's digest is delayed (setTimeout), so this synchronous
    // init lands before the first digest can feed it — the first while-away digest is tallied.
    if (typeof SeedReuseStore !== 'undefined') SeedReuseStore.init();
    // AUTOPILOT (autonomy Slice A — the idle self-direction driver): when the Commander goes idle with autonomy
    // enabled, the station either EARNS context (asks one gentle get-to-know-you question — A1) or, once the dial
    // permits acting AND the dossier is hot AND today's leash has budget, it ACTS — runs the anti-slop pipeline as
    // two SILENT reason-only runs (no tools → safe) and leaves a draft on the desk (A2). The decision is pure
    // (autopilot.js); this is the edge — the live clock, the activity listeners + idle tick (installed once), the
    // curiosity hand-off, the model runs, and the desk delivery. It reads the posture + the (confirmed-only)
    // dossier, never writes either. Reach stays sandbox — nothing is auto-sent or auto-applied (Stage B raises it).
    if (typeof AutopilotStore !== 'undefined') AutopilotStore.init({
      now: () => Date.now(),
      getPosture: () => (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary) ? AutonomyStore.summary() : null,
      getDossier: () => (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null,
      getBeliefs: (dim) => (typeof DossierStore !== 'undefined' && DossierStore.beliefs) ? DossierStore.beliefs(dim) : [],
      offerCuriosity: () => (typeof Chat !== 'undefined' && Chat.offerCuriosity) ? Chat.offerCuriosity() : false,
      getSystem: () => agent ? agent.systemPrompt : '',
      getName: () => agent ? agent.name : 'AGENT',
      // the autopilot's reason-only runs: no `placed` (no tools) + internal (silent) → safe + uncounted by construction.
      chat: (o) => (typeof Harness !== 'undefined' && Harness.chat) ? Harness.chat(o) : Promise.resolve({ error: 'no-harness' }),
      // B2 — the real-write hand-off. canWriteFiles = the cabinet:write CONSENT (PermissionsStore); hasCabinet = the
      // cabinet CAPABILITY actually placed (World.heroCaps — object=capability); BOTH required (Autopilot.canWrite).
      // writeFile = the token-gated, consent-broker-gated, checkpointed server write (/api/autonomy/write). A failed
      // or denied write just degrades to a desk draft (the act() branch handles the fallback).
      canWriteFiles: () => { try { return (typeof PermissionsStore !== 'undefined' && PermissionsStore.snapshot) ? (PermissionsStore.snapshot().grants || []).indexOf('cabinet:write') >= 0 : false; } catch (_) { return false; } },
      hasCabinet: () => { try { return (typeof World !== 'undefined' && World.heroCaps) ? (World.heroCaps((agent && agent.id) || 'agent') || []).indexOf('cabinet') >= 0 : false; } catch (_) { return false; } },
      writeFile: (req) => fetch('/api/autonomy/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: (agent && agent.id) || 'agent', path: req.path, content: req.content }) }).then(r => r.ok ? r.json() : { ok: false }).catch(() => ({ ok: false })),
      // leave the result on the Commander's desk: a persistent toast + the live "working" cue + a gentle COMMS beat
      // that, on accept, posts the work into the feed. If it WROTE a real file (B2) the copy says so + names the path;
      // otherwise it's a desk draft. Either way nothing is sent/published/spent.
      present: (d) => {
        const didWrite = !!(d && d.wrote && d.wrote.path);
        // ONE SURFACE PER MOMENT (beat-fat trim 2026-07-03): the COMMS nudge below is the announcement — an
        // actionable beat sitting in the feed. The toast only fires as the FALLBACK when the nudge can't render
        // (no Chat yet), so the same draft is never announced twice (toast + nudge was the "pushy" double).
        // World.say stays: an ambient in-world cue, not a popup. The return digest recaps everything anyway.
        const canNudge = typeof Chat !== 'undefined' && Chat.nudge;
        if (!canNudge && typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify((didWrite ? 'wrote a file while you were away: ' : 'drafted while you were away: ') + d.title, 'gold', 'cronDigest');   // P1-8 category: autonomous run
        if (typeof World !== 'undefined' && World.say) World.say(didWrite ? '✦ saved a file to your workspace' : '✦ left a draft on your desk');
        if (canNudge) Chat.nudge(
          didWrite
            ? ('✦ while you were away i wrote “' + d.title + '” to your workspace (' + d.wrote.path + '). want to see it?')
            : ('✦ while you were away i drafted “' + d.title + '”. want to see it?'),
          [{ label: 'show me', value: 'yes' }, { label: 'not now', value: 'no', skip: true }],
          item => {
            if (!item || item.value !== 'yes') return;
            if (typeof Chat.localLine === 'function') { Chat.localLine((didWrite ? '✎ ' : '▤ ') + d.title + (didWrite ? '  ·  ' + d.wrote.path : '')); Chat.localLine(d.body); }
            // LEARN HOOK (A3): a one-tap useful/not on the work it just showed → AutopilotStore.rate re-weights selection per Commander.
            if (typeof Chat.nudge === 'function') Chat.nudge('was that worth doing?',
              [{ label: 'useful', value: 'up' }, { label: 'not really', value: 'down', skip: true }],
              r => { if (typeof AutopilotStore !== 'undefined' && AutopilotStore.rate) AutopilotStore.rate(d.archetype, !!(r && r.value === 'up')); });
          }
        );
      },
      // the WELCOME-BACK digest (A3): on the first interaction after a real absence, one gold beat truthfully
      // recapping what the station did while away — composed from the draft log, no new events.
      digest: (info) => {
        const mins = Math.max(1, Math.round(info.awayMs / 60000));
        // B3 — report what was WRITTEN vs drafted, and offer a one-tap UNDO. The headline + the ✎/▸ lines compose
        // ENTIRELY from the draft log (no new events). Undo = restore the EARLIEST write's pre-snapshot, which rolls
        // the WHOLE workspace back to before any away-write — so the copy says exactly that (honest, not per-file).
        const sum = (typeof Autopilot !== 'undefined' && Autopilot.digestSummary) ? Autopilot.digestSummary(info.drafts) : { wroteCount: 0, draftCount: (info.drafts || []).length, undoSnapshot: null };
        const headline = (typeof Autopilot !== 'undefined' && Autopilot.digestHeadline) ? Autopilot.digestHeadline(sum) : ((info.drafts || []).length + ' on your desk');
        const lines = (info.lines && info.lines.length) ? '\n' + info.lines.join('\n') : '';
        const canUndo = !!(sum.wroteCount && sum.undoSnapshot);
        const restore = (snap) => fetch('/api/checkpoint/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: (agent && agent.id) || 'agent', snapshotId: snap }) }).then(r => r.ok).catch(() => false);
        // TRANSPARENCY LAW — the digest must be able to SHOW the work, not just count it. "show me" prints every
        // fresh draft's full body (and the real path of anything written) straight into the feed from the draft
        // log — the Commander never has to take "1 draft on your desk" on faith.
        const reveal = () => {
          if (typeof Chat === 'undefined' || typeof Chat.localLine !== 'function') return;
          for (const d of (info.drafts || [])) {
            if (!d || !d.title) continue;
            const wrotePath = d.wrote && d.wrote.path;
            Chat.localLine((wrotePath ? '✎ ' : '▤ ') + String(d.title).trim() + (wrotePath ? '  ·  ' + wrotePath : ''));
            if (d.body) Chat.localLine(String(d.body));
            else Chat.localLine(wrotePath ? '(the full text is in the file above)' : '(this draft has no saved body — it may predate the draft log)');
          }
        };
        const showBeat = () => {
          if (typeof Chat === 'undefined' || !Chat.nudge) return;
          const opts = [{ label: 'show me', value: 'show' }, { label: 'got it', value: 'ok', skip: true }];
          if (canUndo) opts.push({ label: 'undo the writes', value: 'undo' });
          Chat.nudge(
            '✦ welcome back — while you were away (' + mins + 'm): ' + headline + lines + (canUndo ? '\n(undo rolls your workspace back to before i wrote them)' : ''),
            opts,
            item => {
              if (!item) return;
              if (item.value === 'show') return reveal();
              if (item.value !== 'undo' || !canUndo) return;
              restore(sum.undoSnapshot).then(ok => {
                if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(ok ? 'rolled back the files i wrote while you were away' : 'could not roll back — the snapshot is gone', ok ? 'gold' : 'warn');
                if (ok && typeof World !== 'undefined' && World.say) World.say('✦ rolled back my away-writes');
              });
            });
        };
        // ONE SURFACE PER MOMENT (beat-fat trim 2026-07-03): the welcome-back nudge (showBeat) IS the digest —
        // richer than a toast (show me / undo) and it fires at the same instant the toast used to, saying the
        // SAME sentence. The toast is now only the FALLBACK when the nudge can't render (no Chat), so the
        // Commander's first interaction back is greeted once, not twice.
        if ((typeof Chat === 'undefined' || !Chat.nudge) && typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('while you were away (' + mins + 'm): ' + headline, 'gold', 'cronDigest');   // P1-8 category: autonomous digest
        // DEFERRED a beat: this fires from the capture phase of the Commander's first pointerdown/keydown back.
        // Posting the nudge synchronously would clearNudge()/clearChoices() an in-flight answer on a live beat
        // (e.g. the per-draft "show me" chip) mid-press — the very tap that woke the digest would be eaten.
        setTimeout(showBeat, 400);
      }
    });
    if (typeof Voice !== 'undefined') Voice.init({ name: agent.name, personaId: agent.personaId, resumeCue: !opts.awaitingPurpose });   // mic + this agent's per-persona voice; offer hands-free resume except during the awakening
    if (typeof ModelDock !== 'undefined') ModelDock.init({ apply: applyQuickModel });
    syncChannels();   // if a Telegram bot auto-started from saved config, refresh it to THIS agent's live identity
    pushRoster();     // Stage 2: seed the sidecar with the live crew so the lead can delegate (no-op for a solo station)
    renderRail();
    el('ws-new').onclick = newWorkstream;
    { const wsArch = el('ws-archived'); if (wsArch) wsArch.onclick = toggleArchived; }
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
        getSystem: () => agent ? agent.systemPrompt : '',    // Interview 2.0: the generated beats (wakemind.js) reason on the LIVE prompt (persona + dossier already folded in)
        done: () => { if (agent) agent.onboarded = true; persist(); if (typeof KeyCTA !== 'undefined' && KeyCTA.arm) KeyCTA.arm(); },   // the awakening landed — mark onboarded so a later refresh resumes into the game, not back into the ceremony; arm the keyless-brain CTA (shows only if no key is truly stored)
        notify: (typeof StationUI !== 'undefined') ? StationUI.notify : null,
        // FIRST COMMAND — once the awakening lands, the agent itself teaches the Commander the one real loop (tutorial.js)
        taught: () => { if (typeof Tutorial !== 'undefined' && Tutorial.firstCommand) Tutorial.firstCommand({ name: agent.name }); }
      });
    }
    // A returning (already-onboarded) hero skips the awakening, so its `done` callback never re-fires — arm the
    // keyless-brain CTA here so a station saved without a key still surfaces the honest "add a key" banner on boot.
    // (It's a pure state projection: it stays hidden when a key IS stored.) The awakening path arms it in `done`.
    if (!opts.awaitingPurpose && typeof KeyCTA !== 'undefined' && KeyCTA.arm) KeyCTA.arm();
    // P3: arm the first-steps briefing's bus ticks; re-offer the checklist to a returning user mid-progress
    if (typeof Tutorial !== 'undefined' && Tutorial.onEnterGame) Tutorial.onEnterGame();
    // G1c: the deferred BUILD-dock glow — a soft standing hint on the BUILD dock while a station quest is open
    // (the fix is one click away). Stands down while the tutorial is coaching (tutorial wins). Started here so
    // it only ever runs on the floor; disconnect() stops it.
    if (typeof DockGlow !== 'undefined' && DockGlow.start) DockGlow.start();
    el('btn-disconnect').onclick = disconnect;
  }

  // (the single-question purpose interview was replaced by the AWAKENING — Onboarding authors purpose.md
  //  and the other config docs through applyAgentConfig; see onboarding.js + enterGame.)

  /* ---------- workstreams rail (left) ---------- */
  // A rail row is ONE LINE — exactly as compact as before — but now carries LIVE STATE: the dot pulses while a run
  // is in flight on that stream (gold when it's paused awaiting your approval), and a right-aligned time token
  // reads the live elapsed while busy or a relative "last worked" stamp when idle. The busy signal is read
  // straight from Channels (channels.js) — the same per-workstream run-state the COMMS header trusts — so it's
  // honest by construction and needs no new backend wiring: the rail already re-renders at run start + finish, and
  // a 1s ticker keeps the seconds moving. The full status word ("working…"/"awaiting your approval…") lives in the
  // row's hover tooltip so the one-line layout never has to spell it out.
  let railTicker = 0;
  let railShowArchived = false;   // when true the rail also lists archived (put-away) sessions, dimmed
  function railFmtElapsed(ms) {
    const s = Math.floor((ms < 0 ? 0 : ms) / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;   // 4s · 42s · 1:05
  }
  function railRelTime(ms) {                     // compact right-edge stamp: now · 2m · 1h · 3d
    if (!ms) return '';
    const d = Date.now() - ms;
    if (d < 60000) return 'now';                 // under a minute reads "now" (never "0m")
    const m = Math.floor(d / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }
  // the live presentation of one row: the dot class (pulsing run / gold attention / idle lane color), the compact
  // right-edge meta (elapsed while busy, relative stamp when idle), and the busy/attn flags + full status word for
  // the hover tooltip. Pure read of Channels + the record — no mutation.
  function railRowState(w) {
    if (typeof Channels !== 'undefined' && Channels.isBusy(w.id)) {
      const status = Channels.statusOf(w.id);
      const attn = /approval/.test(status);
      const started = Channels.startedAtOf(w.id);
      return { dot: 'ws-dot ' + (attn ? 'attn' : 'running'), meta: started ? railFmtElapsed(Date.now() - started) : '…', busy: true, attn, status };
    }
    return { dot: 'ws-dot lane-' + w.lane, meta: railRelTime(w.lastActiveAt), busy: false, attn: false, status: '' };
  }
  function rowClass(w, st, activeId) {
    return 'ws-row' + (w.id === activeId ? ' sel' : '') + (st.busy ? ' busy' : '') + (st.attn ? ' attn' : '')
      + (w.pinned ? ' pinned' : '') + (w.archived ? ' archived' : '')
      + (Workstreams.unread(w) ? ' unread' : '');   // real unseen activity (lastActiveAt > lastReadAt, never the open stream)
  }
  function renderRail() {
    const ul = el('workstreams');
    if (!ul || typeof Workstreams === 'undefined') return;
    const activeId = Workstreams.activeId();
    ul.innerHTML = Workstreams.list({ includeArchived: railShowArchived }).map(w => {
      const title = w.title || 'General';
      const st = railRowState(w);
      const tip = title + (w.archived ? ' · archived' : '') + (st.busy ? ' · ' + st.status : '')
        + (Workstreams.unread(w) ? ' · new activity' : '') + ' — right-click for actions';
      return '<li class="' + rowClass(w, st, activeId) + '" data-id="' + U.esc(w.id) + '" title="' + U.esc(tip) + '">' +
        '<span class="' + st.dot + '"></span>' +
        (w.pinned ? '<span class="ws-pin" aria-hidden="true">★</span>' : '') +
        '<span class="ws-title">' + U.esc(title) + '</span>' +
        '<span class="ws-unread" aria-hidden="true"></span>' +
        '<span class="ws-meta">' + U.esc(st.meta) + '</span>' +
        '<button class="ws-kebab" tabindex="-1" aria-label="session actions" title="session actions">⋯</button>' +
        '</li>';
    }).join('');
    ul.querySelectorAll('.ws-row').forEach(li => {
      const id = li.dataset.id;
      li.onclick = () => switchWorkstream(id);
      // right-click OR the hover ⋯ button opens the same actions menu (rename · pin · archive · delete)
      li.oncontextmenu = (e) => { e.preventDefault(); openWsMenu(id, e.clientX, e.clientY); };
      const keb = li.querySelector('.ws-kebab');
      if (keb) keb.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const r = keb.getBoundingClientRect(); openWsMenu(id, r.left, r.bottom + 2); };
    });
    updateArchivedToggle();
    armRailTicker();
    if (typeof StationUI !== 'undefined' && StationUI.refreshBoard) StationUI.refreshBoard();
  }
  // ONE always-on 1s heartbeat keeps the rail truthful while in-game: the busy elapsed counts up AND the idle
  // "last worked" stamps age (2m → 3m) even when nothing is running. It's cheap — every write is change-detected,
  // so a quiet rail does a handful of string compares a second and touches no DOM. It self-stops the moment the
  // rail is gone or the station screen is left (and disconnect() stops it outright); renderRail re-arms on re-entry.
  // Refreshes each row IN PLACE (no innerHTML rebuild) so a click or the scroll position is never reset; the
  // pulsing dot itself is pure CSS — this only swaps the dot CLASS, the right-edge time token, and the row classes.
  function updateRailLive() {
    const ul = el('workstreams'); const game = el('screen-game');
    if (!ul || typeof Workstreams === 'undefined' || !game || !game.classList.contains('active')) { stopRailTicker(); return; }
    const activeId = Workstreams.activeId();
    ul.querySelectorAll('.ws-row').forEach(li => {
      if (li.querySelector('.ws-rename')) return;   // leave a row alone while its title is being edited in place
      const w = Workstreams.get(li.dataset.id); if (!w) return;
      const st = railRowState(w);
      const dot = li.querySelector('.ws-dot'); if (dot && dot.className !== st.dot) dot.className = st.dot;
      const meta = li.querySelector('.ws-meta'); if (meta && meta.textContent !== st.meta) meta.textContent = st.meta;
      const cls = rowClass(w, st, activeId); if (li.className !== cls) li.className = cls;
    });
  }
  function armRailTicker() { if (!railTicker) railTicker = setInterval(updateRailLive, 1000); }
  function stopRailTicker() { if (railTicker) { clearInterval(railTicker); railTicker = 0; } }
  // A backgrounded tab FREEZES/intensively-throttles its timers, so the live clock stalls while you're away. The
  // instant the station is visible again, snap every row back to truth (and re-arm the heartbeat) so the elapsed
  // and "last worked" stamps are never caught stale — they jump straight to correct, not after the next tick.
  // Registered once for the page lifetime; the in-game guard keeps it inert on the title/connect screens.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const game = el('screen-game');
      if (game && game.classList.contains('active')) renderRail();
    });
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
  function openWorkstream(id) { switchWorkstream(id); }
  function newWorkstream() {
    const ws = Workstreams.create(null);
    SFX.open(); Chat.load(ws); refreshUsage(); renderRail(); persist();
  }
  // COMMS AGENT SELECTOR: put the Commander on the line with agent <agentId>. Selecting an agent must never
  // silently rebind an existing conversation to a different agent (that would corrupt whose transcript it is);
  // instead we switch to the agent's most-recent live workstream, or MINT a fresh one bound to that agentId
  // (the same Workstreams.create({agentId}) seam summon uses). switchWorkstream then repoints the focused agent
  // (its model/provider/effort) + Chat.load. Returns the target workstream id, or null for an unknown agent.
  function selectAgent(agentId) {
    const id = String(agentId || '');
    const a = agents.get(id); if (!a) return null;
    // prefer this agent's existing streams (most-recently-active first — Workstreams.list() is already sorted
    // pinned>recent); the General default stream (title==null) is only NOVA/hero's home, so a specialist that
    // has no stream yet gets a fresh one titled with its name (mirrors summon's Workstreams.create).
    const mine = Workstreams.list().filter(w => (w.agentId || 'agent') === id);
    let ws = mine[0] || null;
    if (!ws) ws = Workstreams.create(a.name, { agentId: id, activate: false });
    if (!ws) return null;
    if (ws.id === Workstreams.activeId()) { focusAgent(id); Chat.load(ws); }   // already here: just re-affirm focus/labels
    else switchWorkstream(ws.id);
    return ws.id;
  }

  /* ---------- session (workstream) row actions: rename · pin · archive · delete ----------
     Reached by right-click OR the hover ⋯ on any rail row. A floating menu drawn in the phosphor
     chrome (no native context menu / no window.prompt / no window.confirm): rename is edited IN
     PLACE in the row, delete is a two-step arm/confirm (the terminal idiom for anything destructive),
     and every mutation goes through the Workstreams store — which already guards General from being
     archived or deleted — then re-renders + persists. Archived streams are hidden by default; the
     ARCHIVED toggle in the rail head reveals them so they can be restored or deleted. */
  let wsMenuEl = null;
  function closeWsMenu() {
    if (!wsMenuEl) return;
    wsMenuEl.remove(); wsMenuEl = null;
    document.removeEventListener('pointerdown', onWsMenuOutside, true);
    document.removeEventListener('keydown', onWsMenuKey, true);
    window.removeEventListener('blur', closeWsMenu);
    window.removeEventListener('resize', closeWsMenu);
    const ul = el('workstreams'); if (ul) ul.removeEventListener('scroll', closeWsMenu, true);
  }
  function onWsMenuOutside(e) { if (wsMenuEl && !wsMenuEl.contains(e.target)) closeWsMenu(); }
  function onWsMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeWsMenu(); } }
  function openWsMenu(id, x, y) {
    closeWsMenu();
    const w = Workstreams.get(id); if (!w) return;
    const isGeneral = (id === Workstreams.generalId());
    const menu = document.createElement('div');
    menu.className = 'ws-menu'; menu.setAttribute('role', 'menu');
    const item = (act, label, glyph, cls) =>
      '<button class="ws-menu-item' + (cls ? ' ' + cls : '') + '" role="menuitem" data-act="' + act + '">' +
      '<span class="ws-menu-glyph" aria-hidden="true">' + glyph + '</span>' + U.esc(label) + '</button>';
    let html = item('rename', 'Rename', '✎') + item('pin', w.pinned ? 'Unpin' : 'Pin to top', w.pinned ? '☆' : '★');
    if (!isGeneral) {
      html += item('archive', w.archived ? 'Unarchive' : 'Archive', w.archived ? '⇱' : '⇲') +
        '<div class="ws-menu-sep"></div>' + item('delete', 'Delete', '✕', 'danger');
    }
    menu.innerHTML = html;
    document.body.appendChild(menu);
    // clamp to the viewport so a row near an edge still shows the whole menu
    const r = menu.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    menu.style.left = Math.max(6, Math.min(x, vw - r.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, vh - r.height - 6)) + 'px';
    wsMenuEl = menu;
    menu.querySelectorAll('.ws-menu-item').forEach(btn => {
      const act = btn.dataset.act;
      if (act === 'delete') {   // destructive → arm on first click, act on a second within 4s
        btn.addEventListener('click', () => {
          if (btn.dataset.armed) { closeWsMenu(); deleteWorkstream(id); return; }
          btn.dataset.armed = '1'; btn.classList.add('armed');
          btn.innerHTML = '<span class="ws-menu-glyph" aria-hidden="true">✕</span>Confirm delete';
          SFX.bad();
          setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove('armed'); btn.innerHTML = '<span class="ws-menu-glyph" aria-hidden="true">✕</span>Delete'; } }, 4000);
        });
      } else {
        btn.addEventListener('click', () => { closeWsMenu(); wsMenuAction(act, id); });
      }
    });
    document.addEventListener('pointerdown', onWsMenuOutside, true);
    document.addEventListener('keydown', onWsMenuKey, true);
    window.addEventListener('blur', closeWsMenu);
    window.addEventListener('resize', closeWsMenu);
    const ul = el('workstreams'); if (ul) ul.addEventListener('scroll', closeWsMenu, true);
    SFX.click();
  }
  function wsMenuAction(act, id) {
    const w = Workstreams.get(id); if (!w) return;
    if (act === 'rename') { beginRenameRow(id); return; }
    if (act === 'pin') { Workstreams.pin(id, !w.pinned); SFX.click(); renderRail(); persist(); return; }
    if (act === 'archive') {
      const wasActive = (id === Workstreams.activeId());
      const nowArchived = !w.archived, label = w.title || 'General';
      if (!Workstreams.archive(id, nowArchived)) { SFX.bad(); return; }
      SFX.close();
      if (wasActive && Workstreams.activeId() !== id) loadActiveStream();   // archiving the OPEN stream falls back to General
      renderRail(); persist();
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify((nowArchived ? 'archived ' : 'restored ') + '“' + label + '”', '');
    }
  }
  function deleteWorkstream(id) {
    const w = Workstreams.get(id); const label = w ? (w.title || 'General') : '';
    const wasActive = (id === Workstreams.activeId());
    if (!Workstreams.del(id)) { SFX.bad(); return; }
    SFX.bad();
    if (wasActive) loadActiveStream();   // deleting the OPEN stream falls back to General
    renderRail(); persist();
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('deleted “' + label + '”', 'warn');
  }
  // re-open whatever the store now treats as active (after archive/delete bumps the open stream to General)
  function loadActiveStream() {
    const a = Workstreams.active(); if (!a) return;
    focusAgent(a.agentId || 'agent'); Chat.load(a); refreshUsage();
  }
  // RENAME in place: the row title becomes an input. Enter / blur commits, Esc cancels. An empty commit
  // on a normal stream is treated as cancel (so it can never collapse into a stray second "General"); the
  // real General stays title=null. rename() locks titleAuto so the one-shot auto-title can't later stomp it.
  function beginRenameRow(id) {
    const ul = el('workstreams'); if (!ul) return;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
    const li = ul.querySelector('.ws-row[data-id="' + sel + '"]'); if (!li) return;
    const titleSpan = li.querySelector('.ws-title'); if (!titleSpan || li.querySelector('.ws-rename')) return;
    const w = Workstreams.get(id); if (!w) return;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'ws-rename'; input.maxLength = 80;
    input.value = w.title || ''; input.placeholder = 'General';
    li.classList.add('renaming');
    titleSpan.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      let changed = false;
      if (save) {
        const v = input.value.trim();
        if (v || id === Workstreams.generalId()) changed = Workstreams.rename(id, v);   // empty on a normal stream = cancel
      }
      if (changed) {
        SFX.click(); persist();
        if (id === Workstreams.activeId() && typeof Chat !== 'undefined' && Chat.load) { const a = Workstreams.active(); if (a) Chat.load(a); }   // refresh the COMMS header title
      }
      renderRail();
    };
    input.addEventListener('click', e => e.stopPropagation());   // don't switch the stream while editing its name
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }
  // the rail-head ARCHIVED toggle: shown only when ≥1 stream is archived; flips the rail between
  // hiding and revealing them (revealed rows are dimmed and offer Unarchive in their menu).
  function updateArchivedToggle() {
    const btn = el('ws-archived'); if (!btn) return;
    let n = 0; for (const w of Workstreams.list({ includeArchived: true })) if (w.archived) n++;
    if (!n) { btn.hidden = true; btn.classList.remove('on'); railShowArchived = false; return; }
    btn.hidden = false;
    btn.classList.toggle('on', railShowArchived);
    btn.textContent = (railShowArchived ? '▾ ' : '▸ ') + 'ARCHIVED ' + n;
    btn.title = railShowArchived ? 'hide archived sessions' : 'show ' + n + ' archived session' + (n === 1 ? '' : 's');
  }
  function toggleArchived() { railShowArchived = !railShowArchived; SFX.click(); renderRail(); }

  // DISCONNECT (the ⏏ button) tears down the live game but NEVER wipes data and NEVER lands on a dead title
  // screen — it persists, then re-enters via reentry(): straight back into the station if creds are still in
  // hand, otherwise the RESUME-mode connect screen. The agent is always preserved.
  function disconnect() { if (typeof Onboarding !== 'undefined' && Onboarding.stop && Onboarding.isRunning && Onboarding.isRunning()) Onboarding.stop(); if (typeof Tutorial !== 'undefined' && Tutorial.teardown) Tutorial.teardown(); if (typeof DockGlow !== 'undefined' && DockGlow.stop) DockGlow.stop(); if (typeof Intake !== 'undefined' && Intake.stop) Intake.stop(); SFX.close(); Chat.abort(); stopRailTicker(); World.stop(); if (World.pauseBridge) World.pauseBridge(); persist(); if (typeof StationUI !== 'undefined') StationUI.leave(); reentry(); }

  /* ---------- creation ---------- */
  // Guarded: a genuine FRESH start (no save) wipes any stale resume pointer and opens CREATE YOUR OVERSEER.
  // But if a resume is mid-flight (resumingSaved set, e.g. recovery), do NOT clear it from here — the connect
  // screen must keep its RESUME binding so a key re-entry continues the saved agent rather than re-speccing one.
  function startCreation() {
    SFX.boot(); SFX.open();
    const hasSave = Save.has() && !!Save.load();
    if (!resumingSaved || !hasSave) resumingSaved = null;
    show('screen-connect'); initConnect();
  }

  /* ---------- boot ---------- */
  async function init() {
    if (Harness.init) await Harness.init();   // desktop: load the keychain "configured?" flag first
    if (typeof StationUI !== 'undefined') StationUI.init();   // applies saved theme/CRT settings, wires the bottom bar
    if (typeof Updates !== 'undefined' && typeof StationUI !== 'undefined') Updates.init({ notify: StationUI.notify, rerender: StationUI.rerender });
    // (the title screen — RESUME / NEW STATION / the destructive NEW AGENT wipe — is gone; boot auto-resumes,
    //  see the three-way at the foot of init(). Re-entry is handled by reentry()/startCreation().)

    // data portability — the safety net for the localStorage-fragile agent. Export bundles every
    // starnet.* key + a memory snapshot into one file; import restores it on any browser.
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
      reentry();   // resume straight into the restored agent (or its RESUME screen if creds are still missing)
    };

    // durable restore: adopt whichever of {localStorage cache, sidecar mirror} is NEWER. This is what brings
    // the agent back after a browser-cache wipe (local gone, the sidecar still holds it) and refreshes the
    // cache to match. Best-effort: an unreachable sidecar just falls back to the local cache.
    if (typeof CloudSave !== 'undefined') CloudSave.installUnloadFlush();
    const saved = (typeof CloudSave !== 'undefined') ? await CloudSave.reconcile(Save.load()) : Save.load();
    // restore the provider BEFORE the credential check so a codex agent (tokens server-side) jumps straight
    // in after a wipe/origin-reset instead of being misrouted to an OpenRouter key prompt.
    if (saved && saved.prov && Harness.setProv) Harness.setProv(saved.prov);
    if (saved && saved.reasoningEffort && Harness.setReasoningEffort) Harness.setReasoningEffort(saved.reasoningEffort);
    if (saved && saved.agent) {
      // AUTO-RESUME: a saved station goes STRAIGHT back into the world when creds are available — an OpenRouter
      // key in hand, the desktop keychain holds one (configured, incl. the DEV fast-path), OR the Codex provider
      // (OAuth tokens live server-side; a missing/expired one surfaces as a run error that prompts re-sign-in).
      // NEVER gate reaching the floor on the model catalog: listModels() proxies a LIVE external OpenRouter fetch
      // and if that is slow/blocked, awaiting it here strands boot on the connect screen forever (the seeded DEV
      // shoot regression). The catalog is cosmetic for resume (dropdown/pricing/context gauge), so fire it in the
      // BACKGROUND and enter the station immediately — pricing fills in a beat later, the floor never waits.
      const canResume = !!(Harness.getKey() || (Harness.configured && Harness.configured()) || Harness.getProv() === 'codex');
      if (canResume) {
        if (Harness.getProv && Harness.getProv() !== 'codex' && Harness.listModels) { Promise.resolve(Harness.listModels()).catch(() => {}); }
        resumeInto(saved); return;
      }
      // saved station, but the credentials are gone (cache/origin wipe). RESUME-mode recovery screen: a banner,
      // the model pre-filled, identity locked read-only — the agent is preserved, only the brain re-connects.
      // Here the model dropdown DOES want the catalog, but bound the wait so a hung network can't strand the
      // recovery screen either — a timeout just yields an empty dropdown the Commander can still type a slug into.
      if (Harness.getProv && Harness.getProv() !== 'codex' && Harness.listModels) await Harness.listModels();
      resumingSaved = saved;
      show('screen-connect'); initConnect(saved.agent.name, true, saved.agent);
      return;
    }
    // FIRST RUN (no save) — straight to CREATE YOUR OVERSEER.
    startCreation();
  }
  init();

  // crewCount: the live crew size (hero + summoned minds) — read by the quest log's station arc.
  // agentName/heroId (G1b): the station-quest generator names the acting agent from the LIVE roster
  // (never an id in the UI) and keys its standing candidates against the focused hero.
  // currentAgent/agents/applyConfig (slash-plan): the slash-command suite reads/writes the live roster
  // and per-agent config (/agents, /model, /personality, …).
  return { show, refreshUsage, persist, refreshRail: renderRail, openWorkstream, summonAgent, summonForRequest, crewCount: () => agents.size,
    agentName: id => { const a = agents.get(id); return a ? (a.name || a.id) : null; },
    heroId: () => (agent ? agent.id : 'agent'),
    currentAgent: () => agent,
    agents: () => liveAgents().map(serializeAgentLite),
    selectAgent: selectAgent,   // COMMS top-bar agent selector: switch to (or mint) a workstream bound to agentId
    openSummonBay: openSummonBay,   // adaptive-recruitment beat: accepting the recruit nudge deep-links into the bay's summon flow
    applyConfig: applyAgentConfig };
})();
