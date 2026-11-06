# Watcher checkup job

An owner Check up observes exactly one agent. `op: "reconcile"` with `intent: "checkup"`, and `op: "checkup"`, use this job. Empty, multiple-agent and malformed target lists are refused. Duplicate references to the same valid agent remain accepted.

```json
{
  "op": "reconcile",
  "intent": "checkup",
  "targets": [{ "assistantId": 42, "pairingId": 7 }]
}
```

The checkup never restarts a live process. Idle sessions, busy sessions, unresponsive daemons, live launchers and background processes receive an owner report with Restart now. Unreadable process information is reported as `process_unknown` with the same owner action. Stale heartbeats do not prove that a process stopped: recorded daemon, launcher, pairing-lock and keepalive PIDs are checked for liveness too. Process command lines and working directories, including subfolders, can establish that the target is alive. An unreadable working directory of a live process prevents automatic recovery.

Automatic recovery only starts a target with no remaining process and a supervisor or launch recipe. After progress and any confirmed pairing work, the watcher takes two complete absence observations at least 500 ms apart and checks inventory identity again. The shared recovery budget allows one attempt per 30 minutes and three attempts per target; it must be saved before the start. Boot-hello verification and the terminal report stay inside the pass deadline.

The start path cannot write restart markers or signal processes. It uses `systemctl --user start`, `launchctl kickstart` without `-k`, an owned Windows task's Run action, or a launch recipe. An incumbent appearing after confirmation cannot be stopped by these commands. Checkup no longer stages plugin updates, executes file repairs, evaluates idle/busy restart gates or presses keys on usage-limit screens. Stale plugins, stuck updates, login failures, usage limits and named launch failures are reported to the owner.

## Revoked pairing

Only a target credential for the watcher's backend is probed, via `POST integrations/session`. Only `401` with `code: "pairing_revoked"` proves revocation. Redirects are refused and successful session grants are discarded. Ordinary Check up reports revocation without replacing credentials.

An authenticated job may explicitly authorize credential repair for the matching on-disk pairing:

```json
{
  "op": "reconcile",
  "intent": "checkup",
  "targets": [{ "assistantId": 42, "pairingId": 7 }],
  "pairingRepair": {
    "confirmed": true,
    "assistantId": 42,
    "pairingId": 7,
    "pairCode": "EXAMPLE-CODE"
  }
}
```

The credential snapshot and folder pin are checked before the existing pairing CLI runs with `--assistant-id` and `--no-install-cli`. Changed credentials for the same agent and backend, plus a verified folder pin, are required for success. Confirmation never authorizes a live restart. A live target receives Restart now after credential repair; a stopped target still requires both absence checks and the recovery budget. Producing this confirmation is the backend and app's responsibility.

## Reporting and verification

Progress carries findings, completed actions and step state. A transient delivery failure is retried once; undeliverable progress stops the job before its next repair. Secrets and local identity are scrubbed from human-readable `message`, `detail` and `fix` fields while protocol identifiers remain intact. Pairing output is never forwarded. Notification metadata is unchanged.

Tests use an in-memory filesystem, fake clock and fake backend, with a sentinel rejecting real process operations. They cover live and unclear targets, stopped recovery, changes between the absence checks, start-only platform commands, shared budgets, pairing confirmation and report scrubbing. These checks do not prove a production app confirmation or owner-chat delivery flow. Local-only runs can set `RUN_TESTS_ALLOW_LOCAL_TMP=1` with a temp subfolder inside the checkout; removal is still required. `TSX_DISABLE_CACHE=1` prevents loader-cache leftovers.

Validation: 9,902 passed, 53 skipped across 459 files; typecheck, 229 focused tests and all nine mutation checks passed. Test workers were capped at two. Raw evidence stays in the ignored local `.checkup3/` folder; a regression test enforces no tracked `docs/evidence/` files.
