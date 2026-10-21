# Managed download terminal cleanup proof

Current sources are normalized to LF. The final 80 tests and `tsc --noEmit` were rerun on those exact LF bytes. Native and mutation receipts preserve their historical CRLF source hashes; the JSON includes both sets and verifies all eight files equal the prior Git-normalized content. A coherent committed Chromium 156 image with actual HOAI download release remains required.

The cancellation repair is qualified separately from the historical download foundation and runtime-hook commits. Exactly one original native terminal read, cancellation and verified absence now share one original real and monotonic grace budget. A failed stream never uses Playwright's success-only delete operation.

Actual Chromium 153 exposed two distinct issues. First, `download.delete()` rejected `canceled` even after native files were absent. Second, immediate cancellation acknowledgement could precede removal of the original partial file. A read-only diagnostic observed native unlink 5 ms later before the manager could request stop. Both failed runs and their positive disposable-container removal receipts are preserved. The fix waits only for verified original-path absence within the existing <=2s budget. It never unlinks, adopts another path or retries delete.

Directory identity is rechecked on every absence pass. Any extant GUID final or partial path must be a regular, single-link file belonging to the exact native UID and retain its observed inode. An oversized file can be observed only for cleanup. Invalid terminal results, replaced paths, permanent bytes or an unresolved operation trigger independent owned browser stop and retain uncertainty and physical capacity. A stop acknowledgement cannot substitute for the original pending work.

## Verification

The eight exact touched paths listed in the JSON receipt passed 80 tests, zero skips. The full plugin `tsc --noEmit` completed 0. Ten isolated terminal tests cover delayed native unlink, both leftover paths, invalid/rejected terminal values, one original terminal read, held cancellation and terminal work, retained filesystem reads after the wall deadline, immutable original grace, path owner/link/type/inode checks and replacement directory refusal. Existing runtime and Companion movement/cleanup tests remain green.

The Windows unit fixture projects a Linux UID/mode over real temporary files. Its single fake native file owner serializes stop/cancel/delete removals. A diagnostic traced an intermittent fixture failure to concurrent Windows `unlink` returning `EPERM`; errors are still propagated. No product cleanup error was suppressed.

Seventeen executable-copy mutations each printed a changed production line, produced an actual assertion failure with exit 1, restored exact bytes and reran the same selected test green 0. They break one original terminal read, valid terminal evidence, failed-stream delete handling, each original GUID absence, positive absence, stable inode, UID, single link, regular type, symlink refusal, the original grace budget, independent wall stop, cancellation/terminal grace lifetime, awaited cancellation and original directory proof. Raw changed lines and all red/green hashes are retained in `profile-download-repair-mutations/report.json` and `run.txt`. Shared source bytes remained unchanged.

A guard-only no-reset trial survived because the independent original wall timer still enforced the budget. It is excluded. The final mutation explicitly clears that original timer and restarts the budget; the selected original-budget assertion fails, then passes after exact restoration. No parse failure, timeout or intermittent fixture error is counted as mutation proof.

## Actual native acceptance

The committed probe runs actual managed Runtime, Engine and quarantine on a nonroot Linux agent container, with default Chromium sandbox, private debugging pipe, exact 0700 directory and network:none. It uses synthetic exact authority, explicit fixture clicks and literal loopback HTTP. The container drops all capabilities except `SYS_CHROOT` and uses the already reviewed Playwright seccomp profile.

| Browser | Completed | Slow | Overflow | Cleanup |
| --- | --- | --- | --- | --- |
| Chromium 153.0.8010.12 |7936 bytes, exact hash, one opaque artifact | Deadline cancellation,0 accepted |0 accepted | All 3 original/later process groups empty, raw directories absent, physical 0, no uncertainty |
| Chromium 156.0.8078.4 |7936 bytes, exact hash, one opaque artifact | Deadline cancellation,0 accepted |0 accepted | All 3 original/later process groups empty, raw directories absent, physical 0, no uncertainty |

The content hash is `b63398023edb9682673e2410370d4d648360ee54ff79ccc4ee95e420e05e3cbf`. Each mode observed one actual Engine download event and 11 original browser group members. Both containers exited 0 and were positively absent from successful Docker inventory after normal removal, with no forced stop. The 153 image preserves the prior runtime-hook bytes; the 156 image layers only the exact reviewed manager and probe onto the separate security candidate. Both image identities and source hashes are recorded in the JSON receipt.

Probe deadlines are explicitly 150 ms for slow and 10000 ms otherwise, with 5 ms observations. Production 120 s/100 ms defaults and <=2s cleanup grace are unchanged. Overflow scheduled 26411008 server bytes before native stream closure; this demonstrates the stated transient overshoot boundary and is not a measured maximum disk quota. Quarantine is private plaintext and crash orphans remain outside restarted in-memory accounting.

This receipt does not claim HOAI relay transport, recipient consent, cross-machine ordinary download release, real account use, production changes or a final combined committed runtime tuple. Those require their own composed acceptance. The JSON companion records exact working and Git-normalized source hashes, raw receipt hashes and each direct mutation.
