# StarNet v0.3.3

Image quality + honest busy signals.

- **Current-gen image models.** The studio default was the oldest image model on the
  catalog (the source of garbled mockup text). Now defaults to Nano Banana 2, and agents
  are taught to use Nano Banana Pro for hero/marketing assets or readable text - proven
  crisp on a real landing-page mockup. STARNET_IMAGE_MODEL env override; slug-drift falls
  back safely and reports the model that actually generated.
- **No more mystery "agent is busy" loops.** When the one-run-per-agent guard blocks a
  chat, you now see exactly WHO holds the agent (started how long ago, from what source)
  and the doors out (ROUTINES / E-STOP) - instead of an endless "Something went wrong".
- Includes v0.3.0-v0.3.2 (multi-agent reliability, deliverable visibility, headless
  research, diagnostics truth).
