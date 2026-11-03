# The Windows tests on the update chain

Lane winpath, board row 8946f0b1. Branch fix/idle-agent-loads-staged-update (#291); #300 is stacked on it.

## The two email failures

Cause: #291 held an older #296 head (a0d5426) without 70b9325, "fix: resolve Windows home aliases in outbound
file checks".

- The same two tests failed on every Windows run holding a0319a8, b2b9e7c or a0d5426 without 70b9325: 41251239207,
  41286330405, 41294335796, 41299037606, 41429313766, 41431071556, 41488354116, 41400416620, 41498314780.
- a0d5426 red (41294335796) to 70b9325 green (41358828632) is a one commit A/B touching only those two files.
- 70b9325 was the only #296 commit #291 lacked. Taken with a merge (076d252). After it, both email files are
  identical to 70b9325.

## The download failure

A real bug, not a flake. It is on main too.

- Failed on Windows runs at c819c0f (41498314780), 0c46817 (41299037606) and fec0dc8 (40628933756, an unrelated
  branch). Not on main (last 200 runs) and not on #298 (41382829101).
- Playwright builds the reply once, after a fixed 500 ms settle. A download Chrome raised later was past the window
  of that call and of the next one, so no reply ever named it.
- Reproduced on real Chromium on Linux by holding the host's download event back 1500 ms: the same assertion and
  reply text as CI. With the fix the same run passes, told in the next reply.
- Why Chrome lags on Windows is not proven. The Chromium test logs where the line was told, so CI records how often.
- A slow site was my first theory, and it is false: with a 3 s server delay the click's own reply still named it.

What the agent now gets: the reply to its next browser action names the download, once. A download that may be the
owner's is left to status: one raised while the owner holds the browser, or after that and before the next action of
the agent's that really runs. Playwright does not say who started a download, so this rule comes from the fact that the agent starts one
only by acting. No time window is used, because nobody knows how late Chrome can be.

Limits:

- One the agent started just before the owner took over is left to status.
- An owner's file whose event lands after the agent has run another action, a read-only one too, is still named.
- Only the `### Download` line is covered. `_parkedResult` prints an open ask's summary (`gate_parked: Another
  permission request is already waiting for the owner (download medical-private.pdf ...`), and
  `hoai_browser_wait_gate` on that id names the file. A reviewer ran this with two late owner files and a gated
  navigation, after the 90 s wait ran out. The code is on main unchanged, so it is older than this lane, and it is left
  for a decision of its own.
- A session that closes first takes the line with it. Status still lists the file.

Fresh reviews caught problems in my own fix three times: it pushed owner downloads into the agent's replies (fixed in
81abb37); that fix missed downloads refused at the start and events landing after the hand-back (f735c23); and that
one cleared its flag where the call arrives rather than where the action runs, so a refused call named an owner's file
and a click held at the gate lost the agent's own line (fixed after it).

## The Linux failures this lane found

The goal was a green suite on Linux. On `/mnt/e` (9p, through WSL2) it was not green, for two separate reasons.

Slow filesystem: 13 failures and 1 cancelled at 81abb37, 10 and 1 at 6125a4c, mostly `spawnSync ETIMEDOUT`, `no
browser host connected` and time budgets. All of those passed on the same trees checked out on native ext4. Run this
suite from a native Linux path, as CI does. `npm ci` alone took 23 s against 3 s.

File clock (private turn tests): the rules compare a marker's mtime with a `Date.now()` reading (`entry.at <
writtenAt`, `verifiedAt > at`). Linux stamps an mtime from the kernel's coarse clock: on WSL2 ext4 at HZ 250, a file
written after a reading was not later than it in 2996 of 3000 tries, and 9p was 0 of 3000. The markers live under
`os.tmpdir()`, which is ext4 even when the tree is on `/mnt/e`. The harness spun a fixed 2 ms.

- Same tests with one tick of wait before the Stop: 27 of 30 failures became 0 of 30.
- Old head c819c0f, three files repeated: 22 failures of 1840. With `test/helpers/settle.ts`: 0 of 1840.
- The diff from c819c0f to 81abb37 for those files is empty and the rule has been on main since 2026-10-16, so this
  was not caused by this lane. Why CI's Linux job does not hit it is not established.

The product rule and the assertions are unchanged. A mutation by a reviewer showed the "not later" direction of
`entry.at < writtenAt` has no test that pins it, on either harness. That predates this lane and is left open.

## Left alone, on purpose

`review round 7` in `test/email-outbound-files.test.ts` fails now and then under load, on 3 of the 8 native full
runs of this lane (101, 108 and 117 ms on `digits.csv`, limit 100), including the last run of #300's head, b14e0a7.
That run's other tests all passed, and #291's last run was fully green. The stall is real: 40 to 59 ms alone, 68 to 310 ms with 24 CPU
spinners on 32 CPUs, where 1 run in 6 failed. Sustained load beats the test's median of three, which assumes noise
comes once. The step on the main thread was not identified. The limit is #296's decision, and raising it would be a
blind fix.

## Open

The first Chromium test takes 22 to 40 s on five #291 lineage runs against about 8 s elsewhere, and two of the three
download failures landed on those. But 6215119 and c819c0f have the same tree (667d9313e1) and the same image, at 8 s
and 28 s. So it is not simply the code, and no cause is claimed. A process listing before the Chromium family would
be the next step.

## Proof limits

Local Chromium was build 1148 (131), not the pinned 1248. `expect` is not installed locally, so those tests skip
here. Windows proof comes only from the plugin's CI job.
