# Market3 review resolution

Base: `a160ffea86d755500277e053fa1a657c4c4c505f` on `fix/daemon-attach-scope-impl`.

Read `~/.bgos-reviews/market2.md` in full. It contains one open P1 and no new P2. This round addresses that P1 only and preserves the previously closed forecast and diagnostics findings.

## P1: resolve identity after marketplace configuration

The launcher previously inferred agent 41 from legacy credentials before Claude applied `user_config.assistant_id=42`. The daemon correctly selected `credentials-42.json`, then rejected the launch because its scope still named 41.

Removed the unpinned credential-to-scope guess from `bin/hoai-core.mjs`. A launch with no explicit identity now clears inherited numeric scope and hands over the existing launch-folder marker. `lib/attach-scope.mjs` recognizes that marker only for the current, nonempty folder, after checking the resolved identity and wrong-agent folder pin. The daemon resolves identity using its effective configuration. Explicit folder, environment, and supervisor identities retain numeric scope.

The wrong-agent guard remains: mismatched numeric scopes and folder pins still refuse. A folder-only marker inherited into another folder remains unscoped. No new configuration key, credential resolver, or backend change was added.

## Test-first evidence

The regression was written and run before the production fix. [The red log](docs/evidence/2026-11-03-market3/red-manifest-identity.log) shows the launcher naming legacy agent 41, followed by a dormant daemon and a failing assertion that `reply` is exposed. Exit 1, one behavioral failure.

The test calls the real launcher entry point, expands `mcpServers.bgos.env` from the actual `.claude-plugin/plugin.json` between launcher and daemon, boots the real daemon, and reads its MCP tools. Its fixture has legacy agent 41, sole numbered agent 42, no folder pin or launcher identity, and configured marketplace identity 42. The fixed test verifies `reply`, agent 42, the `env-assistant` route, and a subsequent dormant boot for explicit scope 41.

All four earlier launcher layouts now apply the real manifest environment too. They retain their agent, credential-route, and `reply` assertions. The no-home layouts still prove explicit launch intent admits the daemon without home evidence.

[Additional red evidence](docs/evidence/2026-11-03-market3/red-launch-intent.log) records three failing contract checks before the fix. The folder-only intent test also checks a different folder, missing marker, missing current folder, mismatched numeric scope, and wrong folder pin.

## Verification

- Baseline: 76 passed, 0 failed, 0 skipped.
- Affected scope and marketplace suites: 78 passed, 0 failed, 0 skipped.
- Full `npm test`: 8,237 passed, 52 skipped, 0 failed, exit 0. This includes 7,852 Node tests, 11 Chromium tests, and 374 Bun tests.
- `npm run build`: passed, exit 0.
- `git diff --check`: passed.
- A separate read-only code review found no actionable issues.

Commands and logs are in [the evidence directory](docs/evidence/2026-11-03-market3/README.md). All test runs use at most four workers. Existing dependencies were used; test runs set TMPDIR to `.test-tmp` inside this checkout.

The test substitutes only the external Claude process. It applies the repository's real manifest but does not run a live Claude service or production backend. All changes remain on the requested local branch; nothing was pushed or deployed. `REPORT.md` was not modified.
