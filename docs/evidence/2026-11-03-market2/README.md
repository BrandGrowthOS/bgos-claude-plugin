# Marketplace review verification

Baseline: `fbb997a789d634173881f77a2fb723de7e6f0030` on `fix/daemon-attach-scope-impl`.
Only findings 1, 2 and 3 from the supplied gate review were changed.

## Red first

`red.log` records seven assertion failures before production edits:

- Legacy agent 42 plus numbered agent 41: launcher scopes to 41 instead of 42.
- Explicit credentials for 42 plus numbered agent 41: launcher scopes to 41.
- Legacy-only agent 42 with no home: launcher clears scope.
- Pinned and recorded home admissions: strict forecast is zero instead of one.
- Installed marketplace CLI and doctor: mode is off instead of home.

`red-explicit-legacy.log` records a further assertion failure when an explicit
path points to the legacy file itself. `green-entrypoint.log` then exercises
all four credential layouts through the real launcher entry point and boots
the real marketplace daemon with the resulting child environment. Only the
external Claude CLI spawn is substituted. The daemon's MCP tools and recorded
identity, scope, verdict and credential route are asserted.

The forecast tests serialize actual marketplace decisions, read the event file,
and compare the home-mode prediction with strict-mode refusal for the same
inputs. Diagnostic tests run the installed CLI in both JSON and text modes
and assert the effective marketplace mode separately from its legacy setting.

## Mutation proof

Run from the repository root:

```sh
python3 docs/evidence/2026-11-03-market2/mutate.py
```

Each mutation typechecks before its selected regression runs. Every production
file is restored in a finally block. `mutations.json` records the results and
original SHA-256 hashes. All 11 mutations compiled and were killed by behavioral
assertions. Every one of the eight regression tests independently failed under
at least one mutation.

| Defect restored | Mutations | Assertions |
| --- | --- | --- |
| Wrong credential precedence or missing legacy opt-in | M1, M2, M3, M4 | Four launcher credential layouts |
| Scope lost at the actual launcher handoff | M5 | All four real daemon boots |
| Home admission drops or hides strict counterfactual | M6, M7 | Pinned and recorded home forecasts |
| Doctor normalizes home to off | M8 | Effective doctor mode |
| CLI reports only legacy mode or loses legacy setting | M9, M10, M11 | Installed CLI text and JSON |

## Gates

`tsc.log` is the successful `node_modules/.bin/tsc --noEmit` output.
`related.log` records 824 passes, 7 skips and zero failures with four workers.
The related suites cover attachment, launcher supervision, credential selection,
pairing locks, duplicate copies, dormant and home-refused startup, doctor,
install detection, Memory and Changes wiring, and stand-down behavior.

The full mixed suite is run as:

```sh
PATH="$PWD/node_modules/.bin:$PATH" TMPDIR="$PWD/.tmp" npm test
```

Its runner caps Node and Bun test concurrency at four and runs Chromium files
one at a time. No frontend files changed, so frontend heap, chat parity and
Android performance gates are not applicable to this change.

The final totals are recorded in `verification.json` and `full-suite.log`.

Captured logs trim trailing whitespace and normalize long dashes in existing
test titles to ASCII hyphens. Test output values and verdicts are unchanged.
