# Notes: the watcher frees an agent stuck on the usage limit screen

Branch `feat/watcher-frees-limit-stuck`, based on `feat/agent-checkup-watcher` (#273, P3, stacked on #272 P2).
Kc asked for it 2026-11-01 (chat 4465, message 180081). Kc's word changes Data's ruling in #273 that C9 is
"report only": the watcher may now press ONE Enter on the limit screen, only once usage is back.

## 1. What the stuck state is (root cause, measured)

Claude Code 2.1.316, the same build in `~/.local/bin/claude` (Linux) and `C:\Users\karim\.local\bin\claude.exe`
(both carry `// Version: 2.1.316` and the strings below). Read from the CLI's bundled JS, never run against a
real session.

When a claude.ai usage limit rejects a turn (HTTP 429), the CLI:

1. writes a synthetic assistant record into the transcript: `isApiErrorMessage: true`, `error: "rate_limit"`,
   `apiError: "usage_limit_reached"`, model `<synthetic>`, text `You've hit your weekly limit · resets Nov 6, 8pm
   (Asia/Dubai)`, and, machine readable, `apiErrorParams.rate_limit_info.resetsAt` (Unix seconds) plus
   `quotaLimits.resetsAt`;
2. AUTO OPENS the rate limit options dialog (the `/rate-limit-options` command, flag
   `shouldAutoOpenRateLimitOptionsMenu`). It is a modal PICKER, not an idle prompt.

The screen while it is open (the option list depends on the plan; the default order is shown):

```
  ⎿  You've hit your weekly limit · resets Nov 6, 8pm (Asia/Dubai)

╭──────────────────────────────────────────────────╮
│ What do you want to do?                          │
│                                                  │
│ ❯ 1. Stop and wait for limit to reset            │
│   2. Wait here, then continue automatically at … │
│   3. Add funds to continue with usage credits    │
│                                                  │
│ Enter to confirm · Esc to cancel                 │
╰──────────────────────────────────────────────────╯
```

The pointer is `❯` (U+276F), or `>` on a console without that glyph (the bundled figures fallback). Footer
chords are the same `Enter to confirm` / `Esc to cancel` parts `lib/gate-block.tcl` measured on the startup gates.

While the picker is up the REPL does not take its queued input: every channel message and task notification is
ENQUEUED and none is dequeued. Typed text goes to the picker, which is why `/login` "no longer works" once the
limit is hit. ONE Enter selects the highlighted default, `Stop and wait for limit to reset` (value `cancel`),
which closes the picker with no transcript output (`display: "skip"`), and the queue drains at once.

Why a blind Enter is NOT safe: behind the flag `tengu_jade_anvil_4` the order flips to
`[Add funds or Switch to usage credits, Upgrade your plan, Stop and wait, ...]`, and Enter would start a purchase
or upgrade flow. So the key is derived from the screen, as gate-block.tcl does: Enter only when the pointer
sits on `Stop and wait for limit to reset`.

### Evidence (Ares, agent 1040, transcript d84590f1, read for structure only)

| Time (UTC, 2026-11-01) | Record |
|---|---|
| 16:39:03 | assistant, `error: rate_limit`, 429, `rate_limit_info.resetsAt 1793980800` (= 2026-11-06T16:00Z = "Nov 6, 8pm Dubai"), `rateLimitType seven_day` |
| 16:47 to 20:00 | 29 `queue-operation enqueue` (channel messages, wakes, a liveness probe), ZERO dequeue, no api-request |
| 16:53:14 | the Windows `.credentials.json` mtime (stat only, never opened): the account swap |
| 20:02:28 | 29 `queue-operation dequeue` in the same second (Kc's Enter), then the turn runs at 20:03 |

Ares's daemon log, same window:
- 16:39:21 `Resting self-report sent (resetAt=2026-11-01T17:09:21Z)`: lib/resting.ts did not parse the dated
  weekly reset and used its 30 min fallback; at 17:09:21 it said the account was `ok` again. Wrong, and
  unrelated to the key; reported, not fixed here.
- 17:16:51 `WARN deaf session confirmed ... posting launch guidance into the owner's chat 4465`: the deaf ladder
  told the owner to relaunch, a wrong diagnosis for a picker. Reported, not fixed here.

With this change the watcher would have pressed at the first sweep after 16:53:14 (the login changed after the
limit), about 3 h 9 min earlier than the manual Enter.

## 2. How the watcher sees the screen and sends one key

| Platform | Agent runs in | Read | One Enter |
|---|---|---|---|
| Windows | hidden console of `hoai-core --keep-alive` (task "HOAI Agent <id> home-<hid>"); its pid is in `~/.bgos-agent/<id>/supervisor.json` | `bin/win32-limit-screen.ps1 -Mode read`: AttachConsole, ReadConsoleOutputCharacterW (the viewer's way) | the same helper `-Mode press -ExpectHash <sha256>`: re-reads, presses VK_RETURN ONCE only if the screen hash is unchanged (WriteConsoleInputW, the dev channels helper's way) |
| macOS, Linux with tmux | `tmux -L hoai-<id>-home-<hid>` session of the same name (bin/bgos-agent) | `tmux -L <s> capture-pane -p -t =<s>:` | re-capture, must equal the approved text, then `tmux -L <s> send-keys -t =<s>: Enter` (a key name, never `-l`, never text) |
| macOS, Linux without tmux | expect holds the PTY (`expect eof`, stdin /dev/null) | cannot | cannot: nothing outside expect can type into its PTY (TIOCSTI is off on current kernels). The owner is told the one tap fix instead: Restart now, or Enter in the window |
| a person's own terminal (no supervisor) | not ours | not read | not pressed |

## 3. Design

Usage is "back" only by one of two proofs, never a guess:
- `reset_passed`: now is at least 1 min past `rate_limit_info.resetsAt` from the transcript record;
- `login_changed`: the Claude credential file (`<config dir>/.credentials.json`) has an mtime after the limit
  record. Stat only, never opened, never hashed. macOS keeps the login in the Keychain, so there only the reset
  time counts. A token refresh by another agent on the same login also moves the mtime: that costs at most one
  Enter per hour, and the verify then sees Claude refuse again and says so.

Then, and only then, the screen is read; it must show ALL of: the `You've hit your ... limit` line, then the
`What do you want to do?` title, then the `Stop and wait for limit to reset` option carrying the ONLY pointer
in the dialog, then the `Enter to confirm` footer. Anything else is "unclear": no key, the owner is told.

At most one Enter per hour per agent, written to `~/.bgos-agent/watcher/limit-watch.json` BEFORE the key, shared
by the sweep pass and the checkup. Never /login, never text, never Esc, never a second key.

Verify: re-read the screen (the picker must be gone), then watch the transcript for a real turn after the Enter
(freed) or a new `rate_limit` record (Claude still refuses).

Tell the owner: the watcher drops `~/.bgos-agent/<id>/limit-notice.json` (tokens and times only); the agent's
daemon reads it, builds the words from fixed templates, and posts them in the owner's chat as a connection
notice (the deaf warning's path), so the owner reads it in plain words.

## 4. What was built

| Piece | File | Role |
|---|---|---|
| Pure rules | `lib/limit-screen.mjs` | readLimitScreen, usageBackFrom, decideLimitFree (gates in order), the notice record and its fixed words. No imports. |
| Keys | `lib/limit-keys.mjs` | the key path per platform, the two tmux argv shapes, the helper's arguments, read and press-once. |
| Windows helper | `bin/win32-limit-screen.ps1` | read (visible rows + sha256) and press (one VK_RETURN down/up, only if the hash is unchanged, else exit 7). ASCII only. |
| The pass | `lib/watcher-limit.mjs` | runLimitPass after each keep-alive sweep (switch ON, cleared ids only); freeLimitFor shared with the checkup; the hour record; the notice file. |
| Loop | `lib/watcher-core.mjs` | `freeLimits()` between `sweep()` and `showWindows()`; the checkup observes `limitFree` and runs `free_limit`. |
| Classifier | `lib/agent-checkup.mjs` | C9 fixable only with usage back and a key path; `free_limit` planned or held `one_enter_per_hour`; no key path names Restart now; C9 still blocks restarts. |
| Transcript | `lib/watcher-checkup.mjs` | `resetsAtMs` from `rate_limit_info.resetsAt` (else `quotaLimits.resetsAt`); a limit with a known reset stays an error until an hour past it. |
| Daemon | `lib/limit-notice.ts`, `server.ts` | every 3 s: read, refuse junk whole, post the fixed words to the owner's own chat (deafNoticeChat), retry a failed post once a minute. |

Outcomes the pass logs: none, limited, waiting, cannot_press (no_tmux, no_console, screen_unreadable,
selection_elsewhere, screen_unclear, unsupported), no_picker (the limit line at an idle prompt: nothing is
held by a key, nothing said), not_pressed (the screen changed between read and press), freed, closed,
still_limited, not_taken.

## 5. Verification

- Red first: 5feba0c (the tests alone, each failing for a missing module or behaviour).
- `test/limit-screen.test.ts` 29, `test/watcher-limit.test.ts` 18, `test/limit-notice.test.ts` 8,
  `test/agent-checkup.test.ts` 74 (8 new), `test/watcher-checkup.test.ts` (4 new), all green.
- `test/win32-limit-screen.console.test.ts` 5, RUN for real on this Windows box (not skipped): the real
  helper attached to a hidden console holding a fake picker program; `read` returned text that passes
  readLimitScreen for both the `❯` and the `>` pointer; `press` with that hash delivered exactly one byte,
  `0d`; a wrong hash, a bad pid, an unknown mode, a bad hash and a missing hash delivered nothing.
- `npm run build` (tsc --noEmit) clean.

## 6. Adjacent findings (reported, not fixed here)

1. `lib/resting.ts` did not parse the dated weekly reset ("resets Nov 6, 8pm (Asia/Dubai)") and fell back to
   30 minutes: Ares's daemon said "resetAt 17:09Z" and at 17:09:21 called the account `ok`. The transcript
   record carries `rate_limit_info.resetsAt` in Unix seconds; resting.ts could read that instead of words.
2. The deaf ladder (server.ts) confirmed "deaf session" at 17:16:51 and posted launch guidance into chat
   4465: a wrong diagnosis for a picker. With this change the picker is freed or named; the ladder could
   also skip its escalation while the transcript ends in a fresh `rate_limit` record.
3. A token refresh by another agent on the same login also moves `.credentials.json`. Cost: at most one
   Enter per hour on a still limited agent, the verify then sees Claude refuse again, and "still limited" is
   told once per reset time, not once per Enter.
4. macOS keeps the login in the Keychain: only the reset time proves usage is back there, so a mid week
   account switch on a Mac is not seen (the owner can still tap Restart now, or press Enter).
5. Whether the composer stays painted under the picker could not be confirmed from the minified bundle;
   the rules count pointers only between the dialog's title and its footer, so a `>` in the composer
   below the footer cannot be taken for the selection.
6. Esc also closes the picker (its onCancel). The brief says Enter, and Enter on the read default is what
   was measured (Kc's own fix), so only Enter is sent.
