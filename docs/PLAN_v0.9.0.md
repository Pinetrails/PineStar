# PLAN — v0.9.0 · LEGIBLE · SOLID · UNBLOCKED

Written 2026-07-31 against trunk `feat/harness-backend` @ `129801b1` (v0.8.0 published, both
platforms). Every claim below was re-grepped against trunk on the day of writing, but the
**doc-trust rule still applies**: this file is a hypothesis within hours. Grep before you build.

## The mandate

Andrew, 2026-07-31, verbatim intent:

1. **Users are still confused.** They ask a lot of questions, which means the product is not
   explaining itself. This update's first job is to make StarNet dramatically easier to
   understand.
2. **Fix as many bugs and issues as we can.**
3. **Build a stealth engine** so the station's own browsing stops being misidentified as a bot,
   comparable to what the reference harness ships.

Three tracks, one release. Track A is the headline; Track B is the volume; Track C is the new
capability.

---

## Ground truth at the time of writing (verified, not quoted from docs)

| Fact | Evidence |
| --- | --- |
| Trunk `129801b1`, version `0.8.0`, ~1,011 commits in the last 7 days | `git log` |
| `npm run test:fast` is **473/473 green, exit 0** at this tree | run live 2026-07-31, log kept |
| Green Guardian says **RED** at the same commit with `test-fast exitCode 1` | `qa/guardian-last-cycle.json` |
| → those two disagree. The Guardian red is most likely the known `loops.e2e` / `voice.button` flake | `qa/STATUS.md:142` |
| The durable bug register says 28 open of 36 — **25 of those 28 are already fixed in trunk source** | merge `0a6a14e1` landed the fixes; the `.md` records were never flipped |
| Genuinely open register bugs: **3** | `4962c3ad` (P0), `e05cdba8` (P1), `f42a5f46` (P1) |
| 10 `agent/*` lanes are ahead of trunk carrying **built and gated** fixes | `git rev-list feat/harness-backend..<branch>` |
| Detector ledger: 4 Guardian P1 · 23 Perfectionist P1 · 246 Janitor P2 | `node scripts/qa/ledger.mjs --status` |
| **There are zero GitHub issues, and no support address, community link, or "report a problem" path** in the app, `README.md`, `INSTALL.md`, or the website | grep — the only external URLs in `frontend/app/*.js` are provider API-key pages |
| **The app links to none of its own documentation.** 11 pages exist at `website/docs/*.html`, ~30–40 lines of prose each, and nothing in the frontend points at them | grep |
| The codebase carries **essentially zero TODO/FIXME debt** — mine `qa/bugs/` and `docs/NEXT.md` for the backlog, not comments | full scan of `sidecar/`, `frontend/` |

**The single most important number here is the one we don't have.** Andrew is seeing user
questions, but the project has no channel that captures them: no issue tracker traffic, no
support inbox in the product, no in-app feedback path. Every "users are confused about X"
statement in this plan is therefore inference from the code and from past audits — not from
users. Track A starts by fixing that, because otherwise the rest of Track A is guesswork.

---

# Track A — LEGIBILITY: make StarNet explain itself

The finding that reframes this whole track: **StarNet already has a good explanation layer, and
it is barely deployed and cannot be re-entered.**

- `frontend/app/glossary.js` holds 32 solid beginner sentences.
- `frontend/app/hint.js` is a correct, delegated, themed, keyboard-accessible tooltip layer.
- Only **29 `data-hint` attributes exist in the entire frontend**, and four of them
  (`effort`, `voice`, `focus`, `deliverable`) point at terms the glossary does not define, so
  they render nothing.
- The guided tour (`frontend/app/tutorial.js`) is genuinely good — and it can only ever run
  once. `firstCommand` is called from exactly one place (`frontend/app/app.js:2977`, the
  awakening's `taught` callback), guards on `state.firstCommandDone`, and has no reset path.
  A refresh or crash mid-tour costs the user the tour, the FIRST STEPS briefing, and any
  re-entry, permanently.

So the work is mostly *deployment and re-entry*, not authoring. That is a much cheaper update
than it looks.

### A0 — Capture the actual questions (do this first, it is one day)

Nothing else in this track should be finalised before real questions are flowing in.

- Add a support/contact route the user can actually find: `README.md`, `INSTALL.md`, the website
  footer, and one in-app door (SYSTEM ▸ FIELD MANUAL is the natural home).
- Add a "report a problem / ask a question" path in-app that attaches the existing diagnostics
  bundle (`frontend/app/diagnostics.js` already assembles one, and already carries
  `androo.agi@gmail.com`).
- Decide where community questions land and make it one place.

**Done means:** a fresh install has a visible way to ask a question, and we have a written
list of the first 20 real questions to steer A1–A7 against.

### A1 — Help you can re-enter (the highest-leverage single fix in this update)

Open since the first backlog as GA-17 (`docs/NEXT.md:1729`); `docs/TUTORIAL_ONBOARDING_PLAN.md:335`
flagged replay as an open decision and recommended yes.

- `Tutorial.firstCommand` becomes replayable from FIELD MANUAL: "▸ SHOW ME AROUND AGAIN".
- FIRST STEPS briefing re-openable on demand, not only when `firstCommandDone` flipped.
- Coachmarks get a "show me this again" reset (they are already persisted per-key at
  `tutorial.js:674-750`).
- An abandoned tour must be resumable, not lost: persist tour progress, offer resume on next boot.

**Done means:** I refresh the browser mid-tour, come back, and can finish or restart the tour
and reach FIRST STEPS — verified live on a seeded station, not just in tests.

### A2 — Say what this is before asking for anything

Today the only framing a first-timer gets before the configuration screen is the splash line
`AI-AGENT HARNESS` (`frontend/index.html:57`). The real explanation — the REAL vs FOR SHOW
contract, "the floor IS the pipeline", "real work runs server-side whether or not you've laid a
belt" — lives in the Field Manual behind a dock menu (`tutorial.js:857-901`).

- One short pre-configuration beat: what StarNet is, what it will do with a key, what runs
  locally. Keep it eerie, keep it honest, keep it skippable-forward but not lost.
- Promote the honesty contract (what is real vs cosmetic) out of tab 4 of the manual.

**Done means:** a first-timer can answer "what is this program" before being asked for a
provider key.

### A3 — The keyless first run — **DECISION NEEDED (Andrew)**

`frontend/app/app.js:2375-2388` makes a live 30-second model round-trip a hard precondition of
the awakening. `docs/FULL_RELEASE_POLISH_PLAN.md:78` states the consequence plainly: *a fresh
install produces zero value before a provider key.* The keyless path exists but is deliberately
thin (`onboarding.js:607-616`: honest holding line, purpose + cadence, an IOU).

This is a genuine product fork, not a knowledge gap, so it goes to Andrew rather than being
decided in a lane. Options, in the order I'd rank them:

1. **A scripted no-LLM demo station** — the station boots, the tour runs, one canned "run"
   shows the loop end to end, clearly labelled as a demo. Cheapest, no money, no lies.
2. **Managed starter credits** — best conversion, but it is the billing rail and it drags the
   subscriptions lane into this release.
3. **Leave it** — accept that the funnel needs a key on day one.

Nothing else in Track A blocks on this; it can land late.

### A4 — Deploy the vocabulary layer that already exists

- Tag every jargon site with `data-hint`: `workstream` (`marketplace.js:354, 646, 2376`),
  `sidecar` (`stationui.js:2470`, `build.js:930, 942`), `orchestrator`, `lane`, `clearance`.
  Target: every first-use of a station noun on a surface a beginner reaches.
- Add the missing glossary terms — `session`, `project`, `agent`, `specialist`, `class`, `crew`,
  `provider`, `key`, `credit`, `intake`, `outbox` — plus the four already-referenced-but-undefined
  ones (`effort`, `voice`, `focus`, `deliverable`).
- Settle the naming collisions rather than papering them: **eight peer nouns** now sit in the
  work/build docks (TASKS · DELIVERABLES · RECIPES · ROUTINES · LOOPS · QUESTS · SKILLS ·
  ABILITIES), and `LOOPS` was added *after* the vocabulary audit counted seven. Residual
  collision at `stationui.js:1479` still says "skill recipes" while `:2403` deliberately says
  "procedures".
- **One object, four words:** the rail says SESSIONS, the glossary says *workstream*, the slash
  catalog and COMMS system lines say *workstream*, recruitment copy says *workstream* untagged.
  Pick the user-facing word and use it everywhere the user can see.
- Add the missing cross-links the 2026-07-15 audit asked for: RECIPES' MAKE ROUTINE ↔ ROUTINES.

**Done means:** hovering any station noun on any beginner-reachable surface explains it, and no
two panels call the same object different things.

### A5 — Delete the lessons that teach a false model

This one is a truthfulness bug wearing a UX costume. Connectors are **account-level**:
`sidecar/capability/office.js:38` rides every configured connector onto both surfaces regardless
of what is placed on the floor. The agent's own manual was corrected
(`sidecar/manual.js:61-64`), but the game still teaches the opposite:

- `frontend/app/quests.js:121` — *"Bind a live tool portal — place a connector portal in REFIT…"*
- `frontend/app/tutorial.js:761` — FIRST STEPS item *"Bind a connector portal"*
- `frontend/app/windows/connectors.js:374` — names the missing prop and offers **no button**;
  `docs/CONNECTOR_UX_PLAN.md:219` calls fixing this *the single highest ratio of user-unblocked
  to lines-changed in the document*.

Fix the three, then walk the connect path live end to end.

### A6 — An actual answer surface

- The Field Manual becomes searchable, and gains the entries that answer the questions A0
  collects.
- **Link the docs that already exist.** Eleven pages sit at `website/docs/*.html` and the app
  points at none of them. Every panel that has a matching page gets a "▸ read more" door.
- Those pages are thin — expand `getting-started`, `station`, and `troubleshooting` in the same
  lane, and mirror the vocabulary decisions from A4 so the docs and the app agree.
- Keyboard cheat-sheet overlay (GA-17's second half).
- Prop hover tooltips: name + what it actually grants (GB-6, `docs/NEXT.md:1758`). Belts already
  carry tags (`world.js:4080`); props are silent.

### A7 — Measure comprehension, not stalls

`loops/beginner-run.md` asks the beginner loop to record *"every hesitation >10s, every
misleading label"* — but the runner is `ui-only` and reports only `stalledStep`, and just 3 of
382 findings in the corpus come from it. **There is no artifact anywhere in `qa/` that records
"I did not understand X."** Extend the loop to file comprehension findings, and make an
unexplained surface a real finding class.

---

# Track B — SOLIDITY: fix as many real bugs as we can

The good news is that a large fraction of this track is already built and merely unlanded.
Do the cheap, high-certainty work first.

### B0 — Get the gate honest (blocks everything)

Trunk's fast gate passed 473/473 for me at `129801b1` while the Guardian recorded
`test-fast exitCode 1` at the same commit. Either something in the six `qa(claims)`/`docs(release)`
commits turns it red, or it is the known flake (`loops.e2e` ~2 fails in 12 runs, plus a
`voice.button` timing flake). **Reproduce it before planning on top of it**, then kill the flake
— a gate that lies costs more than the bug it hides. Law already on the books: read the log,
never the exit code.

### B1 — Land what is already built and gated, in this order

| Order | Lane | What it fixes | Severity |
| --- | --- | --- | --- |
| 1 | `agent/quality-loop-0730f` | **E-STOP does not survive a page reload** — a refresh silently clears `cronHalted`/`nightshiftHalted` and re-arms cron with no human resume gesture | P0, worst live defect found |
| 2 | `agent/quality-loop-0731` | Halted routines still count down "next in 12m" for work that will never fire (register `4962c3ad`) | P0 |
| 3 | `agent/quality-loop-0731c` | A 403/stale-token on `/api/projects` renders "NO TRUSTED PROJECTS" and wipes entered project scope (`e05cdba8`) | P1 |
| 4 | `agent/quality-loop-0731d` | One locked legacy file aborts the desktop workspace migration while `.migrated` is still stamped — permanent silent data loss (`f42a5f46`). ⚠ installed-exe cold start not yet exercised | P1 |
| 5 | `agent/voice-bundle-models` | Installed builds cannot run Local Live at all (the bundle ships no `node_modules`). 1059 MB → 482 MB staged closure. Its own lane; release-shaped | P1 |
| 6 | `0730b`, `0730c`, `0730e`, `0731b`, `0730` | Local Live engine copy truth, provider-card a11y, attachment transcript lock, unattended shell-key boundary, Update Center version/notes | P2 |

Merge ritual per lane; gate green before each; two sessions never merge at once.

### B2 — Reconcile the register (half a day, prevents weeks of waste)

25 of the 28 `status: open` records in `qa/bugs/` were fixed by merge `0a6a14e1` (and
`598ab4a4`) and never flipped. Run
`node scripts/qa/bugs.mjs --set <fp> --status fixed --fix 0a6a14e1` for each, regenerate
`qa/BUGS.md`. Left alone, the next planning pass re-does three weeks of work.

⛔ Remember `status: open` is **per-branch** — check `git log --all -- <path>` before trusting
any single record, in either direction.

### B3 — The named user-visible bugs with no owner

1. **Delegated work is invisible in its target session.** Andrew's live repro with screenshots:
   the worker completed a real report, the deliverable landed in the lead's session, and the
   session he named showed nothing. Root cause is written up in
   `docs/HANDOFF_SESSION_DELIVERY_BUG.md`: the visible fold is a one-shot 6-second bridge window
   with **no backfill**, while the durable transcript is correct the whole time.
   `frontend/app/autosessions.js` already does exactly this healing for `cron-*` streams —
   dispatch-targeted sessions have no equivalent. The fix is designed, reviewed, and unclaimed.
2. **Settings split-brain** — the station save carries two disagreeing values for the same
   setting (`doc.prov:"codex"` vs `agent.provider:"openrouter"`; reasoning effort likewise), and
   resume only fills a *missing* value, so it never reconciles. Which one wins depends on the
   read path. `qa/STATUS.md:1655` calls it "still true and still unfixed, worth its own lane."
3. **Prompt-cache trailing anchor is mechanically fragile** — the breakpoint walks back only 20
   content blocks, and a single parallel-tool turn can exceed that, silently re-billing the whole
   conversation as a cold write. This is a money bug and it shipped in v0.8.0.

### B4 — The stranded-user set and connector reliability

`docs/NEXT.md:1525` items 8–13 are still open, all frontend-owned: no undo for out-of-jail
artifacts, full-agent backup unreachable in-app, a dead MCP connector invisible outside its own
panel, a dead channel likewise, custom/Ollama base URL uneditable after onboarding, connector
OAuth locked for five uncancelable minutes. The law is already written: *shippable = zero
stranded.*

Connector reliability pairs with A5 — `sidecar/mcp/oauth.js` contains **zero** `AbortSignal` or
timeout, which is why sign-in can wedge forever, and `sidecar/mcp/transport.http.js` still passes
`fetch failed` straight through to the user.

### B5 — The two defect classes worth mechanizing

Derived from mining every reported-bug lane: of the six recurring classes, only two are static
census work that has never been run, and both keep producing user-visible bugs.

- **A stamped field with no reader, or a reader that means something else.** Enumerate
  producers → consumers for every persisted field. (Live example: `/api/nightshift/status.awaySince`
  is stamped as a *future* instant while `frontend/app/nightreport.js:93` documents it as the
  moment the window opened.)
- **A classifier that drops a class added later.** Feed every regex/allowlist that classifies
  user-supplied identifiers one instance of each class that exists *today*. (This class alone
  produced the connector search indexing 0 of 48 platforms, the recipe tab's 42→3 collapse, the
  FOR-YOU shelf emptying on a negative term, and the permissions regex dropping every `path:` grant.)

The other classes need a human or an agent walking a live failure state — which is what the
beginner loop upgrade in A7 is for.

### B6 — The Guardian's four P1s

Two journey parity regressions (`crew/working-covers-busy`, `shownWorking=0 >= busy-on-roster=1`),
one boot journey failure ("floor never came up"), and `log/frozen-bus` "-1 events captured", open
and unattributed since 2026-07-27. These are what keep the Guardian red; they must be triaged
before any `qa:ready` claim.

### B7 — Installed-build truths

- **macOS notarization re-proof.** The resumable workflow is implemented and on trunk; Apple never
  returned an invalid verdict, but three runners lost their network route while polling and a
  fourth hit GitHub's six-hour ceiling. Until it is exercised end to end, mac support is not
  proven. Parity is a publish gate.
- Andrew still owes a **ChatGPT session rotation** — a credential sat readable in unencrypted
  `%TEMP%`; purging copies cannot un-expose it.
- Version lives in **four** files (`package-lock.json` twice) and `release-cut.mjs` bumps none of
  them. Worth fixing inside this release rather than re-learning it at the cut.

---

# Track C — REACH: stop looking like a robot

## Scope, stated before the design

**In scope:** not volunteering that we are automation. A real user-agent string with matching
client hints, no automation-controlled fingerprint, no CDP leak, human-plausible input timing,
per-site politeness and backoff, and honest detection of the walls we do hit.

**Out of scope, permanently:** solving or bypassing CAPTCHAs and human-verification challenges,
forging consent, distributed or mass-scale scraping infrastructure, credential-stuffing helpers,
or anything built to defeat a site's authentication. When a site genuinely demands "prove you are
human", the answer stays what it is today — hand it to the Commander via `browser.attach` /
`browser.login`. The station browses **on behalf of a present user, at human scale**; the whole
point is that this is a true statement about StarNet, and the stealth layer must not make it
false.

## The policy reversal has to be written down

The codebase currently argues the *opposite* position in two comment blocks and a QA digest:
`sidecar/tools/builtin/browser.js:1792-1799` ("WHY THIS AND NOT A STEALTH ENGINE"), `:2354-2356`
("They are NOT a stealth feature: the station's answer to bot walls is `browser.attach`, never
spoofing"), and the ATTACH entry in `qa/STATUS.md`. Andrew's order supersedes those, but they must
be rewritten in the same lane or the codebase contradicts itself and the next agent re-litigates it.
The honest new framing: attach remains the answer for *authenticated* walls; the stealth layer is
for the ordinary case where a site refuses a browser purely for looking automated.

## What we start from (verified 2026-07-31)

The driver is a hand-rolled CDP client over a WebSocket in
`sidecar/tools/builtin/browser.js` — **no Playwright, no Puppeteer, no npm dependency at all**
(`package.json` has two runtime deps, neither related). It borrows Playwright's cached Chromium
*as a binary* when present, otherwise installed Chrome.

- **Complete launch-arg list** (`browser.js:573-582`): `--disable-gpu --no-first-run
  --no-default-browser-check --remote-debugging-port=<ephemeral> --window-size=1440,900
  --user-data-dir=<profile>`, plus headless `--headless=new --hide-scrollbars --mute-audio`.
- **The only existing evasion in the repo** is negative: never pass `--remote-debugging-port=0`,
  because Chromium then calls `EnableAutomationControlled(true)` and sets `navigator.webdriver`
  (`browser.js:266-292`). Nothing else is touched.
- `Runtime.enable` **is** sent (`browser.js:741`) — the classic CDP detection leak is wide open.
- **No user-agent override at launch**, so `--headless=new` ships `HeadlessChrome/…` in the UA.
  Very likely our single largest tell.
- No `Accept-Language`, no `Sec-CH-UA` metadata, no `Network.setExtraHTTPHeaders` anywhere.
- **Input is instant and inhumanly regular**: click dispatches press+release at the same pixel
  with no preceding `mouseMoved` (`:1045`); type sends the whole string as one `Input.insertText`
  so page keypress listeners see a paste (`:1054`); scroll is a `window.scrollBy` JS call so no
  wheel events reach the page at all (`:1381`); drag is exactly 6 uniform linear steps (`:1085`).
- **We add our own tells**: `__STARNET_SETTLE__` and `__STARNET_SYNTHETIC_INPUT__` are installed as
  non-configurable globals with ~20 frozen prototype patches (`:67-208`) — trivially enumerable by
  any page — and `navigate()` deliberately fails closed if the shim did not install (`:936-941`),
  so they cannot simply be deleted.
- The keyless HTTP path (`sidecar/tools/builtin/web.js:37`) sends a frozen Chrome-124 UA with three
  headers, no `Sec-Fetch-*`, no `Referer`, and there is **no rate limiter or backoff anywhere**.
- Challenge detection exists **only** in `sidecar/tools/builtin/webreader.js:45-62` and is never
  applied to the agent-driven browser: an agent that navigates into a Cloudflare interstitial gets
  HTTP 200 and "Just a moment…" as page text.

## Two constraints that decide the architecture

1. **Zero runtime dependencies, and the desktop bundle ships no `node_modules`.** Camoufox (a
   ~300MB Firefox fork, and unmaintained for roughly a year) and playwright-stealth are therefore
   not options for the shipped app. Everything must be CDP-level and dependency-free — which,
   given we already own a raw CDP client, is a genuine advantage rather than a limitation.
2. **The determinism law bans ambient clock and RNG in backend logic**
   (`browser.js:860, 1463, 2024`; enforced by `lint-determinism` in the gate). Human pacing must
   draw from `shared/clock-rng.js` (`makeRng`, mulberry32, seeded) so replay stays byte-identical.

## Slices

- **C1 — Launch-profile parity.** Add `--disable-blink-features=AutomationControlled`; override the
  UA at launch to strip `HeadlessChrome`; supply matching `userAgentMetadata` so UA-CH does not
  desync (today `setUserAgentOverride` is called without it, `:1178`); set `Accept-Language`, locale
  and timezone from the host rather than leaving them empty. Refresh the three device presets
  (`:2357-2361`) — an iPhone 17.5 / Chrome 126 preset on a current Chromium is itself a mismatch.
- **C2 — CDP leak reduction.** Avoid or defer `Runtime.enable`; move our evaluation into an
  isolated world so the page cannot observe the console/debugger side effects.
- **C3 — Shim minimisation.** Keep the fail-closed guarantee, but make the `__STARNET_*` globals
  non-enumerable and per-run named, and narrow the frozen prototype patch set to what the
  pointer-lock incident actually requires.
- **C4 — Human input model** (seeded RNG only): a mouse path to the target before the press, a
  press duration, per-character typing with realistic inter-key intervals, real
  `Input.dispatchMouseEvent{type:'mouseWheel'}` scrolling, non-linear drags.
- **C5 — Politeness.** A per-host token bucket plus backoff on 429/403 with jitter, in `web.js`.
  This is both an anti-detection measure and the right thing to do.
- **C6 — Challenge honesty everywhere.** Port the `webreader.js` challenge detector into
  `browser.navigate` / `get_text`, so a challenge page is a distinct, actionable result and never
  silently returned as page text. **This is a truthful-telemetry fix, not a stealth feature**, and
  it is the slice I would build first — it is what makes the rest debuggable.
- **C7 — The escalation ladder**, written into the tool doctrine: station browser → politeness
  retry → attach to the Commander's own Chrome (already built, already consented) → tell the user
  plainly. A wall we cannot pass honestly is an answer, not an error.
- **C8 — Proof.** Extend `test/browser.gauntlet.e2e.test.js` — it already drives **real Chromium**
  and already runs in `test:http` — with fixture routes that echo request headers and report
  `navigator.webdriver`, the UA, and `Object.getOwnPropertyNames(window)`, plus a challenge-page
  fixture. Add the launch-arg assertions to `test/browser.test.js:294-359`, which is already the
  fingerprint block.

**Done means:** on a real site that blocks us today, the station reaches the content; and on a
site that legitimately demands human verification, the agent says so plainly and offers attach.
Both observed live, not inferred from unit tests.

---

## Sequencing

- **Wave 1 (unblock).** B0 gate honesty → B1 merge queue → B2 register reconciliation → A0 capture
  the questions. Nothing here is speculative; most of it is already built.
- **Wave 2 (the headline).** A1 re-entry → A2 what-is-this → A5 false lessons → A4 vocabulary
  deployment, in parallel with C6 → C1 → C2 on the browsing side, and B3's session-delivery
  backfill.
- **Wave 3 (depth).** A6 answer surface + docs, A7 comprehension findings, C3–C5, B4 stranded set
  and connector reliability, B5 census sweeps.
- **Wave 4 (cut).** B6 Guardian triage, B7 installed-build truths, A3 if Andrew has decided it,
  then the release ritual.

One lane per worktree, `agent/<name>`, gate green before every merge, claims re-lock as its own
commit after the code commit.

## The shipping bar for v0.9.0

1. A first-time user can learn what StarNet is, take the tour, **lose it, and get it back**.
2. Every station noun a beginner meets explains itself on hover, and no two panels name the same
   object differently.
3. No shipped surface teaches a model the harness contradicts (the connector-portal lesson is the
   live example).
4. `qa/bugs/` tells the truth, the fast gate is honest and green, and the three genuinely open
   register bugs plus the E-STOP-on-reload defect are closed.
5. A delegated run into a named session is visible in that session, or the session heals itself
   from the durable record.
6. The station browser reaches at least one real site that refuses it today, and reports a genuine
   human-verification wall honestly instead of returning challenge text as content.
7. Both platforms build; macOS notarization has been exercised end to end.

## Decisions only Andrew can make

1. **A3 — the keyless first run.** Scripted no-LLM demo, managed starter credits, or leave it?
   My recommendation: the demo station, and keep credits with the subscriptions lane.
2. **Track C's public framing.** The stealth layer changes what we say about the product. I would
   describe it as "the station browses like a person, because a person asked it to" — and keep the
   CAPTCHA line explicit in the docs, because it is a real limit, not a temporary one.
3. **The eight-noun taxonomy.** A4 can tag and cross-link everything, but collapsing SKILLS and
   ABILITIES into one panel — which two audits have now asked for — is a product decision.
