# REPORT: daemon attach scope, step one (board row bab90cdb)

Branch `feat/daemon-attach-scope` in the plugin repo (bgos-claude-plugin), version 0.82.0. Committed, not pushed.

Design followed: BGOS `docs/superpowers/specs/2026-08-29-mcp-daemon-attach-gating-design.md` (#1244, "attach on explicit intent, not on folder residency"). This is its phase 1: the check exists behind a setting that starts OFF, the launcher learns to say what it meant, and every start is counted with what it WOULD have done. Nothing is refused for anyone until the setting is flipped.

## The problem, as the code shows it

On a computer with several agents, the machine wide marketplace copy starts a daemon for every Claude Code session, and the daemon becomes whichever agent the resolver picks (`lib/agent-credentials.ts`: env pin first, then folder pin, then credentials files). The env pin beats the folder pin and is inherited by every child process, so a plain `claude` that agent A's Bash tool starts in agent B's folder attaches as A in B's folder. The home check (`decideHomeBinding`) never refuses an explicit env pin, so nothing caught this. Intent exists only in the launcher, and until now the launcher never said it.

## What changed

- **`lib/attach-scope.mjs` (new): the scope decision, the setting, the telemetry and every text.**
  - `decideAttachScope` is pure, with realpath injectable. It returns one of four outcomes:
    - `match`: attach in every mode.
    - `wrong-agent`, named by either of two signals: `by: 'scope'` (the launcher named another agent) or `by: 'folder'` (this folder's `.bgos-agent-id` names another agent than the one resolved, which is what an inherited `BGOS_ASSISTANT_ID` does).
    - `unscoped`: no launcher named this session's agent.
    - `unreadable`: the scope, the identity or the env cannot be read. This always attaches (fail open), in every mode, strict included.
  - A scope whose `HOAI_ATTACH_SCOPE_DIR` is not this session's folder was inherited from a parent. It is not trusted and counts as `unscoped` with `launcher: 'inherited'`.
  - Folders are compared through realpath, without trailing separators, and case folded on macOS and Windows. Ids compare as numbers.
  - `launcher` is recorded as `hoai`, `gen1` (`BGOS_CONTINUE=1`), `inherited`, `env` (scope set by hand) or `none`.
  - `resolveAttachScopeMode` reads the setting, which starts OFF. `HOAI_ATTACH_SCOPE_MODE` sets it for one process; otherwise `~/.bgos-agent/attach-scope.json` `{"mode": ...}` sets it for the whole computer. The three modes:
    - `off`: the default. Refuses nothing.
    - `wrong-agent`: refuses a wrong agent.
    - `strict`: also refuses an unscoped session (the design's end state).
    Unknown, unreadable or malformed values mean off.
  - The middle step exists because the two classes carry different risk. A wrong agent is wrong by construction; an unscoped session can be a real agent whose launcher is not migrated yet.
  - Telemetry: `recordAttachScopeEvent` appends one JSON line per start to `<plugin state>/attach-scope-events.jsonl` (0600, rotated at 256 KB, never throws). `summarizeAttachScopeEvents` counts the window. It reports the would-refuse counts per mode, distinct (agent, folder) counts beside the boot counts, unscoped starts by launcher and wrong agents by signal.
- **`bin/hoai-core.mjs` (the launcher every current agent starts through: run.sh, the Windows logon task, a hand typed `hoai`).**
  - The run plan carries `attachScope`: the folder pin, the env pin, the supervised service's agent, or the sole paired agent.
  - It also carries `attachScopeDir`, the folder being launched.
  - `applyAttachScope` sets both in the env claude is spawned with. Unlike the rest of the plan env, both OVERRIDE an inherited value. With no agent to name, the scope is removed, while the folder is still set, so the daemon can tell that hoai launched it.
- **`server.ts`.**
  - **Decided** at module level, once, right after the unpaired notice. This part is pure and writes nothing; it reads the setting, the env, the launch folder and its pin.
  - **Acted on** in `main()` by `attachScopeAtBoot()`, second, right behind the duplicate copy check and before any lock, socket or poll:
    - it writes the boot log line (`attach scope: mode=...; ...; attaching; mode X WOULD refuse this session`);
    - it records the event;
    - only when the verdict is `refuse` (impossible while the mode is off) does it serve a one tool notice and stop.
  - The check up (`doctor_rpc`) gains an `Attach scope` row with this session's verdict and the machine's tally. It reports WARN only for a wrong agent and carries counts and ids only, no paths.
- **`lib/pair-required-server.mjs`: `serveScopeRefused`.** The scope refusal's own notice (tool name `hoai_not_this_agent`, as the home refusal). It says not to pin or set an id to get past it, because the home notice's advice to pin the folder would make a wrong agent session worse.
- **`bin/hoai-attach-scope.mjs` (new): the measurement reader** (`--days N`, `--json`). Read only.
- **Version 0.82.0** (`package.json`, `.claude-plugin/plugin.json`, `package-lock.json`) and a CHANGELOG entry.
  - The brief puts origin/main at 0.81.x, and this machine cannot fetch origin. 0.82.0 is above any 0.81.x, so the "version advances against base" check passes whatever patch origin/main is on, and a minor bump fits a new setting.

Not changed on purpose: the heartbeat (see follow ups), the stand-down reports (their eight reasons are the backend's fixed contract; a mislabelled report would be worse than none), `.claude-plugin/plugin.json` env, the lane server (`lane-server.ts`, a separate daemon), and `SESSION_ENV_KEYS` / the lane supervisor's drop list (relaunches go back through `hoai-core`, which recomputes the scope).

## How to measure before the flip

1. Ship 0.82.0. Nothing changes; every daemon start appends one line.
2. On each computer that runs several agents (start with KC's Mac mini and laptop), after a few days run:
   ```
   node <plugin root>/bin/hoai-attach-scope.mjs --days 7
   ```
   On a marketplace install the plugin root is `~/.claude/plugins/cache/hoai/hoai/<version>`; on a clone it is the checkout. It prints one line. An example from a sandbox with six recorded starts:
   ```
   attach scope: mode off (default); last 7 days: 6 starts, 1 right agent, 1 wrong agent, 4 unscoped, 0 unreadable, 0 refused; mode wrong-agent would refuse 1, strict would refuse 5 (distinct agent and folder: 1 and 3); wrong agent by scope 0, by folder pin 1; unscoped by launcher: hoai 0, generation one 1, inherited 0, by hand 0, none 3; last 2026-10-31T13:18:56.574Z
   ```
   Use `--json` for the raw numbers and `eventsDir`. Each event line in `attach-scope-events.jsonl` names its folder, agent, launcher and signal. This shows exactly which launcher or folder produced a would-refuse.
3. Remotely, per agent: the owner's "Run checkup" in the app shows the `Attach scope` row with the same tally for that agent's computer.
4. **Flip gate for `wrong-agent`:** every `wrong agent` start in the window is a session nobody meant as that agent. Read the folders in the events file to confirm that, then flip one computer at a time. Either write `{"mode":"wrong-agent"}` to `~/.bgos-agent/attach-scope.json`, or set `HOAI_ATTACH_SCOPE_MODE=wrong-agent` in one launcher. Undo by deleting the file or setting `off`.
5. **Flip gate for `strict`:** `unscoped by launcher: generation one` and `hoai` must be 0 for real agents. Generation one keepalives (`~/.bgos-session-*/keepalive.sh`, `run.expect`) must first move to `hoai` or export the scope (design section 4, rows 2 to 4). Only `none` and `inherited` should remain, and those must be sessions nobody intended as agents.
6. The fleet wide default flip (changing `DEFAULT_ATTACH_SCOPE_MODE`) is a later release, after steps 4 and 5 hold across the measured computers.

## Tests, red first

All new tests were written before the code they guard. Each was watched failing for the right reason, then made green.

| Step | Run | Red output |
|---|---|---|
| 1 | `test/attach-scope.test.ts` before the module existed | `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../lib/attach-scope.mjs'` |
| 2 | same, against a behaviour-less skeleton (every export a stub) | `ℹ pass 1, ℹ fail 26`. Each test failed on its own assertion (for example `✖ right agent attaches in every mode` with `AssertionError ... off`). The one pass is the dash guard, which passes on empty strings by design. |
| 3 | `test/attach-scope.launcher.test.ts` against a no-op `applyAttachScope` | `ℹ pass 0, ℹ fail 6` (`✖ run plan: a folder pin scopes the launch to that agent`, `✖ applyAttachScope: the launcher OVERRIDES an inherited scope ...`, `✖ main: a supervised launch hands the daemon its scope ...`) |
| 4 | `test/attach-scope.e2e.test.ts` with HEAD's `server.ts` swapped in (then restored) | `ℹ pass 0, ℹ fail 4`: the real daemon neither refused nor counted |
| 5 | Review round, unit: inherited scope folder, folder pin, ids, launcher, distinct counts | `ℹ pass 30, ℹ fail 8` with only the new export added, then green |
| 6 | Review round, launcher: scope folder | `ℹ pass 3, ℹ fail 4`, then green |
| 7 | Review round, e2e: the board row case and the scope notice | `ℹ pass 4, ℹ fail 2` (`✖ THE BOARD ROW: a worker in agent 42's folder that inherited agent 41's env pin ...`, `✖ wrong agent, setting ON ...` on the notice text), then green |

Final counts: `test/attach-scope.test.ts` 38 pass, `test/attach-scope.launcher.test.ts` 7 pass, `test/attach-scope.e2e.test.ts` 6 pass.

The e2e boots the real `bun server.ts` in a throwaway HOME, with a dead backend port and no production contact. It speaks MCP over stdio, and it is driven by the answers rather than timers (about 0.5 s a boot). Its six cases:

- Wrong agent with the setting on: refused with the scope notice, and the refusal is counted.
- Wrong agent with the setting off: the full daemon as before, plus a counted would-refuse.
- The right agent in strict.
- An unreadable scope failing open in strict.
- **The board row case:** agent 42's folder, with agent 41's inherited env pin and scope. Off, it is the full daemon plus `wrong-agent by folder` and `launcher inherited`; on, it is refused.
- Unscoped in strict, read from the machine file.

No test pins an absolute date. Fixtures are relative to `Date.now()`.

## Mutations

Harness: `docs/evidence/2026-10-31-attach-scope/mutate.py` (raw output beside it in `mutations.log`; run it with `python3 docs/evidence/2026-10-31-attach-scope/mutate.py [M1 M2 ...]`). It applies one edit, prints the changed line, runs the guarding test file(s), requires red with the module still loading (a mutant that does not compile is not a kill), and restores the file. 36 mutants, 36 killed. M31 first deleted an `if` line, which left a dangling `else` and did not compile. It was reported as NO-COMPILE, rewritten to `if (false)`, and then killed. M17's anchor moved in the review round and was re-run. M19 and M21 were re-anchored after the duplicate copy fix, and M35 and M36 were added for it.

| # | Mutant | File | Changed line (before, then after) | Result | Red tests (first) |
|---|---|---|---|---|---|
| M1 | wrong agent never refused | `lib/attach-scope.mjs` | `const refuseWrong = effective === 'wrong-agent' \|\| effective === 'strict'` then `const refuseWrong = false` | KILLED | wrong agent, setting ON (wrong-agent): REFUSED with the one notice tool, and the refusal is counted |
| M2 | fail open removed (unreadable judged) | `lib/attach-scope.mjs` | `if (!envReadable \|\| !self) return decide('attach', 'unreadable', null)` then `(line deleted)` | KILLED | an unreadable scope, strict: FAILS OPEN to the full daemon |
| M3 | match inverted | `lib/attach-scope.mjs` | `if (ownScope && scopeId === self) return decide('attach', 'match', null)` then `if (ownScope && scopeId !== self) return decide('attach', 'match', null)` | KILLED | wrong agent, setting ON (wrong-agent): REFUSED with the one notice tool, and the refusal is counted |
| M4 | unscoped refused outside strict | `lib/attach-scope.mjs` | `return decide(effective === 'strict' ? 'refuse' : 'attach', 'unscoped', 'strict')` then `return decide(effective !== 'off' ? 'refuse' : 'attach', 'unscoped', 'strict')` | KILLED | an unscoped session is refused only in strict, and counted as a strict would-refuse |
| M5 | default mode on | `lib/attach-scope.mjs` | `export const DEFAULT_ATTACH_SCOPE_MODE = 'off'` then `export const DEFAULT_ATTACH_SCOPE_MODE = 'strict'` | KILLED | wrong agent, setting OFF (the default): the full daemon as before, counted as a would-refuse |
| M6 | unknown mode not off in decide | `lib/attach-scope.mjs` | `'const effective = ATTACH_SCOPE_MODES.includes(mode) ? mode : DEFAULT_ATTACH_SCOPE_MODE'` then `const effective = normalizeMode(mode) ?? 'wrong-agent'` | KILLED | an unknown mode is OFF: nothing is refused |
| M7 | invalid env setting obeyed as strict | `lib/attach-scope.mjs` | `return { mode: DEFAULT_ATTACH_SCOPE_MODE, source: 'env', invalid: `${ATTACH_SCOPE_MODE_ENV}=${oneLine(fromEnv, 40)}` }` then `return { mode: 'strict', source: 'env', invalid: `${ATTACH_SCOPE_MODE_ENV}=${oneLine(fromEnv, 40)}` }` | KILLED | resolveAttachScopeMode: an unreadable setting is OFF and says why |
| M8 | env does not win over file | `lib/attach-scope.mjs` | `if (mode) return { mode, source: 'env' }` then `if (mode && !readText) return { mode, source: 'env' }` | KILLED | resolveAttachScopeMode: the env var sets it for one process |
| M9 | scope digits check dropped | `lib/attach-scope.mjs` | `if (!ID_RE.test(value)) return { state: 'unreadable' }` then `(line deleted)` | KILLED | readAttachScope: anything else is unreadable, never a guess |
| M10 | strict tally skips unscoped | `lib/attach-scope.mjs` | `'summary.wouldRefuseStrict += 1'` then `if (outcome === 'wrong-agent') summary.wouldRefuseStrict += 1` | KILLED | recordAttachScopeEvent appends one line per evaluation, and the summary counts would-refuses |
| M11 | no rotation | `lib/attach-scope.mjs` | `'if (statSync(path).size >= maxBytes) renameSync(path, `${path}.1`)'` then `if (false) renameSync(path, `${path}.1`)` | KILLED | the events file is rotated at its cap, so it can never grow without bound |
| M12 | telemetry throws | `lib/attach-scope.mjs` | `'} catch {'` then `} catch (err) {` | KILLED | telemetry NEVER throws: an unwritable folder answers false |
| M13 | doctor row never WARN | `lib/attach-scope.mjs` | `if (d.outcome === 'wrong-agent') {` then `if (d.outcome === 'wrong-agent') {` | KILLED | the check up row is OK for a match, WARN for a wrong agent, and carries the machine tally |
| M14 | launcher keeps an inherited scope | `bin/hoai-core.mjs` | `'if (/^\\d{1,12}$/.test(id)) env[ATTACH_SCOPE_ENV] = id'` then `if (/^\d{1,12}$/.test(id) && !env[ATTACH_SCOPE_ENV]) env[ATTACH_SCOPE_ENV] = id` | KILLED | applyAttachScope: the launcher OVERRIDES an inherited scope, and clears one it cannot name |
| M15 | launcher passes an inherited scope it cannot name | `bin/hoai-core.mjs` | `'else delete env[ATTACH_SCOPE_ENV]'` then `(line deleted)` | KILLED | applyAttachScope: the scope folder is set and overridden with the scope, and cleared with nothing to name |
| M16 | folder pin launch unscoped | `bin/hoai-core.mjs` | `'attachScope: declared.id,'` then `attachScope: '',` | KILLED | run plan: a folder pin scopes the launch to that agent |
| M17 | launch never applies the scope | `bin/hoai-core.mjs` | `'applyAttachScope(env, plan.attachScope, plan.attachScopeDir)'` then `(line deleted)` | KILLED | main: a supervised launch hands the daemon its scope, over an inherited one |
| M18 | supervised launch unscoped | `bin/hoai-core.mjs` | `'attachScope: serviceId,'` then `attachScope: '',` | KILLED | run plan: a supervised launch with a pinless folder scopes to the service agent |
| M19 | server never refuses | `server.ts` | `if (ATTACH_SCOPE.verdict !== 'refuse') return` then `if (true) return` | KILLED | wrong agent, setting ON (wrong-agent): REFUSED with the one notice tool, and the refusal is counted |
| M20 | server judges the scope against itself | `server.ts` | `assistantId: String(ASSISTANT_ID ?? ''),` then `assistantId: String(process.env.HOAI_ATTACH_SCOPE ?? ''),` | KILLED | wrong agent, setting ON (wrong-agent): REFUSED with the one notice tool, and the refusal is counted |
| M21 | server records nothing | `server.ts` | `'recordAttachScopeEvent({'` then `void ({` | KILLED | wrong agent, setting ON (wrong-agent): REFUSED with the one notice tool, and the refusal is counted |
| M22 | measurement script ignores the env setting | `bin/hoai-attach-scope.mjs` | `'const mode = resolveAttachScopeMode({'` then `const mode = resolveAttachScopeMode({` | KILLED | bin/hoai-attach-scope.mjs prints the machine tally: what each mode WOULD refuse |
| M23 | folder pin rule removed | `lib/attach-scope.mjs` | `'if (pin && pin !== self) return decide('` then `if (false) return decide(` | KILLED | THE BOARD ROW: a worker in agent 42's folder that inherited agent 41's env pin and scope is the wrong agent (by folder) and is refused when on |
| M24 | inherited scope trusted | `lib/attach-scope.mjs` | `'ownScope = false'` then `(line deleted)` | KILLED | a scope carried into ANOTHER folder was inherited: unscoped, launcher inherited, a strict would-refuse |
| M25 | folder compare ignores case rule | `lib/attach-scope.mjs` | `return platform === 'win32' \|\| platform === 'darwin' ? trimmed.toLowerCase() : trimmed` then `return trimmed` | KILLED | the scope folder compares as a folder: trailing separator, and case on macOS and Windows |
| M26 | folder compare skips realpath | `lib/attach-scope.mjs` | `'out = realpath(out) \|\| out'` then `(line deleted)` | KILLED | the scope folder compares through realpath (a symlinked spelling is the same folder) |
| M27 | ids not normalized | `lib/attach-scope.mjs` | `return id.replace(/^0+(?=\\d)/, '')` then `return id` | KILLED | a folder pin naming THIS agent, or no usable pin, changes nothing |
| M28 | gen1 launcher not recorded | `lib/attach-scope.mjs` | `else if (continued) launcher = 'gen1'` then `(line deleted)` | KILLED | the launcher is recorded: hoai (its folder), generation one (BGOS_CONTINUE), or none |
| M29 | distinct count is the boot count | `lib/attach-scope.mjs` | `'summary.distinctWouldRefuseStrict = strictKeys.size'` then `summary.distinctWouldRefuseStrict = summary.wouldRefuseStrict` | KILLED | the summary splits by launcher and by signal, and counts distinct sessions, not boots |
| M30 | wrong agent by folder tallied as by scope | `lib/attach-scope.mjs` | `const by = event.by === 'folder' ? 'folder' : 'scope'` then `const by = 'scope'` | KILLED | the summary splits by launcher and by signal, and counts distinct sessions, not boots |
| M31 | launcher never sets the scope folder | `bin/hoai-core.mjs` | `'if (folder) env[ATTACH_SCOPE_DIR_ENV] = folder'` then `if (false) env[ATTACH_SCOPE_DIR_ENV] = folder` | KILLED | applyAttachScope: the scope folder is set and overridden with the scope, and cleared with nothing to name |
| M32 | run plan omits the folder | `bin/hoai-core.mjs` | `'attachScope: declared.id,'` then `attachScope: declared.id,` | KILLED | run plan: a folder pin scopes the launch to that agent |
| M33 | server serves the home notice | `server.ts` | `'const served = await serveScopeRefused({'` then `const served = await serveHomeRefused({` | KILLED | wrong agent, setting ON (wrong-agent): REFUSED with the one notice tool, and the refusal is counted |
| M34 | server reads no folder pin | `server.ts` | `'folderPinId: readFolderPinId(ATTACH_SCOPE_FOLDER),'` then `(line deleted)` | KILLED | THE BOARD ROW: a worker in agent 42's folder that inherited agent 41's env pin and scope is the wrong agent (by folder) and is refused when on |
| M35 | main never runs the scope step | `server.ts` | `'await attachScopeAtBoot()'` then `(line deleted)` | KILLED | wrong agent, setting ON (wrong-agent): REFUSED with the one notice tool, and the refusal is counted |
| M36 | scope step runs before the duplicate check | `server.ts` | `'{'` then `await attachScopeAtBoot()` | KILLED | the plugin copy of a session that loads server:bgos serves ONE notice tool, declares no channel and takes no lock |

## Delegated review

One review by a `feature-dev:code-reviewer` subagent. It was given the requirement verbatim, the design doc and the diff, and not my conclusions. Its findings and what was done:

| Finding | Done |
|---|---|
| Literal en and em dash characters inside two regexes (lib and test) | Fixed: written as unicode escapes (backslash u2013, backslash u2014), plus a test that scans every source file of this change |
| The scope shares the inheritance path of the bug: a plain `claude` worker inherits A's scope AND A's env pin and reads as a match | Fixed, mostly: the launcher also names its folder (`HOAI_ATTACH_SCOPE_DIR`). A scope seen in another folder is `inherited` and untrusted, and a folder pin naming another agent is `wrong-agent` by folder. Tested in unit and e2e (the board row case). What is left (a child in the SAME folder) is documented as the design's discipline boundary. |
| The scope refusal reused the home notice, whose advice (pin this folder) is wrong here | Fixed: `serveScopeRefused` with its own text; the e2e asserts the description |
| Strict count cannot separate real agents from strays | Fixed: `launcher` is recorded (`hoai`, `gen1`, `inherited`, `env`, `none`) and summarized; hoai sets the folder even when it can name no agent |
| Counts boots, not sessions | Fixed: distinct (agent, folder) counts beside the boot counts |
| Rotation race at the cap | Documented: two daemons rotating at once can lose one rotated generation, never the live file |
| Ids with leading zeros | Fixed: compared as numbers |
| Comments claimed `hoai doctor` reads the tally | Fixed: they name `bin/hoai-attach-scope.mjs` and the check up row |
| 0.80.2 to 0.82.0 jump | Kept, reason above (above origin/main's 0.81.x per the brief) |
| Fleet wide read deferred | Stated in the CHANGELOG and below |
| Test gaps: e2e strict plus unscoped, the machine file, fixed timers | Fixed: two e2e cases added; the boot is answer driven |
| Test gap: the doctor row's wiring into `runChecks` has no test | Not added (follow up): the row's content is unit tested and mutation proven (M13); driving a real doctor RPC needs a backend socket |

Every fix above was mutation proven again (M23 to M34).

**One more defect, found by the full suite rather than the review.** `test/duplicate-copy.e2e.test.ts` went red on my tree and stayed green on HEAD: `no plugin state written: true !== false`. The scope block ran at module level, before `main()` asks its first question (is this the plugin's second copy, which must stand aside and write nothing?). So a standing aside copy wrote the events file. The fix splits the block: the decision stays at module level and is pure, while the record, log line and refusal move into `main()` right after the duplicate check. The failing test was the red. M36 (the scope step moved back before the duplicate check) proves the test kills that regression, and M35 (the step never called) proves the e2e notices its absence.

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (plugin root; `NODE_OPTIONS=--max-old-space-size=8192`) | exit 0, no output |
| The new tests | `test/attach-scope.test.ts` 38 pass, `test/attach-scope.launcher.test.ts` 7 pass, `test/attach-scope.e2e.test.ts` 6 pass |
| Full `npm test`, with `TMPDIR` set to its real path | **green**: node family 7822 pass, 0 fail, 47 skipped; real Chromium 11 pass, 0 fail, 4 skipped; bun family 375 pass, 0 fail; `[run-tests] both families green`, exit 0 |
| Full `npm test` with this Mac's default `TMPDIR` (a symlink) | 45 fail, every one in 12 browser-profile and browser-bootstrap files. Two of those files also hang until stopped (I stopped only those two PIDs of my own run). The same files fail the same way on a pristine `git archive HEAD` export of main (48 fail and 2 timeouts, with the hung tests capped at 180 s), and no file fails on my tree that passes on HEAD. |
| Version advances against base | 0.80.2 (main) to 0.82.0 in `package.json`, `.claude-plugin/plugin.json` and `package-lock.json`; CHANGELOG entry at the top |
| Dashes | No em or en dash in any added line, the evidence files or this report. `test/attach-scope.test.ts` scans every source file of the change. |

About the second row: the cause is environmental and known. On macOS `$TMPDIR` is a symlink, which the browser profile code refuses on purpose. The local branch `fix/suite-green-off-ci` (not on main here) makes `scripts/run-tests.mjs` hand every family the real temp folder. The green run above sets the same thing in the environment only, with no code change.

**Not applicable here, said plainly.** This lane touched only the plugin repo, so these BRIEF items did not apply: the BGOS `frontend` (yarn install, the expo-app tsc, `src/__tests__/meta`), `backend` (npm ci, jest), and the light and dark UI checks. The plugin repo has no `.claude/rules` and no `docs/CORE-CONTRACTS.md`. I installed the plugin's own dependencies with `npm ci`.

## Follow ups

1. **Fleet wide telemetry through the heartbeat (backend first).** Add an `attachScope` object to BGOS `HeartbeatEnvDto` (outcome, by, launcher, mode, all enums). Do this before the plugin sends it: the global whitelist pipe strips unknown fields silently, and the shadow interceptor counts them as offenders against the `VALIDATION_STRICT` flip. Then one SELECT over `integration_pairings.daemon_env` measures the fleet, as design section 5 phase 2 intends.
2. **Migrate the generation one launchers** (design section 4, rows 2 to 4: `~/.bgos-claude-session/run.expect`, `~/.bgos-session-<id>/keepalive.sh`, the Windows supervisor) to `hoai`, or have them export `HOAI_ATTACH_SCOPE` and `HOAI_ATTACH_SCOPE_DIR`. Until then they count as `unscoped by launcher: generation one`, which is exactly what blocks `strict`.
3. **Teach `bgos-build-agent` and the documented launch commands** (`bgos-install-method.mjs`) the scope. It must never go in a `.mcp.json`, which would re-create folder scoped attach (design section 3).
4. **`hoai doctor`** could print the same one line as `bin/hoai-attach-scope.mjs`. That was left out here so the doctor's pinned row set and argument parser stay untouched.
5. **A doctor RPC wiring test** for the `Attach scope` row (see review table).
6. **Independently of this gate (design 6b):** treat the scoped 403 (`Assistant is not scoped to this pairing`) as terminal, the way `pairing_revoked` is.
7. **Optional hardening:** add `HOAI_ATTACH_SCOPE` and `HOAI_ATTACH_SCOPE_DIR` to `SESSION_ENV_KEYS` (`lib/marker-takeover.mjs`). Not needed today, since every relaunch goes back through `hoai-core`, which recomputes both.

Production: nothing was read from or written to production. No production database, config, log or user record was touched. Every daemon run used a throwaway HOME and a dead backend port.
