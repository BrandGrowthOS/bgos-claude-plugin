# The dev-channels gate fires on marketplace launches too, no settings key silences it, and on Windows it is accepted from the console buffer

**Date:** 2026-08-25

**Context:** Unattended relaunches (update restarts, watcher restarts) on Windows, where there is no `expect`. Claude Code 2.1.241 prints `WARNING: Loading development channels ...` with a menu whose default (Enter with nothing selected, or a blind Enter at the wrong moment) is "no, exit".

**Gotcha / Pattern:**
- The gate shows for MARKETPLACE installs as well as clones whenever `--dangerously-load-development-channels` is on the command line, and it is on the line for marketplace launches too (`plugin:hoai@hoai` alone loads tools and delivers nothing; see the BGOS learning `claude-channels-flag-loads-but-never-delivers`). The settings key `dangerouslyLoadDevelopmentChannels` does not suppress it on this version; `skipDangerousModePermissionPrompt` only covers the permissions prompt.
- The Windows helper (`bin/win32-accept-dev-channels.ps1`) attaches to the launcher's console (`AttachConsole(pid)`), reads the LIVE screen with `ReadConsoleOutputCharacter` over a `CONOUT$` handle reopened on every poll (the TUI switches to the alternate screen buffer; a handle opened once keeps reading the old one), and sends Enter through `WriteConsoleInput` only after the gate marker text is on screen. `0xC0000000` must be cast to `[uint32]` in PowerShell 5.1 or the handle open fails silently.
- Spawn the helper with `detached: false`. Detached, it exits 0 within a second having attached to nothing, and the log says "accepted" for a gate it never saw.

**How to apply next time:** Treat "the prompt was accepted" as something you prove from the screen, not from a return code: log `start / attached / accepted` with timestamps, and in an E2E read the console buffer (a 30-line Python ctypes reader does it) to see what the model is actually looking at. Never send Enter on a timer.

**Regression guard:** `test/hoai-supervise.test.ts` (`win32 gate helper source: only ever presses Enter after the gate marker is on screen, never blindly`; `win32GateHelperArgs`; the helper is spawned non-detached with a log file). Live: `~/.bgos-agent/logs/win32-gate-helper.log` showed `attached` then `accepted` within ~1.1s on every relaunch of the E2E.
