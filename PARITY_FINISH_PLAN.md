# StarNet → Hermes-parity FINISH Loop (G1 computer/browser · G2 MCP stdio · G4 cron · G5 fs patch · G6 spend)

> The durable brain for the self-paced parity-finish + reliability loop. Source: the 2026-06-23
> StarNet-vs-Hermes audit (verified file:line recon + adversarial critique). Scope = the five
> ON-MOAT gaps where Hermes excels and StarNet lacks or lies: **G1** computer/browser use,
> **G2** MCP stdio transport, **G4** cron 100%-reliability, **G5** fs multi-hunk patch, **G6**
> spend/model honesty. **Discord / gap #3 is INTENTIONALLY EXCLUDED — held off by the user; do
> not touch channels.** Defining theme: most of this is PORT-WITH-PROOF — copy Hermes' exact
> grounding/atomicity/lock invariants, but make every "it works" claim a TEST or a LIVE CHECK,
> never a single anecdotal pass. A single success is an existence proof, not reliability.

## Operating protocol (obeyed every iteration)

1. **Work in the worktree, never the integration tree.** ALL editing/committing happens in
   `C:\Users\andro\gen-trees\parity-finish` on branch `agent/parity-finish` (already created via
   `gen-trees\new-agent-tree.ps1 parity-finish`). The integration tree (trunk
   `feat/harness-backend`) is touched ONLY to merge. Never edit
   another agent's worktree or `agent/*` branch.
2. **Green before merge.** `npm run test:fast` must pass FULLY in the worktree before any merge
   (CLAUDE.md rule 5). For shell/route/channel-touching items (G2 stdio spawn, any new
   `/api/*` route, the cron toggle route) ALSO run `npm run test:http`.
3. **Watched before DONE.** Any loop/UI/tool-affecting item gets a live `npm start` check on a
   FREE port (don't collide with :8787 if it's in use) — boot clean, exercise the surface, read
   the result back. Capture the transcript. A headless test alone does NOT satisfy a
   tool/loop/UI item (StarNet's recurring "fake-done / app-lies" failure mode).
4. **One revertable commit per item** (a tight series is ok). Conventional commits, each ending
   with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Commit only YOUR files with
   explicit pathspecs — NEVER `git add -A` / `git add .`.
5. **Polish gate before advancing** — self-review the diff, fix real findings, re-gate.
6. **Shared contract additive-only.** `shared/events.js` and `shared/schema.js` are
   MEMORY-CORTEX-owned (live worktree `C:\Users\andro\gen-trees\memory-cortex`, branch
   `agent/memory-cortex`). New events/enum-widenings/fields are ADDITIVE only and must be
   **REQUESTED** from that owner with the exact name + payload shape, merged to trunk FIRST,
   then synced and consumed — NEVER self-edited, renamed, or removed. `git log
   feat/harness-backend..agent/parity-finish -- shared/events.js shared/schema.js` MUST stay
   empty. **Batch ALL additive requests (G1 + G4 + G6) into ONE round-trip** to the owner.
7. **`loop.replay` byte-identical.** Any `loop.js` change (none expected in this lane, but if
   touched) must keep `loop.replay` byte-identical — assert it.
8. **Sync before merge** (`gen-trees\sync-agent-tree.ps1 parity-finish`) so conflicts surface in
   YOUR worktree, not on trunk. Rebase in the SAME session as the merge (high cadence: 5+
   merges/hour from hermes-parity/crew-sentience/state-integrity at peak).
9. **Board-check the hot files before editing.** From the integration tree run
   `node scripts/board.mjs --files <path>` before editing AND again immediately before merge.
   MANDATORY for the revival-risk files: `sidecar/index.js`, `sidecar/capability/registry.js`,
   `sidecar/runstore.js`, `sidecar/insights.js` (all `agent/hermes-parity`, touched 3–4h ago);
   the live frontend lanes **`agent/workforce-zones` in `frontend/app/world.js`** and
   **`agent/onboarding-remaster` in `frontend/app/app.js`/`voice.js`** (also
   `agent/crew-sentience` in world.js, `agent/state-integrity` in app.js). PREFER NOT to touch
   `world.js` at all — it is the most-contended frontend file.
10. **No infinite walls.** After a REAL fix attempt fails the gate, set the item BLOCKED with
    the concrete reason and move to the next INDEPENDENT item, surfacing it loudly. Never
    fake-green; never weaken a test to pass; never hand-pick a cooperative page/window and call
    a reliability item done.

> **Red-before-green (applies to EVERY new test in this lane):** each new acceptance test must
> be shown to FAIL on the pre-fix tree and PASS after — capture both states in the Progress Log.
> A test that passes against both old and new code is vacuous and does not count toward DONE.

> **Attended verification gates.** A few acceptance criteria require a live display the autonomous
> loop cannot honestly drive: **G1.1 RELIABILITY** (≥9/10 live browser runs) and **G1.2
> REAL-ACTION PROOF + BACKGROUND CO-WORK** (live desktop action, real-cursor-unchanged). For these:
> build the feature and prove EVERY headless criterion green, then mark the live-only criterion
> `ATTENDED` (NOT BLOCKED-failed, NOT DONE) with a one-line repro for Andrew to run. An `ATTENDED`
> criterion never counts toward DONE and is never fake-greened — the goal is DONE only once Andrew
> confirms the live check. The loop continues to the next item rather than walling.

## Per-iteration algorithm
1. Read this file. Pick the first item not DONE / not BLOCKED, in the **autonomy-first order
   G4 → G2 → G5 → G6 → G1** (in listed sub-item order). Rationale: G4/G2/G5/G6 are fully verifiable
   headlessly (injected clock / injected spawn / a Playwright page stub / fold tests) plus a local
   `npm start` smoke, so the loop can drive them to perfect standard UNATTENDED; **G1 is sequenced
   LAST** because its perfect-standard bar includes live-display reliability (≥9/10 live browser
   runs; real desktop action with cursor-unchanged) that an autonomous loop cannot self-certify —
   see **Attended verification gates** above. The loop still BUILDS G1 and proves every headless
   criterion; only its live-reliability criteria wait for Andrew. (G4 also leads because cron is
   the user's most-crucial goal and is 100% deterministically testable.)
2. Advance ONE coherent step: TODO → write tests-first (red-before-green) → implement + gate →
   POLISH self-review → VERIFY live + merge.
3. Update the item's STATUS + Notes; append a dated Progress Log line.
4. Goal complete → run a phase polish pass (full gate + live smoke of that goal's surfaces) →
   advance.
5. All goals DONE → write `LOOP COMPLETE` to the Progress Log and STOP (do not reschedule).

> **Baseline:** worktree `agent/parity-finish` cut from trunk `feat/harness-backend` @ `b452465`;
> `npm run test:fast` confirmed **GREEN** in the fresh worktree (2026-06-23, all ~80 suites + the
> emit/determinism lints, zero failures) before the first edit. This is the red-before-green
> reference tree.

---

## GOAL G1 — Computer use + browser automation (two surfaces)  ·  STATUS: TODO
> PARITY TARGET: Hermes ships TWO surfaces (desktop `computer_use` + `browser`); StarNet has
> NEITHER (no such builtin under `sidecar/tools/builtin/` — only fs/image/notebook/orchestration/
> recall/shell/skills/spotify/todo/verify/web). **RECONCILED DESIGN (the two recon reports
> contradicted each other — this is the single source of truth):** file names = `browser.js` +
> `computer.js` (NOT `computer_use.js`); adopt report-1's tool/grounding port (the detailed
> Hermes parity) with report-2's capability framing — a NEW capability key **`remote`** gated
> `execute + consent`, mirroring `shell.js` so it inherits the autonomous EXEC LOCKOUT at
> `permissions.js:92` for free. **Build `browser.js` FIRST** (native Node / Playwright, low
> risk), then `computer.js`. The frontend capability-OBJECT surfacing (`world.js`/`worldmodel.js`
> `remote_rig`) is **DEFERRED to a separate follow-on lane** — do NOT touch `world.js` here; the
> tool must be reachable via registry + capgate WITHOUT any world-object.

### G1.1 — `browser.js` builtin (Playwright, ariaSnapshot + @ref grounding)  ·  STATUS: TODO
One-line task: add a `browser` builtin wrapping Playwright-for-Node (bundled Chromium), action
family `{navigate, snapshot, click, type, scroll, back, press, console, dialog, get_text,
vision}` matching Hermes `browser_tool.py:2418-3200`; grounding via a per-session text aria
snapshot with stable `@e1..` refs rebuilt on every snapshot.
- **Acceptance (PERFECT STANDARD):**
  - SURFACE (headless, `test/browser.test.js`, Playwright page stub): each action exists and
    behaves — `navigate` settles before returning; `snapshot` returns aria text + `@e1..` refs;
    `click(ref)`; `type(ref,text)` does clear-then-fill (`locator.fill('')` then `fill(text)`);
    `scroll`; `back`; `press`; `console`; `dialog`; `get_text`. Asserted action-by-action.
  - GROUNDING + STALE (headless): a `@ref` used AFTER a newer snapshot returns an EXPLICIT stale
    error and never silently re-resolves to a different element (Hermes `element_token`
    invariant, `backend.py:27-33`). Per-session ref→Locator map keyed by `agent+task` id (no
    global map → no cross-agent ref bleed across StarNet's 7–10 agents).
  - SETTLE (headless, fake timers): `navigate` waits for DOM + network settle (networkidle OR a
    quiet-timer, hard-capped ~5s) before returning the first snapshot; at least one LIVE run
    exercises a LAZY/async-rendered element to prove the settle-wait actually waits.
  - SAFETY (headless): `navigate` blocks SSRF/private+IMDS on the URL AND on every redirect hop,
    and blocks secret-in-URL — REUSE `web.js`'s existing guards (parity
    `browser_tool.py:2429-2563`). Asserted with malicious URLs + a redirect chain.
  - DIALOG (live or integration): a page firing `window.confirm` surfaces a PENDING dialog inside
    the next `snapshot` output and is answerable via the `dialog` action (native Playwright
    `page.on('dialog')`, parity `browser_supervisor.py` + `browser_dialog`).
  - LAZY-INSTALL DEGRADATION (headless): with Chromium NOT installed, the app still BOOTS and
    `npm run test:fast` passes — the tool registers but reports a graceful "browser engine not
    installed" tool-absent state (mirror Hermes' one-time `install` step; keep the ~150MB
    Chromium out of the base download).
  - RELIABILITY (LIVE, captured transcript — NOT a single pass): a FIXED multi-step task
    (navigate → snapshot → click ref → type → submit via press → read result from next snapshot)
    succeeds **≥9/10 consecutive runs** on real bundled Chromium with ZERO manual coordinate
    fallback (ref grounding only). The transcript artifact is saved and referenced. A stub-only
    PR is rejected; the live run must be proven by a non-mockable signal (real navigation
    timing).
- **Files:** `sidecar/tools/builtin/browser.js` (NEW, low collision — follow `web.js` UMD +
  `makeXTools(deps)` factory, reuse its SSRF/secret guards); `sidecar/tools/registry.js` (edit,
  med — additive `register()` only, no dispatch reshape); `sidecar/capability/registry.js`
  (edit, HIGH — `agent/hermes-parity` H4.2 territory, board-check + rebase same-session; add the
  `remote` cap row additively); `package.json` (edit, HIGH — add `playwright` dep + append ONE
  test invocation to the single-line `test:fast` string; see coordination); `test/browser.test.js`
  (NEW, low).
- **Notes:** Build before G1.2. `requiresConsent:true`. Events `browser.navigate` /
  `browser.action` / `browser.dialog` / `browser.blocked` are ADDITIVE — request from
  memory-cortex in the ONE batch, land in trunk first, then emit (emitting before the validator
  knows them fails). Do NOT emit any event until it's in trunk.

### G1.2 — `computer.js` builtin (desktop OS control, Windows-first)  ·  STATUS: TODO
One-line task: add a single action-discriminated `computer` builtin matching Hermes' exact enum
`{capture, click, double_click, right_click, middle_click, drag, scroll, type, key, set_value,
wait, list_apps, focus_app}` with modes `som|vision|ax`, element-index-first grounding,
`capture_after` verification, `max_elements` cap. Transport: cua-driver-over-MCP first (inherit
Hermes' SOM/AX/element_token grounding on the stable Win32 path) with a nut.js coordinate-only
fallback so the tool degrades instead of failing to load.
- **Acceptance (PERFECT STANDARD):**
  - SCHEMA PARITY (headless, `test/computer.test.js`): the action enum is EXACTLY Hermes'
    (`schema.py:34-48`) with modes `som|vision|ax` and an element-index-first grounding param —
    asserted field-by-field.
  - SAFETY (headless): hard-blocks destructive key combos (win+L, cmd+shift+backspace, force-quit/
    logout, etc.) and blocked type patterns (`curl|bash`, `sudo rm -rf`, fork bomb) REGARDLESS of
    approval (parity `tool.py:90-132`). Asserted that approval does NOT override the blocklist. A
    partial port that drops the blocklist is WORSE than no tool — BLOCKED, not shipped.
  - CONSENT WIRING (headless, via registry dispatch): every MUTATING action (click/double_click/
    right_click/middle_click/drag/scroll/type/key/set_value/focus_app) is DENIED when consent is
    absent and proceeds on approve_once/approve_session; `capture`/`wait`/`list_apps` are free
    (parity `tool.py:80-86,291-316`).
  - EXEC LOCKOUT (headless — the critical security test): an AUTONOMOUS run CANNOT drive
    `computer.js` (or `browser.js`) without explicit consent — the `remote` cap inherits the
    `permissions.js:92` autonomous deny. Asserted by an exec-lockout test that DRIVES the gate,
    not a code read.
  - CAPTURE/VERIFY (headless): `capture_after=true` returns a verification re-capture on success
    and is SKIPPED on failure (so a clean screenshot can't fool the model, parity
    `tool.py:836-871`); `max_elements` cap truncates dense captures with `total/truncated`
    surfaced.
  - REAL-ACTION PROOF (LIVE, Windows, captured): `focus_app`/`list_apps` opens a real app;
    `capture(mode='som')` returns numbered elements over a REAL window; click-by-element-index
    lands on the right control across **3 runs on ≥2 distinct controls**, each verified by a
    `capture_after` diff showing a REAL AX/pixel state change attributable to the action (a no-op
    backend that returns ok without injecting input does NOT pass).
  - BACKGROUND CO-WORK (LIVE, positive assertion): the user's REAL cursor X/Y is read BEFORE and
    AFTER a click and asserted UNCHANGED, and focus is not stolen (parity `schema.py:19-21,191-198`).
    Not-testing cursor position does NOT satisfy this — it must be a positive before===after
    assertion.
- **Files:** `sidecar/tools/builtin/computer.js` (NEW, low); `sidecar/tools/registry.js` (edit,
  med — additive); `sidecar/capability/registry.js` (edit, HIGH — `remote` cap reused from G1.1);
  `sidecar/permissions.js` (edit, HIGH — exec-spine-owned/security-critical; new scope ADDITIVE
  and must honor the autonomous exec-lockout; coordinate with exec-spine rather than changing
  semantics); `package.json` (edit, HIGH — optional `@nut-tree-fork/nut-js` dep + one test
  append); `test/computer.test.js` (NEW, low).
- **Notes:** cua-driver is a third-party Rust binary (per-OS install; macOS SkyLight SPIs break
  on OS updates). Prefer the stable Windows Win32 path; treat cua-driver as optional/auto-installed
  with a nut.js coordinate fallback. Events `computer.capture` / `computer.action` /
  `computer.blocked` ADDITIVE — same batched request. Riskiest surface → consent-default, hard
  blocklist non-negotiable.

---

## GOAL G2 — MCP stdio transport  ·  STATUS: TODO
> Today the StarNet MCP client is HTTP-only (`makeTransport: makeHttpTransport`,
> `index.js:647-650`/`:58`). The seam is `makeTransport` in `manager.js:56-64`; the contract is
> `client.js:19-22` — `send(message)->Promise`, optional `onMessage(cb)`, optional `close()`.
> A new `makeStdioTransport` only needs that 3-method duplex shape; `client.js`, `translate.js`,
> and the manager projection are reused VERBATIM. Framing = newline-delimited JSON-RPC (one
> message per line, NOT LSP Content-Length). A stdio server runs an ARBITRARY local command, so
> it needs MORE than the HTTP URL guard: a spawn-time command allowlist + the existing
> per-connector consent/enable gate.

### G2.1 — `transport.stdio.js` (newline-framed JSON-RPC over a child process)  ·  STATUS: TODO
One-line task: add `sidecar/mcp/transport.stdio.js` exporting `makeStdioTransport(deps)` with
the same `{send, onMessage, close}` duplex shape, spawn injected for testability; reuse
`client.js`/`translate.js` unchanged.
- **Acceptance (PERFECT STANDARD):**
  - STUB ECHO over REAL stdio (`test/mcp.stdio.test.js`): a real inline Node child speaking
    newline-delimited JSON-RPC, driven through `makeMcpClient` + `makeStdioTransport`, asserts
    `initialize()` returns serverInfo AND a `notifications/initialized` line was written;
    `listTools()` paginates across 2 pages via `nextCursor`; `callTool()` returns content and an
    `isError:true` result THROWS through `translate.js` `run()` (`translate.js:99-101`). At least
    ONE test spawns a REAL `child_process` (not just a fake duplex stream).
  - FRAMING: one stdout chunk with TWO concatenated JSON lines → two delivered messages; a
    message split ACROSS two chunks is buffered and delivered once whole; a non-JSON log line on
    stdout is SKIPPED without crashing routing (parity `parseSse` tolerance,
    `transport.http.js:51`); stderr never reaches `onMsg`.
  - LIFECYCLE/KILL/CRASH: (a) ENOENT command → `send()` rejects promptly via `failTo`, transport
    closed, no hang; (b) child crashes mid-request → that pending promise rejects with an
    'exited' error, NOT a timeout; (c) `close()`/E-STOP tree-kills (assert `child.kill` +
    `taskkill /T` on win / SIGKILL-the-group on posix) and is idempotent; (d) the client request
    timeout (`client.js:93-95`) still fires if the child accepts the line but never replies.
  - WINDOWS .cmd (the single biggest portability trap): `npx`/`uvx` are `.cmd` shims — a test
    asserts `npx.cmd` is resolved and spawned with `shell:false` and UN-MANGLED argv (NOT
    `shell:true`, which would weaken the allowlist by turning args into a shell string).
  - ALLOWLIST GATE (incl. flag-injection): a command NOT on the allowlist NEVER spawns (assert
    the injected fake spawn was not called) and every `send` fails 'not permitted'; the npx
    package spec is validated with an npx-AWARE parser — `command='npx'
    args=['--package','evil','@modelcontextprotocol/server-x']` is REJECTED with NO spawn
    (rejecting `--package`/`-p`/`--registry`/URL/tarball/git specs; default-deny unknown flags),
    while `npx @modelcontextprotocol/server-*` passes.
  - SAME DISPATCH BOUNDARY: a stdio connector's tools, projected via
    `manager.toolDefsForObjects` and dispatched through the REAL registry, are capability-gated
    (`mcp:<conn>`), consent-gated for mutating tools, and `network:true` — byte-identical
    projection to an HTTP connector.
  - ENV REDACTION (defense against silent secret leak): `manager.summary()` for a stdio
    connector NEVER includes `env` or its secret values (only `hasEnv`); ASSERT no env value
    appears in the `/api/connectors` HTTP RESPONSE body AND in any emitted bus event for a stdio
    connector — not just `summary()`.
  - REGRESSION: the existing function-form `makeTransport` still works after `manager.js` accepts
    fn-or-map (`mcp.transport.test.js` unchanged); `lint-determinism.js` green (clock/spawn
    injected, no `Date.now`/`Math.random`).
- **Files:** `sidecar/mcp/transport.stdio.js` (NEW, low — beside `transport.http.js`);
  `sidecar/mcp/manager.js` (edit, med — connectors-lane; `makeTransport` accepts fn-or-map,
  record gains `command/args/env/cwd/transport`, `summary()` redacts env; coordinate with the mcp
  lane); `sidecar/index.js` (edit, HIGH — touch ONLY: import near `:58`, manager construction
  `:647-650`, `/api/connectors` upsert `:1082-1099`, `handleHalt` `:1919-1924`; minimal
  pathspec-scoped); `test/mcp.stdio.test.js` (NEW, low); `package.json` (edit, HIGH — append
  `&& node test/mcp.stdio.test.js` right after `mcp.transport.test` on the single-line `test:fast`).
- **Notes:** E-STOP MUST reap stdio children — wire `connectors.close()` into `handleHalt`
  alongside `shellBg.killAll()`, and on shutdown, or a runaway stdio server's spend/CPU survives
  E-STOP. Reap the process GROUP (npx spawns a node grandchild) or an orphan leaks. NO new events
  needed (translate.js emits the frozen `agent.tool_call`/`tool_result`). Run `test:http` (route
  touched).

---

## GOAL G4 — Cron 100% reliability (the critical one)  ·  STATUS: TODO
> PARITY TARGET: Hermes cron guarantees tz/DST-correct next-fire, at-most-once across crash
> (advance-before-run), no-backlog catch-up, cross-process exactly-once (two file locks),
> atomic+durable persistence, recurring-never-silently-disabled. StarNet's determinism split
> (pure cron-math + injected clock) is already AHEAD on testability and matches most of this.
> FIVE gaps remain. Preserve the architecture; close the gaps; keep all new math PURE (injected
> clock; `Intl.DateTimeFormat` with an explicit timeZone is pure given ms and is NOT banned by
> `lint-determinism.js` — confirm + a focused test).

### G4.1 — Timezone / DST correctness (highest value)  ·  STATUS: TODO
One-line task: add an optional IANA tz to cron schedules; match on local wall-clock via
`Intl.DateTimeFormat` (replacing `getUTCHours/getUTCMinutes`, `cron.js:154-167`) so `0 9 * * *`
fires 09:00 LOCAL and shifts across DST; default tz = host tz captured once at boot (injected
constant); add the offset-drift repair branch (parity `jobs.py:1364-1385`).
- **Acceptance (PERFECT STANDARD — the strict deterministic-clock DST checklist):**
  - SPRING/FALL next-fire (`test/cron.dst.test.js`, injected clock, pure): `0 9 * * *`
    tz=`America/New_York` across 2026-03-08 spring-forward and 2026-11-01 fall-back yields
    instants EXACTLY 09:00 local each side (offset −05:00 before / −04:00 after in spring); the
    two day-lengths differ by the correct 23h/25h.
  - NONEXISTENT local time (the hardest case): `30 2 * * *` on 2026-03-08 (02:00→03:00 skipped)
    fires EXACTLY ONCE at the post-transition instant (03:30) — documented policy, tested, never
    silently skipped or double-fired.
  - AMBIGUOUS local time: `30 1 * * *` on 2026-11-01 (01:30 occurs twice) fires EXACTLY ONCE
    (first occurrence), never twice.
  - A tz TYPO fails parse (400) — it must NOT silently fall back to UTC (that re-introduces the
    lie).
  - LIVE: `/api/cron/preview` returns the local-time string for a tz schedule (e.g.
    "next: 9:00 AM EDT").
- **Files:** `sidecar/cron.js` (edit, med — additive tz param, default UTC preserves current
  behavior, no signature break, stays determinism-lint clean); `sidecar/index.js` (edit, HIGH —
  host-tz constant near `:170`, tz in preview at `:1287-1303`); `frontend/app/stationui.js`
  (edit, med — tz in the `buildRoutines` preview `:1234-1390`); `test/cron.dst.test.js` (NEW,
  low); `package.json` (edit, med — append test).
- **Notes:** Document the nonexistent/ambiguous policy in the `cron.js` header. Event additive:
  `cron.skipped` reason `tz-recompute`, `cron.fire` optional `tz` — batched request to
  memory-cortex.

### G4.2 — Durable + atomic persistence (no double-fire on crash)  ·  STATUS: TODO
One-line task: make `saveCronJobs` (`index.js:665-668`) fsync the temp file BEFORE rename
(currently temp-write→rename with NO fsync — a crash in the advance-before-run window can lose
the rename / leave a zero-length file → double-fire), matching the ledger idiom
(`index.js:209-215`); per-pid+random tmp suffix; best-effort POSIX dir-fsync.
- **Acceptance (PERFECT STANDARD):**
  - ATOMIC (`test/cron.durability.test.js`): spy/mock fs on the ACTUAL `saveCronJobs`
    implementation (not a re-implementation) and assert `fsyncSync` precedes `renameSync`; a
    stale leftover `.tmp` does NOT corrupt load — `loadCronJobs` returns the last good envelope
    (fail-closed, `cron-store.js:204-210`); no zero-length jobs file ever observed.
  - CRASH-AT-FIRE-BOUNDARY (no double-fire across restart): `applyTick` fires an interval job
    (persists the ADVANCED `nextRunAt` via `setJobs` BEFORE launch), then WITHOUT settling the
    run a NEW driver over the SAME persisted store at the same `now` → `fire.length === 0`; the
    on-disk (post-fsync) `jobs.json` round-trips to the advanced `nextRunAt`.
- **Files:** `sidecar/index.js` (edit, HIGH — confine to the `saveCronJobs` block);
  `test/cron.durability.test.js` (NEW, low); `package.json` (edit, med — append test).
- **Notes:** Fail-closed. Single-file `writeFile` is the common atomic case.

### G4.3 — Cross-process / reentrancy exactly-once lock  ·  STATUS: TODO
One-line task: add (a) an in-process `tickInFlight` reentrancy guard in `cron-driver.applyTick`
and (b) a cross-process advisory lock (`WORKSPACES/cron.lock`) wrapping `applyTick` AND every
CRUD `saveCronJobs`/`setJobs` write, so two sidecars / a boot-reconcile racing the first tick /
a CRUD save racing an advance cannot double-fire or clobber (parity `.tick.lock` +
`.jobs.lock`). Make `setJobs` re-read-modify-write UNDER the lock (fixes the last-write-wins
mirror clobber).
- **Acceptance (PERFECT STANDARD):**
  - NAIVE double-tick: two back-to-back `applyTick` at the same instant produce a SINGLE
    `cron.fire`.
  - STALE-RECLAIM RACE (the bug the lock exists to prevent — TOCTOU): reclaim must be ATOMIC (a
    single atomic rename to a holder-stamped name, OR O_EXCL re-create after unlink with
    pid+nonce written then read-back-verified); the loser no-ops. Test: construct a STALE lock
    (old mtime), run TWO `applyTick` passes that BOTH attempt reclaim at the same `now`, assert
    exactly ONE `cron.fire` total. An in-process-only test does NOT satisfy this.
  - CRUD serialization: every `cronJobs=` assignment / CRUD write routes through the lock (audit
    `index.js:1235-1269`) — a concurrent CRUD save cannot clobber an advance.
- **Files:** `sidecar/cron-driver.js` (edit, low — `tickInFlight`); `sidecar/index.js` (edit,
  HIGH — `cron.lock` around `applyTick` `:1010-1011` + all CRUD saves; coordinate the
  E-STOP/halt block with G2's `connectors.close` as ONE halt-block change); `package.json`
  (edit, med). 
- **Notes:** Windows has no flock — use the portable O_EXCL+pid+nonce+read-back path with a
  `maxRunMs`-based stale break (mirror the existing lease reclaim) so a crashed holder never
  wedges cron forever. Avoid a new dep unless package policy allows.

### G4.4 — Retry proof + global concurrency cap  ·  STATUS: TODO
One-line task: add `SKYNET_CRON_MAX_PARALLEL` (default 4); in `applyTick`, if firing would
exceed the cap, DEFER the extra due jobs to the next tick (emit `cron.skipped` reason
`at-capacity`) WITHOUT advancing their `nextRunAt` (so they stay due); prove the existing
transient-retry path end-to-end.
- **Acceptance (PERFECT STANDARD):**
  - CAP: with `SKYNET_CRON_MAX_PARALLEL=1` and 3 jobs due, exactly 1 fires and 2 emit
    `cron.skipped` reason `at-capacity` and remain due next tick.
  - TRANSIENT RETRY (injected `runOnce` returning transient:true once then ok): assert backoff
    `nextRunAt`, `retryCount++`, NO `lastRunAt` advance, then success — proven, not assumed.
  - CATCH-UP UNCHANGED: a 10m-interval job 200s-late (<grace) fires exactly ONE catch-up; 83m-late
    (>>grace) fast-forwards + emits `cron.skipped` `caught-up` and fires ZERO (keep
    `cron.tick.test.js:158-178` / `cron.test.js:108-129` green after the lock/tz changes).
- **Files:** `sidecar/cron-driver.js` (edit, low — at-capacity deferral); `sidecar/cron-store.js`
  (edit, low); existing `test/cron.tick.test.js`/`cron.test.js` (extend). 
- **Notes:** Event additive: `cron.skipped` reason `at-capacity`, `cron.tick` optional `deferred`
  int — batched request.

### G4.5 — One-shot fire-claim idempotency (explicit, tested policy)  ·  STATUS: TODO
One-line task: stamp a `fireClaim`/`lastFireAttemptAt` on a one-shot at fire time
(advance-before-run analog); `planTick` treats a one-shot with a FRESH claim (< `maxRunMs`,
no settlement) as not-due so a crash-restart inside the run window does NOT re-fire, while a
zombie past the ceiling does (analog of `claim_job_for_fire`, `jobs.py:1226-1271`).
- **Acceptance (PERFECT STANDARD):**
  - IN-FLIGHT vs SETTLED (the correctness hole the critique flagged): `markRun` CLEARS/supersedes
    `fireClaim` on settlement (success OR terminal failure) so the not-due guard ONLY suppresses
    re-fire while ACTUALLY in-flight. Test: a one-shot fires, the run returns transient-FAILURE
    inside the window → the NEXT `applyTick` re-arms via backoff (NOT suppressed by a stale
    fireClaim).
  - CRASH-IN-WINDOW: a one-shot fired, claim fresh, crash-restart inside the window → not
    re-fired; a zombie past `maxRunMs` IS reclaimed.
- **Files:** `sidecar/cron-store.js` (edit, low — additive `fireClaim` in `makeJob`/`markRun`);
  `test/cron.durability.test.js` or a sibling (extend). 
- **Notes:** Document the chosen at-most-once-within-window policy in the `cron.js` header.

### G4.6 — Honest disabled-state + one-click enable  ·  STATUS: TODO
One-line task: when the scheduler is OFF, show a one-click ENABLE control that arms the timer
WITHOUT a manual env edit + restart (prefer a persisted app-data `cronArmed` flag the boot block
ORs with `SKYNET_CRON_ENABLED`, NOT runtime `process.env` mutation), then re-render
"● scheduler armed".
- **Acceptance (PERFECT STANDARD):**
  - INERT-WHEN-OFF invariant (must not regress): for a user who never enables cron, the off-state
    stays fully inert — the "byte-identical browser path when off" guarantee holds (assert no
    timer armed, no behavior change). A toggle that arms must not change the off-path.
  - LIVE: toggle ENABLE in the running app → a due job fires within ONE tick; UI flips
    `○ scheduler is OFF` (`stationui.js:1301`) → `● scheduler armed`; `GET /api/cron` reflects
    `enabled`.
- **Files:** `frontend/app/stationui.js` (edit, med — `buildRoutines`, one-click enable + honest
  badge); `sidecar/index.js` (edit, HIGH — boot block reads the persisted flag; new toggle route
  → run `test:http`). 
- **Notes:** A persisted `cronArmed` flag OR'd at boot is cleaner than mutating `process.env` and
  preserves the documented boot-frozen gate semantics.

---

## GOAL G5 — fs multi-hunk patch (V4A, validate-then-apply, atomic)  ·  STATUS: TODO
> PARITY TARGET: Hermes' V4A patch tool — multi-hunk, two-phase (validate ALL before any write),
> all-or-nothing, with a fuzzy matcher (`fuzzy_match.py`). StarNet's `fs.edit`
> (`fs.js:137-158`) is a single global `split().join()` find/replace — no hunks, no context, no
> fuzz, no atomicity. **DECISION: ADD a NEW `fs.patch` tool; do NOT overload `fs.edit`** (its
> `{path,find,replace}` schema + "replace every occurrence" semantics are load-bearing for
> existing callers/tests; overloading risks regressing the simple path and confusing tool-choice).
> Mirrors Hermes keeping `patch_replace` separate from V4A.

### G5.1 — `patchparse.js` + `fuzzymatch.js` (V4A parser + strategy ladder)  ·  STATUS: TODO
One-line task: port `parse_v4a_patch` (the exact V4A format: `*** Begin/End Patch`,
`*** Update/Add/Delete/Move File:`, `@@ context @@`, ` `/`-`/`+` prefixes) into a new
`patchparse.js`, and a pure-Node `fuzzy_find_and_replace` subset (exact → line_trimmed →
whitespace_normalized → indentation_flexible → block_anchor) with the uniqueness guard and
reindent-on-non-exact into `fuzzymatch.js`. Both UMD-shaped like `fs.js`.
- **Acceptance (PERFECT STANDARD):**
  - MALFORMED rejection (`test/fs.patch.test.js`): no `*** Update File:` header / UPDATE with
    zero hunks / MOVE without `-> dst` → clear error, returns (never throws), writes NOTHING.
  - WHITESPACE/FUZZY tolerance: a hunk with 2-space-vs-4-space drift still applies via the ladder
    AND the written result keeps the FILE's indentation (reindent), not the patch's; the
    uniqueness guard errors "provide more context" when >1 match and not replaceAll.
- **Files:** `sidecar/tools/builtin/patchparse.js` (NEW, low); `sidecar/tools/builtin/fuzzymatch.js`
  (NEW, low); `test/fs.patch.test.js` (NEW, low).
- **Notes:** Defer unicode/escape-drift strategies (noted parity gap — they salvage LLM
  serialization artifacts; fail-closed is safer than silent corruption). Keep Hermes' conservative
  thresholds (0.50 unique / 0.70 multi).

### G5.2 — `fs.patch` tool (jailed, two-phase, buffer-then-flush atomic)  ·  STATUS: TODO
One-line task: add `fs.patch` (`capability:'cabinet'`, `scope:'write'`, `requiresConsent:true`,
schema `{patch:string}`) to `makeFsTools` + the register list (`fs.js:319-323`); jail every op
path AND MOVE dst via `resolveInside` (`fs.js:46`); PHASE-1 validate all hunks in order against a
simulated buffer (no writes); PHASE-2 apply to in-memory buffers, enforce `WRITE_BYTES`
(`fs.js:36`), buffer ALL results, then flush (abort before the first `writeFile` if any step
fails).
- **Acceptance (PERFECT STANDARD):**
  - MULTI-HUNK: a patch touching TWO hunks in one file applies BOTH (read-back proves both
    edits).
  - ATOMIC ROLLBACK: a patch whose first hunk matches but second does NOT leaves the file
    BYTE-IDENTICAL to before (read-back equals original) and returns an error — no partial
    writes.
  - JAIL: a `../escape` / absolute / drive-letter path is rejected BEFORE any I/O (file
    untouched) — reuses `resolveInside`.
  - `fs.edit` UNCHANGED: existing `test/fs.jail.test.js:64-72` still passes (schema + semantics
    preserved).
- **Files:** `sidecar/tools/builtin/fs.js` (edit, med — add `patchTool` + register `:319-323` +
  expose `{parsePatch, fuzzyFind}` on `_internals` `:321`; additive, `fs.edit` untouched;
  board-check — `agent/hermes-parity` fs.search v2 territory, 27h); `test/fs.patch.test.js`
  (extend); `package.json` (edit, med — append test).
- **Notes:** No git in the jail (Hermes leans on git for phase-2 recovery); buffer-then-flush is
  the honest atomicity primitive. Multi-file mid-flush is a theoretical partial-write window
  (no cross-file fsync transaction) — acceptable for a workspace jail, single-file patches fully
  atomic; note it. NO new events.

---

## GOAL G6 — Spend + model honesty  ·  STATUS: TODO
> Two lies. (A) `/api/insights` shows `(unknown)` models because the Codex path lets the provider
> silently substitute `DEFAULT_MODEL` while `runStore.record` books the empty `o.model`
> (`index.js:1869`/`1519`). (B) A live ~900k-token run renders `$0` because Codex-OAuth is
> UNMETERED (`priceOf()→null`, `normalizeUsage` hardcodes `cost:0`, `codex.js:362,381`) and a
> cold OpenRouter catalog prices $0 — both rendered as a misleading $0 instead of "unmetered" or
> the real cost. **Coordinate with `agent/hermes-parity` (runstore.js/insights.js = its H3.3
> territory, 4h) — board-check + rebase same-session.**

### G6.1 — Book a real model + consistent usd on EVERY path  ·  STATUS: TODO
One-line task: in `runOnce` compute an `effectiveModel` (trim `o.model`; else Codex
`DEFAULT_MODEL`; else `SKYNET_DEFAULT_MODEL`; prefer `result.model` if the loop surfaces it) and
book THAT; compute `effectiveUsd` ONCE upstream of BOTH `ledger.record` (`index.js:1864`) and
`runStore.record` (`:1869`) with the cold-catalog backfill (re-resolve `priceOf` when usd===0 &&
tokens>0 && no usage.cost && a price now resolves) so the two writes get IDENTICAL values.
- **Acceptance (PERFECT STANDARD):**
  - REAL MODEL EVERY PATH: an index-level test that a Codex run with `o.model=''` RECORDS
    `DEFAULT_MODEL` (asserts the `runOnce` record call, not just insights folding); a runstore
    round-trip shows non-empty `model` for browser/channel/cron/delegated paths.
  - NO `(unknown)`: `test/insights.test.js` byModel for rows with real slugs shows those slugs and
    ZERO `(unknown)` entries (given non-empty models).
  - LEDGER↔RUNSTORE↔INSIGHTS CONSISTENCY (double-book guard): a cold-catalog run with tokens>0,
    usd===0 at first, `priceOf` resolving post-warm records a NON-zero usd, and the ledger pool
    delta === the runStore row usd === insights byModel usd for that run (computed ONCE upstream;
    backfill overwrites ONLY when usd===0 && no usage.cost — never double-adds onto a correct
    usage.cost).
- **Files:** `sidecar/index.js` (edit, HIGH — minimal additive diff localized to `runOnce`'s
  finally record block `:1860-1875`); `sidecar/runstore.js` (edit, med — backstop only, real fix
  upstream); `test/runstore.test.js` (extend); `test/insights.test.js` (extend); `package.json`
  (edit, med).
- **Notes:** `(unknown)` stays ONLY as a last resort and should disappear for live runs.

### G6.2 — Render Codex-OAuth as "unmetered", split aggregates honestly  ·  STATUS: TODO
One-line task: persist an additive `unmetered` flag on the run record (true when `usingCodex`);
in `insights.js foldInsights` exclude unmetered $0 from ALL usd aggregates while still counting
runs/tokens, and label the row "subscription / unmetered".
- **Acceptance (PERFECT STANDARD — consistent across ALL five aggregates):**
  - LABELING: a Codex-OAuth run (`unmetered:true`, usd:0, tokens>0) is labeled
    "subscription / unmetered" (or carries `unmetered:true`) and is NOT summed into metered
    `totalUsd` as a real $0 (`test/insights.test.js` + `test/runstore.test.js` round-trip).
  - PER-AGGREGATE CONSISTENCY (the new-lie guard): for a MIXED metered+unmetered row set, assert
    each of `totalUsd`, `byModel.usd`, `byAgent.usd` (`:45`), `overTime.usd` (`:55`) EXCLUDES
    unmetered $; and `avgUsdPerRun` (`:66`) divides metered USD by the METERED run count (NOT
    `totalRuns`) — or is relabeled. Unmetered rows contribute to run COUNTS and token totals
    everywhere, to USD nowhere.
- **Files:** `sidecar/runstore.js` (edit, med — additive `unmetered` field; row shape governed by
  cortex-memory → request the additive field); `sidecar/insights.js` (edit, HIGH — fold split,
  coordinate with hermes-parity); `test/insights.test.js` / `test/runstore.test.js` (extend).
- **Notes:** Event/field additive — `unmetered` requested in the batch if the row shape is
  schema-governed. `runstore.js`/`insights.js` are not under `shared/` so editable, but announce
  the field.

---

## Cross-goal ordering + coordination

**Recommended lane:** `agent/parity-finish` (one lane for ALL of G1/G2/G4/G5/G6 — do NOT split G1
into two lanes; the two G1 recon reports contradicted on tool/file/capability and would
double-register).

**Serialization + dependency constraints:**
1. **Events batch first.** ALL additive `shared/events.js` requests — G1 (`browser.*`/
   `computer.*`), G4 (`cron.skipped` reasons `at-capacity`+`tz-recompute`, `cron.tick.deferred`,
   `cron.fire.tz`), G6 (`unmetered` field if governed) — go in ONE request to `agent/memory-cortex`,
   merge to trunk FIRST, then sync + consume. Emitting an un-widened enum/event fails the
   validator. G2 needs no events.
2. **`package.json test:fast` is a single 2727-char line edited by G1 (≤2 tests), G2 (1), G4 (≥2),
   G5 (1), G6 (test edits) → guaranteed serial rebase conflicts.** Either serialize the appends
   through ONE coordinating commit per merge, OR refactor `test:fast` to a multi-line manifest
   FIRST (coordinate that refactor before any append; if done, it lands first and every item
   rebases onto it).
3. **`sidecar/index.js` region ownership.** G1 (registration), G2 (import + manager `:647-650` +
   `/api/connectors :1082-1099` + `handleHalt :1919-1924`), G4 (`saveCronJobs :665-668` +
   `cron.lock` + host-tz + MAX_PARALLEL + boot-flag), G6 (`runOnce` finally `:1860-1875`) touch
   DIFFERENT regions — assign non-overlapping line-regions up front, land as separate small
   pathspec commits. **G2's `handleHalt` (`connectors.close`) and G4's halt edit are ONE
   coordinated halt-block change.**
4. **G4 lock atomicity is indivisible.** The `cron.lock` must wrap `applyTick` AND every CRUD
   `saveCronJobs`/`setJobs` in the SAME change — partial adoption leaves the clobber bug. Cannot
   split across merges.
5. **G6 usd is computed ONCE** upstream of both `ledger.record` and `runStore.record` — the two
   calls cannot be edited in independent commits or they book different usd.
6. **Within G1: `browser.js` lands green BEFORE `computer.js`** (native-Node/low-risk first;
   computer depends on external cua-driver/nut.js). The `remote` cap + exec-lockout wiring in
   `permissions.js`/`capability/registry.js` must be in place before EITHER tool is reachable on
   an autonomous surface.
7. **G1 frontend capability-OBJECT surfacing is a SEPARATE later lane**, AFTER the backend tools
   land green — it serializes against `agent/crew-sentience` (world.js, 50m) and
   `agent/workstation-ui` (build.js/propsprites.js). It must NOT be bundled into this lane's merge.

**Board-check protocol:** before EVERY edit session and again immediately before each merge, from
the integration tree run `node scripts/board.mjs --files <substr>` for each hot target. MANDATORY
files (revival-risk): `sidecar/index.js`, `sidecar/capability/registry.js`, `sidecar/runstore.js`,
`sidecar/insights.js` (hermes-parity, 3–4h — explicitly coordinate before touching its actively-
iterated files), `sidecar/permissions.js` (exec-spine), `sidecar/mcp/manager.js` (mcp lane),
`frontend/app/world.js` (crew-sentience/workforce-zones/state-integrity — PREFER not touching;
route presentation through props instead), `frontend/app/app.js` (state-integrity/onboarding-
remaster), `frontend/app/stationui.js`. The three NEW backend files (`browser.js`, `computer.js`,
`transport.stdio.js`) are verified free of existing owners but RE-check at merge in case another
lane adds the same path. `board.mjs` only sees uncommitted/ahead-of-trunk state — combine with
`git log -1 -- <file>` recency for the full picture. Keep the lane SHORT, land NEW files first,
merge in small increments.

## Progress Log
- _(the loop appends one dated line per iteration here)_
