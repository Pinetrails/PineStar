# StarNet v0.6.9

> **DRAFT** — written 2026-07-27 against trunk `210e9bfa`, covering every lane merged **after
> the v0.6.8 cut** (`d2e2c43b`, published 2026-07-27 05:06Z). v0.6.8 is already live, so this is
> the next cut's copy. `release:bump` overwrites `RELEASE_NOTES.md` with a stub — paste this in
> after the bump, not before it. Anything merged after `210e9bfa` still needs adding here.

The station stops borrowing the operating system's furniture, and starts remembering its own work.

## The station reads as a place

- **A room has four walls, not one.** Only the back wall was ever lit along its top, so the side
  and front walls read as a floor edge and the station looked like it "cut off". The lit crown now
  runs the whole way round — the same ladder of contact seam, face, under-seam, crown and outer
  edge on every side — so a room reads as enclosed at any zoom, in one room or a station full of
  them.
- **The corners hold that ring.** A top corner is the bottom corner lifted: one profile, no notch
  where the curve meets the straight, no waist where the ring narrows, and no stray shadow left
  scattered in the void when a station has more than one room. The corner outline is one rigid
  circle — never eased, because a sheared circle stops being a circle.
- **Crew stand in a shadow, not on a line.** The contact shadow under a body was a flat 9×2 bar.
  It's a soft foreshortened pool now that breathes with the idle bob and tightens when an agent
  sits down, so a body reads as standing on the deck instead of stuck to it.
- **The CRT opens up.** The tube's aperture went from 50% to 68% of the panel and became a dial
  you can set — the feed had been painting nearly a quarter of the screen black inside the canvas
  itself, which no amount of window resizing could reclaim.

## Nothing in StarNet is painted by your operating system

The station is one surface. Anywhere the browser or the OS was still drawing its own furniture
inside it — a grey button, a system font, a yellow tooltip bubble — the illusion broke.

- **The control floor.** No control may paint itself with OS chrome. Every button, dropdown,
  checkbox, slider and scrollbar is drawn in the station's own style, on every platform, and the
  sweep that proved it is now a test — so a control that arrives white and Arial fails the gate
  instead of shipping.
- **Every input speaks in the station's font.** Native inputs were the last hole: they inherit the
  station typeface now instead of falling back to whatever the browser prefers.
- **Dialogs and tooltips are ours too.** The OS tooltip bubble that appeared a second after your
  cursor stopped is gone; StarNet draws its own, immediately, in the same register as the rest of
  the panel.
- **PAINT became SURFACE**, and its palette was rebuilt — the deck-and-wall picker in REFIT had
  been raw HTML buttons sitting inside a pixel-art station.
- **See a skin before you choose it.** The dossier's CONFIG › SKIN shows a live preview of the crew
  member wearing it, instead of asking you to pick a name and find out afterwards.
- **The COMMS rail reclaims its dead space**, and the transcript stopped repeating itself.

## COMMS sounds like the station again

When the new sound pack landed, only 10 of its 36 cues were mapped. The five left on the old synth
included the tick that fires under *every* revealed line, roughly twenty times a second — which is
why the surface still sounded like the old board no matter what else changed.

- Every cue plays a pack file now; none are synthesised.
- The quest, level-up and milestone cues are the picked ones, level-graded so the celebration
  isn't the quietest thing in the room.
- The composer stopped clipping its own placeholder, so the slash-command hint is readable.
- A run you stop says **RUN STOPPED** once, instead of echoing its own headline back at you.

## The station remembers, and shows its working

- **Memory forms on every real run**, not only the one you happened to be watching. Work done by a
  routine, a channel or a delegated worker leaves the same trace as work done in front of you.
- **A belief says where it came from.** Memory Core shows the run a belief was formed in, and
  separates what the station is confident about from what still needs you — so a wrong belief is
  something you can find and correct rather than something you argue with.
- **Recall reaches every workstream.** `recall_conversation` used to see only the open one; it now
  searches across them, which is what makes "what did we decide about X" answerable weeks later.
- **A new note can challenge an old belief.** Writing something that contradicts what the station
  already holds raises the contradiction instead of silently stacking two opposite facts.

## Crew

- **An agent you asked for arrives with somewhere to work.** When you ask the overseer to create a
  crew member, that agent is seeded with its own desk — it adopts a free one if the station has it
  and builds one if it doesn't — instead of appearing with nowhere to sit. Recruiting from the
  Recruitment Bay is unchanged: you place that desk yourself.
- **Every polished skin can sit down.** The 26 redrawn skins gained sit frames, so a crew member at
  a desk is drawn seated rather than standing in a chair.
- **The polished art is what installs.** A skin pack ships several states and the installer had
  been taking whichever one sorted first rather than the finished one. `blank`'s face came back
  with the same pass, and the four `blank_*` recolours are derived from it instead of drifting.
- **Blink is cut from an eye-constrained mask**, so closing the eyes no longer smears whatever else
  changed between a skin's old art and its new.

## Fixes

- **"Full access" means something again — in two places.** Granting a connector's tool full access
  was discarded, so the station asked for the same permission on every single call. The same class
  of bug was then found on the folder card: full access to a folder dropped a grade on the way in,
  so five reads inside one folder cost five clicks. Both record the grade you actually gave them.
- The ambient room shadow no longer darkens bare space at a corner, and the crown carries one
  constant width through a corner instead of thinning out where two walls meet.

## Notes

- Windows installers are code-signed (CN=Andrew Sims), continuing from v0.6.5.
- **Windows: update from inside StarNet.** It installs over your existing copy — your crew,
  sessions, keys and station stay exactly where they are.
- **macOS: in-app updating works from v0.6.8 onward** — the mac updater legs
  (`StarNet_darwin-arm64.app.tar.gz` / `-x64`, plus their `.sig`s) are published alongside the
  DMGs, so INSTALL UPDATE resolves instead of 404ing.
- **StarNet stays MIT-licensed**, and the code is genuinely free to use commercially. The *name,
  logo and artwork* are not part of that grant — a fork is welcome, under its own name.
