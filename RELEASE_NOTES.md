# StarNet v0.6.6

A critical data-safety release: closing the app can no longer lose your latest agents and instructions.

## Fixed
- **Closing StarNet no longer drops your newest changes.** The last-moment save flush that
  runs when the window closes (or minimizes to the tray) was silently failing on desktop —
  it posted to an address that never reached the station's local engine, then wrongly
  reported success and discarded the unsaved copy. If you closed the app shortly after
  editing an agent or its instructions, those edits could vanish while the save indicator
  claimed everything was backed up. The flush now reaches the engine, authenticates
  correctly, and only ever reports "saved" after the engine confirms the write actually
  landed on disk.
- **The save indicator is honest again.** A dispatched-but-unconfirmed save no longer
  counts as a success, so a genuinely failing backup shows the warning state instead of a
  false green.

## If you were affected
If a recent close cost you changes, your durable mirror may still hold them: look at
`%APPDATA%\ai.skynet.harness\workspaces\agent.save.json` (and the `.bak` next to it).

## Notes
- Windows installers are code-signed (CN=Andrew Sims), continuing from v0.6.5.
- Update from inside StarNet, or download the current installer from the releases page.
