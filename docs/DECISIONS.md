# DECISIONS.md — locked decision log

Decisions that are **settled**. Do not re-litigate them in a session; do not "improve" them
in passing. If you believe one is wrong, surface it to Andrew as a question — don't change it.
Each entry: the decision, why, and the date it locked (where known).

Companion files: [BRAIN.md](BRAIN.md) (start here) · [MISTAKES.md](MISTAKES.md) ·
[NEXT.md](NEXT.md). The `.claude/skills/starnet-*` skills are the enforcement layer for
many of these — they win on any wording conflict.

## Product

- **StarNet is a beginners product.** Sandbox freedom, full power from minute one, NEVER
  grind/unlock/permission walls. (Locked; see also skills.)
- **Truthful telemetry is THE core law.** The app must never assert state the harness can't
  prove. Object = capability: a prop in the world is a real grant, not decoration. Tool
  surface must never exceed wired reality.
- **Eerie-not-cute** tone. A living pixel-art station doing REAL work.
- **Deliverable = OPEN, not read** (2026-07-04). The payoff action on a finished work card is
  opening the runnable artifact, not viewing source. View-source is demoted.
- **Engagement = the daily loop adapting to the user — NEVER a gauge/score UI.** (North Star.)
- **Model is a roster property, never per-chat** (2026-07-03). /model and the model dock act
  on the agent, not the conversation.
- **Specialists own only their desk.** All other props are station-shared via the overseer.
  Never build per-agent prop kits.
- **Skills = HOW, Recipes = WHAT, Routines = WHEN.** Marketplace framing; meter compute, not
  recipes (open-core).
- **Connectors OUT > channels IN** (two-axis framing, 2026-07-06). Google Workspace is a
  connector, not a messaging channel. Curated one-click MCP catalog is the chosen path for
  "more connectors"; paste-a-key tier is bearer-only-honest; OAuth 2.1 generic client is live.
- **Monetization:** BYOK free forever + resold-AI (managed-key starter credits) as the single
  revenue rail. One SKU. (Roadmap 2026-07-04.)
- **Growth thesis:** spectacle/watchability is the long-term growth engine (clips, postcards).

## Visual / world (see starnet-frontend-law skill for the full set)

- **Hover = tiny nameplate glance, never a window.** Canvas text = VT323 + phosphor glow.
- **Couch = sofa BACK view + sitter y-sort seatPy+1** (2026-07-03, 8dad4503). Never revert.
- **Sprites:** Pixellab, not Sprite AI. Author chunky ~48px; smooth-downscale the 92px master
  in drawBody — never NN-crush. Foot-shadow anchors agent FEET to the floor line (215132a).
- **Props are on the v3 LOCKED STYLE LAW** (2026-07-02, 7738419).
- **Music is REMOVED by design** (2026-07-04, e6d74bab). audio.js is a sound Director only;
  SFX = one console voice. Never re-add music unasked.
- **CRT look is BOLD not subtle**; iterate via `?crtlab=1` and copy values out.
- **COMMS beats:** decided cards must `vanish()`; ONE post-run beat at a time; gold-inset
  beat family (no `.reply` for asides).
- **Voice v2 final character set** (2026-07-05, 9b666fee): VENOM default = Algenib@0.88deep,
  SURFER = Zubenelgenubi, ULTRON = Algenib@1.0 + machine-shell FX. Style pace words are a
  literal drag — PACE-WORD LAW, never regress. TTS /api/tts is 200-always contract.

## Engineering / process

- **`npm start` (:8787), never `npm run serve`** (dead, UI-only path).
- **One process, one runOnce loop, U.bus frozen events** (see starnet-backend-law).
  `shared/events.js` + `shared/schema.js` are owned; changes additive-only, by request.
- **Rebrand:** Skynet → StarNet (2026-06-22) on all SHIPPED surfaces; internal `skynet.*`
  keys/schemas/env vars intentionally kept — do not "finish" the rename.
- **Hermes branding stripped from shipped surface** (2026-07-04); attribution lives in
  NOTICE.md (MIT — keep it). The `hermes-proven` QA enum is kept on purpose.
- **Reflection mints FACT/PREFERENCE only, never SKILL.** Asks are WORK-EARNED (3 task-runs
  floor), study 1/session. Never regress the earn gate.
- **Awakening/interview questions must be concrete + targeted** — never "what does good look
  like"; the pain-question is the template.
- **Fill gaps by research, don't ask.** Only genuine product forks go to Andrew.
- **Delegation:** implementation agents run on Opus; the orchestrator session briefs,
  merge-gates, and never shotgun-codes across lanes.
- **Codex branches: merge, never rebase.** Claude is the merge gate; grep symbols after every
  hotfile merge (29-hotfile no-touch set — see starnet-merge-ritual).
- **Desktop architecture truth:** the installed app's webview loads the frontend COMPILED INTO
  THE EXE (tauri.localhost). Folder patches never touch the installed UI; CDP-attach is the
  only installed-UI proof. Updater feeds from GitHub Releases (`starnet-releases`).
- **Release gate order:** gate runs AFTER version bump, BEFORE tag push (v0.2.0/v0.2.1 were
  burned proving this).
- **QA baseline suppression:** known defects live in `qa/KNOWN_ISSUES.md` fingerprints; the
  ledger refuses re-filing. Retire a row only when the fix lands.
- **The READY claim is machine-gated** (2026-07-07, EL-7). No session, report, or doc may claim
  StarNet is "ready", "perfect standing", or "go-public-able" without pasting a fresh
  `npm run qa:ready` receipt alongside the claim. `qa:ready` (`scripts/qa/ready.mjs`) prints ONE
  verdict — `READY` or `NOT READY — <numbered reasons>` + a per-check receipts block — and exits 0
  only when READY. It gates on five real artifacts: ledger open P0/P1 == 0 · Green Guardian last
  cycle GREEN + fresh (≤24h) + on the current trunk head · qa:journeys last run pass · Beginner Run
  not STUCK/FAIL · installed-exe smoke stamp GREEN + fresh (≤7d). No-fake-green: any check that can't
  run (missing/unreadable artifact, git failure) is NOT READY, loudly — never a silent pass.
  **Lane-level done stays lane-level:** an agent may say "lane X verified"; station-wide status is
  whatever `qa:ready` says, nothing more. Why: session after session reported lane-green as
  project-green while the Guardian sat RED with open findings — the aggregate claim was never gated
  on anything. Now it is.
  **Authority clarification (2026-07-10, W0):** `qa:ready` is the limited release-readiness
  aggregate defined by those five checks. A READY receipt does **not** prove that every product
  promise, UI surface, or backend implementation is perfected, and it must never be reported as
  `PRODUCT PERFECT`. That exact terminal verdict is reserved to `npm run qa:product-perfect` after
  every candidate-bound wave W0–W7 passes. Neither verdict authorizes publishing, deployment,
  credential rotation, or any other external release operation; those still require the owner's
  explicit authorization.
