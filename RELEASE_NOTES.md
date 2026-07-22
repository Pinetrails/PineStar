# StarNet v0.6.5

A reliability release: every sign-in dead end we could find is gone, your Telegram agent can finally see what you send it, and Windows builds are now code-signed.

## Fixed
- **ChatGPT sign-in is always reachable.** After a disconnect (or on a machine that never
  signed in during setup), the ChatGPT (Codex) card now carries its own ⏼ SIGN IN — you can
  re-connect from Settings without redoing onboarding.
- **No more phantom "sign-in expired."** Token refreshes are now single-flight, so two
  overlapping refreshes can no longer invalidate each other and stamp a false SIGN-IN
  EXPIRED over a healthy session (this hit Kimi hardest).
- **Telegram agents can see your photos and videos.** Photos, video thumbnails, albums, and
  captions now reach the agent (albums arrive as one message, not a burst that cancels
  itself). If the model can't view an image directly, the station falls back to your own
  connected provider's vision — no more "give me an OpenRouter key" demands.
- **The room no longer darkens mid-play.** Answering deferred interview questions during
  normal play no longer leaks the awakening ceremony's darkness veil or camera zoom into
  the lit room.
- **Tutorial highlights land where they should.** The tutorial ring and spotlight now
  position correctly at every TEXT SIZE setting.
- **Honest keychain status.** "Stored in your OS keychain" now only appears after the
  keychain write actually succeeds; failures show what went wrong.
- **Switching brains keeps a working model.** Selecting a different signed-in provider card
  now fills in one of that provider's real models instead of keeping the old provider's
  model and failing on the next run.
- **Clear reconnect doors everywhere.** Mid-run auth failures now name the provider that
  died and offer the right reconnect action (instead of a generic "add a key"); Spotify and
  model errors now open the surface that can actually fix them.
- **Dead-end recovery sweep.** Revoked connectors offer RE-SIGN-IN, removed connectors can
  be re-added immediately, keyless custom endpoints can be edited and fully removed, and
  the ASK/FULL approval picker from setup now has a twin in each agent's dossier CONFIG.

## Changed
- **Windows builds are now code-signed** (publisher: Andrew Sims) — the SmartScreen
  "unknown publisher" warning fades as reputation builds.
- **Apple Silicon installs, first-class.** Install guidance is now silicon-first: grab the
  aarch64 DMG and run the one-time quarantine-clear command; the Intel build stays available
  for Intel Macs.
- **RESTORE BACKUP.** The connect-screen import option is now named what it does.
- **Setup brain picker cleaned up.** ChatGPT keeps the hero sign-in card; every other
  provider is a standard chip that expands its sign-in when picked.
