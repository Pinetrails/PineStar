; StarNet NSIS installer hooks.
;
; ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
; The manual-installer path could not overwrite its own node.exe.
;
; The app ships a bundled node runtime at $INSTDIR\node.exe and runs the sidecar from it. Tauri's
; own CheckIfAppIsRunning (utils.nsh) only ever looks for ${MAINBINARYNAME}.exe — the shell — so
; nothing in the stock installer touches the sidecar. Worse, it kills the shell with a hard
; TerminateProcess, which runs NEITHER `Drop for AppState` NOR the ExitRequested handler where
; kill_sidecar() lives (src-tauri/src/main.rs) — so killing the shell *strands* the sidecar, and
; the very next thing the Install section does is `File` over node.exe. Interactively that stops
; on "Error opening file for writing ... node.exe"; SILENTLY (/S) it is worse — the error is
; auto-ignored and the install completes carrying a STALE node.exe.
;
; The IN-APP updater path was already fixed in main.rs (the updater's on_before_exit calls
; kill_sidecar before the plugin's std::process::exit). This hook is the other half: the user who
; downloads the installer from the site and runs it by hand, and the user carrying an ORPHANED
; sidecar from an earlier hard kill (taskkill /F, crash, End Task) — neither runs any in-process
; hook at all. The Rust-side orphan reaper only runs at the NEXT app boot, i.e. after the
; installer has already failed.
;
; ── ORDER IS LOAD-BEARING ──────────────────────────────────────────────────────────────────────
; The shell must die FIRST. A long-lived guardian thread polls the child every ~3s and respawns it
; on unexpected exit (main.rs spawn_guardian), gated only by an in-process `shutting_down` flag
; that a hard kill never sets. Kill node.exe while the shell is alive and it is back — holding the
; same lock — within three seconds.
;
; ── SCOPE IS LOAD-BEARING ──────────────────────────────────────────────────────────────────────
; The kill matches on FULL IMAGE PATH, never on the name `node.exe`. A developer machine routinely
; has dozens of unrelated node processes (other apps, dev servers, other agent runtimes); Tauri's
; own name-based KillProcess would take every one of them down. Same rule main.rs states for its
; own reaper: "Full image path — the ONLY thing that authorizes a kill."
;
; ── THE WOW64 TRAP (this cost a debug cycle; do not undo it) ───────────────────────────────────
; The NSIS installer runs as a 32-BIT process, so `$SYSDIR` is WOW64-redirected to SysWOW64 and
; launches the 32-bit PowerShell. A 32-bit PowerShell can SEE 64-bit processes but reads their
; `.Path` as EMPTY — so a path-scoped match finds nothing, returns exit code 0, and the hook
; silently does nothing at all. Measured directly: `Get-Process -Id <64-bit pid> | Select Path`
; returns the real path under System32 PowerShell and blank under SysWOW64 PowerShell. We
; therefore reach the 64-bit PowerShell through the SysNative alias, which exists only for 32-bit
; processes; on a genuinely 64-bit installer SysNative is absent and $SYSDIR is already correct.
; NOTE this failed SAFE (killed nothing) rather than dangerous — keep it that way.
;
; ── FAIL-OPEN ──────────────────────────────────────────────────────────────────────────────────
; Any PowerShell/enumeration failure is ignored and the install proceeds. If this hook does
; nothing, behaviour is exactly what shipped in v0.6.8 — the stock retry dialog is still the
; backstop, so the hook can never make an install worse than it already was.
;
; ── NOTE ON `$` ────────────────────────────────────────────────────────────────────────────────
; NSIS expands `$` in strings, so the PowerShell below is deliberately free of PowerShell
; variables — `Get-Process | Where-Object Path -eq ... | Stop-Process` needs none. `$INSTDIR` is
; the one expansion we DO want. Do not "simplify" this into a `$_` pipeline.

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  Push $R9

  ; Resolve the 64-BIT PowerShell (see the WOW64 trap above).
  StrCpy $R9 "$WINDIR\SysNative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$R9" +2 0
    StrCpy $R9 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

  DetailPrint "Stopping any StarNet processes running from $INSTDIR..."

  ; 1. The shell first — it owns the guardian that would respawn the sidecar.
  nsExec::ExecToLog '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name skynet-desktop -ErrorAction SilentlyContinue | Where-Object Path -eq $\'$INSTDIR\skynet-desktop.exe$\' | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Pop $0
  Sleep 600

  ; 2. Then the sidecar — including one orphaned by an earlier hard kill, whose parent is long gone.
  nsExec::ExecToLog '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object Path -eq $\'$INSTDIR\node.exe$\' | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Pop $0
  Sleep 400

  Pop $R9
  Pop $1
  Pop $0
!macroend
