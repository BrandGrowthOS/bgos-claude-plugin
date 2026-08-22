@echo off
rem hoai: cmd.exe shim so `hoai` works from a plain Command Prompt.
rem Delegates to hoai.ps1 next to it; every decision lives in hoai-core.mjs.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hoai.ps1" %*
exit /b %ERRORLEVEL%
