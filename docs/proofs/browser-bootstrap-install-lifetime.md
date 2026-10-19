# Browser bootstrap installer physical lifetime proof

The repair retains installer ownership through actual physical completion, even after a caller times out or the Host stops. It prevents a newly extracted executable, dead owner PID, malformed/replaced recovery marker or reentrant logger from admitting overlapping work. Source commit is `8d499c244ea2233c855eab9bcb06e78809934d82`, parent `e9db85361fd6dec6bc05c2fa5800b2167645722a`; all seven current source pins match its Git blobs. The executed archives used the seven overlays in the [JSON receipt](browser-bootstrap-install-lifetime.json). Current versus executed JSON bytes are distinguished below. A fresh package or full coordinator pass is not claimed here.

The normal trusted completion contract requires exact pinned Playwright source, original CLI exit0 and close0, both real output-pipe EOF and its installed marker. This is narrower than a general OS descendant-empty proof. After an installer starts, abnormal release is Linux-only and additionally requires original PID/start/session/group evidence, bounded inventory, strict kernel signal0 ESRCH and a fresh original-absence check. Unknown retains admission/recovery state; no effectful process signals or automatic dead-owner reclaim occur.

`Host.stop()` fences admission and awaits physical installer drain. Read-only `--check` reports nonzero recovery-required when a pending or unknown bundled marker is discovered, including when another Chrome is installed. With no marker/unknown, the ordinary unrelated-browser fast path remains available. Recovery does not delete a marker or retry automatically; an operator must first verify the original installer/downloader and pipes have ended.

## Accepted evidence

| Qualification | Actual result | Boundary |
| --- | --- | --- |
| Complete affected files | 66/66 pass, zero failures/skips/cancellations; noEmit0 | Whole bootstrap18, lifetime12 and Host36, including actual Chromium Host E2E; no name filter |
| Copied executable conditions | 20 direct ERR_ASSERTION reds and exact whole-file restores | Private loaded source copies; restored counts below |
| Linux CLI/grandchild | Five actual checks, known physical drain, original identities absent, marker removed | Synthetic bundle/CLI; not Playwright installation acceptance |
| Linux first use | Actual pinned CLI once, exit0/close0/both EOF, exact156 SHA, second call cache reuse | Fresh private HOME default cache; no browser launch or cache/executable override |
| Windows readiness | Actual Node `--check`, pending marker refusal and partial-cache handling | Pinned package with private synthetic cache files, never executed |

The affected-file proof completed in 77.775s. The real first-use proof completed in 16.788s and installed Chromium156 SHA `377a9fc07b495c3b8d0ab8ec1fdfd153641759f9756fea34d8dfce4de82f5025` into `/work/home/.cache/ms-playwright`. Its `findInstalled` fixture reports no existing candidate; the actual bundled resolver and CLI are used. A spawn observer delegates the unchanged native command/options and records its completion rather than manufacturing it. The second call returned the same executable without spawning another installer. Pending operations were zero, cleanupUnknown false and the HOAI recovery marker absent.

Both larger executions verified all 862 pinned archive inputs and seven live source files before/after. Each tar has 863 regular files: those 862 inputs plus the input-pins metadata JSON. The two guidance edits were excluded from these archives. Original Docker and SSH processes closed0, each container was positively absent, and neither execution forced a stop. The private c5 image supplies existing OS/dependency prerequisites; this is not a fresh zero-setup OS claim. Immutable preparation manifests retain their original PREPARED ONLY label; separate completed receipts prove execution.

Commit preflight subsequently normalized only `lib/browser-bootstrap.pin.json` from CRLF SHA `19fa11a3b51096a996e1a082ad18d09d838536135db71963e7f427f42dfe1f2e` to LF SHA `21057fbfe0993ccace1bc9f5ff977039af41cd9b790c6eed473dd58a73cb13ae`. The exact executed original is preserved privately; all earlier receipts and archives remain unchanged. The transformation replaces only its 13 CRLF sequences, parsed JSON is identical, and the other six files are byte-identical. After normalization, both whole bootstrap/lifetime files passed all 30 cases, zero failures/skips/cancellations, and an actual default `bundledChromium()` source/provenance read exited0 without installer or browser execution. This whitespace check is not a behavioral mutation or a relabeling of the original 66-case/cold-installer proofs.

## Copied executable drills

Each row records the original executable condition, the exact loaded replacement or deletion, the complete mutant SHA and direct assertion output, then restores exact source bytes. Some deletions leave a comment at the loaded replacement line; that comment is not described as an executed condition. The restored file scope is explicit:

| Omitted condition | Restored passing cases |
| --- | ---: |
| physical_retention | 12 |
| pipe_eof | 12 |
| dead_owner_marker | 18 |
| replacement_nonce | 18 |
| timeout_late_zero | 12 |
| nonlinux_unknown | 12 |
| new_executable_fastpath | 18 |
| pending_map | 18 |
| host_stop_wait | 2 |
| complete_marker | 18 |
| source_hash | 18 |
| original_close | 12 |
| kernel_group_absence | 12 |
| kernel_error_unknown | 12 |
| leader_reuse | 12 |
| deferred_publication | 18 |
| safe_nochild_release | 18 |
| cache_claim_interleaving | 18 |
| readonly_recovery | 18 |
| main_check_recovery | 1 |

The deferred-publication red has two failed selected cases: one literal ERR_ASSERTION plus a secondary unhandledRejection. Other counts must not be inferred from the number of literal assertion strings. The Host-stop copied restore selects the two installer cases; the separate 66-case gate executes its entire Host file. JSON retains all commands, changed lines, whole-file hashes and raw references. Both independent reviewers and root closed the source/raw matrix; no reviewer execution is implied.

For the concrete physical-retention drill, loaded line60 becomes `rejectResult(installRecoveryRequired()); resolvePhysical()`. It releases the physical promise on logical rejection, and the selected actual-module regression fails with a direct ERR_ASSERTION. Exact restoration then passes all 12 cases in the whole lifetime file. This executable example is separate from rows that remove a condition and leave a comment.

## Scope and retained failures

The actual synthetic CLI exits while its grandchild retains inherited pipes. Admission and the durable marker remained held after the logical deadline and after a browser file appeared. Only actual pipe EOF, close and positive original-group absence released physical work; the original logical refusal remained a refusal. This does not qualify Playwright normal-completion semantics, which are established separately by the actual pinned first-use run.

Windows/Darwin ordinary success is unit-qualified under the pinned trusted contract; this proof does not claim actual cold installation on those platforms or abnormal descendant termination there. It does not change enrollment, key-provider, profile encryption, engine or bridge behavior. Full coordinator/provider/custom Electron acceptance is outside this proof.

The first late0 mutation survived an insufficient predecessor fixture and is retained; the final test supplies genuine exit0/EOF/close0 and kills it. A prior copied collector timeout and predecessor typing error are excluded. The cache/marker pre-fix combined test stopped at its first cancellation assertion, so a separate pre-fix spawn-throw red is not claimed. Early overwritten collector output is not presented as retained evidence. Exact predecessor paths, complete raw SHA references and reproducible selected-file commands are in JSON.

## Reproduction

Run the three source files with `node --import tsx --test --test-reporter=tap test/browser-bootstrap.test.ts test/browser-install-lifetime.test.ts test/hoai-browser-host.test.ts`, then `npx tsc --noEmit`. The whole Host file includes real Chromium and needs the qualified disposable environment. Private Docker/SSH/mutation runners and immutable manifests are identified by SHA in JSON; their physical runs require the same owned fixtures and serialized native/download lane. No cleanup, retry or launch is authorized by reading this receipt.
