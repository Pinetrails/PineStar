# StarNet v0.6.4

More ways to bring your own subscription, and a station that remembers being born.

## Added
- **Grok and Kimi subscription sign-in at awakening.** The overseer brain picker now offers
  Grok and Kimi alongside ChatGPT and Claude — sign in with the subscription you already pay
  for, no API key required.

## Fixed
- **Reopening mid-onboarding no longer replays the birth.** Closing the app during the
  first meeting and coming back now gets a brief "I remember this part" re-greeting and jumps
  straight back to the interview — the full awakening monologue plays exactly once, ever.
- **Titlebar buttons match at every scale.** Minimize, maximize, restore, and close now share
  one 2px glyph spec, so the maximized window chrome no longer looks heavier or thinner than
  the windowed one.

## Changed
- **Personality selection no longer shows a sample reply.** Pick a voice by its name and
  vibe — your agent's first real message is the first thing you hear from it.
- **Updates now come from the project's new home** (androoAGI/starnet-releases). Existing
  installs keep updating seamlessly.
