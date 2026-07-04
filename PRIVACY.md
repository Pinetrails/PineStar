# StarNet Privacy

_Last reviewed: 2026-07-03, against the shipping code._

StarNet is a **local-first desktop app**. It runs a small server (the "sidecar") on your own
machine (`localhost`) and does the agent work there. There is **no StarNet cloud, no StarNet
account, and no StarNet server that receives your data.** This document is written in plain
English and is grounded in an audit of the actual code — not aspirations.

Support questions: `ANDREW_SUPPORT_EMAIL`.

## The short version

- **We collect nothing.** There is no telemetry, no analytics, no crash reporting, no ad SDK,
  and no "phone home" of any kind. We verified this by searching the whole codebase for the
  usual suspects (Sentry, PostHog, Mixpanel, Segment, Google Analytics, Amplitude, Datadog):
  none are present.
- **Your data stays on your machine**, under your OS user's app-data directory
  (`%LOCALAPPDATA%\StarNet\` on Windows).
- The app talks to the network **only** to do work you asked for, and only to the specific
  third parties described below.

## What leaves your machine — and only these

StarNet makes outbound network requests in exactly these situations. Nothing else.

### 1. Your chosen AI model provider (using your key)

When an agent runs, StarNet calls the model provider **you** configured, authenticated with
**your** API key (or your ChatGPT sign-in). Your prompts, conversation, and any content the
agent works with are sent to that provider so it can generate a response — the same as any app
that uses that provider. StarNet is a pass-through here; it does not sit in the middle.

Depending on what you set up, that provider is one of:

- OpenRouter (`openrouter.ai`)
- OpenAI (`api.openai.com`)
- Anthropic (`api.anthropic.com`)
- Google Gemini (`generativelanguage.googleapis.com`)
- ChatGPT via sign-in (`chatgpt.com` / `auth.openai.com`)
- or another OpenAI-compatible provider you point it at (xAI, Groq, Mistral, DeepSeek,
  Together, Fireworks, Perplexity, Cerebras).

**Your key, your data, your account.** StarNet never sees a StarNet-owned copy — the key is
yours and the request goes straight to the provider you picked.

### 2. Discord / Telegram — only if you connect them

If you connect a Discord bot or a Telegram bot, StarNet talks to that platform's API
(`discord.com`, `api.telegram.org`) to send and receive messages on the channel you set up. If
you never connect a channel, StarNet never contacts these services.

### 3. Spotify — only if you enable it

If you enable the Spotify integration and authorize it, StarNet calls the Spotify API
(`api.spotify.com`, `accounts.spotify.com`) to read what's playing and control playback, using
the token you granted. If you don't enable Spotify, no Spotify requests are made.

### 4. Web search / web fetch — only when an agent uses that tool

If an agent uses its web tools, StarNet fetches results through independent, keyless services
— web search via Mojeek (`mojeek.com`, with DuckDuckGo as a fallback) and page reading via
Jina Reader (`r.jina.ai`) — or, if you have an OpenRouter key, OpenRouter's web plugin. Only
your search query or the URL you asked to read is sent, and only when an agent actually runs a
web search or fetch. (The fetch tool also refuses to reach private/internal network addresses,
as an anti-abuse guard.)

### 5. A version check for updates (no personal data)

The desktop app checks for updates by fetching a single public manifest file from GitHub
Releases:

```
https://github.com/nonfungiblefunyuns-ship-it/starnet-releases/releases/latest/download/latest.json
```

This is a plain `GET` for a static file. **No user data, no identifier, and no telemetry are
sent** — it's the same request your browser would make to view that file. Each update's
integrity is cryptographically verified against a key baked into the app before anything is
installed.

## What StarNet stores on your machine (and how)

Everything below lives under your per-user app-data directory
(`%LOCALAPPDATA%\StarNet\workspaces\` on Windows). It never leaves your machine except as
described above.

| What | Where | How it's stored |
| --- | --- | --- |
| Conversation transcripts | `transcript.jsonl` | **Plaintext** JSON on disk |
| Run history + cost ledger | `runs.jsonl`, `ledger.jsonl` | **Plaintext** JSON on disk |
| Agent memory / beliefs / to-dos | `<agent>.notebook.json`, `<agent>.todo.json`, dossier/goals | **Plaintext** JSON on disk |
| Voice cache (spoken-line audio) | `voice-cache/` | **Plaintext** audio files on disk |
| Discord / Telegram bot tokens | OS keychain (desktop) | **OS keychain** (Windows Credential Manager); plaintext fallback in bare/dev mode — see below |
| Your model-provider API keys | OS keychain (desktop) | **OS keychain** (Windows Credential Manager) |
| Spotify OAuth token | `.secrets/spotify.json` | **Plaintext** JSON on disk |
| ChatGPT / Codex sign-in token | `codex/tokens.json` | **Plaintext** JSON on disk |
| Settings, roster, permissions, cron, connectors | various `*.json` | **Plaintext** JSON on disk |

### Secrets: keychain vs. plaintext — the honest picture

On the **desktop build**, your provider API keys and your Discord/Telegram bot tokens are held
in the **OS keychain** (Windows Credential Manager, under service `ai.skynet.harness`), not in
a plaintext file. When you upgrade from an older build, any bot token found in the old
plaintext `channels/secrets.json` is migrated into the keychain and stripped from that file.

If you instead run the bare sidecar directly (developer mode / `node sidecar/index.js` /
tests), the OS keychain isn't reachable, so those bot tokens **fall back to a plaintext file**
(`channels/secrets.json`). This is called out plainly in the code rather than hidden.

Two secret types are **plaintext even on desktop** today: the **Spotify** OAuth token
(`.secrets/spotify.json`) and the **ChatGPT/Codex** sign-in token (`codex/tokens.json`). If
that matters to you, keep those integrations off. (Transcripts are run through a redaction step
at write-time to avoid capturing secret-shaped tokens in your chat history, but the transcript
file itself is plaintext.)

Because this data sits in plaintext files under your user profile, anyone with access to your
Windows user account can read it. Protect your machine account accordingly.

## What we do NOT do

- We do **not** run analytics or telemetry of any kind.
- We do **not** collect crash reports.
- We do **not** have a StarNet account system or a StarNet backend that stores your data.
- We do **not** sell, share, or transmit your conversations, keys, or files to anyone —
  the only outbound traffic is the specific, purpose-built requests listed above.

## Deleting your data

Your data is just files. To wipe it, uninstall StarNet and delete the
`%LOCALAPPDATA%\StarNet\` folder. Provider API keys and channel tokens held in the OS keychain
can be removed via Windows Credential Manager (search for `ai.skynet.harness`).

## Changes

If this changes, we'll update this document. Questions: `ANDREW_SUPPORT_EMAIL`.
