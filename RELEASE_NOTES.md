# StarNet v0.10.6

This update makes delegated work, connected services, and first-run station setup more dependable while reducing notification noise.

- The Commander can steer active delegates and hand off the lead task context, so multi-agent work stays aligned as plans change.
- Anthropic models through OpenRouter reuse stable cacheable context anchors, improving long-conversation efficiency without changing the visible conversation.
- A provider retry after partial streaming no longer repeats text that was already shown.
- Google Workspace gains direct Developer Preview connections for Gmail, Drive, Calendar, Docs, and Sheets with shared OAuth setup and restart-safe credential handling.
- Zernio joins the Social connector catalog with its official OAuth flow and searchable network coverage.
- Telegram replies are final-only, pairing appears immediately, agent bots stay bound to the selected roster agent, and removing a bot clears its recoverable credentials only after durable proof.
- The notification bell now keeps actionable results and failures while leaving routine flavor, progress chatter, and one-tap confirmations out of persistent history.
- Dragged COMMS widths now remain honored on narrower desktop windows instead of snapping back below the 1000px breakpoint.
- Closing StarNet to the system tray now preserves the hidden main window, so tray Open and a second launch reliably bring the station back.
- REFIT's starter card now teaches the five practical agent powers—Files, Web, Terminal, Memory, and Images—and retires once the station has them.
- Background reflection, scouting, skill maintenance, quest refresh, and other fail-open passes now leave throttled diagnostic traces instead of disappearing silently when their envelope fails.
- Release verification now understands structured cached provider prompts, restoring full approval, workshop-deliverable, visual, and installed-build coverage for this candidate.
