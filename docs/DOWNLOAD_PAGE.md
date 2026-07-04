# StarNet

**A real desktop station where AI agents do real work — and you watch it happen.**

StarNet is a local-first desktop app. You spawn into one shabby starter room of a living
pixel-art station and expand outward: place rooms, run hallways, summon specialists. The catch
is that the station isn't decoration — the way you build it **is** the way your real
multi-agent org is wired. A room is a capability-scoped team; a hallway is an authorized
handoff lane; a placed object is a real tool grant. Behind the glass, the agents make real
model calls, run real tools, spend real money, and produce real output. Nothing on the screen
is faked: the station only ever shows you what the machine underneath is actually doing.

## Download

> **Windows only for now.** macOS and Linux builds are not shipped yet.

**[Download the latest release →](https://github.com/nonfungiblefunyuns-ship-it/starnet-releases/releases/latest)**

Grab the installer named `StarNet_<version>_x64-setup.exe`.

### System requirements

- **Windows 10 or 11, 64-bit (x64).**
- A few hundred MB of disk space (grows with your agents' history and voice cache).
- An internet connection — for your AI provider, not for StarNet itself.
- Either an **API key** (OpenRouter / OpenAI / Anthropic / others) **or** a **ChatGPT
  subscription** to sign in with. See "Bring your own key" below.

## Installing (the honest version)

The installer is currently **unsigned** (no paid code-signing certificate yet), so Windows
will warn you before running it. This is expected for an early build — it does not mean
anything is wrong with the file.

- **Windows SmartScreen** will likely show *"Windows protected your PC."* Click **More info**,
  then **Run anyway**.
- **Smart App Control (SAC)** on some Windows 11 machines is a *hard* block that "Run anyway"
  cannot bypass. If you're on enforced SAC, you'll need to wait for a signed build.

The full step-by-step, including how to check your SAC mode, is in
**[INSTALL.md](../INSTALL.md)**. Read it before you install — we'd rather tell you what you'll
see up front than have the installer mysteriously vanish.

Once installed, StarNet keeps itself up to date through its built-in updater (System →
Updates); you won't need to come back here for routine updates.

## Bring your own key (BYOK)

StarNet does not resell AI access and has no account system. You connect **your own** provider:

- **Bring your own API key** — OpenRouter, OpenAI, Anthropic, and other OpenAI-compatible
  providers. Paste your key and go.
- **Or sign in with ChatGPT** — use an existing ChatGPT subscription instead of a raw key.

**Your key, your machine, your data.** The key lives on your computer (in the OS keychain on
the desktop build), the agents run on your computer, and your conversations and files stay on
your computer. StarNet never sees a copy. See **[PRIVACY.md](../PRIVACY.md)** for the full,
audited breakdown — including the fact that there is **no telemetry, no analytics, and no
phone-home**.

## What it costs

**The app is free.** You pay only your own AI provider for the tokens your agents use —
directly, at their prices, with no StarNet markup (StarNet has no way to bill you). You set the
budget: StarNet has per-run, per-day, and global spend caps, and a one-click halt that stops
every running agent immediately.

## Support

Email only, best-effort: `ANDREW_SUPPORT_EMAIL`.

## Legal

- **[Privacy](../PRIVACY.md)** — what stays local, what leaves, and why (nothing is telemetry).
- **[Terms of Use](../TERMS.md)** — free, as-is, you own your provider spend and your agents'
  actions.

<!-- ===================== SCREENSHOTS / CLIP PLACEHOLDER =====================
     TODO before launch: drop in real media of the running station.
       - Hero screenshot: the pixel-art station with agents at work.
       - Short clip/GIF: an agent walking to its desk and running a real task
         (COMMS beat + world reacting to a real tool call).
       - 2-3 supporting shots: recruitment bay, room/hallway building, spend ledger.
     Keep captions truthful — show real runs, not staged frames.
     ========================================================================= -->

_Screenshots and a demo clip go here._
