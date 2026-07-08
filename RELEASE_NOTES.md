# StarNet v0.3.2

Image generation catches up to 2026.

- **Current-gen image model by default.** The studio was pinned to the oldest image model
  on the catalog (the source of garbled text on mockups). Default is now Nano Banana 2,
  and agents are taught to reach for Nano Banana Pro on hero/marketing assets or anything
  with readable text - proven crisp on a real landing-page mockup.
- Slug-drift safety: if a newer model slug ever errors, generation falls back once to the
  known-good legacy model and honestly reports which model actually produced the image.
- New STARNET_IMAGE_MODEL env override.
- Includes v0.3.0/v0.3.1 (multi-agent reliability, deliverable visibility, headless
  research, diagnostics truth).
