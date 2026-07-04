# North Star — the adaptive user-understanding engine

**Branch:** `agent/north-star` · **Status:** P1 in progress · **Author:** Fable/Opus lane
**Grounded against trunk** `feat/harness-backend` @ 02114dce (real code, not stale docs — every claim below carries a file:line).

## The idea (locked with Andrew)

The North Star is **not** a one-time captured goal on a plaque. It is a *belief the station holds
about the Commander that sharpens over time*. Every bit of context — mostly **implicit signal from
the work itself**, occasionally an **earned, non-annoying question** — refines the model of what the
Commander actually wants. It **adapts** as their preferences and workflow drift. Ambition is the
spine, but it is a *living estimate*, not a fixed target.

The single engagement lever: make **"how well the station understands you"** a first-class, honest,
adaptive quantity. Watching the station *get* you is intrinsically rewarding and gives a reason to
feed it context. The north star is what that understanding *points at*, and it visibly sharpens from
vague → crisp as the quantity climbs.

> **Product law that governs this whole feature (truthful telemetry):** understanding is derived
> ONLY from beliefs the station actually holds, decayed by staleness. A cold station reads 0. A
> station whose beliefs have gone stale reads *down*. It never fabricates certainty the harness
> can't prove.

## Grounded reality — what already exists (do NOT rebuild)

- **7-dimension dossier** with mutable, provenance-stamped beliefs — `frontend/app/dossier.js:24`
  (`identity, stack, goals, style, standing_orders, pain, ambition`); each belief carries
  `{source, sourceRunId, observedAt, createdAt, updatedAt, pinned}` — `dossier.js:79`.
- **Two honest but partial familiarity meters already ship:**
  - `dossier.js:166` `summary().familiarity` = fraction of dimensions with ≥1 belief (**breadth**).
  - `profile.js:103` `summary().familiarity` = `min(1, samples/24)` (**work-observation depth**),
    with EWMA recency decay (14-day half-life) — `profile.js:23,32`.
  - Neither captures **confidence quality** (belief trust/source, recency, corroboration), and they
    don't combine into one signal the north star can point at.
- **Study Engine** already observes finished salient work → proposes belief ADD/RETIRE, consent-gated
  — `sidecar/index.js:991` (`runStudy`), `frontend/app/studystore.js`.
- **Goal-arc with *real* milestone progress** (advances only from completed work, never a manual tick)
  — `frontend/app/goalstore.js:255` (`reconcile`), `Goals.progress()` → `{done,total,pct}`. **This is
  the north-star PROGRESS axis.**
- **Disciplined ask system** (the anti-annoyance backbone — reuse, don't fight):
  `MIN_WORK=3` earned gate, `CAP=1`/session, stop-after-2-per-dim, persisted declined denylists,
  beat-slot priority arbiter — `frontend/app/curiosity.js:22`, `curiositystore.js`, `chat.js`.
- **Away-workshop return** keep/discard/later — `sidecar/index.js:3063`.

## The real gaps (corrected after grepping trunk)

1. **No unified confidence.** The two familiarity meters are breadth + work-depth only; nothing rolls
   belief count + provenance + recency + corroboration into a per-dimension + overall **confidence**.
2. **The north star isn't felt.** The goal-arc renders as a quest header + a one-line cron note
   (`goalstore.js:107`). No central object combining *clarity* (understanding) × *progress*.
3. **Questions aren't aimed at the biggest uncertainty.** Curiosity picks *any blank dimension*
   (`curiosity.js`), not the dimension whose resolution most sharpens the north star.
4. **Understanding only grows from explicit proposals, not from work.** The dossier moves via
   Study/reflection cards; there's no lightweight implicit corroboration from the *pattern* of work.
5. **Drift is consent-only + coarse.** Dossier beliefs sit at full confidence until an LLM happens to
   propose retiring them — no structural staleness signal on goals/ambition. (The interest profile
   already decays; the dossier does not.)
6. **Workshop verdict is discarded.** No path from keep/discard back into the model — yet "keep" is a
   strong signal of what the Commander values (`sidecar/index.js:3096` emits `workshop.decided`, no
   listener updates the model).

*(Correction to an earlier assumption: the `memory > study > arc` priority exists only in the
frontend beat-slot; the sidecar gates fire concurrently — `sidecar/index.js:4090`.)*

## Design — one connective layer + its honest output

### `understanding.js` (pure engine, this PR / P1)
A read-model mirroring `profile.js`/`dossier.js` (browser global + node export, injected clock, no
`Date.now`/`Math.random`). Computes:

- **per-dimension confidence** `conf[dim] ∈ [0,1]` = saturating function of *evidence*, where a
  belief's evidence = `sourceWeight(source) × freshness(age)` (+ optional corroboration). Commander-
  authored/pinned beliefs weigh full; study-observed weigh less until corroborated; stale beliefs
  decay (this is the drift signal that makes P4 nearly free).
- **overall understanding** = confidence weighted toward north-star-critical dims
  (`goals`/`ambition`/`pain` > the rest), because understanding is defined relative to what the star
  points at.
- **`weakest`** = the dimension maximizing `weight × (1 − conf)` — the **value-of-information target**
  a rare earned question should aim at (consumed by P3).
- **`calibrating`** flag + `workSamples` passthrough for an honest "still getting to know you" read.

No storage, no new events, no UI — pure derivation over state that already persists. Verifiable in
isolation via `test/understanding.test.js`.

## Phases

> **PIVOT (2026-07-03, locked by Andrew):** no dedicated visual surface. The ambient-star concept was
> built, live-verified, and REJECTED — "it needs to be the daily usage and gameplay… that will better
> improve the experience due to StarNet adapting to the user." The engine drives BEHAVIOR (question
> targeting, meter math), presented in the simplest way possible (the existing COMMANDER panel meter).
> Do not rebuild a star/fog/gauge hero visual for this feature.

| Phase | Build | Status |
|---|---|---|
| **P1** | `understanding.js` pure engine + test; `understandingstore.js` read wiring | ✅ SHIPPED (952c73e3; 29+17 assertions) |
| ~~P1b~~ | ~~north-star surface~~ | ❌ REJECTED — built then removed (197301b1) |
| **P3** | **Value-of-information** question targeting — `Curiosity.pick()` takes a VOI `order`; the one earned question targets the weakest dim. Gates unchanged; fail-open. | ✅ SHIPPED (197301b1; live-verified: picks 'pain' where canonical asked 'stack') |
| **Meter** | COMMANDER panel familiarity DISPLAY prefers `understanding.overall` (display-only; `Dossier.summary().familiarity` untouched — pitch/suggest gates still read it) | ✅ SHIPPED (197301b1; live: renders 34% = the read) |
| **P2** | Implicit **corroboration** (each salient run quietly nudges confidence in consistent beliefs) + **workshop keep/discard→model** loop | next — may need 1 additive event (request from `cortex-memory` owner) |
| **P4** | **Drift trigger** — realized as R3 below (suggestions as belief probes), NOT as a re-ask | superseded by R3 |

## Approved roadmap (Andrew, 2026-07-03) — context handover inside the work, never beside it

Build order **R2 → R5 → R3 → R4**. (R1 "mid-task questions that are work" = PARKED, Andrew unsure —
do not build without his go.)

| # | Build | Shape |
|---|---|---|
| **R2** | **Ratings → preference signal.** The shipped 👍/👌/👎 rate-the-work verdicts feed the understanding layer: positive ratings corroborate the current style/standing-orders model; a 👎 is counter-evidence that LOWERS style confidence — which re-aims the earned VOI question at style ("how do you actually want this done?"). Truthful: a downvote honestly means "our model of how you like work done is less certain." Engine needs SIGNED corroboration (currently clamps negatives). | this branch |
| **R5** | **Rhythm → routine offers.** A pure engine over run history (task tag × time-of-day × recurrence) detects honest patterns ("standup prep every morning") and surfaces ONE one-tap routine offer through the existing seeds/cron path + the same earned-beat gates. Big enough for its own lane/worktree. | own lane |
| **R3** | **Suggestions as silent belief probes (the P4 realization).** When a high-weight belief goes stale (engine freshness already computes this), the next earned suggestion aims at it; accept = corroboration, decline = counter-evidence. Drift detection with ZERO new asks. Needs beliefId threading through the suggestion directive + outcome capture. | this branch |
| **R4** | **Payoff receipts.** When an answer/observation lands in the dossier, one provable "◈ briefing updated: …" line in the existing receipt style at the commit site (chat.js) — no new event, no meter. Teaches that feeding the station is never wasted. | this branch, rides with R2/R3 |

## Verification (per doctrine)
- **P1 done** = `node test/understanding.test.js` green + the module appended to `test:fast:raw` and
  the full gate green before merge. Pure engine, no live-app surface yet.
- Later phases: live-app DOM round-trip proof per `starnet-verify` before any "done" claim.
- **Ownership:** never edit `shared/events.js`/`shared/schema.js` (owned, additive-only by request).
  P2's corroboration event, if needed, is requested from the `cortex-memory` workstream.
