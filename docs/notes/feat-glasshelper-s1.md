1. **What would a top professional do here that was not asked?** Make the safety boundary executable before any process test, preserve failures as evidence, and have a separate reviewer challenge the proof. Measure the unsigned stub honestly without claiming antivirus approval, a clean-PC budget, or a working sign-in integration. Sources: ACCEPTANCE E and F; REPORT, "How we know it is right, independent of me and of Ares"; FEAS, "What is not proven".
2. **What would they start from?** The acceptance IDs and binding decisions D1 to D12, then the current pure naming functions and `schtasksSpec` launcher contract. Preserve its node path, watcher argument, working folder and Windows home semantics, while replacing its mechanism only in the new, unused helper. Sources: ACCEPTANCE G; WATCHER, `serviceNamespace`, `canonicalHome`, `watcherHomeId`, `watcherServiceNames`, `schtasksSpec`; HOME, "Gotcha / Pattern".
3. **Which tools would they use?** Read-only Git and file inspection now. After a new build goal: the installed Rust 1.95 toolchain, Microsoft `windows-sys`, the existing Windows SDK resource compiler, Node built-ins, the WSL heavy lock, process-handle and PE inspections, and the prescribed separate read-only Codex review. No package, toolchain, target or component installation. Sources: GOAL, tree, safety, heavy-lock and fresh-review instructions; ACCEPTANCE NAT-1 to NAT-6 and PROC-5.
4. **What would prove the result right, independent of me and Ares?** A per-ID command/log/result ledger, observed fake-child outputs, Windows policy and binary readbacks, meaningful red-first failures and four restored mutations, followed by Data's independent review. Later clean-PC, signed-release, antivirus and actual sign-in proof belong to later slices. Sources: ACCEPTANCE PLAN-3 and F; REPORT and PROPOSAL, "How we know it is right" / "How we prove it"; FEAS, "Never takes focus, the flooded runs".

# Glass helper slice 1 plan

GOAL A only. Everything below describing code, tests, commands, commits or measurement is a proposed GOAL B procedure, not an execution claim. No build goal starts until Ares issues a new goal after the plan passes judgment and answers the blocking questions below. This note is the only repository change in GOAL A. Source: GOAL, "GOAL A, PLAN ONLY" and "GOAL B, BUILD SLICE 1".

## Sources and current baseline

These sources were read in full, including FEAS named by the acceptance file:

| Short name | File |
|---|---|
| GOAL | `<goals>\glasshelper-s1.txt` |
| ACCEPTANCE | `<goals>\glasshelper-acceptance-s1.md` |
| REPORT | `<docs>\helper-window\REPORT.md` |
| PROPOSAL | `<docs>\autostart-av-safe\proposal.md` |
| FEAS | `<docs>\helper-window\glass\FEASIBILITY.md` |
| WATCHER | `lib/watcher-service.mjs` |
| HOME | `docs/learnings/home-override-on-windows-is-userprofile.md` |
| BASELINE | `docs/learnings/windows-test-baseline.md` |

Paths in this file are placeholders, so the repo names no folder of the machine that ran the slice: `<repo>` is this checkout, `<lane>` is the lane's own scratch folder outside it (Cargo home, target, temp, and the evidence folder `<lane>\s1`), `<goals>` and `<docs>` are the coordinator's folders, and `<cargo.exe>`, `<node.exe>` and `<codex.js>` are the installed tools. The real values stay in the lane's evidence.

Read-only inspection on 2026-11-03 found branch `feat/glasshelper-s1`, with HEAD and local `origin/main` both `582a489a2c84748a94e195f03bbd3fd56d82df31`. Initial `git status --short` was empty; no tracked native workspace or plan existed. This is a local reference inspection, not a fetch or a claim about the remote tip. `package.json` version is `0.83.0`. `.gitattributes` requires LF for text. No builds, tests, registry access or product processes were run during planning.

For sources cited below, `ACCEPTANCE <ID>` means that ID's complete requirement, not just its title. Binding DEC decisions narrow the much larger REPORT/PROPOSAL design to this slice. A source gap is a question in PLAN-8, never implied authorization.

## PLAN-1 and PLAN-2: planning gate

This file is `docs/notes/feat-glasshelper-s1.md`. The four answers above precede the rest of the plan. The GOAL A final inspection must show exactly this one untracked/modified file, no code, Cargo or test files, and print the required three-word readiness line alone. No commit is authorized for GOAL A. Sources: GOAL A; ACCEPTANCE PLAN-1, PLAN-2.

## Design contract and binding decisions

- The two-member Rust workspace contains `hoai-common` for data validation, naming, restart scheduling and Win32 wrappers, and `hoai-helper` for the GUI-subsystem entry point. Edition 2021, minimum Rust 1.95, exact dependencies and a committed lockfile. No toolchain file. Sources: ACCEPTANCE NAT-1, D1, D2.
- First operations in `main` set the system-only DLL directory policy and image-load mitigations, before config work or child creation. The release links the static CRT and dependent-load flag 0x800 and embeds the required HOAI names and plugin version. Sources: ACCEPTANCE NAT-2 to NAT-5, D11; REPORT, "A planted DLL next to the helper" and "Engineering appendix / Security".
- `run`, `register` and `unregister` require `--config <path>`. A strict schema-1 JSON decoder rejects wrong types, unknown fields and invalid namespace. The explicit fields are `schema`, `home`, `nodePath`, `watcherDir`, `namespace` when supplied, `stateDir`, and `testRunKey` when supplied. No default config location. Sources: ACCEPTANCE HLP-1, D4, D10. Unspecified path rules and invalid-config logging remain questions Q4 and Q7.
- Existence checks cover the node file, watcher directory and its `bin\hoai-watcher.mjs` before starting anything; no font, signer or network work. Sources: ACCEPTANCE HLP-2, D3; REPORT, "Start-up cost".
- Use `CreateProcessW` directly with application `nodePath`, mutable UTF-16 command line `"<nodePath>" "<watcherDir>\bin\hoai-watcher.mjs" run`, working directory `watcherDir`, a Unicode environment block, inherit handles FALSE, and `CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT`. Pin `USERPROFILE` to the configured home; remove `NODE_OPTIONS`; namespace semantics await Q5. Preserve other environment entries. Do not assign the watcher to a helper-owned job. Sources: ACCEPTANCE HLP-3, D8; WATCHER, `schtasksSpec`; HOME. Microsoft [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw), Parameters, and [process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags), Flags, supply the API contract, not a measured result.
- Restart after 1, 2, 4 seconds and so on, capped at 300; reset after a completed uptime of at least 600 seconds. Use a pure schedule function and a monotonic clock, with measured real-child first and second waits. Sources: ACCEPTANCE HLP-4, D7; PROPOSAL (b), "At sign in". Timing tolerance is Q8.
- Acquire `Local\HOAI-Helper-<user SID>-<first 16 hex of SHA-256 of the full config path>` before any watcher starts, using the agreed full-config-path representation. Keep its handle through supervision. One same-config second instance exits 12; distinct scratch configs do not collide. Sources: ACCEPTANCE HLP-5, D5; REPORT, "The pipe the helper listens on". Config identity and breakaway handoff ordering are Q7 and Q9.
- Register a REG_SZ value named `HOAI Helper` plus optional ` (<namespace>)` plus ` home-<id>`, using the first eight SHA-256 hex digits of precisely WATCHER's UTF-8 `canonicalHome(home, 'win32')`. Value data is quoted full helper path plus `run --config` and quoted full config path. Unregister only that value. API writes only; never touch StartupApproved. Every test targets its unique `Software\HOAI-Test\glasshelper\<random>\Run`; invalid test keys fail 14 before opening a registry key. Sources: ACCEPTANCE HLP-6, HLP-7, D6, D9; WATCHER naming functions; REPORT, "How it starts at sign in" and appendix Start-up.
- If in a job, attempt a self-relaunch with `CREATE_BREAKAWAY_FROM_JOB` before supervision; after verified handoff the original exits. If refused, remain alive in the job and record the outcome. Both allowed and denied jobs are created by the harness only. Sources: ACCEPTANCE HLP-8; REPORT, "What must outlive an agent" and appendix Agents. Never add a job that owns the real watcher. Q9 settles the handoff details before implementation.
- Write `helper-state.json` schema 1 with helper and watcher pid/creation-time pairs, restart count, last error code and in-job result. Use a temporary file in `stateDir`, then a same-folder replacement, with readers checking complete JSON throughout. Log only codes, paths and times in `helper.log`, at most 1 MiB plus one `.1` rollover. Sources: ACCEPTANCE HLP-9, HLP-10, D12; REPORT, state-file identity paragraph. [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew), Return value and Remarks, defines replacement/error cases; initial creation and failure handling await Q10.
- Public exit codes stay 0 clean stop, 10 bad config, 11 missing required file, 12 same configuration already running, 13 registry write failed, 14 refused test key, otherwise 1 plus the Windows error code in the log. Sources: ACCEPTANCE D10. Clean-stop trigger is Q6; do not invent a new CLI or pipe.

## PLAN-4: complete proposed dependency inventory

Only cached source manifests were inspected, under `<lane>\cargo-home\registry\src\`. Nothing was downloaded or installed. Direct dependencies would use `=version`; all resolved packages must match the agreed exact ledger in `Cargo.lock`. `cargo tree --locked` and cached manifests must independently confirm the final closure. Upstream crates' own dev-only dependencies are not dependencies of this workspace. Sources: ACCEPTANCE PLAN-4, NAT-1, D2; GOAL package prohibition.

| New crate/package | Exact proposed version | Licence | Role and reason |
|---|---|---|---|
| hoai-common | 0.0.0, publish = false | Apache-2.0, same as plugin | Local runtime library for the contract above |
| hoai-helper | 0.0.0, publish = false | Apache-2.0, same as plugin | Local runtime program and dev measurement example |
| windows-sys | =0.61.2 | MIT OR Apache-2.0 | Direct runtime/dev bindings for process, registry, SID, mutex, jobs, image policy, file and window inspection; CNG SHA-256 avoids another hashing crate |
| windows-link | =0.2.1 | MIT OR Apache-2.0 | Runtime Windows symbol linkage, transitive |
| serde | =1.0.229 | MIT OR Apache-2.0 | Direct runtime and build JSON data model with derive |
| serde_core | =1.0.229 | MIT OR Apache-2.0 | Runtime and build serialization traits, transitive |
| serde_derive | =1.0.229 | MIT OR Apache-2.0 | Build-time procedural macros for explicit schema structures |
| serde_json | =1.0.151 | MIT OR Apache-2.0 | Direct runtime and build JSON parser/writer, including package version read |
| itoa | =1.0.18 | MIT OR Apache-2.0 | Runtime and build JSON integer output, transitive |
| memchr | =2.8.3 | Unlicense OR MIT; choose MIT | Runtime and build JSON scanning, transitive; no Unlicense election |
| zmij | =1.0.23 | MIT | Runtime and build JSON number output, transitive |
| proc-macro2 | =1.0.107 | MIT OR Apache-2.0 | Build-time macro token support |
| quote | =1.0.47 | MIT OR Apache-2.0 | Build-time macro token generation |
| syn | =3.0.5 | MIT OR Apache-2.0 | Build-time parser, required by this cached serde_derive version |
| unicode-ident | =1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 | Build-time identifier tables; approved by Ares in the final binding section, build time only |

The Unicode-3.0 conjunct cannot be called MIT-only. Ares approved this exception for build-time use in the final binding section. Even avoiding derives may leave these packages in Cargo's all-target lock closure via `cfg(any())` dependencies in serde_core; do not promise that disabling a feature eliminates the issue. No hand-written replacement JSON parser is silently substituted. Sources: the inspected normalized `Cargo.toml` files for every row, especially `serde_derive` dependencies and `unicode-ident` licence; ACCEPTANCE PLAN-4; final binding answer Q3.

New npm packages: none. Node's existing runtime and built-ins suffice for the guard, fixtures and evidence reader. No npm/bun install, package lock change, AccessKit, WebView2, UI crate, async runtime, third-party test framework or resource crate. The installed `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe` was found by read-only inspection; a future build script can invoke that existing SDK compiler without a shell and keep its generated resource under OUT_DIR on E:. No SDK installation is allowed. Resource generation is a proposed implementation choice, with binary readback required by NAT-4. Sources: ACCEPTANCE GRD-1, GRD-7, NAT-4, D2; GOAL toolchain rule.

## PLAN-5: exhaustive proposed file list

Only the first row is created now. Later additions require the judged plan and new GOAL B. Any additional path requires a new plan line agreed by Ares. Paths below are repository-relative unless absolute. Sources: ACCEPTANCE opening scope, PLAN-5, PROC-8; GOAL scope rule.

| Path(s) | Planned purpose |
|---|---|
| `docs/notes/feat-glasshelper-s1.md` | This plan and later Ares decisions |
| `scripts/build-guard.mjs` | Plain Node scanner and CLI |
| `test/build-guard.test.ts` | The only new plugin test file; no imports of watcher runtime |
| `test/fixtures/build-guard/positive.txt`, `test/fixtures/build-guard/near-miss.txt`, `test/fixtures/build-guard/expected.json` | Text cases for every named rule, including forbidden native tokens; never executable payloads |
| `package.json` | One added `guard:win` script: `node scripts/build-guard.mjs --strict native`; no other edits |
| `native/Cargo.toml`, `native/Cargo.lock`, `native/.cargo/config.toml` | Workspace, exact resolution, static CRT and linker settings |
| `native/crates/hoai-common/Cargo.toml` | Library manifest |
| `native/crates/hoai-common/src/lib.rs`, `config.rs`, `naming.rs`, `backoff.rs`, `win32.rs` in that `src/` directory | Library exports, config, name parity, scheduling and scoped Win32 handles |
| `native/crates/hoai-common/tests/contract.rs` | Pure contract and validation tests |
| `native/crates/hoai-helper/Cargo.toml`, `native/crates/hoai-helper/build.rs` | Program manifest and version-resource generation |
| `native/crates/hoai-helper/src/main.rs`, `runtime.rs`, `state.rs`, `logging.rs` in that `src/` directory | Hardened entry, supervision/registry/job behavior, state and bounded logs |
| `native/crates/hoai-helper/tests/acceptance.rs`, `native/crates/hoai-helper/tests/support/mod.rs` | Windows-only safe process harness and acceptance tests |
| `native/crates/hoai-helper/tests/artifact.rs` | Release PE, import, resource and scope inspections |
| `native/crates/hoai-helper/examples/startup-cost.rs` | Twenty-run measurement tool, built as a GUI-subsystem program with no window |
| `native/crates/hoai-helper/examples/audit-boundary.rs` | Test-only GUI-subsystem utility for names-only registry snapshots before the first product run and after the last; blocked on Q1 |
| `native/tools/evidence-audit.mjs` | Read-only evidence ledger checker, scope/command/mutation audit; not another plugin test suite |
| `<lane>\s1\EVIDENCE.md` | Uncommitted per-ID evidence table including PLAN-1 to PLAN-8 |
| `<lane>\s1\logs\<named logs below>` | Uncommitted red, green, mutation, build, command, review and gate logs |
| `%TEMP%\hoai-helper-tests\runs\<unique run>\...` (here `<lane>\tmp\...`; before the path change `<lane>\s1\runs\...`) | Enumerated harness-owned config, home, state, observations and `fake-watcher\bin\hoai-watcher.mjs`; generated by harness, never a real watcher |
| `%TEMP%\hoai-helper-tests\startup-cost.csv`, `startup-cost-summary.json` (before the path change `<lane>\s1\...`) | Measurement |
| `<lane>\s1\guard-report.json`, `review.txt` | Complete scanner report and fresh reviewer output |
| `<lane>\s1\registry-before.json`, `registry-after.json`, `owned-processes.json` | Names-only whole-session registry boundary and harness-owned pid/creation-time ledger |

The shared scratch `cargo-home`, `target` and `tmp` directories already exist under `<lane>\`. They are the only Cargo/cache/temp destinations; no sweeping or deleting shared caches. Generated build files stay there. Tests keep an exact list of their own created paths and remove only those, never wildcards. Sources: GOAL scratch and deletion rules; ACCEPTANCE SAFE-4, SAFE-5.

## Guard rules and test safety

The guard scans regular text files under exactly `bin/`, `lib/`, `hooks/`, `native/`; file-extension rules also report `.vbs` and `.ps1` files. It never executes inspected text or follows a directory link out of those roots. Proposed rule IDs are `SCRIPT_RUNNER`, `POLICY_BYPASS`, `ENCODED_COMMAND`, `SCHEDULED_TASK`, `POWERSHELL`, `WMI`, `COMMAND_PROMPT`, `HIDDEN_POWERSHELL`, `TEMP_LAUNCH`, plus native-only `NEW_CONSOLE`, `DETACHED`, `SHOW_WINDOW`, `ALLOC_CONSOLE`. No allow markers, ignored lines or file skip lists. `test/fixtures/build-guard/` is outside the specified scan roots, not a scanner exemption. Sources: ACCEPTANCE GRD-1, GRD-3, GRD-4, GRD-6.

For every token/extension alternative, the positive text fixture must match with a stable file, one-based line, rule ID and matched text; its paired near miss must not. Case and documented shortened switches must be covered. Proposed temporary-launch heuristic: flag an explicit spawn/run/execute/start call or executable command adjacent to a temp path literal or temp-path expression (`%TEMP%`, `%TMP%`, `$env:TEMP`, `$env:TMP`, `process.env.TEMP`, `process.env.TMP`, `os.tmpdir()`, or a literal Windows Temp directory). A harmless mention or temp data-file write is the paired near miss. This is static risk reporting, not a claim to detect computed paths or every shell grammar. Short-switch boundaries, adjacency and missing-root semantics need Q11 before build. Sources: ACCEPTANCE GRD-1's documented-heuristic requirement, GRD-2 and GRD-6; PROPOSAL, "A build guard".

All fake-child tests use a unique scratch home with a profile-shaped `AppData\Local` and the generated fake watcher only. Before every launch, reject a real USERPROFILE home, any config path into its real `.bgos-agent` (case/separator/alias aware), any watcher other than the recorded fixture, any foreign state directory and any non-test registry destination. No real daemon import, endpoint, signer file, auth file or real task query. The only production module import needed is WATCHER's import-safe pure naming functions to generate parity expectations in the guard test file. Sources: ACCEPTANCE SAFE-1, SAFE-2, SAFE-6; HOME, "How to apply next time"; BASELINE, Windows path/profile cases; WATCHER header, import-safe contract.

Use handles plus creation times to identify every process the harness owns; keep cleanup in a failure-safe guard and verify each recorded handle exited. Never identify a fake node by querying command lines. Job objects belong only to the two explicit job tests; ordinary supervision tests must not impose a helper-owned job on the watcher. Runtime and test logs never dump environment blocks or other programs' command lines. Sources: ACCEPTANCE HLP-3, HLP-8 to HLP-10, SAFE-4, SAFE-6.

Focus sampling begins before launch and spans at least ten seconds while both programs run. Check visible top-level-window ownership against the recorded helper/fake process tree and compare foreground HWND with the baseline at least every 50 ms. Save timestamps, actual max gaps and per-second sample counts. A cadence miss is a failed/inconclusive test, never a pass based on a whole-run average; unrelated foreground changes still fail this requirement and are reported. Do not open a positive-control visible window on this PC. Sources: ACCEPTANCE HLP-11; REPORT risks 2 and 3; FEAS, "The pass lines fixed before any result" and "Never takes focus, the flooded runs".

## PLAN-7: exact proposed commands and evidence locations

All commands in this section are inert plan text. They must not be executed in GOAL A. Each invocation is one detached heavy ticket, serially, never a simultaneous build/test. `L` in the matrix below means the literal directory `<lane>\s1\logs`. A command ID is an exact reference to its full command here, not an invitation to improvise flags. Windows paths in the payload are reached from WSL using the given mounted paths. Sources: GOAL, "Heavy lock"; ACCEPTANCE SAFE-5, PROC-3, PROC-4.

C1, all Rust tests including ignored, serial Windows cases, log `L\cargo-green.log`:

```text
wsl.exe -e bash -lc "cd '<repo>/native' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy --light bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <cargo.exe> test --locked -- --include-ignored --test-threads=1' > <lane>/s1/logs/cargo-green.log 2>&1 < /dev/null &"
```

C2, release build, full slot, log `L\release.log`:

```text
wsl.exe -e bash -lc "cd '<repo>/native' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <cargo.exe> build --release --locked --examples --bins' > <lane>/s1/logs/release.log 2>&1 < /dev/null &"
```

C3, only the new guard test file, log `L\guard-green.log`:

```text
wsl.exe -e bash -lc "cd '<repo>' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy --light bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <node.exe> --test test/build-guard.test.ts' > <lane>/s1/logs/guard-green.log 2>&1 < /dev/null &"
```

C4, report all roots and enforce native only, log `L\guard-report.log`:

```text
wsl.exe -e bash -lc "cd '<repo>' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy --light bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <node.exe> scripts/build-guard.mjs --strict native --json <lane>/s1/guard-report.json' > <lane>/s1/logs/guard-report.log 2>&1 < /dev/null &"
```

C5, Clippy, log `L\clippy.log`:

```text
wsl.exe -e bash -lc "cd '<repo>/native' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy --light bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <cargo.exe> clippy --locked -- -D warnings' > <lane>/s1/logs/clippy.log 2>&1 < /dev/null &"
```

C6, formatting, log `L\fmt.log`, **blocked on Q2's fmt exception**:

```text
wsl.exe -e bash -lc "cd '<repo>/native' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy --light bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <cargo.exe> fmt --check' > <lane>/s1/logs/fmt.log 2>&1 < /dev/null &"
```

C7, dependency closure, log `L\cargo-tree.log`:

```text
wsl.exe -e bash -lc "cd '<repo>/native' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy --light bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <cargo.exe> tree --locked' > <lane>/s1/logs/cargo-tree.log 2>&1 < /dev/null &"
```

C8, startup measurements after C2, log `L\startup-cost.log`:

```text
wsl.exe -e bash -lc "cd '<repo>/native' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy --light bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <lane>/target/release/examples/startup-cost.exe' > <lane>/s1/logs/startup-cost.log 2>&1 < /dev/null &"
```

The cost tool has fixed scratch outputs listed in PLAN-5, creates twenty unique fixture/config instances, and uses the release `hoai-helper.exe` under the same target directory. It must record all twenty rows, launch-to-child-existence elapsed time, helper CPU via GetProcessTimes, read bytes via GetProcessIoCounters, peak process memory, and median/worst for each. It holds process handles until readings and cleanup complete. Set the measured CPU/read figures beside 300 ms and 300 KB, without treating either as a passing threshold here. Sources: ACCEPTANCE HLP-12; REPORT, "Start-up cost" and independent startup proof; FEAS, "Native or WebView2" measurement limits.

C9, evidence audit, log `L\evidence-audit.log`:

```text
wsl.exe -e bash -lc "cd '<repo>' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy --light bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <node.exe> native/tools/evidence-audit.mjs <lane>/s1/EVIDENCE.md' > <lane>/s1/logs/evidence-audit.log 2>&1 < /dev/null &"
```

C0 and C11 bracket the entire product-test session, after Q1 permits names-only access. Build the boundary utility with C2 before any helper/fake-child run. C0 runs before the first such run, including red cases and mutations; C11 runs after the last, including C8 and any reviewer-driven reruns. The snapshots must be equal and are never overwritten to conceal a mismatch. These tools read value names only, not registry data. C9 checks the completed boundary logs. Source: ACCEPTANCE SAFE-3, SAFE-4.

C0, log `L\registry-before.log`:

```text
wsl.exe -e bash -lc "cd '<repo>/native' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy --light bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <lane>/target/release/examples/audit-boundary.exe begin' > <lane>/s1/logs/registry-before.log 2>&1 < /dev/null &"
```

C11, log `L\registry-after.log`:

```text
wsl.exe -e bash -lc "cd '<repo>/native' && export CARGO_HOME='<lane>\cargo-home' CARGO_TARGET_DIR='<lane>\target' TMP='<lane>\tmp' TEMP='<lane>\tmp' WSLENV=CARGO_HOME/w:CARGO_TARGET_DIR/w:TMP/w:TEMP/w && setsid nohup ~/.local/bin/heavy --light bash -c 'printenv CARGO_HOME CARGO_TARGET_DIR TMP TEMP; timeout 3600 <lane>/target/release/examples/audit-boundary.exe end' > <lane>/s1/logs/registry-after.log 2>&1 < /dev/null &"
```

For red-first and mutations, copy C1/C3/C4 literally with these fixed substitutions only:

| Run | Payload substitution | Log basename |
|---|---|---|
| Rust red first, repeated for each newly added case | C1 `test --locked` becomes `test --locked <exact-test-name>`; keep include-ignored and serial flags | `red-<exact-test-name>.log` |
| Guard red first, each newly added case | C3 adds `--test-name-pattern=<exact-test-name>` before its one test-file argument | `red-guard-<exact-test-name>.log` |
| Mutation M1 | C1 selects `launch_flags_are_windowless_before_spawn` | `mutation-M1-red.log` then `mutation-M1-restored.log` |
| Mutation M2 | C1 selects `fake_watcher_observes_scratch_home` | `mutation-M2-red.log` then `mutation-M2-restored.log` |
| Mutation M3 | C1 selects `fake_watcher_has_no_node_options` | `mutation-M3-red.log` then `mutation-M3-restored.log` |
| Mutation M4 | C4 unchanged | `mutation-M4-red.log` then `mutation-M4-restored.log` |

Each launcher log must include the four environment paths, test output and authoritative process exit status. `timeout` 124 is a failed run, never a passing test. The heavy job handle and completion status must be retained in the evidence ledger, not inferred from a quiet log. Every three minutes inspect the named log tail and pids only, for example `wsl.exe -e bash -lc "tail -n 30 <lane>/s1/logs/cargo-green.log; pgrep -f '[c]argo.exe test --locked'"`; use each payload's unique part and the saved heavy ticket to disambiguate. Never kill a queued ticket, never relaunch on a mere observation timeout. Poll/wait up to two hours per run, in short observations. Escalate with the required Ares question after that deadline. Sources: GOAL heavy-lock instructions and active-goal wait rules.

C10 is the prescribed fresh review, after local build commits and before build READY:

```text
node <codex.js> exec --skip-git-repo-check -m gpt-6.1-sol -c model_reasoning_effort=xhigh -s read-only -C <repo> "Read git diff origin/main...HEAD and <goals>\glasshelper-acceptance-s1.md. Report bugs, missed or faked IDs, weakened tests, scope creep, and broken safety rules. Read only; do not run builds, tests, helpers, registry operations, or package installs."
```

Capture its output and exit status at `L\review.log` and `s1\review.txt`, with the revision reviewed. Reconcile every finding in EVIDENCE.md; a material fix needs relevant reruns and review of that fix. C10 is not executed during planning. Sources: GOAL fresh-review command; ACCEPTANCE PROC-5.

## PLAN-3: ID to test, exact command, log and source

The named tests do not exist yet. `T` below expands to `native/crates/hoai-common/tests/contract.rs`; `W` to `native/crates/hoai-helper/tests/acceptance.rs`; `P` to `native/crates/hoai-helper/tests/artifact.rs`; `G` to `test/build-guard.test.ts`. These are literal path aliases for the matrix. C1 runs T, W and P, including ignored cases. P's binary tests read the actual C2 release binary, not a debug stand-in. C2 must therefore precede the final C1. Unit/harness bring-up before C2 uses targeted red/green invocations; no unavailable-artifact test is called passing. Every log path below is `L\<basename>`, with L expanded above. Sources: ACCEPTANCE PLAN-3, PROC-1, PROC-7.

P's evidence-validator tests use synthetic positive and negative records in their own scratch directories, exercising C9's rejection behavior without requiring a final review, final commit or future log to exist. They do not prove historical execution. Only final C9, after the real runs, C10, C11 and final Git inspection, validates the real EVIDENCE.md. This separates testable checker behavior from the actual evidence and removes a circular prerequisite for C1 or the pre-mutation baseline commit. Sources: ACCEPTANCE PROC-1 to PROC-7.

| ID | Test file and exact planned test name; observable assertion | Command(s) | Log(s) | Behavior source |
|---|---|---|---|---|
| GRD-1 | G `every_rule_finds_positive_and_rejects_near_miss`; per-alternative case matrix for the nine rule families, case variants and extensions | C3 | guard-green.log | ACCEPTANCE B GRD-1, GRD-6; PROPOSAL, "A build guard", "No scripts"; REPORT, "HOAI's own files stop starting PowerShell" |
| GRD-2 | G `report_default_and_json_agree`; exact line records, counts, stable JSON parity and exit 0 with findings | C3 | guard-green.log | ACCEPTANCE GRD-2; PROPOSAL, "starts by only reporting" |
| GRD-3 | G `strict_is_containment_scoped_without_exemptions`; native finding exit 1, outside-native finding exit 0; no skip/allow syntax | C3, C4 | guard-green.log, guard-report.log | ACCEPTANCE GRD-3; REPORT, order of work step 2 |
| GRD-4 | G `native_flags_are_rejected`; four positive forbidden API/flag text cases and near misses in a synthetic native root | C3 | guard-green.log | ACCEPTANCE GRD-4; REPORT appendix Agents |
| GRD-5 | G `real_report_covers_required_legacy_paths`; assert all eleven named paths below and retain entire report | C3, C4 | guard-green.log, guard-report.log | ACCEPTANCE GRD-5; PROPOSAL footnotes 6 to 9 and 22; REPORT, Windows script retirement paragraph |
| GRD-6 | G `fixture_inventory_is_complete`; expected.json exhaustively maps rule alternatives to positive and negative cases; fixtures never scanned as product roots | C3 | guard-green.log | ACCEPTANCE GRD-6 |
| GRD-7 | G `package_script_is_only_package_change`; exact guard:win script and baseline comparison of remaining JSON, dependencies, lockfiles and workflows | C3 | guard-green.log | ACCEPTANCE GRD-7; Data owns CI |
| NAT-1 | T `workspace_manifest_and_lock_are_exact`; two members, edition, MSRV, exact dependencies, lock present, no toolchain file | C1, C7 | cargo-green.log, cargo-tree.log | ACCEPTANCE NAT-1, D1, D2; Q2/Q3 must be resolved |
| NAT-2 | P `release_imports_and_dependent_load_flag`; print complete import table, reject CRT DLLs, verify only system DLLs and load config 0x800 | C2, C1 | release.log, cargo-green.log | ACCEPTANCE NAT-2; REPORT, planted-DLL paragraph and appendix Security; Microsoft /DEPENDENTLOADFLAG, Remarks |
| NAT-3 | P `release_has_gui_subsystem`; read PE subsystem equals 2, plus W no-window observation | C2, C1 | release.log, cargo-green.log | ACCEPTANCE NAT-3; REPORT, sign-in startup paragraph |
| NAT-4 | P `release_version_resource_matches_plugin`; read ProductName HOAI, FileDescription HOAI helper, CompanyName HOAI and both versions from actual binary | C2, C1 | release.log, cargo-green.log | ACCEPTANCE NAT-4, D11; REPORT, full version details |
| NAT-5 | W `image_load_policy_readback`; launch safe config, open owned helper handle, GetProcessMitigationPolicy checks all three bits; P `hardening_is_first_in_main` checks ordering | C1 | cargo-green.log | ACCEPTANCE NAT-5; REPORT appendix Security |
| NAT-6 | P `quality_tools_available_or_recorded_missing`; independently inspect tool availability and required outputs; no install when missing | C5, C6, C1 | clippy.log, fmt.log, cargo-green.log | ACCEPTANCE NAT-6; GOAL tool rule; Q2 |
| HLP-1 | T `schema_one_rejects_unknown_and_invalid_fields`; W `bad_config_exits_10_without_child`; missing config/schema, wrong types, unknown fields, invalid namespace; one safe log line per Q4 | C1 | cargo-green.log | ACCEPTANCE HLP-1, D4, D10; WATCHER serviceNamespace |
| HLP-2 | W `missing_required_path_exits_11_without_child`; independently remove each fake path, inspect named error in state | C1 | cargo-green.log | ACCEPTANCE HLP-2; REPORT, Start-up cost |
| HLP-3 | T `launch_flags_are_windowless_before_spawn`; W `fake_watcher_launch_contract`; validate exact application/argv/cwd/flags/handle policy, child home, namespace and environment; watcher outside helper-owned jobs | C1 | cargo-green.log | ACCEPTANCE HLP-3, D8; WATCHER schtasksSpec; REPORT appendix Agents; HOME |
| HLP-4 | T `restart_schedule_doubles_caps_and_resets`; check full sequence, 599/600-second boundary and overflow; W `first_two_restarts_are_observed`; real timestamps and restart count | C1 | cargo-green.log | ACCEPTANCE HLP-4, D7; PROPOSAL (b), At sign in; Q8 |
| HLP-5 | T `mutex_name_has_sid_and_config_digest`; W `same_config_second_instance_exits_12`; no second fake child; a different config can run | C1 | cargo-green.log | ACCEPTANCE HLP-5, D5; Q7/Q9 |
| HLP-6 | G `home_names_match_node_on_three_homes`; record Node pure-function outputs; T `home_names_match_node_vectors`; W `register_roundtrip_touches_only_own_value`, `registry_failure_exits_13`; test-key exact REG_SZ name/data plus unrelated sentinel preservation; fault injection before the API call proves exit 13 without altering any external ACL | C3, C1 | guard-green.log, cargo-green.log | ACCEPTANCE HLP-6, D6, D10; WATCHER canonicalHome/watcherHomeId/watcherServiceNames; REPORT appendix Start-up |
| HLP-7 | W `test_key_prefix_is_enforced_before_registry_open`; use unique allowed subtree; reject RunOnce, bare prefix, separator tricks and other keys with code 14, no writes; finally delete only own subtree | C1 | cargo-green.log | ACCEPTANCE HLP-7, D9 |
| HLP-8 | W `allow_breakaway_survives_job_close`, `deny_breakaway_records_and_stays`; own controlled jobs, retained pid/creation-time handles, allowed relaunch and fake survive closing job; denied state records refusal while helper stays alive | C1 | cargo-green.log | ACCEPTANCE HLP-8; REPORT, What must outlive an agent, appendix Agents; Q9 |
| HLP-9 | W `state_is_complete_atomic_and_pid_time_scoped`, `generic_failure_exits_1_with_windows_code`; concurrent readers during restart see complete schema and identity pairs; first write, replace and injected fault cases per Q10; generic fault records only its numeric Windows code | C1 | cargo-green.log | ACCEPTANCE HLP-9, D10; REPORT, recorded pid and creation time |
| HLP-10 | W `log_caps_rolls_once_and_excludes_payloads`; cross 1 MiB, confirm one .1 and bounded current file; use sentinel config/environment content never present in logs; no raw OS error text that leaks payloads | C1 | cargo-green.log | ACCEPTANCE HLP-10, D12 |
| HLP-11 | W `ten_seconds_no_visible_window_or_focus_change`; baseline-before-launch, at least 20 Hz with timestamps/gaps, owned-tree top-level-window checks, ten seconds with fake child | C1 | cargo-green.log | ACCEPTANCE HLP-11; REPORT risks 2, 3; FEAS pass line and flooded runs |
| HLP-12 | P `cost_output_has_twenty_complete_runs`; validate C8 CSV and independent medians/maxima, CPU, read bytes, memory and timing fields; compare Low reference without promise | C2, C8, C1 | release.log, startup-cost.log, cargo-green.log | ACCEPTANCE HLP-12; REPORT, Start-up cost and How we know it is right |
| SAFE-1 | W `fake_watcher_observes_scratch_home`, `fake_watcher_has_no_node_options`; child's JSON records pid, arguments, cwd, os.homedir, namespace, NODE_OPTIONS absence even when set on helper | C1 | cargo-green.log | ACCEPTANCE SAFE-1; HOME |
| SAFE-2 | W `harness_refuses_real_home_and_agent_paths`; inject real-home/agent-directory strings into each path field and prove rejection before any spawn/read/write, including alias spellings | C1 | cargo-green.log | ACCEPTANCE SAFE-2; HOME isolation lesson; BASELINE path cases |
| SAFE-3 | W `registry_boundary_compares_names_without_values` validates the boundary reader on synthetic registry data; C0/C11 compare actual whole-session sorted value names only, never data, enclosing C1, C8 and all mutation/rerun product launches | C0, C1, C8, C11, C9 | registry-before.log, cargo-green.log, startup-cost.log, registry-after.log, evidence-audit.log | ACCEPTANCE SAFE-3; blocked Q1 |
| SAFE-4 | W `failure_cleanup_leaves_no_owned_process`; deliberate harness failure reaps all recorded helper/fake handles; final whole-run scan restricted to owned identity ledger, outputs pid/name/path only | C1, C8 | cargo-green.log, startup-cost.log | ACCEPTANCE SAFE-4; GOAL kill-what-you-start rule |
| SAFE-5 | T `scratch_environment_is_on_e`; W `all_outputs_stay_in_owned_scratch`; all heavy logs start with four E: values, manifest and output-path audit | C0 to C9, C11 | corresponding eleven heavy-run logs | ACCEPTANCE SAFE-5; GOAL heavy lock |
| SAFE-6 | P `scope_has_no_live_access`; inspect entire changed file list and harness launch/read boundaries, no real HOAI/task/agent/auth/network actions; fresh reviewer challenges it | C1, C9, C10 | cargo-green.log, evidence-audit.log, review.log | ACCEPTANCE SAFE-6; GOAL safety rules; HOME |
| SAFE-7 | G `final_native_tree_is_strict_clean`; exact final-tree guard result must be exit 0 with native finding count 0 | C3, C4 | guard-green.log, guard-report.log | ACCEPTANCE SAFE-7, GRD-3 |
| SAFE-8 | P `changed_files_have_no_long_dashes`; scan all added/changed file text for Unicode U+2013/U+2014, count 0, using numeric codepoints in native source | C1, C9 | cargo-green.log, evidence-audit.log | ACCEPTANCE SAFE-8; GOAL writing rule |
| PROC-1 | P `rejects_missing_red_first_evidence` tests synthetic ledger rejection; final C9 `red_first_inventory` checks each new named test has earlier expected failure and later green output, not only a compiler error in an unrelated case | red variants, C1, C3, C9 | red-<exact-test-name>.log, red-guard-<exact-test-name>.log, cargo-green.log, guard-green.log, evidence-audit.log | ACCEPTANCE PROC-1; GOAL, Done without running |
| PROC-2 | T `launch_flags_are_windowless_before_spawn`; W home/NODE_OPTIONS tests; G strict test, each as named in PLAN-6; P `rejects_missing_mutation_restoration` validates synthetic records; final C9 verifies real logs and direct diff audit | M1 to M4 variants, C9 | mutation-M1-red.log through mutation-M4-restored.log, evidence-audit.log | ACCEPTANCE PROC-2; GOAL scope/safety rules |
| PROC-3 | P `release_artifact_is_current`; actual suite and build completion records are authoritative, not that test alone; include every ignored case in final C1 | C2, C8, C1 | release.log, startup-cost.log, cargo-green.log | ACCEPTANCE PROC-3 |
| PROC-4 | G `only_guard_test_entry_is_used`; entire final C3 green, command audit proves no whole plugin suite or watcher-self-refresh execution | C3, C9 | guard-green.log, evidence-audit.log | ACCEPTANCE PROC-4; GOAL overrides generic whole-suite line; BASELINE does not grant an exception |
| PROC-5 | P `rejects_missing_review_revision_or_answers` exercises synthetic invalid/valid reviews; final C9 checks actual reviewer revision and answers; separate reviewer output must be read by the worker, every finding answered/fixed | C1, C10, C9 | cargo-green.log, review.log, evidence-audit.log | ACCEPTANCE PROC-5; GOAL fresh-review command |
| PROC-6 | P `commit_scope_matches_agreed_files`; C9 plus explicit `git branch --show-current`, `git log origin/main..HEAD --format=full`, `git status --short`, `git diff --check` captured with exit codes in L\final-git.log | C1, C9, listed Git commands | cargo-green.log, evidence-audit.log, final-git.log | ACCEPTANCE PROC-6; GOAL no push/no dangerous Git rules |
| PROC-7 | P `rejects_missing_ids_and_invented_log_lines` exercises synthetic ledger cases; final C9 `all_ids_have_real_results` checks all 49 real A-to-F rows and linked log lines, tree/report/CSV/review artifacts; manual comparison against source remains required | C1, C7, C9 | cargo-green.log, cargo-tree.log, evidence-audit.log | ACCEPTANCE PROC-7; no circular self-certification from the existence of the ledger |
| PROC-8 | P `slice_scope_and_certificate_deferrals_are_explicit`; compare changed paths and this note's deferred scope with requirements | C1, C9, C10 | cargo-green.log, evidence-audit.log, review.log | ACCEPTANCE PROC-8; D1, D3, D11; REPORT split/signing sections |

GRD-5's exact mandatory legacy paths are `lib/watcher-service.mjs`, `lib/agent-task-win32.mjs`, `lib/win32-script-text.mjs`, `bin/hoai-agent-viewer.vbs`, `bin/hoai-agent-viewer.ps1`, `bin/win32-accept-dev-channels.ps1`, `bin/hoai-core.mjs`, `lib/agent-inventory.mjs`, `lib/watcher-keepalive.mjs`, `lib/agent-restart.mjs`, `lib/agent-windows.mjs`. Full findings, not just those names, are saved. Sources: ACCEPTANCE GRD-5.

Home parity vectors must include at least a mixed-case path with slash/duplicate separator/dot segments, a spaced non-ASCII scratch path, and a drive-root path; also test trailing slash and namespace empty/set. Compute expectations by the existing pure Node functions and compare Rust outputs, not two copied Rust formulas. No listed real home is opened. Sources: ACCEPTANCE HLP-6; WATCHER canonicalHome; BASELINE.

PLAN-1 to PLAN-8 are also ledger rows later: named inspections `plan_only_status`, `four_opening_answers`, `all_build_ids_mapped`, `dependency_inventory`, `file_inventory`, `four_mutations`, `heavy_commands`, `questions_and_escalations`. Their current proof is this note, read-only command output and final GOAL A status. Later C9 verifies the preserved plan evidence; it must not rewrite an unexecuted plan as historical build success. Source: ACCEPTANCE A and PROC-7.

## PLAN-6: red first, four deliberate breaks and restoration

Write a failing named test before its implementation; keep its exact failing output. Initial missing-module/compile red proves only absence, so follow it with a runnable failing assertion for each behavioral case before implementing that behavior. First implement and prove the harness's refusal and cleanup boundaries, then run product cases. Never make a real launch to prove unsafe code is unsafe. Tests that cannot safely execute red must fail at their pure launch-plan/guard boundary. Sources: ACCEPTANCE PROC-1, SAFE-1 to SAFE-6; GOAL no weakening.

| Mutation | Local edit, never committed | Required red and safe boundary | Restoration proof |
|---|---|---|---|
| M1 | Drop `CREATE_NO_WINDOW` from the computed launch plan | T `launch_flags_are_windowless_before_spawn` fails before CreateProcessW is reachable; do not launch a console-producing mutation | Restore exact hunk, same targeted command green; saved diff empty |
| M2 | Stop pinning USERPROFILE | W `fake_watcher_observes_scratch_home` fails using a second safe scratch inherited USERPROFILE, never the real home | Restore hunk, child's reported home correct; saved diff empty |
| M3 | Retain NODE_OPTIONS | W `fake_watcher_has_no_node_options` fails with a benign setting such as `--no-warnings`; no preload/require and no outside code | Restore hunk, JSON says absent; saved diff empty |
| M4 | Add one text line representing a PowerShell launch to `native/crates/hoai-helper/src/runtime.rs`, listed in PLAN-5, as a comment | C4 reports POWERSHELL under native and exits 1; text is scanned only, never executed | Remove exactly that line, C4 exit 0; saved diff empty |

Create a fully verified local baseline commit before mutations in GOAL B only, so `git diff --exit-code` and `git diff --cached --exit-code` can directly prove clean restoration after each. Preserve each mutation's exact diff in its log. Never reset, stash, clean or revert other work. After the last restoration run C2, C8, C1, C3, C4 and relevant C5/C6 again. Then inspect full diff in C10 and answer findings, rerun affected checks after fixes, and make only fully passing local commits. Source: ACCEPTANCE PROC-2 to PROC-6; GOAL Git and build rules.

Evidence result lines in this plan are descriptions of future required assertions, not fabricated PASS strings. Copy the actual test result/exit code from each future log into EVIDENCE.md. Evidence audits check other completed runs; the last ledger-audit result is appended only after its process completes, preventing the audit from certifying its own unfinished run. Any missing or unverified ID stays not done. Source: ACCEPTANCE opening paragraph and PROC-7.

## PLAN-8: questions, contradictions and build gates

These questions are part of the plan, not requests to widen GOAL A. Blocking entries must be answered in this note before GOAL B implementation of the affected contract. The full build cannot finish while any blocker remains. Sources: GOAL A, gaps rule; ACCEPTANCE PLAN-8.

| Question | Sources and conflict or silence | Build impact |
|---|---|---|
| Q1. Does SAFE-3 expressly permit a names-only, read-only before/after enumeration of the real Run key despite GOAL's blanket prohibition on touching it? | ACCEPTANCE SAFE-3 vs GOAL real Run key rule | Blocked; no such enumeration until answered |
| Q2. Who supplies the initial committed Cargo.lock, and what precise bootstrap is allowed without package installation or an unlocked Cargo command? Is NAT-6's `cargo fmt --check` an explicit exception to the blanket every-Cargo-command `--locked` rule? | ACCEPTANCE NAT-1, NAT-6; GOAL package rule; empty native baseline | Blocked; no silent `generate-lockfile`/fetch/update or fmt flag invention |
| Q3. May the dependency closure include `unicode-ident` 1.0.24's required Unicode-3.0 licence conjunct, or must Ares agree a replacement JSON/dependency route? Are new manifest references to already cached crates permitted by the package prohibition? | ACCEPTANCE PLAN-4, D2; GOAL packages; cached normalized manifests | Blocked; the proposed serde route is not licence-approved |
| Q4. Where must the single bad-config log line go when JSON is unreadable or stateDir is absent/invalid, given GUI startup, no default config path and no environment/content leakage? | ACCEPTANCE HLP-1, HLP-10, D4, D10, D12 | Blocked; do not invent stderr/file fallback |
| Q5. When namespace is omitted but inherited HOAI_SERVICE_NAMESPACE exists, remove it or preserve it? | HLP-3 says set only when given; D8 says nothing else changes; WATCHER schtasksSpec inherits omitted entries | Blocked contract; tests need one unambiguous expectation |
| Q6. What event causes a clean stop with code 0, and what happens to the fake/real watcher then, without adding a stop command or pipe? | ACCEPTANCE D10 vs HLP-1 CLI and PROC-8 no pipe; source has no stop trigger | Blocked lifecycle case; harness forced cleanup is not clean-stop proof |
| Q7. How is the full config path encoded/canonicalized for its hash, including relative paths, drive case, separators, Unicode and junction/symlink aliases? Must the other config paths be absolute, local, nonempty files/directories, and what error codes cover invalid forms? | HLP-5/D5 specify full path but no canonicalization; HLP-1/2 omit path grammar; HLP-6 explicitly uses lexical home normalization | Blocked identity and config cases; no arbitrary policy |
| Q8. What maximum timing tolerance proves approximately 1 s and 2 s restart waits on this busy PC? | ACCEPTANCE HLP-4 gives schedule but no integration tolerance; FEAS shows scheduling delays | Blocked timed pass/fail; raw measured waits always retained |
| Q9. What self-relaunch handoff proves success and prevents mutex collision/relaunch loops; does a permitted outer job plus a denying inner job follow the denied path? | HLP-5 mutex vs HLP-8 relaunch; REPORT appendix Agents and nested-job uncertainty | Blocked job implementation; both branches must be proven without changing machine jobs |
| Q10. What are the permitted first-publication and replacement failure semantics for state, and state/log write failure exit codes? | HLP-9 atomic replacement; D10 generic failure, but no first-file/failure rule | Blocked state error cases; no promise of crash durability from a rename alone |
| Q11. Which PowerShell abbreviated switches, token boundaries and temp-launch adjacency should the checker accept, and what should it do with a missing strict root, symlink, unreadable or binary file? | GRD-1 short forms/heuristic; GRD-2/3 no I/O-error behavior specified | Blocked scanner edge contracts; proposed heuristic above is reviewable, not silently binding |
| Q12. What finite startup/readiness deadline may the harness use, and is strict cadence interpreted as maximum 50 ms between samples? | HLP-11, HLP-12 give duration/count but no launch deadline; FEAS sampling warning | Blocked final measurement qualification; a missed cadence never passes |
| Q13. Does the no-window rule also require runtime error-dialog suppression, and may the helper set an error mode for that? | NAT-3/HLP-11 require no window; NAT-5 specifies first two calls; no error-mode policy | Blocked exceptional-launch behavior; no intentional crash/dialog tests on this PC |

Resolved scope tensions, with no invented implementation:

- PROC-2's phrase "at least three" is followed by four required examples; plan all four. BASELINE's judge-by-npm-test line is superseded by the explicit local suite ban and ACCEPTANCE PROC-4: only the new guard file runs here; Ares/CI own the later full pass. Sources: ACCEPTANCE PROC-2, PROC-4; GOAL heavy-lock paragraph.
- REPORT/PROPOSAL demand signing and real startup in the full product; ACCEPTANCE outcome explicitly calls this unsigned and unused, D3 defers signer checks, and PROC-8 forbids wiring. The certificate does not block planning; it blocks later release trust claims. Sources: ACCEPTANCE outcome, D3, PROC-8.
- Forbidden native tokens in negative guard fixtures belong outside native under GRD-6; do not add ignore comments to work around native strictness. Source: GRD-3, GRD-4, GRD-6.
- PROPOSAL (b)'s hidden agent console and REPORT's later pseudo-console/host design differ, but neither is built here. D1 fixes Rust despite FEAS leaving the eventual window language open. Sources: ACCEPTANCE D1, PROC-8; REPORT, Changes item 4; FEAS, For whoever builds it.
- D8 deliberately removes NODE_OPTIONS although today's VBS does not. The native launch preserves the documented contract except that explicit change. Sources: D8, HLP-3; WATCHER schtasksSpec.
- GOAL's shorter Node example mentions only TMP/TEMP; this plan sets and prints all four to satisfy SAFE-5. No claim is made that OS crash reports can be redirected by those variables; intentional crashing is excluded here. Sources: SAFE-5; FEAS, What the tests did to this PC.
- REPORT's old native-window memory/time estimate is corrected by FEAS; neither number is a measured budget for this helper. Source: FEAS, Native or WebView2; HLP-12.
- Release byte-identity across unchanged code, supported oldest OS builds, installer temporary execution, GUI design, antivirus matrices, logon delay and current signer identity remain later-slice questions. They do not authorize more work here. Sources: REPORT, Signing and order of work; PROPOSAL, Scope and How we prove it; D3, PROC-8.

## Explicit exclusions and places that need the certificate later

No agent host, pseudo console, pipe, window/tray program, signing, downloads, updater, setup wiring, old-task migration, workflow edit or change to how the plugin starts anything today. No production registration, live watcher run, app query, provider/backend call, or test of `test/watcher-self-refresh.test.ts`. Source: ACCEPTANCE PROC-8 and E; GOAL safety rules.

Later certificate-dependent places are: the `hoai-helper.exe` release signature/timestamp and CompanyName constant; future release signer settings that must fail closed without configuration; any future helper verification of HOAI-signed hosts/window/app images; future signed manifests/data and their trusted signer/key settings; future helper update/repair signature checks on opened files. Host/window/app/installer/uninstaller/native-addon signing and Microsoft pseudo-console-package verification remain later work, not files added by this slice. Unsigned development SHA-256 pin lists, when signer checks are introduced, follow D3 only. Sources: ACCEPTANCE D3, D11, PROC-8; REPORT, Signing and Engineering appendix / Security.

## Completion audit for GOAL A

Before the final readiness line: read back this note, confirm all 41 B-to-F IDs and all eight PLAN IDs appear with their required mappings, retain every blocking question, verify no U+2013/U+2014, and run `git status --short --untracked-files=all`. It must show only `docs/notes/feat-glasshelper-s1.md`. No build/test command above is run, no implementation file exists from this work, and no GOAL B action follows. Print the blocking Ares questions as required, then the exact planning readiness line alone; mark GOAL A complete and stop. Sources: GOAL A Done when; ACCEPTANCE PLAN-1 to PLAN-8.

## Ares binding changes, judge of 3 Nov 2026

These changes override the plan above where they differ. GOAL B builds the plan with them.

### Answers to PLAN-8

Q1. Yes. SAFE-3 is the spec and requires a names-only read of the real Run key. The GOAL rule means never write it. `audit-boundary` opens `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` with KEY_QUERY_VALUE only and calls RegEnumValueW with lpData and lpcbData NULL, so it reads no data. It writes the sorted names, their count and a SHA-256 of the joined list to s1 only. Nothing from it is committed. Any difference between C0 and C11 stops the lane with ARES NEEDED.

Q2. Run `cargo generate-lockfile --offline` once, as ticket C-1 (C7's line with that payload), and commit the lock. Then add `--offline` right after `--locked` in C1, C2, C5, C7 and every variant of them. `cargo fmt --check` runs exactly as NAT-6 writes it: it takes no `--locked` and resolves no dependencies. A crate missing from the E: cache stops the run with ARES NEEDED and is never fetched.

Q3. unicode-ident =1.0.24, licence `(MIT OR Apache-2.0) AND Unicode-3.0`, is allowed as a build-time dependency only. It reaches the lock through serde_core's `cfg(any())` line and through syn and proc-macro2, and none of its code links into hoai-helper.exe. Unicode-3.0 is a permissive OSI-approved licence for Unicode data tables. New manifest references to crates already in the E: cache are allowed (D2). If Ares strikes this answer, the route is no serde at all: hoai-common gets a strict reader for one flat JSON object of strings plus the integer `schema`, with tests for escapes, surrogate pairs, duplicate keys, a BOM and trailing data.

Q4. If the config yields a `stateDir` that is valid under Q7 and exists as a folder, the one bad-config line goes to `<stateDir>\helper.log`. Otherwise nothing is written anywhere and exit code 10 is the only signal: no stderr, no fallback file, no event log. Tests prove both cases.

Q5. Remove it. When `namespace` is absent, remove every inherited HOAI_SERVICE_NAMESPACE, case-insensitive. When `namespace` is present, set it once. Reason: the Run value name and the watcher's own names must come from one source. An inherited stray value makes the watcher address other names (WATCHER header: "a guessed name is how a staging install would end up addressing the live service"). D8 names the namespace variable as one the helper sets.

Q6. Slice 1 has no clean-stop trigger, and none is added. Exit 0 means one of three things: `register` succeeded, `unregister` succeeded, or the original process handed over after a successful breakaway relaunch (Q9). Otherwise `run` keeps running until it is ended. Tests end it by handle and never call that a clean stop. A helper that ends leaves the watcher running (REPORT risk 20), so tests end both.

Q7. Paths and config identity.
- `home`, `nodePath`, `watcherDir` and `stateDir` must be absolute drive paths (`X:\...`). Each must be non-empty, without `"` and without NUL. `nodePath` must not end with `\`. Otherwise: exit 10. UNC and `\\?\` paths are refused in this slice.
- The `--config` argument goes through GetFullPathNameW. The result must not contain `"`, must not end with `\`, and must name an existing file, otherwise exit 10.
- Mutex digest: take that full path, apply canonicalHome's win32 rules (forward slashes to backslashes, normalize, strip trailing backslashes, lower case), encode it as UTF-8, hash it with SHA-256 and keep the first 16 lower-case hex digits. The rules are lexical only: no link or junction is resolved, which matches canonicalHome's stated choice.
- The Run value data uses the same full path, not lower-cased.

Q8. Measure each wait as the next fake's creation time minus the previous fake's exit time, both read with GetProcessTimes on retained handles. Pass when all three hold:
- 0.95 s <= wait 1 <= 2.0 s;
- 1.95 s <= wait 2 <= 4.0 s;
- wait 2 > wait 1 + 0.5 s.

Log the raw values every time.

Q9. The `run` order is:
1. Hardening (NAT-5, B17).
2. Read and check the config (exit 10).
3. Create the mutex (exit 12 if it already exists; nothing else is written).
4. Call IsProcessInJob on itself. If it is in a job:
   - close the mutex handle;
   - call CreateProcessW on its own image with: its own command line from GetCommandLineW; the same current folder; environment NULL (inherited); bInheritHandles FALSE; flags CREATE_BREAKAWAY_FROM_JOB only;
   - on success: write one log line with the child's pid, close both handles, write nothing to the state file, and exit 0;
   - on failure: keep the error code, create the mutex again (exit 12 if another instance took it in the meantime), continue, and record "breakaway refused" plus the code in the state file.
5. File checks (exit 11), then the state file, then the watcher.

The child runs the same steps. A child left inside an outer job that refuses breakaway is refused on its own try, because its immediate job is now the refusing one (Microsoft JOBOBJECT_BASIC_LIMIT_INFORMATION), so the chain ends after one extra start. A permitted outer job with a refusing inner job is refused at once: that is the denied path.

HLP-8 tests:
- Allow job: KILL_ON_JOB_CLOSE | BREAKAWAY_OK. It holds the helper and one sentinel, a fake node in wait mode that the harness starts with CREATE_NO_WINDOW. After the original exits, close the job. The sentinel must be gone (the control). The relaunched helper and its fake must be alive and in no job (IsProcessInJob FALSE, read against the B2 baseline).
- Deny job: KILL_ON_JOB_CLOSE only. The helper stays alive, its state says "breakaway refused" with the code, and its fake is inside the job.
- Never create the helper suspended.

Q10. State and log writes.
- State: write `helper-state.json.<helper pid>.tmp` in stateDir, call FlushFileBuffers, then MoveFileExW to `helper-state.json` with MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH. This also covers the first write. Do not use ReplaceFileW.
- Retry up to 5 times, 100 ms apart, on error 32 (sharing violation) or error 5 (access denied). After a final failure, delete the temp file.
- Before the first watcher start, a state or log write failure exits 1, with the code in the log if the log works.
- During supervision, a state write failure is logged with its code and supervision goes on.
- Log: append. When the next line would pass 1 MiB, use MoveFileExW to turn `helper.log` into `helper.log.1` (replace), then start a new file.
- "Readers always see a whole file" is UNVERIFIED until the concurrent-reader test passes. No crash-durability claim is made.

Q11. Guard edges.
- Matching is case-insensitive, and a switch may start with `-` or `/`.
- ExecutionPolicy: `-ep`, or any prefix of `executionpolicy` of 2 or more letters, followed by `bypass`.
- EncodedCommand: any prefix of `encodedcommand`, including `-e`.
- WindowStyle: any prefix of `windowstyle`, including `-w`, followed by `hidden`, a prefix of `hidden`, or `1`.
- Forms of 1 or 2 letters count only on a line that also matches `powershell` or `pwsh`; the full names count anywhere.
- A token must be preceded by the start of the line, whitespace, a quote, a comma, `(` or `[`, and followed by whitespace, a quote, a colon, a comma or the end of the line.
- Temporary launch: the plan's list, plus `temp_dir()`, `GetTempPathW` and `GetTempPath2W`. "Adjacent" means the same line or the next one.
- Native-only tokens: `\bCREATE_NEW_CONSOLE\b`, `\bDETACHED_PROCESS\b`, `\bShowWindow(Async)?\b` and `\bAllocConsole\b`, case-sensitive, as whole names. Native code and native tests never spell them; tests assert the flag bits by value (0x00000010 and 0x00000008 are absent).
- A missing scan root gives one `GUARD_ROOT_MISSING` line. Report mode still exits 0; a missing `--strict` root exits 1.
- Directory links are never followed and give one `GUARD_LINK_SKIPPED` line.
- An unreadable file gives a `GUARD_IO` line, and exit 1 when it sits under the strict root.
- A file with a NUL byte in its first 8 KiB skips the content rules; the extension rules still apply.

Q12. Readiness and sampling.
- The fake must report within 30 s of launch, otherwise the run is inconclusive (FEAS saw starts stall for 11 s and 19 s).
- Sample about every 10 ms.
- A run passes when each of the ten one-second buckets holds at least 20 samples and no gap between samples exceeds 100 ms.
- A miss is inconclusive: rerun at most twice. A miss is never a pass.

Q13. Error mode and crashes.
- No process-wide SetErrorMode: CreateProcess hands the process error mode to the watcher unless CREATE_DEFAULT_ERROR_MODE is set, and HLP-3's flag list does not include it.
- Call SetThreadErrorMode(SEM_FAILCRITICALERRORS) on the helper's own thread before its file checks. Whether a child inherits a thread's mode is UNVERIFIED; if it does, it is harmless.
- Keep `panic = "unwind"` in every profile. An abort writes a crash report to C:.
- No crash tests and no dialog tests on this PC.

### Other binding changes

B1. Committed tests check product behaviour only.
- Drop `native/tools/evidence-audit.mjs`.
- Drop these P tests: `rejects_missing_red_first_evidence`, `rejects_missing_mutation_restoration`, `rejects_missing_review_revision_or_answers`, `rejects_missing_ids_and_invented_log_lines`, `commit_scope_matches_agreed_files`, `scope_has_no_live_access`, `changed_files_have_no_long_dashes`, `slice_scope_and_certificate_deferrals_are_explicit`, `release_artifact_is_current`, `quality_tools_available_or_recorded_missing`, `cost_output_has_twenty_complete_runs`.
- Drop these G tests: `real_report_covers_required_legacy_paths`, `package_script_is_only_package_change`, `only_guard_test_entry_is_used`.
- These IDs are proven instead by uncommitted, read-only node scripts (node built-ins only) in `<lane>\s1\checks\`, plus the Git commands in PROC-6: GRD-5, GRD-7, NAT-6, HLP-12's summary, SAFE-3, SAFE-5, SAFE-6, SAFE-8 and PROC-1 to PROC-8. Each script runs under the heavy lock like C9 and has its own log in L. Its EVIDENCE.md row names the script, the command, the log and the result line.
- C9 runs `checks/evidence-audit.mjs` from the s1 folder.
- NAT-1's T test asserts four things: the members include hoai-common and hoai-helper (not "exactly two"), every dependency uses `=`, `Cargo.lock` exists, and no `rust-toolchain` or `rust-toolchain.toml` exists.
- P tests that read the release exe:
  - are marked `#[ignore = "needs the C2 release build"]`;
  - find the exe only at `<CARGO_TARGET_DIR>\release\hoai-helper.exe`, and fail when it is missing;
  - run through C1's `--include-ignored`.

B2. A harness job around every helper.
- The first harness test records IsProcessInJob for the harness's own process in its log. This is the baseline.
- Every helper a test or the C8 tool starts is created directly into a harness-owned job. The one exception is HLP-8's allow case.
- The job has JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and neither breakaway flag. The helper is put into it with PROC_THREAD_ATTRIBUTE_JOB_LIST, never with a later AssignProcessToJobObject.
- That job is the harness's, not the helper's, so HLP-3 holds.
- The expected in-job result is "breakaway refused" plus the recorded code, and tests assert it.
- C8's figures carry the label "measured inside a breakaway-refusing job".
- The HLP-8 allow test ends its relaunched helper and that helper's fake by retained handle plus creation time.
- Final sweep, listing pid, name and image path only:
  - end every hoai-helper.exe whose image lies under `<lane>\target\`;
  - end a node process only when its pid and creation time match a fake's JSON or a helper-state.json under the harness runs folder;
  - never end node.exe by name.

B3. D9 in product code.
- The code that opens the real Run key compiles only with a cargo feature `real-run-key`. No command in this plan enables it.
- Without the feature, `register` or `unregister` with no `testRunKey` exits 14 before any registry call. W test `register_without_test_key_exits_14_without_registry_access` proves it; C0 and C11 confirm it.
- The `testRunKey` check lives in hoai-common:
  - the prefix `Software\HOAI-Test\` is compared case-insensitively;
  - at least one more segment must follow;
  - no empty segment, no leading or trailing backslash, no NUL;
  - the root is always HKEY_CURRENT_USER.
- `register` opens its key with RegCreateKeyExW.

B4. HLP-11 watches the whole desktop.
- Before launch, record every visible top-level window: HWND, owner pid and image name, never the title.
- At each sample, a new visible top-level window fails the test if the helper tree, conhost.exe, OpenConsole.exe or WindowsTerminal.exe owns it.
- Any other new window makes the run inconclusive: rerun at most twice, never a pass.
- The foreground rule and Q12 apply as written.

B5. Launch facts, split honestly between tests.
- The CreateProcessW call takes the application name, command line, flags, inherit flag, current folder and environment only from the pure launch plan.
- T tests that plan: the exact command line string, flags 0x08000400, bInheritHandles FALSE, the current folder, and the sorted environment.
- Remove NODE_OPTIONS by a case-insensitive name compare, every occurrence. HOAI_SERVICE_NAMESPACE follows Q5.
- W proves only what the fake can see:
  - argv[1] and argv[2];
  - `process.cwd()` and `os.homedir()`;
  - NODE_OPTIONS absent under any case;
  - HOAI_SERVICE_NAMESPACE's value, or its absence;
  - `process.stdout.isTTY` is true. A start with DETACHED_PROCESS would have no console. This is UNVERIFIED until the first green run records it.
- M3 runs twice, once with `NODE_OPTIONS=--no-warnings` and once with `node_options=--no-warnings`.

B6. Real failures, no test hooks.
- Product code gets no test-only switch, variable or file.
- Exit 13: the harness creates `Software\HOAI-Test\glasshelper\<random>` with REG_OPTION_VOLATILE and points `testRunKey` at `<random>\Run`. RegCreateKeyExW of a stable child then fails with 1021, ERROR_CHILD_MUST_BE_VOLATILE (Microsoft System Error Codes). Expect exit 13 and code 1021 in the log.
- Generic exit 1: before launch, create a folder named `helper-state.json` in stateDir (BASELINE: "a directory or file in the way fails everywhere"). Expect exit 1 and the Windows code in `helper.log`.

B7. Guard tests and fixtures.
- Extension rules are a pure function of the path and are tested with path strings only.
- No test, fixture or harness writes a .vbs, .ps1, .cmd or .bat file anywhere. File-level proof of the extension rules comes from the real tree (GRD-5).
- Text fixtures:
  - hold one risky token per line;
  - never contain a payload: no base64 (write `PLACEHOLDER` after an encoded-command switch), no URL, no download call;
  - never put two risky tokens on one line, except where a short switch must sit beside `powershell` (Q11).
- Synthetic roots for GRD-3 and GRD-4 are built under the E: TMP from .txt, .mjs and .rs text only, and removed by exact path.
- `build-guard.mjs` exports a pure scan function that takes a root.

B8. Guard runs.
- C3's payload starts with `test -f test/build-guard.test.ts || exit 3;` and always passes that one file as its last argument.
- A `node --test` command without an explicit, existing file is forbidden.
- `build-guard.test.ts` uses only erasable TypeScript (no enum, no namespace, no parameter properties) and imports only .mjs files.

B9. SAFE-2 and a decoy profile.
- The harness reads the real profile two ways: its own USERPROFILE, and SHGetKnownFolderPath(FOLDERID_Profile). It refuses both, compared after GetFullPathNameW, ignoring case, separator style and trailing separators.
- Every helper launch sets the helper's own USERPROFILE to a decoy scratch folder that has `AppData\Local`, never to the real profile.
- The fake writes its JSON next to its own script (located from `import.meta.url`), never relative to `os.homedir()` or the current folder.

B10. The home vectors file.
- Add `native/crates/hoai-common/tests/fixtures/home-vectors.json` to PLAN-5.
- G asserts that every vector's id and Run value name equal what `canonicalHome`, `watcherHomeId` and `watcherServiceNames` give, imported from `lib/watcher-service.mjs`. T asserts that Rust matches the same file.
- Vectors: the plan's own, plus:
  - a path with a `..` segment;
  - leading and trailing spaces;
  - a UNC path;
  - one U+00A0 case and one U+FEFF case, written as JSON escapes; Rust must match JS.
- USERPROFILE gets the raw `home` string (WATCHER line 495).
- The script path first drops watcherDir's trailing separators, as joinDir does; the current folder is watcherDir as given.

B11. Bitdefender stop rule.
- If any Bitdefender detection, quarantine or killed process happens during GOAL B, stop every run at once and print ARES NEEDED with the time.
- Touch nothing in Bitdefender, restore nothing, retry nothing.

B12. Record that the new start is not identical to today's.
- Today the task runs at Task Scheduler's default priority 7 (below normal; Microsoft's Task Scheduler Priority page), and the watcher and its agents inherit it.
- The helper starts the watcher at normal priority and passes on whatever environment it inherited.
- HLP-3's flags stay exactly as written in this slice. Priority goes to S5's plan as a question.

B13. Default mode and M4.
- Add C4a: C4's line without `--strict`, log `L\guard-default.log`. It must exit 0 and list the eleven GRD-5 paths.
- M4's red test is G `final_native_tree_is_strict_clean`, alongside C4.

B14. Order of commits and builds.
1. Commit 1: the guard, its test, its fixtures and the package.json script, with C3 green.
2. Commit 2: the native skeleton with `audit-boundary` and a stub helper.
3. An early C2.
4. C0, before any W case runs.

Every commit that touches `native/` passes C4 strict before it is made.

B15. The import rule.
- Reject any import named `vcruntime*`, `msvcp*`, `ucrtbase*` or `api-ms-win-crt-*`.
- Accept `api-ms-win-core-*` and `ext-ms-*` API sets, and DLLs that exist in `%SystemRoot%\System32`.
- Print the whole import table to the log.

B16. rc.exe.
- build.rs finds the highest `%ProgramFiles(x86)%\Windows Kits\10\bin\<version>\x64\rc.exe` by listing folders. It hard-codes no version and reads no registry.
- If none is found, it stops with a clear message.
- It runs rc.exe without a shell, with its output and temp files under OUT_DIR.

B17. Hardening failure.
- If SetDefaultDllDirectories or SetProcessMitigationPolicy fails, keep the code and read the config.
- Write one log line with the code if stateDir is valid.
- Exit 1 before the mutex and before any child starts.

B18. The environment block.
- Build it from GetEnvironmentStringsW.
- Keep the leading per-drive `=X:` entries.
- Apply B5 and Q5, and set USERPROFILE.
- Sort by name, case-insensitive, in Unicode order, and end with a double NUL.

B19. Red first.
- One red ticket per new test file is allowed before that file's code exists, as long as its log shows each new test failing on an assertion, not only on a compile error.
- Tests added later use the single-test form.

B20. Tidy up, logs and timing.
- After the last test, delete `Software\HOAI-Test\glasshelper`, then `Software\HOAI-Test`, each with RegDeleteKeyW and only when it is empty. Never delete a tree above `<random>`.
- No log ever records a window title.
- HLP-12:
  - launch-to-watcher time is the fake's creation time minus the helper's, read with GetProcessTimes;
  - processor time, bytes read and peak memory are read 2 s after the fake exists;
  - then both processes are ended.

B21. Wording and versions.
- In M4, "allowlisted" becomes "listed in PLAN-5".
- "GOAL B's generic whole-suite wording" becomes "BASELINE's judge-by-npm-test line".
- Both crates take version "0.0.0" with `publish = false`. FileVersion and ProductVersion come only from package.json, through build.rs with `rerun-if-changed`.
- The PLAN-4 table states runtime, build or dev for each crate.

B22. Failures during supervision.
- Before every restart, the helper checks the three paths again.
- A missing path, or a failed CreateProcessW, is logged with its code and recorded in the state file, and the backoff continues.
- Exit 11 applies to the first start only.

Ares, 3 Nov 2026 21:55 GST: Q3 approved as written (unicode-ident build time only). Everything above in this section is binding for GOAL B. Plan agreed with these changes.

## Takeover, 4 Nov

Claude Opus 5.5 takes over GOAL B from the Codex worker, which ran out of usage near the end. Ares's takeover goal (`<goals>\glasshelper-claude.txt`) changes four things: the shell is WSL bash with `git.exe`, the fresh review is a fresh read-only Opus subagent on the exact final HEAD, commits end with the Claude co-author line, and any queued or running heavy ticket stays.

1. **What would a top professional do here that was not asked?** Treat the takeover as an audit, not a continuation. Copy the uncommitted work out of the tree before touching it (done: `s1\takeover\`, with a patch, the untracked files and their hashes). Re-check each evidence claim against its log and against the source state that log was made from, because a log from before the logger fix proves nothing about the final tree. On the open gate, name the job and its limits from a Windows readback and do not infer them from one error code, because code 5 alone cannot separate "an outer job refuses" from "the product asks wrongly". Say what the gate means for a real install as well as for the test: at sign in the helper is not started from this context at all. Read the helper source with fresh eyes before spending heavy slots on it, and leave every result repeatable from one saved command line.

2. **What would they start from?** The acceptance IDs and D1 to D12, then the binding changes above, then the logs themselves instead of the prose about them: `helper-green-initial.log`, the retained `job-allow` state file and `helper.log`, the uncommitted diff, and the live heavy queue. The first question is what this shell's process tree actually is, because the worker measured its job baseline from a different starting context than the one I now have.

3. **Which tools?** `git.exe`, read only until commit time. The heavy lock for every build and test. `cargo.exe --locked --offline` with the E: cache. A small scratch probe outside the tree (never committed) built on the same pinned `windows-sys`, calling only `IsProcessInJob` and `QueryInformationJobObject` with a NULL handle, and walking process parents, printing pid, name and image path, never command lines. Microsoft's Job Objects and Nested Jobs pages for what the readback means. Node built-ins for the uncommitted check scripts. A fresh Opus subagent for PROC-5. No Sandbox, no host PowerShell, no delay launcher, no new toolchain or crate.

4. **What would prove the result right, independent of you and of me?** Things neither of us writes: the fake watcher's own fields (the harness adds only its creation time, which the closing sweep uses), the Windows API readbacks (job limits, mitigation policy, PE headers, version resource), the before and after names-only hash of the real Run key, deliberate breaks that turn named tests red and then restore, and a reviewer who sees only the diff and the spec. For the open gate it is the unmodified hard assertion going green in a context whose baseline reads `in_job=false`, or that same test binary run by Ares in his own session. Past this slice: Data's gate, CI on the PR and Ares's controlled whole-suite pass. A clean PC, a signed build and real sign-in remain later proof and are not claimed here.

### The open gate: what was measured, 4 Nov

`allow_breakaway_survives_job_close` stays a hard assertion. It is not passed in any context this lane can reach. Readings came from a scratch probe, read only, never committed: `IsProcessInJob`, `QueryInformationJobObject` with a NULL handle, a parent walk. Logs: `s1\logs\job-probe-build.log`, `job-scan.log`, `gate-ab.log`.

Two jobs refuse breakaway:

| Context | In a job | Immediate job flags | Who owns it |
|---|---|---|---|
| Anything this lane starts, with no cargo | yes | `0x00000000`, about 450 members | The fleet job: other processes of this PC, none started by this slice. The member detail stays in the lane's evidence, not in this repo |
| Under `cargo test` or `cargo run` | yes | `0x00002000`, kill on close only | Cargo itself: `src/cargo/util/job.rs`, rust-1.95.0, puts itself and its children in that job, with no Windows opt-out |

Microsoft's Nested Jobs page says breakaway leaves the immediate job and each parent job until one does not permit it. So the first hop succeeds (exit 0, leaves the harness allow job), and the successor lands in the next job up, which refuses with code 5. The helper behaved as HLP-8 asks in both places: it kept running and recorded "breakaway refused". The same compiled test binary, sha256 `32beac1c...`, read `in_job=true` and failed the same way with and without a cargo parent, in debug and in release.

Two consequences to keep:

1. **`cargo test` on Windows cannot pass this test, from any context, ever**, while it stays a hard assertion. PROC-3 asks for `cargo test --locked` green. That line cannot hold literally for this one test. It is reported, not worked around: the test binary must be run directly, from a context that reads `IsProcessInJob` false.
2. **A no-job context exists on this PC but not for this lane.** `explorer.exe` and `sihost.exe` read as in no job. `WindowsTerminal.exe` and `OpenConsole.exe` read as in some other job, so a Terminal window is not assumed to be clean: the probe decides. For Data's CI: UNVERIFIED whether a hosted runner gives a no-job context. Measure it with the same probe before relying on it.

Routes refused on purpose, because each one borrows a process outside this lane to start the test: Task Scheduler, WMI, `explorer.exe` as a launcher, parent spoofing, and another session's WSL interop socket. Using one would prove the helper from a context nobody agreed to and would look like what the 3 Nov incident forbids.

### Fresh review of bd31648: what changed, what stays open

Full answers per finding: `s1\review-answers.md`. Changes to this plan that follow from it:

- **Restart reset:** the count now goes through the pure `next_failure_count`, and uptime is measured with `Instant`, the monotonic clock this plan asked for. The old code used process times, a wall clock.
- **Environment entries:** one entry that cannot be decoded is skipped. It used to stop every watcher start, for good.
- **Test keys:** `.` and `..` segments are refused.
- **Q11 addition:** `-ec` counts as EncodedCommand. Microsoft's about_pwsh lists it, and Q11's prefix rule missed it.
- **GRD-1 additions, COMMAND_PROMPT:** `cmd` named as the program in `spawn`, `spawnSync`, `exec`, `execFile`, or `Command::new`; a `.cmd` or `.bat` passed to `exec`, unless `shell: false` is on that line. Node's documentation says `exec` spawns a shell, and from memory it ignores `shell: false` (UNVERIFIED). The existing test `source_shape_regressions_follow_the_specification` requires no finding for that form, so the guard follows the test and this is reported here for Ares.
- **One test at a time:** `native/.cargo/config.toml` sets `RUST_TEST_THREADS=1`. Without it the literal `cargo test --locked` failed 29 of 30 W tests, because each test's clean-up ends helpers it did not start (`s1\logs\review-red-literal.log`).
- **HLP-11:** a NULL foreground window at baseline is now INCONCLUSIVE, never a pass. `GetForegroundWindow` read NULL in this lane (`s1\logs\review-red-focus.log`), so the focus half compared nothing with nothing. The window half still runs first and reports. So in this lane the test ends INCONCLUSIVE and counts as not passed. Ares's command for the open gate runs it too, in a session that has a foreground window.
- **The acceptance tests refuse to build with `real-run-key`:** one of them omits `testRunKey` on purpose, which with that feature would write the real Run key.
- **PLAN-5 addition:** `logging.rs` holds a second named mutex, `Local\HOAI-Helper-Log-<digest>`, added with a red test to serialize rotation. It has no SID in its name and is session scoped.

Left for the slice that wires this in, each needs a plan line, none is built here:

- A helper killed and run again starts a second watcher and overwrites the state file. The surviving watcher's identity is lost.
- `register` does not check Microsoft's 260 character limit for Run key data.
- `native/target` is not in `.gitignore`, and `guard:win` would scan it on a build that does not set `CARGO_TARGET_DIR`.
- The guard does not report a bare `shell: true`, as at `bin/hoai-statusline-bridge.mjs:48`, or a temp path on the line before the launch, which a test pins and Q11 defines. A script written to temp and run later by a variable, as in `bin/hoai-bootstrap.ps1:476-478` and `:504-507`, stays outside this heuristic too. A later removal list must not rely on this report alone for those two.
- UNVERIFIED until the PR runs: since the path change no test names a folder of this PC, but this lane has no Linux node and cannot run them elsewhere.

### Fresh review of 75ba513: what changed, what stays open

Full answers per finding: `s1\review-answers-2.md`. Changes that follow from it:

- **Guard, values:** a value followed by `;`, `)`, `}`, `|` or a backtick now counts. `lib/watcher-service.mjs:555` has `-WindowStyle Hidden;`, and the old boundary missed the only hidden window use in the tree. Q11's boundary on the switch itself is unchanged.
- **Guard, COMMAND_PROMPT:** `comspec` with `'/c'` on one line, the real form at `bin/hoai-core.mjs:3753` and `lib/plugin-cli.mjs:385`; and a quoted `.cmd` or `.bat` as the program given to `spawn`, which Node's documentation says needs a shell. `shell: false` on the line exempts it.
- **Guard, TEMP_LAUNCH:** `Command::new`, the `&` call operator, bare `tmpdir()`, `process.env['TEMP']`.
- **Guard start:** compares real paths, so starting it through a linked folder runs it. It used to exit 0 without scanning.
- **Q7:** a path with a forward slash after the drive is now refused. Q7 says `X:\...`.
- **Q10:** state writes now retry up to 5 times, which is 6 attempts. There were 4 retries.
- **SAFE-2:** a config edited to the real home is now proven refused by the harness, without any launch. That `launch` calls this check is read from the source by an uncommitted check.
- **HLP-5:** the test reads the live mutex by the name it computes from its own read of the user's SID.
- **HLP-7:** the process test now sends a foreign key, the bare prefix and RunOnce through the binary, safest first. No red run exists on purpose: a helper that stopped refusing would write outside `HOAI-Test`.

For Ares:

- **SAFE-6, a breach on a strict reading:** the scratch job probe read more than the limits of its own job. Its `--scan` mode, run once, listed every process's job membership (`s1\logs\job-scan.log`). Its default mode listed the members of its own job in two measurements and two rehearsals (`job-probe-build.log`, `job-probe-claude-bash-direct.log`, `gate-rehearsal.log`, `run-bd31648\gate-rehearsal.log`). Those lists may include real HOAI or live agents. It read pid, image name and path only, no command lines, and changed nothing. The goal asked for job readings from each reachable context, so this went further than asked. One `tasklist.exe /svc` read of a single parent pid named that process's service, and the scan showed job roots under it. Which processes and pids, and what I read into them, stay in `s1\EVIDENCE.md` and `s1\logs\job-scan.log`, not in this tree; nothing was done with them. The last step in this lane reads file hashes only and starts nothing. Ares's gate command runs the probe once more; since the review of 7bbd334 the probe prints its job's member count only, never a member list.
- **PROC-6 and PROC-3 cannot hold literally:** `cargo test` holds its own refusing job, so the allow case can never pass under it, and no commit passes "on its own" under that command. Every takeover commit was gated by exact test names and the reason `breakaway refused`.
- **PR gate, settled by Ares:** the branch merges main and so carries main's version; this slice sets none, and the version is set at publish.
- **PROC-1 for the guard:** the first guard reds only showed a missing module, which line 268 of this plan says proves only absence. Stub reds were taken afterwards on a scratch copy (`s1\logs\guard-stub-none.log`, `guard-stub-all.log`). They prove the assertions can fail. They do not prove the order, and no later run can.
- **Plan changes made during the takeover, none signed off by Ares:** the second named mutex with no SID; `RUST_TEST_THREADS`; `-ec`; the guard additions here and above; skipping an environment entry that cannot be decoded, which bends D8 in that one case so the watcher still starts; NAT-5 and the HLP-4 wiring read from the source by an uncommitted check, under B1; the HLP-11 inconclusive rule; the guard test's temp assertion, first limited to this lane and then removed by the path change (each lane log's first lines show where temp was); a holder of the log mutex in the same session for 5 seconds making the helper exit 1 before any watcher; the audit edits (a) to (k) in `s1\EVIDENCE.md`, which change my own checks, not the product or a committed test; the HLP-7 read back, which queries one key and one value name outside `HOAI-Test` with no write and no value data.

### Fresh review of 6b2a284: what changed, what stays open

Full answers per finding: `s1\review-answers-3.md`. Changes that follow from it:

- **Guard, split values:** a switch that ends its line now takes the first token of the very next line as its value. Q11 says the full names count anywhere, and `bin/hoai-core.mjs:1558` and `:4120` put `'-ExecutionPolicy',` and `'Bypass',` on separate lines, so the old report missed both. Forms of 1 or 2 letters stay bound to a line with the shell, as Q11 says.
- **HLP-7:** one assertion could never fail, because the harness's own boundary refused the path it checked. The test now reads back with read-only calls: whether the foreign key exists, and whether each refused key shape holds the helper's exact value name. This reads one value name in `RunOnce`, no data, and never touches the Run key. The test first proves the read-back can see a key and a value that exist.

Reported, no change: the allow assertion stays before the job closes. Survival is proven only by Ares's run.

### Fresh review of 499b497: what changed, what stays open

Full answers per finding: `s1\review-answers-4.md`. Changes that follow from it:

- **HLP-10:** the start line and the watcher line carried a pid. The spec allows codes, paths and times, and Q9 allows one pid, on the relaunch line. Both are gone.
- **A correction of mine:** the section above first said a refused helper stays inside the test's kill-on-close job. That was wrong. As "The open gate" here says, the first hop leaves that job and the successor lands in the next job up, so it could survive the close in this lane too. Moving the assertion after the survival checks would show that here, with every assertion still hard and the test still red. I did not move it. The goal says that test stays as it is, the choice is Ares's, and Ares's run reaches those checks anyway.

### Fresh review of 247afff: what changed, what stays open

Full answers per finding: `s1\review-answers-5.md`. Changes that follow from it:

- **Job checks:** three test assertions called `IsProcessInJob` with no job named, which asks "in any job". Where the harness runs in an outer job, as it does everywhere this lane reaches, they could not fail. `Process::in_this_job` now names the job for "watcher is inside harness-owned job", "original helper remains in refusing job" and "fake stays in harness job". `job_membership_reads_the_job_named` proves the reading with a job nothing joined. The allow test's last check still asks about any job, because being in no job is its claim.
- **Closing sweep:** it stopped on any recorded pid it could not open, and a reused pid can belong to a process that refuses this user. Its first real run, `s1\logs\sweep-rehearsal-old.log` at 247afff, stopped exactly there with Windows code 5, so the closing proof could not have finished after Ares's run. A pid that refuses reading now counts as not this lane's, unless the process list names it `node.exe` or `hoai-helper.exe`, which stays a failure. Each one is printed. This is a harness test, `a_refused_record_is_not_ours_unless_it_may_be_a_fake`, like the other harness refusal tests.
- **Closing sweep, second form:** with that fixed, the sweep passed and then, minutes later at 81332af, stopped on `process image: Windows code 31` (`s1\logs\run-81332af\sweep-rehearsal-final.log`). `an_exited_process_still_held_open_reads_as_gone` reproduces that code with a process the test itself holds. An exited process keeps its pid while something holds it open, so a recorded pid can land on one. It now reads as gone. Any other read failure on a live process stays a visible failure.
- **Closing sweep, third form:** at 464b264 the sweep passed three times and then, minutes later, stopped on `process image: Windows code 5` (`s1\logs\run-464b264\sweep-rehearsal-final.log`). The sweep reads an image only after an open succeeds, and only the identity query of a recorded pid reads one that was not read just before. So a live process at a recorded pid let the sweep query it and then refused its image name. Microsoft documents the limited query right as enough for that read, so which kind of process does this is UNVERIFIED; `s1\logs\record-probe.log` lists each recorded pid the sweep cannot read, by pid, name and code only. That refusal is now read like a refused open: named from the process list, `node.exe` and `hoai-helper.exe` still a failure. This lane found no way for a test to make a process that refuses its image name, so the red is the rehearsal log, and M14 breaks the branch and runs the sweep again. After the 5 Nov restart no recorded pid refused its image name (`s1\logs\record-probe.log`), so the old build passed the sweep (`s1\logs\sweep-img-red.log`) and M14 stayed clean (`s1\logs\run-7bbd334\mutation-M14-red.log`). The only red for this form is the 464b264 rehearsal log.
- **HLP-11, focus half:** the first three runs on this desktop with a real foreground window passed it, at 81332af. Earlier runs read no foreground window and were INCONCLUSIVE. So it depends on the desktop's state, and it is still in Ares's command.
- **HLP-11, a real red:** one of four runs at da78db7 read `FAIL: foreground changed` (`s1\logs\run-da78db7\cargo-green.log`), and the other three passed. The plan says unrelated changes still fail and are reported, so the failure stays a failure. The message did not say what took the foreground, so that one run cannot be attributed. It now names the window's owner, pid and image name, never its title.
- **HLP-11 at 7bbd334:** one of four full runs read `FAIL: foreground changed` and named an unrelated program's window as the new foreground (`s1\logs\run-7bbd334\cargo-literal.log`); the other three passed. The failure stays a failure, and the focus half stays in Ares's command.
- **HLP-11, the check can fail:** `desktop_check_goes_red_without_opening_a_window` hands the check a false baseline and a false owner list, with windows already on the desktop. It opens nothing, and both halves go red. The plan forbids opening a real window for this, and this does not.
- **HLP-10 test:** it now reads each line's whole shape: time, code, and at most one real path.

For Ares:

- **Plan line 109 overstates the harness:** it says every launch rejects "any non-test registry destination". The harness checks home, node path, watcher folder and state folder, not `testRunKey`, because HLP-7 must send refused keys through the binary. What stands behind that launch is the product's own check, the feature that nothing enables and a `compile_error!` in the acceptance tests, and SAFE-3's names comparison at the end.
- **Planned test names that do not exist, beyond NAT-5's:** `registry_boundary_compares_names_without_values` (SAFE-3 is proven by `audit-boundary` directly), `scratch_environment_is_on_e` and `all_outputs_stay_in_owned_scratch` (SAFE-5 is proven by the process audit over every log). `native_flags_are_rejected` and `harness_refuses_real_home_and_agent_paths` exist under other names.
- **Delay imports:** the NAT-2 import check reads the import directory only, not the delay import directory. No build file passes `/DELAYLOAD`, so nothing is hidden today.
- **From the fresh review of 464b264, no change made, each for your call:**
  - A SetThreadErrorMode failure counts as a hardening failure and exits 1 (`runtime.rs:102`). B17 names only SetDefaultDllDirectories and SetProcessMitigationPolicy.
  - HLP-4 says the fake watcher exits at once. `first_two_restarts_are_observed` uses ack-exit: the fake exits as soon as the harness has read its report, and each wait is read from that exit time to the next start, so the schedule reading is the same.
  - Q11's "a quote" is read as `'` and `"`. A switch right after a backtick, which opens a JS template string, is not found. Nothing in the tree has one today.
  - The guard runs only when Node's two real path forms of its own file agree (`scripts/build-guard.mjs:240`). If they ever disagreed, it would exit 0 without scanning. `guard_runs_when_started_through_a_linked_folder` covers a linked folder.
  - That test copies the guard into the temp folder and runs it with node. Here temp is on E:. On CI it would be a script started from the system temp folder, which TEMP_LAUNCH reports.
  - The watcher starts with an all-zero STARTUPINFOW (`runtime.rs:258`, `:336`), so STARTF_FORCEOFFFEEDBACK is not set. Microsoft's STARTUPINFO page describes a feedback cursor that this flag forces off. Whether one shows for these starts is unmeasured, and HLP-11 does not read the cursor: UNVERIFIED.
  - Fixed by the path change: the two contract tests that wrote under this lane's folder by literal path now write under the temp folder, like the harness. An unset TMP would put them on C: here; every lane command sets it.
  - Clippy's NAT-6 command lints the library and binaries only. A run over all targets, tests and examples included, is reported in `s1\logs\clippy-all-targets.log` and is not a gate.
- **From the fresh review of 7bbd334, no code change made, each for your call:**
  - Timed tasks: the guard matches the four tokens GRD-1 names as whole words, and `near-miss.txt` pins `New-ScheduledTaskExtra` as no match. So `New-ScheduledTaskAction`, `-Trigger`, `-SettingsSet`, `-Principal` and `Start-ScheduledTask` lines are not reported one by one (`lib/watcher-service.mjs:525-528`, `:554`; `lib/agent-task-win32.mjs:171-173`, `:201`). Each of those files is still named through `Register-ScheduledTask`, so GRD-5 holds, but per-line counts undercount building and starting tasks.
  - B12, one more difference, UNVERIFIED: today `shell.Run ..., 0` (`lib/watcher-service.mjs:497`) starts the watcher with a console whose window is hidden. CREATE_NO_WINDOW runs it "without a console window. Therefore, the console handle for the application is not set" (Microsoft, Process Creation Flags). So code in the watcher or its console children that asks for its console window may get none, where today it gets a hidden one. Not measured here; it goes to S5 with the priority question, and HLP-3's flags stay as written.
  - The closing sweep reads any wait result other than WAIT_TIMEOUT as exited (`tests/support/mod.rs:1916`). WAIT_FAILED would need a handle without SYNCHRONIZE, and the open asks for that right, so no path to it is known. A red for it would need one more committed test of the harness itself, which B1 limits.
  - The guard skips the content rules for a file with a NUL byte in its first 8 KiB, under `--strict native` too, as Q11 says. A binary or UTF-16 file in `native/` would pass SAFE-7 unread; a later slice could report such files instead.
  - This lane's bookkeeping scripts in `s1\checks` (index, ledger, pid list) are Python; B1 asks for Node built-ins. The CHECK lines come from the Node audits.
