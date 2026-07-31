# StarNet v0.8.0

The station stops being something you have to sit in front of. You can now hold a real spoken
call with it — hands-free, fully offline, no API key — and conduct every session on the floor
from that one call: reading what each is doing, spinning up new ones, handing work across.
Meanwhile your agents hold a real conversation on Telegram: threaded, streaming, full media in
both directions. They carry an earned record of what they can actually do, one the harness proves
rather than the interface flatters. The floor under them became a place. And a long sweep ran
the other way: forty-odd spots where StarNet said something it could not prove are now either true
or gone.

## Live Voice: a real call with the station, fully offline

LOCAL LIVE is a hands-free voice mode: open a call and talk. The station listens, thinks, and
answers out loud — and nothing in the loop waits on a click.

- **The offline engine ships inside the installer.** Whisper speech recognition and the Kokoro
  neural voice now travel with the app itself, so an installed build listens and speaks with no
  API key and no cloud round trip. The model weights download once (~150 MB) into a local cache
  documented in PRIVACY.md; after that, your audio never leaves the machine.
- **Hands-free means hands-free.** Approvals, choices and questions that come up mid-call are
  spoken to you and can be answered by voice. A call is something you can walk away from your
  desk and still finish.
- **One call conducts the whole station.** Mid-call, the station can list your open sessions,
  read what each one is doing, spin up new ones and put work in front of them. You stand in one
  conversation and orchestrate every desk on the floor by voice — ask what the research session
  found, start a build in a fresh session, and keep talking while both run.
- **One voice, and it is the one you picked.** The station speaks with a single engine and a
  single chosen identity. An installed build can no longer silently swap your picked voice for a
  keyed cloud provider's; if the offline engine is unavailable, it falls back to the nearest
  built-in system neural voice — same sex, same accent — and says which engine it is using.
- **The call's audio has exactly one home.** Your microphone and the station's spoken replies are
  bound to the session that opened the call — they cannot bleed into another tab or an older
  page, a stale session is refused *before* the microphone opens, and delivery survives page
  switches instead of going quiet. The call commands the whole station; the audio never strays.

## Telegram is a full seat at the station

Your agents now hold a real, threaded, full-media conversation on Telegram — the same crew, the
same tools, the same station, from wherever you are.

- **Every topic is its own conversation.** Thread and reply routing means a forum group with ten
  topics runs ten parallel conversations, each answer landing exactly where it was asked — and if
  a topic is deleted mid-run, the reply falls back to the group instead of vanishing.
- **Answers are written in front of you.** Long replies stream in live as the agent thinks,
  edited in place, chunked on fences so code never breaks mid-block.
- **Quoting is context.** Reply to any message and the agent reads it as part of your ask.
- **Full media, both directions** — photos, documents and albums out; photos, documents and
  **voice notes** in. Speak to your station from your phone and it does the work.
- **Received is visible.** The agent acknowledges what it hears with a reaction, so you can tell
  "received" from "ignored" at a glance — across every update kind, not just plain text.
- **Group discipline built in:** wake words, per-speaker attribution, `/mention on|off` as an
  escape hatch, and a room the agent can genuinely follow.
- **And it is honest about the edges.** With Telegram privacy mode on, wake words and passive
  observation receive *nothing* from Telegram — StarNet says so plainly instead of offering a
  feature that quietly does nothing. Bot tokens are redacted from every error string.

Both directions were proven against the real api.telegram.org — a real message driving a real run to
a real reply — not against a fixture.

## Your specialists have a record now, and it is load-bearing

The trophy case used to be decoration. It is evidence, and it feeds decisions.

- **PRACTICE** counts what an agent taught itself, and cannot be farmed.
- **RELIABILITY** is a second meter the harness earns on its own, without a single tap from you. A
  veteran's legacy save reads **CALIBRATING** rather than inventing a confident percentage out of
  runs it never measured.
- **Five earned rungs** fill the mid-game where progression used to go dark.
- **The meters reach the lead's dispatch briefing** — a specialist's earned record now changes who
  gets handed the work.

Nothing here gates anything; XP stays approval-only. An existing Commander loses nothing: a
machine-checked upgrade guard runs v0.7.0-shaped records through the update and asserts it can only
*add* — no lost level, no moved XP, no un-lit badge.

## The station has grounds, walls, and somewhere to put things

- **FOREST and THE MOON** — two grounds the station can land on, with relief instead of rings, and
  shadow that darkens material rather than deleting it.
- **Real hallway walls and a real deck**, including the wall tone fix.
- **Twelve new decor props**, and the lounge became a place agents actually go.
- **The prop palette is searchable** — one box, flat across 120 props, and the pick lands on its own
  shelf. Every word the palette prints is a word you can type.

## Reach: the station can name what it can touch

- **`browser.find`** reaches an element the snapshot cap never showed, alongside conditional waits,
  stale-reference recovery, and the option to drive the Commander's own Chrome.
- **Background shells gained stdin** and a paged, searchable log — a background process is now
  something you can talk to, not just start.
- **`fs.read` and `computer.use` hand back pixels**, through one generalized image channel.
- **A per-turn aggregate tool-output budget**, and proactive rate-limit accounting read from every
  provider response instead of guessed at.
- **The skill guard verdict is enforced.** A flagged skill is withheld, not silently injected.
- **Connectors are discoverable** — typing a platform name finds it, and the agent reads its own
  catalog instead of inventing menu paths.

## Recipes and recommendations

- **Typed fill-ins** with a live "what gets sent" preview, and a content-first library.
- **The learned topic histogram feeds every ranked surface**, so what StarNet suggests tracks what
  you have actually been doing.

## macOS: signed, hardened, and notarizable

The Mac app now ships with **hardened runtime and the entitlements notarization requires**. That
matters more than it sounds: hardened runtime terminates JIT-compiling processes unless they are
entitled for it, and StarNet ships two — the shell's WebView and the Node sidecar's V8. Without
these the app signs and notarizes cleanly and then dies on launch.

## Truthful telemetry: forty-one things StarNet said that it could not prove

This is the release's quiet theme. A representative slice:

- **A message that names a component now owes proof that component is at fault.** "The local service
  is unreachable" is no longer said on the strength of a failure that never touched it.
- **Local Live voice names the engine it is actually using.** Earlier builds would open your
  microphone, promise an offline model download the installed app could not perform, and then
  show a raw module error. This release fixes the root — the offline engine now ships in the
  installer (see the Live Voice section) — and keeps the honesty: the panel reports the engine
  really in use, and on a platform with no engine at all it says so plainly instead of failing
  mid-session.
- **An errored read is not "you have none."** A connector list that failed to load no longer renders
  as a confident empty inventory.
- **A "since" is never a future timestamp.**
- **A spent allowance is not a busy provider**, and three flags that looked live but did nothing now
  work.
- **Missing credentials classify as an auth problem**, so COMMS points you at provider settings
  instead of offering a doomed "Try again".
- **COMMS names the provider** when an outbound call fails, and voice stops selling you an API key to
  fix a network blip.
- **A saved skill stops rotting on every read**, and one approval no longer blesses later bytes.
- **New-agent lockdown fails closed.** If standing permissions cannot actually be revoked, the app
  refuses rather than reporting a lockdown the server never performed — and the FULL ACCESS
  wildcards are revoked too, not just the curated list.
- **Windows background process trees are actually reaped**, instead of `taskkill` reporting success
  while grandchildren keep running.
- **A standing folder or connector grant is described by what it allows**, not just by its danger
  key.
- **The seeded dev station stops fabricating a KEY SAVED badge** when it holds no key.
- **The header minimize button is gone** — it read as a duplicate close. Minimize-to-strip stays,
  via header double-click and the dock.

## Fixes

Beyond the honesty sweep, the mechanical bugs this release closes:

- **Live voice opens audible on the path that actually ships**, the LIVE VOICE settings list
  paints, the picker works, and the two-voice level meter reads real levels on the dictation leg.
- **Room noise cannot fire an agent run.** Native dictation is gated, and the keystroke sound no
  longer plays under live speech.
- **A reply finds you across pages.** Session delivery is durable — navigate away mid-run and the
  answer still lands in the right session instead of going quiet.
- **Runs ride out transient provider overloads** instead of dying at the first blip, and
  delegated research survives web-fallback stalls.
- **Web search recovered from a one-character encoding outage**, and bot-walled pages now get a
  real reader instead of a dead end.
- **A web "failure" that is really an answer is treated as one** — a 403, a 404 or a throttle
  comes back as information, not an error card.
- **Agent lifecycle and MCP reconnects are serialized**, ending a race that could wedge
  connectors mid-session.
- **E-STOP holds.** Grant keys are canonical, the FULL ACCESS wildcard is visible, and the
  emergency stop actually stops what it claims to.
- **SETTINGS stopped storming repaints** and fetching the model catalog in duplicate.
- **REFIT no longer goes black on a landed station**, and the gallery host claims its full
  palette column.
- **The ACP editor bridge re-discovers the station token after a restart** instead of telling
  your editor to restart.
- **Channel setup guides come back** — after a forget, and on platforms never set up at all.
- **COMMS announces the active model from the selector**, so what you picked is what you see
  running.
- **A summoned specialist finally earns its own XP** — the rate-the-work beat was hero-only.
- **Tables are actually usable as prop mounts**, hallway walls read as bulkheads with a properly
  lit deck, and rollback history survives an index loss.

## Security

- **The Codex OAuth token migration was a copier, not a migrator.** It could write a live ChatGPT
  refresh token into whatever directory the workspace variable happened to point at — including the
  temp directories used by tests and QA runs, which also meant a "clean-room" boot could silently
  inherit a real sign-in. Migration now happens only into one of the app's own known homes,
  identified by enumerating the real app-data roots rather than inferred from directory shape. A
  cleanup script removes copies the old behaviour already leaked, and refuses to touch the signed-in
  original or an explicitly configured workspace.
- **If you have signed into Codex with ChatGPT on a machine that ran an affected build, rotate that
  ChatGPT session.**

## Notes

- Windows installers are code-signed (CN=Andrew Sims), continuing from v0.6.5.
- **Windows: update from inside StarNet.** It installs over your existing copy — your crew,
  sessions, keys and station stay exactly where they are.
- **This release ships the Windows build.** The macOS 0.8.0 build follows separately; macOS
  in-app updating continues to work from v0.6.8 onward once it lands.
- **Stale caches can no longer outlive an update.** The compiled WebView caches are now
  invalidated against the exact executable that is running — not just its version number — so
  even a rebuilt installer under the same version can never run yesterday's cached code against
  today's app. Your world save and settings are untouched.
- **Upgrading is a no-op for your data.** The workspace schema generation is unchanged from v0.7.0
  and the shared event contract was not touched, so there is no migration to run. Verified by
  booting this build against a copy of a real v0.7.0 workspace rather than assumed.
- **StarNet stays MIT-licensed**, and the code is genuinely free to use commercially. The *name,
  logo and artwork* are not part of that grant — a fork is welcome, under its own name.
