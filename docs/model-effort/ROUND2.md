# Round 2

Effort-only changes answer the CLI 2.1.319 cache confirmation with the exact
"Change effort level?" title, effort explanation, requested lowercase label,
selected Yes and four-line tail. Both operations use the same transaction
rechecks, recapture and one-answer limit. A real tmux rig now opens this effort
dialog independently of model changes and confirms through the status bridge.

The registry snapshot now excludes the six retired registry spellings from the
same installed 2.1.319 bundle's deprecation table. The sanitized table is retained
in test/fixtures/claude-2.1.319-deprecations.json, including dates and deprecated
Sonnet 4.5, which remains offered. This is a version-specific snapshot, not an
account entitlement check. Other CLI versions use their own help aliases rather
than inheriting the 2.1.319 exact catalog.

Mutation checks, run against isolated copies with the new CLI319 tests:

- M7: killed by a transient turn, permission or card signal after the first dialog capture.
- M19: killed by those signals after the second capture.
- M20: killed by a session change after the second capture.
- M11: killed by moving the terminal cursor between capture and the fresh pane-state read.
- M3: killed by two identical question titles.
- M16: killed by an unknown Sonnet label on a family request.
- M13: killed by missing or unrecognized model help despite a matching version.
- M21: equivalent. The prefix regex starts with ASCII spaces then the prompt
  glyph. A boxed row starts with the frame glyph, so prefix is null regardless
  of the !boxed condition. Both versions produce column null; neither can admit
  a blank boxed composer through the terminal-cursor fallback.

Reverting F1 or F2 separately is also killed by the new regression tests.

Validation:

- Type check: `bun run build` passed.
- Model and effort checks: 190 tests passed using the Node runner with tsx,
  including the real tmux rig and the new effort-only dialog.
- Direct `bun test --timeout 120000`: 1,035 passed, 1 skipped, 486 failed,
  473 errors. The direct runner hits unsupported nested node:test execution
  and browser profile temporary-directory refusals. The repository documents
  why its mixed suite uses the file-partitioned runner instead.
- Supplemental `bun run test`: all 475 main Node files and the runner regression
  file passed, followed by four serial browser files. Stopped the supplemental
  run during the fifth browser file; the remaining browser, daemon and Bun
  groups were not completed. No failures were reported before stopping.
- Focused native Bun run with the 120-second timeout: all 31 CLI319 and real
  tmux rig tests passed, including effort-only confirmation.
