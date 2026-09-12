# A declared restart authority must OWN the process, or a restart through it mutes the daemon

**Date:** 2026-09-12

**Context:** On 2026-09-11 a forced `update_now` across 21 pairings muted 9
daemons for 50 minutes. Each one acked, reported `draining` then `installing`
then `restarting`, entered drain mode, and then stayed alive, heartbeating, and
answering nothing. Nothing had killed them. Their restart authority resolved to
`service` (a launchd job under a bespoke `ai.bgos.session.<id>` label), and the
ladder spawned `launchctl kickstart -k` at it. That job's program is a
keepalive SCRIPT, which had started a detached tmux server (pid 798 on the dev
Mac, parent 1); the daemon lives under tmux, so the job's pid is nowhere in the
daemon's ancestry. The kickstart re-ran the script, whose singleton guard saw
the claude session alive and waited. The pre-flight in `lib/update-rpc.ts`
only ever refused `staged`.

**Gotcha / Pattern:**

Two different questions were being answered by one signal.

- Detection (`lib/service-supervision.mjs`, learning
  `restart-authority-detected-not-guessed`): which LOADED job names this
  agent? Answered from the job's own launch recipe, deliberately NOT from
  process ancestry, because tmux re-parents every agent away from its job.
  That remains right for detection: the job does exist and does re-run the
  recipe.
- Ownership (this fix): will a restart addressed to that job REPLACE THIS
  PROCESS? Only if the job's main pid is an ancestor of ours. A kickstart at a
  job that does not hold us re-runs a script and kills nothing.

The tmux fact that makes ancestry useless for detection is the very fact that
makes it decisive for ownership. Trusting `kind === 'service'` alone conflated
them, and the daemon reported a restart that could not happen. Because
`restarting` is the one outcome that keeps drain mode ON (by design: no new
work between now and the restart), a restart that never arrives is a mute with
no expiry.

**How to apply next time:**

- Before draining or pulling, read this process's pid ancestry (`ps -o ppid=`
  walked to 1) and the job's main pid (`launchctl print gui/<uid>/<label>`,
  the `pid = N` line; `systemctl --user show -p MainPID <unit>`), and refuse a
  job whose pid is not an ancestor: `no_restart_authority`, with the handle
  and both pids in the log. `serviceOwnsProcess` / `probeServiceOwnership` in
  `lib/update-readiness.ts`; the handler decides and logs.
- Never let the "keeps the drain on" outcome be unbounded. Three minutes after
  `restarting` on either rung, if the process is still running, lift the
  drain, report `error restart_did_not_arrive`, heartbeat. A real restart
  kills the timer with the process, so the watchdog costs nothing when the
  mechanism works.
- Fail closed on every non-answer: a job with no pid (not running), an
  unreadable ancestry, pid 1, an unsafe handle, no uid for the launchd gui
  domain. A wrong "no" costs one click; a wrong "yes" is the outage above.
- The heartbeat's `updateReadiness.supervised` still reports `launchd` for an
  unowned job (detection is unchanged), so the app still offers the button;
  the click now fails in under a second instead of muting for an hour. Making
  readiness ownership-aware is the follow-up.

**Regression guard:** `test/update-rpc.test.ts` (`restart authority ownership`
and `the un-drain watchdog` blocks, plus the never-mute invariant), and
`test/update-readiness.test.ts` (`service ownership` block: the
`serviceOwnsProcess` table with the live pids from the dev Mac, the three
parsers, the ancestry walk bounded and cycle-safe, the probe). Both seen red
first: a mutant that always owns fails 5 tests, a mutant that never arms the
watchdog fails 6.
