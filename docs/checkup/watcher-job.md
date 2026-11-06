# Watcher checkup job

The watcher already received checkup jobs on main before this change. [PR #272](https://github.com/BrandGrowthOS/bgos-claude-plugin/pull/272) supplied the pure classifier and planner. [PR #273](https://github.com/BrandGrowthOS/bgos-claude-plugin/pull/273) was closed after integration, rather than rejected: its [closure comment](https://github.com/BrandGrowthOS/bgos-claude-plugin/pull/273#issuecomment-6609660594) explains that its head was already on main. Head `f486e817` is an ancestor of integration commit `824d83c` (merge #297) and this checkout's base `d5ea580`. The integration also brought the later usage-limit repairs, which this change preserves.

An ordinary owner Check up asks for one agent:

```json
{
  "op": "reconcile",
  "intent": "checkup",
  "targets": [{ "assistantId": 42, "pairingId": 7 }]
}
```

`op: "checkup"` is accepted too. Empty, multiple-agent and malformed target lists are refused. Duplicate references to the same valid agent remain accepted. A checkup never falls through to machine-wide reconcile.

The watcher observes the target, calls `checkupPass`, runs its planned repairs and sends step progress plus findings and actions to the machine-RPC progress endpoint. Stopped-daemon and stale-plugin repairs retain the existing safety table, restart ladder and shared restart budget. After file work and progress, the watcher refreshes the inventory row and observes safety for that row. It verifies the process identity again after the observation; a changed target holds the restart without spending its budget. Restart and boot verification use the refreshed row. A failed or unrecorded restart budget prevents the act. A thrown file repair is reported as a failed step and holds its dependent reload.

## Revoked pairing and confirmation

The watcher probes only the target's per-agent credential, only against the same backend as its own reporting credential. It uses `POST integrations/session`, whose existing contract distinguishes `401` with `code: "pairing_revoked"` from session expiry. A successful session grant is discarded, including its token. Redirects are refused. Permission errors, expiry and outages do not prove revocation.

An explicit revocation adds finding `pairing_revoked` (C10). An ordinary checkup reports it with instructions for the owner and holds restarts. It does not infer permission to replace a pairing from the Check up click.

After the owner confirms replacing this pairing and supplies a fresh pair code, the authenticated backend job can carry this optional extension (all values below are synthetic):

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

The confirmation must be a boolean true and match the target and the pairing currently stored on disk. The credential snapshot and pinned folder are checked again before the command. Re-pairing uses the existing pairing CLI with `--assistant-id` and `--no-install-cli`, in that agent's folder with its credential path explicitly selected. The watcher never writes replacement credentials itself. A changed credential for the same agent and backend, and a verified folder pin, are required before the repair counts as successful. Command failure, timeout, changed identity or unverified output holds the reload. A successful pairing repair still cannot bypass the restart safety table or budget.

This repository implements the watcher consumer. Producing and forwarding this optional confirmation is a backend and app responsibility outside this repository. Backends that omit or strip it remain report-only for revoked pairings. No backend, app or production service was changed here.

## Reporting and privacy

Progress includes completed actions as well as step state, so the owner can follow the repair. A transient progress failure is retried once within a bounded request budget. A progress step that cannot be delivered stops the job before its next repair. If reporting remains unavailable, delivery cannot be guaranteed; the watcher records a failed job rather than claiming success.

Pair codes, original and replacement credentials, home paths and usernames are scrubbed from report strings. Pairing stdout, stderr and exception text are never forwarded. No new channel notifications or notification metadata are introduced. The existing all-string notification metadata contract remains covered by the plugin suite.

## Verification

The checkup tests run the real watcher loop, classifier, restart ladder and boot-hello verification against an in-memory filesystem, fake clock and fake backend. The real-OS sentinel prevents those tests from listing, signalling or starting actual agents. They prove the plugin-side progress contract, including terminal report delivery and retry against the fake backend. They do not prove a live app confirmation flow or production owner-chat delivery.

The repository test runner supports `RUN_TESTS_WORKERS=2`. The cap also applies when a test requests a larger nested pool. Default maximum concurrency remains four for callers that do not supply a smaller cap.

The restart-target review regressions were red before the fix, then all 188 classifier, inventory, restart and watcher tests passed with two workers. Raw checkup evidence is retained locally, outside the shipped plugin files.
