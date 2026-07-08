# StarNet v0.4.0

The station learns your work now — and proves everything it claims.

## Quests that actually complete
- Quest V2: quests are station-owned with **completion contracts** — every quest
  names exactly what finishes it, and the station now detects all of it: a run
  finishing, a capability going live at a desk, something the station learned,
  a deliverable landing on disk, or your agent attesting with evidence (you
  confirm). No more quests that sit there forever.
- Agents see open STATION QUESTS in their briefing and report progress as they
  work; only the agent actually working a quest can propose completing it.

## The station remembers your ideas
- Mention an idea in chat and move on — the station mines it, and after the run
  a **thread card** offers it back: keep it, tweak it, or discard it (discarded
  ideas are never re-offered). Kept threads become real, durable work items the
  Night Shift can pick up later.

## Recruitment bay recommendations that evolve
- The SUGGESTED shelf now drafts recipes and crew prospects from what you
  *actually* do — topic interests learned from your real activity, with the
  evidence quoted on every card. What you launch feeds the FOR-YOU ranking.
- Honest when it's new: a fresh station says **CALIBRATING — watching what you
  work on** instead of showing an empty shelf. Every suggestion's "why" must
  cite something the station really observed, or it's rejected.

## Night Shift: work on YOUR projects, safely
- Tell an agent a folder path in chat once ("always") and it becomes a blessed
  project — listed in the new **PROJECTS rail**, revocable any time, and the
  Night Shift may revisit it while you're away: scan for TODOs, draft a fix,
  and leave a **patch** for your morning review. Approve and it lands on a
  fresh `ns/` branch in your repo — never main, never pushed.
- Each night declares **one focus** with cited evidence ("tonight: your invoice
  tool — because you touched it 6 times this week"), and beats compound on it.
- **E-STOP now truly stops the Night Shift.** Pressing it halts autonomous
  beats durably — surviving restarts — until you deliberately turn the
  autonomy dial back up. The status panel reports the halt honestly.

## Under the hood
- The hourly QA guardian now runs the full HTTP/E2E integration suite, so a
  green station vouches for these new systems end-to-end, not just unit tests.
- Desktop control: tasks follow a quietest-path doctrine and computer-use
  refuses to act on a window it can't prove is the one you meant.
