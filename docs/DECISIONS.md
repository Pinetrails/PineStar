# DECISIONS.md — locked decision log

Decisions that are **settled**. Do not re-litigate them in a session; do not "improve" them
in passing. If you believe one is wrong, surface it to Andrew as a question — don't change it.
Each entry: the decision, why, and the date it locked (where known).

Companion files: [BRAIN.md](BRAIN.md) (start here) · [MISTAKES.md](MISTAKES.md) ·
[NEXT.md](NEXT.md). The `.claude/skills/starnet-*` skills are the enforcement layer for
many of these — they win on any wording conflict.

## Product

- **StarNet is for beginners and power users.** It is easier for beginners to use, never
  beginner-limited: sandbox freedom, full power from minute one, and no grind/unlock/usage
  walls. User-work quotas default off; users or deployers may opt into limits. Restricted
  postures enforce their advertised consent/sandbox boundaries. (Locked; see also skills.)
- **FULL POWER MEANS THE WHOLE LOCAL COMPUTER** (2026-08-14, Andrew; supersedes every older
  Full-Access/hard-floor/desktop-lease limitation). Per-agent Full Access and the station-wide
  master bypass are host-minted scopes of one general authority: StarNet must project every
  available capability and must not block host paths (including `.env`/`.git`), arbitrary host
  commands, visible apps, or physical screen/input control. Do not build niche request allowlists;
  the unrestricted host executor is the general route. Schema/input validity, timeouts, output
  caps, checkpoints, truthful telemetry, OS account privileges, elevation prompts, credentials,
  unavailable hardware, and disconnected external services remain real engineering/runtime facts,
  not StarNet permission denials. ASK and narrower execution modes remain restricted as labeled.
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
- **The OS paints NOTHING in StarNet** (2026-07-27, Andrew). The corollaries of the control law
  below, for the other two surfaces the user agent will draw if nobody stops it: **no renderer-native
  dialog** — `window.confirm/alert/prompt` is an OS modal over the phosphor terminal; arm through
  `ArmConfirm` (that helper exists for this) or use a station panel. The sole exception is a
  **host-boundary security confirmation** for a renderer-callable OS launch: the host may show a
  blocking native prompt only when it names the exact canonical target + action, remembers nothing,
  asks on every call, and Cancel cannot fall through to another launch path. Renderer UI cannot mint
  that proof; this exception is never reusable for ordinary product confirmation. **No native tooltip** —
  `frontend/app/tooltip.js` adopts every `[title]` into `[data-tip]`, removes the attribute, and
  draws the station's card; `data-no-tip` opts an element out when it owns a richer tip. Both
  locked by `test/station-tooltip.test.js`.
- **NO white HTML controls, ever** (2026-07-27, Andrew — reported for the third time). A
  control that renders with the browser's own paint (buttonface white, ButtonBorder grey,
  black Arial, OS-blue tick) is a BUG, not a detail. `frontend/css/app.css` carries a
  **CONTROL FLOOR**: element-level rules that repaint every native control from theme vars, so
  forgetting a surface class can no longer ship an OS-chrome control. The floor must STAY a
  floor — element-level selectors only, no geometry on the shared button rule — or it starts
  overriding real skins. Locked by `test/control-floor-theming.test.js`.
- **COMMS beats:** decided cards must `vanish()`; ONE post-run beat at a time; gold-inset
  beat family (no `.reply` for asides).
- **Voice v3: ONE station voice — ULTRON** (2026-07-13, Andrew). Supersedes the v2 character
  set: every agent, every persona speaks the locked Ultron recipe (Algenib@1.0 + machine-shell
  FX, `Personas.STATION_VOICE`). Personality changes the WORDS (promptInjection/ambient lines),
  NEVER the sound — do not add per-persona voice fields back. `/api/tts` synthesizes from any
  credential the station holds, preferring the NATIVE voice API of the provider the user runs
  agents on (body.preferProvider = Harness.getProv()): an OpenAI station speaks via OpenAI, a
  Gemini station via Gemini; default chain OpenRouter → Gemini native → OpenAI nearest-voice.
  Codex (ChatGPT OAuth) and Anthropic have no audio endpoint, so those stations use the default
  chain — and a station with NO TTS-capable credential degrades honestly to the browser voice. Still standing from v2: PACE-WORD LAW (style pace words are a literal drag)
  and the /api/tts 200-always contract.

## Engineering / process

- **`npm start` (:8787), never `npm run serve`** (dead, UI-only path).
- **One process, one runOnce loop, U.bus frozen events** (see starnet-backend-law).
  `shared/events.js` + `shared/schema.js` are owned; changes additive-only, by request.
- **Rebrand:** Skynet → StarNet (2026-06-22) on all SHIPPED surfaces; internal `skynet.*`
  keys/schemas/env vars intentionally kept — do not "finish" the rename.
- **the reference harness branding stripped from shipped surface** (2026-07-04); attribution lives in
  NOTICE.md (MIT — keep it). The `ref-proven` QA enum is kept on purpose.
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
- **Open-source validation boundary:** TPM, fixed-VHDX, anti-admin, LocalSystem proof-broker,
  and protected-CAS machinery were never product requirements; W0 identifies exact official,
  reproducible-source, custom, and dirty-dev builds without trying to defeat the machine owner.
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

## Pine Star decisions

The StarNet entries above are retained as upstream architectural history, not automatically adopted Pine Star product law. The decisions below were established before or during `PS-2026-001`. When an earlier precise date is unknown, **pre-foundation** is used rather than fabricating one. Change these only through a deliberate later decision record.

| Date | Decision | Reason / consequence |
| --- | --- | --- |
| Pre-foundation | Build Pine Star on StarNet instead of continuing the old architecture. | Begin from a functioning multi-agent desktop foundation. |
| Pre-foundation | Preserve old Pine Star work as reference rather than merge it into the fresh baseline. | Avoid importing unknown architecture/regressions. |
| 2026-08-26 | Preserve StarNet architecture initially and transform gradually. | Rewrites require evidence and a Pine Star need. |
| 2026-08-26 | Maintain upstream as a reference/update source; never blindly merge. | Review valuable fixes selectively without surrendering Pine Star control. |
| Pre-foundation | Use the separate `pine-star` branch. | Isolate Pine Star evolution. |
| Pre-foundation | Keep `starnet-baseline-0.10.10` permanently untouched. | Preserve an immutable comparison/recovery point. |
| 2026-08-26 | Separate coordinator system role from visible agent name. | Identity can vary without confusing routing authority. |
| 2026-08-26 | Permit direct conversations with specialist agents. | The coordinator is not a mandatory bottleneck. |
| 2026-08-26 | Route to the lowest capable level and escalate only when needed. | Use specialization and cost tiers efficiently. |
| 2026-08-26 | Permit safe local autonomy within protected boundaries. | Reduce interruption without external commitments or irreversible harm. |
| 2026-08-26 | Default external financial authority to `$0`. | Money actions require explicit user approval. |
| 2026-08-26 | Preserve multi-provider architecture initially. | Avoid lock-in and match cost/capability to work. |
| 2026-08-26 | Do not integrate Hermes initially. | Keep foundation scope controlled. |
| 2026-08-26 | Use private internal memory plus shared Obsidian operational memory. | Separate machine state from human-reviewable history. |
| 2026-08-26 | Make Daily Open-Source Scout a permanent future role. | Create disciplined discovery without auto-installation. |
| 2026-08-26 | Ship only original Pine Star art and branding. | Respect upstream exclusions/copyright and create independent identity. |
| 2026-08-26 | Pursue the GBA-era top-down world after functional foundations stabilize. | Preserve experience direction without destabilizing core systems. |
| 2026-08-26 | Keep code-level self-improvement controlled and reviewable. | Inspect, change, test, review, keep/revert, and log; initial merges stay user-controlled. |
| 2026-08-26 | Track intentional changes with `PS-YYYY-###`. | Connect technical changes to rationale, evidence, and outcomes. |
