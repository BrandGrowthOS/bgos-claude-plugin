# A HOME override does not isolate a test on Windows

**Date:** 2026-08-30

**Context:** Smoke-testing the real `server.ts` from a working tree, with `HOME` pointed at a scratch
directory so it would pick up throwaway credentials.

**Gotcha / Pattern:** It did not. Node's `os.homedir()` reads `USERPROFILE` on Windows and ignores
`HOME`. So the daemon resolved `~/.bgos-agent/credentials.json` to the REAL file, authenticated as a
live production assistant, connected to `api.brandgrowthos.ai`, and pushed its own command catalogue
over that agent's. Proven afterwards in one line, which is the check that should have come first:

```
USERPROFILE=C:/Temp/x node -e "console.log(require('os').homedir())"   ->  C:/Temp/x
HOME=C:/Temp/x        node -e "console.log(require('os').homedir())"   ->  C:\Users\karim
```

The deeper mistake was not the variable. It was reaching for an environment override as the isolation
mechanism at all, and then not verifying it before running something that talks to production. An
override you have not tested is a belief, not a boundary.

**How to apply next time:** Never boot a real daemon against a home you have not just proved is the
one it will use. `test/../rig/` now does this properly and is the pattern to copy:

- `USERPROFILE` (and `HOME`, harmlessly) for `homedir()`.
- `CLAUDE_CONFIG_DIR`, which `claudeConfigDir()` honours as an explicit override.
- `BGOS_CREDENTIALS_PATH`, which is the important one: an explicit path with NO fallback to the real
  file, so even if a home override failed the daemon still cannot reach live credentials.
- A hard refusal to start unless the backend URL matches `^http://127\.0\.0\.1:\d+$`.
- Print the real `~/.claude/settings.json` mtime before and after, so a stray write is visible in the
  run's own output rather than discovered later.

Prefer a stub backend on loopback over any real one, and prefer a fake assistant id so state
directories cannot collide with a real agent's.

**Regression guard:** Prose only, plus the rig itself (`rig/run-daemon.mjs`), whose loopback check is
executable and refuses to run otherwise. There is no unit test for this because the failure mode is
someone writing a NEW ad-hoc script; the guard that matters is having a safe rig to reach for
instead.
