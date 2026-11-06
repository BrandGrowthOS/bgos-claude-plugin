# Watcher checkup job

An owner Check up observes exactly one agent. `op: "reconcile"` with `intent: "checkup"`, and `op: "checkup"`, use this job. Empty, multiple-agent and malformed target lists are refused. Duplicate references to the same valid agent remain accepted.

```json
{
  "op": "reconcile",
  "intent": "checkup",
  "targets": [{ "assistantId": 42, "pairingId": 7 }]
}
```

Checkup only observes and reports. It never starts, restarts, kickstarts, kills or takes over a daemon, launcher, tmux server or OS unit, including when every observed process is stopped. Stopped, idle, busy, unresponsive and unclear targets with findings receive an owner report and Restart now or the relevant owner action. Named launch failures and agents needing a first launch also receive Restart now guidance. Login and usage-limit reports retain their specific owner instructions.

Only the owner's separate Restart now action enqueues the existing `restart_only` job. That job's planner, executor, restart ladder, launchers and verification are unchanged. Checkup does not invoke that job, write restart markers or probes, spend recovery budgets, stage plugin updates, replace credentials or press keys on usage-limit screens. Independent keep-alive sweeps are outside this job and unchanged.

Process observations still inspect recorded daemon, launcher, pairing-lock and keepalive PIDs, command lines and working directories, including subfolders. Unreadable process information is reported as `process_unknown`. These observations are snapshots: a new unrecorded process can appear during an asynchronous query or report. No observation grants checkup launch authority, so those races cannot cause checkup to start a competing launcher or stop an incumbent.

## Pairing status

Only a target credential for the watcher's backend is probed, via `POST integrations/session`. Only `401` with `code: "pairing_revoked"` proves revocation. Redirects are refused and successful session grants are discarded. Checkup reports revocation without replacing credentials. Legacy `pairingRepair` payloads cannot authorize credential repair or a launch from checkup. Pairing is performed through the existing separate owner workflow.

## Reporting and verification

Progress carries findings, report actions and step state. A transient delivery failure is retried once; undeliverable progress fails the job. Secrets and local identity are scrubbed from human-readable `message`, `detail` and `fix` fields while protocol identifiers remain intact. Notification metadata is unchanged.

Tests use an in-memory filesystem, fake clock and fake backend, with a sentinel rejecting real process operations. Every command runner is stubbed in the cross-platform matrix: systemd, launchd, Windows tasks, tmux, script and hidden recipe launches across stopped, idle, busy, unresponsive and unclear states. The matrix requires zero mutating commands and no agent-file changes. Race tests create an unrecorded process during cwd queries and progress reporting. An integration test follows a checkup with the owner's `restart_only` job through the real planner, executor, restart and verification path.

The evidence covers plugin behavior, not production app button rendering or notification delivery. Local-only runs can set `RUN_TESTS_ALLOW_LOCAL_TMP=1` with a temp subfolder inside the checkout; removal is still required. `TSX_DISABLE_CACHE=1` prevents loader-cache leftovers. Test workers are capped at two. See `REPORT-CHECKUP4.md` for red-first, mutation, full-suite and typecheck results. Raw evidence remains in ignored `.checkup4/`; no raw machine paths or logs are published.
