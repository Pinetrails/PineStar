# Create-Agent UI — Andrew's feedback + redesign handoff

> Misrouted feedback: Andrew gave create-screen feedback to the testing-harness session by mistake.
> Captured here for the **onboarding / agent-creation** session. Two mockups already exist; no app code changed.

## Andrew's feedback (two rounds)

**Round 1 — on the current live "Create your agent" screen** (verdict: "looks like a clusterfuck"):
- Dislikes the **ASCII art** — "random slop that makes no sense."
- The **voice/personality** section "takes up half the screen even though it's not that important in this creation part."
- The character **skin selector** is "on the bottom for some reason."
- Wants a **more engaging** agent-building UI — keep the StarNet aesthetic but **more premium**.
- **ADD one more CRUCIAL element** the user must select.
- Make the **ASCII art relevant**, not random.

**Round 2 — on the first redesign**:
- "I like the way the **role** looks visually, BUT it misleads — the user won't want to start with a
  specialized agent without creating the **MAIN agent / orchestrator** first."
- "I NEED the **personality types to CHANGE** — Wry Genius / Worker Homie DON'T MAKE SENSE."
- "The **brain** concept is brilliant."
- "We can touch up the UI more but we're **headed in the right direction**."

## Design decisions in the latest mockup (v3)

1. **First agent = THE OVERSEER / orchestrating lead**, not a specialist menu. Title "CREATE YOUR OVERSEER,"
   an "AGENT 01 · YOUR ORCHESTRATING LEAD" tag, and the central sigil is the Overseer's emblem (a hub directing
   its crew). Specialists (scout/engineer/scribe/sentinel) are explicitly framed as **the crew the overseer
   recruits LATER** — they belong in the **Recruitment Bay** (already shipped, `f46ade9`, engraved-coin class
   seals), NOT the create screen.
2. **Crucial new element = MANDATE** — "what your overseer runs" (Personal Ops / Research / Engineering /
   Content / Growth / Open). Keeps the card visual Andrew liked, it's REQUIRED, and it gives the lead its
   purpose at birth. In code, purpose is currently **deferred to the awakening** (`"you have not yet been given
   a purpose"` in app.js) — MANDATE fills that at create for the lead.
   **OPEN QUESTION to confirm with Andrew:** is MANDATE the right crucial element, or did he mean something else
   (the Overseer's home workstation? an autonomy level)?
3. **New personality types**: PROFESSIONAL / FRIENDLY / DIRECT / WITTY / CALM (replacing the nonsensical ones).
   Kept to ONE compact row + a "fine-tune" expander — no longer half the screen.
4. **The brain, elevated** into its own framed panel (`◈ model · via provider · short descriptor · CHANGE`).
5. **Layout fixes**: the AGENT is the hero (centered glowing "genesis pod"); SKIN/SUIT controls moved UP directly
   under the agent (not the bottom); the ASCII art is now the meaningful, reactive role sigil. StarNet aesthetic
   kept (amber CRT, VT323, scanlines, glow) but more premium.

## Artifacts (this repo)
- `frontend/mockups/create-agent-v3.html` — **latest, the reference.** (Overseer framing, new personalities,
  brain panel, MANDATE.)
- `frontend/mockups/create-agent-v2.html` — first pass (superseded; pre-Overseer-framing).
- Preview with headless Chrome (or just open in a browser):
  ```
  chrome-headless-shell --headless --disable-gpu --force-device-scale-factor=2 --virtual-time-budget=3500 \
    --screenshot=out.png --window-size=1360,730 \
    file:///C:/Users/andro/Desktop/gen/frontend/mockups/create-agent-v3.html
  ```
  (binary under `~/AppData/Local/ms-playwright/...chromium_headless_shell.../`)

## Implementation notes
- The live create screen is built in `frontend/app/app.js`; the live walk-cycle skin preview is
  `frontend/app/skinstage.js` (that pod is where it renders — richer than the static sprite in the mockup);
  `onboarding.js` drives the awakening AFTER create.
- Agent data model (app.js): `name, color, skin, model, personaId (voice via Personas.compose),
  role (orchestrator|specialist), voiceTraits, customVoice, purpose, specialtyId, docs{identity/purpose/operating-manual}`.
- Andrew wants continued UI touch-ups: make the agent-pod bigger / more cinematic; polish the mandate cards +
  brain panel further. He's happy with the direction.

These are **mockups only** — no app code has been changed.
