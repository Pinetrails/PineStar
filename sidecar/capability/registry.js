/* sidecar/capability/registry.js — CAP_REGISTRY: objectType -> grant[].
   THE static map that makes "room objects = capability grants" real. The builder UI edits
   rows here (data), never code. A grant is a policy triple, not a boolean.

   grant = { capId, tool, scope:'read'|'write'|'execute', requiresConsent, network, paramConstraints? }

   'computer' grants the special capId 'compute' — the precondition to spend a model turn at all
   (the COMPUTE GATE), not a tool the model invokes. Other objects grant callable tools. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.capability = root.SK.capability || {}).registry = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CAP_REGISTRY = {
    computer: [
      { capId: 'compute', tool: 'model.chat', scope: 'execute', requiresConsent: false, network: true },
      // QUEST V2 §B: quest.update rides the `computer` object — the ONE object in BOTH the interactive baseline
      // (compute-only) office AND fullOffice, so EVERY task surface gets it (the interactive surface has no placed
      // notebook, which is why granting this under `notebook` left the tool ABSENT while the STATION QUESTS prompt
      // commanded its use — a truthful-telemetry break). A quest is the agent's OWN standing objective: knowing and
      // updating it is part of being able to think at all — the same freebie class as compute — with no outward
      // mutation until the Commander confirms an attest. capId is 'quest', NOT 'compute': resolve.js treats a
      // 'compute' grant as the COMPUTE GATE (sets hasCompute and `continue`s — never a callable tool), so 'compute'
      // would make quest.update permanently absent. A distinct 'quest' capId surfaces as a real tool and stays honest
      // in every consumer — it has no TOOLSETS_META row (toolsets.js) so it is never a toggleable family (correct: a
      // freebie, like compute), it is not in capsummary's CAPS list so it is never advertised/nagged, and capdrift
      // keys on objectTypes (unchanged) so the prop⇄cap seam is intact. (see tools/builtin/quests.js)
      { capId: 'quest', tool: 'quest.update', scope: 'write', requiresConsent: false, network: false }
    ],
    notebook: [
      { capId: 'memory', tool: 'notebook.write', scope: 'write', requiresConsent: false, network: false },   // private sandboxed memory — no consent gate (see notebook.js)
      { capId: 'memory', tool: 'notebook.read', scope: 'read', requiresConsent: false, network: false },
      { capId: 'memory', tool: 'notebook.feedback', scope: 'write', requiresConsent: false, network: false }, // rate a recalled memory helpful/unhelpful — trust nudge only (see notebook.js)
      { capId: 'memory', tool: 'todo', scope: 'write', requiresConsent: false, network: false },             // in-session task plan — the agent's working memory (see todo.js)
      { capId: 'memory', tool: 'recall_conversation', scope: 'read', requiresConsent: false, network: false }, // H1.3: search your own past dialogue (transcriptstore) — read-only, no consent (see recall.js)
      { capId: 'memory', tool: 'skill.write', scope: 'write', requiresConsent: false, network: false },        // H4: save/edit a reusable procedure (see skills.js)
      { capId: 'memory', tool: 'skill.manage', scope: 'write', requiresConsent: false, network: false },       // H4: create/patch/archive saved skills
      { capId: 'memory', tool: 'skill.list', scope: 'read', requiresConsent: false, network: false },          // H4: list saved skills (metadata only)
      { capId: 'memory', tool: 'skill.view', scope: 'read', requiresConsent: false, network: false },          // H4: load a saved skill's full body
      { capId: 'memory', tool: 'widget.set', scope: 'write', requiresConsent: false, network: false }          // WIDGET RAILS Phase 2: publish/update an agent-fed rail readout — sandboxed local write to the station's own chrome, same trust class as notebook.write (see tools/builtin/widgets.js)
      // QUEST V2 §B: quest.update was MOVED to the `computer` object (above) — see the note there. It rode `notebook`
      // (memory) originally, but the interactive office has no placed notebook, so the tool was absent while the prompt
      // demanded it. It belongs with compute (the always-present freebie), not with placeable memory.
    ],
    // M5: object = capability made real — placing these grants the agent real-world reach.
    cabinet: [
      { capId: 'cabinet', tool: 'fs.read', scope: 'read', requiresConsent: false, network: false },
      { capId: 'cabinet', tool: 'fs.list', scope: 'read', requiresConsent: false, network: false },
      { capId: 'cabinet', tool: 'fs.search', scope: 'read', requiresConsent: false, network: false },
      { capId: 'cabinet', tool: 'fs.write', scope: 'write', requiresConsent: true, network: false },
      { capId: 'cabinet', tool: 'fs.append', scope: 'write', requiresConsent: true, network: false },
      { capId: 'cabinet', tool: 'fs.edit', scope: 'write', requiresConsent: true, network: false },
      { capId: 'cabinet', tool: 'fs.patch', scope: 'write', requiresConsent: true, network: false }
    ],
    dish: [
      { capId: 'web', tool: 'web_search', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'web_fetch', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.navigate', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.snapshot', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.get_text', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.console', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.vision', scope: 'read', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.click', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'web', tool: 'browser.type', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'web', tool: 'browser.press', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'web', tool: 'browser.dialog', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'web', tool: 'browser.scroll', scope: 'execute', requiresConsent: false, network: true },
      { capId: 'web', tool: 'browser.back', scope: 'execute', requiresConsent: false, network: true },
      // Real-screen desktop.open is not an ordinary run capability. The implementation remains
      // registered inertly for a future separate attended host channel, never a placed dish.
    ],
    // CONNECTORS: a 'connector' object is a DYNAMIC capability — its grants are the tools its configured MCP
    // server reports at runtime (tools/list), which can't be statically listed here. The connector manager
    // (sidecar/mcp/manager.js) unions those live tool names into the agent's resolved set per run; the placed
    // instance's binding ({ connectorId }) selects WHICH server. This empty marker just declares 'connector' a
    // known, placeable capability object so the builder/world can treat it like any other room object.
    connector: [],
    // WORKBENCH: real code execution (shell.exec). Opt-in per agent by PLACING this object — no object, no shell,
    // exactly like cabinet=files. scope 'execute' so the consent broker's exec-lockout binds it: an autonomous
    // run can NEVER execute off a cached grant (only an interactive human, or frozen FULL_ACCESS, may approve).
    // The host auto-checkpoints the workspace before every shell call (execution-spine Commit 1), so a command
    // is one rollback away. (Container/job-object OS sandboxing is a deferred backend behind the same tool seam.)
    workbench: [
      { capId: 'workbench', tool: 'shell.exec', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'workbench', tool: 'verify.run', scope: 'execute', requiresConsent: true, network: true },
      // Local UI/game verification stays inside StarNet's headless CDP session. Pointer/keyboard
      // lock is emulated in-page, and coordinate/key input is synthetic — never Win32 input.
      { capId: 'workbench', tool: 'browser.test_navigate', scope: 'read', requiresConsent: false, network: true },
      { capId: 'workbench', tool: 'browser.test_snapshot', scope: 'read', requiresConsent: false, network: false },
      { capId: 'workbench', tool: 'browser.test_input', scope: 'execute', requiresConsent: false, network: false },
      { capId: 'workbench', tool: 'browser.test_state', scope: 'read', requiresConsent: false, network: false },
      { capId: 'workbench', tool: 'shell.bg.status', scope: 'read', requiresConsent: false, network: false },   // H2.2: inspect your background processes
      { capId: 'workbench', tool: 'shell.bg.kill', scope: 'write', requiresConsent: false, network: false }      // H2.2: stop a background process you started
    ],
    // ORCHESTRATOR (Stage 2): grants team.dispatch — the LEAD delegates subtasks to summoned worker agents,
    // each of which runs its OWN real agent loop. dispatch/spawn are CONSENT-GATED (2026-07-14, closes the parked
    // P1 prompt-injection fork): fanning out autonomous budget-spending loops off text in the lead's context needs
    // a human moment in 'ask' mode (session grants stop per-call fatigue; Full Access bypasses) — same semantics
    // as team.summon. The LEAD-ONLY conferral still caps depth at one (the host adds this object ONLY to the
    // watched browser-commanded run), plus the per-worker/day/global budget caps and the concurrency ceiling.
    orchestrator: [
      { capId: 'orchestrator', tool: 'team.dispatch', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'orchestrator', tool: 'team.spawn', scope: 'execute', requiresConsent: true, network: true },
      // team.summon CREATES a new crew member — a stronger, outward-visible mutation than delegating to existing
      // crew, so unlike team.dispatch it IS consent-gated (the APPROVAL-mode confirm beat). Lead-only by the same
      // orchestrator conferral; a delegated worker never gets the orchestrator object and so can never summon.
      { capId: 'orchestrator', tool: 'team.summon', scope: 'write', requiresConsent: true, network: false },
      { capId: 'orchestrator', tool: 'team.subagents', scope: 'read', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'team.interrupt', scope: 'write', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'team.resume', scope: 'execute', requiresConsent: false, network: true },
      // ROUTINES: create StarNet scheduled jobs through the built-in cron store (the same surface as the
      // ROUTINES panel), never through OS crontab / Windows Task Scheduler. Lead-only like the rest of
      // orchestration; creation is consent-gated because it persists autonomous future work.
      { capId: 'orchestrator', tool: 'routine.list', scope: 'read', requiresConsent: false, network: false },
      { capId: 'orchestrator', tool: 'routine.create', scope: 'write', requiresConsent: true, network: false }
    ],
    // STUDIO (media skills): text->image generation + image vision analysis, both on the SAME BYOK OpenRouter
    // key the agent already uses (no new provider). image_generate WRITES a file into the agent's workspace, so
    // it is consent-gated like fs.write; image_analyze only READS an image and returns text (consent-free).
    studio: [
      { capId: 'studio', tool: 'image_generate', scope: 'write', requiresConsent: true, network: true },
      { capId: 'studio', tool: 'image_analyze', scope: 'read', requiresConsent: false, network: true }
    ],
    // JUKEBOX (Spotify): querying playback/library is consent-free (read); CONTROLLING playback is an outward
    // action on the user's account/device, so it is execute + consent-gated. The OAuth session (PKCE, no secret)
    // lives in sidecar/spotify/store.js; an unconnected Spotify makes each tool fail with a "connect it" message.
    jukebox: [
      { capId: 'jukebox', tool: 'spotify_search', scope: 'read', requiresConsent: false, network: true },
      { capId: 'jukebox', tool: 'spotify_now_playing', scope: 'read', requiresConsent: false, network: true },
      { capId: 'jukebox', tool: 'spotify_playlists', scope: 'read', requiresConsent: false, network: true },
      { capId: 'jukebox', tool: 'spotify_play', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'jukebox', tool: 'spotify_pause', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'jukebox', tool: 'spotify_next', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'jukebox', tool: 'spotify_previous', scope: 'execute', requiresConsent: true, network: true },
      { capId: 'jukebox', tool: 'spotify_queue', scope: 'execute', requiresConsent: true, network: true }
    ]
  };

  function deepFreeze(o) {
    Object.freeze(o);
    for (const k in o) { const v = o[k]; if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); }
    return o;
  }
  deepFreeze(CAP_REGISTRY);

  return { CAP_REGISTRY };
});
