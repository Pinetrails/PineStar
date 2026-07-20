# StarNet v0.6.2

## Fixes from the field

- **The STARNET wordmark sits correctly in windowed mode on every screen.** On displays where
  text size auto-scales (most laptops), the logo drifted out of its topbar seat unless the app
  was fullscreen. It now positions correctly at every text-size setting, at boot, and across
  zoom changes.
- **The "skip intro" button is gone.** The floating corner button read as leftover dev chrome
  and contradicted the station's onboarding law. The guided flow still offers its own natural
  exits — nobody is trapped.
- **macOS: the station view healing itself.** Some Mac installs rendered the entire habitat as
  a solid theme-colored wash. The CRT warp now verifies its own GPU output every launch; if the
  graphics stack misrenders, the station switches to an identical CPU renderer automatically
  and notes it in the console. (If your Mac showed the wash, this build should clear it —
  we'd love to hear either way.)
- **The maximize button keeps its shape.** The restore glyph fragmented under Windows display
  scaling and larger text sizes; it's rebuilt to stay crisp at any scale.

## Under the hood

- The first-run QA gate (Beginner Run) drives the real WAKE wire-proof against a local
  deterministic wire instead of stalling — the mandatory live-model check for real users is
  unchanged.

