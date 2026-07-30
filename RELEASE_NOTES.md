# StarNet v0.8.0

The station stops being something you have to sit in front of. Your agents now hold a real
conversation on Telegram — reading what you replied to, answering in the thread that asked, writing
back in front of you — and they carry an earned record of what they can actually do, one the harness
proves rather than the interface flatters. The floor under them became a place. And a long sweep ran
the other way: forty-odd spots where StarNet said something it could not prove are now either true
or gone.

## Telegram is a real seat at the station, not a notification pipe

The channel could already send and receive. It could not hold a conversation. Now it can.

- **It answers in the topic that asked.** Thread and reply routing means a forum group with ten
  topics gets ten conversations instead of ten answers in the wrong place. If the topic is deleted
  mid-run, the reply falls back to the group rather than vanishing.
- **The reply is written in front of you.** Long answers stream in as the agent thinks, edited in
  place, chunked on fences so code never breaks mid-block.
- **It reads what you replied to.** Quoting a message now hands the agent that message as context
  instead of silently dropping it.
- **Media both directions** — photos, documents and albums out; photos, documents and **voice
  notes** in. Bot tokens are redacted from every error string.
- **It hears the update kinds it used to be deaf to**, and acknowledges receipt with a reaction, so
  you can tell "received" from "ignored".
- **Group discipline:** wake words, `/mention on|off` as an escape hatch, per-speaker attribution,
  and a room the agent can actually follow.
- **It tells you what it cannot hear.** With Telegram privacy mode on, wake words and passive
  observation receive *nothing*. StarNet now says so plainly instead of offering a feature that
  quietly does nothing.

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
- **The offline Local Live voice now admits it is not in this build.** The desktop bundle ships no
  npm packages, so the offline speech models cannot load in an installed copy. The panel used to
  open your microphone, promise a model download, and then show a raw module error. It now says
  plainly that the models are not installed, and never opens the microphone. Your existing voice
  controls are unaffected.
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
- **macOS: in-app updating works from v0.6.8 onward.**
- **Upgrading is a no-op for your data.** The workspace schema generation is unchanged from v0.7.0
  and the shared event contract was not touched, so there is no migration to run. Verified by
  booting this build against a copy of a real v0.7.0 workspace rather than assumed.
- **StarNet stays MIT-licensed**, and the code is genuinely free to use commercially. The *name,
  logo and artwork* are not part of that grant — a fork is welcome, under its own name.
