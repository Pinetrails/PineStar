# Voice orchestration — the missing tool surface (plan, 2026-07-30)

Andrew, on testing the built-in live voice: *"I asked the agent to create a new session and delegate
the agent to do work and it did not create any new session… the whole point of voice mode is for users
to turn it on and have their agent do anything they want in StarNet, orchestrate multiple sessions or
create them, delegate work to other agents, report back when work is done."*

He is right, and it is missing rather than broken.

## Why nothing happened

The three tools (`get_starnet_status`, `start_starnet_task`, `interrupt_starnet_task`) live in
`sidecar/realtime-voice.js` and were only ever reachable on the **provider-native realtime path**,
which was retired on 2026-07-30 in favour of one built-in engine for every station.

On the built-in path the transcript goes to `Chat.send()` — an ordinary agent run. So the agent gets
whatever tools it normally has and **nothing that knows about StarNet's own structure**. There is no
voice-specific tool layer on this path at all.

Even the retired three were thin: status, start, interrupt. Nothing for *create a session*, *switch
agent*, *delegate*, or *report back when done*.

## The real blocker: where these actions live

⛔ **Session and crew actions are FRONTEND state.** `App.openWorkstream`, `App.summonAgent`,
`App.selectAgent`, `App.agents()`, and `Workstreams.*` run in the page, and workstreams persist inside
`agent.save.json` written by the page. The agent's tools run in the **sidecar**. So this is not "add a
tool file" — it needs a bridge, and choosing that bridge is the design decision:

- **A — sidecar tools + a command channel to the page.** Add `sidecar/tools/builtin/station.js` with
  the orchestration verbs; each one emits a `U.bus` event the page acts on, and resolves on the page's
  acknowledgement. Right shape long-term (works for cron, Night Shift and channels too, not just
  voice), but needs a request/response convention over the bus and an honest timeout when no page is
  attached — a headless run must NOT silently claim it opened a session.
- **B — move the session model into the sidecar.** Cleanest conceptually, largest blast radius: the
  save shape, rail rendering and every existing reader change. Not a voice-sized change.
- **C — page-side tool loop for voice only.** Fastest, but re-creates the divergence the single-engine
  decision just removed: voice would orchestrate through one path and everything else through another.

**Recommendation: A.** It serves the other unattended surfaces, and it keeps one answer to "how does
something ask the station to do a station thing".

## The verbs (what "orchestration" actually means here)

| verb | does | already exists |
|---|---|---|
| `station.status` | open sessions, which is active, who is busy, what awaits approval | `VoiceLive.statusSnapshot()` — reuse verbatim |
| `station.new_session` | create a workstream, optionally bound to an agent, optionally focus it | `App.openWorkstream` / `newWorkstream` |
| `station.switch_session` | focus an existing workstream by title or id | `Workstreams.*` + `App.openWorkstream` |
| `station.delegate` | hand an instruction to a NAMED crew member, in their own session | `App.selectAgent` + `Chat.sendOrQueue`; `App.summonAgent` when absent |
| `station.crew` | who is on the roster and what each is for | `App.agents()` |
| `station.report` | what finished since a marker — the "tell me when it's done" half | run ledger + `Channels.statusOf` |

⛔ **`station.report` is the one that makes voice feel alive** and is the easiest to fake. It must read
real completion state, never narrate an expectation. A verb that says "your build finished" without a
finished run is precisely the lie this product forbids.

## Sequencing

1. `station.status` + `station.crew` (read-only) — proves the bridge with nothing to corrupt.
2. `station.new_session` + `station.switch_session`.
3. `station.delegate`.
4. `station.report`, plus a spoken nudge when a delegated run completes while voice is live.

## Guardrails carried from tonight

- ⛔ The tools must be reachable from the ORDINARY agent run, not a voice-only side channel — voice
  should be one caller of a station-wide surface, or the divergence returns.
- ⛔ Every verb reports refusal honestly (no page attached, no such agent, session busy). Silence or a
  cheerful confirmation for work that did not happen is the failure mode that cost this feature its
  credibility once already.
- A spoken task must remain indistinguishable downstream from a typed one: same approvals, same
  ledger, same visible transcript (`Chat.sendOrQueue`, as `start_starnet_task` already did).

## Live finding (Andrew, 2026-07-30): delegation cannot target a session

Tested on the built-in path: he asked for a session named "research", asked for a research agent, then
asked for a task to run *in that session*. The session was created. The agent was created. The work
was delegated — **into the wrong workstream**.

⛔ **CORRECTION to the section above: orchestration is NOT absent on this path.** The agent's ordinary
tools already create sessions and crew; that part works. The defect is narrower and sharper:

**`sidecar/tools/builtin/orchestration.js` has no `streamId` / `workstream` / `sessionId` parameter at
all** (grep: two incidental comment mentions of the word "session", zero plumbing). Delegation is
**agent-addressed, not session-addressed** — the caller can say WHO, never WHERE. The run therefore
lands in whatever workstream the delegating agent is currently in, which is why a session the
Commander explicitly named was ignored.

### What this changes about the plan

`station.delegate` (verb 4) is no longer just "wire a bridge verb". Two halves:

1. **Give the orchestration tool a session target.** Add an optional workstream/stream id to the
   delegate/subagent params and thread it through to where the run is bound. Without this the bridge
   verb would have the same hole one layer up.
2. **Resolve a session by NAME.** The Commander speaks titles ("the research session"), not ids, so the
   verb needs title → id resolution against the live list, and must REFUSE on an ambiguous or unknown
   title rather than silently defaulting to the active one. ⛔ Defaulting is precisely the behaviour
   that produced this bug; a wrong-but-plausible destination is worse than a refusal.

### Acceptance for this slice
Speak: "make a session called research", "add a research agent", "have them summarise X **in the
research session**" → the run appears in `research`, attributed to that agent, and nowhere else.
Then the same request naming a session that does not exist must say so, not pick one.
