# Start with Windows: the plugin names the switch the way the app does

Board row 6900f401 (the plugin part). BGOS #3802 renamed the Windows switch from
Keep agents running to Start with Windows; the installer and the knowledge base
were fixed in lane oldname. The plugin was left. Ships as 0.81.1.

## Source of truth (read only, BGOS origin/main)

- `frontend/expo-app/src/plugin-update/keepAliveWords.ts`: `keepAliveWords(platform)`
  picks the Windows words only for `platform === "win32"`, the computer the words
  describe, never the device showing them. Mac, Linux and a computer that has not
  said keep today's words.
- Windows name: `Start with Windows` (en `pluginUpdate.machine.startWithWindows.title`).
- Mac and Linux name: `Keep agents running` (`pluginUpdate.machine.keepAlive.title`).
- Where it sits: on the computer's card in Integrations. The app's own Windows
  lines say "in Integrations" and "this computer's card in Integrations"
  (`settings.agent.alwaysOn.windows.noSupervisor`,
  `desktopPresence.settings.startWithWindows.info`). "Settings, Computers" is
  not a place the switch is in the app now.

## What changed (words only)

| Where | Before | After |
| --- | --- | --- |
| `server.ts` once-only Windows stand-down log line | `when Keep agents running is on for this computer in HOAI (Settings, Computers)` | `when Start with Windows is on for this computer in HOAI (Integrations, this computer's card)` |
| `lib/watcher-core.mjs` create_agent launch step | `(keep agents running: <reason>)` | Windows: `(Start with Windows: <reason>)`; Mac and Linux unchanged |
| `lib/agent-credentials.ts` `formatHomeMovedWarning` | `(a Keep agents running recipe, ...)` | Windows: `(a Start with Windows recipe, ...)`; Mac and Linux unchanged |

## The launch step line (watcher-core.mjs)

Judgment call, so the reasoning is here. The message is posted as job progress to
the backend. The app reads a step message by splitting it on colons and looking
for a known token (`knownMessageToken` over `STEP_MESSAGE_KEYS` in
`machineModel.ts`). Nothing in this line is a known token, and an unknown token is
never printed. No code in the plugin reads the label back, and the tests only pin
it by exact equality, not by parsing. So it is free text, read at most by an
operator looking at a stored job. It changes on Windows only. The reason codes
(`switch_on`, `switch_off`, `never_set`, `no_answer`) are untouched.

## Left alone on purpose

Comments (server.ts WHY comments, lib comments), CHANGELOG history, code names
(`keepalive-plan`, `always-on`, `watcher-keepalive`), reason codes, the stand-down
reason `always_on_unsupported`.

## Proof

- Red first: the pinned tests were updated before the fix and failed on main for
  the old strings (6 node:test failures in watcher-core and home-binding, 2 bun:test
  failures in reconcile-missing-binary).
- Linux tests in `watcher-core.test.ts` (`recipe-tmux`, `service`) keep the old
  words, which pins Mac and Linux.
- `tsc --noEmit` clean. The three changed test files pass (watcher-core and
  home-binding under node:test, reconcile-missing-binary under bun:test), and the
  whole bun:test family passes (375 tests).
- The full node:test family is NOT green on this machine, on main or on this
  branch: the same 39 tests fail on both, none only on the branch. All are the
  browser host, runtime folder and real Chromium files, and fail with
  `unsafe_profile: another account can write to the browser profile folder`
  (a Windows ACL on this computer's E: drive, read by a WSL driven node.exe).
  Compared by exporting `origin/main` (f780cf1) to a scratch folder, running the
  same 10 files under heavy, and diffing the failing names. CI is the clean
  proof for those files.
