# `schtasks /SC ONLOGON` is admin-only; the Task Scheduler API through PowerShell is not

**Date:** 2026-08-25

**Context:** Installing the per-machine watcher as an always-on service on Windows, from inside the running agent (unelevated user session), on command from the app. The first attempt ran `schtasks /Create /F /SC ONLOGON /RL LIMITED ...` and failed `EPERM: operation not permitted, uv_spawn 'schtasks'` (the same call from a shell says `Access is denied`). That failure is what produced the very first `update_failure_signatures` row (`watcher_service:service_install_failed`).

**Gotcha / Pattern:** The `schtasks` executable refuses logon-trigger tasks for a standard user, but the Task Scheduler COM API accepts them for the calling user: `Register-ScheduledTask -TaskName 'HOAI Watcher' -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) -Action (...) -RunLevel Limited` works unelevated. If even that is refused (policy), the HKCU `Run` key is the fallback (starts at logon, no restart-on-exit). The bundle therefore ships `install-task.ps1` (`-Action install|start|stop|uninstall|status`) and `run-hidden.vbs` (so the task runs `node hoai-watcher.mjs run` without a console window), and the service layer calls `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <bundle>\install-task.ps1`.

**How to apply next time:** On Windows, prefer the API (PowerShell cmdlets) over the legacy exe for anything a standard user should be able to do, and keep one documented fallback. Log the exact refusal into the ledger; it is the diagnostic. Watch the `recordingExec` test key format: it keys on `<file> <first arg>`, so the refusal must be scripted on the install action, not on a later one.

**Regression guard:** `test/watcher-service.test.ts` (win32 spec: files, commands, the run-key fallback ladder, refusal stops the ladder). Live: task `HOAI Watcher` Ready, watcher online, survived its own bundle swap and restart.
